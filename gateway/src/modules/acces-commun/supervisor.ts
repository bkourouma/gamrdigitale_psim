/**
 * Superviseur d'UN controleur d'acces : porte l'etat (en ligne, hors ligne, derive d'horloge, etats des portes) et fabrique
 * tous les messages vers le PSIM. Il ne fait AUCUN reseau, n'a AUCUN temporisateur : la marque lui dit ce qu'elle observe
 * (`alive`, `linkLost`, `passage`, `doorEvent`, `deviceTime`) et l'appelle a intervalle regulier par `tick()`.
 *
 * Regles :
 *  - une porte  "muette" ne reste JAMAIS  "fermee" : coupure signalee ou silence trop long => `{ state: 'offline' }` pour
 *    chacune de ses portes (une seule fois), apres un court delai de grace ; aucun signe de vie pour un controleur injoignable ;
 *  - un message dont `emit` renvoie `false` n'est PAS considere comme emis : ni curseur, ni memoire d'`eventId`. La marque le
 *    retentera (F8) ;
 *  - un refus n'est JAMAIS une alarme a lui seul ; `badge_denied_repeated` (pre-alarme) vient du compteur de refus.
 */
import { DenialCounter } from './denials.ts';
import type { CursorStore } from './cursor.ts';
import { createLimitedLog } from './limitedlog.ts';
import type { LimitedLog } from './limitedlog.ts';
import { CONTROLLER_ID, cleanEventId, cleanText, doorEventMessage, passageMessage, validTs } from './messages.ts';
import { emitted } from './types.ts';
import type { ControllerEventKind, DoorEventKind, Emitter, LogFn, PassageInput, PassageOutcome } from './types.ts';
import type { DeviceMessage } from '../../module.ts';

export interface Thresholds {
  /** Refus rapproches qui declenchent `badge_denied_repeated` (3 en 60 s). */
  denied: { count: number; windowS: number };
  /** Intervalle des signes de vie par porte, en secondes (60). */
  heartbeatS: number;
  /** Ecart d'horloge a partir duquel le controleur est signale (2 min). */
  driftMs: number;
  /** Intervalle de relecture de l'heure du controleur, et de repetition du defaut tant qu'il dure, en secondes (300). */
  driftRecheckS: number;
  /** Silence du controleur (aucun `alive`) au-dela duquel il est traite comme coupe (30 s). */
  silenceMs: number;
  /** Delai de grace apres une coupure avant de declarer les portes hors ligne (15 s). */
  offlineGraceMs: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  denied: { count: 3, windowS: 60 },
  heartbeatS: 60,
  driftMs: 120_000,
  driftRecheckS: 300,
  silenceMs: 30_000,
  offlineGraceMs: 15_000,
};

export type PartialThresholds = Partial<Omit<Thresholds, 'denied'>> & { denied?: Partial<Thresholds['denied']> };

export type LinkState = 'unknown' | 'online' | 'lost' | 'offline';

export interface SupervisorOptions {
  /** Identifiant PSIM du controleur (`access_controller.id`) : `^[A-Za-z0-9_-]{1,32}$`. */
  controllerId: string;
  /** No de porte (dans le controleur) -> identifiant du detecteur PSIM de cette porte. Au moins une porte. */
  doors: ReadonlyMap<number, string>;
  emit: Emitter;
  now: () => number;
  log: LogFn;
  cursors: CursorStore;
  thresholds?: PartialThresholds;
  /** Appelee une fois quand les portes viennent d'etre declarees hors ligne. Ne doit pas lever (si oui, c'est journalise). */
  onOffline?: (info: { controllerId: string; reason: string | null; since: number }) => void;
  /** Appelee quand un controleur declare hors ligne redevient joignable. */
  onOnline?: (info: { controllerId: string; offlineForMs: number }) => void;
}

/** Etat d'une porte, tel que le superviseur le deduit des evenements. */
export interface DoorSnapshot {
  doorNo: number;
  detectorId: string;
  /** `null` tant qu'aucune ouverture ni fermeture n'a ete signalee. */
  open: boolean | null;
  forced: boolean;
  held: boolean;
  tamper: boolean;
  drift: boolean;
}

export interface SupervisorState {
  controllerId: string;
  link: LinkState;
  online: boolean;
  lastAliveAt: number | null;
  /** Debut de la coupure en cours (`lost` ou `offline`). */
  lostSince: number | null;
  lostReason: string | null;
  drifting: boolean;
  /** Dernier ecart d'horloge mesure (ms, controleur moins passerelle). */
  lastDriftMs: number | null;
  doors: DoorSnapshot[];
  /** Messages acceptes par le socle / refuses par le socle (emit a renvoye false). */
  emitted: number;
  refused: number;
  /** Passages ignores (porte inconnue, donnees invalides) et doublons. */
  ignored: number;
  duplicates: number;
  /** `badge_denied_repeated` en attente de renvoi. */
  pendingRepeated: number;
}

interface DoorFlags {
  detectorId: string;
  open: boolean | null;
  forced: boolean;
  held: boolean;
  tamper: boolean;
  drift: boolean;
  /** Heure du dernier changement d'etat physique (ouverture, fermeture, forcage, maintien) : un evenement plus ancien ne la modifie pas. */
  doorTs: number;
  tamperTs: number;
  /** Derniere emission de `clock_drift` acceptee par le socle (heure de la passerelle). */
  driftSentAt: number | null;
}

/** Evenement PSIM de chaque evenement d'etat (tous presents dans EVENTS de server/sources.ts). */
const PSIM_EVENT: Readonly<Record<DoorEventKind, string>> = {
  opened: 'door_opened',
  closed: 'door_closed',
  forced: 'door_forced',
  held_open: 'door_held_open',
  held_open_end: 'door_closed',
  tamper: 'tamper',
  tamper_end: 'restored',
};

const DEDUP_RING = 4096;
const MAX_DOOR_NO = 65_535;

const posNum = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
const nonNeg = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);

export class ControllerSupervisor {
  readonly controllerId: string;
  readonly thresholds: Thresholds;
  private readonly doors = new Map<number, DoorFlags>();
  private readonly emitFn: Emitter;
  private readonly now: () => number;
  private readonly log: LogFn;
  private readonly logLimited: LimitedLog;
  private readonly cursors: CursorStore;
  private readonly denials: DenialCounter;
  private readonly onOffline: SupervisorOptions['onOffline'];
  private readonly onOnline: SupervisorOptions['onOnline'];

  private link: LinkState = 'unknown';
  private readonly createdAt: number;
  private lastAliveAt: number | null = null;
  private lostSince: number | null = null;
  private lostReason: string | null = null;
  private offlineAt: number | null = null;
  /** Portes dont `offline` est parti (un refus du socle est retente au tick suivant). */
  private readonly offlineSent = new Set<number>();
  private lastHeartbeatAt = Number.NEGATIVE_INFINITY;
  private seen = new Map<string, true>();
  /** Portes dont le `badge_denied_repeated` n'a pas pu partir : porte -> heure du refus declencheur. */
  private readonly pendingRepeated = new Map<number, number>();
  private drifting = false;
  private lastDriftMs: number | null = null;
  private lastDriftCheckAt: number | null = null;
  private driftCheckPending = true;
  private counts = { emitted: 0, refused: 0, ignored: 0, duplicates: 0 };

  constructor(opts: SupervisorOptions) {
    if (typeof opts.controllerId !== 'string' || !CONTROLLER_ID.test(opts.controllerId)) {
      throw new RangeError("identifiant de controleur invalide (1 a 32 caracteres : lettres, chiffres, _ et -)");
    }
    this.controllerId = opts.controllerId;
    this.emitFn = opts.emit;
    this.now = opts.now;
    this.log = opts.log;
    this.logLimited = createLimitedLog(opts.log, opts.now);
    this.cursors = opts.cursors;
    this.onOffline = opts.onOffline;
    this.onOnline = opts.onOnline;
    this.createdAt = opts.now();
    for (const [doorNo, detectorId] of opts.doors) {
      if (!Number.isInteger(doorNo) || doorNo < 0 || doorNo > MAX_DOOR_NO) throw new RangeError('numero de porte invalide');
      if (typeof detectorId !== 'string' || !CONTROLLER_ID.test(detectorId)) {
        throw new RangeError(`identifiant de detecteur invalide pour la porte ${doorNo} (1 a 32 caracteres : lettres, chiffres, _ et -)`);
      }
      this.doors.set(doorNo, { detectorId, open: null, forced: false, held: false, tamper: false, drift: false, doorTs: 0, tamperTs: 0, driftSentAt: null });
    }
    if (this.doors.size === 0) throw new RangeError('au moins une porte est necessaire');

    const t = opts.thresholds ?? {};
    const deniedCount = t.denied?.count;
    this.thresholds = {
      denied: {
        count: typeof deniedCount === 'number' && Number.isInteger(deniedCount) && deniedCount >= 1 ? deniedCount : DEFAULT_THRESHOLDS.denied.count,
        windowS: posNum(t.denied?.windowS, DEFAULT_THRESHOLDS.denied.windowS),
      },
      heartbeatS: posNum(t.heartbeatS, DEFAULT_THRESHOLDS.heartbeatS),
      driftMs: posNum(t.driftMs, DEFAULT_THRESHOLDS.driftMs),
      driftRecheckS: posNum(t.driftRecheckS, DEFAULT_THRESHOLDS.driftRecheckS),
      silenceMs: posNum(t.silenceMs, DEFAULT_THRESHOLDS.silenceMs),
      offlineGraceMs: nonNeg(t.offlineGraceMs, DEFAULT_THRESHOLDS.offlineGraceMs),
    };
    this.denials = new DenialCounter(this.thresholds.denied);
  }

  // --- Liaison ----------------------------------------------------------------------------------------------------

  /**
   * Preuve de vie du controleur : partie du flux d'evenements, reponse a une interrogation, reponse a la lecture de l'heure...
   * A appeler a CHAQUE octet utile recu. Si le controleur etait hors ligne (ou si c'est la premiere fois), il est en ligne et
   * chaque porte recoit tout de suite un `heartbeat`. Apres une simple coupure breve (sans `offline`), rien n'est emis.
   */
  alive(): void {
    const t = this.now();
    const was = this.link;
    const first = this.lastAliveAt === null;
    this.lastAliveAt = t;
    if (was === 'online') return;
    this.link = 'online';
    this.driftCheckPending = true; // a chaque reconnexion, la marque relit l'heure du controleur
    if (was === 'lost' && !first) {
      this.logLimited('back', 'info', `controleur ${this.controllerId} : liaison retablie avant la fin du delai de grace`);
      this.lostSince = null;
      this.lostReason = null;
      return;
    }
    const offlineFor = this.offlineAt === null ? 0 : Math.max(0, t - this.offlineAt);
    this.lostSince = null;
    this.lostReason = null;
    this.offlineAt = null;
    this.offlineSent.clear();
    this.heartbeatAll(t);
    if (was === 'offline') {
      this.logLimited('online', 'info', `controleur ${this.controllerId} : de nouveau joignable`);
      this.callback(() => this.onOnline?.({ controllerId: this.controllerId, offlineForMs: offlineFor }));
    }
  }

  /**
   * La marque signale une coupure (flux ferme, hote injoignable). Les portes passent hors ligne apres `offlineGraceMs` SANS
   * retour (verifie par `tick()`), une seule fois ; `{ immediate: true }` supprime le delai de grace. Un nouvel appel pendant la
   * coupure ne repousse pas l'echeance. `reason` est nettoye et borne avant tout journal.
   */
  linkLost(reason?: unknown, opts?: { immediate?: boolean }): void {
    const t = this.now();
    if (this.link === 'offline') return;
    if (this.link !== 'lost') {
      this.link = 'lost';
      this.lostSince = t;
      this.lostReason = cleanText(reason, 120);
      this.logLimited('lost', 'warn', `controleur ${this.controllerId} : liaison perdue${this.lostReason ? ` (${this.lostReason})` : ''}`);
    }
    if (opts?.immediate === true) this.goOffline(t);
  }

  /**
   * A appeler a intervalle regulier (1 s convient). Pas de temporisateur ici : tout part d'ici.
   *  1. controleur muet depuis plus de `silenceMs` => traite comme une coupure (offline apres la grace) ;
   *  2. coupure sans retour depuis `offlineGraceMs` => `offline` pour chaque porte (une fois) ;
   *  3. en ligne : un `heartbeat` par porte toutes les `heartbeatS` secondes ;
   *  4. renvoi de ce que le socle avait refuse (`offline`, `badge_denied_repeated`, `clock_drift`) ;
   *  5. ecriture groupee des curseurs.
   */
  tick(): void {
    const t = this.now();
    // Horloge revenue en arriere : on repart de maintenant plutot que d'attendre un delai qui ne vient plus.
    if (this.lastAliveAt !== null && t < this.lastAliveAt) this.lastAliveAt = t;
    if (this.lostSince !== null && t < this.lostSince) this.lostSince = t;
    if (t < this.lastHeartbeatAt) this.lastHeartbeatAt = Number.NEGATIVE_INFINITY;

    if (this.link === 'online' && this.lastAliveAt !== null && t - this.lastAliveAt > this.thresholds.silenceMs) {
      this.link = 'lost';
      this.lostSince = this.lastAliveAt + this.thresholds.silenceMs;
      this.lostReason = 'aucun signe de vie';
      this.logLimited('silent', 'warn', `controleur ${this.controllerId} : muet depuis plus de ${Math.round(this.thresholds.silenceMs / 1000)} s, traite comme une coupure`);
    } else if (this.link === 'unknown' && t - this.createdAt > this.thresholds.silenceMs) {
      this.link = 'lost';
      this.lostSince = this.createdAt + this.thresholds.silenceMs;
      this.lostReason = 'jamais joint';
      this.logLimited('silent', 'warn', `controleur ${this.controllerId} : aucun signe de vie depuis le demarrage, traite comme une coupure`);
    }
    if (this.link === 'lost' && this.lostSince !== null && t - this.lostSince >= this.thresholds.offlineGraceMs) this.goOffline(t);
    if (this.link === 'offline' && this.offlineSent.size < this.doors.size) this.sendOffline();

    if (this.link === 'online') {
      if (t - this.lastHeartbeatAt >= this.thresholds.heartbeatS * 1000) this.heartbeatAll(t);
      if (this.drifting) this.emitDrift(t);
      for (const [doorNo, ts] of [...this.pendingRepeated]) this.sendRepeated(doorNo, ts);
    }
    this.cursors.tick();
  }

  /** Ecrit les curseurs sur le disque tout de suite (arret du module). */
  flush(): void {
    this.cursors.flush();
  }

  // --- Passages ---------------------------------------------------------------------------------------------------

  /**
   * Un passage (badge, code, empreinte, visage, bouton, ouverture a distance). Dit a la marque ce qu'il est devenu :
   * `sent`, `duplicate` (meme `eventId` deja emis), `refused` (le socle n'a pas mis le message en file : A RETENTER, le curseur
   * n'avance pas) ou `ignored` (porte inconnue, donnees inutilisables : inutile de retenter).
   * Un refus alimente le compteur ; au seuil, `badge_denied_repeated` part (heure du refus declencheur).
   */
  submit(p: PassageInput): PassageOutcome {
    const door = this.doors.get(p?.doorNo);
    if (!door) {
      this.counts.ignored++;
      this.logLimited(`door:${String(p?.doorNo).slice(0, 12)}`, 'warn', `controleur ${this.controllerId} : passage pour une porte inconnue (${cleanText(p?.doorNo, 12) ?? '?'}), ignore`);
      return 'ignored';
    }
    const eventId = cleanEventId(p.eventId);
    if (eventId === null) {
      this.counts.ignored++;
      this.logLimited('badevent', 'warn', `controleur ${this.controllerId} : passage sans identifiant d'evenement exploitable, ignore`);
      return 'ignored';
    }
    if (this.seen.has(eventId)) {
      this.counts.duplicates++;
      this.advanceCursor(p);
      return 'duplicate';
    }
    let msg: DeviceMessage;
    try {
      msg = passageMessage(this.controllerId, { ...p, eventId });
    } catch (err) {
      this.counts.ignored++;
      this.logLimited('badpassage', 'warn', `controleur ${this.controllerId} : passage invalide ignore (${err instanceof Error ? err.message : 'erreur'})`);
      return 'ignored';
    }
    if (!this.send(door.detectorId, msg)) return 'refused';
    this.remember(eventId);
    this.advanceCursor(p);
    if (msg.access?.result === 'denied' && this.denials.record(p.doorNo, p.ts)) this.sendRepeated(p.doorNo, p.ts);
    return 'sent';
  }

  /** Comme `submit`, en booleen : vrai si le message est en file (ou l'etait deja : doublon), faux sinon. */
  passage(p: PassageInput): boolean {
    const outcome = this.submit(p);
    return outcome === 'sent' || outcome === 'duplicate';
  }

  private advanceCursor(p: PassageInput): void {
    if (p.cursor !== undefined && p.cursor !== null) this.cursors.set(this.controllerId, p.cursor, p.ts);
  }

  private remember(eventId: string): void {
    this.seen.set(eventId, true);
    if (this.seen.size > DEDUP_RING) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
  }

  private sendRepeated(doorNo: number, ts: number): void {
    const door = this.doors.get(doorNo);
    if (!door) return;
    if (this.sendState(door, doorNo, 'denied_repeated', 'badge_denied_repeated', ts)) this.pendingRepeated.delete(doorNo);
    else this.pendingRepeated.set(doorNo, ts);
  }

  // --- Evenements d'etat ------------------------------------------------------------------------------------------

  /**
   * Evenement d'etat d'une porte. Rend vrai si le message est en file (ou s'il n'y avait rien a envoyer), faux s'il est refuse
   * par le socle ou si la porte est inconnue. Les etats actifs (forcee, maintenue, sabotage) sont memorises pour qu'une fin de
   * sabotage ou de derive d'horloge n'envoie pas `restored` sur une porte encore en alarme. Un evenement plus ancien que le
   * dernier changement connu est transmis mais ne modifie pas les etats memorises (recuperation F8 dans le desordre).
   * `ts` invalide : l'heure de la passerelle est utilisee.
   */
  doorEvent(doorNo: number, kind: DoorEventKind, ts: number, idPart?: string): boolean {
    const door = this.doors.get(doorNo);
    if (!door) {
      this.counts.ignored++;
      this.logLimited(`door:${String(doorNo).slice(0, 12)}`, 'warn', `controleur ${this.controllerId} : evenement pour une porte inconnue (${cleanText(doorNo, 12) ?? '?'}), ignore`);
      return false;
    }
    if (!Object.hasOwn(PSIM_EVENT, kind)) {
      this.counts.ignored++;
      this.logLimited('badkind', 'warn', `controleur ${this.controllerId} : nature d'evenement inconnue, ignoree`);
      return false;
    }
    let when = ts;
    if (!validTs(ts)) {
      when = Math.trunc(this.now());
      this.logLimited('badts', 'warn', `controleur ${this.controllerId} : heure d'evenement invalide, heure de la passerelle utilisee`);
    }
    const applied = this.applyFlags(door, kind, when);
    // Fin de sabotage : jamais de retour a la normale sur une porte encore forcee, maintenue ouverte ou en derive d'horloge.
    if (kind === 'tamper_end' && (door.forced || door.held || door.drift)) return true;
    // Evenement de fin plus ancien qu'un changement deja connu (desordre) : il ne doit pas effacer l'alarme en cours.
    if (!applied && ((kind === 'tamper_end' && door.tamper) || ((kind === 'closed' || kind === 'held_open_end') && (door.forced || door.held)))) return true;
    return this.sendState(door, doorNo, kind, PSIM_EVENT[kind], when, idPart);
  }

  /** Evenement du boitier (sabotage et fin de sabotage) : applique a toutes les portes. Vrai si tout est en file. */
  controllerEvent(kind: ControllerEventKind, ts: number, idPart?: string): boolean {
    if (kind !== 'tamper' && kind !== 'tamper_end') return false;
    let all = true;
    for (const doorNo of this.doors.keys()) if (!this.doorEvent(doorNo, kind, ts, idPart)) all = false;
    return all;
  }

  /** Met a jour les etats memorises. Faux si l'evenement est plus ancien que le dernier changement connu (rien n'est modifie). */
  private applyFlags(door: DoorFlags, kind: DoorEventKind, ts: number): boolean {
    if (kind === 'tamper' || kind === 'tamper_end') {
      if (ts < door.tamperTs) return false;
      door.tamperTs = ts;
      door.tamper = kind === 'tamper';
      return true;
    }
    if (ts < door.doorTs) return false;
    door.doorTs = ts;
    switch (kind) {
      case 'opened':
        door.open = true;
        break;
      case 'closed':
        door.open = false;
        door.forced = false;
        door.held = false;
        break;
      case 'forced':
        door.open = true;
        door.forced = true;
        break;
      case 'held_open':
        door.open = true;
        door.held = true;
        break;
      case 'held_open_end':
        door.open = false;
        door.held = false;
        break;
    }
    return true;
  }

  /** Fabrique et envoie un message d'etat ; une heure inutilisable (jamais en production) est journalisee et le message abandonne. */
  private sendState(door: DoorFlags, doorNo: number, kind: string, psimEvent: string, ts: number, idPart?: string): boolean {
    let msg: DeviceMessage;
    try {
      msg = doorEventMessage({ controllerId: this.controllerId, doorNo, kind, psimEvent, ts, idPart });
    } catch (err) {
      this.counts.ignored++;
      this.logLimited('badstate', 'error', `controleur ${this.controllerId} : message d'etat impossible (${err instanceof Error ? err.message : 'erreur'})`);
      return false;
    }
    return this.send(door.detectorId, msg);
  }

  // --- Horloge ----------------------------------------------------------------------------------------------------

  /**
   * Controle d'horloge (PRD 8.7). `deviceMs` : heure lue dans le controleur ; `receivedAt` : instant de la lecture (heure de
   * la passerelle, `now()` par defaut). Ecart absolu superieur a `driftMs` : `clock_drift` pour chaque porte (une fois, puis de
   * nouveau toutes les `driftRecheckS` tant que ca dure). Retour sous `driftMs / 2` : `restored` pour chaque porte, SAUF celles qui ont
   * encore une alarme ou un defaut propre (forcee, maintenue ouverte, sabotage) : leur retour a la normale viendra de leur
   * propre evenement (`door_closed`...). Entre `driftMs / 2` et `driftMs` rien ne change (hysteresis).
   * Rend l'ecart signe `deviceMs - receivedAt` (ms), ou `null` si l'heure est aberrante (NaN, nulle, negative, infinie) : ignoree.
   */
  deviceTime(deviceMs: number, receivedAt: number = this.now()): number | null {
    if (typeof deviceMs !== 'number' || !Number.isFinite(deviceMs) || deviceMs <= 0 || deviceMs > 8.64e15) {
      this.logLimited('badclock', 'warn', `controleur ${this.controllerId} : heure du controleur aberrante, ignoree`);
      return null;
    }
    const received = typeof receivedAt === 'number' && Number.isFinite(receivedAt) ? receivedAt : this.now();
    const t = this.now();
    const diff = deviceMs - received;
    this.lastDriftMs = diff;
    this.lastDriftCheckAt = t;
    this.driftCheckPending = false;
    const abs = Math.abs(diff);
    if (abs > this.thresholds.driftMs) {
      if (!this.drifting) {
        this.drifting = true;
        for (const d of this.doors.values()) {
          d.drift = true;
          d.driftSentAt = null;
        }
        this.logLimited('drift', 'warn', `controleur ${this.controllerId} : horloge deregle de ${Math.round(abs / 1000)} s`);
      }
      this.emitDrift(t);
    } else if (this.drifting) {
      if (abs <= this.thresholds.driftMs / 2) this.endDrift(t);
      else this.emitDrift(t);
    }
    return diff;
  }

  /**
   * Vrai quand la marque doit relire l'heure du controleur (puis appeler `deviceTime`) : a chaque (re)connexion, puis toutes
   * les `driftRecheckS` secondes. Reste vrai tant que `deviceTime` n'a pas ete appelee. Toujours faux hors ligne.
   */
  driftDue(): boolean {
    if (this.link !== 'online') return false;
    if (this.driftCheckPending || this.lastDriftCheckAt === null) return true;
    const t = this.now();
    return t < this.lastDriftCheckAt || t - this.lastDriftCheckAt >= this.thresholds.driftRecheckS * 1000;
  }

  private emitDrift(t: number): void {
    for (const [doorNo, door] of this.doors) {
      const at = door.driftSentAt;
      if (at !== null && t >= at && t - at < this.thresholds.driftRecheckS * 1000) continue;
      if (this.sendState(door, doorNo, 'clock_drift', 'clock_drift', Math.trunc(t))) door.driftSentAt = t;
    }
  }

  private endDrift(t: number): void {
    this.drifting = false;
    this.logLimited('driftend', 'info', `controleur ${this.controllerId} : horloge de nouveau exacte`);
    for (const [doorNo, door] of this.doors) {
      door.drift = false;
      door.driftSentAt = null;
      if (door.forced || door.held || door.tamper) continue; // alarme propre a la porte : on ne la masque pas
      this.sendState(door, doorNo, 'clock_ok', 'restored', Math.trunc(t));
    }
  }

  // --- Emission ---------------------------------------------------------------------------------------------------

  private heartbeatAll(t: number): void {
    this.lastHeartbeatAt = t;
    for (const door of this.doors.values()) this.send(door.detectorId, { event: 'heartbeat' });
  }

  private goOffline(t: number): void {
    this.link = 'offline';
    this.offlineAt = t;
    this.offlineSent.clear();
    this.logLimited('offline', 'warn', `controleur ${this.controllerId} : portes declarees hors ligne`);
    this.sendOffline();
    const info = { controllerId: this.controllerId, reason: this.lostReason, since: this.lostSince ?? t };
    this.callback(() => this.onOffline?.(info));
  }

  private sendOffline(): void {
    for (const [doorNo, door] of this.doors) {
      if (this.offlineSent.has(doorNo)) continue;
      if (this.send(door.detectorId, { state: 'offline' })) this.offlineSent.add(doorNo);
    }
  }

  /** Envoi au socle ; ne leve jamais. Vrai si le message est en file. */
  private send(detectorId: string, msg: DeviceMessage): boolean {
    let ok: boolean;
    try {
      ok = emitted(this.emitFn(detectorId, msg));
    } catch (err) {
      ok = false;
      this.logLimited('emitthrow', 'error', `controleur ${this.controllerId} : envoi en echec (${err instanceof Error ? cleanText(err.message, 100) : 'erreur'})`);
    }
    if (ok) this.counts.emitted++;
    else {
      this.counts.refused++;
      this.logLimited('refused', 'warn', `controleur ${this.controllerId} : message refuse par la passerelle (sera retente si possible)`);
    }
    return ok;
  }

  private callback(fn: () => void): void {
    try {
      fn();
    } catch {
      this.logLimited('callback', 'error', `controleur ${this.controllerId} : le rappel du module a leve une exception`);
    }
  }

  // --- Etat -------------------------------------------------------------------------------------------------------

  /** Etat lisible (essais et journaux). Ne contient aucun nom ni numero de badge. */
  state(): SupervisorState {
    return {
      controllerId: this.controllerId,
      link: this.link,
      online: this.link === 'online',
      lastAliveAt: this.lastAliveAt,
      lostSince: this.lostSince,
      lostReason: this.lostReason,
      drifting: this.drifting,
      lastDriftMs: this.lastDriftMs,
      doors: [...this.doors].map(([doorNo, d]) => ({ doorNo, detectorId: d.detectorId, open: d.open, forced: d.forced, held: d.held, tamper: d.tamper, drift: d.drift })),
      emitted: this.counts.emitted,
      refused: this.counts.refused,
      ignored: this.counts.ignored,
      duplicates: this.counts.duplicates,
      pendingRepeated: this.pendingRepeated.size,
    };
  }
}
