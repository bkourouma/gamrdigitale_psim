import { hasForbiddenChar, normalizeName } from './text.ts';
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

export const CATEGORIES: readonly DeviceCategory[] = ['fire', 'intrusion', 'access', 'environment', 'energy', 'people'];

export const CATEGORY_LABEL: Record<DeviceCategory, string> = {
  fire: 'Incendie',
  intrusion: 'Intrusion',
  access: "Contrôle d'accès",
  environment: 'Environnement',
  energy: 'Énergie',
  people: 'Personnes',
};

/** Sans accent (courriels, SMS, journaux) : meme style que le reste des notifications. */
export const CATEGORY_LABEL_PLAIN: Record<DeviceCategory, string> = {
  fire: 'Incendie',
  intrusion: 'Intrusion',
  access: "Controle d'acces",
  environment: 'Environnement',
  energy: 'Energie',
  people: 'Personnes',
};

/**
 * Evenements qu'un desarmement ne masque JAMAIS : le sabotage d'un detecteur et l'alarme de panique restent
 * actifs 24 h sur 24, zone armee ou non. Il en va de meme de l'appel de detresse (sos) et de la chute (fall) :
 * une personne en danger n'est jamais « hors planning ». (Seule la categorie intrusion est armable : energie et
 * personnes ne dependent d'aucun armement.)
 */
export const ALWAYS_ACTIVE_EVENTS: ReadonlySet<string> = new Set(['tamper', 'panic', 'sos', 'fall', 'patrol_incomplete', 'patrol_missed']);

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
  gas: 'alarm',
  co: 'alarm',
  power_loss: 'alarm',
  vibration: 'alarm',
  camera_masked: 'alarm',
  line_crossing: 'alarm',
  loitering: 'alarm',
  sos: 'alarm',
  fall: 'alarm',
  // presence et visages : envoyes par les detecteurs virtuels des regles de presence (server/rules.ts) ; gravite
  // « critical » = evenement precis, gravite « warning » = person_noticed / face_noticed
  person_detected: 'alarm',
  person_lingering: 'alarm',
  face_banned: 'alarm',
  face_unknown: 'alarm',
  // regles d'acces (server/accessrules.ts, detecteurs virtuels « R-<id> ») : gravite « critical » = l'evenement, « warning » = `*_noticed`
  badge_offhours: 'alarm',
  badge_watched: 'alarm',
  denials_spread: 'alarm',
  // prealarmes
  door_held_open: 'prealarm',
  badge_denied_repeated: 'prealarm',
  person_noticed: 'prealarm',
  face_noticed: 'prealarm',
  // armement des portes (server/accessarming.ts) : ouverture d'une porte rattachee a une zone armee ; regles d'acces en gravite « warning »
  door_opened_armed: 'prealarm',
  badge_offhours_noticed: 'prealarm',
  badge_watched_noticed: 'prealarm',
  denials_spread_noticed: 'prealarm',
  // application des agents (server/patrols.ts) : ronde incomplete ou non faite ; signalement d'un agent a la main courante
  patrol_incomplete: 'prealarm',
  patrol_missed: 'alarm',
  logbook_report: 'prealarm',
  // retour a la normale
  normal: 'normal',
  clear: 'normal',
  restored: 'normal',
  door_closed: 'normal',
  alarm_reset: 'normal',
  dry: 'normal',
  power_restored: 'normal',
  // defauts
  fault: 'fault',
  low_battery: 'fault',
  clock_drift: 'fault',
  // signes de vie / activite normale
  heartbeat: 'alive',
  ping: 'alive',
  badge_granted: 'alive',
  badge_denied: 'alive',
  door_opened: 'alive',
  // mode de la porte (F19) : information, jamais un changement d'etat
  door_mode: 'alive',
};

/**
 * Motif en clair de chaque evenement : c'est ce que lisent l'operateur et les personnes prevenues (« Gaz detecte »,
 * « Coupure secteur »), a la place d'un simple « Alarme ». Chaque evenement de EVENTS doit figurer ici (test).
 */
export const EVENT_LABEL: Readonly<Record<string, string>> = {
  intrusion: 'Intrusion',
  motion: 'Mouvement détecté',
  glass_break: 'Bris de vitre',
  tamper: 'Sabotage du détecteur',
  panic: 'Alarme de panique',
  door_forced: 'Porte forcée',
  forced_entry: 'Effraction',
  leak: "Fuite d'eau",
  flood: 'Inondation',
  over_temperature: 'Température excessive',
  gas: 'Gaz détecté',
  co: 'Monoxyde de carbone détecté',
  power_loss: 'Coupure secteur',
  vibration: 'Vibration détectée',
  camera_masked: 'Caméra masquée',
  line_crossing: 'Franchissement de ligne',
  loitering: 'Rôdage suspect',
  sos: 'Appel de détresse (SOS)',
  fall: 'Chute détectée',
  person_detected: 'Présence détectée',
  person_lingering: 'Présence prolongée',
  face_banned: 'Personne interdite reconnue',
  face_unknown: 'Visage inconnu en zone réservée',
  badge_offhours: 'Badge utilisé hors de ses horaires',
  badge_watched: 'Badge surveillé utilisé',
  denials_spread: 'Refus sur plusieurs portes',
  door_held_open: 'Porte restée ouverte',
  badge_denied_repeated: 'Badge refusé à répétition',
  person_noticed: 'Présence signalée',
  face_noticed: 'Visage signalé',
  door_opened_armed: "Ouverture pendant l'armement",
  badge_offhours_noticed: 'Badge hors horaires signalé',
  badge_watched_noticed: 'Badge surveillé signalé',
  denials_spread_noticed: 'Refus sur plusieurs portes signalés',
  patrol_incomplete: 'Ronde incomplète',
  patrol_missed: 'Ronde non faite',
  logbook_report: "Signalement d'un agent",
  normal: 'Retour à la normale',
  clear: 'Retour au calme',
  restored: 'Retour à la normale',
  door_closed: 'Porte fermée',
  alarm_reset: 'Alarme réarmée',
  dry: 'Sol sec',
  power_restored: 'Courant rétabli',
  fault: 'Défaut',
  low_battery: 'Batterie faible',
  clock_drift: "Horloge de l'équipement déréglée",
  heartbeat: 'Signe de vie',
  ping: 'Signe de vie',
  badge_granted: 'Badge accepté',
  badge_denied: 'Badge refusé',
  door_opened: 'Porte ouverte',
  door_mode: 'Mode de la porte',
};

/** Motif d'un evenement ; l'evenement lui-meme s'il est inconnu (donnees anciennes), `null` si aucun. */
export function eventLabel(event: string | null | undefined): string | null {
  if (!event) return null;
  return Object.hasOwn(EVENT_LABEL, event) ? EVENT_LABEL[event] : event;
}

/** Sans accent (courriels, SMS, journaux), comme CATEGORY_LABEL_PLAIN. */
export function eventLabelPlain(event: string | null | undefined): string | null {
  const label = eventLabel(event);
  return label === null ? null : label.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export const DETECTOR_STATES:ReadonlySet<string> = new Set(['normal', 'prealarm', 'alarm', 'fault', 'offline']);

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
      /** Precision en clair portee par le message (1 a 300 caracteres), ou `null` s'il n'en portait pas. */
      detail: string | null;
    }
  | { ok: false; error: string };

const MAX_ABS_VALUE = 1e9;
const MAX_DETAIL_LENGTH = 300;

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
  const { state, event, value, detail: rawDetail } = payload as { state?: unknown; event?: unknown; value?: unknown; detail?: unknown };

  // `detail` (facultatif) : texte libre qui finit dans un incident, des e-mails et des journaux ; meme garde que les noms saisis.
  let detail: string | null = null;
  if (rawDetail !== undefined && rawDetail !== null) {
    const text = typeof rawDetail === 'string' ? normalizeName(rawDetail) : '';
    if (typeof rawDetail !== 'string' || text.length < 1 || text.length > MAX_DETAIL_LENGTH || hasForbiddenChar(text)) {
      return { ok: false, error: `detail invalide (texte de 1 a ${MAX_DETAIL_LENGTH} caracteres, sans caractere de controle)` };
    }
    detail = text;
  }

  let reading: number | null = null;
  if (value !== undefined && value !== null) {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_ABS_VALUE) {
      return { ok: false, error: 'value doit etre un nombre fini' };
    }
    reading = value;
  }

  if (state !== undefined) {
    if (typeof state !== 'string' || !DETECTOR_STATES.has(state)) return { ok: false, error: 'state invalide' };
    return { ok: true, state: state as DetectorState, event: null, alive: false, value: reading, detail };
  }
  if (event !== undefined) {
    if (typeof event !== 'string' || !Object.hasOwn(EVENTS, event)) return { ok: false, error: 'event inconnu' };
    const effect = EVENTS[event];
    return effect === 'alive' ? { ok: true, state: null, event, alive: true, value: reading, detail } : { ok: true, state: effect, event, alive: false, value: reading, detail };
  }
  if (reading !== null) {
    const derived = stateFromValue(reading, settings);
    return { ok: true, state: derived, event: null, alive: derived === null, value: reading, detail };
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
