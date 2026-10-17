/**
 * Controle d'acces : journal des passages, portes, controleurs (lot AC2). Contrats : docs/ACCES.md (§ 2, 3, 4),
 * docs/CONTROLE-ACCES.md (§ 1, 2, 4), docs/PRD-CONTROLE-ACCES.md.
 *
 * Principe : une PORTE est un detecteur PSIM de categorie `access` ; le controleur decide seul d'ouvrir ou non pour un badge, le
 * PSIM enregistre (journal des passages), affiche (etat des portes) et alerte (porte forcee, maintenue ouverte). Rien ici ne
 * commande une serrure.
 *
 * Trois parties :
 *  - le POINT D'ACCROCHE du moteur (`onMessage`, appele par engine.ts dans `ingest`, APRES `interpret` et AVANT `applyReading`) :
 *    valide le champ `access`, enregistre le passage (deduplication definitive), suit l'etat physique de la porte ;
 *  - l'ESCALADE (`tick`, une fois par seconde) : une porte maintenue ouverte devient une alarme apres son delai, sans jamais
 *    rajeunir `last_seen` (une porte muette doit pouvoir passer hors ligne) ; la purge suit la duree de conservation ;
 *  - le SERVICE (portes, recherche, export CSV, controleurs, reglages) que les routes `/api/access/*` appellent.
 *
 * Donnees personnelles : numeros de badge et noms. Aucun code PIN ni gabarit biometrique n'est jamais lu ni stocke : seuls les
 * champs listes dans validateAccessField() sont gardes, tout champ inconnu est ignore.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { PsimError } from './errors.ts';
import { defaultFloorId } from './floors.ts';
import { LATE_AFTER_MS } from './ingestmeta.ts';
import type { MessageMeta } from './ingestmeta.ts';
import { toCsv, fmtDateTime } from './reports.ts';
import { seal } from './secrets.ts';
import { hasForbiddenChar, normalizeName } from './text.ts';
import type { DetectorState, Device } from './types.ts';
import { HOST_PATTERN } from './video.ts';

// ---- Vocabulaire du contrat (docs/CONTROLE-ACCES.md § 2) ---------------------------------------------------------------

export const ACCESS_METHODS = ['badge', 'code', 'fingerprint', 'face', 'exit_button', 'remote', 'unknown'] as const;
export const ACCESS_REASONS = ['unknown_credential', 'expired', 'out_of_schedule', 'disabled', 'wrong_pin', 'antipassback', 'door_locked', 'other'] as const;
export const DOOR_KINDS = ['door', 'gate', 'barrier', 'turnstile'] as const;
export const CONTROLLER_BRANDS = ['dahua', 'zkteco', 'relay'] as const;

export type AccessMethod = (typeof ACCESS_METHODS)[number];
export type AccessReason = (typeof ACCESS_REASONS)[number];
export type AccessResult = 'granted' | 'denied';
export type AccessDirection = 'in' | 'out';
export type DoorKind = (typeof DOOR_KINDS)[number];
export type ControllerBrand = (typeof CONTROLLER_BRANDS)[number];
/** Etat physique de la porte (sans la supervision). */
export type DoorPhysical = 'closed' | 'open' | 'unknown';
/** Etat affiche (F2). */
export type DoorDisplay = 'closed' | 'open' | 'forced' | 'held_open' | 'offline' | 'fault' | 'unknown';

const METHOD_LABEL: Readonly<Record<AccessMethod, string>> = {
  badge: 'Badge',
  code: 'Code',
  fingerprint: 'Empreinte',
  face: 'Visage',
  exit_button: 'Bouton de sortie',
  remote: 'Ouverture à distance',
  unknown: 'Inconnue',
};

const REASON_LABEL: Readonly<Record<AccessReason, string>> = {
  unknown_credential: 'badge inconnu',
  expired: 'badge expiré',
  out_of_schedule: 'hors des horaires',
  disabled: 'badge désactivé',
  wrong_pin: 'code erroné',
  antipassback: 'anti-retour',
  door_locked: 'porte verrouillée',
  other: '',
};

export const methodLabel = (m: string): string => (Object.hasOwn(METHOD_LABEL, m) ? METHOD_LABEL[m as AccessMethod] : METHOD_LABEL.unknown);

/** « Accepté », « Refusé — badge inconnu », « Refusé » (docs/ACCES.md § 3.1). */
export function resultLabel(result: string, reason: string | null): string {
  if (result === 'granted') return 'Accepté';
  const why = reason !== null && Object.hasOwn(REASON_LABEL, reason) ? REASON_LABEL[reason as AccessReason] : '';
  return why ? `Refusé — ${why}` : 'Refusé';
}

// ---- Limites ---------------------------------------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,40}$/;
const MAX_CREDENTIAL = 32;
const MAX_HOLDER_NAME = 64;
const MAX_HOLDER_REF = 32;
const MAX_NAME = 80;
const MAX_MODEL = 40;
const MAX_SECRET = 128;
const DAY_MS = 86_400_000;
/** Un `ts` plus de 24 h dans le futur n'est pas garde tel quel (il rendrait la ligne impossible a purger) : heure d'arrivee. */
const FUTURE_KEEP_MS = DAY_MS;
export const DEFAULT_RETENTION_DAYS = 90;
export const MIN_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 3650;
export const DEFAULT_HELD_ALARM_S = 300;
const MIN_HELD_ALARM_S = 10;
const MAX_HELD_ALARM_S = 86_400;
export const SEARCH_DEFAULT_LIMIT = 50;
export const SEARCH_MAX_LIMIT = 200;
export const SEARCH_TOTAL_CAP = 10_000;
export const EXPORT_MAX_ROWS = 100_000;
export const PURGE_BATCH = 10_000;
export const PURGE_MAX_ROWS = 200_000;
/**
 * Purge automatique de `tick()` : un controle par heure ; tant qu'il reste des lignes echues (apres une baisse de la duree de
 * conservation par exemple), UN lot de 10 000 toutes les 5 secondes, pour ne jamais monopoliser la boucle de controle du PSIM.
 */
const AUTO_PURGE_EVERY_MS = 3_600_000;
const AUTO_PURGE_BACKLOG_PAUSE_MS = 5_000;
/** Recherche par debut de badge : au-dela de ce nombre de passages pour le prefixe, on parcourt le temps (pas de tri de milliers de lignes). */
const PREFIX_SORT_MAX = 5000;
const SEARCH_LOG_EVERY_MS = 60_000;
const AUDIT_DETAILS_MAX = 120;

// ---- Types publics -----------------------------------------------------------------------------------------------------

export interface AccessHookInput {
  device: Device;
  payload: unknown;
  event: string | null;
  state: DetectorState | null;
  meta: MessageMeta;
}
export type AccessHookResult = { ok: true; duplicate?: true } | { ok: false; status: number; error: string };
/** Point d'accroche appele par le moteur (engine.ts, option `access`). */
export interface AccessHook {
  onMessage(input: AccessHookInput): AccessHookResult;
}

/** Champ `access` d'un message de passage, apres validation (rien d'autre n'est garde). */
export interface AccessField {
  controllerId: string;
  eventId: string;
  direction: AccessDirection | null;
  credential: string | null;
  holderName: string | null;
  holderRef: string | null;
  method: AccessMethod;
  result: AccessResult;
  reason: AccessReason | null;
  deferred: boolean;
}

export interface ControllerView {
  id: string;
  name: string;
  brand: ControllerBrand;
  model: string | null;
  host: string | null;
  gatewayId: string | null;
  hasCredentials: boolean;
  clockOffsetMs: number | null;
  lastSeen: number | null;
  doorCount: number;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
}

export interface DoorView {
  detectorId: string;
  name: string;
  zone: string;
  floorId: number;
  x: number;
  y: number;
  controllerId: string;
  controllerName: string;
  doorNo: number;
  kind: DoorKind;
  emergencyExit: boolean;
  heldAlarmAfterS: number;
  actuatorId: string | null;
  state: DoorDisplay;
  stateLabel: string;
  stateHint: string;
  stateSince: number | null;
  doorState: DoorPhysical;
  deviceStatus: string;
  lastSeen: number | null;
  lastPassageAt: number | null;
  cameraIds: string[];
}

export interface PassageView {
  id: number;
  doorId: string;
  doorName: string | null;
  controllerId: string;
  eventId: string;
  atDevice: number;
  atReceived: number;
  direction: AccessDirection | null;
  credential: string | null;
  holderName: string | null;
  holderRef: string | null;
  method: AccessMethod;
  methodLabel: string;
  result: AccessResult;
  reason: AccessReason | null;
  resultLabel: string;
  late: boolean;
}

export interface DoorDetail {
  door: DoorView;
  lastPassages: PassageView[];
  cameras: { id: string; name: string; status: string }[];
  remote: { available: false; reason: string };
}

/** Filtres de recherche tels que la route les recoit (chaines de la requete, ou valeurs deja typees) : tout est valide ici. */
export interface SearchFilters {
  from?: unknown;
  to?: unknown;
  door?: unknown;
  holder?: unknown;
  credential?: unknown;
  result?: unknown;
  late?: unknown;
  limit?: unknown;
  cursor?: unknown;
  count?: unknown;
}

export interface SearchResult {
  items: PassageView[];
  nextCursor: string | null;
  /** `null` si le total n'a pas ete demande (`count=1`). */
  total: number | null;
  /** Vrai : « plus de 10 000 » (le total est alors plafonne). */
  totalCapped: boolean;
}

export interface ExportResult {
  csv: string;
  rows: number;
  /** Vrai : la selection depassait EXPORT_MAX_ROWS lignes (en-tete `X-Export-Truncated: 1`). */
  truncated: boolean;
}

export interface AccessSettings {
  retentionDays: number;
  defaultDays: number;
  eventCount: number;
  oldestAt: number | null;
  lastPurge: { at: number; deleted: number; before: number } | null;
}

export interface ControllerInput {
  id?: unknown;
  name?: unknown;
  brand?: unknown;
  model?: unknown;
  host?: unknown;
  gatewayId?: unknown;
  /** `{ username, password }` : ECRITURE SEULE (jamais relu). `null` = effacement (modification seulement). */
  credentials?: unknown;
}

export interface DoorInput {
  detectorId?: unknown;
  controllerId?: unknown;
  doorNo?: unknown;
  kind?: unknown;
  emergencyExit?: unknown;
  heldAlarmAfterS?: unknown;
  actuatorId?: unknown;
}

export interface AccessOptions {
  db: DatabaseSync;
  /** Horloge injectee (tests). */
  now?: () => number;
  /** Cle de server/secrets.ts : scelle les identifiants des controleurs. */
  key: Buffer;
  audit: (actor: string, action: string, ref?: { deviceId?: string; details?: string }) => void;
  /** Changement d'etat decide par le PSIM (escalade) : ne touche pas last_seen. Faux si le detecteur n'existe pas. */
  setDeviceState: (deviceId: string, state: 'alarm', event: string) => boolean;
  /** Duree de conservation par defaut (jours, 7 a 3650) ; 90 si absente. Un reglage enregistre en base la remplace. */
  retentionDays?: number;
  /** Reglages d'essai de la purge (par defaut : lots de 10 000, 200 000 lignes au plus par appel). */
  purgeBatch?: number;
  purgeMaxRows?: number;
}

export interface AccessService extends AccessHook {
  /** Escalade des portes maintenues ouvertes, puis purge automatique (un lot par controle, voir AUTO_PURGE_*). A appeler chaque seconde. Ne leve jamais. */
  tick(): void;
  /** Supprime les passages plus vieux que la duree de conservation, par lots de 10 000 (au plus 200 000 par appel). */
  purge(): { deleted: number; remaining: number };
  doors(): DoorView[];
  /** Fiche d'une porte DECLAREE (404 sinon). */
  door(id: string): DoorDetail;
  /** Recherche paginee ; `actor` : auteur, pour le journal des recherches par titulaire ou badge. */
  search(filters: SearchFilters, actor: string): SearchResult;
  exportCsv(filters: SearchFilters, actor: string): ExportResult;
  controllers(): ControllerView[];
  controller(id: string): ControllerView;
  createController(actor: string, input: ControllerInput): ControllerView;
  updateController(actor: string, id: string, input: ControllerInput): ControllerView;
  deleteController(actor: string, id: string): void;
  declareDoor(actor: string, input: DoorInput): DoorView;
  updateDoor(actor: string, id: string, input: DoorInput): DoorView;
  removeDoor(actor: string, id: string): void;
  settings(): AccessSettings;
  setRetention(actor: string, days: unknown): AccessSettings;
}

// ---- Schema --------------------------------------------------------------------------------------------------------------

/**
 * Migration : `CREATE TABLE / INDEX IF NOT EXISTS` seulement (appelee par openDb). Pas de cle etrangere sur access_event :
 * l'historique des passages survit a la suppression d'une porte ou d'un controleur, jusqu'a la purge.
 */
export function migrateAccess(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS access_controller (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT NOT NULL CHECK (brand IN ('dahua', 'zkteco', 'relay')),
  model TEXT,
  host TEXT,
  gateway_id TEXT,
  -- Identifiants scelles (secrets.ts), ECRITURE SEULE : jamais dans une vue, un journal ou un message d'erreur.
  credentials_sealed TEXT,
  clock_offset_ms INTEGER,
  last_seen INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
-- Une porte = un detecteur PSIM de categorie access. held_since / held_escalated_at / forced_at : suivi de l'alarme « maintenue
-- ouverte » (escaladee par le PSIM, sans toucher last_seen) et de la porte forcee.
CREATE TABLE IF NOT EXISTS access_door (
  detector_id TEXT PRIMARY KEY REFERENCES device(id) ON DELETE CASCADE,
  controller_id TEXT NOT NULL REFERENCES access_controller(id),
  door_no INTEGER NOT NULL CHECK (door_no BETWEEN 1 AND 4),
  kind TEXT NOT NULL DEFAULT 'door' CHECK (kind IN ('door', 'gate', 'barrier', 'turnstile')),
  emergency_exit INTEGER NOT NULL DEFAULT 0,
  held_alarm_after_s INTEGER NOT NULL DEFAULT 300,
  actuator_id TEXT,
  door_state TEXT NOT NULL DEFAULT 'unknown' CHECK (door_state IN ('closed', 'open', 'unknown')),
  door_state_at INTEGER,
  last_passage_at INTEGER,
  held_since INTEGER,
  held_escalated_at INTEGER,
  forced_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS access_door_by_controller ON access_door(controller_id, door_no);
-- holder_key : nom en minuscules, sans accents (recherche insensible aux accents). holder_id : phase 2 (titulaires).
CREATE TABLE IF NOT EXISTS access_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  door_id TEXT NOT NULL,
  controller_id TEXT NOT NULL,
  at_device INTEGER NOT NULL,
  at_received INTEGER NOT NULL,
  direction TEXT,
  credential TEXT,
  holder_name TEXT,
  holder_key TEXT,
  holder_ref TEXT,
  holder_id INTEGER,
  method TEXT NOT NULL,
  result TEXT NOT NULL,
  reason TEXT,
  device_event_id TEXT NOT NULL,
  late INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS access_event_by_device_event ON access_event(controller_id, device_event_id);
CREATE INDEX IF NOT EXISTS access_event_by_time ON access_event(at_device);
CREATE INDEX IF NOT EXISTS access_event_by_door ON access_event(door_id, at_device);
CREATE INDEX IF NOT EXISTS access_event_by_credential ON access_event(credential, at_device);
CREATE TABLE IF NOT EXISTS access_setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);
}

// ---- Validation du champ `access` -----------------------------------------------------------------------------------------

/** Surrogate isole (UTF-16 mal forme) : refuse, il ne se stocke pas proprement en UTF-8. */
const hasLoneSurrogate = (s: string): boolean => /\p{Cs}/u.test(s);
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Lecture d'une propriete PROPRE : jamais celle d'un prototype (`__proto__`, `constructor`...). */
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

/** Chaine du message d'un equipement : longueur bornee AVANT tout autre controle (une chaine de 100 Ko est refusee a bas cout). */
function checkString(value: unknown, field: string, max: number): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || value.length > max * 4) return { ok: false, error: `${field} invalide (texte de ${max} caracteres au plus)` };
  if (hasLoneSurrogate(value) || hasForbiddenChar(value)) return { ok: false, error: `${field} invalide (caracteres de controle ou invisibles interdits)` };
  const text = normalizeName(value);
  if (text.length > max) return { ok: false, error: `${field} invalide (${max} caracteres au plus)` };
  return { ok: true, value: text === '' ? null : text };
}

/**
 * Valide STRICTEMENT le champ `access` d'un message de passage (docs/CONTROLE-ACCES.md § 2). Un champ inconnu est ignore (jamais
 * stocke) ; un champ de mauvais type, hors liste ou hors format est refuse avec la raison. Les champs facultatifs absents valent
 * `null` (`deferred` : faux).
 */
export function validateAccessField(raw: unknown): { ok: true; value: AccessField } | { ok: false; error: string } {
  if (!isPlainObject(raw)) return { ok: false, error: 'access doit etre un objet' };
  if (own(raw, 'v') !== 1) return { ok: false, error: 'access.v doit valoir 1' };
  const controllerId = own(raw, 'controllerId');
  if (typeof controllerId !== 'string' || !ID_PATTERN.test(controllerId)) return { ok: false, error: 'access.controllerId invalide (lettres, chiffres, - et _ ; 32 caracteres max)' };
  const eventId = own(raw, 'eventId');
  if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId)) return { ok: false, error: 'access.eventId invalide (lettres, chiffres, . _ : - ; 40 caracteres max)' };
  const dir = own(raw, 'direction');
  if (dir !== undefined && dir !== null && dir !== 'in' && dir !== 'out') return { ok: false, error: 'access.direction doit etre in, out ou null' };
  const method = own(raw, 'method');
  if (typeof method !== 'string' || !(ACCESS_METHODS as readonly string[]).includes(method)) return { ok: false, error: `access.method invalide (${ACCESS_METHODS.join(', ')})` };
  const result = own(raw, 'result');
  if (result !== 'granted' && result !== 'denied') return { ok: false, error: 'access.result doit etre granted ou denied' };
  const reason = own(raw, 'reason');
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || !(ACCESS_REASONS as readonly string[]).includes(reason))) return { ok: false, error: `access.reason invalide (null ou ${ACCESS_REASONS.join(', ')})` };
  const deferred = own(raw, 'deferred');
  if (deferred !== undefined && typeof deferred !== 'boolean') return { ok: false, error: 'access.deferred doit etre un booleen' };
  const credential = checkString(own(raw, 'credential'), 'access.credential', MAX_CREDENTIAL);
  if (!credential.ok) return credential;
  const holderName = checkString(own(raw, 'holderName'), 'access.holderName', MAX_HOLDER_NAME);
  if (!holderName.ok) return holderName;
  const holderRef = checkString(own(raw, 'holderRef'), 'access.holderRef', MAX_HOLDER_REF);
  if (!holderRef.ok) return holderRef;
  return {
    ok: true,
    value: {
      controllerId,
      eventId,
      direction: (dir ?? null) as AccessDirection | null,
      credential: credential.value,
      holderName: holderName.value,
      holderRef: holderRef.value,
      method: method as AccessMethod,
      result,
      // Une raison n'a de sens que pour un refus : fournie sur un passage accepte, elle est ignoree ; absente sur un refus, « other ».
      reason: result === 'granted' ? null : ((reason ?? 'other') as AccessReason),
      deferred: deferred === true,
    },
  };
}

/** Nom pour la recherche : minuscules, sans accents (« Noël » -> « noel »), formes composees ramenees a une seule. */
export function holderKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/ø/g, 'o')
    .replace(/ł/g, 'l')
    .replace(/đ/g, 'd');
}

// ---- Etat affiche (F2) -----------------------------------------------------------------------------------------------------

export interface DisplayInput {
  /** Statut du detecteur (`device.status`). */
  deviceStatus: string;
  doorState: DoorPhysical;
  /** Une alarme « porte forcee » est en cours. */
  forced: boolean;
  /** La porte est signalee maintenue ouverte. */
  heldOpen: boolean;
}

const DISPLAY: Readonly<Record<DoorDisplay, { label: string; hint: string }>> = {
  offline: {
    label: 'Hors ligne',
    hint: "Le PSIM n'a plus de nouvelles de cette porte. Les badges fonctionnent toujours sur place. Faites vérifier l'alimentation et le réseau du contrôleur.",
  },
  fault: {
    label: 'En défaut',
    hint: "L'équipement signale une panne. La porte peut ne plus réagir normalement : faites vérifier le contrôleur et le lecteur.",
  },
  forced: {
    label: 'Forcée',
    hint: "La porte s'est ouverte sans autorisation. Regardez la caméra, puis traitez l'alarme.",
  },
  held_open: {
    label: 'Maintenue ouverte',
    hint: "Quelqu'un retient la porte ouverte. Regardez la caméra et faites refermer la porte ; passé le délai de la porte, l'alarme se déclenche.",
  },
  open: {
    label: 'Ouverte',
    hint: "Un passage est en cours. Rien à faire, sauf si la porte reste ouverte trop longtemps.",
  },
  closed: {
    label: 'Fermée',
    hint: 'La porte est fermée. Rien à faire.',
  },
  unknown: {
    label: 'État inconnu',
    hint: "Le PSIM ne sait pas si la porte est ouverte ou fermée (aucune information reçue, ou perdue après une coupure). L'état se mettra à jour au prochain événement ; au besoin, vérifiez la porte sur place.",
  },
};

const HELD_ALARM_HINT = "La porte est restée ouverte au-delà du délai : l'alarme est déclenchée. Regardez la caméra, faites refermer la porte, puis traitez l'alarme.";

/**
 * Etat affiche d'une porte, par priorite : hors ligne > en defaut > forcee > maintenue ouverte > ouverte > fermee (> inconnu).
 * Une porte dont le controleur se tait est « hors ligne », jamais « fermee ». Fonction pure.
 */
export function displayState(input: DisplayInput): { state: DoorDisplay; label: string; hint: string } {
  let state: DoorDisplay;
  if (input.deviceStatus === 'offline') state = 'offline';
  else if (input.deviceStatus === 'fault') state = 'fault';
  else if (input.forced) state = 'forced';
  else if (input.heldOpen) state = 'held_open';
  else if (input.doorState === 'open') state = 'open';
  else if (input.doorState === 'closed') state = 'closed';
  else state = 'unknown';
  const { label, hint } = DISPLAY[state];
  return { state, label, hint: state === 'held_open' && input.deviceStatus === 'alarm' ? HELD_ALARM_HINT : hint };
}

// ---- Utilitaires --------------------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Param = string | number;

const NORMAL_EVENTS: ReadonlySet<string> = new Set(['normal', 'clear', 'restored', 'alarm_reset']);

/** Texte limite a `max` caracteres (sur des points de code : jamais une paire de substitution coupee en deux). */
function clip(text: string, max = AUDIT_DETAILS_MAX): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);
const isoDate = (ms: number): string => new Date(ms).toISOString();

interface DoorRow {
  detector_id: string;
  controller_id: string;
  door_no: number;
  kind: DoorKind;
  emergency_exit: number;
  held_alarm_after_s: number;
  actuator_id: string | null;
  door_state: DoorPhysical;
  door_state_at: number | null;
  last_passage_at: number | null;
  held_since: number | null;
  held_escalated_at: number | null;
  forced_at: number | null;
}

interface Filters {
  from: number | null;
  to: number | null;
  door: string | null;
  holder: string | null;
  credential: string | null;
  result: AccessResult | null;
  late: boolean;
}

export function createAccess(opts: AccessOptions): AccessService {
  const { db, key, audit } = opts;
  const now = opts.now ?? Date.now;
  const defaultDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const purgeBatch = opts.purgeBatch ?? PURGE_BATCH;
  const purgeMaxRows = opts.purgeMaxRows ?? PURGE_MAX_ROWS;
  if (!Number.isInteger(defaultDays) || defaultDays < MIN_RETENTION_DAYS || defaultDays > MAX_RETENTION_DAYS) {
    throw new Error(`Duree de conservation du journal des acces invalide (${MIN_RETENTION_DAYS} a ${MAX_RETENTION_DAYS} jours)`);
  }
  migrateAccess(db); // sans effet si openDb l'a deja fait : l'instance reste utilisable sur une base ouverte autrement

  // Requetes preparees gardees (le cout d'ingestion d'un passage en depend) ; les formes dynamiques de la recherche sont bornees.
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

  /** Plusieurs ecritures en un seul commit (un seul fsync), imbricable dans une transaction en cours. */
  function atomically<T>(fn: () => T): T {
    db.exec('SAVEPOINT access_work');
    try {
      const result = fn();
      db.exec('RELEASE access_work');
      return result;
    } catch (err) {
      db.exec('ROLLBACK TO access_work');
      db.exec('RELEASE access_work');
      throw err;
    }
  }

  function getSetting(name: string): string | null {
    const r = sql('SELECT value FROM access_setting WHERE key = ?').get(name) as { value: string } | undefined;
    return r ? r.value : null;
  }
  function setSetting(name: string, value: string): void {
    sql('INSERT INTO access_setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(name, value);
  }

  function retentionDays(): number {
    const stored = Number(getSetting('retention_days'));
    return Number.isInteger(stored) && stored >= MIN_RETENTION_DAYS && stored <= MAX_RETENTION_DAYS ? stored : defaultDays;
  }

  // ---- Point d'accroche du moteur ------------------------------------------------------------------------------------------

  const refuse = (status: number, error: string): AccessHookResult => ({ ok: false, status, error });

  function onMessage(input: AccessHookInput): AccessHookResult {
    const { device, payload, event, state, meta } = input;
    const msg = isPlainObject(payload) ? payload : null;
    const carriesAccess = msg !== null && Object.hasOwn(msg, 'access');
    if (device.category !== 'access') {
      return carriesAccess ? refuse(400, "Ce detecteur n'est pas de categorie « Controle d'acces » : le champ access est refuse") : { ok: true };
    }

    // 1. Passage : validation stricte, avant toute ecriture.
    let passage: AccessField | null = null;
    let atDevice = 0;
    if (carriesAccess) {
      const parsed = validateAccessField(msg!.access);
      if (!parsed.ok) return refuse(400, parsed.error);
      passage = parsed.value;
      if (!meta.dated) return refuse(400, "ts requis pour un passage (heure du controleur, en millisecondes depuis 1970)");
      const expected = passage.result === 'granted' ? 'badge_granted' : 'badge_denied';
      if (event !== expected) return refuse(400, `event doit etre ${expected} pour un passage ${passage.result === 'granted' ? 'accepte' : 'refuse'}`);
      // `ts` brut du controleur (valide par readMeta : entier sur) ; trop loin dans le futur, l'heure d'arrivee.
      const ts = msg!.ts as number;
      atDevice = ts > meta.receivedAt + FUTURE_KEEP_MS ? meta.eventAt : ts;
    }

    const door = sql('SELECT * FROM access_door WHERE detector_id = ?').get(device.id) as DoorRow | undefined;
    if (passage && door && door.controller_id !== passage.controllerId) {
      return refuse(400, "Ce passage vient d'un autre controleur que celui declare pour cette porte");
    }

    return atomically((): AccessHookResult => {
      // 2. Enregistrement du passage ; deduplication definitive par l'index unique (controleur, evenement).
      if (passage) {
        const res = sql(
          `INSERT INTO access_event (door_id, controller_id, at_device, at_received, direction, credential, holder_name, holder_key, holder_ref, method, result, reason, device_event_id, late)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(controller_id, device_event_id) DO NOTHING`,
        ).run(
          device.id, passage.controllerId, atDevice, meta.receivedAt, passage.direction, passage.credential, passage.holderName,
          passage.holderName === null ? null : holderKey(passage.holderName), passage.holderRef, passage.method, passage.result, passage.reason,
          passage.eventId, passage.deferred || meta.lateMs >= LATE_AFTER_MS ? 1 : 0,
        );
        if (Number(res.changes) === 0) return { ok: true, duplicate: true };
      }

      // 3. Etat physique de la porte (une porte non declaree n'a rien a mettre a jour : le passage est gardé quand meme).
      if (door) updateDoorState(door, device, event, state, meta, passage ? atDevice : null);

      // 4. Controleur : dernier signe de vie et ecart d'horloge (seulement sur un passage en direct).
      const controllerId = passage ? passage.controllerId : door && state !== 'offline' && meta.lateMs < LATE_AFTER_MS ? door.controller_id : null;
      if (controllerId !== null) {
        const live = passage !== null && !passage.deferred && meta.lateMs < LATE_AFTER_MS;
        sql('UPDATE access_controller SET last_seen = MAX(COALESCE(last_seen, 0), ?), clock_offset_ms = COALESCE(?, clock_offset_ms) WHERE id = ?').run(
          meta.receivedAt, live ? (msg!.ts as number) - meta.receivedAt : null, controllerId,
        );
      }
      return { ok: true };
    });
  }

  /**
   * Suit l'etat physique d'une porte DECLAREE d'apres le message. Un message date plus ancien que l'etat connu ne l'ecrase pas.
   * Un message qui n'est pas un evenement de porte, recu alors que le detecteur etait hors ligne, rend l'etat INCONNU : on ne dit
   * jamais « fermee » sans l'avoir su.
   */
  function updateDoorState(door: DoorRow, device: Device, event: string | null, state: DetectorState | null, meta: MessageMeta, passageAt: number | null): void {
    const at = meta.eventAt;
    const stale = meta.dated && door.door_state_at !== null && at < door.door_state_at;
    let doorState = door.door_state;
    let held = door.held_since;
    let escalated = door.held_escalated_at;
    let forced = door.forced_at;
    if (!stale) {
      const knowledgeLost = device.status === 'offline' || (event === null && state === 'offline');
      const normal = (event !== null && NORMAL_EVENTS.has(event)) || (event === null && state === 'normal');
      if (event === 'door_opened') doorState = 'open';
      else if (event === 'door_closed') {
        doorState = 'closed';
        held = escalated = forced = null;
      } else if (event === 'door_forced') {
        doorState = 'open';
        forced = forced ?? at;
      } else if (event === 'door_held_open') {
        doorState = 'open';
        held = held ?? at;
      } else {
        if (normal) held = escalated = forced = null;
        if (knowledgeLost) {
          doorState = 'unknown';
          held = escalated = forced = null;
        }
      }
    }
    const lastPassage = passageAt === null ? door.last_passage_at : Math.max(door.last_passage_at ?? 0, passageAt);
    const changed = doorState !== door.door_state || held !== door.held_since || escalated !== door.held_escalated_at || forced !== door.forced_at;
    if (!changed && lastPassage === door.last_passage_at) return;
    sql('UPDATE access_door SET door_state = ?, door_state_at = ?, held_since = ?, held_escalated_at = ?, forced_at = ?, last_passage_at = ? WHERE detector_id = ?').run(
      doorState, changed ? at : door.door_state_at, held, escalated, forced, lastPassage, door.detector_id,
    );
  }

  // ---- Escalade et purge periodique -------------------------------------------------------------------------------------------

  function escalate(t: number): void {
    const rows = sql(
      `SELECT a.detector_id AS id, a.held_since AS held_since, a.held_alarm_after_s AS after_s, a.door_state AS door_state, d.status AS status
         FROM access_door a JOIN device d ON d.id = a.detector_id
        WHERE a.held_since IS NOT NULL AND a.held_escalated_at IS NULL`,
    ).all() as Row[];
    for (const r of rows) {
      const id = r.id as string;
      const heldFor = t - (r.held_since as number);
      // Porte refermee, hors ligne ou deja en alarme : rien. Delai pas encore ecoule : rien.
      if (r.door_state === 'closed' || r.status === 'offline' || r.status === 'alarm') continue;
      if (heldFor < (r.after_s as number) * 1000) continue;
      try {
        if (!opts.setDeviceState(id, 'alarm', 'door_held_open')) continue;
        sql('UPDATE access_door SET held_escalated_at = ? WHERE detector_id = ?').run(t, id);
        audit('systeme', 'access_door_held_escalated', { deviceId: id, details: `porte maintenue ouverte depuis ${Math.round(heldFor / 1000)} s (delai ${r.after_s} s) : alarme` });
      } catch (err) {
        console.error(`[access] escalade de ${id} :`, err);
      }
    }
  }

  // Prochaine purge automatique (en memoire : un redemarrage purge des le premier controle).
  let nextAutoPurge = 0;

  function tick(): void {
    const t = now();
    try {
      escalate(t);
    } catch (err) {
      console.error('[access] escalade :', err);
    }
    // Horloge revenue en arriere de plus d'une periode : on ne reste pas bloque en attente d'un instant lointain.
    if (t >= nextAutoPurge || nextAutoPurge - t > AUTO_PURGE_EVERY_MS) {
      nextAutoPurge = t + AUTO_PURGE_EVERY_MS;
      try {
        if (purgeUpTo(purgeBatch).remaining > 0) nextAutoPurge = t + AUTO_PURGE_BACKLOG_PAUSE_MS;
      } catch (err) {
        console.error('[access] purge :', err);
      }
    }
  }

  const purge = (): { deleted: number; remaining: number } => purgeUpTo(purgeMaxRows);

  /** Supprime les passages echus, par lots de `purgeBatch`, au plus `maxRows` lignes. `remaining` : lignes echues restant a purger. */
  function purgeUpTo(maxRows: number): { deleted: number; remaining: number } {
    const t = now();
    const before = t - retentionDays() * DAY_MS;
    const del = sql('DELETE FROM access_event WHERE id IN (SELECT id FROM access_event WHERE at_device < ? ORDER BY at_device LIMIT ?)');
    let deleted = 0;
    while (deleted < maxRows) {
      const batch = Math.min(purgeBatch, maxRows - deleted);
      const n = Number(del.run(before, batch).changes);
      deleted += n;
      if (n < batch) break;
    }
    const remaining = (sql('SELECT COUNT(*) AS n FROM access_event WHERE at_device < ?').get(before) as { n: number }).n;
    if (deleted > 0) {
      setSetting('last_purge', JSON.stringify({ at: t, deleted, before }));
      audit('systeme', 'access_purge', { details: `${deleted} passage(s) supprime(s), plus anciens que le ${isoDate(before)}${remaining > 0 ? ` (${remaining} restant(s) a purger)` : ''}` });
    }
    return { deleted, remaining };
  }

  // ---- Portes ------------------------------------------------------------------------------------------------------------------

  const DOOR_SELECT = `SELECT a.*, c.name AS controller_name, d.name AS name, d.zone AS zone, d.floor_id AS floor_id, d.x AS x, d.y AS y,
                              d.status AS status, d.last_seen AS last_seen, d.state_since AS state_since
                         FROM access_door a JOIN device d ON d.id = a.detector_id JOIN access_controller c ON c.id = a.controller_id`;

  function toDoorView(r: Row, cameraIds: string[]): DoorView {
    const doorState = r.door_state as DoorPhysical;
    const shown = displayState({ deviceStatus: r.status as string, doorState, forced: r.forced_at !== null, heldOpen: r.held_since !== null });
    const since =
      shown.state === 'offline' || shown.state === 'fault' ? (r.state_since as number | null) : shown.state === 'forced' ? (r.forced_at as number) : shown.state === 'held_open' ? (r.held_since as number) : (r.door_state_at as number | null);
    return {
      detectorId: r.detector_id as string,
      name: r.name as string,
      zone: r.zone as string,
      floorId: (r.floor_id as number | null) ?? defaultFloorId(db),
      x: r.x as number,
      y: r.y as number,
      controllerId: r.controller_id as string,
      controllerName: r.controller_name as string,
      doorNo: r.door_no as number,
      kind: r.kind as DoorKind,
      emergencyExit: r.emergency_exit === 1,
      heldAlarmAfterS: r.held_alarm_after_s as number,
      actuatorId: (r.actuator_id as string | null) ?? null,
      state: shown.state,
      stateLabel: shown.label,
      stateHint: shown.hint,
      stateSince: since ?? null,
      doorState,
      deviceStatus: r.status as string,
      lastSeen: (r.last_seen as number | null) ?? null,
      lastPassageAt: (r.last_passage_at as number | null) ?? null,
      cameraIds,
    };
  }

  const cameraIdsOf = (detectorId: string): string[] => (sql('SELECT camera_id FROM device_link WHERE detector_id = ? ORDER BY camera_id').all(detectorId) as Row[]).map((r) => r.camera_id as string);

  function doors(): DoorView[] {
    const links = new Map<string, string[]>();
    for (const r of sql('SELECT detector_id, camera_id FROM device_link WHERE detector_id IN (SELECT detector_id FROM access_door) ORDER BY camera_id').all() as Row[]) {
      const list = links.get(r.detector_id as string) ?? [];
      list.push(r.camera_id as string);
      links.set(r.detector_id as string, list);
    }
    return (sql(`${DOOR_SELECT} ORDER BY d.name COLLATE NOCASE, a.detector_id`).all() as Row[]).map((r) => toDoorView(r, links.get(r.detector_id as string) ?? []));
  }

  function doorView(id: string): DoorView | null {
    const r = sql(`${DOOR_SELECT} WHERE a.detector_id = ?`).get(id) as Row | undefined;
    return r ? toDoorView(r, cameraIdsOf(id)) : null;
  }

  /** `hint` : clause « INDEXED BY ... » facultative (voir indexFor). */
  const passageSelect = (hint = ''): string => `SELECT e.*, d.name AS door_name FROM access_event e${hint} LEFT JOIN device d ON d.id = e.door_id`;
  const PASSAGE_SELECT = passageSelect();

  function toPassageView(r: Row): PassageView {
    const method = r.method as AccessMethod;
    const reason = (r.reason as AccessReason | null) ?? null;
    return {
      id: r.id as number,
      doorId: r.door_id as string,
      doorName: (r.door_name as string | null) ?? null,
      controllerId: r.controller_id as string,
      eventId: r.device_event_id as string,
      atDevice: r.at_device as number,
      atReceived: r.at_received as number,
      direction: (r.direction as AccessDirection | null) ?? null,
      credential: (r.credential as string | null) ?? null,
      holderName: (r.holder_name as string | null) ?? null,
      holderRef: (r.holder_ref as string | null) ?? null,
      method,
      methodLabel: methodLabel(method),
      result: r.result as AccessResult,
      reason,
      resultLabel: resultLabel(r.result as string, reason),
      late: r.late === 1,
    };
  }

  function door(id: string): DoorDetail {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new PsimError(404, 'Porte introuvable');
    const view = doorView(id);
    if (!view) throw new PsimError(404, 'Porte introuvable');
    const lastPassages = (sql(`${PASSAGE_SELECT} WHERE e.door_id = ? ORDER BY e.at_device DESC, e.id DESC LIMIT 10`).all(id) as Row[]).map(toPassageView);
    const cameras = (sql('SELECT d.id AS id, d.name AS name, d.status AS status FROM device_link l JOIN device d ON d.id = l.camera_id WHERE l.detector_id = ? ORDER BY d.id').all(id) as Row[]).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      status: r.status as string,
    }));
    return { door: view, lastPassages, cameras, remote: { available: false, reason: 'Ouverture à distance : disponible avec le lot AC4' } };
  }

  // ---- Recherche et export ------------------------------------------------------------------------------------------------------

  /** Vide ou absent = filtre non demande (un formulaire envoie des champs vides). Tout le reste est valide strictement. */
  const blank = (v: unknown): boolean => v === undefined || v === null || v === '';

  function timeFilter(v: unknown, name: string): number | null {
    if (blank(v)) return null;
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n < 0) throw new PsimError(400, `${name} invalide (millisecondes depuis 1970, nombre entier)`);
    return n;
  }

  function textFilter(v: unknown, name: string, max: number): string | null {
    if (blank(v)) return null;
    if (typeof v !== 'string' || v.length > max * 4) throw new PsimError(400, `${name} invalide (${max} caracteres au plus)`);
    if (hasLoneSurrogate(v) || hasForbiddenChar(v)) throw new PsimError(400, `${name} invalide (caracteres de controle ou invisibles interdits)`);
    const text = normalizeName(v);
    if (text.length > max) throw new PsimError(400, `${name} invalide (${max} caracteres au plus)`);
    return text === '' ? null : text;
  }

  function flag(v: unknown, name: string): boolean {
    if (blank(v) || v === '0' || v === 0 || v === false) return false;
    if (v === '1' || v === 1 || v === true) return true;
    throw new PsimError(400, `${name} doit valoir 1`);
  }

  function parseFilters(f: SearchFilters): Filters {
    if (!isPlainObject(f)) throw new PsimError(400, 'Filtres invalides');
    const from = timeFilter(own(f, 'from'), 'from');
    const to = timeFilter(own(f, 'to'), 'to');
    if (from !== null && to !== null && from >= to) throw new PsimError(400, 'Periode invalide : la fin doit etre apres le debut');
    const doorId = own(f, 'door');
    if (!blank(doorId) && (typeof doorId !== 'string' || !ID_PATTERN.test(doorId))) throw new PsimError(400, 'door invalide (identifiant du detecteur)');
    const result = own(f, 'result');
    if (!blank(result) && result !== 'granted' && result !== 'denied') throw new PsimError(400, 'result doit etre granted ou denied');
    return {
      from,
      to,
      door: blank(doorId) ? null : (doorId as string),
      holder: textFilter(own(f, 'holder'), 'holder', MAX_HOLDER_NAME),
      credential: textFilter(own(f, 'credential'), 'credential', MAX_CREDENTIAL),
      result: blank(result) ? null : (result as AccessResult),
      late: flag(own(f, 'late'), 'late'),
    };
  }

  function parseCursor(v: unknown): { at: number; id: number } | null {
    if (blank(v)) return null;
    const m = typeof v === 'string' ? /^(\d{1,16}):(\d{1,16})$/.exec(v) : null;
    const at = m ? Number(m[1]) : NaN;
    const id = m ? Number(m[2]) : NaN;
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(id)) throw new PsimError(400, 'Curseur invalide');
    return { at, id };
  }

  /** Clause WHERE (alias `e`) et parametres : aucune valeur n'est jamais collee dans le SQL. */
  function whereOf(f: Filters, cursor: { at: number; id: number } | null): { text: string; params: Param[] } {
    const clauses: string[] = [];
    const params: Param[] = [];
    if (f.from !== null) {
      clauses.push('e.at_device >= ?');
      params.push(f.from);
    }
    if (f.to !== null) {
      clauses.push('e.at_device < ?');
      params.push(f.to);
    }
    if (f.door !== null) {
      clauses.push('e.door_id = ?');
      params.push(f.door);
    }
    if (f.holder !== null) {
      clauses.push("e.holder_key LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(holderKey(f.holder))}%`);
    }
    // Debut du numero : intervalle sur l'index (credential, at_device), sans caractere joker.
    if (f.credential !== null) {
      clauses.push('e.credential >= ? AND e.credential < ?');
      params.push(f.credential, `${f.credential}\u{10FFFF}`);
    }
    if (f.result !== null) {
      clauses.push('e.result = ?');
      params.push(f.result);
    }
    if (f.late) clauses.push('e.late = 1');
    if (cursor) {
      clauses.push('(e.at_device < ? OR (e.at_device = ? AND e.id < ?))');
      params.push(cursor.at, cursor.at, cursor.id);
    }
    return { text: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params };
  }

  /**
   * Plan de la recherche par debut de badge. L'index (badge, date) range les passages d'un badge par date, mais un PREFIXE couvre
   * plusieurs badges : il faudrait trier tous leurs passages (180 000 lignes = plus d'une seconde). Si le prefixe est rare (au plus
   * PREFIX_SORT_MAX passages, cas d'un numero complet), on garde cet index ; sinon on lit les passages du plus recent au plus ancien
   * (par porte si elle est donnee) et on s'arrete au bout de la page : les correspondances sont nombreuses, la page se remplit vite.
   * Sans filtre de badge, le plan est laisse au moteur SQL.
   */
  function indexFor(f: Filters): string {
    if (f.credential === null) return '';
    const probe = (sql('SELECT COUNT(*) AS n FROM (SELECT 1 FROM access_event WHERE credential >= ? AND credential < ? LIMIT ?)').get(f.credential, `${f.credential}\u{10FFFF}`, PREFIX_SORT_MAX + 1) as { n: number }).n;
    if (probe <= PREFIX_SORT_MAX) return ' INDEXED BY access_event_by_credential';
    return f.door !== null ? ' INDEXED BY access_event_by_door' : ' INDEXED BY access_event_by_time';
  }

  /** Details du journal : les filtres, jamais les resultats. */
  function describeFilters(f: Filters): string {
    const parts: string[] = [];
    if (f.holder !== null) parts.push(`titulaire « ${f.holder} »`);
    if (f.credential !== null) parts.push(`badge « ${f.credential} »`);
    if (f.door !== null) parts.push(`porte ${f.door}`);
    if (f.from !== null) parts.push(`du ${isoDate(f.from)}`);
    if (f.to !== null) parts.push(`au ${isoDate(f.to)}`);
    if (f.result !== null) parts.push(f.result === 'granted' ? 'acceptes' : 'refuses');
    if (f.late) parts.push('differes');
    return parts.length > 0 ? parts.join(', ') : 'aucun filtre';
  }

  const searchLogged = new Map<string, number>();
  function logSearch(actor: string, f: Filters): void {
    const t = now();
    const cacheKey = `${actor}\u0000${JSON.stringify(f)}`;
    const last = searchLogged.get(cacheKey);
    if (last !== undefined && t - last >= 0 && t - last < SEARCH_LOG_EVERY_MS) return;
    if (searchLogged.size >= 500) for (const [k, at] of searchLogged) if (t - at >= SEARCH_LOG_EVERY_MS || t < at) searchLogged.delete(k);
    // Memoire bornee meme sous une rafale de filtres tous differents : les plus anciennes entrees partent d'abord.
    while (searchLogged.size >= 1000) searchLogged.delete(searchLogged.keys().next().value as string);
    searchLogged.set(cacheKey, t);
    audit(actor, 'access_search', { deviceId: f.door ?? undefined, details: clip(describeFilters(f)) });
  }

  function search(filters: SearchFilters, actor: string): SearchResult {
    const f = parseFilters(filters);
    const raw = isPlainObject(filters) ? filters : {};
    const limitRaw = own(raw, 'limit');
    let limit = SEARCH_DEFAULT_LIMIT;
    if (!blank(limitRaw)) {
      const n = typeof limitRaw === 'number' ? limitRaw : typeof limitRaw === 'string' && /^\d{1,4}$/.test(limitRaw) ? Number(limitRaw) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > SEARCH_MAX_LIMIT) throw new PsimError(400, `limit invalide (1 a ${SEARCH_MAX_LIMIT})`);
      limit = n;
    }
    const cursor = parseCursor(own(raw, 'cursor'));
    const wantCount = flag(own(raw, 'count'), 'count');
    // Recherche d'une personne : journalisee (page 1 seulement, au plus une fois par minute pour les memes filtres).
    if ((f.holder !== null || f.credential !== null) && cursor === null) logSearch(actor, f);

    const page = whereOf(f, cursor);
    const rows = sql(`${passageSelect(indexFor(f))}${page.text} ORDER BY e.at_device DESC, e.id DESC LIMIT ?`).all(...page.params, limit + 1) as Row[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toPassageView);
    const last = items[items.length - 1];
    let total: number | null = null;
    let totalCapped = false;
    if (wantCount) {
      const all = whereOf(f, null);
      const n = (sql(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM access_event e${all.text} LIMIT ?)`).get(...all.params, SEARCH_TOTAL_CAP + 1) as { n: number }).n;
      totalCapped = n > SEARCH_TOTAL_CAP;
      total = Math.min(n, SEARCH_TOTAL_CAP);
    }
    return { items, nextCursor: hasMore && last ? `${last.atDevice}:${last.id}` : null, total, totalCapped };
  }

  function exportCsv(filters: SearchFilters, actor: string): ExportResult {
    const f = parseFilters(filters); // limit, cursor et count sont ignores
    const where = whereOf(f, null);
    const rows = sql(
      `SELECT e.*, d.name AS door_name, c.name AS controller_name FROM access_event e${indexFor(f)}
         LEFT JOIN device d ON d.id = e.door_id LEFT JOIN access_controller c ON c.id = e.controller_id${where.text}
        ORDER BY e.at_device DESC, e.id DESC LIMIT ?`,
    ).all(...where.params, EXPORT_MAX_ROWS + 1) as Row[];
    const truncated = rows.length > EXPORT_MAX_ROWS;
    const kept = truncated ? rows.slice(0, EXPORT_MAX_ROWS) : rows;
    const csv = toCsv(
      ['Date et heure du contrôleur', 'Reçu le', 'Porte', 'Contrôleur', 'Sens', 'Badge', 'Titulaire', 'Référence titulaire', 'Méthode', 'Résultat', 'Motif', 'Reçu en différé'],
      kept.map((r) => [
        fmtDateTime(r.at_device as number),
        fmtDateTime(r.at_received as number),
        (r.door_name as string | null) ?? r.door_id,
        (r.controller_name as string | null) ?? r.controller_id,
        r.direction === 'in' ? 'Entrée' : r.direction === 'out' ? 'Sortie' : '',
        r.credential,
        r.holder_name,
        r.holder_ref,
        methodLabel(r.method as string),
        r.result === 'granted' ? 'Accepté' : 'Refusé',
        r.result === 'granted' || r.reason === null ? '' : (REASON_LABEL[r.reason as AccessReason] ?? '') || 'autre',
        r.late === 1 ? 'Oui' : 'Non',
      ]),
    );
    audit(actor, 'access_export', { deviceId: f.door ?? undefined, details: clip(`${kept.length} ligne(s)${truncated ? ' (tronque)' : ''} ; ${describeFilters(f)}`) });
    return { csv, rows: kept.length, truncated };
  }

  // ---- Controleurs ---------------------------------------------------------------------------------------------------------------

  function body(input: unknown): Record<string, unknown> {
    if (!isPlainObject(input)) throw new PsimError(400, 'Corps de requete invalide : un objet est attendu');
    return input;
  }

  /** Texte facultatif : absent = `undefined` (inchange), `null` ou vide = effacement. */
  function optionalText(input: Record<string, unknown>, field: string, label: string, max: number): string | null | undefined {
    const v = own(input, field);
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    if (typeof v !== 'string' || v.length > max * 4 || hasLoneSurrogate(v) || hasForbiddenChar(v)) throw new PsimError(400, `${label} invalide (${max} caracteres au plus, sans caractere de controle)`);
    const text = normalizeName(v);
    if (text.length > max) throw new PsimError(400, `${label} invalide (${max} caracteres au plus)`);
    return text === '' ? null : text;
  }

  function requiredName(input: Record<string, unknown>, current: string | null): string {
    const v = own(input, 'name');
    if (v === undefined && current !== null) return current;
    const text = optionalText(input, 'name', 'name', MAX_NAME);
    if (!text) throw new PsimError(400, `name requis (1 a ${MAX_NAME} caracteres)`);
    return text;
  }

  /** Identifiants : `{ username, password }`, chacun de 1 a 128 caracteres. Jamais cites dans une erreur. */
  function sealedCredentials(v: unknown): string {
    if (!isPlainObject(v)) throw new PsimError(400, 'credentials invalide : { username, password } attendu');
    const username = own(v, 'username');
    const password = own(v, 'password');
    for (const [label, s] of [['username', username], ['password', password]] as const) {
      if (typeof s !== 'string' || s.length < 1 || s.length > MAX_SECRET || hasLoneSurrogate(s)) throw new PsimError(400, `credentials.${label} invalide (1 a ${MAX_SECRET} caracteres)`);
    }
    if (hasForbiddenChar(username as string)) throw new PsimError(400, 'credentials.username invalide (caracteres de controle ou invisibles interdits)');
    return seal(key, JSON.stringify({ username, password }));
  }

  const CONTROLLER_SELECT = `SELECT c.*, (SELECT COUNT(*) FROM access_door a WHERE a.controller_id = c.id) AS door_count FROM access_controller c`;

  function toControllerView(r: Row): ControllerView {
    return {
      id: r.id as string,
      name: r.name as string,
      brand: r.brand as ControllerBrand,
      model: (r.model as string | null) ?? null,
      host: (r.host as string | null) ?? null,
      gatewayId: (r.gateway_id as string | null) ?? null,
      hasCredentials: r.credentials_sealed !== null && r.credentials_sealed !== undefined,
      clockOffsetMs: (r.clock_offset_ms as number | null) ?? null,
      lastSeen: (r.last_seen as number | null) ?? null,
      doorCount: r.door_count as number,
      createdAt: r.created_at as number,
      createdBy: r.created_by as string,
      updatedAt: r.updated_at as number,
      updatedBy: r.updated_by as string,
    };
  }

  function controllers(): ControllerView[] {
    return (sql(`${CONTROLLER_SELECT} ORDER BY c.name COLLATE NOCASE, c.id`).all() as Row[]).map(toControllerView);
  }

  function controller(id: string): ControllerView {
    const r = typeof id === 'string' && ID_PATTERN.test(id) ? (sql(`${CONTROLLER_SELECT} WHERE c.id = ?`).get(id) as Row | undefined) : undefined;
    if (!r) throw new PsimError(404, 'Controleur introuvable');
    return toControllerView(r);
  }

  function checkBrandAndHost(input: Record<string, unknown>): { brand: ControllerBrand | undefined; model: string | null | undefined; host: string | null | undefined; gatewayId: string | null | undefined } {
    const brand = own(input, 'brand');
    if (brand !== undefined && (typeof brand !== 'string' || !(CONTROLLER_BRANDS as readonly string[]).includes(brand))) throw new PsimError(400, `brand invalide (${CONTROLLER_BRANDS.join(', ')})`);
    const model = optionalText(input, 'model', 'model', MAX_MODEL);
    const host = optionalText(input, 'host', 'host', 253);
    if (typeof host === 'string' && !HOST_PATTERN.test(host)) throw new PsimError(400, 'Adresse invalide (adresse IPv4 ou nom de machine, sans http:// ni chemin)');
    const gatewayId = optionalText(input, 'gatewayId', 'gatewayId', 32);
    if (typeof gatewayId === 'string' && !ID_PATTERN.test(gatewayId)) throw new PsimError(400, 'gatewayId invalide (lettres, chiffres, - et _ ; 32 caracteres max)');
    return { brand: brand as ControllerBrand | undefined, model, host, gatewayId };
  }

  function createController(actor: string, raw: ControllerInput): ControllerView {
    const input = body(raw);
    const id = own(input, 'id');
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new PsimError(400, 'Identifiant invalide (lettres, chiffres, - et _ ; 32 caracteres max)');
    const name = requiredName(input, null);
    const { brand, model, host, gatewayId } = checkBrandAndHost(input);
    if (brand === undefined) throw new PsimError(400, `brand requis (${CONTROLLER_BRANDS.join(', ')})`);
    const creds = own(input, 'credentials');
    const sealed = creds === undefined || creds === null ? null : sealedCredentials(creds);
    if (sql('SELECT 1 AS x FROM access_controller WHERE id = ?').get(id)) throw new PsimError(409, 'Identifiant de controleur deja utilise');
    const t = now();
    sql(
      'INSERT INTO access_controller (id, name, brand, model, host, gateway_id, credentials_sealed, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, name, brand, model ?? null, host ?? null, gatewayId ?? null, sealed, t, actor, t, actor);
    audit(actor, 'access_controller_created', { details: clip(`${id} : ${name} (${brand})${sealed ? ', identifiants enregistres' : ''}`) });
    return controller(id);
  }

  function updateController(actor: string, id: string, raw: ControllerInput): ControllerView {
    const current = controller(id);
    const input = body(raw);
    const name = requiredName(input, current.name);
    const { brand, model, host, gatewayId } = checkBrandAndHost(input);
    const creds = own(input, 'credentials');
    const sealed = creds === undefined || creds === null ? null : sealedCredentials(creds);
    const changed: string[] = [];
    if (name !== current.name) changed.push('nom');
    if (brand !== undefined && brand !== current.brand) changed.push('marque');
    if (model !== undefined && model !== current.model) changed.push('modele');
    if (host !== undefined && host !== current.host) changed.push('adresse');
    if (gatewayId !== undefined && gatewayId !== current.gatewayId) changed.push('passerelle');
    if (creds === null) changed.push('identifiants effaces');
    else if (creds !== undefined) changed.push('identifiants remplaces');
    const t = now();
    atomically(() => {
      sql('UPDATE access_controller SET name = ?, brand = ?, model = ?, host = ?, gateway_id = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(
        name, brand ?? current.brand, model === undefined ? current.model : model, host === undefined ? current.host : host,
        gatewayId === undefined ? current.gatewayId : gatewayId, t, actor, id,
      );
      if (creds === null) sql('UPDATE access_controller SET credentials_sealed = NULL WHERE id = ?').run(id);
      else if (sealed !== null) sql('UPDATE access_controller SET credentials_sealed = ? WHERE id = ?').run(sealed, id);
    });
    audit(actor, 'access_controller_updated', { details: clip(`${id} : ${changed.length > 0 ? changed.join(', ') : 'aucun changement'}`) });
    return controller(id);
  }

  function deleteController(actor: string, id: string): void {
    const current = controller(id);
    if (current.doorCount > 0) throw new PsimError(409, `Ce controleur a encore ${current.doorCount} porte(s) declaree(s) : les retirer d'abord`);
    sql('DELETE FROM access_controller WHERE id = ?').run(id);
    audit(actor, 'access_controller_deleted', { details: clip(`${id} : ${current.name}`) });
  }

  // ---- Declaration des portes ------------------------------------------------------------------------------------------------------

  function checkDoorFields(input: Record<string, unknown>): {
    controllerId?: string; doorNo?: number; kind?: DoorKind; emergencyExit?: boolean; heldAlarmAfterS?: number; actuatorId?: string | null;
  } {
    const out: ReturnType<typeof checkDoorFields> = {};
    const controllerId = own(input, 'controllerId');
    if (controllerId !== undefined) {
      if (typeof controllerId !== 'string' || !ID_PATTERN.test(controllerId)) throw new PsimError(400, 'controllerId invalide');
      if (!sql('SELECT 1 AS x FROM access_controller WHERE id = ?').get(controllerId)) throw new PsimError(400, 'Controleur inconnu : le declarer d\'abord');
      out.controllerId = controllerId;
    }
    const doorNo = own(input, 'doorNo');
    if (doorNo !== undefined) {
      if (typeof doorNo !== 'number' || !Number.isInteger(doorNo) || doorNo < 1 || doorNo > 4) throw new PsimError(400, 'doorNo invalide (1 a 4)');
      out.doorNo = doorNo;
    }
    const kind = own(input, 'kind');
    if (kind !== undefined) {
      if (typeof kind !== 'string' || !(DOOR_KINDS as readonly string[]).includes(kind)) throw new PsimError(400, `kind invalide (${DOOR_KINDS.join(', ')})`);
      out.kind = kind as DoorKind;
    }
    const emergency = own(input, 'emergencyExit');
    if (emergency !== undefined) {
      if (typeof emergency !== 'boolean') throw new PsimError(400, 'emergencyExit doit etre vrai ou faux');
      out.emergencyExit = emergency;
    }
    const held = own(input, 'heldAlarmAfterS');
    if (held !== undefined) {
      if (typeof held !== 'number' || !Number.isInteger(held) || held < MIN_HELD_ALARM_S || held > MAX_HELD_ALARM_S) throw new PsimError(400, `heldAlarmAfterS invalide (${MIN_HELD_ALARM_S} a ${MAX_HELD_ALARM_S} secondes)`);
      out.heldAlarmAfterS = held;
    }
    const actuator = own(input, 'actuatorId');
    if (actuator !== undefined) {
      if (actuator !== null && (typeof actuator !== 'string' || !ID_PATTERN.test(actuator))) throw new PsimError(400, 'actuatorId invalide (lettres, chiffres, - et _ ; 32 caracteres max)');
      out.actuatorId = actuator;
    }
    return out;
  }

  /** Le numero de porte est unique par controleur : message clair avant la contrainte de la base. */
  function checkDoorNoFree(controllerId: string, doorNo: number, exceptDetector: string | null): void {
    const taken = sql('SELECT detector_id FROM access_door WHERE controller_id = ? AND door_no = ?').get(controllerId, doorNo) as { detector_id: string } | undefined;
    if (taken && taken.detector_id !== exceptDetector) throw new PsimError(409, `La porte n°${doorNo} de ce controleur est deja declaree (${taken.detector_id})`);
  }

  function declareDoor(actor: string, raw: DoorInput): DoorView {
    const input = body(raw);
    const detectorId = own(input, 'detectorId');
    if (typeof detectorId !== 'string' || !ID_PATTERN.test(detectorId)) throw new PsimError(400, 'detectorId invalide');
    const dev = sql('SELECT kind, category FROM device WHERE id = ?').get(detectorId) as { kind: string; category: string } | undefined;
    if (!dev || dev.kind !== 'detector') throw new PsimError(400, 'Detecteur inconnu');
    if (dev.category !== 'access') throw new PsimError(400, "Ce detecteur n'est pas de categorie « Controle d'acces » (la changer dans l'ecran Equipements)");
    if (sql('SELECT 1 AS x FROM access_door WHERE detector_id = ?').get(detectorId)) throw new PsimError(409, 'Cette porte est deja declaree');
    const f = checkDoorFields(input);
    if (f.controllerId === undefined) throw new PsimError(400, 'controllerId requis');
    if (f.doorNo === undefined) throw new PsimError(400, 'doorNo requis (1 a 4)');
    checkDoorNoFree(f.controllerId, f.doorNo, null);
    sql(
      'INSERT INTO access_door (detector_id, controller_id, door_no, kind, emergency_exit, held_alarm_after_s, actuator_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(detectorId, f.controllerId, f.doorNo, f.kind ?? 'door', f.emergencyExit ? 1 : 0, f.heldAlarmAfterS ?? DEFAULT_HELD_ALARM_S, f.actuatorId ?? null);
    audit(actor, 'access_door_declared', { deviceId: detectorId, details: clip(`porte n°${f.doorNo} du controleur ${f.controllerId}${f.emergencyExit ? ', issue de secours' : ''}`) });
    return doorView(detectorId) as DoorView;
  }

  function updateDoor(actor: string, id: string, raw: DoorInput): DoorView {
    const input = body(raw);
    const current = typeof id === 'string' && ID_PATTERN.test(id) ? (sql('SELECT * FROM access_door WHERE detector_id = ?').get(id) as DoorRow | undefined) : undefined;
    if (!current) throw new PsimError(404, 'Porte introuvable');
    const f = checkDoorFields(input);
    const controllerId = f.controllerId ?? current.controller_id;
    const doorNo = f.doorNo ?? current.door_no;
    if (controllerId !== current.controller_id || doorNo !== current.door_no) checkDoorNoFree(controllerId, doorNo, id);
    const changed: string[] = [];
    if (controllerId !== current.controller_id) changed.push('controleur');
    if (doorNo !== current.door_no) changed.push('numero');
    if (f.kind !== undefined && f.kind !== current.kind) changed.push('type');
    if (f.emergencyExit !== undefined && f.emergencyExit !== (current.emergency_exit === 1)) changed.push('issue de secours');
    if (f.heldAlarmAfterS !== undefined && f.heldAlarmAfterS !== current.held_alarm_after_s) changed.push('delai');
    if (f.actuatorId !== undefined && f.actuatorId !== current.actuator_id) changed.push('actionneur');
    sql('UPDATE access_door SET controller_id = ?, door_no = ?, kind = ?, emergency_exit = ?, held_alarm_after_s = ?, actuator_id = ? WHERE detector_id = ?').run(
      controllerId, doorNo, f.kind ?? current.kind, (f.emergencyExit ?? current.emergency_exit === 1) ? 1 : 0, f.heldAlarmAfterS ?? current.held_alarm_after_s,
      f.actuatorId === undefined ? current.actuator_id : f.actuatorId, id,
    );
    audit(actor, 'access_door_updated', { deviceId: id, details: clip(changed.length > 0 ? changed.join(', ') : 'aucun changement') });
    return doorView(id) as DoorView;
  }

  function removeDoor(actor: string, id: string): void {
    const r = typeof id === 'string' && ID_PATTERN.test(id) ? sql('DELETE FROM access_door WHERE detector_id = ?').run(id) : null;
    if (!r || Number(r.changes) === 0) throw new PsimError(404, 'Porte introuvable');
    audit(actor, 'access_door_removed', { deviceId: id, details: "declaration retiree ; l'historique des passages est conserve jusqu'a la purge" });
  }

  // ---- Reglages ----------------------------------------------------------------------------------------------------------------------

  function settings(): AccessSettings {
    const count = (sql('SELECT COUNT(*) AS n FROM access_event').get() as { n: number }).n;
    const oldest = (sql('SELECT MIN(at_device) AS m FROM access_event').get() as { m: number | null }).m;
    let lastPurge: AccessSettings['lastPurge'] = null;
    try {
      const parsed = JSON.parse(getSetting('last_purge') ?? 'null') as Record<string, unknown> | null;
      if (parsed && typeof parsed.at === 'number' && typeof parsed.deleted === 'number' && typeof parsed.before === 'number') lastPurge = { at: parsed.at, deleted: parsed.deleted, before: parsed.before };
    } catch {
      lastPurge = null;
    }
    return { retentionDays: retentionDays(), defaultDays, eventCount: count, oldestAt: oldest, lastPurge };
  }

  function setRetention(actor: string, days: unknown): AccessSettings {
    if (typeof days !== 'number' || !Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
      throw new PsimError(400, `retentionDays invalide (nombre entier de jours, de ${MIN_RETENTION_DAYS} a ${MAX_RETENTION_DAYS})`);
    }
    const before = retentionDays();
    setSetting('retention_days', String(days));
    audit(actor, 'access_retention_changed', { details: `${before} -> ${days} jour(s)` });
    return settings();
  }

  return {
    onMessage, tick, purge, doors, door, search, exportCsv, controllers, controller, createController, updateController, deleteController,
    declareDoor, updateDoor, removeDoor, settings, setRetention,
  };
}
