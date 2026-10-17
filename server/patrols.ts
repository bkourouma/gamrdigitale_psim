import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Express, Request, RequestHandler } from 'express';
import QRCode from 'qrcode';
import { releaseAcknowledged as releaseAcknowledgedDefault } from './agents.ts';
import { parseSchedule } from './arming.ts';
import type { Window } from './arming.ts';
import type { Engine } from './engine.ts';
import { PsimError } from './errors.ts';
import { createPatrolMachine, windowStarts } from './patrolmachine.ts';
import type { PatrolAction, PatrolMachine, PatrolSpec, RunState, ScanVerdict } from './patrolmachine.ts';
import { hasForbiddenChar, normalizeName } from './text.ts';
import type { AgentRun, MountContext } from './types.ts';

/**
 * Points de controle, circuits et rondes des agents (lot S1, contrat docs/AGENTS-RONDES.md ; choix communs : conception S1).
 *
 *  - un POINT DE CONTROLE est une etiquette (QR et NFC, meme contenu) posee dans le batiment : son code (10 caracteres base32
 *    minuscules aleatoires) est unique, regenerable, et SEUL le code est lu par le telephone ;
 *  - un CIRCUIT est une liste de points (ordonnee ou non), une duree maximale, un planning (l'heure de DEBUT des plages donne
 *    les rondes) et les agents concernes. Chaque circuit a un detecteur virtuel `P-<id>` (categorie `people`) qui porte les
 *    alarmes « Ronde incomplete » / « Ronde non faite » dans le circuit normal des incidents ;
 *  - la decision (ronde creee, active, faite, incomplete, ratee) est prise par la machine PURE `patrolmachine.ts`, une par circuit
 *    actif. Ce module la fait vivre : il persiste ses actions, la reconstruit depuis la base au demarrage et a chaque modification
 *    du circuit, lui donne le temps (`tick`) et les scans, et envoie les evenements au moteur ;
 *  - un scan est TOUJOURS enregistre une fois le code reconnu (verdict `ok`, `duplicate`, `out_of_order`, `out_of_route`, `no_run`) :
 *    la trace est la preuve de passage, et la position de l'agent est celle du dernier point reconnu. Idempotent par `clientId` ;
 *  - la main courante est le registre libre des agents (texte, photo JPEG facultative) ; le chef de poste peut en faire un incident ;
 *  - conservation : 400 jours pour les scans, la main courante (photos comprises) et les rondes.
 *
 * Journal d'audit (chaine, non purgeable : jamais une entree par scan) : points et circuits (`checkpoint_*`, `patrol_route_*`),
 * une entree `patrol_run_closed` par ronde terminee (acteur `systeme`), `logbook_incident_created`, `patrol_history_read`.
 */

type Row = Record<string, unknown>;

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Conservation des scans, de la main courante et des rondes. */
export const RETENTION_DAYS = 400;
/** Un scan recu plus de 2 min apres l'heure du telephone est « recu en differe ». */
export const DEFERRED_AFTER_MS = 2 * MIN;
const PHONE_AHEAD_MS = 5 * MIN;
const PHONE_BEHIND_MS = DAY;
const MAX_PHOTO_BYTES = 400 * 1024;
const MAX_LOG_TEXT = 1000;
const MAX_NAME = 80;
const MAX_ROUTE_POINTS = 100;
const MAX_ROUTE_AGENTS = 100;
const MAX_ROWS = 2000;
/** Lecture de l'historique : une entree d'audit par lecteur et par filtre au plus toutes les 10 min (l'ecran se rafraichit seul). */
const HISTORY_AUDIT_EVERY_MS = 10 * MIN;
/** Une ronde close reste en memoire de la machine 2 jours ; on ne recharge pas plus ancien que cela (hors rondes ouvertes). */
const LOAD_HORIZON_MS = 3 * DAY;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const LABEL_CODE = /^[a-z2-7]{10}$/;
const CLIENT_ID = /^[A-Za-z0-9._:-]{8,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const LOG_CATEGORIES: readonly string[] = ['anomaly', 'damage', 'visitor', 'other'];
const LOG_CATEGORY_LABEL: Record<string, string> = { anomaly: 'Anomalie', damage: 'Dégradation', visitor: 'Visiteur', other: 'Autre' };
const METHODS: readonly string[] = ['nfc', 'qr', 'manual'];
/** Meilleur verdict quand plusieurs circuits examinent le meme scan. */
const RANK: Record<ScanVerdict, number> = { ok: 5, duplicate: 4, out_of_order: 3, out_of_route: 2, no_run: 1 };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoint (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  zone TEXT NOT NULL DEFAULT '',
  floor_id INTEGER NOT NULL,
  x REAL NOT NULL DEFAULT 50,
  y REAL NOT NULL DEFAULT 50,
  code TEXT NOT NULL UNIQUE,
  archived_at INTEGER
);
CREATE TABLE IF NOT EXISTS patrol_route (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  checkpoints TEXT NOT NULL,
  ordered INTEGER NOT NULL DEFAULT 0,
  max_minutes INTEGER NOT NULL,
  schedule TEXT NOT NULL,
  agents TEXT NOT NULL DEFAULT '[]',
  grace_minutes INTEGER NOT NULL DEFAULT 10,
  enabled INTEGER NOT NULL DEFAULT 1,
  archived_at INTEGER
);
CREATE TABLE IF NOT EXISTS patrol_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id INTEGER NOT NULL,
  due_start INTEGER NOT NULL,
  due_end INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'done', 'incomplete', 'missed')),
  started_by TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE (route_id, due_start)
);
CREATE INDEX IF NOT EXISTS patrol_run_by_start ON patrol_run(due_start);
CREATE TABLE IF NOT EXISTS patrol_scan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  run_id INTEGER,
  checkpoint_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  phone_id INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('nfc', 'qr', 'manual')),
  phone_at INTEGER NOT NULL,
  server_at INTEGER NOT NULL,
  deferred INTEGER NOT NULL DEFAULT 0,
  verdict TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS patrol_scan_by_run ON patrol_scan(run_id);
CREATE INDEX IF NOT EXISTS patrol_scan_by_time ON patrol_scan(server_at);
CREATE INDEX IF NOT EXISTS patrol_scan_by_user ON patrol_scan(username, server_at);
CREATE TABLE IF NOT EXISTS logbook_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  category TEXT NOT NULL,
  text TEXT NOT NULL,
  checkpoint_id INTEGER,
  photo_file TEXT,
  photo_sha256 TEXT,
  phone_at INTEGER NOT NULL,
  server_at INTEGER NOT NULL,
  deferred INTEGER NOT NULL DEFAULT 0,
  incident_id INTEGER
);
CREATE INDEX IF NOT EXISTS logbook_by_time ON logbook_entry(server_at);
`;

// ---- Formes exposees ------------------------------------------------------------------------------------------------

export interface CheckpointView {
  id: number;
  name: string;
  zone: string;
  floorId: number;
  x: number;
  y: number;
  /** Code de l'etiquette : reserve a l'administrateur (absent pour l'operateur). */
  code?: string;
  archivedAt: number | null;
}

export interface RouteView {
  id: number;
  name: string;
  checkpoints: number[];
  ordered: boolean;
  maxMinutes: number;
  schedule: Window[];
  agents: string[];
  graceMinutes: number;
  enabled: boolean;
  archivedAt: number | null;
  /** Detecteur virtuel du circuit (`P-<id>`). */
  deviceId: string;
}

export interface ScanView {
  id: number;
  runId: number | null;
  checkpointId: number;
  checkpointName: string;
  username: string;
  displayName: string;
  method: 'nfc' | 'qr' | 'manual';
  phoneAt: number;
  serverAt: number;
  deferred: boolean;
  verdict: ScanVerdict;
}

/** Une ronde avec ses passages, ses points faits et manquants (journal, rapports). */
export interface RunDetail extends AgentRun {
  routeName: string;
  startedBy: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  scans: ScanView[];
  doneCount: number;
  totalCount: number;
  /** Noms des points manques (avenant 2 : l'operateur ne lit pas les circuits). */
  missing: string[];
}

export interface LogbookView {
  id: number;
  username: string;
  displayName: string;
  category: string;
  text: string;
  checkpointId: number | null;
  checkpointName: string;
  hasPhoto: boolean;
  phoneAt: number;
  serverAt: number;
  deferred: boolean;
  incidentId: number | null;
}

export interface PositionView {
  username: string;
  displayName: string;
  checkpointId: number;
  name: string;
  floorId: number;
  x: number;
  y: number;
  at: number;
}

export interface ScanResponse {
  scan: { verdict: ScanVerdict; checkpoint: { id: number; name: string }; run: AgentRun | null; deferred: boolean };
}

/** Ce que ce module utilise du service des agents (`createAgents` de agents.ts le fournit). */
export interface PatrolAgents {
  isAgent(username: string): boolean;
  detectorId(username: string): string;
  setPosition(username: string, checkpointId: number, at: number): void;
  /**
   * Agent a qui attribuer un envoi d'un telephone partage (avenant 1) : `claimed` (champ `username` de l'envoi) s'il a eu un
   * service sur CE telephone a l'heure `phoneAt`, sinon PsimError(403). Renvoie le nom retenu.
   */
  resolveSender(phoneId: number, sessionUsername: string, claimed: string | undefined, phoneAt: number): string;
  positions(): { username: string; displayName: string; checkpointId: number; at: number }[];
  requireAgent: RequestHandler;
  agentOf(req: Request): { username: string; phoneId: number };
}

export interface PatrolsDeps {
  db: DatabaseSync;
  engine: Pick<Engine, 'handleDetectorMessage' | 'audit' | 'getDevice' | 'createDevice' | 'updateDevice' | 'deleteDevice'>;
  agents: PatrolAgents;
  /** Dossier des donnees : les photos de la main courante sont sous `<dataDir>/logbook/`. */
  dataDir: string;
  now?: () => number;
  /**
   * Libere les detecteurs `P-` dont l'incident a ete acquitte par l'exploitation (voir agents.ts). Par defaut la fonction de
   * agents.ts ; injectable pour tester sans elle.
   */
  releaseAcknowledged?: (db: DatabaseSync, engine: Pick<Engine, 'handleDetectorMessage'>, prefix: 'A-' | 'P-') => number | void;
}

// ---- Utilitaires ----------------------------------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);

/** Corps d'une demande : un objet (absent = objet vide). */
function bodyOf(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (!isObject(input)) throw new PsimError(400, 'La demande doit etre un objet JSON');
  return input;
}

/** Administration : aucun champ inconnu n'est ignore en silence. */
function only(body: Record<string, unknown>, keys: string[]): void {
  for (const key of Object.keys(body)) {
    if (!keys.includes(key)) throw new PsimError(400, `Champ « ${key.replace(/[^ -~]/g, '?').slice(0, 40)} » non reconnu`);
  }
}

const parseId = (value: unknown, notFound: string): number => {
  const raw = String(value);
  const id = /^\d{1,12}$/.test(raw) ? Number(raw) : 0;
  if (id < 1) throw new PsimError(404, notFound);
  return id;
};

function randomCode(n: number): string {
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += BASE32[bytes[i] & 31];
  return out;
}

const sha256hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

function cleanName(value: unknown, field: string): string {
  const text = typeof value === 'string' ? normalizeName(value) : '';
  if (text === '' || text.length > MAX_NAME || hasForbiddenChar(text)) {
    throw new PsimError(400, `${field} : texte de 1 a ${MAX_NAME} caracteres, sans caractere de controle`);
  }
  return text;
}

function cleanZone(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  const text = typeof value === 'string' ? normalizeName(value) : '';
  if (text.length > MAX_NAME || hasForbiddenChar(text) || typeof value !== 'string') {
    throw new PsimError(400, `zone : texte de ${MAX_NAME} caracteres au plus, sans caractere de controle`);
  }
  return text;
}

function cleanPercent(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new PsimError(400, `${field} doit etre un nombre entre 0 et 100`);
  return value;
}

function cleanInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new PsimError(400, `${field} : nombre entier de ${min} a ${max}`);
  }
  return value;
}

function cleanBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new PsimError(400, `${field} doit etre vrai ou faux`);
  return value;
}

/** Texte vu par les humains (incident, notification) : une ligne, sans caractere de controle, 300 caracteres au plus. */
const clipDetail = (text: string): string => normalizeName(text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}\s]+/gu, ' ')).slice(0, 300);

function parseJson(text: unknown): unknown {
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}

/** Heure d'un filtre de lecture : millisecondes epoch (chiffres) ou date lisible par `Date.parse`. */
function cleanTime(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') throw new PsimError(400, `Parametre « ${field} » invalide`);
  const text = String(value).trim();
  const t = /^\d{1,15}$/.test(text) ? Number(text) : Date.parse(text);
  if (!Number.isFinite(t)) throw new PsimError(400, `Parametre « ${field} » invalide : heure en millisecondes ou date attendue`);
  return t;
}

/** JPEG base64 strict (pas de prefixe `data:`) : signature FF D8 FF, 400 Ko decodes au plus. */
function decodePhoto(value: unknown): Buffer {
  if (typeof value !== 'string' || value === '') throw new PsimError(400, 'Photo invalide : JPEG en base64 attendu');
  if (value.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 4) throw new PsimError(413, 'Photo trop volumineuse (400 Ko au plus)');
  if (value.length % 4 !== 0 || !BASE64.test(value)) throw new PsimError(400, 'Photo invalide : base64 strict attendu');
  const data = Buffer.from(value, 'base64');
  if (data.length > MAX_PHOTO_BYTES) throw new PsimError(413, 'Photo trop volumineuse (400 Ko au plus)');
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) throw new PsimError(400, 'Photo invalide : ce n\'est pas une image JPEG');
  return data;
}

function cleanLogText(value: unknown): string {
  if (typeof value !== 'string') throw new PsimError(400, 'Texte requis');
  const text = value.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  if (text === '') throw new PsimError(400, 'Texte requis');
  if (text.length > MAX_LOG_TEXT) throw new PsimError(400, `Texte trop long (${MAX_LOG_TEXT} caracteres au plus)`);
  // Retours a la ligne et tabulations permis ; rien d'autre qui change l'affichage (controles, bidi U+202E, largeur nulle...).
  // U+200D (liaison des emoji) est tolere.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u.test(text.replace(/\u200d/g, ''))) {
    throw new PsimError(400, 'Texte invalide (caracteres de controle ou invisibles interdits)');
  }
  return text;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n > 1 ? many : one}`;

// ---- Service --------------------------------------------------------------------------------------------------------

interface RouteRecord {
  id: number;
  name: string;
  checkpoints: number[];
  ordered: boolean;
  maxMinutes: number;
  schedule: Window[];
  agents: string[];
  graceMinutes: number;
  enabled: boolean;
  archivedAt: number | null;
}

interface CheckpointRow {
  id: number;
  name: string;
  zone: string;
  floorId: number;
  x: number;
  y: number;
  code: string;
  archivedAt: number | null;
}

interface RunRow {
  id: number;
  routeId: number;
  dueStart: number;
  dueEnd: number;
  status: RunState['status'];
  startedBy: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

interface ScanRow {
  id: number;
  clientId: string;
  runId: number | null;
  checkpointId: number;
  username: string;
  phoneId: number;
  method: 'nfc' | 'qr' | 'manual';
  phoneAt: number;
  serverAt: number;
  deferred: boolean;
  verdict: ScanVerdict;
}

interface Live {
  routeId: number;
  deviceId: string;
  machine: PatrolMachine;
  points: ReadonlySet<number>;
}

export function createPatrols(deps: PatrolsDeps) {
  const { db, engine, agents } = deps;
  const now = deps.now ?? Date.now;
  const releaseAck = deps.releaseAcknowledged ?? releaseAcknowledgedDefault;
  const logbookDir = resolve(deps.dataDir, 'logbook');
  db.exec(SCHEMA);
  mkdirSync(logbookDir, { recursive: true });

  const deviceOf = (routeId: number): string => `P-${routeId}`;
  const audit = (actor: string, action: string, ref?: { incidentId?: number; deviceId?: string; details?: string }): void => engine.audit(actor, action, ref);

  // -- Lecture des lignes ---------------------------------------------------------------------------------------------

  const toCheckpoint = (r: Row): CheckpointRow => ({
    id: r.id as number,
    name: r.name as string,
    zone: (r.zone as string | null) ?? '',
    floorId: r.floor_id as number,
    x: r.x as number,
    y: r.y as number,
    code: r.code as string,
    archivedAt: (r.archived_at as number | null) ?? null,
  });

  const checkpointRow = (id: number): CheckpointRow | null => {
    const r = db.prepare('SELECT * FROM checkpoint WHERE id = ?').get(id) as Row | undefined;
    return r ? toCheckpoint(r) : null;
  };

  /** Ligne lue sans exception : une colonne illisible donne une valeur vide, que la machine refusera (RangeError) au besoin. */
  function toRoute(r: Row): RouteRecord {
    const points = parseJson(r.checkpoints);
    const schedule = parseJson(r.schedule);
    const agentList = parseJson(r.agents);
    return {
      id: r.id as number,
      name: r.name as string,
      checkpoints: Array.isArray(points) ? (points as number[]) : [],
      ordered: r.ordered === 1,
      maxMinutes: r.max_minutes as number,
      schedule: Array.isArray(schedule) ? (schedule as Window[]) : [],
      agents: Array.isArray(agentList) ? (agentList as string[]) : [],
      graceMinutes: r.grace_minutes as number,
      enabled: r.enabled === 1,
      archivedAt: (r.archived_at as number | null) ?? null,
    };
  }

  const routeRecord = (id: number): RouteRecord | null => {
    const r = db.prepare('SELECT * FROM patrol_route WHERE id = ?').get(id) as Row | undefined;
    return r ? toRoute(r) : null;
  };

  const toRun = (r: Row): RunRow => ({
    id: r.id as number,
    routeId: r.route_id as number,
    dueStart: r.due_start as number,
    dueEnd: r.due_end as number,
    status: r.status as RunRow['status'],
    startedBy: (r.started_by as string | null) ?? null,
    startedAt: (r.started_at as number | null) ?? null,
    finishedAt: (r.finished_at as number | null) ?? null,
  });

  const toScan = (r: Row): ScanRow => ({
    id: r.id as number,
    clientId: r.client_id as string,
    runId: (r.run_id as number | null) ?? null,
    checkpointId: r.checkpoint_id as number,
    username: r.username as string,
    phoneId: r.phone_id as number,
    method: r.method as ScanRow['method'],
    phoneAt: r.phone_at as number,
    serverAt: r.server_at as number,
    deferred: r.deferred === 1,
    verdict: r.verdict as ScanVerdict,
  });

  /** Heure effective d'un passage : celle du serveur, ou celle du telephone s'il a ete recu en differe. */
  const effectiveAt = (s: Pick<ScanRow, 'deferred' | 'phoneAt' | 'serverAt'>): number => (s.deferred ? s.phoneAt : s.serverAt);

  const displayNames = new Map<string, string>();
  function displayName(username: string): string {
    const cached = displayNames.get(username);
    if (cached !== undefined) return cached;
    const r = db.prepare('SELECT display_name FROM app_user WHERE username = ?').get(username) as { display_name: string | null } | undefined;
    const name = r?.display_name?.trim() || username;
    if (displayNames.size > 500) displayNames.clear();
    displayNames.set(username, name);
    return name;
  }

  // -- Detecteur virtuel P-<id> --------------------------------------------------------------------------------------

  /**
   * Cree ou met a jour `P-<id>` : nom du circuit, zone, etage et position du 1er point. Une zone deja utilisee a un autre
   * etage (409 du moteur) n'empeche rien : le detecteur est cree sans zone, et on le signale au journal technique.
   * Etage et position ne suivent le 1er point que s'il a change (`moveToFirst`) : on ne ramene pas a sa place un detecteur
   * que l'administrateur a deplace sur le plan.
   */
  function syncDetector(actor: string, route: RouteRecord, moveToFirst: boolean): void {
    const deviceId = deviceOf(route.id);
    const first = route.checkpoints.length > 0 ? checkpointRow(route.checkpoints[0]) : null;
    if (!first) return;
    const existing = engine.getDevice(deviceId);
    if (!existing) {
      const input = { id: deviceId, kind: 'detector', name: route.name, zone: first.zone, floorId: first.floorId, x: first.x, y: first.y, category: 'people', heartbeatS: 0 };
      try {
        engine.createDevice(actor, input);
      } catch (err) {
        if (!(err instanceof PsimError) || err.status !== 409 || first.zone === '') throw err;
        console.warn(`[patrols] ${deviceId} : zone « ${first.zone} » deja utilisee a un autre etage, detecteur cree sans zone`);
        engine.createDevice(actor, { ...input, zone: '' });
      }
      return;
    }
    const patch: Record<string, unknown> = {};
    if (existing.name !== route.name) patch.name = route.name;
    if (existing.zone !== first.zone) patch.zone = first.zone;
    if (moveToFirst && (existing.floorId !== first.floorId || existing.x !== first.x || existing.y !== first.y)) Object.assign(patch, { floorId: first.floorId, x: first.x, y: first.y });
    if (Object.keys(patch).length === 0) return;
    try {
      engine.updateDevice(actor, deviceId, patch);
    } catch (err) {
      if (!(err instanceof PsimError) || err.status !== 409 || !('zone' in patch)) throw err;
      console.warn(`[patrols] ${deviceId} : zone « ${first.zone} » deja utilisee a un autre etage, detecteur laisse sans zone`);
      engine.updateDevice(actor, deviceId, { ...patch, zone: '' });
    }
  }

  const incidentCount = (deviceId: string): number => (db.prepare('SELECT COUNT(*) AS n FROM incident WHERE detector_id = ?').get(deviceId) as { n: number }).n;
  const ringing = (deviceId: string): boolean => {
    const status = engine.getDevice(deviceId)?.status;
    return status === 'alarm' || status === 'prealarm';
  };

  // -- Machines (une par circuit actif) ------------------------------------------------------------------------------

  const live = new Map<number, Live>();

  /** Rondes recentes (et toutes les rondes ouvertes) du circuit, avec leurs passages `ok`, pour `machine.load`. */
  function storedRuns(routeId: number): RunState[] {
    const rows = db
      .prepare("SELECT * FROM patrol_run WHERE route_id = ? AND (status IN ('pending', 'active', 'incomplete') OR due_end >= ?) ORDER BY due_start")
      .all(routeId, now() - LOAD_HORIZON_MS) as Row[];
    const scans = db.prepare("SELECT checkpoint_id, username, phone_at, server_at, deferred FROM patrol_scan WHERE run_id = ? AND verdict = 'ok' ORDER BY id");
    return rows.map((r) => {
      const run = toRun(r);
      return {
        dueStart: run.dueStart,
        dueEnd: run.dueEnd,
        status: run.status,
        startedBy: run.startedBy,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        done: (scans.all(run.id) as Row[]).map((s) => ({
          checkpointId: s.checkpoint_id as number,
          username: s.username as string,
          at: s.deferred === 1 ? (s.phone_at as number) : (s.server_at as number),
        })),
      };
    });
  }

  /**
   * (Re)construit la machine d'un circuit depuis la base. Circuit absent, archive ou desactive : pas de machine. Ligne
   * corrompue (la machine leve alors une RangeError) : on le dit et on continue, un circuit casse ne fait pas tomber les autres.
   * `catchUpMs` : 0 pour un circuit cree ou modifie a l'instant (pas de rattrapage des debuts de plage passes).
   */
  function rebuild(routeId: number, catchUpMs?: number): void {
    live.delete(routeId);
    const route = routeRecord(routeId);
    if (!route || route.archivedAt !== null || !route.enabled) return;
    try {
      const spec: PatrolSpec = {
        routeId,
        checkpoints: route.checkpoints,
        ordered: route.ordered,
        maxMinutes: route.maxMinutes,
        graceMinutes: route.graceMinutes,
        schedule: route.schedule,
        agents: route.agents,
      };
      const machine = createPatrolMachine(spec, now(), catchUpMs === undefined ? {} : { catchUpMs });
      machine.load(storedRuns(routeId));
      live.set(routeId, { routeId, deviceId: deviceOf(routeId), machine, points: new Set(route.checkpoints) });
    } catch (err) {
      console.error(`[patrols] circuit ${routeId} ignore (donnees illisibles) :`, err);
    }
  }

  /** Detail d'une ronde incomplete ou ratee : `N points manques : A, B, C, ...` ou `aucun point scanne (N points)`. */
  function describeMissing(routeId: number, missed: number[]): string | undefined {
    if (missed.length === 0) return undefined;
    const total = live.get(routeId)?.points.size ?? routeRecord(routeId)?.checkpoints.length ?? 0;
    if (total > 0 && missed.length >= total) return `aucun point scanne (${plural(total, 'point')})`;
    const names = missed.slice(0, 3).map((id) => checkpointRow(id)?.name ?? `point ${id}`);
    const more = missed.length > 3 ? ', ...' : '';
    return clipDetail(`${missed.length} ${missed.length > 1 ? 'points manques' : 'point manque'} : ${names.join(', ')}${more}`);
  }

  /** Le detecteur doit exister avant un evenement (un detecteur supprime a la main perdrait l'alarme) : on le recree au besoin. */
  function ensureDetector(routeId: number): void {
    if (engine.getDevice(deviceOf(routeId))) return;
    try {
      const route = routeRecord(routeId);
      if (route) syncDetector('systeme', route, true);
    } catch (err) {
      console.error(`[patrols] ${deviceOf(routeId)} : detecteur absent et impossible a recreer :`, err);
    }
  }

  function sendEvent(routeId: number, action: Extract<PatrolAction, { kind: 'event' }>): void {
    ensureDetector(routeId);
    const deviceId = deviceOf(routeId);
    if (action.event === 'clear') return void engine.handleDetectorMessage(deviceId, { event: 'clear' });
    // Pas de retrogradation : une ronde non faite (alarme) n'est pas ramenee a « incomplete » par un evenement plus faible.
    if (action.event === 'patrol_incomplete' && engine.getDevice(deviceId)?.status === 'alarm') return;
    const detail = describeMissing(routeId, action.missed);
    engine.handleDetectorMessage(deviceId, detail === undefined ? { event: action.event } : { event: action.event, detail });
  }

  /** Ecrit les actions de creation et d'etat des rondes (a appeler dans une transaction). */
  function persist(routeId: number, actions: PatrolAction[]): void {
    for (const a of actions) {
      if (a.kind === 'create') {
        db.prepare("INSERT OR IGNORE INTO patrol_run (route_id, due_start, due_end, status) VALUES (?, ?, ?, 'pending')").run(routeId, a.dueStart, a.dueEnd);
      } else if (a.kind === 'status') {
        db.prepare('UPDATE patrol_run SET status = ?, started_by = ?, started_at = ?, finished_at = ? WHERE route_id = ? AND due_start = ?').run(
          a.status, a.startedBy, a.startedAt, a.finishedAt, routeId, a.dueStart,
        );
      }
    }
  }

  function transaction(work: () => void): void {
    db.exec('BEGIN IMMEDIATE');
    try {
      work();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const dayText = (ts: number): string => new Date(ts).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

  /** Une entree d'audit par ronde terminee (faite ou ratee), jamais par scan. */
  function auditClosed(routeId: number, dueStart: number, status: string): void {
    const run = db.prepare('SELECT * FROM patrol_run WHERE route_id = ? AND due_start = ?').get(routeId, dueStart) as Row | undefined;
    if (!run) return;
    const route = routeRecord(routeId);
    const done = (db.prepare("SELECT COUNT(DISTINCT checkpoint_id) AS n FROM patrol_scan WHERE run_id = ? AND verdict = 'ok'").get(run.id as number) as { n: number }).n;
    const total = route?.checkpoints.length ?? 0;
    audit('systeme', 'patrol_run_closed', {
      deviceId: deviceOf(routeId),
      details: `${route?.name ?? `circuit ${routeId}`} : ronde de ${dayText(dueStart)} ${status === 'done' ? 'faite' : 'non faite'} (${done}/${total} points)`,
    });
  }

  /**
   * Applique les actions de la machine : les evenements partent AVANT l'ecriture en base (une coupure entre les deux rejoue
   * l'evenement, que le moteur fusionne dans l'incident ouvert, au lieu de perdre l'alarme), puis la base, puis l'audit.
   * `inside` : ecritures supplementaires dans la meme transaction (le scan).
   */
  function commit(routeId: number, actions: PatrolAction[], inside?: () => void): void {
    for (const a of actions) if (a.kind === 'event') sendEvent(routeId, a);
    transaction(() => {
      persist(routeId, actions);
      inside?.();
    });
    for (const a of actions) if (a.kind === 'status' && (a.status === 'done' || a.status === 'missed')) auditClosed(routeId, a.dueStart, a.status);
  }

  /**
   * Circuit desactive, archive ou remplace : `clear` si la machine avait leve une alerte, et les rondes encore ouvertes sont
   * closes sans evaluation (`missed`, rien n'est envoye) : sinon une reactivation les evaluerait pour une periode ou le circuit
   * etait arrete et declencherait une alarme fantome. Renvoie le nombre de rondes abandonnees.
   */
  function deactivate(routeId: number): number {
    const entry = live.get(routeId);
    live.delete(routeId);
    const actions = entry ? entry.machine.release(now()) : [];
    for (const a of actions) if (a.kind === 'event') sendEvent(routeId, a);
    if (actions.length === 0 && engine.getDevice(deviceOf(routeId)) && ringing(deviceOf(routeId))) engine.handleDetectorMessage(deviceOf(routeId), { event: 'clear' });
    const res = db.prepare("UPDATE patrol_run SET status = 'missed' WHERE route_id = ? AND status IN ('pending', 'active', 'incomplete')").run(routeId);
    return Number(res.changes);
  }

  // -- Points de controle ---------------------------------------------------------------------------------------------

  function checkpointView(row: CheckpointRow, withCode: boolean): CheckpointView {
    const view: CheckpointView = { id: row.id, name: row.name, zone: row.zone, floorId: row.floorId, x: row.x, y: row.y, archivedAt: row.archivedAt };
    if (withCode) view.code = row.code;
    return view;
  }

  function listCheckpoints(opts: { includeArchived?: boolean; withCode?: boolean } = {}): CheckpointView[] {
    const rows = db.prepare(`SELECT * FROM checkpoint ${opts.includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY id`).all() as Row[];
    return rows.map((r) => checkpointView(toCheckpoint(r), opts.withCode === true));
  }

  function getCheckpoint(id: number, withCode = true): CheckpointView | null {
    const row = checkpointRow(id);
    return row ? checkpointView(row, withCode) : null;
  }

  function uniqueCode(): string {
    for (let i = 0; i < 20; i++) {
      const code = randomCode(10);
      if (!db.prepare('SELECT 1 AS x FROM checkpoint WHERE code = ?').get(code)) return code;
    }
    throw new PsimError(500, 'Code d\'etiquette impossible a generer');
  }

  function cleanFloor(value: unknown): number {
    if (value === undefined) {
      const r = db.prepare('SELECT id FROM floor ORDER BY position, id LIMIT 1').get() as { id: number } | undefined;
      if (!r) throw new PsimError(500, 'Aucun etage : base incoherente');
      return r.id;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || !db.prepare('SELECT 1 AS x FROM floor WHERE id = ?').get(value)) throw new PsimError(400, 'Etage inconnu');
    return value;
  }

  /** Deux points actifs ne portent pas le meme nom : l'agent et le journal ne sauraient pas les distinguer. */
  function checkNameFree(name: string, exceptId: number): void {
    const wanted = name.toLocaleLowerCase('fr');
    for (const r of db.prepare('SELECT id, name FROM checkpoint WHERE archived_at IS NULL AND id <> ?').all(exceptId) as Row[]) {
      if ((r.name as string).toLocaleLowerCase('fr') === wanted) throw new PsimError(409, 'Un point de controle porte deja ce nom');
    }
  }

  function createCheckpoint(actor: string, input: unknown): CheckpointView {
    const body = bodyOf(input);
    only(body, ['name', 'zone', 'floorId', 'x', 'y']);
    const name = cleanName(own(body, 'name'), 'name');
    const zone = cleanZone(own(body, 'zone'));
    const floorId = cleanFloor(own(body, 'floorId'));
    const x = own(body, 'x') === undefined ? 50 : cleanPercent(own(body, 'x'), 'x');
    const y = own(body, 'y') === undefined ? 50 : cleanPercent(own(body, 'y'), 'y');
    checkNameFree(name, 0);
    const res = db.prepare('INSERT INTO checkpoint (name, zone, floor_id, x, y, code) VALUES (?, ?, ?, ?, ?, ?)').run(name, zone, floorId, x, y, uniqueCode());
    const id = Number(res.lastInsertRowid);
    audit(actor, 'checkpoint_created', { details: `${name}${zone ? ` (zone ${zone})` : ''}` });
    return getCheckpoint(id) as CheckpointView;
  }

  /** Les circuits actifs dont ce point est le premier : leur detecteur suit sa zone et sa position. */
  function resync(actor: string, checkpointId: number, moveToFirst: boolean): void {
    for (const r of db.prepare('SELECT * FROM patrol_route WHERE archived_at IS NULL').all() as Row[]) {
      const route = toRoute(r);
      if (route.checkpoints[0] !== checkpointId) continue;
      try {
        syncDetector(actor, route, moveToFirst);
      } catch (err) {
        console.error(`[patrols] ${deviceOf(route.id)} : synchronisation impossible :`, err);
      }
    }
  }

  function updateCheckpoint(actor: string, id: number, input: unknown): CheckpointView {
    const row = checkpointRow(id);
    if (!row || row.archivedAt !== null) throw new PsimError(404, 'Point de controle introuvable');
    const body = bodyOf(input);
    only(body, ['name', 'zone', 'floorId', 'x', 'y']);
    if (Object.keys(body).length === 0) throw new PsimError(400, 'Rien a modifier');
    const name = own(body, 'name') === undefined ? row.name : cleanName(own(body, 'name'), 'name');
    const zone = own(body, 'zone') === undefined ? row.zone : cleanZone(own(body, 'zone'));
    const floorId = own(body, 'floorId') === undefined ? row.floorId : cleanFloor(own(body, 'floorId'));
    const x = own(body, 'x') === undefined ? row.x : cleanPercent(own(body, 'x'), 'x');
    const y = own(body, 'y') === undefined ? row.y : cleanPercent(own(body, 'y'), 'y');
    if (name !== row.name) checkNameFree(name, id);
    const moved = floorId !== row.floorId || x !== row.x || y !== row.y;
    if (name === row.name && zone === row.zone && !moved) return checkpointView(row, true);
    db.prepare('UPDATE checkpoint SET name = ?, zone = ?, floor_id = ?, x = ?, y = ?, WHERE id = ?'.replace(', WHERE', ' WHERE')).run(name, zone, floorId, x, y, id);
    audit(actor, 'checkpoint_updated', { details: `${name}${name !== row.name ? ` (ancien nom : ${row.name})` : ''}${moved ? ' : deplace' : ''}` });
    resync(actor, id, moved);
    return getCheckpoint(id) as CheckpointView;
  }

  /** Archivage logique : jamais de suppression en dur (les passages passes y font reference). */
  function archiveCheckpoint(actor: string, id: number): void {
    const row = checkpointRow(id);
    if (!row || row.archivedAt !== null) throw new PsimError(404, 'Point de controle introuvable');
    for (const r of db.prepare('SELECT * FROM patrol_route WHERE archived_at IS NULL ORDER BY id').all() as Row[]) {
      const route = toRoute(r);
      if (route.checkpoints.includes(id)) throw new PsimError(409, `Ce point est utilise par le circuit « ${route.name} » : le retirer du circuit d'abord`);
    }
    db.prepare('UPDATE checkpoint SET archived_at = ? WHERE id = ?').run(now(), id);
    audit(actor, 'checkpoint_archived', { details: row.name });
  }

  function recodeCheckpoint(actor: string, id: number): CheckpointView {
    const row = checkpointRow(id);
    if (!row || row.archivedAt !== null) throw new PsimError(404, 'Point de controle introuvable');
    db.prepare('UPDATE checkpoint SET code = ? WHERE id = ?').run(uniqueCode(), id);
    // Le journal ne garde jamais le code, ni l'ancien ni le nouveau.
    audit(actor, 'checkpoint_recoded', { details: `${row.name} : etiquette a reimprimer, l'ancienne ne fonctionne plus` });
    return getCheckpoint(id) as CheckpointView;
  }

  // -- Circuits -------------------------------------------------------------------------------------------------------

  const routeView = (r: RouteRecord): RouteView => ({
    id: r.id,
    name: r.name,
    checkpoints: r.checkpoints,
    ordered: r.ordered,
    maxMinutes: r.maxMinutes,
    schedule: r.schedule,
    agents: r.agents,
    graceMinutes: r.graceMinutes,
    enabled: r.enabled,
    archivedAt: r.archivedAt,
    deviceId: deviceOf(r.id),
  });

  function listRoutes(opts: { includeArchived?: boolean } = {}): RouteView[] {
    const rows = db.prepare(`SELECT * FROM patrol_route ${opts.includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY id`).all() as Row[];
    return rows.map((r) => routeView(toRoute(r)));
  }

  function getRoute(id: number): RouteView | null {
    const r = routeRecord(id);
    return r ? routeView(r) : null;
  }

  function cleanRoutePoints(value: unknown): number[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROUTE_POINTS) throw new PsimError(400, `checkpoints : liste de 1 a ${MAX_ROUTE_POINTS} points de controle`);
    const ids: number[] = [];
    for (const id of value as unknown[]) {
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new PsimError(400, 'checkpoints : identifiants de points attendus');
      if (ids.includes(id)) throw new PsimError(400, 'Un point de controle ne peut figurer qu\'une fois dans un circuit');
      const row = checkpointRow(id);
      if (!row || row.archivedAt !== null) throw new PsimError(400, `Point de controle inconnu ou archive (n° ${id})`);
      ids.push(id);
    }
    return ids;
  }

  function cleanRouteAgents(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > MAX_ROUTE_AGENTS) throw new PsimError(400, `agents : liste de ${MAX_ROUTE_AGENTS} identifiants au plus (vide = tout agent en service)`);
    const out: string[] = [];
    for (const a of value as unknown[]) {
      if (typeof a !== 'string' || !agents.isAgent(a)) throw new PsimError(400, `Agent inconnu : « ${String(a).replace(/[^ -~]/g, '?').slice(0, 40)} »`);
      if (!out.includes(a)) out.push(a);
    }
    return out;
  }

  function cleanSchedule(value: unknown): Window[] {
    if (!Array.isArray(value) || value.length === 0) throw new PsimError(400, 'schedule : au moins une plage horaire est requise');
    return parseSchedule(value) as Window[];
  }

  const ROUTE_FIELDS = ['name', 'checkpoints', 'ordered', 'maxMinutes', 'schedule', 'agents', 'graceMinutes', 'enabled'];

  function createRoute(actor: string, input: unknown): RouteView {
    const body = bodyOf(input);
    only(body, ROUTE_FIELDS);
    const name = cleanName(own(body, 'name'), 'name');
    const points = cleanRoutePoints(own(body, 'checkpoints'));
    const ordered = own(body, 'ordered') === undefined ? false : cleanBool(own(body, 'ordered'), 'ordered');
    const maxMinutes = cleanInt(own(body, 'maxMinutes'), 'maxMinutes', 1, 1440);
    const schedule = cleanSchedule(own(body, 'schedule'));
    const agentList = own(body, 'agents') === undefined ? [] : cleanRouteAgents(own(body, 'agents'));
    const graceMinutes = own(body, 'graceMinutes') === undefined ? 10 : cleanInt(own(body, 'graceMinutes'), 'graceMinutes', 0, 240);
    const enabled = own(body, 'enabled') === undefined ? true : cleanBool(own(body, 'enabled'), 'enabled');

    // Identifiant : jamais celui d'un detecteur existant (un `P-n` conserve pour son historique d'incidents, par exemple).
    let id = (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM patrol_route').get() as { m: number }).m + 1;
    for (const d of db.prepare("SELECT id FROM device WHERE id LIKE 'P-%'").all() as Row[]) {
      const m = /^P-(\d+)$/.exec(d.id as string);
      if (m && Number(m[1]) >= id) id = Number(m[1]) + 1;
    }
    db.prepare(
      'INSERT INTO patrol_route (id, name, checkpoints, ordered, max_minutes, schedule, agents, grace_minutes, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, name, JSON.stringify(points), ordered ? 1 : 0, maxMinutes, JSON.stringify(schedule), JSON.stringify(agentList), graceMinutes, enabled ? 1 : 0);
    try {
      syncDetector(actor, routeRecord(id) as RouteRecord, true);
    } catch (err) {
      db.prepare('DELETE FROM patrol_route WHERE id = ?').run(id);
      if (engine.getDevice(deviceOf(id)) && incidentCount(deviceOf(id)) === 0) {
        try {
          engine.deleteDevice(actor, deviceOf(id));
        } catch {
          /* le detecteur reste : sans circuit, il est signale a l'ouverture suivante */
        }
      }
      throw err;
    }
    audit(actor, 'patrol_route_created', { deviceId: deviceOf(id), details: `${name} : ${plural(points.length, 'point')}${ordered ? ' dans l\'ordre' : ''}, ${maxMinutes} min${enabled ? '' : ', desactive'}` });
    rebuild(id, 0);
    return getRoute(id) as RouteView;
  }

  function updateRoute(actor: string, id: number, input: unknown): RouteView {
    const old = routeRecord(id);
    if (!old || old.archivedAt !== null) throw new PsimError(404, 'Circuit introuvable');
    const body = bodyOf(input);
    only(body, ROUTE_FIELDS);
    if (Object.keys(body).length === 0) throw new PsimError(400, 'Rien a modifier');
    const next: RouteRecord = {
      ...old,
      name: own(body, 'name') === undefined ? old.name : cleanName(own(body, 'name'), 'name'),
      checkpoints: own(body, 'checkpoints') === undefined ? old.checkpoints : cleanRoutePoints(own(body, 'checkpoints')),
      ordered: own(body, 'ordered') === undefined ? old.ordered : cleanBool(own(body, 'ordered'), 'ordered'),
      maxMinutes: own(body, 'maxMinutes') === undefined ? old.maxMinutes : cleanInt(own(body, 'maxMinutes'), 'maxMinutes', 1, 1440),
      schedule: own(body, 'schedule') === undefined ? old.schedule : cleanSchedule(own(body, 'schedule')),
      agents: own(body, 'agents') === undefined ? old.agents : cleanRouteAgents(own(body, 'agents')),
      graceMinutes: own(body, 'graceMinutes') === undefined ? old.graceMinutes : cleanInt(own(body, 'graceMinutes'), 'graceMinutes', 0, 240),
      enabled: own(body, 'enabled') === undefined ? old.enabled : cleanBool(own(body, 'enabled'), 'enabled'),
    };
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    const specChanged =
      !same(next.checkpoints, old.checkpoints) || next.ordered !== old.ordered || next.maxMinutes !== old.maxMinutes || !same(next.schedule, old.schedule) ||
      !same(next.agents, old.agents) || next.graceMinutes !== old.graceMinutes || next.enabled !== old.enabled;
    const renamed = next.name !== old.name;
    if (!specChanged && !renamed) return routeView(old);

    // Detecteur d'abord : si le moteur refuse le nom ou la zone, rien n'a encore change dans le circuit.
    syncDetector(actor, next, next.checkpoints[0] !== old.checkpoints[0]);
    db.prepare(
      'UPDATE patrol_route SET name = ?, checkpoints = ?, ordered = ?, max_minutes = ?, schedule = ?, agents = ?, grace_minutes = ?, enabled = ? WHERE id = ?',
    ).run(next.name, JSON.stringify(next.checkpoints), next.ordered ? 1 : 0, next.maxMinutes, JSON.stringify(next.schedule), JSON.stringify(next.agents), next.graceMinutes, next.enabled ? 1 : 0, id);

    let abandoned = 0;
    if (!next.enabled) {
      if (old.enabled || live.has(id)) abandoned = deactivate(id);
    } else if (specChanged) {
      rebuild(id, 0);
    }
    audit(actor, 'patrol_route_updated', {
      deviceId: deviceOf(id),
      details: `${next.name} : ${renamed ? `renomme (ancien nom : ${old.name}) ; ` : ''}${plural(next.checkpoints.length, 'point')}${next.ordered ? ' dans l\'ordre' : ''}, ${next.maxMinutes} min${next.enabled ? '' : ', desactive'}${abandoned > 0 ? ` ; ${plural(abandoned, 'ronde')} en cours abandonnee(s)` : ''}`,
    });
    return getRoute(id) as RouteView;
  }

  /** Archivage logique ; le detecteur `P-` est supprime s'il n'a aucun incident, sinon laisse tel quel. */
  function archiveRoute(actor: string, id: number): void {
    const route = routeRecord(id);
    if (!route || route.archivedAt !== null) throw new PsimError(404, 'Circuit introuvable');
    const abandoned = deactivate(id);
    db.prepare('UPDATE patrol_route SET archived_at = ?, enabled = 0 WHERE id = ?').run(now(), id);
    let removed = false;
    const deviceId = deviceOf(id);
    if (engine.getDevice(deviceId) && incidentCount(deviceId) === 0) {
      try {
        engine.deleteDevice(actor, deviceId);
        removed = true;
      } catch (err) {
        console.warn(`[patrols] ${deviceId} : suppression impossible :`, err);
      }
    }
    audit(actor, 'patrol_route_archived', {
      deviceId: removed ? undefined : deviceId,
      details: `${route.name}${abandoned > 0 ? ` : ${plural(abandoned, 'ronde')} en cours abandonnee(s)` : ''}${removed ? '' : ' : detecteur conserve (historique d\'incidents)'}`,
    });
  }

  // -- Lecture : rondes, passages, main courante (journal, rapports du lot S4) ----------------------------------------

  /** Caches d'une lecture : un meme point ou circuit n'est lu qu'une fois. */
  function lookups() {
    const cps = new Map<number, CheckpointRow | null>();
    const routes = new Map<number, RouteRecord | null>();
    return {
      cp(id: number): CheckpointRow | null {
        if (!cps.has(id)) cps.set(id, checkpointRow(id));
        return cps.get(id) ?? null;
      },
      route(id: number): RouteRecord | null {
        if (!routes.has(id)) routes.set(id, routeRecord(id));
        return routes.get(id) ?? null;
      },
    };
  }
  type Lookups = ReturnType<typeof lookups>;

  const scansOfRun = (runId: number): ScanRow[] => (db.prepare('SELECT * FROM patrol_scan WHERE run_id = ? ORDER BY server_at, id').all(runId) as Row[]).map(toScan);

  function scanView(s: ScanRow, L: Lookups): ScanView {
    return {
      id: s.id,
      runId: s.runId,
      checkpointId: s.checkpointId,
      checkpointName: L.cp(s.checkpointId)?.name ?? `Point ${s.checkpointId}`,
      username: s.username,
      displayName: displayName(s.username),
      method: s.method,
      phoneAt: s.phoneAt,
      serverAt: s.serverAt,
      deferred: s.deferred,
      verdict: s.verdict,
    };
  }

  /** Points de la ronde : ceux du circuit (dans l'ordre), puis ceux deja faits qui n'en font plus partie (circuit modifie depuis). */
  function runPoints(run: RunRow, scans: ScanRow[], L: Lookups) {
    const route = L.route(run.routeId);
    const doneAt = new Map<number, number>();
    for (const s of scans) {
      if (s.verdict !== 'ok') continue;
      const at = effectiveAt(s);
      if (!doneAt.has(s.checkpointId) || at < (doneAt.get(s.checkpointId) as number)) doneAt.set(s.checkpointId, at);
    }
    const ids = [...(route?.checkpoints ?? [])];
    for (const id of [...doneAt.keys()].sort((a, b) => (doneAt.get(a) as number) - (doneAt.get(b) as number))) if (!ids.includes(id)) ids.push(id);
    return ids.map((id) => {
      const cp = L.cp(id);
      return { id, name: cp?.name ?? `Point ${id}`, zone: cp?.zone ?? '', done: doneAt.has(id), doneAt: doneAt.get(id) ?? null };
    });
  }

  function agentRunView(run: RunRow, scans: ScanRow[], L: Lookups): AgentRun {
    const route = L.route(run.routeId);
    return {
      id: run.id,
      routeId: run.routeId,
      name: route?.name ?? `Circuit ${run.routeId}`,
      status: run.status,
      dueStart: run.dueStart,
      dueEnd: run.dueEnd,
      ordered: route?.ordered ?? false,
      checkpoints: runPoints(run, scans, L),
    };
  }

  function runDetail(run: RunRow, L: Lookups): RunDetail {
    const scans = scansOfRun(run.id);
    const base = agentRunView(run, scans, L);
    return {
      ...base,
      routeName: base.name,
      startedBy: run.startedBy,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      scans: scans.map((s) => scanView(s, L)),
      doneCount: base.checkpoints.filter((c) => c.done).length,
      totalCount: base.checkpoints.length,
      missing: base.checkpoints.filter((c) => !c.done).map((c) => c.name),
    };
  }

  /**
   * Rondes dont le debut tombe dans `[from, to]`, du debut le plus ancien au plus recent, avec leurs passages, points faits et
   * manquants. `username` : rondes ou cet agent a au moins un passage. Plafonne a 2000 rondes.
   */
  function runsBetween(from: number, to: number, filter: { routeId?: number; username?: string } = {}): RunDetail[] {
    const where = ['due_start >= ?', 'due_start <= ?'];
    const args: (string | number)[] = [from, to];
    if (filter.routeId !== undefined) {
      where.push('route_id = ?');
      args.push(filter.routeId);
    }
    if (filter.username !== undefined) {
      where.push('EXISTS (SELECT 1 FROM patrol_scan s WHERE s.run_id = patrol_run.id AND s.username = ?)');
      args.push(filter.username);
    }
    const rows = db.prepare(`SELECT * FROM patrol_run WHERE ${where.join(' AND ')} ORDER BY due_start, id LIMIT ${MAX_ROWS}`).all(...args) as Row[];
    const L = lookups();
    return rows.map((r) => runDetail(toRun(r), L));
  }

  /** Passages (tous verdicts) dont l'heure serveur tombe dans `[from, to]`, du plus ancien au plus recent. */
  function scansBetween(from: number, to: number, filter: { username?: string; routeId?: number; checkpointId?: number; limit?: number } = {}): ScanView[] {
    const where = ['s.server_at >= ?', 's.server_at <= ?'];
    const args: (string | number)[] = [from, to];
    if (filter.username !== undefined) {
      where.push('s.username = ?');
      args.push(filter.username);
    }
    if (filter.checkpointId !== undefined) {
      where.push('s.checkpoint_id = ?');
      args.push(filter.checkpointId);
    }
    if (filter.routeId !== undefined) {
      where.push('EXISTS (SELECT 1 FROM patrol_run r WHERE r.id = s.run_id AND r.route_id = ?)');
      args.push(filter.routeId);
    }
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? MAX_ROWS) || MAX_ROWS, 1), 20_000);
    const rows = db.prepare(`SELECT s.* FROM patrol_scan s WHERE ${where.join(' AND ')} ORDER BY s.server_at, s.id LIMIT ${limit}`).all(...args) as Row[];
    const L = lookups();
    return rows.map((r) => scanView(toScan(r), L));
  }

  function logbookView(r: Row, L: Lookups): LogbookView {
    const checkpointId = (r.checkpoint_id as number | null) ?? null;
    return {
      id: r.id as number,
      username: r.username as string,
      displayName: displayName(r.username as string),
      category: r.category as string,
      text: r.text as string,
      checkpointId,
      checkpointName: checkpointId === null ? '' : (L.cp(checkpointId)?.name ?? `Point ${checkpointId}`),
      hasPhoto: typeof r.photo_file === 'string' && r.photo_file !== '',
      phoneAt: r.phone_at as number,
      serverAt: r.server_at as number,
      deferred: r.deferred === 1,
      incidentId: (r.incident_id as number | null) ?? null,
    };
  }

  /** Main courante dont l'heure serveur tombe dans `[from, to]`, de la plus recente a la plus ancienne (2000 entrees au plus). */
  function logbookBetween(from: number, to: number, filter: { username?: string } = {}): LogbookView[] {
    const where = ['server_at >= ?', 'server_at <= ?'];
    const args: (string | number)[] = [from, to];
    if (filter.username !== undefined) {
      where.push('username = ?');
      args.push(filter.username);
    }
    const rows = db.prepare(`SELECT * FROM logbook_entry WHERE ${where.join(' AND ')} ORDER BY server_at DESC, id DESC LIMIT ${MAX_ROWS}`).all(...args) as Row[];
    const L = lookups();
    return rows.map((r) => logbookView(r, L));
  }

  /** Agents EN SERVICE seulement (le service des agents ne garde la position que pendant le service), avec le point et sa place sur le plan. */
  function positions(): PositionView[] {
    const out: PositionView[] = [];
    for (const p of agents.positions()) {
      const cp = checkpointRow(p.checkpointId);
      if (!cp) continue;
      out.push({ username: p.username, displayName: p.displayName, checkpointId: p.checkpointId, name: cp.name, floorId: cp.floorId, x: cp.x, y: cp.y, at: p.at });
    }
    return out;
  }

  /**
   * Rondes a montrer a l'agent : en cours, a venir ou encore rattrapables (`incomplete`, delai de grace) de ses circuits, puis
   * la prochaine ronde a venir (qui n'existe pas encore : `id` 0, `status` `pending`).
   */
  function runsFor(username: string): AgentRun[] {
    const t = now();
    const L = lookups();
    const concerns = (route: RouteRecord | null): route is RouteRecord => route !== null && route.archivedAt === null && route.enabled && (route.agents.length === 0 || route.agents.includes(username));
    const rows = db
      .prepare("SELECT * FROM patrol_run WHERE status IN ('pending', 'active', 'incomplete') AND due_start >= ? ORDER BY due_start, id")
      .all(t - DAY) as Row[];
    const out: AgentRun[] = [];
    for (const r of rows) {
      const run = toRun(r);
      if (!concerns(L.route(run.routeId))) continue;
      out.push(agentRunView(run, (db.prepare('SELECT * FROM patrol_scan WHERE run_id = ? ORDER BY id').all(run.id) as Row[]).map(toScan), L));
    }
    let next: { routeId: number; start: number } | null = null;
    for (const r of db.prepare('SELECT * FROM patrol_route WHERE archived_at IS NULL AND enabled = 1 ORDER BY id').all() as Row[]) {
      const route = toRoute(r);
      if (!concerns(route)) continue;
      try {
        const start = windowStarts(route.schedule, t + 1, t + 8 * DAY).find((s) => !db.prepare('SELECT 1 AS x FROM patrol_run WHERE route_id = ? AND due_start = ?').get(route.id, s));
        if (start !== undefined && (next === null || start < next.start)) next = { routeId: route.id, start };
      } catch {
        /* planning illisible : pas de prochaine ronde pour ce circuit */
      }
    }
    if (next !== null) {
      const route = L.route(next.routeId) as RouteRecord;
      const virtual: RunRow = { id: 0, routeId: next.routeId, dueStart: next.start, dueEnd: next.start + route.maxMinutes * MIN, status: 'pending', startedBy: null, startedAt: null, finishedAt: null };
      out.push(agentRunView(virtual, [], L));
    }
    return out;
  }

  // -- Passages (scans) -----------------------------------------------------------------------------------------------

  function cleanClientId(value: unknown): string {
    if (typeof value !== 'string' || !CLIENT_ID.test(value)) throw new PsimError(400, 'clientId invalide (8 a 64 caracteres : lettres, chiffres, . _ : -)');
    return value;
  }

  /** Heure du telephone : jamais plus de 5 min dans le futur ni de 24 h dans le passe. */
  function cleanPhoneAt(value: unknown, t: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new PsimError(400, 'phoneAt invalide (heure du telephone en millisecondes)');
    const at = Math.trunc(value);
    if (at > t + PHONE_AHEAD_MS || at < t - PHONE_BEHIND_MS) {
      throw new PsimError(400, 'Heure du telephone invalide : plus de 5 min dans le futur ou plus de 24 h dans le passe (verifier la date du telephone)');
    }
    return at;
  }

  /** Champ facultatif `username` d'un envoi (agent precedent sur un telephone partage) : texte court ou absent. */
  function cleanClaimed(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || value.length > 64) throw new PsimError(400, 'username invalide');
    return value;
  }

  /** Agent a qui attribuer l'envoi : la session, ou l'agent precedent du meme telephone (agents.resolveSender, 403 sinon). */
  function senderOf(phoneId: number, sessionUsername: string, claimed: string | undefined, phoneAt: number): string {
    if (claimed === undefined || claimed === sessionUsername) return sessionUsername;
    return agents.resolveSender(phoneId, sessionUsername, claimed, phoneAt);
  }

  function scanResponse(s: ScanRow): ScanResponse {
    const L = lookups();
    const runRow = s.runId === null ? undefined : (db.prepare('SELECT * FROM patrol_run WHERE id = ?').get(s.runId) as Row | undefined);
    const cp = L.cp(s.checkpointId);
    return {
      scan: {
        verdict: s.verdict,
        checkpoint: { id: s.checkpointId, name: cp?.name ?? `Point ${s.checkpointId}` },
        run: runRow ? agentRunView(toRun(runRow), scansOfRun(runRow.id as number), L) : null,
        deferred: s.deferred,
      },
    };
  }

  /**
   * Un passage d'agent. Idempotent : un `clientId` deja recu renvoie la meme reponse (recalculee depuis la ligne enregistree).
   * Le code doit etre celui d'un point non archive (404 sinon). Tout code reconnu est enregistre, meme sans ronde ou hors
   * circuit (la trace est la preuve), et met a jour la position de l'agent.
   */
  function scan(sessionUsername: string, phoneId: number, input: unknown): ScanResponse {
    const body = bodyOf(input);
    const clientId = cleanClientId(own(body, 'clientId'));
    const claimed = cleanClaimed(own(body, 'username'));
    const previous = db.prepare('SELECT * FROM patrol_scan WHERE client_id = ?').get(clientId) as Row | undefined;
    if (previous) {
      const row = toScan(previous);
      if (row.username !== sessionUsername && row.username !== claimed) throw new PsimError(409, 'Identifiant d\'envoi deja utilise');
      return scanResponse(row);
    }
    const method = own(body, 'method');
    if (typeof method !== 'string' || !METHODS.includes(method)) throw new PsimError(400, 'method invalide (nfc, qr ou manual)');
    const t = now();
    const phoneAt = cleanPhoneAt(own(body, 'phoneAt'), t);
    const username = senderOf(phoneId, sessionUsername, claimed, phoneAt);
    const rawCode = own(body, 'code');
    const code = typeof rawCode === 'string' ? rawCode.trim().toLowerCase() : '';
    const found = LABEL_CODE.test(code) ? (db.prepare('SELECT * FROM checkpoint WHERE code = ? AND archived_at IS NULL').get(code) as Row | undefined) : undefined;
    if (!found) throw new PsimError(404, 'Etiquette inconnue');
    const cp = toCheckpoint(found);

    const deferred = t - phoneAt > DEFERRED_AFTER_MS;
    const at = deferred ? phoneAt : t;

    // Chaque circuit actif examine le scan ; le meilleur verdict gagne. Un `ok` arrete l'examen (la machine qui l'accepte est
    // modifiee : un point commun a deux circuits en cours ne compte que pour le premier, celui qui le contient, a id le plus petit).
    let best: { verdict: ScanVerdict; routeId: number | null; dueStart: number | null; actions: PatrolAction[] } = { verdict: 'no_run', routeId: null, dueStart: null, actions: [] };
    const order = [...live.values()].sort((a, b) => Number(b.points.has(cp.id)) - Number(a.points.has(cp.id)) || a.routeId - b.routeId);
    for (const entry of order) {
      let result;
      try {
        result = entry.machine.scan(t, { checkpointId: cp.id, username, at, deferred });
      } catch (err) {
        console.error(`[patrols] circuit ${entry.routeId} : scan :`, err);
        continue;
      }
      if (result.verdict === 'ok') {
        best = { verdict: 'ok', routeId: entry.routeId, dueStart: result.dueStart, actions: result.actions };
        break;
      }
      if (RANK[result.verdict] > RANK[best.verdict]) best = { verdict: result.verdict, routeId: entry.routeId, dueStart: result.dueStart, actions: result.actions };
    }

    const insert = (): void => {
      let runId: number | null = null;
      if (best.routeId !== null && best.dueStart !== null) {
        const run = db.prepare('SELECT id FROM patrol_run WHERE route_id = ? AND due_start = ?').get(best.routeId, best.dueStart) as { id: number } | undefined;
        runId = run?.id ?? null;
      }
      db.prepare(
        'INSERT INTO patrol_scan (client_id, run_id, checkpoint_id, username, phone_id, method, phone_at, server_at, deferred, verdict) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(clientId, runId, cp.id, username, phoneId, method, phoneAt, t, deferred ? 1 : 0, best.verdict);
    };
    try {
      if (best.routeId !== null) commit(best.routeId, best.actions, insert);
      else transaction(insert);
    } catch (err) {
      // La machine a deja pris le scan en compte : on la resynchronise avec la base (ou le scan n'est pas).
      if (best.routeId !== null) rebuild(best.routeId);
      throw err;
    }

    // Position : le dernier point reconnu. Un scan differe (plus ancien) ne ramene pas l'agent en arriere.
    try {
      const known = agents.positions().find((p) => p.username === username);
      if (!deferred || !known || known.at <= at) agents.setPosition(username, cp.id, at);
    } catch (err) {
      console.error('[patrols] position de l\'agent :', err);
    }
    const stored = db.prepare('SELECT * FROM patrol_scan WHERE client_id = ?').get(clientId) as Row;
    return scanResponse(toScan(stored));
  }

  // -- Main courante --------------------------------------------------------------------------------------------------

  /** Une entree de la main courante, avec photo JPEG facultative. Idempotent par `clientId`. */
  function addLogbook(sessionUsername: string, phoneId: number, input: unknown): { entry: { id: number } } {
    const body = bodyOf(input);
    const clientId = cleanClientId(own(body, 'clientId'));
    const claimed = cleanClaimed(own(body, 'username'));
    const previous = db.prepare('SELECT id, username FROM logbook_entry WHERE client_id = ?').get(clientId) as { id: number; username: string } | undefined;
    if (previous) {
      if (previous.username !== sessionUsername && previous.username !== claimed) throw new PsimError(409, 'Identifiant d\'envoi deja utilise');
      return { entry: { id: previous.id } };
    }
    const category = own(body, 'category');
    if (typeof category !== 'string' || !LOG_CATEGORIES.includes(category)) throw new PsimError(400, 'category invalide (anomaly, damage, visitor ou other)');
    const text = cleanLogText(own(body, 'text'));
    const t = now();
    const phoneAt = cleanPhoneAt(own(body, 'phoneAt'), t);
    const username = senderOf(phoneId, sessionUsername, claimed, phoneAt);
    let checkpointId: number | null = null;
    const rawCp = own(body, 'checkpointId');
    if (rawCp !== undefined && rawCp !== null) {
      if (typeof rawCp !== 'number' || !Number.isSafeInteger(rawCp) || !checkpointRow(rawCp)) throw new PsimError(400, 'Point de controle inconnu');
      checkpointId = rawCp;
    }
    const photo = own(body, 'photo') === undefined || own(body, 'photo') === null ? null : decodePhoto(own(body, 'photo'));
    const deferred = t - phoneAt > DEFERRED_AFTER_MS ? 1 : 0;

    // La ligne et la photo vont ensemble : sans photo ecrite, la ligne n'existe pas (la nouvelle tentative du telephone recommence).
    let id = 0;
    let finalPath: string | null = null;
    transaction(() => {
      const res = db
        .prepare('INSERT INTO logbook_entry (client_id, username, category, text, checkpoint_id, phone_at, server_at, deferred) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(clientId, username, category, text, checkpointId, phoneAt, t, deferred);
      id = Number(res.lastInsertRowid);
      if (photo) {
        // Le nom du fichier ne vient jamais du client : c'est l'identifiant de la ligne.
        const file = `${id}.jpg`;
        finalPath = join(logbookDir, file);
        const tmp = `${finalPath}.tmp`;
        writeFileSync(tmp, photo);
        renameSync(tmp, finalPath);
        db.prepare('UPDATE logbook_entry SET photo_file = ?, photo_sha256 = ? WHERE id = ?').run(file, sha256hex(photo), id);
      }
    });
    return { entry: { id } };
  }

  function logbookPhoto(id: number): Buffer {
    const r = db.prepare('SELECT photo_file, photo_sha256 FROM logbook_entry WHERE id = ?').get(id) as { photo_file: string | null; photo_sha256: string | null } | undefined;
    if (!r || !r.photo_file || r.photo_file !== `${id}.jpg`) throw new PsimError(404, 'Photo introuvable');
    const path = join(logbookDir, r.photo_file);
    if (!existsSync(path)) throw new PsimError(404, 'Photo introuvable');
    const data = readFileSync(path);
    if (sha256hex(data) !== r.photo_sha256) {
      console.error(`[patrols] photo de la main courante ${id} : empreinte differente de celle enregistree`);
      throw new PsimError(500, 'Photo alteree : empreinte differente de celle enregistree');
    }
    return data;
  }

  /** Le chef de poste fait un incident d'une entree : evenement `logbook_report` sur le detecteur `A-<agent>`. */
  function logbookToIncident(actor: string, id: number): { incidentId: number } {
    const r = db.prepare('SELECT * FROM logbook_entry WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new PsimError(404, 'Entree introuvable');
    if ((r.incident_id as number | null) !== null) throw new PsimError(409, 'Cette entree est deja un incident');
    const username = r.username as string;
    if (!agents.isAgent(username)) throw new PsimError(409, 'Cet agent n\'existe plus');
    const deviceId = agents.detectorId(username);
    // Une alarme en cours sur l'agent (SOS) ne serait pas a remplacer par un simple signalement : elle passe d'abord.
    if (engine.getDevice(deviceId)?.status === 'alarm') throw new PsimError(409, 'Un incident est deja ouvert pour cet agent (alarme en cours) : le traiter d\'abord');
    const label = LOG_CATEGORY_LABEL[r.category as string] ?? 'Autre';
    engine.handleDetectorMessage(deviceId, { event: 'logbook_report', detail: clipDetail(`${label} : ${r.text as string}`) });
    const open = db.prepare("SELECT id FROM incident WHERE detector_id = ? AND status <> 'closed' ORDER BY id DESC LIMIT 1").get(deviceId) as { id: number } | undefined;
    if (!open) throw new PsimError(500, 'Incident non cree');
    db.prepare('UPDATE logbook_entry SET incident_id = ? WHERE id = ? AND incident_id IS NULL').run(open.id, id);
    audit(actor, 'logbook_incident_created', { incidentId: open.id, deviceId, details: `entree n° ${id} de ${displayName(username)} (${label})` });
    return { incidentId: open.id };
  }

  // -- Temps, conservation ------------------------------------------------------------------------------------------

  /** Efface scans, rondes et main courante (photos comprises) de plus de 400 jours. Renvoie les nombres effaces. */
  function purge(at = now()): { scans: number; runs: number; entries: number } {
    const cutoff = at - RETENTION_DAYS * DAY;
    const old = db.prepare('SELECT id, photo_file FROM logbook_entry WHERE server_at < ?').all(cutoff) as { id: number; photo_file: string | null }[];
    for (const e of old) {
      if (e.photo_file && e.photo_file === `${e.id}.jpg`) {
        try {
          unlinkSync(join(logbookDir, e.photo_file));
        } catch {
          /* deja absente */
        }
      }
    }
    const entries = Number(db.prepare('DELETE FROM logbook_entry WHERE server_at < ?').run(cutoff).changes);
    const scans = Number(db.prepare('DELETE FROM patrol_scan WHERE server_at < ?').run(cutoff).changes);
    const runs = Number(db.prepare("DELETE FROM patrol_run WHERE due_end < ? AND status IN ('done', 'incomplete', 'missed')").run(cutoff).changes);
    if (scans + runs + entries > 0) {
      audit('systeme', 'patrol_purged', { details: `conservation ${RETENTION_DAYS} jours : ${plural(scans, 'passage')}, ${plural(runs, 'ronde')}, ${plural(entries, 'entree', 'entrees')} de main courante effaces` });
    }
    return { scans, runs, entries };
  }

  let lastPurge = -Infinity;

  /** A appeler chaque seconde : fait avancer chaque circuit, libere les alarmes prises en charge, purge une fois par heure. */
  function tick(): void {
    const t = now();
    for (const entry of [...live.values()]) {
      try {
        commit(entry.routeId, entry.machine.tick(t));
      } catch (err) {
        console.error(`[patrols] circuit ${entry.routeId} : tick :`, err);
        rebuild(entry.routeId); // la machine a avance sans que la base le sache : on repart de la base
      }
    }
    try {
      releaseAck(db, engine, 'P-');
    } catch (err) {
      console.error('[patrols] liberation des alarmes acquittees :', err);
    }
    if (t - lastPurge >= HOUR) {
      lastPurge = t;
      try {
        purge(t);
      } catch (err) {
        console.error('[patrols] conservation :', err);
      }
    }
  }

  // -- Demarrage : reconciliation -----------------------------------------------------------------------------------

  for (const r of db.prepare('SELECT id FROM patrol_route WHERE archived_at IS NULL ORDER BY id').all() as { id: number }[]) {
    try {
      const route = routeRecord(r.id);
      if (route && route.enabled && !engine.getDevice(deviceOf(r.id)) && route.checkpoints.length > 0) syncDetector('systeme', route, true);
    } catch (err) {
      console.error(`[patrols] ${deviceOf(r.id)} : detecteur impossible a recreer :`, err);
    }
    rebuild(r.id);
  }

  // -- Routes HTTP --------------------------------------------------------------------------------------------------

  const historyReads = new Map<string, number>();

  /** Lecture de l'historique des passages : tracee dans l'audit (limitee a une entree toutes les 10 min par lecteur et par filtre). */
  function auditHistoryRead(actor: string, from: number, to: number, filter: { routeId?: number; username?: string }): void {
    const t = now();
    const key = `${actor}|${filter.routeId ?? ''}|${filter.username ?? ''}`;
    const last = historyReads.get(key);
    if (last !== undefined && t - last < HISTORY_AUDIT_EVERY_MS) return;
    if (historyReads.size > 500) historyReads.clear();
    historyReads.set(key, t);
    audit(actor, 'patrol_history_read', {
      details: `passages du ${dayText(from)} au ${dayText(to)}${filter.username ? ` : agent ${filter.username}` : ''}${filter.routeId !== undefined ? ` : circuit ${filter.routeId}` : ''}`,
    });
  }

  function mount(app: Express, ctx: MountContext): void {
    const { adminOnly, staff } = ctx;
    const small = ctx.json('8kb');
    const idOf = (req: Request, notFound: string): number => parseId(req.params.id, notFound);
    const SVG_HEADERS = { 'Content-Type': 'image/svg+xml', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'Cache-Control': 'no-store' };

    // Points de controle : lecture pour l'exploitation (sans le code de l'etiquette), ecriture pour l'administrateur.
    app.get('/api/patrols/checkpoints', staff, (req, res) => {
      res.json(listCheckpoints({ includeArchived: req.query.archived === '1', withCode: ctx.roleOf(req) === 'admin' }));
    });
    // Origine ecrite dans les etiquettes (PSIM_PUBLIC_URL, a defaut l'adresse de la requete) : la meme que celle du QR.
    // L'ecran la lit pour afficher l'adresse a ecrire dans une etiquette NFC, au lieu de l'adresse tapee dans le navigateur.
    app.get('/api/patrols/label-origin', adminOnly, (req, res) => {
      res.set('Cache-Control', 'no-store').json({ origin: ctx.originOf(req) });
    });
    app.post('/api/patrols/checkpoints', adminOnly, small, (req, res) => {
      res.status(201).json(createCheckpoint(ctx.actorOf(req), req.body));
    });
    app.patch('/api/patrols/checkpoints/:id', adminOnly, small, (req, res) => {
      res.json(updateCheckpoint(ctx.actorOf(req), idOf(req, 'Point de controle introuvable'), req.body));
    });
    app.delete('/api/patrols/checkpoints/:id', adminOnly, (req, res) => {
      archiveCheckpoint(ctx.actorOf(req), idOf(req, 'Point de controle introuvable'));
      res.status(204).end();
    });
    app.post('/api/patrols/checkpoints/:id/recode', adminOnly, (req, res) => {
      res.json(recodeCheckpoint(ctx.actorOf(req), idOf(req, 'Point de controle introuvable')));
    });
    app.get('/api/patrols/checkpoints/:id/qr.svg', adminOnly, async (req, res) => {
      const row = checkpointRow(idOf(req, 'Point de controle introuvable'));
      if (!row || row.archivedAt !== null) throw new PsimError(404, 'Point de controle introuvable');
      const svg = await QRCode.toString(`${ctx.originOf(req)}/agent/#cp=${row.code}`, { type: 'svg', margin: 1, width: 260 });
      res.set(SVG_HEADERS).send(svg);
    });

    // Circuits.
    app.get('/api/patrols/routes', staff, (req, res) => {
      res.json(listRoutes({ includeArchived: req.query.archived === '1' }));
    });
    app.post('/api/patrols/routes', adminOnly, small, (req, res) => {
      res.status(201).json(createRoute(ctx.actorOf(req), req.body));
    });
    app.patch('/api/patrols/routes/:id', adminOnly, small, (req, res) => {
      res.json(updateRoute(ctx.actorOf(req), idOf(req, 'Circuit introuvable'), req.body));
    });
    app.delete('/api/patrols/routes/:id', adminOnly, (req, res) => {
      archiveRoute(ctx.actorOf(req), idOf(req, 'Circuit introuvable'));
      res.status(204).end();
    });

    // Journal : rondes et passages (tracees dans l'audit), main courante, positions.
    app.get('/api/patrols/runs', staff, (req, res) => {
      const t = now();
      const to = cleanTime(req.query.to, 'to', t);
      const from = cleanTime(req.query.from, 'from', to - DAY);
      if (from > to) throw new PsimError(400, 'Periode invalide : le debut doit preceder la fin');
      const filter: { routeId?: number; username?: string } = {};
      if (req.query.routeId !== undefined && req.query.routeId !== '') {
        const raw = String(req.query.routeId);
        if (!/^\d{1,12}$/.test(raw)) throw new PsimError(400, 'Parametre « routeId » invalide');
        filter.routeId = Number(raw);
      }
      if (req.query.username !== undefined && req.query.username !== '') {
        const raw = req.query.username;
        if (typeof raw !== 'string' || raw.length > 64) throw new PsimError(400, 'Parametre « username » invalide');
        filter.username = raw;
      }
      auditHistoryRead(ctx.actorOf(req), from, to, filter);
      res.json({ runs: runsBetween(from, to, filter) });
    });
    app.get('/api/patrols/logbook', staff, (req, res) => {
      const t = now();
      const to = cleanTime(req.query.to, 'to', t);
      const from = cleanTime(req.query.from, 'from', to - DAY);
      if (from > to) throw new PsimError(400, 'Periode invalide : le debut doit preceder la fin');
      res.json({ entries: logbookBetween(from, to) });
    });
    app.get('/api/patrols/logbook/:id/photo', staff, (req, res) => {
      const data = logbookPhoto(idOf(req, 'Photo introuvable'));
      res.set({
        'Content-Type': 'image/jpeg',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private',
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': String(data.length),
      });
      res.end(data);
    });
    app.post('/api/patrols/logbook/:id/incident', staff, (req, res) => {
      res.json(logbookToIncident(ctx.actorOf(req), idOf(req, 'Entree introuvable')));
    });
    app.get('/api/patrols/positions', staff, (_req, res) => {
      res.json(positions());
    });

    // Application des agents : telephone appaire et session d'agent exiges (agents.requireAgent), jamais d'autre acces.
    const noStore = (res: { setHeader(name: string, value: string): unknown }): void => void res.setHeader('Cache-Control', 'no-store');
    app.get('/api/agent/runs', agents.requireAgent, (req, res) => {
      noStore(res);
      res.json({ runs: runsFor(agents.agentOf(req).username), serverAt: now() });
    });
    app.post('/api/agent/scans', agents.requireAgent, ctx.json('2kb'), (req, res) => {
      noStore(res);
      const a = agents.agentOf(req);
      res.json(scan(a.username, a.phoneId, req.body));
    });
    app.post('/api/agent/logbook', agents.requireAgent, ctx.json('600kb'), (req, res) => {
      noStore(res);
      const a = agents.agentOf(req);
      res.json(addLogbook(a.username, a.phoneId, req.body));
    });
  }

  return {
    // points et circuits
    listCheckpoints,
    getCheckpoint,
    createCheckpoint,
    updateCheckpoint,
    archiveCheckpoint,
    recodeCheckpoint,
    listRoutes,
    getRoute,
    createRoute,
    updateRoute,
    archiveRoute,
    // temps et passages
    tick,
    scan,
    runsFor,
    // main courante
    addLogbook,
    logbookPhoto,
    logbookToIncident,
    // lecture (journal, rapports du lot S4)
    runsBetween,
    scansBetween,
    logbookBetween,
    positions,
    purge,
    mount,
  };
}

export type Patrols = ReturnType<typeof createPatrols>;
