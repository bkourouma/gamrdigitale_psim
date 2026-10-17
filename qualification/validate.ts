/**
 * Petits outils de validation stricte, ecrits a la main (aucune dependance). Un validateur accumule les problemes avec
 * leur chemin (« entries[3].status : ... ») pour que l'utilisateur voie tout d'un coup.
 */
export type Obj = Record<string, unknown>;

export class Problems {
  readonly list: string[] = [];
  add(path: string, message: string): void {
    this.list.push(`${path} : ${message}`);
  }
  get ok(): boolean {
    return this.list.length === 0;
  }
}

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Refuse toute cle hors de `allowed` (une faute de frappe ne doit jamais passer en silence). */
export function onlyKeys(p: Problems, path: string, o: Obj, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) p.add(`${path}.${k}`, 'champ inconnu');
}

export function text(p: Problems, path: string, v: unknown, opts: { max?: number; empty?: boolean } = {}): v is string {
  if (typeof v !== 'string') {
    p.add(path, 'texte attendu');
    return false;
  }
  if (!opts.empty && v.trim() === '') {
    p.add(path, 'ne doit pas etre vide');
    return false;
  }
  if (v.length > (opts.max ?? 2000)) {
    p.add(path, `trop long (${opts.max ?? 2000} caracteres au plus)`);
    return false;
  }
  return true;
}

export function oneOf<T extends string>(p: Problems, path: string, v: unknown, allowed: readonly T[]): v is T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    p.add(path, `valeur attendue parmi : ${allowed.join(', ')}`);
    return false;
  }
  return true;
}

export function bool(p: Problems, path: string, v: unknown): v is boolean {
  if (typeof v !== 'boolean') {
    p.add(path, 'booleen attendu (true ou false)');
    return false;
  }
  return true;
}

export function num(p: Problems, path: string, v: unknown, opts: { min?: number; max?: number } = {}): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    p.add(path, 'nombre attendu');
    return false;
  }
  if (opts.min !== undefined && v < opts.min) {
    p.add(path, `doit etre au moins ${opts.min}`);
    return false;
  }
  if (opts.max !== undefined && v > opts.max) {
    p.add(path, `doit etre au plus ${opts.max}`);
    return false;
  }
  return true;
}

/** Date au format AAAA-MM-JJ, calendrier reel (pas de 2026-02-30). */
export function isoDate(p: Problems, path: string, v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    p.add(path, 'date attendue au format AAAA-MM-JJ');
    return false;
  }
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    p.add(path, 'date inexistante');
    return false;
  }
  return true;
}

/** Horodatage ISO 8601 complet (UTC ou avec decalage). */
export function isoDateTime(p: Problems, path: string, v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) || Number.isNaN(Date.parse(v))) {
    p.add(path, 'horodatage ISO 8601 attendu (ex. 2026-10-11T09:30:00Z)');
    return false;
  }
  return true;
}

export function array(p: Problems, path: string, v: unknown, opts: { min?: number; max?: number } = {}): v is unknown[] {
  if (!Array.isArray(v)) {
    p.add(path, 'liste attendue');
    return false;
  }
  if (opts.min !== undefined && v.length < opts.min) {
    p.add(path, `au moins ${opts.min} element(s) attendu(s)`);
    return false;
  }
  if (opts.max !== undefined && v.length > opts.max) {
    p.add(path, `au plus ${opts.max} elements`);
    return false;
  }
  return true;
}

/** Identifiant stable : minuscules, chiffres et tirets, 2 a 64 caracteres. */
export const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Echappement HTML (les fiches sont produites a partir de donnees : jamais de balise brute). */
export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
