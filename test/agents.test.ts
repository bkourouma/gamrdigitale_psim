import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { PHONE_COOKIE, createAgents, releaseAcknowledged } from '../server/agents.ts';
import { checkCredentials, createSession, createUser, getSession, parseCookies, setSessionValidator, useSessionStore } from '../server/auth.ts';
import { openDb } from '../server/db.ts';
import { PsimError, createEngine } from '../server/engine.ts';
import { createUsersService } from '../server/users.ts';
import type { MountContext, Role } from '../server/types.ts';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const KEY = Buffer.alloc(32, 5);
const PIN = '90817';
const status = (code: number) => (e: unknown) => e instanceof PsimError && e.status === code;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

// ------------------------------------------------------------------ montage d'un PSIM de test

interface Options {
  certPath?: string | null;
  secure?: boolean;
  live?: (cameraId: string) => void;
}

function setup(options: Options = {}) {
  const db = openDb(':memory:');
  const clock = { t: T0 };
  const engine = createEngine(db, () => {}, () => clock.t);
  const users = createUsersService({ db, key: KEY, now: () => clock.t, audit: (actor, action, ref) => engine.audit(actor, action, ref) });
  createUser(db, 'admin', 'admin', 'Mot-de-passe-admin-1', clock.t);
  createUser(db, 'oscar', 'operator', 'Mot-de-passe-oscar-1', clock.t);
  useSessionStore(db);
  setSessionValidator(users.validateSession);
  // Une zone = celle d'un equipement : deux detecteurs, une camera reelle liee au premier.
  engine.createDevice('admin', { id: 'D-HALL', kind: 'detector', name: 'Detecteur hall', zone: 'Hall', x: 10, y: 20 });
  engine.createDevice('admin', { id: 'D-PARK', kind: 'detector', name: 'Detecteur parking', zone: 'Parking', x: 30, y: 40 });
  engine.createDevice('admin', { id: 'D-NOZONE', kind: 'detector', name: 'Detecteur sans zone' });
  engine.createDevice('admin', { id: 'C-HALL', kind: 'camera', name: 'Camera hall', zone: 'Hall' });
  engine.createDevice('admin', { id: 'C-SIM', kind: 'camera', name: 'Camera simulee', zone: 'Hall' });
  engine.setLinks('admin', 'D-HALL', ['C-HALL', 'C-SIM']);
  db.prepare("INSERT INTO camera_source (device_id, kind, host, port) VALUES ('C-HALL', 'rtsp', '10.0.0.9', 554)").run();
  db.exec(`CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, zone TEXT NOT NULL DEFAULT '',
    floor_id INTEGER NOT NULL, x REAL NOT NULL DEFAULT 50, y REAL NOT NULL DEFAULT 50, code TEXT NOT NULL UNIQUE, archived_at INTEGER)`);
  const snapshots = new Map<number, Buffer>();
  const live: string[] = [];
  const agents = createAgents({
    db,
    engine,
    users,
    now: () => clock.t,
    certPath: options.certPath ?? null,
    readSnapshot: (id) => snapshots.get(id) ?? null,
    liveStream: (cameraId, res) => {
      live.push(cameraId);
      res.setHeader('Content-Type', 'text/plain');
      res.end(`FLUX ${cameraId}`);
    },
  });
  const floor = (db.prepare('SELECT id FROM floor ORDER BY position LIMIT 1').get() as { id: number }).id;
  const checkpoint = (name: string, zone = 'Parking', floorId = floor, x = 55, y = 65): number =>
    Number(db.prepare('INSERT INTO checkpoint (name, zone, floor_id, x, y, code) VALUES (?, ?, ?, ?, ?, ?)').run(name, zone, floorId, x, y, `code${name}`).lastInsertRowid);
  const auditRows = () => db.prepare('SELECT actor, action, details, incident_id, device_id FROM audit_log ORDER BY id').all() as { actor: string; action: string; details: string | null; incident_id: number | null; device_id: string | null }[];
  const actions = (action: string) => auditRows().filter((r) => r.action === action);
  const makeAgent = (username = 'moussa', extra: Record<string, unknown> = {}) =>
    agents.createAgent('admin', { username, displayName: `Agent ${username}`, pin: PIN, zones: [], ...extra });
  /** Un telephone appaire (pour les tests de service) : renvoie son numero. */
  const phone = (label = 'Telephone') => {
    const created = agents.createPhone('admin', label);
    return { id: agents.pairPhone(created.code).phone.id, created };
  };
  /** Session d'un agent sur un telephone (comme la route de connexion). */
  const session = (username: string, phoneId: number, ttlMs = 12 * HOUR) => {
    const opened = users.openSession(username);
    return createSession(username, 'agent', opened.epoch, null, clock.t, { ttlMs, phoneId });
  };
  const staffSession = (username: string) => {
    const opened = users.openSession(username);
    return createSession(username, opened.role, opened.epoch, null, clock.t);
  };
  return { db, clock, engine, users, agents, snapshots, live, floor, checkpoint, auditRows, actions, makeAgent, phone, session, staffSession, options };
}
type Harness = ReturnType<typeof setup>;

// ------------------------------------------------------------------ application Express de test + client HTTP

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

type Authed = Request & { session?: { username: string; role: Role } };

function listen(h: Harness): Promise<string> {
  const app = express();
  app.set('trust proxy', true);
  const guard = (...roles: Role[]) => (req: Request, res: Response, next: NextFunction) => {
    const s = getSession(parseCookies(req.headers.cookie).psim_session);
    if (!s) return void res.status(401).json({ error: 'Non authentifie' });
    if (!roles.includes(s.role)) return void res.status(403).json({ error: 'Droits insuffisants' });
    (req as Authed).session = s;
    next();
  };
  const ctx: MountContext = {
    sessionOf: (req) => getSession(parseCookies(req.headers.cookie).psim_session),
    adminOnly: guard('admin'),
    staff: guard('admin', 'operator'),
    actorOf: (req) => (req as Authed).session!.username,
    roleOf: (req) => (req as Authed).session!.role,
    json: (limit) => express.json({ limit }),
    cookieSecure: h.options.secure === true,
    originOf: () => 'https://psim.test',
  };
  h.agents.mount(app, ctx);
  app.use('/api', (_req, res) => void res.status(404).json({ error: 'Route inconnue' }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof PsimError) return void res.status(err.status).json({ error: err.message });
    const code = (err as { status?: number }).status;
    if (code === 413) return void res.status(413).json({ error: 'Contenu trop volumineux' });
    if (code && code >= 400 && code < 500) return void res.status(code).json({ error: 'Requete invalide' });
    console.error(err);
    res.status(500).json({ error: 'Erreur interne' });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    });
  });
}

let ipCounter = 0;
class Client {
  jar = new Map<string, string>();
  ip = `10.1.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
  base: string;
  constructor(base: string) {
    this.base = base;
  }
  async call(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { 'x-forwarded-for': this.ip };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload: string | undefined;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(this.base + path, { method, headers, body: payload });
    const setCookie = res.headers.getSetCookie();
    for (const c of setCookie) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (/Max-Age=0/i.test(c) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const raw = Buffer.from(await res.arrayBuffer());
    let json: Record<string, any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      json = null;
    }
    return { status: res.status, json, raw, headers: res.headers, setCookie };
  }
  get = (path: string) => this.call('GET', path);
  post = (path: string, body?: unknown) => this.call('POST', path, body ?? {});
}

/** PSIM de test + un client administrateur + un client operateur. */
async function web(options: Options = {}) {
  const h = setup(options);
  const base = await listen(h);
  const admin = new Client(base);
  admin.jar.set('psim_session', h.staffSession('admin'));
  const operator = new Client(base);
  operator.jar.set('psim_session', h.staffSession('oscar'));
  /** Telephone appaire par la procedure complete : l'administrateur cree le code, le telephone l'echange. */
  const pairedPhone = async (label = 'Telephone') => {
    const made = await admin.post('/api/agent-phones', { label });
    assert.equal(made.status, 201);
    const code = /#pair=([a-z2-7]{10})$/.exec(made.json!.pairUrl)![1];
    const client = new Client(base);
    const paired = await client.post('/api/agent/pair', { code });
    assert.equal(paired.status, 200, JSON.stringify(paired.json));
    return { client, id: made.json!.id as number, code };
  };
  const login = async (client: Client, username = 'moussa', pin = PIN) => client.post('/api/agent/login', { username, pin });
  return { h, base, admin, operator, pairedPhone, login };
}

// ================================================================== Service

describe('profils des agents', () => {
  it("un agent est un compte de role agent, avec son detecteur virtuel A-<identifiant> (personnes, non supervise)", () => {
    const h = setup();
    const view = h.makeAgent('moussa', { zones: ['Hall'], maxShiftMinutes: 600 });
    assert.deepEqual(view, {
      username: 'moussa',
      displayName: 'Agent moussa',
      zones: ['Hall'],
      locked: false,
      maxShiftMinutes: 600,
      active: true,
      shift: null,
      position: null,
    });
    assert.equal(h.users.get('moussa').role, 'agent');
    assert.equal(h.users.get('moussa').displayName, 'Agent moussa');
    const detector = h.engine.getDevice('A-moussa')!;
    assert.equal(detector.kind, 'detector');
    assert.equal(detector.category, 'people');
    assert.equal(detector.heartbeatS, 0);
    assert.equal(detector.name, 'Agent moussa');
    assert.equal(h.agents.isAgent('moussa'), true);
    assert.equal(h.agents.isAgent('admin'), false);
    assert.equal(h.agents.isAgent('inconnu'), false);
    assert.deepEqual(h.agents.zonesOf('moussa'), ['Hall']);
    assert.equal(h.agents.detectorId('moussa'), 'A-moussa');
  });

  it('durée de service par défaut : 720 minutes ; toutes les zones si la liste est vide', () => {
    const h = setup();
    const view = h.makeAgent('fanta');
    assert.equal(view.maxShiftMinutes, 720);
    assert.deepEqual(view.zones, []);
  });

  it('rejette un code personnel hors de 4 à 6 chiffres, à la création comme à la modification', () => {
    const h = setup();
    for (const pin of ['123', '1234567', 'abcd', '12 34', '12.45', 1234, null, undefined, ['1234'], '١٢٣٤']) {
      assert.throws(() => h.makeAgent('moussa', { pin }), status(400), `pin ${JSON.stringify(pin)}`);
    }
    h.makeAgent('moussa', { pin: '0042' });
    for (const pin of ['123', '1234567', 'abcd', 1234, null]) {
      assert.throws(() => h.agents.updateAgent('admin', 'moussa', { pin }), status(400));
    }
    assert.doesNotThrow(() => h.agents.updateAgent('admin', 'moussa', { pin: '123456' }));
    assert.doesNotThrow(() => h.agents.updateAgent('admin', 'moussa', { pin: '4321' }));
  });

  it('rejette les zones inconnues, la durée hors de 30 à 1440, un identifiant trop long ou invalide — sans rien écrire', () => {
    const h = setup();
    const users = () => (h.db.prepare('SELECT COUNT(*) AS n FROM app_user').get() as { n: number }).n;
    const before = users();
    assert.throws(() => h.makeAgent('moussa', { zones: ['Piscine'] }), (e) => status(400)(e) && /Piscine/.test((e as Error).message));
    assert.throws(() => h.makeAgent('moussa', { zones: 'Hall' }), status(400));
    assert.throws(() => h.makeAgent('moussa', { zones: [1] }), status(400));
    assert.throws(() => h.makeAgent('moussa', { zones: [''] }), status(400));
    assert.throws(() => h.makeAgent('moussa', { zones: Array.from({ length: 51 }, () => 'Hall') }), status(400));
    for (const maxShiftMinutes of [29, 1441, 0, -5, 90.5, '600', Number.NaN]) {
      assert.throws(() => h.makeAgent('moussa', { maxShiftMinutes }), status(400), String(maxShiftMinutes));
    }
    assert.throws(() => h.makeAgent('x'.repeat(31)), status(400));
    assert.throws(() => h.makeAgent('A B'), status(400));
    assert.throws(() => h.makeAgent('moussa', { displayName: '' }), status(400));
    assert.throws(() => h.makeAgent('moussa', { displayName: 'x'.repeat(81) }), status(400));
    assert.throws(() => h.makeAgent('moussa', { displayName: 'Moussa‮evil' }), status(400));
    assert.throws(() => h.agents.createAgent('admin', null as unknown as Record<string, unknown>), status(400));
    assert.equal(users(), before, 'aucun compte cree');
    assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM agent_profile').get() as { n: number }).n, 0);
    assert.equal(h.engine.getDevice('A-moussa'), null, 'aucun detecteur cree');
    // 30 caracteres : accepte (le detecteur A-<id> tient dans 32).
    assert.doesNotThrow(() => h.makeAgent('y'.repeat(30)));
  });

  it("refuse un identifiant déjà pris (409), y compris par un autre rôle ; les zones des détecteurs d'agents comptent aussi", () => {
    const h = setup();
    h.makeAgent('moussa');
    assert.throws(() => h.makeAgent('moussa'), status(409));
    assert.throws(() => h.makeAgent('oscar'), status(409));
    assert.throws(() => h.makeAgent('admin'), status(409));
  });

  it('un compte agent ne peut pas ouvrir une session avec un mot de passe (mot de passe aléatoire inutilisable)', () => {
    const h = setup();
    h.makeAgent('moussa');
    for (const pw of [PIN, 'moussa', '', 'Mot-de-passe-admin-1']) assert.equal(checkCredentials(h.db, 'moussa', pw), null);
  });

  it('le code personnel est haché (scrypt, sel propre) : jamais en clair, deux agents au même code ont des empreintes différentes', () => {
    const h = setup();
    h.makeAgent('moussa');
    h.makeAgent('fanta');
    const hashes = (h.db.prepare('SELECT pin_hash FROM agent_profile ORDER BY username').all() as { pin_hash: string }[]).map((r) => r.pin_hash);
    for (const stored of hashes) {
      assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
      assert.ok(!stored.includes(PIN));
    }
    assert.notEqual(hashes[0], hashes[1]);
  });

  it('modifie le nom (compte, profil et détecteur), les zones, la durée ; le code seulement si demandé ; erreurs sans effet partiel', () => {
    const h = setup();
    h.makeAgent('moussa');
    const view = h.agents.updateAgent('admin', 'MOUSSA', { displayName: 'Moussa Camara', zones: ['Hall', 'Parking', 'Hall'], maxShiftMinutes: 480 });
    assert.equal(view.displayName, 'Moussa Camara');
    assert.deepEqual(view.zones, ['Hall', 'Parking']);
    assert.equal(view.maxShiftMinutes, 480);
    assert.equal(h.users.get('moussa').displayName, 'Moussa Camara');
    assert.equal(h.engine.getDevice('A-moussa')!.name, 'Moussa Camara');
    // Un patch invalide n'applique rien, meme les champs valides.
    assert.throws(() => h.agents.updateAgent('admin', 'moussa', { displayName: 'Autre', maxShiftMinutes: 5 }), status(400));
    assert.equal(h.agents.listAgents()[0].displayName, 'Moussa Camara');
    assert.throws(() => h.agents.updateAgent('admin', 'inconnu', { displayName: 'x' }), status(404));
    assert.throws(() => h.agents.updateAgent('admin', 'oscar', { displayName: 'x' }), status(404), 'un operateur n\'est pas un agent');
    assert.throws(() => h.agents.updateAgent('admin', 'moussa', { unlock: 'oui' }), status(400));
    // La modification est journalisee, sans la valeur du code.
    h.agents.updateAgent('admin', 'moussa', { pin: '246810' });
    const updates = h.actions('agent_updated');
    assert.ok(updates.some((r) => /code personnel/.test(r.details ?? '')));
    assert.ok(updates.every((r) => !(r.details ?? '').includes('246810')));
  });

  it('la liste des agents indique le verrou, le service et la position', () => {
    const h = setup();
    h.makeAgent('moussa');
    h.makeAgent('fanta');
    const p = h.phone();
    h.agents.startShift('moussa', p.id);
    const cp = h.checkpoint('Portail');
    h.agents.setPosition('moussa', cp, T0 + 5);
    const [fanta, moussa] = h.agents.listAgents();
    assert.equal(fanta.username, 'fanta');
    assert.equal(fanta.shift, null);
    assert.equal(moussa.shift!.startedAt, T0);
    assert.equal(moussa.shift!.endsAt, T0 + 720 * MIN);
    assert.deepEqual(moussa.position, { checkpointId: cp, name: 'Portail', at: T0 + 5 });
  });
});

describe('connexion et verrou', () => {
  it('un bon code ouvre : durée = durée de service, audit agent_login, compteur remis à zéro', () => {
    const h = setup();
    h.makeAgent('moussa', { maxShiftMinutes: 300 });
    const p = h.phone();
    assert.throws(() => h.agents.login(p.id, 'moussa', '0000'), status(401));
    assert.throws(() => h.agents.login(p.id, 'moussa', '1111'), status(401));
    const opened = h.agents.login(p.id, 'Moussa ', PIN);
    assert.equal(opened.username, 'moussa');
    assert.equal(opened.ttlMs, 300 * MIN);
    assert.equal(opened.role, 'agent');
    assert.equal(opened.epoch, h.users.openSession('moussa').epoch);
    assert.equal(h.actions('agent_login').length, 1);
    // Compteur remis a zero : quatre nouveaux codes faux ne verrouillent pas.
    for (let i = 0; i < 4; i++) assert.throws(() => h.agents.login(p.id, 'moussa', '0000'), status(401));
    assert.equal(h.agents.listAgents()[0].locked, false);
  });

  it('nom inconnu, code faux, compte non-agent, compte désactivé : la même réponse 401', () => {
    const h = setup();
    h.makeAgent('moussa');
    h.makeAgent('fanta');
    h.agents.disableAgent('admin', 'fanta');
    const p = h.phone();
    const messages = new Set<string>();
    for (const [name, pin] of [['moussa', '0000'], ['inconnu', PIN], ['oscar', PIN], ['admin', PIN], ['fanta', PIN], ['', ''], [{ a: 1 }, PIN], ['moussa', { pin: 1 }], ['moussa', null], ['moussa', undefined], [undefined, undefined]] as [unknown, unknown][]) {
      assert.throws(() => h.agents.login(p.id, name, pin), (e) => {
        assert.ok(e instanceof PsimError);
        assert.equal(e.status, 401);
        messages.add(e.message);
        return true;
      });
    }
    assert.equal(messages.size, 1, 'un seul message');
  });

  it("cinq codes faux verrouillent (423), même avec le bon code ensuite ; l'administrateur déverrouille", () => {
    const h = setup();
    h.makeAgent('moussa');
    const p = h.phone();
    for (let i = 1; i <= 4; i++) assert.throws(() => h.agents.login(p.id, 'moussa', '0000'), status(401));
    assert.throws(() => h.agents.login(p.id, 'moussa', '0000'), status(423), 'le cinquieme echec verrouille');
    assert.equal(h.agents.listAgents()[0].locked, true);
    assert.throws(() => h.agents.login(p.id, 'moussa', PIN), status(423), 'bon code, mais verrouille');
    assert.deepEqual(h.agents.phoneAgents(), [{ username: 'moussa', displayName: 'Agent moussa', locked: true }]);
    assert.equal(h.actions('agent_locked').length, 1);
    assert.equal(h.actions('agent_login_failed').length, 5, 'un echec journalise par essai, pas de journal pour les essais sur un compte verrouille');
    // Les essais sur compte verrouille n'encombrent pas le journal.
    for (let i = 0; i < 20; i++) assert.throws(() => h.agents.login(p.id, 'moussa', '0000'), status(423));
    assert.equal(h.actions('agent_login_failed').length, 5);
    const view = h.agents.updateAgent('admin', 'moussa', { unlock: true });
    assert.equal(view.locked, false);
    assert.equal(h.actions('agent_unlocked').length, 1);
    assert.equal(h.agents.login(p.id, 'moussa', PIN).username, 'moussa');
    // Le compteur est reparti de zero.
    for (let i = 0; i < 4; i++) assert.throws(() => h.agents.login(p.id, 'moussa', '0000'), status(401));
  });

  it("un administrateur qui déverrouille un agent non verrouillé ne laisse pas d'entrée d'audit, mais remet les essais à zéro", () => {
    const h = setup();
    h.makeAgent('moussa');
    const p = h.phone();
    for (let i = 0; i < 4; i++) assert.throws(() => h.agents.login(p.id, 'moussa', '0000'), status(401));
    h.agents.updateAgent('admin', 'moussa', { unlock: true });
    assert.equal(h.actions('agent_unlocked').length, 0);
    for (let i = 0; i < 4; i++) assert.throws(() => h.agents.login(p.id, 'moussa', '0000'), status(401));
    assert.equal(h.agents.listAgents()[0].locked, false);
  });

  it("le journal ne contient jamais le code personnel (ni le bon, ni les faux)", () => {
    const h = setup();
    h.makeAgent('moussa', { pin: '734912' });
    const p = h.phone();
    assert.throws(() => h.agents.login(p.id, 'moussa', '556677'), status(401));
    h.agents.login(p.id, 'moussa', '734912');
    const all = JSON.stringify(h.auditRows());
    for (const secret of ['734912', '556677']) assert.ok(!all.includes(secret), secret);
  });

  it("un nom inconnu n'encombre pas le journal : une entrée par minute au plus", () => {
    const h = setup();
    const p = h.phone();
    for (let i = 0; i < 30; i++) assert.throws(() => h.agents.login(p.id, `fantome${i}`, PIN), status(401));
    assert.equal(h.actions('agent_login_failed').length, 1);
    h.clock.t += 61_000;
    assert.throws(() => h.agents.login(p.id, 'fantome', PIN), status(401));
    assert.equal(h.actions('agent_login_failed').length, 2);
    assert.ok(h.actions('agent_login_failed').every((r) => r.actor === '?'));
  });

  it("les agents proposés sur un téléphone sont les comptes actifs seulement", () => {
    const h = setup();
    h.makeAgent('moussa');
    h.makeAgent('fanta');
    h.agents.disableAgent('admin', 'fanta');
    assert.deepEqual(h.agents.phoneAgents().map((a) => a.username), ['moussa']);
    assert.equal(h.agents.listAgents().find((a) => a.username === 'fanta')!.active, false);
  });
});

describe('telephones appaires', () => {
  it("code d'appairage : 10 caractères base32, valable 15 minutes, usage unique, stocké haché", () => {
    const h = setup();
    const created = h.agents.createPhone('admin', 'Telephone du poste');
    assert.match(created.code, /^[a-z2-7]{10}$/);
    assert.equal(created.expiresAt, T0 + 15 * MIN);
    const row = h.db.prepare('SELECT pair_hash FROM agent_phone WHERE id = ?').get(created.id) as { pair_hash: string };
    assert.equal(row.pair_hash, createHash('sha256').update(created.code).digest('hex'));
    assert.deepEqual(h.agents.listPhones().map((p) => p.pending), [true]);
    const paired = h.agents.pairPhone(created.code);
    assert.equal(paired.phone.id, created.id);
    assert.equal(paired.phone.label, 'Telephone du poste');
    assert.match(paired.key, new RegExp(`^pph_${created.id}_[A-Za-z0-9_-]{43}$`));
    assert.throws(() => h.agents.pairPhone(created.code), (e) => status(401)(e) && /invalide ou expire/.test((e as Error).message), 'usage unique');
    const view = h.agents.listPhones()[0];
    assert.equal(view.pending, false);
    assert.equal(view.pairedAt, T0);
    assert.equal(view.revokedAt, null);
  });

  it("l'empreinte stockée est celle de la clé ; la clé n'est stockée nulle part et le code d'appairage est effacé", () => {
    const h = setup();
    const { id } = h.phone();
    const created = h.agents.createPhone('admin', 'Autre');
    const key = h.agents.pairPhone(created.code).key;
    const row = h.db.prepare('SELECT * FROM agent_phone WHERE id = ?').get(created.id) as Record<string, unknown>;
    assert.equal(row.key_hash, createHash('sha256').update(key).digest('hex'));
    assert.equal(row.pair_hash, null);
    assert.equal(row.pair_expires_at, null);
    assert.ok(!JSON.stringify(row).includes(key));
    assert.ok(id > 0);
  });

  it("un code expiré (plus de 15 minutes), mal formé, inconnu ou de mauvais type est refusé ; à 15 minutes pile il passe encore", () => {
    const h = setup();
    const a = h.agents.createPhone('admin', 'A');
    const b = h.agents.createPhone('admin', 'B');
    h.clock.t += 15 * MIN;
    assert.doesNotThrow(() => h.agents.pairPhone(a.code));
    h.clock.t += 1;
    assert.throws(() => h.agents.pairPhone(b.code), status(401));
    for (const bad of ['', 'abc', 'ABCDEFGHIJ', 'aaaaaaaaaa', '0123456789', 'x'.repeat(10_000), null, undefined, 12, {}, [], b.code + 'z']) {
      assert.throws(() => h.agents.pairPhone(bad), status(401));
    }
  });

  it("le code est insensible à la casse et aux espaces autour (saisie manuelle)", () => {
    const h = setup();
    const created = h.agents.createPhone('admin', 'A');
    assert.equal(h.agents.pairPhone(`  ${created.code.toUpperCase()} `).phone.id, created.id);
  });

  it("un code d'appairage d'un téléphone révoqué avant usage ne marche plus", () => {
    const h = setup();
    const created = h.agents.createPhone('admin', 'A');
    h.agents.revokePhone('admin', created.id);
    assert.throws(() => h.agents.pairPhone(created.code), status(401));
    assert.equal(h.agents.listPhones()[0].pending, false);
  });

  it('valide le libellé et plafonne les appairages en attente et les téléphones actifs', () => {
    const h = setup();
    for (const label of ['', '   ', 'x'.repeat(81), 'a\nb', 'a‮b', 12, null, undefined]) assert.throws(() => h.agents.createPhone('admin', label), status(400));
    for (let i = 0; i < 20; i++) h.agents.createPhone('admin', `T${i}`);
    assert.throws(() => h.agents.createPhone('admin', 'de trop'), status(409));
    h.clock.t += 16 * MIN; // les codes ont expire
    assert.doesNotThrow(() => h.agents.createPhone('admin', 'ok'));
  });

  it('checkPhone : clé valide, sans jamais lever d’exception pour une clé absente, mal formée, inconnue ou d’un autre téléphone', () => {
    const h = setup();
    const a = h.agents.createPhone('admin', 'A');
    const keyA = h.agents.pairPhone(a.code).key;
    const b = h.agents.createPhone('admin', 'B');
    const keyB = h.agents.pairPhone(b.code).key;
    assert.deepEqual(h.agents.checkPhone(keyA), { id: a.id, label: 'A' });
    assert.deepEqual(h.agents.checkPhone(keyB), { id: b.id, label: 'B' });
    const forged = `pph_${a.id}_${keyB.split('_').pop()}`; // numero de A, secret de B
    const wrongSecret = `pph_${a.id}_${'A'.repeat(43)}`;
    const unknownId = `pph_9999_${'A'.repeat(43)}`;
    const pending = h.agents.createPhone('admin', 'pas encore appaire');
    const notPaired = `pph_${pending.id}_${'A'.repeat(43)}`;
    for (const bad of [forged, wrongSecret, unknownId, notPaired, '', 'pph_', `pph_${a.id}_court`, `${keyA}x`, ` ${keyA}`, keyA.toUpperCase(), 'psk_1_' + 'A'.repeat(43), undefined, null, 5, {}, [], 'x'.repeat(100_000), `pph_${a.id}_${'é'.repeat(43)}`, 'pph_99999999999999_' + 'A'.repeat(43)]) {
      assert.equal(h.agents.checkPhone(bad), null, String(bad).slice(0, 40));
    }
  });

  it("une clé révoquée est refusée partout, y compris la clé qui était valable avant", () => {
    const h = setup();
    const created = h.agents.createPhone('admin', 'A');
    const key = h.agents.pairPhone(created.code).key;
    assert.ok(h.agents.checkPhone(key));
    h.agents.revokePhone('admin', created.id);
    assert.equal(h.agents.checkPhone(key), null);
    assert.equal(h.actions('agent_phone_revoked').length, 1);
    h.agents.revokePhone('admin', created.id); // idempotent
    assert.equal(h.actions('agent_phone_revoked').length, 1, 'pas de seconde entree');
    assert.throws(() => h.agents.revokePhone('admin', 9999), status(404));
    for (const bad of ['abc', '0', '-1', '1; DROP TABLE agent_phone', {}, null, undefined]) assert.throws(() => h.agents.revokePhone('admin', bad), status(404));
  });

  it("last_seen_at suit la dernière requête, écrit au plus toutes les 20 secondes", () => {
    const h = setup();
    const created = h.agents.createPhone('admin', 'A');
    const key = h.agents.pairPhone(created.code).key;
    const seen = () => h.agents.listPhones()[0].lastSeenAt;
    assert.equal(seen(), T0);
    h.clock.t += 5_000;
    h.agents.checkPhone(key);
    assert.equal(seen(), T0, 'trop tot');
    h.clock.t += 15_000;
    h.agents.checkPhone(key);
    assert.equal(seen(), T0 + 20_000);
    h.agents.checkPhone('pph_1_' + 'A'.repeat(43)); // un refus ne met rien a jour
    assert.equal(seen(), T0 + 20_000);
  });

  it("le journal ne contient ni clé de téléphone ni code d'appairage", () => {
    const h = setup();
    const created = h.agents.createPhone('admin', 'Poste');
    const { key } = h.agents.pairPhone(created.code);
    h.agents.revokePhone('admin', created.id);
    const all = JSON.stringify(h.auditRows());
    assert.ok(!all.includes(created.code));
    assert.ok(!all.includes(key));
    assert.ok(!all.includes(key.split('_').pop()!));
    assert.deepEqual(h.auditRows().map((r) => r.action).filter((a) => a.startsWith('agent_phone')), ['agent_phone_created', 'agent_phone_paired', 'agent_phone_revoked']);
  });

  it('révoquer un téléphone ferme SES sessions et SES services (raison revoked), pas ceux des autres', () => {
    const h = setup();
    h.makeAgent('moussa');
    h.makeAgent('fanta');
    const a = h.phone('A');
    const b = h.phone('B');
    const tokenA = h.session('moussa', a.id);
    const tokenB = h.session('fanta', b.id);
    h.agents.startShift('moussa', a.id);
    h.agents.startShift('fanta', b.id);
    h.agents.setPosition('moussa', h.checkpoint('P1'), T0);
    assert.ok(getSession(tokenA));
    h.agents.revokePhone('admin', a.id);
    assert.equal(getSession(tokenA), null);
    assert.ok(getSession(tokenB), 'la session de l\'autre telephone survit');
    const ended = h.db.prepare('SELECT username, end_reason FROM agent_shift WHERE ended_at IS NOT NULL').all().map((r) => ({ ...r })) as { username: string; end_reason: string }[];
    assert.deepEqual(ended, [{ username: 'moussa', end_reason: 'revoked' }]);
    assert.equal(h.agents.listAgents().find((x) => x.username === 'fanta')!.shift !== null, true);
    assert.equal(h.agents.listAgents().find((x) => x.username === 'moussa')!.position, null);
    assert.equal(h.actions('agent_shift_ended').length, 1);
  });
});

describe('service', () => {
  it("prise de service : fin prévue = début + durée max ; idempotente sur le même téléphone", () => {
    const h = setup();
    h.makeAgent('moussa', { maxShiftMinutes: 60 });
    const p = h.phone();
    const me = h.agents.startShift('moussa', p.id);
    assert.deepEqual(me.shift, { id: 1, startedAt: T0, endsAt: T0 + 60 * MIN });
    h.clock.t += 10 * MIN;
    const again = h.agents.startShift('moussa', p.id);
    assert.deepEqual(again.shift, me.shift, 'la fin prevue ne glisse pas');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM agent_shift').get()!.n, 1);
    assert.equal(h.actions('agent_shift_started').length, 1);
    assert.deepEqual(h.agents.onShift(), [{ username: 'moussa', displayName: 'Agent moussa' }]);
  });

  it("un seul service ouvert par agent : en ouvrir un sur un autre téléphone ferme l'ancien (raison agent)", () => {
    const h = setup();
    h.makeAgent('moussa');
    const a = h.phone('A');
    const b = h.phone('B');
    h.agents.startShift('moussa', a.id);
    h.clock.t += MIN;
    const me = h.agents.startShift('moussa', b.id);
    assert.equal(me.shift!.id, 2);
    const rows = h.db.prepare('SELECT id, phone_id, end_reason FROM agent_shift ORDER BY id').all().map((r) => ({ ...r })) as { id: number; phone_id: number; end_reason: string | null }[];
    assert.deepEqual(rows, [{ id: 1, phone_id: a.id, end_reason: 'agent' }, { id: 2, phone_id: b.id, end_reason: null }]);
    assert.equal(h.agents.onShift().length, 1);
  });

  it("fin de service par l'agent : position effacée, sessions du compte fermées, audit", () => {
    const h = setup();
    h.makeAgent('moussa');
    const p = h.phone();
    const token = h.session('moussa', p.id);
    h.agents.startShift('moussa', p.id);
    h.agents.setPosition('moussa', h.checkpoint('P1'), T0);
    h.clock.t += 30 * MIN;
    h.agents.endShift('moussa', 'agent');
    assert.equal(getSession(token), null);
    assert.equal(h.agents.me('moussa').shift, null);
    assert.equal(h.agents.me('moussa').position, null);
    assert.deepEqual(h.agents.positions(), []);
    const [entry] = h.actions('agent_shift_ended');
    assert.equal(entry.actor, 'moussa');
    assert.match(entry.details!, /raison agent, 30 min/);
    h.agents.endShift('moussa', 'agent'); // sans service : sans effet
    assert.equal(h.actions('agent_shift_ended').length, 1);
  });

  it("fin automatique dans tick() : à l'échéance seulement, raison timeout, sessions fermées, position effacée", () => {
    const h = setup();
    h.makeAgent('moussa', { maxShiftMinutes: 30 });
    h.makeAgent('fanta', { maxShiftMinutes: 90 });
    const p = h.phone();
    const tokenM = h.session('moussa', p.id);
    const tokenF = h.session('fanta', p.id);
    h.agents.startShift('moussa', p.id);
    h.agents.startShift('fanta', p.id);
    h.agents.setPosition('moussa', h.checkpoint('P1'), T0);
    h.clock.t = T0 + 30 * MIN - 1;
    h.agents.tick();
    assert.ok(h.agents.me('moussa').shift, 'pas encore');
    h.clock.t = T0 + 30 * MIN;
    h.agents.tick();
    assert.equal(h.agents.me('moussa').shift, null);
    assert.ok(h.agents.me('fanta').shift);
    assert.equal(getSession(tokenM), null);
    assert.ok(getSession(tokenF));
    assert.equal(h.agents.me('moussa').position, null);
    assert.equal((h.db.prepare('SELECT end_reason FROM agent_shift WHERE username = ?').get('moussa') as { end_reason: string }).end_reason, 'timeout');
    const [entry] = h.actions('agent_shift_ended');
    assert.equal(entry.actor, 'systeme');
    h.agents.tick(); // repeter ne refait rien
    assert.equal(h.actions('agent_shift_ended').length, 1);
  });

  it("tick() ferme aussi le service d'un agent désactivé depuis l'écran des comptes", () => {
    const h = setup();
    h.makeAgent('moussa');
    const p = h.phone();
    h.agents.startShift('moussa', p.id);
    h.users.update('admin', 'moussa', { active: false });
    h.agents.tick();
    assert.equal(h.db.prepare('SELECT end_reason FROM agent_shift').get()!.end_reason, 'admin');
  });

  it("desactiver un agent : compte inactif, service terminé (admin), sessions fermées, traces conservées", () => {
    const h = setup();
    h.makeAgent('moussa');
    const p = h.phone();
    const token = h.session('moussa', p.id);
    h.agents.startShift('moussa', p.id);
    h.agents.disableAgent('admin', 'moussa');
    assert.equal(h.users.get('moussa').active, false);
    assert.equal(getSession(token), null);
    assert.equal(h.agents.me('moussa').shift, null);
    assert.equal(h.db.prepare('SELECT end_reason FROM agent_shift').get()!.end_reason, 'admin');
    assert.throws(() => h.agents.login(p.id, 'moussa', PIN), status(401));
    assert.throws(() => h.agents.startShift('moussa', p.id), status(403));
    assert.equal(h.agents.listAgents().length, 1, 'le profil reste');
    assert.equal(h.actions('agent_disabled').length, 1);
    assert.throws(() => h.agents.disableAgent('admin', 'inconnu'), status(404));
    assert.throws(() => h.agents.disableAgent('admin', 'oscar'), status(404), 'seuls les agents se desactivent ici');
    h.agents.disableAgent('admin', 'moussa'); // idempotent
  });

  it("fin de service forcée par l'administrateur : raison admin, acteur admin, sessions fermées", () => {
    const h = setup();
    h.makeAgent('moussa');
    const p = h.phone();
    const token = h.session('moussa', p.id);
    h.agents.startShift('moussa', p.id);
    h.agents.endShiftByAdmin('admin', 'moussa');
    assert.equal(getSession(token), null);
    assert.equal(h.db.prepare('SELECT end_reason FROM agent_shift').get()!.end_reason, 'admin');
    assert.equal(h.actions('agent_shift_ended')[0].actor, 'admin');
    assert.throws(() => h.agents.endShiftByAdmin('admin', 'inconnu'), status(404));
    h.agents.endShiftByAdmin('admin', 'moussa'); // pas en service : sans erreur
  });

  it("la position n'est gardée que pendant le service, et seuls les agents en service figurent dans positions()", () => {
    const h = setup();
    h.makeAgent('moussa');
    h.makeAgent('fanta');
    const p = h.phone();
    const cp = h.checkpoint('Portail');
    h.agents.setPosition('moussa', cp, T0); // hors service : sans effet
    assert.deepEqual(h.agents.positions(), []);
    h.agents.startShift('moussa', p.id);
    h.agents.startShift('fanta', p.id);
    h.agents.setPosition('moussa', cp, T0 + 1);
    h.agents.setPosition('moussa', h.checkpoint('Cour'), T0 + 2);
    assert.deepEqual(h.agents.positions(), [{ username: 'moussa', displayName: 'Agent moussa', checkpointId: 2, at: T0 + 2 }]);
    assert.equal(h.agents.me('moussa').position!.name, 'Cour');
    h.agents.endShift('moussa', 'agent');
    assert.deepEqual(h.agents.positions(), []);
  });

  it("une position sur un point disparu reste lisible (nom de repli)", () => {
    const h = setup();
    h.makeAgent('moussa');
    const p = h.phone();
    h.agents.startShift('moussa', p.id);
    h.agents.setPosition('moussa', 4242, T0);
    assert.equal(h.agents.me('moussa').position!.name, 'Point 4242');
  });
});

describe('alarmes et zones', () => {
  it("l'agent ne voit que les incidents de ses zones ; sans zone = toutes ; incident sans zone = tous", () => {
    const h = setup();
    h.makeAgent('hall', { zones: ['Hall'] });
    h.makeAgent('park', { zones: ['Parking'] });
    h.makeAgent('tous', { zones: [] });
    h.engine.handleDetectorMessage('D-HALL', { state: 'alarm' });
    h.engine.handleDetectorMessage('D-PARK', { state: 'prealarm' });
    h.engine.handleDetectorMessage('D-NOZONE', { state: 'alarm' });
    const zones = (u: string) => h.agents.alarms(u).map((a) => a.zone).sort();
    assert.deepEqual(zones('hall'), ['', 'Hall']);
    assert.deepEqual(zones('park'), ['', 'Parking']);
    assert.deepEqual(zones('tous'), ['', 'Hall', 'Parking']);
  });

  it("forme d'une alarme : titre = motif nommé ou catégorie, détail, nom, zone, étage, image et direct", () => {
    const h = setup();
    h.makeAgent('moussa');
    h.engine.handleDetectorMessage('D-HALL', { event: 'tamper', detail: 'Capot ouvert' });
    const incidentId = h.agents.alarms('moussa')[0].id;
    h.db.prepare("INSERT INTO incident_snapshot (incident_id, camera_id, taken_at, reason, file) VALUES (?, 'C-HALL', ?, 'opened', 'x.jpg')").run(incidentId, T0);
    h.engine.handleDetectorMessage('D-PARK', { state: 'alarm' });
    const alarms = h.agents.alarms('moussa');
    const hall = alarms.find((a) => a.zone === 'Hall')!;
    const park = alarms.find((a) => a.zone === 'Parking')!;
    assert.deepEqual(
      { ...hall, openedAt: 0 },
      {
        id: incidentId,
        severity: 'critical',
        title: 'Sabotage du détecteur',
        detail: 'Capot ouvert',
        deviceName: 'Detecteur hall',
        zone: 'Hall',
        floorName: hall.floorName,
        openedAt: 0,
        acknowledged: false,
        acknowledgedBy: null,
        hasSnapshot: true,
        hasLive: true,
        dispatch: [],
      },
    );
    assert.ok(hall.floorName.length > 0);
    assert.equal(park.title, 'Incendie', 'sans evenement : le libelle de la categorie');
    assert.equal(park.detail, '');
    assert.equal(park.hasSnapshot, false);
    assert.equal(park.hasLive, false);
  });

  it("une caméra simulée (sans source vidéo réelle) ne donne pas de direct", () => {
    const h = setup();
    h.makeAgent('moussa');
    h.db.prepare("DELETE FROM camera_source WHERE device_id = 'C-HALL'").run();
    h.engine.handleDetectorMessage('D-HALL', { state: 'alarm' });
    const [alarm] = h.agents.alarms('moussa');
    assert.equal(alarm.hasLive, false);
    assert.throws(() => h.agents.liveCameraFor('moussa', alarm.id), status(404));
  });

  it("tri : le plus grave d'abord, puis le plus ancien ; les incidents clos n'apparaissent pas", () => {
    const h = setup();
    h.makeAgent('moussa');
    h.engine.handleDetectorMessage('D-PARK', { state: 'prealarm' });
    h.clock.t += MIN;
    h.engine.handleDetectorMessage('D-NOZONE', { state: 'alarm' });
    h.clock.t += MIN;
    h.engine.handleDetectorMessage('D-HALL', { state: 'alarm' });
    assert.deepEqual(h.agents.alarms('moussa').map((a) => a.zone), ['', 'Hall', 'Parking']);
    assert.deepEqual(h.agents.alarms('moussa').map((a) => a.severity), ['critical', 'critical', 'warning']);
    h.engine.handleDetectorMessage('D-HALL', { state: 'normal' });
    h.engine.close(h.agents.alarms('moussa')[1].id, 'oscar', 'false_alarm', '');
    assert.deepEqual(h.agents.alarms('moussa').map((a) => a.zone), ['', 'Parking']);
  });

  it("acquittement : l'acteur est l'agent ; hors zone, inexistant ou clos = 404 ; déjà acquitté = 409", () => {
    const h = setup();
    h.makeAgent('hall', { zones: ['Hall'] });
    h.makeAgent('park', { zones: ['Parking'] });
    h.engine.handleDetectorMessage('D-HALL', { state: 'alarm' });
    const id = h.agents.alarms('hall')[0].id;
    assert.throws(() => h.agents.ackAlarm('park', id), status(404), 'hors de ses zones');
    assert.throws(() => h.agents.ackAlarm('hall', 9999), status(404));
    h.agents.ackAlarm('hall', id);
    const acked = h.engine.incidentView(id);
    assert.equal(acked.status, 'acknowledged');
    assert.equal(acked.ackedBy, 'hall');
    assert.deepEqual(h.agents.alarms('hall')[0].acknowledged, true);
    assert.equal(h.agents.alarms('hall')[0].acknowledgedBy, 'Agent hall', "le nom affiché de l'agent, pas son identifiant");
    assert.throws(() => h.agents.ackAlarm('hall', id), status(409));
    assert.equal(h.actions('incident_acked')[0].actor, 'hall');
    // L'agent ne cloture jamais : aucune methode de qualification n'est exposee.
    assert.equal('closeAlarm' in h.agents, false);
  });

  it("« J'y vais » / « Sur place » : dernier statut par agent et incident, journalisé à chaque changement, validé", () => {
    const h = setup();
    h.makeAgent('hall', { zones: ['Hall'] });
    h.makeAgent('tous');
    h.makeAgent('park', { zones: ['Parking'] });
    h.engine.handleDetectorMessage('D-HALL', { state: 'alarm' });
    const id = h.agents.alarms('hall')[0].id;
    for (const status_ of ['', 'arrive', 'EN_ROUTE', null, 3, undefined, {}]) assert.throws(() => h.agents.dispatch('hall', id, status_), status(400));
    assert.throws(() => h.agents.dispatch('park', id, 'en_route'), status(404));
    assert.throws(() => h.agents.dispatch('hall', 9999, 'en_route'), status(404));
    h.agents.dispatch('hall', id, 'en_route');
    h.clock.t += MIN;
    h.agents.dispatch('tous', id, 'en_route');
    h.clock.t += MIN;
    h.agents.dispatch('hall', id, 'en_route'); // meme statut : rien ne change
    assert.equal(h.actions('agent_dispatch').length, 2);
    h.agents.dispatch('hall', id, 'on_site');
    const rows = h.db.prepare('SELECT username, status FROM agent_dispatch ORDER BY id').all().map((r) => ({ ...r })) as { username: string; status: string }[];
    assert.deepEqual(rows, [{ username: 'hall', status: 'on_site' }, { username: 'tous', status: 'en_route' }], 'une ligne par agent et par incident');
    assert.deepEqual(h.agents.dispatchesOf(id).map((d) => [d.username, d.displayName, d.status]), [['tous', 'Agent tous', 'en_route'], ['hall', 'Agent hall', 'on_site']]);
    assert.equal(h.agents.alarms('hall')[0].dispatch.length, 2);
    const audits = h.actions('agent_dispatch');
    assert.deepEqual(audits.map((r) => [r.actor, r.details, r.incident_id]), [['hall', 'en_route', id], ['tous', 'en_route', id], ['hall', 'on_site', id]]);
  });

  it("le SOS d'un collègue (détecteur A-*, événement sos) est visible de tous les agents, quelle que soit leur zone", () => {
    const h = setup();
    h.makeAgent('hall', { zones: ['Hall'] });
    h.makeAgent('park', { zones: ['Parking'] });
    const p = h.phone();
    const cp = h.checkpoint('Barriere', 'Parking');
    h.agents.startShift('park', p.id);
    h.agents.setPosition('park', cp, T0);
    const { incidentId } = h.agents.sos('park', p.id, { clientId: 'sos-0000-0001', phoneAt: T0, discreet: false });
    assert.deepEqual(h.agents.alarms('hall').map((a) => a.id), [incidentId], 'vu de l\'agent du hall');
    assert.deepEqual(h.agents.alarms('park').map((a) => a.id), [incidentId]);
    h.agents.ackAlarm('hall', incidentId);
    h.agents.dispatch('hall', incidentId, 'en_route');
    assert.equal(h.agents.alarms('park')[0].dispatch[0].username, 'hall');
    // Mais un signalement a la main courante (logbook_report, meme detecteur) n'est PAS un SOS : il suit les zones.
  });

  it("un signalement de main courante sur un détecteur d'agent suit les zones de l'agent (seul le SOS est visible de tous)", () => {
    const h = setup();
    h.makeAgent('hall', { zones: ['Hall'] });
    h.makeAgent('park', { zones: ['Parking'] });
    h.engine.updateDevice('admin', 'A-park', { zone: 'Parking' });
    h.engine.handleDetectorMessage('A-park', { event: 'logbook_report', detail: 'anomalie : porte ouverte' });
    assert.equal(h.agents.alarms('hall').length, 0);
    assert.equal(h.agents.alarms('park').length, 1);
    assert.equal(h.agents.alarms('park')[0].title, "Signalement d'un agent");
  });

  it("image : la dernière image de l'incident ; 404 sans image, sans lecteur ou hors zone", () => {
    const h = setup();
    h.makeAgent('hall', { zones: ['Hall'] });
    h.makeAgent('park', { zones: ['Parking'] });
    h.engine.handleDetectorMessage('D-HALL', { state: 'alarm' });
    const id = h.agents.alarms('hall')[0].id;
    assert.throws(() => h.agents.snapshotFor('hall', id), status(404), 'pas d\'image');
    const insert = h.db.prepare("INSERT INTO incident_snapshot (incident_id, camera_id, taken_at, reason, file) VALUES (?, 'C-HALL', ?, 'opened', 'x.jpg')");
    const first = Number(insert.run(id, T0).lastInsertRowid);
    const last = Number(insert.run(id, T0 + 1).lastInsertRowid);
    h.snapshots.set(first, Buffer.from('ancienne'));
    h.snapshots.set(last, JPEG);
    assert.deepEqual(h.agents.snapshotFor('hall', id), JPEG);
    assert.throws(() => h.agents.snapshotFor('park', id), status(404), 'hors zone');
    h.snapshots.delete(last);
    assert.throws(() => h.agents.snapshotFor('hall', id), status(404), 'fichier disparu');
  });

  it("direct : caméra liée à l'incident avec source réelle ; une autre caméra, une caméra simulée ou une alarme hors zone sont refusées", () => {
    const h = setup();
    h.makeAgent('hall', { zones: ['Hall'] });
    h.makeAgent('park', { zones: ['Parking'] });
    h.engine.handleDetectorMessage('D-HALL', { state: 'alarm' });
    const id = h.agents.alarms('hall')[0].id;
    assert.equal(h.agents.liveCameraFor('hall', id), 'C-HALL');
    assert.equal(h.agents.liveCameraFor('hall', id, 'C-HALL'), 'C-HALL');
    assert.equal(h.agents.liveCameraFor('hall', id, ''), 'C-HALL');
    assert.throws(() => h.agents.liveCameraFor('hall', id, 'C-SIM'), status(404), 'simulee');
    assert.throws(() => h.agents.liveCameraFor('hall', id, 'C-AUTRE'), status(404));
    assert.throws(() => h.agents.liveCameraFor('hall', id, 'D-HALL'), status(404), 'pas une camera');
    assert.throws(() => h.agents.liveCameraFor('park', id), status(404), 'hors zone');
    h.db.prepare("INSERT INTO camera_source (device_id, kind, host, port) VALUES ('C-SIM', 'rtsp', '10.0.0.10', 554)").run();
    h.engine.createDevice('admin', { id: 'C-AILLEURS', kind: 'camera', name: 'Ailleurs', zone: 'Parking' });
    h.db.prepare("INSERT INTO camera_source (device_id, kind, host, port) VALUES ('C-AILLEURS', 'rtsp', '10.0.0.11', 554)").run();
    assert.equal(h.agents.liveCameraFor('hall', id, 'C-SIM'), 'C-SIM');
    assert.throws(() => h.agents.liveCameraFor('hall', id, 'C-AILLEURS'), status(404), 'camera reelle mais non liee a cet incident');
  });
});

describe('SOS', () => {
  const sosBody = (extra: Record<string, unknown> = {}) => ({ clientId: 'abcd-1234-efgh', phoneAt: T0, discreet: false, ...extra });

  it("ouvre un incident critique « Appel de détresse (SOS) » avec le dernier point et son ancienneté ; idempotent par clientId", () => {
    const h = setup();
    h.makeAgent('moussa');
    const p = h.phone();
    h.agents.startShift('moussa', p.id);
    h.agents.setPosition('moussa', h.checkpoint('Arriere-cour'), T0);
    h.clock.t += 2 * MIN;
    const first = h.agents.sos('moussa', p.id, sosBody({ phoneAt: h.clock.t }));
    const incident = h.engine.incidentView(first.incidentId);
    assert.equal(incident.detectorId, 'A-moussa');
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.event, 'sos');
    assert.equal(incident.detail, 'Agent Agent moussa : dernier point Arriere-cour, il y a 2 min');
    // Renvoi du meme clientId (le telephone n'a pas recu la reponse) : meme incident, rien de plus.
    h.clock.t += 10_000;
    assert.deepEqual(h.agents.sos('moussa', p.id, sosBody({ phoneAt: h.clock.t })), first);
    assert.deepEqual(h.agents.sos('moussa', p.id, sosBody({ phoneAt: 1 })), first);
    assert.equal(h.actions('incident_opened').length, 1);
    assert.equal(h.actions('sos_sent').length, 1);
    assert.equal(h.actions('sos_sent')[0].actor, 'moussa');
    assert.equal(h.actions('sos_sent')[0].incident_id, first.incidentId);
    assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM agent_sos').get() as { n: number }).n, 1);
    // Un autre clientId pendant que l'incident est ouvert : le meme incident (pas de doublon, la contrainte du moteur).
    assert.equal(h.agents.sos('moussa', p.id, sosBody({ clientId: 'zzzz-9999-yyyy' })).incidentId, first.incidentId);
  });

  it("accepté hors service et sans position : « position inconnue »", () => {
    const h = setup();
    h.makeAgent('moussa');
    const p = h.phone();
    const { incidentId } = h.agents.sos('moussa', p.id, sosBody());
    assert.equal(h.engine.incidentView(incidentId).detail, 'Agent Agent moussa : position inconnue');
    assert.equal(h.agents.me('moussa').shift, null);
  });

  it("mode discret : précisé dans le détail ; moins d'une minute : « il y a moins d'1 min »", () => {
    const h = setup();
    h.makeAgent('moussa');
    const p = h.phone();
    h.agents.startShift('moussa', p.id);
    h.agents.setPosition('moussa', h.checkpoint('Portail'), T0 - 10_000);
    const { incidentId } = h.agents.sos('moussa', p.id, sosBody({ discreet: true }));
    assert.equal(h.engine.incidentView(incidentId).detail, "Agent Agent moussa : dernier point Portail, il y a moins d'1 min (mode discret)");
    // discreet n'est vrai que pour `true` (pas « true » en texte).
    const other = h.makeAgent('fanta');
    assert.ok(other);
    const { incidentId: second } = h.agents.sos('fanta', p.id, sosBody({ clientId: 'fanta-0000-0001', discreet: 'true' }));
    assert.ok(!/discret/.test(h.engine.incidentView(second).detail!));
  });

  it("jamais refusé pour une horloge fausse : l'heure du serveur fait foi, l'écart est noté dans le détail", () => {
    const h = setup();
    const names = ['ag1', 'ag2', 'ag3', 'ag4', 'ag5', 'ag6', 'ag7'];
    for (const n of names) h.makeAgent(n);
    const p = h.phone();
    const cases: unknown[] = [T0 + 5 * 365 * 24 * HOUR, 1, -5, undefined, 'hier', Number.NaN, T0 - 3 * HOUR];
    const details: string[] = [];
    names.forEach((n, i) => {
      const { incidentId } = h.agents.sos(n, p.id, sosBody({ clientId: `horloge-000${i}`, phoneAt: cases[i] }));
      const incident = h.engine.incidentView(incidentId);
      assert.equal(incident.detectorId, `A-${n}`);
      assert.equal(incident.openedAt, T0, "l'incident porte l'heure du serveur");
      details.push(incident.detail!);
      const stored = h.db.prepare('SELECT server_at FROM agent_sos WHERE client_id = ?').get(`horloge-000${i}`) as { server_at: number };
      assert.equal(stored.server_at, T0);
    });
    assert.match(details[0], /horloge du telephone en avance de \d+ min/);
    assert.match(details[1], /declenche il y a \d+ min d'apres le telephone/);
    assert.ok(!/telephone/.test(details[3].replace('Agent', '')) || /position inconnue/.test(details[3]), 'sans heure : rien a signaler');
    assert.ok(!/declenche|horloge/.test(details[3]), 'phoneAt absent : pas de remarque');
    assert.ok(!/declenche|horloge/.test(details[4]) && !/declenche|horloge/.test(details[5]), 'phoneAt illisible : pas de remarque');
    assert.match(details[6], /declenche il y a 180 min d'apres le telephone/);
    // Un ecart de moins de 2 minutes n'est pas signale.
    h.makeAgent('ag8');
    const { incidentId } = h.agents.sos('ag8', p.id, sosBody({ clientId: 'horloge-0008', phoneAt: T0 - 60_000 }));
    assert.ok(!/declenche|horloge/.test(h.engine.incidentView(incidentId).detail!));
  });

  it("un SOS rejoué n'est pas compté deux fois par le moteur (msgId = clientId), même si la mémoire d'idempotence est perdue", () => {
    const h = setup();
    h.makeAgent('moussa');
    const p = h.phone();
    const { incidentId } = h.agents.sos('moussa', p.id, sosBody({ phoneAt: T0 - 3 * HOUR }));
    h.db.prepare('DELETE FROM agent_sos').run();
    assert.equal(h.agents.sos('moussa', p.id, sosBody({ phoneAt: T0 - 3 * HOUR })).incidentId, incidentId);
    assert.equal(h.actions('incident_opened').length, 1);
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM ingest_dedup WHERE msg_id = 'abcd-1234-efgh'").get() as { n: number }).n, 1);
  });

  it("sans agent identifié : détecteur de secours A-phone-<n°> (« Téléphone <libellé> »), créé au besoin, visible de tous", () => {
    const h = setup();
    h.makeAgent('moussa', { zones: ['Hall'] });
    const p = h.phone('Poste nord');
    const { incidentId } = h.agents.sos(null, p.id, sosBody());
    const incident = h.engine.incidentView(incidentId);
    assert.equal(incident.detectorId, `A-phone-${p.id}`);
    assert.equal(incident.detectorName, 'Téléphone Poste nord');
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.detail, 'Telephone Poste nord : agent non identifie');
    assert.equal(h.engine.getDevice(`A-phone-${p.id}`)!.category, 'people');
    assert.deepEqual(h.agents.alarms('moussa').map((a) => a.id), [incidentId], 'visible de tous les agents');
    assert.deepEqual(h.agents.sos(null, p.id, sosBody()), { incidentId }, 'idempotent');
    assert.equal(h.actions('sos_sent')[0].actor, 'systeme');
    // Meme detecteur pour un second SOS de ce telephone (un seul incident ouvert) ; le releveur le libere aussi.
    assert.equal(h.agents.sos(null, p.id, sosBody({ clientId: 'autre-0000-0001' })).incidentId, incidentId);
    h.engine.acknowledge(incidentId, 'oscar');
    h.agents.tick();
    assert.equal(h.engine.getDevice(`A-phone-${p.id}`)!.status, 'normal');
  });

  it("un renvoi garde son incident même si l'identité change (session perdue entre-temps) : rien n'est refusé", () => {
    const h = setup();
    h.makeAgent('moussa');
    const p = h.phone();
    const first = h.agents.sos(null, p.id, sosBody());
    assert.deepEqual(h.agents.sos('moussa', p.id, sosBody()), first);
    const second = h.agents.sos('moussa', p.id, sosBody({ clientId: 'moussa-0000-0001' }));
    assert.deepEqual(h.agents.sos(null, p.id, sosBody({ clientId: 'moussa-0000-0001' })), second);
  });

  it("dernier agent connecté sur CE téléphone depuis moins de 24 h : seul lui est reconnu quand la session est terminée", () => {
    const h = setup();
    h.makeAgent('moussa');
    h.makeAgent('fanta');
    const a = h.phone('A');
    const b = h.phone('B');
    assert.equal(h.agents.lastLoginAgent(a.id, 'moussa'), null, 'jamais connecte');
    h.agents.login(a.id, 'moussa', PIN);
    assert.equal(h.agents.lastLoginAgent(a.id, 'moussa'), 'moussa');
    assert.equal(h.agents.lastLoginAgent(a.id, ' MOUSSA '), 'moussa');
    assert.equal(h.agents.lastLoginAgent(b.id, 'moussa'), null, 'pas sur ce telephone-la');
    assert.equal(h.agents.lastLoginAgent(a.id, 'fanta'), null, 'pas le dernier connecte');
    for (const bad of [undefined, null, 5, {}, [], '', 'admin', 'oscar', 'inconnu']) assert.equal(h.agents.lastLoginAgent(a.id, bad), null);
    h.agents.login(a.id, 'fanta', PIN);
    assert.equal(h.agents.lastLoginAgent(a.id, 'moussa'), null, 'fanta est maintenant la derniere');
    assert.equal(h.agents.lastLoginAgent(a.id, 'fanta'), 'fanta');
    // Un code faux ne change pas « le dernier connecte ».
    assert.throws(() => h.agents.login(a.id, 'moussa', '0000'), status(401));
    assert.equal(h.agents.lastLoginAgent(a.id, 'fanta'), 'fanta');
    h.clock.t += 24 * HOUR;
    assert.equal(h.agents.lastLoginAgent(a.id, 'fanta'), 'fanta', 'a 24 h pile');
    h.clock.t += 1;
    assert.equal(h.agents.lastLoginAgent(a.id, 'fanta'), null, 'au-dela de 24 h');
    // Un SOS attribue ainsi le dit dans le detail.
    h.clock.t = T0;
    h.agents.login(a.id, 'moussa', PIN);
    const { incidentId } = h.agents.sos('moussa', a.id, sosBody(), true);
    assert.equal(h.engine.incidentView(incidentId).detail, 'Agent Agent moussa : position inconnue, session terminee');
  });

  it("les colonnes du dernier login sont ajoutées à une base créée avant l'avenant (ajout idempotent)", () => {
    const h = setup();
    h.db.exec('ALTER TABLE agent_phone DROP COLUMN last_login_user');
    h.db.exec('ALTER TABLE agent_phone DROP COLUMN last_login_at');
    createAgents({ db: h.db, engine: h.engine, users: h.users, now: () => h.clock.t });
    createAgents({ db: h.db, engine: h.engine, users: h.users, now: () => h.clock.t });
    const columns = (h.db.prepare('PRAGMA table_info(agent_phone)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(columns.includes('last_login_user') && columns.includes('last_login_at'));
  });

  it("valide le clientId (8 à 64 caractères sûrs) ; un clientId déjà reçu renvoie son incident", () => {
    const h = setup();
    h.makeAgent('moussa');
    h.makeAgent('fanta');
    const p = h.phone();
    for (const clientId of ['court', '', 'a'.repeat(65), 'avec espace-0001', 'né-0000-0000', "x';--0000000", 12345678, null, undefined, ['abcdefgh']]) {
      assert.throws(() => h.agents.sos('moussa', p.id, sosBody({ clientId })), status(400), String(clientId));
    }
    for (const bad of [null, undefined, 'x', 5, []]) assert.throws(() => h.agents.sos('moussa', p.id, bad), status(400));
    const done = h.agents.sos('moussa', p.id, sosBody());
    assert.deepEqual(h.agents.sos('fanta', p.id, sosBody()), done, 'meme clientId : meme reponse, rien de refuse');
    assert.equal(h.engine.getDevice('A-fanta')!.status, 'normal', 'rien n\'a ete declenche pour fanta');
    assert.throws(() => h.agents.sos('inconnu', p.id, sosBody({ clientId: 'valide-00-0001' })), status(404));
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM agent_sos').get()!.n, 1, 'un refus ne laisse rien en memoire');
  });

  it("replace le détecteur de l'agent sur son dernier point (étage, x, y, zone) seulement si cela change", () => {
    const h = setup();
    h.makeAgent('moussa');
    const upper = Number(h.db.prepare("INSERT INTO floor (name, position) VALUES ('Etage 1', 1)").run().lastInsertRowid);
    const p = h.phone();
    h.agents.startShift('moussa', p.id);
    h.agents.setPosition('moussa', h.checkpoint('Terrasse', 'Terrasse', upper, 12, 34), T0);
    h.agents.sos('moussa', p.id, sosBody());
    const placed = h.engine.getDevice('A-moussa')!;
    assert.deepEqual([placed.zone, placed.floorId, placed.x, placed.y], ['Terrasse', upper, 12, 34]);
    const updates = () => h.actions('device_updated').filter((r) => r.device_id === 'A-moussa').length;
    const before = updates();
    h.agents.sos('moussa', p.id, sosBody({ clientId: 'second-0000-0001' }));
    assert.equal(updates(), before, 'meme position : pas de mise a jour');
  });

  it("une zone déjà utilisée à un autre étage ne fait pas échouer le SOS : le détecteur est placé sans zone", () => {
    const h = setup();
    h.makeAgent('moussa');
    const upper = Number(h.db.prepare("INSERT INTO floor (name, position) VALUES ('Etage 1', 1)").run().lastInsertRowid);
    const p = h.phone();
    h.agents.startShift('moussa', p.id);
    // « Hall » existe deja au rez-de-chaussee : le point de l'etage 1 portant cette zone est refuse par le moteur.
    h.agents.setPosition('moussa', h.checkpoint('Hall haut', 'Hall', upper, 70, 80), T0);
    const quiet = console.warn;
    console.warn = () => {};
    try {
      const { incidentId } = h.agents.sos('moussa', p.id, sosBody());
      assert.ok(incidentId > 0);
    } finally {
      console.warn = quiet;
    }
    const placed = h.engine.getDevice('A-moussa')!;
    assert.deepEqual([placed.zone, placed.floorId, placed.x, placed.y], ['', upper, 70, 80]);
  });

  it("le SOS est refusé pour la mémoire seulement si le moteur n'a rien enregistré : pas de clientId mémorisé, nouvel essai possible", () => {
    const h = setup();
    h.makeAgent('moussa');
    const p = h.phone();
    // Detecteur d'agent supprime a la main puis recree par ensureDetector : le SOS passe. (Controle de non-regression.)
    h.engine.deleteDevice('admin', 'A-moussa');
    assert.ok(h.agents.sos('moussa', p.id, sosBody()).incidentId > 0);
  });
});

describe('detecteurs virtuels liberes a l\'acquittement', () => {
  it("un SOS acquitté par un opérateur est remis à « clear » : l'opérateur peut le clôturer", () => {
    const h = setup();
    h.makeAgent('moussa');
    const p = h.phone();
    const { incidentId } = h.agents.sos('moussa', p.id, { clientId: 'abcd-1234-efgh', phoneAt: T0 });
    assert.equal(h.engine.getDevice('A-moussa')!.status, 'alarm');
    h.agents.tick();
    assert.equal(h.engine.getDevice('A-moussa')!.status, 'alarm', 'pas encore acquitte');
    assert.throws(() => h.engine.close(incidentId, 'oscar', 'fire', ''), status(409));
    h.engine.acknowledge(incidentId, 'oscar');
    h.agents.tick();
    assert.equal(h.engine.getDevice('A-moussa')!.status, 'normal');
    assert.equal(h.engine.incidentView(incidentId).status, 'acknowledged', "l'incident reste ouvert");
    assert.equal(h.engine.close(incidentId, 'oscar', 'fire', 'vrai SOS').status, 'closed');
  });

  it("acquitté par un agent : le détecteur est libéré aussi (sinon personne ne pourrait clôturer)", () => {
    const h = setup();
    h.makeAgent('moussa');
    h.makeAgent('fanta');
    const p = h.phone();
    const { incidentId } = h.agents.sos('moussa', p.id, { clientId: 'abcd-1234-efgh', phoneAt: T0 });
    h.agents.ackAlarm('fanta', incidentId);
    h.agents.tick();
    assert.equal(h.engine.getDevice('A-moussa')!.status, 'normal');
    assert.equal(h.engine.close(incidentId, 'oscar', 'fire', 'vrai SOS').status, 'closed');
  });

  it("releaseAcknowledged ne touche que le préfixe demandé, et seulement les détecteurs en (pré)alarme", () => {
    const h = setup();
    h.engine.createDevice('admin', { id: 'P-7', kind: 'detector', name: 'Circuit', category: 'people', heartbeatS: 0 });
    h.makeAgent('moussa');
    h.engine.handleDetectorMessage('P-7', { event: 'patrol_missed', detail: 'aucun point scanne (3 points)' });
    h.engine.handleDetectorMessage('A-moussa', { event: 'sos' });
    h.engine.handleDetectorMessage('D-HALL', { state: 'alarm' });
    for (const i of h.engine.getSnapshot().incidents) h.engine.acknowledge(i.id, 'oscar');
    assert.equal(releaseAcknowledged(h.db, h.engine, 'P-'), 1);
    assert.equal(h.engine.getDevice('P-7')!.status, 'normal');
    assert.equal(h.engine.getDevice('A-moussa')!.status, 'alarm');
    assert.equal(h.engine.getDevice('D-HALL')!.status, 'alarm', 'un detecteur ordinaire n\'est jamais concerne');
    assert.equal(releaseAcknowledged(h.db, h.engine, 'A-'), 1);
    assert.equal(h.engine.getDevice('A-moussa')!.status, 'normal');
    assert.equal(releaseAcknowledged(h.db, h.engine, 'A-'), 0, 'deja libere');
    assert.equal(releaseAcknowledged(h.db, h.engine, 'P-'), 0);
  });

  it("décision de l'utilisateur : un agent qui n'a pas pris son service voit, acquitte et signale « j'y vais » / « sur place »", () => {
    const h = setup();
    h.makeAgent('hall', { zones: ['Hall'] });
    h.engine.handleDetectorMessage('D-HALL', { state: 'alarm' });
    assert.equal(h.agents.me('hall').shift, null, 'hors service');
    const id = h.agents.alarms('hall')[0].id;
    h.agents.dispatch('hall', id, 'en_route');
    h.agents.dispatch('hall', id, 'on_site');
    h.agents.ackAlarm('hall', id);
    const a = h.agents.alarms('hall')[0];
    assert.equal(a.acknowledged, true);
    assert.deepEqual(a.dispatch.map((d) => d.status), ['on_site'], 'un seul état par agent : le dernier');
  });

  it("releaseAcknowledged ne libère jamais un détecteur du site nommé A-01 (contrôle d'accès) : seuls les détecteurs d'agents le sont", () => {
    const h = setup();
    // Le site de démonstration (et .env.example) a un détecteur d'accès « A-01 » : même préfixe que les agents.
    h.engine.createDevice('admin', { id: 'A-01', kind: 'detector', name: 'Porte de service', category: 'access' });
    h.makeAgent('moussa');
    h.engine.handleDetectorMessage('A-01', { state: 'alarm' });
    h.engine.handleDetectorMessage('A-moussa', { event: 'sos' });
    for (const i of h.engine.getSnapshot().incidents) h.engine.acknowledge(i.id, 'oscar');
    assert.equal(releaseAcknowledged(h.db, h.engine, 'A-'), 1, 'seul A-moussa');
    assert.equal(h.engine.getDevice('A-moussa')!.status, 'normal');
    assert.equal(h.engine.getDevice('A-01')!.status, 'alarm', 'la porte reste en alarme tant qu\'elle l\'est');
  });

  it("l'identifiant d'un agent n'admet pas le point : le détecteur A-<identifiant> ne le supporterait pas (400 net, rien créé)", () => {
    const h = setup();
    assert.throws(() => h.makeAgent('marie.dupont'), (e) => status(400)(e) && /sans point/.test((e as Error).message));
    assert.ok(!h.engine.getDevice('A-marie.dupont'));
    assert.equal(h.users.list().some((u) => u.username === 'marie.dupont'), false, 'aucun compte à moitié créé');
    h.makeAgent('marie-dupont');
    assert.ok(h.engine.getDevice('A-marie-dupont'));
    assert.throws(() => h.makeAgent('a'.repeat(31)), status(400), 'A- + 31 caractères dépasse 32');
    h.makeAgent('a'.repeat(30)); // A- + 30 = 32 : la limite
  });

  it("l'acquittement d'un compte supprimé ou administrateur libère aussi (seul le rôle agent retient)", () => {
    const h = setup();
    h.engine.createDevice('admin', { id: 'P-9', kind: 'detector', name: 'Circuit', category: 'people', heartbeatS: 0 });
    h.engine.handleDetectorMessage('P-9', { event: 'patrol_incomplete' });
    const id = h.engine.getSnapshot().incidents[0].id;
    h.engine.acknowledge(id, 'ancien-operateur-supprime');
    assert.equal(releaseAcknowledged(h.db, h.engine, 'P-'), 1);
  });
});

// ================================================================== HTTP

describe('HTTP : appairage', () => {
  it("POST /api/agent/pair : pose le cookie psim_phone (HttpOnly, SameSite=Strict, 1 an), sans jamais mettre la clé dans le corps", async () => {
    const { admin, pairedPhone, h } = await web();
    const made = await admin.post('/api/agent-phones', { label: 'Poste 1' });
    const code = /#pair=([a-z2-7]{10})$/.exec(made.json!.pairUrl)![1];
    const phone = new Client(admin.base);
    const res = await phone.post('/api/agent/pair', { code });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { phone: { id: made.json!.id, label: 'Poste 1' } });
    const cookie = res.setCookie.find((c) => c.startsWith(`${PHONE_COOKIE}=`))!;
    assert.match(cookie, /^psim_phone=pph_\d+_[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=31536000$/);
    assert.ok(!cookie.includes('Secure'));
    const key = cookie.split(';')[0].split('=')[1];
    assert.ok(!res.raw.toString().includes(key));
    assert.equal(res.headers.get('cache-control'), 'no-store');
    // Usage unique, y compris par HTTP.
    const again = await new Client(admin.base).post('/api/agent/pair', { code });
    assert.equal(again.status, 401);
    assert.deepEqual(again.json, { error: "Code d'appairage invalide ou expire" });
    assert.equal(again.setCookie.length, 0);
    void pairedPhone;
    void h;
  });

  it('avec TLS (cookieSecure) le cookie du téléphone et celui de la session portent « Secure »', async () => {
    const { h, admin, pairedPhone, login } = await web({ secure: true });
    h.makeAgent('moussa');
    const made = await admin.post('/api/agent-phones', { label: 'T' });
    const code = /#pair=([a-z2-7]{10})$/.exec(made.json!.pairUrl)![1];
    const phone = new Client(admin.base);
    const res = await phone.post('/api/agent/pair', { code });
    assert.match(res.setCookie[0], /; Max-Age=31536000; Secure$/);
    const session = await login(phone);
    assert.match(session.setCookie[0], /^psim_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200; Secure$/);
    void pairedPhone;
  });

  it('limité à 10 échecs par minute et par adresse (429), repart après la minute ; les autres adresses ne sont pas touchées', async () => {
    const { admin, h } = await web();
    const attacker = new Client(admin.base);
    for (let i = 0; i < 10; i++) assert.equal((await attacker.post('/api/agent/pair', { code: 'aaaaaaaaaa' })).status, 401);
    const blocked = await attacker.post('/api/agent/pair', { code: 'aaaaaaaaaa' });
    assert.equal(blocked.status, 429);
    // Meme avec un vrai code, l'adresse bloquee reste bloquee.
    const made = await admin.post('/api/agent-phones', { label: 'T' });
    const code = /#pair=([a-z2-7]{10})$/.exec(made.json!.pairUrl)![1];
    assert.equal((await attacker.post('/api/agent/pair', { code })).status, 429);
    assert.equal((await new Client(admin.base).post('/api/agent/pair', { code })).status, 200, 'une autre adresse passe');
    h.clock.t += 61_000;
    assert.equal((await attacker.post('/api/agent/pair', { code: 'bbbbbbbbbb' })).status, 401, 'la limite est levee apres une minute');
  });

  it('refuse un corps illisible ou démesuré sans planter', async () => {
    const { admin } = await web();
    const phone = new Client(admin.base);
    assert.equal((await phone.call('POST', '/api/agent/pair', '{pas du json')).status, 400);
    assert.equal((await phone.call('POST', '/api/agent/pair', { code: 'x'.repeat(10_000) })).status, 413);
    assert.equal((await phone.call('POST', '/api/agent/pair', '[]')).status, 401);
    assert.equal((await phone.call('POST', '/api/agent/pair', 'null')).status, 400, 'JSON strict : ni null ni texte nu');
  });

  it("GET /api/agent/phone : exige un téléphone appairé non révoqué ; liste les agents actifs avec leur verrou", async () => {
    const { h, admin, pairedPhone } = await web();
    h.makeAgent('moussa');
    h.makeAgent('fanta');
    h.agents.disableAgent('admin', 'fanta');
    const anonymous = new Client(admin.base);
    const refused = await anonymous.get('/api/agent/phone');
    assert.equal(refused.status, 401);
    assert.equal(refused.json!.reason, 'phone');
    const { client, id } = await pairedPhone('Telephone du poste');
    const ok = await client.get('/api/agent/phone');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { phone: { id, label: 'Telephone du poste' }, agents: [{ username: 'moussa', displayName: 'Agent moussa', locked: false }] });
    // Cookie forge ou d'un autre type : refuse.
    const forged = new Client(admin.base);
    forged.jar.set(PHONE_COOKIE, `pph_${id}_${'A'.repeat(43)}`);
    assert.equal((await forged.get('/api/agent/phone')).status, 401);
    forged.jar.set(PHONE_COOKIE, 'nimporte quoi');
    assert.equal((await forged.get('/api/agent/phone')).status, 401);
    // Revocation : le meme cookie ne marche plus.
    assert.equal((await admin.post(`/api/agent-phones/${id}/revoke`)).status, 200);
    const revoked = await client.get('/api/agent/phone');
    assert.equal(revoked.status, 401);
    assert.equal(revoked.json!.reason, 'phone');
  });
});

describe('HTTP : connexion, session, service', () => {
  it("connexion : session de la durée de service, liée au téléphone ; me, service, fin de service (cookie effacé)", async () => {
    const { h, pairedPhone, login } = await web();
    h.makeAgent('moussa', { maxShiftMinutes: 60 });
    const { client } = await pairedPhone();
    const res = await login(client);
    assert.equal(res.status, 200);
    assert.match(res.setCookie[0], /^psim_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=3600$/);
    assert.deepEqual(res.json, { me: { username: 'moussa', displayName: 'Agent moussa', zones: [], shift: null, position: null } });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await client.get('/api/agent/me')).json!.me.username, 'moussa');
    const started = await client.post('/api/agent/shift/start');
    assert.equal(started.status, 200);
    assert.equal(started.json!.me.shift.endsAt, T0 + 60 * MIN);
    // Fin de service : ok, cookie de session efface, l'application doit tout effacer localement.
    const ended = await client.post('/api/agent/shift/end');
    assert.deepEqual(ended.json, { ok: true });
    assert.match(ended.setCookie[0], /^psim_session=; HttpOnly; SameSite=Strict; Path=\/; Max-Age=0$/);
    const after_ = await client.get('/api/agent/me');
    assert.equal(after_.status, 401);
    assert.equal(after_.json!.reason, 'session');
    assert.equal(h.agents.me('moussa').shift, null);
  });

  it("connexion refusée sans téléphone appairé (401, reason phone)", async () => {
    const { h, admin, login } = await web();
    h.makeAgent('moussa');
    const res = await login(new Client(admin.base));
    assert.equal(res.status, 401);
    assert.equal(res.json!.reason, 'phone');
  });

  it("mauvais code : 401 puis, au cinquième, 423 ; message identique pour un nom inconnu ; déverrouillage par l'administrateur", async () => {
    const { h, admin, pairedPhone, login } = await web();
    h.makeAgent('moussa');
    const { client } = await pairedPhone();
    const unknown = await login(client, 'inconnu', PIN);
    const wrong = await login(client, 'moussa', '0000');
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.json, unknown.json);
    for (let i = 0; i < 3; i++) assert.equal((await login(client, 'moussa', '0000')).status, 401);
    // 4 echecs de code + 1 : le 5e verrouille. (limite par adresse : 10 echecs/min, on est a 5 ici)
    const locked = await login(client, 'moussa', '0000');
    assert.equal(locked.status, 423);
    assert.equal(locked.setCookie.length, 0);
    assert.equal((await login(client)).status, 423, 'meme avec le bon code');
    assert.equal((await client.get('/api/agent/phone')).json!.agents[0].locked, true);
    const unlocked = await admin.call('PATCH', '/api/agents/moussa', { unlock: true });
    assert.equal(unlocked.status, 200);
    assert.equal(unlocked.json!.locked, false);
    h.clock.t += 61_000;
    assert.equal((await login(client)).status, 200);
  });

  it('limite par adresse : 10 échecs par minute (429) même sur des noms différents', async () => {
    const { h, pairedPhone, login } = await web();
    h.makeAgent('moussa');
    const { client } = await pairedPhone();
    for (let i = 0; i < 10; i++) assert.equal((await login(client, `inconnu${i}`)).status, 401);
    assert.equal((await login(client, 'moussa', PIN)).status, 429);
    h.clock.t += 61_000;
    assert.equal((await login(client, 'moussa', PIN)).status, 200);
  });

  it("une session ouverte sur le téléphone A ne sert pas avec la clé du téléphone B", async () => {
    const { h, pairedPhone, login } = await web();
    h.makeAgent('moussa');
    const a = await pairedPhone('A');
    const b = await pairedPhone('B');
    assert.equal((await login(a.client)).status, 200);
    const stolen = a.client.jar.get('psim_session')!;
    b.client.jar.set('psim_session', stolen);
    const crossed = await b.client.get('/api/agent/me');
    assert.equal(crossed.status, 401);
    assert.equal(crossed.json!.reason, 'session');
    assert.equal((await b.client.get('/api/agent/alarms')).status, 401);
    // Avenant 1 : le SOS n'exige que le telephone ; la session d'un autre telephone est ignoree (detecteur de secours du telephone B).
    assert.equal((await b.client.post('/api/agent/sos', { clientId: 'abcd-1234-efgh', phoneAt: T0, discreet: false })).status, 200);
    assert.equal(h.engine.getDevice('A-moussa')!.status, 'normal', "jamais attribue a l'agent de l'autre telephone");
    assert.equal((await a.client.get('/api/agent/me')).status, 200);
    // Sans cookie de telephone du tout, la session seule ne suffit pas.
    const bare = new Client(a.client.base);
    bare.jar.set('psim_session', stolen);
    assert.equal((await bare.get('/api/agent/me')).json!.reason, 'phone');
  });

  it("une session ordinaire (opérateur, administrateur) n'ouvre pas les routes de l'agent, même avec un téléphone appairé", async () => {
    const { admin, operator, pairedPhone } = await web();
    const { client } = await pairedPhone();
    for (const who of [admin, operator]) {
      client.jar.set('psim_session', who.jar.get('psim_session')!);
      assert.equal((await client.get('/api/agent/me')).status, 403);
      assert.equal((await client.get('/api/agent/alarms')).status, 403);
      // Un SOS reste accepte (avenant 1) : attribue au detecteur de secours du telephone, jamais au compte de l'exploitation.
      assert.equal((await client.post('/api/agent/sos', { clientId: 'abcd-1234-efgh' + who.jar.size })).status, 200);
    }
  });

  it("avenant 1 : un SOS n'exige que le téléphone (dernier agent connecté, sinon détecteur de secours) ; messages 401 exacts", async () => {
    const { h, pairedPhone, login } = await web();
    h.makeAgent('moussa');
    const { client, phone } = (await pairedPhone('Poste nord')) as { client: Client; phone?: { id: number } };
    // Sans session : 401 « Session terminée » sur une route d'agent, « Téléphone non appairé » sans cookie de téléphone.
    const noSession = await client.get('/api/agent/me');
    assert.equal(noSession.status, 401);
    assert.equal(noSession.json!.error, 'Session terminée');
    assert.equal((await new Client(client.base).get('/api/agent/phone')).json!.error, 'Téléphone non appairé');
    // SOS sans session ni nom : detecteur de secours du telephone.
    const anon = await client.post('/api/agent/sos', { clientId: 'sos-anon-0001', phoneAt: 1, discreet: true });
    assert.equal(anon.status, 200);
    assert.equal(anon.json!.ok, true);
    const backup = h.engine.getSnapshot().devices.find((d) => d.id.startsWith('A-phone-'));
    assert.ok(backup, 'detecteur de secours cree');
    assert.equal(backup!.name, 'Téléphone Poste nord');
    assert.equal(h.engine.getDevice('A-moussa')!.status, 'normal');
    // Apres une connexion de moussa sur ce telephone puis la fin de sa session, son nom est accepte pendant 24 h.
    assert.equal((await login(client)).status, 200);
    client.jar.delete('psim_session');
    const named = await client.post('/api/agent/sos', { clientId: 'sos-named-001', phoneAt: T0, discreet: false, username: 'moussa' });
    assert.equal(named.status, 200);
    assert.equal(h.engine.getDevice('A-moussa')!.status, 'alarm');
    // Un nom qui n'est pas le dernier agent connecte ici n'est pas cru : detecteur de secours, jamais un refus.
    const forged = await client.post('/api/agent/sos', { clientId: 'sos-forged-01', phoneAt: T0, discreet: false, username: 'admin' });
    assert.equal(forged.status, 200);
    void phone;
  });

  it("avenant 2 : le chef de poste (opérateur) lit les agents, déverrouille un code et termine un service ; le reste reste admin", async () => {
    const { h, operator, pairedPhone, login } = await web();
    h.makeAgent('moussa');
    const { client } = await pairedPhone();
    assert.equal((await login(client)).status, 200);
    assert.equal((await client.post('/api/agent/shift/start', {})).status, 200);
    assert.equal((await operator.get('/api/agents')).status, 200);
    for (let i = 0; i < 5; i++) await login(client, 'moussa', '0000');
    assert.equal((await operator.get('/api/agents')).json!.find((a: { username: string }) => a.username === 'moussa').locked, true);
    assert.equal((await operator.post('/api/agents/moussa/unlock', {})).status, 200);
    assert.equal((await operator.get('/api/agents')).json!.find((a: { username: string }) => a.username === 'moussa').locked, false);
    assert.equal((await operator.post('/api/agents/moussa/end-shift', {})).status, 200);
    assert.equal((await operator.post('/api/agents', { username: 'neuf', displayName: 'Neuf', pin: '1234', zones: [] })).status, 403);
    assert.equal((await operator.call('PATCH', '/api/agents/moussa', { displayName: 'X' })).status, 403);
    assert.equal((await operator.call('DELETE', '/api/agents/moussa')).status, 403);
    assert.equal((await operator.get('/api/agent-phones')).status, 403);
  });

  it("une session sans phoneId (créée sans téléphone) est refusée", async () => {
    const { h, admin, pairedPhone } = await web();
    h.makeAgent('moussa');
    const { client } = await pairedPhone();
    const opened = h.users.openSession('moussa');
    client.jar.set('psim_session', createSession('moussa', 'agent', opened.epoch, null, T0));
    assert.equal((await client.get('/api/agent/me')).status, 401);
    void admin;
  });

  it("déconnexion : la session est détruite (le service continue), le cookie est effacé, sans exiger de session valide", async () => {
    const { h, pairedPhone, login } = await web();
    h.makeAgent('moussa');
    const { client } = await pairedPhone();
    await login(client);
    await client.post('/api/agent/shift/start');
    const token = client.jar.get('psim_session')!;
    const out = await client.post('/api/agent/logout');
    assert.deepEqual(out.json, { ok: true });
    assert.equal(getSession(token), null);
    assert.ok(h.agents.me('moussa').shift, 'le service continue');
    assert.equal((await client.get('/api/agent/me')).status, 401);
    assert.equal((await new Client(client.base).post('/api/agent/logout')).status, 200);
    // On peut se reconnecter et retrouver son service.
    await login(client);
    assert.ok((await client.get('/api/agent/me')).json!.me.shift);
  });

  it("une nouvelle connexion remplace la session précédente du navigateur", async () => {
    const { h, pairedPhone, login } = await web();
    h.makeAgent('moussa');
    const { client } = await pairedPhone();
    await login(client);
    const first = client.jar.get('psim_session')!;
    await login(client);
    assert.equal(getSession(first), null);
    assert.equal((await client.get('/api/agent/me')).status, 200);
  });

  it("révoquer le téléphone coupe tout à l'instant : session, service, alarmes, SOS", async () => {
    const { h, admin, pairedPhone, login } = await web();
    h.makeAgent('moussa');
    const { client, id } = await pairedPhone();
    await login(client);
    await client.post('/api/agent/shift/start');
    assert.equal((await client.get('/api/agent/alarms')).status, 200);
    const revoked = await admin.post(`/api/agent-phones/${id}/revoke`);
    assert.deepEqual(revoked.json, { ok: true });
    assert.equal((await client.get('/api/agent/alarms')).status, 401);
    assert.equal((await client.post('/api/agent/sos', { clientId: 'abcd-1234-efgh', phoneAt: T0, discreet: false })).status, 401);
    assert.equal(h.agents.me('moussa').shift, null);
    assert.equal(h.db.prepare('SELECT end_reason FROM agent_shift').get()!.end_reason, 'revoked');
    assert.equal((await login(client)).status, 401);
  });

  it("fin automatique du service : après tick(), le même cookie ne donne plus rien", async () => {
    const { h, pairedPhone, login } = await web();
    h.makeAgent('moussa', { maxShiftMinutes: 30 });
    const { client } = await pairedPhone();
    await login(client);
    await client.post('/api/agent/shift/start');
    h.clock.t += 31 * MIN;
    h.agents.tick();
    assert.equal((await client.get('/api/agent/me')).status, 401);
    await login(client);
    assert.equal((await client.get('/api/agent/me')).json!.me.shift, null);
  });

  it("un agent désactivé voit sa session tomber (compte inactif)", async () => {
    const { h, admin, pairedPhone, login } = await web();
    h.makeAgent('moussa');
    const { client } = await pairedPhone();
    await login(client);
    assert.equal((await admin.call('DELETE', '/api/agents/moussa')).status, 204);
    assert.equal((await client.get('/api/agent/me')).status, 401);
    assert.equal((await login(client)).status, 401);
  });
});

describe('HTTP : alarmes, image, direct, SOS', () => {
  async function ready() {
    const w = await web();
    w.h.makeAgent('hall', { zones: ['Hall'] });
    w.h.makeAgent('park', { zones: ['Parking'] });
    const hall = (await w.pairedPhone('Hall')).client;
    const park = (await w.pairedPhone('Park')).client;
    await w.login(hall, 'hall');
    await w.login(park, 'park');
    return { ...w, hall, park };
  }

  it("GET /api/agent/alarms : alarmes de ses zones + serverAt ; ack et dispatch ; zones étrangères en 404", async () => {
    const { h, hall, park } = await ready();
    h.engine.handleDetectorMessage('D-HALL', { state: 'alarm' });
    h.engine.handleDetectorMessage('D-PARK', { state: 'alarm' });
    const list = await hall.get('/api/agent/alarms');
    assert.equal(list.status, 200);
    assert.equal(list.json!.serverAt, T0);
    assert.deepEqual(list.json!.alarms.map((a: { zone: string }) => a.zone), ['Hall']);
    const id = list.json!.alarms[0].id as number;
    assert.equal((await park.post(`/api/agent/alarms/${id}/ack`)).status, 404);
    assert.equal((await park.post(`/api/agent/alarms/${id}/dispatch`, { status: 'en_route' })).status, 404);
    assert.equal((await hall.post(`/api/agent/alarms/${id}/dispatch`, { status: 'arrive' })).status, 400);
    assert.deepEqual((await hall.post(`/api/agent/alarms/${id}/dispatch`, { status: 'en_route' })).json, { ok: true });
    assert.deepEqual((await hall.post(`/api/agent/alarms/${id}/ack`)).json, { ok: true });
    assert.equal((await hall.post(`/api/agent/alarms/${id}/ack`)).status, 409);
    const after_ = (await hall.get('/api/agent/alarms')).json!.alarms[0];
    assert.equal(after_.acknowledged, true);
    assert.equal(after_.acknowledgedBy, 'Agent hall');
    assert.deepEqual(after_.dispatch.map((d: { username: string; status: string }) => [d.username, d.status]), [['hall', 'en_route']]);
    // Identifiants hostiles : 404, jamais 500.
    for (const bad of ['abc', '0', '-1', '1e3', '99999999999999999999', '1%20OR%201=1']) {
      assert.equal((await hall.post(`/api/agent/alarms/${bad}/ack`)).status, 404, bad);
      assert.equal((await hall.get(`/api/agent/alarms/${bad}/snapshot`)).status, 404, bad);
      assert.equal((await hall.get(`/api/agent/alarms/${bad}/live`)).status, 404, bad);
    }
  });

  it("GET /api/agent/alarms/:id/snapshot : octets de la dernière image, type d'après les octets, sans cache durable", async () => {
    const { h, hall, park } = await ready();
    h.engine.handleDetectorMessage('D-HALL', { state: 'alarm' });
    const id = (await hall.get('/api/agent/alarms')).json!.alarms[0].id as number;
    assert.equal((await hall.get(`/api/agent/alarms/${id}/snapshot`)).status, 404, 'pas encore d\'image');
    const insert = h.db.prepare("INSERT INTO incident_snapshot (incident_id, camera_id, taken_at, reason, file) VALUES (?, 'C-HALL', ?, 'opened', 'x.jpg')");
    h.snapshots.set(Number(insert.run(id, T0).lastInsertRowid), Buffer.from('ancienne'));
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('reste')]);
    h.snapshots.set(Number(insert.run(id, T0 + 1).lastInsertRowid), png);
    const res = await hall.get(`/api/agent/alarms/${id}/snapshot`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.raw, png);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal((await park.get(`/api/agent/alarms/${id}/snapshot`)).status, 404, 'hors zone');
    h.snapshots.set(2, JPEG);
    assert.equal((await hall.get(`/api/agent/alarms/${id}/snapshot`)).headers.get('content-type'), 'image/jpeg');
    assert.equal((await new Client(hall.base).get(`/api/agent/alarms/${id}/snapshot`)).status, 401);
  });

  it("GET /api/agent/alarms/:id/live?camera= : appelle le flux du poste de garde pour une caméra liée, sinon 404", async () => {
    const { h, hall, park } = await ready();
    h.engine.handleDetectorMessage('D-HALL', { state: 'alarm' });
    const id = (await hall.get('/api/agent/alarms')).json!.alarms[0].id as number;
    const ok = await hall.get(`/api/agent/alarms/${id}/live?camera=C-HALL`);
    assert.equal(ok.status, 200);
    assert.equal(ok.raw.toString(), 'FLUX C-HALL');
    assert.equal((await hall.get(`/api/agent/alarms/${id}/live`)).raw.toString(), 'FLUX C-HALL', 'camera par defaut');
    assert.deepEqual(h.live, ['C-HALL', 'C-HALL']);
    assert.equal((await hall.get(`/api/agent/alarms/${id}/live?camera=C-SIM`)).status, 404);
    assert.equal((await hall.get(`/api/agent/alarms/${id}/live?camera=C-AUTRE`)).status, 404);
    assert.equal((await hall.get(`/api/agent/alarms/${id}/live?camera[]=C-HALL`)).raw.toString(), 'FLUX C-HALL', 'parametre non textuel ignore');
    assert.equal((await park.get(`/api/agent/alarms/${id}/live?camera=C-HALL`)).status, 404, 'hors zone');
    assert.equal((await new Client(hall.base).get(`/api/agent/alarms/${id}/live?camera=C-HALL`)).status, 401);
    assert.equal(h.live.length, 3, 'aucun flux ouvert pour les refus');
  });

  it("POST /api/agent/sos : fonctionne hors service, idempotent, incident visible de tous les agents ; refuse un envoi sans clientId", async () => {
    const { h, hall, park } = await ready();
    const body = { clientId: 'abcd-1234-efgh', phoneAt: T0 - 5_000, discreet: true };
    const first = await hall.post('/api/agent/sos', body);
    assert.equal(first.status, 200);
    assert.equal(first.json!.ok, true);
    const incidentId = first.json!.incidentId as number;
    assert.deepEqual((await hall.post('/api/agent/sos', body)).json, first.json);
    assert.equal(h.engine.incidentView(incidentId).detail, 'Agent Agent hall : position inconnue (mode discret)');
    const seen = (await park.get('/api/agent/alarms')).json!.alarms;
    assert.deepEqual(seen.map((a: { id: number }) => a.id), [incidentId], "l'agent du parking voit le SOS du hall");
    assert.equal(seen[0].title, 'Appel de détresse (SOS)');
    assert.equal(seen[0].severity, 'critical');
    assert.equal((await hall.post('/api/agent/sos', {})).status, 400);
    assert.equal((await hall.post('/api/agent/sos', { clientId: 'court' })).status, 400);
    assert.equal((await new Client(hall.base).post('/api/agent/sos', body)).status, 401);
  });
});

describe('HTTP : administration', () => {
  it("/api/agents : réservé à l'administrateur (401 sans session, 403 opérateur), création 201, liste, modification, désactivation 204", async () => {
    const { h, admin, operator } = await web();
    const anonymous = new Client(admin.base);
    assert.equal((await anonymous.get('/api/agents')).status, 401);
    assert.equal((await operator.get('/api/agents')).status, 200, 'avenant 2 : lecture ouverte au chef de poste');
    assert.equal((await operator.post('/api/agents', { username: 'moussa', displayName: 'M', pin: PIN })).status, 403);
    assert.equal((await operator.call('PATCH', '/api/agents/moussa', {})).status, 403);
    assert.equal((await operator.call('DELETE', '/api/agents/moussa')).status, 403);
    assert.equal((await operator.post('/api/agents/moussa/end-shift')).status, 404, 'avenant 2 : ouvert au chef de poste (agent inconnu ici)');
    const created = await admin.post('/api/agents', { username: 'Moussa', displayName: 'Moussa Camara', pin: PIN, zones: ['Hall'], maxShiftMinutes: 600 });
    assert.equal(created.status, 201);
    assert.deepEqual(created.json, { username: 'moussa', displayName: 'Moussa Camara', zones: ['Hall'], locked: false, maxShiftMinutes: 600, active: true, shift: null, position: null });
    assert.ok(!created.raw.toString().includes(PIN), 'le code n\'est jamais renvoye');
    assert.equal((await admin.post('/api/agents', { username: 'moussa', displayName: 'M', pin: PIN })).status, 409);
    assert.equal((await admin.post('/api/agents', { username: 'bob', displayName: 'Bob', pin: 1234 })).status, 400);
    assert.equal((await admin.post('/api/agents', { username: 'bob', displayName: 'Bob', pin: '12' })).status, 400);
    assert.equal((await admin.post('/api/agents', { username: 'bob', displayName: 'Bob', pin: PIN, zones: ['Nulle part'] })).status, 400);
    assert.equal((await admin.post('/api/agents', 'null')).status, 400);
    assert.equal((await admin.get('/api/agents')).json!.length, 1);
    const patched = await admin.call('PATCH', '/api/agents/moussa', { displayName: 'M. Camara', zones: [], maxShiftMinutes: 90 });
    assert.equal(patched.status, 200);
    assert.deepEqual([patched.json!.displayName, patched.json!.zones, patched.json!.maxShiftMinutes], ['M. Camara', [], 90]);
    assert.equal((await admin.call('PATCH', '/api/agents/inconnu', { displayName: 'x' })).status, 404);
    assert.equal((await admin.call('PATCH', '/api/agents/oscar', { displayName: 'x' })).status, 404, 'un operateur n\'est pas un agent');
    assert.equal((await admin.call('PATCH', '/api/agents/moussa', { pin: 'abc' })).status, 400);
    assert.equal((await admin.call('DELETE', '/api/agents/moussa')).status, 204);
    assert.equal((await admin.get('/api/agents')).json![0].active, false);
    assert.equal((await admin.call('DELETE', '/api/agents/inconnu')).status, 404);
    assert.equal(h.users.get('moussa').active, false);
  });

  it("fin de service forcée : /api/agents/:username/end-shift", async () => {
    const { h, admin, pairedPhone, login } = await web();
    h.makeAgent('moussa');
    const { client } = await pairedPhone();
    await login(client);
    await client.post('/api/agent/shift/start');
    assert.ok((await admin.get('/api/agents')).json![0].shift);
    assert.deepEqual((await admin.post('/api/agents/moussa/end-shift')).json, { ok: true });
    assert.equal((await admin.get('/api/agents')).json![0].shift, null);
    assert.equal((await client.get('/api/agent/me')).status, 401, 'la session de l\'agent est aussi fermee');
    assert.equal((await admin.post('/api/agents/inconnu/end-shift')).status, 404);
  });

  it("/api/agent-phones : création (pairUrl, expiresAt), liste (pending, pairedAt...), QR tant que l'appairage est en attente, révocation", async () => {
    const { h, admin, operator } = await web();
    assert.equal((await operator.get('/api/agent-phones')).status, 403);
    assert.equal((await operator.post('/api/agent-phones', { label: 'x' })).status, 403);
    assert.equal((await admin.post('/api/agent-phones', {})).status, 400);
    const made = await admin.post('/api/agent-phones', { label: 'Telephone du poste' });
    assert.equal(made.status, 201);
    assert.deepEqual(Object.keys(made.json!).sort(), ['expiresAt', 'id', 'pairUrl']);
    assert.match(made.json!.pairUrl, /^https:\/\/psim\.test\/agent\/#pair=[a-z2-7]{10}$/);
    assert.equal(made.json!.expiresAt, T0 + 15 * MIN);
    let list = (await admin.get('/api/agent-phones')).json!;
    assert.deepEqual(list, [{ id: made.json!.id, label: 'Telephone du poste', pairedAt: null, revokedAt: null, lastSeenAt: null, pending: true }]);
    const svg = await admin.get(`/api/agent-phones/${made.json!.id}/pair.svg`);
    assert.equal(svg.status, 200);
    assert.match(svg.raw.toString(), /<svg/);
    assert.match(svg.headers.get('content-type')!, /^image\/svg\+xml/);
    assert.match(svg.headers.get('content-security-policy')!, /sandbox/);
    assert.equal((await operator.get(`/api/agent-phones/${made.json!.id}/pair.svg`)).status, 403);
    assert.equal((await new Client(admin.base).get(`/api/agent-phones/${made.json!.id}/pair.svg`)).status, 401);
    // Le code est a usage unique : apres l'appairage, plus de QR.
    const code = /#pair=([a-z2-7]{10})$/.exec(made.json!.pairUrl)![1];
    assert.equal((await new Client(admin.base).post('/api/agent/pair', { code })).status, 200);
    assert.equal((await admin.get(`/api/agent-phones/${made.json!.id}/pair.svg`)).status, 404);
    list = (await admin.get('/api/agent-phones')).json!;
    assert.equal(list[0].pending, false);
    assert.equal(list[0].pairedAt, T0);
    assert.equal((await admin.post('/api/agent-phones/9999/revoke')).status, 404);
    assert.equal((await admin.post('/api/agent-phones/abc/revoke')).status, 404);
    assert.equal((await admin.get('/api/agent-phones/abc/pair.svg')).status, 404);
    assert.equal((await admin.post(`/api/agent-phones/${made.json!.id}/revoke`)).status, 200);
    assert.equal((await admin.get('/api/agent-phones')).json![0].revokedAt, T0);
    void h;
  });

  it("le QR d'appairage n'est jamais relu de la base : introuvable après un redémarrage, expiré ou révoqué", async () => {
    const { h, admin } = await web();
    const a = await admin.post('/api/agent-phones', { label: 'A' });
    const b = await admin.post('/api/agent-phones', { label: 'B' });
    const c = await admin.post('/api/agent-phones', { label: 'C' });
    assert.equal((await admin.get(`/api/agent-phones/${a.json!.id}/pair.svg`)).status, 200);
    h.clock.t += 15 * MIN + 1;
    assert.equal((await admin.get(`/api/agent-phones/${a.json!.id}/pair.svg`)).status, 404, 'expire');
    h.clock.t = T0;
    await admin.post(`/api/agent-phones/${b.json!.id}/revoke`);
    assert.equal((await admin.get(`/api/agent-phones/${b.json!.id}/pair.svg`)).status, 404, 'revoque');
    // « Redemarrage » : un nouveau service sur la meme base n'a plus les codes en memoire.
    const restarted = setup();
    void restarted;
    const second = createAgents({ db: h.db, engine: h.engine, users: h.users, now: () => h.clock.t });
    const base2 = await listen({ ...h, agents: second });
    const admin2 = new Client(base2);
    admin2.jar.set('psim_session', h.staffSession('admin'));
    assert.equal((await admin2.get(`/api/agent-phones/${c.json!.id}/pair.svg`)).status, 404);
    // Le code, lui, vaut toujours : le telephone n'a pas besoin du QR pour utiliser son code.
    const code = /#pair=([a-z2-7]{10})$/.exec(c.json!.pairUrl)![1];
    assert.equal(second.pairPhone(code).phone.id, c.json!.id);
  });

  it("incident → qui se déplace : GET /api/incidents/:id/dispatch pour le personnel du poste de garde seulement", async () => {
    const { h, admin, operator, pairedPhone, login } = await web();
    h.makeAgent('moussa');
    h.engine.handleDetectorMessage('D-HALL', { state: 'alarm' });
    const id = h.engine.getSnapshot().incidents[0].id;
    assert.deepEqual((await operator.get(`/api/incidents/${id}/dispatch`)).json, []);
    h.agents.dispatch('moussa', id, 'on_site');
    const res = await admin.get(`/api/incidents/${id}/dispatch`);
    assert.deepEqual(res.json, [{ username: 'moussa', displayName: 'Agent moussa', status: 'on_site', at: T0 }]);
    assert.equal((await admin.get('/api/incidents/9999/dispatch')).status, 404);
    assert.equal((await admin.get('/api/incidents/abc/dispatch')).status, 404);
    assert.equal((await new Client(admin.base).get(`/api/incidents/${id}/dispatch`)).status, 401);
    const { client } = await pairedPhone();
    await login(client);
    assert.equal((await client.get(`/api/incidents/${id}/dispatch`)).status, 403, 'un agent n\'est pas du personnel du poste de garde');
  });
});

describe('HTTP : certificat du PSIM', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psim-agents-'));
  const pem = '-----BEGIN CERTIFICATE-----\nMIIBFAKECERTIFICATEFORTESTSONLY\n-----END CERTIFICATE-----\n';

  it('sans TLS : 404 pour le certificat et son QR', async () => {
    const { admin } = await web();
    assert.equal((await new Client(admin.base).get('/api/agent-cert')).status, 404);
    assert.equal((await admin.get('/api/agent-cert.svg')).status, 404);
  });

  it("avec TLS : certificat public en application/x-x509-ca-cert (sans authentification) ; QR réservé à l'administrateur", async () => {
    const file = join(dir, 'psim.crt');
    writeFileSync(file, pem);
    const { admin, operator } = await web({ certPath: file });
    const res = await new Client(admin.base).get('/api/agent-cert');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/x-x509-ca-cert');
    assert.equal(res.raw.toString(), pem);
    const svg = await admin.get('/api/agent-cert.svg');
    assert.equal(svg.status, 200);
    assert.match(svg.raw.toString(), /<svg/);
    assert.match(svg.headers.get('content-type')!, /^image\/svg\+xml/);
    assert.equal((await operator.get('/api/agent-cert.svg')).status, 403);
    assert.equal((await new Client(admin.base).get('/api/agent-cert.svg')).status, 401);
  });

  it("un fichier absent, vide ou contenant une clé privée n'est jamais servi", async () => {
    const withKey = join(dir, 'avec-cle.pem');
    writeFileSync(withKey, `${pem}-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n`);
    const empty = join(dir, 'vide.crt');
    writeFileSync(empty, '');
    const quiet = console.warn;
    console.warn = () => {};
    try {
      for (const certPath of [withKey, empty, join(dir, 'absent.crt')]) {
        const { admin } = await web({ certPath });
        const res = await new Client(admin.base).get('/api/agent-cert');
        assert.equal(res.status, 404, certPath);
        assert.ok(!res.raw.toString().includes('SECRET'));
        assert.equal((await admin.get('/api/agent-cert.svg')).status, 404);
      }
    } finally {
      console.warn = quiet;
    }
  });
});

describe('journal : aucun secret', () => {
  it("après un parcours complet (appairage, connexions, service, SOS, révocation), aucun code ni clé dans le journal ni dans les réponses d'administration", async () => {
    const { h, admin, pairedPhone, login } = await web();
    h.makeAgent('moussa');
    const { client, id, code } = await pairedPhone();
    const key = client.jar.get(PHONE_COOKIE)!;
    await login(client, 'moussa', '111111');
    await login(client);
    const session = client.jar.get('psim_session')!;
    await client.post('/api/agent/shift/start');
    await client.post('/api/agent/sos', { clientId: 'abcd-1234-efgh', phoneAt: T0, discreet: false });
    const listings = JSON.stringify([(await admin.get('/api/agents')).json, (await admin.get('/api/agent-phones')).json]);
    await admin.post(`/api/agent-phones/${id}/revoke`);
    const everything = JSON.stringify(h.auditRows()) + listings;
    for (const secret of [PIN, '111111', code, key, key.split('_').pop()!, session]) assert.ok(!everything.includes(secret), secret.slice(0, 8));
    const stored = JSON.stringify(h.db.prepare('SELECT * FROM agent_phone').all());
    assert.ok(!stored.includes(key));
    assert.ok(!stored.includes(code));
  });
});

describe('envois d\'un agent précédent (resolveSender)', () => {
  const refusal = (e: unknown) => e instanceof PsimError && e.status === 403 && e.message === "Envoi d'un autre agent refusé";

  it("sans `claimed`, ou identique à la session : la session", () => {
    const h = setup();
    h.makeAgent('moussa');
    const p = h.phone();
    for (const claimed of [undefined, null, '', 'moussa', 'MOUSSA', ' moussa ']) assert.equal(h.agents.resolveSender(p.id, 'moussa', claimed, T0), 'moussa');
  });

  it("un autre agent est accepté s'il a eu un service sur le MÊME téléphone couvrant l'heure du téléphone (± 5 min)", () => {
    const h = setup();
    h.makeAgent('moussa');
    h.makeAgent('fanta');
    const a = h.phone('A');
    const b = h.phone('B');
    h.agents.startShift('fanta', a.id); // T0
    h.clock.t = T0 + 60 * MIN;
    h.agents.endShift('fanta', 'agent'); // fini a T0 + 60 min
    h.agents.startShift('moussa', a.id);
    const who = (phoneId: number, at: number) => h.agents.resolveSender(phoneId, 'moussa', 'fanta', at);
    assert.equal(who(a.id, T0 + 30 * MIN), 'fanta');
    assert.equal(who(a.id, T0 - 5 * MIN), 'fanta', '5 min avant la prise de service');
    assert.equal(who(a.id, T0 + 65 * MIN), 'fanta', '5 min apres la fin');
    assert.throws(() => who(a.id, T0 - 5 * MIN - 1), refusal);
    assert.throws(() => who(a.id, T0 + 65 * MIN + 1), refusal);
    assert.throws(() => who(b.id, T0 + 30 * MIN), refusal, 'service sur un autre telephone');
  });

  it("un service encore ouvert couvre jusqu'à sa fin prévue (+ 5 min)", () => {
    const h = setup();
    h.makeAgent('moussa', { maxShiftMinutes: 60 });
    h.makeAgent('fanta');
    const p = h.phone();
    h.agents.startShift('fanta', p.id);
    assert.equal(h.agents.resolveSender(p.id, 'moussa', 'fanta', T0 + 65 * 60_000), 'fanta');
    assert.throws(() => h.agents.resolveSender(p.id, 'moussa', 'fanta', T0 + 720 * 60_000 + 5 * 60_000 + 1), refusal);
  });

  it("refuse l'agent sans service, inconnu, désactivé ou qui n'en est pas un, et toute valeur illisible", () => {
    const h = setup();
    h.makeAgent('moussa');
    h.makeAgent('fanta');
    const p = h.phone();
    h.agents.startShift('moussa', p.id);
    for (const claimed of ['fanta', 'inconnu', 'admin', 'oscar', 5, {}, [], true]) assert.throws(() => h.agents.resolveSender(p.id, 'moussa', claimed, T0), refusal, String(claimed));
    h.agents.startShift('fanta', p.id);
    for (const at of [Number.NaN, Number.POSITIVE_INFINITY, undefined, null, '2027', {}]) {
      assert.throws(() => h.agents.resolveSender(p.id, 'moussa', 'fanta', at as number), refusal, String(at));
    }
    assert.equal(h.agents.resolveSender(p.id, 'moussa', 'fanta', T0), 'fanta');
    // Le message est exactement celui du contrat.
    assert.throws(() => h.agents.resolveSender(p.id, 'moussa', 'inconnu', T0), (e) => (e as Error).message === "Envoi d'un autre agent refusé");
  });
});

describe('contrôle direct du service', () => {
  it("requireAgent avant mount : erreur explicite plutôt qu'un accès ouvert", () => {
    const h = setup();
    let status_ = 0;
    const req = { headers: {} } as Request;
    const res = { status: (s: number) => ((status_ = s), { json: () => {} }) } as unknown as Response;
    assert.throws(() => h.agents.requireAgent(req, res, () => { status_ = 200; }), status(500));
    assert.equal(status_, 0);
    assert.throws(() => h.agents.agentOf(req), status(500));
  });
});
