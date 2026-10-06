/**
 * Ce que le portail repond aux clients : des phrases et des chiffres en langage courant, jamais de vocabulaire technique
 * (pas de « MTBF », pas d'etat brut). Toutes les fonctions ici recoivent des sites DEJA filtres par accounts.ts.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { SiteSummary } from '../../server/portal.ts';
import { levelOf } from '../../server/risklevels.ts';
import type { RiskLevel } from '../../server/risklevels.ts';
import type { VisibleSite } from './accounts.ts';

export const DAY_MS = 24 * 3_600_000;

export type Level = 'unknown' | 'unreachable' | 'alarm' | 'degraded' | 'recent' | 'ok';
export interface Status {
  level: Level;
  label: string;
  detail: string;
}

/** « 12 min », « 3 h », « 2 jours » : une duree lisible, arrondie. */
export function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "moins d'une minute";
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} jours`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/**
 * L'etat d'un site en une phrase. « Injoignable » prime : si le portail n'entend plus le site, tout ce qu'il sait est
 * ancien, et il le dit (y compris la derniere alarme connue, qui peut etre toujours en cours).
 */
/** Fenetre pendant laquelle un incident traite reste annonce en tete de page : « tout fonctionne » serait trompeur. */
export const RECENT_INCIDENT_MS = 24 * 3_600_000;

const INCIDENT_WORD: Record<string, string> = { intrusion: 'Intrusion', fire: 'Alarme incendie', access: 'Alerte contrôle d’accès', environment: 'Alerte environnement' };
const pad2 = (n: number) => String(n).padStart(2, '0');

/** « aujourd'hui à 05:32 », « hier à 23:10 » ou « le 4/10 à 18:00 », a l'heure LOCALE du site. */
function whenLocal(t: number, now: number, offsetMin: number): string {
  const local = new Date(t + offsetMin * 60_000);
  const today = new Date(now + offsetMin * 60_000);
  const day = (d: Date) => Math.floor(d.getTime() / 86_400_000);
  const hm = `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`;
  const gap = day(today) - day(local);
  if (gap === 0) return `aujourd’hui à ${hm}`;
  if (gap === 1) return `hier à ${hm}`;
  return `le ${local.getUTCDate()}/${local.getUTCMonth() + 1} à ${hm}`;
}

/**
 * Incidents REELS (ou pas encore qualifies) clos dans les dernieres 24 h, du plus recent au plus ancien. Une fausse alarme
 * n'en fait pas partie : rien ne s'est passe sur le site.
 */
function recentIncidents(summary: SiteSummary, now: number) {
  return summary.incidents
    .filter((i) => i.status === 'closed' && i.qualification !== 'false_alarm' && now - (i.closedAt ?? i.openedAt) <= RECENT_INCIDENT_MS)
    .sort((a, b) => b.openedAt - a.openedAt);
}

/** Une phrase sur le dernier incident traite : quoi, ou, quand, prise en charge et cloture. */
function recentSentence(summary: SiteSummary, now: number): { title: string; detail: string } | null {
  const list = recentIncidents(summary, now);
  if (list.length === 0) return null;
  const last = list[0];
  const word = INCIDENT_WORD[last.category] ?? 'Alerte';
  const off = summary.utcOffsetMin ?? 0;
  const care = last.ackedAt !== null ? `prise en charge en ${ago(last.ackedAt - last.openedAt).replace("moins d'une minute", 'moins d’une minute')}` : 'clôturée sans prise en charge notée';
  const closed = last.closedAt !== null ? `, clôturée ${whenLocal(last.closedAt, now, off).replace(/^aujourd’hui /, '')}` : '';
  const others = list.length > 1 ? ` ${plural(list.length - 1, 'autre incident', 'autres incidents')} dans les dernières 24 h.` : '';
  return {
    title: `${word} ${whenLocal(last.openedAt, now, off)}`,
    detail: `${last.deviceName}${last.zone ? ` (${last.zone})` : ''} : ${care}${closed}.${others}`,
  };
}

export function siteStatus(summary: SiteSummary | null, receivedAt: number | null, now: number, staleAfterMs: number): Status {
  if (!summary || receivedAt === null) return { level: 'unknown', label: 'En attente de données', detail: "Ce site n'a encore rien envoyé au portail." };
  const open = summary.incidents.filter((i) => i.status !== 'closed');
  const down = summary.devices.filter((d) => d.monitored && (d.status === 'fault' || d.status === 'offline'));
  const silence = now - receivedAt;
  if (silence > staleAfterMs) {
    const known = open.length > 0 ? ` Dernier état connu : ${plural(open.length, 'incident en cours', 'incidents en cours')}.` : '';
    return { level: 'unreachable', label: 'Site injoignable', detail: `Aucun signal depuis ${ago(silence)}.${known}` };
  }
  // Rien n'est mesure (pas de detecteur, cameras simulees ou pas encore testees) : rien ne permet de dire que « tout fonctionne ».
  if (!summary.devices.some((d) => d.monitored)) {
    return { level: 'unknown', label: 'Aucun équipement suivi', detail: "L'état des équipements de ce site n'est pas encore mesuré : rien ne permet de dire qu'ils fonctionnent." };
  }
  if (open.length > 0) {
    const critical = open.some((i) => i.severity === 'critical');
    return { level: 'alarm', label: critical ? 'Alarme en cours' : 'Alerte en cours', detail: `${plural(open.length, 'incident ouvert', 'incidents ouverts')} : ${[...new Set(open.map((i) => i.zone || i.deviceName))].slice(0, 3).join(', ')}.` };
  }
  const recent = recentSentence(summary, now);
  if (down.length > 0) {
    const also = recent ? ` Dernier incident : ${recent.title.charAt(0).toLowerCase()}${recent.title.slice(1)}.` : '';
    return { level: 'degraded', label: `${plural(down.length, 'équipement hors service', 'équipements hors service')}`, detail: `${down.slice(0, 3).map((d) => d.name).join(', ')}${down.length > 3 ? '…' : ''} : cette partie du site n'est pas protégée.${also}` };
  }
  // Un incident vient d'avoir lieu : meme traite, il est annonce en tete (24 h), avant « tout fonctionne ».
  if (recent) return { level: 'recent', label: recent.title, detail: `${recent.detail} Les équipements fonctionnent.` };
  return { level: 'ok', label: 'Tout fonctionne', detail: 'Tous les équipements surveillés répondent.' };
}

const SEVERITY_ORDER: Record<Level, number> = { alarm: 0, unreachable: 1, degraded: 2, recent: 3, unknown: 4, ok: 5 };

export interface RiskView {
  /** Indice de securite GAMR du site (1 a 60), `null` tant qu'aucune zone n'est evaluee. */
  index: number | null;
  level: RiskLevel | null;
  levelLabel: string | null;
  worstZone: string | null;
  assessedZones: number;
  totalZones: number;
  /** Date du calcul (celle du dernier resume) : un site injoignable garde son dernier indice connu, date. */
  at: number;
}

/** L'indice tel que le site l'a envoye, nomme ici (Faible, Modere...) ; `null` s'il n'est pas transmis : rien d'invente. */
export function riskOf(summary: SiteSummary | null | undefined): RiskView | null {
  const r = summary?.risk;
  if (!summary || !r) return null;
  const named = r.index === null ? null : levelOf(r.index);
  return { index: r.index, level: named?.level ?? null, levelLabel: named?.label ?? null, worstZone: r.worstZone, assessedZones: r.assessedZones, totalZones: r.totalZones, at: summary.generatedAt };
}

/** Les N derniers jours d'indice connus du site (le plus ancien d'abord). */
export function lastRiskDays(db: DatabaseSync, siteId: string, days: number): { day: string; index: number }[] {
  return (db.prepare('SELECT day, idx FROM site_risk_day WHERE site_id = ? ORDER BY day DESC LIMIT ?').all(siteId, days) as { day: string; idx: number }[]).reverse().map((r) => ({ day: r.day, index: r.idx }));
}

export function loadSummary(db: DatabaseSync, siteId: string): { summary: SiteSummary; receivedAt: number } | null {
  const row = db.prepare('SELECT payload, received_at FROM snapshot WHERE site_id = ?').get(siteId) as { payload: string; received_at: number } | undefined;
  return row ? { summary: JSON.parse(row.payload) as SiteSummary, receivedAt: row.received_at } : null;
}

export interface DayRow {
  day: string;
  pct: number | null;
  up_s: number;
  down_s: number;
  unmonitored_s: number;
}

/** Les N derniers jours connus du site (un jour manquant n'est pas invente). */
export function lastDays(db: DatabaseSync, siteId: string, days: number): DayRow[] {
  return (db.prepare('SELECT day, pct, up_s, down_s, unmonitored_s FROM site_day WHERE site_id = ? ORDER BY day DESC LIMIT ?').all(siteId, days) as unknown as DayRow[]).reverse();
}

/** Disponibilite d'un ensemble de jours : moyenne PONDEREE par le temps observe (un jour court pese moins qu'un jour entier). */
export function availabilityOfDays(rows: DayRow[]): { pct: number | null; upS: number; downS: number; unmonitoredS: number } {
  const up = rows.reduce((s, r) => s + r.up_s, 0);
  const down = rows.reduce((s, r) => s + r.down_s, 0);
  return { pct: up + down > 0 ? Math.round((up / (up + down)) * 10_000) / 100 : null, upS: up, downS: down, unmonitoredS: rows.reduce((s, r) => s + r.unmonitored_s, 0) };
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

export interface IncidentStats {
  total: number;
  open: number;
  real: number;
  falseAlarms: number;
  /** Delais en secondes, `null` s'il n'y a rien a mesurer. */
  ackMedianS: number | null;
  closeMedianS: number | null;
}

export function incidentStats(rows: { status: string; qualification: string | null; opened_at: number; acked_at: number | null; closed_at: number | null }[]): IncidentStats {
  return {
    total: rows.length,
    open: rows.filter((r) => r.status !== 'closed').length,
    real: rows.filter((r) => r.qualification === 'fire').length,
    falseAlarms: rows.filter((r) => r.qualification === 'false_alarm').length,
    ackMedianS: median(rows.filter((r) => r.acked_at !== null).map((r) => Math.round((r.acked_at! - r.opened_at) / 1000))),
    closeMedianS: median(rows.filter((r) => r.closed_at !== null).map((r) => Math.round((r.closed_at! - r.opened_at) / 1000))),
  };
}

function incidentRows(db: DatabaseSync, siteId: string, since: number) {
  return db
    .prepare('SELECT id, device_id, device_name, zone, category, severity, status, qualification, opened_at, acked_at, closed_at FROM incident WHERE site_id = ? AND (opened_at >= ? OR status <> \'closed\') ORDER BY opened_at DESC')
    .all(siteId, since) as { id: number; device_id: string; device_name: string; zone: string; category: string; severity: string; status: string; qualification: string | null; opened_at: number; acked_at: number | null; closed_at: number | null }[];
}

/** Une ligne par site : de quoi choisir ou regarder en premier. Les sites a probleme en tete. */
export function siteCards(db: DatabaseSync, sites: VisibleSite[], now: number, staleAfterMs: number) {
  const cards = sites.map((s) => {
    const snap = loadSummary(db, s.id);
    const status = siteStatus(snap?.summary ?? null, snap?.receivedAt ?? null, now, staleAfterMs);
    const month = availabilityOfDays(lastDays(db, s.id, 30));
    return {
      id: s.id,
      name: s.name,
      organization: s.org_name,
      status,
      lastReceivedAt: snap?.receivedAt ?? null,
      availability30: month.pct,
      availability30DownS: month.downS,
      openIncidents: snap?.summary.incidents.filter((i) => i.status !== 'closed').length ?? 0,
      devicesDown: snap?.summary.devices.filter((d) => d.monitored && (d.status === 'fault' || d.status === 'offline')).length ?? 0,
      risk: riskOf(snap?.summary),
    };
  });
  return cards.sort((a, b) => SEVERITY_ORDER[a.status.level] - SEVERITY_ORDER[b.status.level] || a.name.localeCompare(b.name, 'fr'));
}

/** Synthese de tous les sites visibles : le « coup d'oeil » du haut de page. */
export function overview(db: DatabaseSync, sites: VisibleSite[], now: number, staleAfterMs: number) {
  const cards = siteCards(db, sites, now, staleAfterMs);
  const counts: Record<Level, number> = { alarm: 0, unreachable: 0, degraded: 0, recent: 0, unknown: 0, ok: 0 };
  for (const c of cards) counts[c.status.level]++;
  const all = sites.flatMap((s) => lastDays(db, s.id, 30));
  const rows = sites.flatMap((s) => incidentRows(db, s.id, now - 30 * DAY_MS).filter((r) => r.opened_at >= now - 30 * DAY_MS || r.status !== 'closed'));
  // Le site le plus expose : celui dont l'indice GAMR est le plus haut, parmi ceux qui en ont un.
  const scored = cards.filter((c) => c.risk?.index != null);
  const worst = scored.reduce<(typeof cards)[number] | null>((w, c) => (w === null || c.risk!.index! > w.risk!.index! ? c : w), null);
  return {
    sites: cards.length,
    counts,
    availability30: availabilityOfDays(all).pct,
    availability30DownS: availabilityOfDays(all).downS,
    incidents30: incidentStats(rows.filter((r) => r.opened_at >= now - 30 * DAY_MS)),
    openNow: rows.filter((r) => r.status !== 'closed').length,
    risk: { scoredSites: scored.length, worst: worst ? { siteId: worst.id, siteName: worst.name, ...worst.risk! } : null },
  };
}

export const RANGES = [7, 30, 90] as const;

/** Le detail d'un site sur 7, 30 ou 90 jours. */
export function siteDetail(db: DatabaseSync, site: VisibleSite, days: number, now: number, staleAfterMs: number) {
  const snap = loadSummary(db, site.id);
  const status = siteStatus(snap?.summary ?? null, snap?.receivedAt ?? null, now, staleAfterMs);
  const daily = lastDays(db, site.id, days);
  const since = now - days * DAY_MS;
  const incidents = incidentRows(db, site.id, since);
  const outages = db.prepare('SELECT device_id, device_name, zone, from_ts, to_ts, duration_s, cause FROM outage WHERE site_id = ? AND (from_ts >= ? OR to_ts IS NULL OR to_ts >= ?) ORDER BY from_ts DESC LIMIT 200').all(site.id, since, since) as { device_id: string; device_name: string; zone: string; from_ts: number; to_ts: number | null; duration_s: number; cause: string }[];
  const s = snap?.summary;
  return {
    site: { id: site.id, name: site.name, organization: site.org_name },
    status,
    lastReceivedAt: snap?.receivedAt ?? null,
    days,
    availability: availabilityOfDays(daily),
    daily: daily.map((d) => ({ day: d.day, pct: d.pct, downS: d.down_s, unmonitoredS: d.unmonitored_s })),
    devices: s?.devices ?? [],
    // Par zone et par equipement : fenetre de l'instantane (35 jours), pas la plage choisie.
    zones: s?.availability.byZone ?? [],
    deviceAvailability: s?.availability.byDevice ?? [],
    outages: outages.map((o) => ({ deviceId: o.device_id, deviceName: o.device_name, zone: o.zone, from: o.from_ts, to: o.to_ts, durationS: o.duration_s, cause: o.cause })),
    incidents: incidents.map((i) => ({ id: i.id, deviceName: i.device_name, zone: i.zone, category: i.category, severity: i.severity, status: i.status, qualification: i.qualification, openedAt: i.opened_at, ackedAt: i.acked_at, closedAt: i.closed_at })),
    incidentStats: incidentStats(incidents.filter((i) => i.opened_at >= since)),
    blindPeriods: s?.blindPeriods ?? [],
    notifications: s?.notifications ?? null,
    utcOffsetMin: s?.utcOffsetMin ?? 0,
    risk: riskOf(s),
    // Les zones les plus exposees d'abord ; une zone non evaluee le dit (pas de note supposee).
    riskZones: (s?.risk?.zones ?? [])
      .map((z) => ({ zone: z.zone, index: z.index, stale: z.stale, ...(z.index === null ? { level: null, levelLabel: null } : { level: levelOf(z.index).level, levelLabel: levelOf(z.index).label }) }))
      .sort((a, b) => (b.index ?? -1) - (a.index ?? -1) || a.zone.localeCompare(b.zone, 'fr')),
    riskHistory: lastRiskDays(db, site.id, days),
  };
}
