/**
 * Un controleur d'acces Dahua suivi par le module : flux d'evenements (Digest), reconnexion, lecture de l'heure, etat des portes,
 * recuperation des passages manquants (F8) et pilote d'ouverture a distance. Toute la logique de liaison (hors ligne, grace,
 * signes de vie, derive d'horloge, compteur de refus, messages) est dans le `ControllerSupervisor` du code commun : ici on ne fait
 * que lui dire ce que le controleur donne.
 *
 * Regles de surete :
 *  - UN SEUL flux par controleur, jamais deux ; reconnexion a attente croissante (`reconnect`), remise a zero apres une
 *    connexion stable ; identifiants refuses = une seule tentative puis 5 minutes d'attente (barriere commune flux + requetes) ;
 *  - une seule activite HTTP « de fond » a la fois (heure, etat des portes, recuperation) : jamais de rafale sur le compte ;
 *  - les passages du flux arrives PENDANT une recuperation sont gardes puis emis apres elle, dans l'ordre des n° d'enregistrement ;
 *  - le curseur ne depasse jamais un passage que le socle a refuse : tant que la recuperation n'est pas complete (« trou »), les
 *    passages en direct partent SANS curseur, et la recuperation repart du dernier curseur sur ;
 *  - un evenement du flux sans n° d'enregistrement (certains terminaux) est complete par la memoire du controleur ; a defaut, au
 *    bout de quelques secondes, il part avec un identifiant synthetique (deterministe) ;
 *  - aucun badge, nom ni mot de passe dans les journaux ; aucune exception ne sort.
 */
import { openEventStream } from '../../../../server/dahua.ts';
import { ControllerSupervisor, createLimitedLog } from '../acces-commun/commun.ts';
import type { CursorStore, Emitter, LogFn, PassageInput } from '../acces-commun/commun.ts';
import type { ControllerConfig, Thresholds } from './config.ts';
import { DahuaDoorDriver } from './driver.ts';
import { AuthGate, DahuaAuthError, DahuaHttp, DahuaHttpError } from './http.ts';
import { parseCurrentTime, parseDoorStatus, parsePart, translateEvent } from './protocol.ts';
import type { TranslateContext, Translation } from './protocol.ts';
import { runRecovery } from './recovery.ts';
import type { RecoveryResult } from './recovery.ts';

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface ControllerDeps {
  cfg: ControllerConfig;
  thresholds: Thresholds;
  reconnect: { minMs: number; maxMs: number };
  emit: Emitter;
  now: () => number;
  log: LogFn;
  cursors: CursorStore;
  /** Essais : ouverture du flux (par defaut `openEventStream` de server/dahua.ts). */
  open?: typeof openEventStream;
  timers?: Timers;
  httpTimeoutMs?: number;
}

/** Evenement du flux sans n° d'enregistrement : delai laisse a la memoire du controleur pour le fournir. */
export const ORPHAN_GRACE_MS = 3000;
const ORPHAN_QUICK_MS = 300;
const ORPHAN_RETRY_MS = 1000;
const ORPHAN_MATCH_MS = 2000;
const MAX_ORPHANS = 200;
const MAX_BUFFER = 2000;
/** Au plus ce temps d'attente des passages directs derriere la premiere recuperation. */
const HOLD_MAX_MS = 15_000;
const MAX_RETRY_DOOR = 100;
const RETRY_DOOR_MAX_AGE_MS = 10 * 60_000;
const RECOVERY_RETRY_MIN_MS = 2000;
const RECOVERY_RETRY_MAX_MS = 60_000;
const TIME_RETRY_MS = 10_000;
const RECENT_MAX = 256;
const RECENT_MAX_AGE_MS = 120_000;

interface Orphan {
  passage: PassageInput;
  at: number;
}

interface RetryState {
  doorNo: number | null;
  kind: Extract<Translation, { kind: 'door' }>['doorKind'] | Extract<Translation, { kind: 'controller' }>['ctlKind'];
  ts: number;
  idPart: string;
  at: number;
  tries: number;
}

type Phase = 'idle' | 'connecting' | 'connected' | 'waiting' | 'stopped';

export class AccessController {
  readonly id: string;
  readonly supervisor: ControllerSupervisor;
  readonly driver: DahuaDoorDriver;
  readonly http: DahuaHttp;
  readonly gate: AuthGate;
  private readonly cfg: ControllerConfig;
  private readonly deps: ControllerDeps;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly logLimited: ReturnType<typeof createLimitedLog>;
  private readonly open: typeof openEventStream;

  private phase: Phase = 'idle';
  private generation = 0;
  private stream: { ready: Promise<void>; stop: () => void } | null = null;
  private retryTimer: unknown = null;
  private quickTimer: unknown = null;
  private failures = 0;
  private connectedAt: number | null = null;
  private lastPartAt = 0;
  private firstPart = true;
  /** Connexions ouvertes depuis le demarrage (essais). */
  connections = 0;

  // travail de fond
  private working: Promise<void> | null = null;
  private wantTime = false;
  private timeRetryAt = 0;
  private wantDoors = false;
  private doorStatusSupported = true;
  private wantRecovery = false;
  private recoveryReason: 'reconnect' | 'quick' = 'reconnect';
  private recoveryNotBefore = 0;
  private recoveryFailures = 0;
  private recoverySupported = true;
  private recovering = false;
  /** Vrai de la premiere partie du flux a la fin de la premiere passe de recuperation : les passages directs attendent leur tour. */
  private holding = false;
  private gap = false;
  private floor: number | null = null;
  private driftMs = 0;
  private buffer: PassageInput[] = [];
  private orphans: Orphan[] = [];
  private lastQuickAt = 0;
  private recent: { doorNo: number; ts: number; at: number }[] = [];
  private retryDoors: RetryState[] = [];
  /** Nombre d'evenements d'etat recus par porte : une lecture d'etat depassee par un evenement plus recent est ecartee. */
  private doorSeq = new Map<number, number>();

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.cfg = deps.cfg;
    this.id = deps.cfg.id;
    this.now = deps.now;
    this.timers = deps.timers ?? realTimers;
    this.open = deps.open ?? openEventStream;
    this.logLimited = createLimitedLog(deps.log, deps.now);
    this.gate = new AuthGate(deps.now);
    this.http = new DahuaHttp({ host: deps.cfg.host, port: deps.cfg.port, username: deps.cfg.username, password: deps.cfg.password }, { gate: this.gate, timeoutMs: deps.httpTimeoutMs });
    this.driver = new DahuaDoorDriver(this.http, { remoteUserId: deps.cfg.remoteUserId, log: deps.log });
    const t = deps.thresholds;
    this.supervisor = new ControllerSupervisor({
      controllerId: deps.cfg.id,
      doors: deps.cfg.doors,
      emit: deps.emit,
      now: deps.now,
      log: deps.log,
      cursors: deps.cursors,
      thresholds: {
        denied: { count: t.deniedCount, windowS: t.deniedWindowS },
        heartbeatS: t.heartbeatS,
        driftMs: t.clockDriftMs,
        silenceMs: t.silenceMs,
        offlineGraceMs: t.offlineGraceMs,
      },
    });
  }

  // --- Cycle de vie -------------------------------------------------------------------------------------------------------

  start(): void {
    if (this.phase !== 'idle') return;
    this.connect();
  }

  /** Arret propre : flux, requetes, minuteries, travail en cours, curseurs ecrits. Idempotent. */
  async stop(): Promise<void> {
    if (this.phase === 'stopped') return;
    this.phase = 'stopped';
    this.generation++;
    this.cancelTimer('retry');
    this.cancelTimer('quick');
    try {
      this.stream?.stop();
    } catch {
      // deja ferme
    }
    this.stream = null;
    this.http.stop();
    try {
      await this.working;
    } catch {
      // le travail de fond ne leve pas ; par prudence
    }
    this.supervisor.flush();
  }

  /** Appel regulier (1 s) du module. */
  tick(): void {
    if (this.phase === 'stopped') return;
    try {
      this.supervisor.tick();
      const t = this.now();
      if (this.phase === 'connected' && t - this.lastPartAt > this.deps.thresholds.silenceMs) this.streamEnded('flux muet : aucun signe de vie', false, this.generation);
      if (this.phase === 'connected') {
        if (this.supervisor.driftDue() && !this.wantTime && t >= this.timeRetryAt) this.wantTime = true;
        if (this.holding && this.connectedAt !== null && t - this.connectedAt > HOLD_MAX_MS) this.drainBuffer();
        this.retryDoorEvents();
        this.ageOrphans();
        this.kick();
      }
    } catch (err) {
      this.logLimited('tick', 'error', `controleur ${this.id} : erreur interne (${err instanceof Error ? err.message.slice(0, 80) : 'erreur'})`);
    }
  }

  /** Vrai tant que du travail de fond est en cours ou demande (essais). */
  busy(): boolean {
    return this.working !== null || this.workPending();
  }

  state() {
    return { phase: this.phase, failures: this.failures, connections: this.connections, gap: this.gap, orphans: this.orphans.length, supervisor: this.supervisor.state() };
  }

  // --- Flux ---------------------------------------------------------------------------------------------------------------

  private connect(): void {
    if (this.phase === 'stopped' || this.stream !== null) return;
    const wait = this.gate.remainingMs();
    if (wait > 0) {
      this.phase = 'waiting';
      this.scheduleReconnect(wait);
      return;
    }
    this.phase = 'connecting';
    const generation = ++this.generation;
    this.connections++;
    this.firstPart = true;
    let stream: { ready: Promise<void>; stop: () => void };
    try {
      stream = this.open(
        { host: this.cfg.host, port: this.cfg.port, username: this.cfg.username, password: this.cfg.password },
        {
          onPart: (body) => this.onPart(body, generation),
          onEnd: (reason, authRefused) => this.streamEnded(reason, authRefused === true, generation),
        },
      );
    } catch (err) {
      this.streamEnded(err instanceof Error ? err.message : 'ouverture impossible', err instanceof DahuaAuthError, generation);
      return;
    }
    this.stream = stream;
  }

  private onPart(body: string, generation: number): void {
    if (generation !== this.generation || this.phase === 'stopped') return;
    try {
      const t = this.now();
      this.lastPartAt = t;
      if (this.firstPart) {
        this.firstPart = false;
        this.phase = 'connected';
        this.connectedAt = t;
        this.gap = this.recoverySupported;
        this.wantTime = true;
        this.wantRecovery = this.recoverySupported;
        this.recoveryReason = 'reconnect';
        this.recoveryNotBefore = 0;
        this.wantDoors = this.doorStatusSupported;
        this.holding = this.recoverySupported;
      }
      this.supervisor.alive();
      const ev = parsePart(body);
      if (ev) this.handle(translateEvent(ev, this.translateContext()));
      this.kick();
    } catch (err) {
      this.logLimited('part', 'error', `controleur ${this.id} : evenement non traite (${err instanceof Error ? err.message.slice(0, 80) : 'erreur'})`);
    }
  }

  private streamEnded(reason: string, authRefused: boolean, generation: number): void {
    if (generation !== this.generation || this.phase === 'stopped') return;
    this.generation++; // les rappels tardifs de ce flux sont ignores
    try {
      this.stream?.stop();
    } catch {
      // deja ferme
    }
    this.stream = null;
    const t = this.now();
    const stable = this.connectedAt !== null && t - this.connectedAt >= this.stableMs();
    if (stable) this.failures = 0;
    this.connectedAt = null;
    this.phase = 'waiting';
    this.drainBuffer();
    this.supervisor.linkLost(reason);
    if (authRefused) this.gate.block();
    const backoff = Math.min(this.deps.reconnect.maxMs, this.deps.reconnect.minMs * 2 ** Math.min(this.failures, 20));
    this.failures++;
    const delay = Math.max(backoff, this.gate.remainingMs());
    this.logLimited('end', 'warn', `controleur ${this.id} : flux d'evenements ferme (${reason.slice(0, 120)}) ; nouvel essai dans ${Math.round(delay / 100) / 10} s`);
    // Le travail de fond en cours est inutile sans liaison : il s'arrete de lui-meme (voir canWork).
    this.scheduleReconnect(delay);
  }

  /** Une connexion qui a dure ce temps est « stable » : l'attente repart de la valeur minimale. */
  private stableMs(): number {
    return Math.max(this.deps.reconnect.minMs * 5, 2000);
  }

  private scheduleReconnect(delay: number): void {
    this.cancelTimer('retry');
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private cancelTimer(which: 'retry' | 'quick'): void {
    const handle = which === 'retry' ? this.retryTimer : this.quickTimer;
    if (handle !== null) this.timers.clearTimeout(handle);
    if (which === 'retry') this.retryTimer = null;
    else this.quickTimer = null;
  }

  // --- Traduction des evenements ------------------------------------------------------------------------------------------

  private translateContext(): TranslateContext {
    return { utcOffsetMin: this.cfg.utcOffsetMin, receivedAt: this.now(), doorBase: this.cfg.doorBase, doorNos: [...this.cfg.doors.keys()] };
  }

  private handle(t: Translation): void {
    switch (t.kind) {
      case 'passage':
        if (t.recNo === null) this.onOrphan(t.passage);
        else this.onLivePassage(t.passage);
        break;
      case 'door':
        if (!this.cfg.doors.has(t.doorNo)) {
          this.logLimited('unknowndoor', 'warn', `controleur ${this.id} : evenement pour une porte non declaree (${t.doorNo}), ignore`);
          break;
        }
        this.doorSeq.set(t.doorNo, (this.doorSeq.get(t.doorNo) ?? 0) + 1);
        if (!this.supervisor.doorEvent(t.doorNo, t.doorKind, t.ts, t.idPart)) this.retryLater({ doorNo: t.doorNo, kind: t.doorKind, ts: t.ts, idPart: t.idPart, at: this.now(), tries: 0 });
        break;
      case 'controller':
        if (!this.supervisor.controllerEvent(t.ctlKind, t.ts, t.idPart)) this.retryLater({ doorNo: null, kind: t.ctlKind, ts: t.ts, idPart: t.idPart, at: this.now(), tries: 0 });
        break;
      default:
        if (t.reason.startsWith('alarme de contrainte')) this.logLimited('duress', 'warn', `controleur ${this.id} : ${t.reason} : ignoree`);
        break;
    }
  }

  private retryLater(r: RetryState): void {
    if (this.retryDoors.length >= MAX_RETRY_DOOR) this.retryDoors.shift();
    this.retryDoors.push(r);
  }

  private retryDoorEvents(): void {
    if (this.retryDoors.length === 0) return;
    const t = this.now();
    const pending = this.retryDoors;
    this.retryDoors = [];
    for (const r of pending) {
      if (t - r.at > RETRY_DOOR_MAX_AGE_MS || r.tries >= 20) continue;
      r.tries++;
      const ok =
        r.doorNo === null
          ? this.supervisor.controllerEvent(r.kind as 'tamper' | 'tamper_end', r.ts, r.idPart)
          : this.supervisor.doorEvent(r.doorNo, r.kind as Parameters<ControllerSupervisor['doorEvent']>[1], r.ts, r.idPart);
      if (!ok) this.retryDoors.push(r);
    }
  }

  // --- Passages -----------------------------------------------------------------------------------------------------------

  private noteRecent(p: PassageInput): void {
    const t = this.now();
    this.recent.push({ doorNo: p.doorNo, ts: p.ts, at: t });
    while (this.recent.length > RECENT_MAX || (this.recent.length > 0 && t - this.recent[0]!.at > RECENT_MAX_AGE_MS)) this.recent.shift();
  }

  /** Passage du flux AVEC n° d'enregistrement. */
  private onLivePassage(p: PassageInput): void {
    if ((this.recovering || this.holding) && this.buffer.length < MAX_BUFFER) {
      this.buffer.push(p);
      return;
    }
    this.submitLive(p);
  }

  private submitLive(p: PassageInput): void {
    const input: PassageInput = this.gap ? { ...p, cursor: undefined } : p;
    const outcome = this.supervisor.submit(input);
    if (outcome === 'refused') {
      // Le socle n'a pas mis ce passage en file : pas de curseur au-dela, et la memoire du controleur le redonnera.
      this.gap = true;
      this.wantRecovery = this.recoverySupported;
      this.recoveryReason = 'reconnect';
      this.recoveryNotBefore = Math.min(this.recoveryNotBefore || Number.POSITIVE_INFINITY, this.now() + RECOVERY_RETRY_MIN_MS);
      this.logLimited('liverefused', 'warn', `controleur ${this.id} : un passage a ete refuse par la passerelle, il sera relu dans la memoire du controleur`);
      return;
    }
    if (outcome === 'sent') {
      this.noteRecent(p);
      if (!this.gap && p.cursor !== undefined && /^\d{1,15}$/.test(p.cursor)) {
        const n = Number(p.cursor);
        if (this.floor === null || n > this.floor) this.floor = n;
      }
    }
  }

  /** Emet les passages gardes pendant la recuperation, dans l'ordre des n° d'enregistrement. */
  private drainBuffer(): void {
    this.holding = false;
    const buffered = this.buffer.splice(0).sort((a, b) => Number(a.eventId) - Number(b.eventId));
    for (const p of buffered) this.submitLive(p);
  }

  /** Passage du flux SANS n° d'enregistrement : completer par la memoire du controleur, sinon identifiant synthetique. */
  private onOrphan(p: PassageInput): void {
    if (!this.recoverySupported) {
      this.submitLive(p);
      return;
    }
    if (this.orphans.length >= MAX_ORPHANS) {
      const oldest = this.orphans.shift();
      if (oldest) this.submitLive(oldest.passage);
    }
    this.orphans.push({ passage: p, at: this.now() });
    this.scheduleQuick(ORPHAN_QUICK_MS);
  }

  private scheduleQuick(delay: number): void {
    if (this.quickTimer !== null) return;
    this.quickTimer = this.timers.setTimeout(() => {
      this.quickTimer = null;
      if (this.orphans.length === 0 || this.phase !== 'connected') return;
      if (!this.gap && !this.wantRecovery) {
        this.wantRecovery = true;
        this.recoveryReason = 'quick';
        this.recoveryNotBefore = 0;
      }
      this.kick();
    }, delay);
  }

  /** Rapproche les evenements sans numero des passages deja envoyes (un passage envoye ne satisfait qu'un evenement). */
  private matchOrphans(): void {
    if (this.orphans.length === 0) return;
    const remaining: Orphan[] = [];
    for (const o of this.orphans) {
      const i = this.recent.findIndex((r) => r.doorNo === o.passage.doorNo && Math.abs(r.ts - o.passage.ts) <= ORPHAN_MATCH_MS);
      if (i >= 0) this.recent.splice(i, 1);
      else remaining.push(o);
    }
    this.orphans = remaining;
  }

  /** Les evenements sans numero que la memoire du controleur n'a pas confirmes partent avec leur identifiant synthetique. */
  private ageOrphans(): void {
    if (this.orphans.length === 0) return;
    const t = this.now();
    const keep: Orphan[] = [];
    for (const o of this.orphans) {
      if (t - o.at >= ORPHAN_GRACE_MS && !this.gap) this.submitLive(o.passage);
      else if (t - o.at >= ORPHAN_GRACE_MS * 10) this.submitLive(o.passage); // un « trou » qui dure : on ne retient pas indefiniment
      else keep.push(o);
    }
    this.orphans = keep;
    if (keep.length > 0 && t - this.lastQuickAt >= ORPHAN_RETRY_MS) this.scheduleQuick(0);
  }

  // --- Travail de fond ----------------------------------------------------------------------------------------------------

  private canWork(generation: number): boolean {
    return this.phase === 'connected' && generation === this.generation;
  }

  private kick(): void {
    if (this.working !== null || this.phase !== 'connected' || !this.workPending()) return;
    const generation = this.generation;
    this.working = this.work(generation)
      .catch((err: unknown) => {
        this.logLimited('work', 'error', `controleur ${this.id} : erreur interne (${err instanceof Error ? err.message.slice(0, 80) : 'erreur'})`);
      })
      .finally(() => {
        this.working = null;
        // Un travail demande pendant le precedent : on le relance tout de suite plutot que d'attendre le tick.
        if (this.phase === 'connected' && this.workPending()) this.kick();
      });
  }

  private workPending(): boolean {
    return this.wantTime || this.wantDoors || (this.wantRecovery && this.now() >= this.recoveryNotBefore);
  }

  private async work(generation: number): Promise<void> {
    for (let guard = 0; guard < 20; guard++) {
      if (!this.canWork(generation)) return;
      if (this.wantTime) {
        this.wantTime = false;
        await this.readTime();
        continue;
      }
      if (this.wantRecovery && this.now() >= this.recoveryNotBefore) {
        await this.recover(generation);
        continue;
      }
      if (this.wantDoors) {
        this.wantDoors = false;
        await this.readDoors(generation);
        continue;
      }
      return;
    }
  }

  /** Heure du controleur -> superviseur (derive d'horloge). */
  private async readTime(): Promise<void> {
    const before = this.now();
    try {
      const res = await this.http.get('/cgi-bin/global.cgi?action=getCurrentTime');
      const after = this.now();
      const ms = res.status === 200 ? parseCurrentTime(res.body, this.cfg.utcOffsetMin) : null;
      if (ms === null) {
        this.timeRetryAt = this.now() + TIME_RETRY_MS;
        this.logLimited('timebad', 'warn', `controleur ${this.id} : heure du controleur illisible`);
        return;
      }
      const diff = this.supervisor.deviceTime(ms, Math.round((before + after) / 2));
      if (diff !== null) this.driftMs = diff;
    } catch (err) {
      this.timeRetryAt = this.now() + TIME_RETRY_MS;
      this.noteHttpError('time', err);
    }
  }

  /** Etat de chaque porte au retour de la liaison (`getDoorStatus`, A QUALIFIER) : `door_opened` / `door_closed` exacts. */
  private async readDoors(generation: number): Promise<void> {
    for (const doorNo of this.cfg.doors.keys()) {
      if (!this.canWork(generation)) return;
      const seq = this.doorSeq.get(doorNo) ?? 0;
      try {
        const res = await this.http.get(`/cgi-bin/accessControl.cgi?action=getDoorStatus&channel=${doorNo}`);
        // Un evenement de cette porte est arrive pendant la lecture : il est plus recent que l'etat lu, qui est jete.
        if ((this.doorSeq.get(doorNo) ?? 0) !== seq) continue;
        if (res.status === 404 || res.status === 400) {
          this.doorStatusSupported = false;
          this.logLimited('doorstatus', 'info', `controleur ${this.id} : lecture de l'etat des portes non prise en charge, les signes de vie suffisent`);
          return;
        }
        const status = res.status === 200 ? parseDoorStatus(res.body) : null;
        // Les evenements du controleur sont dates a la SECONDE (champ UTC) : l'etat lu est date une seconde pleine plus tot, pour qu'un
        // evenement arrive pendant ou juste apres la lecture ne soit jamais pris par le PSIM pour plus ancien que cet etat.
        const ts = Math.floor((this.now() + this.driftMs) / 1000) * 1000 - 1000;
        if (status === 'open') this.supervisor.doorEvent(doorNo, 'opened', ts, 'etat');
        else if (status === 'closed') this.supervisor.doorEvent(doorNo, 'closed', ts, 'etat');
        else if (status === 'break') this.logLimited(`break:${doorNo}`, 'warn', `controleur ${this.id} : la porte ${doorNo} signale une effraction a la lecture de son etat (non rejouee)`);
      } catch (err) {
        this.noteHttpError('doors', err);
        return;
      }
    }
  }

  private async recover(generation: number): Promise<void> {
    const reason = this.recoveryReason;
    this.wantRecovery = false;
    this.recovering = true;
    this.lastQuickAt = this.now();
    let result: RecoveryResult;
    try {
      const entry = this.deps.cursors.get(this.id);
      const orphanStart = this.orphans.length > 0 ? Math.floor(Math.min(...this.orphans.map((o) => o.passage.ts)) / 1000) - 30 : undefined;
      result = await runRecovery({
        http: this.http,
        translate: () => this.translateContext(),
        submit: (p) => {
          const outcome = this.supervisor.submit(p);
          if (outcome === 'sent') this.noteRecent(p);
          return outcome;
        },
        cursor: entry,
        floor: this.floor,
        deviceNowMs: this.now() + this.driftMs,
        deferred: reason === 'reconnect',
        startSec: reason === 'quick' && entry === null ? orphanStart : undefined,
        isStopped: () => !this.canWork(generation),
        log: (key, level, text) => this.logLimited(key, level, `controleur ${this.id} : ${text}`),
      });
    } catch (err) {
      result = { status: 'failed', scanned: 0, sent: 0, duplicates: 0, ignored: 0, floor: this.floor, replayed: [], error: err instanceof Error ? err.message.slice(0, 80) : 'erreur' };
    }
    this.recovering = false;
    if (result.floor !== null && (this.floor === null || result.floor > this.floor)) this.floor = result.floor;

    switch (result.status) {
      case 'complete':
        this.gap = false;
        this.recoveryFailures = 0;
        break;
      case 'partial':
        // Borne de securite atteinte : la suite est lue au tour suivant.
        this.wantRecovery = true;
        this.recoveryReason = reason;
        this.recoveryNotBefore = 0;
        break;
      case 'unsupported':
        this.recoverySupported = false;
        this.gap = false;
        this.logLimited('unsupported', 'warn', `controleur ${this.id} : ${result.error ?? 'memoire du controleur illisible'} ; les passages manques pendant une coupure ne pourront pas etre rejoues`);
        break;
      case 'stopped':
        break;
      default: {
        // 'refused' (le socle est plein) ou 'failed' (reseau) : nouvel essai avec attente croissante.
        this.recoveryFailures++;
        const wait = Math.min(RECOVERY_RETRY_MAX_MS, RECOVERY_RETRY_MIN_MS * 2 ** Math.min(this.recoveryFailures - 1, 10));
        this.wantRecovery = true;
        this.recoveryReason = 'reconnect';
        this.recoveryNotBefore = this.now() + wait;
        this.logLimited('recoveryfail', 'warn', `controleur ${this.id} : recuperation des passages incomplete (${result.status === 'refused' ? 'passerelle pleine' : (result.error ?? 'erreur')}) ; nouvel essai dans ${Math.round(wait / 1000)} s`);
      }
    }
    // Les passages du flux arrives pendant la passe sont emis maintenant, dans l'ordre des n° d'enregistrement.
    this.drainBuffer();
    if (result.status === 'complete' || result.status === 'partial') this.matchOrphans();
    this.ageOrphans();
    if (result.replayed.length > 0) {
      this.logLimited('replayed', 'info', `controleur ${this.id} : ${result.replayed.length} passage(s) recupere(s) dans la memoire du controleur`);
    }
  }

  private noteHttpError(key: string, err: unknown): void {
    if (this.phase === 'stopped') return;
    const text = err instanceof DahuaAuthError ? 'identifiants refuses' : err instanceof DahuaHttpError ? err.message : 'erreur reseau';
    this.logLimited(`http:${key}`, 'warn', `controleur ${this.id} : requete ${key} en echec (${text})`);
  }
}
