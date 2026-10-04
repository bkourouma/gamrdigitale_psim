import { createReadStream } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  checkCredentials,
  createSession,
  destroySession,
  getSession,
  isKnownLoginIp,
  isRateLimited,
  parseCookies,
  rememberLoginIp,
  recordFailure,
  setSessionValidator,
} from './auth.ts';
import type { Session } from './auth.ts';
import type { Arming } from './arming.ts';
import { maskAudit, maskSnapshot } from './visibility.ts';
import type { JournalGuard } from './journal.ts';
import type { ReportMail } from './reportmail.ts';
import { parseRange } from './reports.ts';
import type { Reports } from './reports.ts';
import type { Engine } from './engine.ts';
import { PsimError } from './engine.ts';
import { PLAN_TYPES } from './floors.ts';
import type { Floors } from './floors.ts';
import { createHash, timingSafeEqual } from 'node:crypto';
import { discoverOnvif } from './onvif.ts';
import type { Notifier } from './notifications.ts';
import type { RecipientsService } from './recipients.ts';
import type { UsersService } from './users.ts';
import type { RiskService } from './risk.ts';
import type { SnapshotService } from './snapshots.ts';
import type { VideoService } from './video.ts';
import type { Role } from './types.ts';

export const SESSION_COOKIE = 'psim_session';

const MAX_PLAN_BYTES = 10 * 1024 * 1024;

export interface ApiDeps {
  db: DatabaseSync;
  engine: Engine;
  floors: Floors;
  video: VideoService;
  snapshots: SnapshotService;
  notifier: Notifier;
  risk: RiskService;
  users: UsersService;
  recipients: RecipientsService;
  arming: Arming;
  reports: Reports;
  journal: JournalGuard;
  reportMail: ReportMail;
  /** HTTPS integre : active HSTS. */
  tls: boolean;
  trustProxy: boolean;
  health: () => { ok: boolean; reason?: string };
  system: () => unknown;
  /** Lance une sauvegarde immediate (administrateur) et renvoie son resultat. */
  backupNow: () => unknown;
  dataDir: string;
  webDir: string;
  cookieSecure: boolean;
  simEnabled: boolean;
  /** Comptes proposes sur la page de connexion (mode demo), ou null. */
  demoAccounts: { username: string; label: string; password: string }[] | null;
  triggerSim: (detectorId: string, payload: Record<string, unknown>) => Promise<void>;
  /** Jeton de l'entree HTTP des equipements ; vide = entree desactivee. */
  ingestToken?: string;
}

type AuthedRequest = Request & { session: Session };

export function sessionFromRequest(req: Pick<Request, 'headers'>): Session | null {
  return getSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

export function createApp(deps: ApiDeps) {
  const { db, engine, users } = deps;
  // Controle a CHAQUE requete : compte supprime / desactive / identifiants changes = plus de session ; le role vient de la base.
  setSessionValidator(users.validateSession);
  const app = express();
  app.disable('x-powered-by');
  if (deps.trustProxy) app.set('trust proxy', 1); // adresse reelle du client derriere un proxy (limitation des connexions)

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (deps.tls) res.setHeader('Strict-Transport-Security', 'max-age=31536000'); // le navigateur n'ira plus jamais en HTTP
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    // Les reponses d'API (etat, journal, exports) ne doivent jamais rester dans un cache partage ou du navigateur.
    if (_req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Sante : sans authentification (pour un surveillant externe), volontairement minimale.
  app.get('/healthz', (_req, res) => {
    const h = deps.health();
    res.status(h.ok ? 200 : 503).setHeader('Cache-Control', 'no-store').json(h.ok ? { status: 'ok' } : { status: 'degraded', reason: h.reason });
  });

  // Anti-CSRF : SameSite=Strict protege du cross-SITE, pas d'un site « frere » ni d'une autre appli de la meme machine.
  // Toute requete qui modifie quelque chose doit venir de CETTE origine (navigateur) ou ne pas en annoncer (outil, script).
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (req.path.startsWith('/api/ingest/')) return next(); // equipements : jeton, jamais un navigateur
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return void res.status(403).json({ error: 'Requete inter-sites refusee' });
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      const allowed = new Set([String(req.headers.host ?? '')]);
      if (deps.trustProxy && typeof req.headers['x-forwarded-host'] === 'string') allowed.add(req.headers['x-forwarded-host'].split(',')[0].trim());
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch {
        // « null » (iframe isolee, page data:) : refuse
      }
      if (!originHost || !allowed.has(originHost)) return void res.status(403).json({ error: 'Origine refusee' });
    }
    next();
  });

  app.use(express.static(deps.webDir, { index: 'index.html' }));
  const json = express.json({ limit: '10kb' });

  // ---- Authentification ---------------------------------------------------------------

  // Mode demo : uniquement depuis cette machine, jamais si le mode est desactive.
  app.get('/api/demo-accounts', (req, res) => {
    const remote = req.socket.remoteAddress ?? '';
    const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    // Pas derriere un proxy (tout le monde y arriverait de 127.0.0.1), et seulement sous un nom de machine local (DNS rebinding).
    const direct = !deps.trustProxy && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'] && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(req.headers.host ?? ''));
    if (!deps.demoAccounts || !local || !direct) return void res.status(404).json({ error: 'Non disponible' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(deps.demoAccounts);
  });

  const sessionCookie = (token: string) =>
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${deps.cookieSecure ? '; Secure' : ''}`;

  /** Ouvre la session (restreinte si une etape est requise : changer son mot de passe, activer la 2FA). */
  const TWOFA_WINDOW_MS = 10 * 60_000;
  // Un verrouillage n'est inscrit au journal qu'une fois par minute et par cle : l'attaquant ne remplit pas le journal.
  const lastLockAudit = new Map<string, number>();
  const accountKnown = (name: string): boolean => Boolean(name) && Boolean(db.prepare('SELECT 1 AS x FROM app_user WHERE username = ?').get(name));
  function auditLockout(key: string, who: string, ip: string): void {
    const t = Date.now();
    if (t - (lastLockAudit.get(key) ?? 0) < 60_000) return;
    lastLockAudit.set(key, t);
    if (lastLockAudit.size > 1000) lastLockAudit.clear();
    engine.audit('systeme', 'login_locked', { details: `compte ${accountKnown(who) ? who : '?'}, adresse ${ip.slice(0, 64)}` });
  }

  function finishLogin(res: Response, username: string, ip?: string): void {
    if (ip) rememberLoginIp(username, ip);
    const opened = users.openSession(username);
    res.setHeader('Set-Cookie', sessionCookie(createSession(username, opened.role, opened.epoch, opened.restricted)));
    engine.audit(username, 'login');
    res.json({ username, role: opened.role, restricted: opened.restricted });
  }

  app.post('/api/login', json, (req, res) => {
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const name = typeof username === 'string' ? username.trim().toLowerCase().slice(0, 64) : '';
    // Deux limites : par adresse (un attaquant essaie plusieurs comptes) et par compte (plusieurs adresses visent un compte).
    const ip = req.ip ?? 'unknown';
    const ipKey = `ip:${ip}`;
    const userKey = `user:${name}`;
    // Le verrou PAR COMPTE ne s'applique pas a une adresse qui s'est deja connectee avec succes : sinon n'importe qui
    // interdirait l'acces de l'administrateur avec cinq mauvais mots de passe par minute.
    const accountLocked = isRateLimited(userKey) && !isKnownLoginIp(name, ip);
    if (isRateLimited(ipKey) || accountLocked) {
      auditLockout(accountLocked ? userKey : ipKey, name || '?', ip);
      return void res.status(429).json({ error: 'Trop de tentatives, reessayer dans une minute' });
    }
    const role = name && typeof password === 'string' ? checkCredentials(db, name, password) : null;
    if (!role) {
      recordFailure(ipKey);
      recordFailure(userKey);
      // Seul un compte EXISTANT est nomme au journal : un visiteur qui tape son mot de passe dans le champ identifiant ne l'y inscrit pas.
      engine.audit(accountKnown(name) ? name : '?', 'login_failed');
      return void res.status(401).json({ error: 'Identifiants incorrects' });
    }
    if (users.totpEnabled(name)) {
      // Mot de passe correct mais pas de session : il faut encore le code de l'application d'authentification.
      return void res.json({ twoFactor: true, challenge: users.createChallenge(name) });
    }
    finishLogin(res, name, ip);
  });

  app.post('/api/login/2fa', json, (req, res) => {
    const { challenge, code } = (req.body ?? {}) as { challenge?: unknown; code?: unknown };
    const ipKey = `ip2fa:${req.ip ?? 'unknown'}`;
    // Limite PAR COMPTE (10 echecs en 10 minutes), en plus de celle par adresse : un attaquant qui possede le mot de
    // passe et change d'adresse (IPv6, plusieurs machines) ne peut pas deviner le code a la chaine.
    const owner = typeof challenge === 'string' ? users.challengeOwner(challenge) : null;
    const acctKey = owner ? `acct2fa:${owner}` : null;
    if (isRateLimited(ipKey) || (acctKey && isRateLimited(acctKey, Date.now(), 10, TWOFA_WINDOW_MS))) {
      auditLockout(acctKey ?? ipKey, owner ?? '?', req.ip ?? 'unknown');
      return void res.status(429).json({ error: 'Trop de tentatives, reessayer dans quelques minutes' });
    }
    const answer = typeof challenge === 'string' ? users.answerChallengeDetailed(challenge, code) : ({ error: 'expired', attemptsLeft: 0 } as const);
    if (!('username' in answer)) {
      recordFailure(ipKey);
      if (acctKey) recordFailure(acctKey, Date.now(), TWOFA_WINDOW_MS);
      if (owner) engine.audit(owner, 'login_2fa_failed', { details: `adresse ${req.ip ?? '?'}` });
      return void res.status(401).json(
        answer.error === 'wrong'
          ? { error: `Code incorrect (${answer.attemptsLeft} essai${answer.attemptsLeft > 1 ? 's' : ''} restant${answer.attemptsLeft > 1 ? 's' : ''})`, expired: false }
          : { error: 'Délai dépassé ou trop d\'essais : recommencez la connexion', expired: true },
      );
    }
    finishLogin(res, answer.username, req.ip);
  });

  app.post('/api/logout', (req, res) => {
    const who = sessionFromRequest(req)?.username;
    destroySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    // Journalise (et, par ricochet, ferme la connexion temps reel de cette session : elle est revalidee a chaque evenement).
    if (who) engine.audit(who, 'logout');
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  // Une session « restreinte » (mot de passe a changer, 2FA a activer) ne peut faire QUE cela.
  const ALLOWED_WHEN_RESTRICTED = new Set(['GET /api/me', 'POST /api/me/password', 'POST /api/me/2fa/setup', 'POST /api/me/2fa/enable']);

  function requireRole(...roles: Role[]) {
    return (req: Request, res: Response, next: NextFunction) => {
      const session = sessionFromRequest(req);
      if (!session) return void res.status(401).json({ error: 'Non authentifie' });
      if (session.restricted && !ALLOWED_WHEN_RESTRICTED.has(`${req.method} ${req.path}`)) {
        return void res.status(403).json({ error: 'Une etape est requise sur votre compte avant de continuer', restricted: session.restricted });
      }
      if (roles.length > 0 && !roles.includes(session.role)) return void res.status(403).json({ error: 'Droits insuffisants' });
      (req as AuthedRequest).session = session;
      next();
    };
  }
  const anyUser = requireRole();
  const adminOnly = requireRole('admin');
  const actorOf = (req: Request) => (req as AuthedRequest).session.username;

  app.get('/api/me', anyUser, (req, res) => {
    const { username, role, restricted } = (req as AuthedRequest).session;
    const me = users.get(username);
    res.json({
      username,
      role,
      simEnabled: deps.simEnabled,
      restricted,
      displayName: me.displayName,
      totpEnabled: me.totpEnabled,
      recoveryLeft: me.totpEnabled ? users.recoveryLeft(username) : 0,
    });
  });

  // ---- Mon compte : mot de passe et double authentification ------------------------------------

  app.post('/api/me/password', anyUser, json, (req, res) => {
    const { current, next: nextPassword } = (req.body ?? {}) as { current?: unknown; next?: unknown };
    const username = actorOf(req);
    const key = `pw:${username}`;
    if (isRateLimited(key)) throw new PsimError(429, 'Trop de tentatives, reessayer dans une minute');
    try {
      users.changeOwnPassword(username, current, nextPassword);
    } catch (err) {
      if (err instanceof PsimError && err.status === 403) recordFailure(key);
      throw err;
    }
    // Les autres sessions du compte sont fermees ; celle-ci est renouvelee.
    const opened = users.openSession(username);
    res.setHeader('Set-Cookie', sessionCookie(createSession(username, opened.role, opened.epoch, opened.restricted)));
    res.json({ ok: true, restricted: opened.restricted });
  });

  app.post('/api/me/2fa/setup', anyUser, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await users.beginTotp(actorOf(req)));
  });
  app.post('/api/me/2fa/enable', anyUser, json, (req, res) => {
    const username = actorOf(req);
    const key = `2fa-enable:${username}`;
    if (isRateLimited(key)) throw new PsimError(429, 'Trop de tentatives, reessayer dans une minute');
    try {
      const recoveryCodes = users.enableTotp(username, (req.body as { code?: unknown } | undefined)?.code);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ recoveryCodes });
    } catch (err) {
      recordFailure(key);
      throw err;
    }
  });
  app.post('/api/me/2fa/disable', anyUser, json, (req, res) => {
    users.disableTotp(actorOf(req), (req.body as { password?: unknown } | undefined)?.password);
    res.json({ ok: true });
  });
  app.post('/api/me/2fa/recovery', anyUser, json, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ recoveryCodes: users.regenerateRecovery(actorOf(req), (req.body as { password?: unknown } | undefined)?.password) });
  });

  // ---- Comptes (administrateur) --------------------------------------------------------------------

  app.get('/api/users', adminOnly, (_req, res) => {
    res.json(users.list().map((u) => ({ ...u, recoveryLeft: u.totpEnabled ? users.recoveryLeft(u.username) : 0 })));
  });
  app.post('/api/users', adminOnly, json, (req, res) => {
    res.status(201).json(users.create(actorOf(req), (req.body ?? {}) as Record<string, unknown>));
  });
  app.patch('/api/users/:username', adminOnly, json, (req, res) => {
    res.json(users.update(actorOf(req), String(req.params.username), (req.body ?? {}) as Record<string, unknown>));
  });
  app.post('/api/users/:username/reset-password', adminOnly, json, (req, res) => {
    res.json(users.resetPassword(actorOf(req), String(req.params.username), (req.body as { password?: unknown } | undefined)?.password));
  });
  app.post('/api/users/:username/reset-2fa', adminOnly, (req, res) => {
    res.json(users.adminResetTotp(actorOf(req), String(req.params.username)));
  });
  app.delete('/api/users/:username', adminOnly, (req, res) => {
    users.remove(actorOf(req), String(req.params.username));
    res.status(204).end();
  });

  // ---- Destinataires de notification (administrateur) --------------------------------------------

  app.get('/api/notifications/recipients', adminOnly, (_req, res) => {
    res.json({ recipients: deps.recipients.list(), available: deps.recipients.available });
  });
  app.post('/api/notifications/recipients', adminOnly, json, (req, res) => {
    res.status(201).json(deps.recipients.add(actorOf(req), (req.body ?? {}) as Record<string, unknown>));
  });
  app.patch('/api/notifications/recipients/:id', adminOnly, json, (req, res) => {
    res.json(deps.recipients.update(actorOf(req), Number(req.params.id), (req.body ?? {}) as Record<string, unknown>));
  });
  app.delete('/api/notifications/recipients/:id', adminOnly, (req, res) => {
    deps.recipients.remove(actorOf(req), Number(req.params.id));
    res.status(204).end();
  });

  // ---- Lecture --------------------------------------------------------------------------

  app.get('/api/state', anyUser, (req, res) => res.json(maskSnapshot(engine.getSnapshot(), (req as AuthedRequest).session.role)));
  // Image de camera prise au moment d'un incident. Authentification obligatoire ; jamais de chemin
  // fourni par le client (seul l'identifiant numerique est lu).
  app.get('/api/snapshots/:id', anyUser, (req, res) => {
    const id = Number(req.params.id);
    const image = Number.isInteger(id) && id > 0 ? deps.snapshots.read(id) : null;
    if (!image) throw new PsimError(404, 'Image introuvable');
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    res.end(image);
  });

  // Notifications (administrateur) : etat des canaux + message de test pour verifier la configuration.
  app.get('/api/notifications/status', adminOnly, (_req, res) => res.json(deps.notifier.status()));
  app.post('/api/notifications/test', adminOnly, async (req, res) => {
    engine.audit(actorOf(req), 'notification_test');
    res.json(await deps.notifier.test());
  });

  // Gestion des risques : lecture pour tout utilisateur connecte, evaluation reservee a l'administrateur.
  app.get('/api/risk', anyUser, (_req, res) => res.json(deps.risk.overview()));
  app.put('/api/risk/zones/:zone', adminOnly, json, (req, res) => {
    res.json(deps.risk.assess(actorOf(req), String(req.params.zone), (req.body ?? {}) as Record<string, unknown>));
  });

  // Etat du PSIM lui-meme (administrateur) : sante, disque, sauvegardes, avertissements.
  app.get('/api/system', adminOnly, (_req, res) => res.json(deps.system()));
  app.post('/api/system/backup', adminOnly, (req, res) => {
    engine.audit(actorOf(req), 'backup_manual');
    res.json(deps.backupNow());
  });

  // Integrite du journal : verification complete a la demande (chaine d'empreintes et ancres memorisees).
  app.post('/api/system/journal/verify', adminOnly, (req, res) => {
    const result = deps.journal.check();
    engine.audit(actorOf(req), 'journal_verified', { details: result.ok ? `integre (${result.checked} entrees)` : `ALTERE (${result.problems.length} probleme(s))` });
    res.json(result);
  });
  app.get('/api/audit', anyUser, (req, res) => res.json(engine.listAudit(Number(req.query.limit ?? 100)).map((e) => maskAudit(e, (req as AuthedRequest).session.role))));

  // ---- Traitement des incidents ----------------------------------------------------------

  const incidentId = (req: Request): number => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new PsimError(400, 'Identifiant invalide');
    return id;
  };

  app.post('/api/incidents/:id/ack', anyUser, (req, res) => {
    res.json(engine.acknowledge(incidentId(req), actorOf(req)));
  });

  app.post('/api/incidents/:id/close', anyUser, json, (req, res) => {
    const { qualification, comment } = (req.body ?? {}) as Record<string, unknown>;
    res.json(engine.close(incidentId(req), actorOf(req), qualification, comment));
  });

  // ---- Etages et plans --------------------------------------------------------------------

  const sendPlan = (floorId: unknown, res: Response) => {
    const plan = deps.floors.planPath(floorId);
    if (!plan) return void res.status(404).json({ error: 'Aucun plan pour cet etage' });
    res.setHeader('Content-Type', plan.mime);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    // Un SVG televerse ne doit jamais pouvoir executer de script s'il est ouvert directement.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    const stream = createReadStream(plan.path);
    // Plan supprime entre la verification et l'ouverture (remplacement en cours) : jamais d'exception non geree.
    stream.on('error', () => (res.headersSent ? res.destroy() : res.status(404).json({ error: 'Aucun plan pour cet etage' })));
    stream.pipe(res);
  };
  const rawPlan = express.raw({ type: Object.keys(PLAN_TYPES), limit: MAX_PLAN_BYTES });
  const planMime = (req: Request) => (req.headers['content-type'] ?? '').split(';')[0].trim();

  app.get('/api/floors/:id/plan', anyUser, (req, res) => sendPlan(req.params.id, res));
  app.put('/api/floors/:id/plan', adminOnly, rawPlan, (req, res) => {
    res.json({ ok: true, ...deps.floors.setPlan(actorOf(req), req.params.id, planMime(req), req.body) });
  });
  app.post('/api/floors', adminOnly, json, (req, res) => {
    res.status(201).json(deps.floors.create(actorOf(req), (req.body ?? {}) as Record<string, unknown>));
  });
  app.patch('/api/floors/:id', adminOnly, json, (req, res) => {
    res.json(deps.floors.update(actorOf(req), req.params.id, (req.body ?? {}) as Record<string, unknown>));
  });
  app.delete('/api/floors/:id', adminOnly, (req, res) => {
    deps.floors.remove(actorOf(req), req.params.id);
    res.status(204).end();
  });

  // Ancien plan unique (avant les etages) : celui de l'etage le plus bas.
  app.get('/api/plan', anyUser, (_req, res) => sendPlan(deps.floors.defaultId(), res));
  app.put('/api/plan', adminOnly, rawPlan, (req, res) => {
    res.json({ ok: true, ...deps.floors.setPlan(actorOf(req), deps.floors.defaultId(), planMime(req), req.body) });
  });

  // ---- Inventaire (admin) ---------------------------------------------------------------

  app.post('/api/devices', adminOnly, json, (req, res) => {
    res.status(201).json(engine.createDevice(actorOf(req), (req.body ?? {}) as Record<string, unknown>));
  });
  app.patch('/api/devices/:id', adminOnly, json, (req, res) => {
    res.json(engine.updateDevice(actorOf(req), String(req.params.id), (req.body ?? {}) as Record<string, unknown>));
  });
  app.delete('/api/devices/:id', adminOnly, (req, res) => {
    const id = String(req.params.id);
    engine.deleteDevice(actorOf(req), id);
    deps.video.closeFeed(id);
    res.status(204).end();
  });
  app.put('/api/devices/:id/links', adminOnly, json, (req, res) => {
    const { cameraIds } = (req.body ?? {}) as { cameraIds?: unknown };
    res.json({ cameraIds: engine.setLinks(actorOf(req), String(req.params.id), cameraIds) });
  });

  // ---- Cameras reelles (ONVIF / RTSP) ---------------------------------------------------

  // Flux video : accessible a tout utilisateur connecte, l'authentification passe par le cookie.
  app.get('/api/cameras/:id/stream', anyUser, (req, res) => {
    deps.video.attachViewer(String(req.params.id), res);
  });
  app.get('/api/cameras/:id/source', adminOnly, (req, res) => {
    if (engine.getDevice(String(req.params.id))?.kind !== 'camera') throw new PsimError(404, 'Camera introuvable');
    res.json(deps.video.view(String(req.params.id)));
  });
  app.put('/api/cameras/:id/source', adminOnly, json, (req, res) => {
    res.json(deps.video.setSource(actorOf(req), String(req.params.id), (req.body ?? {}) as Record<string, unknown>));
  });
  app.post('/api/cameras/:id/test', adminOnly, async (req, res) => {
    res.json(await deps.video.test(String(req.params.id)));
  });
  let discovering = false;
  app.get('/api/onvif/discover', adminOnly, async (_req, res) => {
    if (discovering) throw new PsimError(429, 'Une recherche est deja en cours');
    discovering = true;
    try {
      res.json(await discoverOnvif());
    } finally {
      discovering = false;
    }
  });

  // ---- Simulateur (desactivable) --------------------------------------------------------

  app.post('/api/sim/detectors/:id', adminOnly, json, async (req, res) => {
    if (!deps.simEnabled) throw new PsimError(404, 'Simulateur desactive');
    const body = (req.body ?? {}) as { state?: unknown; event?: unknown; value?: unknown };
    const id = String(req.params.id);
    // Le simulateur n'envoie que ce qu'un equipement reel pourrait envoyer : un etat, un evenement ou une mesure.
    const payload: Record<string, unknown> = {};
    for (const key of ['state', 'event', 'value'] as const) if (body[key] !== undefined) payload[key] = body[key];
    if (Object.keys(payload).length === 0) throw new PsimError(400, 'state, event ou value requis');
    if (engine.getDevice(id)?.kind !== 'detector') throw new PsimError(404, 'Detecteur introuvable');
    engine.audit(actorOf(req), 'sim_trigger', { deviceId: id, details: JSON.stringify(payload) });
    await deps.triggerSim(id, payload);
    res.json({ ok: true });
  });

  // ---- Entree des equipements (HTTP) -----------------------------------------------------

  // Pour les systemes qui poussent leurs evenements (controle d'acces, passerelle IoT) sans parler MQTT.
  // Authentification par jeton partage (pas de session) ; desactivee tant qu'aucun jeton n'est configure.
  if (deps.ingestToken) {
    const digest = (v: string) => createHash('sha256').update(v).digest();
    const expected = digest(deps.ingestToken);
    const ingestJson = express.json({ limit: '2kb' });
    app.post('/api/ingest/:id', (req, res, next) => {
      const key = `ingest:${req.ip}`;
      if (isRateLimited(key)) return void res.status(429).json({ error: 'Trop de tentatives, reessayez dans une minute' });
      const header = req.headers.authorization ?? '';
      const given = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!timingSafeEqual(digest(given), expected)) {
        recordFailure(key);
        return void res.status(401).json({ error: 'Jeton invalide' });
      }
      next();
    }, ingestJson, (req, res) => {
      const result = engine.ingest(String(req.params.id), req.body);
      if (!result.ok) throw new PsimError(result.status, result.error);
      res.status(204).end();
    });
  }

  // ---- Rapports et exports (lecture seule) -------------------------------------------------

  const sendHtml = (res: Response, html: string) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  };
  const sendCsv = (res: Response, name: string, csv: string) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  };
  app.get('/api/reports/incidents', anyUser, (req, res) => {
    const range = parseRange(req.query);
    engine.audit(actorOf(req), 'report_exported', { details: `rapport ${range.fromDay} au ${range.toDay}${range.category ? ` (${range.category})` : ''}` });
    sendHtml(res, deps.reports.reportHtml(range, deps.reports.query(range), Date.now()));
  });
  app.get('/api/reports/incidents.csv', anyUser, (req, res) => {
    const range = parseRange(req.query);
    engine.audit(actorOf(req), 'report_exported', { details: `export CSV des incidents ${range.fromDay} au ${range.toDay}${range.category ? ` (${range.category})` : ''}` });
    sendCsv(res, `incidents_${range.fromDay}_${range.toDay}.csv`, deps.reports.incidentsCsv(range));
  });
  // Rapport periodique par e-mail : reglage et envoi immediat (administrateur).
  app.get('/api/reports/schedule', adminOnly, (_req, res) => res.json(deps.reportMail.view()));
  app.put('/api/reports/schedule', adminOnly, json, (req, res) => {
    deps.reportMail.update(actorOf(req), (req.body ?? {}) as Record<string, unknown>);
    res.json(deps.reportMail.view());
  });
  app.post('/api/reports/schedule/send-now', adminOnly, async (req, res) => {
    const sent = await deps.reportMail.sendNow(actorOf(req));
    res.json({ ok: true, from: sent.range.fromDay, to: sent.range.toDay, recipients: sent.to.length });
  });
  // Le journal complet contient les actions de tous les utilisateurs : administrateur.
  app.get('/api/reports/audit.csv', adminOnly, (req, res) => {
    const range = parseRange(req.query);
    engine.audit(actorOf(req), 'report_exported', { details: `export CSV du journal ${range.fromDay} au ${range.toDay}` });
    sendCsv(res, `journal_${range.fromDay}_${range.toDay}.csv`, deps.reports.auditCsv(range));
  });
  app.get('/api/reports/incidents/:id', anyUser, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new PsimError(404, 'Incident introuvable');
    sendHtml(res, deps.reports.incidentHtml(id, Date.now()));
  });

  // ---- Armement des zones d'intrusion ---------------------------------------------------

  app.get('/api/arming', anyUser, (_req, res) => res.json(deps.arming.list()));
  // Armer / desarmer pour une duree limitee : geste d'exploitation courant, ouvert a l'operateur (trace au journal).
  app.put('/api/arming/:zone/override', anyUser, json, (req, res) => {
    const { mode, hours } = (req.body ?? {}) as { mode?: unknown; hours?: unknown };
    res.json(deps.arming.setOverride(actorOf(req), String(req.params.zone), mode, hours));
  });
  app.delete('/api/arming/:zone/override', anyUser, (req, res) => {
    res.json(deps.arming.clearOverride(actorOf(req), String(req.params.zone)));
  });
  // Le planning est une configuration : administrateur.
  app.put('/api/arming/:zone/schedule', adminOnly, json, (req, res) => {
    res.json(deps.arming.setSchedule(actorOf(req), String(req.params.zone), (req.body as { schedule?: unknown } | undefined)?.schedule));
  });

  // ---- Erreurs --------------------------------------------------------------------------

  app.use('/api', (_req, res) => void res.status(404).json({ error: 'Route inconnue' }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof PsimError) return void res.status(err.status).json({ error: err.message });
    const status = (err as { status?: number }).status;
    if (status === 413) return void res.status(413).json({ error: 'Contenu trop volumineux' });
    if (status && status >= 400 && status < 500) return void res.status(status).json({ error: 'Requete invalide' });
    console.error(err);
    res.status(500).json({ error: 'Erreur interne' });
  });

  return app;
}
