/**
 * Integration de l'etape 2 : les points ou les quatre lots se croisent.
 *  - 2.1 x 2.2 : le motif d'evenement (gaz, sos...) suit aussi les alarmes recues en differe (ts) et rejouees ;
 *  - 2.2 x 2.3 : un equipement reseau (network_target) n'est ni juge muet ni rendu « non surveille » par une passerelle ;
 *  - 2.1 x 2.3 : un equipement reseau reste de categorie « Environnement » (energie et personnes n'y changent rien) ;
 *  - 2.2 x 2.4 : une image d'equipement en attente, rattachee a une alarme recue en differe, le dit dans sa note.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createDeviceImages } from '../server/deviceimages.ts';
import { createDeviceKeys } from '../server/devicekeys.ts';
import { createEngine } from '../server/engine.ts';
import type { EngineOptions } from '../server/engine.ts';
import { createGatewayLink } from '../server/gatewaylink.ts';
import type { GatewayLink } from '../server/gatewaylink.ts';
import { beginHistory } from '../server/history.ts';
import { createNetworkTargets } from '../server/networkhealth.ts';
import { seedDemo } from '../server/seed.ts';
import type { Incident } from '../server/types.ts';

const T = Date.UTC(2026, 9, 10, 8, 0, 0);
const MIN = 60_000;
const SEED = join(import.meta.dirname, '..', 'seed');

function setup(options: EngineOptions = {}) {
  const db = openDb(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'psim-integ-'));
  seedDemo(db, dataDir, SEED);
  let clock = T;
  const hooks: { incident: Incident; kind: string }[] = [];
  let onOpened: ((incident: Incident) => void) | undefined;
  const engine = createEngine(db, () => {}, () => clock, {
    confirmWindowMs: 0,
    onIncidentEvent: (incident, kind) => {
      hooks.push({ incident, kind });
      if (kind === 'opened') onOpened?.(incident);
    },
    ...options,
  });
  beginHistory(db, clock, null, null);
  const incidents = (id: string) => engine.getSnapshot().incidents.filter((i) => i.detectorId === id);
  const row = (id: string) => db.prepare('SELECT * FROM device WHERE id = ?').get(id) as Record<string, unknown>;
  return {
    db,
    dataDir,
    engine,
    hooks,
    incidents,
    row,
    now: () => clock,
    advance: (ms: number) => void (clock += ms),
    setOnOpened: (fn: (incident: Incident) => void) => void (onOpened = fn),
  };
}

describe('2.1 x 2.2 : motif d evenement des alarmes datees et rejouees', () => {
  it("alarme recue en differe, plus recente que l'etat connu : incident a son heure reelle, avec son motif", () => {
    const t = setup();
    assert.deepEqual(t.engine.ingest('D-01', { event: 'gas', ts: T - 10 * MIN, msgId: 'm1' }), { ok: true });
    const [incident] = t.incidents('D-01');
    assert.equal(incident.event, 'gas');
    assert.equal(incident.openedAt, T - 10 * MIN);
    assert.equal(incident.receivedLateMs, 10 * MIN);
    // Renvoi du meme message : sans effet, le motif ne bouge pas.
    assert.deepEqual(t.engine.ingest('D-01', { event: 'co', ts: T - 10 * MIN, msgId: 'm1' }), { ok: true, duplicate: true });
    assert.equal(t.incidents('D-01')[0].event, 'gas');
  });

  it("alarme anterieure a l'etat connu (recordPastAlarm) : l'incident ouvert a sa date reelle porte le motif", () => {
    const t = setup();
    t.engine.ingest('D-02', { state: 'normal', ts: T - MIN });
    t.engine.ingest('D-02', { event: 'co', ts: T - 10 * MIN });
    assert.equal(t.row('D-02').status, 'normal', "l'etat actuel n'est pas modifie");
    const [incident] = t.incidents('D-02');
    assert.equal(incident.event, 'co');
    assert.equal(incident.openedAt, T - 10 * MIN);
    assert.deepEqual(t.hooks.map((h) => [h.kind, h.incident.event]), [['opened', 'co']], 'la notification part avec le motif');
  });

  it("alarme anterieure qui aggrave l'incident en cours : le motif devient celui de l'alarme", () => {
    const t = setup();
    t.engine.ingest('A-01', { event: 'door_held_open', ts: T - 2 * MIN });
    assert.equal(t.incidents('A-01')[0].event, 'door_held_open');
    t.engine.ingest('A-01', { event: 'door_closed', ts: T - MIN });
    t.engine.ingest('A-01', { event: 'door_forced', ts: T - 5 * MIN });
    const list = t.incidents('A-01');
    assert.equal(list.length, 1);
    assert.equal(list[0].severity, 'critical');
    assert.equal(list[0].event, 'door_forced');
    assert.deepEqual(t.hooks.map((h) => [h.kind, h.incident.event]), [['opened', 'door_held_open'], ['escalated', 'door_forced']]);
  });

  it('etat sans evenement rejoue sur un incident : le motif d origine est garde', () => {
    const t = setup();
    t.engine.ingest('D-03', { event: 'over_temperature', ts: T - 2 * MIN });
    t.engine.ingest('D-03', { state: 'alarm', ts: T - MIN });
    assert.equal(t.incidents('D-03')[0].event, 'over_temperature');
  });
});

describe('2.2 x 2.3 : equipements reseau, passerelles et detecteurs muets', () => {
  function withNetwork() {
    let link: GatewayLink | undefined;
    const t = setup({ silentTimeoutMs: MIN, silenceReference: (id) => link?.silenceReference(id) ?? null });
    const targets = createNetworkTargets({ db: t.db, now: t.now, probe: async () => true, audit: (actor, action, ref) => t.engine.audit(actor, action, ref) });
    // Une passerelle dont la liste couvre TOUT (motif « * ») : le cas le plus large.
    link = createGatewayLink({
      db: t.db,
      gateways: [{ user: 'gw1', detectors: ['*'] }],
      timeoutMs: 2 * MIN,
      graceMs: MIN,
      now: t.now,
      audit: (action, ref) => t.engine.audit('systeme', action, ref),
      publishDevice: () => {},
    });
    t.engine.createDevice('admin', { id: 'N-1', kind: 'detector', name: 'Routeur 4G', zone: 'Local technique', category: 'environment' });
    targets.set('admin', 'N-1', { host: '10.0.0.1', port: 443 });
    const history = (id: string) => t.db.prepare('SELECT state FROM device_state_history WHERE device_id = ? ORDER BY id').all(id) as { state: string }[];
    return { ...t, link, targets, history };
  }

  it("passerelle coupee : ses capteurs sont non surveilles, l'equipement reseau n'est pas touche", () => {
    const t = withNetwork();
    const before = { status: t.row('N-1').status, history: t.history('N-1') };
    assert.equal(t.row('N-1').heartbeat_s, 0);
    assert.equal(t.link.silenceReference('N-1'), null, "le silence d'un equipement reseau ne depend d'aucune passerelle");
    t.advance(3 * MIN);
    t.link.tick();
    assert.equal(t.row('D-01').status, 'offline', 'un capteur de la passerelle est bien non surveille');
    assert.notEqual(t.row('D-01').link_lost_at, null);
    assert.equal(t.row('N-1').link_lost_at, null);
    assert.equal(t.row('N-1').status, before.status);
    assert.deepEqual(t.history('N-1'), before.history, "l'historique mesure par le test reseau n'est pas reecrit");
    const lost = t.db.prepare('SELECT COUNT(*) AS n FROM device WHERE link_lost_at IS NOT NULL').get() as { n: number };
    assert.equal(t.link.status()[0].unmonitored, lost.n);
  });

  it('jamais declare muet : delai « aucun message » a 0, et toute modification qui le reactiverait est refusee', () => {
    const t = withNetwork();
    t.advance(30 * MIN);
    assert.ok(!t.engine.checkSilentDetectors().includes('N-1'));
    assert.equal(t.engine.listAudit(200).filter((e) => e.action === 'detector_silent' && e.deviceId === 'N-1').length, 0);
    assert.throws(() => t.engine.updateDevice('admin', 'N-1', { heartbeatS: null }), /supervise par le reseau/);
    assert.throws(() => t.engine.updateDevice('admin', 'N-1', { heartbeatS: 300 }), /supervise par le reseau/);
    assert.equal(t.row('N-1').heartbeat_s, 0);
    // Une modification ordinaire passe (nom, et le formulaire de mesure qui renvoie 0).
    t.engine.updateDevice('admin', 'N-1', { name: 'Routeur 4G principal', heartbeatS: 0 });
    assert.equal(t.row('N-1').name, 'Routeur 4G principal');
  });

  it('un capteur deja « non surveille » par sa passerelle, devenu equipement reseau, reprend son etat', () => {
    const t = withNetwork();
    t.engine.createDevice('admin', { id: 'N-2', kind: 'detector', name: 'Switch PoE', zone: 'Local technique', category: 'environment' });
    t.advance(3 * MIN);
    t.link.tick();
    assert.notEqual(t.row('N-2').link_lost_at, null);
    t.targets.set('admin', 'N-2', { host: '10.0.0.2', port: 80 });
    assert.equal(t.row('N-2').link_lost_at, null);
    assert.equal(t.row('N-2').status, 'normal');
  });
});

describe('2.1 x 2.3 : un equipement reseau reste de categorie « Environnement »', () => {
  it('energie, personnes ou incendie : refuses tant que la supervision reseau est en place ; permis apres son retrait', () => {
    const t = setup();
    const targets = createNetworkTargets({ db: t.db, now: t.now, probe: async () => true, audit: (actor, action, ref) => t.engine.audit(actor, action, ref) });
    t.engine.createDevice('admin', { id: 'N-1', kind: 'detector', name: 'Onduleur', zone: 'Local technique', category: 'environment' });
    targets.set('admin', 'N-1', { host: '10.0.0.3', port: 443 });
    for (const category of ['energy', 'people', 'fire', 'intrusion', 'access']) {
      assert.throws(() => t.engine.updateDevice('admin', 'N-1', { category }), /Environnement/, category);
    }
    assert.equal(t.row('N-1').category, 'environment');
    // Les nouvelles categories ne peuvent pas recevoir de supervision reseau non plus.
    t.engine.createDevice('admin', { id: 'P-1', kind: 'detector', name: 'Compteur', zone: 'Local technique', category: 'energy' });
    assert.throws(() => targets.set('admin', 'P-1', { host: '10.0.0.4', port: 443 }), /Environnement/);
    // Retrait de la supervision : l'equipement redevient un detecteur ordinaire, sa categorie peut changer.
    targets.remove('admin', 'N-1');
    t.engine.updateDevice('admin', 'N-1', { category: 'energy', heartbeatS: 0 });
    assert.equal(t.row('N-1').category, 'energy');
  });
});

describe('2.2 x 2.4 : images d equipement et alarmes recues en differe', () => {
  it("une image en attente, rattachee a une alarme recue en differe, garde son heure de reception et le dit", () => {
    const t = setup();
    const keys = createDeviceKeys({ db: t.db, audit: (a, b, c) => t.engine.audit(a, b, c), now: t.now });
    const images = createDeviceImages({ db: t.db, engine: t.engine, dataDir: t.dataDir, keys, publishIncident: () => {}, now: t.now });
    t.setOnOpened((incident) => void images.attachPending(incident));
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
      Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]),
      Buffer.alloc(32, 0x55),
      Buffer.from([0xff, 0xd9]),
    ]);
    t.engine.ingest('D-02', { state: 'normal', ts: T - MIN });
    const pending = images.receive('D-02', jpeg, 'jpg', null);
    assert.equal(pending.ok && pending.status, 202, 'aucun incident ouvert : image en attente');
    t.advance(10_000);
    t.engine.ingest('D-02', { event: 'gas', ts: T - 10 * MIN });
    const [incident] = t.incidents('D-02');
    assert.equal(incident.openedAt, T - 10 * MIN);
    const shots = t.db.prepare("SELECT taken_at FROM incident_snapshot WHERE incident_id = ? AND source = 'device'").all(incident.id) as { taken_at: number }[];
    assert.deepEqual(shots.map((s) => s.taken_at), [T], "heure de RECEPTION de l'image, pas celle de l'alarme");
    const sealed = t.engine.listAudit(200).filter((e) => e.incidentId === incident.id && /sha256=/.test(e.details ?? ''));
    assert.equal(sealed.length, 1);
    assert.match(sealed[0].details ?? '', /avant la reception de l'alarme \(recue en differe\)/);
  });
});
