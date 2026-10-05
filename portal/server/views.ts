/**
 * Ce que le portail repond aux clients : des phrases et des chiffres en langage courant, jamais de vocabulaire technique
 * (pas de « MTBF », pas d'etat brut). Toutes les fonctions ici recoivent des sites DEJA filtres par accounts.ts.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { SiteSummary } from '../../server/portal.ts';
import type { VisibleSite } from './accounts.ts';

export const DAY_MS = 24 * 3_600_000;

export type Level = 'unknown' | 'unreachable' | 'alarm' | 'degraded' | 'ok';
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
  if (down.length > 0) {
    return { level: 'degraded', label: `${plural(down.length, 'équipement hors service', 'équipements hors service')}`, detail: `${down.slice(0, 3).map((d) => d.name).join(', ')}${down.length > 3 ? '…' : ''} : cette partie du site n'est pas protégée.` };
  }
  return { level: 'ok', label: 'Tout fonctionne', detail: 'Tous les équipements surveillés répondent.' };
}

const SEVERITY_ORDER: Record<Level, number> = { alarm: 0, unreachable: 1, degraded: 2, unknown: 3, ok: 4 };

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
      openIncidents: snap?.summary.incidents.filter((i) => i.status !== 'closed').length ?? 0,
      devicesDown: snap?.summary.devices.filter((d) => d.monitored && (d.status === 'fault' || d.status === 'offline')).length ?? 0,
    };
  });
  return cards.sort((a, b) => SEVERITY_ORDER[a.status.level] - SEVERITY_ORDER[b.status.level] || a.name.localeCompare(b.name, 'fr'));
}

/** Synthese de tous les sites visibles : le « coup d'oeil » du haut de page. */
export function overview(db: DatabaseSync, sites: VisibleSite[], now: number, staleAfterMs: number) {
  const cards = siteCards(db, sites, now, staleAfterMs);
  const counts: Record<Level, number> = { alarm: 0, unreachable: 0, degraded: 0, unknown: 0, ok: 0 };
  for (const c of cards) counts[c.status.level]++;
  const all = sites.flatMap((s) => lastDays(db, s.id, 30));
  const rows = sites.flatMap((s) => incidentRows(db, s.id, now - 30 * DAY_MS).filter((r) => r.opened_at >= now - 30 * DAY_MS || r.status !== 'closed'));
  return { sites: cards.length, counts, availability30: availabilityOfDays(all).pct, incidents30: incidentStats(rows.filter((r) => r.opened_at >= now - 30 * DAY_MS)), openNow: rows.filter((r) => r.status !== 'closed').length };
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
  };
}
