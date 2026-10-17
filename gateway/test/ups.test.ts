import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeviceMessage, ModuleContext } from '../src/module.ts';
import { create } from '../src/modules/ups/index.ts';
import { parseConfig } from '../src/modules/ups/config.ts';
import { BerError, buildGetRequest, decodeResponse, readTlv } from '../src/modules/ups/ber.ts';
import { nutFetch, parseNutStatus } from '../src/modules/ups/nut.ts';
import { statusFromSnmp } from '../src/modules/ups/snmp.ts';
import { UpsTracker, statusMessages } from '../src/modules/ups/tracker.ts';
import type { UpsStatus } from '../src/modules/ups/reading.ts';

// ---------- outils ----------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition non atteinte a temps');
    await sleep(15);
  }
}

interface Emitted {
  id: string;
  msg: DeviceMessage;
}

function makeCtx(clock?: { t: number }) {
  const emitted: Emitted[] = [];
  const logs: Array<{ level: string; text: string }> = [];
  const ctx: ModuleContext = {
    emit: (id, msg) => void emitted.push({ id, msg }),
    openMqtt: async () => {
      throw new Error('non utilise');
    },
    log: (level, text) => void logs.push({ level, text }),
    onActuator: () => undefined,
    onAccessSync: () => undefined,
    config: {},
    now: () => (clock ? clock.t : Date.now()),
  };
  const of = (id: string) => emitted.filter((e) => e.id === id).map((e) => ({ ...e.msg, ts: undefined, msgId: undefined }));
  const brief = (id: string) => emitted.filter((e) => e.id === id).map((e) => e.msg.event ?? e.msg.state ?? `v=${e.msg.value}`);
  return { ctx, emitted, logs, of, brief };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

// ---------- serveur NUT factice ----------

type NutMode = 'ok' | 'hang' | 'truncated' | 'garbage' | 'longline' | 'errlist' | 'multi' | 'flood';

interface NutFake {
  port: number;
  vars: Record<string, string>;
  commands: string[];
  connections: number;
  mode: NutMode;
  close(): Promise<void>;
}

async function startNut(opts: { port?: number; mode?: NutMode; vars?: Record<string, string>; ups?: string } = {}): Promise<NutFake> {
  const ups = opts.ups ?? 'myups';
  const sockets = new Set<net.Socket>();
  const fake: NutFake = { port: 0, vars: { ...(opts.vars ?? {}) }, commands: [], connections: 0, mode: opts.mode ?? 'ok', close: async () => {} };
  const server = net.createServer((sock) => {
    fake.connections++;
    sockets.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      for (;;) {
        const i = buf.indexOf('\n');
        if (i < 0) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        fake.commands.push(line);
        answer(sock, line);
      }
    });
  });
  const answer = (sock: net.Socket, line: string) => {
    switch (fake.mode) {
      case 'hang':
        return;
      case 'garbage':
        sock.write('bonjour\n');
        return;
      case 'longline':
        sock.write('A'.repeat(10_000));
        return;
      case 'truncated':
        sock.write(`BEGIN LIST VAR ${ups}\nVAR ${ups} ups.status "OL"\n`);
        sock.end();
        return;
      case 'flood': {
        sock.write(`BEGIN LIST VAR ${ups}\n`);
        let n = 0;
        const timer = setInterval(() => {
          if (sock.destroyed) return clearInterval(timer);
          sock.write(Array.from({ length: 200 }, () => `VAR ${ups} x.${n++} "1"\n`).join(''));
        }, 1);
        sock.on('close', () => clearInterval(timer));
        return;
      }
      default:
    }
    if (line === 'LIST UPS') {
      sock.write(`BEGIN LIST UPS\nUPS ${ups} "Onduleur factice"\n${fake.mode === 'multi' ? 'UPS autre "B"\n' : ''}END LIST UPS\n`);
    } else if (line === `LIST VAR ${ups}`) {
      if (fake.mode === 'errlist') return void sock.write('ERR ACCESS-DENIED\n');
      sock.write(`BEGIN LIST VAR ${ups}\n${Object.entries(fake.vars).map(([k, v]) => `VAR ${ups} ${k} "${v}"\n`).join('')}END LIST VAR ${ups}\n`);
    } else if (line.startsWith(`GET VAR ${ups} `)) {
      const name = line.slice(`GET VAR ${ups} `.length);
      if (Object.hasOwn(fake.vars, name)) sock.write(`VAR ${ups} ${name} "${fake.vars[name]}"\n`);
      else sock.write('ERR VAR-NOT-SUPPORTED\n');
    } else {
      sock.write('ERR UNKNOWN-COMMAND\n');
    }
  };
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  fake.port = (server.address() as net.AddressInfo).port;
  fake.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return fake;
}

// ---------- repondeur SNMP factice (codage ecrit a la main, independant du code teste) ----------

function tl(tag: number, body: Buffer): Buffer {
  const n = body.length;
  const head = n < 128 ? [tag, n] : n < 256 ? [tag, 0x81, n] : [tag, 0x82, n >> 8, n & 255];
  return Buffer.concat([Buffer.from(head), body]);
}

function iv(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  do {
    bytes.unshift(v & 255);
    v = Math.floor(v / 256);
  } while (v > 0);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tl(2, Buffer.from(bytes));
}

function rd(b: Buffer, p: number): { tag: number; s: number; e: number } {
  const tag = b[p]!;
  let len = b[p + 1]!;
  let s = p + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[s++]!;
  }
  return { tag, s, e: s + len };
}

function oidString(b: Buffer, s: number, e: number): string {
  const arcs: number[] = [];
  let cur = 0;
  for (let i = s; i < e; i++) {
    cur = cur * 128 + (b[i]! & 0x7f);
    if (!(b[i]! & 0x80)) {
      if (arcs.length === 0) arcs.push(Math.floor(cur / 40), cur % 40);
      else arcs.push(cur);
      cur = 0;
    }
  }
  return arcs.join('.');
}

interface SnmpReq {
  version: number;
  community: string;
  pduTag: number;
  rid: Buffer;
  oidTlv: Buffer;
  oid: string;
}

function parseRequest(b: Buffer): SnmpReq {
  const m = rd(b, 0);
  const ver = rd(b, m.s);
  const com = rd(b, ver.e);
  const pdu = rd(b, com.e);
  const rid = rd(b, pdu.s);
  const es = rd(b, rid.e);
  const ei = rd(b, es.e);
  const vbl = rd(b, ei.e);
  const vb = rd(b, vbl.s);
  const oid = rd(b, vb.s);
  return {
    version: b[ver.s]!,
    community: b.subarray(com.s, com.e).toString(),
    pduTag: pdu.tag,
    rid: b.subarray(rid.s, rid.e),
    oidTlv: b.subarray(vb.s, oid.e),
    oid: oidString(b, oid.s, oid.e),
  };
}

type SnmpMode = 'ok' | 'silent' | 'badid' | 'garbage' | 'huge' | 'wrongcomm';

interface SnmpFake {
  port: number;
  values: Map<string, number>;
  requests: SnmpReq[];
  mode: SnmpMode;
  close(): Promise<void>;
}

async function startSnmp(opts: { community?: string; mode?: SnmpMode; values?: Record<string, number> } = {}): Promise<SnmpFake> {
  const community = opts.community ?? 'public';
  const sock = dgram.createSocket('udp4');
  const fake: SnmpFake = { port: 0, values: new Map(Object.entries(opts.values ?? {})), requests: [], mode: opts.mode ?? 'ok', close: async () => {} };
  const build = (req: SnmpReq, o: { rid?: Buffer; community?: string; forced?: number } = {}): Buffer => {
    const v = o.forced ?? fake.values.get(req.oid);
    let status = 0;
    let value: Buffer;
    if (v === undefined) {
      if (req.version === 0) {
        status = 2;
        value = Buffer.from([5, 0]);
      } else value = Buffer.from([0x80, 0]);
    } else value = req.oid.endsWith('.2.4.0') ? tl(0x42, iv(v).subarray(2)) : iv(v);
    const vb = tl(0x30, Buffer.concat([req.oidTlv, value]));
    const pdu = tl(0xa2, Buffer.concat([tl(2, o.rid ?? req.rid), iv(status), iv(status === 0 ? 0 : 1), tl(0x30, vb)]));
    return tl(0x30, Buffer.concat([iv(req.version), tl(4, Buffer.from(o.community ?? community)), pdu]));
  };
  sock.on('message', (msg, rinfo) => {
    let req: SnmpReq;
    try {
      req = parseRequest(msg);
    } catch {
      return;
    }
    fake.requests.push(req);
    const reply = (b: Buffer) => sock.send(b, rinfo.port, rinfo.address);
    switch (fake.mode) {
      case 'silent':
        return;
      case 'wrongcomm':
        return reply(build(req, { community: 'autre' }));
      case 'badid': {
        const bad = Buffer.from(req.rid);
        bad[bad.length - 1] = (bad[bad.length - 1]! + 1) & 255;
        reply(build(req, { rid: bad, forced: 3 })); // valeur piege : doit etre ignoree
        return reply(build(req));
      }
      case 'garbage':
        reply(Buffer.from([1, 2, 3, 4, 5, 0xff, 0xfe]));
        reply(Buffer.from([0x30, 0x84, 0xff, 0xff, 0xff, 0xff, 0x02, 0x01]));
        return reply(build(req));
      case 'huge':
        reply(Buffer.from([0x30, 0x84, 0x7f, 0xff, 0xff, 0xff, 0x02, 0x01, 0x01]));
        return reply(build(req));
      default:
        reply(build(req));
    }
  });
  await new Promise<void>((resolve) => sock.bind(0, '127.0.0.1', resolve));
  fake.port = sock.address().port;
  fake.close = () => new Promise<void>((resolve) => sock.close(() => resolve()));
  return fake;
}

const OID_MIB = {
  batteryStatus: '1.3.6.1.2.1.33.1.2.1.0',
  minutes: '1.3.6.1.2.1.33.1.2.3.0',
  charge: '1.3.6.1.2.1.33.1.2.4.0',
  voltage: '1.3.6.1.2.1.33.1.2.5.0',
  temp: '1.3.6.1.2.1.33.1.2.7.0',
  inVolt: '1.3.6.1.2.1.33.1.3.3.1.3.1',
  source: '1.3.6.1.2.1.33.1.4.1.0',
  load: '1.3.6.1.2.1.33.1.4.4.1.5.1',
};

const ALL_IDS = { status: 'st', charge: 'ch', runtime: 'rt', load: 'ld', battery_voltage: 'bv', input_voltage: 'iv', temperature: 'tp' };
const FAST = { pollMs: 100, timeoutMs: 300, minIntervalMs: 0, heartbeatMs: 0 };

const NUT_OK = {
  'ups.status': 'OL CHRG',
  'battery.charge': '100',
  'battery.runtime': '1800',
  'ups.load': '20',
  'battery.voltage': '13.6',
  'input.voltage': '230.1',
  'ups.temperature': '25',
};

// ---------- configuration ----------

const base = { name: 'o1', transport: 'nut', host: '127.0.0.1', ids: { status: 'st' } };

test('config : valeurs par defaut', () => {
  const [c] = parseConfig({ ups: [base] });
  assert.equal(c!.port, 3493);
  assert.equal(c!.pollMs, 15000);
  assert.equal(c!.maxFailures, 3);
  assert.equal(c!.runtimeUnit, 'min');
  const [s] = parseConfig({ ups: [{ ...base, transport: 'snmp' }] });
  assert.equal(s!.port, 161);
  assert.equal(s!.version, '2c');
  assert.equal(s!.community, 'public');
});

test('config : refus strict avec message clair en francais', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['pas une liste', { ups: 'x' }, /au moins un onduleur/],
    ['liste vide', { ups: [] }, /au moins un onduleur/],
    ['cle de section inconnue', { ups: [base], autre: 1 }, /cle inconnue "autre"/],
    ['cle inconnue', { ups: [{ ...base, vitesse: 1 }] }, /cle inconnue "vitesse"/],
    ['nom absent', { ups: [{ ...base, name: undefined }] }, /"name" est obligatoire/],
    ['nom invalide', { ups: [{ ...base, name: 'a b' }] }, /"name" est obligatoire/],
    ['nom en double', { ups: [base, { ...base, ids: { status: 'st2' } }] }, /deja utilise/],
    ['transport inconnu', { ups: [{ ...base, transport: 'modbus' }] }, /"transport" doit valoir/],
    ['hote absent', { ups: [{ ...base, host: undefined }] }, /"host" est obligatoire/],
    ['hote avec espace', { ups: [{ ...base, host: 'a b' }] }, /"host" est obligatoire/],
    ['hote avec retour a la ligne', { ups: [{ ...base, host: 'a\nLIST UPS' }] }, /"host" est obligatoire/],
    ['port 0', { ups: [{ ...base, port: 0 }] }, /"port" doit etre un entier/],
    ['port texte', { ups: [{ ...base, port: '3493' }] }, /"port" doit etre un entier/],
    ['upsName sur snmp', { ups: [{ ...base, transport: 'snmp', upsName: 'x' }] }, /"upsName" ne s'applique qu'au transport "nut"/],
    ['upsName avec espace', { ups: [{ ...base, upsName: 'a b' }] }, /"upsName" invalide/],
    ['community sur nut', { ups: [{ ...base, community: 'public' }] }, /"community" ne s'applique qu'au transport "snmp"/],
    ['version numerique', { ups: [{ ...base, transport: 'snmp', version: 2 }] }, /"version" doit valoir/],
    ['version 3', { ups: [{ ...base, transport: 'snmp', version: '3' }] }, /"version" doit valoir/],
    ['pollMs trop petit', { ups: [{ ...base, pollMs: 5 }] }, /"pollMs" doit etre un entier/],
    ['timeoutMs decimal', { ups: [{ ...base, timeoutMs: 100.5 }] }, /"timeoutMs" doit etre un entier/],
    ['maxFailures 0', { ups: [{ ...base, maxFailures: 0 }] }, /"maxFailures" doit etre un entier/],
    ['heartbeat trop court', { ups: [{ ...base, heartbeatMs: 10 }] }, /"heartbeatMs" doit etre un entier/],
    ['runtimeUnit inconnue', { ups: [{ ...base, runtimeUnit: 'h' }] }, /"runtimeUnit" doit valoir/],
    ['deadband grandeur inconnue', { ups: [{ ...base, deadband: { vitesse: 1 } }] }, /grandeur inconnue "vitesse"/],
    ['deadband negatif', { ups: [{ ...base, deadband: { charge: -1 } }] }, /"deadband.charge"/],
    ['ids absent', { ups: [{ ...base, ids: undefined }] }, /"ids" est obligatoire/],
    ['ids vide', { ups: [{ ...base, ids: {} }] }, /au moins une grandeur/],
    ['ids grandeur inconnue', { ups: [{ ...base, ids: { vitesse: 'x' } }] }, /grandeur inconnue "vitesse"/],
    ['ids identifiant invalide', { ups: [{ ...base, ids: { status: 'a/b' } }] }, /"ids.status" doit etre un identifiant PSIM valide/],
    ['identifiant reutilise', { ups: [{ ...base, ids: { status: 'x', charge: 'x' } }] }, /deja utilise/],
    ['identifiant reutilise entre onduleurs', { ups: [base, { ...base, name: 'o2' }] }, /deja utilise/],
  ];
  for (const [label, cfg, re] of cases) {
    assert.throws(() => parseConfig(cfg as Record<string, unknown>), (e: unknown) => e instanceof Error && re.test(e.message) && e.message.startsWith('Module ups'), label);
  }
});

test('config : la communaute SNMP n\'apparait jamais dans un message d\'erreur', () => {
  assert.throws(
    () => parseConfig({ ups: [{ ...base, transport: 'snmp', community: 'mot de passe secret', ids: { status: 'st' } }] }),
    (e: unknown) => e instanceof Error && /"community" invalide/.test(e.message) && !e.message.includes('secret'),
  );
});

test('create : une configuration invalide leve tout de suite', () => {
  assert.throws(() => create({ ups: [] }), /au moins un onduleur/);
});

// ---------- logique : transitions d'etat ----------

test('statusMessages : toutes les transitions', () => {
  const ok: UpsStatus = { onBattery: false, degrade: 'none' };
  const ob: UpsStatus = { onBattery: true, degrade: 'none' };
  const obLow: UpsStatus = { onBattery: true, degrade: 'low_battery' };
  const low: UpsStatus = { onBattery: false, degrade: 'low_battery' };
  const flt: UpsStatus = { onBattery: false, degrade: 'fault' };
  const names = (p: UpsStatus | null, c: UpsStatus) => statusMessages(p, c).map((m) => m.msg.event ?? m.msg.state);
  assert.deepEqual(names(null, ok), ['normal']);
  assert.deepEqual(names(null, ob), ['power_loss']);
  assert.deepEqual(names(null, low), ['low_battery']);
  assert.deepEqual(names(ok, ok), []);
  assert.deepEqual(names(ob, ob), []);
  assert.deepEqual(names(ok, ob), ['power_loss']);
  assert.deepEqual(names(ok, obLow), ['power_loss', 'low_battery']);
  assert.deepEqual(names(ob, obLow), ['low_battery']);
  assert.deepEqual(names(obLow, ob), ['power_loss']);
  assert.deepEqual(names(obLow, ok), ['power_restored', 'normal']);
  assert.deepEqual(names(obLow, low), ['power_restored', 'low_battery']);
  assert.deepEqual(names(ob, ok), ['power_restored']);
  assert.deepEqual(names(low, ok), ['normal']);
  assert.deepEqual(names(low, obLow), ['power_loss', 'low_battery']);
  assert.deepEqual(names(low, ob), ['power_loss']);
  assert.deepEqual(names(ok, flt), ['fault']);
  assert.deepEqual(names(flt, ok), ['normal']);
});

test('parseNutStatus : drapeaux NUT', () => {
  assert.deepEqual(parseNutStatus('OL'), { onBattery: false, degrade: 'none' });
  assert.deepEqual(parseNutStatus('OL CHRG'), { onBattery: false, degrade: 'none' });
  assert.deepEqual(parseNutStatus('OL TRIM'), { onBattery: false, degrade: 'none' });
  assert.deepEqual(parseNutStatus('OL BOOST'), { onBattery: false, degrade: 'none' });
  assert.deepEqual(parseNutStatus('OB DISCHRG'), { onBattery: true, degrade: 'none' });
  assert.deepEqual(parseNutStatus('OB DISCHRG LB'), { onBattery: true, degrade: 'low_battery' });
  assert.deepEqual(parseNutStatus('OL RB'), { onBattery: false, degrade: 'low_battery' });
  assert.deepEqual(parseNutStatus('OL OVER'), { onBattery: false, degrade: 'fault' });
  assert.deepEqual(parseNutStatus('ob  lb'), { onBattery: true, degrade: 'low_battery' });
  assert.equal(parseNutStatus('   '), undefined);
});

test('statusFromSnmp : UPS-MIB', () => {
  assert.deepEqual(statusFromSnmp(3, 2), { onBattery: false, degrade: 'none' });
  assert.deepEqual(statusFromSnmp(5, 2), { onBattery: true, degrade: 'none' });
  assert.deepEqual(statusFromSnmp(5, 3), { onBattery: true, degrade: 'low_battery' });
  assert.deepEqual(statusFromSnmp(3, 4), { onBattery: false, degrade: 'low_battery' });
  assert.deepEqual(statusFromSnmp(2, 2), { onBattery: false, degrade: 'fault' });
  assert.equal(statusFromSnmp(null, null), undefined);
});

function trackerFor(extra: Record<string, unknown> = {}) {
  const [c] = parseConfig({ ups: [{ ...base, ids: { status: 'st', charge: 'ch', runtime: 'rt' }, ...extra }] });
  return new UpsTracker(c!);
}

const okStatus: UpsStatus = { onBattery: false, degrade: 'none' };

test('mesures : ecart minimal (deadband) et periode minimale', () => {
  const tr = trackerFor({ minIntervalMs: 5000, heartbeatMs: 0, deadband: { charge: 2 } });
  const values = (charge: number, now: number) => tr.onReading({ status: okStatus, values: { charge } }, now).emissions.filter((e) => e.deviceId === 'ch').map((e) => e.msg.value);
  assert.deepEqual(values(100, 0), [100]); // premiere mesure : toujours envoyee
  assert.deepEqual(values(99, 10_000), []); // ecart 1 < 2
  assert.deepEqual(values(98, 10_000), [98]); // ecart 2 depuis la derniere envoyee
  assert.deepEqual(values(90, 12_000), []); // grand ecart mais periode minimale (5 s) pas ecoulee
  assert.deepEqual(values(90, 15_000), [90]);
  assert.deepEqual(values(90, 99_000), []); // inchange : rien (heartbeatMs = 0)
});

test('mesures : l\'autonomie est convertie en minutes ou en secondes', () => {
  const trMin = trackerFor({});
  const m = trMin.onReading({ status: okStatus, values: { runtime: 1800 } }, 0).emissions.find((e) => e.deviceId === 'rt');
  assert.equal(m!.msg.value, 30);
  const trSec = trackerFor({ runtimeUnit: 's' });
  const s = trSec.onReading({ status: okStatus, values: { runtime: 1800 } }, 0).emissions.find((e) => e.deviceId === 'rt');
  assert.equal(s!.msg.value, 1800);
});

test('signe de vie periodique : heartbeat sur l\'etat, rafraichissement des mesures', () => {
  const tr = trackerFor({ heartbeatMs: 1000, minIntervalMs: 0 });
  const r = (now: number) => tr.onReading({ status: okStatus, values: { charge: 100 } }, now).emissions.map((e) => `${e.deviceId}:${e.msg.event ?? e.msg.state ?? e.msg.value}`);
  assert.deepEqual(r(0), ['st:normal', 'ch:100']);
  assert.deepEqual(r(500), []);
  assert.deepEqual(r(1000), ['st:heartbeat', 'ch:100']);
  assert.deepEqual(r(1500), []);
});

test('injoignable : defaut une seule fois par identifiant, reprise explicite', () => {
  const tr = trackerFor({ maxFailures: 3 });
  assert.deepEqual(tr.onFailure().emissions, []);
  assert.deepEqual(tr.onFailure().emissions, []);
  const third = tr.onFailure();
  assert.equal(third.fault, true);
  assert.deepEqual(third.emissions.map((e) => `${e.deviceId}:${e.msg.state}`).sort(), ['ch:fault', 'rt:fault', 'st:fault']);
  assert.deepEqual(tr.onFailure().emissions, []);
  assert.deepEqual(tr.onFailure().emissions, []);
  const back = tr.onReading({ status: okStatus, values: { charge: 80, runtime: 600 } }, 1000);
  assert.equal(back.recovered, true);
  assert.deepEqual(
    back.emissions.map((e) => `${e.deviceId}:${e.msg.event ?? e.msg.state ?? e.msg.value}`),
    ['st:normal', 'ch:normal', 'ch:80', 'rt:normal', 'rt:10'],
  );
  // Une panne plus courte que le seuil ne declenche rien et ne force pas de nouvel etat.
  tr.onFailure();
  const brief = tr.onReading({ status: okStatus, values: { charge: 80, runtime: 600 } }, 2000);
  assert.equal(brief.recovered, false);
  assert.deepEqual(brief.emissions, []);
});

// ---------- NUT : module complet ----------

test('NUT : lecture nominale, ts de la lecture, msgId uniques', async () => {
  const nut = await startNut({ vars: NUT_OK });
  const clock = { t: 1_700_000_000_000 };
  const { ctx, emitted, of } = makeCtx(clock);
  const mod = create({ ups: [{ name: 'o1', transport: 'nut', host: '127.0.0.1', port: nut.port, ...FAST, ids: ALL_IDS }] });
  try {
    await mod.start(ctx);
    await waitFor(() => emitted.length >= 7);
    await sleep(350); // plusieurs lectures de plus : rien de nouveau
    assert.equal(emitted.length, 7);
    assert.deepEqual(of('st'), [{ state: 'normal', ts: undefined, msgId: undefined }]);
    assert.equal(of('ch')[0]!.value, 100);
    assert.equal(of('rt')[0]!.value, 30);
    assert.equal(of('ld')[0]!.value, 20);
    assert.equal(of('bv')[0]!.value, 13.6);
    assert.equal(of('iv')[0]!.value, 230.1);
    assert.equal(of('tp')[0]!.value, 25);
    for (const e of emitted) assert.equal(e.msg.ts, clock.t);
    const ids = emitted.map((e) => e.msg.msgId);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id!, /^[A-Za-z0-9_-]{1,100}$/);
  } finally {
    await mod.stop();
    await nut.close();
  }
});

test('NUT : secteur coupe puis revenu, batterie faible, sans repetition', async () => {
  const nut = await startNut({ vars: NUT_OK });
  const { ctx, brief } = makeCtx();
  const mod = create({ ups: [{ name: 'o1', transport: 'nut', host: '127.0.0.1', port: nut.port, ...FAST, ids: { status: 'st' } }] });
  try {
    await mod.start(ctx);
    await waitFor(() => brief('st').length === 1);
    nut.vars['ups.status'] = 'OB DISCHRG';
    await waitFor(() => brief('st').length === 2);
    await sleep(350); // plusieurs lectures sur batterie : pas de nouvelle coupure
    assert.deepEqual(brief('st'), ['normal', 'power_loss']);
    nut.vars['ups.status'] = 'OB DISCHRG LB';
    await waitFor(() => brief('st').length === 3);
    await sleep(250);
    nut.vars['ups.status'] = 'OL CHRG';
    await waitFor(() => brief('st').length === 5);
    await sleep(350);
    assert.deepEqual(brief('st'), ['normal', 'power_loss', 'low_battery', 'power_restored', 'normal']);
  } finally {
    await mod.stop();
    await nut.close();
  }
});

test('NUT : batterie a remplacer (RB) au demarrage = low_battery', async () => {
  const nut = await startNut({ vars: { 'ups.status': 'OL RB' } });
  const { ctx, brief } = makeCtx();
  const mod = create({ ups: [{ name: 'o1', transport: 'nut', host: '127.0.0.1', port: nut.port, ...FAST, ids: { status: 'st' } }] });
  try {
    await mod.start(ctx);
    await waitFor(() => brief('st').length === 1);
    await sleep(250);
    assert.deepEqual(brief('st'), ['low_battery']);
  } finally {
    await mod.stop();
    await nut.close();
  }
});

test('NUT : variables, ecart et periode minimale de bout en bout', async () => {
  const nut = await startNut({ vars: NUT_OK });
  const clock = { t: 1_000_000 };
  const { ctx, brief } = makeCtx(clock);
  const mod = create({ ups: [{ name: 'o1', transport: 'nut', host: '127.0.0.1', port: nut.port, ...FAST, minIntervalMs: 5000, deadband: { charge: 5 }, ids: { charge: 'ch' } }] });
  try {
    await mod.start(ctx);
    await waitFor(() => brief('ch').length === 1);
    nut.vars['battery.charge'] = '97'; // ecart 3 < 5
    await sleep(300);
    assert.equal(brief('ch').length, 1);
    nut.vars['battery.charge'] = '90'; // ecart 10 mais periode minimale pas ecoulee
    await sleep(300);
    assert.equal(brief('ch').length, 1);
    clock.t += 6000;
    await waitFor(() => brief('ch').length === 2);
    assert.deepEqual(brief('ch'), ['v=100', 'v=90']);
  } finally {
    await mod.stop();
    await nut.close();
  }
});

test('NUT : decouverte du nom par LIST UPS, refus si plusieurs onduleurs', async () => {
  const nut = await startNut({ vars: NUT_OK });
  try {
    const r = await nutFetch({ host: '127.0.0.1', port: nut.port, timeoutMs: 500, upsName: null }, ['ups.status']);
    assert.equal(r.status?.onBattery, false);
    assert.equal(nut.commands[0], 'LIST UPS');
    nut.mode = 'multi';
    await assert.rejects(nutFetch({ host: '127.0.0.1', port: nut.port, timeoutMs: 500, upsName: null }, []), /plusieurs onduleurs/);
  } finally {
    await nut.close();
  }
});

test('NUT : LIST VAR refuse -> repli sur GET VAR', async () => {
  const nut = await startNut({ vars: NUT_OK, mode: 'errlist' });
  try {
    const r = await nutFetch({ host: '127.0.0.1', port: nut.port, timeoutMs: 500, upsName: 'myups' }, ['ups.status', 'battery.charge', 'ups.absente']);
    assert.equal(r.values.charge, 100);
    assert.ok(nut.commands.includes('GET VAR myups battery.charge'));
  } finally {
    await nut.close();
  }
});

test('NUT : reponses tronquees, illisibles, trop longues ou sans fin = erreur sans plantage', async () => {
  const nut = await startNut({ vars: NUT_OK });
  const fetchIt = () => nutFetch({ host: '127.0.0.1', port: nut.port, timeoutMs: 400, upsName: 'myups' }, ['ups.status']);
  try {
    nut.mode = 'truncated';
    await assert.rejects(fetchIt(), /fermee avant la fin/);
    nut.mode = 'garbage';
    await assert.rejects(fetchIt(), /mal formee/);
    nut.mode = 'longline';
    await assert.rejects(fetchIt(), /trop longue/);
    nut.mode = 'flood';
    await assert.rejects(fetchIt(), /trop (longue|volumineuse)/);
    nut.mode = 'hang';
    const t0 = Date.now();
    await assert.rejects(fetchIt(), /delai depasse/);
    assert.ok(Date.now() - t0 < 1500);
  } finally {
    await nut.close();
  }
});

test('NUT : valeurs non numeriques ignorees', async () => {
  const nut = await startNut({ vars: { ...NUT_OK, 'battery.charge': 'abc', 'ups.load': '1e999', 'battery.voltage': '' } });
  try {
    const r = await nutFetch({ host: '127.0.0.1', port: nut.port, timeoutMs: 500, upsName: 'myups' }, []);
    assert.equal(r.values.charge, undefined);
    assert.equal(r.values.load, undefined);
    assert.equal(r.values.battery_voltage, undefined);
    assert.equal(r.values.input_voltage, 230.1);
  } finally {
    await nut.close();
  }
});

test('NUT : injoignable -> defaut une fois par identifiant, journal sobre, puis reprise', async () => {
  const port = await freePort(); // personne n'ecoute
  const { ctx, emitted, logs, brief } = makeCtx();
  const mod = create({ ups: [{ name: 'o1', transport: 'nut', host: '127.0.0.1', port, ...FAST, maxFailures: 2, ids: { status: 'st', charge: 'ch' } }] });
  let nut: NutFake | null = null;
  try {
    await mod.start(ctx);
    await waitFor(() => emitted.length === 2);
    await sleep(600); // beaucoup d'autres echecs : pas de nouveau defaut
    assert.deepEqual(brief('st'), ['fault']);
    assert.deepEqual(brief('ch'), ['fault']);
    assert.ok(logs.length <= 3, `journal trop bavard : ${logs.length} lignes`);
    nut = await startNut({ port, vars: NUT_OK });
    await waitFor(() => emitted.length >= 5);
    assert.deepEqual(brief('st'), ['fault', 'normal']);
    assert.deepEqual(brief('ch'), ['fault', 'normal', 'v=100']);
    assert.ok(logs.some((l) => /de nouveau joignable/.test(l.text)));
  } finally {
    await mod.stop();
    await nut?.close();
  }
});

test('NUT : un serveur qui ne repond pas est abandonne apres le delai', async () => {
  const nut = await startNut({ mode: 'hang' });
  const { ctx, brief } = makeCtx();
  const mod = create({ ups: [{ name: 'o1', transport: 'nut', host: '127.0.0.1', port: nut.port, ...FAST, timeoutMs: 100, maxFailures: 2, ids: { status: 'st' } }] });
  try {
    await mod.start(ctx);
    await waitFor(() => brief('st').length === 1);
    assert.deepEqual(brief('st'), ['fault']);
    assert.ok(nut.connections >= 2);
  } finally {
    await mod.stop();
    await nut.close();
  }
});

test('NUT : arret propre, meme avec une lecture en cours', async () => {
  const nut = await startNut({ mode: 'hang' });
  const { ctx, emitted } = makeCtx();
  const mod = create({ ups: [{ name: 'o1', transport: 'nut', host: '127.0.0.1', port: nut.port, ...FAST, timeoutMs: 30_000, ids: { status: 'st' } }] });
  try {
    await mod.start(ctx);
    await waitFor(() => nut.connections >= 1);
    const t0 = Date.now();
    await mod.stop();
    assert.ok(Date.now() - t0 < 1000, 'stop() doit interrompre la lecture en cours');
    const seen = nut.connections;
    await sleep(350);
    assert.equal(nut.connections, seen, 'aucune nouvelle connexion apres stop()');
    assert.equal(emitted.length, 0);
    await mod.stop(); // idempotent
  } finally {
    await nut.close();
  }
});

// ---------- SNMP ----------

const MIB_OK = {
  [OID_MIB.source]: 3,
  [OID_MIB.batteryStatus]: 2,
  [OID_MIB.charge]: 95,
  [OID_MIB.minutes]: 20,
  [OID_MIB.voltage]: 136,
  [OID_MIB.inVolt]: 231,
  [OID_MIB.load]: 30,
  [OID_MIB.temp]: 27,
};

test('SNMP v2c : lecture nominale, unites, coupure et retour du secteur', async () => {
  const snmp = await startSnmp({ values: MIB_OK });
  const { ctx, emitted, brief, of } = makeCtx();
  const mod = create({ ups: [{ name: 'o2', transport: 'snmp', host: '127.0.0.1', port: snmp.port, version: '2c', ...FAST, ids: ALL_IDS }] });
  try {
    await mod.start(ctx);
    await waitFor(() => emitted.length >= 7);
    assert.equal(of('ch')[0]!.value, 95);
    assert.equal(of('rt')[0]!.value, 20);
    assert.equal(of('bv')[0]!.value, 13.6); // 0,1 V -> V
    assert.equal(of('iv')[0]!.value, 231);
    assert.equal(of('ld')[0]!.value, 30);
    assert.equal(of('tp')[0]!.value, 27);
    snmp.values.set(OID_MIB.source, 5);
    await waitFor(() => brief('st').length === 2);
    await sleep(350);
    assert.deepEqual(brief('st'), ['normal', 'power_loss']);
    snmp.values.set(OID_MIB.batteryStatus, 3);
    await waitFor(() => brief('st').length === 3);
    snmp.values.set(OID_MIB.source, 3);
    snmp.values.set(OID_MIB.batteryStatus, 2);
    await waitFor(() => brief('st').length === 5);
    await sleep(250);
    assert.deepEqual(brief('st'), ['normal', 'power_loss', 'low_battery', 'power_restored', 'normal']);
    // Que des requetes de lecture, vers des OID RFC 1628 connus, en v2c.
    const known = new Set(Object.values(OID_MIB));
    for (const r of snmp.requests) {
      assert.equal(r.pduTag, 0xa0);
      assert.equal(r.version, 1);
      assert.ok(known.has(r.oid), r.oid);
    }
  } finally {
    await mod.stop();
    await snmp.close();
  }
});

test('SNMP v1 : un OID absent (noSuchName) n\'empeche pas les autres, avertissement unique', async () => {
  const values = { ...MIB_OK };
  delete (values as Record<string, number>)[OID_MIB.temp];
  const snmp = await startSnmp({ values });
  const { ctx, emitted, logs, brief } = makeCtx();
  const mod = create({ ups: [{ name: 'o2', transport: 'snmp', host: '127.0.0.1', port: snmp.port, version: '1', ...FAST, ids: ALL_IDS }] });
  try {
    await mod.start(ctx);
    await waitFor(() => emitted.length >= 6);
    await sleep(450);
    assert.equal(emitted.length, 6);
    assert.deepEqual(brief('tp'), []);
    assert.equal(logs.filter((l) => /"temperature"/.test(l.text)).length, 1);
    assert.ok(snmp.requests.every((r) => r.version === 0));
  } finally {
    await mod.stop();
    await snmp.close();
  }
});

test('SNMP : reponses mal formees, request-id different, longueurs absurdes = ignorees', async () => {
  for (const mode of ['badid', 'garbage', 'huge'] as const) {
    const snmp = await startSnmp({ mode, values: MIB_OK });
    const { ctx, emitted, brief } = makeCtx();
    const mod = create({ ups: [{ name: 'o2', transport: 'snmp', host: '127.0.0.1', port: snmp.port, ...FAST, ids: { status: 'st', charge: 'ch' } }] });
    try {
      await mod.start(ctx);
      await waitFor(() => emitted.length >= 2);
      assert.deepEqual(brief('st'), ['normal'], mode);
      assert.deepEqual(brief('ch'), ['v=95'], mode);
    } finally {
      await mod.stop();
      await snmp.close();
    }
  }
});

test('SNMP : silence ou mauvaise communaute -> delai, defaut, la communaute n\'est jamais journalisee', async () => {
  for (const mode of ['silent', 'wrongcomm'] as const) {
    const snmp = await startSnmp({ mode, values: MIB_OK, community: 'Secr3t-xyz' });
    const { ctx, emitted, logs } = makeCtx();
    const mod = create({ ups: [{ name: 'o2', transport: 'snmp', host: '127.0.0.1', port: snmp.port, community: 'Secr3t-xyz', ...FAST, timeoutMs: 60, maxFailures: 2, ids: { status: 'st' } }] });
    try {
      await mod.start(ctx);
      await waitFor(() => emitted.length === 1, 6000);
      assert.deepEqual(emitted[0]!.msg.state, 'fault', mode);
      await sleep(400);
      assert.equal(emitted.length, 1, mode);
      assert.ok(logs.length > 0);
      for (const l of logs) assert.ok(!l.text.includes('Secr3t-xyz'), l.text);
      assert.ok(!JSON.stringify(emitted).includes('Secr3t-xyz'));
    } finally {
      await mod.stop();
      await snmp.close();
    }
  }
});

test('SNMP : arret propre pendant une requete sans reponse', async () => {
  const snmp = await startSnmp({ mode: 'silent' });
  const { ctx } = makeCtx();
  const mod = create({ ups: [{ name: 'o2', transport: 'snmp', host: '127.0.0.1', port: snmp.port, ...FAST, timeoutMs: 30_000, ids: { status: 'st' } }] });
  try {
    await mod.start(ctx);
    await waitFor(() => snmp.requests.length >= 1);
    const t0 = Date.now();
    await mod.stop();
    assert.ok(Date.now() - t0 < 1000);
    const seen = snmp.requests.length;
    await sleep(300);
    assert.equal(snmp.requests.length, seen);
  } finally {
    await snmp.close();
  }
});

// ---------- BER ----------

test('BER : requete GetRequest identique au vecteur de reference (sysDescr.0, v1, public)', () => {
  const expected = Buffer.from('302602010004067075626c6963a019020101020100020100300e300c06082b060102010101000500', 'hex');
  assert.deepEqual(buildGetRequest(0, 'public', 1, '1.3.6.1.2.1.1.1.0'), expected);
});

test('BER : decodage d\'une reponse valide et refus des variantes douteuses', () => {
  const oidTlv = Buffer.from('06082b06010201010100', 'hex');
  const make = (o: { rid?: number; community?: string; pdu?: number } = {}) =>
    tl(0x30, Buffer.concat([iv(1), tl(4, Buffer.from(o.community ?? 'public')), tl(o.pdu ?? 0xa2, Buffer.concat([iv(o.rid ?? 77), iv(0), iv(0), tl(0x30, tl(0x30, Buffer.concat([oidTlv, iv(-0 + 1234)])))]))]));
  const ok = decodeResponse(make(), 'public');
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.response.requestId, 77);
    assert.deepEqual(ok.response.varbinds, [{ oid: '1.3.6.1.2.1.1.1.0', value: { kind: 'number', n: 1234 } }]);
  }
  assert.equal(decodeResponse(make({ community: 'autre' }), 'public').ok, false);
  assert.equal(decodeResponse(make({ pdu: 0xa3 }), null).ok, false); // jamais autre chose qu'une reponse
  assert.equal(decodeResponse(Buffer.concat([make(), Buffer.from([0])]), null).ok, false); // octets en trop
});

test('BER : trames absurdes explicitement refusees', () => {
  const bad: string[] = [
    '',
    '30',
    '3080',
    '3084ffffffff0201',
    '30050201',
    '3003020100',
    '30820100',
    '3010020101040670616c6963a2ffff',
    '302b02010104067075626c6963a2200202ffff02010002010030' + '1230100609ffffffffffffffffff7f0500',
  ];
  for (const h of bad) assert.equal(decodeResponse(Buffer.from(h, 'hex'), null).ok, false, h);
});

test('BER : readTlv refuse longueur depassant la trame, indefinie ou sur plus de 4 octets', () => {
  assert.throws(() => readTlv(Buffer.from('0405aa', 'hex'), 0, 3), BerError);
  assert.throws(() => readTlv(Buffer.from('0480', 'hex'), 0, 2), BerError);
  assert.throws(() => readTlv(Buffer.from('048500000000ff', 'hex'), 0, 7), BerError);
  assert.deepEqual(readTlv(Buffer.from('0402aabb', 'hex'), 0, 4), { tag: 4, start: 2, end: 4 });
});

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('BER : fuzz (octets aleatoires, trames valides alterees) -> jamais d\'exception', () => {
  const rnd = mulberry32(12345);
  const oidTlv = Buffer.from('06082b06010201010100', 'hex');
  const valid = tl(0x30, Buffer.concat([iv(1), tl(4, Buffer.from('public')), tl(0xa2, Buffer.concat([iv(77), iv(0), iv(0), tl(0x30, tl(0x30, Buffer.concat([oidTlv, iv(1234)])))]))]));
  let accepted = 0;
  const run = (b: Buffer) => {
    const r = decodeResponse(b, rnd() < 0.5 ? 'public' : null);
    assert.equal(typeof r.ok, 'boolean');
    if (r.ok) accepted++;
  };
  for (let i = 0; i < 20_000; i++) {
    const n = Math.floor(rnd() * 80);
    run(Buffer.from(Array.from({ length: n }, () => Math.floor(rnd() * 256))));
  }
  for (let i = 0; i < 20_000; i++) {
    const b = Buffer.from(valid);
    const flips = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < flips; k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    run(rnd() < 0.3 ? b.subarray(0, Math.floor(rnd() * b.length)) : b);
  }
  for (let n = 0; n <= valid.length; n++) run(valid.subarray(0, n));
  assert.ok(accepted >= 1); // la trame valide d'origine est bien acceptee
});

// ---------- lecture seule ----------

test('lecture seule : aucune commande d\'ecriture dans le code, et seulement des lectures sur le fil', async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'modules', 'ups');
  const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => ({ f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
  assert.ok(sources.length >= 6);
  const forbidden: RegExp[] = [/\bSET\b/, /\bINSTCMD\b/, /\bFSD\b/, /\bLOGIN\b/, /\bUSERNAME\b/, /\bPASSWORD\b/, /\bSTARTTLS\b/, /setRequest/i, /\b0xa3\b/i, /\b0xa4\b/i, /\b0xa6\b/i, /\b0xa7\b/i];
  for (const { f, text } of sources) {
    for (const re of forbidden) assert.ok(!re.test(text), `${f} contient ${re}`);
  }
  // Sur le fil : NUT.
  const nut = await startNut({ vars: NUT_OK });
  try {
    await nutFetch({ host: '127.0.0.1', port: nut.port, timeoutMs: 500, upsName: null }, ['ups.status']);
    nut.mode = 'errlist';
    await nutFetch({ host: '127.0.0.1', port: nut.port, timeoutMs: 500, upsName: 'myups' }, ['ups.status', 'battery.charge']);
    assert.ok(nut.commands.length >= 4);
    for (const c of nut.commands) assert.match(c, /^(LIST UPS|LIST VAR [\w.-]+|GET VAR [\w.-]+ [\w.-]+)$/);
  } finally {
    await nut.close();
  }
});
