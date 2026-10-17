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
import type { AccessSyncHandler, AccessSyncOp } from '../src/modules/acces-commun/sync.ts';
import { HOLIDAYS_FILE, daySegments, deviceName, holidayDate, pinOf, timezoneFields, validityDates, windowBitmaps, zkDate } from '../src/modules/acces-zkteco/sync.ts';
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
import { FAKE_FULL_CODE, FakeZk, deviceTimeText, rawRequest } from './fake-zkteco.ts';

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
  /** Gestionnaires de synchronisation des titulaires enregistres aupres du socle (par controleur). */
  syncHandlers: Map<string, AccessSyncHandler>;
  stateDir: string;
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
async function boot(over: Record<string, unknown> = {}, opts: { actuators?: boolean; sync?: boolean; t?: number } = {}): Promise<Harness> {
  const clock = { t: opts.t ?? T0 };
  const out: Out[] = [];
  const logs: { level: string; text: string }[] = [];
  const rejected: string[] = [];
  const handlers = new Map<string, ActuatorHandler>();
  const syncHandlers = new Map<string, AccessSyncHandler>();
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
    // Comme le vrai socle : `onActuator` est toujours present et LEVE si l'actionneur n'est pas declare dans `actuators`.
    onActuator: (id: string, h: ActuatorHandler) => {
      if (opts.actuators === false) throw new Error(`actionneur « ${id} » non declare dans la section « actuators » de la configuration de la passerelle`);
      handlers.set(id, h);
    },
    ...(opts.sync === false ? {} : { onAccessSync: (id: string, h: AccessSyncHandler) => void syncHandlers.set(id, h) }),
  } as unknown as ModuleContext;
  // Toujours un dossier d'etat temporaire : un essai n'ecrit jamais dans gateway/data.
  const stateDir = typeof over.stateDir === 'string' ? over.stateDir : tempDir();
  const mod = create(baseConfig({ ...over, stateDir }));
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
    syncHandlers,
    stateDir,
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
    for (const n of [0, 1, 2, 3, 14, 202, 208]) assert.equal(eff(n).kind, 'granted', String(n));
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
    for (const n of [26, 32, 206, 220, 221, 11]) assert.equal(eff(n).kind, 'ignore', String(n));
    // Mode de porte (F19) : ouverture continue et retour au mode normal ne sont plus « rien », et ne sont jamais un passage.
    assert.deepEqual(eff(205), { kind: 'mode', mode: 'always_open' });
    for (const n of [9, 10, 204]) assert.deepEqual(eff(n), { kind: 'mode', mode: 'normal' }, String(n));
    for (const n of Object.keys(RTLOG_EVENTS).map(Number)) {
      const e = eff(n);
      if (e.kind === 'mode') assert.notEqual(e.mode, 'always_closed', `aucun evenement connu ne dit « toujours fermee » (${n})`);
    }
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
    for (const ev of [206, 26, 220, 11, 206]) await d.push({ event: ev, door: 1 });
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
    // Le socle leve (actionneur non declare) : `registerActuator` journalise la cause, une seule fois par actionneur.
    assert.equal(h.logs.filter((l) => l.level === 'warn' && /ouverture a distance indisponible/.test(l.text)).length, 2, allLogs(h));
    assert.ok(h.logs.every((l) => !/n'a pas de canal de commande/.test(l.text)), 'plus de journal redondant');
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
// Epoque du controleur (controleur remplace)
// ---------------------------------------------------------------------------------------------------------------------

describe('acces-zkteco : epoque du controleur', () => {
  const withEpoch = (epoch: unknown, extra: Record<string, unknown> = {}) => baseConfig({ controllers: [{ ...controllerCfg, epoch }, { ...terminalCfg, ...extra }] });
  const withTerminalEpoch = (epoch: number) => baseConfig({ controllers: [controllerCfg, { ...terminalCfg, epoch }] });

  it('configuration : entier >= 0, defaut 0, validation stricte (aucune correction silencieuse)', () => {
    assert.equal(parseConfig(baseConfig()).controllers[0]?.epoch, 0);
    assert.equal(parseConfig(withEpoch(0)).controllers[0]?.epoch, 0);
    assert.equal(parseConfig(withEpoch(7)).controllers[0]?.epoch, 7);
    assert.equal(parseConfig(withEpoch(999_999_999_999)).controllers[0]?.epoch, 999_999_999_999);
    assert.equal(parseConfig(withEpoch(undefined)).controllers[0]?.epoch, 0);
    for (const bad of [-1, 1.5, '2', '', null, true, false, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_000_000, [1], {}]) {
      assert.throws(() => parseConfig(withEpoch(bad)), /epoch/, String(bad));
    }
    assert.throws(() => parseConfig(withEpoch(-5)), /controllers\[0\]\.epoch doit etre un entier de 0 a 999999999999/);
  });

  it('epoque 0 : identifiants inchanges (n° d\'enregistrement tel quel) et curseur sous l\'identifiant du controleur', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    await d.push({ event: 0, card: CARD, door: 1, index: 41 });
    await d.push({ event: 102, door: 2, index: 42 });
    assert.equal(passages(h)[0]?.msg.msgId, 'acc:CTL-2:41');
    assert.equal(passages(h)[0]?.msg.access?.eventId, '41');
    assert.ok(events(h, 'door_forced')[0]?.msg.msgId?.endsWith('-42'));
    await h.stop();
    const saved = JSON.parse(readFileSync(join(h.stateDir, 'acces-curseurs.json'), 'utf8')) as { controllers: Record<string, { cursor: string }> };
    assert.deepEqual(Object.keys(saved.controllers), ['CTL-2']);
  });

  it('epoque 3 : eventId "<epoque>.<n°>" pour les passages, les identifiants synthetiques, les etats et la contrainte', async () => {
    const h = await boot({ controllers: [{ ...controllerCfg, epoch: 3 }, terminalCfg] });
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    await d.push({ event: 0, card: CARD, door: 1, index: 41 });
    assert.equal(passages(h)[0]?.msg.access?.eventId, '3.41');
    assert.equal(passages(h)[0]?.msg.msgId, 'acc:CTL-2:3.41');
    await d.push({ event: 0, card: CARD, door: 1, index: null, at: T0 + 1000 });
    assert.match(String(passages(h)[1]?.msg.access?.eventId), /^3\.\d{10}-[0-9a-f]{10}$/);
    await d.push({ event: 102, door: 2, index: 42 });
    assert.ok(events(h, 'door_forced')[0]?.msg.msgId?.endsWith('-3.42'), String(events(h, 'door_forced')[0]?.msg.msgId));
    await d.push({ event: 101, door: 1, pin: PIN, verify: 3, index: 43, at: T0 + 2000 });
    assert.equal(passages(h)[2]?.msg.access?.eventId, '3.43');
    assert.equal(events(h, 'panic')[0]?.msg.msgId, `acc:CTL-2:duress-1-${T0 + 2000}-3.43`);
    assert.deepEqual(h.rejected, []);
  });

  it('epoque d\'un terminal : l\'identifiant synthetique des pointages porte l\'epoque', async () => {
    const h = await boot(withTerminalEpoch(2));
    const t = h.dev(SERIAL_T, 'terminal');
    await t.handshake();
    h.out.length = 0;
    t.recordAttlog({ pin: '2001', status: 0, verify: 1 });
    await t.flush();
    assert.match(String(passages(h)[0]?.msg.access?.eventId), /^2\.\d{10}-[0-9a-f]{10}$/);
    assert.deepEqual(h.rejected, []);
  });

  it('changement d\'epoque : le curseur repart de zero, aucune collision de msgId avec l\'ancienne epoque', async () => {
    const dir = tempDir();
    const h1 = await boot({ stateDir: dir });
    const d1 = h1.dev();
    await d1.handshake();
    await d1.push({ event: 0, card: CARD, door: 1, index: 1 });
    await d1.push({ event: 0, card: CARD, door: 1, index: 2, at: T0 + 1000 });
    await d1.push({ event: 102, door: 1, index: 3, at: T0 + 2000 });
    const oldIds = h1.out.map((o) => o.msg.msgId);
    await h1.stop();

    // Le controleur est remplace : memoire effacee, numeros d'enregistrement repartis de 1, epoque 1.
    const h2 = await boot({ stateDir: dir, controllers: [{ ...controllerCfg, epoch: 1 }, terminalCfg] });
    const d2 = h2.dev();
    const hs = await d2.handshake();
    assert.equal(hs.options.get('ATTLOGStamp'), 'None', "la poignee de main ne reprend pas l'estampille de l'ancienne epoque");
    assert.equal(hs.options.get('Stamp'), undefined);
    await d2.push({ event: 0, card: CARD, door: 1, index: 1 });
    await d2.push({ event: 0, card: CARD, door: 1, index: 2, at: T0 + 1000 });
    await d2.push({ event: 102, door: 1, index: 3, at: T0 + 2000 });
    const newIds = h2.out.map((o) => o.msg.msgId).filter((m) => m?.startsWith('acc:'));
    assert.equal(passages(h2).length, 2, 'les nouveaux enregistrements n°1 et n°2 ne sont pas pris pour des doublons');
    assert.deepEqual(passages(h2).map((o) => o.msg.access?.eventId), ['1.1', '1.2']);
    assert.equal(new Set([...oldIds.filter((m) => m?.startsWith('acc:')), ...newIds]).size, oldIds.filter((m) => m?.startsWith('acc:')).length + newIds.length, 'aucun msgId commun aux deux epoques');
    await h2.stop();
    const saved = JSON.parse(readFileSync(join(dir, 'acces-curseurs.json'), 'utf8')) as { controllers: Record<string, { cursor: string }> };
    assert.deepEqual(Object.keys(saved.controllers).sort(), ['CTL-2', 'CTL-2~e1']);
    assert.equal(saved.controllers['CTL-2']?.cursor, '3');
    assert.equal(saved.controllers['CTL-2~e1']?.cursor, '3');

    // Retour a l'epoque 0 (erreur de saisie corrigee) : le curseur de l'epoque 0 est intact.
    const h3 = await boot({ stateDir: dir });
    assert.equal((await h3.dev().handshake()).options.get('ATTLOGStamp'), '3');
  });

  it('deux epoques successives dans un meme dossier : chacune a son curseur', async () => {
    const dir = tempDir();
    for (const epoch of [0, 1, 2]) {
      const h = await boot({ stateDir: dir, controllers: [{ ...controllerCfg, epoch }, terminalCfg] });
      const d = h.dev();
      assert.equal((await d.handshake()).options.get('ATTLOGStamp'), 'None', `epoque ${epoch}`);
      await d.push({ event: 0, card: CARD, door: 1, index: 1 });
      assert.equal(passages(h).length, 1, `epoque ${epoch}`);
      await h.stop();
    }
    const saved = JSON.parse(readFileSync(join(dir, 'acces-curseurs.json'), 'utf8')) as { controllers: Record<string, unknown> };
    assert.deepEqual(Object.keys(saved.controllers).sort(), ['CTL-2', 'CTL-2~e1', 'CTL-2~e2']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Mode de porte (F19)
// ---------------------------------------------------------------------------------------------------------------------

describe('acces-zkteco : mode de porte (F19)', () => {
  const modes = (h: Harness) => events(h, 'door_mode').map((o) => `${o.id}:${o.msg.doorMode}`);

  it('rien n\'est invente a la connexion : ni a la poignee de main, ni par rtstate', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    await d.sendRtstate('11');
    await d.sendRtstate('21', { alarm: '0100' });
    assert.deepEqual(modes(h), []);
    assert.equal(h.mod.state().controllers['CTL-2']?.doors[0]?.mode, null, 'mode inconnu');
  });

  it('ouverture permanente a distance (205) puis retour au mode normal (204, 10, 9) : un message par changement, jamais un passage', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    await d.push({ event: 205, door: 1, index: 10 });
    assert.deepEqual(modes(h), ['P-ENTREE:always_open']);
    assert.equal(passages(h).length, 0, '205 n\'est plus un passage');
    assert.equal(h.mod.state().controllers['CTL-2']?.doors[0]?.mode, 'always_open');
    assert.equal(h.mod.state().controllers['CTL-2']?.doors[1]?.mode, null, 'l\'autre porte n\'est pas touchee');
    await d.push({ event: 204, door: 1, index: 11, at: T0 + 1000 });
    assert.deepEqual(modes(h), ['P-ENTREE:always_open', 'P-ENTREE:normal']);
    // un mode identique n'est pas re-emis
    await d.push({ event: 204, door: 1, index: 12, at: T0 + 2000 });
    await d.push({ event: 10, door: 1, index: 13, at: T0 + 3000 });
    await d.push({ event: 9, door: 1, index: 14, at: T0 + 4000 });
    assert.equal(modes(h).length, 2);
    await d.push({ event: 205, door: 2, index: 15, at: T0 + 5000 });
    await d.push({ event: 9, door: 2, index: 16, at: T0 + 6000 });
    assert.deepEqual(modes(h), ['P-ENTREE:always_open', 'P-ENTREE:normal', 'P-ARRIERE:always_open', 'P-ARRIERE:normal']);
    assert.deepEqual(h.rejected, []);
    assert.equal(d.unacked, 0);
    const msg = events(h, 'door_mode')[0]?.msg as unknown as { doorMode: string; msgId: string; ts: number };
    assert.match(msg.msgId, /^acc:CTL-2:mode-1-\d+-always_open$/);
  });

  it('« plage reactivee » (11) ne dit pas le mode : rien n\'est emis ; « toujours fermee » n\'est jamais emis', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    await d.push({ event: 11, door: 1, index: 20 });
    assert.deepEqual(modes(h), []);
    for (const n of [0, 1, 2, 5, 8, 28, 100, 102, 200, 201, 202, 206]) await d.push({ event: n, door: 1, index: 100 + n, card: CARD, at: T0 + n });
    assert.ok(!modes(h).some((m) => m.endsWith('always_closed')));
    assert.deepEqual(modes(h), []);
  });

  it('enregistrement ancien (recupere apres une coupure) : l\'histoire n\'est pas le mode courant, rien n\'est emis', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    await d.push({ event: 205, door: 1, index: 30, at: T0 - 10 * 60_000 });
    assert.deepEqual(modes(h), []);
    assert.equal(d.unacked, 0, 'acquitte quand meme');
    await d.push({ event: 205, door: 1, index: 31, at: T0 - 100_000 });
    assert.deepEqual(modes(h), ['P-ENTREE:always_open'], 'sous le seuil de differe (120 s) : mode courant');
  });

  it('porte non declaree : ignore sans bloquer l\'appareil', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    await d.push({ event: 205, door: 4, index: 40 });
    await d.push({ event: 204, door: 3, index: 41 });
    assert.deepEqual(modes(h), []);
    assert.equal(d.unacked, 0);
  });

  it('le socle refuse le message : l\'appareil n\'a rien a renvoyer, le superviseur retente seul', async () => {
    const h = await boot();
    const d = h.dev();
    await d.handshake();
    h.out.length = 0;
    h.accept.value = false;
    await d.push({ event: 205, door: 1, index: 50 });
    assert.equal(d.unacked, 0);
    assert.deepEqual(modes(h), []);
    h.accept.value = true;
    h.clock.t += 2000;
    h.mod.tick();
    assert.deepEqual(modes(h), ['P-ENTREE:always_open']);
  });

  it('terminal : un rtlog envoye par un terminal est acquitte sans effet (pas de mode de porte)', async () => {
    const h = await boot();
    const t = h.dev(SERIAL_T, 'terminal');
    await t.handshake();
    h.out.length = 0;
    // un terminal n'envoie pas de rtlog : l'enregistrement est acquitte sans effet
    t.recordRaw('rtlog', t.rtlogLine({ event: 205, door: 1, index: 1 }));
    await t.flush();
    assert.deepEqual(modes(h), []);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Synchronisation des titulaires : formats
// ---------------------------------------------------------------------------------------------------------------------

describe('acces-zkteco : synchronisation, formats', () => {
  const week = (from: string, to: string, days = [1, 2, 3, 4, 5]) => [{ days, from, to }];
  const field = (fields: Array<[string, number]>, name: string): number => (fields.find(([k]) => k === name) as [string, number])[1];
  const code = (fromHhmm: number, toHhmm: number): number => fromHhmm * 65536 + toHhmm;

  it('pinOf : H + 1 a 9 chiffres sans zero de tete ; le reste n\'est pas convertible', () => {
    assert.equal(pinOf('H101'), '101');
    assert.equal(pinOf('H1'), '1');
    assert.equal(pinOf('H123456789'), '123456789');
    for (const bad of ['H0', 'H007', 'H1234567890', 'Habc', 'H12a', 'H', '101', 'h101', 'H-1', 'H1 ', 'H1\n', 'S1', '']) assert.equal(pinOf(bad), null, JSON.stringify(bad));
  });

  it('zkDate : heure locale de l\'appareil, texte AAAAMMJJ, hors 2001-2099 = null', () => {
    assert.equal(zkDate(T0, 0), '20261017');
    assert.equal(zkDate(Date.UTC(2026, 9, 17, 23, 30), 60), '20261018', 'minuit passe en heure locale');
    assert.equal(zkDate(Date.UTC(2026, 9, 17, 0, 30), -60), '20261016');
    assert.equal(zkDate(Date.UTC(2000, 11, 31), 0), null);
    assert.equal(zkDate(Date.UTC(2100, 0, 1), 0), null);
    assert.equal(zkDate(Date.UTC(2099, 11, 31), 0), '20991231');
    assert.equal(holidayDate('2026-12-25'), '20261225');
    assert.equal(holidayDate('2000-01-01'), null);
    assert.equal(holidayDate('2100-01-01'), null);
  });

  it('validityDates : sans limite = 0, bornes hors plage ramenees sans jamais ouvrir plus', () => {
    assert.deepEqual(validityDates(null, null, 0), { start: '0', end: '0' });
    assert.deepEqual(validityDates(T0, T0 + 3_600_000, 0), { start: '20261017', end: '20261017' });
    assert.deepEqual(validityDates(Date.UTC(1999, 0, 1), null, 0), { start: '0', end: '0' }, 'debut avant 2001 : sans borne utile');
    assert.deepEqual(validityDates(Date.UTC(2150, 0, 1), null, 0), { start: '20991231', end: '0' }, 'debut apres 2099 : jamais valide dans la plage');
    assert.deepEqual(validityDates(null, Date.UTC(1999, 0, 1), 0), { start: '0', end: '20010101' }, 'fin avant 2001 : deja echue');
    assert.deepEqual(validityDates(null, Date.UTC(2150, 0, 1), 0), { start: '0', end: '0' }, 'fin apres 2099 : sans limite');
  });

  it('fuseau : segments (heure*100+minute) du debut << 16 + fin ; la fin est la derniere minute accordee ; 0 = inutilise', () => {
    const f = timezoneFields(2, week('08:00', '18:00'), true);
    assert.equal(f[0]?.[0], 'TimezoneId');
    assert.equal(field(f, 'TimezoneId'), 2);
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) assert.equal(field(f, `${day}Time1`), code(800, 1759), day);
    for (const day of ['Sun', 'Sat']) assert.equal(field(f, `${day}Time1`), 0, day);
    for (const day of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      assert.equal(field(f, `${day}Time2`), 0);
      assert.equal(field(f, `${day}Time3`), 0);
    }
    assert.equal(f.length, 1 + 7 * 3 + 3 * 3, '36 segments + identifiant');
    for (let i = 1; i <= 3; i++) for (const t of [1, 2, 3]) assert.equal(field(f, `Hol${t}Time${i}`), 0, 'ferme les jours feries');
  });

  it('fuseau : plage qui passe minuit (deborde sur le jour suivant), plusieurs plages, journee entiere', () => {
    const night = timezoneFields(3, [{ days: [5], from: '22:00', to: '06:00' }], true);
    assert.equal(field(night, 'FriTime1'), code(2200, 2359));
    assert.equal(field(night, 'SatTime1'), code(0, 559));
    assert.equal(field(night, 'SunTime1'), 0);
    const sat = timezoneFields(3, [{ days: [6], from: '22:00', to: '06:00' }], true);
    assert.equal(field(sat, 'SunTime1'), code(0, 559), 'samedi soir deborde sur dimanche (6 + 1 modulo 7)');
    const multi = timezoneFields(4, [{ days: [1], from: '07:30', to: '12:00' }, { days: [1], from: '13:30', to: '17:15' }, { days: [1], from: '20:00', to: '21:00' }], true);
    assert.equal(field(multi, 'MonTime1'), code(730, 1159));
    assert.equal(field(multi, 'MonTime2'), code(1330, 1714));
    assert.equal(field(multi, 'MonTime3'), code(2000, 2059));
    const adjacent = timezoneFields(4, [{ days: [2], from: '08:00', to: '12:00' }, { days: [2], from: '12:00', to: '16:00' }], true);
    assert.equal(field(adjacent, 'TueTime1'), code(800, 1559), 'plages contigues fusionnees');
    assert.equal(field(adjacent, 'TueTime2'), 0);
    const full = timezoneFields(4, [{ days: [3], from: '00:00', to: '23:59' }], true);
    assert.equal(field(full, 'WedTime1'), code(0, 2358));
    const lone = timezoneFields(4, [{ days: [3], from: '00:00', to: '00:01' }], true);
    assert.equal(field(lone, 'WedTime1'), 1, 'jamais 0 (segment inutilise)');
  });

  it('fuseau : plus de trois plages dans un jour = not_supported (jamais tronque en silence)', () => {
    const four = [{ days: [1], from: '01:00', to: '02:00' }, { days: [1], from: '03:00', to: '04:00' }, { days: [1], from: '05:00', to: '06:00' }, { days: [1], from: '07:00', to: '08:00' }];
    assert.throws(() => timezoneFields(2, four, true), (e: unknown) => (e as { code?: string }).code === 'not_supported');
    assert.doesNotThrow(() => timezoneFields(2, four.slice(0, 3), true));
  });

  it('jours feries : fermes si `holidays`, sinon la plage COMMUNE aux sept jours (jamais plus large que l\'horaire)', () => {
    const closed = timezoneFields(2, week('08:00', '18:00', [0, 1, 2, 3, 4, 5, 6]), true);
    assert.equal(field(closed, 'Hol1Time1'), 0);
    const open = timezoneFields(2, week('08:00', '18:00', [0, 1, 2, 3, 4, 5, 6]), false);
    assert.equal(field(open, 'Hol1Time1'), code(800, 1759));
    const workdays = timezoneFields(2, week('08:00', '18:00'), false);
    assert.equal(field(workdays, 'Hol1Time1'), 0, 'pas ouvert le week-end : aucune plage commune, donc ferme');
    const mixed = timezoneFields(2, [{ days: [0, 1, 2, 3, 4, 5, 6], from: '09:00', to: '12:00' }, { days: [1, 2, 3, 4, 5], from: '14:00', to: '18:00' }], false);
    assert.equal(field(mixed, 'Hol1Time1'), code(900, 1159));
    assert.equal(field(mixed, 'Hol1Time2'), 0);
    for (const t of [2, 3]) for (let i = 1; i <= 3; i++) assert.equal(field(mixed, `Hol${t}Time${i}`), 0);
  });

  it('daySegments et windowBitmaps : bornes', () => {
    const days = windowBitmaps([]);
    assert.equal(days.length, 7);
    assert.deepEqual(daySegments(days[0] as Uint8Array), [0, 0, 0]);
  });

  it('deviceName : sans tabulation ni saut de ligne, au plus 24 octets UTF-8, jamais coupe au milieu d\'un caractere', () => {
    assert.equal(deviceName('KONAN Yao'), 'KONAN Yao');
    assert.equal(deviceName(`A\tB\r\nC${String.fromCharCode(0)}D`), 'A B C D');
    assert.equal(deviceName('   '), '');
    const long = deviceName('Jean-Baptiste Kouassi-Konan Amoakon');
    assert.ok(Buffer.byteLength(long, 'utf8') <= 24, long);
    const accents = deviceName('é'.repeat(30));
    assert.equal(Buffer.byteLength(accents, 'utf8'), 24);
    assert.ok(!accents.includes(String.fromCharCode(0xfffd)));
    assert.ok(!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(deviceName(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x85)}c`)));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Synchronisation des titulaires : essais contre le faux appareil
// ---------------------------------------------------------------------------------------------------------------------

describe('acces-zkteco : synchronisation des titulaires', () => {
  let opSeq = 0;
  const syncOp = (body: Record<string, unknown>): AccessSyncOp => ({ opId: `op${++opSeq}`, seq: opSeq, ...body }) as unknown as AccessSyncOp;
  const handlerOf = (h: Harness, id = 'CTL-2'): AccessSyncHandler => h.syncHandlers.get(id) as AccessSyncHandler;

  /** Fait tourner l'appareil (interrogations successives) jusqu'a ce que l'operation soit terminee : aucune attente reelle. */
  async function drive<T>(d: FakeZk, p: Promise<T>): Promise<T> {
    let done = false;
    void p.then(
      () => (done = true),
      () => (done = true),
    );
    for (let i = 0; i < 400 && !done; i++) {
      await settle();
      await d.poll();
      await settle();
    }
    assert.ok(done, 'operation jamais terminee');
    return p;
  }
  const run = (h: Harness, d: FakeZk, body: Record<string, unknown>, id = 'CTL-2') => drive(d, handlerOf(h, id)(syncOp(body)));

  const holderBody = (over: Record<string, unknown> = {}) => ({
    type: 'upsert_holder',
    holderRef: 'H101',
    name: 'KONAN Yao',
    active: true,
    validFrom: null,
    validTo: null,
    credentials: [CARD],
    doors: [{ doorNo: 1, scheduleRef: null }],
    ...over,
  });
  const scheduleBody = (ref = 'S1', over: Record<string, unknown> = {}) => ({
    type: 'upsert_schedule',
    scheduleRef: ref,
    windows: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }],
    holidays: true,
    ...over,
  });

  async function world(over: Record<string, unknown> = {}, opts: { actuators?: boolean; sync?: boolean; t?: number } = {}) {
    const h = await boot(over, opts);
    const d = h.dev();
    await d.handshake();
    return { h, d };
  }

  const snapshot = (d: FakeZk): string =>
    JSON.stringify({ u: [...d.users], a: [...d.authorizations], t: [...d.timezones], h: [...d.holidays] });
  const authOf = (d: FakeZk, pin: string) => [...d.authorizations.values()].filter((a) => a.pin === pin).map((a) => `${a.timezone}:${a.doors}`).sort();
  const commandTexts = (d: FakeZk) => d.received.map((c) => c.text);

  it('enregistrement : une centrale recoit son gestionnaire, un terminal repond toujours « non pris en charge »', async () => {
    const { h, d } = await world();
    assert.deepEqual([...h.syncHandlers.keys()].sort(), ['CTL-2', 'TERM-1']);
    const t = h.dev(SERIAL_T, 'terminal');
    await t.handshake();
    for (const body of [holderBody(), scheduleBody(), { type: 'delete_holder', holderRef: 'H101' }, { type: 'set_holidays', dates: ['2026-12-25'], replace: false }]) {
      assert.deepEqual(await handlerOf(h, 'TERM-1')(syncOp(body)), { result: 'refused', code: 'not_supported' }, String(body.type));
    }
    assert.equal(t.received.length, 0, 'rien n\'est envoye a un terminal');
    assert.equal(d.received.length, 0);
  });

  it('socle sans canal de synchronisation : le module journalise et continue (passages et ouvertures normaux)', async () => {
    const h = await boot({}, { sync: false });
    assert.equal(h.syncHandlers.size, 0);
    assert.ok(h.logs.some((l) => l.level === 'info' && /canal de synchronisation des titulaires/.test(l.text)), allLogs(h));
    const d = h.dev();
    await d.handshake();
    await d.push({ event: 0, card: CARD, door: 1 });
    assert.equal(passages(h).length, 1);
  });

  it('socle dont onAccessSync leve : avertissement, le module demarre quand meme', async () => {
    const dir = tempDir();
    const out: unknown[] = [];
    const logs: string[] = [];
    const ctx = {
      emit: (_id: string, m: unknown) => (out.push(m), true),
      log: (_l: string, t: string) => logs.push(t),
      now: () => T0,
      onActuator: () => undefined,
      onAccessSync: () => {
        throw new Error('controleur non declare pour cette passerelle');
      },
    } as unknown as ModuleContext;
    const mod = create(baseConfig({ stateDir: dir }));
    await mod.start(ctx);
    cleanups.push(() => mod.stop());
    assert.ok(logs.some((l) => /synchronisation des titulaires non enregistree.*controleur non declare/.test(l)), logs.join('\n'));
    assert.ok(mod.addresses().http !== null);
  });

  it('horaire : numero de fuseau libre attribue (2), ecrit dans l\'appareil, rejeu identique, plages persistees', async () => {
    const { h, d } = await world();
    assert.deepEqual(await run(h, d, scheduleBody('S1')), { result: 'done' });
    assert.equal(d.timezones.get(2)?.MonTime1, String(800 * 65536 + 1759));
    assert.equal(d.timezones.get(2)?.SunTime1, '0');
    assert.equal(d.timezones.get(2)?.Hol1Time1, '0');
    const first = snapshot(d);
    assert.deepEqual(await run(h, d, scheduleBody('S1')), { result: 'done' });
    assert.equal(snapshot(d), first, 'rejouer = meme etat final');
    assert.equal([...d.timezones.keys()].filter((k) => k !== 1).length, 1, 'meme numero de fuseau');
    assert.deepEqual(await run(h, d, scheduleBody('S2', { windows: [{ days: [6], from: '09:00', to: '12:00' }] })), { result: 'done' });
    assert.equal(d.timezones.get(3)?.SatTime1, String(900 * 65536 + 1159));
    assert.equal(d.timezones.get(1)?.preset, '1', 'le fuseau « toujours » n\'est jamais reecrit');
    h.clock.t += 2000;
    h.mod.tick();
    const plages = JSON.parse(readFileSync(join(h.stateDir, 'acces-plages.json'), 'utf8')) as { controllers: Record<string, Record<string, number>> };
    assert.deepEqual(plages.controllers['CTL-2'], { S1: 2, S2: 3 });
  });

  it('horaire : suppression = fuseau vide (jamais d\'acces), numero libere et reutilise ; absent = succes sans commande', async () => {
    const { h, d } = await world();
    await run(h, d, scheduleBody('S1'));
    await run(h, d, scheduleBody('S2'));
    assert.deepEqual(await run(h, d, { type: 'delete_schedule', scheduleRef: 'S1' }), { result: 'done' });
    assert.ok(Object.entries(d.timezones.get(2) ?? {}).filter(([k]) => /Time\d$/.test(k)).every(([, v]) => v === '0'), 'fuseau 2 vide');
    const before = d.received.length;
    assert.deepEqual(await run(h, d, { type: 'delete_schedule', scheduleRef: 'S1' }), { result: 'done' });
    assert.deepEqual(await run(h, d, { type: 'delete_schedule', scheduleRef: 'S9' }), { result: 'done' });
    assert.equal(d.received.length, before, 'rien d\'envoye pour un horaire inconnu');
    await run(h, d, scheduleBody('S3'));
    assert.equal(d.timezones.get(2)?.MonTime1, String(800 * 65536 + 1759), 'S3 reprend le numero 2');
  });

  it('horaire : plus de fuseau libre = refused / full SANS appeler l\'appareil ; echec de l\'appareil = aucune attribution fantome', async () => {
    const { h, d } = await world({ timezones: { min: 2, max: 3 } });
    await run(h, d, scheduleBody('S1'));
    await run(h, d, scheduleBody('S2'));
    const before = d.received.length;
    assert.deepEqual(await run(h, d, scheduleBody('S3')), { result: 'refused', code: 'full' });
    assert.equal(d.received.length, before, 'aucune commande envoyee');
    // un echec de l'appareil ne garde pas le numero
    await run(h, d, { type: 'delete_schedule', scheduleRef: 'S2' });
    d.dataOverride = (c) => (c.table === 'timezone' ? -5 : undefined);
    assert.deepEqual(await run(h, d, scheduleBody('S3')), { result: 'error', code: 'io' });
    d.dataOverride = null;
    assert.deepEqual(await run(h, d, scheduleBody('S4')), { result: 'done' });
    assert.ok(d.timezones.has(3), 'S4 a pris le numero 3, libre malgre l\'echec de S3');
    // S3 n'existe pas : un titulaire qui la cite est refuse
    assert.deepEqual(await run(h, d, holderBody({ doors: [{ doorNo: 1, scheduleRef: 'S3' }] })), { result: 'refused', code: 'invalid' });
  });

  it('horaire : plus de trois plages par jour = refused / not_supported, rien d\'ecrit, numero non garde', async () => {
    const { h, d } = await world();
    const windows = [1, 2, 3, 4].map((i) => ({ days: [1], from: `0${i}:00`, to: `0${i}:30` }));
    assert.deepEqual(await run(h, d, scheduleBody('S1', { windows })), { result: 'refused', code: 'not_supported' });
    assert.equal(d.received.length, 0);
    await run(h, d, scheduleBody('S2'));
    assert.ok(d.timezones.has(2), 'numero 2 toujours libre');
  });

  it('titulaire : utilisateur, badge, validite, droits par fuseau ; jamais de mot de passe ; commandes bien formees', async () => {
    const { h, d } = await world();
    await run(h, d, scheduleBody('S1'));
    const out = await run(h, d, holderBody({ doors: [{ doorNo: 1, scheduleRef: 'S1' }, { doorNo: 2, scheduleRef: null }] }));
    assert.deepEqual(out, { result: 'done' });
    assert.deepEqual(d.users.get('101'), { CardNo: CARD, Pin: '101', StartTime: '0', EndTime: '0', Name: 'KONAN Yao', Privilege: '0' });
    assert.deepEqual(authOf(d, '101'), ['1:2', '2:1'], 'porte 2 sans horaire = fuseau « toujours » (1), porte 1 = fuseau 2');
    const texts = commandTexts(d);
    const userCmd = texts.find((t) => t.includes('DATA UPDATE user')) as string;
    assert.equal(userCmd, `DATA UPDATE user CardNo=${CARD}\tPin=101\tStartTime=0\tEndTime=0\tName=KONAN Yao\tPrivilege=0`);
    assert.deepEqual(d.forbiddenSeen, []);
    assert.ok(texts.every((t) => !/password|passwd|template|photo|biodata|fingerprint|face/i.test(t)));
    assert.ok(texts.every((t) => /^(DATA (UPDATE|DELETE) [a-z]+ \S|CONTROL DEVICE)/.test(t) && !/[\r\n]/.test(t)));
    // meme horaire sur deux portes : une seule autorisation (masque 3)
    await run(h, d, holderBody({ holderRef: 'H102', credentials: [], doors: [{ doorNo: 1, scheduleRef: 'S1' }, { doorNo: 2, scheduleRef: 'S1' }] }));
    assert.deepEqual(authOf(d, '102'), ['2:3']);
    assert.equal(d.users.get('102')?.CardNo, '', 'sans badge : champ vide');
  });

  it('titulaire : rejouer = meme etat final ; changer d\'horaire retire les anciens droits (pas de superposition)', async () => {
    const { h, d } = await world();
    await run(h, d, scheduleBody('S1'));
    await run(h, d, holderBody({ doors: [{ doorNo: 1, scheduleRef: 'S1' }] }));
    const first = snapshot(d);
    await run(h, d, holderBody({ doors: [{ doorNo: 1, scheduleRef: 'S1' }] }));
    assert.equal(snapshot(d), first);
    assert.deepEqual(authOf(d, '101'), ['2:1']);
    await run(h, d, holderBody({ doors: [{ doorNo: 1, scheduleRef: null }] }));
    assert.deepEqual(authOf(d, '101'), ['1:1'], 'seul le nouveau droit reste');
    await run(h, d, holderBody({ doors: [] }));
    assert.deepEqual(authOf(d, '101'), [], 'plus aucune porte');
    assert.ok(d.users.has('101'), 'l\'utilisateur reste');
  });

  it('titulaire : horaire inconnu = refused / invalid, reference ou badge inutilisable = refused / invalid, 2e badge = not_supported ; rien d\'envoye', async () => {
    const { h, d } = await world();
    const cases: Array<[Record<string, unknown>, { result: string; code: string }]> = [
      [holderBody({ doors: [{ doorNo: 1, scheduleRef: 'S5' }] }), { result: 'refused', code: 'invalid' }],
      [holderBody({ holderRef: 'Habc' }), { result: 'refused', code: 'invalid' }],
      [holderBody({ holderRef: 'H0' }), { result: 'refused', code: 'invalid' }],
      [holderBody({ holderRef: 'H007' }), { result: 'refused', code: 'invalid' }],
      [holderBody({ holderRef: 'H1234567890' }), { result: 'refused', code: 'invalid' }],
      [holderBody({ credentials: ['AB12CD'] }), { result: 'refused', code: 'invalid' }],
      [holderBody({ credentials: ['0'] }), { result: 'refused', code: 'invalid' }],
      [holderBody({ credentials: ['0000'] }), { result: 'refused', code: 'invalid' }],
      [holderBody({ credentials: ['12345678901'] }), { result: 'refused', code: 'invalid' }],
      [holderBody({ credentials: ['4294967296'] }), { result: 'refused', code: 'invalid' }],
      [holderBody({ credentials: ['111', '222'] }), { result: 'refused', code: 'not_supported' }],
      [holderBody({ credentials: ['111', '222', '333', '444'] }), { result: 'refused', code: 'not_supported' }],
    ];
    for (const [body, expected] of cases) assert.deepEqual(await handlerOf(h)(syncOp(body)), expected, JSON.stringify(body));
    assert.equal(d.received.length, 0, 'aucune commande');
    assert.equal(d.users.size, 0);
    // le plus grand badge et le plus long Pin passent
    assert.deepEqual(await run(h, d, holderBody({ holderRef: 'H123456789', credentials: ['4294967295'] })), { result: 'done' });
  });

  it('donnees hostiles : champ interdit (PIN, mot de passe, gabarit, photo), champ inconnu ou type faux = refused / invalid, rien d\'envoye', async () => {
    const { h, d } = await world();
    const bad: Array<Record<string, unknown>> = [
      holderBody({ pin: '1234' }),
      holderBody({ password: 'x' }),
      holderBody({ Password: 'x' }),
      holderBody({ template: 'AAAA' }),
      holderBody({ photo: 'AAAA' }),
      holderBody({ extra: 1 }),
      holderBody({ active: 'oui' }),
      holderBody({ name: '' }),
      holderBody({ credentials: 'x' }),
      { type: 'format_all' },
      { type: 'upsert_holder' },
    ];
    for (const body of bad) assert.deepEqual(await handlerOf(h)(syncOp(body)), { result: 'refused', code: 'invalid' }, JSON.stringify(body));
    assert.equal(d.received.length, 0);
  });

  it('titulaire inactif : acces suspendu (droits retires), utilisateur conserve ; reactive : droits restaures', async () => {
    const { h, d } = await world();
    await run(h, d, scheduleBody('S1'));
    const doors = [{ doorNo: 1, scheduleRef: 'S1' }, { doorNo: 2, scheduleRef: null }];
    await run(h, d, holderBody({ doors }));
    assert.deepEqual(authOf(d, '101'), ['1:2', '2:1']);
    await run(h, d, holderBody({ doors, active: false }));
    assert.deepEqual(authOf(d, '101'), [], 'aucun droit');
    assert.equal(d.users.get('101')?.CardNo, CARD, 'jamais de suppression implicite');
    await run(h, d, holderBody({ doors, active: true }));
    assert.deepEqual(authOf(d, '101'), ['1:2', '2:1']);
  });

  it('titulaire inactif : les droits sont retires AVANT la mise a jour de l\'utilisateur (jamais d\'acces en trop si la suite echoue)', async () => {
    const { h, d } = await world();
    await run(h, d, holderBody());
    d.dataOverride = (c) => (c.table === 'user' ? -5 : undefined);
    assert.deepEqual(await run(h, d, holderBody({ active: false })), { result: 'error', code: 'io' });
    assert.deepEqual(authOf(d, '101'), [], 'acces deja retire');
  });

  it('titulaire echu : droits retires et date de fin ecrite ; pas encore valide : date de debut ecrite, droits gardes', async () => {
    const { h, d } = await world();
    await run(h, d, holderBody({ validTo: T0 - 3_600_000 }));
    assert.equal(d.users.get('101')?.EndTime, '20261017');
    assert.deepEqual(authOf(d, '101'), [], 'echu');
    await run(h, d, holderBody({ validFrom: T0 + 2 * 86_400_000, validTo: T0 + 9 * 86_400_000 }));
    assert.equal(d.users.get('101')?.StartTime, '20261019');
    assert.equal(d.users.get('101')?.EndTime, '20261026');
    assert.deepEqual(authOf(d, '101'), ['1:1'], 'StartTime empeche d\'entrer avant la date');
    // heure locale de l'appareil (decalage) pour les dates
    const west = await world({ controllers: [{ ...controllerCfg, utcOffsetMin: -480 }, terminalCfg] });
    await run(west.h, west.d, holderBody({ validTo: Date.UTC(2026, 9, 18, 2, 0) }));
    assert.equal(west.d.users.get('101')?.EndTime, '20261017', '2 h UTC = 18 h la veille, heure locale');
  });

  it('suppression d\'un titulaire : droits puis utilisateur retires ; absent = succes ; reference non convertible = succes sans commande', async () => {
    const { h, d } = await world();
    await run(h, d, holderBody());
    await run(h, d, holderBody({ holderRef: 'H102', credentials: [] }));
    assert.deepEqual(await run(h, d, { type: 'delete_holder', holderRef: 'H101' }), { result: 'done' });
    assert.equal(d.users.has('101'), false);
    assert.deepEqual(authOf(d, '101'), []);
    assert.ok(d.users.has('102'), 'les autres titulaires sont intacts');
    const dels = d.dataLog.filter((c) => c.verb === 'DELETE').map((c) => c.table);
    assert.deepEqual(dels.slice(-2), ['userauthorize', 'user']);
    assert.deepEqual(await run(h, d, { type: 'delete_holder', holderRef: 'H101' }), { result: 'done' }, 'rejeu');
    const before = d.received.length;
    assert.deepEqual(await run(h, d, { type: 'delete_holder', holderRef: 'H0099' }), { result: 'done' });
    assert.equal(d.received.length, before);
  });

  it('options : sans `userExtras`, ni Name ni Privilege ; nom nettoye (tabulation, saut de ligne) et borne', async () => {
    const plain = await world({ sync: { userExtras: false } });
    await run(plain.h, plain.d, holderBody());
    assert.deepEqual(plain.d.users.get('101'), { CardNo: CARD, Pin: '101', StartTime: '0', EndTime: '0' });
    const { h, d } = await world();
    await run(h, d, holderBody({ name: 'Jean\tPaul\nKouassi-Konan Amoakon' }));
    const cmd = commandTexts(d).find((t) => t.startsWith('DATA UPDATE user')) as string;
    assert.equal(cmd.split('\t').length, 6, 'cinq champs apres le nom de table : aucune tabulation en trop');
    assert.ok(Buffer.byteLength(d.users.get('101')?.Name ?? '', 'utf8') <= 24);
    assert.ok(!/[\r\n]/.test(cmd));
  });

  it('jours feries : ecrits (type 1, non annuels) ; `replace` retire ceux qu\'il avait ecrits mais jamais ceux de l\'installateur', async () => {
    const { h, d } = await world();
    d.holidays.set('20250101', { Holiday: '20250101', preexisting: '1' });
    assert.deepEqual(await run(h, d, { type: 'set_holidays', dates: ['2026-12-25', '2026-12-31'], replace: true }), { result: 'done' });
    assert.deepEqual([...d.holidays.keys()].sort(), ['20250101', '20261225', '20261231']);
    assert.deepEqual(d.holidays.get('20261225'), { Holiday: '20261225', HolidayType: '1', Loop: '2' });
    // rejeu identique
    const first = snapshot(d);
    await run(h, d, { type: 'set_holidays', dates: ['2026-12-25', '2026-12-31'], replace: true });
    assert.equal(snapshot(d), first);
    // ajout sans remplacement
    await run(h, d, { type: 'set_holidays', dates: ['2027-01-01'], replace: false });
    assert.deepEqual([...d.holidays.keys()].sort(), ['20250101', '20261225', '20261231', '20270101']);
    // remplacement : retire ce que le module avait ecrit et qui n'est plus voulu
    await run(h, d, { type: 'set_holidays', dates: ['2027-01-01', '2027-05-01'], replace: true });
    assert.deepEqual([...d.holidays.keys()].sort(), ['20250101', '20270101', '20270501']);
    // remplacement par une liste vide
    await run(h, d, { type: 'set_holidays', dates: [], replace: true });
    assert.deepEqual([...d.holidays.keys()], ['20250101']);
    assert.deepEqual(d.forbiddenSeen, []);
  });

  it('jours feries : la liste ecrite survit a un redemarrage du module (dossier d\'etat)', async () => {
    const dir = tempDir();
    const a = await world({ stateDir: dir });
    await run(a.h, a.d, { type: 'set_holidays', dates: ['2026-12-25', '2026-12-31'], replace: true });
    const device = a.d;
    await a.h.stop();
    assert.ok(existsSync(join(dir, HOLIDAYS_FILE)));
    const b = await world({ stateDir: dir });
    for (const [k, v] of device.holidays) b.d.holidays.set(k, v); // le meme appareil, qui a garde sa memoire
    await run(b.h, b.d, { type: 'set_holidays', dates: ['2026-12-31'], replace: true });
    assert.deepEqual([...b.d.holidays.keys()], ['20261231']);
  });

  it('jours feries : date hors de la plage de l\'appareil = refused / invalid, rien d\'ecrit', async () => {
    const { h, d } = await world();
    assert.deepEqual(await run(h, d, { type: 'set_holidays', dates: ['2026-12-25', '2100-01-01'], replace: false }), { result: 'refused', code: 'invalid' });
    assert.equal(d.received.length, 0);
    assert.equal(d.holidays.size, 0);
  });

  it('jours feries : echec au milieu = la liste suivie reste exacte, le rejeu termine le travail', async () => {
    const { h, d } = await world();
    let n = 0;
    d.dataOverride = (c) => (c.table === 'holiday' && ++n === 3 ? -5 : undefined);
    const dates = ['2026-12-25', '2026-12-26', '2026-12-27', '2026-12-28'];
    assert.deepEqual(await run(h, d, { type: 'set_holidays', dates, replace: true }), { result: 'error', code: 'io' });
    assert.deepEqual([...d.holidays.keys()].sort(), ['20261225', '20261226']);
    d.dataOverride = null;
    assert.deepEqual(await run(h, d, { type: 'set_holidays', dates, replace: true }), { result: 'done' });
    assert.equal(d.holidays.size, 4);
    await run(h, d, { type: 'set_holidays', dates: [], replace: true });
    assert.equal(d.holidays.size, 0);
  });

  it('refus et erreurs de l\'appareil : -30 invalid, -1002 not_supported, autre code io, capacite pleine declaree = full', async () => {
    const { h, d } = await world({ sync: { fullCodes: [FAKE_FULL_CODE] } });
    d.capacity = { users: 1 };
    assert.deepEqual(await run(h, d, holderBody()), { result: 'done' });
    assert.deepEqual(await run(h, d, holderBody({ holderRef: 'H102' })), { result: 'refused', code: 'full' });
    assert.ok(d.users.has('101') && !d.users.has('102'));
    d.capacity = { holidays: 1 };
    assert.deepEqual(await run(h, d, { type: 'set_holidays', dates: ['2026-12-25', '2026-12-26'], replace: false }), { result: 'refused', code: 'full' });
    d.dataOverride = () => -30;
    assert.deepEqual(await run(h, d, holderBody()), { result: 'refused', code: 'invalid' });
    d.dataOverride = () => -1002;
    assert.deepEqual(await run(h, d, holderBody()), { result: 'refused', code: 'not_supported' });
    for (const code of [-1, -3, -5, -1003, 7]) {
      d.dataOverride = () => code;
      assert.deepEqual(await run(h, d, holderBody()), { result: 'error', code: 'io' }, String(code));
    }
    d.dataOverride = null;
    // sans declaration, le code « pleine » du faux appareil reste une erreur a reessayer
    const bare = await world();
    bare.d.capacity = { users: 0 };
    assert.deepEqual(await run(bare.h, bare.d, holderBody()), { result: 'error', code: 'io' });
  });

  it('fuseau « toujours » absent de l\'appareil : refus du materiel (invalid), jamais reecrit par le module', async () => {
    const { h, d } = await world({ timezones: { min: 2, max: 8, always: 9 } });
    assert.deepEqual(await run(h, d, holderBody()), { result: 'refused', code: 'invalid' });
    assert.equal(d.timezones.has(9), false, 'le module n\'a pas cree le fuseau « toujours »');
    d.timezones.set(9, { TimezoneId: '9' });
    assert.deepEqual(await run(h, d, holderBody()), { result: 'done' });
    assert.deepEqual(authOf(d, '101'), ['9:1']);
  });

  it('appareil jamais venu : error / unreachable tout de suite, rien en file', async () => {
    const h = await boot();
    const out = await handlerOf(h)(syncOp(holderBody()));
    assert.deepEqual(out, { result: 'error', code: 'unreachable' });
    assert.equal(h.mod.state().controllers['CTL-2']?.commandsPending, 0);
  });

  it('appareil qui n\'interroge plus : la commande expire (commandTimeoutS), est retiree, jamais remise en retard', async () => {
    const { h, d } = await world({ thresholds: { commandTimeoutS: 5 } });
    const p = handlerOf(h)(syncOp(holderBody()));
    await settle();
    assert.equal(h.mod.state().controllers['CTL-2']?.commandsPending, 1);
    h.clock.t += 6000;
    h.mod.tick();
    assert.deepEqual(await p, { result: 'error', code: 'unreachable' });
    assert.equal(h.mod.state().controllers['CTL-2']?.commandsPending, 0, 'retiree de la file');
    const late = await d.poll();
    assert.deepEqual(late.commands, [], 'rien n\'est remis apres coup');
    assert.equal(d.users.size, 0);
  });

  it('appareil qui execute sans repondre : timeout, puis le rejeu donne le meme etat final (idempotence)', async () => {
    const { h, d } = await world({ thresholds: { commandTimeoutS: 5 } });
    await run(h, d, scheduleBody('S1'));
    d.commandReply = 'silent';
    const p = handlerOf(h)(syncOp(holderBody({ doors: [{ doorNo: 1, scheduleRef: 'S1' }] })));
    await settle();
    await d.poll(); // remise : l'appareil execute, le resultat ne vient pas
    assert.ok(d.users.has('101'), 'execute');
    h.clock.t += 6000;
    h.mod.tick();
    assert.deepEqual(await p, { result: 'error', code: 'timeout' });
    assert.equal(h.mod.state().controllers['CTL-2']?.commandsPending, 0);
    d.commandReply = 'ok';
    assert.deepEqual(await run(h, d, holderBody({ doors: [{ doorNo: 1, scheduleRef: 'S1' }] })), { result: 'done' });
    assert.deepEqual(authOf(d, '101'), ['2:1']);
    assert.equal(d.users.size, 1);
  });

  it('operations simultanees : executees une a la fois, dans l\'ordre d\'arrivee, une seule commande en vol', async () => {
    const { h, d } = await world();
    const a = handlerOf(h)(syncOp(holderBody({ holderRef: 'H101' })));
    const b = handlerOf(h)(syncOp(holderBody({ holderRef: 'H102', credentials: ['5551'] })));
    const c = handlerOf(h)(syncOp({ type: 'delete_holder', holderRef: 'H101' }));
    const all = Promise.all([a, b, c]);
    const res = await drive(d, all);
    assert.deepEqual(res, [{ result: 'done' }, { result: 'done' }, { result: 'done' }]);
    const pins = commandTexts(d).map((t) => /Pin=(\d+)/.exec(t)?.[1]);
    // toutes les commandes de H101 (creation), puis celles de H102, puis la suppression de H101
    assert.deepEqual(pins, ['101', '101', '101', '102', '102', '102', '101', '101']);
    assert.deepEqual([...d.users.keys()], ['102']);
  });

  it('une ouverture de porte demandee pendant une synchronisation attend au plus UNE commande de synchronisation (jamais toute la liste)', async () => {
    const { h, d } = await world();
    const p = handlerOf(h)(syncOp({ type: 'set_holidays', dates: ['2026-12-25', '2026-12-26', '2026-12-27', '2026-12-28'], replace: false }));
    await settle();
    await d.poll(); // premiere date ecrite
    const unlock = (h.handlers.get('ACT-ENTREE') as ActuatorHandler)({ actuatorId: 'ACT-ENTREE', cmdId: 'c', action: 'unlock' });
    await settle();
    assert.deepEqual(await drive(d, p), { result: 'done' });
    assert.deepEqual(await unlock, { result: 'done' });
    const order = commandTexts(d).map((t) => (t.startsWith('CONTROL') ? 'ouverture' : 'jour'));
    // la 2e date etait deja en file quand l'ouverture est arrivee ; les 3e et 4e (posees seulement apres confirmation) passent derriere
    assert.deepEqual(order, ['jour', 'jour', 'ouverture', 'jour', 'jour']);
  });

  it('chaque commande est bornee par commandTimeoutS, meme au milieu d\'une operation', async () => {
    const { h, d } = await world({ thresholds: { commandTimeoutS: 5 } });
    const p = handlerOf(h)(syncOp(holderBody()));
    await settle();
    await d.poll(); // 1re commande (utilisateur) executee et confirmee
    await settle();
    assert.equal(h.mod.state().controllers['CTL-2']?.commandsPending, 1, 'la commande suivante attend');
    h.clock.t += 6000;
    h.mod.tick();
    assert.equal((await p).result, 'error');
    assert.equal(h.mod.state().controllers['CTL-2']?.commandsPending, 0);
  });

  it('journaux : jamais de nom, de numero de badge ni de reference de titulaire', async () => {
    const { h, d } = await world();
    await run(h, d, holderBody());
    await run(h, d, holderBody({ holderRef: 'H1234567890' }));
    await run(h, d, holderBody({ credentials: [CARD, '99999'] }));
    await run(h, d, { type: 'delete_holder', holderRef: 'H101' });
    const logs = allLogs(h);
    assert.ok(/synchronisation upsert_holder -> done/.test(logs), logs);
    for (const secret of ['KONAN', CARD, 'H101', '99999', 'H1234567890']) assert.ok(!logs.includes(secret), secret);
  });

  it('redemarrage du module : les numeros de fuseau attribues sont conserves (un titulaire cite son horaire sans qu\'il soit renvoye)', async () => {
    const dir = tempDir();
    const a = await world({ stateDir: dir });
    await run(a.h, a.d, scheduleBody('S1'));
    await run(a.h, a.d, scheduleBody('S2'));
    await a.h.stop();
    const b = await world({ stateDir: dir });
    b.d.timezones.set(3, { TimezoneId: '3' });
    assert.deepEqual(await run(b.h, b.d, holderBody({ doors: [{ doorNo: 1, scheduleRef: 'S2' }] })), { result: 'done' });
    assert.deepEqual(authOf(b.d, '101'), ['3:1']);
  });

  it('configuration : timezones et sync, valeurs par defaut et validation', () => {
    const c = parseConfig(baseConfig());
    assert.deepEqual(c.timezones, { min: 2, max: 50, always: 1 });
    assert.deepEqual(c.sync, { userExtras: true, fullCodes: [] });
    const ok = parseConfig(baseConfig({ timezones: { min: 5, max: 9, always: 2 }, sync: { userExtras: false, fullCodes: [-12, -12, -13] } }));
    assert.deepEqual(ok.timezones, { min: 5, max: 9, always: 2 });
    assert.deepEqual(ok.sync, { userExtras: false, fullCodes: [-12, -13] });
    const bad = (over: Record<string, unknown>, re: RegExp) => assert.throws(() => parseConfig(baseConfig(over)), re, JSON.stringify(over));
    bad({ timezones: { max: 1 } }, /timezones\.min \(2\) ne peut pas depasser timezones\.max \(1\)/);
    bad({ timezones: { min: 3, max: 10, always: 5 } }, /timezones\.always \(5\) doit etre hors de la plage/);
    bad({ timezones: { max: 255 } }, /timezones\.max/);
    bad({ timezones: { min: 0 } }, /timezones\.min/);
    bad({ timezones: { min: 1.5 } }, /timezones\.min/);
    bad({ timezones: { extra: 1 } }, /cle inconnue/);
    bad({ timezones: 5 }, /timezones doit etre un objet/);
    bad({ sync: { userExtras: 'oui' } }, /sync\.userExtras/);
    bad({ sync: { fullCodes: [0] } }, /sync\.fullCodes\[0\]/);
    bad({ sync: { fullCodes: [1] } }, /sync\.fullCodes\[0\]/);
    bad({ sync: { fullCodes: 'x' } }, /sync\.fullCodes/);
    bad({ sync: { fullCodes: Array.from({ length: 17 }, (_, i) => -i - 1) } }, /sync\.fullCodes/);
    bad({ sync: { sendName: true } }, /cle inconnue/);
    bad({ sync: 3 }, /sync doit etre un objet/);
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
