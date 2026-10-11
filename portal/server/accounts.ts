/**
 * Comptes, sessions et PORTEE d'acces du portail.
 *
 * La regle qui compte : un client ne voit que ses sites. Elle n'est pas dans l'affichage, elle est ici : toute lecture de
 * donnees passe par `visibleSites` / `canSee`, qui partent du compte (role, organisation, site) lu en base a CHAQUE requete,
 * jamais d'une valeur fournie par le navigateur. Un site qu'on n'a pas le droit de voir est « introuvable » (404), pas
 * « interdit » (403) : on ne revele pas qu'il existe.
 *
 * Niveau groupe : un directeur peut etre limite a un ou plusieurs groupes (directeur regional) ; `visibleSites` et
 * `visibleGroups` appliquent cette limite. Limite a un groupe, il voit ses sous-groupes ; limite a un sous-groupe, rien
 * au-dessus. Un site sans groupe n'est vu que d'un directeur non limite. Un compte limite mais sans aucun groupe ne voit RIEN :
 * jamais « toute l'organisation » par defaut. Un groupe hors perimetre est « introuvable » comme un site.
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
  /**
   * Groupes auxquels un directeur est limite (identifiants), `null` : aucune limite de groupe. Tableau vide : compte limite
   * sans groupe, il ne voit rien. Lu en base a chaque requete, comme le reste.
   */
  groupScope: number[] | null;
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
  /** Directeur seulement : limite le compte a ces groupes (identifiants). Absent : toute l'organisation. */
  groupIds?: number[];
}

/** Cree un compte (mot de passe initial a changer a la premiere connexion). */
export function createUser(db: DatabaseSync, user: NewUser, password: string, now = Date.now()): void {
  if (!USERNAME_PATTERN.test(user.username)) throw new Error("nom d'utilisateur invalide : 4 a 40 caracteres, minuscules, chiffres, . _ -");
  const problem = validatePassword(password, user.username);
  if (problem) throw new Error(`mot de passe ${problem}`);
  if (user.groupIds !== undefined && user.role !== 'director') throw new Error('seul un directeur peut etre limite a des groupes');
  if (user.groupIds !== undefined && user.groupIds.length === 0) throw new Error('au moins un groupe est necessaire pour limiter un compte');
  const salt = randomBytes(16).toString('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO portal_user (username, role, org_id, site_id, display_name, salt, hash, created_at, group_limited) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      user.username,
      user.role,
      user.role === 'admin' ? null : (user.orgId ?? null),
      user.role === 'site_manager' ? (user.siteId ?? null) : null,
      user.displayName ?? user.username,
      salt,
      hashPassword(password, salt).toString('hex'),
      now,
      user.groupIds ? 1 : 0,
    );
    for (const id of new Set(user.groupIds ?? [])) db.prepare('INSERT INTO portal_user_group (username, group_id) VALUES (?, ?)').run(user.username, id);
    writeAudit(db, 'cli', 'user_created', `${user.username} (${user.role})${user.groupIds ? ` limite a ${user.groupIds.length} groupe(s)` : ''}`, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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
      `SELECT u.username, u.role, u.org_id, u.site_id, u.display_name, u.active, u.must_change_password, u.session_epoch, u.group_limited, s.epoch, s.expires_at
       FROM session s JOIN portal_user u ON u.username = s.username WHERE s.token_hash = ?`,
    )
    .get(tokenHash(token)) as { username: string; role: Role; org_id: number | null; site_id: string | null; display_name: string; active: number; must_change_password: number; session_epoch: number; group_limited: number; epoch: number; expires_at: number } | undefined;
  if (!row || row.expires_at < now || row.active !== 1 || row.epoch !== row.session_epoch) return null;
  // Limite = marque posee OU au moins un groupe note : la lecture la plus stricte l'emporte si les deux divergeaient.
  const groups = row.role === 'director' ? (db.prepare('SELECT group_id FROM portal_user_group WHERE username = ?').all(row.username) as { group_id: number }[]).map((g) => g.group_id) : [];
  const limited = row.role === 'director' && (row.group_limited === 1 || groups.length > 0);
  return { username: row.username, role: row.role, orgId: row.org_id, siteId: row.site_id, displayName: row.display_name, mustChangePassword: row.must_change_password === 1, groupScope: limited ? groups : null };
}

// ---------------------------------------------------------------- portee

export interface VisibleSite extends SiteRow {
  org_name: string;
  group_id: number | null;
}

export interface GroupRow {
  id: number;
  org_id: number;
  org_name: string;
  code: string;
  name: string;
  parent_id: number | null;
}

/**
 * Les groupes (et sous-groupes) que le compte peut voir. `null` : aucune limite de groupe. Limite a un groupe, il voit aussi
 * ses sous-groupes (y compris ceux crees plus tard) ; limite a un sous-groupe, uniquement celui-la.
 */
export function allowedGroupIds(db: DatabaseSync, p: Principal): number[] | null {
  if (p.role !== 'director' || p.groupScope === null) return null;
  if (p.groupScope.length === 0) return [];
  const marks = p.groupScope.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT id FROM site_group WHERE org_id = ? AND (id IN (${marks}) OR parent_id IN (${marks}))`).all(p.orgId, ...p.groupScope, ...p.groupScope) as { id: number }[];
  return rows.map((r) => r.id);
}

/** Les sites qu'un compte a le droit de voir : jamais d'autres. */
export function visibleSites(db: DatabaseSync, p: Principal): VisibleSite[] {
  const base = 'SELECT s.id, s.org_id, s.name, s.key_version, s.active, s.last_received_at, s.group_id, o.name AS org_name FROM site s JOIN organization o ON o.id = s.org_id WHERE s.active = 1';
  if (p.role === 'admin') return db.prepare(`${base} ORDER BY o.name, s.name`).all() as unknown as VisibleSite[];
  if (p.role === 'director') {
    const allowed = allowedGroupIds(db, p);
    if (allowed === null) return db.prepare(`${base} AND s.org_id = ? ORDER BY s.name`).all(p.orgId) as unknown as VisibleSite[];
    if (allowed.length === 0) return [];
    return db.prepare(`${base} AND s.org_id = ? AND s.group_id IN (${allowed.map(() => '?').join(', ')}) ORDER BY s.name`).all(p.orgId, ...allowed) as unknown as VisibleSite[];
  }
  return db.prepare(`${base} AND s.id = ?`).all(p.siteId) as unknown as VisibleSite[];
}

export function visibleSite(db: DatabaseSync, p: Principal, siteId: string): VisibleSite | null {
  return visibleSites(db, p).find((s) => s.id === siteId) ?? null;
}

/** Les groupes que le compte voit. Un responsable de site n'en voit aucun : son perimetre est un seul site. */
export function visibleGroups(db: DatabaseSync, p: Principal): GroupRow[] {
  const base = 'SELECT g.id, g.org_id, o.name AS org_name, g.code, g.name, g.parent_id FROM site_group g JOIN organization o ON o.id = g.org_id';
  if (p.role === 'admin') return db.prepare(`${base} ORDER BY o.name, g.name`).all() as unknown as GroupRow[];
  if (p.role !== 'director') return [];
  const allowed = allowedGroupIds(db, p);
  if (allowed === null) return db.prepare(`${base} WHERE g.org_id = ? ORDER BY g.name`).all(p.orgId) as unknown as GroupRow[];
  if (allowed.length === 0) return [];
  return db.prepare(`${base} WHERE g.org_id = ? AND g.id IN (${allowed.map(() => '?').join(', ')}) ORDER BY g.name`).all(p.orgId, ...allowed) as unknown as GroupRow[];
}

export function visibleGroup(db: DatabaseSync, p: Principal, groupId: number): GroupRow | null {
  return visibleGroups(db, p).find((g) => g.id === groupId) ?? null;
}
