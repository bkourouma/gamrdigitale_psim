/**
 * Configuration de la passerelle : un fichier JSON, valide STRICTEMENT (toute cle inconnue est une erreur : une faute de
 * frappe ne doit pas passer inapercue). Toutes les erreurs sont listees d'un coup, en francais.
 *
 * Les chemins relatifs (dataDir, passwordFile, ca, $file) sont relatifs au DOSSIER DU FICHIER de configuration.
 * Le mot de passe du PSIM vient de `passwordFile` (recommande), de `passwordEnv` ou de `password` ; il n'est jamais journalise.
 * Dans la section `config` d'un module, `{"$env": "NOM"}` et `{"$file": "chemin"}` sont remplaces par le secret correspondant.
 * La section `actuators` declare les actionneurs commandables par le PSIM (cle HMAC par actionneur : `keyFile`, `keyEnv` ou `key`,
 * comme le mot de passe, jamais journalisee) ; voir docs/PASSERELLE.md et docs/COMMANDES.md.
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

/** Plafond local d'une action d'actionneur (defense en profondeur : le PSIM peut etre compromis). */
export interface ActuatorActionSpec {
  /** Duree maximale en secondes ; null = action instantanee (un ordre AVEC durationS est refuse). */
  maxS: number | null;
  /** Vrai = un ordre sans durationS est accepte meme si maxS existe (a l'administrateur de le decider). */
  unbounded: boolean;
}

export interface ActuatorSpec {
  id: string;
  /** Cle HMAC-SHA256 : 64 hexadecimaux minuscules. JAMAIS journalisee. */
  key: string;
  /** D'ou vient la cle (affichable : jamais la cle elle-meme). */
  keySource: string;
  /** Etiquette du module de la passerelle qui execute les ordres. */
  module: string;
  /** Action -> plafond. Toujours lire avec Object.hasOwn (« constructor » est un nom d'action possible). */
  actions: Record<string, ActuatorActionSpec>;
  /** Action de repos appelee au bout de durationS ; null = aucun retour automatique (portail, barriere). */
  rest: string | null;
  /** Issue de secours : l'action `lock` est INTERDITE (configuration et execution). */
  emergencyExit: boolean;
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
  /** Actionneurs commandables par le PSIM (vide = le pilote de commandes est inactif). */
  actuators: ActuatorSpec[];
}

/** Dossier des modules livres avec la passerelle. */
export const MODULES_DIR = fileURLToPath(new URL('./modules/', import.meta.url));
/** Nom de module : minuscules, chiffres, `-` et `_`, sans point ni separateur (aucune traversee de chemin possible). */
export const MODULE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const LABEL = /^[A-Za-z0-9._-]{1,32}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const DETECTOR_PATTERN = /^[A-Za-z0-9_-]{1,32}\*?$/;
/** Memes formats que le PSIM (server/actuatorproto.ts) : identifiant, action, cle de 256 bits en hexadecimal. */
export const ACTUATOR_ID = /^[A-Za-z0-9_-]{1,32}$/;
export const ACTION_NAME = /^[a-z_]{1,16}$/;
const ACTUATOR_KEY = /^[0-9a-fA-F]{64}$/;
const MAX_ACTUATORS = 256;
const MAX_ACTIONS = 16;

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

  onlyKeys(raw, 'racine', ['name', 'psim', 'dataDir', 'queue', 'retry', 'moduleRetry', 'log', 'modules', 'actuators']);

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
  /** Etiquettes de tous les modules valides declares, y compris `enabled: false` (un actionneur peut viser un module coupe). */
  const declaredLabels = new Set<string>();
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
      declaredLabels.add(label);
      let config: Obj = {};
      if (m.config !== undefined) {
        if (!isObj(m.config)) errors.push(`${where}.config : objet attendu`);
        else config = resolveSecrets(m.config, `${where}.config`, env, at, errors) as Obj;
      }
      if (m.enabled !== false) modules.push({ name: m.name, label, config });
    });
  }

  // --- Actionneurs ------------------------------------------------------------------------------------------------
  const actuators: ActuatorSpec[] = [];
  if (raw.actuators !== undefined) {
    if (!Array.isArray(raw.actuators)) {
      errors.push('actuators : liste attendue ([{ "id": "GACHE-1", "keyFile": "secrets/gache-1.key", "module": "dahua-acces", "actions": { ... } }])');
    } else if (raw.actuators.length > MAX_ACTUATORS) {
      errors.push(`actuators : ${MAX_ACTUATORS} actionneurs au plus`);
    } else {
      const ids = new Set<string>();
      const keyOwner = new Map<string, string>();
      raw.actuators.forEach((a, i) => {
        const where = `actuators[${i}]`;
        if (!isObj(a)) {
          errors.push(`${where} : objet attendu`);
          return;
        }
        onlyKeys(a, where, ['id', 'key', 'keyEnv', 'keyFile', 'module', 'actions', 'rest', 'emergencyExit']);
        let id = '';
        if (typeof a.id !== 'string' || !ACTUATOR_ID.test(a.id)) errors.push(`${where}.id : 1 a 32 caracteres (lettres, chiffres, _ et -), comme dans le PSIM`);
        else if (ids.has(a.id)) errors.push(`${where}.id : « ${a.id} » apparait deux fois`);
        else {
          id = a.id;
          ids.add(id);
        }
        const shown = id || `#${i}`;

        // Cle : meme logique que le mot de passe du PSIM (une seule source) ; sa valeur n'apparait JAMAIS dans une erreur.
        let key = '';
        let keySource = '';
        const sources = ['key', 'keyEnv', 'keyFile'].filter((k) => a[k] !== undefined);
        if (sources.length !== 1) {
          errors.push(`${where} (${shown}) : indiquer UNE source de cle : keyFile (recommande), keyEnv ou key`);
        } else {
          let value = '';
          if (sources[0] === 'key') {
            if (typeof a.key !== 'string' || !a.key) errors.push(`${where}.key : texte de 64 hexadecimaux attendu`);
            else {
              value = a.key;
              keySource = 'fichier de configuration';
            }
          } else if (sources[0] === 'keyEnv') {
            if (typeof a.keyEnv !== 'string' || !ENV_NAME.test(a.keyEnv)) errors.push(`${where}.keyEnv : nom de variable d'environnement attendu`);
            else if (!env[a.keyEnv]) errors.push(`${where}.keyEnv : la variable d'environnement ${a.keyEnv} est absente ou vide`);
            else {
              value = env[a.keyEnv] as string;
              keySource = `variable ${a.keyEnv}`;
            }
          } else if (typeof a.keyFile !== 'string' || !a.keyFile) {
            errors.push(`${where}.keyFile : chemin attendu`);
          } else {
            try {
              value = readSecretFile(at(a.keyFile));
              keySource = `fichier ${at(a.keyFile)}`;
              if (!value) errors.push(`${where}.keyFile : le fichier ${at(a.keyFile)} est vide`);
            } catch (err) {
              errors.push(`${where}.keyFile : lecture impossible de ${at(a.keyFile)} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
            }
          }
          if (value) {
            if (!ACTUATOR_KEY.test(value)) errors.push(`${where} (${shown}) : la cle doit etre 64 caracteres hexadecimaux (celle affichee a la creation de l'actionneur dans le PSIM)`);
            else if (/^(.)\1+$/.test(value)) errors.push(`${where} (${shown}) : cle triviale (un seul caractere repete) : est-ce bien la cle affichee par le PSIM ?`);
            else {
              key = value.toLowerCase();
              const owner = keyOwner.get(key);
              if (owner !== undefined) errors.push(`${where} (${shown}) : meme cle que l'actionneur ${owner} : une cle par actionneur (en renouveler une dans le PSIM)`);
              else keyOwner.set(key, shown);
            }
          }
        }

        let moduleLabel = '';
        if (typeof a.module !== 'string' || !LABEL.test(a.module)) errors.push(`${where}.module : etiquette (« label », ou nom par defaut) d'un module declare dans « modules »`);
        else if (!declaredLabels.has(a.module)) errors.push(`${where}.module : aucun module d'etiquette « ${a.module} » dans « modules » (etiquettes : ${[...declaredLabels].join(', ') || 'aucune'})`);
        else moduleLabel = a.module;

        if (a.emergencyExit !== undefined && typeof a.emergencyExit !== 'boolean') errors.push(`${where}.emergencyExit : true ou false`);
        const emergencyExit = a.emergencyExit === true;

        // Actions : Object.keys ne parcourt que les cles PROPRES du JSON ; la table construite ne s'interroge qu'avec Object.hasOwn.
        const actions: Record<string, ActuatorActionSpec> = {};
        let actionsOk = false;
        if (!isObj(a.actions)) {
          errors.push(`${where}.actions : objet attendu ({ "unlock": { "maxS": 10 }, "lock": {} })`);
        } else {
          const names = Object.keys(a.actions);
          if (names.length === 0) errors.push(`${where}.actions : au moins une action`);
          else if (names.length > MAX_ACTIONS) errors.push(`${where}.actions : ${MAX_ACTIONS} actions au plus`);
          else {
            actionsOk = true;
            for (const n of names) {
              const w = `${where}.actions.${n.slice(0, 20)}`;
              const spec = a.actions[n];
              if (!ACTION_NAME.test(n)) {
                errors.push(`${w} : nom d'action invalide (1 a 16 minuscules ou _)`);
                actionsOk = false;
                continue;
              }
              if (!isObj(spec)) {
                errors.push(`${w} : objet attendu ({ "maxS": 10 } ou {})`);
                actionsOk = false;
                continue;
              }
              onlyKeys(spec, w, ['maxS', 'unbounded']);
              let maxS: number | null = null;
              if (spec.maxS !== undefined) {
                if (typeof spec.maxS !== 'number' || !Number.isInteger(spec.maxS) || spec.maxS < 1 || spec.maxS > 86_400) {
                  errors.push(`${w}.maxS : entier entre 1 et 86400 attendu`);
                  actionsOk = false;
                } else maxS = spec.maxS;
              }
              let unbounded = false;
              if (spec.unbounded !== undefined) {
                if (typeof spec.unbounded !== 'boolean') {
                  errors.push(`${w}.unbounded : true ou false`);
                  actionsOk = false;
                } else unbounded = spec.unbounded;
              }
              if (unbounded && spec.maxS === undefined) {
                errors.push(`${w}.unbounded : n'a de sens qu'avec maxS (une action instantanee n'a pas de duree)`);
                actionsOk = false;
              }
              // defineProperty : une action nommee « __proto__ » reste une simple donnee (jamais le prototype de la table).
              Object.defineProperty(actions, n, { value: { maxS, unbounded }, enumerable: true, writable: true, configurable: true });
            }
          }
        }

        let rest: string | null = null;
        if (a.rest !== undefined && a.rest !== null) {
          if (typeof a.rest !== 'string' || !ACTION_NAME.test(a.rest)) errors.push(`${where}.rest : nom de l'action de repos (ex. "lock"), ou absent pour aucun retour automatique`);
          else if (actionsOk && !Object.hasOwn(actions, a.rest)) errors.push(`${where}.rest : l'action de repos « ${a.rest} » doit figurer dans « actions »`);
          else if (actionsOk && (actions[a.rest] as ActuatorActionSpec).maxS !== null) errors.push(`${where}.rest : l'action de repos « ${a.rest} » est appelee sans duree : pas de maxS`);
          else rest = a.rest;
        }
        if (emergencyExit) {
          if (isObj(a.actions) && Object.hasOwn(a.actions, 'lock')) errors.push(`${where} (${shown}) : issue de secours (emergencyExit) : l'action « lock » est interdite dans « actions »`);
          if (a.rest === 'lock') errors.push(`${where}.rest : issue de secours (emergencyExit) : le repos ne peut pas etre « lock »`);
        }

        if (id && key && moduleLabel && actionsOk) actuators.push({ id, key, keySource, module: moduleLabel, actions, rest, emergencyExit });
      });
    }
  }

  if (errors.length > 0) throw new ConfigError(abs, errors);
  return { file: abs, name, psim, dataDir, queue, retry, moduleRetry, log, modules, actuators };
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
