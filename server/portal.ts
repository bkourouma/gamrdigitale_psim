/**
 * Envoi d'un resume du site vers le portail de suivi a distance.
 *
 * Principe : c'est le SITE qui appelle le portail (sortant, comme le signal de supervision externe) ; rien n'est ouvert
 * sur le reseau du client. Chaque envoi est un INSTANTANE COMPLET des N derniers jours, pas un flux d'evenements :
 *  - un envoi manque (coupure internet) ne perd rien, le suivant contient tout ;
 *  - rejouer un envoi est sans effet (le portail remplace ce qu'il a pour ces jours-la) ;
 *  - aucune file d'attente a gerer, aucun ordre a respecter.
 * Le portail conserve, lui, les jours qui sortent de la fenetre : c'est lui qui garde l'historique long.
 *
 * Ce qui part (jamais plus) : equipements (nom, zone, etage, etat), disponibilite et periodes d'arret, incidents sans
 * leurs commentaires ni les noms des operateurs, nombre de notifications, indice de securite GAMR (du site et par zone,
 * sans les notes ni le nom de l'evaluateur). Jamais : identifiants ou adresses des cameras, images, comptes, journal,
 * destinataires de notification.
 *
 * Authentification : signature HMAC-SHA256 du corps avec une cle propre a ce site (en-tetes X-Psim-*). La cle ne circule
 * jamais ; l'horodatage signe limite le rejeu. Un echec d'envoi ne gene jamais le PSIM : il est compte et reessaye.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { availabilityOf, blindPeriods, combine, loadIntervals, outagesOf } from './history.ts';
import type { Availability, BlindPeriod, Outage } from './history.ts';

export const PAYLOAD_VERSION = 1;
export const DAY_MS = 24 * 3_600_000;
const MAX_OUTAGES = 300;
const MAX_INCIDENTS = 500;

export interface SiteSummary {
  v: typeof PAYLOAD_VERSION;
  siteId: string;
  siteName: string;
  generatedAt: number;
  /** Decalage de l'heure locale du site par rapport a UTC, en minutes : les « jours » ci-dessous sont des jours locaux. */
  utcOffsetMin: number;
  windowDays: number;
  psim: { version: string; startedAt: number };
  devices: {
    id: string;
    name: string;
    kind: 'detector' | 'camera';
    category: string;
    zone: string;
    floor: string;
    status: string;
    since: number | null;
    lastSeen: number | null;
    /**
     * `false` : le PSIM ne mesure pas la sante de cet equipement (camera simulee, ou camera reelle pas encore testee) ;
     * aucun pourcentage n'est donne. Pour une camera mesuree, l'etat dit si l'APPAREIL repond, pas si l'image est bonne.
     */
    monitored: boolean;
  }[];
  availability: {
    from: number;
    to: number;
    overall: Availability;
    byZone: (Availability & { zone: string; devices: number })[];
    byDevice: (Availability & { deviceId: string; outages: number; longestOutageS: number })[];
    daily: { day: string; pct: number | null; upS: number; downS: number; unmonitoredS: number }[];
  };
  outages: Outage[];
  blindPeriods: BlindPeriod[];
  incidents: {
    id: number;
    deviceId: string;
    deviceName: string;
    zone: string;
    category: string;
    severity: string;
    status: string;
    qualification: string | null;
    openedAt: number;
    ackedAt: number | null;
    closedAt: number | null;
    confirmedAt: number | null;
  }[];
  notifications: { sent: number; failed: number };
  /**
   * Indice de securite GAMR (1 a 60 : probabilite x vulnerabilite x repercussions). Absent quand le PSIM ne le fournit
   * pas (version plus ancienne, calcul en echec) : le portail dit alors qu'il n'est pas transmis, sans rien inventer.
   */
  risk?: {
    /** Indice du site : celui de sa zone la plus exposee ; `null` tant qu'aucune zone n'est evaluee. */
    index: number | null;
    worstZone: string | null;
    assessedZones: number;
    totalZones: number;
    /** `index` vaut `null` pour une zone non evaluee ; `stale` : evaluation de plus d'un an, a revoir. */
    zones: { zone: string; index: number | null; stale: boolean }[];
    /** Indice du site, un point par jour local (le plus ancien d'abord). */
    history: { day: string; index: number }[];
  };
}

/** Ce que la gestion des risques fournit (voir risk.ts, `overview`) ; seule une partie en est envoyee. */
export interface RiskInput {
  site: { index: number | null; worstZone: string | null; assessedZones: number; totalZones: number };
  zones: { zone: string; index: number | null; stale: boolean }[];
  history: Record<string, { day: string; index: number }[]>;
}

export interface SummaryOptions {
  siteId: string;
  version: string;
  startedAt: number;
  now?: number;
  windowDays?: number;
  /** Etat du risque au moment de l'envoi ; sans lui, le resume part sans indice. */
  risk?: () => RiskInput;
}

const MAX_RISK_ZONES = 200;

function riskPart(build: (() => RiskInput) | undefined, fromDay: string): SiteSummary['risk'] {
  if (!build) return undefined;
  try {
    const r = build();
    return {
      index: r.site.index,
      worstZone: r.site.worstZone,
      assessedZones: r.site.assessedZones,
      totalZones: r.site.totalZones,
      zones: r.zones.slice(0, MAX_RISK_ZONES).map((z) => ({ zone: z.zone, index: z.index, stale: z.stale })),
      history: (r.history.__site__ ?? []).filter((p) => p.day >= fromDay),
    };
  } catch {
    // Un calcul de risque en echec ne doit jamais empecher l'envoi de l'etat du site : le resume part sans indice.
    return undefined;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function buildSiteSummary(db: DatabaseSync, options: SummaryOptions): SiteSummary {
  const now = options.now ?? Date.now();
  const windowDays = options.windowDays ?? 35;
  const from = now - windowDays * DAY_MS;

  const siteName = (db.prepare('SELECT name FROM site WHERE id = 1').get() as { name: string } | undefined)?.name ?? 'Site';
  const floors = new Map((db.prepare('SELECT id, name FROM floor').all() as { id: number; name: string }[]).map((f) => [f.id, f.name]));
  const rows = db.prepare('SELECT * FROM device ORDER BY kind, id').all() as Record<string, unknown>[];
  // L'etat d'une camera reelle est son etat MESURE (historique), pas `device.status` que la mesure ne modifie pas.
  const measuredCameras = new Map(
    (
      db
        .prepare("SELECT h.device_id, h.state, h.started_at FROM device_state_history h JOIN camera_source c ON c.device_id = h.device_id WHERE h.ended_at IS NULL")
        .all() as { device_id: string; state: string; started_at: number }[]
    ).map((r) => [r.device_id, r]),
  );
  const devices = rows.map((r) => {
    const cam = r.kind === 'camera' ? measuredCameras.get(r.id as string) : undefined;
    return {
      id: r.id as string,
      name: r.name as string,
      kind: r.kind as 'detector' | 'camera',
      category: ((r.category as string | null) ?? 'fire'),
      zone: r.zone as string,
      floor: floors.get(r.floor_id as number) ?? '',
      status: cam ? cam.state : (r.status as string),
      since: cam ? cam.started_at : ((r.state_since as number | null) ?? null),
      lastSeen: (r.last_seen as number | null) ?? null,
      monitored: r.kind === 'detector' || cam !== undefined,
    };
  });

  const intervals = loadIntervals(db, from, now, now);
  const measured = devices.filter((d) => d.monitored); // detecteurs et cameras reelles mesurees

  const perDevice = new Map<string, Availability>();
  const outages: Outage[] = [];
  const byDevice = measured.map((d) => {
    const list = intervals.get(d.id) ?? [];
    const a = availabilityOf(list, from, now, now);
    perDevice.set(d.id, a);
    const o = outagesOf(d.id, list, now, now);
    outages.push(...o);
    return { deviceId: d.id, ...a, outages: o.length, longestOutageS: o.reduce((m, x) => Math.max(m, x.durationS), 0) };
  });

  const zones = new Map<string, string[]>();
  for (const d of measured) zones.set(d.zone, [...(zones.get(d.zone) ?? []), d.id]);
  const byZone = [...zones.entries()].map(([zone, ids]) => ({ zone, devices: ids.length, ...combine(ids.map((id) => perDevice.get(id)!)) }));

  // Un point par jour LOCAL ; le jour en cours s'arrete a maintenant.
  const daily: SiteSummary['availability']['daily'] = [];
  const today = new Date(now);
  for (let i = windowDays - 1; i >= 0; i--) {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    const s = Math.max(start.getTime(), from);
    const e = Math.min(end.getTime(), now);
    if (e <= s) continue;
    const c = combine(measured.map((d) => availabilityOf(intervals.get(d.id) ?? [], s, e, now)));
    daily.push({ day: dayKey(start), pct: c.pct, upS: c.upS, downS: c.downS, unmonitoredS: c.unmonitoredS });
  }

  const incidents = (
    db
      .prepare(
        `SELECT i.id, i.detector_id, d.name, d.zone, d.category, i.severity, i.status, i.qualification, i.opened_at, i.acked_at, i.closed_at, i.confirmed_at
         FROM incident i JOIN device d ON d.id = i.detector_id
         WHERE i.opened_at >= ? OR i.status <> 'closed' ORDER BY i.opened_at DESC LIMIT ?`,
      )
      .all(from, MAX_INCIDENTS) as Record<string, unknown>[]
  ).map((r) => ({
    id: r.id as number,
    deviceId: r.detector_id as string,
    deviceName: r.name as string,
    zone: r.zone as string,
    category: (r.category as string | null) ?? 'fire',
    severity: r.severity as string,
    status: r.status as string,
    qualification: (r.qualification as string | null) ?? null,
    openedAt: r.opened_at as number,
    ackedAt: (r.acked_at as number | null) ?? null,
    closedAt: (r.closed_at as number | null) ?? null,
    confirmedAt: (r.confirmed_at as number | null) ?? null,
  }));

  const notif = (status: string) =>
    (db.prepare("SELECT COUNT(*) AS n FROM notification_log WHERE channel <> 'round' AND status = ? AND created_at >= ?").get(status, from) as { n: number }).n;

  return {
    v: PAYLOAD_VERSION,
    siteId: options.siteId,
    siteName,
    generatedAt: now,
    utcOffsetMin: -new Date(now).getTimezoneOffset(),
    windowDays,
    psim: { version: options.version, startedAt: options.startedAt },
    devices,
    availability: { from, to: now, overall: combine([...perDevice.values()]), byZone, byDevice, daily },
    outages: outages.sort((a, b) => b.from - a.from).slice(0, MAX_OUTAGES),
    blindPeriods: blindPeriods(db, from, now),
    incidents,
    notifications: { sent: notif('sent'), failed: notif('failed') },
    risk: riskPart(options.risk, dayKey(new Date(from))),
  };
}

// ---------------------------------------------------------------- signature

export const SITE_HEADER = 'x-psim-site';
export const TIME_HEADER = 'x-psim-timestamp';
export const SIGNATURE_HEADER = 'x-psim-signature';
/** Une cle plus courte se devine : refusee des la configuration. */
export const MIN_KEY_LENGTH = 32;
/** Ecart d'horloge tolere entre le site et le portail : au-dela, l'envoi est refuse (rejeu). */
export const MAX_SKEW_MS = 10 * 60_000;

export function sign(key: string, siteId: string, timestamp: number, body: string): string {
  return createHmac('sha256', key).update(`${siteId}.${timestamp}.${body}`).digest('hex');
}

/** Comparaison a duree constante. */
export function signatureMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** https obligatoire, sauf vers cette machine (essais). Pas d'identifiants dans l'adresse. */
export function validatePortalUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.username || u.password) return "ne doit pas contenir d'identifiants";
    if (u.protocol === 'https:') return null;
    if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return null;
    return 'doit commencer par https:// (http:// n\'est accepte que vers cette machine)';
  } catch {
    return 'adresse invalide';
  }
}

// ---------------------------------------------------------------- envoi

export interface PortalStatus {
  configured: boolean;
  host: string | null;
  everyS: number;
  lastOkAt: number | null;
  lastFailAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  sent: number;
}

export interface PortalSenderOptions {
  url: string;
  siteId: string;
  key: string;
  everyMs: number;
  build: () => SiteSummary;
  timeoutMs?: number;
  now?: () => number;
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' }) => Promise<{ ok: boolean; status: number }>;
  /** Premier echec apres des succes, ou reprise : jamais a chaque tentative. */
  onChange?: (state: 'failing' | 'recovered', status: PortalStatus) => void;
}

export function createPortalSender(options: PortalSenderOptions) {
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const configured = options.url !== '' && options.everyMs > 0 && validatePortalUrl(options.url) === null && SITE_ID_PATTERN.test(options.siteId) && options.key.length >= MIN_KEY_LENGTH;
  let host: string | null = null;
  try {
    host = configured ? new URL(options.url).host : null;
  } catch {
    host = null;
  }
  const state: PortalStatus = { configured, host, everyS: Math.round(options.everyMs / 1000), lastOkAt: null, lastFailAt: null, lastError: null, consecutiveFailures: 0, sent: 0 };
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;

  /** Une tentative. Ne leve jamais d'exception. */
  async function push(): Promise<boolean> {
    if (!configured || inFlight) return false;
    inFlight = true;
    const wasFailing = state.consecutiveFailures > 0;
    let ok = false;
    let error = '';
    try {
      const body = JSON.stringify(options.build());
      const t = now();
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(options.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [SITE_HEADER]: options.siteId,
            [TIME_HEADER]: String(t),
            [SIGNATURE_HEADER]: sign(options.key, options.siteId, t, body),
          },
          body,
          signal: controller.signal,
          redirect: 'error',
        });
        ok = res.ok;
        if (!ok) error = res.status === 401 || res.status === 403 ? `refuse par le portail (HTTP ${res.status}) : cle ou identifiant du site a verifier` : `HTTP ${res.status}`;
      } finally {
        clearTimeout(abort);
      }
    } catch (err) {
      // Le message d'une erreur reseau ne contient ni la cle ni le corps.
      error = err instanceof Error ? err.message : String(err);
    }
    inFlight = false;
    state.sent++;
    if (ok) {
      state.lastOkAt = now();
      state.consecutiveFailures = 0;
      state.lastError = null;
      if (wasFailing) options.onChange?.('recovered', { ...state });
    } else {
      state.lastFailAt = now();
      state.lastError = error;
      state.consecutiveFailures++;
      if (!wasFailing && state.lastOkAt !== null) options.onChange?.('failing', { ...state });
    }
    return ok;
  }

  function start(): void {
    if (!configured || timer) return;
    void push();
    timer = setInterval(() => void push(), options.everyMs);
    timer.unref();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { push, start, stop, status: (): PortalStatus => ({ ...state }) };
}

