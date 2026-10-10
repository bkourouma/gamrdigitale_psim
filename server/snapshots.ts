import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Engine } from './engine.ts';
import { IMAGE_FILE, deleteImages, sealImage } from './evidence.ts';
import type { Incident } from './types.ts';

const CAPTURE_TIMEOUT_MS = 10_000;
/** Serie a l'ouverture : connexion (jusqu'a 15 s) puis environ 7 s d'images. */
const SERIES_TIMEOUT_MS = 30_000;

export interface SnapshotDeps {
  db: DatabaseSync;
  engine: Engine;
  dataDir: string;
  /** Lit une image JPEG de la camera (leve une exception si elle n'a pas de source reelle). */
  grab: (cameraId: string) => Promise<Buffer>;
  /**
   * Plusieurs images espacees (une connexion), avec leur heure. Utilisee a l'OUVERTURE d'un incident : c'est la que la
   * personne est encore dans le champ. Absente : une seule image, comme aux autres etapes.
   */
  grabSeries?: (cameraId: string, count: number) => Promise<{ frame: Buffer; at: number }[]>;
  /** Nombre d'images de la serie d'ouverture (defaut 1 = pas de serie). */
  seriesCount?: number;
  /** Plafond d'images par incident (evite de remplir le disque pendant un incident qui dure). */
  maxPerIncident?: number;
  publishIncident: (incidentId: number) => void;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolveValue, reject) => {
    const timer = setTimeout(() => reject(new Error('delai depasse')), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolveValue(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

const isJpeg = (b: Buffer) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;

export function createSnapshotService(deps: SnapshotDeps) {
  const { db, engine } = deps;
  const dir = resolve(deps.dataDir, 'snapshots');
  const max = deps.maxPerIncident ?? 12;
  const seriesCount = deps.grabSeries ? Math.max(1, deps.seriesCount ?? 1) : 1;
  mkdirSync(dir, { recursive: true });
  // Images des cameras liees seulement : celles envoyees par un equipement ont leur propre plafond (deviceimages.ts).
  const countFor = (incidentId: number) =>
    (db.prepare("SELECT COUNT(*) AS n FROM incident_snapshot WHERE incident_id = ? AND source = 'camera'").get(incidentId) as { n: number }).n;
  const audit = (actor: string, action: string, ref?: { incidentId?: number; deviceId?: string; details?: string }) => engine.audit(actor, action, ref);

  /**
   * Prend une image de chaque camera liee a l'incident. A lancer SANS attendre (tache de fond) :
   * l'alarme est deja publiee, une capture lente ou en echec ne la retarde jamais.
   * Une camera sans source reelle (simulee dans le navigateur) est simplement ignoree.
   */
  async function capture(incident: Incident, reason: 'opened' | 'escalated' | 'confirmed'): Promise<number> {
    let saved = 0;
    await Promise.all(
      incident.cameraIds.map(async (cameraId) => {
        if (countFor(incident.id) >= max) return;
        const device = engine.getDevice(cameraId);
        if (device?.streamKind !== 'onvif' && device?.streamKind !== 'rtsp') return;
        try {
          const series = reason === 'opened' && seriesCount > 1;
          const shots = series
            ? await withTimeout(deps.grabSeries!(cameraId, seriesCount), SERIES_TIMEOUT_MS)
            : [{ frame: await withTimeout(deps.grab(cameraId), CAPTURE_TIMEOUT_MS), at: Date.now() }];
          const valid = shots.filter((s) => isJpeg(s.frame));
          if (valid.length === 0) throw new Error('image invalide');
          for (const shot of valid) {
            // Plafond reverifie ici : plusieurs cameras capturent en parallele et la lecture se fait apres l'attente.
            if (countFor(incident.id) >= max) break;
            // Enregistrement ET scellement au journal (empreinte SHA-256) : meme point que les images des equipements.
            sealImage(db, dir, audit, { incidentId: incident.id, deviceId: cameraId, takenAt: shot.at, reason, source: 'camera', data: shot.frame, type: 'jpg' });
            saved++;
          }
        } catch (err) {
          engine.audit('systeme', 'snapshot_failed', {
            incidentId: incident.id,
            deviceId: cameraId,
            details: err instanceof Error ? err.message.slice(0, 120) : 'echec',
          });
        }
      }),
    );
    if (saved > 0) deps.publishIncident(incident.id);
    return saved;
  }

  /** Contenu d'une image, ou null si elle n'existe pas. Le chemin vient uniquement de la base (nom numerique verifie). */
  function read(snapshotId: number): Buffer | null {
    const row = db.prepare('SELECT file FROM incident_snapshot WHERE id = ?').get(snapshotId) as { file: string } | undefined;
    if (!row || !IMAGE_FILE.test(row.file)) return null;
    const path = join(dir, row.file);
    return existsSync(path) ? readFileSync(path) : null;
  }

  /**
   * Supprime les images plus anciennes que `days` jours (0 = jamais), SAUF celles des incidents non clos (preuves d'un
   * incident en cours) ; la suppression est inscrite au journal (voir evidence.ts). Renvoie le nombre supprime.
   */
  function purge(days: number, now = Date.now()): number {
    if (days <= 0) return 0;
    const cutoff = now - days * 86_400_000;
    const old = db
      .prepare("SELECT s.id FROM incident_snapshot s JOIN incident i ON i.id = s.incident_id WHERE s.taken_at < ? AND i.status = 'closed' ORDER BY s.id")
      .all(cutoff) as { id: number }[];
    return deleteImages(db, dir, audit, old.map((r) => r.id), `conservation ${days} jours`);
  }

  /** Espace occupe (octets), pour information. */
  function sizeOnDisk(): number {
    return readdirSync(dir).reduce((sum, f) => sum + statSync(join(dir, f)).size, 0);
  }

  return { capture, read, purge, sizeOnDisk };
}

export type SnapshotService = ReturnType<typeof createSnapshotService>;
