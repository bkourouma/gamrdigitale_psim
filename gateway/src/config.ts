/**
 * Configuration de la passerelle : un fichier JSON, valide STRICTEMENT (toute cle inconnue est une erreur : une faute de
 * frappe ne doit pas passer inapercue). Toutes les erreurs sont listees d'un coup, en francais.
 *
 * Les chemins relatifs (dataDir, passwordFile, ca, $file) sont relatifs au DOSSIER DU FICHIER de configuration.
 * Le mot de passe du PSIM vient de `passwordFile` (recommande), de `passwordEnv` ou de `password` ; il n'est jamais journalise.
 * Dans la section `config` d'un module, `{"$env": "NOM"}` et `{"$file": "chemin"}` sont remplaces par le secret correspondant.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class ConfigError extends Error {
  readonly errors: string[];
  constructor(file: string, errors: string[]) {
    super(`Configuration invalide (${file}) :\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.errors = errors;
  }
}

export interface ModuleSpec {
  /** Nom du module = dossier gateway/src/modules/<name>. */
  name: string;
  /** Nom affiche dans le journal (plusieurs instances d'un meme module : « modbus-ups », « modbus-clim »). */
  label: string;
  config: Record<string, unknown>;
}

export interface GatewayConfig {
  file: string;
  name: string;
  psim: {
    url: string;
    username: string;
    password: string;
    /** D'ou vient le mot de passe (affichable : jamais le mot de passe lui-meme). */
    passwordSource: string;
    ca: Buffer | null;
    clientId: string;
    /** Detecteurs autorises (identifiants ou prefixes « D-* ») ; null = pas de filtre local. */
    detectors: string[] | null;
  };
  dataDir: string;
  queue: { maxMessages: number; maxBytes: number };
  retry: { minMs: number; maxMs: number };
  moduleRetry: { minMs: number; maxMs: number };
  log: { file: boolean; level: 'info' | 'warn' | 'error' };
  modules: ModuleSpec[];
}

/** Dossier des modules livres avec la passerelle. */
export const MODULES_DIR = fileURLToPath(new URL('./modules/', import.meta.url));
/** Nom de module : minuscules, chiffres, `-` et `_`, sans point ni separateur (aucune traversee de chemin possible). */
export const MODULE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const LABEL = /^[A-Za-z0-9._-]{1,32}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const DETECTOR_PATTERN = /^[A-Za-z0-9_-]{1,32}\*?$/;

/**
 * Fichier d'entree d'un module, ou null si le nom est refuse ou si le module n'existe pas.
 * Double verrou : liste blanche de caracteres, puis le chemin resolu doit rester DANS le dossier des modules.
 */
export function moduleEntry(name: string, modulesDir = MODULES_DIR): string | null {
  if (!MODULE_NAME.test(name)) return null;
  const base = resolve(modulesDir);
  const file = resolve(base, name, 'index.ts');
  const rel = relative(base, file);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return existsSync(file) ? file : null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function readSecretFile(path: string): string {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/[\r\n]+$/, '');
}

/** Lit le dossier de donnees sans valider le reste (superviseur : il doit trouver le fichier d'etat meme si un secret manque). */
export function peekDataDir(file: string): string {
  const abs = resolve(file);
  try {
    const raw = JSON.parse(readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')) as Obj;
    if (typeof raw.dataDir === 'string' && raw.dataDir) return resolve(dirname(abs), raw.dataDir);
  } catch {
    // valeur par defaut
  }
  return resolve(dirname(abs), 'data');
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  /** Dossier des modules (essais : modules factices). */
  modulesDir?: string;
}

export function loadConfig(file: string, opts: LoadOptions = {}): GatewayConfig {
  const env = opts.env ?? process.env;
  const modulesDir = opts.modulesDir ?? MODULES_DIR;
  const abs = resolve(file);
  const base = dirname(abs);
  const errors: string[] = [];
  const at = (p: string) => (isAbsolute(p) ? p : join(base, p));

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ConfigError(abs, [code === 'ENOENT' ? 'fichier introuvable' : `JSON illisible : ${(err as Error).message}`]);
  }
  if (!isObj(raw)) throw new ConfigError(abs, ['un objet JSON est attendu ({ "psim": ..., "modules": [...] })']);

  const onlyKeys = (o: Obj, where: string, allowed: string[]) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${where} : cle inconnue « ${k} » (attendues : ${allowed.join(', ')})`);
  };
  const int = (o: Obj, key: string, where: string, def: number, min: number, max: number): number => {
    const v = o[key];
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      errors.push(`${where}.${key} : entier entre ${min} et ${max} attendu`);
      return def;
    }
    return v;
  };

  onlyKeys(raw, 'racine', ['name', 'psim', 'dataDir', 'queue', 'retry', 'moduleRetry', 'log', 'modules']);

  let name = 'passerelle';
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || !LABEL.test(raw.name)) errors.push('name : 1 a 32 caracteres (lettres, chiffres, . _ -)');
    else name = raw.name;
  }

  // --- PSIM ---------------------------------------------------------------------------------------------------
  const psim: GatewayConfig['psim'] = { url: '', username: '', password: '', passwordSource: '', ca: null, clientId: '', detectors: null };
  if (!isObj(raw.psim)) {
    errors.push('psim : section obligatoire ({ "url": "mqtt://127.0.0.1:1883", "username": "gw1", "passwordFile": "..." })');
  } else {
    const p = raw.psim;
    onlyKeys(p, 'psim', ['url', 'username', 'password', 'passwordEnv', 'passwordFile', 'ca', 'detectors']);
    if (typeof p.url !== 'string') {
      errors.push('psim.url : obligatoire (ex. mqtt://127.0.0.1:1883, ou mqtts://... pour une liaison chiffree)');
    } else {
      let u: URL | null = null;
      try {
        u = new URL(p.url);
      } catch {
        errors.push('psim.url : adresse illisible');
      }
      if (u) {
        if (u.protocol !== 'mqtt:' && u.protocol !== 'mqtts:') errors.push('psim.url : mqtt:// ou mqtts:// attendu');
        else if (u.username || u.password) errors.push("psim.url : pas d'identifiant dans l'adresse (il finirait dans les journaux) : utiliser username et passwordFile");
        else if (u.pathname && u.pathname !== '/') errors.push('psim.url : pas de chemin apres le port');
        else psim.url = p.url;
      }
    }
    if (typeof p.username !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(p.username)) errors.push('psim.username : compte MQTT de la passerelle (1 a 32 caracteres : lettres, chiffres, . _ -)');
    else psim.username = p.username;

    const sources = ['password', 'passwordEnv', 'passwordFile'].filter((k) => p[k] !== undefined);
    if (sources.length !== 1) {
      errors.push('psim : indiquer UNE source de mot de passe : passwordFile (recommande), passwordEnv ou password');
    } else if (sources[0] === 'password') {
      if (typeof p.password !== 'string' || p.password.length === 0) errors.push('psim.password : texte non vide attendu');
      else {
        psim.password = p.password;
        psim.passwordSource = 'fichier de configuration';
      }
    } else if (sources[0] === 'passwordEnv') {
      if (typeof p.passwordEnv !== 'string' || !ENV_NAME.test(p.passwordEnv)) errors.push('psim.passwordEnv : nom de variable d\'environnement attendu');
      else if (!env[p.passwordEnv]) errors.push(`psim.passwordEnv : la variable d'environnement ${p.passwordEnv} est absente ou vide`);
      else {
        psim.password = env[p.passwordEnv] as string;
        psim.passwordSource = `variable ${p.passwordEnv}`;
      }
    } else {
      if (typeof p.passwordFile !== 'string' || !p.passwordFile) errors.push('psim.passwordFile : chemin attendu');
      else {
        try {
          psim.password = readSecretFile(at(p.passwordFile));
          psim.passwordSource = `fichier ${at(p.passwordFile)}`;
          if (!psim.password) errors.push(`psim.passwordFile : le fichier ${at(p.passwordFile)} est vide`);
        } catch (err) {
          errors.push(`psim.passwordFile : lecture impossible de ${at(p.passwordFile)} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
        }
      }
    }

    if (p.ca !== undefined) {
      if (typeof p.ca !== 'string' || !p.ca) errors.push('psim.ca : chemin du certificat (PEM) attendu');
      else if (psim.url && !psim.url.startsWith('mqtts:')) errors.push('psim.ca : seulement avec une adresse mqtts://');
      else {
        try {
          psim.ca = readFileSync(at(p.ca));
        } catch (err) {
          errors.push(`psim.ca : lecture impossible de ${at(p.ca)} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
        }
      }
    }
    if (p.detectors !== undefined) {
      if (!Array.isArray(p.detectors) || p.detectors.length === 0 || p.detectors.length > 500 || !p.detectors.every((d) => typeof d === 'string' && DETECTOR_PATTERN.test(d))) {
        errors.push('psim.detectors : liste d\'identifiants (« D-01 ») ou de prefixes (« D-* »), comme le compte cote PSIM');
      } else psim.detectors = p.detectors as string[];
    }
  }
  psim.clientId = `gamr-gw-${psim.username || 'x'}`;

  // --- Donnees, file, temporisations, journal ----------------------------------------------------------------------
  let dataDir = join(base, 'data');
  if (raw.dataDir !== undefined) {
    if (typeof raw.dataDir !== 'string' || !raw.dataDir) errors.push('dataDir : chemin attendu');
    else dataDir = resolve(base, raw.dataDir);
  }

  const queue = { maxMessages: 10_000, maxBytes: 20 * 1024 * 1024 };
  if (raw.queue !== undefined) {
    if (!isObj(raw.queue)) errors.push('queue : objet attendu');
    else {
      onlyKeys(raw.queue, 'queue', ['maxMessages', 'maxBytes']);
      queue.maxMessages = int(raw.queue, 'maxMessages', 'queue', queue.maxMessages, 1, 1_000_000);
      queue.maxBytes = int(raw.queue, 'maxBytes', 'queue', queue.maxBytes, 4096, 1024 * 1024 * 1024);
    }
  }
  const retry = { minMs: 1000, maxMs: 60_000 };
  const moduleRetry = { minMs: 5000, maxMs: 300_000 };
  for (const [key, target] of [['retry', retry], ['moduleRetry', moduleRetry]] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (!isObj(v)) {
      errors.push(`${key} : objet attendu`);
      continue;
    }
    onlyKeys(v, key, ['minMs', 'maxMs']);
    target.minMs = int(v, 'minMs', key, target.minMs, 50, 3_600_000);
    target.maxMs = int(v, 'maxMs', key, Math.max(target.maxMs, target.minMs), 50, 3_600_000);
    if (target.maxMs < target.minMs) errors.push(`${key} : maxMs doit etre superieur ou egal a minMs`);
  }
  const log: GatewayConfig['log'] = { file: true, level: 'info' };
  if (raw.log !== undefined) {
    if (!isObj(raw.log)) errors.push('log : objet attendu');
    else {
      onlyKeys(raw.log, 'log', ['file', 'level']);
      if (raw.log.file !== undefined) {
        if (typeof raw.log.file !== 'boolean') errors.push('log.file : true ou false');
        else log.file = raw.log.file;
      }
      if (raw.log.level !== undefined) {
        if (raw.log.level !== 'info' && raw.log.level !== 'warn' && raw.log.level !== 'error') errors.push('log.level : info, warn ou error');
        else log.level = raw.log.level;
      }
    }
  }

  // --- Modules ----------------------------------------------------------------------------------------------------
  const modules: ModuleSpec[] = [];
  if (!Array.isArray(raw.modules)) {
    errors.push('modules : liste obligatoire ([{ "name": "zigbee", "config": { ... } }])');
  } else {
    const labels = new Set<string>();
    raw.modules.forEach((m, i) => {
      const where = `modules[${i}]`;
      if (!isObj(m)) {
        errors.push(`${where} : objet attendu`);
        return;
      }
      onlyKeys(m, where, ['name', 'label', 'enabled', 'config']);
      if (typeof m.name !== 'string' || !MODULE_NAME.test(m.name)) {
        errors.push(`${where}.name : nom de module refuse (minuscules, chiffres, - et _ ; ni point ni barre oblique)`);
        return;
      }
      if (!moduleEntry(m.name, modulesDir)) {
        errors.push(`${where}.name : module « ${m.name} » introuvable (dossier gateway/src/modules/${m.name}/index.ts)`);
        return;
      }
      if (m.enabled !== undefined && typeof m.enabled !== 'boolean') errors.push(`${where}.enabled : true ou false`);
      let label = m.name;
      if (m.label !== undefined) {
        if (typeof m.label !== 'string' || !LABEL.test(m.label)) errors.push(`${where}.label : 1 a 32 caracteres (lettres, chiffres, . _ -)`);
        else label = m.label;
      }
      if (labels.has(label)) errors.push(`${where} : « ${label} » apparait deux fois (donner un « label » different a chaque instance)`);
      labels.add(label);
      let config: Obj = {};
      if (m.config !== undefined) {
        if (!isObj(m.config)) errors.push(`${where}.config : objet attendu`);
        else config = resolveSecrets(m.config, `${where}.config`, env, at, errors) as Obj;
      }
      if (m.enabled !== false) modules.push({ name: m.name, label, config });
    });
  }

  if (errors.length > 0) throw new ConfigError(abs, errors);
  return { file: abs, name, psim, dataDir, queue, retry, moduleRetry, log, modules };
}

/** Remplace `{"$env":"NOM"}` et `{"$file":"chemin"}` par le secret ; copie profonde (le module ne modifie pas l'original). */
function resolveSecrets(v: unknown, where: string, env: NodeJS.ProcessEnv, at: (p: string) => string, errors: string[]): unknown {
  if (Array.isArray(v)) return v.map((x, i) => resolveSecrets(x, `${where}[${i}]`, env, at, errors));
  if (!isObj(v)) return v;
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === '$env') {
    const n = v.$env;
    if (typeof n !== 'string' || !ENV_NAME.test(n)) errors.push(`${where} : $env attend un nom de variable`);
    else if (!env[n]) errors.push(`${where} : la variable d'environnement ${n} est absente ou vide`);
    else return env[n];
    return '';
  }
  if (keys.length === 1 && keys[0] === '$file') {
    const p = v.$file;
    if (typeof p !== 'string' || !p) {
      errors.push(`${where} : $file attend un chemin`);
      return '';
    }
    try {
      return readSecretFile(at(p));
    } catch (err) {
      errors.push(`${where} : lecture impossible de ${at(p)} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
      return '';
    }
  }
  const out: Obj = {};
  // defineProperty : une cle « __proto__ » venue du JSON reste une simple donnee (jamais le prototype de l'objet).
  for (const k of keys) Object.defineProperty(out, k, { value: resolveSecrets(v[k], `${where}.${k}`, env, at, errors), enumerable: true, writable: true, configurable: true });
  return out;
}

/** Adresse sans identifiants (journaux). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '(adresse illisible)';
  }
}
