/**
 * Regressions de la relecture de securite, contre le vrai serveur : un client non authentifie ou revoque ne doit jamais
 * pouvoir arreter le PSIM ni lui parler, le verrouillage de compte ne doit pas permettre de bloquer l'administrateur,
 * la 2FA ne se devine pas a la chaine, les requetes inter-sites sont refusees, les actions de securite sont notifiees.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { base32Decode, totp } from '../server/totp.ts';

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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(condition: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < timeoutMs) await wait(25);
}

interface Reply {
  status: number;
  body: any;
  cookie: string | null;
}

/** Client HTTP bas niveau : permet d'envoyer Host, Origin, Sec-Fetch-Site et X-Forwarded-For comme on veut. */
function http(port: number, method: string, path: string, opts: { body?: unknown; cookie?: string | null; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...(opts.cookie ? { Cookie: opts.cookie } : {}), ...opts.headers } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let body: any = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          const set = res.headers['set-cookie']?.[0];
          resolveReply({ status: res.statusCode ?? 0, body, cookie: set ? set.split(';')[0] : null });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startServer(extra: Record<string, string>): Promise<{ proc: ChildProcess; port: number; output: () => string }> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    PSIM_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'psim-sec-')), 'data'),
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
      if ((await http(port, 'GET', '/healthz')).status === 200) return { proc, port, output: () => output };
    } catch {
      // pas encore pret
    }
    await wait(250);
  }
  proc.kill();
  throw new Error(`serveur non demarre :\n${output}`);
}

describe('securite (processus reel)', { timeout: 180_000 }, () => {
  const hooks: { url: string; body: string }[] = [];
  let collector: ReturnType<typeof createHttpServer>;
  let srv: Awaited<ReturnType<typeof startServer>>;
  let admin = '';
  let operator = '';
  const xff = (ip: string) => ({ 'X-Forwarded-For': ip });
  const alive = async () => (await http(srv.port, 'GET', '/healthz')).status === 200 && srv.proc.exitCode === null;

  const login = (user: string, password: string, ip: string) => http(srv.port, 'POST', '/api/login', { body: { username: user, password }, headers: xff(ip) });
  const audit = async () => (await http(srv.port, 'GET', '/api/audit?limit=300', { cookie: admin })).body as { actor: string; action: string; details: string | null }[];

  before(async () => {
    collector = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => (hooks.push({ url: req.url ?? '', body }), res.writeHead(200).end('ok')));
    });
    await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
    const cport = (collector.address() as AddressInfo).port;
    // PSIM_TRUST_PROXY=1 : l'adresse vient de X-Forwarded-For, ce qui permet de simuler plusieurs machines.
    srv = await startServer({ PSIM_TRUST_PROXY: '1', PSIM_NOTIFY_WEBHOOK_L1: `http://127.0.0.1:${cport}/hook` });
    const a = await login('admin', ADMIN_PW, '10.0.0.1');
    assert.equal(a.status, 200, srv.output());
    admin = a.cookie!;
    const o = await login('operateur', OPERATOR_PW, '10.0.0.2');
    assert.equal(o.status, 200);
    operator = o.cookie!;
  });

  after(() => {
    srv?.proc.kill();
    collector?.close();
  });

  describe('un client ne peut pas arreter le PSIM', () => {
    it("WebSocket avec « Origin: null » ou une origine illisible : refusee, le PSIM continue", async () => {
      for (const origin of ['null', 'pas une url', 'http://']) {
        const code = await new Promise<number>((resolveCode) => {
          const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Cookie: admin, Origin: origin } });
          ws.on('unexpected-response', (_req, res) => resolveCode(res.statusCode ?? 0));
          ws.on('error', () => resolveCode(-1));
          ws.on('open', () => resolveCode(200));
        });
        assert.notEqual(code, 200, `origine « ${origin} » refusee`);
        assert.ok(await alive(), `le PSIM tourne encore apres « ${origin} »`);
      }
    });

    it("chemin d'upgrade invalide (« // ») : refuse, le PSIM continue", async () => {
      await new Promise<void>((done) => {
        const req = request({ host: '127.0.0.1', port: srv.port, path: '//', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', Cookie: admin } });
        req.on('upgrade', (_res, socket) => (socket.destroy(), done()));
        req.on('response', () => done());
        req.on('error', () => done());
        req.end();
      });
      await wait(200);
      assert.ok(await alive());
    });

    it("message WebSocket de plus de 1 Ko envoye par un OPERATEUR : sa connexion est coupee, le PSIM continue", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Cookie: operator } });
      await new Promise<void>((r, j) => (ws.on('open', () => r()), ws.on('error', j)));
      const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
      ws.send('x'.repeat(5000));
      await closed;
      assert.ok(await alive(), srv.output());
      assert.ok(!/ERREUR FATALE/.test(srv.output()));
    });

    it("trame invalide (octets aleatoires) envoyee sur la prise : le PSIM continue", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Cookie: operator } });
      await new Promise<void>((r, j) => (ws.on('open', () => r()), ws.on('error', j)));
      // acces a la prise brute : on ecrit une trame invalide (bits reserves, opcode inconnu)
      (ws as unknown as { _socket: { write(b: Uint8Array): void } })._socket.write(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
      await wait(300);
      ws.terminate();
      assert.ok(await alive());
    });
  });

  describe('verrouillage de compte', () => {
    it("cinq mauvais mots de passe venus d'AILLEURS ne bloquent pas l'administrateur depuis son adresse habituelle", async () => {
      for (let i = 1; i <= 5; i++) assert.equal((await login('admin', 'mauvais-mot-de-passe', `10.9.0.${i}`)).status, 401);
      const attacker = await login('admin', ADMIN_PW, '10.9.0.99');
      assert.equal(attacker.status, 429, "une adresse inconnue reste verrouillee, meme avec le bon mot de passe");
      const home = await login('admin', ADMIN_PW, '10.0.0.1');
      assert.equal(home.status, 200, "l'adresse deja connue du compte passe");
      const entries = await audit();
      assert.equal(entries.filter((e) => e.action === 'login_locked').length, 1, 'le verrouillage est journalise, une seule fois par minute');
      assert.match(entries.find((e) => e.action === 'login_locked')!.details ?? '', /compte admin/);
    });

    it("l'adresse seule est aussi limitee (cinq echecs par minute), et ne contourne rien en changeant de compte", async () => {
      for (let i = 0; i < 5; i++) await login(`inconnu${i}`, 'x', '10.8.0.1');
      assert.equal((await login('operateur', OPERATOR_PW, '10.8.0.1')).status, 429);
    });
  });

  describe('double authentification', () => {
    let secret: Buffer = Buffer.alloc(0);

    it("enroler sa 2FA est une action de securite : journalisee ET notifiee", async () => {
      const setup = await http(srv.port, 'POST', '/api/me/2fa/setup', { cookie: operator });
      assert.equal(setup.status, 200);
      secret = base32Decode(setup.body.secret);
      hooks.length = 0;
      const enabled = await http(srv.port, 'POST', '/api/me/2fa/enable', { cookie: operator, body: { code: totp(secret, Date.now()) } });
      assert.equal(enabled.status, 200);
      await until(() => hooks.some((h) => JSON.parse(h.body).event === 'security'));
      const alert = hooks.map((h) => JSON.parse(h.body)).find((p) => p.event === 'security');
      assert.ok(alert, "la notification de securite est partie");
      assert.match(alert.subject, /ACTION DE SECURITE.*double authentification ACTIVEE/);
      assert.match(alert.text, /par operateur/);
      assert.ok((await audit()).some((e) => e.action === 'totp_enabled' && e.actor === 'operateur'));
    });

    it("deviner le code a la chaine depuis des adresses differentes est stoppe PAR COMPTE (10 echecs / 10 min)", async () => {
      const wrongFrom = async (ip: string) => {
        const first = await login('operateur', OPERATOR_PW, ip);
        assert.equal(first.status, 200, 'le mot de passe correct donne un defi');
        assert.equal(first.body.twoFactor, true);
        return http(srv.port, 'POST', '/api/login/2fa', { body: { challenge: first.body.challenge, code: '000000' }, headers: xff(ip) });
      };
      for (let i = 1; i <= 10; i++) assert.equal((await wrongFrom(`10.7.0.${i}`)).status, 401, `essai ${i}`);
      const eleventh = await wrongFrom('10.7.0.200');
      assert.equal(eleventh.status, 429, 'onzieme echec, adresse encore jamais vue : bloque');
      assert.match(eleventh.body.error, /Trop de tentatives/);
      const entries = await audit();
      assert.ok(entries.filter((e) => e.action === 'login_2fa_failed' && e.actor === 'operateur').length >= 10, 'chaque echec 2FA est journalise');
      assert.ok(entries.some((e) => e.action === 'login_locked' && /acct2fa|operateur/.test(e.details ?? '')));
    });
  });

  describe('requetes inter-sites (CSRF)', () => {
    const backup = (headers: Record<string, string>) => http(srv.port, 'POST', '/api/system/backup', { cookie: admin, headers });

    it("refuse une requete sans corps venue d'une autre origine, ou annoncee « cross-site », ou d'une origine « null »", async () => {
      assert.equal((await backup({ Origin: 'http://evil.example' })).status, 403);
      assert.equal((await backup({ Origin: 'null' })).status, 403);
      assert.equal((await backup({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
      assert.equal((await backup({ 'Sec-Fetch-Site': 'same-site' })).status, 403, 'un site « frere » n est pas la meme origine');
      assert.equal((await http(srv.port, 'DELETE', '/api/users/operateur', { cookie: admin, headers: { Origin: 'http://127.0.0.1:1' } })).status, 403);
      assert.equal((await http(srv.port, 'GET', '/api/me', { cookie: admin })).body.username, 'admin', "rien n'a ete supprime");
    });

    it("accepte la meme origine, l'absence d'origine (scripts, outils) et « same-origin »", async () => {
      assert.equal((await backup({ Origin: `http://127.0.0.1:${srv.port}` })).status, 200);
      assert.equal((await backup({})).status, 200);
      assert.equal((await backup({ 'Sec-Fetch-Site': 'same-origin' })).status, 200);
    });

    it("l'entree des equipements n'est pas concernee (jeton, jamais un navigateur) ; la lecture non plus", async () => {
      assert.equal((await http(srv.port, 'GET', '/api/state', { cookie: admin, headers: { Origin: 'http://evil.example' } })).status, 200);
    });
  });

  describe('journal, en-tetes et visibilite', () => {
    it("les reponses d'API ne sont jamais mises en cache ; la politique de securite interdit <base> et les formulaires externes", async () => {
      const res = await new Promise<{ headers: Record<string, string | string[] | undefined> }>((resolveRes, reject) => {
        const r = request({ host: '127.0.0.1', port: srv.port, path: '/api/state', headers: { Cookie: admin } }, (x) => (x.resume(), resolveRes({ headers: x.headers })));
        r.on('error', reject);
        r.end();
      });
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.match(String(res.headers['content-security-policy']), /base-uri 'none'; form-action 'self'/);
    });

    it("un OPERATEUR ne lit pas les details de gestion (adresse d'une camera), l'administrateur si", async () => {
      const set = await http(srv.port, 'PUT', '/api/cameras/C-01/source', { cookie: admin, body: { kind: 'rtsp', host: '10.20.30.40', port: 554, rtspPath: '/flux', username: 'u', password: 'p' } });
      assert.equal(set.status, 200);
      const forAdmin = (await http(srv.port, 'GET', '/api/audit?limit=50', { cookie: admin })).body as { action: string; details: string | null }[];
      assert.match(forAdmin.find((e) => e.action === 'camera_source_updated')!.details ?? '', /10\.20\.30\.40/);
      const forOperator = await http(srv.port, 'GET', '/api/audit?limit=50', { cookie: operator });
      assert.equal(forOperator.status, 200);
      const entry = (forOperator.body as { action: string; details: string | null }[]).find((e) => e.action === 'camera_source_updated');
      assert.ok(entry, "l'operateur voit QU'une action a eu lieu");
      assert.equal(entry!.details, null);
      assert.ok(!JSON.stringify(forOperator.body).includes('10.20.30.40'));
      const state = await http(srv.port, 'GET', '/api/state', { cookie: operator });
      assert.ok(!JSON.stringify(state.body.audit).includes('10.20.30.40'), 'ni dans /api/state');
    });

    it("un mot de passe tape dans le champ identifiant n'est jamais inscrit au journal (seuls les comptes existants sont nommes)", async () => {
      const typed = 'Mon-MotDePasse-Perso-42';
      assert.equal((await login(typed, 'x', '10.5.0.1')).status, 401);
      assert.equal((await login('admin', 'mauvais', '10.0.0.1')).status, 401);
      const text = JSON.stringify((await http(srv.port, 'GET', '/api/audit?limit=300', { cookie: operator })).body).toLowerCase();
      assert.ok(!text.includes(typed.toLowerCase()), 'le texte saisi ne figure nulle part');
      const failed = (await audit()).filter((e) => e.action === 'login_failed');
      assert.ok(failed.some((e) => e.actor === '?'), 'inconnu : « ? »');
      assert.ok(failed.some((e) => e.actor === 'admin'), 'un compte existant reste nomme');
    });
  });

  describe('mots de passe', () => {
    it("refuse les mots de passe courants, repetes ou uniquement numeriques a la creation d'un compte", async () => {
      for (const password of ['passwordpassword', '123456789012', 'azertyazertyazerty', 'aaaaaaaaaaaa']) {
        const r = await http(srv.port, 'POST', '/api/users', { cookie: admin, body: { username: 'nouveau', role: 'operator', password } });
        assert.equal(r.status, 400, password);
      }
      const ok = await http(srv.port, 'POST', '/api/users', { cookie: admin, body: { username: 'nouveau', role: 'operator', password: 'Hippopotame-bleu-42-lune' } });
      assert.equal(ok.status, 201);
    });
  });

  describe('session revoquee : le temps reel se coupe', () => {
    it("desactiver un compte ferme sa WebSocket deja ouverte, qui ne recoit plus rien", async () => {
      const first = await login('nouveau', 'Hippopotame-bleu-42-lune', '10.6.0.1');
      assert.equal(first.status, 200);
      assert.equal(first.body.restricted, 'password', 'mot de passe temporaire : session restreinte');
      const changed = await http(srv.port, 'POST', '/api/me/password', { cookie: first.cookie, body: { current: 'Hippopotame-bleu-42-lune', next: 'Girafe-orange-77-soleil-X' } });
      assert.equal(changed.status, 200);
      const o = { cookie: changed.cookie ?? first.cookie };
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Cookie: o.cookie! } });
      const received: string[] = [];
      let closeCode = 0;
      ws.on('message', (m) => received.push(m.toString()));
      ws.on('close', (code) => (closeCode = code));
      await new Promise<void>((r, j) => (ws.on('open', () => r()), ws.on('error', j)));
      await until(() => received.length >= 1); // l'etat initial
      const disabled = await http(srv.port, 'PATCH', '/api/users/nouveau', { cookie: admin, body: { active: false } });
      assert.equal(disabled.status, 200);
      await until(() => closeCode !== 0);
      assert.equal(closeCode, 4401, 'fermee par le serveur : session terminee');
      const before = received.length;
      await http(srv.port, 'POST', '/api/system/backup', { cookie: admin });
      await wait(300);
      assert.equal(received.length, before, 'aucun evenement apres la revocation');
    });

    it("se deconnecter ferme aussi sa WebSocket, tout de suite", async () => {
      const o = await login('admin', ADMIN_PW, '10.0.0.1');
      assert.equal(o.status, 200);
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Cookie: o.cookie! } });
      let closeCode = 0;
      ws.on('close', (code) => (closeCode = code));
      await new Promise<void>((r, j) => (ws.on('open', () => r()), ws.on('error', j)));
      assert.equal((await http(srv.port, 'POST', '/api/logout', { cookie: o.cookie })).status, 200);
      await until(() => closeCode !== 0, 3000);
      assert.equal(closeCode, 4401);
    });
  });
});

describe('mode demonstration : comptes cliquables', { timeout: 120_000 }, () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  before(async () => {
    srv = await startServer({ PSIM_DEMO_LOGIN: '1' });
  });
  after(() => srv?.proc.kill());

  it("servis a la machine locale sous un nom local, jamais derriere un proxy ni sous un autre nom (DNS rebinding)", async () => {
    const ok = await http(srv.port, 'GET', '/api/demo-accounts');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.length, 2);
    assert.equal((await http(srv.port, 'GET', '/api/demo-accounts', { headers: { Host: 'evil.example' } })).status, 404, 'DNS rebinding');
    assert.equal((await http(srv.port, 'GET', '/api/demo-accounts', { headers: { Host: `evil.example:${srv.port}` } })).status, 404);
    assert.equal((await http(srv.port, 'GET', '/api/demo-accounts', { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 404, 'derriere un proxy : tout le monde arrive de 127.0.0.1');
    assert.equal((await http(srv.port, 'GET', '/api/demo-accounts', { headers: { Host: `localhost:${srv.port}` } })).status, 200);
  });
});
