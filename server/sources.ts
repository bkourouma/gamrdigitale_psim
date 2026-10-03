import type { DetectorState, DeviceCategory, Direction } from './types.ts';

/**
 * Sources d'alarme autres que l'incendie : intrusion, controle d'acces, capteurs d'environnement.
 * Toutes passent par le meme moteur d'incidents ; seule change la facon de « lire » ce que dit l'equipement.
 *
 * Un equipement peut envoyer, au choix (dans cet ordre de priorite) :
 *  - `{"state": "normal|prealarm|alarm|fault|offline"}` : son etat, deja interprete par l'equipement ;
 *  - `{"event": "door_forced"}` : un evenement nomme (voir EVENTS) ;
 *  - `{"value": 41.5}` : une mesure, interpretee avec les seuils configures dans le PSIM.
 * `value` peut accompagner `state` ou `event` : la mesure est alors seulement memorisee et affichee.
 */

export const CATEGORIES: readonly DeviceCategory[] = ['fire', 'intrusion', 'access', 'environment'];

export const CATEGORY_LABEL: Record<DeviceCategory, string> = {
  fire: 'Incendie',
  intrusion: 'Intrusion',
  access: "Contrôle d'accès",
  environment: 'Environnement',
};

/** Sans accent (courriels, SMS, journaux) : meme style que le reste des notifications. */
export const CATEGORY_LABEL_PLAIN: Record<DeviceCategory, string> = {
  fire: 'Incendie',
  intrusion: 'Intrusion',
  access: "Controle d'acces",
  environment: 'Environnement',
};

/**
 * Evenements qu'un desarmement ne masque JAMAIS : le sabotage d'un detecteur et l'alarme de panique restent
 * actifs 24 h sur 24, zone armee ou non.
 */
export const ALWAYS_ACTIVE_EVENTS: ReadonlySet<string> = new Set(['tamper', 'panic']);

export type EventEffect = DetectorState | 'alive';

/**
 * Evenements reconnus. `alive` = signe de vie sans changement d'etat (activite normale : un badge
 * accepte, une porte ouverte puis refermee ne sont pas des incidents).
 *
 * `badge_denied` isole est volontairement ignore (un badge refuse est un fait courant) : c'est a la
 * passerelle d'envoyer `badge_denied_repeated` apres plusieurs refus rapproches.
 */
export const EVENTS: Readonly<Record<string, EventEffect>> = {
  // alarmes
  intrusion: 'alarm',
  motion: 'alarm',
  glass_break: 'alarm',
  tamper: 'alarm',
  panic: 'alarm',
  door_forced: 'alarm',
  forced_entry: 'alarm',
  leak: 'alarm',
  flood: 'alarm',
  over_temperature: 'alarm',
  // prealarmes
  door_held_open: 'prealarm',
  badge_denied_repeated: 'prealarm',
  // retour a la normale
  normal: 'normal',
  clear: 'normal',
  restored: 'normal',
  door_closed: 'normal',
  alarm_reset: 'normal',
  dry: 'normal',
  // defauts
  fault: 'fault',
  low_battery: 'fault',
  // signes de vie / activite normale
  heartbeat: 'alive',
  ping: 'alive',
  badge_granted: 'alive',
  badge_denied: 'alive',
  door_opened: 'alive',
};

export const DETECTOR_STATES: ReadonlySet<string> = new Set(['normal', 'prealarm', 'alarm', 'fault', 'offline']);

export interface SensorSettings {
  category: DeviceCategory;
  warnAt: number | null;
  alarmAt: number | null;
  direction: Direction;
}

export type Reading =
  | {
      ok: true;
      /** `null` : rien a changer dans l'etat (signe de vie, ou mesure sans seuil). */
      state: DetectorState | null;
      /** Evenement nomme a l'origine du message, s'il y en a un. */
      event: string | null;
      /** Signe de vie sans etat : si l'equipement etait « hors ligne », il redevient normal. */
      alive: boolean;
      value: number | null;
    }
  | { ok: false; error: string };

const MAX_ABS_VALUE = 1e9;

/** Etat deduit d'une mesure et des seuils : `null` si aucun seuil d'alarme n'est configure. */
export function stateFromValue(value: number, s: Pick<SensorSettings, 'warnAt' | 'alarmAt' | 'direction'>): DetectorState | null {
  if (s.alarmAt === null) return null;
  const beyond = (limit: number) => (s.direction === 'below' ? value <= limit : value >= limit);
  if (beyond(s.alarmAt)) return 'alarm';
  if (s.warnAt !== null && beyond(s.warnAt)) return 'prealarm';
  return 'normal';
}

/** Lit un message d'equipement. Ne leve jamais d'exception : toute entree inattendue donne une erreur. */
export function interpret(settings: SensorSettings, payload: unknown): Reading {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return { ok: false, error: 'Message invalide : un objet JSON est attendu' };
  const { state, event, value } = payload as { state?: unknown; event?: unknown; value?: unknown };

  let reading: number | null = null;
  if (value !== undefined && value !== null) {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_ABS_VALUE) {
      return { ok: false, error: 'value doit etre un nombre fini' };
    }
    reading = value;
  }

  if (state !== undefined) {
    if (typeof state !== 'string' || !DETECTOR_STATES.has(state)) return { ok: false, error: 'state invalide' };
    return { ok: true, state: state as DetectorState, event: null, alive: false, value: reading };
  }
  if (event !== undefined) {
    if (typeof event !== 'string' || !Object.hasOwn(EVENTS, event)) return { ok: false, error: 'event inconnu' };
    const effect = EVENTS[event];
    return effect === 'alive' ? { ok: true, state: null, event, alive: true, value: reading } : { ok: true, state: effect, event, alive: false, value: reading };
  }
  if (reading !== null) {
    const derived = stateFromValue(reading, settings);
    return { ok: true, state: derived, event: null, alive: derived === null, value: reading };
  }
  return { ok: false, error: 'state, event ou value requis' };
}

/** Valide des reglages de capteur. Renvoie le message d'erreur, ou `null` si tout est coherent. */
export function checkSensorSettings(s: SensorSettings): string | null {
  if (!CATEGORIES.includes(s.category)) return `categorie invalide (${CATEGORIES.join(', ')})`;
  if (s.direction !== 'above' && s.direction !== 'below') return 'direction doit etre above ou below';
  for (const [name, v] of [['seuil de prealarme', s.warnAt], ["seuil d'alarme", s.alarmAt]] as const) {
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > MAX_ABS_VALUE)) return `${name} invalide`;
  }
  if (s.warnAt !== null && s.alarmAt === null) return "Un seuil de prealarme exige un seuil d'alarme";
  if (s.warnAt !== null && s.alarmAt !== null) {
    const ordered = s.direction === 'above' ? s.warnAt <= s.alarmAt : s.warnAt >= s.alarmAt;
    if (!ordered) return `Le seuil de prealarme doit etre ${s.direction === 'above' ? 'inferieur' : 'superieur'} au seuil d'alarme`;
  }
  return null;
}
