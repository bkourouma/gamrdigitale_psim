/**
 * Controle d'acces, lot AC4, contre le VRAI serveur (processus complet) : lien porte <-> actionneur et issues de secours (F17, F18),
 * fiche de porte `remote`, mode de porte (F19), « Tout ouvrir » (F20) avec de vrais ordres signes recus par des simulateurs de
 * passerelle (test/actuator-sim.ts), droits par role, anti-CSRF, journal infalsifiable. Horloge reelle (la limite de debit par minute
 * y est donc mesuree en vrai) ; la logique fine, a horloge injectee, est dans test/accessremote.test.ts.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { startMqttActuator } from './actuator-sim.ts';
import type { MqttSim } from './actuator-sim.ts';

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';
const TOKEN = 'jeton-equipements-0123456789abcdef';
const GW = { user: 'gw-ouverture', password: 'Mot-de-passe-passerelle-ouverture' };
const ACTUATORS = ['LOCK-1', 'LOCK-2', 'LOCK-3', 'GATE-1', 'ISSUE-1'];

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Started {
  proc: ChildProcess;
  base: string;
  mqttUrl: string;
  dataDir: string;
  output: () => string;
}

async function start(): Promise<Started> {
  const port = await freePort();
  const mqttPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const root = mkdtempSync(join(tmpdir(), 'psim-e2e-ouverture-'));
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
    PSIM_DEMO_LOGIN: '0',
    PSIM_REQUIRE_2FA: 'none',
    PSIM_INGEST_TOKEN: TOKEN,
    PSIM_MQTT_GATEWAYS: JSON.stringify([{ user: GW.user, password: GW.password, actuators: ACTUATORS }]),
  });
  let output = '';
  const proc = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (d) => (output += d));
  proc.stderr!.on('data', (d) => (output += d));
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).status === 200) return { proc, base, mqttUrl: `mqtt://127.0.0.1:${mqttPort}`, dataDir: join(root, 'data'), output: () => output };
    } catch {
      // pas encore pret
    }
    await wait(250);
  }
  proc.kill();
  throw new Error(`serveur non demarre :\n${output}`);
}

describe('controle d acces AC4 : ouverture a distance, issues de secours, mode de porte, Tout ouvrir (processus reel)', { timeout: 240_000 }, () => {
  let s: Started;
  let admin = '';
  let operator = '';
  const keys: Record<string, string> = {};
  const sims: MqttSim[] = [];

  interface Reply {
    status: number;
    body: any;
    text: string;
  }
  const api = async (method: string, path: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const res = await fetch(`${s.base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, text };
  };
  const login = async (username: string, password: string): Promise<string> => {
    const res = await fetch(`${s.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(res.status, 200);
    return res.headers.getSetCookie()[0].split(';')[0];
  };
  const ingest = async (id: string, body: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${s.base}/api/ingest/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const door = async (id: string): Promise<any> => (await api('GET', `/api/access/doors/${id}`, operator)).body;
  const history = async (id: string): Promise<any[]> => (await api('GET', `/api/actuators/${id}/commands`, admin)).body;
  const evacuate = (cookie: string | null, over: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    api('POST', '/api/access/evacuation', cookie, { reason: 'Exercice evacuation', password: ADMIN_PW, confirm: true, confirmPhrase: 'TOUT OUVRIR', ...over }, headers);
  async function until<T>(read: () => Promise<T | undefined | false>, ms = 8000): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = await read();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`condition non atteinte en ${ms} ms\n${s.output().slice(-600)}`);
      await wait(50);
    }
  }

  before(async () => {
    s = await start();
    admin = await login('admin', ADMIN_PW);
    operator = await login('operateur', OPERATOR_PW);
    const make = async (id: string, type: string, extra: Record<string, unknown> = {}) => {
      const r = await api('POST', '/api/actuators', admin, { reauth: ADMIN_PW, id, name: `Actionneur ${id}`, type, transport: 'mqtt', ...extra });
      assert.equal(r.status, 201, r.text);
      keys[id] = r.body.key;
    };
    await make('LOCK-1', 'lock');
    await make('LOCK-2', 'lock');
    await make('LOCK-3', 'lock');
    await make('GATE-1', 'gate');
    await make('ISSUE-1', 'lock', { emergencyExit: true });
    await make('SIR-1', 'siren');
    assert.equal((await api('POST', '/api/access/controllers', admin, { id: 'CTL-1', name: 'Controleur entree', brand: 'dahua' })).status, 201);
    for (const id of ['P-1', 'P-2', 'P-3', 'P-4', 'P-5']) {
      const r = await api('POST', '/api/devices', admin, { id, kind: 'detector', name: `Porte ${id}`, zone: 'Rez-de-chaussee', category: 'access' });
      assert.equal(r.status, 201, r.text);
    }
  });
  after(async () => {
    for (const sim of sims) await sim.close().catch(() => {});
    s?.proc.kill();
  });

  const declare = (detectorId: string, doorNo: number, extra: Record<string, unknown> = {}, cookie = admin) =>
    api('POST', '/api/access/doors', cookie, { detectorId, controllerId: 'CTL-1', doorNo, ...extra });

  // -------------------------------------------------------------------------------------------------------------------------
  it('lien porte <-> actionneur : validation par l\'API (400, 409, F18) et delier', async () => {
    assert.equal((await declare('P-1', 1, { actuatorId: 'FANTOME' })).status, 400, 'actionneur inconnu');
    assert.equal((await declare('P-1', 1, { actuatorId: 'GATE-1' })).status, 400, 'porte -> serrure');
    assert.equal((await declare('P-1', 1, { actuatorId: 'SIR-1' })).status, 400, 'sirene');
    assert.equal((await declare('P-1', 1, { kind: 'barrier', actuatorId: 'LOCK-1' })).status, 400, 'barriere -> portail');
    assert.equal((await declare('P-1', 1, { emergencyExit: true, actuatorId: 'LOCK-1' })).status, 400, 'F18 : la porte seulement');
    assert.equal((await declare('P-1', 1, { actuatorId: 'ISSUE-1' })).status, 400, 'F18 : l\'actionneur seulement');
    const refused = await declare('P-1', 1, { actuatorId: 'ISSUE-1' });
    assert.match(refused.body.error, /Issue de secours/);
    assert.equal((await declare('P-1', 1, { actuatorId: 'LOCK-1' }, operator)).status, 403, 'operateur : refuse');

    assert.equal((await declare('P-1', 1, { actuatorId: 'LOCK-1' })).status, 201);
    assert.equal((await declare('P-2', 2, { actuatorId: 'LOCK-1' })).status, 409, 'un actionneur, une porte');
    assert.equal((await declare('P-2', 2, { actuatorId: 'LOCK-2' })).status, 201);
    assert.equal((await declare('P-3', 3, { actuatorId: 'LOCK-3' })).status, 201);
    assert.equal((await declare('P-4', 4, { kind: 'barrier', actuatorId: 'GATE-1' })).status, 201);
    assert.equal((await api('POST', '/api/access/controllers', admin, { id: 'CTL-2', name: 'Controleur annexe', brand: 'dahua' })).status, 201);
    assert.equal((await api('POST', '/api/access/doors', admin, { detectorId: 'P-5', controllerId: 'CTL-2', doorNo: 1, emergencyExit: true, actuatorId: 'ISSUE-1' })).status, 201);

    // Revalidation au changement de type / d'issue de secours d'une porte deja liee.
    assert.equal((await api('PUT', '/api/access/doors/P-1', admin, { emergencyExit: true })).status, 400);
    assert.equal((await api('PUT', '/api/access/doors/P-5', admin, { emergencyExit: false })).status, 400);
    assert.equal((await api('PUT', '/api/access/doors/P-1', admin, { kind: 'gate' })).status, 400);
    assert.equal((await api('PUT', '/api/access/doors/P-1', admin, { heldAlarmAfterS: 120 })).status, 200);
    // Delier puis relier.
    const unlinked = await api('PUT', '/api/access/doors/P-2', admin, { actuatorId: null });
    assert.equal(unlinked.status, 200);
    assert.equal(unlinked.body.actuatorId, null);
    assert.equal((await door('P-2')).remote.available, false);
    assert.equal((await api('PUT', '/api/access/doors/P-2', admin, { actuatorId: 'LOCK-2' })).status, 200);
    // Desactiver LOCK-3 (reservé a l'administrateur, avec mot de passe).
    assert.equal((await api('PATCH', '/api/actuators/LOCK-3', admin, { reauth: ADMIN_PW, active: false })).status, 200);
  });

  it('fiche de porte : `remote` disponible, ou la raison utile', async () => {
    const ok = await door('P-1');
    assert.deepEqual(ok.remote, { available: true, reason: null, actuatorId: 'LOCK-1', actuatorName: 'Actionneur LOCK-1', actuatorType: 'lock' });
    assert.equal((await door('P-4')).remote.actuatorType, 'gate');
    assert.equal((await door('P-5')).remote.available, true);
    const off = (await door('P-3')).remote;
    assert.equal(off.available, false);
    assert.match(off.reason, /désactivé/);
    // Un administrateur supprime l'actionneur lie : la fiche le dit.
    const tmp = await api('POST', '/api/actuators', admin, { reauth: ADMIN_PW, id: 'TMP-1', name: 'Temporaire', type: 'lock', transport: 'mqtt' });
    assert.equal(tmp.status, 201);
    assert.equal((await api('POST', '/api/access/controllers', admin, { id: 'CTL-3', name: 'Controleur temporaire', brand: 'dahua' })).status, 201);
    assert.equal((await api('POST', '/api/devices', admin, { id: 'P-6', kind: 'detector', name: 'Porte P-6', zone: 'Rez-de-chaussee', category: 'access' })).status, 201);
    assert.equal((await api('POST', '/api/access/doors', admin, { detectorId: 'P-6', controllerId: 'CTL-3', doorNo: 1, actuatorId: 'TMP-1' })).status, 201);
    assert.equal((await api('DELETE', '/api/actuators/TMP-1', admin, { reauth: ADMIN_PW })).status, 200);
    assert.equal((await door('P-6')).remote.reason, "L'actionneur lié n'existe plus");
    assert.equal((await api('DELETE', '/api/access/doors/P-6', admin)).status, 204);
  });

  it('issue de secours : « lock » est refuse a l\'execution par le chemin HTTP reel, y compris avec une configuration falsifiee en base (rien n\'est cree)', async () => {
    const lock = { action: 'lock', confirm: true, reason: 'test', password: ADMIN_PW };
    const honest = await api('POST', '/api/actuators/ISSUE-1/commands', admin, lock);
    assert.ok([400, 403].includes(honest.status), `refus attendu, recu ${honest.status} ${honest.text}`);
    assert.equal((await history('ISSUE-1')).length, 0);
    // Le meme ordre venant d'un operateur : refuse aussi.
    const op = await api('POST', '/api/actuators/ISSUE-1/commands', operator, { ...lock, password: OPERATOR_PW });
    assert.ok([400, 403].includes(op.status), `recu ${op.status}`);

    // Base falsifiee a la main : l'action « lock » reapparait dans la configuration de l'issue de secours.
    const raw = new DatabaseSync(join(s.dataDir, 'psim.db'));
    try {
      raw.exec('PRAGMA busy_timeout = 5000');
      const before = (raw.prepare("SELECT actions FROM actuator WHERE id = 'ISSUE-1'").get() as { actions: string }).actions;
      raw.prepare("UPDATE actuator SET actions = ? WHERE id = 'ISSUE-1'").run(JSON.stringify({ unlock: { minS: 1, maxS: 10, roles: ['operator', 'admin'] }, lock: { roles: ['operator', 'admin'] } }));
      try {
        const forged = await api('POST', '/api/actuators/ISSUE-1/commands', admin, lock);
        assert.equal(forged.status, 403, forged.text);
        assert.match(forged.body.error, /Issue de secours/);
        assert.equal((await api('POST', '/api/actuators/ISSUE-1/commands', operator, { ...lock, password: OPERATOR_PW })).status, 403);
        assert.equal((await history('ISSUE-1')).length, 0, 'aucune commande creee');
      } finally {
        raw.prepare("UPDATE actuator SET actions = ? WHERE id = 'ISSUE-1'").run(before);
      }
    } finally {
      raw.close();
    }
  });

  it('mode de porte : un message du controleur est retenu (derniere valeur, plus ancien ignore, valeur invalide ignoree)', async () => {
    const list0 = (await api('GET', '/api/access/doors', operator)).body as any[];
    assert.ok(list0.length >= 5);
    for (const d of list0) assert.deepEqual([d.doorMode, d.doorModeLabel, d.doorModeAt], [null, null, null], d.detectorId);
    const t = Date.now() - 5000;
    // Un etat accompagne de `doorMode` traverse le moteur reel d'aujourd'hui.
    const first = await ingest('P-1', { state: 'normal', doorMode: 'always_open', ts: t, msgId: 'mode-1' });
    assert.ok(first.status >= 200 && first.status < 300, JSON.stringify(first));
    let p1 = (await door('P-1')).door;
    assert.equal(p1.doorMode, 'always_open');
    assert.equal(p1.doorModeLabel, 'Ouverte en permanence (réglée dans le contrôleur)');
    assert.equal(p1.doorModeAt, t);
    // Plus ancien : ignore.
    await ingest('P-1', { state: 'normal', doorMode: 'always_closed', ts: t - 2000, msgId: 'mode-0' });
    assert.equal((await door('P-1')).door.doorMode, 'always_open');
    // Valeur invalide : ignoree, le message reste accepte.
    const bad = await ingest('P-1', { state: 'normal', doorMode: 'grand-ouvert', ts: t + 1000, msgId: 'mode-2' });
    assert.ok(bad.status >= 200 && bad.status < 300);
    assert.equal((await door('P-1')).door.doorMode, 'always_open');
    // Plus recent : retenu.
    await ingest('P-1', { state: 'normal', doorMode: 'normal', ts: t + 2000, msgId: 'mode-3' });
    p1 = (await door('P-1')).door;
    assert.equal(p1.doorMode, 'normal');
    assert.equal(p1.doorModeLabel, 'Mode normal : les badges fonctionnent');
    assert.equal((await door('P-2')).door.doorMode, null, 'les autres portes ne bougent pas');
    // Le changement de mode est au journal infalsifiable.
    const log = (await api('GET', '/api/audit?limit=300', admin)).body as { action: string; deviceId?: string; details: string }[];
    assert.ok(log.filter((e) => e.action === 'access_door_mode').length >= 2);
  });

  it('mode de porte : le message `event: "door_mode"` face au moteur reel (dependance de fusion : server/sources.ts)', async () => {
    const t = Date.now() - 1000;
    const r = await ingest('P-1', { event: 'door_mode', doorMode: 'always_closed', ts: t, msgId: 'mode-evt-1' });
    if (r.status >= 200 && r.status < 300) {
      // sources.ts connait l'evenement (branche fusionnee) : le mode est retenu.
      assert.equal((await door('P-1')).door.doorMode, 'always_closed');
    } else {
      // Etat d'aujourd'hui : le moteur rejette l'evenement inconnu AVANT le crochet d'acces (non contourne ici).
      assert.equal(r.status, 400);
      assert.match(r.body.error, /event inconnu/);
      assert.equal((await door('P-1')).door.doorMode, 'normal');
    }
  });

  // -------------------------------------------------------------------------------------------------------------------------
  describe('Tout ouvrir', () => {
    it('droits : session obligatoire (401), administrateur seulement (403), anti-CSRF', async () => {
      assert.equal((await api('GET', '/api/access/evacuation', null)).status, 401);
      assert.equal((await api('POST', '/api/access/evacuation', null, {})).status, 401);
      assert.equal((await api('GET', '/api/access/evacuation', operator)).status, 403);
      assert.equal((await evacuate(operator, { password: OPERATOR_PW })).status, 403);
      assert.equal((await evacuate(admin, {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'requete inter-sites');
      assert.equal((await evacuate(admin, {}, { Origin: 'https://attaquant.example' })).status, 403);
      for (const id of ACTUATORS) assert.equal((await history(id)).length, 0, `${id} : rien n'a ete envoye`);
    });

    it('apercu : portes liees, pret ou probleme (liaison coupee, actionneur desactive), aucun secret', async () => {
      const r = await api('GET', '/api/access/evacuation', admin);
      assert.equal(r.status, 200);
      const by = Object.fromEntries((r.body.doors as any[]).map((d) => [d.doorId, d]));
      assert.deepEqual(Object.keys(by).sort(), ['P-1', 'P-2', 'P-3', 'P-4', 'P-5']);
      assert.equal(by['P-1'].action, 'unlock');
      assert.equal(by['P-4'].action, 'open');
      assert.equal(by['P-1'].maxDurationS, 10);
      for (const id of ['P-1', 'P-2', 'P-4', 'P-5']) assert.equal(by[id].ready, false, `${id} : aucune passerelle encore a l'ecoute`);
      assert.match(by['P-1'].problem, /passerelle/);
      assert.match(by['P-3'].problem, /désactivé/);
      for (const k of Object.values(keys)) assert.ok(!r.text.includes(k), 'aucune cle d\'actionneur');
      assert.ok(!/transport_secret|key_sealed|password/i.test(r.text));
    });

    it('confirmation, raison, mot de passe : 428 / 403 ; rien n\'est envoye ni cree ; echec journalise a part', async () => {
      const sim = await startMqttActuator({ url: s.mqttUrl, username: GW.user, password: GW.password, actuatorId: 'LOCK-1', key: keys['LOCK-1'], mode: 'ack' });
      sims.push(sim);
      await until(async () => (await api('GET', '/api/access/evacuation', admin)).body.doors.find((d: any) => d.doorId === 'P-1').ready);
      assert.equal((await evacuate(admin, { confirm: undefined })).status, 428);
      assert.equal((await evacuate(admin, { confirmPhrase: 'tout ouvrir' })).status, 428);
      assert.equal((await evacuate(admin, { confirmPhrase: undefined })).status, 428);
      assert.equal((await evacuate(admin, { reason: '' })).status, 428);
      assert.equal((await evacuate(admin, { password: undefined })).status, 428);
      assert.equal((await evacuate(admin, { durationS: 99999 })).status, 400);
      assert.equal((await evacuate(admin, { password: 'faux-mot-de-passe-9' })).status, 403);
      assert.equal((await history('LOCK-1')).length, 0);
      assert.equal(sim.received.length, 0, 'rien n\'est parti');
      const log = (await api('GET', '/api/audit?limit=300', admin)).body as { action: string; details: string }[];
      assert.equal(log.filter((e) => e.action === 'access_evacuation_reauth_echec').length, 1);
      assert.equal(log.filter((e) => e.action === 'access_evacuation').length, 0);
      assert.ok(!JSON.stringify(log).includes('faux-mot-de-passe-9'));
    });

    it('evacuation : ordres signes recus par les passerelles, resultats porte par porte, journal avant/apres, accuses temps reel', async () => {
      const gate = await startMqttActuator({ url: s.mqttUrl, username: GW.user, password: GW.password, actuatorId: 'GATE-1', key: keys['GATE-1'], mode: 'ack' });
      const issue = await startMqttActuator({ url: s.mqttUrl, username: GW.user, password: GW.password, actuatorId: 'ISSUE-1', key: keys['ISSUE-1'], mode: 'ack' });
      sims.push(gate, issue);
      const lock1 = sims[0];
      await until(async () => {
        const doors = (await api('GET', '/api/access/evacuation', admin)).body.doors as any[];
        return ['P-1', 'P-4', 'P-5'].every((id) => doors.find((d) => d.doorId === id).ready);
      });
      const res = await evacuate(admin, { reason: 'Exercice d\'evacuation du batiment', durationS: 8 });
      assert.equal(res.status, 200, res.text);
      assert.match(res.body.batchId, /^[0-9a-f]{16}$/);
      assert.ok(Math.abs(res.body.at - Date.now()) < 10_000);
      assert.deepEqual(res.body.counts, { total: 5, sent: 3, failed: 2 });
      const by = Object.fromEntries((res.body.results as any[]).map((r) => [r.doorId, r]));
      for (const id of ['P-1', 'P-4', 'P-5']) {
        assert.equal(by[id].status, 'sent', id);
        assert.match(by[id].cmdId, /^[0-9a-f]{32}$/);
        assert.equal(by[id].durationS, 8);
      }
      assert.equal(by['P-2'].status, 'no_gateway');
      assert.equal(by['P-3'].status, 'refused');
      assert.match(by['P-3'].error, /désactivé/);
      // Les accuses arrivent ensuite, comme pour une commande normale.
      for (const [id, doorId] of [['LOCK-1', 'P-1'], ['GATE-1', 'P-4'], ['ISSUE-1', 'P-5']] as const) {
        const c = await until(async () => {
          const found = (await history(id)).find((x) => x.cmdId === by[doorId].cmdId);
          return found?.state === 'acked' ? found : false;
        });
        assert.equal(c.ackKind, 'signed');
        assert.equal(c.requestedBy, 'admin');
        assert.match(c.reason, /^Tout ouvrir \(lot [0-9a-f]{8}\) : Exercice d'evacuation/);
      }
      assert.equal(lock1.received.length, 1);
      assert.equal(lock1.received[0].action, 'unlock');
      assert.equal(lock1.received[0].params.durationS, 8);
      assert.equal(gate.received[0].action, 'open');
      assert.equal(issue.received[0].action, 'unlock', 'l\'issue de secours est deverrouillee, jamais verrouillee');
      assert.equal((await history('LOCK-2')).length, 0);
      assert.equal((await history('LOCK-3')).length, 0);
      // Journal : l'evacuation precede les commandes, le bilan les suit ; la chaine est intacte.
      const log = ((await api('GET', '/api/audit?limit=300', admin)).body as { id: number; action: string; actor: string; details: string }[]).sort((a, b) => a.id - b.id);
      const start = log.find((e) => e.action === 'access_evacuation')!;
      const firstCmd = log.find((e) => e.action === 'commande_demandee' && e.details.includes('Tout ouvrir'))!;
      const bilan = log.find((e) => e.action === 'access_evacuation_bilan')!;
      assert.ok(start && firstCmd && bilan);
      assert.ok(start.id < firstCmd.id && firstCmd.id < bilan.id);
      assert.equal(start.actor, 'admin');
      assert.match(start.details, /5 porte\(s\)/);
      assert.match(bilan.details, /3 porte\(s\) sur 5/);
      assert.equal((await api('POST', '/api/system/journal/verify', admin)).body.ok, true);
    });

    it('limite : deux evacuations par minute et par administrateur, la troisieme est refusee (429) avant tout mot de passe', async () => {
      const second = await evacuate(admin);
      assert.equal(second.status, 200, second.text);
      const third = await evacuate(admin);
      assert.equal(third.status, 429, third.text);
      assert.equal((await evacuate(admin, { password: 'faux-mot-de-passe-9' })).status, 429);
    });
  });

  it('aucun secret d\'actionneur ni mot de passe dans les reponses de lecture du lot (portes, fiche, apercu)', async () => {
    const texts = [(await api('GET', '/api/access/doors', operator)).text, (await api('GET', '/api/access/doors/P-1', operator)).text, (await api('GET', '/api/access/evacuation', admin)).text];
    for (const t of texts) {
      for (const k of Object.values(keys)) assert.ok(!t.includes(k));
      assert.ok(!t.includes(ADMIN_PW) && !t.includes(OPERATOR_PW));
    }
  });
});
