import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createCameraHealth, tcpProbe } from '../server/camerahealth.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { beginHistory } from '../server/history.ts';
import { buildSiteSummary } from '../server/portal.ts';
import { seedDemo } from '../server/seed.ts';
import { createSystemStatus } from '../server/system.ts';

const T0 = new Date(2026, 5, 15, 12, 0, 0).getTime();
const MIN = 60_000;

/** Une base de demonstration ; les adresses listees dans `down` ne repondent pas. */
function setup() {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  let clock = T0;
  const engine = createEngine(db, () => {}, () => clock, { silentTimeoutMs: 0 });
  beginHistory(db, clock, null, null);
  const down = new Set<string>();
  const probes: string[] = [];
  const audits: { action: string; deviceId: string; details: string }[] = [];
  const health = createCameraHealth({
    db,
    everyMs: MIN,
    now: () => clock,
    probe: async (host, port) => {
      probes.push(`${host}:${port}`);
      return !down.has(`${host}:${port}`);
    },
    audit: (action, deviceId, details) => {
      audits.push({ action, deviceId, details });
      engine.audit('systeme', action, { deviceId, details });
    },
  });
  const source = (id: string, host: string, port = 554) =>
    db
      .prepare("INSERT INTO camera_source (device_id, kind, host, port) VALUES (?, 'rtsp', ?, ?) ON CONFLICT(device_id) DO UPDATE SET host = excluded.host, port = excluded.port")
      .run(id, host, port);
  /** Une serie de tests, une minute plus tard. */
  const tick = async () => {
    clock += MIN;
    await health.check();
  };
  return { db, engine, health, down, probes, audits, source, tick, now: () => clock, goTo: (t: number) => void (clock = t) };
}

const rowsOf = (db: ReturnType<typeof openDb>, id: string) =>
  db.prepare('SELECT state, started_at, ended_at FROM device_state_history WHERE device_id = ? ORDER BY id').all(id) as { state: string; started_at: number; ended_at: number | null }[];

describe('mesure de l etat des cameras', () => {
  it('une camera simulee (sans source) n est jamais testee et n a pas d historique', async () => {
    const t = setup();
    await t.tick();
    assert.deepEqual(t.probes, []);
    assert.deepEqual(rowsOf(t.db, 'C-01'), []);
  });

  it('premier test reussi : en service, sans rien ecrire au journal', async () => {
    const t = setup();
    t.source('C-01', '10.0.0.5');
    await t.tick();
    assert.deepEqual(rowsOf(t.db, 'C-01').map((r) => r.state), ['normal']);
    assert.deepEqual(t.audits, []);
  });

  it('hors ligne seulement apres 3 echecs de suite, date du premier echec, et une seule ligne au journal', async () => {
    const t = setup();
    t.source('C-01', '10.0.0.5');
    await t.tick();
    t.down.add('10.0.0.5:554');
    await t.tick();
    const firstFail = t.now();
    await t.tick();
    assert.deepEqual(rowsOf(t.db, 'C-01').map((r) => r.state), ['normal'], '2 echecs : un rate isole ne fait pas une panne');
    await t.tick();
    const rows = rowsOf(t.db, 'C-01');
    assert.deepEqual(rows.map((r) => r.state), ['normal', 'offline']);
    assert.equal(rows[1].started_at, firstFail, 'la panne commence au premier echec');
    assert.equal(rows[0].ended_at, firstFail);
    await t.tick();
    await t.tick();
    assert.deepEqual(t.audits.map((a) => a.action), ['camera_offline'], 'pas une ligne par minute');
  });

  it('un echec isole puis un succes : aucune panne', async () => {
    const t = setup();
    t.source('C-01', '10.0.0.5');
    await t.tick();
    t.down.add('10.0.0.5:554');
    await t.tick();
    await t.tick();
    t.down.clear();
    await t.tick();
    t.down.add('10.0.0.5:554');
    await t.tick();
    await t.tick();
    assert.deepEqual(rowsOf(t.db, 'C-01').map((r) => r.state), ['normal'], 'la serie d echecs repart de zero apres un succes');
  });

  it('retour en service au premier succes, note au journal', async () => {
    const t = setup();
    t.source('C-01', '10.0.0.5');
    t.down.add('10.0.0.5:554');
    for (let i = 0; i < 3; i++) await t.tick();
    t.down.clear();
    await t.tick();
    assert.deepEqual(rowsOf(t.db, 'C-01').map((r) => r.state), ['offline', 'normal']);
    assert.deepEqual(t.audits.map((a) => a.action), ['camera_offline', 'camera_online']);
  });

  it('les voies d un meme enregistreur sont testees une seule fois et tombent ensemble', async () => {
    const t = setup();
    t.source('C-01', '10.0.0.9');
    t.source('C-02', '10.0.0.9');
    t.source('C-03', '10.0.0.10');
    await t.tick();
    assert.deepEqual(t.probes.sort(), ['10.0.0.10:554', '10.0.0.9:554']);
    t.down.add('10.0.0.9:554');
    for (let i = 0; i < 3; i++) await t.tick();
    assert.equal(rowsOf(t.db, 'C-01').at(-1)!.state, 'offline');
    assert.equal(rowsOf(t.db, 'C-02').at(-1)!.state, 'offline');
    assert.equal(rowsOf(t.db, 'C-03').at(-1)!.state, 'normal');
  });

  it('une adresse modifiee repart de zero (les echecs de l ancienne ne comptent pas)', async () => {
    const t = setup();
    t.source('C-01', '10.0.0.5');
    await t.tick();
    t.down.add('10.0.0.5:554');
    t.down.add('10.0.0.6:554');
    await t.tick();
    await t.tick();
    t.source('C-01', '10.0.0.6');
    await t.tick();
    assert.deepEqual(rowsOf(t.db, 'C-01').map((r) => r.state), ['normal']);
  });

  it('une camera repassee en simulee cesse d etre mesuree : son etat en cours est clos', async () => {
    const t = setup();
    t.source('C-01', '10.0.0.5');
    await t.tick();
    t.db.prepare('DELETE FROM camera_source WHERE device_id = ?').run('C-01');
    await t.tick();
    const rows = rowsOf(t.db, 'C-01');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ended_at, t.now());
  });

  it('au redemarrage, une camera reprend son dernier etat mesure ; une camera jamais mesuree n a rien', async () => {
    const t = setup();
    t.source('C-01', '10.0.0.5');
    t.source('C-02', '10.0.0.6');
    t.down.add('10.0.0.5:554');
    for (let i = 0; i < 3; i++) await t.tick();
    const stoppedAt = t.now();
    t.source('C-03', '10.0.0.7'); // ajoutee juste avant l'arret, jamais testee
    const restart = stoppedAt + 30 * MIN;
    beginHistory(t.db, restart, stoppedAt, { from: stoppedAt, to: restart, clean: false });
    const c1 = rowsOf(t.db, 'C-01');
    assert.equal(c1.at(-2)!.ended_at, stoppedAt, 'clos au dernier signe de vie : l arret n est pas compte comme une panne');
    assert.deepEqual([c1.at(-1)!.state, c1.at(-1)!.started_at, c1.at(-1)!.ended_at], ['offline', restart, null]);
    assert.equal(rowsOf(t.db, 'C-02').at(-1)!.state, 'normal');
    assert.deepEqual(rowsOf(t.db, 'C-03'), []);
  });

  it('ne modifie pas l etat affiche dans l ecran du PSIM', async () => {
    const t = setup();
    t.source('C-01', '10.0.0.5');
    t.down.add('10.0.0.5:554');
    for (let i = 0; i < 3; i++) await t.tick();
    assert.equal(t.engine.getDevice('C-01')!.status, 'normal');
  });

  it('l ecran Systeme previent quand une camera ne repond plus, avec son nom', async () => {
    const t = setup();
    t.source('C-01', '10.0.0.5');
    t.source('C-02', '10.0.0.6');
    t.down.add('10.0.0.5:554');
    for (let i = 0; i < 3; i++) await t.tick();
    assert.deepEqual(t.health.status(), { enabled: true, measured: 2, offline: ['Camera accueil'] });
    const system = createSystemStatus({
      db: t.db,
      dataDir: mkdtempSync(join(tmpdir(), 'psim-')),
      version: 'test',
      now: t.now,
      startedAt: t.now(),
      lastTickAt: t.now,
      disk: () => ({ freeBytes: 100 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 }),
      brokerClients: () => 0,
      snapshotsBytes: () => 0,
      notificationChannels: () => ({ channels: 1, failedLast24h: 0, sentLast24h: 0 }),
      backup: { everyH: 0, dir: '', last: () => ({ at: null, ok: null, name: null, bytes: null, error: null }), count: () => 0 },
      cameras: () => t.health.status(),
    });
    const warnings = system.detail().warnings.map((w) => w.message);
    assert.ok(warnings.some((m) => /1 camera\(s\) ne repondent plus.*Camera accueil/.test(m)), warnings.join(' | '));
  });
});

describe('cameras dans le resume envoye au portail', () => {
  it('une camera mesuree est suivie (etat mesure, panne, disponibilite) ; une camera simulee reste « non mesuree »', async () => {
    const t = setup();
    t.source('C-01', '10.0.0.5');
    await t.tick();
    t.down.add('10.0.0.5:554');
    for (let i = 0; i < 3; i++) await t.tick();
    t.goTo(t.now() + 60 * MIN);
    const s = buildSiteSummary(t.db, { siteId: 'site-test', version: 'x', startedAt: T0, now: t.now() });
    const c1 = s.devices.find((d) => d.id === 'C-01')!;
    assert.equal(c1.monitored, true);
    assert.equal(c1.status, 'offline', 'l etat mesure, pas celui de l ecran');
    assert.equal(s.devices.find((d) => d.id === 'C-02')!.monitored, false);
    assert.ok(s.outages.some((o) => o.deviceId === 'C-01' && o.to === null && o.cause === 'offline'));
    const a = s.availability.byDevice.find((d) => d.deviceId === 'C-01')!;
    assert.ok(a.downS > 0 && a.upS > 0 && a.pct !== null && a.pct < 100);
    assert.ok(!s.availability.byDevice.some((d) => d.deviceId === 'C-02'), 'aucun pourcentage invente');
    assert.ok(!JSON.stringify(s).includes('10.0.0.5'), 'l adresse de la camera ne sort jamais');
  });

  it('une camera reelle pas encore testee n est pas suivie (aucun etat invente)', () => {
    const t = setup();
    t.source('C-01', '10.0.0.5');
    const s = buildSiteSummary(t.db, { siteId: 'site-test', version: 'x', startedAt: T0, now: t.now() });
    assert.equal(s.devices.find((d) => d.id === 'C-01')!.monitored, false);
  });
});

describe('test de connexion reel', () => {
  it('vrai si le port repond, faux sinon (sans lever d exception)', async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    assert.equal(await tcpProbe('127.0.0.1', port, 2000), true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(await tcpProbe('127.0.0.1', port, 2000), false);
    assert.equal(await tcpProbe('nom-qui-n-existe-pas.invalid', 554, 2000), false);
  });
});
