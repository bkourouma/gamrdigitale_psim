/**
 * Controle d'acces vu par le portail de suivi (F28) : un AGREGAT anonyme, calcule cote PSIM en LECTURE SEULE.
 *
 * Ce qui part : le nombre de portes declarees, le nombre de portes par etat du moment, la disponibilite des portes sur la
 * fenetre, et des COMPTES d'incidents d'acces (par type, par jour, ouverts en ce moment).
 * Ce qui ne part JAMAIS : nom de titulaire, numero de badge, `holderRef`, identifiant ou adresse de controleur, nom de porte,
 * nombre de passages (meme agrege : un « nombre de passages » par porte ou par jour se recoupe avec un registre de presence),
 * ni aucune ligne de `access_event` ou d'`access_controller`. Les noms des detecteurs-portes figurent deja dans `devices`
 * du resume (c'est un equipement comme un autre) : ils ne sont pas repetes ici.
 *
 * Ce module ne lit donc QUE : `access_door` (etat physique, alarmes), `device` (statut), `incident` (jointure sur les portes) et
 * l'historique des etats (via history.ts). Il n'importe pas access.ts : le portail charge ce fichier a travers server/portal.ts,
 * et ne doit pas embarquer le journal des passages, les secrets et le reste. La priorite des etats est donc recopiee
 * (`shownState`) ; un test la compare a `displayState` de access.ts pour toutes les combinaisons.
 */
import type { DatabaseSync } from 'node:sqlite';
import { availabilityOf, combine, loadIntervals } from './history.ts';
import type { Availability } from './history.ts';

/** Etats affiches d'une porte (docs/CONTROLE-ACCES.md § 4), dans l'ordre de priorite : le premier qui s'applique gagne. */
export const ACCESS_STATE_KEYS = ['offline', 'fault', 'forced', 'heldOpen', 'open', 'closed', 'unknown'] as const;
export type AccessStateKey = (typeof ACCESS_STATE_KEYS)[number];

/** Types d'incident d'acces comptes (l'evenement nomme qui a ouvert ou aggrave l'incident, voir sources.ts). */
export interface AccessIncidentCounts {
  /** Incidents OUVERTS pendant la fenetre (tous types). */
  total: number;
  forced: number;
  heldOpen: number;
  /** Refus de badge a repetition (`badge_denied_repeated`, compte par la passerelle). */
  repeatedDenials: number;
  tamper: number;
  /** Tout le reste : alarme sans evenement nomme, defaut d'horloge, etc. `total` = la somme des cinq types. */
  other: number;
  /** Incidents d'acces non clos en ce moment, quelle que soit leur anciennete. */
  openNow: number;
  /** Incidents ouverts par jour LOCAL du site (les jours sans incident sont omis). */
  byDay: { day: string; n: number }[];
}

export interface AccessSummary {
  /** Portes declarees (une porte = un detecteur de categorie `access` rattache a un controleur). Au moins 1. */
  doors: number;
  /** Nombre de portes par etat du moment ; la somme vaut `doors`. */
  states: Record<AccessStateKey, number>;
  /** Disponibilite cumulee des detecteurs-portes sur la fenetre ; `pct` est `null` si rien n'a ete observe. */
  availability: Availability;
  incidents: AccessIncidentCounts;
}

/** Garde-fou : une base alteree ne peut pas faire lire un nombre demesure de lignes. */
const MAX_INCIDENT_ROWS = 50_000;

/**
 * Etat affiche d'une porte, par priorite : hors ligne > en defaut > forcee > maintenue ouverte > ouverte > fermee > inconnu.
 * Meme regle que `displayState` (access.ts). Une porte dont le controleur se tait n'est JAMAIS « fermee ».
 */
export function shownState(input: { deviceStatus: string; doorState: string; forced: boolean; heldOpen: boolean }): AccessStateKey {
  if (input.deviceStatus === 'offline') return 'offline';
  if (input.deviceStatus === 'fault') return 'fault';
  if (input.forced) return 'forced';
  if (input.heldOpen) return 'heldOpen';
  if (input.doorState === 'open') return 'open';
  if (input.doorState === 'closed') return 'closed';
  return 'unknown';
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Jour LOCAL du site, comme les jours de disponibilite du resume. */
const localDay = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export interface AccessSummaryOptions {
  now: number;
  /** Debut de la fenetre (`now` - fenetre). */
  from: number;
  /** Intervalles d'etat deja charges par l'appelant (`loadIntervals`), pour ne pas relire l'historique ; sinon ils sont relus ici. */
  intervals?: ReturnType<typeof loadIntervals>;
}

/**
 * L'agregat d'acces du site, ou `undefined` s'il n'a aucune porte declaree (le bloc est alors absent du resume : un portail
 * ou un PSIM plus ancien ne voit pas la difference). Lecture seule.
 */
export function buildAccessSummary(db: DatabaseSync, options: AccessSummaryOptions): AccessSummary | undefined {
  const { now, from } = options;
  const doors = db
    .prepare(
      `SELECT a.detector_id AS id, a.door_state AS door_state, a.forced_at AS forced_at, a.held_since AS held_since, d.status AS status
         FROM access_door a JOIN device d ON d.id = a.detector_id ORDER BY a.detector_id`,
    )
    .all() as { id: string; door_state: string; forced_at: number | null; held_since: number | null; status: string }[];
  if (doors.length === 0) return undefined;

  const states = Object.fromEntries(ACCESS_STATE_KEYS.map((k) => [k, 0])) as Record<AccessStateKey, number>;
  for (const r of doors) states[shownState({ deviceStatus: r.status, doorState: r.door_state, forced: r.forced_at !== null, heldOpen: r.held_since !== null })]++;

  // Disponibilite : les memes intervalles que le reste du resume, sur les seules portes encore declarees. Une porte retiree
  // ne compte plus (ni dans le nombre, ni dans la disponibilite) ; aucune observation = `pct` null, jamais 100 %.
  const intervals = options.intervals ?? loadIntervals(db, from, now, now);
  const availability = combine(doors.map((r) => availabilityOf(intervals.get(r.id) ?? [], from, now, now)));

  const rows = db
    .prepare(
      `SELECT i.event AS event, i.opened_at AS opened_at, i.status AS status
         FROM incident i JOIN access_door a ON a.detector_id = i.detector_id
        WHERE i.opened_at >= ? OR i.status <> 'closed' ORDER BY i.opened_at DESC LIMIT ?`,
    )
    .all(from, MAX_INCIDENT_ROWS) as { event: string | null; opened_at: number; status: string }[];
  const counts: AccessIncidentCounts = { total: 0, forced: 0, heldOpen: 0, repeatedDenials: 0, tamper: 0, other: 0, openNow: 0, byDay: [] };
  const perDay = new Map<string, number>();
  for (const r of rows) {
    if (r.status !== 'closed') counts.openNow++;
    if (r.opened_at < from) continue; // ouvert avant la fenetre et toujours en cours : compte dans `openNow` seulement
    counts.total++;
    if (r.event === 'door_forced') counts.forced++;
    else if (r.event === 'door_held_open') counts.heldOpen++;
    else if (r.event === 'badge_denied_repeated') counts.repeatedDenials++;
    else if (r.event === 'tamper') counts.tamper++;
    else counts.other++;
    const day = localDay(r.opened_at);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  counts.byDay = [...perDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, n]) => ({ day, n }));

  return { doors: doors.length, states, availability, incidents: counts };
}
