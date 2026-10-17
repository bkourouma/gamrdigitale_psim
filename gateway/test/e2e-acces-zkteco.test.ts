/**
 * Bout en bout, sans faux maillon cote PSIM : faux appareil ZKTeco « push » (fake-zkteco.ts) -> VRAI module `acces-zkteco`
 * (charge par le socle depuis gateway/src/modules) -> file disque de la passerelle -> VRAI broker du PSIM (server/mqtt.ts)
 * -> VRAI moteur (server/engine.ts, base SQLite temporaire) avec des detecteurs de categorie `access`.
 *
 * Seul l'appareil est simule. Ports libres choisis au hasard, interface 127.0.0.1 ; l'horloge de la passerelle est decalable
 * (le moteur, lui, garde l'heure reelle : un decalage de quelques minutes reste dans sa tolerance).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { openDb } from '../../server/db.ts';
import { createEngine } from '../../server/engine.ts';
import { startBroker } from '../../server/mqtt.ts';
import type { Broker } from '../../server/mqtt.ts';
import { loadConfig } from '../src/config.ts';
import { startRuntime } from '../src/runtime.ts';
import type { GatewayRuntime } from '../src/runtime.ts';
import { FakeZk } from './fake-zkteco.ts';
import { freePort, GW_PASSWORD, GW_USER, memoryLogger, tempDir, waitFor, writeConfig } from './helpers.ts';

const SERIAL = 'CJDK123456789';
const CARD = '12345678';
const cleanup: (() => unknown)[] = [];
after(async () => {
  for (const f of cleanup.reverse()) await f();
});

interface World {
  engine: ReturnType<typeof createEngine>;
  db: ReturnType<typeof openDb>;
  rt: GatewayRuntime;
  dev: FakeZk;
  /** Decalage de l'horloge de la passerelle (ms). */
  shift: { ms: number };
  /** Messages recus par le moteur (charge utile brute, champ `access` compris). */
  received: { id: string; payload: Record<string, unknown> }[];
  brokerPort: number;
  broker: () => Broker | null;
  stopBroker: () => Promise<void>;
  startBrokerAgain: () => Promise<void>;
  logger: ReturnType<typeof memoryLogger>;
  dedup: (like: string) => number;
  open: (id: string, event?: string) => ReturnType<ReturnType<typeof createEngine>['getSnapshot']>['incidents'];
}

async function world(moduleConfig: Record<string, unknown> = {}): Promise<World> {
  const dir = tempDir(cleanup);
  const db = openDb(join(dir, 'psim.db'));
  cleanup.push(() => db.close());
  const engine = createEngine(db, () => {}, Date.now, { isArmed: () => false });
  for (const id of ['P-ENTREE', 'P-ARRIERE']) engine.createDevice('admin', { id, kind: 'detector', name: `Porte ${id}`, category: 'access' });

  const received: World['received'] = [];
  // Le moteur reel, derriere un espion : on voit ce que le broker lui remet (y compris `access` et `deferred`).
  const spy = { ...engine, handleDetectorMessage: (id: string, payload: unknown) => {
    received.push({ id, payload: payload as Record<string, unknown> });
    engine.handleDetectorMessage(id, payload);
  } } as unknown as typeof engine;

  const brokerPort = await freePort();
  let broker: Broker | null = null;
  const startB = async () => {
    broker = await startBroker(spy, {
      host: '127.0.0.1',
      port: brokerPort,
      user: 'psim',
      password: 'Mot-de-passe-mqtt-solide-3',
      gateways: [{ user: GW_USER, password: GW_PASSWORD, detectors: ['P-*'] }],
    });
  };
  await startB();
  cleanup.push(() => broker?.close());

  const httpPort = await freePort();
  const shift = { ms: 0 };
  const stateDir = join(dir, 'zk-state');
  const file = writeConfig(dir, {
    psim: { url: `mqtt://127.0.0.1:${brokerPort}`, username: GW_USER, password: GW_PASSWORD, detectors: ['P-*'] },
    dataDir: 'gw-data',
    retry: { minMs: 100, maxMs: 400 },
    moduleRetry: { minMs: 100, maxMs: 400 },
    log: { file: false },
    modules: [{
      name: 'acces-zkteco',
      config: {
        stateDir,
        listen: { host: '127.0.0.1', port: httpPort },
        allowFrom: ['127.0.0.1'],
        controllers: [{ id: 'CTL-E2E', serial: SERIAL, doors: { '1': 'P-ENTREE', '2': 'P-ARRIERE' } }],
        ...moduleConfig,
      },
    }],
  });
  const logger = memoryLogger();
  const rt = await startRuntime({ config: loadConfig(file), logger, now: () => Date.now() + shift.ms });
  cleanup.push(() => rt.stop());
  await waitFor(() => rt.status().modules[0]?.state === 'running', 10_000, 'module acces-zkteco demarre');
  const dev = new FakeZk({ port: httpPort, serial: SERIAL, now: () => Date.now() + shift.ms });
  return {
    engine,
    db,
    rt,
    dev,
    shift,
    received,
    brokerPort,
    broker: () => broker,
    stopBroker: async () => {
      await broker?.close();
      broker = null;
    },
    startBrokerAgain: startB,
    logger,
    dedup: (like) => Number((db.prepare('SELECT COUNT(*) AS n FROM ingest_dedup WHERE msg_id LIKE ?').get(like) as { n: number }).n),
    open: (id, event) => engine.getSnapshot().incidents.filter((i) => i.detectorId === id && i.status !== 'closed' && (event === undefined || i.event === event)),
  };
}

const accessMsgs = (w: World) => w.received.filter((r) => r.payload.access !== undefined);

describe('bout en bout : appareil ZKTeco -> module -> socle -> broker du PSIM -> moteur', () => {
  it('passages acceptes : arrivent au PSIM, aucun incident ; un refus isole n\'en cree pas non plus', { timeout: 60_000 }, async () => {
    const w = await world();
    await w.dev.handshake();
    await w.dev.push({ event: 0, card: CARD, pin: '101', door: 1 });
    await w.dev.push({ event: 0, card: CARD, pin: '101', door: 2, inout: 1 });
    await w.dev.push({ event: 27, card: '5551234', door: 1 });
    await waitFor(() => accessMsgs(w).length === 3, 15_000, 'les trois passages recus par le moteur');
    const a = accessMsgs(w);
    assert.deepEqual(a.map((m) => m.id), ['P-ENTREE', 'P-ARRIERE', 'P-ENTREE']);
    assert.deepEqual(a.map((m) => m.payload.event), ['badge_granted', 'badge_granted', 'badge_denied']);
    const first = a[0]?.payload.access as Record<string, unknown>;
    assert.equal(first.controllerId, 'CTL-E2E');
    assert.equal(first.credential, CARD);
    assert.equal(first.deferred, false);
    assert.equal((a[2]?.payload.access as Record<string, unknown>).reason, 'unknown_credential');
    assert.equal(w.open('P-ENTREE').length + w.open('P-ARRIERE').length, 0, 'ni passage ni refus isole n\'est un incident');
    assert.equal(w.engine.getDevice('P-ENTREE')?.status, 'normal');
    assert.equal(w.dedup('acc:CTL-E2E:%'), 3);
    await waitFor(() => w.rt.status().queue.pending === 0, 10_000, 'file videe');
    assert.equal(w.logger.has(/rejete|refuse/), false, w.logger.lines.map((l) => l.text).join('\n'));
  });

  it('refus repetes : pre-alarme sur la porte concernee seulement', { timeout: 60_000 }, async () => {
    const w = await world();
    await w.dev.handshake();
    for (let i = 0; i < 3; i++) await w.dev.push({ event: 27, card: '5551234', door: 1 });
    await waitFor(() => w.open('P-ENTREE', 'badge_denied_repeated').length === 1, 15_000, 'incident de refus repetes');
    assert.equal(w.open('P-ENTREE', 'badge_denied_repeated')[0]?.category, 'access');
    assert.equal(w.engine.getDevice('P-ENTREE')?.status, 'prealarm');
    assert.equal(w.engine.getDevice('P-ARRIERE')?.status, 'normal');
  });

  it('porte forcee : incident d\'alarme ouvert dans le PSIM, avec le bon motif', { timeout: 60_000 }, async () => {
    const w = await world();
    await w.dev.handshake();
    await w.dev.push({ event: 102, door: 2 });
    await waitFor(() => w.open('P-ARRIERE', 'door_forced').length === 1, 15_000, 'incident porte forcee');
    const incident = w.open('P-ARRIERE', 'door_forced')[0];
    assert.equal(incident?.category, 'access');
    assert.equal(w.engine.getDevice('P-ARRIERE')?.status, 'alarm');
    assert.equal(w.engine.getDevice('P-ENTREE')?.status, 'normal');
    // le retour a la normale (porte refermee) est vu
    await w.dev.push({ event: 201, door: 2 });
    await waitFor(() => w.engine.getDevice('P-ARRIERE')?.status === 'normal', 15_000, 'retour a la normale');
  });

  it('sabotage : alarme toujours active', { timeout: 60_000 }, async () => {
    const w = await world();
    await w.dev.handshake();
    await w.dev.push({ event: 100, door: 1 });
    await waitFor(() => w.open('P-ENTREE', 'tamper').length === 1, 15_000, 'incident sabotage');
  });

  it('coupure du PSIM : les passages restent en file puis arrivent SANS doublon, l\'incident n\'est ouvert qu\'une fois', { timeout: 90_000 }, async () => {
    const w = await world();
    await w.dev.handshake();
    await w.dev.push({ event: 0, card: CARD, door: 1 });
    await waitFor(() => w.dedup('acc:CTL-E2E:%') === 1, 15_000, 'premier passage recu');
    await w.stopBroker();
    await waitFor(() => !w.rt.status().psim.connected, 15_000, 'passerelle consciente de la coupure');
    // pendant la coupure : l'appareil continue d'envoyer, le module acquitte (la passerelle garde sur disque)
    await w.dev.push({ event: 0, card: CARD, door: 2 });
    await w.dev.push({ event: 102, door: 1 });
    await w.dev.push({ event: 27, card: '5551234', door: 2 });
    assert.equal(w.dev.unacked, 0, 'acquittes par le module : la file disque de la passerelle a pris le relais');
    await waitFor(() => w.rt.status().queue.pending >= 3, 10_000, 'messages en file');
    const before = accessMsgs(w).length;
    // l'appareil, lui, renvoie un enregistrement deja acquitte (reponse perdue) : un meme index n'est pas reemis
    w.dev.recordRaw('rtlog', w.dev.rtlogLine({ event: 102, door: 1, index: 3 }));
    await w.dev.flush();
    await w.startBrokerAgain();
    await waitFor(() => w.rt.status().queue.pending === 0 && w.dedup('acc:CTL-E2E:%') >= 3, 30_000, 'file videe apres le retour du PSIM');
    await waitFor(() => w.open('P-ENTREE', 'door_forced').length === 1, 15_000, 'incident porte forcee');
    assert.equal(accessMsgs(w).length - before, 2, 'passage + refus recus apres la reprise (la porte forcee n\'a pas de champ access)');
    // aucun doublon : un seul message par identifiant
    const ids = w.received.map((r) => r.payload.msgId as string).filter((m) => m.startsWith('acc:'));
    assert.equal(new Set(ids).size, ids.length, `msgId en double : ${ids.join(' ')}`);
    assert.equal(w.open('P-ENTREE', 'door_forced').length, 1);
    assert.equal(w.logger.has(/rejete/), false);
  });

  it('coupure de l\'appareil : portes hors ligne apres le silence, puis retour en ligne', { timeout: 90_000 }, async () => {
    const w = await world();
    await w.dev.handshake();
    await waitFor(() => w.engine.getDevice('P-ENTREE')?.lastSeen !== null, 15_000, 'premier signe de vie');
    assert.equal(w.engine.getDevice('P-ENTREE')?.status, 'normal');
    w.dev.goOffline();
    w.shift.ms += 90_000 + 15_000 + 2_000; // silence (90 s) + grace (15 s)
    await waitFor(() => w.engine.getDevice('P-ENTREE')?.status === 'offline' && w.engine.getDevice('P-ARRIERE')?.status === 'offline', 20_000, 'portes hors ligne');
    w.dev.goOnline();
    await w.dev.ping();
    await waitFor(() => w.engine.getDevice('P-ENTREE')?.status === 'normal' && w.engine.getDevice('P-ARRIERE')?.status === 'normal', 20_000, 'portes de nouveau en ligne');
  });

  it('passages stockes pendant une coupure de l\'appareil : recuperes avec deferred=true, dans l\'ordre, sans doublon', { timeout: 90_000 }, async () => {
    const w = await world();
    await w.dev.handshake();
    w.dev.goOffline();
    const t0 = Date.now() + w.shift.ms;
    w.dev.record({ event: 0, card: CARD, door: 1, at: t0 - 20 * 60_000 });
    w.dev.record({ event: 27, card: '5551234', door: 1, at: t0 - 10 * 60_000 });
    await assert.rejects(w.dev.flush());
    w.dev.goOnline();
    w.dev.record({ event: 0, card: CARD, door: 2, at: t0 });
    await w.dev.flush();
    // l'appareil renvoie tout (par exemple apres une reponse perdue) : rien ne doit etre emis deux fois
    w.dev.recordRaw('rtlog', w.dev.rtlogLine({ event: 0, card: CARD, door: 1, at: t0 - 20 * 60_000, index: 1 }));
    await w.dev.flush();
    await waitFor(() => accessMsgs(w).length === 3, 15_000, 'trois passages recus');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(accessMsgs(w).length, 3, 'pas de doublon');
    const deferred = accessMsgs(w).map((m) => (m.payload.access as Record<string, unknown>).deferred);
    assert.deepEqual(deferred, [true, true, false]);
    assert.deepEqual(accessMsgs(w).map((m) => m.payload.ts), [t0 - 20 * 60_000, t0 - 10 * 60_000, t0].map((x) => Math.floor(x / 1000) * 1000));
    assert.equal(w.open('P-ENTREE').length, 0, 'un refus differe n\'est pas un incident');
    assert.equal(w.dedup('acc:CTL-E2E:%'), 3);
  });

  it('actionneur declare : le module demarre et surveille, avec ou sans canal de commande dans le socle', { timeout: 60_000 }, async () => {
    const w = await world({ controllers: [{ id: 'CTL-E2E', serial: SERIAL, doors: { '1': 'P-ENTREE' }, actuators: { 'ACT-ENTREE': { door: 1, type: 'lock' } } }] });
    await w.dev.handshake();
    await w.dev.push({ event: 0, card: CARD, door: 1 });
    await waitFor(() => accessMsgs(w).length === 1, 15_000, 'passage recu');
    assert.equal(w.rt.status().modules[0]?.state, 'running');
  });
});
