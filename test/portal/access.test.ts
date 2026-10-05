import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { resetThrottles, setActive, setPassword } from '../../portal/server/accounts.ts';
import { siteKey } from '../../portal/server/keys.ts';
import { HOUR, MASTER, NOW, PASSWORD, addUser, get, login, makeSummary, post, provision, startPortal } from './helpers.ts';
import type { Portal } from './helpers.ts';

/** Deux clients, trois sites : ce qu'un client voit ne doit jamais depasser son perimetre. */
describe('acces et perimetre', () => {
  let portal: Portal;
  let orgA = 0;
  let orgB = 0;
  const SITES = [
    ['Client A', 'a-nord', 'Entrepôt A Nord'],
    ['Client A', 'a-sud', 'Entrepôt A Sud'],
    ['Client B', 'b-port', 'Dépôt B Port'],
  ] as const;

  before(async () => {
    portal = await startPortal();
    for (const [org, id, name] of SITES) {
      const { orgId } = provision(portal.db, org, id, name);
      if (org === 'Client A') orgA = orgId;
      else orgB = orgId;
      await post(portal, { siteId: id, key: siteKey(MASTER, id, 1), body: JSON.stringify(makeSummary(id)) });
    }
    addUser(portal.db, { username: 'admin-prestataire', role: 'admin' });
    addUser(portal.db, { username: 'directeur-a', role: 'director', orgId: orgA });
    addUser(portal.db, { username: 'directeur-b', role: 'director', orgId: orgB });
    addUser(portal.db, { username: 'responsable-nord', role: 'site_manager', orgId: orgA, siteId: 'a-nord' });
  });
  after(() => portal.close());
  beforeEach(() => resetThrottles());

  const ids = (cards: { id: string }[]) => cards.map((c) => c.id).sort();

  describe('perimetre', () => {
    it('le prestataire voit tout, un directeur toute son organisation, un responsable son seul site', async () => {
      assert.deepEqual(ids((await get(portal, '/api/sites', await login(portal, 'admin-prestataire'))).json), ['a-nord', 'a-sud', 'b-port']);
      assert.deepEqual(ids((await get(portal, '/api/sites', await login(portal, 'directeur-a'))).json), ['a-nord', 'a-sud']);
      assert.deepEqual(ids((await get(portal, '/api/sites', await login(portal, 'directeur-b'))).json), ['b-port']);
      assert.deepEqual(ids((await get(portal, '/api/sites', await login(portal, 'responsable-nord'))).json), ['a-nord']);
    });

    it('un site hors perimetre est « introuvable », identique a un site qui n existe pas (rien ne revele qu il existe)', async () => {
      for (const who of ['directeur-b', 'responsable-nord']) {
        const cookie = await login(portal, who);
        const foreign = await get(portal, who === 'directeur-b' ? '/api/sites/a-nord' : '/api/sites/b-port', cookie);
        const absent = await get(portal, '/api/sites/n-existe-pas', cookie);
        assert.equal(foreign.status, 404, who);
        assert.deepEqual(foreign.json, absent.json, who);
      }
      assert.equal((await get(portal, '/api/sites/a-sud', await login(portal, 'responsable-nord'))).status, 404, 'meme organisation, autre site : refuse aussi');
    });

    it('aucune reponse d un client ne contient le nom, l identifiant ou les chiffres d un site hors perimetre', async () => {
      const cookie = await login(portal, 'directeur-b');
      const everything = JSON.stringify([(await get(portal, '/api/sites', cookie)).json, (await get(portal, '/api/overview', cookie)).json, (await get(portal, '/api/sites/b-port', cookie)).json]);
      for (const secret of ['a-nord', 'a-sud', 'Entrepôt A', 'Client A']) assert.ok(!everything.includes(secret), `« ${secret} » ne doit pas apparaitre chez le client B`);
    });

    it('la synthese ne compte que les sites visibles', async () => {
      assert.equal((await get(portal, '/api/overview', await login(portal, 'directeur-a'))).json.sites, 2);
      assert.equal((await get(portal, '/api/overview', await login(portal, 'responsable-nord'))).json.sites, 1);
      assert.equal((await get(portal, '/api/overview', await login(portal, 'admin-prestataire'))).json.sites, 3);
    });

    it('un site desactive disparait des ecrans de tous, y compris du prestataire', async () => {
      portal.db.prepare("UPDATE site SET active = 0 WHERE id = 'a-sud'").run();
      assert.deepEqual(ids((await get(portal, '/api/sites', await login(portal, 'admin-prestataire'))).json), ['a-nord', 'b-port']);
      assert.equal((await get(portal, '/api/sites/a-sud', await login(portal, 'directeur-a'))).status, 404);
      portal.db.prepare("UPDATE site SET active = 1 WHERE id = 'a-sud'").run();
    });

    it('un parametre trafique ne change pas le perimetre (rien ne vient du navigateur)', async () => {
      const cookie = await login(portal, 'directeur-b');
      const tricks = ['/api/sites?org=1', '/api/sites?siteId=a-nord', '/api/sites?role=admin', '/api/sites/b-port?days=1&site=a-nord'];
      for (const path of tricks) {
        const r = await get(portal, path, cookie);
        assert.ok(!JSON.stringify(r.json).includes('a-nord'), path);
      }
      const res = await fetch(`${portal.base}/api/sites`, { headers: { cookie, 'x-role': 'admin', 'x-org-id': String(orgA) } });
      assert.deepEqual(ids((await res.json()) as { id: string }[]), ['b-port']);
    });
  });

  describe('connexion', () => {
    const attempt = (username: string, password: string) =>
      fetch(`${portal.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });

    it('refuse sans rien reveler : meme reponse pour un compte inconnu, un mauvais mot de passe, un compte desactive', async () => {
      addUser(portal.db, { username: 'ancien-employe', role: 'director', orgId: orgA });
      setActive(portal.db, 'ancien-employe', false);
      const answers = [];
      for (const [u, p] of [['inconnu', PASSWORD], ['directeur-a', 'mauvais-mot-de-passe-1'], ['ancien-employe', PASSWORD]] as const) {
        const r = await attempt(u, p);
        assert.equal(r.status, 401);
        answers.push(await r.json());
      }
      assert.deepEqual(answers[0], answers[1]);
      assert.deepEqual(answers[1], answers[2]);
    });

    it('le cookie de session est inaccessible au JavaScript de la page et n est pas envoye par un autre site', async () => {
      const r = await attempt('directeur-a', PASSWORD);
      assert.equal(r.status, 200);
      const cookie = r.headers.get('set-cookie') ?? '';
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
      assert.match(cookie, /Max-Age=43200/);
    });

    it('ne stocke jamais le jeton de session : une copie de la base ne donne aucune session', async () => {
      const cookie = await login(portal, 'directeur-a');
      const token = cookie.split('=')[1];
      const rows = JSON.stringify(portal.db.prepare('SELECT * FROM session').all());
      assert.ok(!rows.includes(token));
    });

    it('bloque apres 5 echecs en une minute, pour la paire adresse + compte, puis se debloque', async () => {
      for (let i = 0; i < 5; i++) assert.equal((await attempt('directeur-b', 'faux-faux-faux-1')).status, 401);
      assert.equal((await attempt('directeur-b', PASSWORD)).status, 429, 'meme le bon mot de passe est refuse pendant la pause');
      portal.setNow(NOW + 61_000);
      assert.equal((await attempt('directeur-b', PASSWORD)).status, 200);
      portal.setNow(NOW);
    });

    it('les routes de donnees exigent une session', async () => {
      for (const path of ['/api/me', '/api/sites', '/api/overview', '/api/sites/a-nord']) assert.equal((await get(portal, path)).status, 401, path);
      assert.equal((await get(portal, '/api/sites', 'portal_session=' + 'a'.repeat(64))).status, 401);
      assert.equal((await get(portal, '/api/sites', 'portal_session=abc')).status, 401);
    });

    it('la deconnexion detruit la session cote serveur', async () => {
      const cookie = await login(portal, 'directeur-a');
      assert.equal((await get(portal, '/api/me', cookie)).status, 200);
      await fetch(`${portal.base}/api/logout`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
      assert.equal((await get(portal, '/api/me', cookie)).status, 401, 'le meme cookie rejoue ne marche plus');
    });

    it('une session expire apres 12 h', async () => {
      const cookie = await login(portal, 'directeur-a');
      portal.setNow(NOW + 12 * HOUR + 1000);
      assert.equal((await get(portal, '/api/me', cookie)).status, 401);
      portal.setNow(NOW);
    });
  });

  describe('comptes', () => {
    it('desactiver un compte coupe sa session immediatement', async () => {
      addUser(portal.db, { username: 'temporaire', role: 'site_manager', orgId: orgA, siteId: 'a-nord' });
      const cookie = await login(portal, 'temporaire');
      assert.equal((await get(portal, '/api/sites', cookie)).status, 200);
      setActive(portal.db, 'temporaire', false);
      assert.equal((await get(portal, '/api/sites', cookie)).status, 401);
    });

    it('reinitialiser un mot de passe coupe les sessions ouvertes', async () => {
      addUser(portal.db, { username: 'oublieux', role: 'director', orgId: orgB });
      const cookie = await login(portal, 'oublieux');
      setPassword(portal.db, 'oublieux', 'Nouveau-mot-de-passe-77', true);
      assert.equal((await get(portal, '/api/me', cookie)).status, 401);
    });

    it('un compte au mot de passe provisoire ne voit rien tant qu il ne l a pas change', async () => {
      addUser(portal.db, { username: 'nouveau', role: 'director', orgId: orgB }, 'Provisoire-abcdef-12', true);
      const cookie = await login(portal, 'nouveau', 'Provisoire-abcdef-12');
      assert.equal((await get(portal, '/api/me', cookie)).json.mustChangePassword, true);
      for (const path of ['/api/sites', '/api/overview', '/api/sites/b-port']) {
        const r = await get(portal, path, cookie);
        assert.equal(r.status, 403, path);
        assert.equal(r.json.error, 'password_change_required');
      }

      const change = (body: object) => fetch(`${portal.base}/api/password`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal((await change({ current: 'faux-faux-faux-1', next: 'Un-autre-mot-de-passe-5' })).status, 400, 'ancien mot de passe faux');
      assert.equal((await change({ current: 'Provisoire-abcdef-12', next: 'court' })).status, 400, 'nouveau trop court');
      assert.equal((await change({ current: 'Provisoire-abcdef-12', next: 'Provisoire-abcdef-12' })).status, 400, 'identique');
      assert.equal((await change({ current: 'Provisoire-abcdef-12', next: 'nouveau-nouveau-1' })).status, 400, 'contient le nom du compte');

      const ok = await change({ current: 'Provisoire-abcdef-12', next: 'Choisi-par-moi-2026' });
      assert.equal(ok.status, 200);
      const fresh = (ok.headers.get('set-cookie') ?? '').split(';')[0];
      assert.equal((await get(portal, '/api/sites', fresh)).status, 200, 'la session renouvelee voit ses donnees');
      assert.equal((await get(portal, '/api/sites', cookie)).status, 401, 'l ancienne session est coupee');
      await assert.rejects(login(portal, 'nouveau', 'Provisoire-abcdef-12'), /refusee/);
    });

    it('une base ne peut contenir un compte au perimetre incoherent', () => {
      assert.throws(() => portal.db.prepare("INSERT INTO portal_user (username, role, org_id, site_id, salt, hash, created_at) VALUES ('x', 'director', NULL, NULL, 's', 'h', 1)").run());
      assert.throws(() => portal.db.prepare("INSERT INTO portal_user (username, role, org_id, site_id, salt, hash, created_at) VALUES ('y', 'admin', 1, NULL, 's', 'h', 1)").run());
      assert.throws(() => portal.db.prepare("INSERT INTO portal_user (username, role, org_id, site_id, salt, hash, created_at) VALUES ('z', 'site_manager', NULL, NULL, 's', 'h', 1)").run());
    });
  });

  describe('protections du navigateur', () => {
    it('refuse une requete d ecriture venue d un autre site', async () => {
      const r = await fetch(`${portal.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://site-pirate.example' }, body: JSON.stringify({ username: 'directeur-a', password: PASSWORD }) });
      assert.equal(r.status, 403);
      const nul = await fetch(`${portal.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'null' }, body: '{}' });
      assert.equal(nul.status, 403);
    });

    it('envoie des en-tetes de securite et ne met pas les donnees en cache', async () => {
      const r = await fetch(`${portal.base}/api/sites`);
      assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/);
      assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('x-powered-by'), null);
    });

    it('une erreur ne montre jamais la trace interne', async () => {
      const r = await fetch(`${portal.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{pas du json' });
      assert.equal(r.status, 400);
      const text = await r.text();
      assert.ok(!/at .*\.ts|node_modules|Error:/.test(text), text);
    });

    it('/healthz repond sans session et ne dit rien du reste', async () => {
      const r = await get(portal, '/healthz');
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: true });
    });
  });
});
