import type { DetectorState } from '../../module.ts';
import { PROFILES } from './profiles.ts';

/**
 * Validation stricte et compilation de la configuration du module lorawan.
 * Toute erreur leve une Error dont le message (en francais) dit OU est le probleme : le module ne demarre pas
 * avec une configuration douteuse (une faute de frappe ne doit pas rendre un capteur muet en silence).
 */

/** Evenements reconnus par le PSIM (voir server/sources.ts). */
export const KNOWN_EVENTS: readonly string[] = [
  'intrusion', 'motion', 'glass_break', 'tamper', 'panic', 'door_forced', 'leak', 'flood', 'over_temperature',
  'normal', 'clear', 'restored', 'door_closed', 'dry', 'fault', 'low_battery', 'heartbeat', 'door_opened',
  'gas', 'co', 'power_loss', 'power_restored', 'vibration', 'line_crossing', 'loitering', 'sos', 'fall',
];
const KNOWN_STATES: readonly string[] = ['normal', 'prealarm', 'alarm', 'fault', 'offline'];

export const DEV_EUI_RE = /^[0-9a-fA-F]{16}$/;
export const PSIM_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** Segment de chemin : lettres, chiffres, _ - et espace (certains codecs ont des noms comme « Soil Moisture »). */
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_ -]{0,63}$/;
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PATH_DEPTH = 8;
const MAX_DEVICES = 2000;
const MAX_MAPPINGS = 32;
const MAX_ENUM_ENTRIES = 64;

export interface Emit {
  event?: string;
  state?: DetectorState;
  /** true = joindre la valeur mesuree (apres echelle/decalage). */
  value?: true;
}

interface RuleBase {
  key: string;
  /** Chemin dans `object` (sans le premier segment « object »). */
  path: string[];
  minIntervalMs: number;
}
export interface BoolRule extends RuleBase {
  type: 'bool';
  equals: boolean;
  emit: Emit | null;
  emitElse: Emit | null;
  repeat: boolean;
}
export interface EnumRule extends RuleBase {
  type: 'enum';
  map: Map<string, Emit>;
  repeat: boolean;
}
export type NumberWhen = 'above' | 'below' | 'atLeast' | 'atMost';
export interface NumberRule extends RuleBase {
  type: 'number';
  scale: number;
  offset: number;
  /** Bornes de saturation de la valeur (niveau en pourcent). */
  clamp: [number, number] | null;
  /** Valeurs brutes (apres echelle) hors de cet intervalle : mesure aberrante, ignoree. */
  accept: [number, number] | null;
  deadband: number;
  when: NumberWhen | null;
  threshold: number;
  hysteresis: number;
  emit: Emit | null;
  emitElse: Emit | null;
}
export type Rule = BoolRule | EnumRule | NumberRule;

export interface DeviceConfig {
  eui: string;
  id: string;
  kind: string | null;
  rules: Rule[];
}

export interface LorawanConfig {
  brokerUrl: string;
  username?: string;
  password?: string;
  applicationId: string;
  lowBatteryPercent: number;
  staleAfterS: number;
  devices: Map<string, DeviceConfig>;
}

type Obj = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new Error(`lorawan : ${path} : ${message}`);
}

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkKeys(obj: Obj, allowed: readonly string[], path: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(path, `cle inconnue « ${k} » (permises : ${allowed.join(', ')})`);
  }
}

function getNum(obj: Obj, key: string, path: string, min: number, max: number): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${path}.${key}`, 'un nombre est attendu');
  if (v < min || v > max) fail(`${path}.${key}`, `doit etre compris entre ${min} et ${max}`);
  return v;
}

function getBool(obj: Obj, key: string, path: string): boolean | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') fail(`${path}.${key}`, 'vrai ou faux (true/false) attendu');
  return v;
}

/** Chemin pointe sur, « object.a.b » -> ['a', 'b']. Pas d'eval, pas de crochets, pas de cles dangereuses. */
export function parsePath(from: unknown, path: string): string[] {
  if (typeof from !== 'string' || from === '') fail(path, "« from » est requis (ex. « object.temperature »)");
  const parts = from.split('.');
  if (parts[0] !== 'object') fail(path, `le chemin doit commencer par « object. » (recu « ${from.slice(0, 60)} »)`);
  if (parts.length < 2) fail(path, 'le chemin doit nommer un champ apres « object. »');
  if (parts.length - 1 > MAX_PATH_DEPTH) fail(path, `chemin trop profond (${MAX_PATH_DEPTH} niveaux au plus)`);
  const segments = parts.slice(1);
  for (const seg of segments) {
    if (FORBIDDEN_SEGMENTS.has(seg)) fail(path, `segment interdit « ${seg} »`);
    if (!SEGMENT_RE.test(seg)) fail(path, `segment de chemin invalide « ${seg.slice(0, 30)} » (lettres, chiffres, _ et - seulement)`);
  }
  return segments;
}

function parseEmit(raw: unknown, path: string, allowValue: boolean): Emit {
  if (!isObj(raw)) fail(path, 'un objet { event | state [, value] } est attendu');
  checkKeys(raw, ['event', 'state', 'value'], path);
  const out: Emit = {};
  if (raw.event !== undefined) {
    if (typeof raw.event !== 'string' || !KNOWN_EVENTS.includes(raw.event)) {
      fail(`${path}.event`, `evenement inconnu (permis : ${KNOWN_EVENTS.join(', ')})`);
    }
    out.event = raw.event;
  }
  if (raw.state !== undefined) {
    if (typeof raw.state !== 'string' || !KNOWN_STATES.includes(raw.state)) {
      fail(`${path}.state`, `etat inconnu (permis : ${KNOWN_STATES.join(', ')})`);
    }
    out.state = raw.state as DetectorState;
  }
  if (raw.value !== undefined) {
    if (raw.value !== true) fail(`${path}.value`, 'seul « true » est permis (joindre la valeur mesuree)');
    if (!allowValue) fail(`${path}.value`, 'une valeur ne peut etre jointe que pour un champ numerique');
    out.value = true;
  }
  if (out.event !== undefined && out.state !== undefined) fail(path, 'choisissez « event » ou « state », pas les deux');
  if (out.event === undefined && out.state === undefined && out.value === undefined) fail(path, 'event, state ou value est requis');
  return out;
}

const COMMON = ['key', 'from', 'type', 'minIntervalS'];
const NUMBER_KEYS = [...COMMON, 'scale', 'offset', 'min', 'max', 'deadband', 'when', 'threshold', 'hysteresis', 'emit', 'emitElse'];

function compileMapping(raw: unknown, path: string, key: string, lowBatteryPercent: number): Rule {
  if (!isObj(raw)) fail(path, 'un objet de traduction est attendu');
  const type = raw.type;
  const p = parsePath(raw.from, `${path}.from`);
  const minIntervalS = getNum(raw, 'minIntervalS', path, 0, 86400) ?? 0;
  const base = { key, path: p, minIntervalMs: Math.round(minIntervalS * 1000) };

  if (type === 'bool') {
    checkKeys(raw, [...COMMON, 'equals', 'emit', 'emitElse', 'repeat'], path);
    const emit = raw.emit === undefined ? null : parseEmit(raw.emit, `${path}.emit`, false);
    const emitElse = raw.emitElse === undefined ? null : parseEmit(raw.emitElse, `${path}.emitElse`, false);
    if (!emit && !emitElse) fail(path, "« emit » ou « emitElse » est requis");
    return { ...base, type: 'bool', equals: getBool(raw, 'equals', path) ?? true, emit, emitElse, repeat: getBool(raw, 'repeat', path) ?? false };
  }

  if (type === 'enum') {
    checkKeys(raw, [...COMMON, 'map', 'repeat'], path);
    if (!isObj(raw.map)) fail(`${path}.map`, 'une table { "valeur": { event } } est attendue');
    const entries = Object.entries(raw.map);
    if (entries.length === 0) fail(`${path}.map`, 'au moins une valeur est requise');
    if (entries.length > MAX_ENUM_ENTRIES) fail(`${path}.map`, `${MAX_ENUM_ENTRIES} valeurs au plus`);
    const map = new Map<string, Emit>();
    for (const [value, emit] of entries) map.set(value, parseEmit(emit, `${path}.map.${value.slice(0, 30)}`, false));
    return { ...base, type: 'enum', map, repeat: getBool(raw, 'repeat', path) ?? false };
  }

  if (type === 'battery') {
    checkKeys(raw, [...COMMON, 'unit', 'threshold', 'hysteresis'], path);
    const unit = raw.unit ?? 'percent';
    if (unit !== 'percent' && unit !== 'volt') fail(`${path}.unit`, '« percent » ou « volt » attendu');
    const threshold = getNum(raw, 'threshold', path, 0, unit === 'percent' ? 100 : 60) ?? (unit === 'percent' ? lowBatteryPercent : undefined);
    if (threshold === undefined) fail(`${path}.threshold`, 'un seuil en volts est requis pour une batterie en volts');
    return {
      ...base,
      type: 'number',
      scale: 1,
      offset: 0,
      clamp: null,
      accept: unit === 'percent' ? [0, 100] : [0, 60],
      deadband: 0,
      when: 'atMost',
      threshold,
      hysteresis: getNum(raw, 'hysteresis', path, 0, 100) ?? (unit === 'percent' ? 3 : 0.1),
      emit: { event: 'low_battery' },
      emitElse: null,
    };
  }

  if (type === 'number' || type === 'level') {
    const isLevel = type === 'level';
    checkKeys(raw, isLevel ? [...NUMBER_KEYS.filter((k) => k !== 'scale' && k !== 'offset' && k !== 'min' && k !== 'max'), 'emptyAt', 'fullAt'] : NUMBER_KEYS, path);
    let scale = getNum(raw, 'scale', path, -1e9, 1e9) ?? 1;
    let offset = getNum(raw, 'offset', path, -1e9, 1e9) ?? 0;
    if (scale === 0) fail(`${path}.scale`, 'ne peut pas etre 0');
    let clamp: [number, number] | null = null;
    if (isLevel) {
      const emptyAt = getNum(raw, 'emptyAt', path, -1e9, 1e9);
      if (emptyAt === undefined) {
        fail(`${path}.emptyAt`, "requis : distance mesuree quand la cuve est vide (hauteur de cuve, meme unite que le capteur). Renseignez-la dans « overrides »");
      }
      const fullAt = getNum(raw, 'fullAt', path, -1e9, 1e9) ?? 0;
      if (emptyAt === fullAt) fail(path, '« emptyAt » et « fullAt » doivent differer');
      scale = -100 / (emptyAt - fullAt);
      offset = (100 * emptyAt) / (emptyAt - fullAt);
      clamp = [0, 100];
    } else {
      const lo = getNum(raw, 'min', path, -1e12, 1e12);
      const hi = getNum(raw, 'max', path, -1e12, 1e12);
      if (lo !== undefined || hi !== undefined) {
        clamp = [lo ?? -Infinity, hi ?? Infinity];
        if (clamp[0] > clamp[1]) fail(path, '« min » doit etre <= « max »');
      }
    }
    const when = raw.when;
    if (when !== undefined && when !== 'above' && when !== 'below' && when !== 'atLeast' && when !== 'atMost') {
      fail(`${path}.when`, '« above », « below », « atLeast » ou « atMost » attendu');
    }
    const deadband = getNum(raw, 'deadband', path, 0, 1e9) ?? 0;
    const hysteresis = getNum(raw, 'hysteresis', path, 0, 1e9) ?? 0;
    // Sans « when », la regle transmet la mesure : « emit » vaut { value: true } par defaut.
    const emit = raw.emit === undefined ? (when === undefined ? { value: true as const } : null) : parseEmit(raw.emit, `${path}.emit`, true);
    const emitElse = raw.emitElse === undefined ? null : parseEmit(raw.emitElse, `${path}.emitElse`, true);
    let threshold = 0;
    if (when === undefined) {
      // Mesure simple : on transmet la valeur.
      if (raw.threshold !== undefined || raw.hysteresis !== undefined) fail(path, "« threshold » et « hysteresis » demandent « when »");
      if (emitElse) fail(path, "« emitElse » demande « when »");
      if (!emit || emit.value !== true || emit.event !== undefined || emit.state !== undefined) {
        fail(`${path}.emit`, 'sans « when », seul { "value": true } est permis (transmettre la mesure)');
      }
    } else {
      const t = getNum(raw, 'threshold', path, -1e12, 1e12);
      if (t === undefined) fail(`${path}.threshold`, 'requis avec « when »');
      threshold = t;
      if (!emit && !emitElse) fail(path, "« emit » ou « emitElse » est requis avec « when »");
      if (raw.deadband !== undefined) fail(`${path}.deadband`, "inutile avec « when » (utilisez « hysteresis »)");
    }
    return { ...base, type: 'number', scale, offset, clamp, accept: null, deadband, when: (when as NumberWhen | undefined) ?? null, threshold, hysteresis, emit, emitElse };
  }

  return fail(`${path}.type`, "« bool », « number », « enum », « level » ou « battery » attendu");
}

function parseDevice(eui: string, raw: unknown, lowBatteryPercent: number): DeviceConfig {
  const path = `devices.${eui}`;
  if (!isObj(raw)) fail(path, 'un objet { id, kind?, mapping?, overrides? } est attendu');
  checkKeys(raw, ['id', 'kind', 'mapping', 'overrides'], path);
  if (typeof raw.id !== 'string' || !PSIM_ID_RE.test(raw.id)) {
    fail(`${path}.id`, 'identifiant PSIM invalide (1 a 32 caracteres : lettres, chiffres, _ et -)');
  }
  const merged: { raw: Obj; path: string; profile: boolean }[] = [];

  let kind: string | null = null;
  if (raw.kind !== undefined) {
    if (typeof raw.kind !== 'string' || !Object.hasOwn(PROFILES, raw.kind)) {
      fail(`${path}.kind`, `profil inconnu (profils disponibles : ${Object.keys(PROFILES).join(', ')})`);
    }
    kind = raw.kind;
    for (const m of PROFILES[kind]!.mapping) merged.push({ raw: structuredClone(m) as Obj, path: `${path}.kind(${kind})`, profile: true });
  }

  // overrides : { "<cle de regle>": { champs a remplacer } }
  if (raw.overrides !== undefined) {
    if (!isObj(raw.overrides)) fail(`${path}.overrides`, 'un objet { "<cle>": { ... } } est attendu');
    for (const [okey, patch] of Object.entries(raw.overrides)) {
      const target = merged.find((m) => m.raw.key === okey);
      if (!target) {
        const known = merged.map((m) => String(m.raw.key)).join(', ') || '(aucune : precisez « kind »)';
        fail(`${path}.overrides.${okey.slice(0, 30)}`, `aucune regle de ce nom dans le profil (regles : ${known})`);
      }
      if (!isObj(patch)) fail(`${path}.overrides.${okey}`, 'un objet est attendu');
      if (Object.hasOwn(patch, 'key') || Object.hasOwn(patch, 'type')) fail(`${path}.overrides.${okey}`, '« key » et « type » ne se remplacent pas');
      for (const [k, v] of Object.entries(patch)) {
        if (FORBIDDEN_SEGMENTS.has(k)) fail(`${path}.overrides.${okey}`, `cle interdite « ${k} »`);
        target.raw[k] = v;
      }
    }
  }

  if (raw.mapping !== undefined) {
    if (!Array.isArray(raw.mapping)) fail(`${path}.mapping`, 'une liste est attendue');
    raw.mapping.forEach((m, i) => merged.push({ raw: isObj(m) ? { ...m } : (m as Obj), path: `${path}.mapping[${i}]`, profile: false }));
  }
  if (merged.length === 0) fail(path, 'aucune regle : precisez « kind » (profil) ou « mapping »');
  if (merged.length > MAX_MAPPINGS) fail(path, `${MAX_MAPPINGS} regles au plus`);

  // Cles : explicites d'abord (doublon = erreur), puis automatiques (dernier segment du chemin, suffixe si pris).
  const used = new Set<string>();
  for (const m of merged) {
    if (!isObj(m.raw)) continue;
    if (m.raw.key !== undefined) {
      if (typeof m.raw.key !== 'string' || !KEY_RE.test(m.raw.key)) fail(`${m.path}.key`, 'cle invalide (lettres, chiffres, _ et -, 40 au plus)');
      if (used.has(m.raw.key)) fail(`${m.path}.key`, `cle « ${m.raw.key} » en double`);
      used.add(m.raw.key);
    }
  }
  const rules: Rule[] = [];
  merged.forEach((m) => {
    if (!isObj(m.raw)) fail(m.path, 'un objet de traduction est attendu');
    let key = typeof m.raw.key === 'string' ? m.raw.key : '';
    if (key === '') {
      const path = parsePath(m.raw.from, `${m.path}.from`);
      const base = path[path.length - 1]!.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 30);
      key = base;
      for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
      used.add(key);
    }
    rules.push(compileMapping(m.raw, m.profile ? `${m.path}.${key}` : m.path, key, lowBatteryPercent));
  });
  return { eui, id: raw.id, kind, rules };
}

export function parseConfig(raw: Obj): LorawanConfig {
  if (!isObj(raw)) fail('configuration', 'un objet est attendu');
  checkKeys(raw, ['broker', 'applicationId', 'devices', 'lowBatteryPercent', 'staleAfterS'], 'configuration');

  if (!isObj(raw.broker)) fail('broker', "requis : { url, username?, password? } du broker MQTT de ChirpStack");
  checkKeys(raw.broker, ['url', 'username', 'password'], 'broker');
  const url = raw.broker.url;
  if (typeof url !== 'string' || url.length > 300) fail('broker.url', 'URL du broker requise (ex. mqtt://192.168.1.20:1883)');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail('broker.url', 'URL invalide (ex. mqtt://192.168.1.20:1883)');
  }
  if (!['mqtt:', 'mqtts:', 'tcp:', 'tls:', 'ws:', 'wss:'].includes(parsed.protocol)) fail('broker.url', 'protocole attendu : mqtt://, mqtts://, ws:// ou wss://');
  if (!parsed.hostname) fail('broker.url', 'adresse du broker manquante');
  for (const f of ['username', 'password'] as const) {
    const v = raw.broker[f];
    if (v !== undefined && (typeof v !== 'string' || v.length > 256)) fail(`broker.${f}`, 'texte de 256 caracteres au plus attendu');
  }

  const applicationId = raw.applicationId ?? '+';
  if (typeof applicationId !== 'string' || (applicationId !== '+' && !APP_ID_RE.test(applicationId))) {
    fail('applicationId', "identifiant d'application ChirpStack (lettres, chiffres, _ et -) ou « + » pour toutes");
  }
  const lowBatteryPercent = getNum(raw, 'lowBatteryPercent', 'configuration', 1, 99) ?? 15;
  const staleAfterS = getNum(raw, 'staleAfterS', 'configuration', 0, 30 * 86400) ?? 0;

  if (!isObj(raw.devices)) fail('devices', 'requis : { "<devEui>": { id, kind?, mapping? } }');
  const entries = Object.entries(raw.devices);
  if (entries.length === 0) fail('devices', 'au moins un capteur est requis');
  if (entries.length > MAX_DEVICES) fail('devices', `${MAX_DEVICES} capteurs au plus`);
  const devices = new Map<string, DeviceConfig>();
  const ids = new Map<string, string>();
  for (const [eui, dev] of entries) {
    if (!DEV_EUI_RE.test(eui)) fail(`devices.${eui.slice(0, 20)}`, 'devEui invalide : 16 caracteres hexadecimaux attendus (ex. a84041ffff1a2b3c)');
    const lower = eui.toLowerCase();
    if (devices.has(lower)) fail(`devices.${eui}`, 'devEui en double (meme valeur en majuscules et minuscules)');
    const parsedDev = parseDevice(lower, dev, lowBatteryPercent);
    const other = ids.get(parsedDev.id);
    if (other) fail(`devices.${eui}.id`, `identifiant PSIM « ${parsedDev.id} » deja utilise par ${other}`);
    ids.set(parsedDev.id, lower);
    devices.set(lower, parsedDev);
  }

  const out: LorawanConfig = { brokerUrl: url, applicationId, lowBatteryPercent, staleAfterS, devices };
  if (typeof raw.broker.username === 'string') out.username = raw.broker.username;
  if (typeof raw.broker.password === 'string') out.password = raw.broker.password;
  return out;
}
