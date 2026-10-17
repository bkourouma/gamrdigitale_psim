/**
 * Fiches de recette en atelier : un gabarit d'etapes communes (qualification/fiches.json, « templates ») instancie par
 * famille de materiel (« fiches ») et par profil (« profils »). Les fiches imprimables (Markdown, HTML) et les resultats
 * d'essai sortent TOUS de cette meme source : une etape ne peut donc pas exister sur la fiche papier sans exister dans
 * le fichier de resultat, et l'inverse.
 *
 * Donnees avec accents (textes pour techniciens), code sans accents.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Problems, array, bool, escapeHtml, ID_RE, isObj, num, oneOf, onlyKeys, text } from './validate.ts';
import type { Obj } from './validate.ts';

export const ROOT_DIR = resolve(import.meta.dirname, '..');
export const QUALIF_DIR = join(ROOT_DIR, 'qualification');

export const SECTIONS = ['preparation', 'detection', 'liaison', 'psim', 'environnement', 'cloture'] as const;
export type Section = (typeof SECTIONS)[number];
export const SECTION_LABEL: Record<Section, string> = {
  preparation: 'Préparation',
  detection: 'Détection',
  liaison: 'Liaison et silence',
  psim: 'Reprise du PSIM',
  environnement: 'Conditions tropicales',
  cloture: 'Clôture',
};

/** Nature du rejeu possible sans materiel (voir bench.ts). `physique` = seul un humain avec le materiel peut le faire. */
export const BENCH_KINDS = [
  'physique', 'normal', 'declenchement', 'retour', 'repetition', 'latence', 'defaut', 'sabotage', 'liaison', 'reprise',
  'silence', 'redemarrage', 'renvoi', 'renvoi-direct', 'info-sans-incident', 'camera-sante', 'hooks',
] as const;
export type BenchKind = (typeof BENCH_KINDS)[number];

/** Champs de la configuration de banc qu'un type de rejeu exige (hors `physique`, `camera-sante`, `hooks`). */
export const BENCH_REQUIRES: Record<BenchKind, readonly string[]> = {
  physique: [],
  normal: ['categorie', 'normal'],
  declenchement: ['categorie', 'alarme', 'normal'],
  retour: ['categorie', 'alarme', 'normal'],
  repetition: ['categorie', 'alarme', 'normal'],
  latence: ['categorie', 'alarme', 'normal'],
  defaut: ['categorie', 'defaut', 'alarme', 'normal'],
  sabotage: ['categorie', 'sabotage', 'alarme', 'normal'],
  liaison: ['categorie', 'normal', 'silence_s'],
  reprise: ['categorie', 'alarme', 'normal', 'silence_s'],
  silence: ['categorie', 'normal', 'silence_s'],
  redemarrage: ['categorie', 'alarme', 'normal', 'silence_s'],
  renvoi: ['categorie', 'alarme', 'normal'],
  'renvoi-direct': ['categorie', 'alarme', 'normal', 'silence_s'],
  'info-sans-incident': ['categorie', 'info', 'normal'],
  'camera-sante': [],
  hooks: [],
};

export interface Msg {
  state?: string;
  event?: string;
  value?: number;
}
export interface BenchConfig {
  categorie: 'fire' | 'intrusion' | 'access' | 'environment' | 'energy' | 'people';
  alarme?: Msg;
  normal?: Msg;
  defaut?: Msg;
  sabotage?: Msg;
  liaison_perdue?: Msg | null;
  info?: { ouvre: Msg; ferme: Msg };
  seuils?: { warnAt: number; alarmAt: number; direction: 'above' | 'below'; unit: string };
  silence_s?: number;
}

export interface Measure {
  cle: string;
  libelle: string;
  unite: string;
  min?: number;
  max?: number;
}

export interface Step {
  id: string;
  section: Section;
  titre: string;
  action: string;
  attendu: string;
  obligatoire: boolean;
  bench: BenchKind;
  mesures: Measure[];
}

interface RawMeasure {
  cle: string;
  libelle: string;
  unite: string;
  min?: number | string;
  max?: number | string;
}
interface RawStep {
  ref?: string;
  id?: string;
  profils?: string[];
  section?: Section;
  titre?: string;
  action?: string;
  attendu?: string;
  obligatoire?: boolean;
  bench?: BenchKind;
  mesures?: RawMeasure[];
}
type Params = Record<string, string | number>;

export interface Profile {
  libelle: string;
  params: Params;
  bench: BenchConfig | null;
}
export interface Fiche {
  id: string;
  version: number;
  titre: string;
  resume: string;
  docs: string[];
  materiel: string[];
  banc: string[];
  params: Params;
  profils: Record<string, Profile>;
  etapes: RawStep[];
  criteres_supplementaires: { reussite: string[]; echec: string[] };
  bench: BenchConfig | null;
}
export interface FichesData {
  version: number;
  defaults: Params;
  templates: Record<string, RawStep>;
  fiches: Fiche[];
}

// ---------------------------------------------------------------- chargement et validation

export function readFichesData(dir: string = QUALIF_DIR): unknown {
  return JSON.parse(readFileSync(join(dir, 'fiches.json'), 'utf8'));
}

const PLACEHOLDER = /\{\{([a-z0-9_]+)\}\}/g;

function fillText(p: Problems, path: string, value: unknown, params: Params): string {
  if (typeof value !== 'string') return '';
  return value.replace(PLACEHOLDER, (_m, key: string) => {
    if (!Object.hasOwn(params, key)) {
      p.add(path, `parametre inconnu {{${key}}}`);
      return '';
    }
    return String(params[key]);
  });
}

function resolveBound(p: Problems, path: string, v: unknown, params: Params): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.startsWith('$')) {
    const val = params[v.slice(1)];
    if (typeof val === 'number') return val;
    p.add(path, `parametre numerique inconnu ${v}`);
    return undefined;
  }
  p.add(path, 'nombre ou reference $parametre attendu');
  return undefined;
}

/** Etapes d'une fiche pour un profil (ou pour la fiche sans profil), parametres resolus. Accumule les problemes. */
function expand(data: FichesData, fiche: Fiche, profile: string | null, p: Problems): Step[] {
  const where = `fiches.${fiche.id}${profile ? `[${profile}]` : ''}`;
  const params: Params = { ...data.defaults, ...fiche.params, ...(profile ? fiche.profils[profile]?.params : {}) };
  const out: Step[] = [];
  for (const [i, raw] of fiche.etapes.entries()) {
    if (profile !== null && raw.profils && !raw.profils.includes(profile)) continue;
    const base: RawStep = raw.ref ? { ...(data.templates[raw.ref] ?? {}) } : {};
    const merged: RawStep = { ...base, ...raw };
    const id = raw.id ?? raw.ref ?? '';
    const path = `${where}.etapes[${i}](${id})`;
    const step: Step = {
      id,
      section: merged.section as Section,
      titre: fillText(p, `${path}.titre`, merged.titre, params),
      action: fillText(p, `${path}.action`, merged.action, params),
      attendu: fillText(p, `${path}.attendu`, merged.attendu, params),
      obligatoire: merged.obligatoire as boolean,
      bench: merged.bench as BenchKind,
      mesures: (merged.mesures ?? []).map((m, j) => {
        const mp = `${path}.mesures[${j}]`;
        return {
          cle: m.cle,
          libelle: fillText(p, `${mp}.libelle`, m.libelle, params),
          unite: m.unite,
          min: resolveBound(p, `${mp}.min`, m.min, params),
          max: resolveBound(p, `${mp}.max`, m.max, params),
        };
      }),
    };
    out.push(step);
  }
  return out;
}

function validateMsg(p: Problems, path: string, v: unknown): void {
  if (!isObj(v)) return void p.add(path, 'message attendu');
  onlyKeys(p, path, v, ['state', 'event', 'value']);
  if (Object.keys(v).length === 0) p.add(path, 'message vide');
}

function validateBench(p: Problems, path: string, v: unknown): void {
  if (v === null) return;
  if (!isObj(v)) return void p.add(path, 'objet ou null attendu');
  onlyKeys(p, path, v, ['categorie', 'alarme', 'normal', 'defaut', 'sabotage', 'liaison_perdue', 'info', 'seuils', 'silence_s']);
  oneOf(p, `${path}.categorie`, v.categorie, ['fire', 'intrusion', 'access', 'environment', 'energy', 'people']);
  for (const k of ['alarme', 'normal', 'defaut', 'sabotage'] as const) if (v[k] !== undefined) validateMsg(p, `${path}.${k}`, v[k]);
  if (v.liaison_perdue !== undefined && v.liaison_perdue !== null) validateMsg(p, `${path}.liaison_perdue`, v.liaison_perdue);
  if (v.info !== undefined) {
    if (!isObj(v.info)) p.add(`${path}.info`, 'objet attendu');
    else {
      onlyKeys(p, `${path}.info`, v.info, ['ouvre', 'ferme']);
      validateMsg(p, `${path}.info.ouvre`, v.info.ouvre);
      validateMsg(p, `${path}.info.ferme`, v.info.ferme);
    }
  }
  if (v.seuils !== undefined) {
    if (!isObj(v.seuils)) p.add(`${path}.seuils`, 'objet attendu');
    else {
      onlyKeys(p, `${path}.seuils`, v.seuils, ['warnAt', 'alarmAt', 'direction', 'unit']);
      num(p, `${path}.seuils.warnAt`, v.seuils.warnAt);
      num(p, `${path}.seuils.alarmAt`, v.seuils.alarmAt);
      oneOf(p, `${path}.seuils.direction`, v.seuils.direction, ['above', 'below']);
      text(p, `${path}.seuils.unit`, v.seuils.unit, { max: 8 });
    }
  }
  if (v.silence_s !== undefined) num(p, `${path}.silence_s`, v.silence_s, { min: 30, max: 86400 });
}

function validateParams(p: Problems, path: string, v: unknown): void {
  if (!isObj(v)) return void p.add(path, 'objet attendu');
  for (const [k, val] of Object.entries(v)) {
    if (!/^[a-z0-9_]+$/.test(k)) p.add(`${path}.${k}`, 'nom de parametre invalide');
    if (typeof val !== 'string' && typeof val !== 'number') p.add(`${path}.${k}`, 'texte ou nombre attendu');
  }
}

function validateMeasures(p: Problems, path: string, v: unknown): void {
  if (!array(p, path, v, { max: 6 })) return;
  for (const [j, m] of v.entries()) {
    const mp = `${path}[${j}]`;
    if (!isObj(m)) {
      p.add(mp, 'objet attendu');
      continue;
    }
    onlyKeys(p, mp, m, ['cle', 'libelle', 'unite', 'min', 'max']);
    if (typeof m.cle !== 'string' || !/^[a-z0-9_]{2,40}$/.test(m.cle)) p.add(`${mp}.cle`, 'identifiant de mesure invalide');
    text(p, `${mp}.libelle`, m.libelle, { max: 120 });
    text(p, `${mp}.unite`, m.unite, { max: 20 });
    if (m.min === undefined && m.max === undefined) p.add(mp, 'une limite min ou max est obligatoire (critere chiffre)');
  }
}

function validateRawStep(p: Problems, path: string, s: unknown, templates: Obj, isTemplate: boolean): void {
  if (!isObj(s)) return void p.add(path, 'objet attendu');
  onlyKeys(p, path, s, ['ref', 'id', 'profils', 'section', 'titre', 'action', 'attendu', 'obligatoire', 'bench', 'mesures']);
  if (!isTemplate) {
    if (s.ref !== undefined) {
      if (typeof s.ref !== 'string' || !Object.hasOwn(templates, s.ref)) p.add(`${path}.ref`, 'gabarit inconnu');
    }
    if (s.ref === undefined && s.id === undefined) p.add(path, 'ref ou id obligatoire');
    if (s.id !== undefined && (typeof s.id !== 'string' || !ID_RE.test(s.id))) p.add(`${path}.id`, 'identifiant invalide');
    if (s.profils !== undefined && array(p, `${path}.profils`, s.profils, { min: 1 })) {
      for (const [k, x] of s.profils.entries()) text(p, `${path}.profils[${k}]`, x, { max: 40 });
    }
  }
  const full = s.ref && isObj(templates[s.ref as string]) ? { ...(templates[s.ref as string] as Obj), ...s } : s;
  if (s.section !== undefined || !s.ref) oneOf(p, `${path}.section`, full.section, SECTIONS);
  for (const k of ['titre', 'action', 'attendu'] as const) if (s[k] !== undefined || !s.ref) text(p, `${path}.${k}`, full[k], { max: 1500 });
  if (s.obligatoire !== undefined || !s.ref) bool(p, `${path}.obligatoire`, full.obligatoire);
  if (s.bench !== undefined || !s.ref) oneOf(p, `${path}.bench`, full.bench, BENCH_KINDS);
  if (s.mesures !== undefined) validateMeasures(p, `${path}.mesures`, s.mesures);
}

/** Verifie tout le fichier fiches.json, y compris l'expansion de chaque (fiche, profil). Renvoie la liste des problemes. */
export function validateFichesData(raw: unknown): string[] {
  const p = new Problems();
  if (!isObj(raw)) return ['fiches.json : objet attendu'];
  onlyKeys(p, 'fiches', raw, ['version', 'defaults', 'templates', 'fiches']);
  if (raw.version !== 1) p.add('fiches.version', 'version 1 attendue');
  validateParams(p, 'fiches.defaults', raw.defaults);
  if (!isObj(raw.templates)) p.add('fiches.templates', 'objet attendu');
  else for (const [k, t] of Object.entries(raw.templates)) validateRawStep(p, `templates.${k}`, t, raw.templates, true);
  if (!array(p, 'fiches.fiches', raw.fiches, { min: 1 }) || !isObj(raw.templates) || !isObj(raw.defaults)) return p.list;

  const ids = new Set<string>();
  for (const [i, f] of raw.fiches.entries()) {
    const path = `fiches[${i}]`;
    if (!isObj(f)) {
      p.add(path, 'objet attendu');
      continue;
    }
    onlyKeys(p, path, f, ['id', 'version', 'titre', 'resume', 'docs', 'materiel', 'banc', 'params', 'profils', 'etapes', 'criteres_supplementaires', 'bench']);
    if (typeof f.id !== 'string' || !ID_RE.test(f.id)) p.add(`${path}.id`, 'identifiant invalide');
    else if (ids.has(f.id)) p.add(`${path}.id`, `doublon : ${f.id}`);
    else ids.add(f.id);
    num(p, `${path}.version`, f.version, { min: 1 });
    text(p, `${path}.titre`, f.titre, { max: 200 });
    text(p, `${path}.resume`, f.resume, { max: 600 });
    for (const k of ['docs', 'materiel', 'banc'] as const) {
      if (array(p, `${path}.${k}`, f[k], { min: 1 })) for (const [j, x] of f[k].entries()) text(p, `${path}.${k}[${j}]`, x, { max: 600 });
    }
    validateParams(p, `${path}.params`, f.params);
    validateBench(p, `${path}.bench`, f.bench);
    if (!isObj(f.profils)) p.add(`${path}.profils`, 'objet attendu');
    else {
      for (const [pid, prof] of Object.entries(f.profils)) {
        const pp = `${path}.profils.${pid}`;
        if (!ID_RE.test(pid)) p.add(pp, 'identifiant de profil invalide');
        if (!isObj(prof)) {
          p.add(pp, 'objet attendu');
          continue;
        }
        onlyKeys(p, pp, prof, ['libelle', 'params', 'bench']);
        text(p, `${pp}.libelle`, prof.libelle, { max: 200 });
        validateParams(p, `${pp}.params`, prof.params);
        validateBench(p, `${pp}.bench`, prof.bench);
      }
    }
    if (!isObj(f.criteres_supplementaires)) p.add(`${path}.criteres_supplementaires`, 'objet attendu');
    else {
      onlyKeys(p, `${path}.criteres_supplementaires`, f.criteres_supplementaires, ['reussite', 'echec']);
      for (const k of ['reussite', 'echec'] as const) {
        if (array(p, `${path}.criteres_supplementaires.${k}`, f.criteres_supplementaires[k])) {
          for (const [j, x] of f.criteres_supplementaires[k].entries()) text(p, `${path}.criteres_supplementaires.${k}[${j}]`, x, { max: 600 });
        }
      }
    }
    if (array(p, `${path}.etapes`, f.etapes, { min: 3 })) {
      for (const [j, s] of f.etapes.entries()) validateRawStep(p, `${path}.etapes[${j}]`, s, raw.templates, false);
    }
  }
  if (!p.ok) return p.list;

  // Expansion de chaque (fiche, profil) : parametres, identifiants uniques, exigences du banc, etapes de base.
  const data = raw as unknown as FichesData;
  for (const fiche of data.fiches) {
    const profiles = Object.keys(fiche.profils);
    for (const [j, s] of fiche.etapes.entries()) {
      for (const pr of s.profils ?? []) if (!profiles.includes(pr)) p.add(`fiches.${fiche.id}.etapes[${j}].profils`, `profil inconnu : ${pr}`);
    }
    for (const pr of profiles.length ? profiles : [null]) {
      const where = `fiches.${fiche.id}${pr ? `[${pr}]` : ''}`;
      const steps = expand(data, fiche, pr, p);
      const stepIds = new Set<string>();
      const cles = new Set<string>();
      for (const st of steps) {
        if (stepIds.has(st.id)) p.add(where, `etape en double : ${st.id}`);
        stepIds.add(st.id);
        for (const m of st.mesures) {
          if (cles.has(m.cle)) p.add(where, `mesure en double : ${m.cle}`);
          cles.add(m.cle);
        }
        if (st.mesures.length && !st.obligatoire && st.mesures.some((m) => m.min === undefined && m.max === undefined)) p.add(where, `${st.id} : limite manquante`);
        const config = (pr ? fiche.profils[pr].bench : null) ?? fiche.bench;
        for (const need of BENCH_REQUIRES[st.bench]) {
          if (!config || (config as unknown as Obj)[need] === undefined) p.add(where, `${st.id} : le rejeu « ${st.bench} » exige « ${need} » dans la configuration de banc (profil ou fiche)`);
        }
      }
      if (!stepIds.has('prep-identif')) p.add(where, "l'etape prep-identif est obligatoire (numero de serie, firmware)");
      if (!stepIds.has('closeout')) p.add(where, "l'etape closeout (signatures) est obligatoire");
      if (steps.filter((s) => s.obligatoire).length < 4) p.add(where, 'au moins 4 etapes obligatoires attendues');
      if (steps.some((s) => s.id === 'closeout' && !s.obligatoire)) p.add(where, 'closeout doit etre obligatoire');
    }
  }
  return p.list;
}

let cache: { dir: string; data: FichesData } | null = null;

/** Charge et valide (une fois par dossier). Leve une erreur lisible si le fichier est invalide. */
export function loadFiches(dir: string = QUALIF_DIR): FichesData {
  if (cache && cache.dir === dir) return cache.data;
  const raw = readFichesData(dir);
  const problems = validateFichesData(raw);
  if (problems.length) throw new Error(`qualification/fiches.json invalide :\n- ${problems.join('\n- ')}`);
  cache = { dir, data: raw as FichesData };
  return cache.data;
}

export function ficheIds(dir?: string): string[] {
  return loadFiches(dir).fiches.map((f) => f.id);
}

export function getFiche(id: string, dir?: string): Fiche | null {
  return loadFiches(dir).fiches.find((f) => f.id === id) ?? null;
}

/** Etapes applicables a un profil, textes resolus. Un profil inconnu ou manquant (alors que la fiche en a) est une erreur. */
export function stepsFor(fiche: Fiche, profile: string | null, dir?: string): Step[] {
  const profiles = Object.keys(fiche.profils);
  if (profiles.length && (!profile || !profiles.includes(profile))) throw new Error(`profil « ${profile ?? ''} » inconnu pour la fiche ${fiche.id} (profils : ${profiles.join(', ')})`);
  if (!profiles.length && profile) throw new Error(`la fiche ${fiche.id} n'a pas de profils`);
  const p = new Problems();
  const steps = expand(loadFiches(dir), fiche, profile, p);
  if (!p.ok) throw new Error(p.list.join('\n'));
  return steps;
}

export function benchConfigFor(fiche: Fiche, profile: string | null): BenchConfig | null {
  return (profile ? fiche.profils[profile]?.bench : null) ?? fiche.bench;
}

/** Empreinte du contenu qui compte pour un resultat : etapes, caractere obligatoire, mesures et limites. */
export function stepsHash(fiche: Fiche, profile: string | null, steps: Step[]): string {
  const core = steps.map((s) => ({ id: s.id, o: s.obligatoire, m: s.mesures.map((m) => [m.cle, m.min ?? null, m.max ?? null]) }));
  return createHash('sha256').update(JSON.stringify({ f: fiche.id, v: fiche.version, p: profile, s: core })).digest('hex').slice(0, 16);
}

export function ficheHash(fiche: Fiche, profile: string | null, dir?: string): string {
  return stepsHash(fiche, profile, stepsFor(fiche, profile, dir));
}

// ---------------------------------------------------------------- rendu

export interface SheetModel {
  id: string;
  fabricant: string;
  modele: string;
  famille: string;
  raccordement: string;
  statut: string;
  portee: string;
  derniere_reference?: string;
}

const limitText = (m: Measure): string => {
  const parts: string[] = [];
  if (m.min !== undefined) parts.push(`au moins ${m.min} ${m.unite}`);
  if (m.max !== undefined) parts.push(`au plus ${m.max} ${m.unite}`);
  return parts.join(' et ');
};

function criteria(fiche: Fiche, steps: Step[]): { reussite: string[]; echec: string[] } {
  const mandatory = steps.filter((s) => s.obligatoire);
  const reussite = [
    "Essai fait avec le matériel réel, jamais avec un équipement simulé (la case « matériel réel » du résultat est cochée et vraie).",
    `Les ${mandatory.length} étapes marquées OBLIGATOIRE sont toutes à « pass ». Aucune étape, même facultative, n'est à « fail ».`,
    "Chaque mesure chiffrée est dans ses limites (voir les étapes concernées).",
    "Toute étape « na » est justifiée par écrit dans la remarque.",
    "Numéro de série, firmware, versions du PSIM et de la passerelle sont notés ; la fiche est signée par le testeur et par le responsable d'atelier.",
    ...fiche.criteres_supplementaires.reussite,
  ];
  const echec = [
    "Un seul déclenchement manqué ou doublé sur les cycles de répétabilité.",
    "Un équipement muet, en défaut ou dont la liaison est coupée qui reste affiché « Normal ».",
    "Une alarme perdue ou fantôme après un redémarrage du PSIM ou une coupure réseau.",
    "Une mesure chiffrée hors de ses limites, ou un résultat qu'on ne sait pas reproduire.",
    ...fiche.criteres_supplementaires.echec,
  ];
  return { reussite, echec };
}

export function renderMarkdown(fiche: Fiche, profile: string | null, model?: SheetModel, dir?: string): string {
  const steps = stepsFor(fiche, profile, dir);
  const prof = profile ? fiche.profils[profile] : null;
  const crit = criteria(fiche, steps);
  const params: Params = { ...loadFiches(dir).defaults, ...fiche.params, ...(prof?.params ?? {}) };
  const sub = (s: string) => s.replace(PLACEHOLDER, (_m, k: string) => String(params[k] ?? ''));
  const out: string[] = [];
  out.push(`# Fiche de recette : ${fiche.titre}`);
  out.push('');
  if (prof) out.push(`**Profil : ${prof.libelle}** (\`${profile}\`)  `);
  if (model) {
    out.push(`**Modèle : ${model.fabricant} ${model.modele}** (\`${model.id}\`) — ${model.famille}  `);
    out.push(`Raccordement : ${model.raccordement} — statut au registre : **${model.statut}**  `);
    out.push(`Portée actuellement validée : ${model.portee}  `);
    if (model.derniere_reference) out.push(`Dernier essai : ${model.derniere_reference}  `);
  }
  out.push(`Fiche \`${fiche.id}\` version ${fiche.version} — empreinte \`${ficheHash(fiche, profile, dir)}\`  `);
  out.push(`Référence : ${fiche.docs.join(' ; ')}`);
  out.push('');
  out.push(`> ${fiche.resume}`);
  out.push('');
  out.push('> **Règle d\'entreprise : aucune référence n\'entre dans un pack sans recette en atelier.** Un essai fait avec un équipement simulé (banc simulé, tests automatiques) ne qualifie jamais un matériel. Cette fiche se remplit avec le matériel réel, puis le résultat s\'enregistre avec `npm run qualify -- record`.');
  out.push('');
  out.push('## Champs à remplir');
  out.push('');
  out.push('| Champ | Valeur |');
  out.push('|---|---|');
  for (const f of ['Numéro(s) de série', 'Version du micrologiciel (firmware)', 'Version du PSIM testée', 'Version de la passerelle testée (si utilisée)', 'Testeur (nom)', 'Date de l\'essai', 'Matériel réel (oui / non)', 'Température et humidité du local d\'essai']) out.push(`| ${f} | |`);
  out.push('');
  out.push('## Matériel nécessaire');
  out.push('');
  for (const m of fiche.materiel) out.push(`- ${sub(m)}`);
  out.push('');
  out.push("## Montage du banc d'essai");
  out.push('');
  for (const [i, b] of fiche.banc.entries()) out.push(`${i + 1}. ${sub(b)}`);
  out.push('');
  out.push('## Étapes');
  out.push('');
  out.push('Pour chaque étape, cocher **pass**, **fail** ou **na** (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».');
  let n = 0;
  for (const section of SECTIONS) {
    const inSection = steps.filter((s) => s.section === section);
    if (!inSection.length) continue;
    out.push('');
    out.push(`### ${SECTION_LABEL[section]}`);
    for (const s of inSection) {
      n += 1;
      out.push('');
      out.push(`#### ${n}. ${s.titre} \`${s.id}\` — ${s.obligatoire ? 'OBLIGATOIRE' : 'facultative'}`);
      out.push('');
      out.push(`**À faire** : ${s.action}`);
      out.push('');
      out.push(`**Résultat attendu** : ${s.attendu}`);
      for (const m of s.mesures) {
        out.push('');
        out.push(`**Mesure** \`${m.cle}\` — ${m.libelle} : ${limitText(m)}. Valeur relevée : ________ ${m.unite}`);
      }
      out.push('');
      out.push('Résultat : ☐ pass   ☐ fail   ☐ na        Remarque : ______________________________________');
    }
  }
  out.push('');
  out.push('## Critères de réussite');
  out.push('');
  for (const c of crit.reussite) out.push(`- ${c}`);
  out.push('');
  out.push("## Critères d'échec");
  out.push('');
  for (const c of crit.echec) out.push(`- ${c}`);
  out.push('');
  out.push('## Synthèse et signatures');
  out.push('');
  out.push('Conclusion : ☐ qualifié   ☐ à refaire   ☐ rejeté        Réserves : ______________________________________');
  out.push('');
  out.push('| Testeur : nom, date, signature | Responsable d\'atelier : nom, date, signature |');
  out.push('|---|---|');
  out.push('| <br><br><br> | <br><br><br> |');
  out.push('');
  return out.join('\n');
}

export function renderHtml(fiche: Fiche, profile: string | null, model?: SheetModel, dir?: string): string {
  const steps = stepsFor(fiche, profile, dir);
  const prof = profile ? fiche.profils[profile] : null;
  const crit = criteria(fiche, steps);
  const params: Params = { ...loadFiches(dir).defaults, ...fiche.params, ...(prof?.params ?? {}) };
  const sub = (s: string) => escapeHtml(s.replace(PLACEHOLDER, (_m, k: string) => String(params[k] ?? '')));
  const e = escapeHtml;
  let n = 0;
  const sections = SECTIONS.map((section) => {
    const inSection = steps.filter((s) => s.section === section);
    if (!inSection.length) return '';
    return `<h2>${e(SECTION_LABEL[section])}</h2>${inSection
      .map((s) => {
        n += 1;
        return `<section class="step ${s.obligatoire ? 'must' : ''}"><h3>${n}. ${e(s.titre)} <code>${e(s.id)}</code> <span class="tag">${s.obligatoire ? 'OBLIGATOIRE' : 'facultative'}</span></h3>
<p><b>À faire</b> : ${e(s.action)}</p><p><b>Résultat attendu</b> : ${e(s.attendu)}</p>
${s.mesures.map((m) => `<p class="mesure"><b>Mesure</b> <code>${e(m.cle)}</code> — ${e(m.libelle)} : ${e(limitText(m))}. Valeur relevée : <span class="blank"></span> ${e(m.unite)}</p>`).join('')}
<p class="res">Résultat : &#9744; pass &nbsp; &#9744; fail &nbsp; &#9744; na &nbsp;&nbsp; Remarque : <span class="blank long"></span></p></section>`;
      })
      .join('')}`;
  }).join('\n');
  const fields = ['Numéro(s) de série', 'Version du micrologiciel (firmware)', 'Version du PSIM testée', 'Version de la passerelle testée (si utilisée)', 'Testeur (nom)', "Date de l'essai", 'Matériel réel (oui / non)', "Température et humidité du local d'essai"];
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Fiche de recette - ${e(fiche.titre)}</title>
<style>
body{font:12px/1.45 Segoe UI,Arial,sans-serif;color:#111;margin:18px;max-width:900px}
h1{font-size:19px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 6px;border-bottom:1px solid #999}h3{font-size:12.5px;margin:0 0 4px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #777;padding:5px 7px;text-align:left}td.v{width:60%;height:22px}
.step{border:1px solid #bbb;border-radius:4px;padding:6px 10px;margin:8px 0;break-inside:avoid}.step.must{border-left:4px solid #222}
.tag{font-size:10px;border:1px solid #555;border-radius:3px;padding:0 4px;margin-left:6px}code{font-size:11px;background:#eee;padding:0 3px}
.blank{display:inline-block;border-bottom:1px solid #555;min-width:90px;height:13px}.blank.long{min-width:320px}
.note{border:1px solid #999;background:#f6f6f6;padding:6px 10px;margin:8px 0}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:26px}.sign div{border-top:1px solid #111;padding-top:4px;min-height:60px}
@media print{body{margin:8mm}h2{break-after:avoid}}
</style></head><body>
<h1>Fiche de recette : ${e(fiche.titre)}</h1>
${prof ? `<p><b>Profil : ${e(prof.libelle)}</b> (<code>${e(profile)}</code>)</p>` : ''}
${model ? `<p><b>Modèle : ${e(model.fabricant)} ${e(model.modele)}</b> (<code>${e(model.id)}</code>) — ${e(model.famille)}<br>Raccordement : ${e(model.raccordement)} — statut au registre : <b>${e(model.statut)}</b><br>Portée actuellement validée : ${e(model.portee)}${model.derniere_reference ? `<br>Dernier essai : ${e(model.derniere_reference)}` : ''}</p>` : ''}
<p>Fiche <code>${e(fiche.id)}</code> version ${fiche.version}, empreinte <code>${e(ficheHash(fiche, profile, dir))}</code>. Référence : ${e(fiche.docs.join(' ; '))}</p>
<p>${e(fiche.resume)}</p>
<div class="note"><b>Règle d'entreprise : aucune référence n'entre dans un pack sans recette en atelier.</b> Un essai fait avec un équipement simulé ne qualifie jamais un matériel. Cette fiche se remplit avec le matériel réel, puis le résultat s'enregistre avec <code>npm run qualify -- record</code>.</div>
<h2>Champs à remplir</h2><table>${fields.map((f) => `<tr><th>${e(f)}</th><td class="v"></td></tr>`).join('')}</table>
<h2>Matériel nécessaire</h2><ul>${fiche.materiel.map((m) => `<li>${sub(m)}</li>`).join('')}</ul>
<h2>Montage du banc d'essai</h2><ol>${fiche.banc.map((b) => `<li>${sub(b)}</li>`).join('')}</ol>
<h2>Étapes</h2><p>Cocher <b>pass</b>, <b>fail</b> ou <b>na</b> (non applicable, avec la raison) et noter les mesures. Les étapes OBLIGATOIRES doivent toutes être à « pass ».</p>
${sections}
<h2>Critères de réussite</h2><ul>${crit.reussite.map((c) => `<li>${e(c)}</li>`).join('')}</ul>
<h2>Critères d'échec</h2><ul>${crit.echec.map((c) => `<li>${e(c)}</li>`).join('')}</ul>
<h2>Synthèse et signatures</h2>
<p>Conclusion : &#9744; qualifié &nbsp; &#9744; à refaire &nbsp; &#9744; rejeté &nbsp;&nbsp; Réserves : <span class="blank long"></span></p>
<div class="sign"><div>Testeur : nom, date, signature</div><div>Responsable d'atelier : nom, date, signature</div></div>
</body></html>`;
}

/** Descend d'un niveau tous les titres Markdown (le titre de la fiche devient un titre de section du document). */
const demote = (md: string): string => md.split('\n').map((l) => (/^#{1,5} /.test(l) ? `#${l}` : l)).join('\n');

/** Document `docs/qualification/<fiche>.md` : en-tete commun puis une fiche complete par profil (une page chacune). */
export function renderFicheDoc(fiche: Fiche, dir?: string): string {
  const profiles = Object.keys(fiche.profils);
  if (!profiles.length) return `${renderMarkdown(fiche, null, undefined, dir)}\n`;
  const out: string[] = [];
  out.push(`<!-- Fichier généré par « npm run qualify -- docs » à partir de qualification/fiches.json : ne pas modifier à la main. -->`);
  out.push(`# Fiches de recette : ${fiche.titre}`);
  out.push('');
  out.push(`> ${fiche.resume}`);
  out.push('');
  out.push('Choisir le **profil** qui correspond au matériel, imprimer sa fiche et la remplir avec le matériel réel. Pour une fiche vierge au nom d\'un modèle précis : `npm run qualify -- sheet <identifiant-du-modèle>`.');
  out.push('');
  out.push('| Profil | Libellé | Étapes obligatoires |');
  out.push('|---|---|---|');
  for (const pr of profiles) {
    const st = stepsFor(fiche, pr, dir);
    out.push(`| [\`${pr}\`](#profil-${pr}) | ${fiche.profils[pr].libelle} | ${st.filter((s) => s.obligatoire).length} sur ${st.length} |`);
  }
  for (const pr of profiles) {
    out.push('');
    out.push(`<a id="profil-${pr}"></a>`);
    out.push('');
    out.push(demote(renderMarkdown(fiche, pr, undefined, dir)));
    out.push('');
  }
  return `${out.join('\n')}\n`;
}
