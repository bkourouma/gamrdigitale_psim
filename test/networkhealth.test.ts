import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { beginHistory } from '../server/history.ts';
import { cleanHost, cleanPort, createNetworkHealth, createNetworkTargets } from '../server/networkhealth.ts';
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
  const probe = async (host: string, port: number) => {
    probes.push(`${host}:${port}`);
    return !down.has(`${host}:${port}`);
  };
  const health = createNetworkHealth({
    db,
    everyMs: MIN,
    now: () => clock,
    probe,
    audit: (action, deviceId, details) => {
      audits.push({ action, deviceId, details });
      engine.audit('systeme', action, { deviceId, details });
    },
  });
  const targets = createNetworkTargets({ db, now: () => clock, probe, audit: (actor, action, ref) => engine.audit(actor, action, ref) });
  /** Un equipement reseau tel que l'ajoute l'administrateur : detecteur, categorie environnement. */
  const device = (id: string, name = `Routeur ${id}`, category = 'environment') =>
    engine.createDevice('admin', { id, kind: 'detector', name, zone: 'Local technique', category });
  const target = (id: string, host: string, port = 443) => targets.set('admin', id, { host, port });
  const tick = async () => {
    clock += MIN;
    await health.check();
  };
  return { db, engine, health, targets, down, probes, audits, device, target, tick, now: () => clock, goTo: (t: number) => void (clock = t) };
}

const rowsOf = (db: ReturnType<typeof openDb>, id: string) =>
  db.prepare('SELECT state, started_at, ended_at FROM device_state_history WHERE device_id = ? ORDER BY id').all(id) as { state: string; started_at: number; ended_at: number | null }[];

describe('validation de la cible reseau', () => {
  it('adresse : IPv4 ou nom de machine, rien d autre', () => {
    for (const ok of ['192.168.1.1', 'routeur-4g', 'switch.local', ' 10.0.0.2 ', 'a']) assert.doesNotThrow(() => cleanHost(ok), ok);
    for (const bad of ['', '  ', 'http://10.0.0.1', '10.0.0.1/admin', '10.0.0.1:80', 'a b', '-x', 'x-', 'a;b', "x'y", '..', '10.0.0.\u00001', 'a'.repeat(254), 42, null, undefined, {}]) {
      assert.throws(() => cleanHost(bad), /Adresse/, String(bad));
    }
  });

  it('port : entier de 1 a 65535 seulement', () => {
    assert.equal(cleanPort(1), 1);
    assert.equal(cleanPort(65535), 65535);
    assert.equal(cleanPort('443'), 443);
    for (const bad of [0, -1, 65536, 80.5, '80abc', '0x50', '', ' ', '1e2', '123456', NaN, Infinity, null, undefined, true, {}, [80]]) {
      assert.throws(() => cleanPort(bad), /Port invalide/, String(bad));
    }
  });
});

describe('cible reseau d un equipement', () => {
  it('refuse un equipement inconnu, une camera, une autre categorie, un detecteur lu sur un enregistreur', () => {
    const t = setup();
    assert.throws(() => t.target('NOPE', '10.0.0.1'), /introuvable/);
    assert.throws(() => t.target('C-01', '10.0.0.1'), /introuvable/, 'une camera a sa propre source');
    t.device('N-FIRE', 'Detecteur', 'fire');
    assert.throws(() => t.target('N-FIRE', '10.0.0.1'), /Environnement/);
    t.device('N-1');
    t.db.prepare("INSERT INTO detector_source (device_id, kind, camera_id, channel, events) VALUES ('N-1', 'dahua', 'C-01', 1, '[]')").run();
    assert.throws(() => t.target('N-1', '10.0.0.1'), /enregistreur/);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM network_target').get()!.n, 0);
  });

  it('refuse une saisie invalide et n ecrit rien', () => {
    const t = setup();
    t.device('N-1');
    assert.throws(() => t.targets.set('admin', 'N-1', { host: 'http://x', port: 80 }), /Adresse invalide/);
    assert.throws(() => t.targets.set('admin', 'N-1', { host: '10.0.0.1', port: 70000 }), /Port invalide/);
    assert.throws(() => t.targets.set('admin', 'N-1', { host: '10.0.0.1' }), /Port invalide/, 'pas de port par defaut : on teste ce qui est ecoute');
    assert.equal(t.targets.view('N-1'), null);
  });

  it('l etat « normal » ecrit a la creation n est pas une mesure : un equipement jamais teste n a aucun etat', async () => {
    const t = setup();
    t.device('N-1');
    assert.deepEqual(rowsOf(t.db, 'N-1').map((r) => r.state), ['normal'], 'avant : etat de creation');
    t.target('N-1', '10.0.0.1');
    assert.deepEqual(rowsOf(t.db, 'N-1'), [], 'apres : jamais teste = aucun etat');
    assert.deepEqual(t.targets.view('N-1'), { host: '10.0.0.1', port: 443, state: null, since: null });
    // Meme apres un redemarrage du PSIM : l'etat n'est pas reinvente.
    beginHistory(t.db, t.now() + MIN, t.now(), null);
    assert.deepEqual(rowsOf(t.db, 'N-1'), []);
    const s = buildSiteSummary(t.db, { siteId: 'site-test', version: 'x', startedAt: T0, now: t.now() });
    const n = s.devices.find((d) => d.id === 'N-1')!;
    assert.equal(n.monitored, false, 'le portail ne l affiche pas « en service »');
    assert.ok(!s.availability.byDevice.some((d) => d.deviceId === 'N-1'), 'aucun pourcentage invente');
  });

  it('un equipement qui avait parle garde son historique, clos a l enregistrement de la cible', () => {
    const t = setup();
    t.device('N-1');
    t.db.prepare('UPDATE device SET last_seen = ? WHERE id = ?').run(T0, 'N-1');
    t.goTo(T0 + 5 * MIN);
    t.target('N-1', '10.0.0.1');
    const rows = rowsOf(t.db, 'N-1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ended_at, T0 + 5 * MIN);
  });

  it('modifier la cible ne redonne pas un etat a un equipement jamais teste', () => {
    const t = setup();
    t.device('N-1');
    t.target('N-1', '10.0.0.1');
    t.target('N-1', '10.0.0.2', 80);
    assert.deepEqual(rowsOf(t.db, 'N-1'), []);
    assert.equal(t.targets.view('N-1')!.host, '10.0.0.2');
  });

  it('retrait : l equipement redevient un detecteur ordinaire ; retirer deux fois = 404', async () => {
    const t = setup();
    t.device('N-1');
    t.target('N-1', '10.0.0.1');
    t.down.add('10.0.0.1:443');
    for (let i = 0; i < 3; i++) await t.tick();
    assert.equal(rowsOf(t.db, 'N-1').at(-1)!.state, 'offline');
    t.targets.remove('admin', 'N-1');
    assert.equal(t.targets.view('N-1'), null);
    const rows = rowsOf(t.db, 'N-1');
    assert.deepEqual(rows.map((r) => r.state), ['offline', 'normal'], 'reprend l etat de l ecran (device.status)');
    assert.throws(() => t.targets.remove('admin', 'N-1'), /Aucune supervision/);
    // Plus rien n'est teste.
    t.probes.length = 0;
    await t.tick();
    assert.deepEqual(t.probes, []);
  });

  it('suppression de l equipement : sa cible disparait avec lui', () => {
    const t = setup();
    t.device('N-1');
    t.target('N-1', '10.0.0.1');
    t.engine.deleteDevice('admin', 'N-1');
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM network_target').get()!.n, 0);
  });

  it('le journal ne contient jamais l adresse', async () => {
    const t = setup();
    t.device('N-1');
    t.target('N-1', '10.77.88.99', 8443);
    t.down.add('10.77.88.99:8443');
    for (let i = 0; i < 3; i++) await t.tick();
    t.down.clear();
    await t.tick();
    t.targets.remove('admin', 'N-1');
    const journal = JSON.stringify(t.db.prepare('SELECT action, details FROM audit_log').all());
    assert.ok(journal.includes('network_offline') && journal.includes('network_online') && journal.includes('network_target_updated'));
    assert.ok(!journal.includes('10.77.88.99'), journal);
  });
});

describe('mesure de l etat des equipements reseau', () => {
  it('premier test reussi : en service, sans rien ecrire au journal ; le port choisi est celui qui est teste', async () => {
    const t = setup();
    t.device('N-1');
    t.target('N-1', '10.0.0.1', 161);
    await t.tick();
    assert.deepEqual(rowsOf(t.db, 'N-1').map((r) => r.state), ['normal']);
    assert.deepEqual(t.probes, ['10.0.0.1:161']);
    assert.deepEqual(t.audits, []);
  });

  it('hors ligne seulement apres 3 echecs de suite, date du premier echec, une seule ligne au journal', async () => {
    const t = setup();
    t.device('N-1');
    t.target('N-1', '10.0.0.1');
    await t.tick();
    t.down.add('10.0.0.1:443');
    await t.tick();
    const firstFail = t.now();
    await t.tick();
    assert.deepEqual(rowsOf(t.db, 'N-1').map((r) => r.state), ['normal'], '2 echecs : un rate isole ne fait pas une panne');
    await t.tick();
    const rows = rowsOf(t.db, 'N-1');
    assert.deepEqual(rows.map((r) => r.state), ['normal', 'offline']);
    assert.equal(rows[1].started_at, firstFail, 'la panne commence au premier echec');
    assert.equal(rows[0].ended_at, firstFail);
    await t.tick();
    await t.tick();
    assert.deepEqual(t.audits.map((a) => a.action), ['network_offline'], 'pas une ligne par minute');
  });

  it('jamais teste puis 3 echecs : hors ligne, date du premier echec (pas de « normal » invente avant)', async () => {
    const t = setup();
    t.device('N-1');
    t.target('N-1', '10.0.0.1');
    t.down.add('10.0.0.1:443');
    await t.tick();
    const firstFail = t.now();
    await t.tick();
    await t.tick();
    const rows = rowsOf(t.db, 'N-1');
    assert.deepEqual(rows.map((r) => r.state), ['offline']);
    assert.equal(rows[0].started_at, firstFail);
  });

  it('un echec isole puis un succes : aucune panne', async () => {
    const t = setup();
    t.device('N-1');
    t.target('N-1', '10.0.0.1');
    await t.tick();
    t.down.add('10.0.0.1:443');
    await t.tick();
    await t.tick();
    t.down.clear();
    await t.tick();
    t.down.add('10.0.0.1:443');
    await t.tick();
    await t.tick();
    assert.deepEqual(rowsOf(t.db, 'N-1').map((r) => r.state), ['normal'], 'la serie d echecs repart de zero apres un succes');
  });

  it('retour en service au premier succes, note au journal', async () => {
    const t = setup();
    t.device('N-1');
    t.target('N-1', '10.0.0.1');
    t.down.add('10.0.0.1:443');
    for (let i = 0; i < 3; i++) await t.tick();
    t.down.clear();
    await t.tick();
    assert.deepEqual(rowsOf(t.db, 'N-1').map((r) => r.state), ['offline', 'normal']);
    assert.deepEqual(t.audits.map((a) => a.action), ['network_offline', 'network_online']);
  });

  it('un seul essai par adresse et port ; deux ports d un meme hote sont deux essais', async () => {
    const t = setup();
    t.device('N-1');
    t.device('N-2');
    t.device('N-3');
    t.target('N-1', '10.0.0.9', 443);
    t.target('N-2', '10.0.0.9', 443);
    t.target('N-3', '10.0.0.9', 22);
    await t.tick();
    assert.deepEqual(t.probes.sort(), ['10.0.0.9:22', '10.0.0.9:443']);
    t.down.add('10.0.0.9:443');
    for (let i = 0; i < 3; i++) await t.tick();
    assert.equal(rowsOf(t.db, 'N-1').at(-1)!.state, 'offline');
    assert.equal(rowsOf(t.db, 'N-2').at(-1)!.state, 'offline');
    assert.equal(rowsOf(t.db, 'N-3').at(-1)!.state, 'normal');
  });

  it('une adresse ou un port modifie repart de zero (les echecs de l ancienne cible ne comptent pas)', async () => {
    const t = setup();
    t.device('N-1');
    t.target('N-1', '10.0.0.1');
    await t.tick();
    t.down.add('10.0.0.1:443');
    t.down.add('10.0.0.1:80');
    await t.tick();
    await t.tick();
    t.target('N-1', '10.0.0.1', 80);
    await t.tick();
    assert.deepEqual(rowsOf(t.db, 'N-1').map((r) => r.state), ['normal']);
  });

  it('au redemarrage, l equipement reprend son dernier etat mesure ; celui jamais teste n a rien', async () => {
    const t = setup();
    t.device('N-1');
    t.device('N-2');
    t.device('N-3');
    t.target('N-1', '10.0.0.1');
    t.target('N-2', '10.0.0.2');
    t.down.add('10.0.0.1:443');
    for (let i = 0; i < 3; i++) await t.tick();
    const stoppedAt = t.now();
    t.target('N-3', '10.0.0.3'); // ajoute juste avant l'arret, jamais teste
    const restart = stoppedAt + 30 * MIN;
    beginHistory(t.db, restart, stoppedAt, { from: stoppedAt, to: restart, clean: false });
    const n1 = rowsOf(t.db, 'N-1');
    assert.equal(n1.at(-2)!.ended_at, stoppedAt, 'clos au dernier signe de vie : l arret n est pas compte comme une panne');
    assert.deepEqual([n1.at(-1)!.state, n1.at(-1)!.started_at, n1.at(-1)!.ended_at], ['offline', restart, null]);
    assert.equal(rowsOf(t.db, 'N-2').at(-1)!.state, 'normal');
    assert.deepEqual(rowsOf(t.db, 'N-3'), []);
  });

  it('ne modifie pas l etat affiche dans l ecran du PSIM', async () => {
    const t = setup();
    t.device('N-1');
    t.target('N-1', '10.0.0.1');
    t.down.add('10.0.0.1:443');
    for (let i = 0; i < 3; i++) await t.tick();
    assert.equal(t.engine.getDevice('N-1')!.status, 'normal');
  });

  it('le moteur ne le declare pas « muet » (aucun message n est attendu d un equipement reseau)', () => {
    const db = openDb(':memory:');
    seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
    let clock = T0;
    const engine = createEngine(db, () => {}, () => clock, { silentTimeoutMs: 60_000 });
    engine.createDevice('admin', { id: 'N-1', kind: 'detector', name: 'Routeur', zone: 'Z', category: 'environment' });
    createNetworkTargets({ db, audit: () => {} }).set('admin', 'N-1', { host: '10.0.0.1', port: 443 });
    clock += 10 * 60_000;
    engine.checkSilentDetectors();
    assert.equal(engine.getDevice('N-1')!.status, 'normal');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'detector_silent' AND device_id = 'N-1'").get()!.n, 0);
  });
});

describe('arret propre et configuration', () => {
  it('start lance un test immediat puis periodique ; stop arrete tout, et start est sans effet si le delai est 0', async () => {
    const db = openDb(':memory:');
    seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
    const engine = createEngine(db, () => {}, Date.now, { silentTimeoutMs: 0 });
    engine.createDevice('admin', { id: 'N-1', kind: 'detector', name: 'Routeur', zone: 'Z', category: 'environment' });
    createNetworkTargets({ db, audit: () => {} }).set('admin', 'N-1', { host: '10.0.0.1', port: 443 });
    let count = 0;
    const make = (everyMs: number) => createNetworkHealth({ db, everyMs, audit: () => {}, probe: async () => (count++, true) });
    const off = make(0);
    off.start();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(count, 0, 'delai 0 = coupe');
    assert.equal(off.status().enabled, false);

    const on = make(20);
    on.start();
    on.start(); // un second demarrage ne double pas le minuteur
    await new Promise((r) => setTimeout(r, 130));
    on.stop();
    const stopped = count;
    assert.ok(stopped >= 3 && stopped <= 9, `periodique, un seul minuteur (${stopped} tests)`);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(count, stopped, 'plus aucun test apres stop');
    on.stop(); // sans effet
  });

  it('une serie ne se chevauche jamais avec la suivante, et une sonde qui echoue ne leve rien', async () => {
    const db = openDb(':memory:');
    seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
    const engine = createEngine(db, () => {}, Date.now, { silentTimeoutMs: 0 });
    engine.createDevice('admin', { id: 'N-1', kind: 'detector', name: 'Routeur', zone: 'Z', category: 'environment' });
    createNetworkTargets({ db, audit: () => {} }).set('admin', 'N-1', { host: '10.0.0.1', port: 443 });
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const health = createNetworkHealth({ db, everyMs: 1000, audit: () => {}, probe: async () => (started++, await gate, true) });
    const first = health.check();
    void health.check();
    assert.equal(started, 1, 'la seconde serie attend la premiere');
    release();
    await first;
    const failing = createNetworkHealth({ db, everyMs: 1000, audit: () => {}, probe: async () => Promise.reject(new Error('boum')) });
    await assert.doesNotReject(() => failing.check());
  });

  it('base ancienne : sans la table network_target, la migration la cree et garde les donnees', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-'));
    const path = join(dir, 'psim.db');
    const first = openDb(path);
    seedDemo(first, dir, join(import.meta.dirname, '..', 'seed'));
    first.exec('DROP TABLE network_target');
    first.close();
    const db = openDb(path);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'network_target'").get()!.n, 1);
    assert.ok((db.prepare('SELECT COUNT(*) AS n FROM device').get() as { n: number }).n > 0, 'les equipements existants sont conserves');
    openDb(path).close(); // idempotente
    // La contrainte de port tient au niveau de la base.
    assert.throws(() => db.prepare("INSERT INTO network_target (device_id, host, port) VALUES ('E-01', 'x', 70000)").run());
    db.close();
  });
});

describe('ecran Systeme et portail', () => {
  const systemOf = (t: ReturnType<typeof setup>) =>
    createSystemStatus({
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
      network: () => t.health.status(),
    });

  it('un seul avertissement groupe liste tous les equipements reseau hors ligne', async () => {
    const t = setup();
    t.device('N-1', 'Routeur 4G');
    t.device('N-2', 'Switch PoE');
    t.device('N-3', 'Point d acces');
    t.target('N-1', '10.0.0.1');
    t.target('N-2', '10.0.0.2');
    t.target('N-3', '10.0.0.3');
    t.down.add('10.0.0.1:443');
    t.down.add('10.0.0.2:443');
    for (let i = 0; i < 3; i++) await t.tick();
    assert.deepEqual(t.health.status(), { enabled: true, measured: 3, offline: ['Routeur 4G', 'Switch PoE'] });
    const warnings = systemOf(t).detail().warnings.map((w) => w.message).filter((m) => /equipement\(s\) reseau/.test(m));
    assert.equal(warnings.length, 1, warnings.join(' | '));
    assert.match(warnings[0], /2 equipement\(s\) reseau.*Routeur 4G.*Switch PoE/);
    assert.ok(!warnings[0].includes('10.0.0.'), 'jamais l adresse');
  });

  it('aucun avertissement quand tout repond', async () => {
    const t = setup();
    t.device('N-1');
    t.target('N-1', '10.0.0.1');
    await t.tick();
    assert.ok(!systemOf(t).detail().warnings.some((w) => /reseau/.test(w.message)));
  });

  it('portail : un equipement reseau mesure est suivi (etat mesure, panne, disponibilite) comme un detecteur', async () => {
    const t = setup();
    t.device('N-1', 'Routeur 4G');
    t.target('N-1', '10.0.0.1');
    await t.tick();
    t.down.add('10.0.0.1:443');
    for (let i = 0; i < 3; i++) await t.tick();
    t.goTo(t.now() + 60 * MIN);
    const s = buildSiteSummary(t.db, { siteId: 'site-test', version: 'x', startedAt: T0, now: t.now() });
    const n = s.devices.find((d) => d.id === 'N-1')!;
    assert.equal(n.monitored, true);
    assert.equal(n.kind, 'detector');
    assert.equal(n.status, 'offline', 'l etat mesure, pas celui de l ecran (normal)');
    assert.ok(s.outages.some((o) => o.deviceId === 'N-1' && o.to === null && o.cause === 'offline'));
    const a = s.availability.byDevice.find((d) => d.deviceId === 'N-1')!;
    assert.ok(a.downS > 0 && a.upS > 0 && a.pct !== null && a.pct < 100);
    assert.ok(!JSON.stringify(s).includes('10.0.0.1'), 'l adresse ne sort jamais');
  });

  it('portail : les autres detecteurs restent suivis comme avant', () => {
    const t = setup();
    const s = buildSiteSummary(t.db, { siteId: 'site-test', version: 'x', startedAt: T0, now: t.now() });
    const detectors = s.devices.filter((d) => d.kind === 'detector');
    assert.ok(detectors.length > 0 && detectors.every((d) => d.monitored));
  });
});
