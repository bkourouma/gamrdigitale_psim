/**
 * Format de PACK (packVersion 1) : description, en un fichier `pack.json`, d'une installation type (villa, boutique,
 * entrepot...) a reproduire chez un client : etages et plans, zones, equipements avec leur modele catalogue, sources,
 * liens detecteur -> cameras, planning d'armement, evaluation de risque, destinataires en gabarit, comptes de passerelle.
 *
 * Schema ecrit a la main, STRICT : toute cle inconnue est refusee, chaque erreur dit le chemin fautif
 * (ex. `devices[2] « CAM-03 ».source.port`). Specification complete : docs/PACKS.md.
 *
 * JAMAIS de secret dans un pack : mots de passe, identifiants de camera, cles, jetons et adresses des destinataires sont
 * remplaces par un marqueur, demande a l'installateur au moment de l'application :
 *   {"$ask": "libelle"}   question posee (ou lue dans un fichier de reponses) ; meme libelle = meme reponse
 *   {"$env": "NOM"}       variable d'environnement
 * Un secret ecrit en clair (cle de type mot de passe, identifiants dans une adresse, jeton reconnaissable) fait refuser
 * le pack entier, avant toute autre verification (voir `findSecrets`).
 */
import { parseSchedule } from '../../server/arming.ts';
import type { Window } from '../../server/arming.ts';
import { DAHUA_CODES, DAHUA_SUPERVISION_S } from '../../server/dahua.ts';
import { MAX_FLOORS } from '../../server/floors.ts';
import { DEFENSES } from '../../server/risk.ts';
import { CATEGORIES, checkSensorSettings } from '../../server/sources.ts';
import { hasForbiddenChar, normalizeName } from '../../server/text.ts';
import { TUYA_ID, TUYA_SUPERVISION_S } from '../../server/tuya.ts';
import { SENSOR_SPECS, SENSOR_TYPES, TUYA_PSIM_CATEGORIES } from '../../server/tuyasensors.ts';
import type { SensorType } from '../../server/tuyasensors.ts';
import type { DeviceCategory, Direction } from '../../server/types.ts';
import { ASPECTS, HOST_PATTERN } from '../../server/video.ts';
import type { Aspect } from '../../server/video.ts';

export const PACK_VERSION = 1;
export const SEGMENTS = ['villa', 'appartement', 'boutique', 'pharmacie', 'entrepot', 'bureau', 'restaurant', 'hotel', 'ecole', 'sante', 'industrie', 'chantier', 'autre'] as const;
export const LEVELS = ['essentiel', 'confort', 'renforce'] as const;
export const QUALIFICATIONS = ['qualified', 'to_qualify'] as const;
export const GATEWAY_MODULES = ['heartbeat', 'zigbee', 'modbus', 'ups', 'sia', 'lorawan'] as const;
export const RECIPIENT_CHANNELS = ['email', 'telegram', 'whatsapp', 'webhook'] as const;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const MODEL = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const GATEWAY_USER = /^[A-Za-z0-9._-]{1,32}$/;
const GATEWAY_PATTERN = /^[A-Za-z0-9_-]{1,32}\*?$/;
const PLAN_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,199}$/;
const RTSP_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{0,199}$/;
const MAX_HEARTBEAT_S = 7 * 24 * 3600;
const MAX_DEVICES = 500;

// ---------------------------------------------------------------- types

/** Valeur a fournir a l'installation (jamais ecrite dans le pack). */
export type Marker = { $ask: string } | { $env: string };
/** Valeur ordinaire ecrite dans le pack, ou marqueur. */
export type Value = string | Marker;

/** Nature d'une valeur a fournir : elle decide de sa verification et du masquage de la saisie. */
export type ValueKind = 'host' | 'username' | 'password' | 'tuyaId' | 'address:email' | 'address:telegram' | 'address:whatsapp' | 'address:webhook';
export const SECRET_KINDS: ReadonlySet<ValueKind> = new Set(['password']);

export interface Question {
  /** Cle de la reponse : le libelle du `$ask`, ou `$env:NOM`. */
  key: string;
  label: string;
  kind: ValueKind;
  secret: boolean;
  env: string | null;
  /** Ou la valeur est utilisee (chemins dans le pack). */
  paths: string[];
}

export interface PackFloor {
  id: string;
  name: string;
  /** Chemin du plan, relatif au dossier du pack ; null = pas de plan. */
  plan: string | null;
}

export interface PackZone {
  name: string;
  floor: string;
}

export interface CameraSource {
  type: 'rtsp' | 'onvif';
  host: Value;
  port: number;
  path: string | null;
  aspect: Aspect;
  credentials: { username: Marker; password: Marker } | null;
}

export type DetectorSource =
  | { type: 'dahua'; camera: string; channel: number; events: string[]; httpPort: number }
  | { type: 'tuya'; tuyaId: Value; sensorType: SensorType | null }
  | { type: 'network'; host: Value; port: number };

export interface PackDevice {
  id: string;
  kind: 'detector' | 'camera';
  name: string;
  zone: string;
  /** Identifiant de l'etage DANS le pack. */
  floor: string;
  x: number;
  y: number;
  model: string;
  qualification: (typeof QUALIFICATIONS)[number];
  category: DeviceCategory;
  unit: string | null;
  warnAt: number | null;
  alarmAt: number | null;
  direction: Direction;
  /** Valeur EFFECTIVE (memes regles que le moteur et les sources) : c'est elle qui est comparee a l'existant. */
  heartbeatS: number | null;
  source: CameraSource | DetectorSource | null;
}

export interface PackRecipient {
  channel: (typeof RECIPIENT_CHANNELS)[number];
  level: 1 | 2;
  label: string;
  address: Marker;
  zones: string[] | null;
}

export interface Pack {
  packVersion: 1;
  id: string;
  name: string;
  segment: (typeof SEGMENTS)[number];
  level: (typeof LEVELS)[number];
  description: string;
  version: string;
  floors: PackFloor[];
  zones: PackZone[];
  devices: PackDevice[];
  links: Record<string, string[]>;
  arming: { zone: string; schedule: Window[] }[];
  risk: { zone: string; probability: number; defenses: string[]; impacts: { image: number; economy: number; human: number }; notes: string }[];
  recipients: PackRecipient[];
  gateway: { accounts: { name: string; devices: string[] }[]; modules: { module: (typeof GATEWAY_MODULES)[number]; note: string }[] };
}

export interface Validation {
  pack: Pack | null;
  errors: string[];
  questions: Question[];
}

export const isMarker = (v: unknown): v is Marker =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && ('$ask' in v || '$env' in v);

// ---------------------------------------------------------------- detection des secrets

/** Noms de cle qui designent un secret (compares sans casse ni separateur). */
const SECRET_KEY_PARTS = ['password', 'passwd', 'motdepasse', 'secret', 'token', 'jeton', 'apikey', 'accesskey', 'privatekey', 'passphrase'];
const SECRET_KEY_EXACT = new Set(['pass', 'pwd', 'mdp', 'cle', 'key', 'psk', 'pin', 'credentials', 'auth']);
const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
const ASSIGNED_SECRET = /(password|passwd|pwd|pass|mot de passe|mdp|secret|token|jeton|api[_-]?key|access[_-]?secret)\s*[=:]\s*\S{2,}/i;
const RECOGNIZED = [
  { re: /psk_\d{1,9}_[A-Za-z0-9_-]{43}/, what: "cle d'equipement du PSIM" },
  { re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, what: 'jeton de robot Telegram' },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, what: 'jeton JWT' },
  { re: /\b[a-f0-9]{32,}\b/i, what: 'cle hexadecimale (secret Tuya, cle de chiffrement)' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'cle privee' },
];

const keyLooksSecret = (key: string): boolean => {
  const k = key.toLowerCase().replace(/[^a-z]/g, '');
  return SECRET_KEY_EXACT.has(k) || SECRET_KEY_PARTS.some((p) => k.includes(p));
};

/**
 * Parcourt TOUT le document (cles connues ou non) et rend un message par secret ecrit en clair. Un objet `credentials`
 * est legitime s'il ne contient que des marqueurs ; une cle de type mot de passe qui porte une valeur (texte, nombre)
 * est refusee, comme une adresse avec identifiants (`rtsp://admin:xxx@...`) ou un jeton reconnaissable.
 */
export function findSecrets(raw: unknown): string[] {
  const out: string[] = [];
  const advice = 'utiliser {"$ask": "libelle"} ou {"$env": "NOM"} (voir docs/PACKS.md)';
  const walk = (v: unknown, path: string, secretKey: boolean): void => {
    if (isMarker(v)) return;
    if (typeof v === 'string' || typeof v === 'number') {
      const s = String(v);
      if (secretKey && s !== '') {
        out.push(`${path} : secret en clair interdit dans un pack ; ${advice}`);
        return;
      }
      if (typeof v !== 'string') return;
      if (URL_USERINFO.test(s)) out.push(`${path} : secret en clair interdit dans un pack (identifiants dans une adresse « utilisateur:motdepasse@ ») ; ${advice}`);
      else if (ASSIGNED_SECRET.test(s) || /[?&](pwd|password|passwd|pass|token|key|secret)=/i.test(s)) out.push(`${path} : secret en clair interdit dans un pack (mot de passe ou jeton dans le texte) ; ${advice}`);
      else {
        const hit = RECOGNIZED.find((r) => r.re.test(s));
        if (hit) out.push(`${path} : secret en clair interdit dans un pack (${hit.what}) ; ${advice}`);
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`, secretKey));
      return;
    }
    if (typeof v === 'object' && v !== null) {
      for (const [k, child] of Object.entries(v)) {
        // `credentials` est un objet : ce sont ses valeurs qui sont controlees (elles doivent etre des marqueurs).
        const isContainer = typeof child === 'object' && child !== null;
        walk(child, path ? `${path}.${k}` : k, secretKey || (!isContainer && keyLooksSecret(k)) || (isContainer && keyLooksSecret(k) && k !== 'credentials'));
      }
    }
  };
  walk(raw, '', false);
  return out;
}

// ---------------------------------------------------------------- outils de validation

type Obj = Record<string, unknown>;

class Checker {
  errors: string[] = [];
  questions = new Map<string, Question>();

  fail(path: string, message: string): void {
    this.errors.push(`${path || 'pack'} : ${message}`);
  }

  /** Objet avec exactement ces cles (obligatoires / facultatives). */
  obj(v: unknown, path: string, required: string[], optional: string[] = []): Obj | null {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      this.fail(path, 'un objet { ... } est attendu');
      return null;
    }
    const o = v as Obj;
    const allowed = [...required, ...optional];
    for (const k of Object.keys(o)) {
      if (!allowed.includes(k)) this.fail(`${path ? `${path}.` : ''}${k}`, `cle inconnue (cles possibles : ${allowed.join(', ')})`);
    }
    for (const k of required) if (o[k] === undefined) this.fail(`${path ? `${path}.` : ''}${k}`, 'obligatoire');
    return o;
  }

  arr(v: unknown, path: string, min: number, max: number): unknown[] {
    if (!Array.isArray(v)) {
      this.fail(path, 'une liste [ ... ] est attendue');
      return [];
    }
    if (v.length < min || v.length > max) this.fail(path, `de ${min} a ${max} element(s) attendu(s), ${v.length} fourni(s)`);
    return v.slice(0, max);
  }

  str(v: unknown, path: string, opts: { max: number; pattern?: RegExp; hint?: string; name?: boolean; empty?: boolean }): string {
    if (typeof v !== 'string') {
      this.fail(path, 'un texte est attendu');
      return '';
    }
    if (opts.name && hasForbiddenChar(v)) {
      this.fail(path, 'caracteres de controle ou invisibles interdits');
      return '';
    }
    const s = opts.name ? normalizeName(v) : v;
    if (!s && !opts.empty) this.fail(path, 'ne doit pas etre vide');
    else if (s.length > opts.max) this.fail(path, `${opts.max} caracteres au plus`);
    else if (opts.pattern && s && !opts.pattern.test(s)) this.fail(path, `format invalide${opts.hint ? ` (${opts.hint})` : ''}`);
    return s;
  }

  int(v: unknown, path: string, min: number, max: number): number {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      this.fail(path, `un entier de ${min} a ${max} est attendu`);
      return min;
    }
    return v;
  }

  num(v: unknown, path: string, min: number, max: number): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      this.fail(path, `un nombre de ${min} a ${max} est attendu`);
      return min;
    }
    return v;
  }

  oneOf<T extends string>(v: unknown, path: string, values: readonly T[]): T {
    if (typeof v !== 'string' || !values.includes(v as T)) {
      this.fail(path, `valeur invalide (${values.join(', ')})`);
      return values[0];
    }
    return v as T;
  }

  /** Marqueur `$ask` / `$env` bien forme ; il est enregistre comme question. */
  marker(v: unknown, path: string, kind: ValueKind): Marker | null {
    if (!isMarker(v)) {
      this.fail(path, 'un marqueur {"$ask": "libelle"} ou {"$env": "NOM"} est attendu');
      return null;
    }
    let key: string;
    let label: string;
    let env: string | null = null;
    if ('$ask' in v) {
      if (typeof v.$ask !== 'string' || !v.$ask.trim() || v.$ask.length > 120 || hasForbiddenChar(v.$ask)) {
        this.fail(`${path}.$ask`, 'libelle de 1 a 120 caracteres attendu');
        return null;
      }
      label = normalizeName(v.$ask);
      key = label;
    } else {
      if (typeof v.$env !== 'string' || !ENV_NAME.test(v.$env)) {
        this.fail(`${path}.$env`, 'nom de variable invalide (MAJUSCULES, chiffres et _ ; ex. PSIM_PACK_NVR_PASSWORD)');
        return null;
      }
      env = v.$env;
      key = `$env:${env}`;
      label = `variable ${env}`;
    }
    const secret = SECRET_KINDS.has(kind);
    const known = this.questions.get(key);
    if (known) {
      if (known.kind !== kind) {
        this.fail(path, `le libelle « ${label} » designe deja une autre sorte de valeur (${known.kind}, en ${known.paths[0]}) : choisir un autre libelle`);
        return null;
      }
      known.paths.push(path);
    } else {
      this.questions.set(key, { key, label, kind, secret, env, paths: [path] });
    }
    return '$ask' in v ? { $ask: label } : { $env: env! };
  }

  /** Valeur d'installation : texte ecrit dans le pack (verifie selon sa nature) ou marqueur. */
  value(v: unknown, path: string, kind: ValueKind): Value {
    if (isMarker(v)) return this.marker(v, path, kind) ?? '';
    if (kind === 'host') return this.str(v, path, { max: 253, pattern: HOST_PATTERN, hint: 'adresse IPv4 ou nom de machine, sans http:// ni chemin' });
    if (kind === 'tuyaId') return this.str(v, path, { max: 64, pattern: TUYA_ID, hint: "identifiant d'appareil Tuya, lettres et chiffres" });
    this.fail(path, 'un marqueur {"$ask": "libelle"} ou {"$env": "NOM"} est attendu');
    return '';
  }
}

/** Libelle de chemin lisible : `devices[2] « CAM-03 »`. */
const at = (list: string, i: number, item: unknown): string => {
  const id = typeof item === 'object' && item !== null ? ((item as Obj).id ?? (item as Obj).name ?? (item as Obj).zone) : undefined;
  return typeof id === 'string' && id.length <= 40 ? `${list}[${i}] « ${id} »` : `${list}[${i}]`;
};

const fold = (s: string) => s.normalize('NFC').trim().toLocaleLowerCase('fr');

// ---------------------------------------------------------------- validation

export function validatePack(raw: unknown): Validation {
  const c = new Checker();
  // 1. Les secrets d'abord : un pack qui en contient est refuse, quelle que soit la suite.
  const secrets = findSecrets(raw);
  c.errors.push(...secrets);

  const root = c.obj(raw, '', ['packVersion', 'id', 'name', 'segment', 'level', 'version', 'floors', 'devices'], ['description', 'zones', 'links', 'arming', 'risk', 'recipients', 'gateway']);
  if (!root) return { pack: null, errors: c.errors, questions: [] };
  if (root.packVersion !== PACK_VERSION) c.fail('packVersion', `version de format non prise en charge (attendu : ${PACK_VERSION})`);
  const id = c.str(root.id, 'id', { max: 64, pattern: PACK_ID, hint: 'minuscules, chiffres et tirets, ex. villa-essentiel' });
  const name = c.str(root.name, 'name', { max: 120, name: true });
  const segment = c.oneOf(root.segment, 'segment', SEGMENTS);
  const level = c.oneOf(root.level, 'level', LEVELS);
  const description = root.description === undefined ? '' : c.str(root.description, 'description', { max: 2000, name: false, empty: true });
  if (typeof root.description === 'string' && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(root.description)) c.fail('description', 'caracteres de controle interdits');
  const version = c.str(root.version, 'version', { max: 16, pattern: SEMVER, hint: 'trois nombres, ex. 1.0.0' });

  // Etages
  const floors: PackFloor[] = [];
  c.arr(root.floors, 'floors', 1, MAX_FLOORS).forEach((item, i) => {
    const p = at('floors', i, item);
    const o = c.obj(item, p, ['id', 'name'], ['plan']);
    if (!o) return;
    const fid = c.str(o.id, `${p}.id`, { max: 32, pattern: KEY_ID, hint: 'minuscules, chiffres, - et _, ex. rdc' });
    const fname = c.str(o.name, `${p}.name`, { max: 40, name: true });
    let plan: string | null = null;
    if (o.plan !== undefined) {
      plan = c.str(o.plan, `${p}.plan`, { max: 200, pattern: PLAN_PATH, hint: 'chemin relatif au dossier du pack, ex. plans/rdc.svg' });
      if (plan.split('/').some((s) => s === '..' || s === '.' || s === '')) c.fail(`${p}.plan`, 'chemin relatif simple attendu (ni « .. », ni « / » initial)');
      if (!/\.(png|jpe?g|webp|svg)$/i.test(plan)) c.fail(`${p}.plan`, 'image PNG, JPEG, WEBP ou SVG attendue (extension .png, .jpg, .jpeg, .webp ou .svg)');
    }
    if (floors.some((f) => f.id === fid)) c.fail(`${p}.id`, `identifiant d'etage en double (« ${fid} »)`);
    if (fname && floors.some((f) => fold(f.name) === fold(fname))) c.fail(`${p}.name`, `nom d'etage en double (« ${fname} »)`);
    floors.push({ id: fid, name: fname, plan });
  });
  const floorIds = new Set(floors.map((f) => f.id));

  // Zones : chacune sur UN etage (comme le moteur l'impose)
  const zones: PackZone[] = [];
  (root.zones === undefined ? [] : c.arr(root.zones, 'zones', 0, 200)).forEach((item, i) => {
    const p = at('zones', i, item);
    const o = c.obj(item, p, ['name', 'floor']);
    if (!o) return;
    const zname = c.str(o.name, `${p}.name`, { max: 80, name: true });
    const zfloor = c.str(o.floor, `${p}.floor`, { max: 32 });
    if (zfloor && !floorIds.has(zfloor)) c.fail(`${p}.floor`, `etage inconnu « ${zfloor} » (etages du pack : ${[...floorIds].join(', ')})`);
    if (zname && zones.some((z) => fold(z.name) === fold(zname))) c.fail(`${p}.name`, `zone en double (« ${zname} ») : une zone appartient a un seul etage`);
    zones.push({ name: zname, floor: zfloor });
  });
  const zoneByName = new Map(zones.map((z) => [z.name, z]));

  // Equipements
  const devices: PackDevice[] = [];
  const rawDevices = c.arr(root.devices, 'devices', 1, MAX_DEVICES);
  rawDevices.forEach((item, i) => {
    const d = parseDevice(c, item, at('devices', i, item), floors, zoneByName);
    if (!d) return;
    if (devices.some((x) => x.id === d.id)) c.fail(`${at('devices', i, item)}.id`, `identifiant d'equipement en double (« ${d.id} »)`);
    devices.push(d);
  });
  const byId = new Map(devices.map((d) => [d.id, d]));
  for (const z of zones) if (z.name && !devices.some((d) => d.zone === z.name)) c.fail(`zones « ${z.name} »`, 'zone declaree sans aucun equipement (la retirer, ou y placer un equipement)');

  // Sources : references croisees
  devices.forEach((d) => {
    const p = `devices « ${d.id} ».source`;
    const s = d.source;
    if (!s) return;
    if (s.type === 'dahua') {
      const cam = byId.get(s.camera);
      if (!cam || cam.kind !== 'camera') c.fail(`${p}.camera`, `camera inconnue dans le pack (« ${s.camera} »)`);
      else if (!cam.source || !('credentials' in cam.source) || !cam.source.credentials) {
        c.fail(`${p}.camera`, `la camera « ${s.camera} » doit avoir une source rtsp ou onvif avec des identifiants (credentials) : ils servent a lire les evenements`);
      }
    }
  });
  const tuyaIds = devices.flatMap((d) => (d.source?.type === 'tuya' && typeof d.source.tuyaId === 'string' ? [[d.id, d.source.tuyaId] as const] : []));
  tuyaIds.forEach(([did, tid], i) => {
    if (tuyaIds.findIndex(([, t]) => t === tid) !== i) c.fail(`devices « ${did} ».source.tuyaId`, `appareil Tuya deja utilise par un autre equipement du pack (« ${tid} »)`);
  });

  // Liens detecteur -> cameras
  const links: Record<string, string[]> = {};
  if (root.links !== undefined) {
    const o = c.obj(root.links, 'links', [], devices.filter((d) => d.kind === 'detector').map((d) => d.id));
    for (const [det, cams] of Object.entries(o ?? {})) {
      if (byId.get(det)?.kind !== 'detector') continue; // deja signale (cle inconnue)
      const list = c.arr(cams, `links.${det}`, 1, 20).map((cam, j) => c.str(cam, `links.${det}[${j}]`, { max: 32 }));
      list.forEach((cam, j) => {
        if (cam && byId.get(cam)?.kind !== 'camera') c.fail(`links.${det}[${j}]`, `camera inconnue dans le pack (« ${cam} »)`);
      });
      if (new Set(list).size !== list.length) c.fail(`links.${det}`, 'camera citee deux fois');
      links[det] = [...new Set(list)].sort();
    }
  }

  // Armement par zone
  const arming: Pack['arming'] = [];
  (root.arming === undefined ? [] : c.arr(root.arming, 'arming', 0, 200)).forEach((item, i) => {
    const p = at('arming', i, item);
    const o = c.obj(item, p, ['zone', 'schedule']);
    if (!o) return;
    const zone = c.str(o.zone, `${p}.zone`, { max: 80, name: true });
    if (zone && !devices.some((d) => d.zone === zone && d.kind === 'detector' && d.category === 'intrusion')) {
      c.fail(`${p}.zone`, `aucun detecteur d'intrusion du pack dans la zone « ${zone} » : seul l'intrusion s'arme et se desarme`);
    }
    if (arming.some((a) => a.zone === zone)) c.fail(`${p}.zone`, `planning en double pour la zone « ${zone} »`);
    try {
      const schedule = parseSchedule(o.schedule);
      if (!schedule) c.fail(`${p}.schedule`, 'liste de plages attendue');
      else arming.push({ zone, schedule });
    } catch (err) {
      c.fail(`${p}.schedule`, (err as Error).message);
    }
  });

  // Evaluation de risque par zone
  const risk: Pack['risk'] = [];
  (root.risk === undefined ? [] : c.arr(root.risk, 'risk', 0, 200)).forEach((item, i) => {
    const p = at('risk', i, item);
    const o = c.obj(item, p, ['zone', 'probability', 'defenses', 'impacts'], ['notes']);
    if (!o) return;
    const zone = c.str(o.zone, `${p}.zone`, { max: 80, name: true });
    if (zone && !devices.some((d) => d.zone === zone)) c.fail(`${p}.zone`, `aucun equipement du pack dans la zone « ${zone} »`);
    if (risk.some((r) => r.zone === zone)) c.fail(`${p}.zone`, `evaluation en double pour la zone « ${zone} »`);
    const probability = c.int(o.probability, `${p}.probability`, 1, 3);
    const defenses = c.arr(o.defenses, `${p}.defenses`, 0, DEFENSES.length).map((dv, j) => c.oneOf(dv, `${p}.defenses[${j}]`, DEFENSES.map((x) => x.id)));
    if (new Set(defenses).size !== defenses.length) c.fail(`${p}.defenses`, 'ligne de defense citee deux fois');
    const im = c.obj(o.impacts, `${p}.impacts`, ['image', 'economy', 'human']);
    const impacts = { image: c.int(im?.image, `${p}.impacts.image`, 1, 5), economy: c.int(im?.economy, `${p}.impacts.economy`, 1, 5), human: c.int(im?.human, `${p}.impacts.human`, 1, 5) };
    const notes = o.notes === undefined ? '' : c.str(o.notes, `${p}.notes`, { max: 500, empty: true, name: true });
    risk.push({ zone, probability, defenses: [...new Set(defenses)].sort(), impacts, notes });
  });

  // Destinataires en gabarit
  const recipients: PackRecipient[] = [];
  const detectorZones = new Set(devices.filter((d) => d.kind === 'detector' && d.zone).map((d) => d.zone));
  (root.recipients === undefined ? [] : c.arr(root.recipients, 'recipients', 0, 50)).forEach((item, i) => {
    const p = `recipients[${i}]`;
    const o = c.obj(item, p, ['channel', 'level', 'label'], ['address', 'zones']);
    if (!o) return;
    if (o.channel === 'callmebot') {
      c.fail(`${p}.channel`, 'les destinataires CallMeBot se declarent dans le .env (chacun a sa cle secrete), pas dans un pack');
      return;
    }
    const channel = c.oneOf(o.channel, `${p}.channel`, RECIPIENT_CHANNELS);
    let lvl: 1 | 2 = 1;
    if (o.level === 1 || o.level === 2) lvl = o.level;
    else c.fail(`${p}.level`, 'niveau 1 ou 2 attendu');
    const addressKind = `address:${channel}` as ValueKind;
    const label = c.str(o.label, `${p}.label`, { max: 80, name: true });
    const address =
      o.address === undefined
        ? c.marker({ $ask: `${label || 'Destinataire'} : adresse ${channel} (niveau ${lvl})` }, `${p}.address`, addressKind)
        : isMarker(o.address)
          ? c.marker(o.address, `${p}.address`, addressKind)
          : (c.fail(`${p}.address`, "adresse a remplir a l'installation : {\"$ask\": \"libelle\"} ou {\"$env\": \"NOM\"} (jamais d'adresse reelle dans un pack)"), null);
    let zonesOf: string[] | null = null;
    if (o.zones !== undefined && o.zones !== null) {
      zonesOf = c.arr(o.zones, `${p}.zones`, 1, 50).map((z, j) => {
        const zn = c.str(z, `${p}.zones[${j}]`, { max: 80, name: true });
        if (zn && !detectorZones.has(zn)) c.fail(`${p}.zones[${j}]`, `zone sans detecteur dans le pack (« ${zn} »)`);
        return zn;
      });
      zonesOf = [...new Set(zonesOf)];
    }
    if (recipients.some((r) => r.channel === channel && r.level === lvl && r.label === label)) c.fail(p, `destinataire en double (${channel}, niveau ${lvl}, « ${label} »)`);
    if (address) recipients.push({ channel, level: lvl, label, address, zones: zonesOf });
  });

  // Passerelle
  const gateway: Pack['gateway'] = { accounts: [], modules: [] };
  if (root.gateway !== undefined) {
    const g = c.obj(root.gateway, 'gateway', [], ['accounts', 'modules']);
    (g?.accounts === undefined ? [] : c.arr(g.accounts, 'gateway.accounts', 0, 50)).forEach((item, i) => {
      const p = at('gateway.accounts', i, item);
      const o = c.obj(item, p, ['name', 'devices']);
      if (!o) return;
      const gname = c.str(o.name, `${p}.name`, { max: 32, pattern: GATEWAY_USER, hint: 'lettres, chiffres, ., _ et -' });
      const patterns = c.arr(o.devices, `${p}.devices`, 1, 50).map((v, j) => c.str(v, `${p}.devices[${j}]`, { max: 33, pattern: GATEWAY_PATTERN, hint: 'identifiant « D-01 » ou prefixe « Z-* »' }));
      patterns.forEach((pat, j) => {
        if (!pat) return;
        const matched = devices.filter((d) => (pat.endsWith('*') ? d.id.startsWith(pat.slice(0, -1)) : d.id === pat));
        if (matched.length === 0) c.fail(`${p}.devices[${j}]`, `ne designe aucun equipement du pack (« ${pat} »)`);
        for (const d of matched) {
          if (d.kind !== 'detector') c.fail(`${p}.devices[${j}]`, `« ${d.id} » est une camera : une passerelle ne parle que pour des detecteurs`);
          else if (d.source) c.fail(`${p}.devices[${j}]`, `« ${d.id} » est lu par le PSIM lui-meme (source ${d.source.type}) : pas de passerelle`);
        }
      });
      if (gateway.accounts.some((a) => a.name === gname)) c.fail(`${p}.name`, `compte en double (« ${gname} »)`);
      gateway.accounts.push({ name: gname, devices: [...new Set(patterns)] });
    });
    (g?.modules === undefined ? [] : c.arr(g.modules, 'gateway.modules', 0, GATEWAY_MODULES.length)).forEach((item, i) => {
      const p = `gateway.modules[${i}]`;
      const o = c.obj(item, p, ['module'], ['note']);
      if (!o) return;
      const module = c.oneOf(o.module, `${p}.module`, GATEWAY_MODULES);
      const note = o.note === undefined ? '' : c.str(o.note, `${p}.note`, { max: 300, name: true, empty: true });
      if (gateway.modules.some((m) => m.module === module)) c.fail(`${p}.module`, `module cite deux fois (« ${module} »)`);
      gateway.modules.push({ module, note });
    });
  }

  // Un appareil Tuya n'alimente qu'un detecteur : un meme libelle pour deux detecteurs donnerait le meme appareil.
  for (const q of c.questions.values()) {
    if (q.kind === 'tuyaId' && q.paths.length > 1) c.fail(q.paths[1], `le libelle « ${q.label} » est deja utilise pour un autre capteur Tuya (${q.paths[0]}) : un libelle par appareil`);
  }
  if (c.errors.length) return { pack: null, errors: c.errors, questions: [...c.questions.values()] };
  return {
    pack: { packVersion: 1, id, name, segment, level, description, version, floors, zones, devices, links, arming, risk, recipients, gateway },
    errors: [],
    questions: [...c.questions.values()],
  };
}

function parseDevice(c: Checker, item: unknown, p: string, floors: PackFloor[], zones: Map<string, PackZone>): PackDevice | null {
  const common = ['id', 'kind', 'name', 'model', 'qualification'];
  const optional = ['zone', 'floor', 'x', 'y', 'source'];
  const sensor = ['category', 'unit', 'warnAt', 'alarmAt', 'direction', 'heartbeatS'];
  const kind = (item as Obj | null)?.kind;
  const o = c.obj(item, p, common, kind === 'detector' ? [...optional, ...sensor] : optional);
  if (!o) return null;
  const id = c.str(o.id, `${p}.id`, { max: 32, pattern: ID_PATTERN, hint: 'lettres, chiffres, - et _ ; 32 caracteres max' });
  const k = c.oneOf(o.kind, `${p}.kind`, ['detector', 'camera'] as const);
  const name = c.str(o.name, `${p}.name`, { max: 80, name: true });
  const model = c.str(o.model, `${p}.model`, { max: 64, pattern: MODEL, hint: 'reference catalogue en minuscules, ex. dahua-hac-hfw1500th-i8' });
  const qualification = c.oneOf(o.qualification, `${p}.qualification`, QUALIFICATIONS);
  let zone = '';
  let floor = floors[0]?.id ?? '';
  if (o.zone !== undefined) {
    zone = c.str(o.zone, `${p}.zone`, { max: 80, name: true });
    const z = zones.get(zone);
    if (zone && !z) c.fail(`${p}.zone`, `zone non declaree dans « zones » (« ${zone} »)`);
    if (z) floor = z.floor;
  }
  if (o.floor !== undefined) {
    const f = c.str(o.floor, `${p}.floor`, { max: 32 });
    if (f && !floors.some((x) => x.id === f)) c.fail(`${p}.floor`, `etage inconnu « ${f} »`);
    else if (zone && zones.get(zone) && f !== floor) c.fail(`${p}.floor`, `la zone « ${zone} » est a l'etage « ${floor} » : une zone appartient a un seul etage`);
    else floor = f;
  }
  const x = o.x === undefined ? 50 : c.num(o.x, `${p}.x`, 0, 100);
  const y = o.y === undefined ? 50 : c.num(o.y, `${p}.y`, 0, 100);

  // Reglages de capteur (detecteurs seulement), avec les regles du moteur.
  let category: DeviceCategory = 'fire';
  let unit: string | null = null;
  let warnAt: number | null = null;
  let alarmAt: number | null = null;
  let direction: Direction = 'above';
  let heartbeatS: number | null = null;
  let declaredHeartbeat: number | null | undefined;
  if (k === 'detector') {
    category = o.category === undefined ? 'fire' : c.oneOf(o.category, `${p}.category`, CATEGORIES);
    if (o.unit !== undefined && o.unit !== null) unit = c.str(o.unit, `${p}.unit`, { max: 12, name: true, empty: true }) || null;
    const nullableNum = (v: unknown, path: string) => (v === undefined || v === null ? null : c.num(v, path, -1e9, 1e9));
    warnAt = nullableNum(o.warnAt, `${p}.warnAt`);
    alarmAt = nullableNum(o.alarmAt, `${p}.alarmAt`);
    direction = o.direction === undefined ? 'above' : c.oneOf(o.direction, `${p}.direction`, ['above', 'below'] as const);
    const problem = checkSensorSettings({ category, warnAt, alarmAt, direction });
    if (problem) c.fail(p, problem);
    declaredHeartbeat = o.heartbeatS === undefined ? undefined : o.heartbeatS === null ? null : c.int(o.heartbeatS, `${p}.heartbeatS`, 0, MAX_HEARTBEAT_S);
    // Valeur par defaut du moteur : incendie = delai general du PSIM (null), autres categories = non supervise (0).
    heartbeatS = declaredHeartbeat === undefined ? (category === 'fire' ? null : 0) : declaredHeartbeat;
  }

  let source: PackDevice['source'] = null;
  if (o.source !== undefined) {
    const sp = `${p}.source`;
    const type = (o.source as Obj | null)?.type;
    if (k === 'camera') {
      const s = c.obj(o.source, sp, ['type', 'host'], ['port', 'path', 'aspect', 'credentials']);
      if (s) {
        const t = c.oneOf(s.type, `${sp}.type`, ['rtsp', 'onvif'] as const);
        const host = c.value(s.host, `${sp}.host`, 'host');
        const port = s.port === undefined ? (t === 'onvif' ? 80 : 554) : c.int(s.port, `${sp}.port`, 1, 65535);
        let path: string | null = null;
        if (s.path !== undefined) {
          if (t !== 'rtsp') c.fail(`${sp}.path`, 'chemin reserve a une source rtsp');
          else path = c.str(s.path, `${sp}.path`, { max: 200, pattern: RTSP_PATH, hint: 'doit commencer par /' });
        } else if (t === 'rtsp') path = '/';
        const aspect = s.aspect === undefined ? 'auto' : c.oneOf(s.aspect, `${sp}.aspect`, ASPECTS);
        let credentials: CameraSource['credentials'] = null;
        if (s.credentials !== undefined) {
          const cr = c.obj(s.credentials, `${sp}.credentials`, ['username', 'password']);
          if (cr) {
            const username = c.marker(cr.username, `${sp}.credentials.username`, 'username');
            const password = c.marker(cr.password, `${sp}.credentials.password`, 'password');
            if (username && password) credentials = { username, password };
          }
        }
        source = { type: t, host, port, path, aspect, credentials };
      }
    } else if (type === 'dahua') {
      const s = c.obj(o.source, sp, ['type', 'camera', 'channel', 'events'], ['httpPort']);
      if (s) {
        if (category !== 'intrusion') c.fail(`${sp}`, "la detection d'un enregistreur Dahua alimente un detecteur d'intrusion (category: intrusion)");
        if (!zone) c.fail(`${sp}`, "un detecteur alimente par un enregistreur Dahua doit avoir une zone (planning de nuit, destinataires)");
        const events = c.arr(s.events, `${sp}.events`, 1, DAHUA_CODES.length).map((e, j) => c.oneOf(e, `${sp}.events[${j}]`, DAHUA_CODES));
        source = {
          type: 'dahua',
          camera: c.str(s.camera, `${sp}.camera`, { max: 32, pattern: ID_PATTERN }),
          channel: c.int(s.channel, `${sp}.channel`, 1, 128),
          events: [...new Set(events)],
          httpPort: s.httpPort === undefined ? 80 : c.int(s.httpPort, `${sp}.httpPort`, 1, 65535),
        };
        if (declaredHeartbeat === undefined || declaredHeartbeat === null) heartbeatS = DAHUA_SUPERVISION_S;
        else if (declaredHeartbeat < DAHUA_SUPERVISION_S) c.fail(`${p}.heartbeatS`, `un detecteur lu sur un enregistreur Dahua est supervise au moins ${DAHUA_SUPERVISION_S} s`);
      }
    } else if (type === 'tuya') {
      const s = c.obj(o.source, sp, ['type', 'tuyaId'], ['sensorType']);
      if (s) {
        if (!TUYA_PSIM_CATEGORIES.includes(category)) c.fail(sp, `un capteur Tuya alimente un detecteur ${TUYA_PSIM_CATEGORIES.join(', ')}`);
        const sensorType = s.sensorType === undefined || s.sensorType === 'auto' ? null : c.oneOf(s.sensorType, `${sp}.sensorType`, SENSOR_TYPES);
        if (sensorType && !SENSOR_SPECS[sensorType].psimCategories.includes(category)) c.fail(`${sp}.sensorType`, `« ${sensorType} » ne s'associe pas a un detecteur de categorie ${category}`);
        source = { type: 'tuya', tuyaId: c.value(s.tuyaId, `${sp}.tuyaId`, 'tuyaId'), sensorType };
        if (declaredHeartbeat === undefined || declaredHeartbeat === null) heartbeatS = TUYA_SUPERVISION_S;
        else if (declaredHeartbeat < TUYA_SUPERVISION_S) c.fail(`${p}.heartbeatS`, `un capteur Tuya est supervise au moins ${TUYA_SUPERVISION_S} s (deux lectures du cloud)`);
      }
    } else if (type === 'network') {
      const s = c.obj(o.source, sp, ['type', 'host', 'port']);
      if (s) {
        if (category !== 'environment') c.fail(sp, 'la supervision reseau concerne un equipement de categorie environment');
        if (declaredHeartbeat !== undefined && declaredHeartbeat !== 0) c.fail(`${p}.heartbeatS`, 'un equipement supervise par le reseau n\'a pas de delai « aucun message » (0)');
        heartbeatS = 0;
        source = { type: 'network', host: c.value(s.host, `${sp}.host`, 'host'), port: c.int(s.port, `${sp}.port`, 1, 65535) };
      }
    } else {
      c.fail(`${sp}.type`, 'valeur invalide (dahua, tuya ou network pour un detecteur)');
    }
  }
  return { id, kind: k, name, zone, floor, x, y, model, qualification, category, unit, warnAt, alarmAt, direction, heartbeatS, source };
}
