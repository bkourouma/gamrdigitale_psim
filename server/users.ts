/**
 * Gestion des comptes : creation, role, desactivation, mot de passe, double authentification (TOTP).
 *
 * Garanties :
 *  - on ne peut jamais retirer le dernier administrateur actif (suppression, desactivation, changement de role) ;
 *  - tout changement de mot de passe, de role ou de statut invalide immediatement les sessions du compte ;
 *  - un compte cree par un administrateur doit changer son mot de passe a la premiere connexion ;
 *  - le secret TOTP est chiffre en base ; un code ne peut pas etre rejoue ; les codes de secours sont a usage unique.
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import QRCode from 'qrcode';
import { checkCredentials, createUser, destroyUserSessions, validatePassword } from './auth.ts';
import type { Restriction, Session } from './auth.ts';
import { PsimError } from './engine.ts';
import { seal, unseal } from './secrets.ts';
import { base32Decode, base32Encode, hashRecoveryCode, newRecoveryCodes, newSecret, otpauthUri, stepOf, verifyTotp } from './totp.ts';
import type { Role } from './types.ts';

export type RequireTotp = 'none' | 'admin' | 'all';

export interface UserView {
  username: string;
  role: Role;
  displayName: string;
  active: boolean;
  totpEnabled: boolean;
  mustChangePassword: boolean;
  createdAt: number | null;
  lastLoginAt: number | null;
}

export interface UsersDeps {
  db: DatabaseSync;
  key: Buffer;
  audit: (actor: string, action: string, ref?: { details?: string }) => void;
  now?: () => number;
  requireTotp?: RequireTotp;
  issuer?: string;
}

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGE_ATTEMPTS = 5;
const PENDING_TTL_MS = 10 * 60 * 1000;

type Row = Record<string, unknown>;

export function createUsersService(deps: UsersDeps) {
  const { db, key } = deps;
  const now = deps.now ?? Date.now;
  const requireTotp = deps.requireTotp ?? 'none';
  const issuer = deps.issuer ?? 'GAMRdigitale PSIM';

  const challenges = new Map<string, { username: string; expires: number; attempts: number }>();
  const pending = new Map<string, { secret: Buffer; expires: number }>(); // activation 2FA en cours

  const view = (r: Row): UserView => ({
    username: r.username as string,
    role: r.role as Role,
    displayName: (r.display_name as string | null) ?? '',
    active: r.active === 1,
    totpEnabled: r.totp_enabled_at !== null && r.totp_enabled_at !== undefined,
    mustChangePassword: r.must_change_password === 1,
    createdAt: (r.created_at as number | null) ?? null,
    lastLoginAt: (r.last_login_at as number | null) ?? null,
  });

  function row(username: string): Row {
    const r = db.prepare('SELECT * FROM app_user WHERE username = ?').get(username) as Row | undefined;
    if (!r) throw new PsimError(404, 'Compte introuvable');
    return r;
  }

  const activeAdmins = (excluding?: string): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM app_user WHERE role = 'admin' AND active = 1 AND username <> ?").get(excluding ?? '') as { n: number }).n;

  function bumpEpoch(username: string): void {
    db.prepare('UPDATE app_user SET session_epoch = session_epoch + 1 WHERE username = ?').run(username);
    destroyUserSessions(username);
  }

  function list(): UserView[] {
    return (db.prepare('SELECT * FROM app_user ORDER BY username').all() as Row[]).map(view);
  }

  const get = (username: string): UserView => view(row(username));

  function cleanName(value: unknown): string {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string' || value.length > 80 || /[\u0000-\u001f]/.test(value)) throw new PsimError(400, 'Nom affiche invalide (80 caracteres max)');
    return value.trim();
  }

  function checkPassword(password: unknown, username: string): string {
    if (typeof password !== 'string') throw new PsimError(400, 'Mot de passe requis');
    const problem = validatePassword(password, username);
    if (problem) throw new PsimError(400, `Mot de passe refuse : ${problem}`);
    return password;
  }

  function create(actor: string, input: Record<string, unknown>): UserView {
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    if (!USERNAME_PATTERN.test(username)) throw new PsimError(400, "Identifiant invalide (3 a 32 caracteres : lettres minuscules, chiffres, . _ -)");
    if (input.role !== 'operator' && input.role !== 'admin') throw new PsimError(400, 'Role invalide (operator ou admin)');
    if (db.prepare('SELECT 1 AS x FROM app_user WHERE username = ?').get(username)) throw new PsimError(409, 'Cet identifiant existe deja');
    const password = checkPassword(input.password, username);
    const displayName = cleanName(input.displayName); // tout est valide AVANT la moindre ecriture : jamais de creation partielle
    createUser(db, username, input.role, password, now());
    // Mot de passe choisi par l'administrateur : a changer a la premiere connexion.
    db.prepare('UPDATE app_user SET display_name = ?, must_change_password = 1 WHERE username = ?').run(displayName, username);
    deps.audit(actor, 'user_created', { details: `${username} (${input.role})` });
    return get(username);
  }

  function update(actor: string, username: string, patch: Record<string, unknown>): UserView {
    const current = view(row(username));
    const changes: string[] = [];
    let epoch = false;
    const displayName = patch.displayName === undefined ? undefined : cleanName(patch.displayName); // valide d'abord
    if (patch.role !== undefined && patch.role !== 'operator' && patch.role !== 'admin') throw new PsimError(400, 'Role invalide');
    if (patch.active !== undefined && typeof patch.active !== 'boolean') throw new PsimError(400, 'active doit etre vrai ou faux');

    // Tout ou rien : si une des modifications demandees est refusee, aucune n'est appliquee.
    db.exec('BEGIN');
    try {
      if (patch.role !== undefined && patch.role !== current.role) {
        if (current.role === 'admin' && current.active && activeAdmins(username) === 0) throw new PsimError(409, 'Impossible : ce serait retirer le dernier administrateur actif');
        db.prepare('UPDATE app_user SET role = ? WHERE username = ?').run(patch.role, username);
        changes.push(`role ${current.role} -> ${patch.role}`);
        epoch = true;
      }
      if (patch.active !== undefined && patch.active !== current.active) {
        if (!patch.active && username === actor) throw new PsimError(409, 'Vous ne pouvez pas desactiver votre propre compte');
        if (!patch.active && current.role === 'admin' && activeAdmins(username) === 0) throw new PsimError(409, 'Impossible : ce serait desactiver le dernier administrateur actif');
        db.prepare('UPDATE app_user SET active = ? WHERE username = ?').run(patch.active ? 1 : 0, username);
        changes.push(patch.active ? 'reactive' : 'desactive');
        epoch = true;
      }
      if (displayName !== undefined) {
        db.prepare('UPDATE app_user SET display_name = ? WHERE username = ?').run(displayName, username);
        changes.push('nom affiche');
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    if (epoch) bumpEpoch(username);
    if (changes.length > 0) deps.audit(actor, 'user_updated', { details: `${username} : ${changes.join(', ')}` });
    return get(username);
  }

  /** Reinitialise le mot de passe (oubli) : a changer a la prochaine connexion, sessions fermees. */
  function resetPassword(actor: string, username: string, newPassword: unknown): UserView {
    const r = row(username);
    const password = checkPassword(newPassword, username);
    createUser(db, username, r.role as Role, password, now());
    db.prepare('UPDATE app_user SET must_change_password = 1 WHERE username = ?').run(username);
    destroyUserSessions(username);
    deps.audit(actor, 'password_reset', { details: username });
    return get(username);
  }

  function remove(actor: string, username: string): void {
    const current = view(row(username));
    if (username === actor) throw new PsimError(409, 'Vous ne pouvez pas supprimer votre propre compte');
    if (current.role === 'admin' && current.active && activeAdmins(username) === 0) throw new PsimError(409, 'Impossible : ce serait supprimer le dernier administrateur actif');
    db.prepare('DELETE FROM app_user WHERE username = ?').run(username);
    destroyUserSessions(username);
    deps.audit(actor, 'user_deleted', { details: username });
  }

  /** Changement par l'utilisateur lui-meme : exige le mot de passe actuel. */
  function changeOwnPassword(username: string, current: unknown, next: unknown): void {
    const r = row(username);
    if (typeof current !== 'string' || checkCredentials(db, username, current) === null) throw new PsimError(403, 'Mot de passe actuel incorrect');
    const password = checkPassword(next, username);
    if (password === current) throw new PsimError(400, "Le nouveau mot de passe doit etre different de l'ancien");
    createUser(db, username, r.role as Role, password, now());
    db.prepare('UPDATE app_user SET must_change_password = 0 WHERE username = ?').run(username);
    deps.audit(username, 'password_changed');
  }

  // ---------------------------------------------------------------- connexion

  const needsTotp = (role: Role) => requireTotp === 'all' || (requireTotp === 'admin' && role === 'admin');

  /** Etape a accomplir avant d'utiliser l'application : changer son mot de passe, activer la 2FA. */
  function restrictionFor(username: string): Restriction {
    const r = row(username);
    if (r.must_change_password === 1) return 'password';
    if (needsTotp(r.role as Role) && !r.totp_enabled_at) return '2fa';
    return null;
  }

  /** Apres une connexion reussie : date de derniere connexion, version des identifiants, restriction eventuelle. */
  function openSession(username: string): { role: Role; epoch: number; restricted: Restriction } {
    db.prepare('UPDATE app_user SET last_login_at = ? WHERE username = ?').run(now(), username);
    const r = row(username);
    return { role: r.role as Role, epoch: r.session_epoch as number, restricted: restrictionFor(username) };
  }

  const totpEnabled = (username: string): boolean => Boolean(row(username).totp_enabled_at);

  /**
   * Controle applique a chaque requete (voir setSessionValidator) : le role et la restriction viennent de la base,
   * jamais du jeton ; un compte supprime, desactive ou dont les identifiants ont change n'a plus de session.
   */
  function validateSession(session: Session): Session | null {
    const r = db.prepare('SELECT role, active, session_epoch FROM app_user WHERE username = ?').get(session.username) as Row | undefined;
    if (!r || r.active !== 1 || r.session_epoch !== session.epoch) return null;
    return { ...session, role: r.role as Role, restricted: restrictionFor(session.username) };
  }

  /** Defi a repondre avec un code a six chiffres : valable 5 minutes, 5 essais, ne donne PAS de session. */
  function createChallenge(username: string): string {
    const token = randomBytes(24).toString('hex');
    challenges.set(token, { username, expires: now() + CHALLENGE_TTL_MS, attempts: 0 });
    return token;
  }

  /** Verifie un code TOTP ou un code de secours pour ce compte. Renvoie vrai si accepte (et le consomme). */
  function verifySecondFactor(username: string, code: string): boolean {
    const r = row(username);
    if (!r.totp_secret) return false;
    const step = verifyTotp(base32Decode(unseal(key, r.totp_secret as string)), code, now());
    if (step !== null) {
      // Rejeu : une fenetre deja utilisee (ou plus ancienne) est refusee.
      const used = db.prepare('UPDATE app_user SET totp_last_step = ? WHERE username = ? AND (totp_last_step IS NULL OR totp_last_step < ?)').run(step, username, step);
      return used.changes === 1;
    }
    const recovery = db.prepare('UPDATE recovery_code SET used_at = ? WHERE username = ? AND hash = ? AND used_at IS NULL').run(now(), username, hashRecoveryCode(code));
    if (recovery.changes === 1) {
      deps.audit(username, 'recovery_code_used');
      return true;
    }
    return false;
  }

  /**
   * Repond a un defi. Distingue une simple faute de frappe (le defi reste valable : on peut reessayer) d'un defi
   * expire ou epuise (il faut repartir du mot de passe).
   */
  function answerChallengeDetailed(token: string, code: unknown): { username: string } | { error: 'wrong' | 'expired'; attemptsLeft: number } {
    const c = challenges.get(token);
    if (!c || c.expires < now()) {
      challenges.delete(token);
      return { error: 'expired', attemptsLeft: 0 };
    }
    c.attempts++;
    if (typeof code === 'string' && verifySecondFactor(c.username, code)) {
      challenges.delete(token);
      return { username: c.username };
    }
    if (c.attempts >= MAX_CHALLENGE_ATTEMPTS) {
      challenges.delete(token); // trop d'essais : le defi est detruit
      return { error: 'expired', attemptsLeft: 0 };
    }
    return { error: 'wrong', attemptsLeft: MAX_CHALLENGE_ATTEMPTS - c.attempts };
  }

  /** Renvoie le nom d'utilisateur si le code est bon, null sinon (et compte l'essai). */
  function answerChallenge(token: string, code: unknown): string | null {
    const r = answerChallengeDetailed(token, code);
    return 'username' in r ? r.username : null;
  }

  // ---------------------------------------------------------------- double authentification

  /** Etape 1 : genere un secret (non encore actif) et le QR code a scanner. */
  async function beginTotp(username: string): Promise<{ secret: string; uri: string; qrSvg: string }> {
    if (totpEnabled(username)) throw new PsimError(409, 'La double authentification est deja active');
    const secret = newSecret();
    pending.set(username, { secret, expires: now() + PENDING_TTL_MS });
    const uri = otpauthUri({ secret, account: username, issuer });
    return { secret: base32Encode(secret), uri, qrSvg: await QRCode.toString(uri, { type: 'svg', margin: 1, width: 220 }) };
  }

  /** Etape 2 : un code valide prouve que l'application est bien configuree ; active et renvoie les codes de secours. */
  function enableTotp(username: string, code: unknown): string[] {
    const p = pending.get(username);
    if (!p || p.expires < now()) throw new PsimError(400, "Aucune activation en cours (ou elle a expire) : recommencer");
    const step = typeof code === 'string' ? verifyTotp(p.secret, code, now()) : null;
    if (step === null) throw new PsimError(400, 'Code incorrect : verifier l\'heure du telephone et recommencer');
    db.prepare('UPDATE app_user SET totp_secret = ?, totp_enabled_at = ?, totp_last_step = ? WHERE username = ?').run(seal(key, base32Encode(p.secret)), now(), step, username);
    pending.delete(username);
    const codes = storeRecoveryCodes(username);
    deps.audit(username, 'totp_enabled');
    return codes;
  }

  function storeRecoveryCodes(username: string): string[] {
    db.prepare('DELETE FROM recovery_code WHERE username = ?').run(username);
    const codes = newRecoveryCodes();
    const insert = db.prepare('INSERT INTO recovery_code (username, hash) VALUES (?, ?)');
    for (const c of codes) insert.run(username, hashRecoveryCode(c));
    return codes;
  }

  /** Desactivation par l'utilisateur : exige son mot de passe. */
  function disableTotp(username: string, password: unknown): void {
    if (typeof password !== 'string' || checkCredentials(db, username, password) === null) throw new PsimError(403, 'Mot de passe incorrect');
    const r = row(username);
    if (needsTotp(r.role as Role)) throw new PsimError(409, 'La double authentification est obligatoire pour ce role');
    clearTotp(username);
    deps.audit(username, 'totp_disabled');
  }

  function clearTotp(username: string): void {
    db.prepare('UPDATE app_user SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE username = ?').run(username);
    db.prepare('DELETE FROM recovery_code WHERE username = ?').run(username);
    pending.delete(username);
  }

  /** Telephone perdu : l'administrateur retire la 2FA du compte, ses sessions sont fermees. */
  function adminResetTotp(actor: string, username: string): UserView {
    row(username);
    clearTotp(username);
    destroyUserSessions(username);
    bumpEpoch(username);
    deps.audit(actor, 'totp_reset', { details: username });
    return get(username);
  }

  function regenerateRecovery(username: string, password: unknown): string[] {
    if (typeof password !== 'string' || checkCredentials(db, username, password) === null) throw new PsimError(403, 'Mot de passe incorrect');
    if (!totpEnabled(username)) throw new PsimError(409, "La double authentification n'est pas active");
    deps.audit(username, 'recovery_regenerated');
    return storeRecoveryCodes(username);
  }

  const recoveryLeft = (username: string): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM recovery_code WHERE username = ? AND used_at IS NULL').get(username) as { n: number }).n;

  return {
    list,
    get,
    create,
    update,
    resetPassword,
    remove,
    changeOwnPassword,
    restrictionFor,
    openSession,
    totpEnabled,
    validateSession,
    createChallenge,
    answerChallenge,
    answerChallengeDetailed,
    beginTotp,
    enableTotp,
    disableTotp,
    adminResetTotp,
    regenerateRecovery,
    recoveryLeft,
    stepNow: () => stepOf(now()),
  };
}

export type UsersService = ReturnType<typeof createUsersService>;
