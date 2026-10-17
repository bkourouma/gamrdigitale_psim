/**
 * Re-authentification : redemande le mot de passe du compte DEJA connecte avant une operation qui, avec un cookie vole,
 * donnerait la main sur une porte (gestion des comptes, configuration des actionneurs, mode maintenance, commandes de
 * serrure et de portail). Un cookie seul ne suffit plus.
 *
 * Le compteur d'echecs est CELUI DE LA CONNEXION (`user:<compte>`) : 5 essais par minute au total, par la connexion ou par
 * la re-authentification, jamais 5 + 5. Au cinquieme echec, les sessions du compte sont fermees (un voleur de cookie qui
 * devine le mot de passe perd son cookie) ; le titulaire se reconnecte avec son mot de passe.
 */
import type { DatabaseSync } from 'node:sqlite';
import { checkCredentials, destroyUserSessions, isRateLimited, recordFailure } from './auth.ts';
import { PsimError } from './errors.ts';

export type AuditFn = (actor: string, action: string, ref?: { incidentId?: number; deviceId?: string; details?: string }) => void;

export interface ReauthOptions {
  /** Entree de journal en cas d'echec (defaut : `reauth_echec`). */
  failAction?: string;
  /** Operation demandee, pour le journal (« creation de compte »...). */
  what: string;
  deviceId?: string;
}

/** Verifie le mot de passe du compte `username`. Leve 428 (absent), 403 (faux) ou 429 (trop d'essais). */
export function reauthenticate(db: DatabaseSync, username: string, password: unknown, audit: AuditFn, opts: ReauthOptions): void {
  if (typeof password !== 'string' || !password) throw new PsimError(428, 'Mot de passe de votre compte requis pour cette operation');
  const key = `user:${username.trim().toLowerCase()}`;
  if (isRateLimited(key)) throw new PsimError(429, 'Trop de mots de passe faux, reessayer dans une minute');
  if (password.length > 200 || checkCredentials(db, username, password) === null) {
    recordFailure(key);
    audit(username, opts.failAction ?? 'reauth_echec', { deviceId: opts.deviceId, details: `${opts.what} refuse : mot de passe incorrect` });
    if (isRateLimited(key)) {
      const closed = destroyUserSessions(username);
      audit('systeme', 'reauth_session_fermee', { details: `compte ${username} : trop de mots de passe faux a la re-authentification, ${closed} session(s) fermee(s)` });
    }
    throw new PsimError(403, 'Mot de passe incorrect');
  }
}
