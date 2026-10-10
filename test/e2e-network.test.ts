/**
 * Supervision reseau des equipements d'infrastructure, contre le vrai serveur : droits (administrateur seulement),
 * validation de l'hote et du port, essai, mesure periodique (branchement dans main.ts), avertissement de l'ecran Systeme.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });

async function start(extra: Record<string, string>): Promise<{ proc: ChildProcess; base: string; output: () => string }> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    PSIM_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'psim-net-')), 'data'),
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
      if ((await fetch(`${base}/healthz`)).status === 200) return { proc, base, output: () => output };
    } catch {
      // pas encore pret
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error(`serveur non demarre :\n${output}`);
}

describe('supervision reseau (processus reel)', { timeout: 120_000 }, () => {
  let main: Awaited<ReturnType<typeof start>>;
  let admin = '';
  let operator = '';
  let equipment: Server;
  let equipmentPort = 0;

  const login = async (username: string, password: string) => {
    const res = await fetch(`${main.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(res.status, 200);
    return res.headers.getSetCookie()[0].split(';')[0];
  };
  async function api(method: string, path: string, body?: unknown, cookie = admin) {
    const res = await fetch(`${main.base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  const until = async (check: () => Promise<boolean>, what: string, seconds = 20) => {
    for (let i = 0; i < seconds * 4; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.fail(`${what}\n${main.output()}`);
  };

  before(async () => {
    // Un test par seconde : la panne (3 echecs) est constatee en quelques secondes.
    main = await start({ PSIM_NETWORK_CHECK_S: '1' });
    admin = await login('admin', ADMIN_PW);
    operator = await login('operateur', OPERATOR_PW);
    equipment = createServer((socket) => socket.end());
    await new Promise<void>((resolveListen) => equipment.listen(0, '127.0.0.1', resolveListen));
    equipmentPort = (equipment.address() as AddressInfo).port;
  });

  after(() => {
    main?.proc.kill();
    equipment?.close();
  });

  it('droits : administrateur seulement (401 sans session, 403 pour un operateur)', async () => {
    const d = await api('POST', '/api/devices', { id: 'N-01', kind: 'detector', name: 'Routeur 4G', zone: 'Local technique', category: 'environment' });
    assert.equal(d.status, 201);
    for (const [method, path, body] of [
      ['GET', '/api/devices/N-01/network', undefined],
      ['PUT', '/api/devices/N-01/network', { host: '127.0.0.1', port: equipmentPort }],
      ['DELETE', '/api/devices/N-01/network', undefined],
      ['POST', '/api/network/test', { host: '127.0.0.1', port: equipmentPort }],
    ] as const) {
      assert.equal((await api(method, path, body, '')).status, 401, `${method} ${path} sans session`);
      assert.equal((await api(method, path, body, operator)).status, 403, `${method} ${path} operateur`);
    }
  });

  it('validation stricte de l hote et du port : 400, rien d enregistre', async () => {
    assert.equal((await api('GET', '/api/devices/N-01/network')).body, null);
    for (const body of [
      { host: 'http://127.0.0.1', port: 80 },
      { host: '127.0.0.1/x', port: 80 },
      { host: '', port: 80 },
      { host: '127.0.0.1', port: 0 },
      { host: '127.0.0.1', port: 65536 },
      { host: '127.0.0.1', port: 'abc' },
      { host: '127.0.0.1' },
      { port: 80 },
    ]) {
      assert.equal((await api('PUT', '/api/devices/N-01/network', body)).status, 400, JSON.stringify(body));
      assert.equal((await api('POST', '/api/network/test', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await api('GET', '/api/devices/N-01/network')).body, null);
    assert.equal((await api('PUT', '/api/devices/NOPE/network', { host: '127.0.0.1', port: 80 })).status, 404);
    assert.equal((await api('PUT', '/api/devices/C-01/network', { host: '127.0.0.1', port: 80 })).status, 404, 'une camera a sa propre source');
  });

  it('essai : repond ou non, sans rien enregistrer', async () => {
    const ok = await api('POST', '/api/network/test', { host: '127.0.0.1', port: equipmentPort });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    const closed = await freePort();
    const ko = await api('POST', '/api/network/test', { host: '127.0.0.1', port: closed });
    assert.equal(ko.status, 200);
    assert.equal(ko.body.ok, false);
    assert.equal((await api('GET', '/api/devices/N-01/network')).body, null);
  });

  it('enregistre, mesure (jamais « normal » avant le premier test), puis constate la panne et la signale une seule fois', async () => {
    const saved = await api('PUT', '/api/devices/N-01/network', { host: '127.0.0.1', port: equipmentPort });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { host: '127.0.0.1', port: equipmentPort, state: null, since: null });

    await until(async () => (await api('GET', '/api/devices/N-01/network')).body?.state === 'normal', 'jamais declare en service');

    await new Promise<void>((resolveClose) => equipment.close(() => resolveClose()));
    await until(async () => (await api('GET', '/api/devices/N-01/network')).body?.state === 'offline', 'panne non constatee', 30);
    const system = (await api('GET', '/api/system')).body;
    assert.deepEqual(system.network.offline, ['Routeur 4G']);
    const warnings = system.warnings.map((w: { message: string }) => w.message).filter((m: string) => /equipement\(s\) reseau/.test(m));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Routeur 4G/);
    assert.ok(!warnings[0].includes('127.0.0.1'));

    // L'equipement du plan reste affiche comme avant (la mesure ne touche pas device.status) ; le journal n'a pas l'adresse.
    const audit = (await api('GET', '/api/audit?limit=200')).body as { action: string; details: string | null }[] | null;
    if (audit) {
      const lines = audit.filter((a) => a.action.startsWith('network_'));
      assert.ok(lines.some((a) => a.action === 'network_offline'));
      assert.ok(!JSON.stringify(lines).includes('127.0.0.1'));
    }
  });

  it('retrait de la supervision : plus de cible, plus d avertissement', async () => {
    assert.equal((await api('DELETE', '/api/devices/N-01/network')).status, 204);
    assert.equal((await api('GET', '/api/devices/N-01/network')).body, null);
    assert.equal((await api('DELETE', '/api/devices/N-01/network')).status, 404);
    await until(async () => (await api('GET', '/api/system')).body.network.measured === 0, 'cible encore comptee');
    const system = (await api('GET', '/api/system')).body;
    assert.deepEqual(system.network.offline, []);
  });
});
