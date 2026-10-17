/**
 * Bout en bout de la synchronisation des titulaires (docs/CONTROLE-ACCES.md, par. 7) : FAUX PSIM qui signe (client MQTT et
 * node:crypto seulement) -> broker MQTT d'essai (Aedes, 127.0.0.1, port libre, droits ouverts : les droits des topics
 * psim/access/... cote PSIM ne sont pas encore faits) -> vrai socle (startRuntime) -> VRAI module `acces-dahua` -> faux
 * controleur Dahua (gateway/test/fake-dahua.ts, qui garde cartes, plages et jours feries) ; accuses signes verifies par le faux PSIM.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { loadConfig } from '../src/config.ts';
import { createPsimLink } from '../src/psimlink.ts';
import { DiskQueue } from '../src/queue.ts';
import { startRuntime } from '../src/runtime.ts';
import type { GatewayRuntime } from '../src/runtime.ts';
import { FakeDahua } from './fake-dahua.ts';
import { freePort, memoryLogger, sleep, tempDir, waitFor, writeConfig } from './helpers.ts';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) {
    try {
      await f();
    } catch {
      // nettoyage au mieux
    }
  }
});

const SYNC_KEY = '5a'.repeat(32);
const CTL = 'CTL-1';

// ------------------------------------------------------------------------------------------------------------------
// Faux PSIM : signe les ordres et verifie les accuses, sans rien reprendre du code de la passerelle
// ------------------------------------------------------------------------------------------------------------------

const hmac = (text: string, key = SYNC_KEY) => createHmac('sha256', Buffer.from(key, 'hex')).update(text, 'utf8').digest('hex');
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
let opSeq = 0;
const newOpId = () => `${(++opSeq).toString(16).padStart(8, '0')}${'e'.repeat(24)}`;

function signOrder(seq: number, body: Record<string, unknown>, o: { opId?: string; key?: string } = {}): string {
  const opId = o.opId ?? newOpId();
  const ts = Date.now();
  const text = JSON.stringify(body);
  const sig = hmac(`psim-sync-v1|${CTL}|${opId}|${seq}|${ts}|${sha256(text)}`, o.key);
  return JSON.stringify({ v: 1, opId, seq, ts, body: text, sig });
}

interface Ack {
  opId: string;
  seq: number;
  result: string;
  code: string | null;
  ts: number;
}

function verifyAck(raw: string): Ack | null {
  const m = JSON.parse(raw) as Record<string, unknown>;
  if (Object.keys(m).sort().join(',') !== 'code,opId,result,seq,sig,ts,v') return null;
  const expected = Buffer.from(hmac(`psim-sync-ack-v1|${CTL}|${m.opId}|${m.seq}|${m.result}|${m.code ?? ''}|${m.ts}`), 'hex');
  const given = Buffer.from(String(m.sig), 'hex');
  if (given.length !== 32 || !timingSafeEqual(expected, given)) return null;
  return { opId: m.opId as string, seq: m.seq as number, result: m.result as string, code: m.code as string | null, ts: m.ts as number };
}

// ------------------------------------------------------------------------------------------------------------------
// Broker d'essai (Aedes) et monde complet
// ------------------------------------------------------------------------------------------------------------------

interface TestBroker {
  /** Topics auxquels un client s'est abonne (dans l'ordre). */
  subscribed: { client: string; topic: string; qos: number }[];
  close(): Promise<void>;
}

async function startTestBroker(port: number, o: { denySync?: boolean } = {}): Promise<TestBroker> {
  const aedes = await Aedes.createBroker({ connectTimeout: 10_000 });
  const subscribed: TestBroker['subscribed'] = [];
  if (o.denySync) {
    // Comme le futur controle des droits du PSIM : abonnement a la synchronisation refuse (SUBACK 128).
    aedes.authorizeSubscribe = (_client, sub, done) => done(null, /^psim\/access\/[^/]+\/sync$/.test(sub.topic) ? null : sub);
  }
  aedes.on('subscribe', (subs, client) => {
    for (const s of subs) subscribed.push({ client: client?.id ?? '?', topic: s.topic, qos: s.qos });
  });
  const server: Server = createServer(aedes.handle);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  let closed = false;
  return {
    subscribed,
    close: () =>
      new Promise<void>((resolve) => {
        if (closed) return resolve();
        closed = true;
        server.close();
        aedes.close(() => resolve());
      }),
  };
}

interface WorldOptions {
  syncKey?: string | null;
  denySync?: boolean;
}

async function world(o: WorldOptions = {}) {
  const dir = tempDir(cleanup);
  const port = await freePort();
  let broker: TestBroker = await startTestBroker(port, { denySync: o.denySync });
  cleanup.push(() => broker.close());
  const fake = await FakeDahua.start({ heartbeatMs: 100 });
  cleanup.push(() => fake.close());

  // Faux PSIM : abonne aux accuses, publie les ordres en QoS 1 sans retain.
  const psim: MqttClient = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: 'faux-psim', clean: true, reconnectPeriod: 100, protocolVersion: 4 });
  cleanup.push(() => new Promise<void>((r) => psim.end(true, {}, () => r())));
  const acks: { topic: string; raw: string; ack: Ack | null }[] = [];
  psim.on('message', (topic, payload) => {
    const raw = payload.toString('utf8');
    acks.push({ topic, raw, ack: verifyAck(raw) });
  });
  await new Promise<void>((resolve, reject) => {
    psim.once('connect', () => psim.subscribe('psim/access/+/sync-ack', { qos: 1 }, (err) => (err ? reject(err) : resolve())));
  });

  const controller: Record<string, unknown> = {
    id: CTL,
    host: fake.host,
    port: fake.port,
    username: fake.username,
    password: fake.password,
    doors: { '1': 'P-ENTREE', '2': 'P-SALLE' },
  };
  if (o.syncKey !== null) controller.syncKey = o.syncKey ?? SYNC_KEY;
  const file = writeConfig(dir, {
    psim: { url: `mqtt://127.0.0.1:${port}`, username: 'gw1', password: 'Mot-de-passe-passerelle-1', detectors: ['P-*'] },
    dataDir: 'gw-data',
    retry: { minMs: 100, maxMs: 400 },
    moduleRetry: { minMs: 100, maxMs: 400 },
    log: { file: false },
    modules: [
      {
        name: 'acces-dahua',
        config: {
          stateDir: join(dir, 'acces-state'),
          controllers: [controller],
          thresholds: { offlineGraceMs: 500, silenceMs: 10_000, modeCheckS: 0 },
          reconnect: { minMs: 100, maxMs: 400 },
        },
      },
    ],
  });
  const logger = memoryLogger();
  const start = async () => {
    const rt = await startRuntime({ config: loadConfig(file), logger });
    cleanup.push(() => rt.stop());
    return rt;
  };
  const w = {
    dir,
    fake,
    psim,
    acks,
    logger,
    rt: await start(),
    broker: () => broker,
    /** Abonnements de la passerelle (client gamr-gw-gw1) a la synchronisation de CTL-1, sur le broker courant. */
    syncSubs: () => broker.subscribed.filter((s) => s.client === 'gamr-gw-gw1' && s.topic === `psim/access/${CTL}/sync`),
    publish: (payload: string, opts: { retain?: boolean } = {}) =>
      new Promise<void>((resolve, reject) => psim.publish(`psim/access/${CTL}/sync`, payload, { qos: 1, retain: opts.retain ?? false }, (err) => (err ? reject(err) : resolve()))),
    /** Publie l'ordre et attend son accuse (verifie). */
    async exchange(payload: string): Promise<Ack> {
      const before = acks.length;
      await w.publish(payload);
      await waitFor(() => acks.length > before, 15_000, 'accuse de synchronisation');
      const got = acks[before]!;
      assert.equal(got.topic, `psim/access/${CTL}/sync-ack`);
      assert.ok(got.ack, `accuse rejete par le faux PSIM : ${got.raw}`);
      const sent = JSON.parse(payload) as { opId: string; seq: number };
      assert.deepEqual([got.ack.opId, got.ack.seq], [sent.opId, sent.seq]);
      return got.ack;
    },
    async restartBroker(): Promise<void> {
      await broker.close();
      await waitFor(() => !w.rt.status().psim.connected, 10_000, 'liaison PSIM coupee');
      await sleep(200);
      broker = await startTestBroker(port, { denySync: o.denySync });
    },
    /** Arrete la passerelle, fait `between` pendant qu'elle est arretee, puis la redemarre (meme dossier de donnees). */
    async restartGateway(between?: () => Promise<void>): Promise<void> {
      await w.rt.stop();
      await between?.();
      w.rt = await start();
    },
  };
  return w;
}

type World = Awaited<ReturnType<typeof world>>;

async function ready(w: World): Promise<void> {
  await waitFor(() => w.rt.status().modules[0]?.state === 'running', 15_000, 'module demarre');
  await waitFor(() => w.syncSubs().length > 0, 15_000, 'abonnement a la synchronisation');
  await waitFor(() => w.fake.recordFinds > 0, 15_000, 'controleur joint');
}

const schedule = { type: 'upsert_schedule', scheduleRef: 'S1', windows: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '17:00' }], holidays: false };
const holder = {
  type: 'upsert_holder',
  holderRef: 'H101',
  name: 'KONAN Yao',
  active: true,
  validFrom: null,
  validTo: null,
  credentials: ['0012345'],
  doors: [{ doorNo: 1, scheduleRef: 'S1' }],
};
const holidays = { type: 'set_holidays', dates: ['2026-12-25', '2027-01-01'], replace: true };
const remove = { type: 'delete_holder', holderRef: 'H101' };
const syncRequests = (fake: FakeDahua) => fake.requests.filter((r) => /recordUpdater|recordFinder\.cgi\?action=find&name=AccessControl(Card|Holiday)\b|AccessTimeSchedule/.test(r.path)).length;

describe('bout en bout : faux PSIM signe -> broker -> socle -> module acces-dahua -> faux controleur', () => {
  it('plage, titulaire, jours feries, suppression : etat final du controleur et accuses signes ; rejeu = accuse reemis sans appel au controleur', { timeout: 90_000 }, async () => {
    const w = await world();
    await ready(w);
    assert.equal(w.syncSubs()[0]!.qos, 1, 'abonnement en QoS 1');

    const first = signOrder(1, schedule);
    const a1 = await w.exchange(first);
    assert.deepEqual(a1, { opId: (JSON.parse(first) as { opId: string }).opId, seq: 1, result: 'done', code: null, ts: a1.ts });
    assert.ok(Math.abs(a1.ts - Date.now()) < 10_000, "ts de l'accuse : heure de la passerelle");
    assert.equal(w.fake.schedules.get(1)?.Name, 'PSIM S1');
    assert.deepEqual(w.fake.schedules.get(1)?.TimeSchedule[1]?.[0], '1 08:00:00-17:00:00');

    const a2 = await w.exchange(signOrder(2, holder));
    assert.deepEqual([a2.result, a2.code], ['done', null]);
    const cards = w.fake.cardsOf('H101');
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.CardNo, '0012345');
    assert.equal(cards[0]!.CardName, 'KONAN Yao');
    assert.deepEqual(cards[0]!.TimeSections, [1], 'horaire S1 -> plage 1 du controleur');

    const a3 = await w.exchange(signOrder(3, holidays));
    assert.deepEqual([a3.result, a3.code], ['done', null]);
    assert.equal(w.fake.holidays.length, 2);

    const last = signOrder(4, remove);
    const a4 = await w.exchange(last);
    assert.deepEqual([a4.result, a4.code], ['done', null]);
    assert.equal(w.fake.cardsOf('H101').length, 0);
    assert.equal(w.fake.holidays.length, 2, 'les jours feries restent');
    assert.deepEqual(w.fake.forbidden, [], 'aucune donnee interdite recue par le controleur');

    // Rejeu du dernier ordre (accuse perdu cote PSIM) : accuse reemis, meme resultat, ts frais, AUCUN appel au controleur.
    await sleep(300);
    const calls = syncRequests(w.fake);
    const again = await w.exchange(last);
    assert.deepEqual([again.seq, again.result, again.code], [4, 'done', null]);
    assert.ok(again.ts >= a4.ts);
    await sleep(300);
    assert.equal(syncRequests(w.fake), calls, 'aucun nouvel appel au controleur');
    // Ancien ordre : ignore, aucun accuse.
    const n = w.acks.length;
    await w.publish(signOrder(2, holder));
    await sleep(600);
    assert.equal(w.acks.length, n);
    assert.equal(w.fake.cardsOf('H101').length, 0, 'le titulaire supprime n\'est pas recree');
    assert.equal(w.rt.status().accessSync.done, 4);
    // Le journal ne contient ni nom, ni badge, ni cle.
    const text = w.logger.lines.map((l) => l.text).join('\n');
    assert.equal(/KONAN|0012345|5a5a5a5a/.test(text), false, text);
  });

  it('signature fausse : aucun accuse, rien d\'ecrit ; message « retain » ignore ; le vrai ordre passe ensuite', { timeout: 60_000 }, async () => {
    const w = await world();
    await ready(w);
    const forged = JSON.parse(signOrder(1, holder)) as Record<string, unknown>;
    forged.sig = hmac('autre chose');
    await w.publish(JSON.stringify(forged));
    await w.publish(signOrder(1, holder, { key: 'ab'.repeat(32) }));
    await sleep(800);
    assert.equal(w.acks.length, 0);
    assert.equal(w.fake.cards.length, 0);
    assert.equal(w.rt.status().accessSync.ignored, 2);
    // Un ordre authentique CONSERVE par le broker (retain) est remis avec le drapeau « retain » au moment de l'abonnement :
    // jamais lu (il serait rejouable a chaque reconnexion).
    await w.restartGateway(() => w.publish(signOrder(1, holder), { retain: true }));
    await waitFor(() => w.syncSubs().length >= 2, 15_000, 'nouvel abonnement');
    await sleep(800);
    assert.equal(w.acks.length, 0);
    assert.equal(w.fake.cards.length, 0);
    // Efface le message conserve, puis le vrai ordre passe : le seq 1 n'avait pas ete consomme.
    await w.publish('', { retain: true });
    await waitFor(() => w.rt.status().modules[0]?.state === 'running', 15_000, 'module redemarre');
    const ok = await w.exchange(signOrder(1, { type: 'delete_holder', holderRef: 'H5' }));
    assert.deepEqual([ok.result, ok.code], ['done', null]);
  });

  it('coupure puis reprise de la liaison MQTT : abonnement refait, la synchronisation reprend, le seq est garde', { timeout: 90_000 }, async () => {
    const w = await world();
    await ready(w);
    const first = signOrder(1, schedule);
    await w.exchange(first);
    await w.restartBroker();
    await waitFor(() => w.rt.status().psim.connected, 20_000, 'liaison PSIM retablie');
    await waitFor(() => w.syncSubs().length > 0, 15_000, 'abonnement refait');
    await waitFor(() => w.psim.connected, 10_000, 'faux PSIM reconnecte');
    await sleep(200);
    const a = await w.exchange(signOrder(2, holder));
    assert.deepEqual([a.result, a.code], ['done', null]);
    assert.equal(w.fake.cardsOf('H101').length, 1);
    const n = w.acks.length;
    await w.publish(first);
    await sleep(600);
    assert.equal(w.acks.length, n, 'seq 1 deja depasse : ignore');
  });

  it('redemarrage de la passerelle : un seq ancien reste refuse, le dernier est reaccuse, le suivant est execute', { timeout: 90_000 }, async () => {
    const w = await world();
    await ready(w);
    const m1 = signOrder(1, schedule);
    const m2 = signOrder(2, holder);
    await w.exchange(m1);
    await w.exchange(m2);
    await w.restartGateway();
    await waitFor(() => w.rt.status().modules[0]?.state === 'running', 15_000, 'module redemarre');
    await waitFor(() => w.syncSubs().length >= 2, 15_000, 'nouvel abonnement');
    await sleep(300);
    const calls = syncRequests(w.fake);
    const n = w.acks.length;
    await w.publish(m1);
    await sleep(800);
    assert.equal(w.acks.length, n, 'seq 1 refuse apres le redemarrage');
    const again = await w.exchange(m2);
    assert.deepEqual([again.seq, again.result], [2, 'done']);
    await sleep(300);
    assert.equal(syncRequests(w.fake), calls, 'aucune reexecution');
    const a3 = await w.exchange(signOrder(3, remove));
    assert.deepEqual([a3.result, a3.code], ['done', null]);
    assert.equal(w.fake.cardsOf('H101').length, 0);
  });

  it('module sans syncKey : aucun abonnement, une ligne d\'information, les ordres restent sans effet', { timeout: 60_000 }, async () => {
    const w = await world({ syncKey: null });
    await waitFor(() => w.rt.status().modules[0]?.state === 'running', 15_000, 'module demarre');
    await waitFor(() => w.fake.recordFinds > 0, 15_000, 'controleur joint');
    await sleep(500);
    assert.equal(w.syncSubs().length, 0);
    const lines = w.logger.lines.filter((l) => /synchronisation des titulaires inactive pour CTL-1 \(pas de syncKey\)/.test(l.text));
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.level, 'info');
    await w.publish(signOrder(1, holder));
    await sleep(600);
    assert.equal(w.acks.length, 0);
    assert.equal(w.fake.cards.length, 0);
    assert.equal(w.rt.status().accessSync.controllers, 0);
  });

  it('liaison PSIM : watchSync / unwatchSync immediats, topic exact, identifiant pris dans le TOPIC, identifiant invalide refuse', { timeout: 60_000 }, async () => {
    const dir = tempDir(cleanup);
    const port = await freePort();
    const broker = await startTestBroker(port);
    cleanup.push(() => broker.close());
    const logger = memoryLogger();
    const queue = new DiskQueue(join(dir, 'q'), { maxMessages: 100, maxBytes: 1_000_000, log: logger });
    queue.open();
    cleanup.push(() => queue.close());
    const got: [string, string][] = [];
    const link = createPsimLink({
      url: `mqtt://127.0.0.1:${port}`,
      username: 'gw1',
      password: 'x',
      ca: null,
      clientId: 'gw-lien',
      queue,
      retry: { minMs: 100, maxMs: 400 },
      log: logger,
      accessSync: { onSync: (id, payload) => void got.push([id, payload.toString('utf8')]) },
    });
    cleanup.push(() => link.stop(0));
    assert.throws(() => link.watchSync('CTL 1'), /identifiant de controleur invalide/);
    assert.throws(() => link.watchSync('+'), /identifiant de controleur invalide/);
    link.watchSync('CTL-A'); // avant la connexion : applique a la connexion
    link.start();
    await waitFor(() => link.connected() && broker.subscribed.some((s) => s.client === 'gw-lien' && s.topic === 'psim/access/CTL-A/sync'), 10_000, 'abonnement a la connexion');
    link.watchSync('CTL-B'); // connecte : tout de suite
    link.watchSync('CTL-B'); // deja suivi : sans effet
    await waitFor(() => broker.subscribed.filter((s) => s.client === 'gw-lien' && s.topic === 'psim/access/CTL-B/sync').length === 1, 10_000, 'abonnement dynamique');
    assert.deepEqual(link.watchedSync().sort(), ['CTL-A', 'CTL-B']);
    const pub = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: 'pub', protocolVersion: 4 });
    cleanup.push(() => new Promise<void>((r) => pub.end(true, {}, () => r())));
    await new Promise<void>((r) => pub.once('connect', () => r()));
    const send = (topic: string, text: string) => new Promise<void>((r) => pub.publish(topic, text, { qos: 1 }, () => r()));
    await send('psim/access/CTL-A/sync', 'a');
    await send('psim/access/CTL-B/sync', 'b');
    await send('psim/access/CTL-C/sync', 'c'); // non suivi
    await send('psim/access/CTL-A/sync-ack', 'ack'); // autre topic
    await waitFor(() => got.length >= 2, 10_000, 'ordres recus');
    link.unwatchSync('CTL-A');
    link.unwatchSync('CTL-Z'); // jamais suivi : sans effet
    await sleep(300);
    await send('psim/access/CTL-A/sync', 'a2');
    await send('psim/access/CTL-B/sync', 'b2');
    await waitFor(() => got.length >= 3, 10_000, 'ordre apres desabonnement');
    await sleep(300);
    assert.deepEqual(got, [
      ['CTL-A', 'a'],
      ['CTL-B', 'b'],
      ['CTL-B', 'b2'],
    ]);
    assert.deepEqual(link.watchedSync(), ['CTL-B']);
  });

  it('abonnement refuse par le broker (SUBACK 128) : erreur claire nommant le controleur et PSIM_MQTT_GATEWAYS ; le module continue', { timeout: 60_000 }, async () => {
    const w = await world({ denySync: true });
    await waitFor(() => w.rt.status().modules[0]?.state === 'running', 15_000, 'module demarre');
    await waitFor(() => w.logger.has(/controleur CTL-1 non autorise pour ce compte \(voir la liste des controleurs d'acces de PSIM_MQTT_GATEWAYS\)/), 15_000, 'erreur d\'abonnement');
    const line = w.logger.lines.find((l) => /non autorise pour ce compte/.test(l.text))!;
    assert.equal(line.level, 'error');
    assert.equal(w.rt.status().modules[0]?.state, 'running');
  });
});
