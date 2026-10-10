/**
 * Capteurs Tuya / Smart Life autres que la fumee : contact de porte, mouvement (PIR), fuite d'eau, temperature / humidite,
 * gaz, monoxyde de carbone, bouton SOS. Reponses de l'API Tuya simulees d'apres la documentation (« Standard Instruction
 * Set ») : aucun capteur reel n'a ete lu, ces types sont A QUALIFIER (docs/TUYA.md). Un faux cloud signe et verifie les
 * requetes comme dans test/tuya.test.ts ; il sert aussi les specifications des appareils (echelle des mesures).
 */
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { seedDemo } from '../server/seed.ts';
import { createTuya, readAny, TUYA_SUPERVISION_S } from '../server/tuya.ts';
import type { TuyaDevice } from '../server/tuya.ts';
import { EVENTS } from '../server/sources.ts';
import { resolveSensorType, scalesFromSpecifications, SENSOR_SPECS, SENSOR_TYPES } from '../server/tuyasensors.ts';

const ROOT = resolve(import.meta.dirname, '..');
const ACCESS_ID = 'abcd1234efgh5678';
const SECRET = 'secret-de-test-0123456789abcdef';
const DEV = 'c1b2c3d4e5f6a7b8c9d0e1';
const dp = (code: string, value: unknown) => ({ code, value });
const dev = (category: string | undefined, status: { code: string; value: unknown }[], online = true): TuyaDevice => ({ id: DEV, name: 'Capteur', online, category, status });

/** Specifications d'un capteur de temperature, au format du cloud (`values` est une chaine JSON). */
const tempSpec = (tempScale: number, humScale = 0) => ({
  category: 'wsdcg',
  functions: [],
  status: [
    { code: 'va_temperature', type: 'Integer', values: JSON.stringify({ unit: '℃', min: -400, max: 2000, scale: tempScale, step: 1 }) },
    { code: 'va_humidity', type: 'Integer', values: JSON.stringify({ unit: '%', min: 0, max: 100, scale: humScale, step: 1 }) },
    { code: 'battery_percentage', type: 'Integer', values: JSON.stringify({ unit: '%', min: 0, max: 100, scale: 0, step: 1 }) },
  ],
});

// ---------------------------------------------------------------- lecture pure

describe('Tuya capteurs : table de correspondance (lecture pure)', () => {
  const read = (device: TuyaDevice, psimCategory: Parameters<typeof readAny>[1]['psimCategory'], extra: Partial<Parameters<typeof readAny>[1]> = {}) => readAny(device, { requested: null, psimCategory, ...extra });

  it('contact de porte : doorcontact_state vrai = OUVERT ; intrusion -> alarme, acces -> information', () => {
    const open = read(dev('mcs', [dp('doorcontact_state', true), dp('battery_percentage', 90)]), 'intrusion');
    assert.deepEqual([open.kind, open.sensor, open.payloads], ['alarm', 'door', [{ event: 'intrusion' }]]);
    const closed = read(dev('mcs', [dp('doorcontact_state', false), dp('battery_percentage', 90)]), 'intrusion');
    assert.deepEqual([closed.kind, closed.payloads], ['normal', [{ event: 'door_closed' }]]);
    // controle d'acces : une porte ouverte est un fait courant, jamais une alarme
    const access = read(dev('mcs', [dp('doorcontact_state', true)]), 'access');
    assert.deepEqual([access.kind, access.payloads], ['normal', [{ event: 'door_opened' }]]);
    assert.deepEqual(read(dev('mcs', [dp('doorcontact_state', false)]), 'access').payloads, [{ event: 'door_closed' }]);
    // une valeur qui n'est pas un booleen n'est jamais lue comme « ferme »
    assert.equal(read(dev('mcs', [dp('doorcontact_state', 'open')]), 'intrusion').kind, 'fault');
    assert.equal(read(dev('mcs', [dp('doorcontact_state', null)]), 'intrusion').kind, 'fault');
  });

  it('sabotage : tamper_alarm / temper_alarm -> evenement tamper ; pile faible -> low_battery ; l\'alarme reste prioritaire', () => {
    for (const code of ['tamper_alarm', 'temper_alarm']) {
      const r = read(dev('mcs', [dp('doorcontact_state', false), dp(code, true)]), 'intrusion');
      assert.deepEqual([r.kind, r.payloads], ['alarm', [{ event: 'tamper' }]], code);
    }
    assert.equal(read(dev('mcs', [dp('doorcontact_state', false), dp('temper_alarm', false)]), 'intrusion').kind, 'normal');
    const low = read(dev('mcs', [dp('doorcontact_state', false), dp('battery_percentage', 12)]), 'intrusion');
    assert.deepEqual([low.kind, low.reason, low.payloads], ['fault', 'pile faible', [{ event: 'low_battery' }]]);
    assert.equal(read(dev('mcs', [dp('doorcontact_state', false), dp('battery_state', 'low')]), 'intrusion').kind, 'fault');
    assert.equal(read(dev('mcs', [dp('doorcontact_state', false), dp('battery_percentage', 16)]), 'intrusion').kind, 'normal', 'au-dessus du seuil');
    assert.equal(read(dev('mcs', [dp('doorcontact_state', true), dp('battery_percentage', 5)]), 'intrusion').kind, 'alarm', 'une porte ouverte prime sur une pile faible');
    assert.deepEqual(read(dev('mcs', [dp('doorcontact_state', true), dp('tamper_alarm', true)]), 'intrusion').payloads, [{ event: 'intrusion' }, { event: 'tamper' }], 'ouverture et sabotage : les deux sont envoyes, le sabotage restant actif en zone desarmee');
  });

  it("appareil muet ou hors ligne : silence (rien n'est envoye), sauf alarme lue ; jamais « normal » pour un appareil hors ligne", () => {
    assert.deepEqual(read(dev('mcs', [dp('doorcontact_state', false)], false), 'intrusion'), { kind: 'silent', reason: "l'appareil est hors ligne pour Tuya (pile, WiFi)", payloads: [], sensor: 'door' });
    assert.equal(read(dev('mcs', [dp('doorcontact_state', true)], false), 'intrusion').kind, 'alarm', 'alarme lue, meme hors ligne');
    assert.equal(read(dev('pir', [dp('pir', 'none')], false), 'intrusion').kind, 'silent');
    assert.equal(read(dev('sj', [dp('watersensor_state', 'normal')], false), 'environment').kind, 'silent');
    assert.equal(read(dev('wsdcg', [dp('va_temperature', 215)], false), 'environment', { scales: { va_temperature: 1 } }).kind, 'silent');
  });

  it('mouvement : pir = « pir » -> motion, « none » -> clear ; autre valeur -> defaut', () => {
    assert.deepEqual(read(dev('pir', [dp('pir', 'pir'), dp('battery_percentage', 70)]), 'intrusion').payloads, [{ event: 'motion' }]);
    assert.deepEqual(read(dev('pir', [dp('pir', 'none'), dp('battery_percentage', 70)]), 'intrusion').payloads, [{ event: 'clear' }]);
    const odd = read(dev('pir', [dp('pir', 'big_move')]), 'intrusion');
    assert.equal(odd.kind, 'fault');
    assert.match(odd.reason, /valeur inattendue pour pir/);
  });

  it("fuite d'eau : watersensor_state alarm -> leak, normal -> dry", () => {
    assert.deepEqual(read(dev('sj', [dp('watersensor_state', 'alarm'), dp('battery_percentage', 100)]), 'environment').payloads, [{ event: 'leak' }]);
    assert.deepEqual(read(dev('sj', [dp('watersensor_state', 'normal'), dp('battery_percentage', 100)]), 'environment').payloads, [{ event: 'dry' }]);
    assert.equal(read(dev('sj', [dp('watersensor_state', 'wet?')]), 'environment').kind, 'fault');
  });

  it('gaz et monoxyde de carbone : deux noms de code chacun ; alarm -> gas / co, normal -> retour a la normale', () => {
    for (const code of ['gas_sensor_status', 'gas_sensor_state']) {
      assert.deepEqual(read(dev('rqbj', [dp(code, 'alarm')]), 'environment').payloads, [{ event: 'gas' }], code);
      assert.deepEqual(read(dev('rqbj', [dp(code, 'normal')]), 'environment').payloads, [{ event: 'normal' }], code);
    }
    for (const code of ['co_status', 'co_state']) {
      assert.deepEqual(read(dev('cobj', [dp(code, 'alarm')]), 'environment').payloads, [{ event: 'co' }], code);
      assert.deepEqual(read(dev('cobj', [dp(code, 'normal')]), 'environment').payloads, [{ event: 'normal' }], code);
    }
    assert.equal(read(dev('rqbj', [dp('gas_sensor_status', 'preheat')]), 'environment').kind, 'fault', 'etat inconnu (prechauffage) : jamais normal');
    // les deux noms publies a la fois : une seule alarme suffit
    assert.equal(read(dev('rqbj', [dp('gas_sensor_status', 'normal'), dp('gas_sensor_state', 'alarm')]), 'environment').kind, 'alarm');
  });

  it('bouton SOS : sos_state vrai -> sos ; faux -> retour au repos', () => {
    assert.deepEqual(read(dev('sos', [dp('sos_state', true), dp('battery_percentage', 80)]), 'people').payloads, [{ event: 'sos' }]);
    assert.deepEqual(read(dev('sos', [dp('sos_state', false), dp('battery_percentage', 80)]), 'people').payloads, [{ event: 'alarm_reset' }]);
  });

  it("temperature : l'echelle vient des specifications de l'appareil (0,1 °C, 0,01 °C ou entier), jamais devinee", () => {
    const s1 = read(dev('wsdcg', [dp('va_temperature', 215), dp('va_humidity', 63), dp('battery_percentage', 88)]), 'environment', { scales: { va_temperature: 1, va_humidity: 0 } });
    assert.deepEqual([s1.kind, s1.payloads, s1.reason], ['normal', [{ event: 'normal', value: 21.5 }], '21,5 °C, humidite 63 %']);
    const s0 = read(dev('wsdcg', [dp('temp_current', 22), dp('humidity_value', 55)]), 'environment', { scales: { temp_current: 0, humidity_value: 0 } });
    assert.deepEqual(s0.payloads, [{ event: 'normal', value: 22 }]);
    const s2 = read(dev('wsdcg', [dp('va_temperature', 2150)]), 'environment', { scales: { va_temperature: 2 } });
    assert.deepEqual(s2.payloads, [{ event: 'normal', value: 21.5 }]);
    assert.deepEqual(read(dev('wsdcg', [dp('va_temperature', -35)]), 'environment', { scales: { va_temperature: 1 } }).payloads, [{ event: 'normal', value: -3.5 }], 'temperature negative');
    // echelle inconnue : aucune mesure inventee
    const noScale = read(dev('wsdcg', [dp('va_temperature', 215)]), 'environment');
    assert.equal(noScale.kind, 'fault');
    assert.match(noScale.reason, /echelle de la mesure va_temperature inconnue/);
    // valeur hors plage physique (mauvaise echelle) : defaut, pas de mesure envoyee
    const absurd = read(dev('wsdcg', [dp('va_temperature', 2150)]), 'environment', { scales: { va_temperature: 0 } });
    assert.equal(absurd.kind, 'fault');
    assert.match(absurd.reason, /incoherente/);
    assert.equal(read(dev('wsdcg', [dp('va_temperature', '21.5')]), 'environment', { scales: { va_temperature: 1 } }).kind, 'fault');
  });

  it("temperature : les seuils du PSIM decident ; une alarme n'est jamais ecrasee par une pile faible", () => {
    const settings = { warnAt: 30, alarmAt: 38, direction: 'above' as const };
    const hot = read(dev('wsdcg', [dp('va_temperature', 405), dp('battery_percentage', 5)]), 'environment', { scales: { va_temperature: 1 }, settings });
    assert.deepEqual([hot.kind, hot.payloads], ['alarm', [{ value: 40.5 }]]);
    const warm = read(dev('wsdcg', [dp('va_temperature', 320), dp('battery_percentage', 5)]), 'environment', { scales: { va_temperature: 1 }, settings });
    assert.deepEqual([warm.kind, warm.payloads], ['prealarm', [{ value: 32 }]]);
    const lowOnly = read(dev('wsdcg', [dp('va_temperature', 215), dp('battery_percentage', 5)]), 'environment', { scales: { va_temperature: 1 }, settings });
    assert.deepEqual([lowOnly.kind, lowOnly.payloads], ['fault', [{ event: 'low_battery', value: 21.5 }]]);
  });

  it("categorie Tuya inconnue ou aucune fonction reconnue : « modele non pris en charge », jamais « normal »", () => {
    for (const category of ['intrusion', 'access', 'environment', 'people', 'fire'] as const) {
      const r = read(dev('xyz', [dp('switch_1', true)]), category);
      assert.equal(r.kind, 'fault', category);
      if (category !== 'fire') assert.match(r.reason, /modele non pris en charge.*switch_1/, category);
    }
    assert.equal(read(dev('mcs', []), 'intrusion').kind, 'fault', 'categorie connue mais aucune donnee');
    assert.match(read(dev('mcs', [dp('switch_1', true)]), 'intrusion').reason, /modele non pris en charge/);
    assert.match(read(dev('wsdcg', [dp('switch_1', true)]), 'environment', { scales: {} }).reason, /modele non pris en charge/);
  });

  it('type de capteur : choix explicite > categorie Tuya > codes presents ; categorie du detecteur verifiee', () => {
    // sans categorie Tuya : deduit des codes
    assert.deepEqual(resolveSensorType(dev(undefined, [dp('doorcontact_state', false)]), null, 'intrusion'), { type: 'door' });
    assert.deepEqual(resolveSensorType(dev(undefined, [dp('smoke_sensor_status', 'normal')]), null, 'fire'), { type: 'smoke' });
    // ambigu : on ne devine pas
    assert.match((resolveSensorType(dev(undefined, [dp('pir', 'none'), dp('doorcontact_state', false)]), null, 'intrusion') as { error: string }).error, /plusieurs fonctions/);
    // le type choisi dans l'interface l'emporte sur la categorie Tuya
    assert.deepEqual(resolveSensorType(dev('xyz', [dp('doorcontact_state', false)]), 'door', 'intrusion'), { type: 'door' });
    // un detecteur incendie qui recoit un contact : refuse
    assert.match((resolveSensorType(dev('mcs', [dp('doorcontact_state', false)]), null, 'fire') as { error: string }).error, /incompatible/);
    assert.match((resolveSensorType(dev('ywbj', [dp('smoke_sensor_status', 'normal')]), null, 'intrusion') as { error: string }).error, /incompatible/);
    assert.deepEqual(resolveSensorType(dev('ywbj', []), null, 'fire'), { type: 'smoke' });
    // chaque categorie Tuya du tableau designe bien son type
    const expected: Record<string, string> = { ywbj: 'smoke', mcs: 'door', pir: 'motion', sj: 'water', wsdcg: 'temperature', rqbj: 'gas', cobj: 'co', sos: 'sos' };
    for (const [category, type] of Object.entries(expected)) assert.deepEqual(resolveSensorType(dev(category, []), null, null), { type }, category);
    // type explicite sans la bonne fonction : defaut, pas de lecture « normale »
    const wrong = readAny(dev('xyz', [dp('pir', 'none')]), { requested: 'door', psimCategory: 'intrusion' });
    assert.equal(wrong.kind, 'fault');
  });

  it('le tableau est coherent : chaque evenement emis existe dans le moteur ; types, categories et statut documentes', () => {
    const emitted = new Set(['intrusion', 'door_opened', 'door_closed', 'motion', 'clear', 'leak', 'dry', 'gas', 'co', 'normal', 'sos', 'alarm_reset', 'tamper', 'low_battery', 'fault']);
    for (const e of emitted) assert.ok(Object.hasOwn(EVENTS, e), `evenement inconnu du moteur : ${e}`);
    for (const type of SENSOR_TYPES) {
      const spec = SENSOR_SPECS[type];
      assert.ok(spec.codes.length > 0 && spec.tuyaCategories.length > 0 && spec.psimCategories.length > 0, type);
      assert.equal(spec.qualified, type === 'smoke', `${type} : seule la fumee est validee avec un appareil reel`);
    }
  });

  it('specifications Tuya : echelle lue dans values (chaine JSON), valeurs illisibles ignorees', () => {
    assert.deepEqual(scalesFromSpecifications(tempSpec(1)), { va_temperature: 1, va_humidity: 0, battery_percentage: 0 });
    assert.deepEqual(scalesFromSpecifications({ status: [{ code: 'a', values: '{pas du json' }, { code: 'b', values: '{"scale":"1"}' }, null] }), {});
    assert.deepEqual(scalesFromSpecifications(null), {});
  });
});

// ---------------------------------------------------------------- cloud et moteur

function fakeCloud() {
  const devices = new Map<string, TuyaDevice>();
  const specs = new Map<string, unknown>();
  const state = { specCalls: 0, specFails: false };
  const TOKEN = 'tok-0123456789';
  const server = createServer((req, res) => {
    const json = (body: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const h = req.headers;
    const isToken = req.url!.startsWith('/v1.0/token');
    const token = isToken ? '' : String(h.access_token ?? '');
    const stringToSign = `GET\n${createHash('sha256').update('').digest('hex')}\n\n${req.url}`;
    const expected = createHmac('sha256', SECRET).update(`${h.client_id}${token}${h.t}${h.nonce}${stringToSign}`).digest('hex').toUpperCase();
    if (h.client_id !== ACCESS_ID || h.sign !== expected) return json({ success: false, code: 1004, msg: 'sign invalid' });
    if (isToken) return json({ success: true, result: { access_token: TOKEN, expire_time: 7200 } });
    if (token !== TOKEN) return json({ success: false, code: 1010, msg: 'token invalid' });
    const url = new URL(req.url!, 'http://x');
    const spec = /^\/v1\.0\/devices\/([A-Za-z0-9]+)\/specifications$/.exec(url.pathname);
    if (spec) {
      state.specCalls += 1;
      if (state.specFails || !specs.has(spec[1])) return json({ success: false, code: 2009, msg: 'device is not exist' });
      return json({ success: true, result: specs.get(spec[1]) });
    }
    if (url.pathname !== '/v1.0/devices') return json({ success: false, code: 1108, msg: 'uri path invalid' }, 404);
    const ids = (url.searchParams.get('device_ids') ?? '').split(',').filter(Boolean);
    json({ success: true, result: { devices: ids.map((id) => devices.get(id)).filter(Boolean), total: ids.length } });
  });
  return {
    devices,
    specs,
    state,
    start: () => new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

describe('Tuya capteurs : du cloud au moteur du PSIM', () => {
  const cloud = fakeCloud();
  let baseUrl = '';
  before(async () => {
    baseUrl = await cloud.start();
  });
  after(() => cloud.stop());

  function setup(opts: { clock?: { t: number } } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'psim-tuya-sensors-'));
    const db = openDb(join(dir, 'psim.db'));
    seedDemo(db, dir, join(ROOT, 'seed'));
    const arming = { armed: true };
    const engine = createEngine(db, () => {}, Date.now, { isArmed: () => arming.armed });
    const audits: string[] = [];
    const realAudit = engine.audit;
    const tuya = createTuya({
      db,
      engine: { ...engine, audit: (a, b, c) => (audits.push(`${b}:${c?.details ?? ''}`), realAudit(a, b, c)) },
      account: { accessId: ACCESS_ID, accessSecret: SECRET, baseUrl },
      pollS: 120,
      now: opts.clock ? () => opts.clock!.t : undefined,
      log: () => {},
    });
    const incidents = (id: string) => engine.getSnapshot().incidents.filter((i) => i.detectorId === id && i.status !== 'closed');
    return { db, engine, tuya, audits, incidents, arming };
  }
  const put = (device: TuyaDevice) => cloud.devices.set(device.id, device);
  const link = async (t: ReturnType<typeof setup>, detector: string, tuyaDevice: TuyaDevice, input: Record<string, unknown> = {}) => {
    put(tuyaDevice);
    t.tuya.setSource('admin', detector, { deviceId: tuyaDevice.id, ...input });
    // la lecture immediate du premier enregistrement doit etre finie (sinon le poll suivant serait ignore)
    for (let i = 0; i < 200 && t.tuya.view(detector).connection?.state !== 'connected'; i++) await new Promise((r) => setTimeout(r, 15));
    await t.tuya.poll();
  };

  it("contact de porte sur un detecteur d'intrusion : ouverture en zone armee = incident « Intrusion » ; fermeture = retour a la normale ; supervision posee", async () => {
    const t = setup();
    await link(t, 'I-01', dev('mcs', [dp('doorcontact_state', false), dp('battery_percentage', 90)]));
    assert.equal(t.engine.getDevice('I-01')!.status, 'normal');
    assert.equal(t.engine.getDevice('I-01')!.heartbeatS, TUYA_SUPERVISION_S);
    assert.ok(t.engine.getDevice('I-01')!.lastSeen, 'une lecture reussie vaut signe de vie');
    assert.equal(t.tuya.view('I-01').sensorType, null, 'automatique');
    assert.equal(t.tuya.view('I-01').connection?.sensor, 'door');

    put(dev('mcs', [dp('doorcontact_state', true), dp('battery_percentage', 90)]));
    await t.tuya.poll();
    assert.equal(t.engine.getDevice('I-01')!.status, 'alarm');
    assert.equal(t.incidents('I-01').length, 1);
    assert.equal(t.incidents('I-01')[0].event, 'intrusion');
    await t.tuya.poll();
    assert.equal(t.incidents('I-01').length, 1, "une porte qui reste ouverte ne rouvre pas d'incident");

    put(dev('mcs', [dp('doorcontact_state', false), dp('battery_percentage', 90)]));
    await t.tuya.poll();
    assert.equal(t.engine.getDevice('I-01')!.status, 'normal');
    assert.equal(t.incidents('I-01').length, 1, "l'incident reste ouvert jusqu'au traitement par l'operateur");
    t.tuya.stop();
  });

  it("zone d'intrusion desarmee : l'ouverture n'ouvre pas d'incident, mais le sabotage reste actif 24 h sur 24", async () => {
    const t = setup();
    t.arming.armed = false;
    await link(t, 'I-01', dev('mcs', [dp('doorcontact_state', true)]));
    assert.equal(t.incidents('I-01').length, 0, 'le PSIM decide : zone desarmee');
    put(dev('mcs', [dp('doorcontact_state', true), dp('tamper_alarm', true)]));
    await t.tuya.poll();
    assert.equal(t.incidents('I-01').length, 1);
    assert.equal(t.incidents('I-01')[0].event, 'tamper');
    t.tuya.stop();
  });

  it("contact sur un detecteur de controle d'acces : porte ouverte = information (jamais d'incident)", async () => {
    const t = setup();
    await link(t, 'A-01', dev('mcs', [dp('doorcontact_state', true)]));
    assert.equal(t.engine.getDevice('A-01')!.status, 'normal');
    assert.equal(t.incidents('A-01').length, 0);
    assert.equal(t.tuya.view('A-01').connection?.reason, 'porte ouverte');
    assert.ok(t.engine.getDevice('A-01')!.lastSeen);
    t.tuya.stop();
  });

  it('mouvement (PIR) : detection = incident, retour au calme = normal', async () => {
    const t = setup();
    await link(t, 'I-01', dev('pir', [dp('pir', 'none'), dp('battery_percentage', 70)]));
    assert.equal(t.engine.getDevice('I-01')!.status, 'normal');
    put(dev('pir', [dp('pir', 'pir'), dp('battery_percentage', 70)]));
    await t.tuya.poll();
    assert.equal(t.incidents('I-01')[0].event, 'motion');
    put(dev('pir', [dp('pir', 'none'), dp('battery_percentage', 70)]));
    await t.tuya.poll();
    assert.equal(t.engine.getDevice('I-01')!.status, 'normal');
    t.tuya.stop();
  });

  it("fuite d'eau, gaz, monoxyde de carbone : alarmes nommees, puis retour a la normale", async () => {
    const t = setup();
    await link(t, 'E-02', dev('sj', [dp('watersensor_state', 'normal')]));
    assert.equal(t.engine.getDevice('E-02')!.status, 'normal');
    put(dev('sj', [dp('watersensor_state', 'alarm')]));
    await t.tuya.poll();
    assert.equal(t.incidents('E-02')[0].event, 'leak');
    put(dev('sj', [dp('watersensor_state', 'normal')]));
    await t.tuya.poll();
    assert.equal(t.engine.getDevice('E-02')!.status, 'normal');
    t.tuya.stop();

    for (const [category, code, event] of [['rqbj', 'gas_sensor_status', 'gas'], ['cobj', 'co_state', 'co']] as const) {
      const u = setup();
      await link(u, 'E-02', dev(category, [dp(code, 'alarm')]));
      assert.equal(u.engine.getDevice('E-02')!.status, 'alarm', category);
      assert.equal(u.incidents('E-02')[0].event, event, category);
      put(dev(category, [dp(code, 'normal')]));
      await u.tuya.poll();
      assert.equal(u.engine.getDevice('E-02')!.status, 'normal', category);
      u.tuya.stop();
    }
  });

  it('bouton SOS sur un detecteur « Personnes » : incident, meme zone desarmee', async () => {
    const t = setup();
    t.engine.createDevice('admin', { id: 'P-01', kind: 'detector', name: 'Bouton SOS chambre', zone: 'Villa', category: 'people' });
    t.arming.armed = false;
    await link(t, 'P-01', dev('sos', [dp('sos_state', false), dp('battery_percentage', 90)]));
    assert.equal(t.engine.getDevice('P-01')!.status, 'normal');
    put(dev('sos', [dp('sos_state', true), dp('battery_percentage', 90)]));
    await t.tuya.poll();
    assert.equal(t.incidents('P-01')[0].event, 'sos');
    t.tuya.stop();
  });

  it("temperature : echelle lue dans les specifications (une seule fois), mesure memorisee, seuils du PSIM, echec des specifications = defaut", async () => {
    const clock = { t: Date.now() };
    const t = setup({ clock });
    cloud.state.specCalls = 0;
    cloud.specs.set(DEV, tempSpec(1));
    await link(t, 'E-01', dev('wsdcg', [dp('va_temperature', 215), dp('va_humidity', 63), dp('battery_percentage', 90)]));
    assert.equal(t.engine.getDevice('E-01')!.status, 'normal');
    assert.equal(t.engine.getDevice('E-01')!.lastValue, 21.5);
    assert.match(t.tuya.view('E-01').connection!.reason!, /21,5 °C, humidite 63 %/);

    put(dev('wsdcg', [dp('va_temperature', 322), dp('va_humidity', 60), dp('battery_percentage', 90)]));
    await t.tuya.poll();
    assert.equal(t.engine.getDevice('E-01')!.status, 'prealarm', 'seuil de prealarme du PSIM : 30');
    put(dev('wsdcg', [dp('va_temperature', 405), dp('va_humidity', 60), dp('battery_percentage', 4)]));
    await t.tuya.poll();
    assert.equal(t.engine.getDevice('E-01')!.status, 'alarm', "seuil d'alarme du PSIM : 38, malgre la pile faible");
    assert.equal(t.engine.getDevice('E-01')!.lastValue, 40.5);
    put(dev('wsdcg', [dp('va_temperature', 230), dp('va_humidity', 60), dp('battery_percentage', 4)]));
    await t.tuya.poll();
    assert.equal(t.engine.getDevice('E-01')!.status, 'fault', 'retour sous les seuils mais pile faible');
    put(dev('wsdcg', [dp('va_temperature', 230), dp('va_humidity', 60), dp('battery_percentage', 95)]));
    await t.tuya.poll();
    assert.equal(t.engine.getDevice('E-01')!.status, 'normal', 'pile changee');
    assert.equal(cloud.state.specCalls, 1, 'specifications lues une seule fois pour tout ce temps');
    t.tuya.stop();

    // specifications illisibles : aucune mesure inventee, defaut, nouvelle tentative apres 5 minutes
    const u = setup({ clock });
    cloud.state.specCalls = 0;
    cloud.state.specFails = true;
    await link(u, 'E-01', dev('wsdcg', [dp('va_temperature', 215)]));
    assert.equal(u.engine.getDevice('E-01')!.status, 'fault');
    assert.equal(u.engine.getDevice('E-01')!.lastValue, null);
    assert.match(u.tuya.view('E-01').connection!.reason!, /echelle de la mesure/);
    await u.tuya.poll();
    assert.equal(cloud.state.specCalls, 1, "pas de nouvel appel avant l'expiration du delai");
    cloud.state.specFails = false;
    clock.t += 6 * 60_000;
    await u.tuya.poll();
    assert.equal(cloud.state.specCalls, 2);
    assert.equal(u.engine.getDevice('E-01')!.status, 'normal');
    assert.equal(u.engine.getDevice('E-01')!.lastValue, 21.5);
    u.tuya.stop();
  });

  it('modele inconnu ou hors ligne : defaut « modele non pris en charge » / silence, jamais « normal » ; lecture muette = aucun signe de vie', async () => {
    const t = setup();
    await link(t, 'I-01', dev('kg', [dp('switch_1', true)]));
    assert.equal(t.engine.getDevice('I-01')!.status, 'fault');
    assert.match(t.tuya.view('I-01').connection!.reason!, /modele non pris en charge.*switch_1/);
    assert.equal(t.tuya.view('I-01').connection!.reading, 'fault');

    // hors ligne, contact ferme : rien n'est envoye (la supervision declarera le detecteur hors ligne)
    const u = setup();
    await link(u, 'I-01', dev('mcs', [dp('doorcontact_state', false)], false));
    assert.equal(u.tuya.view('I-01').connection!.reading, 'silent');
    assert.equal(u.engine.getDevice('I-01')!.lastSeen, null, "aucun signe de vie n'est invente");
    t.tuya.stop();
    u.tuya.stop();
  });

  it("regles de l'association : type incompatible ou inconnu refuse, type memorise et journalise, categorie verrouillee", () => {
    const t = setup();
    put(dev('mcs', [dp('doorcontact_state', false)]));
    assert.throws(() => t.tuya.setSource('admin', 'E-02', { deviceId: DEV, sensorType: 'door' }), /ne s'associe pas a un detecteur de cette categorie/);
    assert.throws(() => t.tuya.setSource('admin', 'I-01', { deviceId: DEV, sensorType: 'lampe' }), /Type de capteur inconnu/);
    assert.throws(() => t.tuya.setSource('admin', 'D-01', { deviceId: DEV, sensorType: 'door' }), /ne s'associe pas/);
    const view = t.tuya.setSource('admin', 'I-01', { deviceId: DEV, sensorType: 'door' });
    assert.equal(view.sensorType, 'door');
    assert.ok(t.audits.some((a) => a === `tuya_source_updated:appareil Tuya ${DEV} ; supervision ${TUYA_SUPERVISION_S} s ; type door`));
    assert.deepEqual(view.catalog.map((c) => c.type), [...SENSOR_TYPES]);
    // « auto » efface le choix
    assert.equal(t.tuya.setSource('admin', 'I-01', { deviceId: DEV, sensorType: 'auto' }).sensorType, null);
    // le detecteur garde sa categorie tant qu'il lit un capteur Tuya
    assert.throws(() => t.engine.updateDevice('admin', 'I-01', { category: 'environment' }), /garde sa categorie/);
    t.tuya.removeSource('admin', 'I-01');
    assert.equal(t.engine.updateDevice('admin', 'I-01', { category: 'environment' }).category, 'environment');
    t.tuya.stop();
  });

  it("essai : nomme le type reconnu, applique la categorie du detecteur, n'envoie rien au moteur", async () => {
    const t = setup();
    put(dev('mcs', [dp('doorcontact_state', true), dp('battery_percentage', 90)]));
    const r = await t.tuya.test(DEV, undefined, 'I-01');
    assert.equal(r.ok, true);
    assert.equal(r.sensor, 'door');
    assert.equal(r.reading, 'alarm');
    assert.match(r.message, /Contact de porte ou fenêtre/);
    assert.equal(t.engine.getDevice('I-01')!.status, 'normal', "un essai n'ouvre jamais d'incident");
    const wrongCategory = await t.tuya.test(DEV, undefined, 'D-01');
    assert.equal(wrongCategory.ok, false);
    assert.match(wrongCategory.message, /incompatible/);
    put(dev('wsdcg', [dp('va_temperature', 215)]));
    cloud.specs.set(DEV, tempSpec(1));
    const temp = await t.tuya.test(DEV, 'temperature', 'E-01');
    assert.equal(temp.ok, true);
    assert.match(temp.message, /21,5 °C/);
    t.tuya.stop();
  });
});
