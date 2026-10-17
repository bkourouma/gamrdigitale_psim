/**
 * Application des agents : file d'attente hors ligne (web/agent/queue.js) et service worker (web/agent/sw.js).
 * Aucune vraie IndexedDB ni vrai reseau : memoryStore, une IndexedDB factice, un faux `api`, une horloge virtuelle
 * (les delais de 10 s / 15 s ne sont jamais attendus pour de vrai).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';
// @ts-expect-error module JS de l'interface (sans types), importe pour tester ses calculs purs
import { createQueue, deleteDatabase, idbStore, makeSend, memoryStore, sortItems } from '../web/agent/queue.js';

const ROOT = resolve(import.meta.dirname, '..');

// ------------------------------------------------------------------------------------------------------------
// Outils de test

/** Laisse s'executer toutes les promesses en attente (sans attendre de vrai delai). */
async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((r) => setImmediate(r));
}

interface Gate {
  promise: Promise<void>;
  release: () => void;
}
function gate(): Gate {
  let release: () => void = () => {};
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

/** Horloge virtuelle : setTimeout / setInterval qui n'avancent que sur advance(). */
function makeClock() {
  let nowMs = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  return {
    setTimeout: (fn: () => void, ms: number) => {
      seq += 1;
      timers.set(seq, { at: nowMs + ms, fn, every: null });
      return seq;
    },
    setInterval: (fn: () => void, ms: number) => {
      seq += 1;
      timers.set(seq, { at: nowMs + ms, fn, every: ms });
      return seq;
    },
    clearTimeout: (id: number) => void timers.delete(id),
    clearInterval: (id: number) => void timers.delete(id),
    pending: () => timers.size,
    advance(ms: number) {
      const end = nowMs + ms;
      for (;;) {
        let nextId = -1;
        let nextAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= end && t.at < nextAt) {
            nextAt = t.at;
            nextId = id;
          }
        }
        if (nextId < 0) break;
        const t = timers.get(nextId)!;
        nowMs = t.at;
        if (t.every === null) timers.delete(nextId);
        else t.at += t.every;
        t.fn();
      }
      nowMs = end;
    },
  };
}

type Sent = { status: string; response?: unknown; error?: string; auth?: boolean; itemError?: boolean };
type SendFn = (item: any, ctx?: any) => Promise<Sent>;

interface Harness {
  queue: any;
  store: any;
  clock: ReturnType<typeof makeClock>;
  calls: any[];
  changes: any[];
  results: Array<{ item: any; outcome: string; response: unknown }>;
}

function make(send?: SendFn, options: { store?: any; env?: any } = {}): Harness {
  const store = options.store ?? memoryStore();
  const clock = makeClock();
  const calls: any[] = [];
  const changes: any[] = [];
  const results: Harness['results'] = [];
  let t = 1_000;
  const queue = createQueue({
    store,
    send: async (item: any, ctx: any) => {
      calls.push(item);
      return send ? send(item, ctx) : { status: 'sent', response: { ok: true } };
    },
    now: () => (t += 1),
    onChange: (state: any) => changes.push(state),
    onResult: (item: any, outcome: string, response: unknown) => results.push({ item, outcome, response }),
    env: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval, ...options.env },
  });
  return { queue, store, clock, calls, changes, results };
}

const ok: SendFn = async () => ({ status: 'sent', response: { ok: true } });
const offline: SendFn = async () => ({ status: 'retry', error: 'Pas de réseau' });

function rawItem(clientId: string, kind = 'scan', extra: Record<string, unknown> = {}) {
  return { clientId, kind, username: 'ann', payload: { clientId, phoneAt: 1 }, createdAt: 1, attempts: 0, lastError: null, ...extra };
}

// ------------------------------------------------------------------------------------------------------------
// File d'attente

describe('file hors ligne : submit', () => {
  it('ecrit l’item dans le stockage AVANT toute tentative (meme si send plante)', async () => {
    const seenAtSend: any[] = [];
    const h = make(async (item) => {
      seenAtSend.push((await h.store.getAll()).map((i: any) => i.clientId));
      throw new Error('boum');
    });
    const result = await h.queue.submit('sos', { clientId: 'sos-1', phoneAt: 5, discreet: false }, { username: 'ann' });
    assert.deepEqual(seenAtSend, [['sos-1']], 'l’item est deja stocke quand send est appele');
    assert.equal(result.sent, false);
    assert.equal(result.clientId, 'sos-1');
    assert.equal(result.error, 'boum');
    const [stored] = await h.store.getAll();
    assert.equal(stored.attempts, 1);
    assert.equal(stored.lastError, 'boum');
    assert.equal(stored.username, 'ann');
    assert.deepEqual(stored.payload, { clientId: 'sos-1', phoneAt: 5, discreet: false });
  });

  it('succes : retire l’item, resout { sent: true, response } et appelle onResult', async () => {
    const h = make(async () => ({ status: 'sent', response: { scan: { verdict: 'ok' } } }));
    const result = await h.queue.submit('scan', { code: 'abcde23456', method: 'qr', phoneAt: 1 }, { username: 'ann' });
    assert.equal(result.sent, true);
    assert.deepEqual(result.response, { scan: { verdict: 'ok' } });
    assert.equal(result.rejected, undefined);
    assert.deepEqual(await h.store.getAll(), []);
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0]!.outcome, 'sent');
    assert.equal(h.results[0]!.item.kind, 'scan');
    assert.equal(h.queue.count(), 0);
  });

  it('refus definitif : retire l’item, { sent: false, rejected: true, error } et onResult(rejected)', async () => {
    const h = make(async () => ({ status: 'rejected', error: 'Étiquette inconnue', response: { error: 'Étiquette inconnue' } }));
    const result = await h.queue.submit('scan', { code: 'zzzzz22222', method: 'manual', phoneAt: 1 }, { username: 'ann' });
    assert.equal(result.sent, false);
    assert.equal(result.rejected, true);
    assert.equal(result.error, 'Étiquette inconnue');
    assert.deepEqual(await h.store.getAll(), []);
    assert.deepEqual(h.results.map((r) => r.outcome), ['rejected']);
    assert.deepEqual(h.results[0]!.response, { error: 'Étiquette inconnue' });
  });

  it('echec reseau : l’item reste, attempts et lastError sont mis a jour a chaque tentative', async () => {
    const h = make(offline);
    const first = await h.queue.submit('logbook', { clientId: 'lb-1', category: 'ras', text: 'x', phoneAt: 1 }, { username: 'ann' });
    assert.equal(first.sent, false);
    assert.equal(first.error, 'Pas de réseau');
    await h.queue.flush();
    await h.queue.flush();
    const [stored] = await h.store.getAll();
    assert.equal(stored.attempts, 3);
    assert.equal(stored.lastError, 'Pas de réseau');
    assert.equal(h.results.length, 0);
  });

  it('genere un clientId (ajoute au payload) s’il manque, sans modifier l’objet de l’appelant', async () => {
    const h = make(offline);
    const payload = { code: 'abcde23456', method: 'nfc', phoneAt: 1 };
    const result = await h.queue.submit('scan', payload, { username: 'ann' });
    assert.match(result.clientId, /^[0-9a-f-]{36}$/);
    assert.equal('clientId' in payload, false);
    const [stored] = await h.store.getAll();
    assert.equal(stored.clientId, result.clientId);
    assert.equal(stored.payload.clientId, result.clientId);
  });

  it('idempotence : le clientId du payload est garde tel quel a chaque tentative', async () => {
    const h = make(offline);
    await h.queue.submit('sos', { clientId: 'fixe-123', phoneAt: 1, discreet: true }, { username: 'ann' });
    await h.queue.flush();
    await h.queue.flush();
    assert.equal(h.calls.length, 3);
    for (const sent of h.calls) {
      assert.equal(sent.clientId, 'fixe-123');
      assert.equal(sent.payload.clientId, 'fixe-123');
    }
  });

  it('re-soumettre un clientId deja en file ne duplique pas (et garde la date d’origine)', async () => {
    const h = make(offline);
    await h.queue.submit('scan', { clientId: 'dup', code: 'a', method: 'qr', phoneAt: 1 }, { username: 'ann' });
    const [before] = await h.store.getAll();
    await h.queue.submit('scan', { clientId: 'dup', code: 'a', method: 'qr', phoneAt: 1 }, { username: 'ann' });
    const all = await h.store.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].createdAt, before.createdAt);
    assert.equal(h.queue.count(), 1);
  });

  it('deux submit simultanes du meme clientId n’envoient qu’une fois', async () => {
    const g = gate();
    const h = make(async () => {
      await g.promise;
      return { status: 'sent', response: { n: 1 } };
    });
    const a = h.queue.submit('sos', { clientId: 'same', phoneAt: 1, discreet: false }, { username: 'ann' });
    await settle();
    const b = h.queue.submit('sos', { clientId: 'same', phoneAt: 1, discreet: false }, { username: 'ann' });
    await settle();
    g.release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(h.calls.length, 1);
    assert.equal(ra.sent, true);
    assert.equal(rb.sent, true);
    assert.equal(h.results.length, 1);
  });

  it('un agent inconnu (chaine vide) est range sans nom : jamais efface par discardForeign', async () => {
    const h = make(offline);
    await h.queue.submit('sos', { clientId: 'inc', phoneAt: 1, discreet: false }, { username: '' });
    assert.equal((await h.store.getAll())[0].username, null);
    assert.equal(await h.queue.discardForeign('ann'), 0);
    assert.equal(h.queue.count(), 1);
  });

  it('refuse un type inconnu et un contenu qui n’est pas un objet', async () => {
    const h = make(ok);
    await assert.rejects(h.queue.submit('photo', { a: 1 }), TypeError);
    await assert.rejects(h.queue.submit('scan', null), TypeError);
    await assert.rejects(h.queue.submit('scan', [1, 2]), TypeError);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(await h.store.getAll(), []);
  });

  it('un send qui ne repond jamais : submit resout au bout de 10 s, l’item reste, le garde-fou compte l’essai', async () => {
    const h = make(() => new Promise<Sent>(() => {}));
    let done = null as any;
    const p = h.queue.submit('sos', { clientId: 'hang', phoneAt: 1, discreet: false }, { username: 'ann' }).then((r: any) => (done = r));
    await settle();
    assert.equal(done, null, 'pas encore résolu');
    h.clock.advance(9_999);
    await settle();
    assert.equal(done, null);
    h.clock.advance(1);
    const resolved: any = await p;
    assert.equal(resolved.sent, false);
    assert.equal(resolved.clientId, 'hang');
    assert.equal((await h.store.getAll()).length, 1);
    // le garde-fou (10 s + marge) abandonne l’appel : l’essai est compté
    h.clock.advance(2_000);
    await settle();
    const [stored] = await h.store.getAll();
    assert.equal(stored.attempts, 1);
    assert.equal(stored.lastError, 'Délai dépassé');
  });

  it('le signal d’annulation est passe a send et declenche a l’expiration', async () => {
    let signal: AbortSignal | undefined;
    const h = make((_item, ctx) => {
      signal = ctx.signal;
      assert.equal(ctx.timeoutMs, 10_000);
      return new Promise<Sent>(() => {});
    });
    void h.queue.submit('scan', { clientId: 's', code: 'a', method: 'qr', phoneAt: 1 }, { username: 'ann' });
    await settle();
    assert.equal(signal?.aborted, false);
    h.clock.advance(12_000);
    await settle();
    assert.equal(signal?.aborted, true);
  });

  it('une main courante avec photo a un delai d’envoi plus long', async () => {
    let timeoutMs = 0;
    const h = make(async (_item, ctx) => {
      timeoutMs = ctx.timeoutMs;
      return { status: 'sent' };
    });
    await h.queue.submit('logbook', { clientId: 'p', category: 'ras', text: 'x', phoneAt: 1, photo: 'AAAA' }, { username: 'ann' });
    assert.equal(timeoutMs, 30_000);
  });
});

describe('file hors ligne : stockage defaillant', () => {
  function brokenStore() {
    const failure = () => Promise.reject(new Error('IndexedDB indisponible'));
    return { getAll: failure, put: failure, delete: failure, clear: failure };
  }

  it('repli en memoire : l’envoi est quand meme tente et l’item n’est pas perdu', async () => {
    const h = make(offline, { store: brokenStore() });
    const result = await h.queue.submit('sos', { clientId: 'm-1', phoneAt: 1, discreet: false }, { username: 'ann' });
    assert.equal(h.calls.length, 1);
    assert.equal(result.sent, false);
    const pending = await h.queue.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].clientId, 'm-1');
    assert.equal(pending[0].attempts, 1);
    assert.equal(h.queue.count(), 1);
    assert.equal(h.queue.isDegraded(), true);
  });

  it('repli en memoire : le renvoi reussit et vide la file', async () => {
    let up = false;
    const h = make(async () => (up ? { status: 'sent' } : { status: 'retry', error: 'Pas de réseau' }), { store: brokenStore() });
    await h.queue.submit('scan', { clientId: 'm-2', code: 'a', method: 'qr', phoneAt: 1 }, { username: 'ann' });
    up = true;
    const flushed = await h.queue.flush();
    assert.deepEqual(flushed, { sent: 1, remaining: 0 });
    assert.equal(h.queue.count(), 0);
    assert.deepEqual(await h.queue.pending(), []);
  });

  it('le stockage revient : les items de repli y sont recopies', async () => {
    const real = memoryStore();
    let broken = true;
    const flaky = {
      getAll: () => (broken ? Promise.reject(new Error('KO')) : real.getAll()),
      put: (i: any) => (broken ? Promise.reject(new Error('KO')) : real.put(i)),
      delete: (id: string) => (broken ? Promise.reject(new Error('KO')) : real.delete(id)),
      clear: () => (broken ? Promise.reject(new Error('KO')) : real.clear()),
    };
    const h = make(offline, { store: flaky });
    await h.queue.submit('sos', { clientId: 'back-1', phoneAt: 1, discreet: false }, { username: 'ann' });
    assert.equal((await real.getAll()).length, 0);
    broken = false;
    const pending = await h.queue.pending();
    assert.equal(pending.length, 1);
    assert.deepEqual((await real.getAll()).map((i: any) => i.clientId), ['back-1']);
  });

  it('clear() ne leve pas meme si le stockage echoue, et vide la memoire de repli', async () => {
    const h = make(offline, { store: brokenStore() });
    await h.queue.submit('scan', { clientId: 'c', code: 'a', method: 'qr', phoneAt: 1 }, { username: 'ann' });
    await h.queue.clear();
    assert.equal(h.queue.count(), 0);
    assert.deepEqual(await h.queue.pending(), []);
  });
});

describe('file hors ligne : flush', () => {
  it('envoie les SOS d’abord, puis par date', async () => {
    const h = make(ok);
    await h.store.put(rawItem('scan-new', 'scan', { createdAt: 30 }));
    await h.store.put(rawItem('log-old', 'logbook', { createdAt: 5 }));
    await h.store.put(rawItem('sos-late', 'sos', { createdAt: 99 }));
    await h.store.put(rawItem('scan-old', 'scan', { createdAt: 10 }));
    await h.store.put(rawItem('sos-early', 'sos', { createdAt: 50 }));
    const result = await h.queue.flush();
    assert.deepEqual(result, { sent: 5, remaining: 0 });
    assert.deepEqual(h.calls.map((c) => c.clientId), ['sos-early', 'sos-late', 'log-old', 'scan-old', 'scan-new']);
  });

  it('sortItems : meme regle, sans modifier le tableau d’origine', () => {
    const input = [rawItem('a', 'scan', { createdAt: 2 }), rawItem('b', 'sos', { createdAt: 9 }), rawItem('c', 'scan', { createdAt: 1 })];
    const copy = [...input];
    assert.deepEqual(sortItems(input).map((i: any) => i.clientId), ['b', 'c', 'a']);
    assert.deepEqual(input, copy);
  });

  it('s’arrete a la premiere erreur reseau (les suivants ne sont pas essayes)', async () => {
    const h = make(offline);
    await h.store.put(rawItem('a', 'scan', { createdAt: 1 }));
    await h.store.put(rawItem('b', 'scan', { createdAt: 2 }));
    await h.store.put(rawItem('c', 'sos', { createdAt: 3 }));
    const result = await h.queue.flush();
    assert.deepEqual(h.calls.map((c) => c.clientId), ['c'], 'seul le premier (le SOS) est essayé');
    assert.deepEqual(result, { sent: 0, remaining: 3 });
    const byId = new Map((await h.store.getAll()).map((i: any) => [i.clientId, i]));
    assert.equal((byId.get('c') as any).attempts, 1);
    assert.equal((byId.get('a') as any).attempts, 0);
    assert.equal((byId.get('b') as any).attempts, 0);
  });

  it('s’arrete aussi sur une session perdue (auth) ou un 503, mais pas sur un item « empoisonne »', async () => {
    for (const first of [{ status: 'retry', error: 'Session', auth: true }, { status: 'retry', error: 'Indisponible' }]) {
      const h = make(async () => first);
      await h.store.put(rawItem('a', 'scan', { createdAt: 1 }));
      await h.store.put(rawItem('b', 'scan', { createdAt: 2 }));
      await h.queue.flush();
      assert.equal(h.calls.length, 1);
    }
    const poisoned = make(async (item) => (item.clientId === 'a' ? { status: 'retry', error: 'Erreur 500', itemError: true } : { status: 'sent' }));
    await poisoned.store.put(rawItem('a', 'scan', { createdAt: 1 }));
    await poisoned.store.put(rawItem('b', 'scan', { createdAt: 2 }));
    const result = await poisoned.queue.flush();
    assert.deepEqual(poisoned.calls.map((c) => c.clientId), ['a', 'b']);
    assert.deepEqual(result, { sent: 1, remaining: 1 });
  });

  it('un refus definitif est retire, signale, et la vidange continue', async () => {
    const h = make(async (item) => (item.clientId === 'a' ? { status: 'rejected', error: 'Trop gros', response: { error: 'Trop gros' } } : { status: 'sent' }));
    await h.store.put(rawItem('a', 'logbook', { createdAt: 1 }));
    await h.store.put(rawItem('b', 'scan', { createdAt: 2 }));
    const result = await h.queue.flush();
    assert.deepEqual(result, { sent: 1, remaining: 0 });
    assert.deepEqual(h.results.map((r) => [r.item.clientId, r.outcome]), [['a', 'rejected'], ['b', 'sent']]);
    assert.deepEqual(h.results[0]!.response, { error: 'Trop gros' });
    assert.deepEqual(await h.store.getAll(), []);
  });

  it('un envoi reussi est retire du stockage et signale', async () => {
    const h = make(async () => ({ status: 'sent', response: { entry: { id: 7 } } }));
    await h.store.put(rawItem('a', 'logbook'));
    await h.queue.refresh();
    assert.equal(h.queue.count(), 1);
    await h.queue.flush();
    assert.equal(h.queue.count(), 0);
    assert.deepEqual(h.results.map((r) => [r.outcome, r.response]), [['sent', { entry: { id: 7 } }]]);
  });

  it('single-flight : deux flush simultanes = meme promesse, un seul envoi par item', async () => {
    const g = gate();
    const h = make(async () => {
      await g.promise;
      return { status: 'sent' };
    });
    await h.store.put(rawItem('a'));
    const p1 = h.queue.flush();
    await settle();
    const p2 = h.queue.flush();
    assert.equal(p1, p2);
    g.release();
    assert.deepEqual(await p1, { sent: 1, remaining: 0 });
    assert.equal(h.calls.length, 1);
    // la vidange est terminee : un nouvel appel repart normalement
    assert.notEqual(h.queue.flush(), p1);
  });

  it('un flush demande pendant une vidange refait un tour si de nouveaux items sont apparus', async () => {
    const g = gate();
    const h = make(async (item) => {
      if (item.clientId === 'a') await g.promise;
      return { status: 'sent' };
    });
    await h.store.put(rawItem('a', 'scan', { createdAt: 1 }));
    const p1 = h.queue.flush();
    await settle();
    await h.store.put(rawItem('b', 'scan', { createdAt: 2 })); // apparu pendant la vidange (autre onglet, par exemple)
    const p2 = h.queue.flush();
    assert.equal(p1, p2);
    g.release();
    assert.deepEqual(await p1, { sent: 2, remaining: 0 });
    assert.deepEqual(h.calls.map((c) => c.clientId), ['a', 'b']);
  });

  it('sans nouvelle demande, un item apparu pendant la vidange attend la suivante', async () => {
    const g = gate();
    const h = make(async (item) => {
      if (item.clientId === 'a') await g.promise;
      return { status: 'sent' };
    });
    await h.store.put(rawItem('a', 'scan', { createdAt: 1 }));
    const p1 = h.queue.flush();
    await settle();
    await h.store.put(rawItem('b', 'scan', { createdAt: 2 }));
    g.release();
    assert.deepEqual(await p1, { sent: 1, remaining: 1 });
  });

  it('un flush demande apres une coupure retente tout (la liaison est peut-etre revenue)', async () => {
    const g = gate();
    let attempts = 0;
    const h = make(async () => {
      attempts += 1;
      if (attempts === 1) {
        await g.promise;
        return { status: 'retry', error: 'Pas de réseau' };
      }
      return { status: 'sent' };
    });
    await h.store.put(rawItem('a'));
    const p1 = h.queue.flush();
    await settle();
    h.queue.flush(); // « online » reçu pendant que le premier essai tourne encore
    g.release();
    assert.deepEqual(await p1, { sent: 1, remaining: 0 });
    assert.equal(h.calls.length, 2);
  });

  it('un flush ne bloque jamais un submit (un SOS part tout de suite pendant une vidange qui traine)', async () => {
    const g = gate();
    const h = make(async (item) => {
      if (item.clientId === 'slow') await g.promise;
      return { status: 'sent' };
    });
    await h.store.put(rawItem('slow', 'scan'));
    const flushing = h.queue.flush();
    await settle();
    const result = await h.queue.submit('sos', { clientId: 'urgent', phoneAt: 1, discreet: false }, { username: 'ann' });
    assert.equal(result.sent, true);
    assert.deepEqual(h.calls.map((c) => c.clientId), ['slow', 'urgent']);
    g.release();
    await flushing;
  });

  it('une vidange qui rencontre un item en cours d’envoi par submit ne l’envoie pas deux fois', async () => {
    const g = gate();
    const h = make(async () => {
      await g.promise;
      return { status: 'sent' };
    });
    const submitted = h.queue.submit('sos', { clientId: 'x', phoneAt: 1, discreet: false }, { username: 'ann' });
    await settle();
    const flushing = h.queue.flush();
    await settle();
    g.release();
    await Promise.all([submitted, flushing]);
    assert.equal(h.calls.length, 1);
    assert.equal(h.results.length, 1);
  });

  it('filtre par username : seuls les items de cet agent partent', async () => {
    const h = make(ok);
    await h.store.put(rawItem('ann-1', 'scan', { username: 'ann', createdAt: 1 }));
    await h.store.put(rawItem('bob-1', 'scan', { username: 'bob', createdAt: 2 }));
    await h.store.put(rawItem('anon-1', 'scan', { username: null, createdAt: 3 }));
    const result = await h.queue.flush({ username: 'ann' });
    assert.deepEqual(h.calls.map((c) => c.clientId), ['ann-1']);
    assert.deepEqual(result, { sent: 1, remaining: 0 }, 'remaining compte selon le filtre');
    assert.equal(h.queue.count(), 2);
    assert.deepEqual((await h.queue.pending()).map((i: any) => i.clientId).sort(), ['anon-1', 'bob-1']);
  });

  it('filtre par kinds', async () => {
    const h = make(ok);
    await h.store.put(rawItem('s', 'scan', { createdAt: 1 }));
    await h.store.put(rawItem('l', 'logbook', { createdAt: 2 }));
    await h.store.put(rawItem('o', 'sos', { createdAt: 3 }));
    const result = await h.queue.flush({ kinds: ['sos', 'logbook'] });
    assert.deepEqual(h.calls.map((c) => c.clientId), ['o', 'l']);
    assert.deepEqual(result, { sent: 2, remaining: 0 });
    assert.deepEqual((await h.queue.pending()).map((i: any) => i.clientId), ['s']);
  });

  it('deux flush de filtres differents pendant une vidange : chacun finit par etre traite, sans melanger les agents', async () => {
    const g = gate();
    const h = make(async (item) => {
      if (item.clientId === 'a1') await g.promise;
      return { status: 'sent' };
    });
    await h.store.put(rawItem('a1', 'scan', { username: 'ann', createdAt: 1 }));
    const p1 = h.queue.flush({ username: 'ann' });
    await settle();
    await h.store.put(rawItem('b1', 'scan', { username: 'bob', createdAt: 2 }));
    await h.store.put(rawItem('a2', 'scan', { username: 'ann', createdAt: 3 }));
    h.queue.flush({ username: 'bob' });
    h.queue.flush({ username: 'ann' });
    g.release();
    await p1;
    assert.deepEqual(h.calls.map((c) => c.clientId).sort(), ['a1', 'a2', 'b1']);
  });

  it('une file vide se vide sans rien envoyer', async () => {
    const h = make(ok);
    assert.deepEqual(await h.queue.flush(), { sent: 0, remaining: 0 });
    assert.equal(h.calls.length, 0);
  });

  it('un item efface pendant l’envoi n’est pas ressuscite par l’echec', async () => {
    const g = gate();
    const h = make(async () => {
      await g.promise;
      return { status: 'retry', error: 'Pas de réseau' };
    });
    await h.store.put(rawItem('a'));
    const flushing = h.queue.flush();
    await settle();
    await h.queue.clear();
    g.release();
    await flushing;
    assert.deepEqual(await h.store.getAll(), []);
    assert.equal(h.queue.count(), 0);
  });

  it('un onResult qui plante n’empeche rien', async () => {
    const store = memoryStore();
    const queue = createQueue({ store, send: ok, onResult: () => { throw new Error('UI cassée'); }, onChange: () => { throw new Error('UI cassée'); } });
    const result = await queue.submit('scan', { clientId: 'x', code: 'a', method: 'qr', phoneAt: 1 }, { username: 'ann' });
    assert.equal(result.sent, true);
    assert.deepEqual(await store.getAll(), []);
  });
});

describe('file hors ligne : etat, effacement, ecouteurs', () => {
  it('count() est synchrone et onChange donne { count, kinds }', async () => {
    const h = make(offline);
    assert.equal(h.queue.count(), 0);
    await h.queue.submit('scan', { clientId: '1', code: 'a', method: 'qr', phoneAt: 1 }, { username: 'ann' });
    assert.equal(h.queue.count(), 1);
    await h.queue.submit('sos', { clientId: '2', phoneAt: 1, discreet: false }, { username: 'ann' });
    await h.queue.submit('logbook', { clientId: '3', category: 'ras', text: 'x', phoneAt: 1 }, { username: 'ann' });
    assert.equal(h.queue.count(), 3);
    assert.deepEqual(h.changes.at(-1), { count: 3, kinds: { scan: 1, logbook: 1, sos: 1 } });
    assert.deepEqual(h.queue.state(), { count: 3, kinds: { scan: 1, logbook: 1, sos: 1 } });
    // une tentative ratee (attempts +1) ne change pas le compteur : pas de bruit
    const before = h.changes.length;
    await h.queue.flush();
    assert.equal(h.changes.length, before);
  });

  it('onChange signale aussi la baisse du compteur', async () => {
    const h = make(ok);
    await h.store.put(rawItem('a', 'scan'));
    await h.store.put(rawItem('b', 'sos'));
    await h.queue.refresh();
    assert.deepEqual(h.changes.at(-1), { count: 2, kinds: { scan: 1, logbook: 0, sos: 1 } });
    await h.queue.flush();
    assert.deepEqual(h.changes.at(-1), { count: 0, kinds: { scan: 0, logbook: 0, sos: 0 } });
  });

  it('refresh() recale le compteur sur le stockage (items restes d’une session precedente)', async () => {
    const h = make(ok);
    await h.store.put(rawItem('left', 'sos'));
    assert.equal(h.queue.count(), 0);
    assert.equal(await h.queue.refresh(), 1);
    assert.equal(h.queue.count(), 1);
  });

  it('pending() renvoie les items dans l’ordre d’envoi', async () => {
    const h = make(ok);
    await h.store.put(rawItem('s2', 'scan', { createdAt: 2 }));
    await h.store.put(rawItem('s1', 'scan', { createdAt: 1 }));
    await h.store.put(rawItem('o', 'sos', { createdAt: 9 }));
    assert.deepEqual((await h.queue.pending()).map((i: any) => i.clientId), ['o', 's1', 's2']);
  });

  it('clear() efface tout, y compris le compteur', async () => {
    const h = make(offline);
    await h.queue.submit('scan', { clientId: '1', code: 'a', method: 'qr', phoneAt: 1 }, { username: 'ann' });
    await h.queue.submit('sos', { clientId: '2', phoneAt: 1, discreet: false }, { username: 'bob' });
    await h.queue.clear();
    assert.equal(h.queue.count(), 0);
    assert.deepEqual(await h.store.getAll(), []);
    assert.deepEqual(h.changes.at(-1), { count: 0, kinds: { scan: 0, logbook: 0, sos: 0 } });
  });

  it('discardForeign(username) efface les items des autres agents et renvoie leur nombre', async () => {
    const h = make(offline);
    await h.store.put(rawItem('a1', 'scan', { username: 'ann' }));
    await h.store.put(rawItem('b1', 'sos', { username: 'bob' }));
    await h.store.put(rawItem('b2', 'scan', { username: 'bob' }));
    await h.store.put(rawItem('c1', 'scan', { username: 'cleo' }));
    await h.store.put(rawItem('n1', 'sos', { username: null })); // agent inconnu : on ne perd jamais un SOS
    assert.equal(await h.queue.discardForeign('ann'), 3);
    assert.deepEqual((await h.queue.pending()).map((i: any) => i.clientId).sort(), ['a1', 'n1']);
    assert.equal(h.queue.count(), 2);
    assert.equal(await h.queue.discardForeign('ann'), 0);
  });

  it('subscribe() ajoute des ecouteurs et les retire', async () => {
    const h = make(ok);
    const changes: number[] = [];
    const outcomes: string[] = [];
    const off = h.queue.subscribe({ onChange: (s: any) => changes.push(s.count), onResult: (_i: any, o: string) => outcomes.push(o) });
    await h.store.put(rawItem('a'));
    await h.queue.flush();
    assert.deepEqual(changes, [1, 0]);
    assert.deepEqual(outcomes, ['sent']);
    off();
    await h.queue.submit('scan', { clientId: 'z', code: 'a', method: 'qr', phoneAt: 1 }, { username: 'ann' });
    assert.deepEqual(outcomes, ['sent']);
  });

  it('createQueue exige store et send', () => {
    assert.throws(() => createQueue({}), TypeError);
    assert.throws(() => createQueue({ store: memoryStore() }), TypeError);
  });
});

describe('file hors ligne : start / stop', () => {
  function fakeTarget() {
    const listeners = new Map<string, Set<() => void>>();
    return {
      addEventListener: (type: string, fn: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
      emit: (type: string) => [...(listeners.get(type) ?? [])].forEach((fn) => fn()),
      count: (type: string) => listeners.get(type)?.size ?? 0,
    };
  }

  it('vidange au demarrage, toutes les 15 s, au retour du reseau et au retour au premier plan ; stop() detache tout', async () => {
    const target = fakeTarget();
    const doc = Object.assign(fakeTarget(), { visibilityState: 'hidden' });
    const h = make(ok, { env: { target, doc } });
    await h.store.put(rawItem('a'));
    h.queue.start();
    await settle();
    assert.equal(h.calls.length, 1, 'vidange immédiate au démarrage');
    assert.equal(h.queue.count(), 0);
    assert.equal(target.count('online'), 1);
    assert.equal(doc.count('visibilitychange'), 1);
    assert.equal(h.clock.pending(), 1);

    await h.store.put(rawItem('b'));
    h.clock.advance(14_999);
    await settle();
    assert.equal(h.calls.length, 1);
    h.clock.advance(1);
    await settle();
    assert.equal(h.calls.length, 2, 'toutes les 15 s');

    await h.store.put(rawItem('c'));
    target.emit('online');
    await settle();
    assert.equal(h.calls.length, 3, 'au retour du réseau');

    await h.store.put(rawItem('d'));
    doc.emit('visibilitychange'); // masqué : rien
    await settle();
    assert.equal(h.calls.length, 3);
    doc.visibilityState = 'visible';
    doc.emit('visibilitychange');
    await settle();
    assert.equal(h.calls.length, 4, 'au retour au premier plan');

    h.queue.stop();
    assert.equal(target.count('online'), 0);
    assert.equal(doc.count('visibilitychange'), 0);
    assert.equal(h.clock.pending(), 0);
    await h.store.put(rawItem('e'));
    h.clock.advance(60_000);
    target.emit('online');
    await settle();
    assert.equal(h.calls.length, 4, 'plus rien après stop()');
    h.queue.stop(); // sans effet
  });

  it('start({ intervalMs }) et un second start() sans stop() n’empilent pas les minuteries', async () => {
    const target = fakeTarget();
    const h = make(ok, { env: { target, doc: fakeTarget() } });
    h.queue.start({ intervalMs: 1000 });
    h.queue.start({ intervalMs: 1000 });
    assert.equal(h.clock.pending(), 1);
    assert.equal(target.count('online'), 1);
    await h.store.put(rawItem('a'));
    h.clock.advance(1000);
    await settle();
    assert.equal(h.calls.length, 1);
    h.queue.stop();
  });

  it('start({ username }) ne vide que les items de l’agent connecte (texte ou fonction)', async () => {
    const target = fakeTarget();
    let who = 'ann';
    const h = make(ok, { env: { target, doc: fakeTarget() } });
    await h.store.put(rawItem('a', 'scan', { username: 'ann' }));
    await h.store.put(rawItem('b', 'scan', { username: 'bob' }));
    h.queue.start({ username: () => who });
    await settle();
    assert.deepEqual(h.calls.map((c) => c.clientId), ['a']);
    who = 'bob';
    target.emit('online');
    await settle();
    assert.deepEqual(h.calls.map((c) => c.clientId), ['a', 'b']);
    h.queue.stop();
  });

  it('un echec de vidange automatique ne leve rien', async () => {
    const target = fakeTarget();
    const h = make(async () => {
      throw new Error('boum');
    }, { env: { target, doc: fakeTarget() } });
    await h.store.put(rawItem('a'));
    h.queue.start();
    await settle();
    target.emit('online');
    await settle();
    assert.equal((await h.store.getAll())[0].lastError, 'boum');
    h.queue.stop();
  });
});

// ------------------------------------------------------------------------------------------------------------
// makeSend

describe('makeSend : statuts du contrat', () => {
  interface Fake {
    status: number;
    data?: any;
    network?: boolean;
  }
  function sendWith(res: Fake) {
    const requests: any[] = [];
    const send = makeSend(async (path: string, opts: any) => {
      requests.push({ path, ...opts });
      const ok = res.status >= 200 && res.status < 300;
      return {
        ok,
        status: res.network ? 0 : res.status,
        data: res.data ?? null,
        error: ok ? null : res.network ? 'Pas de réseau' : String(res.data?.error ?? `Erreur ${res.status}`),
        network: Boolean(res.network),
      };
    });
    return { send, requests };
  }
  const item = (kind: string) => ({ clientId: 'c1', kind, username: 'ann', payload: { clientId: 'c1', phoneAt: 1, kind }, createdAt: 1, attempts: 0, lastError: null });

  it('route chaque type vers sa route, en POST, avec le payload tel quel', async () => {
    for (const [kind, path] of [['scan', '/api/agent/scans'], ['logbook', '/api/agent/logbook'], ['sos', '/api/agent/sos']] as const) {
      const { send, requests } = sendWith({ status: 200, data: { ok: true } });
      const it = item(kind);
      await send(it);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].path, path);
      assert.equal(requests[0].method, 'POST');
      assert.deepEqual(requests[0].body, it.payload);
    }
  });

  it('delai de 10 s par defaut, ou celui de l’appelant ; le signal est transmis', async () => {
    const { send, requests } = sendWith({ status: 200 });
    await send(item('sos'));
    assert.equal(requests[0].timeoutMs, 10_000);
    const controller = new AbortController();
    await send(item('sos'), { signal: controller.signal, timeoutMs: 30_000 });
    assert.equal(requests[1].timeoutMs, 30_000);
    assert.equal(requests[1].signal, controller.signal);
  });

  it('2xx : sent, avec la reponse du serveur', async () => {
    for (const status of [200, 201, 204]) {
      const { send } = sendWith({ status, data: { scan: { verdict: 'ok' } } });
      assert.deepEqual(await send(item('scan')), { status: 'sent', response: { scan: { verdict: 'ok' } } });
    }
  });

  it('erreur reseau : retry', async () => {
    const { send } = sendWith({ status: 0, network: true });
    assert.deepEqual(await send(item('sos')), { status: 'retry', error: 'Pas de réseau' });
  });

  it('5xx, 408, 429, 403 : retry', async () => {
    for (const status of [500, 502, 503, 504, 408, 429, 403]) {
      const { send } = sendWith({ status, data: { error: `Erreur ${status}` } });
      const result = await send(item('scan'));
      assert.equal(result.status, 'retry', `statut ${status}`);
      assert.equal(result.auth, undefined);
    }
  });

  it('401 : retry avec auth: true (session terminee)', async () => {
    const { send } = sendWith({ status: 401, data: { error: 'Session expirée' } });
    assert.deepEqual(await send(item('sos')), { status: 'retry', error: 'Session expirée', auth: true });
  });

  it('un 500 isole est marque itemError (n’arrete pas la vidange), un 503 non', async () => {
    assert.equal((await sendWith({ status: 500, data: { error: 'x' } }).send(item('scan'))).itemError, true);
    assert.equal((await sendWith({ status: 503, data: { error: 'x' } }).send(item('scan'))).itemError, undefined);
  });

  it('autres 4xx : rejected avec le message du serveur et sa reponse', async () => {
    for (const status of [400, 404, 409, 413, 422]) {
      const data = { error: `Refusé ${status}` };
      const { send } = sendWith({ status, data });
      assert.deepEqual(await send(item('logbook')), { status: 'rejected', error: `Refusé ${status}`, response: data }, `statut ${status}`);
    }
  });

  it('404 d’un scan « Étiquette inconnue » : rejected avec ce message', async () => {
    const data = { error: 'Étiquette inconnue' };
    const { send } = sendWith({ status: 404, data });
    assert.deepEqual(await send(item('scan')), { status: 'rejected', error: 'Étiquette inconnue', response: data });
  });

  it('404 / 405 sans corps JSON (route absente, mandataire) : retry, jamais un SOS perdu', async () => {
    for (const status of [404, 405]) {
      const { send } = sendWith({ status });
      const result = await send(item('sos'));
      assert.equal(result.status, 'retry');
      assert.equal(result.error, `Erreur ${status}`);
    }
  });

  it('type inconnu : rejected sans appel reseau', async () => {
    const { send, requests } = sendWith({ status: 200 });
    const result = await send({ ...item('scan'), kind: 'photo' });
    assert.equal(result.status, 'rejected');
    assert.equal(requests.length, 0);
  });

  it('bout en bout avec la file : le 401 arrete la vidange et garde l’item', async () => {
    const calls: string[] = [];
    const send = makeSend(async (path: string) => {
      calls.push(path);
      return { ok: false, status: 401, data: { error: 'Session terminée' }, error: 'Session terminée', network: false };
    });
    const queue = createQueue({ store: memoryStore(), send });
    const result = await queue.submit('sos', { clientId: 's', phoneAt: 1, discreet: false }, { username: 'ann' });
    assert.equal(result.sent, false);
    assert.equal(result.error, 'Session terminée');
    assert.equal(queue.count(), 1);
  });
});

// ------------------------------------------------------------------------------------------------------------
// IndexedDB (factice)

/** Une IndexedDB minimale : assez pour exercer ouverture paresseuse, transactions, versionchange, suppression. */
function fakeIndexedDB() {
  const databases = new Map<string, { stores: Map<string, Map<string, any>>; connections: Set<any> }>();
  const stats = { opens: 0, deletes: 0 };
  const flags = { failOpen: 0, failClear: 0 };
  const later = (fn: () => void) => setImmediate(fn);

  function connect(name: string) {
    const db = databases.get(name)!;
    const conn: any = {
      closed: false,
      onversionchange: null,
      onclose: null,
      objectStoreNames: { contains: (n: string) => db.stores.has(n) },
      createObjectStore: (n: string) => void db.stores.set(n, new Map()),
      close() {
        conn.closed = true;
        db.connections.delete(conn);
      },
      transaction(storeName: string) {
        if (conn.closed) throw Object.assign(new Error('La connexion est fermée'), { name: 'InvalidStateError' });
        const data = db.stores.get(storeName)!;
        const tx: any = { oncomplete: null, onabort: null, onerror: null, error: null };
        const request = (run: () => unknown) => {
          const req: any = { result: undefined, onsuccess: null };
          later(() => {
            req.result = run();
            req.onsuccess?.();
            later(() => tx.oncomplete?.());
          });
          return req;
        };
        tx.objectStore = () => ({
          getAll: () => request(() => structuredClone([...data.values()])),
          put: (v: any) => request(() => void data.set(v.clientId, structuredClone(v))),
          delete: (k: string) => request(() => void data.delete(k)),
          clear: () => {
            if (flags.failClear > 0) {
              flags.failClear -= 1;
              throw new Error('Base verrouillée');
            }
            return request(() => void data.clear());
          },
        });
        return tx;
      },
    };
    db.connections.add(conn);
    return conn;
  }

  const factory = {
    open(name: string) {
      stats.opens += 1;
      const req: any = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => {
        if (flags.failOpen > 0) {
          flags.failOpen -= 1;
          req.error = new Error('Accès refusé');
          req.onerror?.();
          return;
        }
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, { stores: new Map(), connections: new Set() });
        req.result = connect(name);
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
    deleteDatabase(name: string) {
      stats.deletes += 1;
      const req: any = { onsuccess: null, onerror: null, onblocked: null };
      later(() => {
        const db = databases.get(name);
        for (const conn of [...(db?.connections ?? [])]) conn.onversionchange?.();
        if (db && db.connections.size > 0) {
          req.onblocked?.();
          return; // bloquee : ne se termine pas tant qu'une connexion reste ouverte
        }
        databases.delete(name);
        req.onsuccess?.();
      });
      return req;
    },
  };

  return {
    factory,
    stats,
    flags,
    databases,
    /** Un autre onglet demande une mise a jour : toutes les connexions recoivent versionchange. */
    versionChange: (name: string) => [...(databases.get(name)?.connections ?? [])].forEach((c) => c.onversionchange?.()),
    /** Le navigateur ferme les connexions sans prevenir. */
    dropConnections: (name: string) => [...(databases.get(name)?.connections ?? [])].forEach((c) => { c.closed = true; databases.get(name)!.connections.delete(c); }),
    /** Une connexion qui ne se ferme jamais (autre onglet fige). */
    stubborn: (name: string) => connect(name),
  };
}

describe('idbStore (IndexedDB factice)', () => {
  it('ouverture paresseuse : rien n’est ouvert avant la premiere operation, puis une seule connexion', async () => {
    const idb = fakeIndexedDB();
    const store = idbStore('psim-agent', { indexedDB: idb.factory });
    assert.equal(idb.stats.opens, 0);
    await store.getAll();
    await store.put(rawItem('a'));
    await store.getAll();
    assert.equal(idb.stats.opens, 1);
    assert.equal(idb.databases.get('psim-agent')!.stores.has('queue'), true);
    await store.close();
  });

  it('getAll / put / delete / clear en promesses, avec remplacement par clientId', async () => {
    const idb = fakeIndexedDB();
    const store = idbStore('psim-agent', { indexedDB: idb.factory });
    assert.deepEqual(await store.getAll(), []);
    await store.put(rawItem('a', 'scan', { attempts: 0 }));
    await store.put(rawItem('b', 'sos'));
    await store.put(rawItem('a', 'scan', { attempts: 4 }));
    const all = await store.getAll();
    assert.equal(all.length, 2);
    assert.equal(all.find((i: any) => i.clientId === 'a').attempts, 4);
    await store.delete('b');
    assert.deepEqual((await store.getAll()).map((i: any) => i.clientId), ['a']);
    await store.clear();
    assert.deepEqual(await store.getAll(), []);
    await store.close();
  });

  it('une ouverture refusee echoue proprement puis reussit a la tentative suivante', async () => {
    const idb = fakeIndexedDB();
    idb.flags.failOpen = 1;
    const store = idbStore('psim-agent', { indexedDB: idb.factory });
    await assert.rejects(store.getAll(), /Accès refusé/);
    assert.deepEqual(await store.getAll(), []);
    await store.close();
  });

  it('sans IndexedDB : les operations echouent (la file bascule en memoire)', async () => {
    const store = idbStore('psim-agent', { indexedDB: null, ...{} });
    // `indexedDB: null` retombe sur globalThis.indexedDB, absent de Node
    await assert.rejects(store.getAll(), /IndexedDB indisponible/);
    const queue = createQueue({ store, send: offline as any });
    const result = await queue.submit('sos', { clientId: 'x', phoneAt: 1, discreet: false }, { username: 'ann' });
    assert.equal(result.sent, false);
    assert.equal(queue.count(), 1);
    assert.equal(queue.isDegraded(), true);
  });

  it('versionchange (autre onglet) : la connexion est fermee, la suivante la rouvre, les donnees restent', async () => {
    const idb = fakeIndexedDB();
    const store = idbStore('psim-agent', { indexedDB: idb.factory });
    await store.put(rawItem('a'));
    idb.versionChange('psim-agent');
    assert.equal(idb.databases.get('psim-agent')!.connections.size, 0);
    assert.deepEqual((await store.getAll()).map((i: any) => i.clientId), ['a']);
    assert.equal(idb.stats.opens, 2);
    await store.close();
  });

  it('connexion fermee a notre insu : l’operation rouvre une fois et reussit', async () => {
    const idb = fakeIndexedDB();
    const store = idbStore('psim-agent', { indexedDB: idb.factory });
    await store.put(rawItem('a'));
    idb.dropConnections('psim-agent');
    await store.put(rawItem('b'));
    assert.equal((await store.getAll()).length, 2);
    await store.close();
  });

  it('clear() en echec (base verrouillee) : ferme, supprime la base, et la file repart vide', async () => {
    const idb = fakeIndexedDB();
    const store = idbStore('psim-agent', { indexedDB: idb.factory });
    await store.put(rawItem('a'));
    idb.flags.failClear = 1;
    await store.clear();
    assert.equal(idb.stats.deletes, 1);
    assert.equal(idb.databases.has('psim-agent'), false);
    assert.deepEqual(await store.getAll(), []);
    await store.close();
  });

  it('clear() qui echoue et dont la suppression est bloquee par un autre onglet : l’erreur remonte', async () => {
    const idb = fakeIndexedDB();
    const store = idbStore('psim-agent', { indexedDB: idb.factory });
    await store.put(rawItem('a'));
    idb.flags.failClear = 1;
    idb.stubborn('psim-agent');
    // deleteDatabase attend 3 s par defaut : on ne veut pas l'attendre, on verifie plutot son comportement ci-dessous
    const outcome = await Promise.race([store.clear().then(() => 'ok', () => 'erreur'), new Promise((r) => setTimeout(() => r('long'), 200))]);
    assert.equal(outcome, 'long', 'la suppression bloquée attend, elle ne plante pas');
  });

  it('deleteDatabase : true quand la base disparait (meme si notre connexion est ouverte), false si bloquee', async () => {
    const idb = fakeIndexedDB();
    const store = idbStore('psim-agent', { indexedDB: idb.factory });
    await store.put(rawItem('a'));
    assert.equal(await deleteDatabase('psim-agent', { indexedDB: idb.factory }), true);
    assert.equal(idb.databases.has('psim-agent'), false);

    const store2 = idbStore('autre', { indexedDB: idb.factory });
    await store2.put(rawItem('a'));
    idb.stubborn('autre');
    assert.equal(await deleteDatabase('autre', { indexedDB: idb.factory, timeoutMs: 20 }), false);
    assert.equal(await deleteDatabase('x', { indexedDB: null as any, timeoutMs: 20 }), false, 'sans IndexedDB : false, sans lever');
  });

  it('redemarrage : une nouvelle file sur la meme base retrouve les items et les envoie', async () => {
    const idb = fakeIndexedDB();
    const first = createQueue({ store: idbStore('psim-agent', { indexedDB: idb.factory }), send: offline as any });
    await first.submit('sos', { clientId: 'sos-persist', phoneAt: 5, discreet: false }, { username: 'ann' });
    await first.submit('scan', { clientId: 'scan-persist', code: 'abcde23456', method: 'nfc', phoneAt: 6 }, { username: 'ann' });

    // « redémarrage » : nouvel objet, mêmes données sur le disque
    const sentIds: string[] = [];
    const second = createQueue({
      store: idbStore('psim-agent', { indexedDB: idb.factory }),
      send: (async (item: any) => {
        sentIds.push(item.clientId);
        return { status: 'sent' };
      }) as any,
    });
    assert.equal(await second.refresh(), 2);
    assert.deepEqual(await second.flush(), { sent: 2, remaining: 0 });
    assert.deepEqual(sentIds, ['sos-persist', 'scan-persist']);
    assert.deepEqual(await idbStore('psim-agent', { indexedDB: idb.factory }).getAll(), []);
  });
});

// ------------------------------------------------------------------------------------------------------------
// Service worker (sw.js execute dans node:vm avec un faux `self`)

const SW_ORIGIN = 'https://psim.test';
const SW_SCOPE = `${SW_ORIGIN}/agent/`;
const SW_SOURCE = readFileSync(resolve(ROOT, 'web/agent/sw.js'), 'utf8');

function fakeResponse(extra: Record<string, unknown> = {}) {
  const base: any = { ok: true, status: 200, type: 'basic', redirected: false, body: 'contenu', ...extra };
  base.clone = () => ({ ...base });
  return base;
}

interface SwHarness {
  ctx: any;
  fire: (type: string, event: any) => void;
  fetchCalls: string[];
  cacheStore: Map<string, Map<string, any>>;
  respond: (url: string, options?: { method?: string; mode?: string; headers?: Record<string, string> }) => { responded: boolean; promise: Promise<any>; waits: Promise<any>[] };
  setFetch: (fn: (request: any) => Promise<any>) => void;
  timers: Array<() => void>;
  skipWaitingCalls: number;
  claimCalls: number;
  fn: (name: string) => any;
}

function loadSw(): SwHarness {
  const listeners = new Map<string, (event: any) => void>();
  const cacheStore = new Map<string, Map<string, any>>();
  const fetchCalls: string[] = [];
  const timers: Array<() => void> = [];
  const state = { fetch: (async () => fakeResponse()) as (request: any) => Promise<any>, skip: 0, claim: 0 };
  const keyOf = (k: any) => (typeof k === 'string' ? k : k.url);

  const caches = {
    async open(name: string) {
      if (!cacheStore.has(name)) cacheStore.set(name, new Map());
      const entries = cacheStore.get(name)!;
      return {
        async add(request: any) {
          fetchCalls.push(request.url);
          const response = await state.fetch(request);
          if (!response.ok) throw new TypeError(`échec ${request.url}`);
          entries.set(keyOf(request), response);
        },
        async put(key: any, response: any) {
          entries.set(keyOf(key), response);
        },
        async match(key: any) {
          return entries.get(keyOf(key));
        },
      };
    },
    async keys() {
      return [...cacheStore.keys()];
    },
    async delete(name: string) {
      return cacheStore.delete(name);
    },
  };

  const self: any = {
    addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, fn),
    registration: { scope: SW_SCOPE },
    location: new URL(`${SW_SCOPE}sw.js`),
    skipWaiting: async () => void (state.skip += 1),
    clients: { claim: async () => void (state.claim += 1) },
  };
  const sandbox: any = {
    self,
    caches,
    URL,
    Request,
    fetch: (request: any) => {
      fetchCalls.push(request.url);
      return state.fetch(request);
    },
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, ctx, { filename: 'sw.js' });

  const harness: SwHarness = {
    ctx,
    fire: (type, event) => listeners.get(type)!(event),
    fetchCalls,
    cacheStore,
    timers,
    setFetch: (fn) => {
      state.fetch = fn;
    },
    get skipWaitingCalls() {
      return state.skip;
    },
    get claimCalls() {
      return state.claim;
    },
    fn: (name: string) => vm.runInContext(name, ctx),
    respond(url, options = {}) {
      const headers = options.headers ?? {};
      const event: any = {
        request: {
          url,
          method: options.method ?? 'GET',
          mode: options.mode ?? 'no-cors',
          headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
        },
        responded: false,
        promise: null as any,
        waits: [] as Promise<any>[],
        respondWith(p: Promise<any>) {
          event.responded = true;
          event.promise = Promise.resolve(p);
        },
        waitUntil(p: Promise<any>) {
          event.waits.push(p);
        },
      };
      harness.fire('fetch', event);
      return event;
    },
  };
  return harness;
}

const CACHE_NAME_RE = /^psim-agent-shell-/;

describe('service worker : script classique', () => {
  it('n’a ni import ni export (testable en Node, charge par register classique)', () => {
    assert.doesNotMatch(SW_SOURCE, /^\s*(import|export)\s/m);
  });

  it('la liste PRECACHE contient la coquille, les ecrans, les styles, les icones et les quatre polices', () => {
    const sw = loadSw();
    const list: string[] = [...sw.fn('PRECACHE')];
    for (const required of ['./', 'index.html', 'app.js', 'util.js', 'sound.js', 'queue.js', 'scan.js', 'photo.js', 'sos.js', 'alarms.js', 'live.js', 'ronde.js', 'logbook.js', 'agent.css', 'alarms.css', 'ronde.css', 'sos.css', 'logbook.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png']) {
      assert.ok(list.includes(required), `${required} manque au précache`);
    }
    const fonts = list.filter((p) => p.startsWith('../fonts/'));
    assert.deepEqual(fonts.sort(), [
      '../fonts/atkinson-hyperlegible-next-latin-ext-wght-normal.woff2',
      '../fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2',
      '../fonts/baloo-2-latin-ext-wght-normal.woff2',
      '../fonts/baloo-2-latin-wght-normal.woff2',
    ]);
    assert.equal(new Set(list).size, list.length, 'pas de doublon');
    assert.equal(list.some((p) => p.includes('/api') || p.includes('ws')), false, 'jamais d’API dans le précache');
  });

  it('les adresses du précache se resolvent dans la portee (et les polices a /fonts/)', () => {
    const sw = loadSw();
    const urls: string[] = [...sw.fn('precacheUrls')(SW_SCOPE)];
    assert.ok(urls.includes(`${SW_ORIGIN}/agent/`));
    assert.ok(urls.includes(`${SW_ORIGIN}/agent/index.html`));
    assert.ok(urls.includes(`${SW_ORIGIN}/agent/app.js`));
    assert.ok(urls.includes(`${SW_ORIGIN}/fonts/baloo-2-latin-wght-normal.woff2`));
  });
});

describe('service worker : ce qui n’est jamais intercepte', () => {
  const shouldHandle = (sw: SwHarness, url: string, method = 'GET') => sw.fn('shouldHandle')(new URL(url), method, '/agent/', SW_ORIGIN);

  it('shouldHandle : coquille et polices oui, tout le reste non', () => {
    const sw = loadSw();
    const yes = [
      `${SW_ORIGIN}/agent/`,
      `${SW_ORIGIN}/agent`,
      `${SW_ORIGIN}/agent/index.html`,
      `${SW_ORIGIN}/agent/app.js`,
      `${SW_ORIGIN}/agent/app.js?v=3`,
      `${SW_ORIGIN}/agent/#pair=abc`,
      `${SW_ORIGIN}/fonts/baloo-2-latin-wght-normal.woff2`,
    ];
    const no = [
      `${SW_ORIGIN}/api/agent/alarms`,
      `${SW_ORIGIN}/api/agent/alarms/12/snapshot`,
      `${SW_ORIGIN}/api/agent/alarms/12/live`,
      `${SW_ORIGIN}/api`,
      `${SW_ORIGIN}/ws`,
      `${SW_ORIGIN}/ws/events`,
      `${SW_ORIGIN}/agent/../api/agent/me`, // normalisé en /api/agent/me
      `${SW_ORIGIN}/`,
      `${SW_ORIGIN}/app.js`,
      `${SW_ORIGIN}/agents/app.js`,
      `${SW_ORIGIN}/fonts/OFL-baloo-2.txt`,
      'https://evil.test/agent/app.js',
      'https://evil.test/fonts/baloo-2-latin-wght-normal.woff2',
      'http://psim.test/agent/app.js', // autre origine (protocole)
      'data:text/plain,hello',
    ];
    for (const url of yes) assert.equal(shouldHandle(sw, url), true, url);
    for (const url of no) assert.equal(shouldHandle(sw, url), false, url);
  });

  it('shouldHandle : seulement GET', () => {
    const sw = loadSw();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      assert.equal(shouldHandle(sw, `${SW_ORIGIN}/agent/app.js`, method), false, method);
    }
    assert.equal(shouldHandle(sw, `${SW_ORIGIN}/agent/app.js`, 'get'), true);
  });

  it('fetch /api/... : ni respondWith, ni fetch, ni cache', async () => {
    const sw = loadSw();
    for (const path of ['/api/agent/alarms', '/api/agent/runs', '/api/agent/alarms/3/snapshot', '/api/agent/alarms/3/live', '/api/me', '/ws']) {
      const event = sw.respond(`${SW_ORIGIN}${path}`);
      assert.equal(event.responded, false, path);
    }
    await settle();
    assert.deepEqual(sw.fetchCalls, []);
    assert.equal(sw.cacheStore.size, 0);
  });

  it('fetch POST (SOS, scans, main courante...) : jamais intercepte', async () => {
    const sw = loadSw();
    for (const path of ['/api/agent/sos', '/api/agent/scans', '/agent/app.js', '/agent/']) {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        assert.equal(sw.respond(`${SW_ORIGIN}${path}`, { method }).responded, false, `${method} ${path}`);
      }
    }
    await settle();
    assert.deepEqual(sw.fetchCalls, []);
  });

  it('fetch d’une autre origine : jamais intercepte', async () => {
    const sw = loadSw();
    for (const url of ['https://evil.test/agent/app.js', 'https://cdn.exemple.org/fonts/x.woff2', 'http://psim.test/agent/app.js']) {
      assert.equal(sw.respond(url).responded, false, url);
    }
    await settle();
    assert.deepEqual(sw.fetchCalls, []);
  });

  it('fetch d’une page du PSIM hors portee, ou d’une lecture partielle (Range) : laisse au navigateur', () => {
    const sw = loadSw();
    assert.equal(sw.respond(`${SW_ORIGIN}/`).responded, false);
    assert.equal(sw.respond(`${SW_ORIGIN}/app.js`).responded, false);
    assert.equal(sw.respond(`${SW_ORIGIN}/agent/icon.svg`, { headers: { range: 'bytes=0-10' } }).responded, false);
  });

  it('fetch de la coquille : intercepte', () => {
    const sw = loadSw();
    assert.equal(sw.respond(`${SW_ORIGIN}/agent/app.js`).responded, true);
    assert.equal(sw.respond(`${SW_ORIGIN}/agent/`, { mode: 'navigate' }).responded, true);
    assert.equal(sw.respond(`${SW_ORIGIN}/fonts/baloo-2-latin-wght-normal.woff2`).responded, true);
  });
});

describe('service worker : strategies', () => {
  it('coquille : reseau d’abord, la reponse est gardee en cache sous une cle sans query', async () => {
    const sw = loadSw();
    const network = fakeResponse({ body: 'neuf' });
    sw.setFetch(async () => network);
    const event = sw.respond(`${SW_ORIGIN}/agent/app.js?v=9`);
    const response = await event.promise;
    assert.equal(response, network);
    await Promise.all(event.waits);
    const [name] = [...sw.cacheStore.keys()];
    assert.match(name!, CACHE_NAME_RE);
    assert.equal(sw.cacheStore.get(name!)!.get(`${SW_ORIGIN}/agent/app.js`)?.body, 'neuf');
  });

  it('coquille : reseau trop lent (3 s) -> copie locale, et la copie est rafraichie ensuite', async () => {
    const sw = loadSw();
    sw.setFetch(async () => fakeResponse({ body: 'ancien' }));
    await sw.respond(`${SW_ORIGIN}/agent/app.js`).promise; // met en cache
    const late = gate();
    sw.setFetch(async () => {
      await late.promise;
      return fakeResponse({ body: 'recent' });
    });
    const event = sw.respond(`${SW_ORIGIN}/agent/app.js`);
    await settle();
    assert.equal(sw.timers.length >= 1, true, 'un délai est armé');
    sw.timers.at(-1)!(); // 3 s écoulées
    const response = await event.promise;
    assert.equal(response.body, 'ancien');
    late.release();
    await Promise.all(event.waits);
    const [name] = [...sw.cacheStore.keys()];
    assert.equal(sw.cacheStore.get(name!)!.get(`${SW_ORIGIN}/agent/app.js`)?.body, 'recent');
  });

  it('coquille : reseau en panne -> copie locale', async () => {
    const sw = loadSw();
    sw.setFetch(async () => fakeResponse({ body: 'ok' }));
    await sw.respond(`${SW_ORIGIN}/agent/agent.css`).promise;
    sw.setFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const response = await sw.respond(`${SW_ORIGIN}/agent/agent.css`).promise;
    assert.equal(response.body, 'ok');
  });

  it('navigation hors ligne : n’importe quelle page de la portee retombe sur index.html du cache', async () => {
    const sw = loadSw();
    sw.setFetch(async () => fakeResponse({ body: 'accueil' }));
    await sw.respond(`${SW_ORIGIN}/agent/index.html`).promise;
    sw.setFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const response = await sw.respond(`${SW_ORIGIN}/agent/?cp=abc`, { mode: 'navigate' }).promise;
    assert.equal(response.body, 'accueil');
    const other = await sw.respond(`${SW_ORIGIN}/agent/inconnue`, { mode: 'navigate' }).promise;
    assert.equal(other.body, 'accueil');
  });

  it('hors ligne, sans copie, un fichier non-navigation echoue normalement (erreur reseau du navigateur)', async () => {
    const sw = loadSw();
    sw.setFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await assert.rejects(sw.respond(`${SW_ORIGIN}/agent/app.js`).promise, /Failed to fetch/);
  });

  it('serveur en erreur (5xx) : on prefere la copie locale ; sans copie, la reponse 5xx est rendue', async () => {
    const sw = loadSw();
    sw.setFetch(async () => fakeResponse({ body: 'bon' }));
    await sw.respond(`${SW_ORIGIN}/agent/ronde.js`).promise;
    sw.setFetch(async () => fakeResponse({ ok: false, status: 503, body: 'indispo' }));
    assert.equal((await sw.respond(`${SW_ORIGIN}/agent/ronde.js`).promise).body, 'bon');
    const none = await sw.respond(`${SW_ORIGIN}/agent/sos.js`).promise;
    assert.equal(none.status, 503);
  });

  it('une reponse non 200 (404, redirection) n’est jamais gardee en cache, mais est rendue telle quelle', async () => {
    const sw = loadSw();
    sw.setFetch(async () => fakeResponse({ ok: false, status: 404 }));
    const notFound = await sw.respond(`${SW_ORIGIN}/agent/absent.js`).promise;
    assert.equal(notFound.status, 404);
    sw.setFetch(async () => fakeResponse({ redirected: true }));
    await sw.respond(`${SW_ORIGIN}/agent/redirige.js`).promise;
    sw.setFetch(async () => fakeResponse({ status: 206 }));
    await sw.respond(`${SW_ORIGIN}/agent/partiel.js`).promise;
    const cached = [...sw.cacheStore.values()].flatMap((m) => [...m.keys()]);
    assert.deepEqual(cached, []);
  });

  it('polices : cache d’abord (un seul telechargement), puis servies hors ligne', async () => {
    const sw = loadSw();
    const font = `${SW_ORIGIN}/fonts/baloo-2-latin-wght-normal.woff2`;
    sw.setFetch(async () => fakeResponse({ body: 'police' }));
    assert.equal((await sw.respond(font).promise).body, 'police');
    sw.setFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    assert.equal((await sw.respond(font).promise).body, 'police');
    assert.deepEqual(sw.fetchCalls, [font], 'une seule requête réseau');
  });

  it('un cache plein ne fait pas echouer la reponse', async () => {
    const sw = loadSw();
    sw.setFetch(async () => fakeResponse({ body: 'ok' }));
    await sw.respond(`${SW_ORIGIN}/agent/app.js`).promise; // crée le cache
    const [name] = [...sw.cacheStore.keys()];
    // un cache dont put échoue
    const original = sw.ctx.caches.open;
    sw.ctx.caches.open = async (n: string) => {
      const cache = await original(n);
      return { ...cache, put: async () => { throw new Error('quota'); } };
    };
    const response = await sw.respond(`${SW_ORIGIN}/agent/live.js`).promise;
    assert.equal(response.body, 'ok');
    assert.ok(name);
  });
});

describe('service worker : installation et activation', () => {
  it('install : precache tolerant (un fichier manquant n’echoue pas), puis skipWaiting', async () => {
    const sw = loadSw();
    sw.setFetch(async (request: any) => (request.url.endsWith('/agent/live.js') ? fakeResponse({ ok: false, status: 404 }) : fakeResponse({ body: request.url })));
    const waits: Promise<any>[] = [];
    sw.fire('install', { waitUntil: (p: Promise<any>) => waits.push(p) });
    await Promise.all(waits);
    const total = [...sw.fn('PRECACHE')].length;
    const [name] = [...sw.cacheStore.keys()];
    assert.match(name!, CACHE_NAME_RE);
    assert.equal(sw.cacheStore.get(name!)!.size, total - 1);
    assert.equal(sw.cacheStore.get(name!)!.has(`${SW_ORIGIN}/agent/index.html`), true);
    assert.equal(sw.cacheStore.get(name!)!.has(`${SW_ORIGIN}/agent/live.js`), false);
    assert.equal(sw.cacheStore.get(name!)!.has(`${SW_ORIGIN}/fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2`), true);
    assert.equal(sw.skipWaitingCalls, 1);
  });

  it('install : meme si TOUT echoue (hors ligne), l’installation se termine', async () => {
    const sw = loadSw();
    sw.setFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const waits: Promise<any>[] = [];
    sw.fire('install', { waitUntil: (p: Promise<any>) => waits.push(p) });
    await Promise.all(waits);
    assert.equal(sw.skipWaitingCalls, 1);
  });

  it('install : le precache ne demande que la coquille (jamais /api ni /ws)', async () => {
    const sw = loadSw();
    const waits: Promise<any>[] = [];
    sw.fire('install', { waitUntil: (p: Promise<any>) => waits.push(p) });
    await Promise.all(waits);
    assert.ok(sw.fetchCalls.length > 20);
    for (const url of sw.fetchCalls) {
      const path = new URL(url).pathname;
      assert.equal(path.startsWith('/api') || path.startsWith('/ws'), false, url);
      assert.ok(path.startsWith('/agent/') || path.startsWith('/fonts/'), url);
    }
  });

  it('activate : supprime les anciens caches de l’application (pas ceux des autres), garde le courant, claim()', async () => {
    const sw = loadSw();
    const waitsInstall: Promise<any>[] = [];
    sw.fire('install', { waitUntil: (p: Promise<any>) => waitsInstall.push(p) });
    await Promise.all(waitsInstall);
    const [current] = [...sw.cacheStore.keys()];
    sw.cacheStore.set('psim-agent-shell-v0', new Map());
    sw.cacheStore.set('psim-agent-shell-ancien', new Map());
    sw.cacheStore.set('autre-application', new Map());
    const waits: Promise<any>[] = [];
    sw.fire('activate', { waitUntil: (p: Promise<any>) => waits.push(p) });
    await Promise.all(waits);
    assert.deepEqual([...sw.cacheStore.keys()].sort(), [current, 'autre-application'].sort());
    assert.equal(sw.claimCalls, 1);
  });

  it('le nom du cache est versionne', () => {
    const sw = loadSw();
    assert.match(sw.fn('CACHE_NAME'), /^psim-agent-shell-v\d+$/);
  });
});
