/**
 * Interoperabilite du protocole de synchronisation des titulaires : le VRAI cote PSIM (server/accesssync.ts) branche sur le VRAI
 * pilote de la passerelle (gateway/src/accesssync.ts), puis sur le gestionnaire commun des modules (acces-commun/sync.ts).
 * Contrat : docs/CONTROLE-ACCES.md par. 7, precisions docs/ACCES.md par. 12.4.
 *
 *  1. vecteurs canoniques FIXES (copies de gateway/test/accesssync.test.ts) : memes chaines et memes signatures des deux cotes ;
 *  2. boucle fermee en memoire : base `:memory:`, faux `RightsSource`, horloge et planificateur injectes (aucune attente reelle).
 *     Le transport PSIM -> pilote est un appel direct ; le chemin retour renvoie l'accuse du pilote a `receiveAck`. Le module de la
 *     passerelle est un gestionnaire factice (done / refused / error / silence de N secondes simulees) ou le vrai `makeSyncHandler`
 *     avec un pilote de controleur factice.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { createAccessSyncPilot, parseSyncOrder } from '../gateway/src/accesssync.ts';
import type { AccessSyncPilot } from '../gateway/src/accesssync.ts';
import type { Scheduler } from '../gateway/src/actuators.ts';
import type { AccessSyncHandler, AccessSyncOp, ActuatorOutcome } from '../gateway/src/module.ts';
import { ActuatorFailure } from '../gateway/src/modules/acces-commun/actuator.ts';
import { SlotMap } from '../gateway/src/modules/acces-commun/slots.ts';
import { makeSyncHandler, parseSyncBody } from '../gateway/src/modules/acces-commun/sync.ts';
import type { SyncDriver } from '../gateway/src/modules/acces-commun/sync.ts';
import type { AckVerdict, DesiredHolder, DesiredSchedule, DesiredState, RightsListener, RightsSource, SyncService } from '../server/accessholderstypes.ts';
import { ackString, createSync, MAX_BODY_BYTES, MAX_MESSAGE_BYTES, orderString, scheduleBody, signAck, signOrder } from '../server/accesssync.ts';
import { openDb } from '../server/db.ts';

const S = 1000;
const T0 = Date.UTC(2026, 9, 17, 8, 0, 0);
const CTL = 'CTL-1';

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// =============================================================================================================================
// 1. Vecteurs canoniques FIXES (gateway/test/accesssync.test.ts, « vecteurs canoniques FIXES »)
// =============================================================================================================================

describe('interop : vecteurs canoniques fixes (memes valeurs que la passerelle)', () => {
  // Cle 000102...1f, controleur CTL-1, opId 0123456789abcdef0123456789abcdef, ts de l'ordre 1760000000000, ts de l'accuse 1760000000400.
  const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  const OPID = '0123456789abcdef0123456789abcdef';
  const key = Buffer.from(KEY, 'hex');
  const ORDERS = [
    {
      seq: 42,
      body: '{"type":"delete_holder","holderRef":"H101"}',
      sha: '927316f03deff04a847b6a9ca238283f851e54adc7ceef86e0158f691d58b753',
      sig: '7e4c4f3f1e5064a0176dfe5a066f1b4cdc82dd91387b6008543e9bfee4145062',
    },
    {
      seq: 43,
      body: '{"type":"set_holidays","dates":["2026-12-25"],"replace":true}',
      sha: '2c6fad86b98dade78bdfcd8398d8f518ec09107d2f8ce4fff0e25ae30a6d6d24',
      sig: 'de20c3a31be8f88ee1c44e01ef612e8c394dcf3f0065f1c0a3201944ffabacbe',
    },
    {
      // Nom accentue (E accent aigu, U+00C9) : l'empreinte porte sur les octets UTF-8 du corps.
      seq: 44,
      body: `{"type":"upsert_holder","holderRef":"H7","name":"KONAN Aya ${String.fromCodePoint(0xc9)}milie","active":true,"validFrom":null,"validTo":null,"credentials":["0012345"],"doors":[{"doorNo":1,"scheduleRef":null}]}`,
      sha: 'd886f6c082fcfb7e8e5e7276b7ad750b6d206e1ec302d8578dbb6e65561554f4',
      sig: '8d89d7923786358ef242f27090b2c3299d1d15baa88cfd37f7b0cca267f29305',
    },
  ];
  const ACKS = [
    { seq: 42, result: 'done', code: null, canonical: 'psim-sync-ack-v1|CTL-1|0123456789abcdef0123456789abcdef|42|done||1760000000400', sig: 'a0b4c9e76d5561568d6a334fcda8f7091fe7ce0aeee5203b031a4147ad069899' },
    { seq: 43, result: 'refused', code: 'invalid', canonical: 'psim-sync-ack-v1|CTL-1|0123456789abcdef0123456789abcdef|43|refused|invalid|1760000000400', sig: '510b4e07be71561efef4596dae80c09d29ae0e30ea50e52ef305988bd8aedf59' },
    { seq: 44, result: 'error', code: 'unreachable', canonical: 'psim-sync-ack-v1|CTL-1|0123456789abcdef0123456789abcdef|44|error|unreachable|1760000000400', sig: '4809267e3614e645384979b48a262197b8946b59e9b538eac4c3bed8871a733a' },
  ];

  it('ordres : chaine canonique et signature identiques a celles de la passerelle', () => {
    for (const v of ORDERS) {
      assert.equal(orderString(CTL, OPID, v.seq, 1_760_000_000_000, v.body), `psim-sync-v1|CTL-1|${OPID}|${v.seq}|1760000000000|${v.sha}`);
      assert.equal(signOrder(key, CTL, OPID, v.seq, 1_760_000_000_000, v.body), v.sig);
    }
  });

  it('accuses : chaine canonique et signature identiques a celles de la passerelle', () => {
    for (const a of ACKS) {
      assert.equal(ackString(CTL, OPID, a.seq, a.result, a.code, 1_760_000_000_400), a.canonical);
      assert.equal(signAck(key, CTL, OPID, a.seq, a.result, a.code, 1_760_000_000_400), a.sig);
    }
  });

  it('un ordre signe par le PSIM est lu par parseSyncOrder de la passerelle (six champs exacts, corps intact)', () => {
    const v = ORDERS[2];
    const sig = signOrder(key, CTL, OPID, v.seq, 1_760_000_000_000, v.body);
    const raw = JSON.stringify({ v: 1, opId: OPID, seq: v.seq, ts: 1_760_000_000_000, body: v.body, sig });
    assert.deepEqual(parseSyncOrder(raw), { opId: OPID, seq: v.seq, ts: 1_760_000_000_000, body: v.body, sig: v.sig });
  });
});

// =============================================================================================================================
// 2. Boucle fermee : vrai PSIM <-> vrai pilote de la passerelle
// =============================================================================================================================

class FakeRights implements RightsSource {
  ids: string[] = [CTL];
  states = new Map<string, DesiredState>();
  listeners: RightsListener[] = [];
  controllerIds(): string[] {
    return [...this.ids];
  }
  desired(c: string): DesiredState {
    return structuredClone(this.states.get(c) ?? { holders: [], schedules: [], holidays: [] });
  }
  subscribe(l: RightsListener): void {
    this.listeners.push(l);
  }
  set(c: string, s: Partial<DesiredState>): void {
    this.states.set(c, { holders: [], schedules: [], holidays: [], ...s });
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
};

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

interface Posted {
  opId: string;
  seq: number;
  type: string;
}

/** Banc : PSIM reel + pilote reel, horloge et planificateur fictifs partages. */
class Rig {
  t = T0;
  timers: Timer[] = [];
  private nextId = 0;
  db: DatabaseSync;
  rights = new FakeRights();
  sync!: SyncService;
  pilot: AccessSyncPilot;
  audits: { action: string; details?: string }[] = [];
  /** Ordres publies par le PSIM (meme ceux perdus). */
  orders: Posted[] = [];
  /** Accuses remis au PSIM et verdicts rendus. */
  acks: { opId: string; seq: number; result: string; code: string | null }[] = [];
  verdicts: AckVerdict[] = [];
  pilotLog: string[] = [];
  dropAcks = false;
  dropOrders = false;
  key = '';
  unregister: () => void = () => undefined;
  readonly scheduler: Scheduler = (fn, ms) => {
    const timer: Timer = { id: ++this.nextId, at: this.t + ms, fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((x) => x !== timer);
    };
  };

  constructor(opts: { handlerTimeoutMs?: number } = {}) {
    this.db = openDb(':memory:');
    this.db
      .prepare('INSERT INTO access_controller (id, name, brand, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(CTL, 'Controleur 1', 'dahua', T0, 'admin', T0, 'admin');
    this.pilot = createAccessSyncPilot({
      log: { log: (level, text) => void this.pilotLog.push(`${level} ${text}`) },
      now: () => this.t,
      publishAck: (c, payload) => {
        if (this.dropAcks) return false;
        const a = JSON.parse(payload) as { opId: string; seq: number; result: string; code: string | null };
        this.acks.push({ opId: a.opId, seq: a.seq, result: a.result, code: a.code });
        this.verdicts.push(this.sync.receiveAck(c, payload));
        return true;
      },
      stateFile: null,
      schedule: this.scheduler,
      handlerTimeoutMs: opts.handlerTimeoutMs,
    });
    this.sync = this.buildSync();
  }

  /** Une instance du service PSIM sur la base courante (un redemarrage en recree une). */
  buildSync(): SyncService {
    return createSync({
      db: this.db,
      now: () => this.t,
      key: Buffer.alloc(32, 7),
      audit: (_actor, action, ref) => void this.audits.push({ action, details: ref?.details }),
      rights: this.rights,
      transport: {
        publish: (c, payload) => {
          const m = parseSyncOrder(payload);
          assert.ok(m, 'le pilote doit pouvoir lire TOUT ordre publie par le PSIM');
          assert.ok(Buffer.byteLength(payload, 'utf8') <= MAX_MESSAGE_BYTES);
          assert.ok(Buffer.byteLength(m.body, 'utf8') <= MAX_BODY_BYTES);
          this.orders.push({ opId: m.opId, seq: m.seq, type: (JSON.parse(m.body) as { type: string }).type });
          if (!this.dropOrders) void this.pilot.handleMessage(c, payload);
          return true;
        },
      },
    });
  }

  restartPsim(): void {
    this.sync = this.buildSync();
    this.sync.start();
  }

  /** Cree la cle, la « recopie » dans la passerelle (enregistrement du gestionnaire) et demarre le PSIM. */
  async boot(desired: Partial<DesiredState>, handler: AccessSyncHandler, opts: { moduleUp?: boolean } = {}): Promise<void> {
    this.rights.set(CTL, desired);
    this.key = this.sync.issueKey('admin', CTL).key;
    this.unregister = this.pilot.register(CTL, this.key, handler);
    if (opts.moduleUp === false) this.removeModule(); // le pilote connait la cle, mais aucun module n'a de gestionnaire
    this.sync.start();
    await flush();
  }

  /** Le module du controleur s'arrete : le pilote garde la cle mais n'a plus de gestionnaire. */
  removeModule(): void {
    this.unregister();
  }

  async advanceTo(target: number): Promise<void> {
    for (;;) {
      let next: Timer | undefined;
      for (const x of this.timers) if (x.at <= target && (!next || x.at < next.at || (x.at === next.at && x.id < next.id))) next = x;
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = Math.max(this.t, next.at);
      next.fn();
      await flush();
    }
    this.t = target;
  }

  /** Une seconde simulee a la fois : minuteries dues, puis tick du PSIM. */
  async elapse(seconds: number, each?: () => void): Promise<void> {
    for (let i = 0; i < seconds; i++) {
      await this.advanceTo(this.t + S);
      this.sync.tick();
      await flush();
      each?.();
    }
  }

  /** Promesse resolue apres `ms` millisecondes SIMULEES. */
  after(ms: number): Promise<void> {
    return new Promise((resolve) => void this.scheduler(resolve, ms));
  }

  get sec(): number {
    return (this.t - T0) / S;
  }
  item(kind: string, ref: string) {
    return this.sync.controller(CTL).items.find((i) => i.kind === kind && i.ref === ref);
  }
  seqsOf(opId: string): number[] {
    return this.orders.filter((o) => o.opId === opId).map((o) => o.seq);
  }
}

/** Gestionnaire factice de module : `fn` decide du resultat ; les appels sont comptes. */
function scripted(fn: (op: AccessSyncOp, n: number) => ActuatorOutcome | Promise<ActuatorOutcome>): AccessSyncHandler & { calls: AccessSyncOp[] } {
  const calls: AccessSyncOp[] = [];
  const handler = (async (op: AccessSyncOp) => {
    calls.push(op);
    return fn(op, calls.length);
  }) as AccessSyncHandler & { calls: AccessSyncOp[] };
  handler.calls = calls;
  return handler;
}

const holder = (n: number, scheduleRef = 'S1', over: Partial<DesiredHolder> = {}): DesiredHolder => ({
  ref: `H${n}`,
  name: `NOM${n} Prenom${n}`,
  active: true,
  validFrom: null,
  validTo: null,
  credentials: [`B${n}`],
  doors: [{ doorNo: 1, scheduleRef }],
  ...over,
});

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
/** La plage « Tout le temps » : deux fenetres 00:00 -> 12:00 et 12:00 -> 00:00, sept jours sur sept. */
const alwaysSchedule = (ref = 'S1'): DesiredSchedule => ({
  ref,
  windows: [
    { days: ALL_DAYS, from: '00:00', to: '12:00' },
    { days: ALL_DAYS, from: '12:00', to: '00:00' },
  ],
  holidays: false,
});
const weekSchedule = (ref = 'S2', holidays = false): DesiredSchedule => ({ ref, windows: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }], holidays });

/** Controleur factice (pilote d'un module) : enregistre les appels ; `dahuaLike` refuse « fermé les jours fériés » comme le module Dahua. */
function fakeDriver(opts: { dahuaLike?: boolean } = {}): { driver: SyncDriver; calls: string[] } {
  const calls: string[] = [];
  const driver: SyncDriver = {
    upsertHolder: async (h, doorSlots) => void calls.push(`holder:${h.holderRef}:${doorSlots.map((d) => `${d.doorNo}=${d.slot}`).join(',')}`),
    deleteHolder: async (ref) => void calls.push(`delete_holder:${ref}`),
    upsertSchedule: async (ref, slot, _windows, holidays) => {
      if (holidays && opts.dahuaLike) throw new ActuatorFailure('not_supported', 'horaire « ferme les jours feries » non pris en charge');
      calls.push(`schedule:${ref}:${slot}`);
    },
    deleteSchedule: async (ref, slot) => void calls.push(`delete_schedule:${ref}:${slot}`),
    setHolidays: async (dates, replace) => void calls.push(`holidays:${dates.join(',')}:${replace}`),
  };
  return { driver, calls };
}

/** Le vrai gestionnaire commun des modules sur un controleur factice. */
function realHandler(rig: Rig, opts: { dahuaLike?: boolean } = {}): { handler: AccessSyncHandler; calls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'psim-interop-'));
  tmpDirs.push(dir);
  const slots = new SlotMap({ dir, now: () => rig.t, log: () => undefined, min: 1, max: 8 });
  const { driver, calls } = fakeDriver(opts);
  return { handler: makeSyncHandler(CTL, driver, { slots, now: () => rig.t, log: () => undefined }), calls };
}

describe('interop : boucle fermee PSIM <-> pilote <-> gestionnaire commun', () => {
  it('envoi complet ordonne : jours feries, plages, titulaires ; tout est signe, lu et accuse', async () => {
    const rig = new Rig();
    const { handler, calls } = realHandler(rig);
    await rig.boot(
      { holidays: ['2026-12-25', '2027-01-01'], schedules: [alwaysSchedule('S1'), weekSchedule('S2')], holders: [holder(1, 'S1'), holder(2, 'S2'), holder(3, 'S1')] },
      handler,
    );
    await rig.elapse(5);
    assert.deepEqual(calls, ['holidays:2026-12-25,2027-01-01:true', 'schedule:S1:1', 'schedule:S2:2', 'holder:H1:1=1', 'holder:H2:1=2', 'holder:H3:1=1']);
    assert.deepEqual(rig.orders.map((o) => o.seq), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(rig.orders.map((o) => o.type), ['set_holidays', 'upsert_schedule', 'upsert_schedule', 'upsert_holder', 'upsert_holder', 'upsert_holder']);
    assert.ok(rig.verdicts.every((v) => v.accepted), 'tous les accuses du pilote sont acceptes par le PSIM');
    assert.deepEqual(rig.pilot.stats(), { controllers: 1, done: 6, refused: 0, failed: 0, unreachable: 0, ignored: 0, replayed: 0, reacked: 0, acksLost: 0 });
    const st = rig.sync.status()[0];
    assert.equal(st.state, 'ok');
    assert.equal(st.counts.synced, 6);
    assert.equal(rig.sync.holderStatus('H1')[0].state, 'synced');
    assert.equal(rig.audits.filter((a) => a.action === 'access_sync_failed').length, 0);
  });

  it('accuse perdu puis renvoi : l\'accuse est REEMIS, le module n\'execute jamais deux fois', async () => {
    const rig = new Rig();
    const module = scripted(() => ({ result: 'done' }));
    rig.dropAcks = true; // le premier accuse (et ceux d'avant le renvoi) se perd
    await rig.boot({ schedules: [weekSchedule('S1')], holders: [holder(1, 'S1')] }, module);
    await rig.elapse(3);
    assert.equal(module.calls.length, 1);
    assert.equal(rig.pilot.stats().acksLost, 1);
    assert.equal(rig.verdicts.length, 0, 'le PSIM n\'a rien recu');
    rig.dropAcks = false;
    await rig.elapse(8); // renvoi du MEME ordre a 10 s
    assert.equal(rig.seqsOf(rig.orders[0].opId).length, 2, 'meme opId, meme seq, renvoye une fois');
    assert.equal(rig.pilot.stats().reacked, 1);
    assert.equal(module.calls.filter((o) => o.seq === 1).length, 1, 'pas de double execution');
    assert.deepEqual(rig.verdicts[0], { accepted: true });
    await rig.elapse(3);
    assert.equal(module.calls.length, 2, 'la plage puis le titulaire, une fois chacun');
    assert.equal(rig.sync.status()[0].state, 'ok');
  });

  it('ordre perdu en route : renvoye a l\'identique, execute une seule fois', async () => {
    const rig = new Rig();
    const module = scripted(() => ({ result: 'done' }));
    rig.dropOrders = true;
    await rig.boot({ schedules: [weekSchedule('S1')] }, module);
    await rig.elapse(15); // envois a 0 s et 10 s : perdus
    assert.equal(module.calls.length, 0);
    rig.dropOrders = false;
    await rig.elapse(20); // 30 s : arrive
    assert.equal(module.calls.length, 1);
    assert.equal(rig.sync.status()[0].state, 'ok');
    assert.equal(new Set(rig.orders.map((o) => o.opId)).size, 1);
  });

  it('execution lente (120 s) : les renvois pendant l\'execution sont ignores, l\'accuse tardif est accepte', async () => {
    const rig = new Rig();
    const module = scripted(async () => {
      await rig.after(120 * S);
      return { result: 'done' };
    });
    await rig.boot({ schedules: [weekSchedule('S1')], holders: [holder(1, 'S1')] }, module);
    await rig.elapse(119, () => assert.notEqual(rig.item('schedule', 'S1')?.state, 'failed', `pas d'echec a ${rig.sec} s`));
    assert.equal(module.calls.length, 1, 'le module n\'est appele qu\'une fois');
    assert.deepEqual(rig.orders.map((o) => o.seq), [1, 1, 1, 1], 'envois a 0, 10, 30 et 70 s : toujours le meme (opId, seq)');
    assert.equal(new Set(rig.orders.map((o) => o.opId)).size, 1);
    assert.equal(rig.pilot.stats().replayed, 3, 'trois renvois ignores par le pilote');
    assert.equal(rig.verdicts.length, 0);
    await rig.elapse(2); // l'accuse part a 120 s
    assert.deepEqual(rig.verdicts[0], { accepted: true });
    assert.equal(rig.orders.at(-1)!.seq, 2, 'on est passe a l\'operation suivante');
    assert.equal(rig.item('schedule', 'S1'), undefined, 'S1 est synchronisee');
  });

  it('execution normale de 299 s (ZKTeco) : jamais d\'echec « no_ack » a tort (6e envoi a 310 s)', async () => {
    const rig = new Rig();
    const module = scripted(async () => {
      await rig.after(299 * S);
      return { result: 'done' };
    });
    await rig.boot({ schedules: [weekSchedule('S1')] }, module);
    let failedSeen = false;
    await rig.elapse(300, () => {
      if (rig.sync.status()[0].counts.failed > 0) failedSeen = true;
    });
    assert.equal(failedSeen, false);
    assert.deepEqual(rig.orders.map((o) => o.seq), [1, 1, 1, 1, 1], 'cinq envois avant la reponse : 0, 10, 30, 70, 150 s');
    assert.equal(module.calls.length, 1);
    assert.equal(rig.sync.status()[0].state, 'ok');
    assert.equal(rig.sync.status()[0].lastAckAt, T0 + 299 * S);
  });

  it('module muet pendant 300 s : error/timeout du pilote, operation remplacee, echec visible apres 5 essais puis guerison', async () => {
    const rig = new Rig({ handlerTimeoutMs: 300 * S });
    const module = scripted((_op, n) => (n === 1 ? new Promise<ActuatorOutcome>(() => undefined) : { result: 'done' }));
    await rig.boot({ schedules: [weekSchedule('S1')] }, module);
    await rig.elapse(300);
    assert.deepEqual(rig.acks.map((a) => [a.result, a.code]), [['error', 'timeout']], 'le pilote accuse a 300 s');
    assert.equal(rig.item('schedule', 'S1')?.state, 'pending');
    assert.equal(rig.item('schedule', 'S1')?.code, 'timeout');
    assert.equal(rig.item('schedule', 'S1')?.message, 'Le contrôleur a mis trop de temps à répondre : nouvel essai automatique.');
    await rig.elapse(9); // 309 s
    assert.equal(rig.orders.length, 5);
    await rig.elapse(2); // 310 s : 5 essais cumules, l'operation morte est remplacee et l'echec devient visible
    assert.equal(rig.orders.length, 6);
    assert.equal(rig.orders[5].seq, 2);
    assert.notEqual(rig.orders[5].opId, rig.orders[0].opId);
    assert.equal(rig.audits.filter((a) => a.action === 'access_sync_failed').length, 1);
    assert.equal(module.calls.length, 2);
    assert.equal(rig.sync.status()[0].state, 'ok', 'le second essai a reussi : plus d\'echec');
    assert.equal(rig.sync.controller(CTL).lastProblem, null);
  });

  it('accuse tardif APRES l\'echec « no_ack » (module tres lent) : accepte, l\'element redevient synchronise', async () => {
    const rig = new Rig({ handlerTimeoutMs: 3_600 * S });
    const module = scripted(async () => {
      await rig.after(400 * S);
      return { result: 'done' };
    });
    await rig.boot({ schedules: [weekSchedule('S1')] }, module);
    await rig.elapse(315);
    const item = rig.item('schedule', 'S1')!;
    assert.equal(item.state, 'failed');
    assert.equal(item.code, 'no_ack');
    assert.equal(rig.sync.status()[0].state, 'failed');
    assert.equal(rig.orders.length, 6, 'un 6e envoi a 310 s, ignore par le pilote');
    assert.equal(module.calls.length, 1);
    await rig.elapse(90); // l'accuse part a 400 s
    assert.deepEqual(rig.verdicts[0], { accepted: true });
    assert.equal(rig.sync.status()[0].state, 'ok');
    assert.equal(rig.sync.controller(CTL).lastProblem, null);
    assert.equal(rig.item('schedule', 'S1'), undefined);
  });

  it('error/io : nouvel opId et nouveau seq a l\'echeance, puis done', async () => {
    const rig = new Rig();
    const module = scripted((_op, n) => (n === 1 ? { result: 'error', code: 'io' } : { result: 'done' }));
    await rig.boot({ schedules: [weekSchedule('S1')] }, module);
    await rig.elapse(5);
    assert.deepEqual(rig.acks.map((a) => [a.result, a.code]), [['error', 'io']]);
    assert.equal(rig.item('schedule', 'S1')?.code, 'io');
    assert.match(rig.item('schedule', 'S1')!.message!, /Nouvel essai automatique/);
    assert.equal(rig.orders.length, 1, 'jamais de renvoi du meme (opId, seq) apres un accuse error');
    await rig.elapse(6); // 11 s : echeance de 10 s
    assert.equal(rig.orders.length, 2);
    assert.deepEqual(rig.orders.map((o) => o.seq), [1, 2]);
    assert.notEqual(rig.orders[1].opId, rig.orders[0].opId);
    assert.deepEqual(module.calls.map((o) => o.seq), [1, 2], 'le module a vu deux operations distinctes');
    assert.equal(rig.sync.status()[0].state, 'ok');
    assert.equal(rig.sync.controller(CTL).lastProblem, null);
    assert.equal(rig.pilot.stats().replayed, 0);
  });

  it('error/busy du gestionnaire : meme traitement, phrase dediee', async () => {
    const rig = new Rig();
    const module = scripted((_op, n) => (n <= 2 ? { result: 'error', code: 'busy' } : { result: 'done' }));
    await rig.boot({ schedules: [weekSchedule('S1')] }, module);
    await rig.elapse(2);
    assert.equal(rig.item('schedule', 'S1')?.message, 'La passerelle a trop de changements en attente : nouvel essai automatique.');
    await rig.elapse(10); // 12 s
    assert.equal(rig.orders.length, 2);
    await rig.elapse(20); // 32 s : 3e essai (echeance 10 + 20 s)
    assert.deepEqual(rig.orders.map((o) => o.seq), [1, 2, 3]);
    assert.equal(rig.sync.status()[0].state, 'ok');
  });

  it('refused/not_supported pour une plage « jours feries » : phrase exacte ; titulaires dependants : phrase derivee', async () => {
    const rig = new Rig();
    const { handler, calls } = realHandler(rig, { dahuaLike: true });
    await rig.boot(
      { schedules: [weekSchedule('S1', true), weekSchedule('S2')], holders: [holder(1, 'S1'), holder(2, 'S2'), holder(3, 'S1')] },
      handler,
    );
    await rig.elapse(6);
    assert.deepEqual(calls, ['schedule:S2:1', 'holder:H2:1=1'], 'seuls S2 et H2 atteignent le controleur');
    assert.equal(
      rig.item('schedule', 'S1')?.message,
      "Ce contrôleur ne sait pas encore appliquer « fermé les jours fériés » : retirez l'option de cette plage ou attendez la qualification.",
    );
    assert.equal(rig.item('schedule', 'S1')?.code, 'not_supported');
    const phrase = "L'horaire de ce titulaire n'a pas pu être envoyé au contrôleur (voir l'état de la plage S1).";
    assert.equal(rig.item('holder', 'H1')?.message, phrase);
    assert.equal(rig.item('holder', 'H1')?.code, 'invalid');
    assert.equal(rig.item('holder', 'H3')?.message, phrase);
    assert.equal(rig.sync.holderStatus('H1')[0].message, phrase);
    assert.equal(rig.item('holder', 'H2'), undefined, 'H2 est synchronise');
    assert.equal(rig.sync.status()[0].state, 'failed');
    // Aucun renvoi sans fin : ces refus sont definitifs.
    const n = rig.orders.length;
    await rig.elapse(120);
    assert.equal(rig.orders.length, n);
  });

  it('module absent (unreachable, seq non consomme) puis present : le PSIM remplace l\'operation, la passerelle l\'execute', async () => {
    const rig = new Rig();
    const module = scripted(() => ({ result: 'done' }));
    await rig.boot({ schedules: [weekSchedule('S1')] }, module, { moduleUp: false });
    await rig.elapse(1);
    const first = rig.acks.at(0);
    assert.ok(first);
    assert.deepEqual([first.result, first.code], ['error', 'unreachable']);
    assert.equal(module.calls.length, 0);
    assert.match(rig.item('schedule', 'S1')!.message!, /n'arrive pas à joindre le contrôleur/);
    await rig.elapse(10); // seq 2, de nouveau unreachable
    assert.ok(rig.acks.length >= 2);
    assert.ok(rig.acks.every((a) => a.code === 'unreachable'));
    assert.deepEqual(rig.orders.map((o) => o.seq), [1, 2]);
    // Le module revient (la passerelle le reenregistre avec la meme cle).
    rig.unregister = rig.pilot.register(CTL, rig.key, module);
    await rig.elapse(25); // echeance a 30 s
    assert.deepEqual(rig.orders.map((o) => o.seq), [1, 2, 3]);
    assert.equal(module.calls.length, 1);
    assert.equal(module.calls[0].seq, 3);
    assert.equal(rig.sync.status()[0].state, 'ok');
    assert.equal(rig.sync.controller(CTL).lastProblem, null);
  });

  it('redemarrage du PSIM pendant une execution lente : meme ordre renvoye, ignore, l\'accuse est accepte par la nouvelle instance', async () => {
    const rig = new Rig();
    const module = scripted(async () => {
      await rig.after(50 * S);
      return { result: 'done' };
    });
    await rig.boot({ schedules: [weekSchedule('S1')] }, module);
    await rig.elapse(20);
    rig.restartPsim(); // nouvelle instance sur la meme base : renvoi immediat de l'operation persistee
    await flush();
    assert.equal(rig.orders.length, 3, 'envois a 0 s, 10 s et au redemarrage (20 s) : la prochaine echeance est a 60 s');
    assert.equal(new Set(rig.orders.map((o) => o.opId)).size, 1);
    assert.equal(module.calls.length, 1);
    await rig.elapse(32);
    assert.deepEqual(rig.verdicts.at(0), { accepted: true });
    assert.equal(rig.sync.status()[0].state, 'ok');
    assert.equal(module.calls.length, 1);
  });

  it('redemarrage du PSIM apres execution mais accuse perdu : accuse reemis, jamais de double execution', async () => {
    const rig = new Rig();
    const module = scripted(() => ({ result: 'done' }));
    rig.dropAcks = true;
    await rig.boot({ schedules: [weekSchedule('S1')] }, module);
    await rig.elapse(2);
    assert.equal(module.calls.length, 1);
    rig.dropAcks = false;
    rig.restartPsim();
    await flush();
    assert.equal(module.calls.length, 1);
    assert.equal(rig.pilot.stats().reacked, 1);
    assert.deepEqual(rig.verdicts.at(-1), { accepted: true });
    assert.equal(rig.sync.status()[0].state, 'ok');
  });

  it('renouvellement de cle : le PSIM continue sa numerotation, la passerelle repart de zero ; rien ne se bloque', async () => {
    const rig = new Rig();
    const module = scripted(async (op) => {
      if (op.type === 'upsert_schedule') await rig.after(30 * S);
      return { result: 'done' };
    });
    await rig.boot({ schedules: [weekSchedule('S1')], holders: [holder(1, 'S1'), holder(2, 'S1')] }, module);
    await rig.elapse(5);
    const seqInDb = (): number => (rig.db.prepare('SELECT last_seq FROM access_sync_controller WHERE controller_id = ?').get(CTL) as { last_seq: number }).last_seq;
    assert.equal(seqInDb(), 1);
    // L'administrateur renouvelle la cle cote PSIM. La passerelle n'a pas encore la nouvelle : tout est signe avec la nouvelle, rien ne passe.
    const renewed = rig.sync.issueKey('admin', CTL);
    assert.notEqual(renewed.key, rig.key);
    assert.equal(seqInDb(), 1, 'issueKey ne touche pas au compteur du PSIM');
    await rig.elapse(40); // l'ancien module finit a 30 s : son accuse est signe avec l'ANCIENNE cle
    assert.ok(rig.verdicts.some((v) => !v.accepted && v.reason === 'signature'), 'accuse a l\'ancienne cle refuse');
    assert.ok(rig.pilot.stats().ignored > 0, 'ordres a la nouvelle cle ignores (signature fausse)');
    assert.equal(rig.sync.status()[0].counts.synced, 0);
    // La passerelle est reconfiguree : le module s'arrete et se relance avec la nouvelle cle -> son compteur repart de zero.
    rig.removeModule();
    rig.key = renewed.key;
    rig.unregister = rig.pilot.register(CTL, renewed.key, module);
    assert.ok(rig.pilotLog.some((l) => /cle de synchronisation changee/.test(l)));
    await rig.elapse(400); // le PSIM renvoie la meme operation (seq 1) signee avec la nouvelle cle : acceptee
    assert.equal(rig.sync.status()[0].state, 'ok');
    assert.equal(rig.sync.status()[0].counts.synced, 3);
    assert.ok(seqInDb() >= 3, 'la numerotation du PSIM a continue');
    assert.equal(rig.item('holder', 'H1'), undefined);
  });

  it('constat : remettre last_seq a zero cote PSIM SEUL bloquerait la synchronisation (rejeu pour la passerelle)', async () => {
    const rig = new Rig();
    const module = scripted(() => ({ result: 'done' }));
    await rig.boot({ schedules: [weekSchedule('S1')], holders: [holder(1, 'S1'), holder(2, 'S1')] }, module);
    await rig.elapse(5);
    assert.equal(module.calls.length, 3);
    rig.db.prepare('UPDATE access_sync_controller SET last_seq = 0 WHERE controller_id = ?').run(CTL);
    rig.rights.set(CTL, { schedules: [weekSchedule('S1')], holders: [holder(1, 'S1'), holder(2, 'S1'), holder(3, 'S1')] });
    rig.sync.notify([CTL]);
    await rig.elapse(400);
    assert.equal(module.calls.length, 3, 'H3 n\'a jamais atteint le module');
    assert.ok(rig.pilot.stats().replayed > 0, 'la passerelle y voit un rejeu (seq 1 deja vu)');
    assert.equal(rig.item('holder', 'H3')?.code, 'no_ack');
  });

  it('set_holidays avec dates: [] est accepte par le pilote et le gestionnaire commun (vidage de la liste)', async () => {
    const rig = new Rig();
    const { handler, calls } = realHandler(rig);
    await rig.boot({ holidays: ['2026-12-25'] }, handler);
    await rig.elapse(2);
    rig.rights.set(CTL, { holidays: [] });
    rig.sync.notify([CTL]);
    await rig.elapse(3);
    assert.deepEqual(calls, ['holidays:2026-12-25:true', 'holidays::true']);
    const last = rig.orders.at(-1)!;
    assert.equal(last.type, 'set_holidays');
    assert.equal(rig.acks.at(-1)!.result, 'done');
    assert.equal(rig.sync.status()[0].state, 'ok');
    assert.deepEqual(rig.sync.controller(CTL).items, []);
  });

  it('la plage « Tout le temps » (00:00-12:00 et 12:00-00:00, 7 jours) passe parseSyncBody de la passerelle', () => {
    const body = JSON.parse(scheduleBody(alwaysSchedule('S5'))) as Record<string, unknown>;
    const parsed = parseSyncBody({ ...body, opId: 'a'.repeat(32), seq: 9 });
    assert.equal(parsed.ok, true);
    if (parsed.ok && parsed.op.type === 'upsert_schedule') {
      assert.equal(parsed.op.windows.length, 2);
      assert.deepEqual(parsed.op.windows[0], { days: ALL_DAYS, from: '00:00', to: '12:00' });
      assert.deepEqual(parsed.op.windows[1], { days: ALL_DAYS, from: '12:00', to: '00:00' });
      assert.equal(parsed.op.holidays, false);
    }
    // Les corps de tous les autres types produits par le PSIM sont eux aussi valides pour la passerelle.
    for (const b of [
      JSON.stringify({ type: 'upsert_holder', holderRef: 'H1', name: 'KONAN Yao', active: true, validFrom: null, validTo: null, credentials: ['B1'], doors: [{ doorNo: 1, scheduleRef: 'S5' }] }),
      JSON.stringify({ type: 'delete_holder', holderRef: 'H1' }),
      JSON.stringify({ type: 'delete_schedule', scheduleRef: 'S5' }),
      JSON.stringify({ type: 'set_holidays', dates: [], replace: true }),
      JSON.stringify({ type: 'set_holidays', dates: ['2026-12-25'], replace: false }),
    ]) {
      assert.equal(parseSyncBody(JSON.parse(b)).ok, true, b);
    }
  });
});
