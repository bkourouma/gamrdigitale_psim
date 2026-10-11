/**
 * Lecture d'un pack sur disque : un dossier contenant `pack.json` (ou le chemin du fichier lui-meme), et les plans
 * d'etage en fichiers images voisins. Les plans sont controles comme a l'envoi par l'interface (floors.ts) : extension,
 * taille, et contenu conforme au type annonce. Rien n'est ecrit.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { looksLike } from '../../server/floors.ts';
import { validateAddress } from '../../server/recipients.ts';
import type { ChannelId } from '../../server/recipients.ts';
import { DIGEST_USERNAME } from '../../server/dahua.ts';
import { TUYA_ID } from '../../server/tuya.ts';
import { HOST_PATTERN } from '../../server/video.ts';
import { validatePack } from './schema.ts';
import type { Marker, Pack, Question, Value, ValueKind } from './schema.ts';

const MAX_PACK_BYTES = 1024 * 1024;
/** Meme limite que l'envoi d'un plan par l'interface (api.ts). */
export const MAX_PLAN_BYTES = 10 * 1024 * 1024;
const PLAN_MIME: Record<string, { mime: string; ext: string }> = {
  png: { mime: 'image/png', ext: 'png' },
  jpg: { mime: 'image/jpeg', ext: 'jpg' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  webp: { mime: 'image/webp', ext: 'webp' },
  svg: { mime: 'image/svg+xml', ext: 'svg' },
};

export interface PlanFile {
  mime: string;
  ext: string;
  body: Buffer;
}

export interface LoadedPack {
  pack: Pack | null;
  errors: string[];
  questions: Question[];
  /** Dossier du pack et chemin de pack.json. */
  dir: string;
  file: string;
  /** Empreinte SHA-256 de pack.json (journal, fiche de recette). */
  sha256: string;
  /** Plans par identifiant d'etage du pack. */
  plans: Map<string, PlanFile>;
}

export function loadPack(path: string): LoadedPack {
  const target = resolve(path);
  const file = existsSync(target) && statSync(target).isDirectory() ? join(target, 'pack.json') : target;
  const dir = dirname(file);
  const empty = (errors: string[]): LoadedPack => ({ pack: null, errors, questions: [], dir, file, sha256: '', plans: new Map() });
  if (!existsSync(file)) return empty([`${file} : fichier introuvable`]);
  const bytes = readFileSync(file);
  if (bytes.length > MAX_PACK_BYTES) return empty([`${file} : fichier trop gros (1 Mo au plus)`]);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8').trimStart());
  } catch (err) {
    return empty([`${file} : JSON invalide (${(err as Error).message})`]);
  }
  const v = validatePack(raw);
  const out: LoadedPack = { pack: v.pack, errors: v.errors, questions: v.questions, dir, file, sha256: createHash('sha256').update(bytes).digest('hex'), plans: new Map() };
  if (!v.pack) return out;
  for (const floor of v.pack.floors) {
    if (!floor.plan) continue;
    const where = `floors « ${floor.id} ».plan`;
    const planPath = resolve(dir, floor.plan);
    if (!planPath.startsWith(resolve(dir) + sep)) {
      out.errors.push(`${where} : le plan doit etre dans le dossier du pack`);
      continue;
    }
    const type = PLAN_MIME[floor.plan.split('.').pop()!.toLowerCase()];
    if (!existsSync(planPath)) {
      out.errors.push(`${where} : fichier introuvable (${floor.plan})`);
      continue;
    }
    const body = readFileSync(planPath);
    if (body.length === 0 || body.length > MAX_PLAN_BYTES) out.errors.push(`${where} : image vide ou trop grosse (10 Mo au plus)`);
    else if (!type || !looksLike(type.mime, body)) out.errors.push(`${where} : le contenu ne correspond pas au type d'image annonce par l'extension`);
    else out.plans.set(floor.id, { mime: type.mime, ext: type.ext, body });
  }
  if (out.errors.length) out.pack = null;
  return out;
}

// ---------------------------------------------------------------- reponses

/** Reponses aux marqueurs, par cle de question (libelle du `$ask`, ou `$env:NOM`). */
export type Answers = Map<string, string>;

export const markerKey = (m: Marker): string => ('$ask' in m ? m.$ask : `$env:${m.$env}`);

/**
 * Valeur effective : texte du pack, reponse fournie, ou `null` si elle n'est pas (encore) connue (plan sans reponses).
 */
export function resolveValue(v: Value, answers: Answers): string | null {
  if (typeof v === 'string') return v;
  return answers.get(markerKey(v)) ?? null;
}

/** Message d'erreur si la reponse ne convient pas a sa nature ; null si elle est acceptable. Vide = destinataire ignore. */
export function checkAnswer(kind: ValueKind, value: string): string | null {
  if (kind.startsWith('address:')) {
    if (value.trim() === '') return null; // destinataire laisse de cote (adresse pas encore connue)
    try {
      validateAddress(kind.slice('address:'.length) as ChannelId, value);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }
  if (kind === 'host') return HOST_PATTERN.test(value.trim()) ? null : 'adresse IPv4 ou nom de machine attendu (sans http:// ni chemin)';
  if (kind === 'tuyaId') return TUYA_ID.test(value.trim()) ? null : "identifiant d'appareil Tuya attendu (lettres et chiffres, 8 a 64)";
  if (kind === 'username') return DIGEST_USERNAME.test(value) ? null : 'identifiant de 1 a 64 caracteres ASCII simples (sans accent ni guillemet)';
  if (kind === 'password') return value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value) ? null : 'mot de passe de 1 a 128 caracteres, sans caractere de controle';
  return null;
}

/**
 * Reponses lues : fichier JSON `{ "libelle": "valeur" }` puis variables d'environnement pour les `$env`. Rend aussi les
 * erreurs (valeur invalide) et les questions sans reponse (a poser, ou a signaler). N'affiche jamais une valeur.
 */
export function collectAnswers(questions: Question[], fromFile: Record<string, unknown>, env: NodeJS.ProcessEnv): { answers: Answers; missing: Question[]; errors: string[]; unused: string[] } {
  const answers: Answers = new Map();
  const missing: Question[] = [];
  const errors: string[] = [];
  for (const q of questions) {
    const raw = q.env ? env[q.env] : fromFile[q.key];
    if (raw === undefined) {
      missing.push(q);
      continue;
    }
    if (typeof raw !== 'string') {
      errors.push(`reponse « ${q.label} » : un texte est attendu`);
      continue;
    }
    const problem = checkAnswer(q.kind, raw);
    if (problem) errors.push(`reponse « ${q.label} » : ${problem}`);
    else answers.set(q.key, q.kind === 'password' ? raw : raw.trim());
  }
  const unused = Object.keys(fromFile).filter((k) => !questions.some((q) => q.key === k));
  return { answers, missing, errors, unused };
}
