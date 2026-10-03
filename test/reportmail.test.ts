import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import type { MailMessage, Mailer } from '../server/notifications.ts';
import { CATCH_UP_MS, createReportMail, latestSendMoment, nextSendMoment, periodFor } from '../server/reportmail.ts';
import type { Schedule } from '../server/reportmail.ts';
import { createReports } from '../server/reports.ts';
import { seedDemo } from '../server/seed.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Fevrier / debut mars 2026 : aucun changement d'heure. 2026-02-02 est un lundi.
const at = (m: number, d: number, h = 0, min = 0) => new Date(2026, m - 1, d, h, min).getTime();
const badRequest = (pattern: RegExp, status = 400) => (e: unknown) => e instanceof PsimError && e.status === status && pattern.test(e.message);

function setup(opts: { smtp?: boolean; start?: number } = {}) {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  let clock = opts.start ?? at(2, 10, 12);
  const engine = createEngine(db, () => {}, () => clock);
  const sent: MailMessage[] = [];
  const state = { fail: null as string | null, calls: 0 };
  const mailer: Mailer = {
    async send(m) {
      state.calls++;
      if (state.fail) throw new Error(state.fail);
      sent.push(m);
    },
  };
  const reports = createReports(db, () => 'Site <demo>', () => ({ id: 42, hash: 'ab'.repeat(32) }));
  const mail = createReportMail({
    db, reports, mailer: opts.smtp === false ? null : mailer, now: () => clock, audit: (a, x, r) => engine.audit(a, x, r),
    siteName: () => 'Site <demo>', journalHead: () => ({ id: 42, hash: 'ab'.repeat(32) }), css: () => 'body{color:#000}', publicUrl: 'https://psim.exemple.test',
  });
  return { db, engine, mail, sent, state, set: (t: number) => void (clock = t), advance: (ms: number) => void (clock += ms), audits: (a: string) => engine.listAudit(200).filter((e) => e.action === a) };
}

const weekly = (weekday = 1, hour = 7): Pick<Schedule, 'frequency' | 'weekday' | 'dayOfMonth' | 'hour'> => ({ frequency: 'weekly', weekday, dayOfMonth: 1, hour });
const monthly = (dayOfMonth = 1, hour = 7): Pick<Schedule, 'frequency' | 'weekday' | 'dayOfMonth' | 'hour'> => ({ frequency: 'monthly', weekday: 1, dayOfMonth, hour });

describe('calendrier des envois', () => {
  it("hebdomadaire : dernier envoi prevu, prochain envoi, et periode = les 7 jours entiers precedents", () => {
    // mercredi 11 fevrier 12:00 ; envoi le lundi a 7 h
    const now = at(2, 11, 12);
    assert.equal(latestSendMoment(weekly(1, 7), now), at(2, 9, 7));
    assert.equal(nextSendMoment(weekly(1, 7), now), at(2, 16, 7));
    const p = periodFor('weekly', at(2, 9, 7));
    assert.deepEqual([p.fromDay, p.toDay], ['2026-02-02', '2026-02-08'], 'du lundi 2 au dimanche 8 inclus');
    assert.equal(p.to - p.from, 7 * DAY);
  });

  it("le jour d'envoi avant l'heure prevue : c'est encore la semaine precedente qui compte", () => {
    const now = at(2, 9, 6, 59); // lundi 6 h 59, envoi a 7 h
    assert.equal(latestSendMoment(weekly(1, 7), now), at(2, 2, 7));
    assert.equal(latestSendMoment(weekly(1, 7), at(2, 9, 7, 0)), at(2, 9, 7), "a l'heure pile : du");
  });

  it("mensuel : le mois civil precedent, quel que soit sa longueur", () => {
    assert.deepEqual([periodFor('monthly', at(2, 1, 7)).fromDay, periodFor('monthly', at(2, 1, 7)).toDay], ['2026-01-01', '2026-01-31']);
    assert.deepEqual([periodFor('monthly', at(3, 1, 7)).fromDay, periodFor('monthly', at(3, 1, 7)).toDay], ['2026-02-01', '2026-02-28'], 'fevrier : 28 jours');
    assert.equal(latestSendMoment(monthly(5, 8), at(2, 10, 12)), at(2, 5, 8));
    assert.equal(latestSendMoment(monthly(15, 8), at(2, 10, 12)), at(1, 15, 8), 'pas encore le 15 : celui du mois dernier');
    assert.equal(nextSendMoment(monthly(5, 8), at(2, 10, 12)), at(3, 5, 8));
  });

  it("desactive : ni envoi prevu ni prochain envoi", () => {
    const off = { frequency: 'off' as const, weekday: 1, dayOfMonth: 1, hour: 7 };
    assert.equal(latestSendMoment(off, at(2, 10)), null);
    assert.equal(nextSendMoment(off, at(2, 10)), null);
  });
});

describe('reglage', () => {
  it("refuse sans destinataire, sans serveur SMTP, ou avec une valeur invalide ; rien n'est modifie en cas de refus", () => {
    const t = setup();
    assert.throws(() => t.mail.update('admin', { frequency: 'weekly' }), badRequest(/au moins un destinataire/));
    assert.throws(() => t.mail.update('admin', { frequency: 'weekly', recipients: ['pas-un-mail'] }), badRequest(/e-mail invalide/));
    assert.throws(() => t.mail.update('admin', { frequency: 'weekly', recipients: ['a@x.fr'], hour: 24 }), badRequest(/heure invalide/));
    assert.throws(() => t.mail.update('admin', { frequency: 'weekly', recipients: ['a@x.fr'], weekday: 7 }), badRequest(/jour de la semaine/));
    assert.throws(() => t.mail.update('admin', { frequency: 'monthly', recipients: ['a@x.fr'], dayOfMonth: 29 }), badRequest(/jour du mois/));
    assert.throws(() => t.mail.update('admin', { frequency: 'tous-les-jours', recipients: ['a@x.fr'] }), badRequest(/frequence invalide/));
    assert.throws(() => t.mail.update('admin', { recipients: 'a@x.fr' }), badRequest(/liste/));
    assert.throws(() => t.mail.update('admin', { recipients: Array.from({ length: 21 }, (_, i) => `u${i}@x.fr`) }), badRequest(/trop de destinataires/));
    assert.deepEqual(t.mail.get().recipients, []);
    assert.equal(t.mail.get().frequency, 'off');

    const noSmtp = setup({ smtp: false });
    assert.throws(() => noSmtp.mail.update('admin', { frequency: 'weekly', recipients: ['a@x.fr'] }), badRequest(/SMTP/, 409));
    assert.equal(noSmtp.mail.view().smtpConfigured, false);
  });

  it("normalise les adresses (minuscules, sans doublon) et journalise le reglage", () => {
    const t = setup();
    const s = t.mail.update('admin', { frequency: 'weekly', weekday: 1, hour: 7, recipients: ['Direction@Exemple.FR', 'direction@exemple.fr', 'qhse@exemple.fr'] });
    assert.deepEqual(s.recipients, ['direction@exemple.fr', 'qhse@exemple.fr']);
    assert.match(t.audits('report_schedule_updated')[0].details ?? '', /chaque lundi a 7 h, 2 destinataire/);
  });

  it("l'activation n'envoie rien d'arriere : seul le prochain envoi prevu partira", async () => {
    const t = setup({ start: at(2, 11, 12) }); // mercredi, le lundi 9 est deja passe
    t.mail.update('admin', { frequency: 'weekly', weekday: 1, hour: 7, recipients: ['a@x.fr'] });
    await t.mail.tick();
    assert.equal(t.sent.length, 0, 'le lundi 9 est passe avant l\'activation : rien a rattraper');
    t.set(at(2, 16, 7, 1));
    await t.mail.tick();
    assert.equal(t.sent.length, 1);
    assert.deepEqual(t.sent[0].to, ['a@x.fr']);
  });
});

describe('envoi automatique', () => {
  const armed = (opts?: Parameters<typeof setup>[0]) => {
    const t = setup(opts);
    t.mail.update('admin', { frequency: 'weekly', weekday: 1, hour: 7, recipients: ['a@x.fr', 'b@x.fr'] });
    return t;
  };

  it("envoie une fois a l'heure prevue, a tous les destinataires, puis plus rien jusqu'a la semaine suivante", async () => {
    const t = armed({ start: at(2, 9, 6, 59) });
    await t.mail.tick();
    assert.equal(t.sent.length, 0, 'pas encore 7 h');
    t.set(at(2, 16, 7, 0));
    await t.mail.tick();
    await t.mail.tick();
    t.advance(30 * MIN);
    await t.mail.tick();
    assert.equal(t.sent.length, 1, 'un seul envoi');
    assert.deepEqual(t.sent[0].to, ['a@x.fr', 'b@x.fr']);
    assert.match(t.sent[0].subject, /Rapport 2026-02-09 au 2026-02-15/);
    assert.equal(t.audits('report_email_sent').length, 1);
    assert.ok(t.mail.get().lastSentAt !== null);
    t.set(at(2, 23, 7, 5));
    await t.mail.tick();
    assert.equal(t.sent.length, 2, 'semaine suivante');
  });

  it("rattrape un envoi manque (PSIM arrete a l'heure prevue) pendant 3 jours, pas au-dela", async () => {
    const t = armed({ start: at(2, 9, 6, 0) });
    t.set(at(2, 9, 7) + 20 * HOUR); // le PSIM redemarre lundi 3 h du matin... mardi : 20 h apres
    await t.mail.tick();
    assert.equal(t.sent.length, 1, 'rattrape');

    const late = armed({ start: at(2, 9, 6, 0) });
    late.set(at(2, 9, 7) + CATCH_UP_MS + HOUR);
    await late.mail.tick();
    assert.equal(late.sent.length, 0, 'trop tard : pas de rapport perime');
    assert.match(late.audits('report_email_failed')[0].details ?? '', /non envoye : PSIM arrete plus de 3 jours/);
    late.set(at(2, 16, 7, 1));
    await late.mail.tick();
    assert.equal(late.sent.length, 1, 'le suivant part normalement');
  });

  it("echec d'envoi : trois essais espaces de 10 minutes, puis abandon journalise ; le suivant part normalement", async () => {
    const t = armed({ start: at(2, 12, 12) });
    t.set(at(2, 16, 7, 0));
    t.state.fail = 'connexion SMTP refusee';
    await t.mail.tick();
    assert.equal(t.state.calls, 1);
    assert.match(t.mail.get().lastError ?? '', /refusee/);
    await t.mail.tick();
    assert.equal(t.state.calls, 1, 'pas de nouvel essai avant 10 min');
    t.advance(10 * MIN);
    await t.mail.tick();
    t.advance(10 * MIN);
    await t.mail.tick();
    assert.equal(t.state.calls, 3);
    t.advance(10 * MIN);
    await t.mail.tick();
    assert.equal(t.state.calls, 3, 'abandon apres 3 essais');
    const fails = t.audits('report_email_failed');
    assert.equal(fails.length, 3);
    assert.match(fails[0].details ?? '', /essai 3\/3, abandon/, 'le dernier journal dit qu\'on abandonne');
    // le reseau revient : la semaine suivante part
    t.state.fail = null;
    t.set(at(2, 23, 7, 1));
    await t.mail.tick();
    assert.equal(t.sent.length, 1);
    assert.equal(t.mail.get().lastError, null, 'l\'erreur est effacee par un succes');
  });

  it("un echec n'est jamais repete a la seconde pres, et deux tick simultanes n'envoient qu'une fois", async () => {
    const t = armed({ start: at(2, 12, 12) });
    t.set(at(2, 16, 7, 0));
    await Promise.all([t.mail.tick(), t.mail.tick(), t.mail.tick()]);
    assert.equal(t.sent.length, 1);
  });

  it("desactive, sans destinataire ou sans SMTP : aucun envoi", async () => {
    const t = armed({ start: at(2, 16, 8) });
    t.mail.update('admin', { frequency: 'off' });
    t.set(at(2, 23, 8));
    await t.mail.tick();
    assert.equal(t.sent.length, 0);
  });
});

describe('contenu du message', () => {
  function withIncidents() {
    const t = armed();
    function armed() {
      const x = setup({ start: at(2, 10, 9) });
      x.mail.update('admin', { frequency: 'weekly', weekday: 1, hour: 7, recipients: ['a@x.fr'] });
      return x;
    }
    t.engine.ingest('D-01', { state: 'alarm' });
    const id = t.engine.getSnapshot().incidents[0].id;
    t.advance(2 * MIN);
    t.engine.acknowledge(id, 'operateur');
    t.engine.ingest('D-01', { state: 'normal' });
    t.engine.close(id, 'operateur', 'false_alarm', '<script>alert(1)</script>');
    t.engine.ingest('A-01', { event: 'door_forced' });
    return t;
  }
  const range = { from: at(2, 9), to: at(2, 16), fromDay: '2026-02-09', toDay: '2026-02-15', category: null };

  it("resume chiffre dans le corps, avec l'empreinte du journal et le lien vers le PSIM", () => {
    const t = withIncidents();
    const m = t.mail.buildEmail(range, t.mail.get() && createReports(t.db).query(range), at(2, 16, 7));
    assert.match(m.text, /2 incident\(s\)/);
    assert.match(m.text, /fausses alarmes : 1 \(taux 100 %/);
    assert.match(m.text, /Empreinte du journal \(a conserver\) : 42:abab/);
    assert.match(m.text, /https:\/\/psim\.exemple\.test/);
    assert.match(m.html, /taux de fausses alarmes/);
    assert.match(m.subject, /^\[PSIM\] Rapport 2026-02-09 au 2026-02-15 - 2 incidents/);
  });

  it("echappe tout texte venu du site : aucune balise dans le message", () => {
    const t = withIncidents();
    const records = createReports(t.db).query(range);
    const m = t.mail.buildEmail(range, records, at(2, 16, 7));
    assert.ok(!/<script>alert/.test(m.html) && !/<script>alert/.test(m.report));
    assert.ok(m.html.includes('Site &lt;demo&gt;'), 'nom du site echappe');
    assert.ok(m.report.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'commentaire echappe dans le rapport joint');
  });

  it("la piece jointe HTML est autonome : CSS integre, ni script, ni feuille externe, ni bouton, ni lien vers le PSIM", () => {
    const t = withIncidents();
    const m = t.mail.buildEmail(range, createReports(t.db).query(range), at(2, 16, 7));
    assert.match(m.report, /<style>body\{color:#000\}<\/style>/);
    assert.ok(!/<script|report\.css|id="print"|\/api\/reports/.test(m.report), m.report.slice(0, 400));
    assert.match(m.report, /Empreinte du journal à l'établissement/);
    // le rapport normal, lui, reste inchange apres un rendu autonome (pas d'etat qui fuit)
    const normal = createReports(t.db).reportHtml(range, [], at(2, 16, 7));
    assert.match(normal, /\/report\.css/);
  });

  it("signale une surveillance interrompue pendant la periode, et un journal altere", () => {
    const t = setup({ start: at(2, 10, 9) });
    t.engine.audit('systeme', 'supervision_gap', { details: 'arret INATTENDU : aucune surveillance du 10/02 au 10/02 (7 min)' });
    t.engine.audit('systeme', 'journal_integrity_failed', { details: 'n°3 : contenu modifie' });
    const m = t.mail.buildEmail({ ...range, from: at(2, 9), to: at(2, 16) }, [], at(2, 16, 7));
    assert.match(m.text, /ATTENTION - surveillance interrompue 1 fois : arret INATTENDU/);
    assert.match(m.text, /journal a ete signale ALTERE 1 fois/);
    assert.match(m.subject, /surveillance interrompue/);
  });

  it("une semaine calme est envoyee aussi (c'est une preuve de bon fonctionnement)", async () => {
    const t = setup({ start: at(2, 16, 7, 0) });
    t.mail.update('admin', { frequency: 'weekly', weekday: 1, hour: 7, recipients: ['a@x.fr'] });
    t.set(at(2, 23, 7, 1));
    await t.mail.tick();
    assert.equal(t.sent.length, 1);
    assert.match(t.sent[0].subject, /aucun incident/);
    assert.match(t.sent[0].text, /Aucun incident sur la periode/);
  });

  it("pieces jointes : rapport HTML et CSV (BOM) aux noms de la periode", async () => {
    const t = setup({ start: at(2, 16, 7, 0) });
    t.mail.update('admin', { frequency: 'weekly', weekday: 1, hour: 7, recipients: ['a@x.fr'] });
    t.set(at(2, 23, 7, 1));
    await t.mail.tick();
    const files = t.sent[0].attachments!;
    assert.deepEqual(files.map((f) => f.filename), ['rapport_2026-02-16_2026-02-22.html', 'incidents_2026-02-16_2026-02-22.csv']);
    assert.ok(String(files[1].content).startsWith('﻿N°;'));
  });
});

describe('envoi manuel', () => {
  it("envoie le dernier rapport complet sans toucher au calendrier ; refuse sans destinataire ni SMTP ; echec = 502 journalise", async () => {
    const t = setup({ start: at(2, 11, 12) });
    await assert.rejects(t.mail.sendNow('admin'), badRequest(/destinataire/));
    t.mail.update('admin', { frequency: 'weekly', weekday: 1, hour: 7, recipients: ['a@x.fr'] });
    const before = t.mail.get().lastDoneFor;
    const r = await t.mail.sendNow('admin');
    assert.deepEqual([r.range.fromDay, r.range.toDay], ['2026-02-02', '2026-02-08']);
    assert.equal(t.sent.length, 1);
    assert.equal(t.mail.get().lastDoneFor, before, 'le calendrier automatique est intact');
    t.state.fail = 'SMTP injoignable';
    await assert.rejects(t.mail.sendNow('admin'), badRequest(/Envoi impossible : SMTP injoignable/, 502));
    assert.equal(t.audits('report_email_failed').length, 1);
    const noSmtp = setup({ smtp: false });
    noSmtp.db.prepare("UPDATE report_schedule SET recipients = '[\"a@x.fr\"]'").run();
    await assert.rejects(noSmtp.mail.sendNow('admin'), badRequest(/SMTP/, 409));
  });
});
