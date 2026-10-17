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
  useSessionStore,
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
import { DahuaAuthError } from './dahua.ts';
import type { Credentials, DahuaEvents } from './dahua.ts';
import { fetchFaceGroups } from './faces.ts';
import type { FaceGroup } from './faces.ts';
import type { FaceObs } from './faceobs.ts';
import type { Presence } from './presence.ts';
import { describeRule } from './rules.ts';
import type { Rules } from './rules.ts';
import { createRuleAssistant } from './ruleassist.ts';
import type { TuyaService } from './tuya.ts';
import { createNetworkTargets } from './networkhealth.ts';
import { createHash, timingSafeEqual } from 'node:crypto';
import { discoverOnvif } from './onvif.ts';
import type { Notifier } from './notifications.ts';
import type { RecipientsService } from './recipients.ts';
import type { UsersService } from './users.ts';
import type { RiskService } from './risk.ts';
import type { SnapshotService } from './snapshots.ts';
import type { DeviceImages } from './deviceimages.ts';
import type { Actuators } from './actuators.ts';
import type { ProofService } from './proofpack.ts';
import type { VideoService } from './video.ts';
import type { Role } from './types.ts';

export const SESSION_COOKIE = 'psim_session';

const MAX_PLAN_BYTES = 10 * 1024 * 1024;

export interface ApiDeps {
  db: DatabaseSync;
  engine: Engine;
  floors: Floors;
  dahua: DahuaEvents;
  /** Regles de presence (detecteurs virtuels R-<id>) et presence courante des cameras. */
  rules: Rules;
  presence: Presence;
  /** Visages vus par les cameras (GET /api/faces/recent). Absent : aucune observation. */
  faceObs?: FaceObs;
  /** Assistant de regles (cle de l'API, modele, adresse du service) ; sans cle, l'assistant n'est pas configure. */
  assist?: { apiKey: string; model?: string; apiUrl?: string };
  tuya: TuyaService;
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
  /** Cles par equipement et images envoyees par les equipements (POST /api/ingest/<id>/image). */
  deviceImages?: DeviceImages;
  /** Commandes des equipements (sirenes, relais, gaches...) : voir actuators.ts et docs/COMMANDES.md. */
  actuators?: Actuators;
  /** Dossier de preuve exportable par incident (GET /api/incidents/:id/proof). */
  proofs?: ProofService;
}

type AuthedRequest = Request & { session: Session };

export function sessionFromRequest(req: Pick<Request, 'headers'>): Session | null {
  return getSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

// ---------------------------------------------------------------- listes de visages (cache partage)

export interface FaceListEntry {
  id: string;
  name: string;
  size?: number;
  cameraId: string;
  cameraName: string;
  /**
   * Identifiants de TOUTES les cameras du PSIM lues par le meme appareil que `cameraId` (triees, `cameraId` comprise), relus a chaque
   * lecture ; sert a retrouver la liste d'une regle creee depuis une autre voie du meme enregistreur. Aucune adresse.
   */
  deviceCameraIds?: string[];
}

export interface FaceListsResult {
  lists: FaceListEntry[];
  notes: string[];
  /** Nombre d'appareils interroges. */
  hosts: number;
}

const FACE_OK_TTL_MS = 5 * 60_000;
/** Un echec n'est pas retente avant 60 s (des essais en rafale bloqueraient le compte de l'appareil) ; un refus d'identifiants, 5 min. */
const FACE_FAIL_TTL_MS = 60_000;
const FACE_AUTH_TTL_MS = 5 * 60_000;
const FACE_READ_TIMEOUT_MS = 12_000;
/** Message de fetchFaceGroups pour un appareil sans reconnaissance faciale (HTTP 404 ou 501) : pas un incident, rien a signaler. */
const NO_FACE_SERVICE = /ne propose pas la reconnaissance faciale/;

interface FaceHostState {
  cameraId: string;
  /** Fin de la derniere lecture terminee (0 : jamais). */
  at: number;
  groups: FaceGroup[];
  failure: { reason: string; auth: boolean } | null;
  pending: Promise<void> | null;
}

/**
 * Bases de visages lues sur chaque appareil Dahua de camera_source (un enregistreur, mais aussi une camera IP a
 * reconnaissance embarquee). Cache PAR HOTE : 5 min pour un succes (une reponse vide ou « sans reconnaissance faciale » en
 * est un : l'enregistreur actuel n'a aucune base), 60 s pour un echec, 5 min pour des identifiants refuses. Partage par la
 * route des listes et par le contexte de l'assistant. Aucune adresse ni mot de passe dans ce qui sort.
 */
export function createFaceLists(deps: {
  hosts: () => { cameraId: string; creds: Credentials }[];
  cameraName: (cameraId: string) => string;
  /** Cameras du meme appareil que la camera donnee (voir `deviceIndex`) : ajoute `deviceCameraIds` a chaque entree. */
  deviceCameraIds?: (cameraId: string) => string[];
  fetchGroups?: (creds: Credentials) => Promise<FaceGroup[]>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const fetchGroups = deps.fetchGroups ?? ((creds: Credentials) => fetchFaceGroups(creds));
  const cache = new Map<string, FaceHostState>();
  const keyOf = (c: Credentials) => `${c.host}|${c.port}|${c.username}|${createHash('sha256').update(c.password).digest('hex').slice(0, 16)}`;

  const fresh = (e: FaceHostState): boolean => e.at > 0 && now() - e.at < (e.failure ? (e.failure.auth ? FACE_AUTH_TTL_MS : FACE_FAIL_TTL_MS) : FACE_OK_TTL_MS);

  /** Raison lisible : jamais le mot de passe ni l'adresse, meme si un message d'appareil les citait. */
  const safeReason = (err: unknown, creds: Credentials): string => {
    let text = err instanceof Error ? err.message : 'erreur inconnue';
    for (const secret of [creds.password, creds.host]) if (secret) text = text.split(secret).join('***');
    return text.replace(/[\r\n]+/g, ' ').slice(0, 200);
  };

  function load(entry: FaceHostState, creds: Credentials): Promise<void> {
    if (entry.pending) return entry.pending;
    entry.pending = (async () => {
      try {
        entry.groups = await fetchGroups(creds);
        entry.failure = null;
      } catch (err) {
        if (err instanceof Error && NO_FACE_SERVICE.test(err.message)) {
          entry.groups = []; // appareil sans reconnaissance faciale : ignore proprement, sans note
          entry.failure = null;
        } else {
          // Les dernieres bases connues restent utilisables (un trou de 60 s ne vide pas le contexte de l'assistant).
          entry.failure = { reason: safeReason(err, creds), auth: err instanceof DahuaAuthError };
        }
      } finally {
        entry.at = now();
        entry.pending = null;
      }
    })();
    return entry.pending;
  }

  /** Relit ce qui est perime (en parallele) et attend au plus `timeoutMs` ; ce qui n'a pas fini le sera pour la fois suivante. */
  async function read(timeoutMs = FACE_READ_TIMEOUT_MS): Promise<FaceListsResult> {
    const hosts = deps.hosts();
    const wanted = new Set(hosts.map((h) => keyOf(h.creds)));
    for (const key of [...cache.keys()]) if (!wanted.has(key)) cache.delete(key);
    const states = hosts.map((h) => {
      const key = keyOf(h.creds);
      let entry = cache.get(key);
      if (!entry) {
        entry = { cameraId: h.cameraId, at: 0, groups: [], failure: null, pending: null };
        cache.set(key, entry);
      }
      entry.cameraId = h.cameraId;
      if (!fresh(entry)) void load(entry, h.creds);
      return entry;
    });
    const running = states.map((e) => e.pending).filter((p): p is Promise<void> => p !== null);
    if (running.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(running), new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
      clearTimeout(timer);
    }
    return compose(states);
  }

  function compose(states: FaceHostState[]): FaceListsResult {
    const lists: FaceListEntry[] = [];
    const notes: string[] = [];
    for (const e of states) {
      const cameraName = deps.cameraName(e.cameraId);
      const sameDevice = deps.deviceCameraIds ? { deviceCameraIds: deps.deviceCameraIds(e.cameraId) } : {};
      for (const g of e.groups) lists.push({ id: g.id, name: g.name, ...(g.size === undefined ? {} : { size: g.size }), cameraId: e.cameraId, cameraName, ...sameDevice });
      if (e.failure) {
        notes.push(`La caméra « ${cameraName} » ne répond pas : ${e.failure.reason}.`);
      } else if (e.at === 0) {
        notes.push(`La caméra « ${cameraName} » ne répond pas : pas de réponse de l'appareil.`); // lecture encore en cours
      }
    }
    return { lists, notes, hosts: states.length };
  }

  /**
   * Ce que le cache contient maintenant, sans rien lire (contexte de l'assistant) : UNE ligne par (appareil, liste), avec la camera
   * par laquelle la liste se lit. Aucun dedoublonnage entre appareils : chaque appareil numerote ses listes lui-meme, deux appareils
   * peuvent avoir chacun une liste « 1 » (meme nom ou non), et ce sont deux listes distinctes.
   */
  function cached(): { cameraId: string; cameraName: string; id: string; name: string }[] {
    const out: { cameraId: string; cameraName: string; id: string; name: string }[] = [];
    const done = new Set<FaceHostState>();
    for (const h of deps.hosts()) {
      const entry = cache.get(keyOf(h.creds));
      if (!entry || done.has(entry)) continue;
      done.add(entry);
      const cameraName = deps.cameraName(h.cameraId);
      for (const g of entry.groups) out.push({ cameraId: h.cameraId, cameraName, id: g.id, name: g.name });
    }
    return out;
  }

  return { read, cached };
}

/**
 * Stabilise la camera annoncee pour chaque appareil. `faceHosts()` prend la premiere camera de l'hote par ordre d'identifiant : y
 * ajouter une camera d'identifiant plus petit (ou corriger les identifiants de la premiere) changerait le `cameraId` annonce, et
 * l'ecran ne retrouverait plus la liste d'une regle deja enregistree. On garde donc, par hote, la camera deja annoncee tant qu'elle
 * lit encore cet hote (source video avec une voie) ; sinon (camera supprimee, adresse changee) on prend celle que `faceHosts()` donne.
 * La correspondance des regles se fait par APPAREIL (hote) : ce choix ne change jamais le declenchement, seulement ce que l'ecran affiche.
 * La memoire vit dans le processus : apres un redemarrage, c'est de nouveau la premiere camera de l'hote par ordre d'identifiant.
 */
export function stableFaceHosts(db: DatabaseSync, hosts: () => { cameraId: string; creds: Credentials }[]): () => { cameraId: string; creds: Credentials }[] {
  const chosen = new Map<string, string>();
  const stillReads = (cameraId: string, host: string): boolean => {
    try {
      const row = db.prepare('SELECT host, rtsp_path FROM camera_source WHERE device_id = ?').get(cameraId) as { host?: unknown; rtsp_path?: unknown } | undefined;
      return row?.host === host && typeof row.rtsp_path === 'string' && /channel=\d+/i.test(row.rtsp_path);
    } catch {
      return false;
    }
  };
  return () =>
    hosts().map((h) => {
      const kept = chosen.get(h.creds.host);
      if (kept !== undefined && kept !== h.cameraId && stillReads(kept, h.creds.host)) return { ...h, cameraId: kept };
      chosen.set(h.creds.host, h.cameraId);
      return h;
    });
}

/**
 * Index des appareils (un par hote de camera_source). Reperes d'appareil OPAQUES pour le contexte de l'assistant : « appareil 1 », « appareil 2 »... un par hote distinct de
 * camera_source (hotes tries, hote -> rang), le meme pour toutes les cameras d'un meme hote (enregistreur a plusieurs voies).
 * Camera sans source video ou a hote vide : aucun repere. L'hote lui-meme (adresse) ne sort JAMAIS d'ici. Relu a chaque appel :
 * une camera dont on change l'adresse change d'appareil au contexte suivant.
 */
export function deviceIndex(db: DatabaseSync): { mark: (cameraId: string) => string | undefined; cameras: (cameraId: string) => string[] } {
  // Meme comparaison d'hotes que les regles (rules.ts) : sans espaces autour, en minuscules.
  const keyOf = (host: unknown): string | null => (typeof host === 'string' && host.trim() !== '' ? host.trim().toLowerCase() : null);
  let rows: { device_id: string; host: unknown }[] = [];
  try {
    rows = db.prepare('SELECT device_id, host FROM camera_source').all() as unknown as { device_id: string; host: unknown }[];
  } catch {
    return { mark: () => undefined, cameras: () => [] }; // base illisible : rien plutot qu'une reponse en erreur
  }
  const hosts = [...new Set(rows.map((r) => keyOf(r.host)).filter((k): k is string => k !== null))].sort();
  const rank = new Map(hosts.map((h, i) => [h, i + 1] as const));
  const byCamera = new Map(rows.map((r) => [r.device_id, keyOf(r.host)] as const));
  const byHost = new Map<string, string[]>();
  for (const r of rows) {
    const key = keyOf(r.host);
    if (key !== null) byHost.set(key, [...(byHost.get(key) ?? []), r.device_id]);
  }
  for (const ids of byHost.values()) ids.sort();
  return {
    mark: (cameraId) => {
      const key = byCamera.get(cameraId);
      const n = key ? rank.get(key) : undefined;
      return n === undefined ? undefined : `appareil ${n}`;
    },
    /** Toutes les cameras lues par le meme appareil que `cameraId` (triees, elle comprise) ; aucune si elle n'a pas de source. */
    cameras: (cameraId) => {
      const key = byCamera.get(cameraId);
      return key ? [...(byHost.get(key) ?? [])] : [];
    },
  };
}

/** Compteur glissant : au plus `max` appels par `windowMs` et par cle. */
function createQuota(max: number, windowMs: number, now: () => number = Date.now) {
  const calls = new Map<string, number[]>();
  return {
    /** Prend une place si elle existe ; faux si la limite est atteinte. */
    take(key: string): boolean {
      const t = now();
      const recent = (calls.get(key) ?? []).filter((at) => t - at < windowMs);
      if (recent.length >= max) {
        calls.set(key, recent);
        return false;
      }
      recent.push(t);
      calls.set(key, recent);
      if (calls.size > 1000) for (const [k, v] of calls) if (v.every((at) => t - at >= windowMs)) calls.delete(k);
      return true;
    },
  };
}

const ASSIST_PER_HOUR = 20;
/** Meme borne que ruleassist.ts (MAX_TEXT) : une phrase trop longue est refusee avant d'entamer le quota. */
const ASSIST_MAX_TEXT = 1000;
const ASSIST_WARM_MS = 3000;

export function createApp(deps: ApiDeps) {
  const { db, engine, users } = deps;
  // Controle a CHAQUE requete : compte supprime / desactive / identifiants changes = plus de session ; le role vient de la base.
  setSessionValidator(users.validateSession);
  // Sessions gardees en base (empreinte du jeton) : un redemarrage du PSIM ne deconnecte personne.
  useSessionStore(db);
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
    // Type d'apres les octets (JPEG ou PNG, verifies a l'arrivee) ; jamais interpretable comme un document actif.
    res.setHeader('Content-Type', image[0] === 0x89 ? 'image/png' : 'image/jpeg');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    res.end(image);
  });

  // Notifications (administrateur) : etat des canaux + message de test pour verifier la configuration.
  app.get('/api/notifications/status', adminOnly, (_req, res) => res.json({ ...deps.notifier.status(), orphanRecipientZones: deps.recipients.orphanZones() }));
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
    // Le detecteur virtuel d'une regle de presence vit et meurt avec sa regle : le supprimer ici la laisserait orpheline.
    if (db.prepare('SELECT 1 AS x FROM presence_rule WHERE device_id = ?').get(id)) {
      throw new PsimError(409, 'Ce detecteur appartient a une regle de presence : modifier ou supprimer la regle');
    }
    engine.deleteDevice(actorOf(req), id);
    deps.video.closeFeed(id);
    res.status(204).end();
  });
  app.put('/api/devices/:id/links', adminOnly, json, (req, res) => {
    const { cameraIds } = (req.body ?? {}) as { cameraIds?: unknown };
    res.json({ cameraIds: engine.setLinks(actorOf(req), String(req.params.id), cameraIds) });
  });

  // ---- Regles de presence (administrateur : ecriture ; tout utilisateur connecte : lecture) --------------

  /** Identifiant numerique d'une regle ; tout le reste (texte, 0, negatif, trop grand) est « introuvable ». */
  const ruleId = (req: Request): number => {
    const text = String(req.params.id);
    const id = /^[0-9]{1,15}$/.test(text) ? Number(text) : 0;
    if (!Number.isSafeInteger(id) || id < 1) throw new PsimError(404, 'Regle introuvable');
    return id;
  };
  /** Corps d'une demande : l'absence de corps devient un objet vide (le module des regles dit ce qui manque). */
  const ruleBody = (req: Request): unknown => req.body ?? {};
  // Les regles ouvrent ou ferment les flux d'observation de l'enregistreur (« existe-t-il une regle active ? »).
  const afterRuleChange = () => {
    try {
      deps.dahua.reload();
    } catch (err) {
      console.error('[psim] relecture des flux apres un changement de regle :', err);
    }
  };

  app.get('/api/rules', anyUser, (_req, res) => res.json(deps.rules.list()));
  app.get('/api/presence', anyUser, (_req, res) => res.json(deps.presence.current()));
  app.post('/api/rules', adminOnly, json, (req, res) => {
    const rule = deps.rules.create(actorOf(req), ruleBody(req) as Parameters<Rules['create']>[1]);
    afterRuleChange();
    res.status(201).json(rule);
  });

  // Listes de visages (bases des appareils Dahua de camera_source) : cache partage avec le contexte de l'assistant.
  const cameraNameOf = (id: string): string => engine.getDevice(id)?.name ?? id;
  const faceLists = createFaceLists({
    hosts: stableFaceHosts(deps.db, () => deps.dahua.faceHosts()),
    cameraName: cameraNameOf,
    deviceCameraIds: (cameraId) => deviceIndex(deps.db).cameras(cameraId),
  });

  // Assistant : meme validation et meme phrase francaise que la saisie manuelle ; le contexte ne contient que des noms.
  const assistEnvironment = () => {
    const devices = engine.getSnapshot().devices;
    const cameras = devices.filter((d) => d.kind === 'camera');
    return {
      cameras,
      ctx: { cameraIds: new Set(cameras.map((c) => c.id)) as ReadonlySet<string>, zones: new Set(devices.map((d) => d.zone).filter((z) => z !== '')) as ReadonlySet<string> },
    };
  };
  const assistant = createRuleAssistant({
    apiKey: deps.assist?.apiKey,
    model: deps.assist?.model,
    url: deps.assist?.apiUrl,
    // Meme verification que la saisie manuelle (forme, portee, et camera de la portee sur l'appareil de la liste).
    validate: (input) => deps.rules.validate(input),
    describe: (spec) => describeRule(spec, { cameraName: cameraNameOf }),
    context: () => {
      const { cameras, ctx } = assistEnvironment();
      const markOf = deviceIndex(deps.db).mark;
      const mark = (cameraId: string) => {
        const device = markOf(cameraId);
        return device === undefined ? {} : { device };
      };
      return {
        cameras: cameras.map((c) => ({ id: c.id, name: c.name, zone: c.zone, ...mark(c.id) })),
        zones: [...ctx.zones],
        // Le repere d'une liste est celui de sa camera : une liste et les cameras de son appareil portent le meme.
        lists: faceLists.cached().map((l) => ({ cameraId: l.cameraId, cameraName: l.cameraName, ...mark(l.cameraId), id: l.id, name: l.name })),
      };
    },
  });
  const assistQuota = createQuota(ASSIST_PER_HOUR, 3_600_000);

  app.get('/api/rules/assist', adminOnly, (_req, res) => res.json({ configured: assistant.configured }));
  app.post('/api/rules/assist', adminOnly, json, async (req, res) => {
    const body = ruleBody(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new PsimError(400, 'La demande : un objet est attendu');
    for (const key of Object.keys(body)) {
      if (key !== 'text' && key !== 'history') throw new PsimError(400, `La demande : champ « ${key.replace(/[^ -~]/g, '?').slice(0, 40)} » non reconnu`);
    }
    const { text, history } = body as { text?: unknown; history?: unknown };
    if (typeof text !== 'string') throw new PsimError(400, 'La demande : « text » (la phrase décrivant la règle) est requis');
    let turns: { role: 'user' | 'assistant'; text: string }[] | undefined;
    if (history !== undefined) {
      if (!Array.isArray(history) || history.length > 40) throw new PsimError(400, 'La demande : « history » doit être une liste de 40 échanges au plus');
      turns = history.map((turn) => {
        if (typeof turn !== 'object' || turn === null || Array.isArray(turn) || Object.keys(turn).some((k) => k !== 'role' && k !== 'text')) {
          throw new PsimError(400, 'La demande : chaque échange de « history » est { role, text }');
        }
        const { role, text: said } = turn as { role?: unknown; text?: unknown };
        if ((role !== 'user' && role !== 'assistant') || typeof said !== 'string') throw new PsimError(400, 'La demande : chaque échange de « history » est { role: "user" ou "assistant", text }');
        return { role, text: said };
      });
    }
    // Refus avant d'atteindre le service (aucun appel, donc aucune place prise sur le quota).
    if (!assistant.configured) throw new PsimError(503, 'Assistant non configuré');
    if (text.trim() === '') throw new PsimError(400, 'Décrivez la règle en une phrase.');
    if (text.length > ASSIST_MAX_TEXT) throw new PsimError(400, `La phrase est trop longue (${ASSIST_MAX_TEXT} caractères au plus).`);
    const actor = actorOf(req);
    if (!assistQuota.take(actor)) throw new PsimError(429, `Trop de demandes à l'assistant (${ASSIST_PER_HOUR} par heure). Réessayez plus tard.`);
    // Les listes de visages se lisent sur les appareils : on leur laisse quelques secondes, pas davantage.
    await faceLists.read(ASSIST_WARM_MS).catch(() => undefined);
    let kind = 'erreur';
    try {
      const proposal = await assistant.propose(text, turns);
      kind = proposal.kind;
      res.json(proposal);
    } finally {
      engine.audit(actor, 'rule_assist', { details: `${text.length} caractères ; proposition : ${kind}` });
    }
  });

  app.get('/api/faces/lists', adminOnly, async (_req, res) => res.json(await faceLists.read()));
  app.get('/api/faces/recent', adminOnly, (_req, res) => {
    res.json(
      (deps.faceObs?.recent(50) ?? []).map((o) => ({ cameraId: o.cameraId, cameraName: cameraNameOf(o.cameraId), at: o.at, kind: o.kind, personName: o.personName, groupName: o.groupName, similarity: o.similarity })),
    );
  });

  // Essai sur le passe : rien n'est ecrit, le moteur ne recoit aucun message.
  app.post('/api/rules/simulate', adminOnly, json, (req, res) => {
    const body = ruleBody(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new PsimError(400, 'La demande : un objet est attendu');
    for (const key of Object.keys(body)) {
      if (key !== 'spec' && key !== 'days') throw new PsimError(400, `La demande : champ « ${key.replace(/[^ -~]/g, '?').slice(0, 40)} » non reconnu`);
    }
    const { spec, days } = body as { spec?: unknown; days?: unknown };
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 30) throw new PsimError(400, 'Nombre de jours invalide (1 a 30)');
    const to = Date.now();
    const from = to - days * 86_400_000;
    const result = deps.rules.simulate(spec, from, to);
    // L'historique d'armement n'est pas conserve : pour « quand la zone est armee », l'armement ACTUEL sert pour tout le passe.
    const when = typeof spec === 'object' && spec !== null ? (spec as { when?: unknown }).when : undefined;
    const armedNote = typeof when === 'object' && when !== null && (when as { type?: unknown }).type === 'armed';
    res.json({ summary: result.summary, triggers: result.triggers, days, from, to, armedNote });
  });
  app.put('/api/rules/:id', adminOnly, json, (req, res) => {
    const rule = deps.rules.update(actorOf(req), ruleId(req), ruleBody(req) as Parameters<Rules['update']>[2]);
    afterRuleChange();
    res.json(rule);
  });
  app.delete('/api/rules/:id', adminOnly, (req, res) => {
    deps.rules.remove(actorOf(req), ruleId(req));
    afterRuleChange();
    res.status(204).end();
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

  // ---- Source d'evenements d'un detecteur (detection d'un appareil Dahua) ----------------
  app.get('/api/detectors/:id/source', adminOnly, (req, res) => {
    if (engine.getDevice(String(req.params.id))?.kind !== 'detector') throw new PsimError(404, 'Detecteur introuvable');
    res.json(deps.dahua.view(String(req.params.id)));
  });
  app.put('/api/detectors/:id/source', adminOnly, json, (req, res) => {
    res.json(deps.dahua.setSource(actorOf(req), String(req.params.id), (req.body ?? {}) as Record<string, unknown>));
  });
  app.delete('/api/detectors/:id/source', adminOnly, (req, res) => {
    deps.dahua.removeSource(actorOf(req), String(req.params.id));
    res.status(204).end();
  });
  // ---- Supervision reseau d'un equipement d'infrastructure (routeur, switch...) : hote + port TCP ----
  const network = createNetworkTargets({ db, audit: (actor, action, ref) => engine.audit(actor, action, ref) });
  app.get('/api/devices/:id/network', adminOnly, (req, res) => {
    res.json(network.view(String(req.params.id)));
  });
  app.put('/api/devices/:id/network', adminOnly, json, (req, res) => {
    res.json(network.set(actorOf(req), String(req.params.id), (req.body ?? {}) as Record<string, unknown>));
  });
  app.delete('/api/devices/:id/network', adminOnly, (req, res) => {
    network.remove(actorOf(req), String(req.params.id));
    res.status(204).end();
  });
  // Essai avant enregistrement : une seule connexion, un essai a la fois (jamais une rafale vers une adresse choisie).
  let networkTesting = false;
  app.post('/api/network/test', adminOnly, json, async (req, res) => {
    if (networkTesting) throw new PsimError(429, 'Un essai est deja en cours');
    networkTesting = true;
    try {
      res.json(await network.test((req.body ?? {}) as Record<string, unknown>));
    } finally {
      networkTesting = false;
    }
  });
  // Essai : ecoute l'appareil d'une camera 20 s et rapporte tout ce qu'il emet (un essai a la fois).
  let listening = false;
  app.post('/api/cameras/:id/events-test', adminOnly, json, async (req, res) => {
    if (listening) throw new PsimError(429, 'Un essai est deja en cours');
    const body = (req.body ?? {}) as { httpPort?: unknown };
    const port = body.httpPort === undefined ? 80 : Number(body.httpPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PsimError(400, 'Port HTTP invalide (1 a 65535)');
    listening = true;
    try {
      res.json(await deps.dahua.test(String(req.params.id), port, 20));
    } finally {
      listening = false;
    }
  });
  // ---- Detecteurs de fumee WiFi Tuya / Smart Life (lus dans le cloud Tuya) --------------------
  app.get('/api/detectors/:id/tuya', adminOnly, (req, res) => {
    if (engine.getDevice(String(req.params.id))?.kind !== 'detector') throw new PsimError(404, 'Detecteur introuvable');
    res.json(deps.tuya.view(String(req.params.id)));
  });
  app.put('/api/detectors/:id/tuya', adminOnly, json, (req, res) => {
    res.json(deps.tuya.setSource(actorOf(req), String(req.params.id), (req.body ?? {}) as Record<string, unknown>));
  });
  app.delete('/api/detectors/:id/tuya', adminOnly, (req, res) => {
    deps.tuya.removeSource(actorOf(req), String(req.params.id));
    res.status(204).end();
  });
  // Essai : lit l'appareil une fois dans le cloud Tuya (un essai a la fois ; chaque essai consomme un appel du forfait Tuya).
  let tuyaTesting = false;
  app.post('/api/tuya/test', adminOnly, json, async (req, res) => {
    if (tuyaTesting) throw new PsimError(429, 'Un essai est deja en cours');
    tuyaTesting = true;
    try {
      const body = (req.body ?? {}) as { deviceId?: unknown; sensorType?: unknown; detectorId?: unknown };
      res.json(await deps.tuya.test(body.deviceId, body.sensorType, body.detectorId));
    } finally {
      tuyaTesting = false;
    }
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
  // Cle par equipement (deviceimages.ts) : acceptee aussi pour les messages d'etat, limitee a SES equipements.
  if (deps.ingestToken || deps.deviceImages) {
    const digest = (v: string) => createHash('sha256').update(v).digest();
    const expected = digest(deps.ingestToken ?? '');
    const ingestJson = express.json({ limit: '2kb' });
    app.post('/api/ingest/:id', (req, res, next) => {
      const key = `ingest:${req.ip}`;
      if (isRateLimited(key)) return void res.status(429).json({ error: 'Trop de tentatives, reessayez dans une minute' });
      const keys = deps.deviceImages?.keys;
      if (keys?.presentsKey(req.headers.authorization)) {
        const check = keys.check(req.headers.authorization, String(req.params.id));
        if (check.ok) return next();
        recordFailure(key);
        deps.deviceImages!.noteRefusal(req.ip ?? 'inconnue', String(req.params.id), `message d'etat : cle refusee (${check.reason})`, check.keyId);
        return void res.status(check.reason === 'scope' ? 403 : 401).json({ error: check.reason === 'scope' ? "Cette cle n'est pas autorisee pour cet equipement" : 'Jeton invalide' });
      }
      if (!deps.ingestToken) return next('route'); // sans jeton partage, l'entree n'existe que pour les cles d'equipement
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
      // msgId deja traite (renvoi apres une coupure) : succes sans effet, dit comme tel pour que la passerelle l'oublie.
      if (result.duplicate) return void res.status(200).json({ ok: true, duplicate: true });
      res.status(204).end();
    });
  }
  deps.deviceImages?.mount(app, { adminOnly, actorOf });
  deps.actuators?.mount(app, { anyUser, adminOnly, actorOf, roleOf: (req) => (req as AuthedRequest).session.role });
  deps.proofs?.mount(app, { anyUser, actorOf, roleOf: (req) => (req as AuthedRequest).session.role });

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
