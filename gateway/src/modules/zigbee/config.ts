/**
 * Configuration du module Zigbee2MQTT : lecture et validation stricte.
 * Toute erreur leve une Error dont le message est en francais, pret a etre affiche a l'installateur.
 */

export const KINDS = ['motion', 'contact', 'leak', 'temperature', 'smoke', 'gas', 'co', 'vibration', 'panic', 'tamper_only'] as const;
export type ZigbeeKind = (typeof KINDS)[number];

export interface DeviceSpec {
  /** Nom Zigbee2MQTT (friendly_name) ou adresse IEEE, tel qu'ecrit dans la configuration. */
  key: string;
  /** Identifiant de l'equipement dans le PSIM. */
  id: string;
  kind: ZigbeeKind;
  /** Identifiant PSIM distinct qui recoit l'humidite (capteurs de temperature). Absent = humidite ignoree. */
  humidityId?: string;
  /** Variation minimale (en unites de la mesure) avant de renvoyer une temperature. */
  minDelta: number;
  humidityMinDelta: number;
  /** Une mesure inchangee est tout de meme renvoyee au bout de ce delai (secondes). */
  repeatEveryS: number;
}

export interface ZigbeeConfig {
  brokerUrl: string;
  username?: string;
  password?: string;
  baseTopic: string;
  devices: DeviceSpec[];
  batteryLowPercent: number;
  /** Silence (s) au-dela duquel un capteur n'est plus « maintenu en vie » aupres du PSIM. null = jamais de heartbeat. */
  staleAfterS: number | null;
  heartbeatEveryS: number;
  /** Messages dont l'horodatage est plus ancien que ce delai (s) : ignores (0 = pas de limite). */
  maxAgeS: number;
  /** Plafond de messages envoyes au PSIM par equipement et par minute. */
  maxPerMinute: number;
}

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const BROKER_PROTOCOLS = new Set(['mqtt:', 'mqtts:', 'tcp:', 'tls:', 'ws:', 'wss:']);
const DAY_S = 24 * 3600;

const TOP_KEYS = new Set(['broker', 'baseTopic', 'devices', 'batteryLowPercent', 'staleAfterS', 'heartbeatEveryS', 'maxAgeS', 'maxPerMinute', 'valueMinDelta', 'humidityMinDelta', 'valueEveryS']);
const DEVICE_KEYS = new Set(['id', 'kind', 'humidityId', 'minDelta', 'humidityMinDelta', 'repeatEveryS']);
const BROKER_KEYS = new Set(['url', 'username', 'password']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 32 || s.charCodeAt(i) === 127) return true;
  return false;
}

function unknownKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw new Error(`${where} : option inconnue « ${k} » (options permises : ${[...allowed].join(', ')})`);
  }
}

function numberOpt(obj: Record<string, unknown>, name: string, where: string, def: number, min: number, max: number): number {
  const v = obj[name];
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`${where} : « ${name} » doit etre un nombre entre ${min} et ${max}`);
  }
  return v;
}

function checkTopicPart(value: string, where: string, what: string): void {
  if (value.length === 0 || value.length > 128) throw new Error(`${where} : ${what} doit contenir entre 1 et 128 caracteres`);
  if (/[#+]/.test(value)) throw new Error(`${where} : ${what} ne peut pas contenir de joker MQTT (# ou +)`);
  if (hasControlChars(value)) throw new Error(`${where} : ${what} contient un caractere interdit`);
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//')) {
    throw new Error(`${where} : ${what} ne doit pas commencer ou finir par « / » ni contenir « // »`);
  }
}

export function parseConfig(raw: unknown): ZigbeeConfig {
  if (!isObject(raw)) throw new Error('Zigbee : la configuration du module doit etre un objet');
  unknownKeys(raw, TOP_KEYS, 'Zigbee');

  // Liaison vers le broker Zigbee2MQTT
  const broker = raw.broker;
  if (!isObject(broker)) throw new Error('Zigbee : « broker » est obligatoire, ex. { "url": "mqtt://127.0.0.1:1883" }');
  unknownKeys(broker, BROKER_KEYS, 'Zigbee broker');
  if (typeof broker.url !== 'string' || broker.url.trim() === '') throw new Error('Zigbee broker : « url » est obligatoire (ex. mqtt://127.0.0.1:1883)');
  let parsed: URL;
  try {
    parsed = new URL(broker.url.trim());
  } catch {
    throw new Error(`Zigbee broker : adresse invalide « ${broker.url} » (ex. mqtt://127.0.0.1:1883)`);
  }
  if (!BROKER_PROTOCOLS.has(parsed.protocol)) throw new Error(`Zigbee broker : protocole « ${parsed.protocol.replace(':', '')} » non pris en charge (mqtt, mqtts, tcp, tls, ws, wss)`);
  if (parsed.hostname === '') throw new Error('Zigbee broker : l\'adresse ne contient pas de machine');
  for (const f of ['username', 'password'] as const) {
    if (broker[f] !== undefined && typeof broker[f] !== 'string') throw new Error(`Zigbee broker : « ${f} » doit etre un texte`);
  }

  // Sujet de base
  let baseTopic = 'zigbee2mqtt';
  if (raw.baseTopic !== undefined) {
    if (typeof raw.baseTopic !== 'string') throw new Error('Zigbee : « baseTopic » doit etre un texte');
    baseTopic = raw.baseTopic;
  }
  checkTopicPart(baseTopic, 'Zigbee', '« baseTopic »');

  const batteryLowPercent = numberOpt(raw, 'batteryLowPercent', 'Zigbee', 15, 0, 100);
  const heartbeatEveryS = numberOpt(raw, 'heartbeatEveryS', 'Zigbee', 60, 5, 3600);
  const maxAgeS = numberOpt(raw, 'maxAgeS', 'Zigbee', 900, 0, 30 * DAY_S);
  const maxPerMinute = numberOpt(raw, 'maxPerMinute', 'Zigbee', 60, 1, 6000);
  const valueMinDelta = numberOpt(raw, 'valueMinDelta', 'Zigbee', 0.5, 0, 1000);
  const humidityMinDelta = numberOpt(raw, 'humidityMinDelta', 'Zigbee', 2, 0, 1000);
  const valueEveryS = numberOpt(raw, 'valueEveryS', 'Zigbee', 900, 10, 7 * DAY_S);
  let staleAfterS: number | null = null;
  if (raw.staleAfterS !== undefined && raw.staleAfterS !== null) {
    staleAfterS = numberOpt(raw, 'staleAfterS', 'Zigbee', 0, 30, 30 * DAY_S);
    if (heartbeatEveryS >= staleAfterS) throw new Error('Zigbee : « heartbeatEveryS » doit etre inferieur a « staleAfterS »');
  }

  // Equipements
  const devices = raw.devices;
  if (!isObject(devices) || Object.keys(devices).length === 0) {
    throw new Error('Zigbee : « devices » est obligatoire et doit declarer au moins un equipement, ex. { "salon_pir": { "id": "zb-pir-1", "kind": "motion" } }');
  }
  const list: DeviceSpec[] = [];
  const ids = new Map<string, string>();
  const claimId = (id: string, owner: string): void => {
    const other = ids.get(id);
    if (other !== undefined) throw new Error(`Zigbee : l'identifiant PSIM « ${id} » est utilise deux fois (${other} et ${owner})`);
    ids.set(id, owner);
  };

  for (const [key, entry] of Object.entries(devices)) {
    const where = `Zigbee equipement « ${key} »`;
    checkTopicPart(key, 'Zigbee', `le nom d'equipement « ${key} »`);
    if (key === 'bridge' || key.startsWith('bridge/')) throw new Error(`${where} : le nom « bridge » est reserve a Zigbee2MQTT`);
    if (/\/(set|get|availability)$/.test(key)) throw new Error(`${where} : un nom ne peut pas finir par /set, /get ou /availability`);
    if (!isObject(entry)) throw new Error(`${where} : doit etre un objet { "id": ..., "kind": ... }`);
    unknownKeys(entry, DEVICE_KEYS, where);
    if (typeof entry.id !== 'string' || !ID_RE.test(entry.id)) throw new Error(`${where} : « id » invalide (1 a 32 caracteres parmi lettres, chiffres, _ et -)`);
    if (typeof entry.kind !== 'string' || !(KINDS as readonly string[]).includes(entry.kind)) {
      throw new Error(`${where} : « kind » doit etre l'un de : ${KINDS.join(', ')}`);
    }
    const kind = entry.kind as ZigbeeKind;
    claimId(entry.id, key);
    let humidityId: string | undefined;
    if (entry.humidityId !== undefined) {
      if (kind !== 'temperature') throw new Error(`${where} : « humidityId » n'a de sens que pour kind « temperature »`);
      if (typeof entry.humidityId !== 'string' || !ID_RE.test(entry.humidityId)) throw new Error(`${where} : « humidityId » invalide (1 a 32 caracteres parmi lettres, chiffres, _ et -)`);
      claimId(entry.humidityId, `${key} (humidite)`);
      humidityId = entry.humidityId;
    }
    const spec: DeviceSpec = {
      key,
      id: entry.id,
      kind,
      minDelta: numberOpt(entry, 'minDelta', where, valueMinDelta, 0, 1000),
      humidityMinDelta: numberOpt(entry, 'humidityMinDelta', where, humidityMinDelta, 0, 1000),
      repeatEveryS: numberOpt(entry, 'repeatEveryS', where, valueEveryS, 10, 7 * DAY_S),
    };
    if (humidityId !== undefined) spec.humidityId = humidityId;
    list.push(spec);
  }

  const cfg: ZigbeeConfig = { brokerUrl: broker.url.trim(), baseTopic, devices: list, batteryLowPercent, staleAfterS, heartbeatEveryS, maxAgeS, maxPerMinute };
  if (typeof broker.username === 'string' && broker.username !== '') cfg.username = broker.username;
  if (typeof broker.password === 'string' && broker.password !== '') cfg.password = broker.password;
  return cfg;
}
