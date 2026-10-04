/**
 * Auto-test d'intrusion en boite noire, contre un vrai serveur jetable :
 *  1. matrice d'autorisations : TOUTES les routes declarees dans server/api.ts, sans session, en operateur, en session
 *     restreinte, et une route sans garde declaree (hors liste blanche) fait echouer le test ;
 *  2. fuzzing : chaque route recoit des corps, des parametres et des chaines d'attaque ; jamais d'erreur 5xx, jamais de plantage ;
 *  3. protocole : requetes HTTP malformees, en-tetes geants, connexions lentes ou nombreuses.
 *
 * Ce n'est PAS un test d'intrusion par un tiers : il ne remplace pas une evaluation externe de l'installation reelle.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createConnection, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';
const INGEST = 'jeton-attaque-0123456789abcdef';

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Reply {
  status: number;
  body: any;
  cookie: string | null;
}

function http(port: number, method: string, path: string, opts: { body?: string | Buffer; json?: unknown; cookie?: string | null; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const payload = opts.json !== undefined ? JSON.stringify(opts.json) : (opts.body ?? null);
    const headers: Record<string, string | number> = { ...(opts.cookie ? { Cookie: opts.cookie } : {}), ...opts.headers };
    if (payload !== null) {
      headers['Content-Length'] = Buffer.byteLength(payload);
      if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
    }
    const req = request({ host: '127.0.0.1', port, method, path, headers, timeout: 15_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: any = text;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          // pas du JSON (HTML, CSV...)
        }
        const set = res.headers['set-cookie']?.[0];
        resolveReply({ status: res.statusCode ?? 0, body, cookie: set ? set.split(';')[0] : null });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('delai depasse')));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

interface Route {
  method: string;
  path: string;
  guard: 'anyUser' | 'adminOnly' | 'none';
}

/** Routes declarees dans server/api.ts (analyse du texte : une route ajoutee demain est testee sans rien declarer ici). */
function declaredRoutes(): Route[] {
  const src = readFileSync(join(ROOT, 'server', 'api.ts'), 'utf8');
  const out: Route[] = [];
  const re = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,\s*([A-Za-z_]+)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    out.push({ method: m[1].toUpperCase(), path: m[2], guard: m[3] === 'anyUser' || m[3] === 'adminOnly' ? m[3] : 'none' });
  }
  return out;
}

/** Routes volontairement SANS garde de session (authentifiees autrement, ou publiques). Toute autre route sans garde est un defaut. */
const PUBLIC = new Set(['GET /healthz', 'GET /api/demo-accounts', 'POST /api/login', 'POST /api/login/2fa', 'POST /api/logout', 'POST /api/ingest/:id']);

const concrete = (path: string) => path.replace(/:zone/g, 'Accueil').replace(/:id/g, '1').replace(/:[A-Za-z]+/g, 'x');
const key = (r: Route) => `${r.method} ${r.path}`;

describe('auto-test d intrusion (boite noire, serveur reel)', { timeout: 280_000 }, () => {
  let proc: ChildProcess;
  let port = 0;
  let output = '';
  let admin = '';
  let operator = '';
  let restricted = '';
  const routes = declaredRoutes();

  const alive = async () => proc.exitCode === null && (await http(port, 'GET', '/healthz')).status === 200;
  const login = async (user: string, pw: string) => {
    const r = await http(port, 'POST', '/api/login', { json: { username: user, password: pw } });
    assert.equal(r.status, 200, output);
    return r;
  };

  before(async () => {
    port = await freePort();
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
    Object.assign(env, {
      PSIM_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'psim-atk-')), 'data'),
      PSIM_PORT: String(port),
      PSIM_MQTT_PORT: String(await freePort()),
      PSIM_ADMIN_PASSWORD: ADMIN_PW,
      PSIM_OPERATOR_PASSWORD: OPERATOR_PW,
      PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3',
      PSIM_DEMO_LOGIN: '0',
      PSIM_REQUIRE_2FA: 'none',
      PSIM_INGEST_TOKEN: INGEST,
      PSIM_TRUST_PROXY: '1', // pour varier l'adresse source (X-Forwarded-For) sans toucher aux limites
    });
    proc = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout!.on('data', (d) => (output += d));
    proc.stderr!.on('data', (d) => (output += d));
    for (let i = 0; i < 80; i++) {
      try {
        if ((await http(port, 'GET', '/healthz')).status === 200) break;
      } catch {
        // pas encore pret
      }
      await wait(250);
    }
    admin = (await login('admin', ADMIN_PW)).cookie!;
    operator = (await login('operateur', OPERATOR_PW)).cookie!;
    // Session « restreinte » : un compte cree par l'administrateur doit changer son mot de passe avant tout.
    const created = await http(port, 'POST', '/api/users', { cookie: admin, json: { username: 'restreint', role: 'admin', password: 'Hippopotame-bleu-42-lune' } });
    assert.equal(created.status, 201);
    restricted = (await login('restreint', 'Hippopotame-bleu-42-lune')).cookie!;
  });

  after(() => proc?.kill());

  describe('matrice d autorisations', () => {
    it("l'analyse trouve les routes du serveur (garde-fou du test lui-meme)", () => {
      assert.ok(routes.length >= 50, `${routes.length} routes analysees`);
      assert.ok(routes.some((r) => key(r) === 'DELETE /api/users/:username' && r.guard === 'adminOnly'));
      assert.ok(routes.some((r) => key(r) === 'GET /api/state' && r.guard === 'anyUser'));
    });

    it("AUCUNE route n'est declaree sans garde de session, hors liste blanche (une route oubliee fait echouer ce test)", () => {
      const unguarded = routes.filter((r) => r.guard === 'none' && !PUBLIC.has(key(r))).map(key);
      assert.deepEqual(unguarded, [], `routes sans garde : ${unguarded.join(', ')}`);
    });

    it("sans session : 401 partout (jamais de donnee, jamais d'erreur 5xx), meme avec un corps hostile", async () => {
      for (const r of routes.filter((x) => x.guard !== 'none')) {
        const res = await http(port, r.method, concrete(r.path), { json: r.method === 'GET' ? undefined : { x: 1 } });
        assert.equal(res.status, 401, `${key(r)} sans session`);
      }
      assert.ok(await alive());
    });

    it("operateur : 403 sur toutes les routes d'administration, jamais 401/5xx sur les autres", async () => {
      for (const r of routes.filter((x) => x.guard !== 'none')) {
        if (r.path === '/api/onvif/discover') continue; // multidiffusion de 4 s : sans interet ici
        const res = await http(port, r.method, concrete(r.path), { cookie: operator, json: r.method === 'GET' ? undefined : {} });
        if (r.guard === 'adminOnly') assert.equal(res.status, 403, `${key(r)} en operateur`);
        // Un 403 METIER (« mot de passe actuel incorrect ») est normal ; seul « Droits insuffisants » trahirait un refus de role a tort.
        else assert.ok(res.status !== 401 && res.status < 500 && !(res.status === 403 && res.body?.error === 'Droits insuffisants'), `${key(r)} en operateur : ${res.status} ${JSON.stringify(res.body).slice(0, 80)}`);
      }
      assert.ok(await alive());
    });

    it("session restreinte (mot de passe a changer) : tout est refuse sauf les 4 routes de son compte", async () => {
      const allowed = new Set(['GET /api/me', 'POST /api/me/password', 'POST /api/me/2fa/setup', 'POST /api/me/2fa/enable']);
      for (const r of routes.filter((x) => x.guard !== 'none')) {
        if (allowed.has(key(r)) || r.path === '/api/onvif/discover') continue;
        const res = await http(port, r.method, concrete(r.path), { cookie: restricted, json: r.method === 'GET' ? undefined : {} });
        assert.equal(res.status, 403, `${key(r)} en session restreinte`);
        assert.ok(res.body?.restricted, `${key(r)} : doit expliquer l'etape requise`);
      }
    });

    it("variantes de chemin (casse, barre finale, double barre, encodage) : jamais d'acces sans session", async () => {
      for (const path of ['/API/state', '/api/state/', '//api/state', '/api//state', '/api/%73tate', '/api/state%00', '/api/state;x=1', '/api/state?x=1#y', '/./api/state', '/api/../api/state', '/%2e%2e/api/state']) {
        const res = await http(port, 'GET', path);
        assert.ok([401, 404].includes(res.status), `${path} : ${res.status}`);
        assert.ok(!(res.status === 200 && res.body?.devices), `${path} ne doit rien livrer`);
      }
      assert.ok(await alive());
    });

    it("methodes inattendues (TRACE, CONNECT-like, PROPFIND, verbe inconnu) : refusees sans plantage", async () => {
      for (const method of ['TRACE', 'PROPFIND', 'PURGE', 'FOO', 'OPTIONS', 'HEAD']) {
        const res = await http(port, method, '/api/state', { cookie: admin });
        assert.ok(res.status < 500, `${method} : ${res.status}`);
      }
      assert.ok(await alive());
    });
  });

  describe('fuzzing : jamais d erreur 5xx, jamais de plantage', () => {
    const deep = (n: number): unknown => (n === 0 ? 'x' : { a: deep(n - 1) });
    const corpus: { name: string; json?: unknown; raw?: string; contentType?: string }[] = [
      { name: 'null', json: null },
      { name: 'nombre', json: 123 },
      { name: 'tableau vide', json: [] },
      { name: 'objet vide', json: {} },
      { name: 'chaine', json: 'x' },
      { name: '__proto__', raw: '{"__proto__":{"admin":true,"role":"admin"},"constructor":{"prototype":{"x":1}}}' },
      { name: 'operateurs NoSQL', json: { state: { $gt: '' }, event: { $ne: null }, value: { $where: '1' }, username: { $regex: '.*' }, password: { $gt: '' } } },
      { name: 'longue chaine', json: { name: 'x'.repeat(20_000), zone: 'y'.repeat(20_000), comment: 'z'.repeat(20_000), message: 'm'.repeat(5000) } },
      { name: 'imbrication profonde', json: deep(300) },
      { name: 'nombres extremes', json: { x: 1e308, y: -1e308, id: Number.MAX_SAFE_INTEGER, hours: 1e21, value: 1e999, port: -1, hour: 99999999999, level: 2.5 } },
      { name: 'caracteres speciaux', json: { name: "'; DROP TABLE device;--", zone: '<script>alert(1)</script>', username: '../../etc/passwd', address: '\u0000\u001b[2J\r\nBcc: x@y.z', label: '${7*7}{{7*7}}' } },
      { name: 'unicode', json: { name: '\ud800', zone: '𝕏'.repeat(50), username: 'é'.repeat(70), password: '‮' } },
      { name: 'types melanges', json: { id: [], kind: {}, category: 5, direction: [], zone: null, cameraIds: 'pas-une-liste', recipients: 3, schedule: 'x', mode: 1, hours: '2', days: 'lun' } },
      { name: 'JSON casse', raw: '{"a":', contentType: 'application/json' },
      { name: 'JSON hors specification', raw: "{'a': 1,}", contentType: 'application/json' },
      { name: 'mauvais type de contenu', raw: 'a=1&b=2', contentType: 'application/x-www-form-urlencoded' },
      { name: 'binaire', raw: '\u0000\u0001\u0002��', contentType: 'application/octet-stream' },
    ];

    const skip = new Set(['POST /api/logout', 'POST /api/ingest/:id']);

    it("tous les corps hostiles sur toutes les routes, en administrateur : aucune erreur 5xx", async () => {
      const failures: string[] = [];
      for (const r of routes.filter((x) => x.guard !== 'none' && !skip.has(key(x)) && x.path !== '/api/onvif/discover')) {
        for (const c of corpus) {
          if (r.method === 'GET') continue;
          const headers: Record<string, string> = c.contentType ? { 'Content-Type': c.contentType } : c.raw ? { 'Content-Type': 'application/json' } : {};
          const res = await http(port, r.method, concrete(r.path), { cookie: admin, ...(c.raw !== undefined ? { body: c.raw } : { json: c.json }), headers });
          if (res.status >= 500) failures.push(`${key(r)} <- ${c.name} : ${res.status} ${JSON.stringify(res.body).slice(0, 100)}`);
          if (res.status === 401) admin = (await login('admin', ADMIN_PW)).cookie!; // une des routes a pu fermer la session : on se reconnecte
        }
        assert.ok(await alive(), `le serveur est tombe apres ${key(r)} :\n${output.slice(-600)}`);
      }
      assert.deepEqual(failures, []);
    });

    it("parametres de chemin et de requete hostiles sur toutes les routes de lecture : aucune erreur 5xx", async () => {
      const failures: string[] = [];
      const params = ['%', '%00', '..%2f..%2f', "'%20OR%201=1--", '%3Cscript%3E', 'x'.repeat(5000), '-1', '1e999', 'NaN', '%E0%A4%A', '__proto__', 'constructor'];
      const queries = ['?limit=-1', '?limit=999999999', '?limit=abc', '?from=%00&to=x', '?from[]=1&to[a]=2', '?category=%27', `?${'a=1&'.repeat(500)}`, '?from=2026-13-45&to=2026-02-30', '?limit=1e308'];
      for (const r of routes.filter((x) => x.method === 'GET' && x.guard !== 'none' && x.path !== '/api/onvif/discover')) {
        for (const p of params) {
          const path = r.path.replace(/:[A-Za-z]+/g, p);
          const res = await http(port, 'GET', path, { cookie: admin }).catch((e) => ({ status: -1, body: String(e) }));
          if (res.status >= 500 || res.status === -1) failures.push(`GET ${r.path} param « ${p.slice(0, 30)} » : ${res.status}`);
        }
        for (const q of queries) {
          const res = await http(port, 'GET', concrete(r.path) + q, { cookie: admin }).catch((e) => ({ status: -1, body: String(e) }));
          if (res.status >= 500 || res.status === -1) failures.push(`GET ${r.path}${q.slice(0, 40)} : ${res.status}`);
        }
        assert.ok(await alive(), `tombe apres GET ${r.path}`);
      }
      assert.deepEqual(failures, []);
    });

    it("entree des equipements : jeton faux, messages hostiles, identifiants d'attaque", async () => {
      const post = (id: string, token: string | null, body: unknown) =>
        http(port, 'POST', `/api/ingest/${id}`, { json: body, headers: token ? { Authorization: `Bearer ${token}` } : {} });
      assert.equal((await post('D-01', null, { state: 'alarm' })).status, 401);
      assert.equal((await post('D-01', 'x'.repeat(10_000), { state: 'alarm' })).status, 401);
      for (const body of [null, [], 'x', 1, { state: { $gt: '' } }, { event: '__proto__' }, { value: 'NaN' }, { value: 1e999 }, { state: 'alarm', event: 'x', value: 'y' }]) {
        const res = await post('D-01', INGEST, body);
        assert.ok(res.status === 204 || (res.status >= 400 && res.status < 500), `${JSON.stringify(body)} : ${res.status}`);
      }
      for (const id of ['..%2f..%2fetc', '%00', 'x'.repeat(500), '__proto__', 'constructor', "D-01'--"]) {
        const res = await post(id, INGEST, { state: 'alarm' });
        assert.ok(res.status >= 400 && res.status < 500, `${id.slice(0, 20)} : ${res.status}`);
      }
      assert.ok(await alive());
    });

    it("televersement du plan : types, signatures, tailles et SVG pieges", async () => {
      const put = (type: string, body: Buffer) => http(port, 'PUT', '/api/plan', { cookie: admin, body, headers: { 'Content-Type': type } });
      assert.equal((await put('text/html', Buffer.from('<script>alert(1)</script>'))).status, 415);
      for (const [type, data] of [['image/png', 'pas un png'], ['image/jpeg', 'GIF89a'], ['image/webp', 'RIFFxxxxPNG '], ['image/svg+xml', 'pas du svg']] as const) {
        const res = await put(type, Buffer.from(data));
        assert.ok(res.status >= 400 && res.status < 500, `${type} : ${res.status}`);
      }
      assert.equal((await put('image/png', Buffer.alloc(11 * 1024 * 1024, 1))).status, 413, '11 Mo : trop gros');
      // un SVG avec script est accepte mais servi sous une politique qui l'empeche de s'executer
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script><rect width="1" height="1"/></svg>';
      assert.equal((await put('image/svg+xml', Buffer.from(svg))).status, 200);
      const served = await new Promise<Record<string, string | string[] | undefined>>((resolveH, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/api/plan', headers: { Cookie: admin } }, (res) => (res.resume(), resolveH(res.headers)));
        req.on('error', reject);
        req.end();
      });
      assert.match(String(served['content-security-policy']), /sandbox/);
      assert.match(String(served['content-security-policy']), /default-src 'none'/);
      assert.equal(served['x-content-type-options'], 'nosniff');
      assert.ok(await alive());
    });
  });

  describe('protocole et deni de service', () => {
    const raw = (data: string | Buffer, waitMs = 600) =>
      new Promise<string>((resolveRaw) => {
        const socket = createConnection({ host: '127.0.0.1', port }, () => socket.write(data));
        let received = '';
        socket.on('data', (d) => (received += d.toString('latin1')));
        socket.on('error', () => resolveRaw(received));
        socket.on('close', () => resolveRaw(received));
        setTimeout(() => (socket.destroy(), resolveRaw(received)), waitMs);
      });

    it("requetes HTTP malformees : refusees ou ignorees, le serveur continue", async () => {
      const attacks = [
        'GARBAGE\r\n\r\n',
        'GET / HTTP/9.9\r\nHost: x\r\n\r\n',
        'GET /api/state HTTP/1.1\r\nHost: x\r\nContent-Length: -1\r\n\r\n',
        'POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nContent-Length: 50\r\n\r\n{"a":',
        'POST /api/login HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nContent-Length: 4\r\n\r\n0\r\n\r\n',
        'GET /' + 'a'.repeat(20_000) + ' HTTP/1.1\r\nHost: x\r\n\r\n',
        'GET / HTTP/1.1\r\nHost: x\r\n' + 'X-Pad: ' + 'b'.repeat(40_000) + '\r\n\r\n',
        'GET / HTTP/1.1\r\n' + 'H: v\r\n'.repeat(5000) + '\r\n',
        '\u0000\u0001\u0002\u0003\r\n\r\n',
        'GET /\r\n\r\n',
      ];
      for (const a of attacks) {
        await raw(a, 300);
        assert.ok(await alive(), `le serveur est tombe apres : ${a.slice(0, 50).replace(/\r\n/g, '|')}`);
      }
    });

    it("en-tetes et URL geants : 431 / 414 (limites de Node), jamais d'allocation sans fin", async () => {
      const big = await raw('GET / HTTP/1.1\r\nHost: x\r\nX-Pad: ' + 'b'.repeat(40_000) + '\r\n\r\n');
      assert.match(big, /^HTTP\/1\.1 431/);
      assert.ok(await alive());
    });

    it("corps declare enorme sur une route JSON : 413 sans lire des gigaoctets", async () => {
      const res = await http(port, 'POST', '/api/login', { body: JSON.stringify({ username: 'a', password: 'x'.repeat(100_000) }), headers: { 'Content-Type': 'application/json' } });
      assert.equal(res.status, 413);
      assert.ok(await alive());
    });

    it("connexions lentes (slowloris) : des centaines de requetes jamais terminees n'empechent pas de servir les autres", async () => {
      const sockets = Array.from({ length: 150 }, () => {
        const s = createConnection({ host: '127.0.0.1', port }, () => s.write('GET /api/state HTTP/1.1\r\nHost: x\r\nX-Lent: '));
        s.on('error', () => {});
        return s;
      });
      await wait(500);
      const t0 = Date.now();
      assert.equal((await http(port, 'GET', '/healthz')).status, 200);
      assert.ok(Date.now() - t0 < 3000, 'les requetes saines restent servies');
      for (const s of sockets) s.destroy();
      assert.ok(await alive());
    });

    it("rafale de connexions : 300 requetes simultanees sans erreur serveur ni plantage", async () => {
      const results = await Promise.all(Array.from({ length: 300 }, () => http(port, 'GET', '/healthz').then((r) => r.status, () => -1)));
      const bad = results.filter((s) => s !== 200);
      assert.ok(bad.length < 15, `${bad.length} echecs sur 300 : ${[...new Set(bad)].join(',')}`);
      assert.ok(await alive());
    });

    it("le serveur n'a jamais journalise d'erreur interne pendant toute l'attaque", async () => {
      assert.ok(await alive());
      assert.ok(!/ERREUR FATALE|TypeError|RangeError|Cannot read|is not a function|unhandled/i.test(output), output.slice(-800));
    });
  });
});
