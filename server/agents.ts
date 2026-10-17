import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { Express, Request, RequestHandler, Response } from 'express';
import QRCode from 'qrcode';
import { createSession, destroyPhoneSessions, destroySession, destroyUserSessions, isRateLimited, parseCookies, recordFailure } from './auth.ts';
import type { Engine } from './engine.ts';
import { PsimError } from './errors.ts';
import { MSG_ID_PATTERN } from './ingestmeta.ts';
import { CATEGORY_LABEL, eventLabel } from './sources.ts';
import { hasForbiddenChar, normalizeName } from './text.ts';
import type { AgentAlarm, AgentMe, Incident, MountContext } from './types.ts';
import type { UsersService } from './users.ts';

/**
 * Agents de terrain (application mobile) : profils, telephones appaires, service, alarmes et SOS.
 * Contrat : docs/AGENTS-RONDES.md ; choix d'implementation communs au lot S1.
 *
 *  - un agent est un compte `app_user` de role `agent` (mot de passe aleatoire, jamais utilise) + un profil (code personnel, zones) ;
 *  - le telephone est APPAIRE une fois par un code a usage unique (15 min) lu dans un QR ; il recoit alors une cle propre dans un
 *    cookie HttpOnly `psim_phone` (seule l'empreinte SHA-256 est stockee, comparaison en temps constant, revocation immediate) ;
 *  - sur un telephone appaire, l'agent touche son nom puis tape son code (4 a 6 chiffres, hache avec scrypt) : cinq codes faux
 *    verrouillent le profil jusqu'a l'intervention d'un administrateur ;
 *  - la session de l'agent (cookie `psim_session`) est liee au telephone qui l'a ouverte : inutilisable avec la cle d'un autre ;
 *  - le service (prise et fin de poste) est distinct de la session ; il se termine tout seul apres `max_shift_minutes` ;
 *  - un agent ne voit, n'acquitte et ne regarde que les incidents de ses zones, sauf le SOS d'un collegue (visible de tous) ;
 *  - jamais de code personnel, de cle de telephone ni de code d'appairage dans le journal d'audit.
 */

/**
 * Meme nom que `SESSION_COOKIE` de api.ts : redeclare ici, car importer api.ts depuis ce module ferait un cycle
 * (api.ts importe ses services). A garder identique.
 */
const SESSION_COOKIE = 'psim_session';
export const PHONE_COOKIE = 'psim_phone';

export const PHONE_KEY_PATTERN = /^pph_(\d{1,9})_([A-Za-z0-9_-]{43})$/;
const PAIR_CODE_PATTERN = /^[a-z2-7]{10}$/;
const PIN_PATTERN = /^\d{4,6}$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

const MIN = 60_000;
const HOUR = 3_600_000;
const PAIR_TTL_MS = 15 * MIN;
const MAX_FAILED_PINS = 5;
const DEFAULT_SHIFT_MINUTES = 720;
const MIN_SHIFT_MINUTES = 30;
const MAX_SHIFT_MINUTES = 1440;
const MAX_ZONES = 50;
const MAX_NAME = 80;
/** Le detecteur `A-<identifiant>` doit tenir dans les 32 caracteres d'un identifiant d'equipement. */
const MAX_USERNAME = 30;
/**
 * Le detecteur virtuel `A-<identifiant>` est un identifiant d'equipement : lettres, chiffres, tiret et soulignement SEULEMENT
 * (le point, admis pour un compte ordinaire, y est refuse : « marie.dupont » echouait a la creation du detecteur, apres coup).
 */
const AGENT_USERNAME = /^[a-z0-9][a-z0-9_-]{2,29}$/;
const MAX_ACTIVE_PHONES = 200;
const MAX_PENDING_PAIRINGS = 20;
const SOS_LOGIN_WINDOW_MS = 24 * HOUR;
/** Envoi d'un agent precedent : son service doit couvrir l'heure du telephone a 5 min pres. */
const SENDER_MARGIN_MS = 5 * MIN;
const LAST_SEEN_STEP_MS = 20_000;
const MAX_ALARMS = 200;
const MAX_CERT_BYTES = 256 * 1024;

export const AGENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_profile (
  username TEXT PRIMARY KEY REFERENCES app_user(username) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  zones TEXT NOT NULL DEFAULT '[]',
  failed_pins INTEGER NOT NULL DEFAULT 0,
  locked_at INTEGER,
  max_shift_minutes INTEGER NOT NULL DEFAULT 720
);
CREATE TABLE IF NOT EXISTS agent_phone (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  key_hash TEXT UNIQUE,
  pair_hash TEXT UNIQUE,
  pair_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  paired_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS agent_shift (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  phone_id INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT
);
CREATE INDEX IF NOT EXISTS agent_shift_open ON agent_shift(username, ended_at);
CREATE TABLE IF NOT EXISTS agent_position (
  username TEXT PRIMARY KEY,
  checkpoint_id INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_dispatch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('en_route','on_site')),
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_dispatch_by_incident ON agent_dispatch(incident_id, username);
CREATE TABLE IF NOT EXISTS agent_sos (
  client_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  incident_id INTEGER,
  phone_at INTEGER NOT NULL,
  server_at INTEGER NOT NULL
);
`;

export type ShiftEndReason = 'agent' | 'timeout' | 'revoked' | 'admin';

export interface AgentAdminView {
  username: string;
  displayName: string;
  zones: string[];
  locked: boolean;
  maxShiftMinutes: number;
  /** Compte actif (un agent desactive garde son profil et ses traces, mais ne peut plus se connecter). */
  active: boolean;
  shift: { id: number; startedAt: number; endsAt: number } | null;
  position: { checkpointId: number; name: string; at: number } | null;
}

export interface PhoneView {
  id: number;
  label: string;
  pairedAt: number | null;
  revokedAt: number | null;
  lastSeenAt: number | null;
  /** Code d'appairage encore valable, telephone pas encore appaire. */
  pending: boolean;
}

export interface AgentsDeps {
  db: DatabaseSync;
  engine: Pick<Engine, 'handleDetectorMessage' | 'audit' | 'getDevice' | 'createDevice' | 'updateDevice' | 'acknowledge' | 'incidentView'>;
  users: Pick<UsersService, 'createAgentAccount' | 'update' | 'openSession'>;
  now?: () => number;
  /** Fichier du certificat public du PSIM (PSIM_TLS_CERT), ou null/absent : pas de TLS. */
  certPath?: string | null;
  /** Ouvre le flux direct d'une camera sur la reponse (meme mecanisme que le poste de garde : `video.attachViewer`). */
  liveStream?: (cameraId: string, res: ServerResponse) => void;
  /** Lit une image d'incident (`snapshots.read`). */
  readSnapshot?: (snapshotId: number) => Buffer | null;
}

type Row = Record<string, unknown>;

const sha256hex = (v: string) => createHash('sha256').update(v).digest('hex');
// Empreintes de reference pour une cle mal formee ou inconnue : meme travail, meme duree, toujours refusee.
const DUMMY_KEY_HASH = sha256hex(`pph_0_${'A'.repeat(43)}-jamais-valide`);
const DUMMY_PAIR_HASH = sha256hex('aaaaaaaaaa-jamais-valide');
const DUMMY_PIN_SALT = randomBytes(16).toString('hex');
const DUMMY_PIN_HASH = scryptSync('0000', DUMMY_PIN_SALT, 64).toString('hex');

const sameHex = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

/** `n` caracteres base32 minuscules aleatoires ([a-z2-7], 5 bits chacun). */
function randomCode(n: number): string {
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += BASE32[bytes[i] & 31];
  return out;
}

/** Texte saisi (nom, etiquette) : meme garde que les noms d'equipements (voir text.ts). */
function cleanText(value: unknown, field: string, max = MAX_NAME): string {
  const text = typeof value === 'string' ? normalizeName(value) : '';
  if (!text || text.length > max || hasForbiddenChar(text)) throw new PsimError(400, `${field} : texte de 1 a ${max} caracteres, sans caractere de controle`);
  return text;
}

function cleanPin(value: unknown): string {
  if (typeof value !== 'string' || !PIN_PATTERN.test(value)) throw new PsimError(400, 'pin : le code personnel comporte 4 a 6 chiffres');
  return value;
}

function cleanMaxShift(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_SHIFT_MINUTES || value > MAX_SHIFT_MINUTES) {
    throw new PsimError(400, `maxShiftMinutes : entier de ${MIN_SHIFT_MINUTES} a ${MAX_SHIFT_MINUTES}`);
  }
  return value;
}

const parseId = (value: unknown, notFound: string): number => {
  const raw = String(value);
  const id = /^\d{1,12}$/.test(raw) ? Number(raw) : 0;
  if (id < 1) throw new PsimError(404, notFound);
  return id;
};

const hashPin = (pin: string, salt: string): string => scryptSync(pin, salt, 64).toString('hex');

/** Retire ce qui ne doit pas finir dans le texte d'un incident, et plafonne a 300 caracteres. */
const clipDetail = (text: string): string => normalizeName(text.replace(/[\u0000-\u001f\u007f-\u009f\p{Zl}\p{Zp}\p{Cf}]/gu, ' ')).slice(0, 300);

/** Detecteurs virtuels des agents : `A-<identifiant>` d'un profil, `A-phone-<n°>` d'un telephone appaire (condition sur `d.id`). */
const VIRTUAL_AGENT_SQL = "d.id IN (SELECT 'A-' || username FROM agent_profile UNION SELECT 'A-phone-' || id FROM agent_phone)";
/**
 * Detecteurs virtuels des circuits de ronde : `P-<n° de circuit>` (condition sur `d.id`). Chiffres seulement, SANS zero devant : les
 * circuits sont numerotes depuis 1 (patrols.ts : `P-${id}`), alors qu'un detecteur du site peut s'appeler `P-01`.
 */
const VIRTUAL_CIRCUIT_SQL = "d.id GLOB 'P-[1-9]*' AND d.id NOT GLOB 'P-*[^0-9]*'";

/**
 * Ce detecteur est-il virtuel (SOS d'un agent ou d'un telephone, ronde d'un circuit) ? Le prefixe seul ne suffit pas (voir
 * `releaseAcknowledged`). Sert au moteur (`EngineOptions.virtualDetector`) : ces detecteurs ne subissent aucune regle anti-fausses
 * alarmes. Faux pour un identifiant inconnu.
 */
export function isVirtualDetector(db: DatabaseSync, detectorId: string): boolean {
  return db.prepare(`SELECT 1 AS x FROM device d WHERE d.id = ? AND ((${VIRTUAL_AGENT_SQL}) OR (${VIRTUAL_CIRCUIT_SQL}))`).get(detectorId) !== undefined;
}

/**
 * Un detecteur virtuel `A-` ou `P-` en (pre)alarme dont l'incident ouvert a ete acquitte (par l'exploitation OU par un agent : un
 * agent qui acquitte le SOS d'un collegue ne doit pas bloquer la cloture) recoit `{ event: 'clear' }` : sans cela personne ne pourrait
 * cloturer l'incident (le moteur refuse de cloturer tant que le detecteur sonne, et d'acquitter deux fois). L'incident reste ouvert et
 * acquitte ; c'est l'exploitation qui le qualifie et le cloture (l'agent ne peut jamais le faire).
 * Partagee avec patrols.ts (prefixe `P-`). Renvoie le nombre de detecteurs liberes.
 */
export function releaseAcknowledged(db: DatabaseSync, engine: Pick<Engine, 'handleDetectorMessage'>, prefix: 'A-' | 'P-'): number {
  // Le prefixe seul ne suffit pas : le site peut avoir ses propres detecteurs `A-01` (controle d'acces) ; on ne libere que les
  // detecteurs virtuels de CE module (agents, telephones de secours, circuits).
  const virtual = prefix === 'A-' ? VIRTUAL_AGENT_SQL : VIRTUAL_CIRCUIT_SQL;
  const rows = db
    .prepare(
      `SELECT DISTINCT d.id AS id FROM incident i JOIN device d ON d.id = i.detector_id
        WHERE i.status = 'acknowledged' AND ${virtual} AND d.status IN ('alarm', 'prealarm')`,
    )
    .all() as Row[];
  let released = 0;
  for (const r of rows) {
    engine.handleDetectorMessage(r.id as string, { event: 'clear' });
    released++;
  }
  return released;
}

export function createAgents(deps: AgentsDeps) {
  const { db, engine, users } = deps;
  const now = deps.now ?? Date.now;
  db.exec(AGENT_SCHEMA);
  // Dernier agent connecte sur chaque telephone (avenant 1 : un SOS sans session est attribue a cet agent pendant 24 h).
  // Ajout idempotent de colonnes : une base creee avant l'avenant les recoit au demarrage.
  const phoneColumns = (db.prepare('PRAGMA table_info(agent_phone)').all() as { name: string }[]).map((c) => c.name);
  if (!phoneColumns.includes('last_login_user')) db.exec('ALTER TABLE agent_phone ADD COLUMN last_login_user TEXT');
  if (!phoneColumns.includes('last_login_at')) db.exec('ALTER TABLE agent_phone ADD COLUMN last_login_at INTEGER');

  const audit = (actor: string, action: string, ref?: { incidentId?: number; deviceId?: string; details?: string }) => engine.audit(actor, action, ref);

  /** Execute `fn` dans un point de sauvegarde (utilisable dans ou hors d'une transaction). */
  function atomically<T>(name: string, fn: () => T): T {
    db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      db.exec(`RELEASE ${name}`);
      return out;
    } catch (err) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw err;
    }
  }

  // ------------------------------------------------------------------ zones, points de controle (table de patrols.ts)

  function knownZones(): Set<string> {
    const rows = db.prepare("SELECT DISTINCT zone FROM device WHERE zone <> ''").all() as Row[];
    return new Set(rows.map((r) => r.zone as string));
  }

  function cleanZones(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_ZONES) throw new PsimError(400, `zones : liste de ${MAX_ZONES} noms de zones au plus (vide = toutes les zones)`);
    const known = knownZones();
    const out = new Set<string>();
    for (const v of value) {
      const zone = typeof v === 'string' ? normalizeName(v) : '';
      if (!zone || !known.has(zone)) {
        const shown = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 80) : String(typeof v);
        throw new PsimError(400, `zones : zone inconnue « ${shown} » (une zone est celle d'un equipement existant)`);
      }
      out.add(zone);
    }
    return [...out];
  }

  /** Nom d'un point de controle ; la table appartient a patrols.ts (absente tant que ce module n'est pas construit). */
  function checkpointInfo(id: number): { name: string; zone: string; floorId: number; x: number; y: number } | null {
    try {
      const r = db.prepare('SELECT name, zone, floor_id, x, y FROM checkpoint WHERE id = ?').get(id) as Row | undefined;
      return r ? { name: r.name as string, zone: r.zone as string, floorId: r.floor_id as number, x: r.x as number, y: r.y as number } : null;
    } catch {
      return null;
    }
  }
  const checkpointName = (id: number): string => checkpointInfo(id)?.name ?? `Point ${id}`;

  // ------------------------------------------------------------------ telephones

  /** Codes d'appairage en clair, gardes EN MEMOIRE pour le QR seulement (jamais relus de la base : 404 apres redemarrage). */
  const pendingCodes = new Map<number, { code: string; expiresAt: number }>();

  const phoneRow = (id: number): Row => {
    const r = db.prepare('SELECT * FROM agent_phone WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new PsimError(404, 'Telephone introuvable');
    return r;
  };

  function phoneView(r: Row): PhoneView {
    return {
      id: r.id as number,
      label: r.label as string,
      pairedAt: (r.paired_at as number | null) ?? null,
      revokedAt: (r.revoked_at as number | null) ?? null,
      lastSeenAt: (r.last_seen_at as number | null) ?? null,
      pending: r.paired_at === null && r.revoked_at === null && r.pair_hash !== null && (r.pair_expires_at as number) >= now(),
    };
  }

  function createPhone(actor: string, label: unknown): { id: number; label: string; code: string; expiresAt: number } {
    const name = cleanText(label, 'label');
    const t = now();
    const active = (db.prepare('SELECT COUNT(*) AS n FROM agent_phone WHERE revoked_at IS NULL AND paired_at IS NOT NULL').get() as { n: number }).n;
    if (active >= MAX_ACTIVE_PHONES) throw new PsimError(409, `Trop de telephones actifs (${MAX_ACTIVE_PHONES}) : revoquez ceux qui ne servent plus`);
    const pending = (db.prepare('SELECT COUNT(*) AS n FROM agent_phone WHERE revoked_at IS NULL AND paired_at IS NULL AND pair_expires_at >= ?').get(t) as { n: number }).n;
    if (pending >= MAX_PENDING_PAIRINGS) throw new PsimError(409, "Trop d'appairages en attente : attendre leur expiration ou les revoquer");
    const code = randomCode(10);
    const expiresAt = t + PAIR_TTL_MS;
    const res = db
      .prepare('INSERT INTO agent_phone (label, pair_hash, pair_expires_at, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(name, sha256hex(code), expiresAt, t, actor);
    const id = Number(res.lastInsertRowid);
    pendingCodes.set(id, { code, expiresAt });
    audit(actor, 'agent_phone_created', { details: `telephone n°${id} « ${name} »` });
    return { id, label: name, code, expiresAt };
  }

  function listPhones(): PhoneView[] {
    return (db.prepare('SELECT * FROM agent_phone ORDER BY id').all() as Row[]).map(phoneView);
  }

  /** Echange un code d'appairage (usage unique, 15 min) contre la cle du telephone. La cle n'existe qu'ici et dans le cookie. */
  function pairPhone(code: unknown): { phone: { id: number; label: string }; key: string } {
    const given = typeof code === 'string' ? code.trim().toLowerCase().slice(0, 64) : '';
    const valid = PAIR_CODE_PATTERN.test(given);
    // Toujours un hachage et une recherche, quelle que soit l'issue (pas d'oracle de duree).
    const row = db.prepare('SELECT * FROM agent_phone WHERE pair_hash = ?').get(sha256hex(valid ? given : DUMMY_PAIR_HASH)) as Row | undefined;
    const t = now();
    if (!valid || !row || row.paired_at !== null || row.revoked_at !== null || (row.pair_expires_at as number | null) === null || (row.pair_expires_at as number) < t) {
      throw new PsimError(401, "Code d'appairage invalide ou expire");
    }
    const id = row.id as number;
    const key = `pph_${id}_${randomBytes(32).toString('base64url')}`;
    // Usage unique : la ligne n'est mise a jour que si elle est encore en attente (un second appel simultane echoue).
    const res = db
      .prepare('UPDATE agent_phone SET key_hash = ?, paired_at = ?, last_seen_at = ?, pair_hash = NULL, pair_expires_at = NULL WHERE id = ? AND paired_at IS NULL AND revoked_at IS NULL AND pair_hash = ?')
      .run(sha256hex(key), t, t, id, sha256hex(given));
    if (res.changes !== 1) throw new PsimError(401, "Code d'appairage invalide ou expire");
    pendingCodes.delete(id);
    audit('systeme', 'agent_phone_paired', { details: `telephone n°${id} « ${row.label as string} »` });
    return { phone: { id, label: row.label as string }, key };
  }

  /**
   * Telephone designe par la cle du cookie, ou null (cle absente, mal formee, inconnue, telephone revoque). Ne leve jamais
   * d'exception ; meme travail dans tous les cas. `last_seen_at` n'est ecrit qu'au plus toutes les 20 s (le telephone interroge
   * toutes les 4 s).
   */
  function checkPhone(key: unknown): { id: number; label: string } | null {
    const given = typeof key === 'string' && key.length <= 128 ? key : '';
    const m = PHONE_KEY_PATTERN.exec(given);
    const row = m ? (db.prepare('SELECT * FROM agent_phone WHERE id = ?').get(Number(m[1])) as Row | undefined) : undefined;
    const stored = (row?.key_hash as string | null | undefined) ?? DUMMY_KEY_HASH;
    const same = sameHex(stored, sha256hex(given));
    if (!m || !row || !same || row.revoked_at !== null || row.key_hash === null) return null;
    const t = now();
    const seen = (row.last_seen_at as number | null) ?? 0;
    if (t - seen >= LAST_SEEN_STEP_MS || t < seen) db.prepare('UPDATE agent_phone SET last_seen_at = ? WHERE id = ?').run(t, row.id as number);
    return { id: row.id as number, label: row.label as string };
  }

  function revokePhone(actor: string, idValue: unknown): void {
    const id = parseId(idValue, 'Telephone introuvable');
    const row = phoneRow(id);
    if (row.revoked_at !== null) return; // deja revoque : idempotent
    db.prepare('UPDATE agent_phone SET revoked_at = ?, revoked_by = ?, pair_hash = NULL, pair_expires_at = NULL WHERE id = ?').run(now(), actor, id);
    pendingCodes.delete(id);
    destroyPhoneSessions(id);
    for (const s of db.prepare('SELECT * FROM agent_shift WHERE phone_id = ? AND ended_at IS NULL').all(id) as Row[]) closeShift(s, 'revoked', actor);
    audit(actor, 'agent_phone_revoked', { details: `telephone n°${id} « ${row.label as string} »` });
  }

  // ------------------------------------------------------------------ profils

  function profileRow(username: string): Row {
    const r = db
      .prepare('SELECT p.*, u.active AS active, u.role AS role FROM agent_profile p JOIN app_user u ON u.username = p.username WHERE p.username = ?')
      .get(username) as Row | undefined;
    if (!r || r.role !== 'agent') throw new PsimError(404, 'Agent introuvable');
    return r;
  }

  const isAgent = (username: string): boolean => {
    try {
      profileRow(username);
      return true;
    } catch {
      return false;
    }
  };

  const zonesOfRow = (r: Row): string[] => {
    try {
      const v = JSON.parse(r.zones as string) as unknown;
      return Array.isArray(v) ? v.filter((z): z is string => typeof z === 'string') : [];
    } catch {
      return [];
    }
  };
  const zonesOf = (username: string): string[] => zonesOfRow(profileRow(username));

  const openShiftOf = (username: string): Row | undefined =>
    db.prepare('SELECT * FROM agent_shift WHERE username = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').get(username) as Row | undefined;

  const shiftView = (s: Row | undefined): AgentAdminView['shift'] => (s ? { id: s.id as number, startedAt: s.started_at as number, endsAt: s.ends_at as number } : null);

  function positionView(username: string): AgentAdminView['position'] {
    const p = db.prepare('SELECT checkpoint_id, at FROM agent_position WHERE username = ?').get(username) as Row | undefined;
    return p ? { checkpointId: p.checkpoint_id as number, name: checkpointName(p.checkpoint_id as number), at: p.at as number } : null;
  }

  function adminView(r: Row): AgentAdminView {
    const username = r.username as string;
    return {
      username,
      displayName: r.display_name as string,
      zones: zonesOfRow(r),
      locked: r.locked_at !== null,
      maxShiftMinutes: r.max_shift_minutes as number,
      active: r.active === 1,
      shift: shiftView(openShiftOf(username)),
      position: positionView(username),
    };
  }

  const detectorId = (username: string): string => `A-${username}`;

  /** Detecteur virtuel `A-<identifiant>` (categorie « personnes », non supervise) : cree au besoin, renomme avec l'agent. */
  function ensureDetector(actor: string, username: string, displayName: string): string {
    const id = detectorId(username);
    const current = engine.getDevice(id);
    if (!current) {
      engine.createDevice(actor, { id, kind: 'detector', name: displayName, zone: '', category: 'people', heartbeatS: 0 });
    } else if (current.name !== displayName) {
      engine.updateDevice(actor, id, { name: displayName });
    }
    return id;
  }

  function listAgents(): AgentAdminView[] {
    const rows = db
      .prepare("SELECT p.*, u.active AS active FROM agent_profile p JOIN app_user u ON u.username = p.username WHERE u.role = 'agent' ORDER BY p.username")
      .all() as Row[];
    return rows.map(adminView);
  }

  function createAgent(actor: string, input: Record<string, unknown>): AgentAdminView {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new PsimError(400, 'Corps invalide');
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    if (!AGENT_USERNAME.test(username)) throw new PsimError(400, `Identifiant invalide (3 a ${MAX_USERNAME} caracteres : lettres minuscules, chiffres, tiret et soulignement, sans point)`);
    // Tout est valide AVANT la moindre ecriture : jamais de creation partielle.
    const displayName = cleanText(input.displayName, 'displayName');
    const pin = cleanPin(input.pin);
    const zones = cleanZones(input.zones);
    const maxShift = input.maxShiftMinutes === undefined || input.maxShiftMinutes === null ? DEFAULT_SHIFT_MINUTES : cleanMaxShift(input.maxShiftMinutes);
    return atomically('agent_create', () => {
      users.createAgentAccount(actor, username, displayName); // valide l'identifiant (400) et son unicite (409)
      const salt = randomBytes(16).toString('hex');
      db.prepare('INSERT INTO agent_profile (username, display_name, pin_hash, zones, max_shift_minutes) VALUES (?, ?, ?, ?, ?)').run(
        username,
        displayName,
        `${salt}:${hashPin(pin, salt)}`,
        JSON.stringify(zones),
        maxShift,
      );
      ensureDetector(actor, username, displayName);
      audit(actor, 'agent_created', { details: `${username} « ${displayName} », zones : ${zones.join(', ') || 'toutes'}, service de ${maxShift} min au plus` });
      return adminView(profileRow(username));
    });
  }

  function updateAgent(actor: string, usernameValue: string, patch: Record<string, unknown>): AgentAdminView {
    const username = String(usernameValue).trim().toLowerCase();
    const current = profileRow(username);
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new PsimError(400, 'Corps invalide');
    if (patch.unlock !== undefined && typeof patch.unlock !== 'boolean') throw new PsimError(400, 'unlock doit etre vrai ou faux');
    const displayName = patch.displayName === undefined ? undefined : cleanText(patch.displayName, 'displayName');
    const pin = patch.pin === undefined ? undefined : cleanPin(patch.pin);
    const zones = patch.zones === undefined ? undefined : cleanZones(patch.zones);
    const maxShift = patch.maxShiftMinutes === undefined ? undefined : cleanMaxShift(patch.maxShiftMinutes);
    const changes: string[] = [];
    atomically('agent_update', () => {
      if (displayName !== undefined && displayName !== current.display_name) {
        db.prepare('UPDATE agent_profile SET display_name = ? WHERE username = ?').run(displayName, username);
        db.prepare('UPDATE app_user SET display_name = ? WHERE username = ?').run(displayName, username);
        ensureDetector(actor, username, displayName);
        changes.push('nom affiche');
      }
      if (pin !== undefined) {
        const salt = randomBytes(16).toString('hex');
        db.prepare('UPDATE agent_profile SET pin_hash = ? WHERE username = ?').run(`${salt}:${hashPin(pin, salt)}`, username);
        changes.push('code personnel'); // jamais la valeur
      }
      if (zones !== undefined && JSON.stringify(zones) !== JSON.stringify(zonesOfRow(current))) {
        db.prepare('UPDATE agent_profile SET zones = ? WHERE username = ?').run(JSON.stringify(zones), username);
        changes.push(`zones : ${zones.join(', ') || 'toutes'}`);
      }
      if (maxShift !== undefined && maxShift !== current.max_shift_minutes) {
        db.prepare('UPDATE agent_profile SET max_shift_minutes = ? WHERE username = ?').run(maxShift, username);
        changes.push(`service de ${maxShift} min au plus`);
      }
      if (changes.length > 0) audit(actor, 'agent_updated', { details: `${username} : ${changes.join(' ; ')}` });
      if (patch.unlock === true && (current.locked_at !== null || (current.failed_pins as number) > 0)) {
        db.prepare('UPDATE agent_profile SET failed_pins = 0, locked_at = NULL WHERE username = ?').run(username);
        if (current.locked_at !== null) audit(actor, 'agent_unlocked', { details: username });
      }
    });
    return adminView(profileRow(username));
  }

  /** Desactive le compte (les traces restent), ferme ses sessions et son service. Idempotent. */
  function disableAgent(actor: string, usernameValue: string): void {
    const username = String(usernameValue).trim().toLowerCase();
    profileRow(username);
    users.update(actor, username, { active: false }); // ferme aussi les sessions du compte
    const shift = openShiftOf(username);
    if (shift) closeShift(shift, 'admin', actor);
    audit(actor, 'agent_disabled', { details: username });
  }

  function endShiftByAdmin(actor: string, usernameValue: string): void {
    const username = String(usernameValue).trim().toLowerCase();
    profileRow(username);
    endShift(username, 'admin', actor);
  }

  // ------------------------------------------------------------------ connexion

  function phoneAgents(): { username: string; displayName: string; locked: boolean }[] {
    return listAgents()
      .filter((a) => a.active)
      .map((a) => ({ username: a.username, displayName: a.displayName, locked: a.locked }));
  }

  let lastUnknownAudit = 0;

  /**
   * Verifie le code d'un agent sur un telephone appaire. Le travail (scrypt) est le meme pour un nom inconnu, un compte
   * desactive ou un code faux : ni la duree ni le message ne revelent lequel. Cinq codes faux verrouillent le profil (423) ;
   * seul un administrateur le deverrouille.
   */
  function login(phoneId: number, usernameValue: unknown, pinValue: unknown): { username: string; ttlMs: number; epoch: number; role: 'agent' } {
    const name = typeof usernameValue === 'string' ? usernameValue.trim().toLowerCase().slice(0, 64) : '';
    const pin = typeof pinValue === 'string' && pinValue.length <= 32 ? pinValue : '';
    const row = name ? (db.prepare('SELECT p.*, u.active AS active, u.role AS role FROM agent_profile p JOIN app_user u ON u.username = p.username WHERE p.username = ?').get(name) as Row | undefined) : undefined;
    const [salt, expected] = row ? String(row.pin_hash).split(':') : [DUMMY_PIN_SALT, DUMMY_PIN_HASH];
    const candidate = hashPin(pin, salt);
    const good = sameHex(candidate, expected ?? '') && PIN_PATTERN.test(pin);
    const generic = new PsimError(401, 'Identifiant ou code incorrect');
    if (!row || row.role !== 'agent') {
      const t = now();
      if (t - lastUnknownAudit >= MIN) {
        lastUnknownAudit = t;
        audit('?', 'agent_login_failed', { details: `identifiant inconnu, telephone n°${phoneId}` });
      }
      throw generic;
    }
    if (row.active !== 1) throw generic;
    if (row.locked_at !== null) throw new PsimError(423, 'Compte verrouille : demander a un administrateur de le deverrouiller');
    if (!good) {
      const failed = (row.failed_pins as number) + 1;
      if (failed >= MAX_FAILED_PINS) {
        db.prepare('UPDATE agent_profile SET failed_pins = ?, locked_at = ? WHERE username = ?').run(failed, now(), name);
        audit(name, 'agent_login_failed', { details: `code faux, essai ${failed}/${MAX_FAILED_PINS}, telephone n°${phoneId}` });
        audit('systeme', 'agent_locked', { details: `${name} : ${MAX_FAILED_PINS} codes faux` });
        throw new PsimError(423, 'Compte verrouille : demander a un administrateur de le deverrouiller');
      }
      db.prepare('UPDATE agent_profile SET failed_pins = ? WHERE username = ?').run(failed, name);
      audit(name, 'agent_login_failed', { details: `code faux, essai ${failed}/${MAX_FAILED_PINS}, telephone n°${phoneId}` });
      throw generic;
    }
    if ((row.failed_pins as number) > 0) db.prepare('UPDATE agent_profile SET failed_pins = 0 WHERE username = ?').run(name);
    const opened = users.openSession(name);
    db.prepare('UPDATE agent_phone SET last_login_user = ?, last_login_at = ? WHERE id = ?').run(name, now(), phoneId);
    audit(name, 'agent_login', { details: `telephone n°${phoneId}` });
    return { username: name, ttlMs: (row.max_shift_minutes as number) * MIN, epoch: opened.epoch, role: 'agent' };
  }

  // ------------------------------------------------------------------ service, position

  function me(username: string): AgentMe {
    const r = profileRow(username);
    const shift = shiftView(openShiftOf(username));
    return { username, displayName: r.display_name as string, zones: zonesOfRow(r), shift, position: shift ? positionView(username) : null };
  }

  function startShift(username: string, phoneId: number): AgentMe {
    const r = profileRow(username);
    if (r.active !== 1) throw new PsimError(403, 'Compte desactive');
    const open = openShiftOf(username);
    if (open && open.phone_id === phoneId) return me(username); // deja en service sur ce telephone : rien a refaire
    if (open) closeShift(open, 'agent', username); // service ouvert sur un autre telephone : le nouveau le remplace
    const t = now();
    const res = db
      .prepare('INSERT INTO agent_shift (username, phone_id, started_at, ends_at) VALUES (?, ?, ?, ?)')
      .run(username, phoneId, t, t + (r.max_shift_minutes as number) * MIN);
    audit(username, 'agent_shift_started', { details: `telephone n°${phoneId}, service n°${Number(res.lastInsertRowid)}` });
    return me(username);
  }

  function closeShift(s: Row, reason: ShiftEndReason, actor: string): void {
    const t = now();
    const res = db.prepare('UPDATE agent_shift SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').run(t, reason, s.id as number);
    if (res.changes === 0) return;
    const username = s.username as string;
    db.prepare('DELETE FROM agent_position WHERE username = ?').run(username); // la position n'est gardee que pendant le service
    const minutes = Math.max(0, Math.round((t - (s.started_at as number)) / MIN));
    audit(actor, 'agent_shift_ended', { details: `${username}, raison ${reason}, ${minutes} min` });
  }

  /**
   * Fin de service. Sans effet si l'agent n'est pas en service. Sauf pour `revoked` (traite par telephone), toutes les sessions
   * du compte sont fermees. `actor` : par defaut l'agent lui-meme (`agent`) ou `systeme`.
   */
  function endShift(username: string, reason: ShiftEndReason, actor?: string): void {
    const who = actor ?? (reason === 'agent' ? username : 'systeme');
    const open = openShiftOf(username);
    if (open) closeShift(open, reason, who);
    if (reason !== 'revoked') destroyUserSessions(username);
  }

  function onShift(): { username: string; displayName: string }[] {
    return (
      db
        .prepare(
          `SELECT s.username AS username, p.display_name AS display_name FROM agent_shift s JOIN agent_profile p ON p.username = s.username
            WHERE s.ended_at IS NULL GROUP BY s.username ORDER BY s.username`,
        )
        .all() as Row[]
    ).map((r) => ({ username: r.username as string, displayName: r.display_name as string }));
  }

  /** Derniere position connue (dernier point scanne). Sans effet si l'agent n'est pas en service. */
  function setPosition(username: string, checkpointId: number, at: number): void {
    if (!openShiftOf(username)) return;
    db.prepare('INSERT INTO agent_position (username, checkpoint_id, at) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET checkpoint_id = excluded.checkpoint_id, at = excluded.at').run(username, checkpointId, at);
  }

  function positions(): { username: string; displayName: string; checkpointId: number; at: number }[] {
    return (
      db
        .prepare(
          `SELECT pos.username AS username, p.display_name AS display_name, pos.checkpoint_id AS checkpoint_id, pos.at AS at
             FROM agent_position pos JOIN agent_profile p ON p.username = pos.username
            WHERE EXISTS (SELECT 1 FROM agent_shift s WHERE s.username = pos.username AND s.ended_at IS NULL)
            ORDER BY pos.username`,
        )
        .all() as Row[]
    ).map((r) => ({ username: r.username as string, displayName: r.display_name as string, checkpointId: r.checkpoint_id as number, at: r.at as number }));
  }

  // ------------------------------------------------------------------ alarmes

  /** SOS d'un collegue : visible de TOUS les agents, quelle que soit leur zone. Sinon : zones vides = toutes ; incident sans zone = tous. */
  const visible = (zones: string[], incident: Incident): boolean =>
    (incident.event === 'sos' && incident.detectorId.startsWith('A-')) || zones.length === 0 || incident.zone === '' || zones.includes(incident.zone);

  /** Incident non clos visible de l'agent ; 404 sinon (on ne distingue pas « inexistant » de « hors de ses zones »). */
  function incidentFor(username: string, id: number): Incident {
    const zones = zonesOf(username);
    let incident: Incident;
    try {
      incident = engine.incidentView(id);
    } catch {
      throw new PsimError(404, 'Alarme introuvable');
    }
    if (incident.status === 'closed' || !visible(zones, incident)) throw new PsimError(404, 'Alarme introuvable');
    return incident;
  }

  const liveCameras = (incident: Incident): string[] =>
    incident.cameraIds.filter((c) => db.prepare('SELECT 1 AS x FROM camera_source WHERE device_id = ?').get(c) !== undefined);

  function dispatchesOf(incidentId: number): { username: string; displayName: string; status: 'en_route' | 'on_site'; at: number }[] {
    return (
      db
        .prepare(
          `SELECT d.username AS username, COALESCE(p.display_name, d.username) AS display_name, d.status AS status, d.at AS at
             FROM agent_dispatch d LEFT JOIN agent_profile p ON p.username = d.username WHERE d.incident_id = ? ORDER BY d.at, d.id`,
        )
        .all(incidentId) as Row[]
    ).map((r) => ({ username: r.username as string, displayName: r.display_name as string, status: r.status as 'en_route' | 'on_site', at: r.at as number }));
  }

  /** Qui a acquitte, en clair pour l'agent : le nom affiche si c'est un agent (« Marie Dupont »), sinon l'identifiant du poste. */
  function ackerName(username: string | null): string | null {
    if (username === null) return null;
    const row = db.prepare('SELECT display_name FROM agent_profile WHERE username = ?').get(username) as Row | undefined;
    return (row?.display_name as string | undefined) ?? username;
  }

  function alarmView(i: Incident): AgentAlarm {
    return {
      id: i.id,
      severity: i.severity,
      title: eventLabel(i.event) ?? CATEGORY_LABEL[i.category],
      detail: i.detail ?? '',
      deviceName: i.detectorName,
      zone: i.zone,
      floorName: i.floor,
      openedAt: i.openedAt,
      acknowledged: i.status === 'acknowledged',
      acknowledgedBy: ackerName(i.ackedBy),
      hasSnapshot: i.snapshots.length > 0,
      hasLive: liveCameras(i).length > 0,
      dispatch: dispatchesOf(i.id),
    };
  }

  /** Incidents non clos de ses zones : le plus grave d'abord, puis le plus ancien. */
  function alarms(username: string): AgentAlarm[] {
    const zones = zonesOf(username);
    const ids = db.prepare("SELECT id FROM incident WHERE status <> 'closed' ORDER BY id").all() as Row[];
    const out: Incident[] = [];
    for (const r of ids) {
      const incident = engine.incidentView(r.id as number);
      if (visible(zones, incident)) out.push(incident);
    }
    out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1) || a.openedAt - b.openedAt || a.id - b.id);
    return out.slice(0, MAX_ALARMS).map(alarmView);
  }

  /** Acquittement : acteur = l'agent. L'agent ne qualifie ni ne cloture jamais. */
  function ackAlarm(username: string, incidentId: number): void {
    incidentFor(username, incidentId);
    engine.acknowledge(incidentId, username);
  }

  /** « J'y vais » / « Sur place » : dernier statut par agent et par incident (mis a jour, pas empile), journalise a chaque changement. */
  function dispatch(username: string, incidentId: number, status: unknown): void {
    if (status !== 'en_route' && status !== 'on_site') throw new PsimError(400, 'status : en_route ou on_site');
    incidentFor(username, incidentId);
    const existing = db.prepare('SELECT id, status FROM agent_dispatch WHERE incident_id = ? AND username = ? ORDER BY id DESC LIMIT 1').get(incidentId, username) as Row | undefined;
    if (existing && existing.status === status) return; // deja dans cet etat
    if (existing) db.prepare('UPDATE agent_dispatch SET status = ?, at = ? WHERE id = ?').run(status, now(), existing.id as number);
    else db.prepare('INSERT INTO agent_dispatch (incident_id, username, status, at) VALUES (?, ?, ?, ?)').run(incidentId, username, status, now());
    audit(username, 'agent_dispatch', { incidentId, details: status });
  }

  /** Derniere image de l'incident. 404 si l'incident n'a pas d'image, ou hors de ses zones. */
  function snapshotFor(username: string, incidentId: number): Buffer {
    const incident = incidentFor(username, incidentId);
    const last = incident.snapshots[incident.snapshots.length - 1];
    const image = last && deps.readSnapshot ? deps.readSnapshot(last.id) : null;
    if (!image) throw new PsimError(404, 'Image introuvable');
    return image;
  }

  /** Camera autorisee pour le direct : liee a l'incident, avec une source video reelle, incident visible de l'agent. */
  function liveCameraFor(username: string, incidentId: number, cameraId?: string): string {
    const incident = incidentFor(username, incidentId);
    const cameras = liveCameras(incident);
    if (cameras.length === 0) throw new PsimError(404, 'Aucune camera en direct pour cette alarme');
    if (cameraId === undefined || cameraId === '') return cameras[0];
    if (!cameras.includes(cameraId)) throw new PsimError(404, 'Camera introuvable pour cette alarme');
    return cameraId;
  }

  // ------------------------------------------------------------------ SOS

  /** Replace le detecteur de l'agent sur son dernier point connu (un `updateDevice` seulement si cela change). Ne fait jamais echouer le SOS. */
  function relocateDetector(username: string, position: { checkpointId: number } | null): void {
    if (!position) return;
    const point = checkpointInfo(position.checkpointId);
    const device = engine.getDevice(detectorId(username));
    if (!point || !device) return;
    if (device.zone === point.zone && device.floorId === point.floorId && device.x === point.x && device.y === point.y) return;
    try {
      try {
        engine.updateDevice('systeme', device.id, { zone: point.zone, floorId: point.floorId, x: point.x, y: point.y });
      } catch (err) {
        if (!(err instanceof PsimError) || err.status !== 409) throw err;
        // Zone deja utilisee a un autre etage : le detecteur reste place sur son point, sans zone.
        console.warn(`[agents] zone « ${point.zone} » refusee pour ${device.id} : ${err.message}`);
        engine.updateDevice('systeme', device.id, { zone: '', floorId: point.floorId, x: point.x, y: point.y });
      }
    } catch (err) {
      console.warn(`[agents] detecteur ${device.id} non deplace : ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Incident du detecteur : celui qui est ouvert, a defaut le plus recent. */
  function incidentOfDetector(id: string): number | null {
    const open = db.prepare("SELECT id FROM incident WHERE detector_id = ? AND status <> 'closed' ORDER BY id DESC LIMIT 1").get(id) as Row | undefined;
    if (open) return open.id as number;
    const last = db.prepare('SELECT id FROM incident WHERE detector_id = ? ORDER BY id DESC LIMIT 1').get(id) as Row | undefined;
    return last ? (last.id as number) : null;
  }

  /** Detecteur de secours `A-phone-<n°>` : un SOS que ni la session ni le dernier login n'ont permis d'attribuer a un agent. */
  function ensurePhoneDetector(phoneId: number, label: string): string {
    const id = `A-phone-${phoneId}`;
    const name = clipDetail(`Téléphone ${label}`).slice(0, MAX_NAME);
    if (!engine.getDevice(id)) engine.createDevice('systeme', { id, kind: 'detector', name, zone: '', category: 'people', heartbeatS: 0 });
    return id;
  }

  /**
   * Agent a qui attribuer un SOS recu SANS session : celui que le telephone designe (`claimed`) s'il est le DERNIER agent connecte
   * sur CE telephone depuis moins de 24 h et que son profil existe ; sinon null (detecteur de secours).
   */
  function lastLoginAgent(phoneId: number, claimed: unknown): string | null {
    const name = typeof claimed === 'string' ? claimed.trim().toLowerCase().slice(0, 64) : '';
    if (!name) return null;
    const row = db.prepare('SELECT last_login_user, last_login_at FROM agent_phone WHERE id = ?').get(phoneId) as Row | undefined;
    if (!row || row.last_login_user !== name || row.last_login_at === null) return null;
    if (Math.abs(now() - (row.last_login_at as number)) > SOS_LOGIN_WINDOW_MS || !isAgent(name)) return null;
    return name;
  }

  /**
   * Appel de detresse. Idempotent par `clientId` (le telephone le renvoie jusqu'au succes), accepte hors service, jamais refuse pour
   * un motif d'identite ni d'horloge. `username` : l'agent identifie (session, ou dernier login du telephone), ou null : detecteur de
   * secours du telephone. L'evenement garde l'HEURE DU SERVEUR ; un ecart avec l'horloge du telephone est note dans le detail.
   * `viaLogin` : l'agent vient du dernier login (la session est terminee), pas d'une session ouverte.
   */
  function sos(username: string | null, phoneId: number, input: unknown, viaLogin = false): { incidentId: number } {
    const body = (typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
    const clientId = body.clientId;
    if (typeof clientId !== 'string' || clientId.length < 8 || !MSG_ID_PATTERN.test(clientId)) {
      throw new PsimError(400, 'clientId : identifiant d\'envoi de 8 a 64 caracteres (lettres, chiffres, . _ : -)');
    }
    // Renvoi d'un SOS deja recu : meme reponse, quelle que soit l'identite avec laquelle il revient (rien n'est jamais refuse).
    const known = db.prepare('SELECT username, incident_id FROM agent_sos WHERE client_id = ?').get(clientId) as Row | undefined;
    if (known) {
      const previous = known.username as string;
      const incidentId = (known.incident_id as number | null) ?? incidentOfDetector(previous.startsWith('phone-') ? `A-${previous}` : detectorId(previous));
      if (incidentId === null) throw new PsimError(503, 'SOS non enregistre : nouvel essai necessaire');
      return { incidentId };
    }
    const t = now();
    const phoneAt = typeof body.phoneAt === 'number' && Number.isFinite(body.phoneAt) ? body.phoneAt : null;
    const discreet = body.discreet === true;
    let id: string;
    let who: string;
    let where: string;
    if (username !== null) {
      const profile = profileRow(username);
      id = ensureDetector('systeme', username, profile.display_name as string);
      const position = positionView(username);
      relocateDetector(username, position);
      const minutes = position ? Math.floor((t - position.at) / MIN) : 0;
      where = position ? `dernier point ${position.name}, ${minutes < 1 ? "il y a moins d'1 min" : `il y a ${minutes} min`}` : 'position inconnue';
      who = `Agent ${profile.display_name as string}`;
      if (viaLogin) where += ', session terminee';
    } else {
      id = ensurePhoneDetector(phoneId, phoneRow(phoneId).label as string);
      who = `Telephone ${phoneRow(phoneId).label as string}`;
      where = 'agent non identifie';
    }
    // Ecart d'horloge : l'heure du serveur fait foi ; on dit seulement quand le telephone dit autre chose (2 min ou plus).
    let skew = '';
    if (phoneAt !== null) {
      const gap = Math.round((t - phoneAt) / MIN);
      if (gap >= 2) skew = `, declenche il y a ${gap} min d'apres le telephone`;
      else if (gap <= -2) skew = `, horloge du telephone en avance de ${-gap} min`;
    }
    const detail = clipDetail(`${who} : ${where}${discreet ? ' (mode discret)' : ''}${skew}`);
    engine.handleDetectorMessage(id, { event: 'sos', detail, msgId: clientId });
    const incidentId = incidentOfDetector(id);
    if (incidentId === null) throw new PsimError(503, 'SOS non enregistre : nouvel essai necessaire'); // rien n'est memorise : le telephone recommence
    const sender = username ?? `phone-${phoneId}`;
    db.prepare('INSERT INTO agent_sos (client_id, username, incident_id, phone_at, server_at) VALUES (?, ?, ?, ?, ?)').run(clientId, sender, incidentId, Math.round(phoneAt ?? t), t);
    audit(username ?? 'systeme', 'sos_sent', { incidentId, deviceId: id, details: `telephone n°${phoneId}${username === null ? ', agent non identifie' : viaLogin ? ', session terminee' : ''}${discreet ? ', mode discret' : ''}` });
    return { incidentId };
  }

  /**
   * Envoi d'un agent precedent sur un telephone partage (scan, main courante en file) : l'envoi est enregistre au nom de l'agent
   * qui l'a produit (`claimed`) s'il a eu un service sur CE telephone couvrant `phoneAt` (a 5 min pres) ; sinon 403. Sans `claimed`,
   * ou identique a la session : la session. Utilise par patrols.ts pour les scans et la main courante.
   */
  function resolveSender(phoneId: number, sessionUsername: string, claimed: unknown, phoneAt: number): string {
    if (claimed === undefined || claimed === null || claimed === '') return sessionUsername;
    const name = typeof claimed === 'string' ? claimed.trim().toLowerCase() : '';
    if (name === sessionUsername) return sessionUsername;
    const refused = new PsimError(403, "Envoi d'un autre agent refusé");
    if (!name || typeof phoneAt !== 'number' || !Number.isFinite(phoneAt) || !isAgent(name)) throw refused;
    const covered = db
      .prepare(
        `SELECT 1 AS x FROM agent_shift WHERE username = ? AND phone_id = ? AND started_at - ? <= ? AND ? <= COALESCE(ended_at, ends_at) + ? LIMIT 1`,
      )
      .get(name, phoneId, SENDER_MARGIN_MS, phoneAt, phoneAt, SENDER_MARGIN_MS);
    if (!covered) throw refused;
    return name;
  }

  // ------------------------------------------------------------------ tick

  let lastPurge = 0;

  /** Chaque seconde (main.ts) : fin automatique des services, detecteurs virtuels liberes, menage. */
  function tick(): void {
    const t = now();
    // Services echus, ou dont l'agent n'existe plus ou n'est plus actif (compte desactive depuis l'ecran des comptes).
    const due = db
      .prepare(
        `SELECT * FROM agent_shift WHERE ended_at IS NULL AND (ends_at <= ?
           OR username NOT IN (SELECT p.username FROM agent_profile p JOIN app_user u ON u.username = p.username WHERE u.active = 1 AND u.role = 'agent'))`,
      )
      .all(t) as Row[];
    for (const s of due) {
      closeShift(s, (s.ends_at as number) <= t ? 'timeout' : 'admin', 'systeme');
      destroyUserSessions(s.username as string);
    }
    releaseAcknowledged(db, engine, 'A-');
    for (const [id, p] of pendingCodes) if (p.expiresAt < t) pendingCodes.delete(id);
    if (t - lastPurge >= HOUR) {
      lastPurge = t;
      db.prepare('DELETE FROM agent_sos WHERE server_at < ?').run(t - 30 * 24 * HOUR);
    }
  }

  // ------------------------------------------------------------------ HTTP

  let context: MountContext | null = null;
  const phones = new WeakMap<Request, { id: number; label: string }>();
  const agentsOfRequest = new WeakMap<Request, { username: string; phoneId: number }>();

  const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');
  const phoneCookie = (key: string, secure: boolean) => `${PHONE_COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure ? '; Secure' : ''}`;
  const sessionCookie = (token: string, ttlMs: number, secure: boolean) =>
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(1, Math.floor(ttlMs / 1000))}${secure ? '; Secure' : ''}`;
  const clearedSessionCookie = `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  const unauthorized = (res: Response, error: string, reason: 'phone' | 'session') => void res.status(401).json({ error, reason });
  const ipOf = (req: Request) => req.ip ?? 'unknown';

  /** Cookie `psim_phone` valide (cle connue, non revoquee) : sinon 401 `reason: 'phone'` (l'application revient a l'ecran d'appairage). */
  const requirePhone: RequestHandler = (req, res, next) => {
    const phone = checkPhone(parseCookies(req.headers.cookie)[PHONE_COOKIE]);
    if (!phone) return unauthorized(res, 'Téléphone non appairé', 'phone');
    phones.set(req, phone);
    next();
  };

  /** Telephone valide ET session de role agent ouverte SUR CE telephone, compte actif : sinon 401/403. */
  const requireAgent: RequestHandler = (req, res, next) => {
    if (!context) throw new PsimError(500, 'Routes des agents non montees');
    const phone = checkPhone(parseCookies(req.headers.cookie)[PHONE_COOKIE]);
    if (!phone) return unauthorized(res, 'Téléphone non appairé', 'phone');
    const session = context.sessionOf(req);
    if (!session) return unauthorized(res, 'Session terminée', 'session');
    if (session.role !== 'agent') return void res.status(403).json({ error: 'Droits insuffisants' });
    // Une session ouverte sur le telephone A ne sert pas avec la cle du telephone B (cookie de session copie, telephone revoque...).
    if (session.phoneId === undefined || session.phoneId === null || session.phoneId !== phone.id) return unauthorized(res, 'Session terminée', 'session');
    if (!isAgent(session.username) || (profileRow(session.username).active as number) !== 1) return unauthorized(res, 'Session terminée', 'session');
    phones.set(req, phone);
    agentsOfRequest.set(req, { username: session.username, phoneId: phone.id });
    next();
  };

  const agentOf = (req: Request): { username: string; phoneId: number } => {
    const a = agentsOfRequest.get(req);
    if (!a) throw new PsimError(500, 'Requete sans agent (requireAgent manquant)');
    return a;
  };

  const SVG_HEADERS = { 'Content-Type': 'image/svg+xml', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'Cache-Control': 'no-store' };
  const qrSvg = (text: string) => QRCode.toString(text, { type: 'svg', margin: 1, width: 260 });

  /** Certificat public a installer sur le telephone (CA du PSIM). Refuse tout fichier contenant une cle privee. */
  function readCertificate(): Buffer | null {
    if (!deps.certPath) return null;
    try {
      const pem = readFileSync(deps.certPath);
      if (pem.length === 0 || pem.length > MAX_CERT_BYTES) return null;
      if (pem.includes('PRIVATE KEY')) {
        console.warn('[agents] PSIM_TLS_CERT contient une cle privee : jamais servi');
        return null;
      }
      return pem;
    } catch {
      return null;
    }
  }

  function mount(app: Express, ctx: MountContext): void {
    context = ctx;
    const secure = ctx.cookieSecure;
    const small = ctx.json('2kb');
    const adminOnly = ctx.adminOnly; // nom lu tel quel par l'auto-test des routes (test/e2e-attack.test.ts)

    // ---- Telephone ----------------------------------------------------------------------
    app.post('/api/agent/pair', small, (req, res) => {
      const key = `agentpair:${ipOf(req)}`;
      if (isRateLimited(key, now(), 10, MIN)) throw new PsimError(429, 'Trop de tentatives, reessayer dans une minute');
      noStore(res);
      let paired;
      try {
        paired = pairPhone((req.body as { code?: unknown } | undefined)?.code);
      } catch (err) {
        recordFailure(key, now(), MIN);
        throw err;
      }
      res.setHeader('Set-Cookie', phoneCookie(paired.key, secure));
      res.json({ phone: paired.phone });
    });

    app.get('/api/agent/phone', requirePhone, (req, res) => {
      noStore(res);
      res.json({ phone: phones.get(req), agents: phoneAgents() });
    });

    // ---- Connexion, service -------------------------------------------------------------
    app.post('/api/agent/login', requirePhone, small, (req, res) => {
      const phone = phones.get(req)!;
      const key = `agentlogin:${ipOf(req)}`;
      if (isRateLimited(key, now(), 10, MIN)) throw new PsimError(429, 'Trop de tentatives, reessayer dans une minute');
      const { username, pin } = (req.body ?? {}) as { username?: unknown; pin?: unknown };
      let opened;
      try {
        opened = login(phone.id, username, pin);
      } catch (err) {
        if (err instanceof PsimError && (err.status === 401 || err.status === 423)) recordFailure(key, now(), MIN);
        throw err;
      }
      // Une session deja ouverte sur ce navigateur est remplacee, pas empilee.
      destroySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      const token = createSession(opened.username, 'agent', opened.epoch, null, now(), { ttlMs: opened.ttlMs, phoneId: phone.id });
      noStore(res);
      res.setHeader('Set-Cookie', sessionCookie(token, opened.ttlMs, secure));
      res.json({ me: me(opened.username) });
    });

    app.post('/api/agent/logout', (req, res) => {
      destroySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      noStore(res);
      res.setHeader('Set-Cookie', clearedSessionCookie);
      res.json({ ok: true });
    });

    app.get('/api/agent/me', requireAgent, (req, res) => {
      noStore(res);
      res.json({ me: me(agentOf(req).username) });
    });
    app.post('/api/agent/shift/start', requireAgent, (req, res) => {
      const a = agentOf(req);
      noStore(res);
      res.json({ me: startShift(a.username, a.phoneId) });
    });
    app.post('/api/agent/shift/end', requireAgent, (req, res) => {
      endShift(agentOf(req).username, 'agent');
      noStore(res);
      res.setHeader('Set-Cookie', clearedSessionCookie);
      res.json({ ok: true });
    });

    // ---- Alarmes ------------------------------------------------------------------------
    app.get('/api/agent/alarms', requireAgent, (req, res) => {
      noStore(res);
      res.json({ alarms: alarms(agentOf(req).username), serverAt: now() });
    });
    app.post('/api/agent/alarms/:id/ack', requireAgent, (req, res) => {
      ackAlarm(agentOf(req).username, parseId(req.params.id, 'Alarme introuvable'));
      noStore(res);
      res.json({ ok: true });
    });
    app.post('/api/agent/alarms/:id/dispatch', requireAgent, small, (req, res) => {
      dispatch(agentOf(req).username, parseId(req.params.id, 'Alarme introuvable'), (req.body as { status?: unknown } | undefined)?.status);
      noStore(res);
      res.json({ ok: true });
    });
    app.get('/api/agent/alarms/:id/snapshot', requireAgent, (req, res) => {
      const image = snapshotFor(agentOf(req).username, parseId(req.params.id, 'Alarme introuvable'));
      // Type d'apres les octets (JPEG ou PNG, verifies a l'arrivee) ; jamais interpretable comme un document actif.
      res.setHeader('Content-Type', image[0] === 0x89 ? 'image/png' : 'image/jpeg');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      // Pas « immutable » comme /api/snapshots/:id : cette adresse designe la DERNIERE image de l'incident, qui change.
      res.setHeader('Cache-Control', 'private, no-store');
      res.end(image);
    });
    app.get('/api/agent/alarms/:id/live', requireAgent, (req, res) => {
      const camera = typeof req.query.camera === 'string' ? req.query.camera : undefined;
      const cameraId = liveCameraFor(agentOf(req).username, parseId(req.params.id, 'Alarme introuvable'), camera);
      if (!deps.liveStream) throw new PsimError(404, 'Video en direct indisponible');
      deps.liveStream(cameraId, res);
    });

    // ---- SOS ----------------------------------------------------------------------------
    // Avenant 1 : un SOS n'exige que le telephone appaire. Attribution : la session ouverte SUR CE telephone ; sinon le `username`
    // annonce s'il est le dernier agent connecte ici depuis moins de 24 h ; sinon le detecteur de secours du telephone.
    app.post('/api/agent/sos', requirePhone, small, (req, res) => {
      const phone = phones.get(req)!;
      const s = context?.sessionOf(req) ?? null;
      let fromSession: string | null = null;
      if (s && s.role === 'agent' && s.phoneId === phone.id) {
        try {
          if (isAgent(s.username) && (profileRow(s.username).active as number) === 1) fromSession = s.username;
        } catch {
          fromSession = null; // profil illisible : on retombe sur le dernier agent connecte ou le detecteur du telephone
        }
      }
      const claimed = fromSession ? null : lastLoginAgent(phone.id, (req.body as Record<string, unknown> | undefined)?.username);
      noStore(res);
      res.json({ ok: true, incidentId: sos(fromSession ?? claimed, phone.id, req.body, claimed !== null).incidentId });
    });

    // ---- Administration des agents ------------------------------------------------------
    const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
    app.get('/api/agents', ctx.staff, (_req, res) => void res.json(listAgents()));
    app.post('/api/agents', adminOnly, small, (req, res) => void res.status(201).json(createAgent(ctx.actorOf(req), body(req))));
    app.patch('/api/agents/:username', adminOnly, small, (req, res) => void res.json(updateAgent(ctx.actorOf(req), String(req.params.username), body(req))));
    app.delete('/api/agents/:username', adminOnly, (req, res) => {
      disableAgent(ctx.actorOf(req), String(req.params.username));
      res.status(204).end();
    });
    // Le chef de poste (operateur) peut deverrouiller un code et terminer un service (avenant 2) ; l'acteur est journalise.
    app.post('/api/agents/:username/unlock', ctx.staff, (req, res) => void res.json(updateAgent(ctx.actorOf(req), String(req.params.username), { unlock: true })));
    app.post('/api/agents/:username/end-shift', ctx.staff, (req, res) => {
      endShiftByAdmin(ctx.actorOf(req), String(req.params.username));
      res.json({ ok: true });
    });

    // ---- Administration des telephones --------------------------------------------------
    app.get('/api/agent-phones', adminOnly, (_req, res) => void res.json(listPhones()));
    app.post('/api/agent-phones', adminOnly, small, (req, res) => {
      const created = createPhone(ctx.actorOf(req), body(req).label);
      noStore(res);
      res.status(201).json({ id: created.id, pairUrl: `${ctx.originOf(req)}/agent/#pair=${created.code}`, expiresAt: created.expiresAt });
    });
    app.get('/api/agent-phones/:id/pair.svg', adminOnly, async (req, res) => {
      const id = parseId(req.params.id, 'Telephone introuvable');
      const row = phoneRow(id);
      const pending = pendingCodes.get(id);
      // Le code n'est jamais relu de la base : introuvable apres un redemarrage, une revocation ou une expiration.
      if (!pending || pending.expiresAt < now() || row.paired_at !== null || row.revoked_at !== null) throw new PsimError(404, 'Appairage termine, expire ou indisponible');
      const svg = await qrSvg(`${ctx.originOf(req)}/agent/#pair=${pending.code}`);
      res.set(SVG_HEADERS).send(svg);
    });
    app.post('/api/agent-phones/:id/revoke', adminOnly, (req, res) => {
      revokePhone(ctx.actorOf(req), req.params.id);
      res.json({ ok: true });
    });

    // ---- Certificat du PSIM (installation sur le telephone) -----------------------------
    app.get('/api/agent-cert', (_req, res) => {
      const pem = readCertificate();
      if (!pem) throw new PsimError(404, 'Pas de certificat (le PSIM n\'est pas en TLS)');
      res.setHeader('Content-Type', 'application/x-x509-ca-cert');
      res.setHeader('Content-Disposition', 'attachment; filename="psim-certificat.crt"');
      res.setHeader('Cache-Control', 'no-store');
      res.end(pem);
    });
    app.get('/api/agent-cert.svg', adminOnly, async (req, res) => {
      if (!readCertificate()) throw new PsimError(404, 'Pas de certificat (le PSIM n\'est pas en TLS)');
      res.set(SVG_HEADERS).send(await qrSvg(`${ctx.originOf(req)}/api/agent-cert`));
    });

    // ---- Qui se deplace (poste de garde) ------------------------------------------------
    app.get('/api/incidents/:id/dispatch', ctx.staff, (req, res) => {
      const id = parseId(req.params.id, 'Incident introuvable');
      engine.incidentView(id); // 404 si l'incident n'existe pas
      res.json(dispatchesOf(id));
    });
  }

  return {
    createPhone,
    listPhones,
    pairPhone,
    checkPhone,
    revokePhone,
    listAgents,
    createAgent,
    updateAgent,
    disableAgent,
    endShiftByAdmin,
    isAgent,
    zonesOf,
    detectorId: (username: string): string => ensureDetector('systeme', username, profileRow(username).display_name as string),
    phoneAgents,
    login,
    me,
    startShift,
    endShift,
    onShift,
    setPosition,
    positions,
    alarms,
    ackAlarm,
    dispatch,
    dispatchesOf,
    snapshotFor,
    liveCameraFor,
    sos,
    lastLoginAgent,
    resolveSender,
    tick,
    requireAgent,
    agentOf,
    mount,
  };
}

export type Agents = ReturnType<typeof createAgents>;
