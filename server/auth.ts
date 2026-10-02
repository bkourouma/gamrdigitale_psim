import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Role } from './types.ts';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60 * 1000;

export interface Session {
  username: string;
  role: Role;
  expires: number;
}

const sessions = new Map<string, Session>();
const failures = new Map<string, number[]>();

function hash(password: string, salt: string): Buffer {
  return scryptSync(password, salt, 64);
}

export function createUser(db: DatabaseSync, username: string, role: Role, password: string): void {
  const salt = randomBytes(16).toString('hex');
  db.prepare('INSERT OR REPLACE INTO app_user (username, role, salt, hash) VALUES (?, ?, ?, ?)').run(
    username,
    role,
    salt,
    hash(password, salt).toString('hex'),
  );
}

const DUMMY_SALT = randomBytes(16).toString('hex');

/** Verifie les identifiants ; le temps de reponse ne revele pas si l'utilisateur existe. */
export function checkCredentials(db: DatabaseSync, username: string, password: string): Role | null {
  const row = db.prepare('SELECT role, salt, hash FROM app_user WHERE username = ?').get(username) as
    | { role: Role; salt: string; hash: string }
    | undefined;
  const candidate = hash(password, row?.salt ?? DUMMY_SALT);
  if (!row) return null;
  const expected = Buffer.from(row.hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected) ? row.role : null;
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

export function createSession(username: string, role: Role, now = Date.now()): string {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { username, role, expires: now + SESSION_TTL_MS });
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
  return session;
}

export function destroySession(token: string | undefined): void {
  if (token) sessions.delete(token);
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
