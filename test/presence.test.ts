/**
 * Presence : observations (hote, voie) -> cameras, debuts et fins de presence, historique et reprise au demarrage.
 * Base temporaire, horloge injectee, aucun reseau.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.ts';
import { createPresence, PRESENCE_CODES } from '../server/presence.ts';
import type { PresenceChange } from '../server/presence.ts';
import { seedDemo } from '../server/seed.ts';

const ROOT = resolve(import.meta.dirname, '..');
const DAY = 86_400_000;
const H1 = '192.168.1.13';
const H2 = '192.168.1.14';

function setup(opts: { retentionDays?: number; dir?: string; start?: number } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'psim-presence-'));
  const db = openDb(join(dir, 'psim.db'));
  if (!opts.dir) {
    seedDemo(db, dir, join(ROOT, 'seed'));
    const cam = db.prepare("INSERT INTO camera_source (device_id, kind, host, port, rtsp_path, username, secret) VALUES (?, 'rtsp', ?, 554, ?, NULL, NULL)");
    cam.run('C-01', H1, '/cam/realmonitor?channel=1&subtype=1');
    cam.run('C-02', H1, '/cam/realmonitor?channel=10&subtype=1');
    cam.run('C-03', H1, '/cam/realmonitor?CHANNEL=2&subtype=0');
    cam.run('C-04', H2, '/cam/realmonitor?channel=1&subtype=1');
  }
  const clock = { t: opts.start ?? 1_000_000 };
  const presence = createPresence({ db, now: () => clock.t, retentionDays: opts.retentionDays });
  const seen: PresenceChange[] = [];
  presence.subscribe((c) => seen.push(c));
  return { dir, db, clock, presence, seen };
}

const obs = (host: string, channel: number, action: string, at: number, code = 'SmartMotionHuman') => ({ host, channel, code, action, at });
const rows = (db: DatabaseSync) => db.prepare('SELECT camera_id, kind, at, source FROM presence_event ORDER BY id').all().map((r) => ({ ...r }));

describe('presence : observations -> cameras', () => {
  it('seul SmartMotionHuman compte', () => {
    assert.deepEqual([...PRESENCE_CODES], ['SmartMotionHuman']);
    const t = setup();
    t.presence.observe(obs(H1, 1, 'Start', 10, 'VideoMotion'));
    t.presence.observe(obs(H1, 1, 'Start', 10, 'SmartMotionVehicle'));
    t.presence.observe(obs(H1, 1, 'Pulse', 10));
    t.presence.observe(obs(H1, 1, 'Heartbeat', 10));
    assert.deepEqual(t.presence.current(), {});
    assert.deepEqual(rows(t.db), []);
  });

  it('hote + voie -> camera : channel=1 n\'est pas channel=10, la casse est indifferente, un autre hote est une autre camera', () => {
    const t = setup();
    t.presence.observe(obs(H1, 1, 'Start', 100));
    assert.deepEqual(Object.keys(t.presence.current()), ['C-01'], 'voie 1 : C-01 seule (pas C-02 en channel=10)');
    t.presence.observe(obs(H1, 10, 'Start', 110));
    t.presence.observe(obs(H1, 2, 'Start', 120)); // « CHANNEL=2 » en majuscules
    t.presence.observe(obs(H2, 1, 'Start', 130));
    assert.deepEqual(t.presence.current(), { 'C-01': { since: 100 }, 'C-02': { since: 110 }, 'C-03': { since: 120 }, 'C-04': { since: 130 } });
    t.presence.observe(obs(H1, 1, 'Stop', 200));
    assert.deepEqual(Object.keys(t.presence.current()).sort(), ['C-02', 'C-03', 'C-04'], 'la fin de la voie 1 ne touche pas la voie 10 ni l\'autre hote');
  });

  it('observation sans camera correspondante (voie ou hote inconnus) : ignoree, rien d\'ecrit', () => {
    const t = setup();
    t.presence.observe(obs(H1, 5, 'Start', 100));
    t.presence.observe(obs(H1, 11, 'Start', 100));
    t.presence.observe(obs('10.0.0.9', 1, 'Start', 100));
    assert.deepEqual(t.presence.current(), {});
    assert.deepEqual(rows(t.db), []);
    assert.deepEqual(t.seen, []);
  });

  it('plusieurs cameras sur la meme voie : toutes sont concernees', () => {
    const t = setup();
    t.db.prepare("UPDATE camera_source SET rtsp_path = '/cam?channel=1&subtype=0' WHERE device_id = 'C-03'").run();
    t.presence.observe(obs(H1, 1, 'Start', 100));
    assert.deepEqual(Object.keys(t.presence.current()).sort(), ['C-01', 'C-03']);
    t.presence.observe(obs(H1, 1, 'Stop', 150));
    assert.deepEqual(t.presence.current(), {});
    assert.deepEqual(t.seen.map((c) => [c.cameraId, c.kind]).sort(), [['C-01', 'start'], ['C-01', 'stop'], ['C-03', 'start'], ['C-03', 'stop']]);
  });

  it('Start / Stop (casse indifferente), source = code de l\'evenement, occupied / current', () => {
    const t = setup();
    assert.equal(t.presence.occupied('C-01'), null);
    t.presence.observe(obs(H1, 1, 'start', 100));
    assert.deepEqual(t.presence.occupied('C-01'), { since: 100 });
    assert.equal(t.presence.occupied('C-04'), null);
    assert.deepEqual(t.presence.current(), { 'C-01': { since: 100 } });
    t.presence.observe(obs(H1, 1, 'STOP', 160));
    assert.equal(t.presence.occupied('C-01'), null);
    assert.deepEqual(t.presence.current(), {});
    assert.deepEqual(rows(t.db), [
      { camera_id: 'C-01', kind: 'start', at: 100, source: 'SmartMotionHuman' },
      { camera_id: 'C-01', kind: 'stop', at: 160, source: 'SmartMotionHuman' },
    ]);
  });

  it('Start sur une camera deja occupee et Stop sur une camera libre : ignores, aucune ligne en double', () => {
    const t = setup();
    t.presence.observe(obs(H1, 1, 'Stop', 50)); // libre
    assert.deepEqual(rows(t.db), []);
    t.presence.observe(obs(H1, 1, 'Start', 100));
    t.presence.observe(obs(H1, 1, 'Start', 120)); // deja occupee : le debut reste 100
    assert.deepEqual(t.presence.occupied('C-01'), { since: 100 });
    t.presence.observe(obs(H1, 1, 'Stop', 200));
    t.presence.observe(obs(H1, 1, 'Stop', 210));
    assert.equal(rows(t.db).length, 2);
    assert.deepEqual(t.seen.map((c) => c.kind), ['start', 'stop']);
  });

  it('flux perdu : un « stop » link_lost pour chaque camera occupee de cet hote, pas les autres', () => {
    const t = setup();
    t.presence.observe(obs(H1, 1, 'Start', 100));
    t.presence.observe(obs(H1, 2, 'Start', 110));
    t.presence.observe(obs(H2, 1, 'Start', 120));
    t.clock.t = 500;
    t.presence.linkLost(H1);
    assert.deepEqual(t.presence.current(), { 'C-04': { since: 120 } });
    assert.deepEqual(t.presence.history(400, 600).map((c) => [c.cameraId, c.kind, c.at, c.source]), [
      ['C-01', 'stop', 500, 'link_lost'],
      ['C-03', 'stop', 500, 'link_lost'],
    ]);
    t.presence.linkLost(H1); // personne d'occupe : rien de plus
    t.presence.linkLost('10.0.0.9');
    assert.equal(rows(t.db).length, 5);
    t.presence.observe(obs(H1, 1, 'Start', 600)); // et la presence peut reprendre ensuite
    assert.deepEqual(t.presence.occupied('C-01'), { since: 600 });
  });
});

describe('presence : abonnes', () => {
  it('subscribe renvoie le desabonnement ; un abonne qui leve une exception n\'empeche pas les autres ni l\'enregistrement', () => {
    const t = setup();
    const quiet: string[] = [];
    const log = console.error;
    console.error = () => {};
    try {
      t.presence.subscribe(() => {
        throw new Error('abonne casse');
      });
      const off = t.presence.subscribe((c) => quiet.push(`${c.cameraId}:${c.kind}`));
      t.presence.observe(obs(H1, 1, 'Start', 100));
      assert.deepEqual(quiet, ['C-01:start']);
      assert.deepEqual(t.seen.map((c) => c.kind), ['start'], 'l\'abonne de setup() recoit aussi (avant et apres le casse)');
      off();
      t.presence.observe(obs(H1, 1, 'Stop', 200));
      assert.deepEqual(quiet, ['C-01:start'], 'desabonne : plus rien');
      assert.deepEqual(t.seen.map((c) => c.kind), ['start', 'stop']);
      assert.equal(rows(t.db).length, 2);
    } finally {
      console.error = log;
    }
  });

  it('le changement transmis porte camera, nature, instant et source', () => {
    const t = setup();
    t.presence.observe(obs(H2, 1, 'Start', 777));
    assert.deepEqual(t.seen, [{ cameraId: 'C-04', kind: 'start', at: 777, source: 'SmartMotionHuman' }]);
  });
});

describe('presence : historique et conservation', () => {
  function filled() {
    const t = setup();
    t.presence.observe(obs(H1, 1, 'Start', 100));
    t.presence.observe(obs(H2, 1, 'Start', 100)); // meme instant : tri par id
    t.presence.observe(obs(H1, 1, 'Stop', 300));
    t.presence.observe(obs(H2, 1, 'Stop', 250)); // insere apres mais plus tot : tri par `at`
    t.presence.observe(obs(H1, 1, 'Start', 500));
    return t;
  }

  it('history : bornes incluses, tri par at puis id, filtre par cameras', () => {
    const t = filled();
    const all = t.presence.history(0, 1000);
    assert.deepEqual(all.map((c) => [c.cameraId, c.kind, c.at]), [
      ['C-01', 'start', 100],
      ['C-04', 'start', 100],
      ['C-04', 'stop', 250],
      ['C-01', 'stop', 300],
      ['C-01', 'start', 500],
    ]);
    assert.deepEqual(t.presence.history(250, 300).map((c) => c.at), [250, 300], 'bornes incluses');
    assert.deepEqual(t.presence.history(101, 249), []);
    assert.deepEqual(t.presence.history(0, 1000, ['C-04']).map((c) => [c.cameraId, c.kind]), [['C-04', 'start'], ['C-04', 'stop']]);
    assert.deepEqual(t.presence.history(0, 1000, ['C-01', 'C-04']).length, 5);
    assert.deepEqual(t.presence.history(0, 1000, ['C-03']), []);
    assert.deepEqual(t.presence.history(0, 1000, []), [], 'liste vide : aucune camera');
  });

  it('purge : efface au-dela de la duree de conservation (30 jours par defaut), renvoie le nombre de lignes', () => {
    const t = setup({ start: 100 * DAY });
    t.presence.observe(obs(H1, 1, 'Start', 60 * DAY));
    t.presence.observe(obs(H1, 1, 'Stop', 69 * DAY)); // 31 jours avant « maintenant » : efface
    t.presence.observe(obs(H1, 1, 'Start', 70 * DAY)); // 30 jours pile : conserve
    t.presence.observe(obs(H1, 1, 'Stop', 99 * DAY));
    assert.equal(t.presence.purge(), 2);
    assert.deepEqual(t.presence.history(0, 200 * DAY).map((c) => c.at), [70 * DAY, 99 * DAY]);
    assert.equal(t.presence.purge(), 0);
    t.clock.t = 200 * DAY;
    assert.equal(t.presence.purge(), 2, 'plus tard, tout est perime');
    assert.deepEqual(t.presence.history(0, 300 * DAY), []);
  });

  it('retentionDays regle la duree', () => {
    const t = setup({ start: 10 * DAY, retentionDays: 2 });
    t.presence.observe(obs(H1, 1, 'Start', 7 * DAY));
    t.presence.observe(obs(H1, 1, 'Stop', 9 * DAY + 1));
    assert.equal(t.presence.purge(), 1);
    assert.equal(t.presence.history(0, 20 * DAY).length, 1);
  });
});

describe('presence : reprise au demarrage', () => {
  it('Start sans Stop avant l\'arret : un « stop » restart horodate a l\'ouverture, l\'etat repart vide, l\'historique reste coherent', () => {
    const a = setup({ start: 1000 });
    a.presence.observe(obs(H1, 1, 'Start', 1100)); // C-01 reste ouverte
    a.presence.observe(obs(H2, 1, 'Start', 1200));
    a.presence.observe(obs(H2, 1, 'Stop', 1300)); // C-04 fermee normalement
    const b = setup({ dir: a.dir, start: 5000 });
    assert.deepEqual(b.presence.current(), {});
    assert.equal(b.presence.occupied('C-01'), null);
    assert.deepEqual(b.presence.history(0, 10_000).map((c) => [c.cameraId, c.kind, c.at, c.source]), [
      ['C-01', 'start', 1100, 'SmartMotionHuman'],
      ['C-04', 'start', 1200, 'SmartMotionHuman'],
      ['C-04', 'stop', 1300, 'SmartMotionHuman'],
      ['C-01', 'stop', 5000, 'restart'],
    ]);
    assert.deepEqual(b.seen, [], 'rien n\'est diffuse : personne n\'est encore abonne');
    // Un troisieme demarrage n'ajoute rien : tout est deja ferme.
    const c = setup({ dir: a.dir, start: 9000 });
    assert.equal(c.presence.history(0, 20_000).length, 4);
    // Et la presence peut recommencer.
    c.presence.observe(obs(H1, 1, 'Start', 9500));
    assert.deepEqual(c.presence.occupied('C-01'), { since: 9500 });
  });
});
