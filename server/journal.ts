import type { DatabaseSync } from 'node:sqlite';
import { verify } from './auditchain.ts';
import type { Anchor, Verification } from './auditchain.ts';

/**
 * Surveillance du journal : verification periodique de la chaine d'empreintes, ancres quotidiennes, et alerte si le
 * journal a ete altere. Voir auditchain.ts pour ce que la protection couvre, et ses limites.
 */

const MAX_ANCHORS = 60;
const DAY_MS = 86_400_000;

export interface JournalGuardOptions {
  db: DatabaseSync;
  now?: () => number;
  /** Appele UNE fois par alteration constatee (pas a chaque verification) : journal, notification. */
  onBroken?: (result: Verification) => void;
  onRecovered?: () => void;
}

export function createJournalGuard(options: JournalGuardOptions) {
  const { db } = options;
  const now = options.now ?? Date.now;
  db.exec('CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  let last: Verification | null = null;
  let lastSignature = '';

  const readJson = <T>(key: string, fallback: T): T => {
    const r = db.prepare('SELECT value FROM system_state WHERE key = ?').get(key) as { value: string } | undefined;
    try {
      return r ? (JSON.parse(r.value) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  const writeJson = (key: string, value: unknown): void =>
    void db.prepare('INSERT INTO system_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));

  type StoredAnchor = Anchor & { at: number };
  const anchors = (): StoredAnchor[] => readJson<StoredAnchor[]>('audit_anchors', []);

  /** Memorise l'empreinte de fin de journal (au plus une par jour). Les copies hors machine sont les seules qui font foi. */
  function anchorNow(): StoredAnchor | null {
    const result = verify(db, [], now());
    if (!result.ok || !result.head) return null; // on n'ancre jamais une chaine deja brisee
    const list = anchors();
    const lastAnchor = list[list.length - 1];
    if (lastAnchor && lastAnchor.id === result.head.id) return lastAnchor;
    if (lastAnchor && now() - lastAnchor.at < DAY_MS) return lastAnchor;
    const anchor: StoredAnchor = { ...result.head, at: now() };
    writeJson('audit_anchors', [...list, anchor].slice(-MAX_ANCHORS));
    return anchor;
  }

  /** Verifie la chaine ET les ancres memorisees ; `extra` = ancres fournies de l'exterieur (e-mail, sauvegarde). */
  function check(extra: Anchor[] = []): Verification {
    const result = verify(db, [...anchors().map(({ id, hash }) => ({ id, hash })), ...extra], now());
    last = result;
    const signature = result.ok ? '' : result.problems.map((p) => `${p.id}:${p.reason}`).join('|');
    if (!result.ok && signature !== lastSignature) options.onBroken?.(result);
    if (result.ok && lastSignature !== '') options.onRecovered?.();
    lastSignature = signature;
    writeJson('journal_last_check', { ok: result.ok, at: result.at, checked: result.checked, problems: result.problems.slice(0, 5) });
    return result;
  }

  return {
    check,
    anchorNow,
    anchors,
    last: (): Verification | null => last,
    /** Derniere verification connue, meme apres un redemarrage. */
    lastKnown: (): { ok: boolean; at: number; checked: number } | null => readJson('journal_last_check', null),
  };
}

export type JournalGuard = ReturnType<typeof createJournalGuard>;
