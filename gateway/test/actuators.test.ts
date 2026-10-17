/**
 * Pilote de commandes d'actionneurs (gateway/src/actuators.ts) : les regles du recepteur de docs/COMMANDES.md 5.1, une par une,
 * avec horloge et planificateur FACTICES (aucune attente reelle) ; la configuration `actuators` ; `ctx.onActuator` dans le
 * socle ; puis un essai d'integration contre le VRAI broker du PSIM (ordres signes par server/actuatorproto.ts).
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ackCanonical, buildAck, createActuatorPilot, hmacHex, orderCanonical, parseOrder, sameSignature } from '../src/actuators.ts';
import type { ActuatorPilot, Scheduler } from '../src/actuators.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import type { ActuatorSpec } from '../src/config.ts';
import type { ActuatorHandler, ActuatorOutcome, ActuatorRequest } from '../src/module.ts';
import { startRuntime } from '../src/runtime.ts';
import { commandCanonical, signAck, signCommand, verifyAck, verifyCommand } from '../../server/actuatorproto.ts';
import type { AckMessage } from '../../server/actuatorproto.ts';
import type { DoorRecord } from './fixtures/modules/door/index.ts';
import { FIXTURES, GW_PASSWORD, GW_USER, freePort, memoryLogger, psimBroker, sleep, tempDir, testConfig, waitFor, writeConfig } from './helpers.ts';

const cleanup: (() => unknown)[] = [];
after(async () => {
  for (const f of cleanup.reverse()) await f();
});

/** Cle des vecteurs de docs/COMMANDES.md 5.3. */
const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const KEY2 = '1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100';
const T0 = 1_760_000_000_000;

const doors = () => ((globalThis as { gatewayDoors?: Record<string, DoorRecord> }).gatewayDoors ??= {});

function spec(over: Partial<ActuatorSpec> = {}): ActuatorSpec {
  return {
    id: 'GACHE-1',
    key: KEY,
    keySource: 'essai',
    module: 'door',
    actions: { unlock: { maxS: 10, unbounded: false }, lock: { maxS: null, unbounded: false } },
    rest: 'lock',
    emergencyExit: false,
    ...over,
  };
}

// ------------------------------------------------------------------------------------------------------------------
// Banc d'essai du pilote : horloge et planificateur factices, accuses captures et verifies par le code du PSIM.
// ------------------------------------------------------------------------------------------------------------------

/** cmdId uniques pour tout le fichier : deux bancs d'essai (redemarrage simule) ne se chevauchent jamais. */
let cmdSeq = 0;
const nextCmdId = () => (++cmdSeq).toString(16).padStart(32, '0');

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
}

const flush = async () => {
  for (let i = 0; i < 25; i++) await new Promise<void>((r) => setImmediate(r));
};

function bench(over: { specs?: ActuatorSpec[]; stateFile?: string | null; handlerTimeoutMs?: number; restRetryMs?: number; restRetries?: number; startAt?: number } = {}) {
  const specs = over.specs ?? [spec()];
  const clock = { t: over.startAt ?? T0 };
  const timers = new Set<Timer>();
  let seq = 0;
  const schedule: Scheduler = (fn, ms) => {
    const t: Timer = { at: clock.t + ms, seq: seq++, fn };
    timers.add(t);
    return () => void timers.delete(t);
  };
  const logger = memoryLogger();
  const acks: { id: string; ack: AckMessage; raw: string }[] = [];
  const net = { up: true, throws: false, hang: false, published: 0, release: () => undefined as void };
  const held: (() => void)[] = [];
  net.release = () => void held.splice(0).forEach((f) => f());
  const keys = new Map(specs.map((s) => [s.id, s.key]));
  const pilot: ActuatorPilot = createActuatorPilot({
    actuators: specs,
    log: logger,
    now: () => clock.t,
    schedule,
    stateFile: over.stateFile ?? null,
    handlerTimeoutMs: over.handlerTimeoutMs,
    restRetryMs: over.restRetryMs,
    restRetries: over.restRetries,
    publishAck: async (id, raw) => {
      net.published++;
      if (net.hang) await new Promise<void>((r) => void held.push(r));
      if (net.throws) throw new Error('liaison en panne');
      if (!net.up) return false;
      // Chaque accuse publie doit etre lu et valide par le CODE DU PSIM (server/actuatorproto.ts).
      const ack = verifyAck(keys.get(id) as string, id, raw);
      assert.ok(ack, `accuse invalide pour le PSIM : ${raw}`);
      acks.push({ id, ack, raw });
      return true;
    },
  });
  const cmdId = nextCmdId;
  const h = {
    clock,
    pilot,
    logger,
    acks,
    net,
    timers,
    cmdId,
    /** Ordre signe par le code du PSIM. */
    order(o: { id?: string; key?: string; cmdId?: string; action?: string; durationS?: number; clip?: string; ts?: number; ttlS?: number } = {}) {
      const params: { durationS?: number; clip?: string } = {};
      if (o.durationS !== undefined) params.durationS = o.durationS;
      if (o.clip !== undefined) params.clip = o.clip;
      return signCommand(o.key ?? keys.get(o.id ?? 'GACHE-1') ?? KEY, o.id ?? 'GACHE-1', { cmdId: o.cmdId ?? cmdId(), action: o.action ?? 'unlock', params, ts: o.ts ?? clock.t, ttlS: o.ttlS ?? 10 });
    },
    send: (id: string, msg: unknown) => pilot.handleMessage(id, Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg))),
    /** Enregistre un gestionnaire qui garde ses appels ; `behavior` peut etre change en cours d'essai. */
    attach(id = 'GACHE-1') {
      const rec = {
        calls: [] as ActuatorRequest[],
        concurrent: 0,
        maxConcurrent: 0,
        behavior: (async () => ({ result: 'done' })) as (req: ActuatorRequest) => Promise<ActuatorOutcome> | ActuatorOutcome,
        off: () => undefined as void,
      };
      const handler: ActuatorHandler = async (req) => {
        rec.calls.push(req);
        rec.concurrent++;
        rec.maxConcurrent = Math.max(rec.maxConcurrent, rec.concurrent);
        try {
          return await rec.behavior(req);
        } finally {
          rec.concurrent--;
        }
      };
      rec.off = pilot.register(id, handler);
      return rec;
    },
    /** Promesse qui se resout apres `ms` de temps FACTICE. */
    sleep: (ms: number) => new Promise<void>((r) => void schedule(r, ms)),
    async advance(ms: number) {
      const end = clock.t + ms;
      await flush();
      for (;;) {
        const next = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
        if (!next) break;
        timers.delete(next);
        clock.t = Math.max(clock.t, next.at);
        next.fn();
        await flush();
      }
      clock.t = end;
      await flush();
    },
    flush,
    last: () => acks[acks.length - 1],
  };
  return h;
}

/** Aucune ligne de journal ne contient de secret : ni cle, ni signature (64 hexadecimaux), ni retour a la ligne. */
function assertNoSecrets(logger: ReturnType<typeof memoryLogger>): void {
  for (const l of logger.lines) {
    assert.doesNotMatch(l.text, /[0-9a-f]{64}/i, `secret possible dans le journal : ${l.text}`);
    assert.doesNotMatch(l.text, /[\u0000-\u001f]/, `caractere de controle dans le journal : ${JSON.stringify(l.text)}`);
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Protocole : vecteurs 5.3 et accord avec server/actuatorproto.ts
// ------------------------------------------------------------------------------------------------------------------

describe('protocole : vecteurs de docs/COMMANDES.md 5.3 et accord avec le code du PSIM', () => {
  it('les trois vecteurs signes', () => {
    assert.equal(
      hmacHex(KEY, 'psim-cmd-v1|SIR-01|0123456789abcdef0123456789abcdef|on|30||1760000000000|10'),
      '6093f1a2a2059ef774346df9dde1becae2176df72ffcdee8e4778d504845c7f5',
    );
    assert.equal(hmacHex(KEY, 'psim-ack-v1|SIR-01|0123456789abcdef0123456789abcdef|done||1760000000850'), '255db3b9fa4c4c174c08f66202c5d6e31ff30d5bb17aafb51e928a807f59b3d4');
    assert.equal(
      hmacHex(KEY, 'psim-cmd-v1|GACHE-1|fedcba9876543210fedcba9876543210|unlock|5||1760000000000|10'),
      '600b7c96c85b2c774d2e382e8a7dc9ab38bb1ff785322eb330dd2824fcf83f8f',
    );
    // ... et par les fonctions de chaine canonique de la passerelle
    assert.equal(orderCanonical('SIR-01', { cmdId: '0123456789abcdef0123456789abcdef', action: 'on', durationS: 30, ts: 1760000000000, ttlS: 10 }), 'psim-cmd-v1|SIR-01|0123456789abcdef0123456789abcdef|on|30||1760000000000|10');
    assert.equal(ackCanonical('SIR-01', { cmdId: '0123456789abcdef0123456789abcdef', result: 'done', ts: 1760000000850 }), 'psim-ack-v1|SIR-01|0123456789abcdef0123456789abcdef|done||1760000000850');
  });

  it("l'ordre du vecteur 1, tel que le PSIM le signe, est lu par la passerelle", () => {
    const raw = '{"v":1,"cmdId":"0123456789abcdef0123456789abcdef","action":"on","params":{"durationS":30},"ts":1760000000000,"ttlS":10,"sig":"6093f1a2a2059ef774346df9dde1becae2176df72ffcdee8e4778d504845c7f5"}';
    const o = parseOrder(raw);
    assert.ok(o);
    assert.equal(o.durationS, 30);
    assert.equal(o.clip, undefined);
    assert.ok(sameSignature(hmacHex(KEY, orderCanonical('SIR-01', o)), o.sig));
    assert.ok(!sameSignature(hmacHex(KEY, orderCanonical('SIR-02', o)), o.sig), "l'identifiant du topic fait partie de la signature");
  });

  it('accord avec server/actuatorproto.ts sur des centaines d ordres et d accuses tires au hasard', () => {
    const rnd = (n: number) => Math.floor(Math.random() * n);
    const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[rnd(16)]).join('');
    const names = ['unlock', 'lock', 'on', 'off', 'open', 'close', 'stop', 'play', 'pulse', 'a', 'x_y'];
    for (let i = 0; i < 300; i++) {
      const key = hex(64);
      const id = `A${hex(5)}-${i}`;
      const params: { durationS?: number; clip?: string } = {};
      if (rnd(2)) params.durationS = 1 + rnd(86_400);
      if (rnd(2)) params.clip = `clip_${hex(4)}-${rnd(99)}`;
      const base = { cmdId: hex(32), action: names[rnd(names.length)], params, ts: 1 + rnd(2e12), ttlS: 2 + rnd(29) };
      const signed = signCommand(key, id, base);
      // la passerelle recalcule la meme signature
      const parsed = parseOrder(JSON.stringify(signed));
      assert.ok(parsed, JSON.stringify(signed));
      assert.equal(hmacHex(key, orderCanonical(id, parsed)), signed.sig);
      assert.equal(orderCanonical(id, parsed), commandCanonical(id, base));
      // le recepteur du PSIM accepte ce que la passerelle accepte
      assert.equal(verifyCommand(key, id, JSON.stringify(signed), base.ts).ok, true);
      // un accuse construit par la passerelle est valide pour verifyAck du PSIM, avec ou sans code
      for (const code of [undefined, 'stale', 'not_allowed', 'a1_b2']) {
        for (const result of ['done', 'refused', 'error'] as const) {
          const ts = 1 + rnd(2e12);
          const mine = buildAck(key, id, { cmdId: base.cmdId, result, ...(code ? { code } : {}), ts });
          const theirs = verifyAck(key, id, mine);
          assert.ok(theirs, mine);
          assert.deepEqual({ cmdId: theirs.cmdId, result: theirs.result, code: theirs.code, ts: theirs.ts }, { cmdId: base.cmdId, result, code, ts });
          // et reciproquement : meme signature que signAck du PSIM
          assert.equal(theirs.sig, signAck(key, id, { cmdId: base.cmdId, result, ...(code ? { code } : {}), ts }).sig);
        }
      }
    }
  });

  it("l'ordre n'est pas un accuse et l'accuse n'est pas un ordre (prefixes differents)", () => {
    const o = signCommand(KEY, 'GACHE-1', { cmdId: 'a'.repeat(32), action: 'done', params: {}, ts: T0, ttlS: 10 });
    assert.equal(verifyAck(KEY, 'GACHE-1', JSON.stringify({ v: 1, cmdId: o.cmdId, result: 'done', ts: T0, sig: o.sig })), null);
  });

  it('sameSignature : longueurs, majuscules et caracteres hors hexadecimal refuses sans lever', () => {
    const s = 'a'.repeat(64);
    assert.ok(sameSignature(s, s));
    assert.ok(!sameSignature(s, 'a'.repeat(63)));
    assert.ok(!sameSignature(s, 'A'.repeat(64)));
    assert.ok(!sameSignature(s, `${'a'.repeat(63)}g`));
    assert.ok(!sameSignature(s, ''));
    assert.ok(!sameSignature(s, 'a'.repeat(128)));
  });

  it('hmacHex refuse une cle mal formee', () => {
    assert.throws(() => hmacHex('abc', 'x'), /invalide/);
    assert.throws(() => hmacHex(KEY.toUpperCase(), 'x'), /invalide/);
    assert.equal(createHmac('sha256', Buffer.from(KEY, 'hex')).update('x').digest('hex'), hmacHex(KEY, 'x'));
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Regle 1 : formats ; regle 2 : signature
// ------------------------------------------------------------------------------------------------------------------

describe('pilote : regles 1 et 2 (formats, signature) = ignorer SANS accuser', () => {
  it('chaque champ mal forme est ignore : aucun accuse, aucun appel du module', async () => {
    const h = bench();
    const rec = h.attach();
    const ok = h.order({ action: 'unlock', durationS: 5 });
    const mutate = (f: (o: Record<string, unknown>) => void) => {
      const o = structuredClone(ok) as unknown as Record<string, unknown>;
      f(o);
      return JSON.stringify(o);
    };
    const bad: [string, string][] = [
      ['pas du JSON', '{pas du json'],
      ['tableau', '[1,2]'],
      ['nul', 'null'],
      ['texte', '"unlock"'],
      ['vide', ''],
      ['v = 2', mutate((o) => (o.v = 2))],
      ['v texte', mutate((o) => (o.v = '1'))],
      ['v absent', mutate((o) => delete o.v)],
      ['cmdId majuscules', mutate((o) => (o.cmdId = 'A'.repeat(32)))],
      ['cmdId trop court', mutate((o) => (o.cmdId = 'a'.repeat(31)))],
      ['cmdId trop long', mutate((o) => (o.cmdId = 'a'.repeat(33)))],
      ['cmdId nombre', mutate((o) => (o.cmdId = 12))],
      ['action majuscule', mutate((o) => (o.action = 'Unlock'))],
      ['action 17 caracteres', mutate((o) => (o.action = 'a'.repeat(17)))],
      ['action vide', mutate((o) => (o.action = ''))],
      ['action avec |', mutate((o) => (o.action = 'un|lock'))],
      ['params absent', mutate((o) => delete o.params)],
      ['params nul', mutate((o) => (o.params = null))],
      ['params tableau', mutate((o) => (o.params = []))],
      ['params cle en trop', mutate((o) => (o.params = { durationS: 5, extra: 1 }))],
      ['params __proto__', '{"v":1,"cmdId":"' + ok.cmdId + '","action":"unlock","params":{"__proto__":{"durationS":5}},"ts":' + ok.ts + ',"ttlS":10,"sig":"' + ok.sig + '"}'],
      ['durationS 0', mutate((o) => (o.params = { durationS: 0 }))],
      ['durationS 86401', mutate((o) => (o.params = { durationS: 86_401 }))],
      ['durationS decimal', mutate((o) => (o.params = { durationS: 1.5 }))],
      ['durationS texte', mutate((o) => (o.params = { durationS: '5' }))],
      ['durationS negatif', mutate((o) => (o.params = { durationS: -5 }))],
      ['clip invalide', mutate((o) => (o.params = { clip: 'a b' }))],
      ['clip trop long', mutate((o) => (o.params = { clip: 'a'.repeat(33) }))],
      ['clip nombre', mutate((o) => (o.params = { clip: 5 }))],
      ['ts decimal', mutate((o) => (o.ts = ok.ts + 0.5))],
      ['ts texte', mutate((o) => (o.ts = String(ok.ts)))],
      ['ts zero', mutate((o) => (o.ts = 0))],
      ['ts negatif', mutate((o) => (o.ts = -1))],
      ['ts hors entiers surs', mutate((o) => (o.ts = 2 ** 60))],
      ['ttlS 1', mutate((o) => (o.ttlS = 1))],
      ['ttlS 31', mutate((o) => (o.ttlS = 31))],
      ['ttlS decimal', mutate((o) => (o.ttlS = 10.5))],
      ['sig majuscules', mutate((o) => (o.sig = String(ok.sig).toUpperCase()))],
      ['sig courte', mutate((o) => (o.sig = String(ok.sig).slice(1)))],
      ['sig longue', mutate((o) => (o.sig = `${ok.sig}0`))],
      ['sig absente', mutate((o) => delete o.sig)],
      ['champ en trop', mutate((o) => (o.extra = 1))],
      ['__proto__ a la racine', `{"__proto__":{"x":1},"v":1,"cmdId":"${ok.cmdId}","action":"unlock","params":{"durationS":5},"ts":${ok.ts},"ttlS":10,"sig":"${ok.sig}"}`],
      ['depasse 1024 octets', mutate((o) => (o.padding = 'x'.repeat(1100)))],
    ];
    for (const [what, raw] of bad) {
      await h.send('GACHE-1', raw);
      assert.equal(h.acks.length, 0, `${what} : aucun accuse`);
      assert.equal(rec.calls.length, 0, `${what} : module non appele`);
    }
    assert.equal(h.pilot.stats().ignored, bad.length);
    // le message sain, lui, passe (les ordres mal formes n'ont pas consomme son cmdId)
    await h.send('GACHE-1', ok);
    assert.equal(rec.calls.length, 1);
    assert.equal(h.last().ack.result, 'done');
  });

  it('exactement 1024 octets : lu ; 1025 : ignore', async () => {
    const h = bench();
    const rec = h.attach();
    const o = h.order({ action: 'unlock', durationS: 5 });
    const base = JSON.stringify(o);
    const pad = (n: number) => base.replace('"v":1', `"v":1${' '.repeat(n)}`);
    const exact = pad(1024 - Buffer.byteLength(base));
    assert.equal(Buffer.byteLength(exact), 1024);
    await h.send('GACHE-1', exact);
    assert.equal(rec.calls.length, 1, '1024 octets acceptes');
    const over = h.order({ action: 'unlock', durationS: 5 });
    await h.send('GACHE-1', JSON.stringify(over).replace('"v":1', `"v":1${' '.repeat(1025 - Buffer.byteLength(JSON.stringify(over)))}`));
    assert.equal(rec.calls.length, 1, '1025 octets ignores');
  });

  it('octets invalides (UTF-8 casse), tampon vide, BOM : ignores sans lever', async () => {
    const h = bench();
    const rec = h.attach();
    await h.pilot.handleMessage('GACHE-1', Buffer.from([0xff, 0xfe, 0x7b, 0x7d]));
    await h.pilot.handleMessage('GACHE-1', Buffer.alloc(0));
    await h.pilot.handleMessage('GACHE-1', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(h.order({ action: 'lock' })))]));
    assert.equal(h.acks.length, 0);
    assert.equal(rec.calls.length, 0);
  });

  it("signature fausse (un bit, autre cle, autre actionneur, autre champ) : ignoree SANS accuser et SANS consommer le cmdId", async () => {
    const h = bench({ specs: [spec(), spec({ id: 'GACHE-2', key: KEY2 })] });
    const rec = h.attach();
    const good = h.order({ action: 'unlock', durationS: 5 });
    const flip = { ...good, sig: good.sig.replace(/^./, (c) => (c === '0' ? '1' : '0')) };
    const otherKey = h.order({ key: KEY2, cmdId: good.cmdId, action: 'unlock', durationS: 5, ts: good.ts });
    const forOther = h.order({ id: 'GACHE-2', cmdId: good.cmdId, action: 'unlock', durationS: 5, ts: good.ts });
    const tampered = { ...good, params: { durationS: 6 } }; // signature d'un autre ordre
    const tamperedAction = { ...good, action: 'lock' };
    const tamperedTtl = { ...good, ttlS: 30 };
    for (const m of [flip, otherKey, forOther, tampered, tamperedAction, tamperedTtl]) await h.send('GACHE-1', m);
    assert.equal(h.acks.length, 0, 'pas d\'oracle : rien n\'est publie');
    assert.equal(h.net.published, 0);
    assert.equal(rec.calls.length, 0);
    assert.equal(h.pilot.stats().ignored, 6);
    // le vrai ordre passe ensuite : les faux n'ont pas brule son cmdId
    await h.send('GACHE-1', good);
    assert.equal(rec.calls.length, 1);
    assert.equal(h.last().ack.result, 'done');
  });

  it("une signature « presque bonne » et une signature entierement fausse sont indiscernables de l'exterieur", async () => {
    const h = bench();
    h.attach();
    const good = h.order({ action: 'unlock', durationS: 5 });
    const almost = { ...good, sig: good.sig.slice(0, 63) + (good.sig.endsWith('0') ? '1' : '0') };
    const nothing = { ...good, sig: (good.sig[0] === 'f' ? '0' : 'f').repeat(64) };
    await h.send('GACHE-1', almost);
    const afterAlmost = [h.net.published, h.acks.length, h.pilot.stats().ignored];
    await h.send('GACHE-1', nothing);
    assert.deepEqual([h.net.published, h.acks.length, h.pilot.stats().ignored], [afterAlmost[0], afterAlmost[1], afterAlmost[2] + 1], 'meme observation : ni accuse ni publication');
  });

  it('signatures fausses comptees, journalisees au plus une fois par minute', async () => {
    const h = bench();
    h.attach();
    const forged = () => ({ ...h.order({ action: 'lock' }), sig: 'b'.repeat(64) });
    const warns = () => h.logger.lines.filter((l) => /signature fausse/.test(l.text)).length;
    for (let i = 0; i < 5; i++) await h.send('GACHE-1', forged());
    assert.equal(warns(), 1, 'une seule ligne pour 5 ordres dans la meme minute');
    await h.advance(30_000);
    for (let i = 0; i < 4; i++) await h.send('GACHE-1', forged());
    assert.equal(warns(), 1);
    await h.advance(31_000);
    await h.send('GACHE-1', forged());
    assert.equal(warns(), 2, 'une minute plus tard : nouvelle ligne');
    assert.match(h.logger.lines.filter((l) => /signature fausse/.test(l.text))[1].text, /9 ordre/, 'avec le compte cumule (4 + 4 + 1 depuis la premiere ligne)');
    assertNoSecrets(h.logger);
  });

  it('actionneur inconnu (topic hors configuration) : ignore, journalise une fois par minute', async () => {
    const h = bench();
    await h.send('INCONNU-9', h.order());
    await h.send('INCONNU-9', h.order());
    await h.send('x\ny', h.order());
    assert.equal(h.acks.length, 0);
    assert.equal(h.logger.lines.filter((l) => /non configure/.test(l.text)).length, 1);
    assertNoSecrets(h.logger);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Regle 3 : fraicheur
// ------------------------------------------------------------------------------------------------------------------

describe('pilote : regle 3 (fraicheur)', () => {
  it('bornes exactes : ts - 5000 <= maintenant <= ts + ttlS * 1000', async () => {
    const h = bench();
    const rec = h.attach();
    // trop tot de 1 ms
    await h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + 5001 }));
    assert.deepEqual([h.last().ack.result, h.last().ack.code], ['refused', 'stale']);
    assert.equal(rec.calls.length, 0);
    // exactement 5000 ms d'avance : accepte
    await h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + 5000 }));
    assert.equal(h.last().ack.result, 'done');
    assert.equal(rec.calls.length, 1);
    // exactement ts + ttl : accepte ; 1 ms de plus : perime
    h.clock.t = T0 + 20_000;
    await h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + 10_000, ttlS: 10 }));
    assert.equal(h.last().ack.result, 'done', 'a l\'echeance exacte');
    h.clock.t += 1;
    await h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + 10_000, ttlS: 10 }));
    assert.deepEqual([h.last().ack.result, h.last().ack.code], ['refused', 'stale'], '1 ms apres');
    assert.equal(rec.calls.length, 2);
  });

  it("l'accuse de peremption est signe, date de maintenant, avec le cmdId de l'ordre", async () => {
    const h = bench();
    h.attach();
    const o = h.order({ action: 'lock', ts: T0 - 60_000 });
    await h.send('GACHE-1', o);
    assert.equal(h.last().ack.cmdId, o.cmdId);
    assert.equal(h.last().ack.ts, T0);
    assert.equal(h.last().ack.code, 'stale');
  });

  it("un ordre perime n'est PAS memorise : le meme cmdId, tres en avance puis dans la fenetre, passe", async () => {
    const h = bench();
    const rec = h.attach();
    const o = h.order({ action: 'lock', ts: T0 + 8000 }); // trop en avance (3 s)
    await h.send('GACHE-1', o);
    assert.equal(h.last().ack.code, 'stale');
    await h.advance(4000); // maintenant = ts - 4000 : dans la fenetre
    await h.send('GACHE-1', o);
    assert.equal(rec.calls.length, 1);
    assert.equal(h.last().ack.result, 'done');
  });

  it('horloge de la passerelle reculee de plus de 5 s : ordres refuses « stale » avec un message qui nomme les horloges', async () => {
    const h = bench();
    h.attach();
    await h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + 12_000 }));
    assert.equal(h.last().ack.code, 'stale');
    assert.ok(h.logger.has(/horloge/i));
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Regle 4 : anti-rejeu, ordre des ordres
// ------------------------------------------------------------------------------------------------------------------

describe('pilote : regle 4 (anti-rejeu, ts anterieur)', () => {
  it('meme ordre deux fois : executee une fois, un seul accuse, deuxieme journalise', async () => {
    const h = bench();
    const rec = h.attach();
    const o = h.order({ action: 'unlock', durationS: 5 });
    await h.send('GACHE-1', o);
    await h.send('GACHE-1', o);
    await h.send('GACHE-1', JSON.stringify(o));
    assert.equal(rec.calls.length, 1);
    assert.equal(h.acks.length, 1);
    assert.equal(h.pilot.stats().replayed, 2);
    assert.ok(h.logger.has(/deja vu/));
  });

  it('un ordre REFUSE est memorise lui aussi : le rejouer ne fait rien et n accuse pas', async () => {
    const h = bench();
    const rec = h.attach();
    const o = h.order({ action: 'inconnue' });
    await h.send('GACHE-1', o);
    assert.equal(h.last().ack.code, 'not_allowed');
    await h.send('GACHE-1', o);
    assert.equal(h.acks.length, 1);
    assert.equal(rec.calls.length, 0);
  });

  it("meme cmdId avec une autre action (signature differente, valide) : c'est un rejeu, ignore", async () => {
    const h = bench();
    const rec = h.attach();
    const id = h.cmdId();
    await h.send('GACHE-1', h.order({ cmdId: id, action: 'lock' }));
    await h.send('GACHE-1', h.order({ cmdId: id, action: 'unlock', durationS: 5, ts: T0 + 10 }));
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].action, 'lock');
  });

  it("un ordre rejoue longtemps apres (avant ou apres les 120 s de memoire) n'est jamais re-execute ; deja traite, il n'est pas accuse « stale »", async () => {
    const h = bench();
    const rec = h.attach();
    const o = h.order({ action: 'lock', ttlS: 30 });
    await h.send('GACHE-1', o);
    await h.advance(119_000);
    await h.send('GACHE-1', o);
    assert.equal(rec.calls.length, 1);
    assert.equal(h.acks.length, 1, 'ni execution ni accuse : un « stale » contredirait le « done » deja envoye');
    await h.advance(2000); // au-dela des 120 s : la memoire est oubliee, mais l'ordre est perime depuis longtemps
    await h.send('GACHE-1', o);
    assert.equal(rec.calls.length, 1, 'jamais re-execute');
    assert.equal(h.last().ack.code, 'stale', 'inconnu et perime : refuse');
  });

  it('memoire bornee : au-dela de 5000 ordres, le plus ancien est oublie sans casser les autres', async () => {
    const h = bench();
    h.attach();
    for (let i = 0; i < 5100; i++) {
      await h.send('GACHE-1', h.order({ action: 'lock', ts: T0, ttlS: 30 }));
    }
    assert.equal(h.acks.length, 5100);
    const replay = h.order({ action: 'lock', ts: T0 });
    await h.send('GACHE-1', replay);
    const n = h.acks.length;
    await h.send('GACHE-1', replay);
    assert.equal(h.acks.length, n, 'le dernier est toujours reconnu');
  });

  it('ts anterieur au dernier ordre accepte : refused/out_of_order ; ts egal accepte ; un refus ne fait pas avancer', async () => {
    const h = bench();
    const rec = h.attach();
    await h.send('GACHE-1', h.order({ action: 'unlock', durationS: 5, ts: T0 + 1000 }));
    assert.equal(h.last().ack.result, 'done');
    const old = h.order({ action: 'lock', ts: T0 + 999 });
    await h.send('GACHE-1', old);
    assert.deepEqual([h.last().ack.result, h.last().ack.code], ['refused', 'out_of_order']);
    assert.equal(rec.calls.length, 1, 'le module n\'a pas ete appele');
    await h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + 1000 }));
    assert.equal(h.last().ack.result, 'done', 'meme ts : accepte');
    // un ordre refuse (not_allowed) a ts eleve ne fait pas avancer le « dernier ordre execute »
    await h.send('GACHE-1', h.order({ action: 'zzz', ts: T0 + 4000 }));
    assert.equal(h.last().ack.code, 'not_allowed');
    await h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + 2000 }));
    assert.equal(h.last().ack.result, 'done');
    // l'ordre ancien est memorise : le rejouer ne fait rien
    const n = h.acks.length;
    await h.send('GACHE-1', old);
    assert.equal(h.acks.length, n);
  });

  it("l'ordre « unlock » retarde apres un « lock » plus recent (broker qui retient un message) est refuse", async () => {
    const h = bench();
    const rec = h.attach();
    const unlock = h.order({ action: 'unlock', durationS: 5, ts: T0 });
    const lock = h.order({ action: 'lock', ts: T0 + 800 });
    await h.send('GACHE-1', lock); // arrive en premier
    await h.send('GACHE-1', unlock); // retarde par l'attaquant
    assert.deepEqual(rec.calls.map((c) => c.action), ['lock']);
    assert.equal(h.last().ack.code, 'out_of_order');
  });

  it("ordre sans module : « unavailable », cmdId memorise, mais le « dernier ts » n'avance pas", async () => {
    const h = bench();
    const o = h.order({ action: 'lock', ts: T0 + 3000 });
    await h.send('GACHE-1', o);
    assert.deepEqual([h.last().ack.result, h.last().ack.code], ['refused', 'unavailable']);
    const rec = h.attach();
    await h.send('GACHE-1', o);
    assert.equal(h.acks.length, 1, 'rejeu ignore meme apres le retour du module');
    await h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + 1000 }));
    assert.equal(rec.calls.length, 1, 'un ts plus ancien que l ordre « unavailable » reste accepte');
  });

  it('horloge de la passerelle passee en avant puis corrigee : le dernier ts impossible est oublie, pas de blocage', async () => {
    const dir = tempDir(cleanup);
    const stateFile = join(dir, 'etat.json');
    writeFileSync(stateFile, JSON.stringify({ v: 1, savedAt: T0, seen: {}, lastTs: { 'GACHE-1': T0 + 3_600_000 }, rest: {} }));
    const h = bench({ stateFile });
    const rec = h.attach();
    await h.send('GACHE-1', h.order({ action: 'lock' }));
    assert.equal(rec.calls.length, 1);
    assert.equal(h.last().ack.result, 'done');
  });
});

describe('pilote : regle 4 apres un redemarrage (fichier d\'etat)', () => {
  it('rejeu apres redemarrage : ignore ; fichier atomique, sans secret', async () => {
    const dir = tempDir(cleanup);
    const stateFile = join(dir, 'actuators-state.json');
    const a = bench({ stateFile });
    const recA = a.attach();
    const o = a.order({ action: 'unlock', durationS: 5, ts: T0 });
    await a.send('GACHE-1', o);
    assert.equal(recA.calls.length, 1);
    assert.ok(existsSync(stateFile));
    assert.ok(!existsSync(`${stateFile}.tmp`), 'pas de fichier temporaire oublie');
    const text = readFileSync(stateFile, 'utf8');
    assert.ok(!text.includes(KEY), 'la cle n\'est pas dans le fichier');
    assert.ok(!text.includes(o.sig), 'ni la signature');
    assert.doesNotMatch(text, /[0-9a-f]{64}/, 'aucune chaine de 64 hexadecimaux');
    // la passerelle redemarre : nouvelle instance, meme fichier, meme heure
    const b = bench({ stateFile, startAt: T0 + 3000 });
    const recB = b.attach();
    await b.send('GACHE-1', o);
    assert.equal(recB.calls.length, 0, 'rejeu ignore apres redemarrage');
    assert.equal(b.acks.length, 0);
    // un ordre plus ancien que le dernier execute est refuse aussi apres redemarrage
    await b.send('GACHE-1', b.order({ action: 'lock', ts: T0 - 500, ttlS: 30 }));
    assert.equal(b.last().ack.code, 'out_of_order');
    // un ordre neuf passe
    await b.send('GACHE-1', b.order({ action: 'lock', ts: T0 + 3000 }));
    assert.equal(b.last().ack.result, 'done');
  });

  it('les cmdId de plus de 120 s ne sont pas reportes apres redemarrage', async () => {
    const dir = tempDir(cleanup);
    const stateFile = join(dir, 'etat.json');
    const a = bench({ stateFile });
    a.attach();
    await a.send('GACHE-1', a.order({ action: 'lock' }));
    const b = bench({ stateFile, startAt: T0 + 200_000 });
    b.attach();
    const seen = JSON.parse(readFileSync(stateFile, 'utf8')).seen['GACHE-1'] as Record<string, number>;
    assert.equal(Object.keys(seen).length, 1);
    await b.send('GACHE-1', b.order({ action: 'lock', ts: T0 + 200_000 })); // fraiche, nouvelle
    const after = JSON.parse(readFileSync(stateFile, 'utf8')).seen['GACHE-1'] as Record<string, number>;
    assert.equal(Object.keys(after).length, 1, 'l\'ancien a ete purge, le nouveau garde');
  });

  it('fichier illisible, vide, corrompu ou de mauvaise version : on repart vide, en le journalisant', async () => {
    for (const content of ['{pas du json', '', '[]', '{"v":2}', 'null', '\u0000\u0000', JSON.stringify({ v: 1, seen: 'x', lastTs: [], rest: 5 })]) {
      const dir = tempDir(cleanup);
      const stateFile = join(dir, 'etat.json');
      writeFileSync(stateFile, content);
      const h = bench({ stateFile });
      const rec = h.attach();
      await h.send('GACHE-1', h.order({ action: 'lock' }));
      assert.equal(rec.calls.length, 1, `repart vide : ${JSON.stringify(content).slice(0, 30)}`);
      assertNoSecrets(h.logger);
    }
    const dir = tempDir(cleanup);
    const stateFile = join(dir, 'etat.json');
    writeFileSync(stateFile, '{pas du json');
    const h = bench({ stateFile });
    assert.ok(h.logger.has(/corrompu/), 'journalise');
  });

  it('fichier hostile (cmdId invalides, nombres enormes, __proto__, actions inconnues) : entrees ignorees, jamais de plantage', async () => {
    const dir = tempDir(cleanup);
    const stateFile = join(dir, 'etat.json');
    const good = 'c'.repeat(32);
    writeFileSync(
      stateFile,
      `{"v":1,"seen":{"GACHE-1":{"${good}":${T0},"zzz":1,"${'d'.repeat(32)}":"x","${'e'.repeat(32)}":1e999},"__proto__":{"a":1},"AUTRE":{"${'f'.repeat(32)}":${T0}}},"lastTs":{"GACHE-1":"pas un nombre","__proto__":5},"rest":{"GACHE-1":{"action":"unlock","cmdId":"x","dueAt":1},"__proto__":{}}}`,
    );
    const h = bench({ stateFile });
    const rec = h.attach();
    assert.ok(h.logger.has(/ignoree/), 'entrees invalides signalees');
    assert.equal(({} as Record<string, unknown>).a, undefined, 'pas de pollution du prototype');
    await h.send('GACHE-1', h.order({ cmdId: good, action: 'lock' }));
    assert.equal(rec.calls.length, 0, 'le cmdId valide du fichier est bien connu (rejeu)');
    await h.send('GACHE-1', h.order({ action: 'lock' }));
    assert.equal(rec.calls.length, 1);
  });

  it('ecriture impossible du fichier d\'etat : journalisee (limitee), les ordres continuent', async () => {
    const dir = tempDir(cleanup);
    mkdirSync(join(dir, 'etat.json')); // un dossier a la place du fichier : renameSync echoue
    const h = bench({ stateFile: join(dir, 'etat.json') });
    const rec = h.attach();
    await h.send('GACHE-1', h.order({ action: 'lock' }));
    await h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + 1 }));
    assert.equal(rec.calls.length, 2);
    assert.equal(h.logger.lines.filter((l) => /fichier d'etat impossible/.test(l.text)).length, 1, 'une ligne par minute');
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Regle 5 : plafonds locaux, issue de secours
// ------------------------------------------------------------------------------------------------------------------

describe('pilote : regle 5 (plafonds locaux, issue de secours, action inconnue)', () => {
  const refusedWith = async (h: ReturnType<typeof bench>, o: Parameters<ReturnType<typeof bench>['order']>[0], code: string, id = 'GACHE-1') => {
    const before = h.acks.length;
    await h.send(id, h.order({ id, ...o }));
    assert.equal(h.acks.length, before + 1, JSON.stringify(o));
    assert.deepEqual([h.last().ack.result, h.last().ack.code], ['refused', code], JSON.stringify(o));
  };

  it('action absente de la liste, y compris les noms de Object.prototype', async () => {
    const h = bench();
    const rec = h.attach();
    for (const action of ['open', 'on', 'constructor', 'valueof', 'hasownproperty', '__proto__', 'tostring', '__defineGetter__'.toLowerCase().slice(0, 16)]) {
      await refusedWith(h, { action }, 'not_allowed');
    }
    assert.equal(rec.calls.length, 0);
  });

  it('durationS au-dela de maxS refuse, egal a maxS accepte', async () => {
    const h = bench();
    const rec = h.attach();
    await refusedWith(h, { action: 'unlock', durationS: 11 }, 'not_allowed');
    await refusedWith(h, { action: 'unlock', durationS: 86_400 }, 'not_allowed');
    await h.send('GACHE-1', h.order({ action: 'unlock', durationS: 10 }));
    assert.equal(h.last().ack.result, 'done');
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].durationS, 10);
  });

  it('action a maxS : un ordre SANS duree est refuse, sauf unbounded', async () => {
    const h = bench({ specs: [spec({ actions: { unlock: { maxS: 10, unbounded: false }, on: { maxS: 600, unbounded: true }, off: { maxS: null, unbounded: false } }, rest: 'off' })] });
    const rec = h.attach();
    await refusedWith(h, { action: 'unlock' }, 'not_allowed');
    await h.send('GACHE-1', h.order({ action: 'on' }));
    assert.equal(h.last().ack.result, 'done');
    assert.equal(rec.calls[0].durationS, undefined);
    assert.equal(h.pilot.pendingRests().length, 0, 'sans duree : tenu jusqu\'a l\'ordre contraire, pas de minuteur');
    assert.ok(h.logger.has(/sans duree/), 'journalise');
    // ... mais avec duree, le plafond s'applique encore
    await refusedWith(h, { action: 'on', durationS: 601, ts: T0 + 1 }, 'not_allowed');
  });

  it('action instantanee (sans maxS) : un ordre AVEC durationS est refuse', async () => {
    const h = bench();
    const rec = h.attach();
    await refusedWith(h, { action: 'lock', durationS: 5 }, 'not_allowed');
    await h.send('GACHE-1', h.order({ action: 'lock' }));
    assert.equal(h.last().ack.result, 'done');
    assert.equal(rec.calls.length, 1);
  });

  it('issue de secours : « lock » refuse emergency_exit, meme si la table d\'actions a ete trafiquee en memoire', async () => {
    const tampered = spec({ emergencyExit: true, rest: null, actions: { unlock: { maxS: 10, unbounded: false }, lock: { maxS: null, unbounded: false } } });
    const h = bench({ specs: [tampered] });
    const rec = h.attach();
    await refusedWith(h, { action: 'lock' }, 'emergency_exit');
    assert.equal(rec.calls.length, 0);
    await h.send('GACHE-1', h.order({ action: 'unlock', durationS: 5, ts: T0 + 1 }));
    assert.equal(h.last().ack.result, 'done', 'unlock reste possible');
    assert.equal(h.pilot.pendingRests().length, 0, 'jamais de retour automatique sur une issue de secours');
    await h.advance(60_000);
    assert.deepEqual(rec.calls.map((c) => c.action), ['unlock']);
  });

  it('issue de secours et configuration trafiquee (rest = lock) : le retour au repos n\'appelle jamais « lock »', async () => {
    const h = bench({ specs: [spec({ emergencyExit: true, rest: 'lock' })] });
    const rec = h.attach();
    await h.send('GACHE-1', h.order({ action: 'unlock', durationS: 3 }));
    await h.advance(20_000);
    assert.deepEqual(rec.calls.map((c) => c.action), ['unlock']);
    assert.ok(h.logger.has(/abandonne/));
    assert.equal(h.pilot.pendingRests().length, 0);
  });

  it("le clip est transmis tel quel ; la requete est figee ; l'actionneur est celui du topic", async () => {
    const h = bench({ specs: [spec({ id: 'HP-1', actions: { play: { maxS: 60, unbounded: false }, stop: { maxS: null, unbounded: false } }, rest: 'stop' }), spec({ id: 'HP-2', key: KEY2, actions: { play: { maxS: 60, unbounded: false } }, rest: null })] });
    const rec = h.attach('HP-1');
    const rec2 = h.attach('HP-2');
    await h.send('HP-1', h.order({ id: 'HP-1', action: 'play', durationS: 20, clip: 'evacuation_fr-2' }));
    assert.deepEqual({ ...rec.calls[0] }, { actuatorId: 'HP-1', cmdId: h.acks[0].ack.cmdId, action: 'play', durationS: 20, clip: 'evacuation_fr-2' });
    assert.ok(Object.isFrozen(rec.calls[0]));
    // un ordre signe pour HP-1 livre sur le topic de HP-2 : signature fausse (l'id du topic fait foi)
    await h.send('HP-2', h.order({ id: 'HP-1', action: 'play', durationS: 20 }));
    assert.equal(rec2.calls.length, 0);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Regle 6 : execution, delai, resultats du module
// ------------------------------------------------------------------------------------------------------------------

describe('pilote : regles 6 et 7 (execution par le module, accuse)', () => {
  it('« done » : accuse signe avec le cmdId, l\'heure courante, sans code', async () => {
    const h = bench();
    const rec = h.attach();
    const o = h.order({ action: 'unlock', durationS: 5 });
    await h.send('GACHE-1', o);
    assert.deepEqual({ ...rec.calls[0] }, { actuatorId: 'GACHE-1', cmdId: o.cmdId, action: 'unlock', durationS: 5 });
    assert.equal(h.acks.length, 1);
    assert.equal(h.last().ack.result, 'done');
    assert.equal(h.last().ack.code, undefined);
    assert.equal(h.last().ack.ts, T0);
    assert.equal(JSON.parse(h.last().raw).v, 1);
    assert.equal(h.pilot.stats().executed, 1);
  });

  it('« refused » et « error » du module sont accuses tels quels, avec leur code', async () => {
    const h = bench();
    const rec = h.attach();
    rec.behavior = () => ({ result: 'refused', code: 'door_busy' });
    await h.send('GACHE-1', h.order({ action: 'lock' }));
    assert.deepEqual([h.last().ack.result, h.last().ack.code], ['refused', 'door_busy']);
    rec.behavior = () => ({ result: 'error', code: 'io' });
    await h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + 1 }));
    assert.deepEqual([h.last().ack.result, h.last().ack.code], ['error', 'io']);
    assert.deepEqual([h.pilot.stats().refused, h.pilot.stats().failed], [1, 1]);
  });

  it('code du module assaini : ^[a-z0-9_]{1,32}$ sinon « other »', async () => {
    const h = bench();
    const rec = h.attach();
    let ts = T0;
    const codes: [unknown, string | undefined][] = [
      ['ok_code1', 'ok_code1'],
      ['Mauvais Code!', 'other'],
      ['x'.repeat(33), 'other'],
      ['x'.repeat(32), 'x'.repeat(32)],
      ['', 'other'],
      ['a|b', 'other'],
      ['a\nb', 'other'],
      [42, 'other'],
      [{ toString: () => 'abc' }, 'other'],
      [['a'], 'other'],
      [undefined, undefined],
      [null, undefined],
    ];
    for (const [code, expected] of codes) {
      rec.behavior = () => ({ result: 'error', code }) as unknown as ActuatorOutcome;
      await h.send('GACHE-1', h.order({ action: 'lock', ts: ++ts }));
      assert.equal(h.last().ack.code, expected, JSON.stringify(code));
    }
  });

  it('reponse invalide du module (pas d objet, result inconnu) : « error / bad_result »', async () => {
    const h = bench();
    const rec = h.attach();
    let ts = T0;
    for (const bad of [undefined, null, 'done', 42, {}, { result: 'ok' }, { result: 'DONE' }, { result: 5 }]) {
      rec.behavior = () => bad as unknown as ActuatorOutcome;
      await h.send('GACHE-1', h.order({ action: 'lock', ts: ++ts }));
      assert.deepEqual([h.last().ack.result, h.last().ack.code], ['error', 'bad_result'], JSON.stringify(bad));
    }
  });

  it('exception synchrone et rejet du module : « error / exception », texte assaini dans le journal', async () => {
    const h = bench();
    const rec = h.attach();
    rec.behavior = () => {
      throw new Error('boum\nfausse ligne [info] cle=' + 'a'.repeat(10));
    };
    await h.send('GACHE-1', h.order({ action: 'lock' }));
    assert.deepEqual([h.last().ack.result, h.last().ack.code], ['error', 'exception']);
    rec.behavior = () => Promise.reject(new Error('refus asynchrone'));
    await h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + 1 }));
    assert.deepEqual([h.last().ack.result, h.last().ack.code], ['error', 'exception']);
    rec.behavior = () => Promise.reject('texte brut');
    await h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + 2 }));
    assert.equal(h.last().ack.code, 'exception');
    assertNoSecrets(h.logger);
    assert.ok(h.logger.has(/boum fausse ligne/));
  });

  it('gestionnaire qui ne repond pas : « error / timeout » au bout de 4 s (delai parametrable), reponse tardive ignoree', async () => {
    const h = bench();
    const rec = h.attach();
    rec.behavior = () => h.sleep(60_000).then(() => ({ result: 'done' }) as ActuatorOutcome);
    const p = h.send('GACHE-1', h.order({ action: 'lock' }));
    await h.advance(3999);
    assert.equal(h.acks.length, 0, 'pas encore');
    await h.advance(1);
    await p;
    assert.deepEqual([h.last().ack.result, h.last().ack.code], ['error', 'timeout']);
    await h.advance(60_000);
    assert.equal(h.acks.length, 1, 'la reponse tardive du module n\'ajoute rien');

    const short = bench({ handlerTimeoutMs: 250 });
    const r2 = short.attach();
    r2.behavior = () => short.sleep(10_000).then(() => ({ result: 'done' }) as ActuatorOutcome);
    const p2 = short.send('GACHE-1', short.order({ action: 'lock' }));
    await short.advance(250);
    await p2;
    assert.equal(short.last().ack.code, 'timeout');
  });

  it('rejet tardif d\'un gestionnaire deja en delai : pas de rejet non gere', async () => {
    const h = bench();
    const rec = h.attach();
    rec.behavior = () => h.sleep(5000).then(() => Promise.reject(new Error('trop tard')));
    const p = h.send('GACHE-1', h.order({ action: 'lock' }));
    await h.advance(4000);
    await p;
    await h.advance(2000); // le rejet arrive : doit etre absorbe
    assert.equal(h.acks.length, 1);
  });

  it('aucun gestionnaire (module arrete) : refused/unavailable', async () => {
    const h = bench();
    await h.send('GACHE-1', h.order({ action: 'lock' }));
    assert.deepEqual([h.last().ack.result, h.last().ack.code], ['refused', 'unavailable']);
    const rec = h.attach();
    rec.off();
    await h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + 1 }));
    assert.equal(h.last().ack.code, 'unavailable', 'gestionnaire retire');
    assert.equal(h.pilot.hasHandler('GACHE-1'), false);
  });

  it('register : deux fois refuse, retrait d\'un ancien gestionnaire sans effet sur le nouveau', () => {
    const h = bench();
    const first = h.pilot.register('GACHE-1', async () => ({ result: 'done' }));
    assert.throws(() => h.pilot.register('GACHE-1', async () => ({ result: 'done' })), /deja enregistre/);
    assert.throws(() => h.pilot.register('INCONNU', async () => ({ result: 'done' })), /non configure/);
    first();
    assert.equal(h.pilot.hasHandler('GACHE-1'), false);
    const second = h.pilot.register('GACHE-1', async () => ({ result: 'done' }));
    first(); // l'ancien retrait ne retire pas le nouveau
    assert.equal(h.pilot.hasHandler('GACHE-1'), true);
    second();
  });

  it("accuse impossible a remettre (liaison coupee, exception) : perdu et journalise, JAMAIS retente, ordre jamais rejoue", async () => {
    const h = bench();
    const rec = h.attach();
    h.net.up = false;
    const o = h.order({ action: 'lock' });
    await h.send('GACHE-1', o);
    assert.equal(rec.calls.length, 1, 'l\'ordre est execute');
    assert.equal(h.acks.length, 0);
    assert.equal(h.net.published, 1, 'une seule tentative');
    assert.ok(h.logger.has(/PERDU/));
    h.net.throws = true;
    await h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + 1 }));
    assert.equal(h.pilot.stats().acksLost, 2);
    h.net.up = true;
    h.net.throws = false;
    await h.advance(120_000);
    assert.equal(h.acks.length, 0, 'aucun accuse en retard');
    assert.equal(rec.calls.length, 2, 'aucun ordre rejoue');
    await h.send('GACHE-1', o); // le PSIM (ou l'attaquant) renvoie : toujours ignore
    assert.equal(rec.calls.length, 2);
  });

  it('un seul ordre a la fois par actionneur, dans l\'ordre d\'arrivee', async () => {
    const h = bench();
    const rec = h.attach();
    rec.behavior = async (req) => {
      await h.sleep(1000);
      return { result: 'done' };
    };
    const a = h.send('GACHE-1', h.order({ action: 'unlock', durationS: 5, ts: T0 }));
    const b = h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + 1, ttlS: 30 }));
    await h.advance(2500);
    await Promise.all([a, b]);
    assert.deepEqual(rec.calls.map((c) => c.action), ['unlock', 'lock']);
    assert.equal(rec.maxConcurrent, 1);
    assert.deepEqual(h.acks.map((x) => x.ack.result), ['done', 'done']);
  });

  it("un ordre qui attend son tour derriere un gestionnaire lent et devient perime n'est PAS execute", async () => {
    const h = bench();
    const rec = h.attach();
    rec.behavior = async () => {
      await h.sleep(3500);
      return { result: 'done' };
    };
    const a = h.send('GACHE-1', h.order({ action: 'lock', ts: T0, ttlS: 10 }));
    const b = h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + 1, ttlS: 2 })); // ttl 2 s : perime des T0 + 2001
    await h.advance(8000);
    await Promise.all([a, b]);
    assert.equal(rec.calls.length, 1);
    assert.deepEqual([h.last().ack.result, h.last().ack.code], ['refused', 'stale']);
  });

  it('file d attente bornee : au-dela de 8 ordres en attente, refused/busy immediat', async () => {
    const h = bench();
    const rec = h.attach();
    rec.behavior = () => h.sleep(100_000).then(() => ({ result: 'done' }) as ActuatorOutcome);
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) pending.push(h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + i, ttlS: 30 })));
    await h.flush();
    assert.deepEqual(h.acks.map((x) => x.ack.code), ['busy', 'busy'], 'les 2 derniers sont refuses tout de suite');
    await h.advance(40_000);
    await Promise.all(pending);
  });

  it("une publication d'accuse qui traine ne retarde PAS l'ordre suivant du meme actionneur", async () => {
    const h = bench();
    const rec = h.attach();
    h.net.hang = true;
    const a = h.send('GACHE-1', h.order({ action: 'lock', ts: T0 }));
    const b = h.send('GACHE-1', h.order({ action: 'lock', ts: T0 + 1 }));
    await h.flush();
    assert.equal(rec.calls.length, 2, 'les deux ordres sont executes sans attendre les accuses');
    h.net.hang = false;
    h.net.release();
    await Promise.all([a, b]);
    assert.equal(h.acks.length, 2);
  });

  it('arret du pilote : plus aucun ordre accepte', async () => {
    const h = bench();
    const rec = h.attach();
    await h.pilot.stop();
    await h.send('GACHE-1', h.order({ action: 'lock' }));
    assert.equal(rec.calls.length, 0);
    assert.equal(h.acks.length, 0);
    await h.pilot.stop(); // idempotent
  });

  it('jamais de secret dans le journal, quel que soit le parcours', async () => {
    const h = bench();
    const rec = h.attach();
    await h.send('GACHE-1', h.order({ action: 'unlock', durationS: 5 }));
    await h.send('GACHE-1', { ...h.order({ action: 'lock' }), sig: 'e'.repeat(64) });
    await h.send('GACHE-1', h.order({ action: 'zzz', ts: T0 + 5 }));
    rec.behavior = () => ({ result: 'error' });
    await h.advance(6000);
    await h.pilot.stop();
    assert.ok(h.logger.lines.length > 3);
    assertNoSecrets(h.logger);
    for (const l of h.logger.lines) assert.ok(!l.text.includes(KEY));
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Regle 6 : retour LOCAL au repos
// ------------------------------------------------------------------------------------------------------------------

describe('pilote : retour local au repos au bout de durationS', () => {
  it('« unlock 5 s » : rien avant 5 s, puis « lock » (cmdId « <id>:rest », sans durationS), liaison PSIM coupee ou non', async () => {
    const h = bench();
    const rec = h.attach();
    h.net.up = false; // liaison coupee : le retour au repos ne depend de rien
    const o = h.order({ action: 'unlock', durationS: 5 });
    await h.send('GACHE-1', o);
    assert.equal(h.pilot.pendingRests().length, 1);
    assert.equal(h.pilot.pendingRests()[0].dueAt, T0 + 5000);
    await h.advance(4999);
    assert.equal(rec.calls.length, 1);
    await h.advance(1);
    assert.equal(rec.calls.length, 2);
    assert.deepEqual({ ...rec.calls[1] }, { actuatorId: 'GACHE-1', cmdId: `${o.cmdId}:rest`, action: 'lock' });
    assert.equal(h.pilot.pendingRests().length, 0);
    assert.equal(h.acks.length, 0, 'le retour local n\'est pas accuse (pas de cmdId connu du PSIM)');
    assert.ok(h.logger.has(/retour au repos « lock » fait/));
    await h.advance(60_000);
    assert.equal(rec.calls.length, 2, 'une seule fois');
  });

  it("l'echeance part de l'instant d'execution, meme si le module met du temps a repondre", async () => {
    const h = bench();
    const rec = h.attach();
    rec.behavior = async () => {
      await h.sleep(1500);
      return { result: 'done' };
    };
    const p = h.send('GACHE-1', h.order({ action: 'unlock', durationS: 5 }));
    await h.advance(1500);
    await p;
    assert.equal(h.pilot.pendingRests()[0].dueAt, T0 + 5000, 'T0 + 5 s, pas T0 + 1,5 s + 5 s');
    await h.advance(3500);
    assert.deepEqual(rec.calls.map((c) => c.action), ['unlock', 'lock']);
  });

  it('module en erreur, en delai, en exception : le minuteur est arme QUAND MEME (etat inconnu)', async () => {
    for (const behavior of [
      () => ({ result: 'error', code: 'io' }) as ActuatorOutcome,
      () => {
        throw new Error('x');
      },
      () => Promise.reject(new Error('y')),
      () => new Promise<ActuatorOutcome>(() => undefined), // ne repond jamais
    ]) {
      const h = bench();
      const rec = h.attach();
      rec.behavior = behavior;
      const p = h.send('GACHE-1', h.order({ action: 'unlock', durationS: 10 }));
      await h.advance(4000);
      await p;
      assert.equal(h.pilot.pendingRests().length, 1, 'minuteur arme');
      rec.behavior = async () => ({ result: 'done' });
      await h.advance(6000);
      assert.equal(rec.calls.at(-1)?.action, 'lock');
      assert.equal(h.pilot.pendingRests().length, 0);
    }
  });

  it('module qui REFUSE : rien n\'a ete fait, pas de minuteur ; la temporisation precedente reste', async () => {
    const h = bench();
    const rec = h.attach();
    await h.send('GACHE-1', h.order({ action: 'unlock', durationS: 10, ts: T0 }));
    await h.advance(3000);
    rec.behavior = () => ({ result: 'refused', code: 'busy' });
    await h.send('GACHE-1', h.order({ action: 'unlock', durationS: 10 }));
    assert.equal(h.pilot.pendingRests().length, 1);
    assert.equal(h.pilot.pendingRests()[0].dueAt, T0 + 10_000, 'minuteur de l\'ordre precedent conserve');
    rec.behavior = async () => ({ result: 'done' });
    await h.advance(7000);
    assert.equal(rec.calls.at(-1)?.action, 'lock');
    const only = bench();
    const r2 = only.attach();
    r2.behavior = () => ({ result: 'refused' });
    await only.send('GACHE-1', only.order({ action: 'unlock', durationS: 10 }));
    assert.equal(only.pilot.pendingRests().length, 0);
  });

  it('un nouvel ordre ACCEPTE remplace la temporisation ; un ordre refuse par le socle ne l\'annule pas', async () => {
    const h = bench();
    const rec = h.attach();
    await h.send('GACHE-1', h.order({ action: 'unlock', durationS: 10, ts: T0 }));
    await h.advance(4000);
    // refuse par le socle (plafond) : le minuteur d'origine reste
    await h.send('GACHE-1', h.order({ action: 'unlock', durationS: 11 }));
    assert.equal(h.last().ack.code, 'not_allowed');
    assert.equal(h.pilot.pendingRests()[0].dueAt, T0 + 10_000);
    // accepte : remplace (nouvelle echeance = maintenant + 10 s = T0 + 14 s)
    await h.send('GACHE-1', h.order({ action: 'unlock', durationS: 10 }));
    assert.equal(h.pilot.pendingRests()[0].dueAt, T0 + 14_000);
    await h.advance(6000); // T0 + 10 s : l'ancienne echeance ne fait plus rien
    assert.deepEqual(rec.calls.map((c) => c.action), ['unlock', 'unlock']);
    await h.advance(4000);
    assert.deepEqual(rec.calls.map((c) => c.action), ['unlock', 'unlock', 'lock']);
    await h.advance(60_000);
    assert.equal(rec.calls.length, 3, 'un seul retour');
  });

  it("l'ordre « lock » (le repos lui-meme) annule le minuteur : pas de second « lock »", async () => {
    const h = bench();
    const rec = h.attach();
    await h.send('GACHE-1', h.order({ action: 'unlock', durationS: 10 }));
    await h.advance(2000);
    await h.send('GACHE-1', h.order({ action: 'lock' }));
    assert.equal(h.pilot.pendingRests().length, 0);
    await h.advance(60_000);
    assert.deepEqual(rec.calls.map((c) => c.action), ['unlock', 'lock']);
  });

  it('sans « rest » (portail, barriere) : aucun retour automatique', async () => {
    const h = bench({ specs: [spec({ id: 'PORTAIL-1', actions: { open: { maxS: 10, unbounded: false }, close: { maxS: 10, unbounded: false }, stop: { maxS: null, unbounded: false } }, rest: null })] });
    const rec = h.attach('PORTAIL-1');
    await h.send('PORTAIL-1', h.order({ id: 'PORTAIL-1', action: 'open', durationS: 5 }));
    assert.equal(h.pilot.pendingRests().length, 0);
    await h.advance(120_000);
    assert.deepEqual(rec.calls.map((c) => c.action), ['open']);
  });

  it('plusieurs actionneurs : chacun son minuteur, sans interference', async () => {
    const h = bench({ specs: [spec(), spec({ id: 'GACHE-2', key: KEY2 })] });
    const a = h.attach('GACHE-1');
    const b = h.attach('GACHE-2');
    await h.send('GACHE-1', h.order({ id: 'GACHE-1', action: 'unlock', durationS: 5 }));
    await h.send('GACHE-2', h.order({ id: 'GACHE-2', action: 'unlock', durationS: 8 }));
    await h.advance(5000);
    assert.deepEqual([a.calls.length, b.calls.length], [2, 1]);
    await h.advance(3000);
    assert.deepEqual([a.calls.length, b.calls.length], [2, 2]);
  });

  it('repos qui echoue : reessais toutes les 5 s, journal d\'erreur a chaque echec, puis succes', async () => {
    const h = bench();
    const rec = h.attach();
    await h.send('GACHE-1', h.order({ action: 'unlock', durationS: 5 }));
    let fails = 3;
    rec.behavior = (req) => (req.action === 'lock' && fails-- > 0 ? { result: 'error', code: 'io' } : { result: 'done' });
    await h.advance(5000); // essai 1 : echec
    assert.equal(rec.calls.filter((c) => c.action === 'lock').length, 1);
    await h.advance(4999);
    assert.equal(rec.calls.filter((c) => c.action === 'lock').length, 1, 'pas avant 5 s');
    await h.advance(1);
    assert.equal(rec.calls.filter((c) => c.action === 'lock').length, 2);
    await h.advance(5000);
    assert.equal(rec.calls.filter((c) => c.action === 'lock').length, 3);
    await h.advance(5000); // 4e : succes
    assert.equal(rec.calls.filter((c) => c.action === 'lock').length, 4);
    assert.equal(h.pilot.pendingRests().length, 0);
    assert.equal(h.logger.lines.filter((l) => l.level === 'error' && /ECHOUE/.test(l.text)).length, 3, 'une ligne d\'erreur par echec');
    await h.advance(60_000);
    assert.equal(rec.calls.filter((c) => c.action === 'lock').length, 4);
  });

  it('repos qui echoue toujours : 1 appel + 20 reessais au plus, puis abandon journalise', async () => {
    const h = bench();
    const rec = h.attach();
    await h.send('GACHE-1', h.order({ action: 'unlock', durationS: 5 }));
    rec.behavior = (req) => (req.action === 'lock' ? { result: 'error', code: 'io' } : { result: 'done' });
    await h.advance(5000 + 20 * 5000 + 60_000);
    assert.equal(rec.calls.filter((c) => c.action === 'lock').length, 21);
    assert.ok(h.logger.has(/ABANDONNE/));
    assert.equal(h.pilot.pendingRests().length, 0);
    assert.equal(h.timers.size, 0, 'plus aucun minuteur');
  });

  it('repos refuse par le module, repos en delai : meme traitement qu\'un echec', async () => {
    const h = bench({ restRetryMs: 1000, restRetries: 2 });
    const rec = h.attach();
    await h.send('GACHE-1', h.order({ action: 'unlock', durationS: 1 }));
    rec.behavior = (req) => (req.action === 'lock' ? ({ result: 'refused' } as ActuatorOutcome) : { result: 'done' });
    await h.advance(1000 + 2000 + 1000);
    assert.equal(rec.calls.filter((c) => c.action === 'lock').length, 3, '1 + 2 reessais (parametrables)');
  });

  it('un nouvel ordre accepte pendant les reessais du repos les arrete', async () => {
    const h = bench();
    const rec = h.attach();
    await h.send('GACHE-1', h.order({ action: 'unlock', durationS: 2 }));
    rec.behavior = (req) => (req.action === 'lock' ? { result: 'error' } : { result: 'done' });
    await h.advance(2000 + 5000); // 2 appels du repos
    assert.equal(rec.calls.filter((c) => c.action === 'lock').length, 2);
    rec.behavior = async () => ({ result: 'done' });
    await h.send('GACHE-1', h.order({ action: 'unlock', durationS: 10 }));
    await h.advance(9000); // au-dela du reessai prevu a +12 s (ancien repos) : annule
    assert.equal(rec.calls.filter((c) => c.action === 'lock').length, 2, 'les reessais ont cesse');
    await h.advance(1000);
    assert.equal(rec.calls.filter((c) => c.action === 'lock').length, 3, 'le nouveau repos part a son heure');
  });

  it('repos echu alors que le module est arrete : reessais ; au retour du module, essai immediat', async () => {
    const h = bench();
    const rec = h.attach();
    await h.send('GACHE-1', h.order({ action: 'unlock', durationS: 3 }));
    rec.off(); // le module s'arrete / redemarre
    await h.advance(3000);
    assert.equal(h.pilot.pendingRests().length, 1);
    assert.ok(h.logger.has(/aucun module n'a enregistre/));
    await h.advance(7000);
    assert.equal(h.pilot.pendingRests()[0].attempts, 2, 'essais a 3 s et 8 s');
    const back = h.attach(); // le module revient entre deux essais
    await h.flush();
    assert.deepEqual(back.calls.map((c) => c.action), ['lock'], 'sans attendre les 5 s');
    assert.equal(h.pilot.pendingRests().length, 0);
  });

  it('arret de la passerelle : le repos est appele UNE fois pour les minuteurs en cours, puis plus rien', async () => {
    const h = bench({ specs: [spec(), spec({ id: 'GACHE-2', key: KEY2 })] });
    const a = h.attach('GACHE-1');
    const b = h.attach('GACHE-2');
    await h.send('GACHE-1', h.order({ id: 'GACHE-1', action: 'unlock', durationS: 10 }));
    await h.send('GACHE-2', h.order({ id: 'GACHE-2', action: 'lock' })); // pas de minuteur
    await h.pilot.stop();
    assert.deepEqual(a.calls.map((c) => c.action), ['unlock', 'lock']);
    assert.deepEqual(b.calls.map((c) => c.action), ['lock']);
    assert.equal(h.timers.size, 0);
    await h.advance(300_000);
    assert.equal(a.calls.length, 2);
  });

  it("arret : repos en echec = conserve dans le fichier d'etat et repris au demarrage suivant", async () => {
    const dir = tempDir(cleanup);
    const stateFile = join(dir, 'etat.json');
    const a = bench({ stateFile });
    const recA = a.attach();
    await a.send('GACHE-1', a.order({ action: 'unlock', durationS: 10 }));
    recA.behavior = (req) => (req.action === 'lock' ? { result: 'error', code: 'io' } : { result: 'done' });
    await a.pilot.stop();
    assert.ok(a.logger.has(/ECHOUE/));
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).rest['GACHE-1'].action, 'lock');
    // redemarrage
    const b = bench({ stateFile, startAt: T0 + 2000 });
    assert.equal(b.pilot.pendingRests().length, 1, 'repos repris');
    const recB = b.attach();
    await b.advance(0);
    assert.deepEqual(recB.calls.map((c) => c.action), ['lock'], 'immediatement, sans attendre la duree d\'origine');
    assert.equal(b.pilot.pendingRests().length, 0);
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).rest['GACHE-1'], undefined, 'efface une fois fait');
  });

  it("redemarrage avec un repos programme dont l'action a change dans la configuration : abandonne", async () => {
    const dir = tempDir(cleanup);
    const stateFile = join(dir, 'etat.json');
    writeFileSync(stateFile, JSON.stringify({ v: 1, seen: {}, lastTs: {}, rest: { 'GACHE-1': { action: 'unlock', cmdId: 'abc', dueAt: T0 } } }));
    const h = bench({ stateFile });
    assert.equal(h.pilot.pendingRests().length, 0);
  });

  it('retour au repos programme, puis ecart d\'horloge : echeance deja passee => immediat ; trop lointaine => bornee a 24 h', async () => {
    const dir = tempDir(cleanup);
    const stateFile = join(dir, 'etat.json');
    writeFileSync(stateFile, JSON.stringify({ v: 1, seen: {}, lastTs: {}, rest: { 'GACHE-1': { action: 'lock', cmdId: 'abc', dueAt: T0 + 10 * 86_400_000 } } }));
    const h = bench({ stateFile });
    assert.equal(h.pilot.pendingRests()[0].dueAt, T0 + 86_400_000);
  });

  it("la reponse du module a un ordre « tenu » (unbounded) n'arme pas de minuteur", async () => {
    const h = bench({ specs: [spec({ id: 'SIR-1', actions: { on: { maxS: 120, unbounded: true }, off: { maxS: null, unbounded: false } }, rest: 'off' })] });
    h.attach('SIR-1');
    await h.send('SIR-1', h.order({ id: 'SIR-1', action: 'on' }));
    assert.equal(h.pilot.pendingRests().length, 0);
    assert.equal(h.timers.size, 0);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------------------------------------------------------

describe('configuration : section actuators', () => {
  const base = (extra: Record<string, unknown> = {}) => ({
    psim: { url: 'mqtt://127.0.0.1:1883', username: 'gw1', password: GW_PASSWORD },
    modules: [
      { name: 'door', config: { key: 'x' } },
      { name: 'probe', label: 'sonde', config: { key: 'y' } },
      { name: 'probe', label: 'coupee', enabled: false, config: { key: 'z' } },
    ],
    ...extra,
  });
  const act = (over: Record<string, unknown> = {}) => ({
    id: 'GACHE-1',
    key: KEY,
    module: 'door',
    actions: { unlock: { maxS: 10 }, lock: {} },
    rest: 'lock',
    emergencyExit: false,
    ...over,
  });
  function errorsOf(dir: string, cfg: unknown, env: NodeJS.ProcessEnv = {}): string[] {
    const file = writeConfig(dir, cfg as Record<string, unknown>);
    try {
      loadConfig(file, { env, modulesDir: FIXTURES });
    } catch (err) {
      assert.ok(err instanceof ConfigError, String(err));
      return err.errors;
    }
    return [];
  }
  const load = (dir: string, cfg: unknown, env: NodeJS.ProcessEnv = {}) => loadConfig(writeConfig(dir, cfg as Record<string, unknown>), { env, modulesDir: FIXTURES });

  it('sans section : liste vide ; configuration complete lue telle quelle', () => {
    const dir = tempDir(cleanup);
    assert.deepEqual(load(dir, base()).actuators, []);
    const c = load(dir, base({ actuators: [act(), act({ id: 'PORTAIL-1', key: KEY2, module: 'sonde', actions: { open: { maxS: 10 }, close: { maxS: 10 }, stop: {} }, rest: undefined, emergencyExit: undefined })] }));
    assert.equal(c.actuators.length, 2);
    assert.deepEqual(c.actuators[0], {
      id: 'GACHE-1',
      key: KEY,
      keySource: 'fichier de configuration',
      module: 'door',
      actions: { unlock: { maxS: 10, unbounded: false }, lock: { maxS: null, unbounded: false } },
      rest: 'lock',
      emergencyExit: false,
    });
    assert.equal(c.actuators[1].rest, null);
    assert.equal(c.actuators[1].emergencyExit, false);
    assert.equal(c.actuators[1].module, 'sonde', 'etiquette (label) du module');
  });

  it('cle : keyFile (relatif au fichier de configuration, fin de ligne retiree), keyEnv, key ; majuscules ramenees en minuscules', () => {
    const dir = tempDir(cleanup);
    mkdirSync(join(dir, 'secrets'));
    writeFileSync(join(dir, 'secrets', 'gache-1.key'), `${KEY}\r\n`);
    const c = load(dir, base({ actuators: [act({ key: undefined, keyFile: 'secrets/gache-1.key' }), act({ id: 'A-2', key: undefined, keyEnv: 'CLE_A2' })] }), { CLE_A2: KEY2.toUpperCase() });
    assert.equal(c.actuators[0].key, KEY);
    assert.equal(c.actuators[0].keySource, `fichier ${join(dir, 'secrets', 'gache-1.key')}`);
    assert.equal(c.actuators[1].key, KEY2);
    assert.equal(c.actuators[1].keySource, 'variable CLE_A2');
    for (const a of c.actuators) assert.ok(!a.keySource.includes(a.key), 'la source affichable ne contient jamais la cle');
  });

  it('toutes les erreurs sont listees d\'un coup, sans jamais afficher une cle', () => {
    const dir = tempDir(cleanup);
    const secret = 'ab'.repeat(32);
    const errs = errorsOf(
      dir,
      base({
        actuators: [
          act({ id: 'mauvais id!' }),
          act({ id: 'DEJA', key: secret }),
          act({ id: 'DEJA', key: secret }), // id double ET meme cle
          act({ id: 'COURTE', key: 'abcd' }),
          act({ id: 'PASHEX', key: 'zz'.repeat(32) }),
          act({ id: 'TRIVIALE', key: '0'.repeat(64) }),
          act({ id: 'SANSCLE', key: undefined }),
          act({ id: 'DEUXCLES', keyEnv: 'X', key: KEY2 }),
          act({ id: 'ENVABSENT', key: undefined, keyEnv: 'ABSENTE' }),
          act({ id: 'FICHIER', key: undefined, keyFile: 'nexiste/pas.key' }),
          act({ id: 'MODABSENT', key: '12'.repeat(32), module: 'nexiste' }),
          act({ id: 'MODCOUPE', key: '34'.repeat(32), module: 'coupee' }), // module desactive : accepte
          act({ id: 'INCONNUE', key: '56'.repeat(32), colour: 1 }),
        ],
      }),
    );
    const text = errs.join('\n');
    for (const re of [/id : 1 a 32/, /apparait deux fois/, /meme cle que l'actionneur/, /64 caracteres hexadecimaux/, /cle triviale/, /UNE source de cle/, /ABSENTE est absente/, /keyFile : lecture impossible/, /aucun module d'etiquette « nexiste »/, /cle inconnue « colour »/]) {
      assert.match(text, re);
    }
    assert.doesNotMatch(text, /MODCOUPE/, 'un module desactive reste un module declare');
    assert.ok(errs.length >= 10, `toutes les erreurs : ${errs.length}`);
    for (const k of [secret, KEY, KEY2, 'zz'.repeat(32), 'abcd']) assert.ok(!text.includes(k), 'aucune cle dans les erreurs');
  });

  it('actions : noms, plafonds, unbounded, nombre', () => {
    const dir = tempDir(cleanup);
    const bad = (actions: unknown) => errorsOf(dir, base({ actuators: [act({ actions, rest: undefined })] }));
    assert.match(bad(undefined).join('|'), /actions : objet attendu/);
    assert.match(bad([]).join('|'), /actions : objet attendu/);
    assert.match(bad('x').join('|'), /actions : objet attendu/);
    assert.match(bad({}).join('|'), /au moins une action/);
    assert.match(bad(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`a${'_'.repeat(i + 1)}`, {}]))).join('|'), /16 actions au plus/);
    for (const name of ['Unlock', 'a1', 'a b', 'a-b', 'x'.repeat(17), 'ouvriré']) assert.match(bad({ [name]: {} }).join('|'), /nom d'action invalide/, name);
    assert.match(bad({ unlock: 5 }).join('|'), /objet attendu/);
    assert.match(bad({ unlock: null }).join('|'), /objet attendu/);
    assert.match(bad({ unlock: [] }).join('|'), /objet attendu/);
    assert.match(bad({ unlock: { color: 1 } }).join('|'), /cle inconnue « color »/);
    for (const maxS of [0, -1, 86_401, 1.5, '10', null, true]) assert.match(bad({ unlock: { maxS } }).join('|'), /maxS : entier entre 1 et 86400/, String(maxS));
    assert.deepEqual(bad({ unlock: { maxS: 1 }, a: { maxS: 86_400 } }), [], 'bornes incluses');
    for (const unbounded of ['oui', 1, null]) assert.match(bad({ on: { maxS: 5, unbounded } }).join('|'), /unbounded : true ou false/);
    assert.match(bad({ on: { unbounded: true } }).join('|'), /unbounded : n'a de sens qu'avec maxS/);
    assert.deepEqual(bad({ on: { maxS: 5, unbounded: true } }), []);
  });

  it('actions sans heritage de Object.prototype : « constructor » et « __proto__ » sont de simples donnees', () => {
    const dir = tempDir(cleanup);
    const file = join(dir, 'proto.json');
    writeFileSync(file, `{"psim":{"url":"mqtt://127.0.0.1:1883","username":"gw1","password":"${GW_PASSWORD}"},"modules":[{"name":"door"}],"actuators":[{"id":"A-1","key":"${KEY}","module":"door","actions":{"__proto__":{"maxS":5},"constructor":{}}}]}`);
    const c = loadConfig(file, { modulesDir: FIXTURES });
    const actions = c.actuators[0].actions;
    assert.equal(Object.getPrototypeOf(actions), Object.prototype, 'prototype intact');
    assert.ok(Object.hasOwn(actions, '__proto__'));
    assert.ok(Object.hasOwn(actions, 'constructor'));
    assert.equal(({} as Record<string, unknown>).maxS, undefined);
    // une action absente ne « trouve » rien chez Object.prototype
    const sans = load(dir, base({ actuators: [act()] })).actuators[0];
    assert.ok(!Object.hasOwn(sans.actions, 'constructor'));
    assert.ok(!Object.hasOwn(sans.actions, 'toString'));
  });

  it("repos (rest) : doit exister dans actions, sans maxS ; absent ou null = aucun retour", () => {
    const dir = tempDir(cleanup);
    const bad = (rest: unknown) => errorsOf(dir, base({ actuators: [act({ rest })] }));
    assert.match(bad('absente').join('|'), /doit figurer dans « actions »/);
    assert.match(bad('constructor').join('|'), /doit figurer dans « actions »/);
    assert.match(bad('Lock').join('|'), /nom de l'action de repos/);
    assert.match(bad(5).join('|'), /nom de l'action de repos/);
    assert.match(bad('unlock').join('|'), /pas de maxS/);
    assert.deepEqual(bad(null), []);
    assert.deepEqual(bad(undefined), []);
    assert.equal(load(dir, base({ actuators: [act({ rest: null })] })).actuators[0].rest, null);
  });

  it('issue de secours : « lock » interdit dans actions et comme repos', () => {
    const dir = tempDir(cleanup);
    const errs = errorsOf(dir, base({ actuators: [act({ emergencyExit: true })] }));
    assert.match(errs.join('|'), /issue de secours.*« lock » est interdite/);
    assert.match(errs.join('|'), /rest : issue de secours/);
    assert.deepEqual(errorsOf(dir, base({ actuators: [act({ emergencyExit: true, actions: { unlock: { maxS: 10 } }, rest: undefined })] })), []);
    assert.equal(load(dir, base({ actuators: [act({ emergencyExit: true, actions: { unlock: { maxS: 10 } }, rest: undefined })] })).actuators[0].emergencyExit, true);
    assert.match(errorsOf(dir, base({ actuators: [act({ emergencyExit: 'oui' })] })).join('|'), /emergencyExit : true ou false/);
    // sans emergencyExit, « lock » est bien permis
    assert.deepEqual(errorsOf(dir, base({ actuators: [act()] })), []);
  });

  it('forme generale : liste, objets, cle inconnue a la racine, trop d\'actionneurs', () => {
    const dir = tempDir(cleanup);
    assert.match(errorsOf(dir, base({ actuators: {} })).join('|'), /actuators : liste attendue/);
    assert.match(errorsOf(dir, base({ actuators: 'x' })).join('|'), /actuators : liste attendue/);
    assert.match(errorsOf(dir, base({ actuators: [null, 5, []] })).join('|'), /actuators\[0\] : objet attendu/);
    assert.match(errorsOf(dir, base({ actuators: Array.from({ length: 257 }, () => act()) })).join('|'), /256 actionneurs au plus/);
    assert.match(errorsOf(dir, { ...base(), actuator: [] }).join('|'), /cle inconnue « actuator »/);
    assert.match(errorsOf(dir, base({ actuators: [act({ module: 5 })] })).join('|'), /module : etiquette/);
    assert.match(errorsOf(dir, base({ actuators: [act({ module: undefined })] })).join('|'), /module : etiquette/);
    assert.match(errorsOf(dir, base({ actuators: [act({ key: 12 })] })).join('|'), /key : texte/);
    assert.match(errorsOf(dir, base({ actuators: [act({ key: undefined, keyEnv: 7 })] })).join('|'), /keyEnv : nom de variable/);
    assert.match(errorsOf(dir, base({ actuators: [act({ key: undefined, keyFile: '' })] })).join('|'), /keyFile : chemin attendu/);
    mkdirSync(join(dir, 's'));
    writeFileSync(join(dir, 's', 'vide.key'), '\n');
    assert.match(errorsOf(dir, base({ actuators: [act({ key: undefined, keyFile: 's/vide.key' })] })).join('|'), /est vide/);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// ctx.onActuator dans le socle
// ------------------------------------------------------------------------------------------------------------------

describe('socle : ctx.onActuator', () => {
  let counter = 0;
  /** Passerelle sans broker (la liaison PSIM reessaie dans le vide) avec des modules « door » factices. */
  async function gateway(modules: { label: string; key: string; actuators?: string[]; twice?: boolean; failTimes?: number }[], actuators: unknown[], dir = tempDir(cleanup)) {
    const port = await freePort();
    const cfg = testConfig(
      dir,
      port,
      modules.map((m) => ({ name: 'door', label: m.label, config: { key: m.key, actuators: m.actuators ?? [], twice: m.twice, failTimes: m.failTimes } })),
      { actuators },
    );
    const logger = memoryLogger();
    const rt = await startRuntime({ config: cfg, logger, modulesDir: FIXTURES, actuators: { restRetryMs: 100 } });
    cleanup.push(() => rt.stop());
    return { rt, logger, dir, port };
  }
  const key = () => `onact-${++counter}-${process.pid}`;
  let seq = 0;
  const order = (action: string, o: { durationS?: number; id?: string; ts?: number; ttlS?: number } = {}) => {
    const cmdId = (++seq + 1_000_000).toString(16).padStart(32, 'a');
    return { cmdId, buf: Buffer.from(JSON.stringify(signCommand(KEY, o.id ?? 'GACHE-1', { cmdId, action, params: o.durationS ? { durationS: o.durationS } : {}, ts: o.ts ?? Date.now(), ttlS: o.ttlS ?? 10 }))) };
  };
  const act1 = (over: Record<string, unknown> = {}) => ({ id: 'GACHE-1', key: KEY, module: 'porte', actions: { unlock: { maxS: 60 }, lock: {} }, rest: 'lock', ...over });
  const running = (rt: Awaited<ReturnType<typeof gateway>>['rt'], label = 'porte') => rt.status().modules.find((m) => m.label === label)?.state === 'running';

  it('enregistrement : le gestionnaire du module recoit les ordres du pilote', async () => {
    const k = key();
    const { rt } = await gateway([{ label: 'porte', key: k, actuators: ['GACHE-1'] }], [act1()]);
    await waitFor(() => running(rt), 10_000, 'module demarre');
    assert.ok(rt.actuators);
    assert.equal(rt.actuators.hasHandler('GACHE-1'), true);
    const o = order('unlock', { durationS: 5 });
    await rt.actuators.handleMessage('GACHE-1', o.buf);
    assert.deepEqual(doors()[k].calls.map((c) => ({ ...c })), [{ actuatorId: 'GACHE-1', cmdId: o.cmdId, action: 'unlock', durationS: 5 }]);
    assert.equal(rt.status().actuators?.acksLost, 1, 'accuse non remis (liaison PSIM absente) : perdu, journalise');
    assert.equal(rt.status().actuators?.executed, 1, 'pas d\'accuse remis (liaison PSIM absente) mais l\'ordre a ete execute');
    assert.equal(rt.status().actuators?.pendingRests, 1);
  });

  it('sans actionneur configure : pas de pilote, onActuator echoue clairement', async () => {
    const k = key();
    const { rt } = await gateway([{ label: 'porte', key: k, actuators: ['GACHE-1'] }], []);
    await waitFor(() => rt.status().modules[0].failures >= 1, 10_000, 'demarrage echoue');
    assert.equal(rt.actuators, null);
    assert.match(rt.status().modules[0].lastError ?? '', /non declare dans la section « actuators »/);
    assert.equal(rt.status().actuators, undefined);
  });

  it("actionneur non declare : le demarrage du module echoue (journal, nouvel essai), sans toucher aux autres", async () => {
    const ka = key();
    const kb = key();
    const { rt, logger } = await gateway(
      [
        { label: 'porte', key: ka, actuators: ['INCONNU-1'] },
        { label: 'autre', key: kb, actuators: ['GACHE-2'] },
      ],
      [act1({ id: 'GACHE-1' }), act1({ id: 'GACHE-2', key: KEY2, module: 'autre' })],
    );
    await waitFor(() => rt.status().modules.find((m) => m.label === 'porte')!.failures >= 1 && running(rt, 'autre'), 10_000, 'un echoue, l\'autre tourne');
    assert.match(rt.status().modules.find((m) => m.label === 'porte')!.lastError ?? '', /« INCONNU-1 » non declare/);
    assert.ok(logger.has(/\[porte\] echec du demarrage/));
    assert.equal(rt.actuators!.hasHandler('GACHE-2'), true);
    assert.equal(rt.actuators!.hasHandler('GACHE-1'), false);
  });

  it('actionneur declare pour un AUTRE module : refuse', async () => {
    const ka = key();
    const kb = key();
    const { rt } = await gateway(
      [
        { label: 'porte', key: ka, actuators: [] },
        { label: 'intrus', key: kb, actuators: ['GACHE-1'] },
      ],
      [act1()],
    );
    await waitFor(() => rt.status().modules.find((m) => m.label === 'intrus')!.failures >= 1, 10_000, 'intrus refuse');
    assert.match(rt.status().modules.find((m) => m.label === 'intrus')!.lastError ?? '', /declare pour le module « porte » et non pour « intrus »/);
    assert.equal(rt.actuators!.hasHandler('GACHE-1'), false, 'rien n\'a ete enregistre');
  });

  it('double enregistrement par la meme instance : le demarrage echoue et plus rien n\'est enregistre', async () => {
    const k = key();
    const { rt } = await gateway([{ label: 'porte', key: k, actuators: ['GACHE-1'], twice: true }], [act1()]);
    await waitFor(() => rt.status().modules[0].failures >= 1, 10_000, 'double enregistrement refuse');
    assert.match(rt.status().modules[0].lastError ?? '', /deja enregistre par ce module/);
    assert.equal(rt.actuators!.hasHandler('GACHE-1'), false, 'instance en echec = gestionnaires retires');
  });

  it("gestionnaires retires quand l'instance s'arrete (echec au demarrage), reenregistres au redemarrage du module", async () => {
    const k = key();
    const { rt } = await gateway([{ label: 'porte', key: k, actuators: ['GACHE-1'], failTimes: 1 }], [act1()]);
    await waitFor(() => doors()[k]?.starts >= 1, 10_000, 'premier demarrage');
    await waitFor(() => rt.status().modules[0].failures === 1, 10_000, 'echec constate');
    // pendant l'attente avant le nouvel essai : plus de gestionnaire, un ordre est refuse « unavailable »
    if (rt.status().modules[0].state === 'retrying') {
      assert.equal(rt.actuators!.hasHandler('GACHE-1'), false);
      await rt.actuators!.handleMessage('GACHE-1', order('lock').buf);
      assert.equal(rt.status().actuators?.refused, 1);
    }
    await waitFor(() => running(rt), 10_000, 'module relance');
    assert.equal(doors()[k].starts, 2);
    assert.equal(rt.actuators!.hasHandler('GACHE-1'), true, 'reenregistre sans « deja enregistre »');
    await rt.actuators!.handleMessage('GACHE-1', order('lock').buf);
    assert.deepEqual(doors()[k].calls.map((c) => c.action), ['lock']);
  });

  it("contexte d'une instance arretee : onActuator leve « module arrete »", async () => {
    const k = key();
    const { rt } = await gateway([{ label: 'porte', key: k, actuators: ['GACHE-1'], failTimes: 1 }], [act1()]);
    await waitFor(() => doors()[k]?.starts >= 1 && rt.status().modules[0].failures >= 1, 10_000, 'premier contexte mort');
    const dead = doors()[k].ctxs[0];
    assert.throws(() => dead.onActuator('GACHE-1', async () => ({ result: 'done' })), /^Error: module arrete$/);
    await waitFor(() => running(rt), 10_000, 'module relance');
    assert.equal(rt.actuators!.hasHandler('GACHE-1'), true);
    assert.throws(() => dead.onActuator('GACHE-1', async () => ({ result: 'done' })), /module arrete/, 'une instance morte ne vole pas le gestionnaire de la nouvelle');
  });

  it("arret de la passerelle : le retour au repos part AVANT l'arret du module, puis le gestionnaire est retire", async () => {
    const k = key();
    const { rt, dir } = await gateway([{ label: 'porte', key: k, actuators: ['GACHE-1'] }], [act1()]);
    await waitFor(() => running(rt), 10_000, 'module demarre');
    await rt.actuators!.handleMessage('GACHE-1', order('unlock', { durationS: 30 }).buf);
    assert.equal(rt.actuators!.pendingRests().length, 1);
    await rt.stop();
    assert.deepEqual(doors()[k].events, ['call:unlock', 'call:lock', 'stop'], 'repos appele une fois, avant stop()');
    assert.deepEqual(doors()[k].calls.map((c) => c.action), ['unlock', 'lock']);
    const state = readFileSync(join(dir, 'data', 'actuators-state.json'), 'utf8');
    assert.doesNotMatch(state, /[0-9a-f]{64}/, 'pas de secret dans le fichier d\'etat');
    assert.equal(JSON.parse(state).rest['GACHE-1'], undefined, 'repos fait : rien a reprendre');
  });

  it('rejeu apres redemarrage de la passerelle (meme dossier de donnees) : ignore', async () => {
    const k1 = key();
    const k2 = key();
    const first = await gateway([{ label: 'porte', key: k1, actuators: ['GACHE-1'] }], [act1()]);
    await waitFor(() => running(first.rt), 10_000, 'demarre');
    const o = order('lock');
    await first.rt.actuators!.handleMessage('GACHE-1', o.buf);
    assert.equal(doors()[k1].calls.length, 1);
    await first.rt.stop();
    const second = await gateway([{ label: 'porte', key: k2, actuators: ['GACHE-1'] }], [act1()], first.dir);
    await waitFor(() => running(second.rt), 10_000, 'redemarre');
    await second.rt.actuators!.handleMessage('GACHE-1', o.buf);
    assert.equal(doors()[k2].calls.length, 0, 'ordre deja execute avant l\'arret : ignore');
  });

  it("statut : nombre d'ordres executes, refuses, en erreur", async () => {
    const k = key();
    const { rt } = await gateway([{ label: 'porte', key: k, actuators: ['GACHE-1'] }], [act1()]);
    await waitFor(() => running(rt), 10_000, 'demarre');
    await rt.actuators!.handleMessage('GACHE-1', order('lock').buf);
    await rt.actuators!.handleMessage('GACHE-1', order('zzz').buf);
    doors()[k].behavior = () => ({ result: 'error', code: 'io' });
    await rt.actuators!.handleMessage('GACHE-1', order('lock').buf);
    const s = rt.status().actuators!;
    assert.deepEqual({ executed: s.executed, refused: s.refused, failed: s.failed, configured: s.configured }, { executed: 1, refused: 1, failed: 1, configured: 1 });
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Integration contre le vrai broker du PSIM
// ------------------------------------------------------------------------------------------------------------------

describe('integration : passerelle <-> broker du PSIM (server/mqtt.ts), ordres signes par server/actuatorproto.ts', () => {
  const actuatorsCfg = (ids: string[]) =>
    ids.map((id) => ({
      id,
      key: id === 'SORTIE-1' ? KEY2 : KEY,
      module: 'porte',
      actions: id === 'SORTIE-1' ? { unlock: { maxS: 10 } } : { unlock: { maxS: 10 }, lock: {} },
      rest: id === 'SORTIE-1' ? undefined : 'lock',
      emergencyExit: id === 'SORTIE-1',
    }));
  let n = 0;

  async function setup(opts: { declared?: string[]; allowed?: string[] } = {}) {
    const dir = tempDir(cleanup);
    const port = await freePort();
    const acks: { id: string; raw: Buffer }[] = [];
    const k = `integ-${++n}-${process.pid}`;
    const broker = await psimBroker(
      port,
      [],
      [{ user: GW_USER, password: GW_PASSWORD, detectors: ['D-*'], actuators: opts.allowed ?? ['GACHE-1', 'SORTIE-1'] }],
      { onActuatorAck: (id, raw) => void acks.push({ id, raw }) },
    );
    cleanup.push(() => broker.close());
    const declared = opts.declared ?? ['GACHE-1', 'SORTIE-1'];
    const cfg = testConfig(dir, port, [{ name: 'door', label: 'porte', config: { key: k, actuators: declared } }], { actuators: actuatorsCfg(declared) });
    const logger = memoryLogger();
    const rt = await startRuntime({ config: cfg, logger, modulesDir: FIXTURES, publishTimeoutMs: 3000 });
    cleanup.push(() => rt.stop());
    const rec = () => doors()[k];
    const send = async (id: string, msg: unknown) => broker.publishCommand(id, Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg)));
    const sign = (id: string, o: { action: string; durationS?: number; ts?: number; ttlS?: number; cmdId?: string }) =>
      signCommand(id === 'SORTIE-1' ? KEY2 : KEY, id, {
        cmdId: o.cmdId ?? (++n + 5_000_000).toString(16).padStart(32, 'b'),
        action: o.action,
        params: o.durationS ? { durationS: o.durationS } : {},
        ts: o.ts ?? Date.now(),
        ttlS: o.ttlS ?? 10,
      });
    const ackOf = (cmdId: string, id = 'GACHE-1') => {
      const key = id === 'SORTIE-1' ? KEY2 : KEY;
      for (const a of acks) {
        const v = a.id === id ? verifyAck(key, id, a.raw) : null;
        if (v && v.cmdId === cmdId) return v;
      }
      return undefined;
    };
    return { dir, port, broker, rt, logger, acks, rec, send, sign, ackOf, k };
  }

  it('ordre -> gestionnaire du module -> accuse « done » recu et valide par le code du PSIM ; repos local en temps reel', async () => {
    const t = await setup();
    await waitFor(() => t.broker.actuatorListeners('GACHE-1') === 1 && t.broker.actuatorListeners('SORTIE-1') === 1, 10_000, 'abonnements aux ordres');
    const o = t.sign('GACHE-1', { action: 'unlock', durationS: 1 });
    await t.send('GACHE-1', o);
    await waitFor(() => t.ackOf(o.cmdId) !== undefined, 10_000, 'accuse');
    const ack = t.ackOf(o.cmdId)!;
    assert.equal(ack.result, 'done');
    assert.equal(ack.code, undefined);
    assert.ok(Math.abs(ack.ts - Date.now()) < 5000);
    assert.deepEqual(t.rec().calls.map((c) => ({ ...c })), [{ actuatorId: 'GACHE-1', cmdId: o.cmdId, action: 'unlock', durationS: 1 }]);
    // retour LOCAL au repos au bout de 1 s, sans autre message du PSIM
    await waitFor(() => t.rec().calls.length === 2, 10_000, 'repos local');
    assert.deepEqual({ ...t.rec().calls[1] }, { actuatorId: 'GACHE-1', cmdId: `${o.cmdId}:rest`, action: 'lock' });
    assert.equal(t.acks.length, 1, 'le retour local n\'est pas accuse');
    assert.equal(t.rt.queue.stats().pending, 0, 'aucun accuse ni ordre dans la file disque');
  });

  it('rejeu, ordre perime, mal signe, au-dela du plafond, « lock » sur issue de secours', async () => {
    const t = await setup();
    await waitFor(() => t.broker.actuatorListeners('GACHE-1') === 1, 10_000, 'abonnements');
    const good = t.sign('GACHE-1', { action: 'unlock', durationS: 5 });
    await t.send('GACHE-1', good);
    await t.send('GACHE-1', good); // rejeu : ignore
    const stale = t.sign('GACHE-1', { action: 'lock', ts: Date.now() - 60_000 });
    await t.send('GACHE-1', stale);
    const forged = { ...t.sign('GACHE-1', { action: 'lock' }), sig: 'c'.repeat(64) };
    await t.send('GACHE-1', forged); // ni execution ni accuse
    const tooLong = t.sign('GACHE-1', { action: 'unlock', durationS: 11 });
    await t.send('GACHE-1', tooLong);
    const emergency = t.sign('SORTIE-1', { action: 'lock' });
    await t.send('SORTIE-1', emergency);
    const sentinel = t.sign('GACHE-1', { action: 'lock' });
    await t.send('GACHE-1', sentinel);
    await waitFor(() => t.ackOf(sentinel.cmdId) !== undefined, 10_000, 'accuse de la sentinelle (les messages precedents sont arrives avant)');
    const code = (cmdId: string, id = 'GACHE-1') => {
      const a = t.ackOf(cmdId, id);
      return a ? `${a.result}/${a.code ?? ''}` : 'aucun';
    };
    assert.equal(code(good.cmdId), 'done/');
    assert.equal(code(stale.cmdId), 'refused/stale');
    assert.equal(code(forged.cmdId), 'aucun', 'signature fausse : aucun accuse');
    assert.equal(code(tooLong.cmdId), 'refused/not_allowed');
    assert.equal(code(emergency.cmdId, 'SORTIE-1'), 'refused/emergency_exit');
    assert.equal(code(sentinel.cmdId), 'done/');
    assert.equal(t.acks.length, 5, 'good, stale, tooLong, emergency, sentinelle (ni le rejeu ni le faux)');
    assert.deepEqual(t.rec().calls.map((c) => c.action), ['unlock', 'lock'], 'le module n\'a recu que les deux ordres valides');
    assertNoSecrets(t.logger);
  });

  it('ordre pour un actionneur d\'un autre compte, et ordre rejoue sur un autre actionneur : rien', async () => {
    const t = await setup();
    await waitFor(() => t.broker.actuatorListeners('GACHE-1') === 1, 10_000, 'abonnements');
    // le broker ne livre que les topics souscrits : un ordre pour un actionneur inconnu n'atteint personne
    await t.send('AUTRE-1', t.sign('GACHE-1', { action: 'lock' }));
    // ordre de GACHE-1 livre sur le topic de SORTIE-1 : signature liee a l'identifiant du topic
    const wrongTopic = t.sign('GACHE-1', { action: 'unlock', durationS: 3 });
    await t.send('SORTIE-1', wrongTopic);
    const sentinel = t.sign('GACHE-1', { action: 'lock' });
    await t.send('GACHE-1', sentinel);
    await waitFor(() => t.ackOf(sentinel.cmdId) !== undefined, 10_000, 'sentinelle');
    assert.equal(t.acks.length, 1);
    assert.deepEqual(t.rec().calls.map((c) => `${c.actuatorId}:${c.action}`), ['GACHE-1:lock']);
  });

  it('compte de passerelle qui declare un actionneur NON autorise : SUBACK refuse journalise, le reste de la liaison fonctionne', async () => {
    const t = await setup({ declared: ['GACHE-1', 'SORTIE-1'], allowed: ['GACHE-1'] });
    await waitFor(() => t.logger.has(/actionneur SORTIE-1 non autorise pour ce compte : voir PSIM_MQTT_GATEWAYS, liste actuators/), 10_000, 'refus journalise');
    assert.ok(!t.logger.has(/actionneur GACHE-1 non autorise/));
    assert.equal(t.broker.actuatorListeners('GACHE-1'), 1);
    assert.equal(t.broker.actuatorListeners('SORTIE-1'), 0);
    assert.equal(t.rt.status().psim.connected, true, 'liaison intacte');
    const o = t.sign('GACHE-1', { action: 'lock' });
    await t.send('GACHE-1', o);
    await waitFor(() => t.ackOf(o.cmdId) !== undefined, 10_000, 'GACHE-1 fonctionne');
    // la file de detecteurs aussi
    t.rt.emit('D-01', { state: 'alarm' });
    await waitFor(() => t.rt.status().queue.pending === 0, 10_000, 'file videe');
  });

  it("liaison coupee : l'accuse est PERDU et journalise (jamais en file) ; abonnements refaits a la reconnexion ; pas de rejeu", async () => {
    const t = await setup();
    await waitFor(() => t.broker.actuatorListeners('GACHE-1') === 1, 10_000, 'abonnements');
    await t.broker.close();
    await waitFor(() => !t.rt.status().psim.connected, 10_000, 'coupure detectee');
    const o = t.sign('GACHE-1', { action: 'lock' });
    await t.rt.actuators!.handleMessage('GACHE-1', Buffer.from(JSON.stringify(o)));
    assert.equal(t.rec().calls.length, 1, 'l\'ordre a ete execute localement');
    assert.ok(t.logger.has(/accuse .*PERDU/));
    assert.equal(t.rt.status().actuators?.acksLost, 1);
    assert.equal(t.rt.queue.stats().pending, 0, 'rien en file disque');
    // le PSIM revient sur le meme port : la passerelle se reconnecte ET se reabonne (clean:true)
    const again = await psimBroker(t.port, [], [{ user: GW_USER, password: GW_PASSWORD, detectors: ['D-*'], actuators: ['GACHE-1', 'SORTIE-1'] }], { onActuatorAck: (id, raw) => void t.acks.push({ id, raw }) });
    cleanup.push(() => again.close());
    await waitFor(() => again.actuatorListeners('GACHE-1') === 1, 15_000, 'reabonnement apres reconnexion');
    await sleep(300);
    assert.equal(t.acks.length, 0, 'aucun accuse en retard');
    assert.equal(t.rec().calls.length, 1, 'aucun ordre rejoue');
    // et la chaine fonctionne de nouveau
    const o2 = signCommand(KEY, 'GACHE-1', { cmdId: 'd'.repeat(32), action: 'lock', params: {}, ts: Date.now(), ttlS: 10 });
    await again.publishCommand('GACHE-1', Buffer.from(JSON.stringify(o2)));
    await waitFor(() => t.acks.length === 1, 10_000, 'accuse apres reconnexion');
    assert.equal(verifyAck(KEY, 'GACHE-1', t.acks[0].raw)?.cmdId, o2.cmdId);
  });

  it("un accuse fabrique par la passerelle est accepte par la verification du PSIM, et un accuse d'un autre actionneur ne l'est pas", async () => {
    const t = await setup();
    await waitFor(() => t.broker.actuatorListeners('GACHE-1') === 1, 10_000, 'abonnements');
    const o = t.sign('GACHE-1', { action: 'lock' });
    await t.send('GACHE-1', o);
    await waitFor(() => t.acks.length === 1, 10_000, 'accuse');
    assert.ok(verifyAck(KEY, 'GACHE-1', t.acks[0].raw));
    assert.equal(verifyAck(KEY2, 'GACHE-1', t.acks[0].raw), null, 'autre cle');
    assert.equal(verifyAck(KEY, 'SORTIE-1', t.acks[0].raw), null, 'autre actionneur');
  });
});
