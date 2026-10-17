/**
 * Bout en bout, sans aucun faux maillon cote PSIM : faux controleur Dahua (gateway/test/fake-dahua.ts, 127.0.0.1) -> VRAI module
 * `acces-dahua` charge par le socle (startRuntime, gateway/src/modules) -> file disque -> vrai broker du PSIM (server/mqtt.ts,
 * compte de passerelle) -> vrai moteur (server/engine.ts, base SQLite temporaire) avec des detecteurs de categorie `access`.
 *
 * Le stockage des passages cote PSIM (table access_event) est dans une autre branche : on verifie ici ce que le socle du PSIM sait
 * faire aujourd'hui, c'est-a-dire accepter les messages (signe de vie, derniere activite), les dedoublonner par `msgId`
 * (`ingest_dedup`) et ouvrir / fermer les incidents.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { openDb } from '../../server/db.ts';
import { createEngine } from '../../server/engine.ts';
import { signCommand, verifyAck } from '../../server/actuatorproto.ts';
import { startBroker } from '../../server/mqtt.ts';
import type { Broker } from '../../server/mqtt.ts';
import { loadConfig } from '../src/config.ts';
import { startRuntime } from '../src/runtime.ts';
import type { GatewayRuntime } from '../src/runtime.ts';
import { FakeDahua } from './fake-dahua.ts';
import { freePort, GW_PASSWORD, GW_USER, memoryLogger, sleep, tempDir, waitFor, writeConfig } from './helpers.ts';

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

const BROKER_PASSWORD = 'Mot-de-passe-mqtt-solide-3';

interface Received {
  id: string;
  payload: { event?: string; state?: string; ts?: number; msgId?: string; access?: { eventId: string; deferred: boolean; result: string; reason: string | null; credential: string | null } };
}

/** Cle HMAC de l'actionneur d'essai (32 octets en hexadecimal). */
const ACT_KEY = '0'.repeat(63) + '1';

interface SetupOptions {
  /** Cles ajoutees au controleur du module (epoque, actionneurs...). */
  controller?: Record<string, unknown>;
  /** Section `actuators` de la passerelle (le vrai socle LEVE a la declaration d'un actionneur absent d'ici). */
  actuators?: unknown[];
  /** Actionneurs que le compte MQTT de la passerelle a le droit de recevoir. */
  allowedActuators?: string[];
  modeCheckS?: number;
}

async function setup(o: SetupOptions = {}) {
  const dir = tempDir(cleanup);
  const db = openDb(join(dir, 'psim.db'));
  cleanup.push(() => db.close());
  const engine = createEngine(db, () => {}, Date.now, { isArmed: () => false });
  engine.createDevice('admin', { id: 'P-ENTREE', kind: 'detector', name: 'Porte entree personnel', category: 'access', zone: 'Entree' });
  engine.createDevice('admin', { id: 'P-SALLE', kind: 'detector', name: 'Salle serveur', category: 'access', zone: 'Technique' });

  // Le moteur reel, observe : tout ce que le broker lui remet est aussi range ici.
  const received: Received[] = [];
  const watched = new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === 'handleDetectorMessage') {
        return (id: string, payload: unknown) => {
          received.push({ id, payload: payload as Received['payload'] });
          return target.handleDetectorMessage(id, payload);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  const acks: { id: string; raw: Buffer }[] = [];
  const port = await freePort();
  const brokerOpts = {
    host: '127.0.0.1',
    port,
    user: 'psim',
    password: BROKER_PASSWORD,
    gateways: [{ user: GW_USER, password: GW_PASSWORD, detectors: ['P-*'], ...(o.allowedActuators ? { actuators: o.allowedActuators } : {}) }],
    onActuatorAck: (id: string, raw: Buffer) => void acks.push({ id, raw }),
  };
  let broker: Broker | null = await startBroker(watched, brokerOpts);
  cleanup.push(() => broker?.close());

  const fake = await FakeDahua.start({ heartbeatMs: 100 });
  cleanup.push(() => fake.close());

  const file = writeConfig(dir, {
    psim: { url: `mqtt://127.0.0.1:${port}`, username: GW_USER, password: GW_PASSWORD, detectors: ['P-*'] },
    dataDir: 'gw-data',
    retry: { minMs: 100, maxMs: 400 },
    moduleRetry: { minMs: 100, maxMs: 400 },
    log: { file: false },
    ...(o.actuators ? { actuators: o.actuators } : {}),
    modules: [
      {
        name: 'acces-dahua',
        config: {
          stateDir: join(dir, 'acces-state'),
          controllers: [
            {
              id: 'CTL-1',
              host: fake.host,
              port: fake.port,
              username: fake.username,
              password: fake.password,
              doors: { '1': 'P-ENTREE', '2': 'P-SALLE' },
              ...o.controller,
            },
          ],
          thresholds: { offlineGraceMs: 500, silenceMs: 10_000, ...(o.modeCheckS === undefined ? {} : { modeCheckS: o.modeCheckS }) },
          reconnect: { minMs: 100, maxMs: 400 },
        },
      },
    ],
  });
  const logger = memoryLogger();
  const rt: GatewayRuntime = await startRuntime({ config: loadConfig(file), logger });
  cleanup.push(() => rt.stop());

  const device = (id: string) => engine.getDevice(id)!;
  const open = (id: string) => engine.getSnapshot().incidents.filter((i) => i.detectorId === id && i.status !== 'closed');
  const dedup = (id: string) => (db.prepare('SELECT msg_id FROM ingest_dedup WHERE device_id = ? ORDER BY msg_id').all(id) as { msg_id: string }[]).map((r) => r.msg_id);
  const passages = () => received.filter((r) => r.payload.access !== undefined);
  return {
    db,
    engine,
    fake,
    rt,
    getBroker: () => broker,
    acks,
    logger,
    device,
    open,
    dedup,
    received,
    passages,
    stopBroker: async () => {
      await broker?.close();
      broker = null;
    },
    startBrokerAgain: async () => {
      broker = await startBroker(watched, brokerOpts);
    },
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** Attend que le module soit en ligne dans le moteur (premiers signes de vie recus). */
async function ready(c: Ctx): Promise<void> {
  await waitFor(() => c.device('P-ENTREE').lastSeen !== null && c.device('P-SALLE').lastSeen !== null, 15_000, 'les deux portes ont donne signe de vie');
  await waitFor(() => c.fake.recordFinds > 0, 10_000, 'memoire du controleur relue');
  await waitFor(() => c.rt.status().queue.pending === 0, 10_000, 'file videe');
}

describe('bout en bout : controleur Dahua -> module -> socle -> broker du PSIM -> moteur', () => {
  it('un passage accepte et un passage refuse arrivent ; derniere activite mise a jour ; un refus isole n\'ouvre aucun incident', { timeout: 60_000 }, async () => {
    const c = await setup();
    await ready(c);
    const seenBefore = c.device('P-ENTREE').lastSeen!;
    await sleep(20);
    c.fake.emitAccess({ recNo: 1001, cardNo: '0012345', cardName: 'KONAN Yao', door: 0 });
    c.fake.emitAccess({ recNo: 1002, cardNo: '0099999', status: 0, errorCode: 0x10, door: 0 });
    await waitFor(() => c.passages().length === 2, 15_000, 'deux passages recus par le moteur');
    assert.deepEqual(c.passages().map((p) => [p.payload.event, p.payload.msgId, p.payload.access!.eventId, p.payload.access!.deferred]), [
      ['badge_granted', 'acc:CTL-1:1001', '1001', false],
      ['badge_denied', 'acc:CTL-1:1002', '1002', false],
    ]);
    assert.equal(c.passages()[1]!.payload.access!.reason, 'unknown_credential');
    assert.ok(c.device('P-ENTREE').lastSeen! >= seenBefore, 'derniere activite mise a jour');
    assert.equal(c.device('P-ENTREE').status, 'normal');
    assert.equal(c.open('P-ENTREE').length, 0, 'un refus isole n\'est pas un incident');
    await waitFor(() => c.dedup('P-ENTREE').includes('acc:CTL-1:1002'), 5000, 'msgId memorises');
    assert.equal(c.dedup('P-SALLE').some((m) => /^acc:CTL-1:\d+$/.test(m)), false);
    assert.equal(c.logger.has(/message rejete/), false, c.logger.lines.map((l) => l.text).join('\n'));
  });

  it('porte forcee => incident door_forced critique ; fermeture => retour a la normale', { timeout: 60_000 }, async () => {
    const c = await setup();
    await ready(c);
    c.fake.emitDoor('BreakIn', { action: 'Start', index: 1 });
    await waitFor(() => c.open('P-SALLE').length === 1, 15_000, 'incident ouvert');
    const incident = c.open('P-SALLE')[0]!;
    assert.equal(incident.event, 'door_forced');
    assert.equal(incident.severity, 'critical');
    assert.equal(c.device('P-SALLE').status, 'alarm');
    assert.equal(c.device('P-ENTREE').status, 'normal', 'l\'autre porte n\'est pas touchee');
    c.fake.emitDoor('DoorStatus', { index: 1, data: { Status: 'Close' } });
    await waitFor(() => c.device('P-SALLE').status === 'normal', 15_000, 'porte refermee');
  });

  it('porte maintenue ouverte => pre-alarme ; sabotage du boitier => alarme sur toutes les portes', { timeout: 60_000 }, async () => {
    const c = await setup();
    await ready(c);
    c.fake.emitDoor('DoorNotClosed', { action: 'Start', index: 0 });
    await waitFor(() => c.device('P-ENTREE').status === 'prealarm', 15_000, 'pre-alarme');
    assert.equal(c.open('P-ENTREE')[0]!.event, 'door_held_open');
    c.fake.emitDoor('ChassisIntruded', { action: 'Start', index: 0, data: null });
    await waitFor(() => c.device('P-ENTREE').status === 'alarm' && c.device('P-SALLE').status === 'alarm', 15_000, 'sabotage');
    assert.equal(c.open('P-SALLE')[0]!.event, 'tamper');
  });

  it('coupure DU PSIM pendant que des passages arrivent : file de la passerelle, reprise, tous arrives sans doublon', { timeout: 90_000 }, async () => {
    const c = await setup();
    await ready(c);
    await c.stopBroker();
    await waitFor(() => !c.rt.status().psim.connected, 10_000, 'liaison PSIM coupee');
    for (let n = 1; n <= 5; n++) c.fake.emitAccess({ recNo: 2000 + n, cardNo: `00${n}`, door: 0 });
    c.fake.emitDoor('BreakIn', { action: 'Start', index: 1 });
    await waitFor(() => c.rt.status().queue.pending >= 6, 15_000, 'messages gardes sur disque');
    assert.equal(c.passages().length, 0, 'rien n\'est arrive pendant la coupure');
    await c.startBrokerAgain();
    await waitFor(() => c.passages().length >= 5 && c.rt.status().queue.pending === 0, 30_000, 'tous les passages livres');
    await sleep(500);
    const ids = new Set(c.passages().map((p) => p.payload.access!.eventId));
    assert.deepEqual([...ids].sort(), ['2001', '2002', '2003', '2004', '2005']);
    assert.deepEqual(c.dedup('P-ENTREE').filter((m) => /^acc:CTL-1:200\d$/.test(m)), ['acc:CTL-1:2001', 'acc:CTL-1:2002', 'acc:CTL-1:2003', 'acc:CTL-1:2004', 'acc:CTL-1:2005']);
    // La porte forcee pendant la coupure n'ouvre qu'UN incident, meme si le message a pu etre presente plus d'une fois.
    assert.equal(c.open('P-SALLE').length, 1);
    assert.equal(c.open('P-SALLE')[0]!.event, 'door_forced');
    assert.equal(c.engine.getSnapshot().incidents.filter((i) => i.detectorId === 'P-SALLE').length, 1);
    assert.equal(c.logger.has(/message rejete/), false);
  });

  it('coupure du CONTROLEUR avec des passages en memoire : recuperes, marques « differes », sans doublon', { timeout: 90_000 }, async () => {
    const c = await setup();
    await ready(c);
    c.fake.emitAccess({ recNo: 3001, door: 0 });
    await waitFor(() => c.passages().length === 1, 15_000, 'passage direct');
    await c.fake.pause();
    for (let n = 2; n <= 4; n++) c.fake.emitAccess({ recNo: 3000 + n, send: false, door: 0, cardNo: `77${n}` });
    c.fake.emitAccess({ recNo: 3005, send: false, door: 1, status: 0, errorCode: 0x14 });
    await sleep(600);
    await c.fake.resume();
    await waitFor(() => c.passages().length === 5, 30_000, 'passages recuperes');
    await sleep(500);
    assert.deepEqual(c.passages().map((p) => [p.payload.access!.eventId, p.payload.access!.deferred]), [
      ['3001', false],
      ['3002', true],
      ['3003', true],
      ['3004', true],
      ['3005', true],
    ]);
    assert.equal(c.passages()[4]!.payload.access!.reason, 'expired');
    assert.equal(c.passages().length, 5, 'aucun doublon');
    assert.equal(c.open('P-ENTREE').length + c.open('P-SALLE').length, 0, 'les passages ne creent pas d\'incident');
  });

  it('controleur coupe : portes hors ligne dans le moteur, puis de nouveau normales au retour', { timeout: 90_000 }, async () => {
    const c = await setup();
    await ready(c);
    assert.equal(c.device('P-ENTREE').status, 'normal');
    await c.fake.pause();
    await waitFor(() => c.device('P-ENTREE').status === 'offline' && c.device('P-SALLE').status === 'offline', 30_000, 'portes hors ligne');
    await c.fake.resume();
    await waitFor(() => c.device('P-ENTREE').status === 'normal' && c.device('P-SALLE').status === 'normal', 30_000, 'portes de nouveau normales');
    assert.equal(c.logger.has(/message rejete/), false);
  });
  it('ouverture a distance : actionneur DECLARE dans « actuators » -> ordre signe, vrai socle, module, controleur, accuse valide, repos local', { timeout: 60_000 }, async () => {
    const c = await setup({
      controller: { actuators: { 'ACT-ENTREE': { door: 1, type: 'lock' } } },
      actuators: [{ id: 'ACT-ENTREE', key: ACT_KEY, module: 'acces-dahua', actions: { unlock: { maxS: 10 }, lock: {} }, rest: 'lock' }],
      allowedActuators: ['ACT-ENTREE'],
    });
    await ready(c);
    await waitFor(() => c.getBroker()?.actuatorListeners('ACT-ENTREE') === 1, 10_000, 'abonnement aux ordres');
    const cmdId = 'a'.repeat(32);
    const order = signCommand(ACT_KEY, 'ACT-ENTREE', { cmdId, action: 'unlock', params: { durationS: 1 }, ts: Date.now(), ttlS: 10 });
    await c.getBroker()!.publishCommand('ACT-ENTREE', Buffer.from(JSON.stringify(order)));
    await waitFor(() => c.acks.some((a) => verifyAck(ACT_KEY, 'ACT-ENTREE', a.raw)?.cmdId === cmdId), 15_000, 'accuse signe');
    const ack = c.acks.map((a) => verifyAck(ACT_KEY, 'ACT-ENTREE', a.raw)).find((a) => a?.cmdId === cmdId)!;
    assert.equal(ack.result, 'done');
    assert.deepEqual(c.fake.commands.map((x) => [x.action, x.channel]).slice(0, 1), [['openDoor', 1]], 'la porte 1 a recu l\'impulsion');
    // Retour LOCAL au repos au bout de 1 s : mode normal puis fermeture, sans autre message du PSIM.
    await waitFor(() => c.fake.commands.some((x) => x.action === 'closeDoor' && x.channel === 1), 15_000, 'repos local');
    assert.equal(c.fake.modes.includes('CloseAlways'), false);
    assert.equal(c.logger.has(/ouverture a distance indisponible/), false, 'actionneur declare : aucun avertissement');
    assert.equal(c.rt.status().modules[0]?.state, 'running');
  });

  it('actionneur du module NON declare dans la section `actuators` de la passerelle : le module demarre quand meme, les passages remontent, le journal le dit clairement', { timeout: 60_000 }, async () => {
    // Le vrai socle LEVE a la declaration : `registerActuator` attrape l'erreur, journalise la cause et le module continue.
    const c = await setup({ controller: { actuators: { 'ACT-ENTREE': { door: 1, type: 'lock' } } } });
    await ready(c);
    assert.equal(c.rt.status().modules[0]?.state, 'running', 'le module n\'est pas tombe');
    c.fake.emitAccess({ recNo: 5001, cardNo: '0012345', door: 0 });
    c.fake.emitAccess({ recNo: 5002, cardNo: '0099999', status: 0, errorCode: 0x10, door: 1 });
    c.fake.emitDoor('BreakIn', { action: 'Start', index: 1 });
    await waitFor(() => c.passages().length === 2, 15_000, 'passages recus malgre l\'actionneur non declare');
    await waitFor(() => c.open('P-SALLE').length === 1, 15_000, 'porte forcee remontee');
    assert.deepEqual(c.passages().map((p) => p.payload.event), ['badge_granted', 'badge_denied']);
    assert.equal(c.rt.status().modules[0]?.state, 'running');
    const line = c.logger.lines.find((l) => /ouverture a distance indisponible/.test(l.text));
    assert.ok(line, c.logger.lines.map((l) => l.text).join('\n'));
    assert.equal(line.level, 'warn');
    assert.match(line.text, /ACT-ENTREE/);
    assert.match(line.text, /surveillance seule/);
    assert.match(line.text, /non declare dans la section/);
    assert.equal(c.logger.lines.filter((l) => /ACT-ENTREE/.test(l.text) && /non enregistre/.test(l.text)).length, 1, 'une seule ligne : pas de journal redondant');
    assert.equal(c.logger.has(/canal de commande n'est pas installe/), false);
    assert.equal(c.getBroker()?.actuatorListeners('ACT-ENTREE'), 0);
  });

  it('controleur sans syncKey : le module demarre, le dit une fois, et les passages remontent', { timeout: 60_000 }, async () => {
    const c = await setup();
    await ready(c);
    c.fake.emitAccess({ recNo: 6001, door: 0 });
    await waitFor(() => c.passages().length === 1, 15_000, 'passage recu');
    assert.equal(c.rt.status().modules[0]?.state, 'running');
    const lines = c.logger.lines.filter((l) => /synchronisation des titulaires inactive pour CTL-1 \(pas de syncKey\)/.test(l.text));
    assert.equal(lines.length, 1, c.logger.lines.map((l) => l.text).join('\n'));
    assert.match(lines[0]!.text, /CTL-1/);
  });

  it('mode de porte (F19) : lu a la connexion puis a chaque changement, accepte par le vrai moteur (signe de vie, aucun rejet)', { timeout: 60_000 }, async () => {
    const c = await setup({ modeCheckS: 1 });
    await ready(c);
    const modes = (id: string) => c.received.filter((r) => r.id === id && r.payload.event === 'door_mode').map((r) => (r.payload as { doorMode?: string }).doorMode);
    await waitFor(() => modes('P-ENTREE').length >= 1 && modes('P-SALLE').length >= 1, 15_000, 'modes initiaux');
    assert.equal(modes('P-ENTREE')[0], 'normal');
    c.fake.modes[1] = 'OpenAlways';
    await waitFor(() => modes('P-SALLE').includes('always_open'), 20_000, 'changement vu par la relecture');
    assert.equal(c.device('P-SALLE').status, 'normal', 'un mode n\'est pas une alarme');
    assert.equal(c.open('P-SALLE').length, 0);
    assert.equal(c.logger.has(/message rejete/), false, c.logger.lines.map((l) => l.text).join('\n'));
  });

  it('contrainte : Duress -> alarme « panic » reconnue par le vrai moteur (incident critique) sur la bonne porte seulement', { timeout: 60_000 }, async () => {
    const c = await setup();
    await ready(c);
    c.fake.emitDoor('Duress', { action: 'Start', index: 1, data: { Door: 1, UTC: Math.floor(Date.now() / 1000), RecNo: 77 } });
    await waitFor(() => c.open('P-SALLE').length === 1, 15_000, 'incident de contrainte');
    assert.equal(c.open('P-SALLE')[0]!.event, 'panic');
    assert.equal(c.open('P-SALLE')[0]!.severity, 'critical');
    assert.equal(c.device('P-SALLE').status, 'alarm');
    assert.equal(c.device('P-ENTREE').status, 'normal');
    assert.equal(c.logger.has(/message rejete/), false);
  });

  it('epoque : eventId "<epoque>.<n°>" jusqu\'au moteur (msgId memorise, aucune collision avec l\'epoque 0)', { timeout: 60_000 }, async () => {
    const c = await setup({ controller: { epoch: 3 } });
    await ready(c);
    c.fake.emitAccess({ recNo: 7001, door: 0 });
    await waitFor(() => c.passages().length === 1, 15_000, 'passage');
    assert.equal(c.passages()[0]!.payload.msgId, 'acc:CTL-1:3.7001');
    assert.equal(c.passages()[0]!.payload.access!.eventId, '3.7001');
    await waitFor(() => c.dedup('P-ENTREE').includes('acc:CTL-1:3.7001'), 5000, 'msgId memorise');
    assert.equal(c.dedup('P-ENTREE').includes('acc:CTL-1:7001'), false);
  });
});
