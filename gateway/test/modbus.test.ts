/**
 * Module Modbus de la Passerelle GAMR : un faux equipement Modbus TCP (net.createServer) joue le role des modules
 * d'entrees, compteurs et automates. Aucun equipement reel n'est contacte.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { DeviceMessage, ModuleContext } from '../src/module.ts';
import { ModbusClient, ModbusError } from '../src/modules/modbus/client.ts';
import { ConfigError, parseConfig } from '../src/modules/modbus/config.ts';
import type { PointConfig } from '../src/modules/modbus/config.ts';
import { decodeNumber, evaluate } from '../src/modules/modbus/decode.ts';
import { planBlocks } from '../src/modules/modbus/device.ts';
import { create } from '../src/modules/modbus/index.ts';
import { PointTracker } from '../src/modules/modbus/points.ts';

const SRC = resolve(import.meta.dirname, '../src/modules/modbus');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('delai depasse');
    await wait(10);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Faux equipement Modbus TCP
// ---------------------------------------------------------------------------------------------------------------

type Mode = 'ok' | 'silent' | 'truncate' | 'badTid' | 'badProto' | 'shortLen' | 'hugeLen' | 'badCount' | 'badFn' | 'badUnit' | 'extra' | 'exception' | 'close';
interface Req { tid: number; unit: number; fn: number; address: number; quantity: number }

function fakeModbus() {
  const data = {
    coils: new Map<number, boolean>(),
    discrete: new Map<number, boolean>(),
    holding: new Map<number, number>(),
    input: new Map<number, number>(),
  };
  const s = {
    ...data,
    mode: 'ok' as Mode,
    exceptionCode: 2,
    delayMs: 0,
    rule: undefined as ((r: Req) => Mode | undefined) | undefined,
    requests: [] as Req[],
    connects: [] as number[],
    inflight: 0,
    maxInflight: 0,
    sockets: new Set<Socket>(),
    port: 0,
  };

  const body = (r: Req): Buffer => {
    if (r.fn === 1 || r.fn === 2) {
      const map = r.fn === 1 ? s.coils : s.discrete;
      const bytes = Buffer.alloc(Math.ceil(r.quantity / 8));
      for (let i = 0; i < r.quantity; i++) if (map.get(r.address + i)) bytes[i >> 3] |= 1 << (i & 7);
      return Buffer.concat([Buffer.from([r.fn, bytes.length]), bytes]);
    }
    const map = r.fn === 3 ? s.holding : s.input;
    const bytes = Buffer.alloc(r.quantity * 2);
    for (let i = 0; i < r.quantity; i++) bytes.writeUInt16BE(map.get(r.address + i) ?? 0, i * 2);
    return Buffer.concat([Buffer.from([r.fn, bytes.length]), bytes]);
  };

  const frame = (r: Req, pdu: Buffer, opts: { tid?: number; proto?: number; len?: number; unit?: number } = {}): Buffer => {
    const h = Buffer.alloc(7);
    h.writeUInt16BE(opts.tid ?? r.tid, 0);
    h.writeUInt16BE(opts.proto ?? 0, 2);
    h.writeUInt16BE(opts.len ?? pdu.length + 1, 4);
    h.writeUInt8(opts.unit ?? r.unit, 6);
    return Buffer.concat([h, pdu]);
  };

  const answer = (sock: Socket, r: Req): void => {
    const mode = s.rule?.(r) ?? s.mode;
    const ok = body(r);
    switch (mode) {
      case 'silent': return;
      case 'close': sock.destroy(); return;
      case 'truncate': sock.write(frame(r, ok).subarray(0, 9)); return;
      case 'badTid': sock.write(frame(r, ok, { tid: (r.tid + 1) & 0xffff })); return;
      case 'badProto': sock.write(frame(r, ok, { proto: 1 })); return;
      case 'shortLen': sock.write(frame(r, ok, { len: ok.length })); return;
      case 'hugeLen': sock.write(frame(r, ok, { len: 1000 })); return;
      case 'badCount': {
        const bad = Buffer.from(ok);
        bad[1] = bad[1] + 2;
        sock.write(frame(r, bad));
        return;
      }
      case 'badFn': {
        const bad = Buffer.from(ok);
        bad[0] = 0x05;
        sock.write(frame(r, bad));
        return;
      }
      case 'badUnit': sock.write(frame(r, ok, { unit: (r.unit + 1) & 0xff })); return;
      case 'extra': sock.write(Buffer.concat([frame(r, ok), Buffer.from([1, 2, 3])])); return;
      case 'exception': sock.write(frame(r, Buffer.from([r.fn | 0x80, s.exceptionCode]))); return;
      default: sock.write(frame(r, ok));
    }
  };

  const server: Server = createServer((sock) => {
    s.connects.push(Date.now());
    s.sockets.add(sock);
    let buf = Buffer.alloc(0);
    sock.on('error', () => undefined);
    sock.on('close', () => s.sockets.delete(sock));
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 12) {
        const f = buf.subarray(0, 12);
        buf = buf.subarray(12);
        const r: Req = { tid: f.readUInt16BE(0), unit: f.readUInt8(6), fn: f.readUInt8(7), address: f.readUInt16BE(8), quantity: f.readUInt16BE(10) };
        s.requests.push(r);
        s.inflight++;
        s.maxInflight = Math.max(s.maxInflight, s.inflight);
        if (r.fn < 1 || r.fn > 4) {
          sock.write(frame(r, Buffer.from([r.fn | 0x80, 1])));
          s.inflight--;
          continue;
        }
        setTimeout(() => {
          s.inflight--;
          if (!sock.destroyed) answer(sock, r);
        }, s.delayMs);
      }
    });
  });

  return {
    ...s,
    get port() {
      return s.port;
    },
    s,
    async listen(port = 0): Promise<number> {
      await new Promise<void>((res, rej) => {
        server.once('error', rej);
        server.listen(port, '127.0.0.1', () => res());
      });
      s.port = (server.address() as AddressInfo).port;
      return s.port;
    },
    async close(): Promise<void> {
      for (const k of s.sockets) k.destroy();
      await new Promise<void>((res) => server.close(() => res()));
    },
    dropConnections(): void {
      for (const k of s.sockets) k.destroy();
    },
  };
}
type Fake = ReturnType<typeof fakeModbus>;

async function withServer<T>(fn: (f: Fake) => Promise<T>): Promise<T> {
  const f = fakeModbus();
  await f.listen();
  try {
    return await fn(f);
  } finally {
    await f.close();
  }
}

function fakeCtx() {
  const emitted: { id: string; msg: DeviceMessage }[] = [];
  const logs: { level: string; text: string }[] = [];
  const ctx: ModuleContext = {
    emit: (id, msg) => void emitted.push({ id, msg }),
    openMqtt: async () => {
      throw new Error('non utilise');
    },
    log: (level, text) => void logs.push({ level, text }),
    config: {},
    now: () => Date.now(),
  };
  return { ctx, emitted, logs, of: (id: string) => emitted.filter((e) => e.id === id).map((e) => e.msg) };
}

/** Lance le module avec une configuration, execute le scenario, puis l'arrete proprement. */
async function runModule(devices: Record<string, unknown>[], scenario: (c: ReturnType<typeof fakeCtx>) => Promise<void>): Promise<void> {
  const c = fakeCtx();
  const mod = create({ devices });
  await mod.start(c.ctx);
  try {
    await scenario(c);
  } finally {
    await mod.stop();
  }
}

const dev = (port: number, points: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  name: 'boitier1',
  host: '127.0.0.1',
  port,
  pollMs: 15,
  timeoutMs: 200,
  failThreshold: 2,
  reconnectMinMs: 20,
  reconnectMaxMs: 60,
  heartbeatMs: 0,
  points,
  ...extra,
});

/** Construit un point normalise (via la validation) pour les tests unitaires. */
function point(p: Record<string, unknown>, deviceExtra: Record<string, unknown> = {}): PointConfig {
  return parseConfig({ devices: [{ name: 'd', host: '127.0.0.1', heartbeatMs: 0, ...deviceExtra, points: [p] }] }).devices[0].points[0];
}
const intrusion = { id: 'c1', type: 'discrete', address: 0, onTrue: { event: 'intrusion' } };

// ---------------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------------

describe('modbus : configuration', () => {
  it('applique les valeurs par defaut', () => {
    const c = parseConfig({ devices: [{ name: 'a', host: 'module1.local', points: [intrusion] }] });
    const d = c.devices[0];
    assert.equal(d.port, 502);
    assert.equal(d.unitId, 1);
    assert.equal(d.pollMs, 1000);
    assert.equal(d.timeoutMs, 2000);
    assert.equal(d.failThreshold, 3);
    const p = d.points[0];
    assert.equal(p.fn, 2);
    assert.deepEqual(p.onFalse, { event: 'clear' });
    assert.equal(p.invert, false);
    assert.equal(p.heartbeatMs, 30_000);
  });

  it('rejette une configuration invalide avec des messages clairs, tous en une fois', () => {
    const bad = {
      devices: [
        { name: 'a', host: 'http://x', port: 0, unitId: 300, points: [{ id: 'p', type: 'discrete', address: 70000, onTrue: { event: 'intrusion' } }] },
        { name: 'a', host: '10.0.0.1', pollMs: 1, truc: 1, points: [
          { id: 'p', type: 'coil', address: 1, onTrue: { event: 'evenement_bidon' } },
          { id: 'q', type: 'holding', address: 65535, dataType: 'uint32', mode: 'value' },
          { id: 'r', type: 'input', address: 0, current4_20: { rawMin: 10, rawMax: 5, engMin: 0, engMax: 1 } },
          { id: 's', type: 'discrete', address: 2 },
          { id: 't', type: 'holding', address: 3, mode: 'bit', bit: 16, onTrue: { event: 'fault' } },
          { id: 'u', type: 'input', address: 3, scale: 2, current4_20: { rawMin: 0, rawMax: 10, engMin: 0, engMax: 1 } },
          { id: 'v v', type: 'bidon', address: 0.5 },
          { id: 'w', type: 'discrete', address: 4, onTrue: { event: 'intrusion', state: 'alarm' }, debounce: 3 },
        ] },
      ],
    };
    assert.throws(() => parseConfig(bad), (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      const m = e.message;
      for (const attendu of [
        'http://x', '« port »', '« unitId »', '« address » doit etre compris entre 0 et 65535', 'nom en double', 'identifiant en double',
        '« pollMs »', 'cle inconnue « truc »', 'evenement inconnu', 'depasse 65535', '« rawMin » doit etre inferieur', '« onTrue » est obligatoire',
        '« bit »', 'ne se combinent pas', '« type » doit valoir', '« address » doit etre un entier', 'exactement un des deux', 'cle inconnue « debounce »', '« id » obligatoire',
      ]) assert.ok(m.includes(attendu), `message attendu absent : ${attendu}\n${m}`);
      assert.ok(e.problems.length >= 15);
      return true;
    });
  });

  it('refuse les structures vides ou de mauvais type', () => {
    assert.throws(() => parseConfig(null), ConfigError);
    assert.throws(() => parseConfig({}), /devices/);
    assert.throws(() => parseConfig({ devices: [] }), /devices/);
    assert.throws(() => parseConfig({ devices: [{ name: 'a', host: '1.2.3.4', points: [] }] }), /points/);
    assert.throws(() => parseConfig({ devices: [{ name: 'a', host: '1.2.3.4', points: [intrusion], port: '502' }] }), /port/);
    assert.throws(() => parseConfig({ devices: [{ name: 'a', host: '1.2.3.4', points: [{ ...intrusion, id: 'a'.repeat(33) }] }] }), /id/);
    assert.throws(() => parseConfig({ devices: [{ name: 'a', host: '1.2.3.4', points: [{ ...intrusion, onFalse: { state: 'bidon' } }] }] }), /etat inconnu/);
    assert.throws(() => create({ devices: [{ name: 'a', host: '', points: [intrusion] }] }), /host/);
  });

  it('les exemples de la documentation sont des configurations valides', () => {
    const texte = readFileSync(resolve(import.meta.dirname, '../docs/modbus.md'), 'utf8');
    const blocs = [...texte.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
    assert.ok(blocs.length >= 5, 'format + 4 exemples');
    for (const b of blocs) assert.doesNotThrow(() => parseConfig(JSON.parse(b)), b.slice(0, 80));
  });

  it('accepte adresses IPv4, IPv6 et noms de machine', () => {
    for (const host of ['192.168.1.20', '::1', 'automate-1.usine.local', 'io']) {
      assert.doesNotThrow(() => parseConfig({ devices: [{ name: 'a', host, points: [intrusion] }] }), host);
    }
    for (const host of ['a b', 'x:502', '-a', 'a..b', 'http://a']) {
      assert.throws(() => parseConfig({ devices: [{ name: 'a', host, points: [intrusion] }] }), /host/, host);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Decodage
// ---------------------------------------------------------------------------------------------------------------

/** Mots d'un flottant 32 bits, calcules ici independamment du code teste. */
function floatWords(x: number, order: 'ABCD' | 'CDAB' | 'BADC' | 'DCBA'): number[] {
  const b = Buffer.alloc(4);
  b.writeFloatBE(x, 0);
  const [A, B, C, D] = [b[0], b[1], b[2], b[3]];
  const bytes = { ABCD: [A, B, C, D], CDAB: [C, D, A, B], BADC: [B, A, D, C], DCBA: [D, C, B, A] }[order];
  return [(bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]];
}

describe('modbus : types de donnees et ordre des mots', () => {
  it('uint16 / int16', () => {
    assert.equal(decodeNumber([65535], 'uint16', 'big', 'big'), 65535);
    assert.equal(decodeNumber([0xfffe], 'int16', 'big', 'big'), -2);
    assert.equal(decodeNumber([0x7fff], 'int16', 'big', 'big'), 32767);
    assert.equal(decodeNumber([0x3412], 'uint16', 'big', 'little'), 0x1234);
  });

  it('uint32 / int32 dans les quatre ordres', () => {
    assert.equal(decodeNumber([0x0001, 0x1170], 'uint32', 'big', 'big'), 70000);
    assert.equal(decodeNumber([0x1170, 0x0001], 'uint32', 'little', 'big'), 70000);
    assert.equal(decodeNumber([0x0100, 0x7011], 'uint32', 'big', 'little'), 70000);
    assert.equal(decodeNumber([0x7011, 0x0100], 'uint32', 'little', 'little'), 70000);
    assert.equal(decodeNumber([0xffff, 0xfffe], 'int32', 'big', 'big'), -2);
    assert.equal(decodeNumber([0xfffe, 0xffff], 'int32', 'little', 'big'), -2);
    assert.equal(decodeNumber([0xffff, 0xfffe], 'uint32', 'big', 'big'), 4294967294);
  });

  it('float32 dans les quatre ordres (ABCD, CDAB, BADC, DCBA)', () => {
    const wo = { ABCD: ['big', 'big'], CDAB: ['little', 'big'], BADC: ['big', 'little'], DCBA: ['little', 'little'] } as const;
    for (const k of ['ABCD', 'CDAB', 'BADC', 'DCBA'] as const) {
      assert.equal(decodeNumber(floatWords(25.5, k), 'float32', wo[k][0], wo[k][1]), 25.5, k);
      assert.equal(decodeNumber(floatWords(-0.25, k), 'float32', wo[k][0], wo[k][1]), -0.25, k);
    }
    // un mauvais ordre ne donne pas la bonne valeur
    assert.notEqual(decodeNumber(floatWords(25.5, 'CDAB'), 'float32', 'big', 'big'), 25.5);
  });

  it('mise a l\'echelle, decalage et arrondi', () => {
    const p = point({ id: 'v', type: 'holding', address: 0, scale: 0.1, offset: -10, decimals: 1 });
    const ev = evaluate(p, [1234]);
    assert.deepEqual(ev, { ok: true, kind: 'num', num: 113.4, ma: null });
    const neg = evaluate(point({ id: 'v', type: 'holding', address: 0, dataType: 'int16', scale: 0.5 }), [0xfff6]);
    assert.deepEqual(neg, { ok: true, kind: 'num', num: -5, ma: null });
  });

  it('NaN et infini dans un registre flottant donnent un echec de lecture', () => {
    const p = point({ id: 'v', type: 'input', address: 0, dataType: 'float32' });
    const nan = evaluate(p, [0x7fc0, 0]);
    assert.equal(nan.ok, false);
    const inf = evaluate(p, [0x7f80, 0]);
    assert.equal(inf.ok, false);
  });

  it('bit d\'un registre et comparaison a un seuil', () => {
    const b = point({ id: 'g', type: 'holding', address: 0, mode: 'bit', bit: 3, onTrue: { event: 'fault' } });
    assert.deepEqual(evaluate(b, [0b1000]), { ok: true, kind: 'bool', bool: true });
    assert.deepEqual(evaluate(b, [0b0111]), { ok: true, kind: 'bool', bool: false });
    const c = point({ id: 'g', type: 'holding', address: 0, mode: 'compare', compare: { op: 'lt', value: 20 }, scale: 0.1, onTrue: { event: 'low_battery' } });
    assert.deepEqual(evaluate(c, [150]), { ok: true, kind: 'bool', bool: true }); // 15,0 < 20
    assert.deepEqual(evaluate(c, [250]), { ok: true, kind: 'bool', bool: false });
  });

  it('invert inverse le sens du contact', () => {
    const direct = point({ ...intrusion });
    const inverse = point({ ...intrusion, invert: true });
    assert.deepEqual(evaluate(direct, true), { ok: true, kind: 'bool', bool: true });
    assert.deepEqual(evaluate(inverse, true), { ok: true, kind: 'bool', bool: false });
    assert.deepEqual(evaluate(inverse, false), { ok: true, kind: 'bool', bool: true });
  });
});

describe('modbus : 4-20 mA', () => {
  const cfg = { id: 'cuve', type: 'input', address: 0, current4_20: { rawMin: 4000, rawMax: 20000, engMin: 0, engMax: 3 } };

  it('convertit le courant en grandeur physique', () => {
    const p = point(cfg);
    for (const [raw, eng, ma] of [[4000, 0, 4], [12000, 1.5, 12], [20000, 3, 20], [8000, 0.75, 8]] as const) {
      assert.deepEqual(evaluate(p, [raw]), { ok: true, kind: 'num', num: eng, ma }, String(raw));
    }
  });

  it('detecte la rupture de boucle sous 3,6 mA et la surintensite', () => {
    const p = point(cfg);
    const cut = evaluate(p, [0]);
    assert.equal(cut.ok, false);
    assert.match(cut.ok ? '' : cut.reason, /rupture de boucle/);
    assert.equal(evaluate(p, [3500]).ok, false); // 3,5 mA
    assert.equal(evaluate(p, [3700]).ok, true); // 3,7 mA : encore une mesure valide
    const over = evaluate(p, [22000]);
    assert.equal(over.ok, false);
    assert.match(over.ok ? '' : over.reason, /hors plage/);
  });

  it('le seuil de rupture est configurable', () => {
    const p = point({ ...cfg, current4_20: { ...cfg.current4_20, loopBreakMa: 2, overRangeMa: null } });
    assert.equal(evaluate(p, [3000]).ok, true);
    assert.equal(evaluate(p, [60000]).ok, true);
    assert.equal(evaluate(p, [1000]).ok, false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Regroupement en blocs
// ---------------------------------------------------------------------------------------------------------------

describe('modbus : lectures groupees', () => {
  const mk = (pts: Record<string, unknown>[], extra: Record<string, unknown> = {}) => {
    const d = parseConfig({ devices: [{ name: 'd', host: '127.0.0.1', ...extra, points: pts }] }).devices[0];
    return planBlocks(d);
  };
  const bit = (id: string, address: number, type = 'discrete') => ({ id, type, address, onTrue: { event: 'intrusion' } });

  it('fusionne les adresses contigues, separe les trous', () => {
    const b = mk([bit('a', 0), bit('b', 1), bit('c', 2), bit('d', 5)]);
    assert.deepEqual(b.map((x) => [x.fn, x.start, x.count]), [[2, 0, 3], [2, 5, 1]]);
  });

  it('tolere un trou d\'au plus maxGap', () => {
    const b = mk([bit('a', 0), bit('b', 3), bit('c', 20)], { maxGap: 2 });
    assert.deepEqual(b.map((x) => [x.start, x.count]), [[0, 4], [20, 1]]);
  });

  it('compte les mots des types 32 bits et separe les fonctions', () => {
    const b = mk([
      { id: 'a', type: 'holding', address: 10, dataType: 'float32' },
      { id: 'b', type: 'holding', address: 12 },
      { id: 'c', type: 'input', address: 12 },
      bit('d', 12, 'coil'),
    ]);
    assert.deepEqual(b.map((x) => [x.fn, x.start, x.count]), [[1, 12, 1], [3, 10, 3], [4, 12, 1]]);
  });

  it('borne la taille des blocs', () => {
    const b = mk([{ id: 'a', type: 'holding', address: 0 }, { id: 'b', type: 'holding', address: 1 }, { id: 'c', type: 'holding', address: 2 }], { maxRegisters: 2 });
    assert.deepEqual(b.map((x) => [x.start, x.count]), [[0, 2], [2, 1]]);
  });

  it('une seule requete reseau pour des points contigus', async () => {
    await withServer(async (f) => {
      f.discrete.set(0, true);
      await runModule([dev(f.port, [bit('a', 0), bit('b', 1), bit('c', 2)])], async (c) => {
        await until(() => c.emitted.length >= 3);
        await until(() => f.requests.length >= 3); // plusieurs tours
      });
      assert.ok(f.requests.every((r) => r.fn === 2 && r.address === 0 && r.quantity === 3));
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Machine a etats d'un point (heures fictives)
// ---------------------------------------------------------------------------------------------------------------

const bool = (b: boolean) => ({ ok: true as const, kind: 'bool' as const, bool: b });
const num = (n: number) => ({ ok: true as const, kind: 'num' as const, num: n, ma: null });
const bad = { ok: false as const, reason: 'x' };

describe('modbus : emission d\'un point', () => {
  it('emet l\'etat initial, puis seulement les changements', () => {
    const t = new PointTracker(point({ ...intrusion }), 3);
    assert.deepEqual(t.sample(bool(false), 1000).map((m) => m.event), ['clear']);
    assert.deepEqual(t.sample(bool(false), 1100), []);
    assert.deepEqual(t.sample(bool(true), 1200).map((m) => m.event), ['intrusion']);
    assert.deepEqual(t.sample(bool(true), 1300), []);
    assert.deepEqual(t.sample(bool(false), 1400).map((m) => m.event), ['clear']);
  });

  it('peut emettre un etat au lieu d\'un evenement', () => {
    const t = new PointTracker(point({ id: 'x', type: 'coil', address: 0, onTrue: { state: 'alarm' }, onFalse: { state: 'normal' } }), 3);
    assert.deepEqual(t.sample(bool(true), 1).map((m) => m.state), ['alarm']);
    assert.deepEqual(t.sample(bool(false), 2).map((m) => m.state), ['normal']);
  });

  it('anti-rebond : un changement doit durer debounceMs', () => {
    const t = new PointTracker(point({ ...intrusion, debounceMs: 100 }), 3);
    t.sample(bool(false), 0);
    assert.deepEqual(t.sample(bool(true), 10), []);
    assert.deepEqual(t.sample(bool(true), 60), []);
    assert.deepEqual(t.sample(bool(false), 70), []); // retour avant 100 ms : rien
    assert.deepEqual(t.sample(bool(true), 80), []); // le chronometre repart
    assert.deepEqual(t.sample(bool(true), 170), []);
    assert.deepEqual(t.sample(bool(true), 180).map((m) => m.event), ['intrusion']);
  });

  it('signe de vie periodique sans changer l\'etat', () => {
    const t = new PointTracker(point({ ...intrusion, heartbeatMs: 1000 }), 3);
    assert.equal(t.sample(bool(false), 0).length, 1);
    assert.deepEqual(t.sample(bool(false), 999), []);
    assert.deepEqual(t.sample(bool(false), 1000).map((m) => m.event), ['heartbeat']);
    assert.deepEqual(t.sample(bool(false), 1500), []);
    assert.deepEqual(t.sample(bool(false), 2000).map((m) => m.event), ['heartbeat']);
  });

  it('defaut emis UNE fois apres N echecs, puis etat reel au retour', () => {
    const t = new PointTracker(point({ ...intrusion }), 3);
    t.sample(bool(true), 0);
    assert.deepEqual(t.failure(1), []);
    assert.deepEqual(t.failure(2), []);
    assert.deepEqual(t.failure(3).map((m) => m.state), ['fault']);
    assert.deepEqual(t.failure(4), []);
    assert.deepEqual(t.sample(bad, 5), []);
    // meme etat qu'avant la panne : il est tout de meme reemis, pour effacer le defaut
    assert.deepEqual(t.sample(bool(true), 6).map((m) => m.event), ['intrusion']);
    assert.deepEqual(t.sample(bool(true), 7), []);
  });

  it('un succes remet a zero le compteur d\'echecs', () => {
    const t = new PointTracker(point({ ...intrusion }), 3);
    t.sample(bool(false), 0);
    t.failure(1);
    t.failure(2);
    t.sample(bool(false), 3);
    assert.deepEqual(t.failure(4), []);
    assert.deepEqual(t.failure(5), []);
    assert.equal(t.failure(6).length, 1);
  });

  it('mesure : zone morte et periode minimale', () => {
    const t = new PointTracker(point({ id: 'v', type: 'holding', address: 0, deadband: 5, minIntervalMs: 1000 }), 3);
    assert.deepEqual(t.sample(num(100), 0).map((m) => m.value), [100]);
    assert.deepEqual(t.sample(num(103), 2000), []); // sous la zone morte
    assert.deepEqual(t.sample(num(106), 500), []); // assez different, mais trop tot
    assert.deepEqual(t.sample(num(106), 2100).map((m) => m.value), [106]);
    assert.deepEqual(t.sample(num(101), 4000).map((m) => m.value), [101]); // |101-106| = 5
  });

  it('mesure : rafraichissement periodique et retour apres defaut', () => {
    const t = new PointTracker(point({ id: 'v', type: 'holding', address: 0, heartbeatMs: 1000 }), 1);
    t.sample(num(7), 0);
    assert.deepEqual(t.sample(num(7), 500), []);
    assert.deepEqual(t.sample(num(7), 1000).map((m) => m.value), [7]);
    assert.deepEqual(t.failure(1100).map((m) => m.state), ['fault']);
    const back = t.sample(num(7), 1200);
    assert.deepEqual(back.map((m) => m.event ?? m.value), ['restored', 7]);
  });

  it('msgId unique et deterministe, ts entier', () => {
    const t = new PointTracker(point({ ...intrusion }), 1);
    const all = [...t.sample(bool(false), 1000.7), ...t.sample(bool(true), 1000.7), ...t.failure(1000.7)];
    assert.equal(all.length, 3);
    assert.equal(new Set(all.map((m) => m.msgId)).size, 3);
    assert.ok(all.every((m) => m.ts === 1000 && /^c1-1000-\d+$/.test(m.msgId ?? '')));
    const t2 = new PointTracker(point({ ...intrusion }), 1);
    assert.equal(t2.sample(bool(false), 1000.7)[0].msgId, all[0].msgId);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Client Modbus TCP
// ---------------------------------------------------------------------------------------------------------------

const client = (f: Fake, timeoutMs = 150) => new ModbusClient({ host: '127.0.0.1', port: f.port, unitId: 1, timeoutMs });

describe('modbus : client TCP', () => {
  it('lit des bits et des registres des quatre tables', async () => {
    await withServer(async (f) => {
      f.coils.set(10, true); f.coils.set(12, true);
      f.discrete.set(3, true);
      f.holding.set(100, 0x1234); f.holding.set(101, 7);
      f.input.set(0, 65535);
      const c = client(f);
      try {
        assert.deepEqual(await c.read(1, 10, 4), [true, false, true, false]);
        assert.deepEqual(await c.read(2, 0, 9), [false, false, false, true, false, false, false, false, false]);
        assert.deepEqual(await c.read(3, 100, 3), [0x1234, 7, 0]);
        assert.deepEqual(await c.read(4, 0, 2), [65535, 0]);
        assert.equal(f.connects.length, 1); // une seule connexion reutilisee
        assert.ok(f.requests.every((r) => r.unit === 1));
      } finally {
        c.close();
      }
    });
  });

  it('une seule requete en vol par connexion', async () => {
    await withServer(async (f) => {
      f.s.delayMs = 20;
      const c = client(f, 1000);
      try {
        const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => c.read(4, i, 1)));
        assert.equal(rs.length, 5);
        assert.equal(f.s.maxInflight, 1);
        // identifiants de transaction tous differents
        assert.equal(new Set(f.requests.map((r) => r.tid)).size, 5);
      } finally {
        c.close();
      }
    });
  });

  it('exception Modbus : message clair, connexion conservee', async () => {
    await withServer(async (f) => {
      f.s.mode = 'exception';
      const c = client(f);
      try {
        await assert.rejects(c.read(3, 5000, 1), (e: unknown) => {
          assert.ok(e instanceof ModbusError);
          assert.equal(e.kind, 'exception');
          assert.equal(e.exceptionCode, 2);
          assert.equal(e.isLink, false);
          assert.match(e.message, /exception Modbus 2.*adresse/);
          return true;
        });
        f.s.mode = 'ok';
        assert.deepEqual(await c.read(3, 0, 1), [0]);
        assert.equal(f.connects.length, 1);
      } finally {
        c.close();
      }
    });
  });

  for (const [mode, motif] of [
    ['badTid', /transaction/], ['badProto', /protocole/], ['shortLen', /octets|incoherent/], ['hugeLen', /longueur/],
    ['badCount', /octets/], ['badFn', /fonction/], ['badUnit', /unite/], ['extra', /en trop/],
  ] as const) {
    it(`reponse mal formee (${mode}) : erreur de trame, puis reconnexion`, async () => {
      await withServer(async (f) => {
        f.s.mode = mode;
        const c = client(f);
        try {
          const t0 = Date.now();
          await assert.rejects(c.read(3, 0, 2), (e: unknown) => {
            assert.ok(e instanceof ModbusError);
            assert.equal(e.kind, 'protocol', e.message);
            assert.equal(e.isLink, true);
            assert.match(e.message, motif);
            return true;
          });
          assert.ok(Date.now() - t0 < 140, 'doit echouer tout de suite, sans attendre le delai');
          f.s.mode = 'ok';
          assert.deepEqual(await c.read(3, 0, 2), [0, 0]);
          assert.equal(f.connects.length, 2);
        } finally {
          c.close();
        }
      });
    });
  }

  it('reponse tronquee : delai depasse, puis reconnexion', async () => {
    await withServer(async (f) => {
      f.s.mode = 'truncate';
      const c = client(f, 100);
      try {
        await assert.rejects(c.read(4, 0, 2), (e: unknown) => e instanceof ModbusError && e.kind === 'timeout');
        f.s.mode = 'ok';
        assert.deepEqual(await c.read(4, 0, 2), [0, 0]);
        assert.equal(f.connects.length, 2);
      } finally {
        c.close();
      }
    });
  });

  it('pas de reponse : delai depasse', async () => {
    await withServer(async (f) => {
      f.s.mode = 'silent';
      const c = client(f, 80);
      try {
        const t0 = Date.now();
        await assert.rejects(c.read(1, 0, 1), (e: unknown) => e instanceof ModbusError && e.kind === 'timeout');
        assert.ok(Date.now() - t0 >= 70);
      } finally {
        c.close();
      }
    });
  });

  it('connexion coupee par l\'equipement', async () => {
    await withServer(async (f) => {
      f.s.mode = 'close';
      const c = client(f);
      try {
        await assert.rejects(c.read(1, 0, 1), (e: unknown) => e instanceof ModbusError && e.isLink);
      } finally {
        c.close();
      }
    });
  });

  it('connexion refusee', async () => {
    const f = fakeModbus();
    const port = await f.listen();
    await f.close();
    const c = new ModbusClient({ host: '127.0.0.1', port, unitId: 1, timeoutMs: 200 });
    await assert.rejects(c.read(1, 0, 1), (e: unknown) => e instanceof ModbusError && e.kind === 'connect');
    c.close();
  });

  it('refuse les arguments hors limites sans rien envoyer', async () => {
    await withServer(async (f) => {
      const c = client(f);
      try {
        for (const [fn, a, q] of [[3, -1, 1], [3, 65536, 1], [3, 0, 0], [3, 0, 126], [1, 0, 2001], [3, 65535, 2], [4, 1.5, 1]] as const) {
          await assert.rejects(c.read(fn, a, q), (e: unknown) => e instanceof ModbusError && e.kind === 'argument', `${fn} ${a} ${q}`);
        }
        assert.equal(f.requests.length, 0);
      } finally {
        c.close();
      }
    });
  });

  it('apres close, plus aucune lecture', async () => {
    await withServer(async (f) => {
      const c = client(f);
      await c.read(1, 0, 1);
      c.close();
      await assert.rejects(c.read(1, 0, 1), (e: unknown) => e instanceof ModbusError && e.kind === 'closed');
    });
  });
});

describe('modbus : lecture seule', () => {
  it('aucune fonction d\'ecriture dans le code', () => {
    const interdit = /write(Single|Multiple|Coil|Register|Holding)|FC_?WRITE|0x0*5\b|0x0*6\b|0x0*[fF]\b|0x10\b|fonction 5|fonction 6|fonction 15|fonction 16/i;
    const fichiers = readdirSync(SRC).filter((n) => n.endsWith('.ts'));
    assert.ok(fichiers.length >= 5);
    for (const n of fichiers) {
      const texte = readFileSync(join(SRC, n), 'utf8');
      assert.doesNotMatch(texte, interdit, n);
    }
    assert.match(readFileSync(join(SRC, 'client.ts'), 'utf8'), /type ReadFunction = 1 \| 2 \| 3 \| 4;/);
  });

  it('l\'interface du client n\'offre aucune ecriture', () => {
    const noms = Object.getOwnPropertyNames(ModbusClient.prototype);
    assert.deepEqual(noms.filter((n) => /write|set|send|poke/i.test(n)), []);
    assert.ok(noms.includes('read') && noms.includes('close'));
  });

  it('les codes fonction d\'ecriture sont refuses a l\'execution', async () => {
    await withServer(async (f) => {
      const c = client(f);
      try {
        for (const fn of [5, 6, 15, 16, 0, 23]) {
          await assert.rejects((c as unknown as { read(fn: number, a: number, q: number): Promise<unknown> }).read(fn, 0, 1), (e: unknown) => e instanceof ModbusError && e.kind === 'argument' && /lecture seule/.test(e.message), String(fn));
        }
        assert.equal(f.requests.length, 0);
      } finally {
        c.close();
      }
    });
  });

  it('le module n\'envoie jamais que les fonctions 1 a 4', async () => {
    await withServer(async (f) => {
      await runModule([dev(f.port, [
        { id: 'a', type: 'coil', address: 0, onTrue: { event: 'intrusion' } },
        { id: 'b', type: 'discrete', address: 0, onTrue: { event: 'intrusion' } },
        { id: 'c', type: 'holding', address: 0 },
        { id: 'd', type: 'input', address: 0 },
      ])], async (c) => {
        await until(() => c.emitted.length >= 4);
        await wait(80);
      });
      assert.ok(f.requests.length >= 4);
      assert.deepEqual([...new Set(f.requests.map((r) => r.fn))].sort(), [1, 2, 3, 4]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Module complet contre le faux equipement
// ---------------------------------------------------------------------------------------------------------------

describe('modbus : module', () => {
  it('contact sec : alarme a la fermeture, retour a l\'ouverture, sans repetition', async () => {
    await withServer(async (f) => {
      await runModule([dev(f.port, [{ ...intrusion, id: 'porte1' }])], async (c) => {
        await until(() => c.of('porte1').length === 1);
        assert.equal(c.of('porte1')[0].event, 'clear');
        const avant = Date.now();
        f.discrete.set(0, true);
        await until(() => c.of('porte1').length === 2);
        assert.equal(c.of('porte1')[1].event, 'intrusion');
        await wait(120); // plusieurs tours de lecture sans changement
        assert.equal(c.of('porte1').length, 2);
        f.discrete.set(0, false);
        await until(() => c.of('porte1').length === 3);
        assert.equal(c.of('porte1')[2].event, 'clear');
        const [a, b, d] = c.of('porte1');
        assert.ok(Number.isInteger(b.ts) && (b.ts as number) >= avant && (b.ts as number) <= Date.now());
        assert.equal(new Set([a.msgId, b.msgId, d.msgId]).size, 3);
        assert.ok(c.of('porte1').every((m) => m.msgId?.startsWith('porte1-')));
      });
    });
  });

  it('invert : contact normalement ferme', async () => {
    await withServer(async (f) => {
      f.discrete.set(0, true); // ferme = repos
      await runModule([dev(f.port, [{ ...intrusion, id: 'nf', invert: true }])], async (c) => {
        await until(() => c.of('nf').length === 1);
        assert.equal(c.of('nf')[0].event, 'clear');
        f.discrete.set(0, false); // coupure du circuit = alarme
        await until(() => c.of('nf').length === 2);
        assert.equal(c.of('nf')[1].event, 'intrusion');
      });
    });
  });

  it('bobines (fonction 1) et registre de bits', async () => {
    await withServer(async (f) => {
      f.coils.set(4, true);
      f.holding.set(50, 0b100);
      await runModule([dev(f.port, [
        { id: 'bob', type: 'coil', address: 4, onTrue: { state: 'alarm' }, onFalse: { state: 'normal' } },
        { id: 'grp', type: 'holding', address: 50, mode: 'bit', bit: 2, onTrue: { event: 'power_loss' }, onFalse: { event: 'power_restored' } },
        { id: 'bas', type: 'holding', address: 51, mode: 'compare', compare: { op: 'lt', value: 10 }, onTrue: { event: 'low_battery' } },
      ])], async (c) => {
        await until(() => c.of('bob').length === 1 && c.of('grp').length === 1 && c.of('bas').length === 1);
        assert.equal(c.of('bob')[0].state, 'alarm');
        assert.equal(c.of('grp')[0].event, 'power_loss');
        assert.equal(c.of('bas')[0].event, 'low_battery'); // 0 < 10
        f.holding.set(51, 12);
        await until(() => c.of('bas').length === 2);
        assert.equal(c.of('bas')[1].event, 'clear');
      });
    });
  });

  it('registres : tous types de donnees et ordres de mots, avec echelle', async () => {
    await withServer(async (f) => {
      const set = (addr: number, ws: number[]) => ws.forEach((w, i) => f.input.set(addr + i, w));
      set(0, [0xfffe]); // int16 -2
      set(1, [0x0001, 0x1170]); // uint32 70000 ABCD
      set(3, [0xffff, 0xfffe]); // int32 -2
      set(5, floatWords(230.4, 'ABCD'));
      set(7, floatWords(230.4, 'CDAB'));
      set(9, floatWords(230.4, 'BADC'));
      set(11, floatWords(230.4, 'DCBA'));
      set(13, [1234]); // uint16 * 0.1
      const base = { type: 'input', minIntervalMs: 0 };
      await runModule([dev(f.port, [
        { ...base, id: 'i16', address: 0, dataType: 'int16' },
        { ...base, id: 'u32', address: 1, dataType: 'uint32' },
        { ...base, id: 'i32', address: 3, dataType: 'int32' },
        { ...base, id: 'fabcd', address: 5, dataType: 'float32', decimals: 1 },
        { ...base, id: 'fcdab', address: 7, dataType: 'float32', wordOrder: 'little', decimals: 1 },
        { ...base, id: 'fbadc', address: 9, dataType: 'float32', byteOrder: 'little', decimals: 1 },
        { ...base, id: 'fdcba', address: 11, dataType: 'float32', wordOrder: 'little', byteOrder: 'little', decimals: 1 },
        { ...base, id: 'sc', address: 13, scale: 0.1, offset: 1, decimals: 1, unit: 'V' },
      ])], async (c) => {
        await until(() => ['i16', 'u32', 'i32', 'fabcd', 'fcdab', 'fbadc', 'fdcba', 'sc'].every((id) => c.of(id).length >= 1));
        const v = (id: string) => c.of(id)[0].value;
        assert.equal(v('i16'), -2);
        assert.equal(v('u32'), 70000);
        assert.equal(v('i32'), -2);
        assert.equal(v('fabcd'), 230.4);
        assert.equal(v('fcdab'), 230.4);
        assert.equal(v('fbadc'), 230.4);
        assert.equal(v('fdcba'), 230.4);
        assert.equal(v('sc'), 124.4);
        assert.equal(c.of('sc')[0].event, undefined);
        assert.equal(c.of('sc')[0].state, undefined);
      });
    });
  });

  it('niveau de cuve 4-20 mA : mesure, rupture de boucle, retour', async () => {
    await withServer(async (f) => {
      f.input.set(0, 12000); // 12 mA -> 1,5 m
      const cuve = { id: 'cuve', type: 'input', address: 0, minIntervalMs: 0, current4_20: { rawMin: 4000, rawMax: 20000, engMin: 0, engMax: 3 } };
      await runModule([dev(f.port, [cuve])], async (c) => {
        await until(() => c.of('cuve').length === 1);
        assert.equal(c.of('cuve')[0].value, 1.5);
        f.input.set(0, 0); // fil coupe : 0 mA
        await until(() => c.of('cuve').some((m) => m.state === 'fault'));
        await wait(150);
        assert.equal(c.of('cuve').filter((m) => m.state === 'fault').length, 1); // une seule fois
        f.input.set(0, 8000); // 8 mA -> 0,75 m
        await until(() => c.of('cuve').some((m) => m.value === 0.75));
        const msgs = c.of('cuve');
        const i = msgs.findIndex((m) => m.state === 'fault');
        assert.equal(msgs[i + 1].event, 'restored');
        assert.equal(msgs[i + 2].value, 0.75);
        assert.equal(msgs.filter((m) => m.value !== undefined && m.state !== undefined).length, 0);
      });
    });
  });

  it('anti-rebond : une impulsion breve n\'est pas emise, un etat durable l\'est', async () => {
    await withServer(async (f) => {
      await runModule([dev(f.port, [{ ...intrusion, id: 'ir', debounceMs: 200 }])], async (c) => {
        await until(() => c.of('ir').length === 1);
        f.discrete.set(0, true);
        await wait(70);
        f.discrete.set(0, false);
        await wait(400);
        assert.equal(c.of('ir').length, 1, 'impulsion breve ignoree');
        const t0 = Date.now();
        f.discrete.set(0, true);
        await until(() => c.of('ir').length === 2);
        assert.equal(c.of('ir')[1].event, 'intrusion');
        assert.ok(Date.now() - t0 >= 150, `delai ${Date.now() - t0} ms trop court`);
      });
    });
  });

  it('zone morte : les petites variations ne sont pas emises', async () => {
    await withServer(async (f) => {
      f.holding.set(0, 100);
      await runModule([dev(f.port, [{ id: 'nv', type: 'holding', address: 0, deadband: 5, minIntervalMs: 0 }])], async (c) => {
        await until(() => c.of('nv').length === 1);
        f.holding.set(0, 102);
        await wait(120);
        assert.equal(c.of('nv').length, 1);
        f.holding.set(0, 106);
        await until(() => c.of('nv').length === 2);
        assert.equal(c.of('nv')[1].value, 106);
        f.holding.set(0, 101);
        await until(() => c.of('nv').length === 3);
        assert.equal(c.of('nv')[2].value, 101);
      });
    });
  });

  it('signe de vie periodique configurable', async () => {
    await withServer(async (f) => {
      await runModule([dev(f.port, [{ ...intrusion, id: 'vie' }], { heartbeatMs: 60 })], async (c) => {
        await until(() => c.of('vie').filter((m) => m.event === 'heartbeat').length >= 3);
        assert.equal(c.of('vie').filter((m) => m.event !== 'heartbeat').length, 1);
        assert.equal(new Set(c.of('vie').map((m) => m.msgId)).size, c.of('vie').length);
      });
    });
  });

  it('equipement muet : defaut une seule fois par point, puis reprise ; journal sans repetition', async () => {
    await withServer(async (f) => {
      f.discrete.set(0, true);
      f.input.set(5, 42);
      const pts = [{ ...intrusion, id: 'a' }, { id: 'b', type: 'input', address: 5, minIntervalMs: 0 }];
      await runModule([dev(f.port, pts, { timeoutMs: 60 })], async (c) => {
        await until(() => c.of('a').length === 1 && c.of('b').length === 1);
        f.s.mode = 'silent';
        await until(() => c.of('a').some((m) => m.state === 'fault') && c.of('b').some((m) => m.state === 'fault'));
        await wait(500); // beaucoup de tours manques
        for (const id of ['a', 'b']) {
          assert.equal(c.of(id).filter((m) => m.state === 'fault').length, 1, id);
          assert.ok(c.of(id).every((m) => m.state !== 'offline'));
        }
        assert.equal(c.logs.filter((l) => /injoignable/.test(l.text)).length, 1);
        assert.ok(f.connects.length >= 2, 'reconnexions tentees');
        f.s.mode = 'ok';
        await until(() => c.of('a').length >= 3 && c.of('b').length >= 4);
        assert.equal(c.of('a')[2].event, 'intrusion'); // etat reel reemis
        assert.deepEqual(c.of('b').slice(2).map((m) => m.event ?? m.value), ['restored', 42]);
        assert.equal(c.logs.filter((l) => /de nouveau joignable/.test(l.text)).length, 1);
      });
    });
  });

  it('equipement eteint (connexion refusee) puis rallume', async () => {
    const probe = fakeModbus();
    const port = await probe.listen();
    await probe.close();
    const f = fakeModbus();
    try {
      await runModule([dev(port, [{ ...intrusion, id: 'z' }])], async (c) => {
        await until(() => c.of('z').some((m) => m.state === 'fault'));
        await wait(200);
        assert.equal(c.of('z').filter((m) => m.state === 'fault').length, 1);
        assert.equal(c.logs.filter((l) => /injoignable/.test(l.text)).length, 1);
        f.discrete.set(0, true);
        await f.listen(port);
        await until(() => c.of('z').some((m) => m.event === 'intrusion'));
      });
    } finally {
      await f.close();
    }
  });

  it('reconnexion apres coupure de la liaison', async () => {
    await withServer(async (f) => {
      await runModule([dev(f.port, [{ ...intrusion, id: 'r' }])], async (c) => {
        await until(() => c.of('r').length === 1);
        f.dropConnections();
        f.discrete.set(0, true);
        await until(() => c.of('r').some((m) => m.event === 'intrusion'));
        assert.ok(f.connects.length >= 2);
        assert.equal(c.of('r').filter((m) => m.state === 'fault').length, 0, 'une coupure breve ne declenche pas de defaut');
      });
    });
  });

  it('temporisation exponentielle entre les tentatives de reconnexion', async () => {
    await withServer(async (f) => {
      f.s.mode = 'close';
      const d = dev(f.port, [{ ...intrusion, id: 'x' }], { pollMs: 10, reconnectMinMs: 60, reconnectMaxMs: 1000, failThreshold: 50 });
      await runModule([d], async () => {
        await until(() => f.connects.length >= 5, 5000);
      });
      const g = f.connects.slice(1).map((t, i) => t - f.connects[i]);
      assert.ok(g[0] >= 50, `1er intervalle ${g[0]}`);
      assert.ok(g[1] > g[0] * 1.5, `${g[1]} vs ${g[0]}`);
      assert.ok(g[2] > g[1] * 1.5, `${g[2]} vs ${g[1]}`);
    });
  });

  it('exception sur un bloc : seuls ses points passent en defaut', async () => {
    await withServer(async (f) => {
      f.holding.set(0, 5);
      f.s.rule = (r) => (r.fn === 4 ? 'exception' : undefined);
      const pts = [{ id: 'h', type: 'holding', address: 0 }, { id: 'i', type: 'input', address: 9999 }];
      await runModule([dev(f.port, pts)], async (c) => {
        await until(() => c.of('i').some((m) => m.state === 'fault'));
        await wait(150);
        assert.equal(c.of('h')[0].value, 5);
        assert.equal(c.of('h').filter((m) => m.state === 'fault').length, 0);
        assert.equal(c.of('i').filter((m) => m.state === 'fault').length, 1);
        assert.equal(c.logs.filter((l) => /lecture refusee/.test(l.text)).length, 1);
        assert.equal(f.connects.length, 1);
      });
    });
  });

  it('reponse mal formee de l\'equipement : defaut, pas de plantage', async () => {
    await withServer(async (f) => {
      f.s.mode = 'badCount';
      await runModule([dev(f.port, [{ ...intrusion, id: 'm' }])], async (c) => {
        await until(() => c.of('m').some((m) => m.state === 'fault'));
        f.s.mode = 'ok';
        await until(() => c.of('m').some((m) => m.event === 'clear'));
      });
    });
  });

  it('plusieurs equipements independants', async () => {
    await withServer(async (f1) => {
      await withServer(async (f2) => {
        f1.discrete.set(0, true);
        await runModule([
          dev(f1.port, [{ ...intrusion, id: 'e1' }], { name: 'un' }),
          dev(f2.port, [{ ...intrusion, id: 'e2' }], { name: 'deux', unitId: 7 }),
        ], async (c) => {
          await until(() => c.of('e1').length === 1 && c.of('e2').length === 1);
          assert.equal(c.of('e1')[0].event, 'intrusion');
          assert.equal(c.of('e2')[0].event, 'clear');
          assert.ok(f2.requests.every((r) => r.unit === 7));
        });
      });
    });
  });

  it('arret propre : meme pendant un echange, rien n\'est emis ensuite', async () => {
    await withServer(async (f) => {
      const c = fakeCtx();
      const mod = create({ devices: [dev(f.port, [{ ...intrusion, id: 's' }], { timeoutMs: 5000 })] });
      await mod.start(c.ctx);
      await until(() => c.of('s').length === 1);
      f.s.mode = 'silent';
      const vus = f.requests.length;
      await until(() => f.requests.length > vus); // une requete reste sans reponse
      const t0 = Date.now();
      await mod.stop();
      assert.ok(Date.now() - t0 < 500, 'arret rapide');
      const n = c.emitted.length;
      const conns = f.connects.length;
      f.s.mode = 'ok';
      f.discrete.set(0, true);
      await wait(150);
      assert.equal(c.emitted.length, n);
      assert.equal(f.connects.length, conns);
      await until(() => f.s.sockets.size === 0);
      await mod.stop(); // idempotent
    });
  });

  it('le module porte son nom et refuse une configuration invalide a la creation', () => {
    assert.equal(create({ devices: [{ name: 'a', host: '127.0.0.1', points: [intrusion] }] }).name, 'modbus');
    assert.throws(() => create({ devices: [{ name: 'a', host: '127.0.0.1', points: [{ ...intrusion, address: 99999 }] }] }), /address/);
  });
});
