/**
 * Evenements d'un enregistreur ou d'une camera Dahua (XVR, NVR, camera IP) : la detection de l'appareil (mouvement, SMD
 * humain / vehicule, franchissement de ligne) devient l'alarme d'un detecteur d'INTRUSION du PSIM.
 *
 * Protocole : GET /cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=5, authentification HTTP Digest (ou
 * Basic). La reponse ne se termine jamais : une suite de parties « Code=SmartMotionHuman;action=Start;index=0 »
 * (index = voie - 1) et un « Heartbeat » toutes les 5 s.
 *
 * Surete :
 *  - une seule connexion par appareil, avec les identifiants deja enregistres pour la camera (chiffres en base) ;
 *  - tant qu'elle vit, les detecteurs recoivent un signe de vie : si l'appareil se tait (cable, panne, mot de passe change),
 *    ils passent « hors ligne » et la notification « detecteur muet » part, comme pour tout detecteur supervise ;
 *  - perte video d'une voie (VideoLoss) : zone armee (la nuit), c'est un sabotage possible de la camera, donc une alarme
 *    (`tamper`) ; zone desarmee, un simple defaut du detecteur (coupure de courant de la camera en journee) ;
 *  - la source n'existe que sur un detecteur d'intrusion qui a une zone (voir engine.updateDevice) ;
 *  - identifiants refuses : nouvel essai seulement apres 5 min (un appareil Dahua bloque le compte apres quelques echecs) ;
 *  - authentification Digest seulement (jamais Basic : le mot de passe passerait en clair sur le reseau) ;
 *  - l'appareil n'est « connecte » qu'a sa premiere partie lue (signe de vie ou evenement), pas sur un simple « 200 » ;
 *  - une alarme en cours (Start sans Stop) est terminee si la connexion tombe ou si la source change : jamais bloquee ;
 *  - l'armement (planning de nuit) s'applique comme a tout detecteur d'intrusion : rien n'est filtre ici.
 * Le mot de passe n'apparait jamais dans un message, un journal ou une reponse.
 */
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { Engine } from './engine.ts';
import { PsimError } from './errors.ts';
import { unseal } from './secrets.ts';

/** Evenements Dahua qu'un detecteur peut suivre (VideoLoss est toujours suivi : il signale une voie sans image). */
export const DAHUA_CODES = ['VideoMotion', 'SmartMotionHuman', 'SmartMotionVehicle', 'CrossLineDetection', 'CrossRegionDetection'] as const;
const ALLOWED = new Set<string>(DAHUA_CODES);
const MAX_BUFFER = 256 * 1024;
const HEARTBEAT_S = 5;
const SILENCE_MS = 25_000;
const ALIVE_EVERY_MS = 30_000;
/** Supervision posee sur un detecteur qui n'en avait pas : il passe hors ligne 2 min apres la perte de l'appareil. */
export const DAHUA_SUPERVISION_S = 120;
const PULSE_MS = 10_000;
/** Apres le « 200 », delai pour recevoir une premiere partie : sinon ce n'est pas (ou plus) un flux d'evenements vivant. */
const FIRST_PART_MS = 20_000;

export interface DahuaEvent {
  code: string;
  action: string;
  /** Voie, a partir de 1. */
  channel: number;
}

/** « Code=SmartMotionHuman;action=Start;index=0;data={...} » -> evenement (voie = index + 1), ou null (Heartbeat...). */
export function parseEventPart(text: string): DahuaEvent | null {
  const m = /Code=([A-Za-z]+);action=([A-Za-z]+);index=(\d+)/.exec(text);
  return m ? { code: m[1], action: m[2], channel: Number(m[3]) + 1 } : null;
}

/**
 * Decoupe un flux multipart au fil de l'eau. Chaque partie est livree des qu'elle est complete (Content-Length), sans
 * attendre la suivante : une alarme n'attend pas le prochain « Heartbeat ». Memoire bornee.
 */
export function createPartParser(boundary: string, onPart: (body: string) => void): (chunk: Buffer) => void {
  const marker = Buffer.from(`--${boundary.replace(/^--/, '')}`);
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_BUFFER) buffer = buffer.subarray(buffer.length - MAX_BUFFER);
    for (;;) {
      const start = buffer.indexOf(marker);
      if (start < 0) {
        buffer = buffer.subarray(Math.max(0, buffer.length - marker.length));
        return;
      }
      const headerEnd = buffer.indexOf('\r\n\r\n', start + marker.length);
      if (headerEnd < 0) {
        buffer = buffer.subarray(start);
        return;
      }
      const headers = buffer.subarray(start + marker.length, headerEnd).toString('latin1');
      const length = /content-length:\s*(\d+)/i.exec(headers);
      const bodyStart = headerEnd + 4;
      let bodyEnd: number;
      if (length) {
        bodyEnd = bodyStart + Number(length[1]);
        if (buffer.length < bodyEnd) {
          buffer = buffer.subarray(start);
          return;
        }
      } else {
        const next = buffer.indexOf(marker, bodyStart);
        if (next < 0) {
          buffer = buffer.subarray(start);
          return;
        }
        bodyEnd = next;
      }
      onPart(buffer.subarray(bodyStart, bodyEnd).toString('utf8'));
      buffer = buffer.subarray(bodyEnd);
    }
  };
}

/** En-tete WWW-Authenticate -> schema et parametres. */
export function parseChallenge(header: string): { scheme: string; params: Record<string, string> } {
  const scheme = header.trim().split(/\s+/)[0] ?? '';
  const params: Record<string, string> = {};
  for (const m of header.slice(scheme.length).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) params[m[1].toLowerCase()] = m[2] ?? m[3];
  return { scheme: scheme.toLowerCase(), params };
}

/** Algorithmes Digest pris en charge (RFC 7616) -> fonction de hachage. MD5 : verifie sur un XVR reel. */
const DIGEST_HASH: Record<string, string> = { md5: 'md5', 'md5-sess': 'md5', 'sha-256': 'sha256', 'sha-256-sess': 'sha256' };

/** Refus d'authentification qu'un nouvel essai ne changerait pas : on attend 5 min avant de recommencer (compte de l'appareil). */
export class DahuaAuthError extends Error {}

/** Nom d'utilisateur utilisable dans un en-tete Digest : ASCII imprimable, sans guillemet ni barre oblique inverse. */
export const DIGEST_USERNAME = /^[\x20-\x21\x23-\x5b\x5d-\x7e]{1,64}$/;

/**
 * En-tete Authorization pour une requete GET : Digest seulement (qop=auth si propose). Parmi plusieurs defis, MD5 d'abord
 * (celui des appareils Dahua), puis SHA-256. Basic est refuse : le mot de passe passerait en clair sur le reseau.
 */
export function authorization(challenges: string | string[], username: string, password: string, uri: string, cnonce = randomBytes(8).toString('hex')): string {
  if (!DIGEST_USERNAME.test(username)) throw new DahuaAuthError("nom d'utilisateur de la camera non pris en charge (accents, guillemets) : utiliser un compte en lettres simples");
  const offered = (Array.isArray(challenges) ? challenges : [challenges]).map(parseChallenge);
  const digest = offered.filter((c) => c.scheme === 'digest');
  if (digest.length === 0) {
    throw new DahuaAuthError(
      offered.some((c) => c.scheme === 'basic') ? "l'appareil demande une authentification en clair (Basic) : refusee, le mot de passe passerait lisible sur le reseau" : "authentification de l'appareil non prise en charge",
    );
  }
  const algorithmOf = (c: { params: Record<string, string> }) => (c.params.algorithm ?? 'MD5').toLowerCase();
  const chosen = digest.find((c) => algorithmOf(c) === 'md5') ?? digest.find((c) => DIGEST_HASH[algorithmOf(c)]);
  if (!chosen) throw new DahuaAuthError(`algorithme d'authentification non pris en charge (${digest.map((c) => c.params.algorithm).join(', ')})`);
  const { params } = chosen;
  const algorithm = algorithmOf(chosen);
  const hash = (s: string) => createHash(DIGEST_HASH[algorithm]).update(s).digest('hex');
  const realm = params.realm ?? '';
  const nonce = params.nonce ?? '';
  const qop = (params.qop ?? '').split(',').map((q) => q.trim()).includes('auth') ? 'auth' : '';
  const sess = algorithm.endsWith('-sess');
  const ha1 = sess ? hash(`${hash(`${username}:${realm}:${password}`)}:${nonce}:${cnonce}`) : hash(`${username}:${realm}:${password}`);
  const ha2 = hash(`GET:${uri}`);
  const nc = '00000001';
  const response = qop ? hash(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : hash(`${ha1}:${nonce}:${ha2}`);
  const fields = [`username="${username}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`, `response="${response}"`];
  if (qop) fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  else if (sess) fields.push(`cnonce="${cnonce}"`);
  if (params.opaque) fields.push(`opaque="${params.opaque}"`);
  if (params.algorithm) fields.push(`algorithm=${params.algorithm}`);
  return `Digest ${fields.join(', ')}`;
}

export interface Credentials {
  host: string;
  port: number;
  username: string;
  password: string;
}

const EVENTS_PATH = `/cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=${HEARTBEAT_S}`;

/** Message d'erreur en clair, sans jamais le mot de passe ni l'adresse complete. */
function explain(err: unknown): string {
  const code = (err as { code?: string }).code;
  if (code === 'ECONNREFUSED') return "connexion refusee (port HTTP de l'appareil ferme ?)";
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'appareil injoignable (reseau, VPN ?)';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return "pas de reponse de l'appareil";
  if (code === 'ECONNRESET') return "connexion coupee par l'appareil";
  return 'erreur reseau';
}

/**
 * Ouvre le flux d'evenements (avec la reprise d'authentification Digest). `onPart` recoit chaque partie ; la promesse se
 * resout a la PREMIERE partie recue (signe de vie ou evenement), ou rejette avec une raison lisible. `stop()` coupe tout.
 */
export function openEventStream(
  creds: Credentials,
  /** `authRefused` : refus d'authentification, qu'un nouvel essai rapide ne changerait pas (et qui bloquerait le compte). */
  handlers: { onPart: (body: string) => void; onEnd: (reason: string, authRefused?: boolean) => void },
): { ready: Promise<void>; stop: () => void } {
  let current: ClientRequest | null = null;
  let stopped = false;
  let firstPart: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    clearTimeout(firstPart);
    current?.destroy();
  };
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const attempt = (auth: string | null) => {
      const req = request({ host: creds.host, port: creds.port, path: EVENTS_PATH, method: 'GET', headers: auth ? { Authorization: auth } : {}, timeout: 15_000 });
      current = req;
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', (err) => {
        if (stopped) return;
        const reason = explain(err);
        rejectReady(new Error(reason));
        handlers.onEnd(reason);
      });
      req.on('response', (res: IncomingMessage) => {
        if (res.statusCode === 401) {
          res.resume();
          const challenges = res.headersDistinct['www-authenticate'] ?? [];
          if (!auth && challenges.length) {
            let next: string;
            try {
              next = authorization(challenges, creds.username, creds.password, EVENTS_PATH);
            } catch (err) {
              const reason = (err as Error).message;
              rejectReady(new DahuaAuthError(reason));
              return handlers.onEnd(reason, true);
            }
            return attempt(next);
          }
          const reason = "identifiants refuses par l'appareil (ceux de la camera)";
          rejectReady(new DahuaAuthError(reason));
          return handlers.onEnd(reason, true);
        }
        if (res.statusCode !== 200) {
          res.resume();
          const reason = res.statusCode === 404 ? "l'appareil ne propose pas ce service (eventManager.cgi) : est-ce un appareil Dahua ?" : `refus de l'appareil (HTTP ${res.statusCode})`;
          rejectReady(new Error(reason));
          return handlers.onEnd(reason);
        }
        const type = String(res.headers['content-type'] ?? '');
        if (!/^multipart\//i.test(type)) {
          res.resume();
          req.destroy();
          const reason = "l'appareil ne renvoie pas un flux d'evenements Dahua (reponse HTTP ordinaire)";
          rejectReady(new Error(reason));
          return handlers.onEnd(reason);
        }
        req.setTimeout(0);
        // Connecte seulement a la premiere partie : un « 200 » muet ne doit pas faire croire les detecteurs en ligne.
        firstPart = setTimeout(() => {
          if (stopped) return;
          req.destroy();
          const reason = "aucun signe de vie de l'appareil (flux d'evenements muet)";
          rejectReady(new Error(reason));
          handlers.onEnd(reason);
        }, FIRST_PART_MS);
        const boundary = /boundary=("?)([^";]+)\1/i.exec(type)?.[2] ?? 'myboundary';
        const parse = createPartParser(boundary, (body) => {
          clearTimeout(firstPart);
          resolveReady();
          handlers.onPart(body);
        });
        res.on('data', (chunk: Buffer) => parse(chunk));
        res.on('end', () => {
          clearTimeout(firstPart);
          if (!stopped) handlers.onEnd("flux ferme par l'appareil");
        });
        res.on('error', () => {
          clearTimeout(firstPart);
          if (!stopped) handlers.onEnd("connexion coupee par l'appareil");
        });
      });
      req.end();
    };
    attempt(null);
  });
  ready.catch(() => {});
  return { ready, stop };
}

// ---------------------------------------------------------------- service

interface SourceRow {
  device_id: string;
  camera_id: string;
  channel: number;
  events: string;
  http_port: number;
  host: string;
  username: string | null;
  secret: string | null;
}

export interface DetectorSourceView {
  cameraId: string;
  channel: number;
  events: string[];
  httpPort: number;
  /** Etat de la connexion a l'appareil. */
  connection: { state: 'connecting' | 'connected' | 'error'; since: number; error: string | null; lastEvent: { code: string; action: string; at: number } | null };
}

interface Link {
  key: string;
  creds: Credentials;
  detectors: { id: string; channel: number; codes: Set<string> }[];
  stream: { stop: () => void } | null;
  state: 'connecting' | 'connected' | 'error';
  since: number;
  error: string | null;
  lastData: number;
  retry: ReturnType<typeof setTimeout> | null;
  failures: number;
}

export interface DahuaDeps {
  db: DatabaseSync;
  engine: Pick<Engine, 'handleDetectorMessage' | 'audit' | 'getDevice'>;
  key: Buffer;
  now?: () => number;
  /** Pour les tests : ouverture du flux (par defaut le vrai reseau). */
  open?: typeof openEventStream;
  log?: (message: string) => void;
  /** Armement de la zone (planning de nuit) : decide si une perte video est une alarme ou un simple defaut. */
  isArmed?: (zone: string) => boolean;
  /** Pour les tests : cadence des signes de vie (30 s). */
  aliveEveryMs?: number;
}

export function createDahuaEvents(deps: DahuaDeps) {
  const { db, engine } = deps;
  const now = deps.now ?? Date.now;
  const open = deps.open ?? openEventStream;
  const log = deps.log ?? ((m: string) => console.log(`[dahua] ${m}`));
  const links = new Map<string, Link>();
  const active = new Map<string, Set<string>>(); // detecteur -> codes en cours (Start sans Stop)
  const lastEvent = new Map<string, { code: string; action: string; at: number }>();
  const pulses = new Map<string, ReturnType<typeof setTimeout>>();
  // Voies sans image (VideoLoss sans fin) -> alarme deja donnee ? Une perte commencee le jour devient une alarme a l'armement.
  const blind = new Map<string, boolean>();
  const armedFor = (detectorId: string) => deps.isArmed?.(engine.getDevice(detectorId)?.zone ?? '') ?? true;
  let stopped = false;

  function rows(): SourceRow[] {
    return db
      .prepare(
        `SELECT s.device_id, s.camera_id, s.channel, s.events, s.http_port, c.host, c.username, c.secret
           FROM detector_source s JOIN camera_source c ON c.device_id = s.camera_id
           JOIN device d ON d.id = s.device_id WHERE d.kind = 'detector' AND d.category = 'intrusion'`,
      )
      .all() as unknown as SourceRow[];
  }

  function credentials(row: { host: string; http_port: number; username: string | null; secret: string | null }): Credentials | null {
    if (!row.username || !row.secret) return null;
    try {
      return { host: row.host, port: row.http_port, username: row.username, password: unseal(deps.key, row.secret) };
    } catch {
      return null; // cle perdue ou secret altere : la camera doit etre ressaisie (signale par le statut)
    }
  }

  function send(detectorId: string, event: string): void {
    engine.handleDetectorMessage(detectorId, { event });
  }

  /**
   * Termine ce qui est en cours pour un detecteur (Start sans Stop, impulsion) : connexion perdue, source retiree ou changee.
   * Sans cela, le detecteur resterait « en alarme » : incident impossible a cloturer, alarmes suivantes jamais notifiees.
   */
  function release(detectorId: string, keep: Set<string> = new Set()): void {
    const codes = active.get(detectorId);
    const pulse = pulses.get(detectorId);
    const had = Boolean(codes?.size) || pulse !== undefined;
    for (const code of codes ?? []) if (!keep.has(code)) codes!.delete(code);
    if (pulse !== undefined) {
      clearTimeout(pulse);
      pulses.delete(detectorId);
    }
    if (had && !codes?.size) send(detectorId, 'clear');
  }

  function onEvent(link: Link, ev: DahuaEvent): void {
    for (const det of link.detectors) {
      if (det.channel !== ev.channel) continue;
      // Un Stop termine toujours un Start en cours, meme si ce code n'est plus suivi (reglage change entre les deux).
      if (ev.action === 'Stop' && active.get(det.id)?.has(ev.code) && !det.codes.has(ev.code)) {
        const codes = active.get(det.id)!;
        codes.delete(ev.code);
        if (codes.size === 0 && !pulses.has(det.id)) send(det.id, 'clear');
        continue;
      }
      if (ev.code === 'VideoLoss') {
        lastEvent.set(det.id, { code: ev.code, action: ev.action, at: now() });
        if (ev.action === 'Stop') {
          blind.delete(det.id);
          send(det.id, 'clear');
          continue;
        }
        const armed = armedFor(det.id);
        blind.set(det.id, armed);
        send(det.id, armed ? 'tamper' : 'fault');
        continue;
      }
      if (!det.codes.has(ev.code)) continue;
      lastEvent.set(det.id, { code: ev.code, action: ev.action, at: now() });
      const codes = active.get(det.id) ?? new Set<string>();
      if (ev.action === 'Start') {
        codes.add(ev.code);
        active.set(det.id, codes);
        send(det.id, 'motion');
      } else if (ev.action === 'Stop') {
        codes.delete(ev.code);
        if (codes.size === 0 && !pulses.has(det.id)) send(det.id, 'clear');
      } else if (ev.action === 'Pulse') {
        // Evenement ponctuel (franchissement de ligne) : alarme, puis retour au calme apres quelques secondes.
        send(det.id, 'motion');
        clearTimeout(pulses.get(det.id));
        pulses.set(
          det.id,
          setTimeout(() => {
            pulses.delete(det.id);
            if (!active.get(det.id)?.size) send(det.id, 'clear');
          }, PULSE_MS),
        );
      }
    }
  }

  function connect(link: Link): void {
    if (stopped) return;
    link.state = 'connecting';
    link.since = now();
    const stream = open(link.creds, {
      onPart: (body) => {
        link.lastData = now();
        const ev = parseEventPart(body);
        if (ev) onEvent(link, ev);
      },
      onEnd: (reason, authRefused) => fail(link, reason, authRefused),
    });
    link.stream = stream;
    stream.ready.then(
      () => {
        if (link.stream !== stream) return;
        link.state = 'connected';
        link.since = now();
        link.error = null;
        link.failures = 0;
        link.lastData = now();
        log(`${link.creds.host} : connecte (${link.detectors.length} detecteur(s))`);
        for (const det of link.detectors) send(det.id, 'heartbeat');
      },
      () => {},
    );
  }

  function fail(link: Link, reason: string, authRefused = false): void {
    if (stopped || links.get(link.key) !== link) return;
    link.stream?.stop();
    link.stream = null;
    // Ce qui avait commence ne finira jamais sur cette connexion : retour au calme (l'incident ouvert, lui, reste).
    for (const det of link.detectors) release(det.id);
    if (link.state !== 'error' || link.error !== reason) log(`${link.creds.host} : ${reason}`);
    link.state = 'error';
    link.since = now();
    link.error = reason;
    link.failures += 1;
    // Identifiants refuses : on attend 5 min (un appareil Dahua bloque le compte apres quelques echecs). Sinon 2 s, 4 s... 60 s.
    const delay = authRefused ? 300_000 : Math.min(60_000, 1000 * 2 ** Math.min(link.failures, 6));
    clearTimeout(link.retry ?? undefined);
    link.retry = setTimeout(() => connect(link), delay);
  }

  /** Signe de vie periodique et surveillance du silence (un flux vivant envoie un « Heartbeat » toutes les 5 s). */
  const timer = setInterval(() => {
    for (const link of links.values()) {
      if (link.state !== 'connected') continue;
      if (now() - link.lastData > SILENCE_MS) {
        fail(link, "l'appareil ne donne plus de nouvelles");
        continue;
      }
      for (const det of link.detectors) {
        send(det.id, 'heartbeat');
        // Perte video commencee zone desarmee (le soir) : a l'armement, elle devient l'alarme de sabotage.
        if (blind.get(det.id) === false && armedFor(det.id)) {
          blind.set(det.id, true);
          send(det.id, 'tamper');
        }
      }
    }
  }, deps.aliveEveryMs ?? ALIVE_EVERY_MS);
  timer.unref?.();

  /** Relit la configuration : ouvre, garde ou ferme les connexions (apres un changement de source ou de camera). */
  function reload(): void {
    if (stopped) return;
    const wanted = new Map<string, { creds: Credentials; detectors: Link['detectors'] }>();
    for (const row of rows()) {
      const creds = credentials(row);
      if (!creds) continue;
      const key = `${creds.host}|${creds.port}|${creds.username}|${createHash('sha256').update(creds.password).digest('hex').slice(0, 16)}`;
      const entry = wanted.get(key) ?? { creds, detectors: [] };
      entry.detectors.push({ id: row.device_id, channel: row.channel, codes: new Set(JSON.parse(row.events) as string[]) });
      wanted.set(key, entry);
    }
    // Detecteur retire, change de voie ou d'evenements : ce qui etait en cours pour lui se termine. Une connexion fermee
    // (identifiants changes) n'enverra jamais les « Stop » attendus : idem pour ses detecteurs.
    const next = new Map([...wanted.values()].flatMap((e) => e.detectors.map((d) => [d.id, d] as const)));
    for (const link of links.values()) {
      for (const det of link.detectors) {
        const cfg = next.get(det.id);
        const same = cfg !== undefined && cfg.channel === det.channel && cfg.codes.size === det.codes.size && [...cfg.codes].every((c) => det.codes.has(c));
        if (!same) release(det.id, cfg?.channel === det.channel ? cfg.codes : undefined);
        if (cfg?.channel !== det.channel) blind.delete(det.id); // autre voie (ou plus de source) : sa perte video ne compte plus
      }
    }
    for (const [key, link] of links) {
      if (wanted.has(key)) continue;
      link.stream?.stop();
      clearTimeout(link.retry ?? undefined);
      links.delete(key);
      for (const det of link.detectors) release(det.id);
    }
    for (const [key, entry] of wanted) {
      const existing = links.get(key);
      if (existing) {
        existing.detectors = entry.detectors;
        continue;
      }
      const link: Link = { key, creds: entry.creds, detectors: entry.detectors, stream: null, state: 'connecting', since: now(), error: null, lastData: now(), retry: null, failures: 0 };
      links.set(key, link);
      connect(link);
    }
  }

  function view(detectorId: string): DetectorSourceView | null {
    const row = db.prepare('SELECT * FROM detector_source WHERE device_id = ?').get(detectorId) as { camera_id: string; channel: number; events: string; http_port: number } | undefined;
    if (!row) return null;
    const link = [...links.values()].find((l) => l.detectors.some((d) => d.id === detectorId));
    const credsOk = Boolean(rows().find((r) => r.device_id === detectorId && credentials(r)));
    return {
      cameraId: row.camera_id,
      channel: row.channel,
      events: JSON.parse(row.events) as string[],
      httpPort: row.http_port,
      connection: link
        ? { state: link.state, since: link.since, error: link.error, lastEvent: lastEvent.get(detectorId) ?? null }
        : { state: 'error', since: now(), error: credsOk ? 'connexion non ouverte' : "la camera n'a pas d'identifiants enregistres (source video RTSP ou ONVIF)", lastEvent: null },
    };
  }

  function cameraCredentials(cameraId: string, httpPort: number): Credentials {
    const cam = db.prepare("SELECT c.host, c.username, c.secret FROM camera_source c JOIN device d ON d.id = c.device_id WHERE c.device_id = ? AND d.kind = 'camera'").get(cameraId) as
      | { host: string; username: string | null; secret: string | null }
      | undefined;
    if (!cam) throw new PsimError(400, "Cette camera n'a pas de source video reelle (RTSP ou ONVIF) : ses identifiants servent a lire les evenements");
    const creds = credentials({ host: cam.host, http_port: httpPort, username: cam.username, secret: cam.secret });
    if (!creds) throw new PsimError(400, "La camera n'a pas d'utilisateur ou de mot de passe enregistre (ou ils sont illisibles) : les ressaisir dans sa source video");
    if (!DIGEST_USERNAME.test(creds.username)) throw new PsimError(400, "Nom d'utilisateur de la camera non pris en charge pour les evenements (accents, guillemets) : utiliser un compte en lettres simples");
    return creds;
  }

  function setSource(actor: string, detectorId: string, input: Record<string, unknown>): DetectorSourceView {
    const detector = engine.getDevice(detectorId);
    if (!detector || detector.kind !== 'detector') throw new PsimError(404, 'Detecteur introuvable');
    if (detector.category !== 'intrusion') throw new PsimError(400, "Les evenements Dahua alimentent un detecteur d'INTRUSION (armement, planning de nuit) : changer d'abord sa categorie");
    if (!detector.zone) throw new PsimError(400, "Donner d'abord une zone au detecteur (ex. Portail) : le planning de nuit et les destinataires s'appliquent par zone");
    const cameraId = typeof input.cameraId === 'string' ? input.cameraId : '';
    const channel = input.channel;
    if (typeof channel !== 'number' || !Number.isInteger(channel) || channel < 1 || channel > 128) throw new PsimError(400, 'Voie invalide (1 a 128)');
    const httpPort = input.httpPort === undefined ? 80 : input.httpPort;
    if (typeof httpPort !== 'number' || !Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) throw new PsimError(400, 'Port HTTP invalide (1 a 65535)');
    const events = input.events;
    if (!Array.isArray(events) || events.length === 0 || events.some((e) => typeof e !== 'string' || !ALLOWED.has(e))) {
      throw new PsimError(400, `Evenements invalides (parmi ${DAHUA_CODES.join(', ')})`);
    }
    cameraCredentials(cameraId, httpPort); // la camera doit avoir une source reelle avec identifiants
    const unique = [...new Set(events as string[])];
    db.prepare(
      `INSERT INTO detector_source (device_id, kind, camera_id, channel, events, http_port) VALUES (?, 'dahua', ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET camera_id = excluded.camera_id, channel = excluded.channel, events = excluded.events, http_port = excluded.http_port`,
    ).run(detectorId, cameraId, channel, JSON.stringify(unique), httpPort);
    // Supervision obligatoire : sans elle, un appareil hors service laisserait le detecteur « Normal » indefiniment. Jamais
    // plus courte que DAHUA_SUPERVISION_S : les signes de vie arrivent toutes les 30 s (sinon « hors ligne » en boucle).
    let supervision = '';
    if (!detector.heartbeatS || detector.heartbeatS < DAHUA_SUPERVISION_S) {
      db.prepare('UPDATE device SET heartbeat_s = ? WHERE id = ?').run(DAHUA_SUPERVISION_S, detectorId);
      supervision = ` ; supervision ${DAHUA_SUPERVISION_S} s`;
    }
    engine.audit(actor, 'detector_source_updated', { deviceId: detectorId, details: `Dahua ${cameraId} voie ${channel} : ${unique.join('+')}${supervision}` });
    reload();
    return view(detectorId)!;
  }

  function removeSource(actor: string, detectorId: string): void {
    const res = db.prepare('DELETE FROM detector_source WHERE device_id = ?').run(detectorId);
    if (Number(res.changes) === 0) throw new PsimError(404, 'Aucune source pour ce detecteur');
    engine.audit(actor, 'detector_source_removed', { deviceId: detectorId });
    reload();
  }

  /**
   * Essai : ecoute l'appareil `seconds` secondes et rapporte TOUS les evenements recus (toutes voies), pour verifier les
   * identifiants, la voie et le nom exact des evenements. Une seule tentative (jamais de rafale qui bloquerait le compte).
   */
  async function test(cameraId: string, httpPort = 80, seconds = 20): Promise<{ ok: boolean; message: string; heartbeats: number; events: (DahuaEvent & { at: number })[] }> {
    const creds = cameraCredentials(cameraId, httpPort);
    const events: (DahuaEvent & { at: number })[] = [];
    let heartbeats = 0;
    let ended: string | null = null;
    const stream = open(creds, {
      onPart: (body) => {
        const ev = parseEventPart(body);
        if (ev) {
          if (events.length < 50) events.push({ ...ev, at: now() });
        } else if (/heartbeat/i.test(body)) heartbeats += 1;
      },
      onEnd: (reason) => (ended = reason),
    });
    try {
      await stream.ready;
    } catch (err) {
      return { ok: false, message: (err as Error).message, heartbeats, events };
    }
    await new Promise((r) => setTimeout(r, Math.min(Math.max(seconds, 3), 60) * 1000));
    stream.stop();
    if (ended) return { ok: false, message: ended, heartbeats, events };
    if (heartbeats === 0 && events.length === 0) return { ok: false, message: "aucun signe de vie de l'appareil pendant l'essai", heartbeats, events };
    return {
      ok: true,
      message: `connecte ; ${heartbeats} signe(s) de vie, ${events.length} evenement(s) en ${seconds} s${events.length ? '' : " (passez devant la camera pendant l'essai, et verifiez que la detection est activee sur l'appareil)"}`,
      heartbeats,
      events,
    };
  }

  function stop(): void {
    stopped = true;
    clearInterval(timer);
    for (const link of links.values()) {
      link.stream?.stop();
      clearTimeout(link.retry ?? undefined);
    }
    for (const t of pulses.values()) clearTimeout(t);
    links.clear();
  }

  return { reload, view, setSource, removeSource, test, stop };
}

export type DahuaEvents = ReturnType<typeof createDahuaEvents>;
