/**
 * Messages dates et rejouables (`ts`, `msgId`) et supervision de la liaison des passerelles : une passerelle sur 4G garde
 * ses alertes pendant une coupure puis les renvoie. L'alerte garde son heure reelle, un renvoi ne cree jamais deux fois le
 * meme incident, et une passerelle coupee ne fait pas declarer N capteurs muets.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, beforeEach, describe, it } from 'node:test';
import mqtt from 'mqtt';
import { siteStatus } from '../portal/server/views.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import type { Engine, EngineOptions } from '../server/engine.ts';
import { createGatewayLink } from '../server/gatewaylink.ts';
import type { GatewayLink } from '../server/gatewaylink.ts';
import { availabilityOf, loadIntervals } from '../server/history.ts';
import { capDedup, purgeDedup } from '../server/ingestmeta.ts';
import { buildSiteSummary } from '../server/portal.ts';
import { preflight } from '../server/preflight.ts';
import type { PreflightInput } from '../server/preflight.ts';
import { seedDemo } from '../server/seed.ts';
import { createSystemStatus } from '../server/system.ts';
import type { Incident } from '../server/types.ts';

const T = Date.UTC(2026, 9, 10, 8, 0, 0);
const S = 1000;
const MIN = 60 * S;
const SEED = join(import.meta.dirname, '..', 'seed');

let db: DatabaseSync;
let engine: Engine;
let clock: number;
let hooks: { id: number; kind: string }[];

function setup(options: EngineOptions = {}, file = ':memory:'): void {
  db = openDb(file);
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-replay-')), SEED);
  clock = T;
  hooks = [];
  engine = createEngine(db, () => {}, () => clock, { onIncidentEvent: (i, kind) => void hooks.push({ id: i.id, kind }), ...options });
}

const incidents = (id?: string): Incident[] => engine.getSnapshot().incidents.filter((i) => !id || i.detectorId === id);
const audits = (action: string) => engine.listAudit(500).filter((e) => e.action === action);
const row = (id: string) => db.prepare('SELECT * FROM device WHERE id = ?').get(id) as Record<string, unknown>;
const openState = (id: string) => (db.prepare('SELECT state, started_at FROM device_state_history WHERE device_id = ? AND ended_at IS NULL').get(id) as { state: string; started_at: number } | undefined);

describe('messages dates (ts)', () => {
  beforeEach(() => setup());

  it("sans ts ni msgId : comportement inchange (heure d'arrivee, rien de marque, rien de memorise)", () => {
    assert.deepEqual(engine.ingest('D-01', { state: 'alarm' }), { ok: true });
    const [incident] = incidents('D-01');
    assert.equal(incident.openedAt, T);
    assert.equal(incident.receivedLateMs, null);
    assert.equal(audits('alarm_late').length, 0);
    assert.equal(row('D-01').last_seen, T);
    // Sans msgId, un message identique est traite comme avant (ici : un second incident apres cloture).
    engine.ingest('D-01', { state: 'normal' });
    engine.close(incident.id, 'operateur', 'false_alarm', '');
    clock += MIN;
    engine.ingest('D-01', { state: 'alarm' });
    assert.equal(incidents('D-01').filter((i) => i.status !== 'closed').length, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ingest_dedup').get() as { n: number }).n, 0);
  });

  it("ts valide : l'incident, l'etat et l'historique gardent l'heure reelle ; une alarme de plus d'une minute est marquee recue en differe", () => {
    assert.deepEqual(engine.ingest('D-01', { state: 'alarm', ts: T - 10 * MIN }), { ok: true });
    const [incident] = incidents('D-01');
    assert.equal(incident.openedAt, T - 10 * MIN);
    assert.equal(incident.receivedLateMs, 10 * MIN);
    assert.equal(row('D-01').state_since, T - 10 * MIN);
    assert.equal(openState('D-01')?.started_at, T - 10 * MIN);
    const [late] = audits('alarm_late');
    assert.equal(late.incidentId, incident.id);
    assert.match(late.details ?? '', /recu avec 10 min de retard/);
    assert.deepEqual(hooks, [{ id: incident.id, kind: 'opened' }], 'notifiee comme toute ouverture');
  });

  it('ts a moins d une minute : heure reelle, mais pas marquee en differe', () => {
    engine.ingest('D-02', { state: 'prealarm', ts: T - 20 * S });
    const [incident] = incidents('D-02');
    assert.equal(incident.openedAt, T - 20 * S);
    assert.equal(incident.receivedLateMs, null);
    assert.equal(audits('alarm_late').length, 0);
  });

  it('ts ou msgId mal formes : refuses (400), sans aucun effet', () => {
    const bad: Record<string, unknown>[] = [
      { ts: String(T) }, { ts: T + 0.5 }, { ts: -1 }, { ts: 0 }, { ts: Number.NaN }, { ts: null }, { ts: 2 ** 60 },
      { msgId: '' }, { msgId: 'x'.repeat(65) }, { msgId: 'gw 1' }, { msgId: 42 }, { msgId: 'passerelle-é' }, { msgId: null },
    ];
    for (const extra of bad) {
      const r = engine.ingest('D-01', { state: 'alarm', ...extra });
      assert.equal(r.ok, false, JSON.stringify(extra));
      assert.equal(!r.ok && r.status, 400, JSON.stringify(extra));
    }
    assert.equal(incidents().length, 0);
    assert.equal(row('D-01').last_seen, null);
    assert.equal(row('D-01').status, 'normal');
  });

  it("ts dans le futur : ramene a l'heure de reception (jamais refuse), et ne bloque pas les messages suivants", () => {
    assert.deepEqual(engine.ingest('D-03', { state: 'alarm', ts: T + 3_600_000 }), { ok: true });
    const [incident] = incidents('D-03');
    assert.equal(incident.openedAt, T);
    assert.equal(incident.receivedLateMs, null);
    clock += S;
    engine.ingest('D-03', { state: 'normal', ts: clock });
    assert.equal(row('D-03').status, 'normal', "une date future n'a pas « verrouille » l'etat");
  });

  it('ts trop ancien : refuse ; un ts en secondes est refuse avec un message qui le dit ; age maximal reglable', () => {
    const old = engine.ingest('D-01', { state: 'alarm', ts: T - 8 * 24 * 3_600_000 });
    assert.equal(old.ok, false);
    assert.match(!old.ok ? old.error : '', /trop ancien/);
    const seconds = engine.ingest('D-01', { state: 'alarm', ts: Math.floor(T / 1000) });
    assert.equal(seconds.ok, false);
    assert.match(!seconds.ok ? seconds.error : '', /secondes/);
    assert.equal(incidents().length, 0);

    setup({ ingestMaxAgeMs: 3_600_000 });
    assert.equal(engine.ingest('D-01', { state: 'alarm', ts: T - 2 * 3_600_000 }).ok, false);
    assert.equal(engine.ingest('D-01', { state: 'alarm', ts: T - 30 * MIN }).ok, true);
  });
});

describe('rejeu (msgId) : jamais deux fois le meme incident', () => {
  beforeEach(() => setup());

  it("un message deja traite est un succes sans effet, meme apres la cloture de l'incident", () => {
    engine.ingest('D-01', { state: 'alarm', ts: T - 5 * MIN, msgId: 'gw1-0001' });
    engine.ingest('D-01', { state: 'normal', ts: T - 4 * MIN, msgId: 'gw1-0002' });
    const [incident] = incidents('D-01');
    engine.close(incident.id, 'operateur', 'false_alarm', '');
    const journal = engine.listAudit(500).length;
    const seen = row('D-01').last_seen;
    clock += MIN;
    // La passerelle, qui n'a pas recu l'accuse, renvoie toute sa file.
    assert.deepEqual(engine.ingest('D-01', { state: 'alarm', ts: T - 5 * MIN, msgId: 'gw1-0001' }), { ok: true, duplicate: true });
    assert.deepEqual(engine.ingest('D-01', { state: 'normal', ts: T - 4 * MIN, msgId: 'gw1-0002' }), { ok: true, duplicate: true });
    assert.equal(incidents('D-01').length, 1);
    assert.equal(engine.listAudit(500).length, journal, 'rien de journalise');
    assert.equal(row('D-01').last_seen, seen);
  });

  it("le meme msgId sur un autre equipement est un autre message ; un message refuse n'est pas memorise", () => {
    engine.ingest('D-01', { state: 'alarm', msgId: 'm-1' });
    assert.deepEqual(engine.ingest('D-02', { state: 'alarm', msgId: 'm-1' }), { ok: true });
    assert.equal(incidents('D-02').length, 1);
    assert.equal(engine.ingest('D-03', { state: 'explosion', msgId: 'm-2' }).ok, false);
    assert.deepEqual(engine.ingest('D-03', { state: 'alarm', msgId: 'm-2' }), { ok: true });
    assert.equal(incidents('D-03').length, 1);
  });

  it("un msgId deja traite reste un succes meme quand son ts est devenu trop ancien (deduplication avant le controle d'age)", () => {
    setup({ ingestMaxAgeMs: 3_600_000 });
    engine.ingest('D-01', { state: 'alarm', ts: T - 50 * MIN, msgId: 'vieux' });
    clock += 30 * MIN;
    assert.deepEqual(engine.ingest('D-01', { state: 'alarm', ts: T - 50 * MIN, msgId: 'vieux' }), { ok: true, duplicate: true });
  });

  it("sans msgId, une alarme datee deja couverte par un incident clos ne cree pas de doublon", () => {
    engine.ingest('D-01', { state: 'alarm', ts: T - 10 * MIN });
    engine.ingest('D-01', { state: 'normal', ts: T - 8 * MIN });
    engine.close(incidents('D-01')[0].id, 'operateur', 'fire', '');
    clock += MIN;
    engine.ingest('D-01', { state: 'alarm', ts: T - 10 * MIN });
    assert.equal(incidents('D-01').length, 1);
    assert.equal(row('D-01').status, 'normal');
  });
});

describe('ordre des messages', () => {
  beforeEach(() => setup({ hintMs: 5 * MIN }));

  it("un message plus ancien n'ecrase pas un etat plus recent", () => {
    engine.ingest('D-01', { state: 'alarm', ts: T - MIN });
    engine.ingest('D-01', { state: 'normal', ts: T - 2 * MIN });
    assert.equal(row('D-01').status, 'alarm');
    assert.equal(openState('D-01')?.state, 'alarm');
    assert.equal(audits('device_state').length, 1);
  });

  it("alarme rejouee alors que le detecteur est redevenu normal depuis : incident a sa date reelle, detecteur normal, cloturable aussitot", () => {
    engine.ingest('D-02', { state: 'normal', ts: T - MIN });
    engine.ingest('D-02', { state: 'alarm', ts: T - 10 * MIN });
    assert.equal(row('D-02').status, 'normal', "l'etat actuel n'est pas modifie");
    const [incident] = incidents('D-02');
    assert.equal(incident.openedAt, T - 10 * MIN);
    assert.equal(incident.status, 'open', "jamais clos tout seul : un operateur qualifie l'alarme");
    assert.equal(incident.receivedLateMs, 10 * MIN);
    assert.match(audits('alarm_late')[0].details ?? '', /anterieure a l'etat connu.*etat actuel \(normal\) inchange/);
    assert.deepEqual(hooks, [{ id: incident.id, kind: 'opened' }]);
    // Pas « en cours » a tort : le detecteur n'est pas en alarme, la cloture est acceptee.
    assert.equal(engine.close(incident.id, 'operateur', 'false_alarm', '').status, 'closed');
  });

  it('renvoi dans l ordre apres une coupure : alarme puis retour a la normale, a leurs heures reelles (indice compris)', () => {
    engine.ingest('D-03', { state: 'alarm', ts: T - 10 * MIN, msgId: 'a' });
    engine.ingest('D-03', { state: 'normal', ts: T - 7 * MIN, msgId: 'b' });
    const [incident] = incidents('D-03');
    assert.equal(incident.openedAt, T - 10 * MIN);
    assert.equal(row('D-03').status, 'normal');
    assert.equal(row('D-03').state_since, T - 7 * MIN);
    assert.equal(incident.hint, 'false_alarm_likely');
    assert.match(incident.hintDetails ?? '', /180 s/, "duree reelle de l'alarme, pas celle de la reception");
  });

  it("une alarme anterieure a un incident en cours y est rattachee (et l'aggrave), sans second incident", () => {
    engine.ingest('D-04', { state: 'prealarm', ts: T - 2 * MIN });
    engine.ingest('D-04', { state: 'normal', ts: T - MIN });
    engine.ingest('D-04', { state: 'alarm', ts: T - 5 * MIN });
    const list = incidents('D-04');
    assert.equal(list.length, 1);
    assert.equal(list[0].severity, 'critical');
    assert.equal(audits('alarm_late')[0].incidentId, list[0].id);
    assert.equal(row('D-04').status, 'normal');
  });

  it("un message sans ts est toujours applique, meme si l'horloge du PSIM recule", () => {
    engine.ingest('D-05', { state: 'alarm', ts: T });
    clock = T - 3_600_000;
    engine.ingest('D-05', { state: 'normal' });
    assert.equal(row('D-05').status, 'normal');
  });

  it('une mesure plus ancienne ne remplace pas la derniere mesure affichee', () => {
    engine.ingest('E-01', { value: 25, ts: T - MIN });
    engine.ingest('E-01', { value: 20, ts: T - 5 * MIN });
    assert.equal(row('E-01').last_value, 25);
    assert.equal(row('E-01').last_seen, T - MIN);
  });

  it("un detecteur declare muet n'est pas ramene en ligne par un signe de vie anterieur", () => {
    setup({ silentTimeoutMs: MIN });
    engine.ingest('D-06', { event: 'heartbeat' });
    clock += 2 * MIN;
    assert.ok(engine.checkSilentDetectors().includes('D-06'));
    engine.ingest('D-06', { event: 'heartbeat', ts: clock - 30 * S });
    assert.equal(row('D-06').status, 'offline');
    engine.ingest('D-06', { event: 'heartbeat', ts: clock });
    assert.equal(row('D-06').status, 'normal');
  });
});

describe('passerelle : sa coupure ne fait pas declarer ses capteurs muets un par un', () => {
  let link: GatewayLink;
  const gw = { user: 'gw1', detectors: ['D-01', 'D-02', 'D-03'] };
  const client = {};
  const makeLink = (timeoutMs = 2 * MIN) =>
    createGatewayLink({
      db,
      gateways: [gw],
      timeoutMs,
      graceMs: MIN,
      now: () => clock,
      audit: (action, ref) => engine.audit('systeme', action, ref),
      publishDevice: () => {},
    });

  beforeEach(() => {
    setup({ silentTimeoutMs: MIN, silenceReference: (id) => link?.silenceReference(id) ?? null });
    link = makeLink();
    link.connection('gw1', true, client);
    for (const id of ['D-01', 'D-02', 'D-03', 'D-04']) engine.ingest(id, { state: 'normal' });
    engine.ingest('D-03', { state: 'alarm' });
  });

  /** Coupe la passerelle a T + 10 s, puis avance jusqu'a sa declaration (delai de 2 min). */
  function cut(): void {
    clock = T + 10 * S;
    link.connection('gw1', false, client);
    clock = T + 90 * S;
    engine.checkSilentDetectors();
    link.tick();
    clock = T + 131 * S;
    engine.checkSilentDetectors();
    link.tick();
    link.tick();
  }

  it('coupee : UN avertissement, capteurs non surveilles (jamais « normal »), aucun detecteur muet ; un capteur en alarme garde son etat', () => {
    cut();
    const silent = audits('detector_silent').map((e) => e.deviceId);
    assert.ok(silent.includes('D-04'), 'un detecteur hors passerelle reste juge seul');
    assert.ok(!silent.includes('D-01') && !silent.includes('D-02'), 'aucun capteur de la passerelle declare muet');
    assert.equal(audits('gateway_offline').length, 1);
    assert.match(audits('gateway_offline')[0].details ?? '', /gw1 .*2 capteur\(s\) non surveille\(s\) : D-01, D-02 ; 1 en alarme/);
    assert.equal(row('D-01').status, 'offline');
    assert.equal(row('D-01').link_lost_status, 'normal');
    assert.equal(row('D-03').status, 'alarm');
    assert.equal(openState('D-01')?.state, 'unmonitored');
    assert.equal(openState('D-01')?.started_at, T + 10 * S, 'non surveille depuis la deconnexion');
    assert.deepEqual(link.status(), [{ user: 'gw1', connected: false, since: T + 10 * S, down: true, unmonitored: 2, detectors: ['D-01', 'D-02', 'D-03'], represents: ['D-01', 'D-02', 'D-03'], lastMessageAt: null }]);
  });

  it("ecran Systeme : un seul avertissement pour la passerelle, ses capteurs ne sont pas comptes « hors service » un par un", () => {
    cut();
    const status = createSystemStatus({
      db, dataDir: mkdtempSync(join(tmpdir(), 'psim-sys-')), version: 't', now: () => clock, startedAt: T, lastTickAt: () => clock,
      disk: () => ({ freeBytes: 100 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 }), brokerClients: () => 0, snapshotsBytes: () => 0,
      notificationChannels: () => ({ channels: 1, failedLast24h: 0, sentLast24h: 0 }),
      backup: { everyH: 24, dir: '/s', last: () => ({ at: clock, ok: true, name: 'x', bytes: 1, error: null }), count: () => 1 },
      gateways: () => link.status(),
    });
    const messages = status.detail().warnings.map((w) => w.message);
    assert.equal(messages.filter((m) => /Passerelle gw1 injoignable/.test(m)).length, 1);
    const alone = (db.prepare("SELECT COUNT(*) AS n FROM device WHERE kind = 'detector' AND status IN ('offline', 'fault') AND link_lost_at IS NULL").get() as { n: number }).n;
    assert.ok(messages.some((m) => m.startsWith(`${alone} detecteur(s) hors service`)), 'les capteurs de la passerelle ne sont pas recomptes un par un');
  });

  it("portail : les capteurs non surveilles ne sont jamais presentes « normaux », et leur coupure ne compte ni comme disponible ni comme panne", () => {
    engine.ingest('D-03', { state: 'normal' });
    engine.close(incidents('D-03')[0].id, 'operateur', 'false_alarm', '');
    cut();
    db.prepare("UPDATE device SET status = 'normal' WHERE link_lost_at IS NULL AND status = 'offline'").run(); // isole l'effet de la passerelle
    clock = T + 10 * MIN;
    const summary = buildSiteSummary(db, { siteId: 'site-test', version: 't', startedAt: T, now: clock });
    const d1 = summary.devices.find((d) => d.id === 'D-01')!;
    assert.notEqual(d1.status, 'normal');
    assert.equal(d1.monitored, true);
    assert.equal(siteStatus(summary, clock, clock, 3_600_000).level, 'degraded', 'jamais « tout fonctionne » quand on ne sait pas');
    const intervals = loadIntervals(db, T, clock, clock).get('D-01') ?? [];
    const a = availabilityOf(intervals, T, clock, clock);
    assert.equal(a.downS, 0, 'pas une panne du capteur');
    assert.ok(a.unmonitoredS >= 9 * 60, `non surveille : ${a.unmonitoredS} s`);
  });

  it("au retour : etat d'avant la coupure, alerte gardee appliquee a son heure, silence juge apres le delai de grace", () => {
    cut();
    clock = T + 300 * S;
    link.connection('gw1', true, client);
    assert.equal(row('D-01').status, 'normal');
    assert.equal(row('D-01').link_lost_at, null);
    assert.equal(openState('D-01')?.state, 'normal');
    assert.equal(audits('gateway_online').length, 1);
    // La passerelle vide sa file : alarme de D-02 pendant la coupure.
    engine.ingest('D-02', { state: 'alarm', ts: T + 200 * S, msgId: 'gw1-42' });
    assert.equal(incidents('D-02')[0].openedAt, T + 200 * S);
    assert.equal(incidents('D-02')[0].receivedLateMs, 100 * S);
    // Retour a T+300 s, grace 60 s, delai 60 s : rien avant T+420 s.
    clock = T + 419 * S;
    assert.deepEqual(engine.checkSilentDetectors().filter((id) => id !== 'D-04'), []);
    engine.ingest('D-02', { state: 'normal' });
    clock = T + 421 * S;
    assert.deepEqual(engine.checkSilentDetectors(), ['D-01'], "D-01 ne s'est pas manifeste depuis le retour : muet");
  });

  it("un message du capteur (autre canal) pendant la coupure le remet aussitot sous surveillance", () => {
    cut();
    engine.ingest('D-01', { event: 'heartbeat' });
    assert.equal(row('D-01').status, 'normal');
    assert.equal(row('D-01').link_lost_at, null);
  });

  it("redemarrage du PSIM pendant la coupure : la coupure est reprise, puis levee au retour de la passerelle", () => {
    cut();
    link = makeLink();
    assert.equal(link.status()[0].down, true);
    assert.equal(openState('D-01')?.state, 'unmonitored');
    link.connection('gw1', true, client);
    assert.equal(row('D-01').status, 'normal');
    assert.equal(audits('gateway_online').length, 1);
  });

  it('supervision desactivee (0) ou passerelle retiree : capteurs juges un par un, comme avant', () => {
    cut();
    link = makeLink(0); // redemarrage sans la supervision : les capteurs marques sont rendus
    assert.equal(row('D-01').status, 'normal');
    assert.match(audits('gateway_online')[0].details ?? '', /retiree de la configuration : 2 capteur/);
    link.connection('gw1', false, client);
    clock += 2 * MIN;
    assert.ok(engine.checkSilentDetectors().includes('D-01'));
  });
});

describe('memoire des msgId : bornee et purgee', () => {
  beforeEach(() => setup());
  const count = () => (db.prepare('SELECT COUNT(*) AS n FROM ingest_dedup').get() as { n: number }).n;

  it("purge par anciennete : passe la fenetre, un msgId est oublie (la purge tourne toute seule environ une fois par minute)", () => {
    engine.ingest('D-01', { event: 'heartbeat', msgId: 'h-1' });
    assert.equal(count(), 1);
    clock += 8 * 24 * 3_600_000;
    for (let i = 0; i < 59; i++) engine.tick();
    assert.equal(count(), 1);
    engine.tick();
    assert.equal(count(), 0);
    assert.deepEqual(engine.ingest('D-01', { event: 'heartbeat', msgId: 'h-1' }), { ok: true });
  });

  it('plafonds : par equipement puis au total, les plus anciens sont oublies en premier', () => {
    const insert = db.prepare('INSERT INTO ingest_dedup (device_id, msg_id, received_at) VALUES (?, ?, ?)');
    for (let i = 1; i <= 5; i++) insert.run('D-01', `a${i}`, i * 10);
    for (let i = 1; i <= 4; i++) insert.run('D-02', `b${i}`, i * 10 + 5);
    capDedup(db, 3, 5);
    const left = (db.prepare('SELECT msg_id FROM ingest_dedup ORDER BY received_at').all() as { msg_id: string }[]).map((r) => r.msg_id);
    assert.deepEqual(left, ['a3', 'b3', 'a4', 'b4', 'a5']);
    assert.equal(purgeDedup(db, 0), 0);
  });
});

describe('base existante : migration sans perte', () => {
  it("une base d'avant (sans les colonnes ni la table) est completee a l'ouverture, ses donnees intactes, et la migration est rejouable", () => {
    const file = join(mkdtempSync(join(tmpdir(), 'psim-mig-')), 'psim.db');
    setup({}, file);
    engine.ingest('D-01', { state: 'alarm' });
    const id = incidents('D-01')[0].id;
    db.close();
    // Retour a l'etat d'une base anterieure a cette version.
    const old = new DatabaseSync(file);
    old.exec('DROP TABLE ingest_dedup; ALTER TABLE device DROP COLUMN state_ts; ALTER TABLE device DROP COLUMN link_lost_at; ALTER TABLE device DROP COLUMN link_lost_status; ALTER TABLE incident DROP COLUMN received_at;');
    old.close();
    for (let i = 0; i < 2; i++) {
      db = openDb(file);
      engine = createEngine(db, () => {}, () => clock);
      const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      assert.ok(['state_ts', 'link_lost_at', 'link_lost_status'].every((c) => cols('device').includes(c)));
      assert.ok(cols('incident').includes('received_at'));
      const incident = engine.incidentView(id);
      assert.equal(incident.status, 'open');
      assert.equal(incident.receivedLateMs, null);
      assert.equal(row('D-01').status, 'alarm');
      db.close();
    }
    db = openDb(file);
    engine = createEngine(db, () => {}, () => clock);
    engine.ingest('D-01', { state: 'normal', ts: clock, msgId: 'apres-migration' });
    assert.deepEqual(engine.ingest('D-01', { state: 'normal', ts: clock, msgId: 'apres-migration' }), { ok: true, duplicate: true });
    db.close();
  });
});

describe('controle de demarrage : reglages des passerelles et des messages dates', () => {
  const GOOD: PreflightInput = {
    production: true, host: '127.0.0.1', mqttHost: '127.0.0.1', tlsEnabled: false, mqttTlsEnabled: false, trustProxy: false, cookieSecure: false,
    simEnabled: false, demoLogin: false, adminPassword: 'Un-vrai-mot-de-passe-1', operatorPassword: 'Un-autre-mot-de-passe-2', mqttPassword: 'Mot-de-passe-MQTT-3',
    notificationChannels: 2, escalationConfigured: true, detectorTimeoutS: 180, backupEveryH: 24, requireTotp: 'admin', heartbeatUrl: 'https://hc.exemple.test/ping/jeton',
    gateways: 2, gatewayTimeoutS: 120, ingestMaxAgeS: 7 * 86_400,
  };
  const warnings = (c: PreflightInput) => preflight(c).map((f) => `${f.level} ${f.message}`).join('\n');

  it('valeurs par defaut : rien a signaler', () => assert.deepEqual(preflight(GOOD), []));
  it('supervision des passerelles coupee, delai plus long que celui des detecteurs muets, age maximal trop court : avertis', () => {
    assert.match(warnings({ ...GOOD, gatewayTimeoutS: 0 }), /^warn Supervision des passerelles desactivee/m);
    assert.match(warnings({ ...GOOD, gatewayTimeoutS: 600 }), /^warn PSIM_GATEWAY_TIMEOUT_S \(600 s\) depasse/m);
    assert.match(warnings({ ...GOOD, ingestMaxAgeS: 3600 }), /^warn PSIM_INGEST_MAX_AGE_S \(3600 s\)/m);
    assert.deepEqual(preflight({ ...GOOD, gateways: 0, gatewayTimeoutS: 0 }), [], 'sans passerelle, rien a dire');
  });
});

// ---------------------------------------------------------------- processus reel : HTTP et broker MQTT

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const TOKEN = 'jeton-equipements-0123456789abcdef';
const GW_PW = 'Mot-de-passe-passerelle-1';
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('processus reel : HTTP, broker MQTT et passerelle coupee', { timeout: 120_000 }, () => {
  let proc: ChildProcess;
  let base = '';
  let mqttPort = 0;
  let cookie = '';
  let output = '';

  before(async () => {
    const port = await freePort();
    mqttPort = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
    Object.assign(env, {
      PSIM_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'psim-replay-e2e-')), 'data'),
      PSIM_PORT: String(port),
      PSIM_MQTT_PORT: String(mqttPort),
      PSIM_ADMIN_PASSWORD: ADMIN_PW,
      PSIM_OPERATOR_PASSWORD: 'Mot-de-passe-operateur-2',
      PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3',
      PSIM_DEMO_LOGIN: '0',
      PSIM_REQUIRE_2FA: 'none',
      PSIM_INGEST_TOKEN: TOKEN,
      PSIM_MQTT_GATEWAYS: JSON.stringify([{ user: 'gw1', password: GW_PW, detectors: ['D-01', 'D-02'] }]),
      PSIM_GATEWAY_TIMEOUT_S: '1',
      PSIM_GATEWAY_GRACE_S: '5',
    });
    proc = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout!.on('data', (d) => (output += d));
    proc.stderr!.on('data', (d) => (output += d));
    for (let i = 0; i < 80 && !cookie; i++) {
      try {
        const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PW }) });
        if (res.status === 200) cookie = res.headers.getSetCookie()[0].split(';')[0];
      } catch {
        // pas encore pret
      }
      if (!cookie) await wait(250);
    }
    assert.ok(cookie, `serveur non demarre :\n${output}`);
  });
  after(() => proc?.kill());

  const ingest = (id: string, body: unknown) =>
    fetch(`${base}/api/ingest/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
  const state = async () => (await (await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).json()) as { devices: { id: string; status: string }[]; incidents: Incident[] };
  const auditOf = async (action: string) => ((await (await fetch(`${base}/api/audit?limit=500`, { headers: { Cookie: cookie } })).json()) as { action: string; details: string }[]).filter((e) => e.action === action);

  it('HTTP : premier envoi 204, renvoi du meme msgId 200 « duplicate », ts en secondes 400', async () => {
    const msg = { event: 'door_forced', ts: Date.now() - 5 * MIN, msgId: 'ctrl-acces-0001' };
    assert.equal((await ingest('A-01', msg)).status, 204);
    const again = await ingest('A-01', msg);
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { ok: true, duplicate: true });
    const list = (await state()).incidents.filter((i) => i.detectorId === 'A-01');
    assert.equal(list.length, 1);
    assert.ok(Math.abs(list[0].openedAt - msg.ts) < 1000);
    assert.ok((list[0].receivedLateMs ?? 0) >= 5 * MIN - 1000);
    const bad = await ingest('A-01', { event: 'door_forced', ts: Math.floor(Date.now() / 1000) });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /secondes/);
  });

  it("MQTT : la passerelle publie deux fois la meme alerte (un incident) ; coupee, ses capteurs passent hors ligne avec UN avertissement ; revenue, ils sont rendus", async () => {
    // Jamais connectee depuis le demarrage (delai 1 s) : deja declaree injoignable ; sa connexion la retablit.
    const gw = await mqtt.connectAsync(`mqtt://127.0.0.1:${mqttPort}`, { username: 'gw1', password: GW_PW, connectTimeout: 4000, reconnectPeriod: 0 });
    await wait(200);
    assert.equal((await state()).devices.find((d) => d.id === 'D-01')!.status, 'normal');
    const msg = JSON.stringify({ state: 'prealarm', ts: Date.now() - 2 * MIN, msgId: 'gw1-0001' });
    await gw.publishAsync('psim/detectors/D-02/state', msg, { qos: 1 });
    await gw.publishAsync('psim/detectors/D-02/state', msg, { qos: 1 });
    await gw.publishAsync('psim/detectors/D-02/state', JSON.stringify({ state: 'normal', msgId: 'gw1-0002' }), { qos: 1 });
    await wait(300);
    assert.equal((await state()).incidents.filter((i) => i.detectorId === 'D-02').length, 1);
    const offBefore = (await auditOf('gateway_offline')).length;
    await gw.endAsync();
    let d1 = '';
    for (let i = 0; i < 40 && d1 !== 'offline'; i++) {
      await wait(250);
      d1 = (await state()).devices.find((d) => d.id === 'D-01')!.status;
    }
    assert.equal(d1, 'offline');
    await wait(1500);
    assert.equal((await auditOf('gateway_offline')).length, offBefore + 1, 'un seul avertissement par coupure');
    assert.equal((await auditOf('detector_silent')).length, 0);
    const onBefore = (await auditOf('gateway_online')).length;
    const back = await mqtt.connectAsync(`mqtt://127.0.0.1:${mqttPort}`, { username: 'gw1', password: GW_PW, connectTimeout: 4000, reconnectPeriod: 0 });
    await wait(300);
    assert.equal((await state()).devices.find((d) => d.id === 'D-01')!.status, 'normal');
    assert.equal((await auditOf('gateway_online')).length, onBefore + 1);
    await back.endAsync();
  });
});
