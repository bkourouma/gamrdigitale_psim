/**
 * Registre de qualification en atelier (qualification/registry.json).
 *
 * Regle d'entreprise : aucune reference n'entre dans un pack sans recette en atelier. Chaque modele (ou famille de
 * modeles) est « qualified », « to_qualify » ou « rejected ». Le registre est une DONNEE validee strictement ici ; il n'est
 * modifie que par `npm run qualify` (ecriture atomique), jamais a la main.
 *
 * API pour d'autres modules (importeur de packs, interface) :
 *   isQualified(id)            vrai seulement si le modele est « qualified » ; faux s'il est inconnu, a qualifier ou rejete.
 *   qualificationStatus(id)    'qualified' | 'to_qualify' | 'rejected' | 'unknown'
 *   resolveModel(nom)          retrouve une entree par identifiant, alias ou nom de modele (insensible a la casse et aux separateurs)
 *   checkPackModels(noms)      verdict pour une liste de modeles (voir ModelVerdict)
 * Un registre illisible ou invalide fait LEVER une erreur (RegistryError) : on echoue ferme, jamais ouvert.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic.ts';
import { QUALIF_DIR, getFiche } from './fiches.ts';
import { Problems, array, bool, ID_RE, isObj, isoDate, isoDateTime, oneOf, onlyKeys, text } from './validate.ts';
import type { Obj } from './validate.ts';

export const FAMILIES = ['socle', 'video', 'intrusion', 'incendie_gaz', 'acces', 'environnement', 'energie', 'personnes', 'vehicules', 'notifications'] as const;
export type Family = (typeof FAMILIES)[number];
export const FAMILY_LABEL: Record<Family, string> = {
  socle: 'Socle (poste, onduleur, routeur, switch, parafoudre)',
  video: 'Vidéo',
  intrusion: 'Intrusion',
  incendie_gaz: 'Incendie et gaz',
  acces: 'Contrôle d\'accès',
  environnement: 'Environnement',
  energie: 'Énergie',
  personnes: 'Personnes',
  vehicules: 'Véhicules',
  notifications: 'Notifications',
};

export const STATUSES = ['qualified', 'to_qualify', 'rejected'] as const;
export type Status = (typeof STATUSES)[number];
export const CONNECTION_TYPES = ['existing', 'gateway', 'to_develop'] as const;
export const GATEWAY_MODULES = ['zigbee', 'modbus', 'ups', 'sia', 'lorawan'] as const;

/**
 * Seuls modeles marques « qualified » SANS fichier de resultat : constats faits sur du materiel reel avant l'existence de
 * cet outil (README et docs/HANDOFF-tuya.md). Toute autre qualification passe par `promote` avec un resultat materiel.
 * Ajouter un identifiant ici est un changement de code, relu comme tel : le registre seul ne peut pas l'accorder.
 */
export const LEGACY_QUALIFIED: readonly string[] = ['dahua-xvr5108hs-i3t-voie', 'tuya-smoke-wifi'];

export interface Trial {
  date: string;
  reference: string;
  psim_version: string;
  gateway_version: string | null;
  real_hardware: boolean;
  conditions: string;
  serial_numbers: string[];
  firmware: string | null;
  result_file: string | null;
  result_sha256: string | null;
  legacy: boolean;
}
export interface HistoryItem {
  at: string;
  by: string;
  from: Status | null;
  to: Status;
  reason: string;
  result_file: string | null;
}
export interface Entry {
  id: string;
  family: Family;
  manufacturer: string;
  model: string;
  kind: 'model' | 'generic';
  aliases: string[];
  connection: { type: (typeof CONNECTION_TYPES)[number]; module: string | null; detail: string };
  fiche: string;
  profile: string | null;
  status: Status;
  scope: string;
  not_covered: string;
  last_trial: Trial | null;
  simulated_tests: string[];
  history: HistoryItem[];
  notes: string;
}
export interface Registry {
  schema: 1;
  entries: Entry[];
}

export class RegistryError extends Error {
  readonly problems: string[];
  constructor(message: string, problems: string[] = []) {
    super(problems.length ? `${message}\n- ${problems.join('\n- ')}` : message);
    this.name = 'RegistryError';
    this.problems = problems;
  }
}

export const normalizeName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

// ---------------------------------------------------------------- validation

const TRIAL_KEYS = ['date', 'reference', 'psim_version', 'gateway_version', 'real_hardware', 'conditions', 'serial_numbers', 'firmware', 'result_file', 'result_sha256', 'legacy'];
const HISTORY_KEYS = ['at', 'by', 'from', 'to', 'reason', 'result_file'];
const ENTRY_KEYS = ['id', 'family', 'manufacturer', 'model', 'kind', 'aliases', 'connection', 'fiche', 'profile', 'status', 'scope', 'not_covered', 'last_trial', 'simulated_tests', 'history', 'notes'];

function validateTrial(p: Problems, path: string, t: unknown): void {
  if (!isObj(t)) return void p.add(path, 'objet ou null attendu');
  onlyKeys(p, path, t, TRIAL_KEYS);
  isoDate(p, `${path}.date`, t.date);
  text(p, `${path}.reference`, t.reference, { max: 400 });
  text(p, `${path}.psim_version`, t.psim_version, { max: 80 });
  if (t.gateway_version !== null) text(p, `${path}.gateway_version`, t.gateway_version, { max: 80 });
  bool(p, `${path}.real_hardware`, t.real_hardware);
  text(p, `${path}.conditions`, t.conditions, { max: 600 });
  if (array(p, `${path}.serial_numbers`, t.serial_numbers, { max: 20 })) for (const [i, s] of t.serial_numbers.entries()) text(p, `${path}.serial_numbers[${i}]`, s, { max: 80 });
  if (t.firmware !== null) text(p, `${path}.firmware`, t.firmware, { max: 80 });
  if (t.result_file !== null) text(p, `${path}.result_file`, t.result_file, { max: 200 });
  if (t.result_sha256 !== null && (typeof t.result_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(t.result_sha256))) p.add(`${path}.result_sha256`, 'empreinte SHA-256 (64 hexadecimaux) ou null attendue');
  bool(p, `${path}.legacy`, t.legacy);
}

/** Validation stricte de la structure ET des regles d'honnetete. Renvoie la liste des problemes (vide = valide). */
export function validateRegistry(raw: unknown, ficheDir: string | null = QUALIF_DIR): string[] {
  const p = new Problems();
  if (!isObj(raw)) return ['registry : objet attendu'];
  onlyKeys(p, 'registry', raw, ['schema', 'entries']);
  if (raw.schema !== 1) p.add('registry.schema', 'schema 1 attendu');
  if (!array(p, 'registry.entries', raw.entries, { min: 1 })) return p.list;

  const ids = new Set<string>();
  const names = new Map<string, string>();
  for (const [i, e] of raw.entries.entries()) {
    const path = `entries[${i}]`;
    if (!isObj(e)) {
      p.add(path, 'objet attendu');
      continue;
    }
    onlyKeys(p, path, e, ENTRY_KEYS);
    const idOk = typeof e.id === 'string' && ID_RE.test(e.id);
    if (!idOk) p.add(`${path}.id`, 'identifiant invalide (minuscules, chiffres et tirets, 2 a 64 caracteres)');
    else {
      if (ids.has(e.id as string)) p.add(`${path}.id`, `doublon : ${e.id}`);
      ids.add(e.id as string);
    }
    const label = idOk ? `${path}(${e.id})` : path;
    oneOf(p, `${label}.family`, e.family, FAMILIES);
    text(p, `${label}.manufacturer`, e.manufacturer, { max: 120 });
    text(p, `${label}.model`, e.model, { max: 160 });
    oneOf(p, `${label}.kind`, e.kind, ['model', 'generic']);
    if (array(p, `${label}.aliases`, e.aliases, { max: 12 })) {
      for (const [k, a] of e.aliases.entries()) text(p, `${label}.aliases[${k}]`, a, { max: 80 });
    }
    // Unicite des noms utilisables dans un pack : identifiants et alias ne designent qu'une seule entree.
    const claim = (name: unknown, where: string) => {
      if (typeof name !== 'string' || !name.trim()) return;
      const key = normalizeName(name);
      const holder = names.get(key);
      if (holder && holder !== e.id) p.add(where, `« ${name} » designe deja ${holder}`);
      else names.set(key, String(e.id));
    };
    if (idOk) claim(e.id, `${label}.id`);
    if (Array.isArray(e.aliases)) for (const a of e.aliases) claim(a, `${label}.aliases`);

    if (!isObj(e.connection)) p.add(`${label}.connection`, 'objet attendu');
    else {
      onlyKeys(p, `${label}.connection`, e.connection, ['type', 'module', 'detail']);
      oneOf(p, `${label}.connection.type`, e.connection.type, CONNECTION_TYPES);
      text(p, `${label}.connection.detail`, e.connection.detail, { max: 400 });
      if (e.connection.type === 'gateway') {
        if (!oneOf(p, `${label}.connection.module`, e.connection.module, GATEWAY_MODULES)) p.add(`${label}.connection.module`, 'module de passerelle obligatoire pour un raccordement par passerelle');
      } else if (e.connection.module !== null) p.add(`${label}.connection.module`, 'null attendu hors raccordement par passerelle');
    }

    text(p, `${label}.fiche`, e.fiche, { max: 60 });
    if (e.profile !== null) text(p, `${label}.profile`, e.profile, { max: 40 });
    if (ficheDir !== null && typeof e.fiche === 'string') {
      const fiche = getFiche(e.fiche, ficheDir);
      if (!fiche) p.add(`${label}.fiche`, `fiche de recette inconnue : ${e.fiche}`);
      else {
        const profs = Object.keys(fiche.profils);
        if (profs.length && (typeof e.profile !== 'string' || !profs.includes(e.profile))) p.add(`${label}.profile`, `profil obligatoire parmi : ${profs.join(', ')}`);
        if (!profs.length && e.profile !== null) p.add(`${label}.profile`, 'null attendu (cette fiche n\'a pas de profils)');
      }
    }

    oneOf(p, `${label}.status`, e.status, STATUSES);
    text(p, `${label}.scope`, e.scope, { max: 800 });
    text(p, `${label}.not_covered`, e.not_covered, { max: 800, empty: true });
    text(p, `${label}.notes`, e.notes, { max: 800, empty: true });
    if (array(p, `${label}.simulated_tests`, e.simulated_tests, { max: 12 })) for (const [k, s] of e.simulated_tests.entries()) text(p, `${label}.simulated_tests[${k}]`, s, { max: 200 });

    // Historique : enchainement coherent des changements de statut.
    let last: Status | null = null;
    if (array(p, `${label}.history`, e.history, { max: 200 })) {
      for (const [k, h] of e.history.entries()) {
        const hp = `${label}.history[${k}]`;
        if (!isObj(h)) {
          p.add(hp, 'objet attendu');
          continue;
        }
        onlyKeys(p, hp, h, HISTORY_KEYS);
        isoDateTime(p, `${hp}.at`, h.at);
        text(p, `${hp}.by`, h.by, { max: 120 });
        text(p, `${hp}.reason`, h.reason, { max: 600 });
        if (h.from !== null) oneOf(p, `${hp}.from`, h.from, STATUSES);
        oneOf(p, `${hp}.to`, h.to, STATUSES);
        if (h.result_file !== null) text(p, `${hp}.result_file`, h.result_file, { max: 200 });
        if (k === 0 ? h.from !== null && h.from !== 'to_qualify' : h.from !== last) p.add(`${hp}.from`, `doit etre « ${k === 0 ? 'null' : last} »`);
        last = (h.to as Status) ?? last;
      }
      if (e.history.length === 0 && e.status !== 'to_qualify') p.add(`${label}.history`, `un statut « ${String(e.status)} » exige un historique qui le justifie`);
      if (e.history.length > 0 && last !== e.status) p.add(`${label}.history`, `le dernier changement (${String(last)}) ne correspond pas au statut ${String(e.status)}`);
    }

    // Regles d'honnetete.
    if (e.last_trial !== null) validateTrial(p, `${label}.last_trial`, e.last_trial);
    const trial = isObj(e.last_trial) ? e.last_trial : null;
    // Un constat historique (avant cet outil) n'existe que pour les identifiants figes dans LEGACY_QUALIFIED.
    if (trial && trial.legacy === true) {
      if (!LEGACY_QUALIFIED.includes(String(e.id))) p.add(`${label}.last_trial.legacy`, 'constat historique non autorise pour ce modele : seule une promotion avec un resultat materiel peut le qualifier');
      if (trial.result_file !== null || trial.result_sha256 !== null) p.add(`${label}.last_trial`, "un constat historique n'a pas de fichier de resultat");
      if (trial.real_hardware !== true) p.add(`${label}.last_trial.real_hardware`, 'un constat historique porte sur du materiel reel');
    }
    if (e.status === 'qualified') {
      if (!trial) p.add(`${label}.last_trial`, 'un modele « qualified » exige un dernier essai');
      else {
        if (trial.real_hardware !== true) p.add(`${label}.last_trial.real_hardware`, 'un modele ne peut etre « qualified » que sur un essai avec materiel reel');
        if (trial.legacy !== true) {
          if (typeof trial.result_file !== 'string' || typeof trial.result_sha256 !== 'string') p.add(`${label}.last_trial`, 'un modele « qualified » exige un fichier de resultat materiel et son empreinte (ou un constat historique autorise)');
          if (!Array.isArray(trial.serial_numbers) || trial.serial_numbers.length === 0) p.add(`${label}.last_trial.serial_numbers`, 'au moins un numero de serie');
        }
      }
    }
    if (e.status === 'rejected' && (typeof e.notes !== 'string' || !e.notes.trim())) p.add(`${label}.notes`, 'un modele « rejected » doit expliquer pourquoi');
  }
  return p.list;
}

// ---------------------------------------------------------------- lecture et ecriture

export const registryPath = (dir: string = QUALIF_DIR): string => join(dir, 'registry.json');

/** Lit et valide le registre. Leve RegistryError si le fichier manque, est illisible ou invalide (echec ferme). */
export function loadRegistry(dir: string = QUALIF_DIR): Registry {
  const file = registryPath(dir);
  if (!existsSync(file)) throw new RegistryError(`registre introuvable : ${file}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new RegistryError(`registre illisible (${file}) : ${(err as Error).message}`);
  }
  // La validation des profils lit fiches.json du MEME dossier.
  const problems = validateRegistry(raw, dir);
  if (problems.length) throw new RegistryError(`registre invalide (${file})`, problems);
  return raw as Registry;
}

/** Ecrit le registre de facon atomique, apres l'avoir validé : un registre invalide n'est jamais ecrit. */
export function saveRegistry(reg: Registry, dir: string = QUALIF_DIR): void {
  const problems = validateRegistry(reg, dir);
  if (problems.length) throw new RegistryError('registre invalide, ecriture refusee', problems);
  writeFileAtomic(registryPath(dir), `${JSON.stringify(reg, null, 2)}\n`);
}

export const findEntry = (reg: Registry, id: string): Entry | undefined => reg.entries.find((e) => e.id === id);

// ---------------------------------------------------------------- API d'interrogation

/** Vrai seulement pour un modele « qualified ». Inconnu, a qualifier, rejete : faux. Leve si le registre est invalide. */
export function isQualified(id: string, dir?: string): boolean {
  return qualificationStatus(id, dir) === 'qualified';
}

export function qualificationStatus(id: string, dir?: string): Status | 'unknown' {
  const e = findEntry(loadRegistry(dir), id);
  return e ? e.status : 'unknown';
}

/** Retrouve une entree par identifiant, alias ou nom de modele (insensible a la casse, aux espaces et aux tirets). */
export function resolveModel(name: string, dir?: string): Entry | null {
  return resolveIn(loadRegistry(dir), name);
}

function resolveIn(reg: Registry, name: string): Entry | null {
  const key = normalizeName(name);
  if (!key) return null;
  const byId = reg.entries.find((e) => normalizeName(e.id) === key || e.aliases.some((a) => normalizeName(a) === key));
  if (byId) return byId;
  // « Dahua HAC-HFW1500TH-I8 » : le fabricant devant l'identifiant ou l'alias, ou le nom complet du modele (si non ambigu).
  const byMaker = reg.entries.filter((e) => [e.id, ...e.aliases].some((a) => normalizeName(`${e.manufacturer}${a}`) === key));
  if (byMaker.length === 1) return byMaker[0];
  const byModel = reg.entries.filter((e) => normalizeName(e.model) === key || normalizeName(`${e.manufacturer}${e.model}`) === key);
  return byModel.length === 1 ? byModel[0] : null;
}

export interface ModelVerdict {
  /** Nom tel qu'il figure dans le pack. */
  name: string;
  /** Entree du registre retrouvee, ou null. */
  entry: Entry | null;
  status: Status | 'unknown';
  ok: boolean;
  /** Nombre d'appareils du pack qui utilisent ce modele. */
  count: number;
}

/** Verdict par modele distinct. `ok` vaut vrai seulement pour un modele « qualified ». */
export function checkPackModels(names: string[], dir?: string): ModelVerdict[] {
  const reg = loadRegistry(dir);
  const out: ModelVerdict[] = [];
  for (const name of names) {
    const entry = resolveIn(reg, name);
    const key = entry ? entry.id : `?${normalizeName(name)}`;
    const found = out.find((v) => (v.entry ? v.entry.id : `?${normalizeName(v.name)}`) === key);
    if (found) {
      found.count += 1;
      continue;
    }
    out.push({ name, entry, status: entry ? entry.status : 'unknown', ok: entry?.status === 'qualified', count: 1 });
  }
  return out;
}

export type { Obj };
