/**
 * Visages vus devant les cameras : enregistrement des observations « FaceRecognition » (reconnu / inconnu), lues par faces.ts,
 * pour les regles d'identite (rules.ts) et leur essai sur le passe. Contrat : docs/PRESENCE-REGLES.md.
 *
 *  - une observation (hote, voie, code, action, data) designe la ou les cameras de meme hote et de meme voie que pour la
 *    presence (camerasOfSource de presence.ts) ; une ligne par camera correspondante ; sans camera correspondante, elle est ignoree ;
 *  - seuls FaceRecognition et FaceDetection sont lus ; FaceDetection (« un visage est la », aucune identite, risque de deluge)
 *    et toute observation nulle ne sont PAS enregistres ;
 *  - JAMAIS de photo ni d'octets d'image : `data` est lu par parseFaceEvent (champs connus seulement) et rien n'en est garde,
 *    seuls les champs de FaceObservation arrivent en base ;
 *  - doublon : un Start suivi d'un Pulse pour la meme reconnaissance (meme camera, meme personne, meme `at`) n'est enregistre qu'une fois
 *    (comparaison avec la derniere ligne de la camera, en memoire) ;
 *  - ne leve jamais d'exception sur une donnee d'appareil ; un abonne en erreur ne casse pas les autres ;
 *  - historique borne dans le temps (30 jours par defaut). Horodatages en millisecondes.
 */
import type { DatabaseSync } from 'node:sqlite';
import { parseFaceEvent } from './faces.ts';
import { camerasOfSource } from './presence.ts';

const DAY_MS = 86_400_000;
const DEFAULT_RECENT = 50;
const MAX_RECENT = 200;

export interface FaceSeen {
  id?: number;
  cameraId: string;
  at: number;
  kind: 'recognized' | 'unknown';
  personId: string | null;
  personName: string | null;
  groupId: string | null;
  groupName: string | null;
  similarity: number | null;
}

export const FACE_OBS_SCHEMA = `
CREATE TABLE IF NOT EXISTS face_event (
  id INTEGER PRIMARY KEY,
  camera_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('recognized','unknown')),
  person_uid TEXT,
  person_name TEXT,
  group_id TEXT,
  group_name TEXT,
  similarity REAL
);
CREATE INDEX IF NOT EXISTS idx_face_event_at ON face_event(at);
`;

type Row = Record<string, unknown>;

const seenOf = (r: Row): FaceSeen => ({
  id: r.id as number,
  cameraId: r.camera_id as string,
  at: r.at as number,
  kind: r.kind as 'recognized' | 'unknown',
  personId: (r.person_uid as string | null) ?? null,
  personName: (r.person_name as string | null) ?? null,
  groupId: (r.group_id as string | null) ?? null,
  groupName: (r.group_name as string | null) ?? null,
  similarity: (r.similarity as number | null) ?? null,
});

export function createFaceObs(deps: { db: DatabaseSync; now?: () => number; retentionDays?: number }) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const retentionMs = (deps.retentionDays ?? 30) * DAY_MS;
  db.exec(FACE_OBS_SCHEMA);

  const listeners = new Set<(s: FaceSeen) => void>();
  const insert = db.prepare('INSERT INTO face_event (camera_id, at, kind, person_uid, person_name, group_id, group_name, similarity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  /** Derniere observation enregistree par camera : cle « type|personne|date ». */
  const last = new Map<string, string>();

  return {
    observe(o: { host: string; channel: number; code: string; action: string; at: number; data: string | null }): void {
      try {
        if (o.code !== 'FaceRecognition' && o.code !== 'FaceDetection') return;
        const obs = parseFaceEvent(o.code, o.action, o.channel, o.data, o.at);
        if (!obs || obs.kind === 'detected') return;
        const kind = obs.kind;
        for (const cameraId of camerasOfSource(db, o.host, o.channel)) {
          const key = `${kind}|${obs.personId ?? ''}|${obs.at}`;
          if (last.get(cameraId) === key) continue; // Start + Pulse de la meme reconnaissance
          last.set(cameraId, key);
          const seen: FaceSeen = {
            cameraId,
            at: obs.at,
            kind,
            personId: obs.personId ?? null,
            personName: obs.personName ?? null,
            groupId: obs.groupId ?? null,
            groupName: obs.groupName ?? null,
            similarity: obs.similarity ?? null,
          };
          const res = insert.run(seen.cameraId, seen.at, seen.kind, seen.personId, seen.personName, seen.groupId, seen.groupName, seen.similarity);
          seen.id = Number(res.lastInsertRowid);
          for (const fn of [...listeners]) {
            try {
              fn({ ...seen });
            } catch (err) {
              console.error(`[faceobs] abonne en erreur : ${(err as Error).message}`);
            }
          }
        }
      } catch (err) {
        console.error(`[faceobs] observation ignoree : ${(err as Error).message}`);
      }
    },

    subscribe(fn: (s: FaceSeen) => void): () => void {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },

    /** Observations dont `at` est dans [from, to], triees par `at` puis `id` ; `cameraIds` limite aux cameras citees. */
    history(from: number, to: number, cameraIds?: string[]): FaceSeen[] {
      if (cameraIds && cameraIds.length === 0) return [];
      const filter = cameraIds ? ` AND camera_id IN (${cameraIds.map(() => '?').join(',')})` : '';
      const rows = db
        .prepare(`SELECT * FROM face_event WHERE at >= ? AND at <= ?${filter} ORDER BY at, id`)
        .all(from, to, ...(cameraIds ?? [])) as Row[];
      return rows.map(seenOf);
    },

    /** Les plus recentes d'abord (defaut 50, au plus 200). */
    recent(limit?: number): FaceSeen[] {
      const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.min(MAX_RECENT, Math.max(1, Math.floor(limit))) : DEFAULT_RECENT;
      return (db.prepare('SELECT * FROM face_event ORDER BY at DESC, id DESC LIMIT ?').all(n) as Row[]).map(seenOf);
    },

    /** Efface ce qui depasse la duree de conservation ; renvoie le nombre de lignes effacees. */
    purge(): number {
      return Number(db.prepare('DELETE FROM face_event WHERE at < ?').run(now() - retentionMs).changes);
    },
  };
}

export type FaceObs = ReturnType<typeof createFaceObs>;
