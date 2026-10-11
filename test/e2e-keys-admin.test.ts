/**
 * Ecran « Cles et passerelles », contre le vrai serveur : etat des passerelles expose a l'administrateur seulement
 * (identifiants declares et representes, dernier message recu, liaison), fichiers de l'ecran servis sans aucune cle, cycle
 * de vie des cles tel que l'ecran le conduit (creation, rotation avec delai de grace, revocation), cle jamais relue.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';
const GATEWAYS = [
  { user: 'gw-zigbee', password: 'Passerelle-zigbee-essai-1', detectors: ['D-*', 'GW-01'] },
  { user: 'gw-modbus', password: 'Passerelle-modbus-essai-2', detectors: ['M-*'] },
];

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });

async function start(): Promise<{ proc: ChildProcess; base: string; mqttPort: number; output: () => string }> {
  const port = await freePort();
  const mqttPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const root = mkdtempSync(join(tmpdir(), 'psim-e2e-keys-'));
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    PSIM_DATA_DIR: join(root, 'data'),
    PSIM_BACKUP_DIR: join(root, 'backups'),
    PSIM_PORT: String(port),
    PSIM_MQTT_PORT: String(mqttPort),
    PSIM_ADMIN_PASSWORD: ADMIN_PW,
    PSIM_OPERATOR_PASSWORD: OPERATOR_PW,
    PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3',
    PSIM_MQTT_GATEWAYS: JSON.stringify(GATEWAYS),
    PSIM_DEMO_LOGIN: '0',
    PSIM_REQUIRE_2FA: 'none',
  });
  let output = '';
  const proc = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (d) => (output += d));
  proc.stderr!.on('data', (d) => (output += d));
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).status === 200) return { proc, base, mqttPort, output: () => output };
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

interface GatewayView {
  user: string;
  connected: boolean;
  since: number;
  down: boolean;
  unmonitored: number;
  detectors: string[];
  represents: string[];
  lastMessageAt: number | null;
}

describe('ecran « Cles et passerelles » (processus reel)', { timeout: 120_000 }, () => {
  let s: Awaited<ReturnType<typeof start>>;
  let admin = '';
  let operator = '';
  let gateway: MqttClient | undefined;

  const api = async (method: string, path: string, cookie: string | null, body?: unknown) => {
    const res = await fetch(`${s.base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const gateways = async (): Promise<GatewayView[]> => (await api('GET', '/api/system', admin)).body.gateways;
  const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> => {
    let last: T | undefined;
    for (let i = 0; i < 60; i++) {
      last = await read();
      if (ok(last)) return last;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${what} : ${JSON.stringify(last)}\n${s.output().slice(-400)}`);
  };

  before(async () => {
    s = await start();
    admin = await login(s.base, 'admin', ADMIN_PW);
    operator = await login(s.base, 'operateur', OPERATOR_PW);
  });
  after(() => {
    gateway?.end(true);
    s?.proc.kill();
  });

  it("passerelles : reservees a l'administrateur ; identifiants declares et representes, aucun message avant la connexion", async () => {
    assert.equal((await api('GET', '/api/system', null)).status, 401);
    assert.equal((await api('GET', '/api/system', operator)).status, 403);
    const list = await gateways();
    assert.deepEqual(list.map((g) => g.user), ['gw-zigbee', 'gw-modbus']);
    const zigbee = list[0];
    assert.deepEqual(zigbee.detectors, ['D-*', 'GW-01'], 'tels que declares');
    assert.ok(zigbee.represents.length > 0 && zigbee.represents.every((id) => id.startsWith('D-')), `detecteurs representes : ${zigbee.represents}`);
    assert.deepEqual(list[1].represents, [], 'aucun detecteur du site ne porte M-');
    for (const g of list) {
      assert.equal(g.connected, false);
      assert.equal(g.lastMessageAt, null);
      assert.equal(g.unmonitored, 0);
      assert.equal(typeof g.since, 'number');
    }
  });

  it('passerelle connectee : liaison et dernier message recu mis a jour ; l autre passerelle reste silencieuse ; deconnexion visible', async () => {
    gateway = mqtt.connect(`mqtt://127.0.0.1:${s.mqttPort}`, { username: 'gw-zigbee', password: GATEWAYS[0].password, clientId: 'gw-zigbee-essai', reconnectPeriod: 0 });
    await new Promise<void>((resolveConnect, reject) => {
      gateway!.once('connect', () => resolveConnect());
      gateway!.once('error', reject);
    });
    const connected = await until(gateways, (l) => l[0].connected, 'passerelle connectee');
    assert.equal(connected[0].lastMessageAt, null, 'connectee mais encore muette');
    const before = Date.now();
    await new Promise<void>((resolvePublish, reject) => gateway!.publish('psim/detectors/D-01/state', JSON.stringify({ state: 'normal', ts: Date.now() }), { qos: 0 }, (err) => (err ? reject(err) : resolvePublish())));
    const spoken = await until(gateways, (l) => l[0].lastMessageAt !== null, 'dernier message recu');
    assert.ok(spoken[0].lastMessageAt! >= before - 1000 && spoken[0].lastMessageAt! <= Date.now() + 1000);
    assert.equal(spoken[1].lastMessageAt, null, 'une autre passerelle n est pas concernee');
    assert.equal(spoken[1].connected, false);
    gateway.end(true);
    const gone = await until(gateways, (l) => !l[0].connected, 'passerelle deconnectee');
    assert.equal(gone[0].down, false, "deconnectee depuis moins longtemps que le delai : pas encore declaree coupee");
    assert.ok(gone[0].lastMessageAt !== null, 'le dernier message reste affiche');
  });

  it("fichiers de l'ecran servis, sans aucune cle, y compris apres la creation d'une cle", async () => {
    const made = await api('POST', '/api/device-keys', admin, { label: 'Camera 4G portail', devices: ['D-01', 'I-*'] });
    assert.equal(made.status, 201);
    const secret = made.body.key as string;
    for (const file of ['', 'keys.js', 'keysdata.js', 'keys.css']) {
      const res = await fetch(`${s.base}/${file}`, { headers: { Cookie: admin } });
      assert.equal(res.status, 200, file);
      const text = await res.text();
      assert.ok(!text.includes(secret.slice(5)) && !/psk_\d/.test(text), `${file || 'index.html'} ne contient aucune cle`);
      if (file === 'keys.js') assert.match(res.headers.get('content-type') ?? '', /javascript/);
    }
    assert.match(await (await fetch(`${s.base}/`)).text(), /id="view-cles"/);
  });

  it("cycle de vie tel que l'ecran le conduit : creation, rotation avec delai de grace, revocation ; la cle n'est jamais relue", async () => {
    // « * » seul : refuse comme dans l'ecran.
    assert.equal((await api('POST', '/api/device-keys', admin, { label: 'x', devices: ['*'] })).status, 400);
    const made = await api('POST', '/api/device-keys', admin, { label: 'Passerelle LoRa', devices: ['D-02'] });
    assert.equal(made.status, 201);
    const { key: first, ...firstView } = made.body as { key: string; id: number; active: boolean };
    assert.equal(firstView.active, true);
    const ingest = (key: string) => fetch(`${s.base}/api/ingest/D-02`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ state: 'normal' }) });
    assert.equal((await ingest(first)).status, 204);

    const rotated = await api('POST', `/api/device-keys/${firstView.id}/rotate`, admin, { graceMinutes: 60 });
    assert.equal(rotated.status, 201);
    const second = rotated.body.key as string;
    assert.notEqual(second, first);
    assert.equal((await ingest(first)).status, 204, "l'ancienne cle fonctionne pendant le delai de grace");
    assert.equal((await ingest(second)).status, 204);
    const list = (await api('GET', '/api/device-keys', admin)).body as { id: number; active: boolean; revokedAt: number | null; replacedBy: number | null; lastUsedAt: number | null }[];
    const old = list.find((k) => k.id === firstView.id)!;
    assert.equal(old.active, true, 'en rotation : encore active');
    assert.ok(old.revokedAt! > Date.now() + 50 * 60_000 && old.replacedBy === rotated.body.id, 'fin de grace dans une heure, remplacee par la nouvelle');
    assert.notEqual(old.lastUsedAt, null, 'derniere utilisation renseignee');

    assert.equal((await api('DELETE', `/api/device-keys/${rotated.body.id}`, admin)).body.active, false);
    assert.equal((await ingest(second)).status, 401, 'revoquee : refusee tout de suite');

    // Aucune cle dans la liste ni dans le journal.
    const listing = JSON.stringify((await api('GET', '/api/device-keys', admin)).body);
    const audit = JSON.stringify((await api('GET', '/api/audit?limit=200', admin)).body);
    for (const secret of [first, second]) {
      assert.ok(!listing.includes(secret.slice(5)) && !audit.includes(secret.slice(5)), 'la cle ne sort jamais apres sa creation');
    }
    assert.match(audit, /device_key_rotated/);
  });
});
