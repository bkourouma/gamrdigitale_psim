/**
 * Compteur de refus par porte (docs/CONTROLE-ACCES.md, par. 1.7) : `badge_denied_repeated` quand X refus tombent dans une
 * fenetre de Y secondes sur la meme porte (3 en 60 s par defaut).
 *
 * Choix :
 *  - la fenetre est calculee sur l'heure DU CONTROLEUR de chaque refus (`ts`), jamais sur l'heure de reception : une
 *    recuperation apres coupure (F8) ou des evenements recus dans le desordre donnent le meme resultat ;
 *  - bornes incluses : 3 refus a 0 s, 30 s et 60 s tiennent dans une fenetre de 60 s ;
 *  - apres un declenchement, le compteur de CETTE porte repart de zero (il faut X nouveaux refus pour redeclencher) ;
 *  - un passage accepte ne remet PAS le compteur a zero (hypothese prudente : un badge valide entre deux essais rates
 *    ne doit pas masquer quelqu'un qui essaie des badges) ; le compteur ne le voit d'ailleurs jamais ;
 *  - un refus differe (recupere apres une coupure) compte comme les autres ;
 *  - memoire bornee : au plus `maxDoors` portes suivies (la moins recemment touchee est oubliee) et `maxPerDoor` refus par
 *    porte (les plus anciens sont oublies).
 * Aucune horloge, aucun temporisateur.
 */

export interface DenialOptions {
  /** Nombre de refus qui declenche (3 par defaut). */
  count?: number;
  /** Largeur de la fenetre en secondes (60 par defaut). */
  windowS?: number;
  /** Portes suivies au plus (256). */
  maxDoors?: number;
  /** Refus gardes par porte au plus (4 fois le seuil, 16 au minimum). */
  maxPerDoor?: number;
}

export class DenialCounter {
  readonly count: number;
  readonly windowMs: number;
  private readonly maxDoors: number;
  private readonly maxPerDoor: number;
  /** Heures de refus triees par ordre croissant, par porte. L'ordre d'insertion de la Map sert d'ordre d'usage. */
  private readonly doors = new Map<number, number[]>();

  constructor(opts: DenialOptions = {}) {
    const count = opts.count ?? 3;
    const windowS = opts.windowS ?? 60;
    if (!Number.isInteger(count) || count < 1) throw new RangeError('seuil de refus invalide (entier de 1 au moins)');
    if (!Number.isFinite(windowS) || windowS <= 0) throw new RangeError('fenetre de refus invalide (secondes, superieures a 0)');
    this.count = count;
    this.windowMs = windowS * 1000;
    this.maxDoors = Math.max(1, Math.floor(opts.maxDoors ?? 256));
    this.maxPerDoor = Math.max(count, Math.floor(opts.maxPerDoor ?? Math.max(count * 4, 16)));
  }

  /**
   * Enregistre un refus a l'heure `ts` (ms, heure du controleur) sur la porte `doorNo`.
   * Vrai quand le seuil est atteint : le compteur de la porte est alors remis a zero. Une heure inutilisable (NaN, non
   * entiere, negative) est ignoree (faux).
   */
  record(doorNo: number, ts: number): boolean {
    if (!Number.isSafeInteger(ts) || ts <= 0) return false;
    let list = this.doors.get(doorNo);
    if (list) {
      // Touchee en dernier : elle passe en fin de Map.
      this.doors.delete(doorNo);
    } else {
      list = [];
      while (this.doors.size >= this.maxDoors) {
        const oldest = this.doors.keys().next();
        if (oldest.done) break;
        this.doors.delete(oldest.value);
      }
    }
    this.doors.set(doorNo, list);
    // Insertion triee (apres les heures egales) : tolere les evenements recus dans le desordre.
    let i = list.length;
    while (i > 0 && list[i - 1]! > ts) i--;
    list.splice(i, 0, ts);
    let at = i;
    if (list.length > this.maxPerDoor) {
      list.shift();
      at--;
    }
    if (at < 0) return false; // le plus ancien de tous, deja oublie
    // Une fenetre de `count` refus consecutifs qui contient le nouveau et tient dans la largeur voulue ?
    const first = Math.max(0, at - this.count + 1);
    const last = Math.min(at, list.length - this.count);
    for (let s = first; s <= last; s++) {
      if (list[s + this.count - 1]! - list[s]! <= this.windowMs) {
        this.doors.delete(doorNo);
        return true;
      }
    }
    return false;
  }

  /** Remet a zero une porte (ou toutes). */
  reset(doorNo?: number): void {
    if (doorNo === undefined) this.doors.clear();
    else this.doors.delete(doorNo);
  }

  /** Refus actuellement retenus pour une porte (essais, journaux). */
  pending(doorNo: number): number {
    return this.doors.get(doorNo)?.length ?? 0;
  }

  /** Nombre de portes suivies (essais : memoire bornee). */
  get tracked(): number {
    return this.doors.size;
  }
}
