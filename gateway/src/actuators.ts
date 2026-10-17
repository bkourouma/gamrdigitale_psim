/**
 * Pilote de commandes de la passerelle : recoit les ordres SIGNES du PSIM (topic psim/actuators/<id>/command), les verifie,
 * les fait executer par le module concerne (ModuleContext.onActuator) et accuse (topic .../ack). Specification : docs/COMMANDES.md
 * section 5 ; contrat avec les modules : docs/CONTROLE-ACCES.md section 3 ; usage : docs/PASSERELLE.md, section « actuators ».
 *
 * C'est la piece qui, au bout de la chaine, ouvre une gache ou leve une barriere : chaque decision est prise du cote de
 * l'attaquant (broker compromis, PSIM compromis, rejeu, horloge, coupure).
 *
 * Regles du recepteur, DANS CET ORDRE :
 *   1. taille <= 1024 octets, JSON objet, chaque champ au bon format       -> sinon ignore, sans accuse
 *   2. signature HMAC-SHA256 (temps constant)                               -> fausse : ignore SANS accuser (pas d'oracle), compte
 *   3. fraicheur  ts - 5 s <= maintenant <= ts + ttlS                       -> sinon accuse refused/stale
 *   4. anti-rejeu : cmdId deja vu (120 s, survit au redemarrage)            -> ni execution ni accuse (verifie AVANT la
 *                                                                              fraicheur : un ordre deja traite puis perime
 *                                                                              n'est pas accuse « stale ») ; ts anterieur au
 *                                                                              dernier ordre accepte -> refused/out_of_order
 *   5. plafonds locaux, issue de secours, action inconnue                   -> refused/not_allowed ou emergency_exit
 *   6. execution par le module (delai borne) ; retour LOCAL au repos au bout de durationS, quoi qu'il arrive ; un nouvel
 *      ordre accepte REMPLACE la temporisation en cours
 *   7. accuse signe, jamais de nouvel essai d'un ordre
 *
 * Ce fichier n'importe RIEN de server/ : la signature est refaite ici, et les essais prouvent que les deux implementations
 * s'accordent (vecteurs de docs/COMMANDES.md 5.3 et server/actuatorproto.ts). Aucun reseau dans le coeur : l'horloge, le
 * planificateur et la publication des accuses sont injectes.
 *
 * Jamais la cle, la signature ni un secret dans les journaux ; tout texte venu du reseau est assaini (clean).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { ActuatorSpec } from './config.ts';
import { clean } from './log.ts';
import type { Logger } from './log.ts';
import type { ActuatorHandler, ActuatorOutcome, ActuatorRequest } from './module.ts';

// ------------------------------------------------------------------------------------------------------ protocole

export const MAX_ORDER_BYTES = 1024;
/** Tolerance d'horloge : un ordre date de plus de 5 s dans le futur est refuse. */
export const CLOCK_SKEW_MS = 5000;
/** Memoire anti-rejeu des cmdId. */
export const REPLAY_WINDOW_MS = 120_000;
const TTL_MIN_S = 2;
const TTL_MAX_S = 30;
const DURATION_MAX_S = 86_400;
const CMD_ID = /^[0-9a-f]{32}$/;
const ACTION = /^[a-z_]{1,16}$/;
const CLIP = /^[A-Za-z0-9_-]{1,32}$/;
const SIG = /^[0-9a-f]{64}$/;
export const ACK_CODE = /^[a-z0-9_]{1,32}$/;

export type AckResult = 'done' | 'refused' | 'error';
const RESULTS: ReadonlySet<string> = new Set(['done', 'refused', 'error']);

/** Ordre decode, formats verifies (la signature ne l'est pas encore). */
export interface Order {
  cmdId: string;
  action: string;
  durationS?: number;
  clip?: string;
  ts: number;
  ttlS: number;
  sig: string;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** `psim-cmd-v1|<id>|<cmdId>|<action>|<durationS>|<clip>|<ts>|<ttlS>` (champ absent = vide). */
export function orderCanonical(actuatorId: string, o: Omit<Order, 'sig'>): string {
  return ['psim-cmd-v1', actuatorId, o.cmdId, o.action, o.durationS ?? '', o.clip ?? '', o.ts, o.ttlS].join('|');
}

/** `psim-ack-v1|<id>|<cmdId>|<result>|<code>|<ts>` (code vide si absent). */
export function ackCanonical(actuatorId: string, a: { cmdId: string; result: AckResult; code?: string; ts: number }): string {
  return ['psim-ack-v1', actuatorId, a.cmdId, a.result, a.code ?? '', a.ts].join('|');
}

export const KEY_HEX = /^[0-9a-f]{64}$/;

/** HMAC-SHA256 hexadecimal ; la cle est les 32 octets decodes de ses 64 hexadecimaux. */
export function hmacHex(keyHex: string, text: string): string {
  if (!KEY_HEX.test(keyHex)) throw new Error('cle d\'actionneur invalide (64 hexadecimaux minuscules attendus)');
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(text, 'utf8').digest('hex');
}

/** Comparaison en temps constant de deux signatures hexadecimales (tampons de 32 octets, donc de meme longueur). */
export function sameSignature(expectedHex: string, givenHex: string): boolean {
  if (!SIG.test(expectedHex) || !SIG.test(givenHex)) return false;
  return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(givenHex, 'hex'));
}

/** Accuse signe, tel que le PSIM l'attend (JSON compact). */
export function buildAck(keyHex: string, actuatorId: string, a: { cmdId: string; result: AckResult; code?: string; ts: number }): string {
  const body: Record<string, unknown> = { v: 1, cmdId: a.cmdId, result: a.result };
  if (a.code !== undefined) body.code = a.code;
  body.ts = a.ts;
  body.sig = hmacHex(keyHex, ackCanonical(actuatorId, a));
  return JSON.stringify(body);
}

const only = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));

/**
 * Regle 1 : taille, JSON objet, chaque champ au format. `null` = a ignorer (sans accuser). Aucun champ en trop, aucun
 * champ manquant ; `params` n'accepte que durationS et clip.
 */
export function parseOrder(raw: Buffer | Uint8Array | string): Order | null {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length;
  if (size > MAX_ORDER_BYTES || size === 0) return null;
  let o: unknown;
  try {
    o = JSON.parse(typeof raw === 'string' ? raw : (Buffer.isBuffer(raw) ? raw : Buffer.from(raw)).toString('utf8'));
  } catch {
    return null;
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
  const m = o as Record<string, unknown>;
  if (!only(m, ['v', 'cmdId', 'action', 'params', 'ts', 'ttlS', 'sig'])) return null;
  if (m.v !== 1 || typeof m.cmdId !== 'string' || !CMD_ID.test(m.cmdId) || typeof m.action !== 'string' || !ACTION.test(m.action)) return null;
  const p = m.params;
  if (p === null || typeof p !== 'object' || Array.isArray(p) || !only(p as Record<string, unknown>, ['durationS', 'clip'])) return null;
  const params = p as Record<string, unknown>;
  if (!isInt(m.ts) || m.ts <= 0 || !isInt(m.ttlS) || m.ttlS < TTL_MIN_S || m.ttlS > TTL_MAX_S || typeof m.sig !== 'string' || !SIG.test(m.sig)) return null;
  const order: Order = { cmdId: m.cmdId, action: m.action, ts: m.ts, ttlS: m.ttlS, sig: m.sig };
  if (params.durationS !== undefined) {
    if (!isInt(params.durationS) || params.durationS < 1 || params.durationS > DURATION_MAX_S) return null;
    order.durationS = params.durationS;
  }
  if (params.clip !== undefined) {
    if (typeof params.clip !== 'string' || !CLIP.test(params.clip)) return null;
    order.clip = params.clip;
  }
  return order;
}

// ------------------------------------------------------------------------------------------------------ pilote

/** Planificateur injectable : renvoie la fonction qui annule le delai. */
export type Scheduler = (fn: () => void, ms: number) => () => void;

const realScheduler: Scheduler = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export interface PilotOptions {
  actuators: readonly ActuatorSpec[];
  log: Logger;
  /** Publie un accuse (topic psim/actuators/<id>/ack, QoS 1, sans file disque) ; faux = perdu (liaison coupee). */
  publishAck: (actuatorId: string, payload: string) => Promise<boolean> | boolean;
  now?: () => number;
  schedule?: Scheduler;
  /** Fichier d'etat (anti-rejeu, dernier ts, retours au repos en attente) ; null = memoire seule. */
  stateFile?: string | null;
  /** Delai laisse a un gestionnaire de module (4 s). */
  handlerTimeoutMs?: number;
  /** Pause entre deux essais du retour au repos (5 s) et nombre de reessais au plus (20). */
  restRetryMs?: number;
  restRetries?: number;
}

export interface ActuatorStats {
  configured: number;
  /** Ordres accuses « done ». */
  executed: number;
  /** Ordres refuses (par le socle ou par le module). */
  refused: number;
  /** Ordres en erreur (module : erreur, delai, exception). */
  failed: number;
  /** Messages ignores : mal formes ou signature fausse. */
  ignored: number;
  /** Ordres deja vus (rejeu). */
  replayed: number;
  /** Accuses qui n'ont pas pu etre publies. */
  acksLost: number;
}

export interface ActuatorPilot {
  /** Identifiants dont le pilote attend les ordres (topics a souscrire). */
  ids(): string[];
  /**
   * Traite un message recu sur `psim/actuators/<actuatorId>/command` (l'identifiant est celui du TOPIC souscrit, jamais une
   * valeur du message). Ne leve jamais ; se termine quand l'accuse est parti (ou qu'il n'y en a pas).
   */
  handleMessage(actuatorId: string, payload: Buffer | Uint8Array | string): Promise<void>;
  /** Enregistre le gestionnaire du module ; renvoie la fonction qui le retire (sans effet s'il a ete remplace). */
  register(actuatorId: string, handler: ActuatorHandler): () => void;
  hasHandler(actuatorId: string): boolean;
  stats(): ActuatorStats;
  /** Retours au repos programmes (essais, statut). */
  pendingRests(): { actuatorId: string; action: string; dueAt: number; attempts: number }[];
  /**
   * Arret : plus aucun ordre accepte ; les ordres en cours finissent (delai borne) ; chaque actionneur dont un retour au repos
   * est programme recoit l'action de repos UNE fois, au mieux. Echec = le retour reste dans le fichier d'etat et sera repris
   * au prochain demarrage.
   */
  stop(): Promise<void>;
}

interface Rest {
  gen: number;
  cmdId: string;
  dueAt: number;
  /** Appels deja faits de l'action de repos. */
  attempts: number;
  cancel: (() => void) | null;
}

interface Counter {
  count: number;
  last: number;
}

interface State {
  spec: ActuatorSpec;
  handler: ActuatorHandler | null;
  seen: Map<string, number>;
  /** ts du dernier ordre ACCEPTE (execute ou en cours d'execution). */
  lastTs: number | null;
  rest: Rest | null;
  gen: number;
  chain: Promise<void>;
  queued: number;
  counters: Record<'format' | 'signature' | 'replay', Counter>;
}

const MAX_QUEUED = 8;
const MAX_SEEN = 5000;
const STATE_VERSION = 1;
const NOTE_EVERY_MS = 60_000;

const errText = (err: unknown) => clean(err instanceof Error ? err.message : String(err), 200);
const short = (cmdId: string) => cmdId.slice(0, 8);

export function createActuatorPilot(opts: PilotOptions): ActuatorPilot {
  const log = opts.log;
  const now = opts.now ?? Date.now;
  const schedule = opts.schedule ?? realScheduler;
  const timeoutMs = opts.handlerTimeoutMs ?? 4000;
  const restRetryMs = opts.restRetryMs ?? 5000;
  const restRetries = opts.restRetries ?? 20;
  const stateFile = opts.stateFile ?? null;
  const say = (level: 'info' | 'warn' | 'error', text: string) => log.log(level, `[actionneurs] ${text}`);

  const acts = new Map<string, State>();
  for (const spec of opts.actuators) {
    if (!KEY_HEX.test(spec.key) || acts.has(spec.id)) throw new Error(`actionneur « ${clean(spec.id, 40)} » : cle invalide (64 hexadecimaux minuscules) ou identifiant en double`);
    acts.set(spec.id, {
      spec,
      handler: null,
      seen: new Map(),
      lastTs: null,
      rest: null,
      gen: 0,
      chain: Promise.resolve(),
      queued: 0,
      counters: { format: { count: 0, last: -Infinity }, signature: { count: 0, last: -Infinity }, replay: { count: 0, last: -Infinity } },
    });
  }
  const stats: ActuatorStats = { configured: acts.size, executed: 0, refused: 0, failed: 0, ignored: 0, replayed: 0, acksLost: 0 };
  let stopped = false;
  let stopping: Promise<void> | null = null;
  let lastUnknownLog = -Infinity;
  let lastPersistErrorLog = -Infinity;

  // ---------------------------------------------------------------- compteurs journalises au plus une fois par minute

  const NOTE_TEXT = {
    format: 'ordre(s) mal forme(s) ignore(s)',
    signature: 'ordre(s) a signature fausse ignore(s) (sans accuse)',
    replay: 'ordre(s) deja vu(s) ignore(s) (rejeu)',
  } as const;

  function note(a: State, kind: keyof State['counters']): void {
    const c = a.counters[kind];
    c.count++;
    const t = now();
    if (t - c.last < NOTE_EVERY_MS) return;
    c.last = t;
    const n = c.count;
    c.count = 0;
    say('warn', `${a.spec.id} : ${n} ${NOTE_TEXT[kind]} depuis la derniere alerte (au plus une ligne par minute)`);
  }

  function flushNotes(): void {
    for (const a of acts.values()) {
      for (const kind of ['format', 'signature', 'replay'] as const) {
        const c = a.counters[kind];
        if (c.count > 0) {
          say('warn', `${a.spec.id} : ${c.count} ${NOTE_TEXT[kind]} depuis la derniere alerte`);
          c.count = 0;
        }
      }
    }
  }

  // ---------------------------------------------------------------- fichier d'etat (jamais de secret)

  function loadState(): void {
    if (!stateFile) return;
    let text: string;
    try {
      text = readFileSync(stateFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') say('warn', `fichier d'etat illisible (${clean((err as NodeJS.ErrnoException).code ?? errText(err))}) : memoire anti-rejeu repartie a vide`);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      say('warn', `fichier d'etat corrompu (${clean(stateFile, 120)}) : memoire anti-rejeu repartie a vide`);
      return;
    }
    const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
    const top = obj(raw);
    if (!top || top.v !== STATE_VERSION) {
      say('warn', "fichier d'etat de version inconnue : memoire anti-rejeu repartie a vide");
      return;
    }
    const t = now();
    let dropped = 0;
    const seen = obj(top.seen) ?? {};
    const last = obj(top.lastTs) ?? {};
    const rests = obj(top.rest) ?? {};
    for (const [id, a] of acts) {
      const mine = Object.hasOwn(seen, id) ? obj(seen[id]) : null;
      if (mine) {
        const entries: [string, number][] = [];
        for (const [cmdId, at] of Object.entries(mine)) {
          if (!CMD_ID.test(cmdId) || !isInt(at)) dropped++;
          else if (t - at < REPLAY_WINDOW_MS) entries.push([cmdId, Math.min(at, t)]);
        }
        entries.sort((x, y) => x[1] - y[1]);
        for (const [cmdId, at] of entries.slice(-MAX_SEEN)) a.seen.set(cmdId, at);
      }
      if (Object.hasOwn(last, id)) {
        const v = last[id];
        if (isInt(v) && v > 0) a.lastTs = v;
        else dropped++;
      }
      const r = Object.hasOwn(rests, id) ? obj(rests[id]) : null;
      if (r) {
        if (typeof r.action === 'string' && r.action === a.spec.rest && typeof r.cmdId === 'string' && r.cmdId.length > 0 && r.cmdId.length <= 64 && /^[A-Za-z0-9:_-]+$/.test(r.cmdId) && isInt(r.dueAt)) {
          // Un retour au repos programme avant l'arret et pas fait : repris tout de suite (borne : une horloge deregulee ne le repousse pas).
          const dueAt = Math.min(r.dueAt, t + DURATION_MAX_S * 1000);
          armRest(a, r.cmdId, dueAt);
          say('info', `${id} : retour au repos « ${a.spec.rest} » programme avant l'arret de la passerelle : repris`);
        } else dropped++;
      }
    }
    if (dropped > 0) say('warn', `fichier d'etat : ${dropped} entree(s) invalide(s) ou obsolete(s) ignoree(s)`);
  }

  function persist(): void {
    if (!stateFile) return;
    const t = now();
    const seen: Record<string, Record<string, number>> = {};
    const lastTs: Record<string, number> = {};
    const rest: Record<string, { action: string; cmdId: string; dueAt: number }> = {};
    for (const [id, a] of acts) {
      if (a.seen.size > 0) seen[id] = Object.fromEntries(a.seen);
      if (a.lastTs !== null) lastTs[id] = a.lastTs;
      if (a.rest && a.spec.rest) rest[id] = { action: a.spec.rest, cmdId: a.rest.cmdId, dueAt: a.rest.dueAt };
    }
    const tmp = `${stateFile}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ v: STATE_VERSION, savedAt: t, seen, lastTs, rest }));
      renameSync(tmp, stateFile);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // rien de plus a faire
      }
      // La memoire anti-rejeu reste valable jusqu'au redemarrage ; l'ordre n'est pas bloque pour autant.
      if (t - lastPersistErrorLog >= NOTE_EVERY_MS) {
        lastPersistErrorLog = t;
        say('error', `ecriture du fichier d'etat impossible (${clean((err as NodeJS.ErrnoException).code ?? errText(err))}) : la memoire anti-rejeu ne survivra pas a un redemarrage`);
      }
    }
  }

  // ---------------------------------------------------------------- appel d'un gestionnaire de module

  function sanitizeOutcome(o: unknown): ActuatorOutcome {
    if (o === null || typeof o !== 'object') return { result: 'error', code: 'bad_result' };
    const r = (o as { result?: unknown; code?: unknown }).result;
    const c = (o as { code?: unknown }).code;
    if (typeof r !== 'string' || !RESULTS.has(r)) return { result: 'error', code: 'bad_result' };
    const out: ActuatorOutcome = { result: r as AckResult };
    if (c !== undefined && c !== null) out.code = typeof c === 'string' && ACK_CODE.test(c) ? c : 'other';
    return out;
  }

  /** Appelle le gestionnaire, borne par un delai. Ne leve jamais. Une reponse tardive est ignoree. */
  function callHandler(a: State, handler: ActuatorHandler, req: ActuatorRequest): Promise<ActuatorOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let cancel: () => void = () => undefined;
      const finish = (o: ActuatorOutcome) => {
        if (settled) return;
        settled = true;
        cancel();
        resolve(o);
      };
      cancel = schedule(() => {
        say('error', `${a.spec.id} : le module n'a pas repondu en ${Math.round(timeoutMs / 100) / 10} s (${clean(req.action, 16)}, cmd ${short(req.cmdId)}) : etat de l'equipement inconnu`);
        finish({ result: 'error', code: 'timeout' });
      }, timeoutMs);
      Promise.resolve()
        .then(() => handler(Object.freeze({ ...req })))
        .then(
          (o) => finish(sanitizeOutcome(o)),
          (err) => {
            say('error', `${a.spec.id} : le module a leve une exception (${errText(err)})`);
            finish({ result: 'error', code: 'exception' });
          },
        );
    });
  }

  // ---------------------------------------------------------------- accuse

  async function sendAck(a: State, cmdId: string, outcome: ActuatorOutcome): Promise<void> {
    if (outcome.result === 'done') stats.executed++;
    else if (outcome.result === 'refused') stats.refused++;
    else stats.failed++;
    let payload: string;
    try {
      payload = buildAck(a.spec.key, a.spec.id, { cmdId, result: outcome.result, ...(outcome.code !== undefined ? { code: outcome.code } : {}), ts: Math.trunc(now()) });
    } catch (err) {
      say('error', `${a.spec.id} : accuse impossible a construire (${errText(err)})`);
      return;
    }
    try {
      const ok = await opts.publishAck(a.spec.id, payload);
      if (!ok) throw new Error('liaison PSIM coupee ou accuse non remis');
    } catch (err) {
      // Un accuse en retard n'a aucune valeur : jamais mis en file. Le PSIM affichera l'ordre « sans accuse ».
      stats.acksLost++;
      say('warn', `${a.spec.id} : accuse « ${outcome.result}${outcome.code ? ` (${outcome.code})` : ''} » de l'ordre ${short(cmdId)} PERDU (${errText(err)})`);
    }
  }

  // ---------------------------------------------------------------- file par actionneur et retour au repos

  /** Une seule execution a la fois par actionneur, dans l'ordre d'arrivee des ordres. Ne rejette jamais. */
  function enqueue<T>(a: State, task: () => Promise<T>): Promise<T | undefined> {
    const run = a.chain.then(task).catch((err) => {
      say('error', `${a.spec.id} : erreur interne (${errText(err)})`);
      return undefined;
    });
    a.chain = run.then(() => undefined);
    return run;
  }

  function cancelRest(a: State): void {
    a.rest?.cancel?.();
    a.rest = null;
  }

  function armRest(a: State, cmdId: string, dueAt: number, attempts = 0): void {
    cancelRest(a);
    const gen = ++a.gen;
    const rest: Rest = { gen, cmdId, dueAt, attempts, cancel: null };
    rest.cancel = schedule(() => fire(a, gen), Math.max(0, dueAt - now()));
    a.rest = rest;
  }

  function fire(a: State, gen: number): void {
    const r = a.rest;
    if (stopped || !r || r.gen !== gen) return;
    r.cancel = null;
    void enqueue(a, () => runRest(a, gen));
  }

  async function runRest(a: State, gen: number): Promise<void> {
    const r = a.rest;
    if (!r || r.gen !== gen || stopped) return;
    const action = a.spec.rest;
    if (action === null || (a.spec.emergencyExit && action === 'lock')) {
      say('error', `${a.spec.id} : retour au repos abandonne (configuration incoherente : issue de secours)`);
      a.rest = null;
      persist();
      return;
    }
    r.attempts++;
    const handler = a.handler;
    const outcome: ActuatorOutcome = handler ? await callHandler(a, handler, { actuatorId: a.spec.id, cmdId: `${r.cmdId}:rest`, action }) : { result: 'error', code: 'unavailable' };
    if (a.rest !== r) return; // remplace entre-temps par un nouvel ordre
    if (outcome.result === 'done') {
      say('info', `${a.spec.id} : retour au repos « ${action} » fait (ordre ${short(r.cmdId)}${r.attempts > 1 ? `, essai ${r.attempts}` : ''})`);
      a.rest = null;
      persist();
      return;
    }
    const why = `${outcome.result}${outcome.code ? ` (${outcome.code})` : ''}`;
    say(handler ? 'error' : 'warn', `${a.spec.id} : retour au repos « ${action} » ECHOUE (essai ${r.attempts}/${restRetries + 1}) : ${handler ? `le module repond ${why}` : 'aucun module n\'a enregistre cet actionneur'}`);
    if (r.attempts > restRetries) {
      say('error', `${a.spec.id} : retour au repos « ${action} » ABANDONNE apres ${r.attempts} essais : verifier l'equipement SUR PLACE (il peut etre reste actif)`);
      a.rest = null;
      persist();
      return;
    }
    if (!stopped) r.cancel = schedule(() => fire(a, gen), restRetryMs);
  }

  /** Un module vient de (re)enregistrer son gestionnaire : un retour au repos en attente d'un nouvel essai part tout de suite. */
  function kickRest(a: State): void {
    const r = a.rest;
    if (!r || r.attempts === 0 || r.cancel === null) return;
    r.cancel();
    r.cancel = null;
    fire(a, r.gen);
  }

  /** Apres une execution qui n'a pas ete REFUSEE par le module : l'ancienne temporisation est remplacee. */
  function replaceRest(a: State, o: Order, startedAt: number): void {
    cancelRest(a);
    a.gen++;
    if (o.durationS !== undefined && a.spec.rest !== null && o.action !== a.spec.rest) armRest(a, o.cmdId, startedAt + o.durationS * 1000);
    persist();
  }

  // ---------------------------------------------------------------- un ordre

  function refuse(a: State, o: Order, code: string, why: string): Promise<void> {
    say('warn', `${a.spec.id} : ordre ${clean(o.action, 16)} (cmd ${short(o.cmdId)}) REFUSE (${code}) : ${why}`);
    return sendAck(a, o.cmdId, { result: 'refused', code });
  }

  /** Regle 5 : issue de secours, action connue, plafonds. Renvoie le code de refus, ou null. */
  function policy(a: State, o: Order): { code: string; why: string } | null {
    const spec = a.spec;
    if (spec.emergencyExit && o.action === 'lock') return { code: 'emergency_exit', why: 'issue de secours : jamais verrouillee' };
    if (!Object.hasOwn(spec.actions, o.action)) return { code: 'not_allowed', why: 'action absente de la liste locale' };
    const act = spec.actions[o.action] as { maxS: number | null; unbounded: boolean };
    if (o.durationS !== undefined) {
      if (act.maxS === null) return { code: 'not_allowed', why: 'action instantanee : durationS interdit' };
      if (o.durationS > act.maxS) return { code: 'not_allowed', why: `duree ${o.durationS} s au-dela du plafond local (${act.maxS} s)` };
    } else if (act.maxS !== null && !act.unbounded) {
      return { code: 'not_allowed', why: 'duree obligatoire pour cette action (aucune duree donnee)' };
    }
    return null;
  }

  /**
   * Execute un ordre accepte. Renvoie l'accuse EN COURS d'envoi sans l'attendre : une publication lente ne doit jamais
   * retarder l'ordre suivant du meme actionneur.
   */
  async function runOrder(a: State, o: Order): Promise<{ ack: Promise<void> }> {
    const startedAt = now();
    if (stopped) return { ack: sendAck(a, o.cmdId, { result: 'refused', code: 'unavailable' }) };
    // Attendre son tour derriere un gestionnaire lent ne doit jamais faire executer un ordre perime (M7).
    if (startedAt > o.ts + o.ttlS * 1000) return { ack: refuse(a, o, 'stale', "perime pendant l'attente de l'ordre precedent") };
    const handler = a.handler;
    if (!handler) return { ack: refuse(a, o, 'unavailable', "aucun module n'a enregistre cet actionneur") };
    const req: ActuatorRequest = { actuatorId: a.spec.id, cmdId: o.cmdId, action: o.action };
    if (o.durationS !== undefined) req.durationS = o.durationS;
    if (o.clip !== undefined) req.clip = o.clip;
    const outcome = await callHandler(a, handler, req);
    // Refuse par le module = rien n'a ete fait : la temporisation precedente reste. Tout le reste (fait, erreur, delai,
    // exception) peut avoir agi sur l'equipement : le retour au repos est programme quand meme.
    if (outcome.result !== 'refused') replaceRest(a, o, startedAt);
    const detail = `${o.action}${o.durationS !== undefined ? ` ${o.durationS} s` : ''}`;
    const held = o.durationS === undefined && outcome.result !== 'refused' && (a.spec.actions[o.action] as { maxS: number | null }).maxS !== null;
    say(outcome.result === 'done' ? 'info' : outcome.result === 'refused' ? 'warn' : 'error', `${a.spec.id} : ordre ${clean(detail, 40)} (cmd ${short(o.cmdId)}) -> ${outcome.result}${outcome.code ? ` (${outcome.code})` : ''}${held ? " ; sans duree (unbounded) : tenu jusqu'a l'ordre contraire" : ''}`);
    return { ack: sendAck(a, o.cmdId, outcome) };
  }

  function handleMessage(actuatorId: string, payload: Buffer | Uint8Array | string): Promise<void> {
    const a = acts.get(actuatorId);
    if (!a) {
      const t = now();
      if (t - lastUnknownLog >= NOTE_EVERY_MS) {
        lastUnknownLog = t;
        say('warn', `ordre recu pour un actionneur non configure (« ${clean(actuatorId, 40)} ») : ignore`);
      }
      return Promise.resolve();
    }
    if (stopped) return Promise.resolve();

    // 1. formats
    const o = parseOrder(payload);
    if (!o) {
      stats.ignored++;
      note(a, 'format');
      return Promise.resolve();
    }
    // 2. signature, temps constant ; fausse = ignore SANS accuser (aucun oracle)
    if (!sameSignature(hmacHex(a.spec.key, orderCanonical(a.spec.id, o)), o.sig)) {
      stats.ignored++;
      note(a, 'signature');
      return Promise.resolve();
    }
    const t = now();
    // 4 (verifie AVANT la fraicheur). Un cmdId deja vu est ignore sans accuser, MEME s'il est perime depuis : un accuse
    // « stale » pour un ordre qui a bel et bien ete execute (accuse « done » perdu) contredirait le premier et tromperait
    // l'operateur. Un ordre perime n'est jamais memorise : seul un ordre signe ET frais l'est.
    for (const [id, at] of a.seen) {
      if (t - at < REPLAY_WINDOW_MS) break; // insertion = ordre chronologique : le reste est plus recent
      a.seen.delete(id);
    }
    if (a.seen.has(o.cmdId)) {
      stats.replayed++;
      note(a, 'replay');
      return Promise.resolve();
    }
    // 3. fraicheur
    if (t < o.ts - CLOCK_SKEW_MS || t > o.ts + o.ttlS * 1000) {
      return refuse(a, o, 'stale', t < o.ts - CLOCK_SKEW_MS ? `date dans le futur de ${Math.round((o.ts - t) / 1000)} s (horloge de la passerelle ou du PSIM deregulee ? 5 s de tolerance)` : `perime depuis ${Math.round((t - o.ts - o.ttlS * 1000) / 1000)} s`);
    }
    a.seen.set(o.cmdId, t);
    if (a.seen.size > MAX_SEEN) a.seen.delete(a.seen.keys().next().value as string);

    let denied: { code: string; why: string } | null = null;
    // Un `lastTs` plus loin que le futur toleree (5 s) vient d'une horloge passee en avant puis corrigee : il est oublie,
    // sinon il refuserait tout ordre honnete jusqu'a ce que l'heure le rattrape.
    if (a.lastTs !== null && a.lastTs > t + CLOCK_SKEW_MS) a.lastTs = null;
    if (a.lastTs !== null && o.ts < a.lastTs) denied = { code: 'out_of_order', why: 'plus ancien que le dernier ordre accepte pour cet actionneur' };
    else denied = policy(a, o);
    if (!denied && !a.handler) denied = { code: 'unavailable', why: 'aucun module n\'a enregistre cet actionneur (module arrete ou en cours de redemarrage)' };
    if (!denied && a.queued >= MAX_QUEUED) denied = { code: 'busy', why: `${MAX_QUEUED} ordres deja en attente derriere un gestionnaire lent` };
    if (denied) {
      persist();
      return refuse(a, o, denied.code, denied.why);
    }
    a.lastTs = o.ts;
    persist(); // avant toute execution : un redemarrage ne rejoue pas cet ordre
    a.queued++;
    return enqueue(a, () => {
      a.queued--;
      return runOrder(a, o);
    }).then((r) => r?.ack);
  }

  // ---------------------------------------------------------------- arret

  async function doStop(): Promise<void> {
    stopped = true;
    for (const a of acts.values()) {
      a.rest?.cancel?.();
      if (a.rest) a.rest.cancel = null;
    }
    // Laisse finir les ordres commences (chacun est borne par le delai du gestionnaire).
    let cancelWait: () => void = () => undefined;
    await Promise.race([
      Promise.all([...acts.values()].map((a) => a.chain)),
      new Promise<void>((resolve) => {
        cancelWait = schedule(resolve, timeoutMs + 500);
      }),
    ]);
    cancelWait();
    // Une fois, au mieux : l'equipement revient a son repos au lieu d'attendre un temporisateur qui ne sera plus la.
    await Promise.all(
      [...acts.values()].map(async (a) => {
        const r = a.rest;
        const action = a.spec.rest;
        if (!r || action === null || (a.spec.emergencyExit && action === 'lock')) return;
        const handler = a.handler;
        if (!handler) {
          say('warn', `${a.spec.id} : arret avec un retour au repos « ${action} » en cours et aucun module pour l'executer : repris au prochain demarrage`);
          return;
        }
        const outcome = await callHandler(a, handler, { actuatorId: a.spec.id, cmdId: `${r.cmdId}:rest`, action });
        if (outcome.result === 'done') {
          say('info', `${a.spec.id} : arret de la passerelle : retour au repos « ${action} » fait`);
          a.rest = null;
        } else {
          say('error', `${a.spec.id} : arret de la passerelle : retour au repos « ${action} » ECHOUE (${outcome.result}${outcome.code ? ` ${outcome.code}` : ''}) ; repris au prochain demarrage`);
          r.dueAt = Math.min(r.dueAt, now());
        }
      }),
    );
    persist();
    flushNotes();
  }

  loadState();

  return {
    ids: () => [...acts.keys()],
    handleMessage(actuatorId, payload) {
      const fail = (err: unknown) => say('error', `${clean(actuatorId, 40)} : erreur interne au traitement d'un ordre (${errText(err)})`);
      try {
        return handleMessage(actuatorId, payload).catch(fail);
      } catch (err) {
        fail(err);
        return Promise.resolve();
      }
    },
    register(actuatorId, handler) {
      const a = acts.get(actuatorId);
      if (!a) throw new Error(`actionneur « ${clean(actuatorId, 40)} » non configure`);
      if (a.handler) throw new Error(`actionneur « ${a.spec.id} » deja enregistre`);
      a.handler = handler;
      kickRest(a);
      return () => {
        if (a.handler === handler) a.handler = null;
      };
    },
    hasHandler: (actuatorId) => acts.get(actuatorId)?.handler != null,
    stats: () => ({ ...stats }),
    pendingRests: () => [...acts.values()].filter((a) => a.rest && a.spec.rest).map((a) => ({ actuatorId: a.spec.id, action: a.spec.rest as string, dueAt: (a.rest as Rest).dueAt, attempts: (a.rest as Rest).attempts })),
    stop() {
      stopping ??= doStop();
      return stopping;
    },
  };
}
