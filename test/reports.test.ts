import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import { createReports, csvCell, dayString, esc, fmtDuration, parseRange, summarize, toCsv } from '../server/reports.ts';
import type { IncidentRecord } from '../server/reports.ts';
import { seedDemo } from '../server/seed.ts';

const MIN = 60_000;
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const badRequest = (pattern: RegExp) => (e: unknown) => e instanceof PsimError && e.status === 400 && pattern.test(e.message);

function setup() {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  let clock = at(2026, 2, 10, 9, 0);
  const engine = createEngine(db, () => {}, () => clock);
  const reports = createReports(db, () => 'Site <test>');
  return { db, engine, reports, set: (t: number) => void (clock = t), advance: (ms: number) => void (clock += ms) };
}

/** Un incident de bout en bout : ouverture, acquittement apres `ackMin`, cloture apres `closeMin`. */
function incident(t: ReturnType<typeof setup>, detector: string, message: Record<string, unknown>, ackMin: number, closeMin: number, qualification: 'fire' | 'false_alarm', comment = '') {
  t.engine.ingest(detector, message);
  const id = t.engine.getSnapshot().incidents.find((i) => i.detectorId === detector && i.status !== 'closed')!.id;
  t.advance(ackMin * MIN);
  t.engine.acknowledge(id, 'operateur');
  t.advance((closeMin - ackMin) * MIN);
  t.engine.ingest(detector, detector.startsWith('D') ? { state: 'normal' } : { event: 'clear', state: 'normal' });
  t.engine.close(id, 'operateur', qualification, comment);
  t.advance(10 * MIN);
  return id;
}

const range = (from: string, to: string, category?: string) => parseRange({ from, to, ...(category ? { category } : {}) });

describe('periode demandee', () => {
  it("par defaut : les 30 derniers jours, jusqu'a aujourd'hui inclus", () => {
    const r = parseRange({}, at(2026, 2, 10));
    assert.equal(r.toDay, '2026-02-10');
    assert.equal(r.fromDay, '2026-01-12', '30 jours en comptant aujourd hui');
    assert.equal(r.to, at(2026, 2, 11, 0, 0), 'la fin est exclusive : le lendemain a minuit');
    assert.equal(r.category, null);
  });

  it("le dernier jour est inclus, une seule journee est une periode valide", () => {
    const r = range('2026-02-10', '2026-02-10');
    assert.equal(r.to - r.from, 24 * 60 * MIN);
  });

  it('refuse les dates invalides, inexistantes, inversees, la periode trop longue et la categorie inconnue', () => {
    assert.throws(() => range('hier', '2026-02-10'), badRequest(/from invalide/));
    assert.throws(() => range('2026-02-30', '2026-03-01'), badRequest(/inexistante/));
    assert.throws(() => range('2026-02-10', '2026-02-09'), badRequest(/precede/));
    assert.throws(() => range('2024-01-01', '2026-02-10'), badRequest(/trop longue/));
    assert.throws(() => range('2026-02-01', '2026-02-10', 'gaz'), badRequest(/categorie/));
    assert.equal(parseRange({ from: ['2026-01-01'], to: '2026-02-10' }).fromDay, '2026-01-12', 'une valeur qui n est pas un texte est ignoree, jamais une erreur interne');
    assert.equal(dayString(at(2026, 2, 5)), '2026-02-05');
  });
});

describe('statistiques', () => {
  const t = setup();
  incident(t, 'D-01', { state: 'alarm' }, 2, 10, 'fire', 'feu reel');
  incident(t, 'D-02', { state: 'prealarm' }, 4, 6, 'false_alarm', 'vapeur');
  incident(t, 'D-02', { state: 'prealarm' }, 6, 8, 'false_alarm');
  incident(t, 'A-01', { event: 'door_forced' }, 1, 3, 'fire');
  t.engine.ingest('I-01', { event: 'motion' }); // reste ouvert, non acquitte
  const records = t.reports.query(range('2026-02-10', '2026-02-10'));
  const s = summarize(records);

  it('compte les incidents, la gravite et la qualification', () => {
    assert.equal(s.total, 5);
    assert.equal(s.critical, 3);
    assert.equal(s.warning, 2);
    assert.equal(s.real, 2);
    assert.equal(s.falseAlarms, 2);
    assert.equal(s.unqualified, 1);
    assert.equal(s.unacknowledged, 1);
  });

  it('taux de fausses alarmes sur les seuls incidents qualifies', () => {
    assert.equal(s.falseAlarmRate, 0.5);
    assert.equal(summarize([]).falseAlarmRate, null, 'aucune donnee : pas de taux invente');
  });

  it("delais d'acquittement (mediane, maximum) et de cloture (mediane)", () => {
    // acquittements : 2, 4, 6, 1 minutes -> mediane (2+4)/2 = 3 min ; cloture : 10, 6, 8, 3 -> (6+8)/2 = 7 min
    assert.equal(s.ackMedianS, 180);
    assert.equal(s.ackMaxS, 360);
    assert.equal(s.closeMedianS, 420);
  });

  it('regroupe par categorie, zone et detecteur, les plus sollicites en tete', () => {
    assert.deepEqual(s.byCategory.map((c) => [c.category, c.total, c.real, c.falseAlarms]), [['fire', 3, 1, 2], ['intrusion', 1, 0, 0], ['access', 1, 1, 0]]);
    assert.equal(s.byDetector[0].id, 'D-02');
    assert.deepEqual([s.byDetector[0].total, s.byDetector[0].falseAlarms], [2, 2]);
  });

  it('filtre par categorie et par periode', () => {
    assert.equal(t.reports.query(range('2026-02-10', '2026-02-10', 'access')).length, 1);
    assert.equal(t.reports.query(range('2026-02-09', '2026-02-09')).length, 0, 'la veille : rien');
    assert.equal(t.reports.query(range('2026-02-11', '2026-02-12')).length, 0);
  });
});

describe('CSV', () => {
  it("neutralise les formules (Excel) et protege separateurs, guillemets et retours a la ligne", () => {
    assert.equal(csvCell('=SOMME(A1)'), "'=SOMME(A1)");
    assert.equal(csvCell('+33 1'), "'+33 1");
    assert.equal(csvCell('-1+1'), "'-1+1");
    assert.equal(csvCell('@cmd'), "'@cmd");
    assert.equal(csvCell('a;b'), '"a;b"');
    assert.equal(csvCell('dit "oui"'), '"dit ""oui"""');
    assert.equal(csvCell('ligne1\nligne2'), '"ligne1\nligne2"');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(42), '42');
  });

  it("commence par le BOM UTF-8 (accents corrects dans Excel), separateur « ; », fins de ligne CRLF", () => {
    const csv = toCsv(['a', 'b'], [['é', 1]]);
    assert.ok(csv.startsWith('﻿a;b\r\n'));
    assert.ok(csv.endsWith('é;1\r\n'));
  });

  it("l'export des incidents contient une ligne par incident, et un commentaire malveillant est neutralise", () => {
    const t = setup();
    incident(t, 'D-01', { state: 'alarm' }, 2, 10, 'false_alarm', '=HYPERLINK("http://evil","clic")');
    const csv = t.reports.incidentsCsv(range('2026-02-10', '2026-02-10'));
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^N°;Ouvert le;Catégorie;/);
    assert.ok(lines[1].includes(`"'=HYPERLINK(""http://evil"",""clic"")"`), lines[1]);
    assert.match(lines[1], /;Fausse alarme;/);
  });

  it("le journal est exporte sur la periode, avec les actions et leurs auteurs", () => {
    const t = setup();
    incident(t, 'D-01', { state: 'alarm' }, 2, 10, 'fire');
    const csv = t.reports.auditCsv(range('2026-02-10', '2026-02-10'));
    assert.match(csv, /incident_opened/);
    assert.match(csv, /operateur;incident_acked/);
    assert.equal(t.reports.auditCsv(range('2026-01-01', '2026-01-02')).trim().split('\r\n').length, 1, 'periode vide : seulement l entete');
  });
});

describe('rapport et fiche HTML', () => {
  it("echappe tout texte venu d'un utilisateur ou d'un equipement : aucune balise injectee", () => {
    const t = setup();
    t.engine.updateDevice('admin', 'D-01', { name: '<img src=x onerror=alert(1)>', zone: '"><script>alert(2)</script>' });
    const id = incident(t, 'D-01', { state: 'alarm' }, 2, 10, 'false_alarm', '<script>alert(3)</script>');
    const html = t.reports.reportHtml(range('2026-02-10', '2026-02-10'), t.reports.query(range('2026-02-10', '2026-02-10')), at(2026, 2, 10));
    const page = t.reports.incidentHtml(id, at(2026, 2, 10));
    for (const doc of [html, page]) {
      assert.ok(!/<script>alert/.test(doc) && !/<img src=x/.test(doc), 'aucune balise injectee');
      assert.ok(doc.includes('&lt;script&gt;alert(3)&lt;/script&gt;') || doc.includes('&lt;img src=x'), 'le texte est affiche, echappe');
    }
    assert.ok(html.includes('Site &lt;test&gt;'), 'le nom du site est echappe aussi');
    assert.equal(esc(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  });

  it("le rapport donne les chiffres cles, sans rien inventer quand il n'y a pas d'incident", () => {
    const t = setup();
    const empty = t.reports.reportHtml(range('2026-02-10', '2026-02-10'), [], at(2026, 2, 10));
    assert.match(empty, /Aucun incident sur cette période/);
    assert.ok(!/<h2>Par catégorie/.test(empty));
    incident(t, 'D-01', { state: 'alarm' }, 2, 10, 'fire');
    incident(t, 'D-02', { state: 'prealarm' }, 4, 6, 'false_alarm');
    const html = t.reports.reportHtml(range('2026-02-10', '2026-02-10'), t.reports.query(range('2026-02-10', '2026-02-10')), at(2026, 2, 10));
    assert.match(html, /taux : 50 % des incidents qualifiés/);
    assert.match(html, /<h2>Détail des incidents/);
    assert.match(html, /\/api\/reports\/incidents\/\d+/);
  });

  it("la fiche d'incident donne la chronologie, les alertes et signale un echec d'envoi", () => {
    const t = setup();
    const id = incident(t, 'D-01', { state: 'alarm' }, 2, 10, 'fire');
    t.db.prepare("INSERT INTO notification_log (incident_id, kind, channel, recipient, level, status, attempts, created_at) VALUES (?, 'opened', 'email', 'a***@x.fr', 1, 'failed', 3, ?)").run(id, at(2026, 2, 10, 9, 1));
    t.db.prepare("INSERT INTO notification_log (incident_id, kind, channel, recipient, level, status, attempts, created_at) VALUES (?, 'round', 'email', '', 2, 'sent', 1, ?)").run(id, at(2026, 2, 10, 9, 2));
    const html = t.reports.incidentHtml(id, at(2026, 2, 10));
    assert.match(html, /Incident ouvert/);
    assert.match(html, /Acquitté/);
    assert.match(html, /Clôturé/);
    assert.ok(!/incident_opened|incident_acked/.test(html), 'libelles en francais, pas les codes internes');
    assert.match(html, /ÉCHEC \(3 tentatives\)/);
    assert.ok(!/round/.test(html), 'les lignes techniques de l escalade ne sont pas affichees');
    assert.throws(() => t.reports.incidentHtml(999, 0), (e: unknown) => e instanceof PsimError && e.status === 404);
  });

  it("une fiche d'incident hors incendie parle de son type", () => {
    const t = setup();
    const id = incident(t, 'A-01', { event: 'door_forced' }, 1, 3, 'fire');
    const html = t.reports.incidentHtml(id, at(2026, 2, 10));
    assert.match(html, /Contrôle d'accès|Contrôle d&#39;accès/);
    assert.match(html, /Accès anormal avéré/);
  });

  it('formate les durees de facon lisible', () => {
    assert.equal(fmtDuration(null), '—');
    assert.equal(fmtDuration(45), '45 s');
    assert.equal(fmtDuration(300), '5 min');
    assert.equal(fmtDuration(3 * 3600 + 5 * 60), '3 h 05');
    assert.equal(fmtDuration(5 * 86400), '5 j');
  });
});
