import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { computeAccessReport, reasonText } from '../server/accessreport.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import type { Mailer } from '../server/notifications.ts';
import { createReportMail } from '../server/reportmail.ts';
import { createReports, dayString } from '../server/reports.ts';
import type { Range } from '../server/reports.ts';
import { seedDemo } from '../server/seed.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Fevrier 2026 : aucun changement d'heure. Periode du lundi 2 au dimanche 8 inclus.
const at = (m: number, d: number, h = 0, min = 0) => new Date(2026, m - 1, d, h, min).getTime();
const FROM = at(2, 2);
const TO = at(2, 9);
const NOW = at(2, 10, 12);
const range = (category: Range['category'] = null): Range => ({ from: FROM, to: TO, fromDay: dayString(FROM), toDay: dayString(TO - 1), category });

const HOSTILE = 'Porte <script>alert(1)</script> principale';
const SECRETS = ['ZORRO-NOM-TEST', '99887766', 'HREF-4242', 'CTL-SECRET-7', '10.99.88.77', 'zorro-nom-test'];

function setup() {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  const engine = createEngine(db, () => {}, () => NOW);
  const reports = createReports(db, () => 'Site <demo>', () => null);
  const mailer: Mailer = { async send() {} };
  const mail = createReportMail({ db, reports, mailer, now: () => NOW, audit: (a, x, r) => engine.audit(a, x, r), siteName: () => 'Site <demo>', css: () => 'body{color:#000}' });
  return { db, reports, mail };
}

function addController(db: DatabaseSync, id = 'CTL-SECRET-7') {
  db.prepare("INSERT INTO access_controller (id, name, brand, host, created_at, created_by, updated_at, updated_by) VALUES (?, 'Controleur', 'dahua', '10.99.88.77', 1, 'test', 1, 'test')").run(id);
}

function addDoor(db: DatabaseSync, id: string, name: string, no: number, controller = 'CTL-SECRET-7') {
  db.prepare("INSERT INTO device (id, kind, name, zone, status, category) VALUES (?, 'detector', ?, 'Zone A', 'normal', 'access')").run(id, name);
  db.prepare('INSERT INTO access_door (detector_id, controller_id, door_no) VALUES (?, ?, ?)').run(id, controller, no);
}

let eventSeq = 0;
function passage(db: DatabaseSync, door: string, result: 'granted' | 'denied', t: number, extra: { reason?: string | null; late?: number; name?: string; credential?: string; ref?: string } = {}) {
  db.prepare(
    `INSERT INTO access_event (door_id, controller_id, at_device, at_received, credential, holder_name, holder_ref, method, result, reason, device_event_id, late)
     VALUES (?, 'CTL-SECRET-7', ?, ?, ?, ?, ?, 'badge', ?, ?, ?, ?)`,
  ).run(door, t, t, extra.credential ?? null, extra.name ?? null, extra.ref ?? null, result, extra.reason ?? null, `e${++eventSeq}`, extra.late ?? 0);
}

function incident(db: DatabaseSync, door: string, event: string | null, t: number) {
  db.prepare("INSERT INTO incident (detector_id, severity, status, opened_at, closed_at, event) VALUES (?, 'critical', 'closed', ?, ?, ?)").run(door, t, t + 1000, event);
}

function state(db: DatabaseSync, door: string, st: string, from: number, to: number) {
  db.prepare('INSERT INTO device_state_history (device_id, state, started_at, ended_at) VALUES (?, ?, ?, ?)').run(door, st, from, to);
}

/** Jeu connu : deux portes (dont une au nom hostile), une porte retiree, des donnees dans et hors periode. */
function dataset(db: DatabaseSync) {
  addController(db);
  addDoor(db, 'P1', HOSTILE, 1);
  addDoor(db, 'P2', 'Portail nord', 2);
  const t = at(2, 4, 10);
  for (let i = 0; i < 3; i++) passage(db, 'P1', 'granted', t + i * 1000, { late: i === 0 ? 1 : 0, name: 'ZORRO-NOM-TEST', credential: '99887766', ref: 'HREF-4242' });
  passage(db, 'P1', 'denied', t + 10_000, { reason: 'unknown_credential', name: 'ZORRO-NOM-TEST', credential: '99887766', ref: 'HREF-4242' });
  passage(db, 'P1', 'denied', t + 11_000, { reason: 'unknown_credential' });
  passage(db, 'P1', 'denied', t + 12_000, { reason: null });
  passage(db, 'P2', 'granted', t + 13_000);
  passage(db, 'P2', 'denied', t + 14_000, { reason: 'expired' });
  passage(db, 'P2', 'denied', t + 15_000, { reason: 'other' });
  passage(db, 'GONE', 'denied', t + 16_000, { reason: 'wrong_pin' }); // porte retiree depuis
  passage(db, 'P1', 'denied', FROM - 1, { reason: 'expired' }); // avant la periode
  passage(db, 'P1', 'denied', TO, { reason: 'expired' }); // `to` est exclu
  incident(db, 'P1', 'door_forced', at(2, 3, 9));
  incident(db, 'P1', 'door_forced', at(2, 3, 11));
  incident(db, 'P1', 'tamper', at(2, 3, 13));
  incident(db, 'P1', null, at(2, 3, 15));
  incident(db, 'P2', 'door_held_open', at(2, 5, 9));
  incident(db, 'P2', 'badge_denied_repeated', at(2, 5, 11));
  incident(db, 'P1', 'door_forced', FROM - DAY); // hors periode
  // P1 : normale, defaut 1 h puis hors ligne 2 h (meme panne : 3 h), normale, hors ligne 1 h (2e coupure), non surveille 2 h.
  state(db, 'P1', 'normal', FROM, at(2, 3, 12));
  state(db, 'P1', 'fault', at(2, 3, 12), at(2, 3, 13));
  state(db, 'P1', 'offline', at(2, 3, 13), at(2, 3, 15));
  state(db, 'P1', 'normal', at(2, 3, 15), at(2, 5, 8));
  state(db, 'P1', 'offline', at(2, 5, 8), at(2, 5, 9));
  state(db, 'P1', 'normal', at(2, 5, 9), at(2, 6, 0));
  state(db, 'P1', 'unmonitored', at(2, 6, 0), at(2, 6, 2));
  state(db, 'P1', 'normal', at(2, 6, 2), TO);
  state(db, 'P2', 'normal', FROM, TO);
}

describe('section Controle d\'acces du rapport', () => {
  it('absente sans aucune porte : ni titre ni texte, rapport et message inchanges', () => {
    const { db, reports, mail } = setup();
    assert.equal(computeAccessReport(db, range(), NOW), null);
    const html = reports.reportHtml(range(), reports.query(range()), NOW);
    assert.ok(!/Contrôle d'accès/.test(html));
    const m = mail.buildEmail(range(), reports.query(range()), NOW);
    for (const part of [m.text, m.html, m.report]) assert.ok(!/ontrôle d'accès|ontrole d'acces/.test(part));
  });

  it('absente quand le rapport est filtre sur une autre categorie ; presente pour access', () => {
    const { db, reports } = setup();
    dataset(db);
    assert.equal(computeAccessReport(db, range('fire'), NOW), null);
    assert.ok(!/Contrôle d'accès/.test(reports.reportHtml(range('fire'), reports.query(range('fire')), NOW)));
    assert.notEqual(computeAccessReport(db, range('access'), NOW), null);
    assert.notEqual(computeAccessReport(db, range(null), NOW), null);
  });

  it('chiffres cles, incidents par type, refus par motif, pannes : jeu connu', () => {
    const { db } = setup();
    dataset(db);
    const r = computeAccessReport(db, range(), NOW)!;
    assert.deepEqual([r.doors, r.passages, r.granted, r.denied, r.late], [2, 10, 4, 6, 1]);
    // Incidents : P1 = 2 forcees + 1 sabotage + 1 autre ; P2 = 1 maintenue ouverte + 1 refus repetes.
    assert.equal(r.incidentTotal, 6);
    const p1 = r.incidents.find((i) => i.door === HOSTILE)!;
    assert.deepEqual(p1.counts, { door_forced: 2, door_held_open: 0, badge_denied_repeated: 0, tamper: 1, other: 1 });
    assert.equal(p1.total, 4);
    const p2 = r.incidents.find((i) => i.door === 'Portail nord')!;
    assert.deepEqual(p2.counts, { door_forced: 0, door_held_open: 1, badge_denied_repeated: 1, tamper: 0, other: 0 });
    // Refus : P1 = 2 badge inconnu + 1 sans motif ; P2 = 1 expire + 1 autre ; porte retiree = 1 code errone.
    const d1 = r.denials.find((d) => d.door === HOSTILE)!;
    assert.equal(d1.total, 3);
    assert.deepEqual(d1.reasons, [{ label: 'Badge inconnu', count: 2 }, { label: 'Motif non précisé', count: 1 }]);
    const d2 = r.denials.find((d) => d.door === 'Portail nord')!;
    assert.deepEqual(d2.reasons.map((x) => x.label).sort(), ['Autre motif', 'Badge expiré']);
    assert.deepEqual(r.denials.find((d) => d.door === 'Porte retirée')!.reasons, [{ label: 'Code erroné', count: 1 }]);
    // Pannes : seule P1 apparait ; 3 h + 1 h = 4 h, 2 coupures, plus longue 3 h ; 2 h non surveillees a part.
    assert.equal(r.outages.length, 1);
    const o = r.outages[0];
    assert.deepEqual([o.door, o.downS, o.count, o.longestS], [HOSTILE, 4 * 3600, 2, 3 * 3600]);
    assert.equal(o.availabilityPct, 97.59); // 162 h en service sur 166 h observees
    assert.equal(r.unmonitoredS, 2 * 3600);
    assert.equal(r.retentionNote, false);
  });

  it('classe les portes par duree decroissante', () => {
    const { db } = setup();
    dataset(db);
    db.prepare('DELETE FROM device_state_history WHERE device_id = ?').run('P2');
    state(db, 'P2', 'normal', FROM, at(2, 7));
    state(db, 'P2', 'offline', at(2, 7), at(2, 7, 10));
    state(db, 'P2', 'normal', at(2, 7, 10), TO);
    const r = computeAccessReport(db, range(), NOW)!;
    assert.deepEqual(r.outages.map((o) => o.door), ['Portail nord', HOSTILE]);
  });

  it('periode sans incident ni panne ni refus : le dit en toutes lettres', () => {
    const { db, reports } = setup();
    addController(db);
    addDoor(db, 'P1', 'Porte A', 1);
    passage(db, 'P1', 'granted', at(2, 4));
    state(db, 'P1', 'normal', FROM, TO);
    const r = computeAccessReport(db, range(), NOW)!;
    assert.deepEqual([r.passages, r.granted, r.denied, r.incidentTotal, r.outages.length], [1, 1, 0, 0, 0]);
    const html = reports.reportHtml(range(), reports.query(range()), NOW);
    assert.match(html, /Aucun incident d'accès sur cette période/);
    assert.match(html, /Aucune porte hors ligne ou en défaut/);
    assert.match(html, /Aucun refus/);
  });

  it('nom de porte hostile echappe dans le rapport, la piece jointe autonome et le message', () => {
    const { db, reports, mail } = setup();
    dataset(db);
    const records = reports.query(range());
    const m = mail.buildEmail(range(), records, NOW);
    for (const html of [reports.reportHtml(range(), records, NOW), reports.standaloneReportHtml(range(), records, NOW, ''), m.html, m.report]) {
      assert.ok(!html.includes('<script>alert(1)'), 'balise non echappee');
      assert.ok(html.includes('&lt;script&gt;alert(1)'), 'nom present, echappe');
    }
  });

  it('note de conservation quand la periode commence avant la limite', () => {
    const { db, reports, mail } = setup();
    dataset(db);
    assert.equal(computeAccessReport(db, range(), NOW)!.retentionNote, false, '90 jours par defaut : la periode est recente');
    assert.equal(computeAccessReport(db, range(), at(6, 1))!.retentionNote, true, 'periode vieille de plus de 90 jours');
    db.prepare("INSERT INTO access_setting (key, value) VALUES ('retention_days', '7')").run();
    const r = computeAccessReport(db, range(), NOW)!;
    assert.equal(r.retentionNote, true);
    assert.equal(r.retentionDays, 7);
    const phrase = "Le journal des passages n'est conservé que 7 jours : les chiffres de passages et de refus de cette période peuvent être incomplets";
    assert.ok(reports.reportHtml(range(), reports.query(range()), NOW).includes(phrase.replace(/'/g, '&#39;')));
    const m = mail.buildEmail(range(), reports.query(range()), NOW);
    assert.ok(m.html.includes(phrase.replace(/'/g, '&#39;')));
    assert.match(m.text, /n'est conserve que 7 jours/);
  });

  it('texte du message en ASCII ; section presente dans le texte et le HTML', () => {
    const { db, reports, mail } = setup();
    dataset(db);
    const m = mail.buildEmail(range(), reports.query(range()), NOW);
    assert.match(m.text, /Controle d'acces/);
    assert.match(m.text, /2 porte\(s\) declaree\(s\) - 10 passage\(s\) : 4 accorde\(s\), 6 refuse\(s\), 1 recu\(s\) en differe/);
    assert.match(m.text, /Badge inconnu 2/);
    // Le reste du texte (existant) peut contenir un tiret long ; la section, elle, reste en ASCII.
    const block = m.text.slice(m.text.indexOf("Controle d'acces")).split('\n\n')[0];
    assert.ok(!/[^\x00-\x7f]/.test(block), 'section en ASCII');
    assert.match(m.html, /Contrôle d'accès/);
  });

  it('plusieurs milliers de passages : comptes exacts (agregation SQL)', () => {
    const { db } = setup();
    addController(db);
    addDoor(db, 'P1', 'Porte A', 1);
    db.exec('BEGIN');
    for (let i = 0; i < 5000; i++) passage(db, 'P1', i % 5 === 0 ? 'denied' : 'granted', FROM + i * 1000, { reason: i % 5 === 0 ? 'expired' : null, late: i % 100 === 0 ? 1 : 0 });
    db.exec('COMMIT');
    const r = computeAccessReport(db, range(), NOW)!;
    assert.deepEqual([r.passages, r.denied, r.granted, r.late], [5000, 1000, 4000, 50]);
    assert.deepEqual(r.denials[0].reasons, [{ label: 'Badge expiré', count: 1000 }]);
  });

  it('libelles de motif', () => {
    assert.equal(reasonText(null), 'Motif non précisé');
    assert.equal(reasonText('antipassback'), 'Anti-retour');
    assert.equal(reasonText('motif-inconnu'), 'Autre motif');
  });
});

describe('confidentialite de la section', () => {
  it('aucun nom, badge, reference, id ou adresse de controleur dans aucune sortie', () => {
    const { db, reports, mail } = setup();
    dataset(db);
    const records = reports.query(range());
    const m = mail.buildEmail(range(), records, NOW);
    const outputs: Record<string, string> = {
      'rapport HTML': reports.reportHtml(range(), records, NOW),
      'HTML autonome': reports.standaloneReportHtml(range(), records, NOW, 'body{}'),
      'texte du message': m.text,
      'HTML du message': m.html,
      'objet du message': m.subject,
      'CSV du message': m.csv,
      'piece jointe': m.report,
      'CSV des incidents': reports.incidentsCsv(range()),
    };
    // La section existe bien (sinon le test serait vide de sens).
    assert.match(outputs['rapport HTML'], /Contrôle d'accès/);
    assert.match(outputs['texte du message'], /Controle d'acces/);
    for (const [label, text] of Object.entries(outputs)) {
      for (const secret of SECRETS) assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `${label} contient « ${secret} »`);
    }
  });
});
