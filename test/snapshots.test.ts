import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { createSnapshotService } from '../server/snapshots.ts';
import { seedDemo } from '../server/seed.ts';
import type { Incident } from '../server/types.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const tick = () => new Promise((r) => setTimeout(r, 20));

function setup(grab: (id: string) => Promise<Buffer>, opts: { max?: number; confirmWindowMs?: number } = {}) {
  const db = openDb(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'psim-snap-'));
  seedDemo(db, dataDir, join(import.meta.dirname, '..', 'seed'));
  // D-05 et D-06 sont liees a C-04 / C-05 : on leur donne une source reelle (les autres restent simulees).
  db.prepare("UPDATE device SET stream_kind = 'rtsp' WHERE id IN ('C-04', 'C-05')").run();
  const published: number[] = [];
  const hooks: string[] = [];
  let snapshots: ReturnType<typeof createSnapshotService> | undefined;
  const engine = createEngine(db, () => {}, Date.now, {
    confirmWindowMs: opts.confirmWindowMs ?? 0,
    onIncidentEvent: (incident: Incident, kind) => {
      hooks.push(`${incident.detectorId}:${kind}`);
      void snapshots?.capture(incident, kind);
    },
  });
  snapshots = createSnapshotService({ db, engine, dataDir, grab, maxPerIncident: opts.max, publishIncident: (id) => void published.push(id) });
  return { db, dataDir, engine, snapshots, published, hooks, send: (id: string, state: string) => engine.handleDetectorMessage(id, { state }) };
}

describe('images prises a l\'ouverture d\'un incident', () => {
  it('prend une image de chaque camera liee a source reelle, et ignore les cameras simulees', async () => {
    const grabbed: string[] = [];
    const t = setup(async (id) => (grabbed.push(id), JPEG));
    t.send('D-06', 'alarm'); // D-06 -> C-05, C-04 (reelles)
    await tick();
    const incident = t.engine.getSnapshot().incidents[0];
    assert.deepEqual(grabbed.sort(), ['C-04', 'C-05']);
    assert.equal(incident.snapshots.length, 2);
    assert.ok(incident.snapshots.every((s) => s.reason === 'opened'));
    assert.deepEqual(t.snapshots.read(incident.snapshots[0].id), JPEG);
    assert.ok(t.published.includes(incident.id), 'les ecrans sont prevenus de la nouvelle image');
  });

  it("ne tente rien pour un detecteur dont les cameras sont simulees", async () => {
    const grabbed: string[] = [];
    const t = setup(async (id) => (grabbed.push(id), JPEG));
    t.send('D-01', 'alarm'); // C-01, C-02 : simulees
    await tick();
    assert.deepEqual(grabbed, []);
    assert.equal(t.engine.getSnapshot().incidents[0].snapshots.length, 0);
  });

  it("une capture lente ne retarde JAMAIS l'alarme : l'incident existe avant la fin de la capture", async () => {
    const pending: ((b: Buffer) => void)[] = [];
    const t = setup(() => new Promise<Buffer>((r) => void pending.push(r)));
    t.send('D-06', 'alarm'); // rendu immediatement, meme si la camera ne repond pas
    const incident = t.engine.getSnapshot().incidents[0];
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.snapshots.length, 0, 'image pas encore la');
    for (const release of pending) release(JPEG);
    await tick();
    assert.equal(t.engine.getSnapshot().incidents[0].snapshots.length, 2);
  });

  it('une camera en echec est journalisee et ne fait pas echouer l\'alarme ni les autres cameras', async () => {
    const t = setup(async (id) => {
      if (id === 'C-04') throw new Error('camera injoignable');
      return JPEG;
    });
    t.send('D-06', 'alarm');
    await tick();
    const incident = t.engine.getSnapshot().incidents[0];
    assert.equal(incident.snapshots.length, 1);
    assert.equal(incident.snapshots[0].cameraId, 'C-05');
    const failure = t.engine.listAudit(50).find((a) => a.action === 'snapshot_failed');
    assert.equal(failure?.deviceId, 'C-04');
    assert.match(failure?.details ?? '', /injoignable/);
  });

  it("rejette ce qui n'est pas une image JPEG", async () => {
    const t = setup(async () => Buffer.from('<html>pas une image</html>'));
    t.send('D-06', 'alarm');
    await tick();
    assert.equal(t.engine.getSnapshot().incidents[0].snapshots.length, 0);
    assert.ok(t.engine.listAudit(50).some((a) => a.action === 'snapshot_failed'));
  });

  it("l'aggravation et la confirmation prennent de nouvelles images, dans la limite du plafond", async () => {
    const t = setup(async () => JPEG, { max: 5, confirmWindowMs: 60_000 });
    t.send('D-06', 'prealarm');
    await tick();
    t.send('D-06', 'alarm'); // aggravation
    await tick();
    t.send('D-05', 'prealarm'); // voisin : confirmation (D-05 -> C-04)
    await tick();
    const kinds = [...new Set(t.engine.getSnapshot().incidents.find((i) => i.detectorId === 'D-06')!.snapshots.map((s) => s.reason))];
    assert.deepEqual(kinds.sort(), ['confirmed', 'escalated', 'opened']);
    for (const i of t.engine.getSnapshot().incidents) assert.ok(i.snapshots.length <= 5, 'plafond respecte');
    assert.deepEqual(t.hooks.filter((h) => h.startsWith('D-06')), ['D-06:opened', 'D-06:escalated', 'D-06:confirmed']);
  });

  it("une exception dans le crochet n'empeche pas l'alarme", () => {
    const db = openDb(':memory:');
    seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
    const engine = createEngine(db, () => {}, Date.now, {
      onIncidentEvent: () => {
        throw new Error('panne du service d\'images');
      },
    });
    const original = console.error;
    console.error = () => {};
    try {
      engine.handleDetectorMessage('D-01', { state: 'alarm' });
    } finally {
      console.error = original;
    }
    assert.equal(engine.getSnapshot().incidents[0].severity, 'critical');
  });
});

describe('lecture et conservation des images', () => {
  it('ne lit jamais un fichier hors du dossier des images, meme si la base est alteree', async () => {
    const t = setup(async () => JPEG);
    t.send('D-06', 'alarm');
    await tick();
    const [first] = t.engine.getSnapshot().incidents[0].snapshots;
    t.db.prepare("UPDATE incident_snapshot SET file = '../../secret.key' WHERE id = ?").run(first.id);
    assert.equal(t.snapshots.read(first.id), null);
    assert.equal(t.snapshots.read(99999), null);
  });

  it('supprime les images trop anciennes (fichier et ligne) et garde les autres', async () => {
    const t = setup(async () => JPEG);
    t.send('D-06', 'alarm');
    await tick();
    const [old, recent] = t.engine.getSnapshot().incidents[0].snapshots;
    t.db.prepare('UPDATE incident_snapshot SET taken_at = ? WHERE id = ?').run(Date.now() - 40 * 86_400_000, old.id);
    assert.equal(t.snapshots.purge(30), 1);
    assert.equal(t.snapshots.read(old.id), null);
    assert.ok(!existsSync(join(t.dataDir, 'snapshots', `${old.id}.jpg`)));
    assert.deepEqual(t.snapshots.read(recent.id), JPEG);
    assert.equal(t.snapshots.purge(0), 0, '0 = conservation illimitee');
  });
});
