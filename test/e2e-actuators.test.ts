/**
 * Commandes des equipements contre le VRAI serveur (processus complet) : droits par role, anti-CSRF, confirmation,
 * mot de passe, limite, mode maintenance, aller-retour MQTT avec le simulateur (ordre signe -> accuse signe), journal
 * scelle (demande AVANT envoi), et redemarrage : une commande en vol expire et n'est jamais renvoyee.
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
import { startMqttActuator } from './actuator-sim.ts';
import type { MqttSim } from './actuator-sim.ts';

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';
const GW = { user: 'gw-act', password: 'Mot-de-passe-passerelle-actionneurs' };

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Running {
  proc: ChildProcess;
  base: string;
  mqttUrl: string;
  output: () => string;
}

async function start(root: string, ports: { web: number; mqtt: number }): Promise<Running> {
  const base = `http://127.0.0.1:${ports.web}`;
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    PSIM_DATA_DIR: join(root, 'data'),
    PSIM_BACKUP_DIR: join(root, 'backups'),
    PSIM_PORT: String(ports.web),
    PSIM_MQTT_PORT: String(ports.mqtt),
    PSIM_ADMIN_PASSWORD: ADMIN_PW,
    PSIM_OPERATOR_PASSWORD: OPERATOR_PW,
    PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3',
    PSIM_DEMO_LOGIN: '0',
    PSIM_REQUIRE_2FA: 'none',
    PSIM_MQTT_GATEWAYS: JSON.stringify([{ user: GW.user, password: GW.password, actuators: ['SIR-01', 'GACHE-1'] }]),
    PSIM_ACTUATOR_HTTP_HOSTS: '127.0.0.1',
  });
  let output = '';
  const proc = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (d) => (output += d));
  proc.stderr!.on('data', (d) => (output += d));
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).status === 200) return { proc, base, mqttUrl: `mqtt://127.0.0.1:${ports.mqtt}`, output: () => output };
    } catch {
      // pas encore pret
    }
    await wait(250);
  }
  proc.kill();
  throw new Error(`serveur non demarre :\n${output}`);
}

async function stop(r: Running): Promise<void> {
  if (r.proc.exitCode !== null) return;
  const exited = new Promise((res) => r.proc.once('exit', res));
  r.proc.kill('SIGKILL'); // arret brutal : le cas le plus dur pour le redemarrage
  await exited;
}

describe('commandes des equipements (processus reel)', { timeout: 180_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'psim-e2e-act-'));
  let ports: { web: number; mqtt: number };
  let s: Running;
  let admin = '';
  let operator = '';
  let sirenKey = '';
  let gacheKey = '';
  let sim: MqttSim | null = null;

  const login = async (username: string, password: string) => {
    const res = await fetch(`${s.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(res.status, 200);
    return res.headers.getSetCookie()[0].split(';')[0];
  };
  const api = async (method: string, path: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${s.base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const command = (cookie: string, id: string, body: Record<string, unknown>) => api('POST', `/api/actuators/${id}/commands`, cookie, body);
  const stateOf = async (cookie: string, id: string, cmdId: string) => (await api('GET', `/api/actuators/${id}/commands`, cookie)).body.find((c: { cmdId: string }) => c.cmdId === cmdId);
  const until = async (cookie: string, id: string, cmdId: string, wanted: string) => {
    for (let i = 0; i < 60; i++) {
      const c = await stateOf(cookie, id, cmdId);
      if (c?.state === wanted) return c;
      await wait(50);
    }
    return stateOf(cookie, id, cmdId);
  };

  before(async () => {
    ports = { web: await freePort(), mqtt: await freePort() };
    s = await start(root, ports);
    admin = await login('admin', ADMIN_PW);
    operator = await login('operateur', OPERATOR_PW);
  });
  after(async () => {
    await sim?.close().catch(() => {});
    if (s) await stop(s);
  });

  it("configuration reservee a l'administrateur, anti-CSRF, cle montree une fois, SSRF refuse", async () => {
    assert.equal((await api('GET', '/api/actuators', null)).status, 401);
    assert.equal((await api('POST', '/api/actuators', operator, { id: 'X', name: 'x', type: 'siren', transport: 'mqtt' })).status, 403);
    const csrf = await api('POST', '/api/actuators', admin, { reauth: ADMIN_PW, id: 'X', name: 'x', type: 'siren', transport: 'mqtt' }, { Origin: 'https://attaquant.example' });
    assert.equal(csrf.status, 403);
    const created = await api('POST', '/api/actuators', admin, { reauth: ADMIN_PW, id: 'SIR-01', name: 'Sirene hall', type: 'siren', transport: 'mqtt', actions: { on: { maxS: 60 } } });
    assert.equal(created.status, 201);
    sirenKey = created.body.key;
    assert.match(sirenKey, /^[0-9a-f]{64}$/);
    const gache = await api('POST', '/api/actuators', admin, { reauth: ADMIN_PW, id: 'GACHE-1', name: 'Gache accueil', type: 'lock', transport: 'mqtt' });
    assert.equal(gache.status, 201);
    gacheKey = gache.body.key;
    const list = await api('GET', '/api/actuators', operator);
    assert.equal(list.status, 200);
    assert.ok(!JSON.stringify(list.body).includes(sirenKey));
    assert.deepEqual(list.body.actuators.find((a: { id: string }) => a.id === 'SIR-01').allowed.sort(), ['off', 'on']);
    const ssrf = await api('POST', '/api/actuators', admin, { reauth: ADMIN_PW, id: 'H-1', name: 'h', type: 'light', transport: 'http', http: { requests: { on: { method: 'GET', url: 'http://169.254.169.254/latest/meta-data/' }, off: { method: 'GET', url: 'http://169.254.169.254/' } } } });
    assert.equal(ssrf.status, 400);
    assert.equal((await api('PATCH', '/api/actuators/SIR-01', operator, { active: false })).status, 403);
    assert.equal((await api('DELETE', '/api/actuators/SIR-01', operator)).status, 403);
    assert.equal((await api('POST', '/api/actuators/SIR-01/key', operator)).status, 403);
  });

  it('liaison coupee : refus tant que la passerelle ne les ecoute pas ; puis aller-retour signe', async () => {
    assert.equal((await command(operator, 'SIR-01', { action: 'on', params: { durationS: 20 }, confirm: true })).status, 409);
    sim = await startMqttActuator({ url: s.mqttUrl, username: GW.user, password: GW.password, actuatorId: 'SIR-01', key: sirenKey, mode: 'ack' });
    assert.equal((await command(operator, 'SIR-01', { action: 'on', params: { durationS: 20 } })).status, 428, 'sans confirm');
    const csrf = await api('POST', '/api/actuators/SIR-01/commands', operator, { action: 'on', params: { durationS: 20 }, confirm: true }, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(csrf.status, 403, 'requete inter-sites');
    const r = await command(operator, 'SIR-01', { action: 'on', params: { durationS: 20 }, confirm: true, reason: 'levee de doute' });
    assert.equal(r.status, 201);
    const done = await until(operator, 'SIR-01', r.body.command.cmdId, 'acked');
    assert.equal(done.state, 'acked');
    assert.equal(done.ackKind, 'signed');
    assert.equal(sim.received.length, 1);
    assert.equal(sim.received[0].params.durationS, 20);
    const audit = (await api('GET', '/api/audit?limit=50', admin)).body as { id: number; action: string; details: string | null }[];
    const short = r.body.command.cmdId.slice(0, 8);
    const mine = audit.filter((e) => e.details?.includes(short)).sort((a, b) => a.id - b.id).map((e) => e.action);
    assert.deepEqual(mine.slice(0, 3), ['commande_demandee', 'commande_envoyee', 'commande_accusee'], 'journalisee AVANT l envoi');
    assert.equal((await api('POST', '/api/system/journal/verify', admin)).body.ok, true);
  });

  it('serrure : mot de passe ; limite par minute ; mode maintenance', async () => {
    assert.equal((await command(operator, 'GACHE-1', { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'livreur', password: OPERATOR_PW })).status, 409, 'personne n ecoute la gache');
    const door = await startMqttActuator({ url: s.mqttUrl, username: GW.user, password: GW.password, actuatorId: 'GACHE-1', key: gacheKey, mode: 'ack' });
    try {
      assert.equal((await command(operator, 'GACHE-1', { action: 'unlock', params: { durationS: 5 }, confirm: true, password: OPERATOR_PW })).status, 428, 'sans raison');
      assert.equal((await command(operator, 'GACHE-1', { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'livreur' })).status, 428, 'sans mot de passe');
      assert.equal((await command(operator, 'GACHE-1', { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'livreur', password: 'faux' })).status, 403);
      assert.equal((await command(operator, 'GACHE-1', { action: 'unlock', params: { durationS: 60 }, confirm: true, reason: 'livreur', password: OPERATOR_PW })).status, 400, 'impulsion bornee');
      const ok = await command(operator, 'GACHE-1', { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'livreur', password: OPERATOR_PW });
      assert.equal(ok.status, 201);
      assert.equal((await until(operator, 'GACHE-1', ok.body.command.cmdId, 'acked')).state, 'acked');
      assert.equal(door.received.length, 1);
    } finally {
      await door.close();
    }
    for (const d of [21, 22, 23]) assert.equal((await command(operator, 'SIR-01', { action: 'on', params: { durationS: d }, confirm: true })).status, 201);
    assert.equal((await command(operator, 'SIR-01', { action: 'on', params: { durationS: 24 }, confirm: true })).status, 429);
    assert.equal((await api('PUT', '/api/actuator-lock', operator, { locked: true, reason: 'x' })).status, 403);
    assert.equal((await api('PUT', '/api/actuator-lock', admin, { locked: true, reason: 'travaux sur la sirene', reauth: ADMIN_PW })).status, 200);
    assert.equal((await command(admin, 'SIR-01', { action: 'on', params: { durationS: 24 }, confirm: true })).status, 409, 'verrou : aucune mise en marche');
    assert.equal((await command(admin, 'SIR-01', { action: 'off', confirm: true })).status, 201, 'verrou : l action sure manuelle reste possible (arreter ne doit jamais etre impossible)');
    assert.equal((await api('PUT', '/api/actuator-lock', admin, { locked: false, reauth: ADMIN_PW })).status, 200);
    assert.equal((await command(admin, 'SIR-01', { action: 'off', confirm: true })).status, 201);
  });

  it('redemarrage brutal : la commande en vol expire, rien n est renvoye', async () => {
    assert.equal((await api('PATCH', '/api/actuators/SIR-01', admin, { ackTimeoutS: 30, reauth: ADMIN_PW })).status, 200);
    sim!.mode = 'silent';
    await wait(50);
    const r = await command(admin, 'SIR-01', { action: 'on', params: { durationS: 45 }, confirm: true });
    assert.equal(r.status, 201);
    await wait(300);
    const received = sim!.received.length;
    await stop(s);
    await sim!.close().catch(() => {});
    s = await start(root, ports);
    admin = await login('admin', ADMIN_PW);
    sim = await startMqttActuator({ url: s.mqttUrl, username: GW.user, password: GW.password, actuatorId: 'SIR-01', key: sirenKey, mode: 'silent' });
    await wait(1500);
    assert.equal(sim.received.length, 0, 'aucun ordre rejoue au demarrage');
    assert.ok(received >= 1);
    const after = await stateOf(admin, 'SIR-01', r.body.command.cmdId);
    assert.equal(after.state, 'expired');
    assert.match(after.ack, /jamais renvoyee/);
  });
});
