/**
 * Application des agents (web/agent/util.js) : les parties pures (heures, durees, UUID) et l'appel d'API, avec un faux
 * `fetch` : jamais d'exception, reseau absent signale, 401 remonte au gestionnaire de session, pastille « en ligne ».
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
// @ts-expect-error module JS de l'interface (sans types), importe pour tester ses calculs purs
import { api, fmtAgo, fmtDuration, fmtWhen, setAuthLostHandler, setNetworkHandler, uuid } from '../web/agent/util.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setAuthLostHandler(null);
  setNetworkHandler(null);
});

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (url: string, init: RequestInit) => handler(String(url), init ?? {})) as typeof fetch;
}

describe('heures et durees', () => {
  it('fmtAgo : à l’instant, minutes, heures', () => {
    const now = 1_000_000_000;
    assert.equal(fmtAgo(now - 10_000, now), 'à l’instant');
    assert.equal(fmtAgo(now - 4 * 60_000, now), 'il y a 4 min');
    assert.equal(fmtAgo(now - 2 * 3_600_000, now), 'il y a 2 h');
    assert.equal(fmtAgo(now - (2 * 3_600_000 + 10 * 60_000), now), 'il y a 2 h 10');
    assert.equal(fmtAgo(now + 5000, now), 'à l’instant', 'une heure future (horloge du telephone) ne donne jamais un temps négatif');
  });

  it('fmtDuration', () => {
    assert.equal(fmtDuration(12 * 60_000), '12 min');
    assert.equal(fmtDuration(65 * 60_000), '1 h 05');
    assert.equal(fmtDuration(-5), '0 min');
  });

  it('uuid : format v4, jamais deux fois le même', () => {
    const a = uuid();
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(a, uuid());
  });
});

describe('api()', () => {
  it('succès : données, ok, pas d’erreur', async () => {
    fakeFetch(() => Response.json({ alarms: [] }));
    const r = await api('/api/agent/alarms');
    assert.equal(r.ok, true);
    assert.equal(r.network, false);
    assert.deepEqual(r.data, { alarms: [] });
  });

  it('envoie le corps en JSON avec le cookie de la même origine, sans cache', async () => {
    let seen: RequestInit = {};
    fakeFetch((_url, init) => {
      seen = init;
      return Response.json({ ok: true });
    });
    await api('/api/agent/sos', { method: 'POST', body: { clientId: 'x' } });
    assert.equal(seen.method, 'POST');
    assert.equal(seen.credentials, 'same-origin');
    assert.equal(seen.cache, 'no-store');
    assert.equal(seen.body, '{"clientId":"x"}');
    assert.deepEqual(seen.headers, { 'Content-Type': 'application/json' });
  });

  it('erreur du serveur : message en français repris tel quel', async () => {
    fakeFetch(() => Response.json({ error: 'Étiquette inconnue' }, { status: 404 }));
    const r = await api('/api/agent/scans', { method: 'POST', body: {} });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.equal(r.error, 'Étiquette inconnue');
    assert.equal(r.network, false);
  });

  it('pas de réponse : jamais d’exception, network: true, status 0', async () => {
    fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const r = await api('/api/agent/alarms');
    assert.equal(r.ok, false);
    assert.equal(r.network, true);
    assert.equal(r.status, 0);
  });

  it('délai dépassé : compte comme une absence de réseau', async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    const r = await api('/api/agent/alarms', { timeoutMs: 20 });
    assert.equal(r.network, true);
  });

  it('401 : le gestionnaire de session perdue est appelé', async () => {
    let lost = 0;
    setAuthLostHandler(() => {
      lost += 1;
    });
    fakeFetch(() => Response.json({ error: 'Session terminée' }, { status: 401 }));
    const r = await api('/api/agent/me');
    assert.equal(r.status, 401);
    assert.equal(lost, 1);
  });

  it('pastille réseau : prévenue seulement quand l’état change', async () => {
    const seen: boolean[] = [];
    setNetworkHandler((ok: boolean) => seen.push(ok));
    fakeFetch(() => Response.json({}));
    await api('/a');
    await api('/a');
    fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await api('/a');
    await api('/a');
    fakeFetch(() => Response.json({ error: 'x' }, { status: 500 }));
    await api('/a');
    assert.deepEqual(seen.slice(-2), [false, true], 'une erreur 500 prouve que le serveur répond : en ligne');
    assert.ok(seen.every((v, i) => i === 0 || v !== seen[i - 1]), 'jamais deux fois le même état de suite');
  });
});

describe('fmtWhen : le jour d\'une ronde à venir', () => {
  const at = (dayOffset: number, h: number, m: number) => {
    const d = new Date(2026, 9, 17 + dayOffset, h, m, 0, 0);
    return d.getTime();
  };
  const now = at(0, 7, 37);
  it('le jour même : « à 07:43 »', () => assert.equal(fmtWhen(at(0, 7, 43), now), 'à 07:43'));
  it('le lendemain : « demain à 07:43 » (jamais pris pour une ronde imminente)', () => assert.equal(fmtWhen(at(1, 7, 43), now), 'demain à 07:43'));
  it('plus tard : le nom du jour', () => assert.equal(fmtWhen(at(3, 22, 0), now), 'mardi à 22:00'));
  it('après minuit, le lendemain reste « demain » même à 00:05', () => assert.equal(fmtWhen(at(1, 0, 5), at(0, 23, 50)), 'demain à 00:05'));
});
