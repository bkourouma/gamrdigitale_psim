import { join } from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { MAX_SKEW_MS } from '../../server/portal.ts';
import { checkCredentials, clearFailures, createSession, destroySession, isThrottled, principalFor, recordFailure, setPassword, visibleSite, visibleSites } from './accounts.ts';
import type { Principal } from './accounts.ts';
import { writeAudit } from './db.ts';
import { authenticateIngest, parseSummary, storeSummary } from './ingest.ts';
import { RANGES, overview, siteCards, siteDetail } from './views.ts';

export const SESSION_COOKIE = 'portal_session';

export interface PortalAppOptions {
  db: DatabaseSync;
  master: Buffer;
  now?: () => number;
  staleAfterMs: number;
  cookieSecure?: boolean;
  trustProxy?: boolean;
  webDir: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    principal?: Principal;
  }
}

function cookieOf(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function createPortalApp(options: PortalAppOptions) {
  const { db, master } = options;
  const now = options.now ?? Date.now;
  const app = express();
  app.disable('x-powered-by');
  if (options.trustProxy) app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    // Aucun script ni style venu d'ailleurs, aucune page integree dans un autre site, rien de mis en cache pour les donnees.
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/healthz', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // ------------------------------------------------------------ reception des sites (corps brut : la signature porte dessus)

  app.post('/api/ingest', express.raw({ type: () => true, limit: '2mb' }), (req, res) => {
    const t = now();
    const throttleKey = `ingest|${req.ip}`;
    if (isThrottled(throttleKey, t)) return void res.status(429).json({ error: 'trop de tentatives refusees' });
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const auth = authenticateIngest(db, master, req.headers, body, t);
    if (!auth.ok) {
      recordFailure(throttleKey, t);
      return void res.status(auth.status).json({ error: auth.error });
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return void res.status(400).json({ error: 'corps illisible (JSON attendu)' });
    }
    const parsed = parseSummary(json);
    if (!parsed.ok) return void res.status(400).json({ error: parsed.error });
    // Un resume signe par CE site ne parle que de ce site, et date d'un moment plausible (sinon il figerait l'etat dans le futur).
    if (parsed.summary.siteId !== auth.site.id) return void res.status(400).json({ error: "l'identifiant du site dans le resume ne correspond pas a celui de l'envoi" });
    if (Math.abs(parsed.summary.generatedAt - t) > MAX_SKEW_MS) return void res.status(400).json({ error: "horloge : la date du resume est trop eloignee de l'heure du portail" });
    const result = storeSummary(db, auth.site.id, parsed.summary, t);
    res.json({ ok: true, result });
  });

  // ------------------------------------------------------------ le reste : JSON, meme origine, session

  app.use(express.json({ limit: '10kb' }));

  // Un navigateur qui poste depuis un autre site envoie son origine : on la refuse. (Le cookie est deja SameSite=Strict.)
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {
        // « null » (page locale, contexte isole) : refuse
      }
      if (host !== req.headers.host) return void res.status(403).json({ error: 'origine refusee' });
    }
    next();
  });

  const cookieFlags = (maxAgeS: number) => `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${options.cookieSecure ? '; Secure' : ''}`;

  function user(req: Request, res: Response, next: NextFunction): void {
    const p = principalFor(db, cookieOf(req, SESSION_COOKIE), now());
    if (!p) return void res.status(401).json({ error: 'connexion requise' });
    req.principal = p;
    next();
  }
  /** Un compte au mot de passe initial ne voit rien tant qu'il ne l'a pas change. */
  function ready(req: Request, res: Response, next: NextFunction): void {
    if (req.principal!.mustChangePassword) return void res.status(403).json({ error: 'password_change_required' });
    next();
  }
  const me = (p: Principal) => ({ username: p.username, displayName: p.displayName, role: p.role, mustChangePassword: p.mustChangePassword });

  app.post('/api/login', (req, res) => {
    const t = now();
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase().slice(0, 60) : '';
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
    const keys = [`login|${req.ip}`, `login|${req.ip}|${username}`];
    if (keys.some((k) => isThrottled(k, t))) return void res.status(429).json({ error: 'Trop de tentatives. Réessayez dans une minute.' });
    const ok = username && password ? checkCredentials(db, username, password) : null;
    if (!ok) {
      for (const k of keys) recordFailure(k, t);
      writeAudit(db, username || '?', 'login_failed', `ip ${req.ip}`, t);
      return void res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
    }
    for (const k of keys) clearFailures(k);
    const token = createSession(db, ok.username, ok.epoch, t);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieFlags(12 * 3600)}`);
    writeAudit(db, ok.username, 'login', `ip ${req.ip}`, t);
    res.json(me(principalFor(db, token, t)!));
  });

  app.post('/api/logout', (req, res) => {
    destroySession(db, cookieOf(req, SESSION_COOKIE));
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieFlags(0)}`);
    res.json({ ok: true });
  });

  app.get('/api/me', user, (req, res) => void res.json(me(req.principal!)));

  app.post('/api/password', user, (req, res) => {
    const p = req.principal!;
    const t = now();
    const key = `password|${p.username}`;
    if (isThrottled(key, t)) return void res.status(429).json({ error: 'Trop de tentatives. Réessayez dans une minute.' });
    const current = typeof req.body?.current === 'string' ? req.body.current.slice(0, 200) : '';
    const next = typeof req.body?.next === 'string' ? req.body.next.slice(0, 201) : '';
    const verified = checkCredentials(db, p.username, current);
    if (!verified) {
      recordFailure(key, t);
      return void res.status(400).json({ error: 'Le mot de passe actuel est incorrect.' });
    }
    if (next === current) return void res.status(400).json({ error: "Le nouveau mot de passe doit être différent de l'ancien." });
    try {
      setPassword(db, p.username, next, false, t);
    } catch (err) {
      return void res.status(400).json({ error: `Mot de passe refusé : ${(err as Error).message.replace(/^mot de passe /, '')}.` });
    }
    // setPassword a coupe toutes les sessions, y compris celle-ci : on en ouvre une nouvelle.
    const fresh = db.prepare('SELECT session_epoch FROM portal_user WHERE username = ?').get(p.username) as { session_epoch: number };
    const token = createSession(db, p.username, fresh.session_epoch, t);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieFlags(12 * 3600)}`);
    writeAudit(db, p.username, 'password_changed', undefined, t);
    res.json(me(principalFor(db, token, t)!));
  });

  app.get('/api/overview', user, ready, (req, res) => {
    const sites = visibleSites(db, req.principal!);
    res.json(overview(db, sites, now(), options.staleAfterMs));
  });

  app.get('/api/sites', user, ready, (req, res) => {
    res.json(siteCards(db, visibleSites(db, req.principal!), now(), options.staleAfterMs));
  });

  app.get('/api/sites/:id', user, ready, (req, res) => {
    const site = visibleSite(db, req.principal!, String(req.params.id));
    if (!site) return void res.status(404).json({ error: 'Site introuvable' });
    const asked = Number(req.query.days ?? 30);
    const days = (RANGES as readonly number[]).includes(asked) ? asked : 30;
    res.json(siteDetail(db, site, days, now(), options.staleAfterMs));
  });

  app.all('/api/*splat', (_req, res) => void res.status(404).json({ error: 'Introuvable' }));

  app.use(express.static(options.webDir, { index: 'index.html', maxAge: 0 }));
  app.get('/{*splat}', (_req, res) => res.sendFile(join(options.webDir, 'index.html')));

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // Corps trop gros, JSON invalide... : une reponse nette, jamais la trace de la pile.
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500) console.error('[portail] erreur :', err);
    res.status(status).json({ error: status === 413 ? 'Corps trop volumineux' : status < 500 ? 'Requete invalide' : 'Erreur interne' });
  });

  return app;
}
