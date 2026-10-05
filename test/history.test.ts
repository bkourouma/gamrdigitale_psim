import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { availabilityOf, beginHistory, loadIntervals, outagesOf, purgeHistory, recordState } from '../server/history.ts';
import { seedDemo } from '../server/seed.ts';

const T0 = 1_000_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;

function setup(silentTimeoutMs = 0) {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  let clock = T0;
  const engine = createEngine(db, () => {}, () => clock, { silentTimeoutMs });
  // Comme au demarrage reel : chaque detecteur a un etat ouvert depuis T0.
  beginHistory(db, T0, null, null);
  return { db, engine, advance: (ms: number) => void (clock += ms), now: () => clock };
}

const rowsOf = (db: ReturnType<typeof openDb>, id: string) =>
  db.prepare('SELECT state, started_at, ended_at FROM device_state_history WHERE device_id = ? ORDER BY id').all(id) as { state: string; started_at: number; ended_at: number | null }[];

describe('historique des etats', () => {
  it('chaque changement ferme l etat precedent a l instant exact, sans trou ni chevauchement', () => {
    const t = setup();
    t.advance(10 * MIN);
    t.engine.handleDetectorMessage('D-01', { state: 'alarm' });
    t.advance(5 * MIN);
    t.engine.handleDetectorMessage('D-01', { state: 'normal' });
    const rows = rowsOf(t.db, 'D-01');
    assert.deepEqual(rows.map((r) => r.state), ['normal', 'alarm', 'normal']);
    assert.equal(rows[0].ended_at, rows[1].started_at);
    assert.equal(rows[1].ended_at, rows[2].started_at);
    assert.equal(rows[2].ended_at, null, 'l etat en cours reste ouvert');
    assert.equal(rows[1].ended_at! - rows[1].started_at, 5 * MIN);
  });

  it('un message qui ne change rien n ajoute aucune ligne', () => {
    const t = setup();
    for (let i = 0; i < 5; i++) {
      t.advance(MIN);
      t.engine.handleDetectorMessage('D-01', { state: 'normal' });
    }
    assert.equal(rowsOf(t.db, 'D-01').length, 1);
  });

  it('un detecteur muet est enregistre hors ligne, et son retour met fin a la panne', () => {
    const t = setup(60_000);
    t.engine.handleDetectorMessage('D-01', { state: 'normal' });
    t.advance(2 * MIN);
    assert.ok(t.engine.checkSilentDetectors().includes('D-01'));
    t.advance(30 * MIN);
    t.engine.handleDetectorMessage('D-01', { state: 'normal' });
    const rows = rowsOf(t.db, 'D-01');
    assert.deepEqual(rows.map((r) => r.state), ['normal', 'offline', 'normal']);
    const outages = outagesOf('D-01', loadIntervals(t.db, T0, T0 + 3 * HOUR, t.now()).get('D-01')!, t.now(), t.now());
    assert.equal(outages.length, 1);
    assert.equal(outages[0].cause, 'offline');
    assert.ok(outages[0].to !== null, 'la panne est terminee');
    assert.ok(outages[0].durationS >= 30 * 60 && outages[0].durationS <= 33 * 60);
  });

  it('l alarme est un detecteur qui fonctionne : elle ne compte pas comme une panne', () => {
    const t = setup();
    t.advance(HOUR);
    t.engine.handleDetectorMessage('D-01', { state: 'alarm' });
    t.advance(HOUR);
    const a = availabilityOf(loadIntervals(t.db, T0, t.now(), t.now()).get('D-01')!, T0, t.now(), t.now());
    assert.equal(a.pct, 100);
    assert.equal(a.downS, 0);
    assert.equal(a.upS, 7200);
  });

  it('calcule la disponibilite : 1 h de defaut sur 10 h = 90 %', () => {
    const t = setup();
    t.advance(4 * HOUR);
    t.engine.handleDetectorMessage('D-01', { state: 'fault' });
    t.advance(HOUR);
    t.engine.handleDetectorMessage('D-01', { state: 'normal' });
    t.advance(5 * HOUR);
    const a = availabilityOf(loadIntervals(t.db, T0, t.now(), t.now()).get('D-01')!, T0, t.now(), t.now());
    assert.equal(a.pct, 90);
    assert.equal(a.downS, 3600);
    assert.equal(a.unmonitoredS, 0);
  });

  it('defaut puis hors ligne a la suite = une seule panne', () => {
    const t = setup(60_000);
    t.engine.handleDetectorMessage('D-01', { state: 'fault' });
    t.advance(10 * MIN);
    t.engine.checkSilentDetectors(); // le detecteur en defaut se tait : « hors ligne », meme panne
    t.advance(20 * MIN);
    t.engine.handleDetectorMessage('D-01', { state: 'normal' });
    const outages = outagesOf('D-01', loadIntervals(t.db, T0, T0 + HOUR * 2, t.now()).get('D-01')!, t.now(), t.now());
    assert.equal(outages.length, 1);
    assert.equal(outages[0].cause, 'fault', 'la cause est le premier etat');
    assert.ok(outages[0].durationS >= 29 * 60);
  });

  it('une panne en cours n a pas de fin et dure jusqu a maintenant', () => {
    const t = setup();
    t.engine.handleDetectorMessage('D-01', { state: 'fault' });
    t.advance(2 * HOUR);
    const [o] = outagesOf('D-01', loadIntervals(t.db, T0, t.now(), t.now()).get('D-01')!, t.now(), t.now());
    assert.equal(o.to, null);
    assert.equal(o.durationS, 7200);
  });

  it('le temps ou le PSIM etait arrete n est ni disponible ni indisponible : il est rapporte a part', () => {
    const t = setup();
    t.advance(2 * HOUR);
    // Le PSIM s'arrete (dernier signe de vie), puis redemarre 3 h plus tard.
    const alive = t.now();
    t.advance(3 * HOUR);
    beginHistory(t.db, t.now(), alive, { from: alive, to: t.now(), clean: false });
    t.advance(HOUR);
    const a = availabilityOf(loadIntervals(t.db, T0, t.now(), t.now()).get('D-01')!, T0, t.now(), t.now());
    assert.equal(a.unmonitoredS, 3 * 3600);
    assert.equal(a.upS, 3 * 3600, '2 h avant + 1 h apres');
    assert.equal(a.pct, 100, 'les 3 h d arret ne baissent pas le chiffre');
    const blind = (t.db.prepare('SELECT from_ts, to_ts, clean FROM blind_period').all() as { from_ts: number; to_ts: number; clean: number }[]).map((r) => ({ ...r }));
    assert.deepEqual(blind, [{ from_ts: alive, to_ts: alive + 3 * HOUR, clean: 0 }]);
  });

  it('un detecteur sans aucun historique n a pas de pourcentage invente', () => {
    const t = setup();
    t.db.prepare('DELETE FROM device_state_history WHERE device_id = ?').run('D-02');
    const a = availabilityOf(loadIntervals(t.db, T0, T0 + HOUR, T0 + HOUR).get('D-02') ?? [], T0, T0 + HOUR, T0 + HOUR);
    assert.equal(a.pct, null);
    assert.equal(a.upS + a.downS, 0);
  });

  it('un detecteur ajoute en cours de periode n est pas « non surveille » avant son ajout', () => {
    const t = setup();
    t.advance(5 * HOUR);
    t.engine.createDevice('admin', { id: 'D-99', kind: 'detector', name: 'Nouveau', zone: 'Atelier' });
    t.advance(HOUR);
    const a = availabilityOf(loadIntervals(t.db, T0, t.now(), t.now()).get('D-99')!, T0, t.now(), t.now());
    assert.equal(a.upS, 3600);
    assert.equal(a.unmonitoredS, 0);
  });

  it('au premier demarrage avec cette fonction, l etat existant est date de son dernier changement connu', () => {
    const db = openDb(':memory:');
    seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
    db.prepare("UPDATE device SET status = 'fault', state_since = ? WHERE id = 'D-01'").run(T0 - 6 * HOUR);
    beginHistory(db, T0, null, null);
    const [row] = rowsOf(db, 'D-01');
    assert.equal(row.state, 'fault');
    assert.equal(row.started_at, T0 - 6 * HOUR);
  });

  it('un detecteur qui oscille est enregistre en entier, sans plafond (le journal, lui, se limite)', () => {
    const t = setup();
    for (let i = 0; i < 80; i++) {
      t.advance(10_000);
      t.engine.handleDetectorMessage('D-01', { state: i % 2 === 0 ? 'fault' : 'normal' });
    }
    assert.equal(rowsOf(t.db, 'D-01').length, 81);
  });

  it('une horloge revenue en arriere ne donne jamais une duree negative', () => {
    const t = setup();
    recordState(t.db, 'D-01', 'fault', T0 - HOUR);
    const rows = rowsOf(t.db, 'D-01');
    assert.ok(rows.every((r) => r.ended_at === null || r.ended_at >= r.started_at));
  });

  it('la purge ne retire que les etats termines et anciens', () => {
    const t = setup();
    t.advance(HOUR);
    t.engine.handleDetectorMessage('D-01', { state: 'fault' });
    t.advance(HOUR);
    t.engine.handleDetectorMessage('D-01', { state: 'normal' });
    const before = t.db.prepare('SELECT COUNT(*) AS n FROM device_state_history').get() as { n: number };
    purgeHistory(t.db, T0 + 90 * MIN);
    const after = t.db.prepare('SELECT COUNT(*) AS n FROM device_state_history').get() as { n: number };
    assert.equal(before.n - after.n, 1, 'seul « normal » de T0 a T0+1h est termine avant la limite');
    assert.ok(rowsOf(t.db, 'D-01').some((r) => r.ended_at === null), 'l etat en cours est toujours la');
  });
});
