/**
 * Lecture et validation STRICTE de la configuration du module `acces-zkteco` : toute cle inconnue, toute valeur hors bornes est
 * refusee avec un message clair en francais, TOUTES les erreurs d'un coup. Meme principe que le module SIA (sia/config.ts).
 *
 * Forme (tout est facultatif sauf `listen` et `controllers`) :
 *   stateDir      dossier d'etat (curseurs F8, plages horaires attribuees, jours feries ecrits) ; defaut <gateway>/data/acces
 *   listen        { host, port, allowAnyInterface? } : interface d'ecoute du serveur PUSH (aucune valeur par defaut)
 *   allowFrom     adresses IPv4 / plages autorisees a se connecter
 *   controllers[] { id, serial, kind?, utcOffsetMin?, doors, actuators?, epoch?, syncKey? }
 *                   syncKey : cle de synchronisation des titulaires du controleur (64 hexadecimaux minuscules, donnee une seule
 *                   fois par le PSIM), de preference par {"$file": ...} ou {"$env": ...} ; absente = pas de synchronisation des
 *                   titulaires pour ce controleur (surveillance normale). Jamais journalisee ni reprise dans une erreur.
 *                   epoch : entier >= 0 (defaut 0). A augmenter quand le controleur est REMPLACE (memoire effacee, numeros
 *                   d'enregistrement repartis de zero) : si epoch > 0, l'identifiant d'evenement devient "<epoque>.<numero>" et le
 *                   curseur de recuperation (estampille de la poignee de main) repart de zero.
 *   thresholds    refus repetes, battement, derive d'horloge, silence, delais, `commandTimeoutS` (borne de CHAQUE commande,
 *                 ouvertures a distance comme synchronisation des titulaires)
 *   limits        corps, debit et connexions de la facade HTTP
 *   push          reglages renvoyes a l'appareil (delai d'interrogation, TransFlag, forme de CONTROL DEVICE)
 *   timezones     { min, max, always } : fuseaux horaires (« TimezoneId ») du controleur. Les horaires du PSIM recoivent un numero
 *                 libre de [min, max] (defaut 2 a 50) ; `always` (defaut 1) est le fuseau « toujours » deja present dans l'appareil
 *                 (titulaire sans horaire) : il n'est jamais ecrit ni supprime par le module. A QUALIFIER (capacite et fuseau 1).
 *   sync          synchronisation des titulaires PSIM -> controleur (centrales `controller` seulement) :
 *                   userExtras  envoyer `Name` et `Privilege=0` avec l'utilisateur (defaut true ; champs de la famille inBio /
 *                               terminaux, absents de la table `user` du SDK C3) ; mettre false si la centrale les refuse
 *                   fullCodes   codes `Return` de l'appareil signifiant « capacite pleine » (defaut [] : inconnus, A QUALIFIER)
 */
import { isIP } from 'node:net';
import { CONTROLLER_ID, MAX_EPOCH, validEpoch } from '../acces-commun/commun.ts';
import { SERIAL } from './protocol.ts';
import type { ControlFormat } from './protocol.ts';

export interface CidrRange {
  /** Adresse de reseau (entier non signe de 32 bits). */
  base: number;
  mask: number;
  text: string;
}

export interface ActuatorConfig {
  id: string;
  doorNo: number;
  kind: 'lock' | 'gate';
  /** Duree de l'impulsion d'ouverture envoyee a l'appareil (secondes, 1 a 254). */
  pulseS: number;
}

export interface ControllerConfig {
  id: string;
  serial: string;
  kind: 'controller' | 'terminal';
  utcOffsetMin: number;
  /** Numero de porte -> identifiant du detecteur PSIM. */
  doors: Map<number, string>;
  actuators: ActuatorConfig[];
  /** Epoque du controleur (0 par defaut) : voir l'en-tete de ce fichier. */
  epoch: number;
  /** Cle de synchronisation des titulaires ou null (synchronisation inactive). Ne jamais journaliser. */
  syncKey: string | null;
}

export interface TimezoneConfig {
  /** Premier et dernier numero de fuseau attribuable aux horaires du PSIM. */
  min: number;
  max: number;
  /** Fuseau « toujours » (titulaire sans horaire), hors de [min, max]. */
  always: number;
}

export interface SyncOptions {
  userExtras: boolean;
  /** Codes `Return` de l'appareil qui signifient « capacite pleine ». */
  fullCodes: number[];
}

export interface Thresholds {
  deniedCount: number;
  deniedWindowS: number;
  heartbeatS: number;
  clockDriftMs: number;
  silenceMs: number;
  offlineGraceMs: number;
  longUnlockS: number;
  deferredAfterS: number;
  commandTimeoutS: number;
}

export interface Limits {
  maxBodyBytes: number;
  perAddressPerMinute: number;
  maxConnections: number;
  maxConnectionsPerAddress: number;
  requestTimeoutMs: number;
}

export interface PushOptions {
  delayS: number;
  errorDelayS: number;
  transFlag: string;
  controlFormat: ControlFormat;
}

export interface ZktecoConfig {
  stateDir: string | null;
  host: string;
  port: number;
  allowFrom: CidrRange[] | null;
  controllers: ControllerConfig[];
  thresholds: Thresholds;
  limits: Limits;
  push: PushOptions;
  timezones: TimezoneConfig;
  sync: SyncOptions;
}

/** Adresse « toutes les interfaces », quelle que soit son ecriture (0.0.0.0, ::, ::0, 0:0:0:0:0:0:0:0, ::ffff:0.0.0.0...). */
export function anyInterface(host: string): boolean {
  if (isIP(host) === 4) return host.split('.').every((p) => Number(p) === 0);
  try {
    const h = new URL(`http://[${host}]/`).hostname;
    return h === '[::]' || h === '[::ffff:0:0]';
  } catch {
    return false;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Affichage sur d'une valeur fournie par l'utilisateur dans un message d'erreur. */
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 40) ?? String(v);

class Errors {
  list: string[] = [];
  add(text: string): void {
    if (this.list.length < 50) this.list.push(text);
  }
  unknownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) this.add(`${where} : cle inconnue ${show(k)} (attendues : ${allowed.join(', ')})`);
  }
  number(v: unknown, where: string, min: number, max: number, dflt: number, integer = true): number {
    if (v === undefined) return dflt;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
      this.add(`${where} doit etre un nombre${integer ? ' entier' : ''} entre ${min} et ${max} (recu : ${show(v)})`);
      return dflt;
    }
    return v;
  }
  bool(v: unknown, where: string, dflt: boolean): boolean {
    if (v === undefined) return dflt;
    if (typeof v !== 'boolean') {
      this.add(`${where} doit valoir true ou false`);
      return dflt;
    }
    return v;
  }
}

/** Adresse IPv4 -> entier non signe de 32 bits, ou `null`. */
export function ipv4ToInt(text: string): number | null {
  if (isIP(text) !== 4) return null;
  const p = text.split('.').map(Number) as [number, number, number, number];
  return ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3];
}

/** Adresse IPv4 ou plage CIDR (`192.168.10.0/24`). Prefixe de 8 a 32 : une plage plus large que /8 n'est pas une liste d'appareils. */
export function parseCidr(text: unknown): CidrRange | string {
  if (typeof text !== 'string') return 'doit etre une adresse IPv4 ou une plage (ex. 192.168.10.0/24)';
  const [addr, prefixText, ...rest] = text.split('/');
  if (rest.length > 0 || addr === undefined) return 'doit etre une adresse IPv4 ou une plage (ex. 192.168.10.0/24)';
  const base = ipv4ToInt(addr);
  if (base === null) return 'doit etre une adresse IPv4 ou une plage (ex. 192.168.10.0/24)';
  let prefix = 32;
  if (prefixText !== undefined) {
    if (!/^\d{1,2}$/.test(prefixText)) return 'a un masque invalide (8 a 32)';
    prefix = Number(prefixText);
    if (prefix < 8 || prefix > 32) return 'a un masque invalide (8 a 32) : une plage plus large n\'est pas une liste d\'appareils';
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (base & mask) >>> 0, mask, text };
}

/** Vrai si l'adresse source (IPv4, eventuellement ecrite `::ffff:a.b.c.d`) appartient a l'une des plages. */
export function inRanges(address: string, ranges: readonly CidrRange[]): boolean {
  const a = address.startsWith('::ffff:') ? address.slice(7) : address;
  const n = ipv4ToInt(a);
  if (n === null) return false;
  return ranges.some((r) => ((n & r.mask) >>> 0) === r.base);
}

const THRESHOLD_KEYS = ['deniedCount', 'deniedWindowS', 'heartbeatS', 'clockDriftMs', 'silenceMs', 'offlineGraceMs', 'longUnlockS', 'deferredAfterS', 'commandTimeoutS'];
const LIMIT_KEYS = ['maxBodyBytes', 'perAddressPerMinute', 'maxConnections', 'maxConnectionsPerAddress', 'requestTimeoutS'];
const PUSH_KEYS = ['delayS', 'errorDelayS', 'transFlag', 'controlFormat'];
const TIMEZONE_KEYS = ['min', 'max', 'always'];
const SYNC_KEYS = ['userExtras', 'fullCodes'];

/** TransFlag par defaut : le seul journal des passages, jamais utilisateurs ni gabarits (A QUALIFIER, voir protocol.ts). */
export const DEFAULT_TRANSFLAG = '1000000000';

function readController(raw: unknown, index: number, e: Errors): ControllerConfig | null {
  const where = `controllers[${index}]`;
  if (!isObject(raw)) {
    e.add(`${where} doit etre un objet`);
    return null;
  }
  e.unknownKeys(raw, ['id', 'serial', 'kind', 'utcOffsetMin', 'doors', 'actuators', 'epoch', 'syncKey'], where);
  let ok = true;
  const id = raw.id;
  if (typeof id !== 'string' || !CONTROLLER_ID.test(id)) {
    e.add(`${where}.id doit etre un identifiant (lettres, chiffres, _ ou -, 32 caracteres au plus)`);
    ok = false;
  }
  const serial = raw.serial;
  if (typeof serial !== 'string' || !SERIAL.test(serial)) {
    e.add(`${where}.serial doit etre le numero de serie de l'appareil (lettres et chiffres, 4 a 32 caracteres)`);
    ok = false;
  }
  let kind: 'controller' | 'terminal' = 'controller';
  if (raw.kind !== undefined) {
    if (raw.kind !== 'controller' && raw.kind !== 'terminal') {
      e.add(`${where}.kind doit valoir "controller" (centrale C3 / inBio) ou "terminal" (pointeuse, une porte)`);
      ok = false;
    } else kind = raw.kind;
  }
  const utcOffsetMin = e.number(raw.utcOffsetMin, `${where}.utcOffsetMin`, -720, 840, 0);
  // Epoque : validation STRICTE (pas de texte "2", pas de 1.5, pas de negatif), aucune correction silencieuse.
  let epoch = 0;
  if (raw.epoch !== undefined) {
    if (!validEpoch(raw.epoch)) {
      e.add(`${where}.epoch doit etre un entier de 0 a ${MAX_EPOCH} (0 = controleur d'origine ; l'augmenter quand le controleur est remplace) (recu : ${show(raw.epoch)})`);
      ok = false;
    } else epoch = raw.epoch;
  }

  // Cle de synchronisation : validation stricte, et jamais la valeur dans le message (c'est peut-etre une cle presque juste).
  let syncKey: string | null = null;
  if (raw.syncKey !== undefined) {
    if (typeof raw.syncKey !== 'string' || !/^[0-9a-f]{64}$/.test(raw.syncKey)) {
      e.add(`${where}.syncKey doit etre la cle de synchronisation du controleur donnee par le PSIM : 64 caracteres hexadecimaux minuscules (0-9, a-f), de preference {"$file": "secrets/fichier.txt"} ou {"$env": "NOM"}`);
      ok = false;
    } else syncKey = raw.syncKey;
  }

  const doors = new Map<number, string>();
  if (!isObject(raw.doors) || Object.keys(raw.doors).length === 0) {
    e.add(`${where}.doors est obligatoire : { "1": "<id du detecteur PSIM>", ... } (portes 1 a 4)`);
    ok = false;
  } else {
    for (const [k, v] of Object.entries(raw.doors)) {
      if (!/^[1-4]$/.test(k)) {
        e.add(`${where}.doors : ${show(k)} n'est pas un numero de porte (1 a 4)`);
        ok = false;
        continue;
      }
      if (typeof v !== 'string' || !CONTROLLER_ID.test(v)) {
        e.add(`${where}.doors.${k} doit etre un identifiant de detecteur PSIM (lettres, chiffres, _ ou -, 32 caracteres au plus)`);
        ok = false;
        continue;
      }
      doors.set(Number(k), v);
    }
    if (kind === 'terminal' && (doors.size !== 1 || !doors.has(1))) {
      e.add(`${where} : un terminal n'a qu'une porte, la numero 1`);
      ok = false;
    }
  }

  const actuators: ActuatorConfig[] = [];
  if (raw.actuators !== undefined) {
    if (!isObject(raw.actuators)) {
      e.add(`${where}.actuators doit etre un objet { "<id actionneur>": { "door": 1, "type": "lock" } }`);
      ok = false;
    } else {
      for (const [aid, a] of Object.entries(raw.actuators)) {
        const at = `${where}.actuators.${aid}`;
        if (!CONTROLLER_ID.test(aid)) {
          e.add(`${where}.actuators : identifiant ${show(aid)} invalide (lettres, chiffres, _ ou -, 32 caracteres au plus)`);
          ok = false;
          continue;
        }
        if (!isObject(a)) {
          e.add(`${at} doit etre un objet { "door": 1, "type": "lock" }`);
          ok = false;
          continue;
        }
        e.unknownKeys(a, ['door', 'type', 'pulseS'], at);
        const door = a.door;
        if (typeof door !== 'number' || !Number.isInteger(door) || !doors.has(door)) {
          e.add(`${at}.door doit etre le numero d'une porte declaree dans doors`);
          ok = false;
          continue;
        }
        if (a.type !== 'lock' && a.type !== 'gate') {
          e.add(`${at}.type doit valoir "lock" (serrure) ou "gate" (barriere, portail)`);
          ok = false;
          continue;
        }
        actuators.push({ id: aid, doorNo: door, kind: a.type, pulseS: e.number(a.pulseS, `${at}.pulseS`, 1, 254, 5) });
      }
    }
  }
  if (!ok) return null;
  return { id: id as string, serial: serial as string, kind, utcOffsetMin, doors, actuators, epoch, syncKey };
}

/** Valide la configuration ; leve une erreur listant TOUS les problemes. */
export function parseConfig(raw: Record<string, unknown>): ZktecoConfig {
  const e = new Errors();
  if (!isObject(raw)) throw new Error('Configuration acces-zkteco invalide : un objet est attendu');
  e.unknownKeys(raw, ['stateDir', 'listen', 'allowFrom', 'controllers', 'thresholds', 'limits', 'push', 'timezones', 'sync'], 'acces-zkteco');

  let stateDir: string | null = null;
  if (raw.stateDir !== undefined) {
    if (typeof raw.stateDir !== 'string' || raw.stateDir.trim() === '' || raw.stateDir.length > 400 || raw.stateDir.includes('\0')) e.add('stateDir doit etre un chemin de dossier (texte non vide)');
    else stateDir = raw.stateDir;
  }

  let host = '';
  let port = 0;
  if (!isObject(raw.listen)) e.add('listen est obligatoire : { "host": "<adresse IP de l\'interface>", "port": <port> }');
  else {
    const l = raw.listen;
    e.unknownKeys(l, ['host', 'port', 'allowAnyInterface'], 'listen');
    const any = e.bool(l.allowAnyInterface, 'listen.allowAnyInterface', false);
    if (typeof l.host !== 'string' || isIP(l.host) === 0) e.add("listen.host doit etre l'adresse IP de l'interface d'ecoute (ex. 192.168.10.10) ; aucune valeur par defaut");
    else if (anyInterface(l.host) && !any) e.add(`listen.host ${l.host} ecoute sur TOUTES les interfaces : choisir l'adresse d'une interface, ou ajouter "allowAnyInterface": true en connaissance de cause`);
    else host = l.host;
    if (typeof l.port !== 'number' || !Number.isInteger(l.port) || l.port < 0 || l.port > 65535) e.add('listen.port doit etre un numero de port (1 a 65535)');
    else port = l.port;
  }

  let allowFrom: CidrRange[] | null = null;
  if (raw.allowFrom !== undefined) {
    if (!Array.isArray(raw.allowFrom) || raw.allowFrom.length === 0 || raw.allowFrom.length > 256) e.add('allowFrom doit etre une liste (1 a 256) d\'adresses IPv4 ou de plages, ex. ["192.168.10.0/24", "192.168.10.21"]');
    else {
      allowFrom = [];
      raw.allowFrom.forEach((entry, i) => {
        const r = parseCidr(entry);
        if (typeof r === 'string') e.add(`allowFrom[${i}] ${r}`);
        else allowFrom?.push(r);
      });
    }
  }

  const t = raw.thresholds === undefined ? {} : raw.thresholds;
  if (!isObject(t)) e.add('thresholds doit etre un objet');
  const th = isObject(t) ? t : {};
  e.unknownKeys(th, THRESHOLD_KEYS, 'thresholds');
  const thresholds: Thresholds = {
    deniedCount: e.number(th.deniedCount, 'thresholds.deniedCount', 1, 100, 3),
    deniedWindowS: e.number(th.deniedWindowS, 'thresholds.deniedWindowS', 1, 3600, 60),
    heartbeatS: e.number(th.heartbeatS, 'thresholds.heartbeatS', 5, 3600, 60),
    clockDriftMs: e.number(th.clockDriftMs, 'thresholds.clockDriftMs', 1000, 86_400_000, 120_000),
    silenceMs: e.number(th.silenceMs, 'thresholds.silenceMs', 5000, 3_600_000, 90_000),
    offlineGraceMs: e.number(th.offlineGraceMs, 'thresholds.offlineGraceMs', 0, 300_000, 15_000),
    longUnlockS: e.number(th.longUnlockS, 'thresholds.longUnlockS', 1, 3600, 60),
    deferredAfterS: e.number(th.deferredAfterS, 'thresholds.deferredAfterS', 1, 86_400, 120),
    commandTimeoutS: e.number(th.commandTimeoutS, 'thresholds.commandTimeoutS', 2, 300, 30),
  };

  const l = raw.limits === undefined ? {} : raw.limits;
  if (!isObject(l)) e.add('limits doit etre un objet');
  const lim = isObject(l) ? l : {};
  e.unknownKeys(lim, LIMIT_KEYS, 'limits');
  const limits: Limits = {
    maxBodyBytes: e.number(lim.maxBodyBytes, 'limits.maxBodyBytes', 1024, 4_194_304, 262_144),
    perAddressPerMinute: e.number(lim.perAddressPerMinute, 'limits.perAddressPerMinute', 1, 100_000, 600),
    maxConnections: e.number(lim.maxConnections, 'limits.maxConnections', 1, 1000, 64),
    maxConnectionsPerAddress: e.number(lim.maxConnectionsPerAddress, 'limits.maxConnectionsPerAddress', 1, 1000, 8),
    requestTimeoutMs: Math.round(e.number(lim.requestTimeoutS, 'limits.requestTimeoutS', 0.2, 60, 10, false) * 1000),
  };

  const p = raw.push === undefined ? {} : raw.push;
  if (!isObject(p)) e.add('push doit etre un objet');
  const pu = isObject(p) ? p : {};
  e.unknownKeys(pu, PUSH_KEYS, 'push');
  let transFlag = DEFAULT_TRANSFLAG;
  if (pu.transFlag !== undefined) {
    if (typeof pu.transFlag !== 'string' || !/^[A-Za-z0-9 ]{1,64}$/.test(pu.transFlag)) e.add('push.transFlag doit etre un texte de 1 a 64 caracteres (lettres, chiffres, espaces)');
    else transFlag = pu.transFlag;
  }
  let controlFormat: ControlFormat = 'hex';
  if (pu.controlFormat !== undefined) {
    if (pu.controlFormat !== 'hex' && pu.controlFormat !== 'spaced') e.add('push.controlFormat doit valoir "hex" (CONTROL DEVICE 01010105) ou "spaced" (CONTROL DEVICE 1 1 1 5)');
    else controlFormat = pu.controlFormat;
  }
  const push: PushOptions = {
    delayS: e.number(pu.delayS, 'push.delayS', 1, 30, 3),
    errorDelayS: e.number(pu.errorDelayS, 'push.errorDelayS', 5, 600, 30),
    transFlag,
    controlFormat,
  };
  if (thresholds.silenceMs < push.delayS * 3000) e.add(`thresholds.silenceMs (${thresholds.silenceMs}) doit valoir au moins 3 fois push.delayS (${push.delayS * 3000} ms) : un appareil qui interroge toutes les ${push.delayS} s ne doit pas etre declare muet`);

  // Fuseaux horaires du controleur (synchronisation des horaires) : A QUALIFIER, valeurs prudentes par defaut.
  const tzRaw = raw.timezones === undefined ? {} : raw.timezones;
  if (!isObject(tzRaw)) e.add('timezones doit etre un objet { "min": 2, "max": 50, "always": 1 }');
  const tz = isObject(tzRaw) ? tzRaw : {};
  e.unknownKeys(tz, TIMEZONE_KEYS, 'timezones');
  const timezones: TimezoneConfig = {
    min: e.number(tz.min, 'timezones.min', 1, 254, 2),
    max: e.number(tz.max, 'timezones.max', 1, 254, 50),
    always: e.number(tz.always, 'timezones.always', 1, 254, 1),
  };
  if (timezones.min > timezones.max) e.add(`timezones.min (${timezones.min}) ne peut pas depasser timezones.max (${timezones.max})`);
  else if (timezones.always >= timezones.min && timezones.always <= timezones.max) {
    e.add(`timezones.always (${timezones.always}) doit etre hors de la plage attribuable ${timezones.min} a ${timezones.max} : le fuseau « toujours » ne doit jamais etre reecrit par une synchronisation`);
  }

  const syRaw = raw.sync === undefined ? {} : raw.sync;
  if (!isObject(syRaw)) e.add('sync doit etre un objet { "userExtras": true, "fullCodes": [] }');
  const sy = isObject(syRaw) ? syRaw : {};
  e.unknownKeys(sy, SYNC_KEYS, 'sync');
  const fullCodes: number[] = [];
  if (sy.fullCodes !== undefined) {
    if (!Array.isArray(sy.fullCodes) || sy.fullCodes.length > 16) e.add('sync.fullCodes doit etre une liste (16 au plus) de codes de retour entiers negatifs de l\'appareil');
    else {
      sy.fullCodes.forEach((c, i) => {
        if (typeof c !== 'number' || !Number.isInteger(c) || c >= 0 || c < -100_000) e.add(`sync.fullCodes[${i}] doit etre un entier negatif (code Return de l'appareil)`);
        else if (!fullCodes.includes(c)) fullCodes.push(c);
      });
    }
  }
  const sync: SyncOptions = { userExtras: e.bool(sy.userExtras, 'sync.userExtras', true), fullCodes };

  const controllers: ControllerConfig[] = [];
  if (!Array.isArray(raw.controllers) || raw.controllers.length === 0) e.add('controllers est obligatoire : au moins un appareil [{ "id": ..., "serial": ..., "doors": {...} }]');
  else {
    if (raw.controllers.length > 64) e.add('controllers : 64 appareils au plus');
    const ids = new Set<string>();
    const serials = new Set<string>();
    const detectors = new Set<string>();
    const actuatorIds = new Set<string>();
    raw.controllers.slice(0, 64).forEach((entry, i) => {
      const c = readController(entry, i, e);
      if (!c) return;
      if (ids.has(c.id)) e.add(`controllers[${i}].id ${c.id} est utilise deux fois`);
      if (serials.has(c.serial.toLowerCase())) e.add(`controllers[${i}].serial est utilise deux fois (majuscules et minuscules comprises)`);
      ids.add(c.id);
      serials.add(c.serial.toLowerCase());
      for (const [no, det] of c.doors) {
        if (detectors.has(det)) e.add(`controllers[${i}].doors.${no} : le detecteur ${det} est deja utilise par une autre porte`);
        detectors.add(det);
      }
      for (const a of c.actuators) {
        if (actuatorIds.has(a.id)) e.add(`controllers[${i}].actuators : l'actionneur ${a.id} est declare deux fois`);
        actuatorIds.add(a.id);
      }
      controllers.push(c);
    });
  }

  if (e.list.length > 0) throw new Error(`Configuration acces-zkteco invalide :\n - ${e.list.join('\n - ')}`);
  return { stateDir, host, port, allowFrom, controllers, thresholds, limits, push, timezones, sync };
}
