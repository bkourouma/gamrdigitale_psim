import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { validatePassword } from '../scripts/set-password.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { seedDemo } from '../server/seed.ts';
import { createSystemStatus } from '../server/system.ts';
import type { BackupStatus } from '../server/system.ts';

const T0 = 1_800_000_000_000;
const H = 3_600_000;

function setup(over: { freeGb?: number; backupEveryH?: number; backup?: BackupStatus; channels?: number; failed?: number; tickAgeMs?: number; startedAgoMs?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'psim-sys-'));
  const db = openDb(join(dataDir, 'psim.db'));
  seedDemo(db, dataDir, join(import.meta.dirname, '..', 'seed'));
  const engine = createEngine(db, () => {});
  let clock = T0;
  const status = createSystemStatus({
    db,
    dataDir,
    version: '9.9.9',
    now: () => clock,
    startedAt: T0 - (over.startedAgoMs ?? 1000),
    lastTickAt: () => T0 - (over.tickAgeMs ?? 500),
    disk: () => ({ freeBytes: (over.freeGb ?? 100) * 1024 ** 3, totalBytes: 500 * 1024 ** 3 }),
    brokerClients: () => 3,
    snapshotsBytes: () => 1234,
    notificationChannels: () => ({ channels: over.channels ?? 2, failedLast24h: over.failed ?? 0, sentLast24h: 5 }),
    backup: {
      everyH: over.backupEveryH ?? 24,
      dir: '/sauvegardes',
      last: () => over.backup ?? { at: T0 - H, ok: true, name: 'psim-x', bytes: 10, error: null },
      count: () => 4,
    },
  });
  return { db, engine, status, advance: (ms: number) => void (clock += ms) };
}

describe('sante (/healthz)', () => {
  it('ok quand la base repond et que la boucle de controle tourne', () => {
    assert.deepEqual(setup().status.health(), { ok: true });
  });

  it("degradee si la boucle de controle est bloquee : sans elle, plus de detecteur muet ni d'escalade", () => {
    const h = setup({ tickAgeMs: 30_000 }).status.health();
    assert.equal(h.ok, false);
    assert.match(h.reason ?? '', /boucle de controle bloquee depuis 30 s/);
  });

  it('degradee si la base est inaccessible', () => {
    const t = setup();
    t.db.close();
    const h = t.status.health();
    assert.equal(h.ok, false);
    assert.match(h.reason ?? '', /base de donnees/);
  });
});

describe('etat systeme (administrateur)', () => {
  it("decrit le PSIM : version, uptime, base, broker, detecteurs, incidents, sauvegardes", () => {
    const t = setup();
    t.engine.handleDetectorMessage('D-01', { state: 'alarm' });
    t.engine.handleDetectorMessage('D-02', { state: 'offline' });
    const d = t.status.detail();
    assert.equal(d.version, '9.9.9');
    assert.equal(d.brokerClients, 3);
    assert.equal(d.openIncidents, 1);
    assert.equal(d.detectors.alarm, 1);
    assert.equal(d.detectors.offline, 1);
    assert.equal(d.backup.count, 4);
    assert.equal(d.backup.dir, '/sauvegardes');
    assert.ok(d.database.bytes > 0);
    assert.equal(d.disk?.freeBytes, 100 * 1024 ** 3);
  });

  it('ne signale rien quand tout va bien... sauf un detecteur hors service', () => {
    const t = setup();
    assert.deepEqual(t.status.detail().warnings, []);
    t.engine.handleDetectorMessage('D-03', { state: 'fault' });
    assert.match(t.status.detail().warnings.map((w) => w.message).join(' '), /1 detecteur\(s\) hors service/);
  });

  it('alerte si aucun canal de notification, ou des notifications en echec', () => {
    assert.match(setup({ channels: 0 }).status.detail().warnings.map((w) => w.message).join(' '), /Aucun canal de notification/);
    assert.match(setup({ failed: 3 }).status.detail().warnings.map((w) => w.message).join(' '), /3 notification\(s\) en echec/);
  });

  it("alerte, en critique, si la derniere sauvegarde a echoue ou est trop ancienne", () => {
    const failed = setup({ backup: { at: T0 - H, ok: false, name: null, bytes: null, error: 'disque plein' } }).status.detail().warnings;
    assert.ok(failed.some((w) => w.level === 'critique' && /a echoue : disque plein/.test(w.message)));
    const stale = setup({ backup: { at: T0 - 60 * H, ok: true, name: 'x', bytes: 1, error: null } }).status.detail().warnings;
    assert.ok(stale.some((w) => w.level === 'critique' && /il y a 60 h/.test(w.message)));
    const never = setup({ backup: { at: null, ok: null, name: null, bytes: null, error: null }, startedAgoMs: 72 * H }).status.detail().warnings;
    assert.ok(never.some((w) => /Aucune sauvegarde depuis le demarrage/.test(w.message)));
  });

  it("ne crie pas a l'absence de sauvegarde juste apres le demarrage", () => {
    const w = setup({ backup: { at: null, ok: null, name: null, bytes: null, error: null }, startedAgoMs: 60_000 }).status.detail().warnings;
    assert.ok(!w.some((x) => /Aucune sauvegarde/.test(x.message)));
  });

  it('rappelle de planifier les sauvegardes quand l\'automatique est coupee', () => {
    assert.match(setup({ backupEveryH: 0 }).status.detail().warnings.map((w) => w.message).join(' '), /Sauvegarde automatique desactivee/);
  });
});

describe('espace disque', () => {
  const msg = (freeGb: number) => setup({ freeGb }).status.detail().warnings;
  it('alerte sur un espace ABSOLU faible, pas sur un pourcentage', () => {
    assert.deepEqual(msg(42.7), [], '42 Go libres sur un gros disque : aucune alerte');
    assert.equal(msg(1.5)[0].level, 'attention');
    assert.match(msg(1.5)[0].message, /1\.5 Go libres/);
    assert.equal(msg(0.3)[0].level, 'critique');
  });
});

describe('mot de passe (set-password)', () => {
  it('refuse les mots de passe faibles et accepte un bon', () => {
    assert.match(validatePassword('court', 'admin') ?? '', /trop court/);
    assert.match(validatePassword('admin-dev-only', 'admin') ?? '', /demonstration/);
    assert.match(validatePassword('xxxxxxxxxxxxxx', 'bob') ?? '', /repete/);
    assert.match(validatePassword('operateur-12345', 'operateur') ?? '', /nom d'utilisateur/);
    assert.equal(validatePassword('Un-bon-mot-de-passe-7', 'operateur'), null);
  });
});
