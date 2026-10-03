import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Journal infalsifiable. Chaque entree du journal contient l'empreinte SHA-256 de la precedente : modifier,
 * supprimer ou inserer une ligne apres coup rompt la chaine a cet endroit, et la verification le montre.
 *
 *   hash(n) = SHA-256( hash(n-1), id, date, auteur, action, incident, equipement, details )
 *
 * CE QUE CELA PROTEGE, ET CE QUE CELA NE PROTEGE PAS (a lire avant d'en parler a un assureur) :
 *  - protege contre une modification ou une suppression MALADROITE ou PARTIELLE : quelqu'un qui change une ligne, en
 *    efface une, ou en ajoute une a la main dans la base. La verification indique laquelle ;
 *  - ne protege PAS seule contre quelqu'un qui a un acces complet a la base ET connait ce mecanisme : il peut
 *    recalculer toute la chaine depuis la ligne modifiee. C'est pourquoi l'empreinte de la derniere entree (l'« ancre »)
 *    est aussi envoyee hors de la machine (rapport par e-mail, sauvegardes) : une chaine reecrite ne correspond plus
 *    a l'ancre conservee ailleurs, et la verification peut la comparer (`--anchor`) ;
 *  - ne couvre que le journal (`audit_log`), pas les autres tables ;
 *  - les entrees anterieures a l'activation du mecanisme ne sont pas protegees (comptees a part).
 */

export const GENESIS = 'GENESIS';

export interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  action: string;
  incident_id: number | null;
  device_id: string | null;
  details: string | null;
}

export function computeHash(prev: string, r: AuditRow): string {
  // Un tableau JSON est sans ambiguite : aucun champ ne peut « deborder » sur le suivant.
  return createHash('sha256').update(JSON.stringify([prev, r.id, r.ts, r.actor, r.action, r.incident_id, r.device_id, r.details])).digest('hex');
}

type Row = Record<string, unknown>;

export function headOf(db: DatabaseSync): { id: number; hash: string } | null {
  const r = db.prepare('SELECT id, hash FROM audit_log WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1').get() as Row | undefined;
  return r ? { id: r.id as number, hash: r.hash as string } : null;
}

/**
 * Ecrit une entree scellee et renvoie son identifiant. Synchrone et sans transaction propre : elle peut donc etre
 * appelee dans une transaction en cours (un retour en arriere annule aussi l'entree, et son numero).
 */
export function appendSealed(db: DatabaseSync, entry: Omit<AuditRow, 'id'>): number {
  const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit_log'").get() as { seq: number } | undefined;
  const id = (seq?.seq ?? 0) + 1;
  const prev = headOf(db)?.hash ?? GENESIS;
  const row: AuditRow = { id, ...entry };
  db.prepare('INSERT INTO audit_log (id, ts, actor, action, incident_id, device_id, details, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, row.ts, row.actor, row.action, row.incident_id, row.device_id, row.details, prev, computeHash(prev, row),
  );
  return id;
}

export interface Problem {
  id: number;
  reason: string;
}

export interface Verification {
  ok: boolean;
  /** Entrees scellees verifiees, et entrees anterieures au mecanisme (non protegees). */
  checked: number;
  unprotected: number;
  head: { id: number; hash: string } | null;
  problems: Problem[];
  at: number;
}

export interface Anchor {
  id: number;
  hash: string;
}

const MAX_PROBLEMS = 20;

/** Parcourt toute la chaine ; `anchors` = empreintes conservees AILLEURS (e-mail, sauvegarde) a retrouver telles quelles. */
export function verify(db: DatabaseSync, anchors: Anchor[] = [], now = Date.now()): Verification {
  const problems: Problem[] = [];
  const add = (id: number, reason: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push({ id, reason });
  };
  let prev: string | null = null;
  let prevId = 0;
  let checked = 0;
  let unprotected = 0;
  let head: Verification['head'] = null;
  const byId = new Map<number, string>();
  const wanted = new Set(anchors.map((a) => a.id));

  for (const r of db.prepare('SELECT * FROM audit_log ORDER BY id').iterate() as IterableIterator<Row>) {
    const id = r.id as number;
    const hash = (r.hash as string | null) ?? null;
    if (hash === null) {
      if (prev === null) unprotected++; // anterieure au mecanisme
      else add(id, "entree non scellee au milieu de la chaine (inseree hors du PSIM ?)");
      continue;
    }
    const row: AuditRow = { id, ts: r.ts as number, actor: r.actor as string, action: r.action as string, incident_id: (r.incident_id as number | null) ?? null, device_id: (r.device_id as string | null) ?? null, details: (r.details as string | null) ?? null };
    // Numeros CONSECUTIFS : une entree supprimee laisse un trou, meme si quelqu'un a recalcule les empreintes qui suivent.
    // (Une transaction annulee annule aussi son numero, voir appendSealed : aucun trou legitime.)
    if (prev !== null && id !== prevId + 1) add(id, `${id - prevId - 1 > 0 ? id - prevId - 1 : 'des'} entree(s) manquante(s) avant celle-ci : supprimee(s) apres coup`);
    prevId = id;
    const expectedPrev = prev ?? GENESIS;
    if ((r.prev_hash as string | null) !== expectedPrev) add(id, prev === null ? 'debut de chaine invalide' : 'chainage rompu : une entree precedente a ete supprimee ou modifiee');
    if (computeHash((r.prev_hash as string | null) ?? '', row) !== hash) add(id, 'contenu modifie apres coup');
    prev = hash;
    checked++;
    head = { id, hash };
    if (wanted.has(id)) byId.set(id, hash);
  }

  // Fin de journal supprimee : le compteur d'identifiants de SQLite est plus avance que la derniere entree.
  if (head) {
    const seq = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit_log'").get() as { seq: number } | undefined)?.seq ?? head.id;
    if (seq > head.id) add(head.id, `la fin du journal a ete supprimee (derniere entree n°${head.id}, compteur a ${seq})`);
  }

  for (const a of anchors) {
    const found = byId.get(a.id);
    if (found === undefined) add(a.id, `ancre n°${a.id} introuvable : entrees supprimees ou chaine reecrite`);
    else if (found !== a.hash) add(a.id, `ancre n°${a.id} differente de celle conservee ailleurs : chaine reecrite`);
  }
  // Une ancre PLUS RECENTE que la fin de la chaine = la queue du journal a ete supprimee.
  if (head) for (const a of anchors) if (a.id > head.id) add(a.id, `ancre n°${a.id} posterieure a la derniere entree (n°${head.id}) : fin du journal supprimee`);

  return { ok: problems.length === 0, checked, unprotected, head, problems, at: now };
}

/** Lit « 1234:abcdef... » (la forme imprimee dans les rapports). */
export function parseAnchor(text: string): Anchor | null {
  const m = /^(\d{1,12}):([0-9a-f]{64})$/i.exec(text.trim());
  return m ? { id: Number(m[1]), hash: m[2].toLowerCase() } : null;
}

export const formatAnchor = (a: Anchor): string => `${a.id}:${a.hash}`;
