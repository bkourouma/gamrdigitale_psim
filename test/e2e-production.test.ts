/**
 * Test de bout en bout du mode production : le vrai serveur est demarre (processus separe), avec un vrai
 * certificat TLS, et on verifie ce qu'un exploitant verrait.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { verifyBackup } from '../server/backup.ts';

const ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;
const ADMIN_PASSWORD = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PASSWORD = 'Mot-de-passe-operateur-2';
const MQTT_PASSWORD = 'Mot-de-passe-mqtt-solide-3';

const OPENSSL = ['openssl', 'D:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/usr/bin/openssl.exe'].find(
  (b) => spawnSync(b, ['version'], { stdio: 'ignore' }).status === 0,
);

function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolvePort(port));
    });
  });
}

/** Environnement minimal et propre : rien ne vient de la machine de test. */
function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const keep = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}

function run(script: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000) {
  const r = spawnSync(NODE, [script, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function https(port: number, ca: string, path: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const req = httpsRequest(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', ca, servername: 'localhost', headers: options.headers },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolveReply({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('mode production (processus reel)', { skip: OPENSSL ? false : 'openssl introuvable', timeout: 120_000 }, () => {
  let dataDir: string;
  let backupDir: string;
  let ports: { web: number; mqtt: number; redirect: number };
  let pem: string;
  let env: NodeJS.ProcessEnv;
  let server: ChildProcess;
  let output = '';

  const waitHealthy = async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const r = await https(ports.web, pem, '/healthz');
        if (r.status === 200) return;
      } catch {
        // pas encore pret
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`le serveur n'est pas devenu sain :\n${output}`);
  };

  before(async () => {
    const work = mkdtempSync(join(tmpdir(), 'psim-e2e-'));
    dataDir = join(work, 'data');
    backupDir = join(work, 'backups');
    ports = { web: await freePort(), mqtt: await freePort(), redirect: await freePort() };
    const cert = join(work, 'cert.pem');
    const key = join(work, 'key.pem');
    const r = spawnSync(OPENSSL!, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'pipe' });
    assert.equal(r.status, 0);
    pem = readFileSync(cert, 'utf8');
    env = baseEnv({
      PSIM_ENV: 'production',
      PSIM_DATA_DIR: dataDir,
      PSIM_HOST: '127.0.0.1',
      PSIM_PORT: String(ports.web),
      PSIM_MQTT_PORT: String(ports.mqtt),
      PSIM_HTTP_REDIRECT_PORT: String(ports.redirect),
      PSIM_TLS_CERT: cert,
      PSIM_TLS_KEY: key,
      PSIM_ADMIN_PASSWORD: ADMIN_PASSWORD,
      PSIM_OPERATOR_PASSWORD: OPERATOR_PASSWORD,
      PSIM_MQTT_PASSWORD: MQTT_PASSWORD,
      PSIM_BACKUP_DIR: backupDir,
    });
    server = spawn(NODE, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout!.on('data', (d) => (output += d));
    server.stderr!.on('data', (d) => (output += d));
    await waitHealthy();
  });

  after(() => {
    server?.kill();
  });

  it('demarre en HTTPS et affiche ce qui compte', () => {
    assert.match(output, /\(production\)/);
    assert.match(output, /interface {2}: https:\/\//);
    assert.match(output, /sauvegarde automatique : toutes les 24 h/);
    assert.match(output, /Aucun canal de notification/, 'le controle de demarrage avertit');
  });

  it('/healthz repond sans authentification, de facon minimale', async () => {
    const r = await https(ports.web, pem, '/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { status: 'ok' });
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  it("envoie HSTS, et le cookie de session est « Secure » sans reglage supplementaire", async () => {
    const page = await https(ports.web, pem, '/');
    assert.match(String(page.headers['strict-transport-security']), /max-age=31536000/);
    const login = await https(ports.web, pem, '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(login.status, 200);
    const cookie = String(login.headers['set-cookie']);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
  });

  it("n'offre ni comptes cliquables ni simulateur en production", async () => {
    const demo = await https(ports.web, pem, '/api/demo-accounts');
    assert.equal(demo.status, 404);
    const login = await https(ports.web, pem, '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }), headers: { 'Content-Type': 'application/json' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await https(ports.web, pem, '/api/me', { headers: { Cookie: cookie } })).body);
    assert.equal(me.simEnabled, false);
    const sim = await https(ports.web, pem, '/api/sim/detectors/D-01', { method: 'POST', body: '{"state":"alarm"}', headers: { Cookie: cookie, 'Content-Type': 'application/json' } });
    assert.equal(sim.status, 404, 'impossible de declencher une fausse alarme');
  });

  it("l'etat systeme est reserve a l'administrateur et signale ce qui manque", async () => {
    const adminLogin = await https(ports.web, pem, '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }), headers: { 'Content-Type': 'application/json' } });
    const admin = String(adminLogin.headers['set-cookie']).split(';')[0];
    const r = await https(ports.web, pem, '/api/system', { headers: { Cookie: admin } });
    assert.equal(r.status, 200);
    const system = JSON.parse(r.body);
    assert.equal(system.health.ok, true);
    assert.ok(system.uptimeS >= 0 && system.database.bytes > 0);
    assert.ok(system.warnings.some((w: { message: string }) => /Aucun canal de notification/.test(w.message)));

    const opLogin = await https(ports.web, pem, '/api/login', { method: 'POST', body: JSON.stringify({ username: 'operateur', password: OPERATOR_PASSWORD }), headers: { 'Content-Type': 'application/json' } });
    const op = String(opLogin.headers['set-cookie']).split(';')[0];
    assert.equal((await https(ports.web, pem, '/api/system', { headers: { Cookie: op } })).status, 403);
    assert.equal((await https(ports.web, pem, '/api/system')).status, 401);
  });

  it("« Sauvegarder maintenant » (administrateur) cree une sauvegarde verifiee ; refuse a un operateur", async () => {
    const headers = { 'Content-Type': 'application/json' };
    const login = (username: string, password: string) => https(ports.web, pem, '/api/login', { method: 'POST', body: JSON.stringify({ username, password }), headers });
    const admin = String((await login('admin', ADMIN_PASSWORD)).headers['set-cookie']).split(';')[0];
    const op = String((await login('operateur', OPERATOR_PASSWORD)).headers['set-cookie']).split(';')[0];
    assert.equal((await https(ports.web, pem, '/api/system/backup', { method: 'POST', headers: { Cookie: op } })).status, 403);
    const r = await https(ports.web, pem, '/api/system/backup', { method: 'POST', headers: { Cookie: admin } });
    assert.equal(r.status, 200);
    const result = JSON.parse(r.body);
    assert.equal(result.ok, true);
    assert.ok(existsSync(join(backupDir, result.name, 'manifest.json')));
    assert.equal(verifyBackup(join(backupDir, result.name)).ok, true);
    const system = JSON.parse((await https(ports.web, pem, '/api/system', { headers: { Cookie: admin } })).body);
    assert.equal(system.backup.ok, true);
    assert.ok(system.backup.count >= 1);
  });

  it('refuse les mots de passe de demonstration pour se connecter', async () => {
    const r = await https(ports.web, pem, '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin-dev-only' }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 401);
  });

  it('redirige HTTP vers HTTPS', async () => {
    const r = await new Promise<{ status: number; location: string | undefined }>((resolveReply, reject) => {
      httpRequest({ host: '127.0.0.1', port: ports.redirect, path: '/api/state' }, (res) => resolveReply({ status: res.statusCode!, location: res.headers.location })).on('error', reject).end();
    });
    assert.equal(r.status, 308);
    assert.match(r.location ?? '', new RegExp(`^https://127\\.0\\.0\\.1:${ports.web}/api/state$`));
  });

  it('refuse une seconde instance sur les memes donnees, sans toucher a la premiere', async () => {
    const second = run('server/index.ts', [], { ...env, PSIM_PORT: String(await freePort()), PSIM_MQTT_PORT: String(await freePort()), PSIM_HTTP_REDIRECT_PORT: '0' }, 20_000);
    assert.equal(second.status, 1);
    assert.match(second.out, /Un autre PSIM utilise deja ce dossier de donnees/);
    assert.equal((await https(ports.web, pem, '/healthz')).status, 200, 'la premiere instance est intacte');
  });

  it('npm run backup fonctionne pendant que le PSIM tourne et produit une sauvegarde verifiee', () => {
    const r = run('scripts/backup.ts', [], env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /verifiee/);
    assert.match(r.out, /secret\.key\) n'est PAS dans cette sauvegarde/);
    const [name] = readdirSync(backupDir).filter((n) => n.startsWith('psim-'));
    assert.ok(name);
    assert.equal(verifyBackup(join(backupDir, name)).ok, true);
    assert.ok(!existsSync(join(backupDir, name, 'secret.key')));
  });

  it("la restauration refuse tant que le PSIM tourne, puis fonctionne apres son arret (verrou orphelin ignore)", async () => {
    const [name] = readdirSync(backupDir).filter((n) => n.startsWith('psim-'));
    const backup = join(backupDir, name);
    const refused = run('scripts/restore.ts', [backup, '--yes'], env);
    assert.equal(refused.status, 1);
    assert.match(refused.out, /Le PSIM tourne/);

    server.kill(); // arret brutal : le verrou reste sur le disque, mais son processus n'existe plus
    await new Promise((r) => server.once('exit', r));
    const dry = run('scripts/restore.ts', [backup], env);
    assert.equal(dry.status, 0, dry.out);
    assert.match(dry.out, /Rien n'a ete modifie/);

    const done = run('scripts/restore.ts', [backup, '--yes'], env);
    assert.equal(done.status, 0, done.out);
    assert.match(done.out, /Restauration terminee/);
    assert.match(done.out, /Ancien etat conserve dans/);
    assert.ok(existsSync(join(dataDir, 'psim.db')));
    assert.ok(readdirSync(join(dataDir, '..')).some((n) => n.startsWith('data.before-restore-')), "l'ancien etat est conserve");

    // Le PSIM repart avec les donnees restaurees.
    server = spawn(NODE, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout!.on('data', (d) => (output += d));
    server.stderr!.on('data', (d) => (output += d));
    await waitHealthy();
    const login = await https(ports.web, pem, '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(login.status, 200, 'les comptes sont revenus avec la sauvegarde');
  });
});

describe('demarrage refuse en production mal configuree', { timeout: 60_000 }, () => {
  const refuse = (extra: Record<string, string>) =>
    run('server/index.ts', [], baseEnv({ PSIM_ENV: 'production', PSIM_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'psim-bad-')), 'data'), PSIM_PORT: '0', ...extra }), 20_000);

  it('mots de passe de demonstration', () => {
    const r = refuse({});
    assert.equal(r.status, 1);
    assert.match(r.out, /valeur de demonstration publique/);
    assert.match(r.out, /Demarrage refuse/);
  });

  it("interface ouverte au reseau sans HTTPS", () => {
    const r = refuse({ PSIM_HOST: '0.0.0.0', PSIM_ADMIN_PASSWORD: ADMIN_PASSWORD, PSIM_OPERATOR_PASSWORD: OPERATOR_PASSWORD, PSIM_MQTT_PASSWORD: MQTT_PASSWORD });
    assert.equal(r.status, 1);
    assert.match(r.out, /sans HTTPS/);
  });

  it('simulateur explicitement active', () => {
    const r = refuse({ PSIM_SIM_ENABLED: '1', PSIM_ADMIN_PASSWORD: ADMIN_PASSWORD, PSIM_OPERATOR_PASSWORD: OPERATOR_PASSWORD, PSIM_MQTT_PASSWORD: MQTT_PASSWORD });
    assert.equal(r.status, 1);
    assert.match(r.out, /simulateur est actif/i);
  });

  it('npm run check-config donne le meme verdict sans demarrer', () => {
    const r = run('scripts/check-config.ts', [], baseEnv({ PSIM_ENV: 'production' }));
    assert.equal(r.status, 1);
    assert.match(r.out, /PRODUCTION/);
    assert.match(r.out, /erreur\(s\) bloquante\(s\)/);
    const ok = run('scripts/check-config.ts', [], baseEnv({}));
    assert.equal(ok.status, 0, 'hors production : avertissements seulement');
  });
});
