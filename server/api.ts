import { createReadStream, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  checkCredentials,
  createSession,
  destroySession,
  getSession,
  isRateLimited,
  parseCookies,
  recordFailure,
} from './auth.ts';
import type { Session } from './auth.ts';
import type { Engine } from './engine.ts';
import { PsimError } from './engine.ts';
import { discoverOnvif } from './onvif.ts';
import type { Notifier } from './notifications.ts';
import type { RiskService } from './risk.ts';
import type { SnapshotService } from './snapshots.ts';
import type { VideoService } from './video.ts';
import type { Role } from './types.ts';

export const SESSION_COOKIE = 'psim_session';

const PLAN_TYPES: Record<string, { ext: string; mime: string }> = {
  'image/png': { ext: 'png', mime: 'image/png' },
  'image/jpeg': { ext: 'jpg', mime: 'image/jpeg' },
  'image/webp': { ext: 'webp', mime: 'image/webp' },
  'image/svg+xml': { ext: 'svg', mime: 'image/svg+xml' },
};
const MAX_PLAN_BYTES = 10 * 1024 * 1024;

function looksLike(mime: string, body: Buffer): boolean {
  switch (mime) {
    case 'image/png':
      return body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    case 'image/jpeg':
      return body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case 'image/webp':
      return body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'image/svg+xml':
      return body.subarray(0, 2048).toString('utf8').includes('<svg');
    default:
      return false;
  }
}

export interface ApiDeps {
  db: DatabaseSync;
  engine: Engine;
  video: VideoService;
  snapshots: SnapshotService;
  notifier: Notifier;
  risk: RiskService;
  dataDir: string;
  webDir: string;
  cookieSecure: boolean;
  simEnabled: boolean;
  /** Comptes proposes sur la page de connexion (mode demo), ou null. */
  demoAccounts: { username: string; label: string; password: string }[] | null;
  triggerSim: (detectorId: string, state: string) => Promise<void>;
}

type AuthedRequest = Request & { session: Session };

export function sessionFromRequest(req: Pick<Request, 'headers'>): Session | null {
  return getSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

export function createApp(deps: ApiDeps) {
  const { db, engine } = deps;
  const app = express();
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
    next();
  });

  app.use(express.static(deps.webDir, { index: 'index.html' }));
  const json = express.json({ limit: '10kb' });

  // ---- Authentification ---------------------------------------------------------------

  // Mode demo : uniquement depuis cette machine, jamais si le mode est desactive.
  app.get('/api/demo-accounts', (req, res) => {
    const remote = req.socket.remoteAddress ?? '';
    const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!deps.demoAccounts || !local) return void res.status(404).json({ error: 'Non disponible' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(deps.demoAccounts);
  });

  app.post('/api/login', json, (req, res) => {
    const key = req.ip ?? 'unknown';
    if (isRateLimited(key)) return void res.status(429).json({ error: 'Trop de tentatives, reessayer dans une minute' });
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const role =
      typeof username === 'string' && typeof password === 'string' ? checkCredentials(db, username, password) : null;
    if (!role || typeof username !== 'string') {
      recordFailure(key);
      return void res.status(401).json({ error: 'Identifiants incorrects' });
    }
    const token = createSession(username, role);
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${deps.cookieSecure ? '; Secure' : ''}`,
    );
    engine.audit(username, 'login');
    res.json({ username, role });
  });

  app.post('/api/logout', (req, res) => {
    destroySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  function requireRole(...roles: Role[]) {
    return (req: Request, res: Response, next: NextFunction) => {
      const session = sessionFromRequest(req);
      if (!session) return void res.status(401).json({ error: 'Non authentifie' });
      if (roles.length > 0 && !roles.includes(session.role)) return void res.status(403).json({ error: 'Droits insuffisants' });
      (req as AuthedRequest).session = session;
      next();
    };
  }
  const anyUser = requireRole();
  const adminOnly = requireRole('admin');
  const actorOf = (req: Request) => (req as AuthedRequest).session.username;

  app.get('/api/me', anyUser, (req, res) => {
    const { username, role } = (req as AuthedRequest).session;
    res.json({ username, role, simEnabled: deps.simEnabled });
  });

  // ---- Lecture --------------------------------------------------------------------------

  app.get('/api/state', anyUser, (_req, res) => res.json(engine.getSnapshot()));
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

  app.get('/api/audit', anyUser, (req, res) => res.json(engine.listAudit(Number(req.query.limit ?? 100))));

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

  // ---- Plan du site ---------------------------------------------------------------------

  app.get('/api/plan', anyUser, (_req, res) => {
    const site = db.prepare('SELECT plan_file FROM site WHERE id = 1').get() as { plan_file: string | null } | undefined;
    const file = site?.plan_file;
    const path = file ? join(deps.dataDir, file) : null;
    if (!file || !path || !existsSync(path)) return void res.status(404).json({ error: 'Aucun plan' });
    const mime = Object.values(PLAN_TYPES).find((t) => file.endsWith(`.${t.ext}`))?.mime ?? 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    // Un SVG televerse ne doit jamais pouvoir executer de script s'il est ouvert directement.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    createReadStream(path).pipe(res);
  });

  app.put(
    '/api/plan',
    adminOnly,
    express.raw({ type: Object.keys(PLAN_TYPES), limit: MAX_PLAN_BYTES }),
    (req, res) => {
      const mime = (req.headers['content-type'] ?? '').split(';')[0].trim();
      const type = PLAN_TYPES[mime];
      const body = req.body as unknown;
      if (!type || !Buffer.isBuffer(body) || body.length === 0) {
        throw new PsimError(415, 'Envoyer une image PNG, JPEG, WEBP ou SVG');
      }
      if (!looksLike(mime, body)) throw new PsimError(400, "Le contenu ne correspond pas au type d'image annonce");

      mkdirSync(deps.dataDir, { recursive: true });
      const current = db.prepare('SELECT plan_version FROM site WHERE id = 1').get() as { plan_version: number };
      const version = current.plan_version + 1;
      const file = `plan-${version}.${type.ext}`;
      writeFileSync(join(deps.dataDir, file), body);
      db.prepare('UPDATE site SET plan_file = ?, plan_version = ? WHERE id = 1').run(file, version);
      for (const old of readdirSync(deps.dataDir)) {
        if (/^plan-\d+\.\w+$/.test(old) && old !== file) unlinkSync(resolve(deps.dataDir, old));
      }
      engine.audit(actorOf(req), 'plan_updated', { details: `${(body.length / 1024).toFixed(0)} Ko` });
      res.json({ ok: true, planVersion: version });
    },
  );

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
    const state = (req.body as { state?: unknown } | undefined)?.state;
    const id = String(req.params.id);
    if (typeof state !== 'string') throw new PsimError(400, 'state requis');
    if (engine.getDevice(id)?.kind !== 'detector') throw new PsimError(404, 'Detecteur introuvable');
    engine.audit(actorOf(req), 'sim_trigger', { deviceId: id, details: state });
    await deps.triggerSim(id, state);
    res.json({ ok: true });
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
