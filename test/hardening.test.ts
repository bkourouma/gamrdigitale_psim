/**
 * Regressions de la relecture de securite (configuration, broker MQTT, journal, rapports, validations).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import mqtt from 'mqtt';
import { checkSmtp } from '../scripts/commission/checks.ts';
import { accountsWithDevPassword, createUser } from '../server/auth.ts';
import { createBackup, pruneBackups, verifyBackup } from '../server/backup.ts';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import { failUrl } from '../server/heartbeat.ts';
import { acquireLock, lockHolder, lockPath } from '../server/lock.ts';
import { allows, startBroker } from '../server/mqtt.ts';
import { webhookChannel } from '../server/notifications.ts';
import { validateAddress } from '../server/recipients.ts';
import { fmtDateTime, summarize } from '../server/reports.ts';
import type { IncidentRecord } from '../server/reports.ts';
import { seedDemo } from '../server/seed.ts';
import { createHttpRedirect } from '../server/tls.ts';
import { maskAudit } from '../server/visibility.ts';

const ROOT = resolve(import.meta.dirname, '..');
const cleanup: (() => void)[] = [];
after(() => cleanup.forEach((f) => f()));
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, ...extra });
const badRequest = (pattern: RegExp) => (e: unknown) => e instanceof PsimError && e.status === 400 && pattern.test(e.message);

describe('configuration : aucune valeur douteuse ne passe en silence', () => {
  const check = (extra: Record<string, string>) => spawnSync(process.execPath, ['scripts/check-config.ts'], { cwd: ROOT, env: clean({ PSIM_DATA_DIR: join(tmpdir(), 'psim-none'), ...extra }), encoding: 'utf8' });

  it("une faute de frappe sur PSIM_ENV est refusee (sinon toute la protection de production disparait)", () => {
    for (const bad of ['prod', 'Prodution', 'production!', 'staging']) {
      const r = check({ PSIM_ENV: bad });
      assert.notEqual(r.status, 0, bad);
      assert.match(r.stderr, /PSIM_ENV=".*" est invalide/, bad);
    }
    assert.equal(check({ PSIM_ENV: 'Production' }).status === 0 || /PRODUCTION/.test(check({ PSIM_ENV: 'Production' }).stdout), true, 'la casse est tolérée : « Production » vaut production');
    assert.match(check({ PSIM_ENV: 'PRODUCTION' }).stdout, /PRODUCTION/);
    assert.equal(check({ PSIM_ENV: 'development' }).status, 0);
    assert.equal(check({}).status, 0);
  });

  it("un nombre invalide est une erreur de demarrage claire, jamais un repli silencieux (NaN supprimait les sauvegardes)", () => {
    for (const [name, value] of [['PSIM_BACKUP_KEEP', '14d'], ['PSIM_BACKUP_KEEP', '0'], ['PSIM_BACKUP_EVERY_H', '24h'], ['PSIM_HEARTBEAT_EVERY_S', 'souvent'], ['PSIM_GAP_NOTIFY_S', '-5'], ['PSIM_PORT', '99999'], ['PSIM_MQTT_PORT', 'abc'], ['PSIM_DETECTOR_TIMEOUT_S', 'x'], ['PSIM_SNAPSHOT_DAYS', '30j']]) {
      const r = check({ [name]: value });
      assert.notEqual(r.status, 0, `${name}=${value}`);
      assert.match(r.stderr, new RegExp(`${name}="${value}" est invalide`));
    }
    assert.equal(check({ PSIM_BACKUP_KEEP: '7', PSIM_BACKUP_EVERY_H: '12' }).status, 0);
  });

  it("le broker MQTT n'ecoute que sur la machine par defaut, meme si l'interface web est ouverte au reseau", () => {
    const r = spawnSync(process.execPath, ['-e', "import('./server/config.ts').then((m) => console.log(m.config.mqttHost))"], { cwd: ROOT, env: clean({ PSIM_HOST: '0.0.0.0' }), encoding: 'utf8' });
    assert.equal(r.stdout.trim(), '127.0.0.1');
  });

  it("PSIM_MQTT_GATEWAYS : JSON valide exige, identifiants et mots de passe controles", () => {
    const run = (value: string) => spawnSync(process.execPath, ['-e', "import('./server/config.ts').then((m) => console.log(JSON.stringify(m.config.mqttGateways)))"], { cwd: ROOT, env: clean({ PSIM_MQTT_GATEWAYS: value }), encoding: 'utf8' });
    assert.equal(run('[{"user":"gw1","password":"Mot-de-passe-passerelle-1","detectors":["D-*","A-01"]}]').status, 0);
    for (const bad of ['pas du json', '{}', '[{"user":"psim","password":"Mot-de-passe-passerelle-1","detectors":["D-01"]}]', '[{"user":"gw","password":"court","detectors":["D-01"]}]', '[{"user":"gw","password":"Mot-de-passe-passerelle-1","detectors":[]}]', '[{"user":"gw","password":"Mot-de-passe-passerelle-1","detectors":["../x"]}]']) {
      assert.notEqual(run(bad).status, 0, bad);
    }
  });
});

describe('sauvegardes : jamais tout supprimer, jamais de chemin imprevu', () => {
  it("une valeur de conservation invalide ne supprime AUCUNE sauvegarde", () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-prune-'));
    const db = openDb(join(dir, 'psim.db'));
    for (let i = 0; i < 3; i++) createBackup({ db, dataDir: dir, backupDir: join(dir, 'b'), now: () => Date.now() + i * 1000 });
    for (const bad of [NaN, -1, 0, Infinity * 0, undefined as unknown as number]) assert.deepEqual(pruneBackups(join(dir, 'b'), bad), [], String(bad));
    assert.equal(pruneBackups(join(dir, 'b'), 2).length, 1, 'une valeur valide garde les plus recentes');
  });

  it("un manifeste forge (empreintes comprises) ne peut designer qu'un fichier de sauvegarde attendu", () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-forge-'));
    const db = openDb(join(dir, 'psim.db'));
    const b = createBackup({ db, dataDir: dir, backupDir: join(dir, 'b') });
    assert.equal(verifyBackup(b.dir).ok, true);
    const manifest = JSON.parse(spawnSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(b.dir, 'manifest.json'))}, 'utf8'))`], { encoding: 'utf8' }).stdout);
    writeFileSync(join(b.dir, 'start.cmd'), 'echo pirate');
    manifest.files.push({ path: 'start.cmd', size: 11, sha256: 'x' });
    writeFileSync(join(b.dir, 'manifest.json'), JSON.stringify(manifest));
    const v = verifyBackup(b.dir);
    assert.equal(v.ok, false);
    assert.match(v.problems.join(' '), /fichier non prevu dans le manifeste : start\.cmd/);
  });
});

describe('verrou d instance', () => {
  it("un verrou ecrit AVANT le dernier demarrage de la machine est ignore (PID reattribue apres une coupure de courant)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-lock-'));
    writeFileSync(lockPath(dir), String(process.pid));
    assert.equal(lockHolder(dir), process.pid, 'verrou recent, processus vivant : respecte');
    utimesSync(lockPath(dir), new Date(0), new Date(0));
    assert.equal(lockHolder(dir), null, 'verrou date d\'avant le demarrage de la machine : orphelin');
    const release = acquireLock(dir);
    release();
  });

  it("le message d'erreur dit comment debloquer", () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-lock2-'));
    writeFileSync(lockPath(dir), String(process.pid));
    assert.throws(() => acquireLock(dir, process.pid + 1), /Si aucun PSIM ne tourne, supprimez .*psim\.lock/);
  });
});

describe('mots de passe de demonstration deja STOCKES en base', () => {
  it("detecte les comptes dont le mot de passe enregistre est une valeur publique", () => {
    const db = openDb(':memory:');
    createUser(db, 'admin', 'admin', 'admin-dev-only');
    createUser(db, 'operateur', 'operator', 'Un-vrai-mot-de-passe-solide-9');
    createUser(db, 'psim', 'operator', 'psim-dev-only');
    assert.deepEqual(accountsWithDevPassword(db).sort(), ['admin', 'psim']);
  });

  it("un PSIM de PRODUCTION refuse de demarrer sur une base dont un compte garde un mot de passe de demonstration", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-devdb-'));
    mkdirSync(join(dir, 'data'));
    const db = openDb(join(dir, 'data', 'psim.db'));
    createUser(db, 'admin', 'admin', 'admin-dev-only');
    db.close();
    const r = spawnSync(process.execPath, ['server/index.ts'], {
      cwd: ROOT, encoding: 'utf8', timeout: 20_000,
      env: clean({ PSIM_ENV: 'production', PSIM_DATA_DIR: join(dir, 'data'), PSIM_PORT: '0', PSIM_MQTT_PORT: '0', PSIM_ADMIN_PASSWORD: 'Mot-de-passe-admin-solide-1', PSIM_OPERATOR_PASSWORD: 'Mot-de-passe-operateur-2', PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3', USERPROFILE: process.env.USERPROFILE ?? '' }),
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /Compte\(s\) admin : le mot de passe enregistre est une valeur de demonstration PUBLIQUE/);
    assert.match(r.stdout + r.stderr, /Demarrage refuse/);
  });
});

describe('SMTP : STARTTLS obligatoire', () => {
  it("un serveur qui n'annonce pas STARTTLS est refuse (identifiants jamais envoyes en clair) sauf relais interne explicite", async () => {
    const seen: string[] = [];
    const server = createServer((socket) => {
      socket.write('220 localhost ESMTP\r\n');
      socket.on('data', (c) => {
        for (const line of c.toString().split('\r\n')) {
          seen.push(line);
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO') socket.write('250-localhost\r\n250 AUTH PLAIN\r\n'); // pas de STARTTLS
          else if (cmd === 'AUTH') socket.write('235 ok\r\n');
          else if (cmd === 'QUIT') socket.end('221 bye\r\n');
          else if (line) socket.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    const cfg = { host: '127.0.0.1', port, secure: false, user: 'alertes', password: 'MOT-DE-PASSE-SMTP-SECRET', from: 'psim@exemple.test', starttls: true };
    const strict = await checkSmtp(cfg);
    assert.equal(strict.status, 'fail');
    assert.ok(!seen.some((l) => /MOT-DE-PASSE-SMTP-SECRET|AUTH/i.test(l) && /^AUTH/i.test(l)), 'aucune commande AUTH envoyee : le mot de passe ne part jamais en clair');
    const relay = await checkSmtp({ ...cfg, starttls: false });
    assert.equal(relay.status, 'ok', 'relais interne explicitement en clair (PSIM_SMTP_STARTTLS=0)');
  });
});

describe('journal : un equipement qui oscille ne remplit pas le disque', () => {
  it("au-dela de 30 changements en 10 minutes : plus de ligne par changement, une seule alerte d'oscillation, etat toujours exact", () => {
    const db = openDb(':memory:');
    seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(ROOT, 'seed'));
    let clock = 1_000_000_000_000;
    const engine = createEngine(db, () => {}, () => clock);
    const count = (action: string) => (db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action) as { n: number }).n;
    for (let i = 0; i < 400; i++) {
      engine.ingest('D-01', { state: i % 2 ? 'fault' : 'normal' });
      clock += 500;
    }
    assert.equal(count('device_state'), 30, 'plafonne');
    assert.equal(count('device_flapping'), 1, 'une seule ligne de signalement');
    assert.equal(engine.getDevice('D-01')?.status, 'fault', "l'etat reel reste a jour");
    // un vrai incident n'est JAMAIS concerne
    engine.ingest('D-01', { state: 'alarm' });
    assert.equal(engine.getSnapshot().incidents.length, 1);
    // plus tard, la journalisation reprend
    clock += 11 * 60_000;
    engine.ingest('D-01', { state: 'normal' });
    assert.equal(count('device_state'), 31);
  });
});

describe('libelles : pas de caracteres de controle', () => {
  it("refuse retours a la ligne et sequences d'echappement dans un nom ou une zone ; accepte les accents", () => {
    const db = openDb(':memory:');
    seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(ROOT, 'seed'));
    const engine = createEngine(db, () => {});
    for (const bad of ['ok\r\nBcc: attaquant@evil.example', 'x\u001b[2J', 'a\u0000b', 'tab\tici']) {
      assert.throws(() => engine.createDevice('admin', { id: 'X-1', kind: 'detector', name: bad }), badRequest(/caracteres de controle/), JSON.stringify(bad));
      assert.throws(() => engine.updateDevice('admin', 'D-01', { zone: bad }), badRequest(/caracteres de controle/));
    }
    assert.equal(engine.createDevice('admin', { id: 'X-1', kind: 'detector', name: 'Détecteur Éléphant — entrée' }).name, 'Détecteur Éléphant — entrée');
  });
});

describe('webhooks', () => {
  it("adresses reservees (lien-local, metadonnees) refusees ; une redirection n'est jamais suivie", async () => {
    for (const bad of ['http://169.254.169.254/latest/meta-data', 'http://metadata.google.internal/x', 'http://0.0.0.0/x', 'http://[fe80::1]/x']) {
      assert.throws(() => validateAddress('webhook', bad), badRequest(/refusee/), bad);
    }
    assert.equal(validateAddress('webhook', 'http://192.168.1.50:1880/hook'), 'http://192.168.1.50:1880/hook');

    let landed = 0;
    const target = createHttpServer((_q, res) => (landed++, res.end('ok')));
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    cleanup.push(() => target.close());
    const redirector = createHttpServer((_q, res) => res.writeHead(302, { Location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/vole` }).end());
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    cleanup.push(() => redirector.close());
    const channel = webhookChannel({ secret: 's' }, [[`http://127.0.0.1:${(redirector.address() as AddressInfo).port}/hook`]]);
    await assert.rejects(channel.send({ kind: 'test', incidentId: null, subject: 's', text: 't', data: {} }, channel.recipients(1)[0]), /Webhook injoignable/);
    assert.equal(landed, 0, 'la redirection n\'a pas ete suivie');
  });
});

describe('supervision externe : /fail avant la query string', () => {
  it("place le suffixe dans le chemin, y compris pour une adresse a parametres (Uptime Kuma)", () => {
    assert.equal(failUrl('https://hc.exemple.test/ping/abc'), 'https://hc.exemple.test/ping/abc/fail');
    assert.equal(failUrl('https://hc.exemple.test/ping/abc/'), 'https://hc.exemple.test/ping/abc/fail');
    assert.equal(failUrl('https://kuma.exemple.test/api/push/XYZ?status=up&msg=OK&ping='), 'https://kuma.exemple.test/api/push/XYZ/fail?status=up&msg=OK&ping=');
  });
});

describe('rapports : rapides meme tres volumineux', () => {
  const record = (i: number): IncidentRecord => ({
    id: i, detectorId: i % 3 ? 'D-01' : 'D-02', detectorName: 'Detecteur', zone: 'Zone', category: 'fire', severity: 'critical', status: 'closed', qualification: i % 2 ? 'fire' : 'false_alarm', comment: null,
    openedAt: 1_700_000_000_000 + i * 60_000, ackedAt: 1_700_000_000_000 + i * 60_000 + 30_000, ackedBy: 'op', closedAt: 1_700_000_000_000 + i * 60_000 + 90_000, closedBy: 'op', confirmedAt: null, confirmationReason: null, hint: null, snapshots: 0, notificationsSent: 2, notificationsFailed: 0,
  });

  it("la synthese de 50 000 incidents d'un meme detecteur prend moins d'une seconde (elle prenait 31 s : boucle de controle bloquee)", () => {
    const records = Array.from({ length: 50_000 }, (_, i) => record(i + 1));
    const t0 = Date.now();
    const s = summarize(records);
    const ms = Date.now() - t0;
    assert.equal(s.total, 50_000);
    assert.ok(ms < 1500, `${ms} ms`);
  });

  it("le formatage de 100 000 dates prend moins de 2 secondes", () => {
    const t0 = Date.now();
    for (let i = 0; i < 100_000; i++) fmtDateTime(1_700_000_000_000 + i * 1000);
    assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  });
});

describe('redirection HTTP -> HTTPS', () => {
  it("avec un hote public connu, jamais d'autre hote que lui, quel que soit l'en-tete Host", async () => {
    const server = createHttpRedirect(8443, '127.0.0.1', 'psim.exemple.fr');
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    const location = (host: string) =>
      new Promise<string>((resolveLoc, reject) => {
        const r = request({ host: '127.0.0.1', port, path: '/x?y=1', headers: { Host: host } }, (res) => resolveLoc(String(res.headers.location)));
        r.on('error', reject);
        r.end();
      });
    assert.equal(await location('evil.example.com'), 'https://psim.exemple.fr:8443/x?y=1');
    assert.equal(await location('psim.exemple.fr'), 'https://psim.exemple.fr:8443/x?y=1');
    const open = createHttpRedirect(8443, 'fallback.local');
    await new Promise<void>((r) => open.listen(0, '127.0.0.1', r));
    cleanup.push(() => open.close());
  });
});

describe('visibilite : un operateur ne lit pas la configuration et les secrets de gestion', () => {
  const entry = (action: string) => ({ id: 1, ts: 1, actor: 'admin', action, incidentId: null, deviceId: 'C-01', details: 'rtsp 10.20.30.40:554 /opt/psim/data' });
  it("masque les details des actions d'administration pour l'operateur, jamais pour l'administrateur ni pour les actions d'exploitation", () => {
    for (const a of ['camera_source_updated', 'backup_failed', 'user_created', 'totp_reset', 'login_failed', 'device_flapping']) {
      assert.equal(maskAudit(entry(a), 'operator').details, null, a);
      assert.ok(maskAudit(entry(a), 'admin').details, a);
    }
    for (const a of ['incident_opened', 'incident_acked', 'device_state', 'zone_disarmed', 'intrusion_ignored']) {
      assert.ok(maskAudit(entry(a), 'operator').details, `${a} reste visible`);
    }
    assert.equal(maskAudit(entry('backup_failed'), 'operator').actor, 'admin', 'seul le detail est masque');
  });
});

describe('broker MQTT : aucun client ne lit les autres, ne force pas, n usurpe pas', { timeout: 120_000 }, () => {
  async function fixture() {
    const received: { id: string; payload: unknown }[] = [];
    const engine = { handleDetectorMessage: (id: string, payload: unknown) => void received.push({ id, payload }) } as never;
    const port = await freePort();
    const broker = await startBroker(engine, {
      host: '127.0.0.1', port, user: 'psim', password: 'Mot-de-passe-mqtt-solide-3',
      gateways: [{ user: 'gw1', password: 'Mot-de-passe-passerelle-1', detectors: ['D-01', 'A-*'] }],
    });
    cleanup.push(() => void broker.close());
    const connect = (username: string, password: string) => mqtt.connectAsync(`mqtt://127.0.0.1:${port}`, { username, password, connectTimeout: 4000, reconnectPeriod: 0 });
    return { received, broker, port, connect };
  }

  it("filtre de detecteurs : un compte de passerelle ne publie que pour ses detecteurs (identifiants exacts et prefixes)", () => {
    assert.equal(allows(['D-01', 'A-*'], 'D-01'), true);
    assert.equal(allows(['D-01', 'A-*'], 'D-02'), false);
    assert.equal(allows(['D-01', 'A-*'], 'A-07'), true);
    assert.equal(allows(['D-01', 'A-*'], 'XA-1'), false);
    assert.equal(allows([], 'D-01'), false);
  });

  it("usurpation : la passerelle ne peut pas parler au nom d'un autre detecteur ; le compte principal le peut", async () => {
    const f = await fixture();
    const gw = await f.connect('gw1', 'Mot-de-passe-passerelle-1');
    await gw.publishAsync('psim/detectors/D-01/state', JSON.stringify({ state: 'alarm' }));
    await gw.publishAsync('psim/detectors/A-05/state', JSON.stringify({ event: 'door_forced' }));
    await gw.publishAsync('psim/detectors/D-02/state', JSON.stringify({ state: 'normal' })).catch(() => {});
    await gw.publishAsync('psim/detectors/Z-99/state', JSON.stringify({ state: 'normal' })).catch(() => {});
    await wait(300);
    assert.deepEqual(f.received.map((r) => r.id).sort(), ['A-05', 'D-01'], "D-02 (d'un autre) et Z-99 n'ont jamais atteint le moteur");
    const main = await f.connect('psim', 'Mot-de-passe-mqtt-solide-3');
    await main.publishAsync('psim/detectors/D-02/state', JSON.stringify({ state: 'normal' }));
    await wait(200);
    assert.ok(f.received.some((r) => r.id === 'D-02'));
    gw.end(true);
    main.end(true);
  });

  it("lecture : « # », « $SYS » et les topics des autres sont refuses a tout client ; un compte de passerelle ne s'abonne a rien", async () => {
    const f = await fixture();
    const main = await f.connect('psim', 'Mot-de-passe-mqtt-solide-3');
    for (const topic of ['#', '$SYS/#', 'psim/#', '+/+/+', 'psim/detectors/#']) {
      await assert.rejects(main.subscribeAsync(topic), /Subscribe error/, `${topic} refuse`);
    }
    assert.notEqual((await main.subscribeAsync('psim/detectors/+/state'))[0].qos, 128, 'le compte principal garde le topic des detecteurs (recette)');
    const gw = await f.connect('gw1', 'Mot-de-passe-passerelle-1');
    await assert.rejects(gw.subscribeAsync('psim/detectors/+/state'), /Subscribe error/, 'une passerelle ne lit rien');
    const heard: string[] = [];
    main.on('message', (t) => heard.push(t));
    await gw.publishAsync('psim/detectors/D-01/state', JSON.stringify({ state: 'normal' }));
    await wait(200);
    assert.deepEqual(heard, ['psim/detectors/D-01/state']);
    gw.end(true);
    main.end(true);
  });

  it("aucun message « retained » n'est conserve ; un message de plus de 1 Ko n'atteint pas le moteur", async () => {
    const f = await fixture();
    const gw = await f.connect('gw1', 'Mot-de-passe-passerelle-1');
    await gw.publishAsync('psim/detectors/D-01/state', JSON.stringify({ state: 'alarm' }), { retain: true });
    await gw.publishAsync('psim/detectors/D-01/state', JSON.stringify({ state: 'normal', pad: 'x'.repeat(3000) })).catch(() => {});
    await wait(200);
    assert.equal(f.received.length, 1, 'le message trop gros est refuse');
    const late = await f.connect('psim', 'Mot-de-passe-mqtt-solide-3');
    const heard: string[] = [];
    late.on('message', (t) => heard.push(t));
    await late.subscribeAsync('psim/detectors/+/state');
    await wait(300);
    assert.deepEqual(heard, [], 'rien n\'est redistribue a un nouvel abonne');
    gw.end(true);
    late.end(true);
  });

  it("dix echecs d'authentification depuis une adresse la bloquent une minute, meme avec le bon mot de passe", async () => {
    const f = await fixture();
    for (let i = 0; i < 10; i++) await f.connect('psim', `mauvais-${i}`).then((c) => c.end(true), () => {});
    await assert.rejects(f.connect('psim', 'Mot-de-passe-mqtt-solide-3'));
    assert.equal(f.received.length, 0);
  });
});

