import type { DatabaseSync } from 'node:sqlite';

/**
 * Continuite de surveillance. Un PSIM arrete (panne, coupure de courant, mise a jour) ne surveille plus rien,
 * et surtout ne peut pas le dire : au redemarrage, personne ne sait que des alarmes ont pu passer inapercues.
 *
 * Le PSIM note regulierement qu'il est en vie (`last_alive`) et, a l'arret propre, qu'il s'arrete (`clean`).
 * Au demarrage suivant, l'ecart entre `last_alive` et maintenant est la **periode aveugle** ; un arret sans
 * marque propre est un arret inattendu (plantage, coupure). Elle est inscrite au journal, affichee, et notifiee.
 */

export interface Gap {
  /** Dernier signe de vie avant l'arret, et reprise de la surveillance (ms). */
  from: number;
  to: number;
  durationMs: number;
  /** false = arret inattendu (plantage, coupure de courant, processus tue). */
  clean: boolean;
}

export interface ContinuityOptions {
  now?: () => number;
  /** Ecart minimal (ms) pour parler de periode aveugle : un redemarrage de quelques secondes n'en est pas une. */
  minGapMs?: number;
}

export function createContinuity(db: DatabaseSync, options: ContinuityOptions = {}) {
  const now = options.now ?? Date.now;
  const minGapMs = options.minGapMs ?? 30_000;

  db.exec('CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const read = (key: string): string | null => (db.prepare('SELECT value FROM system_state WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  const write = (key: string, value: string): void => void db.prepare('INSERT INTO system_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

  /**
   * A appeler une fois au demarrage, avant tout le reste. Renvoie la periode aveugle detectee (ou null) et la
   * conserve pour l'affichage. Marque aussitot le PSIM comme « en marche, arret non propre ».
   */
  function begin(): Gap | null {
    const t = now();
    const previous = Number(read('last_alive'));
    const clean = read('clean') === '1';
    const known = read('last_alive') !== null && Number.isFinite(previous);
    write('clean', '0');
    write('last_alive', String(t));
    // Premier demarrage, ou horloge revenue en arriere : rien de fiable a affirmer.
    if (!known || t < previous) return null;
    const durationMs = t - previous;
    // Un arret inattendu est toujours signale ; un arret propre seulement s'il a dure.
    if (durationMs < minGapMs && clean) return null;
    if (durationMs < 1000 && !clean) return null; // deux demarrages rapproches sans rien entre : bruit
    const gap: Gap = { from: previous, to: t, durationMs, clean };
    write('last_gap', JSON.stringify(gap));
    return gap;
  }

  /** Signe de vie : a appeler toutes les quelques secondes. */
  function beat(): void {
    write('last_alive', String(now()));
  }

  /** Arret volontaire (Ctrl+C, arret du service) : le prochain demarrage saura qu'il n'y a pas eu de plantage. */
  function markClean(): void {
    write('last_alive', String(now()));
    write('clean', '1');
  }

  function lastGap(): Gap | null {
    const raw = read('last_gap');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Gap;
    } catch {
      return null;
    }
  }

  return { begin, beat, markClean, lastGap };
}

export type Continuity = ReturnType<typeof createContinuity>;
