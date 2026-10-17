/**
 * Synchronisation des titulaires PSIM -> controleurs (lot AC5, phase 2). Contrats : docs/CONTROLE-ACCES.md § 7 (protocole fige),
 * docs/ACCES.md § 12.1, 12.2, 12.3 et 12.4 (precisions), types partages : server/accessholderstypes.ts.
 *
 * Principe : le PSIM est la reference. Pour chaque controleur il sait ce que celui-ci DOIT contenir (`RightsSource.desired`) et ce que
 * le controleur a ACCUSE avoir recu. Chaque element (titulaire, plage horaire, jours feries) porte deux empreintes : `wanted_hash`
 * (le voulu, NULL = ne doit pas exister) et `acked_hash` (ce que le controleur a confirme, NULL = absent). Une operation est
 * necessaire tant que les deux different. Le PSIM ne lit jamais le contenu du controleur : il ne supprime que ce qu'il y a envoye.
 *
 * File : par controleur, UNE seule operation en vol, ecrite en base AVANT d'etre publiee (`seq`, opId, ts et body y sont figes ; un
 * renvoi ne recalcule que la signature). Un redemarrage brutal reprend donc exactement la meme operation.
 *
 * Securite : la cle de synchronisation (32 octets) est creee ici, scellee par secrets.ts, montree UNE fois par `issueKey`, puis
 * jamais relue ni journalisee. Les accuses sont verifies (controleur, cle, format, signature en temps constant, operation en vol
 * avec les memes opId ET seq) avant tout changement d'etat ; tout le reste est ignore sans effet.
 *
 * Journal infalsifiable : jamais de cle, jamais d'identifiant de controleur, jamais de nom ni de numero de badge (identifiants
 * `H12`, `S3` et nombres seulement).
 */
import { createHash, createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { PsimError } from './errors.ts';
import { seal, unseal } from './secrets.ts';
import type {
  AckVerdict,
  DesiredHolder,
  DesiredSchedule,
  DesiredState,
  HolderSyncView,
  RightsSource,
  SyncControllerDetail,
  SyncControllerStatus,
  SyncItemKind,
  SyncItemView,
  SyncService,
  SyncState,
  SyncTransport,
} from './accessholderstypes.ts';

// ---- Constantes du protocole ------------------------------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const OPID_PATTERN = /^[0-9a-f]{32}$/;
const SIG_PATTERN = /^[0-9a-f]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Taille maximale d'un message publie (limite du broker), en octets UTF-8. */
export const MAX_MESSAGE_BYTES = 1024;
/** Taille maximale du champ `body` d'un ordre (la passerelle refuse au-dela, en plus de la limite du message entier). */
export const MAX_BODY_BYTES = 800;
/** Taille maximale d'un accuse accepte. */
export const MAX_ACK_BYTES = 2048;
/** Dates par message `set_holidays`. */
export const HOLIDAYS_PER_MESSAGE = 40;
/** Attente avant le premier renvoi ; double a chaque essai, jusqu'au plafond. */
export const BASE_RETRY_MS = 10_000;
export const MAX_RETRY_MS = 60 * 60 * 1000;
/** Au-dela de ce nombre d'essais sans accuse, l'element passe en echec (les essais continuent). */
export const FAIL_AFTER_ATTEMPTS = 5;
/** Suppressions de titulaires au-dela desquelles l'administrateur doit confirmer (en attente + deja envoyees dans l'heure). */
export const MASS_DELETE_LIMIT = 20;
export const MASS_DELETE_WINDOW_MS = 60 * 60 * 1000;
const LOG_KEEP = 200;
const ACK_INVALID_EVERY_MS = 60 * 60 * 1000;
const DETAIL_ITEMS_MAX = 200;
const AWAITING_REFS_MAX = 20;
const PURGE_CHECK_EVERY_MS = 30_000;
const MAX_NAME = 64;
const MAX_STEPS = 100_000;
/** Marqueur d'empreinte pour « supprimer » (l'empreinte voulue est alors NULL). */
const DELETE_MARK = 'delete';

const ACK_RESULTS = ['done', 'refused', 'error'] as const;
type AckResult = (typeof ACK_RESULTS)[number];
/** Motif d'un code d'accuse : la passerelle en renvoie plusieurs (not_supported, invalid, full, io, unreachable, timeout, busy...). */
const CODE_PATTERN = /^[a-z0-9_]{1,32}$/;

// ---- Messages en francais -----------------------------------------------------------------------------------------------------

const MSG_NO_KEY = "La synchronisation n'est pas activée pour ce contrôleur. Activez-la pour envoyer les titulaires.";
const MSG_NO_TRANSPORT = "Le lien avec la passerelle n'est pas connecté : les changements partiront dès qu'il le sera.";
const MSG_NO_ACK =
  "La passerelle ne répond pas. Vérifiez qu'elle est allumée, connectée au PSIM et que la clé de synchronisation de ce contrôleur est bien celle du PSIM.";
const MSG_FULL = 'La mémoire du contrôleur est pleine : supprimez des titulaires inutiles sur le contrôleur.';
const MSG_INVALID = 'Le contrôleur a refusé ces données (nom, horaires ou badges non acceptés). Corrigez la fiche puis cliquez sur Réessayer.';
const MSG_NOT_SUPPORTED = 'Ce contrôleur ne sait pas faire cette opération.';
const MSG_IO = "Le contrôleur n'a pas pu enregistrer ce changement (erreur de communication avec le matériel). Nouvel essai automatique.";
const MSG_UNREACHABLE =
  "La passerelle n'arrive pas à joindre le contrôleur. Vérifiez qu'il est allumé et branché au réseau. Nouvel essai automatique.";
const MSG_TOO_BIG = 'Ce changement est trop volumineux pour être envoyé : raccourcissez le nom du titulaire ou réduisez le nombre de plages horaires.';
const MSG_TIMEOUT = 'Le contrôleur a mis trop de temps à répondre : nouvel essai automatique.';
const MSG_BUSY = 'La passerelle a trop de changements en attente : nouvel essai automatique.';
const MSG_HOLIDAYS_NOT_SUPPORTED =
  "Ce contrôleur ne sait pas encore appliquer « fermé les jours fériés » : retirez l'option de cette plage ou attendez la qualification.";
const msgScheduleUnsent = (ref: string): string => `L'horaire de ce titulaire n'a pas pu être envoyé au contrôleur (voir l'état de la plage ${ref}).`;
const MSG_BLOCKED = `Suppression retenue : plus de ${MASS_DELETE_LIMIT} titulaires à retirer d'un coup. Un administrateur doit la confirmer.`;
const MSG_KEY_UNREADABLE =
  "La clé de synchronisation de ce contrôleur est illisible (clé du serveur changée ?). Renouvelez-la pour reprendre l'envoi des titulaires.";

function messageForCode(code: string | null): string {
  switch (code) {
    case 'no_ack':
      return MSG_NO_ACK;
    case 'full':
      return MSG_FULL;
    case 'invalid':
      return MSG_INVALID;
    case 'not_supported':
      return MSG_NOT_SUPPORTED;
    case 'io':
      return MSG_IO;
    case 'unreachable':
      return MSG_UNREACHABLE;
    case 'timeout':
      return MSG_TIMEOUT;
    case 'busy':
      return MSG_BUSY;
    default:
      return "Le contrôleur n'a pas appliqué ce changement. Cliquez sur Réessayer.";
  }
}

// ---- Schema ------------------------------------------------------------------------------------------------------------------

/**
 * Migration : `CREATE TABLE / INDEX IF NOT EXISTS` seulement. Pas de cle etrangere : la suppression d'un controleur n'est jamais
 * bloquee par la synchronisation (ses lignes sont retirees ici, voir `purgeController`).
 */
export function migrateSync(db: DatabaseSync): void {
  db.exec(`
-- Cle de synchronisation d'un controleur : 32 octets aleatoires, scellee (secrets.ts), ECRITURE SEULE (montree une fois a la creation).
CREATE TABLE IF NOT EXISTS access_sync_key (
  controller_id TEXT PRIMARY KEY,
  sealed TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
);
-- Etat par controleur : dernier seq (jamais decremente), dernier accuse, et L'OPERATION EN VOL (op_*), persistee avant publication.
CREATE TABLE IF NOT EXISTS access_sync_controller (
  controller_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0,
  last_ack_at INTEGER,
  problem_code TEXT,
  problem_message TEXT,
  problem_at INTEGER,
  ack_invalid_at INTEGER,
  held_logged INTEGER NOT NULL DEFAULT 0,
  op_id TEXT,
  op_seq INTEGER,
  op_ts INTEGER,
  op_body TEXT,
  op_kind TEXT,
  op_ref TEXT,
  op_op TEXT,
  op_hash TEXT,
  op_chunk INTEGER NOT NULL DEFAULT 0,
  op_last INTEGER NOT NULL DEFAULT 1,
  op_attempts INTEGER NOT NULL DEFAULT 0,
  op_sent_at INTEGER,
  op_next_at INTEGER,
  -- 1 : la passerelle a accuse \`error\` pour l'operation en vol. Elle a consomme son seq (et renverrait le meme accuse) : l'operation n'est
  -- plus renvoyee, elle est REMPLACEE (nouveau seq, nouvel opId) a l'echeance du prochain essai.
  op_dead INTEGER NOT NULL DEFAULT 0
);
-- Un element a synchroniser. wanted_hash NULL = ne doit pas exister ; acked_hash NULL = absent du controleur. wanted_body : corps
-- voulu (titulaire, plage) ou liste JSON des dates (jours feries), sans PIN ni photo.
CREATE TABLE IF NOT EXISTS access_sync_item (
  controller_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('holder', 'schedule', 'holidays')),
  ref TEXT NOT NULL,
  wanted_hash TEXT,
  wanted_body TEXT,
  acked_hash TEXT,
  state TEXT NOT NULL CHECK (state IN ('synced', 'pending', 'failed', 'blocked')),
  attempts INTEGER NOT NULL DEFAULT 0,
  code TEXT,
  message TEXT,
  since INTEGER NOT NULL,
  held INTEGER NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  failed_hash TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  -- rank : ordre d'envoi (0 jours feries, 1 plages creees, 2 titulaires crees, 3 titulaires supprimes, 4 plages supprimees) ;
  -- todo : 1 si une operation est a envoyer (voulu <> accuse, ni retenu, ni refuse definitivement). Maintenus par saveItem.
  rank INTEGER NOT NULL DEFAULT 0,
  todo INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (controller_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS access_sync_item_ref ON access_sync_item(kind, ref);
CREATE INDEX IF NOT EXISTS access_sync_item_todo ON access_sync_item(controller_id, todo, rank, ref);
CREATE INDEX IF NOT EXISTS access_sync_item_wanted ON access_sync_item(controller_id, kind, wanted_hash);
-- Journal des operations (200 dernieres par controleur, plus toutes celles de la derniere heure) : sert a la regle des suppressions en
-- masse. Ni cle, ni corps.
CREATE TABLE IF NOT EXISTS access_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  controller_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  op TEXT NOT NULL,
  result TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS access_sync_log_controller ON access_sync_log(controller_id, at);
CREATE INDEX IF NOT EXISTS access_sync_log_seq ON access_sync_log(controller_id, seq);
CREATE INDEX IF NOT EXISTS access_sync_log_deletes ON access_sync_log(controller_id, op, confirmed, at);
`);
  // Base creee avant l'ajout de op_dead (developpement) : la colonne est ajoutee, sans rien perdre.
  const cols = db.prepare('PRAGMA table_info(access_sync_controller)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'op_dead')) db.exec('ALTER TABLE access_sync_controller ADD COLUMN op_dead INTEGER NOT NULL DEFAULT 0');
}

// ---- Lignes ------------------------------------------------------------------------------------------------------------------

interface ItemRow {
  controller_id: string;
  kind: SyncItemKind;
  ref: string;
  wanted_hash: string | null;
  wanted_body: string | null;
  acked_hash: string | null;
  state: SyncState;
  attempts: number;
  code: string | null;
  message: string | null;
  since: number;
  held: number;
  confirmed: number;
  failed_hash: string | null;
  progress: number;
  rank: number;
  todo: number;
}

interface CtrlRow {
  controller_id: string;
  last_seq: number;
  last_ack_at: number | null;
  problem_code: string | null;
  problem_message: string | null;
  problem_at: number | null;
  ack_invalid_at: number | null;
  held_logged: number;
  op_id: string | null;
  op_seq: number | null;
  op_ts: number | null;
  op_body: string | null;
  op_kind: SyncItemKind | null;
  op_ref: string | null;
  op_op: 'upsert' | 'delete' | null;
  op_hash: string | null;
  op_chunk: number;
  op_last: number;
  op_attempts: number;
  op_sent_at: number | null;
  op_next_at: number | null;
  op_dead: number;
}

interface Wanted {
  kind: SyncItemKind;
  ref: string;
  hash: string;
  body: string;
}

export interface SyncOptions {
  db: DatabaseSync;
  /** Horloge injectee (tests). */
  now?: () => number;
  /** Cle de server/secrets.ts : scelle les cles de synchronisation. */
  key: Buffer;
  audit: (actor: string, action: string, ref?: { deviceId?: string; details?: string }) => void;
  rights: RightsSource;
  transport: SyncTransport;
  /** Hasard (cle de 32 octets, opId de 16 octets) ; deterministe en test. */
  randomBytes?: (n: number) => Buffer;
}

// ---- Fonctions pures ---------------------------------------------------------------------------------------------------------

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const hmacHex = (key: Buffer, text: string): string => createHmac('sha256', key).update(text, 'utf8').digest('hex');
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Attente avant le prochain essai, apres `attempts` envois : 10 s, 20 s, 40 s... plafonnee a 1 h. */
export function retryDelayMs(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts < 1) return BASE_RETRY_MS;
  return Math.min(BASE_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS);
}

/** Chaine canonique signee pour un ordre (docs/CONTROLE-ACCES.md § 7). */
export function orderString(controllerId: string, opId: string, seq: number, ts: number, body: string): string {
  return `psim-sync-v1|${controllerId}|${opId}|${seq}|${ts}|${sha256(body)}`;
}

/** Chaine canonique signee pour un accuse ; `code` absent s'ecrit vide. */
export function ackString(controllerId: string, opId: string, seq: number, result: string, code: string | null, ts: number): string {
  return `psim-sync-ack-v1|${controllerId}|${opId}|${seq}|${result}|${code ?? ''}|${ts}`;
}

/** Signature d'un ordre avec la cle (32 octets). */
export function signOrder(key: Buffer, controllerId: string, opId: string, seq: number, ts: number, body: string): string {
  return hmacHex(key, orderString(controllerId, opId, seq, ts, body));
}

/** Signature d'un accuse avec la cle (32 octets) ; sert a la fausse passerelle des essais et a la future passerelle. */
export function signAck(key: Buffer, controllerId: string, opId: string, seq: number, result: string, code: string | null, ts: number): string {
  return hmacHex(key, ackString(controllerId, opId, seq, result, code, ts));
}

function envelope(opId: string, seq: number, ts: number, body: string, sig: string): string {
  return JSON.stringify({ v: 1, opId, seq, ts, body, sig });
}

const clip = (s: string, n: number): string => [...s].slice(0, n).join('');

export function holderBody(h: DesiredHolder): string {
  return JSON.stringify({
    type: 'upsert_holder',
    holderRef: h.ref,
    name: clip(String(h.name), MAX_NAME),
    active: h.active === true,
    validFrom: h.validFrom ?? null,
    validTo: h.validTo ?? null,
    credentials: h.credentials.slice(0, 4).map(String),
    doors: h.doors.slice(0, 4).map((d) => ({ doorNo: d.doorNo, scheduleRef: d.scheduleRef })),
  });
}

export function scheduleBody(s: DesiredSchedule): string {
  return JSON.stringify({
    type: 'upsert_schedule',
    scheduleRef: s.ref,
    windows: s.windows.map((w) => ({ days: [...w.days], from: w.from, to: w.to })),
    holidays: s.holidays === true,
  });
}

const deleteBody = (kind: 'holder' | 'schedule', ref: string): string =>
  kind === 'holder' ? JSON.stringify({ type: 'delete_holder', holderRef: ref }) : JSON.stringify({ type: 'delete_schedule', scheduleRef: ref });

/** Rang d'envoi : jours feries, plages (creation), titulaires (creation), titulaires (suppression), plages (suppression). */
function rankOf(kind: SyncItemKind, wantedHash: string | null): number {
  if (kind === 'holidays') return 0;
  if (kind === 'schedule') return wantedHash !== null ? 1 : 4;
  return wantedHash !== null ? 2 : 3;
}

// ---- Service -------------------------------------------------------------------------------------------------------------------

export function createSync(opts: SyncOptions): SyncService {
  const { db, rights, transport, audit } = opts;
  const secretKey = opts.key;
  const now = opts.now ?? Date.now;
  const rand = opts.randomBytes ?? nodeRandomBytes;
  migrateSync(db);

  const statements = new Map<string, StatementSync>();
  function sql(text: string): StatementSync {
    let st = statements.get(text);
    if (!st) {
      if (statements.size >= 200) statements.clear();
      st = db.prepare(text);
      statements.set(text, st);
    }
    return st;
  }
  const one = <T>(text: string, ...params: (string | number | null)[]): T | undefined => sql(text).get(...params) as T | undefined;
  const all = <T>(text: string, ...params: (string | number | null)[]): T[] => sql(text).all(...params) as unknown as T[];
  const run = (text: string, ...params: (string | number | null)[]): void => {
    sql(text).run(...params);
  };

  /** Plusieurs ecritures en un seul commit, imbricable dans une transaction en cours. */
  function atomically<T>(fn: () => T): T {
    db.exec('SAVEPOINT access_sync_work');
    try {
      const result = fn();
      db.exec('RELEASE access_sync_work');
      return result;
    } catch (err) {
      db.exec('ROLLBACK TO access_sync_work');
      db.exec('RELEASE access_sync_work');
      throw err;
    }
  }

  /** Dernier etat connu du transport : vrai tant qu'aucun `publish` n'a echoue. */
  let transportReady = true;
  let subscribed = false;
  let lastPurgeCheck = 0;

  // ---- Controleurs et cles --------------------------------------------------------------------------------------------------

  function known(controllerId: unknown): controllerId is string {
    if (typeof controllerId !== 'string' || !ID_PATTERN.test(controllerId)) return false;
    try {
      return rights.controllerIds().includes(controllerId);
    } catch {
      return false;
    }
  }

  function requireKnown(controllerId: unknown): string {
    if (!known(controllerId)) throw new PsimError(404, 'Contrôleur introuvable');
    return controllerId;
  }

  function controllerName(controllerId: string): string {
    const r = one<{ name: string }>('SELECT name FROM access_controller WHERE id = ?', controllerId);
    return r?.name ?? controllerId;
  }

  function ensureCtrl(controllerId: string): CtrlRow {
    run('INSERT OR IGNORE INTO access_sync_controller (controller_id) VALUES (?)', controllerId);
    return one<CtrlRow>('SELECT * FROM access_sync_controller WHERE controller_id = ?', controllerId)!;
  }
  const ctrlRow = (controllerId: string): CtrlRow | undefined => one<CtrlRow>('SELECT * FROM access_sync_controller WHERE controller_id = ?', controllerId);

  const keyCache = new Map<string, { sealed: string; buf: Buffer }>();
  function hasKeyRow(controllerId: string): boolean {
    return one('SELECT 1 AS x FROM access_sync_key WHERE controller_id = ?', controllerId) !== undefined;
  }
  /** Les 32 octets de la cle, ou `null` (pas de cle, ou cle illisible). Le scelle est relu a chaque appel : une cle renouvelee par une autre instance est vue. */
  function keyFor(controllerId: string): Buffer | null {
    const r = one<{ sealed: string }>('SELECT sealed FROM access_sync_key WHERE controller_id = ?', controllerId);
    if (!r) return null;
    const cached = keyCache.get(controllerId);
    if (cached && cached.sealed === r.sealed) return cached.buf;
    try {
      const hex = unseal(secretKey, r.sealed);
      if (!/^[0-9a-f]{64}$/.test(hex)) return null;
      const buf = Buffer.from(hex, 'hex');
      keyCache.set(controllerId, { sealed: r.sealed, buf });
      return buf;
    } catch {
      return null;
    }
  }

  function purgeController(controllerId: string): void {
    atomically(() => {
      run('DELETE FROM access_sync_key WHERE controller_id = ?', controllerId);
      run('DELETE FROM access_sync_controller WHERE controller_id = ?', controllerId);
      run('DELETE FROM access_sync_item WHERE controller_id = ?', controllerId);
      run('DELETE FROM access_sync_log WHERE controller_id = ?', controllerId);
    });
    keyCache.delete(controllerId);
  }

  /** Retire les lignes des controleurs qui n'existent plus. */
  function purgeVanished(): void {
    let ids: Set<string>;
    try {
      ids = new Set(rights.controllerIds());
    } catch {
      return;
    }
    const seen = new Set<string>();
    for (const t of ['access_sync_key', 'access_sync_controller', 'access_sync_item', 'access_sync_log']) {
      for (const r of all<{ controller_id: string }>(`SELECT DISTINCT controller_id FROM ${t}`)) seen.add(r.controller_id);
    }
    for (const id of seen) if (!ids.has(id)) purgeController(id);
  }

  // ---- Etat des elements ---------------------------------------------------------------------------------------------------

  const markerOf = (row: ItemRow): string => row.wanted_hash ?? DELETE_MARK;
  const isInFlight = (ctrl: CtrlRow | undefined, row: ItemRow): boolean =>
    !!ctrl && ctrl.op_id !== null && ctrl.op_kind === row.kind && ctrl.op_ref === row.ref;

  /** Calcule `state` d'apres les autres champs (sans toucher aux compteurs sauf pour revenir a « synchronise »). */
  function derive(row: ItemRow, inflight: boolean): void {
    const needsOp = row.wanted_hash !== row.acked_hash;
    if (!needsOp && !inflight) {
      row.state = 'synced';
      row.attempts = 0;
      row.code = null;
      row.message = null;
      row.failed_hash = null;
      row.held = 0;
      row.progress = 0;
      return;
    }
    if (row.failed_hash !== null && row.failed_hash === markerOf(row)) {
      row.state = 'failed';
      return;
    }
    if (row.held === 1 && !inflight) {
      row.state = 'blocked';
      return;
    }
    if (inflight && row.state === 'failed') return; // sans accuse apres trop d'essais : reste en echec tant que l'operation est en vol
    row.state = 'pending';
  }

  function settle(row: ItemRow, inflight: boolean): void {
    const before = row.state;
    derive(row, inflight);
    if (row.state !== before) row.since = now();
  }

  function saveItem(row: ItemRow): void {
    run(
      `UPDATE access_sync_item SET wanted_hash = ?, wanted_body = ?, acked_hash = ?, state = ?, attempts = ?, code = ?, message = ?, since = ?,
         held = ?, confirmed = ?, failed_hash = ?, progress = ?, rank = ?, todo = ? WHERE controller_id = ? AND kind = ? AND ref = ?`,
      row.wanted_hash,
      row.wanted_body,
      row.acked_hash,
      row.state,
      row.attempts,
      row.code,
      row.message,
      row.since,
      row.held,
      row.confirmed,
      row.failed_hash,
      row.progress,
      rankOf(row.kind, row.wanted_hash),
      row.wanted_hash !== row.acked_hash && row.held === 0 && !(row.failed_hash !== null && row.failed_hash === markerOf(row)) ? 1 : 0,
      row.controller_id,
      row.kind,
      row.ref,
    );
  }
  function dropItem(row: ItemRow): void {
    run('DELETE FROM access_sync_item WHERE controller_id = ? AND kind = ? AND ref = ?', row.controller_id, row.kind, row.ref);
  }
  /** Ecrit la ligne, ou la supprime si plus rien n'est voulu ni present sur le controleur (et qu'aucune operation ne la concerne). */
  function persist(row: ItemRow, inflight: boolean): void {
    if (row.wanted_hash === null && row.acked_hash === null && !inflight) dropItem(row);
    else saveItem(row);
  }
  const getItem = (controllerId: string, kind: string, ref: string): ItemRow | undefined =>
    one<ItemRow>('SELECT * FROM access_sync_item WHERE controller_id = ? AND kind = ? AND ref = ?', controllerId, kind, ref);

  /** Le voulu d'un element change : nouveau contenu => en attente, essais a zero, echec oublie. */
  function applyWanted(row: ItemRow, hash: string | null, body: string | null, inflight: boolean): void {
    row.wanted_hash = hash;
    row.wanted_body = body;
    if (row.failed_hash !== null && row.failed_hash !== (hash ?? DELETE_MARK)) row.failed_hash = null;
    row.held = 0;
    row.confirmed = 0;
    row.progress = 0;
    if (!inflight && row.failed_hash === null) {
      row.attempts = 0;
      row.code = null;
      row.message = null;
    }
    settle(row, inflight);
  }

  // ---- Recalcul du voulu ---------------------------------------------------------------------------------------------------

  function wantedOf(desired: DesiredState): Map<string, Wanted> {
    const out = new Map<string, Wanted>();
    for (const s of desired.schedules) {
      const body = scheduleBody(s);
      out.set(`schedule|${s.ref}`, { kind: 'schedule', ref: s.ref, hash: sha256(body), body });
    }
    for (const h of desired.holders) {
      const body = holderBody(h);
      out.set(`holder|${h.ref}`, { kind: 'holder', ref: h.ref, hash: sha256(body), body });
    }
    const dates = [...new Set(desired.holidays.filter((d) => typeof d === 'string' && DATE_PATTERN.test(d)))].sort();
    if (dates.length > 0) {
      const body = JSON.stringify(dates);
      out.set('holidays|all', { kind: 'holidays', ref: 'all', hash: sha256(body), body });
    }
    return out;
  }

  function reconcile(controllerId: string): void {
    let wanted: Map<string, Wanted>;
    try {
      wanted = wantedOf(rights.desired(controllerId));
    } catch {
      return; // droits illisibles : on garde l'etat actuel, rien n'est supprime par erreur
    }
    atomically(() => {
      const ctrl = ctrlRow(controllerId);
      const rows = new Map<string, ItemRow>();
      for (const r of all<ItemRow>('SELECT * FROM access_sync_item WHERE controller_id = ?', controllerId)) rows.set(`${r.kind}|${r.ref}`, r);
      for (const [k, w] of wanted) {
        const row = rows.get(k);
        rows.delete(k);
        if (!row) {
          run(
            `INSERT INTO access_sync_item (controller_id, kind, ref, wanted_hash, wanted_body, acked_hash, state, since, rank, todo) VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?, ?, 1)`,
            controllerId,
            w.kind,
            w.ref,
            w.hash,
            w.body,
            now(),
            rankOf(w.kind, w.hash),
          );
          continue;
        }
        if (row.wanted_hash === w.hash) continue;
        const inflight = isInFlight(ctrl, row);
        applyWanted(row, w.hash, w.body, inflight);
        persist(row, inflight);
      }
      for (const row of rows.values()) {
        if (row.wanted_hash === null) continue; // deja une suppression en cours
        const inflight = isInFlight(ctrl, row);
        applyWanted(row, null, null, inflight);
        persist(row, inflight);
      }
    });
    refreshHold(controllerId);
  }

  // ---- Suppressions en masse -----------------------------------------------------------------------------------------------

  /** Suppressions de titulaires non confirmees, en attente d'envoi (l'operation en vol n'en fait pas partie : elle est deja au journal). */
  function unconfirmedDeletes(controllerId: string, ctrl: CtrlRow | undefined): ItemRow[] {
    return all<ItemRow>(
      `SELECT * FROM access_sync_item INDEXED BY access_sync_item_wanted WHERE controller_id = ? AND kind = 'holder' AND wanted_hash IS NULL AND acked_hash IS NOT NULL
         AND confirmed = 0 AND failed_hash IS NULL ORDER BY ref`,
      controllerId,
    ).filter((r) => !isInFlight(ctrl, r));
  }

  /**
   * Regle des 20 suppressions (docs/ACCES.md § 12.4) : en attente non confirmees + deja envoyees sans confirmation dans l'heure.
   * Au-dela, les suppressions en attente sont RETENUES (`blocked`) jusqu'a confirmation ; le blocage ne se leve pas tout seul.
   */
  function refreshHold(controllerId: string): void {
    const ctrl = ctrlRow(controllerId);
    const candidates = unconfirmedDeletes(controllerId, ctrl);
    const sentRecently = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM access_sync_log WHERE controller_id = ? AND kind = 'holder' AND op = 'delete' AND confirmed = 0 AND at > ?`,
      controllerId,
      now() - MASS_DELETE_WINDOW_MS,
    )!.n;
    const over = candidates.length + sentRecently > MASS_DELETE_LIMIT;
    const toHold = over ? candidates.filter((r) => r.held === 0) : [];
    const heldAfter = candidates.filter((r) => r.held === 1).length + toHold.length; // les retenues sont toutes parmi les candidates
    const resetFlag = heldAfter === 0 && ctrl !== undefined && ctrl.held_logged === 1;
    if (toHold.length === 0 && !resetFlag) return; // rien a changer (cas courant : aucune ecriture)
    atomically(() => {
      for (const r of toHold) {
        r.held = 1;
        r.state = 'blocked';
        r.since = now();
        saveItem(r);
      }
      if (resetFlag) run('UPDATE access_sync_controller SET held_logged = 0 WHERE controller_id = ?', controllerId);
      else if (toHold.length > 0 && !(ctrl && ctrl.held_logged === 1)) {
        ensureCtrl(controllerId);
        run('UPDATE access_sync_controller SET held_logged = 1 WHERE controller_id = ?', controllerId);
        audit('systeme', 'access_sync_deletions_held', { details: `${heldAfter} suppression(s) de titulaires retenue(s), en attente de confirmation` });
      }
    });
  }

  // ---- Envoi -----------------------------------------------------------------------------------------------------------------

  function logOp(controllerId: string, seq: number, kind: string, ref: string, op: string, confirmed: number): void {
    const t = now();
    run('INSERT INTO access_sync_log (controller_id, at, seq, kind, ref, op, result, confirmed) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)', controllerId, t, seq, kind, ref, op, confirmed);
    // Elagage : seulement s'il existe des lignes de plus d'une heure (sinon rien n'est a retirer, et le tri coute cher).
    const oldest = one<{ m: number | null }>('SELECT MIN(at) AS m FROM access_sync_log WHERE controller_id = ?', controllerId)!.m;
    if (oldest !== null && oldest <= t - MASS_DELETE_WINDOW_MS) {
      run(
        `DELETE FROM access_sync_log WHERE controller_id = ? AND at <= ?
           AND id NOT IN (SELECT id FROM access_sync_log WHERE controller_id = ? ORDER BY id DESC LIMIT ${LOG_KEEP})`,
        controllerId,
        t - MASS_DELETE_WINDOW_MS,
        controllerId,
      );
    }
  }

  /** Probleme visible sur le controleur (dernier refus ou absence d'accuse). */
  function setProblem(controllerId: string, code: string, message: string): void {
    ensureCtrl(controllerId);
    run('UPDATE access_sync_controller SET problem_code = ?, problem_message = ?, problem_at = ? WHERE controller_id = ?', code, message, now(), controllerId);
  }

  function failItem(row: ItemRow, code: string, message: string, definitive: boolean): void {
    const wasFailed = row.state === 'failed';
    row.state = 'failed';
    row.code = code;
    row.message = message;
    if (definitive) row.failed_hash = markerOf(row);
    if (!wasFailed) {
      row.since = now();
      audit('systeme', 'access_sync_failed', { details: `${row.kind === 'holder' ? 'titulaire' : row.kind === 'schedule' ? 'plage' : 'jours feries'} ${row.ref} : ${code}` });
    }
    setProblem(row.controller_id, code, message);
  }

  /** Construit l'operation d'un element : corps, empreinte, morceau. */
  function buildOp(item: ItemRow): { body: string; hash: string; op: 'upsert' | 'delete'; chunk: number; last: boolean } {
    const op: 'upsert' | 'delete' = item.wanted_hash === null ? 'delete' : 'upsert';
    const hash = item.wanted_hash ?? DELETE_MARK;
    if (item.kind === 'holidays') {
      const dates: string[] = item.wanted_body ? (JSON.parse(item.wanted_body) as string[]) : [];
      let chunk = item.progress;
      if (!Number.isInteger(chunk) || chunk < 0 || (dates.length > 0 && chunk * HOLIDAYS_PER_MESSAGE >= dates.length)) chunk = 0;
      const part = dates.slice(chunk * HOLIDAYS_PER_MESSAGE, (chunk + 1) * HOLIDAYS_PER_MESSAGE);
      const last = (chunk + 1) * HOLIDAYS_PER_MESSAGE >= dates.length;
      return { body: JSON.stringify({ type: 'set_holidays', dates: part, replace: chunk === 0 }), hash, op, chunk, last };
    }
    const body = op === 'upsert' ? item.wanted_body! : deleteBody(item.kind, item.ref);
    return { body, hash, op, chunk: 0, last: true };
  }

  /** Element suivant a envoyer, dans l'ordre du protocole. Les retenus, les refus definitifs et l'inutile en sont exclus. */
  function pickNext(controllerId: string): ItemRow | undefined {
    return one<ItemRow>(
      `SELECT * FROM access_sync_item WHERE controller_id = ? AND todo = 1 ORDER BY rank, ref LIMIT 1`,
      controllerId,
    );
  }

  /** Libere l'operation en vol (elle n'a plus lieu d'etre renvoyee). */
  function clearOp(controllerId: string): void {
    run(
      `UPDATE access_sync_controller SET op_id = NULL, op_seq = NULL, op_ts = NULL, op_body = NULL, op_kind = NULL, op_ref = NULL, op_op = NULL,
         op_hash = NULL, op_chunk = 0, op_last = 1, op_attempts = 0, op_sent_at = NULL, op_next_at = NULL, op_dead = 0 WHERE controller_id = ?`,
      controllerId,
    );
  }

  /** Une operation est a envoyer pour cet element : voulu different de l'accuse, ni retenu, ni refuse definitivement. */
  const needsSending = (row: ItemRow): boolean =>
    row.wanted_hash !== row.acked_hash && row.held === 0 && !(row.failed_hash !== null && row.failed_hash === markerOf(row));

  /** Plus aucun echec sur le controleur : le dernier incident est resolu. */
  function clearProblemIfResolved(controllerId: string): void {
    const ctrl = ctrlRow(controllerId);
    if (ctrl && ctrl.problem_code !== null && !one('SELECT 1 AS x FROM access_sync_item WHERE controller_id = ? AND state = ? LIMIT 1', controllerId, 'failed')) {
      run('UPDATE access_sync_controller SET problem_code = NULL, problem_message = NULL, problem_at = NULL WHERE controller_id = ?', controllerId);
    }
  }

  /**
   * Cree et PERSISTE l'operation (seq + 1) pour cet element. Faux si le message serait trop gros (message entier ou champ `body`) :
   * l'element passe en echec `invalid`, rien n'est publie et aucun seq n'est consomme.
   *
   * `replacing` : l'operation en vol vient d'etre accusee `error` (op_dead) ; la nouvelle la REMPLACE avec un nouveau seq et un nouvel
   * opId, reconstruite depuis l'etat courant de l'element. Le compteur d'essais de l'element est CONSERVE (l'attente croissante et
   * l'echec visible apres 5 essais continuent de compter) et le journal des operations garde sa ligne (mise a jour du seq) : une
   * suppression de titulaire reessayee ne compte qu'une fois pour la regle des 20 suppressions.
   */
  function createOp(controllerId: string, item: ItemRow, replacing?: CtrlRow): boolean {
    const ctrl = ensureCtrl(controllerId);
    const built = buildOp(item);
    const seq = ctrl.last_seq + 1;
    const ts = now();
    // Gabarit de meme taille que le vrai message (opId de 32 car., signature de 64 car.).
    const probe = envelope('0'.repeat(32), seq, ts, built.body, '0'.repeat(64));
    if (Buffer.byteLength(built.body, 'utf8') > MAX_BODY_BYTES || Buffer.byteLength(probe, 'utf8') > MAX_MESSAGE_BYTES) {
      atomically(() => {
        failItem(item, 'invalid', MSG_TOO_BIG, true);
        saveItem(item);
        if (replacing) clearOp(controllerId); // l'ancienne operation morte n'a plus d'objet
      });
      return false;
    }
    const opId = rand(16).toString('hex');
    atomically(() => {
      run(
        `UPDATE access_sync_controller SET last_seq = ?, op_id = ?, op_seq = ?, op_ts = ?, op_body = ?, op_kind = ?, op_ref = ?, op_op = ?, op_hash = ?,
           op_chunk = ?, op_last = ?, op_attempts = ?, op_sent_at = NULL, op_next_at = 0, op_dead = 0 WHERE controller_id = ?`,
        seq,
        opId,
        seq,
        ts,
        built.body,
        item.kind,
        item.ref,
        built.op,
        built.hash,
        built.chunk,
        built.last ? 1 : 0,
        replacing ? replacing.op_attempts : 0,
        controllerId,
      );
      if (!replacing && item.attempts !== 0) {
        item.attempts = 0;
        saveItem(item);
      }
      const sameLine = replacing && replacing.op_kind === item.kind && replacing.op_ref === item.ref && replacing.op_op === built.op;
      const moved = sameLine
        ? sql('UPDATE access_sync_log SET seq = ?, result = NULL WHERE controller_id = ? AND seq = ?').run(seq, controllerId, replacing!.op_seq!).changes
        : 0;
      if (!moved) logOp(controllerId, seq, item.kind, item.ref, built.op, item.confirmed);
    });
    return true;
  }

  /** Publie (ou republie) l'operation en vol, signee avec la cle du moment. Un publish faux n'est pas compte comme un essai. */
  function transmit(controllerId: string): void {
    const ctrl = ctrlRow(controllerId);
    if (!ctrl || ctrl.op_id === null || ctrl.op_dead === 1) return; // une operation morte n'est jamais renvoyee
    const key = keyFor(controllerId);
    if (!key) return;
    const opId = ctrl.op_id;
    const seq = ctrl.op_seq!;
    const ts = ctrl.op_ts!;
    const body = ctrl.op_body!;
    const message = envelope(opId, seq, ts, body, signOrder(key, controllerId, opId, seq, ts, body));
    const attempts = ctrl.op_attempts + 1;
    const t = now();
    // Compte l'essai AVANT de publier : un transport synchrone peut accuser a l'interieur de publish.
    atomically(() => {
      run('UPDATE access_sync_controller SET op_attempts = ?, op_sent_at = ?, op_next_at = ? WHERE controller_id = ? AND op_id = ?', attempts, t, t + retryDelayMs(attempts), controllerId, opId);
      run('UPDATE access_sync_item SET attempts = ? WHERE controller_id = ? AND kind = ? AND ref = ?', attempts, controllerId, ctrl.op_kind!, ctrl.op_ref!);
    });
    let ok = false;
    try {
      ok = transport.publish(controllerId, message) === true;
    } catch {
      ok = false;
    }
    transportReady = ok;
    if (!ok) {
      // Annule le compte si l'operation est toujours la meme (sinon un accuse l'a deja liberee) : on retentera au tick suivant.
      if (ctrlRow(controllerId)?.op_id === opId) {
        atomically(() => {
          run('UPDATE access_sync_controller SET op_attempts = ?, op_sent_at = ?, op_next_at = ? WHERE controller_id = ? AND op_id = ?', ctrl.op_attempts, ctrl.op_sent_at, ctrl.op_next_at, controllerId, opId);
          run('UPDATE access_sync_item SET attempts = ? WHERE controller_id = ? AND kind = ? AND ref = ?', ctrl.op_attempts, controllerId, ctrl.op_kind!, ctrl.op_ref!);
        });
      }
    }
  }

  /** L'echeance d'un essai est passee sans accuse apres plus de 5 essais : l'element est en echec `no_ack` (ou garde le code du dernier accuse `error`). */
  function markNoAck(controllerId: string, ctrl: CtrlRow): void {
    const item = getItem(controllerId, ctrl.op_kind!, ctrl.op_ref!);
    if (!item || item.state === 'failed') return;
    const code = item.code ?? 'no_ack';
    atomically(() => {
      failItem(item, code, messageForCode(code), false);
      saveItem(item);
    });
  }

  /**
   * L'echeance d'une operation MORTE (accusee `error`) est passee : elle est remplacee par une nouvelle (nouveau seq, nouvel opId),
   * reconstruite depuis l'etat courant de l'element, ou simplement liberee si l'element n'a plus rien a envoyer. Faux si aucune
   * nouvelle operation n'est en vol (liberee, ou message trop gros).
   */
  function replaceDeadOp(controllerId: string, ctrl: CtrlRow): boolean {
    if (ctrl.op_attempts >= FAIL_AFTER_ATTEMPTS) markNoAck(controllerId, ctrl); // 5 essais cumules sans succes : l'echec devient visible
    const item = getItem(controllerId, ctrl.op_kind!, ctrl.op_ref!);
    if (item && needsSending(item)) return createOp(controllerId, item, ctrl);
    atomically(() => {
      clearOp(controllerId);
      if (item) {
        settle(item, false);
        persist(item, false);
      }
      clearProblemIfResolved(controllerId);
    });
    return false;
  }

  /** Une etape pour un controleur : renvoi echu, remplacement d'une operation morte, ou creation et envoi de l'operation suivante. */
  function step(controllerId: string): void {
    if (!known(controllerId)) return;
    if (!keyFor(controllerId)) return;
    const ctrl = ctrlRow(controllerId);
    if (ctrl && ctrl.op_id !== null) {
      // Echeance pas atteinte (et plausible : une horloge ramenee en arriere ne doit pas figer l'envoi pendant des heures).
      const wait = (ctrl.op_next_at ?? 0) - now();
      if (wait > 0 && wait <= MAX_RETRY_MS) return;
      if (ctrl.op_dead !== 1) {
        if (ctrl.op_attempts >= FAIL_AFTER_ATTEMPTS) markNoAck(controllerId, ctrl);
        transmit(controllerId);
        return;
      }
      if (replaceDeadOp(controllerId, ctrl)) {
        transmit(controllerId);
        return;
      }
      // Operation morte liberee (plus rien a envoyer pour cet element) : on passe a la suivante.
    }
    refreshHold(controllerId);
    for (let i = 0; i < 1000; i++) {
      const item = pickNext(controllerId);
      if (!item) return;
      if (createOp(controllerId, item)) {
        transmit(controllerId);
        return;
      }
    }
  }

  // Un publish synchrone qui accuse dans la foulee rappelle `pump` : on met la demande en attente au lieu de recurser (pile).
  const pumping = new Set<string>();
  const rerun = new Set<string>();
  function pump(controllerId: string): void {
    if (pumping.has(controllerId)) {
      rerun.add(controllerId);
      return;
    }
    pumping.add(controllerId);
    try {
      let guard = 0;
      do {
        rerun.delete(controllerId);
        step(controllerId);
      } while (rerun.has(controllerId) && ++guard < MAX_STEPS);
    } finally {
      pumping.delete(controllerId);
      rerun.delete(controllerId);
    }
  }

  // ---- Accuses ----------------------------------------------------------------------------------------------------------------

  const bad = (reason: Extract<AckVerdict, { accepted: false }>['reason']): AckVerdict => ({ accepted: false, reason });

  function ack(controllerId: unknown, payload: unknown): AckVerdict {
    if (!known(controllerId)) return bad('unknown_controller');
    if (!hasKeyRow(controllerId)) return bad('no_key');
    const key = keyFor(controllerId);
    if (!key) return bad('no_key');

    let raw: string;
    if (typeof payload === 'string') {
      if (Buffer.byteLength(payload, 'utf8') > MAX_ACK_BYTES) return bad('format');
      raw = payload;
    } else if (Buffer.isBuffer(payload)) {
      if (payload.length > MAX_ACK_BYTES) return bad('format');
      raw = payload.toString('utf8');
    } else return bad('format');
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return bad('format');
    }
    if (!isPlainObject(msg)) return bad('format');
    const { v, opId, seq, result, code, ts, sig } = msg;
    if (v !== 1) return bad('format');
    if (typeof opId !== 'string' || !OPID_PATTERN.test(opId)) return bad('format');
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return bad('format');
    if (typeof result !== 'string' || !(ACK_RESULTS as readonly string[]).includes(result)) return bad('format');
    // Tout code de motif `^[a-z0-9_]{1,32}$` est accepte (la passerelle en renvoie plusieurs) ; pour `done` il est ignore, sans invalider l'accuse.
    if (code !== null && (typeof code !== 'string' || !CODE_PATTERN.test(code))) return bad('format');
    if (typeof ts !== 'number' || !Number.isSafeInteger(ts)) return bad('format');
    if (typeof sig !== 'string' || !SIG_PATTERN.test(sig)) return bad('format');

    const expected = Buffer.from(signAck(key, controllerId, opId, seq, result, code, ts), 'hex');
    const given = Buffer.from(sig, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      const ctrl = ensureCtrl(controllerId);
      if (ctrl.ack_invalid_at === null || now() - ctrl.ack_invalid_at >= ACK_INVALID_EVERY_MS) {
        run('UPDATE access_sync_controller SET ack_invalid_at = ? WHERE controller_id = ?', now(), controllerId);
        audit('systeme', 'access_sync_ack_invalid', { details: 'accusé de synchronisation à signature fausse ignoré' });
      }
      return bad('signature');
    }

    const ctrl = ctrlRow(controllerId);
    if (!ctrl || ctrl.op_id === null) return bad('no_operation');
    if (ctrl.op_id !== opId || ctrl.op_seq !== seq) return bad('mismatch');
    if (ctrl.op_dead === 1) return bad('mismatch'); // accuse en double ou tardif d'une operation deja morte : sans effet

    applyAck(controllerId, ctrl, result as AckResult, result === 'done' ? null : (code as string | null));
    if (result !== 'error') pump(controllerId);
    return { accepted: true };
  }

  /**
   * Phrase d'un refus definitif. Deux cas particuliers : une plage « fermee les jours feries » que le controleur ne sait pas appliquer,
   * et un titulaire refuse `invalid` parce qu'une plage de ses portes a elle-meme ete refusee (horaire inconnu du controleur).
   */
  function refusalMessage(controllerId: string, ctrl: CtrlRow, code: string): string {
    try {
      const body = JSON.parse(ctrl.op_body ?? 'null') as Record<string, unknown> | null;
      if (code === 'not_supported' && ctrl.op_kind === 'schedule' && ctrl.op_op === 'upsert' && body?.holidays === true) return MSG_HOLIDAYS_NOT_SUPPORTED;
      if (code === 'invalid' && ctrl.op_kind === 'holder' && ctrl.op_op === 'upsert' && Array.isArray(body?.doors)) {
        for (const d of body.doors as { scheduleRef?: unknown }[]) {
          const ref = d?.scheduleRef;
          if (typeof ref === 'string' && getItem(controllerId, 'schedule', ref)?.state === 'failed') return msgScheduleUnsent(ref);
        }
      }
    } catch {
      // corps illisible : phrase generique
    }
    return messageForCode(code);
  }

  /** L'accuse est authentique et concerne l'operation en vol : met a jour l'element, libere l'operation (sauf `error`). */
  function applyAck(controllerId: string, ctrl: CtrlRow, result: AckResult, code: string | null): void {
    atomically(() => {
      const item = getItem(controllerId, ctrl.op_kind!, ctrl.op_ref!);
      const t = now();
      run('UPDATE access_sync_controller SET last_ack_at = ? WHERE controller_id = ?', t, controllerId);
      run('UPDATE access_sync_log SET result = ? WHERE controller_id = ? AND seq = ?', result, controllerId, ctrl.op_seq!);

      if (result === 'error') {
        // La passerelle a consomme le seq et renverrait le MEME accuse : l'operation est morte. Elle reste en vol (l'element n'est ni
        // synchronise ni libere) jusqu'a l'echeance du prochain essai, meme attente que l'absence d'accuse, puis elle est remplacee.
        const c = code ?? 'io';
        run('UPDATE access_sync_controller SET op_dead = 1 WHERE controller_id = ? AND op_id = ?', controllerId, ctrl.op_id!);
        if (item) {
          item.code = c;
          item.message = messageForCode(c);
          saveItem(item);
        }
        setProblem(controllerId, c, messageForCode(c));
        return;
      }

      clearOp(controllerId);
      if (!item) return;
      const hash = ctrl.op_hash!;
      const sameContent = markerOf(item) === hash;

      if (result === 'done') {
        if (item.kind === 'holidays') {
          if (ctrl.op_op === 'delete' || !ctrl.op_last) {
            // Liste videe, ou morceau intermediaire : le controleur contient un melange, rien n'est « acquitte » avant le dernier morceau.
            item.acked_hash = null;
            item.progress = ctrl.op_op !== 'delete' && sameContent ? ctrl.op_chunk + 1 : 0;
          } else {
            item.acked_hash = hash;
            item.progress = 0;
          }
        } else {
          item.acked_hash = ctrl.op_op === 'delete' ? null : hash;
        }
        item.attempts = 0;
        item.code = null;
        item.message = null;
        if (item.failed_hash === hash) item.failed_hash = null;
        settle(item, false);
        persist(item, false);
        clearProblemIfResolved(controllerId);
        return;
      }

      // refused : definitif pour CE contenu (sauf si le voulu a change depuis l'envoi, auquel cas il n'y a rien a signaler).
      item.progress = 0;
      if (sameContent) {
        const c = code ?? 'invalid';
        failItem(item, c, refusalMessage(controllerId, ctrl, c), true);
      } else {
        item.attempts = 0;
        item.code = null;
        item.message = null;
        item.state = 'pending';
        settle(item, false);
      }
      persist(item, false);
    });
  }

  // ---- Vues --------------------------------------------------------------------------------------------------------------------

  function itemMessage(row: ItemRow, hasKey: boolean): string | null {
    switch (row.state) {
      case 'synced':
        return null;
      case 'blocked':
        return MSG_BLOCKED;
      case 'failed':
        return row.message ?? messageForCode(row.code);
      default:
        if (!hasKey) return MSG_NO_KEY;
        if (row.code !== null) return messageForCode(row.code); // dernier accuse `error` (io, unreachable, timeout, busy...) : nouvel essai automatique
        if (!transportReady) return MSG_NO_TRANSPORT;
        return row.attempts > 0
          ? `Envoyé ${row.attempts} fois, en attente de la réponse du contrôleur.`
          : "En attente d'envoi vers le contrôleur.";
    }
  }

  function itemView(row: ItemRow, hasKey: boolean): SyncItemView {
    return {
      kind: row.kind,
      ref: row.ref,
      op: row.wanted_hash === null ? 'delete' : 'upsert',
      state: row.state,
      attempts: row.attempts,
      code: row.code,
      message: itemMessage(row, hasKey),
      since: row.since,
    };
  }

  function statusOf(controllerId: string): SyncControllerStatus {
    const keyRow = one<{ created_at: number }>('SELECT created_at FROM access_sync_key WHERE controller_id = ?', controllerId);
    const enabled = keyRow !== undefined;
    const usable = enabled && keyFor(controllerId) !== null;
    const counts: Record<SyncState, number> = { synced: 0, pending: 0, failed: 0, blocked: 0 };
    for (const r of all<{ state: SyncState; n: number }>('SELECT state, COUNT(*) AS n FROM access_sync_item WHERE controller_id = ? GROUP BY state', controllerId)) {
      counts[r.state] = r.n;
    }
    const ctrl = ctrlRow(controllerId);
    const lastProblem =
      ctrl && ctrl.problem_code !== null ? { code: ctrl.problem_code, message: ctrl.problem_message ?? messageForCode(ctrl.problem_code), at: ctrl.problem_at ?? 0 } : null;
    const awaiting =
      counts.blocked > 0
        ? {
            count: counts.blocked,
            refs: all<{ ref: string }>(
              `SELECT ref FROM access_sync_item WHERE controller_id = ? AND state = 'blocked' ORDER BY ref LIMIT ${AWAITING_REFS_MAX}`,
              controllerId,
            ).map((r) => r.ref),
          }
        : null;

    let state: SyncControllerStatus['state'];
    let hint: string;
    if (!enabled) {
      state = 'disabled';
      hint = MSG_NO_KEY;
    } else if (!usable) {
      state = 'failed';
      hint = MSG_KEY_UNREADABLE;
    } else if (counts.blocked > 0) {
      state = 'blocked';
      hint = `${counts.blocked} suppression(s) de titulaires attendent la confirmation d'un administrateur. Vérifiez la liste puis confirmez, ou rétablissez les titulaires concernés.`;
    } else if (counts.failed > 0) {
      state = 'failed';
      hint = lastProblem?.message ?? "Certains changements n'ont pas pu être envoyés. Consultez la liste puis cliquez sur Réessayer.";
    } else if (counts.pending > 0) {
      state = 'pending';
      hint = transportReady ? `${counts.pending} changement(s) en cours d'envoi vers le contrôleur.` : MSG_NO_TRANSPORT;
    } else {
      state = 'ok';
      hint = counts.synced > 0 ? 'Le contrôleur est à jour.' : "Rien à envoyer : aucun titulaire n'a de droit sur ce contrôleur.";
    }
    return {
      controllerId,
      controllerName: controllerName(controllerId),
      enabled,
      keyCreatedAt: keyRow?.created_at ?? null,
      state,
      counts,
      lastAckAt: ctrl?.last_ack_at ?? null,
      lastProblem,
      awaitingConfirmation: awaiting,
      transportReady,
      hint,
    };
  }

  // ---- Service -----------------------------------------------------------------------------------------------------------------

  function notify(controllerIds?: string[]): void {
    try {
      let ids: string[];
      try {
        ids = rights.controllerIds();
      } catch {
        return;
      }
      if (controllerIds === undefined) {
        purgeVanished();
        for (const id of ids) reconcile(id);
        return;
      }
      for (const id of controllerIds) {
        if (typeof id !== 'string') continue;
        if (ids.includes(id)) reconcile(id);
        else if (ID_PATTERN.test(id)) purgeController(id); // controleur supprime
      }
    } catch {
      // ne leve jamais : le tick et le prochain notify rattraperont
    }
  }

  function tick(): void {
    try {
      const t = now();
      if (t - lastPurgeCheck >= PURGE_CHECK_EVERY_MS || t < lastPurgeCheck) {
        lastPurgeCheck = t;
        purgeVanished();
      }
      for (const r of all<{ controller_id: string }>('SELECT controller_id FROM access_sync_key ORDER BY controller_id')) {
        try {
          pump(r.controller_id);
        } catch {
          // un controleur en erreur n'empeche pas les autres
        }
      }
    } catch {
      // ne leve jamais
    }
  }

  function start(): void {
    try {
      if (!subscribed) {
        subscribed = true;
        rights.subscribe((ids) => notify(ids));
      }
      notify();
      // L'operation en vol (persistee) repart a la premiere occasion, sans remettre les essais a zero.
      run('UPDATE access_sync_controller SET op_next_at = 0 WHERE op_id IS NOT NULL');
      lastPurgeCheck = now();
    } catch {
      // ne leve jamais
    }
    tick();
  }

  function holderStatus(holderRef: string): HolderSyncView[] {
    if (typeof holderRef !== 'string') return [];
    const rows = all<ItemRow>("SELECT * FROM access_sync_item WHERE kind = 'holder' AND ref = ? ORDER BY controller_id", holderRef);
    return rows.map((r) => ({
      controllerId: r.controller_id,
      controllerName: controllerName(r.controller_id),
      state: r.state,
      message: itemMessage(r, hasKeyRow(r.controller_id)),
    }));
  }

  return {
    start,
    tick,
    notify,
    receiveAck(controllerId, payload): AckVerdict {
      try {
        return ack(controllerId, payload);
      } catch {
        return bad('format');
      }
    },

    status(): SyncControllerStatus[] {
      return rights.controllerIds().map(statusOf);
    },

    controller(controllerId): SyncControllerDetail {
      const id = requireKnown(controllerId);
      const hasKey = hasKeyRow(id);
      const items = all<ItemRow>(
        `SELECT * FROM access_sync_item WHERE controller_id = ? AND state <> 'synced'
           ORDER BY CASE state WHEN 'blocked' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END, rank, ref LIMIT ${DETAIL_ITEMS_MAX}`,
        id,
      );
      return { ...statusOf(id), items: items.map((r) => itemView(r, hasKey)) };
    },

    holderStatus,

    issueKey(actor, controllerId) {
      const id = requireKnown(controllerId);
      const bytes = rand(32);
      if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw new Error('Generateur aleatoire invalide');
      const hex = bytes.toString('hex');
      const sealed = seal(secretKey, hex);
      const t = now();
      const renewed = hasKeyRow(id);
      atomically(() => {
        run(
          `INSERT INTO access_sync_key (controller_id, sealed, created_at, created_by) VALUES (?, ?, ?, ?)
             ON CONFLICT(controller_id) DO UPDATE SET sealed = excluded.sealed, created_at = excluded.created_at, created_by = excluded.created_by`,
          id,
          sealed,
          t,
          String(actor),
        );
        ensureCtrl(id);
        audit(actor, 'access_sync_key_issued', { details: renewed ? 'cle renouvelee' : 'cle creee' });
      });
      keyCache.delete(id);
      reconcile(id); // une synchronisation qui vient d'etre activee connait tout de suite ce qu'elle doit envoyer
      return { key: hex, createdAt: t, renewed };
    },

    confirmDeletions(actor, controllerId) {
      const id = requireKnown(controllerId);
      const held = all<ItemRow>(`SELECT * FROM access_sync_item WHERE controller_id = ? AND kind = 'holder' AND held = 1 ORDER BY ref`, id);
      if (held.length === 0) return { confirmed: 0 };
      atomically(() => {
        for (const r of held) {
          r.held = 0;
          r.confirmed = 1;
          r.state = 'pending';
          r.since = now();
          saveItem(r);
        }
        run('UPDATE access_sync_controller SET held_logged = 0 WHERE controller_id = ?', id);
        const refs = held.slice(0, AWAITING_REFS_MAX).map((r) => r.ref).join(', ');
        audit(actor, 'access_sync_deletions_confirmed', { details: `${held.length} suppression(s) confirmee(s) : ${refs}${held.length > AWAITING_REFS_MAX ? ', ...' : ''}` });
      });
      pump(id);
      return { confirmed: held.length };
    },

    retry(actor, controllerId) {
      const id = requireKnown(controllerId);
      const failed = all<ItemRow>(`SELECT * FROM access_sync_item WHERE controller_id = ? AND state = 'failed'`, id);
      if (failed.length === 0) return { requeued: 0 };
      atomically(() => {
        const ctrl = ctrlRow(id);
        for (const r of failed) {
          const inflight = isInFlight(ctrl, r);
          r.failed_hash = null;
          r.attempts = 0;
          r.code = null;
          r.message = null;
          r.state = 'pending';
          r.since = now();
          saveItem(r);
          if (inflight) run('UPDATE access_sync_controller SET op_attempts = 0, op_next_at = 0 WHERE controller_id = ?', id);
        }
        run('UPDATE access_sync_controller SET problem_code = NULL, problem_message = NULL, problem_at = NULL WHERE controller_id = ?', id);
        audit(actor, 'access_sync_retry', { details: `${failed.length} element(s) remis en file` });
      });
      pump(id);
      return { requeued: failed.length };
    },
  };
}
