/** Configuration du module `ups` : types et validation stricte (messages en francais pour l'installateur). */

export type MeasureKey = 'charge' | 'runtime' | 'load' | 'battery_voltage' | 'input_voltage' | 'temperature';
export type IdKey = 'status' | MeasureKey;

export const MEASURE_KEYS: readonly MeasureKey[] = ['charge', 'runtime', 'load', 'battery_voltage', 'input_voltage', 'temperature'];
export const ID_KEYS: readonly IdKey[] = ['status', ...MEASURE_KEYS];

export interface UpsConfig {
  name: string;
  transport: 'nut' | 'snmp';
  host: string;
  port: number;
  /** NUT : nom de l'onduleur chez upsd (decouvert par LIST UPS si absent). */
  upsName: string | null;
  /** SNMP : communaute v1/v2c. Ne jamais journaliser. */
  community: string;
  version: '1' | '2c';
  /** SNMP : numero de ligne (phase) lu pour la tension d'entree et la charge. */
  line: number;
  pollMs: number;
  timeoutMs: number;
  maxFailures: number;
  heartbeatMs: number;
  minIntervalMs: number;
  runtimeUnit: 'min' | 's';
  deadband: Record<MeasureKey, number>;
  ids: Partial<Record<IdKey, string>>;
}

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const NUT_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const HOST_RE = /^[A-Za-z0-9._:-]{1,253}$/;

const ALLOWED_KEYS = new Set([
  'name', 'transport', 'host', 'port', 'upsName', 'community', 'version', 'line', 'pollMs', 'timeoutMs',
  'maxFailures', 'heartbeatMs', 'minIntervalMs', 'runtimeUnit', 'deadband', 'ids',
]);

export const NUT_NAME_PATTERN = NUT_NAME_RE;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(where: string, text: string): never {
  throw new Error(`Module ups, ${where} : ${text}`);
}

function intIn(raw: unknown, where: string, field: string, min: number, max: number, def: number): number {
  if (raw === undefined) return def;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    fail(where, `"${field}" doit etre un entier entre ${min} et ${max}`);
  }
  return raw;
}

/** Valide la section de configuration du module et renvoie les onduleurs normalises. Leve une Error claire. */
export function parseConfig(config: Record<string, unknown>): UpsConfig[] {
  if (!isRecord(config)) fail('configuration', 'section absente ou invalide');
  for (const k of Object.keys(config)) {
    if (k !== 'ups') fail('configuration', `cle inconnue "${k}" (seule la liste "ups" est attendue)`);
  }
  const list = config.ups;
  if (!Array.isArray(list) || list.length === 0) fail('configuration', 'la liste "ups" doit contenir au moins un onduleur');
  if (list.length > 32) fail('configuration', 'au plus 32 onduleurs par passerelle');

  const names = new Set<string>();
  const usedIds = new Map<string, string>();
  const out: UpsConfig[] = [];

  list.forEach((raw, index) => {
    let where = `onduleur no ${index + 1}`;
    if (!isRecord(raw)) fail(where, 'un objet est attendu');
    if (typeof raw.name === 'string' && ID_RE.test(raw.name)) where = `onduleur "${raw.name}"`;
    for (const k of Object.keys(raw)) {
      if (!ALLOWED_KEYS.has(k)) fail(where, `cle inconnue "${k}"`);
    }

    const name = raw.name;
    if (typeof name !== 'string' || !ID_RE.test(name)) fail(where, '"name" est obligatoire (1 a 32 caracteres : lettres, chiffres, _ et -)');
    if (names.has(name)) fail(where, `le nom "${name}" est deja utilise`);
    names.add(name);

    const transport = raw.transport;
    if (transport !== 'nut' && transport !== 'snmp') fail(where, '"transport" doit valoir "nut" ou "snmp"');

    const host = raw.host;
    if (typeof host !== 'string' || !HOST_RE.test(host)) fail(where, '"host" est obligatoire (adresse IP ou nom de machine, sans espace)');

    const port = intIn(raw.port, where, 'port', 1, 65535, transport === 'nut' ? 3493 : 161);

    let upsName: string | null = null;
    if (raw.upsName !== undefined) {
      if (transport !== 'nut') fail(where, '"upsName" ne s\'applique qu\'au transport "nut"');
      if (typeof raw.upsName !== 'string' || !NUT_NAME_RE.test(raw.upsName)) {
        fail(where, '"upsName" invalide (1 a 64 caracteres : lettres, chiffres, point, _ et -)');
      }
      upsName = raw.upsName;
    }

    let community = 'public';
    let version: '1' | '2c' = '2c';
    let line = 1;
    if (transport === 'snmp') {
      if (raw.community !== undefined) {
        if (typeof raw.community !== 'string' || raw.community.length < 1 || raw.community.length > 64 || !/^[\x21-\x7e]+$/.test(raw.community)) {
          fail(where, '"community" invalide (1 a 64 caracteres imprimables, sans espace)');
        }
        community = raw.community;
      }
      if (raw.version !== undefined) {
        if (raw.version !== '1' && raw.version !== '2c') fail(where, '"version" doit valoir "1" ou "2c" (entre guillemets)');
        version = raw.version;
      }
      line = intIn(raw.line, where, 'line', 1, 64, 1);
    } else {
      for (const k of ['community', 'version', 'line'] as const) {
        if (raw[k] !== undefined) fail(where, `"${k}" ne s'applique qu'au transport "snmp"`);
      }
    }

    const pollMs = intIn(raw.pollMs, where, 'pollMs', 100, 3_600_000, 15_000);
    const timeoutMs = intIn(raw.timeoutMs, where, 'timeoutMs', 50, 60_000, 3_000);
    const maxFailures = intIn(raw.maxFailures, where, 'maxFailures', 1, 100, 3);
    let heartbeatMs = 300_000;
    if (raw.heartbeatMs !== undefined) {
      if (raw.heartbeatMs === 0) heartbeatMs = 0;
      else heartbeatMs = intIn(raw.heartbeatMs, where, 'heartbeatMs', 1_000, 86_400_000, 300_000);
    }
    const minIntervalMs = intIn(raw.minIntervalMs, where, 'minIntervalMs', 0, 86_400_000, 10_000);

    let runtimeUnit: 'min' | 's' = 'min';
    if (raw.runtimeUnit !== undefined) {
      if (raw.runtimeUnit !== 'min' && raw.runtimeUnit !== 's') fail(where, '"runtimeUnit" doit valoir "min" ou "s"');
      runtimeUnit = raw.runtimeUnit;
    }

    const deadband: Record<MeasureKey, number> = {
      charge: 2,
      runtime: runtimeUnit === 'min' ? 1 : 60,
      load: 5,
      battery_voltage: 0.5,
      input_voltage: 3,
      temperature: 1,
    };
    if (raw.deadband !== undefined) {
      if (!isRecord(raw.deadband)) fail(where, '"deadband" doit etre un objet {grandeur: ecart}');
      for (const [k, v] of Object.entries(raw.deadband)) {
        if (!(MEASURE_KEYS as readonly string[]).includes(k)) fail(where, `"deadband" : grandeur inconnue "${k}" (attendu : ${MEASURE_KEYS.join(', ')})`);
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e6) fail(where, `"deadband.${k}" doit etre un nombre positif ou nul`);
        deadband[k as MeasureKey] = v;
      }
    }

    if (!isRecord(raw.ids)) fail(where, '"ids" est obligatoire : {status, charge, runtime, load, battery_voltage, input_voltage, temperature} -> identifiant PSIM');
    const ids: Partial<Record<IdKey, string>> = {};
    for (const [k, v] of Object.entries(raw.ids)) {
      if (!(ID_KEYS as readonly string[]).includes(k)) fail(where, `"ids" : grandeur inconnue "${k}" (attendu : ${ID_KEYS.join(', ')})`);
      if (typeof v !== 'string' || !ID_RE.test(v)) fail(where, `"ids.${k}" doit etre un identifiant PSIM valide (1 a 32 caracteres : lettres, chiffres, _ et -)`);
      const owner = usedIds.get(v);
      if (owner !== undefined) fail(where, `l'identifiant PSIM "${v}" est deja utilise (${owner}) : un identifiant ne peut recevoir qu'une seule grandeur`);
      usedIds.set(v, `${name}/${k}`);
      ids[k as IdKey] = v;
    }
    if (Object.keys(ids).length === 0) fail(where, '"ids" doit router au moins une grandeur vers un identifiant PSIM');

    out.push({ name, transport, host, port, upsName, community, version, line, pollMs, timeoutMs, maxFailures, heartbeatMs, minIntervalMs, runtimeUnit, deadband, ids });
  });
  return out;
}
