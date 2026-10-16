/**
 * Observations de visages : evenements Dahua (fixtures test/fixtures/dahua-face-*) -> cameras par (hote, voie) -> table face_event.
 * Base temporaire, horloge injectee, aucun reseau ni appareil reel.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parseEventPart } from '../server/dahua.ts';
import { openDb } from '../server/db.ts';
import { createFaceObs } from '../server/faceobs.ts';
import type { FaceSeen } from '../server/faceobs.ts';
import { seedDemo } from '../server/seed.ts';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURES = resolve(ROOT, 'test', 'fixtures');
const DAY = 86_400_000;
const H1 = '192.168.1.13';
const H2 = '192.168.1.14';

/** Fixture lue avec des fins de ligne normalisees (extraction CRLF sous Windows). */
const fixture = (name: string) => readFileSync(resolve(FIXTURES, `dahua-face-${name}.txt`), 'utf8').replace(/\r\n/g, '\n');
/** Texte apres « data= » d'une partie, comme le donne dahua.ts a onObservation. */
const dataOf = (part: string) => {
  const i = part.indexOf('data=');
  return i < 0 ? null : part.slice(i + 5);
};
/** Une partie du flux -> observation brute de dahua.ts (hote donne). */
function raw(host: string, name: string, at: number) {
  const part = fixture(name);
  const ev = parseEventPart(part);
  assert.ok(ev, `partie ${name} reconnue`);
  return { host, channel: ev.channel, code: ev.code, action: ev.action, at, data: dataOf(part) };
}

function setup(opts: { retentionDays?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'psim-faceobs-'));
  const db = openDb(join(dir, 'psim.db'));
  seedDemo(db, dir, join(ROOT, 'seed'));
  const cam = db.prepare("INSERT INTO camera_source (device_id, kind, host, port, rtsp_path, username, secret) VALUES (?, 'rtsp', ?, 554, ?, NULL, NULL)");
  cam.run('C-01', H1, '/cam/realmonitor?channel=5&subtype=1'); // voie 5 (known, two-candidates)
  cam.run('C-02', H1, '/cam/realmonitor?CHANNEL=8&subtype=0'); // voie 8 (unknown, detection)
  cam.run('C-03', H1, '/cam/realmonitor?channel=1&subtype=1'); // voie 1 (hostile)
  cam.run('C-04', H2, '/cam/realmonitor?channel=5&subtype=1'); // autre hote, meme voie 5
  cam.run('C-05', H1, '/cam/realmonitor?channel=50&subtype=1'); // « channel=50 » n'est pas la voie 5
  const clock = { t: 10 * DAY };
  const faces = createFaceObs({ db, now: () => clock.t, retentionDays: opts.retentionDays });
  const got: FaceSeen[] = [];
  faces.subscribe((s) => got.push(s));
  return { db, clock, faces, got };
}

const count = (db: ReturnType<typeof setup>['db']) => (db.prepare('SELECT COUNT(*) AS n FROM face_event').get() as { n: number }).n;
const plain = (s: FaceSeen) => ({ ...s });

describe('observations de visages : evenements -> cameras', () => {
  it('personne connue : une ligne sur la camera de la voie, avec identite, groupe et similarite', () => {
    const t = setup();
    t.faces.observe(raw(H1, 'recognition-known', 5000));
    assert.deepEqual(t.faces.history(0, 10_000).map(plain), [
      { id: 1, cameraId: 'C-01', at: 5000, kind: 'recognized', personId: '5', personName: 'Jean Exemple', groupId: '1', groupName: 'Residents et personnel', similarity: 91 },
    ]);
    assert.deepEqual(t.got.map(plain), t.faces.history(0, 10_000).map(plain), "l'abonne recoit la meme chose, avec l'identifiant");
  });

  it('deux candidats : le plus fort est retenu (Interdits, 88)', () => {
    const t = setup();
    t.faces.observe(raw(H1, 'recognition-two-candidates', 100));
    const [s] = t.faces.history(0, 1000);
    assert.equal(s.cameraId, 'C-01');
    assert.equal(s.kind, 'recognized');
    assert.equal(s.personName, 'Paul Fictif');
    assert.equal(s.groupName, 'Interdits');
    assert.equal(s.similarity, 88);
  });

  it('visage inconnu : kind « unknown », aucune identite', () => {
    const t = setup();
    t.faces.observe(raw(H1, 'recognition-unknown', 200));
    assert.deepEqual(t.faces.history(0, 1000).map(plain), [
      { id: 1, cameraId: 'C-02', at: 200, kind: 'unknown', personId: null, personName: null, groupId: null, groupName: null, similarity: null },
    ]);
  });

  it('FaceDetection (aucune identite) : jamais enregistre', () => {
    const t = setup();
    t.faces.observe(raw(H1, 'detection', 300));
    t.faces.observe({ host: H1, channel: 8, code: 'FaceDetection', action: 'Pulse', at: 301, data: null });
    assert.equal(count(t.db), 0);
    assert.deepEqual(t.got, []);
  });

  it('donnees hostiles : aucune exception ; seuls des champs nettoyes et bornes sont gardes (pas de __proto__, pas de photo)', () => {
    const t = setup();
    t.faces.observe(raw(H1, 'hostile', 400));
    const [s] = t.faces.history(0, 1000);
    assert.equal(s.cameraId, 'C-03');
    assert.equal(s.kind, 'recognized');
    assert.ok(s.personName !== null && s.personName.length <= 80);
    assert.ok(!/[\u0000-\u001f‮​]/.test(s.personName!), 'controles et marques de sens retires');
    assert.notEqual(s.personName, 'Pirate', "__proto__ n'est jamais suivi");
    assert.ok(s.similarity === null || (s.similarity >= 0 && s.similarity <= 100), 'similarite absurde ignoree');
    assert.equal(({} as Record<string, unknown>).Name, undefined, 'Object.prototype intact');
  });

  it("aucun octet de photo n'atteint la base : ni dans les colonnes, ni dans le fichier", () => {
    const t = setup();
    const photo = `/9j/4AAQSkZJRgABAQEASABIAAD/${'A'.repeat(5000)}JFIFMARQUEUR`;
    const body = JSON.stringify({ Candidates: [{ Similarity: 90, Person: { UID: '1', Name: 'Jean', GroupID: '1', GroupName: 'Base', Image: photo } }], SceneImage: photo, Face: { Image: photo } });
    t.faces.observe({ host: H1, channel: 5, code: 'FaceRecognition', action: 'Pulse', at: 1, data: `${body}\r\nÿØÿà JFIF ${photo}` });
    assert.equal(count(t.db), 1);
    const all = JSON.stringify(t.db.prepare('SELECT * FROM face_event').all());
    assert.ok(!all.includes('JFIF') && !all.includes('MARQUEUR') && !all.includes('/9j/'), 'rien de la photo');
    assert.ok(all.length < 400, `la ligne est minuscule (${all.length})`);
    assert.ok(!JSON.stringify(t.got).includes('JFIF'));
    // colonnes de la table : seulement des champs de FaceObservation
    const cols = (t.db.prepare('PRAGMA table_info(face_event)').all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(cols, ['id', 'camera_id', 'at', 'kind', 'person_uid', 'person_name', 'group_id', 'group_name', 'similarity']);
  });

  it('autres codes, actions Stop / Config et donnees invalides : ignores sans bruit ni exception', (ctx) => {
    const err = ctx.mock.method(console, 'error', () => {});
    const t = setup();
    const known = dataOf(fixture('recognition-known'));
    t.faces.observe({ host: H1, channel: 5, code: 'SmartMotionHuman', action: 'Start', at: 1, data: known });
    t.faces.observe({ host: H1, channel: 5, code: 'VideoMotion', action: 'Start', at: 1, data: known });
    t.faces.observe({ host: H1, channel: 5, code: 'facerecognition', action: 'Start', at: 1, data: known });
    t.faces.observe({ host: H1, channel: 5, code: 'FaceRecognition', action: 'Stop', at: 1, data: known });
    t.faces.observe({ host: H1, channel: 5, code: 'FaceRecognition', action: 'Config', at: 1, data: known });
    for (const data of [null, '', 'pas du json', '{', '[]', '"x"', '{"Candidates":[']) t.faces.observe({ host: H1, channel: 5, code: 'FaceRecognition', action: 'Pulse', at: 1, data });
    t.faces.observe({ host: H1, channel: 0, code: 'FaceRecognition', action: 'Pulse', at: 1, data: known });
    t.faces.observe({ host: H1, channel: 5.5, code: 'FaceRecognition', action: 'Pulse', at: 1, data: known });
    t.faces.observe({ host: H1, channel: 5, code: 'FaceRecognition', action: 'Pulse', at: Number.NaN, data: known });
    t.faces.observe(null as never);
    t.faces.observe({ host: H1, channel: 5, code: 'FaceRecognition', action: 5 as never, at: 1, data: known });
    assert.equal(count(t.db), 0);
    assert.equal(err.mock.callCount(), 1, "seule l'entree absurde (observation nulle) est signalee au journal technique");
  });
});

describe('observations de visages : correspondance (hote, voie) -> cameras', () => {
  it('un autre hote, ou une voie sans camera : ignore ; « channel=5 » n\'est pas « channel=50 » ; la casse est indifferente', () => {
    const t = setup();
    t.faces.observe(raw('10.0.0.9', 'recognition-known', 1)); // hote inconnu
    t.faces.observe({ ...raw(H1, 'recognition-known', 2), channel: 6 }); // voie sans camera
    assert.equal(count(t.db), 0);
    t.faces.observe(raw(H1, 'recognition-known', 3));
    assert.deepEqual(t.faces.history(0, 100).map((s) => s.cameraId), ['C-01']);
    t.faces.observe(raw(H1, 'recognition-unknown', 4)); // « CHANNEL=8 » en majuscules
    assert.deepEqual(t.faces.history(4, 4).map((s) => s.cameraId), ['C-02']);
    t.faces.observe(raw(H2, 'recognition-known', 5)); // meme voie, autre enregistreur
    assert.deepEqual(t.faces.history(5, 5).map((s) => s.cameraId), ['C-04']);
  });

  it('deux cameras sur la meme voie : une ligne par camera (et un evenement par camera)', () => {
    const t = setup();
    t.db.prepare("UPDATE camera_source SET rtsp_path = '/cam/realmonitor?channel=5&subtype=0' WHERE device_id = 'C-05'").run(); // 2e camera de la voie 5
    t.faces.observe(raw(H1, 'recognition-known', 10));
    assert.deepEqual(t.faces.history(0, 100).map((s) => s.cameraId), ['C-01', 'C-05']);
    assert.deepEqual(t.got.map((s) => s.cameraId), ['C-01', 'C-05']);
    assert.equal(count(t.db), 2);
  });

  it('meme correspondance que la presence (fonction partagee camerasOfSource)', async () => {
    const { camerasOfSource } = await import('../server/presence.ts');
    const t = setup();
    assert.deepEqual(camerasOfSource(t.db, H1, 5), ['C-01']);
    assert.deepEqual(camerasOfSource(t.db, H1), ['C-01', 'C-02', 'C-03', 'C-05']);
    assert.deepEqual(camerasOfSource(t.db, 'inconnu', 5), []);
  });
});

describe('observations de visages : doublons, abonnes, historique, conservation', () => {
  it('Start puis Pulse de la meme reconnaissance (meme camera, personne, date) : une seule ligne ; autre date ou autre personne : deux', () => {
    const t = setup();
    const start = { ...raw(H1, 'recognition-known', 700), action: 'Start' };
    t.faces.observe(start);
    t.faces.observe({ ...start, action: 'Pulse' });
    assert.equal(count(t.db), 1);
    t.faces.observe({ ...start, action: 'Pulse', at: 701 });
    assert.equal(count(t.db), 2, 'date differente : autre observation');
    t.faces.observe({ ...raw(H1, 'recognition-two-candidates', 701) });
    assert.equal(count(t.db), 3, 'autre personne');
    // un inconnu deux fois a la meme date : un seul
    t.faces.observe(raw(H1, 'recognition-unknown', 800));
    t.faces.observe(raw(H1, 'recognition-unknown', 800));
    assert.equal(count(t.db), 4);
  });

  it("un abonne en erreur ne casse ni les autres ni l'enregistrement ; se desabonner fonctionne", (ctx) => {
    const err = ctx.mock.method(console, 'error', () => {});
    const t = setup();
    const unsub = t.faces.subscribe(() => {
      throw new Error('abonne casse');
    });
    const seen2: FaceSeen[] = [];
    t.faces.subscribe((s) => seen2.push(s));
    t.faces.observe(raw(H1, 'recognition-known', 1));
    assert.equal(count(t.db), 1);
    assert.equal(t.got.length, 1);
    assert.equal(seen2.length, 1);
    assert.equal(err.mock.callCount(), 1);
    unsub();
    t.faces.observe(raw(H1, 'recognition-known', 2));
    assert.equal(err.mock.callCount(), 1);
    assert.equal(t.got.length, 2);
  });

  it('history : bornes incluses, tri par date puis identifiant, filtre par cameras ; liste vide = rien', () => {
    const t = setup();
    t.faces.observe(raw(H1, 'recognition-unknown', 300)); // C-02
    t.faces.observe(raw(H1, 'recognition-known', 100)); // C-01
    t.faces.observe(raw(H1, 'recognition-unknown', 200)); // C-02
    t.faces.observe(raw(H2, 'recognition-known', 200)); // C-04, meme date, identifiant suivant
    assert.deepEqual(t.faces.history(0, 1000).map((s) => [s.at, s.cameraId]), [[100, 'C-01'], [200, 'C-02'], [200, 'C-04'], [300, 'C-02']]);
    assert.deepEqual(t.faces.history(200, 300).map((s) => s.at), [200, 200, 300], 'bornes incluses');
    assert.deepEqual(t.faces.history(101, 199), []);
    assert.deepEqual(t.faces.history(0, 1000, ['C-02']).map((s) => s.at), [200, 300]);
    assert.deepEqual(t.faces.history(0, 1000, ['C-01', 'C-04']).map((s) => s.cameraId), ['C-01', 'C-04']);
    assert.deepEqual(t.faces.history(0, 1000, []), []);
    assert.deepEqual(t.faces.history(0, 1000, ["C-02' OR 1=1 --"]), [], 'parametres lies : pas d\'injection');
  });

  it('recent : les plus recentes d\'abord, 50 par defaut, 200 au plus, limite absurde ramenee', () => {
    const t = setup();
    for (let i = 1; i <= 260; i++) t.faces.observe({ ...raw(H1, 'recognition-unknown', i) });
    assert.equal(t.faces.recent().length, 50);
    assert.deepEqual(t.faces.recent(3).map((s) => s.at), [260, 259, 258]);
    assert.equal(t.faces.recent(1000).length, 200);
    assert.equal(t.faces.recent(0).length, 1);
    assert.equal(t.faces.recent(-5).length, 1);
    assert.equal(t.faces.recent(Number.NaN).length, 50);
    assert.equal(t.faces.recent(2.9).length, 2);
  });

  it('purge : efface au-dela de 30 jours (limite conservee), renvoie le nombre de lignes', () => {
    const t = setup();
    const now = t.clock.t;
    t.faces.observe(raw(H1, 'recognition-unknown', now - 31 * DAY));
    t.faces.observe(raw(H1, 'recognition-unknown', now - 30 * DAY - 1));
    t.faces.observe(raw(H1, 'recognition-unknown', now - 30 * DAY)); // pile 30 jours : conservee
    t.faces.observe(raw(H1, 'recognition-unknown', now - DAY));
    assert.equal(t.faces.purge(), 2);
    assert.equal(count(t.db), 2);
    assert.equal(t.faces.purge(), 0);
    t.clock.t = now + 40 * DAY;
    assert.equal(t.faces.purge(), 2);
  });

  it('duree de conservation reglable', () => {
    const t = setup({ retentionDays: 2 });
    t.faces.observe(raw(H1, 'recognition-unknown', t.clock.t - 3 * DAY));
    t.faces.observe(raw(H1, 'recognition-unknown', t.clock.t - DAY));
    assert.equal(t.faces.purge(), 1);
  });

  it('la table survit a une recreation du module (CREATE TABLE IF NOT EXISTS) et garde les donnees', () => {
    const t = setup();
    t.faces.observe(raw(H1, 'recognition-known', 50));
    const again = createFaceObs({ db: t.db, now: () => t.clock.t });
    assert.equal(again.history(0, 100).length, 1);
  });
});
