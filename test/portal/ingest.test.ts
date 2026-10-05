import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { resetThrottles } from '../../portal/server/accounts.ts';
import { siteKey } from '../../portal/server/keys.ts';
import { createPortalSender, sign } from '../../server/portal.ts';
import type { SiteSummary } from '../../server/portal.ts';
import { HOUR, MASTER, NOW, addUser, get, login, makeSummary, post, provision, startPortal } from './helpers.ts';
import type { Portal } from './helpers.ts';

describe('cles des sites', () => {
  it('sont derivees : stables, propres a chaque site et a chaque version, assez longues', () => {
    const a = siteKey(MASTER, 'site-a', 1);
    assert.equal(a, siteKey(MASTER, 'site-a', 1));
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, siteKey(MASTER, 'site-b', 1));
    assert.notEqual(a, siteKey(MASTER, 'site-a', 2));
    assert.notEqual(a, siteKey(Buffer.alloc(32, 8), 'site-a', 1));
  });
});

describe('reception des resumes', () => {
  let portal: Portal;
  before(async () => {
    portal = await startPortal();
    provision(portal.db, 'Client A', 'site-a', 'Entrepôt A');
    provision(portal.db, 'Client B', 'site-b', 'Entrepôt B');
    provision(portal.db, 'Client A', 'site-off', 'Site coupé');
    portal.db.prepare("UPDATE site SET active = 0 WHERE id = 'site-off'").run();
  });
  after(() => portal.close());
  beforeEach(() => resetThrottles());

  const stored = () => (portal.db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n;
  const json = (s: SiteSummary) => JSON.stringify(s);

  it('de bout en bout : le VRAI emetteur du PSIM envoie, le portail enregistre et affiche le site', async () => {
    const summary = makeSummary('site-a', {
      mutate: (engine, goTo) => {
        goTo(NOW - 20 * HOUR);
        engine.handleDetectorMessage('D-01', { state: 'fault' });
        goTo(NOW - 18 * HOUR);
        engine.handleDetectorMessage('D-01', { state: 'normal' });
      },
    });
    const sender = createPortalSender({ url: `${portal.base}/api/ingest`, siteId: 'site-a', key: siteKey(MASTER, 'site-a', 1), everyMs: 60_000, build: () => summary, now: portal.now });
    assert.equal(await sender.push(), true, sender.status().lastError ?? '');
    assert.equal(sender.status().consecutiveFailures, 0);

    const row = portal.db.prepare('SELECT generated_at, received_at FROM snapshot WHERE site_id = ?').get('site-a') as { generated_at: number; received_at: number };
    assert.equal(row.generated_at, NOW);
    assert.equal(row.received_at, NOW);
    assert.ok((portal.db.prepare('SELECT COUNT(*) AS n FROM site_day WHERE site_id = ?').get('site-a') as { n: number }).n >= 30, 'un point par jour conserve');
    const outage = portal.db.prepare('SELECT device_id, duration_s, cause, to_ts FROM outage WHERE site_id = ?').get('site-a') as { device_id: string; duration_s: number; cause: string; to_ts: number | null };
    assert.equal(outage.device_id, 'D-01');
    assert.equal(outage.duration_s, 2 * 3600);
    assert.ok(outage.to_ts !== null, 'panne terminee');

    addUser(portal.db, { username: 'directeur-a', role: 'director', orgId: (portal.db.prepare("SELECT id FROM organization WHERE name = 'Client A'").get() as { id: number }).id });
    const cookie = await login(portal, 'directeur-a');
    const detail = await get(portal, '/api/sites/site-a?days=30', cookie);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.status.level, 'ok');
    assert.equal(detail.json.outages.length, 1);
    assert.ok(detail.json.availability.pct < 100 && detail.json.availability.pct > 99);
  });

  it('refuse une signature fausse, une cle d un autre site, un site inconnu ou desactive : tous avec le meme message', async () => {
    const body = json(makeSummary('site-a'));
    const wrongKey = await post(portal, { body, key: siteKey(MASTER, 'site-b', 1) });
    const forged = await post(portal, { body, key: 'x'.repeat(64) });
    const unknown = await post(portal, { body, siteId: 'site-inconnu', key: siteKey(MASTER, 'site-inconnu', 1) });
    const disabled = await post(portal, { body: json(makeSummary('site-off')), siteId: 'site-off', key: siteKey(MASTER, 'site-off', 1) });
    for (const r of [wrongKey, forged, unknown, disabled]) {
      assert.equal(r.status, 401);
      assert.deepEqual(r.json, { error: 'refuse' }, 'on ne revele pas quels sites existent');
    }
    assert.equal(stored(), 1, 'rien n a ete enregistre en plus du premier site');
  });

  it('refuse un corps modifie apres signature', async () => {
    const body = json(makeSummary('site-a'));
    const key = siteKey(MASTER, 'site-a', 1);
    const res = await fetch(`${portal.base}/api/ingest`, {
      method: 'POST',
      headers: { 'x-psim-site': 'site-a', 'x-psim-timestamp': String(NOW), 'x-psim-signature': sign(key, 'site-a', NOW, body) },
      body: body.replace('"site-a"', '"site-a" ').replace('9.9.9', '0.0.1'),
    });
    assert.equal(res.status, 401);
  });

  it('refuse un envoi rejoue : horodatage trop ancien ou trop dans le futur, avec une explication pour le site', async () => {
    const body = json(makeSummary('site-a'));
    for (const timestamp of [NOW - 11 * 60_000, NOW + 11 * 60_000]) {
      const r = await post(portal, { body, timestamp });
      assert.equal(r.status, 401);
      assert.match(String(r.json.error), /horloge/);
    }
    assert.equal((await post(portal, { body, timestamp: NOW - 9 * 60_000 })).status, 200, 'dans la tolerance');
  });

  it('refuse un resume qui parle d un autre site que celui qui signe', async () => {
    const r = await post(portal, { body: json(makeSummary('site-b')), siteId: 'site-a' });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /identifiant du site/);
  });

  it('refuse un resume date d un moment invraisemblable (il figerait l etat dans le futur)', async () => {
    const r = await post(portal, { body: json(makeSummary('site-a', { at: NOW + 3 * HOUR })) });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /horloge/);
  });

  it('refuse un contenu mal forme, sans rien enregistrer', async () => {
    const good = makeSummary('site-a');
    const cases: [string, (s: any) => void, RegExp][] = [
      ['version inconnue', (s) => (s.v = 2), /version/],
      ['etat inconnu', (s) => (s.devices[0].status = 'explose'), /device\.status/],
      ['texte avec caractere de controle', (s) => (s.devices[0].name = 'a\u0007b'), /caractere interdit/],
      ['nom enorme', (s) => (s.devices[0].name = 'x'.repeat(5000)), /device\.name/],
      ['pourcentage hors bornes', (s) => (s.availability.overall.pct = 140), /pct/],
      ['duree negative', (s) => (s.availability.overall.downS = -5), /downS/],
      ['jour mal forme', (s) => (s.availability.daily[0].day = "2026-01-01'; DROP TABLE site;--"), /day/],
      ['liste demesuree', (s) => (s.incidents = Array.from({ length: 2001 }, () => s.incidents[0] ?? {})), /incidents/],
      ['corps qui n est pas un objet', () => {}, /corps/],
    ];
    const before = stored();
    const snapshotBefore = portal.db.prepare('SELECT payload FROM snapshot WHERE site_id = ?').get('site-a');
    for (const [name, mutate, expected] of cases) {
      const copy = JSON.parse(json(good));
      mutate(copy);
      const r = await post(portal, { body: name === 'corps qui n est pas un objet' ? '[1,2,3]' : JSON.stringify(copy) });
      assert.equal(r.status, 400, name);
      assert.match(String(r.json.error), expected, name);
    }
    assert.equal(stored(), before);
    assert.deepEqual(portal.db.prepare('SELECT payload FROM snapshot WHERE site_id = ?').get('site-a'), snapshotBefore, 'l instantane precedent est intact');
    const garbage = await post(portal, { body: '{pas du json' });
    assert.equal(garbage.status, 400);
  });

  it('ne garde que les champs connus : un champ ajoute par l emetteur n est ni stocke ni renvoye', async () => {
    const s = JSON.parse(json(makeSummary('site-a'))) as any;
    s.devices[0].mot_de_passe = 'SECRET-EN-TROP';
    s.extra = { cle: 'SECRET-EN-TROP' };
    assert.equal((await post(portal, { body: JSON.stringify(s) })).status, 200);
    const payload = (portal.db.prepare('SELECT payload FROM snapshot WHERE site_id = ?').get('site-a') as { payload: string }).payload;
    assert.ok(!payload.includes('SECRET-EN-TROP'));
  });

  it('un instantane plus ancien que celui deja recu est ignore ; rejouer le meme est sans effet', async () => {
    const newer = makeSummary('site-a', { at: NOW });
    portal.setNow(NOW + 5 * 60_000);
    assert.equal((await post(portal, { body: json(makeSummary('site-a', { at: NOW + 5 * 60_000 })) })).json.result, 'stored');
    const older = await post(portal, { body: json(newer), timestamp: portal.now() });
    assert.equal(older.status, 200);
    assert.equal(older.json.result, 'older');
    const row = portal.db.prepare('SELECT generated_at FROM snapshot WHERE site_id = ?').get('site-a') as { generated_at: number };
    assert.equal(row.generated_at, NOW + 5 * 60_000, 'l etat n est pas revenu en arriere');
    const again = await post(portal, { body: json(makeSummary('site-a', { at: NOW + 5 * 60_000 })) });
    assert.equal(again.status, 200);
    assert.equal((portal.db.prepare('SELECT COUNT(*) AS n FROM outage WHERE site_id = ?').get('site-a') as { n: number }).n, 1, 'aucun doublon');
    portal.setNow(NOW);
  });

  it('une panne en cours se termine quand le site l envoie : la meme ligne est mise a jour', async () => {
    const ongoing = makeSummary('site-b', { mutate: (e, goTo) => (goTo(NOW - 3 * HOUR), e.handleDetectorMessage('D-02', { state: 'fault' })) });
    assert.equal((await post(portal, { body: json(ongoing), siteId: 'site-b', key: siteKey(MASTER, 'site-b', 1) })).status, 200);
    const open = portal.db.prepare('SELECT from_ts, to_ts, duration_s FROM outage WHERE site_id = ?').get('site-b') as { from_ts: number; to_ts: number | null; duration_s: number };
    assert.equal(open.to_ts, null);
    assert.equal(open.duration_s, 3 * 3600);

    portal.setNow(NOW + HOUR);
    const done = makeSummary('site-b', {
      at: NOW + HOUR,
      mutate: (e, goTo) => {
        goTo(NOW - 3 * HOUR);
        e.handleDetectorMessage('D-02', { state: 'fault' });
        goTo(NOW + 30 * 60_000);
        e.handleDetectorMessage('D-02', { state: 'normal' });
      },
    });
    assert.equal((await post(portal, { body: json(done), siteId: 'site-b', key: siteKey(MASTER, 'site-b', 1) })).status, 200);
    const rows = portal.db.prepare('SELECT from_ts, to_ts, duration_s FROM outage WHERE site_id = ?').all('site-b') as { from_ts: number; to_ts: number | null; duration_s: number }[];
    assert.equal(rows.length, 1, 'meme panne, pas une seconde');
    assert.equal(rows[0].to_ts, NOW + 30 * 60_000);
    assert.equal(rows[0].duration_s, 3.5 * 3600);
    portal.setNow(NOW);
  });

  it('limite les tentatives refusees depuis une meme adresse', async () => {
    const body = json(makeSummary('site-a'));
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await post(portal, { body, key: 'y'.repeat(64) })).status;
    assert.equal(last, 429);
    // Meme un envoi legitime est refuse pendant la pause : le blocage est par adresse, il se leve tout seul.
    assert.equal((await post(portal, { body })).status, 429);
    portal.setNow(NOW + 2 * 60_000);
    assert.equal((await post(portal, { body: json(makeSummary('site-a', { at: NOW + 2 * 60_000 })) })).status, 200, 'la pause est finie');
    portal.setNow(NOW);
  });

  it('refuse un corps de plus de 2 Mo', async () => {
    const res = await fetch(`${portal.base}/api/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(2.5 * 1024 * 1024) });
    assert.equal(res.status, 413);
  });
});
