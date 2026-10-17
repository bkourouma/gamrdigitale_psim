/**
 * Curseur de recuperation (F8) : pour chaque controleur, le dernier evenement connu `{ cursor, ts }`. Au retour d'une
 * coupure, la marque relit la memoire du controleur A PARTIR de ce curseur ; les passages manquants sont emis marques
 * `deferred`. Le curseur est une chaine OPAQUE choisie par la marque (no d'enregistrement Dahua, estampille ZKTeco...).
 *
 * Persistance : un fichier JSON `acces-curseurs.json` dans le dossier `dir`.
 *  - ecriture atomique : fichier temporaire (ecrit puis synchronise sur le disque) puis `rename` ; une coupure de courant laisse
 *    l'ancien fichier intact ;
 *  - ecriture regroupee : `set` marque l'etat  "a ecrire" ; `tick()` ecrit au plus une fois par seconde (horloge injectee) ;
 *    `flush()` ecrit tout de suite, de facon synchrone (a l'arret du module) ;
 *  - a l'ecriture, le fichier est relu et fusionne : seules les entrees MODIFIEES par ce magasin sont remplacees. Deux
 *    modules (dahua et zkteco) peuvent donc partager le meme dossier sans s'ecraser ;
 *  - lecture tolerante : fichier absent, vide, tronque, trop gros ou hostile = etat vide + un avertissement, jamais d'exception.
 * Le curseur ne recule jamais (voir `compare`).
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createLimitedLog } from './limitedlog.ts';
import { CONTROLLER_ID } from './messages.ts';
import type { LogFn } from './types.ts';

export const CURSOR_FILE = 'acces-curseurs.json';
const MAX_CURSOR_LENGTH = 128;
const MAX_CONTROLLERS = 256;
const MAX_FILE_BYTES = 1024 * 1024;
/** Au plus une ecriture par seconde. */
const WRITE_EVERY_MS = 1000;

export interface CursorEntry {
  cursor: string;
  /** Heure (ms) de l'evenement auquel correspond le curseur. */
  ts: number;
}

/** Negatif si `a` est plus ANCIEN que `b`, positif si plus recent, 0 si egaux. */
export type CursorCompare = (a: string, b: string) => number;

/**
 * Comparaison par defaut : numerique si les deux curseurs sont des nombres (entiers de plus de 15 chiffres compares sans perte),
 * sinon l'ordre d'arrivee (le nouveau est toujours considere plus recent).
 */
export const defaultCursorCompare: CursorCompare = (a, b) => {
  if (/^\d{1,40}$/.test(a) && /^\d{1,40}$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const na = a.trim() === '' ? Number.NaN : Number(a);
  const nb = b.trim() === '' ? Number.NaN : Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
  return 1;
};

/** Operations disque (injectables pour les essais : echec d'ecriture, coupure entre l'ecriture et le renommage). */
export interface CursorIo {
  /** Ecrit puis synchronise le fichier. */
  write(file: string, data: string): void;
  rename(from: string, to: string): void;
}

const realIo: CursorIo = {
  write(file, data) {
    const fd = openSync(file, 'w');
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  rename: renameSync,
};

export interface CursorStoreOptions {
  /** Dossier du fichier (cree au besoin). */
  dir: string;
  now: () => number;
  log: LogFn;
  compare?: CursorCompare;
  io?: Partial<CursorIo>;
}

type Entries = Map<string, CursorEntry>;

function validCursor(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_CURSOR_LENGTH && !/\p{Cc}/u.test(v);
}

function validTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

export class CursorStore {
  readonly file: string;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly compare: CursorCompare;
  private readonly io: CursorIo;
  private readonly warn: (key: string, text: string) => void;
  private readonly entries: Entries = new Map();
  /** Controleurs modifies depuis la derniere ecriture reussie. */
  private readonly touched = new Set<string>();
  private lastWriteAt: number | null = null;

  constructor(opts: CursorStoreOptions) {
    this.dir = opts.dir;
    this.file = join(opts.dir, CURSOR_FILE);
    this.now = opts.now;
    this.compare = opts.compare ?? defaultCursorCompare;
    this.io = { ...realIo, ...opts.io };
    const limited = createLimitedLog(opts.log, opts.now);
    this.warn = (key, text) => limited(key, 'warn', text);
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      this.warn('mkdir', `dossier des curseurs d'acces inutilisable (${this.dir}) : les curseurs ne seront pas conserves tant que le dossier manque`);
    }
    for (const [id, e] of this.read(true)) this.entries.set(id, e);
  }

  /** Dernier evenement connu pour ce controleur, ou `null`. */
  get(controllerId: string): CursorEntry | null {
    const e = this.entries.get(controllerId);
    return e ? { ...e } : null;
  }

  /**
   * Memorise le curseur de l'evenement le plus recent connu. Ne recule jamais : un curseur plus ancien que le courant (selon le
   * comparateur) est refuse. Rend vrai s'il a ete retenu, faux s'il est refuse, invalide ou sans effet. N'ecrit pas sur le
   * disque (voir `tick` et `flush`).
   */
  set(controllerId: string, cursor: string, ts: number): boolean {
    if (!CONTROLLER_ID.test(controllerId)) {
      this.warn('badid', 'curseur d\'acces refuse : identifiant de controleur invalide');
      return false;
    }
    if (!validCursor(cursor) || !validTime(ts)) {
      this.warn(`badcursor:${controllerId}`, `curseur d'acces refuse pour ${controllerId} : valeur ou heure invalide`);
      return false;
    }
    const cur = this.entries.get(controllerId);
    if (cur) {
      let order: number;
      try {
        order = this.compare(cursor, cur.cursor);
      } catch {
        this.warn('compare', 'comparateur de curseurs en echec : l\'ordre d\'arrivee est utilise');
        order = 1;
      }
      if (!(order >= 0)) return false; // plus ancien (ou resultat non numerique) : jamais de recul
    } else if (this.entries.size >= MAX_CONTROLLERS) {
      this.warn('toomany', 'trop de controleurs dans les curseurs d\'acces : curseur refuse');
      return false;
    }
    if (cur && cur.cursor === cursor && cur.ts === ts) return false;
    this.entries.set(controllerId, { cursor, ts });
    this.touched.add(controllerId);
    return true;
  }

  /** A appeler a intervalle regulier (le superviseur le fait dans `tick()`) : ecrit si quelque chose a change depuis plus d'une seconde. */
  tick(): void {
    if (this.touched.size === 0) return;
    const t = this.now();
    // Horloge revenue en arriere : on ecrit tout de suite plutot que d'attendre un retard qui ne vient jamais.
    if (this.lastWriteAt === null || t < this.lastWriteAt || t - this.lastWriteAt >= WRITE_EVERY_MS) this.flush();
  }

  /** Ecrit tout de suite (arret du module). Ne leve jamais ; en cas d'echec l'etat reste  "a ecrire" et sera retente. */
  flush(): void {
    if (this.touched.size === 0) return;
    this.lastWriteAt = this.now();
    const tmp = `${this.file}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true });
      // Fusion avec le disque : les controleurs que nous n'avons pas modifies gardent la valeur du fichier.
      const merged: Entries = new Map(this.entries);
      for (const [id, e] of this.read(false)) if (!this.touched.has(id)) merged.set(id, e);
      const data = JSON.stringify({ v: 1, controllers: Object.fromEntries(merged) });
      this.io.write(tmp, data);
      this.io.rename(tmp, this.file);
      this.touched.clear();
    } catch (err) {
      this.warn('write', `ecriture des curseurs d'acces impossible (${err instanceof Error ? err.message : 'erreur'}) : nouvel essai plus tard`);
    }
  }

  /** Lit le fichier ; toute anomalie donne un etat vide (ou les seules entrees valides) et un avertissement si `report`. */
  private read(report: boolean): Entries {
    const out: Entries = new Map();
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && report) this.warn('read', 'fichier des curseurs d\'acces illisible : etat vide');
      return out;
    }
    if (text.trim() === '') {
      if (report) this.warn('empty', 'fichier des curseurs d\'acces vide : etat vide');
      return out;
    }
    if (text.length > MAX_FILE_BYTES) {
      if (report) this.warn('big', 'fichier des curseurs d\'acces trop gros : ignore');
      return out;
    }
    let data: unknown;
    try {
      data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      if (report) this.warn('corrupt', 'fichier des curseurs d\'acces corrompu : etat vide');
      return out;
    }
    const controllers = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as { controllers?: unknown }).controllers : undefined;
    if (typeof controllers !== 'object' || controllers === null || Array.isArray(controllers)) {
      if (report) this.warn('format', 'fichier des curseurs d\'acces au mauvais format : etat vide');
      return out;
    }
    let dropped = 0;
    for (const [id, raw] of Object.entries(controllers)) {
      const e = typeof raw === 'object' && raw !== null ? (raw as { cursor?: unknown; ts?: unknown }) : null;
      if (out.size < MAX_CONTROLLERS && CONTROLLER_ID.test(id) && e && validCursor(e.cursor) && validTime(e.ts)) out.set(id, { cursor: e.cursor, ts: e.ts });
      else dropped++;
    }
    if (dropped > 0 && report) this.warn('dropped', `${dropped} entree(s) invalide(s) ignoree(s) dans le fichier des curseurs d'acces`);
    return out;
  }
}
