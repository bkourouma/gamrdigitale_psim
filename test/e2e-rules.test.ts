/**
 * Regles de presence (lot P3), contre le vrai serveur : droits, cycle de vie complet, validations en francais, detecteur
 * virtuel R-<id> dans l'etat du site, refus de le supprimer par l'inventaire, essai sur le passe, et la chaine complete
 * (faux enregistreur Dahua -> observation -> presence -> regle -> incident) sans aucun appareil reel.
 *
 * La fin d'une presence ne se constate qu'apres 60 s de lissage : elle est verifiee dans le test d'integration en
 * processus (horloge maitrisee), pas dans le test du processus reel.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createDahuaEvents, openEventStream } from '../server/dahua.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { createFaceObs } from '../server/faceobs.ts';
import { createPresence } from '../server/presence.ts';
import { createRules } from '../server/rules.ts';
import { seal } from '../server/secrets.ts';
import { seedDemo } from '../server/seed.ts';
import { eventLabel } from '../server/sources.ts';

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';
const USER = 'psim';
const PASSWORD = 'MotDePasse-XVR-1';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`delai depasse : ${what}`);
    await wait(25);
  }
}

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });

// ---------------------------------------------------------------- faux enregistreur Dahua (Digest + flux multipart)

const GROUPS_PATH = '/cgi-bin/faceRecognitionServer.cgi?action=findGroup';

/** `address` : adresse locale d'ecoute (127.0.0.x : plusieurs appareils) ; `groups` : reponse de findGroup (absent : 404). */
function fakeRecorder(opts: { address?: string; groups?: string } = {}) {
  const md5 = (s: string) => createHash('md5').update(s).digest('hex');
  const realm = 'Login to XVR';
  const nonce = randomBytes(8).toString('hex');
  const streams = new Set<ServerResponse>();
  const send = (res: ServerResponse, body: string) => res.write(`--myboundary\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  const server = createHttpServer((req, res) => {
    const auth = String(req.headers.authorization ?? '');
    const p = Object.fromEntries([...auth.matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1], m[2]]));
    const expected = md5(`${md5(`${USER}:${realm}:${PASSWORD}`)}:${nonce}:${p.nc}:${p.cnonce}:auth:${md5(`GET:${p.uri}`)}`);
    if (!auth.startsWith('Digest') || p.username !== USER || p.response !== expected || p.uri !== req.url) {
      res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}", opaque="abc"` }).end();
      return;
    }
    if (req.url === GROUPS_PATH) {
      if (opts.groups === undefined) res.writeHead(404).end();
      else res.writeHead(200, { 'Content-Type': 'text/plain' }).end(opts.groups);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=myboundary' });
    streams.add(res);
    res.on('close', () => streams.delete(res));
    send(res, 'Heartbeat');
  });
  return {
    start: () => new Promise<number>((r) => server.listen(0, opts.address ?? '127.0.0.1', () => r((server.address() as AddressInfo).port))),
    stop: () => {
      for (const s of streams) s.destroy();
      server.close();
    },
    emit: (body: string) => streams.forEach((s) => send(s, body)),
    cut: () => streams.forEach((s) => s.destroy()),
    connected: () => streams.size,
  };
}

// ---------------------------------------------------------------- serveur reel

async function start(opts: { dataDir?: string } = {}): Promise<{ proc: ChildProcess; base: string; output: () => string }> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    PSIM_DATA_DIR: opts.dataDir ?? join(mkdtempSync(join(tmpdir(), 'psim-e2e-rules-')), 'data'),
    PSIM_PORT: String(port),
    PSIM_MQTT_PORT: String(await freePort()),
    PSIM_ADMIN_PASSWORD: ADMIN_PW,
    PSIM_OPERATOR_PASSWORD: OPERATOR_PW,
    PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3',
    PSIM_DEMO_LOGIN: '0',
    PSIM_REQUIRE_2FA: 'none',
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
    await wait(250);
  }
  proc.kill();
  throw new Error(`serveur non demarre :\n${output}`);
}

/** Arrete le serveur et attend sa sortie (le fichier de base est alors libre). */
async function stop(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  const done = new Promise<void>((r) => proc.once('exit', () => r()));
  proc.kill();
  await done;
}

function caller(base: () => string) {
  return async (method: string, path: string, cookie: string | null, body?: unknown) => {
    const res = await fetch(`${base()}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

async function login(base: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie()[0].split(';')[0];
}

/** Jeux d'essai visage (test/fixtures/dahua-face-*) : texte brut d'une partie du flux, ramene a la voie 1 (index=0). */
const faceFixture = (name: string): string => readFileSync(join(ROOT, 'test', 'fixtures', name), 'utf8').replace(/\r\n/g, '\n').replace(/index=\d+/, 'index=0');
const FACE_UNKNOWN = faceFixture('dahua-face-recognition-unknown.txt');

const SPEC = {
  who: { type: 'anyone' },
  where: { cameras: ['C-01'] },
  when: { type: 'always' },
  trigger: { type: 'appears' },
  then: { severity: 'critical' },
  cooldownMinutes: 10,
};

describe('regles de presence (processus reel)', { timeout: 180_000 }, () => {
  let s: Awaited<ReturnType<typeof start>>;
  let admin = '';
  let operator = '';
  const xvr = fakeRecorder();
  let xvrPort = 0;

  const call = async (method: string, path: string, cookie: string | null, body?: unknown) => {
    const res = await fetch(`${s.base}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const asAdmin = (method: string, path: string, body?: unknown) => call(method, path, admin, body);
  const state = async () => (await asAdmin('GET', '/api/state')).body;

  before(async () => {
    xvrPort = await xvr.start();
    s = await start();
    admin = await login(s.base, 'admin', ADMIN_PW);
    operator = await login(s.base, 'operateur', OPERATOR_PW);
  });
  after(() => {
    xvr.stop();
    s?.proc.kill();
  });

  it("droits : sans session 401 partout ; l'operateur lit les regles et la presence, mais ne cree, modifie, supprime ni n'essaie rien", async () => {
    for (const [method, path, body] of [
      ['GET', '/api/rules'],
      ['GET', '/api/presence'],
      ['POST', '/api/rules', { name: 'x', spec: SPEC }],
      ['PUT', '/api/rules/1', { enabled: false }],
      ['DELETE', '/api/rules/1'],
      ['POST', '/api/rules/simulate', { spec: SPEC, days: 7 }],
    ] as [string, string, unknown?][]) {
      assert.equal((await call(method, path, null, body)).status, 401, `${method} ${path} sans session`);
    }
    assert.deepEqual((await call('GET', '/api/rules', operator)).body, []);
    assert.deepEqual((await call('GET', '/api/presence', operator)).body, {});
    for (const [method, path, body] of [
      ['POST', '/api/rules', { name: 'x', spec: SPEC }],
      ['PUT', '/api/rules/1', { enabled: false }],
      ['DELETE', '/api/rules/1'],
      ['POST', '/api/rules/simulate', { spec: SPEC, days: 7 }],
    ] as [string, string, unknown?][]) {
      assert.equal((await call(method, path, operator, body)).status, 403, `${method} ${path} par l'operateur`);
    }
    assert.deepEqual((await asAdmin('GET', '/api/rules')).body, [], "rien n'a ete cree par les refus");
  });

  it('cycle complet : creer, lire (phrase francaise), modifier, desactiver, supprimer ; journal et detecteur virtuel suivent', async () => {
    const made = await asAdmin('POST', '/api/rules', { name: 'Presence accueil', spec: SPEC, sourceText: 'Prevenir si quelqu un apparait a l accueil' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const rule = made.body;
    assert.equal(typeof rule.id, 'number');
    assert.equal(rule.deviceId, `R-${rule.id}`);
    assert.equal(rule.enabled, true);
    assert.equal(rule.createdBy, 'admin');
    assert.equal(rule.sourceText, 'Prevenir si quelqu un apparait a l accueil');
    assert.match(rule.summary, /Prévenir \(alerte critique\) si quelqu'un apparaît devant la caméra « Camera accueil »/);
    assert.deepEqual(rule.spec, SPEC, 'specification normalisee identique a la saisie');

    const listed = (await asAdmin('GET', '/api/rules')).body;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].summary, rule.summary);

    // Modification : nom et condition ; la phrase et le detecteur suivent.
    const edited = await asAdmin('PUT', `/api/rules/${rule.id}`, { name: 'Presence prolongee accueil', spec: { ...SPEC, trigger: { type: 'stays', minutes: 5 } } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.match(edited.body.summary, /reste au moins 5 min/);
    assert.equal(edited.body.name, 'Presence prolongee accueil');
    assert.equal((await state()).devices.find((d: any) => d.id === rule.deviceId).name, 'Presence prolongee accueil');

    // Desactivation puis reactivation.
    const off = await asAdmin('PUT', `/api/rules/${rule.id}`, { enabled: false });
    assert.equal(off.body.enabled, false);
    assert.equal((await asAdmin('GET', '/api/rules')).body[0].enabled, false);
    assert.equal((await asAdmin('PUT', `/api/rules/${rule.id}`, { enabled: true })).body.enabled, true);
    assert.equal((await asAdmin('PUT', `/api/rules/${rule.id}`, { enabled: false })).body.enabled, false);

    // Suppression : 204, la regle et son detecteur disparaissent, une seconde suppression est « introuvable ».
    assert.equal((await asAdmin('DELETE', `/api/rules/${rule.id}`)).status, 204);
    assert.deepEqual((await asAdmin('GET', '/api/rules')).body, []);
    assert.ok(!(await state()).devices.some((d: any) => d.id === rule.deviceId), 'le detecteur virtuel est supprime avec la regle');
    const again = await asAdmin('DELETE', `/api/rules/${rule.id}`);
    assert.equal(again.status, 404);
    assert.equal(again.body.error, 'Regle introuvable');

    const audit = JSON.stringify((await asAdmin('GET', '/api/audit?limit=200')).body);
    for (const action of ['rule_created', 'rule_updated', 'rule_enabled', 'rule_disabled', 'rule_deleted']) assert.match(audit, new RegExp(action), action);
    assert.match(audit, /phrase d'origine/);
  });

  it('validations : messages en francais, rien de superflu accepte, identifiants hors bornes = « Regle introuvable »', async () => {
    const bad = async (method: string, path: string, body: unknown, status: number, message: RegExp) => {
      const r = await asAdmin(method, path, body);
      assert.equal(r.status, status, `${method} ${path} ${JSON.stringify(body)} -> ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, message);
    };
    // Creation
    await bad('POST', '/api/rules', {}, 400, /Nom de la regle requis/);
    await bad('POST', '/api/rules', { name: 'x' }, 400, /Il manque la case|un objet est attendu/);
    await bad('POST', '/api/rules', { name: 'x', spec: { ...SPEC, where: { cameras: ['C-99'] } } }, 400, /camera inconnue « C-99 »/);
    await bad('POST', '/api/rules', { name: 'x', spec: { ...SPEC, where: { zones: ['Nulle part'] } } }, 400, /zone inconnue/);
    await bad('POST', '/api/rules', { name: 'x', spec: { ...SPEC, trigger: { type: 'stays', minutes: 0 } } }, 400, /entier de minutes entre 1 et 1440/);
    await bad('POST', '/api/rules', { name: 'x', spec: { ...SPEC, then: { severity: 'enorme' } } }, 400, /gravite/);
    await bad('POST', '/api/rules', { name: 'x', spec: { ...SPEC, plus: 1 } }, 400, /non reconnu/);
    await bad('POST', '/api/rules', { name: 'x', spec: SPEC, extra: true }, 400, /champ « extra » non reconnu/);
    await bad('POST', '/api/rules', { name: 'x', spec: SPEC, enabled: 'oui' }, 400, /vrai ou faux/);
    await bad('POST', '/api/rules', [1, 2], 400, /un objet est attendu/);
    await bad('POST', '/api/rules', '{ pas du json', 400, /Requete invalide/);
    assert.deepEqual((await asAdmin('GET', '/api/rules')).body, [], 'aucune regle creee par les refus');

    // Identifiants
    for (const id of ['abc', '0', '-1', '1.5', '999999999999999999999', '99999']) {
      await bad('PUT', `/api/rules/${id}`, { enabled: false }, 404, /^Regle introuvable$/);
      await bad('DELETE', `/api/rules/${id}`, undefined, 404, /^Regle introuvable$/);
    }

    // Modification d'une regle existante
    const made = (await asAdmin('POST', '/api/rules', { name: 'Essai', spec: SPEC })).body;
    await bad('PUT', `/api/rules/${made.id}`, {}, 400, /Rien a modifier/);
    await bad('PUT', `/api/rules/${made.id}`, { nom: 'x' }, 400, /non reconnu/);
    await bad('PUT', `/api/rules/${made.id}`, { spec: { ...SPEC, where: { cameras: ['C-99'] } } }, 400, /camera inconnue/);
    await bad('PUT', `/api/rules/${made.id}`, [], 400, /un objet est attendu/);
    assert.deepEqual((await asAdmin('GET', '/api/rules')).body[0].spec, SPEC, 'la regle est restee telle quelle');

    // Essai sur le passe
    for (const days of [0, 31, 1.5, '7', null, -3, undefined]) {
      await bad('POST', '/api/rules/simulate', { spec: SPEC, days }, 400, /^Nombre de jours invalide \(1 a 30\)$/);
    }
    await bad('POST', '/api/rules/simulate', { spec: SPEC, days: 7, plus: 1 }, 400, /non reconnu/);
    await bad('POST', '/api/rules/simulate', { spec: { ...SPEC, where: { cameras: ['C-99'] } }, days: 7 }, 400, /camera inconnue/);
    await bad('POST', '/api/rules/simulate', [], 400, /un objet est attendu/);
    await bad('POST', '/api/rules/simulate', { days: 7 }, 400, /un objet est attendu/);

    assert.equal((await asAdmin('DELETE', `/api/rules/${made.id}`)).status, 204);
  });

  it("detecteur virtuel : present dans l'etat du site avec ses liens et sa zone ; la pastille se deplace, mais l'inventaire ne le supprime pas", async () => {
    const made = (await asAdmin('POST', '/api/rules', { name: 'Presence couloir et accueil', spec: { ...SPEC, where: { cameras: ['C-02', 'C-01'] } } })).body;
    const snap = await state();
    const device = snap.devices.find((d: any) => d.id === made.deviceId);
    assert.ok(device, 'le detecteur existe dans /api/state');
    assert.equal(device.kind, 'detector');
    assert.equal(device.category, 'access');
    assert.equal(device.heartbeatS, 0, 'non supervise');
    assert.equal(device.zone, 'Couloir', 'zone de la premiere camera de la portee');
    assert.deepEqual([...snap.links[made.deviceId]].sort(), ['C-01', 'C-02']);

    const moved = await asAdmin('PATCH', `/api/devices/${made.deviceId}`, { x: 33, y: 44 });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.x, 33);

    const refused = await asAdmin('DELETE', `/api/devices/${made.deviceId}`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'Ce detecteur appartient a une regle de presence : modifier ou supprimer la regle');
    assert.ok((await state()).devices.some((d: any) => d.id === made.deviceId), 'toujours la');

    // Un detecteur ordinaire se supprime comme avant ; celui de la regle part avec elle.
    assert.equal((await asAdmin('DELETE', `/api/rules/${made.id}`)).status, 204);
    assert.ok(!(await state()).devices.some((d: any) => d.id === made.deviceId));
    assert.equal((await asAdmin('DELETE', `/api/devices/${made.deviceId}`)).status, 404, 'plus de detecteur, donc introuvable (et non 409)');
  });

  it("essai sur le passe : resume en francais, periode renvoyee, avertissement d'armement seulement pour « quand la zone est armee »", async () => {
    const before = Date.now();
    const plain = await asAdmin('POST', '/api/rules/simulate', { spec: SPEC, days: 7 });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.match(plain.body.summary, /si quelqu'un apparaît devant la caméra « Camera accueil »/);
    assert.deepEqual(plain.body.triggers, []);
    assert.equal(plain.body.days, 7);
    assert.equal(plain.body.armedNote, false);
    assert.ok(plain.body.to >= before && plain.body.to <= Date.now());
    assert.equal(plain.body.to - plain.body.from, 7 * 86_400_000);
    const armed = await asAdmin('POST', '/api/rules/simulate', { spec: { ...SPEC, when: { type: 'armed' } }, days: 30 });
    assert.equal(armed.status, 200);
    assert.equal(armed.body.armedNote, true);
    assert.match(armed.body.summary, /uniquement quand la zone est armée/);
    assert.deepEqual((await asAdmin('GET', '/api/rules')).body, [], "l'essai n'enregistre rien");
    assert.ok(!(await state()).devices.some((d: any) => /^R-/.test(d.id)), "l'essai ne cree aucun detecteur");
  });

  it("chaine complete : faux enregistreur -> observation -> presence -> regle -> incident « Presence detectee » ; la regle qui a sonne ne se supprime plus", async () => {
    // La camera du site de demonstration devient une camera d'enregistreur (voie 1), le detecteur d'intrusion de l'accueil
    // lit le faux enregistreur : c'est son port qui permet a l'observation de reutiliser le lien (sans detecteur, ce serait 80).
    const source = await asAdmin('PUT', '/api/cameras/C-01/source', { kind: 'rtsp', host: '127.0.0.1', port: 554, rtspPath: '/cam/realmonitor?channel=1&subtype=1', username: USER, password: PASSWORD });
    assert.equal(source.status, 200, JSON.stringify(source.body));
    const det = await asAdmin('PUT', '/api/detectors/I-01/source', { cameraId: 'C-01', channel: 1, events: ['SmartMotionVehicle'], httpPort: xvrPort });
    assert.equal(det.status, 200, JSON.stringify(det.body));
    await until(async () => (await asAdmin('GET', '/api/detectors/I-01/source')).body.connection.state === 'connected', 8000, 'liaison avec le faux enregistreur');
    assert.equal(xvr.connected(), 1, 'une seule connexion vers l\'enregistreur');

    const made = await asAdmin('POST', '/api/rules', { name: 'Presence devant l accueil', spec: SPEC });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const rule = made.body;
    assert.deepEqual((await asAdmin('GET', '/api/presence')).body, {});

    // Voie 2 : pas la notre. Une presence sur la voie 1 : la regle sonne.
    xvr.emit('Code=SmartMotionHuman;action=Start;index=1');
    await wait(200);
    assert.deepEqual((await asAdmin('GET', '/api/presence')).body, {}, 'aucune camera sur la voie 2');
    assert.equal((await state()).incidents.filter((i: any) => i.detectorId === rule.deviceId).length, 0);

    const before = Date.now();
    xvr.emit('Code=SmartMotionHuman;action=Start;index=0;data={"Object":"Human"}');
    await until(async () => (await state()).incidents.some((i: any) => i.detectorId === rule.deviceId), 8000, `incident sur ${rule.deviceId}\n${s.output().slice(-600)}`);
    const snap = await state();
    const incident = snap.incidents.find((i: any) => i.detectorId === rule.deviceId);
    assert.equal(incident.event, 'person_detected');
    assert.equal(eventLabel(incident.event), 'Présence détectée');
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.category, 'access');
    assert.deepEqual(incident.cameraIds, ['C-01']);
    assert.equal(snap.devices.find((d: any) => d.id === rule.deviceId).status, 'alarm');

    // La presence courante est visible par tout utilisateur connecte.
    for (const cookie of [admin, operator]) {
      const presence = (await call('GET', '/api/presence', cookie)).body;
      assert.deepEqual(Object.keys(presence), ['C-01']);
      assert.ok(presence['C-01'].since >= before - 1000 && presence['C-01'].since <= Date.now());
    }

    // L'essai sur le passe retrouve ce declenchement dans l'historique de presence.
    const trial = (await asAdmin('POST', '/api/rules/simulate', { spec: SPEC, days: 1 })).body;
    assert.equal(trial.triggers.length, 1, JSON.stringify(trial));
    assert.equal(trial.triggers[0].cameraId, 'C-01');

    // La regle a declenche un incident : on ne la supprime plus (message du module renvoye tel quel), on la desactive.
    const refused = await asAdmin('DELETE', `/api/rules/${rule.id}`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'Cette regle a deja declenche des incidents : la desactiver plutot que la supprimer');
    assert.equal((await asAdmin('GET', '/api/rules')).body.length, 1, 'toujours la');
    assert.ok((await state()).devices.some((d: any) => d.id === rule.deviceId));

    // Fin de la presence : elle cesse tout de suite pour l'ecran (la regle, elle, attend 60 s de lissage).
    xvr.emit('Code=SmartMotionHuman;action=Stop;index=0');
    await until(async () => Object.keys((await asAdmin('GET', '/api/presence')).body).length === 0, 5000, 'presence terminee');

    // Desactiver : le detecteur revient au calme tout de suite (clear), la regle reste en base.
    const off = await asAdmin('PUT', `/api/rules/${rule.id}`, { enabled: false });
    assert.equal(off.body.enabled, false);
    assert.equal((await state()).devices.find((d: any) => d.id === rule.deviceId).status, 'normal');
  });

  it("regles d'identite : un visage inconnu declenche « Visage inconnu en zone reservee » (critique) et « Visage signale » (avertissement) ; « n'importe qui » ne reagit pas a un visage ; les visages vus sont listes sans photo", async () => {
    // Le lien vers le faux enregistreur et la camera C-01 (voie 1) viennent du test precedent.
    assert.deepEqual((await asAdmin('GET', '/api/faces/recent')).body, [], 'aucun visage vu pour le moment');
    const ID_SPEC = { ...SPEC, who: { type: 'unknown' } };
    const critical = (await asAdmin('POST', '/api/rules', { name: 'Inconnu en zone reservee', spec: { ...ID_SPEC, then: { severity: 'critical' } } })).body;
    const warning = (await asAdmin('POST', '/api/rules', { name: 'Inconnu signale', spec: { ...ID_SPEC, then: { severity: 'warning' } } })).body;
    const anyone = (await asAdmin('POST', '/api/rules', { name: 'Presence ordinaire', spec: SPEC })).body;
    assert.match(critical.summary, /visage inconnu/i);
    await wait(300); // le flux est deja ouvert (detecteur lie) : la regle n'en change rien

    xvr.emit(FACE_UNKNOWN);
    await until(async () => {
      const snap = await state();
      return [critical, warning].every((r) => snap.incidents.some((i: any) => i.detectorId === r.deviceId));
    }, 8000, `incidents d'identite\n${s.output().slice(-600)}`);
    const snap = await state();

    const hard = snap.incidents.find((i: any) => i.detectorId === critical.deviceId);
    assert.equal(hard.event, 'face_unknown');
    assert.equal(eventLabel(hard.event), 'Visage inconnu en zone réservée');
    assert.equal(hard.severity, 'critical');
    assert.equal(hard.category, 'access');
    assert.deepEqual(hard.cameraIds, ['C-01']);
    assert.equal(snap.devices.find((d: any) => d.id === critical.deviceId).status, 'alarm');

    const soft = snap.incidents.find((i: any) => i.detectorId === warning.deviceId);
    assert.equal(soft.event, 'face_noticed');
    assert.equal(eventLabel(soft.event), 'Visage signalé');
    assert.equal(soft.severity, 'warning');
    assert.equal(snap.devices.find((d: any) => d.id === warning.deviceId).status, 'prealarm');

    // « N'importe qui » est piloté par la presence, jamais par un visage.
    assert.equal(snap.incidents.filter((i: any) => i.detectorId === anyone.deviceId).length, 0);
    assert.equal(snap.devices.find((d: any) => d.id === anyone.deviceId).status, 'normal');

    // Les visages vus : sans photo ni identifiant interne.
    const recent = await asAdmin('GET', '/api/faces/recent');
    assert.equal(recent.status, 200);
    assert.equal(recent.body.length, 1);
    assert.deepEqual(Object.keys(recent.body[0]).sort(), ['at', 'cameraId', 'cameraName', 'groupName', 'kind', 'personName', 'similarity']);
    assert.deepEqual({ ...recent.body[0], at: 0 }, { cameraId: 'C-01', cameraName: 'Camera accueil', at: 0, kind: 'unknown', personName: null, groupName: null, similarity: null });
    assert.ok(Math.abs(recent.body[0].at - Date.now()) < 30_000);
    assert.doesNotMatch(JSON.stringify(recent.body), /base64|Candidates|image/i);

    // Les routes de visages sont reservees a l'administrateur.
    for (const path of ['/api/faces/recent', '/api/faces/lists']) {
      assert.equal((await call('GET', path, operator)).status, 403, `${path} par l'operateur`);
      assert.equal((await call('GET', path, null)).status, 401, `${path} sans session`);
    }
    assert.equal((await call('GET', '/api/rules/assist', operator)).status, 403);
    assert.equal((await call('POST', '/api/rules/assist', operator, { text: 'x' })).status, 403);

    // Une personne reconnue ne correspond pas a « inconnu » : rien de plus ne se declenche.
    const known = faceFixture('dahua-face-recognition-known.txt');
    const incidentsBefore = (await state()).incidents.length;
    xvr.emit(known);
    await until(async () => (await asAdmin('GET', '/api/faces/recent')).body.length === 2, 5000, 'visage reconnu enregistre');
    const seen = (await asAdmin('GET', '/api/faces/recent')).body;
    assert.equal(seen[0].kind, 'recognized', 'le plus recent d\'abord');
    assert.equal(typeof seen[0].personName, 'string');
    assert.equal((await state()).incidents.length, incidentsBefore, 'une personne reconnue ne declenche pas « inconnu »');
  });
});

// ---------------------------------------------------------------- integration en processus (horloge maitrisee)

describe('regles de presence : branchement observeAll -> presence -> regle -> incident, en processus', () => {
  const xvr = fakeRecorder();
  let port = 0;
  before(async () => {
    port = await xvr.start();
  });
  after(() => xvr.stop());

  it('une regle active ouvre le flux sans detecteur ; presence -> incident ; fin apres 60 s de lissage ; regle desactivee = flux ferme ; flux coupe = presence terminee', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-rules-int-'));
    const db = openDb(join(dir, 'psim.db'));
    seedDemo(db, dir, join(ROOT, 'seed'));
    const key = randomBytes(32);
    // Aucune source de detecteur : seule l'observation de toutes les voies peut ouvrir ce flux.
    db.prepare("INSERT INTO camera_source (device_id, kind, host, port, rtsp_path, username, secret) VALUES ('C-01', 'rtsp', '127.0.0.1', 554, '/cam/realmonitor?channel=1&subtype=1', ?, ?)").run(USER, seal(key, PASSWORD));
    let clock = Date.now();
    const now = () => clock;
    const engine = createEngine(db, () => {}, now, { isArmed: () => true });
    const presence = createPresence({ db, now });
    const rules = createRules({ db, engine, presence, isArmed: () => true, now });
    const dahua = createDahuaEvents({
      db,
      engine,
      key,
      now,
      log: () => {},
      isArmed: () => true,
      // Le port 80 des enregistreurs reels est impossible en essai : on redirige vers le faux.
      open: (creds, handlers) => openEventStream({ ...creds, port }, handlers),
      onObservation: (o) => presence.observe(o),
      onLinkLost: (host) => presence.linkLost(host),
      observeAll: () => rules.list().some((r) => r.enabled),
    });
    try {
      dahua.reload();
      await wait(150);
      assert.equal(xvr.connected(), 0, 'aucune regle active : aucun flux');

      const rule = rules.create('admin', { name: 'Presence accueil', spec: SPEC });
      dahua.reload();
      await until(() => xvr.connected() === 1, 5000, 'flux ouvert par la regle');
      await wait(150);

      const incidents = () => engine.getSnapshot().incidents.filter((i) => i.detectorId === rule.deviceId);
      const status = () => engine.getDevice(rule.deviceId)!.status;
      xvr.emit('Code=SmartMotionHuman;action=Start;index=0');
      await until(() => incidents().length === 1, 5000, 'incident de la regle');
      assert.equal(status(), 'alarm');
      assert.equal(incidents()[0].event, 'person_detected');
      assert.deepEqual(Object.keys(presence.current()), ['C-01']);

      // Fin de la presence : le detecteur ne revient au calme qu'apres 60 s sans reprise.
      clock += 30_000;
      xvr.emit('Code=SmartMotionHuman;action=Stop;index=0');
      await until(() => Object.keys(presence.current()).length === 0, 5000, 'presence terminee');
      clock += 59_000;
      rules.tick();
      assert.equal(status(), 'alarm', 'moins de 60 s : toujours la');
      clock += 2_000;
      rules.tick();
      assert.equal(status(), 'normal', '60 s sans reprise : clear');
      assert.equal(incidents().length, 1, "l'incident reste a traiter par un humain");

      // Regle desactivee : plus aucune raison d'observer l'enregistreur.
      rules.update('admin', rule.id, { enabled: false });
      dahua.reload();
      await until(() => xvr.connected() === 0, 5000, 'flux ferme');

      // Reactivee, puis flux coupe pendant une presence : la presence se termine (le Stop ne viendra jamais).
      rules.update('admin', rule.id, { enabled: true });
      dahua.reload();
      await until(() => xvr.connected() === 1, 5000, 'flux rouvert');
      await wait(150);
      clock += 11 * 60_000; // repos de la regle ecoule
      xvr.emit('Code=SmartMotionHuman;action=Start;index=0');
      await until(() => Object.keys(presence.current()).length === 1, 5000, 'nouvelle presence');
      assert.equal(status(), 'alarm', 'nouvelle alerte (le meme incident, reste ouvert, est repris par le moteur)');
      xvr.cut();
      await until(() => Object.keys(presence.current()).length === 0, 5000, 'presence terminee par la perte du flux');
    } finally {
      rules.close();
      dahua.stop();
      db.close();
    }
  });
});

describe("regles d'identite : branchement observeAll -> visages -> regle -> incident, en processus", () => {
  const xvr = fakeRecorder();
  let port = 0;
  before(async () => {
    port = await xvr.start();
  });
  after(() => xvr.stop());

  it("une regle d'identite ouvre le flux ; un visage inconnu declenche ; retour au calme 60 s apres la derniere observation ; une panne de la presence n'empeche pas les visages", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-rules-face-'));
    const db = openDb(join(dir, 'psim.db'));
    seedDemo(db, dir, join(ROOT, 'seed'));
    const key = randomBytes(32);
    db.prepare("INSERT INTO camera_source (device_id, kind, host, port, rtsp_path, username, secret) VALUES ('C-01', 'rtsp', '127.0.0.1', 554, '/cam/realmonitor?channel=1&subtype=1', ?, ?)").run(USER, seal(key, PASSWORD));
    let clock = Date.now();
    const now = () => clock;
    const engine = createEngine(db, () => {}, now, { isArmed: () => true });
    const presence = createPresence({ db, now });
    const faceObs = createFaceObs({ db, now });
    const rules = createRules({ db, engine, presence, faces: faceObs, isArmed: () => true, now });
    let presenceBroken = false;
    const dahua = createDahuaEvents({
      db,
      engine,
      key,
      now,
      log: () => {},
      isArmed: () => true,
      open: (creds, handlers) => openEventStream({ ...creds, port }, handlers),
      // Meme branchement que main.ts : l'un ne doit pas empecher l'autre.
      onObservation: (o) => {
        try {
          if (presenceBroken) throw new Error('presence en panne');
          presence.observe(o);
        } catch {
          // journalise par main.ts
        }
        faceObs.observe(o);
      },
      onLinkLost: (host) => presence.linkLost(host),
      observeAll: () => rules.list().some((r) => r.enabled),
    });
    try {
      dahua.reload();
      await wait(150);
      assert.equal(xvr.connected(), 0, 'aucune regle : aucun flux');

      const rule = rules.create('admin', { name: 'Inconnu en zone reservee', spec: { ...SPEC, who: { type: 'unknown' } } });
      dahua.reload();
      await until(() => xvr.connected() === 1, 5000, "flux ouvert par la regle d'identite");
      await wait(150);
      presenceBroken = true;

      const incidents = () => engine.getSnapshot().incidents.filter((i) => i.detectorId === rule.deviceId);
      const status = () => engine.getDevice(rule.deviceId)!.status;
      xvr.emit(FACE_UNKNOWN);
      await until(() => incidents().length === 1, 5000, 'incident de la regle');
      assert.equal(status(), 'alarm');
      assert.equal(incidents()[0].event, 'face_unknown');

      // Nouvelle observation 30 s plus tard : le retour au calme se compte depuis elle (et non depuis la premiere).
      clock += 30_000;
      xvr.emit(FACE_UNKNOWN.replace('"UTC" : 1776717100', '"UTC" : 1776717130'));
      await until(() => faceObs.history(0, clock + 1).length === 2, 5000, 'deuxieme observation');
      clock += 59_000;
      rules.tick();
      assert.equal(status(), 'alarm', 'moins de 60 s apres la derniere observation : toujours la');
      clock += 2_000;
      rules.tick();
      assert.equal(status(), 'normal', '60 s sans nouvelle observation : retour au calme');
      assert.equal(incidents().length, 1, "l'incident reste a traiter par un humain");

      // Regle desactivee : plus rien a observer.
      rules.update('admin', rule.id, { enabled: false });
      dahua.reload();
      await until(() => xvr.connected() === 0, 5000, 'flux ferme');
    } finally {
      rules.close();
      dahua.stop();
      db.close();
    }
  });
});

// ---------------------------------------------------------------- listes et personnes propres a chaque appareil

/** Reponse de findGroup d'un appareil qui n'a qu'une base. */
const groupsText = (id: string, name: string, size: number): string =>
  `found=1\nGroupList[0].groupID=${id}\nGroupList[0].groupName=${name}\nGroupList[0].groupType=BlackListDB\nGroupList[0].groupSize=${size}\n`;

/** Visage reconnu sur la voie `channel` (1, 2...) : un seul candidat, la personne `uid` de la base `groupId`. */
function recognized(channel: number, uid: string, groupId: string, name: string, groupName: string): string {
  const candidate = { Similarity: 91, Person: { UID: uid, GroupID: groupId, Name: name, GroupName: groupName } };
  return `Code=FaceRecognition;action=Pulse;index=${channel - 1};data=${JSON.stringify({ Candidates: [candidate] })}`;
}

const identitySpec = (who: unknown, where: unknown = { cameras: ['C-01'] }) => ({
  who,
  where,
  when: { type: 'always' },
  trigger: { type: 'appears' },
  then: { severity: 'warning' },
  cooldownMinutes: 10,
});

describe("regles d'identite : listes et personnes propres a chaque appareil (deux faux appareils Dahua, processus reel)", { timeout: 240_000 }, () => {
  // Appareil 1 (127.0.0.1) : enregistreur a DEUX voies, cameras C-01 (voie 1) et C-02 (voie 2), base « 1 » = Famille.
  // Appareil 2 (127.0.0.2) : camera C-03 (voie 1), base « 1 » = Visiteurs. Memes numeros de base et de personne sur les deux.
  const devA = fakeRecorder({ address: '127.0.0.1', groups: groupsText('1', 'Famille', 2) });
  const devB = fakeRecorder({ address: '127.0.0.2', groups: groupsText('1', 'Visiteurs', 3) });
  let s: Awaited<ReturnType<typeof start>>;
  let admin = '';
  const call = caller(() => s.base);
  const asAdmin = (method: string, path: string, body?: unknown) => call(method, path, admin, body);

  const famille = { type: 'list', cameraId: 'C-01', listId: '1', listName: 'Famille' };
  const alice = { type: 'person', cameraId: 'C-01', personId: '1', personName: 'Alice' };
  const visiteurs = { type: 'list', cameraId: 'C-03', listId: '1', listName: 'Visiteurs' };
  const bob = { type: 'person', cameraId: 'C-03', personId: '1', personName: 'Bob' };
  const BOTH = ['C-01', 'C-03'];

  const incidentsOf = async (rule: { deviceId: string }): Promise<any[]> => (await asAdmin('GET', '/api/state')).body.incidents.filter((i: any) => i.detectorId === rule.deviceId);
  const seenCount = async (): Promise<number> => (await asAdmin('GET', '/api/faces/recent')).body.length;
  /** Un visage vient de l'appareil ; on attend qu'il soit enregistre (donc deja remis aux regles) et on laisse le temps aux incidents. */
  const emit = async (dev: ReturnType<typeof fakeRecorder>, event: string): Promise<void> => {
    const n = await seenCount();
    dev.emit(event);
    await until(async () => (await seenCount()) === n + 1, 5000, `visage enregistre\n${s.output().slice(-500)}`);
    await wait(100);
  };
  const make = async (name: string, who: unknown, cameras: string[] = BOTH) => {
    const r = await asAdmin('POST', '/api/rules', { name, spec: identitySpec(who, { cameras }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const refusal = async (method: string, path: string, body: unknown, message: RegExp) => {
    const r = await asAdmin(method, path, body);
    assert.equal(r.status, 400, `${method} ${path} -> ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, message);
  };

  before(async () => {
    const portA = await devA.start();
    const portB = await devB.start();
    s = await start();
    admin = await login(s.base, 'admin', ADMIN_PW);
    const source = async (camera: string, host: string, channel: number) => {
      const r = await asAdmin('PUT', `/api/cameras/${camera}/source`, { kind: 'rtsp', host, port: 554, rtspPath: `/cam/realmonitor?channel=${channel}&subtype=1`, username: USER, password: PASSWORD });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    };
    await source('C-01', '127.0.0.1', 1);
    await source('C-02', '127.0.0.1', 2);
    await source('C-03', '127.0.0.2', 1);
    // Le port HTTP vient du detecteur lie a l'hote (sinon 80) : un detecteur par appareil.
    const created = await asAdmin('POST', '/api/devices', { id: 'I-10', kind: 'detector', category: 'intrusion', name: 'Mouvement serveurs', zone: 'Salle serveurs' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const detA = await asAdmin('PUT', '/api/detectors/I-01/source', { cameraId: 'C-01', channel: 1, events: ['SmartMotionVehicle'], httpPort: portA });
    assert.equal(detA.status, 200, JSON.stringify(detA.body));
    const detB = await asAdmin('PUT', '/api/detectors/I-10/source', { cameraId: 'C-03', channel: 1, events: ['SmartMotionVehicle'], httpPort: portB });
    assert.equal(detB.status, 200, JSON.stringify(detB.body));
    for (const id of ['I-01', 'I-10']) await until(async () => (await asAdmin('GET', `/api/detectors/${id}/source`)).body.connection.state === 'connected', 8000, `liaison ${id}\n${s.output().slice(-500)}`);
  });
  after(async () => {
    devA.stop();
    devB.stop();
    if (s) await stop(s.proc);
  });

  it("GET /api/faces/lists : une entree par (appareil, liste), meme numero « 1 » sur les deux ; la camera annoncee est celle de l'appareil proprietaire et ne change pas d'une lecture a l'autre", async () => {
    const first = await asAdmin('GET', '/api/faces/lists');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.hosts, 2);
    assert.deepEqual(first.body.notes, []);
    assert.deepEqual(
      first.body.lists.map((l: any) => [l.id, l.name, l.size, l.cameraId, l.cameraName]),
      [
        ['1', 'Famille', 2, 'C-01', 'Camera accueil'],
        ['1', 'Visiteurs', 3, 'C-03', 'Camera serveurs'],
      ],
    );

    // Chaque liste porte les cameras de TOUTES les voies de son appareil (triees, representante comprise) ; deux appareils : disjoints. Aucune adresse.
    assert.deepEqual(first.body.lists.map((l: any) => l.deviceCameraIds), [['C-01', 'C-02'], ['C-03']]);
    assert.doesNotMatch(JSON.stringify(first.body), /127\.0\.0\./);

    // Une camera d'identifiant plus petit arrive sur le premier appareil : ce n'est pas elle qui devient la camera annoncee.
    assert.equal((await asAdmin('POST', '/api/devices', { id: 'C-00', kind: 'camera', name: 'Camera ajoutee', zone: 'Accueil' })).status, 201);
    const added = await asAdmin('PUT', '/api/cameras/C-00/source', { kind: 'rtsp', host: '127.0.0.1', port: 554, rtspPath: '/cam/realmonitor?channel=3&subtype=1', username: USER, password: PASSWORD });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    for (let i = 0; i < 3; i++) {
      const again = await asAdmin('GET', '/api/faces/lists');
      assert.deepEqual(again.body.lists.map((l: any) => l.cameraId), ['C-01', 'C-03'], `lecture ${i + 1}`);
      assert.deepEqual(again.body.lists[0].deviceCameraIds, ['C-00', 'C-01', 'C-02'], 'relu a chaque lecture (pas en cache) : la nouvelle voie y est');
      assert.deepEqual(again.body.lists[1].deviceCameraIds, ['C-03']);
    }
    // Retiree, la camera annoncee reste la meme.
    assert.equal((await asAdmin('DELETE', '/api/devices/C-00')).status, 204);
    const afterRemoval = (await asAdmin('GET', '/api/faces/lists')).body.lists;
    assert.deepEqual(afterRemoval.map((l: any) => l.cameraId), ['C-01', 'C-03']);
    assert.deepEqual(afterRemoval[0].deviceCameraIds, ['C-01', 'C-02']);
  });

  it("une regle sur la liste « 1 » (ou la personne « 1 ») d'un appareil ne declenche pas sur le « 1 » de l'autre appareil, et declenche sur le sien", async () => {
    const ruleFamille = await make('Famille (appareil 1)', famille);
    const ruleAlice = await make('Alice (appareil 1)', alice);
    const ruleVisiteurs = await make('Visiteurs (appareil 2)', visiteurs);
    const ruleBob = await make('Bob (appareil 2)', bob);

    // Visage « base 1, personne 1 » vu par l'appareil 2 : seules les regles de l'appareil 2 sonnent.
    await emit(devB, recognized(1, '1', '1', 'Bob', 'Visiteurs'));
    assert.equal((await incidentsOf(ruleVisiteurs)).length, 1, 'la liste de l\'appareil 2 sonne');
    assert.equal((await incidentsOf(ruleBob)).length, 1, 'la personne de l\'appareil 2 sonne');
    assert.equal((await incidentsOf(ruleFamille)).length, 0, "la liste « 1 » de l'appareil 1 ne sonne pas");
    assert.equal((await incidentsOf(ruleAlice)).length, 0, "la personne « 1 » de l'appareil 1 ne sonne pas");
    const snap = (await asAdmin('GET', '/api/state')).body;
    for (const r of [ruleFamille, ruleAlice]) assert.equal(snap.devices.find((d: any) => d.id === r.deviceId).status, 'normal');
    const hit = (await incidentsOf(ruleVisiteurs))[0];
    assert.equal(hit.event, 'face_noticed');
    assert.equal(hit.severity, 'warning');
    assert.deepEqual([...hit.cameraIds].sort(), BOTH, "l'incident porte les cameras de la portee de la regle");

    // Meme visage « base 1, personne 1 » vu par l'appareil 1 : ses regles sonnent maintenant.
    await emit(devA, recognized(1, '1', '1', 'Alice', 'Famille'));
    for (const r of [ruleFamille, ruleAlice]) {
      const found = await incidentsOf(r);
      assert.equal(found.length, 1, r.name);
    }
    assert.equal((await incidentsOf(ruleVisiteurs)).length, 1);
    assert.equal((await incidentsOf(ruleBob)).length, 1);
  });

  it("enregistreur a deux voies : un visage reconnu sur l'une ou l'autre voie correspond a la meme base, que la regle vienne de la camera de l'une ou de l'autre", async () => {
    const fromVoie1 = await make('Famille, creee depuis la voie 1', famille, ['C-01', 'C-02']);
    const fromVoie2 = await make('Famille, creee depuis la voie 2', { ...famille, cameraId: 'C-02' }, ['C-01']);

    // Voie 2 (camera C-02) : la regle portee sur les deux voies sonne, l'autre (portee sur la voie 1 seulement) l'ignore.
    await emit(devA, recognized(2, '1', '1', 'Alice', 'Famille'));
    const onVoie2 = await incidentsOf(fromVoie1);
    assert.equal(onVoie2.length, 1);
    assert.deepEqual([...onVoie2[0].cameraIds].sort(), ['C-01', 'C-02']);
    assert.equal((await incidentsOf(fromVoie2)).length, 0);

    // Voie 1 (camera C-01) : la regle creee depuis la camera de l'AUTRE voie sonne aussi (meme appareil, meme base).
    await emit(devA, recognized(1, '1', '1', 'Alice', 'Famille'));
    const onVoie1 = await incidentsOf(fromVoie2);
    assert.equal(onVoie1.length, 1);
    assert.deepEqual(onVoie1[0].cameraIds, ['C-01']);
    assert.equal(fromVoie2.needsReview, false);
  });

  it("creation refusee (400, « Ou : ... ») quand aucune camera choisie n'est sur l'appareil de la liste ; cameraId absent ou inconnu refuse ; meme message pour l'essai et la modification", async () => {
    const rulesBefore = (await asAdmin('GET', '/api/rules')).body.length;
    const create = (who: unknown, where: unknown) => ({ name: 'Refusee', spec: identitySpec(who, where) });

    // Toutes les cameras choisies sont sur l'autre appareil.
    const ou1 = /^Ou : aucune camera choisie n'appartient a l'appareil de la liste « Famille » \(camera « Camera accueil »\) : elle ne pourrait jamais se declencher$/;
    await refusal('POST', '/api/rules', create(famille, { cameras: ['C-03'] }), ou1);
    await refusal('POST', '/api/rules', create(famille, { zones: ['Salle serveurs'] }), ou1);
    await refusal('POST', '/api/rules', create(bob, { cameras: ['C-01', 'C-02'] }), /^Ou : aucune camera choisie n'appartient a l'appareil de la personne « Bob » \(camera « Camera serveurs »\)/);
    // Le message arrive tel quel par l'essai sur le passe.
    await refusal('POST', '/api/rules/simulate', { spec: identitySpec(famille, { cameras: ['C-03'] }), days: 7 }, ou1);

    // cameraId absent, vide, inconnu ; camera sans source video.
    const { cameraId: _list, ...listWithout } = famille;
    const { cameraId: _person, ...personWithout } = alice;
    await refusal('POST', '/api/rules', create(listWithout, { cameras: ['C-01'] }), /^Qui : la camera de la liste est requise$/);
    await refusal('POST', '/api/rules', create(personWithout, { cameras: ['C-01'] }), /^Qui : la camera de la personne est requise$/);
    await refusal('POST', '/api/rules', create({ ...famille, cameraId: '' }, { cameras: ['C-01'] }), /la camera de la liste est requise/);
    await refusal('POST', '/api/rules', create({ ...famille, cameraId: 'C-99' }, { cameras: ['C-01'] }), /^Qui : camera inconnue « C-99 »$/);
    await refusal('POST', '/api/rules', create({ ...alice, cameraId: 'C-99' }, { cameras: ['C-01'] }), /^Qui : camera inconnue « C-99 »$/);
    await refusal('POST', '/api/rules', create({ ...famille, cameraId: 'C-04' }, { cameras: ['C-04', 'C-01'] }), /n'est reliee a aucun appareil/);
    await refusal('POST', '/api/rules/simulate', { spec: identitySpec(listWithout), days: 7 }, /^Qui : la camera de la liste est requise$/);

    // Modification d'une regle existante : la portee ne peut pas quitter l'appareil de la liste.
    const existing = (await asAdmin('GET', '/api/rules')).body.find((r: any) => r.name === 'Famille, creee depuis la voie 1');
    await refusal('PUT', `/api/rules/${existing.id}`, { spec: identitySpec(famille, { cameras: ['C-03'] }) }, ou1);
    const unchanged = (await asAdmin('GET', '/api/rules')).body.find((r: any) => r.id === existing.id);
    assert.deepEqual(unchanged.spec.where, { cameras: ['C-01', 'C-02'] }, 'la regle est restee telle quelle');
    assert.equal((await asAdmin('GET', '/api/rules')).body.length, rulesBefore, 'aucune regle creee par les refus');
  });

  it("GET /api/rules : needsReview figure sur chaque regle (faux pour les regles saisies avec leur camera), et chaque regle d'identite garde son cameraId", async () => {
    const rules = (await asAdmin('GET', '/api/rules')).body;
    assert.ok(rules.length >= 6);
    for (const r of rules) {
      assert.equal(typeof r.needsReview, 'boolean', r.name);
      assert.equal(r.needsReview, false, r.name);
      if (r.spec.who.type === 'list' || r.spec.who.type === 'person') assert.match(r.spec.who.cameraId, /^C-0[1-3]$/);
    }
    assert.match(rules[0].summary, /caméra « Camera accueil »/);
    assert.ok(rules.some((r: any) => r.spec.who.cameraId === 'C-03'));
  });

  it("changement d'adresse d'une camera : l'appareil de la regle est relu a chaque visage (aucun redemarrage), mais la liste « 1 » du nouvel appareil porte un autre nom : PAS de correspondance, avertissement unique", async () => {
    // Regle sur la voie 2 de l'appareil 1, jamais encore declenchee.
    const rule = await make('Famille voie 2', { ...famille, cameraId: 'C-02' }, ['C-02']);
    // La camera C-02 passe sur l'appareil 2 (voie 2) : comportement du coeur, l'hote de la source video est relu a chaque comparaison.
    const moved = await asAdmin('PUT', '/api/cameras/C-02/source', { kind: 'rtsp', host: '127.0.0.2', port: 554, rtspPath: '/cam/realmonitor?channel=2&subtype=1', username: USER, password: PASSWORD });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal((await asAdmin('GET', `/api/rules`)).body.find((r: any) => r.id === rule.id).needsReview, false);

    // L'appareil 1 n'a plus de camera sur sa voie 2 : son visage n'est rattache a aucune camera, rien n'est enregistre.
    const n = await seenCount();
    devA.emit(recognized(2, '1', '1', 'Alice', 'Famille'));
    await wait(400);
    assert.equal(await seenCount(), n);
    assert.equal((await incidentsOf(rule)).length, 0);
    // La voie 2 de l'appareil 2 est maintenant celle de C-02 : la regle « Famille » (liste « 1 ») est lue par l'appareil 2, dont la liste « 1 »
    // est « Visiteurs ». Meme appareil, meme numero, mais un AUTRE NOM : la garde de nom empeche la correspondance (risque sur une liste
    // « Interdits » qui deviendrait celle d'un autre appareil). La regle est a reenregistrer, et le serveur le dit une seule fois.
    await emit(devB, recognized(2, '1', '1', 'Bob', 'Visiteurs'));
    await emit(devB, recognized(2, '1', '1', 'Bob', 'Visiteurs'));
    assert.equal((await incidentsOf(rule)).length, 0, 'la liste « 1 » du nouvel appareil n\'est pas « Famille »');
    assert.equal(((await asAdmin('GET', '/api/state')).body.devices.find((d: any) => d.id === rule.deviceId)).status, 'normal');
    const warning = `[rules] regle ${rule.id} : la liste « Famille » n'est plus trouvee sur l'appareil de la camera « Camera couloir » : reenregistrez la regle`;
    await until(async () => s.output().includes(warning), 5000, `avertissement\n${s.output().slice(-500)}`);
    assert.equal(s.output().split(warning).length - 1, 1, 'avertissement unique malgre deux visages');
    // Un visage de cet appareil qui porte le bon nom (ou aucun) correspondrait toujours : seule la garde de nom a ecarte « Visiteurs ».
    await emit(devB, recognized(2, '1', '1', 'Alice', 'famille'));
    const found = await incidentsOf(rule);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].cameraIds, ['C-02']);

    // La camera annoncee pour chaque appareil ne bouge pas, meme si C-02 (identifiant plus petit) arrive sur l'appareil 2.
    assert.deepEqual((await asAdmin('GET', '/api/faces/lists')).body.lists.map((l: any) => l.cameraId), ['C-01', 'C-03']);
  });
});

// ---------------------------------------------------------------- regle ancienne, sans camera

describe("regle d'identite ancienne (sans cameraId), inseree directement en base : le serveur demarre, la regle est a reenregistrer et ne declenche pas", { timeout: 180_000 }, () => {
  const dev = fakeRecorder({ address: '127.0.0.1', groups: groupsText('1', 'Famille', 2) });
  let proc: ChildProcess | null = null;
  after(async () => {
    dev.stop();
    if (proc) await stop(proc);
  });

  it('GET /api/rules la renvoie avec needsReview ; aucun declenchement sur un visage « 1 » ; la reactiver telle quelle est refuse (400) ; la reenregistrer avec sa camera la remet en service', async () => {
    const port = await dev.start();
    const dataDir = join(mkdtempSync(join(tmpdir(), 'psim-e2e-rules-old-')), 'data');

    // Premier demarrage : cree la base et le site de demonstration ; on l'arrete pour ecrire la regle ancienne.
    const first = await start({ dataDir });
    await stop(first.proc);
    const OLD_SPEC = {
      who: { type: 'list', listId: '1', listName: 'Famille' },
      where: { cameras: ['C-01'] },
      when: { type: 'always' },
      trigger: { type: 'appears' },
      then: { severity: 'warning' },
      cooldownMinutes: 10,
    };
    const db = openDb(join(dataDir, 'psim.db'));
    try {
      const t = Date.now();
      db.prepare('INSERT INTO presence_rule (id, name, enabled, spec, device_id, source_text, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        1, 'Famille a l accueil (ancienne)', 1, JSON.stringify(OLD_SPEC), 'R-1', null, 'admin', t, 'admin', t,
      );
    } finally {
      db.close();
    }

    // Deuxieme demarrage : la regle ancienne est reprise sans erreur.
    const s = await start({ dataDir });
    proc = s.proc;
    const admin = await login(s.base, 'admin', ADMIN_PW);
    const call = caller(() => s.base);
    const asAdmin = (method: string, path: string, body?: unknown) => call(method, path, admin, body);
    assert.doesNotMatch(s.output(), /\[rules\] regle 1/, 'aucune erreur au chargement de la regle');

    const listed = (await asAdmin('GET', '/api/rules')).body;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].needsReview, true);
    assert.equal(listed[0].enabled, true);
    assert.match(listed[0].summary, /liste « Famille »/);
    assert.match(listed[0].summary, /caméra non précisée/);
    assert.ok((await asAdmin('GET', '/api/state')).body.devices.some((d: any) => d.id === 'R-1'), 'son detecteur existe');

    // La camera C-01 devient une camera de l'appareil (voie 1) : le flux est ouvert, la regle active l'observe.
    const src = await asAdmin('PUT', '/api/cameras/C-01/source', { kind: 'rtsp', host: '127.0.0.1', port: 554, rtspPath: '/cam/realmonitor?channel=1&subtype=1', username: USER, password: PASSWORD });
    assert.equal(src.status, 200, JSON.stringify(src.body));
    const det = await asAdmin('PUT', '/api/detectors/I-01/source', { cameraId: 'C-01', channel: 1, events: ['SmartMotionVehicle'], httpPort: port });
    assert.equal(det.status, 200, JSON.stringify(det.body));
    await until(async () => (await asAdmin('GET', '/api/detectors/I-01/source')).body.connection.state === 'connected', 8000, `liaison\n${s.output().slice(-500)}`);

    const incidents = async () => (await asAdmin('GET', '/api/state')).body.incidents.filter((i: any) => i.detectorId === 'R-1');
    const seen = async () => (await asAdmin('GET', '/api/faces/recent')).body.length;
    const emit = async () => {
      const n = await seen();
      dev.emit(recognized(1, '1', '1', 'Alice', 'Famille'));
      await until(async () => (await seen()) === n + 1, 5000, 'visage enregistre');
      await wait(100);
    };
    await emit();
    assert.equal((await incidents()).length, 0, 'la regle ancienne ne declenche pas sur un visage « 1 »');
    assert.equal((await asAdmin('GET', '/api/state')).body.devices.find((d: any) => d.id === 'R-1').status, 'normal');

    // On peut la desactiver, mais pas la reactiver telle quelle.
    assert.equal((await asAdmin('PUT', '/api/rules/1', { enabled: false })).status, 200);
    const refused = await asAdmin('PUT', '/api/rules/1', { enabled: true });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error, 'Cette regle doit etre reenregistree : choisissez a nouveau la liste');
    const still = (await asAdmin('GET', '/api/rules')).body[0];
    assert.equal(still.enabled, false);
    assert.equal(still.needsReview, true);

    // Reenregistree avec sa camera, elle redevient une regle ordinaire et declenche.
    const fixed = await asAdmin('PUT', '/api/rules/1', { spec: { ...OLD_SPEC, who: { ...OLD_SPEC.who, cameraId: 'C-01' } }, enabled: true });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.equal(fixed.body.needsReview, false);
    assert.equal(fixed.body.enabled, true);
    await emit();
    const after = await incidents();
    assert.equal(after.length, 1, 'declenche apres reenregistrement');
    assert.deepEqual(after[0].cameraIds, ['C-01']);
  });
});
