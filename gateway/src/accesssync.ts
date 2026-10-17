/**
 * Pilote de synchronisation des titulaires de la passerelle : recoit les ordres SIGNES du PSIM (topic
 * psim/access/<controllerId>/sync), les verifie, les fait executer par le module d'acces qui a enregistre le controleur
 * (ModuleContext.onAccessSync) et accuse (topic .../sync-ack). Specification : docs/CONTROLE-ACCES.md, par. 7. Meme modele que le
 * pilote de commandes d'actionneurs (actuators.ts), avec un anti-rejeu par numero de sequence au lieu d'une fenetre de fraicheur.
 *
 * Un ordre accepte ecrit des titulaires et des badges dans un controleur de porte : chaque decision est prise du cote de
 * l'attaquant (broker compromis, rejeu d'un ancien message capture, coupure, redemarrage, horloge).
 *
 * Regles du recepteur, DANS CET ORDRE :
 *   a. taille <= 1024 octets, UTF-8 valide, JSON objet aux champs EXACTEMENT v (=1), opId (32 hexadecimaux minuscules),
 *      seq (entier sur >= 1), ts (entier ms > 0), body (chaine <= 800 octets), sig (64 hexadecimaux minuscules)
 *                                                                   -> sinon ignore SANS accuse (compte, journal 1 fois/min)
 *   b. signature HMAC-SHA256, cle du controleur (32 octets), sur
 *      `psim-sync-v1|<controllerId>|<opId>|<seq>|<ts>|<sha256 hex de body>`, comparaison en temps constant
 *                                                                   -> fausse : ignore SANS accuse (pas d'oracle), compte
 *   c. anti-rejeu par controleur : `seq` strictement croissant, dernier `seq` PERSISTE (ecrit AVANT l'execution) :
 *        seq < dernier, ou seq = dernier avec un autre opId          -> ignore sans accuse
 *        seq = dernier, meme opId, resultat connu                     -> PAS de nouvelle execution : l'accuse est REEMIS (ts frais)
 *        seq = dernier, meme opId, en file ou en cours                -> ignore (l'accuse partira a la fin)
 *        seq = dernier, meme opId, sans resultat (arret pendant l'execution) -> nouvelle execution permise (operations idempotentes)
 *   d. aucun gestionnaire pour ce controleur (module arrete ou en echec) -> accuse error/unreachable SANS consommer le seq
 *   e. `body` doit etre un JSON objet avec une chaine `type` (et sans champ opId ni seq)  -> sinon refused/invalid (seq consomme) ;
 *      le gestionnaire recoit `{ ...body, opId, seq }` (fige) ; une operation a la fois par controleur (file de 8 au plus,
 *      au-dela : ignore sans accuse ni consommation) ; delai maximal par operation (300 s par defaut : le module attend des
 *      cycles d'interrogation de l'appareil) -> error/timeout ; exception -> error/io ; resultat hors contrat -> error/io
 *   f. accuse signe {"v":1,"opId","seq","result","code":<chaine|null>,"ts","sig"} sur
 *      `psim-sync-ack-v1|<controllerId>|<opId>|<seq>|<result>|<code ou vide>|<ts>` ; jamais de nouvel essai d'un accuse ;
 *      le resultat est PERSISTE avec le seq (c'est lui qui est reemis).
 *
 * Pas de fraicheur (`ts` n'entre que dans la signature) : l'ordre et `seq` suffisent, la synchronisation n'est pas urgente.
 * Le PSIM qui veut REESSAYER une operation dont l'accuse est arrive (meme `error`) doit donc utiliser un NOUVEAU `seq` ;
 * renvoyer le meme (opId, seq) ne sert qu'a recuperer un accuse perdu. Seul `unreachable` laisse le seq libre.
 *
 * Fichier d'etat (access-sync-state.json) : par controleur, dernier seq, son opId, son resultat et une empreinte NON secrete de
 * la cle (HMAC de la cle sur une constante, 16 hexadecimaux) ; aucun nom, badge, corps ni cle. Ecriture atomique (fichier
 * temporaire puis renommage) AVANT toute execution. Lecture tolerante : absent, illisible ou corrompu = memoire repartie a vide,
 * avec un avertissement. Pourquoi c'est acceptable : un attaquant ne peut pas FABRIQUER d'ordre (il lui faut la cle) ; perdre
 * l'etat permet seulement de faire accepter de nouveau un ancien message authentique, et seulement a qui peut PUBLIER sur
 * psim/access/<id>/sync (droit reserve au PSIM par les droits du broker) apres avoir capture ce message (jamais conserve par
 * le broker : QoS 1 sans retain). Le PSIM, qui renvoie lui-meme ses operations dans l'ordre, retablit l'etat juste ensuite.
 * Empreinte de cle differente au redemarrage (cle renouvelee) : le compteur repart de zero (sur : les anciens messages, signes
 * avec l'ancienne cle, ne passent plus la regle b).
 *
 * Jamais la cle, la signature ni le corps (noms, numeros de badge) dans les journaux : seulement controleur, type, seq, opId
 * abrege, resultat et code. Aucun reseau dans le coeur : horloge, planificateur et publication des accuses sont injectes.
 * Ce fichier n'importe rien de server/.
 */
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { KEY_HEX, hmacHex, sameSignature } from './actuators.ts';
import type { Scheduler } from './actuators.ts';
import { clean } from './log.ts';
import type { Logger } from './log.ts';
import type { AccessSyncHandler, AccessSyncOp, ActuatorOutcome } from './module.ts';

// ------------------------------------------------------------------------------------------------------ protocole

export const MAX_SYNC_BYTES = 1024;
export const MAX_SYNC_BODY_BYTES = 800;
/** Identifiant PSIM d'un controleur (`access_controller.id`). */
export const SYNC_CONTROLLER_ID = /^[A-Za-z0-9_-]{1,32}$/;
/** Operations en file (y compris celle en cours) par controleur. */
export const SYNC_QUEUE_MAX = 8;
export const DEFAULT_SYNC_TIMEOUT_MS = 300_000;
/** Controleurs enregistres a la fois, et entrees du fichier d'etat, au plus. */
export const MAX_SYNC_CONTROLLERS = 256;
const MAX_STATE_ENTRIES = 1024;
const OP_ID = /^[0-9a-f]{32}$/;
const SIG = /^[0-9a-f]{64}$/;
const SYNC_CODE = /^[a-z0-9_]{1,32}$/;
const KID = /^[0-9a-f]{16}$/;
/** Type affichable dans le journal (le corps entier ne l'est jamais). */
const SHOWN_TYPE = /^[a-z_]{1,32}$/;
const STATE_VERSION = 1;
const NOTE_EVERY_MS = 60_000;
const DEFAULT_STOP_WAIT_MS = 5000;

export type SyncResult = 'done' | 'refused' | 'error';
const RESULTS: ReadonlySet<string> = new Set(['done', 'refused', 'error']);

/** Ordre decode, formats verifies (la signature ne l'est pas encore). */
export interface SyncOrder {
  opId: string;
  seq: number;
  ts: number;
  body: string;
  sig: string;
}

export interface SyncAck {
  opId: string;
  seq: number;
  result: SyncResult;
  code: string | null;
  ts: number;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** `psim-sync-v1|<controllerId>|<opId>|<seq>|<ts>|<sha256 hex de body>` (body en UTF-8, tel que transmis). */
export function syncOrderCanonical(controllerId: string, o: Omit<SyncOrder, 'sig'>): string {
  return ['psim-sync-v1', controllerId, o.opId, o.seq, o.ts, sha256Hex(o.body)].join('|');
}

/** `psim-sync-ack-v1|<controllerId>|<opId>|<seq>|<result>|<code ou vide>|<ts>`. */
export function syncAckCanonical(controllerId: string, a: SyncAck): string {
  return ['psim-sync-ack-v1', controllerId, a.opId, a.seq, a.result, a.code ?? '', a.ts].join('|');
}

/** Accuse signe, tel que le PSIM l'attend (JSON compact, `code` toujours present : chaine ou null). */
export function buildSyncAck(keyHex: string, controllerId: string, a: SyncAck): string {
  return JSON.stringify({ v: 1, opId: a.opId, seq: a.seq, result: a.result, code: a.code ?? null, ts: a.ts, sig: hmacHex(keyHex, syncAckCanonical(controllerId, a)) });
}

const FIELDS = ['v', 'opId', 'seq', 'ts', 'body', 'sig'];
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Regle a : taille, UTF-8, JSON objet, champs exacts et au format. `null` = a ignorer, sans accuser. Ne leve jamais. */
export function parseSyncOrder(raw: Buffer | Uint8Array | string): SyncOrder | null {
  let text: string;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > MAX_SYNC_BYTES) return null;
    text = raw;
  } else {
    if (raw.length > MAX_SYNC_BYTES) return null;
    try {
      // UTF-8 casse refuse (pas de remplacement silencieux) ; une marque d'ordre d'octets reste dans le texte, donc refusee par JSON.parse.
      text = strictUtf8.decode(raw);
    } catch {
      return null;
    }
  }
  if (text.length === 0) return null;
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
  const m = o as Record<string, unknown>;
  const keys = Object.keys(m);
  if (keys.length !== FIELDS.length || !FIELDS.every((k) => Object.hasOwn(m, k))) return null;
  if (m.v !== 1 || typeof m.opId !== 'string' || !OP_ID.test(m.opId)) return null;
  if (!isInt(m.seq) || m.seq < 1 || !isInt(m.ts) || m.ts <= 0) return null;
  if (typeof m.body !== 'string' || Buffer.byteLength(m.body, 'utf8') > MAX_SYNC_BODY_BYTES) return null;
  if (typeof m.sig !== 'string' || !SIG.test(m.sig)) return null;
  return { opId: m.opId, seq: m.seq, ts: m.ts, body: m.body, sig: m.sig };
}

/** Empreinte NON secrete de la cle (pour savoir si elle a change entre deux demarrages) : 16 hexadecimaux. */
export function keyId(keyHex: string): string {
  return hmacHex(keyHex, 'psim-sync-state-v1').slice(0, 16);
}

// ------------------------------------------------------------------------------------------------------ pilote

const realScheduler: Scheduler = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export interface AccessSyncPilotOptions {
  log: Logger;
  now: () => number;
  /** Publie un accuse (topic psim/access/<id>/sync-ack, QoS 1, sans file disque) ; faux = perdu (liaison coupee). */
  publishAck: (controllerId: string, payload: string) => Promise<boolean> | boolean;
  /** Fichier d'etat (dernier seq par controleur) ; null = memoire seule. */
  stateFile: string | null;
  schedule?: Scheduler;
  /** Delai laisse a un gestionnaire de module pour une operation (300 s). */
  handlerTimeoutMs?: number;
  /** A l'arret, attente au plus des operations en cours (5 s) ; au-dela, elles seront reexecutees si le PSIM les renvoie. */
  stopWaitMs?: number;
}

export interface AccessSyncStats {
  /** Controleurs dont un module a enregistre le gestionnaire. */
  controllers: number;
  /** Operations accusees done / refused / error (hors reemissions). */
  done: number;
  refused: number;
  failed: number;
  /** Accuses error/unreachable (aucun gestionnaire) : seq non consomme. */
  unreachable: number;
  /** Messages ignores : mal formes, signature fausse, file pleine. */
  ignored: number;
  /** Messages ignores par l'anti-rejeu (seq ancien, conflit, deja en cours). */
  replayed: number;
  /** Accuses reemis pour une operation deja faite. */
  reacked: number;
  /** Accuses qui n'ont pas pu etre publies. */
  acksLost: number;
}

export interface AccessSyncPilot {
  /**
   * Enregistre le gestionnaire du module pour `controllerId` avec sa cle. Leve si l'identifiant, la cle ou le gestionnaire est
   * invalide, si le controleur a deja un gestionnaire, si le plafond de controleurs est atteint ou si le pilote est arrete. Le
   * message d'erreur ne contient jamais la cle. Renvoie la fonction qui retire CE gestionnaire (la cle reste connue : un ordre
   * recu ensuite est accuse error/unreachable).
   */
  register(controllerId: string, key: string, handler: AccessSyncHandler): () => void;
  /** Controleurs dont le pilote connait la cle (topics a souscrire). */
  ids(): string[];
  hasHandler(controllerId: string): boolean;
  /**
   * Traite un message recu sur `psim/access/<controllerId>/sync` (identifiant du TOPIC, jamais une valeur du message). Ne leve
   * jamais ; se termine quand l'accuse est parti (ou qu'il n'y en a pas).
   */
  handleMessage(controllerId: string, payload: Buffer | Uint8Array | string): Promise<void>;
  stats(): AccessSyncStats;
  /**
   * Arret : plus aucun message traite ; les operations en cours ont `stopWaitMs` pour finir (et accuser) ; au-dela, leur resultat
   * n'est plus ecrit ni accuse : sans resultat, elles seront reexecutees si le PSIM les renvoie.
   */
  stop(): Promise<void>;
}

interface Counter {
  count: number;
  last: number;
}

type NoteKind = 'format' | 'signature' | 'replay' | 'inflight' | 'busy' | 'done' | 'reack' | 'acklost' | 'unreachable';

interface Outcome {
  result: SyncResult;
  code: string | null;
}

interface Ctl {
  id: string;
  /** null : connu seulement par le fichier d'etat (aucun module ne l'a encore enregistre). */
  key: string | null;
  /** Empreinte de la cle du fichier d'etat (comparee a l'enregistrement). */
  kid: string | null;
  handler: AccessSyncHandler | null;
  /** Dernier seq consomme (0 : jamais). */
  lastSeq: number;
  lastOpId: string | null;
  /** Resultat de l'operation lastSeq ; null = en file, en cours ou interrompue par un arret. */
  outcome: Outcome | null;
  /** `<seq>:<opId>` en file ou en cours. */
  inflight: Set<string>;
  chain: Promise<void>;
  /** En file + en cours. */
  queued: number;
  counters: Map<NoteKind, Counter>;
}

const NOTE: Record<NoteKind, { level: 'info' | 'warn'; text: string }> = {
  format: { level: 'warn', text: 'ordre(s) de synchronisation mal forme(s) ignore(s)' },
  signature: { level: 'warn', text: 'ordre(s) de synchronisation a signature fausse ignore(s) (sans accuse)' },
  replay: { level: 'warn', text: 'ordre(s) de synchronisation deja applique(s) ou plus ancien(s) ignore(s) (rejeu)' },
  inflight: { level: 'info', text: 'renvoi(s) d\'une operation encore en cours ignore(s) (l\'accuse partira a la fin)' },
  busy: { level: 'warn', text: `ordre(s) de synchronisation ignore(s) : ${SYNC_QUEUE_MAX} operations deja en attente` },
  done: { level: 'info', text: 'operation(s) de synchronisation faite(s)' },
  reack: { level: 'info', text: 'accuse(s) reemis pour une operation deja faite' },
  acklost: { level: 'warn', text: 'accuse(s) de synchronisation perdu(s) (liaison PSIM coupee ? le PSIM renverra l\'operation)' },
  unreachable: { level: 'warn', text: 'ordre(s) de synchronisation sans module pour les executer (module arrete ou en echec) : accuse(s) « unreachable »' },
};

const errText = (err: unknown) => clean(err instanceof Error ? err.message : String(err), 200);
const short = (opId: string) => opId.slice(0, 8);
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function createAccessSyncPilot(opts: AccessSyncPilotOptions): AccessSyncPilot {
  const log = opts.log;
  const now = opts.now;
  const schedule = opts.schedule ?? realScheduler;
  const timeoutMs = opts.handlerTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const stopWaitMs = opts.stopWaitMs ?? DEFAULT_STOP_WAIT_MS;
  const stateFile = opts.stateFile;
  const say = (level: 'info' | 'warn' | 'error', text: string) => {
    try {
      log.log(level, `[synchro] ${text}`);
    } catch {
      // un journal defaillant ne change rien au traitement
    }
  };

  const ctls = new Map<string, Ctl>();
  const stats: AccessSyncStats = { controllers: 0, done: 0, refused: 0, failed: 0, unreachable: 0, ignored: 0, replayed: 0, reacked: 0, acksLost: 0 };
  /** Plus aucun message traite. */
  let stopped = false;
  /** Plus aucune ecriture du fichier d'etat ni aucun accuse (apres l'attente de l'arret). */
  let closed = false;
  let stopping: Promise<void> | null = null;
  let lastUnknownLog = -Infinity;
  let lastPersistErrorLog = -Infinity;

  function newCtl(id: string): Ctl {
    return { id, key: null, kid: null, handler: null, lastSeq: 0, lastOpId: null, outcome: null, inflight: new Set(), chain: Promise.resolve(), queued: 0, counters: new Map() };
  }

  // ---------------------------------------------------------------- compteurs journalises au plus une fois par minute

  function note(c: Ctl, kind: NoteKind): void {
    let k = c.counters.get(kind);
    if (!k) {
      k = { count: 0, last: -Infinity };
      c.counters.set(kind, k);
    }
    k.count++;
    const t = now();
    if (t - k.last < NOTE_EVERY_MS) return;
    k.last = t;
    const n = k.count;
    k.count = 0;
    say(NOTE[kind].level, `${c.id} : ${n} ${NOTE[kind].text} depuis la derniere ligne (au plus une par minute)`);
  }

  function flushNotes(): void {
    for (const c of ctls.values()) {
      for (const [kind, k] of c.counters) {
        if (k.count > 0) {
          say(NOTE[kind].level, `${c.id} : ${k.count} ${NOTE[kind].text} depuis la derniere ligne`);
          k.count = 0;
        }
      }
    }
  }

  // ---------------------------------------------------------------- fichier d'etat (jamais de secret ni de nom)

  function loadState(): void {
    if (!stateFile) return;
    let text: string;
    try {
      text = readFileSync(stateFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') say('warn', `fichier d'etat illisible (${clean((err as NodeJS.ErrnoException).code ?? errText(err))}) : memoire anti-rejeu repartie a vide (les ordres deja appliques ne peuvent etre rejoues que par qui peut publier sur le broker du PSIM)`);
      return;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      say('warn', `fichier d'etat corrompu (${clean(stateFile, 120)}) : memoire anti-rejeu repartie a vide (les ordres deja appliques ne peuvent etre rejoues que par qui peut publier sur le broker du PSIM)`);
      return;
    }
    const top = obj(raw);
    if (!top || top.v !== STATE_VERSION) {
      say('warn', "fichier d'etat de version inconnue : memoire anti-rejeu repartie a vide");
      return;
    }
    const list = obj(top.controllers) ?? {};
    let dropped = 0;
    for (const [id, v] of Object.entries(list)) {
      const e = obj(v);
      const result = e?.result;
      const code = e?.code;
      const valid =
        e !== null &&
        SYNC_CONTROLLER_ID.test(id) &&
        isInt(e.seq) &&
        e.seq >= 1 &&
        typeof e.opId === 'string' &&
        OP_ID.test(e.opId) &&
        (result === null || (typeof result === 'string' && RESULTS.has(result))) &&
        (code === null || (typeof code === 'string' && SYNC_CODE.test(code))) &&
        !(result === null && code !== null) &&
        (e.kid === undefined || (typeof e.kid === 'string' && KID.test(e.kid)));
      if (!valid || ctls.size >= MAX_STATE_ENTRIES || ctls.has(id)) {
        dropped++;
        continue;
      }
      const c = newCtl(id);
      c.lastSeq = e.seq as number;
      c.lastOpId = e.opId as string;
      c.outcome = result === null ? null : { result: result as SyncResult, code: code as string | null };
      c.kid = typeof e.kid === 'string' ? e.kid : null;
      ctls.set(id, c);
    }
    if (dropped > 0) say('warn', `fichier d'etat : ${dropped} entree(s) invalide(s) ignoree(s)`);
  }

  function persist(): void {
    if (!stateFile || closed) return;
    const t = now();
    const controllers: Record<string, { seq: number; opId: string; result: SyncResult | null; code: string | null; kid?: string }> = {};
    for (const c of ctls.values()) {
      if (c.lastSeq < 1 || c.lastOpId === null) continue;
      const kid = c.key !== null ? keyId(c.key) : c.kid;
      Object.defineProperty(controllers, c.id, {
        value: { seq: c.lastSeq, opId: c.lastOpId, result: c.outcome?.result ?? null, code: c.outcome?.code ?? null, ...(kid ? { kid } : {}) },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    const tmp = `${stateFile}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ v: STATE_VERSION, savedAt: Math.trunc(t), controllers }));
      renameSync(tmp, stateFile);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // rien de plus a faire
      }
      // La memoire reste valable jusqu'au redemarrage ; la synchronisation continue.
      if (t - lastPersistErrorLog >= NOTE_EVERY_MS) {
        lastPersistErrorLog = t;
        say('error', `ecriture du fichier d'etat impossible (${clean((err as NodeJS.ErrnoException).code ?? errText(err))}) : la memoire anti-rejeu ne survivra pas a un redemarrage`);
      }
    }
  }

  // ---------------------------------------------------------------- gestionnaire, accuse

  /** Resultat du module conforme au contrat (`done` / `refused` / `error`, code `^[a-z0-9_]{1,32}$` ou absent), sinon null. */
  function checkOutcome(o: unknown): Outcome | null {
    if (o === null || typeof o !== 'object') return null;
    const r = (o as ActuatorOutcome).result as unknown;
    const code = (o as { code?: unknown }).code;
    if (typeof r !== 'string' || !RESULTS.has(r)) return null;
    if (code === undefined || code === null) return { result: r as SyncResult, code: null };
    if (typeof code !== 'string' || !SYNC_CODE.test(code)) return null;
    return { result: r as SyncResult, code };
  }

  /** Appelle le gestionnaire, borne par un delai. Ne leve jamais. Une reponse tardive est ignoree. */
  function callHandler(handler: AccessSyncHandler, op: AccessSyncOp): Promise<{ outcome: Outcome; why: string | null }> {
    return new Promise((resolve) => {
      let settled = false;
      let cancel: () => void = () => undefined;
      const finish = (outcome: Outcome, why: string | null) => {
        if (settled) return;
        settled = true;
        cancel();
        resolve({ outcome, why });
      };
      cancel = schedule(() => finish({ result: 'error', code: 'timeout' }, `le module n'a pas repondu en ${Math.round(timeoutMs / 1000)} s : etat du controleur inconnu`), timeoutMs);
      Promise.resolve()
        .then(() => handler(op))
        .then(
          (o) => {
            const out = checkOutcome(o);
            finish(out ?? { result: 'error', code: 'io' }, out ? null : 'reponse du module hors contrat');
          },
          // Seule la nature de l'erreur est journalisee : son texte pourrait reprendre un nom ou un badge du corps.
          (err) => finish({ result: 'error', code: 'io' }, `le module a leve une exception (${err instanceof Error ? clean(err.name, 40) : typeof err})`),
        );
    });
  }

  async function sendAck(c: Ctl, o: SyncOrder, outcome: Outcome): Promise<void> {
    if (closed || c.key === null) return;
    let payload: string;
    try {
      payload = buildSyncAck(c.key, c.id, { opId: o.opId, seq: o.seq, result: outcome.result, code: outcome.code, ts: Math.trunc(now()) });
    } catch (err) {
      say('error', `${c.id} : accuse impossible a construire (${errText(err)})`);
      return;
    }
    try {
      const ok = await opts.publishAck(c.id, payload);
      if (!ok) throw new Error('liaison PSIM coupee ou accuse non remis');
    } catch {
      // Jamais retente : le resultat est garde ; si le PSIM renvoie l'operation, l'accuse est reemis.
      stats.acksLost++;
      note(c, 'acklost');
    }
  }

  /** Une seule operation a la fois par controleur, dans l'ordre d'arrivee. Ne rejette jamais. */
  function enqueue<T>(c: Ctl, task: () => Promise<T>): Promise<T | undefined> {
    const run = c.chain.then(task).catch((err) => {
      say('error', `${c.id} : erreur interne (${errText(err)})`);
      return undefined;
    });
    c.chain = run.then(() => undefined);
    return run;
  }

  /** Execute une operation dont le seq est consomme. Renvoie l'accuse EN COURS d'envoi (sans l'attendre). */
  async function runOp(c: Ctl, o: SyncOrder): Promise<{ ack: Promise<void> } | undefined> {
    const tag = `${o.seq}:${o.opId}`;
    try {
      // Arret pendant l'attente : rien d'execute, pas de resultat (le PSIM renverra, l'operation sera alors executee).
      if (stopped) return undefined;
      const record = (out: Outcome, why: string | null, type: string) => {
        if (out.result === 'done') stats.done++;
        else if (out.result === 'refused') stats.refused++;
        else stats.failed++;
        // Seule la DERNIERE operation consommee porte un resultat persiste (c'est elle que le PSIM peut renvoyer).
        if (!closed && c.lastSeq === o.seq && c.lastOpId === o.opId) {
          c.outcome = out;
          persist();
        }
        if (out.result === 'done') note(c, 'done');
        else say(out.result === 'refused' ? 'warn' : 'error', `${c.id} : synchronisation ${type} seq ${o.seq} (op ${short(o.opId)}) -> ${out.result}${out.code ? ` (${out.code})` : ''}${why ? ` : ${why}` : ''}`);
        return { ack: sendAck(c, o, out) };
      };
      // d. Gestionnaire retire entre l'arrivee et l'execution (module en cours d'arret) : seq laisse sans resultat.
      const handler = c.handler;
      if (!handler) {
        stats.unreachable++;
        note(c, 'unreachable');
        return { ack: sendAck(c, o, { result: 'error', code: 'unreachable' }) };
      }
      // e. Corps : JSON objet avec une chaine `type` ; jamais d'opId ni de seq venus du corps.
      let body: unknown;
      try {
        body = JSON.parse(o.body);
      } catch {
        body = null;
      }
      if (!isPlainObject(body) || typeof body.type !== 'string' || Object.hasOwn(body, 'opId') || Object.hasOwn(body, 'seq')) {
        return record({ result: 'refused', code: 'invalid' }, 'corps illisible (JSON objet avec un champ « type » attendu)', '?');
      }
      const type = SHOWN_TYPE.test(body.type) ? body.type : '?';
      const op = Object.freeze({ ...body, opId: o.opId, seq: o.seq }) as unknown as AccessSyncOp;
      const { outcome, why } = await callHandler(handler, op);
      return record(outcome, why, type);
    } finally {
      c.inflight.delete(tag);
      c.queued--;
    }
  }

  function handleMessage(controllerId: string, payload: Buffer | Uint8Array | string): Promise<void> {
    if (stopped) return Promise.resolve();
    const c = typeof controllerId === 'string' ? ctls.get(controllerId) : undefined;
    if (!c || c.key === null) {
      const t = now();
      if (t - lastUnknownLog >= NOTE_EVERY_MS) {
        lastUnknownLog = t;
        say('warn', `ordre de synchronisation recu pour un controleur sans cle enregistree (« ${clean(String(controllerId), 40)} ») : ignore`);
      }
      return Promise.resolve();
    }
    // a. formats
    const o = parseSyncOrder(payload);
    if (!o) {
      stats.ignored++;
      note(c, 'format');
      return Promise.resolve();
    }
    // b. signature, temps constant ; fausse = ignore SANS accuser et sans rien changer (aucun oracle)
    if (!sameSignature(hmacHex(c.key, syncOrderCanonical(c.id, o)), o.sig)) {
      stats.ignored++;
      note(c, 'signature');
      return Promise.resolve();
    }
    // c. anti-rejeu
    if (o.seq < c.lastSeq || (o.seq === c.lastSeq && o.opId !== c.lastOpId)) {
      stats.replayed++;
      note(c, 'replay');
      return Promise.resolve();
    }
    const tag = `${o.seq}:${o.opId}`;
    if (o.seq === c.lastSeq) {
      if (c.inflight.has(tag)) {
        stats.replayed++;
        note(c, 'inflight');
        return Promise.resolve();
      }
      if (c.outcome) {
        // Deja fait : l'accuse (perdu ?) est reemis, signe de nouveau avec un ts frais ; jamais de nouvelle execution.
        stats.reacked++;
        note(c, 'reack');
        return sendAck(c, o, c.outcome);
      }
      // Sans resultat : interrompue par un arret ; nouvelle execution permise (operations idempotentes).
    }
    // d. aucun module : accuse unreachable, seq NON consomme (le PSIM peut renvoyer la meme operation)
    if (!c.handler) {
      stats.unreachable++;
      note(c, 'unreachable');
      return sendAck(c, o, { result: 'error', code: 'unreachable' });
    }
    // e. file bornee : au-dela, ignore sans consommer (le PSIM renverra)
    if (c.queued >= SYNC_QUEUE_MAX) {
      stats.ignored++;
      note(c, 'busy');
      return Promise.resolve();
    }
    // seq consomme et ecrit AVANT l'execution : un redemarrage n'accepte plus jamais un seq inferieur.
    c.lastSeq = o.seq;
    c.lastOpId = o.opId;
    c.outcome = null;
    persist();
    c.inflight.add(tag);
    c.queued++;
    return enqueue(c, () => runOp(c, o)).then((r) => r?.ack);
  }

  // ---------------------------------------------------------------- arret

  async function doStop(): Promise<void> {
    stopped = true;
    let cancelWait: () => void = () => undefined;
    await Promise.race([
      Promise.all([...ctls.values()].map((c) => c.chain)),
      new Promise<void>((resolve) => {
        cancelWait = schedule(resolve, stopWaitMs);
      }),
    ]);
    cancelWait();
    const running = [...ctls.values()].reduce((n, c) => n + c.queued, 0);
    if (running > 0) say('warn', `arret : ${running} operation(s) de synchronisation non terminee(s) ; sans resultat, elles seront reexecutees si le PSIM les renvoie`);
    persist();
    flushNotes();
    closed = true;
  }

  loadState();

  return {
    register(controllerId, key, handler) {
      if (stopped) throw new Error('synchronisation des titulaires arretee');
      if (typeof controllerId !== 'string' || !SYNC_CONTROLLER_ID.test(controllerId)) throw new Error(`identifiant de controleur « ${clean(String(controllerId), 40)} » invalide (lettres, chiffres, _ et -, 32 au plus)`);
      // Le message ne reprend JAMAIS la valeur fournie : c'est peut-etre une cle presque juste.
      if (typeof key !== 'string' || !KEY_HEX.test(key)) throw new Error(`controleur « ${controllerId} » : cle de synchronisation invalide (64 hexadecimaux minuscules attendus)`);
      if (typeof handler !== 'function') throw new Error(`controleur « ${controllerId} » : un gestionnaire (fonction) est attendu`);
      let c = ctls.get(controllerId);
      if (c?.handler) throw new Error(`controleur « ${controllerId} » deja enregistre`);
      if (!c) {
        if ([...ctls.values()].filter((x) => x.key !== null).length >= MAX_SYNC_CONTROLLERS) throw new Error(`au plus ${MAX_SYNC_CONTROLLERS} controleurs synchronises par passerelle`);
        if (ctls.size >= MAX_STATE_ENTRIES) {
          // Place pour le nouveau : la plus ancienne entree du fichier d'etat dont aucun module ne se sert est oubliee.
          for (const [id, x] of ctls) {
            if (x.key === null) {
              ctls.delete(id);
              break;
            }
          }
        }
        c = newCtl(controllerId);
        ctls.set(controllerId, c);
      }
      const kid = keyId(key);
      if (c.key === null && c.kid !== null && c.kid !== kid && c.lastSeq > 0) {
        // Cle renouvelee : les anciens messages ne passent plus la signature, le compteur peut repartir de zero sans risque.
        say('warn', `${controllerId} : cle de synchronisation changee depuis le dernier demarrage : numero de sequence remis a zero`);
        c.lastSeq = 0;
        c.lastOpId = null;
        c.outcome = null;
      }
      if (c.key !== null && c.key !== key && c.lastSeq > 0) {
        say('warn', `${controllerId} : cle de synchronisation changee : numero de sequence remis a zero`);
        c.lastSeq = 0;
        c.lastOpId = null;
        c.outcome = null;
      }
      c.key = key;
      c.kid = kid;
      c.handler = handler;
      stats.controllers = [...ctls.values()].filter((x) => x.handler !== null).length;
      persist();
      const mine = c;
      return () => {
        if (mine.handler === handler) mine.handler = null;
        stats.controllers = [...ctls.values()].filter((x) => x.handler !== null).length;
      };
    },
    ids: () => [...ctls.values()].filter((c) => c.key !== null).map((c) => c.id),
    hasHandler: (controllerId) => ctls.get(controllerId)?.handler != null,
    handleMessage(controllerId, payload) {
      const fail = (err: unknown) => say('error', `${clean(String(controllerId), 40)} : erreur interne au traitement d'un ordre de synchronisation (${errText(err)})`);
      try {
        return handleMessage(controllerId, payload).catch(fail);
      } catch (err) {
        fail(err);
        return Promise.resolve();
      }
    },
    stats: () => ({ ...stats }),
    stop() {
      stopping ??= doStop();
      return stopping;
    },
  };
}
