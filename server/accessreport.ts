import type { DatabaseSync } from 'node:sqlite';
import { ACCESS_REASONS, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, resultLabel } from './access.ts';
import { availabilityOf, loadIntervals, outagesOf } from './history.ts';
import { esc, fmtDuration } from './reports.ts';
import type { Range } from './reports.ts';

/**
 * Section « Controle d'acces » du rapport periodique (F27) : ecran de rapport, piece jointe autonome et e-mail.
 * LECTURE SEULE : rien ici ne modifie la base.
 *
 * CONFIDENTIALITE (docs/CONTROLE-ACCES.md § 4) : la section ne contient que des COMPTES et des NOMS DE PORTES (nom du
 * detecteur). Jamais de nom de titulaire, de numero de badge, de reference ni d'identifiant ou d'adresse de controleur :
 * ces colonnes ne sont meme pas lues ci-dessous.
 *
 * Choix documentes :
 *  - Aucune porte declaree (table `access_door` vide), ou rapport filtre sur une autre categorie que `access` : section ABSENTE.
 *  - Passage dont la porte a ete retiree depuis : compte dans les totaux (ils restent ceux du journal) et regroupe sous
 *    « Porte retiree » dans les refus. Incidents et pannes d'une porte retiree : ignores (la porte n'est plus declaree).
 *  - Les passages sont filtres sur `at_device` (heure du controleur), comme le journal des passages.
 *  - Le temps non surveille (PSIM arrete) est donne a part et n'est jamais compte comme une panne.
 */

/** Types d'incident d'acces, dans l'ordre des colonnes ; tout autre evenement tombe dans `other`. */
export const INCIDENT_TYPES = ['door_forced', 'door_held_open', 'badge_denied_repeated', 'tamper', 'other'] as const;
export type AccessIncidentType = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_TYPE_LABEL: Readonly<Record<AccessIncidentType, string>> = {
  door_forced: 'Porte forcée',
  door_held_open: 'Maintenue ouverte',
  badge_denied_repeated: 'Refus répétés',
  tamper: 'Sabotage',
  other: 'Autre',
};

export const UNSPECIFIED_REASON = 'Motif non précisé';
export const REMOVED_DOOR = 'Porte retirée';
const MAX_ROWS = 50;
const DAY_MS = 86_400_000;

export interface AccessReport {
  doors: number;
  passages: number;
  granted: number;
  denied: number;
  late: number;
  /** Incidents par porte (celles qui en ont), tries par total decroissant. */
  incidents: { door: string; counts: Record<AccessIncidentType, number>; total: number }[];
  incidentTotal: number;
  /** Portes en defaut ou hors ligne, par duree cumulee decroissante (une porte sans panne n'y figure pas). */
  outages: { door: string; downS: number; availabilityPct: number | null; count: number; longestS: number }[];
  /** Temps non surveille cumule de toutes les portes, a part des pannes. */
  unmonitoredS: number;
  /** Refus par porte puis par motif. */
  denials: { door: string; total: number; reasons: { label: string; count: number }[] }[];
  retentionDays: number;
  /** La periode commence avant la limite de conservation du journal des passages. */
  retentionNote: boolean;
}

type Row = Record<string, unknown>;

/** « Refuse — badge inconnu » -> « Badge inconnu » ; motif absent -> « Motif non precise » ; motif sans libelle -> « Autre motif ». */
export function reasonText(reason: string | null): string {
  if (reason === null || reason === '') return UNSPECIFIED_REASON;
  const known = (ACCESS_REASONS as readonly string[]).includes(reason) ? reason : 'other';
  const label = resultLabel('denied', known);
  const prefix = 'Refusé — ';
  if (!label.startsWith(prefix)) return 'Autre motif';
  const why = label.slice(prefix.length);
  return why.charAt(0).toUpperCase() + why.slice(1);
}

function retentionDaysOf(db: DatabaseSync): number {
  const r = db.prepare("SELECT value FROM access_setting WHERE key = 'retention_days'").get() as { value: string } | undefined;
  const n = Number(r?.value);
  return Number.isInteger(n) && n >= MIN_RETENTION_DAYS && n <= MAX_RETENTION_DAYS ? n : DEFAULT_RETENTION_DAYS;
}

/** Calcule la section ; `null` = section absente. `now` : horloge injectee. */
export function computeAccessReport(db: DatabaseSync, range: Range, now: number): AccessReport | null {
  if (range.category !== null && range.category !== 'access') return null;
  const doors = (db.prepare('SELECT COUNT(*) AS n FROM access_door').get() as { n: number }).n;
  if (doors === 0) return null;

  // Chiffres cles : une seule requete agregee, quel que soit le nombre de passages.
  const k = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(result = 'granted'), 0) AS granted, COALESCE(SUM(result = 'denied'), 0) AS denied, COALESCE(SUM(late = 1), 0) AS late
         FROM access_event WHERE at_device >= ? AND at_device < ?`,
    )
    .get(range.from, range.to) as Row;

  // Incidents d'acces : par porte declaree et par type d'evenement.
  const incidentRows = db
    .prepare(
      `SELECT a.detector_id AS id, d.name AS name, i.event AS event, COUNT(*) AS n
         FROM incident i JOIN access_door a ON a.detector_id = i.detector_id JOIN device d ON d.id = i.detector_id
        WHERE i.opened_at >= ? AND i.opened_at < ?
        GROUP BY a.detector_id, d.name, i.event`,
    )
    .all(range.from, range.to) as Row[];
  const byDoor = new Map<string, { door: string; counts: Record<AccessIncidentType, number>; total: number }>();
  for (const r of incidentRows) {
    const id = r.id as string;
    let entry = byDoor.get(id);
    if (!entry) byDoor.set(id, (entry = { door: r.name as string, counts: { door_forced: 0, door_held_open: 0, badge_denied_repeated: 0, tamper: 0, other: 0 }, total: 0 }));
    const type: AccessIncidentType = (INCIDENT_TYPES as readonly string[]).includes(r.event as string) ? (r.event as AccessIncidentType) : 'other';
    entry.counts[type] += r.n as number;
    entry.total += r.n as number;
  }
  const incidentAll = [...byDoor.values()].sort((a, b) => b.total - a.total || a.door.localeCompare(b.door, 'fr'));

  // Pannes : historique d'etat des portes (detecteurs), meme calcul que la disponibilite du parc.
  const intervals = loadIntervals(db, range.from, range.to, now);
  const outages: AccessReport['outages'] = [];
  let unmonitoredS = 0;
  for (const d of db.prepare('SELECT a.detector_id AS id, d.name AS name FROM access_door a JOIN device d ON d.id = a.detector_id').all() as Row[]) {
    const list = intervals.get(d.id as string) ?? [];
    const av = availabilityOf(list, range.from, range.to, now);
    unmonitoredS += av.unmonitoredS;
    const found = outagesOf(d.id as string, list, now, range.to);
    if (found.length === 0) continue;
    outages.push({ door: d.name as string, downS: av.downS, availabilityPct: av.pct, count: found.length, longestS: Math.max(...found.map((o) => o.durationS)) });
  }
  outages.sort((a, b) => b.downS - a.downS || a.door.localeCompare(b.door, 'fr'));

  // Refus par porte et par motif ; une porte retiree (plus de ligne access_door) est regroupee sous un seul nom.
  const denialRows = db
    .prepare(
      `SELECT a.detector_id AS id, d.name AS name, e.reason AS reason, COUNT(*) AS n
         FROM access_event e LEFT JOIN access_door a ON a.detector_id = e.door_id LEFT JOIN device d ON d.id = a.detector_id
        WHERE e.result = 'denied' AND e.at_device >= ? AND e.at_device < ?
        GROUP BY a.detector_id, d.name, e.reason`,
    )
    .all(range.from, range.to) as Row[];
  const denialByDoor = new Map<string, { door: string; total: number; reasons: Map<string, number> }>();
  for (const r of denialRows) {
    const key = (r.id as string | null) ?? '';
    let entry = denialByDoor.get(key);
    if (!entry) denialByDoor.set(key, (entry = { door: key === '' ? REMOVED_DOOR : (r.name as string), total: 0, reasons: new Map() }));
    const label = reasonText((r.reason as string | null) ?? null);
    entry.reasons.set(label, (entry.reasons.get(label) ?? 0) + (r.n as number));
    entry.total += r.n as number;
  }
  const denials = [...denialByDoor.values()]
    .sort((a, b) => b.total - a.total || a.door.localeCompare(b.door, 'fr'))
    .slice(0, MAX_ROWS)
    .map((e) => ({ door: e.door, total: e.total, reasons: [...e.reasons].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'fr')) }));

  const retentionDays = retentionDaysOf(db);
  return {
    doors,
    passages: k.n as number,
    granted: k.granted as number,
    denied: k.denied as number,
    late: k.late as number,
    incidents: incidentAll.slice(0, MAX_ROWS),
    incidentTotal: incidentAll.reduce((s, i) => s + i.total, 0),
    outages: outages.slice(0, MAX_ROWS),
    unmonitoredS,
    denials,
    retentionDays,
    retentionNote: range.from < now - retentionDays * DAY_MS,
  };
}

export const retentionText = (days: number): string =>
  `Le journal des passages n'est conservé que ${days} jours : les chiffres de passages et de refus de cette période peuvent être incomplets.`;

const pct = (v: number | null): string => (v === null ? '—' : `${String(v).replace('.', ',')} %`);

// ---------------------------------------------------------------- ecran de rapport et piece jointe autonome

/** Bloc HTML de la section (chaine vide si absente). Tout texte venu d'un utilisateur (nom de porte) est echappe. */
export function accessSectionHtml(r: AccessReport | null): string {
  if (!r) return '';
  const stat = (label: string, value: number, note = '') => `<div class="stat"><div class="v">${value}</div><div class="l">${esc(label)}</div>${note ? `<div class="n">${esc(note)}</div>` : ''}</div>`;
  const table = (head: string[], rows: string[][]) =>
    `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const incidents =
    r.incidents.length === 0
      ? '<p class="empty">Aucun incident d\'accès sur cette période.</p>'
      : table(['Porte', ...INCIDENT_TYPES.map((t) => INCIDENT_TYPE_LABEL[t]), 'Total'], r.incidents.map((i) => [esc(i.door), ...INCIDENT_TYPES.map((t) => String(i.counts[t])), `<b>${i.total}</b>`]));
  const outages =
    r.outages.length === 0
      ? '<p class="empty">Aucune porte hors ligne ou en défaut sur cette période.</p>'
      : table(['Porte', 'Durée en défaut ou hors ligne', 'Disponibilité', 'Coupures', 'Plus longue coupure'], r.outages.map((o) => [esc(o.door), esc(fmtDuration(o.downS)), esc(pct(o.availabilityPct)), String(o.count), esc(fmtDuration(o.longestS))]));
  const denials =
    r.denials.length === 0
      ? '<p class="empty">Aucun refus sur cette période.</p>'
      : table(['Porte', 'Refus', 'Motifs'], r.denials.map((d) => [esc(d.door), `<b>${d.total}</b>`, d.reasons.map((x) => `${esc(x.label)} : ${x.count}`).join('<br>')]));
  return `
<h2>Contrôle d'accès</h2>
<section class="stats">
${stat('Portes déclarées', r.doors)}
${stat('Passages', r.passages)}
${stat('Accordés', r.granted)}
${stat('Refusés', r.denied)}
${stat('Reçus en différé', r.late, 'remontés après coup par le contrôleur')}
</section>
${r.retentionNote ? `<p class="warn">${esc(retentionText(r.retentionDays))}</p>` : ''}
<h3>Incidents d'accès</h3>
${incidents}
<h3>Portes les plus en défaut ou hors ligne</h3>
${outages}
${r.unmonitoredS > 0 ? `<p class="meta">Temps non surveillé (PSIM arrêté ou passerelle injoignable), non compté comme panne : ${esc(fmtDuration(r.unmonitoredS))} cumulés sur les portes.</p>` : ''}
<h3>Refus par porte et par motif</h3>
${denials}
<p class="foot">Comptes seulement : ce rapport ne nomme aucun titulaire ni aucun badge.</p>`;
}

// ---------------------------------------------------------------- e-mail

const ascii = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘]/g, "'")
    .replace(/[—–]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
const MAIL_ROWS = 10;

/** Lignes de texte brut (ASCII, comme le reste du corps du message) ; tableau vide si la section est absente. */
export function accessSectionText(r: AccessReport | null): string[] {
  if (!r) return [];
  const typesOf = (i: AccessReport['incidents'][number]) => INCIDENT_TYPES.filter((t) => i.counts[t] > 0).map((t) => `${INCIDENT_TYPE_LABEL[t]} ${i.counts[t]}`).join(', ');
  const lines = [
    "Controle d'acces",
    `  ${r.doors} porte(s) declaree(s) - ${r.passages} passage(s) : ${r.granted} accorde(s), ${r.denied} refuse(s), ${r.late} recu(s) en differe.`,
    r.retentionNote ? `  ATTENTION - ${retentionText(r.retentionDays)}` : '',
    r.incidents.length === 0
      ? "  Incidents d'acces : aucun sur la periode."
      : `  Incidents d'acces : ${r.incidentTotal}. ${r.incidents.slice(0, MAIL_ROWS).map((i) => `${i.door} : ${typesOf(i)}`).join(' ; ')}`,
    r.outages.length === 0
      ? '  Portes hors ligne ou en defaut : aucune sur la periode.'
      : `  Portes hors ligne ou en defaut : ${r.outages.slice(0, MAIL_ROWS).map((o) => `${o.door} ${fmtDuration(o.downS)} (${o.count} coupure(s), disponibilite ${pct(o.availabilityPct)})`).join(' ; ')}`,
    r.unmonitoredS > 0 ? `  Temps non surveille (non compte comme panne) : ${fmtDuration(r.unmonitoredS)} cumules.` : '',
    r.denied === 0 ? '  Refus : aucun.' : `  Refus par porte : ${r.denials.slice(0, MAIL_ROWS).map((d) => `${d.door} ${d.total} (${d.reasons.map((x) => `${x.label} ${x.count}`).join(', ')})`).join(' ; ')}`,
  ];
  return lines.filter((l) => l !== '').map((l) => `${/^ /.test(l) ? '  ' : ''}${ascii(l)}`);
}

/** Bloc HTML compact pour le corps du message (styles en ligne) ; chaine vide si la section est absente. */
export function accessSectionMailHtml(r: AccessReport | null): string {
  if (!r) return '';
  const li = (t: string) => (t === '' ? '' : `<li>${t}</li>`);
  const typesOf = (i: AccessReport['incidents'][number]) => INCIDENT_TYPES.filter((t) => i.counts[t] > 0).map((t) => `${esc(INCIDENT_TYPE_LABEL[t])} ${i.counts[t]}`).join(', ');
  return `<h3 style="margin:14px 0 4px">Contrôle d'accès</h3>
<p style="margin:4px 0">${r.doors} porte(s) déclarée(s) — <b>${r.passages}</b> passage(s) : ${r.granted} accordé(s), <b>${r.denied}</b> refusé(s), ${r.late} reçu(s) en différé.</p>
${r.retentionNote ? `<p style="margin:6px 0;padding:6px 10px;background:#fff4e0;border-left:4px solid #e08a00">${esc(retentionText(r.retentionDays))}</p>` : ''}
<ul style="margin:4px 0">
${li(r.incidents.length === 0 ? "Incidents d'accès : aucun sur la période." : `Incidents d'accès : <b>${r.incidentTotal}</b> — ${r.incidents.slice(0, MAIL_ROWS).map((i) => `${esc(i.door)} (${typesOf(i)})`).join(' ; ')}`)}
${li(r.outages.length === 0 ? 'Aucune porte hors ligne ou en défaut sur la période.' : `Portes hors ligne ou en défaut : ${r.outages.slice(0, MAIL_ROWS).map((o) => `${esc(o.door)} ${esc(fmtDuration(o.downS))} (${o.count} coupure(s), disponibilité ${esc(pct(o.availabilityPct))})`).join(' ; ')}`)}
${li(r.unmonitoredS > 0 ? `Temps non surveillé (non compté comme panne) : ${esc(fmtDuration(r.unmonitoredS))} cumulés.` : '')}
${li(r.denied === 0 ? 'Aucun refus.' : `Refus par porte : ${r.denials.slice(0, MAIL_ROWS).map((d) => `${esc(d.door)} ${d.total} (${d.reasons.map((x) => `${esc(x.label)} ${x.count}`).join(', ')})`).join(' ; ')}`)}
</ul>`;
}
