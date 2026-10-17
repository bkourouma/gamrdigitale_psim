/**
 * Module `acces-zkteco` : protocole (formats, tables, donnees hostiles), configuration, securite de la facade HTTP, messages
 * conformes au contrat (et acceptes par `prepare()` du socle), recuperation F8, supervision, commandes. Faux appareil
 * `fake-zkteco.ts` sur 127.0.0.1 (port libre choisi par le systeme), horloge injectee : aucune attente reelle.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, describe, it } from 'node:test';
import type { DeviceMessage, ModuleContext } from '../src/module.ts';
import { newMsgId, prepare } from '../src/validate.ts';
import type { ActuatorHandler } from '../src/modules/acces-commun/actuator.ts';
import { DeviceCommands } from '../src/modules/acces-zkteco/commands.ts';
import { inRanges, ipv4ToInt, parseCidr, parseConfig } from '../src/modules/acces-zkteco/config.ts';
import { DEFAULT_STATE_DIR, create, resolveStateDir } from '../src/modules/acces-zkteco/index.ts';
import type { ZktecoModule } from '../src/modules/acces-zkteco/index.ts';
import {
  RTLOG_EVENTS,
  attlogDirection,
  attlogMethod,
  classifyEvent,
  controlCommand,
  handshakeBody,
  inoutDirection,
  minStamp,
  parseAttlogLine,
  parseDeviceCmdBody,
  parseDeviceTime,
  parseKv,
  parseRtlogLine,
  parseRtstateLine,
  parseTarget,
  rtlogEventId,
  splitLines,
  stampOf,
  syntheticEventId,
  verifyMethod,
} from '../src/modules/acces-zkteco/protocol.ts';
import { FakeZk, deviceTimeText, rawRequest } from './fake-zkteco.ts';

// ---------------------------------------------------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------------------------------------------------

const T0 = Date.UTC(2026, 9, 17, 8, 0, 0);
const CARD = '12345678';
const PIN = '101';
const SERIAL_C = 'CJDK123456789';
const SERIAL_T = 'TERM00000001';

const controllerCfg = {
  id: 'CTL-2',
  serial: SERIAL_C,
  kind: 'controller',
  utcOffsetMin: 0,
  doors: { '1': 'P-ENTREE', '2': 'P-ARRIERE' },
  actuators: { 'ACT-ENTREE': { door: 1, type: 'lock' }, 'GATE-ARRIERE': { door: 2, type: 'gate', pulseS: 8 } },
};
const terminalCfg = { id: 'TERM-1', serial: SERIAL_T, kind: 'terminal', utcOffsetMin: 0, doors: { '1': 'P-POINTEUSE' } };

const baseConfig = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  listen: { host: '127.0.0.1', port: 0 },
  controllers: [controllerCfg, terminalCfg],
  ...over,
});

interface Out {
  id: string;
  msg: DeviceMessage;
}

interface Harness {
  mod: ZktecoModule;
  port: number;
  clock: { t: number };
  out: Out[];
  logs: { level: string; text: string }[];
  rejected: string[];
  handlers: Map<string, ActuatorHandler>;
  accept: { value: boolean };
  dev(serial?: string, kind?: 'controller' | 'terminal'): FakeZk;
  stop(): Promise<void>;
}

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zk-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Demarre un VRAI module sur un contexte d'essai : emit passe par `prepare()` du socle, comme en production. */
async function boot(over: Record<string, unknown> = {}, opts: { actuators?: boolean; t?: number } = {}): Promise<Harness> {
  const clock = { t: opts.t ?? T0 };
  const out: Out[] = [];
  const logs: { level: string; text: string }[] = [];
  const rejected: string[] = [];
  const handlers = new Map<string, ActuatorHandler>();
  const accept = { value: true };
  const ctx = {
    emit: (id: string, msg: DeviceMessage) => {
      if (!accept.value) return false;
      const r = prepare(id, msg, clock.t, newMsgId);
      if (!r.ok) {
        rejected.push(r.error);
        return false;
      }
      out.push({ id, msg });
      return true;
    },
    openMqtt: async () => {
      throw new Error('inutile');
    },
    log: (level: string, text: string) => logs.push({ level, text }),
    config: {},
    now: () => clock.t,
    ...(opts.actuators === false ? {} : { onActuator: (id: string, h: ActuatorHandler) => void handlers.set(id, h) }),
  } as unknown as ModuleContext;
  // Toujours un dossier d'etat temporaire : un essai n'ecrit jamais dans gateway/data.
  const mod = create(baseConfig({ stateDir: tempDir(), ...over }));
  await mod.start(ctx);
  const port = mod.addresses().http as number;
  const h: Harness = {
    mod,
    port,
    clock,
    out,
    logs,
    rejected,
    handlers,
    accept,
    dev: (serial = SERIAL_C, kind = 'controller') => new FakeZk({ port, serial, kind, now: () => clock.t }),
    stop: () => mod.stop(),
  };
  cleanups.push(() => mod.stop());
  return h;
}

const passages = (h: Harness) => h.out.filter((o) => o.msg.access !== undefined);
const events = (h: Harness, event: string) => h.out.filter((o) => o.msg.event === event);
const states = (h: Harness, state: string) => h.out.filter((o) => o.msg.state === state);
const allLogs = (h: Harness) => h.logs.map((l) => l.text).join('\n');
/** Laisse les promesses en attente s'executer (aucune attente reelle). */
const settle = () => new Promise<void>((r) => setImmediate(r));

// ---------------------------------------------------------------------------------------------------------------------
// Protocole
// ---------------------------------------------------------------------------------------------------------------------

describe('acces-zkteco : protocole', () => {
  it("parseTarget : chemin et parametres, noms sans casse, refus des formes hostiles", () => {
    const t = parseTarget('/iclock/cdata?SN=ABCD1234&options=all&pushver=2.4.1');
    assert.equal(t?.path, '/iclock/cdata');
    assert.equal(t?.params.get('sn'), 'ABCD1234');
    assert.equal(t?.params.get('options'), 'all');
    assert.equal(parseTarget('/iclock/ping')?.params.size, 0);
    assert.equal(parseTarget('/iclock/cdata?SN=A1B2&SN=C3D4'), null, 'parametre repete');
    assert.equal(parseTarget('/iclock/cdata?SN=%E0%A4%A'), null, 'pourcentage mal forme');
    assert.equal(parseTarget(undefined), null);
    assert.equal(parseTarget('iclock/cdata'), null);
    assert.equal(parseTarget(`/iclock/cdata?SN=${'A'.repeat(300)}`), null, 'valeur trop longue');
    assert.equal(parseTarget(`/${'a'.repeat(1100)}`), null, 'adresse trop longue');
    assert.equal(parseTarget(`/x?${Array.from({ length: 40 }, (_, i) => `k${i}=1`).join('&')}`), null, 'trop de parametres');
  });

  it("parseDeviceTime : heure locale convertie avec l'ecart, dates impossibles refusees", () => {
    assert.equal(parseDeviceTime('2026-10-17 08:00:00', 0), T0);
    assert.equal(parseDeviceTime('2026-10-17 09:00:00', 60), T0, "Paris l'hiver : 09 h locale = 08 h UTC");
    assert.equal(parseDeviceTime('2026-10-17T08:00:00', 0), T0);
    assert.equal(parseDeviceTime(' 2026-10-17 08:00:00 ', 0), T0);
    for (const bad of ['2026-13-01 00:00:00', '2026-04-31 00:00:00', '2026-02-30 10:00:00', '2026-10-17 24:00:00', '2026-10-17 08:60:00', '2026-10-17 08:00:60', '1999-01-01 00:00:00', '2100-01-01 00:00:00', 'hier', '', '2026-10-17', '20261017080000', '2026-10-17 08:00:00 UTC']) {
      assert.equal(parseDeviceTime(bad, 0), null, bad);
    }
    assert.equal(parseDeviceTime(undefined, 0), null);
    assert.equal(parseDeviceTime(null, 0), null);
    assert.equal(parseDeviceTime('2026-02-29 10:00:00', 0), null, '2026 n\'est pas bissextile');
    assert.notEqual(parseDeviceTime('2028-02-29 10:00:00', 0), null);
  });

  it('splitLines et parseKv : separateurs, lignes vides, cles invalides ignorees, lignes hostiles refusees', () => {
    assert.deepEqual(splitLines('a\r\nb\n\nc\r \n'), ['a', 'b', 'c']);
    const kv = parseKv('time=2026-10-17 08:00:00\tpin=1\tBIZARRE\t=vide\tCle Invalide=1\tEvent=0');
    assert.equal(kv?.get('time'), '2026-10-17 08:00:00');
    assert.equal(kv?.get('event'), '0', 'cle en minuscules');
    assert.equal(kv?.has('cle invalide'), false);
    assert.equal(parseKv(`pin=${'9'.repeat(5000)}`), null, 'ligne trop longue');
    assert.equal(parseKv(Array.from({ length: 60 }, (_, i) => `k${i}=1`).join('\t')), null, 'trop de champs');
    assert.equal(parseKv(`k=${'x'.repeat(500)}`)?.get('k')?.length, 64, 'valeur bornee');
  });

  const goodLine = ['time=2026-10-17 08:00:00', 'pin=101', 'cardno=12345678', 'eventaddr=1', 'event=0', 'inoutstatus=0', 'verifytype=4', 'index=777', 'sitecode=', 'linkid=0'].join('\t');

  it('parseRtlogLine : ligne nominale, PIN lu comme identifiant du titulaire, carte nulle = pas de carte', () => {
    const r = parseRtlogLine(goodLine, 0);
    assert.deepEqual(r, { ts: T0, pin: '101', card: '12345678', door: 1, event: 0, inout: 0, verify: 4, index: '777' });
    assert.equal(parseRtlogLine(goodLine.replace('cardno=12345678', 'cardno=0'), 0)?.card, null);
    assert.equal(parseRtlogLine(goodLine.replace('cardno=12345678', 'cardno=0000'), 0)?.card, null);
    assert.equal(parseRtlogLine(goodLine.replace('cardno=12345678', 'cardno='), 0)?.card, null);
    assert.equal(parseRtlogLine(goodLine.replace('index=777', 'index=abc'), 0)?.index, null, 'index non numerique ignore');
    assert.equal(parseRtlogLine(goodLine.replace('\tindex=777', ''), 0)?.index, null);
  });

  it('parseRtlogLine : lignes tronquees, tabulations en trop, caracteres de controle, valeurs enormes', () => {
    assert.equal(parseRtlogLine('time=2026-10-17 08:00:00\tpin=1\tcardno=2', 0), null, 'sans event');
    assert.equal(parseRtlogLine('time=2026-10-17 08', 0), null, 'tronquee');
    assert.equal(parseRtlogLine('', 0), null);
    assert.equal(parseRtlogLine('\t\t\t', 0), null);
    assert.equal(parseRtlogLine(goodLine.replace('event=0', 'event=abc'), 0), null);
    assert.equal(parseRtlogLine(goodLine.replace('event=0', 'event=-5'), 0), null);
    assert.equal(parseRtlogLine(goodLine.replace('event=0', `event=${'9'.repeat(30)}`), 0), null, 'numero d\'evenement enorme');
    assert.equal(parseRtlogLine(goodLine.replace('time=2026-10-17 08:00:00', 'time=0'), 0), null);
    assert.ok(parseRtlogLine(`\t\t${goodLine}\t\t\t`, 0), 'tabulations en trop tolerees');
    // caracteres de controle et enormes valeurs : nettoyes, jamais propages tels quels
    const nasty = parseRtlogLine(goodLine.replace('pin=101', `pin=1\u0007\u001b[31m${'Z'.repeat(400)}`).replace('cardno=12345678', 'cardno=\u0000\u0001ab\u202e'), 0);
    assert.ok(nasty);
    assert.match(nasty.pin ?? '', /^[A-Za-z0-9._:-]{1,32}$/);
    assert.match(nasty.card ?? '', /^[A-Za-z0-9._:-]{1,32}$/);
    assert.equal(parseRtlogLine(goodLine.repeat(100), 0), null, 'ligne enorme');
  });

  it("rtlogEventId : `index` s'il existe, sinon identifiant synthetique deterministe <heure>-<empreinte>", () => {
    const withIndex = parseRtlogLine(goodLine, 0);
    assert.ok(withIndex);
    assert.equal(rtlogEventId(withIndex), '777');
    const noIndex = parseRtlogLine(goodLine.replace('\tindex=777', ''), 0);
    assert.ok(noIndex);
    const id = rtlogEventId(noIndex);
    assert.match(id, /^\d{10}-[0-9a-f]{10}$/);
    assert.equal(id, rtlogEventId({ ...noIndex }), 'deterministe');
    assert.equal(id.split('-')[0], String(T0 / 1000));
    assert.notEqual(id, rtlogEventId({ ...noIndex, card: '99999999' }), 'autre carte, autre identifiant');
    assert.notEqual(id, rtlogEventId({ ...noIndex, ts: T0 + 1000 }));
    assert.equal(syntheticEventId(T0, 'a', 1, null), syntheticEventId(T0, 'a', 1, null));
  });

  it('table des evenements : acces, refus et motifs, alarmes, etats', () => {
    const eff = (n: number) => classifyEvent(n).effect;
    for (const n of [0, 1, 2, 3, 14, 202, 205, 208]) assert.equal(eff(n).kind, 'granted', String(n));
    assert.deepEqual(eff(23), { kind: 'denied', reason: 'other' });
    assert.deepEqual(eff(27), { kind: 'denied', reason: 'unknown_credential' });
    assert.deepEqual(eff(34), { kind: 'denied', reason: 'unknown_credential' });
    assert.deepEqual(eff(29), { kind: 'denied', reason: 'expired' });
    assert.deepEqual(eff(30), { kind: 'denied', reason: 'wrong_pin' });
    for (const n of [21, 22, 35, 36]) assert.deepEqual(eff(n), { kind: 'denied', reason: 'out_of_schedule' }, String(n));
    assert.deepEqual(eff(24), { kind: 'denied', reason: 'antipassback' });
    for (const n of [38, 39]) assert.deepEqual(eff(n), { kind: 'denied', reason: 'disabled' }, String(n));
    assert.deepEqual(eff(100), { kind: 'tamper' });
    assert.deepEqual(eff(102), { kind: 'door', what: 'forced' });
    assert.deepEqual(eff(28), { kind: 'door', what: 'held_open' });
    assert.deepEqual(eff(200), { kind: 'door', what: 'opened' });
    assert.deepEqual(eff(201), { kind: 'door', what: 'closed' });
    assert.deepEqual(eff(202), { kind: 'granted', method: 'exit_button' });
    assert.deepEqual(eff(8), { kind: 'granted', method: 'remote' });
    assert.equal(eff(101).kind, 'duress');
    assert.equal(eff(103).kind, 'duress');
    for (const n of [26, 32, 206, 220, 221, 204]) assert.equal(eff(n).kind, 'ignore', String(n));
    assert.ok(Object.keys(RTLOG_EVENTS).length > 50);
  });

  it('numero d\'evenement inconnu : jamais une alarme (refus `other` dans la bande des echecs, sans effet ailleurs)', () => {
    for (const n of [57, 66, 99, 20]) assert.equal(classifyEvent(n).known && n !== 20, false);
    assert.deepEqual(classifyEvent(57).effect, { kind: 'denied', reason: 'other' });
    assert.equal(classifyEvent(57).known, false);
    for (const n of [19 + 1000, 150, 250, 9999, 104, 99999]) {
      const e = classifyEvent(n);
      assert.equal(e.effect.kind, 'ignore', String(n));
      assert.equal(e.known, false);
    }
    for (const n of [40, 41, 50, 60, 99]) assert.equal(classifyEvent(n).effect.kind, 'denied');
    for (const n of Object.keys(RTLOG_EVENTS).map(Number)) {
      const k = classifyEvent(n).effect.kind;
      if (k === 'tamper' || (k === 'door' && n !== 200 && n !== 201 && n !== 28)) assert.ok(n >= 100 || n === 28, `alarme ${n} hors bande`);
    }
  });

  it('verifyMethod, sens, ATTLOG : correspondances', () => {
    assert.equal(verifyMethod(1, false), 'fingerprint');
    assert.equal(verifyMethod(3, false), 'code');
    assert.equal(verifyMethod(4, true), 'badge');
    assert.equal(verifyMethod(10, true), 'badge');
    assert.equal(verifyMethod(11, true), 'badge');
    assert.equal(verifyMethod(6, true), 'badge');
    assert.equal(verifyMethod(6, false), 'fingerprint');
    assert.equal(verifyMethod(15, false), 'face');
    assert.equal(verifyMethod(200, true), 'badge');
    assert.equal(verifyMethod(200, false), 'unknown');
    assert.equal(verifyMethod(null, false), 'unknown');
    assert.equal(inoutDirection(0), 'in');
    assert.equal(inoutDirection(1), 'out');
    assert.equal(inoutDirection(2), null);
    assert.equal(inoutDirection(null), null);
    assert.equal(attlogDirection(0), 'in');
    assert.equal(attlogDirection(1), 'out');
    assert.equal(attlogDirection(7), null);
    assert.equal(attlogMethod(0), 'code');
    assert.equal(attlogMethod(1), 'fingerprint');
    assert.equal(attlogMethod(2), 'badge');
    assert.equal(attlogMethod(15), 'face');
    assert.equal(attlogMethod(99), 'unknown');
  });

  it('parseAttlogLine : forme a tabulations (ordre PIN, heure, Status, Verify, Workcode), forme cle=valeur, lignes hostiles', () => {
    assert.deepEqual(parseAttlogLine('1001\t2026-10-17 08:00:00\t1\t15\t0', 0), { ts: T0, pin: '1001', status: 1, verify: 15 });
    assert.deepEqual(parseAttlogLine('1001\t2026-10-17 08:00:00\t0\t1\t0\t0\t0\t', 0), { ts: T0, pin: '1001', status: 0, verify: 1 });
    assert.deepEqual(parseAttlogLine('PIN=1002\tDateTime=2026-10-17 08:00:00\tVerified=1\tStatus=0', 0), { ts: T0, pin: '1002', status: 0, verify: 1 });
    assert.equal(parseAttlogLine('1001\thier\t0\t1', 0), null);
    assert.equal(parseAttlogLine('\t2026-10-17 08:00:00\t0\t1', 0), null, 'sans PIN');
    assert.equal(parseAttlogLine('1001', 0), null);
    assert.equal(parseAttlogLine(`1001\t${'x'.repeat(3000)}`, 0), null);
    assert.equal(parseAttlogLine(Array.from({ length: 60 }, () => 'a').join('\t'), 0), null);
  });

  it('parseRtstateLine : heure actuelle, contact de porte (1 fermee, 2 ouverte), alarme', () => {
    const r = parseRtstateLine('time=2026-10-17 08:00:00\tsensor=0212\trelay=0000\talarm=0000', 0);
    assert.equal(r?.ts, T0);
    assert.deepEqual([...(r?.open ?? [])], [[2, true], [3, false], [4, true]]);
    assert.equal(r?.alarm, false);
    assert.equal(parseRtstateLine('time=2026-10-17 08:00:00\tsensor=11\talarm=0100', 0)?.alarm, true);
    assert.equal(parseRtstateLine('time=n/a\tsensor=zz', 0)?.ts, null);
    assert.equal(parseRtstateLine('time=n/a\tsensor=zz', 0)?.open.size, 0);
    assert.equal(parseRtstateLine('rien du tout', 0), null);
  });

  it('poignee de main : forme, estampille, aucune option dangereuse', () => {
    const body = handshakeBody({ serial: SERIAL_C, stamp: null, delayS: 3, errorDelayS: 30, transFlag: '1000000000' });
    const lines = body.split('\n');
    assert.equal(lines[0], `GET OPTION FROM: ${SERIAL_C}`);
    for (const k of ['ATTLOGStamp=None', 'OPERLOGStamp=9999', 'ErrorDelay=30', 'Delay=3', 'TransInterval=1', 'TransFlag=1000000000', 'Realtime=1', 'Encrypt=0']) assert.ok(lines.includes(k), k);
    assert.ok(!/TimeZone/i.test(body), 'le fuseau de l\'appareil n\'est jamais impose');
    assert.ok(!lines.some((l) => l.startsWith('Stamp=')), 'pas de Stamp tant qu\'aucune estampille n\'est acquittee');
    const withStamp = handshakeBody({ serial: SERIAL_C, stamp: '4242', delayS: 3, errorDelayS: 30, transFlag: '1000000000' });
    assert.ok(withStamp.split('\n').includes('Stamp=4242'));
    assert.ok(withStamp.split('\n').includes('ATTLOGStamp=4242'));
    assert.equal(stampOf('123'), '123');
    assert.equal(stampOf('abc'), null);
    assert.equal(stampOf('-1'), null);
    assert.equal(stampOf(undefined), null);
    assert.equal(stampOf('1'.repeat(25)), null);
    assert.equal(minStamp('10', '9'), '9');
    assert.equal(minStamp('9', '10'), '9');
    assert.equal(minStamp(null, '5'), '5');
    assert.equal(minStamp('5', null), '5');
    assert.equal(minStamp(null, null), null);
    assert.equal(minStamp('99999999999999999999', '99999999999999999998'), '99999999999999999998', 'comparaison sans perte');
  });

  it('controlCommand : formats hex et espaces, bornes', () => {
    assert.equal(controlCommand('hex', 1, 5), 'CONTROL DEVICE 01010105');
    assert.equal(controlCommand('hex', 2, 255), 'CONTROL DEVICE 010201FF');
    assert.equal(controlCommand('hex', 4, 0), 'CONTROL DEVICE 01040100');
    assert.equal(controlCommand('spaced', 3, 10), 'CONTROL DEVICE 1 3 1 10');
    assert.throws(() => controlCommand('hex', 0, 5));
    assert.throws(() => controlCommand('hex', 1, 256));
    assert.throws(() => controlCommand('hex', 1, -1));
    assert.throws(() => controlCommand('hex', 1, 1.5));
  });

  it('parseDeviceCmdBody : un ou plusieurs resultats, lignes illisibles ignorees', () => {
    assert.deepEqual(parseDeviceCmdBody('ID=12&Return=0&CMD=CONTROL DEVICE 01010105'), [{ id: 12, code: 0 }]);
    assert.deepEqual(parseDeviceCmdBody('ID=1&Return=-1002&CMD=X\r\nn importe quoi\r\nID=2&Return=0&CMD=Y\r\n'), [{ id: 1, code: -1002 }, { id: 2, code: 0 }]);
    assert.deepEqual(parseDeviceCmdBody('id=3&return=0'), [{ id: 3, code: 0 }], 'casse indifferente');
    assert.deepEqual(parseDeviceCmdBody('ID=abc&Return=0'), []);
    assert.deepEqual(parseDeviceCmdBody('ID=3'), []);
    assert.deepEqual(parseDeviceCmdBody(''), []);
    assert.deepEqual(parseDeviceCmdBody('ID=-4&Return=0'), []);
    assert.equal(parseDeviceCmdBody(Array.from({ length: 200 }, (_, i) => `ID=${i}&Return=0`).join('\n')).length, 64, 'borne');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------------------

describe('acces-zkteco : configuration', () => {
  const ok = (over: Record<string, unknown> = {}) => parseConfig(baseConfig(over));
  const errors = (over: Record<string, unknown>): string => {
    try {
      parseConfig(over);
    } catch (e) {
      return (e as Error).message;
    }
    return '';
  };

  it('configuration complete valide : valeurs par defaut', () => {
    const c = ok();
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.stateDir, null);
    assert.equal(c.allowFrom, null);
    assert.deepEqual(c.thresholds, { deniedCount: 3, deniedWindowS: 60, heartbeatS: 60, clockDriftMs: 120_000, silenceMs: 90_000, offlineGraceMs: 15_000, longUnlockS: 60, deferredAfterS: 120, commandTimeoutS: 30 });
    assert.equal(c.limits.maxBodyBytes, 262_144);
    assert.equal(c.limits.perAddressPerMinute, 600);
    assert.equal(c.push.delayS, 3);
    assert.equal(c.push.controlFormat, 'hex');
    assert.equal(c.controllers.length, 2);
    assert.equal(c.controllers[0]?.actuators[0]?.pulseS, 5);
    assert.equal(c.controllers[0]?.actuators[1]?.pulseS, 8);
    assert.equal(c.controllers[0]?.doors.get(2), 'P-ARRIERE');
  });

  it("exemple complet de la documentation", () => {
    const c = parseConfig({
      stateDir: 'data/acces-zkteco',
      listen: { host: '192.168.10.10', port: 8081 },
      allowFrom: ['192.168.10.0/24', '192.168.10.21'],
      controllers: [{ id: 'CTL-2', serial: 'CJDK123456789', kind: 'controller', utcOffsetMin: 0, doors: { '1': 'P-ENTREE', '2': 'P-ARRIERE' }, actuators: { 'ACT-ENTREE': { door: 1, type: 'lock' } } }],
      thresholds: { deniedCount: 3, deniedWindowS: 60, heartbeatS: 60, clockDriftMs: 120000, silenceMs: 90000, offlineGraceMs: 15000, longUnlockS: 60, deferredAfterS: 120, commandTimeoutS: 30 },
      limits: { maxBodyBytes: 262144, perAddressPerMinute: 600 },
    });
    assert.equal(c.port, 8081);
    assert.equal(c.allowFrom?.length, 2);
    assert.equal(c.stateDir, 'data/acces-zkteco');
  });

  it("listen : obligatoire, sans valeur par defaut, jamais « toutes les interfaces » sans allowAnyInterface", () => {
    assert.match(errors({ controllers: baseConfig().controllers }), /listen est obligatoire/);
    assert.match(errors(baseConfig({ listen: { port: 8081 } })), /listen\.host/);
    for (const any of ['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0', '0.0.0.00']) {
      assert.match(errors(baseConfig({ listen: { host: any, port: 8081 } })), /TOUTES les interfaces|listen\.host/, any);
    }
    assert.equal(ok({ listen: { host: '0.0.0.0', port: 8081, allowAnyInterface: true } }).host, '0.0.0.0');
    assert.match(errors(baseConfig({ listen: { host: 'localhost', port: 1 } })), /listen\.host/);
    assert.match(errors(baseConfig({ listen: { host: '127.0.0.1', port: 70000 } })), /listen\.port/);
    assert.match(errors(baseConfig({ listen: { host: '127.0.0.1', port: 1.5 } })), /listen\.port/);
    assert.match(errors(baseConfig({ listen: { host: '127.0.0.1', port: 1, extra: 1 } })), /cle inconnue/);
    assert.match(errors(baseConfig({ listen: { host: '127.0.0.1', port: 1, allowAnyInterface: 'oui' } })), /true ou false/);
  });

  it('allowFrom : adresses IPv4 et plages, refus des formes invalides ou trop larges', () => {
    assert.match(errors(baseConfig({ allowFrom: [] })), /allowFrom/);
    assert.match(errors(baseConfig({ allowFrom: 'x' })), /allowFrom/);
    for (const bad of ['10.0.0.0/0', '10.0.0.0/7', '10.0.0.0/33', '10.0.0.0/a', '300.1.1.1', '::1', 'localhost', '10.0.0.1/24/8', 7, null]) {
      assert.match(errors(baseConfig({ allowFrom: [bad] })), /allowFrom\[0\]/, String(bad));
    }
    const c = ok({ allowFrom: ['192.168.10.0/24', '10.1.2.3'] });
    const r = c.allowFrom ?? [];
    assert.ok(inRanges('192.168.10.77', r));
    assert.ok(inRanges('::ffff:192.168.10.77', r));
    assert.ok(inRanges('10.1.2.3', r));
    assert.ok(!inRanges('10.1.2.4', r));
    assert.ok(!inRanges('192.168.11.1', r));
    assert.ok(!inRanges('::1', r), 'IPv6 jamais autorise');
    assert.ok(!inRanges('n importe quoi', r));
    assert.equal(ipv4ToInt('1.2.3.4'), 16909060);
    assert.equal(ipv4ToInt('1.2.3'), null);
    assert.equal(typeof parseCidr('10.0.0.0/8'), 'object');
    const big = Array.from({ length: 300 }, (_, i) => `10.0.${i % 250}.1`);
    assert.match(errors(baseConfig({ allowFrom: big })), /allowFrom/);
  });

  it('controleurs : identifiants, numeros de serie, types, portes, unicite', () => {
    const one = (c: Record<string, unknown>) => baseConfig({ controllers: [{ ...controllerCfg, ...c }] });
    assert.match(errors(baseConfig({ controllers: [] })), /controllers est obligatoire/);
    assert.match(errors({ listen: { host: '127.0.0.1', port: 1 } }), /controllers est obligatoire/);
    assert.match(errors(one({ id: 'a b' })), /\.id doit etre/);
    assert.match(errors(one({ id: 'A'.repeat(33) })), /\.id doit etre/);
    assert.match(errors(one({ serial: 'abc' })), /serial/);
    assert.match(errors(one({ serial: 'AB CD1234' })), /serial/);
    assert.match(errors(one({ serial: 'A'.repeat(33) })), /serial/);
    assert.match(errors(one({ serial: 12345678 })), /serial/);
    assert.match(errors(one({ kind: 'lecteur' })), /kind/);
    assert.match(errors(one({ utcOffsetMin: 900 })), /utcOffsetMin/);
    assert.match(errors(one({ utcOffsetMin: 1.5 })), /utcOffsetMin/);
    assert.match(errors(one({ doors: {} })), /doors est obligatoire/);
    assert.match(errors(one({ doors: { '0': 'P-A' } })), /numero de porte/);
    assert.match(errors(one({ doors: { '5': 'P-A' } })), /numero de porte/);
    assert.match(errors(one({ doors: { '1': 'P A' } })), /doors\.1/);
    assert.match(errors(one({ doors: { '1': 3 } })), /doors\.1/);
    assert.match(errors(one({ extra: 1 })), /cle inconnue/);
    assert.match(errors(baseConfig({ controllers: ['x'] })), /doit etre un objet/);
    assert.match(errors(baseConfig({ controllers: [{ ...terminalCfg, doors: { '1': 'P-A', '2': 'P-B' } }] })), /qu'une porte/);
    assert.match(errors(baseConfig({ controllers: [{ ...terminalCfg, doors: { '2': 'P-A' } }] })), /qu'une porte/);
    assert.equal(parseConfig(baseConfig({ controllers: [{ ...controllerCfg, kind: undefined }] })).controllers[0]?.kind, 'controller', 'centrale par defaut');
    // unicite
    assert.match(errors(baseConfig({ controllers: [controllerCfg, { ...terminalCfg, id: 'CTL-2' }] })), /utilise deux fois/);
    assert.match(errors(baseConfig({ controllers: [controllerCfg, { ...terminalCfg, serial: SERIAL_C }] })), /serial est utilise deux fois/);
    assert.match(errors(baseConfig({ controllers: [controllerCfg, { ...terminalCfg, serial: SERIAL_C.toLowerCase() }] })), /serial est utilise deux fois/, 'majuscules / minuscules');
    assert.match(errors(baseConfig({ controllers: [controllerCfg, { ...terminalCfg, doors: { '1': 'P-ENTREE' } }] })), /deja utilise/);
  });

  it('actionneurs : porte declaree, type, duree d\'impulsion, unicite', () => {
    const act = (a: unknown) => baseConfig({ controllers: [{ ...controllerCfg, actuators: a }] });
    assert.match(errors(act([])), /actuators doit etre un objet/);
    assert.match(errors(act({ 'A 1': { door: 1, type: 'lock' } })), /identifiant/);
    assert.match(errors(act({ A1: 'x' })), /doit etre un objet/);
    assert.match(errors(act({ A1: { door: 3, type: 'lock' } })), /porte declaree/);
    assert.match(errors(act({ A1: { door: '1', type: 'lock' } })), /porte declaree/);
    assert.match(errors(act({ A1: { door: 1, type: 'relais' } })), /type/);
    assert.match(errors(act({ A1: { door: 1, type: 'lock', pulseS: 0 } })), /pulseS/);
    assert.match(errors(act({ A1: { door: 1, type: 'lock', pulseS: 255 } })), /pulseS/);
    assert.match(errors(act({ A1: { door: 1, type: 'lock', zzz: 1 } })), /cle inconnue/);
    assert.match(errors(baseConfig({ controllers: [controllerCfg, { ...terminalCfg, actuators: { 'ACT-ENTREE': { door: 1, type: 'lock' } } }] })), /declare deux fois/);
    assert.equal(parseConfig(act({ A1: { door: 1, type: 'gate', pulseS: 254 } })).controllers[0]?.actuators[0]?.pulseS, 254);
  });

  it('seuils, limites, options push : bornes et cles inconnues', () => {
    assert.match(errors(baseConfig({ thresholds: { deniedCount: 0 } })), /deniedCount/);
    assert.match(errors(baseConfig({ thresholds: { deniedWindowS: 0 } })), /deniedWindowS/);
    assert.match(errors(baseConfig({ thresholds: { heartbeatS: 1 } })), /heartbeatS/);
    assert.match(errors(baseConfig({ thresholds: { clockDriftMs: 5 } })), /clockDriftMs/);
    assert.match(errors(baseConfig({ thresholds: { silenceMs: 10 } })), /silenceMs/);
    assert.match(errors(baseConfig({ thresholds: { offlineGraceMs: -1 } })), /offlineGraceMs/);
    assert.match(errors(baseConfig({ thresholds: { longUnlockS: 0 } })), /longUnlockS/);
    assert.match(errors(baseConfig({ thresholds: { deferredAfterS: 0 } })), /deferredAfterS/);
    assert.match(errors(baseConfig({ thresholds: { commandTimeoutS: 1 } })), /commandTimeoutS/);
    assert.match(errors(baseConfig({ thresholds: { commandTimeoutS: '30' } })), /commandTimeoutS/);
    assert.match(errors(baseConfig({ thresholds: { n_importe_quoi: 1 } })), /cle inconnue/);
    assert.match(errors(baseConfig({ thresholds: 3 })), /thresholds doit etre un objet/);
    assert.match(errors(baseConfig({ limits: { maxBodyBytes: 10 } })), /maxBodyBytes/);
    assert.match(errors(baseConfig({ limits: { maxBodyBytes: 1e9 } })), /maxBodyBytes/);
    assert.match(errors(baseConfig({ limits: { perAddressPerMinute: 0 } })), /perAddressPerMinute/);
    assert.match(errors(baseConfig({ limits: { zzz: 1 } })), /cle inconnue/);
    assert.match(errors(baseConfig({ push: { controlFormat: 'binaire' } })), /controlFormat/);
    assert.match(errors(baseConfig({ push: { transFlag: 'a;b' } })), /transFlag/);
    assert.match(errors(baseConfig({ push: { delayS: 0 } })), /delayS/);
    assert.match(errors(baseConfig({ push: { zzz: 1 } })), /cle inconnue/);
    assert.match(errors(baseConfig({ push: { delayS: 30 }, thresholds: { silenceMs: 60_000 } })), /3 fois push\.delayS/);
    assert.equal(ok({ push: { controlFormat: 'spaced' } }).push.controlFormat, 'spaced');
    assert.match(errors(baseConfig({ stateDir: '' })), /stateDir/);
    assert.match(errors(baseConfig({ stateDir: 5 })), /stateDir/);
    assert.match(errors(baseConfig({ zzz: 1 })), /cle inconnue/);
  });

  it('toutes les erreurs d\'un coup, en francais', () => {
    const msg = errors({ listen: { port: -1 }, controllers: [{ id: 'a b', serial: 'x', doors: {} }], thresholds: { deniedCount: 0 }, zzz: 1 });
    const lines = msg.split('\n').filter((l) => l.startsWith(' - '));
    assert.ok(lines.length >= 6, msg);
    assert.match(msg, /^Configuration acces-zkteco invalide/);
    assert.throws(() => create({}), /listen est obligatoire/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// File de commandes (unite)
// ---------------------------------------------------------------------------------------------------------------------

describe('acces-zkteco : file de commandes', () => {
  function queue(timeoutMs = 30_000, reachableMs = 90_000) {
    const clock = { t: T0 };
    let id = 100;
    const q = new DeviceCommands({ now: () => clock.t, timeoutMs, reachableMs, nextId: () => ++id });
    return { q, clock };
  }
  const fate = async (p: Promise<void>): Promise<string> => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'erreur');

  it('appareil jamais venu : refus immediat « offline »', async () => {
    const { q } = queue();
    assert.equal(await fate(q.enqueue('X')), 'offline');
    assert.equal(q.pending, 0);
  });

  it('remise unique, une seule commande en vol, serialisation dans l\'ordre', async () => {
    const { q } = queue();
    q.touch();
    const a = q.enqueue('A');
    const b = q.enqueue('B');
    assert.equal(q.take()?.line, 'C:101:A');
    assert.equal(q.take(), null, 'A attend son resultat : B n\'est pas remise');
    assert.equal(q.inFlight, true);
    assert.equal(q.ack(101, 0), true);
    assert.equal(await fate(a), 'ok');
    assert.equal(q.take()?.line, 'C:102:B');
    assert.equal(q.ack(102, 0), true);
    assert.equal(await fate(b), 'ok');
    assert.equal(q.take(), null);
    assert.equal(q.ack(102, 0), false, 'un resultat n\'est accepte qu\'une fois');
  });

  it('un code different de 0 est un refus de l\'appareil ; identifiant inconnu ou non remis ignore', async () => {
    const { q } = queue();
    q.touch();
    const a = q.enqueue('A');
    assert.equal(q.ack(101, 0), false, 'jamais remise : pas d\'accuse');
    assert.equal(q.ack(999, 0), false);
    q.take();
    assert.equal(q.ack(101, -2), true);
    assert.equal(await fate(a), 'refused_by_device');
  });

  it('delai depasse : commande retiree, jamais remise en retard, resultat tardif ignore', async () => {
    const { q, clock } = queue(30_000);
    q.touch();
    const a = q.enqueue('A');
    const taken = q.take();
    assert.ok(taken);
    clock.t += 31_000;
    assert.equal(q.sweep(), 1);
    assert.equal(await fate(a), 'timeout', 'remise mais jamais confirmee');
    assert.equal(q.ack(taken.id, 0), false, 'resultat tardif ignore');
    assert.equal(q.pending, 0);
    // jamais remise : l'appareil n'est pas venu la chercher
    q.touch();
    const b = q.enqueue('B');
    clock.t += 31_000;
    assert.equal(q.take(), null, 'expiree avant la remise : retiree, pas remise');
    assert.equal(await fate(b), 'offline', 'aucun contact depuis la mise en file');
  });

  it('commande jamais remise et appareil muet depuis : « offline »', async () => {
    const { q, clock } = queue(30_000, 90_000);
    q.touch();
    const a = q.enqueue('A');
    clock.t += 31_000;
    q.sweep();
    assert.equal(await fate(a), 'offline', 'aucun contact depuis la mise en file');
    clock.t += 200_000;
    assert.equal(await fate(q.enqueue('B')), 'offline', 'muet depuis plus de reachableMs');
  });

  it('une commande qui attend derriere une commande bloquee expire aussi', async () => {
    const { q, clock } = queue(30_000);
    q.touch();
    const a = q.enqueue('A');
    const b = q.enqueue('B');
    q.take();
    clock.t += 29_000;
    q.touch();
    assert.equal(q.sweep(), 0);
    clock.t += 2000;
    assert.equal(q.sweep(), 2);
    assert.equal(await fate(a), 'timeout');
    assert.notEqual(await fate(b), 'ok');
    assert.equal(q.take(), null);
  });

  it('horloge revenue en arriere : l\'echeance repart de maintenant', async () => {
    const { q, clock } = queue(30_000);
    q.touch();
    const a = q.enqueue('A');
    clock.t -= 3_600_000;
    assert.equal(q.sweep(), 0);
    clock.t += 29_000;
    assert.equal(q.sweep(), 0);
    clock.t += 2_000;
    assert.equal(q.sweep(), 1);
    assert.notEqual(await fate(a), 'ok');
  });

  it('failAll : toutes les commandes en attente sont rejetees', async () => {
    const { q } = queue();
    q.touch();
    const a = q.enqueue('A');
    const b = q.enqueue('B');
    q.take();
    q.failAll('stopped', 'arret');
    assert.equal(await fate(a), 'stopped');
    assert.equal(await fate(b), 'stopped');
    assert.equal(q.pending, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Module : poignee de main, passages, alarmes
// ---------------------------------------------------------------------------------------------------------------------

describe('acces-zkteco : poignee de main et appareils declares', () => {
  it('poignee de main : configuration renvoyee, Realtime=1, delai court, preuve de vie', async () => {
    const h = await boot();
    const d = h.dev();
    const r = await d.handshake();
    assert.equal(r.status, 200);
    assert.equal(r.body.split('\n')[0], `GET OPTION FROM: ${SERIAL_C}`);
    assert.equal(r.options.get('Realtime'), '1');
    assert.equal(r.options.get('Delay'), '3');
    assert.equal(r.options.get('ErrorDelay'), '30');
    assert.equal(r.options.get('ATTLOGStamp'), 'None');
    assert.match(String(r.headers['content-type']), /^text\/plain/);
    assert.equal(h.mod.state().controllers['CTL-2']?.link, 'online');
    assert.ok(events(h, 'heartbeat').length >= 2, 'un signe de vie par porte des le premier contact');
    assert.ok(h.logs.some((l) => /premier contact/.test(l.text)));
  });

  it("l'estampille de l'appareil est renvoyee si elle est plus basse que le curseur, jamais plus haute", async () => {
    const dir = tempDir();
    const h = await boot({ stateDir: dir });
    const d = h.dev();
    await d.push({ event: 0, card: CARD, pin: PIN });
    h.mod.tick();
    const stamp = (await d.handshake()).options.get('ATTLOGStamp');
    assert.equal(stamp, '1');
    assert.equal((await d.handshake({ ATTLOGStamp: '0' })).options.get('ATTLOGStamp'), '0', 'min(curseur, appareil)');
    assert.equal((await d.handshake({ ATTLOGStamp: '99' })).options.get('ATTLOGStamp'), '1', "l'appareil ne peut pas faire sauter des enregistrements");
    assert.equal((await d.handshake({ ATTLOGStamp: 'zz' })).options.get('ATTLOGStamp'), '1', 'estampille illisible ignoree');
  });

  it('numero de serie modifiable : un appareil inconnu est traite comme un chemin inconnu', async () => {
    const h = await boot();
    const d = h.dev();
    d.serial = 'ZZZZ99999999';
    const r = await d.handshake();
    assert.equal(r.status, 404);
    assert.equal(r.body, 'Not Found');
    assert.equal(h.out.length, 0);
    assert.equal(h.mod.state().controllers['CTL-2']?.lastAliveAt, null, 'un inconnu n\'est pas une preuve de vie');
  });

  it('un terminal et une centrale cohabitent, chacun avec ses portes', async () => {
    const h = await boot();
    await h.dev().handshake();
    await h.dev(SERIAL_T, 'terminal').handshake();
    const hb = events(h, 'heartbeat').map((o) => o.id).sort();
    assert.deepEqual(hb, ['P-ARRIERE', 'P-ENTREE', 'P-POINTEUSE']);
  });
});

describe('acces-zkteco : passages', () => {
  it('passage accepte : message exact du contrat, accepte par prepare()', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    await d.push({ event: 0, card: CARD, pin: PIN, door: 1, inout: 0, verify: 4 });
    assert.deepEqual(h.rejected, []);
    assert.equal(h.out.length, 1);
    const { id, msg } = h.out[0] as Out;
    assert.equal(id, 'P-ENTREE');
    assert.deepEqual(msg, {
      event: 'badge_granted',
      ts: T0,
      msgId: 'acc:CTL-2:1',
      access: { v: 1, controllerId: 'CTL-2', eventId: '1', direction: 'in', credential: CARD, holderName: null, holderRef: PIN, method: 'badge', result: 'granted', reason: null, deferred: false },
    });
    assert.ok(Buffer.byteLength(JSON.stringify(msg)) <= 1024);
  });

  it('sortie, deuxieme porte, empreinte, visage, code, bouton de sortie, ouverture a distance', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    await d.push({ event: 0, card: CARD, pin: PIN, door: 2, inout: 1, verify: 4 });
    await d.push({ event: 14, pin: PIN, door: 1, verify: 1 });
    await d.push({ event: 0, pin: PIN, door: 1, verify: 15 });
    await d.push({ event: 4, pin: PIN, door: 1, verify: 3 });
    await d.push({ event: 202, door: 1, card: CARD, pin: PIN });
    await d.push({ event: 8, door: 2, card: CARD, pin: PIN });
    const p = passages(h);
    assert.equal(p.length, 6);
    assert.equal(p[0]?.id, 'P-ARRIERE');
    assert.equal(p[0]?.msg.access?.direction, 'out');
    assert.deepEqual(p.map((o) => o.msg.access?.method), ['badge', 'fingerprint', 'face', 'code', 'exit_button', 'remote']);
    for (const o of p.slice(3)) assert.equal(o.msg.access?.credential, null, `pas de badge pour ${o.msg.access?.method}`);
    assert.equal(p[3]?.msg.access?.holderRef, PIN, 'le code reste dans le controleur : seul l\'identifiant du titulaire part');
    assert.equal(p[4]?.msg.access?.holderRef, null);
    assert.deepEqual(h.rejected, []);
  });

  it('refus : motifs par numero d\'evenement, refus isole jamais une alarme', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    const cases: [number, string][] = [[27, 'unknown_credential'], [29, 'expired'], [30, 'wrong_pin'], [21, 'out_of_schedule'], [22, 'out_of_schedule'], [24, 'antipassback'], [38, 'disabled'], [23, 'other']];
    for (const [ev] of cases) {
      h.clock.t += 120_000; // refus espaces : pas de rafale
      await d.push({ event: ev, card: CARD, pin: PIN, door: 1 });
    }
    const p = passages(h);
    assert.deepEqual(p.map((o) => o.msg.access?.reason), cases.map(([, r]) => r));
    for (const o of p) {
      assert.equal(o.msg.event, 'badge_denied');
      assert.equal(o.msg.access?.result, 'denied');
    }
    assert.equal(events(h, 'badge_denied_repeated').length, 0);
    assert.deepEqual(h.rejected, []);
  });

  it('refus repetes : 3 refus en 60 s sur la meme porte = badge_denied_repeated, autre porte sans effet', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    await d.push({ event: 27, card: CARD, door: 1 });
    h.clock.t += 10_000;
    await d.push({ event: 27, card: CARD, door: 2 });
    h.clock.t += 10_000;
    await d.push({ event: 27, card: CARD, door: 1 });
    assert.equal(events(h, 'badge_denied_repeated').length, 0);
    h.clock.t += 10_000;
    await d.push({ event: 27, card: CARD, door: 1 });
    const rep = events(h, 'badge_denied_repeated');
    assert.equal(rep.length, 1);
    assert.equal(rep[0]?.id, 'P-ENTREE');
  });

  it('evenement inconnu : journalise une fois, jamais une alarme ; entre 20 et 99 = refus `other`', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    await d.push({ event: 57, card: CARD, door: 1 });
    h.clock.t += 120_000;
    await d.push({ event: 57, card: CARD, door: 1 });
    await d.push({ event: 777, card: CARD, door: 1 });
    await d.push({ event: 777, card: CARD, door: 1 });
    const p = passages(h);
    assert.equal(p.length, 2);
    assert.equal(p[0]?.msg.access?.reason, 'other');
    assert.equal(h.out.filter((o) => o.msg.state === 'alarm' || ['door_forced', 'tamper', 'panic', 'sos'].includes(o.msg.event ?? '')).length, 0);
    assert.equal(h.logs.filter((l) => /evenement 57 inconnu/.test(l.text)).length, 1, 'une seule fois');
    assert.equal(h.logs.filter((l) => /evenement 777 inconnu/.test(l.text)).length, 1);
  });

  it('evenements sans effet connus : acquittes, journalises une fois, rien envoye', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    for (const ev of [206, 26, 220, 204, 206]) await d.push({ event: ev, door: 1 });
    assert.equal(h.out.length, 0);
    assert.equal(d.unacked, 0, 'acquittes malgre tout');
    assert.equal(h.logs.filter((l) => /evenement 206 \(/.test(l.text)).length, 1);
  });

  it('heure : decalage utcOffsetMin applique, heure du controleur conservee', async () => {
    const h = await boot({ controllers: [{ ...controllerCfg, utcOffsetMin: 60 }, terminalCfg] });
    const d = new FakeZk({ port: h.port, serial: SERIAL_C, now: () => h.clock.t, utcOffsetMin: 60 });
    await d.handshake();
    h.out.length = 0;
    await d.push({ event: 0, card: CARD, door: 1, at: T0 - 5000 });
    assert.equal(passages(h)[0]?.msg.ts, T0 - 5000);
    assert.equal(passages(h)[0]?.msg.access?.deferred, false);
  });

  it('ATTLOG d\'un terminal : passages acceptes, sens par Status, methode par Verify, porte 1, reponse OK:<n>', async () => {
    const h = await boot();
    const t = h.dev(SERIAL_T, 'terminal');
    await t.handshake();
    h.out.length = 0;
    t.recordAttlog({ pin: '2001', status: 0, verify: 1 });
    t.recordAttlog({ pin: '2002', status: 1, verify: 15, at: T0 + 1000 });
    t.recordAttlog({ pin: '2003', status: 0, verify: 2, at: T0 + 2000 });
    const [reply] = await t.flush();
    assert.equal(reply?.status, 200);
    assert.equal(reply?.body, 'OK:3');
    const p = passages(h);
    assert.equal(p.length, 3);
    assert.ok(p.every((o) => o.id === 'P-POINTEUSE' && o.msg.event === 'badge_granted' && o.msg.access?.result === 'granted' && o.msg.access.credential === null));
    assert.deepEqual(p.map((o) => o.msg.access?.direction), ['in', 'out', 'in']);
    assert.deepEqual(p.map((o) => o.msg.access?.method), ['fingerprint', 'face', 'badge']);
    assert.deepEqual(p.map((o) => o.msg.access?.holderRef), ['2001', '2002', '2003']);
    assert.deepEqual(h.rejected, []);
    assert.equal(p[0]?.msg.access?.controllerId, 'TERM-1');
    assert.match(p[0]?.msg.access?.eventId ?? '', /^\d{10}-[0-9a-f]{10}$/, 'identifiant synthetique');
    assert.equal(t.unacked, 0);
  });

  it('rtlog sur un terminal et ATTLOG sur une centrale : acquittes sans effet (tables non exploitees)', async () => {
    const h = await boot();
    const t = h.dev(SERIAL_T, 'terminal');
    await t.handshake();
    h.out.length = 0;
    await t.push({ event: 0, card: CARD });
    const c = h.dev();
    await c.handshake();
    c.recordAttlog({ pin: '1' });
    await c.flush();
    assert.equal(passages(h).length, 0);
    assert.equal(t.unacked + c.unacked, 0);
  });

  it('jamais de numero de badge, de code ou de serie dans les journaux', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    await d.push({ event: 0, card: CARD, pin: PIN });
    await d.push({ event: 27, card: '99887766', pin: '555' });
    d.recordRaw('rtlog', `time=2026-10-17 08:00:00\tpin=${PIN}\tcardno=${CARD}\tevent=zz`);
    await d.flush();
    d.serial = 'INCONNU123456';
    await d.handshake();
    const text = allLogs(h);
    for (const secret of [CARD, '99887766', PIN, '555', SERIAL_C, 'INCONNU123456']) assert.ok(!text.includes(secret), `fuite : ${secret}`);
    assert.ok(text.length > 0);
  });
});

describe('acces-zkteco : alarmes et etats de porte', () => {
  it('porte forcee (102) = door_forced sur la bonne porte, une seule fois meme renvoyee', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    await d.push({ event: 102, door: 2 });
    const f = events(h, 'door_forced');
    assert.equal(f.length, 1);
    assert.equal(f[0]?.id, 'P-ARRIERE');
    assert.equal(f[0]?.msg.ts, T0);
    // l'appareil renvoie le meme enregistrement (reponse perdue) : pas de second message
    d.recordRaw('rtlog', d.rtlogLine({ event: 102, door: 2, index: 5 }));
    d.recordRaw('rtlog', d.rtlogLine({ event: 102, door: 2, index: 5 }));
    await d.flush();
    assert.equal(events(h, 'door_forced').length, 2, 'deux index differents = deux evenements, mais un meme index n\'est pas emis deux fois');
    assert.deepEqual(h.rejected, []);
  });

  it('porte ouverte, fermee, maintenue ouverte puis refermee', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    await d.push({ event: 200, door: 1 });
    h.clock.t += 5000;
    await d.push({ event: 28, door: 1 });
    h.clock.t += 5000;
    await d.push({ event: 201, door: 1 });
    assert.deepEqual(h.out.map((o) => `${o.id}:${o.msg.event}`), ['P-ENTREE:door_opened', 'P-ENTREE:door_held_open', 'P-ENTREE:door_closed']);
    assert.equal(h.mod.state().controllers['CTL-2']?.doors[0]?.held, false);
    assert.deepEqual(h.rejected, []);
  });

  it('sabotage (100) : tamper sur la porte designee, ou sur toutes les portes si elle est inconnue', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    await d.push({ event: 100, door: 1 });
    assert.deepEqual(events(h, 'tamper').map((o) => o.id), ['P-ENTREE']);
    h.clock.t += 5000;
    await d.push({ event: 100, door: 9 });
    assert.deepEqual(events(h, 'tamper').map((o) => o.id).sort(), ['P-ARRIERE', 'P-ENTREE', 'P-ENTREE']);
  });

  it('contrainte (101) : passage accepte ET alarme silencieuse `panic`, une seule fois', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    await d.push({ event: 101, door: 1, pin: PIN, verify: 3 });
    assert.equal(passages(h).length, 1);
    assert.equal(passages(h)[0]?.msg.access?.method, 'code');
    assert.equal(passages(h)[0]?.msg.access?.credential, null);
    assert.equal(events(h, 'panic').length, 1);
    assert.equal(events(h, 'panic')[0]?.id, 'P-ENTREE');
    assert.deepEqual(h.rejected, []);
  });

  it('porte pour laquelle aucun detecteur n\'est declare : ignore sans bloquer l\'appareil', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    await d.push({ event: 0, card: CARD, door: 4 });
    await d.push({ event: 102, door: 4 });
    await d.push({ event: 200, door: 3 });
    assert.equal(d.unacked, 0);
    assert.equal(h.out.filter((o) => o.msg.event !== 'heartbeat').length, 0);
  });

  it('rtstate : etat des portes par changement uniquement, sans doublon avec le rtlog', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    await d.sendRtstate('11');
    assert.deepEqual(h.out.filter((o) => o.msg.event === 'door_closed').map((o) => o.id).sort(), ['P-ARRIERE', 'P-ENTREE']);
    h.out.length = 0;
    await d.sendRtstate('11');
    assert.equal(h.out.length, 0, 'aucun changement');
    await d.sendRtstate('21');
    assert.deepEqual(h.out.map((o) => `${o.id}:${o.msg.event}`), ['P-ENTREE:door_opened']);
    h.out.length = 0;
    await d.push({ event: 200, door: 1 }); // le rtlog confirme ce que rtstate a deja dit
    assert.equal(events(h, 'door_opened').length, 1, 'le rtlog est autoritaire (horodatage) : il est emis');
    h.out.length = 0;
    await d.sendRtstate('21');
    assert.equal(h.out.length, 0);
    await d.sendRtstate('1');
    assert.deepEqual(h.out.map((o) => `${o.id}:${o.msg.event}`), ['P-ENTREE:door_closed']);
  });

  it('rtstate : alarme indiquee = information seulement (les alarmes viennent du rtlog)', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    await d.sendRtstate('11', { alarm: '0100' });
    assert.equal(h.out.filter((o) => o.msg.event !== 'door_closed').length, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Horloge, supervision
// ---------------------------------------------------------------------------------------------------------------------

describe('acces-zkteco : horloge et supervision', () => {
  it('derive d\'horloge (rtstate) : clock_drift sur chaque porte, puis retour a la normale', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    d.clockSkewMs = 10 * 60_000;
    await d.sendRtstate('11');
    assert.deepEqual(events(h, 'clock_drift').map((o) => o.id).sort(), ['P-ARRIERE', 'P-ENTREE']);
    assert.equal(h.mod.state().controllers['CTL-2']?.drifting, true);
    d.clockSkewMs = 0;
    h.out.length = 0;
    await d.sendRtstate('11');
    assert.deepEqual(events(h, 'restored').map((o) => o.id).sort(), ['P-ARRIERE', 'P-ENTREE']);
    assert.equal(h.mod.state().controllers['CTL-2']?.drifting, false);
  });

  it('ecart sous le seuil : aucune derive ; seuil reglable', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    d.clockSkewMs = 60_000;
    await d.sendRtstate('11');
    assert.equal(events(h, 'clock_drift').length, 0);
    const h2 = await boot({ thresholds: { clockDriftMs: 30_000 } });
    const d2 = h2.dev();
    await d2.handshake();
    d2.clockSkewMs = 60_000;
    await d2.sendRtstate('11');
    assert.equal(events(h2, 'clock_drift').length, 2);
  });

  it('un enregistrement date du futur prouve une horloge en avance ; un enregistrement ancien non (il peut etre stocke)', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    await d.push({ event: 0, card: CARD, door: 1, at: T0 - 3_600_000 });
    assert.equal(events(h, 'clock_drift').length, 0, 'une heure de retard = enregistrement stocke, pas une derive');
    await d.push({ event: 0, card: CARD, door: 1, at: T0 + 10 * 60_000 });
    assert.equal(events(h, 'clock_drift').length, 2);
    // un enregistrement isole et proche de l'heure locale ramene la derive a la normale
    await d.push({ event: 0, card: CARD, door: 1, at: T0 + 1000 });
    assert.equal(events(h, 'restored').length, 2);
  });

  it('hors ligne apres silence puis grace, signe de vie au retour', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    h.clock.t += 91_000; // silenceMs = 90 s
    h.mod.tick();
    assert.equal(states(h, 'offline').length, 0, 'delai de grace');
    assert.equal(h.mod.state().controllers['CTL-2']?.link, 'lost');
    h.clock.t += 16_000; // offlineGraceMs = 15 s
    h.mod.tick();
    assert.deepEqual(states(h, 'offline').map((o) => o.id).sort(), ['P-ARRIERE', 'P-ENTREE', 'P-POINTEUSE'], 'une fois par porte (le terminal, jamais venu, aussi)');
    h.mod.tick();
    assert.equal(states(h, 'offline').length, 3, 'une seule fois');
    h.out.length = 0;
    await d.ping();
    assert.equal(h.mod.state().controllers['CTL-2']?.link, 'online');
    assert.deepEqual(events(h, 'heartbeat').map((o) => o.id).sort(), ['P-ARRIERE', 'P-ENTREE']);
  });

  it('appareil jamais joint depuis le demarrage : hors ligne (jamais « fermee » a tort)', async () => {
    const h = await boot();
    h.clock.t += 91_000;
    h.mod.tick();
    h.clock.t += 16_000;
    h.mod.tick();
    assert.deepEqual(states(h, 'offline').map((o) => o.id).sort(), ['P-ARRIERE', 'P-ENTREE', 'P-POINTEUSE']);
  });

  it('signe de vie periodique toutes les heartbeatS secondes tant que l\'appareil interroge', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    for (let i = 0; i < 4; i++) {
      h.clock.t += 20_000;
      await d.poll();
      h.mod.tick();
    }
    assert.equal(events(h, 'heartbeat').filter((o) => o.id === 'P-ENTREE').length, 1, '80 s : un signe de vie (toutes les 60 s)');
    assert.equal(states(h, 'offline').length, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Recuperation F8
// ---------------------------------------------------------------------------------------------------------------------

describe('acces-zkteco : recuperation F8', () => {
  it('le socle refuse le message : 503, l\'appareil conserve et renvoie, emis UNE seule fois', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    h.accept.value = false;
    d.record({ event: 0, card: CARD, pin: PIN, door: 1 });
    const [r1] = await d.flush();
    assert.equal(r1?.status, 503);
    assert.equal(d.unacked, 1, 'conserve par l\'appareil');
    assert.equal(passages(h).length, 0);
    const [r2] = await d.flush();
    assert.equal(r2?.status, 503);
    h.accept.value = true;
    const [r3] = await d.flush();
    assert.equal(r3?.status, 200);
    assert.equal(r3?.body, 'OK');
    assert.equal(d.unacked, 0);
    assert.equal(passages(h).length, 1);
    await d.flush();
    assert.equal(passages(h).length, 1, 'rien de plus');
  });

  it('lot partiel : tout le lot est renvoye, les lignes deja emises ne le sont pas deux fois', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    d.record({ event: 0, card: CARD, door: 1 });
    d.record({ event: 102, door: 2 });
    d.record({ event: 27, card: '5551234', door: 1 });
    // le socle refuse a partir du deuxieme message
    let n = 0;
    const original = h.accept;
    Object.defineProperty(original, 'value', { get: () => n++ < 1, configurable: true });
    const [r1] = await d.flush();
    assert.equal(r1?.status, 503);
    assert.equal(passages(h).length, 1);
    Object.defineProperty(original, 'value', { value: true, writable: true, configurable: true });
    const [r2] = await d.flush();
    assert.equal(r2?.status, 200);
    assert.equal(passages(h).length, 2, 'le premier passage n\'est pas reemis');
    assert.equal(events(h, 'door_forced').length, 1);
    assert.deepEqual(h.out.map((o) => o.msg.msgId).filter((m, i, a) => a.indexOf(m) !== i), [], 'aucun msgId en double');
  });

  it('lignes illisibles : ignorees et comptees, sans bloquer l\'acquittement des autres', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    d.recordRaw('rtlog', 'time=2026-10-17 08:00');
    d.recordRaw('rtlog', '\t\t\t');
    d.recordRaw('rtlog', `\u0000\u0001\u0002 ${'ÿ'.repeat(5000)}`);
    d.record({ event: 0, card: CARD, door: 1 });
    d.recordRaw('rtlog', 'event=0');
    const [r] = await d.flush();
    assert.equal(r?.status, 200);
    assert.equal(passages(h).length, 1);
    assert.equal(d.unacked, 0);
    assert.ok(h.logs.some((l) => /3 ligne\(s\) illisible\(s\) ignoree\(s\) sur 4/.test(l.text)), allLogs(h));
  });

  it('passages stockes pendant une coupure : recuperes avec deferred=true, passage recent non differe', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    d.goOffline();
    d.record({ event: 0, card: CARD, door: 1, at: T0 + 1000 });
    d.record({ event: 27, card: '5551234', door: 2, at: T0 + 60_000 });
    await assert.rejects(d.flush(), /hors ligne/);
    h.clock.t = T0 + 20 * 60_000; // 20 minutes plus tard
    d.goOnline();
    d.record({ event: 0, card: CARD, door: 1, at: h.clock.t });
    await d.flush();
    const p = passages(h);
    assert.equal(p.length, 3);
    assert.deepEqual(p.map((o) => o.msg.access?.deferred), [true, true, false]);
    assert.deepEqual(p.map((o) => o.msg.ts), [T0 + 1000, T0 + 60_000, h.clock.t], 'heure du controleur conservee, dans l\'ordre');
    assert.deepEqual(h.rejected, []);
  });

  it('seuil de differe : deferredAfterS reglable, borne incluse', async () => {
    const h = await boot({ thresholds: { deferredAfterS: 30 } });
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    h.clock.t = T0 + 30_000;
    await d.push({ event: 0, card: CARD, door: 1, at: T0 });
    await d.push({ event: 0, card: CARD, door: 1, at: T0 - 1000 });
    assert.deepEqual(passages(h).map((o) => o.msg.access?.deferred), [false, true]);
  });

  it('un doublon renvoye par l\'appareil (meme index) n\'est emis qu\'une fois', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    const line = d.rtlogLine({ event: 0, card: CARD, door: 1, index: 42 });
    d.recordRaw('rtlog', line);
    await d.flush();
    d.recordRaw('rtlog', line);
    await d.flush();
    assert.equal(passages(h).length, 1);
  });

  it('redemarrage du module : le curseur est conserve sur disque et renvoye a la poignee de main', async () => {
    const dir = tempDir();
    const h1 = await boot({ stateDir: dir });
    const d1 = h1.dev();
    await d1.handshake();
    await d1.push({ event: 0, card: CARD, door: 1 });
    await d1.push({ event: 0, card: CARD, door: 1, at: T0 + 1000 });
    await h1.stop();
    assert.ok(existsSync(join(dir, 'acces-curseurs.json')), 'curseur ecrit a l\'arret');
    const saved = JSON.parse(readFileSync(join(dir, 'acces-curseurs.json'), 'utf8')) as { controllers: Record<string, { cursor: string }> };
    assert.equal(saved.controllers['CTL-2']?.cursor, '2');
    const h2 = await boot({ stateDir: dir });
    const hs = await h2.dev().handshake();
    assert.equal(hs.options.get('ATTLOGStamp'), '2');
    assert.equal(hs.options.get('Stamp'), '2');
    // dossier different : curseur propre
    const h3 = await boot();
    assert.equal((await h3.dev().handshake()).options.get('ATTLOGStamp'), 'None');
  });

  it('le curseur n\'avance pas quand le lot est refuse', async () => {
    const dir = tempDir();
    const h = await boot({ stateDir: dir });
    const d = h.dev();
    await d.handshake();
    h.accept.value = false;
    d.record({ event: 0, card: CARD, door: 1 });
    await d.flush();
    h.accept.value = true;
    assert.equal((await d.handshake()).options.get('ATTLOGStamp'), 'None', 'rien d\'acquitte, rien dans le curseur');
    await d.flush();
    assert.equal((await d.handshake()).options.get('ATTLOGStamp'), '1');
  });

  it('autres tables (utilisateurs, empreintes, operations) : jamais lues, acquittees', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    const r = await rawRequest(h.port, 'POST', `/iclock/cdata?SN=${SERIAL_C}&table=FINGERTMP&Stamp=1`, { body: 'FP PIN=1\tTMP=AAAABBBB\r\n' });
    assert.equal(r.status, 200);
    assert.ok(r.body.startsWith('OK'));
    const r2 = await rawRequest(h.port, 'POST', `/iclock/cdata?SN=${SERIAL_C}&table=OPERLOG&Stamp=1`, { body: 'USER PIN=1\tName=Konan Yao\r\n' });
    assert.equal(r2.status, 200);
    assert.ok(!allLogs(h).includes('Konan'));
    assert.ok(!allLogs(h).includes('AAAABBBB'));
    assert.equal(h.out.filter((o) => o.msg.event !== 'heartbeat').length, 0);
  });

  it('corps vide ou sans table : acquitte sans effet', async () => {
    const h = await boot();
    await h.dev().handshake();
    const r = await rawRequest(h.port, 'POST', `/iclock/cdata?SN=${SERIAL_C}&table=rtlog`, { body: '' });
    assert.equal(r.status, 200);
    const r2 = await rawRequest(h.port, 'POST', `/iclock/cdata?SN=${SERIAL_C}`, { body: 'x' });
    assert.equal(r2.status, 200);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------------------------------------------------

describe('acces-zkteco : ordres (ouverture a distance)', () => {
  const unlock = (h: Harness, durationS?: number) => (h.handlers.get('ACT-ENTREE') as ActuatorHandler)({ actuatorId: 'ACT-ENTREE', cmdId: 'c1', action: 'unlock', ...(durationS === undefined ? {} : { durationS }) });
  /** Etat d'une promesse sans l'attendre. */
  const probe = async <T>(p: Promise<T>): Promise<{ done: boolean; value?: T }> => {
    let state: { done: boolean; value?: T } = { done: false };
    void p.then((v) => (state = { done: true, value: v }));
    await settle();
    await settle();
    return state;
  };

  it('les actionneurs de la configuration sont enregistres aupres du socle', async () => {
    const h = await boot();
    assert.deepEqual([...h.handlers.keys()].sort(), ['ACT-ENTREE', 'GATE-ARRIERE']);
  });

  it('socle sans canal de commande : surveillance seule, avertissement, le module fonctionne', async () => {
    const h = await boot({}, { actuators: false });
    assert.equal(h.handlers.size, 0);
    assert.ok(h.logs.some((l) => l.level === 'warn' && /canal de commande/.test(l.text)));
    await h.dev().handshake();
    assert.ok(events(h, 'heartbeat').length > 0);
  });

  it('impulsion : accuse SEULEMENT apres Return=0 de l\'appareil', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    d.commandReply = 'silent';
    const p = unlock(h);
    await settle();
    assert.equal(h.mod.state().controllers['CTL-2']?.commandsPending, 1);
    assert.deepEqual(await probe(p), { done: false }, 'pas d\'accuse tant que l\'appareil n\'a rien repondu');
    const { commands } = await d.poll();
    assert.equal(commands.length, 1);
    assert.match(commands[0]?.text ?? '', /^CONTROL DEVICE 01010105$/);
    assert.match(String(commands[0]?.id), /^\d+$/);
    assert.deepEqual(await probe(p), { done: false }, 'remise mais pas encore confirmee');
    await d.answer(commands[0] as { id: number; text: string }, 0);
    assert.deepEqual(await p, { result: 'done' });
    assert.equal(h.mod.state().controllers['CTL-2']?.commandsPending, 0);
  });

  it('ordre de la deuxieme porte : duree d\'impulsion propre a l\'actionneur (barriere, 8 s) ; open / close', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    const gate = h.handlers.get('GATE-ARRIERE') as ActuatorHandler;
    const p1 = gate({ actuatorId: 'GATE-ARRIERE', cmdId: 'a', action: 'open' });
    await settle();
    assert.equal((await d.poll()).commands[0]?.text, 'CONTROL DEVICE 01020108');
    assert.deepEqual(await p1, { result: 'done' });
    const p2 = gate({ actuatorId: 'GATE-ARRIERE', cmdId: 'b', action: 'close' });
    await settle();
    assert.equal((await d.poll()).commands[0]?.text, 'CONTROL DEVICE 01020100');
    assert.deepEqual(await p2, { result: 'done' });
    const p3 = gate({ actuatorId: 'GATE-ARRIERE', cmdId: 'c', action: 'unlock' });
    assert.deepEqual(await p3, { result: 'refused', code: 'not_supported' }, 'une barriere ne se « deverrouille » pas');
  });

  it('ouverture continue : unlock au-dela de longUnlockS', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    const p = unlock(h, 600);
    await settle();
    assert.equal((await d.poll()).commands[0]?.text, 'CONTROL DEVICE 010101FF');
    assert.deepEqual(await p, { result: 'done' });
    const p2 = unlock(h, 60);
    await settle();
    assert.equal((await d.poll()).commands[0]?.text, 'CONTROL DEVICE 01010105', 'au seuil : impulsion');
    await p2;
  });

  it('lock = retour au mode normal et refermeture (jamais « toujours fermee »)', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    const p = (h.handlers.get('ACT-ENTREE') as ActuatorHandler)({ actuatorId: 'ACT-ENTREE', cmdId: 'c', action: 'lock' });
    await settle();
    assert.equal((await d.poll()).commands[0]?.text, 'CONTROL DEVICE 01010100');
    assert.deepEqual(await p, { result: 'done' });
  });

  it('format « spaced » demande par la configuration', async () => {
    const h = await boot({ push: { controlFormat: 'spaced' } });
    const d = h.dev();
    await d.handshake();
    const p = unlock(h);
    await settle();
    assert.equal((await d.poll()).commands[0]?.text, 'CONTROL DEVICE 1 1 1 5');
    await p;
  });

  it('refus de l\'appareil (code d\'erreur) : error / refused_by_device, pas d\'accuse de reussite', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    d.commandReply = -1002;
    const p = unlock(h);
    await settle();
    await d.poll();
    assert.deepEqual(await p, { result: 'error', code: 'refused_by_device' });
  });

  it('pas de reponse avant commandTimeoutS : error / timeout', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    d.commandReply = 'silent';
    const p = unlock(h);
    await settle();
    await d.poll();
    h.clock.t += 29_000;
    h.mod.tick();
    assert.deepEqual(await probe(p), { done: false });
    h.clock.t += 2_000;
    h.mod.tick();
    assert.deepEqual(await p, { result: 'error', code: 'timeout' });
    assert.equal(h.mod.state().controllers['CTL-2']?.commandsPending, 0);
  });

  it('commande expiree : jamais remise en retard a l\'appareil', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    const p = unlock(h);
    await settle();
    h.clock.t += 31_000; // l'appareil n'est pas venu (reseau lent)
    h.mod.tick();
    const r = await p;
    assert.equal(r.result, 'error');
    assert.match(r.code ?? '', /^(timeout|offline)$/);
    const { commands } = await d.poll();
    assert.deepEqual(commands, [], 'la porte ne s\'ouvre pas apres coup');
    assert.equal(d.executed.length, 0);
  });

  it('resultat tardif ou invente (identifiant inconnu) : ignore, sans effet', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    d.commandReply = 'silent';
    const p = unlock(h);
    await settle();
    const { commands } = await d.poll();
    const cmd = commands[0] as { id: number; text: string };
    const forged = await d.answer({ id: cmd.id + 5000, text: 'X' }, 0);
    assert.equal(forged.status, 200);
    assert.deepEqual(await probe(p), { done: false }, 'un faux accuse ne valide rien');
    h.clock.t += 31_000;
    h.mod.tick();
    assert.equal((await p).code, 'timeout');
    const late = await d.answer(cmd, 0);
    assert.equal(late.status, 200);
    assert.ok(h.logs.some((l) => /tardif/.test(l.text)));
  });

  it('appareil jamais venu ou muet depuis longtemps : error / offline tout de suite', async () => {
    const h = await boot();
    assert.deepEqual(await unlock(h), { result: 'error', code: 'offline' });
    const d = h.dev();
    await d.handshake();
    h.clock.t += 100_000;
    assert.deepEqual(await unlock(h), { result: 'error', code: 'offline' });
    await d.ping();
    const p = unlock(h);
    await settle();
    await d.poll();
    assert.deepEqual(await p, { result: 'done' });
  });

  it('ordres simultanes serialises : un seul en vol, remis dans l\'ordre, jamais deux fois', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    d.commandReply = 'silent';
    const p1 = unlock(h, 600);
    const p2 = unlock(h);
    const p3 = (h.handlers.get('ACT-ENTREE') as ActuatorHandler)({ actuatorId: 'ACT-ENTREE', cmdId: 'c3', action: 'lock' });
    await settle();
    const a = await d.poll();
    assert.deepEqual(a.commands.map((c) => c.text), ['CONTROL DEVICE 010101FF']);
    assert.deepEqual((await d.poll()).commands, [], 'rien de plus tant que le premier n\'est pas confirme (et jamais remis deux fois)');
    await d.answer(a.commands[0] as { id: number; text: string }, 0);
    assert.deepEqual(await p1, { result: 'done' });
    const b = await d.poll();
    assert.deepEqual(b.commands.map((c) => c.text), ['CONTROL DEVICE 01010105']);
    await d.answer(b.commands[0] as { id: number; text: string }, 0);
    assert.deepEqual(await p2, { result: 'done' });
    const c = await d.poll();
    assert.deepEqual(c.commands.map((x) => x.text), ['CONTROL DEVICE 01010100']);
    await d.answer(c.commands[0] as { id: number; text: string }, 0);
    assert.deepEqual(await p3, { result: 'done' });
    const ids = [a, b, c].map((x) => x.commands[0]?.id);
    assert.equal(new Set(ids).size, 3, 'identifiants uniques');
    assert.deepEqual((await d.poll()).commands, []);
  });

  it('stop et actions inconnues : refused / not_supported', async () => {
    const h = await boot();
    const handler = h.handlers.get('ACT-ENTREE') as ActuatorHandler;
    assert.deepEqual(await handler({ actuatorId: 'ACT-ENTREE', cmdId: 'c', action: 'stop' }), { result: 'refused', code: 'not_supported' });
    assert.deepEqual(await handler({ actuatorId: 'ACT-ENTREE', cmdId: 'c', action: 'explose' }), { result: 'refused', code: 'not_supported' });
    assert.deepEqual(await handler({ actuatorId: 'ACT-ENTREE', cmdId: 'c', action: 'open' }), { result: 'refused', code: 'not_supported' });
    assert.equal(h.mod.state().controllers['CTL-2']?.commandsPending, 0);
  });

  it('arret du module : les ordres en attente sont rejetes, le serveur ferme', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    const p = unlock(h);
    await settle();
    await h.stop();
    assert.deepEqual(await p, { result: 'error', code: 'stopped' });
    await assert.rejects(d.ping());
    assert.equal(h.mod.addresses().http, null);
  });

  it('getrequest sans commande : OK ; avec commande : C:<id>:<commande>', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    assert.equal((await d.poll()).reply.body, 'OK');
    const p = unlock(h);
    await settle();
    d.commandReply = 'silent';
    const { reply } = await d.poll();
    assert.match(reply.body, /^C:\d+:CONTROL DEVICE 01010105\n$/);
    h.clock.t += 31_000;
    h.mod.tick();
    await p;
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Securite de la facade
// ---------------------------------------------------------------------------------------------------------------------

describe('acces-zkteco : securite', () => {
  const sameRefusal = (a: { status: number; body: string }, b: { status: number; body: string }) => assert.deepEqual({ s: a.status, b: a.body }, { s: b.status, b: b.body });

  it('tout refus de fond recoit la MEME reponse neutre : numero inconnu, chemin, methode, parametre manquant ou hostile', async () => {
    // 20 requetes simultanees : la borne de connexions par adresse est relevee pour ce seul essai (elle est testee plus bas).
    const h = await boot({ limits: { maxConnectionsPerAddress: 64, perAddressPerMinute: 1000 } });
    const refusals = await Promise.all([
      rawRequest(h.port, 'GET', '/iclock/cdata?SN=ZZZZ99999999&options=all'),
      rawRequest(h.port, 'GET', '/iclock/cdata'),
      rawRequest(h.port, 'GET', '/iclock/cdata?SN='),
      rawRequest(h.port, 'GET', `/iclock/cdata?SN=${SERIAL_C.toLowerCase()}`),
      rawRequest(h.port, 'GET', `/iclock/cdata?SN=${SERIAL_C}%00`),
      rawRequest(h.port, 'GET', `/iclock/cdata?SN=${SERIAL_C}&SN=${SERIAL_C}`),
      rawRequest(h.port, 'GET', `/iclock/cdata?SN=${encodeURIComponent("' OR 1=1 --")}`),
      rawRequest(h.port, 'GET', `/iclock/cdata?SN=${'A'.repeat(500)}`),
      rawRequest(h.port, 'GET', `/iclock/inconnu?SN=${SERIAL_C}`),
      rawRequest(h.port, 'GET', `/ICLOCK/CDATA?SN=${SERIAL_C}`),
      rawRequest(h.port, 'GET', `/iclock/cdata/?SN=${SERIAL_C}`),
      rawRequest(h.port, 'GET', `/?SN=${SERIAL_C}`),
      rawRequest(h.port, 'GET', `/../../etc/passwd?SN=${SERIAL_C}`),
      rawRequest(h.port, 'PUT', `/iclock/cdata?SN=${SERIAL_C}`, { body: 'x' }),
      rawRequest(h.port, 'DELETE', `/iclock/cdata?SN=${SERIAL_C}`),
      rawRequest(h.port, 'OPTIONS', `/iclock/cdata?SN=${SERIAL_C}`),
      rawRequest(h.port, 'POST', `/iclock/getrequest?SN=${SERIAL_C}`, { body: 'x' }),
      rawRequest(h.port, 'GET', `/iclock/devicecmd?SN=${SERIAL_C}`),
      rawRequest(h.port, 'POST', `/iclock/ping?SN=${SERIAL_C}`, { body: 'x' }),
      rawRequest(h.port, 'GET', '/iclock/ping'),
    ]);
    for (const r of refusals) {
      assert.equal(r.status, 404);
      sameRefusal(r, refusals[0] as { status: number; body: string });
    }
    const flat = (r: { headers: Record<string, string | string[] | undefined> }) => JSON.stringify({ ...r.headers, date: '', connection: '' });
    for (const r of refusals) assert.equal(flat(r), flat(refusals[0] as never), 'memes en-tetes');
    assert.equal(h.out.length, 0, 'aucun message pour un inconnu');
    assert.equal(h.mod.state().controllers['CTL-2']?.lastAliveAt, null);
  });

  it('GET avec corps : refuse', async () => {
    const h = await boot();
    const r = await rawRequest(h.port, 'GET', `/iclock/getrequest?SN=${SERIAL_C}`, { body: 'surprise' });
    assert.equal(r.status, 404);
  });

  it('journal des refus : une ligne par minute, sans le numero de serie ni le chemin recus', async () => {
    const h = await boot();
    for (let i = 0; i < 20; i++) await rawRequest(h.port, 'GET', `/iclock/cdata?SN=INCONNU${1000 + i}`);
    const lines = h.logs.filter((l) => /requete refusee/.test(l.text));
    assert.equal(lines.length, 1, 'limite a une ligne par minute');
    assert.ok(!/INCONNU/.test(allLogs(h)));
    h.clock.t += 61_000;
    await rawRequest(h.port, 'GET', '/iclock/cdata?SN=INCONNU2000');
    const again = h.logs.filter((l) => /requete refusee/.test(l.text));
    assert.equal(again.length, 2);
    assert.match(again[1]?.text ?? '', /\(20 message\(s\) semblable\(s\) non affiche\(s\)\)|\(19 message/);
  });

  it('allowFrom : adresse source hors liste = connexion fermee sans reponse ; dans la liste = servie', async () => {
    const out = await boot({ allowFrom: ['10.9.8.7', '192.168.77.0/24'] });
    await assert.rejects(rawRequest(out.port, 'GET', `/iclock/cdata?SN=${SERIAL_C}`), /socket hang up|ECONNRESET|aborted/);
    assert.equal(out.out.length, 0);
    assert.equal(out.mod.state().controllers['CTL-2']?.lastAliveAt, null);
    assert.ok(out.logs.some((l) => /hors de allowFrom/.test(l.text)));
    const inside = await boot({ allowFrom: ['127.0.0.1'] });
    assert.equal((await rawRequest(inside.port, 'GET', `/iclock/cdata?SN=${SERIAL_C}`)).status, 200);
    const range = await boot({ allowFrom: ['127.0.0.0/8'] });
    assert.equal((await rawRequest(range.port, 'GET', `/iclock/cdata?SN=${SERIAL_C}`)).status, 200);
  });

  it('corps trop gros : 413 sans etre lu ; flux sans Content-Length depassant la limite : coupe ; le module continue', async () => {
    const h = await boot({ limits: { maxBodyBytes: 2048 } });
    const big = await rawRequest(h.port, 'POST', `/iclock/cdata?SN=${SERIAL_C}&table=rtlog`, { body: 'x'.repeat(5000) });
    assert.equal(big.status, 413);
    // sans Content-Length (transfert par morceaux)
    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = connect(h.port, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    let got = '';
    sock.on('data', (c) => (got += c.toString('latin1')));
    sock.on('error', () => undefined);
    sock.resume();
    sock.write(`POST /iclock/cdata?SN=${SERIAL_C}&table=rtlog HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n`);
    for (let i = 0; i < 4; i++) sock.write(`400\r\n${'y'.repeat(1024)}\r\n`);
    await new Promise<void>((r) => sock.once('close', () => r()));
    assert.match(got, /413/);
    assert.equal(h.out.filter((o) => o.msg.event !== 'heartbeat').length, 0);
    const ok = await rawRequest(h.port, 'GET', `/iclock/getrequest?SN=${SERIAL_C}`);
    assert.equal(ok.status, 200, 'toujours servi');
  });

  it('Content-Length illisible ou negatif : refuse', async () => {
    const h = await boot();
    for (const cl of ['abc', '-5', '1e9', '99999999999999']) {
      const sock = await new Promise<Socket>((resolve, reject) => {
        const s = connect(h.port, '127.0.0.1', () => resolve(s));
        s.on('error', reject);
      });
      let got = '';
      sock.on('data', (c) => (got += c.toString('latin1')));
      sock.on('error', () => undefined);
    sock.resume();
      sock.write(`POST /iclock/cdata?SN=${SERIAL_C}&table=rtlog HTTP/1.1\r\nHost: x\r\nContent-Length: ${cl}\r\n\r\n`);
      await new Promise<void>((r) => {
        sock.once('close', () => r());
        setTimeout(() => sock.destroy(), 1500).unref();
      });
      assert.doesNotMatch(got, /^HTTP\/1\.1 200/, cl);
    }
    assert.equal((await rawRequest(h.port, 'GET', `/iclock/ping?SN=${SERIAL_C}`)).status, 200);
  });

  it('en-tetes enormes : refus sans planter', async () => {
    const h = await boot();
    const r = await rawRequest(h.port, 'GET', `/iclock/ping?SN=${SERIAL_C}`, { headers: { 'X-Gros': 'a'.repeat(20_000) } }).catch((e: Error) => ({ status: -1, body: e.message }));
    assert.ok(r.status === 431 || r.status === 400 || r.status === -1, String(r.status));
    assert.equal((await rawRequest(h.port, 'GET', `/iclock/ping?SN=${SERIAL_C}`)).status, 200);
  });

  it('debit limite par adresse : au-dela du seau, 429 ; le seau se remplit avec l\'horloge', async () => {
    const h = await boot({ limits: { perAddressPerMinute: 5 } });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await rawRequest(h.port, 'GET', `/iclock/ping?SN=${SERIAL_C}`)).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429, 429]);
    h.clock.t += 60_000;
    assert.equal((await rawRequest(h.port, 'GET', `/iclock/ping?SN=${SERIAL_C}`)).status, 200);
  });

  it('le debit compte aussi les requetes refusees (un inconnu ne peut pas inonder le module)', async () => {
    const h = await boot({ limits: { perAddressPerMinute: 3 } });
    const s: number[] = [];
    for (let i = 0; i < 5; i++) s.push((await rawRequest(h.port, 'GET', '/iclock/cdata?SN=ZZZZ99999999')).status);
    assert.deepEqual(s, [404, 404, 404, 429, 429]);
  });

  it('connexion lente (en-tetes envoyes au compte-gouttes) : fermee apres le delai', async () => {
    const h = await boot({ limits: { requestTimeoutS: 0.3 } });
    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = connect(h.port, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    sock.on('error', () => undefined);
    sock.resume();
    sock.write('GET /iclock/ping?SN=');
    const closed = await new Promise<boolean>((resolve) => {
      sock.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 5000).unref();
    });
    sock.destroy();
    assert.equal(closed, true, 'connexion lente coupee');
    assert.equal((await rawRequest(h.port, 'GET', `/iclock/ping?SN=${SERIAL_C}`)).status, 200);
  });

  it('corps lent (annonce 1000 octets, en envoie 3) : coupe apres le delai, rien n\'est emis', async () => {
    const h = await boot({ limits: { requestTimeoutS: 0.3 } });
    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = connect(h.port, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    sock.on('error', () => undefined);
    sock.resume();
    sock.write(`POST /iclock/cdata?SN=${SERIAL_C}&table=rtlog HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\nabc`);
    const closed = await new Promise<boolean>((resolve) => {
      sock.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 5000).unref();
    });
    sock.destroy();
    assert.equal(closed, true);
    assert.equal(h.out.filter((o) => o.msg.event !== 'heartbeat').length, 0);
  });

  it('connexions bornees : au-dela de maxConnections / maxConnectionsPerAddress, fermees', async () => {
    const h = await boot({ limits: { maxConnectionsPerAddress: 2 } });
    const socks: Socket[] = [];
    const closed: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const s = await new Promise<Socket>((resolve, reject) => {
        const c = connect(h.port, '127.0.0.1', () => resolve(c));
        c.on('error', reject);
      });
      s.on('error', () => undefined);
      closed.push(false);
      s.once('close', () => (closed[i] = true));
      socks.push(s);
    }
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(closed.filter(Boolean).length, 2, 'les deux dernieres sont fermees');
    assert.equal(h.mod.state() !== null, true);
    for (const s of socks) s.destroy();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await rawRequest(h.port, 'GET', `/iclock/ping?SN=${SERIAL_C}`)).status, 200, 'les connexions liberees permettent de nouveau de servir');
  });

  it('donnees hostiles massives : jamais d\'exception, module toujours servi', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    const junk = [
      'time=2026-10-17 08:00:00\tpin=1\tcardno=2\teventaddr=1\tevent=0\tindex=1\t\t\t\t\t\t',
      '=\t=\t=',
      `${'\t'.repeat(500)}`,
      `time=2026-10-17 08:00:00\tpin=${'<script>'.repeat(50)}\tevent=0\teventaddr=1\tcardno=${'9'.repeat(200)}`,
      'time=2026-10-17 08:00:00\tevent=0\teventaddr=-1',
      'time=2026-10-17 08:00:00\tevent=0\teventaddr=99999999999999999999',
      '\u0000\u0000\u0000',
      '{"json":"inattendu"}',
      'time=2026-10-17 08:00:00\tevent=1e3\teventaddr=1',
    ];
    for (const line of junk) d.recordRaw('rtlog', line);
    const [r] = await d.flush();
    assert.equal(r?.status, 200);
    assert.deepEqual(h.rejected, []);
    assert.equal((await d.ping()).status, 200);
    for (const o of passages(h)) {
      assert.match(o.msg.access?.credential ?? 'ok', /^[A-Za-z0-9._:-]{1,32}$/);
      assert.match(o.msg.access?.holderRef ?? 'ok', /^[A-Za-z0-9._:-]{1,32}$/);
    }
  });

  it('le port n\'est jamais ouvert avant start et se ferme a stop ; double start refuse', async () => {
    const mod = create(baseConfig({ stateDir: tempDir() }));
    assert.equal(mod.addresses().http, null);
    const ctx = { emit: () => true, openMqtt: async () => { throw new Error('x'); }, log: () => undefined, config: {}, now: () => T0 } as unknown as ModuleContext;
    await mod.start(ctx);
    const port = mod.addresses().http;
    assert.ok(port && port > 0);
    await assert.rejects(mod.start(ctx), /deja demarre/);
    await mod.stop();
    assert.equal(mod.addresses().http, null);
    await mod.stop();
    await assert.rejects(rawRequest(port, 'GET', '/iclock/ping'));
  });

  it('port deja occupe : echec clair du demarrage, rien ne reste ouvert', async () => {
    const h = await boot();
    const mod = create(baseConfig({ stateDir: tempDir(), listen: { host: '127.0.0.1', port: h.port } }));
    const ctx = { emit: () => true, openMqtt: async () => { throw new Error('x'); }, log: () => undefined, config: {}, now: () => T0 } as unknown as ModuleContext;
    await assert.rejects(mod.start(ctx), /ecoute impossible sur 127\.0\.0\.1:\d+ \(EADDRINUSE\)/);
    assert.equal(mod.addresses().http, null);
  });

  it('un journal defaillant ou un socle qui leve ne fait pas tomber le module', async () => {
    const mod = create(baseConfig({ stateDir: tempDir() }));
    let calls = 0;
    const ctx = {
      emit: () => {
        calls++;
        throw new Error('disque plein');
      },
      openMqtt: async () => { throw new Error('x'); },
      log: () => {
        throw new Error('journal casse');
      },
      config: {},
      now: () => T0,
    } as unknown as ModuleContext;
    await mod.start(ctx);
    cleanups.push(() => mod.stop());
    const d = new FakeZk({ port: mod.addresses().http as number, serial: SERIAL_C, now: () => T0 });
    d.record({ event: 0, card: CARD, door: 1 });
    const [r] = await d.flush();
    assert.equal(r?.status, 503, 'non acquitte : l\'appareil renverra');
    assert.ok(calls > 0);
    assert.equal((await d.ping()).status, 200);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Divers
// ---------------------------------------------------------------------------------------------------------------------

describe('acces-zkteco : divers', () => {
  it("dossier d'etat : defaut <gateway>/data/acces, relatif resolu depuis gateway/, absolu inchange (sans toucher au disque)", () => {
    assert.equal(resolveStateDir(null), DEFAULT_STATE_DIR);
    assert.match(DEFAULT_STATE_DIR.split(sep).join('/'), /\/gateway\/data\/acces$/);
    assert.equal(resolveStateDir(null, join(tmpdir(), 'gw')), join(tmpdir(), 'gw', 'data', 'acces'));
    assert.equal(resolveStateDir('data/zk', join(tmpdir(), 'gw')), join(tmpdir(), 'gw', 'data', 'zk'));
    const abs = join(tmpdir(), 'etat-absolu');
    assert.equal(resolveStateDir(abs, join(tmpdir(), 'gw')), abs);
  });

  it('deviceTimeText (outil des essais) est l\'inverse de parseDeviceTime', () => {
    for (const off of [0, 60, -300, 330]) {
      const text = deviceTimeText(T0 + 123_000, off);
      assert.equal(parseDeviceTime(text, off), T0 + 123_000);
    }
  });

  it('identifiants de commande uniques d\'un module a l\'autre (redemarrage)', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 2; i++) {
      const h = await boot({}, { t: T0 + i * 5000 });
      const d = h.dev();
      await d.handshake();
      d.commandReply = 'silent';
      const p = (h.handlers.get('ACT-ENTREE') as ActuatorHandler)({ actuatorId: 'ACT-ENTREE', cmdId: 'c', action: 'unlock' });
      await settle();
      ids.push((await d.poll()).commands[0]?.id ?? -1);
      h.clock.t += 31_000;
      h.mod.tick();
      await p;
      await h.stop();
    }
    assert.notEqual(ids[0], ids[1]);
    assert.ok((ids[1] ?? 0) > (ids[0] ?? 0));
  });
});
