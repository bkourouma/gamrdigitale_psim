import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DeviceMessage, ModuleContext, MqttLink } from '../src/module.ts';
import { create, lookup } from '../src/modules/lorawan/index.ts';
import { PROFILES } from '../src/modules/lorawan/profiles.ts';

const T0 = Date.parse('2026-10-10T08:15:30.000Z');
const APP = '52f14cd4-c6f1-4fbd-8f87-4025e1d49242';
const EUI = 'a84041ffff1a2b3c';
const EUI2 = '70b3d57ed0012345';

type Handler = (topic: string, payload: Buffer) => void;

/** Contexte factice : faux broker ChirpStack, messages emis et journal captures, horloge pilotee. */
function harness(config: Record<string, unknown>, opts: { failSubscribeAt?: number } = {}) {
  const emitted: { id: string; msg: DeviceMessage }[] = [];
  const logs: { level: string; text: string }[] = [];
  const subs: { topic: string; cb: Handler }[] = [];
  const opened: { url: string; opts?: { username?: string; password?: string } }[] = [];
  let clock = T0;
  let closed = 0;
  const link: MqttLink = {
    async subscribe(topic, cb) {
      if (opts.failSubscribeAt !== undefined && subs.length === opts.failSubscribeAt) throw new Error('refuse');
      subs.push({ topic, cb });
    },
    async close() {
      closed += 1;
    },
  };
  const ctx: ModuleContext = {
    emit: (id, msg) => void emitted.push({ id, msg }),
    openMqtt: async (url, o) => {
      opened.push({ url, opts: o });
      return link;
    },
    log: (level, text) => void logs.push({ level, text }),
    onActuator: () => undefined,
    onAccessSync: () => undefined,
    config,
    now: () => clock,
  };
  const mod = create(config);
  function matches(pattern: string, topic: string): boolean {
    const p = pattern.split('/');
    const t = topic.split('/');
    return p.length === t.length && p.every((seg, i) => seg === '+' || seg === t[i]);
  }
  /** Publie sur le faux broker : seuls les abonnes concernes recoivent. */
  function publish(topic: string, payload: Buffer | string | object) {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    for (const s of subs) if (matches(s.topic, topic)) s.cb(topic, buf);
  }
  function up(eui: string, frame: { fCnt?: number; object?: unknown; time?: string; extra?: object }) {
    const body: Record<string, unknown> = {
      deduplicationId: 'e7c1b1a4-0f2b-4a44-9c59-1f1d5d7f4b11',
      time: frame.time ?? new Date(clock).toISOString(),
      deviceInfo: { tenantId: 'tenant', tenantName: 'GAMR', applicationId: APP, applicationName: 'chantier', deviceProfileName: 'EU868', deviceName: 'capteur', devEui: eui, tags: {} },
      devAddr: '01020304',
      adr: true,
      dr: 5,
      fPort: 2,
      confirmed: false,
      data: 'AQID',
      rxInfo: [{ gatewayId: 'ffffffffffffffff', uplinkId: 1, rssi: -97, snr: 7.5 }],
      txInfo: { frequency: 868100000, modulation: { lora: { bandwidth: 125000, spreadingFactor: 7, codeRate: 'CR_4_5' } } },
      ...frame.extra,
    };
    if (frame.fCnt !== undefined) body.fCnt = frame.fCnt; // ChirpStack omet fCnt = 0
    if (frame.object !== undefined) body.object = frame.object;
    publish(`application/${APP}/device/${eui}/event/up`, body);
  }
  function status(eui: string, body: object) {
    publish(`application/${APP}/device/${eui}/event/status`, { time: new Date(clock).toISOString(), deviceInfo: { devEui: eui }, ...body });
  }
  return {
    mod, ctx, emitted, logs, subs, opened, publish, up, status,
    advance: (s: number) => void (clock += s * 1000),
    closed: () => closed,
    start: () => mod.start(ctx),
    last: () => emitted[emitted.length - 1],
    clear: () => void (emitted.length = 0),
    warns: () => logs.filter((l) => l.level === 'warn'),
  };
}

const broker = { url: 'mqtt://192.168.1.20:1883', username: 'psim', password: 'secret' };

function cfgOf(devices: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { broker, applicationId: APP, devices, ...extra };
}

async function started(devices: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const h = harness(cfgOf(devices, extra));
  await h.start();
  return h;
}

describe('lorawan : abonnements', () => {
  it("s'abonne aux seuls evenements des devEui declares, jamais a un joker, avec les identifiants du broker", async () => {
    const h = await started({ [EUI]: { id: 'porte-1', kind: 'dragino-lds03a' }, [EUI2.toUpperCase()]: { id: 'cuve-1', kind: 'milesight-th' } });
    assert.deepEqual(h.opened, [{ url: 'mqtt://192.168.1.20:1883', opts: { username: 'psim', password: 'secret' } }]);
    assert.deepEqual(
      h.subs.map((s) => s.topic).sort(),
      ['up', 'status', 'join'].flatMap((k) => [EUI, EUI2].map((e) => `application/${APP}/device/${e}/event/${k}`)).sort(),
    );
    for (const s of h.subs) assert.ok(!s.topic.includes('#'));
  });

  it("sans applicationId, utilise « + » pour l'application mais reste limite au devEui", async () => {
    const h = harness({ broker, devices: { [EUI]: { id: 'p1', kind: 'dragino-lds03a' } } });
    await h.start();
    assert.ok(h.subs.every((s) => s.topic.startsWith('application/+/device/' + EUI + '/event/')));
  });

  it("un abonnement refuse ferme la liaison et fait echouer le demarrage", async () => {
    const h = harness(cfgOf({ [EUI]: { id: 'p1', kind: 'dragino-lds03a' } }), { failSubscribeAt: 1 });
    await assert.rejects(h.start(), /abonnement impossible/);
    assert.equal(h.closed(), 1);
  });

  it("ignore les messages d'une autre application ou d'un devEui non declare", async () => {
    const h = await started({ [EUI]: { id: 'p1', kind: 'dragino-lds03a' } });
    h.publish(`application/autre/device/${EUI}/event/up`, { fCnt: 1, object: { DOOR_OPEN_STATUS: 1 } });
    h.publish(`application/${APP}/device/${EUI2}/event/up`, { fCnt: 1, object: { DOOR_OPEN_STATUS: 1 } });
    assert.equal(h.emitted.length, 0);
    // un abonne direct recevrait un topic hors schema : le module l'ignore aussi
    h.subs[0]!.cb(`application/${APP}/device/${EUI}/event/log`, Buffer.from('{}'));
    h.subs[0]!.cb('n/importe/quoi', Buffer.from('{}'));
    assert.equal(h.emitted.length, 0);
  });
});

describe('lorawan : profils predefinis (charges ChirpStack v4)', () => {
  it('chaque profil est valide une fois complete (cuve : hauteur fournie)', () => {
    for (const name of Object.keys(PROFILES)) {
      const dev = name === 'dragino-ldds75' ? { id: 'x', kind: name, overrides: { niveau: { emptyAt: 2000 } } } : { id: 'x', kind: name };
      assert.doesNotThrow(() => create(cfgOf({ [EUI]: dev })), name);
    }
  });

  it('Dragino LHT65 : temperature en valeur avec bande morte et delai minimal, batterie en volts', async () => {
    const h = await started({ [EUI]: { id: 'temp-1', kind: 'dragino-lht65' } });
    h.up(EUI, { fCnt: 10, object: { BatV: 3.1, TempC_SHT: 23.45, Hum_SHT: 61.2, Ext_sensor: 'Temperature Sensor' } });
    assert.deepEqual(h.emitted.map((e) => ({ id: e.id, value: e.msg.value, event: e.msg.event })), [{ id: 'temp-1', value: 23.45, event: undefined }]);
    // variation sous la bande morte (0,5) : aucune mesure, mais un signe de vie
    h.advance(600);
    h.clear();
    h.up(EUI, { fCnt: 11, object: { BatV: 3.1, TempC_SHT: 23.6 } });
    assert.deepEqual(h.emitted.map((e) => e.msg.event), ['heartbeat']);
    // variation franche apres le delai minimal
    h.clear();
    h.advance(600);
    h.up(EUI, { fCnt: 12, object: { BatV: 3.1, TempC_SHT: 25.1 } });
    assert.equal(h.last()!.msg.value, 25.1);
    // piles faibles : une seule fois
    h.clear();
    h.up(EUI, { fCnt: 13, object: { BatV: 2.5, TempC_SHT: 25.1 } });
    assert.deepEqual(h.emitted.map((e) => e.msg.event), ['low_battery']);
    h.clear();
    h.up(EUI, { fCnt: 14, object: { BatV: 2.5, TempC_SHT: 25.1 } });
    assert.deepEqual(h.emitted.map((e) => e.msg.event), ['heartbeat']);
  });

  it('delai minimal : deux mesures tres rapprochees ne passent pas deux fois', async () => {
    const h = await started({ [EUI]: { id: 'temp-1', kind: 'milesight-th' } });
    h.up(EUI, { fCnt: 1, object: { temperature: 20, humidity: 50, battery: 90 } });
    h.advance(10);
    h.up(EUI, { fCnt: 2, object: { temperature: 30, humidity: 50, battery: 90 } });
    assert.deepEqual(h.emitted.map((e) => e.msg.value ?? e.msg.event), [20, 'heartbeat']);
    h.advance(60);
    h.up(EUI, { fCnt: 3, object: { temperature: 30, humidity: 50, battery: 90 } });
    assert.equal(h.last()!.msg.value, 30);
  });

  it('Milesight temperature/humidite : batterie en pourcent, seuil par defaut 15', async () => {
    const h = await started({ [EUI]: { id: 'temp-2', kind: 'milesight-th' } });
    h.up(EUI, { fCnt: 1, object: { temperature: 19.5, humidity: 48, battery: 14 } });
    assert.deepEqual(h.emitted.map((e) => e.msg.event ?? e.msg.value), [19.5, 'low_battery']);
  });

  it('Milesight WS301 (a qualifier) : ouverture = intrusion, fermeture = door_closed, une seule fois par changement', async () => {
    const h = await started({ [EUI]: { id: 'porte-2', kind: 'milesight-ws301' } });
    h.up(EUI, { fCnt: 1, object: { door: 'close', battery: 100 } });
    h.up(EUI, { fCnt: 2, object: { door: 'open', battery: 100 } });
    h.up(EUI, { fCnt: 3, object: { door: 'open', battery: 100 } }); // trame periodique, meme etat
    h.up(EUI, { fCnt: 4, object: { door: 'close', battery: 100 } });
    assert.deepEqual(h.emitted.map((e) => e.msg.event), ['door_closed', 'intrusion', 'heartbeat', 'door_closed']);
  });

  it('Dragino LDS03A : DOOR_OPEN_STATUS 1 = intrusion, 0 = door_closed', async () => {
    const h = await started({ [EUI]: { id: 'porte-3', kind: 'dragino-lds03a' } });
    h.up(EUI, { fCnt: 1, object: { DOOR_OPEN_STATUS: 0, DOOR_OPEN_TIMES: 3, LAST_DOOR_OPEN_DURATION: 12, BAT_V: 3.0, ALARM: 0 } });
    h.up(EUI, { fCnt: 2, object: { DOOR_OPEN_STATUS: 1, DOOR_OPEN_TIMES: 4, LAST_DOOR_OPEN_DURATION: 0, BAT_V: 3.0, ALARM: 0 } });
    assert.deepEqual(h.emitted.map((e) => e.msg.event), ['door_closed', 'intrusion']);
    assert.equal(h.last()!.msg.msgId, `${EUI}-2-${T0}-porte`);
  });

  it("Dragino LWL03A : WATER_LEAK_STATUS 1 = leak, 0 = dry", async () => {
    const h = await started({ [EUI]: { id: 'fuite-1', kind: 'dragino-lwl03a' } });
    h.up(EUI, { fCnt: 1, object: { WATER_LEAK_STATUS: 0, WATER_LEAK_TIMES: 0, LAST_WATER_LEAK_DURATION: 0, BAT_V: 3.2 } });
    h.up(EUI, { fCnt: 2, object: { WATER_LEAK_STATUS: 1, WATER_LEAK_TIMES: 1, LAST_WATER_LEAK_DURATION: 0, BAT_V: 3.2 } });
    h.up(EUI, { fCnt: 3, object: { WATER_LEAK_STATUS: 0, WATER_LEAK_TIMES: 1, LAST_WATER_LEAK_DURATION: 4, BAT_V: 3.2 } });
    assert.deepEqual(h.emitted.map((e) => e.msg.event), ['dry', 'leak', 'dry']);
  });

  it('Dragino LDDS75 (a qualifier) : distance (texte avec unite accepte) -> niveau en pourcent, borne a 0..100', async () => {
    const h = await started({ [EUI]: { id: 'cuve-2', kind: 'dragino-ldds75', overrides: { niveau: { emptyAt: 2000 } } } });
    h.up(EUI, { fCnt: 1, object: { Bat: 3.6, Distance: '1500 mm', Interrupt_flag: 0 } });
    assert.equal(h.last()!.msg.value, 25);
    h.advance(600);
    h.up(EUI, { fCnt: 2, object: { Bat: 3.6, Distance: 400 } }); // nombre brut
    assert.equal(h.last()!.msg.value, 80);
    h.advance(600);
    h.up(EUI, { fCnt: 3, object: { Bat: 3.6, Distance: '2400 mm' } }); // sous le fond : sature a 0
    assert.equal(h.last()!.msg.value, 0);
    h.advance(600);
    h.up(EUI, { fCnt: 4, object: { Bat: 3.6, Distance: '-30 mm' } }); // au-dessus du plein : sature a 100
    assert.equal(h.last()!.msg.value, 100);
  });

  it('LDDS75 sans la hauteur de cuve : refus clair a la creation', () => {
    assert.throws(() => create(cfgOf({ [EUI]: { id: 'cuve-2', kind: 'dragino-ldds75' } })), /emptyAt.*cuve est vide/);
  });

  it('Milesight WS202 : pir trigger = motion, normal = clear', async () => {
    const h = await started({ [EUI]: { id: 'pir-1', kind: 'milesight-ws202' } });
    h.up(EUI, { fCnt: 1, object: { battery: 87, daylight: 'dark', pir: 'trigger' } });
    h.up(EUI, { fCnt: 2, object: { battery: 87, daylight: 'dark', pir: 'normal' } });
    h.up(EUI, { fCnt: 3, object: { battery: 87, daylight: 'dark', pir: 'trigger' } });
    assert.deepEqual(h.emitted.map((e) => e.msg.event), ['motion', 'clear', 'motion']);
  });

  it('boutons SOS : chaque appui est un evenement panic, meme sans retour a repos', async () => {
    const h = await started({
      [EUI]: { id: 'sos-1', kind: 'milesight-ws101' },
      [EUI2]: { id: 'sos-2', kind: 'bouton-sos' },
    });
    h.up(EUI, { fCnt: 1, object: { press: 'short', battery: 90 } });
    h.up(EUI, { fCnt: 2, object: { press: 'long', battery: 90 } });
    h.up(EUI, { fCnt: 3, object: { press: 'long', battery: 90 } });
    assert.deepEqual(h.emitted.map((e) => e.msg.event), ['heartbeat', 'panic', 'panic']);
    h.clear();
    h.up(EUI2, { fCnt: 1, object: { alarm: true, battery: 80 } });
    h.up(EUI2, { fCnt: 2, object: { alarm: true, battery: 80 } });
    assert.deepEqual(h.emitted.map((e) => [e.id, e.msg.event]), [['sos-2', 'panic'], ['sos-2', 'panic']]);
  });
});

describe('lorawan : traduction personnalisee (mapping)', () => {
  it("mesure avec echelle, decalage et chemin imbrique / tableau", async () => {
    const h = await started({
      [EUI]: { id: 'press-1', mapping: [{ key: 'p', from: 'object.mesures.0.pression_pa', type: 'number', scale: 0.01, offset: -1000, emit: { value: true } }] },
    });
    h.up(EUI, { fCnt: 1, object: { mesures: [{ pression_pa: 101325 }] } });
    assert.equal(h.last()!.msg.value, 13.25);
  });

  it('seuil avec hysteresis : declenche une fois, ne rebascule qu apres retour franc', async () => {
    const h = await started({
      [EUI]: {
        id: 'cuve-3',
        mapping: [{ from: 'object.temp', type: 'number', when: 'above', threshold: 60, hysteresis: 5, emit: { event: 'over_temperature', value: true }, emitElse: { event: 'normal' } }],
      },
    });
    const seq = [50, 61, 62, 58, 57, 54, 70];
    seq.forEach((t, i) => h.up(EUI, { fCnt: i + 1, object: { temp: t } }));
    assert.deepEqual(h.emitted.map((e) => [e.msg.event, e.msg.value]), [
      ['normal', undefined], // premiere trame : etat initial
      ['over_temperature', 61],
      ['heartbeat', undefined],
      ['heartbeat', undefined], // 58 : entre 55 et 60, reste actif
      ['heartbeat', undefined], // 57
      ['normal', undefined], // 54 : sous 55
      ['over_temperature', 70],
    ]);
  });

  it("etat explicite (state) emis a la place d'un evenement", async () => {
    const h = await started({
      [EUI]: { id: 'g1', mapping: [{ from: 'object.gas', type: 'bool', emit: { state: 'alarm' }, emitElse: { state: 'normal' } }] },
    });
    h.up(EUI, { fCnt: 1, object: { gas: 'true' } });
    h.up(EUI, { fCnt: 2, object: { gas: 0 } });
    assert.deepEqual(h.emitted.map((e) => e.msg.state), ['alarm', 'normal']);
  });

  it('bool equals:false, enum avec valeurs numeriques, valeurs inconnues sans effet', async () => {
    const h = await started({
      [EUI]: {
        id: 'm1',
        mapping: [
          { key: 'ferme', from: 'object.closed', type: 'bool', equals: false, emit: { event: 'intrusion' } },
          { key: 'mode', from: 'object.mode', type: 'enum', map: { '1': { event: 'door_opened' }, '2': { event: 'tamper' } } },
        ],
      },
    });
    h.up(EUI, { fCnt: 1, object: { closed: true, mode: 9 } });
    assert.deepEqual(h.emitted.map((e) => e.msg.event), ['heartbeat']);
    h.up(EUI, { fCnt: 2, object: { closed: false, mode: 2 } });
    assert.deepEqual(h.emitted.slice(1).map((e) => e.msg.event), ['intrusion', 'tamper']);
    assert.deepEqual(h.emitted.slice(1).map((e) => e.msg.msgId), [`${EUI}-2-${T0}-ferme`, `${EUI}-2-${T0}-mode`]);
  });

  it("overrides : corrige le nom de champ d'un profil sans code", async () => {
    const h = await started({ [EUI]: { id: 'porte-4', kind: 'milesight-ws301', overrides: { porte: { from: 'object.magnet_status' } } } });
    h.up(EUI, { fCnt: 1, object: { magnet_status: 'open' } });
    assert.equal(h.last()!.msg.event, 'intrusion');
    // l'ancien champ n'est plus lu
    h.up(EUI, { fCnt: 2, object: { door: 'close' } });
    assert.equal(h.last()!.msg.event, 'heartbeat');
  });

  it('une mesure aberrante (non numerique, hors plage) est ignoree sans casser le reste', async () => {
    const h = await started({ [EUI]: { id: 'temp-3', kind: 'milesight-th' } });
    h.up(EUI, { fCnt: 1, object: { temperature: 'erreur', battery: 250 } });
    assert.deepEqual(h.emitted.map((e) => e.msg.event), ['heartbeat']);
    assert.ok(h.warns().length >= 1);
  });
});

describe('lorawan : chemins sur (jamais d eval, jamais de prototype)', () => {
  it('refuse a la configuration les chemins dangereux ou mal formes', () => {
    const bad = [
      'object.__proto__.x',
      'object.a.constructor',
      'object.prototype',
      'object.a[0]',
      'object',
      'temp',
      'object..x',
      'object.a b;process.exit()',
      'object.' + 'a.'.repeat(9) + 'z',
      "object.a'+alert(1)+'",
    ];
    for (const from of bad) {
      assert.throws(() => create(cfgOf({ [EUI]: { id: 'x', mapping: [{ from, type: 'number', emit: { value: true } }] } })), /lorawan/, from);
    }
  });

  it('lookup ne lit que les proprietes propres, meme avec un JSON piege', async () => {
    assert.equal(lookup({}, ['toString']), undefined);
    assert.equal(lookup({}, ['__proto__']), undefined);
    assert.equal(lookup(JSON.parse('{"__proto__":{"t":1}}'), ['t']), undefined);
    assert.equal(lookup([1, 2], ['length']), undefined);
    assert.equal(lookup({ a: [5, 6] }, ['a', '1']), 6);
    const h = await started({ [EUI]: { id: 'x', mapping: [{ key: 't', from: 'object.t', type: 'number', emit: { value: true } }] } });
    h.publish(`application/${APP}/device/${EUI}/event/up`, '{"fCnt":1,"object":{"__proto__":{"t":99}}}');
    assert.deepEqual(h.emitted.map((e) => e.msg.event), ['heartbeat']);
    assert.equal(({} as Record<string, unknown>).t, undefined, "le prototype d'Object n'a pas ete pollue");
  });
});

describe('lorawan : charges invalides', () => {
  it('JSON invalide, non-objet, trop gros : ignores, journalises, sans exception', async () => {
    const h = await started({ [EUI]: { id: 'p1', kind: 'dragino-lds03a' } });
    const topic = `application/${APP}/device/${EUI}/event/up`;
    h.publish(topic, '{pas du json');
    h.publish(topic, '[1,2,3]');
    h.publish(topic, 'null');
    h.publish(topic, Buffer.alloc(70 * 1024, 0x20));
    assert.equal(h.emitted.length, 0);
    assert.ok(h.warns().length >= 1);
    for (const w of h.warns()) assert.ok(!w.text.includes('secret'));
  });

  it('les avertissements repetes sont regroupes (un par minute et par capteur)', async () => {
    const h = await started({ [EUI]: { id: 'p1', kind: 'dragino-lds03a' } });
    for (let i = 0; i < 50; i++) h.publish(`application/${APP}/device/${EUI}/event/up`, 'oups');
    assert.equal(h.warns().length, 1);
    h.advance(61);
    h.publish(`application/${APP}/device/${EUI}/event/up`, 'oups');
    assert.equal(h.warns().length, 2);
    assert.match(h.warns()[1]!.text, /\+49 similaires/);
  });

  it('un devEui du contenu different de celui du topic est refuse', async () => {
    const h = await started({ [EUI]: { id: 'p1', kind: 'dragino-lds03a' } });
    h.up(EUI2, { fCnt: 1, object: { DOOR_OPEN_STATUS: 1 } }); // pas abonne
    h.publish(`application/${APP}/device/${EUI}/event/up`, { fCnt: 1, deviceInfo: { devEui: EUI2 }, object: { DOOR_OPEN_STATUS: 1 } });
    assert.equal(h.emitted.length, 0);
    assert.ok(h.warns().some((w) => /devEui/.test(w.text)));
  });

  it("trame sans objet decode : signe de vie seulement, avec un avertissement sur le codec", async () => {
    const h = await started({ [EUI]: { id: 'p1', kind: 'dragino-lds03a' } });
    h.up(EUI, { fCnt: 1 });
    assert.deepEqual(h.emitted.map((e) => e.msg.event), ['heartbeat']);
    assert.ok(h.warns().some((w) => /codec/.test(w.text)));
  });

  it('fCnt invalide : trame ignoree', async () => {
    const h = await started({ [EUI]: { id: 'p1', kind: 'dragino-lds03a' } });
    h.up(EUI, { extra: { fCnt: -3 }, object: { DOOR_OPEN_STATUS: 1 } });
    h.up(EUI, { extra: { fCnt: 'abc' }, object: { DOOR_OPEN_STATUS: 1 } });
    assert.equal(h.emitted.length, 0);
  });
});

describe('lorawan : anti-doublons, horodatage', () => {
  it('une retransmission (meme fCnt) est ignoree, y compris le signe de vie', async () => {
    const h = await started({ [EUI]: { id: 'porte-1', kind: 'dragino-lds03a' } });
    h.up(EUI, { fCnt: 7, object: { DOOR_OPEN_STATUS: 1, BAT_V: 3 } });
    h.up(EUI, { fCnt: 7, object: { DOOR_OPEN_STATUS: 1, BAT_V: 3 } });
    h.up(EUI, { fCnt: 7, object: { DOOR_OPEN_STATUS: 0, BAT_V: 3 } }); // meme fCnt = meme trame, quoi que dise la copie
    assert.deepEqual(h.emitted.map((e) => e.msg.event), ['intrusion']);
  });

  it("fCnt absent (ChirpStack l'omet quand il vaut 0) est traite comme 0", async () => {
    const h = await started({ [EUI]: { id: 'porte-1', kind: 'dragino-lds03a' } });
    h.up(EUI, { object: { DOOR_OPEN_STATUS: 1 } });
    h.up(EUI, { object: { DOOR_OPEN_STATUS: 1 } });
    assert.equal(h.emitted.length, 1);
    assert.equal(h.emitted[0]!.msg.msgId, `${EUI}-0-${T0}-porte`);
  });

  it("les compteurs de deux capteurs sont independants", async () => {
    const h = await started({ [EUI]: { id: 'a', kind: 'dragino-lds03a' }, [EUI2]: { id: 'b', kind: 'dragino-lds03a' } });
    h.up(EUI, { fCnt: 5, object: { DOOR_OPEN_STATUS: 1 } });
    h.up(EUI2, { fCnt: 5, object: { DOOR_OPEN_STATUS: 1 } });
    assert.deepEqual(h.emitted.map((e) => e.id), ['a', 'b']);
  });

  it('une nouvelle session (join) repart de zero : le fCnt peut etre reutilise', async () => {
    const h = await started({ [EUI]: { id: 'p', kind: 'milesight-ws202' } });
    h.up(EUI, { fCnt: 1, object: { pir: 'trigger' } });
    h.publish(`application/${APP}/device/${EUI}/event/join`, { time: new Date(T0).toISOString(), deviceInfo: { devEui: EUI }, devAddr: '0a0b0c0d' });
    h.up(EUI, { fCnt: 1, object: { pir: 'normal' } });
    assert.deepEqual(h.emitted.map((e) => e.msg.event), ['motion', 'heartbeat', 'clear']);
  });

  it("la memoire des fCnt est bornee : un tres ancien fCnt peut revenir apres un redemarrage de l'appareil", async () => {
    const h = await started({ [EUI]: { id: 'p', kind: 'milesight-ws202' } });
    for (let i = 0; i < 200; i++) {
      h.advance(2);
      h.up(EUI, { fCnt: i, object: { pir: i % 2 ? 'trigger' : 'normal' } });
    }
    const before = h.emitted.length;
    h.up(EUI, { fCnt: 199, object: { pir: 'normal' } }); // recent : retransmission ignoree
    assert.equal(h.emitted.length, before);
    h.up(EUI, { fCnt: 1, object: { pir: 'normal' } }); // sorti de la fenetre : traite
    assert.equal(h.emitted.length, before + 1);
    assert.equal(h.last()!.msg.event, 'clear');
  });

  it("ts = heure de la trame ; invalide, lointaine dans le futur ou avant l'an 2000 : heure de la passerelle", async () => {
    const h = await started({ [EUI]: { id: 'p', kind: 'dragino-lds03a' } });
    h.up(EUI, { fCnt: 1, time: '2026-10-10T08:15:20.123456+00:00', object: { DOOR_OPEN_STATUS: 1 } });
    assert.equal(h.last()!.msg.ts, Date.parse('2026-10-10T08:15:20.123Z'));
    assert.ok(Number.isInteger(h.last()!.msg.ts));
    h.up(EUI, { fCnt: 2, time: 'hier', object: { DOOR_OPEN_STATUS: 0 } });
    assert.equal(h.last()!.msg.ts, T0);
    h.up(EUI, { fCnt: 3, time: '2099-01-01T00:00:00Z', object: { DOOR_OPEN_STATUS: 1 } });
    assert.equal(h.last()!.msg.ts, T0);
    h.up(EUI, { fCnt: 4, time: '1970-01-01T00:00:10Z', object: { DOOR_OPEN_STATUS: 0 } });
    assert.equal(h.last()!.msg.ts, T0);
  });

  it('msgId deterministe <devEui>-<fCnt>-<heure>-<champ>, en minuscules', async () => {
    const h = await started({ [EUI.toUpperCase()]: { id: 'p', kind: 'dragino-lwl03a' } });
    h.up(EUI, { fCnt: 42, object: { WATER_LEAK_STATUS: 1, BAT_V: 2.0 } });
    assert.deepEqual(h.emitted.map((e) => e.msg.msgId), [`${EUI}-42-${T0}-fuite`, `${EUI}-42-${T0}-batterie`]);
  });

  it("staleAfterS : une trame trop ancienne (rattrapage) est ignoree ; reste active si le reglage est a 0", async () => {
    const h = await started({ [EUI]: { id: 'p', kind: 'dragino-lds03a' } }, { staleAfterS: 3600 });
    h.up(EUI, { fCnt: 1, time: '2026-10-10T05:00:00Z', object: { DOOR_OPEN_STATUS: 1 } });
    assert.equal(h.emitted.length, 0);
    h.up(EUI, { fCnt: 2, time: '2026-10-10T08:10:00Z', object: { DOOR_OPEN_STATUS: 1 } });
    assert.equal(h.emitted.length, 1);
    const h2 = await started({ [EUI]: { id: 'p', kind: 'dragino-lds03a' } });
    h2.up(EUI, { fCnt: 1, time: '2026-10-10T05:00:00Z', object: { DOOR_OPEN_STATUS: 1 } });
    assert.equal(h2.emitted.length, 1);
  });

  it("plafond de 60 messages par minute et par capteur", async () => {
    const h = await started({ [EUI]: { id: 'p', kind: 'milesight-ws101' } });
    for (let i = 0; i < 100; i++) h.up(EUI, { fCnt: i, object: { press: 'long' } });
    assert.equal(h.emitted.length, 60);
    h.advance(61);
    h.up(EUI, { fCnt: 1000, object: { press: 'long' } });
    assert.equal(h.emitted.length, 61);
  });
});

describe('lorawan : batterie', () => {
  it("evenement status : low_battery une seule fois au franchissement, rearme apres remontee", async () => {
    const h = await started({ [EUI]: { id: 'p', kind: 'dragino-lds03a' } }, { lowBatteryPercent: 20 });
    h.status(EUI, { margin: 9, batteryLevel: 60.5 });
    h.status(EUI, { margin: 9, batteryLevel: 19 });
    h.status(EUI, { margin: 9, batteryLevel: 18 });
    h.status(EUI, { margin: 9, batteryLevel: 21 }); // dans l'hysteresis : toujours bas
    h.status(EUI, { margin: 9, batteryLevel: 80 });
    h.status(EUI, { margin: 9, batteryLevel: 10 });
    assert.deepEqual(h.emitted.map((e) => e.msg.event), ['heartbeat', 'low_battery', 'heartbeat', 'heartbeat', 'heartbeat', 'low_battery']);
  });

  it("status : alimentation externe ou niveau indisponible = pas d'alerte batterie", async () => {
    const h = await started({ [EUI]: { id: 'p', kind: 'dragino-lds03a' } });
    h.status(EUI, { externalPowerSource: true, batteryLevel: 1 });
    h.status(EUI, { batteryLevelUnavailable: true });
    h.status(EUI, { margin: 5 });
    assert.deepEqual(h.emitted.map((e) => e.msg.event), ['heartbeat', 'heartbeat', 'heartbeat']);
  });

  it('le seuil lowBatteryPercent configure s applique aux regles en pourcent', async () => {
    const h = await started({ [EUI]: { id: 'p', kind: 'milesight-ws202' } }, { lowBatteryPercent: 30 });
    h.up(EUI, { fCnt: 1, object: { pir: 'normal', battery: 25 } });
    assert.deepEqual(h.emitted.map((e) => e.msg.event), ['clear', 'low_battery']);
  });
});

describe('lorawan : configuration invalide', () => {
  const dev = { id: 'p1', kind: 'dragino-lds03a' };
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['broker absent', { devices: { [EUI]: dev } }, /broker/],
    ['url de broker invalide', cfgOf({ [EUI]: dev }, { broker: { url: 'pas une url' } }), /broker\.url/],
    ['protocole de broker inconnu', cfgOf({ [EUI]: dev }, { broker: { url: 'ftp://x:1' } }), /protocole/],
    ['devices absent', { broker, applicationId: APP }, /devices/],
    ['devices vide', cfgOf({}), /au moins un capteur/],
    ['devEui trop court', cfgOf({ abcd: dev }), /16 caracteres hexadecimaux/],
    ['devEui non hexadecimal', cfgOf({ zzzzzzzzzzzzzzzz: dev }), /hexadecimaux/],
    ['devEui en double (casse)', cfgOf({ [EUI]: dev, [EUI.toUpperCase()]: { id: 'p2', kind: 'dragino-lwl03a' } }), /en double/],
    ['id PSIM en double', cfgOf({ [EUI]: dev, [EUI2]: dev }), /deja utilise/],
    ['id PSIM invalide', cfgOf({ [EUI]: { ...dev, id: 'a b!' } }), /identifiant PSIM invalide/],
    ['id PSIM trop long', cfgOf({ [EUI]: { ...dev, id: 'x'.repeat(33) } }), /identifiant PSIM invalide/],
    ['profil inconnu', cfgOf({ [EUI]: { id: 'p', kind: 'inconnu' } }), /profil inconnu/],
    ['capteur sans regle', cfgOf({ [EUI]: { id: 'p' } }), /aucune regle/],
    ['cle inconnue', cfgOf({ [EUI]: { ...dev, couleur: 'bleu' } }), /cle inconnue/],
    ['cle inconnue de premier niveau', cfgOf({ [EUI]: dev }, { fautDeFrappe: 1 }), /cle inconnue/],
    ['applicationId invalide', cfgOf({ [EUI]: dev }, { applicationId: 'a/b' }), /applicationId/],
    ['lowBatteryPercent hors plage', cfgOf({ [EUI]: dev }, { lowBatteryPercent: 0 }), /lowBatteryPercent/],
    ['evenement inconnu', cfgOf({ [EUI]: { id: 'p', mapping: [{ from: 'object.a', type: 'bool', emit: { event: 'explosion' } }] } }), /evenement inconnu/],
    ['etat inconnu', cfgOf({ [EUI]: { id: 'p', mapping: [{ from: 'object.a', type: 'bool', emit: { state: 'rouge' } }] } }), /etat inconnu/],
    ['event et state ensemble', cfgOf({ [EUI]: { id: 'p', mapping: [{ from: 'object.a', type: 'bool', emit: { event: 'leak', state: 'alarm' } }] } }), /pas les deux/],
    ['type inconnu', cfgOf({ [EUI]: { id: 'p', mapping: [{ from: 'object.a', type: 'texte', emit: { event: 'leak' } }] } }), /type/],
    ['mesure sans valeur', cfgOf({ [EUI]: { id: 'p', mapping: [{ from: 'object.a', type: 'number', emit: { event: 'leak' } }] } }), /value/],
    ['seuil sans when', cfgOf({ [EUI]: { id: 'p', mapping: [{ from: 'object.a', type: 'number', threshold: 3, emit: { value: true } }] } }), /when/],
    ['when sans seuil', cfgOf({ [EUI]: { id: 'p', mapping: [{ from: 'object.a', type: 'number', when: 'above', emit: { event: 'leak' } }] } }), /threshold/],
    ['valeur jointe a un booleen', cfgOf({ [EUI]: { id: 'p', mapping: [{ from: 'object.a', type: 'bool', emit: { value: true } }] } }), /numerique/],
    ['enum vide', cfgOf({ [EUI]: { id: 'p', mapping: [{ from: 'object.a', type: 'enum', map: {} }] } }), /au moins une valeur/],
    ['cle de regle en double', cfgOf({ [EUI]: { id: 'p', mapping: [{ key: 'k', from: 'object.a', type: 'bool', emit: { event: 'leak' } }, { key: 'k', from: 'object.b', type: 'bool', emit: { event: 'leak' } }] } }), /en double/],
    ['override sur une regle inexistante', cfgOf({ [EUI]: { ...dev, overrides: { nimporte: { from: 'object.x' } } } }), /aucune regle de ce nom/],
    ['override du type', cfgOf({ [EUI]: { ...dev, overrides: { porte: { type: 'number' } } } }), /ne se remplacent pas/],
    ['batterie en volts sans seuil', cfgOf({ [EUI]: { id: 'p', mapping: [{ from: 'object.v', type: 'battery', unit: 'volt' }] } }), /seuil en volts/],
  ];
  for (const [name, config, expected] of cases) {
    it(name, () => {
      assert.throws(() => create(config), (err: Error) => {
        assert.match(err.message, /^lorawan : /);
        assert.match(err.message, expected);
        return true;
      });
    });
  }

  it("l'exemple complet de la documentation (gateway/docs/lorawan.md) est valide", () => {
    assert.doesNotThrow(() =>
      create({
        broker: { url: 'mqtt://192.168.1.20:1883', username: 'gamr-lecture', password: '...' },
        applicationId: APP,
        lowBatteryPercent: 15,
        staleAfterS: 0,
        devices: {
          a84041ffff1a2b3c: { id: 'porte-atelier', kind: 'dragino-lds03a' },
          a84041ffff2d4e5f: { id: 'fuite-local-pompe', kind: 'dragino-lwl03a' },
          '70b3d57ed0012345': { id: 'cuve-gasoil', kind: 'dragino-ldds75', overrides: { niveau: { emptyAt: 2000 } } },
          '70b3d57ed0067890': { id: 'chambre-froide', kind: 'milesight-th', overrides: { temperature: { minIntervalS: 300 } } },
          '70b3d57ed00abcde': {
            id: 'pompe-vibration',
            mapping: [{ key: 'vib', from: 'object.vibration', type: 'bool', equals: true, emit: { event: 'vibration' }, emitElse: { event: 'normal' } }],
          },
        },
      }),
    );
  });

  it('une configuration complete est acceptee et le nom du module est « lorawan »', () => {
    assert.equal(create(cfgOf({ [EUI]: dev })).name, 'lorawan');
  });
});

describe('lorawan : arret et robustesse', () => {
  it("l'arret ferme la liaison, est idempotent, et plus aucun message n'est emis ensuite", async () => {
    const h = await started({ [EUI]: { id: 'p', kind: 'dragino-lds03a' } });
    h.up(EUI, { fCnt: 1, object: { DOOR_OPEN_STATUS: 1 } });
    assert.equal(h.emitted.length, 1);
    await h.mod.stop();
    await h.mod.stop();
    assert.equal(h.closed(), 1);
    h.up(EUI, { fCnt: 2, object: { DOOR_OPEN_STATUS: 0 } });
    assert.equal(h.emitted.length, 1);
  });

  it('on peut redemarrer apres un arret, avec un etat neuf', async () => {
    const h = await started({ [EUI]: { id: 'p', kind: 'dragino-lds03a' } });
    h.up(EUI, { fCnt: 1, object: { DOOR_OPEN_STATUS: 1 } });
    await h.mod.stop();
    h.subs.length = 0;
    await h.start();
    h.up(EUI, { fCnt: 1, object: { DOOR_OPEN_STATUS: 1 } });
    assert.equal(h.emitted.length, 2);
  });

  it('un demarrage double est refuse', async () => {
    const h = await started({ [EUI]: { id: 'p', kind: 'dragino-lds03a' } });
    await assert.rejects(h.start(), /deja demarre/);
  });

  it("une erreur de fermeture au stop est journalisee, pas propagee", async () => {
    const h = harness(cfgOf({ [EUI]: { id: 'p', kind: 'dragino-lds03a' } }));
    h.ctx.openMqtt = async () => ({ subscribe: async () => {}, close: async () => { throw new Error('boum'); } });
    await h.start();
    await h.mod.stop();
    assert.ok(h.warns().some((w) => /boum/.test(w.text)));
  });

  it('un emit qui leve (contre le contrat) ne tue pas le module', async () => {
    const h = await started({ [EUI]: { id: 'p', kind: 'dragino-lds03a' } });
    let n = 0;
    h.ctx.emit = () => {
      n += 1;
      throw new Error('file pleine');
    };
    h.up(EUI, { fCnt: 1, object: { DOOR_OPEN_STATUS: 1 } });
    h.up(EUI, { fCnt: 2, object: { DOOR_OPEN_STATUS: 0 } });
    assert.equal(n, 2);
    assert.ok(h.logs.some((l) => l.level === 'error'));
  });
});

describe('lorawan : msgId', () => {
  const MSG_ID = /^[A-Za-z0-9._:-]{1,64}$/;

  it('cle de regle de 40 caracteres et fCnt maximal : msgId borne a 64 caracteres, deterministe', async () => {
    const key = 'k'.repeat(40);
    const dev = { id: 'p', mapping: [{ key, from: 'object.a', type: 'bool', emit: { event: 'leak' }, emitElse: { event: 'dry' } }] };
    const h = await started({ [EUI]: dev });
    const h2 = await started({ [EUI]: dev });
    h.up(EUI, { fCnt: 0xffffffff, object: { a: true } });
    h2.up(EUI, { fCnt: 0xffffffff, object: { a: true } });
    const id = h.last()!.msg.msgId!;
    assert.match(id, MSG_ID);
    assert.equal(h2.last()!.msg.msgId, id);
  });

  it("apres une nouvelle session (fCnt repart de 0), les trames ne reprennent pas les msgId de l'ancienne (sinon le PSIM les ignorerait comme doublons)", async () => {
    const h = await started({ [EUI]: { id: 'p', kind: 'milesight-ws202' } });
    h.up(EUI, { fCnt: 1, object: { pir: 'trigger' } });
    h.up(EUI, { fCnt: 2, object: { pir: 'normal' } });
    h.advance(600);
    h.publish(`application/${APP}/device/${EUI}/event/join`, { time: new Date(T0 + 600_000).toISOString(), deviceInfo: { devEui: EUI }, devAddr: '0a0b0c0d' });
    h.up(EUI, { fCnt: 1, object: { pir: 'trigger' } });
    const motions = h.emitted.filter((e) => e.msg.event === 'motion').map((e) => e.msg.msgId);
    assert.equal(motions.length, 2);
    assert.notEqual(motions[0], motions[1]);
  });
});
