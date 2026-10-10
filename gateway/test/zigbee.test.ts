import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { DeviceMessage, GatewayModule, ModuleContext, MqttLink } from '../src/module.ts';
import { create, MAX_PAYLOAD_BYTES } from '../src/modules/zigbee/index.ts';
import { parseConfig } from '../src/modules/zigbee/config.ts';

const T0 = Date.parse('2026-10-10T10:00:00.000Z');

interface Harness {
  mod: GatewayModule;
  emitted: { id: string; msg: DeviceMessage }[];
  logs: { level: string; text: string }[];
  subscribed: string[];
  openArgs: { url: string; opts?: { username?: string; password?: string } }[];
  closed: () => number;
  setNow(ms: number): void;
  /** Injecte un message MQTT (objet = JSON, texte ou Buffer = tel quel). */
  inject(topic: string, body: unknown): void;
  /** Idem pour un equipement : sujet zigbee2mqtt/<nom>. */
  dev(name: string, body: unknown): void;
  /** Messages (sans heartbeat) pour un identifiant PSIM. */
  for(id: string): DeviceMessage[];
}

const BASE_CONFIG = {
  broker: { url: 'mqtt://127.0.0.1:1883' },
  devices: {
    pir_salon: { id: 'zb-pir', kind: 'motion' },
    porte: { id: 'zb-door', kind: 'contact' },
    fuite: { id: 'zb-leak', kind: 'leak' },
    thermo: { id: 'zb-temp', kind: 'temperature', humidityId: 'zb-hum' },
    fumee: { id: 'zb-smoke', kind: 'smoke' },
    gaz: { id: 'zb-gas', kind: 'gas' },
    co: { id: 'zb-co', kind: 'co' },
    choc: { id: 'zb-vib', kind: 'vibration' },
    bouton: { id: 'zb-panic', kind: 'panic' },
    sabot: { id: 'zb-tamper', kind: 'tamper_only' },
  },
};

async function setup(config: Record<string, unknown> = BASE_CONFIG, start = true): Promise<Harness> {
  let now = T0;
  const handlers = new Map<string, (topic: string, payload: Buffer) => void>();
  let closedCount = 0;
  const h = {
    emitted: [] as Harness['emitted'],
    logs: [] as Harness['logs'],
    subscribed: [] as string[],
    openArgs: [] as Harness['openArgs'],
  };
  const link: MqttLink = {
    async subscribe(topic, onMessage) {
      h.subscribed.push(topic);
      handlers.set(topic, onMessage);
    },
    async close() {
      closedCount++;
    },
  };
  const ctx: ModuleContext = {
    emit: (id, msg) => void h.emitted.push({ id, msg }),
    async openMqtt(url, opts) {
      h.openArgs.push(opts ? { url, opts } : { url });
      return link;
    },
    log: (level, text) => void h.logs.push({ level, text }),
    config,
    now: () => now,
  };
  const mod = create(config);
  if (start) await mod.start(ctx);
  const inject = (topic: string, body: unknown) => {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    handlers.get(topic)?.(topic, payload);
  };
  return {
    mod,
    ...h,
    closed: () => closedCount,
    setNow: (ms) => {
      now = ms;
    },
    inject,
    dev: (name, body) => inject(`zigbee2mqtt/${name}`, body),
    for: (id) => h.emitted.filter((e) => e.id === id && e.msg.event !== 'heartbeat').map((e) => e.msg),
  };
}

// --- configuration -----------------------------------------------------------------------------------------

test('config : valeurs par defaut et exemple complet', () => {
  const cfg = parseConfig({ broker: { url: 'mqtt://127.0.0.1:1883', username: 'u', password: 'p' }, devices: { a: { id: 'A1', kind: 'motion' } } });
  assert.equal(cfg.baseTopic, 'zigbee2mqtt');
  assert.equal(cfg.batteryLowPercent, 15);
  assert.equal(cfg.staleAfterS, null);
  assert.equal(cfg.devices[0]?.minDelta, 0.5);
  assert.equal(cfg.devices[0]?.humidityMinDelta, 2);
  assert.equal(cfg.devices[0]?.repeatEveryS, 900);
  assert.equal(cfg.username, 'u');
  assert.equal(parseConfig(BASE_CONFIG).devices.length, 10);
});

test('config invalide : messages clairs en francais', () => {
  const ok = { broker: { url: 'mqtt://h:1883' }, devices: { a: { id: 'A1', kind: 'motion' } } };
  const bad: [string, unknown, RegExp][] = [
    ['pas un objet', 'x', /doit etre un objet/],
    ['broker absent', { devices: ok.devices }, /« broker » est obligatoire/],
    ['url absente', { ...ok, broker: {} }, /« url » est obligatoire/],
    ['url illisible', { ...ok, broker: { url: 'pas une adresse' } }, /adresse invalide/],
    ['protocole http', { ...ok, broker: { url: 'http://h:80' } }, /protocole/],
    ['option inconnue', { ...ok, extra: 1 }, /option inconnue « extra »/],
    ['devices absent', { broker: ok.broker }, /« devices » est obligatoire/],
    ['devices vide', { ...ok, devices: {} }, /au moins un equipement/],
    ['id invalide', { ...ok, devices: { a: { id: 'a b', kind: 'motion' } } }, /« id » invalide/],
    ['id trop long', { ...ok, devices: { a: { id: 'x'.repeat(33), kind: 'motion' } } }, /« id » invalide/],
    ['id absent', { ...ok, devices: { a: { kind: 'motion' } } }, /« id » invalide/],
    ['kind inconnu', { ...ok, devices: { a: { id: 'A1', kind: 'radar' } } }, /« kind » doit etre/],
    ['id en double', { ...ok, devices: { a: { id: 'A1', kind: 'motion' }, b: { id: 'A1', kind: 'leak' } } }, /utilise deux fois/],
    ['humidityId = id', { ...ok, devices: { a: { id: 'A1', kind: 'temperature', humidityId: 'A1' } } }, /utilise deux fois/],
    ['humidityId hors temperature', { ...ok, devices: { a: { id: 'A1', kind: 'motion', humidityId: 'H1' } } }, /n'a de sens que pour/],
    ['joker dans le nom', { ...ok, devices: { 'a/#': { id: 'A1', kind: 'motion' } } }, /joker/],
    ['nom bridge', { ...ok, devices: { bridge: { id: 'A1', kind: 'motion' } } }, /reserve/],
    ['nom en /set', { ...ok, devices: { 'a/set': { id: 'A1', kind: 'motion' } } }, /ne peut pas finir/],
    ['baseTopic avec joker', { ...ok, baseTopic: 'z/#' }, /joker/],
    ['baseTopic vide', { ...ok, baseTopic: '' }, /entre 1 et 128/],
    ['option equipement inconnue', { ...ok, devices: { a: { id: 'A1', kind: 'motion', foo: 1 } } }, /option inconnue « foo »/],
    ['batterie hors bornes', { ...ok, batteryLowPercent: 150 }, /batteryLowPercent/],
    ['staleAfterS trop court', { ...ok, staleAfterS: 5 }, /staleAfterS/],
    ['heartbeat >= stale', { ...ok, staleAfterS: 60, heartbeatEveryS: 60 }, /inferieur a « staleAfterS »/],
    ['delta negatif', { ...ok, devices: { a: { id: 'A1', kind: 'temperature', minDelta: -1 } } }, /minDelta/],
  ];
  for (const [label, cfg, re] of bad) {
    assert.throws(() => create(cfg as Record<string, unknown>), re, label);
  }
});

// --- abonnements -------------------------------------------------------------------------------------------

test('abonnements : uniquement pont + equipements declares, jamais de joker', async () => {
  const h = await setup({ ...BASE_CONFIG, broker: { url: 'mqtt://10.0.0.5:1883', username: 'gw', password: 'secret' } });
  assert.deepEqual(h.openArgs, [{ url: 'mqtt://10.0.0.5:1883', opts: { username: 'gw', password: 'secret' } }]);
  assert.equal(h.subscribed[0], 'zigbee2mqtt/bridge/state');
  assert.equal(h.subscribed.length, 11);
  assert.ok(h.subscribed.includes('zigbee2mqtt/pir_salon'));
  assert.ok(!h.subscribed.some((t) => t.includes('#') || t.includes('+')));
  assert.ok(!h.logs.some((l) => l.text.includes('secret')), 'le mot de passe ne doit jamais etre journalise');
});

test('baseTopic personnalise', async () => {
  const h = await setup({ ...BASE_CONFIG, baseTopic: 'maison/zb' });
  assert.ok(h.subscribed.includes('maison/zb/bridge/state'));
  assert.ok(h.subscribed.includes('maison/zb/porte'));
});

test("echec d'ouverture MQTT : l'erreur remonte au socle", async () => {
  const mod = create(BASE_CONFIG);
  const ctx = { emit() {}, openMqtt: async () => Promise.reject(new Error('refuse')), log() {}, config: {}, now: () => T0 } as ModuleContext;
  await assert.rejects(mod.start(ctx), /refuse/);
});

// --- traduction par type -----------------------------------------------------------------------------------

test('motion : occupancy et presence -> motion / clear', async () => {
  const h = await setup();
  h.dev('pir_salon', { occupancy: true, battery: 90, linkquality: 100 });
  h.dev('pir_salon', { occupancy: false, battery: 90, linkquality: 101 });
  assert.deepEqual(h.for('zb-pir'), [{ event: 'motion' }, { event: 'clear' }]);

  const h2 = await setup();
  h2.dev('pir_salon', { presence: true });
  h2.dev('pir_salon', { presence: false });
  assert.deepEqual(h2.for('zb-pir'), [{ event: 'motion' }, { event: 'clear' }]);
});

test('contact : true = ferme -> door_closed, false = ouvert -> door_opened', async () => {
  const h = await setup();
  h.dev('porte', { contact: false });
  h.dev('porte', { contact: true });
  assert.deepEqual(h.for('zb-door'), [{ event: 'door_opened' }, { event: 'door_closed' }]);
});

test('contact + tamper -> door_forced (apres le contact, pour que l alarme prime)', async () => {
  const h = await setup();
  h.dev('porte', { contact: true, tamper: true });
  assert.deepEqual(h.for('zb-door'), [{ event: 'door_closed' }, { event: 'door_forced' }]);
});

test('leak : water_leak -> leak / dry', async () => {
  const h = await setup();
  h.dev('fuite', { water_leak: true, battery_low: false });
  h.dev('fuite', { water_leak: false, battery_low: false });
  assert.deepEqual(h.for('zb-leak'), [{ event: 'leak' }, { event: 'dry' }]);
});

test('smoke : etat alarm / normal', async () => {
  const h = await setup();
  h.dev('fumee', { smoke: true, battery_low: false, tamper: false });
  h.dev('fumee', { smoke: false });
  assert.deepEqual(h.for('zb-smoke'), [{ state: 'alarm' }, { state: 'normal' }]);
});

test('gas et monoxyde de carbone : evenement puis clear', async () => {
  const h = await setup();
  h.dev('gaz', { gas: true });
  h.dev('gaz', { gas: false });
  h.dev('co', { carbon_monoxide: true });
  h.dev('co', { carbon_monoxide: false });
  assert.deepEqual(h.for('zb-gas'), [{ event: 'gas' }, { event: 'clear' }]);
  assert.deepEqual(h.for('zb-co'), [{ event: 'co' }, { event: 'clear' }]);
});

test('vibration : champ vibration et action (tilt/drop)', async () => {
  const h = await setup();
  h.dev('choc', { vibration: true, action: 'vibration' });
  h.dev('choc', { action: 'drop' });
  assert.deepEqual(h.for('zb-vib'), [{ event: 'vibration' }, { event: 'vibration' }]);
  h.dev('choc', { vibration: false });
  assert.deepEqual(h.for('zb-vib').at(-1), { event: 'clear' });
});

test('panic : action emergency / panic, un evenement par appui date', async () => {
  const h = await setup();
  h.dev('bouton', { action: 'emergency', last_seen: '2026-10-10T09:59:59.000Z' });
  // meme heure reutilisee dans un message ulterieur : pas un nouvel appui
  h.dev('bouton', { action: 'emergency', last_seen: '2026-10-10T09:59:59.000Z' });
  h.dev('bouton', { action: 'panic', last_seen: '2026-10-10T09:59:59.500Z' });
  h.dev('bouton', { action: 'single' });
  const msgs = h.for('zb-panic');
  assert.equal(msgs.length, 2);
  assert.ok(msgs.every((m) => m.event === 'panic'));
});

test('tamper_only et sabotage : tamper ; fin de sabotage silencieuse ; nouveau sabotage renvoye', async () => {
  const h = await setup();
  h.dev('sabot', { tamper: true });
  h.dev('sabot', { tamper: false });
  h.dev('sabot', { tamper: true });
  assert.deepEqual(h.for('zb-tamper'), [{ event: 'tamper' }, { event: 'tamper' }]);
  h.dev('pir_salon', { tamper: true, occupancy: false });
  assert.deepEqual(h.for('zb-pir'), [{ event: 'clear' }, { event: 'tamper' }]);
});

test('champs inconnus ou hors type ignores, valeurs de mauvais type ignorees', async () => {
  const h = await setup();
  h.dev('pir_salon', { foo: 'bar', contact: true, water_leak: true, smoke: true, linkquality: 5, voltage: 3000 });
  h.dev('pir_salon', { occupancy: 'true' });
  h.dev('porte', { contact: 1 });
  h.dev('thermo', { temperature: 'chaud', humidity: null });
  assert.equal(h.emitted.length, 0);
});

// --- mesures -----------------------------------------------------------------------------------------------

test('temperature : une mesure par changement significatif, et une relance periodique', async () => {
  const h = await setup();
  h.dev('thermo', { temperature: 21.0, humidity: 50 });
  h.setNow(T0 + 10_000);
  h.dev('thermo', { temperature: 21.2, humidity: 51 }); // sous les seuils
  h.setNow(T0 + 20_000);
  h.dev('thermo', { temperature: 21.5, humidity: 51 }); // exactement le seuil : envoyee
  h.setNow(T0 + 30_000);
  h.dev('thermo', { temperature: 21.4, humidity: 53 }); // +0.1 : non ; humidite +2 : oui
  assert.deepEqual(h.for('zb-temp'), [{ value: 21 }, { value: 21.5 }]);
  assert.deepEqual(h.for('zb-hum'), [{ value: 50 }, { value: 53 }]);
  // aucune mesure n'a bouge, mais 15 minutes se sont ecoulees : relance
  h.setNow(T0 + 30_000 + 900_000);
  h.dev('thermo', { temperature: 21.5, humidity: 53 });
  assert.deepEqual(h.for('zb-temp').at(-1), { value: 21.5 });
  assert.equal(h.for('zb-temp').length, 3);
});

test('temperature : humidite ignoree sans humidityId, valeurs absurdes ignorees, seuils personnalises', async () => {
  const h = await setup({
    broker: { url: 'mqtt://h:1883' },
    valueMinDelta: 2,
    devices: { t: { id: 'T1', kind: 'temperature' }, u: { id: 'T2', kind: 'temperature', minDelta: 0.1, repeatEveryS: 3600 } },
  });
  h.dev('t', { temperature: 20, humidity: 40 });
  h.dev('t', { temperature: 21 }); // delta global 2 : non
  h.dev('t', { temperature: 22 }); // oui
  h.dev('t', { temperature: 9999 });
  h.dev('t', { temperature: Number.NaN });
  h.dev('u', { temperature: 20 });
  h.dev('u', { temperature: 20.1 });
  assert.deepEqual(h.for('T1'), [{ value: 20 }, { value: 22 }]);
  assert.deepEqual(h.for('T2'), [{ value: 20 }, { value: 20.1 }]);
  assert.equal(h.emitted.length, 4);
});

// --- batterie ----------------------------------------------------------------------------------------------

test('batterie : seuil de 15 %, seulement au franchissement, verrou leve apres remontee', async () => {
  const h = await setup();
  const send = (battery: number) => h.dev('pir_salon', { battery });
  send(100);
  send(16);
  assert.equal(h.for('zb-pir').length, 0, '16 % : au-dessus du seuil');
  send(15);
  assert.deepEqual(h.for('zb-pir'), [{ event: 'low_battery' }], '15 % : franchi');
  send(14);
  send(10);
  assert.equal(h.for('zb-pir').length, 1, 'pas de repetition');
  send(20);
  send(18);
  send(15);
  assert.equal(h.for('zb-pir').length, 1, 'verrou maintenu jusqu a plus de 20 %');
  send(21);
  send(14);
  assert.equal(h.for('zb-pir').length, 2, 'nouvel episode apres remontee');
});

test('batterie : battery_low et seuil configure ; valeurs absurdes ignorees', async () => {
  const h = await setup();
  h.dev('fuite', { battery_low: true });
  h.dev('fuite', { battery_low: true });
  h.dev('fuite', { battery_low: false });
  h.dev('fuite', { battery_low: true });
  assert.deepEqual(h.for('zb-leak').filter((m) => m.event === 'low_battery').length, 2);

  const h2 = await setup({ ...BASE_CONFIG, batteryLowPercent: 30 });
  h2.dev('porte', { battery: 31 });
  h2.dev('porte', { battery: 30 });
  assert.deepEqual(h2.for('zb-door'), [{ event: 'low_battery' }]);

  const h3 = await setup();
  h3.dev('porte', { battery: -5 });
  h3.dev('porte', { battery: 500 });
  h3.dev('porte', { battery: '5' });
  assert.equal(h3.emitted.length, 0);
});

test('batterie faible emise avant l alarme du meme message', async () => {
  const h = await setup();
  h.dev('fuite', { water_leak: true, battery: 5 });
  assert.deepEqual(h.for('zb-leak'), [{ event: 'low_battery' }, { event: 'leak' }]);
});

// --- deduplication, debit ---------------------------------------------------------------------------------

test('messages identiques repetes : un seul envoi', async () => {
  const h = await setup();
  for (let i = 0; i < 500; i++) h.dev('porte', { contact: false, linkquality: i % 255 });
  assert.equal(h.for('zb-door').length, 1);
});

test('valeur active repetee : relancee seulement apres repeatEveryS', async () => {
  const h = await setup();
  h.dev('fuite', { water_leak: true });
  h.setNow(T0 + 60_000);
  h.dev('fuite', { water_leak: true });
  assert.equal(h.for('zb-leak').length, 1);
  h.setNow(T0 + 901_000);
  h.dev('fuite', { water_leak: true });
  assert.equal(h.for('zb-leak').length, 2);
});

test('capteur qui oscille : plafonne par minute, journalise une seule fois, reprend ensuite', async () => {
  const h = await setup({ ...BASE_CONFIG, maxPerMinute: 10 });
  for (let i = 0; i < 400; i++) h.dev('porte', { contact: i % 2 === 0 });
  assert.equal(h.for('zb-door').length, 10);
  assert.equal(h.logs.filter((l) => l.level === 'warn' && /trop de messages/.test(l.text)).length, 1);
  h.setNow(T0 + 61_000);
  // l'etat n'a pas avance pour les envois refuses : le dernier changement est bien delivre
  h.dev('porte', { contact: true });
  assert.equal(h.for('zb-door').length, 11);
  assert.deepEqual(h.for('zb-door').at(-1), { event: 'door_closed' });
});

// --- JSON invalide -----------------------------------------------------------------------------------------

test('JSON invalide, tableau, trop gros, vide : ignores sans planter, journal limite', async () => {
  const h = await setup();
  assert.doesNotThrow(() => {
    for (let i = 0; i < 50; i++) h.dev('porte', '{pas du json');
    h.dev('porte', '[1,2,3]');
    h.dev('porte', 'null');
    h.dev('porte', '');
    h.dev('porte', Buffer.alloc(MAX_PAYLOAD_BYTES + 1, 0x20));
    h.dev('porte', Buffer.from([0xff, 0xfe, 0x00]));
  });
  assert.equal(h.emitted.length, 0);
  assert.equal(h.logs.filter((l) => l.level === 'warn' && /JSON invalide/.test(l.text)).length, 1, 'une seule alerte par minute');
  assert.ok(h.logs.some((l) => /trop volumineux/.test(l.text)));
  h.dev('porte', { contact: false });
  assert.deepEqual(h.for('zb-door'), [{ event: 'door_opened' }], 'le module continue de fonctionner');
});

test('messages sur des sujets non declares : ignores', async () => {
  const h = await setup();
  h.inject('zigbee2mqtt/inconnu', { contact: false });
  h.inject('zigbee2mqtt/porte/set', { contact: false });
  assert.equal(h.emitted.length, 0);
});

// --- pont --------------------------------------------------------------------------------------------------

test('pont hors ligne : journalise, aucun capteur declare en panne ; retour en ligne journalise', async () => {
  const h = await setup();
  h.inject('zigbee2mqtt/bridge/state', { state: 'online' });
  h.inject('zigbee2mqtt/bridge/state', 'offline');
  h.inject('zigbee2mqtt/bridge/state', { state: 'offline' });
  h.inject('zigbee2mqtt/bridge/state', 'online');
  h.inject('zigbee2mqtt/bridge/state', 'n importe quoi');
  h.inject('zigbee2mqtt/bridge/state', '{cassé');
  assert.equal(h.emitted.length, 0, 'rien n est envoye au PSIM');
  assert.equal(h.logs.filter((l) => /hors ligne/.test(l.text)).length, 1, 'un seul journal par passage hors ligne');
  assert.ok(h.logs.some((l) => /de nouveau en ligne/.test(l.text)));
  assert.ok(h.logs.some((l) => /illisible/.test(l.text)));
});

// --- horodatage et msgId -----------------------------------------------------------------------------------

test('last_seen -> ts ; msgId deterministe, identique au rejeu, distinct entre champs et valeurs', async () => {
  const h = await setup();
  const seen = '2026-10-10T09:59:58.000Z';
  h.dev('porte', { contact: false, tamper: true, last_seen: seen });
  const [opened, forced] = h.emitted.map((e) => e.msg);
  const ts = Date.parse(seen);
  assert.equal(opened?.ts, ts);
  assert.equal(forced?.ts, ts);
  assert.equal(opened?.msgId, `porte-${ts}-contact-0`);
  assert.equal(forced?.msgId, `porte-${ts}-tamper-1`);
  assert.match(opened?.msgId ?? '', /^[A-Za-z0-9_.-]+$/);

  // rejeu par une autre instance : memes identifiants
  const h2 = await setup();
  h2.dev('porte', { contact: false, tamper: true, last_seen: seen });
  assert.deepEqual(h2.emitted.map((e) => e.msg.msgId), h.emitted.map((e) => e.msg.msgId));
});

test('sans last_seen : ni ts ni msgId (le socle fournit les siens)', async () => {
  const h = await setup();
  h.dev('porte', { contact: false });
  assert.equal('ts' in (h.emitted[0]?.msg ?? {}), false);
  assert.equal('msgId' in (h.emitted[0]?.msg ?? {}), false);
});

test('last_seen en epoch (ms ou s), ISO local ; invraisemblable ou futur : ignore', async () => {
  const h = await setup();
  h.dev('porte', { contact: false, last_seen: T0 - 5000 });
  h.dev('porte', { contact: true, last_seen: Math.floor((T0 - 4000) / 1000) });
  h.dev('porte', { contact: false, last_seen: '2026-10-10T11:59:57+02:00' });
  h.dev('porte', { contact: true, last_seen: T0 + 3600_000 }); // futur
  h.dev('porte', { contact: false, last_seen: 'hier' });
  const tss = h.emitted.map((e) => e.msg.ts);
  assert.deepEqual(tss.slice(0, 3), [T0 - 5000, Math.floor((T0 - 4000) / 1000) * 1000, T0 - 3000]);
  assert.equal(tss[3], undefined);
  assert.equal(tss[4], undefined);
  assert.ok(tss.every((t) => t === undefined || Number.isInteger(t)));
});

test('message conserve trop ancien : ignore, sans rien deduire', async () => {
  const h = await setup();
  h.dev('fuite', { water_leak: true, last_seen: '2026-10-07T10:00:00.000Z' });
  assert.equal(h.emitted.length, 0);
  assert.ok(h.logs.some((l) => /trop ancien/.test(l.text)));
  h.dev('fuite', { water_leak: true, last_seen: '2026-10-10T09:59:50.000Z' });
  assert.equal(h.for('zb-leak').length, 1);
  // maxAgeS = 0 : plus de limite
  const h2 = await setup({ ...BASE_CONFIG, maxAgeS: 0 });
  h2.dev('fuite', { water_leak: true, last_seen: '2026-10-07T10:00:00.000Z' });
  assert.equal(h2.for('zb-leak').length, 1);
});

// --- signe de vie ------------------------------------------------------------------------------------------

test('heartbeat : tant que le capteur a parle depuis moins de staleAfterS, suspendu si pont hors ligne', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = await setup({ ...BASE_CONFIG, staleAfterS: 300, heartbeatEveryS: 60 });
  const beats = () => h.emitted.filter((e) => e.msg.event === 'heartbeat').map((e) => e.id);

  h.setNow(T0 + 60_000);
  t.mock.timers.tick(60_000);
  assert.equal(beats().length, 11, 'tous les equipements (dont l humidite) sont maintenus en vie au demarrage');

  // Seule la porte parle ; les autres se taisent au-dela de 300 s
  h.setNow(T0 + 240_000);
  h.dev('porte', { contact: true });
  h.setNow(T0 + 400_000);
  h.emitted.length = 0;
  t.mock.timers.tick(60_000);
  assert.deepEqual(beats(), ['zb-door']);

  // pont hors ligne : plus de signes de vie
  h.inject('zigbee2mqtt/bridge/state', 'offline');
  h.emitted.length = 0;
  t.mock.timers.tick(60_000);
  assert.equal(h.emitted.length, 0);

  await h.mod.stop();
  h.inject('zigbee2mqtt/bridge/state', 'online');
  t.mock.timers.tick(600_000);
  assert.equal(h.emitted.length, 0, 'aucun heartbeat apres arret');
});

test('sans staleAfterS : aucun heartbeat', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = await setup();
  t.mock.timers.tick(3_600_000);
  assert.equal(h.emitted.length, 0);
});

// --- arret -------------------------------------------------------------------------------------------------

test('arret propre : liaison fermee, messages tardifs ignores, arret repete sans effet', async () => {
  const h = await setup();
  h.dev('porte', { contact: false });
  await h.mod.stop();
  assert.equal(h.closed(), 1);
  h.dev('porte', { contact: true });
  h.inject('zigbee2mqtt/bridge/state', 'offline');
  assert.equal(h.for('zb-door').length, 1);
  await h.mod.stop();
  assert.equal(h.closed(), 1);
});

test('arret avant demarrage : sans erreur ; module nomme zigbee', async () => {
  const h = await setup(BASE_CONFIG, false);
  assert.equal(h.mod.name, 'zigbee');
  await assert.doesNotReject(h.mod.stop());
});

test('msgId toujours accepte par le PSIM, meme avec un nom Zigbee2MQTT pathologique (accents, espaces, « / », 100+ caracteres)', async () => {
  const MSG_ID = /^[A-Za-z0-9._:-]{1,64}$/;
  const names = [
    'Entrée principale/porte du hall',
    `bâtiment A/${'très long nom de capteur '.repeat(5)}`.slice(0, 120),
    'salle:serveur 1',
    'éèêàç/ôû',
  ];
  const devices: Record<string, unknown> = {};
  names.forEach((n, i) => (devices[n] = { id: `zb-p${i}`, kind: 'contact' }));
  const h = await setup({ broker: { url: 'mqtt://127.0.0.1:1883' }, devices });
  const h2 = await setup({ broker: { url: 'mqtt://127.0.0.1:1883' }, devices });
  const seen = '2026-10-10T09:59:58.000Z';
  for (const n of names) {
    h.dev(n, { contact: false, tamper: true, last_seen: seen });
    h2.dev(n, { contact: false, tamper: true, last_seen: seen });
  }
  const ids = h.emitted.map((e) => e.msg.msgId ?? '');
  assert.equal(ids.length, names.length * 2);
  for (const id of ids) assert.match(id, MSG_ID, id);
  assert.equal(new Set(ids).size, ids.length, 'tous distincts');
  assert.deepEqual(h2.emitted.map((e) => e.msg.msgId), ids, 'deterministes (rejeu, redemarrage)');
});
