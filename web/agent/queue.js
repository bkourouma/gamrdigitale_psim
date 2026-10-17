// Application des agents : file d'attente hors ligne (scans, main courante, SOS).
//
// Regle d'or : un envoi n'est JAMAIS perdu en silence. Chaque envoi est d'abord ecrit dans le stockage local
// (IndexedDB), puis tente ; il n'est retire que lorsque le serveur l'a recu (« sent ») ou l'a refuse pour de bon
// (« rejected », 4xx definitif). Le serveur est idempotent sur `clientId` : renvoyer un item deja recu est sans risque.
//
// Aucun acces au DOM a l'import (ce fichier est aussi importe par node:test). Les acces a window / document /
// indexedDB / timers se font dans les fonctions, et peuvent etre injectes (parametre `env`) pour les tests.

import { uuid } from './util.js';

/** Types d'envoi connus et leur route (contrat docs/AGENTS-RONDES.md, « API agent »). */
const ROUTES = {
  scan: '/api/agent/scans',
  logbook: '/api/agent/logbook',
  sos: '/api/agent/sos',
};
export const KINDS = Object.keys(ROUTES);

/** Delai d'une tentative d'envoi (ms). Une photo de main courante (jusqu'a 400 Ko) en a davantage. */
export const SEND_TIMEOUT_MS = 10000;
export const PHOTO_SEND_TIMEOUT_MS = 30000;
/** Marge au-dessus du delai de api() : c'est api() qui doit expirer en premier, ceci n'est qu'un garde-fou. */
const HARD_TIMEOUT_GRACE_MS = 2000;
/** Temps maximal pendant lequel submit() fait attendre l'appelant (le SOS affiche « non transmis » apres). */
export const SUBMIT_WAIT_MS = 10000;
/** Vidange periodique par defaut. */
export const DEFAULT_INTERVAL_MS = 15000;
/** Nombre maximal de tours d'une meme vidange (evite toute boucle). */
const MAX_PASSES = 3;

// ---------------------------------------------------------------------------------------------------------------
// Petits outils

/** Copie profonde (comme le ferait IndexedDB : le stockage ne partage jamais d'objet avec l'appelant). */
function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function errorMessage(err, fallback = 'Erreur inconnue') {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return message || fallback;
}

/** Ordre d'envoi : les SOS d'abord, puis du plus ancien au plus recent (tri stable). */
export function sortItems(items) {
  return [...items].sort((a, b) => {
    const sa = a.kind === 'sos' ? 0 : 1;
    const sb = b.kind === 'sos' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
}

/** Normalise le filtre d'une vidange : { kinds?: string[], username?: string }. */
function normalizeFilter(opts) {
  const filter = {};
  if (Array.isArray(opts?.kinds)) filter.kinds = [...opts.kinds];
  if (typeof opts?.username === 'string' && opts.username !== '') filter.username = opts.username;
  return filter;
}

function filterKey(filter) {
  return JSON.stringify([filter.kinds ? [...filter.kinds].sort() : null, filter.username ?? null]);
}

function matchesFilter(item, filter) {
  if (filter.kinds && !filter.kinds.includes(item.kind)) return false;
  if (filter.username !== undefined && item.username !== filter.username) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Stockages

/** Stockage en memoire (tests, et repli quand IndexedDB est indisponible). Memes methodes que idbStore. */
export function memoryStore() {
  const items = new Map();
  return {
    async getAll() {
      return [...items.values()].map(clone);
    },
    async put(item) {
      items.set(item.clientId, clone(item));
    },
    async delete(clientId) {
      items.delete(clientId);
    },
    async clear() {
      items.clear();
    },
  };
}

const DB_VERSION = 1;
const STORE_NAME = 'queue';
const OPEN_TIMEOUT_MS = 4000;

/**
 * Stockage IndexedDB : base `name`, objet « queue » (cle : clientId). Ouverture paresseuse, a la premiere operation.
 * Si une autre connexion (autre onglet) veut mettre a jour ou supprimer la base, on ferme proprement la notre
 * (versionchange) pour ne jamais la bloquer. `env.indexedDB` permet d'injecter une base factice dans les tests.
 * Methodes : getAll, put, delete, clear, close.
 */
export function idbStore(name = 'psim-agent', env = {}) {
  let dbPromise = null;

  const factory = () => env.indexedDB ?? globalThis.indexedDB;

  function open() {
    if (dbPromise) return dbPromise;
    const promise = new Promise((resolve, reject) => {
      const idb = factory();
      if (!idb) {
        reject(new Error('IndexedDB indisponible'));
        return;
      }
      let request;
      try {
        request = idb.open(name, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('IndexedDB ne répond pas'));
      }, OPEN_TIMEOUT_MS);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'clientId' });
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        const db = request.result;
        if (settled) {
          // l'ouverture a ete jugee trop lente : on ne garde pas cette connexion
          db.close();
          return;
        }
        settled = true;
        const drop = () => {
          if (dbPromise === promise) dbPromise = null;
        };
        // un autre onglet veut changer ou supprimer la base : on se retire pour ne pas la bloquer
        db.onversionchange = () => {
          db.close();
          drop();
        };
        db.onclose = drop;
        resolve(db);
      };
      request.onerror = () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(request.error ?? new Error('Ouverture d’IndexedDB impossible'));
      };
      // request.onblocked : une ancienne connexion retarde la mise a jour ; on attend (le delai ci-dessus tranche)
    });
    dbPromise = promise;
    promise.catch(() => {
      if (dbPromise === promise) dbPromise = null;
    });
    return promise;
  }

  /** Execute une operation dans une transaction et attend sa fin (donc l'ecriture durable). */
  async function run(mode, op, canRetry = true) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error ?? new Error('Transaction annulée'));
        tx.onerror = () => reject(tx.error ?? new Error('Erreur de transaction'));
        const request = op(tx.objectStore(STORE_NAME));
        request.onsuccess = () => {
          result = request.result;
        };
      });
    } catch (err) {
      // la connexion a ete fermee entre-temps (versionchange) : on rouvre une fois
      if (canRetry && err?.name === 'InvalidStateError') {
        dbPromise = null;
        return run(mode, op, false);
      }
      throw err;
    }
  }

  async function close() {
    const pending = dbPromise;
    dbPromise = null;
    if (!pending) return;
    try {
      (await pending).close();
    } catch {
      // jamais ouverte : rien a fermer
    }
  }

  return {
    getAll: () => run('readonly', (s) => s.getAll()),
    put: (item) => run('readwrite', (s) => s.put(item)),
    delete: (clientId) => run('readwrite', (s) => s.delete(clientId)),
    async clear() {
      try {
        await run('readwrite', (s) => s.clear());
      } catch (firstError) {
        // dernier recours (base corrompue ou verrouillee) : on ferme notre connexion et on supprime la base
        await close();
        const deleted = await deleteDatabase(name, { indexedDB: factory() });
        if (!deleted) throw firstError;
      }
    },
    close,
  };
}

/**
 * Supprime toute la base IndexedDB `name` (fin de service). Resout true quand elle est supprimee, false si c'est
 * impossible ou trop long (connexion d'un autre onglet qui refuse de se fermer). Ne leve jamais.
 * Les connexions de cette page doivent etre fermees avant (idbStore le fait tout seul sur versionchange).
 */
export function deleteDatabase(name = 'psim-agent', { indexedDB, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const idb = indexedDB ?? globalThis.indexedDB;
    if (!idb) {
      resolve(false);
      return;
    }
    let timer = null;
    const finish = (value) => {
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };
    try {
      const request = idb.deleteDatabase(name);
      timer = setTimeout(() => finish(false), timeoutMs);
      request.onsuccess = () => finish(true);
      request.onerror = () => finish(false);
      // request.onblocked : on attend la fermeture des autres connexions, le delai ci-dessus tranche
    } catch {
      finish(false);
    }
  });
}

/**
 * Enrobe un stockage pour qu'il ne leve jamais : si le stockage principal echoue (IndexedDB indisponible, quota,
 * navigation privee), les items vont dans une memoire de repli plutot que d'etre perdus. Quand le stockage principal
 * revient, les items de repli y sont recopies.
 */
function resilientStore(primary) {
  const fallback = memoryStore();
  let degraded = false;
  return {
    isDegraded: () => degraded,
    async getAll() {
      let fromPrimary = null;
      try {
        fromPrimary = await primary.getAll();
      } catch {
        degraded = true;
      }
      const extra = await fallback.getAll();
      if (fromPrimary === null) return extra;
      if (extra.length === 0) return fromPrimary;
      const byId = new Map(fromPrimary.map((item) => [item.clientId, item]));
      for (const item of extra) {
        byId.set(item.clientId, item);
        // le stockage principal fonctionne de nouveau : on y remet l'item de repli
        try {
          await primary.put(item);
          await fallback.delete(item.clientId);
        } catch {
          degraded = true;
        }
      }
      return [...byId.values()];
    },
    async put(item) {
      try {
        await primary.put(item);
        await fallback.delete(item.clientId);
      } catch {
        degraded = true;
        await fallback.put(item);
      }
    },
    async delete(clientId) {
      try {
        await primary.delete(clientId);
      } catch {
        degraded = true;
      }
      await fallback.delete(clientId);
    },
    async clear() {
      await fallback.clear();
      try {
        await primary.clear();
      } catch {
        degraded = true;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Transport HTTP

/**
 * Transport reel : envoie un item vers sa route avec `api` (util.js) et traduit la reponse du serveur.
 *   2xx                                         -> { status: 'sent', response }
 *   reseau, 5xx, 408, 429, 403                  -> { status: 'retry', error }
 *   401 (session terminee)                      -> { status: 'retry', error, auth: true }
 *   autres 4xx (dont 404 « Étiquette inconnue ») -> { status: 'rejected', error: message du serveur, response }
 * Ecarts volontaires, pour ne rien perdre : un 404/405 SANS corps JSON (route absente, mandataire, ancien serveur) est
 * un « retry » ; un 500/501 (`itemError: true`) n'arrete pas la vidange (un item « empoisonne » ne bloque pas les autres).
 * api() appelle son gestionnaire global sur 401 : c'est voulu (l'application revient a l'ecran de connexion).
 */
export function makeSend(api) {
  return async function send(item, { signal, timeoutMs } = {}) {
    const path = ROUTES[item?.kind];
    if (!path) return { status: 'rejected', error: 'Type d’envoi inconnu' };
    const res = await api(path, {
      method: 'POST',
      body: item.payload,
      signal,
      timeoutMs: timeoutMs ?? SEND_TIMEOUT_MS,
    });
    return interpretResponse(res);
  };
}

/** Traduit la reponse de api() ({ ok, status, data, error, network }) en resultat d'envoi. Exporte pour les tests. */
export function interpretResponse(res) {
  if (res.network || !res.status) return { status: 'retry', error: res.error || 'Pas de réseau' };
  if (res.ok) return { status: 'sent', response: res.data };
  const message = serverMessage(res);
  if (res.status === 401) return { status: 'retry', error: message, auth: true };
  if (res.status === 403 || res.status === 408 || res.status === 429) return { status: 'retry', error: message };
  if (res.status >= 500) {
    const result = { status: 'retry', error: message };
    if (res.status === 500 || res.status === 501) result.itemError = true;
    return result;
  }
  if (res.status >= 400) {
    const hasServerMessage = typeof res.data?.error === 'string' && res.data.error !== '';
    // une route absente ou un mandataire qui repond 404/405 en HTML : ce n'est pas un refus du serveur du PSIM
    if ((res.status === 404 || res.status === 405) && !hasServerMessage) return { status: 'retry', error: message };
    return { status: 'rejected', error: message, response: res.data };
  }
  // 1xx / 3xx inattendus : on garde l'item et on reessaiera
  return { status: 'retry', error: message };
}

function serverMessage(res) {
  const fromServer = res.data?.error;
  if (typeof fromServer === 'string' && fromServer !== '') return fromServer;
  return res.error || `Erreur ${res.status}`;
}

// ---------------------------------------------------------------------------------------------------------------
// File d'attente

/**
 * @param {object} options
 * @param {{getAll, put, delete, clear}} options.store  stockage (idbStore() en production, memoryStore() en test)
 * @param {(item, ctx?: {signal, timeoutMs}) => Promise<{status, response?, error?, auth?}>} options.send  transport
 * @param {() => number} [options.now]  horloge (injectable)
 * @param {(state: {count, kinds}) => void} [options.onChange]
 * @param {(item, outcome: 'sent'|'rejected', response) => void} [options.onResult]
 * @param {object} [options.env]  pour les tests : setTimeout, clearTimeout, setInterval, clearInterval, target, doc
 */
export function createQueue({ store, send, now = Date.now, onChange, onResult, env = {} } = {}) {
  if (!store || typeof send !== 'function') throw new TypeError('createQueue : store et send sont obligatoires');

  const safe = resilientStore(store);
  const timers = {
    setTimeout: (fn, ms) => (env.setTimeout ?? globalThis.setTimeout)(fn, ms),
    clearTimeout: (id) => (env.clearTimeout ?? globalThis.clearTimeout)(id),
    setInterval: (fn, ms) => (env.setInterval ?? globalThis.setInterval)(fn, ms),
    clearInterval: (id) => (env.clearInterval ?? globalThis.clearInterval)(id),
  };

  const changeListeners = new Set();
  const resultListeners = new Set();
  if (typeof onChange === 'function') changeListeners.add(onChange);
  if (typeof onResult === 'function') resultListeners.add(onResult);

  /** clientId -> { kind, username } : miroir leger du stockage, pour count() synchrone et les gardes. */
  let meta = new Map();
  let lastSignature = '0|0|0|0';

  // -- Ecouteurs (une erreur d'interface ne doit jamais casser la file) --
  function snapshot() {
    const kinds = { scan: 0, logbook: 0, sos: 0 };
    for (const { kind } of meta.values()) if (kind in kinds) kinds[kind] += 1;
    return { count: meta.size, kinds };
  }

  function emitChange() {
    const state = snapshot();
    const signature = `${state.count}|${state.kinds.scan}|${state.kinds.logbook}|${state.kinds.sos}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    for (const listener of [...changeListeners]) {
      try {
        listener(state);
      } catch {
        // ecouteur defaillant : ignore
      }
    }
  }

  function emitResult(item, outcome, response) {
    for (const listener of [...resultListeners]) {
      try {
        listener(item, outcome, response);
      } catch {
        // ecouteur defaillant : ignore
      }
    }
  }

  // -- Exclusion mutuelle des acces au stockage (jamais imbriquee) --
  let chain = Promise.resolve();
  function locked(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }

  /** Relit le stockage et recale le miroir. A n'appeler que sous `locked`. */
  async function readAll() {
    const items = await safe.getAll();
    meta = new Map(items.map((item) => [item.clientId, { kind: item.kind, username: item.username ?? null }]));
    emitChange();
    return items;
  }

  // -- Tentative d'envoi d'UN item --
  /** clientId -> Promise<outcome> : un item n'est jamais en cours d'envoi deux fois a la fois. */
  const inflight = new Map();

  function timeoutFor(item) {
    return item.kind === 'logbook' && item.payload?.photo ? PHOTO_SEND_TIMEOUT_MS : SEND_TIMEOUT_MS;
  }

  async function callSend(item) {
    const timeoutMs = timeoutFor(item);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    const hardStop = new Promise((resolve) => {
      timer = timers.setTimeout(() => {
        controller?.abort();
        resolve({ status: 'retry', error: 'Délai dépassé' });
      }, timeoutMs + HARD_TIMEOUT_GRACE_MS);
    });
    const call = (async () => {
      try {
        return await send(item, { signal: controller?.signal, timeoutMs });
      } catch (err) {
        return { status: 'retry', error: errorMessage(err, 'Envoi impossible') };
      }
    })();
    try {
      return await Promise.race([call, hardStop]);
    } finally {
      timers.clearTimeout(timer);
    }
  }

  /** Applique le resultat d'un envoi au stockage. */
  async function settle(item, raw) {
    const result = raw && typeof raw === 'object' ? raw : { status: 'retry', error: 'Réponse illisible' };
    const id = item.clientId;
    if (result.status === 'sent' || result.status === 'rejected') {
      const outcome = result.status;
      await locked(async () => {
        await safe.delete(id);
        meta.delete(id);
        emitChange();
      });
      emitResult(item, outcome, result.response);
      return {
        status: outcome,
        sent: outcome === 'sent',
        rejected: outcome === 'rejected',
        response: result.response,
        error: outcome === 'rejected' ? String(result.error || 'Refusé par le serveur') : undefined,
      };
    }
    const error = String(result.error || 'Envoi impossible');
    await locked(async () => {
      // l'item peut avoir ete efface (fin de service, autre agent) pendant l'envoi : on ne le ressuscite pas
      if (!meta.has(id)) return;
      const updated = { ...item, attempts: (item.attempts ?? 0) + 1, lastError: error };
      await safe.put(updated);
    });
    return {
      status: 'retry',
      sent: false,
      rejected: false,
      error,
      auth: result.auth === true,
      itemError: result.itemError === true,
    };
  }

  function attempt(item) {
    const existing = inflight.get(item.clientId);
    if (existing) return existing;
    const promise = (async () => {
      try {
        return await settle(item, await callSend(item));
      } finally {
        inflight.delete(item.clientId);
      }
    })();
    inflight.set(item.clientId, promise);
    return promise;
  }

  // -- API --

  /**
   * Ecrit l'item dans le stockage D'ABORD, tente de l'envoyer tout de suite et resout apres cette tentative
   * (10 s au plus : au-dela, l'envoi continue en arriere-plan et resout { sent: false } ; l'item reste en file).
   * Re-soumettre un clientId deja en file ne le duplique pas.
   */
  async function submit(kind, payload, { username: rawUsername = null } = {}) {
    const username = typeof rawUsername === 'string' && rawUsername !== '' ? rawUsername : null; // « » = agent inconnu
    if (!KINDS.includes(kind)) throw new TypeError(`Type d’envoi inconnu : ${String(kind)}`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Le contenu à envoyer doit être un objet');
    const clientId = typeof payload.clientId === 'string' && payload.clientId !== '' ? payload.clientId : uuid();
    const body = payload.clientId === clientId ? payload : { ...payload, clientId };

    let attemptPromise = inflight.get(clientId) ?? null;
    if (!attemptPromise) {
      const item = await locked(async () => {
        const existing = (await readAll()).find((i) => i.clientId === clientId);
        if (existing) return existing;
        const fresh = { clientId, kind, username, payload: body, createdAt: now(), attempts: 0, lastError: null };
        await safe.put(fresh);
        meta.set(clientId, { kind, username });
        emitChange();
        return fresh;
      });
      attemptPromise = attempt(item);
    }

    let waitTimer = null;
    const tooLong = new Promise((resolve) => {
      waitTimer = timers.setTimeout(() => resolve({ status: 'retry', sent: false, error: 'En attente du réseau' }), SUBMIT_WAIT_MS);
    });
    let outcome;
    try {
      outcome = await Promise.race([attemptPromise, tooLong]);
    } finally {
      timers.clearTimeout(waitTimer);
    }
    const result = { clientId, sent: outcome.sent === true };
    if (outcome.response !== undefined) result.response = outcome.response;
    if (outcome.error !== undefined) result.error = outcome.error;
    if (outcome.rejected) result.rejected = true;
    return result;
  }

  // -- Vidange --
  let running = null;
  /** Filtres demandes pendant une vidange en cours (une seule vidange a la fois ; un tour de plus au besoin). */
  let requested = [];

  async function pass(filter, seen, onlyUnseen) {
    const items = sortItems(await locked(readAll)).filter((item) => matchesFilter(item, filter));
    let sent = 0;
    let stopped = false;
    for (const item of items) {
      if (onlyUnseen && seen.has(item.clientId)) continue;
      if (!meta.has(item.clientId)) continue; // retire entre-temps (fin de service, autre agent, envoi concurrent)
      seen.add(item.clientId);
      const outcome = await attempt(item);
      if (outcome.sent) sent += 1;
      // premiere erreur qui touche tout le monde (reseau, session, serveur) : inutile d'insister sur les suivants
      if (outcome.status === 'retry' && !outcome.itemError) {
        stopped = true;
        break;
      }
    }
    return { sent, stopped };
  }

  async function countMatching(filter) {
    const items = await locked(readAll);
    return items.filter((item) => matchesFilter(item, filter)).length;
  }

  async function drain(first) {
    const seen = new Set();
    let sent = 0;
    let filters = [first];
    let onlyUnseen = false;
    for (let round = 0; round < MAX_PASSES && filters.length > 0; round += 1) {
      requested = [];
      let stopped = false;
      for (const filter of filters) {
        const result = await pass(filter, seen, onlyUnseen);
        sent += result.sent;
        if (result.stopped) {
          stopped = true;
          break;
        }
      }
      // un flush demande pendant la vidange : on refait un tour. Si la liaison a lache, tout est a retenter
      // (elle est peut-etre revenue) ; sinon seuls les items apparus depuis comptent.
      filters = requested;
      onlyUnseen = !stopped;
    }
    requested = [];
    return { sent, remaining: await countMatching(first) };
  }

  /**
   * Vide la file. Une seule vidange a la fois : un appel pendant une vidange renvoie la meme promesse, et fait
   * refaire un tour a la fin. Ordre : SOS d'abord, puis par date. S'arrete a la premiere erreur qui toucherait tous
   * les suivants. `kinds` et `username` restreignent les items traites. -> { sent, remaining } (selon le filtre)
   */
  function flush(opts = {}) {
    const filter = normalizeFilter(opts);
    if (running) {
      if (!requested.some((f) => filterKey(f) === filterKey(filter))) requested.push(filter);
      return running;
    }
    const promise = drain(filter).finally(() => {
      if (running === promise) running = null;
    });
    running = promise;
    return promise;
  }

  async function pending() {
    return sortItems(await locked(readAll));
  }

  /** Recale le compteur sur le stockage (au demarrage, ou apres un changement fait par un autre onglet). */
  async function refresh() {
    await locked(readAll);
    return meta.size;
  }

  function count() {
    return meta.size;
  }

  /** Efface TOUT (fin de service). */
  function clear() {
    return locked(async () => {
      await safe.clear();
      meta = new Map();
      emitChange();
    });
  }

  /** Efface les items d'un AUTRE agent (telephone partage). Les items sans agent connu sont gardes. -> nombre efface */
  function discardForeign(username) {
    return locked(async () => {
      const items = await readAll();
      let removed = 0;
      for (const item of items) {
        if (!item.username || item.username === username) continue;
        await safe.delete(item.clientId);
        meta.delete(item.clientId);
        removed += 1;
      }
      emitChange();
      return removed;
    });
  }

  // -- Declencheurs --
  let started = null;

  /**
   * Demarre la vidange automatique : au demarrage, toutes les `intervalMs` (15 s), au retour du reseau (`online`)
   * et au retour au premier plan. `username` (texte, ou fonction qui le donne) limite la vidange a cet agent.
   */
  function start({ intervalMs = DEFAULT_INTERVAL_MS, username } = {}) {
    if (started) return;
    const target = env.target ?? globalThis.window ?? globalThis;
    const doc = env.doc ?? globalThis.document;
    const tick = () => {
      const name = typeof username === 'function' ? username() : username;
      flush(name ? { username: name } : {}).catch(() => {});
    };
    const onVisible = () => {
      if (!doc || doc.visibilityState === 'visible') tick();
    };
    const intervalId = timers.setInterval(tick, intervalMs);
    target.addEventListener?.('online', tick);
    doc?.addEventListener?.('visibilitychange', onVisible);
    started = () => {
      timers.clearInterval(intervalId);
      target.removeEventListener?.('online', tick);
      doc?.removeEventListener?.('visibilitychange', onVisible);
    };
    refresh().catch(() => {});
    tick();
  }

  function stop() {
    if (!started) return;
    const detach = started;
    started = null;
    detach();
  }

  /** Ajoute des ecouteurs supplementaires ; renvoie la fonction qui les retire. */
  function subscribe({ onChange: change, onResult: result } = {}) {
    if (typeof change === 'function') changeListeners.add(change);
    if (typeof result === 'function') resultListeners.add(result);
    return () => {
      if (change) changeListeners.delete(change);
      if (result) resultListeners.delete(result);
    };
  }

  return {
    submit,
    flush,
    pending,
    count,
    refresh,
    clear,
    discardForeign,
    start,
    stop,
    subscribe,
    /** true si le stockage principal a echoue au moins une fois (des items ont pu rester en memoire seulement). */
    isDegraded: () => safe.isDegraded(),
    /** Etat courant { count, kinds }. */
    state: snapshot,
  };
}
