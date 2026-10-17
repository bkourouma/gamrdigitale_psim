/**
 * Requetes HTTP GET authentifiees en Digest vers un controleur Dahua (une requete = un defi 401 puis la reponse, avec
 * `authorization()` de server/dahua.ts, eprouve sur un vrai enregistreur).
 *
 * Surete :
 *  - delai maximal par echange, taille de la reponse bornee (1 Mo), annulation de tout ce qui est en cours a l'arret ;
 *  - Digest SEULEMENT (jamais Basic : le mot de passe passerait en clair sur le reseau) ;
 *  - identifiants refuses (`DahuaAuthError`) : plus AUCUNE requete pendant 5 minutes, flux d'evenements compris (la barriere
 *    `AuthGate` est partagee) : un compte Dahua se bloque apres quelques echecs ;
 *  - les messages d'erreur ne contiennent jamais le mot de passe ni l'adresse du controleur.
 */
import { request } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { DahuaAuthError, authorization } from '../../../../server/dahua.ts';

export { DahuaAuthError };

/** Attente apres un refus d'identifiants. */
export const AUTH_BLOCK_MS = 300_000;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;

export type HttpErrorCode = 'unreachable' | 'timeout' | 'http' | 'too_large' | 'stopped';

/** Echec reseau ou HTTP (pas un refus d'identifiants : voir `DahuaAuthError`). */
export class DahuaHttpError extends Error {
  readonly code: HttpErrorCode;
  readonly status: number | null;
  constructor(code: HttpErrorCode, message: string, status: number | null = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Barriere commune au flux d'evenements et aux requetes d'un controleur : apres un refus d'identifiants, personne ne
 * se reconnecte avant `AUTH_BLOCK_MS`.
 */
export class AuthGate {
  private until = 0;
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  block(): void {
    this.until = this.now() + AUTH_BLOCK_MS;
  }
  /** Millisecondes restantes avant le prochain essai permis (0 = permis). */
  remainingMs(): number {
    const t = this.now();
    // Horloge revenue en arriere : l'attente ne peut pas depasser la duree prevue.
    if (this.until - t > AUTH_BLOCK_MS) this.until = t + AUTH_BLOCK_MS;
    return Math.max(0, this.until - t);
  }
  blocked(): boolean {
    return this.remainingMs() > 0;
  }
  clear(): void {
    this.until = 0;
  }
}

export interface HttpResult {
  status: number;
  body: string;
}

export interface HttpTarget {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface DahuaHttpOptions {
  timeoutMs?: number;
  maxBytes?: number;
  gate: AuthGate;
}

/** Message en clair pour une erreur reseau, sans adresse ni identifiant. */
function explain(err: unknown): { code: HttpErrorCode; text: string } {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return { code: 'timeout', text: "pas de reponse du controleur" };
  if (code === 'ECONNREFUSED') return { code: 'unreachable', text: 'connexion refusee (port HTTP du controleur ferme ?)' };
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return { code: 'unreachable', text: 'controleur injoignable (reseau ?)' };
  if (code === 'ECONNRESET') return { code: 'unreachable', text: 'connexion coupee par le controleur' };
  return { code: 'unreachable', text: 'erreur reseau' };
}

export class DahuaHttp {
  private readonly target: HttpTarget;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly gate: AuthGate;
  private readonly active = new Set<ClientRequest>();
  private stopped = false;

  constructor(target: HttpTarget, opts: DahuaHttpOptions) {
    this.target = target;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
    this.gate = opts.gate;
  }

  /** Annule tout ce qui est en cours ; les appels suivants echouent tout de suite. */
  stop(): void {
    this.stopped = true;
    for (const req of [...this.active]) req.destroy(Object.assign(new Error('stopped'), { code: 'STOPPED' }));
    this.active.clear();
  }

  /** Un echange HTTP (sans reprise d'authentification). */
  private exchange(path: string, auth: string | null): Promise<{ status: number; challenges: string[]; body: string }> {
    return new Promise((resolve, reject) => {
      if (this.stopped) return reject(new DahuaHttpError('stopped', 'module arrete'));
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active.delete(req);
        fn();
      };
      const req = request({ host: this.target.host, port: this.target.port, path, method: 'GET', headers: auth ? { Authorization: auth } : {} });
      this.active.add(req);
      const timer = setTimeout(() => {
        done(() => reject(new DahuaHttpError('timeout', 'pas de reponse du controleur')));
        req.destroy();
      }, this.timeoutMs);
      timer.unref?.();
      req.on('error', (err) => {
        if ((err as { code?: string }).code === 'STOPPED') return done(() => reject(new DahuaHttpError('stopped', 'module arrete')));
        const e = explain(err);
        done(() => reject(new DahuaHttpError(e.code, e.text)));
      });
      req.on('response', (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const challenges = res.headersDistinct['www-authenticate'] ?? [];
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > this.maxBytes) {
            done(() => reject(new DahuaHttpError('too_large', 'reponse du controleur trop grande')));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => done(() => resolve({ status, challenges, body: Buffer.concat(chunks).toString('utf8') })));
        res.on('error', () => done(() => reject(new DahuaHttpError('unreachable', 'connexion coupee par le controleur'))));
        res.on('aborted', () => done(() => reject(new DahuaHttpError('unreachable', 'connexion coupee par le controleur'))));
      });
      req.end();
    });
  }

  /**
   * GET authentifie. Rend le code HTTP et le corps (un code autre que 200 n'est PAS une exception : l'appelant decide).
   * Leve `DahuaAuthError` (identifiants refuses : la barriere est fermee 5 minutes) ou `DahuaHttpError`.
   */
  async get(path: string): Promise<HttpResult> {
    if (this.stopped) throw new DahuaHttpError('stopped', 'module arrete');
    if (this.gate.blocked()) throw new DahuaAuthError(`identifiants refuses : prochain essai dans ${Math.ceil(this.gate.remainingMs() / 60_000)} min`);
    const first = await this.exchange(path, null);
    if (first.status !== 401) return { status: first.status, body: first.body };
    if (first.challenges.length === 0) {
      this.gate.block();
      throw new DahuaAuthError("le controleur refuse l'acces sans proposer d'authentification");
    }
    let header: string;
    try {
      header = authorization(first.challenges, this.target.username, this.target.password, path);
    } catch (err) {
      this.gate.block();
      throw err instanceof DahuaAuthError ? err : new DahuaAuthError('authentification impossible');
    }
    const second = await this.exchange(path, header);
    if (second.status === 401) {
      this.gate.block();
      throw new DahuaAuthError("identifiants refuses par le controleur");
    }
    return { status: second.status, body: second.body };
  }
}
