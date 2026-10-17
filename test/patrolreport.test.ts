import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import { createPatrolReport, mountPatrolReport, NO_AGENT } from '../server/patrolreport.ts';
import type { PatrolReport } from '../server/patrolreport.ts';
import { createPatrols } from '../server/patrols.ts';
import type { PatrolAgents } from '../server/patrols.ts';
import { createReports, MAX_CSV_ROWS, parseRange } from '../server/reports.ts';

/**
 * Rapport de rondes (server/patrolreport.ts) : agregats, frontieres de jour, taux, CSV, section HTML, rapport e-mail, routes
 * HTTP, et un essai de bout en bout contre le vrai serveur. Les tables viennent du vrai schema (createPatrols) ; les lignes
 * sont inserees en SQL pour maitriser chaque instant. Dates en heure LOCALE, comme le reste des rapports.
 */

const MIN = 60_000;
const HOUR = 3_600_000;
const ALL = [0, 1, 2, 3, 4, 5, 6];
/** `d` juin 2026 a `h`:`m`:`s` heure locale. */
const at = (d: number, h = 12, m = 0, s = 0, ms = 0): number => new Date(2026, 5, d, h, m, s, ms).getTime();
const range = (from: string, to: string) => parseRange({ from, to });
const stubAgents: PatrolAgents = {
  isAgent: () => true,
  detectorId: (u) => `A-${u}`,
  setPosition: () => {},
  positions: () => [],
  resolveSender: (_phone, session) => session,
  requireAgent: (_req, _res, next) => next(),
  agentOf: () => ({ username: 'ali', phoneId: 1 }),
};

const cleanup: (() => void)[] = [];
afterEach(() => {
  mock.restoreAll();
  while (cleanup.length > 0) cleanup.pop()?.();
});

interface Env {
  db: DatabaseSync;
  engine: ReturnType<typeof createEngine>;
  clock: { t: number };
  patrols: ReturnType<typeof createPatrols>;
  report: ReturnType<typeof createPatrolReport>;
  n: number;
}

/** Base avec le schema des rondes (vide) et une table `agent_profile` minimale. */
function setup(opts: { tables?: boolean; profiles?: boolean } = {}): Env {
  const db = openDb(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'psim-patrolreport-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { t: at(10, 12) };
  const engine = createEngine(db, () => {}, () => clock.t);
  const patrols = createPatrols({ db: opts.tables === false ? openDb(':memory:') : db, engine, agents: stubAgents, dataDir: dir, now: () => clock.t });
  if (opts.profiles !== false) db.exec('CREATE TABLE IF NOT EXISTS agent_profile (username TEXT PRIMARY KEY, display_name TEXT NOT NULL)');
  return { db, engine, clock, patrols, report: createPatrolReport({ db, now: () => clock.t }), n: 0 };
}

/** Une base SANS les tables des rondes (PSIM sans l'application des agents). */
function bare(): Env {
  const db = openDb(':memory:');
  const clock = { t: at(10, 12) };
  const engine = createEngine(db, () => {}, () => clock.t);
  return { db, engine, clock, patrols: null as never, report: createPatrolReport({ db, now: () => clock.t }), n: 0 };
}

const profile = (e: Env, username: string, displayName: string) => e.db.prepare('INSERT INTO agent_profile (username, display_name) VALUES (?, ?)').run(username, displayName);

function route(e: Env, name: string, points: number[], over: { archived?: boolean; rawPoints?: string } = {}): number {
  const r = e.db
    .prepare('INSERT INTO patrol_route (name, checkpoints, max_minutes, schedule, archived_at) VALUES (?, ?, 30, ?, ?)')
    .run(name, over.rawPoints ?? JSON.stringify(points), JSON.stringify([{ days: ALL, from: '22:00', to: '23:00' }]), over.archived ? 1 : null);
  return Number(r.lastInsertRowid);
}

function run(e: Env, routeId: number, dueStart: number, dueEnd: number, status: string, startedBy: string | null = null): number {
  const r = e.db.prepare('INSERT INTO patrol_run (route_id, due_start, due_end, status, started_by) VALUES (?, ?, ?, ?, ?)').run(routeId, dueStart, dueEnd, status, startedBy);
  return Number(r.lastInsertRowid);
}

function scan(e: Env, runId: number | null, checkpoint: number, o: { serverAt: number; phoneAt?: number; deferred?: boolean; verdict?: string }): void {
  e.db
    .prepare("INSERT INTO patrol_scan (client_id, run_id, checkpoint_id, username, phone_id, method, phone_at, server_at, deferred, verdict) VALUES (?, ?, ?, 'x', 1, 'qr', ?, ?, ?, ?)")
    .run(`client-${String(++e.n).padStart(8, '0')}`, runId, checkpoint, o.phoneAt ?? o.serverAt, o.serverAt, o.deferred ? 1 : 0, o.verdict ?? 'ok');
}

/**
 * Jeu de reference : 2 circuits (Nuit = points 1-3, Jour = points 4-5), 2 agents (ali a un profil « Ali Traoré », bob n'en a
 * pas), 3 jours (8, 9 et 10 juin 2026), tous les statuts.
 */
function reference(): Env & { nuit: number; jour: number } {
  const e = setup();
  profile(e, 'ali', 'Ali Traoré');
  const nuit = route(e, 'Nuit', [1, 2, 3]);
  const jour = route(e, 'Jour', [4, 5]);
  // 8 juin
  const r1 = run(e, nuit, at(8, 22), at(8, 22, 30), 'done', 'ali');
  scan(e, r1, 1, { serverAt: at(8, 22, 2) });
  scan(e, r1, 2, { serverAt: at(8, 22, 10) });
  scan(e, r1, 3, { serverAt: at(8, 22, 20) });
  const r2 = run(e, jour, at(8, 8), at(8, 8, 20), 'done', 'bob');
  scan(e, r2, 4, { serverAt: at(8, 7, 45) }); // exactement 15 min avant le debut : a l'heure
  scan(e, r2, 5, { serverAt: at(8, 8, 20) }); // exactement a l'echeance : a l'heure
  // 9 juin : ronde de nuit a cheval sur le 10, et ronde de jour non faite
  const r3 = run(e, nuit, at(9, 22), at(10, 2), 'incomplete', 'ali');
  scan(e, r3, 1, { serverAt: at(9, 22, 30) });
  scan(e, r3, 2, { serverAt: at(10, 1, 59, 59) });
  run(e, jour, at(9, 8), at(9, 8, 20), 'missed');
  // 10 juin
  const r5 = run(e, jour, at(10, 8), at(10, 8, 20), 'done', 'bob');
  scan(e, r5, 4, { serverAt: at(10, 8, 5) });
  scan(e, r5, 5, { serverAt: at(10, 8, 10), phoneAt: at(10, 7, 40), deferred: true }); // heure du telephone : trop tot
  run(e, nuit, at(10, 22), at(10, 22, 30), 'pending');
  const r7 = run(e, jour, at(10, 12), at(10, 12, 20), 'incomplete', 'ali');
  scan(e, r7, 4, { serverAt: at(10, 14), phoneAt: at(10, 12, 10), deferred: true }); // recu tard mais passe a l'heure
  scan(e, r7, 5, { serverAt: at(10, 12, 11), verdict: 'duplicate' }); // un doublon ne compte pas
  scan(e, null, 5, { serverAt: at(10, 12, 12), verdict: 'no_run' });
  const r8 = run(e, jour, at(10, 18), at(10, 18, 20), 'active', 'bob');
  scan(e, r8, 4, { serverAt: at(10, 18, 1) });
  return Object.assign(e, { nuit, jour });
}

const pick = <T extends object>(o: T, keys: (keyof T)[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const COUNT_KEYS = ['planned', 'done', 'incomplete', 'missed', 'pending', 'expectedPoints', 'onTimePoints'] as const;

// ------------------------------------------------------------------ agregats

describe('agregats du rapport de rondes', () => {
  it('totaux, par jour, par circuit, par agent : compteurs et taux', () => {
    const e = reference();
    const r = e.report.build(range('2026-06-08', '2026-06-10'));
    assert.equal(r.from, '2026-06-08');
    assert.equal(r.to, '2026-06-10');
    assert.equal(r.fromDay, '2026-06-08');
    assert.equal(r.toDay, '2026-06-10');
    assert.equal(r.generatedAt, e.clock.t);

    assert.deepEqual(pick(r.totals, [...COUNT_KEYS]), { planned: 8, done: 3, incomplete: 2, missed: 1, pending: 2, expectedPoints: 14, onTimePoints: 9 });
    assert.equal(r.totals.doneRate, 3 / 6, 'les rondes a venir ou en cours sont exclues des taux');
    assert.equal(r.totals.onTimeRate, 9 / 14);

    assert.deepEqual(
      r.byDay.map((d) => [d.day, d.planned, d.done, d.incomplete, d.missed, d.pending, d.expectedPoints, d.onTimePoints]),
      [
        ['2026-06-08', 2, 2, 0, 0, 0, 5, 5],
        ['2026-06-09', 2, 0, 1, 1, 0, 5, 2],
        ['2026-06-10', 4, 1, 1, 0, 2, 4, 2],
      ],
    );
    assert.equal(r.byDay[0].doneRate, 1);
    assert.equal(r.byDay[0].onTimeRate, 1);
    assert.equal(r.byDay[1].doneRate, 0);
    assert.equal(r.byDay[1].onTimeRate, 2 / 5);
    assert.equal(r.byDay[2].doneRate, 1 / 2);

    assert.deepEqual(
      r.byRoute.map((c) => [c.name, c.routeId, c.archived, c.planned, c.done, c.incomplete, c.missed, c.pending, c.expectedPoints, c.onTimePoints]),
      [
        ['Jour', e.jour, false, 5, 2, 1, 1, 1, 8, 4],
        ['Nuit', e.nuit, false, 3, 1, 1, 0, 1, 6, 5],
      ],
      'trie par nom',
    );
    assert.equal(r.byRoute[0].doneRate, 2 / 4);
    assert.equal(r.byRoute[1].onTimeRate, 5 / 6);

    assert.deepEqual(
      r.byAgent.map((a) => [a.username, a.name, a.planned, a.done, a.incomplete, a.missed, a.pending, a.expectedPoints, a.onTimePoints]),
      [
        ['ali', 'Ali Traoré', 3, 1, 2, 0, 0, 8, 6],
        ['bob', 'bob', 3, 2, 0, 0, 1, 4, 3],
      ],
      'nom affiche du profil, repli sur l identifiant ; la ronde sans agent n y figure pas',
    );
    assert.equal(
      r.byAgent.reduce((n, a) => n + a.planned, 0),
      6,
      'la ronde non faite (sans agent) et la ronde a venir sans agent sont hors de byAgent : 8 - 2',
    );
  });

  it("rows : une ligne par jour, circuit et agent, la ronde sans agent est rattachee a « (personne) »", () => {
    const e = reference();
    const r = e.report.build(range('2026-06-08', '2026-06-10'));
    assert.deepEqual(
      r.rows.map((x) => [x.day, x.route, x.username, x.agent, x.planned, x.done, x.pending, x.expectedPoints, x.onTimePoints]),
      [
        ['2026-06-08', 'Jour', 'bob', 'bob', 1, 1, 0, 2, 2],
        ['2026-06-08', 'Nuit', 'ali', 'Ali Traoré', 1, 1, 0, 3, 3],
        ['2026-06-09', 'Jour', null, NO_AGENT, 1, 0, 0, 2, 0],
        ['2026-06-09', 'Nuit', 'ali', 'Ali Traoré', 1, 0, 0, 3, 2],
        ['2026-06-10', 'Jour', 'ali', 'Ali Traoré', 1, 0, 0, 2, 1],
        ['2026-06-10', 'Jour', 'bob', 'bob', 2, 1, 1, 2, 1],
        ['2026-06-10', 'Nuit', null, NO_AGENT, 1, 0, 1, 0, 0],
      ],
    );
    const sum = (k: (typeof COUNT_KEYS)[number]) => r.rows.reduce((n, x) => n + x[k], 0);
    for (const k of COUNT_KEYS) assert.equal(sum(k), r.totals[k], `les lignes somment aux totaux : ${k}`);
  });

  it("l'heure d'un passage est celle de la machine des rondes : telephone si differe, serveur sinon", () => {
    const e = setup();
    const c = route(e, 'Nuit', [1, 2, 3, 4]);
    const start = at(10, 22);
    const id = run(e, c, start, start + 30 * MIN, 'incomplete', 'ali');
    scan(e, id, 1, { serverAt: start - 15 * MIN }); // borne basse incluse
    scan(e, id, 2, { serverAt: start - 15 * MIN - 1 }); // 1 ms trop tot
    scan(e, id, 3, { serverAt: start + 30 * MIN }); // borne haute incluse
    scan(e, id, 4, { serverAt: start + 30 * MIN + 1 }); // 1 ms apres l'echeance (delai de grace)
    const r = e.report.build(range('2026-06-10', '2026-06-10'));
    assert.equal(r.totals.expectedPoints, 4);
    assert.equal(r.totals.onTimePoints, 2);

    const e2 = setup();
    const c2 = route(e2, 'Nuit', [1, 2]);
    const id2 = run(e2, c2, start, start + 30 * MIN, 'done', 'ali');
    // Recu apres l'echeance mais passe a l'heure (telephone) ; recu a l'heure mais passe trop tard (telephone) : seule l'heure du telephone compte.
    scan(e2, id2, 1, { serverAt: start + 3 * HOUR, phoneAt: start + 10 * MIN, deferred: true });
    scan(e2, id2, 2, { serverAt: start + 10 * MIN, phoneAt: start + 31 * MIN, deferred: true });
    assert.equal(e2.report.build(range('2026-06-10', '2026-06-10')).totals.onTimePoints, 1);

    // Non differe : la colonne `phone_at` est ignoree, meme si elle est absurde.
    const e3 = setup();
    const c3 = route(e3, 'Nuit', [1]);
    const id3 = run(e3, c3, start, start + 30 * MIN, 'done', 'ali');
    scan(e3, id3, 1, { serverAt: start + 5 * MIN, phoneAt: start - 5 * HOUR, deferred: false });
    assert.equal(e3.report.build(range('2026-06-10', '2026-06-10')).totals.onTimePoints, 1);
  });

  it("frontieres de jour : une ronde de 22 h a 2 h appartient au jour de son debut", () => {
    const e = reference();
    const only9 = e.report.build(range('2026-06-09', '2026-06-09'));
    assert.deepEqual(only9.byDay.map((d) => d.day), ['2026-06-09']);
    assert.ok(only9.rows.some((r) => r.route === 'Nuit' && r.planned === 1 && r.incomplete === 1), 'la ronde de nuit du 9 (fin le 10 a 2 h) est du 9');
    const only10 = e.report.build(range('2026-06-10', '2026-06-10'));
    assert.ok(!only10.rows.some((r) => r.route === 'Nuit' && r.incomplete === 1), 'et pas du 10');
    assert.equal(only10.totals.planned, 4);

    // Minuit pile et 23 h 59 : chacun dans son jour ; la fin de periode est exclusive.
    const e2 = setup();
    const c = route(e2, 'Nuit', [1]);
    run(e2, c, at(9, 23, 59, 59, 999), at(10, 0, 30), 'missed');
    run(e2, c, at(10, 0, 0, 0, 0), at(10, 0, 30), 'missed');
    const d9 = e2.report.build(range('2026-06-09', '2026-06-09'));
    const d10 = e2.report.build(range('2026-06-10', '2026-06-10'));
    assert.deepEqual([d9.totals.planned, d10.totals.planned], [1, 1]);
    assert.equal(e2.report.build(range('2026-06-09', '2026-06-10')).totals.planned, 2);
    assert.equal(e2.report.build(range('2026-06-11', '2026-06-12')).totals.planned, 0);
  });

  it('taux inconnus (null) sans ronde echue, et rapport vide sans aucune ronde', () => {
    const e = setup();
    const c = route(e, 'Nuit', [1, 2]);
    run(e, c, at(10, 22), at(10, 22, 30), 'pending');
    const id = run(e, c, at(11, 22), at(11, 22, 30), 'active', 'ali');
    scan(e, id, 1, { serverAt: at(11, 22, 5) });
    const r = e.report.build(range('2026-06-10', '2026-06-11'));
    assert.equal(r.totals.planned, 2);
    assert.equal(r.totals.pending, 2);
    assert.equal(r.totals.doneRate, null);
    assert.equal(r.totals.onTimeRate, null);
    assert.equal(r.totals.expectedPoints, 0, 'les points des rondes a venir ne sont pas attendus');
    assert.equal(r.totals.onTimePoints, 0);
    assert.ok(r.byDay.every((d) => d.doneRate === null && d.onTimeRate === null));

    const none = e.report.build(range('2026-05-01', '2026-05-02'));
    assert.deepEqual(pick(none.totals, [...COUNT_KEYS]), { planned: 0, done: 0, incomplete: 0, missed: 0, pending: 0, expectedPoints: 0, onTimePoints: 0 });
    assert.equal(none.totals.doneRate, null);
    assert.deepEqual([none.byDay, none.byRoute, none.byAgent, none.rows], [[], [], [], []]);
  });

  it('une ronde non faite compte tous ses points comme attendus mais aucun a l heure : taux 0, pas null', () => {
    const e = setup();
    const c = route(e, 'Nuit', [1, 2, 3]);
    run(e, c, at(10, 22), at(10, 22, 30), 'missed');
    const r = e.report.build(range('2026-06-10', '2026-06-10'));
    assert.equal(r.totals.expectedPoints, 3);
    assert.equal(r.totals.onTimeRate, 0);
    assert.equal(r.totals.doneRate, 0);
  });

  it('circuit archive ou supprime, nom vide, JSON de points hostile : le rapport ne plante pas', () => {
    const e = setup();
    const old = route(e, 'Ancien <circuit>', [1, 2], { archived: true });
    const blank = route(e, '   ', [1]);
    const garbage = route(e, 'Corrompu', [], { rawPoints: '{pas du json' });
    const mixed = route(e, 'Melange', [], { rawPoints: '[1, "2", null, 3.5, 4, 4]' });
    run(e, old, at(10, 22), at(10, 22, 30), 'done', 'ali');
    run(e, blank, at(10, 23), at(10, 23, 30), 'missed');
    run(e, garbage, at(10, 21), at(10, 21, 30), 'missed');
    run(e, mixed, at(10, 20), at(10, 20, 30), 'missed');
    const gone = run(e, 999, at(10, 19), at(10, 19, 30), 'done', 'bob'); // le circuit n'existe plus
    scan(e, gone, 7, { serverAt: at(10, 19, 5) });
    scan(e, gone, 8, { serverAt: at(10, 19, 10) });
    const r = e.report.build(range('2026-06-10', '2026-06-10'));
    const byId = (id: number) => r.byRoute.find((c) => c.routeId === id)!;
    assert.equal(byId(old).name, 'Ancien <circuit>', 'un circuit archive garde son nom');
    assert.equal(byId(old).archived, true);
    assert.equal(byId(old).expectedPoints, 2);
    assert.equal(byId(blank).name, `Circuit n°${blank}`);
    assert.equal(byId(garbage).expectedPoints, 0);
    assert.equal(byId(mixed).expectedPoints, 2, 'seuls les identifiants entiers valides, sans doublon');
    assert.equal(byId(999).name, 'Circuit n°999');
    assert.equal(byId(999).expectedPoints, 2, 'sans circuit, les points sont ceux des passages de la ronde');
    assert.equal(byId(999).onTimePoints, 2);
    assert.equal(r.totals.planned, 5);
  });

  it("l'agent d'une ronde est celui du premier passage (started_by), pas celui des passages suivants", () => {
    const e = setup();
    profile(e, 'ali', 'Ali');
    const c = route(e, 'Nuit', [1, 2]);
    const id = run(e, c, at(10, 22), at(10, 22, 30), 'done', 'ali');
    scan(e, id, 1, { serverAt: at(10, 22, 1) });
    scan(e, id, 2, { serverAt: at(10, 22, 2) });
    e.db.prepare("UPDATE patrol_scan SET username = 'bob' WHERE run_id = ?").run(id);
    const r = e.report.build(range('2026-06-10', '2026-06-10'));
    assert.deepEqual(r.byAgent.map((a) => a.username), ['ali']);
  });

  it('sans table agent_profile : le nom affiche est l identifiant', () => {
    const e = setup({ profiles: false });
    const c = route(e, 'Nuit', [1]);
    run(e, c, at(10, 22), at(10, 22, 30), 'done', 'ali');
    const r = e.report.build(range('2026-06-10', '2026-06-10'));
    assert.deepEqual(r.byAgent.map((a) => [a.username, a.name]), [['ali', 'ali']]);
  });

  it('un statut inconnu en base est ignore (ligne corrompue)', () => {
    const e = setup();
    const c = route(e, 'Nuit', [1]);
    run(e, c, at(10, 22), at(10, 22, 30), 'done', 'ali');
    e.db.exec('PRAGMA ignore_check_constraints = ON');
    run(e, c, at(10, 23), at(10, 23, 30), 'bizarre', 'ali');
    e.db.exec('PRAGMA ignore_check_constraints = OFF');
    assert.equal(e.report.build(range('2026-06-10', '2026-06-10')).totals.planned, 1);
  });

  it('le calcul reste correct sur beaucoup de rondes', () => {
    const e = setup();
    const c = route(e, 'Nuit', [1, 2]);
    e.db.exec('BEGIN');
    for (let i = 0; i < 3000; i++) {
      const start = at(1, 0) + i * 5 * MIN;
      const id = run(e, c, start, start + 4 * MIN, 'done', 'ali');
      scan(e, id, 1, { serverAt: start });
      scan(e, id, 2, { serverAt: start + MIN });
    }
    e.db.exec('COMMIT');
    const r = e.report.build(range('2026-06-01', '2026-06-30'));
    assert.equal(r.totals.planned, 3000);
    assert.equal(r.totals.onTimeRate, 1);
  });
});

// ------------------------------------------------------------------ absence des tables

describe('PSIM sans l application des agents', () => {
  it('hasRoutes() est faux et build() renvoie un rapport vide', () => {
    const e = bare();
    assert.equal(e.report.hasRoutes(), false);
    const r = e.report.build(range('2026-06-01', '2026-06-30'));
    assert.equal(r.totals.planned, 0);
    assert.equal(r.totals.doneRate, null);
    assert.deepEqual([r.byDay, r.byRoute, r.byAgent, r.rows], [[], [], [], []]);
    assert.equal(e.report.csv(r).split('\r\n').length, 2, 'en-tete + fin de ligne seulement');
    assert.match(e.report.sectionHtml(r), /Aucune ronde prévue/);
  });

  it('les tables creees apres coup sont vues (rien n est memorise)', () => {
    const e = bare();
    assert.equal(e.report.hasRoutes(), false);
    createPatrols({ db: e.db, engine: e.engine, agents: stubAgents, dataDir: mkdtempSync(join(tmpdir(), 'psim-pr-')), now: () => e.clock.t });
    route(e, 'Nuit', [1]);
    assert.equal(e.report.hasRoutes(), true);
  });

  it('hasRoutes() : un circuit non archive suffit, des circuits archives seuls ne suffisent pas', () => {
    const e = setup();
    assert.equal(e.report.hasRoutes(), false, 'tables vides');
    route(e, 'Vieux', [1], { archived: true });
    assert.equal(e.report.hasRoutes(), false);
    route(e, 'Actif', [1]);
    assert.equal(e.report.hasRoutes(), true);
  });
});

// ------------------------------------------------------------------ CSV

describe('CSV du rapport de rondes', () => {
  it('en-tetes francais, BOM, separateur « ; », CRLF, une ligne par jour/circuit/agent', () => {
    const e = reference();
    const csv = e.report.csv(e.report.build(range('2026-06-08', '2026-06-10')));
    assert.ok(csv.startsWith('\uFEFF'), 'BOM UTF-8 pour Excel');
    const lines = csv.slice(1).split('\r\n');
    assert.equal(lines.pop(), '', 'fin de ligne CRLF finale');
    assert.equal(lines[0], 'Jour;Circuit;Agent;Rondes prévues;Faites;Incomplètes;Non faites;À venir ou en cours;Points attendus;Points à l’heure;Taux à l’heure (%)');
    assert.equal(lines.length, 1 + 7);
    assert.equal(lines[1], '2026-06-08;Jour;bob;1;1;0;0;0;2;2;100');
    assert.equal(lines[2], '2026-06-08;Nuit;Ali Traoré;1;1;0;0;0;3;3;100');
    assert.equal(lines[3], `2026-06-09;Jour;${NO_AGENT};1;0;0;1;0;2;0;0`);
    assert.equal(lines[4], '2026-06-09;Nuit;Ali Traoré;1;0;1;0;0;3;2;66,7', 'une decimale, virgule decimale');
    assert.equal(lines[7], `2026-06-10;Nuit;${NO_AGENT};1;0;0;0;1;0;0;`, 'taux vide quand aucun point n est attendu');
    assert.ok(!csv.includes('\n') || csv.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r')), 'aucun saut de ligne nu');
  });

  it('echappe les guillemets, les « ; » et neutralise les formules dans les noms', () => {
    const e = setup();
    profile(e, 'ali', '=HYPERLINK("http://x")');
    profile(e, 'bob', 'Dupont; "Jr"');
    const formula = route(e, '=1+1', [1]);
    const quoted = route(e, 'Cave; sous-sol "B"', [1]);
    const plus = route(e, '@SUM(A1)', [1]);
    run(e, formula, at(10, 22), at(10, 22, 30), 'done', 'ali');
    run(e, quoted, at(10, 23), at(10, 23, 30), 'done', 'bob');
    run(e, plus, at(10, 21), at(10, 21, 30), 'missed');
    const csv = e.report.csv(e.report.build(range('2026-06-10', '2026-06-10')));
    const lines = csv.slice(1).split('\r\n');
    assert.ok(lines.some((l) => l.startsWith("2026-06-10;'=1+1;\"'=HYPERLINK(\"\"http://x\"\")\";")), 'formule neutralisee dans le circuit et dans l agent');
    assert.ok(lines.some((l) => l.startsWith('2026-06-10;"Cave; sous-sol ""B""";"Dupont; ""Jr"""')), 'guillemets doubles');
    assert.ok(lines.some((l) => l.startsWith("2026-06-10;'@SUM(A1);")));
    assert.ok(!csv.split('\r\n').some((l) => /;=1\+1/.test(l)), 'aucune cellule ne commence par =');
  });

  it(`plafonne a ${MAX_CSV_ROWS} lignes`, () => {
    const e = bare();
    const base = createPatrolReport({ db: e.db }).build(range('2026-06-10', '2026-06-10'));
    const row = { day: '2026-06-10', routeId: 1, route: 'C', username: 'a', agent: 'A', planned: 1, done: 1, incomplete: 0, missed: 0, pending: 0, expectedPoints: 1, onTimePoints: 1, onTimeRate: 1, doneRate: 1 };
    const big: PatrolReport = { ...base, rows: Array.from({ length: MAX_CSV_ROWS + 10 }, () => row) };
    const lines = e.report.csv(big).split('\r\n');
    assert.equal(lines.length, 1 + MAX_CSV_ROWS + 1);
  });
});

// ------------------------------------------------------------------ section HTML

describe('section « Rondes » du rapport', () => {
  it('chiffres cles, tableaux par circuit et par agent, tout texte echappe, sans script ni style en ligne', () => {
    const e = setup();
    profile(e, 'ali', '<b>x</b>');
    profile(e, 'bob', '"><img src=x onerror=alert(1)>');
    const c = route(e, '<script>alert(1)</script>', [1, 2]);
    const id = run(e, c, at(10, 22), at(10, 22, 30), 'done', 'ali');
    scan(e, id, 1, { serverAt: at(10, 22, 1) });
    scan(e, id, 2, { serverAt: at(10, 22, 2) });
    run(e, c, at(11, 22), at(11, 22, 30), 'incomplete', 'bob');
    const html = e.report.sectionHtml(e.report.build(range('2026-06-10', '2026-06-11')));
    assert.match(html, /^<h2>Rondes<\/h2>/);
    assert.ok(!html.includes('<b>x</b>') && html.includes('&lt;b&gt;x&lt;/b&gt;'));
    assert.ok(!html.includes('<script') && html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('<img') && html.includes('&lt;img'));
    assert.ok(!/<style|style=|<script|onerror=\w*\(|javascript:/i.test(html.replace(/&lt;[^]*?&gt;/g, '')), 'ni script ni style en ligne');
    assert.equal((html.match(/<div class="stat">/g) ?? []).length, 5);
    assert.match(html, /class="stats"/);
    assert.equal((html.match(/<table>/g) ?? []).length, 2, 'un tableau par circuit, un par agent');
    assert.match(html, /Rondes prévues/);
    assert.match(html, /<div class="l">Faites<\/div>/);
    assert.match(html, /Points contrôlés à l’heure/);
    assert.match(html, /<div class="v">50 %<\/div>/, 'taux a l heure : 2 points sur 4 attendus');
    assert.match(html, /2 sur 4 points attendus/);
  });

  it('periode sans ronde : le message le dit, sans tableau', () => {
    const e = setup();
    route(e, 'Nuit', [1]);
    const html = e.report.sectionHtml(e.report.build(range('2026-06-10', '2026-06-10')));
    assert.match(html, /Aucune ronde prévue sur cette période/);
    assert.ok(!html.includes('<table>'));
    assert.match(html, /<div class="v">—<\/div>/, 'taux inconnu affiche en tiret');
  });
});

// ------------------------------------------------------------------ rapport e-mail

describe('section dans le rapport d incidents / e-mail', () => {
  const standalone = (e: Env, reports: ReturnType<typeof createReports>, r = range('2026-06-10', '2026-06-10')) => reports.standaloneReportHtml(r, [], e.clock.t, 'body{}');

  it('reportHtml contient « Rondes » quand un circuit existe, juste avant le pied du document ; pas sinon', () => {
    const e = setup();
    const reports = createReports(e.db);
    mountPatrolReport(express(), { reports, report: e.report, staff: ((_q, _s, n) => n()) as RequestHandler, audit: () => {}, actorOf: () => 'x' });
    assert.ok(!reports.reportHtml(range('2026-06-10', '2026-06-10'), [], e.clock.t).includes('<h2>Rondes</h2>'), 'aucun circuit, aucune ronde');
    route(e, 'Nuit', [1]);
    const html = reports.reportHtml(range('2026-06-10', '2026-06-10'), [], e.clock.t);
    assert.ok(html.includes('<h2>Rondes</h2>'));
    assert.ok(html.indexOf('<h2>Rondes</h2>') < html.indexOf('Document généré par le PSIM'), 'avant le pied');
    const alone = standalone(e, reports);
    assert.ok(alone.includes('<h2>Rondes</h2>'), 'le rapport autonome (piece jointe) l embarque aussi');
    assert.ok(!/<script/i.test(alone), 'le rapport autonome reste sans script');
    assert.ok(!alone.includes('<link'), 'et autonome');
  });

  it('un circuit archive seul n ajoute rien, sauf si des rondes tombent dans la periode', () => {
    const e = setup();
    const reports = createReports(e.db);
    mountPatrolReport(express(), { reports, report: e.report, staff: ((_q, _s, n) => n()) as RequestHandler, audit: () => {}, actorOf: () => 'x' });
    const old = route(e, 'Vieux', [1], { archived: true });
    assert.ok(!reports.reportHtml(range('2026-06-10', '2026-06-10'), [], e.clock.t).includes('<h2>Rondes</h2>'));
    run(e, old, at(10, 22), at(10, 22, 30), 'done', 'ali');
    assert.ok(reports.reportHtml(range('2026-06-10', '2026-06-10'), [], e.clock.t).includes('<h2>Rondes</h2>'), 'une ronde de la periode suffit');
    assert.ok(!reports.reportHtml(range('2026-06-20', '2026-06-20'), [], e.clock.t).includes('<h2>Rondes</h2>'), 'mais pas hors periode');
  });

  it('sans les tables des rondes : le rapport est inchange', () => {
    const e = bare();
    const reports = createReports(e.db);
    const before = reports.reportHtml(range('2026-06-10', '2026-06-10'), [], e.clock.t);
    mountPatrolReport(express(), { reports, report: e.report, staff: ((_q, _s, n) => n()) as RequestHandler, audit: () => {}, actorOf: () => 'x' });
    assert.equal(reports.reportHtml(range('2026-06-10', '2026-06-10'), [], e.clock.t), before);
  });

  it('un rapport filtre sur une autre categorie que « personnes » ne parle pas des rondes', () => {
    const e = setup();
    route(e, 'Nuit', [1]);
    const reports = createReports(e.db);
    mountPatrolReport(express(), { reports, report: e.report, staff: ((_q, _s, n) => n()) as RequestHandler, audit: () => {}, actorOf: () => 'x' });
    const fire = parseRange({ from: '2026-06-10', to: '2026-06-10', category: 'fire' });
    const people = parseRange({ from: '2026-06-10', to: '2026-06-10', category: 'people' });
    assert.ok(!reports.reportHtml(fire, [], e.clock.t).includes('<h2>Rondes</h2>'));
    assert.ok(reports.reportHtml(people, [], e.clock.t).includes('<h2>Rondes</h2>'));
  });

  it('crochet generique : une section qui renvoie null, vide ou qui leve n ajoute rien et ne casse JAMAIS le rapport', () => {
    const e = setup();
    const reports = createReports(e.db);
    const warn = mock.method(console, 'warn', () => {});
    const plain = reports.reportHtml(range('2026-06-10', '2026-06-10'), [], e.clock.t);
    reports.addSection(() => null);
    reports.addSection(() => '');
    reports.addSection(() => {
      throw new Error('boum');
    });
    reports.addSection(() => 42 as never);
    reports.addSection(() => Promise.reject(new Error('asynchrone')) as never);
    assert.equal(reports.reportHtml(range('2026-06-10', '2026-06-10'), [], e.clock.t), plain);
    reports.addSection(() => '<h2>Autre</h2>');
    const html = reports.reportHtml(range('2026-06-10', '2026-06-10'), [], e.clock.t);
    assert.ok(html.includes('<h2>Autre</h2>'), 'les sections suivantes sont rendues malgre l erreur d une precedente');
    assert.ok(html.indexOf('<h2>Autre</h2>') < html.indexOf('Document généré par le PSIM'));
    assert.ok(warn.mock.calls.length >= 1);
    assert.match(String(warn.mock.calls[0].arguments.join(' ')), /boum/);
  });

  it('addSection renvoie de quoi retirer la section ; la fiche d incident n est pas concernee', () => {
    const e = setup();
    const reports = createReports(e.db);
    const off = reports.addSection(() => '<h2>Temporaire</h2>');
    assert.ok(reports.reportHtml(range('2026-06-10', '2026-06-10'), [], e.clock.t).includes('Temporaire'));
    off();
    off();
    assert.ok(!reports.reportHtml(range('2026-06-10', '2026-06-10'), [], e.clock.t).includes('Temporaire'));
  });

  it('une section recoit la periode du rapport', () => {
    const e = setup();
    const reports = createReports(e.db);
    const seen: string[] = [];
    reports.addSection((r) => {
      seen.push(`${r.fromDay}/${r.toDay}`);
      return null;
    });
    reports.reportHtml(range('2026-06-08', '2026-06-10'), [], e.clock.t);
    assert.deepEqual(seen, ['2026-06-08/2026-06-10']);
  });
});

// ------------------------------------------------------------------ rondes reelles (horloge de passage)

describe('contre le vrai service des rondes', () => {
  it('une ronde faite en differe, puis une ronde rattrapee pendant le delai de grace', () => {
    const e = setup();
    const p1 = e.patrols.createCheckpoint('chef', { name: 'Parking', zone: 'Cour', x: 10, y: 10 });
    const p2 = e.patrols.createCheckpoint('chef', { name: 'Cave', zone: 'Cour', x: 20, y: 20 });
    e.clock.t = at(10, 21, 50);
    e.patrols.createRoute('chef', { name: 'Nuit', checkpoints: [p1.id, p2.id], maxMinutes: 30, graceMinutes: 10, schedule: [{ days: ALL, from: '22:00', to: '23:00' }] });
    const send = (code: string, phoneAt = e.clock.t) => e.patrols.scan('ali', 1, { clientId: `real-${++e.n}-${String(Math.random()).slice(2, 10)}`, code, method: 'qr', phoneAt });
    const tick = (t: number) => {
      e.clock.t = t;
      e.patrols.tick();
    };

    // Jour 1 : point 1 a 22 h 05, point 2 recu a 22 h 40 mais passe a 22 h 20 (telephone hors ligne) : a l'heure.
    tick(at(10, 22, 0));
    e.clock.t = at(10, 22, 5);
    assert.equal(send(p1.code as string).scan.verdict, 'ok');
    e.clock.t = at(10, 22, 40);
    const late = send(p2.code as string, at(10, 22, 20));
    assert.equal(late.scan.verdict, 'ok');
    assert.equal(late.scan.deferred, true);
    tick(at(10, 22, 41));

    // Jour 2 : point 1 a 22 h 05, echeance a 22 h 30 (incomplete), point 2 a 22 h 35 pendant la grace : ronde faite, mais pas a l'heure.
    tick(at(11, 22, 0));
    e.clock.t = at(11, 22, 5);
    assert.equal(send(p1.code as string).scan.verdict, 'ok');
    tick(at(11, 22, 30));
    e.clock.t = at(11, 22, 35);
    assert.equal(send(p2.code as string).scan.verdict, 'ok');
    tick(at(11, 22, 36));

    const statuses = (e.db.prepare('SELECT status FROM patrol_run ORDER BY due_start').all() as { status: string }[]).map((r) => r.status);
    assert.deepEqual(statuses, ['done', 'done']);
    const r = e.report.build(range('2026-06-10', '2026-06-11'));
    assert.deepEqual(r.byDay.map((d) => [d.day, d.done, d.expectedPoints, d.onTimePoints]), [
      ['2026-06-10', 1, 2, 2],
      ['2026-06-11', 1, 2, 1],
    ]);
    assert.equal(r.byAgent[0].username, 'ali');
  });
});

// ------------------------------------------------------------------ routes HTTP

interface Reply {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
  headers: Headers;
}

describe('routes HTTP du rapport de rondes', () => {
  let e: Env;
  let server: Server | null = null;
  let base = '';
  let audits: { actor: string; action: string; details?: string }[] = [];

  beforeEach(async () => {
    e = reference();
    audits = [];
    const app = express();
    const roleOf = (req: Request) => req.header('x-test-role') ?? '';
    const guard: RequestHandler = (req, res, next) => {
      const role = roleOf(req);
      if (!role) return void res.status(401).json({ error: 'Non authentifie' });
      if (role !== 'admin' && role !== 'operator') return void res.status(403).json({ error: 'Droits insuffisants' });
      next();
    };
    const reports = createReports(e.db);
    mountPatrolReport(app, {
      reports,
      report: e.report,
      staff: guard,
      audit: (actor, action, ref) => {
        audits.push({ actor, action, details: ref?.details });
        e.engine.audit(actor, action, ref);
      },
      actorOf: (req) => req.header('x-test-user') ?? 'chef',
      now: () => e.clock.t,
    });
    app.use('/api', (_req, res) => void res.status(404).json({ error: 'Route inconnue' }));
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof PsimError) return void res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Erreur interne' });
    });
    const listening = app.listen(0, '127.0.0.1');
    server = listening;
    await new Promise<void>((resolveListen) => listening.once('listening', () => resolveListen()));
    base = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    server = null;
  });

  async function get(path: string, role?: string, user?: string): Promise<Reply> {
    const headers: Record<string, string> = {};
    if (role) headers['x-test-role'] = role;
    if (user) headers['x-test-user'] = user;
    const res = await fetch(base + path, { headers });
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString('utf8'); // `toString` garde le BOM (contrairement a `res.text()`)
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* pas du JSON */
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  const Q = '?from=2026-06-08&to=2026-06-10';

  it('401 sans session, 403 pour un autre role (agent), 200 pour administrateur et operateur', async () => {
    for (const path of ['/api/patrols/report', '/api/patrols/report.csv']) {
      assert.equal((await get(path + Q)).status, 401, path);
      assert.equal((await get(path + Q, 'agent')).status, 403, path);
      assert.equal((await get(path + Q, 'admin')).status, 200, path);
      assert.equal((await get(path + Q, 'operator')).status, 200, path);
    }
    assert.equal(audits.length, 4, 'les refus n ecrivent rien dans l audit');
  });

  it('JSON : forme du rapport, Cache-Control: no-store', async () => {
    const r = await get(`/api/patrols/report${Q}`, 'operator', 'chef');
    assert.match(r.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(r.json).sort(), ['byAgent', 'byDay', 'byRoute', 'from', 'fromDay', 'generatedAt', 'rows', 'to', 'toDay', 'totals']);
    assert.equal(r.json.totals.planned, 8);
    assert.equal(r.json.totals.onTimeRate, 9 / 14);
    assert.equal(r.json.rows.length, 7);
    assert.equal(r.json.rows[2].username, null);
  });

  it('periode par defaut : les 30 derniers jours jusqu aujourd hui (horloge du serveur)', async () => {
    const r = await get('/api/patrols/report', 'admin');
    assert.equal(r.json.toDay, '2026-06-10');
    assert.equal(r.json.fromDay, '2026-05-12', '30 jours en comptant aujourd hui');
    assert.equal(r.json.totals.planned, 8);
  });

  it('periode invalide : 400 en francais, comme les autres rapports, et rien n est journalise', async () => {
    for (const q of ['?from=hier', '?from=2026-06-10&to=2026-06-01', '?from=2026-02-30', '?from=2024-01-01&to=2026-06-10', '?category=gaz']) {
      for (const path of ['/api/patrols/report', '/api/patrols/report.csv']) {
        const r = await get(path + q, 'admin');
        assert.equal(r.status, 400, `${path}${q}`);
        assert.equal(typeof r.json.error, 'string');
      }
    }
    assert.equal(audits.length, 0);
  });

  it('CSV : type, nom de fichier, no-store, BOM, plafond respecte', async () => {
    const r = await get(`/api/patrols/report.csv${Q}`, 'admin');
    assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="patrouilles_2026-06-08_2026-06-10.csv"');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.ok(r.text.startsWith('\uFEFFJour;Circuit;Agent;'));
    assert.equal(r.text.split('\r\n').length, 1 + 7 + 1);
  });

  it('chaque lecture est journalisee (patrol_history_read) avec l acteur et la periode', async () => {
    await get(`/api/patrols/report${Q}`, 'operator', 'chef-poste');
    await get(`/api/patrols/report.csv${Q}`, 'admin', 'direction');
    assert.deepEqual(audits, [
      { actor: 'chef-poste', action: 'patrol_history_read', details: 'rapport de rondes du 2026-06-08 au 2026-06-10' },
      { actor: 'direction', action: 'patrol_history_read', details: 'export CSV du rapport de rondes du 2026-06-08 au 2026-06-10' },
    ]);
    const inChain = e.engine.listAudit(50).filter((a) => a.action === 'patrol_history_read');
    assert.equal(inChain.length, 2, 'ecrit dans le vrai journal d audit (aucune liste blanche d actions)');
    assert.deepEqual(inChain.map((a) => a.actor).sort(), ['chef-poste', 'direction']);
  });

  it('aucune autre methode que GET', async () => {
    const res = await fetch(`${base}/api/patrols/report${Q}`, { method: 'POST', headers: { 'x-test-role': 'admin' } });
    assert.equal(res.status, 404);
  });
});

// ------------------------------------------------------------------ vrai serveur

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';
const PIN = '4821';
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });

describe('rapport de rondes contre le vrai serveur (processus reel)', { timeout: 120_000 }, () => {
  let proc: ChildProcess;
  let base = '';
  let output = '';
  const cookies = { admin: '', operator: '', agent: '' };

  async function call(method: string, path: string, body?: unknown, cookie?: string): Promise<{ status: number; body: any; text: string; headers: Headers; cookies: string[] }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* pas du JSON */
    }
    return { status: res.status, body: parsed, text, headers: res.headers, cookies: res.headers.getSetCookie().map((c) => c.split(';')[0]) };
  }

  before(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
    Object.assign(env, {
      PSIM_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'psim-prep-')), 'data'),
      PSIM_PORT: String(port),
      PSIM_MQTT_PORT: String(await freePort()),
      PSIM_ADMIN_PASSWORD: ADMIN_PW,
      PSIM_OPERATOR_PASSWORD: OPERATOR_PW,
      PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3',
      PSIM_DEMO_LOGIN: '0',
      PSIM_REQUIRE_2FA: 'none',
      PSIM_PUBLIC_URL: 'https://psim.exemple.test:3034',
    });
    proc = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout!.on('data', (d) => (output += d));
    proc.stderr!.on('data', (d) => (output += d));
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).status === 200) return;
      } catch {
        /* pas encore pret */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`serveur non demarre :\n${output}`);
  });
  after(() => proc?.kill());

  it('une ronde faite par un agent apparait dans le rapport, avec les droits et l audit attendus', async () => {
    cookies.admin = (await call('POST', '/api/login', { username: 'admin', password: ADMIN_PW })).cookies[0];
    cookies.operator = (await call('POST', '/api/login', { username: 'operateur', password: OPERATOR_PW })).cookies[0];
    assert.equal((await call('POST', '/api/agents', { username: 'kouassi', displayName: 'Kouassi <b>K</b>', pin: PIN, zones: [] }, cookies.admin)).status, 201, output);
    const phone = await call('POST', '/api/agent-phones', { label: 'Poste nord' }, cookies.admin);
    const paired = await call('POST', '/api/agent/pair', { code: String(phone.body.pairUrl).split('#pair=')[1] });
    const phoneCookie = paired.cookies[0];
    const login = await call('POST', '/api/agent/login', { username: 'kouassi', pin: PIN }, phoneCookie);
    cookies.agent = `${phoneCookie}; ${login.cookies.find((c) => c.startsWith('psim_session='))}`;
    assert.equal((await call('POST', '/api/agent/shift/start', {}, cookies.agent)).status, 200);

    const floorId = (await call('GET', '/api/state', undefined, cookies.admin)).body.floors[0].id as number;
    const point = await call('POST', '/api/patrols/checkpoints', { name: 'Portail', zone: 'Accueil', floorId, x: 20, y: 30 }, cookies.admin);
    const start = new Date(Date.now() + 3 * MIN);
    const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const created = await call(
      'POST',
      '/api/patrols/routes',
      { name: 'Tour <test>', checkpoints: [point.body.id], maxMinutes: 30, schedule: [{ days: ALL, from: hhmm(start), to: hhmm(new Date(start.getTime() + HOUR)) }] },
      cookies.admin,
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // Passage 3 min avant le debut (accepte jusqu'a 15 min avant) : la ronde est creee et terminee (un seul point).
    const scanned = await call('POST', '/api/agent/scans', { clientId: 'prep-scan-0001', code: point.body.code, method: 'qr', phoneAt: Date.now() }, cookies.agent);
    assert.equal(scanned.status, 200, JSON.stringify(scanned.body));
    assert.equal(scanned.body.scan.verdict, 'ok');

    const wide = `?from=${dayOf(-1)}&to=${dayOf(1)}`;
    for (const path of ['/api/patrols/report', '/api/patrols/report.csv']) {
      assert.equal((await call('GET', path + wide)).status, 401, `${path} sans session`);
      assert.equal((await call('GET', path + wide, undefined, cookies.agent.split('; ')[1])).status, 403, `${path} agent`);
    }
    const report = await call('GET', `/api/patrols/report${wide}`, undefined, cookies.operator);
    assert.equal(report.status, 200, output);
    assert.equal(report.headers.get('cache-control'), 'no-store');
    assert.equal(report.body.totals.planned, 1);
    assert.equal(report.body.totals.done, 1);
    assert.equal(report.body.totals.onTimeRate, 1);
    assert.deepEqual(report.body.byAgent.map((a: { username: string; name: string }) => [a.username, a.name]), [['kouassi', 'Kouassi <b>K</b>']], 'nom affiche du vrai profil');
    assert.equal(report.body.byRoute[0].name, 'Tour <test>');

    const csv = await call('GET', `/api/patrols/report.csv${wide}`, undefined, cookies.admin);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition') ?? '', /^attachment; filename="patrouilles_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"$/);
    assert.match(csv.text, /Kouassi <b>K<\/b>/);

    assert.equal((await call('GET', '/api/patrols/report?from=nimporte', undefined, cookies.admin)).status, 400);

    // Le rapport d'incidents embarque la section « Rondes ».
    const incidents = await call('GET', `/api/reports/incidents${wide}`, undefined, cookies.operator);
    assert.equal(incidents.status, 200);
    assert.match(incidents.text, /<h2>Rondes<\/h2>/);
    assert.ok(!incidents.text.includes('<b>K</b>'), 'noms echappes');

    const audit = await call('GET', '/api/audit?limit=200', undefined, cookies.admin);
    const reads = (audit.body as { actor: string; action: string; details: string | null }[]).filter((a) => a.action === 'patrol_history_read');
    assert.ok(reads.some((a) => a.actor === 'operateur' && /rapport de rondes du \d{4}-\d{2}-\d{2} au \d{4}-\d{2}-\d{2}/.test(a.details ?? '')), 'lecture de l operateur journalisee');
    assert.ok(reads.some((a) => a.actor === 'admin' && /export CSV/.test(a.details ?? '')));
  });
});

/** Jour local `AAAA-MM-JJ` decale de `n` jours par rapport a aujourd'hui. */
function dayOf(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
