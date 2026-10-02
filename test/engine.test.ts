import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import type { Engine } from '../server/engine.ts';
import { seedDemo } from '../server/seed.ts';
import type { PsimEvent } from '../server/types.ts';

let engine: Engine;
let events: PsimEvent[];
let clock: number;

beforeEach(() => {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  events = [];
  clock = 1_000_000;
  engine = createEngine(db, (e) => events.push(e), () => (clock += 1000));
});

const incidentsOf = () => engine.getSnapshot().incidents;

describe('corrélation alarme -> incident', () => {
  it("une alarme ouvre un incident critique avec les caméras liées au détecteur", () => {
    engine.handleDetectorMessage('D-01', { state: 'alarm' });
    const [incident] = incidentsOf();
    assert.equal(incident.detectorId, 'D-01');
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.status, 'open');
    assert.deepEqual(incident.cameraIds, ['C-01', 'C-02']);
    assert.ok(events.some((e) => e.type === 'incident'));
  });

  it("une préalarme ouvre un incident d'avertissement", () => {
    engine.handleDetectorMessage('D-02', { state: 'prealarm' });
    assert.equal(incidentsOf()[0].severity, 'warning');
  });

  it("une alarme répétée ne crée pas un second incident", () => {
    engine.handleDetectorMessage('D-01', { state: 'alarm' });
    engine.handleDetectorMessage('D-01', { state: 'alarm' });
    engine.handleDetectorMessage('D-01', { state: 'alarm' });
    assert.equal(incidentsOf().length, 1);
  });

  it("la préalarme suivie d'une alarme escalade l'incident et le remet à non acquitté", () => {
    engine.handleDetectorMessage('D-03', { state: 'prealarm' });
    const id = incidentsOf()[0].id;
    engine.acknowledge(id, 'operateur');
    engine.handleDetectorMessage('D-03', { state: 'alarm' });
    const [incident] = incidentsOf();
    assert.equal(incidentsOf().length, 1);
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.status, 'open');
    assert.equal(incident.ackedBy, null);
  });

  it("défaut et hors ligne changent le statut sans ouvrir d'incident", () => {
    engine.handleDetectorMessage('D-04', { state: 'fault' });
    engine.handleDetectorMessage('D-05', { state: 'offline' });
    assert.equal(incidentsOf().length, 0);
    assert.equal(engine.getDevice('D-04')?.status, 'fault');
    assert.equal(engine.getDevice('D-05')?.status, 'offline');
  });

  it('ignore les messages invalides ou venant d\'équipements inconnus', () => {
    engine.handleDetectorMessage('D-01', { state: 'explosion' });
    engine.handleDetectorMessage('D-01', 'alarm');
    engine.handleDetectorMessage('D-01', null);
    engine.handleDetectorMessage('INCONNU', { state: 'alarm' });
    engine.handleDetectorMessage('C-01', { state: 'alarm' }); // une caméra n'est pas un détecteur
    assert.equal(incidentsOf().length, 0);
    assert.equal(engine.getDevice('D-01')?.status, 'normal');
    assert.equal(engine.getDevice('C-01')?.status, 'normal');
  });
});

describe('traitement de l\'incident', () => {
  it('acquitter puis clôturer avec qualification écrit le journal', () => {
    engine.handleDetectorMessage('D-06', { state: 'alarm' });
    const id = incidentsOf()[0].id;
    engine.acknowledge(id, 'operateur');
    engine.handleDetectorMessage('D-06', { state: 'normal' });
    const closed = engine.close(id, 'operateur', 'false_alarm', 'Fumée de soudure');
    assert.equal(closed.status, 'closed');
    assert.equal(closed.qualification, 'false_alarm');
    assert.equal(closed.comment, 'Fumée de soudure');
    const actions = engine.listAudit(50).map((a) => a.action);
    for (const a of ['incident_opened', 'incident_acked', 'incident_closed', 'device_state']) {
      assert.ok(actions.includes(a), `journal sans ${a}`);
    }
  });

  it("refuse de clôturer tant que le détecteur est en alarme", () => {
    engine.handleDetectorMessage('D-06', { state: 'alarm' });
    const id = incidentsOf()[0].id;
    assert.throws(() => engine.close(id, 'operateur', 'fire', ''), (e) => e instanceof PsimError && e.status === 409);
  });

  it('refuse une qualification absente ou inconnue', () => {
    engine.handleDetectorMessage('D-07', { state: 'alarm' });
    engine.handleDetectorMessage('D-07', { state: 'normal' });
    const id = incidentsOf()[0].id;
    assert.throws(() => engine.close(id, 'operateur', undefined, ''), (e) => e instanceof PsimError && e.status === 400);
    assert.throws(() => engine.close(id, 'operateur', 'peut-etre', ''), (e) => e instanceof PsimError && e.status === 400);
  });

  it('ne permet ni de double acquittement ni de double clôture', () => {
    engine.handleDetectorMessage('D-07', { state: 'alarm' });
    const id = incidentsOf()[0].id;
    engine.acknowledge(id, 'operateur');
    assert.throws(() => engine.acknowledge(id, 'operateur'), (e) => e instanceof PsimError && e.status === 409);
    engine.handleDetectorMessage('D-07', { state: 'normal' });
    engine.close(id, 'operateur', 'fire', '');
    assert.throws(() => engine.close(id, 'operateur', 'fire', ''), (e) => e instanceof PsimError && e.status === 409);
  });

  it("une nouvelle alarme après clôture ouvre un nouvel incident", () => {
    engine.handleDetectorMessage('D-01', { state: 'alarm' });
    engine.handleDetectorMessage('D-01', { state: 'normal' });
    engine.close(incidentsOf()[0].id, 'operateur', 'false_alarm', '');
    engine.handleDetectorMessage('D-01', { state: 'alarm' });
    assert.equal(incidentsOf().filter((i) => i.status !== 'closed').length, 1);
    assert.equal(incidentsOf().length, 2);
  });
});

describe('inventaire', () => {
  it("valide l'identifiant, le type et la position", () => {
    const bad = (input: Record<string, unknown>, status: number) =>
      assert.throws(() => engine.createDevice('admin', input), (e) => e instanceof PsimError && e.status === status);
    bad({ id: 'a/b', kind: 'detector', name: 'x' }, 400);
    bad({ id: 'Z-1', kind: 'radar', name: 'x' }, 400);
    bad({ id: 'Z-1', kind: 'detector', name: '' }, 400);
    bad({ id: 'Z-1', kind: 'detector', name: 'x', x: 140 }, 400);
    bad({ id: 'D-01', kind: 'detector', name: 'doublon' }, 409);
    const created = engine.createDevice('admin', { id: 'Z-1', kind: 'camera', name: 'Nouvelle', x: 10, y: 20 });
    assert.equal(created.streamKind, 'simulated');
  });

  it('les liens détecteur -> caméras sont remplacés atomiquement et validés', () => {
    assert.deepEqual(engine.setLinks('admin', 'D-01', ['C-05', 'C-05']), ['C-05']);
    assert.throws(() => engine.setLinks('admin', 'D-01', ['D-02']), (e) => e instanceof PsimError && e.status === 400);
    assert.deepEqual(engine.getSnapshot().links['D-01'], ['C-05']);
  });

  it("ne supprime pas un détecteur qui a un historique d'incidents", () => {
    engine.handleDetectorMessage('D-01', { state: 'alarm' });
    assert.throws(() => engine.deleteDevice('admin', 'D-01'), (e) => e instanceof PsimError && e.status === 409);
    engine.deleteDevice('admin', 'D-02');
    assert.equal(engine.getDevice('D-02'), null);
  });
});
