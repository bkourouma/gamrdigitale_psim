/**
 * Broker MQTT et commandes des equipements : elevation de privilege. Un compte de passerelle ne lit QUE les ordres de ses
 * actionneurs et ne publie QUE leurs accuses ; il ne peut ni lire ni forger pour un autre ; le compte principal n'a aucun
 * acces aux actionneurs ; jamais de joker, jamais de message conserve, abonnements forces en QoS 0 (pas de file hors ligne).
 * Plus un aller-retour complet : PSIM -> broker -> simulateur (ordre verifie) -> accuse signe -> commande accusee.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { signAck } from '../server/actuatorproto.ts';
import { parseAllowList } from '../server/actuatorhttp.ts';
import { createActuators } from '../server/actuators.ts';
import type { Actuators } from '../server/actuators.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { startBroker } from '../server/mqtt.ts';
import type { Broker } from '../server/mqtt.ts';
import { seedEmptySite } from '../server/seed.ts';
import { randomBytes } from 'node:crypto';
import { startMqttActuator } from './actuator-sim.ts';

const ROOT = resolve(import.meta.dirname, '..');
const MAIN = { user: 'psim', password: 'Mot-de-passe-mqtt-principal-1' };
const GW_A = { user: 'gw-a', password: 'Mot-de-passe-passerelle-A', detectors: ['D-A'], actuators: ['SIR-A', 'R-*'] };
const GW_B = { user: 'gw-b', password: 'Mot-de-passe-passerelle-B', detectors: [], actuators: ['SIR-B'] };

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('broker MQTT : droits sur les commandes', { timeout: 60_000 }, () => {
  let dir = '';
  let broker: Broker;
  let url = '';
  let svc: Actuators;
  const acks: { id: string; payload: string }[] = [];
  const clients: MqttClient[] = [];
  let keyA = '';
  let keyB = '';
  let db: ReturnType<typeof openDb>;

  const connect = async (user: string, password: string): Promise<MqttClient> => {
    const c = mqtt.connect(url, { username: user, password, reconnectPeriod: 0, connectTimeout: 5000 });
    clients.push(c);
    await new Promise<void>((res, rej) => {
      c.once('connect', () => res());
      c.once('error', rej);
    });
    return c;
  };
  // Code accorde par le broker (128 = refuse ; la bibliotheque mqtt leve alors une erreur portant le SUBACK).
  const sub = async (c: MqttClient, topic: string, qos: 0 | 1 = 1): Promise<number | undefined> => {
    try {
      return (await c.subscribeAsync(topic, { qos }))[0]?.qos;
    } catch (err) {
      const granted = (err as { packet?: { granted?: number[] } }).packet?.granted?.[0];
      if (granted === undefined) throw err;
      return granted;
    }
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'psim-mqtt-act-'));
    db = openDb(join(dir, 'psim.db'));
    seedEmptySite(db);
    const engine = createEngine(db, () => {});
    svc = createActuators({ db, key: randomBytes(32), audit: engine.audit, publish: () => {}, httpAllow: parseAllowList([]) });
    keyA = svc.create('admin', { id: 'SIR-A', name: 'Sirene A', type: 'siren', transport: 'mqtt' }).key;
    keyB = svc.create('admin', { id: 'SIR-B', name: 'Sirene B', type: 'siren', transport: 'mqtt' }).key;
    const port = await freePort();
    url = `mqtt://127.0.0.1:${port}`;
    broker = await startBroker(engine, {
      host: '127.0.0.1',
      port,
      user: MAIN.user,
      password: MAIN.password,
      gateways: [GW_A, GW_B],
      onActuatorAck: (id, payload) => {
        acks.push({ id, payload: payload.toString() });
        svc.handleAck(id, payload);
      },
    });
    svc.attachMqtt({ listeners: (id) => broker.actuatorListeners(id), publishCommand: (id, p) => broker.publishCommand(id, p) });
  });
  after(async () => {
    for (const c of clients) await c.endAsync(true).catch(() => {});
    await broker?.close();
    db?.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows
    }
  });

  it('abonnements : seulement le topic exact de SES actionneurs, force en QoS 0 ; jamais de joker ; principal exclu', async () => {
    const a = await connect(GW_A.user, GW_A.password);
    assert.notEqual(await sub(a, 'psim/actuators/SIR-A/command'), 128, 'accorde');
    assert.notEqual(await sub(a, 'psim/actuators/R-12/command'), 128, 'prefixe R-*');
    assert.equal(await sub(a, 'psim/actuators/SIR-B/command'), 128, "ordres d'un autre : refuses");
    for (const t of ['psim/actuators/+/command', 'psim/actuators/#', '#', 'psim/+/SIR-A/command', 'psim/actuators/SIR-A/ack', 'psim/actuators/SIR-A/+', '$share/g/psim/actuators/SIR-A/command', '$SYS/#']) {
      assert.equal(await sub(a, t), 128, t);
    }
    const main = await connect(MAIN.user, MAIN.password);
    assert.equal(await sub(main, 'psim/actuators/SIR-A/command'), 128, 'le compte principal ne lit aucun ordre');
    assert.equal(await sub(main, 'psim/actuators/SIR-A/ack'), 128);
    assert.equal(broker.actuatorListeners('SIR-A'), 1);
    assert.equal(broker.actuatorListeners('SIR-B'), 0);
    await a.unsubscribeAsync('psim/actuators/SIR-A/command');
    await wait(50);
    assert.equal(broker.actuatorListeners('SIR-A'), 0, 'desabonnement suivi');
    await a.subscribeAsync('psim/actuators/SIR-A/command', { qos: 1 });
    await a.endAsync(true);
    await wait(100);
    assert.equal(broker.actuatorListeners('SIR-A'), 0, 'deconnexion suivie');
  });

  it("un compte ne peut ni forger un ordre, ni accuser pour un autre ; le principal n'accuse rien", async () => {
    const b = await connect(GW_B.user, GW_B.password);
    const received: string[] = [];
    b.on('message', (t, p) => received.push(`${t} ${p}`));
    assert.notEqual(await sub(b, 'psim/actuators/SIR-B/command'), 128);
    // A forge un ordre pour B (meme bien signe avec la cle de B s'il l'avait volee) : il ne passe pas le broker.
    const a = await connect(GW_A.user, GW_A.password);
    a.on('error', () => {});
    a.publish('psim/actuators/SIR-B/command', JSON.stringify({ v: 1, cmdId: 'f'.repeat(32), action: 'on', params: {}, ts: Date.now(), ttlS: 10, sig: '0'.repeat(64) }));
    await wait(300);
    assert.deepEqual(received, [], "aucun ordre forge n'arrive a B");
    // A ne peut pas accuser pour B, meme avec la vraie cle de B.
    const a2 = await connect(GW_A.user, GW_A.password);
    a2.on('error', () => {});
    acks.length = 0;
    a2.publish('psim/actuators/SIR-B/ack', JSON.stringify(signAck(keyB, 'SIR-B', { cmdId: 'a'.repeat(32), result: 'done', ts: Date.now() })));
    const main = await connect(MAIN.user, MAIN.password);
    main.on('error', () => {});
    main.publish('psim/actuators/SIR-A/ack', JSON.stringify(signAck(keyA, 'SIR-A', { cmdId: 'b'.repeat(32), result: 'done', ts: Date.now() })));
    await wait(300);
    assert.deepEqual(acks, [], "le broker n'a transmis aucun accuse non autorise");
    // Accuse autorise (A pour SIR-A), avec retain : transmis, mais jamais conserve.
    const a3 = await connect(GW_A.user, GW_A.password);
    a3.publish('psim/actuators/SIR-A/ack', JSON.stringify(signAck(keyA, 'SIR-A', { cmdId: 'c'.repeat(32), result: 'done', ts: Date.now() })), { retain: true, qos: 1 });
    await wait(300);
    const delivered: { id: string }[] = [...acks];
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].id, 'SIR-A');
  });

  it("pas de commande « fantome » : un ordre publie pendant la coupure n'est jamais remis au retour (session persistante)", async () => {
    const opts = { username: GW_A.user, password: GW_A.password, reconnectPeriod: 0, connectTimeout: 5000, clean: false, clientId: 'gw-a-persistant' };
    const first = mqtt.connect(url, opts);
    await new Promise<void>((res) => first.once('connect', () => res()));
    assert.notEqual((await first.subscribeAsync('psim/actuators/SIR-A/command', { qos: 1 }))[0]?.qos, 128);
    await first.endAsync();
    await wait(100);
    await broker.publishCommand('SIR-A', Buffer.from('{"v":1}'));
    const back = mqtt.connect(url, opts);
    clients.push(back);
    const got: { qos: number }[] = [];
    back.on('message', (_t, _p, packet) => got.push({ qos: packet.qos }));
    await new Promise<void>((res) => back.once('connect', () => res()));
    await wait(400);
    assert.deepEqual(got, [], 'rien de garde pendant la coupure');
    await broker.publishCommand('SIR-A', Buffer.from('{"v":1}'));
    await wait(200);
    assert.deepEqual(got, [{ qos: 0 }], 'en ligne : remis, en QoS 0');
    await back.endAsync(true);
    await wait(100);
  });

  it("aller-retour : ordre signe recu et verifie par le simulateur, accuse signe, commande accusee ; une autre passerelle n'a rien lu", async () => {
    const sim = await startMqttActuator({ url, username: GW_A.user, password: GW_A.password, actuatorId: 'SIR-A', key: keyA, mode: 'ack' });
    const spy = await connect(GW_B.user, GW_B.password);
    const spied: string[] = [];
    spy.on('message', (t) => spied.push(t));
    await sub(spy, 'psim/actuators/SIR-B/command');
    await wait(50);
    const r = svc.request({ username: 'op', role: 'operator' }, 'SIR-A', { action: 'on', params: { durationS: 15 }, confirm: true });
    for (let i = 0; i < 50 && svc.command(r.command.cmdId)?.state === 'sent'; i++) await wait(20);
    assert.equal(sim.received.length, 1);
    assert.equal(sim.received[0].params.durationS, 15);
    assert.equal(svc.command(r.command.cmdId)?.state, 'acked');
    assert.deepEqual(spied, []);
    // Ordre falsifie par un « broker » (publication interne) : rejete par le recepteur, aucun accuse.
    await broker.publishCommand('SIR-A', Buffer.from(JSON.stringify({ v: 1, cmdId: 'd'.repeat(32), action: 'on', params: { durationS: 600 }, ts: Date.now(), ttlS: 10, sig: '1'.repeat(64) })));
    // Ordre rejoue a l'identique (trame capturee, toujours dans son TTL) : refuse par l'anti-rejeu du recepteur.
    await broker.publishCommand('SIR-A', Buffer.from(JSON.stringify(sim.received[0])));
    await wait(200);
    assert.deepEqual(sim.rejected, ['signature', 'replay']);
    assert.equal(sim.received.length, 1, 'execute une seule fois');
    // Accuse en retard : la commande echoue d'abord (delai 1 s), l'accuse tardif est seulement note.
    svc.update('admin', 'SIR-A', { ackTimeoutS: 1 });
    sim.mode = 'late';
    sim.lateMs = 1500;
    const late = svc.request({ username: 'op', role: 'operator' }, 'SIR-A', { action: 'on', params: { durationS: 20 }, confirm: true });
    await wait(1100);
    svc.tick();
    assert.equal(svc.command(late.command.cmdId)?.state, 'failed');
    await wait(700);
    assert.equal(svc.command(late.command.cmdId)?.state, 'failed');
    assert.equal(svc.command(late.command.cmdId)?.lateAck, 'done');
    // Accuse a la signature falsifiee : ignore, la commande echoue a l'echeance.
    sim.mode = 'forge';
    const forged = svc.request({ username: 'op', role: 'operator' }, 'SIR-A', { action: 'on', params: { durationS: 21 }, confirm: true });
    await wait(1100);
    svc.tick();
    assert.equal(svc.command(forged.command.cmdId)?.state, 'failed');
    sim.mode = 'refuse';
    const refused = svc.request({ username: 'op', role: 'operator' }, 'SIR-A', { action: 'off', confirm: true });
    for (let i = 0; i < 50 && svc.command(refused.command.cmdId)?.state === 'sent'; i++) await wait(20);
    assert.equal(svc.command(refused.command.cmdId)?.state, 'refused');
    await sim.close();
    await wait(100);
    assert.equal(broker.actuatorListeners('SIR-A'), 0);
    assert.throws(() => svc.request({ username: 'op', role: 'operator' }, 'SIR-A', { action: 'off', confirm: true }), /Liaison coupee/);
  });
});

describe('configuration des passerelles : liste d actionneurs', () => {
  const load = (gateways: unknown) =>
    spawnSync(process.execPath, ['-e', "import('./server/config.ts').then(() => console.log('OK')).catch((e) => { console.error(e.message); process.exit(3); })"], {
      cwd: ROOT,
      env: { ...process.env, PSIM_MQTT_GATEWAYS: JSON.stringify(gateways), PSIM_ENV: '' },
      encoding: 'utf8',
    });

  it("« * » seul, joker MQTT, liste vide : refuses au demarrage ; compte d'actionneurs sans detecteur accepte", () => {
    for (const actuators of [['*'], ['+'], ['#'], [], ['SIR/1'], 'SIR-1']) {
      const r = load([{ user: 'gw1', password: 'mot-de-passe-long-1', detectors: ['D-1'], actuators }]);
      assert.equal(r.status, 3, JSON.stringify(actuators));
      assert.match(r.stderr, /actuators/);
    }
    assert.equal(load([{ user: 'gw1', password: 'mot-de-passe-long-1', actuators: ['SIR-1', 'R-*'] }]).status, 0);
    assert.equal(load([{ user: 'gw1', password: 'mot-de-passe-long-1', detectors: [] }]).status, 3, 'sans detecteur ni actionneur');
  });
});
