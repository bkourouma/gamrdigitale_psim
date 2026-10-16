/**
 * Presence dans le champ des cameras : debuts et fins de « quelqu'un est vu » (SmartMotionHuman de l'enregistreur Dahua),
 * conserves tels quels (le lissage est fait par les regles, voir docs/PRESENCE-REGLES.md).
 *
 *  - une observation (hote, voie, code, action) designe la ou les cameras dont la source video (camera_source) a le meme
 *    hote et un chemin RTSP contenant « channel=<voie> » ; sans camera correspondante, elle est ignoree ;
 *  - seuls les codes de PRESENCE_CODES comptent ; Start et Stop seulement ; un Start sur une camera deja occupee et un Stop sur
 *    une camera libre sont ignores (aucune ligne en double) ;
 *  - flux perdu (linkLost) : la presence de chaque camera occupee de l'hote se termine (le Stop ne viendra jamais) ;
 *  - au demarrage, toute camera dont la derniere ligne est un « start » recoit un « stop » (la connexion precedente est
 *    perdue) : l'etat courant repart vide et l'historique reste coherent ;
 *  - historique borne dans le temps (30 jours par defaut). Horodatages en millisecondes.
 */
import type { DatabaseSync } from 'node:sqlite';

/** Evenements Dahua qui signalent un humain dans le champ d'une camera. */
export const PRESENCE_CODES = ['SmartMotionHuman'] as const;
const CODES = new Set<string>(PRESENCE_CODES);
const DAY_MS = 86_400_000;

export interface PresenceChange {
  cameraId: string;
  kind: 'start' | 'stop';
  at: number;
  /** Code de l'evenement d'origine, ou « link_lost » (flux perdu), ou « restart » (redemarrage du PSIM). */
  source: string;
}

export const PRESENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS presence_event (
  id INTEGER PRIMARY KEY,
  camera_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('start','stop')),
  at INTEGER NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_presence_event_at ON presence_event(at);
`;

export function createPresence(deps: { db: DatabaseSync; now?: () => number; retentionDays?: number }) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const retentionMs = (deps.retentionDays ?? 30) * DAY_MS;
  db.exec(PRESENCE_SCHEMA);

  const current = new Map<string, { since: number }>();
  const listeners = new Set<(c: PresenceChange) => void>();
  const insert = db.prepare('INSERT INTO presence_event (camera_id, kind, at, source) VALUES (?, ?, ?, ?)');

  // Reprise : une presence ouverte avant l'arret ne sera jamais terminee par l'ancienne connexion.
  const open = db
    .prepare("SELECT camera_id FROM presence_event WHERE id IN (SELECT MAX(id) FROM presence_event GROUP BY camera_id) AND kind = 'start'")
    .all() as { camera_id: string }[];
  for (const row of open) insert.run(row.camera_id, 'stop', now(), 'restart');

  function camerasOf(host: string, channel?: number): string[] {
    const rows = db.prepare('SELECT device_id, rtsp_path FROM camera_source WHERE host = ? AND rtsp_path IS NOT NULL ORDER BY device_id').all(host) as { device_id: string; rtsp_path: string }[];
    if (channel === undefined) return rows.map((r) => r.device_id);
    // Borne apres le numero : « channel=1 » ne designe pas « channel=10 ».
    const wanted = new RegExp(`channel=${channel}(?![0-9])`, 'i');
    return rows.filter((r) => wanted.test(r.rtsp_path)).map((r) => r.device_id);
  }

  function record(cameraId: string, kind: 'start' | 'stop', at: number, source: string): void {
    insert.run(cameraId, kind, at, source);
    if (kind === 'start') current.set(cameraId, { since: at });
    else current.delete(cameraId);
    const change: PresenceChange = { cameraId, kind, at, source };
    for (const fn of [...listeners]) {
      try {
        fn(change);
      } catch (err) {
        console.error(`[presence] abonne en erreur : ${(err as Error).message}`);
      }
    }
  }

  return {
    observe(o: { host: string; channel: number; code: string; action: string; at: number }): void {
      if (!CODES.has(o.code) || !Number.isInteger(o.channel)) return;
      const action = o.action.toLowerCase();
      if (action !== 'start' && action !== 'stop') return;
      for (const cameraId of camerasOf(o.host, o.channel)) {
        const busy = current.has(cameraId);
        if (action === 'start' && !busy) record(cameraId, 'start', o.at, o.code);
        else if (action === 'stop' && busy) record(cameraId, 'stop', o.at, o.code);
      }
    },

    /** Le flux de l'hote est perdu : la presence de chaque camera occupee de cet hote se termine. */
    linkLost(host: string): void {
      for (const cameraId of camerasOf(host)) if (current.has(cameraId)) record(cameraId, 'stop', now(), 'link_lost');
    },

    occupied(cameraId: string): { since: number } | null {
      const c = current.get(cameraId);
      return c ? { since: c.since } : null;
    },

    current(): Record<string, { since: number }> {
      return Object.fromEntries([...current].map(([id, c]) => [id, { since: c.since }]));
    },

    subscribe(fn: (c: PresenceChange) => void): () => void {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },

    /** Changements dont `at` est dans [from, to], tries par `at` puis `id` ; `cameraIds` limite aux cameras citees. */
    history(from: number, to: number, cameraIds?: string[]): PresenceChange[] {
      if (cameraIds && cameraIds.length === 0) return [];
      const filter = cameraIds ? ` AND camera_id IN (${cameraIds.map(() => '?').join(',')})` : '';
      const rows = db
        .prepare(`SELECT camera_id, kind, at, source FROM presence_event WHERE at >= ? AND at <= ?${filter} ORDER BY at, id`)
        .all(from, to, ...(cameraIds ?? [])) as { camera_id: string; kind: 'start' | 'stop'; at: number; source: string }[];
      return rows.map((r) => ({ cameraId: r.camera_id, kind: r.kind, at: r.at, source: r.source }));
    },

    /** Efface ce qui depasse la duree de conservation ; renvoie le nombre de lignes effacees. */
    purge(): number {
      return Number(db.prepare('DELETE FROM presence_event WHERE at < ?').run(now() - retentionMs).changes);
    },
  };
}

export type Presence = ReturnType<typeof createPresence>;
