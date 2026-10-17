import express from 'express';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { checkCredentials, destroyUserSessions, isRateLimited, recordFailure } from './auth.ts';
import { PsimError } from './errors.ts';
import type {
  GroupInput,
  HolderFilters,
  HolderInput,
  HoldersService,
  ImportReport,
  ScheduleInput,
  SyncService,
  SyncState,
  VisitorInput,
} from './accessholderstypes.ts';

/**
 * Routes `/api/access/*` des titulaires, groupes, plages, jours feries, visiteurs, import CSV et synchronisation
 * (contrat : docs/ACCES.md § 10.3). Aucune regle metier ici : les services valident TOUT (corps, filtres) et levent des
 * `PsimError` que le gestionnaire d'erreurs d'`api.ts` traduit en `{"error": ...}`. Ce module ne fait que : garde de role,
 * lecture du corps (JSON borne, image ou CSV bruts), identifiants d'URL, re-authentification, codes HTTP et en-tetes.
 *
 * Roles : consulter, creer un visiteur et mettre fin a sa visite = tout utilisateur connecte ; le reste = administrateur.
 * Emission de cle de synchronisation et confirmation de suppressions en masse : mot de passe du compte (champ `reauth` du
 * corps, retire avant d'aller plus loin : jamais journalise, jamais transmis au service).
 */

export type AuditFn = (actor: string, action: string, ref?: { incidentId?: number; deviceId?: string; details?: string }) => void;

export interface HoldersApiDeps {
  holders: HoldersService;
  sync: SyncService;
  /** Import CSV : `dryRun` = verifie sans rien ecrire. */
  runImport: (bytes: Buffer, actor: string, dryRun: boolean) => ImportReport;
  db: DatabaseSync;
  audit: AuditFn;
}

export interface HoldersApiGuards {
  anyUser: RequestHandler;
  adminOnly: RequestHandler;
  actorOf: (req: Request) => string;
  /** Re-authentification fournie par l'application (branche acces-ac0) ; absente : equivalent local identique. */
  reauth?: (what: string) => RequestHandler;
}

export interface HoldersApi {
  /** Monte les routes. A appeler AVANT la route « /api » de repli (404) d'api.ts. */
  mount(app: Express, guards: HoldersApiGuards): void;
}

/** Identifiant de controleur : meme motif que le service d'acces. */
const CONTROLLER_ID = /^[A-Za-z0-9_-]{1,32}$/;
/** Identifiant numerique d'URL : entier positif de 10 chiffres au plus, sans zero de tete. */
const NUMERIC_ID = /^[1-9][0-9]{0,9}$/;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Gravite d'un etat de synchronisation : le pire l'emporte. */
const SEVERITY: Record<SyncState, number> = { synced: 0, pending: 1, failed: 2, blocked: 3 };

/**
 * Re-authentification locale, STRICTEMENT celle de `reauth.ts` (branche acces-ac0) : 428 si le mot de passe manque, 429 au-dela
 * de 5 echecs par minute (compteur de la connexion `user:<compte>`), 403 s'il est faux, sessions du compte fermees au 5e echec.
 */
export function reauthenticate(db: DatabaseSync, username: string, password: unknown, audit: AuditFn, what: string): void {
  if (typeof password !== 'string' || !password) throw new PsimError(428, 'Mot de passe de votre compte requis pour cette operation');
  const key = `user:${username.trim().toLowerCase()}`;
  if (isRateLimited(key)) throw new PsimError(429, 'Trop de mots de passe faux, reessayer dans une minute');
  if (password.length > 200 || checkCredentials(db, username, password) === null) {
    recordFailure(key);
    audit(username, 'reauth_echec', { details: `${what} refuse : mot de passe incorrect` });
    if (isRateLimited(key)) {
      const closed = destroyUserSessions(username);
      audit('systeme', 'reauth_session_fermee', { details: `compte ${username} : trop de mots de passe faux a la re-authentification, ${closed} session(s) fermee(s)` });
    }
    throw new PsimError(403, 'Mot de passe incorrect');
  }
}

/** Identifiant numerique d'URL, ou 404 sans interroger le service. */
function numId(req: Request, what: string): number {
  const raw = req.params.id;
  if (typeof raw !== 'string' || !NUMERIC_ID.test(raw)) throw new PsimError(404, `${what} introuvable`);
  return Number(raw);
}

function controllerId(req: Request): string {
  const raw = req.params.id;
  if (typeof raw !== 'string' || !CONTROLLER_ID.test(raw)) throw new PsimError(404, 'Controleur introuvable');
  return raw;
}

/** Corps JSON : un objet. Le reste (tableau, chaine, nombre) est refuse ici ; le contenu est valide par le service. */
function objectBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body ?? {};
  if (typeof body !== 'object' || body === null || Array.isArray(body) || Buffer.isBuffer(body)) {
    throw new PsimError(400, 'Le corps de la requete doit etre un objet JSON');
  }
  return body as Record<string, unknown>;
}

const noStore = (res: Response): void => void res.setHeader('Cache-Control', 'no-store');

export function createHoldersApi(deps: HoldersApiDeps): HoldersApi {
  const { holders, sync, runImport, db, audit } = deps;

  function mount(app: Express, guards: HoldersApiGuards): void {
    // Noms lus tels quels par l'auto-test des routes (test/e2e-attack.test.ts) : chaque route porte `anyUser` ou `adminOnly`.
    const { anyUser, adminOnly, actorOf } = guards;
    const json = express.json({ limit: '10kb' });
    const jsonGroups = express.json({ limit: '64kb' });
    const jsonHolidays = express.json({ limit: '60kb' });
    const rawPhoto = express.raw({ type: PHOTO_TYPES, limit: '64kb' });
    const rawCsv = express.raw({ type: () => true, limit: '1mb' });

    /** Mot de passe du compte connecte (a placer APRES le corps JSON) ; le champ est retire du corps dans tous les cas. */
    const reauth = (what: string): RequestHandler => {
      const strip = (req: Request): void => {
        if (req.body && typeof req.body === 'object') delete (req.body as Record<string, unknown>).reauth;
      };
      if (guards.reauth) {
        const external = guards.reauth(what);
        return (req: Request, res: Response, next: NextFunction) =>
          external(req, res, (err?: unknown) => {
            strip(req);
            next(err);
          });
      }
      return (req: Request, _res: Response, next: NextFunction) => {
        try {
          reauthenticate(db, actorOf(req), (req.body as { reauth?: unknown } | undefined)?.reauth, audit, what);
        } catch (err) {
          strip(req);
          return next(err);
        }
        strip(req);
        next();
      };
    };

    // ---- Titulaires ----
    app.get('/api/access/holders', anyUser, (req, res) => {
      const list = holders.list(req.query as HolderFilters, actorOf(req));
      // Un appel par titulaire de la page (100 au plus) : borne.
      const items = list.items.map((h) => {
        let worst: SyncState | null = null;
        for (const s of sync.holderStatus(h.ref)) if (worst === null || SEVERITY[s.state] > SEVERITY[worst]) worst = s.state;
        return { ...h, syncState: worst ?? 'none' };
      });
      noStore(res);
      res.json({ ...list, items });
    });
    app.get('/api/access/holders/:id', anyUser, (req, res) => {
      const detail = holders.get(numId(req, 'Titulaire'));
      noStore(res);
      res.json({ ...detail, sync: sync.holderStatus(detail.ref) });
    });
    app.post('/api/access/holders', adminOnly, json, (req, res) => {
      noStore(res);
      res.status(201).json(holders.create(actorOf(req), objectBody(req) as HolderInput));
    });
    app.put('/api/access/holders/:id', adminOnly, json, (req, res) => {
      const id = numId(req, 'Titulaire');
      noStore(res);
      res.json(holders.update(actorOf(req), id, objectBody(req) as HolderInput));
    });
    app.delete('/api/access/holders/:id', adminOnly, (req, res) => {
      holders.remove(actorOf(req), numId(req, 'Titulaire'));
      res.status(204).end();
    });

    // ---- Photo : jamais mise en cache, servie comme une image inerte ----
    app.get('/api/access/holders/:id/photo', anyUser, (req, res) => {
      const photo = holders.photo(numId(req, 'Titulaire'));
      if (!photo) throw new PsimError(404, 'Aucune photo pour ce titulaire');
      noStore(res);
      res.setHeader('Content-Type', photo.mime);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline; filename="photo"');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.send(photo.data);
    });
    app.put('/api/access/holders/:id/photo', adminOnly, rawPhoto, (req, res) => {
      const id = numId(req, 'Titulaire');
      const mime = req.is(PHOTO_TYPES);
      if (!mime) throw new PsimError(415, 'Format de photo non accepte : JPEG, PNG ou WebP');
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new PsimError(400, 'Envoyez la photo telle quelle (corps vide)');
      holders.setPhoto(actorOf(req), id, mime, req.body);
      res.status(204).end();
    });
    app.delete('/api/access/holders/:id/photo', adminOnly, (req, res) => {
      holders.clearPhoto(actorOf(req), numId(req, 'Titulaire'));
      res.status(204).end();
    });

    // ---- Badges ----
    app.post('/api/access/holders/:id/badges', adminOnly, json, (req, res) => {
      const id = numId(req, 'Titulaire');
      res.status(201).json(holders.addBadge(actorOf(req), id, objectBody(req).number));
    });
    app.patch('/api/access/badges/:id', adminOnly, json, (req, res) => {
      const id = numId(req, 'Badge');
      res.json(holders.setBadgeState(actorOf(req), id, objectBody(req).state));
    });
    app.delete('/api/access/badges/:id', adminOnly, (req, res) => {
      holders.removeBadge(actorOf(req), numId(req, 'Badge'));
      res.status(204).end();
    });

    // ---- Groupes ----
    app.get('/api/access/groups', anyUser, (_req, res) => {
      res.json(holders.groups());
    });
    app.get('/api/access/groups/:id', anyUser, (req, res) => {
      res.json(holders.group(numId(req, 'Groupe')));
    });
    app.post('/api/access/groups', adminOnly, jsonGroups, (req, res) => {
      res.status(201).json(holders.createGroup(actorOf(req), objectBody(req) as GroupInput));
    });
    app.put('/api/access/groups/:id', adminOnly, jsonGroups, (req, res) => {
      const id = numId(req, 'Groupe');
      res.json(holders.updateGroup(actorOf(req), id, objectBody(req) as GroupInput));
    });
    app.delete('/api/access/groups/:id', adminOnly, (req, res) => {
      holders.deleteGroup(actorOf(req), numId(req, 'Groupe'));
      res.status(204).end();
    });

    // ---- Plages horaires ----
    app.get('/api/access/schedules', anyUser, (_req, res) => {
      res.json(holders.schedules());
    });
    app.get('/api/access/schedules/:id', anyUser, (req, res) => {
      res.json(holders.schedule(numId(req, 'Plage horaire')));
    });
    app.post('/api/access/schedules', adminOnly, json, (req, res) => {
      res.status(201).json(holders.createSchedule(actorOf(req), objectBody(req) as ScheduleInput));
    });
    app.put('/api/access/schedules/:id', adminOnly, json, (req, res) => {
      const id = numId(req, 'Plage horaire');
      res.json(holders.updateSchedule(actorOf(req), id, objectBody(req) as ScheduleInput));
    });
    app.delete('/api/access/schedules/:id', adminOnly, (req, res) => {
      holders.deleteSchedule(actorOf(req), numId(req, 'Plage horaire'));
      res.status(204).end();
    });

    // ---- Jours feries (la liste est remplacee en entier) ----
    app.get('/api/access/holidays', anyUser, (_req, res) => {
      res.json(holders.holidays());
    });
    app.put('/api/access/holidays', adminOnly, jsonHolidays, (req, res) => {
      res.json(holders.setHolidays(actorOf(req), objectBody(req).entries));
    });

    // ---- Visiteurs (poste de garde : l'operateur peut en creer et y mettre fin) ----
    app.get('/api/access/visitors', anyUser, (req, res) => {
      const scope = req.query.scope;
      if (scope !== undefined && scope !== 'current' && scope !== 'recent') throw new PsimError(400, 'scope : current ou recent');
      noStore(res);
      res.json(holders.visitors(scope === 'recent' ? 'recent' : 'current'));
    });
    app.post('/api/access/visitors', anyUser, json, (req, res) => {
      noStore(res);
      res.status(201).json(holders.createVisitor(actorOf(req), objectBody(req) as VisitorInput));
    });
    app.post('/api/access/visitors/:id/end', anyUser, (req, res) => {
      const id = numId(req, 'Visiteur');
      noStore(res);
      res.json(holders.endVisitor(actorOf(req), id));
    });

    // ---- Import CSV : le fichier arrive tel quel (corps brut, 1 Mo au plus) ----
    app.post('/api/access/import', adminOnly, rawCsv, (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new PsimError(400, 'Envoyez le fichier CSV tel quel');
      const flag = req.query.dryRun;
      const dryRun = flag === '1' || flag === 'true';
      noStore(res);
      res.json(runImport(req.body, actorOf(req), dryRun));
    });

    // ---- Synchronisation avec les controleurs ----
    app.get('/api/access/sync', anyUser, (_req, res) => {
      res.json(sync.status());
    });
    app.get('/api/access/sync/controllers/:id', anyUser, (req, res) => {
      res.json(sync.controller(controllerId(req)));
    });
    // La cle n'est montree qu'ici, une seule fois : jamais dans le cache, jamais dans le journal.
    app.post('/api/access/sync/controllers/:id/key', adminOnly, json, reauth('emission de cle de synchronisation'), (req, res) => {
      const id = controllerId(req);
      noStore(res);
      res.json(sync.issueKey(actorOf(req), id));
    });
    app.post('/api/access/sync/controllers/:id/confirm-deletions', adminOnly, json, reauth('confirmation de suppressions en masse'), (req, res) => {
      const id = controllerId(req);
      res.json(sync.confirmDeletions(actorOf(req), id));
    });
    app.post('/api/access/sync/controllers/:id/retry', adminOnly, (req, res) => {
      res.json(sync.retry(actorOf(req), controllerId(req)));
    });
  }

  return { mount };
}
