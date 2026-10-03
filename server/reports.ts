import type { DatabaseSync } from 'node:sqlite';
import { PsimError } from './engine.ts';
import { CATEGORIES, CATEGORY_LABEL } from './sources.ts';
import type { DeviceCategory } from './types.ts';

/**
 * Rapports et exports : export CSV des incidents et du journal, rapport imprimable (a enregistrer en PDF depuis
 * le navigateur : « Imprimer > Enregistrer au format PDF ») et fiche detaillee d'un incident. Lecture seule : rien
 * ici ne modifie la base.
 *
 * Toutes les dates sont a l'heure locale du serveur. Tout texte venu d'un utilisateur ou d'un equipement (nom,
 * commentaire) est echappe en HTML, et neutralise contre l'injection de formule dans les CSV.
 */

export const MAX_RANGE_DAYS = 366;
export const MAX_HTML_ROWS = 2000;
export const MAX_CSV_ROWS = 50_000;

export interface Range {
  from: number;
  /** Exclusif : debut du lendemain du dernier jour demande. */
  to: number;
  fromDay: string;
  toDay: string;
  category: DeviceCategory | null;
}

export interface IncidentRecord {
  id: number;
  detectorId: string;
  detectorName: string;
  zone: string;
  category: DeviceCategory;
  severity: 'warning' | 'critical';
  status: 'open' | 'acknowledged' | 'closed';
  qualification: 'fire' | 'false_alarm' | null;
  comment: string | null;
  openedAt: number;
  ackedAt: number | null;
  ackedBy: string | null;
  closedAt: number | null;
  closedBy: string | null;
  confirmedAt: number | null;
  confirmationReason: string | null;
  hint: string | null;
  snapshots: number;
  notificationsSent: number;
  notificationsFailed: number;
}

export interface Summary {
  total: number;
  critical: number;
  warning: number;
  confirmed: number;
  /** Evenements reels / fausses alarmes / pas encore qualifies. */
  real: number;
  falseAlarms: number;
  unqualified: number;
  /** Part des fausses alarmes parmi les incidents qualifies (null si aucun n'est qualifie). */
  falseAlarmRate: number | null;
  /** Delais en secondes : delai d'acquittement et duree jusqu'a la cloture (null si aucun incident concerne). */
  ackMedianS: number | null;
  ackMaxS: number | null;
  closeMedianS: number | null;
  unacknowledged: number;
  notificationsSent: number;
  notificationsFailed: number;
  byCategory: { category: DeviceCategory; total: number; real: number; falseAlarms: number }[];
  byZone: { zone: string; total: number }[];
  byDetector: { id: string; name: string; total: number; falseAlarms: number }[];
}

type Row = Record<string, unknown>;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDay(value: string, field: string): number {
  const m = DAY.exec(value);
  if (!m) throw new PsimError(400, `${field} invalide (AAAA-MM-JJ attendu)`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) throw new PsimError(400, `${field} : date inexistante`);
  return date.getTime();
}

export const dayString = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Lit `from`, `to` (jours, inclus) et `category` ; par defaut les 30 derniers jours, tous types. */
export function parseRange(query: Record<string, unknown>, now = Date.now()): Range {
  const get = (k: string) => (typeof query[k] === 'string' && query[k] !== '' ? (query[k] as string) : null);
  const toDay = get('to') ?? dayString(now);
  const to = new Date(parseDay(toDay, 'to'));
  to.setDate(to.getDate() + 1);
  const fromDay = get('from') ?? dayString(new Date(to.getFullYear(), to.getMonth(), to.getDate() - 30).getTime());
  const from = parseDay(fromDay, 'from');
  if (to.getTime() <= from) throw new PsimError(400, 'La date de fin precede la date de debut');
  const days = Math.round((to.getTime() - from) / 86_400_000);
  if (days > MAX_RANGE_DAYS) throw new PsimError(400, `Periode trop longue (${MAX_RANGE_DAYS} jours maximum)`);
  const cat = get('category');
  if (cat !== null && !CATEGORIES.includes(cat as DeviceCategory)) throw new PsimError(400, `categorie invalide (${CATEGORIES.join(', ')})`);
  return { from, to: to.getTime(), fromDay, toDay, category: cat as DeviceCategory | null };
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

export function summarize(records: IncidentRecord[]): Summary {
  const real = records.filter((r) => r.qualification === 'fire').length;
  const falseAlarms = records.filter((r) => r.qualification === 'false_alarm').length;
  const qualified = real + falseAlarms;
  const acks = records.filter((r) => r.ackedAt !== null).map((r) => Math.round((r.ackedAt! - r.openedAt) / 1000));
  const closes = records.filter((r) => r.closedAt !== null).map((r) => Math.round((r.closedAt! - r.openedAt) / 1000));
  const group = <K extends string>(key: (r: IncidentRecord) => K) => {
    const map = new Map<K, IncidentRecord[]>();
    for (const r of records) map.set(key(r), [...(map.get(key(r)) ?? []), r]);
    return map;
  };
  return {
    total: records.length,
    critical: records.filter((r) => r.severity === 'critical').length,
    warning: records.filter((r) => r.severity === 'warning').length,
    confirmed: records.filter((r) => r.confirmedAt !== null).length,
    real,
    falseAlarms,
    unqualified: records.length - qualified,
    falseAlarmRate: qualified === 0 ? null : falseAlarms / qualified,
    ackMedianS: median(acks),
    ackMaxS: acks.length ? Math.max(...acks) : null,
    closeMedianS: median(closes),
    unacknowledged: records.filter((r) => r.status === 'open').length,
    notificationsSent: records.reduce((n, r) => n + r.notificationsSent, 0),
    notificationsFailed: records.reduce((n, r) => n + r.notificationsFailed, 0),
    byCategory: CATEGORIES.map((category) => {
      const rs = records.filter((r) => r.category === category);
      return { category, total: rs.length, real: rs.filter((r) => r.qualification === 'fire').length, falseAlarms: rs.filter((r) => r.qualification === 'false_alarm').length };
    }).filter((c) => c.total > 0),
    byZone: [...group((r) => r.zone || '(sans zone)')].map(([zone, rs]) => ({ zone, total: rs.length })).sort((a, b) => b.total - a.total || a.zone.localeCompare(b.zone, 'fr')).slice(0, 10),
    byDetector: [...group((r) => r.detectorId)]
      .map(([id, rs]) => ({ id, name: rs[0].detectorName, total: rs.length, falseAlarms: rs.filter((r) => r.qualification === 'false_alarm').length }))
      .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id))
      .slice(0, 10),
  };
}

// ---------------------------------------------------------------- formats

export const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const SEVERITY: Record<string, string> = { critical: 'Critique', warning: 'Avertissement' };
const STATUS: Record<string, string> = { open: 'Non acquitté', acknowledged: 'Acquitté', closed: 'Clôturé' };

export function qualificationText(category: DeviceCategory, q: string | null): string {
  if (q === 'false_alarm') return 'Fausse alarme';
  if (q !== 'fire') return 'Non qualifié';
  return { fire: 'Feu confirmé', intrusion: 'Intrusion avérée', access: 'Accès anormal avéré', environment: 'Incident avéré' }[category];
}

export const fmtDateTime = (ts: number | null): string => (ts === null ? '' : new Date(ts).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' }));

export function fmtDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 90) return `${seconds} s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${Math.round(h / 24)} j`;
}

const ACTION_TEXT: Record<string, string> = {
  incident_opened: 'Incident ouvert',
  incident_escalated: 'Aggravation (préalarme → alarme)',
  incident_confirmed: 'Incident confirmé',
  incident_hint: 'Indice : fausse alarme probable',
  incident_acked: 'Acquitté',
  incident_closed: 'Clôturé',
  notification_escalated: 'Escalade : niveau 2 prévenu',
  notification_reminder: 'Rappel envoyé',
  notification_failed: "Échec d'envoi d'une alerte",
  device_state: "Changement d'état",
  sim_trigger: 'Simulation',
};

/** Détails du journal en français lisible quand ils suivent un code connu ; sinon tels quels. */
function detailsText(action: string, details: string | null, category: DeviceCategory): string {
  if (!details) return '';
  if (action === 'incident_opened') return details === 'critical' ? 'critique' : details === 'warning' ? 'avertissement' : details;
  if (action === 'incident_closed') return qualificationText(category, details === 'fire' || details === 'false_alarm' ? details : null);
  if (action === 'incident_confirmed') return details.startsWith('neighbor:') ? `détecteur voisin ${details.slice(9)}` : details === 'persistence' ? 'persistance' : details;
  return details;
}

function confirmationText(r: IncidentRecord): string {
  if (r.confirmedAt === null) return 'à confirmer';
  const why = r.confirmationReason ?? '';
  return `confirmé (${why.startsWith('neighbor:') ? `détecteur voisin ${why.slice(9)}` : why === 'persistence' ? 'persistance' : why})`;
}

/** Cellule CSV : guillemets doubles, et neutralisation d'une formule (=, +, -, @, tabulation) pour Excel. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV pour Excel en francais : separateur « ; », UTF-8 avec BOM, fins de ligne CRLF. */
export function toCsv(header: string[], rows: unknown[][]): string {
  return `﻿${[header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n')}\r\n`;
}

export function incidentsCsv(records: IncidentRecord[]): string {
  return toCsv(
    ['N°', 'Ouvert le', 'Catégorie', 'Détecteur', 'Nom', 'Zone', 'Gravité', 'État', 'Confirmation', 'Acquitté le', 'Acquitté par', 'Délai d’acquittement (s)', 'Clôturé le', 'Clôturé par', 'Durée (s)', 'Qualification', 'Commentaire', 'Images', 'Alertes envoyées', 'Alertes en échec'],
    records.map((r) => [
      r.id,
      fmtDateTime(r.openedAt),
      CATEGORY_LABEL[r.category],
      r.detectorId,
      r.detectorName,
      r.zone,
      SEVERITY[r.severity],
      STATUS[r.status],
      confirmationText(r),
      fmtDateTime(r.ackedAt),
      r.ackedBy,
      r.ackedAt === null ? '' : Math.round((r.ackedAt - r.openedAt) / 1000),
      fmtDateTime(r.closedAt),
      r.closedBy,
      r.closedAt === null ? '' : Math.round((r.closedAt - r.openedAt) / 1000),
      qualificationText(r.category, r.qualification),
      r.comment,
      r.snapshots,
      r.notificationsSent,
      r.notificationsFailed,
    ]),
  );
}

// ---------------------------------------------------------------- service

export function createReports(db: DatabaseSync, siteName: () => string = () => 'Site') {
  function query(range: Range, limit = MAX_CSV_ROWS): IncidentRecord[] {
    const rows = db
      .prepare(
        `SELECT i.*, d.name AS detector_name, d.zone AS zone, d.category AS category,
                (SELECT COUNT(*) FROM incident_snapshot s WHERE s.incident_id = i.id) AS snapshots,
                (SELECT COUNT(*) FROM notification_log n WHERE n.incident_id = i.id AND n.kind <> 'round' AND n.status = 'sent') AS sent,
                (SELECT COUNT(*) FROM notification_log n WHERE n.incident_id = i.id AND n.kind <> 'round' AND n.status = 'failed') AS failed
           FROM incident i JOIN device d ON d.id = i.detector_id
          WHERE i.opened_at >= ? AND i.opened_at < ? ${range.category ? 'AND d.category = ?' : ''}
          ORDER BY i.opened_at DESC, i.id DESC LIMIT ?`,
      )
      .all(...(range.category ? [range.from, range.to, range.category, limit] : [range.from, range.to, limit])) as Row[];
    return rows.map(toRecord);
  }

  function toRecord(r: Row): IncidentRecord {
    return {
      id: r.id as number,
      detectorId: r.detector_id as string,
      detectorName: r.detector_name as string,
      zone: r.zone as string,
      category: ((r.category as string | null) ?? 'fire') as DeviceCategory,
      severity: r.severity as IncidentRecord['severity'],
      status: r.status as IncidentRecord['status'],
      qualification: (r.qualification as IncidentRecord['qualification']) ?? null,
      comment: (r.comment as string | null) ?? null,
      openedAt: r.opened_at as number,
      ackedAt: (r.acked_at as number | null) ?? null,
      ackedBy: (r.acked_by as string | null) ?? null,
      closedAt: (r.closed_at as number | null) ?? null,
      closedBy: (r.closed_by as string | null) ?? null,
      confirmedAt: (r.confirmed_at as number | null) ?? null,
      confirmationReason: (r.confirmation_reason as string | null) ?? null,
      hint: (r.hint as string | null) ?? null,
      snapshots: (r.snapshots as number) ?? 0,
      notificationsSent: (r.sent as number) ?? 0,
      notificationsFailed: (r.failed as number) ?? 0,
    };
  }

  function auditCsv(range: Range): string {
    const rows = db
      .prepare('SELECT * FROM audit_log WHERE ts >= ? AND ts < ? ORDER BY id LIMIT ?')
      .all(range.from, range.to, MAX_CSV_ROWS) as Row[];
    return toCsv(
      ['Date', 'Auteur', 'Action', 'Incident', 'Équipement', 'Détails'],
      rows.map((r) => [fmtDateTime(r.ts as number), r.actor, r.action, r.incident_id, r.device_id, r.details]),
    );
  }

  function detail(id: number): { record: IncidentRecord; timeline: { ts: number; actor: string; action: string; details: string | null }[]; notifications: Row[]; snapshotIds: { id: number; cameraId: string; takenAt: number; reason: string }[] } {
    const row = db
      .prepare(
        `SELECT i.*, d.name AS detector_name, d.zone AS zone, d.category AS category,
                (SELECT COUNT(*) FROM incident_snapshot s WHERE s.incident_id = i.id) AS snapshots,
                (SELECT COUNT(*) FROM notification_log n WHERE n.incident_id = i.id AND n.kind <> 'round' AND n.status = 'sent') AS sent,
                (SELECT COUNT(*) FROM notification_log n WHERE n.incident_id = i.id AND n.kind <> 'round' AND n.status = 'failed') AS failed
           FROM incident i JOIN device d ON d.id = i.detector_id WHERE i.id = ?`,
      )
      .get(id) as Row | undefined;
    if (!row) throw new PsimError(404, 'Incident introuvable');
    return {
      record: toRecord(row),
      timeline: (db.prepare('SELECT ts, actor, action, details FROM audit_log WHERE incident_id = ? ORDER BY id').all(id) as Row[]).map((r) => ({ ts: r.ts as number, actor: r.actor as string, action: r.action as string, details: (r.details as string | null) ?? null })),
      notifications: db.prepare("SELECT kind, channel, recipient, level, status, attempts, created_at FROM notification_log WHERE incident_id = ? AND kind <> 'round' ORDER BY id").all(id) as Row[],
      snapshotIds: (db.prepare('SELECT id, camera_id, taken_at, reason FROM incident_snapshot WHERE incident_id = ? ORDER BY id').all(id) as Row[]).map((s) => ({ id: s.id as number, cameraId: s.camera_id as string, takenAt: s.taken_at as number, reason: s.reason as string })),
    };
  }

  const percent = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)} %`);

  const PAGE_HEAD = (title: string) =>
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/report.css"></head><body>`;
  const PAGE_FOOT = '<script src="/report.js"></script></body></html>';

  function reportHtml(range: Range, records: IncidentRecord[], now: number): string {
    const sum = summarize(records);
    const shown = records.slice(0, MAX_HTML_ROWS);
    const scope = range.category ? ` — ${esc(CATEGORY_LABEL[range.category])}` : '';
    const stat = (label: string, value: string, note = '') => `<div class="stat"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div>${note ? `<div class="n">${esc(note)}</div>` : ''}</div>`;
    const table = (head: string[], rows: string[][]) =>
      `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    return `${PAGE_HEAD(`Rapport d'incidents ${range.fromDay} au ${range.toDay}`)}
<header class="bar"><h1>Rapport d'incidents${scope}</h1><button id="print" class="noprint" type="button">Imprimer / enregistrer en PDF</button></header>
<p class="meta">${esc(siteName())} — du ${esc(range.fromDay)} au ${esc(range.toDay)} inclus — établi le ${esc(fmtDateTime(now))} (heure du serveur)</p>
<section class="stats">
${stat('Incidents', String(sum.total), `${sum.critical} critiques, ${sum.warning} avertissements`)}
${stat('Événements réels', String(sum.real))}
${stat('Fausses alarmes', String(sum.falseAlarms), `taux : ${percent(sum.falseAlarmRate)} des incidents qualifiés`)}
${stat('Non qualifiés', String(sum.unqualified))}
${stat("Acquittement (médiane)", fmtDuration(sum.ackMedianS), `maximum : ${fmtDuration(sum.ackMaxS)}`)}
${stat('Clôture (médiane)', fmtDuration(sum.closeMedianS))}
${stat('Alertes envoyées', String(sum.notificationsSent), `${sum.notificationsFailed} en échec`)}
</section>
${sum.total === 0 ? '<p class="empty">Aucun incident sur cette période.</p>' : `
<h2>Par catégorie</h2>
${table(['Catégorie', 'Incidents', 'Réels', 'Fausses alarmes'], sum.byCategory.map((c) => [esc(CATEGORY_LABEL[c.category]), String(c.total), String(c.real), String(c.falseAlarms)]))}
<div class="cols"><div><h2>Zones les plus touchées</h2>${table(['Zone', 'Incidents'], sum.byZone.map((z) => [esc(z.zone), String(z.total)]))}</div>
<div><h2>Détecteurs les plus sollicités</h2>${table(['Détecteur', 'Incidents', 'Dont fausses alarmes'], sum.byDetector.map((d) => [`${esc(d.id)} ${esc(d.name)}`, String(d.total), String(d.falseAlarms)]))}</div></div>
<h2>Détail des incidents</h2>
${records.length > shown.length ? `<p class="warn">Seuls les ${shown.length} incidents les plus récents sont listés sur ${records.length} : réduisez la période ou utilisez l'export CSV.</p>` : ''}
${table(
  ['N°', 'Ouvert le', 'Détecteur', 'Zone', 'Gravité', 'État', 'Acquitté', 'Clôturé', 'Qualification', 'Commentaire'],
  shown.map((r) => [
    `<a href="/api/reports/incidents/${r.id}">${r.id}</a>`,
    esc(fmtDateTime(r.openedAt)),
    `${esc(r.detectorId)} ${esc(r.detectorName)}<br><small>${esc(CATEGORY_LABEL[r.category])} — ${esc(confirmationText(r))}</small>`,
    esc(r.zone),
    esc(SEVERITY[r.severity]),
    esc(STATUS[r.status]),
    r.ackedAt === null ? '—' : `${esc(r.ackedBy)} (${esc(fmtDuration(Math.round((r.ackedAt - r.openedAt) / 1000)))})`,
    r.closedAt === null ? '—' : `${esc(r.closedBy)} (${esc(fmtDuration(Math.round((r.closedAt - r.openedAt) / 1000)))})`,
    esc(qualificationText(r.category, r.qualification)),
    esc(r.comment ?? ''),
  ]),
)}`}
<p class="foot">Document généré par le PSIM à partir de son journal. Les durées sont mesurées entre l'ouverture de l'incident et l'action de l'opérateur.</p>
${PAGE_FOOT}`;
  }

  function incidentHtml(id: number, now: number): string {
    const d = detail(id);
    const r = d.record;
    return `${PAGE_HEAD(`Fiche d'incident n°${r.id}`)}
<header class="bar"><h1>Fiche d'incident n°${r.id}</h1><button id="print" class="noprint" type="button">Imprimer / enregistrer en PDF</button></header>
<p class="meta">${esc(siteName())} — établie le ${esc(fmtDateTime(now))} (heure du serveur)</p>
<table class="kv"><tbody>
<tr><th>Détecteur</th><td>${esc(r.detectorId)} — ${esc(r.detectorName)} (${esc(CATEGORY_LABEL[r.category])})</td></tr>
<tr><th>Zone</th><td>${esc(r.zone || 'non renseignée')}</td></tr>
<tr><th>Ouvert le</th><td>${esc(fmtDateTime(r.openedAt))} — ${esc(SEVERITY[r.severity])}</td></tr>
<tr><th>Confirmation</th><td>${esc(confirmationText(r))}</td></tr>
<tr><th>Acquittement</th><td>${r.ackedAt === null ? 'Non acquitté' : `${esc(r.ackedBy)} le ${esc(fmtDateTime(r.ackedAt))} (délai : ${esc(fmtDuration(Math.round((r.ackedAt - r.openedAt) / 1000)))})`}</td></tr>
<tr><th>Clôture</th><td>${r.closedAt === null ? 'Non clôturé' : `${esc(r.closedBy)} le ${esc(fmtDateTime(r.closedAt))} — ${esc(qualificationText(r.category, r.qualification))}`}</td></tr>
<tr><th>Commentaire</th><td>${esc(r.comment ?? '')}</td></tr>
</tbody></table>
<h2>Chronologie</h2>
${d.timeline.length === 0 ? '<p class="empty">Aucune entrée de journal.</p>' : `<table><thead><tr><th>Heure</th><th>Auteur</th><th>Événement</th><th>Détails</th></tr></thead><tbody>${d.timeline.map((t) => `<tr><td>${esc(fmtDateTime(t.ts))}</td><td>${esc(t.actor)}</td><td>${esc(ACTION_TEXT[t.action] ?? t.action)}</td><td>${esc(detailsText(t.action, t.details, r.category))}</td></tr>`).join('')}</tbody></table>`}
<h2>Alertes envoyées</h2>
${d.notifications.length === 0 ? '<p class="empty">Aucune alerte envoyée pour cet incident.</p>' : `<table><thead><tr><th>Heure</th><th>Canal</th><th>Destinataire</th><th>Niveau</th><th>Résultat</th></tr></thead><tbody>${d.notifications.map((n) => `<tr><td>${esc(fmtDateTime(n.created_at as number))}</td><td>${esc(n.channel)}</td><td>${esc(n.recipient)}</td><td>${esc(n.level)}</td><td>${n.status === 'sent' ? 'envoyée' : 'ÉCHEC'} (${esc(n.attempts)} tentative${(n.attempts as number) > 1 ? 's' : ''})</td></tr>`).join('')}</tbody></table>`}
<h2>Images des caméras</h2>
${d.snapshotIds.length === 0 ? '<p class="empty">Aucune image enregistrée.</p>' : `<div class="shots">${d.snapshotIds.map((s) => `<figure><img src="/api/snapshots/${s.id}?t=${s.takenAt}" alt="Caméra ${esc(s.cameraId)}"><figcaption>${esc(s.cameraId)} — ${esc(fmtDateTime(s.takenAt))} (${esc(s.reason)})</figcaption></figure>`).join('')}</div>`}
<p class="foot">Document généré par le PSIM à partir de son journal.</p>
${PAGE_FOOT}`;
  }

  return { query, auditCsv, detail, reportHtml, incidentHtml, incidentsCsv: (range: Range) => incidentsCsv(query(range)) };
}

export type Reports = ReturnType<typeof createReports>;
