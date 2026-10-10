/**
 * Autres capteurs Tuya / Smart Life que la fumee : contact de porte ou fenetre, mouvement (PIR), fuite d'eau,
 * temperature / humidite, gaz, monoxyde de carbone, bouton SOS. Ce fichier est PUREMENT declaratif et sans reseau :
 * une table de correspondance « code de fonction Tuya (DP code) -> evenement, etat ou mesure du PSIM », par type de capteur,
 * et la lecture d'un appareil d'apres cette table. Le service (lecture du cloud, moteur) est dans tuya.ts.
 *
 * Principes (les memes que pour la fumee) :
 *  - jamais « normal » faute de savoir : une fonction non reconnue, une valeur inattendue ou une echelle de mesure inconnue
 *    donnent un DEFAUT (« modele non pris en charge », « valeur inattendue »), jamais un etat normal par defaut ;
 *  - une alarme lue reste prioritaire, meme si l'appareil est declare hors ligne ; hors ligne sans alarme = silence
 *    (la supervision du moteur declare alors le detecteur « hors ligne ») ;
 *  - le PSIM decide : le capteur donne un fait (contact ouvert, mouvement, eau...), l'armement des zones d'intrusion et
 *    les seuils des mesures sont ceux du PSIM ;
 *  - lecture par NIVEAU (l'etat courant dans le cloud, pas des impulsions) : un evenement plus court que l'intervalle de
 *    lecture (appui bref sur un bouton SOS, mouvement d'une seconde) peut passer inapercu (voir docs/TUYA.md).
 *
 * Statut : seul le detecteur de fumee est valide contre un appareil reel. Tous les autres types ci-dessous sont ecrits
 * d'apres la documentation Tuya (« Standard Instruction Set ») et testes contre de fausses reponses : A QUALIFIER avec un
 * capteur reel de chaque modele avant tout usage en production.
 */
import { stateFromValue } from './sources.ts';
import type { DeviceCategory, Direction } from './types.ts';

export type SensorType = 'smoke' | 'door' | 'motion' | 'water' | 'temperature' | 'gas' | 'co' | 'sos';
export const SENSOR_TYPES: readonly SensorType[] = ['smoke', 'door', 'motion', 'water', 'temperature', 'gas', 'co', 'sos'];

/** Forme minimale d'un appareil Tuya (voir TuyaDevice dans tuya.ts, compatible). */
export interface SensorDevice {
  id: string;
  name?: string;
  online?: boolean;
  category?: string;
  status?: { code: string; value: unknown }[];
}

export interface SensorSpec {
  label: string;
  /** Categories de produit Tuya (champ `category` de l'appareil) qui designent ce type. */
  tuyaCategories: string[];
  /** Codes de fonction (DP) qui portent l'information principale. */
  codes: string[];
  /** Categories de detecteur du PSIM auxquelles ce type peut etre associe. */
  psimCategories: DeviceCategory[];
  /** `true` seulement si valide avec un appareil reel. */
  qualified: boolean;
  /** Ce que le PSIM en fait, en une phrase (affiche dans l'interface). */
  effect: string;
}

export const SENSOR_SPECS: Readonly<Record<SensorType, SensorSpec>> = {
  smoke: {
    label: 'Détecteur de fumée',
    tuyaCategories: ['ywbj'],
    codes: ['smoke_sensor_status', 'smoke_sensor_state', 'smoke_alarm'],
    psimCategories: ['fire'],
    qualified: true,
    effect: 'fumée → alarme incendie',
  },
  door: {
    label: 'Contact de porte ou fenêtre',
    tuyaCategories: ['mcs'],
    codes: ['doorcontact_state'],
    psimCategories: ['intrusion', 'access'],
    qualified: false,
    effect: 'ouvert → intrusion (zone armée) ou porte ouverte (accès, informatif)',
  },
  motion: {
    label: 'Détecteur de mouvement (PIR)',
    tuyaCategories: ['pir'],
    codes: ['pir'],
    psimCategories: ['intrusion'],
    qualified: false,
    effect: 'mouvement → alarme intrusion (zone armée)',
  },
  water: {
    label: "Détecteur de fuite d'eau",
    tuyaCategories: ['sj'],
    codes: ['watersensor_state'],
    psimCategories: ['environment'],
    qualified: false,
    effect: "eau → alarme fuite d'eau",
  },
  temperature: {
    label: 'Capteur de température et humidité',
    tuyaCategories: ['wsdcg'],
    codes: ['va_temperature', 'temp_current'],
    psimCategories: ['environment'],
    qualified: false,
    effect: 'température → mesure, seuils réglés dans le PSIM',
  },
  gas: {
    label: 'Détecteur de gaz',
    tuyaCategories: ['rqbj', 'jwbj'],
    codes: ['gas_sensor_status', 'gas_sensor_state'],
    psimCategories: ['environment'],
    qualified: false,
    effect: 'gaz → alarme gaz',
  },
  co: {
    label: 'Détecteur de monoxyde de carbone',
    tuyaCategories: ['cobj'],
    codes: ['co_status', 'co_state'],
    psimCategories: ['environment'],
    qualified: false,
    effect: 'CO → alarme monoxyde de carbone',
  },
  sos: {
    label: 'Bouton SOS',
    tuyaCategories: ['sos'],
    codes: ['sos_state'],
    psimCategories: ['people'],
    qualified: false,
    effect: 'appui → appel de détresse (toujours actif)',
  },
};

/** Categories de detecteur du PSIM pour lesquelles une source Tuya a un sens. */
export const TUYA_PSIM_CATEGORIES: readonly DeviceCategory[] = ['fire', 'intrusion', 'access', 'environment', 'people'];

/** Catalogue envoye a l'interface (liste deroulante et liste des modeles pris en charge). */
export function sensorCatalog() {
  return SENSOR_TYPES.map((type) => ({ type, ...SENSOR_SPECS[type] }));
}

/** Codes secondaires, communs a tous les capteurs ci-dessous (sauf la fumee, dont la lecture existante est intacte). */
const TAMPER_CODES = ['tamper_alarm', 'temper_alarm']; // vrai = ouverture du boitier / arrachement
const BATTERY_PERCENT_CODES = ['battery_percentage', 'residual_electricity']; // residual_electricity : a confirmer selon le produit
const BATTERY_STATE_CODE = 'battery_state'; // low / middle / high
const LOW_BATTERY_PERCENT = 15;

/** Code de mesure -> role (temperature ou humidite). */
const TEMPERATURE_CODES = ['va_temperature', 'temp_current'];
const HUMIDITY_CODES = ['va_humidity', 'humidity_value'];
/** Plage physique plausible d'une temperature ambiante lue : au-dela, la valeur est consideree incoherente (mauvaise echelle). */
const TEMPERATURE_MIN = -40;
const TEMPERATURE_MAX = 125;

const ON = new Set<unknown>(['alarm', true, 1, '1']);
const OFF = new Set<unknown>(['normal', false, 0, '0']);

/** Reconnaissance de la valeur d'une fonction binaire : vrai = declenche, faux = repos, null = valeur inattendue. */
type Parse = (value: unknown) => boolean | null;
const parseAlarm: Parse = (v) => (ON.has(v) ? true : OFF.has(v) ? false : null);
const parseContactOpen: Parse = (v) => (typeof v === 'boolean' ? v : null); // doorcontact_state : true = OUVERT
const parsePir: Parse = (v) => (v === 'pir' ? true : v === 'none' ? false : null);
const parseSos: Parse = (v) => (v === true || v === 'sos' || v === 'alarm' ? true : v === false || v === 'normal' || v === 'none' ? false : null);

interface Outcome {
  event: string;
  /** `true` : une vraie alarme (ouvre un incident). `false` : fait informatif ou retour au repos. */
  alarm: boolean;
  reason: string;
}

interface BinaryRule {
  parse: Parse;
  /** Fonction declenchee : selon la categorie du detecteur du PSIM. */
  on: (category: DeviceCategory | null) => Outcome;
  off: Outcome;
}

const BINARY: Partial<Record<SensorType, BinaryRule>> = {
  door: {
    parse: parseContactOpen,
    on: (c) => (c === 'access' ? { event: 'door_opened', alarm: false, reason: 'porte ouverte' } : { event: 'intrusion', alarm: true, reason: 'contact ouvert (porte ou fenetre)' }),
    off: { event: 'door_closed', alarm: false, reason: 'contact ferme' },
  },
  motion: { parse: parsePir, on: () => ({ event: 'motion', alarm: true, reason: 'mouvement detecte' }), off: { event: 'clear', alarm: false, reason: 'aucun mouvement' } },
  water: { parse: parseAlarm, on: () => ({ event: 'leak', alarm: true, reason: 'eau detectee' }), off: { event: 'dry', alarm: false, reason: 'aucune eau' } },
  gas: { parse: parseAlarm, on: () => ({ event: 'gas', alarm: true, reason: 'gaz detecte' }), off: { event: 'normal', alarm: false, reason: 'aucun gaz' } },
  co: { parse: parseAlarm, on: () => ({ event: 'co', alarm: true, reason: 'monoxyde de carbone detecte' }), off: { event: 'normal', alarm: false, reason: 'aucun monoxyde de carbone' } },
  sos: { parse: parseSos, on: () => ({ event: 'sos', alarm: true, reason: 'bouton SOS actionne' }), off: { event: 'alarm_reset', alarm: false, reason: 'aucun appel' } },
};

// ---------------------------------------------------------------- choix du type

export type SensorChoice = { type: SensorType } | { error: string };

const present = (device: SensorDevice, codes: string[]) => (device.status ?? []).some((s) => s && typeof s.code === 'string' && codes.includes(s.code));

/**
 * Type de capteur d'un appareil. Priorite : le type choisi dans l'interface ; sinon la categorie de produit Tuya
 * (`category` de l'appareil) ; sinon les codes de fonction presents. Refuse (message en clair) un type que la categorie du
 * detecteur du PSIM ne peut pas porter. Aucun type reconnu = erreur : jamais un « normal » par defaut.
 * `psimCategory` null (essai sans detecteur) : pas de controle de compatibilite.
 */
export function resolveSensorType(device: SensorDevice, requested: SensorType | null, psimCategory: DeviceCategory | null): SensorChoice {
  let type: SensorType | null = requested;
  if (!type && typeof device.category === 'string') type = SENSOR_TYPES.find((t) => SENSOR_SPECS[t].tuyaCategories.includes(device.category as string)) ?? null;
  if (!type) {
    const found = SENSOR_TYPES.filter((t) => present(device, SENSOR_SPECS[t].codes));
    if (found.length > 1) return { error: `modele non pris en charge : plusieurs fonctions reconnues (${found.map((t) => SENSOR_SPECS[t].label).join(', ')}) ; choisir le type de capteur` };
    type = found[0] ?? null;
  }
  // Rien de reconnu : un detecteur incendie garde la lecture « fumee » d'origine (et son message de defaut).
  if (!type && psimCategory === 'fire') type = 'smoke';
  if (!type) {
    const codes = (device.status ?? []).map((s) => s?.code).filter(Boolean).join(', ') || 'aucune';
    const category = device.category ? ` (categorie Tuya « ${String(device.category).slice(0, 20)} »)` : '';
    return { error: `modele non pris en charge${category} : aucune fonction reconnue ; donnees recues : ${codes}` };
  }
  if (psimCategory && !SENSOR_SPECS[type].psimCategories.includes(psimCategory)) {
    return { error: `type de capteur incompatible : « ${SENSOR_SPECS[type].label} » ne s'associe pas a un detecteur de cette categorie` };
  }
  return { type };
}

// ---------------------------------------------------------------- lecture

export interface SensorReading {
  kind: 'alarm' | 'prealarm' | 'normal' | 'fault' | 'silent';
  reason: string;
  /** Messages a envoyer au moteur (`handleDetectorMessage`), dans l'ordre. Vide = rien (appareil muet). */
  payloads: Record<string, unknown>[];
}

export interface SensorContext {
  psimCategory: DeviceCategory | null;
  /** Seuils du detecteur du PSIM (types a mesure) : permettent de ne jamais ecraser une alarme par un defaut de pile. */
  settings?: { warnAt: number | null; alarmAt: number | null; direction: Direction };
  /** Echelle (nombre de decimales) de chaque code de mesure, lue dans les specifications de l'appareil. */
  scales?: Record<string, number>;
}

const fault = (reason: string, event = 'fault'): SensorReading => ({ kind: 'fault', reason, payloads: [{ event }] });

function item(device: SensorDevice, codes: string[]): { code: string; value: unknown }[] {
  return (device.status ?? []).filter((s) => s && typeof s.code === 'string' && codes.includes(s.code));
}

function lowBattery(device: SensorDevice): boolean {
  const state = item(device, [BATTERY_STATE_CODE])[0]?.value;
  return state === 'low' || item(device, BATTERY_PERCENT_CODES).some((s) => typeof s.value === 'number' && s.value <= LOW_BATTERY_PERCENT);
}

const tamper = (device: SensorDevice) => item(device, TAMPER_CODES).some((s) => s.value === true || s.value === 'alarm' || s.value === 1);
const decimal = (n: number) => n.toFixed(1).replace('.', ',');

/** Nombre de decimales des codes de mesure d'un type (pour savoir s'il faut lire les specifications de l'appareil). */
export function needsScales(type: SensorType): boolean {
  return type === 'temperature';
}

/** Lecture d'un appareil de type `type` (hors fumee : voir readDevice dans tuya.ts). Fonction pure. */
export function readSensor(device: SensorDevice, type: Exclude<SensorType, 'smoke'>, ctx: SensorContext): SensorReading {
  const offline = device.online === false;
  const hasTamper = tamper(device);
  const tamperAlarm: SensorReading = { kind: 'alarm', reason: 'sabotage du detecteur (boitier ouvert ou arrache)', payloads: [{ event: 'tamper' }] };

  if (type === 'temperature') return readTemperature(device, ctx, offline, hasTamper ? tamperAlarm : null);

  const rule = BINARY[type]!;
  const values = item(device, SENSOR_SPECS[type].codes).map((s) => rule.parse(s.value));
  // Plusieurs codes equivalents publies : une seule alarme suffit.
  const state: boolean | null = values.includes(true) ? true : values.includes(false) ? false : null;
  const outcome = state === true ? rule.on(ctx.psimCategory) : state === false ? rule.off : null;

  // Le sabotage s'ajoute a l'alarme : en zone desarmee, l'ouverture est ignoree mais le sabotage reste actif.
  if (outcome?.alarm) return { kind: 'alarm', reason: outcome.reason, payloads: [{ event: outcome.event }, ...(hasTamper ? tamperAlarm.payloads : [])] };
  if (hasTamper) return tamperAlarm;
  if (offline) return { kind: 'silent', reason: "l'appareil est hors ligne pour Tuya (pile, WiFi)", payloads: [] };
  if (!outcome) {
    const codes = (device.status ?? []).map((s) => s?.code).filter(Boolean).join(', ') || 'aucune';
    const known = SENSOR_SPECS[type].codes.join(', ');
    return item(device, SENSOR_SPECS[type].codes).length === 0
      ? fault(`modele non pris en charge : aucune fonction reconnue pour « ${SENSOR_SPECS[type].label} » (${known}) ; donnees recues : ${codes}`)
      : fault(`valeur inattendue pour ${item(device, SENSOR_SPECS[type].codes)[0].code} : ${JSON.stringify(item(device, SENSOR_SPECS[type].codes)[0].value)?.slice(0, 40)}`);
  }
  if (lowBattery(device)) return fault('pile faible', 'low_battery');
  return { kind: 'normal', reason: outcome.reason, payloads: [{ event: outcome.event }] };
}

function readTemperature(device: SensorDevice, ctx: SensorContext, offline: boolean, tamperAlarm: SensorReading | null): SensorReading {
  const tempItem = item(device, TEMPERATURE_CODES)[0];
  const humItem = item(device, HUMIDITY_CODES)[0];
  let value: number | null = null;
  let problem: string | null = null;

  if (!tempItem) {
    const codes = (device.status ?? []).map((s) => s?.code).filter(Boolean).join(', ') || 'aucune';
    problem = `modele non pris en charge : aucune fonction reconnue pour « ${SENSOR_SPECS.temperature.label} » (${TEMPERATURE_CODES.join(', ')}) ; donnees recues : ${codes}`;
  } else if (typeof tempItem.value !== 'number' || !Number.isFinite(tempItem.value)) {
    problem = `valeur inattendue pour ${tempItem.code}`;
  } else {
    const scale = ctx.scales?.[tempItem.code];
    // L'echelle (0,1 degre, degre entier...) depend du produit : sans specifications lisibles, aucune mesure n'est inventee.
    if (typeof scale !== 'number' || !Number.isInteger(scale) || scale < 0 || scale > 4) {
      problem = `echelle de la mesure ${tempItem.code} inconnue (specifications de l'appareil non lues)`;
    } else {
      value = tempItem.value / 10 ** scale;
      if (value < TEMPERATURE_MIN || value > TEMPERATURE_MAX) {
        problem = `temperature incoherente (${decimal(value)} °C) : echelle de la mesure a verifier`;
        value = null;
      }
    }
  }

  let humidity: number | null = null;
  if (humItem && typeof humItem.value === 'number') {
    const scale = ctx.scales?.[humItem.code];
    if (typeof scale === 'number' && Number.isInteger(scale) && scale >= 0 && scale <= 4) {
      const h = humItem.value / 10 ** scale;
      if (h >= 0 && h <= 100) humidity = h;
    }
  }
  const text = value === null ? '' : `${decimal(value)} °C${humidity === null ? '' : `, humidite ${Math.round(humidity)} %`}`;

  const derived = value !== null && ctx.settings ? stateFromValue(value, ctx.settings) : null;
  // Une alarme ou une prealarme de seuil n'est jamais ecrasee par un defaut de pile.
  if (value !== null && (derived === 'alarm' || derived === 'prealarm')) {
    return { kind: derived === 'alarm' ? 'alarm' : 'prealarm', reason: `${text} : seuil depasse`, payloads: [{ value }, ...(tamperAlarm?.payloads ?? [])] };
  }
  if (tamperAlarm) return tamperAlarm;
  if (offline) return { kind: 'silent', reason: "l'appareil est hors ligne pour Tuya (pile, WiFi)", payloads: [] };
  if (problem !== null || value === null) return fault(problem ?? 'mesure illisible');
  if (lowBattery(device)) return { kind: 'fault', reason: 'pile faible', payloads: [{ event: 'low_battery', value }] };
  return { kind: 'normal', reason: text, payloads: [{ event: 'normal', value }] };
}

/** Lit les echelles (nombre de decimales) des codes de mesure dans les specifications d'un appareil (reponse brute du cloud). */
export function scalesFromSpecifications(result: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const r = (result ?? {}) as { functions?: unknown; status?: unknown };
  for (const list of [r.functions, r.status]) {
    if (!Array.isArray(list)) continue;
    for (const f of list as { code?: unknown; values?: unknown }[]) {
      if (!f || typeof f.code !== 'string' || typeof f.values !== 'string') continue;
      try {
        const scale = (JSON.parse(f.values) as { scale?: unknown }).scale;
        if (typeof scale === 'number' && Number.isInteger(scale)) out[f.code] = scale;
      } catch {
        // `values` illisible : l'echelle de ce code reste inconnue
      }
    }
  }
  return out;
}
