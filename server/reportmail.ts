import type { DatabaseSync } from 'node:sqlite';
import { PsimError } from './engine.ts';
import type { Mailer } from './notifications.ts';
import { validateAddress } from './recipients.ts';
import { CATEGORY_LABEL } from './sources.ts';
import { dayString, esc, fmtDuration, summarize } from './reports.ts';
import type { IncidentRecord, Range, Reports } from './reports.ts';

/**
 * Rapport periodique envoye par e-mail (hebdomadaire ou mensuel) : synthese chiffree dans le corps du message, rapport
 * complet autonome et export CSV en pieces jointes. Le message dit aussi si le PSIM a ete aveugle pendant la periode
 * et donne l'empreinte du journal (ancre), conservee ainsi hors de la machine.
 *
 * Periode : hebdomadaire = les 7 jours entiers qui precedent le jour d'envoi ; mensuel = le mois civil precedent.
 * Heure locale du serveur. L'activation n'envoie JAMAIS d'arriere : seul le prochain envoi prevu part.
 */

export type Frequency = 'off' | 'weekly' | 'monthly';
export const MAX_RECIPIENTS = 20;
/** Un envoi manque (PSIM arrete a l'heure prevue) est rattrape pendant 3 jours, pas au-dela. */
export const CATCH_UP_MS = 3 * 86_400_000;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 10 * 60_000;

export interface Schedule {
  frequency: Frequency;
  /** Jour d'envoi hebdomadaire : 0 = dimanche ... 6 = samedi. */
  weekday: number;
  /** Jour d'envoi mensuel : 1 a 28 (jamais 29-31 : tous les mois en ont un). */
  dayOfMonth: number;
  hour: number;
  recipients: string[];
  /** Debut du jour d'envoi du dernier rapport traite (envoye, ou abandonne apres 3 echecs). */
  lastDoneFor: number | null;
  lastSentAt: number | null;
  lastError: string | null;
  attempts: number;
  lastAttemptAt: number | null;
}

type Row = Record<string, unknown>;

const startOfDay = (ts: number): number => {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** Dernier moment d'envoi prevu qui est <= `now`, ou null (desactive). */
export function latestSendMoment(s: Pick<Schedule, 'frequency' | 'weekday' | 'dayOfMonth' | 'hour'>, now: number): number | null {
  if (s.frequency === 'off') return null;
  const n = new Date(now);
  if (s.frequency === 'weekly') {
    const back = (n.getDay() - s.weekday + 7) % 7;
    let t = new Date(n.getFullYear(), n.getMonth(), n.getDate() - back, s.hour).getTime();
    if (t > now) t = new Date(n.getFullYear(), n.getMonth(), n.getDate() - back - 7, s.hour).getTime();
    return t;
  }
  let t = new Date(n.getFullYear(), n.getMonth(), s.dayOfMonth, s.hour).getTime();
  if (t > now) t = new Date(n.getFullYear(), n.getMonth() - 1, s.dayOfMonth, s.hour).getTime();
  return t;
}

/** Prochain moment d'envoi strictement apres `now`. */
export function nextSendMoment(s: Pick<Schedule, 'frequency' | 'weekday' | 'dayOfMonth' | 'hour'>, now: number): number | null {
  const last = latestSendMoment(s, now);
  if (last === null) return null;
  const d = new Date(last);
  return s.frequency === 'weekly' ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7, s.hour).getTime() : new Date(d.getFullYear(), d.getMonth() + 1, s.dayOfMonth, s.hour).getTime();
}

/** Periode couverte par le rapport envoye au moment `sendMoment`. */
export function periodFor(frequency: Exclude<Frequency, 'off'>, sendMoment: number): Range {
  const d = new Date(sendMoment);
  const from = frequency === 'weekly' ? new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7) : new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const to = frequency === 'weekly' ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : new Date(d.getFullYear(), d.getMonth(), 1);
  return { from: from.getTime(), to: to.getTime(), fromDay: dayString(from.getTime()), toDay: dayString(to.getTime() - 1), category: null };
}

export interface ReportMailDeps {
  db: DatabaseSync;
  reports: Reports;
  /** null = pas de serveur SMTP configure : l'envoi est impossible (et le dit). */
  mailer: Mailer | null;
  audit: (actor: string, action: string, ref?: { details?: string }) => void;
  now?: () => number;
  siteName?: () => string;
  /** Empreinte de fin de journal (ancre). */
  journalHead?: () => { id: number; hash: string } | null;
  /** Contenu de web/report.css, integre dans la piece jointe autonome. */
  css?: () => string;
  publicUrl?: string;
}

export function createReportMail(deps: ReportMailDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;

  db.exec(`CREATE TABLE IF NOT EXISTS report_schedule (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    frequency TEXT NOT NULL DEFAULT 'off',
    weekday INTEGER NOT NULL DEFAULT 1,
    day_of_month INTEGER NOT NULL DEFAULT 1,
    hour INTEGER NOT NULL DEFAULT 7,
    recipients TEXT NOT NULL DEFAULT '[]',
    last_done_for INTEGER,
    last_sent_at INTEGER,
    last_error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER
  )`);
  db.prepare('INSERT OR IGNORE INTO report_schedule (id) VALUES (1)').run();

  function get(): Schedule {
    const r = db.prepare('SELECT * FROM report_schedule WHERE id = 1').get() as Row;
    return {
      frequency: r.frequency as Frequency,
      weekday: r.weekday as number,
      dayOfMonth: r.day_of_month as number,
      hour: r.hour as number,
      recipients: JSON.parse(r.recipients as string) as string[],
      lastDoneFor: (r.last_done_for as number | null) ?? null,
      lastSentAt: (r.last_sent_at as number | null) ?? null,
      lastError: (r.last_error as string | null) ?? null,
      attempts: r.attempts as number,
      lastAttemptAt: (r.last_attempt_at as number | null) ?? null,
    };
  }

  const int = (v: unknown, lo: number, hi: number, field: string): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new PsimError(400, `${field} invalide (${lo} a ${hi})`);
    return v;
  };

  /** Valide toute la demande AVANT d'ecrire : rien n'est modifie si une valeur est refusee. */
  function update(actor: string, input: Record<string, unknown>): Schedule {
    const current = get();
    const frequency = (input.frequency ?? current.frequency) as Frequency;
    if (frequency !== 'off' && frequency !== 'weekly' && frequency !== 'monthly') throw new PsimError(400, 'frequence invalide (off, weekly, monthly)');
    const weekday = input.weekday === undefined ? current.weekday : int(input.weekday, 0, 6, 'jour de la semaine');
    const dayOfMonth = input.dayOfMonth === undefined ? current.dayOfMonth : int(input.dayOfMonth, 1, 28, 'jour du mois');
    const hour = input.hour === undefined ? current.hour : int(input.hour, 0, 23, 'heure');
    let recipients = current.recipients;
    if (input.recipients !== undefined) {
      if (!Array.isArray(input.recipients)) throw new PsimError(400, 'recipients doit etre une liste');
      if (input.recipients.length > MAX_RECIPIENTS) throw new PsimError(400, `trop de destinataires (${MAX_RECIPIENTS} maximum)`);
      recipients = [...new Set(input.recipients.map((r) => validateAddress('email', r).toLowerCase()))];
    }
    if (frequency !== 'off' && recipients.length === 0) throw new PsimError(400, 'Ajoutez au moins un destinataire avant d\'activer le rapport');
    if (frequency !== 'off' && !deps.mailer) throw new PsimError(409, "Aucun serveur SMTP configure (PSIM_SMTP_HOST, PSIM_SMTP_FROM) : le rapport ne pourrait pas partir");

    const t = now();
    const next = { frequency, weekday, dayOfMonth, hour };
    // Activation ou changement de rythme : on ne rattrape rien. Le dernier envoi « du » est considere comme fait.
    const moment = latestSendMoment(next, t);
    const rescheduled = frequency !== current.frequency || weekday !== current.weekday || dayOfMonth !== current.dayOfMonth || hour !== current.hour;
    const lastDoneFor = frequency === 'off' ? null : rescheduled && moment !== null ? startOfDay(moment) : current.lastDoneFor;
    db.prepare('UPDATE report_schedule SET frequency = ?, weekday = ?, day_of_month = ?, hour = ?, recipients = ?, last_done_for = ?, attempts = 0, last_attempt_at = NULL, last_error = CASE WHEN ? THEN NULL ELSE last_error END WHERE id = 1').run(
      frequency, weekday, dayOfMonth, hour, JSON.stringify(recipients), lastDoneFor, rescheduled ? 1 : 0,
    );
    deps.audit(actor, 'report_schedule_updated', {
      details: frequency === 'off' ? 'rapport periodique desactive' : `${frequency === 'weekly' ? `chaque ${['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'][weekday]}` : `le ${dayOfMonth} de chaque mois`} a ${hour} h, ${recipients.length} destinataire(s)`,
    });
    return get();
  }

  // ---------------------------------------------------------------- contenu

  function buildEmail(range: Range, records: IncidentRecord[], at: number): { subject: string; text: string; html: string; csv: string; report: string } {
    const sum = summarize(records);
    const site = deps.siteName?.() ?? 'Site';
    const head = deps.journalHead?.() ?? null;
    const gaps = (db.prepare("SELECT ts, details FROM audit_log WHERE action = 'supervision_gap' AND ts >= ? AND ts < ? ORDER BY id").all(range.from, range.to) as { ts: number; details: string | null }[]);
    const integrity = (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'journal_integrity_failed' AND ts >= ? AND ts < ?").get(range.from, range.to) as { n: number }).n;
    const offline = (db.prepare("SELECT COUNT(*) AS n FROM device WHERE kind = 'detector' AND status IN ('offline', 'fault')").get() as { n: number }).n;
    const period = range.fromDay === range.toDay ? range.fromDay : `${range.fromDay} au ${range.toDay}`;
    const rate = sum.falseAlarmRate === null ? '—' : `${Math.round(sum.falseAlarmRate * 100)} %`;

    const lines: string[] = [
      `Rapport d'incidents - ${site}`,
      `Periode : ${period}`,
      '',
      sum.total === 0 ? 'Aucun incident sur la periode.' : `${sum.total} incident(s) : ${sum.critical} critique(s), ${sum.warning} avertissement(s).`,
      sum.total === 0 ? '' : `Evenements reels : ${sum.real} - fausses alarmes : ${sum.falseAlarms} (taux ${rate} des incidents qualifies) - non qualifies : ${sum.unqualified}.`,
      sum.total === 0 ? '' : `Acquittement (mediane) : ${fmtDuration(sum.ackMedianS)} - maximum : ${fmtDuration(sum.ackMaxS)}. Alertes envoyees : ${sum.notificationsSent}, en echec : ${sum.notificationsFailed}.`,
      ...sum.byCategory.map((c) => `  - ${CATEGORY_LABEL[c.category]} : ${c.total}`),
      '',
      gaps.length === 0 ? 'Surveillance : aucune periode sans surveillance pendant cette periode.' : `ATTENTION - surveillance interrompue ${gaps.length} fois : ${gaps.map((g) => g.details ?? '').join(' ; ')}`,
      offline > 0 ? `ATTENTION - ${offline} detecteur(s) actuellement hors service.` : 'Detecteurs : aucun hors service actuellement.',
      integrity > 0 ? `ATTENTION - le journal a ete signale ALTERE ${integrity} fois pendant la periode.` : '',
      '',
      head ? `Empreinte du journal (a conserver) : ${head.id}:${head.hash}` : '',
      deps.publicUrl ? `Ouvrir le PSIM : ${deps.publicUrl}` : '',
      'Le rapport complet (a ouvrir dans un navigateur, ou a imprimer en PDF) et l\'export CSV sont en pieces jointes.',
    ];

    const stat = (label: string, value: string) => `<td style="padding:8px 12px;border:1px solid #c9d1d9;text-align:center"><div style="font-size:22px;font-weight:700">${esc(value)}</div><div style="font-size:12px;color:#55606b">${esc(label)}</div></td>`;
    const warn = (text: string) => `<p style="margin:6px 0;padding:6px 10px;background:#fff4e0;border-left:4px solid #e08a00">${esc(text)}</p>`;
    const html = `<!doctype html><html lang="fr"><body style="font:14px/1.45 Segoe UI,Arial,sans-serif;color:#1b232b;max-width:640px">
<h2 style="margin:0 0 4px">Rapport d'incidents</h2>
<p style="margin:0 0 12px;color:#55606b">${esc(site)} - ${esc(period)}</p>
${sum.total === 0 ? '<p>Aucun incident sur la période.</p>' : `<table style="border-collapse:collapse;margin:8px 0"><tr>${stat('incidents', String(sum.total))}${stat('critiques', String(sum.critical))}${stat('réels', String(sum.real))}${stat('fausses alarmes', String(sum.falseAlarms))}${stat('taux de fausses alarmes', rate)}</tr></table>
<p style="margin:6px 0">Acquittement (médiane) : <b>${esc(fmtDuration(sum.ackMedianS))}</b>, maximum ${esc(fmtDuration(sum.ackMaxS))}. Alertes envoyées : ${sum.notificationsSent}${sum.notificationsFailed ? `, <b>${sum.notificationsFailed} en échec</b>` : ''}.</p>
<ul style="margin:6px 0">${sum.byCategory.map((c) => `<li>${esc(CATEGORY_LABEL[c.category])} : ${c.total}</li>`).join('')}</ul>`}
${gaps.length === 0 ? '<p style="margin:6px 0;color:#2a7a3b">Surveillance : aucune période sans surveillance.</p>' : warn(`Surveillance interrompue ${gaps.length} fois pendant la période : ${gaps.map((g) => g.details ?? '').join(' ; ')}`)}
${offline > 0 ? warn(`${offline} détecteur(s) actuellement hors service.`) : ''}
${integrity > 0 ? warn(`Le journal a été signalé ALTÉRÉ ${integrity} fois pendant la période.`) : ''}
${head ? `<p style="margin:12px 0 4px;font-size:12px;color:#55606b">Empreinte du journal (à conserver, voir <code>npm run verify-journal</code>) :<br><code>${head.id}:${head.hash}</code></p>` : ''}
<p style="font-size:12px;color:#55606b">Le rapport complet (à ouvrir dans un navigateur ou à imprimer en PDF) et l'export CSV sont en pièces jointes.</p>
</body></html>`;

    return {
      subject: `[PSIM] Rapport ${period} - ${sum.total === 0 ? 'aucun incident' : `${sum.total} incident${sum.total > 1 ? 's' : ''}`}${gaps.length ? ' - surveillance interrompue' : ''}`,
      text: lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n'),
      html,
      csv: deps.reports.incidentsCsv(range),
      report: deps.reports.standaloneReportHtml(range, records, at, deps.css?.() ?? ''),
    };
  }

  /** Envoie le rapport de la periode `range` a `to`. Leve une erreur si l'envoi echoue. */
  async function sendFor(range: Range, to: string[]): Promise<void> {
    if (!deps.mailer) throw new Error('Aucun serveur SMTP configure');
    const at = now();
    const mail = buildEmail(range, deps.reports.query(range), at);
    await deps.mailer.send({
      to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      attachments: [
        { filename: `rapport_${range.fromDay}_${range.toDay}.html`, content: mail.report, contentType: 'text/html; charset=utf-8' },
        { filename: `incidents_${range.fromDay}_${range.toDay}.csv`, content: mail.csv, contentType: 'text/csv; charset=utf-8' },
      ],
    });
  }

  /** Envoi immediat du rapport de la derniere periode complete (administrateur : verifier le rendu, ou rattraper). */
  async function sendNow(actor: string): Promise<{ range: Range; to: string[] }> {
    const s = get();
    if (s.recipients.length === 0) throw new PsimError(400, 'Aucun destinataire');
    if (!deps.mailer) throw new PsimError(409, 'Aucun serveur SMTP configure (PSIM_SMTP_HOST, PSIM_SMTP_FROM)');
    const frequency = s.frequency === 'off' ? 'weekly' : s.frequency;
    const range = periodFor(frequency, latestSendMoment({ frequency, weekday: s.weekday, dayOfMonth: s.dayOfMonth, hour: s.hour }, now())!);
    try {
      await sendFor(range, s.recipients);
    } catch (err) {
      const message = errorText(err);
      deps.audit(actor, 'report_email_failed', { details: `envoi manuel ${range.fromDay} au ${range.toDay} : ${message}` });
      throw new PsimError(502, `Envoi impossible : ${message}`);
    }
    deps.audit(actor, 'report_email_sent', { details: `envoi manuel ${range.fromDay} au ${range.toDay} a ${s.recipients.length} destinataire(s)` });
    return { range, to: s.recipients };
  }

  const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 160);

  let sending = false;

  /** A appeler chaque minute. Envoie le rapport s'il est du ; 3 essais espaces de 10 min, puis abandon (journalise). */
  async function tick(): Promise<void> {
    if (sending) return;
    const s = get();
    const t = now();
    const moment = latestSendMoment(s, t);
    if (s.frequency === 'off' || moment === null || s.recipients.length === 0) return;
    const day = startOfDay(moment);
    if (s.lastDoneFor !== null && s.lastDoneFor >= day) return; // deja traite
    if (t - moment > CATCH_UP_MS) {
      // Trop tard (PSIM arrete plusieurs jours) : on ne rattrape pas, on le dit.
      db.prepare('UPDATE report_schedule SET last_done_for = ?, attempts = 0 WHERE id = 1').run(day);
      deps.audit('systeme', 'report_email_failed', { details: `rapport du ${new Date(moment).toLocaleDateString('fr-FR')} non envoye : PSIM arrete plus de 3 jours a l'heure prevue` });
      return;
    }
    if (s.attempts >= MAX_ATTEMPTS) return;
    if (s.lastAttemptAt !== null && t - s.lastAttemptAt < RETRY_MS) return;
    if (!deps.mailer) return;

    sending = true;
    const range = periodFor(s.frequency, moment);
    db.prepare('UPDATE report_schedule SET attempts = attempts + 1, last_attempt_at = ? WHERE id = 1').run(t);
    try {
      await sendFor(range, s.recipients);
      db.prepare('UPDATE report_schedule SET last_done_for = ?, last_sent_at = ?, last_error = NULL, attempts = 0 WHERE id = 1').run(day, now());
      deps.audit('systeme', 'report_email_sent', { details: `${range.fromDay} au ${range.toDay} a ${s.recipients.length} destinataire(s)` });
    } catch (err) {
      const message = errorText(err);
      const last = s.attempts + 1 >= MAX_ATTEMPTS;
      // Abandon : la periode est consideree traitee ET le compteur repart de zero pour la suivante.
      db.prepare('UPDATE report_schedule SET last_error = ?, last_done_for = CASE WHEN ? THEN ? ELSE last_done_for END, attempts = CASE WHEN ? THEN 0 ELSE attempts END WHERE id = 1').run(message, last ? 1 : 0, day, last ? 1 : 0);
      deps.audit('systeme', 'report_email_failed', { details: `${range.fromDay} au ${range.toDay} : ${message} (essai ${s.attempts + 1}/${MAX_ATTEMPTS}${last ? ', abandon' : ''})` });
    } finally {
      sending = false;
    }
  }

  function view() {
    const s = get();
    const t = now();
    return { ...s, smtpConfigured: deps.mailer !== null, nextSendAt: nextSendMoment(s, t), maxRecipients: MAX_RECIPIENTS };
  }

  return { get, view, update, tick, sendNow, buildEmail };
}

export type ReportMail = ReturnType<typeof createReportMail>;
