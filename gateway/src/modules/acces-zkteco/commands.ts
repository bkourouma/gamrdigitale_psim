/**
 * File de commandes d'UN appareil ZKTeco. Le protocole PUSH est « tire » : le serveur ne peut rien envoyer, il pose la commande
 * dans une file et l'appareil la vient chercher (`GET /iclock/getrequest`) puis en annonce le resultat
 * (`POST /iclock/devicecmd`). Regles :
 *
 *  - une commande n'est remise QU'UNE FOIS a l'appareil, et une seule est « en vol » a la fois : les suivantes attendent son
 *    resultat (les ordres sur une meme porte sont ainsi serialises, dans l'ordre d'arrivee) ;
 *  - la promesse d'une commande ne se resout que sur `Return=0` de l'appareil. Un autre code est un refus, le silence est un
 *    delai depasse, un appareil qui n'est pas venu depuis longtemps est « hors ligne » ;
 *  - une commande qui depasse son delai est RETIREE de la file (sinon elle s'executerait en retard, longtemps apres que
 *    l'operateur ait cru a un echec) ; un resultat tardif pour une commande retiree est ignore ;
 *  - identifiants uniques (fournis par le module : jamais deux fois le meme, meme apres un redemarrage).
 * Aucun temporisateur ici : l'horloge est injectee et `sweep()` est appele par le module.
 */
import { ActuatorFailure } from '../acces-commun/actuator.ts';

export interface CommandsOptions {
  now: () => number;
  /** Delai total accorde a une commande depuis sa mise en file (ms). */
  timeoutMs: number;
  /** Silence de l'appareil (ms) au-dela duquel une commande est refusee tout de suite (hors ligne). */
  reachableMs: number;
  /** Identifiants uniques de commande. */
  nextId: () => number;
}

interface Entry {
  id: number;
  text: string;
  enqueuedAt: number;
  deadline: number;
  delivered: boolean;
  resolve: () => void;
  reject: (err: ActuatorFailure) => void;
}

export class DeviceCommands {
  private readonly opts: CommandsOptions;
  private readonly queue: Entry[] = [];
  private lastContactAt: number | null = null;

  constructor(opts: CommandsOptions) {
    this.opts = opts;
  }

  /** L'appareil vient de se manifester (n'importe quelle requete valide). */
  touch(): void {
    this.lastContactAt = this.opts.now();
  }

  /** Vrai si l'appareil s'est manifeste depuis moins de `reachableMs`. */
  reachable(): boolean {
    const t = this.opts.now();
    return this.lastContactAt !== null && t >= this.lastContactAt && t - this.lastContactAt <= this.opts.reachableMs;
  }

  /**
   * Met une commande en file. La promesse se resout quand l'appareil a confirme (`Return=0`) ; elle est rejetee par une
   * `ActuatorFailure` : `offline` (appareil muet, ou jamais venu), `refused_by_device` (autre code), `timeout` (pas de reponse
   * dans le delai), `stopped` (arret du module).
   */
  enqueue(text: string): Promise<void> {
    if (!this.reachable()) {
      return Promise.reject(new ActuatorFailure('offline', 'appareil injoignable : aucune interrogation recente'));
    }
    const t = this.opts.now();
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ id: this.opts.nextId(), text, enqueuedAt: t, deadline: t + this.opts.timeoutMs, delivered: false, resolve, reject });
    });
  }

  /**
   * Prochaine commande a remettre a l'appareil (ligne `C:<id>:<commande>`), ou `null`. Rien n'est remis tant qu'une commande
   * remise attend son resultat. La commande est marquee remise : elle ne sera jamais remise une seconde fois.
   */
  take(): { id: number; line: string } | null {
    this.sweep();
    if (this.queue.some((e) => e.delivered)) return null;
    const next = this.queue.find((e) => !e.delivered);
    if (!next) return null;
    next.delivered = true;
    return { id: next.id, line: `C:${next.id}:${next.text}` };
  }

  /** Resultat d'une commande remise. Faux si elle est inconnue (deja retiree, jamais remise, identifiant invente). */
  ack(id: number, code: number): boolean {
    this.sweep();
    const i = this.queue.findIndex((e) => e.id === id && e.delivered);
    if (i < 0) return false;
    const [entry] = this.queue.splice(i, 1);
    if (!entry) return false;
    if (code === 0) entry.resolve();
    else entry.reject(new ActuatorFailure('refused_by_device', `commande refusee par l'appareil (code ${code})`));
    return true;
  }

  /** Retire les commandes dont le delai est depasse. Rend leur nombre. */
  sweep(): number {
    const t = this.opts.now();
    let n = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const e = this.queue[i] as Entry;
      // Horloge revenue en arriere : l'echeance repart de maintenant plutot que d'attendre indefiniment.
      if (t < e.enqueuedAt) {
        e.enqueuedAt = t;
        e.deadline = t + this.opts.timeoutMs;
        continue;
      }
      if (t < e.deadline) continue;
      this.queue.splice(i, 1);
      n++;
      const silent = !e.delivered && (this.lastContactAt === null || this.lastContactAt <= e.enqueuedAt);
      e.reject(new ActuatorFailure(silent ? 'offline' : 'timeout', e.delivered ? "pas de reponse de l'appareil a la commande" : "l'appareil n'est pas venu chercher la commande"));
    }
    return n;
  }

  /** Arret du module : toutes les commandes en attente sont rejetees. */
  failAll(code: string, message: string): void {
    for (const e of this.queue.splice(0)) e.reject(new ActuatorFailure(code, message));
  }

  get pending(): number {
    return this.queue.length;
  }

  get inFlight(): boolean {
    return this.queue.some((e) => e.delivered);
  }
}
