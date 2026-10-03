import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { checkTls } from '../scripts/commission/checks.ts';
import { DatabaseSync } from 'node:sqlite';
import { buildEnv, randomPassword } from '../scripts/init-production.ts';
import { findOpenssl } from '../scripts/lib/cert.ts';
import { validatePassword } from '../server/auth.ts';
import { DEV_PASSWORDS } from '../server/preflight.ts';

const ROOT = resolve(import.meta.dirname, '..');
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });
const run = (args: string[]) => spawnSync(process.execPath, ['scripts/init-production.ts', ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, USERNAME: process.env.USERNAME } });
const parse = (file: string): Record<string, string> =>
  Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

describe('mots de passe aleatoires', () => {
  it("24 caracteres sans caractere ambigu, acceptes par la politique, differents a chaque appel", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = randomPassword('admin');
      assert.equal(p.length, 24);
      assert.match(p, /^[A-HJ-NP-Za-km-z2-9]+$/, 'ni 0 O 1 l I');
      assert.equal(validatePassword(p, 'admin'), null);
      assert.ok(!DEV_PASSWORDS.includes(p));
      seen.add(p);
    }
    assert.equal(seen.size, 200);
  });
});

describe('contenu de .env.production', () => {
  const base = { listen: '0.0.0.0', port: 3033, dataDir: 'D:/psim/data-prod', backupDir: 'E:/sauvegardes psim', tls: { cert: 'D:/psim/tls/cert.pem', key: 'D:/psim/tls/key.pem' }, publicHost: 'psim.local', passwords: { admin: 'A'.repeat(24), operator: 'B'.repeat(24), mqtt: 'C'.repeat(24) } };

  it("active tout ce que la production exige, et rien de ce qu'elle interdit", () => {
    const text = buildEnv(base);
    const p = Object.fromEntries(text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    assert.equal(p.PSIM_ENV, 'production');
    assert.equal(p.PSIM_SIM_ENABLED, '0');
    assert.equal(p.PSIM_DEMO_LOGIN, '0');
    assert.equal(p.PSIM_REQUIRE_2FA, 'admin');
    assert.equal(p.PSIM_BACKUP_EVERY_H, '24');
    assert.equal(p.PSIM_MQTT_HOST, '127.0.0.1', 'le broker reste local par defaut');
    assert.equal(p.PSIM_PUBLIC_URL, 'https://psim.local:3033');
    assert.equal(p.PSIM_ENV_FILE, '.env.production');
    assert.equal(p.PSIM_ADMIN_PASSWORD, 'A'.repeat(24));
    assert.equal(p.PSIM_BACKUP_DIR, '"E:/sauvegardes psim"', 'les valeurs avec espace sont protegees par des guillemets');
    for (const dev of DEV_PASSWORDS) assert.ok(!text.includes(dev));
  });

  it("sans TLS : le dit clairement et ne declare pas d'adresse publique en https", () => {
    const text = buildEnv({ ...base, listen: '127.0.0.1', tls: null });
    assert.ok(!/^PSIM_TLS_CERT=/m.test(text));
    assert.match(text, /HTTPS non configure/);
    assert.ok(!/^PSIM_PUBLIC_URL=/m.test(text));
  });
});

describe('outil init-production (processus reel)', { timeout: 120_000 }, () => {
  const sandbox = () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-init-'));
    return { dir, out: join(dir, 'env.production'), data: join(dir, 'data-prod'), backups: join(dir, 'backups') };
  };

  it("genere le fichier, n'affiche AUCUN mot de passe, restreint son acces, et le controle de production passe", () => {
    const s = sandbox();
    const r = run(['--out', s.out, '--data-dir', s.data, '--backup-dir', s.backups, '--no-tls']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const env = parse(s.out);
    for (const k of ['PSIM_ADMIN_PASSWORD', 'PSIM_OPERATOR_PASSWORD', 'PSIM_MQTT_PASSWORD']) {
      assert.equal(env[k].length, 24, k);
      assert.ok(!(r.stdout + r.stderr).includes(env[k]), `${k} ne doit jamais etre affiche`);
    }
    assert.equal(new Set([env.PSIM_ADMIN_PASSWORD, env.PSIM_OPERATOR_PASSWORD, env.PSIM_MQTT_PASSWORD]).size, 3, 'trois mots de passe differents');
    assert.match(r.stdout, /ne sont pas affiches ici/);
    assert.match(r.stdout, /Controle de demarrage de production/);
    assert.ok(!/ERREUR/.test(r.stdout), r.stdout);
    assert.equal(existsSync(s.data), true);
    if (process.platform === 'win32') {
      const acl = spawnSync('icacls', [s.out], { encoding: 'utf8' }).stdout;
      assert.ok(!/Everyone|BUILTIN\\Users|Utilisateurs/i.test(acl), `acces restreint : ${acl}`);
    }
  });

  it("refuse d'ecraser un fichier existant (sans le modifier), le dossier de developpement, une ecoute reseau sans TLS, des arguments invalides", () => {
    const s = sandbox();
    writeFileSync(s.out, 'PSIM_ADMIN_PASSWORD=ancien-mot-de-passe\n');
    const again = run(['--out', s.out, '--data-dir', s.data, '--no-tls']);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /existe deja : rien n'a ete modifie/);
    assert.equal(readFileSync(s.out, 'utf8'), 'PSIM_ADMIN_PASSWORD=ancien-mot-de-passe\n');

    const fresh = sandbox();
    assert.equal(run(['--out', fresh.out, '--data-dir', 'data', '--no-tls']).status, 2, 'dossier de developpement');
    assert.equal(run(['--out', fresh.out, '--data-dir', fresh.data, '--listen', '0.0.0.0', '--no-tls']).status, 2, 'ouvert au reseau sans TLS');
    assert.equal(run(['--out', fresh.out, '--data-dir', fresh.data, '--port', '99999', '--no-tls']).status, 2);
    assert.equal(run(['--out', fresh.out, '--data-dir', fresh.data, '--host', 'mauvais host!', '--no-tls']).status, 2);
    assert.equal(run(['--out', fresh.out, '--data-dir', fresh.data, '--listen', 'pas-une-ip', '--no-tls']).status, 2);
    assert.equal(existsSync(fresh.out), false, 'aucun fichier cree apres un refus');
  });

  it("certificat reel : genere pour les noms demandes, ecoute reseau acceptee, certificat valide pour la verification de mise en service", { skip: findOpenssl() ? false : 'openssl introuvable' }, () => {
    const s = sandbox();
    const r = run(['--out', s.out, '--data-dir', s.data, '--backup-dir', s.backups, '--host', 'psim.local', '--host', '192.168.1.22', '--listen', '0.0.0.0']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const env = parse(s.out);
    assert.equal(env.PSIM_HOST, '0.0.0.0');
    assert.equal(env.PSIM_PUBLIC_URL, 'https://psim.local:3033');
    assert.ok(existsSync(env.PSIM_TLS_CERT) && existsSync(env.PSIM_TLS_KEY));
    const tls = checkTls({ cert: env.PSIM_TLS_CERT, key: env.PSIM_TLS_KEY });
    assert.equal(tls.status, 'ok', tls.detail);
    assert.match(tls.detail, /psim\.local/);
    assert.match(tls.detail, /192\.168\.1\.22/);
    assert.ok(!/ERREUR/.test(r.stdout), r.stdout);
  });

  it("le fichier genere demarre un vrai PSIM de production : les identifiants fonctionnent, l'administrateur est tenu d'activer la 2FA, le simulateur est ferme", async () => {
    const s = sandbox();
    assert.equal(run(['--out', s.out, '--data-dir', s.data, '--backup-dir', s.backups, '--no-tls']).status, 0);
    const env = parse(s.out);
    const port = await freePort();
    const proc = spawn(process.execPath, [`--env-file=${s.out}`, 'server/index.ts'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE, PSIM_PORT: String(port), PSIM_MQTT_PORT: String(await freePort()) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    proc.stdout.on('data', (d) => (output += d));
    proc.stderr.on('data', (d) => (output += d));
    try {
      const base = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 80; i++) {
        try {
          if ((await fetch(`${base}/healthz`)).status === 200) break;
        } catch {
          // pas encore pret
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal((await fetch(`${base}/healthz`)).status, 200, output);
      const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: env.PSIM_ADMIN_PASSWORD }) });
      assert.equal(login.status, 200, output);
      assert.equal(((await login.json()) as { restricted?: string }).restricted, '2fa', 'la 2FA est imposee a l\'administrateur');
      assert.equal((await fetch(`${base}/api/demo-accounts`)).status, 404, 'pas de comptes cliquables');
      const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin-dev-only' }) });
      assert.equal(bad.status, 401, 'le mot de passe de demonstration ne marche pas');
      assert.match(output, /\(production\)/);
      assert.ok(!output.includes(env.PSIM_ADMIN_PASSWORD) && !output.includes(env.PSIM_MQTT_PASSWORD), 'aucun mot de passe dans les journaux');
    } finally {
      proc.kill();
    }
    // Production : un site VIDE. Aucun detecteur, camera ou evaluation de risque de demonstration.
    await new Promise((r) => setTimeout(r, 500));
    const db = new DatabaseSync(join(s.data, 'psim.db'), { readOnly: true });
    try {
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM device').get() as { n: number }).n, 0, 'aucun equipement de demonstration');
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM risk_zone').get() as { n: number }).n, 0, 'aucune evaluation de risque de demonstration');
      assert.equal((db.prepare('SELECT plan_file FROM site WHERE id = 1').get() as { plan_file: string | null }).plan_file, null);
    } finally {
      db.close();
    }
    assert.match(output, /site vide cree/);
  });
});
