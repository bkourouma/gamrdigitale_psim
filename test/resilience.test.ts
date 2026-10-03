import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { createSupervisor } from '../scripts/supervise.ts';
import { createContinuity } from '../server/continuity.ts';
import { openDb } from '../server/db.ts';
import { createHeartbeat, validateHeartbeatUrl } from '../server/heartbeat.ts';
import { preflight } from '../server/preflight.ts';
import { createSystemStatus } from '../server/system.ts';

const SECOND = 1000;
const MIN = 60 * SECOND;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < timeoutMs) await wait(10);
}

describe('continuite : periode pendant laquelle rien n\'a ete surveille', () => {
  function setup() {
    const db = openDb(':memory:');
    let clock = 1_000_000_000_000;
    const make = () => createContinuity(db, { now: () => clock });
    return { db, make, set: (t: number) => void (clock = t), advance: (ms: number) => void (clock += ms), now: () => clock };
  }

  it("premier demarrage : aucune periode aveugle inventee", () => {
    const t = setup();
    assert.equal(t.make().begin(), null);
  });

  it("arret INATTENDU : l'ecart avec le dernier signe de vie est la periode aveugle", () => {
    const t = setup();
    const first = t.make();
    first.begin();
    t.advance(10 * SECOND);
    first.beat(); // dernier signe de vie, puis plantage : pas de markClean
    const lastAlive = t.now();
    t.advance(7 * MIN);
    const gap = t.make().begin()!;
    assert.deepEqual([gap.from, gap.to, gap.durationMs, gap.clean], [lastAlive, t.now(), 7 * MIN, false]);
  });

  it("arret volontaire long : signale comme volontaire ; arret volontaire court : ignore", () => {
    const t = setup();
    const a = t.make();
    a.begin();
    a.markClean();
    t.advance(20 * MIN);
    const gap = t.make().begin()!;
    assert.equal(gap.clean, true);
    assert.equal(gap.durationMs, 20 * MIN);

    const b = t.make();
    b.markClean();
    t.advance(5 * SECOND);
    assert.equal(t.make().begin(), null, "5 s de redemarrage propre : pas une periode aveugle");
  });

  it("un arret inattendu est signale meme tres court (un plantage reste un plantage)", () => {
    const t = setup();
    const a = t.make();
    a.begin();
    t.advance(5 * SECOND);
    const gap = t.make().begin()!;
    assert.equal(gap.clean, false);
    assert.equal(gap.durationMs, 5 * SECOND);
  });

  it("deux demarrages dans la meme seconde, ou une horloge revenue en arriere : rien d'affirme", () => {
    const t = setup();
    t.make().begin();
    t.advance(300);
    assert.equal(t.make().begin(), null);
    t.advance(-10 * MIN);
    assert.equal(t.make().begin(), null, 'horloge reculee : on ne calcule pas un ecart negatif');
  });

  it("la derniere periode est conservee pour l'affichage, y compris apres un redemarrage sans nouvel ecart", () => {
    const t = setup();
    t.make().begin();
    t.advance(3 * MIN);
    const second = t.make();
    second.begin();
    assert.equal(second.lastGap()?.durationMs, 3 * MIN);
    second.markClean();
    t.advance(1000);
    const third = t.make();
    third.begin();
    assert.equal(third.lastGap()?.durationMs, 3 * MIN, 'conservee');
  });

  it("l'etat est lu depuis la base : un second processus voit le meme signe de vie", () => {
    const t = setup();
    const a = t.make();
    a.begin();
    t.advance(MIN);
    a.beat();
    const row = t.db.prepare("SELECT value FROM system_state WHERE key = 'last_alive'").get() as { value: string };
    assert.equal(Number(row.value), t.now());
  });
});

describe('signal de supervision externe', () => {
  const URL_OK = 'https://hc.exemple.test/ping/jeton-secret-123';
  const fakeFetch = (log: string[], result: () => { ok: boolean; status: number } | Error) => async (url: string) => {
    log.push(url);
    const r = result();
    if (r instanceof Error) throw r;
    return r;
  };

  it("envoie un signal quand tout va bien, et /fail quand la sante est degradee", async () => {
    const sent: string[] = [];
    let healthy = true;
    const hb = createHeartbeat({ url: URL_OK, everyMs: MIN, health: () => ({ ok: healthy }), fetch: fakeFetch(sent, () => ({ ok: true, status: 200 })) });
    assert.equal(await hb.ping(), true);
    healthy = false;
    await hb.ping();
    assert.deepEqual(sent, [URL_OK, `${URL_OK}/fail`]);
    assert.equal(hb.status().sent, 2);
  });

  it("n'expose jamais l'adresse complete : seul l'hote est affiche, meme dans les erreurs", async () => {
    const hb = createHeartbeat({ url: URL_OK, everyMs: MIN, health: () => ({ ok: true }), fetch: fakeFetch([], () => new Error(`fetch failed pour ${URL_OK} (ECONNREFUSED)`)) });
    await hb.ping();
    const status = JSON.stringify(hb.status());
    assert.ok(!status.includes('jeton-secret-123'), status);
    assert.equal(hb.status().host, 'hc.exemple.test');
    assert.match(hb.status().lastError ?? '', /\[adresse\]/);
  });

  it("compte les echecs, previent UNE fois quand ca casse puis quand ca se retablit", async () => {
    const changes: string[] = [];
    let mode: 'ok' | 'ko' = 'ok';
    const hb = createHeartbeat({
      url: URL_OK,
      everyMs: MIN,
      health: () => ({ ok: true }),
      fetch: fakeFetch([], () => (mode === 'ok' ? { ok: true, status: 200 } : { ok: false, status: 503 })),
      onChange: (state) => void changes.push(state),
    });
    await hb.ping();
    mode = 'ko';
    for (let i = 0; i < 5; i++) await hb.ping();
    assert.equal(hb.status().consecutiveFailures, 5);
    assert.equal(hb.status().lastError, 'HTTP 503');
    assert.deepEqual(changes, ['failing'], 'une seule alerte pour cinq echecs');
    mode = 'ok';
    await hb.ping();
    assert.deepEqual(changes, ['failing', 'recovered']);
    assert.equal(hb.status().consecutiveFailures, 0);
  });

  it("une panne du service externe ne gene pas le PSIM : aucune exception, jamais deux envois simultanes", async () => {
    let calls = 0;
    const hb = createHeartbeat({
      url: URL_OK,
      everyMs: MIN,
      health: () => {
        throw new Error('sante en panne');
      },
      fetch: async () => {
        calls++;
        await wait(50);
        throw new Error('reseau coupe');
      },
    });
    const [a, b] = await Promise.all([hb.ping(), hb.ping()]);
    assert.deepEqual([a, b], [false, false]);
    assert.equal(calls, 1, 'le second envoi est ignore tant que le premier est en cours');
  });

  it("n'est pas actif sans adresse valide ; refuse les identifiants dans l'adresse et les adresses invalides", async () => {
    assert.equal(createHeartbeat({ url: '', everyMs: MIN, health: () => ({ ok: true }) }).status().configured, false);
    assert.equal(createHeartbeat({ url: 'pas une adresse', everyMs: MIN, health: () => ({ ok: true }) }).status().configured, false);
    assert.equal(createHeartbeat({ url: URL_OK, everyMs: 0, health: () => ({ ok: true }) }).status().configured, false);
    assert.match(validateHeartbeatUrl('ftp://x.test/a') ?? '', /https/);
    assert.match(validateHeartbeatUrl('https://user:pw@x.test/a') ?? '', /identifiants/);
    assert.equal(validateHeartbeatUrl(URL_OK), null);
    const sent: string[] = [];
    const off = createHeartbeat({ url: '', everyMs: MIN, health: () => ({ ok: true }), fetch: fakeFetch(sent, () => ({ ok: true, status: 200 })) });
    assert.equal(await off.ping(), false);
    assert.equal(sent.length, 0);
  });

  it("de bout en bout contre un vrai serveur HTTP : signal periodique, /fail, et redirection refusee", async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url?.startsWith('/redirige')) {
        res.writeHead(302, { Location: 'http://127.0.0.1:1/vole' });
        return void res.end();
      }
      res.writeHead(200).end('OK');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      let healthy = true;
      const hb = createHeartbeat({ url: `${base}/ping/abc`, everyMs: 40, health: () => ({ ok: healthy }) });
      hb.start();
      await until(() => hits.filter((h) => h === '/ping/abc').length >= 3);
      healthy = false;
      await until(() => hits.includes('/ping/abc/fail'));
      hb.stop();
      assert.ok(hits.filter((h) => h === '/ping/abc').length >= 3, 'signal regulier');
      assert.ok(hits.includes('/ping/abc/fail'));

      const redirected = createHeartbeat({ url: `${base}/redirige/jeton`, everyMs: MIN, health: () => ({ ok: true }) });
      assert.equal(await redirected.ping(), false, 'on ne suit jamais une redirection (le jeton partirait ailleurs)');
    } finally {
      server.close();
    }
  });
});

describe('controle de demarrage et etat systeme', () => {
  const base = {
    production: true, host: '127.0.0.1', mqttHost: '127.0.0.1', tlsEnabled: false, mqttTlsEnabled: false, trustProxy: false, cookieSecure: false,
    simEnabled: false, demoLogin: false, adminPassword: 'Mot-de-passe-admin-solide-1', operatorPassword: 'Mot-de-passe-operateur-2', mqttPassword: 'Mot-de-passe-mqtt-solide-3',
    notificationChannels: 1, escalationConfigured: true, detectorTimeoutS: 180, backupEveryH: 24, requireTotp: 'admin' as const,
  };

  it("en production : pas de supervision externe = avertissement ; adresse invalide ou en http = erreur bloquante", () => {
    assert.ok(preflight(base).some((f) => f.level === 'warn' && /Aucune supervision externe/.test(f.message)));
    assert.ok(preflight({ ...base, heartbeatUrl: 'https://hc.exemple.test/ping/x' }).every((f) => !/supervision externe|HEARTBEAT/.test(f.message)));
    assert.ok(preflight({ ...base, heartbeatUrl: 'http://hc.exemple.test/ping/x' }).some((f) => f.level === 'error' && /http:\/\//.test(f.message)));
    assert.ok(preflight({ ...base, heartbeatUrl: 'n importe quoi' }).some((f) => f.level === 'error' && /HEARTBEAT/.test(f.message)));
    assert.ok(preflight({ ...base, production: false, heartbeatUrl: 'http://hc.exemple.test/x' }).every((f) => f.level === 'warn'), 'hors production : jamais bloquant');
  });

  const statusWith = (extra: Record<string, unknown>) => {
    const db = openDb(':memory:');
    const t = 1_000_000_000_000;
    return createSystemStatus({
      db, dataDir: '.', version: 't', now: () => t, startedAt: t, lastTickAt: () => t, brokerClients: () => 0, snapshotsBytes: () => 0,
      disk: () => ({ freeBytes: 100 * 1024 ** 3, totalBytes: 200 * 1024 ** 3 }),
      notificationChannels: () => ({ channels: 1, failedLast24h: 0, sentLast24h: 0 }),
      backup: { everyH: 24, dir: '.', last: () => ({ at: t, ok: true, name: 'b', bytes: 1, error: null }), count: () => 1 },
      ...extra,
    } as never);
  };

  it("avertit d'un redemarrage apres arret inattendu (24 h), pas d'un arret volontaire ni d'un ancien incident", () => {
    const t = 1_000_000_000_000;
    const warnings = (gap: object | null) => statusWith({ lastGap: () => gap }).detail().warnings.map((w) => w.message);
    assert.ok(warnings({ from: t - 9 * MIN, to: t - 2 * MIN, durationMs: 7 * MIN, clean: false }).some((m) => /arret inattendu.*7 min/.test(m)));
    assert.ok(!warnings({ from: t - 9 * MIN, to: t - 2 * MIN, durationMs: 7 * MIN, clean: true }).some((m) => /inattendu/.test(m)));
    assert.ok(!warnings({ from: t - 80 * 3600_000, to: t - 79 * 3600_000, durationMs: 3600_000, clean: false }).some((m) => /inattendu/.test(m)), 'plus de 24 h : plus signale');
    assert.ok(!warnings(null).some((m) => /inattendu/.test(m)));
  });

  it("avertit quand le signal externe echoue depuis plusieurs tentatives, et l'expose sans adresse", () => {
    const beat = (n: number) => ({ configured: true, host: 'hc.exemple.test', everyS: 60, lastOkAt: null, lastFailAt: 1, lastError: 'HTTP 503', consecutiveFailures: n, sent: 0 });
    assert.ok(statusWith({ heartbeat: () => beat(3) }).detail().warnings.some((w) => /Supervision externe : 3 signaux/.test(w.message)));
    assert.ok(!statusWith({ heartbeat: () => beat(2) }).detail().warnings.some((w) => /Supervision externe/.test(w.message)));
    assert.equal(statusWith({ heartbeat: () => beat(0) }).detail().heartbeat?.host, 'hc.exemple.test');
  });
});

describe('superviseur', () => {
  const NODE = process.execPath;
  const quiet = () => {};

  it("relance un PSIM qui plante, avec une pause croissante plafonnee, et ne renonce jamais", async () => {
    const logs: string[] = [];
    const sup = createSupervisor({ command: NODE, args: ['-e', 'process.exit(3)'], backoff: { minMs: 20, maxMs: 80, resetAfterMs: 60_000 }, log: (m) => logs.push(m) });
    sup.start();
    await until(() => sup.stats().starts >= 6);
    await sup.stop();
    assert.ok(sup.stats().starts >= 6, `relances : ${sup.stats().starts}`);
    const waits = logs.filter((l) => /relance dans/.test(l)).map((l) => Number(/relance dans (\d+) ms/.exec(l)![1]));
    assert.deepEqual(waits.slice(0, 4), [20, 40, 80, 80], 'pause doublee a chaque panne, plafonnee a 80 ms');
  });

  it("une longue periode de bon fonctionnement remet la pause au minimum", async () => {
    const logs: string[] = [];
    const sup = createSupervisor({ command: NODE, args: ['-e', 'setTimeout(() => process.exit(1), 150)'], backoff: { minMs: 20, maxMs: 5000, resetAfterMs: 100 }, log: (m) => logs.push(m) });
    sup.start();
    await until(() => sup.stats().starts >= 4, 8000);
    await sup.stop();
    const waits = logs.filter((l) => /relance dans/.test(l));
    assert.ok(waits.length >= 3);
    assert.ok(waits.every((l) => /relance dans 20 ms/.test(l)), `toujours la pause minimale (20 ms) : ${waits.join(' | ')}`);
  });

  it("arrete de force un PSIM bloque (sante defaillante 3 fois de suite) puis le relance", async () => {
    const logs: string[] = [];
    const sup = createSupervisor({
      command: NODE,
      args: ['-e', 'setInterval(() => {}, 1000)'], // tourne, mais ne repond plus
      probe: async () => ({ ok: false, detail: 'aucune reponse' }),
      probeEveryMs: 20,
      graceMs: 0,
      failuresBeforeKill: 3,
      stopTimeoutMs: 300,
      backoff: { minMs: 20, maxMs: 40, resetAfterMs: 60_000 },
      log: (m) => logs.push(m),
    });
    sup.start();
    await until(() => sup.stats().hangKills >= 1 && sup.stats().starts >= 2, 8000);
    await sup.stop();
    assert.ok(sup.stats().hangKills >= 1);
    assert.ok(sup.stats().starts >= 2, 'relance apres l\'arret force');
    assert.ok(logs.some((l) => /PSIM bloque/.test(l)));
  });

  it("ne touche pas a un PSIM en bonne sante, ni pendant sa phase de demarrage", async () => {
    const probeTimes: number[] = [];
    const sup = createSupervisor({
      command: NODE, args: ['-e', 'setInterval(() => {}, 1000)'], probe: async () => (probeTimes.push(Date.now()), { ok: true }), probeEveryMs: 20, graceMs: 150, stopTimeoutMs: 300, log: quiet,
    });
    const t0 = Date.now();
    sup.start();
    await until(() => probeTimes.length >= 3);
    await sup.stop();
    assert.ok(probeTimes.length >= 3);
    assert.ok(Math.min(...probeTimes) - t0 >= 140, `aucune sonde avant la fin du delai de grace (premiere sonde a +${Math.min(...probeTimes) - t0} ms)`);
    assert.equal(sup.stats().hangKills, 0);
    assert.equal(sup.stats().starts, 1);

    let failing = 0;
    const lenient = createSupervisor({
      command: NODE, args: ['-e', 'setInterval(() => {}, 1000)'], probeEveryMs: 20, graceMs: 0, failuresBeforeKill: 3, stopTimeoutMs: 300, log: quiet,
      probe: async () => ({ ok: ++failing % 3 === 0 }), // un succes interrompt la serie : jamais 3 echecs d'affilee
    });
    lenient.start();
    await until(() => failing >= 12);
    await lenient.stop();
    assert.equal(lenient.stats().hangKills, 0, 'des echecs isoles ne declenchent rien');
  });

  it("l'arret volontaire demande un arret PROPRE (message), sans relancer", async () => {
    const logs: string[] = [];
    // Le « PSIM » ne s'arrete que s'il recoit le message : preuve que l'arret est propre et non force.
    const code = "process.on('message', (m) => { if (m === 'shutdown') { console.log('arret-propre-recu'); process.exit(0); } }); setInterval(() => {}, 1000)";
    const sup = createSupervisor({ command: NODE, args: ['-e', code], log: (m) => logs.push(m) });
    sup.start();
    await wait(300);
    await sup.stop();
    assert.equal(sup.running(), false);
    await wait(150);
    assert.equal(sup.stats().starts, 1, 'rien n\'est relance apres un arret volontaire');
    assert.ok(!logs.some((l) => /force/.test(l)), logs.join(' | '));
  });

  it("un PSIM qui ignore la demande d'arret est force au bout du delai", async () => {
    const logs: string[] = [];
    const code = "process.on('message', () => {}); setInterval(() => {}, 1000)"; // sourd
    const sup = createSupervisor({ command: NODE, args: ['-e', code], stopTimeoutMs: 200, log: (m) => logs.push(m) });
    sup.start();
    await wait(300);
    const t0 = Date.now();
    await sup.stop();
    assert.ok(Date.now() - t0 >= 150, 'a laisse le delai');
    assert.equal(sup.running(), false);
    assert.ok(logs.some((l) => /arret force/.test(l)));
  });

  it("impossible de lancer la commande : signale, et reessaie", async () => {
    const logs: string[] = [];
    const sup = createSupervisor({ command: 'commande-inexistante-psim', args: [], backoff: { minMs: 20, maxMs: 40, resetAfterMs: 60_000 }, log: (m) => logs.push(m) });
    sup.start();
    await until(() => sup.stats().starts >= 3);
    await sup.stop();
    assert.ok(logs.some((l) => /lancement impossible/.test(l)));
    assert.ok(sup.stats().starts >= 3);
  });
});
