import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
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
 * Sessions gardees aussi en base : un redemarrage du PSIM (mise a jour, plantage, coupure) ne deconnecte personne, et
 * l'ecran d'un operateur revient seul. Seule l'EMPREINTE SHA-256 du jeton est stockee : le jeton n'existe que dans le
 * cookie du navigateur, une copie de la base ou d'une sauvegarde ne permet pas de se connecter. Les memes controles
 * s'appliquent a chaque requete (expiration 12 h, compte actif, identifiants inchanges : voir le validateur).
 * Sans base (tests unitaires), les sessions restent en memoire seulement.
 */
let store: DatabaseSync | null = null;
export function useSessionStore(db: DatabaseSync | null): void {
  store = db;
}
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

function forget(token: string): void {
  sessions.delete(token);
  store?.prepare('DELETE FROM app_session WHERE token_hash = ?').run(tokenHash(token));
}

/** Session connue de la base mais pas de la memoire (le PSIM a redemarre depuis la connexion). */
function loadStored(token: string): Session | null {
  if (!store || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = store.prepare('SELECT username, role, expires, epoch, restricted FROM app_session WHERE token_hash = ?').get(tokenHash(token)) as
    | { username: string; role: Role; expires: number; epoch: number; restricted: string | null }
    | undefined;
  if (!row) return null;
  const session: Session = { username: row.username, role: row.role, expires: row.expires, epoch: row.epoch, restricted: (row.restricted as Restriction) ?? null };
  sessions.set(token, session);
  return session;
}

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

// Mots de passe les plus courants (en clair ou repetes) : refuses meme s'ils atteignent la longueur minimale.
const WEAK = ['password', 'motdepasse', 'azertyuiop', 'qwertyuiop', 'azerty', 'qwerty', 'admin', 'administrateur', 'bienvenue', 'welcome', 'letmein', 'changeme', 'iloveyou', '123456789', '1234567890', '1234', 'abcdefgh'];

// Les mots longs d'abord : « administrateur » ne doit pas etre decoupe en « admin » + un reste.
const WEAK_BY_LENGTH = [...WEAK].sort((a, b) => b.length - a.length);

/** Regles de mot de passe (partagees par l'interface, le CLI et l'API). Renvoie le probleme, ou null. */
export function validatePassword(password: string, username: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `trop court (${MIN_PASSWORD_LENGTH} caracteres minimum)`;
  if (password.length > 200) return 'trop long';
  if (DEV_PASSWORDS.includes(password)) return 'valeur de demonstration publique';
  if (password.toLowerCase().includes(username.toLowerCase())) return "ne doit pas contenir le nom d'utilisateur";
  if (/^(.)\1+$/.test(password)) return 'un seul caractere repete';
  if (/^\d+$/.test(password)) return 'uniquement des chiffres';
  const flat = password.toLowerCase().replace(/[^a-z0-9]/g, '');
  // Une fois retires tous les mots courants, il ne reste presque rien : « passwordpassword », « azertyqwerty », « admin1234 ».
  if (WEAK_BY_LENGTH.reduce((rest, w) => rest.split(w).join(''), flat).length < 4) return 'mot de passe trop courant';
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

/** `limit` echecs dans `windowMs` : par defaut 5 par minute. */
/**
 * Comptes dont le mot de passe STOCKE est encore une valeur de demonstration publique. Le controle de demarrage ne voit que
 * l'environnement ; or une base creee en developpement (ou restauree) garde ses comptes, quels que soient les .env d'apres :
 * `admin / admin-dev-only` resterait valable en production.
 */
export function accountsWithDevPassword(db: DatabaseSync): string[] {
  const out: string[] = [];
  for (const u of db.prepare('SELECT username, salt, hash FROM app_user').all() as { username: string; salt: string; hash: string }[]) {
    const stored = Buffer.from(u.hash, 'hex');
    for (const dev of DEV_PASSWORDS) {
      const candidate = hash(dev, u.salt);
      if (candidate.length === stored.length && timingSafeEqual(candidate, stored)) {
        out.push(u.username);
        break;
      }
    }
  }
  return out;
}

export function isRateLimited(key: string, now = Date.now(), limit = MAX_FAILURES, windowMs = FAILURE_WINDOW_MS): boolean {
  const recent = (failures.get(key) ?? []).filter((t) => now - t < windowMs);
  failures.set(key, recent);
  return recent.length >= limit;
}

export function recordFailure(key: string, now = Date.now(), windowMs = FAILURE_WINDOW_MS): void {
  const recent = (failures.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  failures.set(key, recent);
}

/**
 * Adresses depuis lesquelles un compte s'est deja connecte avec succes. Quand le compte est verrouille par trop
 * d'echecs (venus d'ailleurs), son titulaire peut quand meme se connecter depuis SON adresse habituelle : sans cela,
 * cinq mauvais mots de passe par minute suffiraient a interdire durablement l'acces de l'administrateur.
 * En memoire : perdu au redemarrage, ce qui ne ferme que cette tolerance.
 */
const knownIps = new Map<string, Set<string>>();
const MAX_KNOWN_IPS = 20;

export function rememberLoginIp(username: string, ip: string): void {
  const set = knownIps.get(username) ?? new Set<string>();
  if (set.size >= MAX_KNOWN_IPS && !set.has(ip)) set.delete(set.values().next().value as string);
  set.add(ip);
  knownIps.set(username, set);
}

export const isKnownLoginIp = (username: string, ip: string): boolean => knownIps.get(username)?.has(ip) ?? false;

/** Libere la memoire : sessions expirees et echecs anciens (les cles de verrouillage viennent du client). */
export function purgeExpired(now = Date.now()): void {
  for (const [token, s] of sessions) if (s.expires < now) sessions.delete(token);
  store?.prepare('DELETE FROM app_session WHERE expires < ?').run(now);
  for (const [key, list] of failures) {
    const recent = list.filter((t) => now - t < 10 * 60_000);
    if (recent.length === 0) failures.delete(key);
    else failures.set(key, recent);
  }
}

export function createSession(username: string, role: Role, epoch: number, restricted: Restriction = null, now = Date.now()): string {
  const token = randomBytes(32).toString('hex');
  const session: Session = { username, role, expires: now + SESSION_TTL_MS, epoch, restricted };
  sessions.set(token, session);
  store
    ?.prepare('INSERT INTO app_session (token_hash, username, role, expires, epoch, restricted) VALUES (?, ?, ?, ?, ?, ?)')
    .run(tokenHash(token), username, role, session.expires, epoch, restricted);
  return token;
}

export function getSession(token: string | undefined, now = Date.now()): Session | null {
  if (!token) return null;
  const session = sessions.get(token) ?? loadStored(token);
  if (!session) return null;
  if (session.expires < now) {
    forget(token);
    return null;
  }
  if (!validator) return session;
  const fresh = validator(session);
  if (!fresh) {
    forget(token); // compte supprime, desactive ou identifiants changes
    return null;
  }
  return fresh;
}

/** Oublie les sessions EN MEMOIRE seulement (comme apres un redemarrage) : celles de la base seront relues au besoin. */
export function clearSessionCache(): void {
  sessions.clear();
}

export function destroySession(token: string | undefined): void {
  if (token) forget(token);
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
  store?.prepare('DELETE FROM app_session WHERE username = ?').run(username);
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
