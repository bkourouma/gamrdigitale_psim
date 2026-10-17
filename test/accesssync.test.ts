/**
 * Synchronisation des titulaires PSIM -> controleurs (lot AC5) : protocole du § 7 de docs/CONTROLE-ACCES.md, precisions du § 10.4 de
 * docs/ACCES.md. Base en memoire, horloge et hasard injectes (aucune attente reelle), FAUSSE PASSERELLE independante du code teste :
 * elle recalcule elle-meme les chaines canoniques et les signatures (HMAC-SHA256 de la cle decodee), verifie chaque ordre publie et
 * signe ses accuses.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, it } from 'node:test';
import type { DesiredHolder, DesiredSchedule, DesiredState, RightsListener, RightsSource, SyncService, SyncTransport } from '../server/accessholderstypes.ts';
import { createSync, HOLIDAYS_PER_MESSAGE, holderBody, MAX_MESSAGE_BYTES, migrateSync, retryDelayMs } from '../server/accesssync.ts';
import { openDb } from '../server/db.ts';
import { PsimError } from '../server/errors.ts';
import { unseal } from '../server/secrets.ts';

const S = 1000;
const MIN = 60 * S;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 17, 8, 0, 0);
const SECRET = randomBytes(32);

// ---- Fausse passerelle et banc d'essai ---------------------------------------------------------------------------------------

interface Envelope {
  v: number;
  opId: string;
  seq: number;
  ts: number;
  body: string;
  sig: string;
}
interface Sent {
  c: string;
  payload: string;
  msg: Envelope;
  body: Record<string, any>;
  sigOk: boolean;
  bytes: number;
}
interface Audit {
  actor: string;
  action: string;
  details?: string;
  deviceId?: string;
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key: Buffer, s: string): string => createHmac('sha256', key).update(s, 'utf8').digest('hex');
/** Chaines canoniques RECALCULEES ici, independamment du code teste. */
const orderSig = (key: Buffer, c: string, m: { opId: string; seq: number; ts: number; body: string }): string =>
  hmac(key, `psim-sync-v1|${c}|${m.opId}|${m.seq}|${m.ts}|${sha256(m.body)}`);
function ackJson(key: Buffer, c: string, m: { opId: string; seq: number }, result: string, code: string | null = null, ts = 0): string {
  const sig = hmac(key, `psim-sync-ack-v1|${c}|${m.opId}|${m.seq}|${result}|${code ?? ''}|${ts}`);
  return JSON.stringify({ v: 1, opId: m.opId, seq: m.seq, result, code, ts, sig });
}

class FakeRights implements RightsSource {
  ids: string[] = [];
  states = new Map<string, DesiredState>();
  listeners: RightsListener[] = [];
  fail = false;
  controllerIds(): string[] {
    return [...this.ids];
  }
  desired(c: string): DesiredState {
    if (this.fail) throw new Error('droits illisibles');
    return structuredClone(this.states.get(c) ?? { holders: [], schedules: [], holidays: [] });
  }
  subscribe(l: RightsListener): void {
    this.listeners.push(l);
  }
  set(c: string, s: Partial<DesiredState>): void {
    this.states.set(c, { holders: [], schedules: [], holidays: [], ...s });
  }
  emit(ids: string[]): void {
    for (const l of this.listeners) l(ids);
  }
}

let db: DatabaseSync;
let rights: FakeRights;
let sync: SyncService;
let sent: Sent[];
let audits: Audit[];
let t: number;
let transportReady: boolean;
let autoAnswer: boolean;
let keys: Map<string, Buffer>;
let answered: Set<string>;
let counter: number;

/** Hasard deterministe (opId, cles) : sha256 d'un compteur. */
function rb(n: number): Buffer {
  counter++;
  return createHash('sha256').update(`hasard-${counter}`).digest().subarray(0, n);
}

function build(): SyncService {
  const transport: SyncTransport = {
    publish(c, payload) {
      if (!transportReady) return false;
      const msg = JSON.parse(payload) as Envelope;
      const key = keys.get(c);
      const s: Sent = { c, payload, msg, body: JSON.parse(msg.body), sigOk: !!key && msg.sig === orderSig(key, c, msg), bytes: Buffer.byteLength(payload, 'utf8') };
      sent.push(s);
      if (autoAnswer) answer(s, 'done');
      return true;
    },
  };
  return createSync({
    db,
    now: () => t,
    key: SECRET,
    audit: (actor, action, ref) => audits.push({ actor, action, details: ref?.details, deviceId: ref?.deviceId }),
    rights,
    transport,
    randomBytes: rb,
  });
}

function addController(id: string, name = `Controleur ${id}`): void {
  db.prepare('INSERT INTO access_controller (id, name, brand, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, name, 'dahua', T0, 'admin', T0, 'admin');
  rights.ids.push(id);
}

function setup(controllers: string[] = ['CTL-1']): void {
  db = openDb(':memory:');
  rights = new FakeRights();
  sent = [];
  audits = [];
  t = T0;
  transportReady = true;
  autoAnswer = false;
  keys = new Map();
  answered = new Set();
  counter = 0;
  for (const c of controllers) addController(c);
  sync = build();
}

/** Cree ou renouvelle la cle ; la passerelle la « recopie dans sa configuration ». */
function issue(c = 'CTL-1'): string {
  const r = sync.issueKey('admin', c);
  keys.set(c, Buffer.from(r.key, 'hex'));
  return r.key;
}

const lastSent = (c = 'CTL-1'): Sent | undefined => sent.filter((s) => s.c === c).at(-1);
const pending = (c = 'CTL-1'): Sent | undefined => {
  const s = lastSent(c);
  return s && !answered.has(s.msg.opId) ? s : undefined;
};
const typesOf = (c = 'CTL-1'): string[] => sent.filter((s) => s.c === c).map((s) => s.body.type as string);
const refsOf = (c = 'CTL-1'): string[] => sent.filter((s) => s.c === c).map((s) => (s.body.holderRef ?? s.body.scheduleRef ?? 'holidays') as string);

/** La passerelle repond a un message (signature de l'ordre verifiee, accuse signe avec la meme cle). */
function answer(s: Sent, result: 'done' | 'refused' | 'error', code: string | null = null) {
  assert.ok(s.sigOk, `ordre mal signe (seq ${s.msg.seq})`);
  answered.add(s.msg.opId);
  return sync.receiveAck(s.c, ackJson(keys.get(s.c)!, s.c, s.msg, result, code, t));
}

/** Repond « done » a tout ce qui est en vol, jusqu'a la fin de la file. */
function drain(c = 'CTL-1', max = 100_000): number {
  let n = 0;
  for (let p = pending(c); p && n < max; p = pending(c)) {
    const v = answer(p, 'done');
    assert.equal(v.accepted, true);
    n++;
  }
  return n;
}

const advance = (ms: number): void => {
  t += ms;
};

/** Tick puis tout accuser. */
function syncAll(c = 'CTL-1'): number {
  sync.tick();
  return drain(c);
}

const holder = (n: number, over: Partial<DesiredHolder> = {}): DesiredHolder => ({
  ref: `H${n}`,
  name: `NOM${n} Prenom${n}`,
  active: true,
  validFrom: null,
  validTo: null,
  credentials: [`B${n}`],
  doors: [{ doorNo: 1, scheduleRef: 'S1' }],
  ...over,
});
const schedule = (n: number, over: Partial<DesiredSchedule> = {}): DesiredSchedule => ({
  ref: `S${n}`,
  windows: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }],
  holidays: false,
  ...over,
});
const dates = (n: number, from = Date.UTC(2026, 0, 1)): string[] => Array.from({ length: n }, (_, i) => new Date(from + i * 86_400_000).toISOString().slice(0, 10));
const holders = (from: number, to: number): DesiredHolder[] => Array.from({ length: to - from + 1 }, (_, i) => holder(from + i));

/** Contenu de toutes les tables de la base, en texte (pour y chercher un secret). */
function dumpDb(): string {
  const out: string[] = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
    out.push(name, JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()));
  }
  return out.join('\n');
}

const itemRows = (c = 'CTL-1') => db.prepare('SELECT * FROM access_sync_item WHERE controller_id = ? ORDER BY kind, ref').all(c) as any[];
function snapshot(c = 'CTL-1'): string {
  const ctl = db.prepare('SELECT op_id, op_seq, op_ts, op_body, op_attempts, op_sent_at, op_next_at, last_seq, last_ack_at FROM access_sync_controller WHERE controller_id = ?').get(c);
  return JSON.stringify({ items: itemRows(c), ctl, sent: sent.length });
}

// ---- Essais ---------------------------------------------------------------------------------------------------------------------

describe('migration', () => {
  it('est idempotente et cree les quatre tables', () => {
    setup();
    migrateSync(db);
    migrateSync(db);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'access_sync_%'").all() as { name: string }[]).map((r) => r.name).sort();
    assert.deepEqual(names, ['access_sync_controller', 'access_sync_item', 'access_sync_key', 'access_sync_log']);
  });
});

describe('premier envoi', () => {
  beforeEach(() => setup());

  it("envoie tout dans le bon ordre, une operation a la fois, seq 1, 2, 3...", () => {
    rights.set('CTL-1', { holidays: dates(3), schedules: [schedule(2), schedule(1)], holders: [holder(2), holder(1)] });
    issue();
    sync.notify();
    assert.equal(sent.length, 0, 'notify ne publie jamais');
    sync.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.type, 'set_holidays');
    assert.equal(sent[0].msg.seq, 1);
    drain();
    assert.deepEqual(typesOf(), ['set_holidays', 'upsert_schedule', 'upsert_schedule', 'upsert_holder', 'upsert_holder']);
    assert.deepEqual(refsOf(), ['holidays', 'S1', 'S2', 'H1', 'H2']);
    assert.deepEqual(sent.map((s) => s.msg.seq), [1, 2, 3, 4, 5]);
    assert.ok(sent.every((s) => s.sigOk));
    assert.equal(new Set(sent.map((s) => s.msg.opId)).size, 5, 'opId tous differents');
    assert.ok(sent.every((s) => /^[0-9a-f]{32}$/.test(s.msg.opId)));
    const st = sync.status()[0];
    assert.equal(st.state, 'ok');
    assert.deepEqual(st.counts, { synced: 5, pending: 0, failed: 0, blocked: 0 });
    assert.equal(st.lastAckAt, t);
    assert.equal(st.lastProblem, null);
  });

  it("respecte la forme de l'enveloppe et des corps du contrat", () => {
    rights.set('CTL-1', {
      schedules: [schedule(1, { holidays: true })],
      holders: [holder(7, { validFrom: 1000, validTo: 2000, active: false, credentials: ['A1', 'B2'], doors: [{ doorNo: 1, scheduleRef: 'S1' }, { doorNo: 2, scheduleRef: 'S1' }] })],
    });
    issue();
    syncAll();
    for (const s of sent) assert.deepEqual(Object.keys(s.msg), ['v', 'opId', 'seq', 'ts', 'body', 'sig']);
    assert.equal(typeof sent[0].msg.body, 'string');
    assert.equal(sent[0].msg.v, 1);
    assert.equal(sent[0].msg.ts, T0);
    assert.deepEqual(Object.keys(sent[0].body), ['type', 'scheduleRef', 'windows', 'holidays']);
    assert.deepEqual(sent[0].body.windows, [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }]);
    assert.equal(sent[0].body.holidays, true);
    assert.deepEqual(Object.keys(sent[1].body), ['type', 'holderRef', 'name', 'active', 'validFrom', 'validTo', 'credentials', 'doors']);
    assert.deepEqual(sent[1].body, {
      type: 'upsert_holder',
      holderRef: 'H7',
      name: 'NOM7 Prenom7',
      active: false,
      validFrom: 1000,
      validTo: 2000,
      credentials: ['A1', 'B2'],
      doors: [{ doorNo: 1, scheduleRef: 'S1' }, { doorNo: 2, scheduleRef: 'S1' }],
    });
    assert.ok(sent.every((s) => s.bytes <= MAX_MESSAGE_BYTES));
  });

  it('n\'envoie rien sans cle de synchronisation', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1)] });
    sync.start();
    sync.tick();
    advance(HOUR);
    sync.tick();
    assert.equal(sent.length, 0);
    const st = sync.status()[0];
    assert.equal(st.enabled, false);
    assert.equal(st.state, 'disabled');
    assert.equal(st.keyCreatedAt, null);
    assert.equal(st.counts.pending, 2);
    assert.equal(st.hint, "La synchronisation n'est pas activée pour ce contrôleur. Activez-la pour envoyer les titulaires.");
    assert.equal(sync.holderStatus('H1')[0].message, st.hint);
    // Des que la cle existe, tout part au tick suivant (rien n'est perdu).
    issue();
    assert.equal(sent.length, 0, 'issueKey n\'envoie pas');
    sync.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.type, 'upsert_schedule');
  });

  it('une seule operation en vol : pas de suivante tant que la premiere n\'est pas accusee', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1), holder(2)] });
    issue();
    sync.tick();
    for (let i = 0; i < 5; i++) {
      advance(S);
      sync.tick();
    }
    assert.equal(sent.length, 1);
    advance(5 * S); // 10 s apres le premier envoi : renvoi de la MEME operation
    sync.tick();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].msg.opId, sent[0].msg.opId);
    assert.equal(sent[1].msg.seq, 1);
    assert.equal(sent.filter((s) => !answered.has(s.msg.opId)).map((s) => s.msg.opId).filter((v, i, a) => a.indexOf(v) === i).length, 1);
  });

  it('notify ne publie rien et recalcule le voulu ; le tick envoie', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1)] });
    issue();
    sync.notify(['CTL-1']);
    assert.equal(sent.length, 0);
    assert.equal(sync.status()[0].counts.pending, 2);
    sync.tick();
    assert.equal(sent.length, 1);
  });

  it('start() abonne le service aux changements de droits', () => {
    issue();
    sync.start();
    assert.equal(rights.listeners.length, 1);
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1)] });
    rights.emit(['CTL-1']);
    assert.equal(sync.status()[0].counts.pending, 2);
    assert.equal(sent.length, 0);
    rights.emit(['inconnu', 42 as unknown as string]); // ne leve jamais
  });

  it('droits illisibles : l\'etat actuel est conserve, rien n\'est supprime par erreur', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1)] });
    issue();
    syncAll();
    rights.fail = true;
    sync.notify();
    rights.fail = false;
    assert.equal(sync.status()[0].counts.synced, 2);
    assert.equal(itemRows().length, 2);
  });
});

describe('accuses', () => {
  beforeEach(() => {
    setup(['CTL-1', 'CTL-2']);
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1), holder(2)] });
    rights.set('CTL-2', { schedules: [schedule(1)], holders: [holder(3)] });
    issue('CTL-1');
    issue('CTL-2');
    sync.tick();
  });

  it('un accuse juste fait avancer immediatement a l\'operation suivante', () => {
    const p = pending()!;
    t += 400;
    assert.deepEqual(answer(p, 'done'), { accepted: true });
    const next = pending()!;
    assert.notEqual(next.msg.opId, p.msg.opId);
    assert.equal(next.msg.seq, p.msg.seq + 1);
    assert.equal(next.msg.ts, t, 'ts = heure du PSIM a la creation de l\'operation');
    assert.equal(sync.status()[0].lastAckAt, t);
  });

  it('un accuse a signature fausse est ignore sans effet, journal au plus une fois par heure', () => {
    const p = pending()!;
    const before = snapshot();
    const wrongKey = randomBytes(32);
    const forged = ackJson(wrongKey, 'CTL-1', p.msg, 'done');
    assert.deepEqual(sync.receiveAck('CTL-1', forged), { accepted: false, reason: 'signature' });
    assert.equal(snapshot(), before);
    assert.equal(audits.filter((a) => a.action === 'access_sync_ack_invalid').length, 1);
    assert.equal(audits.find((a) => a.action === 'access_sync_ack_invalid')!.actor, 'systeme');
    // Une seconde fois dans l'heure : toujours refuse, pas de nouvelle entree.
    advance(59 * MIN);
    assert.deepEqual(sync.receiveAck('CTL-1', forged), { accepted: false, reason: 'signature' });
    assert.equal(audits.filter((a) => a.action === 'access_sync_ack_invalid').length, 1);
    advance(2 * MIN);
    sync.receiveAck('CTL-1', forged);
    assert.equal(audits.filter((a) => a.action === 'access_sync_ack_invalid').length, 2);
    // Le journal est par controleur : CTL-2 a son propre compteur.
    sync.receiveAck('CTL-2', ackJson(wrongKey, 'CTL-2', pending('CTL-2')!.msg, 'done'));
    assert.equal(audits.filter((a) => a.action === 'access_sync_ack_invalid').length, 3);
    // La vraie operation est toujours en vol et le vrai accuse passe.
    assert.deepEqual(answer(p, 'done'), { accepted: true });
  });

  it('un accuse rejoue est ignore (autre operation en vol, puis file vide)', () => {
    const p = pending()!;
    const raw = ackJson(keys.get('CTL-1')!, 'CTL-1', p.msg, 'done');
    assert.deepEqual(sync.receiveAck('CTL-1', raw), { accepted: true });
    const before = snapshot();
    assert.deepEqual(sync.receiveAck('CTL-1', raw), { accepted: false, reason: 'mismatch' });
    assert.equal(snapshot(), before);
    // Fin de file : plus aucune operation en vol.
    drain('CTL-1');
    assert.equal(pending(), undefined);
    const idle = snapshot();
    assert.deepEqual(sync.receiveAck('CTL-1', raw), { accepted: false, reason: 'no_operation' });
    assert.equal(snapshot(), idle);
    assert.equal(sync.status()[0].state, 'ok');
  });

  it('un accuse tardif apres achevement est ignore', () => {
    const p = pending()!;
    answer(p, 'done');
    drain();
    const late = ackJson(keys.get('CTL-1')!, 'CTL-1', p.msg, 'refused', 'full');
    const before = snapshot();
    assert.equal(sync.receiveAck('CTL-1', late).accepted, false);
    assert.equal(snapshot(), before);
    assert.equal(sync.status()[0].counts.failed, 0);
  });

  it('un accuse d\'un autre controleur ou signe avec une autre cle est ignore', () => {
    const p1 = pending('CTL-1')!;
    const p2 = pending('CTL-2')!;
    const before1 = snapshot('CTL-1');
    const before2 = snapshot('CTL-2');
    // L'accuse authentique de CTL-1 livre sur le canal de CTL-2.
    assert.deepEqual(sync.receiveAck('CTL-2', ackJson(keys.get('CTL-1')!, 'CTL-1', p1.msg, 'done')), { accepted: false, reason: 'signature' });
    // L'accuse de CTL-1 signe avec la cle de CTL-2 : le nom du controleur est dans la chaine signee.
    assert.deepEqual(sync.receiveAck('CTL-2', ackJson(keys.get('CTL-2')!, 'CTL-1', p1.msg, 'done')), { accepted: false, reason: 'signature' });
    // Signature juste de CTL-2 mais pour l'operation de CTL-1 : opId inconnu pour ce controleur.
    assert.deepEqual(sync.receiveAck('CTL-2', ackJson(keys.get('CTL-2')!, 'CTL-2', p1.msg, 'done')), { accepted: false, reason: 'mismatch' });
    assert.equal(snapshot('CTL-1'), before1);
    assert.equal(snapshot('CTL-2'), before2);
    assert.deepEqual(answer(p2, 'done'), { accepted: true });
  });

  it('controleur inconnu ou sans cle : refus sans effet', () => {
    assert.deepEqual(sync.receiveAck('CTL-9', ackJson(randomBytes(32), 'CTL-9', pending()!.msg, 'done')), { accepted: false, reason: 'unknown_controller' });
    assert.deepEqual(sync.receiveAck(42 as unknown as string, '{}'), { accepted: false, reason: 'unknown_controller' });
    assert.deepEqual(sync.receiveAck('a/b#', '{}'), { accepted: false, reason: 'unknown_controller' });
    addController('CTL-3');
    assert.deepEqual(sync.receiveAck('CTL-3', ackJson(randomBytes(32), 'CTL-3', pending()!.msg, 'done')), { accepted: false, reason: 'no_key' });
  });

  it('mauvais opId ou mauvais seq (signature juste) : ignore', () => {
    const p = pending()!;
    const key = keys.get('CTL-1')!;
    const before = snapshot();
    const otherOp = 'f'.repeat(32);
    assert.deepEqual(sync.receiveAck('CTL-1', ackJson(key, 'CTL-1', { opId: otherOp, seq: p.msg.seq }, 'done')), { accepted: false, reason: 'mismatch' });
    assert.deepEqual(sync.receiveAck('CTL-1', ackJson(key, 'CTL-1', { opId: p.msg.opId, seq: p.msg.seq + 1 }, 'done')), { accepted: false, reason: 'mismatch' });
    assert.deepEqual(sync.receiveAck('CTL-1', ackJson(key, 'CTL-1', { opId: p.msg.opId, seq: p.msg.seq - 1 || 99 }, 'done')), { accepted: false, reason: 'mismatch' });
    assert.equal(snapshot(), before);
    assert.deepEqual(answer(p, 'done'), { accepted: true });
  });

  it('JSON hostile, champs invalides, trop gros : refus « format » sans effet et sans exception', () => {
    const p = pending()!;
    const key = keys.get('CTL-1')!;
    const good = JSON.parse(ackJson(key, 'CTL-1', p.msg, 'done'));
    const before = snapshot();
    const hostile: (string | Buffer | unknown)[] = [
      '',
      'null',
      '[]',
      '"texte"',
      '42',
      '{',
      '{"v":1}',
      '{"__proto__":{"v":1},"opId":"x"}',
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, v: '1' }),
      JSON.stringify({ ...good, opId: good.opId.toUpperCase() }),
      JSON.stringify({ ...good, opId: good.opId.slice(1) }),
      JSON.stringify({ ...good, opId: 7 }),
      JSON.stringify({ ...good, seq: '1' }),
      JSON.stringify({ ...good, seq: 0 }),
      JSON.stringify({ ...good, seq: -3 }),
      JSON.stringify({ ...good, seq: 1.5 }),
      JSON.stringify({ ...good, seq: 2 ** 60 }),
      JSON.stringify({ ...good, result: 'ok' }),
      JSON.stringify({ ...good, result: ['done'] }),
      JSON.stringify({ ...good, code: 'full' }), // done avec un code
      JSON.stringify({ ...good, result: 'refused', code: 'autre' }),
      JSON.stringify({ ...good, result: 'refused', code: 'x'.repeat(33) }),
      JSON.stringify({ ...good, result: 'refused', code: 5 }),
      JSON.stringify({ ...good, ts: '12' }),
      JSON.stringify({ ...good, ts: 1.25 }),
      JSON.stringify({ ...good, ts: null }),
      JSON.stringify({ ...good, sig: good.sig.toUpperCase() }),
      JSON.stringify({ ...good, sig: good.sig.slice(2) }),
      JSON.stringify({ ...good, sig: [good.sig] }),
      JSON.stringify({ ...good, sig: undefined }),
      JSON.stringify({ ...good, padding: 'x'.repeat(2100) }),
      Buffer.from([0xff, 0xfe, 0x00, 0x7b]),
      Buffer.alloc(3000, 0x20),
      12345,
      null,
      undefined,
      { v: 1 },
      new Uint8Array([123, 125]),
    ];
    for (const h of hostile) {
      const v = sync.receiveAck('CTL-1', h as string);
      assert.deepEqual(v, { accepted: false, reason: 'format' }, `payload: ${String(h).slice(0, 60)}`);
    }
    assert.equal(snapshot(), before);
    assert.equal(audits.filter((a) => a.action === 'access_sync_ack_invalid').length, 0, 'un accuse mal forme n\'est pas une signature fausse');
    // Un payload Buffer valide passe.
    assert.deepEqual(sync.receiveAck('CTL-1', Buffer.from(JSON.stringify(good), 'utf8')), { accepted: true });
  });

  it('un accuse « error » garde l\'operation en vol : meme attente que l\'absence d\'accuse', () => {
    const p = pending()!;
    const n = sent.length;
    assert.deepEqual(answer(p, 'error', 'io'), { accepted: true });
    assert.equal(sent.length, n, 'rien de nouveau');
    advance(S);
    sync.tick();
    assert.equal(sent.filter((s) => s.c === 'CTL-1').length, 1, 'pas de renvoi avant l\'echeance, pas d\'operation suivante');
    let det = sync.controller('CTL-1');
    assert.equal(det.items[0].state, 'pending');
    assert.equal(det.items[0].code, 'io');
    assert.match(det.items[0].message!, /Nouvel essai automatique/);
    assert.equal(det.lastProblem?.code, 'io');
    advance(10 * S);
    sync.tick();
    const again = lastSent()!;
    assert.equal(again.msg.opId, p.msg.opId);
    answered.delete(p.msg.opId);
    assert.deepEqual(answer(again, 'done'), { accepted: true });
    det = sync.controller('CTL-1');
    assert.equal(det.lastProblem, null);
    assert.ok(!det.items.some((i) => i.code === 'io'));
  });
});

describe('essais, attente croissante et echec visible', () => {
  beforeEach(() => {
    setup();
    rights.set('CTL-1', { schedules: [schedule(1)] });
    issue();
  });

  it('retryDelayMs : 10 s, 20 s, 40 s... plafonne a une heure', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 50, 5000].map(retryDelayMs).map((v) => v / S), [10, 20, 40, 80, 160, 320, 640, 1280, 2560, 3600, 3600, 3600, 3600]);
  });

  it('renvoie la meme operation avec l\'attente 10-20-40... jusqu\'a une heure (horloge avancee)', () => {
    sync.tick();
    let last = t;
    const gaps = [10, 20, 40, 80, 160, 320, 640, 1280, 2560, 3600, 3600, 3600];
    for (const g of gaps) {
      const n = sent.length;
      t = last + g * S - 1;
      sync.tick();
      assert.equal(sent.length, n, `pas de renvoi 1 ms avant ${g} s`);
      t += 1;
      sync.tick();
      assert.equal(sent.length, n + 1, `renvoi a ${g} s`);
      last = t;
    }
    const first = sent[0];
    for (const s of sent) {
      assert.equal(s.msg.opId, first.msg.opId);
      assert.equal(s.msg.seq, 1);
      assert.equal(s.msg.ts, first.msg.ts, 'ts fige a la creation');
      assert.equal(s.msg.body, first.msg.body);
      assert.ok(s.sigOk);
    }
    assert.equal(sent.length, 1 + gaps.length);
  });

  it('echec visible apres 5 essais sans accuse (no_ack), puis retour a « synchronise » quand l\'accuse arrive', () => {
    sync.tick(); // essai 1 a 0 s
    for (const at of [10, 30, 70, 150]) {
      t = T0 + at * S;
      sync.tick();
    }
    assert.equal(sent.length, 5);
    let det = sync.controller('CTL-1');
    assert.equal(det.items[0].state, 'pending');
    assert.equal(det.items[0].attempts, 5);
    assert.equal(det.state, 'pending');
    // L'echeance du 5e essai (160 s plus tard) passe sans accuse : echec, mais les essais continuent.
    t = T0 + 310 * S - 1;
    sync.tick();
    assert.equal(sync.controller('CTL-1').items[0].state, 'pending');
    t = T0 + 310 * S;
    sync.tick();
    assert.equal(sent.length, 6);
    det = sync.controller('CTL-1');
    assert.equal(det.state, 'failed');
    assert.equal(det.items[0].state, 'failed');
    assert.equal(det.items[0].code, 'no_ack');
    assert.equal(det.items[0].message, "La passerelle ne répond pas. Vérifiez qu'elle est allumée, connectée au PSIM et que la clé de synchronisation de ce contrôleur est bien celle du PSIM.");
    assert.equal(det.lastProblem?.code, 'no_ack');
    assert.equal(det.hint, det.items[0].message);
    assert.equal(sync.holderStatus('H1').length, 0);
    assert.equal(audits.filter((a) => a.action === 'access_sync_failed').length, 1);
    // Les essais continuent et ne rejournalisent pas.
    t += 320 * S;
    sync.tick();
    assert.equal(sent.length, 7);
    assert.equal(audits.filter((a) => a.action === 'access_sync_failed').length, 1);
    // L'accuse finit par arriver (la passerelle revient).
    assert.deepEqual(answer(lastSent()!, 'done'), { accepted: true });
    det = sync.controller('CTL-1');
    assert.equal(det.state, 'ok');
    assert.deepEqual(det.items, []);
    assert.equal(det.lastProblem, null);
    assert.equal(sync.status()[0].counts.synced, 1);
  });

  it('une horloge ramenee en arriere ne fige pas l\'envoi', () => {
    sync.tick();
    t = T0 - 5 * HOUR;
    sync.tick();
    assert.equal(sent.length, 2, 'renvoi immediat : l\'echeance est dans un futur impossible');
    assert.equal(sent[1].msg.opId, sent[0].msg.opId);
    // L'echeance suivante repart de l'heure actuelle.
    t += 19 * S; // 2e essai : attente de 20 s
    sync.tick();
    assert.equal(sent.length, 2);
    t += S;
    sync.tick();
    assert.equal(sent.length, 3);
  });

  it('un publish qui renvoie faux n\'est pas compte comme un essai', () => {
    transportReady = false;
    for (let i = 0; i < 20; i++) {
      advance(S);
      sync.tick();
    }
    assert.equal(sent.length, 0);
    let st = sync.status()[0];
    assert.equal(st.transportReady, false);
    assert.equal(st.hint, "Le lien avec la passerelle n'est pas connecté : les changements partiront dès qu'il le sera.");
    let det = sync.controller('CTL-1');
    assert.equal(det.items[0].attempts, 0);
    assert.equal(det.items[0].message, st.hint);
    assert.equal(det.items[0].state, 'pending', 'jamais d\'echec tant qu\'aucun essai n\'est parti');
    // Beaucoup plus tard, le transport revient : l'operation part tout de suite, c'est le PREMIER essai.
    advance(5 * HOUR);
    transportReady = true;
    sync.tick();
    assert.equal(sent.length, 1);
    st = sync.status()[0];
    assert.equal(st.transportReady, true);
    det = sync.controller('CTL-1');
    assert.equal(det.items[0].attempts, 1);
    assert.equal(det.items[0].state, 'pending');
    assert.equal(sent[0].msg.seq, 1, 'seq consomme une seule fois malgre les tentatives');
  });

  it('un renvoi dont le publish echoue ne decale pas l\'echeance et ne compte pas', () => {
    sync.tick();
    transportReady = false;
    advance(10 * S);
    sync.tick();
    advance(S);
    sync.tick();
    assert.equal(sent.length, 1);
    transportReady = true;
    advance(S);
    sync.tick();
    assert.equal(sent.length, 2);
    assert.equal(sync.controller('CTL-1').items[0].attempts, 2);
  });

  it('un accuse arrive PENDANT publish (transport synchrone) : pas de recursion, tout est synchronise', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: holders(1, 300) });
    sync.notify();
    autoAnswer = true;
    sync.tick();
    assert.equal(sent.length, 301);
    assert.deepEqual(sent.map((s) => s.msg.seq), Array.from({ length: 301 }, (_, i) => i + 1));
    const st = sync.status()[0];
    assert.equal(st.state, 'ok');
    assert.equal(st.counts.synced, 301);
    assert.equal(db.prepare('SELECT op_id FROM access_sync_controller').get()!.op_id, null);
  });
});

describe('refus du controleur', () => {
  beforeEach(() => {
    setup();
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1), holder(2)] });
    issue();
    sync.tick();
    drain(); // S1 acquittee ; il reste a envoyer H1 puis H2
  });

  it('refused est definitif pour ce contenu : echec visible, la suite part, pas de renvoi, retry relance', () => {
    // drain() a deja tout accuse ; on refait avec un refus sur H1.
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1, { name: 'AUTRE' }), holder(2, { name: 'AUTRE2' })] });
    sync.notify();
    sync.tick();
    const first = pending()!;
    assert.equal(first.body.holderRef, 'H1');
    assert.deepEqual(answer(first, 'refused', 'full'), { accepted: true });
    // L'operation est liberee et la suivante part tout de suite.
    const second = pending()!;
    assert.equal(second.body.holderRef, 'H2');
    answer(second, 'done');
    // Aucun renvoi de H1, meme des heures plus tard.
    const n = sent.length;
    for (let i = 0; i < 6; i++) {
      advance(HOUR);
      sync.tick();
    }
    assert.equal(sent.length, n);
    const det = sync.controller('CTL-1');
    assert.equal(det.state, 'failed');
    assert.deepEqual(det.counts, { synced: 2, pending: 0, failed: 1, blocked: 0 });
    assert.equal(det.items[0].ref, 'H1');
    assert.equal(det.items[0].code, 'full');
    assert.equal(det.items[0].message, 'La mémoire du contrôleur est pleine : supprimez des titulaires inutiles sur le contrôleur.');
    assert.equal(det.lastProblem?.code, 'full');
    assert.equal(sync.holderStatus('H1')[0].state, 'failed');
    assert.equal(sync.holderStatus('H1')[0].message, det.items[0].message);
    assert.equal(audits.filter((a) => a.action === 'access_sync_failed').length, 1);
    // « Reessayer » : remis en file, envoye aussitot avec une NOUVELLE operation (seq suivant).
    const seqBefore = sent.at(-1)!.msg.seq;
    assert.deepEqual(sync.retry('admin', 'CTL-1'), { requeued: 1 });
    assert.equal(audits.filter((a) => a.action === 'access_sync_retry').length, 1);
    const again = pending()!;
    assert.equal(again.body.holderRef, 'H1');
    assert.equal(again.msg.seq, seqBefore + 1);
    assert.equal(sync.holderStatus('H1')[0].state, 'pending');
    answer(again, 'done');
    assert.equal(sync.status()[0].state, 'ok');
    assert.deepEqual(sync.retry('admin', 'CTL-1'), { requeued: 0 });
    assert.equal(audits.filter((a) => a.action === 'access_sync_retry').length, 1, 'rien a remettre : pas de journal');
  });

  it('un contenu modifie apres un refus est renvoye sans « Reessayer »', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1, { name: 'MAUVAIS' }), holder(2)] });
    sync.notify();
    sync.tick();
    answer(pending()!, 'refused', 'invalid');
    drain();
    assert.equal(sync.holderStatus('H1')[0].state, 'failed');
    assert.equal(sync.holderStatus('H1')[0].message!.startsWith('Le contrôleur a refusé ces données'), true);
    const n = sent.length;
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1, { name: 'BON' }), holder(2)] });
    sync.notify();
    assert.equal(sync.holderStatus('H1')[0].state, 'pending');
    sync.tick();
    assert.equal(sent.length, n + 1);
    assert.equal(lastSent()!.body.name, 'BON');
    drain();
    assert.equal(sync.status()[0].state, 'ok');
  });

  it('refus pour un contenu qui a change depuis l\'envoi : pas d\'echec, le nouveau contenu part', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1, { name: 'V2' }), holder(2)] });
    sync.notify();
    sync.tick();
    const v2 = pending()!;
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1, { name: 'V3' }), holder(2)] });
    sync.notify();
    answer(v2, 'refused', 'invalid');
    assert.equal(sync.status()[0].counts.failed, 0);
    assert.equal(audits.filter((a) => a.action === 'access_sync_failed').length, 0);
    assert.equal(pending()!.body.name, 'V3');
  });

  it('not_supported et invalid : phrases claires', () => {
    rights.set('CTL-1', { schedules: [schedule(1, { holidays: true })], holders: [holder(1), holder(2)] });
    sync.notify();
    sync.tick();
    answer(pending()!, 'refused', 'not_supported');
    assert.equal(sync.controller('CTL-1').items[0].message, 'Ce contrôleur ne sait pas faire cette opération.');
  });

  it('un refus sans code est traite comme « invalid »', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1, { name: 'X' }), holder(2)] });
    sync.notify();
    sync.tick();
    answer(pending()!, 'refused', null);
    assert.equal(sync.controller('CTL-1').items[0].code, 'invalid');
  });
});

describe('redemarrage, modification, suppression', () => {
  beforeEach(() => setup());

  it('reprise apres redemarrage : meme operation (opId, seq, ts, body), essais conserves, seq jamais en arriere', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1), holder(2)] });
    issue();
    sync.start();
    const original = sent[0];
    advance(10 * S);
    sync.tick(); // renvoi 1 : 2 essais
    assert.equal(sent.length, 2);
    advance(20 * S);
    // Redemarrage brutal : nouvelle instance sur la meme base, nouveau transport (la memoire est perdue).
    const before = sent.length;
    sync = build();
    sync.start();
    assert.equal(sent.length, before + 1, 'renvoi a la premiere occasion, sans attendre l\'echeance');
    const resent = lastSent()!;
    assert.equal(resent.msg.opId, original.msg.opId);
    assert.equal(resent.msg.seq, original.msg.seq);
    assert.equal(resent.msg.ts, original.msg.ts);
    assert.equal(resent.msg.body, original.msg.body);
    assert.ok(resent.sigOk);
    assert.equal(sync.controller('CTL-1').items[0].attempts, 3, 'les essais ne sont pas remis a zero');
    assert.equal(sync.status()[0].counts.pending, 3);
    // Suite normale : la nouvelle instance continue la numerotation.
    answer(resent, 'done');
    drain();
    assert.deepEqual(sent.filter((s, i, a) => a.findIndex((x) => x.msg.opId === s.msg.opId) === i).map((s) => s.msg.seq), [1, 2, 3]);
    // Un second redemarrage ne reutilise jamais un seq.
    sync = build();
    sync.start();
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1), holder(2), holder(3)] });
    sync.notify();
    sync.tick();
    assert.equal(lastSent()!.msg.seq, 4);
    assert.equal(lastSent()!.body.holderRef, 'H3');
  });

  it('seq ne regresse pas quand tout est supprime puis recree', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1)] });
    issue();
    syncAll();
    rights.set('CTL-1', {});
    sync.notify();
    syncAll();
    assert.equal(itemRows().length, 0);
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1)] });
    sync.notify();
    syncAll();
    const seqs = sent.map((s) => s.msg.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
    assert.equal(seqs.at(-1), sent.length);
  });

  it('modification pendant un vol : le renvoi garde l\'ancien contenu, le nouveau part apres l\'accuse', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1, { name: 'ANCIEN' })] });
    issue();
    sync.tick();
    drain(); // S1 puis H1 ANCIEN (accuse)
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1, { name: 'V2' })] });
    sync.notify();
    sync.tick();
    const v2 = pending()!;
    assert.equal(v2.body.name, 'V2');
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1, { name: 'V3' })] });
    sync.notify();
    advance(10 * S);
    sync.tick();
    const resent = lastSent()!;
    assert.equal(resent.msg.opId, v2.msg.opId);
    assert.equal(resent.body.name, 'V2', 'l\'operation en vol n\'est pas modifiee');
    assert.equal(sync.holderStatus('H1')[0].state, 'pending');
    answered.delete(v2.msg.opId);
    answer(resent, 'done');
    // Apres l'accuse de V2, H1 n'est pas « synchronise » : V3 est attendu.
    assert.equal(sync.holderStatus('H1')[0].state, 'pending');
    const v3 = pending()!;
    assert.equal(v3.body.name, 'V3');
    assert.equal(v3.msg.seq, v2.msg.seq + 1);
    answer(v3, 'done');
    assert.equal(sync.holderStatus('H1')[0].state, 'synced');
    assert.equal(sync.status()[0].state, 'ok');
  });

  it('modification revenue a l\'etat accuse pendant un vol : renvoyee apres l\'accuse', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1, { name: 'A' })] });
    issue();
    syncAll();
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1, { name: 'B' })] });
    sync.notify();
    sync.tick();
    const b = pending()!;
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1, { name: 'A' })] });
    sync.notify();
    assert.equal(sync.holderStatus('H1')[0].state, 'pending', 'B est en vol : pas « synchronise »');
    answer(b, 'done');
    assert.equal(pending()!.body.name, 'A');
    drain();
    assert.equal(sync.holderStatus('H1')[0].state, 'synced');
  });

  it('suppression d\'un titulaire : delete_holder, puis la ligne disparait', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1), holder(2)] });
    issue();
    syncAll();
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(2)] });
    sync.notify();
    assert.equal(sync.holderStatus('H1')[0].state, 'pending');
    sync.tick();
    assert.deepEqual(pending()!.body, { type: 'delete_holder', holderRef: 'H1' });
    drain();
    assert.equal(sync.holderStatus('H1').length, 0);
    assert.equal(itemRows().length, 2);
    assert.equal(sync.status()[0].state, 'ok');
  });

  it('un titulaire retire avant tout envoi n\'envoie rien du tout', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1)] });
    issue();
    sync.notify();
    rights.set('CTL-1', { schedules: [schedule(1)] });
    sync.notify();
    sync.tick();
    drain();
    assert.deepEqual(refsOf(), ['S1']);
  });

  it('retire pendant un vol d\'envoi : l\'envoi est termine puis le titulaire est supprime', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1)] });
    issue();
    sync.tick();
    answer(pending()!, 'done'); // S1 ; H1 part aussitot
    const up = pending()!;
    assert.equal(up.body.type, 'upsert_holder');
    rights.set('CTL-1', { schedules: [schedule(1)] });
    sync.notify();
    assert.equal(itemRows().length, 2, 'la ligne est gardee tant que l\'envoi peut avoir abouti');
    answer(up, 'done');
    assert.deepEqual(pending()!.body, { type: 'delete_holder', holderRef: 'H1' });
    drain();
    assert.equal(itemRows().length, 1);
  });

  it('une plage n\'est supprimee qu\'apres les titulaires ; ordre general de la file', () => {
    rights.set('CTL-1', { holidays: dates(2), schedules: [schedule(1), schedule(2)], holders: [holder(1), holder(2), holder(3, { doors: [{ doorNo: 1, scheduleRef: 'S2' }] })] });
    issue();
    syncAll();
    const mark = sent.length;
    // Plus rien sauf une nouvelle plage S3 et un nouveau titulaire H4 ; jours feries modifies.
    rights.set('CTL-1', { holidays: dates(3), schedules: [schedule(3)], holders: [holder(4, { doors: [{ doorNo: 1, scheduleRef: 'S3' }] })] });
    sync.notify();
    syncAll();
    const order = sent.slice(mark).map((s) => `${s.body.type}:${s.body.holderRef ?? s.body.scheduleRef ?? ''}`);
    assert.deepEqual(order, [
      'set_holidays:',
      'upsert_schedule:S3',
      'upsert_holder:H4',
      'delete_holder:H1',
      'delete_holder:H2',
      'delete_holder:H3',
      'delete_schedule:S1',
      'delete_schedule:S2',
    ]);
    assert.equal(sync.status()[0].counts.synced, 3);
    assert.equal(itemRows().length, 3);
  });
});

describe('suppressions en masse', () => {
  const removeHolders = (from: number, to: number, keep: DesiredHolder[]): void => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: keep.filter((h) => Number(h.ref.slice(1)) < from || Number(h.ref.slice(1)) > to) });
  };
  const deletes = (): Sent[] => sent.filter((s) => s.body.type === 'delete_holder');
  let all: DesiredHolder[];

  beforeEach(() => {
    setup();
    all = holders(1, 60);
    rights.set('CTL-1', { schedules: [schedule(1)], holders: all });
    issue();
    syncAll(); // 60 titulaires acquittes
    assert.equal(sync.status()[0].counts.synced, 61);
  });

  it('21 d\'un coup : retenues, rien envoye, les autres elements partent, journal une seule fois', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [...all.slice(21), holder(99)] });
    sync.notify();
    sync.notify(['CTL-1']);
    sync.tick();
    drain();
    assert.equal(deletes().length, 0);
    assert.equal(sent.at(-1)!.body.holderRef, 'H99', 'le reste de la file continue');
    let st = sync.status()[0];
    assert.equal(st.state, 'blocked');
    assert.equal(st.counts.blocked, 21);
    assert.equal(st.awaitingConfirmation!.count, 21);
    assert.equal(st.awaitingConfirmation!.refs.length, 20);
    assert.match(st.hint, /21 suppression\(s\) de titulaires attendent la confirmation/);
    assert.equal(sync.holderStatus('H1')[0].state, 'blocked');
    assert.match(sync.holderStatus('H1')[0].message!, /Un administrateur doit la confirmer/);
    const det = sync.controller('CTL-1');
    assert.equal(det.items.length, 21);
    assert.ok(det.items.every((i) => i.state === 'blocked' && i.op === 'delete' && i.kind === 'holder'));
    for (let i = 0; i < 5; i++) {
      advance(10 * MIN);
      sync.tick();
      sync.notify();
    }
    assert.equal(deletes().length, 0, 'meme des heures plus tard');
    assert.equal(audits.filter((a) => a.action === 'access_sync_deletions_held').length, 1);
    assert.equal(audits.find((a) => a.action === 'access_sync_deletions_held')!.actor, 'systeme');
    // Confirmation : liste figee, envoi, journal.
    assert.deepEqual(sync.confirmDeletions('admin', 'CTL-1'), { confirmed: 21 });
    const conf = audits.filter((a) => a.action === 'access_sync_deletions_confirmed');
    assert.equal(conf.length, 1);
    assert.equal(conf[0].actor, 'admin');
    assert.match(conf[0].details!, /^21 suppression\(s\) confirmee\(s\) : H1, /);
    assert.ok(!conf[0].details!.includes('CTL'));
    drain();
    assert.equal(deletes().length, 21);
    assert.deepEqual(deletes().map((d) => d.body.holderRef).sort(), all.slice(0, 21).map((h) => h.ref).sort());
    st = sync.status()[0];
    assert.equal(st.state, 'ok');
    assert.equal(st.awaitingConfirmation, null);
    assert.deepEqual(sync.confirmDeletions('admin', 'CTL-1'), { confirmed: 0 });
    assert.equal(audits.filter((a) => a.action === 'access_sync_deletions_confirmed').length, 1);
  });

  it('20 pile : envoyees sans confirmation', () => {
    removeHolders(1, 20, all);
    sync.notify();
    syncAll();
    assert.equal(deletes().length, 20);
    assert.equal(sync.status()[0].state, 'ok');
    assert.equal(audits.filter((a) => a.action === 'access_sync_deletions_held').length, 0);
  });

  it('cumul sur l\'heure : 15 envoyees puis 6 de plus = 21, les 6 sont retenues ; 5 de plus = 20, envoyees', () => {
    removeHolders(1, 15, all);
    sync.notify();
    syncAll();
    assert.equal(deletes().length, 15);
    advance(30 * MIN);
    removeHolders(1, 21, all);
    sync.notify();
    syncAll();
    assert.equal(deletes().length, 15);
    assert.equal(sync.status()[0].counts.blocked, 6);
    assert.equal(sync.status()[0].state, 'blocked');
    sync.confirmDeletions('admin', 'CTL-1');
    drain();
    assert.equal(deletes().length, 21);
  });

  it('cumul : 15 puis 5 = 20 pile, envoyees', () => {
    removeHolders(1, 15, all);
    sync.notify();
    syncAll();
    advance(30 * MIN);
    removeHolders(1, 20, all);
    sync.notify();
    syncAll();
    assert.equal(deletes().length, 20);
    assert.equal(sync.status()[0].state, 'ok');
  });

  it('les suppressions envoyees il y a plus d\'une heure ne comptent plus', () => {
    removeHolders(1, 15, all);
    sync.notify();
    syncAll();
    advance(HOUR + MIN);
    removeHolders(1, 30, all);
    sync.notify();
    syncAll();
    assert.equal(deletes().length, 30);
    assert.equal(sync.status()[0].counts.blocked, 0);
  });

  it('une suppression confirmee ne compte plus ; la confirmation ne vaut que pour la liste figee', () => {
    removeHolders(1, 21, all);
    sync.notify();
    sync.tick();
    assert.equal(sync.status()[0].counts.blocked, 21);
    sync.confirmDeletions('admin', 'CTL-1');
    const first = pending()!;
    assert.equal(first.body.type, 'delete_holder');
    // Pendant que la premiere est en vol, 21 autres suppressions arrivent : elles, ne sont pas confirmees.
    removeHolders(1, 42, all);
    sync.notify();
    const st = sync.status()[0];
    assert.equal(st.counts.blocked, 21);
    assert.ok(st.awaitingConfirmation!.refs.every((r) => Number(r.slice(1)) > 21));
    drain();
    assert.equal(deletes().length, 21);
    assert.equal(sync.status()[0].counts.blocked, 21);
    assert.equal(audits.filter((a) => a.action === 'access_sync_deletions_held').length, 2, 'le second blocage (apres la confirmation du premier) est journalise a part');
    assert.deepEqual(sync.confirmDeletions('admin', 'CTL-1'), { confirmed: 21 });
    drain();
    assert.equal(deletes().length, 42);
  });

  it('un titulaire retenu puis retabli n\'est plus retenu ni supprime', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: all.slice(21) });
    sync.notify();
    sync.tick();
    assert.equal(sync.status()[0].counts.blocked, 21);
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [all[0], ...all.slice(21)] }); // H1 revient
    sync.notify();
    assert.equal(sync.holderStatus('H1')[0].state, 'synced');
    assert.equal(sync.status()[0].counts.blocked, 20);
    assert.equal(deletes().length, 0);
  });

  it('un second blocage, apres confirmation, est journalise a nouveau', () => {
    removeHolders(1, 21, all);
    sync.notify();
    sync.tick();
    sync.confirmDeletions('admin', 'CTL-1');
    drain();
    advance(2 * HOUR);
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [] });
    sync.notify();
    sync.tick();
    assert.equal(audits.filter((a) => a.action === 'access_sync_deletions_held').length, 2);
  });

  it('seules les suppressions de titulaires sont comptees (pas les mises a jour ni les plages)', () => {
    rights.set('CTL-1', { schedules: [schedule(1), schedule(2)], holders: all.map((h) => holder(Number(h.ref.slice(1)), { name: 'Modifie' })) });
    sync.notify();
    syncAll();
    assert.equal(sync.status()[0].counts.blocked, 0);
    rights.set('CTL-1', { schedules: [schedule(2)], holders: all.map((h) => holder(Number(h.ref.slice(1)), { name: 'Modifie', doors: [{ doorNo: 1, scheduleRef: 'S2' }] })) });
    sync.notify();
    syncAll();
    assert.equal(sync.status()[0].state, 'ok');
  });
});

describe('jours feries', () => {
  beforeEach(() => {
    setup();
    issue();
  });

  it('par morceaux de 40 dates, replace seulement au premier, acquitte apres le dernier', () => {
    rights.set('CTL-1', { holidays: dates(95) });
    sync.notify();
    sync.tick();
    const msgs = (): Sent[] => sent.filter((s) => s.body.type === 'set_holidays');
    assert.equal(msgs().length, 1);
    assert.equal(msgs()[0].body.dates.length, HOLIDAYS_PER_MESSAGE);
    assert.equal(msgs()[0].body.replace, true);
    answer(pending()!, 'done');
    assert.equal(sync.status()[0].counts.pending, 1, 'pas acquitte avant le dernier morceau');
    assert.equal(sync.status()[0].counts.synced, 0);
    answer(pending()!, 'done');
    assert.equal(msgs().length, 3);
    assert.deepEqual(msgs().map((m) => m.body.dates.length), [40, 40, 15]);
    assert.deepEqual(msgs().map((m) => m.body.replace), [true, false, false]);
    assert.deepEqual(msgs().flatMap((m) => m.body.dates), dates(95));
    assert.deepEqual(msgs().map((m) => m.msg.seq), [1, 2, 3]);
    assert.equal(sync.status()[0].state, 'pending');
    answer(pending()!, 'done');
    assert.equal(sync.status()[0].state, 'ok');
    assert.equal(sync.status()[0].counts.synced, 1);
    sync.tick();
    assert.equal(msgs().length, 3);
  });

  it('exactement 40 dates : un seul message', () => {
    rights.set('CTL-1', { holidays: dates(40) });
    sync.notify();
    syncAll();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.dates.length, 40);
    assert.equal(sync.status()[0].state, 'ok');
  });

  it('un renvoi d\'un morceau intermediaire garde son contenu', () => {
    rights.set('CTL-1', { holidays: dates(60) });
    sync.notify();
    sync.tick();
    answer(pending()!, 'done');
    const second = pending()!;
    advance(10 * S);
    sync.tick();
    assert.equal(lastSent()!.msg.opId, second.msg.opId);
    assert.equal(lastSent()!.body.replace, false);
    assert.equal(lastSent()!.body.dates.length, 20);
  });

  it('si le voulu change en cours de route, on repart du morceau 0', () => {
    rights.set('CTL-1', { holidays: dates(95) });
    sync.notify();
    sync.tick();
    answer(pending()!, 'done');
    answer(pending()!, 'done'); // morceaux 0 et 1 accuses, le 2 est en vol
    const inflight = pending()!;
    assert.equal(inflight.body.dates.length, 15);
    rights.set('CTL-1', { holidays: dates(96) });
    sync.notify();
    answer(inflight, 'done');
    assert.equal(sync.status()[0].counts.synced, 0, 'l\'ancienne liste n\'est pas la bonne : toujours en attente');
    const restart = pending()!;
    assert.equal(restart.body.replace, true);
    assert.deepEqual(restart.body.dates, dates(96).slice(0, 40));
    drain();
    const tail = sent.slice(-3).map((s) => s.body.dates.length);
    assert.deepEqual(tail, [40, 40, 16]);
    assert.equal(sync.status()[0].state, 'ok');
  });

  it('un changement apres un morceau accuse (aucun vol) repart aussi du morceau 0', () => {
    rights.set('CTL-1', { holidays: dates(95) });
    sync.notify();
    sync.tick();
    answer(pending()!, 'done'); // le morceau 1 part et reste en vol
    const inflight = pending()!;
    rights.set('CTL-1', { holidays: dates(50, Date.UTC(2027, 0, 1)) });
    sync.notify();
    answer(inflight, 'done');
    const restart = pending()!;
    assert.equal(restart.body.replace, true);
    assert.equal(restart.body.dates[0], '2027-01-01');
  });

  it('liste vide jamais envoyee : aucun envoi', () => {
    rights.set('CTL-1', { holidays: [] });
    sync.notify();
    sync.tick();
    assert.equal(sent.length, 0);
    assert.equal(sync.status()[0].state, 'ok');
    assert.equal(itemRows().length, 0);
  });

  it('liste videe apres un envoi : le controleur est vide avec un set_holidays vide (replace)', () => {
    rights.set('CTL-1', { holidays: dates(3) });
    sync.notify();
    syncAll();
    rights.set('CTL-1', { holidays: [] });
    sync.notify();
    sync.tick();
    assert.deepEqual(pending()!.body, { type: 'set_holidays', dates: [], replace: true });
    drain();
    assert.equal(itemRows().length, 0);
    sync.tick();
    assert.equal(sent.length, 2);
  });

  it('doublons et dates invalides sont ecartes', () => {
    rights.set('CTL-1', { holidays: ['2026-05-01', '2026-05-01', 'n-importe-quoi', '2026-1-1', '2026-12-25'] });
    sync.notify();
    sync.tick();
    assert.deepEqual(sent[0].body.dates, ['2026-05-01', '2026-12-25']);
  });

  it('un refus du premier morceau : echec definitif, retry repart du morceau 0', () => {
    rights.set('CTL-1', { holidays: dates(60) });
    sync.notify();
    sync.tick();
    answer(pending()!, 'done');
    answer(pending()!, 'refused', 'invalid');
    assert.equal(sync.controller('CTL-1').items[0].state, 'failed');
    sync.retry('admin', 'CTL-1');
    assert.equal(pending()!.body.replace, true);
    assert.equal(pending()!.body.dates.length, 40);
  });
});

describe('taille des messages', () => {
  beforeEach(() => {
    setup();
    issue();
  });

  const envelopeBytes = (h: DesiredHolder): number =>
    Buffer.byteLength(JSON.stringify({ v: 1, opId: '0'.repeat(32), seq: 1, ts: T0, body: holderBody(h), sig: '0'.repeat(64) }), 'utf8');
  const CTRL = ''; // 7 octets une fois echappe deux fois dans l'enveloppe

  /** Titulaire dont l'enveloppe (seq 1) fait exactement `target` octets : un nom de 64 caracteres melant ASCII, accents et caracteres de controle. */
  function holderOfSize(target: number): DesiredHolder | null {
    for (let k = 0; k <= 64; k++) {
      for (let e = 0; e + k <= 64; e++) {
        const name = CTRL.repeat(k) + 'é'.repeat(e) + 'a'.repeat(64 - k - e);
        const h = holder(1, { name, credentials: ['A'.repeat(32), 'B'.repeat(32), 'C'.repeat(32), 'D'.repeat(32)], doors: [1, 2, 3, 4].map((n) => ({ doorNo: n, scheduleRef: 'S1' })) });
        if (envelopeBytes(h) === target) return h;
      }
    }
    return null;
  }

  it('1 024 octets : accepte ; 1 025 : refuse localement', () => {
    const fits = holderOfSize(MAX_MESSAGE_BYTES);
    const over = holderOfSize(MAX_MESSAGE_BYTES + 1);
    assert.ok(fits && over, "titulaires d'essai trouves");
    rights.set('CTL-1', { holders: [fits!] });
    sync.notify();
    sync.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].bytes, MAX_MESSAGE_BYTES);
    assert.ok(sent[0].sigOk);
    drain();
    rights.set('CTL-1', { holders: [over!] });
    sync.notify();
    sync.tick();
    assert.equal(sent.length, 1);
    assert.equal(sync.controller('CTL-1').items[0].code, 'invalid');
    assert.equal(sync.holderStatus('H1')[0].state, 'failed');
  });

  it('message trop gros : « invalid », rien de publie, aucun seq consomme, l’element suivant est tente', () => {
    const big = holder(1, { name: CTRL.repeat(64), credentials: ['A'.repeat(32), 'B'.repeat(32), 'C'.repeat(32), 'D'.repeat(32)], doors: [1, 2, 3, 4].map((n) => ({ doorNo: n, scheduleRef: 'S1' })) });
    assert.ok(envelopeBytes(big) > MAX_MESSAGE_BYTES, `le gabarit doit depasser la limite (${envelopeBytes(big)})`);
    // Des donnees valides ne depassent jamais la limite : le plus gros titulaire possible (4 caracteres de 3 octets, 4 badges, 4 portes) tient.
    const largest = holder(99999, { name: '漢'.repeat(64), validFrom: 1760000000000, validTo: 1760000000000, credentials: ['A'.repeat(32), 'B'.repeat(32), 'C'.repeat(32), 'D'.repeat(32)], doors: [1, 2, 3, 4].map((n) => ({ doorNo: n, scheduleRef: 'S99999' })) });
    assert.ok(envelopeBytes(largest) < MAX_MESSAGE_BYTES);
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [big, holder(2)] });
    sync.notify();
    sync.tick();
    drain();
    assert.deepEqual(refsOf(), ['S1', 'H2']);
    assert.ok(sent.every((s) => s.bytes <= MAX_MESSAGE_BYTES));
    assert.deepEqual(sent.map((s) => s.msg.seq), [1, 2], "aucun seq consomme par l'element refuse");
    const bad = sync.controller('CTL-1');
    assert.equal(bad.state, 'failed');
    const item = bad.items.find((i) => i.ref === 'H1')!;
    assert.equal(item.state, 'failed');
    assert.equal(item.code, 'invalid');
    assert.match(item.message!, /trop volumineux/);
    assert.match(item.message!, /1 024 octets/);
    assert.equal(audits.filter((a) => a.action === 'access_sync_failed').length, 1);
    // Pas de nouvel essai tout seul.
    advance(5 * HOUR);
    sync.tick();
    assert.deepEqual(refsOf(), ['S1', 'H2']);
    // Contenu raccourci : il part.
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1), holder(2)] });
    sync.notify();
    sync.tick();
    assert.equal(lastSent()!.body.holderRef, 'H1');
    assert.equal(lastSent()!.msg.seq, 3);
  });

  it('mesure en octets UTF-8, pas en caracteres', () => {
    // 14 plages ne rentrent pas ; la meme chose en ASCII pur rentre : on verifie surtout que les accents comptent double.
    const name = 'é'.repeat(64);
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1, { name })] });
    sync.notify();
    syncAll();
    const h = sent.find((s) => s.body.type === 'upsert_holder')!;
    assert.equal(h.bytes, Buffer.byteLength(h.payload, 'utf8'));
    assert.ok(h.bytes > h.payload.length);
  });

  it('un nom trop long est tronque a 64 caracteres', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1, { name: 'N'.repeat(200) })] });
    sync.notify();
    syncAll();
    assert.equal(sent.find((s) => s.body.type === 'upsert_holder')!.body.name.length, 64);
  });
});

describe('cle de synchronisation', () => {
  beforeEach(() => {
    setup(['CTL-1', 'CTL-2']);
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1), holder(2)] });
  });

  it('issueKey : 64 caracteres hexadecimaux, scellee en base, renouvellement signale, journal sans secret', () => {
    const a = sync.issueKey('admin', 'CTL-1');
    assert.match(a.key, /^[0-9a-f]{64}$/);
    assert.equal(a.renewed, false);
    assert.equal(a.createdAt, T0);
    const sealed = (db.prepare('SELECT sealed FROM access_sync_key WHERE controller_id = ?').get('CTL-1') as { sealed: string }).sealed;
    assert.ok(sealed.startsWith('v1:'));
    assert.equal(unseal(SECRET, sealed), a.key);
    advance(S);
    const b = sync.issueKey('admin', 'CTL-1');
    assert.equal(b.renewed, true);
    assert.notEqual(b.key, a.key);
    assert.deepEqual(audits.filter((x) => x.action === 'access_sync_key_issued').map((x) => x.details), ['cle creee', 'cle renouvelee']);
    assert.ok(audits.every((x) => x.deviceId === undefined));
    assert.equal(sync.status().find((s) => s.controllerId === 'CTL-1')!.keyCreatedAt, T0 + S);
  });

  it('controleur inconnu ou identifiant hostile : 404 « Contrôleur introuvable »', () => {
    for (const bad of ['CTL-9', '', '../etc', 'CTL-1; DROP TABLE x', 42 as unknown as string, 'x'.repeat(200)]) {
      for (const f of [() => sync.issueKey('admin', bad), () => sync.confirmDeletions('admin', bad), () => sync.retry('admin', bad), () => sync.controller(bad)]) {
        assert.throws(f, (e: unknown) => e instanceof PsimError && e.status === 404 && e.message === 'Contrôleur introuvable');
      }
    }
    assert.equal(audits.length, 0);
  });

  it('renouvellement : l\'ancienne signature est refusee, la nouvelle acceptee, l\'operation en vol est re-signee, seq continue', () => {
    const oldKey = issue();
    sync.tick();
    const p = pending()!;
    assert.equal(p.msg.seq, 1);
    const newKey = issue(); // renouvellement
    assert.notEqual(newKey, oldKey);
    // Un accuse signe avec l'ancienne cle est refuse...
    const before = snapshot();
    const oldAck = ackJson(Buffer.from(oldKey, 'hex'), 'CTL-1', p.msg, 'done');
    assert.deepEqual(sync.receiveAck('CTL-1', oldAck), { accepted: false, reason: 'signature' });
    assert.equal(snapshot(), before);
    // ... le renvoi est signe avec la nouvelle cle : meme opId, seq, ts, body.
    advance(10 * S);
    sync.tick();
    const resent = lastSent()!;
    assert.equal(resent.msg.opId, p.msg.opId);
    assert.equal(resent.msg.seq, 1);
    assert.equal(resent.msg.body, p.msg.body);
    assert.notEqual(resent.msg.sig, p.msg.sig);
    assert.equal(resent.msg.sig, orderSig(Buffer.from(newKey, 'hex'), 'CTL-1', resent.msg));
    assert.notEqual(resent.msg.sig, orderSig(Buffer.from(oldKey, 'hex'), 'CTL-1', resent.msg));
    // ... l'accuse signe avec la nouvelle passe, et la numerotation continue.
    assert.deepEqual(answer(resent, 'done'), { accepted: true });
    assert.equal(pending()!.msg.seq, 2);
    assert.ok(pending()!.sigOk);
  });

  it('la cle n\'apparait jamais : ni dans les vues, ni dans les messages, ni dans le journal, ni en clair dans la base', () => {
    const k1 = issue('CTL-1');
    const k2 = issue('CTL-2');
    const k1b = issue('CTL-1'); // renouvellement
    rights.set('CTL-2', { schedules: [schedule(1)], holders: [holder(5)] });
    sync.start();
    syncAll('CTL-1');
    syncAll('CTL-2');
    sync.receiveAck('CTL-1', ackJson(randomBytes(32), 'CTL-1', { opId: 'a'.repeat(32), seq: 1 }, 'done'));
    sync.retry('admin', 'CTL-1');
    sync.confirmDeletions('admin', 'CTL-1');
    const views = JSON.stringify([sync.status(), sync.controller('CTL-1'), sync.controller('CTL-2'), sync.holderStatus('H1'), sync.holderStatus('H5')]);
    const messages = sent.map((s) => s.payload).join('\n');
    const journal = JSON.stringify(audits);
    const base = dumpDb();
    for (const [nom, texte] of Object.entries({ views, messages, journal, base })) {
      for (const k of [k1, k2, k1b]) {
        assert.ok(!texte.includes(k), `la cle apparait dans : ${nom}`);
        assert.ok(!texte.includes(Buffer.from(k, 'hex').toString('base64')), `la cle (base64) apparait dans : ${nom}`);
        assert.ok(!texte.toLowerCase().includes(k.slice(0, 24)), `un fragment de cle apparait dans : ${nom}`);
      }
    }
    assert.ok(base.includes('access_sync_key'), 'la base a bien ete parcourue');
    // Pas non plus de signature en base (recalculee a chaque envoi).
    for (const s of sent) assert.ok(!base.includes(s.msg.sig));
  });

  it('le journal ne contient jamais d\'identifiant de controleur, de nom ni de numero de badge', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: holders(1, 30) });
    issue('CTL-1');
    syncAll();
    rights.set('CTL-1', { schedules: [schedule(1)] });
    sync.notify();
    sync.tick();
    sync.confirmDeletions('admin', 'CTL-1');
    answer(pending()!, 'refused', 'full');
    advance(HOUR);
    sync.receiveAck('CTL-1', ackJson(randomBytes(32), 'CTL-1', { opId: 'a'.repeat(32), seq: 1 }, 'done'));
    sync.retry('admin', 'CTL-1');
    assert.ok(audits.length >= 5);
    const texte = JSON.stringify(audits);
    assert.ok(!/CTL-/.test(texte), 'identifiant de controleur dans le journal');
    assert.ok(!/NOM\d|Prenom|\bB\d+\b/.test(texte), 'nom ou badge dans le journal');
    assert.ok(audits.every((a) => a.deviceId === undefined));
  });

  it('une cle illisible (cle du serveur changee) arrete l\'envoi et le dit', () => {
    issue('CTL-1');
    const other = createSync({ db, now: () => t, key: randomBytes(32), audit: () => {}, rights, transport: { publish: () => true }, randomBytes: rb });
    const st = other.status().find((s) => s.controllerId === 'CTL-1')!;
    assert.equal(st.enabled, true);
    assert.equal(st.state, 'failed');
    assert.match(st.hint, /illisible/);
    other.notify();
    other.tick();
    assert.deepEqual(other.receiveAck('CTL-1', '{}'), { accepted: false, reason: 'no_key' });
  });
});

describe('vues et etats', () => {
  beforeEach(() => {
    setup(['CTL-1', 'CTL-2']);
  });

  it('etats par controleur et par titulaire', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1), holder(2)] });
    rights.set('CTL-2', { schedules: [schedule(1)], holders: [holder(1)] });
    issue('CTL-1');
    sync.notify();
    const status = sync.status();
    assert.deepEqual(status.map((s) => s.controllerId), ['CTL-1', 'CTL-2']);
    assert.equal(status[0].controllerName, 'Controleur CTL-1');
    assert.equal(status[0].state, 'pending');
    assert.equal(status[1].state, 'disabled');
    assert.equal(status[1].hint, "La synchronisation n'est pas activée pour ce contrôleur. Activez-la pour envoyer les titulaires.");
    // H1 est attendu sur deux controleurs.
    assert.deepEqual(sync.holderStatus('H1').map((v) => [v.controllerId, v.controllerName, v.state]), [
      ['CTL-1', 'Controleur CTL-1', 'pending'],
      ['CTL-2', 'Controleur CTL-2', 'pending'],
    ]);
    assert.deepEqual(sync.holderStatus('H2').map((v) => v.controllerId), ['CTL-1']);
    assert.deepEqual(sync.holderStatus('H404'), []);
    assert.deepEqual(sync.holderStatus(null as unknown as string), []);
    syncAll('CTL-1');
    assert.equal(sync.holderStatus('H1').find((v) => v.controllerId === 'CTL-1')!.state, 'synced');
    assert.equal(sync.holderStatus('H1').find((v) => v.controllerId === 'CTL-1')!.message, null);
    assert.equal(sync.holderStatus('H1').find((v) => v.controllerId === 'CTL-2')!.state, 'pending');
    assert.equal(sync.status()[0].state, 'ok');
    assert.equal(sync.status()[0].hint, 'Le contrôleur est à jour.');
  });

  it('un controleur sans titulaire attendu est « ok » avec une phrase claire', () => {
    issue('CTL-1');
    sync.notify();
    const st = sync.status()[0];
    assert.equal(st.state, 'ok');
    assert.match(st.hint, /Rien à envoyer/);
  });

  it('l\'etat agrege : bloque l\'emporte sur echec, qui l\'emporte sur attente', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: holders(1, 30) });
    issue('CTL-1');
    syncAll();
    // 21 retenues + un refus + une attente.
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(30, { name: 'M' }), holder(40)] });
    sync.notify();
    sync.tick();
    answer(pending()!, 'refused', 'invalid'); // H30 (ou H40) refuse
    assert.equal(sync.status()[0].state, 'blocked');
    assert.equal(sync.status()[0].counts.blocked, 29);
    assert.equal(sync.status()[0].counts.failed, 1);
    sync.confirmDeletions('admin', 'CTL-1');
    drain();
    assert.equal(sync.status()[0].state, 'failed');
    sync.retry('admin', 'CTL-1');
    assert.equal(sync.status()[0].state, 'pending');
  });

  it('le detail classe les elements les plus graves d\'abord, 200 au plus', () => {
    rights.set('CTL-1', { schedules: [schedule(1)], holders: holders(1, 250) });
    issue('CTL-1');
    sync.notify();
    let det = sync.controller('CTL-1');
    assert.equal(det.items.length, 200);
    assert.equal(det.counts.pending, 251);
    assert.equal(det.items[0].kind, 'schedule', 'plages avant titulaires dans l\'ordre d\'envoi');
    syncAll();
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(300), ...holders(100, 109)] });
    sync.notify();
    sync.tick();
    det = sync.controller('CTL-1');
    assert.equal(det.items[0].state, 'blocked');
    assert.ok(det.items.slice(0, 200).every((i, k, a) => k === 0 || ['blocked', 'failed', 'pending'].indexOf(a[k - 1].state) <= ['blocked', 'failed', 'pending'].indexOf(i.state)));
    assert.equal(det.awaitingConfirmation!.refs.length, 20);
  });

  it('controller() renvoie 404 pour un controleur inconnu', () => {
    assert.throws(() => sync.controller('CTL-9'), (e: unknown) => e instanceof PsimError && e.status === 404);
  });
});

describe('controleur supprime', () => {
  beforeEach(() => {
    setup(['CTL-1', 'CTL-2']);
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [holder(1)] });
    rights.set('CTL-2', { schedules: [schedule(1)], holders: [holder(2)] });
    issue('CTL-1');
    issue('CTL-2');
    sync.tick();
  });

  const rows = (c: string): number =>
    ['access_sync_key', 'access_sync_controller', 'access_sync_item', 'access_sync_log'].reduce(
      (n, tbl) => n + (db.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE controller_id = ?`).get(c) as { n: number }).n,
      0,
    );

  it('notify(): un controleur disparu perd toutes ses lignes ; l\'autre est intact', () => {
    assert.ok(rows('CTL-1') > 0);
    rights.ids = ['CTL-2'];
    sync.notify(['CTL-1']);
    assert.equal(rows('CTL-1'), 0);
    assert.ok(rows('CTL-2') > 0);
    assert.deepEqual(sync.status().map((s) => s.controllerId), ['CTL-2']);
    assert.throws(() => sync.controller('CTL-1'), PsimError);
    assert.deepEqual(sync.holderStatus('H1'), []);
    // Plus aucun envoi ni accuse accepte pour lui.
    const n = sent.length;
    advance(HOUR);
    sync.tick();
    assert.ok(sent.slice(n).every((s) => s.c === 'CTL-2'));
    assert.deepEqual(sync.receiveAck('CTL-1', ackJson(keys.get('CTL-1')!, 'CTL-1', sent[0].msg, 'done')), { accepted: false, reason: 'unknown_controller' });
  });

  it('notify() sans argument et tick() rattrapent aussi', () => {
    rights.ids = ['CTL-2'];
    sync.notify();
    assert.equal(rows('CTL-1'), 0);
    // Via le tick, au plus tard 30 s apres.
    rights.ids = ['CTL-1', 'CTL-2'];
    sync.notify(['CTL-1']);
    sync.tick();
    assert.ok(rows('CTL-1') > 0);
    rights.ids = ['CTL-2'];
    advance(31 * S);
    sync.tick();
    assert.equal(rows('CTL-1'), 0);
  });

  it('recree avec le meme identifiant : repart de zero, sans l\'ancienne cle', () => {
    rights.ids = ['CTL-2'];
    sync.notify(['CTL-1']);
    rights.ids = ['CTL-1', 'CTL-2'];
    sync.notify();
    assert.equal(sync.status()[0].enabled, false);
    const n = sent.length;
    sync.tick();
    assert.equal(sent.length, n, 'rien n\'est envoye sans cle');
  });
});

describe('journal des operations', () => {
  it('garde les 200 dernieres lignes par controleur (plus toutes celles de l\'heure), sans cle ni corps', () => {
    setup();
    rights.set('CTL-1', { schedules: [schedule(1)], holders: holders(1, 250) });
    issue();
    syncAll();
    const count = (): number => (db.prepare('SELECT COUNT(*) AS n FROM access_sync_log').get() as { n: number }).n;
    assert.equal(count(), 251, 'toutes les operations de la derniere heure sont gardees (la regle des 20 en depend)');
    advance(2 * HOUR);
    rights.set('CTL-1', { schedules: [schedule(1)], holders: [...holders(1, 250), holder(900)] });
    sync.notify();
    syncAll();
    assert.equal(count(), 200);
    const row = db.prepare('SELECT * FROM access_sync_log ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    assert.deepEqual(Object.keys(row).sort(), ['at', 'confirmed', 'controller_id', 'id', 'kind', 'op', 'ref', 'result', 'seq']);
    assert.equal(row.result, 'done');
    assert.equal(row.ref, 'H900');
  });
});
