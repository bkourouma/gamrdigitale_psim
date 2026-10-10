/**
 * Integration etape 3 (passerelle GAMR + Tuya etendu) : une base de l'etape 2 (tuya_source sans sensor_type) rouverte deux
 * fois par le code de l'etape 3 reste integre : colonne ajoutee une seule fois, donnees, incidents et journal scelle intacts.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { verify } from '../server/auditchain.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { seedDemo } from '../server/seed.ts';

const SEED = resolve(import.meta.dirname, '..', 'seed');
const TUYA_ID = 'c1b2c3d4e5f6a7b8c9d0e1';

describe('integration etape 3 : migration de la base', () => {
  it("base de l'etape 2 rouverte deux fois : tuya_source.sensor_type ajoutee, donnees et journal intacts", () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-etape3-'));
    try {
      const file = join(dir, 'psim.db');
      // Base « etape 2 » : donnees de demonstration, une source Tuya (detecteur de fumee), deux incidents, un msgId memorise.
      const old = openDb(file);
      seedDemo(old, dir, SEED);
      const e2 = createEngine(old, () => {}, Date.now, { isArmed: () => true });
      old.prepare('INSERT INTO tuya_source (device_id, tuya_id) VALUES (?, ?)').run('D-01', TUYA_ID);
      e2.handleDetectorMessage('D-02', { state: 'alarm' });
      e2.handleDetectorMessage('I-01', { event: 'intrusion', ts: Date.now() - 1000, msgId: 'etape2-1' });
      old.exec('ALTER TABLE tuya_source DROP COLUMN sensor_type');
      const before = {
        devices: (old.prepare('SELECT COUNT(*) AS n FROM device').get() as { n: number }).n,
        incidents: (old.prepare('SELECT id, detector_id, event FROM incident ORDER BY id').all() as Record<string, unknown>[]).map((r) => ({ ...r })),
        audit: (old.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n,
      };
      assert.equal(verify(old).ok, true);
      old.close();

      for (const pass of [1, 2]) {
        const db = openDb(file);
        const cols = (db.prepare('PRAGMA table_info(tuya_source)').all() as { name: string }[]).map((c) => c.name);
        assert.deepEqual(cols, ['device_id', 'tuya_id', 'sensor_type'], `passage ${pass}`);
        assert.deepEqual((db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((r) => r.integrity_check), ['ok']);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        assert.deepEqual({ ...(db.prepare('SELECT device_id, tuya_id, sensor_type FROM tuya_source').get() as object) }, { device_id: 'D-01', tuya_id: TUYA_ID, sensor_type: null });
        assert.equal((db.prepare('SELECT COUNT(*) AS n FROM device').get() as { n: number }).n, before.devices);
        assert.deepEqual((db.prepare('SELECT id, detector_id, event FROM incident ORDER BY id').all() as Record<string, unknown>[]).map((r) => ({ ...r })), before.incidents);
        assert.equal((db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n, before.audit);
        assert.equal(verify(db).ok, true, 'journal scelle intact');
        // Le moteur de l'etape 3 travaille sur la base migree : le msgId deja vu reste un doublon, un nouveau passe.
        const engine = createEngine(db, () => {}, Date.now, { isArmed: () => true });
        assert.equal(engine.getSnapshot().incidents.filter((i) => i.status !== 'closed').length, 2);
        assert.deepEqual(engine.ingest('I-01', { event: 'intrusion', ts: Date.now() - 1000, msgId: 'etape2-1' }), { ok: true, duplicate: true });
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
