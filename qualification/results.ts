/**
 * Resultats d'essai en atelier (qualification/results/<id>-<date>.json) et promotion au statut « qualified ».
 *
 *  - `record` enregistre un resultat apres validation stricte (tous les champs, toutes les etapes de la fiche). Il ne
 *    modifie JAMAIS le statut du registre.
 *  - `promote` change le statut en « qualified » seulement si le resultat reference est un essai sur MATERIEL REEL dont
 *    toutes les etapes obligatoires sont « pass », sans aucune etape « fail », avec les mesures dans leurs limites, sur la
 *    fiche telle qu'elle est aujourd'hui. Sinon elle refuse et dit pourquoi.
 *  - `setStatus` ramene un modele a « to_qualify » ou le declare « rejected » (jamais vers « qualified »).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createFileExclusive } from './atomic.ts';
import { QUALIF_DIR, ficheHash, getFiche, stepsFor, stepsHash } from './fiches.ts';
import type { Fiche, Step } from './fiches.ts';
import { findEntry, loadRegistry, saveRegistry } from './registry.ts';
import type { Entry, Registry, Status } from './registry.ts';
import { Problems, array, bool, isObj, isoDate, num, oneOf, onlyKeys, text } from './validate.ts';
import type { Obj } from './validate.ts';

export const STEP_RESULTS = ['pass', 'fail', 'na'] as const;
export type StepResult = (typeof STEP_RESULTS)[number];

export interface StepOutcome {
  result: StepResult;
  note: string;
}
export interface TrialInput {
  date: string;
  tester: string;
  serial_numbers: string[];
  firmware: string;
  tested_version: { psim: string; gateway: string | null };
  conditions: { real_hardware: boolean; description: string; temperature_c: number | null; humidity_pct: number | null };
  steps: Record<string, StepOutcome>;
  measures: Record<string, number>;
  notes: string;
}
export interface TrialResult extends TrialInput {
  schema: 1;
  model_id: string;
  fiche: string;
  profile: string | null;
  fiche_version: number;
  fiche_hash: string;
}

export const resultsDir = (dir: string = QUALIF_DIR): string => join(dir, 'results');

const INPUT_KEYS = ['date', 'tester', 'serial_numbers', 'firmware', 'tested_version', 'conditions', 'steps', 'measures', 'notes'];
const RESULT_KEYS = ['schema', 'model_id', 'fiche', 'profile', 'fiche_version', 'fiche_hash', ...INPUT_KEYS];

/** Contexte d'un modele : son entree, sa fiche et les etapes qui s'appliquent a son profil. */
export function contextFor(reg: Registry, id: string, dir: string = QUALIF_DIR): { entry: Entry; fiche: Fiche; steps: Step[] } {
  const entry = findEntry(reg, id);
  if (!entry) throw new Error(`modele inconnu du registre : ${id}`);
  const fiche = getFiche(entry.fiche, dir);
  if (!fiche) throw new Error(`fiche inconnue : ${entry.fiche}`);
  return { entry, fiche, steps: stepsFor(fiche, entry.profile, dir) };
}

/** Modele de saisie vide pour un modele : les champs a remplir, une ligne par etape de sa fiche. */
export function emptyInput(steps: Step[]): unknown {
  const stepsObj: Record<string, unknown> = {};
  const measures: Record<string, unknown> = {};
  for (const s of steps) {
    stepsObj[s.id] = { result: null, note: '' };
    for (const m of s.mesures) measures[m.cle] = null;
  }
  return {
    date: null,
    tester: '',
    serial_numbers: [],
    firmware: '',
    tested_version: { psim: '', gateway: null },
    conditions: { real_hardware: null, description: '', temperature_c: null, humidity_pct: null },
    steps: stepsObj,
    measures,
    notes: '',
  };
}

function inLimits(value: number, m: { min?: number; max?: number }): boolean {
  return (m.min === undefined || value >= m.min) && (m.max === undefined || value <= m.max);
}

/** Validation stricte d'un resultat complet. Ne dit rien du statut : seule `evaluatePromotion` en juge. */
export function validateResult(raw: unknown, entry: Entry, fiche: Fiche, steps: Step[], now: Date = new Date()): string[] {
  const p = new Problems();
  if (!isObj(raw)) return ['resultat : objet attendu'];
  onlyKeys(p, 'resultat', raw, RESULT_KEYS);
  if (raw.schema !== 1) p.add('resultat.schema', 'schema 1 attendu');
  if (raw.model_id !== entry.id) p.add('resultat.model_id', `doit etre « ${entry.id} »`);
  if (raw.fiche !== fiche.id) p.add('resultat.fiche', `doit etre « ${fiche.id} »`);
  if (raw.profile !== entry.profile) p.add('resultat.profile', `doit etre « ${entry.profile ?? 'null'} »`);
  if (raw.fiche_version !== fiche.version) p.add('resultat.fiche_version', `la fiche est maintenant en version ${fiche.version} (resultat : ${String(raw.fiche_version)}) : refaire l'essai`);
  if (raw.fiche_hash !== stepsHash(fiche, entry.profile, steps)) p.add('resultat.fiche_hash', "le contenu de la fiche (etapes, obligations, limites) a change depuis cet essai : refaire l'essai");

  if (isoDate(p, 'resultat.date', raw.date)) {
    const limit = new Date(now.getTime() + 24 * 3600_000).toISOString().slice(0, 10);
    if ((raw.date as string) > limit) p.add('resultat.date', 'date dans le futur');
  }
  text(p, 'resultat.tester', raw.tester, { max: 120 });
  text(p, 'resultat.firmware', raw.firmware, { max: 80 });
  if (array(p, 'resultat.serial_numbers', raw.serial_numbers, { min: 1, max: 20 })) for (const [i, s] of raw.serial_numbers.entries()) text(p, `resultat.serial_numbers[${i}]`, s, { max: 80 });
  if (!isObj(raw.tested_version)) p.add('resultat.tested_version', 'objet attendu');
  else {
    onlyKeys(p, 'resultat.tested_version', raw.tested_version, ['psim', 'gateway']);
    text(p, 'resultat.tested_version.psim', raw.tested_version.psim, { max: 80 });
    if (raw.tested_version.gateway !== null) text(p, 'resultat.tested_version.gateway', raw.tested_version.gateway, { max: 80 });
    else if (entry.connection.type === 'gateway') p.add('resultat.tested_version.gateway', 'version de la passerelle obligatoire pour un equipement raccorde par passerelle');
  }
  if (!isObj(raw.conditions)) p.add('resultat.conditions', 'objet attendu');
  else {
    onlyKeys(p, 'resultat.conditions', raw.conditions, ['real_hardware', 'description', 'temperature_c', 'humidity_pct']);
    bool(p, 'resultat.conditions.real_hardware', raw.conditions.real_hardware);
    text(p, 'resultat.conditions.description', raw.conditions.description, { max: 600 });
    if (raw.conditions.temperature_c !== null) num(p, 'resultat.conditions.temperature_c', raw.conditions.temperature_c, { min: -40, max: 80 });
    if (raw.conditions.humidity_pct !== null) num(p, 'resultat.conditions.humidity_pct', raw.conditions.humidity_pct, { min: 0, max: 100 });
  }
  text(p, 'resultat.notes', raw.notes, { max: 2000, empty: true });

  // Etapes : exactement celles de la fiche, ni plus ni moins.
  const outcomes = new Map<string, StepOutcome>();
  if (!isObj(raw.steps)) p.add('resultat.steps', 'objet attendu');
  else {
    const known = new Set(steps.map((s) => s.id));
    for (const k of Object.keys(raw.steps)) if (!known.has(k)) p.add(`resultat.steps.${k}`, 'etape inconnue pour cette fiche et ce profil');
    for (const s of steps) {
      const o = raw.steps[s.id];
      const path = `resultat.steps.${s.id}`;
      if (!isObj(o)) {
        p.add(path, 'etape manquante : un resultat pass, fail ou na est obligatoire');
        continue;
      }
      onlyKeys(p, path, o, ['result', 'note']);
      if (!oneOf(p, `${path}.result`, o.result, STEP_RESULTS)) continue;
      if (typeof o.note !== 'string') p.add(`${path}.note`, 'texte attendu (peut etre vide)');
      else if ((o.result === 'fail' || o.result === 'na') && !o.note.trim()) p.add(`${path}.note`, `une etape « ${o.result} » doit etre justifiee par une remarque`);
      outcomes.set(s.id, { result: o.result, note: typeof o.note === 'string' ? o.note : '' });
    }
  }

  // Mesures : celles de la fiche, obligatoires pour toute etape « pass » ; une etape « pass » hors limite est incoherente.
  if (!isObj(raw.measures)) p.add('resultat.measures', 'objet attendu');
  else {
    const keys = new Map(steps.flatMap((s) => s.mesures.map((m) => [m.cle, { step: s, m }] as const)));
    for (const k of Object.keys(raw.measures)) if (!keys.has(k)) p.add(`resultat.measures.${k}`, 'mesure inconnue pour cette fiche et ce profil');
    for (const [k, { step, m }] of keys) {
      const v = raw.measures[k];
      const status = outcomes.get(step.id)?.result;
      if (v === undefined || v === null) {
        if (status === 'pass') p.add(`resultat.measures.${k}`, `mesure obligatoire : l'etape « ${step.id} » est a pass`);
        continue;
      }
      if (!num(p, `resultat.measures.${k}`, v)) continue;
      if (status === 'pass' && !inLimits(v, m)) p.add(`resultat.measures.${k}`, `${v} ${m.unite} hors limite : l'etape « ${step.id} » ne peut pas etre a pass`);
    }
  }
  return p.list;
}

export interface Promotion {
  ok: boolean;
  reasons: string[];
}

/** Explique si un resultat (deja structurellement valide ou non) autorise la promotion. Ne touche a rien. */
export function evaluatePromotion(raw: unknown, entry: Entry, fiche: Fiche, steps: Step[], now: Date = new Date()): Promotion {
  const reasons: string[] = [];
  const structural = validateResult(raw, entry, fiche, steps, now);
  reasons.push(...structural);
  if (isObj(raw) && isObj(raw.conditions) && raw.conditions.real_hardware !== true) {
    reasons.push("l'essai n'a pas ete fait avec du materiel reel (conditions.real_hardware n'est pas vrai) : un essai simule ne qualifie jamais un materiel");
  }
  if (isObj(raw) && isObj(raw.steps)) {
    for (const s of steps) {
      const o = raw.steps[s.id];
      const result = isObj(o) ? o.result : undefined;
      if (result === 'fail') reasons.push(`etape « ${s.id} » (${s.titre}) en echec`);
      else if (s.obligatoire && result !== 'pass') reasons.push(`etape obligatoire « ${s.id} » (${s.titre}) : ${result === undefined ? 'absente' : String(result)} au lieu de pass`);
      if (result === 'pass' && isObj(raw.measures)) {
        for (const m of s.mesures) {
          const v = raw.measures[m.cle];
          if (typeof v === 'number' && !inLimits(v, m)) reasons.push(`mesure « ${m.cle} » = ${v} ${m.unite} hors limite`);
        }
      }
    }
  }
  // Doublons de messages (une meme cause peut etre signalee par les deux controles).
  const unique = [...new Set(reasons)];
  return { ok: unique.length === 0, reasons: unique };
}

export class PromotionRefused extends Error {
  readonly reasons: string[];
  constructor(id: string, reasons: string[]) {
    super(`promotion de ${id} refusee :\n- ${reasons.join('\n- ')}`);
    this.name = 'PromotionRefused';
    this.reasons = reasons;
  }
}

export interface Options {
  dir?: string;
  now?: Date;
}

/**
 * Enregistre un resultat d'essai. Refuse tout champ manquant ou etape manquante. Ne modifie pas le registre.
 * Renvoie le chemin du fichier cree (jamais ecrase : un second essai le meme jour prend le suffixe -2, -3...).
 */
export function recordResult(id: string, input: unknown, opts: Options = {}): { file: string; result: TrialResult } {
  const dir = opts.dir ?? QUALIF_DIR;
  const now = opts.now ?? new Date();
  const reg = loadRegistry(dir);
  const { entry, fiche, steps } = contextFor(reg, id, dir);
  if (!isObj(input)) throw new Error('saisie : objet attendu');
  const extra = Object.keys(input).filter((k) => !INPUT_KEYS.includes(k));
  if (extra.length) throw new Error(`saisie : champ(s) inconnu(s) : ${extra.join(', ')}`);
  const result = {
    schema: 1,
    model_id: entry.id,
    fiche: fiche.id,
    profile: entry.profile,
    fiche_version: fiche.version,
    fiche_hash: ficheHash(fiche, entry.profile, dir),
    ...(input as Obj),
  } as unknown as TrialResult;
  const problems = validateResult(result, entry, fiche, steps, now);
  if (problems.length) throw new Error(`resultat refuse, rien n'a ete enregistre :\n- ${problems.join('\n- ')}`);
  const base = join(resultsDir(dir), `${entry.id}-${result.date}`);
  const content = `${JSON.stringify(result, null, 2)}\n`;
  for (let n = 1; n < 100; n++) {
    const file = `${base}${n === 1 ? '' : `-${n}`}.json`;
    try {
      createFileExclusive(file, content);
      return { file, result };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error('trop de resultats le meme jour pour ce modele');
}

/** Empreinte du TEXTE du fichier, fins de ligne normalisees : git peut convertir LF en CRLF au transfert sans que le contenu change. */
export const sha256 = (buf: Buffer | string): string => createHash('sha256').update(String(buf).replace(/\r\n/g, '\n')).digest('hex');

/** Chemin relatif du fichier de resultat (a partir du dossier qualification), en barres obliques, apres controle de son emplacement. */
function relativeResult(file: string, dir: string): string {
  const abs = resolve(file);
  const root = resolve(resultsDir(dir));
  // Windows : les chemins ne different pas selon la casse (d: / D:).
  const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!same(dirname(abs), root) || !abs.endsWith('.json') || !abs.startsWith(dirname(abs) + sep)) {
    throw new Error(`le resultat doit etre un fichier .json range directement dans ${resultsDir(dir)}`);
  }
  return `results/${basename(abs)}`;
}

export interface PromoteArgs {
  id: string;
  resultFile: string;
  by: string;
  scope: string;
  notCovered?: string;
}

/** Passe un modele a « qualified » si, et seulement si, le resultat reference le permet. Leve PromotionRefused sinon. */
export function promote(args: PromoteArgs, opts: Options = {}): Entry {
  const dir = opts.dir ?? QUALIF_DIR;
  const now = opts.now ?? new Date();
  const reg = loadRegistry(dir);
  const { entry, fiche, steps } = contextFor(reg, args.id, dir);
  const reasons: string[] = [];
  if (entry.status === 'rejected') reasons.push("ce modele est rejete : le remettre d'abord a to_qualify (set-status, avec la raison) avant tout nouvel essai");
  if (!args.by.trim()) reasons.push("le nom du responsable qui valide (--by) est obligatoire");
  if (!args.scope.trim()) reasons.push('la portee precise de ce qui est valide (--scope) est obligatoire');
  let rel = '';
  let raw: unknown = null;
  let digest = '';
  try {
    rel = relativeResult(args.resultFile, dir);
    const buf = readFileSync(resolve(args.resultFile));
    digest = sha256(buf);
    raw = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    reasons.push(`resultat illisible : ${(err as Error).message}`);
  }
  if (raw !== null) reasons.push(...evaluatePromotion(raw, entry, fiche, steps, now).reasons);
  if (reasons.length) throw new PromotionRefused(args.id, [...new Set(reasons)]);

  const r = raw as TrialResult;
  const index = reg.entries.findIndex((e) => e.id === args.id);
  const updated: Entry = {
    ...entry,
    status: 'qualified',
    scope: args.scope.trim(),
    not_covered: (args.notCovered ?? '').trim(),
    last_trial: {
      date: r.date,
      reference: `qualification/${rel} (fiche ${fiche.id}, version ${fiche.version}, signé par ${args.by.trim()})`,
      psim_version: r.tested_version.psim,
      gateway_version: r.tested_version.gateway,
      real_hardware: true,
      conditions: r.conditions.description,
      serial_numbers: r.serial_numbers,
      firmware: r.firmware,
      result_file: `qualification/${rel}`,
      result_sha256: digest,
      legacy: false,
    },
    history: [
      ...entry.history,
      { at: now.toISOString(), by: args.by.trim(), from: entry.status, to: 'qualified', reason: `promotion sur le résultat ${rel} (testeur : ${r.tester})`, result_file: `qualification/${rel}` },
    ],
  };
  reg.entries[index] = updated;
  saveRegistry(reg, dir);
  return updated;
}

/** Retire la qualification (« to_qualify ») ou rejette un modele. Jamais vers « qualified ». */
export function setStatus(id: string, to: Status, by: string, reason: string, opts: Options = {}): Entry {
  const dir = opts.dir ?? QUALIF_DIR;
  const now = opts.now ?? new Date();
  if (to === 'qualified') throw new Error('seule `promote`, sur un resultat materiel, peut qualifier un modele');
  if (!by.trim()) throw new Error('--by obligatoire');
  if (!reason.trim()) throw new Error('--reason obligatoire');
  const reg = loadRegistry(dir);
  const index = reg.entries.findIndex((e) => e.id === id);
  if (index < 0) throw new Error(`modele inconnu du registre : ${id}`);
  const entry = reg.entries[index];
  if (entry.status === to) throw new Error(`${id} est deja « ${to} »`);
  const updated: Entry = {
    ...entry,
    status: to,
    scope: to === 'rejected' ? 'Rejeté : ne doit entrer dans aucun pack.' : "Qualification retirée : rien n'est validé tant qu'un nouvel essai matériel n'a pas réussi.",
    notes: to === 'rejected' ? `${entry.notes ? `${entry.notes} ` : ''}Rejeté : ${reason.trim()}`.slice(0, 800) : entry.notes,
    history: [...entry.history, { at: now.toISOString(), by: by.trim(), from: entry.status, to, reason: reason.trim(), result_file: null }],
  };
  reg.entries[index] = updated;
  saveRegistry(reg, dir);
  return updated;
}

/**
 * Controle de coherence du registre avec le disque (commande `verify`) : chaque modele « qualified » (hors constats
 * historiques) a un fichier de resultat present, intact (empreinte), materiel et encore valable pour la fiche actuelle ;
 * les tests simules cites existent.
 */
export function auditRegistry(dir: string = QUALIF_DIR, repoRoot: string = resolve(dir, '..'), now: Date = new Date()): string[] {
  const problems: string[] = [];
  let reg: Registry;
  try {
    reg = loadRegistry(dir);
  } catch (err) {
    return [(err as Error).message];
  }
  for (const e of reg.entries) {
    for (const t of e.simulated_tests) if (!existsSync(join(repoRoot, t))) problems.push(`${e.id} : test simule introuvable : ${t}`);
    const trial = e.last_trial;
    if (e.status !== 'qualified' || !trial || trial.legacy) continue;
    const file = join(dir, (trial.result_file ?? '').replace(/^qualification\//, ''));
    if (!existsSync(file)) {
      problems.push(`${e.id} : fichier de resultat introuvable : ${trial.result_file}`);
      continue;
    }
    const buf = readFileSync(file);
    if (sha256(buf) !== trial.result_sha256) {
      problems.push(`${e.id} : le fichier de resultat a ete modifie depuis la promotion (empreinte differente)`);
      continue;
    }
    try {
      const { entry, fiche, steps } = contextFor(reg, e.id, dir);
      const verdict = evaluatePromotion(JSON.parse(buf.toString('utf8')), entry, fiche, steps, now);
      for (const r of verdict.reasons) problems.push(`${e.id} : ${r}`);
    } catch (err) {
      problems.push(`${e.id} : ${(err as Error).message}`);
    }
  }
  return problems;
}

