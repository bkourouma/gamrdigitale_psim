import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createHoldersApi } from '../server/accessholdersapi.ts';
import { createSession, createUser, getSession } from '../server/auth.ts';
import { openDb } from '../server/db.ts';
import { PsimError } from '../server/errors.ts';

/**
 * Routes des titulaires (docs/ACCES.md § 10.3) montees sur une petite application, avec de faux services qui
 * enregistrent leurs appels et de faux gardes qui lisent le role et le compte dans des en-tetes de test.
 */

const KEY = 'ab'.repeat(32);

interface Call {
  name: string;
  args: unknown[];
}

function makeFakes() {
  const calls: Call[] = [];
  const returns: Record<string, unknown> = {
    list: { items: [{ id: 1, ref: 'H1' }, { id: 2, ref: 'H2' }, { id: 3, ref: 'H3' }, { id: 4, ref: 'H4' }], nextCursor: null, total: 4 },
    get: { id: 7, ref: 'H7' },
    photo: { mime: 'image/png', data: Buffer.from([1, 2, 3]) },
    visitors: [],
    groups: [],
    schedules: [],
    holidays: [],
    status: [],
    issueKey: { key: KEY, createdAt: 1, renewed: false },
    confirmDeletions: { confirmed: 2 },
    retry: { requeued: 1 },
  };
  const statuses: Record<string, { controllerId: string; controllerName: string; state: string; message: string | null }[]> = {
    H1: [],
    H2: [{ controllerId: 'C1', controllerName: 'C1', state: 'synced', message: null }],
    H3: [
      { controllerId: 'C1', controllerName: 'C1', state: 'synced', message: null },
      { controllerId: 'C2', controllerName: 'C2', state: 'failed', message: 'x' },
      { controllerId: 'C3', controllerName: 'C3', state: 'pending', message: null },
    ],
    H4: [{ controllerId: 'C1', controllerName: 'C1', state: 'pending', message: null }],
    H7: [{ controllerId: 'C1', controllerName: 'C1', state: 'blocked', message: 'y' }],
  };
  const proxy = (): unknown =>
    new Proxy(
      {},
      {
        get: (_t, prop) => (...args: unknown[]) => {
          const name = String(prop);
          calls.push({ name, args });
          if (name === 'holderStatus') return statuses[String(args[0])] ?? [];
          if (name in returns) return returns[name];
          return {};
        },
      },
    );
  return { calls, returns, holders: proxy(), sync: proxy() };
}

interface Rig {
  base: string;
  calls: Call[];
  returns: Record<string, unknown>;
  audits: { actor: string; action: string; details?: string }[];
  imports: { bytes: Buffer; actor: string; dryRun: boolean }[];
  seenBodies: unknown[];
  close: () => Promise<void>;
}

async function start(opts: { reauth?: boolean; db?: ReturnType<typeof openDb> } = {}): Promise<Rig> {
  const fakes = makeFakes();
  const audits: Rig['audits'] = [];
  const imports: Rig['imports'] = [];
  const seenBodies: unknown[] = [];
  const db = opts.db ?? openDb(':memory:');
  const app = express();
  // Corps tels qu'ils sont a la fin de la requete (le champ `reauth` doit en avoir disparu).
  app.use((req, res, next) => {
    res.on('finish', () => seenBodies.push(req.body));
    next();
  });
  const anyUser = (req: Request, res: Response, next: NextFunction) => {
    if (!req.header('x-user')) return void res.status(401).json({ error: 'Non connecte' });
    next();
  };
  const adminOnly = (req: Request, res: Response, next: NextFunction) => {
    if (!req.header('x-user')) return void res.status(401).json({ error: 'Non connecte' });
    if (req.header('x-role') !== 'admin') return void res.status(403).json({ error: 'Reserve a l administrateur' });
    next();
  };
  createHoldersApi({
    holders: fakes.holders as never,
    sync: fakes.sync as never,
    runImport: (bytes, actor, dryRun) => {
      imports.push({ bytes, actor, dryRun });
      return { dryRun, lines: 1 } as never;
    },
    db,
    audit: (actor, action, ref) => void audits.push({ actor, action, details: ref?.details }),
  }).mount(app, {
    anyUser,
    adminOnly,
    actorOf: (req) => req.header('x-user') ?? '',
    reauth: opts.reauth
      ? (what) => (req, _res, next) => {
          const pw = (req.body as { reauth?: unknown } | undefined)?.reauth;
          if (pw === undefined) return next(new PsimError(428, 'Mot de passe requis'));
          if (pw !== 'bon') return next(new PsimError(403, 'Mot de passe incorrect'));
          void what;
          next();
        }
      : undefined,
  });
  // Meme traduction des erreurs que server/api.ts.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof PsimError) return void res.status(err.status).json({ error: err.message });
    const status = (err as { status?: number }).status;
    if (status === 413) return void res.status(413).json({ error: 'Contenu trop volumineux' });
    if (status && status >= 400 && status < 500) return void res.status(status).json({ error: 'Requete invalide' });
    res.status(500).json({ error: 'Erreur interne' });
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    calls: fakes.calls,
    returns: fakes.returns,
    audits,
    imports,
    seenBodies,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const ADMIN = { 'x-user': 'alice', 'x-role': 'admin' };
const OPER = { 'x-user': 'bob', 'x-role': 'operator' };

async function call(rig: Rig, method: string, path: string, headers: Record<string, string>, body?: unknown, contentType?: string) {
  const h: Record<string, string> = { ...headers };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) {
      h['content-type'] = contentType ?? 'application/octet-stream';
      payload = new Uint8Array(body);
    } else {
      h['content-type'] = contentType ?? 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
  }
  const res = await fetch(rig.base + path, { method, headers: h, body: payload });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* corps non JSON */
  }
  return { res, status: res.status, text, json: json as Record<string, unknown> | null };
}

/** Toutes les routes : [methode, chemin d'essai, role requis, corps]. */
const ROUTES: [string, string, 'any' | 'admin', unknown?, string?][] = [
  ['GET', '/api/access/holders', 'any'],
  ['GET', '/api/access/holders/7', 'any'],
  ['POST', '/api/access/holders', 'admin', { lastName: 'K' }],
  ['PUT', '/api/access/holders/7', 'admin', { lastName: 'K' }],
  ['DELETE', '/api/access/holders/7', 'admin'],
  ['GET', '/api/access/holders/7/photo', 'any'],
  ['PUT', '/api/access/holders/7/photo', 'admin', Buffer.from([1, 2, 3]), 'image/png'],
  ['DELETE', '/api/access/holders/7/photo', 'admin'],
  ['POST', '/api/access/holders/7/badges', 'admin', { number: '12' }],
  ['PATCH', '/api/access/badges/5', 'admin', { state: 'lost' }],
  ['DELETE', '/api/access/badges/5', 'admin'],
  ['GET', '/api/access/groups', 'any'],
  ['GET', '/api/access/groups/3', 'any'],
  ['POST', '/api/access/groups', 'admin', { name: 'G' }],
  ['PUT', '/api/access/groups/3', 'admin', { name: 'G' }],
  ['DELETE', '/api/access/groups/3', 'admin'],
  ['GET', '/api/access/schedules', 'any'],
  ['GET', '/api/access/schedules/3', 'any'],
  ['POST', '/api/access/schedules', 'admin', { name: 'S' }],
  ['PUT', '/api/access/schedules/3', 'admin', { name: 'S' }],
  ['DELETE', '/api/access/schedules/3', 'admin'],
  ['GET', '/api/access/holidays', 'any'],
  ['PUT', '/api/access/holidays', 'admin', { entries: [] }],
  ['GET', '/api/access/visitors', 'any'],
  ['POST', '/api/access/visitors', 'any', { lastName: 'V' }],
  ['POST', '/api/access/visitors/9/end', 'any'],
  ['POST', '/api/access/import', 'admin', Buffer.from('nom\nA\n'), 'text/csv'],
  ['GET', '/api/access/sync', 'any'],
  ['GET', '/api/access/sync/controllers/CTL-1', 'any'],
  ['POST', '/api/access/sync/controllers/CTL-1/key', 'admin', { reauth: 'bon' }],
  ['POST', '/api/access/sync/controllers/CTL-1/confirm-deletions', 'admin', { reauth: 'bon' }],
  ['POST', '/api/access/sync/controllers/CTL-1/retry', 'admin'],
];

describe('routes des titulaires : roles', () => {
  let rig: Rig;
  before(async () => {
    rig = await start({ reauth: true });
  });
  after(() => rig.close());

  it('refuse sans session (401) et ne touche pas aux services', async () => {
    for (const [m, p, , body, ct] of ROUTES) {
      const r = await call(rig, m, p, {}, body, ct);
      assert.equal(r.status, 401, `${m} ${p}`);
    }
    assert.equal(rig.calls.length, 0);
  });

  it('une route reservee a l administrateur est refusee a l operateur sans appeler le service', async () => {
    for (const [m, p, role, body, ct] of ROUTES) {
      if (role !== 'admin') continue;
      rig.calls.length = 0;
      const r = await call(rig, m, p, OPER, body, ct);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(rig.calls.length, 0, `${m} ${p}`);
    }
  });

  it('les routes ouvertes (consultation, visiteurs) repondent a l operateur', async () => {
    for (const [m, p, role, body, ct] of ROUTES) {
      if (role !== 'any') continue;
      const r = await call(rig, m, p, OPER, body, ct);
      assert.ok(r.status >= 200 && r.status < 300, `${m} ${p} -> ${r.status}`);
    }
  });

  it('l administrateur passe partout avec les bons codes', async () => {
    const expected: Record<string, number> = {
      'POST /api/access/holders': 201,
      'DELETE /api/access/holders/7': 204,
      'PUT /api/access/holders/7/photo': 204,
      'DELETE /api/access/holders/7/photo': 204,
      'POST /api/access/holders/7/badges': 201,
      'DELETE /api/access/badges/5': 204,
      'POST /api/access/groups': 201,
      'DELETE /api/access/groups/3': 204,
      'POST /api/access/schedules': 201,
      'DELETE /api/access/schedules/3': 204,
      'POST /api/access/visitors': 201,
    };
    for (const [m, p, , body, ct] of ROUTES) {
      const r = await call(rig, m, p, ADMIN, body, ct);
      assert.equal(r.status, expected[`${m} ${p}`] ?? 200, `${m} ${p}`);
    }
  });

  it('chaque route du source porte anyUser ou adminOnly', () => {
    const src = readFileSync(new URL('../server/accessholdersapi.ts', import.meta.url), 'utf8');
    const re = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,\s*([A-Za-z_]+)/g;
    let n = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      n++;
      assert.ok(m[3] === 'anyUser' || m[3] === 'adminOnly', `${m[1]} ${m[2]} sans garde`);
    }
    assert.equal(n, ROUTES.length, 'toutes les routes sont couvertes par la table du test');
    assert.equal((src.match(/\bapp\.(get|post|put|patch|delete)\(/g) ?? []).length, n, 'aucune route hors motif');
  });
});

describe('routes des titulaires : identifiants et reponses', () => {
  let rig: Rig;
  before(async () => {
    rig = await start({ reauth: true });
  });
  after(() => rig.close());

  it('identifiants d URL hostiles => 404 sans appeler le service', async () => {
    const bad = ['0', '01', '-1', '1.5', 'abc', '12345678901', '1e3', '%20', '7%2F8', '1;2'];
    const numeric: [string, string][] = [
      ['GET', '/api/access/holders/'],
      ['PUT', '/api/access/holders/'],
      ['DELETE', '/api/access/holders/'],
      ['GET', '/api/access/groups/'],
      ['PUT', '/api/access/groups/'],
      ['DELETE', '/api/access/groups/'],
      ['GET', '/api/access/schedules/'],
      ['PUT', '/api/access/schedules/'],
      ['DELETE', '/api/access/schedules/'],
      ['PATCH', '/api/access/badges/'],
      ['DELETE', '/api/access/badges/'],
      ['POST', '/api/access/visitors/'],
    ];
    for (const id of bad) {
      for (const [m, base] of numeric) {
        const path = m === 'POST' ? `${base}${id}/end` : `${base}${id}`;
        const r = await call(rig, m, path, ADMIN, m === 'GET' || m === 'DELETE' || m === 'POST' ? undefined : { name: 'x' });
        assert.equal(r.status, 404, `${m} ${path}`);
      }
      for (const suffix of ['/photo']) {
        const r = await call(rig, 'GET', `/api/access/holders/${id}${suffix}`, ADMIN);
        assert.equal(r.status, 404);
      }
      const b = await call(rig, 'POST', `/api/access/holders/${id}/badges`, ADMIN, { number: '1' });
      assert.equal(b.status, 404);
    }
    for (const id of ['a.b', 'x'.repeat(33), 'a b', 'a%00b']) {
      for (const suffix of ['', '/key', '/retry', '/confirm-deletions']) {
        const m = suffix === '' ? 'GET' : 'POST';
        const r = await call(rig, m, `/api/access/sync/controllers/${id}${suffix}`, ADMIN, suffix === '' || suffix === '/retry' ? undefined : { reauth: 'bon' });
        assert.equal(r.status, 404, `${m} controllers/${id}${suffix}`);
      }
    }
    assert.equal(rig.calls.length, 0, 'le service n a jamais ete appele');
  });

  it('liste : syncState = le pire etat, none sans porte ; un appel holderStatus par titulaire', async () => {
    rig.calls.length = 0;
    const r = await call(rig, 'GET', '/api/access/holders?q=k', OPER);
    const items = (r.json as { items: { ref: string; syncState: string }[] }).items;
    assert.deepEqual(items.map((i) => i.syncState), ['none', 'synced', 'failed', 'pending']);
    assert.equal(rig.calls.filter((c) => c.name === 'holderStatus').length, 4);
    assert.equal(r.res.headers.get('cache-control'), 'no-store');
    const list = rig.calls.find((c) => c.name === 'list');
    assert.equal(list?.args[1], 'bob');
  });

  it('fiche : ajoute sync et passe en no-store', async () => {
    const r = await call(rig, 'GET', '/api/access/holders/7', OPER);
    assert.equal(r.status, 200);
    assert.deepEqual((r.json as { sync: { state: string }[] }).sync.map((s) => s.state), ['blocked']);
    assert.equal(r.res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(rig.calls.filter((c) => c.name === 'get').at(-1)?.args, [7]);
  });

  it('corps non objet => 400 propre ; objet transmis tel quel', async () => {
    for (const body of ['[1,2]', '"texte"', '12']) {
      const r = await call(rig, 'POST', '/api/access/holders', ADMIN, body);
      assert.equal(r.status, 400, body);
      assert.ok(typeof r.json?.error === 'string');
    }
    const bad = await call(rig, 'POST', '/api/access/holders', ADMIN, '{pas du json');
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json, { error: 'Requete invalide' });
    rig.calls.length = 0;
    await call(rig, 'POST', '/api/access/holders', ADMIN, { lastName: 'K', zzz: { a: 1 } });
    assert.deepEqual(rig.calls[0].args, ['alice', { lastName: 'K', zzz: { a: 1 } }]);
  });

  it('corps JSON trop gros => 413 ; jours feries : entries transmis', async () => {
    const big = await call(rig, 'POST', '/api/access/holders', ADMIN, { lastName: 'x'.repeat(11_000) });
    assert.equal(big.status, 413);
    assert.deepEqual(big.json, { error: 'Contenu trop volumineux' });
    rig.calls.length = 0;
    const entries = [{ date: '2026-01-01', label: 'An' }];
    await call(rig, 'PUT', '/api/access/holidays', ADMIN, { entries });
    assert.deepEqual(rig.calls[0].args, ['alice', entries]);
    const arr = await call(rig, 'PUT', '/api/access/holidays', ADMIN, '[]');
    assert.equal(arr.status, 400);
  });

  it('visiteurs : scope', async () => {
    rig.calls.length = 0;
    await call(rig, 'GET', '/api/access/visitors', OPER);
    await call(rig, 'GET', '/api/access/visitors?scope=recent', OPER);
    const bad = await call(rig, 'GET', '/api/access/visitors?scope=tout', OPER);
    assert.equal(bad.status, 400);
    assert.deepEqual(rig.calls.map((c) => c.args[0]), ['current', 'recent']);
    const end = await call(rig, 'POST', '/api/access/visitors/9/end', OPER);
    assert.equal(end.status, 200);
    assert.deepEqual(rig.calls.at(-1)?.args, ['bob', 9]);
  });
});

describe('photo et import', () => {
  let rig: Rig;
  before(async () => {
    rig = await start();
  });
  after(() => rig.close());

  it('photo : GET avec les en-tetes de securite, 404 si aucune', async () => {
    const r = await call(rig, 'GET', '/api/access/holders/7/photo', OPER);
    assert.equal(r.status, 200);
    assert.equal(r.res.headers.get('content-type'), 'image/png');
    assert.equal(r.res.headers.get('cache-control'), 'no-store');
    assert.equal(r.res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.res.headers.get('content-disposition'), 'inline; filename="photo"');
    assert.equal(r.res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    rig.returns.photo = null;
    const none = await call(rig, 'GET', '/api/access/holders/7/photo', OPER);
    assert.equal(none.status, 404);
    assert.ok(typeof none.json?.error === 'string');
    rig.returns.photo = { mime: 'image/png', data: Buffer.from([1]) };
  });

  it('photo : PUT du type recu, 415 pour un autre type, 413 au-dela de 64 Ko, 400 si vide', async () => {
    rig.calls.length = 0;
    const ok = await call(rig, 'PUT', '/api/access/holders/7/photo', ADMIN, Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
    assert.equal(ok.status, 204);
    const set = rig.calls[0];
    assert.equal(set.name, 'setPhoto');
    assert.deepEqual([set.args[0], set.args[1], set.args[2]], ['alice', 7, 'image/jpeg']);
    assert.ok(Buffer.isBuffer(set.args[3]));
    rig.calls.length = 0;
    for (const ct of ['text/plain', 'application/json', 'image/gif', 'image/svg+xml']) {
      const r = await call(rig, 'PUT', '/api/access/holders/7/photo', ADMIN, Buffer.from('abc'), ct);
      assert.equal(r.status, 415, ct);
      assert.ok(typeof r.json?.error === 'string');
    }
    const big = await call(rig, 'PUT', '/api/access/holders/7/photo', ADMIN, Buffer.alloc(70 * 1024, 1), 'image/png');
    assert.equal(big.status, 413);
    assert.deepEqual(big.json, { error: 'Contenu trop volumineux' });
    const empty = await call(rig, 'PUT', '/api/access/holders/7/photo', ADMIN, Buffer.alloc(0), 'image/png');
    assert.equal(empty.status, 400);
    assert.equal(rig.calls.length, 0);
  });

  it('import : corps brut, essai a blanc, trop gros, corps absent', async () => {
    const csv = Buffer.from('nom;prenom\nKONAN;Yao\n');
    const real = await call(rig, 'POST', '/api/access/import', ADMIN, csv, 'text/csv');
    assert.equal(real.status, 200);
    assert.equal(real.res.headers.get('cache-control'), 'no-store');
    const dry = await call(rig, 'POST', '/api/access/import?dryRun=1', ADMIN, csv, 'application/octet-stream');
    assert.equal(dry.status, 200);
    assert.deepEqual(rig.imports.map((i) => [i.actor, i.dryRun]), [['alice', false], ['alice', true]]);
    assert.ok(rig.imports[0].bytes.equals(csv));
    const big = await call(rig, 'POST', '/api/access/import', ADMIN, Buffer.alloc(1024 * 1024 + 10, 65), 'text/csv');
    assert.equal(big.status, 413);
    assert.deepEqual(big.json, { error: 'Contenu trop volumineux' });
    const none = await call(rig, 'POST', '/api/access/import', ADMIN);
    assert.equal(none.status, 400);
    assert.deepEqual(none.json, { error: 'Envoyez le fichier CSV tel quel' });
    const asJson = await call(rig, 'POST', '/api/access/import', ADMIN, { nom: 'x' });
    assert.equal(asJson.status, 200, 'tout type est accepte comme octets bruts');
    assert.equal(rig.imports.length, 3);
    assert.equal(typeof rig.imports[2].bytes.length, 'number');
  });
});

describe('cle de synchronisation et ré-authentification fournie', () => {
  let rig: Rig;
  before(async () => {
    rig = await start({ reauth: true });
  });
  after(() => rig.close());

  it('428 sans mot de passe, 403 s il est faux : le service n est pas appele', async () => {
    const miss = await call(rig, 'POST', '/api/access/sync/controllers/CTL-1/key', ADMIN, {});
    assert.equal(miss.status, 428);
    const wrong = await call(rig, 'POST', '/api/access/sync/controllers/CTL-1/key', ADMIN, { reauth: 'faux' });
    assert.equal(wrong.status, 403);
    const conf = await call(rig, 'POST', '/api/access/sync/controllers/CTL-1/confirm-deletions', ADMIN, {});
    assert.equal(conf.status, 428);
    assert.equal(rig.calls.length, 0);
    assert.deepEqual(wrong.json, { error: 'Mot de passe incorrect' });
  });

  it('cle : no-store, montree dans cette seule reponse, mot de passe retire du corps', async () => {
    rig.seenBodies.length = 0;
    const ok = await call(rig, 'POST', '/api/access/sync/controllers/CTL-1/key', ADMIN, { reauth: 'bon' });
    assert.equal(ok.status, 200);
    assert.equal(ok.res.headers.get('cache-control'), 'no-store');
    assert.equal((ok.json as { key: string }).key, KEY);
    assert.deepEqual(rig.calls.at(-1)?.args, ['alice', 'CTL-1']);
    const last = rig.seenBodies.at(-1) as Record<string, unknown>;
    assert.equal('reauth' in last, false);
    // La cle n'apparait dans aucune autre route.
    for (const [m, p, role, body, ct] of ROUTES) {
      if (p.endsWith('/key')) continue;
      const r = await call(rig, m, p, ADMIN, role === 'admin' ? body : undefined, ct);
      assert.ok(!r.text.includes(KEY), `${m} ${p}`);
      assert.ok(!JSON.stringify([...r.res.headers]).includes(KEY));
    }
    assert.ok(!rig.audits.some((a) => (a.details ?? '').includes(KEY)));
  });

  it('confirmation des suppressions : reauth requis puis service appele', async () => {
    const r = await call(rig, 'POST', '/api/access/sync/controllers/CTL-1/confirm-deletions', ADMIN, { reauth: 'bon' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { confirmed: 2 });
    assert.deepEqual(rig.calls.at(-1)?.args, ['alice', 'CTL-1']);
  });
});

describe('ré-authentification locale', () => {
  let rig: Rig;
  let db: ReturnType<typeof openDb>;
  before(async () => {
    db = openDb(':memory:');
    createUser(db, 'carole', 'admin', 'Sesame-Ouvre-Toi-42');
    rig = await start({ db });
  });
  after(() => rig.close());

  const url = '/api/access/sync/controllers/CTL-1/key';
  const as = { 'x-user': 'carole', 'x-role': 'admin' };

  it('428 si absent ou vide, 403 si faux, journal sans mot de passe', async () => {
    assert.equal((await call(rig, 'POST', url, as, {})).status, 428);
    assert.equal((await call(rig, 'POST', url, as, { reauth: '' })).status, 428);
    assert.equal((await call(rig, 'POST', url, as, { reauth: 12 })).status, 428);
    const wrong = await call(rig, 'POST', url, as, { reauth: 'Pas-Le-Bon-Mot-1' });
    assert.equal(wrong.status, 403);
    assert.equal(rig.calls.length, 0);
    const fail = rig.audits.find((a) => a.action === 'reauth_echec');
    assert.ok(fail);
    assert.ok(!(fail.details ?? '').includes('Pas-Le-Bon'));
    assert.ok(!JSON.stringify(rig.seenBodies).includes('Pas-Le-Bon'));
  });

  it('le bon mot de passe passe et n arrive jamais au service ni au corps', async () => {
    const ok = await call(rig, 'POST', url, as, { reauth: 'Sesame-Ouvre-Toi-42' });
    assert.equal(ok.status, 200);
    assert.equal(ok.res.headers.get('cache-control'), 'no-store');
    assert.ok(!JSON.stringify(rig.calls).includes('Sesame'));
    assert.ok(!JSON.stringify(rig.seenBodies).includes('Sesame'));
    assert.ok(!ok.text.includes('Sesame'));
  });

  it('5 echecs par minute : sessions fermees au 5e, puis 429 meme avec le bon mot de passe', async () => {
    createUser(db, 'denis', 'admin', 'Autre-Phrase-Secrete-7');
    const token = createSession('denis', 'admin', 0);
    assert.ok(getSession(token));
    const h = { 'x-user': 'denis', 'x-role': 'admin' };
    for (let i = 0; i < 5; i++) {
      const r = await call(rig, 'POST', url, h, { reauth: 'faux-faux-faux' });
      assert.equal(r.status, 403, `essai ${i + 1}`);
    }
    assert.equal(getSession(token), null, 'sessions fermees');
    assert.ok(rig.audits.some((a) => a.action === 'reauth_session_fermee' && (a.details ?? '').includes('denis')));
    const locked = await call(rig, 'POST', url, h, { reauth: 'Autre-Phrase-Secrete-7' });
    assert.equal(locked.status, 429);
    assert.deepEqual(locked.json, { error: 'Trop de mots de passe faux, reessayer dans une minute' });
  });
});
