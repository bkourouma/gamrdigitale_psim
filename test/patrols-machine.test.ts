import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { Window } from '../server/arming.ts';
import { createPatrolMachine, EARLY_SCAN_MS, windowStarts } from '../server/patrolmachine.ts';
import type { PatrolAction, PatrolMachine, PatrolScanResult, PatrolSpec, RunState } from '../server/patrolmachine.ts';

/**
 * Machine des rondes : fonction pure, l'horloge est fabriquee par le test. Toutes les dates sont construites en heure
 * LOCALE (`new Date(a, m, j, h, min)`), jamais en UTC en dur : les tests passent dans n'importe quel fuseau. Les dates
 * de reference sont en juin (aucun changement d'heure ce mois-la dans les fuseaux usuels) ; le changement d'heure est
 * teste dans un processus fils regle sur Europe/Paris.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const ALL = [0, 1, 2, 3, 4, 5, 6];
const local = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime();
const NIGHT: Window[] = [{ days: ALL, from: '22:00', to: '06:00' }];
/** Mercredi 10 juin 2026, 22:00 heure locale : debut de la ronde de reference. */
const S = local(2026, 6, 10, 22, 0);
const S2 = local(2026, 6, 11, 22, 0);

function spec(over: Partial<PatrolSpec> = {}): PatrolSpec {
  // Copie profonde : un test qui modifie la specification ne doit pas toucher les autres.
  return structuredClone({ routeId: 1, checkpoints: [11, 12, 13], ordered: false, maxMinutes: 30, graceMinutes: 10, schedule: NIGHT, agents: [], ...over });
}

const kinds = (actions: PatrolAction[]): string[] =>
  actions.map((a) => (a.kind === 'event' ? `event:${a.event}` : a.kind === 'status' ? `status:${a.status}` : 'create'));

function scan(m: PatrolMachine, now: number, checkpointId: number, o: { user?: string; at?: number; deferred?: boolean } = {}): PatrolScanResult {
  return m.scan(now, { checkpointId, username: o.user ?? 'ali', at: o.at ?? now, deferred: o.deferred ?? false });
}

/** Machine creee juste avant le debut de la ronde de reference, ronde S deja creee. */
function started(over: Partial<PatrolSpec> = {}): PatrolMachine {
  const m = createPatrolMachine(spec(over), S - MIN);
  assert.deepEqual(m.tick(S - MIN), []);
  assert.deepEqual(m.tick(S), [{ kind: 'create', dueStart: S, dueEnd: S + 30 * MIN }]);
  return m;
}

const run = (m: PatrolMachine, dueStart = S): RunState => {
  const found = m.runs().find((r) => r.dueStart === dueStart);
  assert.ok(found, `ronde ${new Date(dueStart).toString()}`);
  return found;
};

/** Ce que ferait le service : appliquer les actions et les scans `ok` a une « base ». */
function persist(db: Map<number, RunState>, actions: PatrolAction[], scanned?: { checkpointId: number; username: string; at: number; result: PatrolScanResult }): void {
  for (const a of actions) {
    if (a.kind === 'create') db.set(a.dueStart, { dueStart: a.dueStart, dueEnd: a.dueEnd, status: 'pending', startedBy: null, startedAt: null, finishedAt: null, done: [] });
    else if (a.kind === 'status') {
      const r = db.get(a.dueStart);
      assert.ok(r, 'status sur une ronde inconnue de la base');
      Object.assign(r, { status: a.status, startedBy: a.startedBy, startedAt: a.startedAt, finishedAt: a.finishedAt });
    }
  }
  if (scanned && scanned.result.verdict === 'ok') {
    const r = db.get(scanned.result.dueStart as number);
    assert.ok(r, 'scan ok sur une ronde inconnue de la base');
    r.done.push({ checkpointId: scanned.checkpointId, at: scanned.at, username: scanned.username });
  }
}

const dbRuns = (db: Map<number, RunState>): RunState[] => [...db.values()].sort((a, b) => a.dueStart - b.dueStart).map((r) => structuredClone(r));

// ---- windowStarts -------------------------------------------------------------------------------------------------

describe('windowStarts', () => {
  it('une plage quotidienne donne un debut par jour, en heure locale, trie', () => {
    const starts = windowStarts(NIGHT, local(2026, 6, 10), local(2026, 6, 13));
    assert.deepEqual(starts, [local(2026, 6, 10, 22), local(2026, 6, 11, 22), local(2026, 6, 12, 22)]);
  });

  it('bornes [from, to] incluses', () => {
    assert.deepEqual(windowStarts(NIGHT, S, S), [S]);
    assert.deepEqual(windowStarts(NIGHT, S + 1, S2 - 1), []);
    assert.deepEqual(windowStarts(NIGHT, S - 1, S2), [S, S2]);
  });

  it('plage a cheval sur minuit : elle commence le jour de `days` seulement', () => {
    const wed = new Date(S).getDay();
    const w: Window[] = [{ days: [wed], from: '22:00', to: '06:00' }];
    // La partie du matin (jeudi 00:00 - 06:00) n'est pas un debut.
    assert.deepEqual(windowStarts(w, local(2026, 6, 11, 0), local(2026, 6, 11, 6)), []);
    // Une semaine entiere : un seul debut, le mercredi soir.
    assert.deepEqual(windowStarts(w, local(2026, 6, 8), local(2026, 6, 15)), [S]);
  });

  it('plusieurs plages, jours multiples, sans doublon', () => {
    const mon = local(2026, 6, 8);
    const day = new Date(mon).getDay();
    const w: Window[] = [
      { days: [day, (day + 2) % 7], from: '08:00', to: '09:00' },
      { days: [day], from: '20:30', to: '21:00' },
      { days: [day], from: '08:00', to: '10:00' }, // meme debut que la premiere plage : une seule ronde
    ];
    assert.deepEqual(windowStarts(w, mon, local(2026, 6, 11)), [local(2026, 6, 8, 8), local(2026, 6, 8, 20, 30), local(2026, 6, 10, 8)]);
  });

  it('plages mal formees ignorees, intervalle vide ou invalide : rien', () => {
    const bad = [null, { days: [1], from: '25:00', to: '01:00' }, { days: [9, -1, 1.5], from: '08:00', to: '09:00' }, { days: 'x', from: '08:00' }, ...NIGHT] as unknown as Window[];
    assert.deepEqual(windowStarts(bad, S - HOUR, S + HOUR), [S]);
    assert.deepEqual(windowStarts(NIGHT, S2, S), []);
    assert.deepEqual(windowStarts(NIGHT, Number.NaN, S), []);
    assert.deepEqual(windowStarts(NIGHT, S, Number.POSITIVE_INFINITY), []);
    assert.deepEqual(windowStarts(null as unknown as Window[], S, S2), []);
    assert.deepEqual(windowStarts([], S, S2), []);
  });

  it('intervalle absurde (plus d\'un an) : erreur explicite plutot qu\'une boucle sans fin', () => {
    assert.throws(() => windowStarts(NIGHT, 0, 400 * 24 * HOUR), RangeError);
  });

  it('changement d\'heure (Europe/Paris) : ni plantage ni doublon, y compris dans la machine', () => {
    const url = pathToFileURL(join(import.meta.dirname, '..', 'server', 'patrolmachine.ts')).href;
    const code = `
      import { windowStarts, createPatrolMachine } from ${JSON.stringify(url)};
      const L = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
      const all = [0, 1, 2, 3, 4, 5, 6];
      const spring = windowStarts([{ days: all, from: '02:30', to: '04:00' }, { days: all, from: '03:30', to: '05:00' }], L(2026, 3, 28), L(2026, 3, 31));
      const fall = windowStarts([{ days: all, from: '02:30', to: '04:00' }], L(2026, 10, 24), L(2026, 10, 27));
      function creates(from, to) {
        const m = createPatrolMachine({ routeId: 1, checkpoints: [1], ordered: false, maxMinutes: 30, graceMinutes: 0,
          schedule: [{ days: all, from: '02:30', to: '03:00' }], agents: [] }, from, { catchUpMs: 0 });
        const out = [];
        for (let t = from; t <= to; t += 60000) for (const a of m.tick(t)) if (a.kind === 'create') out.push(a.dueStart);
        return out;
      }
      console.log(JSON.stringify({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, spring, fall,
        springRuns: creates(L(2026, 3, 28), L(2026, 3, 31)), fallRuns: creates(L(2026, 10, 24), L(2026, 10, 27)) }));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: 'Europe/Paris' }, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const r = JSON.parse(child.stdout) as { tz: string; spring: number[]; fall: number[]; springRuns: number[]; fallRuns: number[] };
    assert.equal(r.tz, 'Europe/Paris');
    // Printemps : le 29 mars, 02:30 n'existe pas (devient 03:30) et se confond avec la plage de 03:30 : une seule ronde.
    assert.deepEqual(r.spring, [
      Date.UTC(2026, 2, 28, 1, 30), Date.UTC(2026, 2, 28, 2, 30), // 28 mars : 02:30 et 03:30 CET
      Date.UTC(2026, 2, 29, 1, 30), // 29 mars : 03:30 CEST
      Date.UTC(2026, 2, 30, 0, 30), Date.UTC(2026, 2, 30, 1, 30), // 30 mars : 02:30 et 03:30 CEST
    ]);
    // Automne : le 25 octobre, 02:30 existe deux fois ; une seule ronde.
    assert.equal(r.fall.length, 3);
    assert.equal(new Set(r.fall).size, 3);
    assert.equal(r.fall[0], Date.UTC(2026, 9, 24, 0, 30));
    assert.equal(r.fall[2], Date.UTC(2026, 9, 26, 1, 30));
    // La machine, avec un tick par minute a travers les deux nuits, cree une ronde par nuit, jamais deux.
    assert.deepEqual(r.springRuns, [Date.UTC(2026, 2, 28, 1, 30), Date.UTC(2026, 2, 29, 1, 30), Date.UTC(2026, 2, 30, 0, 30)]);
    assert.deepEqual(r.fallRuns, r.fall);
  });
});

// ---- Creation des rondes ------------------------------------------------------------------------------------------

describe('machine des rondes : creation', () => {
  it('cree la ronde `pending` a l\'heure de debut, une seule fois', () => {
    const m = started();
    assert.deepEqual(m.tick(S + 1000), []);
    assert.deepEqual(m.tick(S + 5 * MIN), []);
    assert.deepEqual(m.runs(), [{ dueStart: S, dueEnd: S + 30 * MIN, status: 'pending', startedBy: null, startedAt: null, finishedAt: null, done: [] }]);
  });

  it('rattrapage par defaut (maxMinutes + graceMinutes) : la ronde en cours pendant un arret est creee', () => {
    const during = createPatrolMachine(spec(), S + 20 * MIN);
    assert.deepEqual(during.tick(S + 20 * MIN), [{ kind: 'create', dueStart: S, dueEnd: S + 30 * MIN }]);
    // Borne incluse : creee a S + 40 min, aussitot ratee (echeance et grace passees).
    const edge = createPatrolMachine(spec(), S + 40 * MIN);
    assert.deepEqual(kinds(edge.tick(S + 40 * MIN)), ['create', 'status:missed', 'event:patrol_missed']);
    // Au-dela : trop ancienne, jamais creee (pas d'alarme pour une ronde d'avant l'arret).
    const late = createPatrolMachine(spec(), S + 40 * MIN + 1);
    assert.deepEqual(late.tick(S + 40 * MIN + 1), []);
    assert.deepEqual(late.tick(S + 2 * HOUR), []);
    assert.deepEqual(late.runs(), []);
  });

  it('catchUpMs explicite : borne le rattrapage', () => {
    const m = createPatrolMachine(spec(), S + 2 * HOUR, { catchUpMs: 3 * HOUR });
    assert.deepEqual(kinds(m.tick(S + 2 * HOUR)), ['create', 'status:missed', 'event:patrol_missed']);
  });

  it('catchUpMs: 0 (circuit neuf) : rien du passe, la prochaine plage est creee a l\'heure', () => {
    const m = createPatrolMachine(spec(), S + MIN, { catchUpMs: 0 });
    assert.deepEqual(m.tick(S + MIN), []);
    assert.deepEqual(m.tick(S2 - MIN), []);
    assert.deepEqual(m.tick(S2), [{ kind: 'create', dueStart: S2, dueEnd: S2 + 30 * MIN }]);
    // Circuit cree pile a l'heure de debut : la ronde est creee.
    const exact = createPatrolMachine(spec(), S, { catchUpMs: 0 });
    assert.deepEqual(kinds(exact.tick(S)), ['create']);
  });

  it('idempotence apres `load` : un debut deja connu n\'est jamais recree', () => {
    const a = started();
    const b = createPatrolMachine(spec(), S + 5 * MIN);
    b.load(a.runs());
    b.load(a.runs()); // deux fois : toujours une seule ronde
    assert.deepEqual(b.tick(S + 5 * MIN), []);
    assert.equal(b.runs().length, 1);
  });

  it('saut d\'horloge de plusieurs jours en avant : au plus 24 h rattrapees, pas d\'avalanche', () => {
    const m = createPatrolMachine(spec(), S - MIN);
    m.tick(S - MIN);
    const now = local(2026, 6, 13, 23, 0);
    const out = m.tick(now);
    assert.deepEqual(kinds(out), ['create', 'status:missed', 'event:patrol_missed']);
    assert.equal(out[0].dueStart, local(2026, 6, 13, 22, 0));
    assert.deepEqual(m.tick(now + MIN), []);
  });

  it('un tick qui saute le debut (serveur bloque quelques minutes) cree quand meme la ronde', () => {
    const m = createPatrolMachine(spec(), S - MIN, { catchUpMs: 0 });
    m.tick(S - MIN);
    assert.deepEqual(kinds(m.tick(S + 3 * MIN)), ['create']);
  });

  it('horloge qui recule : ni recreation ni evenement repete, aucun retour en arriere d\'etat', () => {
    const m = started();
    assert.deepEqual(kinds(m.tick(S + 31 * MIN)), ['status:missed', 'event:patrol_missed']);
    assert.deepEqual(m.tick(S + 5 * MIN), []);
    assert.deepEqual(m.tick(S - HOUR), []);
    assert.deepEqual(m.tick(S + 31 * MIN), []);
    assert.equal(run(m).status, 'missed');
    assert.equal(m.runs().length, 1);
  });

  it('planning vide : aucune ronde', () => {
    const m = createPatrolMachine(spec({ schedule: [] }), S - HOUR);
    assert.deepEqual(m.tick(S), []);
    assert.deepEqual(scan(m, S, 11).verdict, 'no_run');
  });
});

// ---- Echeances ----------------------------------------------------------------------------------------------------

describe('machine des rondes : echeances', () => {
  it('rien scanne : `missed` + patrol_missed (tous les points), une seule fois', () => {
    const m = started();
    assert.deepEqual(m.tick(S + 30 * MIN - 1), []);
    assert.deepEqual(m.tick(S + 30 * MIN), [
      { kind: 'status', dueStart: S, status: 'missed', startedBy: null, startedAt: null, finishedAt: null },
      { kind: 'event', dueStart: S, event: 'patrol_missed', missed: [11, 12, 13] },
    ]);
    for (let t = S + 30 * MIN + 1000; t < S + 2 * HOUR; t += 1000) assert.deepEqual(m.tick(t), []);
  });

  it('points manquants : `incomplete` + patrol_incomplete, puis `missed` apres la grace', () => {
    const m = started();
    assert.deepEqual(scan(m, S + 5 * MIN, 11).actions, [{ kind: 'status', dueStart: S, status: 'active', startedBy: 'ali', startedAt: S + 5 * MIN, finishedAt: null }]);
    assert.deepEqual(m.tick(S + 30 * MIN), [
      { kind: 'status', dueStart: S, status: 'incomplete', startedBy: 'ali', startedAt: S + 5 * MIN, finishedAt: null },
      { kind: 'event', dueStart: S, event: 'patrol_incomplete', missed: [12, 13] },
    ]);
    for (let t = S + 30 * MIN + 1000; t < S + 40 * MIN; t += 1000) assert.deepEqual(m.tick(t), []);
    assert.deepEqual(m.tick(S + 40 * MIN), [
      { kind: 'status', dueStart: S, status: 'missed', startedBy: 'ali', startedAt: S + 5 * MIN, finishedAt: null },
      { kind: 'event', dueStart: S, event: 'patrol_missed', missed: [12, 13] },
    ]);
    assert.deepEqual(m.tick(S + 41 * MIN), []);
  });

  it('patrol_missed apres la grace ne liste que les points restants', () => {
    const m = started();
    scan(m, S + 5 * MIN, 11);
    m.tick(S + 30 * MIN);
    scan(m, S + 32 * MIN, 12); // pendant la grace
    const out = m.tick(S + 40 * MIN);
    assert.deepEqual(out[1], { kind: 'event', dueStart: S, event: 'patrol_missed', missed: [13] });
  });

  it('graceMinutes = 0 : `incomplete` puis `missed` au meme tick, dans cet ordre', () => {
    const m = started({ graceMinutes: 0 });
    scan(m, S + 5 * MIN, 12);
    const out = m.tick(S + 30 * MIN);
    assert.deepEqual(kinds(out), ['status:incomplete', 'event:patrol_incomplete', 'status:missed', 'event:patrol_missed']);
    assert.deepEqual(out.filter((a) => a.kind === 'event').map((a) => (a as { missed: number[] }).missed), [[11, 13], [11, 13]]);
    assert.deepEqual(m.tick(S + 31 * MIN), []);
    // Aucune grace : un scan juste apres l'echeance ne compte plus.
    assert.equal(scan(m, S + 30 * MIN + 1, 11).verdict, 'no_run');
  });

  it('plusieurs rondes en retard au meme tick : traitees dans l\'ordre chronologique', () => {
    const S10 = local(2026, 6, 10, 22, 10);
    const m = createPatrolMachine(spec({ schedule: [{ days: ALL, from: '22:10', to: '23:00' }, ...NIGHT] }), S - MIN);
    m.tick(S - MIN);
    const out = m.tick(S + 50 * MIN);
    assert.deepEqual(kinds(out), ['create', 'create', 'status:missed', 'event:patrol_missed', 'status:missed', 'event:patrol_missed']);
    assert.deepEqual(out.map((a) => a.dueStart), [S, S10, S, S, S10, S10]);
  });

  it('redemarrage : une ronde chargee `incomplete` ne redonne pas son evenement, la grace continue', () => {
    const m = createPatrolMachine(spec(), S + 32 * MIN);
    m.load([{ dueStart: S, dueEnd: S + 30 * MIN, status: 'incomplete', startedBy: 'ali', startedAt: S + 5 * MIN, finishedAt: null, done: [{ checkpointId: 11, at: S + 5 * MIN, username: 'ali' }] }]);
    assert.deepEqual(m.tick(S + 32 * MIN), []);
    assert.deepEqual(m.tick(S + 39 * MIN), []);
    assert.deepEqual(kinds(m.tick(S + 40 * MIN)), ['status:missed', 'event:patrol_missed']);
  });

  it('redemarrage : grace depassee pendant l\'arret -> `missed` au premier tick, sans patrol_incomplete', () => {
    const m = createPatrolMachine(spec(), S + 2 * HOUR);
    m.load([{ dueStart: S, dueEnd: S + 30 * MIN, status: 'incomplete', startedBy: 'ali', startedAt: S + 5 * MIN, finishedAt: null, done: [{ checkpointId: 11, at: S + 5 * MIN, username: 'ali' }] }]);
    assert.deepEqual(m.tick(S + 2 * HOUR), [
      { kind: 'status', dueStart: S, status: 'missed', startedBy: 'ali', startedAt: S + 5 * MIN, finishedAt: null },
      { kind: 'event', dueStart: S, event: 'patrol_missed', missed: [12, 13] },
    ]);
    assert.deepEqual(m.tick(S + 2 * HOUR + 1000), []);
  });

  it('redemarrage : rondes `missed` et `done` chargees : silence ; `pending` / `active` echues : evaluees', () => {
    const base = { startedBy: null, startedAt: null, finishedAt: null, done: [] };
    const m = createPatrolMachine(spec({ schedule: [] }), S + 3 * HOUR);
    m.load([
      { ...base, dueStart: S - 3 * HOUR, dueEnd: S - 150 * MIN, status: 'missed' },
      { ...base, dueStart: S - 2 * HOUR, dueEnd: S - 90 * MIN, status: 'done', startedBy: 'ali', startedAt: S - 2 * HOUR, finishedAt: S - 100 * MIN, done: [11, 12, 13].map((c) => ({ checkpointId: c, at: S - 2 * HOUR, username: 'ali' })) },
      { ...base, dueStart: S, dueEnd: S + 30 * MIN, status: 'pending' },
      { ...base, dueStart: S + HOUR, dueEnd: S + 90 * MIN, status: 'active', startedBy: 'ali', startedAt: S + HOUR, done: [{ checkpointId: 13, at: S + HOUR, username: 'ali' }] },
    ]);
    const out = m.tick(S + 3 * HOUR);
    assert.deepEqual(kinds(out), ['status:missed', 'event:patrol_missed', 'status:incomplete', 'event:patrol_incomplete', 'status:missed', 'event:patrol_missed']);
    assert.deepEqual(out.map((a) => a.dueStart), [S, S, S + HOUR, S + HOUR, S + HOUR, S + HOUR]);
    assert.deepEqual(m.tick(S + 3 * HOUR + 1000), []);
  });
});

// ---- Scans --------------------------------------------------------------------------------------------------------

describe('machine des rondes : scans', () => {
  it('fenetre : jusqu\'a 15 min avant le debut (la ronde est creee par le scan), pas une milliseconde de plus', () => {
    const m = createPatrolMachine(spec(), S - 20 * MIN);
    assert.deepEqual(m.tick(S - 20 * MIN), []);
    assert.equal(EARLY_SCAN_MS, 15 * MIN);
    assert.deepEqual(scan(m, S - 15 * MIN - 1, 11), { verdict: 'no_run', dueStart: null, actions: [] });
    assert.deepEqual(m.runs(), []);
    const r = scan(m, S - 15 * MIN, 11);
    assert.deepEqual(r, {
      verdict: 'ok',
      dueStart: S,
      actions: [
        { kind: 'create', dueStart: S, dueEnd: S + 30 * MIN },
        { kind: 'status', dueStart: S, status: 'active', startedBy: 'ali', startedAt: S - 15 * MIN, finishedAt: null },
      ],
    });
    // Le tick qui atteint le debut ne la recree pas.
    assert.deepEqual(m.tick(S - 10 * MIN), []);
    assert.deepEqual(m.tick(S), []);
    assert.equal(m.runs().length, 1);
    assert.equal(run(m).status, 'active');
  });

  it('scan anticipe refuse sur une ronde pas encore creee : verdict sans ronde, rien de cree', () => {
    const m = createPatrolMachine(spec({ ordered: true }), S - 20 * MIN);
    m.tick(S - 20 * MIN);
    assert.deepEqual(scan(m, S - 10 * MIN, 12), { verdict: 'out_of_order', dueStart: null, actions: [] });
    assert.deepEqual(scan(m, S - 10 * MIN, 99), { verdict: 'out_of_route', dueStart: null, actions: [] });
    assert.deepEqual(m.runs(), []);
    assert.deepEqual(kinds(m.tick(S)), ['create']);
  });

  it('fenetre : `dueEnd` inclus (meme avant le tick de l\'echeance), au-dela sans scan prealable : no_run', () => {
    const a = started();
    assert.equal(scan(a, S + 30 * MIN, 11).verdict, 'ok');
    assert.deepEqual(a.tick(S + 30 * MIN)[1], { kind: 'event', dueStart: S, event: 'patrol_incomplete', missed: [12, 13] });
    const b = started();
    assert.deepEqual(scan(b, S + 30 * MIN + 1, 11), { verdict: 'no_run', dueStart: null, actions: [] });
    assert.equal(run(b).status, 'pending');
  });

  it('ronde complete : `done` avec finishedAt, sans evenement si elle n\'etait pas en alerte', () => {
    const m = started();
    scan(m, S + 2 * MIN, 12, { user: 'moussa' });
    assert.deepEqual(scan(m, S + 3 * MIN, 11).actions, []);
    assert.deepEqual(scan(m, S + 4 * MIN, 13), {
      verdict: 'ok',
      dueStart: S,
      actions: [{ kind: 'status', dueStart: S, status: 'done', startedBy: 'moussa', startedAt: S + 2 * MIN, finishedAt: S + 4 * MIN }],
    });
    assert.deepEqual(run(m).done, [
      { checkpointId: 12, at: S + 2 * MIN, username: 'moussa' },
      { checkpointId: 11, at: S + 3 * MIN, username: 'ali' },
      { checkpointId: 13, at: S + 4 * MIN, username: 'ali' },
    ]);
    assert.deepEqual(m.tick(S + HOUR), []);
    // Une ronde terminee n'est plus candidate.
    assert.equal(scan(m, S + 5 * MIN, 11).verdict, 'no_run');
  });

  it('circuit d\'un seul point : create, puis directement `done`', () => {
    const m = createPatrolMachine(spec({ checkpoints: [11] }), S - 10 * MIN);
    m.tick(S - 10 * MIN);
    assert.deepEqual(kinds(scan(m, S - 5 * MIN, 11).actions), ['create', 'status:done']);
  });

  it('grace d\'une ronde `incomplete` : scan non differe accepte ; la completer donne `clear`', () => {
    const m = started();
    scan(m, S + 5 * MIN, 11);
    m.tick(S + 30 * MIN);
    assert.deepEqual(scan(m, S + 35 * MIN, 12), { verdict: 'ok', dueStart: S, actions: [] });
    assert.deepEqual(scan(m, S + 38 * MIN, 13).actions, [
      { kind: 'status', dueStart: S, status: 'done', startedBy: 'ali', startedAt: S + 5 * MIN, finishedAt: S + 38 * MIN },
      { kind: 'event', dueStart: S, event: 'clear', missed: [] },
    ]);
    assert.deepEqual(m.tick(S + 40 * MIN), []);
    assert.deepEqual(m.release(S + HOUR), []); // l'alerte a ete levee : rien a lever
  });

  it('grace : echeance pas encore traitee par le tick, le scan est accepte quand meme', () => {
    const m = started();
    scan(m, S + 5 * MIN, 11);
    assert.deepEqual(scan(m, S + 32 * MIN, 12), { verdict: 'ok', dueStart: S, actions: [] });
    assert.deepEqual(m.tick(S + 33 * MIN)[1], { kind: 'event', dueStart: S, event: 'patrol_incomplete', missed: [13] });
  });

  it('grace depassee : no_run (avant comme apres le tick), etat inchange', () => {
    const m = started();
    scan(m, S + 5 * MIN, 11);
    m.tick(S + 30 * MIN);
    const before = m.runs();
    assert.deepEqual(scan(m, S + 40 * MIN, 12), { verdict: 'no_run', dueStart: null, actions: [] });
    assert.deepEqual(m.runs(), before);
    m.tick(S + 40 * MIN);
    assert.equal(scan(m, S + 41 * MIN, 12).verdict, 'no_run');
  });

  it('rattrapage differe d\'une ronde `missed` : points gardes, reste `missed` tant qu\'elle n\'est pas complete, puis `clear`', () => {
    const m = started();
    m.tick(S + 30 * MIN);
    assert.equal(run(m).status, 'missed');
    // Un scan NON differe ne rattrape jamais une ronde ratee.
    assert.equal(scan(m, S + 45 * MIN, 11).verdict, 'no_run');
    assert.deepEqual(scan(m, S + 45 * MIN, 11, { at: S + 10 * MIN, deferred: true }).actions, [
      { kind: 'status', dueStart: S, status: 'missed', startedBy: 'ali', startedAt: S + 10 * MIN, finishedAt: null },
    ]);
    assert.deepEqual(scan(m, S + 45 * MIN, 12, { at: S + 12 * MIN, deferred: true }).actions, []);
    assert.equal(run(m).status, 'missed');
    assert.deepEqual(m.tick(S + 50 * MIN), []);
    assert.deepEqual(scan(m, S + 46 * MIN, 13, { at: S + 20 * MIN, deferred: true }).actions, [
      { kind: 'status', dueStart: S, status: 'done', startedBy: 'ali', startedAt: S + 10 * MIN, finishedAt: S + 20 * MIN },
      { kind: 'event', dueStart: S, event: 'clear', missed: [] },
    ]);
  });

  it('scan differe : heure effective hors fenetre -> no_run ; fait pendant la grace -> accepte', () => {
    const a = started();
    a.tick(S + 30 * MIN); // missed, aucun point
    assert.equal(scan(a, S + HOUR, 11, { at: S + 31 * MIN, deferred: true }).verdict, 'no_run');
    assert.equal(scan(a, S + HOUR, 11, { at: S - 16 * MIN, deferred: true }).verdict, 'no_run');
    const b = started();
    scan(b, S + 5 * MIN, 11);
    b.tick(S + 30 * MIN);
    b.tick(S + 40 * MIN); // missed apres la grace
    // Fait a S + 35 min (pendant la grace), recu a S + 50 min : compte.
    assert.equal(scan(b, S + 50 * MIN, 12, { at: S + 35 * MIN, deferred: true }).verdict, 'ok');
    // Fait apres la grace : ne compte pas.
    assert.equal(scan(b, S + 50 * MIN, 13, { at: S + 40 * MIN, deferred: true }).verdict, 'no_run');
  });

  it('scan differe plus ancien que le premier scan : corrige startedAt / startedBy, finishedAt = scan le plus tardif', () => {
    const m = started();
    scan(m, S + 10 * MIN, 12, { user: 'moussa' });
    assert.deepEqual(scan(m, S + 13 * MIN, 11, { at: S + 8 * MIN, deferred: true }).actions, [
      { kind: 'status', dueStart: S, status: 'active', startedBy: 'ali', startedAt: S + 8 * MIN, finishedAt: null },
    ]);
    const done = scan(m, S + 20 * MIN, 13, { at: S + 9 * MIN, deferred: true });
    assert.deepEqual(done.actions, [{ kind: 'status', dueStart: S, status: 'done', startedBy: 'ali', startedAt: S + 8 * MIN, finishedAt: S + 10 * MIN }]);
  });

  it('agent non autorise : comme si le circuit n\'existait pas', () => {
    const m = started({ agents: ['ali'] });
    assert.deepEqual(scan(m, S + MIN, 11, { user: 'moussa' }), { verdict: 'no_run', dueStart: null, actions: [] });
    assert.deepEqual(scan(m, S + MIN, 99, { user: 'moussa' }), { verdict: 'no_run', dueStart: null, actions: [] });
    assert.equal(run(m).status, 'pending');
    assert.equal(scan(m, S + MIN, 11, { user: 'ali' }).verdict, 'ok');
  });

  it('circuit ordonne : out_of_order ne compte pas, duplicate, out_of_route', () => {
    const m = started({ ordered: true });
    const snapshot = m.runs();
    assert.deepEqual(scan(m, S + MIN, 12), { verdict: 'out_of_order', dueStart: S, actions: [] });
    assert.deepEqual(m.runs(), snapshot); // toujours `pending`, rien de compte
    assert.equal(scan(m, S + 2 * MIN, 11).verdict, 'ok');
    assert.deepEqual(scan(m, S + 3 * MIN, 11), { verdict: 'duplicate', dueStart: S, actions: [] });
    assert.deepEqual(scan(m, S + 4 * MIN, 13), { verdict: 'out_of_order', dueStart: S, actions: [] });
    assert.deepEqual(scan(m, S + 5 * MIN, 99), { verdict: 'out_of_route', dueStart: S, actions: [] });
    assert.equal(scan(m, S + 6 * MIN, 12).verdict, 'ok');
    assert.equal(scan(m, S + 7 * MIN, 13).actions[0].kind, 'status');
    assert.equal(run(m).status, 'done');
    assert.deepEqual(run(m).done.map((d) => d.checkpointId), [11, 12, 13]);
  });

  it('circuit non ordonne : n\'importe quel ordre, duplicate sur un point deja fait', () => {
    const m = started();
    assert.equal(scan(m, S + MIN, 13).verdict, 'ok');
    assert.equal(scan(m, S + 2 * MIN, 13).verdict, 'duplicate');
    assert.equal(scan(m, S + 3 * MIN, 11).verdict, 'ok');
  });

  it('point hors circuit (out_of_route) contre aucune ronde (no_run)', () => {
    const m = started();
    assert.deepEqual(scan(m, S + MIN, 99), { verdict: 'out_of_route', dueStart: S, actions: [] });
    assert.deepEqual(scan(m, S - HOUR, 99), { verdict: 'no_run', dueStart: null, actions: [] });
    assert.deepEqual(scan(m, S - HOUR, 11), { verdict: 'no_run', dueStart: null, actions: [] });
  });

  it('rondes qui se chevauchent : la plus ancienne, sauf si le point y est deja fait et compte pour la suivante', () => {
    const S20 = local(2026, 6, 10, 22, 20);
    const m = createPatrolMachine(spec({ schedule: [...NIGHT, { days: ALL, from: '22:20', to: '23:00' }] }), S - MIN);
    m.tick(S - MIN);
    m.tick(S);
    m.tick(S20);
    assert.equal(m.runs().length, 2);
    assert.deepEqual(scan(m, S + 21 * MIN, 11).dueStart, S);
    const second = scan(m, S + 22 * MIN, 11);
    assert.equal(second.verdict, 'ok');
    assert.equal(second.dueStart, S20);
    assert.deepEqual(scan(m, S + 23 * MIN, 11), { verdict: 'duplicate', dueStart: S, actions: [] });
    assert.deepEqual(scan(m, S + 23 * MIN, 99), { verdict: 'out_of_route', dueStart: S, actions: [] });
  });

  it('`clear` retenu tant qu\'une autre ronde du circuit est `incomplete`, emis a la derniere', () => {
    const S20 = local(2026, 6, 10, 22, 20);
    const m = createPatrolMachine(spec({ schedule: [...NIGHT, { days: ALL, from: '22:20', to: '23:00' }] }), S - MIN);
    m.tick(S - MIN);
    m.tick(S);
    assert.equal(scan(m, S + MIN, 11).dueStart, S);
    m.tick(S20);
    assert.equal(scan(m, S + 21 * MIN, 11).dueStart, S20);
    assert.deepEqual(kinds(m.tick(S + 30 * MIN)), ['status:incomplete', 'event:patrol_incomplete']);
    assert.deepEqual(kinds(m.tick(S + 40 * MIN)), ['status:missed', 'event:patrol_missed']);
    assert.deepEqual(kinds(m.tick(S + 50 * MIN)), ['status:incomplete', 'event:patrol_incomplete']);
    // Rattrapage differe de la premiere ronde : terminee, mais la seconde est encore en pre-alarme : pas de `clear`.
    assert.equal(scan(m, S + 51 * MIN, 12, { at: S + 25 * MIN, deferred: true }).dueStart, S);
    assert.deepEqual(kinds(scan(m, S + 51 * MIN, 13, { at: S + 26 * MIN, deferred: true }).actions), ['status:done']);
    // La seconde est completee pendant sa grace : `clear`.
    assert.equal(scan(m, S + 52 * MIN, 12).dueStart, S20);
    const last = scan(m, S + 53 * MIN, 13);
    assert.deepEqual(last.actions[1], { kind: 'event', dueStart: S20, event: 'clear', missed: [] });
    assert.deepEqual(m.release(S + HOUR), []);
  });

  it('un scan refuse ne modifie jamais l\'etat', () => {
    const m = started({ ordered: true, agents: ['ali', 'moussa'] });
    scan(m, S + MIN, 11);
    const before = m.runs();
    const refused: PatrolScanResult[] = [
      scan(m, S + 2 * MIN, 13),
      scan(m, S + 2 * MIN, 11),
      scan(m, S + 2 * MIN, 99),
      scan(m, S + 2 * MIN, 12, { user: 'intrus' }),
      scan(m, S + 2 * MIN, 12, { at: S - HOUR, deferred: true }),
      scan(m, S + 2 * MIN, 12, { at: Number.NaN }),
    ];
    assert.deepEqual(refused.map((r) => r.verdict), ['out_of_order', 'duplicate', 'out_of_route', 'no_run', 'no_run', 'no_run']);
    for (const r of refused) assert.deepEqual(r.actions, []);
    assert.deepEqual(m.runs(), before);
  });

  it('donnees hostiles : aucune exception, aucun effet', () => {
    const m = started();
    const before = m.runs();
    assert.equal(m.scan(S + MIN, null as unknown as never).verdict, 'no_run');
    assert.equal(m.scan(S + MIN, { checkpointId: 11, username: 42 as unknown as string, at: S + MIN, deferred: false }).verdict, 'no_run');
    assert.equal(m.scan(S + MIN, { checkpointId: '11' as unknown as number, username: 'ali', at: S + MIN, deferred: false }).verdict, 'out_of_route');
    assert.equal(m.scan(Number.NaN, { checkpointId: 11, username: 'ali', at: S + MIN, deferred: false }).verdict, 'no_run');
    assert.deepEqual(m.tick(Number.NaN), []);
    assert.deepEqual(m.runs(), before);
  });

  it('`load` ignore les entrees invalides et ecarte les scans hors circuit ou en double', () => {
    const m = createPatrolMachine(spec(), S + 5 * MIN);
    m.load([
      null,
      5,
      { dueStart: 'x' },
      { dueStart: S - HOUR, dueEnd: S - 2 * HOUR, status: 'pending', done: [] },
      { dueStart: S - HOUR, dueEnd: S, status: 'bogus', done: [] },
      {
        dueStart: S, dueEnd: S + 30 * MIN, status: 'active', startedBy: 7, startedAt: 'hier', finishedAt: null,
        done: [null, { checkpointId: 99, at: S, username: 'ali' }, { checkpointId: 11, at: S + MIN, username: 'ali' }, { checkpointId: 11, at: S + 2 * MIN, username: 'ali' }, { checkpointId: 12, at: Number.NaN, username: 'ali' }],
      },
    ] as unknown as RunState[]);
    m.load('pas une liste' as unknown as RunState[]);
    assert.deepEqual(m.runs(), [{ dueStart: S, dueEnd: S + 30 * MIN, status: 'active', startedBy: null, startedAt: null, finishedAt: null, done: [{ checkpointId: 11, at: S + MIN, username: 'ali' }] }]);
  });

  it('`load` d\'une ronde dont tous les points du circuit (raccourci) sont faits : terminee au tick suivant', () => {
    const m = createPatrolMachine(spec({ checkpoints: [11] }), S + 5 * MIN);
    m.load([{ dueStart: S, dueEnd: S + 30 * MIN, status: 'active', startedBy: 'ali', startedAt: S + MIN, finishedAt: null, done: [{ checkpointId: 11, at: S + MIN, username: 'ali' }, { checkpointId: 12, at: S + 2 * MIN, username: 'ali' }] }]);
    assert.deepEqual(m.tick(S + 5 * MIN), [{ kind: 'status', dueStart: S, status: 'done', startedBy: 'ali', startedAt: S + MIN, finishedAt: S + MIN }]);
  });
});

// ---- Isolation, release, specification -----------------------------------------------------------------------------

describe('machine des rondes : isolation et fin de vie', () => {
  it('runs(), actions, spec et load sont des copies : le service ne peut pas corrompre la machine', () => {
    const s = spec();
    const m = createPatrolMachine(s, S - MIN);
    s.checkpoints.push(99);
    s.agents.push('ali');
    s.schedule[0].days.length = 0;
    m.tick(S);
    assert.equal(scan(m, S + MIN, 99).verdict, 'out_of_route');
    assert.equal(scan(m, S + MIN, 11, { user: 'moussa' }).verdict, 'ok');
    const copy = m.runs();
    copy[0].status = 'done';
    copy[0].done.push({ checkpointId: 12, at: 0, username: 'x' });
    copy[0].done[0].checkpointId = 13;
    assert.equal(run(m).status, 'active');
    assert.deepEqual(run(m).done, [{ checkpointId: 11, at: S + MIN, username: 'moussa' }]);
    const out = m.tick(S + 30 * MIN);
    const ev = out[1] as { missed: number[] };
    ev.missed.push(11);
    assert.deepEqual(m.tick(S + 40 * MIN)[1], { kind: 'event', dueStart: S, event: 'patrol_missed', missed: [12, 13] });
    const input: RunState[] = [{ dueStart: S2, dueEnd: S2 + 30 * MIN, status: 'pending', startedBy: null, startedAt: null, finishedAt: null, done: [] }];
    m.load(input);
    input[0].status = 'done';
    input[0].done.push({ checkpointId: 11, at: S2, username: 'x' });
    assert.equal(run(m, S2).status, 'pending');
    assert.deepEqual(run(m, S2).done, []);
  });

  it('release : `clear` si une alerte n\'est pas resolue, une seule fois ; ensuite machine inerte', () => {
    const m = started();
    m.tick(S + 30 * MIN);
    assert.deepEqual(m.release(S + 31 * MIN), [{ kind: 'event', dueStart: S, event: 'clear', missed: [] }]);
    assert.deepEqual(m.release(S + 32 * MIN), []);
    assert.deepEqual(m.tick(S2), []);
    assert.deepEqual(scan(m, S2 + MIN, 11), { verdict: 'no_run', dueStart: null, actions: [] });
    assert.deepEqual(scan(m, S + 33 * MIN, 11, { at: S + 5 * MIN, deferred: true }).verdict, 'no_run');
  });

  it('release sans alerte (ou alerte deja levee par `clear`) : rien', () => {
    const quiet = started();
    assert.deepEqual(quiet.release(S + MIN), []);
    const busy = started();
    scan(busy, S + MIN, 11);
    assert.deepEqual(busy.release(S + 2 * MIN), []);
  });

  it('release apres redemarrage : une ronde chargee `incomplete` compte comme alerte levee', () => {
    const m = createPatrolMachine(spec(), S + 32 * MIN);
    m.load([{ dueStart: S, dueEnd: S + 30 * MIN, status: 'incomplete', startedBy: 'ali', startedAt: S + MIN, finishedAt: null, done: [{ checkpointId: 11, at: S + MIN, username: 'ali' }] }]);
    assert.deepEqual(m.release(S + 33 * MIN), [{ kind: 'event', dueStart: S, event: 'clear', missed: [] }]);
  });

  it('specification invalide : RangeError a la creation', () => {
    assert.throws(() => createPatrolMachine(spec({ checkpoints: [] }), S), RangeError);
    assert.throws(() => createPatrolMachine(spec({ checkpoints: [1.5] }), S), RangeError);
    assert.throws(() => createPatrolMachine(spec({ maxMinutes: 0 }), S), RangeError);
    assert.throws(() => createPatrolMachine(spec({ maxMinutes: Number.NaN }), S), RangeError);
    assert.throws(() => createPatrolMachine(spec({ graceMinutes: -1 }), S), RangeError);
    assert.throws(() => createPatrolMachine(spec({ schedule: null as unknown as Window[] }), S), RangeError);
    assert.throws(() => createPatrolMachine(spec({ agents: [1] as unknown as string[] }), S), RangeError);
    assert.throws(() => createPatrolMachine(null as unknown as PatrolSpec, S), RangeError);
    assert.throws(() => createPatrolMachine(spec(), Number.NaN), RangeError);
  });

  it('memoire bornee : les rondes closes depuis plus de 48 h sont oubliees, jamais recreees', () => {
    const m = createPatrolMachine(spec({ checkpoints: [11] }), S - MIN, { catchUpMs: 0 });
    m.tick(S - MIN);
    m.tick(S);
    scan(m, S + MIN, 11); // done
    const S3 = local(2026, 6, 12, 22, 0);
    for (let t = S + HOUR; t <= S3 + 40 * MIN; t += 10 * MIN) m.tick(t); // S2 ratee, S3 ratee
    assert.deepEqual(m.runs().map((r) => [r.dueStart, r.status]), [[S, 'done'], [S2, 'missed'], [S3, 'missed']]);
    const limit = S + 40 * MIN + 2 * 24 * HOUR; // dueEnd + grace + 48 h de la ronde S
    m.tick(limit);
    assert.equal(m.runs().length, 3);
    assert.deepEqual(m.tick(limit + 1), []);
    assert.deepEqual(m.runs().map((r) => r.dueStart), [S2, S3]);
    // Rechargee depuis la base (redemarrage) : oubliee de nouveau au premier tick, sans evenement.
    m.load([{ dueStart: S, dueEnd: S + 30 * MIN, status: 'done', startedBy: 'ali', startedAt: S + MIN, finishedAt: S + MIN, done: [{ checkpointId: 11, at: S + MIN, username: 'ali' }] }]);
    assert.deepEqual(m.tick(limit + 2), []);
    assert.deepEqual(m.runs().map((r) => r.dueStart), [S2, S3]);
  });

  it('point en double dans le circuit : compte une seule fois', () => {
    const m = started({ checkpoints: [11, 12, 11] });
    scan(m, S + MIN, 11);
    assert.deepEqual(scan(m, S + 2 * MIN, 12).actions.map((a) => (a.kind === 'status' ? a.status : a.kind)), ['done']);
  });
});

// ---- Determinisme et rejeu ----------------------------------------------------------------------------------------

describe('machine des rondes : determinisme', () => {
  type Call =
    | { t: 'tick'; now: number }
    | { t: 'scan'; now: number; checkpointId: number; username: string; at: number; deferred: boolean }
    | { t: 'release'; now: number };

  /** Deux nuits : une ronde completee pendant la grace, une ronde ratee puis rattrapee en partie en differe. */
  function script(): Call[] {
    const calls: Call[] = [];
    const scans: Call[] = [
      { t: 'scan', now: S - 10 * MIN + 30_000, checkpointId: 11, username: 'ali', at: S - 10 * MIN + 30_000, deferred: false },
      { t: 'scan', now: S + 3 * MIN + 30_000, checkpointId: 99, username: 'moussa', at: S + 3 * MIN + 30_000, deferred: false },
      { t: 'scan', now: S + 4 * MIN + 30_000, checkpointId: 11, username: 'moussa', at: S + 4 * MIN + 30_000, deferred: false },
      { t: 'scan', now: S + 6 * MIN + 30_000, checkpointId: 13, username: 'ali', at: S + 6 * MIN + 30_000, deferred: false },
      { t: 'scan', now: S + 33 * MIN + 30_000, checkpointId: 12, username: 'moussa', at: S + 33 * MIN + 30_000, deferred: false },
      { t: 'scan', now: S2 + 50 * MIN + 30_000, checkpointId: 12, username: 'ali', at: S2 + 10 * MIN, deferred: true },
      { t: 'scan', now: S2 + 51 * MIN + 30_000, checkpointId: 11, username: 'ali', at: S2 + 12 * MIN, deferred: true },
    ];
    for (let now = S - 20 * MIN; now <= S + 60 * MIN; now += MIN) calls.push({ t: 'tick', now });
    for (let now = S2 - 5 * MIN; now <= S2 + 55 * MIN; now += MIN) calls.push({ t: 'tick', now });
    calls.push(...scans);
    calls.sort((a, b) => a.now - b.now);
    calls.push({ t: 'release', now: S2 + HOUR });
    return calls;
  }

  function play(m: PatrolMachine, calls: Call[], db: Map<number, RunState>): unknown[] {
    return calls.map((c) => {
      if (c.t === 'tick') {
        const out = m.tick(c.now);
        persist(db, out);
        return out;
      }
      if (c.t === 'release') return m.release(c.now);
      const result = m.scan(c.now, { checkpointId: c.checkpointId, username: c.username, at: c.at, deferred: c.deferred });
      persist(db, result.actions, { ...c, result });
      return result;
    });
  }

  it('deux machines neuves, memes appels : memes actions ; les actions suffisent a reconstruire l\'etat', () => {
    const calls = script();
    const dbA = new Map<number, RunState>();
    const a = createPatrolMachine(spec(), calls[0].now);
    const outA = play(a, calls, dbA);
    const b = createPatrolMachine(spec(), calls[0].now);
    assert.deepEqual(play(b, calls, new Map()), outA);
    assert.deepEqual(dbRuns(dbA), a.runs());
    // Le scenario passe bien par les etats attendus.
    const events = outA.flatMap((o) => (Array.isArray(o) ? o : (o as PatrolScanResult).actions)).filter((x): x is Extract<PatrolAction, { kind: 'event' }> => x.kind === 'event');
    assert.deepEqual(events.map((e) => `${e.dueStart === S ? 'S' : 'S2'}:${e.event}`), ['S:patrol_incomplete', 'S:clear', 'S2:patrol_missed', 'S2:clear']);
    assert.deepEqual(a.runs().map((r) => r.status), ['done', 'missed']);
  });

  it('redemarrage a n\'importe quel moment : `load` de la base + memes appels = memes actions', () => {
    const calls = script();
    const dbA = new Map<number, RunState>();
    const a = createPatrolMachine(spec(), calls[0].now);
    const outA = play(a, calls, dbA);
    // Points de redemarrage : avant toute ronde, pendant la ronde, pendant la grace, entre deux nuits, avant les scans differes.
    const indexes = [0, 5, 12, 30, 45, 50, 80, 100, calls.length - 3, calls.length - 1];
    for (const k of indexes) {
      const db = new Map<number, RunState>();
      play(createPatrolMachine(spec(), calls[0].now), calls.slice(0, k), db);
      const b = createPatrolMachine(spec(), calls[k].now);
      b.load(dbRuns(db));
      const outB = play(b, calls.slice(k), db);
      assert.deepEqual(outB, outA.slice(k), `redemarrage a l'appel ${k}`);
      assert.deepEqual(b.runs(), a.runs(), `etat final apres redemarrage a l'appel ${k}`);
      assert.deepEqual(dbRuns(db), dbRuns(dbA));
    }
  });
});
