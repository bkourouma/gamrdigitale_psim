/**
 * Images envoyees par les equipements, contre le vrai serveur : gestion des cles reservee a l'administrateur, image mise en
 * attente puis rattachee a l'incident ouvert par le message d'alarme (meme cle), affichage protege par session, jeton
 * partage refuse pour les images mais toujours valable pour les messages d'etat, revocation, sauvegarde.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';
const TOKEN = 'jeton-equipements-0123456789abcdef';

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
  Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]),
  Buffer.alloc(64, 0x42),
  Buffer.from([0xff, 0xd9]),
]);

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });

async function start(extra: Record<string, string>): Promise<{ proc: ChildProcess; base: string; dataDir: string; backupDir: string; output: () => string }> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const root = mkdtempSync(join(tmpdir(), 'psim-e2e-img-'));
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    PSIM_DATA_DIR: join(root, 'data'),
    PSIM_BACKUP_DIR: join(root, 'backups'),
    PSIM_PORT: String(port),
    PSIM_MQTT_PORT: String(await freePort()),
    PSIM_ADMIN_PASSWORD: ADMIN_PW,
    PSIM_OPERATOR_PASSWORD: OPERATOR_PW,
    PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3',
    PSIM_DEMO_LOGIN: '0',
    PSIM_REQUIRE_2FA: 'none',
    ...extra,
  });
  let output = '';
  const proc = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (d) => (output += d));
  proc.stderr!.on('data', (d) => (output += d));
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).status === 200) return { proc, base, dataDir: join(root, 'data'), backupDir: join(root, 'backups'), output: () => output };
    } catch {
      // pas encore pret
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error(`serveur non demarre :\n${output}`);
}

async function login(base: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie()[0].split(';')[0];
}

describe('images envoyees par les equipements (processus reel)', { timeout: 120_000 }, () => {
  let s: Awaited<ReturnType<typeof start>>;
  let admin = '';
  let operator = '';

  const api = async (method: string, path: string, cookie: string | null, body?: unknown) => {
    const res = await fetch(`${s.base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const image = (id: string, key: string | null, data = JPEG, base = s.base) =>
    fetch(`${base}/api/ingest/${id}/image`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: data });
  const state = (id: string, key: string | null, body: unknown, base = s.base) =>
    fetch(`${base}/api/ingest/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });

  before(async () => {
    s = await start({ PSIM_INGEST_TOKEN: TOKEN });
    admin = await login(s.base, 'admin', ADMIN_PW);
    operator = await login(s.base, 'operateur', OPERATOR_PW);
  });
  after(() => s?.proc.kill());

  it("cles : reservees a l'administrateur ; la cle n'est montree qu'a la creation", async () => {
    assert.equal((await api('GET', '/api/device-keys', null)).status, 401);
    assert.equal((await api('POST', '/api/device-keys', operator, { label: 'x', devices: ['D-01'] })).status, 403);
    // Requete inter-sites (navigateur piege) : refusee comme toute action d'administration.
    const csrf = await fetch(`${s.base}/api/device-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin, Origin: 'https://attaquant.example' }, body: JSON.stringify({ label: 'x', devices: ['D-01'] }) });
    assert.equal(csrf.status, 403);
    const created = await api('POST', '/api/device-keys', admin, { label: 'Camera 4G accueil', devices: ['D-01'] });
    assert.equal(created.status, 201);
    assert.match(created.body.key, /^psk_\d+_/);
    const list = await api('GET', '/api/device-keys', admin);
    assert.ok(!JSON.stringify(list.body).includes(created.body.key.slice(5)));
  });

  it("photo puis alarme (meme cle) : l'image attend, se rattache a l'incident, s'affiche pour l'operateur", async () => {
    const { body: k } = await api('POST', '/api/device-keys', admin, { label: 'Camera 4G', devices: ['D-01'] });
    const sent = await image('D-01', k.key);
    assert.equal(sent.status, 202, await sent.clone().text());
    assert.equal((await state('D-01', k.key, { state: 'alarm' })).status, 204, 'la cle d equipement vaut aussi pour les messages d etat');
    let shot: { id: number; reason: string } | undefined;
    for (let i = 0; i < 40 && !shot; i++) {
      const snap = await api('GET', '/api/state', operator);
      shot = snap.body.incidents.find((x: { detectorId: string }) => x.detectorId === 'D-01')?.snapshots.find((x: { reason: string }) => x.reason === 'device');
      if (!shot) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(shot, s.output().slice(-500));
    const served = await fetch(`${s.base}/api/snapshots/${shot.id}`, { headers: { Cookie: operator } });
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/jpeg');
    assert.match(served.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), JPEG);
    assert.equal((await fetch(`${s.base}/api/snapshots/${shot.id}`)).status, 401, 'jamais sans session');
    for (const p of ['..%2fpsim.db', '..%2f..%2fsecret.key', `${shot.id}.jpg`, '-1', '1e3']) {
      assert.equal((await fetch(`${s.base}/api/snapshots/${p}`, { headers: { Cookie: operator } })).status, 404, p);
    }
    const audit = await api('GET', '/api/audit?limit=50', operator);
    assert.ok(audit.body.some((a: { action: string; details: string | null }) => a.action === 'image_scellee' && /sha256=[0-9a-f]{64}/.test(a.details ?? '')));
  });

  it("jeton partage : refuse pour les images, toujours accepte pour les messages d'etat ; cle limitee a SES equipements", async () => {
    assert.equal((await image('D-02', TOKEN)).status, 401);
    assert.equal((await state('E-01', TOKEN, { value: 21 })).status, 204, 'retrocompatibilite du jeton partage');
    const { body: k } = await api('POST', '/api/device-keys', admin, { label: 'Passerelle D-02', devices: ['D-02'] });
    assert.equal((await state('A-01', k.key, { event: 'door_forced' })).status, 403);
    assert.equal((await image('A-01', k.key)).status, 403);
    assert.equal((await api('DELETE', `/api/device-keys/${k.id}`, admin)).body.active, false);
    assert.equal((await image('D-02', k.key)).status, 401, 'revoquee');
    assert.equal((await state('D-02', k.key, { state: 'normal' })).status, 401, 'revoquee, aussi pour les messages d etat');
  });

  it('la sauvegarde contient les images des equipements', async () => {
    const res = await api('POST', '/api/system/backup', admin);
    assert.equal(res.status, 200);
    const [name] = readdirSync(s.backupDir);
    const manifest = JSON.parse(readFileSync(join(s.backupDir, name, 'manifest.json'), 'utf8')) as { files: { path: string }[] };
    assert.ok(manifest.files.some((f) => /^snapshots\/\d+\.jpg$/.test(f.path)), JSON.stringify(manifest.files.map((f) => f.path)));
  });

  it("sans jeton partage : l'entree d'etat reste inexistante (404) sauf pour une cle d'equipement", async () => {
    const other = await start({});
    try {
      const cookie = await login(other.base, 'admin', ADMIN_PW);
      const created = await fetch(`${other.base}/api/device-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ label: 'cle', devices: ['E-01'] }) });
      const k = (await created.json()) as { key: string };
      assert.equal((await state('E-01', null, { value: 20 }, other.base)).status, 404);
      assert.equal((await state('E-01', 'court', { value: 20 }, other.base)).status, 404);
      assert.equal((await state('E-01', k.key, { value: 20 }, other.base)).status, 204);
    } finally {
      other.proc.kill();
    }
  });
});
