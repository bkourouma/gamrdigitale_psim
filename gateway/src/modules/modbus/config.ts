import { isIP } from 'node:net';
import type { DetectorState } from '../../module.ts';

/**
 * Configuration du module Modbus : lecture stricte. Toute erreur (cle inconnue, adresse hors plage, doublon...) est
 * collectee puis signalee en une seule fois, en francais, pour que l'installateur corrige tout d'un coup.
 */

export type PointType = 'discrete' | 'coil' | 'holding' | 'input';
export type DataType = 'uint16' | 'int16' | 'uint32' | 'int32' | 'float32';
export type Order = 'big' | 'little';
export type CompareOp = 'gt' | 'ge' | 'lt' | 'le' | 'eq' | 'ne';
/** bit : entree/bobine ; regbit : un bit d'un registre ; compare : registre compare a un seuil ; value : mesure. */
export type PointKind = 'bit' | 'regbit' | 'compare' | 'value';

/** Evenements que le PSIM reconnait (ceux utiles a une entree Modbus). */
export const KNOWN_EVENTS: readonly string[] = [
  'intrusion', 'motion', 'glass_break', 'tamper', 'panic', 'door_forced', 'leak', 'flood', 'over_temperature',
  'door_held_open', 'normal', 'clear', 'restored', 'door_closed', 'alarm_reset', 'dry', 'fault', 'low_battery',
  'heartbeat', 'ping', 'door_opened', 'gas', 'co', 'power_loss', 'power_restored', 'vibration', 'line_crossing', 'sos',
];
export const KNOWN_STATES: readonly DetectorState[] = ['normal', 'prealarm', 'alarm', 'fault', 'offline'];

/** Ce que l'on envoie au PSIM : un evenement OU un etat. */
export interface Action {
  event?: string;
  state?: DetectorState;
}

export interface Current4_20 {
  rawMin: number;
  rawMax: number;
  engMin: number;
  engMax: number;
  /** En dessous (mA) : boucle coupee -> defaut. */
  loopBreakMa: number;
  /** Au dessus (mA) : hors plage -> defaut. null = pas de controle. */
  overRangeMa: number | null;
}

export interface PointConfig {
  id: string;
  type: PointType;
  address: number;
  /** Code fonction de lecture : 1 coil, 2 discrete, 3 holding, 4 input. */
  fn: 1 | 2 | 3 | 4;
  kind: PointKind;
  /** Nombre de bits (bit) ou de mots (registres) lus pour ce point. */
  span: number;
  dataType: DataType;
  wordOrder: Order;
  byteOrder: Order;
  scale: number;
  offset: number;
  decimals: number;
  unit: string;
  deadband: number;
  minIntervalMs: number;
  current4_20: Current4_20 | null;
  bit: number;
  compare: { op: CompareOp; value: number } | null;
  onTrue: Action | null;
  onFalse: Action | null;
  invert: boolean;
  debounceMs: number;
  heartbeatMs: number;
}

export interface DeviceConfig {
  name: string;
  host: string;
  port: number;
  unitId: number;
  pollMs: number;
  timeoutMs: number;
  failThreshold: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  maxGap: number;
  maxRegisters: number;
  maxBits: number;
  heartbeatMs: number;
  points: PointConfig[];
}

export interface ModbusConfig {
  devices: DeviceConfig[];
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Configuration modbus invalide :\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const DATA_TYPES: readonly DataType[] = ['uint16', 'int16', 'uint32', 'int32', 'float32'];
const COMPARE_OPS: readonly CompareOp[] = ['gt', 'ge', 'lt', 'le', 'eq', 'ne'];
const MAX_ABS = 1e9;

const DEVICE_KEYS = ['name', 'host', 'port', 'unitId', 'pollMs', 'timeoutMs', 'failThreshold', 'reconnectMinMs', 'reconnectMaxMs', 'maxGap', 'maxRegisters', 'maxBits', 'heartbeatMs', 'points'];
const BIT_KEYS = ['id', 'type', 'address', 'onTrue', 'onFalse', 'invert', 'debounceMs', 'heartbeatMs'];
const REG_COMMON = ['id', 'type', 'address', 'mode', 'heartbeatMs'];
const REG_VALUE_KEYS = [...REG_COMMON, 'dataType', 'wordOrder', 'byteOrder', 'scale', 'offset', 'decimals', 'unit', 'deadband', 'minIntervalMs', 'current4_20'];
const REG_BIT_KEYS = [...REG_COMMON, 'byteOrder', 'bit', 'onTrue', 'onFalse', 'invert', 'debounceMs'];
const REG_COMPARE_KEYS = [...REG_COMMON, 'dataType', 'wordOrder', 'byteOrder', 'scale', 'offset', 'decimals', 'unit', 'compare', 'onTrue', 'onFalse', 'invert', 'debounceMs'];
const C420_KEYS = ['rawMin', 'rawMax', 'engMin', 'engMax', 'loopBreakMa', 'overRangeMa'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function wordSpan(t: DataType): 1 | 2 {
  return t === 'uint16' || t === 'int16' ? 1 : 2;
}

interface NumOpts {
  def?: number;
  min: number;
  max: number;
  int?: boolean;
}

class Reader {
  readonly problems: string[];
  constructor(problems: string[]) {
    this.problems = problems;
  }

  err(where: string, text: string): void {
    this.problems.push(`${where} : ${text}`);
  }

  keys(o: Obj, allowed: readonly string[], where: string): void {
    for (const k of Object.keys(o)) {
      if (!allowed.includes(k)) this.err(where, `cle inconnue « ${k} » (cles permises ici : ${allowed.join(', ')})`);
    }
  }

  num(o: Obj, key: string, where: string, opts: NumOpts): number {
    const v = o[key];
    const fallback = opts.def ?? opts.min;
    if (v === undefined) {
      if (opts.def === undefined) this.err(where, `« ${key} » est obligatoire`);
      return fallback;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.err(where, `« ${key} » doit etre un nombre`);
      return fallback;
    }
    if (opts.int && !Number.isInteger(v)) {
      this.err(where, `« ${key} » doit etre un entier`);
      return fallback;
    }
    if (v < opts.min || v > opts.max) {
      this.err(where, `« ${key} » doit etre compris entre ${opts.min} et ${opts.max} (recu ${v})`);
      return fallback;
    }
    return v;
  }

  oneOf<T extends string>(o: Obj, key: string, where: string, allowed: readonly T[], def: T | null): T {
    const v = o[key];
    if (v === undefined) {
      if (def === null) this.err(where, `« ${key} » est obligatoire (${allowed.join(', ')})`);
      return def ?? allowed[0];
    }
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      this.err(where, `« ${key} » doit valoir ${allowed.join(', ')}`);
      return def ?? allowed[0];
    }
    return v as T;
  }

  bool(o: Obj, key: string, where: string, def: boolean): boolean {
    const v = o[key];
    if (v === undefined) return def;
    if (typeof v !== 'boolean') {
      this.err(where, `« ${key} » doit etre true ou false`);
      return def;
    }
    return v;
  }

  action(o: Obj, key: string, where: string): Action | null {
    const v = o[key];
    if (v === undefined) return null;
    const w = `${where}.${key}`;
    if (!isObj(v)) {
      this.err(w, 'doit etre un objet { event } ou { state }');
      return null;
    }
    this.keys(v, ['event', 'state'], w);
    const hasEvent = v.event !== undefined;
    const hasState = v.state !== undefined;
    if (hasEvent === hasState) {
      this.err(w, 'indiquer exactement un des deux : « event » ou « state »');
      return null;
    }
    if (hasEvent) {
      if (typeof v.event !== 'string' || !KNOWN_EVENTS.includes(v.event)) {
        this.err(w, `evenement inconnu « ${String(v.event)} » (permis : ${KNOWN_EVENTS.join(', ')})`);
        return null;
      }
      return { event: v.event };
    }
    if (typeof v.state !== 'string' || !(KNOWN_STATES as readonly string[]).includes(v.state)) {
      this.err(w, `etat inconnu « ${String(v.state)} » (permis : ${KNOWN_STATES.join(', ')})`);
      return null;
    }
    return { state: v.state as DetectorState };
  }
}

function heartbeatMs(r: Reader, o: Obj, where: string, def: number): number {
  const v = o.heartbeatMs;
  if (v === undefined) return def;
  if (v === 0) return 0;
  return r.num(o, 'heartbeatMs', where, { min: 50, max: 86_400_000, int: true, def });
}

function parsePoint(r: Reader, raw: unknown, where: string, dev: DeviceConfig): PointConfig | null {
  if (!isObj(raw)) {
    r.err(where, 'un point doit etre un objet');
    return null;
  }
  const idRaw = raw.id;
  const label = typeof idRaw === 'string' && idRaw ? `${where} (${idRaw})` : where;
  if (typeof idRaw !== 'string' || !ID_RE.test(idRaw)) r.err(label, '« id » obligatoire : 1 a 32 caracteres parmi lettres, chiffres, _ et -');
  const type = r.oneOf<PointType>(raw, 'type', label, ['discrete', 'coil', 'holding', 'input'], null);
  const address = r.num(raw, 'address', label, { min: 0, max: 65535, int: true });

  const p: PointConfig = {
    id: typeof idRaw === 'string' ? idRaw : '',
    type,
    address,
    fn: type === 'coil' ? 1 : type === 'discrete' ? 2 : type === 'holding' ? 3 : 4,
    kind: 'bit',
    span: 1,
    dataType: 'uint16',
    wordOrder: 'big',
    byteOrder: 'big',
    scale: 1,
    offset: 0,
    decimals: 2,
    unit: '',
    deadband: 0,
    minIntervalMs: 0,
    current4_20: null,
    bit: 0,
    compare: null,
    onTrue: null,
    onFalse: null,
    invert: false,
    debounceMs: 0,
    heartbeatMs: dev.heartbeatMs,
  };

  const isBitType = type === 'discrete' || type === 'coil';
  if (isBitType) {
    r.keys(raw, BIT_KEYS, label);
  } else {
    const mode = r.oneOf<'value' | 'bit' | 'compare'>(raw, 'mode', label, ['value', 'bit', 'compare'], 'value');
    p.kind = mode === 'value' ? 'value' : mode === 'bit' ? 'regbit' : 'compare';
    r.keys(raw, p.kind === 'value' ? REG_VALUE_KEYS : p.kind === 'regbit' ? REG_BIT_KEYS : REG_COMPARE_KEYS, label);
    if (p.kind !== 'regbit') {
      p.dataType = r.oneOf<DataType>(raw, 'dataType', label, DATA_TYPES, 'uint16');
      p.wordOrder = r.oneOf<Order>(raw, 'wordOrder', label, ['big', 'little'], 'big');
      p.scale = r.num(raw, 'scale', label, { def: 1, min: -MAX_ABS, max: MAX_ABS });
      p.offset = r.num(raw, 'offset', label, { def: 0, min: -MAX_ABS, max: MAX_ABS });
      p.decimals = r.num(raw, 'decimals', label, { def: 2, min: 0, max: 9, int: true });
    }
    p.byteOrder = r.oneOf<Order>(raw, 'byteOrder', label, ['big', 'little'], 'big');
    if (raw.unit !== undefined) {
      if (typeof raw.unit !== 'string' || raw.unit.length > 16) r.err(label, '« unit » doit etre un texte de 16 caracteres au plus');
      else p.unit = raw.unit;
    }
    p.span = p.kind === 'regbit' ? 1 : wordSpan(p.dataType);
  }
  if (address + p.span - 1 > 65535) r.err(label, `l'adresse ${address} + ${p.span} mot(s) depasse 65535`);

  if (p.kind === 'value') {
    p.deadband = r.num(raw, 'deadband', label, { def: 0, min: 0, max: MAX_ABS });
    p.minIntervalMs = r.num(raw, 'minIntervalMs', label, { def: 5000, min: 0, max: 86_400_000, int: true });
    const c = raw.current4_20;
    if (c !== undefined) {
      const w = `${label}.current4_20`;
      if (!isObj(c)) {
        r.err(w, 'doit etre un objet { rawMin, rawMax, engMin, engMax }');
      } else {
        r.keys(c, C420_KEYS, w);
        const rawMin = r.num(c, 'rawMin', w, { min: -MAX_ABS, max: MAX_ABS });
        const rawMax = r.num(c, 'rawMax', w, { min: -MAX_ABS, max: MAX_ABS });
        const engMin = r.num(c, 'engMin', w, { min: -MAX_ABS, max: MAX_ABS });
        const engMax = r.num(c, 'engMax', w, { min: -MAX_ABS, max: MAX_ABS });
        const loopBreakMa = r.num(c, 'loopBreakMa', w, { def: 3.6, min: 0, max: 4 });
        let overRangeMa: number | null = 21;
        if (c.overRangeMa === null) overRangeMa = null;
        else overRangeMa = r.num(c, 'overRangeMa', w, { def: 21, min: 20, max: 100 });
        if (rawMin >= rawMax) r.err(w, '« rawMin » doit etre inferieur a « rawMax » (valeurs brutes pour 4 mA et 20 mA)');
        if (engMin === engMax) r.err(w, '« engMin » et « engMax » doivent etre differents');
        if (raw.scale !== undefined || raw.offset !== undefined) r.err(label, '« scale » et « offset » ne se combinent pas avec current4_20 (la mise a l\'echelle est dans current4_20)');
        p.current4_20 = { rawMin, rawMax, engMin, engMax, loopBreakMa, overRangeMa };
      }
    }
  } else {
    if (p.kind === 'regbit') p.bit = r.num(raw, 'bit', label, { min: 0, max: 15, int: true });
    if (p.kind === 'compare') {
      const c = raw.compare;
      const w = `${label}.compare`;
      if (!isObj(c)) {
        r.err(label, '« compare » est obligatoire : { op: gt|ge|lt|le|eq|ne, value: nombre }');
      } else {
        r.keys(c, ['op', 'value'], w);
        const op = r.oneOf<CompareOp>(c, 'op', w, COMPARE_OPS, null);
        const value = r.num(c, 'value', w, { min: -MAX_ABS, max: MAX_ABS });
        p.compare = { op, value };
      }
    }
    p.onTrue = r.action(raw, 'onTrue', label);
    if (p.onTrue === null && raw.onTrue === undefined) r.err(label, '« onTrue » est obligatoire (ex. { "event": "intrusion" })');
    p.onFalse = r.action(raw, 'onFalse', label) ?? { event: 'clear' };
    p.invert = r.bool(raw, 'invert', label, false);
    p.debounceMs = r.num(raw, 'debounceMs', label, { def: 0, min: 0, max: 3_600_000, int: true });
  }
  p.heartbeatMs = heartbeatMs(r, raw, label, dev.heartbeatMs);
  return p;
}

function parseDevice(r: Reader, raw: unknown, where: string): DeviceConfig | null {
  if (!isObj(raw)) {
    r.err(where, 'un equipement doit etre un objet');
    return null;
  }
  const nameRaw = raw.name;
  const label = typeof nameRaw === 'string' && nameRaw ? `${where} (${nameRaw})` : where;
  r.keys(raw, DEVICE_KEYS, label);
  if (typeof nameRaw !== 'string' || nameRaw.trim() === '' || nameRaw.length > 64) r.err(label, '« name » obligatoire (texte de 1 a 64 caracteres)');

  const hostRaw = raw.host;
  if (typeof hostRaw !== 'string' || hostRaw === '') r.err(label, '« host » obligatoire (adresse IP ou nom de machine)');
  else if (isIP(hostRaw) === 0 && !HOST_RE.test(hostRaw)) r.err(label, `« host » invalide « ${hostRaw} » : adresse IP ou nom de machine attendu (sans http://, sans port)`);

  const reconnectMinMs = r.num(raw, 'reconnectMinMs', label, { def: 1000, min: 10, max: 600_000, int: true });
  const reconnectMaxMs = r.num(raw, 'reconnectMaxMs', label, { def: 30_000, min: 10, max: 3_600_000, int: true });
  if (reconnectMaxMs < reconnectMinMs) r.err(label, '« reconnectMaxMs » doit etre superieur ou egal a « reconnectMinMs »');

  const dev: DeviceConfig = {
    name: typeof nameRaw === 'string' ? nameRaw : '',
    host: typeof hostRaw === 'string' ? hostRaw : '',
    port: r.num(raw, 'port', label, { def: 502, min: 1, max: 65535, int: true }),
    unitId: r.num(raw, 'unitId', label, { def: 1, min: 0, max: 255, int: true }),
    pollMs: r.num(raw, 'pollMs', label, { def: 1000, min: 10, max: 3_600_000, int: true }),
    timeoutMs: r.num(raw, 'timeoutMs', label, { def: 2000, min: 20, max: 60_000, int: true }),
    failThreshold: r.num(raw, 'failThreshold', label, { def: 3, min: 1, max: 100, int: true }),
    reconnectMinMs,
    reconnectMaxMs,
    maxGap: r.num(raw, 'maxGap', label, { def: 0, min: 0, max: 125, int: true }),
    maxRegisters: r.num(raw, 'maxRegisters', label, { def: 100, min: 1, max: 125, int: true }),
    maxBits: r.num(raw, 'maxBits', label, { def: 1000, min: 1, max: 2000, int: true }),
    heartbeatMs: heartbeatMs(r, raw, label, 30_000),
    points: [],
  };

  const pts = raw.points;
  if (!Array.isArray(pts) || pts.length === 0) {
    r.err(label, '« points » doit etre une liste non vide');
  } else {
    pts.forEach((p, i) => {
      const parsed = parsePoint(r, p, `${label}.points[${i}]`, dev);
      if (parsed) dev.points.push(parsed);
    });
  }
  return dev;
}

/** Valide et normalise la configuration. Leve ConfigError (avec toutes les erreurs) si elle est incorrecte. */
export function parseConfig(config: unknown): ModbusConfig {
  const problems: string[] = [];
  const r = new Reader(problems);
  if (!isObj(config)) throw new ConfigError(['la configuration doit etre un objet { "devices": [...] }']);
  r.keys(config, ['devices'], 'configuration');
  const devs = config.devices;
  const out: DeviceConfig[] = [];
  if (!Array.isArray(devs) || devs.length === 0) {
    r.err('configuration', '« devices » doit etre une liste non vide');
  } else {
    devs.forEach((d, i) => {
      const parsed = parseDevice(r, d, `devices[${i}]`);
      if (parsed) out.push(parsed);
    });
  }

  const names = new Map<string, number>();
  const ids = new Map<string, string>();
  for (const d of out) {
    if (d.name) {
      if (names.has(d.name)) r.err(`equipement « ${d.name} »`, 'nom en double');
      names.set(d.name, 1);
    }
    for (const p of d.points) {
      if (!p.id) continue;
      const prev = ids.get(p.id);
      if (prev !== undefined) r.err(`point « ${p.id} »`, `identifiant en double (deja utilise sur « ${prev} »)`);
      else ids.set(p.id, d.name);
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return { devices: out };
}
