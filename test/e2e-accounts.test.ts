/**
 * Parcours reels des comptes, contre le vrai serveur (processus separe) : double authentification obligatoire,
 * connexion en deux etapes, codes de secours, mot de passe a changer, desactivation, dernier administrateur,
 * destinataires de notification.
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

interface Reply {
  status: number;
  body: any;
  cookie: string | null;
}

describe('comptes et double authentification (processus reel)', { timeout: 120_000 }, () => {
  let server: ChildProcess;
  let base: string;
  let output = '';

  async function call(method: string, path: string, body?: unknown, cookie?: string | null): Promise<Reply> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const setCookie = res.headers.getSetCookie()[0];
    return { status: res.status, body: text ? JSON.parse(text) : null, cookie: setCookie ? setCookie.split(';')[0] : null };
  }

  const login = (username: string, password: string) => call('POST', '/api/login', { username, password });

  before(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const keep = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE'];
    const env: NodeJS.ProcessEnv = {};
    for (const k of keep) if (process.env[k]) env[k] = process.env[k];
    Object.assign(env, {
      PSIM_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'psim-acc-')), 'data'),
      PSIM_PORT: String(port),
      PSIM_MQTT_PORT: String(await freePort()),
      PSIM_ADMIN_PASSWORD: ADMIN_PW,
      PSIM_OPERATOR_PASSWORD: OPERATOR_PW,
      PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3',
      PSIM_DEMO_LOGIN: '0',
      PSIM_REQUIRE_2FA: 'admin',
      PSIM_SMTP_HOST: '127.0.0.1',
      PSIM_SMTP_FROM: 'psim@exemple.test',
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

  // Etat partage entre les etapes (le parcours est volontairement sequentiel).
  const state = { adminCookie: '', secret: Buffer.alloc(0) as Buffer, recovery: [] as string[] };

  it("la 2FA imposee aux administrateurs restreint la session tant qu'elle n'est pas activee", async () => {
    const r = await login('admin', ADMIN_PW);
    assert.equal(r.status, 200);
    assert.equal(r.body.restricted, '2fa');
    state.adminCookie = r.cookie!;
    const blocked = await call('GET', '/api/state', undefined, state.adminCookie);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.restricted, '2fa');
    assert.equal((await call('GET', '/api/users', undefined, state.adminCookie)).status, 403, 'meme les routes d\'administration');
    assert.equal((await call('GET', '/api/me', undefined, state.adminCookie)).status, 200, 'mais il peut voir son etat');
  });

  it("un mauvais code d'activation est refuse ; le bon active la 2FA et debloque la session", async () => {
    const setup = await call('POST', '/api/me/2fa/setup', undefined, state.adminCookie);
    assert.equal(setup.status, 200);
    assert.match(setup.body.qrSvg, /^<svg/);
    assert.match(setup.body.uri, /^otpauth:\/\/totp\//);
    state.secret = base32Decode(setup.body.secret);
    assert.equal((await call('POST', '/api/me/2fa/enable', { code: '000000' }, state.adminCookie)).status, 400);
    const enabled = await call('POST', '/api/me/2fa/enable', { code: totp(state.secret, Date.now()) }, state.adminCookie);
    assert.equal(enabled.status, 200);
    state.recovery = enabled.body.recoveryCodes;
    assert.equal(state.recovery.length, 8);
    assert.equal((await call('GET', '/api/state', undefined, state.adminCookie)).status, 200, 'plus de restriction');
    const me = (await call('GET', '/api/me', undefined, state.adminCookie)).body;
    assert.equal(me.totpEnabled, true);
    assert.equal(me.restricted, null);
    assert.equal(me.recoveryLeft, 8);
  });

  it("la connexion se fait en deux etapes : le mot de passe seul ne donne AUCUNE session", async () => {
    const first = await login('admin', ADMIN_PW);
    assert.equal(first.status, 200);
    assert.equal(first.body.twoFactor, true);
    assert.equal(first.cookie, null, 'pas de cookie de session apres le seul mot de passe');
    assert.equal((await call('GET', '/api/state')).status, 401);

    const wrong = await call('POST', '/api/login/2fa', { challenge: first.body.challenge, code: '000000' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.cookie, null);
    // L'activation a consomme la fenetre courante : le code de la fenetre suivante est valide (tolerance +-1) et jamais utilise.
    const ok = await call('POST', '/api/login/2fa', { challenge: first.body.challenge, code: totp(state.secret, Date.now() + 30_000) });
    assert.equal(ok.status, 200);
    assert.ok(ok.cookie);
    assert.equal((await call('GET', '/api/state', undefined, ok.cookie)).status, 200);
    state.adminCookie = ok.cookie!;
  });

  it("un code TOTP ne peut pas etre rejoue", async () => {
    const code = totp(state.secret, Date.now() + 30_000); // celui qui vient de servir
    const challenge = (await login('admin', ADMIN_PW)).body.challenge;
    assert.equal((await call('POST', '/api/login/2fa', { challenge, code })).status, 401);
  });

  it('un code de secours ouvre une session, une seule fois', async () => {
    const code = state.recovery[0];
    const first = await call('POST', '/api/login/2fa', { challenge: (await login('admin', ADMIN_PW)).body.challenge, code });
    assert.equal(first.status, 200);
    const again = await call('POST', '/api/login/2fa', { challenge: (await login('admin', ADMIN_PW)).body.challenge, code });
    assert.equal(again.status, 401);
    state.adminCookie = first.cookie!;
    assert.equal((await call('GET', '/api/me', undefined, state.adminCookie)).body.recoveryLeft, 7);
  });

  it("un defi est detruit apres 5 essais rates ; la limitation par adresse freine aussi les essais en rafale", async () => {
    const challenge = (await login('admin', ADMIN_PW)).body.challenge;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call('POST', '/api/login/2fa', { challenge, code: '111111' })).status);
    assert.ok(statuses.every((s) => s === 401 || s === 429), `jamais de 200 sur un mauvais code : ${statuses}`);
    assert.ok(statuses.includes(429), 'la limitation par adresse se declenche (5 echecs par minute)');
    const good = await call('POST', '/api/login/2fa', { challenge, code: totp(state.secret, Date.now() - 30_000) });
    assert.ok(good.status === 401 || good.status === 429, 'meme un code valide ne passe plus : defi detruit ou adresse limitee');
    assert.equal(good.cookie, null);
  });

  it("l'administrateur cree un compte : il doit changer son mot de passe avant tout usage", async () => {
    const created = await call('POST', '/api/users', { username: 'Camille', role: 'operator', password: 'Mot-de-passe-temporaire-8', displayName: 'Camille Martin' }, state.adminCookie);
    assert.equal(created.status, 201);
    assert.equal(created.body.username, 'camille');
    assert.equal(created.body.mustChangePassword, true);
    assert.ok(!JSON.stringify(created.body).includes('Mot-de-passe-temporaire-8'), 'jamais de mot de passe dans une reponse');

    const r = await login('camille', 'Mot-de-passe-temporaire-8');
    assert.equal(r.body.restricted, 'password');
    assert.equal((await call('GET', '/api/state', undefined, r.cookie)).status, 403);
    assert.equal((await call('POST', '/api/me/password', { current: 'faux', next: 'Nouveau-mot-de-passe-99' }, r.cookie)).status, 403);
    assert.equal((await call('POST', '/api/me/password', { current: 'Mot-de-passe-temporaire-8', next: 'court' }, r.cookie)).status, 400);
    const changed = await call('POST', '/api/me/password', { current: 'Mot-de-passe-temporaire-8', next: 'Nouveau-mot-de-passe-99' }, r.cookie);
    assert.equal(changed.status, 200);
    assert.equal(changed.body.restricted, null);
    assert.equal((await call('GET', '/api/state', undefined, changed.cookie)).status, 200, 'session renouvelee et libre');
    assert.equal((await call('GET', '/api/state', undefined, r.cookie)).status, 401, "l'ancienne session est fermee");
    assert.equal((await login('camille', 'Mot-de-passe-temporaire-8')).status, 401);
  });

  it("desactiver un compte ferme SA SESSION IMMEDIATEMENT, et il ne peut plus se connecter", async () => {
    const session = (await login('camille', 'Nouveau-mot-de-passe-99')).cookie!;
    assert.equal((await call('GET', '/api/state', undefined, session)).status, 200);
    assert.equal((await call('PATCH', '/api/users/camille', { active: false }, state.adminCookie)).status, 200);
    assert.equal((await call('GET', '/api/state', undefined, session)).status, 401, 'session coupee a la requete suivante');
    assert.equal((await login('camille', 'Nouveau-mot-de-passe-99')).status, 401);
    await call('PATCH', '/api/users/camille', { active: true }, state.adminCookie);
    assert.equal((await call('GET', '/api/state', undefined, session)).status, 401, "reactiver ne ressuscite pas l'ancienne session");
  });

  it("un operateur n'accede ni aux comptes ni aux destinataires", async () => {
    const op = (await login('operateur', OPERATOR_PW)).cookie!;
    for (const [m, p] of [['GET', '/api/users'], ['POST', '/api/users'], ['GET', '/api/notifications/recipients'], ['POST', '/api/notifications/recipients'], ['DELETE', '/api/users/camille']] as const) {
      assert.equal((await call(m, p, m === 'POST' ? {} : undefined, op)).status, 403, `${m} ${p}`);
    }
    assert.equal((await call('GET', '/api/users')).status, 401);
  });

  it("le dernier administrateur ne peut etre ni retrograde, ni desactive, ni supprime", async () => {
    assert.equal((await call('PATCH', '/api/users/admin', { role: 'operator' }, state.adminCookie)).status, 409);
    assert.equal((await call('PATCH', '/api/users/admin', { active: false }, state.adminCookie)).status, 409);
    assert.equal((await call('DELETE', '/api/users/admin', undefined, state.adminCookie)).status, 409);
    assert.equal((await call('GET', '/api/me', undefined, state.adminCookie)).body.role, 'admin');
  });

  it("reinitialiser un mot de passe force son changement et ferme les sessions du compte", async () => {
    const session = (await login('operateur', OPERATOR_PW)).cookie!;
    const reset = await call('POST', '/api/users/operateur/reset-password', { password: 'Mot-de-passe-reinitialise-4' }, state.adminCookie);
    assert.equal(reset.status, 200);
    assert.equal((await call('GET', '/api/state', undefined, session)).status, 401);
    assert.equal((await login('operateur', OPERATOR_PW)).status, 401);
    assert.equal((await login('operateur', 'Mot-de-passe-reinitialise-4')).body.restricted, 'password');
  });

  it("l'administrateur reinitialise la 2FA d'un compte (telephone perdu)", async () => {
    await call('POST', '/api/users', { username: 'paul', role: 'operator', password: 'Mot-de-passe-temporaire-8' }, state.adminCookie);
    const paul = (await login('paul', 'Mot-de-passe-temporaire-8')).cookie!;
    await call('POST', '/api/me/password', { current: 'Mot-de-passe-temporaire-8', next: 'Mot-de-passe-solide-12' }, paul);
    const session = (await login('paul', 'Mot-de-passe-solide-12')).cookie!;
    const setup = await call('POST', '/api/me/2fa/setup', undefined, session);
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    assert.equal((await call('POST', '/api/me/2fa/enable', { code: totp(base32Decode(setup.body.secret), Date.now()) }, session)).status, 200);
    assert.equal((await login('paul', 'Mot-de-passe-solide-12')).body.twoFactor, true);
    const reset = await call('POST', '/api/users/paul/reset-2fa', undefined, state.adminCookie);
    assert.equal(reset.body.totpEnabled, false);
    assert.equal((await call('GET', '/api/state', undefined, session)).status, 401, 'ses sessions sont fermees');
    assert.equal((await login('paul', 'Mot-de-passe-solide-12')).body.twoFactor, undefined, 'plus de seconde etape');
  });

  it("destinataires : ajout, desactivation, retrait, validation, et aucune adresse de webhook renvoyee", async () => {
    const add = (body: unknown) => call('POST', '/api/notifications/recipients', body, state.adminCookie);
    assert.equal((await add({ channel: 'email', address: 'pas-un-email', level: 1 })).status, 400);
    assert.equal((await add({ channel: 'telegram', address: '123456789', level: 1 })).status, 409, 'Telegram non configure sur ce serveur');
    const email = await add({ channel: 'email', address: 'astreinte@exemple.fr', level: 2, label: 'Astreinte' });
    assert.equal(email.status, 201);
    const hook = await add({ channel: 'webhook', address: 'https://hooks.exemple.fr/JETON-SECRET', level: 1 });
    assert.equal(hook.status, 201);
    const list = await call('GET', '/api/notifications/recipients', undefined, state.adminCookie);
    assert.ok(!JSON.stringify(list.body).includes('JETON-SECRET'));
    assert.equal(list.body.available.email, true);
    assert.equal(list.body.available.telegram, false);
    assert.equal((await add({ channel: 'email', address: 'astreinte@exemple.fr', level: 2 })).status, 409, 'doublon');
    assert.equal((await call('PATCH', `/api/notifications/recipients/${email.body.id}`, { active: false }, state.adminCookie)).body.active, false);
    assert.equal((await call('DELETE', `/api/notifications/recipients/${email.body.id}`, undefined, state.adminCookie)).status, 204);
    assert.equal((await call('DELETE', `/api/notifications/recipients/${email.body.id}`, undefined, state.adminCookie)).status, 404);
    const status = (await call('GET', '/api/notifications/status', undefined, state.adminCookie)).body;
    assert.equal(status.channels.find((c: { id: string }) => c.id === 'webhook').level1, 1, 'pris en compte tout de suite par le notificateur');
  });

  it('les connexions ratees sont journalisees, sans le mot de passe', async () => {
    await login('admin', 'mot-de-passe-tente-123');
    const audit = (await call('GET', '/api/audit?limit=60', undefined, state.adminCookie)).body as { actor: string; action: string; details: string | null }[];
    assert.ok(audit.some((a) => a.action === 'login_failed' && a.actor === 'admin'));
    assert.ok(!JSON.stringify(audit).includes('mot-de-passe-tente-123'));
    for (const action of ['totp_enabled', 'user_created', 'password_changed', 'password_reset', 'totp_reset', 'recipient_added']) {
      assert.ok(audit.some((a) => a.action === action) || (await call('GET', '/api/audit?limit=500', undefined, state.adminCookie)).body.some((a: { action: string }) => a.action === action), `journal : ${action}`);
    }
  });

  it("supprimer un compte supprime sa session", async () => {
    const session = (await login('paul', 'Mot-de-passe-solide-12')).cookie!;
    assert.equal((await call('GET', '/api/state', undefined, session)).status, 200);
    assert.equal((await call('DELETE', '/api/users/paul', undefined, state.adminCookie)).status, 204);
    assert.equal((await call('GET', '/api/state', undefined, session)).status, 401);
  });
});
