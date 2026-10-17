/**
 * Titulaires de badges (lot AC5, phase 2) : titulaires, badges, groupes, plages horaires, jours feries, visiteurs et calcul des
 * droits. Contrats : docs/ACCES.md § 10, docs/CONTROLE-ACCES.md § 1 et § 7, types figes dans accessholderstypes.ts.
 *
 * Principe : le PSIM est la REFERENCE des titulaires ; `desired(controllerId)` dit ce que chaque controleur doit contenir et la
 * synchronisation (accesssync.ts) le pousse. Le controleur decide seul d'ouvrir : rien ici ne commande une porte.
 *
 * Donnees personnelles : noms, matricules, numeros de badge, photo. Ni code PIN ni gabarit biometrique ne passe jamais ici. Le
 * journal infalsifiable ne recoit que des IDENTIFIANTS (`H12`, `B5`, `G3`, `S2`), jamais un nom, un numero de badge ni la photo
 * (il ne s'efface pas) ; seule exception voulue : le texte d'une recherche nominative, journalise pour savoir qui cherche qui.
 *
 * Ecritures : chacune est atomique (savepoint). `batch` regroupe plusieurs ecritures en une transaction et une notification ;
 * `simulate` les execute puis les ANNULE (import « a blanc ») sans rien notifier.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { holderKey, migrateAccess, resultLabel } from './access.ts';
import { parseSchedule } from './arming.ts';
import type { Window } from './arming.ts';
import { PsimError } from './errors.ts';
import { hasForbiddenChar, normalizeName } from './text.ts';
import { BADGE_STATES, HOLDER_STATUSES } from './accessholderstypes.ts';
import type {
  BadgeState, BadgeView, DesiredHolder, DesiredSchedule, DesiredState, GroupDoorView, GroupInput, GroupView, HolderDetail, HolderFilters,
  HolderInput, HolderKind, HolderList, HolderPhase, HolderStatus, HolderView, HoldersService, HolidayView, MutationOptions, PassageBrief,
  RightsListener, ScheduleInput, ScheduleView, VisitorInput, VisitorView,
} from './accessholderstypes.ts';

// ---- Limites ---------------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
export const MAX_HOLDERS = 20_000;
export const MAX_GROUPS = 200;
export const MAX_SCHEDULES = 100;
export const MAX_HOLIDAYS = 400;
const MAX_LAST_NAME = 40;
const MAX_FIRST_NAME = 40;
/** « NOM Prenom » : 63 caracteres au plus (le nom envoye aux controleurs en garde 64). */
const MAX_DISPLAY_NAME = 63;
const MAX_SENT_NAME = 64;
const MAX_ACTIVE_BADGES = 4;
const MAX_BADGE_ROWS = 12;
const MAX_GROUPS_PER_HOLDER = 20;
const MAX_DOORS_PER_GROUP = 200;
const MAX_WINDOWS = 8;
const MAX_GROUP_NAME = 60;
const MAX_DESCRIPTION = 200;
const MAX_LABEL = 60;
const MAX_HOST = 64;
const MAX_REASON = 120;
const MAX_QUERY = 64;
const MAX_QUERY_WORDS = 6;
const PHOTO_MAX_BYTES = 64 * 1024;
const FUTURE_LIMIT_MS = Math.round(20 * 365.25 * DAY_MS);
const VISITOR_MIN_MINUTES = 15;
const VISITOR_MAX_MINUTES = 44_640;
const HOLIDAY_FIRST_YEAR = 2020;
const HOLIDAY_LAST_YEAR = 2100;
export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 100;
export const LIST_TOTAL_CAP = 10_000;
const TICK_MIN_INTERVAL_MS = 5_000;
const TICK_BATCH = 200;
const SEARCH_LOG_EVERY_MS = 60_000;
const AUDIT_DETAILS_MAX = 120;
const RECENT_VISITORS_MS = DAY_MS;
const VISITORS_MAX = 500;
export const DEFAULT_RETENTION_DAYS = 90;

export const BUILTIN_SCHEDULE_NAME = 'Tout le temps';

const MATRICULE_PATTERN = /^[A-Za-z0-9._/-]{1,32}$/;
const BADGE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const DOOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const HOLDER_REF_PATTERN = /^H([1-9][0-9]{0,14})$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const LEADING_DANGER = /^[=+\-@]/;
const ANGLE_BRACKET = /[<>]/;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const STATE_LABEL: Readonly<Record<BadgeState, string>> = { active: 'Actif', disabled: 'Désactivé', lost: 'Perdu', returned: 'Rendu' };

// ---- Schema ----------------------------------------------------------------------------------------------------------------

/**
 * Migration : `CREATE TABLE / INDEX IF NOT EXISTS` seulement. Appelle `migrateAccess` (idempotente) car les droits s'appuient sur
 * `access_door` et la recherche des passages sur `access_event`. Pas de cle etrangere vers `device` : une porte retiree laisse son
 * droit sans effet, il n'est pas supprime en silence.
 */
export function migrateHolders(db: DatabaseSync): void {
  migrateAccess(db);
  db.exec(`
CREATE TABLE IF NOT EXISTS access_holder (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  last_name TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  -- Recherche : « nom prenom » en minuscules, sans accents (holderKey de access.ts).
  name_key TEXT NOT NULL,
  external_ref TEXT,
  kind TEXT NOT NULL DEFAULT 'staff' CHECK (kind IN ('staff', 'visitor')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  valid_from INTEGER,
  valid_to INTEGER,
  visitor_host TEXT,
  visitor_reason TEXT,
  ended_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS access_holder_by_external_ref ON access_holder(external_ref COLLATE NOCASE) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS access_holder_by_kind ON access_holder(kind, id);
CREATE INDEX IF NOT EXISTS access_holder_by_name ON access_holder(name_key);
CREATE TABLE IF NOT EXISTS access_holder_photo (
  holder_id INTEGER PRIMARY KEY REFERENCES access_holder(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BLOB NOT NULL
);
-- Le numero ne distingue pas majuscules et minuscules (un numero hexadecimal se lit des deux manieres).
CREATE TABLE IF NOT EXISTS access_badge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holder_id INTEGER NOT NULL REFERENCES access_holder(id) ON DELETE CASCADE,
  number TEXT NOT NULL COLLATE NOCASE,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled', 'lost', 'returned')),
  state_at INTEGER NOT NULL,
  state_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- Un numero est unique tant que le badge n'est pas rendu : une carte visiteur rendue peut etre redonnee, une carte perdue reste reservee.
CREATE UNIQUE INDEX IF NOT EXISTS access_badge_by_number ON access_badge(number) WHERE state <> 'returned';
CREATE INDEX IF NOT EXISTS access_badge_by_holder ON access_badge(holder_id);
CREATE TABLE IF NOT EXISTS access_group (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  for_visitors INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS access_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  windows TEXT NOT NULL,
  closed_on_holidays INTEGER NOT NULL DEFAULT 0,
  builtin INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS access_group_door (
  group_id INTEGER NOT NULL REFERENCES access_group(id) ON DELETE CASCADE,
  door_id TEXT NOT NULL,
  schedule_id INTEGER NOT NULL REFERENCES access_schedule(id),
  PRIMARY KEY (group_id, door_id)
);
CREATE INDEX IF NOT EXISTS access_group_door_by_door ON access_group_door(door_id);
CREATE INDEX IF NOT EXISTS access_group_door_by_schedule ON access_group_door(schedule_id);
CREATE TABLE IF NOT EXISTS access_holder_group (
  holder_id INTEGER NOT NULL REFERENCES access_holder(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES access_group(id) ON DELETE CASCADE,
  PRIMARY KEY (holder_id, group_id)
);
CREATE INDEX IF NOT EXISTS access_holder_group_by_group ON access_holder_group(group_id);
CREATE TABLE IF NOT EXISTS access_holiday (
  date TEXT PRIMARY KEY,
  label TEXT
);
-- Passages d'un titulaire (fiche, visiteurs) : index PARTIEL, seules les lignes rattachees sont indexees (cout d'ecriture negligeable).
CREATE INDEX IF NOT EXISTS access_event_by_holder ON access_event(holder_id, at_device) WHERE holder_id IS NOT NULL;
`);
}

// ---- Utilitaires -----------------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Param = string | number | null | Uint8Array;

const bad = (message: string): PsimError => new PsimError(400, message);
const hasLoneSurrogate = (s: string): boolean => /\p{Cs}/u.test(s);
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Propriete PROPRE seulement : jamais celle d'un prototype (`__proto__`, `constructor`...). `undefined` si absente. */
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);
const uniqueSorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();
const isUniqueError = (err: unknown): boolean => err instanceof Error && /UNIQUE constraint/i.test(err.message);

/** Texte limite a `max` caracteres (points de code : jamais une paire de substitution coupee en deux). */
function clip(text: string, max = AUDIT_DETAILS_MAX): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

function asObject(input: unknown, what = 'La requête'): Record<string, unknown> {
  if (!isPlainObject(input)) throw bad(`${what} est invalide : un objet est attendu.`);
  return input;
}

/** Entier strictement positif (identifiant). */
function positiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw bad(`${label} doit être un nombre entier positif.`);
  return value;
}

/**
 * Texte saisi : type, longueur (bornee AVANT tout autre controle), caracteres de controle ou invisibles, forme NFC. Un texte qui
 * commence par `=`, `+`, `-` ou `@` (formule de tableur) ou contient `<` ou `>` (balise) est refuse : il finit dans des exports.
 */
function cleanText(value: unknown, label: string, max: number, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) throw bad(`${label} est obligatoire.`);
    return '';
  }
  if (typeof value !== 'string') throw bad(`${label} doit être un texte.`);
  if (value.length > max * 4 + 8) throw bad(`${label} est trop long (${max} caractères au plus).`);
  if (hasLoneSurrogate(value) || hasForbiddenChar(value)) throw bad(`${label} contient un caractère interdit (caractère de contrôle ou invisible).`);
  const text = normalizeName(value);
  if (text === '') {
    if (required) throw bad(`${label} est obligatoire.`);
    return '';
  }
  if ([...text].length > max) throw bad(`${label} est trop long (${max} caractères au plus).`);
  if (LEADING_DANGER.test(text)) throw bad(`${label} ne peut pas commencer par =, +, - ou @.`);
  if (ANGLE_BRACKET.test(text)) throw bad(`${label} ne peut pas contenir < ou >.`);
  return text;
}

function cleanNames(lastName: unknown, firstName: unknown): { lastName: string; firstName: string } {
  const last = cleanText(lastName, 'Le nom', MAX_LAST_NAME, true);
  const first = cleanText(firstName, 'Le prénom', MAX_FIRST_NAME, false);
  const length = [...displayOf(last, first)].length;
  if (length > MAX_DISPLAY_NAME) throw bad(`Le nom et le prénom ensemble ne peuvent pas dépasser ${MAX_DISPLAY_NAME} caractères (ici ${length}).`);
  return { lastName: last, firstName: first };
}

const displayOf = (last: string, first: string): string => (first === '' ? last : `${last} ${first}`);
const keyOf = (last: string, first: string): string => holderKey(displayOf(last, first));

function cleanMatricule(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw bad('Le matricule doit être un texte.');
  if (value.length > 64) throw bad('Le matricule est trop long (32 caractères au plus).');
  const text = value.trim();
  if (text === '') return null;
  if (!MATRICULE_PATTERN.test(text)) throw bad('Le matricule est invalide : 1 à 32 caractères, lettres, chiffres, . _ / et - seulement.');
  return text;
}

function cleanBadgeNumber(value: unknown): string {
  if (typeof value !== 'string') throw bad('Le numéro de badge doit être un texte (les zéros du début comptent).');
  if (value.length > 64) throw bad('Le numéro de badge est trop long (32 caractères au plus).');
  const text = value.trim();
  if (!BADGE_PATTERN.test(text)) throw bad('Le numéro de badge est invalide : 1 à 32 caractères, lettres, chiffres, - et _ seulement.');
  return text;
}

function cleanStatus(value: unknown): HolderStatus {
  if (typeof value !== 'string' || !(HOLDER_STATUSES as readonly string[]).includes(value)) throw bad('Le statut doit être « active » ou « suspended ».');
  return value as HolderStatus;
}

function cleanBadgeState(value: unknown): BadgeState {
  if (typeof value !== 'string' || !(BADGE_STATES as readonly string[]).includes(value)) throw bad(`L'état du badge doit être l'un de : ${BADGE_STATES.join(', ')}.`);
  return value as BadgeState;
}

/** Instant en millisecondes (entier), ou `null`. */
function cleanInstant(value: unknown, label: string, now: number): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw bad(`${label} doit être un instant en millisecondes (nombre entier).`);
  if (value > now + FUTURE_LIMIT_MS) throw bad(`${label} ne peut pas dépasser 20 ans dans le futur.`);
  return value;
}

/** Valide le texte libre d'une phrase (groupe, plage, jour ferie) : meme regles que les noms, jamais obligatoire sauf demande. */
const cleanLabel = (value: unknown, label: string, max: number, required: boolean): string => cleanText(value, label, max, required);

function cleanBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw bad(`${label} doit valoir vrai ou faux.`);
  return value;
}

/** Signature d'un fichier image (octets magiques) : le type annonce par l'appelant ne suffit jamais. */
function imageMimeOf(data: Uint8Array): (typeof PHOTO_TYPES)[number] | null {
  const at = (i: number): number => data[i] ?? -1;
  if (data.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (data.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b)) return 'image/png';
  if (data.length >= 12 && [0x52, 0x49, 0x46, 0x46].every((b, i) => at(i) === b) && [0x57, 0x45, 0x42, 0x50].every((b, i) => at(8 + i) === b)) return 'image/webp';
  return null;
}

/** Date calendaire reelle `AAAA-MM-JJ` (le 30 fevrier est refuse), de 2020 a 2100. */
function cleanDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 20) throw bad(`${label} doit être une date AAAA-MM-JJ.`);
  const m = DATE_PATTERN.exec(value);
  if (!m) throw bad(`${label} doit être une date AAAA-MM-JJ.`);
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const real = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== day) {
    throw bad(`${label} n'existe pas au calendrier (${value}).`);
  }
  if (year < HOLIDAY_FIRST_YEAR || year > HOLIDAY_LAST_YEAR) throw bad(`${label} doit être entre ${HOLIDAY_FIRST_YEAR} et ${HOLIDAY_LAST_YEAR}.`);
  return value;
}

// ---- Lignes ----------------------------------------------------------------------------------------------------------------

interface HolderRow {
  id: number;
  last_name: string;
  first_name: string;
  name_key: string;
  external_ref: string | null;
  kind: HolderKind;
  status: HolderStatus;
  valid_from: number | null;
  valid_to: number | null;
  visitor_host: string | null;
  visitor_reason: string | null;
  ended_at: number | null;
  created_at: number;
  created_by: string;
  updated_at: number;
  updated_by: string;
  has_photo: number;
}

interface BadgeRow {
  id: number;
  holder_id: number;
  number: string;
  state: BadgeState;
  state_at: number;
  state_by: string;
  created_at: number;
}

interface GroupRow {
  id: number;
  name: string;
  description: string;
  for_visitors: number;
  created_at: number;
  created_by: string;
  updated_at: number;
  updated_by: string;
}

interface ScheduleRow {
  id: number;
  name: string;
  windows: string;
  closed_on_holidays: number;
  builtin: number;
}

/** Colonnes d'un titulaire SANS la photo (jamais lue hors de `photo()`). */
const HOLDER_COLS =
  'h.id, h.last_name, h.first_name, h.name_key, h.external_ref, h.kind, h.status, h.valid_from, h.valid_to, h.visitor_host, h.visitor_reason, h.ended_at, ' +
  'h.created_at, h.created_by, h.updated_at, h.updated_by, EXISTS (SELECT 1 FROM access_holder_photo p WHERE p.holder_id = h.id) AS has_photo';

export interface HoldersOptions {
  db: DatabaseSync;
  /** Horloge injectee (tests). */
  now?: () => number;
  audit: (actor: string, action: string, ref?: { deviceId?: string; details?: string }) => void;
  /** Duree de conservation des fiches de visiteurs terminees (jours) ; 90 si absente ou invalide. */
  retentionDays?: () => number;
}

export function createHolders(opts: HoldersOptions): HoldersService {
  const { db, audit } = opts;
  const now = opts.now ?? Date.now;
  migrateHolders(db);

  // Requetes preparees gardees (resolve est appele a chaque passage) ; les formes dynamiques de la recherche sont bornees.
  const statements = new Map<string, StatementSync>();
  function sql(text: string): StatementSync {
    let st = statements.get(text);
    if (!st) {
      if (statements.size >= 300) statements.clear();
      st = db.prepare(text);
      statements.set(text, st);
    }
    return st;
  }
  const all = (text: string, ...params: Param[]): Row[] => sql(text).all(...params) as Row[];
  const one = (text: string, ...params: Param[]): Row | undefined => sql(text).get(...params) as Row | undefined;
  const run = (text: string, ...params: Param[]): { changes: number; id: number } => {
    const r = sql(text).run(...params);
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  };

  /** Plusieurs ecritures en un seul commit, imbricable dans une transaction en cours. */
  function atomically<T>(fn: () => T): T {
    db.exec('SAVEPOINT holders_work');
    try {
      const result = fn();
      db.exec('RELEASE holders_work');
      return result;
    } catch (err) {
      db.exec('ROLLBACK TO holders_work');
      db.exec('RELEASE holders_work');
      throw err;
    }
  }

  // Plage « Tout le temps » : creee a la premiere ouverture, ni modifiable ni supprimable.
  if (!one('SELECT 1 AS x FROM access_schedule WHERE builtin = 1')) {
    const allDays = [0, 1, 2, 3, 4, 5, 6];
    const windows: Window[] = [{ days: allDays, from: '00:00', to: '12:00' }, { days: allDays, from: '12:00', to: '00:00' }];
    run('INSERT OR IGNORE INTO access_schedule (name, name_key, windows, closed_on_holidays, builtin) VALUES (?, ?, ?, 0, 1)', BUILTIN_SCHEDULE_NAME, holderKey(BUILTIN_SCHEDULE_NAME), JSON.stringify(windows));
  }

  const log = (actor: string, action: string, details: string): void => audit(actor, action, { details: clip(details) });

  // ---- Notifications ---------------------------------------------------------------------------------------------------------

  const listeners: RightsListener[] = [];
  /** > 0 pendant un `batch` ou un `simulate` : les notifications attendent la fin de l'operation. */
  let depth = 0;
  let pending = new Set<string>();

  function fire(ids: string[]): void {
    if (ids.length === 0) return;
    const sorted = uniqueSorted(ids);
    for (const listener of [...listeners]) {
      try {
        listener([...sorted]);
      } catch (err) {
        console.error('[accessholders] ecouteur :', err);
      }
    }
  }

  function notify(ids: Iterable<string>): void {
    if (depth > 0) {
      for (const id of ids) pending.add(id);
      return;
    }
    fire([...ids]);
  }

  /** Ecriture atomique ; les controleurs touches ne sont notifies qu'apres le commit (jamais si elle echoue). */
  function write<T>(fn: () => { value: T; touched?: Iterable<string> }): T {
    let out: { value: T; touched?: Iterable<string> };
    try {
      out = atomically(fn);
    } catch (err) {
      if (isUniqueError(err)) throw new PsimError(409, 'Cette valeur existe déjà (doublon).');
      throw err;
    }
    if (out.touched) notify(out.touched);
    return out.value;
  }

  function batch<T>(fn: () => T): T {
    const saved = new Set(pending);
    depth++;
    let result: T;
    try {
      result = atomically(fn);
    } catch (err) {
      depth--;
      pending = saved;
      throw err;
    }
    depth--;
    if (depth === 0) {
      const ids = [...pending];
      pending = new Set();
      fire(ids);
    }
    return result;
  }

  function simulate<T>(fn: () => T): T {
    const saved = pending;
    pending = new Set(saved);
    depth++;
    db.exec('SAVEPOINT holders_simulation');
    try {
      return fn();
    } finally {
      try {
        db.exec('ROLLBACK TO holders_simulation');
        db.exec('RELEASE holders_simulation');
      } finally {
        depth--;
        pending = saved;
      }
    }
  }

  // ---- Controleurs concernes par un changement ---------------------------------------------------------------------------------

  const controllersOfHolder = (holderId: number): string[] =>
    all(
      `SELECT DISTINCT ad.controller_id AS c FROM access_holder_group hg
         JOIN access_group_door gd ON gd.group_id = hg.group_id
         JOIN access_door ad ON ad.detector_id = gd.door_id
        WHERE hg.holder_id = ?`,
      holderId,
    ).map((r) => r.c as string);

  /** Controleurs des portes d'un groupe, seulement si le groupe a des titulaires (sinon rien ne change pour eux). */
  const controllersOfGroup = (groupId: number): string[] =>
    all(
      `SELECT DISTINCT ad.controller_id AS c FROM access_group_door gd
         JOIN access_door ad ON ad.detector_id = gd.door_id
        WHERE gd.group_id = ? AND EXISTS (SELECT 1 FROM access_holder_group hg WHERE hg.group_id = gd.group_id)`,
      groupId,
    ).map((r) => r.c as string);

  const controllersOfSchedule = (scheduleId: number): string[] =>
    all(
      `SELECT DISTINCT ad.controller_id AS c FROM access_group_door gd
         JOIN access_door ad ON ad.detector_id = gd.door_id
        WHERE gd.schedule_id = ? AND EXISTS (SELECT 1 FROM access_holder_group hg WHERE hg.group_id = gd.group_id)`,
      scheduleId,
    ).map((r) => r.c as string);

  const allControllerIds = (): string[] => all('SELECT id FROM access_controller ORDER BY id').map((r) => r.id as string);

  // ---- Vues ------------------------------------------------------------------------------------------------------------------

  function phaseOf(r: HolderRow, t: number): HolderPhase {
    if (r.kind === 'visitor' && r.ended_at !== null) return 'expired';
    if (r.valid_to !== null && r.valid_to <= t) return 'expired';
    if (r.valid_from !== null && r.valid_from > t) return 'upcoming';
    return 'valid';
  }

  const badgeView = (b: BadgeRow): BadgeView => ({
    id: b.id,
    number: b.number,
    state: b.state,
    stateLabel: STATE_LABEL[b.state],
    stateAt: b.state_at,
    stateBy: b.state_by,
    createdAt: b.created_at,
  });

  /** Vues de plusieurs titulaires : deux requetes (badges, groupes) pour tout le lot, jamais une par titulaire. */
  function viewsOf(rows: HolderRow[]): HolderView[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const where = ids.length === 1 ? '= ?' : `IN (${placeholders(ids.length)})`;
    const badges = new Map<number, BadgeView[]>();
    for (const b of all(`SELECT id, holder_id, number, state, state_at, state_by, created_at FROM access_badge WHERE holder_id ${where} ORDER BY id`, ...ids) as unknown as BadgeRow[]) {
      const list = badges.get(b.holder_id) ?? [];
      list.push(badgeView(b));
      badges.set(b.holder_id, list);
    }
    const groups = new Map<number, { id: number; name: string }[]>();
    for (const g of all(
      `SELECT hg.holder_id, g.id, g.name FROM access_holder_group hg JOIN access_group g ON g.id = hg.group_id WHERE hg.holder_id ${where} ORDER BY g.name_key, g.id`,
      ...ids,
    )) {
      const list = groups.get(g.holder_id as number) ?? [];
      list.push({ id: g.id as number, name: g.name as string });
      groups.set(g.holder_id as number, list);
    }
    const t = now();
    return rows.map((r) => ({
      id: r.id,
      ref: `H${r.id}`,
      lastName: r.last_name,
      firstName: r.first_name,
      displayName: displayOf(r.last_name, r.first_name),
      externalRef: r.external_ref,
      kind: r.kind,
      status: r.status,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      phase: phaseOf(r, t),
      hasPhoto: r.has_photo === 1,
      badges: badges.get(r.id) ?? [],
      groups: groups.get(r.id) ?? [],
      visitor: r.kind === 'visitor' ? { host: r.visitor_host ?? '', reason: r.visitor_reason ?? '', endedAt: r.ended_at } : null,
      createdAt: r.created_at,
      createdBy: r.created_by,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    }));
  }

  const holderRow = (id: number): HolderRow | undefined => one(`SELECT ${HOLDER_COLS} FROM access_holder h WHERE h.id = ?`, id) as unknown as HolderRow | undefined;

  /** Identifiant venu d'une URL ou d'un corps : entier positif, sinon 404 sans interroger la base. */
  function holderIdOf(id: unknown): number {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new PsimError(404, 'Titulaire introuvable');
    return id;
  }

  function mustHolder(id: unknown): HolderRow {
    const r = holderRow(holderIdOf(id));
    if (!r) throw new PsimError(404, 'Titulaire introuvable');
    return r;
  }

  const viewOf = (id: number): HolderView => viewsOf([mustHolder(id)])[0] as HolderView;

  // ---- Passages d'un titulaire -------------------------------------------------------------------------------------------------

  const PASSAGE_COLS = 'e.id, e.door_id, e.at_device, e.result, e.reason, e.method, e.credential, d.name AS door_name';

  function passageBrief(r: Row): PassageBrief {
    const reason = (r.reason as PassageBrief['reason']) ?? null;
    return {
      id: r.id as number,
      doorId: r.door_id as string,
      doorName: (r.door_name as string | null) ?? null,
      atDevice: r.at_device as number,
      result: r.result as PassageBrief['result'],
      reason,
      resultLabel: resultLabel(r.result as string, reason),
      method: r.method as PassageBrief['method'],
      credential: (r.credential as string | null) ?? null,
    };
  }

  /**
   * Derniers passages : rattaches par `holder_id` (index partiel), ou a defaut par le numero d'un badge non rendu tant qu'ils n'ont
   * pas de titulaire (index `(credential, at_device)`). Un passage deja rattache a un AUTRE titulaire (carte redonnee) est ecarte.
   */
  function recentPassages(holderId: number, numbers: string[], limit: number): PassageBrief[] {
    const found = new Map<number, Row>();
    for (const r of all(
      `SELECT ${PASSAGE_COLS} FROM access_event e LEFT JOIN device d ON d.id = e.door_id WHERE e.holder_id = ? ORDER BY e.at_device DESC, e.id DESC LIMIT ?`,
      holderId, limit,
    )) found.set(r.id as number, r);
    for (const number of numbers) {
      for (const r of all(
        `SELECT ${PASSAGE_COLS} FROM access_event e LEFT JOIN device d ON d.id = e.door_id WHERE e.credential = ? AND e.holder_id IS NULL ORDER BY e.at_device DESC, e.id DESC LIMIT ?`,
        number, limit,
      )) found.set(r.id as number, r);
    }
    return [...found.values()]
      .sort((a, b) => (b.at_device as number) - (a.at_device as number) || (b.id as number) - (a.id as number))
      .slice(0, limit)
      .map(passageBrief);
  }

  // ---- Recherche et lecture --------------------------------------------------------------------------------------------------

  /** Entier venu d'une requete (nombre ou chaine de chiffres), ou `undefined` si absent. */
  function queryInt(value: unknown, label: string): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value === 'string' && /^[0-9]{1,15}$/.test(value) && Number(value) > 0) return Number(value);
    throw bad(`${label} est invalide (nombre entier positif attendu).`);
  }

  const encodeCursor = (id: number): string => Buffer.from(`h1:${id}`).toString('base64url');
  function decodeCursor(value: unknown): number {
    if (typeof value !== 'string' || !CURSOR_PATTERN.test(value)) throw bad('Le curseur de pagination est invalide.');
    const m = /^h1:([0-9]{1,15})$/.exec(Buffer.from(value, 'base64url').toString('utf8'));
    if (!m) throw bad('Le curseur de pagination est invalide.');
    return Number(m[1]);
  }

  const searchLogged = new Map<string, number>();
  function logSearch(actor: string, q: string, kind: string): void {
    const t = now();
    const cacheKey = `${actor}\u0000${holderKey(q)}`;
    const last = searchLogged.get(cacheKey);
    if (last !== undefined && t - last >= 0 && t - last < SEARCH_LOG_EVERY_MS) return;
    if (searchLogged.size >= 500) for (const [k, at] of searchLogged) if (t - at >= SEARCH_LOG_EVERY_MS || t < at) searchLogged.delete(k);
    while (searchLogged.size >= 1000) searchLogged.delete(searchLogged.keys().next().value as string);
    searchLogged.set(cacheKey, t);
    log(actor, 'access_holder_search', `recherche « ${clip(q, MAX_QUERY)} » (${kind === 'all' ? 'tous les titulaires' : kind === 'visitor' ? 'visiteurs' : 'personnel'})`);
  }

  function list(filters: HolderFilters, actor: string): HolderList {
    const f = asObject(filters, 'Le filtre');
    const kindRaw = own(f, 'kind');
    if (kindRaw !== undefined && kindRaw !== null && kindRaw !== '' && kindRaw !== 'staff' && kindRaw !== 'visitor' && kindRaw !== 'all') throw bad('Le type doit être « staff », « visitor » ou « all ».');
    const kind = typeof kindRaw === 'string' && kindRaw !== '' ? kindRaw : 'staff';
    const statusRaw = own(f, 'status');
    const status = statusRaw === undefined || statusRaw === null || statusRaw === '' ? null : cleanStatus(statusRaw);
    const groupId = queryInt(own(f, 'groupId'), 'Le groupe');
    const limit = queryInt(own(f, 'limit'), 'La limite') ?? LIST_DEFAULT_LIMIT;
    if (limit > LIST_MAX_LIMIT) throw bad(`La limite ne peut pas dépasser ${LIST_MAX_LIMIT}.`);
    const cursorRaw = own(f, 'cursor');
    const after = cursorRaw === undefined || cursorRaw === null || cursorRaw === '' ? 0 : decodeCursor(cursorRaw);
    const qRaw = own(f, 'q');
    let q = '';
    if (qRaw !== undefined && qRaw !== null) {
      if (typeof qRaw !== 'string') throw bad('La recherche doit être un texte.');
      if (qRaw.length > MAX_QUERY * 4) throw bad(`La recherche est trop longue (${MAX_QUERY} caractères au plus).`);
      if (hasLoneSurrogate(qRaw) || hasForbiddenChar(qRaw)) throw bad('La recherche contient un caractère interdit.');
      q = normalizeName(qRaw).replace(/\s+/g, ' ');
      if ([...q].length > MAX_QUERY) throw bad(`La recherche est trop longue (${MAX_QUERY} caractères au plus).`);
    }

    const where: string[] = [];
    const params: Param[] = [];
    if (kind !== 'all') {
      where.push('h.kind = ?');
      params.push(kind);
    }
    if (status) {
      where.push('h.status = ?');
      params.push(status);
    }
    if (groupId !== undefined) {
      where.push('EXISTS (SELECT 1 FROM access_holder_group g WHERE g.holder_id = h.id AND g.group_id = ?)');
      params.push(groupId);
    }
    if (q !== '') {
      const words = holderKey(q).split(' ').filter((w) => w !== '');
      if (words.length > MAX_QUERY_WORDS) throw bad(`La recherche compte trop de mots (${MAX_QUERY_WORDS} au plus).`);
      const byName = words.map(() => "h.name_key LIKE ? ESCAPE '\\'").join(' AND ');
      where.push(
        `((${byName}) OR h.external_ref LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM access_badge b WHERE b.holder_id = h.id AND b.state <> 'returned' AND b.number LIKE ? ESCAPE '\\'))`,
      );
      for (const w of words) params.push(`%${escapeLike(w)}%`);
      params.push(`%${escapeLike(q)}%`, `${escapeLike(q)}%`);
    }
    const clause = where.length > 0 ? `${where.join(' AND ')} AND ` : '';
    const rows = all(
      `SELECT ${HOLDER_COLS} FROM access_holder h WHERE ${clause}h.id > ? ORDER BY h.id LIMIT ?`,
      ...params, after, limit + 1,
    ) as unknown as HolderRow[];
    const total = (one(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM access_holder h WHERE ${where.length > 0 ? where.join(' AND ') : '1 = 1'} LIMIT ${LIST_TOTAL_CAP})`, ...params) as { n: number }).n;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    if (q !== '' && after === 0) logSearch(actor, q, kind);
    return { items: viewsOf(page), nextCursor: rows.length > limit && last ? encodeCursor(last.id) : null, total };
  }

  function get(id: number): HolderDetail {
    const view = viewOf(holderIdOf(id));
    const numbers = view.badges.filter((b) => b.state !== 'returned').map((b) => b.number);
    return { ...view, recentPassages: recentPassages(view.id, numbers, 10) };
  }

  function findByExternalRef(ref: string): HolderView | null {
    if (typeof ref !== 'string' || !MATRICULE_PATTERN.test(ref.trim())) return null;
    const r = one(`SELECT ${HOLDER_COLS} FROM access_holder h WHERE h.external_ref = ? COLLATE NOCASE`, ref.trim()) as unknown as HolderRow | undefined;
    return r ? (viewsOf([r])[0] as HolderView) : null;
  }

  function findByBadge(number: string): HolderView | null {
    if (typeof number !== 'string' || !BADGE_PATTERN.test(number.trim())) return null;
    const r = one(
      `SELECT ${HOLDER_COLS} FROM access_holder h WHERE h.id = (SELECT holder_id FROM access_badge WHERE number = ? AND state <> 'returned')`,
      number.trim(),
    ) as unknown as HolderRow | undefined;
    return r ? (viewsOf([r])[0] as HolderView) : null;
  }

  function findByName(lastName: string, firstName: string): HolderView[] {
    if (typeof lastName !== 'string' || typeof firstName !== 'string' || lastName.length > 200 || firstName.length > 200) return [];
    const last = normalizeName(lastName);
    const first = normalizeName(firstName);
    if (last === '') return [];
    const rows = all(`SELECT ${HOLDER_COLS} FROM access_holder h WHERE h.name_key = ? ORDER BY h.id LIMIT 100`, keyOf(last, first)) as unknown as HolderRow[];
    // name_key concatene « nom prenom » : « Jean Pierre » + « Dupont » et « Jean » + « Pierre Dupont » se confondent, on les separe ici.
    return viewsOf(rows.filter((r) => holderKey(r.last_name) === holderKey(last) && holderKey(r.first_name) === holderKey(first)));
  }

  // ---- Conflits de droits ------------------------------------------------------------------------------------------------------

  const CONFLICT_ADVICE = 'Un titulaire ne peut avoir qu’un seul horaire par porte : retirez l’un des deux groupes ou donnez-leur le même horaire.';

  /** Un titulaire qui aurait ces groupes recevrait-il deux horaires differents pour une meme porte ? 409 si oui. */
  function checkGroupSet(groupIds: number[]): void {
    if (groupIds.length < 2) return;
    const rows = all(
      `SELECT gd.group_id, g.name AS group_name, gd.door_id, COALESCE(d.name, gd.door_id) AS door_name, gd.schedule_id
         FROM access_group_door gd JOIN access_group g ON g.id = gd.group_id LEFT JOIN device d ON d.id = gd.door_id
        WHERE gd.group_id IN (${placeholders(groupIds.length)}) ORDER BY gd.door_id, gd.group_id`,
      ...groupIds,
    );
    const first = new Map<string, Row>();
    for (const r of rows) {
      const door = r.door_id as string;
      const seen = first.get(door);
      if (!seen) first.set(door, r);
      else if (seen.schedule_id !== r.schedule_id) {
        throw new PsimError(409, `La porte « ${r.door_name as string} » est déjà donnée à ce titulaire par le groupe « ${seen.group_name as string} » avec d’autres horaires (groupe « ${r.group_name as string} »). ${CONFLICT_ADVICE}`);
      }
    }
  }

  /** Les nouvelles portes d'un groupe entrent-elles en conflit pour l'un de ses titulaires avec un autre de leurs groupes ? 409 si oui. */
  function checkGroupDoors(groupId: number, doors: { doorId: string; scheduleId: number }[]): void {
    if (doors.length === 0) return;
    const wanted = new Map(doors.map((d) => [d.doorId, d.scheduleId]));
    const rows = all(
      `SELECT hg.holder_id, g.name AS group_name, gd.door_id, COALESCE(d.name, gd.door_id) AS door_name, gd.schedule_id
         FROM access_holder_group me
         JOIN access_holder_group hg ON hg.holder_id = me.holder_id AND hg.group_id <> me.group_id
         JOIN access_group_door gd ON gd.group_id = hg.group_id
         JOIN access_group g ON g.id = hg.group_id
         LEFT JOIN device d ON d.id = gd.door_id
        WHERE me.group_id = ? AND gd.door_id IN (${placeholders(doors.length)})
        ORDER BY hg.holder_id, gd.door_id`,
      groupId, ...doors.map((d) => d.doorId),
    );
    for (const r of rows) {
      if (wanted.get(r.door_id as string) === r.schedule_id) continue;
      const holder = one('SELECT last_name, first_name FROM access_holder WHERE id = ?', r.holder_id as number);
      const who = holder ? displayOf(holder.last_name as string, holder.first_name as string) : `H${r.holder_id as number}`;
      throw new PsimError(409, `La porte « ${r.door_name as string} » est déjà donnée à ${who}, membre de ce groupe, par le groupe « ${r.group_name as string} » avec d’autres horaires. ${CONFLICT_ADVICE}`);
    }
  }

  // ---- Titulaires : ecriture ---------------------------------------------------------------------------------------------------

  /** Groupes d'une entree : liste d'identifiants entiers existants (dedoublonnee, 20 au plus). */
  function cleanGroupIds(raw: unknown): number[] {
    if (!Array.isArray(raw)) throw bad('Les groupes doivent être une liste d’identifiants.');
    if (raw.length > MAX_GROUPS_PER_HOLDER) throw bad(`Un titulaire ne peut pas appartenir à plus de ${MAX_GROUPS_PER_HOLDER} groupes.`);
    const ids = [...new Set(raw.map((v) => positiveInt(v, 'Un identifiant de groupe')))];
    for (const id of ids) if (!one('SELECT 1 AS x FROM access_group WHERE id = ?', id)) throw bad(`Le groupe n°${id} n’existe pas.`);
    return ids;
  }

  const groupIdsOfHolder = (holderId: number): number[] => all('SELECT group_id FROM access_holder_group WHERE holder_id = ? ORDER BY group_id', holderId).map((r) => r.group_id as number);

  function checkDates(from: number | null, to: number | null, kind: HolderKind): void {
    if (from !== null && to !== null && to <= from) throw bad('La fin de validité doit être postérieure au début.');
    if (kind === 'visitor' && to === null) throw bad('La fin de visite est obligatoire pour un visiteur.');
  }

  function checkMatriculeFree(matricule: string | null, exceptId: number): void {
    if (matricule === null) return;
    const clash = one('SELECT id FROM access_holder WHERE external_ref = ? COLLATE NOCASE AND id <> ?', matricule, exceptId);
    if (clash) throw new PsimError(409, 'Ce matricule est déjà utilisé par un autre titulaire.');
  }

  function countHolders(): number {
    return (one('SELECT COUNT(*) AS n FROM access_holder') as { n: number }).n;
  }

  /** Insere un badge actif apres tous les controles (numero libre, limites). */
  function insertBadge(holderId: number, number: string, actor: string, t: number): number {
    const clash = one("SELECT holder_id, state FROM access_badge WHERE number = ? AND state <> 'returned'", number) as { holder_id: number; state: BadgeState } | undefined;
    if (clash) {
      throw new PsimError(409, clash.holder_id === holderId
        ? 'Ce badge est déjà enregistré pour ce titulaire.'
        : `Ce numéro de badge est déjà enregistré pour un autre titulaire (badge ${STATE_LABEL[clash.state].toLowerCase()}). Un numéro redevient disponible quand le badge est rendu.`);
    }
    const rows = (one('SELECT COUNT(*) AS n, SUM(state = \'active\') AS active FROM access_badge WHERE holder_id = ?', holderId) as { n: number; active: number | null });
    if (rows.n >= MAX_BADGE_ROWS) throw new PsimError(409, `Ce titulaire a déjà ${MAX_BADGE_ROWS} badges enregistrés : supprimez d’anciens badges (rendus ou perdus) avant d’en ajouter.`);
    if ((rows.active ?? 0) >= MAX_ACTIVE_BADGES) throw new PsimError(409, `Ce titulaire a déjà ${MAX_ACTIVE_BADGES} badges actifs : désactivez-en un avant d’en ajouter.`);
    return run('INSERT INTO access_badge (holder_id, number, state, state_at, state_by, created_at) VALUES (?, ?, \'active\', ?, ?, ?)', holderId, number, t, actor, t).id;
  }

  function create(actor: string, input: HolderInput, mutation: MutationOptions = {}): HolderView {
    const o = asObject(input, 'Le titulaire');
    // Un visiteur se crée à l'accueil (createVisitor) : badge, groupe et durée y sont obligatoires.
    const kindRaw = own(o, 'kind');
    if (kindRaw !== undefined && kindRaw !== 'staff') throw bad('Un visiteur se crée depuis l’accueil des visiteurs, pas comme un titulaire du personnel.');
    const names = cleanNames(own(o, 'lastName'), own(o, 'firstName'));
    const matricule = cleanMatricule(own(o, 'externalRef'));
    const t = now();
    const statusRaw = own(o, 'status');
    const status = statusRaw === undefined || statusRaw === null ? 'active' : cleanStatus(statusRaw);
    const validFrom = cleanInstant(own(o, 'validFrom'), 'Le début de validité', t);
    const validTo = cleanInstant(own(o, 'validTo'), 'La fin de validité', t);
    checkDates(validFrom, validTo, 'staff');
    const groupsRaw = own(o, 'groupIds');
    const groupIds = groupsRaw === undefined || groupsRaw === null ? [] : cleanGroupIds(groupsRaw);
    const badgesRaw = own(o, 'badges');
    let numbers: string[] = [];
    if (badgesRaw !== undefined && badgesRaw !== null) {
      if (!Array.isArray(badgesRaw)) throw bad('Les badges doivent être une liste de numéros.');
      if (badgesRaw.length > MAX_ACTIVE_BADGES) throw bad(`Un titulaire a ${MAX_ACTIVE_BADGES} badges actifs au plus.`);
      numbers = badgesRaw.map(cleanBadgeNumber);
      if (new Set(numbers.map((n) => n.toLowerCase())).size !== numbers.length) throw bad('Un même numéro de badge est donné deux fois.');
    }
    return write(() => {
      if (countHolders() >= MAX_HOLDERS) throw new PsimError(409, `Le nombre maximal de titulaires (${MAX_HOLDERS}) est atteint : supprimez des fiches inutiles.`);
      checkMatriculeFree(matricule, 0);
      checkGroupSet(groupIds);
      const id = run(
        `INSERT INTO access_holder (last_name, first_name, name_key, external_ref, kind, status, valid_from, valid_to, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, 'staff', ?, ?, ?, ?, ?, ?, ?)`,
        names.lastName, names.firstName, keyOf(names.lastName, names.firstName), matricule, status, validFrom, validTo, t, actor, t, actor,
      ).id;
      for (const g of groupIds) run('INSERT INTO access_holder_group (holder_id, group_id) VALUES (?, ?)', id, g);
      for (const n of numbers) insertBadge(id, n, actor, t);
      if (!mutation.quiet) log(actor, 'access_holder_created', `H${id} : ${numbers.length} badge(s), ${groupIds.length} groupe(s)`);
      return { value: viewOf(id), touched: controllersOfHolder(id) };
    });
  }

  function update(actor: string, id: number, input: HolderInput, mutation: MutationOptions = {}): HolderView {
    const holderId = holderIdOf(id);
    const o = asObject(input, 'Le titulaire');
    const cur = mustHolder(holderId);
    const kindRaw = own(o, 'kind');
    if (kindRaw !== undefined && kindRaw !== cur.kind) throw new PsimError(409, 'Un visiteur ne peut pas devenir un titulaire du personnel, ni l’inverse.');
    if (own(o, 'badges') !== undefined) throw bad('Les badges se gèrent un par un (ajout, état, suppression), pas par la modification du titulaire.');
    const t = now();
    const touchesName = own(o, 'lastName') !== undefined || own(o, 'firstName') !== undefined;
    const names = touchesName
      ? cleanNames(own(o, 'lastName') === undefined ? cur.last_name : own(o, 'lastName'), own(o, 'firstName') === undefined ? cur.first_name : own(o, 'firstName'))
      : { lastName: cur.last_name, firstName: cur.first_name };
    const matricule = own(o, 'externalRef') === undefined ? cur.external_ref : cleanMatricule(own(o, 'externalRef'));
    const statusRaw = own(o, 'status');
    const status = statusRaw === undefined ? cur.status : cleanStatus(statusRaw);
    const validFrom = own(o, 'validFrom') === undefined ? cur.valid_from : cleanInstant(own(o, 'validFrom'), 'Le début de validité', t);
    const validTo = own(o, 'validTo') === undefined ? cur.valid_to : cleanInstant(own(o, 'validTo'), 'La fin de validité', t);
    if (own(o, 'validFrom') !== undefined || own(o, 'validTo') !== undefined) checkDates(validFrom, validTo, cur.kind);
    const groupsRaw = own(o, 'groupIds');
    const groupIds = groupsRaw === undefined ? null : cleanGroupIds(groupsRaw);

    return write(() => {
      const before = controllersOfHolder(holderId);
      checkMatriculeFree(matricule, holderId);
      const oldGroups = groupIdsOfHolder(holderId);
      const newGroups = groupIds === null ? oldGroups : [...groupIds].sort((a, b) => a - b);
      const groupsChanged = oldGroups.join(',') !== newGroups.join(',');
      if (groupsChanged) checkGroupSet(newGroups);
      const changed: string[] = [];
      if (names.lastName !== cur.last_name || names.firstName !== cur.first_name) changed.push('nom');
      if (matricule !== cur.external_ref) changed.push('matricule');
      if (status !== cur.status) changed.push('statut');
      if (validFrom !== cur.valid_from || validTo !== cur.valid_to) changed.push('validité');
      if (groupsChanged) changed.push('groupes');
      if (changed.length === 0) return { value: viewOf(holderId) };
      run(
        'UPDATE access_holder SET last_name = ?, first_name = ?, name_key = ?, external_ref = ?, status = ?, valid_from = ?, valid_to = ?, updated_at = ?, updated_by = ? WHERE id = ?',
        names.lastName, names.firstName, keyOf(names.lastName, names.firstName), matricule, status, validFrom, validTo, t, actor, holderId,
      );
      if (groupsChanged) {
        run('DELETE FROM access_holder_group WHERE holder_id = ?', holderId);
        for (const g of newGroups) run('INSERT INTO access_holder_group (holder_id, group_id) VALUES (?, ?)', holderId, g);
      }
      if (!mutation.quiet) log(actor, 'access_holder_updated', `H${holderId} : ${changed.join(', ')}`);
      // Seul ce qui part vers les controleurs compte : un simple changement de matricule ne notifie personne.
      const rights = changed.some((c) => c !== 'matricule');
      return { value: viewOf(holderId), touched: rights ? [...before, ...controllersOfHolder(holderId)] : undefined };
    });
  }

  /** Supprime un titulaire et tout ce qui s'y rattache (badges, groupes, photo) ; les passages gardent leur nom et leur badge. */
  function deleteHolderRows(holderId: number): void {
    run('DELETE FROM access_badge WHERE holder_id = ?', holderId);
    run('DELETE FROM access_holder_group WHERE holder_id = ?', holderId);
    run('DELETE FROM access_holder_photo WHERE holder_id = ?', holderId);
    run('DELETE FROM access_holder WHERE id = ?', holderId);
  }

  function remove(actor: string, id: number): void {
    const holderId = holderIdOf(id);
    write(() => {
      const cur = mustHolder(holderId);
      const touched = controllersOfHolder(holderId);
      const badges = (one('SELECT COUNT(*) AS n FROM access_badge WHERE holder_id = ?', holderId) as { n: number }).n;
      deleteHolderRows(holderId);
      log(actor, 'access_holder_deleted', `H${holderId} : ${cur.kind === 'visitor' ? 'visiteur' : 'personnel'}, ${badges} badge(s) supprimé(s)`);
      return { value: undefined, touched };
    });
  }

  // ---- Photo ------------------------------------------------------------------------------------------------------------------

  function photo(id: number): { mime: string; data: Buffer } | null {
    const holderId = holderIdOf(id);
    const r = one('SELECT mime, data FROM access_holder_photo WHERE holder_id = ?', holderId);
    if (!r) return null;
    return { mime: r.mime as string, data: Buffer.from(r.data as Uint8Array) };
  }

  function setPhoto(actor: string, id: number, mime: string, data: Buffer): void {
    const holderId = holderIdOf(id);
    if (typeof mime !== 'string' || !(PHOTO_TYPES as readonly string[]).includes(mime)) throw bad('La photo doit être au format JPEG, PNG ou WebP.');
    if (!(data instanceof Uint8Array) || data.length === 0) throw bad('La photo est vide.');
    if (data.length > PHOTO_MAX_BYTES) throw bad(`La photo est trop lourde (${Math.round(PHOTO_MAX_BYTES / 1024)} Ko au plus).`);
    const real = imageMimeOf(data);
    if (real === null) throw bad('Ce fichier n’est pas une image JPEG, PNG ou WebP valide.');
    if (real !== mime) throw bad('Le contenu du fichier ne correspond pas au type annoncé.');
    write(() => {
      mustHolder(holderId);
      run(
        'INSERT INTO access_holder_photo (holder_id, mime, data) VALUES (?, ?, ?) ON CONFLICT(holder_id) DO UPDATE SET mime = excluded.mime, data = excluded.data',
        holderId, mime, new Uint8Array(data),
      );
      log(actor, 'access_holder_photo_set', `H${holderId} : photo enregistrée (${mime}, ${data.length} octets)`);
      return { value: undefined };
    });
  }

  function clearPhoto(actor: string, id: number): void {
    const holderId = holderIdOf(id);
    write(() => {
      mustHolder(holderId);
      if (run('DELETE FROM access_holder_photo WHERE holder_id = ?', holderId).changes === 0) throw new PsimError(404, 'Ce titulaire n’a pas de photo.');
      log(actor, 'access_holder_photo_cleared', `H${holderId}`);
      return { value: undefined };
    });
  }

  // ---- Badges -----------------------------------------------------------------------------------------------------------------

  function badgeRow(badgeId: unknown): BadgeRow {
    if (typeof badgeId !== 'number' || !Number.isSafeInteger(badgeId) || badgeId <= 0) throw new PsimError(404, 'Badge introuvable');
    const r = one('SELECT id, holder_id, number, state, state_at, state_by, created_at FROM access_badge WHERE id = ?', badgeId) as unknown as BadgeRow | undefined;
    if (!r) throw new PsimError(404, 'Badge introuvable');
    return r;
  }

  function checkVisitNotEnded(holder: HolderRow): void {
    if (holder.kind === 'visitor' && holder.ended_at !== null) throw new PsimError(409, 'La visite de ce visiteur est terminée : on ne peut plus lui donner de badge.');
  }

  function addBadge(actor: string, holderId: number, number: unknown, mutation: MutationOptions = {}): BadgeView {
    const hid = holderIdOf(holderId);
    const clean = cleanBadgeNumber(number);
    return write(() => {
      const holder = mustHolder(hid);
      checkVisitNotEnded(holder);
      const t = now();
      const id = insertBadge(hid, clean, actor, t);
      if (!mutation.quiet) log(actor, 'access_badge_added', `B${id} ajouté à H${hid}`);
      return { value: badgeView(badgeRow(id)), touched: controllersOfHolder(hid) };
    });
  }

  function setBadgeState(actor: string, badgeId: number, state: unknown): BadgeView {
    const next = cleanBadgeState(state);
    return write(() => {
      const b = badgeRow(badgeId);
      if (b.state === next) return { value: badgeView(b) };
      const holder = mustHolder(b.holder_id);
      if (next === 'active') checkVisitNotEnded(holder);
      // Un badge rendu qui revient (ou un badge perdu retrouve) reprend un numero que quelqu'un d'autre a pu recevoir entre-temps.
      if (b.state === 'returned') {
        const clash = one("SELECT 1 AS x FROM access_badge WHERE number = ? AND state <> 'returned' AND id <> ?", b.number, b.id);
        if (clash) throw new PsimError(409, 'Ce numéro de badge a été attribué à quelqu’un d’autre depuis qu’il a été rendu : il ne peut pas être rétabli.');
      }
      if (next === 'active') {
        const active = (one("SELECT COUNT(*) AS n FROM access_badge WHERE holder_id = ? AND state = 'active'", b.holder_id) as { n: number }).n;
        if (active >= MAX_ACTIVE_BADGES) throw new PsimError(409, `Ce titulaire a déjà ${MAX_ACTIVE_BADGES} badges actifs : désactivez-en un avant d’en réactiver un autre.`);
      }
      const t = now();
      run('UPDATE access_badge SET state = ?, state_at = ?, state_by = ? WHERE id = ?', next, t, actor, b.id);
      log(actor, 'access_badge_state_changed', `B${b.id} (H${b.holder_id}) : ${b.state} -> ${next}`);
      return { value: badgeView(badgeRow(b.id)), touched: b.state === 'active' || next === 'active' ? controllersOfHolder(b.holder_id) : undefined };
    });
  }

  function removeBadge(actor: string, badgeId: number): void {
    write(() => {
      const b = badgeRow(badgeId);
      run('DELETE FROM access_badge WHERE id = ?', b.id);
      log(actor, 'access_badge_removed', `B${b.id} (H${b.holder_id}) : état ${b.state}`);
      return { value: undefined, touched: b.state === 'active' ? controllersOfHolder(b.holder_id) : undefined };
    });
  }

  // ---- Groupes ----------------------------------------------------------------------------------------------------------------

  function groupViews(onlyId: number | null): GroupView[] {
    const rows = (onlyId === null
      ? all('SELECT * FROM access_group ORDER BY name_key, id')
      : all('SELECT * FROM access_group WHERE id = ?', onlyId)) as unknown as GroupRow[];
    if (rows.length === 0) return [];
    const doors = new Map<number, GroupDoorView[]>();
    const doorRows = onlyId === null
      ? all(DOORS_SQL + ' ORDER BY gd.group_id, gd.door_id')
      : all(DOORS_SQL + ' WHERE gd.group_id = ? ORDER BY gd.group_id, gd.door_id', onlyId);
    for (const d of doorRows) {
      const list = doors.get(d.group_id as number) ?? [];
      list.push({
        doorId: d.door_id as string,
        doorName: d.declared === 1 ? ((d.door_name as string | null) ?? null) : null,
        controllerId: (d.controller_id as string | null) ?? null,
        scheduleId: d.schedule_id as number,
        scheduleName: d.schedule_name as string,
      });
      doors.set(d.group_id as number, list);
    }
    const counts = new Map<number, number>();
    const countRows = onlyId === null
      ? all('SELECT group_id, COUNT(*) AS n FROM access_holder_group GROUP BY group_id')
      : all('SELECT group_id, COUNT(*) AS n FROM access_holder_group WHERE group_id = ? GROUP BY group_id', onlyId);
    for (const c of countRows) counts.set(c.group_id as number, c.n as number);
    return rows.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      forVisitors: g.for_visitors === 1,
      doors: doors.get(g.id) ?? [],
      holderCount: counts.get(g.id) ?? 0,
      createdAt: g.created_at,
      createdBy: g.created_by,
      updatedAt: g.updated_at,
      updatedBy: g.updated_by,
    }));
  }

  const DOORS_SQL =
    `SELECT gd.group_id, gd.door_id, gd.schedule_id, s.name AS schedule_name, ad.controller_id, d.name AS door_name, (ad.detector_id IS NOT NULL) AS declared
       FROM access_group_door gd
       JOIN access_schedule s ON s.id = gd.schedule_id
       LEFT JOIN access_door ad ON ad.detector_id = gd.door_id
       LEFT JOIN device d ON d.id = gd.door_id`;

  function groupIdOf(id: unknown): number {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new PsimError(404, 'Groupe introuvable');
    return id;
  }

  function group(id: number): GroupView {
    const v = groupViews(groupIdOf(id))[0];
    if (!v) throw new PsimError(404, 'Groupe introuvable');
    return v;
  }

  const groups = (): GroupView[] => groupViews(null);

  function groupByName(name: string): GroupView | null {
    if (typeof name !== 'string' || name.length > MAX_GROUP_NAME * 4) return null;
    const r = one('SELECT id FROM access_group WHERE name_key = ?', holderKey(normalizeName(name))) as { id: number } | undefined;
    return r ? (groupViews(r.id)[0] ?? null) : null;
  }

  function cleanGroupDoors(raw: unknown): { doorId: string; scheduleId: number }[] {
    if (!Array.isArray(raw)) throw bad('Les portes du groupe doivent être une liste { doorId, scheduleId }.');
    if (raw.length > MAX_DOORS_PER_GROUP) throw bad(`Un groupe ne peut pas donner plus de ${MAX_DOORS_PER_GROUP} portes.`);
    const seen = new Set<string>();
    return raw.map((entry, i) => {
      if (!isPlainObject(entry)) throw bad(`Porte ${i + 1} du groupe : { doorId, scheduleId } attendu.`);
      const doorId = own(entry, 'doorId');
      if (typeof doorId !== 'string' || !DOOR_ID_PATTERN.test(doorId)) throw bad(`Porte ${i + 1} du groupe : identifiant de porte invalide.`);
      if (seen.has(doorId)) throw bad(`La porte « ${doorId} » est donnée deux fois au même groupe.`);
      seen.add(doorId);
      const scheduleId = positiveInt(own(entry, 'scheduleId'), `Porte « ${doorId} » : l’identifiant de l’horaire`);
      if (!one('SELECT 1 AS x FROM access_door WHERE detector_id = ?', doorId)) throw bad(`La porte « ${doorId} » n’est pas déclarée dans le contrôle d’accès.`);
      if (!one('SELECT 1 AS x FROM access_schedule WHERE id = ?', scheduleId)) throw bad(`L’horaire n°${scheduleId} n’existe pas.`);
      return { doorId, scheduleId };
    });
  }

  function createGroup(actor: string, input: GroupInput): GroupView {
    const o = asObject(input, 'Le groupe');
    const name = cleanLabel(own(o, 'name'), 'Le nom du groupe', MAX_GROUP_NAME, true);
    const description = cleanLabel(own(o, 'description'), 'La description', MAX_DESCRIPTION, false);
    const forVisitorsRaw = own(o, 'forVisitors');
    const forVisitors = forVisitorsRaw === undefined || forVisitorsRaw === null ? false : cleanBoolean(forVisitorsRaw, 'Le réglage « visiteurs »');
    const doorsRaw = own(o, 'doors');
    return write(() => {
      const doors = doorsRaw === undefined || doorsRaw === null ? [] : cleanGroupDoors(doorsRaw);
      if ((one('SELECT COUNT(*) AS n FROM access_group') as { n: number }).n >= MAX_GROUPS) throw new PsimError(409, `Le nombre maximal de groupes (${MAX_GROUPS}) est atteint.`);
      if (one('SELECT 1 AS x FROM access_group WHERE name_key = ?', holderKey(name))) throw new PsimError(409, 'Un groupe porte déjà ce nom.');
      const t = now();
      const id = run(
        'INSERT INTO access_group (name, name_key, description, for_visitors, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        name, holderKey(name), description, forVisitors ? 1 : 0, t, actor, t, actor,
      ).id;
      for (const d of doors) run('INSERT INTO access_group_door (group_id, door_id, schedule_id) VALUES (?, ?, ?)', id, d.doorId, d.scheduleId);
      log(actor, 'access_group_created', `G${id} : ${doors.length} porte(s)`);
      return { value: group(id) };
    });
  }

  function updateGroup(actor: string, id: number, input: GroupInput): GroupView {
    const gid = groupIdOf(id);
    const o = asObject(input, 'Le groupe');
    return write(() => {
      const cur = one('SELECT * FROM access_group WHERE id = ?', gid) as unknown as GroupRow | undefined;
      if (!cur) throw new PsimError(404, 'Groupe introuvable');
      const name = own(o, 'name') === undefined ? cur.name : cleanLabel(own(o, 'name'), 'Le nom du groupe', MAX_GROUP_NAME, true);
      const description = own(o, 'description') === undefined ? cur.description : cleanLabel(own(o, 'description'), 'La description', MAX_DESCRIPTION, false);
      const forVisitors = own(o, 'forVisitors') === undefined ? cur.for_visitors === 1 : cleanBoolean(own(o, 'forVisitors'), 'Le réglage « visiteurs »');
      const doors = own(o, 'doors') === undefined ? null : cleanGroupDoors(own(o, 'doors'));
      if (one('SELECT 1 AS x FROM access_group WHERE name_key = ? AND id <> ?', holderKey(name), gid)) throw new PsimError(409, 'Un groupe porte déjà ce nom.');
      const before = controllersOfGroup(gid);
      const oldDoors = all('SELECT door_id, schedule_id FROM access_group_door WHERE group_id = ? ORDER BY door_id', gid).map((r) => `${r.door_id as string}:${r.schedule_id as number}`).join(',');
      const newDoors = doors === null ? oldDoors : [...doors].sort((a, b) => (a.doorId < b.doorId ? -1 : 1)).map((d) => `${d.doorId}:${d.scheduleId}`).join(',');
      const doorsChanged = oldDoors !== newDoors;
      if (doorsChanged && doors !== null) checkGroupDoors(gid, doors);
      const changed: string[] = [];
      if (name !== cur.name) changed.push('nom');
      if (description !== cur.description) changed.push('description');
      if (forVisitors !== (cur.for_visitors === 1)) changed.push('visiteurs');
      if (doorsChanged) changed.push('portes');
      if (changed.length === 0) return { value: group(gid) };
      run('UPDATE access_group SET name = ?, name_key = ?, description = ?, for_visitors = ?, updated_at = ?, updated_by = ? WHERE id = ?', name, holderKey(name), description, forVisitors ? 1 : 0, now(), actor, gid);
      if (doorsChanged && doors !== null) {
        run('DELETE FROM access_group_door WHERE group_id = ?', gid);
        for (const d of doors) run('INSERT INTO access_group_door (group_id, door_id, schedule_id) VALUES (?, ?, ?)', gid, d.doorId, d.scheduleId);
      }
      log(actor, 'access_group_updated', `G${gid} : ${changed.join(', ')}`);
      return { value: group(gid), touched: doorsChanged ? [...before, ...controllersOfGroup(gid)] : undefined };
    });
  }

  function deleteGroup(actor: string, id: number): void {
    const gid = groupIdOf(id);
    write(() => {
      if (!one('SELECT 1 AS x FROM access_group WHERE id = ?', gid)) throw new PsimError(404, 'Groupe introuvable');
      const n = (one('SELECT COUNT(*) AS n FROM access_holder_group WHERE group_id = ?', gid) as { n: number }).n;
      if (n > 0) throw new PsimError(409, `Ce groupe a encore ${n} titulaire(s) : retirez-les du groupe avant de le supprimer.`);
      run('DELETE FROM access_group_door WHERE group_id = ?', gid);
      run('DELETE FROM access_group WHERE id = ?', gid);
      log(actor, 'access_group_deleted', `G${gid}`);
      return { value: undefined };
    });
  }

  // ---- Plages horaires --------------------------------------------------------------------------------------------------------

  function scheduleViews(onlyId: number | null): ScheduleView[] {
    const rows = (onlyId === null ? all('SELECT * FROM access_schedule ORDER BY builtin DESC, name_key, id') : all('SELECT * FROM access_schedule WHERE id = ?', onlyId)) as unknown as ScheduleRow[];
    const counts = new Map<number, number>();
    const countRows = onlyId === null
      ? all('SELECT schedule_id, COUNT(DISTINCT group_id) AS n FROM access_group_door GROUP BY schedule_id')
      : all('SELECT schedule_id, COUNT(DISTINCT group_id) AS n FROM access_group_door WHERE schedule_id = ? GROUP BY schedule_id', onlyId);
    for (const c of countRows) counts.set(c.schedule_id as number, c.n as number);
    return rows.map((s) => ({
      id: s.id,
      ref: `S${s.id}`,
      name: s.name,
      windows: parseWindows(s.windows),
      closedOnHolidays: s.closed_on_holidays === 1,
      builtin: s.builtin === 1,
      groupCount: counts.get(s.id) ?? 0,
    }));
  }

  /** Plages stockees, reconstruites dans un ordre de cles fixe (la sortie de `desired` doit etre stable octet pour octet). */
  function parseWindows(json: string): Window[] {
    const raw = JSON.parse(json) as Window[];
    return raw.map((w) => ({ days: [...w.days], from: w.from, to: w.to }));
  }

  function scheduleIdOf(id: unknown): number {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new PsimError(404, 'Plage horaire introuvable');
    return id;
  }

  function schedule(id: number): ScheduleView {
    const v = scheduleViews(scheduleIdOf(id))[0];
    if (!v) throw new PsimError(404, 'Plage horaire introuvable');
    return v;
  }

  const schedules = (): ScheduleView[] => scheduleViews(null);

  function cleanWindows(raw: unknown): Window[] {
    if (!Array.isArray(raw)) throw bad('Les plages horaires doivent être une liste.');
    if (raw.length === 0) throw bad('Un horaire doit compter au moins une plage.');
    if (raw.length > MAX_WINDOWS) throw bad(`Un horaire compte ${MAX_WINDOWS} plages au plus.`);
    for (const w of raw) if (isPlainObject(w) && Array.isArray(w.days) && w.days.length > 7) throw bad('Une plage compte 7 jours au plus.');
    const windows = parseSchedule(raw);
    if (windows === null) throw bad('Les plages horaires sont obligatoires.');
    return windows.map((w) => ({ days: w.days, from: w.from, to: w.to }));
  }

  function createSchedule(actor: string, input: ScheduleInput): ScheduleView {
    const o = asObject(input, 'L’horaire');
    const name = cleanLabel(own(o, 'name'), 'Le nom de l’horaire', MAX_LABEL, true);
    const windows = cleanWindows(own(o, 'windows'));
    const closedRaw = own(o, 'closedOnHolidays');
    const closed = closedRaw === undefined || closedRaw === null ? false : cleanBoolean(closedRaw, 'Le réglage « fermé les jours fériés »');
    return write(() => {
      if ((one('SELECT COUNT(*) AS n FROM access_schedule') as { n: number }).n >= MAX_SCHEDULES) throw new PsimError(409, `Le nombre maximal d’horaires (${MAX_SCHEDULES}) est atteint.`);
      if (one('SELECT 1 AS x FROM access_schedule WHERE name_key = ?', holderKey(name))) throw new PsimError(409, 'Un horaire porte déjà ce nom.');
      const id = run('INSERT INTO access_schedule (name, name_key, windows, closed_on_holidays, builtin) VALUES (?, ?, ?, ?, 0)', name, holderKey(name), JSON.stringify(windows), closed ? 1 : 0).id;
      log(actor, 'access_schedule_created', `S${id} : ${windows.length} plage(s)`);
      return { value: schedule(id) };
    });
  }

  function updateSchedule(actor: string, id: number, input: ScheduleInput): ScheduleView {
    const sid = scheduleIdOf(id);
    const o = asObject(input, 'L’horaire');
    return write(() => {
      const cur = one('SELECT * FROM access_schedule WHERE id = ?', sid) as unknown as ScheduleRow | undefined;
      if (!cur) throw new PsimError(404, 'Plage horaire introuvable');
      if (cur.builtin === 1) throw new PsimError(409, `L’horaire « ${cur.name} » est fourni par le système : il ne peut être ni modifié ni supprimé.`);
      const name = own(o, 'name') === undefined ? cur.name : cleanLabel(own(o, 'name'), 'Le nom de l’horaire', MAX_LABEL, true);
      const windows = own(o, 'windows') === undefined ? parseWindows(cur.windows) : cleanWindows(own(o, 'windows'));
      const closed = own(o, 'closedOnHolidays') === undefined ? cur.closed_on_holidays === 1 : cleanBoolean(own(o, 'closedOnHolidays'), 'Le réglage « fermé les jours fériés »');
      if (one('SELECT 1 AS x FROM access_schedule WHERE name_key = ? AND id <> ?', holderKey(name), sid)) throw new PsimError(409, 'Un horaire porte déjà ce nom.');
      const windowsJson = JSON.stringify(windows);
      const changed: string[] = [];
      if (name !== cur.name) changed.push('nom');
      if (windowsJson !== JSON.stringify(parseWindows(cur.windows))) changed.push('plages');
      if (closed !== (cur.closed_on_holidays === 1)) changed.push('jours fériés');
      if (changed.length === 0) return { value: schedule(sid) };
      run('UPDATE access_schedule SET name = ?, name_key = ?, windows = ?, closed_on_holidays = ? WHERE id = ?', name, holderKey(name), windowsJson, closed ? 1 : 0, sid);
      log(actor, 'access_schedule_updated', `S${sid} : ${changed.join(', ')}`);
      // Le nom ne part pas vers les controleurs : seuls les plages et l'option « jours feries » comptent.
      return { value: schedule(sid), touched: changed.some((c) => c !== 'nom') ? controllersOfSchedule(sid) : undefined };
    });
  }

  function deleteSchedule(actor: string, id: number): void {
    const sid = scheduleIdOf(id);
    write(() => {
      const cur = one('SELECT * FROM access_schedule WHERE id = ?', sid) as unknown as ScheduleRow | undefined;
      if (!cur) throw new PsimError(404, 'Plage horaire introuvable');
      if (cur.builtin === 1) throw new PsimError(409, `L’horaire « ${cur.name} » est fourni par le système : il ne peut être ni modifié ni supprimé.`);
      const n = (one('SELECT COUNT(DISTINCT group_id) AS n FROM access_group_door WHERE schedule_id = ?', sid) as { n: number }).n;
      if (n > 0) throw new PsimError(409, `Cet horaire est utilisé par ${n} groupe(s) : changez l’horaire de ces groupes avant de le supprimer.`);
      run('DELETE FROM access_schedule WHERE id = ?', sid);
      log(actor, 'access_schedule_deleted', `S${sid}`);
      return { value: undefined };
    });
  }

  // ---- Jours feries -----------------------------------------------------------------------------------------------------------

  const holidays = (): HolidayView[] => all('SELECT date, label FROM access_holiday ORDER BY date').map((r) => ({ date: r.date as string, label: (r.label as string | null) ?? null }));

  function setHolidays(actor: string, entries: unknown): HolidayView[] {
    if (!Array.isArray(entries)) throw bad('Les jours fériés doivent être une liste { date, label }.');
    if (entries.length > MAX_HOLIDAYS) throw bad(`Il y a trop de jours fériés (${MAX_HOLIDAYS} au plus).`);
    const seen = new Set<string>();
    const clean = entries.map((entry, i) => {
      const n = i + 1;
      // Une simple date « AAAA-MM-JJ » est aussi acceptee.
      const o = typeof entry === 'string' ? { date: entry } : entry;
      if (!isPlainObject(o)) throw bad(`Jour férié ${n} : { date, label } attendu.`);
      const date = cleanDate(own(o, 'date'), `Jour férié ${n} : la date`);
      if (seen.has(date)) throw bad(`Jour férié ${n} : la date ${date} est donnée deux fois.`);
      seen.add(date);
      const label = cleanLabel(own(o, 'label'), `Jour férié ${n} : le libellé`, MAX_LABEL, false);
      return { date, label: label === '' ? null : label };
    });
    return write(() => {
      run('DELETE FROM access_holiday');
      for (const h of clean) run('INSERT INTO access_holiday (date, label) VALUES (?, ?)', h.date, h.label);
      log(actor, 'access_holidays_replaced', `${clean.length} jour(s) férié(s)`);
      return { value: holidays(), touched: allControllerIds() };
    });
  }

  // ---- Visiteurs --------------------------------------------------------------------------------------------------------------

  function visitorView(view: HolderView, r: HolderRow, t: number): VisitorView {
    const ended = r.ended_at !== null || (r.valid_to !== null && r.valid_to <= t);
    const endsAt = r.valid_to ?? 0;
    const numbers = view.badges.filter((b) => b.state !== 'returned').map((b) => b.number);
    // Badge rendu a la fin de la visite : ses passages restent retrouvables par `holder_id`.
    return {
      holder: view,
      host: r.visitor_host ?? '',
      reason: r.visitor_reason ?? '',
      startsAt: r.valid_from,
      endsAt,
      state: ended ? 'ended' : r.valid_from !== null && r.valid_from > t ? 'upcoming' : 'present',
      remainingMs: ended ? 0 : Math.max(0, endsAt - t),
      lastPassage: recentPassages(r.id, numbers, 1)[0] ?? null,
    };
  }

  function visitors(scope: 'current' | 'recent' = 'current'): VisitorView[] {
    if (scope !== 'current' && scope !== 'recent') throw bad('La portée doit être « current » ou « recent ».');
    const t = now();
    const rows = all(
      `SELECT ${HOLDER_COLS} FROM access_holder h WHERE h.kind = 'visitor' AND (h.ended_at IS NULL OR h.ended_at > ?) ORDER BY h.id LIMIT ?`,
      t - RECENT_VISITORS_MS, VISITORS_MAX,
    ) as unknown as HolderRow[];
    const kept = rows.filter((r) => {
      const ended = r.ended_at !== null || (r.valid_to !== null && r.valid_to <= t);
      if (!ended) return true;
      if (scope === 'current') return false;
      // Visite echue mais pas encore terminee par `tick` : fin effective = son echeance.
      return (r.ended_at ?? r.valid_to ?? 0) > t - RECENT_VISITORS_MS;
    });
    const views = viewsOf(kept);
    return kept.map((r, i) => visitorView(views[i] as HolderView, r, t));
  }

  function createVisitor(actor: string, input: VisitorInput): VisitorView {
    const o = asObject(input, 'Le visiteur');
    const names = cleanNames(own(o, 'lastName'), own(o, 'firstName'));
    const host = cleanText(own(o, 'host'), 'L’accompagnateur', MAX_HOST, true);
    const reason = cleanText(own(o, 'reason'), 'Le motif', MAX_REASON, false);
    const number = cleanBadgeNumber(own(o, 'badge'));
    const groupId = positiveInt(own(o, 'groupId'), 'Le groupe');
    const minutes = own(o, 'durationMinutes');
    if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes < VISITOR_MIN_MINUTES || minutes > VISITOR_MAX_MINUTES) {
      throw bad(`La durée de la visite doit être un nombre entier de minutes, de ${VISITOR_MIN_MINUTES} à ${VISITOR_MAX_MINUTES} (31 jours).`);
    }
    return write(() => {
      const g = one('SELECT for_visitors FROM access_group WHERE id = ?', groupId) as { for_visitors: number } | undefined;
      if (!g) throw bad(`Le groupe n°${groupId} n’existe pas.`);
      if (g.for_visitors !== 1) throw bad('Ce groupe n’est pas réservé aux visiteurs : choisissez un groupe « visiteurs ».');
      if (countHolders() >= MAX_HOLDERS) throw new PsimError(409, `Le nombre maximal de titulaires (${MAX_HOLDERS}) est atteint : supprimez des fiches inutiles.`);
      const t = now();
      const id = run(
        `INSERT INTO access_holder (last_name, first_name, name_key, external_ref, kind, status, valid_from, valid_to, visitor_host, visitor_reason, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, NULL, 'visitor', 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
        names.lastName, names.firstName, keyOf(names.lastName, names.firstName), t, t + minutes * 60_000, host, reason, t, actor, t, actor,
      ).id;
      run('INSERT INTO access_holder_group (holder_id, group_id) VALUES (?, ?)', id, groupId);
      const badgeId = insertBadge(id, number, actor, t);
      log(actor, 'access_visitor_created', `H${id} : badge B${badgeId}, groupe G${groupId}, ${minutes} min`);
      const r = mustHolder(id);
      return { value: visitorView(viewsOf([r])[0] as HolderView, r, t), touched: controllersOfHolder(id) };
    });
  }

  /** Termine une visite : fin posee, badges rendus. Renvoie les controleurs a prevenir. */
  function finishVisit(holderId: number, endedAt: number, actor: string, details: string): string[] {
    const touched = controllersOfHolder(holderId);
    const t = now();
    run('UPDATE access_holder SET ended_at = ?, updated_at = ?, updated_by = ? WHERE id = ?', endedAt, t, actor, holderId);
    run("UPDATE access_badge SET state = 'returned', state_at = ?, state_by = ? WHERE holder_id = ? AND state <> 'returned'", t, actor, holderId);
    log(actor, 'access_visitor_ended', `H${holderId} : ${details}`);
    return touched;
  }

  function endVisitor(actor: string, holderId: number): VisitorView {
    const hid = holderIdOf(holderId);
    return write(() => {
      const r = mustHolder(hid);
      if (r.kind !== 'visitor') throw new PsimError(404, 'Visiteur introuvable');
      if (r.ended_at !== null) throw new PsimError(409, 'La visite de ce visiteur est déjà terminée.');
      const t = now();
      const touched = finishVisit(hid, Math.min(t, r.valid_to ?? t), actor, 'badge rendu');
      const after = mustHolder(hid);
      return { value: visitorView(viewsOf([after])[0] as HolderView, after, t), touched };
    });
  }

  // ---- Rattachement des passages ---------------------------------------------------------------------------------------------

  function resolve(credential: string | null, holderRef: string | null): { id: number; name: string } | null {
    try {
      if (typeof holderRef === 'string') {
        const m = HOLDER_REF_PATTERN.exec(holderRef);
        if (m) {
          const r = one('SELECT id, last_name, first_name FROM access_holder WHERE id = ?', Number(m[1]));
          if (r) return { id: r.id as number, name: clip(displayOf(r.last_name as string, r.first_name as string), MAX_SENT_NAME) };
        }
      }
      if (typeof credential === 'string' && credential !== '' && credential.length <= 32) {
        const r = one(
          "SELECT h.id, h.last_name, h.first_name FROM access_badge b JOIN access_holder h ON h.id = b.holder_id WHERE b.number = ? AND b.state <> 'returned'",
          credential,
        );
        if (r) return { id: r.id as number, name: clip(displayOf(r.last_name as string, r.first_name as string), MAX_SENT_NAME) };
      }
    } catch {
      // Un passage ne doit jamais etre perdu a cause du rattachement.
    }
    return null;
  }

  // ---- Temps : fin des visites, purge ----------------------------------------------------------------------------------------

  let lastTick: number | null = null;

  function retentionDays(): number {
    const days = opts.retentionDays?.();
    return typeof days === 'number' && Number.isFinite(days) && days >= 1 ? days : DEFAULT_RETENTION_DAYS;
  }

  function tick(): void {
    try {
      const t = now();
      // Garde-fou : au plus un passage toutes les 5 secondes ; une horloge qui recule relance le controle.
      if (lastTick !== null && t >= lastTick && t - lastTick < TICK_MIN_INTERVAL_MS) return;
      lastTick = t;
      const expired = all(
        "SELECT id, valid_to FROM access_holder WHERE kind = 'visitor' AND ended_at IS NULL AND valid_to IS NOT NULL AND valid_to <= ? ORDER BY valid_to LIMIT ?",
        t, TICK_BATCH,
      );
      if (expired.length > 0) {
        write(() => {
          const touched = new Set<string>();
          for (const r of expired) for (const c of finishVisit(r.id as number, Math.min(t, r.valid_to as number), 'systeme', 'visite échue, badge rendu')) touched.add(c);
          return { value: undefined, touched };
        });
      }
      const cutoff = t - retentionDays() * DAY_MS;
      const old = all("SELECT id FROM access_holder WHERE kind = 'visitor' AND ended_at IS NOT NULL AND ended_at < ? ORDER BY id LIMIT ?", cutoff, TICK_BATCH);
      if (old.length > 0) {
        write(() => {
          for (const r of old) deleteHolderRows(r.id as number);
          log('systeme', 'access_holder_deleted', `purge : ${old.length} fiche(s) de visiteur terminée(s) depuis plus de ${retentionDays()} jour(s) (${old.slice(0, 5).map((r) => `H${r.id as number}`).join(', ')}${old.length > 5 ? ', …' : ''})`);
          return { value: undefined };
        });
      }
    } catch (err) {
      console.error('[accessholders] tick :', err);
    }
  }

  // ---- Droits : contenu attendu d'un controleur ------------------------------------------------------------------------------

  function desired(controllerId: string): DesiredState {
    const t = now();
    // Titulaire x porte de CE controleur x horaire. Un visiteur dont la visite est terminee ou echue n'y figure pas.
    const rows = all(
      `SELECT h.id, h.last_name, h.first_name, h.status, h.valid_from, h.valid_to, ad.door_no, gd.schedule_id
         FROM access_door ad
         JOIN access_group_door gd ON gd.door_id = ad.detector_id
         JOIN access_holder_group hg ON hg.group_id = gd.group_id
         JOIN access_holder h ON h.id = hg.holder_id
        WHERE ad.controller_id = ?
          AND NOT (h.kind = 'visitor' AND (h.ended_at IS NOT NULL OR (h.valid_to IS NOT NULL AND h.valid_to <= ?)))
        ORDER BY h.id, ad.door_no, gd.schedule_id`,
      controllerId, t,
    );
    const byHolder = new Map<number, { row: Row; doors: Map<number, number> }>();
    for (const r of rows) {
      const id = r.id as number;
      const entry = byHolder.get(id) ?? { row: r, doors: new Map<number, number>() };
      const doorNo = r.door_no as number;
      // Deux groupes aux horaires differents pour une meme porte sont refuses a l'ecriture ; si la base en contient un quand meme, le plus petit gagne.
      if (!entry.doors.has(doorNo)) entry.doors.set(doorNo, r.schedule_id as number);
      byHolder.set(id, entry);
    }
    const credentials = new Map<number, string[]>();
    if (byHolder.size > 0) {
      for (const b of all(
        `SELECT b.holder_id, b.number FROM access_badge b
          WHERE b.state = 'active' AND b.holder_id IN (
            SELECT hg.holder_id FROM access_holder_group hg
              JOIN access_group_door gd ON gd.group_id = hg.group_id
              JOIN access_door ad ON ad.detector_id = gd.door_id
             WHERE ad.controller_id = ?)`,
        controllerId,
      )) {
        const list = credentials.get(b.holder_id as number) ?? [];
        list.push(b.number as string);
        credentials.set(b.holder_id as number, list);
      }
    }
    const usedSchedules = new Set<number>();
    const holders: DesiredHolder[] = [...byHolder.keys()].sort((a, b) => a - b).map((id) => {
      const { row, doors } = byHolder.get(id) as { row: Row; doors: Map<number, number> };
      for (const s of doors.values()) usedSchedules.add(s);
      return {
        ref: `H${id}`,
        name: [...displayOf(row.last_name as string, row.first_name as string)].slice(0, MAX_SENT_NAME).join(''),
        active: row.status === 'active',
        validFrom: (row.valid_from as number | null) ?? null,
        validTo: (row.valid_to as number | null) ?? null,
        credentials: [...(credentials.get(id) ?? [])].sort().slice(0, MAX_ACTIVE_BADGES),
        doors: [...doors.entries()].sort((a, b) => a[0] - b[0]).map(([doorNo, scheduleId]) => ({ doorNo, scheduleRef: `S${scheduleId}` })),
      };
    });
    const schedulesOut: DesiredSchedule[] = [...usedSchedules].sort((a, b) => a - b).flatMap((id) => {
      const s = one('SELECT windows, closed_on_holidays FROM access_schedule WHERE id = ?', id);
      return s ? [{ ref: `S${id}`, windows: parseWindows(s.windows as string), holidays: s.closed_on_holidays === 1 }] : [];
    });
    // Jours feries depuis le 1er janvier de l'annee courante (heure locale du serveur).
    const year = new Date(t).getFullYear();
    const from = `${String(year).padStart(4, '0')}-01-01`;
    const days = all('SELECT date FROM access_holiday WHERE date >= ? ORDER BY date LIMIT ?', from, MAX_HOLIDAYS).map((r) => r.date as string);
    return { holders, schedules: schedulesOut, holidays: days };
  }

  const controllerIds = (): string[] => allControllerIds();

  function subscribe(listener: RightsListener): void {
    listeners.push(listener);
  }

  return {
    controllerIds, desired, subscribe,
    list, get, create, update, remove, findByExternalRef, findByBadge, findByName,
    photo, setPhoto, clearPhoto,
    addBadge, setBadgeState, removeBadge,
    groups, group, createGroup, updateGroup, deleteGroup, groupByName,
    schedules, schedule, createSchedule, updateSchedule, deleteSchedule,
    holidays, setHolidays,
    visitors, createVisitor, endVisitor,
    resolve, tick, batch, simulate,
  };
}
