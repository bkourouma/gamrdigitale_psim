/**
 * Application des agents, contre le vrai serveur (processus separe) : appairage d'un telephone, connexion par code, service,
 * scan d'une etiquette, SOS, et surtout les REFUS du role « agent » hors de ses routes (connexion ordinaire, API d'exploitation,
 * temps reel). Le detail des regles est teste en processus par test/agents.test.ts et test/patrols.test.ts.
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
import { WebSocket } from 'ws';

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';
const PIN = '4821';

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });

interface Reply {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  cookies: string[];
}

describe("application des agents (processus reel)", { timeout: 120_000 }, () => {
  let server: ChildProcess;
  let port = 0;
  let base = '';
  let output = '';

  async function call(method: string, path: string, body?: unknown, cookie?: string): Promise<Reply> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // pas du JSON (image SVG...)
    }
    return { status: res.status, body: parsed, cookies: res.headers.getSetCookie().map((c) => c.split(';')[0]) };
  }

  before(async () => {
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
    Object.assign(env, {
      PSIM_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'psim-agt-')), 'data'),
      PSIM_PORT: String(port),
      PSIM_MQTT_PORT: String(await freePort()),
      PSIM_ADMIN_PASSWORD: ADMIN_PW,
      PSIM_OPERATOR_PASSWORD: OPERATOR_PW,
      PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3',
      PSIM_DEMO_LOGIN: '0',
      PSIM_REQUIRE_2FA: 'none',
      PSIM_PUBLIC_URL: 'https://psim.exemple.test:3034',
    });
    server = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout!.on('data', (d) => (output += d));
    server.stderr!.on('data', (d) => (output += d));
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).status === 200) return;
      } catch {
        // pas encore pret
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`serveur non demarre :\n${output}`);
  });

  after(() => server?.kill());

  const state: { admin: string; operator: string; phone: string; agent: string } = { admin: '', operator: '', phone: '', agent: '' };

  it("l'administrateur cree un agent et un telephone ; l'appairage pose le cookie du telephone", async () => {
    state.admin = (await call('POST', '/api/login', { username: 'admin', password: ADMIN_PW })).cookies[0];
    state.operator = (await call('POST', '/api/login', { username: 'operateur', password: OPERATOR_PW })).cookies[0];
    const created = await call('POST', '/api/agents', { username: 'kouassi', displayName: 'Kouassi', pin: PIN, zones: [] }, state.admin);
    assert.equal(created.status, 201, output);
    const phone = await call('POST', '/api/agent-phones', { label: 'Poste nord' }, state.admin);
    assert.equal(phone.status, 201);
    assert.match(phone.body.pairUrl, /^https:\/\/psim\.exemple\.test:3034\/agent\/#pair=[a-z2-7]{10}$/, "l'adresse publique sert de base");
    const qr = await fetch(`${base}/api/agent-phones/${phone.body.id}/pair.svg`, { headers: { Cookie: state.admin } });
    assert.equal(qr.status, 200);
    assert.match(await qr.text(), /^<svg/);
    const code = String(phone.body.pairUrl).split('#pair=')[1];
    const paired = await call('POST', '/api/agent/pair', { code });
    assert.equal(paired.status, 200);
    assert.ok(paired.cookies[0].startsWith('psim_phone='));
    state.phone = paired.cookies[0];
    assert.equal((await call('POST', '/api/agent/pair', { code })).status, 401, "le code est a usage unique");
  });

  it("connexion par code, service, scan d'une etiquette, position vue par le chef de poste", async () => {
    assert.equal((await call('POST', '/api/agent/login', { username: 'kouassi', pin: '0000' }, state.phone)).status, 401);
    const login = await call('POST', '/api/agent/login', { username: 'kouassi', pin: PIN }, state.phone);
    assert.equal(login.status, 200, output);
    state.agent = `${state.phone}; ${login.cookies.find((c) => c.startsWith('psim_session='))}`;
    assert.equal((await call('POST', '/api/agent/shift/start', {}, state.agent)).body.me.shift !== null, true);
    const floors = await call('GET', '/api/state', undefined, state.admin);
    const floorId = floors.body.floors[0].id as number;
    const point = await call('POST', '/api/patrols/checkpoints', { name: 'Portail', zone: 'Accueil', floorId, x: 20, y: 30 }, state.admin);
    assert.equal(point.status, 201, JSON.stringify(point.body));
    const qr = await fetch(`${base}/api/patrols/checkpoints/${point.body.id}/qr.svg?v=${point.body.code}`, { headers: { Cookie: state.admin } });
    assert.equal(qr.status, 200);
    const scan = await call('POST', '/api/agent/scans', { clientId: 'e2e-scan-0001', code: point.body.code, method: 'qr', phoneAt: Date.now() }, state.agent);
    assert.equal(scan.status, 200, JSON.stringify(scan.body));
    assert.equal(scan.body.scan.checkpoint.name, 'Portail');
    assert.equal(typeof scan.body.scan.deferred, 'boolean');
    assert.equal((await call('POST', '/api/agent/scans', { clientId: 'e2e-scan-0002', code: 'zzzzzzzzzz', method: 'qr', phoneAt: Date.now() }, state.agent)).status, 404);
    const positions = await call('GET', '/api/patrols/positions', undefined, state.operator);
    assert.equal(positions.status, 200);
    assert.deepEqual(positions.body.map((p: { username: string; name: string }) => [p.username, p.name]), [['kouassi', 'Portail']]);
  });

  it("un SOS devient une alarme critique visible du poste de garde et des autres agents", async () => {
    const sos = await call('POST', '/api/agent/sos', { clientId: 'e2e-sos-00001', phoneAt: Date.now(), discreet: false }, state.agent);
    assert.equal(sos.status, 200, output);
    const incident = (await call('GET', '/api/state', undefined, state.operator)).body.incidents.find((i: { id: number }) => i.id === sos.body.incidentId);
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.event, 'sos');
    assert.match(incident.detail, /dernier point Portail/);
    const alarms = await call('GET', '/api/agent/alarms', undefined, state.agent);
    assert.equal(alarms.body.alarms.length, 1);
    // Sans session (code oublie, session expiree) : le SOS part quand meme avec le seul telephone.
    const bare = await call('POST', '/api/agent/sos', { clientId: 'e2e-sos-00002', phoneAt: Date.now() }, state.phone);
    assert.equal(bare.status, 200);
    assert.equal((await call('POST', '/api/agent/sos', { clientId: 'e2e-sos-00003' })).status, 401, 'sans telephone : refuse');
  });

  it("le role agent est refuse partout ailleurs : connexion ordinaire, API d'exploitation, temps reel", async () => {
    const ordinary = await call('POST', '/api/login', { username: 'kouassi', password: PIN });
    assert.equal(ordinary.status, 401);
    const sessionOnly = state.agent.split('; ')[1];
    for (const path of ['/api/state', '/api/audit', '/api/users', '/api/risk', '/api/rules', '/api/arming', '/api/patrols/routes', '/api/patrols/positions', '/api/agents']) {
      assert.equal((await call('GET', path, undefined, sessionOnly)).status, 403, path);
    }
    assert.equal((await call('POST', '/api/incidents/1/ack', {}, sessionOnly)).status, 403);
    assert.equal((await call('POST', '/api/incidents/1/close', { qualification: 'fire' }, sessionOnly)).status, 403);
    assert.equal((await call('GET', '/api/me', undefined, sessionOnly)).status, 200);
    const refused = await new Promise<string>((resolveWs) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: sessionOnly } });
      ws.on('unexpected-response', (_req, res) => resolveWs(`http ${res.statusCode}`));
      ws.on('open', () => resolveWs('ouvert'));
      ws.on('error', () => resolveWs('erreur'));
    });
    assert.notEqual(refused, 'ouvert', '/ws refuse le role agent');
    // Un agent ne peut ni acquitter hors de ses routes ni qualifier : seule la route d'agent acquitte.
    const incidentId = (await call('GET', '/api/agent/alarms', undefined, state.agent)).body.alarms[0].id as number;
    assert.equal((await call('POST', `/api/agent/alarms/${incidentId}/ack`, {}, state.agent)).status, 200);
  });

  it("revoquer le telephone ferme tout : sessions, services, SOS sans code", async () => {
    const phones = await call('GET', '/api/agent-phones', undefined, state.admin);
    const id = phones.body[0].id as number;
    assert.equal((await call('POST', `/api/agent-phones/${id}/revoke`, {}, state.admin)).status, 200);
    const after = await call('GET', '/api/agent/me', undefined, state.agent);
    assert.equal(after.status, 401);
    assert.equal(after.body.error, 'Téléphone non appairé');
    assert.equal((await call('POST', '/api/agent/sos', { clientId: 'e2e-sos-00004' }, state.phone)).status, 401);
    const agents = await call('GET', '/api/agents', undefined, state.operator);
    assert.equal(agents.body.find((a: { username: string }) => a.username === 'kouassi').shift, null, 'service termine par la revocation');
  });
});
