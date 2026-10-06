/**
 * Reception des resumes envoyes par les sites : authentification (signature HMAC du corps avec la cle derivee du site),
 * validation STRICTE du contenu (il vient d'un equipement distant : on ne garde que ce qu'on connait, borne en taille),
 * puis enregistrement. Le protocole (en-tetes, signature, ecart d'horloge) est celui de server/portal.ts, partage avec
 * l'emetteur pour que les deux cotes ne puissent pas diverger.
 */
import type { DatabaseSync } from 'node:sqlite';
import { MAX_SKEW_MS, PAYLOAD_VERSION, SIGNATURE_HEADER, SITE_HEADER, SITE_ID_PATTERN, TIME_HEADER, sign, signatureMatches } from '../../server/portal.ts';
import type { SiteSummary } from '../../server/portal.ts';
import { siteKey } from './keys.ts';

export type Headers = Record<string, string | string[] | undefined>;
export interface SiteRow {
  id: string;
  org_id: number;
  name: string;
  key_version: number;
  active: number;
  last_received_at: number | null;
}

export type Auth = { ok: true; site: SiteRow } | { ok: false; status: number; error: string };

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
// Meme message pour « site inconnu », « site desactive » et « signature fausse » : on ne revele pas quels sites existent.
const REFUSED = { ok: false, status: 401, error: 'refuse' } as const;

export function authenticateIngest(db: DatabaseSync, master: Buffer, headers: Headers, rawBody: string, now: number): Auth {
  const siteId = first(headers[SITE_HEADER]);
  const timestamp = Number(first(headers[TIME_HEADER]));
  const given = first(headers[SIGNATURE_HEADER]);
  if (!SITE_ID_PATTERN.test(siteId) || !Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/.test(given)) return REFUSED;
  // Rejeu : un envoi capture ne vaut que quelques minutes. Message precis (il n'apprend rien sur les sites) : un site dont
  // l'horloge derive doit savoir pourquoi il est refuse.
  if (Math.abs(now - timestamp) > MAX_SKEW_MS) return { ok: false, status: 401, error: "horloge : l'heure du serveur du site differe de plus de 10 minutes de celle du portail" };
  const site = db.prepare('SELECT id, org_id, name, key_version, active, last_received_at FROM site WHERE id = ?').get(siteId) as SiteRow | undefined;
  // Pour un site inconnu on calcule quand meme une signature : la duree de reponse ne distingue pas les deux cas.
  const expected = sign(siteKey(master, siteId, site?.key_version ?? 1), siteId, timestamp, rawBody);
  if (!signatureMatches(expected, given) || !site || site.active !== 1) return REFUSED;
  return { ok: true, site };
}

// ---------------------------------------------------------------- validation

class Invalid extends Error {}
const fail = (what: string): never => {
  throw new Invalid(what);
};

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(what);
  return v as Record<string, unknown>;
}
function arr(v: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) fail(`${what} (liste de ${max} elements au plus)`);
  return v as unknown[];
}
function str(v: unknown, what: string, max = 120): string {
  if (typeof v !== 'string' || v.length > max) fail(what);
  // Aucun caractere de controle : ces textes viennent d'un equipement distant et finissent dans une page et un export.
  if (/[\u0000-\u001f\u007f]/.test(v as string)) fail(`${what} (caractere interdit)`);
  return v as string;
}
function int(v: unknown, what: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(what);
  return v as number;
}
function intOrNull(v: unknown, what: string): number | null {
  return v === null || v === undefined ? null : int(v, what);
}
function pctOrNull(v: unknown, what: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) fail(what);
  return v as number;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) fail(what);
  return v as T;
}

const AVAIL = (v: unknown, what: string) => {
  const o = obj(v, what);
  return { upS: int(o.upS, `${what}.upS`), downS: int(o.downS, `${what}.downS`), unmonitoredS: int(o.unmonitoredS, `${what}.unmonitoredS`), pct: pctOrNull(o.pct, `${what}.pct`) };
};

const CATEGORIES = ['fire', 'intrusion', 'access', 'environment'] as const;
const STATES = ['normal', 'prealarm', 'alarm', 'fault', 'offline'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Indice GAMR : un entier de 1 a 60, ou `null` (zone ou site pas encore evalue). */
const riskIndex = (v: unknown, what: string): number | null => (v === null || v === undefined ? null : int(v, what, 1, 60));

function parseRisk(v: unknown): NonNullable<SiteSummary['risk']> {
  const x = obj(v, 'risk');
  return {
    index: riskIndex(x.index, 'risk.index'),
    worstZone: x.worstZone === null || x.worstZone === undefined ? null : str(x.worstZone, 'risk.worstZone'),
    assessedZones: int(x.assessedZones, 'risk.assessedZones', 0, 10_000),
    totalZones: int(x.totalZones, 'risk.totalZones', 0, 10_000),
    zones: arr(x.zones, 'risk.zones', 500).map((z, i) => {
      const y = obj(z, `risk.zones[${i}]`);
      return { zone: str(y.zone, 'risk.zone'), index: riskIndex(y.index, `risk.zones[${i}].index`), stale: y.stale === true };
    }),
    history: arr(x.history, 'risk.history', 400).map((p, i) => {
      const y = obj(p, `risk.history[${i}]`);
      const day = str(y.day, 'risk.history.day', 10);
      if (!DAY.test(day)) fail(`risk.history[${i}].day`);
      return { day, index: int(y.index, `risk.history[${i}].index`, 1, 60) };
    }),
  };
}

/** Valide un resume recu. Ne garde que les champs connus (rien d'autre n'est stocke ni renvoye aux clients). */
export function parseSummary(raw: unknown): { ok: true; summary: SiteSummary } | { ok: false; error: string } {
  try {
    const o = obj(raw, 'corps');
    if (o.v !== PAYLOAD_VERSION) fail(`version ${String(o.v)} non prise en charge (attendu : ${PAYLOAD_VERSION})`);
    const av = obj(o.availability, 'availability');
    const summary: SiteSummary = {
      v: PAYLOAD_VERSION,
      siteId: str(o.siteId, 'siteId', 40),
      siteName: str(o.siteName, 'siteName'),
      generatedAt: int(o.generatedAt, 'generatedAt'),
      utcOffsetMin: int(o.utcOffsetMin, 'utcOffsetMin', -840, 840),
      windowDays: int(o.windowDays, 'windowDays', 1, 400),
      psim: { version: str(obj(o.psim, 'psim').version, 'psim.version', 40), startedAt: int(obj(o.psim, 'psim').startedAt, 'psim.startedAt') },
      devices: arr(o.devices, 'devices', 2000).map((d, i) => {
        const x = obj(d, `devices[${i}]`);
        return {
          id: str(x.id, 'device.id', 32),
          name: str(x.name, 'device.name'),
          kind: oneOf(x.kind, ['detector', 'camera'] as const, 'device.kind'),
          category: oneOf(x.category, CATEGORIES, 'device.category'),
          zone: str(x.zone, 'device.zone'),
          floor: str(x.floor, 'device.floor'),
          status: oneOf(x.status, STATES, 'device.status'),
          since: intOrNull(x.since, 'device.since'),
          lastSeen: intOrNull(x.lastSeen, 'device.lastSeen'),
          monitored: x.monitored === true,
        };
      }),
      availability: {
        from: int(av.from, 'availability.from'),
        to: int(av.to, 'availability.to'),
        overall: AVAIL(av.overall, 'availability.overall'),
        byZone: arr(av.byZone, 'byZone', 500).map((z, i) => ({ zone: str(obj(z, 'byZone').zone, 'zone'), devices: int(obj(z, 'byZone').devices, `byZone[${i}].devices`), ...AVAIL(z, `byZone[${i}]`) })),
        byDevice: arr(av.byDevice, 'byDevice', 2000).map((d, i) => ({
          deviceId: str(obj(d, 'byDevice').deviceId, 'deviceId', 32),
          outages: int(obj(d, 'byDevice').outages, `byDevice[${i}].outages`),
          longestOutageS: int(obj(d, 'byDevice').longestOutageS, `byDevice[${i}].longestOutageS`),
          ...AVAIL(d, `byDevice[${i}]`),
        })),
        daily: arr(av.daily, 'daily', 400).map((d, i) => {
          const x = obj(d, `daily[${i}]`);
          const day = str(x.day, 'daily.day', 10);
          if (!DAY.test(day)) fail(`daily[${i}].day`);
          return { day, pct: pctOrNull(x.pct, 'daily.pct'), upS: int(x.upS, 'daily.upS'), downS: int(x.downS, 'daily.downS'), unmonitoredS: int(x.unmonitoredS, 'daily.unmonitoredS') };
        }),
      },
      outages: arr(o.outages, 'outages', 1000).map((d, i) => {
        const x = obj(d, `outages[${i}]`);
        return { deviceId: str(x.deviceId, 'outage.deviceId', 32), from: int(x.from, 'outage.from'), to: intOrNull(x.to, 'outage.to'), durationS: int(x.durationS, 'outage.durationS'), cause: oneOf(x.cause, ['fault', 'offline'] as const, 'outage.cause') };
      }),
      blindPeriods: arr(o.blindPeriods, 'blindPeriods', 1000).map((d, i) => {
        const x = obj(d, `blindPeriods[${i}]`);
        return { from: int(x.from, 'blind.from'), to: int(x.to, 'blind.to'), clean: x.clean === true };
      }),
      incidents: arr(o.incidents, 'incidents', 2000).map((d, i) => {
        const x = obj(d, `incidents[${i}]`);
        return {
          id: int(x.id, 'incident.id', 1),
          deviceId: str(x.deviceId, 'incident.deviceId', 32),
          deviceName: str(x.deviceName, 'incident.deviceName'),
          zone: str(x.zone, 'incident.zone'),
          category: oneOf(x.category, CATEGORIES, 'incident.category'),
          severity: oneOf(x.severity, ['warning', 'critical'] as const, 'incident.severity'),
          status: oneOf(x.status, ['open', 'acknowledged', 'closed'] as const, 'incident.status'),
          qualification: x.qualification === null || x.qualification === undefined ? null : oneOf(x.qualification, ['fire', 'false_alarm'] as const, 'incident.qualification'),
          openedAt: int(x.openedAt, 'incident.openedAt'),
          ackedAt: intOrNull(x.ackedAt, 'incident.ackedAt'),
          closedAt: intOrNull(x.closedAt, 'incident.closedAt'),
          confirmedAt: intOrNull(x.confirmedAt, 'incident.confirmedAt'),
        };
      }),
      notifications: { sent: int(obj(o.notifications, 'notifications').sent, 'notifications.sent'), failed: int(obj(o.notifications, 'notifications').failed, 'notifications.failed') },
      // Facultatif : un PSIM plus ancien n'envoie pas d'indice, son resume reste valable.
      risk: o.risk === undefined || o.risk === null ? undefined : parseRisk(o.risk),
    };
    return { ok: true, summary };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: `resume invalide : ${err.message}` };
    throw err;
  }
}

// ---------------------------------------------------------------- enregistrement

/**
 * Remplace l'instantane du site et met a jour l'historique, en une seule transaction. Un instantane PLUS ANCIEN que celui
 * deja recu (envoi rejoue, retardataire) est ignore : il ne doit jamais faire revenir l'etat en arriere.
 */
export function storeSummary(db: DatabaseSync, siteId: string, s: SiteSummary, receivedAt: number): 'stored' | 'older' {
  const current = db.prepare('SELECT generated_at FROM snapshot WHERE site_id = ?').get(siteId) as { generated_at: number } | undefined;
  if (current && s.generatedAt < current.generated_at) return 'older';
  const names = new Map(s.devices.map((d) => [d.id, { name: d.name, zone: d.zone }]));
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO snapshot (site_id, generated_at, received_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET generated_at = excluded.generated_at, received_at = excluded.received_at, payload = excluded.payload').run(
      siteId,
      s.generatedAt,
      receivedAt,
      JSON.stringify(s),
    );
    const day = db.prepare('INSERT INTO site_day (site_id, day, pct, up_s, down_s, unmonitored_s) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(site_id, day) DO UPDATE SET pct = excluded.pct, up_s = excluded.up_s, down_s = excluded.down_s, unmonitored_s = excluded.unmonitored_s');
    for (const d of s.availability.daily) day.run(siteId, d.day, d.pct, d.upS, d.downS, d.unmonitoredS);
    const outage = db.prepare('INSERT INTO outage (site_id, device_id, device_name, zone, from_ts, to_ts, duration_s, cause) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(site_id, device_id, from_ts) DO UPDATE SET to_ts = excluded.to_ts, duration_s = excluded.duration_s, cause = excluded.cause, device_name = excluded.device_name, zone = excluded.zone');
    for (const o of s.outages) outage.run(siteId, o.deviceId, names.get(o.deviceId)?.name ?? o.deviceId, names.get(o.deviceId)?.zone ?? '', o.from, o.to, o.durationS, o.cause);
    const incident = db.prepare(
      `INSERT INTO incident (site_id, id, device_id, device_name, zone, category, severity, status, qualification, opened_at, acked_at, closed_at, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_id, id) DO UPDATE SET device_name = excluded.device_name, zone = excluded.zone, category = excluded.category, severity = excluded.severity, status = excluded.status,
         qualification = excluded.qualification, acked_at = excluded.acked_at, closed_at = excluded.closed_at, confirmed_at = excluded.confirmed_at`,
    );
    for (const i of s.incidents) incident.run(siteId, i.id, i.deviceId, i.deviceName, i.zone, i.category, i.severity, i.status, i.qualification, i.openedAt, i.ackedAt, i.closedAt, i.confirmedAt);
    const riskDay = db.prepare('INSERT INTO site_risk_day (site_id, day, idx) VALUES (?, ?, ?) ON CONFLICT(site_id, day) DO UPDATE SET idx = excluded.idx');
    for (const p of s.risk?.history ?? []) riskDay.run(siteId, p.day, p.index);
    db.prepare('UPDATE site SET last_received_at = ? WHERE id = ?').run(receivedAt, siteId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return 'stored';
}
