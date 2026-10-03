/**
 * Entree HTTP des equipements (controle d'acces, passerelles IoT), contre le vrai serveur : jeton, validation,
 * incident d'intrusion avec capture de la camera liee, mesure de capteur, categories dans l'inventaire.
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

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';
const TOKEN = 'jeton-equipements-0123456789abcdef';

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
    PSIM_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'psim-src-')), 'data'),
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

describe("entree HTTP des equipements (processus reel)", { timeout: 120_000 }, () => {
  let main: Awaited<ReturnType<typeof start>>;
  let cookie = '';

  const ingest = (id: string, body: unknown, token: string | null = TOKEN, base = main.base) =>
    fetch(`${base}/api/ingest/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(`${main.base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  before(async () => {
    main = await start({ PSIM_INGEST_TOKEN: TOKEN });
    const res = await fetch(`${main.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PW }) });
    assert.equal(res.status, 200);
    cookie = res.headers.getSetCookie()[0].split(';')[0];
  });

  after(() => main?.proc.kill());

  it("sans jeton, avec un mauvais jeton ou un jeton de longueur differente : 401, et rien ne change", async () => {
    assert.equal((await ingest('A-01', { event: 'door_forced' }, null)).status, 401);
    assert.equal((await ingest('A-01', { event: 'door_forced' }, 'mauvais')).status, 401);
    assert.equal((await ingest('A-01', { event: 'door_forced' }, TOKEN + 'x')).status, 401);
    const state = (await api('GET', '/api/state')).body;
    assert.equal(state.incidents.length, 0);
  });

  it("un evenement authentifie ouvre un incident d'acces critique, avec sa categorie et sa camera liee", async () => {
    const res = await ingest('A-01', { event: 'door_forced' });
    assert.equal(res.status, 204);
    const state = (await api('GET', '/api/state')).body;
    const incident = state.incidents.find((i: any) => i.detectorId === 'A-01');
    assert.equal(incident.category, 'access');
    assert.equal(incident.severity, 'critical');
    assert.deepEqual(incident.cameraIds, ['C-04']);
  });

  it("une mesure de temperature franchit les seuils configures et reste affichee", async () => {
    assert.equal((await ingest('E-01', { value: 41.5 })).status, 204);
    const state = (await api('GET', '/api/state')).body;
    const device = state.devices.find((d: any) => d.id === 'E-01');
    assert.equal(device.status, 'alarm');
    assert.equal(device.lastValue, 41.5);
    assert.equal(device.valueUnit, '°C');
  });

  it("messages invalides : 400 ; equipement inconnu ou camera : 404 ; JSON casse ou trop gros : refuse", async () => {
    assert.equal((await ingest('A-01', { event: 'inconnu' })).status, 400);
    assert.equal((await ingest('A-01', { value: 'chaud' })).status, 400);
    assert.equal((await ingest('A-01', {})).status, 400);
    assert.equal((await ingest('NOPE', { state: 'alarm' })).status, 404);
    assert.equal((await ingest('C-01', { state: 'alarm' })).status, 404);
    const broken = await ingest('A-01', '{pas du json');
    assert.ok(broken.status >= 400 && broken.status < 500);
    const big = await ingest('A-01', { event: 'ping', pad: 'x'.repeat(5000) });
    assert.equal(big.status, 413);
  });

  it("la categorie et les seuils se reglent depuis l'inventaire (administrateur uniquement)", async () => {
    const created = await api('POST', '/api/devices', { id: 'E-09', kind: 'detector', category: 'environment', name: 'Chambre froide', zone: 'Stockage', valueUnit: '°C', warnAt: 6, alarmAt: 8 });
    assert.equal(created.status, 201);
    assert.equal(created.body.category, 'environment');
    assert.equal(created.body.heartbeatS, 0);
    assert.equal((await ingest('E-09', { value: 9 })).status, 204);
    assert.equal((await api('GET', '/api/state')).body.devices.find((d: any) => d.id === 'E-09').status, 'alarm');
    const bad = await api('PATCH', '/api/devices/E-09', { warnAt: 20 });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /inferieur/);

    // un operateur n'a aucun droit sur l'inventaire
    const op = await fetch(`${main.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'operateur', password: OPERATOR_PW }) });
    const opCookie = op.headers.getSetCookie()[0].split(';')[0];
    const denied = await fetch(`${main.base}/api/devices/E-09`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: opCookie }, body: JSON.stringify({ alarmAt: 99 }) });
    assert.equal(denied.status, 403);
  });

  it("armement : l'operateur desarme pour une duree limitee, seul l'administrateur regle le planning", async () => {
    const op = await fetch(`${main.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'operateur', password: OPERATOR_PW }) });
    const opCookie = op.headers.getSetCookie()[0].split(';')[0];
    const as = async (who: string, method: string, path: string, body?: unknown) => {
      const res = await fetch(`${main.base}${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: who }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const state = async () => (await api('GET', '/api/state')).body;

    assert.equal((await state()).arming.Accueil, true, 'armee par defaut');
    const zones = await as(opCookie, 'GET', '/api/arming');
    assert.deepEqual(zones.body.map((z: any) => [z.zone, z.armed, z.source]), [['Accueil', true, 'default']]);

    // un desarmement sans duree, ou trop long, est refuse
    assert.equal((await as(opCookie, 'PUT', '/api/arming/Accueil/override', { mode: 'disarmed' })).status, 400);
    assert.equal((await as(opCookie, 'PUT', '/api/arming/Accueil/override', { mode: 'disarmed', hours: 48 })).status, 400);
    assert.equal((await as(opCookie, 'PUT', '/api/arming/Bureaux/override', { mode: 'disarmed', hours: 1 })).status, 404);

    assert.equal((await as(opCookie, 'PUT', '/api/arming/Accueil/override', { mode: 'disarmed', hours: 2 })).body.armed, false);
    assert.equal((await state()).arming.Accueil, false);
    assert.equal((await ingest('I-01', { event: 'motion' })).status, 204);
    assert.equal((await state()).incidents.some((i: any) => i.detectorId === 'I-01'), false, 'mouvement ignore');
    assert.equal((await ingest('I-01', { event: 'tamper' })).status, 204);
    assert.equal((await state()).incidents.some((i: any) => i.detectorId === 'I-01'), true, 'le sabotage alarme toujours');

    // le planning est reserve a l'administrateur
    const schedule = [{ days: [1, 2, 3, 4, 5], from: '19:00', to: '07:00' }];
    assert.equal((await as(opCookie, 'PUT', '/api/arming/Accueil/schedule', { schedule })).status, 403);
    assert.equal((await as(cookie, 'PUT', '/api/arming/Accueil/schedule', { schedule: [{ days: [9], from: '19:00', to: '07:00' }] })).status, 400);
    assert.equal((await as(cookie, 'PUT', '/api/arming/Accueil/schedule', { schedule })).status, 200);

    const back = await as(opCookie, 'DELETE', '/api/arming/Accueil/override');
    assert.equal(back.status, 200);
    assert.equal(back.body.source, 'schedule');
    const journal = (await api('GET', '/api/audit?limit=50')).body.map((e: any) => `${e.actor}:${e.action}`);
    assert.ok(journal.includes('operateur:zone_disarmed') && journal.includes('admin:arming_schedule'));
    assert.ok(journal.includes('systeme:intrusion_ignored'));
    // retour a un etat neutre pour les tests suivants
    await as(cookie, 'PUT', '/api/arming/Accueil/schedule', { schedule: null });
  });

  it("rapports : HTML imprimable, exports CSV, fiche d'incident ; journal complet reserve a l'administrateur", async () => {
    const op = await fetch(`${main.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'operateur', password: OPERATOR_PW }) });
    const opCookie = op.headers.getSetCookie()[0].split(';')[0];
    const get = (path: string, who: string | null = cookie) => fetch(`${main.base}${path}`, { headers: who ? { Cookie: who } : {} });

    assert.equal((await get('/api/reports/incidents', null)).status, 401, 'sans session : refuse');
    assert.equal((await get('/api/reports/incidents.csv', null)).status, 401);

    const html = await get('/api/reports/incidents');
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(html.headers.get('cache-control'), 'no-store');
    const page = await html.text();
    assert.match(page, /Rapport d'incidents/);
    assert.match(page, /\/report\.css/);
    assert.ok(!/<script>/.test(page), 'aucun script en ligne (politique de securite)');
    assert.equal((await get('/report.css')).status, 200);
    assert.equal((await get('/report.js')).status, 200);

    const csv = await get('/api/reports/incidents.csv?category=access');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition') ?? '', /^attachment; filename="incidents_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"$/);
    const bytes = Buffer.from(await csv.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM UTF-8 (fetch le retire du texte : on lit les octets)');
    const text = bytes.toString('utf8');
    assert.ok(text.includes('N°;'));
    assert.match(text, /A-01/, "l'incident de porte forcee y figure");
    assert.ok(!/I-01/.test(text), 'filtre par categorie');

    assert.equal((await get('/api/reports/incidents?from=pas-une-date')).status, 400);
    assert.equal((await get('/api/reports/incidents.csv?category=gaz')).status, 400);
    assert.equal((await get('/api/reports/incidents.csv?from=2020-01-01&to=2026-01-01')).status, 400);

    const state = (await api('GET', '/api/state')).body;
    const id = state.incidents.find((i: any) => i.detectorId === 'A-01').id;
    const fiche = await get(`/api/reports/incidents/${id}`, opCookie);
    assert.equal(fiche.status, 200, "l'operateur peut lire une fiche");
    assert.match(await fiche.text(), /Fiche d'incident/);
    assert.equal((await get('/api/reports/incidents/99999')).status, 404);
    assert.equal((await get('/api/reports/incidents/abc')).status, 404);

    assert.equal((await get('/api/reports/audit.csv', opCookie)).status, 403, 'journal complet : administrateur');
    const audit = await get('/api/reports/audit.csv');
    assert.equal(audit.status, 200);
    assert.match(await audit.text(), /report_exported/, 'les exports precedents sont tracables');
  });

  it("le jeton ne figure ni dans les journaux du serveur ni dans les reponses", async () => {
    assert.ok(!main.output().includes(TOKEN));
    const system = JSON.stringify((await api('GET', '/api/system')).body) + JSON.stringify((await api('GET', '/api/notifications/status')).body);
    assert.ok(!system.includes(TOKEN));
  });

  it("cinq echecs d'authentification en une minute bloquent l'adresse (429), meme avec le bon jeton", async () => {
    const other = await start({ PSIM_INGEST_TOKEN: TOKEN });
    try {
      for (let i = 0; i < 5; i++) assert.equal((await ingest('A-01', { event: 'ping' }, 'faux', other.base)).status, 401);
      assert.equal((await ingest('A-01', { event: 'ping' }, TOKEN, other.base)).status, 429);
    } finally {
      other.proc.kill();
    }
  });

  it("sans jeton configure (ou trop court), l'entree HTTP n'existe pas du tout", async () => {
    for (const extra of [{} as Record<string, string>, { PSIM_INGEST_TOKEN: 'court' }]) {
      const s = await start(extra);
      try {
        assert.equal((await ingest('A-01', { event: 'door_forced' }, 'court', s.base)).status, 404);
        assert.equal((await ingest('A-01', { event: 'door_forced' }, null, s.base)).status, 404);
        if ('PSIM_INGEST_TOKEN' in extra) assert.match(s.output(), /Jeton d'entree des equipements/, 'le contrôle de démarrage le signale');
      } finally {
        s.proc.kill();
      }
    }
  });
});
