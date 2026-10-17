/**
 * GARDE-FOU DURABLE : attaques contre le VRAI serveur (processus complet) sur les routes /api/actuators* et /api/users*.
 * Un cookie de session administrateur vole (mot de passe INCONNU) ne doit plus suffire a creer un compte, changer la
 * configuration d'une serrure, renouveler une cle ni activer le mode maintenance : le serveur redemande le mot de passe
 * du compte connecte (428 s'il manque, 403 s'il est faux, session fermee au cinquieme faux mot de passe).
 * Autonome : ne depend d'aucun fichier hors de test/.
 *
 * Lancer : node --test test/garde-e2e-commandes.test.ts
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

describe('garde-fou commandes : cookie vole et attaques (processus reel)', { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'psim-garde-e2e-'));
  let proc: ChildProcess;
  let base = '';
  let mqttUrl = '';
  let output = '';
  let admin = '';
  let operator = '';
  let sim: MqttSim | null = null;

  const login = async (username: string, password: string) => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(res.status, 200, `connexion ${username}`);
    return res.headers.getSetCookie()[0].split(';')[0];
  };
  const api = async (method: string, path: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}, raw?: string) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // texte brut
    }
    return { status: res.status, body: parsed as Record<string, any>, headers: res.headers };
  };

  before(async () => {
    const web = await freePort();
    const mqtt = await freePort();
    base = `http://127.0.0.1:${web}`;
    mqttUrl = `mqtt://127.0.0.1:${mqtt}`;
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
    Object.assign(env, {
      PSIM_DATA_DIR: join(root, 'data'),
      PSIM_BACKUP_DIR: join(root, 'backups'),
      PSIM_PORT: String(web),
      PSIM_MQTT_PORT: String(mqtt),
      PSIM_ADMIN_PASSWORD: ADMIN_PW,
      PSIM_OPERATOR_PASSWORD: OPERATOR_PW,
      PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3',
      PSIM_DEMO_LOGIN: '0',
      PSIM_REQUIRE_2FA: 'none',
      PSIM_MQTT_GATEWAYS: JSON.stringify([{ user: GW.user, password: GW.password, actuators: ['SIR-01', 'GACHE-1'] }]),
      PSIM_ACTUATOR_HTTP_HOSTS: '127.0.0.1',
    });
    proc = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout!.on('data', (d) => (output += d));
    proc.stderr!.on('data', (d) => (output += d));
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).status === 200) break;
      } catch {
        // pas pret
      }
      await wait(250);
    }
    admin = await login('admin', ADMIN_PW);
    operator = await login('operateur', OPERATOR_PW);
  });
  after(async () => {
    await sim?.close().catch(() => {});
    if (proc && proc.exitCode === null) {
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill('SIGKILL');
      await exited;
    }
  });

  it('CONTROLE : la cle n apparait ni dans la liste, ni dans le journal, ni dans les journaux du processus ; reponse non mise en cache', async () => {
    const created = await api('POST', '/api/actuators', admin, { id: 'SIR-01', name: 'Sirene hall', type: 'siren', transport: 'mqtt', reauth: ADMIN_PW });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    const key = created.body.key as string;
    sim = await startMqttActuator({ url: mqttUrl, username: GW.user, password: GW.password, actuatorId: 'SIR-01', key, mode: 'ack' });
    const r = await api('POST', '/api/actuators/SIR-01/commands', operator, { action: 'on', params: { durationS: 20 }, confirm: true });
    assert.equal(r.status, 201);
    await wait(300);
    const rotated = await api('POST', '/api/actuators/SIR-01/key', admin, { reauth: ADMIN_PW });
    for (const k of [key, rotated.body.key as string]) {
      for (const who of [admin, operator]) {
        assert.ok(!JSON.stringify((await api('GET', '/api/actuators', who)).body).includes(k));
        assert.ok(!JSON.stringify((await api('GET', '/api/audit?limit=500', who)).body).includes(k));
        assert.ok(!JSON.stringify((await api('GET', '/api/actuators/SIR-01/commands', who)).body).includes(k));
        assert.ok(!JSON.stringify((await api('GET', '/api/state', who)).body).includes(k));
      }
      assert.ok(!output.includes(k), 'pas dans la sortie du processus');
    }
  });

  it('CONTROLE : CSRF sur l annulation (sans corps JSON), corps text/plain, Origin etrangere, Origin « null »', async () => {
    const cmd = (await api('GET', '/api/actuators/SIR-01/commands', admin)).body[0] as { cmdId: string };
    for (const h of [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'https://attaquant.example' }, { Origin: 'null' }] as Record<string, string>[]) {
      assert.equal((await api('POST', `/api/actuators/commands/${cmd.cmdId}/cancel`, operator, undefined, h)).status, 403, JSON.stringify(h));
    }
    const plain = await api('POST', '/api/actuators/SIR-01/commands', operator, undefined, { 'Content-Type': 'text/plain' }, JSON.stringify({ action: 'on', params: { durationS: 21 }, confirm: true }));
    assert.equal(plain.status, 400, 'text/plain : non lu comme JSON, action absente');
    const form = await api('POST', '/api/actuators/SIR-01/commands', operator, undefined, { 'Content-Type': 'application/x-www-form-urlencoded' }, 'action=on&confirm=true&params[durationS]=22');
    assert.ok(form.status === 400 || form.status === 428, `formulaire : ${form.status}`);
  });

  it('CONTROLE : session restreinte (mot de passe a changer) ne commande rien ; operateur sans droit admin', async () => {
    assert.equal((await api('POST', '/api/users', admin, { username: 'nouvel-op', role: 'operator', password: 'Mot-de-passe-provisoire-9', reauth: ADMIN_PW })).status, 201);
    const restricted = await login('nouvel-op', 'Mot-de-passe-provisoire-9');
    assert.equal((await api('GET', '/api/actuators', restricted)).status, 403);
    assert.equal((await api('POST', '/api/actuators/SIR-01/commands', restricted, { action: 'on', params: { durationS: 20 }, confirm: true })).status, 403);
    for (const [m, p, b] of [
      ['PATCH', '/api/actuators/SIR-01', { actions: { on: { maxS: 600, unbounded: true, roles: ['operator'] } } }],
      ['PUT', '/api/actuator-lock', { locked: true, reason: 'x' }],
      ['POST', '/api/actuators/SIR-01/key', {}],
      ['DELETE', '/api/actuators/SIR-01', undefined],
      ['POST', '/api/actuators', { id: 'X', name: 'x', type: 'siren', transport: 'mqtt' }],
    ] as const) {
      assert.equal((await api(m, p, operator, b)).status, 403, `${m} ${p}`);
    }
  });

  it('GARDE-FOU A6 : le cookie admin SEUL (mot de passe inconnu) ne peut ni creer un compte, ni changer une serrure, ni renouveler une cle, ni verrouiller les commandes ; le bon mot de passe suffit', async () => {
    const gache = await api('POST', '/api/actuators', admin, { id: 'GACHE-1', name: 'Gache accueil', type: 'lock', transport: 'mqtt', reauth: ADMIN_PW });
    assert.equal(gache.status, 201, JSON.stringify(gache.body));
    const FAUX = 'Je-ne-connais-pas-le-mot-de-passe-0';
    const ops: { nom: string; run: (reauth?: string) => Promise<{ status: number; body: Record<string, any> }> }[] = [
      { nom: 'creer un compte', run: (reauth) => api('POST', '/api/users', admin, { username: 'complice', role: 'operator', password: 'Mot-de-passe-du-voleur-7', reauth }) },
      { nom: 'changer la configuration d une serrure', run: (reauth) => api('PATCH', '/api/actuators/GACHE-1', admin, { ackTimeoutS: 7, reauth }) },
      { nom: 'renouveler une cle', run: (reauth) => api('POST', '/api/actuators/GACHE-1/key', admin, { reauth }) },
      { nom: 'activer le mode maintenance', run: (reauth) => api('PUT', '/api/actuator-lock', admin, { locked: true, reason: 'travaux', reauth }) },
    ];
    // 1. Sans mot de passe : 428, rien n'est fait. 2. Avec un faux : 403 (quatre echecs au total, sous le seuil de cinq).
    for (const op of ops) {
      assert.equal((await op.run()).status, 428, `${op.nom} : sans mot de passe`);
      assert.equal((await op.run('')).status, 428, `${op.nom} : mot de passe vide`);
    }
    for (const op of ops) assert.equal((await op.run(FAUX)).status, 403, `${op.nom} : faux mot de passe`);
    assert.equal((await api('GET', '/api/actuators', admin)).body.lock.locked, false, 'le mode maintenance n a pas ete active');
    assert.ok(!(await api('GET', '/api/users', admin)).body.some((u: { username: string }) => u.username === 'complice'), 'aucun compte cree');
    const audit = JSON.stringify((await api('GET', '/api/audit?limit=200', admin)).body);
    assert.ok(audit.includes('reauth_echec'), 'les refus sont journalises');
    assert.ok(!audit.includes(FAUX), 'le faux mot de passe n est jamais journalise');
    // 3. Avec le bon mot de passe, chaque operation passe (un succes ne compte pas comme un echec).
    for (const op of ops) {
      const r = await op.run(ADMIN_PW);
      assert.ok(r.status === 200 || r.status === 201, `${op.nom} : bon mot de passe -> ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.equal((await api('PUT', '/api/actuator-lock', admin, { locked: false, reauth: ADMIN_PW })).status, 200, 'la fin de maintenance redemande aussi le mot de passe');
    // 4. Cinquieme faux mot de passe : refuse, et la session du voleur est fermee (la requete suivante donne 401).
    assert.equal((await ops[0].run(FAUX)).status, 403);
    assert.equal((await api('GET', '/api/me', admin)).status, 401, 'session fermee au cinquieme faux mot de passe');
    assert.equal((await ops[0].run(ADMIN_PW)).status, 401, 'le cookie vole ne sert plus a rien, meme avec le bon mot de passe');
  });
});
