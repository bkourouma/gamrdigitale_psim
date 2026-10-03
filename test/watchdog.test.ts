import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { seedDemo } from '../server/seed.ts';
import type { PsimEvent } from '../server/types.ts';

const T0 = 1_000_000_000_000;
const SECOND = 1000;

/** Moteur avec une horloge manuelle : on avance le temps exactement comme on veut. */
function setup(silentTimeoutMs: number) {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  const events: PsimEvent[] = [];
  let clock = T0;
  const engine = createEngine(db, (e) => events.push(e), () => clock, { silentTimeoutMs });
  return {
    engine,
    events,
    advance: (seconds: number) => void (clock += seconds * SECOND),
    status: (id: string) => engine.getDevice(id)?.status,
    silentEntries: () => engine.listAudit(100).filter((a) => a.action === 'detector_silent'),
  };
}

describe('detecteur muet', () => {
  it('declare hors ligne un detecteur qui ne donne plus signe de vie, avec une trace dans le journal', () => {
    const t = setup(60 * SECOND);
    t.engine.handleDetectorMessage('D-01', { state: 'normal' });
    t.advance(59);
    assert.deepEqual(t.engine.checkSilentDetectors(), [], 'pas encore : le delai n\'est pas ecoule');
    assert.equal(t.status('D-01'), 'normal');

    t.advance(2);
    const silent = t.engine.checkSilentDetectors();
    assert.ok(silent.includes('D-01'));
    assert.equal(t.status('D-01'), 'offline');
    const [entry] = t.silentEntries().filter((e) => e.deviceId === 'D-01');
    assert.match(entry.details ?? '', /aucun message depuis 61 s/);
    assert.equal(entry.actor, 'systeme');
    assert.ok(t.events.some((e) => e.type === 'device' && e.device.id === 'D-01' && e.device.status === 'offline'), 'les ecrans sont prevenus');
  });

  it("un detecteur qui continue d'emettre n'est jamais declare muet", () => {
    const t = setup(60 * SECOND);
    for (let i = 0; i < 20; i++) {
      t.engine.handleDetectorMessage('D-02', { state: 'normal' });
      t.advance(30);
      t.engine.checkSilentDetectors();
    }
    assert.equal(t.status('D-02'), 'normal');
    assert.equal(t.silentEntries().filter((e) => e.deviceId === 'D-02').length, 0);
  });

  it("laisse le meme delai de grace, depuis le demarrage, a un detecteur jamais entendu", () => {
    const t = setup(60 * SECOND);
    t.advance(30);
    assert.deepEqual(t.engine.checkSilentDetectors(), []);
    t.advance(31);
    // 7 detecteurs incendie + le capteur de temperature (qui mesure en continu) ; les contacts et detecteurs de mouvement ne sont pas supervises
    assert.equal(t.engine.checkSilentDetectors().length, 8, 'les detecteurs supervises, muets depuis le demarrage');
    assert.equal(t.status('I-01'), 'normal');
    assert.equal(t.status('A-01'), 'normal');
    assert.equal(t.status('D-05'), 'offline');
  });

  it("ne declasse JAMAIS un detecteur en prealarme ou en alarme, meme muet : le silence ne doit pas masquer un feu", () => {
    const t = setup(60 * SECOND);
    t.engine.handleDetectorMessage('D-03', { state: 'alarm' });
    t.engine.handleDetectorMessage('D-06', { state: 'prealarm' });
    t.advance(600);
    const silent = t.engine.checkSilentDetectors();
    assert.ok(!silent.includes('D-03') && !silent.includes('D-06'));
    assert.equal(t.status('D-03'), 'alarm');
    assert.equal(t.status('D-06'), 'prealarm');
    assert.equal(t.engine.getSnapshot().incidents.filter((i) => i.status !== 'closed').length, 2, 'les incidents restent ouverts');
  });

  it('un detecteur en defaut qui se tait passe aussi hors ligne', () => {
    const t = setup(60 * SECOND);
    t.engine.handleDetectorMessage('D-04', { state: 'fault' });
    t.advance(120);
    t.engine.checkSilentDetectors();
    assert.equal(t.status('D-04'), 'offline');
    assert.match(t.silentEntries().find((e) => e.deviceId === 'D-04')?.details ?? '', /etait : fault/);
  });

  it('reprend son etat normal des qu\'il emet a nouveau, et le journal garde les deux evenements', () => {
    const t = setup(60 * SECOND);
    t.engine.handleDetectorMessage('D-01', { state: 'normal' });
    t.advance(120);
    t.engine.checkSilentDetectors();
    assert.equal(t.status('D-01'), 'offline');

    t.engine.handleDetectorMessage('D-01', { state: 'normal' });
    assert.equal(t.status('D-01'), 'normal');
    const actions = t.engine.listAudit(100).filter((a) => a.deviceId === 'D-01').map((a) => a.action);
    assert.ok(actions.includes('detector_silent') && actions.includes('device_state'));
    t.advance(30);
    t.engine.checkSilentDetectors();
    assert.equal(t.status('D-01'), 'normal', 'le delai repart de zero apres le retour');
  });

  it("un detecteur muet qui reprend avec une alarme ouvre bien un incident", () => {
    const t = setup(60 * SECOND);
    t.advance(120);
    t.engine.checkSilentDetectors();
    assert.equal(t.status('D-02'), 'offline');
    t.engine.handleDetectorMessage('D-02', { state: 'alarm' });
    assert.equal(t.engine.getSnapshot().incidents[0]?.detectorId, 'D-02');
  });

  it("n'ajoute pas d'entree au journal a chaque controle", () => {
    const t = setup(60 * SECOND);
    t.advance(120);
    t.engine.checkSilentDetectors();
    const count = t.silentEntries().length;
    for (let i = 0; i < 5; i++) {
      t.advance(10);
      assert.deepEqual(t.engine.checkSilentDetectors(), []);
    }
    assert.equal(t.silentEntries().length, count);
  });

  it("n'ecrase pas un detecteur qui s'est lui-meme annonce hors ligne", () => {
    const t = setup(60 * SECOND);
    t.engine.handleDetectorMessage('D-07', { state: 'offline' });
    t.advance(300);
    const silent = t.engine.checkSilentDetectors();
    assert.ok(!silent.includes('D-07'));
    assert.equal(t.silentEntries().filter((e) => e.deviceId === 'D-07').length, 0);
  });

  it('ne touche pas aux cameras', () => {
    const t = setup(60 * SECOND);
    t.advance(600);
    t.engine.checkSilentDetectors();
    assert.equal(t.status('C-01'), 'normal');
  });

  it('est desactivee quand le delai vaut 0', () => {
    const t = setup(0);
    t.advance(100_000);
    assert.deepEqual(t.engine.checkSilentDetectors(), []);
    assert.equal(t.status('D-01'), 'normal');
  });
});
