import type { DeviceMessage } from '../../module.ts';
import type { Action, PointConfig } from './config.ts';
import type { Evaluation } from './decode.ts';

/**
 * Logique d'emission d'un point : machine a etats pure (aucune entree/sortie), donc testable avec des heures fictives.
 * Regles :
 *  - un etat inchange n'est jamais re-emis (sauf le signe de vie periodique `heartbeat`) ;
 *  - anti-rebond : un changement doit durer `debounceMs` avant d'etre accepte (le premier echantillon est accepte tel quel) ;
 *  - mesure : emise si elle varie d'au moins `deadband` ET si `minIntervalMs` s'est ecoule ; re-emise periodiquement ;
 *  - apres `failThreshold` echecs consecutifs : `{state:'fault'}` UNE fois ; au retour, l'etat reel est reemis.
 * `ts` de chaque message = heure de la lecture. `msgId` = `<id>-<ts>-<numero>` : unique meme apres un redemarrage.
 */
export class PointTracker {
  readonly point: PointConfig;
  readonly #failThreshold: number;
  #seq = 0;
  #failures = 0;
  #faulted = false;
  #lastEmitTs = 0;
  // points a bits
  #accepted: boolean | null = null;
  #pending: { value: boolean; since: number } | null = null;
  // mesures
  #lastValue: number | null = null;
  #lastValueTs = 0;

  constructor(point: PointConfig, failThreshold: number) {
    this.point = point;
    this.#failThreshold = failThreshold;
  }

  get faulted(): boolean {
    return this.#faulted;
  }

  /** Un echec de lecture (reseau, exception, valeur inutilisable). Renvoie les messages a emettre. */
  failure(ts: number): DeviceMessage[] {
    this.#failures++;
    if (this.#failures < this.#failThreshold || this.#faulted) return [];
    this.#faulted = true;
    return [this.#msg({ state: 'fault' }, ts)];
  }

  /** Une lecture reussie et interpretee. Renvoie les messages a emettre. */
  sample(ev: Evaluation, ts: number): DeviceMessage[] {
    if (!ev.ok) return this.failure(ts);
    const recovered = this.#faulted;
    this.#failures = 0;
    this.#faulted = false;
    return ev.kind === 'bool' ? this.#sampleBool(ev.bool, ts, recovered) : this.#sampleValue(ev.num, ts, recovered);
  }

  #sampleBool(logical: boolean, ts: number, recovered: boolean): DeviceMessage[] {
    const out: DeviceMessage[] = [];
    if (this.#accepted === null || recovered) {
      this.#accepted = logical;
      this.#pending = null;
      out.push(this.#msg(this.#action(logical), ts));
    } else if (logical === this.#accepted) {
      this.#pending = null;
    } else {
      if (this.#pending === null || this.#pending.value !== logical) this.#pending = { value: logical, since: ts };
      if (ts - this.#pending.since >= this.point.debounceMs) {
        this.#accepted = logical;
        this.#pending = null;
        out.push(this.#msg(this.#action(logical), ts));
      }
    }
    if (out.length === 0) return this.#heartbeat(ts);
    return out;
  }

  #sampleValue(v: number, ts: number, recovered: boolean): DeviceMessage[] {
    const out: DeviceMessage[] = [];
    // Apres un defaut, la mesure seule ne ramene pas l'etat a normal si le PSIM n'a pas de seuil : on l'annonce.
    if (recovered) out.push(this.#msg({ event: 'restored' }, ts));
    const last = this.#lastValue;
    const p = this.point;
    let emit = false;
    if (last === null || recovered) {
      emit = true;
    } else {
      const moved = p.deadband > 0 ? Math.abs(v - last) >= p.deadband : v !== last;
      if (moved && ts - this.#lastValueTs >= p.minIntervalMs) emit = true;
      else if (p.heartbeatMs > 0 && ts - this.#lastEmitTs >= p.heartbeatMs) emit = true; // rafraichissement = signe de vie
    }
    if (emit) {
      this.#lastValue = v;
      this.#lastValueTs = ts;
      out.push(this.#msg({ value: v }, ts));
    }
    return out;
  }

  #heartbeat(ts: number): DeviceMessage[] {
    const hb = this.point.heartbeatMs;
    if (hb > 0 && ts - this.#lastEmitTs >= hb) return [this.#msg({ event: 'heartbeat' }, ts)];
    return [];
  }

  #action(logical: boolean): Action {
    return (logical ? this.point.onTrue : this.point.onFalse) ?? { event: 'clear' };
  }

  #msg(body: Action | { value: number }, ts: number): DeviceMessage {
    this.#seq++;
    this.#lastEmitTs = ts;
    const t = Math.trunc(ts);
    return { ...body, ts: t, msgId: `${this.point.id}-${t}-${this.#seq}` };
  }
}
