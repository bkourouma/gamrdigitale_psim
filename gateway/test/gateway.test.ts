/**
 * Passerelle de bout en bout, contre le VRAI broker du PSIM (server/mqtt.ts : comptes de passerelle, limite de 1 Ko...).
 * Coupure du broker, redemarrage de la passerelle, processus tue net, modules en panne, liaison vers un autre broker.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { createServer } from 'node:net';
import type { ProbeRecord } from './fixtures/modules/probe/index.ts';
import { startRuntime } from '../src/runtime.ts';
import { FIXTURES, GW_PASSWORD, GW_USER, ROOT, freePort, memoryLogger, psimBroker, sleep, tempDir, testConfig, waitFor, writeConfig } from './helpers.ts';
import type { Received } from './helpers.ts';

const cleanup: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const f of cleanup.reverse()) await f();
});
const probes = () => ((globalThis as { gatewayProbes?: Record<string, ProbeRecord> }).gatewayProbes ??= {});

describe('passerelle : envoi fiable vers le PSIM', () => {
  it('coupure du broker puis retour : ni perte ni doublon, ordre et heure reelle conserves', async () => {
    const dir = tempDir(cleanup);
    const port = await freePort();
    const received: Received[] = [];
    let broker = await psimBroker(port, received);
    const logger = memoryLogger();
    const rt = await startRuntime({ config: testConfig(dir, port), logger });
    cleanup.push(() => rt.stop());

    rt.emit('D-01', { state: 'alarm' });
    rt.emit('D-01', { event: 'heartbeat' });
    await waitFor(() => received.length === 2, 10_000, 'deux premiers messages');

    await broker.close();
    await waitFor(() => logger.has(/connexion au PSIM perdue/), 5000, 'coupure detectee');
    const emittedAt: number[] = [];
    for (let i = 0; i < 5; i++) {
      emittedAt.push(Date.now());
      rt.emit('D-02', { value: i });
      await sleep(30);
    }
    assert.equal(rt.status().queue.pending, 5, 'en attente sur disque pendant la coupure');
    await sleep(600); // plusieurs essais de reconnexion
    assert.ok(logger.has(/PSIM injoignable/));

    broker = await psimBroker(port, received);
    cleanup.push(() => broker.close());
    await waitFor(() => received.length === 7, 15_000, 'messages de la coupure');
    await sleep(300);
    assert.equal(received.length, 7, 'aucun doublon');
    const after = received.slice(2);
    assert.deepEqual(after.map((r) => r.payload.value), [0, 1, 2, 3, 4], 'ordre conserve');
    after.forEach((r, i) => {
      assert.equal(r.id, 'D-02');
      assert.ok(Math.abs((r.payload.ts as number) - emittedAt[i]) < 50, "ts = heure de l'evenement, pas du renvoi");
    });
    assert.equal(new Set(received.map((r) => r.payload.msgId)).size, 7);
    assert.equal(rt.status().queue.pending, 0);
    assert.equal(rt.status().psim.connected, true);
  });

  it('redemarrage de la passerelle avec une file non videe : les messages repartent avec LEURS msgId', async () => {
    const dir = tempDir(cleanup);
    const port = await freePort();
    const received: Received[] = [];
    const config = testConfig(dir, port);
    const rt1 = await startRuntime({ config, logger: memoryLogger() });
    rt1.emit('D-01', { state: 'alarm' });
    rt1.emit('D-01', { state: 'normal', msgId: 'fourni-par-module' });
    rt1.emit('D-03', { event: 'tamper' });
    const queued = rt1.queue.pending().map((e) => ({ id: e.id, msgId: e.m.msgId, ts: e.m.ts }));
    assert.equal(queued.length, 3);
    await rt1.stop();

    const broker = await psimBroker(port, received);
    cleanup.push(() => broker.close());
    const logger = memoryLogger();
    const rt2 = await startRuntime({ config, logger });
    cleanup.push(() => rt2.stop());
    await waitFor(() => received.length === 3, 10_000, 'file reprise');
    assert.deepEqual(received.map((r) => ({ id: r.id, msgId: r.payload.msgId, ts: r.payload.ts })), queued);
    assert.ok(logger.has(/3 message\(s\) en attente repris/));
  });

  it("processus tue net (coupure) puis relance : aucun message accepte n'est perdu", { timeout: 60_000 }, async () => {
    const dir = tempDir(cleanup);
    const port = await freePort();
    const file = writeConfig(dir, {
      psim: { url: `mqtt://127.0.0.1:${port}`, username: GW_USER, password: GW_PASSWORD },
      retry: { minMs: 100, maxMs: 300 },
      log: { file: true },
      modules: [{ name: 'heartbeat', config: { deviceId: 'GW-01', everyS: 1 } }],
    });
    const run = () => spawn(process.execPath, ['gateway/src/main.ts', file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const queueLines = () => {
      try {
        return readFileSync(join(dir, 'data', 'queue.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"seq"'));
      } catch {
        return [];
      }
    };
    const kill = (c: ChildProcess) => {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      else c.kill('SIGKILL');
    };
    // 1) PSIM arrete : la passerelle accumule des signes de vie sur disque, puis elle est tuee sans preavis.
    const first = run();
    cleanup.push(() => kill(first));
    await waitFor(() => queueLines().length >= 3, 20_000, 'messages en file');
    kill(first);
    await new Promise((r) => (first.exitCode !== null ? r(null) : first.once('exit', r)));
    const before = queueLines().map((l) => JSON.parse(l).m as { msgId: string; ts: number });

    // 2) Le PSIM revient, la passerelle est relancee : tout ce qui etait en file arrive, avec les msgId et heures d'origine.
    const received: Received[] = [];
    const broker = await psimBroker(port, received);
    cleanup.push(() => broker.close());
    const second = run();
    cleanup.push(() => kill(second));
    await waitFor(() => before.every((b) => received.some((r) => r.payload.msgId === b.msgId)), 20_000, 'messages repris');
    for (const b of before) {
      const r = received.find((x) => x.payload.msgId === b.msgId) as Received;
      assert.equal(r.id, 'GW-01');
      assert.equal(r.payload.ts, b.ts);
    }
    kill(second);
  });

  it('message invalide (trop gros, id piege, ts en secondes) : rejete et journalise, la passerelle continue', async () => {
    const dir = tempDir(cleanup);
    const port = await freePort();
    const received: Received[] = [];
    const broker = await psimBroker(port, received);
    cleanup.push(() => broker.close());
    const logger = memoryLogger();
    const rt = await startRuntime({ config: testConfig(dir, port), logger });
    cleanup.push(() => rt.stop());
    rt.emit('D-01', { event: 'x'.repeat(1500) });
    assert.equal(rt.emit('../#', { state: 'alarm' }), false, 'refuse : emit renvoie faux (le module peut faire renvoyer sa source)');
    rt.emit('D-01/state', { state: 'alarm' });
    rt.emit('D-01', { state: 'alarm', ts: Math.floor(Date.now() / 1000) });
    rt.emit('D-01', null as never);
    assert.equal(rt.status().queue.pending + received.length, 0, 'rien en file');
    assert.ok(logger.has(/trop gros/));
    assert.ok(logger.has(/identifiant d'equipement invalide/));
    assert.ok(logger.has(/ts en secondes/));
    assert.equal(rt.emit('D-01', { state: 'alarm' }), true, 'en file : emit renvoie vrai');
    await waitFor(() => received.length === 1, 10_000, 'message valide');
  });

  it("detecteur refuse par le PSIM (hors du compte) : mis de cote apres plusieurs refus, la file n'est pas bloquee", { timeout: 60_000 }, async () => {
    const dir = tempDir(cleanup);
    const port = await freePort();
    const received: Received[] = [];
    const broker = await psimBroker(port, received, [{ user: GW_USER, password: GW_PASSWORD, detectors: ['D-01'] }]);
    cleanup.push(() => broker.close());
    const logger = memoryLogger();
    const rt = await startRuntime({ config: testConfig(dir, port), logger, rejectAfter: 3 });
    cleanup.push(() => rt.stop());
    rt.emit('X-99', { state: 'alarm' });
    rt.emit('D-01', { state: 'alarm' });
    await waitFor(() => received.length === 1, 30_000, 'message autorise malgre le refus precedent');
    assert.equal(received[0].id, 'D-01');
    assert.ok(logger.has(/refuse 3 fois par le PSIM/));
    assert.equal(rt.status().queue.rejected, 1);
    const rejected = readFileSync(join(dir, 'data', 'rejected.jsonl'), 'utf8');
    assert.match(rejected, /X-99/);
  });

  it('filtre local psim.detectors : un equipement hors perimetre est refuse avant la file', async () => {
    const dir = tempDir(cleanup);
    const port = await freePort();
    const logger = memoryLogger();
    const config = testConfig(dir, port, [], { psim: { url: `mqtt://127.0.0.1:${port}`, username: GW_USER, password: GW_PASSWORD, detectors: ['D-*'] } });
    const rt = await startRuntime({ config, logger });
    cleanup.push(() => rt.stop());
    rt.emit('Z-01', { state: 'alarm' });
    rt.emit('D-07', { state: 'alarm' });
    assert.equal(rt.status().queue.pending, 1);
    assert.ok(logger.has(/hors de psim.detectors/));
  });

  it("deux passerelles sur le meme dossier de donnees : la seconde refuse de demarrer", async () => {
    const dir = tempDir(cleanup);
    const port = await freePort();
    const config = testConfig(dir, port);
    const rt = await startRuntime({ config, logger: memoryLogger() });
    cleanup.push(() => rt.stop());
    // Verrou tenu par un AUTRE processus vivant (le processus parent des essais).
    await rt.stop();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(config.dataDir, 'gateway.lock'), String(process.ppid));
    await assert.rejects(startRuntime({ config, logger: memoryLogger() }), /Une autre passerelle utilise deja ce dossier/);
  });
});

describe('passerelle : modules', () => {
  it("un module qui plante au demarrage est journalise et retente, sans arreter les autres ; il finit par demarrer", async () => {
    const dir = tempDir(cleanup);
    const port = await freePort();
    const received: Received[] = [];
    const broker = await psimBroker(port, received);
    cleanup.push(() => broker.close());
    const logger = memoryLogger();
    const config = testConfig(dir, port, [
      { name: 'probe', label: 'toujours-en-panne', config: { key: 'm-ko', failTimes: -1 } },
      { name: 'probe', label: 'capricieux', config: { key: 'm-flaky', failTimes: 2 } },
      { name: 'probe', label: 'sain', config: { key: 'm-ok' } },
      { name: 'probe', label: 'config-refusee', config: { key: 'm-bad', throwInCreate: true } },
    ]);
    const rt = await startRuntime({ config, modulesDir: FIXTURES, logger });
    cleanup.push(() => rt.stop());
    await waitFor(() => probes()['m-ok']?.ctx !== null && probes()['m-ok'] !== undefined, 5000, 'module sain');
    probes()['m-ok'].ctx!.emit('D-01', { state: 'alarm' });
    await waitFor(() => received.length === 1, 10_000, 'message du module sain');

    await waitFor(() => rt.status().modules.find((m) => m.label === 'capricieux')?.state === 'running', 10_000, 'module capricieux demarre');
    assert.equal(probes()['m-flaky'].starts, 3);
    probes()['m-flaky'].ctx!.emit('D-02', { event: 'gas' });
    await waitFor(() => received.length === 2, 10_000, 'message du module capricieux');

    await waitFor(() => probes()['m-ko'].starts >= 3, 10_000, 'nouveaux essais du module en panne');
    const ko = rt.status().modules.find((m) => m.label === 'toujours-en-panne')!;
    assert.equal(ko.state === 'retrying' || ko.state === 'starting', true);
    assert.match(ko.lastError ?? '', /panne simulee/);
    assert.ok(probes()['m-ko'].stops >= 2, 'arrete apres chaque echec (ressources liberees)');
    assert.ok(logger.has(/\[toujours-en-panne\] echec du demarrage \(panne simulee/));
    assert.ok(logger.has(/\[config-refusee\] echec du demarrage \(configuration refusee/));
  });

  it("arret propre : chaque module est arrete, et un dernier etat emis pendant l'arret part encore", async () => {
    const dir = tempDir(cleanup);
    const port = await freePort();
    const received: Received[] = [];
    const broker = await psimBroker(port, received);
    cleanup.push(() => broker.close());
    const config = testConfig(dir, port, [{ name: 'probe', config: { key: 'm-stop', emitOnStop: 'D-09' } }]);
    const rt = await startRuntime({ config, modulesDir: FIXTURES, logger: memoryLogger() });
    await waitFor(() => rt.status().modules[0].state === 'running' && rt.status().psim.connected, 5000, 'module demarre');
    const ctx = probes()['m-stop'].ctx!;
    await rt.stop();
    assert.equal(probes()['m-stop'].stops, 1);
    await waitFor(() => received.length === 1, 5000, 'dernier etat');
    assert.deepEqual([received[0].id, received[0].payload.state], ['D-09', 'offline']);
    ctx.emit('D-09', { state: 'alarm' }); // apres l'arret : ignore, sans exception
    assert.equal(rt.status().modules[0].state, 'stopped');
  });

  it("contrat : emit ne leve jamais, meme avec des arguments absurdes ; ctx.config est une copie", async () => {
    const dir = tempDir(cleanup);
    const port = await freePort();
    const config = testConfig(dir, port, [{ name: 'probe', config: { key: 'm-contract', nested: { a: 1 } } }]);
    const rt = await startRuntime({ config, modulesDir: FIXTURES, logger: memoryLogger() });
    cleanup.push(() => rt.stop());
    await waitFor(() => probes()['m-contract']?.ctx != null, 5000, 'module');
    const ctx = probes()['m-contract'].ctx!;
    for (const args of [[undefined, undefined], [{}, {}], ['D-01', 'alarm'], ['D-01', { state: { toString: () => 'alarm' } }], ['D-01', { value: 10n }]] as unknown[][]) {
      assert.doesNotThrow(() => (ctx.emit as (...a: unknown[]) => void)(...args));
    }
    (ctx.config.nested as { a: number }).a = 2;
    assert.equal((config.modules[0].config.nested as { a: number }).a, 1);
    assert.equal(typeof ctx.now(), 'number');
  });
});

describe('passerelle : liaison vers un autre broker (openMqtt)', () => {
  it('lecture seule, reconnexion automatique avec reprise des abonnements, erreur du module sans consequence', { timeout: 60_000 }, async () => {
    const dir = tempDir(cleanup);
    const psimPort = await freePort();
    const srcPort = await freePort();
    const received: Received[] = [];
    const broker = await psimBroker(psimPort, received);
    cleanup.push(() => broker.close());

    const startSource = async () => {
      const aedes = await Aedes.createBroker();
      aedes.authenticate = (_c, u, p, done) => done(null, u === 'z2m' && p?.toString() === 'secret-z2m');
      const server = createServer(aedes.handle);
      await new Promise<void>((r) => server.listen(srcPort, '127.0.0.1', r));
      return {
        aedes,
        close: () => new Promise<void>((r) => {
          for (const s of [server]) s.close();
          aedes.close(() => r());
        }),
      };
    };
    let source = await startSource();
    const logger = memoryLogger();
    const config = testConfig(dir, psimPort, [{ name: 'reader', config: { url: `mqtt://127.0.0.1:${srcPort}`, username: 'z2m', password: 'secret-z2m', topic: 'capteurs/+' } }]);
    const rt = await startRuntime({ config, modulesDir: FIXTURES, logger });
    cleanup.push(() => rt.stop());
    await waitFor(() => rt.status().modules[0].state === 'running', 10_000, 'module lecteur demarre');

    const pub = async (topic: string, text: string) => {
      const c = await mqtt.connectAsync(`mqtt://127.0.0.1:${srcPort}`, { username: 'z2m', password: 'secret-z2m', reconnectPeriod: 0 });
      await c.publishAsync(topic, text, { qos: 1 });
      await c.endAsync();
    };
    await pub('capteurs/D-11', 'boom'); // erreur dans le module : journalisee, la liaison continue
    await pub('capteurs/D-11', 'alarm');
    await waitFor(() => received.length === 1, 10_000, 'message traduit');
    assert.deepEqual([received[0].id, received[0].payload.state], ['D-11', 'alarm']);
    assert.ok(logger.has(/erreur en traitant capteurs\/D-11 : message illisible/));

    const link = (globalThis as { gatewayReaderLink?: Record<string, unknown> }).gatewayReaderLink!;
    assert.equal(typeof link.publish, 'undefined', 'aucune publication possible');

    await source.close();
    await waitFor(() => logger.has(/liaison perdue avec/), 10_000, 'coupure de la source vue');
    source = await startSource();
    cleanup.push(() => source.close());
    await waitFor(() => logger.has(/reconnecte a/), 20_000, 'reconnexion');
    await sleep(300); // reprise des abonnements
    await pub('capteurs/D-12', 'fault');
    await waitFor(() => received.length === 2, 10_000, 'message apres reconnexion');
    assert.equal(received[1].id, 'D-12');
  });

  it('identifiants refuses par la source : le demarrage du module echoue et sera retente', async () => {
    const dir = tempDir(cleanup);
    const port = await freePort();
    const srcPort = await freePort();
    const aedes = await Aedes.createBroker();
    aedes.authenticate = (_c, _u, _p, done) => done(Object.assign(new Error('refuse'), { returnCode: 4 as never }), false);
    const server = createServer(aedes.handle);
    await new Promise<void>((r) => server.listen(srcPort, '127.0.0.1', r));
    cleanup.push(() => new Promise<void>((r) => {
      server.close();
      aedes.close(() => r());
    }));
    const logger = memoryLogger();
    const config = testConfig(dir, port, [{ name: 'reader', config: { url: `mqtt://127.0.0.1:${srcPort}`, username: 'x', password: 'y', topic: '#' } }]);
    const rt = await startRuntime({ config, modulesDir: FIXTURES, logger });
    cleanup.push(() => rt.stop());
    await waitFor(() => logger.has(/echec du demarrage .*connexion refusee/), 15_000, 'refus journalise');
    assert.equal(rt.status().modules[0].state === 'running', false);
  });
});
