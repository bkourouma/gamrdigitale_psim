/**
 * Lecture et validation STRICTE de la configuration du module SIA : toute cle inconnue, toute valeur hors bornes
 * est refusee avec un message clair. Les cles de chiffrement ne figurent jamais dans les messages d'erreur.
 */
import { isIP } from 'node:net';
import type { DetectorState } from '../../module.ts';
import { PSIM_EVENTS, ruleFromOverride, type Override, type Overrides } from './codes.ts';
import { normalizeNumber } from './protocol.ts';

export interface AccountConfig {
  /** Numero de compte normalise (hexadecimal majuscule, 3 a 16 caracteres). */
  account: string;
  panelName: string;
  /** Cle AES (16, 24 ou 32 octets) ou `null` si le compte n'utilise pas le chiffrement. */
  key: Buffer | null;
  requireEncryption: boolean;
  allowMissingTimestamp: boolean;
  /** Zone normalisee (`7`) ou `*` -> id PSIM. */
  zones: Map<string, string>;
  /** Partition normalisee ou `*` -> id PSIM. */
  partitions: Map<string, string>;
  defaultId: string | null;
  /** 0 = pas de supervision de la centrale. */
  supervisionMs: number;
  overrides: Overrides;
}

export interface Limits {
  maxConnections: number;
  maxConnectionsPerAddress: number;
  frameTimeoutMs: number;
  idleTimeoutMs: number;
  perAddressPerMinute: number;
  perAccountPerMinute: number;
}

export interface SiaConfig {
  host: string;
  port: number;
  protocols: { tcp: boolean; udp: boolean };
  accounts: Map<string, AccountConfig>;
  maxClockSkewMs: number;
  forwardHeartbeat: boolean;
  limits: Limits;
}

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ACCOUNT_RE = /^[0-9A-Fa-f]{3,16}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const STATES: ReadonlySet<string> = new Set(['normal', 'prealarm', 'alarm', 'fault', 'offline']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Adresse « toutes les interfaces », quelle que soit son ecriture : 0.0.0.0, ::, ::0, 0:0:0:0:0:0:0:0, ::ffff:0.0.0.0...
 * (comparer seulement les chaines « 0.0.0.0 » et « :: » laissait passer les autres formes).
 */
export function anyInterface(host: string): boolean {
  if (isIP(host) === 4) return host.split('.').every((p) => Number(p) === 0);
  try {
    const h = new URL(`http://[${host}]/`).hostname;
    return h === '[::]' || h === '[::ffff:0:0]';
  } catch {
    return false;
  }
}

/** Affichage sur d'une valeur fournie par l'utilisateur dans un message d'erreur (jamais pour une cle). */
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

/** Cle de table zone / partition : `*` ou un numero (1 a 6 chiffres), normalise sans zeros de tete. */
function readMapping(v: unknown, where: string, e: Errors): Map<string, string> {
  const map = new Map<string, string>();
  if (v === undefined) return map;
  if (!isObject(v)) {
    e.add(`${where} doit etre un objet { "<numero ou *>": { "id": "<id PSIM>" } }`);
    return map;
  }
  for (const [k, entry] of Object.entries(v)) {
    const at = `${where}.${k}`;
    if (k !== '*' && !/^\d{1,6}$/.test(k)) {
      e.add(`${where} : ${show(k)} n'est ni un numero ni *`);
      continue;
    }
    if (!isObject(entry)) {
      e.add(`${at} doit etre un objet { "id": "<id PSIM>" }`);
      continue;
    }
    e.unknownKeys(entry, ['id', 'label'], at);
    if (typeof entry.id !== 'string' || !ID_RE.test(entry.id)) {
      e.add(`${at}.id doit etre un identifiant PSIM (lettres, chiffres, _ ou -, 32 caracteres au plus)`);
      continue;
    }
    const norm = k === '*' ? '*' : normalizeNumber(k);
    if (map.has(norm)) e.add(`${where} : ${show(k)} est defini deux fois`);
    map.set(norm, entry.id);
  }
  return map;
}

function readOverrides(v: unknown, where: string, e: Errors): Overrides {
  const res: Overrides = { sia: new Map(), cid: new Map() };
  if (v === undefined) return res;
  if (!isObject(v)) {
    e.add(`${where} doit etre un objet { "sia": {...}, "cid": {...} }`);
    return res;
  }
  e.unknownKeys(v, ['sia', 'cid'], where);
  for (const format of ['sia', 'cid'] as const) {
    const table = v[format];
    if (table === undefined) continue;
    if (!isObject(table)) {
      e.add(`${where}.${format} doit etre un objet`);
      continue;
    }
    for (const [code, o] of Object.entries(table)) {
      const at = `${where}.${format}.${code}`;
      const codeOk = format === 'sia' ? /^[A-Z]{2}$/.test(code) : /^\d{3}$/.test(code);
      if (!codeOk) {
        e.add(`${where}.${format} : code ${show(code)} invalide (${format === 'sia' ? '2 lettres majuscules, ex. BA' : '3 chiffres, ex. 130'})`);
        continue;
      }
      const rule = readOverride(o, at, e);
      if (rule) res[format].set(code, ruleFromOverride(code, rule));
    }
  }
  return res;
}

function readOverride(o: unknown, at: string, e: Errors): Override | null {
  if (o === 'ignore') return 'ignore';
  if (!isObject(o)) {
    e.add(`${at} doit valoir "ignore" ou { "event": "..." } ou { "state": "..." }`);
    return null;
  }
  e.unknownKeys(o, ['event', 'state', 'kind', 'zone'], at);
  if ((o.event === undefined) === (o.state === undefined)) {
    e.add(`${at} : indiquer soit "event", soit "state"`);
    return null;
  }
  if (o.event !== undefined && (typeof o.event !== 'string' || !Object.hasOwn(PSIM_EVENTS, o.event))) {
    e.add(`${at}.event inconnu du PSIM (${Object.keys(PSIM_EVENTS).join(', ')})`);
    return null;
  }
  if (o.state !== undefined && (typeof o.state !== 'string' || !STATES.has(o.state))) {
    e.add(`${at}.state doit etre normal, prealarm, alarm, fault ou offline`);
    return null;
  }
  if (o.kind !== undefined && !['alarm', 'fault', 'restore', 'heartbeat'].includes(o.kind as string)) {
    e.add(`${at}.kind doit etre alarm, fault, restore ou heartbeat`);
    return null;
  }
  if (o.zone !== undefined && typeof o.zone !== 'boolean') {
    e.add(`${at}.zone doit valoir true ou false`);
    return null;
  }
  return {
    ...(o.event !== undefined ? { event: o.event as string } : { state: o.state as DetectorState }),
    ...(o.kind !== undefined ? { kind: o.kind as 'alarm' | 'fault' | 'restore' | 'heartbeat' } : {}),
    ...(o.zone !== undefined ? { zone: o.zone as boolean } : {}),
  };
}

/** Cle AES : hexadecimal (32, 48 ou 64 caracteres) par defaut, ou texte de 16, 24 ou 32 caracteres si keyFormat = ascii. */
function readKey(raw: string, format: 'hex' | 'ascii', where: string, e: Errors): Buffer | null {
  if (format === 'hex') {
    if (!/^[0-9A-Fa-f]+$/.test(raw) || ![32, 48, 64].includes(raw.length)) {
      e.add(`${where} : la cle doit comporter 32, 48 ou 64 caracteres hexadecimaux (AES 128, 192 ou 256 bits)`);
      return null;
    }
    return Buffer.from(raw, 'hex');
  }
  if (![16, 24, 32].includes(raw.length) || !/^[\x21-\x7e]+$/.test(raw)) {
    e.add(`${where} : la cle (keyFormat ascii) doit comporter 16, 24 ou 32 caracteres imprimables`);
    return null;
  }
  return Buffer.from(raw, 'latin1');
}

function readAccount(acct: string, v: unknown, supervisionDefault: number, e: Errors, env: NodeJS.ProcessEnv): AccountConfig | null {
  const where = `accounts.${acct}`;
  if (!ACCOUNT_RE.test(acct)) {
    e.add(`accounts : numero de compte ${show(acct)} invalide (3 a 16 caracteres hexadecimaux)`);
    return null;
  }
  if (!isObject(v)) {
    e.add(`${where} doit etre un objet`);
    return null;
  }
  e.unknownKeys(
    v,
    ['key', 'keyEnv', 'keyFormat', 'requireEncryption', 'allowMissingTimestamp', 'panelName', 'zones', 'partitions', 'defaultId', 'supervisionS', 'overrides'],
    where,
  );
  let keyFormat: 'hex' | 'ascii' = 'hex';
  if (v.keyFormat !== undefined) {
    if (v.keyFormat !== 'hex' && v.keyFormat !== 'ascii') e.add(`${where}.keyFormat doit valoir "hex" ou "ascii"`);
    else keyFormat = v.keyFormat;
  }
  let key: Buffer | null = null;
  if (v.key !== undefined && v.keyEnv !== undefined) e.add(`${where} : indiquer key OU keyEnv, pas les deux`);
  else if (v.key !== undefined) {
    if (typeof v.key !== 'string') e.add(`${where}.key doit etre une chaine`);
    else key = readKey(v.key, keyFormat, `${where}.key`, e);
  } else if (v.keyEnv !== undefined) {
    if (typeof v.keyEnv !== 'string' || !ENV_RE.test(v.keyEnv)) e.add(`${where}.keyEnv doit etre un nom de variable d'environnement`);
    else {
      const raw = env[v.keyEnv];
      if (raw === undefined || raw === '') e.add(`${where}.keyEnv : la variable d'environnement ${v.keyEnv} n'est pas definie`);
      else key = readKey(raw.trim(), keyFormat, `${where}.keyEnv (${v.keyEnv})`, e);
    }
  }
  const requireEncryption = e.bool(v.requireEncryption, `${where}.requireEncryption`, key !== null || v.key !== undefined || v.keyEnv !== undefined);
  if (requireEncryption && key === null && v.key === undefined && v.keyEnv === undefined) e.add(`${where} : requireEncryption exige une cle (key ou keyEnv)`);
  let panelName = `centrale ${acct.toUpperCase()}`;
  if (v.panelName !== undefined) {
    if (typeof v.panelName !== 'string' || !/^[\x20-\x7e\xc0-\xff]{1,64}$/.test(v.panelName)) e.add(`${where}.panelName doit etre un texte de 1 a 64 caracteres`);
    else panelName = v.panelName;
  }
  let defaultId: string | null = null;
  if (v.defaultId !== undefined) {
    if (typeof v.defaultId !== 'string' || !ID_RE.test(v.defaultId)) e.add(`${where}.defaultId doit etre un identifiant PSIM (lettres, chiffres, _ ou -, 32 caracteres au plus)`);
    else defaultId = v.defaultId;
  }
  const zones = readMapping(v.zones, `${where}.zones`, e);
  const partitions = readMapping(v.partitions, `${where}.partitions`, e);
  if (zones.size === 0 && partitions.size === 0 && defaultId === null) e.add(`${where} : aucune destination (zones, partitions ou defaultId)`);
  const supervisionS = e.number(v.supervisionS, `${where}.supervisionS`, 0, 86400, supervisionDefault, false);
  return {
    account: acct.toUpperCase(),
    panelName,
    key,
    requireEncryption,
    allowMissingTimestamp: e.bool(v.allowMissingTimestamp, `${where}.allowMissingTimestamp`, false),
    zones,
    partitions,
    defaultId,
    supervisionMs: Math.round(supervisionS * 1000),
    overrides: readOverrides(v.overrides, `${where}.overrides`, e),
  };
}

/**
 * Valide la configuration ; leve une erreur listant TOUS les problemes. `env` permet de lire les cles
 * (`keyEnv`) depuis les variables d'environnement.
 */
export function parseConfig(raw: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): SiaConfig & { overrides: Overrides } {
  const e = new Errors();
  if (!isObject(raw)) throw new Error('Configuration SIA invalide : un objet est attendu');
  e.unknownKeys(raw, ['listen', 'accounts', 'maxClockSkewS', 'supervisionS', 'forwardHeartbeat', 'limits', 'overrides'], 'sia');

  let host = '';
  let port = 0;
  const protocols = { tcp: true, udp: false };
  if (!isObject(raw.listen)) e.add('listen est obligatoire : { "host": "<adresse IP de l\'interface>", "port": <port>, "protocols": ["tcp", "udp"] }');
  else {
    const l = raw.listen;
    e.unknownKeys(l, ['host', 'port', 'protocols', 'allowAnyInterface'], 'listen');
    const any = e.bool(l.allowAnyInterface, 'listen.allowAnyInterface', false);
    if (typeof l.host !== 'string' || isIP(l.host) === 0) e.add("listen.host doit etre l'adresse IP de l'interface d'ecoute (ex. 192.168.1.10) ; aucune valeur par defaut");
    else if (anyInterface(l.host) && !any) e.add(`listen.host ${l.host} ecoute sur TOUTES les interfaces : choisir l'adresse d'une interface, ou ajouter "allowAnyInterface": true en connaissance de cause`);
    else host = l.host;
    if (typeof l.port !== 'number' || !Number.isInteger(l.port) || l.port < 0 || l.port > 65535) e.add('listen.port doit etre un numero de port (1 a 65535)');
    else port = l.port;
    if (l.protocols !== undefined) {
      if (!Array.isArray(l.protocols) || l.protocols.length === 0 || l.protocols.length > 2 || l.protocols.some((p) => p !== 'tcp' && p !== 'udp')) {
        e.add('listen.protocols doit etre une liste parmi "tcp" et "udp" (ex. ["tcp"])');
      } else {
        protocols.tcp = l.protocols.includes('tcp');
        protocols.udp = l.protocols.includes('udp');
      }
    }
  }

  const maxClockSkewS = e.number(raw.maxClockSkewS, 'maxClockSkewS', 1, 3600, 20);
  const supervisionS = e.number(raw.supervisionS, 'supervisionS', 0, 86400, 0, false);
  const forwardHeartbeat = e.bool(raw.forwardHeartbeat, 'forwardHeartbeat', true);

  const l = raw.limits === undefined ? {} : raw.limits;
  if (!isObject(l)) e.add('limits doit etre un objet');
  const lim = isObject(l) ? l : {};
  e.unknownKeys(lim, ['maxConnections', 'maxConnectionsPerAddress', 'frameTimeoutS', 'idleTimeoutS', 'perAddressPerMinute', 'perAccountPerMinute'], 'limits');
  const limits: Limits = {
    maxConnections: e.number(lim.maxConnections, 'limits.maxConnections', 1, 10000, 64),
    maxConnectionsPerAddress: e.number(lim.maxConnectionsPerAddress, 'limits.maxConnectionsPerAddress', 1, 1000, 8),
    frameTimeoutMs: Math.round(e.number(lim.frameTimeoutS, 'limits.frameTimeoutS', 0.05, 60, 10, false) * 1000),
    idleTimeoutMs: Math.round(e.number(lim.idleTimeoutS, 'limits.idleTimeoutS', 0.1, 3600, 120, false) * 1000),
    perAddressPerMinute: e.number(lim.perAddressPerMinute, 'limits.perAddressPerMinute', 1, 100000, 240),
    perAccountPerMinute: e.number(lim.perAccountPerMinute, 'limits.perAccountPerMinute', 1, 100000, 240),
  };

  const accounts = new Map<string, AccountConfig>();
  if (!isObject(raw.accounts) || Object.keys(raw.accounts).length === 0) e.add('accounts est obligatoire : au moins une centrale { "<numero de compte>": { ... } }');
  else {
    if (Object.keys(raw.accounts).length > 1000) e.add('accounts : 1000 centrales au plus');
    for (const [acct, v] of Object.entries(raw.accounts).slice(0, 1000)) {
      const a = readAccount(acct, v, supervisionS, e, env);
      if (!a) continue;
      if (accounts.has(a.account)) e.add(`accounts : le compte ${a.account} est defini deux fois (majuscules / minuscules)`);
      accounts.set(a.account, a);
    }
  }
  const overrides = readOverrides(raw.overrides, 'overrides', e);

  if (e.list.length > 0) throw new Error(`Configuration SIA invalide :\n - ${e.list.join('\n - ')}`);
  return { host, port, protocols, accounts, maxClockSkewMs: maxClockSkewS * 1000, forwardHeartbeat, limits, overrides };
}


