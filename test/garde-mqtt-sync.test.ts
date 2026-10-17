/**
 * Garde-fous du broker MQTT embarque (server/mqtt.ts) pour la synchronisation des titulaires PSIM -> controleurs
 * (docs/CONTROLE-ACCES.md § 7, docs/ACCES.md § 11.4) : vrais clients MQTT contre un vrai broker sur un port libre.
 *
 * « CONTROLE » : l'attaque est tentee et doit echouer.
 * « GARDE-FOU » : propriete a conserver (rattachement relu en base a chaque autorisation, plafonds, QoS...) ; l'essai ECHOUE si elle disparait.
 * « TEMOIN » : le chemin legitime fonctionne (sans lui, un refus pourrait n'etre qu'un message jamais envoye).
 * Le dernier bloc est la CHAINE COMPLETE : vrai broker + vrai moteur de synchronisation (server/accesssync.ts) + fausse passerelle.
 *
 * Lancer : node --test test/garde-mqtt-sync.test.ts
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import mqtt from 'mqtt';
import type { IClientOptions, MqttClient } from 'mqtt';
import { migrateAccess } from '../server/access.ts';
import type { DesiredState, RightsListener, RightsSource, SyncService } from '../server/accessholderstypes.ts';
import { createSync, orderString, signAck, signOrder } from '../server/accesssync.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { startBroker } from '../server/mqtt.ts';
import type { Broker } from '../server/mqtt.ts';
import { seedEmptySite } from '../server/seed.ts';

const MAIN = { user: 'psim', password: 'Mot-de-passe-mqtt-principal-1' };
const GW_A = { user: 'gw-a', password: 'Mot-de-passe-passerelle-A', detectors: ['D-A'], actuators: ['SIR-A'] };
const GW_B = { user: 'gw-b', password: 'Mot-de-passe-passerelle-B', detectors: [] as string[] };
const GW_D = { user: 'gw-d', password: 'Mot-de-passe-passerelle-D', detectors: ['D-*'] };
/** Compte dont `controllerOwned` repond toujours vrai : isole les refus dus au FORMAT du topic de ceux dus au rattachement. */
const GW_ALL = { user: 'gw-all', password: 'Mot-de-passe-passerelle-ALL', detectors: [] as string[] };
const MAX_SYNC_SUBSCRIPTIONS = 200;
const BROKER_MAX = 1024;

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

const syncTopic = (c: string) => `psim/access/${c}/sync`;
const ackTopic = (c: string) => `psim/access/${c}/sync-ack`;

interface Received {
  topic: string;
  text: string;
  qos: number;
  retain: boolean;
  bytes: number;
}

/** Rattachement controleur -> compte, modifiable a tout moment par les essais (comme la base du PSIM). */
const owner = new Map<string, string>();
let ownerCalls = 0;
let ownerFails = false;

describe('garde-fous MQTT : synchronisation des titulaires (droits, QoS, bornes)', { timeout: 120_000 }, () => {
  let broker: Broker;
  let url = '';
  let db: ReturnType<typeof openDb>;
  const clients: MqttClient[] = [];
  const acks: { id: string; text: string; size: number }[] = [];
  const gatewayMessages: string[] = [];
  let ackShouldThrow = false;

  const connect = async (account: { user: string; password: string } | null, extra: IClientOptions = {}): Promise<MqttClient> => {
    const c = mqtt.connect(url, { username: account?.user, password: account?.password, reconnectPeriod: 0, connectTimeout: 5000, ...extra });
    clients.push(c);
    c.on('error', () => {});
    await new Promise<void>((res, rej) => {
      c.once('connect', () => res());
      c.once('error', rej);
      c.once('close', () => rej(new Error('ferme')));
    });
    return c;
  };
  /** Collecte tout ce que le client recoit. */
  const collect = (c: MqttClient): Received[] => {
    const got: Received[] = [];
    c.on('message', (topic, p, packet) => got.push({ topic, text: p.toString().slice(0, 80), qos: packet.qos, retain: packet.retain, bytes: p.length }));
    return got;
  };
  /** Connexion qui ecoute DES le CONNACK (messages en file remis a la reprise d'une session persistante). */
  const connectListening = async (account: { user: string; password: string }, extra: IClientOptions) => {
    const c = mqtt.connect(url, { username: account.user, password: account.password, reconnectPeriod: 0, connectTimeout: 5000, ...extra });
    clients.push(c);
    c.on('error', () => {});
    const messages = collect(c);
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
  const own = (controller: string, user: string) => owner.set(controller, user);

  before(async () => {
    db = openDb(':memory:');
    seedEmptySite(db);
    const engine = createEngine(db, () => {});
    const port = await freePort();
    url = `mqtt://127.0.0.1:${port}`;
    broker = await startBroker(engine, {
      host: '127.0.0.1',
      port,
      user: MAIN.user,
      password: MAIN.password,
      gateways: [GW_A, GW_B, GW_D, GW_ALL],
      controllerOwned: (user, controller) => {
        ownerCalls++;
        if (ownerFails) throw new Error('base illisible');
        return user === GW_ALL.user || owner.get(controller) === user;
      },
      onAccessSyncAck: (id, payload) => {
        acks.push({ id, text: payload.toString().slice(0, 40), size: payload.length });
        if (ackShouldThrow) throw new Error('gestionnaire en panne');
      },
      onGatewayMessage: (user) => gatewayMessages.push(user),
    });
  });
  after(async () => {
    for (const c of clients) await c.endAsync(true).catch(() => {});
    await broker?.close();
    db?.close();
  });

  it('CONTROLE : une AUTRE passerelle ne s abonne pas au sync d un controleur qui n est pas le sien, ni ne publie un sync-ack pour lui', async () => {
    own('CTL-A', GW_A.user);
    own('CTL-B', GW_B.user);
    const b = await connect(GW_B);
    assert.equal(await sub(b, syncTopic('CTL-A')), 128);
    assert.equal(broker.syncListeners('CTL-A'), 0, 'un abonnement refuse ne compte pas comme une liaison');
    assert.equal(await sub(b, syncTopic('CTL-B')), 1, 'TEMOIN : le sien est accorde');
    acks.length = 0;
    const forger = await connect(GW_B);
    forger.publish(ackTopic('CTL-A'), '{"forge":true}', { qos: 1 });
    const d = await connect(GW_D); // passerelle de detecteurs, aucun controleur
    d.publish(ackTopic('CTL-A'), '{"forge":true}', { qos: 1 });
    await wait(300);
    assert.equal(acks.length, 0, 'aucun accuse forge transmis');
    const a = await connect(GW_A);
    a.publish(ackTopic('CTL-A'), '{"ok":true}', { qos: 1 });
    await until(() => acks.length === 1, 'TEMOIN : accuse du proprietaire transmis');
    assert.equal(acks[0].id, 'CTL-A');
  });

  it('CONTROLE : jokers et variantes de topic refuses (#, +, psim/access/+/sync, psim/#, sync-ack, casse, barre finale, $share...), meme pour le proprietaire', async () => {
    own('CTL-A', GW_A.user);
    const a = await connect(GW_A);
    const refused = [
      '#',
      '+',
      '+/+/+/+',
      'psim/#',
      'psim/access/#',
      'psim/access/+/sync',
      'psim/access/+/+',
      'psim/access/CTL-A/#',
      'psim/access/CTL-A/+',
      'psim/access/CTL-A/sync/#',
      'psim/access/CTL-A/sync/',
      'psim/access/CTL-A/sync-ack',
      'psim/access/+/sync-ack',
      'psim/access/ctl-a/sync',
      'PSIM/access/CTL-A/sync',
      '/psim/access/CTL-A/sync',
      'psim//access/CTL-A/sync',
      'psim/access/CTL-A /sync',
      'psim/access/CTL-A/sync\n',
      '$share/x/psim/access/CTL-A/sync',
      '$SYS/#',
      'psim/access/CTL-B/sync',
    ];
    for (const t of refused) assert.equal(await sub(a, t), 128, JSON.stringify(t));
    assert.equal(broker.syncListeners('CTL-A'), 0);
    assert.equal(await sub(a, syncTopic('CTL-A')), 1, 'TEMOIN : le topic exact est accorde apres tous ces refus (connexion non coupee)');
    // Meme refus dans un SUBSCRIBE mixte : le filtre legitime est accorde, les autres refuses un par un.
    const mixed = await a.subscribeAsync({ '#': { qos: 1 }, [syncTopic('CTL-A')]: { qos: 1 }, 'psim/access/+/sync': { qos: 1 } }).catch(grantedOf);
    assert.deepEqual(mixed.map((g) => g.qos), [128, 1, 128]);
  });

  it('CONTROLE : le compte principal (outil de recette) n a aucun droit sur sync ni sync-ack ; ses droits sur les detecteurs sont intacts', async () => {
    own('CTL-A', GW_A.user);
    const m = await connect(MAIN);
    for (const t of [syncTopic('CTL-A'), ackTopic('CTL-A'), 'psim/access/+/sync', 'psim/access/#', '#']) assert.equal(await sub(m, t), 128, t);
    assert.equal(await sub(m, 'psim/detectors/+/state'), 1, 'NON-REGRESSION : detecteurs');
    acks.length = 0;
    const m2 = await connect(MAIN);
    m2.publish(ackTopic('CTL-A'), '{"principal":true}', { qos: 1 });
    await wait(300);
    assert.equal(acks.length, 0);
  });

  it('CONTROLE : aucun client ne publie sur sync (proprietaire, autre passerelle, principal) ; l ordre du PSIM, lui, arrive', async () => {
    own('CTL-A', GW_A.user);
    const a = await connect(GW_A);
    const got = collect(a);
    assert.equal(await sub(a, syncTopic('CTL-A')), 1);
    for (const account of [GW_A, GW_B, MAIN, GW_D, GW_ALL]) {
      const c = await connect(account);
      c.publish(syncTopic('CTL-A'), '{"forge":true}', { qos: 1 });
      c.publish(syncTopic('CTL-A'), '{"forge":true,"retain":true}', { qos: 0, retain: true });
    }
    await wait(300);
    assert.equal(got.length, 0, 'rien de forge remis');
    assert.equal(broker.publishSync('CTL-A', '{"v":1,"ordre":"psim"}'), true);
    await until(() => got.length === 1, 'TEMOIN : ordre du PSIM remis');
    assert.equal(got[0].text, '{"v":1,"ordre":"psim"}');
  });

  it('CONTROLE : un client ne recoit JAMAIS un sync-ack (SUBSCRIBE mixte avec jokers, en ligne et en session clean:false hors ligne)', async () => {
    own('CTL-V', GW_A.user);
    own('CTL-W', GW_B.user);
    const opts = { clean: false, clientId: 'passerelle-a-curieuse-ack' };
    const filters = {
      [syncTopic('CTL-V')]: { qos: 1 as const },
      '#': { qos: 1 as const },
      'psim/access/+/sync-ack': { qos: 1 as const },
      [ackTopic('CTL-V')]: { qos: 1 as const },
      [ackTopic('CTL-W')]: { qos: 1 as const },
    };
    const first = await connect(GW_A, opts);
    const live = collect(first);
    const granted = await first.subscribeAsync(filters).catch(grantedOf);
    assert.deepEqual(granted.map((g) => g.qos), [1, 128, 128, 128, 128]);
    // Un accuse legitime (B) puis le sien, pendant que A est EN LIGNE.
    const b = await connect(GW_B);
    b.publish(ackTopic('CTL-W'), '{"b":1}', { qos: 1 });
    first.publish(ackTopic('CTL-V'), '{"a":1}', { qos: 1 });
    await until(() => acks.some((x) => x.text === '{"a":1}') && acks.some((x) => x.text === '{"b":1}'), 'accuses transmis au PSIM');
    await wait(150);
    assert.deepEqual(live, [], 'aucun accuse remis en direct');
    // Hors ligne : accuses en QoS 1 + un ordre du PSIM mis en file par un autre abonne autorise.
    await first.endAsync();
    await until(() => broker.syncListeners('CTL-V') === 0, 'deconnexion suivie');
    const relay = await connect(GW_A);
    assert.equal(await sub(relay, syncTopic('CTL-V')), 1);
    const b2 = await connect(GW_B);
    await b2.publishAsync(ackTopic('CTL-W'), '{"b":2}', { qos: 1 });
    await relay.publishAsync(ackTopic('CTL-V'), '{"a":2}', { qos: 1 });
    assert.equal(broker.publishSync('CTL-V', '{"ordre":"absent"}'), true);
    await wait(150);
    const back = await connectListening(GW_A, opts);
    assert.equal(back.sessionPresent, true);
    await until(() => back.messages.some((m) => m.topic === syncTopic('CTL-V')), 'TEMOIN : ordre mis en file remis au retour');
    await wait(400);
    assert.deepEqual(back.messages.map((m) => m.topic), [syncTopic('CTL-V')], 'ni accuse ni autre topic');
    assert.equal(back.messages[0].qos, 1);
  });

  /** Reaffectation du controleur (la fonction `controllerOwned` change) : plus aucune remise, ni en direct ni depuis la file. */
  const reassignScenario = async (id: string, reassign: boolean) => {
    const c = `CTL-${id}`;
    own(c, GW_A.user);
    const opts = { clean: false, clientId: `gw-a-persistante-${id}` };
    const a1 = await connect(GW_A, opts);
    assert.equal(await sub(a1, syncTopic(c)), 1);
    await a1.endAsync();
    await until(() => broker.syncListeners(c) === 0, 'deconnexion suivie');
    // Un autre acces de la meme passerelle reste en ligne : le PSIM publie, l'ordre est mis en file pour a1 (QoS 1, hors ligne).
    const a2 = await connect(GW_A);
    const liveA2 = collect(a2);
    assert.equal(await sub(a2, syncTopic(c)), 1);
    assert.equal(broker.publishSync(c, '{"v":1,"seq":1}'), true);
    await until(() => liveA2.length === 1, 'a2 recoit l ordre');
    if (reassign) own(c, GW_B.user);
    const back = await connectListening(GW_A, opts);
    assert.equal(back.sessionPresent, true, 'la session est conservee');
    await wait(500);
    if (!reassign) {
      assert.deepEqual(back.messages.map((m) => [m.topic, m.qos, m.retain, m.text]), [[syncTopic(c), 1, false, '{"v":1,"seq":1}']], 'TEMOIN : ordre mis en file remis');
      await back.c.endAsync(true);
      await a2.endAsync(true);
      return;
    }
    assert.deepEqual(back.messages, [], 'controleur reaffecte : rien depuis la file de la session persistante');
    // En direct : a2 est reste abonne (suivi perime) mais n'a plus droit ; B, nouveau proprietaire, est seul autorise.
    assert.equal(broker.syncListeners(c), 0, 'plus aucun abonne autorise');
    assert.equal(broker.publishSync(c, '{"v":1,"seq":2}'), false, 'personne d autorise : refus synchrone');
    const b = await connect(GW_B);
    const liveB = collect(b);
    assert.equal(await sub(b, syncTopic(c)), 1);
    assert.equal(broker.syncListeners(c), 1);
    liveA2.length = 0;
    assert.equal(broker.publishSync(c, '{"v":1,"seq":3}'), true);
    await until(() => liveB.length === 1, 'le nouveau proprietaire recoit');
    await wait(300);
    assert.deepEqual(liveA2, [], 'l ancien proprietaire, encore connecte et abonne, ne recoit plus rien');
    assert.deepEqual(back.messages, [], 'ni la session reprise');
    assert.equal(liveB[0].text, '{"v":1,"seq":3}');
    // Il n'a plus non plus le droit de publier un accuse pour ce controleur.
    acks.length = 0;
    a2.publish(ackTopic(c), '{"ancien":true}', { qos: 1 });
    await wait(300);
    assert.equal(acks.length, 0, 'accuse de l ancien proprietaire refuse');
    await b.endAsync(true);
    await back.c.endAsync(true);
    await a2.endAsync(true);
  };
  it('TEMOIN : sans reaffectation, l ordre mis en file pour une session clean:false est remis au retour (QoS 1, sans retain)', async () => {
    await reassignScenario('T1', false);
  });
  it('CONTROLE : reaffectation du controleur a une autre passerelle : plus de remise, ni en direct ni depuis la file d une session clean:false ; plus d accuse accepte', async () => {
    await reassignScenario('R1', true);
  });

  it('CONTROLE : reprise de la session persistante d une passerelle par un AUTRE compte (meme clientId) : ni ordres mis en file, ni liaison', async () => {
    own('CTL-S', GW_A.user);
    own('CTL-S2', GW_B.user);
    const opts = { clean: false, clientId: 'identifiant-partage-sync' };
    const first = await connect(GW_A, opts);
    assert.equal(await sub(first, syncTopic('CTL-S')), 1);
    await first.endAsync();
    await until(() => broker.syncListeners('CTL-S') === 0, 'deconnexion suivie');
    const relay = await connect(GW_A);
    assert.equal(await sub(relay, syncTopic('CTL-S')), 1);
    assert.equal(broker.publishSync('CTL-S', '{"v":1,"secret":"A"}'), true);
    const thief = await connectListening(GW_B, opts);
    await wait(400);
    assert.deepEqual(thief.messages, [], 'B ne lit pas les ordres de A');
    assert.equal(broker.syncListeners('CTL-S'), 1, 'seul le relais legitime est une liaison');
    // B conserve ses propres droits sur son controleur.
    assert.equal(await sub(thief.c, syncTopic('CTL-S2')), 1);
    await thief.c.endAsync(true);
  });

  it('GARDE-FOU : publishSync renvoie faux sans abonne autorise, vrai avec un abonne ; QoS 1, jamais retain ; retombe a faux a la deconnexion', async () => {
    own('CTL-P', GW_A.user);
    assert.equal(broker.publishSync('CTL-P', '{"v":1}'), false, 'aucun abonne');
    assert.equal(broker.syncListeners('CTL-P'), 0);
    const a = await connect(GW_A);
    const got = collect(a);
    // Meme en demandant QoS 2, l'abonnement est plafonne a 1 (voir le SUBACK : la bibliotheque annonce la QoS demandee, comme pour les actionneurs).
    await sub(a, syncTopic('CTL-P'), 2);
    assert.equal(broker.syncListeners('CTL-P'), 1);
    assert.equal(broker.publishSync('CTL-P', '{"v":1,"n":1}'), true);
    await until(() => got.length === 1, 'ordre remis');
    assert.deepEqual([got[0].qos, got[0].retain], [1, false], 'QoS 1 et sans retain');
    assert.equal(got[0].topic, syncTopic('CTL-P'));
    // Un nouvel abonne ne recoit AUCUN message conserve.
    const late = await connect(GW_A);
    const lateGot = collect(late);
    await sub(late, syncTopic('CTL-P'), 1);
    await wait(400);
    assert.deepEqual(lateGot, [], 'rien de conserve pour un nouvel abonne');
    // Le renouvellement d'abonnement ne double pas la liaison.
    await sub(a, syncTopic('CTL-P'), 1);
    assert.equal(broker.syncListeners('CTL-P'), 2, 'deux connexions, deux liaisons (pas trois)');
    await late.endAsync(true);
    await a.unsubscribeAsync(syncTopic('CTL-P'));
    await until(() => broker.syncListeners('CTL-P') === 0, 'desabonnement suivi');
    assert.equal(broker.publishSync('CTL-P', '{"v":1,"n":2}'), false, 'desabonne : faux');
    await sub(a, syncTopic('CTL-P'), 1);
    assert.equal(broker.publishSync('CTL-P', '{"v":1,"n":3}'), true);
    await a.endAsync(true);
    await until(() => broker.syncListeners('CTL-P') === 0, 'deconnexion suivie');
    assert.equal(broker.publishSync('CTL-P', '{"v":1,"n":4}'), false, 'deconnecte : faux');
  });

  it('GARDE-FOU : un message de plus de 1 024 octets est refuse dans les deux sens (octets, pas caracteres) ; 1 024 passe', async () => {
    own('CTL-L', GW_A.user);
    const a = await connect(GW_A);
    const got = collect(a);
    await sub(a, syncTopic('CTL-L'));
    assert.equal(broker.publishSync('CTL-L', 'x'.repeat(BROKER_MAX + 1)), false);
    assert.equal(broker.publishSync('CTL-L', 'é'.repeat(600)), false, '600 caracteres = 1 200 octets');
    assert.equal(broker.publishSync('CTL-L', 'é'.repeat(512)), true, '512 x 2 = 1 024 octets : accepte');
    assert.equal(broker.publishSync('CTL-L', 'x'.repeat(BROKER_MAX)), true);
    await until(() => got.length === 2, 'les deux messages valides remis');
    await wait(150);
    assert.deepEqual(got.map((g) => g.bytes), [1024, 1024], 'et seulement eux');
    // Sens passerelle -> PSIM.
    acks.length = 0;
    const big = await connect(GW_A);
    big.publish(ackTopic('CTL-L'), 'x'.repeat(BROKER_MAX + 1), { qos: 1 });
    const ok = await connect(GW_A);
    ok.publish(ackTopic('CTL-L'), 'y'.repeat(BROKER_MAX), { qos: 1 });
    await until(() => acks.length === 1, 'accuse de 1 024 octets transmis');
    await wait(300);
    assert.deepEqual(acks.map((x) => x.size), [BROKER_MAX], 'celui de 1 025 octets n arrive jamais');
  });

  it('CONTROLE : identifiants de controleur invalides (../, trop long, vide, caracteres speciaux) refuses en abonnement, en accuse et par publishSync, meme pour un compte qui possede tout', async () => {
    const all = await connect(GW_ALL);
    const ids = ['..', '../x', 'a/b', '','x'.repeat(33), 'CTL A', 'é', 'CTL-1\n'];
    for (const id of ids) {
      assert.equal(await sub(all, `psim/access/${id}/sync`), 128, `abonnement ${JSON.stringify(id)}`);
      assert.equal(broker.publishSync(id, '{"v":1}'), false, `publishSync ${JSON.stringify(id)}`);
    }
    assert.equal(await sub(all, syncTopic('x'.repeat(32))), 1, 'TEMOIN : 32 caracteres, la limite, passent');
    for (const id of ['a+b', '#', '+']) assert.equal(broker.publishSync(id, '{"v":1}'), false, `publishSync ${id}`);
    for (const id of ['a+b', '#', '+']) assert.equal(broker.publishSync(id, '{"v":1}'), false, `publishSync ${id}`);
    assert.equal(broker.publishSync('x'.repeat(33), '{"v":1}'), false);
    acks.length = 0;
    for (const id of ids) {
      const c = await connect(GW_ALL);
      c.publish(`psim/access/${id}/sync-ack`, '{"v":1}', { qos: 1 });
    }
    await wait(400);
    assert.equal(acks.length, 0, 'aucun accuse pour un identifiant invalide');
  });

  it('GARDE-FOU : au plus 200 abonnements au sync par connexion (SUBACK 128 au-dela) ; place liberee au desabonnement et a la deconnexion', async () => {
    const a = await connect(GW_ALL);
    const topics: Record<string, { qos: 1 }> = {};
    for (let i = 0; i < 1000; i++) topics[syncTopic(`BULK-${i}`)] = { qos: 1 };
    const granted = await a.subscribeAsync(topics).catch(grantedOf);
    assert.equal(granted.length, 1000);
    assert.equal(granted.filter((g) => g.qos !== 128).length, MAX_SYNC_SUBSCRIPTIONS);
    assert.ok(granted.slice(0, MAX_SYNC_SUBSCRIPTIONS).every((g) => g.qos === 1));
    assert.ok(granted.slice(MAX_SYNC_SUBSCRIPTIONS).every((g) => g.qos === 128));
    assert.equal(broker.syncListeners('BULK-0'), 1);
    assert.equal(broker.syncListeners(`BULK-${MAX_SYNC_SUBSCRIPTIONS - 1}`), 1);
    assert.equal(broker.syncListeners(`BULK-${MAX_SYNC_SUBSCRIPTIONS}`), 0, 'refuse = pas de liaison');
    assert.equal(await sub(a, syncTopic('BULK-5000')), 128, 'limite atteinte');
    assert.equal(await sub(a, syncTopic('BULK-0')), 1, 'renouvellement d un abonnement deja accorde');
    await a.unsubscribeAsync(syncTopic('BULK-0'));
    await until(() => broker.syncListeners('BULK-0') === 0, 'desabonnement suivi');
    assert.equal(await sub(a, syncTopic('BULK-5000')), 1, 'place liberee');
    assert.equal(await sub(a, syncTopic('BULK-0')), 128, 'de nouveau a la limite');
    // La borne est par connexion.
    const a2 = await connect(GW_ALL);
    assert.equal(await sub(a2, syncTopic('BULK-999')), 1);
    await a.endAsync(true);
    await a2.endAsync(true);
    await until(() => broker.syncListeners('BULK-1') === 0 && broker.syncListeners('BULK-999') === 0, 'libere a la deconnexion');
  });

  it('GARDE-FOU : le rattachement est relu a CHAQUE autorisation (jamais garde dans la connexion) ; une base en erreur vaut refus', async () => {
    own('CTL-D', GW_A.user);
    const a = await connect(GW_A);
    const got = collect(a);
    assert.equal(await sub(a, syncTopic('CTL-D')), 1);
    const before = ownerCalls;
    assert.equal(broker.publishSync('CTL-D', '{"n":1}'), true);
    await until(() => got.length === 1, 'remis');
    assert.ok(ownerCalls - before >= 2, `rattachement interroge a la publication et a la remise (${ownerCalls - before} appels)`);
    const muted = console.error;
    console.error = () => {};
    try {
      ownerFails = true;
      assert.equal(broker.syncListeners('CTL-D'), 0, 'lecture en erreur : aucun droit');
      assert.equal(broker.publishSync('CTL-D', '{"n":2}'), false);
      assert.equal(await sub(await connect(GW_A), syncTopic('CTL-D')), 128, 'abonnement refuse');
      acks.length = 0;
      (await connect(GW_A)).publish(ackTopic('CTL-D'), '{"base":"en panne"}', { qos: 1 });
      await wait(300);
      assert.equal(acks.length, 0, 'accuse refuse');
    } finally {
      ownerFails = false;
      console.error = muted;
    }
    assert.equal(broker.syncListeners('CTL-D'), 1, 'la base revenue, le droit revient sans reconnexion');
    assert.equal(broker.publishSync('CTL-D', '{"n":3}'), true);
    await until(() => got.length === 2, 'remis de nouveau');
  });

  it('GARDE-FOU : un accuse valide est transmis au PSIM avec l identifiant du topic ; il compte comme signe de vie de la passerelle ; un gestionnaire qui leve ne casse pas le broker', async () => {
    own('CTL-K', GW_A.user);
    acks.length = 0;
    gatewayMessages.length = 0;
    const a = await connect(GW_A);
    const muted = console.error;
    console.error = () => {};
    try {
      ackShouldThrow = true;
      await a.publishAsync(ackTopic('CTL-K'), '{"n":1}', { qos: 1 });
      await until(() => acks.length === 1, 'accuse 1 transmis (le gestionnaire a leve)');
    } finally {
      ackShouldThrow = false;
      console.error = muted;
    }
    await a.publishAsync(ackTopic('CTL-K'), '{"n":2}', { qos: 1, retain: true });
    await until(() => acks.length === 2, 'accuse 2 transmis apres la panne');
    assert.deepEqual(acks.map((x) => [x.id, x.text]), [['CTL-K', '{"n":1}'], ['CTL-K', '{"n":2}']]);
    assert.deepEqual(gatewayMessages, [GW_A.user, GW_A.user], 'signe de vie de la passerelle');
    assert.equal(broker.clients() > 0, true, 'broker toujours en service');
    // Aucun message conserve : un autre abonne legitime d'un ordre ne recoit rien non plus.
    const late = await connect(GW_A);
    const lateGot = collect(late);
    await sub(late, syncTopic('CTL-K'));
    await wait(200);
    assert.deepEqual(lateGot, []);
  });

  it('NON-REGRESSION : les droits des detecteurs et des actionneurs ne changent pas', async () => {
    const a = await connect(GW_A);
    // Actionneurs : SIR-A accorde en QoS 0, jamais ceux des autres ; ordres de sync sans effet sur ses droits.
    assert.equal(await sub(a, 'psim/actuators/SIR-A/command', 0), 0);
    assert.equal(await sub(a, 'psim/actuators/SIR-B/command', 0), 128);
    assert.equal(broker.actuatorListeners('SIR-A'), 1);
    // Detecteurs : une passerelle de detecteurs ne lit rien, ne publie que les siens.
    const d = await connect(GW_D);
    assert.equal(await sub(d, 'psim/detectors/+/state'), 128);
    assert.equal(await sub(d, syncTopic('CTL-A')), 128);
    const watcher = await connect(MAIN);
    const seen = collect(watcher);
    assert.equal(await sub(watcher, 'psim/detectors/+/state'), 1);
    d.publish('psim/detectors/D-1/state', JSON.stringify({ state: 'normal' }), { qos: 1 });
    await until(() => seen.length === 1, 'etat du detecteur remis au compte principal');
    assert.equal(seen[0].topic, 'psim/detectors/D-1/state');
    // Un client ne peut toujours rien publier hors de son arborescence.
    const g = await connect(GW_B);
    g.publish('psim/actuators/SIR-A/command', '{"forge":true}', { qos: 1 });
    g.publish('psim/access/CTL-X/forge', '{"forge":true}', { qos: 1 });
    await wait(200);
    assert.equal(seen.length, 1);
  });
});

// ============================================================================================================================
// CHAINE COMPLETE : vrai broker + vrai moteur de synchronisation + fausse passerelle independante du code teste.
// ============================================================================================================================

interface Order {
  v: number;
  opId: string;
  seq: number;
  ts: number;
  body: string;
  sig: string;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Droits attendus d'un seul controleur, modifiables (un titulaire, une plage). */
class FakeRights implements RightsSource {
  ids = ['CTL-1', 'CTL-2'];
  states = new Map<string, DesiredState>();
  listeners: RightsListener[] = [];
  controllerIds(): string[] {
    return [...this.ids];
  }
  desired(c: string): DesiredState {
    return structuredClone(this.states.get(c) ?? { holders: [], schedules: [], holidays: [] });
  }
  subscribe(l: RightsListener): void {
    this.listeners.push(l);
  }
  holders(c: string, refs: string[]): void {
    this.states.set(c, {
      holders: refs.map((ref, i) => ({ ref, name: `NOM${i} Prenom${i}`, active: true, validFrom: null, validTo: null, credentials: [`B${ref}`], doors: [{ doorNo: 1, scheduleRef: 'S1' }] })),
      schedules: [{ ref: 'S1', windows: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }], holidays: false }],
      holidays: [],
    });
    for (const l of this.listeners) l([c]);
  }
}

describe('chaine complete : broker reel + moteur de synchronisation reel + fausse passerelle', { timeout: 120_000 }, () => {
  const GW1 = { user: 'passerelle-1', password: 'Mot-de-passe-passerelle-chaine-1', detectors: [] as string[] };
  const GW2 = { user: 'passerelle-2', password: 'Mot-de-passe-passerelle-chaine-2', detectors: [] as string[] };
  let broker: Broker;
  let db: ReturnType<typeof openDb>;
  let sync: SyncService;
  let rights: FakeRights;
  let url = '';
  let key = Buffer.alloc(0);
  let skew = 0; // decalage de l'horloge du moteur : les attentes de renvoi (10 s) se franchissent sans dormir
  const clients: MqttClient[] = [];
  const ackCalls: { id: string; text: string }[] = [];
  const auditActions: string[] = [];

  /** Fausse passerelle : verifie chaque ordre (chaine canonique recalculee ici), refuse un seq deja vu, accuse. */
  const gateway = {
    client: undefined as MqttClient | undefined,
    mode: 'normal' as 'normal' | 'wrongKey' | 'silent',
    received: [] as Order[],
    applied: [] as { seq: number; type: string; ref: string }[],
    badSignatures: 0,
    replays: 0,
    lastSeq: 0,
    lastOrder: undefined as Order | undefined,
    sendAck(o: Order, via: MqttClient | undefined, withKey: Buffer = key): void {
      const ts = Date.now();
      const sig = signAck(withKey, 'CTL-1', o.opId, o.seq, 'done', null, ts);
      via?.publish(ackTopic('CTL-1'), JSON.stringify({ v: 1, opId: o.opId, seq: o.seq, result: 'done', code: null, ts, sig }), { qos: 1 });
    },
    onOrder(payload: Buffer): void {
      const o = JSON.parse(payload.toString('utf8')) as Order;
      this.received.push(o);
      // Chaine canonique du § 7, ecrite ici independamment du code teste, puis comparee a celle exportee.
      const canonical = `psim-sync-v1|CTL-1|${o.opId}|${o.seq}|${o.ts}|${sha256(o.body)}`;
      const expected = createHmac('sha256', key).update(canonical).digest('hex');
      if (canonical !== orderString('CTL-1', o.opId, o.seq, o.ts, o.body) || o.sig !== expected || o.sig !== signOrder(key, 'CTL-1', o.opId, o.seq, o.ts, o.body)) {
        this.badSignatures++;
        return;
      }
      if (o.seq <= this.lastSeq) {
        this.replays++; // seq deja vu : jamais reapplique ; reemettre l'accuse du dernier ordre applique est permis
        if (o.seq === this.lastSeq && o.opId === this.lastOrder?.opId && this.mode !== 'silent') this.sendAck(o, this.client, this.mode === 'wrongKey' ? randomBytes(32) : key);
        return;
      }
      this.lastSeq = o.seq;
      this.lastOrder = o;
      const body = JSON.parse(o.body) as { type: string; holderRef?: string; scheduleRef?: string };
      this.applied.push({ seq: o.seq, type: body.type, ref: body.holderRef ?? body.scheduleRef ?? 'holidays' });
      if (this.mode === 'normal') this.sendAck(o, this.client);
      else if (this.mode === 'wrongKey') this.sendAck(o, this.client, randomBytes(32));
    },
  };

  const connect = async (account: { user: string; password: string }): Promise<MqttClient> => {
    const c = mqtt.connect(url, { username: account.user, password: account.password, reconnectPeriod: 0, connectTimeout: 5000 });
    clients.push(c);
    c.on('error', () => {});
    await new Promise<void>((res, rej) => {
      c.once('connect', () => res());
      c.once('error', rej);
      c.once('close', () => rej(new Error('ferme')));
    });
    return c;
  };
  /** Pilote le moteur a la main (tick) jusqu'a ce que la condition soit vraie. */
  const driveUntil = async (cond: () => boolean, what: string, ms = 8000) => {
    const end = Date.now() + ms;
    while (true) {
      sync.tick();
      if (cond()) return;
      if (Date.now() > end) assert.fail(`delai depasse : ${what}`);
      await wait(25);
    }
  };
  const holderState = (ref: string) => sync.holderStatus(ref).find((s) => s.controllerId === 'CTL-1')?.state;

  before(async () => {
    const engineDb = openDb(':memory:');
    seedEmptySite(engineDb);
    const engine = createEngine(engineDb, () => {});
    db = openDb(':memory:');
    migrateAccess(db);
    const now = Date.now();
    for (const [id, gw] of [['CTL-1', GW1.user], ['CTL-2', GW2.user]]) {
      db.prepare('INSERT INTO access_controller (id, name, brand, gateway_id, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, `Controleur ${id}`, 'dahua', gw, now, 'admin', now, 'admin');
    }
    rights = new FakeRights();
    const port = await freePort();
    url = `mqtt://127.0.0.1:${port}`;
    sync = createSync({
      db,
      now: () => Date.now() + skew,
      key: randomBytes(32),
      audit: (_actor, action) => auditActions.push(action),
      rights,
      transport: { publish: (controllerId, payload) => broker.publishSync(controllerId, payload) },
    });
    broker = await startBroker(engine, {
      host: '127.0.0.1',
      port,
      user: MAIN.user,
      password: MAIN.password,
      gateways: [GW1, GW2],
      // Meme requete que server/main.ts.
      controllerOwned: (gatewayUser, controllerId) => db.prepare('SELECT 1 AS ok FROM access_controller WHERE id = ? AND gateway_id = ?').get(controllerId, gatewayUser) !== undefined,
      onAccessSyncAck: (controllerId, payload) => {
        ackCalls.push({ id: controllerId, text: payload.toString().slice(0, 30) });
        sync.receiveAck(controllerId, payload);
      },
    });
    key = Buffer.from(sync.issueKey('admin', 'CTL-1').key, 'hex');
    sync.start();
  });
  after(async () => {
    for (const c of clients) await c.endAsync(true).catch(() => {});
    await broker?.close();
    db?.close();
  });

  it('sans passerelle abonnee, rien ne part et rien n est compte ; des qu elle s abonne, la synchronisation arrive a « synchronise » (signatures verifiees, seq croissants)', async () => {
    rights.holders('CTL-1', ['H1']);
    sync.tick();
    assert.equal(holderState('H1'), 'pending');
    assert.equal(sync.status().find((s) => s.controllerId === 'CTL-1')?.transportReady, false, 'transport non pret : aucun abonne');
    assert.equal(gateway.received.length, 0);
    gateway.client = await connect(GW1);
    gateway.client.on('message', (_t, p) => gateway.onOrder(p));
    assert.equal((await gateway.client.subscribeAsync(syncTopic('CTL-1'), { qos: 1 }))[0]?.qos, 1);
    await driveUntil(() => holderState('H1') === 'synced', 'H1 synchronise');
    assert.deepEqual(gateway.applied.map((a) => a.seq), [1, 2], 'plage puis titulaire, seq croissants sans trou');
    assert.deepEqual(gateway.applied.map((a) => a.ref), ['S1', 'H1']);
    assert.equal(gateway.badSignatures, 0, 'toutes les signatures verifiees par la passerelle');
    assert.ok(gateway.received.every((o) => Buffer.byteLength(JSON.stringify(o)) <= BROKER_MAX));
    const status = sync.status().find((s) => s.controllerId === 'CTL-1');
    assert.equal(status?.state, 'ok');
    assert.equal(status?.transportReady, true);
    assert.deepEqual(status?.counts, { synced: 2, pending: 0, failed: 0, blocked: 0 });
  });

  it('un accuse signe avec une mauvaise cle ne change rien (journalise, titulaire toujours en attente) ; au renvoi, le bon accuse est accepte et le seq deja vu n est pas reapplique', async () => {
    gateway.mode = 'wrongKey';
    const applied = gateway.applied.length;
    rights.holders('CTL-1', ['H1', 'H2']);
    await driveUntil(() => gateway.applied.length === applied + 1, 'ordre de H2 recu');
    await wait(300); // l'accuse a mauvaise cle est arrive au PSIM
    sync.tick();
    assert.equal(holderState('H2'), 'pending', 'accuse a mauvaise cle sans effet');
    assert.ok(auditActions.includes('access_sync_ack_invalid'), 'incident journalise');
    assert.ok(ackCalls.length > 0, 'l accuse a bien traverse le broker (c est le moteur qui l ecarte)');
    // Renvoi apres l'attente (horloge du moteur avancee) : meme seq, la passerelle ne le reapplique pas mais le reaccuse avec la bonne cle.
    gateway.mode = 'normal';
    skew += 11_000;
    await driveUntil(() => holderState('H2') === 'synced', 'H2 synchronise apres renvoi');
    assert.ok(gateway.replays >= 1, 'le seq deja vu a ete refuse par la passerelle');
    assert.equal(gateway.applied.filter((a) => a.ref === 'H2').length, 1, 'jamais reapplique');
    assert.deepEqual(gateway.applied.map((a) => a.seq), [...new Set(gateway.applied.map((a) => a.seq))].sort((x, y) => x - y), 'seq strictement croissants');
  });

  it('un accuse correctement signe mais publie par une AUTRE passerelle est ecarte par le broker : l etat ne change pas ; le vrai accuse suit', async () => {
    gateway.mode = 'silent';
    const applied = gateway.applied.length;
    rights.holders('CTL-1', ['H1', 'H2', 'H3']);
    await driveUntil(() => gateway.applied.length === applied + 1, 'ordre de H3 recu, sans accuse');
    const order = gateway.lastOrder!;
    assert.equal(holderState('H3'), 'pending');
    const before = ackCalls.length;
    const thief = await connect(GW2); // possede CTL-2, pas CTL-1
    gateway.sendAck(order, thief, key); // cle volee : la signature est BONNE
    await wait(500);
    sync.tick();
    assert.equal(ackCalls.length, before, 'le broker ne transmet pas l accuse de l autre passerelle');
    assert.equal(holderState('H3'), 'pending');
    gateway.sendAck(order, gateway.client); // le vrai
    await driveUntil(() => holderState('H3') === 'synced', 'H3 synchronise par le bon accuse');
    gateway.mode = 'normal';
  });

  it('la passerelle perd son rattachement : le PSIM n envoie plus rien (essai non compte) ; rattachee de nouveau, la synchronisation reprend', async () => {
    db.prepare("UPDATE access_controller SET gateway_id = 'passerelle-2' WHERE id = 'CTL-1'").run();
    const applied = gateway.applied.length;
    rights.holders('CTL-1', ['H1', 'H2', 'H3', 'H4']);
    for (let i = 0; i < 5; i++) {
      sync.tick();
      await wait(40);
    }
    assert.equal(gateway.applied.length, applied, 'la passerelle reaffectee ne recoit plus rien');
    assert.equal(sync.status().find((s) => s.controllerId === 'CTL-1')?.transportReady, false);
    assert.equal(holderState('H4'), 'pending');
    db.prepare("UPDATE access_controller SET gateway_id = 'passerelle-1' WHERE id = 'CTL-1'").run();
    await driveUntil(() => holderState('H4') === 'synced', 'H4 synchronise apres retour du rattachement');
    assert.equal(gateway.badSignatures, 0);
  });
});
