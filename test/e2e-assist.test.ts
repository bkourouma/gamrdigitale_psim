/**
 * Assistant de regles et listes de visages (phase 2), contre le vrai serveur : droits, validations, quota par personne,
 * cle jamais divulguee, contexte envoye au service (noms seulement), listes de visages lues sur des appareils Dahua
 * (fusion, appareil vide, appareil sans reconnaissance faciale, appareil injoignable) et cache.
 *
 * Aucun appel reel : le service de l'assistant est un faux serveur LOCAL (PSIM_ASSIST_API_URL, http vers 127.0.0.1 seulement),
 * les appareils Dahua sont de faux serveurs Digest sur 127.0.0.x. Aucune cle reelle.
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
import { createFaceLists, stableFaceHosts } from '../server/api.ts';
import { DahuaAuthError } from '../server/dahua.ts';
import type { Credentials } from '../server/dahua.ts';
import { openDb } from '../server/db.ts';
import { seedDemo } from '../server/seed.ts';

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';
const USER = 'psim';
const PASSWORD = 'MotDePasse-XVR-1';
const KEY = 'cle-de-test-assistant-1234';
const GROUPS_PATH = '/cgi-bin/faceRecognitionServer.cgi?action=findGroup';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });

const fixture = (name: string) => readFileSync(join(ROOT, 'test', 'fixtures', name), 'utf8').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------- faux service de l'assistant (API Messages)

interface ServiceCall {
  headers: Record<string, string | string[] | undefined>;
  raw: string;
  body: any;
}

function fakeAssistantService() {
  const calls: ServiceCall[] = [];
  let reply: (sentence: string, call: ServiceCall) => { status?: number; out?: unknown; text?: string } = () => ({ out: { kind: 'refused', name: null, spec: null, question: null, reason: 'Pas prevu.' } });
  const server = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: any = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // corps illisible : consigne tel quel
      }
      const call: ServiceCall = { headers: req.headers, raw, body };
      calls.push(call);
      if (req.headers['x-api-key'] !== KEY) {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'cle refusee' } }));
        return;
      }
      const last = body?.messages?.[body.messages.length - 1]?.content;
      const sentence = typeof last === 'string' ? last : '';
      const r = reply(sentence, call);
      if (r.status && r.status !== 200) {
        res.writeHead(r.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: `refus ${r.status}` } }));
        return;
      }
      const text = r.text ?? JSON.stringify(r.out);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }));
    });
  });
  return {
    calls,
    setReply: (fn: typeof reply) => (reply = fn),
    start: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port))),
    stop: () => server.close(),
  };
}

const ruleOut = (spec: unknown, name = 'Visage inconnu a l accueil') => ({ kind: 'rule', name, spec, question: null, reason: null });
const questionOut = (question: string) => ({ kind: 'question', name: null, spec: null, question, reason: null });
const refusedOut = (reason: string) => ({ kind: 'refused', name: null, spec: null, question: null, reason });

const SPEC_UNKNOWN = {
  who: { type: 'unknown' },
  where: { cameras: ['C-01'] },
  when: { type: 'always' },
  trigger: { type: 'appears' },
  then: { severity: 'warning' },
  cooldownMinutes: 10,
};
// Chaque appareil numerote ses listes : la liste « 1 » de l'appareil de C-01 (Residents et personnel) n'est pas celle de C-10 (Visiteurs).
const SPEC_LIST = { ...SPEC_UNKNOWN, who: { type: 'list', cameraId: 'C-01', listId: '1', listName: 'Residents et personnel' } };
const SPEC_LIST_B = { ...SPEC_UNKNOWN, where: { cameras: ['C-10'] }, who: { type: 'list', cameraId: 'C-10', listId: '1', listName: 'Visiteurs' } };

// ---------------------------------------------------------------- faux appareil Dahua (Digest, flux d'evenements, bases de visages)

type GroupsMode = { kind: 'groups'; text: string } | { kind: 'empty' } | { kind: 'status'; status: number };

function fakeDahuaHost(address: string, groups: GroupsMode) {
  const md5 = (s: string) => createHash('md5').update(s).digest('hex');
  const realm = 'Login to device';
  const nonce = randomBytes(8).toString('hex');
  const streams = new Set<ServerResponse>();
  let hits = 0;
  const server = createHttpServer((req, res) => {
    const auth = String(req.headers.authorization ?? '');
    const p = Object.fromEntries([...auth.matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1], m[2]]));
    const expected = md5(`${md5(`${USER}:${realm}:${PASSWORD}`)}:${nonce}:${p.nc}:${p.cnonce}:auth:${md5(`GET:${p.uri}`)}`);
    if (!auth.startsWith('Digest') || p.username !== USER || p.response !== expected || p.uri !== req.url) {
      res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}", opaque="abc"` }).end();
      return;
    }
    if (req.url === GROUPS_PATH) {
      hits += 1;
      if (groups.kind === 'status') res.writeHead(groups.status).end();
      else res.writeHead(200, { 'Content-Type': 'text/plain' }).end(groups.kind === 'groups' ? groups.text : '');
      return;
    }
    if (req.url?.startsWith('/cgi-bin/eventManager.cgi')) {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=myboundary' });
      streams.add(res);
      res.on('close', () => streams.delete(res));
      res.write('--myboundary\r\nContent-Type: text/plain\r\nContent-Length: 9\r\n\r\nHeartbeat');
      return;
    }
    res.writeHead(404).end();
  });
  return {
    start: () => new Promise<number>((r) => server.listen(0, address, () => r((server.address() as AddressInfo).port))),
    stop: () => {
      for (const s of streams) s.destroy();
      server.close();
    },
    hits: () => hits,
  };
}

// ---------------------------------------------------------------- serveur reel

async function start(extra: Record<string, string>): Promise<{ proc: ChildProcess; base: string; output: () => string }> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    PSIM_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'psim-e2e-assist-')), 'data'),
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
    await wait(250);
  }
  proc.kill();
  throw new Error(`serveur non demarre :\n${output}`);
}

async function login(base: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie()[0].split(';')[0];
}

function caller(base: () => string) {
  return async (method: string, path: string, cookie: string | null, body?: unknown) => {
    const res = await fetch(`${base()}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, text };
  };
}

// ================================================================ avec la cle

describe('assistant de regles et listes de visages (processus reel, avec cle)', { timeout: 240_000 }, () => {
  let s: Awaited<ReturnType<typeof start>>;
  let admin = '';
  let operator = '';
  const service = fakeAssistantService();
  // A : bases (fixture : « 1 » et « 2 ») ; B : une autre base, ELLE AUSSI numerotee « 1 » ; C : sans reconnaissance faciale (501) ; D : injoignable ;
  // E : reponse vide (le XVR actuel).
  const hosts = {
    A: fakeDahuaHost('127.0.0.1', { kind: 'groups', text: fixture('dahua-face-groups.txt') }),
    B: fakeDahuaHost('127.0.0.2', { kind: 'groups', text: 'GroupList[0].groupID=1\nGroupList[0].groupName=Visiteurs\nGroupList[0].groupSize=3\n' }),
    C: fakeDahuaHost('127.0.0.3', { kind: 'status', status: 501 }),
    E: fakeDahuaHost('127.0.0.5', { kind: 'empty' }),
  };
  /** Appels de l'administrateur qui ont atteint le service (donc pris sur son quota). */
  let reached = 0;

  const call = caller(() => s.base);
  const asAdmin = (method: string, path: string, body?: unknown) => call(method, path, admin, body);
  const ask = async (body: unknown, cookie = admin) => {
    const r = await call('POST', '/api/rules/assist', cookie, body);
    if (cookie === admin && ![400, 403, 503].includes(r.status) && !(r.status === 429)) reached += 1;
    return r;
  };

  before(async () => {
    const servicePort = await service.start();
    s = await start({ PSIM_ASSIST_API_KEY: KEY, PSIM_ASSIST_API_URL: `http://127.0.0.1:${servicePort}/v1/messages` });
    admin = await login(s.base, 'admin', ADMIN_PW);
    operator = await login(s.base, 'operateur', OPERATOR_PW);
  });
  after(() => {
    service.stop();
    for (const h of Object.values(hosts)) h.stop();
    s?.proc.kill();
  });

  it("droits : sans session 401, l'operateur 403 sur les quatre routes ; la cle n'est jamais renvoyee", async () => {
    for (const [method, path, body] of [
      ['GET', '/api/rules/assist'],
      ['POST', '/api/rules/assist', { text: 'bonjour' }],
      ['GET', '/api/faces/lists'],
      ['GET', '/api/faces/recent'],
    ] as [string, string, unknown?][]) {
      assert.equal((await call(method, path, null, body)).status, 401, `${method} ${path} sans session`);
      assert.equal((await call(method, path, operator, body)).status, 403, `${method} ${path} par l'operateur`);
    }
    assert.equal(service.calls.length, 0, "les refus d'acces n'atteignent pas le service");
    const status = await asAdmin('GET', '/api/rules/assist');
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, { configured: true });
    assert.ok(!status.text.includes(KEY));
  });

  it("corps invalide : 400 en francais, sans appel au service et sans place prise sur le quota", async () => {
    const bad = async (body: unknown, message: RegExp) => {
      const r = await ask(body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.text}`);
      assert.match(r.body.error, message);
    };
    await bad([1, 2], /un objet est attendu/);
    await bad({}, /« text » .* est requis/);
    await bad({ text: 12 }, /« text » .* est requis/);
    await bad({ text: 'x', plus: 1 }, /champ « plus » non reconnu/);
    await bad({ text: 'x', history: 'non' }, /« history » doit être une liste/);
    await bad({ text: 'x', history: [{ role: 'system', text: 'a' }] }, /chaque échange/);
    await bad({ text: 'x', history: [{ role: 'user' }] }, /chaque échange/);
    await bad({ text: 'x', history: [{ role: 'user', text: 'a', extra: 1 }] }, /chaque échange/);
    await bad({ text: '   ' }, /Décrivez la règle en une phrase/);
    await bad({ text: 'a'.repeat(1001) }, /trop longue/);
    const broken = await ask('{ pas du json');
    assert.equal(broken.status, 400);
    assert.match(broken.body.error, /Requete invalide/);
    assert.equal(service.calls.length, 0, 'aucun appel au service');
  });

  it('appareils declares : un enregistreur et des cameras IP sur 127.0.0.x, dont un qui ne repond pas', async () => {
    const ports: Record<string, number> = { A: await hosts.A.start(), B: await hosts.B.start(), C: await hosts.C.start(), E: await hosts.E.start() };
    const dead = await freePort(); // rien n'ecoute : connexion refusee
    const setup = async (cam: string, name: string, address: string, port: number, detector: string) => {
      if (cam !== 'C-01') {
        assert.equal((await asAdmin('POST', '/api/devices', { id: cam, kind: 'camera', name, zone: 'Accueil' })).status, 201);
        assert.equal((await asAdmin('POST', '/api/devices', { id: detector, kind: 'detector', category: 'intrusion', name: `Mouvement ${name}`, zone: 'Accueil' })).status, 201);
      }
      const src = await asAdmin('PUT', `/api/cameras/${cam}/source`, { kind: 'rtsp', host: address, port: 554, rtspPath: '/cam/realmonitor?channel=1&subtype=1', username: USER, password: PASSWORD });
      assert.equal(src.status, 200, JSON.stringify(src.body));
      const det = await asAdmin('PUT', `/api/detectors/${detector}/source`, { cameraId: cam, channel: 1, events: ['SmartMotionHuman'], httpPort: port });
      assert.equal(det.status, 200, JSON.stringify(det.body));
    };
    await setup('C-01', 'Camera accueil', '127.0.0.1', ports.A, 'I-01');
    await setup('C-10', 'Camera B', '127.0.0.2', ports.B, 'I-10');
    await setup('C-11', 'Camera C', '127.0.0.3', ports.C, 'I-11');
    await setup('C-12', 'Camera D', '127.0.0.4', dead, 'I-12');
    await setup('C-13', 'Camera E', '127.0.0.5', ports.E, 'I-13');
    // Deuxieme voie du premier enregistreur (meme hote que C-01, voie 2) : meme appareil, sans detecteur.
    assert.equal((await asAdmin('POST', '/api/devices', { id: 'C-14', kind: 'camera', name: 'Camera accueil voie 2', zone: 'Accueil' })).status, 201);
    const second = await asAdmin('PUT', '/api/cameras/C-14/source', { kind: 'rtsp', host: '127.0.0.1', port: 554, rtspPath: '/cam/realmonitor?channel=2&subtype=1', username: USER, password: PASSWORD });
    assert.equal(second.status, 200, JSON.stringify(second.body));
  });

  it("listes de visages : fusion des appareils, vide et 501 ignores sans note, injoignable = une note lisible sans adresse ni mot de passe ; cache de 5 minutes", async () => {
    const r = await asAdmin('GET', '/api/faces/lists');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.hosts, 5);
    assert.deepEqual(
      r.body.lists.map((l: any) => [l.id, l.name, l.size, l.cameraId, l.cameraName]),
      [
        ['1', 'Residents et personnel', 12, 'C-01', 'Camera accueil'],
        ['2', 'Interdits', 0, 'C-01', 'Camera accueil'],
        ['1', 'Visiteurs', 3, 'C-10', 'Camera B'],
      ],
    );
    // Chaque liste porte les cameras de TOUTES les voies de son appareil (triees, representante comprise) ; deux appareils : disjoints.
    assert.deepEqual(r.body.lists.map((l: any) => l.deviceCameraIds), [['C-01', 'C-14'], ['C-01', 'C-14'], ['C-10']]);
    assert.equal(r.body.notes.length, 1, JSON.stringify(r.body.notes));
    assert.match(r.body.notes[0], /^La caméra « Camera D » ne répond pas : /);
    assert.doesNotMatch(r.text, /127\.0\.0\./, "aucune adresse IP");
    assert.ok(!r.text.includes(PASSWORD), 'aucun mot de passe');
    assert.deepEqual(Object.keys(r.body).sort(), ['hosts', 'lists', 'notes']);

    // Deuxieme lecture : tout vient du cache, les appareils ne sont pas interroges de nouveau (ni le fautif avant 60 s).
    const before = [hosts.A.hits(), hosts.B.hits(), hosts.C.hits(), hosts.E.hits()];
    assert.deepEqual(before, [1, 1, 1, 1], 'une seule lecture par appareil');
    const again = await asAdmin('GET', '/api/faces/lists');
    assert.deepEqual(again.body, r.body);
    assert.deepEqual([hosts.A.hits(), hosts.B.hits(), hosts.C.hits(), hosts.E.hits()], before, 'cache');
  });

  it("proposition de regle : reconstituee par le faux service, validee par le PSIM ; le contexte envoye ne contient que des noms (listes comprises), jamais d'adresse, de photo ni de mot de passe", async () => {
    service.setReply(() => ({ out: ruleOut(SPEC_UNKNOWN) }));
    const r = await ask({ text: "Prévenez-moi quand un visage inconnu apparaît à l'accueil" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.kind, 'rule');
    assert.deepEqual(r.body.spec, SPEC_UNKNOWN);
    assert.equal(r.body.name, 'Visage inconnu a l accueil');
    assert.match(r.body.summary, /caméra « Camera accueil »/);
    assert.ok(!r.text.includes(KEY), 'la cle ne sort pas');

    assert.equal(service.calls.length, 1);
    const sent = service.calls[0];
    assert.equal(sent.headers['x-api-key'], KEY, 'la cle sert a appeler le service');
    const prompt = sent.body.system.map((b: any) => b.text).join('\n');
    // Les listes lues sur les appareils sont dans l'invite (camera, identifiant, nom), de tous les appareils.
    assert.match(prompt, /- camera C-01 \(« Camera accueil », appareil 1\) : liste 1 : Residents et personnel/);
    assert.match(prompt, /- camera C-01 \(« Camera accueil », appareil 1\) : liste 2 : Interdits/);
    assert.match(prompt, /- camera C-10 \(« Camera B », appareil 2\) : liste 1 : Visiteurs/);
    assert.match(prompt, /C-01 : Camera accueil \(zone Accueil\)/);
    assert.match(prompt, /C-12 : Camera D/);
    assert.match(sent.raw, /Prévenez-moi quand un visage inconnu/);
    assert.doesNotMatch(sent.raw, /\b\d{1,3}(\.\d{1,3}){3}\b/, "aucune adresse IP dans la requete");
    assert.ok(!sent.raw.includes(PASSWORD), 'aucun mot de passe');
    assert.doesNotMatch(sent.raw, /data:image|base64|rtsp|channel=/i, 'aucune image ni chemin video');
    assert.ok(!s.output().includes(KEY), 'la cle ne figure pas dans la sortie du serveur');
  });

  it("deux appareils ayant chacun une liste « 1 » : le contexte les distingue (camera et nom de camera) ; la liste du second appareil est acceptee, un melange des deux ou une portee hors de l'appareil est rejete", async () => {
    service.setReply(() => ({ out: ruleOut(SPEC_UNKNOWN) }));
    const start0 = service.calls.length;
    assert.equal((await ask({ text: 'Quelles listes existent ?' })).status, 200);
    const prompt = service.calls[start0].body.system.map((b: any) => b.text).join('\n');
    const ones = prompt.split('\n').filter((line: string) => /^- camera \S+ \(.*\) : liste 1 : /.test(line));
    assert.deepEqual(
      ones,
      ['- camera C-01 (« Camera accueil », appareil 1) : liste 1 : Residents et personnel', '- camera C-10 (« Camera B », appareil 2) : liste 1 : Visiteurs'],
      'deux lignes, une par appareil, pas de fusion, chacune avec le repere de son appareil',
    );
    // Reperes d'appareil : les deux voies du meme enregistreur (C-01, C-14) portent le meme, un autre appareil un autre ; une camera sans source, aucun.
    const markOf = (id: string) => /\((appareil \d+)\)\s*$/.exec(prompt.split('\n').find((line: string) => line.startsWith(`- ${id} : `)) ?? '')?.[1];
    assert.equal(markOf('C-01'), 'appareil 1');
    assert.equal(markOf('C-14'), 'appareil 1', 'deuxieme voie du meme enregistreur');
    assert.equal(markOf('C-10'), 'appareil 2');
    assert.equal(markOf('C-12'), 'appareil 4');
    assert.equal(markOf('C-02'), undefined, 'camera sans source video : aucun repere');
    assert.doesNotMatch(service.calls[start0].raw, /\b\d{1,3}(\.\d{1,3}){3}\b/, "aucune adresse IP dans la requete");

    // Une proposition correcte pour le second appareil.
    service.setReply(() => ({ out: ruleOut(SPEC_LIST_B, 'Visiteurs sur la camera B') }));
    const ok = await ask({ text: 'Signalez les visiteurs de la camera B' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.kind, 'rule', ok.text);
    assert.deepEqual(ok.body.spec, SPEC_LIST_B);
    assert.match(ok.body.summary, /liste « Visiteurs » \(caméra « Camera B »\)/);

    // Melanges : le cameraId d'un appareil avec la liste de l'autre (meme numero « 1 », autre nom) : rejete, apres un seul nouvel essai.
    for (const who of [
      { type: 'list', cameraId: 'C-10', listId: '1', listName: 'Residents et personnel' },
      { type: 'list', cameraId: 'C-01', listId: '1', listName: 'Visiteurs' },
      { type: 'list', cameraId: 'C-10', listId: '2', listName: 'Interdits' },
    ]) {
      const before = service.calls.length;
      service.setReply(() => ({ out: ruleOut({ ...SPEC_LIST_B, who }) }));
      const mixed = await ask({ text: 'Signalez une liste melangee' });
      assert.equal(mixed.status, 200, mixed.text);
      assert.equal(mixed.body.kind, 'refused', JSON.stringify(who));
      assert.equal(service.calls.length - before, 2, 'un seul nouvel essai');
    }

    // La bonne liste, mais des cameras qui ne sont pas sur son appareil : la meme verification que la saisie manuelle la refuse,
    // et son message (« Ou : ... ») est renvoye au service pour le nouvel essai.
    const before = service.calls.length;
    service.setReply(() => ({ out: ruleOut({ ...SPEC_LIST_B, where: { cameras: ['C-01'] } }) }));
    const outside = await ask({ text: 'Signalez les visiteurs a l accueil' });
    assert.equal(outside.body.kind, 'refused', outside.text);
    assert.equal(service.calls.length - before, 2);
    const retry = service.calls[service.calls.length - 1].body.messages;
    assert.match(retry[retry.length - 1].content, /Ou : aucune camera choisie n'appartient a l'appareil de la liste « Visiteurs »/);
  });

  it("une regle sur une liste connue est acceptee ; une liste inventee est refusee apres un nouvel essai ; question et refus passent tels quels ; l'historique est transmis", async () => {
    service.setReply(() => ({ out: ruleOut(SPEC_LIST, 'Residents a l accueil') }));
    const known = await ask({ text: 'Signalez les résidents à l accueil' });
    assert.equal(known.status, 200, known.text);
    assert.equal(known.body.kind, 'rule');
    assert.deepEqual(known.body.spec.who, { type: 'list', cameraId: 'C-01', listId: '1', listName: 'Residents et personnel' });

    const before = service.calls.length;
    service.setReply(() => ({ out: ruleOut({ ...SPEC_LIST, who: { type: 'list', cameraId: 'C-01', listId: '99', listName: 'Inventee' } }) }));
    const invented = await ask({ text: 'Signalez les inventés' });
    assert.equal(invented.status, 200);
    assert.equal(invented.body.kind, 'refused');
    assert.equal(service.calls.length - before, 2, 'un seul nouvel essai');

    service.setReply(() => ({ out: questionOut('Quelle caméra ?') }));
    const q = await ask({ text: 'Prévenez-moi la nuit', history: [{ role: 'user', text: 'Bonjour' }, { role: 'assistant', text: 'Que voulez-vous surveiller ?' }] });
    assert.deepEqual(q.body, { kind: 'question', question: 'Quelle caméra ?' });
    const sent = service.calls[service.calls.length - 1].body.messages;
    assert.equal(sent.length, 3, 'deux echanges d\'historique + la nouvelle phrase');
    assert.equal(sent[0].role, 'user');

    service.setReply(() => ({ out: refusedOut('Je ne sais écrire que des règles de présence.') }));
    const refused = await ask({ text: 'Raconte une blague' });
    assert.deepEqual(refused.body, { kind: 'refused', reason: 'Je ne sais écrire que des règles de présence.' });
  });

  it("panne du service : erreur en francais (cle refusee, service indisponible), jamais la cle ni l'adresse du service", async () => {
    service.setReply(() => ({ status: 503 }));
    const down = await ask({ text: 'Une règle' });
    assert.equal(down.status, 502, down.text);
    assert.match(down.body.error, /momentanément indisponible/);
    assert.ok(!down.text.includes(KEY));
    assert.doesNotMatch(down.text, /127\.0\.0\.1/);
    assert.ok(!s.output().includes(KEY));
  });

  it("journal : une entree « rule_assist » par demande (acteur, nombre de caracteres, type de proposition), jamais la phrase ni la cle", async () => {
    const audit = (await asAdmin('GET', '/api/audit?limit=200')).text;
    const entries = (JSON.parse(audit) as any[]).filter((e) => e.action === 'rule_assist');
    assert.equal(entries.length, reached, JSON.stringify(entries));
    assert.ok(entries.every((e) => e.actor === 'admin'));
    assert.ok(entries.some((e) => /\d+ caractères ; proposition : rule/.test(e.details)));
    assert.ok(entries.some((e) => /proposition : question/.test(e.details)));
    assert.ok(entries.some((e) => /proposition : refused/.test(e.details)));
    assert.ok(entries.some((e) => /proposition : erreur/.test(e.details)));
    assert.ok(!audit.includes(KEY));
    assert.ok(!audit.includes('Prévenez-moi quand un visage inconnu'), 'la phrase complete n\'est pas journalisee');
  });

  it("observations de visages recentes : liste vide au depart, reservee a l'administrateur", async () => {
    const r = await asAdmin('GET', '/api/faces/recent');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  });

  it("quota : 20 propositions par heure et PAR PERSONNE ; la 21e de la meme personne est refusee (429), une autre personne n'est pas touchee", async () => {
    service.setReply(() => ({ out: ruleOut(SPEC_UNKNOWN) }));
    // Un second administrateur (mot de passe temporaire a changer a la premiere connexion).
    const TEMP = 'Mot-de-passe-temporaire-8';
    const NEXT = 'Mot-de-passe-solide-et-neuf-9';
    assert.equal((await asAdmin('POST', '/api/users', { username: 'adjoint', role: 'admin', password: TEMP, reauth: ADMIN_PW })).status, 201);
    const tempCookie = (await fetch(`${s.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'adjoint', password: TEMP }) })).headers.getSetCookie()[0].split(';')[0];
    assert.equal((await call('POST', '/api/me/password', tempCookie, { current: TEMP, next: NEXT })).status, 200);
    const adjoint = await login(s.base, 'adjoint', NEXT);

    let last = await ask({ text: 'Encore une règle' });
    while (last.status === 200 && reached < 20) last = await ask({ text: 'Encore une règle' });
    assert.equal(reached, 20, 'vingt demandes ont atteint le service');
    const served = service.calls.length;
    const refused = await ask({ text: 'Une de trop' });
    assert.equal(refused.status, 429, refused.text);
    assert.equal(refused.body.error, "Trop de demandes à l'assistant (20 par heure). Réessayez plus tard.");
    assert.equal(service.calls.length, served, 'la 21e n\'atteint pas le service');
    // Un corps invalide reste un 400 (et n'est pas un 429 deguise) ; l'autre administrateur a son propre quota.
    assert.equal((await ask({ text: 12 })).status, 400);
    const other = await call('POST', '/api/rules/assist', adjoint, { text: 'Ma règle à moi' });
    assert.equal(other.status, 200, other.text);
    assert.equal(other.body.kind, 'rule');
  });

  it("le service ne voit jamais d'autre cle, et la sortie du serveur n'a jamais contenu la cle", () => {
    for (const c of service.calls) assert.equal(c.headers['x-api-key'], KEY);
    assert.ok(!s.output().includes(KEY));
  });
});

// ================================================================ sans cle

describe('assistant de regles sans cle (processus reel)', { timeout: 120_000 }, () => {
  let s: Awaited<ReturnType<typeof start>>;
  let admin = '';
  const service = fakeAssistantService();
  const call = caller(() => s.base);

  before(async () => {
    const servicePort = await service.start();
    s = await start({ PSIM_ASSIST_API_URL: `http://127.0.0.1:${servicePort}/v1/messages` });
    admin = await login(s.base, 'admin', ADMIN_PW);
  });
  after(() => {
    service.stop();
    s?.proc.kill();
  });

  it('GET : configured = false ; POST : 503 « Assistant non configuré » sans aucun appel ; un corps invalide reste un 400', async () => {
    assert.deepEqual((await call('GET', '/api/rules/assist', admin)).body, { configured: false });
    const r = await call('POST', '/api/rules/assist', admin, { text: 'Prévenez-moi' });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'Assistant non configuré');
    assert.equal((await call('POST', '/api/rules/assist', admin, { nope: 1 })).status, 400);
    assert.equal(service.calls.length, 0);
  });

  it('aucun appareil declare : { lists: [], notes: [], hosts: 0 } ; aucun visage vu', async () => {
    assert.deepEqual((await call('GET', '/api/faces/lists', admin)).body, { lists: [], notes: [], hosts: 0 });
    assert.deepEqual((await call('GET', '/api/faces/recent', admin)).body, []);
  });
});

// ================================================================ configuration

describe("PSIM_ASSIST_API_URL : https partout, http seulement vers cette machine ; la cle n'apparait jamais dans l'erreur", () => {
  const boot = (url: string) =>
    new Promise<{ code: number | null; output: string }>((resolveRun) => {
      const env: NodeJS.ProcessEnv = {};
      for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
      Object.assign(env, { PSIM_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'psim-assist-url-')), 'data'), PSIM_PORT: '0', PSIM_ASSIST_API_KEY: KEY, PSIM_ASSIST_API_URL: url });
      let output = '';
      const proc = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stdout!.on('data', (d) => (output += d));
      proc.stderr!.on('data', (d) => (output += d));
      proc.on('exit', (code) => resolveRun({ code, output }));
      setTimeout(() => proc.kill(), 20_000).unref();
    });

  for (const url of ['http://assistant.example.com/v1/messages', 'ftp://127.0.0.1/x', 'pas une adresse']) {
    it(`refuse ${url} au demarrage`, async () => {
      const r = await boot(url);
      assert.notEqual(r.code, 0);
      assert.match(r.output, /PSIM_ASSIST_API_URL/);
      assert.ok(!r.output.includes(KEY));
    });
  }
});

// ================================================================ cache des listes (en processus, horloge maitrisee)

describe('listes de visages : cache par appareil (en processus, horloge maitrisee)', () => {
  const cred = (host: string, password = 'secret-pw'): Credentials => ({ host, port: 80, username: 'admin', password });
  const GROUP = [{ id: '1', name: 'Famille', size: 2 }];

  function setup(behaviour: (creds: Credentials, attempt: number) => Promise<typeof GROUP> | typeof GROUP) {
    let clock = 1_000_000;
    const attempts = new Map<string, number>();
    const hostsNow = [{ cameraId: 'C-1', creds: cred('10.0.0.1') }];
    const lists = createFaceLists({
      hosts: () => hostsNow,
      cameraName: (id) => `Camera ${id}`,
      now: () => clock,
      fetchGroups: async (creds) => {
        const n = (attempts.get(creds.host) ?? 0) + 1;
        attempts.set(creds.host, n);
        return behaviour(creds, n);
      },
    });
    return { lists, attempts, advance: (ms: number) => (clock += ms), hostsNow };
  }

  it("succes : 5 minutes de cache ; echec : pas de nouvel essai avant 60 s, les dernieres bases restent utilisables", async () => {
    const t = setup((_c, n) => {
      if (n === 2) throw new Error('connexion coupee par l\'appareil');
      return GROUP;
    });
    assert.deepEqual((await t.lists.read()).lists.map((l) => l.id), ['1']);
    t.advance(299_000);
    await t.lists.read();
    assert.equal(t.attempts.get('10.0.0.1'), 1, 'toujours le cache a 4 min 59');
    t.advance(2_000);
    const failed = await t.lists.read();
    assert.equal(t.attempts.get('10.0.0.1'), 2);
    assert.equal(failed.notes.length, 1);
    assert.match(failed.notes[0], /^La caméra « Camera C-1 » ne répond pas : connexion coupee par l'appareil\.$/);
    assert.deepEqual(failed.lists.map((l) => l.id), ['1'], 'dernieres bases connues');
    t.advance(59_000);
    await t.lists.read();
    assert.equal(t.attempts.get('10.0.0.1'), 2, 'pas de rafale : 59 s apres un echec');
    t.advance(2_000);
    const healed = await t.lists.read();
    assert.equal(t.attempts.get('10.0.0.1'), 3);
    assert.deepEqual(healed.notes, []);
  });

  it("identifiants refuses : pas de nouvel essai avant 5 minutes ; un mot de passe change est relu tout de suite", async () => {
    const t = setup(() => {
      throw new DahuaAuthError("identifiants refuses par l'appareil (ceux de la camera)");
    });
    const first = await t.lists.read();
    assert.match(first.notes[0], /identifiants refuses/);
    t.advance(240_000);
    await t.lists.read();
    assert.equal(t.attempts.get('10.0.0.1'), 1, 'toujours refuse a 4 min');
    t.advance(61_000);
    await t.lists.read();
    assert.equal(t.attempts.get('10.0.0.1'), 2, 'nouvel essai apres 5 min');
    t.hostsNow[0] = { cameraId: 'C-1', creds: cred('10.0.0.1', 'autre-mot-de-passe') };
    await t.lists.read();
    assert.equal(t.attempts.get('10.0.0.1'), 3, 'identifiants modifies : nouvel essai immediat');
  });

  it("appareil muet : la lecture rend la main au bout du delai (note), sans bloquer les autres ; la reponse tardive est gardee", async () => {
    let release: (g: typeof GROUP) => void = () => {};
    const t = setup((c) => (c.host === '10.0.0.9' ? new Promise<typeof GROUP>((r) => (release = r)) : GROUP));
    t.hostsNow.push({ cameraId: 'C-9', creds: cred('10.0.0.9') });
    const started = Date.now();
    const r = await t.lists.read(150);
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(r.lists.map((l) => l.cameraId), ['C-1']);
    assert.equal(r.notes.length, 1);
    assert.match(r.notes[0], /^La caméra « Camera C-9 » ne répond pas : pas de réponse de l'appareil\.$/);
    assert.deepEqual(t.lists.cached().map((l) => l.id), ['1'], 'le contexte de l\'assistant ne bloque pas non plus');
    release([{ id: '5', name: 'Tardive', size: 1 }]);
    await new Promise((r2) => setTimeout(r2, 20));
    const later = await t.lists.read(150);
    assert.deepEqual(later.lists.map((l) => l.id).sort(), ['1', '5']);
    assert.deepEqual(later.notes, []);
  });

  it("sans reconnaissance faciale (404/501) : ignore sans note ; le message de l'appareil n'expose ni adresse ni mot de passe", async () => {
    const t = setup(() => {
      throw new Error("l'appareil ne propose pas la reconnaissance faciale (faceRecognitionServer.cgi)");
    });
    assert.deepEqual(await t.lists.read(), { lists: [], notes: [], hosts: 1 });
    const leaky = setup((c) => {
      throw new Error(`echec vers ${c.host} avec ${c.password}`);
    });
    const r = await leaky.lists.read();
    assert.ok(!r.notes[0].includes('10.0.0.1') && !r.notes[0].includes('secret-pw'), r.notes[0]);
  });
});

describe("listes de visages : contexte de l'assistant, une ligne par (appareil, liste)", () => {
  const cred = (host: string): Credentials => ({ host, port: 80, username: 'admin', password: 'secret-pw' });
  const make = (byHost: Record<string, { id: string; name: string; size?: number }[]>, hosts: { cameraId: string; creds: Credentials }[]) =>
    createFaceLists({ hosts: () => hosts, cameraName: (id) => `Camera ${id}`, now: () => 1_000_000, fetchGroups: async (c) => byHost[c.host] ?? [] });

  it("deux appareils ayant tous deux une liste « 1 » du meme nom (ou non) donnent deux lignes, chacune avec sa camera et le nom de sa camera", async () => {
    const same = make({ '10.0.0.1': [{ id: '1', name: 'Famille' }], '10.0.0.2': [{ id: '1', name: 'Famille' }] }, [
      { cameraId: 'C-1', creds: cred('10.0.0.1') },
      { cameraId: 'C-2', creds: cred('10.0.0.2') },
    ]);
    assert.deepEqual(same.cached(), [], 'rien de lu : le contexte ne lit rien');
    await same.read();
    assert.deepEqual(same.cached(), [
      { cameraId: 'C-1', cameraName: 'Camera C-1', id: '1', name: 'Famille' },
      { cameraId: 'C-2', cameraName: 'Camera C-2', id: '1', name: 'Famille' },
    ]);

    const other = make({ '10.0.0.1': [{ id: '1', name: 'Famille' }, { id: '2', name: 'Interdits' }], '10.0.0.2': [{ id: '1', name: 'Visiteurs' }] }, [
      { cameraId: 'C-1', creds: cred('10.0.0.1') },
      { cameraId: 'C-2', creds: cred('10.0.0.2') },
    ]);
    await other.read();
    assert.deepEqual(other.cached().map((l) => [l.cameraId, l.id, l.name]), [
      ['C-1', '1', 'Famille'],
      ['C-1', '2', 'Interdits'],
      ['C-2', '1', 'Visiteurs'],
    ]);
  });

  it("un appareil declare deux fois n'est compte qu'une fois ; un appareil en echec garde ses dernieres listes dans le contexte", async () => {
    let broken = false;
    const hosts = [
      { cameraId: 'C-1', creds: cred('10.0.0.1') },
      { cameraId: 'C-1', creds: cred('10.0.0.1') },
    ];
    let clock = 1_000_000;
    const lists = createFaceLists({
      hosts: () => hosts,
      cameraName: (id) => `Camera ${id}`,
      now: () => clock,
      fetchGroups: async () => {
        if (broken) throw new Error('coupure');
        return [{ id: '1', name: 'Famille' }];
      },
    });
    await lists.read();
    assert.equal(lists.cached().length, 1);
    broken = true;
    clock += 6 * 60_000;
    await lists.read();
    assert.deepEqual(lists.cached().map((l) => l.id), ['1'], 'dernieres listes connues');
  });
});

describe("camera annoncee pour chaque appareil (stableFaceHosts) : la meme d'une lecture a l'autre", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'psim-stable-'));
    const db = openDb(join(dir, 'psim.db'));
    seedDemo(db, dir, join(ROOT, 'seed'));
    db.exec('DELETE FROM camera_source');
    const put = (camera: string, host: string, path = '/cam/realmonitor?channel=1&subtype=1') =>
      db.prepare("INSERT OR REPLACE INTO camera_source (device_id, kind, host, port, rtsp_path, username, secret) VALUES (?, 'rtsp', ?, 554, ?, 'u', 's')").run(camera, host, path);
    // Comme faceHosts de dahua.ts : la premiere camera de chaque hote, par ordre d'identifiant.
    const first = () => {
      const seen = new Set<string>();
      const out: { cameraId: string; creds: Credentials }[] = [];
      for (const r of db.prepare('SELECT device_id, host, rtsp_path FROM camera_source WHERE rtsp_path IS NOT NULL ORDER BY device_id').all() as { device_id: string; host: string; rtsp_path: string }[]) {
        if (!/channel=\d+/i.test(r.rtsp_path) || seen.has(r.host)) continue;
        seen.add(r.host);
        out.push({ cameraId: r.device_id, creds: { host: r.host, port: 80, username: 'u', password: 'p' } });
      }
      return out;
    };
    const stable = stableFaceHosts(db, first);
    const ids = () => stable().map((h) => `${h.creds.host}=${h.cameraId}`).sort();
    return { db, put, ids, raw: () => first().map((h) => `${h.creds.host}=${h.cameraId}`).sort() };
  }

  it("une camera d'identifiant plus petit ajoutee sur l'hote ne change pas la camera annoncee ; une autre adresse ne s'en mele pas", () => {
    const t = setup();
    try {
      t.put('C-02', '10.0.0.1');
      t.put('C-03', '10.0.0.1');
      t.put('C-04', '10.0.0.2');
      assert.deepEqual(t.ids(), ['10.0.0.1=C-02', '10.0.0.2=C-04']);
      t.put('C-01', '10.0.0.1');
      assert.deepEqual(t.raw(), ['10.0.0.1=C-01', '10.0.0.2=C-04'], 'sans memoire, la camera annoncee changerait');
      for (let i = 0; i < 3; i++) assert.deepEqual(t.ids(), ['10.0.0.1=C-02', '10.0.0.2=C-04'], `lecture ${i + 1}`);
    } finally {
      t.db.close();
    }
  });

  it("la camera annoncee est remplacee quand elle ne lit plus l'hote (supprimee, adresse changee, plus de voie), puis reste stable", () => {
    const t = setup();
    try {
      t.put('C-02', '10.0.0.1');
      t.put('C-03', '10.0.0.1');
      t.put('C-05', '10.0.0.2');
      assert.deepEqual(t.ids(), ['10.0.0.1=C-02', '10.0.0.2=C-05']);
      // Supprimee : la suivante par ordre d'identifiant, puis elle ne bouge plus meme si C-02 revient.
      t.db.prepare('DELETE FROM camera_source WHERE device_id = ?').run('C-02');
      assert.deepEqual(t.ids(), ['10.0.0.1=C-03', '10.0.0.2=C-05']);
      t.put('C-02', '10.0.0.1');
      assert.deepEqual(t.ids(), ['10.0.0.1=C-03', '10.0.0.2=C-05']);
      // Adresse changee : C-03 ne lit plus l'hote 10.0.0.1.
      t.put('C-03', '10.0.0.9');
      assert.deepEqual(t.ids(), ['10.0.0.1=C-02', '10.0.0.2=C-05', '10.0.0.9=C-03']);
      // Plus de voie dans le chemin video : elle ne lit plus rien.
      t.put('C-02', '10.0.0.1', '/live');
      t.put('C-04', '10.0.0.1');
      assert.deepEqual(t.ids(), ['10.0.0.1=C-04', '10.0.0.2=C-05', '10.0.0.9=C-03']);
      assert.deepEqual(t.ids(), ['10.0.0.1=C-04', '10.0.0.2=C-05', '10.0.0.9=C-03']);
    } finally {
      t.db.close();
    }
  });
});
