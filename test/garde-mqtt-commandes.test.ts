/**
 * Garde-fous durables du broker MQTT embarque (server/mqtt.ts), issus de la revue de securite du canal de commande : vrais
 * clients MQTT contre le broker, droits des comptes de passerelle sur les ordres / accuses des actionneurs, et
 * non-regression des droits des detecteurs.
 *
 * « CONTROLE » : l'attaque est tentee et doit echouer (repris tels quels de la revue).
 * « GARDE-FOU » : ancien defaut de la revue (M1, M2, M3), retourne : l'essai ECHOUE si le defaut revient.
 *
 * Fichier autonome (aucune dependance sur le dossier de la revue). Lancer : node --test test/garde-mqtt-commandes.test.ts
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import mqtt from 'mqtt';
import type { IClientOptions, MqttClient } from 'mqtt';
import { signAck } from '../server/actuatorproto.ts';
import { parseAllowList } from '../server/actuatorhttp.ts';
import { createActuators } from '../server/actuators.ts';
import type { Actuators } from '../server/actuators.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { startBroker } from '../server/mqtt.ts';
import type { Broker } from '../server/mqtt.ts';
import { seedEmptySite } from '../server/seed.ts';

const MAIN = { user: 'psim', password: 'Mot-de-passe-mqtt-principal-1' };
const GW_A = { user: 'gw-a', password: 'Mot-de-passe-passerelle-A', detectors: ['D-A'], actuators: ['SIR-A', 'R-*'] };
const GW_B = { user: 'gw-b', password: 'Mot-de-passe-passerelle-B', detectors: [] as string[], actuators: ['SIR-B'] };
const GW_D = { user: 'gw-d', password: 'Mot-de-passe-passerelle-D', detectors: ['D-*'] };
/** Borne des abonnements aux ordres par connexion (MAX_COMMAND_SUBSCRIPTIONS de server/mqtt.ts, = MAX_ACTUATORS). */
const MAX_COMMAND_SUBSCRIPTIONS = 200;

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Attend qu'une condition devienne vraie (machine chargee : pas de delai fixe pour ce qui DOIT arriver). */
const until = async (cond: () => boolean, what: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`delai depasse : ${what}`);
    await wait(10);
  }
};
type Granted = { qos: number }[];
/** QoS accordees d'un SUBSCRIBE a plusieurs filtres (la bibliotheque leve une erreur des qu'un filtre est refuse). */
const grantedOf = (err: { packet?: { granted?: number[] } }): Granted => (err.packet?.granted ?? []).map((qos) => ({ qos }));

describe('garde-fous MQTT : elevation de privilege sur le canal de commande', { timeout: 120_000 }, () => {
  let dir = '';
  let broker: Broker;
  let url = '';
  let svc: Actuators;
  let keyA = '';
  let keyB = '';
  const acks: { id: string; size: number }[] = [];
  const clients: MqttClient[] = [];
  let db: ReturnType<typeof openDb>;

  const connect = async (user: string | undefined, password: string | undefined, extra: IClientOptions = {}): Promise<MqttClient> => {
    const c = mqtt.connect(url, { username: user, password, reconnectPeriod: 0, connectTimeout: 5000, ...extra });
    clients.push(c);
    c.on('error', () => {});
    await new Promise<void>((res, rej) => {
      c.once('connect', () => res());
      c.once('error', rej);
      c.once('close', () => rej(new Error('ferme')));
    });
    return c;
  };
  /** Connexion qui renvoie aussi le CONNACK (session restauree ou non) et ecoute les messages DES la connexion. */
  const connectListening = async (user: string, password: string, extra: IClientOptions) => {
    const c = mqtt.connect(url, { username: user, password, reconnectPeriod: 0, connectTimeout: 5000, ...extra });
    clients.push(c);
    c.on('error', () => {});
    const messages: { topic: string; text: string; qos: number }[] = [];
    c.on('message', (topic, p, packet) => messages.push({ topic, text: p.toString().slice(0, 60), qos: packet.qos }));
    const sessionPresent = await new Promise<boolean>((res, rej) => {
      c.once('connect', (connack) => res(connack.sessionPresent));
      c.once('error', rej);
    });
    return { c, messages, sessionPresent };
  };
  const sub = async (c: MqttClient, topic: string, qos: 0 | 1 | 2 = 1): Promise<number | undefined> => {
    try {
      return (await c.subscribeAsync(topic, { qos }))[0]?.qos;
    } catch (err) {
      const granted = (err as { packet?: { granted?: number[] } }).packet?.granted?.[0];
      if (granted === undefined) throw err;
      return granted;
    }
  };
  const ackFor = (key: string, id: string, cmdId: string) => JSON.stringify(signAck(key, id, { cmdId, result: 'done', ts: Date.now() }));

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'psim-garde-mqtt-'));
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
      gateways: [GW_A, GW_B, GW_D],
      onActuatorAck: (id, payload) => {
        acks.push({ id, size: payload.length });
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

  it('CONTROLE : client sans identifiant, mauvais mot de passe, compte de passerelle avec le mot de passe d un autre : refuses', async () => {
    await assert.rejects(connect(undefined, undefined));
    await assert.rejects(connect(GW_A.user, GW_B.password));
    await assert.rejects(connect('', ''));
  });

  it('CONTROLE : variantes de topic (casse, espaces, Unicode, segment vide, barre finale, joker, $share) refusees ; prefixe R-* non etendu', async () => {
    const a = await connect(GW_A.user, GW_A.password);
    const refused = [
      'psim/actuators/sir-a/command',
      'psim/actuators/SIR-A /command',
      'psim/actuators/SIR‐A/command',
      'psim/actuators//command',
      'psim/actuators/SIR-A/command/',
      'psim/actuators/SIR-A/command/#',
      'psim//actuators/SIR-A/command',
      '/psim/actuators/SIR-A/command',
      'psim/actuators/SIR-A/command\n',
      'PSIM/actuators/SIR-A/command',
      '+/actuators/SIR-A/command',
      '$share/x/psim/actuators/SIR-A/command',
      '$SYS/broker/clients/connected',
      'psim/actuators/R/command',
      'psim/actuators/r-1/command',
      'psim/actuators/SIR-B/command',
    ];
    for (const t of refused) assert.equal(await sub(a, t), 128, JSON.stringify(t));
    assert.equal(broker.actuatorListeners('SIR-B'), 0, 'aucun abonnement refuse ne compte comme une liaison');
    await a.endAsync(true);
  });

  it('GARDE-FOU M2 (documentation, connu et sans effet) : le SUBACK annonce la QoS DEMANDEE (2) alors que l abonnement est ramene a 0 ; la remise reelle est bien en QoS 0', async () => {
    const a = await connect(GW_A.user, GW_A.password);
    // Si aedes se met un jour a annoncer la QoS accordee (0), cette ligne changera : c'est une amelioration, pas une faille.
    assert.equal(await sub(a, 'psim/actuators/SIR-A/command', 2), 2, 'SUBACK : QoS 2 annoncee');
    const got: number[] = [];
    a.on('message', (_t, _p, packet) => got.push(packet.qos));
    await broker.publishCommand('SIR-A', Buffer.from('{"v":1}'));
    await until(() => got.length > 0, 'ordre remis');
    await wait(100);
    assert.deepEqual(got, [0], 'remise effective en QoS 0 (ce qui compte : jamais d ordre en file hors ligne)');
    await a.endAsync(true);
  });

  it('CONTROLE : reprise de session (meme clientId, clean:false) par une AUTRE passerelle : les ordres de A ne lui sont pas remis', async () => {
    const opts = { clean: false, clientId: 'identifiant-partage' };
    const first = await connect(GW_A.user, GW_A.password, opts);
    assert.notEqual(await sub(first, 'psim/actuators/SIR-A/command'), 128);
    await first.endAsync();
    await wait(100);
    const thief = await connect(GW_B.user, GW_B.password, opts);
    const got: string[] = [];
    thief.on('message', (t) => got.push(t));
    await wait(200);
    assert.equal(broker.actuatorListeners('SIR-A'), 0, 'la session restauree ne compte pas comme une liaison de SIR-A');
    await broker.publishCommand('SIR-A', Buffer.from('{"v":1}'));
    await wait(200);
    assert.deepEqual(got, [], 'B ne lit pas les ordres de SIR-A');
    await thief.endAsync(true);
  });

  it('CONTROLE : accuse trop gros (> 1 Ko), accuse publie par le compte principal ou une passerelle de detecteurs : jamais transmis', async () => {
    acks.length = 0;
    const a = await connect(GW_A.user, GW_A.password);
    a.publish('psim/actuators/SIR-A/ack', 'x'.repeat(1500), { qos: 1 });
    const d = await connect(GW_D.user, GW_D.password);
    d.publish('psim/actuators/SIR-A/ack', ackFor(keyA, 'SIR-A', 'e'.repeat(32)));
    const m = await connect(MAIN.user, MAIN.password);
    m.publish('psim/actuators/SIR-B/ack', ackFor(keyB, 'SIR-B', 'e'.repeat(32)));
    await wait(300);
    assert.deepEqual(acks, []);
  });

  it('CONTROLE : personne ne publie un ordre (passerelle autorisee, principal, detecteurs) ; une passerelle de detecteurs ne lit aucun ordre', async () => {
    const sim = await connect(GW_A.user, GW_A.password);
    const got: string[] = [];
    sim.on('message', (t, p) => got.push(`${t} ${p}`));
    await sub(sim, 'psim/actuators/SIR-A/command');
    for (const [u, p] of [[GW_A.user, GW_A.password], [MAIN.user, MAIN.password], [GW_D.user, GW_D.password]]) {
      const c = await connect(u, p);
      c.publish('psim/actuators/SIR-A/command', '{"v":1,"forge":true}', { qos: 1 });
    }
    const d = await connect(GW_D.user, GW_D.password);
    assert.equal(await sub(d, 'psim/actuators/SIR-A/command'), 128);
    await wait(300);
    assert.deepEqual(got, []);
    await sim.endAsync(true);
  });

  it("NON-REGRESSION detecteurs : un compte d'actionneurs seuls (detectors: []) ne publie l'etat d'AUCUN detecteur ; une passerelle de detecteurs ne gagne aucun droit", async () => {
    const watcher = await connect(MAIN.user, MAIN.password);
    const seen: string[] = [];
    watcher.on('message', (t) => seen.push(t));
    assert.notEqual(await sub(watcher, 'psim/detectors/+/state'), 128);
    const b = await connect(GW_B.user, GW_B.password);
    b.publish('psim/detectors/D-A/state', JSON.stringify({ state: 'alarm' }), { qos: 1 });
    b.publish('psim/detectors/ANY/state', JSON.stringify({ state: 'alarm' }), { qos: 1 });
    const d = await connect(GW_D.user, GW_D.password);
    for (const t of ['psim/detectors/+/state', 'psim/detectors/D-1/state', '#']) assert.equal(await sub(d, t), 128, t);
    const d2 = await connect(GW_D.user, GW_D.password);
    d2.publish('psim/detectors/X-1/state', JSON.stringify({ state: 'alarm' }), { qos: 1 });
    await wait(300);
    assert.deepEqual(seen, [], 'aucun etat de detecteur forge');
    await watcher.endAsync(true);
  });

  it('GARDE-FOU M1 : un compte a prefixe (R-*) ne s abonne pas a plus de 200 ordres par connexion (SUBACK 128 au-dela) ; place liberee au desabonnement et a la deconnexion', async () => {
    const a = await connect(GW_A.user, GW_A.password);
    const topics: Record<string, { qos: 0 }> = {};
    for (let i = 0; i < 3000; i++) topics[`psim/actuators/R-${i}/command`] = { qos: 0 };
    const granted = await a.subscribeAsync(topics).catch(grantedOf);
    assert.equal(granted.length, 3000);
    assert.equal(granted.filter((g) => g.qos !== 128).length, MAX_COMMAND_SUBSCRIPTIONS, `${MAX_COMMAND_SUBSCRIPTIONS} accordes au plus`);
    assert.ok(granted.slice(0, MAX_COMMAND_SUBSCRIPTIONS).every((g) => g.qos === 0), 'les premiers du paquet sont accordes');
    assert.ok(granted.slice(MAX_COMMAND_SUBSCRIPTIONS).every((g) => g.qos === 128), 'tous les suivants refuses');
    assert.equal(broker.actuatorListeners('R-0'), 1);
    assert.equal(broker.actuatorListeners(`R-${MAX_COMMAND_SUBSCRIPTIONS - 1}`), 1);
    assert.equal(broker.actuatorListeners(`R-${MAX_COMMAND_SUBSCRIPTIONS}`), 0, 'refuse = pas de liaison');
    assert.equal(broker.actuatorListeners('R-2999'), 0);
    // Meme a la limite : un actionneur LEGITIME en plus est refuse, un abonnement deja accorde se renouvelle sans compter.
    assert.equal(await sub(a, 'psim/actuators/SIR-A/command', 0), 128, 'limite atteinte');
    assert.equal(await sub(a, 'psim/actuators/R-0/command', 0), 0, 'renouvellement d un abonnement deja accorde');
    // Un desabonnement libere une place.
    await a.unsubscribeAsync('psim/actuators/R-0/command');
    await until(() => broker.actuatorListeners('R-0') === 0, 'desabonnement suivi');
    assert.equal(await sub(a, 'psim/actuators/SIR-A/command', 0), 0, 'place liberee');
    assert.equal(await sub(a, 'psim/actuators/R-0/command', 0), 128, 'de nouveau a la limite');
    // La borne est par connexion : une autre connexion du meme compte a sa propre place.
    const a2 = await connect(GW_A.user, GW_A.password);
    assert.equal(await sub(a2, 'psim/actuators/R-2999/command', 0), 0);
    await a.endAsync(true);
    await a2.endAsync(true);
    await until(() => broker.actuatorListeners('R-1') === 0 && broker.actuatorListeners('SIR-A') === 0, 'libere a la deconnexion');
    assert.equal(broker.actuatorListeners('R-2999'), 0);
  });

  it('GARDE-FOU M1 : session persistante d un compte a prefixe : apres reprise, la borne tient toujours', async () => {
    const opts = { clean: false, clientId: 'passerelle-prefixe-persistante' };
    const a = await connect(GW_A.user, GW_A.password, opts);
    const topics: Record<string, { qos: 0 }> = {};
    for (let i = 0; i < 400; i++) topics[`psim/actuators/R-${i}/command`] = { qos: 0 };
    const granted = await a.subscribeAsync(topics).catch(grantedOf);
    assert.equal(granted.filter((g) => g.qos !== 128).length, MAX_COMMAND_SUBSCRIPTIONS);
    await a.endAsync();
    await until(() => broker.actuatorListeners('R-0') === 0, 'deconnexion suivie');
    const back = await connectListening(GW_A.user, GW_A.password, opts);
    assert.equal(back.sessionPresent, true, 'la session legitime est conservee');
    await until(() => broker.actuatorListeners(`R-${MAX_COMMAND_SUBSCRIPTIONS - 1}`) === 1, 'abonnements restaures');
    assert.equal(broker.actuatorListeners(`R-${MAX_COMMAND_SUBSCRIPTIONS}`), 0, 'les refuses ne sont pas memorises');
    assert.equal(await sub(back.c, 'psim/actuators/R-399/command'), 128, 'borne toujours atteinte apres reprise');
    await back.c.endAsync(true);
  });

  /** Rejoue l'attaque M3 : SUBSCRIBE mixte (ordre legitime + jokers), absence, messages QoS 1 d'autres comptes, retour. */
  const replayM3 = async (clientId: string, order: 'command-first' | 'wildcards-first') => {
    const opts = { clean: false, clientId };
    const thief = await connect(GW_B.user, GW_B.password, opts);
    const filters: Record<string, { qos: 0 | 1 }> =
      order === 'command-first'
        ? { 'psim/actuators/SIR-B/command': { qos: 0 }, '#': { qos: 1 }, 'psim/detectors/+/state': { qos: 1 } }
        : { '#': { qos: 1 }, 'psim/detectors/+/state': { qos: 1 }, 'psim/actuators/+/ack': { qos: 1 }, 'psim/actuators/SIR-B/command': { qos: 1 } };
    const granted = await thief.subscribeAsync(filters).catch(grantedOf);
    const byTopic = Object.fromEntries(Object.keys(filters).map((t, i) => [t, granted[i]?.qos]));
    assert.notEqual(byTopic['psim/actuators/SIR-B/command'], 128, 'son topic d ordres est accorde');
    for (const t of Object.keys(filters)) if (t !== 'psim/actuators/SIR-B/command') assert.equal(byTopic[t], 128, `joker refuse : ${t}`);
    // En ligne : aucun message etranger remis en direct non plus.
    const live: string[] = [];
    thief.on('message', (t) => live.push(t));
    const d = await connect(GW_D.user, GW_D.password);
    await d.publishAsync('psim/detectors/D-6/state', JSON.stringify({ state: 'alarm', note: 'en ligne' }), { qos: 1 });
    await wait(150);
    assert.deepEqual(live, [], 'rien d etranger en direct');
    await thief.endAsync();
    await wait(150);
    // Pendant l'absence : une autre passerelle publie l'etat d'un detecteur et un accuse, en QoS 1 ; le PSIM publie aussi.
    await d.publishAsync('psim/detectors/D-7/state', JSON.stringify({ state: 'alarm', note: 'confidentiel' }), { qos: 1 });
    const a = await connect(GW_A.user, GW_A.password);
    await a.publishAsync('psim/actuators/SIR-A/ack', ackFor(keyA, 'SIR-A', '9'.repeat(32)), { qos: 1 });
    await broker.publishDetectorState('D-8', 'alarm');
    await broker.publishCommand('SIR-A', Buffer.from('{"v":1,"absent":true}'));
    await wait(150);
    const back = await connectListening(GW_B.user, GW_B.password, opts);
    assert.equal(back.sessionPresent, true, 'la session legitime (ordres de SIR-B) est conservee');
    // Temoin : un ordre de SIR-B publie apres le retour DOIT arriver (l'abonnement legitime a ete restaure).
    await until(() => broker.actuatorListeners('SIR-B') === 1, 'abonnement restaure');
    await broker.publishCommand('SIR-B', Buffer.from('{"v":1,"temoin":true}'));
    await until(() => back.messages.some((m) => m.topic === 'psim/actuators/SIR-B/command'), 'temoin recu');
    await wait(400); // laisse a la file hors ligne le temps de se vider
    const foreign = back.messages.filter((m) => m.topic !== 'psim/actuators/SIR-B/command');
    assert.deepEqual(foreign, [], `aucun message etranger remis au retour : ${JSON.stringify(foreign)}`);
    assert.deepEqual(back.messages.map((m) => m.qos), [0], 'seul le temoin, en QoS 0');
    await back.c.endAsync(true);
    await d.endAsync(true);
    await a.endAsync(true);
  };

  it("GARDE-FOU M3 (confidentialite) : une passerelle d'actionneurs glisse « # » et « psim/detectors/+/state » dans le MEME SUBSCRIBE que son topic d'ordres (clean:false) : au retour, AUCUN etat de detecteur d'une autre passerelle ni accuse d'un autre actionneur, meme publies en QoS 1 pendant son absence", async () => {
    await replayM3('passerelle-curieuse', 'command-first');
  });

  it('GARDE-FOU M3 (variante) : jokers PLACES AVANT le topic d ordres, accuses en joker, abonnement legitime demande en QoS 1 : meme resultat', async () => {
    await replayM3('passerelle-curieuse-2', 'wildcards-first');
  });

  it('GARDE-FOU M3 (variante) : reprise par une passerelle de la session persistante du compte PRINCIPAL (meme clientId) : aucun etat de detecteur ne lui est remis, ni a la reprise ni au retour suivant', async () => {
    const opts = { clean: false, clientId: 'session-du-principal' };
    const main = await connect(MAIN.user, MAIN.password, opts);
    assert.equal(await sub(main, 'psim/detectors/+/state', 1), 1, 'droit du compte principal (outil de recette)');
    await main.endAsync();
    await wait(100);
    const d = await connect(GW_D.user, GW_D.password);
    await d.publishAsync('psim/detectors/D-10/state', JSON.stringify({ state: 'alarm', note: 'avant reprise' }), { qos: 1 });
    await wait(100);
    const thief = await connectListening(GW_B.user, GW_B.password, opts);
    await wait(300);
    assert.deepEqual(thief.messages, [], 'rien a la reprise de la session');
    // Pendant que la passerelle tient la session, puis pendant son absence.
    await d.publishAsync('psim/detectors/D-11/state', JSON.stringify({ state: 'alarm', note: 'pendant reprise' }), { qos: 1 });
    await wait(100);
    await thief.c.endAsync();
    await wait(100);
    await d.publishAsync('psim/detectors/D-12/state', JSON.stringify({ state: 'alarm', note: 'absence' }), { qos: 1 });
    await wait(100);
    const back = await connectListening(GW_B.user, GW_B.password, opts);
    await wait(400);
    assert.deepEqual(back.messages, [], `rien au retour suivant : ${JSON.stringify(back.messages)}`);
    await back.c.endAsync(true);
    await d.endAsync(true);
  });

  it('TEMOIN M3 : le compte principal (clean:false) recoit bien, au retour, les etats de detecteurs QoS 1 publies pendant son absence ; jamais les accuses', async () => {
    const opts = { clean: false, clientId: 'principal-persistant' };
    const main = await connect(MAIN.user, MAIN.password, opts);
    assert.equal(await sub(main, 'psim/detectors/+/state', 1), 1);
    await main.endAsync();
    await wait(100);
    const d = await connect(GW_D.user, GW_D.password);
    await d.publishAsync('psim/detectors/D-20/state', JSON.stringify({ state: 'alarm' }), { qos: 1 });
    const a = await connect(GW_A.user, GW_A.password);
    await a.publishAsync('psim/actuators/SIR-A/ack', ackFor(keyA, 'SIR-A', '8'.repeat(32)), { qos: 1 });
    await wait(100);
    const back = await connectListening(MAIN.user, MAIN.password, opts);
    await until(() => back.messages.some((m) => m.topic === 'psim/detectors/D-20/state'), 'etat mis en file remis au principal');
    await wait(200);
    assert.deepEqual(back.messages.map((m) => m.topic), ['psim/detectors/D-20/state'], 'ni accuse ni autre topic');
    await back.c.endAsync(true);
    await d.endAsync(true);
    await a.endAsync(true);
  });

  it('CONTROLE : rafale de 2 000 accuses mal signes : journalisee une seule fois par minute', async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'commande_accuse_invalide'").get() as { n: number }).n;
    const a = await connect(GW_A.user, GW_A.password);
    const bad = JSON.stringify({ v: 1, cmdId: 'f'.repeat(32), result: 'done', ts: Date.now(), sig: '0'.repeat(64) });
    for (let i = 0; i < 2000; i++) a.publish('psim/actuators/SIR-A/ack', bad);
    await wait(1500);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'commande_accuse_invalide'").get() as { n: number }).n;
    assert.ok(n - before <= 1, `${n - before} entrees`);
  });
});
