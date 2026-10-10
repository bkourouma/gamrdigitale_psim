import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import type { Express, Request, RequestHandler, Response } from 'express';
import { isRateLimited, recordFailure } from './auth.ts';
import type { DeviceKeys, KeyCheck } from './devicekeys.ts';
import { deleteImages, sealImage, sensibleSize, sha256hex, sniffImage } from './evidence.ts';
import type { AuditFn, ImageType } from './evidence.ts';
import type { Engine } from './engine.ts';
import type { Incident } from './types.ts';

/**
 * Images envoyees par les equipements (camera solaire 4G, capteur avec photo) : POST /api/ingest/<id>/image.
 *
 *  - authentification par CLE D'EQUIPEMENT uniquement (devicekeys.ts) ; le jeton partage PSIM_INGEST_TOKEN est refuse ici ;
 *  - corps = l'image brute (Content-Type image/jpeg ou image/png), taille plafonnee AVANT lecture (Content-Length) et
 *    pendant la lecture (flux coupe au-dela) : jamais plus que le plafond en memoire ;
 *  - type verifie sur les OCTETS (signature, structure, dimensions lues sans rien decompresser), et doit correspondre au
 *    Content-Type annonce ; aucun traitement d'image cote serveur ;
 *  - nom de fichier genere par le serveur (identifiant numerique), dans le dossier des images d'incident ;
 *  - limites : tentatives par adresse, echecs d'authentification par adresse, envois par equipement, envois simultanes,
 *    plafond par incident, quota global (nombre et octets) des images d'equipement, attente bornee par equipement ;
 *  - rattachement : a l'incident NON CLOS du detecteur ; a defaut, l'image attend `pendingS` secondes qu'un incident
 *    s'ouvre (l'image part souvent juste AVANT le message d'alarme), puis est supprimee ;
 *  - scellement : voir evidence.ts (meme point d'enregistrement que les images des cameras liees).
 */

export interface DeviceImageLimits {
  /** Taille maximale d'une image (octets). */
  maxBytes: number;
  /** Envois acceptes par equipement et par minute. */
  perDevicePerMin: number;
  /** Tentatives par adresse et par minute (toutes issues confondues). */
  perIpPerMin: number;
  /** Quota global des images d'equipement (rattachees + en attente) : octets et nombre. */
  quotaBytes: number;
  quotaCount: number;
  /** Images d'equipement par incident. */
  maxPerIncident: number;
  /** Duree d'attente d'un incident pour une image arrivee sans incident ouvert (secondes ; 0 = refusee). */
  pendingS: number;
  /** Images en attente par equipement (les plus anciennes cedent la place). */
  maxPendingPerDevice: number;
}

export const DEFAULT_LIMITS: DeviceImageLimits = {
  maxBytes: 2 * 1024 * 1024,
  perDevicePerMin: 6,
  perIpPerMin: 30,
  quotaBytes: 500 * 1024 * 1024,
  quotaCount: 5000,
  maxPerIncident: 20,
  pendingS: 300,
  maxPendingPerDevice: 5,
};

const DEVICE_ID = /^[A-Za-z0-9_-]{1,32}$/;
const EVENT = /^[A-Za-z0-9_.-]{1,32}$/;
const MAX_INFLIGHT = 4;
const BODY_TIMEOUT_MS = 30_000;
const MIME: Record<string, ImageType> = { 'image/jpeg': 'jpg', 'image/png': 'png' };

export interface DeviceImagesDeps {
  db: DatabaseSync;
  engine: Engine;
  dataDir: string;
  keys: DeviceKeys;
  limits?: Partial<DeviceImageLimits>;
  publishIncident: (incidentId: number) => void;
  now?: () => number;
}

export type ReceiveResult =
  | { ok: true; status: 201 | 202; attached: boolean; imageId: number | null; incidentId: number | null; sha256: string; bytes: number }
  | { ok: false; status: number; error: string };

/** Fenetre glissante d'une minute ; la table est videe si elle grossit trop (adresses usurpees en masse). */
function windowCounter(limit: () => number) {
  const hits = new Map<string, number[]>();
  return (key: string, t: number): boolean => {
    const recent = (hits.get(key) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= limit()) {
      hits.set(key, recent);
      return false;
    }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}

export function createDeviceImages(deps: DeviceImagesDeps) {
  const { db, engine, keys } = deps;
  const now = deps.now ?? Date.now;
  const limits: DeviceImageLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const dir = resolve(deps.dataDir, 'snapshots');
  const pendingDir = join(dir, 'pending');
  mkdirSync(pendingDir, { recursive: true });
  const audit: AuditFn = (actor, action, ref) => engine.audit(actor, action, ref);
  const ipAllowed = windowCounter(() => limits.perIpPerMin);
  const deviceAllowed = windowCounter(() => limits.perDevicePerMin);
  let inflight = 0;
  const uploading = new Set<string>();

  // Fichiers en attente orphelins (arret pendant une ecriture) : supprimes au demarrage.
  {
    const known = new Set((db.prepare('SELECT id, type FROM device_image_pending').all() as { id: number; type: string }[]).map((r) => `${r.id}.${r.type}`));
    for (const f of readdirSync(pendingDir)) {
      if (!known.has(f)) {
        try {
          unlinkSync(join(pendingDir, f));
        } catch {
          // fichier verrouille : retente au prochain demarrage
        }
      }
    }
  }

  // ---- Refus journalises (sans secret, au plus une fois par minute et par motif/adresse) -----------------

  // Le journal est chaine, donc jamais purge : des refus venus de nombreuses adresses ne doivent pas le remplir.
  const MAX_REFUSALS_PER_MIN = 20;
  const lastRefusal = new Map<string, number>();
  let refusalMinute = 0;
  let refusalsThisMinute = 0;
  function noteRefusal(ip: string, deviceId: string, reason: string, keyId: number | null = null): void {
    const t = now();
    const k = `${reason}|${ip}`;
    if (t - (lastRefusal.get(k) ?? -Infinity) < 60_000) return;
    lastRefusal.set(k, t);
    if (lastRefusal.size > 1000) lastRefusal.clear();
    if (t - refusalMinute >= 60_000) {
      refusalMinute = t;
      refusalsThisMinute = 0;
    }
    refusalsThisMinute++;
    if (refusalsThisMinute > MAX_REFUSALS_PER_MIN) {
      if (refusalsThisMinute === MAX_REFUSALS_PER_MIN + 1) audit('systeme', 'image_refusee', { details: `plus de ${MAX_REFUSALS_PER_MIN} refus en une minute : journalisation des refus suspendue jusqu'a la minute suivante` });
      return;
    }
    const device = DEVICE_ID.test(deviceId) ? deviceId : '?';
    audit('systeme', 'image_refusee', { details: `${reason} ; equipement ${device} ; adresse ${ip.slice(0, 64)}${keyId !== null ? ` ; cle n°${keyId}` : ''}` });
  }

  // ---- Quota et attente ---------------------------------------------------------------------------------

  function usage(): { count: number; bytes: number } {
    const a = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM incident_snapshot WHERE source = 'device'").get() as { n: number; b: number };
    const p = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM device_image_pending').get() as { n: number; b: number };
    return { count: a.n + p.n, bytes: a.b + p.b };
  }

  function dropPending(ids: number[]): void {
    for (const id of ids) {
      const row = db.prepare('SELECT type FROM device_image_pending WHERE id = ?').get(id) as { type: string } | undefined;
      if (!row) continue;
      db.prepare('DELETE FROM device_image_pending WHERE id = ?').run(id);
      try {
        unlinkSync(join(pendingDir, `${id}.${row.type === 'png' ? 'png' : 'jpg'}`));
      } catch {
        // deja absent
      }
    }
  }

  /**
   * Fait de la place pour `bytes` octets : d'abord les images en attente les plus anciennes, puis les images d'equipement
   * des incidents CLOS les plus anciennes. Jamais une image d'un incident non clos, jamais une image de camera.
   */
  function makeRoom(bytes: number): boolean {
    let u = usage();
    const fits = () => u.count + 1 <= limits.quotaCount && u.bytes + bytes <= limits.quotaBytes;
    if (fits()) return true;
    const pending = db.prepare('SELECT id, bytes FROM device_image_pending ORDER BY received_at, id').all() as { id: number; bytes: number }[];
    const dropped: number[] = [];
    for (const p of pending) {
      if (fits()) break;
      dropped.push(p.id);
      u = { count: u.count - 1, bytes: u.bytes - p.bytes };
    }
    dropPending(dropped);
    if (fits()) return true;
    const closed = db
      .prepare(
        `SELECT s.id, s.bytes FROM incident_snapshot s JOIN incident i ON i.id = s.incident_id
          WHERE s.source = 'device' AND i.status = 'closed' ORDER BY s.taken_at, s.id`,
      )
      .all() as { id: number; bytes: number | null }[];
    const purge: number[] = [];
    for (const s of closed) {
      if (fits()) break;
      purge.push(s.id);
      u = { count: u.count - 1, bytes: u.bytes - (s.bytes ?? 0) };
    }
    deleteImages(db, dir, audit, purge, "quota des images d'equipement atteint");
    return fits();
  }

  const openIncidentOf = (deviceId: string): number | null =>
    (db.prepare("SELECT id FROM incident WHERE detector_id = ? AND status <> 'closed'").get(deviceId) as { id: number } | undefined)?.id ?? null;
  const deviceCountFor = (incidentId: number): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM incident_snapshot WHERE incident_id = ? AND source = 'device'").get(incidentId) as { n: number }).n;

  /** Enregistre une image deja validee (octets, type, taille) pour le detecteur `deviceId`. */
  function receive(deviceId: string, data: Buffer, type: ImageType, event: string | null): ReceiveResult {
    const device = engine.getDevice(deviceId);
    if (!device || device.kind !== 'detector') return { ok: false, status: 404, error: 'Detecteur introuvable' };
    const t = now();
    const incidentId = openIncidentOf(deviceId);
    if (incidentId !== null && deviceCountFor(incidentId) >= limits.maxPerIncident) {
      return { ok: false, status: 409, error: "Plafond d'images atteint pour cet incident" };
    }
    if (incidentId === null && limits.pendingS <= 0) return { ok: false, status: 409, error: 'Aucun incident ouvert pour ce detecteur' };
    if (incidentId === null) {
      // Un equipement bavard ne garde que ses dernieres images en attente.
      const mine = db.prepare('SELECT id FROM device_image_pending WHERE device_id = ? ORDER BY received_at, id').all(deviceId) as { id: number }[];
      dropPending(mine.slice(0, Math.max(0, mine.length - limits.maxPendingPerDevice + 1)).map((r) => r.id));
    }
    if (!makeRoom(data.length)) return { ok: false, status: 507, error: "Quota des images d'equipement atteint (images d'incidents en cours)" };
    const note = event ? `evenement ${event}` : undefined;

    if (incidentId !== null) {
      const sealed = sealImage(db, dir, audit, { incidentId, deviceId, takenAt: t, reason: 'device', source: 'device', data, type, note });
      deps.publishIncident(incidentId);
      return { ok: true, status: 201, attached: true, imageId: sealed.id, incidentId, sha256: sealed.sha256, bytes: sealed.bytes };
    }

    const sha256 = sha256hex(data);
    let written: string | null = null;
    db.exec('SAVEPOINT pending_image');
    try {
      const res = db
        .prepare('INSERT INTO device_image_pending (device_id, received_at, type, sha256, bytes, event) VALUES (?, ?, ?, ?, ?, ?)')
        .run(deviceId, t, type, sha256, data.length, event);
      const id = Number(res.lastInsertRowid);
      const file = join(pendingDir, `${id}.${type}`);
      writeFileSync(`${file}.tmp`, data);
      renameSync(`${file}.tmp`, file);
      written = file;
      audit('equipement', 'image_en_attente', {
        deviceId,
        details: `image en attente ${id} sha256=${sha256} ${data.length} octets (aucun incident ouvert : rattachee si un incident s'ouvre dans les ${limits.pendingS} s)${note ? ` ; ${note}` : ''}`,
      });
      db.exec('RELEASE pending_image');
    } catch (err) {
      db.exec('ROLLBACK TO pending_image');
      db.exec('RELEASE pending_image');
      if (written) {
        try {
          unlinkSync(written);
        } catch {
          // deja absent
        }
      }
      throw err;
    }
    return { ok: true, status: 202, attached: false, imageId: null, incidentId: null, sha256, bytes: data.length };
  }

  /**
   * Un incident s'ouvre (ou change d'etape) : les images en attente de SON detecteur, recues dans la fenetre d'attente, lui
   * sont rattachees et scellees. Une image modifiee pendant l'attente (empreinte differente) est ecartee et signalee.
   */
  function attachPending(incident: Incident): number {
    const t = now();
    const rows = db
      .prepare('SELECT * FROM device_image_pending WHERE device_id = ? AND received_at >= ? ORDER BY received_at, id')
      .all(incident.detectorId, t - limits.pendingS * 1000) as { id: number; device_id: string; received_at: number; type: string; sha256: string; bytes: number; event: string | null }[];
    let attached = 0;
    for (const r of rows) {
      const type: ImageType = r.type === 'png' ? 'png' : 'jpg';
      let data: Buffer | null = null;
      try {
        data = readFileSync(join(pendingDir, `${r.id}.${type}`));
      } catch {
        data = null;
      }
      if (!data || sha256hex(data) !== r.sha256) {
        audit('systeme', 'image_refusee', { incidentId: incident.id, deviceId: r.device_id, details: `image en attente ${r.id} ${data ? 'MODIFIEE' : 'MANQUANTE'} pendant l'attente : non rattachee` });
      } else if (deviceCountFor(incident.id) < limits.maxPerIncident) {
        const when = new Date(r.received_at).toLocaleTimeString('fr-FR');
        sealImage(db, dir, audit, {
          incidentId: incident.id,
          deviceId: r.device_id,
          takenAt: r.received_at,
          reason: 'device',
          source: 'device',
          data,
          type,
          note: `recue a ${when} avant l'ouverture de l'incident (attente n°${r.id})${r.event ? ` ; evenement ${r.event}` : ''}`,
        });
        attached++;
      }
      dropPending([r.id]);
    }
    if (attached > 0) deps.publishIncident(incident.id);
    return attached;
  }

  /** Supprime les images en attente dont la fenetre est passee (aucun incident ne s'est ouvert). */
  function expirePending(): number {
    const rows = db.prepare('SELECT id FROM device_image_pending WHERE received_at < ?').all(now() - limits.pendingS * 1000) as { id: number }[];
    if (rows.length === 0) return 0;
    dropPending(rows.map((r) => r.id));
    audit('systeme', 'image_expiree', { details: `${rows.length} image(s) en attente supprimee(s) : aucun incident ouvert dans les ${limits.pendingS} s` });
    return rows.length;
  }

  let timer: ReturnType<typeof setInterval> | undefined;

  // ---- Entree HTTP -------------------------------------------------------------------------------------

  /** Lit le corps en le plafonnant : au-dela de `max` octets, la lecture s'arrete (aucun octet de plus en memoire). */
  function readLimited(req: Request, max: number): Promise<{ ok: true; data: Buffer } | { ok: false; status: number; error: string }> {
    return new Promise((done) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let finished = false;
      const finish = (r: { ok: true; data: Buffer } | { ok: false; status: number; error: string }) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onClose);
        req.off('close', onClose);
        if (!r.ok) req.pause();
        done(r);
      };
      const onData = (chunk: Buffer) => {
        size += chunk.length;
        if (size > max) return finish({ ok: false, status: 413, error: 'Image trop volumineuse' });
        chunks.push(chunk);
      };
      const onEnd = () => finish({ ok: true, data: Buffer.concat(chunks, size) });
      const onClose = () => finish({ ok: false, status: 400, error: 'Envoi interrompu' });
      const timer = setTimeout(() => finish({ ok: false, status: 408, error: "Envoi trop lent" }), BODY_TIMEOUT_MS);
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onClose);
      req.on('close', onClose);
    });
  }

  /** Refus qui laisse le corps non lu : la connexion est fermee apres la reponse (pas de lecture du reste). */
  const refuseUnread = (res: Response, status: number, error: string) => {
    res.setHeader('Connection', 'close');
    res.status(status).json({ error });
  };

  const AUTH_TEXT: Record<Exclude<KeyCheck, { ok: true }>['reason'], string> = {
    absent: 'cle absente',
    malformed: 'cle mal formee',
    unknown: 'cle inconnue',
    revoked: 'cle revoquee',
    scope: "cle d'un autre equipement",
  };

  async function handleUpload(req: Request, res: Response): Promise<void> {
    const deviceId = String(req.params.id);
    const ip = req.ip ?? 'inconnue';
    const failKey = `ingest:${ip}`; // meme compteur d'echecs que l'entree des messages d'etat
    if (!DEVICE_ID.test(deviceId)) return refuseUnread(res, 404, 'Detecteur introuvable');
    if (!ipAllowed(ip, now()) || isRateLimited(failKey)) {
      res.setHeader('Retry-After', '60');
      return refuseUnread(res, 429, 'Trop de tentatives, reessayez dans une minute');
    }
    const auth = req.headers.authorization;
    if (!keys.presentsKey(auth)) {
      recordFailure(failKey);
      noteRefusal(ip, deviceId, typeof auth === 'string' && auth.startsWith('Bearer ') ? 'jeton partage ou inconnu (cle par equipement exigee pour les images)' : 'cle absente');
      res.setHeader('WWW-Authenticate', 'Bearer');
      return refuseUnread(res, 401, "Cle d'equipement requise");
    }
    const check = keys.check(auth, deviceId);
    if (!check.ok) {
      recordFailure(failKey);
      noteRefusal(ip, deviceId, AUTH_TEXT[check.reason], check.keyId);
      if (check.reason === 'scope') return refuseUnread(res, 403, "Cette cle n'est pas autorisee pour cet equipement");
      res.setHeader('WWW-Authenticate', 'Bearer');
      return refuseUnread(res, 401, 'Cle invalide');
    }
    const device = engine.getDevice(deviceId);
    if (!device || device.kind !== 'detector') return refuseUnread(res, 404, 'Detecteur introuvable');
    const eventRaw = req.query.event;
    if (eventRaw !== undefined && (typeof eventRaw !== 'string' || !EVENT.test(eventRaw))) return refuseUnread(res, 400, 'event : 1 a 32 caracteres (lettres, chiffres, . _ -)');
    if (!deviceAllowed(deviceId, now())) {
      noteRefusal(ip, deviceId, "debit de l'equipement depasse", check.keyId);
      res.setHeader('Retry-After', '60');
      return refuseUnread(res, 429, "Trop d'images pour cet equipement, reessayez dans une minute");
    }
    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const declared = MIME[mime];
    if (!declared) return refuseUnread(res, 415, 'Content-Type image/jpeg ou image/png attendu');
    const encoding = String(req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (encoding !== 'identity') return refuseUnread(res, 415, 'Contenu compresse refuse (Content-Encoding)');
    const length = req.headers['content-length'];
    if (length !== undefined && Number(length) > limits.maxBytes) {
      noteRefusal(ip, deviceId, 'image trop volumineuse', check.keyId);
      return refuseUnread(res, 413, `Image trop volumineuse (${Math.floor(limits.maxBytes / 1024)} Ko au plus)`);
    }
    // Envois simultanes plafonnes (memoire bornee) ; un equipement n'en occupe qu'un a la fois (une cle volee qui envoie
    // tres lentement ne bloque pas les autres).
    if (inflight >= MAX_INFLIGHT || uploading.has(deviceId)) {
      res.setHeader('Retry-After', '5');
      return refuseUnread(res, 503, 'Trop d\'envois simultanes, reessayez dans quelques secondes');
    }
    inflight++;
    uploading.add(deviceId);
    let body: Awaited<ReturnType<typeof readLimited>>;
    try {
      body = await readLimited(req, limits.maxBytes);
    } finally {
      inflight--;
      uploading.delete(deviceId);
    }
    if (!body.ok) {
      if (body.status === 413) noteRefusal(ip, deviceId, 'image trop volumineuse', check.keyId);
      return refuseUnread(res, body.status, body.error);
    }
    const sniffed = sniffImage(body.data);
    if (!sniffed) {
      noteRefusal(ip, deviceId, "contenu qui n'est pas une image JPEG ou PNG complete", check.keyId);
      return void res.status(415).json({ error: "Le contenu n'est pas une image JPEG ou PNG valide" });
    }
    if (sniffed.type !== declared) {
      noteRefusal(ip, deviceId, 'Content-Type mensonger', check.keyId);
      return void res.status(415).json({ error: 'Le contenu ne correspond pas au Content-Type annonce' });
    }
    if (!sensibleSize(sniffed)) {
      noteRefusal(ip, deviceId, `dimensions refusees (${sniffed.width}x${sniffed.height})`, check.keyId);
      return void res.status(415).json({ error: 'Dimensions de l\'image refusees' });
    }
    const result = receive(deviceId, body.data, sniffed.type, typeof eventRaw === 'string' ? eventRaw : null);
    if (!result.ok) {
      if (result.status === 507) noteRefusal(ip, deviceId, 'quota global atteint', check.keyId);
      return void res.status(result.status).json({ error: result.error });
    }
    res.status(result.status).json({ attached: result.attached, incidentId: result.incidentId, sha256: result.sha256, bytes: result.bytes });
  }

  /**
   * Routes : entree des images (sans session : cle d'equipement) et gestion des cles (administrateur). A monter AVANT la
   * route « /api » de repli (404).
   */
  function mount(app: Express, guards: { adminOnly: RequestHandler; actorOf: (req: Request) => string }): void {
    const { adminOnly, actorOf } = guards;
    const json = express.json({ limit: '4kb' });
    app.post('/api/ingest/:id/image', handleUpload);
    // Cles d'equipement : la valeur en clair n'est renvoyee qu'a la creation et a la rotation.
    app.get('/api/device-keys', adminOnly, (_req, res) => res.json(keys.list()));
    app.post('/api/device-keys', adminOnly, json, (req, res) => {
      res.status(201).json(keys.create(actorOf(req), (req.body ?? {}) as Record<string, unknown>));
    });
    app.post('/api/device-keys/:id/rotate', adminOnly, json, (req, res) => {
      res.status(201).json(keys.rotate(actorOf(req), req.params.id, (req.body ?? {}) as Record<string, unknown>));
    });
    app.delete('/api/device-keys/:id', adminOnly, (req, res) => {
      res.json(keys.revoke(actorOf(req), req.params.id));
    });
  }

  return {
    keys,
    limits,
    receive,
    attachPending,
    expirePending,
    usage,
    noteRefusal,
    mount,
    start(): void {
      expirePending();
      timer = setInterval(() => {
        try {
          expirePending();
        } catch (err) {
          console.error('[psim] images en attente :', err);
        }
      }, 30_000);
      timer.unref();
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}

export type DeviceImages = ReturnType<typeof createDeviceImages>;
