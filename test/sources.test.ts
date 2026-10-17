import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import { createRiskService } from '../server/risk.ts';
import { seedDemo } from '../server/seed.ts';
import { ALWAYS_ACTIVE_EVENTS, checkSensorSettings, EVENT_LABEL, EVENTS, eventLabel, interpret, stateFromValue } from '../server/sources.ts';
import type { SensorSettings } from '../server/sources.ts';

const T0 = 1_000_000_000_000;
const SECOND = 1000;

function setup(options: Parameters<typeof createEngine>[3] = {}) {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  let clock = T0;
  const engine = createEngine(db, () => {}, () => clock, options);
  return { db, engine, advance: (s: number) => void (clock += s * SECOND), status: (id: string) => engine.getDevice(id)?.status };
}

const temperature: SensorSettings = { category: 'environment', warnAt: 30, alarmAt: 38, direction: 'above' };
const fire: SensorSettings = { category: 'fire', warnAt: null, alarmAt: null, direction: 'above' };

describe('lecture des messages (etat, evenement, mesure)', () => {
  it("un etat explicite est repris tel quel, une mesure jointe est seulement memorisee", () => {
    assert.deepEqual(interpret(fire, { state: 'alarm' }), { ok: true, state: 'alarm', event: null, alive: false, value: null, detail: null });
    assert.deepEqual(interpret(temperature, { state: 'normal', value: 99 }), { ok: true, state: 'normal', event: null, alive: false, value: 99, detail: null });
  });

  it('les evenements nommes donnent un etat, ou un simple signe de vie', () => {
    assert.equal((interpret(fire, { event: 'door_forced' }) as { state: string }).state, 'alarm');
    assert.equal((interpret(fire, { event: 'door_held_open' }) as { state: string }).state, 'prealarm');
    assert.equal((interpret(fire, { event: 'door_closed' }) as { state: string }).state, 'normal');
    assert.equal((interpret(fire, { event: 'low_battery' }) as { state: string }).state, 'fault');
    const alive = interpret(fire, { event: 'badge_granted' });
    assert.deepEqual(alive, { ok: true, state: null, event: 'badge_granted', alive: true, value: null, detail: null });
    // un badge refuse isole n'est pas un incident ; seul « refus repetes » (decide par la passerelle) en est un
    assert.equal((interpret(fire, { event: 'badge_denied' }) as { state: null }).state, null);
    assert.equal((interpret(fire, { event: 'badge_denied_repeated' }) as { state: string }).state, 'prealarm');
  });

  it("une mesure est comparee aux seuils : normal, prealarme, alarme (limites incluses)", () => {
    assert.equal(stateFromValue(29.9, temperature), 'normal');
    assert.equal(stateFromValue(30, temperature), 'prealarm');
    assert.equal(stateFromValue(37.99, temperature), 'prealarm');
    assert.equal(stateFromValue(38, temperature), 'alarm');
    const frost = { warnAt: 4, alarmAt: 0, direction: 'below' as const };
    assert.equal(stateFromValue(10, frost), 'normal');
    assert.equal(stateFromValue(4, frost), 'prealarm');
    assert.equal(stateFromValue(-1, frost), 'alarm');
    assert.equal(stateFromValue(50, { warnAt: null, alarmAt: 38, direction: 'above' }), 'alarm', 'sans seuil de prealarme');
    assert.equal(stateFromValue(50, { warnAt: null, alarmAt: null, direction: 'above' }), null, 'sans seuil : rien a conclure');
  });

  it('refuse tout ce qui ressemble a une attaque ou a une erreur, sans jamais lever d exception', () => {
    for (const bad of [null, 'alarm', 42, [], {}, { state: 'explosion' }, { state: 3 }, { event: 'inconnu' }, { event: '__proto__' }, { event: 'constructor' }, { value: 'chaud' }, { value: NaN }, { value: Infinity }, { value: 1e12 }, { value: {} }]) {
      const r = interpret(temperature, bad);
      assert.equal(r.ok, false, `refuse ${JSON.stringify(bad)}`);
    }
  });

  it('valide les seuils : prealarme avant alarme, dans le sens du depassement', () => {
    assert.equal(checkSensorSettings(temperature), null);
    assert.match(checkSensorSettings({ ...temperature, warnAt: 40 })!, /inferieur/);
    assert.match(checkSensorSettings({ category: 'environment', warnAt: 0, alarmAt: 4, direction: 'below' })!, /superieur/);
    assert.match(checkSensorSettings({ ...temperature, alarmAt: null })!, /exige un seuil d'alarme/);
    assert.match(checkSensorSettings({ ...temperature, category: 'gaz' as never })!, /categorie/);
  });
});

describe('moteur : autres sources dans le meme circuit d incidents', () => {
  it("un evenement d'acces ouvre un incident critique rattache a sa categorie et a sa camera", () => {
    const t = setup();
    assert.deepEqual(t.engine.ingest('A-01', { event: 'door_forced' }), { ok: true });
    const incident = t.engine.getSnapshot().incidents.find((i) => i.detectorId === 'A-01')!;
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.category, 'access');
    assert.deepEqual(incident.cameraIds, ['C-04']);
    assert.equal(incident.status, 'open');
  });

  it("porte restee ouverte = avertissement, qui devient critique si la porte est forcee ; refermee = normal", () => {
    const t = setup();
    t.engine.ingest('A-01', { event: 'door_held_open' });
    assert.equal(t.engine.getSnapshot().incidents[0].severity, 'warning');
    t.engine.ingest('A-01', { event: 'door_forced' });
    assert.equal(t.engine.getSnapshot().incidents[0].severity, 'critical');
    t.engine.ingest('A-01', { event: 'door_closed' });
    assert.equal(t.status('A-01'), 'normal');
    assert.equal(t.engine.getSnapshot().incidents.length, 1, "l'incident reste ouvert jusqu'a sa qualification");
  });

  it("une mesure franchit les seuils : prealarme puis alarme, la valeur est conservee et exposee", () => {
    const t = setup();
    t.engine.ingest('E-01', { value: 24.5 });
    assert.equal(t.status('E-01'), 'normal');
    assert.equal(t.engine.getDevice('E-01')?.lastValue, 24.5);
    t.engine.ingest('E-01', { value: 33 });
    assert.equal(t.status('E-01'), 'prealarm');
    t.engine.ingest('E-01', { value: 41.2 });
    assert.equal(t.status('E-01'), 'alarm');
    const incident = t.engine.getSnapshot().incidents.find((i) => i.detectorId === 'E-01')!;
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.lastValue, 41.2);
    assert.equal(incident.valueUnit, '°C');
    t.engine.ingest('E-01', { value: 22 });
    assert.equal(t.status('E-01'), 'normal');
  });

  it("une mesure sans seuil configure est affichee mais ne declenche rien", () => {
    const t = setup();
    t.engine.ingest('E-02', { value: 12 });
    assert.equal(t.engine.getDevice('E-02')?.lastValue, 12);
    assert.equal(t.status('E-02'), 'normal');
    assert.equal(t.engine.getSnapshot().incidents.length, 0);
  });

  it("refus clair des messages invalides, et d'un equipement inconnu ou qui n'est pas un detecteur", () => {
    const t = setup();
    assert.deepEqual(t.engine.ingest('A-01', { event: 'n-importe-quoi' }), { ok: false, status: 400, error: 'event inconnu' });
    assert.equal((t.engine.ingest('NOPE', { state: 'alarm' }) as { status: number }).status, 404);
    assert.equal((t.engine.ingest('C-01', { state: 'alarm' }) as { status: number }).status, 404, 'une camera ne declenche pas');
    t.engine.handleDetectorMessage('A-01', { event: '__proto__' }); // ne leve jamais
    assert.equal(t.engine.getSnapshot().incidents.length, 0);
  });

  it("un signe de vie ne cree rien, mais remet en ligne un equipement qu'on croyait muet", () => {
    const t = setup({ silentTimeoutMs: 60 * SECOND });
    t.advance(61);
    assert.ok(t.engine.checkSilentDetectors().includes('E-01'));
    assert.equal(t.status('E-01'), 'offline');
    t.engine.ingest('E-01', { event: 'heartbeat' });
    assert.equal(t.status('E-01'), 'normal');
    assert.equal(t.engine.getSnapshot().incidents.length, 0);
  });
});

describe('supervision par equipement', () => {
  it("les capteurs a changement d'etat (porte, mouvement) ne sont pas declares muets par defaut", () => {
    const t = setup({ silentTimeoutMs: 60 * SECOND });
    t.advance(3600);
    const silent = t.engine.checkSilentDetectors();
    assert.ok(!silent.includes('A-01') && !silent.includes('I-01') && !silent.includes('E-02'));
    assert.equal(t.status('A-01'), 'normal');
    assert.ok(silent.includes('D-01') && silent.includes('E-01'), 'les detecteurs qui emettent en continu le sont toujours');
  });

  it("un delai propre a l'equipement prime sur le delai general, et peut etre rendu au delai general", () => {
    const t = setup({ silentTimeoutMs: 600 * SECOND });
    t.engine.updateDevice('admin', 'A-01', { heartbeatS: 120 });
    t.advance(121);
    assert.deepEqual(t.engine.checkSilentDetectors(), ['A-01'], 'seul A-01 depasse son delai de 120 s');
    t.engine.updateDevice('admin', 'D-01', { heartbeatS: 0 });
    t.advance(10_000);
    assert.ok(!t.engine.checkSilentDetectors().includes('D-01'), '0 = non supervise');
    t.engine.updateDevice('admin', 'D-01', { heartbeatS: null });
    assert.ok(t.engine.checkSilentDetectors().includes('D-01'), 'null = delai general');
  });
});

describe('confirmation par coincidence : meme categorie seulement', () => {
  const rules = { confirmWindowMs: 60 * SECOND };

  it("un detecteur de fumee et un contact de porte dans la meme zone ne se corroborent PAS", () => {
    const t = setup(rules);
    t.db.prepare("UPDATE device SET zone = 'Entrepot' WHERE id = 'A-01'").run();
    t.engine.ingest('D-05', { state: 'prealarm' }); // entrepot, incendie
    t.engine.ingest('A-01', { event: 'door_forced' }); // entrepot, acces
    for (const i of t.engine.getSnapshot().incidents) assert.equal(i.confirmedAt, null, `${i.detectorId} reste « a confirmer »`);
  });

  it("deux detecteurs de mouvement voisins se confirment l'un l'autre", () => {
    const t = setup(rules);
    t.engine.createDevice('admin', { id: 'I-02', kind: 'detector', category: 'intrusion', name: 'Mouvement hall', zone: 'Accueil' });
    t.engine.ingest('I-01', { event: 'motion' });
    t.engine.ingest('I-02', { event: 'motion' });
    const incidents = t.engine.getSnapshot().incidents;
    assert.equal(incidents.length, 2);
    for (const i of incidents) assert.ok(i.confirmedAt !== null && i.confirmationReason?.startsWith('neighbor:'));
  });
});

describe('inventaire : categorie, seuils, unite', () => {
  it("cree un detecteur d'une autre categorie : non supervise par defaut, incendie = delai general", () => {
    const t = setup();
    const door = t.engine.createDevice('admin', { id: 'A-09', kind: 'detector', category: 'access', name: 'Porte quai', zone: 'Atelier' });
    assert.equal(door.category, 'access');
    assert.equal(door.heartbeatS, 0);
    const smoke = t.engine.createDevice('admin', { id: 'D-09', kind: 'detector', name: 'Fumee', zone: 'Atelier' });
    assert.equal(smoke.category, 'fire');
    assert.equal(smoke.heartbeatS, null);
    const temp = t.engine.createDevice('admin', { id: 'E-09', kind: 'detector', category: 'environment', name: 'Frigo', unit: 'x', valueUnit: '°C', direction: 'above', warnAt: 6, alarmAt: 8 });
    assert.deepEqual([temp.valueUnit, temp.warnAt, temp.alarmAt], ['°C', 6, 8]);
  });

  it('refuse les reglages incoherents (HTTP 400) : categorie, seuils, unite, delai', () => {
    const t = setup();
    const bad = (input: Record<string, unknown>, pattern: RegExp) =>
      assert.throws(() => t.engine.updateDevice('admin', 'E-01', input), (e: unknown) => e instanceof PsimError && e.status === 400 && pattern.test(e.message));
    bad({ category: 'gaz' }, /categorie/);
    bad({ warnAt: 50 }, /inferieur/);
    bad({ alarmAt: 'chaud' }, /nombre/);
    bad({ alarmAt: null }, /exige un seuil d'alarme/); // E-01 garde sa prealarme (30) sans alarme
    bad({ valueUnit: 'x'.repeat(40) }, /unite/);
    bad({ heartbeatS: -5 }, /supervision/);
    bad({ heartbeatS: 1.5 }, /supervision/);
    assert.equal(t.engine.getDevice('E-01')?.alarmAt, 38, 'rien n\'a ete modifie');
  });

  it("les reglages de capteur ne s'appliquent pas aux cameras", () => {
    const t = setup();
    assert.throws(() => t.engine.updateDevice('admin', 'C-01', { category: 'intrusion' }), (e: unknown) => e instanceof PsimError && e.status === 400);
    assert.equal(t.engine.createDevice('admin', { id: 'C-09', kind: 'camera', name: 'Cam', category: 'access' }).category, 'fire', 'ignore pour une camera');
  });

  it("changer la categorie d'un detecteur en incident est refuse (409)", () => {
    const t = setup();
    t.engine.ingest('A-01', { event: 'door_forced' });
    assert.throws(() => t.engine.updateDevice('admin', 'A-01', { category: 'intrusion' }), (e: unknown) => e instanceof PsimError && e.status === 409);
    assert.equal(t.engine.getDevice('A-01')?.category, 'access');
  });

  it('une base existante est migree : les detecteurs deviennent « incendie » sans rien perdre', () => {
    const db = openDb(':memory:');
    db.exec("INSERT INTO device (id, kind, name) VALUES ('X-1', 'detector', 'Ancien')");
    const row = db.prepare("SELECT category, direction, heartbeat_s FROM device WHERE id = 'X-1'").get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { category: 'fire', direction: 'above', heartbeat_s: null });
  });
});

describe("l'indice de risque incendie ne compte que l'incendie", () => {
  it("un incident d'intrusion qualifie « reel » n'augmente pas le nombre d'incendies de la zone", () => {
    const db = openDb(':memory:');
    seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
    const engine = createEngine(db, () => {}, () => T0);
    const risk = createRiskService(db, engine, { now: () => T0 });
    const before = risk.overview().zones.find((z) => z.zone === 'Accueil')!.facts;
    engine.ingest('I-01', { event: 'motion' });
    engine.ingest('I-01', { event: 'clear' });
    const id = engine.getSnapshot().incidents[0].id;
    engine.close(id, 'operateur', 'fire', 'intrusion averee');
    const after = risk.overview().zones.find((z) => z.zone === 'Accueil')!.facts;
    assert.equal(after.fires, before.fires);
    assert.equal(after.detectors, before.detectors, "le detecteur de mouvement n'est pas un detecteur d'incendie");
  });
});

describe('evenements de presence et de visage (regles de presence)', () => {
  const NEW_EVENTS = [
    ['person_detected', 'alarm', 'Présence détectée'],
    ['person_lingering', 'alarm', 'Présence prolongée'],
    ['person_noticed', 'prealarm', 'Présence signalée'],
    ['face_banned', 'alarm', 'Personne interdite reconnue'],
    ['face_unknown', 'alarm', 'Visage inconnu en zone réservée'],
    ['face_noticed', 'prealarm', 'Visage signalé'],
  ] as const;

  it('chacun est reconnu, avec son effet et son motif en clair', () => {
    for (const [event, effect, label] of NEW_EVENTS) {
      assert.equal(EVENTS[event], effect, event);
      assert.equal(EVENT_LABEL[event], label, event);
      assert.equal(eventLabel(event), label);
      assert.deepEqual(interpret(fire, { event }), { ok: true, state: effect, event, alive: false, value: null, detail: null });
    }
  });

  it("ouvre un incident (critique pour une alarme, avertissement pour une prealarme) qui garde son motif", () => {
    const { engine } = setup();
    for (const [event, effect] of NEW_EVENTS) {
      const id = `R-${event}`.slice(0, 32);
      engine.createDevice('admin', { id, kind: 'detector', name: event, zone: 'Accueil', category: 'access', heartbeatS: 0 });
      engine.handleDetectorMessage(id, { event });
      const incident = engine.getSnapshot().incidents.find((i) => i.detectorId === id);
      assert.ok(incident, `incident pour ${event}`);
      assert.equal(incident.severity, effect === 'alarm' ? 'critical' : 'warning', event);
      assert.equal(incident.event, event);
      assert.equal(engine.getDevice(id)?.status, effect, event);
    }
  });
});

describe("evenements de l'armement des portes (F14) et des regles d'acces (F15)", () => {
  const ACCESS_EVENTS = [
    ['door_opened_armed', 'prealarm', "Ouverture pendant l'armement"],
    ['badge_offhours', 'alarm', 'Badge utilisé hors de ses horaires'],
    ['badge_offhours_noticed', 'prealarm', 'Badge hors horaires signalé'],
    ['badge_watched', 'alarm', 'Badge surveillé utilisé'],
    ['badge_watched_noticed', 'prealarm', 'Badge surveillé signalé'],
    ['denials_spread', 'alarm', 'Refus sur plusieurs portes'],
    ['denials_spread_noticed', 'prealarm', 'Refus sur plusieurs portes signalés'],
  ] as const;
  const access: SensorSettings = { category: 'access', warnAt: null, alarmAt: null, direction: 'above' };

  it('chacun est reconnu avec son effet et son libelle (accents compris)', () => {
    for (const [event, effect, label] of ACCESS_EVENTS) {
      assert.equal(EVENTS[event], effect, event);
      assert.equal(EVENT_LABEL[event], label, event);
      assert.equal(eventLabel(event), label);
      assert.deepEqual(interpret(access, { event }), { ok: true, state: effect, event, alive: false, value: null, detail: null }, event);
    }
  });

  it("aucun n'est « toujours actif » : l'armement ne les concerne pas, et la categorie acces n'est de toute facon jamais masquee", () => {
    for (const [event] of ACCESS_EVENTS) assert.ok(!ALWAYS_ACTIVE_EVENTS.has(event), event);
    // Zone desarmee : un detecteur de categorie acces ouvre quand meme son incident (seule la categorie intrusion est masquee).
    const { engine, db } = setup({ isArmed: () => false });
    db.prepare("UPDATE device SET zone = 'Accueil' WHERE id = 'A-01'").run();
    for (const [event, effect] of ACCESS_EVENTS) {
      engine.handleDetectorMessage('A-01', { event });
      assert.equal(engine.getDevice('A-01')?.status, effect, event);
      engine.handleDetectorMessage('A-01', { event: 'normal' });
    }
  });

  it("door_opened_armed porte le texte de l'incident (detail) jusqu'au motif affiche", () => {
    const { engine } = setup();
    engine.handleDetectorMessage('A-01', { event: 'door_opened_armed', detail: "Ouverture de la porte « Entrée » à 22:14 pendant l'armement de la zone « Bureaux » : aucun titulaire connu" });
    const incident = engine.getSnapshot().incidents.find((i) => i.detectorId === 'A-01')!;
    assert.equal(incident.severity, 'warning');
    assert.equal(incident.event, 'door_opened_armed');
    assert.match(incident.detail ?? '', /Entrée.*22:14.*Bureaux/);
  });
});
