/**
 * Pilote de synchronisation des titulaires (gateway/src/accesssync.ts) : les regles a-f du recepteur (docs/CONTROLE-ACCES.md,
 * par. 7), une par une, avec horloge et planificateur FACTICES (aucune attente reelle) ; vecteurs canoniques FIXES (a reprendre
 * tels quels par l'equipe PSIM) ; fichier d'etat (persistance, redemarrage, corruption) ; puis `ctx.onAccessSync` dans le vrai
 * socle (startRuntime) avec un module d'essai ecrit dans un dossier temporaire (aucun broker joignable : les ordres sont remis
 * directement au pilote).
 *
 * Le « faux PSIM » de ce fichier signe et verifie avec node:crypto, sans rien reprendre du code de la passerelle.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  MAX_SYNC_BODY_BYTES,
  MAX_SYNC_BYTES,
  SYNC_QUEUE_MAX,
  buildSyncAck,
  createAccessSyncPilot,
  keyId,
  parseSyncOrder,
  syncAckCanonical,
  syncOrderCanonical,
} from '../src/accesssync.ts';
import type { AccessSyncPilot } from '../src/accesssync.ts';
import type { Scheduler } from '../src/actuators.ts';
import { loadConfig } from '../src/config.ts';
import type { AccessSyncHandler, AccessSyncOp, ActuatorOutcome } from '../src/module.ts';
import { ACCESS_SYNC_STATE_FILE, startRuntime } from '../src/runtime.ts';
import { freePort, memoryLogger, tempDir, waitFor, writeConfig } from './helpers.ts';

const cleanup: (() => unknown)[] = [];
after(async () => {
  for (const f of cleanup.reverse()) await f();
});

/** Cle des vecteurs (la meme que docs/COMMANDES.md 5.3). */
const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const KEY2 = '1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100';
const T0 = 1_760_000_000_000;
const OPID = '0123456789abcdef0123456789abcdef';

// ------------------------------------------------------------------------------------------------------------------
// Faux PSIM : signature et verification INDEPENDANTES (node:crypto seulement)
// ------------------------------------------------------------------------------------------------------------------

const hmac = (keyHex: string, text: string) => createHmac('sha256', Buffer.from(keyHex, 'hex')).update(text, 'utf8').digest('hex');
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

interface PsimOrder {
  opId: string;
  seq: number;
  ts: number;
  body: string;
}

function psimSign(keyHex: string, controllerId: string, o: PsimOrder): string {
  const canonical = `psim-sync-v1|${controllerId}|${o.opId}|${o.seq}|${o.ts}|${sha256(o.body)}`;
  return JSON.stringify({ v: 1, opId: o.opId, seq: o.seq, ts: o.ts, body: o.body, sig: hmac(keyHex, canonical) });
}

interface PsimAck {
  opId: string;
  seq: number;
  result: string;
  code: string | null;
  ts: number;
}

/** Ce que le PSIM fera d'un accuse : champs exacts, signature recalculee et comparee en temps constant ; null = rejete. */
function psimVerifyAck(keyHex: string, controllerId: string, raw: string): PsimAck | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const keys = Object.keys(m).sort().join(',');
  if (keys !== 'code,opId,result,seq,sig,ts,v' || m.v !== 1) return null;
  if (typeof m.opId !== 'string' || typeof m.seq !== 'number' || typeof m.result !== 'string' || typeof m.ts !== 'number' || typeof m.sig !== 'string') return null;
  if (m.code !== null && typeof m.code !== 'string') return null;
  const canonical = `psim-sync-ack-v1|${controllerId}|${m.opId}|${m.seq}|${m.result}|${m.code ?? ''}|${m.ts}`;
  const expected = Buffer.from(hmac(keyHex, canonical), 'hex');
  const given = Buffer.from(m.sig, 'hex');
  if (given.length !== 32 || !timingSafeEqual(expected, given)) return null;
  return { opId: m.opId, seq: m.seq, result: m.result, code: m.code as string | null, ts: m.ts };
}

// ------------------------------------------------------------------------------------------------------------------
// Banc d'essai : horloge et planificateur factices, accuses captures et verifies par le faux PSIM
// ------------------------------------------------------------------------------------------------------------------

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r));
};

let opCounter = 0;
const nextOpId = () => (++opCounter).toString(16).padStart(32, '0');

const deleteHolder = (ref = 'H101') => JSON.stringify({ type: 'delete_holder', holderRef: ref });
const upsertHolder = () =>
  JSON.stringify({ type: 'upsert_holder', holderRef: 'H101', name: 'KONAN Yao', active: true, validFrom: null, validTo: null, credentials: ['0012345'], doors: [{ doorNo: 1, scheduleRef: null }] });

interface Deferred {
  promise: Promise<ActuatorOutcome>;
  resolve: (o: ActuatorOutcome) => void;
  reject: (e: unknown) => void;
}
function deferred(): Deferred {
  let resolve!: (o: ActuatorOutcome) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<ActuatorOutcome>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function bench(over: { stateFile?: string | null; handlerTimeoutMs?: number; stopWaitMs?: number; startAt?: number; keys?: Record<string, string> } = {}) {
  const clock = { t: over.startAt ?? T0 };
  const timers = new Set<Timer>();
  let tseq = 0;
  const schedule: Scheduler = (fn, ms) => {
    const t: Timer = { at: clock.t + ms, seq: tseq++, fn };
    timers.add(t);
    return () => void timers.delete(t);
  };
  const logger = memoryLogger();
  const keys: Record<string, string> = { 'CTL-1': KEY, 'CTL-2': KEY2, ...over.keys };
  const acks: { id: string; ack: PsimAck; raw: string }[] = [];
  const net = { up: true, throws: false, published: 0 };
  const pilot: AccessSyncPilot = createAccessSyncPilot({
    log: logger,
    now: () => clock.t,
    schedule,
    stateFile: over.stateFile ?? null,
    handlerTimeoutMs: over.handlerTimeoutMs,
    stopWaitMs: over.stopWaitMs,
    publishAck: async (id, raw) => {
      net.published++;
      if (net.throws) throw new Error('liaison en panne');
      if (!net.up) return false;
      const ack = psimVerifyAck(keys[id] as string, id, raw);
      assert.ok(ack, `accuse rejete par le faux PSIM : ${raw}`);
      acks.push({ id, ack, raw });
      return true;
    },
  });
  async function advance(ms: number): Promise<void> {
    const end = clock.t + ms;
    for (;;) {
      await flush();
      const due = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      timers.delete(due);
      clock.t = Math.max(clock.t, due.at);
      due.fn();
    }
    clock.t = end;
    await flush();
  }
  const h = {
    clock,
    pilot,
    logger,
    acks,
    net,
    timers,
    advance,
    /** Ordre signe par le faux PSIM. */
    order(o: { id?: string; key?: string; opId?: string; seq: number; ts?: number; body?: string }): string {
      const id = o.id ?? 'CTL-1';
      return psimSign(o.key ?? keys[id] ?? KEY, id, { opId: o.opId ?? nextOpId(), seq: o.seq, ts: o.ts ?? clock.t, body: o.body ?? deleteHolder() });
    },
    send: (id: string, msg: string | Buffer) => pilot.handleMessage(id, typeof msg === 'string' ? Buffer.from(msg, 'utf8') : msg),
    /** Envoie puis laisse passer les promesses (aucune attente reelle). */
    async deliver(id: string, msg: string | Buffer): Promise<void> {
      void h.send(id, msg);
      await flush();
    },
    /** Enregistre un gestionnaire qui garde ses appels ; `behavior` peut etre change en cours d'essai. */
    attach(id = 'CTL-1', key?: string) {
      const rec = {
        calls: [] as AccessSyncOp[],
        concurrent: 0,
        maxConcurrent: 0,
        behavior: (async () => ({ result: 'done' })) as (op: AccessSyncOp) => Promise<ActuatorOutcome> | ActuatorOutcome,
        off: () => undefined as void,
      };
      const handler: AccessSyncHandler = async (op) => {
        rec.calls.push(op);
        rec.concurrent++;
        rec.maxConcurrent = Math.max(rec.maxConcurrent, rec.concurrent);
        try {
          return await rec.behavior(op);
        } finally {
          rec.concurrent--;
        }
      };
      rec.off = pilot.register(id, key ?? keys[id] ?? KEY, handler);
      return rec;
    },
    text: () => logger.lines.map((l) => `${l.level} ${l.text}`).join('\n'),
  };
  return h;
}

// ------------------------------------------------------------------------------------------------------------------
describe('synchronisation : vecteurs canoniques FIXES (a reprendre par le PSIM)', () => {
  // Cle 000102...1f, controleur CTL-1, opId 0123456789abcdef0123456789abcdef, ts de l'ordre 1760000000000, ts de l'accuse 1760000000400.
  const VECTORS = [
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
    { seq: 42, result: 'done' as const, code: null, canonical: 'psim-sync-ack-v1|CTL-1|0123456789abcdef0123456789abcdef|42|done||1760000000400', sig: 'a0b4c9e76d5561568d6a334fcda8f7091fe7ce0aeee5203b031a4147ad069899' },
    { seq: 43, result: 'refused' as const, code: 'invalid', canonical: 'psim-sync-ack-v1|CTL-1|0123456789abcdef0123456789abcdef|43|refused|invalid|1760000000400', sig: '510b4e07be71561efef4596dae80c09d29ae0e30ea50e52ef305988bd8aedf59' },
    { seq: 44, result: 'error' as const, code: 'unreachable', canonical: 'psim-sync-ack-v1|CTL-1|0123456789abcdef0123456789abcdef|44|error|unreachable|1760000000400', sig: '4809267e3614e645384979b48a262197b8946b59e9b538eac4c3bed8871a733a' },
  ];

  it('ordres : chaine canonique, empreinte du corps et HMAC de reference', () => {
    for (const v of VECTORS) {
      const canonical = `psim-sync-v1|CTL-1|${OPID}|${v.seq}|1760000000000|${v.sha}`;
      assert.equal(syncOrderCanonical('CTL-1', { opId: OPID, seq: v.seq, ts: 1_760_000_000_000, body: v.body }), canonical);
      assert.equal(sha256(v.body), v.sha, 'empreinte calculee independamment');
      assert.equal(hmac(KEY, canonical), v.sig, 'HMAC calcule independamment');
      const msg = psimSign(KEY, 'CTL-1', { opId: OPID, seq: v.seq, ts: 1_760_000_000_000, body: v.body });
      assert.deepEqual(parseSyncOrder(msg), { opId: OPID, seq: v.seq, ts: 1_760_000_000_000, body: v.body, sig: v.sig });
    }
  });

  it('accuses : chaine canonique, HMAC de reference et JSON exact', () => {
    for (const a of ACKS) {
      const ack = { opId: OPID, seq: a.seq, result: a.result, code: a.code, ts: 1_760_000_000_400 };
      assert.equal(syncAckCanonical('CTL-1', ack), a.canonical);
      assert.equal(hmac(KEY, a.canonical), a.sig);
      const raw = buildSyncAck(KEY, 'CTL-1', ack);
      assert.equal(raw, `{"v":1,"opId":"${OPID}","seq":${a.seq},"result":"${a.result}","code":${a.code === null ? 'null' : `"${a.code}"`},"ts":1760000000400,"sig":"${a.sig}"}`);
      assert.deepEqual(psimVerifyAck(KEY, 'CTL-1', raw), ack);
    }
  });

  it("l'ordre n'est pas un accuse (prefixes differents) ; un autre controleur ne verifie pas", () => {
    const can = syncOrderCanonical('CTL-1', { opId: OPID, seq: 1, ts: 1, body: '{}' });
    assert.ok(can.startsWith('psim-sync-v1|') && !can.startsWith('psim-sync-ack-v1|'));
    const raw = buildSyncAck(KEY, 'CTL-1', { opId: OPID, seq: 1, result: 'done', code: null, ts: 5 });
    assert.equal(psimVerifyAck(KEY, 'CTL-2', raw), null);
    assert.equal(psimVerifyAck(KEY2, 'CTL-1', raw), null);
  });

  it("empreinte de cle du fichier d'etat : 16 hexadecimaux, non reversible, stable", () => {
    assert.equal(keyId(KEY), 'af00c1e1cf340d69');
    assert.equal(keyId(KEY), hmac(KEY, 'psim-sync-state-v1').slice(0, 16));
    assert.notEqual(keyId(KEY2), keyId(KEY));
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe('synchronisation : regle a (formats) = ignorer SANS accuser ni consommer le seq', () => {
  const sign = (o: Record<string, unknown>, key = KEY) => {
    const can = `psim-sync-v1|CTL-1|${o.opId}|${o.seq}|${o.ts}|${sha256(String(o.body))}`;
    return { ...o, sig: hmac(key, can) };
  };
  const good = () => ({ v: 1, opId: nextOpId(), seq: 5, ts: T0, body: deleteHolder() });

  it('chaque champ mal forme : aucun accuse, aucun appel du module ; le seq reste libre', async () => {
    const h = bench();
    const rec = h.attach();
    const hostile: unknown[] = [
      'pas du json',
      '[]',
      'null',
      '42',
      '"texte"',
      {},
      { ...sign(good()), extra: 1 },
      { ...sign(good()), __proto__x: 1 },
      (() => {
        const o = sign(good()) as Record<string, unknown>;
        delete o.ts;
        return o;
      })(),
      { ...sign(good()), v: 2 },
      { ...sign(good()), v: '1' },
      sign({ ...good(), opId: 'ABCDEF0123456789abcdef0123456789' }),
      sign({ ...good(), opId: 'abc' }),
      sign({ ...good(), opId: `${'a'.repeat(32)}0` }),
      sign({ ...good(), seq: 0 }),
      sign({ ...good(), seq: -1 }),
      sign({ ...good(), seq: 1.5 }),
      sign({ ...good(), seq: '5' }),
      sign({ ...good(), seq: 2 ** 53 }),
      sign({ ...good(), ts: 0 }),
      sign({ ...good(), ts: -5 }),
      sign({ ...good(), ts: 1.5 }),
      sign({ ...good(), ts: null }),
      { ...sign(good()), body: { type: 'delete_holder' } },
      sign({ ...good(), body: 'x'.repeat(MAX_SYNC_BODY_BYTES + 1) }),
      { ...sign(good()), sig: sign(good()).sig.toUpperCase() },
      { ...sign(good()), sig: 'ab' },
      { ...sign(good()), sig: 5 },
    ];
    for (const raw of hostile) await h.send('CTL-1', typeof raw === 'string' ? raw : JSON.stringify(raw));
    // __proto__ litteral dans le JSON (cle propre, pas le prototype) : champ en trop.
    const withProto = JSON.stringify(sign(good())).replace(/^\{/, '{"__proto__":{"seq":1},');
    await h.send('CTL-1', withProto);
    await h.send('CTL-1', Buffer.alloc(0));
    await flush();
    assert.equal(h.acks.length, 0);
    assert.equal(h.net.published, 0);
    assert.equal(rec.calls.length, 0);
    assert.equal(h.pilot.stats().ignored, hostile.length + 2);
    // Le seq 5 n'a pas ete consomme.
    await h.send('CTL-1', h.order({ seq: 5 }));
    assert.equal(rec.calls.length, 1);
    assert.equal(h.acks.length, 1);
  });

  it('taille : corps de 800 octets lu ; message de plus de 1024 octets ignore ; UTF-8 casse et BOM ignores', async () => {
    const h = bench();
    const rec = h.attach();
    rec.behavior = () => ({ result: 'refused', code: 'invalid' });
    const head = '{"type":"delete_holder","holderRef":"H1","pad":"';
    const body800 = `${head}${'p'.repeat(MAX_SYNC_BODY_BYTES - head.length - 2)}"}`;
    assert.equal(Buffer.byteLength(body800), MAX_SYNC_BODY_BYTES);
    const ok = h.order({ seq: 1, body: body800 });
    assert.ok(Buffer.byteLength(ok) <= MAX_SYNC_BYTES, String(Buffer.byteLength(ok)));
    await h.send('CTL-1', ok);
    assert.equal(rec.calls.length, 1, '800 octets de corps : lu');
    // Corps de 800 octets plein de guillemets : une fois echappe, le message depasse 1024 octets.
    const quoted = h.order({ seq: 2, body: `{"type":"delete_holder","x":"${'\\"'.repeat(380)}"}` });
    assert.ok(Buffer.byteLength(quoted) > MAX_SYNC_BYTES);
    await h.send('CTL-1', quoted);
    const broken = Buffer.from(h.order({ seq: 3 }), 'utf8');
    const bad = Buffer.concat([broken.subarray(0, 40), Buffer.from([0xc3, 0x28]), broken.subarray(40)]);
    await h.send('CTL-1', bad);
    await h.send('CTL-1', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(h.order({ seq: 4 }))]));
    await flush();
    assert.equal(rec.calls.length, 1);
    assert.equal(h.acks.length, 1);
    assert.equal(h.pilot.stats().ignored, 3);
  });

  it('formats ignores comptes et journalises au plus une fois par minute', async () => {
    const h = bench();
    h.attach();
    for (let i = 0; i < 30; i++) await h.send('CTL-1', 'nul');
    assert.equal(h.logger.lines.filter((l) => /mal forme/.test(l.text)).length, 1);
    h.clock.t += 60_000;
    await h.send('CTL-1', 'nul');
    const lines = h.logger.lines.filter((l) => /mal forme/.test(l.text));
    assert.equal(lines.length, 2);
    assert.match(lines[1]!.text, /CTL-1 : 30 ordre/);
    assert.equal(lines[1]!.level, 'warn');
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe('synchronisation : regle b (signature) = ignorer SANS accuser, sans oracle', () => {
  it('un bit, autre cle, autre controleur, champ modifie apres signature : ignore, rien ne change', async () => {
    const h = bench();
    const rec = h.attach();
    const base = JSON.parse(h.order({ seq: 7, opId: OPID })) as Record<string, unknown>;
    const flip = (s: string) => (s[0] === '0' ? '1' : '0') + s.slice(1);
    const variants = [
      { ...base, sig: flip(base.sig as string) },
      JSON.parse(h.order({ seq: 7, opId: OPID, key: KEY2 })),
      JSON.parse(h.order({ id: 'CTL-2', key: KEY, seq: 7, opId: OPID })),
      { ...base, seq: 8 },
      { ...base, ts: (base.ts as number) + 1 },
      { ...base, opId: OPID.replace(/0/, '1') },
      { ...base, body: deleteHolder('H102') },
    ];
    for (const v of variants) await h.send('CTL-1', JSON.stringify(v));
    assert.equal(h.acks.length, 0);
    assert.equal(rec.calls.length, 0);
    assert.equal(h.pilot.stats().ignored, variants.length);
    // Le seq 7 et l'opId restent utilisables par le vrai ordre.
    await h.send('CTL-1', JSON.stringify(base));
    assert.equal(rec.calls.length, 1);
    assert.equal(h.acks[0]!.ack.seq, 7);
  });

  it('signature « presque bonne » et entierement fausse : indiscernables (aucun accuse, meme fichier d\'etat, meme promesse)', async (t) => {
    const dir = tempDir(cleanup);
    const stateFile = join(dir, 'etat.json');
    const h = bench({ stateFile });
    h.attach();
    await h.send('CTL-1', h.order({ seq: 1 }));
    const before = readFileSync(stateFile, 'utf8');
    const base = JSON.parse(h.order({ seq: 2 })) as Record<string, string>;
    const almost = { ...base, sig: base.sig!.slice(0, 63) + (base.sig!.endsWith('0') ? '1' : '0') };
    const wrong = { ...base, sig: 'f'.repeat(64) };
    const outA = await h.send('CTL-1', JSON.stringify(almost));
    const outB = await h.send('CTL-1', JSON.stringify(wrong));
    assert.equal(outA, undefined);
    assert.equal(outB, undefined);
    assert.equal(h.acks.length, 1, 'seul le premier ordre (valide) est accuse');
    assert.equal(readFileSync(stateFile, 'utf8'), before, 'fichier d\'etat inchange');
    t.diagnostic('aucune difference observable depuis le broker');
  });

  it('signatures fausses comptees, journalisees au plus une fois par minute, sans la signature', async () => {
    const h = bench();
    h.attach();
    const msgs: string[] = [];
    for (let i = 0; i < 10; i++) {
      const m = JSON.parse(h.order({ seq: 1 })) as Record<string, string>;
      m.sig = 'e'.repeat(63) + String(i % 10);
      msgs.push(m.sig);
      await h.send('CTL-1', JSON.stringify(m));
    }
    const lines = h.logger.lines.filter((l) => /signature fausse/.test(l.text));
    assert.equal(lines.length, 1);
    for (const s of msgs) assert.equal(h.text().includes(s), false);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe('synchronisation : regle c (anti-rejeu par seq)', () => {
  it('meme ordre rejoue : pas de nouvel appel, accuse REEMIS signe avec un ts frais et le meme resultat', async () => {
    const h = bench();
    const rec = h.attach();
    rec.behavior = () => ({ result: 'refused', code: 'full' });
    const msg = h.order({ seq: 3 });
    await h.send('CTL-1', msg);
    h.clock.t += 2500;
    await h.send('CTL-1', msg);
    h.clock.t += 2500;
    await h.send('CTL-1', msg);
    assert.equal(rec.calls.length, 1);
    assert.equal(h.acks.length, 3);
    assert.deepEqual(h.acks.map((a) => [a.ack.seq, a.ack.result, a.ack.code, a.ack.ts]), [
      [3, 'refused', 'full', T0],
      [3, 'refused', 'full', T0 + 2500],
      [3, 'refused', 'full', T0 + 5000],
    ]);
    assert.notEqual(h.acks[0]!.raw, h.acks[1]!.raw, 'signature refaite');
    assert.equal(h.pilot.stats().reacked, 2);
    assert.equal(h.pilot.stats().refused, 1, 'les reemissions ne sont pas des operations');
  });

  it('seq ancien, ou egal avec un autre opId : ignore sans accuse ; un saut de seq est permis', async () => {
    const h = bench();
    const rec = h.attach();
    await h.send('CTL-1', h.order({ seq: 10, opId: OPID }));
    await h.send('CTL-1', h.order({ seq: 9 }));
    await h.send('CTL-1', h.order({ seq: 1 }));
    await h.send('CTL-1', h.order({ seq: 10 }));
    assert.equal(rec.calls.length, 1);
    assert.equal(h.acks.length, 1);
    assert.equal(h.pilot.stats().replayed, 3);
    await h.send('CTL-1', h.order({ seq: 500 }));
    assert.equal(rec.calls.length, 2);
    await h.send('CTL-1', h.order({ seq: 10, opId: OPID }));
    assert.equal(h.acks.length, 2, 'l\'ancien seq 10 n\'est meme plus reaccuse : seul le dernier seq l\'est');
  });

  it('renvoi d\'une operation encore en cours : ignore ; UN seul accuse a la fin', async () => {
    const h = bench();
    const rec = h.attach();
    const d = deferred();
    rec.behavior = () => d.promise;
    const msg = h.order({ seq: 1 });
    await h.deliver('CTL-1', msg);
    await h.deliver('CTL-1', msg);
    await h.deliver('CTL-1', msg);
    assert.equal(rec.calls.length, 1);
    assert.equal(h.acks.length, 0);
    d.resolve({ result: 'done' });
    await flush();
    assert.equal(h.acks.length, 1);
    assert.equal(h.acks[0]!.ack.result, 'done');
    await h.send('CTL-1', msg);
    assert.equal(h.acks.length, 2, 'termine : reaccuse');
    assert.equal(rec.calls.length, 1);
  });

  it('les seq sont propres a chaque controleur', async () => {
    const h = bench();
    const r1 = h.attach('CTL-1');
    const r2 = h.attach('CTL-2');
    await h.send('CTL-1', h.order({ seq: 50 }));
    await h.send('CTL-2', h.order({ id: 'CTL-2', seq: 1 }));
    assert.equal(r1.calls.length, 1);
    assert.equal(r2.calls.length, 1);
    assert.deepEqual(h.acks.map((a) => [a.id, a.ack.seq]), [['CTL-1', 50], ['CTL-2', 1]]);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe('synchronisation : regle d (aucun gestionnaire)', () => {
  it('controleur connu sans module : error/unreachable, seq NON consomme ; au retour du module, la meme operation passe', async () => {
    const h = bench();
    const rec = h.attach();
    rec.off();
    assert.equal(h.pilot.hasHandler('CTL-1'), false);
    assert.deepEqual(h.pilot.ids(), ['CTL-1'], 'la cle reste connue : abonnement garde');
    const msg = h.order({ seq: 4 });
    await h.send('CTL-1', msg);
    await h.send('CTL-1', msg);
    assert.deepEqual(h.acks.map((a) => [a.ack.result, a.ack.code]), [['error', 'unreachable'], ['error', 'unreachable']]);
    assert.equal(rec.calls.length, 0);
    const back = h.attach();
    await h.send('CTL-1', msg);
    assert.equal(back.calls.length, 1);
    assert.deepEqual([h.acks[2]!.ack.result, h.acks[2]!.ack.code], ['done', null]);
    assert.equal(h.pilot.stats().unreachable, 2);
  });

  it('gestionnaire retire pendant que l\'operation attend son tour : unreachable, sans resultat (le renvoi l\'execute)', async () => {
    const h = bench();
    const rec = h.attach();
    const d = deferred();
    rec.behavior = () => d.promise;
    await h.deliver('CTL-1', h.order({ seq: 1 }));
    const second = h.order({ seq: 2 });
    await h.deliver('CTL-1', second);
    rec.off();
    d.resolve({ result: 'done' });
    await flush();
    assert.deepEqual(h.acks.map((a) => [a.ack.seq, a.ack.result, a.ack.code]), [
      [1, 'done', null],
      [2, 'error', 'unreachable'],
    ]);
    const again = h.attach();
    await h.send('CTL-1', second);
    assert.equal(again.calls.length, 1);
    assert.equal(h.acks.at(-1)!.ack.result, 'done');
  });

  it('controleur jamais enregistre (aucune cle) : ignore, journalise une fois par minute', async () => {
    const h = bench();
    for (let i = 0; i < 5; i++) await h.send('CTL-9', h.order({ id: 'CTL-9', seq: 1 }));
    assert.equal(h.acks.length, 0);
    assert.equal(h.logger.lines.filter((l) => /sans cle enregistree/.test(l.text)).length, 1);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe('synchronisation : regle e (corps, execution par le module)', () => {
  it('le module recoit { ...corps, opId, seq } fige, opId et seq de l\'ORDRE', async () => {
    const h = bench();
    const rec = h.attach();
    await h.send('CTL-1', h.order({ seq: 9, opId: OPID, body: upsertHolder() }));
    assert.equal(rec.calls.length, 1);
    const op = rec.calls[0]!;
    assert.equal(op.opId, OPID);
    assert.equal(op.seq, 9);
    assert.equal(op.type, 'upsert_holder');
    assert.equal((op as { name?: string }).name, 'KONAN Yao');
    assert.ok(Object.isFrozen(op));
  });

  it('corps illisible, sans type, type non texte, ou portant opId / seq : refused/invalid, seq consomme, module jamais appele', async () => {
    const h = bench();
    const rec = h.attach();
    const bodies = ['pas du json', '[]', 'null', '"x"', '{}', '{"type":5}', '{"type":"delete_holder","opId":"aa"}', '{"type":"delete_holder","seq":1}'];
    let seq = 0;
    for (const body of bodies) {
      const msg = h.order({ seq: ++seq, body });
      await h.send('CTL-1', msg);
      await h.send('CTL-1', msg); // rejoue : accuse reemis, toujours sans appel
    }
    assert.equal(rec.calls.length, 0);
    assert.equal(h.acks.length, bodies.length * 2);
    assert.ok(h.acks.every((a) => a.ack.result === 'refused' && a.ack.code === 'invalid'));
    assert.equal(h.pilot.stats().refused, bodies.length);
  });

  it('type inconnu mais texte : transmis au module (qui le refuse lui-meme)', async () => {
    const h = bench();
    const rec = h.attach();
    rec.behavior = () => ({ result: 'refused', code: 'not_supported' });
    await h.send('CTL-1', h.order({ seq: 1, body: '{"type":"frobnicate"}' }));
    assert.equal(rec.calls.length, 1);
    assert.deepEqual([h.acks[0]!.ack.result, h.acks[0]!.ack.code], ['refused', 'not_supported']);
  });

  it('une operation a la fois par controleur, dans l\'ordre d\'arrivee ; les controleurs ne s\'attendent pas', async () => {
    const h = bench();
    const r1 = h.attach('CTL-1');
    const r2 = h.attach('CTL-2');
    const pending: Deferred[] = [];
    r1.behavior = () => {
      const d = deferred();
      pending.push(d);
      return d.promise;
    };
    for (let s = 1; s <= 3; s++) await h.deliver('CTL-1', h.order({ seq: s }));
    await h.send('CTL-2', h.order({ id: 'CTL-2', seq: 1 }));
    assert.equal(r2.calls.length, 1, 'CTL-2 n\'attend pas CTL-1');
    assert.equal(r1.calls.length, 1);
    for (let i = 0; i < 3; i++) {
      pending[i]!.resolve({ result: 'done' });
      await flush();
    }
    assert.deepEqual(r1.calls.map((c) => c.seq), [1, 2, 3]);
    assert.equal(r1.maxConcurrent, 1);
    assert.deepEqual(h.acks.filter((a) => a.id === 'CTL-1').map((a) => a.ack.seq), [1, 2, 3]);
  });

  it(`file bornee a ${SYNC_QUEUE_MAX} : au-dela, ignore sans accuse NI consommation du seq`, async () => {
    const h = bench();
    const rec = h.attach();
    const d = deferred();
    rec.behavior = () => d.promise;
    for (let s = 1; s <= SYNC_QUEUE_MAX; s++) await h.deliver('CTL-1', h.order({ seq: s }));
    const extra = h.order({ seq: SYNC_QUEUE_MAX + 1 });
    await h.deliver('CTL-1', extra);
    assert.equal(h.pilot.stats().ignored, 1);
    rec.behavior = async () => ({ result: 'done' });
    d.resolve({ result: 'done' });
    await flush();
    assert.equal(h.acks.length, SYNC_QUEUE_MAX);
    await h.send('CTL-1', extra);
    assert.equal(h.acks.length, SYNC_QUEUE_MAX + 1, 'le seq ignore reste utilisable');
    assert.equal(h.acks.at(-1)!.ack.seq, SYNC_QUEUE_MAX + 1);
  });

  it('delai depasse (300 s par defaut) : error/timeout ; reponse tardive ignoree ; l\'operation suivante passe', async () => {
    const h = bench();
    const rec = h.attach();
    const d = deferred();
    rec.behavior = () => d.promise;
    const first = h.order({ seq: 1 });
    await h.deliver('CTL-1', first);
    await h.deliver('CTL-1', h.order({ seq: 2 }));
    await h.advance(299_999);
    assert.equal(h.acks.length, 0);
    rec.behavior = async () => ({ result: 'done' });
    await h.advance(1);
    assert.deepEqual(h.acks.map((a) => [a.ack.seq, a.ack.result, a.ack.code]), [
      [1, 'error', 'timeout'],
      [2, 'done', null],
    ]);
    d.resolve({ result: 'done' });
    await flush();
    assert.equal(h.acks.length, 2, 'reponse tardive : aucun second accuse');
    assert.match(h.text(), /CTL-1 : synchronisation delete_holder seq 1 \(op [0-9a-f]{8}\) -> error \(timeout\)/);
  });

  it('delai parametrable', async () => {
    const h = bench({ handlerTimeoutMs: 1000 });
    const rec = h.attach();
    rec.behavior = () => new Promise(() => undefined);
    await h.deliver('CTL-1', h.order({ seq: 1 }));
    await h.advance(1000);
    assert.deepEqual([h.acks[0]!.ack.result, h.acks[0]!.ack.code], ['error', 'timeout']);
  });

  it('exception (synchrone ou rejet) : error/io ; le texte de l\'exception n\'est jamais journalise', async () => {
    const h = bench();
    const rec = h.attach();
    rec.behavior = () => {
      throw new Error('KONAN Yao 0012345');
    };
    await h.send('CTL-1', h.order({ seq: 1 }));
    rec.behavior = () => Promise.reject(new TypeError('badge 0012345'));
    await h.send('CTL-1', h.order({ seq: 2 }));
    rec.behavior = () => Promise.reject('chaine brute 0012345');
    await h.send('CTL-1', h.order({ seq: 3 }));
    assert.deepEqual(h.acks.map((a) => [a.ack.result, a.ack.code]), [['error', 'io'], ['error', 'io'], ['error', 'io']]);
    assert.equal(/KONAN|0012345/.test(h.text()), false, h.text());
    assert.match(h.text(), /exception \(TypeError\)/);
  });

  it('resultat hors contrat : error/io ; codes conformes transmis tels quels', async () => {
    const h = bench();
    const rec = h.attach();
    const cases: [unknown, string, string | null][] = [
      [null, 'error', 'io'],
      [undefined, 'error', 'io'],
      ['done', 'error', 'io'],
      [{ result: 'ok' }, 'error', 'io'],
      [{ result: 'done', code: 'Pas Bon' }, 'error', 'io'],
      [{ result: 'done', code: 5 }, 'error', 'io'],
      [{ result: 'refused', code: 'x'.repeat(33) }, 'error', 'io'],
      [{ result: 'done' }, 'done', null],
      [{ result: 'done', code: null }, 'done', null],
      [{ result: 'refused', code: 'full' }, 'refused', 'full'],
      [{ result: 'error', code: 'unreachable' }, 'error', 'unreachable'],
    ];
    let seq = 0;
    for (const [out] of cases) {
      rec.behavior = () => out as ActuatorOutcome;
      await h.send('CTL-1', h.order({ seq: ++seq }));
    }
    assert.deepEqual(h.acks.map((a) => [a.ack.result, a.ack.code]), cases.map(([, r, c]) => [r, c]));
  });

  it('accuse non remis (liaison coupee, exception) : perdu, compte, jamais retente ; le renvoi du PSIM obtient l\'accuse', async () => {
    const h = bench();
    const rec = h.attach();
    h.net.up = false;
    const msg = h.order({ seq: 1 });
    await h.send('CTL-1', msg);
    h.net.up = true;
    h.net.throws = true;
    await h.send('CTL-1', h.order({ seq: 2 }));
    assert.equal(h.pilot.stats().acksLost, 2);
    assert.equal(h.net.published, 2, 'aucun nouvel essai');
    h.net.throws = false;
    await h.send('CTL-1', msg);
    assert.equal(h.acks.length, 0, 'seq 1 n\'est plus le dernier : ignore');
    const last = h.order({ seq: 3 });
    h.net.up = false;
    await h.send('CTL-1', last);
    h.net.up = true;
    await h.send('CTL-1', last);
    assert.equal(rec.calls.length, 3);
    assert.equal(h.acks.length, 1);
    assert.equal(h.acks[0]!.ack.seq, 3);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("synchronisation : fichier d'etat (persistance, redemarrage)", () => {
  it("seq ecrit AVANT l'execution ; contenu sans cle, nom, badge ni corps ; ecriture atomique", async () => {
    const dir = tempDir(cleanup);
    const stateFile = join(dir, 'etat.json');
    const h = bench({ stateFile });
    const rec = h.attach();
    let seenDuring: unknown = null;
    rec.behavior = () => {
      seenDuring = JSON.parse(readFileSync(stateFile, 'utf8'));
      return { result: 'done' };
    };
    await h.send('CTL-1', h.order({ seq: 12, opId: OPID, body: upsertHolder() }));
    assert.deepEqual((seenDuring as { controllers: unknown }).controllers, { 'CTL-1': { seq: 12, opId: OPID, result: null, code: null, kid: keyId(KEY) } });
    const saved = readFileSync(stateFile, 'utf8');
    assert.deepEqual(JSON.parse(saved).controllers, { 'CTL-1': { seq: 12, opId: OPID, result: 'done', code: null, kid: keyId(KEY) } });
    assert.equal(JSON.parse(saved).v, 1);
    assert.equal(/KONAN|0012345|H101|upsert/.test(saved), false);
    assert.equal(saved.includes(KEY), false);
    assert.equal(existsSync(`${stateFile}.tmp`), false);
  });

  it('redemarrage : seq ancien refuse, dernier reaccuse avec le resultat persiste, suivant execute', async () => {
    const dir = tempDir(cleanup);
    const stateFile = join(dir, 'etat.json');
    const h1 = bench({ stateFile });
    const r1 = h1.attach();
    r1.behavior = () => ({ result: 'refused', code: 'full' });
    const m5 = h1.order({ seq: 5 });
    await h1.send('CTL-1', h1.order({ seq: 4 }));
    await h1.send('CTL-1', m5);
    await h1.pilot.stop();
    const h2 = bench({ stateFile });
    const r2 = h2.attach();
    await h2.send('CTL-1', h1.order({ seq: 4 }));
    await h2.send('CTL-1', m5);
    await h2.send('CTL-1', h2.order({ seq: 6 }));
    assert.equal(r2.calls.length, 1);
    assert.deepEqual(h2.acks.map((a) => [a.ack.seq, a.ack.result, a.ack.code]), [
      [5, 'refused', 'full'],
      [6, 'done', null],
    ]);
  });

  it("arret pendant une execution : sans resultat ; au redemarrage, le renvoi de la MEME operation est execute de nouveau", async () => {
    const dir = tempDir(cleanup);
    const stateFile = join(dir, 'etat.json');
    const h1 = bench({ stateFile, stopWaitMs: 2000 });
    const r1 = h1.attach();
    r1.behavior = () => new Promise(() => undefined);
    const msg = h1.order({ seq: 30 });
    await h1.deliver('CTL-1', msg);
    const stopping = h1.pilot.stop();
    await h1.advance(2000);
    await stopping;
    assert.match(h1.text(), /1 operation\(s\) de synchronisation non terminee\(s\)/);
    assert.equal(h1.acks.length, 0);
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).controllers['CTL-1'].result, null);
    // Apres l'arret : plus rien n'est traite par l'ancien pilote.
    await h1.send('CTL-1', h1.order({ seq: 31 }));
    assert.equal(r1.calls.length, 1);
    const h2 = bench({ stateFile });
    const r2 = h2.attach();
    await h2.send('CTL-1', msg);
    assert.equal(r2.calls.length, 1, 'operation interrompue : reexecutee (idempotente)');
    assert.equal(h2.acks[0]!.ack.result, 'done');
    await h2.send('CTL-1', msg);
    assert.equal(r2.calls.length, 1, 'puis reaccusee seulement');
  });

  it("arret : l'operation qui finit dans le delai est accusee ; aucun ordre accepte apres l'arret", async () => {
    const h = bench({ stopWaitMs: 5000 });
    const rec = h.attach();
    const d = deferred();
    rec.behavior = () => d.promise;
    await h.deliver('CTL-1', h.order({ seq: 1 }));
    const stopping = h.pilot.stop();
    await h.deliver('CTL-1', h.order({ seq: 2 }));
    d.resolve({ result: 'done' });
    await flush();
    await stopping;
    assert.deepEqual(h.acks.map((a) => a.ack.seq), [1]);
    assert.equal(rec.calls.length, 1);
    assert.throws(() => h.pilot.register('CTL-3', KEY, async () => ({ result: 'done' })), /arretee/);
  });

  it('fichier absent : depart a vide sans bruit ; illisible, corrompu, de mauvaise version : depart a vide avec avertissement', async () => {
    const dir = tempDir(cleanup);
    const quiet = bench({ stateFile: join(dir, 'absent.json') });
    assert.equal(quiet.logger.lines.length, 0);
    for (const [content, re] of [
      ['{ pas du json', /corrompu/],
      ['', /corrompu/],
      ['{"v":2,"controllers":{}}', /version inconnue/],
      ['[1,2]', /version inconnue/],
    ] as const) {
      const f = join(dir, `etat-${Math.random().toString(16).slice(2)}.json`);
      writeFileSync(f, content);
      const h = bench({ stateFile: f });
      assert.match(h.text(), re);
      assert.match(h.text(), /repartie a vide/);
      const rec = h.attach();
      await h.send('CTL-1', h.order({ seq: 1 }));
      assert.equal(rec.calls.length, 1);
    }
    const asDir = join(dir, 'dossier');
    mkdirSync(asDir);
    const h = bench({ stateFile: asDir });
    assert.match(h.text(), /illisible/);
  });

  it('fichier hostile : entrees invalides ignorees (__proto__, seq enormes, opId faux, resultat inconnu), jamais de plantage', async () => {
    const dir = tempDir(cleanup);
    const f = join(dir, 'etat.json');
    const good = { seq: 7, opId: OPID, result: 'done', code: null, kid: keyId(KEY) };
    writeFileSync(
      f,
      `{"v":1,"controllers":{"__proto__":{"seq":3,"opId":"${OPID}","result":null,"code":null},"CTL-1":${JSON.stringify(good)},` +
        `"CTL-2":{"seq":1e400,"opId":"${OPID}","result":null,"code":null},"CTL 3":${JSON.stringify(good)},"CTL-4":{"seq":2,"opId":"XYZ","result":null,"code":null},` +
        `"CTL-5":{"seq":2,"opId":"${OPID}","result":"peut-etre","code":null},"CTL-6":{"seq":2,"opId":"${OPID}","result":null,"code":"io"},"CTL-7":5}}`,
    );
    const h = bench({ stateFile: f });
    assert.match(h.text(), /6 entree\(s\) invalide\(s\) ignoree\(s\)/);
    assert.equal(({} as Record<string, unknown>).seq, undefined, 'prototype intact');
    const rec = h.attach();
    await h.send('CTL-1', h.order({ seq: 7, opId: OPID }));
    assert.deepEqual([h.acks[0]!.ack.seq, h.acks[0]!.ack.result], [7, 'done'], 'entree valide reprise');
    assert.equal(rec.calls.length, 0);
    // « __proto__ » est un identifiant de controleur bien forme : garde comme une simple donnee (Map), sans effet sur les autres.
    assert.deepEqual(h.pilot.ids(), ['CTL-1']);
  });

  it("ecriture impossible du fichier d'etat : journalisee (au plus une fois par minute), la synchronisation continue", async () => {
    const dir = tempDir(cleanup);
    const h = bench({ stateFile: join(dir, 'absent', 'etat.json') });
    const rec = h.attach();
    for (let s = 1; s <= 5; s++) await h.send('CTL-1', h.order({ seq: s }));
    assert.equal(rec.calls.length, 5);
    assert.equal(h.acks.length, 5);
    assert.equal(h.logger.lines.filter((l) => /ecriture du fichier d'etat impossible/.test(l.text)).length, 1);
  });

  it('cle changee entre deux demarrages : numero de sequence remis a zero (les anciens messages ne passent plus la signature)', async () => {
    const dir = tempDir(cleanup);
    const stateFile = join(dir, 'etat.json');
    const h1 = bench({ stateFile });
    h1.attach();
    const old = h1.order({ seq: 100 });
    await h1.send('CTL-1', old);
    await h1.pilot.stop();
    const h2 = bench({ stateFile, keys: { 'CTL-1': KEY2 } });
    const r2 = h2.attach('CTL-1', KEY2);
    assert.match(h2.text(), /cle de synchronisation changee/);
    await h2.send('CTL-1', old);
    assert.equal(r2.calls.length, 0, 'ancien message, ancienne cle : signature fausse');
    await h2.send('CTL-1', h2.order({ seq: 1 }));
    assert.equal(r2.calls.length, 1, 'le PSIM peut repartir de 1 avec la nouvelle cle');
  });

  it('memoire seule (stateFile null) : aucune ecriture, meme comportement', async () => {
    const h = bench({ stateFile: null });
    const rec = h.attach();
    const m = h.order({ seq: 2 });
    await h.send('CTL-1', m);
    await h.send('CTL-1', m);
    assert.equal(rec.calls.length, 1);
    assert.equal(h.acks.length, 2);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe('synchronisation : enregistrement, statistiques, journaux', () => {
  it('register : identifiant, cle, gestionnaire valides ; double enregistrement refuse ; la cle n\'apparait jamais dans une erreur', () => {
    const h = bench();
    const ok: AccessSyncHandler = async () => ({ result: 'done' });
    for (const bad of ['', 'CTL 1', 'a'.repeat(33), 'CTL/1', '../x', 5 as unknown as string]) {
      assert.throws(() => h.pilot.register(bad, KEY, ok), /identifiant de controleur/);
    }
    const nearly = KEY.slice(0, 63) + 'G';
    for (const badKey of [nearly, KEY.toUpperCase(), KEY.slice(1), '', 12 as unknown as string]) {
      assert.throws(
        () => h.pilot.register('CTL-1', badKey, ok),
        (err: Error) => /cle de synchronisation invalide/.test(err.message) && (String(badKey).length < 8 || !err.message.includes(String(badKey).slice(0, 20))),
      );
    }
    assert.throws(() => h.pilot.register('CTL-1', KEY, 'non' as unknown as AccessSyncHandler), /gestionnaire/);
    const off = h.pilot.register('CTL-1', KEY, ok);
    assert.throws(() => h.pilot.register('CTL-1', KEY, ok), /deja enregistre/);
    off();
    const other: AccessSyncHandler = async () => ({ result: 'refused', code: 'invalid' });
    h.pilot.register('CTL-1', KEY, other);
    off(); // ancien retrait : sans effet sur le nouveau gestionnaire
    assert.equal(h.pilot.hasHandler('CTL-1'), true);
  });

  it('statistiques', async () => {
    const h = bench();
    const rec = h.attach();
    await h.send('CTL-1', h.order({ seq: 1 }));
    rec.behavior = () => ({ result: 'refused', code: 'invalid' });
    const m = h.order({ seq: 2 });
    await h.send('CTL-1', m);
    await h.send('CTL-1', m);
    rec.behavior = () => ({ result: 'error', code: 'io' });
    await h.send('CTL-1', h.order({ seq: 3 }));
    await h.send('CTL-1', h.order({ seq: 1 }));
    await h.send('CTL-1', 'x');
    assert.deepEqual(h.pilot.stats(), { controllers: 1, done: 1, refused: 1, failed: 1, unreachable: 0, ignored: 1, replayed: 1, reacked: 1, acksLost: 0 });
  });

  it('operations faites : une ligne par minute au plus ; refus et erreurs : une ligne chacun, sans donnee personnelle', async () => {
    const h = bench();
    const rec = h.attach();
    for (let s = 1; s <= 20; s++) await h.send('CTL-1', h.order({ seq: s, body: upsertHolder() }));
    assert.equal(h.logger.lines.filter((l) => /faite/.test(l.text)).length, 1);
    rec.behavior = () => ({ result: 'refused', code: 'full' });
    await h.send('CTL-1', h.order({ seq: 21, body: upsertHolder() }));
    const line = h.logger.lines.find((l) => /-> refused/.test(l.text))!;
    assert.match(line.text, /^\[synchro\] CTL-1 : synchronisation upsert_holder seq 21 \(op [0-9a-f]{8}\) -> refused \(full\)$/);
    assert.equal(line.level, 'warn');
  });

  it('jamais de cle, de signature, de corps, de nom ni de badge dans le journal, quel que soit le parcours', async () => {
    const dir = tempDir(cleanup);
    const h = bench({ stateFile: join(dir, 'etat.json'), handlerTimeoutMs: 100 });
    const rec = h.attach();
    const sigs: string[] = [];
    const send = async (seq: number) => {
      const m = h.order({ seq, body: upsertHolder() });
      sigs.push((JSON.parse(m) as { sig: string }).sig);
      await h.send('CTL-1', m);
      return m;
    };
    const m1 = await send(1);
    await h.send('CTL-1', m1);
    rec.behavior = () => {
      throw new Error('KONAN Yao 0012345');
    };
    await send(2);
    rec.behavior = () => new Promise(() => undefined);
    void send(3);
    await h.advance(100);
    rec.behavior = () => ({ result: 'refused', code: 'invalid' });
    await send(4);
    h.net.up = false;
    await send(5);
    rec.off();
    await send(6);
    await h.send('CTL-1', JSON.stringify({ ...JSON.parse(h.order({ seq: 7, body: upsertHolder() })), sig: 'a'.repeat(64) }));
    h.clock.t += 120_000;
    await h.pilot.stop();
    const text = h.text();
    assert.ok(h.logger.lines.length > 5);
    for (const secret of [KEY, ...sigs, 'KONAN', '0012345', 'H101', upsertHolder()]) assert.equal(text.includes(secret), false, `fuite : ${secret.slice(0, 20)}\n${text}`);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Socle : ctx.onAccessSync (vrai startRuntime, module d'essai ecrit dans un dossier temporaire)
// ------------------------------------------------------------------------------------------------------------------

/** Module d'essai : enregistre les controleurs de sa configuration et garde ses appels dans globalThis. */
const SYNC_MODULE = `
const g = globalThis;
g.syncCalls ??= [];
g.syncErrors ??= [];
export function create(config) {
  return {
    name: 'syncmod',
    async start(ctx) {
      for (const c of config.controllers ?? []) {
        try {
          ctx.onAccessSync(c.id, async (op) => {
            g.syncCalls.push({ label: config.label, id: c.id, op: { ...op } });
            if (config.fail) throw new Error('panne');
            return { result: 'done' };
          }, { key: c.key });
        } catch (err) {
          g.syncErrors.push(config.label + ': ' + err.message);
          if (config.strict) throw err;
        }
      }
      if (config.lateCtx) g.lateCtx = ctx;
      if (config.failStart) throw new Error('demarrage rate');
    },
    async stop() {},
  };
}
`;

interface SyncGlobals {
  syncCalls?: { label: string; id: string; op: AccessSyncOp }[];
  syncErrors?: string[];
  lateCtx?: { onAccessSync: (id: string, h: AccessSyncHandler, o: { key: string }) => void };
}
const G = globalThis as SyncGlobals;

async function socle(modules: { label: string; config: Record<string, unknown> }[]) {
  const dir = tempDir(cleanup);
  const modulesDir = join(dir, 'modules');
  mkdirSync(join(modulesDir, 'syncmod'), { recursive: true });
  writeFileSync(join(modulesDir, 'syncmod', 'index.ts'), SYNC_MODULE);
  G.syncCalls = [];
  G.syncErrors = [];
  // Aucun broker n'ecoute sur ce port : les ordres sont remis directement au pilote du socle.
  const port = await freePort();
  const file = writeConfig(dir, {
    psim: { url: `mqtt://127.0.0.1:${port}`, username: 'gw1', password: 'Mot-de-passe-passerelle-1' },
    dataDir: 'data',
    retry: { minMs: 5000, maxMs: 5000 },
    moduleRetry: { minMs: 1000, maxMs: 1000 },
    log: { file: false },
    modules: modules.map((m) => ({ name: 'syncmod', label: m.label, config: { label: m.label, ...m.config } })),
  });
  const logger = memoryLogger();
  const rt = await startRuntime({ config: loadConfig(file, { modulesDir }), logger, modulesDir });
  cleanup.push(() => rt.stop());
  return { rt, logger, dir };
}

describe('socle : ctx.onAccessSync', () => {
  it("enregistrement : le pilote du socle recoit l'ordre et le module l'execute ; statut et fichier d'etat", async () => {
    const { rt, dir } = await socle([{ label: 'a', config: { controllers: [{ id: 'CTL-1', key: KEY }] } }]);
    await waitFor(() => rt.status().modules[0]?.state === 'running', 5000, 'module demarre');
    assert.deepEqual(rt.accessSync.ids(), ['CTL-1']);
    assert.equal(rt.status().accessSync.controllers, 1);
    await rt.accessSync.handleMessage('CTL-1', Buffer.from(psimSign(KEY, 'CTL-1', { opId: OPID, seq: 1, ts: Date.now(), body: deleteHolder() })));
    assert.equal(G.syncCalls!.length, 1);
    assert.equal(G.syncCalls![0]!.op.type, 'delete_holder');
    assert.equal(G.syncCalls![0]!.op.seq, 1);
    // Liaison PSIM coupee : l'accuse est perdu, l'operation est faite et son resultat garde.
    assert.equal(rt.status().accessSync.done, 1);
    assert.equal(rt.status().accessSync.acksLost, 1);
    const saved = JSON.parse(readFileSync(join(dir, 'data', ACCESS_SYNC_STATE_FILE), 'utf8')) as { controllers: Record<string, { seq: number; result: string }> };
    assert.deepEqual([saved.controllers['CTL-1']!.seq, saved.controllers['CTL-1']!.result], [1, 'done']);
  });

  it('identifiant invalide, cle invalide (jamais affichee), gestionnaire absent, controleur deja pris par un autre module : erreur claire', async () => {
    const nearly = `${KEY.slice(0, 62)}zz`;
    const { rt } = await socle([
      { label: 'a', config: { controllers: [{ id: 'CTL 1', key: KEY }, { id: 'CTL-2', key: nearly }, { id: 'CTL-3', key: KEY }] } },
      { label: 'b', config: { controllers: [{ id: 'CTL-3', key: KEY2 }] } },
    ]);
    await waitFor(() => rt.status().modules.every((m) => m.state === 'running'), 5000, 'modules demarres');
    const errors = G.syncErrors!.join('\n');
    assert.match(errors, /a: identifiant de controleur « CTL 1 » invalide/);
    assert.match(errors, /a: controleur « CTL-2 » : cle de synchronisation invalide/);
    // Les deux modules demarrent en parallele : le premier arrive garde le controleur, l'autre recoit l'erreur.
    assert.match(errors, /(a: controleur « CTL-3 » deja enregistre pour la synchronisation par le module « b »|b: controleur « CTL-3 » deja enregistre pour la synchronisation par le module « a »)/);
    assert.equal(errors.includes(nearly.slice(0, 20)), false, 'la cle fausse n\'est jamais reprise');
    assert.deepEqual(rt.accessSync.ids(), ['CTL-3']);
  });

  it("double enregistrement par le meme module : refuse « ce module » ; contexte d'une instance arretee : « module arrete »", async () => {
    const { rt } = await socle([{ label: 'a', config: { lateCtx: true, controllers: [{ id: 'CTL-1', key: KEY }, { id: 'CTL-1', key: KEY }] } }]);
    await waitFor(() => rt.status().modules[0]?.state === 'running', 5000, 'module demarre');
    assert.match(G.syncErrors!.join('\n'), /controleur « CTL-1 » deja enregistre pour la synchronisation par ce module/);
    const ctx = G.lateCtx!;
    await rt.stop();
    assert.throws(() => ctx.onAccessSync('CTL-9', async () => ({ result: 'done' }), { key: KEY }), /module arrete/);
  });

  it("module qui echoue au demarrage : gestionnaire retire (ordre accuse « unreachable », seq libre), reenregistre a l'essai suivant", async () => {
    const { rt } = await socle([{ label: 'a', config: { failStart: true, controllers: [{ id: 'CTL-1', key: KEY }] } }]);
    await waitFor(() => (rt.status().modules[0]?.failures ?? 0) >= 1 && rt.status().modules[0]?.state === 'retrying', 5000, 'echec du demarrage');
    assert.equal(rt.accessSync.hasHandler('CTL-1'), false);
    assert.deepEqual(rt.accessSync.ids(), ['CTL-1'], 'cle et abonnement gardes');
    await rt.accessSync.handleMessage('CTL-1', Buffer.from(psimSign(KEY, 'CTL-1', { opId: OPID, seq: 1, ts: Date.now(), body: deleteHolder() })));
    assert.equal(rt.status().accessSync.unreachable, 1);
    assert.equal(G.syncCalls!.length, 0);
    assert.equal(G.syncErrors!.length, 0, 'le reenregistrement ne heurte jamais l\'ancien gestionnaire');
    await waitFor(() => (rt.status().modules[0]?.failures ?? 0) >= 2, 5000, 'nouvel essai');
    assert.equal(G.syncErrors!.length, 0);
  });
});
