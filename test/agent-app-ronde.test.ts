/**
 * Application des agents, onglet Ronde : calculs purs (ronde en cours, progression, delais, verdicts, anti-rebond).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// @ts-expect-error module JS de l'interface (sans types), importe pour tester ses calculs purs
import { describeVerdict, isUrgent, nextCheckpoint, pickCurrentRun, runProgress, shouldIgnoreRepeat, timeLeftLabel } from '../web/agent/ronde.js';

const MIN = 60000;
const NOW = Date.UTC(2026, 9, 17, 20, 0, 0);

function run(id: number, status: string, dueStart: number, dueEnd: number, done: boolean[] = [false, false]) {
  return {
    id,
    routeId: id,
    name: `Ronde ${id}`,
    status,
    dueStart,
    dueEnd,
    ordered: true,
    checkpoints: done.map((d, i) => ({ id: i + 1, name: `Point ${i + 1}`, zone: 'Z', done: d, doneAt: d ? NOW : null })),
  };
}

describe('pickCurrentRun', () => {
  it('prefere la ronde en cours', () => {
    const runs = [run(1, 'pending', NOW, NOW + 30 * MIN), run(2, 'active', NOW - 10 * MIN, NOW + 20 * MIN)];
    assert.equal(pickCurrentRun(runs, NOW).id, 2);
  });
  it('prend une ronde en attente dont la plage est ouverte (15 min avant le debut)', () => {
    const runs = [run(1, 'pending', NOW + 10 * MIN, NOW + 40 * MIN)];
    assert.equal(pickCurrentRun(runs, NOW).id, 1);
  });
  it('sinon la prochaine a venir, la plus proche d\'abord', () => {
    const runs = [run(2, 'pending', NOW + 120 * MIN, NOW + 150 * MIN), run(1, 'pending', NOW + 60 * MIN, NOW + 90 * MIN)];
    assert.equal(pickCurrentRun(runs, NOW).id, 1);
  });
  it('ignore les rondes terminees ou manquees, et renvoie null sans ronde', () => {
    const runs = [run(1, 'done', NOW - 60 * MIN, NOW - 30 * MIN), run(2, 'missed', NOW - 120 * MIN, NOW - 90 * MIN)];
    assert.equal(pickCurrentRun(runs, NOW), null);
    assert.equal(pickCurrentRun([], NOW), null);
    assert.equal(pickCurrentRun(undefined, NOW), null);
  });
  it('une ronde en attente deja depassee n\'est pas mise en avant', () => {
    assert.equal(pickCurrentRun([run(1, 'pending', NOW - 60 * MIN, NOW - 30 * MIN)], NOW), null);
  });
});

describe('runProgress et nextCheckpoint', () => {
  it('compte les points faits et le pourcentage', () => {
    assert.deepEqual(runProgress(run(1, 'active', NOW, NOW, [true, true, false, false, false, false, false, false])), { done: 2, total: 8, percent: 25 });
    assert.deepEqual(runProgress(run(1, 'active', NOW, NOW, [true, false, false])), { done: 1, total: 3, percent: 33 });
  });
  it('ronde vide ou absente : zero partout', () => {
    assert.deepEqual(runProgress(run(1, 'active', NOW, NOW, [])), { done: 0, total: 0, percent: 0 });
    assert.deepEqual(runProgress(null), { done: 0, total: 0, percent: 0 });
  });
  it('le prochain point est le premier non fait ; null si tout est fait', () => {
    assert.equal(nextCheckpoint(run(1, 'active', NOW, NOW, [true, false, true])).name, 'Point 2');
    assert.equal(nextCheckpoint(run(1, 'active', NOW, NOW, [true, true])), null);
    assert.equal(nextCheckpoint(null), null);
  });
});

describe('timeLeftLabel et isUrgent', () => {
  it('dit le temps restant', () => {
    assert.equal(timeLeftLabel(NOW + 12 * MIN, NOW), 'dans 12 min');
    assert.equal(timeLeftLabel(NOW + 65 * MIN, NOW), 'dans 1 h 05');
    assert.equal(timeLeftLabel(NOW + 20000, NOW), 'dans moins d’une minute');
  });
  it('dit le depassement', () => {
    assert.equal(timeLeftLabel(NOW - 3 * MIN, NOW), 'dépassé de 3 min');
    assert.equal(timeLeftLabel(NOW - 10000, NOW), 'dépassé à l’instant');
  });
  it('urgent sous 10 min ou depasse', () => {
    assert.equal(isUrgent(NOW + 9 * MIN, NOW), true);
    assert.equal(isUrgent(NOW + 10 * MIN, NOW), false);
    assert.equal(isUrgent(NOW + 30 * MIN, NOW), false);
    assert.equal(isUrgent(NOW - 1, NOW), true);
  });
});

describe('shouldIgnoreRepeat', () => {
  it('ignore le meme code relu dans les 3 s', () => {
    assert.equal(shouldIgnoreRepeat('abcde23456', NOW, 'abcde23456', NOW + 2999), true);
  });
  it('accepte le meme code apres 3 s, ou un autre code', () => {
    assert.equal(shouldIgnoreRepeat('abcde23456', NOW, 'abcde23456', NOW + 3000), false);
    assert.equal(shouldIgnoreRepeat('abcde23456', NOW, 'zzzzz22222', NOW + 100), false);
  });
  it('premier scan : jamais ignore', () => {
    assert.equal(shouldIgnoreRepeat(null, 0, 'abcde23456', NOW), false);
  });
});

describe('describeVerdict', () => {
  it('point valide', () => {
    assert.deepEqual(describeVerdict('ok', {}), { tone: 'ok', text: 'Point validé' });
  });
  it('avertissements', () => {
    assert.deepEqual(describeVerdict('out_of_route', {}), { tone: 'warn', text: 'Ce point n’est pas dans votre ronde' });
    assert.deepEqual(describeVerdict('no_run', {}), { tone: 'warn', text: 'Aucune ronde en cours : passage noté' });
    assert.deepEqual(describeVerdict('duplicate', {}), { tone: 'warn', text: 'Point déjà validé' });
  });
  it('hors ordre : nomme le prochain point (objet ou texte)', () => {
    assert.equal(describeVerdict('out_of_order', { next: { name: 'Portail' } }).text, 'Hors ordre : ce point ne compte pas — allez d’abord à Portail');
    assert.equal(describeVerdict('out_of_order', { next: 'Parking' }).text, 'Hors ordre : ce point ne compte pas — allez d’abord à Parking');
    assert.equal(describeVerdict('out_of_order', { next: null }).tone, 'warn');
  });
  it('verdict inconnu : avertissement neutre', () => {
    assert.equal(describeVerdict('autre', {}).tone, 'warn');
  });
});
