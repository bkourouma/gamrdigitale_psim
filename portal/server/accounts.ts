/**
 * Comptes, sessions et PORTEE d'acces du portail.
 *
 * La regle qui compte : un client ne voit que ses sites. Elle n'est pas dans l'affichage, elle est ici : toute lecture de
 * donnees passe par `visibleSites` / `canSee`, qui partent du compte (role, organisation, site) lu en base a CHAQUE requete,
 * jamais d'une valeur fournie par le navigateur. Un site qu'on n'a pas le droit de voir est « introuvable » (404), pas
 * « interdit » (403) : on ne revele pas qu'il existe.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { writeAudit } from './db.ts';
import type { SiteRow } from './ingest.ts';

export type Role = 'admin' | 'director' | 'site_manager';
export const MIN_PASSWORD_LENGTH = 12;
export const SESSION_TTL_MS = 12 * 3_600_000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;

export interface Principal {
  username: string;
  role: Role;
  orgId: number | null;
  siteId: string | null;
  displayName: string;
  mustChangePassword: boolean;
}

const hashPassword = (password: string, salt: string): Buffer => scryptSync(password, salt, 64);
const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

const WEAK = ['password', 'motdepasse', 'azerty', 'qwerty', 'admin', 'bienvenue', 'welcome', 'changeme', 'portail', '123456789', '1234'];

/** Regles de mot de passe. Renvoie le probleme, ou null. */
export function validatePassword(password: string, username: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `trop court (${MIN_PASSWORD_LENGTH} caracteres minimum)`;
  if (password.length > 200) return 'trop long';
  if (password.toLowerCase().includes(username.toLowerCase())) return "ne doit pas contenir le nom d'utilisateur";
  if (/^(.)\1+$/.test(password) || /^\d+$/.test(password)) return 'trop simple';
  const flat = password.toLowerCase().replace(/[^a-z0-9]/g, '');
  const rest = [...WEAK].sort((a, b) => b.length - a.length).reduce((r, w) => r.split(w).join(''), flat);
  if (rest.length < 4) return 'mot de passe trop courant';
  return null;
}

/** Mot de passe initial genere : 18 caracteres sans ambiguite (ni 0/O ni 1/l/I), a changer a la premiere connexion. */
export function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(18);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,38}[a-z0-9]$/;

export interface NewUser {
  username: string;
  role: Role;
  orgId?: number | null;
  siteId?: string | null;
  displayName?: string;
}

/** Cree un compte (mot de passe initial a changer a la premiere connexion). */
export function createUser(db: DatabaseSync, user: NewUser, password: string, now = Date.now()): void {
  if (!USERNAME_PATTERN.test(user.username)) throw new Error("nom d'utilisateur invalide : 4 a 40 caracteres, minuscules, chiffres, . _ -");
  const problem = validatePassword(password, user.username);
  if (problem) throw new Error(`mot de passe ${problem}`);
  const salt = randomBytes(16).toString('hex');
  db.prepare('INSERT INTO portal_user (username, role, org_id, site_id, display_name, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    user.username,
    user.role,
    user.role === 'admin' ? null : (user.orgId ?? null),
    user.role === 'site_manager' ? (user.siteId ?? null) : null,
    user.displayName ?? user.username,
    salt,
    hashPassword(password, salt).toString('hex'),
    now,
  );
  writeAudit(db, 'cli', 'user_created', `${user.username} (${user.role})`, now);
}

/** Change le mot de passe ; toutes les sessions ouvertes du compte sont invalidees. */
export function setPassword(db: DatabaseSync, username: string, password: string, mustChange: boolean, now = Date.now()): void {
  const problem = validatePassword(password, username);
  if (problem) throw new Error(`mot de passe ${problem}`);
  const salt = randomBytes(16).toString('hex');
  const res = db.prepare('UPDATE portal_user SET salt = ?, hash = ?, must_change_password = ?, session_epoch = session_epoch + 1 WHERE username = ?').run(salt, hashPassword(password, salt).toString('hex'), mustChange ? 1 : 0, username);
  if (res.changes === 0) throw new Error('compte introuvable');
  db.prepare('DELETE FROM session WHERE username = ?').run(username);
}

export function setActive(db: DatabaseSync, username: string, active: boolean): void {
  const res = db.prepare('UPDATE portal_user SET active = ?, session_epoch = session_epoch + 1 WHERE username = ?').run(active ? 1 : 0, username);
  if (res.changes === 0) throw new Error('compte introuvable');
  db.prepare('DELETE FROM session WHERE username = ?').run(username);
}

// ---------------------------------------------------------------- connexion

const failures = new Map<string, number[]>();

export function isThrottled(key: string, now = Date.now()): boolean {
  const recent = (failures.get(key) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  failures.set(key, recent);
  return recent.length >= MAX_FAILURES;
}
export function recordFailure(key: string, now = Date.now()): void {
  const recent = (failures.get(key) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  recent.push(now);
  failures.set(key, recent);
  if (failures.size > 5000) for (const [k, v] of failures) if (v.every((t) => now - t >= FAILURE_WINDOW_MS)) failures.delete(k);
}
export function clearFailures(key: string): void {
  failures.delete(key);
}
/** Remet les compteurs a zero (tests). */
export function resetThrottles(): void {
  failures.clear();
}

const DUMMY_SALT = randomBytes(16).toString('hex');

/** Verifie les identifiants. Meme duree que le compte existe ou non, meme refus dans tous les cas. */
export function checkCredentials(db: DatabaseSync, username: string, password: string): { username: string; epoch: number } | null {
  const row = db.prepare('SELECT username, salt, hash, active, session_epoch FROM portal_user WHERE username = ?').get(username) as { username: string; salt: string; hash: string; active: number; session_epoch: number } | undefined;
  const candidate = hashPassword(password, row?.salt ?? DUMMY_SALT);
  const expected = Buffer.from(row?.hash ?? '', 'hex');
  const ok = row !== undefined && row.active === 1 && candidate.length === expected.length && timingSafeEqual(candidate, expected);
  return ok ? { username: row!.username, epoch: row!.session_epoch } : null;
}

export function createSession(db: DatabaseSync, username: string, epoch: number, now = Date.now()): string {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO session (token_hash, username, epoch, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash(token), username, epoch, now + SESSION_TTL_MS);
  db.prepare('UPDATE portal_user SET last_login_at = ? WHERE username = ?').run(now, username);
  return token;
}

export function destroySession(db: DatabaseSync, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM session WHERE token_hash = ?').run(tokenHash(token));
}

export function purgeSessions(db: DatabaseSync, now = Date.now()): void {
  db.prepare('DELETE FROM session WHERE expires_at < ?').run(now);
}

/**
 * Le compte derriere un jeton, ou null. Role, perimetre et statut viennent de la base A CHAQUE REQUETE : desactiver un
 * compte ou changer son mot de passe coupe ses sessions aussitot.
 */
export function principalFor(db: DatabaseSync, token: string | undefined, now = Date.now()): Principal | null {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = db
    .prepare(
      `SELECT u.username, u.role, u.org_id, u.site_id, u.display_name, u.active, u.must_change_password, u.session_epoch, s.epoch, s.expires_at
       FROM session s JOIN portal_user u ON u.username = s.username WHERE s.token_hash = ?`,
    )
    .get(tokenHash(token)) as { username: string; role: Role; org_id: number | null; site_id: string | null; display_name: string; active: number; must_change_password: number; session_epoch: number; epoch: number; expires_at: number } | undefined;
  if (!row || row.expires_at < now || row.active !== 1 || row.epoch !== row.session_epoch) return null;
  return { username: row.username, role: row.role, orgId: row.org_id, siteId: row.site_id, displayName: row.display_name, mustChangePassword: row.must_change_password === 1 };
}

// ---------------------------------------------------------------- portee

export interface VisibleSite extends SiteRow {
  org_name: string;
}

/** Les sites qu'un compte a le droit de voir : jamais d'autres. */
export function visibleSites(db: DatabaseSync, p: Principal): VisibleSite[] {
  const base = 'SELECT s.id, s.org_id, s.name, s.key_version, s.active, s.last_received_at, o.name AS org_name FROM site s JOIN organization o ON o.id = s.org_id WHERE s.active = 1';
  if (p.role === 'admin') return db.prepare(`${base} ORDER BY o.name, s.name`).all() as unknown as VisibleSite[];
  if (p.role === 'director') return db.prepare(`${base} AND s.org_id = ? ORDER BY s.name`).all(p.orgId) as unknown as VisibleSite[];
  return db.prepare(`${base} AND s.id = ?`).all(p.siteId) as unknown as VisibleSite[];
}

export function visibleSite(db: DatabaseSync, p: Principal, siteId: string): VisibleSite | null {
  return visibleSites(db, p).find((s) => s.id === siteId) ?? null;
}
