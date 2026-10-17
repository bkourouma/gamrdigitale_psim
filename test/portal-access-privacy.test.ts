/**
 * Controle d'acces et portail : RIEN de nominatif ne part du site, ni n'est stocke ou montre par le portail (F28,
 * docs/CONTROLE-ACCES.md § 4 : « jamais du portail »).
 *
 * On construit un vrai PSIM (moteur et module d'acces reels, horloge injectee) avec un controleur dont l'identifiant, l'adresse et
 * les identifiants sont reconnaissables, des portes, et des passages portant un nom, un numero de badge et une reference de
 * titulaire, dont des refus repetes et une porte forcee (donc des incidents d'acces). On suit ensuite TOUT ce qui part vers le portail
 * (corps du resume, corps reellement envoye par l'emetteur) puis TOUT ce que le portail repond a un prestataire, un directeur, un
 * directeur limite a un groupe et un responsable de site, et ce qu'il garde dans sa base. Un marqueur trouve = test en echec.
 * Le portail n'a aucun export : il n'y a pas d'autre sortie a suivre.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createAccess } from '../server/access.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { beginHistory } from '../server/history.ts';
import { buildSiteSummary, createPortalSender, sign } from '../server/portal.ts';
import { createRiskService } from '../server/risk.ts';
import { seedDemo } from '../server/seed.ts';
import { addGroup, addOrganization, assignSite, groupIdsByCodes } from '../portal/server/admin.ts';
import { siteKey } from '../portal/server/keys.ts';
import { HOUR, MASTER, NOW, addUser, get, login, provision, startPortal } from './portal/helpers.ts';
import type { Portal } from './portal/helpers.ts';

const DAY = 24 * HOUR;
const SITE = 'site-acces';
const OTHER = 'autre-site';

/** Ce qui ne doit JAMAIS apparaitre. `9988` : un fragment du numero de badge, pour attraper aussi un badge masque ou tronque. */
const MARKERS = {
  controllerId: 'CTL-SECRET-7',
  controllerName: 'Controleur-Hall-ZETA',
  host: '10.99.88.77',
  holderName: 'ZORRO-NOM-TEST',
  badge: '99887766',
  holderRef: 'HREF-4242',
  controllerUser: 'utilisateur-ctl-ZZ',
  controllerPassword: 'Mdp-ctl-ZZ-9!x',
  badgeFragment: '9988',
};

/** Echoue si l'un des marqueurs figure dans `text` ; `where` dit d'ou vient le texte. */
function assertClean(where: string, text: string): void {
  for (const [name, marker] of Object.entries(MARKERS)) assert.ok(!text.includes(marker), `${name} (« ${marker} ») trouve dans : ${where}`);
}

/** Un vrai PSIM avec un controleur marque et des passages nominatifs. */
function psimWithSecrets() {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-privacy-')), join(import.meta.dirname, '..', 'seed'));
  let clock = NOW - 30 * DAY;
  let engine: ReturnType<typeof createEngine>;
  const access = createAccess({
    db,
    now: () => clock,
    key: randomBytes(32),
    audit: (actor, action, ref) => engine.audit(actor, action, ref),
    setDeviceState: (id, state, event) => engine.setStateBySupervisor(id, state, event),
  });
  engine = createEngine(db, () => {}, () => clock, { access, silentTimeoutMs: 0 });
  beginHistory(db, clock, null, null);
  const risk = createRiskService(db, engine, { now: () => clock });

  access.createController('admin', { id: MARKERS.controllerId, name: MARKERS.controllerName, brand: 'dahua', host: MARKERS.host, credentials: { username: MARKERS.controllerUser, password: MARKERS.controllerPassword } });
  for (const [id, name] of [['A-02', 'Porte du hall'], ['A-03', 'Portail livraison']]) engine.createDevice('admin', { id, kind: 'detector', name, zone: 'Entrepot', category: 'access' });
  ['A-01', 'A-02', 'A-03'].forEach((id, i) => access.declareDoor('admin', { detectorId: id, controllerId: MARKERS.controllerId, doorNo: i + 1 }));

  let n = 0;
  const passage = (door: string, result: 'granted' | 'denied', ts: number, reason: string | null = null) => {
    const eventId = String(++n);
    clock = ts;
    return engine.ingest(door, {
      event: result === 'granted' ? 'badge_granted' : 'badge_denied',
      ts,
      msgId: `acc:${MARKERS.controllerId}:${eventId}`,
      access: { v: 1, controllerId: MARKERS.controllerId, eventId, direction: 'in', credential: MARKERS.badge, holderName: MARKERS.holderName, holderRef: MARKERS.holderRef, method: 'badge', result, reason, deferred: false },
    });
  };
  // Des passages acceptes les jours precedents, puis trois refus et un refus « a repetition » (incident), puis une porte forcee.
  for (let d = 5; d >= 1; d--) assert.deepEqual(passage('A-01', 'granted', NOW - d * DAY), { ok: true });
  for (let k = 0; k < 3; k++) passage('A-02', 'denied', NOW - 3 * HOUR + k * 1000, 'unknown_credential');
  clock = NOW - 3 * HOUR + 4000;
  engine.ingest('A-02', { event: 'badge_denied_repeated' });
  clock = NOW - 2 * HOUR;
  engine.ingest('A-03', { event: 'door_forced' });
  clock = NOW;
  risk.recordHistory();
  return { db, engine, access, risk, summary: () => buildSiteSummary(db, { siteId: SITE, version: '9.9.9', startedAt: NOW - 1000, now: NOW, risk: () => risk.overview() }) };
}

describe('confidentialite du controle d acces vers le portail', () => {
  const psim = psimWithSecrets();
  let portal: Portal;
  let sentBody = '';
  let sentHeaders: Record<string, string> = {};
  let sentUrl = '';
  const cookies: Record<string, string> = {};
  /** Toutes les reponses du portail vues par le test, avec leur provenance. */
  const seen: { where: string; text: string }[] = [];

  async function fetchText(path: string, cookie?: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`${portal.base}${path}`, { headers: cookie ? { cookie } : {} });
    const text = await res.text();
    seen.push({ where: `GET ${path} (${cookie ? Object.entries(cookies).find(([, c]) => c === cookie)?.[0] : 'sans session'})`, text });
    return { status: res.status, text };
  }

  before(async () => {
    // Le fichier de depart contient bien les marqueurs, et ils sont bien dans le journal du PSIM (sinon le test ne prouverait rien).
    const row = psim.db.prepare('SELECT holder_name, credential, holder_ref FROM access_event LIMIT 1').get() as { holder_name: string; credential: string; holder_ref: string };
    assert.deepEqual({ ...row }, { holder_name: MARKERS.holderName, credential: MARKERS.badge, holder_ref: MARKERS.holderRef });
    assert.equal((psim.db.prepare('SELECT host FROM access_controller').get() as { host: string }).host, MARKERS.host);
    assert.equal((psim.db.prepare('SELECT COUNT(*) AS n FROM access_event').get() as { n: number }).n, 8, 'cinq passages acceptes et trois refus');
    assert.equal((psim.db.prepare("SELECT COUNT(*) AS n FROM incident WHERE detector_id IN ('A-02', 'A-03')").get() as { n: number }).n, 2, 'refus a repetition et porte forcee : deux incidents d acces');

    // Le vrai emetteur, avec un fetch factice qui capture exactement ce qui partirait sur le reseau.
    const key = siteKey(MASTER, SITE, 1);
    const sender = createPortalSender({
      url: 'http://127.0.0.1:9/api/ingest',
      siteId: SITE,
      key,
      everyMs: 60_000,
      build: psim.summary,
      now: () => NOW,
      fetch: async (url, init) => {
        sentUrl = url;
        sentBody = init.body;
        sentHeaders = init.headers;
        return { ok: true, status: 200 };
      },
    });
    assert.equal(await sender.push(), true);

    portal = await startPortal();
    // Une banque a deux regions (le site est dans la region A), un autre client, quatre comptes.
    addOrganization(portal.db, 'Banque', NOW);
    addGroup(portal.db, 'Banque', 'region-a', 'Région A', null, NOW);
    addGroup(portal.db, 'Banque', 'region-b', 'Région B', null, NOW);
    provision(portal.db, 'Banque', SITE, 'Agence acces');
    assignSite(portal.db, SITE, 'region-a', NOW);
    provision(portal.db, 'Banque', OTHER, 'Agence voisine');
    assignSite(portal.db, OTHER, 'region-b', NOW);
    const org = (portal.db.prepare("SELECT id FROM organization WHERE name = 'Banque'").get() as { id: number }).id;
    addUser(portal.db, { username: 'prestataire', role: 'admin' });
    addUser(portal.db, { username: 'dir-banque', role: 'director', orgId: org });
    addUser(portal.db, { username: 'dir-region-a', role: 'director', orgId: org, groupIds: groupIdsByCodes(portal.db, ['region-a']) });
    addUser(portal.db, { username: 'dir-region-b', role: 'director', orgId: org, groupIds: groupIdsByCodes(portal.db, ['region-b']) });
    addUser(portal.db, { username: 'resp-agence', role: 'site_manager', orgId: org, siteId: SITE });
    for (const u of ['prestataire', 'dir-banque', 'dir-region-a', 'dir-region-b', 'resp-agence']) cookies[u] = await login(portal, u);

    // Le corps capture est celui que le portail recoit, tel quel (en-tetes signes compris).
    const res = await fetch(`${portal.base}/api/ingest`, { method: 'POST', headers: sentHeaders, body: sentBody });
    assert.equal(res.status, 200, await res.text());
    // L'autre site envoie un resume sans porte (celui de la demo) : il ne doit rien recevoir de celui-ci.
    const plain = buildSiteSummary(openDemo(), { siteId: OTHER, version: '9.9.9', startedAt: NOW - 1000, now: NOW });
    const t = NOW;
    const body = JSON.stringify(plain);
    const r2 = await fetch(`${portal.base}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-psim-site': OTHER, 'x-psim-timestamp': String(t), 'x-psim-signature': sign(siteKey(MASTER, OTHER, 1), OTHER, t, body) },
      body,
    });
    assert.equal(r2.status, 200);
  });
  after(async () => {
    await portal?.close();
  });

  it('le detecteur de marqueurs fonctionne (sinon un test « vert » ne prouverait rien)', () => {
    for (const bad of Object.values(MARKERS)) assert.throws(() => assertClean('essai', `{"x":"avant ${bad} apres"}`), /trouve dans/, bad);
    assert.doesNotThrow(() => assertClean('essai', '{"x":"rien de special"}'));
  });

  it('le resume construit par le PSIM (buildSiteSummary) n en contient aucun, mais porte bien le bloc d acces', () => {
    const summary = psim.summary();
    assertClean('buildSiteSummary', JSON.stringify(summary));
    assert.equal(summary.access?.doors, 3);
    assert.equal(summary.access?.incidents.total, 2);
    assert.equal(summary.access?.incidents.repeatedDenials, 1);
    assert.equal(summary.access?.incidents.forced, 1);
    // Meme le bloc d acces n a que des comptes : aucun texte libre (hors jours au format AAAA-MM-JJ).
    const strings: string[] = [];
    const walk = (v: unknown, key = ''): void => {
      if (typeof v === 'string') strings.push(`${key}=${v}`);
      else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(summary.access);
    assert.ok(strings.every((s) => /^day=\d{4}-\d{2}-\d{2}$/.test(s)), `textes libres dans le bloc : ${strings.join(' | ')}`);
    assert.deepEqual(Object.keys(summary.access!).sort(), ['availability', 'doors', 'incidents', 'states']);
  });

  it('le corps REELLEMENT envoye par l emetteur (fetch factice) n en contient aucun, ni les en-tetes', () => {
    assert.ok(sentBody.length > 1000, 'un corps a ete capture');
    assert.equal(sentUrl, 'http://127.0.0.1:9/api/ingest');
    assertClean('corps envoye', sentBody);
    assertClean('en-tetes envoyes', JSON.stringify(sentHeaders));
    const parsed = JSON.parse(sentBody);
    assert.equal(parsed.access.doors, 3);
    // La signature porte sur ce corps (rien n est ajoute apres signature).
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(psim.summary())));
  });

  it('le portail a recu le bloc et le montre', async () => {
    const r = await fetchText(`/api/sites/${SITE}`, cookies['dir-banque']);
    const d = JSON.parse(r.text);
    assert.equal(d.access.doors, 3);
    assert.equal(d.access.incidents.total, 2);
    assert.equal(d.access.incidents.repeatedDenials, 1);
    assert.equal(d.access.incidents.forced, 1);
    assert.equal(d.access.states.forced, 1, 'la porte forcee');
  });

  it('TOUTES les reponses de l API, pour chaque role : prestataire, directeur, directeur limite, responsable de site', async () => {
    const groupIds = (portal.db.prepare('SELECT id FROM site_group ORDER BY id').all() as { id: number }[]).map((g) => g.id);
    for (const [user, cookie] of Object.entries(cookies)) {
      const paths = ['/api/me', '/api/overview', '/api/sites', '/api/groups', ...groupIds.map((g) => `/api/groups/${g}`)];
      for (const days of [7, 30, 90]) paths.push(`/api/sites/${SITE}?days=${days}`, `/api/sites/${OTHER}?days=${days}`);
      for (const p of paths) {
        const r = await fetchText(p, cookie);
        assert.ok(r.status === 200 || r.status === 404, `${user} ${p} : ${r.status}`);
        assertClean(`${user} ${p}`, r.text);
      }
    }
    // Sans session et routes inconnues : jamais de donnee.
    for (const p of ['/api/sites', `/api/sites/${SITE}`, '/api/groups', '/api/inconnue', `/api/access/${SITE}`, '/api/ingest']) assertClean(`anonyme ${p}`, (await fetchText(p)).text);
    // Les pages et scripts du portail ne portent aucune donnee de site.
    for (const p of ['/', '/app.js', '/groups.js', '/ui.js', '/portal.css']) assertClean(`statique ${p}`, (await fetchText(p)).text);
  });

  it('le directeur de la region B ne recoit aucune donnee du site de la region A (le bloc non plus)', async () => {
    const r = await fetchText(`/api/sites/${SITE}`, cookies['dir-region-b']);
    assert.equal(r.status, 404);
    assert.ok(!r.text.includes('access') && !r.text.includes('doors'));
    const groups = await fetchText('/api/groups', cookies['dir-region-b']);
    assert.deepEqual(JSON.parse(groups.text).total.access, { sites: 0, doors: 0, offline: 0, fault: 0, unverifiedDown: 0 });
    const list = JSON.parse((await fetchText('/api/sites', cookies['dir-region-b'])).text);
    assert.deepEqual(list.map((s: { id: string }) => s.id), [OTHER]);
  });

  it('la base du portail (toutes les tables, tous les champs) n en garde aucun', () => {
    const tables = (portal.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
    assert.ok(tables.includes('snapshot') && tables.includes('audit'));
    for (const table of tables) assertClean(`table ${table} du portail`, JSON.stringify(portal.db.prepare(`SELECT * FROM ${table}`).all()));
    const payload = (portal.db.prepare('SELECT payload FROM snapshot WHERE site_id = ?').get(SITE) as { payload: string }).payload;
    assert.equal(JSON.parse(payload).access.doors, 3, 'le bloc est bien stocke avec le resume');
  });

  it('le journal du PSIM, lui, garde bien les marqueurs (le test les cherche a bon escient)', () => {
    const all = JSON.stringify(psim.db.prepare('SELECT * FROM access_event').all()) + JSON.stringify(psim.db.prepare('SELECT * FROM access_controller').all());
    for (const m of [MARKERS.holderName, MARKERS.badge, MARKERS.holderRef, MARKERS.controllerId, MARKERS.host]) assert.ok(all.includes(m), m);
    assert.ok(seen.length > 30, `${seen.length} reponses du portail examinees`);
  });
});

/** Un PSIM de demonstration sans porte (second site). */
function openDemo() {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-privacy-other-')), join(import.meta.dirname, '..', 'seed'));
  beginHistory(db, NOW - 30 * DAY, null, null);
  return db;
}
