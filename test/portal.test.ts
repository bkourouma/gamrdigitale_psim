import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { beginHistory } from '../server/history.ts';
import { preflight } from '../server/preflight.ts';
import type { PreflightInput } from '../server/preflight.ts';
import { SIGNATURE_HEADER, SITE_HEADER, TIME_HEADER, buildSiteSummary, createPortalSender, sign, signatureMatches, validatePortalUrl } from '../server/portal.ts';
import type { PortalStatus } from '../server/portal.ts';
import { seedDemo } from '../server/seed.ts';

const T0 = new Date(2026, 5, 15, 12, 0, 0).getTime(); // midi, heure locale : le « jour » ne bascule pas pendant le test
const HOUR = 3_600_000;
const KEY = 'k'.repeat(40);

function setup() {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  let clock = T0 - 30 * 24 * HOUR;
  const engine = createEngine(db, () => {}, () => clock, { silentTimeoutMs: 0 });
  beginHistory(db, clock, null, null);
  return { db, engine, goTo: (t: number) => void (clock = t) };
}

describe('resume du site pour le portail', () => {
  it('contient les equipements, la disponibilite par detecteur et par zone, et un point par jour', () => {
    const t = setup();
    t.goTo(T0 - 10 * HOUR);
    t.engine.handleDetectorMessage('D-01', { state: 'fault' });
    t.goTo(T0 - 9 * HOUR);
    t.engine.handleDetectorMessage('D-01', { state: 'normal' });
    const s = buildSiteSummary(t.db, { siteId: 'site-test', version: '1.2.3', startedAt: T0 - 1000, now: T0 });

    assert.equal(s.v, 1);
    assert.equal(s.siteId, 'site-test');
    assert.ok(s.devices.some((d) => d.id === 'D-01' && d.kind === 'detector' && d.monitored));
    assert.ok(s.devices.filter((d) => d.kind === 'camera').every((d) => !d.monitored), 'aucune sante inventee pour une camera');
    assert.ok(s.availability.byDevice.every((d) => s.devices.find((x) => x.id === d.deviceId)?.kind === 'detector'));

    const d1 = s.availability.byDevice.find((d) => d.deviceId === 'D-01')!;
    assert.equal(d1.downS, 3600);
    assert.equal(d1.outages, 1);
    assert.equal(d1.longestOutageS, 3600);
    assert.ok(d1.pct !== null && d1.pct < 100 && d1.pct > 99);

    const zone = s.availability.byZone.find((z) => z.zone === s.devices.find((d) => d.id === 'D-01')!.zone)!;
    assert.ok(zone.downS >= 3600, 'la panne se retrouve dans la zone');
    assert.equal(s.availability.overall.downS, s.availability.byZone.reduce((a, z) => a + z.downS, 0), 'parc = somme des zones');

    assert.equal(s.outages.length, 1);
    assert.equal(s.outages[0].deviceId, 'D-01');
    assert.equal(s.availability.daily.length, 35);
    assert.equal(s.availability.daily.at(-1)!.day, '2026-06-15');
    assert.equal(s.availability.daily.at(-1)!.downS, 3600, 'la panne tombe le jour courant');
    assert.equal(s.availability.daily.at(-2)!.downS, 0);
    const day = s.availability.daily.at(-1)!;
    const detectors = s.devices.filter((d) => d.monitored).length;
    assert.equal(day.upS + day.downS, detectors * 12 * 3600, 'de minuit a midi, chaque detecteur est observe : de quoi recalculer une moyenne exacte');
  });

  it('ne laisse sortir ni identifiants de camera, ni commentaires, ni noms d operateurs', () => {
    const t = setup();
    const camera = t.db.prepare("SELECT id FROM device WHERE kind = 'camera' LIMIT 1").get() as { id: string };
    t.db.prepare("INSERT INTO camera_source (device_id, kind, host, port, username, secret) VALUES (?, 'rtsp', '192.168.77.5', 554, 'cam-user', 'SECRET-CAMERA-XYZ')").run(camera.id);
    t.goTo(T0 - 5 * HOUR);
    t.engine.handleDetectorMessage('D-01', { state: 'alarm' });
    const incident = t.engine.getSnapshot().incidents.find((i) => i.detectorId === 'D-01')!;
    t.engine.acknowledge(incident.id, 'jean.dupont');
    t.engine.handleDetectorMessage('D-01', { state: 'normal' });
    t.engine.close(incident.id, 'marie.martin', 'false_alarm', 'COMMENTAIRE-INTERNE-ABC');

    const s = buildSiteSummary(t.db, { siteId: 'site-test', version: '1', startedAt: T0, now: T0 });
    const json = JSON.stringify(s);
    for (const secret of ['SECRET-CAMERA-XYZ', '192.168.77.5', 'cam-user', 'COMMENTAIRE-INTERNE-ABC', 'jean.dupont', 'marie.martin']) {
      assert.ok(!json.includes(secret), `« ${secret} » ne doit pas partir vers le portail`);
    }
    const sent = s.incidents.find((i) => i.id === incident.id)!;
    assert.equal(sent.status, 'closed');
    assert.equal(sent.qualification, 'false_alarm');
    assert.ok(sent.ackedAt !== null && sent.closedAt !== null);
  });

  it('un incident plus ancien que la fenetre n y figure pas, un incident encore ouvert y figure toujours', () => {
    const t = setup();
    t.goTo(T0 - 33 * 24 * HOUR);
    t.db.prepare("INSERT INTO incident (detector_id, severity, status, opened_at, closed_at, qualification) VALUES ('D-02', 'warning', 'closed', ?, ?, 'false_alarm')").run(T0 - 40 * 24 * HOUR, T0 - 40 * 24 * HOUR + 60_000);
    t.db.prepare("INSERT INTO incident (detector_id, severity, status, opened_at) VALUES ('D-03', 'critical', 'open', ?)").run(T0 - 50 * 24 * HOUR);
    const s = buildSiteSummary(t.db, { siteId: 'site-test', version: '1', startedAt: T0, now: T0 });
    assert.deepEqual(s.incidents.map((i) => i.deviceId), ['D-03']);
  });

  it('compte les notifications reussies et en echec, sans les tournees', () => {
    const t = setup();
    const insert = t.db.prepare("INSERT INTO notification_log (kind, channel, recipient, level, status, created_at) VALUES ('alarm', ?, 'x', 1, ?, ?)");
    insert.run('email', 'sent', T0 - HOUR);
    insert.run('email', 'sent', T0 - HOUR);
    insert.run('telegram', 'failed', T0 - HOUR);
    insert.run('round', 'sent', T0 - HOUR);
    const s = buildSiteSummary(t.db, { siteId: 'site-test', version: '1', startedAt: T0, now: T0 });
    assert.deepEqual(s.notifications, { sent: 2, failed: 1 });
  });
});

describe('signature des envois', () => {
  it('depend de la cle, du site, de l horodatage et du corps', () => {
    const base = sign(KEY, 'site-a', 1000, '{"a":1}');
    assert.equal(base, sign(KEY, 'site-a', 1000, '{"a":1}'));
    assert.notEqual(base, sign('autre'.repeat(8), 'site-a', 1000, '{"a":1}'));
    assert.notEqual(base, sign(KEY, 'site-b', 1000, '{"a":1}'));
    assert.notEqual(base, sign(KEY, 'site-a', 1001, '{"a":1}'));
    assert.notEqual(base, sign(KEY, 'site-a', 1000, '{"a":2}'));
  });

  it('la comparaison refuse une signature differente ou de longueur differente', () => {
    const good = sign(KEY, 'site-a', 1, 'x');
    assert.equal(signatureMatches(good, good), true);
    assert.equal(signatureMatches(good, `${good.slice(0, -1)}0`), good.endsWith('0'));
    assert.equal(signatureMatches(good, good.slice(1)), false);
    assert.equal(signatureMatches(good, ''), false);
  });
});

describe('adresse du portail', () => {
  it('exige https, sauf vers cette machine, et refuse les identifiants dans l adresse', () => {
    assert.equal(validatePortalUrl('https://suivi.exemple.com/api/ingest'), null);
    assert.equal(validatePortalUrl('http://127.0.0.1:4000/api/ingest'), null);
    assert.equal(validatePortalUrl('http://localhost:4000/x'), null);
    assert.match(validatePortalUrl('http://suivi.exemple.com/x') ?? '', /https/);
    assert.match(validatePortalUrl('https://user:pass@suivi.exemple.com/x') ?? '', /identifiants/);
    assert.match(validatePortalUrl('ftp://x') ?? '', /https/);
    assert.equal(validatePortalUrl('pas une adresse'), 'adresse invalide');
  });
});

describe('envoi vers le portail', () => {
  const summary = () => ({ v: 1, siteId: 'site-test' }) as unknown as ReturnType<typeof buildSiteSummary>;
  type Call = { url: string; headers: Record<string, string>; body: string };

  function sender(responses: (number | Error)[], extra: { siteId?: string; key?: string; url?: string } = {}) {
    const calls: Call[] = [];
    const changes: string[] = [];
    let clock = 5000;
    const next = [...responses];
    const s = createPortalSender({
      url: extra.url ?? 'https://suivi.exemple.com/api/ingest',
      siteId: extra.siteId ?? 'site-test',
      key: extra.key ?? KEY,
      everyMs: 60_000,
      build: summary,
      now: () => clock++,
      fetch: async (url, init) => {
        calls.push({ url, headers: init.headers, body: init.body });
        const r = next.shift() ?? 200;
        if (r instanceof Error) throw r;
        return { ok: r >= 200 && r < 300, status: r };
      },
      onChange: (state, st: PortalStatus) => changes.push(`${state}:${st.consecutiveFailures}`),
    });
    return { s, calls, changes };
  }

  it('envoie le corps signe, avec l identifiant du site et l horodatage signes', async () => {
    const { s, calls } = sender([200]);
    assert.equal(await s.push(), true);
    const [c] = calls;
    assert.equal(c.url, 'https://suivi.exemple.com/api/ingest');
    assert.equal(c.headers[SITE_HEADER], 'site-test');
    const ts = Number(c.headers[TIME_HEADER]);
    assert.equal(c.headers[SIGNATURE_HEADER], sign(KEY, 'site-test', ts, c.body), 'le portail peut refaire ce calcul avec sa copie de la cle');
    assert.ok(!Object.values(c.headers).some((v) => v.includes(KEY)) && !c.body.includes(KEY), 'la cle ne circule jamais');
    assert.equal(s.status().lastError, null);
    assert.equal(s.status().sent, 1);
  });

  it('compte les echecs, previent une fois a la premiere defaillance et une fois au retablissement', async () => {
    const { s, changes } = sender([200, 500, new Error('fetch failed'), 503, 200, 200]);
    await s.push();
    await s.push();
    assert.equal(s.status().consecutiveFailures, 1);
    await s.push();
    await s.push();
    assert.equal(s.status().consecutiveFailures, 3);
    assert.equal(s.status().lastError, 'HTTP 503');
    await s.push();
    assert.equal(s.status().consecutiveFailures, 0);
    await s.push();
    assert.deepEqual(changes, ['failing:1', 'recovered:0'], 'jamais a chaque tentative');
  });

  it('un refus 401 ou 403 dit de verifier la cle et l identifiant', async () => {
    const { s } = sender([403]);
    await s.push();
    assert.match(s.status().lastError ?? '', /cle ou identifiant du site/);
  });

  it('ne leve jamais d exception, meme si la construction du resume echoue', async () => {
    const s = createPortalSender({
      url: 'https://suivi.exemple.com/x',
      siteId: 'site-test',
      key: KEY,
      everyMs: 60_000,
      build: () => {
        throw new Error('base verrouillee');
      },
      fetch: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(await s.push(), false);
    assert.equal(s.status().lastError, 'base verrouillee');
  });

  it('un seul envoi a la fois', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const s = createPortalSender({
      url: 'https://suivi.exemple.com/x',
      siteId: 'site-test',
      key: KEY,
      everyMs: 60_000,
      build: summary,
      fetch: async () => {
        calls++;
        await gate;
        return { ok: true, status: 200 };
      },
    });
    const first = s.push();
    assert.equal(await s.push(), false, 'le second est ecarte pendant que le premier court');
    release();
    await first;
    assert.equal(calls, 1);
  });

  it('une configuration incomplete ou fragile n envoie rien', async () => {
    for (const bad of [{ key: 'courte' }, { siteId: 'Mauvais Site' }, { siteId: '' }, { url: '' }, { url: 'http://suivi.exemple.com/x' }]) {
      const { s, calls } = sender([200], bad);
      assert.equal(s.status().configured, false, JSON.stringify(bad));
      assert.equal(await s.push(), false);
      assert.equal(calls.length, 0);
    }
  });
});

describe('controle de configuration', () => {
  const GOOD: PreflightInput = {
    production: true, host: '127.0.0.1', mqttHost: '127.0.0.1', tlsEnabled: false, mqttTlsEnabled: false, trustProxy: false, cookieSecure: false,
    simEnabled: false, demoLogin: false, adminPassword: 'Un-vrai-mot-de-passe-1', operatorPassword: 'Un-autre-mot-de-passe-2', mqttPassword: 'Mot-de-passe-MQTT-3',
    notificationChannels: 2, escalationConfigured: true, detectorTimeoutS: 180, backupEveryH: 24, requireTotp: 'admin', heartbeatUrl: 'https://hc-ping.com/abc',
  };
  const errors = (c: PreflightInput) => preflight(c).filter((f) => f.level === 'error').map((f) => f.message).join(' | ');

  it('sans portail, rien a dire ; avec un portail complet et valide, non plus', () => {
    assert.equal(errors({ ...GOOD, portal: { url: '', siteId: '', key: '' } }), '');
    assert.equal(errors({ ...GOOD, portal: { url: 'https://suivi.exemple.com/api/ingest', siteId: 'entrepot-kaloum', key: KEY } }), '');
  });

  it('refuse en production une configuration qui n enverrait rien ou signerait mal', () => {
    assert.match(errors({ ...GOOD, portal: { url: 'https://suivi.exemple.com/x', siteId: '', key: '' } }), /incomplet/);
    assert.match(errors({ ...GOOD, portal: { url: 'http://suivi.exemple.com/x', siteId: 'entrepot-kaloum', key: KEY } }), /https/);
    assert.match(errors({ ...GOOD, portal: { url: 'https://suivi.exemple.com/x', siteId: 'Entrepôt', key: KEY } }), /PSIM_PORTAL_SITE_ID invalide/);
    assert.match(errors({ ...GOOD, portal: { url: 'https://suivi.exemple.com/x', siteId: 'entrepot-kaloum', key: 'courte' } }), /trop courte/);
  });
});
