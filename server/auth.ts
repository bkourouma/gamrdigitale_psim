import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DEV_PASSWORDS, MIN_PASSWORD_LENGTH } from './preflight.ts';
import type { Role } from './types.ts';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60 * 1000;

/** Une session « restreinte » ne peut qu'accomplir l'etape demandee (changer son mot de passe, activer la 2FA). */
export type Restriction = 'password' | '2fa' | null;

export interface Session {
  username: string;
  role: Role;
  expires: number;
  /** Version des identifiants au moment de la connexion : si elle change, la session n'est plus valable. */
  epoch: number;
  restricted: Restriction;
}

const sessions = new Map<string, Session>();
const failures = new Map<string, number[]>();

/**
 * Controle applique a CHAQUE requete : le compte existe-t-il encore, est-il actif, ses identifiants ont-ils change ?
 * Renvoie la session a jour (le role vient de la base, pas du jeton) ou null. Branche par createApp.
 */
let validator: ((session: Session) => Session | null) | null = null;
export function setSessionValidator(fn: ((session: Session) => Session | null) | null): void {
  validator = fn;
}

function hash(password: string, salt: string): Buffer {
  return scryptSync(password, salt, 64);
}

/** Regles de mot de passe (partagees par l'interface, le CLI et l'API). Renvoie le probleme, ou null. */
export function validatePassword(password: string, username: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `trop court (${MIN_PASSWORD_LENGTH} caracteres minimum)`;
  if (password.length > 200) return 'trop long';
  if (DEV_PASSWORDS.includes(password)) return 'valeur de demonstration publique';
  if (password.toLowerCase().includes(username.toLowerCase())) return "ne doit pas contenir le nom d'utilisateur";
  if (/^(.)\1+$/.test(password)) return 'un seul caractere repete';
  return null;
}

/**
 * Cree le compte, ou change son mot de passe et le role s'il existe. Les autres donnees du compte (2FA, nom,
 * dates) sont conservees, et toute session ouverte est invalidee.
 */
export function createUser(db: DatabaseSync, username: string, role: Role, password: string, now = Date.now()): void {
  const salt = randomBytes(16).toString('hex');
  db.prepare(
    `INSERT INTO app_user (username, role, salt, hash, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET role = excluded.role, salt = excluded.salt, hash = excluded.hash,
       password_changed_at = excluded.password_changed_at, session_epoch = session_epoch + 1`,
  ).run(username, role, salt, hash(password, salt).toString('hex'), now, now);
}

const DUMMY_SALT = randomBytes(16).toString('hex');

/** Verifie les identifiants ; le temps de reponse ne revele ni l'existence du compte ni son statut. */
export function checkCredentials(db: DatabaseSync, username: string, password: string): Role | null {
  const row = db.prepare('SELECT role, salt, hash, active FROM app_user WHERE username = ?').get(username) as
    | { role: Role; salt: string; hash: string; active: number }
    | undefined;
  const candidate = hash(password, row?.salt ?? DUMMY_SALT);
  if (!row) return null;
  const expected = Buffer.from(row.hash, 'hex');
  const ok = candidate.length === expected.length && timingSafeEqual(candidate, expected);
  return ok && row.active === 1 ? row.role : null;
}

export function isRateLimited(key: string, now = Date.now()): boolean {
  const recent = (failures.get(key) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  failures.set(key, recent);
  return recent.length >= MAX_FAILURES;
}

export function recordFailure(key: string, now = Date.now()): void {
  const recent = (failures.get(key) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  recent.push(now);
  failures.set(key, recent);
}

export function createSession(username: string, role: Role, epoch: number, restricted: Restriction = null, now = Date.now()): string {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { username, role, expires: now + SESSION_TTL_MS, epoch, restricted });
  return token;
}

export function getSession(token: string | undefined, now = Date.now()): Session | null {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expires < now) {
    sessions.delete(token);
    return null;
  }
  if (!validator) return session;
  const fresh = validator(session);
  if (!fresh) {
    sessions.delete(token); // compte supprime, desactive ou identifiants changes
    return null;
  }
  return fresh;
}

export function destroySession(token: string | undefined): void {
  if (token) sessions.delete(token);
}

/** Ferme toutes les sessions d'un compte (en plus du controle d'epoch, pour liberer la memoire). */
export function destroyUserSessions(username: string): number {
  let n = 0;
  for (const [token, s] of sessions) {
    if (s.username === username) {
      sessions.delete(token);
      n++;
    }
  }
  return n;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // cookie mal forme : ignore
      }
    }
  }
  return out;
}
