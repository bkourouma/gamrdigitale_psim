/**
 * Correspondance `scheduleRef` (reference PSIM d'un horaire, `S<id>`) -> numero de plage du controleur, PAR controleur
 * (docs/CONTROLE-ACCES.md, par. 7). Un controleur n'a qu'un nombre fixe de plages horaires (Dahua `AccessTimeSchedule`, ZKTeco
 * `TimeZone`) : le module en attribue une a chaque horaire du PSIM et se souvient de l'attribution, meme apres un redemarrage.
 *
 * Persistance : un fichier JSON `acces-plages.json` dans le dossier `dir`, meme discipline que `CursorStore` :
 *  - ecriture atomique (fichier temporaire ecrit puis synchronise, puis `rename`) ;
 *  - ecriture regroupee : `tick()` ecrit au plus une fois par seconde (horloge injectee, AUCUNE minuterie ici), `flush()` tout
 *    de suite et de facon synchrone ;
 *  - a l'ecriture, le fichier est relu et fusionne : seuls les controleurs MODIFIES par ce magasin sont remplaces (deux modules
 *    peuvent partager le dossier) ;
 *  - lecture tolerante : fichier absent, vide, tronque, trop gros ou hostile = etat vide (ou seules les entrees valides) + un
 *    avertissement, jamais d'exception.
 *
 * Invariants : pour un controleur, deux references n'ont jamais le meme numero ; un numero attribue reste le meme tant que la
 * reference n'est pas liberee (`allocate` est idempotent) ; `allocate` rend toujours le plus petit numero libre de `[min, max]`.
 * Les journaux ne contiennent jamais de reference en clair.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { realCursorIo } from './cursor.ts';
import type { CursorIo } from './cursor.ts';
import { createLimitedLog } from './limitedlog.ts';
import { CONTROLLER_ID } from './messages.ts';
import type { LogFn } from './types.ts';

export const SLOTS_FILE = 'acces-plages.json';
/** Format d'une reference d'horaire. */
export const SCHEDULE_REF = /^S[A-Za-z0-9_-]{1,31}$/;
const MAX_CONTROLLERS = 256;
/** Plus grand ecart `max - min` accepte a la construction (un controleur n'a pas des milliers de plages). */
const MAX_RANGE = 1023;
const MAX_FILE_BYTES = 1024 * 1024;
const WRITE_EVERY_MS = 1000;

export type SlotIo = CursorIo;

export interface SlotMapOptions {
  /** Dossier du fichier (cree au besoin). */
  dir: string;
  now: () => number;
  log: LogFn;
  /** Premier et dernier numero de plage utilisables (bornes incluses, entiers >= 0, `min <= max`). RangeError sinon. */
  min: number;
  max: number;
  io?: Partial<SlotIo>;
}

type Refs = Map<string, number>;

export class SlotMap {
  readonly file: string;
  readonly min: number;
  readonly max: number;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly io: SlotIo;
  private readonly warn: (key: string, text: string) => void;
  private readonly controllers = new Map<string, Refs>();
  /** Controleurs modifies depuis la derniere ecriture reussie. */
  private readonly touched = new Set<string>();
  private lastWriteAt: number | null = null;

  constructor(opts: SlotMapOptions) {
    if (!Number.isInteger(opts.min) || !Number.isInteger(opts.max) || opts.min < 0 || opts.max < opts.min || opts.max - opts.min > MAX_RANGE) {
      throw new RangeError('bornes des plages horaires invalides (entiers, 0 <= min <= max, au plus 1024 plages)');
    }
    this.min = opts.min;
    this.max = opts.max;
    this.dir = opts.dir;
    this.file = join(opts.dir, SLOTS_FILE);
    this.now = opts.now;
    this.io = { ...realCursorIo, ...opts.io };
    const limited = createLimitedLog(opts.log, opts.now);
    this.warn = (key, text) => limited(key, 'warn', text);
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      this.warn('mkdir', `dossier des plages horaires d'acces inutilisable (${this.dir}) : l'attribution ne sera pas conservee tant que le dossier manque`);
    }
    for (const [id, refs] of this.read(true)) this.controllers.set(id, refs);
  }

  /** Numero de plage attribue a cette reference, ou `null`. */
  get(controllerId: string, ref: string): number | null {
    return this.controllers.get(controllerId)?.get(ref) ?? null;
  }

  /**
   * Numero de plage de cette reference : celui deja attribue (idempotent), sinon le plus petit numero libre de `[min, max]`.
   * `'full'` s'il n'y en a plus (ou si le controleur / la reference est invalide, ou s'il y a trop de controleurs : on ne
   * devine jamais). N'ecrit pas sur le disque (voir `tick` et `flush`). Si l'appel au controleur echoue ensuite, l'appelant
   * annule par `release` : il ne doit rester aucune attribution fantome.
   */
  allocate(controllerId: string, ref: string): number | 'full' {
    if (typeof controllerId !== 'string' || !CONTROLLER_ID.test(controllerId) || typeof ref !== 'string' || !SCHEDULE_REF.test(ref)) {
      this.warn('badalloc', "attribution de plage horaire refusee : controleur ou reference invalide");
      return 'full';
    }
    let refs = this.controllers.get(controllerId);
    const known = refs?.get(ref);
    if (known !== undefined) return known;
    if (!refs) {
      if (this.controllers.size >= MAX_CONTROLLERS) {
        this.warn('toomany', "trop de controleurs dans les plages horaires d'acces : attribution refusee");
        return 'full';
      }
      refs = new Map();
    }
    const used = new Set(refs.values());
    let slot = this.min;
    while (slot <= this.max && used.has(slot)) slot++;
    if (slot > this.max) return 'full';
    refs.set(ref, slot);
    this.controllers.set(controllerId, refs);
    this.touched.add(controllerId);
    return slot;
  }

  /** Libere la plage de cette reference. Vrai si elle etait attribuee. */
  release(controllerId: string, ref: string): boolean {
    const refs = this.controllers.get(controllerId);
    if (!refs || !refs.delete(ref)) return false;
    // Un controleur sans aucune plage reste dans la table tant qu'il est " touche " : l'ecriture fusionnee doit savoir qu'il est vide.
    this.touched.add(controllerId);
    return true;
  }

  /** Attributions d'un controleur, par numero de plage croissant. */
  list(controllerId: string): Array<{ ref: string; slot: number }> {
    const refs = this.controllers.get(controllerId);
    if (!refs) return [];
    return [...refs].map(([ref, slot]) => ({ ref, slot })).sort((a, b) => a.slot - b.slot);
  }

  /** A appeler a intervalle regulier : ecrit si quelque chose a change depuis plus d'une seconde. */
  tick(): void {
    if (this.touched.size === 0) return;
    const t = this.now();
    // Horloge revenue en arriere : on ecrit tout de suite plutot que d'attendre un retard qui ne vient jamais.
    if (this.lastWriteAt === null || t < this.lastWriteAt || t - this.lastWriteAt >= WRITE_EVERY_MS) this.flush();
  }

  /** Ecrit tout de suite (synchrone). Ne leve jamais ; en cas d'echec l'etat reste " a ecrire " et sera retente. Vrai si tout est ecrit. */
  flush(): boolean {
    if (this.touched.size === 0) return true;
    this.lastWriteAt = this.now();
    const tmp = `${this.file}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true });
      // Fusion avec le disque : les controleurs que nous n'avons pas modifies gardent la valeur du fichier.
      const merged = new Map(this.controllers);
      for (const [id, refs] of this.read(false)) if (!this.touched.has(id)) merged.set(id, refs);
      // `fromEntries` cree des proprietes propres (un identifiant " __proto__ " ne modifie pas le prototype).
      const out = Object.fromEntries([...merged].filter(([, refs]) => refs.size > 0).map(([id, refs]) => [id, Object.fromEntries(refs)]));
      this.io.write(tmp, JSON.stringify({ v: 1, controllers: out }));
      this.io.rename(tmp, this.file);
      this.touched.clear();
      return true;
    } catch (err) {
      this.warn('write', `ecriture des plages horaires d'acces impossible (${err instanceof Error ? err.message : 'erreur'}) : nouvel essai plus tard`);
      return false;
    }
  }

  /** Lit le fichier ; toute anomalie donne un etat vide (ou les seules entrees valides) et un avertissement si `report`. */
  private read(report: boolean): Map<string, Refs> {
    const out = new Map<string, Refs>();
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && report) this.warn('read', "fichier des plages horaires d'acces illisible : etat vide");
      return out;
    }
    if (text.trim() === '') {
      if (report) this.warn('empty', "fichier des plages horaires d'acces vide : etat vide");
      return out;
    }
    if (text.length > MAX_FILE_BYTES) {
      if (report) this.warn('big', "fichier des plages horaires d'acces trop gros : ignore");
      return out;
    }
    let data: unknown;
    try {
      data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      if (report) this.warn('corrupt', "fichier des plages horaires d'acces corrompu : etat vide");
      return out;
    }
    const controllers = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as { controllers?: unknown }).controllers : undefined;
    if (typeof controllers !== 'object' || controllers === null || Array.isArray(controllers)) {
      if (report) this.warn('format', "fichier des plages horaires d'acces au mauvais format : etat vide");
      return out;
    }
    let dropped = 0;
    for (const [id, raw] of Object.entries(controllers)) {
      if (out.size >= MAX_CONTROLLERS || !CONTROLLER_ID.test(id) || typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        dropped++;
        continue;
      }
      const refs: Refs = new Map();
      const used = new Set<number>();
      for (const [ref, slot] of Object.entries(raw)) {
        // Numero valide, reference valide, et jamais deux references sur le meme numero (la premiere gagne).
        if (SCHEDULE_REF.test(ref) && typeof slot === 'number' && Number.isSafeInteger(slot) && slot >= 0 && !used.has(slot) && refs.size <= MAX_RANGE) {
          refs.set(ref, slot);
          used.add(slot);
        } else dropped++;
      }
      if (refs.size > 0) out.set(id, refs);
    }
    if (dropped > 0 && report) this.warn('dropped', `${dropped} entree(s) invalide(s) ignoree(s) dans le fichier des plages horaires d'acces`);
    return out;
  }
}
