import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createAgents } from '../server/agents.ts';
import type { Window } from '../server/arming.ts';
import { getSession, parseCookies, setSessionValidator, useSessionStore } from '../server/auth.ts';
import { openDb } from '../server/db.ts';
import { createUsersService } from '../server/users.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import { createPatrols, RETENTION_DAYS } from '../server/patrols.ts';
import type { PatrolAgents } from '../server/patrols.ts';
import type { MountContext, Role } from '../server/types.ts';

/**
 * Service des rondes (server/patrols.ts) : vraie base `:memory:`, vrai moteur, horloge injectee, faux service des agents
 * (la surface `createAgents` utilisee par le module). Les dates sont construites en heure LOCALE (comme le planning).
 */

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ALL = [0, 1, 2, 3, 4, 5, 6];
const NIGHT: Window[] = [{ days: ALL, from: '22:00', to: '06:00' }];
/** Mercredi 10 juin 2026, a `h`:`m` heure locale (+ `d` jours). */
const at = (h: number, m = 0, d = 0): number => new Date(2026, 5, 10 + d, h, m).getTime();
const T0 = at(21, 0);
const NAMES = ['Parking', 'Arriere-cour', 'Local bouteilles', 'Toiture', 'Cave'];
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 7), Buffer.from([0xff, 0xd9])]);
const status = (code: number) => (e: unknown) => e instanceof PsimError && e.status === code;

type Sent = { id: string; payload: Record<string, unknown> };

function setup(opts: { agentNames?: string[] } = {}) {
  const db = openDb(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'psim-patrols-'));
  const env = { clock: T0 };
  const now = () => env.clock;
  const base = createEngine(db, () => {}, now);
  const sent: Sent[] = [];
  const engine = {
    ...base,
    handleDetectorMessage: (id: string, payload: unknown) => {
      sent.push({ id, payload: payload as Record<string, unknown> });
      base.handleDetectorMessage(id, payload);
    },
  };

  const names = new Set(opts.agentNames ?? ['ali', 'bob']);
  const onShift = new Set<string>(['ali', 'bob']);
  const pos = new Map<string, { checkpointId: number; at: number }>();
  const allowedSenders = new Set<string>(); // `${phoneId}:${username}`
  const asked: { phoneId: number; session: string; claimed: string | undefined; phoneAt: number }[] = [];
  const requests = new WeakMap<Request, { username: string; phoneId: number }>();
  const agents: PatrolAgents = {
    isAgent: (u) => names.has(u),
    detectorId: (u) => {
      const id = `A-${u}`;
      if (!base.getDevice(id)) base.createDevice('systeme', { id, kind: 'detector', name: `Agent ${u}`, zone: '', category: 'people', heartbeatS: 0 });
      return id;
    },
    setPosition: (u, checkpointId, atMs) => {
      if (onShift.has(u)) pos.set(u, { checkpointId, at: atMs });
    },
    positions: () => [...pos].filter(([u]) => onShift.has(u)).map(([u, p]) => ({ username: u, displayName: `Nom ${u}`, checkpointId: p.checkpointId, at: p.at })),
    resolveSender: (phoneId, session, claimed, phoneAt) => {
      asked.push({ phoneId, session, claimed, phoneAt });
      if (claimed === undefined || claimed === session) return session;
      if (!allowedSenders.has(`${phoneId}:${claimed}`)) throw new PsimError(403, "Envoi d'un autre agent refusé");
      return claimed;
    },
    requireAgent: (req, res, next) => {
      const u = req.header('x-test-agent');
      if (!u) return void res.status(401).json({ error: 'Session terminée' });
      requests.set(req, { username: u, phoneId: Number(req.header('x-test-phone') ?? 1) });
      next();
    },
    agentOf: (req) => requests.get(req) as { username: string; phoneId: number },
  };
  const patrols = createPatrols({ db, engine, agents, dataDir: dir, now });
  return { db, dir, env, base, engine, sent, agents, names, onShift, pos, allowedSenders, asked, patrols, count: 0 };
}
type Env = ReturnType<typeof setup>;

let env: Env;
const cleanup: (() => void)[] = [];

beforeEach(() => {
  mock.method(console, 'warn', () => {});
  env = setup();
  cleanup.push(() => rmSync(env.dir, { recursive: true, force: true }));
});
afterEach(() => {
  mock.restoreAll();
  while (cleanup.length > 0) cleanup.pop()?.();
});

const tickAt = (ms: number): void => {
  env.env.clock = ms;
  env.patrols.tick();
};

function makePoints(n = 3, e: Env = env): number[] {
  return NAMES.slice(0, n).map((name, i) => e.patrols.createCheckpoint('chef', { name, zone: `Zone ${i + 1}`, x: 10 + i, y: 20 + i }).id);
}

function makeRoute(ids: number[], over: Record<string, unknown> = {}, e: Env = env) {
  return e.patrols.createRoute('chef', { name: 'Ronde de nuit', checkpoints: ids, maxMinutes: 30, graceMinutes: 10, schedule: NIGHT, ...over });
}

let counter = 0;
function scanOf(cpId: number, o: { user?: string; phoneAt?: number; clientId?: string; method?: string; phoneId?: number; username?: string; code?: string } = {}, e: Env = env) {
  const code = o.code ?? (e.patrols.getCheckpoint(cpId)?.code as string);
  const body: Record<string, unknown> = { clientId: o.clientId ?? `scan-${String(++counter).padStart(8, '0')}`, code, method: o.method ?? 'qr', phoneAt: o.phoneAt ?? e.env.clock };
  if (o.username !== undefined) body.username = o.username;
  return e.patrols.scan(o.user ?? 'ali', o.phoneId ?? 1, body);
}

const incidentsOf = (deviceId: string, e: Env = env) => (e.db.prepare('SELECT id FROM incident WHERE detector_id = ? ORDER BY id').all(deviceId) as { id: number }[]).map((r) => e.base.incidentView(r.id));
const auditActions = (action: string, e: Env = env) => e.base.listAudit(500).filter((a) => a.action === action);
const runRows = (e: Env = env) => e.db.prepare('SELECT * FROM patrol_run ORDER BY due_start').all() as Record<string, unknown>[];
const eventsOf = (deviceId: string, e: Env = env) => e.sent.filter((s) => s.id === deviceId).map((s) => s.payload.event);

// ------------------------------------------------------------------ points de controle

describe('points de controle', () => {
  it('cree un point : code base32 de 10 caracteres, unique, normalise le nom', () => {
    const a = env.patrols.createCheckpoint('chef', { name: '  Parking ', zone: ' Cour ', x: 12.5, y: 80 });
    assert.equal(a.name, 'Parking');
    assert.equal(a.zone, 'Cour');
    assert.equal(a.x, 12.5);
    assert.equal(a.archivedAt, null);
    assert.match(a.code as string, /^[a-z2-7]{10}$/);
    const b = env.patrols.createCheckpoint('chef', { name: 'Cave' });
    assert.notEqual(a.code, b.code);
    assert.equal(b.x, 50); // valeurs par defaut
    assert.equal(b.zone, '');
    assert.equal(auditActions('checkpoint_created').length, 2);
  });

  it("le code d'etiquette n'est jamais ecrit dans le journal d'audit", () => {
    const a = env.patrols.createCheckpoint('chef', { name: 'Parking' });
    env.patrols.recodeCheckpoint('chef', a.id);
    const code = env.patrols.getCheckpoint(a.id)?.code as string;
    assert.ok(env.base.listAudit(500).every((e) => !(e.details ?? '').includes(code) && !(e.details ?? '').includes(a.code as string)));
  });

  it('place le point sur l\'etage par defaut, ou refuse un etage inconnu', () => {
    const floor = (env.db.prepare('SELECT id FROM floor ORDER BY position, id LIMIT 1').get() as { id: number }).id;
    assert.equal(env.patrols.createCheckpoint('chef', { name: 'A' }).floorId, floor);
    assert.throws(() => env.patrols.createCheckpoint('chef', { name: 'B', floorId: 9999 }), status(400));
    assert.throws(() => env.patrols.createCheckpoint('chef', { name: 'B', floorId: '1' }), status(400));
    assert.throws(() => env.patrols.createCheckpoint('chef', { name: 'B', floorId: null }), status(400));
  });

  it('valide les champs : nom, zone, coordonnees, champs inconnus, corps', () => {
    const bad = (input: unknown, code = 400) => assert.throws(() => env.patrols.createCheckpoint('chef', input), status(code));
    bad({});
    bad({ name: '' });
    bad({ name: '   ' });
    bad({ name: 12 });
    bad({ name: 'x'.repeat(81) });
    bad({ name: 'Parking\n2' });
    bad({ name: 'Park\u202eing' });
    bad({ name: 'A', zone: 'z'.repeat(81) });
    bad({ name: 'A', zone: 3 });
    bad({ name: 'A', zone: 'Z\u0000' });
    bad({ name: 'A', x: -1 });
    bad({ name: 'A', y: 101 });
    bad({ name: 'A', x: '5' });
    bad({ name: 'A', x: Number.NaN });
    bad({ name: 'A', code: 'aaaaaaaaaa' }); // le code ne se choisit pas
    bad({ name: 'A', archivedAt: 1 });
    bad([1]);
    bad('texte');
    assert.equal(env.patrols.listCheckpoints().length, 0);
  });

  it('refuse deux points actifs du meme nom (casse ignoree), mais pas un nom d\'archive', () => {
    const a = env.patrols.createCheckpoint('chef', { name: 'Parking' });
    assert.throws(() => env.patrols.createCheckpoint('chef', { name: 'parking' }), status(409));
    env.patrols.archiveCheckpoint('chef', a.id);
    assert.equal(env.patrols.createCheckpoint('chef', { name: 'Parking' }).name, 'Parking');
  });

  it('modifie un point (partiel) et signale les rien-a-modifier', () => {
    const a = env.patrols.createCheckpoint('chef', { name: 'Parking', zone: 'Cour' });
    const b = env.patrols.updateCheckpoint('chef', a.id, { x: 70, y: 30 });
    assert.deepEqual([b.x, b.y, b.name, b.zone, b.code], [70, 30, 'Parking', 'Cour', a.code]);
    assert.equal(env.patrols.updateCheckpoint('chef', a.id, { name: 'Garage' }).name, 'Garage');
    assert.equal(auditActions('checkpoint_updated').length, 2);
    // inchange : pas d'entree de journal en plus
    env.patrols.updateCheckpoint('chef', a.id, { name: 'Garage' });
    assert.equal(auditActions('checkpoint_updated').length, 2);
    assert.throws(() => env.patrols.updateCheckpoint('chef', a.id, {}), status(400));
    assert.throws(() => env.patrols.updateCheckpoint('chef', a.id, { code: 'aaaaaaaaaa' }), status(400));
    assert.throws(() => env.patrols.updateCheckpoint('chef', a.id, { x: 120 }), status(400));
    assert.throws(() => env.patrols.updateCheckpoint('chef', 999, { x: 1 }), status(404));
    const c = env.patrols.createCheckpoint('chef', { name: 'Cave' });
    assert.throws(() => env.patrols.updateCheckpoint('chef', c.id, { name: 'garage' }), status(409));
  });

  it('recode : un nouveau code, l\'ancien devient inconnu', () => {
    const [id] = makePoints(1);
    const old = env.patrols.getCheckpoint(id)?.code as string;
    const fresh = env.patrols.recodeCheckpoint('chef', id);
    assert.notEqual(fresh.code, old);
    assert.match(fresh.code as string, /^[a-z2-7]{10}$/);
    assert.throws(() => scanOf(id, { code: old }), status(404));
    assert.equal(scanOf(id).scan.verdict, 'no_run');
    assert.throws(() => env.patrols.recodeCheckpoint('chef', 999), status(404));
    assert.equal(auditActions('checkpoint_recoded').length, 1);
  });

  it('archive sans jamais supprimer : la ligne reste, le code devient inconnu, la liste l\'ignore', () => {
    const [a, b] = makePoints(2);
    const code = env.patrols.getCheckpoint(a)?.code as string;
    env.patrols.archiveCheckpoint('chef', a);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM checkpoint').get()?.n, 2);
    assert.deepEqual(env.patrols.listCheckpoints().map((c) => c.id), [b]);
    assert.deepEqual(env.patrols.listCheckpoints({ includeArchived: true }).map((c) => c.id), [a, b]);
    assert.ok((env.patrols.getCheckpoint(a)?.archivedAt ?? 0) > 0);
    assert.throws(() => scanOf(a, { code }), status(404));
    assert.throws(() => env.patrols.archiveCheckpoint('chef', a), status(404));
    assert.throws(() => env.patrols.updateCheckpoint('chef', a, { x: 1 }), status(404));
    assert.throws(() => env.patrols.recodeCheckpoint('chef', a), status(404));
    assert.equal(auditActions('checkpoint_archived').length, 1);
  });

  it('refuse d\'archiver un point utilise par un circuit (meme desactive), l\'autorise une fois retire', () => {
    const ids = makePoints(3);
    const route = makeRoute(ids.slice(0, 2));
    assert.throws(() => env.patrols.archiveCheckpoint('chef', ids[0]), status(409));
    env.patrols.updateRoute('chef', route.id, { enabled: false });
    assert.throws(() => env.patrols.archiveCheckpoint('chef', ids[0]), status(409));
    env.patrols.archiveCheckpoint('chef', ids[2]); // hors circuit : permis
    env.patrols.archiveRoute('chef', route.id);
    env.patrols.archiveCheckpoint('chef', ids[0]); // circuit archive : permis
  });
});

// ------------------------------------------------------------------ circuits et detecteur P-

describe('circuits', () => {
  it('cree un circuit et son detecteur virtuel P-<id> sur le premier point', () => {
    const ids = makePoints(3);
    const route = makeRoute(ids, { ordered: true });
    assert.equal(route.id, 1);
    assert.equal(route.deviceId, 'P-1');
    assert.deepEqual(route.checkpoints, ids);
    assert.equal(route.ordered, true);
    assert.equal(route.enabled, true);
    assert.equal(route.graceMinutes, 10);
    const d = env.base.getDevice('P-1');
    assert.ok(d);
    assert.equal(d.kind, 'detector');
    assert.equal(d.category, 'people');
    assert.equal(d.heartbeatS, 0);
    assert.equal(d.name, 'Ronde de nuit');
    assert.equal(d.zone, 'Zone 1');
    assert.equal(d.x, 10);
    assert.equal(d.y, 20);
    assert.equal(auditActions('patrol_route_created').length, 1);
  });

  it('applique les valeurs par defaut (grace 10 min, non ordonne, actif, tout agent)', () => {
    const ids = makePoints(2);
    const r = env.patrols.createRoute('chef', { name: 'R', checkpoints: ids, maxMinutes: 20, schedule: NIGHT });
    assert.deepEqual([r.ordered, r.graceMinutes, r.enabled, r.agents], [false, 10, true, []]);
  });

  it('valide strictement chaque champ', () => {
    const ids = makePoints(3);
    const ok = { name: 'R', checkpoints: ids, maxMinutes: 30, schedule: NIGHT };
    const bad = (over: Record<string, unknown>, code = 400) => assert.throws(() => env.patrols.createRoute('chef', { ...ok, ...over }), status(code));
    bad({ name: '' });
    bad({ name: 'x'.repeat(81) });
    bad({ name: 'R\r\nX' });
    bad({ checkpoints: [] });
    bad({ checkpoints: 'a' });
    bad({ checkpoints: [ids[0], ids[0]] }); // point en double
    bad({ checkpoints: [ids[0], 9999] });
    bad({ checkpoints: [ids[0], '2'] });
    bad({ checkpoints: [ids[0], 1.5] });
    bad({ checkpoints: [0] });
    bad({ checkpoints: Array.from({ length: 101 }, (_, i) => i + 1) });
    bad({ maxMinutes: 0 });
    bad({ maxMinutes: 1441 });
    bad({ maxMinutes: 1.5 });
    bad({ maxMinutes: '30' });
    bad({ maxMinutes: undefined });
    bad({ graceMinutes: -1 });
    bad({ graceMinutes: 241 });
    bad({ graceMinutes: 2.5 });
    bad({ schedule: undefined });
    bad({ schedule: [] });
    bad({ schedule: 'nuit' });
    bad({ schedule: [{ days: [], from: '22:00', to: '06:00' }] });
    bad({ schedule: [{ days: [7], from: '22:00', to: '06:00' }] });
    bad({ schedule: [{ days: [1], from: '25:00', to: '06:00' }] });
    bad({ schedule: [{ days: [1], from: '22:00', to: '22:00' }] });
    bad({ agents: ['inconnu'] });
    bad({ agents: 'ali' });
    bad({ agents: [3] });
    bad({ ordered: 'oui' });
    bad({ enabled: 1 });
    bad({ unknown: true });
    assert.throws(() => env.patrols.createRoute('chef', 'x'), status(400));
    assert.throws(() => env.patrols.createRoute('chef', [ok]), status(400));
    assert.equal(env.patrols.listRoutes().length, 0);
    assert.equal(env.base.getDevice('P-1'), null);
  });

  it('refuse un point archive, accepte des agents existants (sans doublon)', () => {
    const ids = makePoints(3);
    env.patrols.archiveCheckpoint('chef', ids[2]);
    assert.throws(() => makeRoute(ids), status(400));
    const r = makeRoute(ids.slice(0, 2), { agents: ['ali', 'bob', 'ali'] });
    assert.deepEqual(r.agents, ['ali', 'bob']);
  });

  it('normalise le planning (jours tries sans doublon)', () => {
    const ids = makePoints(2);
    const r = makeRoute(ids, { schedule: [{ days: [3, 1, 3], from: '22:00', to: '06:00' }] });
    assert.deepEqual(r.schedule, [{ days: [1, 3], from: '22:00', to: '06:00' }]);
  });

  it('un nom de route est libre, deux circuits peuvent avoir le meme (detecteurs P-1 et P-2)', () => {
    const ids = makePoints(2);
    makeRoute(ids);
    const b = makeRoute(ids);
    assert.equal(b.id, 2);
    assert.ok(env.base.getDevice('P-2'));
  });

  it('un identifiant P-n deja pris par un detecteur n\'est pas reutilise', () => {
    env.base.createDevice('chef', { id: 'P-1', kind: 'detector', name: 'Reste', zone: '', category: 'people', heartbeatS: 0 });
    const ids = makePoints(2);
    assert.equal(makeRoute(ids).id, 2);
  });

  it('modifie un circuit : renomme le detecteur, deplace avec le premier point, journalise', () => {
    const ids = makePoints(3);
    const r = makeRoute(ids);
    env.patrols.updateRoute('chef', r.id, { name: 'Ronde du soir' });
    assert.equal(env.base.getDevice('P-1')?.name, 'Ronde du soir');
    const moved = env.patrols.updateRoute('chef', r.id, { checkpoints: [ids[2], ids[1]], ordered: true, maxMinutes: 45, graceMinutes: 0 });
    assert.deepEqual([moved.checkpoints, moved.ordered, moved.maxMinutes, moved.graceMinutes], [[ids[2], ids[1]], true, 45, 0]);
    const d = env.base.getDevice('P-1');
    assert.equal(d?.zone, 'Zone 3');
    assert.equal(d?.x, 12);
    assert.equal(auditActions('patrol_route_updated').length, 2);
    // inchange : rien
    env.patrols.updateRoute('chef', r.id, { name: 'Ronde du soir' });
    assert.equal(auditActions('patrol_route_updated').length, 2);
    assert.throws(() => env.patrols.updateRoute('chef', r.id, {}), status(400));
    assert.throws(() => env.patrols.updateRoute('chef', r.id, { checkpoints: [] }), status(400));
    assert.throws(() => env.patrols.updateRoute('chef', 99, { name: 'x' }), status(404));
    assert.throws(() => env.patrols.updateRoute('chef', r.id, { id: 5 }), status(400));
  });

  it("deplacer un point deplace le detecteur des circuits qui commencent par lui, mais pas le deplacement manuel d'un autre", () => {
    const ids = makePoints(2);
    makeRoute(ids);
    env.patrols.updateCheckpoint('chef', ids[0], { x: 90, y: 91, zone: 'Nord' });
    const d = env.base.getDevice('P-1');
    assert.deepEqual([d?.x, d?.y, d?.zone], [90, 91, 'Nord']);
    env.base.updateDevice('chef', 'P-1', { x: 5, y: 5 }); // l'administrateur le place a la main
    env.patrols.updateCheckpoint('chef', ids[1], { x: 33 }); // 2e point : le detecteur ne bouge pas
    assert.deepEqual([env.base.getDevice('P-1')?.x, env.base.getDevice('P-1')?.y], [5, 5]);
  });

  it('une zone deja prise a un autre etage : detecteur cree sans zone, sans echec', () => {
    env.db.prepare("INSERT INTO floor (name, position) VALUES ('Etage 1', 1)").run();
    const upper = (env.db.prepare("SELECT id FROM floor WHERE name = 'Etage 1'").get() as { id: number }).id;
    env.base.createDevice('chef', { id: 'X-1', kind: 'detector', name: 'Hall haut', zone: 'Hall', floorId: upper, category: 'access', heartbeatS: 0 });
    const cp = env.patrols.createCheckpoint('chef', { name: 'Entree', zone: 'Hall' }); // etage le plus bas
    const route = makeRoute([cp.id]);
    assert.equal(env.base.getDevice(`P-${route.id}`)?.zone, '');
  });

  it("archive un circuit : detecteur supprime s'il n'a aucun incident, sinon conserve", () => {
    const ids = makePoints(3);
    const a = makeRoute(ids);
    env.patrols.archiveRoute('chef', a.id);
    assert.equal(env.base.getDevice('P-1'), null);
    assert.deepEqual(env.patrols.listRoutes().map((r) => r.id), []);
    assert.ok((env.patrols.listRoutes({ includeArchived: true })[0].archivedAt ?? 0) > 0);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM patrol_route').get()?.n, 1); // jamais supprime en dur
    assert.throws(() => env.patrols.archiveRoute('chef', a.id), status(404));
    assert.throws(() => env.patrols.updateRoute('chef', a.id, { name: 'x' }), status(404));

    const b = makeRoute(ids);
    tickAt(at(22, 0));
    tickAt(at(22, 30)); // ronde ratee : incident
    assert.equal(incidentsOf(`P-${b.id}`).length, 1);
    env.patrols.archiveRoute('chef', b.id);
    assert.ok(env.base.getDevice(`P-${b.id}`)); // historique d'incidents : conserve
    assert.equal(env.base.getDevice(`P-${b.id}`)?.status, 'normal'); // et remis au calme
    assert.equal(auditActions('patrol_route_archived').length, 2);
  });
});

// ------------------------------------------------------------------ tick : creation et issue des rondes

describe('rondes : creation et issue', () => {
  it('cree la ronde a l\'heure de debut de plage (heure locale), pas avant', () => {
    const ids = makePoints(3);
    makeRoute(ids);
    tickAt(at(21, 59));
    assert.equal(runRows().length, 0);
    tickAt(at(22, 0));
    const [run] = runRows();
    assert.equal(run.due_start, at(22, 0));
    assert.equal(run.due_end, at(22, 30));
    assert.equal(run.status, 'pending');
    tickAt(at(22, 1));
    tickAt(at(22, 2));
    assert.equal(runRows().length, 1); // pas de doublon
  });

  it('ne cree que les jours du planning', () => {
    const ids = makePoints(2);
    env.env.clock = at(20, 0, 3); // samedi 13 juin
    makeRoute(ids, { schedule: [{ days: [1, 2, 3, 4, 5], from: '22:00', to: '06:00' }] });
    tickAt(at(22, 0, 3));
    tickAt(at(22, 0, 4)); // dimanche
    assert.equal(runRows().length, 0);
    tickAt(at(22, 0, 5)); // lundi 15
    assert.equal(runRows().length, 1);
    assert.equal(runRows()[0].due_start, at(22, 0, 5));
  });

  it('plusieurs plages : une ronde a chaque heure de debut', () => {
    const ids = makePoints(2);
    makeRoute(ids, { maxMinutes: 20, schedule: [{ days: ALL, from: '22:00', to: '23:00' }, { days: ALL, from: '02:00', to: '03:00' }] });
    for (const t of [at(22, 0), at(22, 30), at(23, 0), at(2, 0, 1)]) tickAt(t);
    assert.deepEqual(runRows().map((r) => r.due_start), [at(22, 0), at(2, 0, 1)]);
  });

  it('un circuit cree a l\'instant ne rattrape pas les debuts passes', () => {
    const ids = makePoints(2);
    env.env.clock = at(22, 10); // 10 min apres le debut de la plage
    makeRoute(ids);
    tickAt(at(22, 11));
    assert.equal(runRows().length, 0);
    tickAt(at(22, 40));
    assert.equal(incidentsOf('P-1').length, 0);
  });

  it('ronde complete : active au premier scan, faite au dernier, aucun incident, une entree d\'audit', () => {
    const ids = makePoints(3);
    makeRoute(ids);
    tickAt(at(22, 0));
    tickAt(at(22, 5));
    const first = scanOf(ids[0]);
    assert.equal(first.scan.verdict, 'ok');
    assert.equal(first.scan.run?.status, 'active');
    assert.equal(runRows()[0].started_by, 'ali');
    tickAt(at(22, 10));
    scanOf(ids[1]);
    tickAt(at(22, 15));
    const last = scanOf(ids[2]);
    assert.equal(last.scan.run?.status, 'done');
    assert.deepEqual(last.scan.run?.checkpoints.map((c) => c.done), [true, true, true]);
    assert.equal(runRows()[0].status, 'done');
    assert.equal(runRows()[0].finished_at, at(22, 15));
    tickAt(at(22, 31));
    tickAt(at(22, 50));
    assert.equal(incidentsOf('P-1').length, 0);
    assert.equal(env.base.getDevice('P-1')?.status, 'normal');
    assert.equal(auditActions('patrol_run_closed').length, 1);
    const entry = auditActions('patrol_run_closed')[0];
    assert.equal(entry.actor, 'systeme');
    assert.equal(entry.deviceId, 'P-1');
    assert.match(entry.details ?? '', /faite \(3\/3 points\)/);
    // jamais une entree d'audit par scan
    assert.equal(env.base.listAudit(500).filter((a) => /scan/.test(a.action)).length, 0);
  });

  it('ronde incomplete : pre-alarme a l\'echeance avec le detail, critique apres la grace', () => {
    const ids = makePoints(3);
    makeRoute(ids);
    tickAt(at(22, 0));
    tickAt(at(22, 5));
    scanOf(ids[0]);
    tickAt(at(22, 29));
    assert.equal(incidentsOf('P-1').length, 0);
    tickAt(at(22, 30));
    const [incident] = incidentsOf('P-1');
    assert.equal(incident.severity, 'warning');
    assert.equal(incident.event, 'patrol_incomplete');
    assert.equal(incident.detail, '2 points manques : Arriere-cour, Local bouteilles');
    assert.equal(env.base.getDevice('P-1')?.status, 'prealarm');
    assert.equal(runRows()[0].status, 'incomplete');
    assert.equal(auditActions('patrol_run_closed').length, 0); // pas encore terminee
    tickAt(at(22, 39));
    assert.equal(incidentsOf('P-1')[0].severity, 'warning');
    tickAt(at(22, 40));
    const [escalated] = incidentsOf('P-1');
    assert.equal(escalated.id, incident.id);
    assert.equal(escalated.severity, 'critical');
    assert.equal(escalated.event, 'patrol_missed');
    assert.equal(escalated.detail, '2 points manques : Arriere-cour, Local bouteilles');
    assert.equal(env.base.getDevice('P-1')?.status, 'alarm');
    assert.equal(runRows()[0].status, 'missed');
    assert.equal(auditActions('patrol_run_closed').length, 1);
    assert.match(auditActions('patrol_run_closed')[0].details ?? '', /non faite \(1\/3 points\)/);
    // pas d'evenement en double ensuite
    tickAt(at(22, 41));
    tickAt(at(23, 30));
    assert.deepEqual(eventsOf('P-1'), ['patrol_incomplete', 'patrol_missed']);
  });

  it('ronde ratee : alarme critique des l\'echeance, detail « aucun point scanne »', () => {
    const ids = makePoints(3);
    makeRoute(ids);
    tickAt(at(22, 0));
    tickAt(at(22, 29));
    assert.equal(incidentsOf('P-1').length, 0);
    tickAt(at(22, 30));
    const [incident] = incidentsOf('P-1');
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.event, 'patrol_missed');
    assert.equal(incident.detail, 'aucun point scanne (3 points)');
    assert.equal(runRows()[0].status, 'missed');
    assert.equal(auditActions('patrol_run_closed').length, 1);
    // les evenements de ronde ne sont jamais masques (toujours actifs)
    assert.equal(env.base.getDevice('P-1')?.status, 'alarm');
  });

  it('detail : trois noms puis des points de suspension, singulier pour un seul point', () => {
    const ids = makePoints(5);
    makeRoute(ids);
    tickAt(at(22, 0));
    scanOf(ids[0], { phoneAt: at(22, 1) });
    tickAt(at(22, 30));
    assert.equal(incidentsOf('P-1')[0].detail, '4 points manques : Arriere-cour, Local bouteilles, Toiture, ...');
    // une autre ronde, un seul point manque
    const e2 = setup();
    cleanup.push(() => rmSync(e2.dir, { recursive: true, force: true }));
    const p2 = makePoints(3, e2);
    makeRoute(p2, {}, e2);
    e2.env.clock = at(22, 0);
    e2.patrols.tick();
    scanOf(p2[0], { phoneAt: at(22, 1) }, e2);
    scanOf(p2[1], { phoneAt: at(22, 1) }, e2);
    e2.env.clock = at(22, 30);
    e2.patrols.tick();
    assert.equal(incidentsOf('P-1', e2)[0].detail, '1 point manque : Local bouteilles');
  });

  it('un scan qui complete la ronde incomplete remet le detecteur au calme', () => {
    const ids = makePoints(3);
    makeRoute(ids);
    tickAt(at(22, 0));
    scanOf(ids[0], { phoneAt: at(22, 1) });
    tickAt(at(22, 30));
    assert.equal(env.base.getDevice('P-1')?.status, 'prealarm');
    env.env.clock = at(22, 33);
    scanOf(ids[1]);
    assert.equal(env.base.getDevice('P-1')?.status, 'prealarm');
    env.env.clock = at(22, 35);
    const r = scanOf(ids[2]);
    assert.equal(r.scan.verdict, 'ok');
    assert.equal(r.scan.run?.status, 'done');
    assert.equal(env.base.getDevice('P-1')?.status, 'normal');
    assert.deepEqual(eventsOf('P-1'), ['patrol_incomplete', 'clear']);
    // pas de ronde ratee ensuite
    tickAt(at(22, 45));
    assert.deepEqual(eventsOf('P-1'), ['patrol_incomplete', 'clear']);
    assert.equal(auditActions('patrol_run_closed').length, 1);
    // l'incident reste a traiter par l'exploitation : le detecteur est calme, on peut le cloturer
    const [incident] = incidentsOf('P-1');
    assert.notEqual(incident.status, 'closed');
    assert.equal(env.base.close(incident.id, 'chef', 'false_alarm', null).status, 'closed');
  });

  it('une ronde ratee rattrapee par des scans differes complete la ronde et rend le calme', () => {
    const ids = makePoints(3);
    makeRoute(ids);
    tickAt(at(22, 0));
    tickAt(at(22, 30));
    assert.equal(env.base.getDevice('P-1')?.status, 'alarm');
    env.env.clock = at(22, 50);
    // telephone hors reseau pendant la ronde : trois passages a 22:10, 22:15, 22:20 recus a 22:50
    const results = ids.map((id, i) => scanOf(id, { phoneAt: at(22, 10 + 5 * i) }));
    assert.deepEqual(results.map((r) => r.scan.verdict), ['ok', 'ok', 'ok']);
    assert.ok(results.every((r) => r.scan.deferred === true));
    assert.equal(results[2].scan.run?.status, 'done');
    assert.equal(env.base.getDevice('P-1')?.status, 'normal');
    assert.equal(runRows()[0].finished_at, at(22, 20));
    assert.deepEqual(results[2].scan.run?.checkpoints.map((c) => c.doneAt), [at(22, 10), at(22, 15), at(22, 20)]);
  });

  it("n'envoie pas « ronde incomplete » quand le detecteur est deja en alarme", () => {
    const ids = makePoints(2);
    makeRoute(ids, { schedule: [{ days: ALL, from: '22:00', to: '23:59' }, { days: ALL, from: '22:20', to: '23:59' }], graceMinutes: 5 });
    tickAt(at(22, 0));
    tickAt(at(22, 20));
    tickAt(at(22, 30)); // ronde de 22:00 : rien scanne -> ratee -> alarme
    assert.equal(env.base.getDevice('P-1')?.status, 'alarm');
    env.env.clock = at(22, 35);
    scanOf(ids[0]); // compte pour la ronde de 22:20 (celle de 22:00 est ratee, un scan en direct ne la rattrape pas)
    tickAt(at(22, 50)); // ronde de 22:20 incomplete
    assert.equal(runRows()[1].status, 'incomplete');
    assert.deepEqual(eventsOf('P-1'), ['patrol_missed']);
    assert.equal(env.base.getDevice('P-1')?.status, 'alarm');
    tickAt(at(22, 55)); // grace passee : ratee, evenement critique (pas de retrogradation, juste l'evenement)
    assert.deepEqual(eventsOf('P-1'), ['patrol_missed', 'patrol_missed']);
  });

  it('grace a zero : incomplete puis ratee au meme instant', () => {
    const ids = makePoints(2);
    makeRoute(ids, { graceMinutes: 0 });
    tickAt(at(22, 0));
    scanOf(ids[0], { phoneAt: at(22, 1) });
    tickAt(at(22, 30));
    assert.equal(incidentsOf('P-1')[0].severity, 'critical');
    assert.equal(runRows()[0].status, 'missed');
    assert.deepEqual(eventsOf('P-1'), ['patrol_incomplete', 'patrol_missed']);
  });

  it('un scan avant le debut (15 min) cree la ronde ; le tick qui suit ne la recree pas', () => {
    const ids = makePoints(2);
    makeRoute(ids);
    env.env.clock = at(21, 50);
    const r = scanOf(ids[0]);
    assert.equal(r.scan.verdict, 'ok');
    assert.equal(r.scan.run?.status, 'active');
    assert.equal(r.scan.run?.dueStart, at(22, 0));
    assert.equal(runRows().length, 1);
    tickAt(at(22, 0));
    tickAt(at(22, 1));
    assert.equal(runRows().length, 1);
    assert.equal(runRows()[0].status, 'active');
    // trop tot : plus de 15 min avant
    env.env.clock = at(21, 30);
    const e2 = setup();
    cleanup.push(() => rmSync(e2.dir, { recursive: true, force: true }));
    const p = makePoints(2, e2);
    makeRoute(p, {}, e2);
    e2.env.clock = at(21, 40);
    assert.equal(scanOf(p[0], {}, e2).scan.verdict, 'no_run');
  });

  it("un circuit desactive ne cree plus de rondes ; la reactivation n'evalue pas la periode d'arret", () => {
    const ids = makePoints(2);
    const route = makeRoute(ids);
    tickAt(at(22, 0));
    tickAt(at(22, 30));
    assert.equal(env.base.getDevice('P-1')?.status, 'alarm');
    const updated = env.patrols.updateRoute('chef', route.id, { enabled: false });
    assert.equal(updated.enabled, false);
    assert.equal(env.base.getDevice('P-1')?.status, 'normal'); // clear
    tickAt(at(23, 0));
    tickAt(at(2, 0, 1));
    assert.equal(runRows().length, 1);
    // une ronde ouverte au moment de la desactivation est close sans alarme
    env.patrols.updateRoute('chef', route.id, { enabled: true });
    tickAt(at(2, 5, 1));
    assert.deepEqual(eventsOf('P-1'), ['patrol_missed', 'clear']);
    tickAt(at(22, 0, 1)); // nouvelle ronde, normale
    assert.equal(runRows().length, 2);
    assert.equal(runRows()[1].status, 'pending');
  });

  it('desactiver pendant une ronde en cours : abandonnee, pas d\'alarme fantome a la reactivation', () => {
    const ids = makePoints(3);
    const route = makeRoute(ids);
    tickAt(at(22, 0));
    scanOf(ids[0], { phoneAt: at(22, 1) });
    env.patrols.updateRoute('chef', route.id, { enabled: false });
    assert.equal(runRows()[0].status, 'missed');
    assert.match(auditActions('patrol_route_updated')[0].details ?? '', /1 ronde en cours abandonnee/);
    env.env.clock = at(23, 0);
    env.patrols.updateRoute('chef', route.id, { enabled: true });
    tickAt(at(23, 1));
    tickAt(at(23, 30));
    assert.deepEqual(eventsOf('P-1'), []);
    assert.equal(incidentsOf('P-1').length, 0);
  });

  it('modifier le circuit pendant une ronde la poursuit avec le nouveau jeu de points', () => {
    const ids = makePoints(3);
    const route = makeRoute(ids);
    tickAt(at(22, 0));
    scanOf(ids[0], { phoneAt: at(22, 1) });
    env.env.clock = at(22, 5);
    env.patrols.updateRoute('chef', route.id, { checkpoints: [ids[0], ids[1]], graceMinutes: 5 });
    const r = scanOf(ids[1]);
    assert.equal(r.scan.run?.status, 'done');
    assert.equal(r.scan.verdict, 'ok');
  });

  it('un circuit restreint a certains agents ignore les autres', () => {
    const ids = makePoints(2);
    makeRoute(ids, { agents: ['bob'] });
    tickAt(at(22, 0));
    assert.equal(scanOf(ids[0], { user: 'ali' }).scan.verdict, 'no_run');
    assert.equal(scanOf(ids[0], { user: 'bob' }).scan.verdict, 'ok');
  });
});

// ------------------------------------------------------------------ scans

describe('scans', () => {
  it('rend les verdicts : hors circuit, hors ordre, doublon, sans ronde', () => {
    const ids = makePoints(4);
    makeRoute(ids.slice(0, 3), { ordered: true });
    assert.equal(scanOf(ids[0]).scan.verdict, 'no_run'); // avant toute ronde
    tickAt(at(22, 0));
    const outOfOrder = scanOf(ids[1]);
    assert.equal(outOfOrder.scan.verdict, 'out_of_order');
    assert.equal(outOfOrder.scan.run?.status, 'pending'); // ne compte pas
    assert.equal(outOfOrder.scan.run?.checkpoints[1].done, false);
    assert.equal(scanOf(ids[3]).scan.verdict, 'out_of_route');
    assert.equal(scanOf(ids[0]).scan.verdict, 'ok');
    assert.equal(scanOf(ids[0]).scan.verdict, 'duplicate');
    assert.equal(scanOf(ids[1]).scan.verdict, 'ok'); // maintenant dans l'ordre
    const rows = env.db.prepare('SELECT verdict, run_id FROM patrol_scan ORDER BY id').all() as { verdict: string; run_id: number | null }[];
    assert.deepEqual(rows.map((r) => r.verdict), ['no_run', 'out_of_order', 'out_of_route', 'ok', 'duplicate', 'ok']);
  });

  it('un verdict non ok sans ronde enregistre le scan avec un run_id vide', () => {
    const ids = makePoints(2);
    makeRoute(ids);
    const r = scanOf(ids[0]);
    assert.equal(r.scan.verdict, 'no_run');
    assert.equal(r.scan.run, null);
    const row = env.db.prepare('SELECT run_id, verdict FROM patrol_scan').get() as { run_id: unknown; verdict: string };
    assert.equal(row.run_id, null);
    // un scan avant la creation de la ronde, hors circuit : verdict non ok sur une ronde inexistante -> run_id vide aussi
    const outside = env.patrols.createCheckpoint('chef', { name: 'Hors circuit' });
    env.env.clock = at(21, 50);
    const out = scanOf(outside.id);
    assert.equal(out.scan.verdict, 'out_of_route');
    assert.equal(out.scan.run, null);
    assert.equal((env.db.prepare('SELECT run_id FROM patrol_scan ORDER BY id DESC LIMIT 1').get() as { run_id: unknown }).run_id, null);
  });

  it('un point archive ou un code inconnu : 404 « Etiquette inconnue », rien d\'enregistre', () => {
    const [id] = makePoints(1);
    for (const code of ['zzzzzzzzzz', '', 'abc', 'ABCDEFGHIJ', 'a'.repeat(11), '../../etc/pw']) {
      assert.throws(() => scanOf(id, { code }), (e: unknown) => e instanceof PsimError && e.status === 404 && /Etiquette inconnue/.test(e.message));
    }
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM patrol_scan').get()?.n, 0);
    assert.equal(env.pos.size, 0);
  });

  it('accepte le code tape en majuscules ou avec des espaces (saisie manuelle)', () => {
    const [id] = makePoints(1);
    const code = env.patrols.getCheckpoint(id)?.code as string;
    assert.equal(scanOf(id, { code: ` ${code.toUpperCase()} `, method: 'manual' }).scan.checkpoint.id, id);
  });

  it('valide clientId, methode, heure du telephone', () => {
    const [id] = makePoints(1);
    const code = env.patrols.getCheckpoint(id)?.code as string;
    const send = (over: Record<string, unknown>) => env.patrols.scan('ali', 1, { clientId: 'abcdefgh-1', code, method: 'qr', phoneAt: env.env.clock, ...over });
    for (const clientId of ['court', 'x'.repeat(65), 'avec espace 123', 'a/b/c/d/e/f', 12345678, undefined, null]) assert.throws(() => send({ clientId }), status(400));
    for (const method of ['gps', '', 3, undefined]) assert.throws(() => send({ method }), status(400));
    for (const phoneAt of ['now', Number.NaN, undefined, null, env.env.clock + 5 * MIN + 1000, env.env.clock - DAY - 1000]) assert.throws(() => send({ phoneAt }), status(400));
    assert.throws(() => env.patrols.scan('ali', 1, 'x'), status(400));
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM patrol_scan').get()?.n, 0);
    // bornes acceptees : 5 min dans le futur, 24 h dans le passe
    assert.equal(send({ clientId: 'abcdefgh-2', phoneAt: env.env.clock + 5 * MIN }).scan.deferred, false);
    assert.equal(send({ clientId: 'abcdefgh-3', phoneAt: env.env.clock - DAY }).scan.deferred, true);
  });

  it('deferred : plus de 2 min d\'ecart entre l\'heure du telephone et celle du serveur', () => {
    const [id] = makePoints(1);
    assert.equal(scanOf(id, { phoneAt: env.env.clock - 2 * MIN }).scan.deferred, false);
    assert.equal(scanOf(id, { phoneAt: env.env.clock - 2 * MIN - 1 }).scan.deferred, true);
    const row = env.db.prepare('SELECT phone_at, server_at, deferred FROM patrol_scan ORDER BY id DESC LIMIT 1').get() as Record<string, number>;
    assert.equal(row.deferred, 1);
    assert.equal(row.server_at, env.env.clock);
  });

  it('idempotent : le meme clientId renvoie la meme reponse, sans second enregistrement', () => {
    const ids = makePoints(3);
    makeRoute(ids);
    tickAt(at(22, 0));
    const first = scanOf(ids[0], { clientId: 'idem-0001' });
    env.env.clock = at(22, 10);
    const again = scanOf(ids[0], { clientId: 'idem-0001', phoneAt: at(22, 9) });
    assert.deepEqual(again, first);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM patrol_scan').get()?.n, 1);
    // un envoi different compte ensuite, et la reponse rejouee montre l'etat COURANT de la ronde
    scanOf(ids[1]);
    const replay = scanOf(ids[0], { clientId: 'idem-0001' });
    assert.equal(replay.scan.verdict, 'ok');
    assert.deepEqual(replay.scan.run?.checkpoints.map((c) => c.done), [true, true, false]);
    // meme apres un delai de plus de 24 h (la file du telephone rejoue tard)
    env.env.clock = at(22, 0, 3);
    assert.equal(scanOf(ids[0], { clientId: 'idem-0001', phoneAt: at(22, 1) }).scan.verdict, 'ok');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM patrol_scan').get()?.n, 2);
  });

  it('idempotent : le rejeu d\'un doublon ne change pas son verdict, et un autre agent ne peut pas reprendre le clientId', () => {
    const ids = makePoints(2);
    makeRoute(ids);
    tickAt(at(22, 0));
    scanOf(ids[0]);
    const dup = scanOf(ids[0], { clientId: 'idem-0002' });
    assert.equal(dup.scan.verdict, 'duplicate');
    assert.equal(scanOf(ids[0], { clientId: 'idem-0002' }).scan.verdict, 'duplicate');
    assert.throws(() => scanOf(ids[0], { clientId: 'idem-0002', user: 'bob' }), status(409));
  });

  it('un scan non idempotent echoue sans modifier l\'etat de la ronde (transaction)', () => {
    const ids = makePoints(2);
    makeRoute(ids);
    tickAt(at(22, 0));
    // force un echec d'ecriture du scan : table des scans retiree
    env.db.exec('ALTER TABLE patrol_scan RENAME TO patrol_scan_off');
    assert.throws(() => scanOf(ids[0]));
    env.db.exec('ALTER TABLE patrol_scan_off RENAME TO patrol_scan');
    // la machine a ete resynchronisee avec la base : le meme point compte normalement ensuite
    const r = scanOf(ids[0]);
    assert.equal(r.scan.verdict, 'ok');
    assert.equal(r.scan.run?.status, 'active');
  });

  it('position : tout code reconnu met a jour la position (ok, doublon, hors circuit, sans ronde)', () => {
    const ids = makePoints(3);
    const outside = env.patrols.createCheckpoint('chef', { name: 'Hors circuit' });
    makeRoute(ids);
    scanOf(ids[0]); // sans ronde
    assert.deepEqual(env.pos.get('ali'), { checkpointId: ids[0], at: T0 });
    tickAt(at(22, 0));
    scanOf(ids[1]);
    assert.equal(env.pos.get('ali')?.checkpointId, ids[1]);
    scanOf(ids[1]); // doublon
    assert.equal(env.pos.get('ali')?.at, at(22, 0));
    env.env.clock = at(22, 5);
    scanOf(outside.id); // hors circuit
    assert.deepEqual(env.pos.get('ali'), { checkpointId: outside.id, at: at(22, 5) });
    assert.throws(() => scanOf(ids[0], { code: 'zzzzzzzzzz' }), status(404)); // code inconnu : inchange
    assert.equal(env.pos.get('ali')?.checkpointId, outside.id);
    assert.equal(env.pos.get('bob'), undefined);
  });

  it('position : sans effet hors service, et un passage differe plus ancien ne ramene pas l\'agent en arriere', () => {
    const ids = makePoints(2);
    env.onShift.delete('ali');
    scanOf(ids[0]);
    assert.equal(env.pos.size, 0);
    env.onShift.add('ali');
    env.env.clock = at(22, 30);
    scanOf(ids[1]); // 22:30, position la plus recente
    scanOf(ids[0], { phoneAt: at(22, 10) }); // differe, plus ancien
    assert.deepEqual(env.pos.get('ali'), { checkpointId: ids[1], at: at(22, 30) });
    env.env.clock = at(22, 40);
    scanOf(ids[0], { phoneAt: at(22, 35) }); // differe mais plus recent que la position : retenu a son heure
    assert.deepEqual(env.pos.get('ali'), { checkpointId: ids[0], at: at(22, 35) });
  });

  it('une panne du service des agents ne fait pas perdre le scan', () => {
    const [id] = makePoints(1);
    const spy = mock.method(env.agents, 'setPosition', () => {
      throw new Error('panne');
    });
    mock.method(console, 'error', () => {});
    assert.equal(scanOf(id).scan.verdict, 'no_run');
    assert.equal(spy.mock.callCount(), 1);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM patrol_scan').get()?.n, 1);
  });

  it('plusieurs circuits : le meilleur verdict gagne, un point commun ne compte que pour un circuit', () => {
    const ids = makePoints(3);
    const a = makeRoute([ids[0], ids[1]], { name: 'A' });
    const b = makeRoute([ids[1], ids[2]], { name: 'B' });
    tickAt(at(22, 0));
    const r = scanOf(ids[1]);
    assert.equal(r.scan.verdict, 'ok');
    assert.equal(r.scan.run?.routeId, a.id); // plus petit id, a egalite
    const only2 = scanOf(ids[2]);
    assert.equal(only2.scan.run?.routeId, b.id);
    assert.equal(only2.scan.verdict, 'ok');
    // un point d'un circuit sans ronde ne l'emporte pas sur un « hors circuit » du circuit en cours
    env.patrols.updateRoute('chef', b.id, { enabled: false });
    assert.equal(scanOf(ids[2], { clientId: 'autre-0001' }).scan.verdict, 'out_of_route');
  });

  it('un agent du telephone partage : l\'envoi est enregistre au nom de l\'agent precedent (resolveSender)', () => {
    const ids = makePoints(2);
    makeRoute(ids);
    tickAt(at(22, 0));
    env.allowedSenders.add('1:bob');
    const r = scanOf(ids[0], { user: 'ali', username: 'bob', phoneAt: at(22, 0) });
    assert.equal(r.scan.verdict, 'ok');
    const row = env.db.prepare('SELECT username FROM patrol_scan').get() as { username: string };
    assert.equal(row.username, 'bob');
    assert.equal(runRows()[0].started_by, 'bob');
    assert.equal(env.pos.get('bob')?.checkpointId, ids[0]);
    assert.equal(env.pos.get('ali'), undefined);
    assert.deepEqual(env.asked[0], { phoneId: 1, session: 'ali', claimed: 'bob', phoneAt: at(22, 0) });
    // autorisation du circuit : jugee sur l'agent retenu
    makeRoute([ids[1]], { name: 'Reservee a ali', agents: ['ali'] });
    assert.equal(scanOf(ids[1], { user: 'ali', username: 'bob' }).scan.verdict, 'ok'); // circuit 1 (tout agent) le prend
  });

  it('un envoi attribue a un agent non autorise sur ce telephone : 403, rien d\'enregistre', () => {
    const ids = makePoints(1);
    assert.throws(() => scanOf(ids[0], { username: 'bob' }), (e: unknown) => e instanceof PsimError && e.status === 403 && /autre agent/.test(e.message));
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM patrol_scan').get()?.n, 0);
    assert.equal(env.pos.size, 0);
    assert.throws(() => scanOf(ids[0], { username: 5 as unknown as string }), status(400));
    assert.throws(() => scanOf(ids[0], { username: 'x'.repeat(65) }), status(400));
    // username = soi-meme ou vide : pas de controle supplementaire
    assert.equal(scanOf(ids[0], { username: 'ali' }).scan.verdict, 'no_run');
    assert.equal(env.asked.length, 1 + 0); // seul l'appel avec bob a interroge resolveSender
  });

  it('le clientId reste la cle d\'idempotence meme avec un username de substitution', () => {
    const ids = makePoints(2);
    makeRoute(ids);
    tickAt(at(22, 0));
    env.allowedSenders.add('1:bob');
    const first = scanOf(ids[0], { username: 'bob', clientId: 'shared-0001' });
    const again = scanOf(ids[0], { username: 'bob', clientId: 'shared-0001' });
    assert.deepEqual(again, first);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM patrol_scan').get()?.n, 1);
    // rejeu sans username par la session : accepte seulement si c'est le meme agent
    assert.throws(() => scanOf(ids[0], { clientId: 'shared-0001', user: 'carl' }), status(409));
  });
});

// ------------------------------------------------------------------ lecture agent : rondes du jour

describe('rondes visibles par un agent', () => {
  it('la prochaine ronde a venir, puis la ronde en cours, avec ses points', () => {
    const ids = makePoints(3);
    const route = makeRoute(ids, { ordered: true });
    const before = env.patrols.runsFor('ali');
    assert.equal(before.length, 1);
    assert.deepEqual([before[0].id, before[0].status, before[0].dueStart, before[0].routeId], [0, 'pending', at(22, 0), route.id]);
    assert.equal(before[0].name, 'Ronde de nuit');
    assert.equal(before[0].ordered, true);
    assert.deepEqual(before[0].checkpoints.map((c) => [c.id, c.name, c.zone, c.done, c.doneAt]), [
      [ids[0], 'Parking', 'Zone 1', false, null],
      [ids[1], 'Arriere-cour', 'Zone 2', false, null],
      [ids[2], 'Local bouteilles', 'Zone 3', false, null],
    ]);
    tickAt(at(22, 0));
    scanOf(ids[0]);
    const during = env.patrols.runsFor('ali');
    assert.equal(during.length, 2);
    assert.ok(during[0].id > 0);
    assert.equal(during[0].status, 'active');
    assert.equal(during[0].checkpoints[0].done, true);
    assert.equal(during[1].id, 0);
    assert.equal(during[1].dueStart, at(22, 0, 1));
  });

  it('ne montre ni les rondes terminees, ni celles des circuits desactives, restreints ou archives', () => {
    const ids = makePoints(2);
    const a = makeRoute(ids, { name: 'A' });
    makeRoute(ids, { name: 'B', agents: ['bob'] });
    tickAt(at(22, 0));
    assert.deepEqual(env.patrols.runsFor('ali').filter((r) => r.id > 0).map((r) => r.routeId), [a.id]);
    assert.deepEqual(env.patrols.runsFor('bob').filter((r) => r.id > 0).length, 2);
    scanOf(ids[0]);
    scanOf(ids[1]);
    assert.equal(env.patrols.runsFor('ali').filter((r) => r.id > 0).length, 0); // faite
    env.patrols.updateRoute('chef', a.id, { enabled: false });
    env.patrols.archiveRoute('chef', 2);
    assert.deepEqual(env.patrols.runsFor('bob'), []);
  });

  it('une ronde incomplete (encore rattrapable) reste visible, une ronde ratee non', () => {
    const ids = makePoints(2);
    makeRoute(ids);
    tickAt(at(22, 0));
    scanOf(ids[0], { phoneAt: at(22, 1) });
    tickAt(at(22, 30));
    assert.equal(env.patrols.runsFor('ali').find((r) => r.id > 0)?.status, 'incomplete');
    tickAt(at(22, 40));
    assert.equal(env.patrols.runsFor('ali').filter((r) => r.id > 0).length, 0);
  });
});

// ------------------------------------------------------------------ redemarrage

describe('redemarrage', () => {
  it('une nouvelle instance sur la meme base reconstruit l\'etat, sans doublon d\'evenement', () => {
    const ids = makePoints(3);
    makeRoute(ids);
    tickAt(at(22, 0));
    scanOf(ids[0], { phoneAt: at(22, 1) });
    tickAt(at(22, 30));
    assert.deepEqual(eventsOf('P-1'), ['patrol_incomplete']);
    const again = createPatrols({ db: env.db, engine: env.engine, agents: env.agents, dataDir: env.dir, now: () => env.env.clock });
    env.env.clock = at(22, 31);
    again.tick();
    again.tick();
    assert.deepEqual(eventsOf('P-1'), ['patrol_incomplete']);
    assert.equal(runRows().length, 1);
    assert.equal(auditActions('patrol_run_closed').length, 0);
    // la suite se deroule normalement sur la nouvelle instance : grace, puis ratee, une seule fois
    env.env.clock = at(22, 40);
    again.tick();
    again.tick();
    assert.deepEqual(eventsOf('P-1'), ['patrol_incomplete', 'patrol_missed']);
    assert.equal(auditActions('patrol_run_closed').length, 1);
  });

  it('redemarrage en cours de ronde : les points deja faits comptent encore, la ronde se termine', () => {
    const ids = makePoints(3);
    makeRoute(ids);
    tickAt(at(22, 0));
    scanOf(ids[0], { phoneAt: at(22, 1) });
    scanOf(ids[1], { phoneAt: at(22, 2) });
    const again = createPatrols({ db: env.db, engine: env.engine, agents: env.agents, dataDir: env.dir, now: () => env.env.clock });
    env.env.clock = at(22, 10);
    const r = again.scan('ali', 1, { clientId: 'restart-01', code: again.getCheckpoint(ids[2])?.code, method: 'nfc', phoneAt: at(22, 10) });
    assert.equal(r.scan.run?.status, 'done');
    assert.equal(again.scan('ali', 1, { clientId: 'restart-02', code: again.getCheckpoint(ids[0])?.code, method: 'nfc', phoneAt: at(22, 10) }).scan.verdict, 'no_run');
  });

  it('arret du serveur pendant une ronde : a la reprise, la ronde echue est evaluee une fois', () => {
    const ids = makePoints(3);
    makeRoute(ids);
    tickAt(at(22, 0));
    scanOf(ids[0], { phoneAt: at(22, 1) });
    // le serveur est arrete de 22:05 a 23:30
    env.env.clock = at(23, 30);
    const again = createPatrols({ db: env.db, engine: env.engine, agents: env.agents, dataDir: env.dir, now: () => env.env.clock });
    again.tick();
    again.tick();
    assert.deepEqual(eventsOf('P-1'), ['patrol_incomplete', 'patrol_missed']); // incomplete puis grace echue
    assert.equal(runRows().length, 1);
  });

  it('une ronde dont le debut tombait pendant l\'arret est creee et evaluee a la reprise (rattrapage borne)', () => {
    const ids = makePoints(2);
    makeRoute(ids);
    env.env.clock = at(22, 10); // arret de 21:30 a 22:10 ; la ronde de 22:00 n'a jamais ete creee
    const again = createPatrols({ db: env.db, engine: env.engine, agents: env.agents, dataDir: env.dir, now: () => env.env.clock });
    again.tick();
    assert.equal(runRows().length, 1);
    env.env.clock = at(22, 30);
    again.tick();
    assert.deepEqual(eventsOf('P-1'), ['patrol_missed']);
  });

  it('un circuit desactive ou archive n\'est pas recharge', () => {
    const ids = makePoints(2);
    const a = makeRoute(ids, { name: 'A' });
    const b = makeRoute(ids, { name: 'B' });
    env.patrols.updateRoute('chef', a.id, { enabled: false });
    env.patrols.archiveRoute('chef', b.id);
    env.env.clock = at(22, 30);
    const again = createPatrols({ db: env.db, engine: env.engine, agents: env.agents, dataDir: env.dir, now: () => env.env.clock });
    again.tick();
    assert.equal(runRows().length, 0);
  });

  it('une ligne corrompue en base ne fait pas tomber les autres circuits', () => {
    const errors = mock.method(console, 'error', () => {});
    const ids = makePoints(2);
    const good = makeRoute(ids, { name: 'Bon' });
    const insert = env.db.prepare('INSERT INTO patrol_route (name, checkpoints, ordered, max_minutes, schedule, agents, grace_minutes, enabled) VALUES (?, ?, 0, ?, ?, ?, 10, 1)');
    insert.run('Vide', '[]', 30, JSON.stringify(NIGHT), '[]');
    insert.run('Json casse', '{pas du json', 30, JSON.stringify(NIGHT), '[]');
    insert.run('Duree folle', JSON.stringify(ids), 'abc', JSON.stringify(NIGHT), '[]');
    insert.run('Planning casse', JSON.stringify(ids), 30, 'null', '[]');
    insert.run('Agents casses', JSON.stringify(ids), 30, JSON.stringify(NIGHT), '{"a":1}');
    const again = createPatrols({ db: env.db, engine: env.engine, agents: env.agents, dataDir: env.dir, now: () => env.env.clock });
    assert.equal(errors.mock.callCount(), 3); // liste de points vide, JSON casse, duree illisible (un planning ou des agents illisibles = listes vides, valides)
    env.env.clock = at(22, 0);
    again.tick();
    // seuls le bon circuit et celui dont la seule liste d'agents est illisible (= tout agent) tournent
    assert.deepEqual(runRows().map((r) => r.route_id), [good.id, good.id + 5]);
    // la lecture des circuits ne leve pas non plus
    assert.equal(again.listRoutes().length, 6);
    env.env.clock = at(22, 30);
    again.tick();
    assert.equal(incidentsOf(`P-${good.id}`).length, 1);
  });

  it('un detecteur P- supprime a la main est recree avant l\'evenement (l\'alarme n\'est pas perdue)', () => {
    const ids = makePoints(2);
    makeRoute(ids);
    env.base.deleteDevice('chef', 'P-1');
    tickAt(at(22, 0));
    tickAt(at(22, 30));
    assert.ok(env.base.getDevice('P-1'));
    assert.equal(incidentsOf('P-1').length, 1);
  });

  it('un detecteur absent au demarrage est recree', () => {
    const ids = makePoints(2);
    makeRoute(ids);
    env.base.deleteDevice('chef', 'P-1');
    createPatrols({ db: env.db, engine: env.engine, agents: env.agents, dataDir: env.dir, now: () => env.env.clock });
    assert.ok(env.base.getDevice('P-1'));
  });
});

// ------------------------------------------------------------------ acquittement par l'exploitation

describe('acquittement par l\'exploitation', () => {
  const addUser = (name: string, role: string) => env.db.prepare('INSERT INTO app_user (username, role, salt, hash) VALUES (?, ?, ?, ?)').run(name, role, 's', 'h');

  it('un detecteur P- acquitte par un operateur est libere : l\'incident peut etre cloture', () => {
    addUser('op', 'operator');
    const ids = makePoints(2);
    makeRoute(ids);
    tickAt(at(22, 0));
    tickAt(at(22, 30)); // ratee : alarme
    const [incident] = incidentsOf('P-1');
    assert.throws(() => env.base.close(incident.id, 'op', 'false_alarm', null), status(409)); // detecteur en alarme
    env.base.acknowledge(incident.id, 'op');
    tickAt(at(22, 31));
    assert.equal(env.base.getDevice('P-1')?.status, 'normal');
    assert.equal(env.base.close(incident.id, 'op', 'fire', null).status, 'closed');
  });

  it('acquitte par un agent : libere aussi (sinon personne ne pourrait cloturer)', () => {
    addUser('ali', 'agent');
    const ids = makePoints(2);
    makeRoute(ids);
    tickAt(at(22, 0));
    tickAt(at(22, 30));
    env.base.acknowledge(incidentsOf('P-1')[0].id, 'ali');
    tickAt(at(22, 31));
    assert.equal(env.base.getDevice('P-1')?.status, 'normal');
  });

  it('la liberation est injectable et son echec ne bloque pas le tick', () => {
    const calls: string[] = [];
    const e2 = setup();
    cleanup.push(() => rmSync(e2.dir, { recursive: true, force: true }));
    const p = createPatrols({
      db: e2.db,
      engine: e2.engine,
      agents: e2.agents,
      dataDir: e2.dir,
      now: () => e2.env.clock,
      releaseAcknowledged: (_db, _engine, prefix) => {
        calls.push(prefix);
        throw new Error('panne');
      },
    });
    mock.method(console, 'error', () => {});
    p.tick();
    assert.deepEqual(calls, ['P-']);
  });

  it('apres liberation, la grace echue rouvre l\'alerte en critique', () => {
    addUser('op', 'operator');
    const ids = makePoints(3);
    makeRoute(ids);
    tickAt(at(22, 0));
    scanOf(ids[0], { phoneAt: at(22, 1) });
    tickAt(at(22, 30));
    const [incident] = incidentsOf('P-1');
    env.base.acknowledge(incident.id, 'op');
    tickAt(at(22, 31)); // libere
    assert.equal(env.base.getDevice('P-1')?.status, 'normal');
    tickAt(at(22, 40)); // grace echue : ratee
    const [after] = incidentsOf('P-1');
    assert.equal(after.id, incident.id);
    assert.equal(after.severity, 'critical');
    assert.equal(after.status, 'open'); // l'escalade releve l'alerte
    assert.equal(env.base.getDevice('P-1')?.status, 'alarm');
  });
});

// ------------------------------------------------------------------ main courante

describe('main courante', () => {
  const entry = (over: Record<string, unknown> = {}, user = 'ali', phoneId = 1) =>
    env.patrols.addLogbook(user, phoneId, { clientId: `log-${String(++counter).padStart(8, '0')}`, category: 'anomaly', text: 'Porte de la cave entrouverte', phoneAt: env.env.clock, ...over });

  it('enregistre une entree sans photo', () => {
    const [cp] = makePoints(1);
    const { entry: e } = entry({ checkpointId: cp, category: 'damage' });
    const [view] = env.patrols.logbookBetween(0, env.env.clock + 1);
    assert.equal(view.id, e.id);
    assert.deepEqual([view.username, view.displayName, view.category, view.text, view.checkpointId, view.checkpointName, view.hasPhoto, view.deferred, view.incidentId],
      ['ali', 'ali', 'damage', 'Porte de la cave entrouverte', cp, 'Parking', false, false, null]);
    assert.equal(env.db.prepare('SELECT photo_file FROM logbook_entry').get()?.photo_file, null);
  });

  it('le nom affiche vient du compte (app_user.display_name) quand il existe', () => {
    env.db.prepare("INSERT INTO app_user (username, role, salt, hash, display_name) VALUES ('ali', 'agent', 's', 'h', 'Ali Diallo')").run();
    entry();
    assert.equal(env.patrols.logbookBetween(0, env.env.clock + 1)[0].displayName, 'Ali Diallo');
  });

  it('idempotent par clientId (meme id, une seule ligne) ; un autre agent ne le reprend pas', () => {
    const a = entry({ clientId: 'log-idem-01' });
    const b = entry({ clientId: 'log-idem-01', text: 'autre texte' });
    assert.equal(a.entry.id, b.entry.id);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM logbook_entry').get()?.n, 1);
    assert.throws(() => entry({ clientId: 'log-idem-01' }, 'bob'), status(409));
    env.allowedSenders.add('1:bob');
    assert.equal(entry({ clientId: 'log-idem-01', username: 'bob' }, 'ali').entry.id, a.entry.id); // meme cle, aucun doublon
  });

  it('enregistre au nom de l\'agent precedent du telephone partage, ou refuse (403)', () => {
    assert.throws(() => entry({ username: 'bob' }), (e: unknown) => e instanceof PsimError && e.status === 403);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM logbook_entry').get()?.n, 0);
    env.allowedSenders.add('1:bob');
    entry({ username: 'bob' }, 'ali');
    assert.equal(env.db.prepare('SELECT username FROM logbook_entry').get()?.username, 'bob');
    assert.equal(env.asked.at(-1)?.phoneAt, env.env.clock);
    assert.throws(() => entry({ username: ['bob'] as unknown as string }), status(400));
  });

  it('valide categorie, texte, point, heure', () => {
    const bad = (over: Record<string, unknown>, code = 400) => assert.throws(() => entry(over), status(code));
    for (const category of ['other ', 'ANOMALY', '', 3, undefined]) bad({ category });
    for (const text of ['', '   ', 5, undefined, 'x'.repeat(1001), 'a\u0000b', 'a\u202eb', 'a\u200bb', 'a\u0007b', 'a\u2028b']) bad({ text });
    bad({ checkpointId: 999 });
    bad({ checkpointId: '1' });
    bad({ checkpointId: 1.5 });
    bad({ phoneAt: env.env.clock + 6 * MIN });
    bad({ phoneAt: env.env.clock - DAY - 1000 });
    bad({ clientId: 'court' });
    assert.throws(() => env.patrols.addLogbook('ali', 1, 'texte'), status(400));
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM logbook_entry').get()?.n, 0);
    // accepte : texte de 1000 caracteres, retours a la ligne, emoji, point nul
    entry({ text: 'x'.repeat(1000) });
    entry({ text: 'ligne 1\nligne 2\ttab', checkpointId: null });
    entry({ text: '\u{1F468}\u200d\u{1F469} alerte' });
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM logbook_entry').get()?.n, 3);
  });

  it('recu en differe : marque differe', () => {
    entry({ phoneAt: env.env.clock - 10 * MIN });
    assert.equal(env.patrols.logbookBetween(0, env.env.clock + 1)[0].deferred, true);
  });

  it('photo : JPEG en base64, fichier sous dataDir/logbook/<id>.jpg, empreinte SHA-256 en base', async () => {
    const { entry: e } = entry({ photo: JPEG.toString('base64') });
    const path = join(env.dir, 'logbook', `${e.id}.jpg`);
    assert.ok(existsSync(path));
    assert.deepEqual(readFileSync(path), JPEG);
    const { createHash } = await import('node:crypto');
    const row = env.db.prepare('SELECT photo_file, photo_sha256 FROM logbook_entry WHERE id = ?').get(e.id) as Record<string, string>;
    assert.equal(row.photo_file, `${e.id}.jpg`);
    assert.equal(row.photo_sha256, createHash('sha256').update(JPEG).digest('hex'));
    assert.equal(env.patrols.logbookBetween(0, env.env.clock + 1)[0].hasPhoto, true);
    assert.deepEqual(env.patrols.logbookPhoto(e.id), JPEG);
  });

  it('photo : refuse tout ce qui n\'est pas un JPEG base64 strict de 400 Ko au plus', () => {
    const bad = (photo: unknown, code = 400) => assert.throws(() => entry({ photo }), status(code));
    bad('');
    bad(42);
    bad(`data:image/jpeg;base64,${JPEG.toString('base64')}`);
    bad(`${JPEG.toString('base64')}\n`);
    bad(`${JPEG.toString('base64')}!`);
    bad(JPEG.toString('base64').slice(1)); // longueur non multiple de 4
    bad(Buffer.from('GIF89a-ceci-nest-pas-un-jpeg').toString('base64'));
    bad(Buffer.from([0xff, 0xd8]).toString('base64')); // trop court
    bad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).toString('base64')); // PNG
    bad(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400 * 1024)]).toString('base64'), 413);
    bad('A'.repeat(900_000), 413);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM logbook_entry').get()?.n, 0);
    // exactement 400 Ko : accepte
    entry({ photo: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400 * 1024 - 3)]).toString('base64') });
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM logbook_entry').get()?.n, 1);
  });

  it('une photo modifiee sur le disque n\'est pas servie', () => {
    const { entry: e } = entry({ photo: JPEG.toString('base64') });
    mock.method(console, 'error', () => {});
    const path = join(env.dir, 'logbook', `${e.id}.jpg`);
    rmSync(path);
    assert.throws(() => env.patrols.logbookPhoto(e.id), status(404));
    writeFileSync(path, Buffer.concat([JPEG, Buffer.from('x')]));
    assert.throws(() => env.patrols.logbookPhoto(e.id), status(500));
    assert.throws(() => env.patrols.logbookPhoto(999), status(404));
    const { entry: noPhoto } = entry();
    assert.throws(() => env.patrols.logbookPhoto(noPhoto.id), status(404));
  });

  it('le nom du fichier ne vient jamais du client', () => {
    const { entry: e } = entry({ photo: JPEG.toString('base64'), photoFile: '../../etc/x', photo_file: '../x', file: '../y' });
    assert.equal(env.db.prepare('SELECT photo_file FROM logbook_entry WHERE id = ?').get(e.id)?.photo_file, `${e.id}.jpg`);
    env.db.prepare('UPDATE logbook_entry SET photo_file = ? WHERE id = ?').run('../../secret.txt', e.id);
    assert.throws(() => env.patrols.logbookPhoto(e.id), status(404)); // une ligne trafiquee ne sort pas du dossier
  });

  it('en faire un incident : evenement logbook_report sur A-<agent>, lien memorise, une seule fois', () => {
    const { entry: e } = entry({ category: 'damage', text: 'Vitre brisee\nau  rez-de-chaussee' });
    const { incidentId } = env.patrols.logbookToIncident('chef', e.id);
    const incident = env.base.incidentView(incidentId);
    assert.equal(incident.detectorId, 'A-ali');
    assert.equal(incident.severity, 'warning');
    assert.equal(incident.event, 'logbook_report');
    assert.equal(incident.detail, 'Dégradation : Vitre brisee au rez-de-chaussee');
    assert.equal(env.patrols.logbookBetween(0, env.env.clock + 1)[0].incidentId, incidentId);
    assert.throws(() => env.patrols.logbookToIncident('chef', e.id), status(409));
    assert.throws(() => env.patrols.logbookToIncident('chef', 999), status(404));
    assert.equal(auditActions('logbook_incident_created').length, 1);
    assert.equal(auditActions('logbook_incident_created')[0].incidentId, incidentId);
  });

  it('en faire un incident : detail borne a 300 caracteres ; refuse si une alarme (SOS) est en cours sur l\'agent', () => {
    const { entry: e } = entry({ text: 'z'.repeat(1000) });
    const { incidentId } = env.patrols.logbookToIncident('chef', e.id);
    assert.equal(env.base.incidentView(incidentId).detail?.length, 300);
    const { entry: f } = entry({ clientId: 'log-bob-0001', text: 'texte' }, 'bob');
    env.base.handleDetectorMessage(env.agents.detectorId('bob'), { event: 'sos' });
    assert.throws(() => env.patrols.logbookToIncident('chef', f.id), status(409));
    assert.equal(env.patrols.logbookBetween(0, env.env.clock + 1).find((x) => x.id === f.id)?.incidentId, null);
  });

  it('l\'agent supprime : pas d\'incident possible', () => {
    const { entry: e } = entry();
    env.names.delete('ali');
    assert.throws(() => env.patrols.logbookToIncident('chef', e.id), status(409));
  });
});

// ------------------------------------------------------------------ conservation 400 jours

describe('conservation', () => {
  it('efface au dela de 400 jours scans, rondes, main courante et photos, garde le reste', () => {
    const ids = makePoints(2);
    makeRoute(ids);
    tickAt(at(22, 0));
    scanOf(ids[0]);
    scanOf(ids[1]);
    const { entry: e } = env.patrols.addLogbook('ali', 1, { clientId: 'log-ret-0001', category: 'other', text: 'RAS', phoneAt: env.env.clock, photo: JPEG.toString('base64') });
    const photo = join(env.dir, 'logbook', `${e.id}.jpg`);
    assert.ok(existsSync(photo));

    assert.deepEqual(env.patrols.purge(T0 + (RETENTION_DAYS - 1) * DAY), { scans: 0, runs: 0, entries: 0 });
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM patrol_scan').get()?.n, 2);
    assert.ok(existsSync(photo));

    assert.deepEqual(env.patrols.purge(at(22, 0) + RETENTION_DAYS * DAY + HOUR), { scans: 2, runs: 1, entries: 1 });
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM patrol_scan').get()?.n, 0);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM logbook_entry').get()?.n, 0);
    assert.equal(runRows().length, 0);
    assert.ok(!existsSync(photo));
    assert.equal(auditActions('patrol_purged').length, 1);
    // rien a effacer : pas d'entree d'audit en plus
    env.patrols.purge(at(22, 0) + RETENTION_DAYS * DAY + 2 * HOUR);
    assert.equal(auditActions('patrol_purged').length, 1);
  });

  it('ne purge pas une ronde encore ouverte, ni les jeunes entrees', () => {
    const ids = makePoints(2);
    makeRoute(ids);
    tickAt(at(22, 0));
    env.db.prepare("UPDATE patrol_run SET due_end = ? WHERE status = 'pending'").run(T0 - 500 * DAY);
    assert.equal(env.patrols.purge(T0).runs, 0);
  });

  it('tick purge une fois par heure', () => {
    const ids = makePoints(1);
    scanOf(ids[0], {});
    env.env.clock = T0 + 401 * DAY;
    env.patrols.tick();
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM patrol_scan').get()?.n, 0);
  });
});

// ------------------------------------------------------------------ lecture : journal, rapports

describe('lecture pour le journal et les rapports', () => {
  function history() {
    const ids = makePoints(3);
    const route = makeRoute(ids);
    tickAt(at(22, 0));
    scanOf(ids[0], { phoneAt: at(22, 1) });
    env.env.clock = at(22, 10);
    scanOf(ids[1], { user: 'bob' });
    tickAt(at(22, 30)); // incomplete
    tickAt(at(22, 40)); // ratee
    tickAt(at(22, 0, 1)); // 2e ronde
    scanOf(ids[0], { user: 'bob' });
    return { ids, route };
  }

  it('runsBetween : rondes avec passages, points faits et manquants', () => {
    const { ids, route } = history();
    const runs = env.patrols.runsBetween(at(0, 0), at(23, 0, 1));
    assert.equal(runs.length, 2);
    const [first, second] = runs;
    assert.equal(first.status, 'missed');
    assert.equal(first.routeName, 'Ronde de nuit');
    assert.equal(first.startedBy, 'ali');
    assert.equal(first.doneCount, 2);
    assert.equal(first.totalCount, 3);
    assert.deepEqual(first.missing, ['Local bouteilles']);
    assert.deepEqual(first.scans.map((s) => [s.username, s.checkpointName, s.verdict, s.method]), [['ali', 'Parking', 'ok', 'qr'], ['bob', 'Arriere-cour', 'ok', 'qr']]);
    assert.equal(first.scans[0].runId, first.id);
    assert.equal(first.routeId, route.id);
    assert.equal(second.status, 'active');
    assert.equal(second.doneCount, 1);
    assert.equal(second.missing.length, 2);
  });

  it('runsBetween : filtres periode, circuit et agent', () => {
    const { ids } = history();
    makeRoute([ids[0]], { name: 'Autre', schedule: [{ days: ALL, from: '23:00', to: '23:30' }] });
    assert.equal(env.patrols.runsBetween(at(0, 0), at(21, 0, 1)).length, 1); // seule la premiere nuit
    assert.equal(env.patrols.runsBetween(at(22, 1), at(23, 0, 1)).length, 1); // la seconde
    assert.equal(env.patrols.runsBetween(at(0, 0), at(23, 0, 1), { routeId: 1 }).length, 2);
    assert.equal(env.patrols.runsBetween(at(0, 0), at(23, 0, 1), { routeId: 99 }).length, 0);
    assert.deepEqual(env.patrols.runsBetween(at(0, 0), at(23, 0, 1), { username: 'bob' }).map((r) => r.id), [1, 2]);
    assert.deepEqual(env.patrols.runsBetween(at(0, 0), at(23, 0, 1), { username: 'ali' }).map((r) => r.id), [1]);
    assert.equal(env.patrols.runsBetween(at(0, 0), at(23, 0, 1), { username: 'carl' }).length, 0);
    assert.equal(env.patrols.runsBetween(at(23, 59, 5), at(0, 0, 6)).length, 0);
  });

  it('runsBetween : un circuit modifie ensuite n\'efface pas les points deja faits', () => {
    const ids = makePoints(3);
    const route = makeRoute(ids);
    tickAt(at(22, 0));
    scanOf(ids[2], { phoneAt: at(22, 1) });
    env.patrols.updateRoute('chef', route.id, { checkpoints: [ids[0], ids[1]] });
    const [run] = env.patrols.runsBetween(at(0, 0), at(23, 0));
    assert.deepEqual(run.checkpoints.map((c) => [c.id, c.done]), [[ids[0], false], [ids[1], false], [ids[2], true]]);
  });

  it('runsBetween : un point archive garde son nom dans l\'historique', () => {
    const ids = makePoints(2);
    const route = makeRoute(ids);
    tickAt(at(22, 0));
    scanOf(ids[0], { phoneAt: at(22, 1) });
    env.patrols.archiveRoute('chef', route.id);
    env.patrols.archiveCheckpoint('chef', ids[0]);
    const [run] = env.patrols.runsBetween(at(0, 0), at(23, 0));
    assert.equal(run.scans[0].checkpointName, 'Parking');
    assert.equal(run.name, 'Ronde de nuit');
  });

  it('scansBetween : tous les passages (meme sans ronde), filtres', () => {
    const { ids } = history();
    scanOf(ids[0], { clientId: 'orphan-0001', user: 'bob' });
    const all = env.patrols.scansBetween(0, at(23, 59, 1));
    assert.equal(all.length, 4);
    assert.equal(env.patrols.scansBetween(0, at(23, 59, 1), { username: 'ali' }).length, 1);
    assert.equal(env.patrols.scansBetween(0, at(23, 59, 1), { checkpointId: ids[0] }).length, 3);
    assert.equal(env.patrols.scansBetween(0, at(23, 59, 1), { routeId: 1 }).length, 4);
    assert.equal(env.patrols.scansBetween(0, at(23, 59, 1), { routeId: 2 }).length, 0);
    assert.equal(env.patrols.scansBetween(0, at(23, 59, 1), { limit: 2 }).length, 2);
    assert.ok(all.every((s, i) => i === 0 || all[i - 1].serverAt <= s.serverAt));
  });

  it('logbookBetween : la plus recente d\'abord, filtre par agent et par periode', () => {
    env.patrols.addLogbook('ali', 1, { clientId: 'log-aa-0001', category: 'other', text: 'un', phoneAt: env.env.clock });
    env.env.clock += HOUR;
    env.patrols.addLogbook('bob', 1, { clientId: 'log-aa-0002', category: 'visitor', text: 'deux', phoneAt: env.env.clock });
    assert.deepEqual(env.patrols.logbookBetween(0, env.env.clock).map((e) => e.text), ['deux', 'un']);
    assert.deepEqual(env.patrols.logbookBetween(0, env.env.clock, { username: 'ali' }).map((e) => e.text), ['un']);
    assert.deepEqual(env.patrols.logbookBetween(T0 + 1, env.env.clock).map((e) => e.text), ['deux']);
  });

  it('positions : agents en service avec le point et sa place sur le plan', () => {
    const ids = makePoints(2);
    scanOf(ids[1]);
    assert.deepEqual(env.patrols.positions(), [{ username: 'ali', displayName: 'Nom ali', checkpointId: ids[1], name: 'Arriere-cour', floorId: env.patrols.getCheckpoint(ids[1])?.floorId, x: 11, y: 21, at: T0 }]);
    env.onShift.delete('ali');
    assert.deepEqual(env.patrols.positions(), []);
  });
});

// ------------------------------------------------------------------ routes HTTP

interface Reply {
  status: number;
  json: any;
  text: string;
  headers: Headers;
  buffer: Buffer;
}

let server: Server | null = null;
let base = '';

async function serve(e: Env = env): Promise<void> {
  const app = express();
  const roleOf = (req: Request): Role => (req.header('x-test-role') ?? '') as Role;
  const sessionOf = (req: Request) => (roleOf(req) ? ({ username: req.header('x-test-user') ?? 'chef', role: roleOf(req), expires: Infinity, epoch: 0, restricted: null } as never) : null);
  const guard = (roles: Role[]): RequestHandler => (req, res, next) => {
    const role = roleOf(req);
    if (!role) return void res.status(401).json({ error: 'Non authentifie' });
    if (!roles.includes(role)) return void res.status(403).json({ error: 'Droits insuffisants' });
    next();
  };
  const ctx: MountContext = {
    sessionOf,
    adminOnly: guard(['admin']),
    staff: guard(['admin', 'operator']),
    actorOf: (req) => req.header('x-test-user') ?? 'chef',
    roleOf,
    json: (limit) => express.json({ limit }),
    cookieSecure: false,
    originOf: () => 'https://psim.test',
  };
  e.patrols.mount(app, ctx);
  app.use('/api', (_req, res) => void res.status(404).json({ error: 'Route inconnue' }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof PsimError) return void res.status(err.status).json({ error: err.message });
    const status = (err as { status?: number }).status;
    if (typeof status === 'number') return void res.status(status).json({ error: 'refuse' });
    res.status(500).json({ error: 'Erreur interne' });
  });
  const listening = app.listen(0, '127.0.0.1');
  server = listening;
  await new Promise<void>((resolve) => listening.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = null;
});

async function call(method: string, path: string, o: { role?: string; user?: string; agent?: string; phone?: number; body?: unknown; raw?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (o.role) headers['x-test-role'] = o.role;
  if (o.user) headers['x-test-user'] = o.user;
  if (o.agent) headers['x-test-agent'] = o.agent;
  if (o.phone !== undefined) headers['x-test-phone'] = String(o.phone);
  let body: string | undefined;
  if (o.raw !== undefined) {
    body = o.raw;
    headers['content-type'] = 'application/json';
  } else if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(base + path, { method, headers, body });
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = buffer.toString('utf8');
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* pas du JSON */
  }
  return { status: res.status, json, text, headers: res.headers, buffer };
}

describe('routes HTTP : droits', () => {
  beforeEach(() => serve());

  it('points et circuits : lecture admin + operator, ecriture admin seulement', async () => {
    const ids = makePoints(2);
    makeRoute(ids);
    for (const path of ['/api/patrols/checkpoints', '/api/patrols/routes']) {
      assert.equal((await call('GET', path)).status, 401, path);
      assert.equal((await call('GET', path, { role: 'agent' })).status, 403, path);
      assert.equal((await call('GET', path, { role: 'operator' })).status, 200, path);
      assert.equal((await call('GET', path, { role: 'admin' })).status, 200, path);
    }
    const writes: [string, string, unknown][] = [
      ['POST', '/api/patrols/checkpoints', { name: 'X' }],
      ['PATCH', `/api/patrols/checkpoints/${ids[0]}`, { x: 1 }],
      ['DELETE', `/api/patrols/checkpoints/${ids[1]}`, undefined],
      ['POST', `/api/patrols/checkpoints/${ids[0]}/recode`, undefined],
      ['GET', `/api/patrols/checkpoints/${ids[0]}/qr.svg`, undefined],
      ['POST', '/api/patrols/routes', { name: 'X', checkpoints: ids, maxMinutes: 5, schedule: NIGHT }],
      ['PATCH', '/api/patrols/routes/1', { name: 'Y' }],
      ['DELETE', '/api/patrols/routes/1', undefined],
    ];
    for (const [method, path, body] of writes) {
      assert.equal((await call(method, path, { body })).status, 401, `${method} ${path}`);
      assert.equal((await call(method, path, { role: 'operator', body })).status, 403, `${method} ${path} operator`);
      assert.equal((await call(method, path, { role: 'agent', body })).status, 403, `${method} ${path} agent`);
    }
    // rien n'a ete modifie par les refus
    assert.equal(env.patrols.listCheckpoints().length, 2);
    assert.equal(env.patrols.getRoute(1)?.name, 'Ronde de nuit');
    assert.equal(env.patrols.getCheckpoint(ids[0])?.x, 10);
  });

  it('le code des etiquettes est reserve a l\'administrateur', async () => {
    makePoints(1);
    const op = await call('GET', '/api/patrols/checkpoints', { role: 'operator' });
    assert.equal(op.json[0].code, undefined);
    assert.ok(!op.text.includes(env.patrols.listCheckpoints({ withCode: true })[0].code as string));
    const admin = await call('GET', '/api/patrols/checkpoints', { role: 'admin' });
    assert.match(admin.json[0].code, /^[a-z2-7]{10}$/);
  });

  it('circuits : l\'operateur ne recoit aucun code d\'etiquette, l\'administrateur garde l\'acces aux codes des points', async () => {
    const ids = makePoints(3);
    makeRoute(ids);
    const codes = ids.map((id) => env.patrols.getCheckpoint(id)?.code as string);
    for (const path of ['/api/patrols/checkpoints', '/api/patrols/checkpoints?archived=1', '/api/patrols/routes', '/api/patrols/routes?archived=1']) {
      const op = await call('GET', path, { role: 'operator' });
      assert.equal(op.status, 200, path);
      assert.ok(Array.isArray(op.json) && op.json.length > 0 || path.includes('archived'), path);
      for (const item of op.json as Record<string, unknown>[]) assert.ok(!('code' in item), `${path} : cle code presente`);
      for (const code of codes) assert.ok(!op.text.includes(code), `${path} : code dans le corps`);
    }
    const adminPoints = await call('GET', '/api/patrols/checkpoints', { role: 'admin' });
    assert.deepEqual(adminPoints.json.map((p: { code: string }) => p.code), codes);
  });

  it('qr.svg et recode : 403 pour l\'operateur (code inchange), accessibles a l\'administrateur', async () => {
    const [id] = makePoints(1);
    const before = env.patrols.getCheckpoint(id)?.code;
    const qr = `/api/patrols/checkpoints/${id}/qr.svg`;
    const recode = `/api/patrols/checkpoints/${id}/recode`;
    assert.equal((await call('GET', qr, { role: 'operator' })).status, 403);
    assert.equal((await call('POST', recode, { role: 'operator' })).status, 403);
    assert.equal(env.patrols.getCheckpoint(id)?.code, before);
    assert.equal((await call('GET', qr, { role: 'admin' })).status, 200);
    assert.equal((await call('POST', recode, { role: 'admin' })).status, 200);
    assert.notEqual(env.patrols.getCheckpoint(id)?.code, before);
  });

  it('runs, main courante, positions : aucun code d\'etiquette dans le corps lu par l\'operateur', async () => {
    const ids = makePoints(3);
    makeRoute(ids);
    tickAt(at(22, 0));
    scanOf(ids[0], { phoneAt: at(22, 1) });
    scanOf(ids[1], { phoneAt: at(22, 2) });
    env.patrols.addLogbook('ali', 1, { clientId: 'log-codes-01', category: 'other', text: 'RAS', phoneAt: at(22, 3) });
    tickAt(at(22, 10));
    const codes = ids.map((id) => env.patrols.getCheckpoint(id)?.code as string);
    const paths = [`/api/patrols/runs?from=${at(0, 0)}&to=${at(23, 0)}`, `/api/patrols/logbook?from=${at(0, 0)}&to=${at(23, 0)}`, '/api/patrols/positions'];
    for (const path of paths) {
      const op = await call('GET', path, { role: 'operator' });
      assert.equal(op.status, 200, path);
      for (const code of codes) assert.ok(!op.text.includes(code), `${path} : code dans le corps`);
    }
    const runs = await call('GET', paths[0], { role: 'operator' });
    assert.ok(runs.text.includes('Parking'), 'les rondes contiennent bien des passages');
  });

  it('journal, main courante, positions : admin + operator, jamais l\'agent ni un anonyme', async () => {
    const { entry } = env.patrols.addLogbook('ali', 1, { clientId: 'log-http-01', category: 'other', text: 'RAS', phoneAt: T0, photo: JPEG.toString('base64') });
    const paths = ['/api/patrols/runs', '/api/patrols/logbook', `/api/patrols/logbook/${entry.id}/photo`, '/api/patrols/positions'];
    for (const path of paths) {
      assert.equal((await call('GET', path)).status, 401, path);
      assert.equal((await call('GET', path, { role: 'agent' })).status, 403, path);
      assert.equal((await call('GET', path, { role: 'operator' })).status, 200, path);
      assert.equal((await call('GET', path, { role: 'admin' })).status, 200, path);
    }
    assert.equal((await call('POST', `/api/patrols/logbook/${entry.id}/incident`)).status, 401);
    assert.equal((await call('POST', `/api/patrols/logbook/${entry.id}/incident`, { role: 'agent' })).status, 403);
    assert.equal((await call('POST', `/api/patrols/logbook/${entry.id}/incident`, { role: 'operator' })).status, 200);
  });

  it('routes de l\'agent : exigent agents.requireAgent (401 sans session d\'agent)', async () => {
    const [id] = makePoints(1);
    const code = env.patrols.getCheckpoint(id)?.code;
    const body = { clientId: 'http-0000001', code, method: 'qr', phoneAt: T0 };
    assert.equal((await call('GET', '/api/agent/runs')).status, 401);
    assert.equal((await call('POST', '/api/agent/scans', { body })).status, 401);
    assert.equal((await call('POST', '/api/agent/logbook', { body })).status, 401);
    // une session d'exploitation n'ouvre pas ces routes
    assert.equal((await call('GET', '/api/agent/runs', { role: 'admin' })).status, 401);
    assert.equal((await call('POST', '/api/agent/scans', { role: 'admin', body })).status, 401);
    assert.equal((await call('GET', '/api/agent/runs', { agent: 'ali' })).status, 200);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM patrol_scan').get()?.n, 0);
  });
});

describe('routes HTTP : points et circuits', () => {
  beforeEach(() => serve());

  it('cree, modifie, recode, archive un point', async () => {
    const created = await call('POST', '/api/patrols/checkpoints', { role: 'admin', body: { name: 'Parking', zone: 'Cour', x: 40, y: 60 } });
    assert.equal(created.status, 201);
    assert.deepEqual([created.json.name, created.json.zone, created.json.x, created.json.y], ['Parking', 'Cour', 40, 60]);
    assert.match(created.json.code, /^[a-z2-7]{10}$/);
    const id = created.json.id;
    const patched = await call('PATCH', `/api/patrols/checkpoints/${id}`, { role: 'admin', body: { x: 70 } });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.x, 70);
    const recoded = await call('POST', `/api/patrols/checkpoints/${id}/recode`, { role: 'admin' });
    assert.equal(recoded.status, 200);
    assert.notEqual(recoded.json.code, created.json.code);
    const deleted = await call('DELETE', `/api/patrols/checkpoints/${id}`, { role: 'admin' });
    assert.equal(deleted.status, 204);
    assert.equal((await call('GET', '/api/patrols/checkpoints', { role: 'admin' })).json.length, 0);
    assert.equal((await call('GET', '/api/patrols/checkpoints?archived=1', { role: 'admin' })).json.length, 1);
    assert.equal((await call('DELETE', `/api/patrols/checkpoints/${id}`, { role: 'admin' })).status, 404);
  });

  it('erreurs en francais avec le bon code : 400, 404, 409, JSON invalide, identifiant invalide', async () => {
    const [a] = makePoints(1);
    const r400 = await call('POST', '/api/patrols/checkpoints', { role: 'admin', body: { name: '' } });
    assert.equal(r400.status, 400);
    assert.match(r400.json.error, /name/);
    assert.equal((await call('POST', '/api/patrols/checkpoints', { role: 'admin', raw: '{pas du json' })).status, 400);
    assert.equal((await call('POST', '/api/patrols/checkpoints', { role: 'admin', body: { name: 'Parking' } })).status, 409);
    assert.equal((await call('PATCH', '/api/patrols/checkpoints/9999', { role: 'admin', body: { x: 1 } })).status, 404);
    for (const bad of ['abc', '0', '-1', '1e3', '99999999999999999999']) {
      assert.equal((await call('PATCH', `/api/patrols/checkpoints/${bad}`, { role: 'admin', body: { x: 1 } })).status, 404, bad);
    }
    makeRoute([a]);
    const used = await call('DELETE', `/api/patrols/checkpoints/${a}`, { role: 'admin' });
    assert.equal(used.status, 409);
    assert.match(used.json.error, /circuit/);
    assert.equal((await call('POST', '/api/patrols/checkpoints', { role: 'admin', body: { name: 'Gros', zone: 'z'.repeat(9000) } })).status, 413);
  });

  it('qr.svg : SVG, en-tetes de securite, 404 pour un point archive ou inconnu', async () => {
    const [id] = makePoints(1);
    const res = await call('GET', `/api/patrols/checkpoints/${id}/qr.svg`, { role: 'admin' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^image\/svg\+xml/);
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.text, /<svg/);
    // le QR change quand le code change (contenu = origine + /agent/#cp=<code>)
    await call('POST', `/api/patrols/checkpoints/${id}/recode`, { role: 'admin' });
    const after = await call('GET', `/api/patrols/checkpoints/${id}/qr.svg`, { role: 'admin' });
    assert.notEqual(after.text, res.text);
    env.patrols.archiveCheckpoint('chef', id);
    assert.equal((await call('GET', `/api/patrols/checkpoints/${id}/qr.svg`, { role: 'admin' })).status, 404);
    assert.equal((await call('GET', '/api/patrols/checkpoints/999/qr.svg', { role: 'admin' })).status, 404);
  });

  it('le QR encode https://<hote>/agent/#cp=<code>', async () => {
    const [id] = makePoints(1);
    const code = env.patrols.getCheckpoint(id)?.code;
    const QRCode = (await import('qrcode')).default;
    const expected = await QRCode.toString(`https://psim.test/agent/#cp=${code}`, { type: 'svg', margin: 1, width: 260 });
    assert.equal((await call('GET', `/api/patrols/checkpoints/${id}/qr.svg`, { role: 'admin' })).text, expected);
  });

  it('cree, modifie, desactive, archive un circuit', async () => {
    const ids = makePoints(3);
    const body = { name: 'Ronde', checkpoints: ids, ordered: true, maxMinutes: 40, schedule: NIGHT, agents: ['ali'], graceMinutes: 5 };
    const created = await call('POST', '/api/patrols/routes', { role: 'admin', body });
    assert.equal(created.status, 201);
    assert.deepEqual([created.json.deviceId, created.json.agents, created.json.graceMinutes, created.json.enabled], ['P-1', ['ali'], 5, true]);
    const patched = await call('PATCH', '/api/patrols/routes/1', { role: 'admin', body: { enabled: false, maxMinutes: 50 } });
    assert.equal(patched.status, 200);
    assert.deepEqual([patched.json.enabled, patched.json.maxMinutes], [false, 50]);
    const list = await call('GET', '/api/patrols/routes', { role: 'operator' });
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].name, 'Ronde');
    assert.equal((await call('DELETE', '/api/patrols/routes/1', { role: 'admin' })).status, 204);
    assert.equal((await call('GET', '/api/patrols/routes', { role: 'admin' })).json.length, 0);
    assert.equal((await call('GET', '/api/patrols/routes?archived=1', { role: 'admin' })).json.length, 1);
    assert.equal((await call('DELETE', '/api/patrols/routes/1', { role: 'admin' })).status, 404);
  });

  it('refuse un circuit invalide avec un message precis', async () => {
    const ids = makePoints(2);
    const post = (over: Record<string, unknown>) => call('POST', '/api/patrols/routes', { role: 'admin', body: { name: 'R', checkpoints: ids, maxMinutes: 30, schedule: NIGHT, ...over } });
    const dup = await post({ checkpoints: [ids[0], ids[0]] });
    assert.equal(dup.status, 400);
    assert.match(dup.json.error, /qu'une fois/);
    assert.equal((await post({ maxMinutes: 0 })).status, 400);
    assert.equal((await post({ agents: ['zorro'] })).status, 400);
    assert.equal((await post({ schedule: [] })).status, 400);
    assert.equal((await call('PATCH', '/api/patrols/routes/42', { role: 'admin', body: { name: 'x' } })).status, 404);
  });
});

describe('routes HTTP : journal', () => {
  beforeEach(() => serve());

  it('GET /api/patrols/runs : rondes avec passages, filtres, audit patrol_history_read limite dans le temps', async () => {
    const ids = makePoints(3);
    makeRoute(ids);
    tickAt(at(22, 0));
    scanOf(ids[0], { phoneAt: at(22, 1) });
    tickAt(at(22, 10));
    const url = `/api/patrols/runs?from=${at(0, 0)}&to=${at(23, 0)}`;
    const res = await call('GET', url, { role: 'operator', user: 'chef1' });
    assert.equal(res.status, 200);
    assert.equal(res.json.runs.length, 1);
    assert.equal(res.json.runs[0].scans.length, 1);
    assert.equal(res.json.runs[0].routeName, 'Ronde de nuit');
    assert.equal(res.json.runs[0].missing.length, 2);
    assert.equal(auditActions('patrol_history_read').length, 1);
    assert.equal(auditActions('patrol_history_read')[0].actor, 'chef1');
    // l'ecran se rafraichit seul : pas une entree par lecture
    await call('GET', url, { role: 'operator', user: 'chef1' });
    await call('GET', url, { role: 'operator', user: 'chef1' });
    assert.equal(auditActions('patrol_history_read').length, 1);
    // un autre lecteur, ou un autre filtre, est trace
    await call('GET', url, { role: 'admin', user: 'patron' });
    await call('GET', `${url}&username=ali`, { role: 'operator', user: 'chef1' });
    assert.equal(auditActions('patrol_history_read').length, 3);
    // plus tard : de nouveau trace
    env.env.clock = at(22, 30) + 11 * MIN;
    await call('GET', url, { role: 'operator', user: 'chef1' });
    assert.equal(auditActions('patrol_history_read').length, 4);
    // les filtres
    assert.equal((await call('GET', `${url}&routeId=1`, { role: 'admin' })).json.runs.length, 1);
    assert.equal((await call('GET', `${url}&routeId=2`, { role: 'admin' })).json.runs.length, 0);
    assert.equal((await call('GET', `${url}&username=bob`, { role: 'admin' })).json.runs.length, 0);
    assert.equal((await call('GET', `${url}&username=ali`, { role: 'admin' })).json.runs.length, 1);
    // dates ISO acceptees, defaut = les dernieres 24 h
    assert.equal((await call('GET', `/api/patrols/runs?from=${encodeURIComponent(new Date(at(0, 0)).toISOString())}&to=${at(23, 0)}`, { role: 'admin' })).json.runs.length, 1);
    assert.equal((await call('GET', '/api/patrols/runs', { role: 'admin' })).json.runs.length, 1);
  });

  it('GET /api/patrols/runs : parametres invalides = 400', async () => {
    for (const q of ['from=abc', 'to=nimporte', `from=${at(23, 0)}&to=${at(1, 0)}`, 'routeId=x', 'routeId=-1', `username=${'u'.repeat(65)}`, 'from=1&from=2']) {
      assert.equal((await call('GET', `/api/patrols/runs?${q}`, { role: 'admin' })).status, 400, q);
    }
    assert.equal(auditActions('patrol_history_read').length, 0);
  });

  it('GET /api/patrols/logbook, photo et incident', async () => {
    const { entry } = env.patrols.addLogbook('ali', 1, { clientId: 'log-http-02', category: 'visitor', text: 'Livraison', phoneAt: T0, photo: JPEG.toString('base64') });
    const { entry: plain } = env.patrols.addLogbook('ali', 1, { clientId: 'log-http-03', category: 'other', text: 'RAS', phoneAt: T0 });
    const list = await call('GET', `/api/patrols/logbook?from=${T0 - HOUR}&to=${T0 + HOUR}`, { role: 'operator' });
    assert.equal(list.status, 200);
    assert.equal(list.json.entries.length, 2);
    assert.equal(list.json.entries.find((e: { id: number }) => e.id === entry.id).hasPhoto, true);
    assert.equal((await call('GET', `/api/patrols/logbook?from=${T0 + HOUR}&to=${T0 + 2 * HOUR}`, { role: 'operator' })).json.entries.length, 0);
    assert.equal((await call('GET', '/api/patrols/logbook?from=zzz', { role: 'operator' })).status, 400);

    const photo = await call('GET', `/api/patrols/logbook/${entry.id}/photo`, { role: 'operator' });
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/jpeg');
    assert.equal(photo.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(photo.headers.get('cache-control'), 'private');
    assert.equal(photo.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(photo.buffer, JPEG);
    assert.equal((await call('GET', `/api/patrols/logbook/${plain.id}/photo`, { role: 'operator' })).status, 404);
    assert.equal((await call('GET', '/api/patrols/logbook/abc/photo', { role: 'operator' })).status, 404);
    assert.equal((await call('GET', '/api/patrols/logbook/999/photo', { role: 'operator' })).status, 404);

    const made = await call('POST', `/api/patrols/logbook/${entry.id}/incident`, { role: 'operator', user: 'chef1' });
    assert.equal(made.status, 200);
    assert.equal(env.base.incidentView(made.json.incidentId).event, 'logbook_report');
    assert.equal((await call('POST', `/api/patrols/logbook/${entry.id}/incident`, { role: 'operator' })).status, 409);
    assert.equal((await call('POST', '/api/patrols/logbook/999/incident', { role: 'operator' })).status, 404);
    assert.equal(auditActions('logbook_incident_created')[0].actor, 'chef1');
  });

  it('GET /api/patrols/positions : agents en service, avec le plan', async () => {
    const ids = makePoints(2);
    scanOf(ids[0]);
    const res = await call('GET', '/api/patrols/positions', { role: 'operator' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, [{ username: 'ali', displayName: 'Nom ali', checkpointId: ids[0], name: 'Parking', floorId: env.patrols.getCheckpoint(ids[0])?.floorId, x: 10, y: 20, at: T0 }]);
    env.onShift.delete('ali');
    assert.deepEqual((await call('GET', '/api/patrols/positions', { role: 'admin' })).json, []);
  });
});

describe('routes HTTP : agent', () => {
  beforeEach(() => serve());

  it('GET /api/agent/runs : rondes de l\'agent et prochaine a venir, jamais mises en cache', async () => {
    const ids = makePoints(2);
    makeRoute(ids);
    tickAt(at(22, 0));
    const res = await call('GET', '/api/agent/runs', { agent: 'ali' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.json.runs.length, 2);
    assert.equal(res.json.runs[0].status, 'pending');
    assert.equal(res.json.runs[0].checkpoints.length, 2);
    assert.equal(res.json.serverAt, at(22, 0));
  });

  it('POST /api/agent/scans : reponse du contrat, idempotent, 404 etiquette inconnue, 400 corps invalide', async () => {
    const ids = makePoints(2);
    makeRoute(ids);
    tickAt(at(22, 0));
    const code = env.patrols.getCheckpoint(ids[0])?.code;
    const body = { clientId: 'http-scan-01', code, method: 'nfc', phoneAt: at(22, 0) };
    const first = await call('POST', '/api/agent/scans', { agent: 'ali', body });
    assert.equal(first.status, 200);
    assert.deepEqual(Object.keys(first.json), ['scan']);
    assert.deepEqual(Object.keys(first.json.scan).sort(), ['checkpoint', 'deferred', 'run', 'verdict']);
    assert.equal(first.json.scan.verdict, 'ok');
    assert.deepEqual(first.json.scan.checkpoint, { id: ids[0], name: 'Parking' });
    assert.equal(first.json.scan.deferred, false); // booleen JSON
    assert.equal(first.json.scan.run.status, 'active');
    assert.deepEqual(Object.keys(first.json.scan.run).sort(), ['checkpoints', 'dueEnd', 'dueStart', 'id', 'name', 'ordered', 'routeId', 'status']);
    const again = await call('POST', '/api/agent/scans', { agent: 'ali', body });
    assert.deepEqual(again.json, first.json);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM patrol_scan').get()?.n, 1);
    const unknown = await call('POST', '/api/agent/scans', { agent: 'ali', body: { ...body, clientId: 'http-scan-02', code: 'zzzzzzzzzz' } });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error, 'Etiquette inconnue');
    assert.equal((await call('POST', '/api/agent/scans', { agent: 'ali', body: { ...body, clientId: 'x' } })).status, 400);
    assert.equal((await call('POST', '/api/agent/scans', { agent: 'ali', raw: '[1,2]' })).status, 400);
    assert.equal((await call('POST', '/api/agent/scans', { agent: 'ali', body: { ...body, clientId: 'http-scan-03', pad: 'x'.repeat(3000) } })).status, 413);
    // recu en differe : deferred vrai (booleen)
    env.env.clock = at(22, 20);
    const late = await call('POST', '/api/agent/scans', { agent: 'ali', body: { ...body, clientId: 'http-scan-04', code: env.patrols.getCheckpoint(ids[1])?.code, phoneAt: at(22, 5) } });
    assert.equal(late.json.scan.deferred, true);
    assert.equal(late.json.scan.run.status, 'done');
  });

  it('POST /api/agent/scans : l\'agent connu est celui de la session ; username de substitution via resolveSender', async () => {
    const ids = makePoints(1);
    const code = env.patrols.getCheckpoint(ids[0])?.code;
    const body = { clientId: 'http-sub-0001', code, method: 'qr', phoneAt: T0, username: 'bob' };
    const refused = await call('POST', '/api/agent/scans', { agent: 'ali', body });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error, "Envoi d'un autre agent refusé");
    env.allowedSenders.add('1:bob');
    assert.equal((await call('POST', '/api/agent/scans', { agent: 'ali', body })).status, 200);
    assert.equal(env.db.prepare('SELECT username FROM patrol_scan').get()?.username, 'bob');
    // autre telephone : l'autorisation de ce telephone ne vaut pas pour lui
    assert.equal((await call('POST', '/api/agent/scans', { agent: 'ali', phone: 2, body: { ...body, clientId: 'http-sub-0002' } })).status, 403);
  });

  it('POST /api/agent/logbook : entree avec photo, idempotente, limite de 600 Ko', async () => {
    const body = { clientId: 'http-log-0001', category: 'anomaly', text: 'Lumiere cassee', phoneAt: T0, photo: JPEG.toString('base64') };
    const res = await call('POST', '/api/agent/logbook', { agent: 'ali', body });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json), ['entry']);
    assert.deepEqual(Object.keys(res.json.entry), ['id']);
    const again = await call('POST', '/api/agent/logbook', { agent: 'ali', body });
    assert.deepEqual(again.json, res.json);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM logbook_entry').get()?.n, 1);
    assert.ok(existsSync(join(env.dir, 'logbook', `${res.json.entry.id}.jpg`)));
    // photo a la limite : passe le plafond JSON de 600 Ko
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400 * 1024 - 3)]).toString('base64');
    assert.equal((await call('POST', '/api/agent/logbook', { agent: 'ali', body: { ...body, clientId: 'http-log-0002', photo: big } })).status, 200);
    // au-dela de 400 Ko decodes : 413
    const tooBig = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(450 * 1024)]).toString('base64');
    assert.equal((await call('POST', '/api/agent/logbook', { agent: 'ali', body: { ...body, clientId: 'http-log-0003', photo: tooBig } })).status, 413);
    // au-dela de 600 Ko de corps : 413 aussi
    const huge = 'A'.repeat(700 * 1024);
    assert.equal((await call('POST', '/api/agent/logbook', { agent: 'ali', body: { ...body, clientId: 'http-log-0004', photo: huge } })).status, 413);
    assert.equal((await call('POST', '/api/agent/logbook', { agent: 'ali', body: { ...body, clientId: 'http-log-0005', category: 'nope' } })).status, 400);
    assert.equal((await call('POST', '/api/agent/logbook', { agent: 'ali', body: { ...body, clientId: 'http-log-0006', photo: 'pas-du-base64!' } })).status, 400);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM logbook_entry').get()?.n, 2);
  });

  it('POST /api/agent/logbook : username de substitution (telephone partage)', async () => {
    const body = { clientId: 'http-log-sub01', category: 'other', text: 'RAS', phoneAt: T0, username: 'bob' };
    assert.equal((await call('POST', '/api/agent/logbook', { agent: 'ali', body })).status, 403);
    env.allowedSenders.add('1:bob');
    assert.equal((await call('POST', '/api/agent/logbook', { agent: 'ali', body })).status, 200);
    assert.equal(env.db.prepare('SELECT username FROM logbook_entry').get()?.username, 'bob');
  });
});

// ------------------------------------------------------------------ avec le vrai service des agents

describe('avec le vrai service des agents (agents.ts)', () => {
  const KEY = Buffer.alloc(32, 5);
  const PIN = '90817';

  function real(start = at(22, 0)) {
    const db = openDb(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'psim-patrols-real-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const clock = { t: start };
    const now = () => clock.t;
    const engine = createEngine(db, () => {}, now);
    const users = createUsersService({ db, key: KEY, now, audit: (a, b, c) => engine.audit(a, b, c) });
    useSessionStore(db);
    setSessionValidator(users.validateSession);
    const agents = createAgents({ db, engine, users, now });
    const patrols = createPatrols({ db, engine, agents, dataDir: dir, now });
    const phone = (label: string) => {
      const created = agents.createPhone('admin', label);
      const paired = agents.pairPhone(created.code);
      return { id: paired.phone.id, key: paired.key };
    };
    const agent = (username: string, phoneId: number) => {
      agents.createAgent('admin', { username, displayName: `Agent ${username}`, pin: PIN, zones: [] });
      agents.startShift(username, phoneId);
    };
    return { db, dir, clock, engine, users, agents, patrols, phone, agent };
  }

  it('la position de l\'agent en service suit ses scans (me, positions) ; hors service, rien', () => {
    const r = real();
    const tel = r.phone('Tel 1');
    r.agent('moussa', tel.id);
    const cp = r.patrols.createCheckpoint('admin', { name: 'Parking', zone: 'Cour', x: 12, y: 34 });
    r.patrols.createRoute('admin', { name: 'Ronde', checkpoints: [cp.id], maxMinutes: 30, schedule: NIGHT, agents: ['moussa'] });
    r.patrols.tick();
    const sent = r.patrols.scan('moussa', tel.id, { clientId: 'real-0000001', code: r.patrols.getCheckpoint(cp.id)?.code, method: 'nfc', phoneAt: r.clock.t });
    assert.equal(sent.scan.verdict, 'ok');
    assert.equal(sent.scan.run?.status, 'done');
    assert.deepEqual(r.agents.me('moussa').position, { checkpointId: cp.id, name: 'Parking', at: r.clock.t });
    const [p] = r.patrols.positions();
    assert.deepEqual([p.username, p.displayName, p.name, p.x, p.y], ['moussa', 'Agent moussa', 'Parking', 12, 34]);
    r.agents.endShift('moussa', 'agent');
    assert.deepEqual(r.patrols.positions(), []);
    r.patrols.scan('moussa', tel.id, { clientId: 'real-0000002', code: r.patrols.getCheckpoint(cp.id)?.code, method: 'nfc', phoneAt: r.clock.t });
    assert.deepEqual(r.patrols.positions(), []); // hors service : pas de position
  });

  it('telephone partage : l\'envoi de l\'agent precedent est enregistre a son nom, sinon 403', () => {
    const r = real();
    const tel = r.phone('Partage');
    const other = r.phone('Autre');
    r.agent('moussa', tel.id);
    const cp = r.patrols.createCheckpoint('admin', { name: 'Cave' });
    const code = r.patrols.getCheckpoint(cp.id)?.code;
    const startedAt = r.clock.t;
    r.clock.t = startedAt + 20 * MIN;
    r.agents.endShift('moussa', 'agent');
    r.agent('awa', tel.id);
    r.clock.t = startedAt + 60 * MIN;
    // l'envoi de moussa (fait pendant son service), remonte par la session d'awa
    const ok = r.patrols.scan('awa', tel.id, { clientId: 'real-share-01', code, method: 'qr', phoneAt: startedAt + 5 * MIN, username: 'moussa' });
    assert.equal(ok.scan.deferred, true);
    assert.equal(r.db.prepare('SELECT username FROM patrol_scan').get()?.username, 'moussa');
    // hors de son service ou d'un autre telephone : refuse
    assert.throws(() => r.patrols.scan('awa', tel.id, { clientId: 'real-share-02', code, method: 'qr', phoneAt: startedAt + 40 * MIN, username: 'moussa' }), status(403)); // apres la fin de son service (+ 5 min)
    assert.throws(() => r.patrols.scan('awa', other.id, { clientId: 'real-share-03', code, method: 'qr', phoneAt: startedAt + 5 * MIN, username: 'moussa' }), status(403));
    assert.throws(() => r.patrols.scan('awa', tel.id, { clientId: 'real-share-04', code, method: 'qr', phoneAt: r.clock.t, username: 'inconnu' }), status(403));
    assert.throws(() => r.patrols.addLogbook('awa', other.id, { clientId: 'real-share-05', category: 'other', text: 'RAS', phoneAt: startedAt + 5 * MIN, username: 'moussa' }), status(403));
    r.patrols.addLogbook('awa', tel.id, { clientId: 'real-share-06', category: 'other', text: 'RAS', phoneAt: startedAt + 5 * MIN, username: 'moussa' });
    assert.equal(r.db.prepare('SELECT username FROM logbook_entry').get()?.username, 'moussa');
    assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM patrol_scan').get()?.n, 1);
  });

  it('de bout en bout : telephone appaire + session d\'agent ouvrent les routes de l\'agent, rien d\'autre', async () => {
    // Les sessions expirent selon l'horloge reelle (auth.ts) : ce test vit a l'heure reelle. Ronde qui commence dans 10 min,
    // scan accepte jusqu'a 15 min avant le debut.
    const r = real(Date.now());
    const startsAt = new Date(r.clock.t + 10 * MIN);
    const from = `${String(startsAt.getHours()).padStart(2, '0')}:${String(startsAt.getMinutes()).padStart(2, '0')}`;
    const tel = r.phone('Terrain');
    r.agent('moussa', tel.id);
    const cp = r.patrols.createCheckpoint('admin', { name: 'Parking' });
    r.patrols.createRoute('admin', { name: 'Ronde', checkpoints: [cp.id], maxMinutes: 30, schedule: [{ days: ALL, from, to: '23:59' === from ? '00:01' : '23:59' }] });

    const app = express();
    const roleNow = (req: Request): string => getSession(parseCookies(req.headers.cookie).psim_session)?.role ?? '';
    const ctx: MountContext = {
      sessionOf: (req) => getSession(parseCookies(req.headers.cookie).psim_session),
      adminOnly: (req, res, next) => (roleNow(req) === 'admin' ? next() : void res.status(403).json({ error: 'Droits insuffisants' })),
      staff: (req, res, next) => (['admin', 'operator'].includes(roleNow(req)) ? next() : void res.status(403).json({ error: 'Droits insuffisants' })),
      actorOf: () => 'oscar',
      roleOf: () => 'operator',
      json: (limit) => express.json({ limit }),
      cookieSecure: false,
      originOf: () => 'https://psim.test',
    };
    r.agents.mount(app, ctx);
    r.patrols.mount(app, ctx);
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof PsimError) return void res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Erreur interne' });
    });
    const listening = app.listen(0, '127.0.0.1');
    server = listening;
    await new Promise<void>((resolve) => listening.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;

    const send = async (path: string, cookie: string, body?: unknown) => {
      const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: (await res.json().catch(() => null)) as any };
    };
    const phoneCookie = `psim_phone=${tel.key}`;
    assert.equal((await send('/api/agent/runs', phoneCookie)).status, 401); // sans session
    const login = await fetch(`${base}/api/agent/login`, { method: 'POST', headers: { cookie: phoneCookie, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'moussa', pin: PIN }) });
    assert.equal(login.status, 200);
    const session = /psim_session=([0-9a-f]{64})/.exec(login.headers.get('set-cookie') ?? '')?.[1];
    assert.ok(session);
    const cookie = `${phoneCookie}; psim_session=${session}`;
    const runs = await send('/api/agent/runs', cookie);
    assert.equal(runs.status, 200);
    assert.equal(runs.json.runs[0].name, 'Ronde');
    const scan = await send('/api/agent/scans', cookie, { clientId: 'real-http-001', code: r.patrols.getCheckpoint(cp.id)?.code, method: 'qr', phoneAt: r.clock.t });
    assert.equal(scan.status, 200);
    assert.equal(scan.json.scan.verdict, 'ok');
    assert.equal(scan.json.scan.deferred, false);
    assert.equal((await send('/api/agent/logbook', cookie, { clientId: 'real-http-002', category: 'other', text: 'RAS', phoneAt: r.clock.t })).status, 200);
    // sans la cle du telephone : refuse, meme avec une session valide
    assert.equal((await send('/api/agent/scans', `psim_session=${session}`, { clientId: 'real-http-003', code: 'x', method: 'qr', phoneAt: r.clock.t })).status, 401);
    // le journal de l'exploitation est ferme a l'agent
    assert.equal((await send('/api/patrols/runs', cookie)).status, 403);
    assert.equal((await send('/api/patrols/positions', cookie)).status, 403);
    assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM patrol_scan').get()?.n, 1);
  });
});
