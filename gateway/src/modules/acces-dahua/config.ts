/**
 * Configuration du module `acces-dahua` : types et validation STRICTE (cle inconnue = erreur, toutes les erreurs d'un coup,
 * messages en francais pour l'installateur). Le mot de passe ne figure JAMAIS dans un message d'erreur.
 *
 *   { "stateDir": "optionnel",                       // curseurs F8 (acces-curseurs.json) ET plages horaires (acces-plages.json)
 *     "controllers": [ { "id": "CTL-1", "host": "192.168.10.20", "port": 80, "username": "psim",
 *                        "password": {"$file":"secrets/ctl1.txt"}, "utcOffsetMin": 0,
 *                        "epoch": 0,                 // optionnel (entier >= 0, 0) : voir ci-dessous
 *                        "doors": { "1": "P-ENTREE", "2": "P-SALLE-SERVEUR" },
 *                        "actuators": { "ACT-ENTREE": { "door": 1, "type": "lock" } } } ],
 *     "thresholds": { "deniedCount": 3, "deniedWindowS": 60, "heartbeatS": 60, "clockDriftMs": 120000,
 *                     "silenceMs": 30000, "offlineGraceMs": 15000, "longUnlockS": 60,
 *                     "modeCheckS": 60 },             // relecture du mode des portes (F19), 0 = inactive
 *     "schedules": { "min": 1, "max": 127 },         // numeros de plage horaire (AccessTimeSchedule) confies au PSIM (synchronisation)
 *     "reconnect": { "minMs": 1000, "maxMs": 60000 } }
 *
 * `epoch` (par controleur) : a AUGMENTER quand le controleur est remplace (sa memoire est vide : les n° d'enregistrement repartent
 * de zero). Si epoch > 0, `eventId` = "<epoque>.<n° d'enregistrement>" et le curseur de recuperation (F8) est celui de l'epoque :
 * il repart de zero (premier demarrage : au plus les dernieres 24 h de la memoire sont rejouees).
 * `schedules.min` / `schedules.max` : plage de numeros de `AccessTimeSchedule` que le module peut attribuer aux horaires du PSIM.
 * Defaut 1 a 127 : le controleur en offre 128 (indices 0 a 127, SDK Dahua) et le numero 0 reste celui d'usine ; 255 est reserve
 * (« toutes les heures »). A QUALIFIER sur materiel. Valeurs : entiers, 0 <= min <= max <= 254.
 */
import { MAX_EPOCH, validEpoch } from '../acces-commun/commun.ts';
import { DIGEST_USERNAME } from '../../../../server/dahua.ts';

export interface ActuatorConfig {
  door: number;
  type: 'lock' | 'gate';
}

export interface ControllerConfig {
  /** Identifiant PSIM du controleur (`access_controller.id`). */
  id: string;
  host: string;
  port: number;
  username: string;
  /** Ne jamais journaliser. */
  password: string;
  /** Decalage de l'heure LOCALE du controleur par rapport a UTC, en minutes (0 = Abidjan). */
  utcOffsetMin: number;
  /** No de porte (1 a 4) -> identifiant du detecteur PSIM. */
  doors: Map<number, string>;
  /** Identifiant d'actionneur -> porte et type. */
  actuators: Map<string, ActuatorConfig>;
  /**
   * Numerotation des portes dans les EVENEMENTS et enregistrements du controleur : 0 = la premiere porte est le numero 0
   * (hypothese par defaut, vue sur un terminal ASI : `index=0`, `Door: 0`) ; 1 = elle est le numero 1. A QUALIFIER.
   */
  doorBase: 0 | 1;
  /** Identifiant d'utilisateur transmis avec l'ordre d'ouverture a distance (facultatif ; absent par defaut). */
  remoteUserId: number | null;
  /** Epoque du controleur (entier >= 0, 0 par defaut) : a augmenter quand le controleur est remplace. */
  epoch: number;
}

export interface Thresholds {
  deniedCount: number;
  deniedWindowS: number;
  heartbeatS: number;
  clockDriftMs: number;
  silenceMs: number;
  offlineGraceMs: number;
  longUnlockS: number;
  /** Periode (secondes) de la relecture du mode des portes (F19) ; 0 = pas de relecture periodique. */
  modeCheckS: number;
}

/** Numeros de plage horaire (`AccessTimeSchedule`) que le module peut attribuer ; `NO_RESTRICTION_SLOT` (255) n'en fait jamais partie. */
export interface SchedulesConfig {
  min: number;
  max: number;
}

export const DEFAULT_SCHEDULES: SchedulesConfig = { min: 1, max: 127 };
/** Numero de plage « toutes les heures » dans une fiche carte (`TimeSections`). A QUALIFIER. */
export const NO_RESTRICTION_SLOT = 255;

export interface DahuaAccessConfig {
  /** Dossier d'etat (curseurs F8) ; `null` = dossier par defaut choisi par le module. */
  stateDir: string | null;
  controllers: ControllerConfig[];
  thresholds: Thresholds;
  schedules: SchedulesConfig;
  reconnect: { minMs: number; maxMs: number };
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  deniedCount: 3,
  deniedWindowS: 60,
  heartbeatS: 60,
  clockDriftMs: 120_000,
  silenceMs: 30_000,
  offlineGraceMs: 15_000,
  longUnlockS: 60,
  modeCheckS: 60,
};

export const MAX_CONTROLLERS = 16;
export const MAX_DOOR_NO = 4;

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** Adresse IP ou nom de machine, SANS schema ni chemin ni port. */
const HOST_RE = /^[A-Za-z0-9._:-]{1,253}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const TOP_KEYS = new Set(['stateDir', 'controllers', 'thresholds', 'schedules', 'reconnect']);
const CONTROLLER_KEYS = new Set(['id', 'host', 'port', 'username', 'password', 'utcOffsetMin', 'doors', 'actuators', 'doorBase', 'remoteUserId', 'epoch']);
const THRESHOLD_BOUNDS: Record<keyof Thresholds, [number, number]> = {
  deniedCount: [1, 100],
  deniedWindowS: [1, 86_400],
  heartbeatS: [1, 3600],
  clockDriftMs: [1000, 86_400_000],
  silenceMs: [500, 600_000],
  offlineGraceMs: [0, 600_000],
  longUnlockS: [1, 86_400],
  modeCheckS: [0, 86_400],
};

/** Texte court et sans danger pour un message d'erreur (jamais une valeur de mot de passe). */
function shown(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  return s.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 40);
}

/**
 * Valide la section de configuration du module. Leve une `Error` dont le message liste TOUTES les erreurs (une par ligne).
 */
export function parseConfig(config: Record<string, unknown>): DahuaAccessConfig {
  const errors: string[] = [];
  const err = (where: string, text: string) => void errors.push(`${where} : ${text}`);

  if (!isObject(config)) throw new Error('Module acces-dahua : configuration absente ou invalide (un objet est attendu)');
  for (const k of Object.keys(config)) if (!TOP_KEYS.has(k)) err('configuration', `cle inconnue « ${shown(k)} » (attendu : ${[...TOP_KEYS].join(', ')})`);

  let stateDir: string | null = null;
  if (config.stateDir !== undefined) {
    if (typeof config.stateDir !== 'string' || config.stateDir.trim() === '' || config.stateDir.length > 400 || /[\x00-\x1f]/.test(config.stateDir)) {
      err('stateDir', 'un chemin de dossier est attendu (texte non vide)');
    } else stateDir = config.stateDir;
  }

  // --- Seuils ---
  const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS };
  if (config.thresholds !== undefined) {
    if (!isObject(config.thresholds)) err('thresholds', 'un objet est attendu');
    else {
      for (const [k, v] of Object.entries(config.thresholds)) {
        if (!Object.hasOwn(THRESHOLD_BOUNDS, k)) {
          err('thresholds', `cle inconnue « ${shown(k)} » (attendu : ${Object.keys(THRESHOLD_BOUNDS).join(', ')})`);
          continue;
        }
        const [min, max] = THRESHOLD_BOUNDS[k as keyof Thresholds];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) err(`thresholds.${k}`, `un entier entre ${min} et ${max} est attendu`);
        else thresholds[k as keyof Thresholds] = v;
      }
    }
  }

  // --- Plages horaires (synchronisation des titulaires) ---
  const schedules: SchedulesConfig = { ...DEFAULT_SCHEDULES };
  if (config.schedules !== undefined) {
    if (!isObject(config.schedules)) err('schedules', 'un objet est attendu ({"min": 1, "max": 127})');
    else {
      for (const k of Object.keys(config.schedules)) if (k !== 'min' && k !== 'max') err('schedules', `cle inconnue « ${shown(k)} » (attendu : min, max)`);
      for (const k of ['min', 'max'] as const) {
        const v = config.schedules[k];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 254) err(`schedules.${k}`, 'un entier entre 0 et 254 est attendu (255 est reserve : « toutes les heures »)');
        else schedules[k] = v;
      }
      if (schedules.max < schedules.min) err('schedules', `max (${schedules.max}) doit etre superieur ou egal a min (${schedules.min})`);
    }
  }

  // --- Reconnexion ---
  const reconnect = { minMs: 1000, maxMs: 60_000 };
  if (config.reconnect !== undefined) {
    if (!isObject(config.reconnect)) err('reconnect', 'un objet est attendu');
    else {
      for (const k of Object.keys(config.reconnect)) if (k !== 'minMs' && k !== 'maxMs') err('reconnect', `cle inconnue « ${shown(k)} » (attendu : minMs, maxMs)`);
      const r = config.reconnect;
      if (r.minMs !== undefined) {
        if (typeof r.minMs !== 'number' || !Number.isInteger(r.minMs) || r.minMs < 50 || r.minMs > 600_000) err('reconnect.minMs', 'un entier entre 50 et 600000 est attendu');
        else reconnect.minMs = r.minMs;
      }
      if (r.maxMs !== undefined) {
        if (typeof r.maxMs !== 'number' || !Number.isInteger(r.maxMs) || r.maxMs < 50 || r.maxMs > 3_600_000) err('reconnect.maxMs', 'un entier entre 50 et 3600000 est attendu');
        else reconnect.maxMs = r.maxMs;
      }
      if (reconnect.maxMs < reconnect.minMs) err('reconnect', `maxMs (${reconnect.maxMs}) doit etre superieur ou egal a minMs (${reconnect.minMs})`);
    }
  }

  // --- Controleurs ---
  const controllers: ControllerConfig[] = [];
  const list = config.controllers;
  if (!Array.isArray(list) || list.length === 0) err('controllers', 'la liste doit contenir au moins un controleur');
  else if (list.length > MAX_CONTROLLERS) err('controllers', `au plus ${MAX_CONTROLLERS} controleurs par module`);
  else {
    const controllerIds = new Set<string>();
    const detectorOwner = new Map<string, string>();
    const actuatorOwner = new Map<string, string>();
    list.forEach((raw, index) => {
      let where = `controleur no ${index + 1}`;
      if (!isObject(raw)) return err(where, 'un objet est attendu');
      if (typeof raw.id === 'string' && ID_RE.test(raw.id)) where = `controleur « ${raw.id} »`;
      const before = errors.length;
      for (const k of Object.keys(raw)) if (!CONTROLLER_KEYS.has(k)) err(where, `cle inconnue « ${shown(k)} »`);

      const id = raw.id;
      if (typeof id !== 'string' || !ID_RE.test(id)) err(where, '« id » est obligatoire (1 a 32 caracteres : lettres, chiffres, _ et -)');
      else if (controllerIds.has(id)) err(where, `l'identifiant « ${id} » est deja utilise par un autre controleur`);
      else controllerIds.add(id);

      const host = raw.host;
      if (typeof host !== 'string' || !HOST_RE.test(host)) err(where, '« host » est obligatoire (adresse IP ou nom de machine, sans http:// ni chemin ni espace)');

      let port = 80;
      if (raw.port !== undefined) {
        if (typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65_535) err(where, '« port » doit etre un entier entre 1 et 65535');
        else port = raw.port;
      }

      const username = raw.username;
      if (typeof username !== 'string' || !DIGEST_USERNAME.test(username)) err(where, '« username » est obligatoire (1 a 64 caracteres ASCII imprimables, sans guillemet ni barre oblique inverse)');
      const password = raw.password;
      if (typeof password !== 'string' || password.length === 0 || password.length > 128 || /[\x00-\x1f\x7f]/.test(password)) {
        err(where, '« password » est obligatoire (texte de 1 a 128 caracteres, ou {"$file": "secrets/fichier.txt"} / {"$env": "NOM"})');
      }

      let utcOffsetMin = 0;
      if (raw.utcOffsetMin !== undefined) {
        if (typeof raw.utcOffsetMin !== 'number' || !Number.isInteger(raw.utcOffsetMin) || raw.utcOffsetMin < -840 || raw.utcOffsetMin > 840) err(where, '« utcOffsetMin » doit etre un entier de minutes entre -840 et 840 (0 = Abidjan)');
        else utcOffsetMin = raw.utcOffsetMin;
      }

      let doorBase: 0 | 1 = 0;
      if (raw.doorBase !== undefined) {
        if (raw.doorBase !== 0 && raw.doorBase !== 1) err(where, '« doorBase » doit valoir 0 ou 1');
        else doorBase = raw.doorBase;
      }

      let epoch = 0;
      if (raw.epoch !== undefined) {
        if (!validEpoch(raw.epoch)) err(where, `« epoch » doit etre un entier entre 0 et ${MAX_EPOCH} (0 par defaut ; a augmenter quand le controleur est remplace)`);
        else epoch = raw.epoch;
      }

      let remoteUserId: number | null = null;
      if (raw.remoteUserId !== undefined) {
        if (typeof raw.remoteUserId !== 'number' || !Number.isInteger(raw.remoteUserId) || raw.remoteUserId < 0 || raw.remoteUserId > 99_999_999) err(where, '« remoteUserId » doit etre un entier positif ou nul');
        else remoteUserId = raw.remoteUserId;
      }

      const doors = new Map<number, string>();
      if (!isObject(raw.doors) || Object.keys(raw.doors).length === 0) err(where, '« doors » est obligatoire : {"1": "ID-DETECTEUR", ...} (portes 1 a 4)');
      else {
        for (const [k, v] of Object.entries(raw.doors)) {
          const n = /^[1-9]\d{0,1}$/.test(k) ? Number(k) : 0;
          if (n < 1 || n > MAX_DOOR_NO) {
            err(where, `« doors » : numero de porte « ${shown(k)} » invalide (1 a ${MAX_DOOR_NO})`);
            continue;
          }
          if (typeof v !== 'string' || !ID_RE.test(v)) {
            err(where, `« doors.${k} » doit etre un identifiant de detecteur PSIM (1 a 32 caracteres : lettres, chiffres, _ et -)`);
            continue;
          }
          const owner = detectorOwner.get(v);
          if (owner !== undefined) {
            err(where, `l'identifiant de detecteur « ${v} » est deja utilise (${owner}) : un detecteur ne peut representer qu'une porte`);
            continue;
          }
          detectorOwner.set(v, `${typeof id === 'string' ? id : '?'}/porte ${k}`);
          doors.set(n, v);
        }
      }

      const actuators = new Map<string, ActuatorConfig>();
      if (raw.actuators !== undefined) {
        if (!isObject(raw.actuators)) err(where, '« actuators » doit etre un objet {"ID-ACTIONNEUR": {"door": 1, "type": "lock"}}');
        else {
          for (const [aid, spec] of Object.entries(raw.actuators)) {
            if (!ID_RE.test(aid)) {
              err(where, `« actuators » : identifiant « ${shown(aid)} » invalide (1 a 32 caracteres : lettres, chiffres, _ et -)`);
              continue;
            }
            if (!isObject(spec)) {
              err(where, `« actuators.${aid} » : un objet {"door": 1, "type": "lock"} est attendu`);
              continue;
            }
            for (const k of Object.keys(spec)) if (k !== 'door' && k !== 'type') err(where, `« actuators.${aid} » : cle inconnue « ${shown(k)} » (attendu : door, type)`);
            if (typeof spec.door !== 'number' || !Number.isInteger(spec.door) || !doors.has(spec.door)) {
              err(where, `« actuators.${aid}.door » doit etre une porte declaree dans « doors »`);
              continue;
            }
            if (spec.type !== 'lock' && spec.type !== 'gate') {
              err(where, `« actuators.${aid}.type » doit valoir « lock » ou « gate »`);
              continue;
            }
            const owner = actuatorOwner.get(aid);
            if (owner !== undefined) {
              err(where, `l'actionneur « ${aid} » est deja declare (${owner})`);
              continue;
            }
            actuatorOwner.set(aid, typeof id === 'string' ? id : '?');
            actuators.set(aid, { door: spec.door, type: spec.type });
          }
        }
      }

      if (errors.length === before && typeof id === 'string' && typeof host === 'string' && typeof username === 'string' && typeof password === 'string') {
        controllers.push({ id, host, port, username, password, utcOffsetMin, doors, actuators, doorBase, remoteUserId, epoch });
      }
    });
  }

  if (errors.length > 0) throw new Error(`Module acces-dahua : configuration invalide :\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  return { stateDir, controllers, thresholds, schedules, reconnect };
}
