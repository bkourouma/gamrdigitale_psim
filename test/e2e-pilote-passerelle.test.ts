/**
 * Canal de commande BOUT EN BOUT, processus reels de chaque cote :
 *
 *   API du PSIM (server/index.ts, base temporaire) --ordre signe--> broker MQTT du PSIM --> [relais TCP d'essai]
 *     --> passerelle reelle (processus separe, gateway/src/runtime.ts) --> module factice « doorlog » (gateway/test/fixtures)
 *     --accuse signe--> le meme chemin en sens inverse --> VRAI handleAck du PSIM (etat de la commande, ackKind).
 *
 * Le relais TCP (`startRelay`) fait passer les octets MQTT tels quels, mais voit chaque PUBLISH dans les deux sens et peut en
 * INJECTER un vers la passerelle : c'est le « broker compromis / reseau hostile » du modele de menaces (ordre rejoue, ordre
 * perime, ordre mal signe, ordre fabrique avec la cle). Aucun client ne peut publier un ordre sur le vrai broker (c'est
 * justement une des verifications), donc c'est le seul moyen de joindre ce que la passerelle fait quand le PSIM n'y est pour
 * rien. Le module consigne chaque appel dans un fichier (`calls.jsonl`) que le test relit.
 *
 * Particularite : le lanceur de la passerelle est gateway/test/fixtures/run-gateway.ts et non gateway/src/main.ts, car main.ts ne
 * charge que les modules livres (aucun ne pilote d'actionneur) ; la chaine appelee est la meme (loadConfig, startRuntime).
 *
 * Ports libres pris au hasard (web du PSIM, broker MQTT, relais) ; tout est arrete et efface a la fin.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect as tcpConnect, createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import mqtt from 'mqtt';
import type { IClientOptions, MqttClient } from 'mqtt';
import { signAck, signCommand, verifyAck } from '../server/actuatorproto.ts';
import type { AckMessage } from '../server/actuatorproto.ts';

const ROOT = resolve(import.meta.dirname, '..');
const RUNNER = join(ROOT, 'gateway', 'test', 'fixtures', 'run-gateway.ts');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';
const MAIN = { user: 'psim', password: 'Mot-de-passe-mqtt-solide-3' };
/** Compte de la passerelle de l'essai (recoit les ordres de ses trois actionneurs) et compte d'une AUTRE passerelle. */
const GW = { user: 'gw-pilote', password: 'Mot-de-passe-passerelle-pilote-1', detectors: ['D-GW1-*'], actuators: ['GACHE-1', 'SECOURS-1', 'PORTAIL-1'] };
const OTHER = { user: 'gw-autre', password: 'Mot-de-passe-passerelle-autre-2', detectors: ['D-B-*'], actuators: ['AUTRE-ACT'] };

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });

// ------------------------------------------------------------------------------------------------------ PSIM reel

interface Psim {
  proc: ChildProcess;
  base: string;
  output: () => string;
}

async function startPsim(root: string, ports: { web: number; mqtt: number }): Promise<Psim> {
  const base = `http://127.0.0.1:${ports.web}`;
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    PSIM_DATA_DIR: join(root, 'data'),
    PSIM_BACKUP_DIR: join(root, 'backups'),
    PSIM_PORT: String(ports.web),
    PSIM_MQTT_PORT: String(ports.mqtt),
    PSIM_ADMIN_PASSWORD: ADMIN_PW,
    PSIM_OPERATOR_PASSWORD: OPERATOR_PW,
    PSIM_MQTT_PASSWORD: MAIN.password,
    PSIM_DEMO_LOGIN: '0',
    PSIM_REQUIRE_2FA: 'none',
    PSIM_MQTT_GATEWAYS: JSON.stringify([GW, OTHER]),
  });
  let output = '';
  const proc = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (d) => (output += d));
  proc.stderr!.on('data', (d) => (output += d));
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).status === 200) return { proc, base, output: () => output };
    } catch {
      // pas encore pret
    }
    await wait(250);
  }
  proc.kill();
  throw new Error(`serveur non demarre :\n${output}`);
}

/** Arret brutal (SIGKILL) : aucun nettoyage possible cote PSIM, le cas le plus dur. */
async function killProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((res) => proc.once('exit', res));
  proc.kill('SIGKILL');
  await exited;
}

// ------------------------------------------------------------------------------------------------------ relais MQTT

interface Seen {
  topic: string;
  payload: Buffer;
  qos: number;
  at: number;
}

interface Relay {
  port: number;
  /** PUBLISH vus du PSIM vers la passerelle (ordres). */
  down: Seen[];
  /** PUBLISH vus de la passerelle vers le PSIM (accuses, etats). */
  up: Seen[];
  /** Injecte un PUBLISH QoS 0 vers la passerelle, entre deux paquets entiers ; faux si aucune connexion. */
  inject(topic: string, payload: string | Buffer): boolean;
  connections(): number;
  close(): Promise<void>;
}

/** Decoupe un flux MQTT en paquets entiers (en-tete fixe + longueur variable). */
function packets(onPacket: (raw: Buffer, type: number, flags: number, body: Buffer) => void): (chunk: Buffer) => void {
  let buf: Buffer = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      let length = 0;
      let mult = 1;
      let i = 1;
      let byte: number;
      do {
        if (i >= buf.length) return;
        byte = buf[i++]!;
        length += (byte & 127) * mult;
        mult *= 128;
      } while (byte & 128 && mult <= 128 ** 3);
      if (buf.length < i + length) return;
      onPacket(buf.subarray(0, i + length), buf[0]! >> 4, buf[0]! & 15, buf.subarray(i, i + length));
      buf = buf.subarray(i + length);
    }
  };
}

function publishOf(flags: number, body: Buffer): Omit<Seen, 'at'> {
  const topicLength = body.readUInt16BE(0);
  const qos = (flags >> 1) & 3;
  const start = 2 + topicLength + (qos > 0 ? 2 : 0);
  return { topic: body.toString('utf8', 2, 2 + topicLength), payload: Buffer.from(body.subarray(start)), qos };
}

function buildPublish(topic: string, payload: Buffer): Buffer {
  const t = Buffer.from(topic, 'utf8');
  let rest = 2 + t.length + payload.length;
  const varint: number[] = [];
  do {
    let b = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) b |= 128;
    varint.push(b);
  } while (rest > 0);
  const head = Buffer.alloc(2);
  head.writeUInt16BE(t.length, 0);
  return Buffer.concat([Buffer.from([0x30, ...varint]), head, t, payload]);
}

async function startRelay(targetPort: number): Promise<Relay> {
  const down: Seen[] = [];
  const up: Seen[] = [];
  const sockets = new Set<Socket>();
  let current: Socket | null = null;
  const server: Server = createServer((client) => {
    const upstream = tcpConnect(targetPort, '127.0.0.1');
    sockets.add(client);
    sockets.add(upstream);
    current = client;
    client.on('error', () => undefined);
    upstream.on('error', () => client.destroy());
    client.on('close', () => {
      sockets.delete(client);
      if (current === client) current = null;
      upstream.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      client.destroy();
    });
    client.on(
      'data',
      packets((raw, type, flags, body) => {
        if (type === 3) up.push({ ...publishOf(flags, body), at: Date.now() });
        upstream.write(raw);
      }),
    );
    upstream.on(
      'data',
      packets((raw, type, flags, body) => {
        if (type === 3) down.push({ ...publishOf(flags, body), at: Date.now() });
        client.write(raw);
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    down,
    up,
    inject(topic, payload) {
      if (!current || current.destroyed) return false;
      current.write(buildPublish(topic, Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')));
      return true;
    },
    connections: () => [...sockets].filter((s) => !s.destroyed).length / 2,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

// ------------------------------------------------------------------------------------------------------ essai

interface Call {
  t: number;
  actuatorId: string;
  cmdId: string;
  action: string;
  durationS?: number;
  clip?: string;
}
type CommandView = { cmdId: string; state: string; ackKind: string | null; ack: string | null; action: string; auto: boolean; parentId: string | null; durationS: number | null };

describe('commandes : PSIM reel + passerelle reelle (processus) + module factice', { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'psim-e2e-pilote-'));
  const gwDir = join(root, 'passerelle');
  const callsFile = join(gwDir, 'calls.jsonl');
  const configFile = join(gwDir, 'config.json');
  let ports: { web: number; mqtt: number };
  let psim: Psim;
  let relay: Relay;
  let gateway: ChildProcess | null = null;
  let gwOutput = '';
  let admin = '';
  let operator = '';
  const keys: Record<string, string> = {};
  const rawClients: MqttClient[] = [];
  /** Premier ordre reel (cmdId et message tel que vu sur le fil) : rejoue plus loin. */
  const s1: { cmdId: string; wire: string } = { cmdId: '', wire: '' };

  const mqttUrl = () => `mqtt://127.0.0.1:${ports.mqtt}`;
  const login = async (username: string, password: string) => {
    const res = await fetch(`${psim.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(res.status, 200, `connexion de ${username}`);
    return res.headers.getSetCookie()[0]!.split(';')[0]!;
  };
  const api = async (method: string, path: string, cookie: string | null, body?: unknown) => {
    const res = await fetch(`${psim.base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const command = (cookie: string, id: string, body: Record<string, unknown>) => api('POST', `/api/actuators/${id}/commands`, cookie, body);
  const commandsOf = async (cookie: string, id: string): Promise<CommandView[]> => (await api('GET', `/api/actuators/${id}/commands`, cookie)).body;
  const viewOf = async (cookie: string, id: string, cmdId: string) => (await commandsOf(cookie, id)).find((c) => c.cmdId === cmdId);
  const linkUp = async (id: string) => ((await api('GET', '/api/actuators', admin)).body.actuators as { id: string; linkUp: boolean | null }[]).find((a) => a.id === id)?.linkUp;

  const calls = (): Call[] => {
    if (!existsSync(callsFile)) return [];
    return readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Call);
  };
  const callsOf = (cmdId: string) => calls().filter((c) => c.cmdId === cmdId || c.cmdId === `${cmdId}:rest`);
  const gwLog = () => gwOutput;
  const gwHas = (re: RegExp) => re.test(gwOutput);

  /** Attend une condition ; en cas d'echec, joint la fin du journal de la passerelle (diagnostic). */
  async function until<T>(what: string, probe: () => T | Promise<T>, ms = 8000): Promise<NonNullable<T>> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await probe();
      if (v) return v as NonNullable<T>;
      if (Date.now() > end) assert.fail(`delai depasse : ${what}\n--- passerelle ---\n${gwOutput.split('\n').slice(-25).join('\n')}`);
      await wait(25);
    }
  }
  const untilState = (cookie: string, id: string, cmdId: string, wanted: string, ms = 8000) =>
    until(`commande ${cmdId.slice(0, 8)} a l'etat ${wanted}`, async () => {
      const v = await viewOf(cookie, id, cmdId);
      return v?.state === wanted ? v : null;
    }, ms);

  /** Accuses de la passerelle pour `cmdId`, relus sur le fil et verifies avec la cle de l'actionneur. */
  const acksSeen = (id: string, cmdId: string): AckMessage[] =>
    relay.up
      .filter((m) => m.topic === `psim/actuators/${id}/ack`)
      .map((m) => verifyAck(keys[id]!, id, m.payload))
      .filter((a): a is AckMessage => a !== null && a.cmdId === cmdId);

  /** Ordre fabrique avec la vraie cle (compromission du broker / du PSIM : l'attaquant qui connait la cle ou rejoue). */
  function forge(id: string, over: { action: string; durationS?: number; ts?: number; ttlS?: number; cmdId?: string }) {
    const cmdId = over.cmdId ?? randomBytes(16).toString('hex');
    const message = signCommand(keys[id]!, id, { cmdId, action: over.action, params: over.durationS !== undefined ? { durationS: over.durationS } : {}, ts: over.ts ?? Date.now(), ttlS: over.ttlS ?? 10 });
    return { cmdId, message, payload: JSON.stringify(message) };
  }
  const injectOrder = (id: string, payload: string) => assert.ok(relay.inject(`psim/actuators/${id}/command`, payload), 'la passerelle est connectee au relais');
  const refusedLine = (id: string, cmdId: string, code: string) => new RegExp(`${id} : ordre \\w+ \\(cmd ${cmdId.slice(0, 8)}\\) REFUSE \\(${code}\\)`);

  /** Un ordre fabrique est refuse LOCALEMENT : accuse signe `refused` + code, module jamais appele, ligne de journal. */
  async function expectLocalRefusal(id: string, order: { cmdId: string; payload: string }, code: string) {
    injectOrder(id, order.payload);
    const ack = await until(`accuse refused/${code} de ${order.cmdId.slice(0, 8)}`, () => acksSeen(id, order.cmdId)[0]);
    assert.equal(ack.result, 'refused');
    assert.equal(ack.code, code);
    assert.equal(acksSeen(id, order.cmdId).length, 1, 'un seul accuse');
    assert.ok(gwHas(refusedLine(id, order.cmdId, code)), `journal : REFUSE (${code})`);
    await wait(150);
    assert.deepEqual(callsOf(order.cmdId), [], 'le module n\'a JAMAIS ete appele');
  }

  const rawClient = async (account: { user: string; password: string }, extra: IClientOptions = {}): Promise<MqttClient> => {
    const c = mqtt.connect(mqttUrl(), { username: account.user, password: account.password, reconnectPeriod: 0, connectTimeout: 5000, clean: true, ...extra });
    rawClients.push(c);
    c.on('error', () => undefined);
    await new Promise<void>((res, rej) => {
      c.once('connect', () => res());
      c.once('error', rej);
      c.once('close', () => rej(new Error('connexion fermee')));
    });
    return c;
  };
  /** QoS accordee d'un abonnement ; 128 = refuse (la bibliotheque leve alors une erreur qui porte le SUBACK). */
  const subscribeCode = async (c: MqttClient, topic: string): Promise<number | undefined> => {
    try {
      return (await c.subscribeAsync(topic, { qos: 0 }))[0]?.qos;
    } catch (err) {
      const granted = (err as { packet?: { granted?: number[] } }).packet?.granted?.[0];
      if (granted === undefined) throw err;
      return granted;
    }
  };
  /** Publication tentee ; renvoie quand le broker a coupe la connexion (refus) ou, sinon, apres un court delai. */
  async function attempt(c: MqttClient, topic: string, payload: string): Promise<void> {
    const closed = new Promise<void>((r) => c.once('close', () => r()));
    c.publish(topic, payload, { qos: 1 }, () => undefined);
    await Promise.race([closed, wait(700)]);
  }

  async function startGateway(): Promise<void> {
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
    const proc = spawn(process.execPath, [RUNNER, configFile], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    proc.stdout!.on('data', (d) => (gwOutput += d));
    proc.stderr!.on('data', (d) => (gwOutput += d));
    gateway = proc;
    await until('passerelle connectee au PSIM', () => gwHas(/connecte au PSIM/), 20_000);
  }
  async function stopGateway(): Promise<void> {
    const proc = gateway;
    gateway = null;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise((res) => proc.once('exit', res));
    try {
      proc.send('shutdown');
    } catch {
      // canal ferme
    }
    const timer = setTimeout(() => proc.kill('SIGKILL'), 12_000);
    await exited;
    clearTimeout(timer);
  }

  before(async () => {
    mkdirSync(join(gwDir, 'secrets'), { recursive: true });
    ports = { web: await freePort(), mqtt: await freePort() };
    psim = await startPsim(root, ports);
    admin = await login('admin', ADMIN_PW);
    operator = await login('operateur', OPERATOR_PW);
    relay = await startRelay(ports.mqtt);
  });

  after(async () => {
    for (const c of rawClients) await c.endAsync(true).catch(() => undefined);
    await stopGateway();
    // Diagnostic : E2E_PILOTE_LOG=1 affiche le journal complet de la passerelle (et celui du PSIM avec =psim)
    if (process.env.E2E_PILOTE_LOG) console.log(`--- journal de la passerelle ---
${gwOutput}${process.env.E2E_PILOTE_LOG === 'psim' ? `--- journal du PSIM ---
${psim?.output()}` : ''}`);
    await relay?.close().catch(() => undefined);
    if (psim) await killProcess(psim.proc);
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await wait(200); // Windows : fichier encore ouvert un instant
      }
    }
  });

  // -------------------------------------------------------------------------------------------------- mise en place

  it('mise en place : actionneurs crees par l\'API, cles ecrites dans les fichiers de la passerelle, liaison etablie ; actionneur non autorise journalise sans arreter les autres', async () => {
    const create = async (body: Record<string, unknown>) => {
      const r = await api('POST', '/api/actuators', admin, { reauth: ADMIN_PW, transport: 'mqtt', ...body });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.match(r.body.key, /^[0-9a-f]{64}$/);
      keys[body.id as string] = r.body.key;
    };
    // Le PSIM autorise PLUS que la passerelle : unlock jusqu'a 30 s ici, 10 s dans la configuration de la passerelle.
    await create({ id: 'GACHE-1', name: 'Gache accueil', type: 'lock', actions: { unlock: { maxS: 30 } } });
    await create({ id: 'SECOURS-1', name: 'Issue de secours', type: 'lock', emergencyExit: true, actions: { unlock: { maxS: 10 } } });
    await create({ id: 'PORTAIL-1', name: 'Portail vehicules', type: 'gate', actions: { open: { maxS: 10 }, close: { maxS: 10 } } });
    await create({ id: 'AUTRE-ACT', name: 'Sirene d\'une autre passerelle', type: 'siren', ackTimeoutS: 30, actions: { on: { maxS: 60 } } });
    // Un actionneur que la passerelle declare mais que le compte n'a pas le droit d'ecouter : cle quelconque.
    keys['ORPHELIN-1'] = randomBytes(32).toString('hex');
    for (const id of ['GACHE-1', 'SECOURS-1', 'PORTAIL-1', 'ORPHELIN-1']) writeFileSync(join(gwDir, 'secrets', `${id.toLowerCase()}.key`), `${keys[id]}\n`);

    const act = (id: string, rest: Record<string, unknown>) => ({ id, keyFile: `secrets/${id.toLowerCase()}.key`, module: 'doorlog', ...rest });
    writeFileSync(
      configFile,
      JSON.stringify(
        {
          name: 'passerelle-essai',
          psim: { url: `mqtt://127.0.0.1:${relay.port}`, username: GW.user, password: GW.password },
          dataDir: 'data',
          retry: { minMs: 100, maxMs: 400 },
          moduleRetry: { minMs: 100, maxMs: 400 },
          log: { file: false },
          modules: [{ name: 'doorlog', config: { actuators: ['GACHE-1', 'SECOURS-1', 'PORTAIL-1', 'ORPHELIN-1'], callsFile } }],
          actuators: [
            act('GACHE-1', { actions: { unlock: { maxS: 10 }, lock: {} }, rest: 'lock' }),
            act('SECOURS-1', { emergencyExit: true, actions: { unlock: { maxS: 10 } } }),
            act('PORTAIL-1', { actions: { open: { maxS: 10 }, close: { maxS: 10 }, stop: {} } }),
            act('ORPHELIN-1', { actions: { unlock: { maxS: 10 }, lock: {} }, rest: 'lock' }),
          ],
        },
        null,
        2,
      ),
    );
    await startGateway();
    for (const id of ['GACHE-1', 'SECOURS-1', 'PORTAIL-1']) await until(`liaison de ${id}`, async () => (await linkUp(id)) === true, 10_000);
    assert.equal(await linkUp('AUTRE-ACT'), false, 'personne n\'ecoute l\'actionneur d\'une autre passerelle');
    // Actionneur absent de PSIM_MQTT_GATEWAYS : abonnement refuse journalise, la passerelle continue (les trois autres sont ecoutes)
    await until('journal : actionneur non autorise', () => gwHas(/actionneur ORPHELIN-1 non autorise pour ce compte/));
    assert.ok(!gwHas(/actionneur (GACHE-1|SECOURS-1|PORTAIL-1) non autorise/), 'aucun refus pour les actionneurs du compte');
    assert.equal(gateway!.exitCode, null, 'la passerelle tourne toujours');
    assert.ok(!gwHas(/démarrage impossible|demarrage impossible|erreur fatale/));
    assert.ok(!gwLog().includes(keys['GACHE-1']!), 'la cle n\'apparait jamais dans le journal de la passerelle');
    assert.ok(!psim.output().includes(keys['GACHE-1']!), 'ni dans celui du PSIM');
  });

  // -------------------------------------------------------------------------------------------------- 1 et 2 (retour local)

  it('1. ordre signe reel : la passerelle execute, la commande passe « acked » (ackKind signed) par le VRAI accuse ; 2. retour LOCAL au repos AVANT celui du PSIM', async () => {
    const r = await command(admin, 'GACHE-1', { action: 'unlock', params: { durationS: 3 }, reason: 'essai bout en bout', confirm: true, password: ADMIN_PW });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const cmdId: string = r.body.command.cmdId;
    s1.cmdId = cmdId;

    const done = await untilState(admin, 'GACHE-1', cmdId, 'acked');
    assert.equal(done.ackKind, 'signed', 'accuse SIGNE valide par le handleAck du PSIM');
    assert.match(done.ack ?? '', /^done/);
    // Le module a recu l'ordre tel que signe
    const unlock = (await until('appel unlock du module', () => callsOf(cmdId).find((c) => c.action === 'unlock')))!;
    assert.equal(unlock.actuatorId, 'GACHE-1');
    assert.equal(unlock.durationS, 3);
    // Sur le fil : l'ordre est bien le message signe du PSIM, l'accuse est signe avec la cle de l'actionneur
    const onWire = relay.down.find((m) => m.topic === 'psim/actuators/GACHE-1/command' && (JSON.parse(m.payload.toString()) as { cmdId: string }).cmdId === cmdId);
    assert.ok(onWire, 'ordre vu sur le fil');
    s1.wire = onWire.payload.toString();
    const acks = acksSeen('GACHE-1', cmdId);
    assert.equal(acks.length, 1);
    assert.equal(acks[0]!.result, 'done');

    // 2. Retour au repos LOCAL : `<cmdId>:rest`, ~3 s apres l'execution, sans que le PSIM n'ait rien envoye
    const rest = (await until('retour au repos local', () => callsOf(cmdId).find((c) => c.cmdId === `${cmdId}:rest`), 10_000))!;
    assert.equal(rest.action, 'lock');
    assert.equal(rest.durationS, undefined, 'le repos est appele sans duree');
    const elapsed = rest.t - unlock.t;
    assert.ok(elapsed >= 2800 && elapsed <= 6000, `repos ${elapsed} ms apres l'execution (attendu ~3000 ms)`);
    // Le PSIM prevoit son propre retour a +4 s : il arrive APRES le retour local, c'est un ordre signe distinct
    const psimLock = (await until('retour automatique du PSIM', () => calls().find((c) => c.actuatorId === 'GACHE-1' && c.action === 'lock' && !c.cmdId.endsWith(':rest') && c.t > unlock.t && c.cmdId !== cmdId), 12_000))!;
    assert.ok(rest.t < psimLock.t, `le repos local (${rest.t - unlock.t} ms) precede l'ordre du PSIM (${psimLock.t - unlock.t} ms)`);
    const child = await until('retour automatique du PSIM acquitte', async () => {
      const c = (await commandsOf(admin, 'GACHE-1')).find((x) => x.parentId === cmdId && x.auto);
      return c?.state === 'acked' ? c : null;
    });
    assert.equal(child.action, 'lock');
    assert.equal(child.ackKind, 'signed');
    assert.ok(gwHas(new RegExp(`GACHE-1 : retour au repos « lock » fait \\(ordre ${cmdId.slice(0, 8)}`)), 'journal de la passerelle : retour au repos fait');
    // Un seul appel unlock, jamais rejoue
    assert.equal(calls().filter((c) => c.cmdId === cmdId).length, 1);
  });
  // -------------------------------------------------------------------------------------------------- 4 (portail, issue de secours)

  it('4. portail : « stop » accepte, « open » sans retour automatique ; issue de secours : « unlock » sans repos', async () => {
    const opened = await command(admin, 'PORTAIL-1', { action: 'open', params: { durationS: 2 }, reason: 'livraison', confirm: true, password: ADMIN_PW });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const openId: string = opened.body.command.cmdId;
    assert.equal((await untilState(admin, 'PORTAIL-1', openId, 'acked')).ackKind, 'signed');
    const openCall = (await until('appel open', () => callsOf(openId).find((c) => c.action === 'open')))!;
    assert.equal(openCall.durationS, 2);

    const exit = await command(admin, 'SECOURS-1', { action: 'unlock', params: { durationS: 2 }, reason: 'evacuation', confirm: true, password: ADMIN_PW });
    assert.equal(exit.status, 201, JSON.stringify(exit.body));
    const exitId: string = exit.body.command.cmdId;
    assert.equal((await untilState(admin, 'SECOURS-1', exitId, 'acked')).ackKind, 'signed');
    // Le PSIM lui-meme refuse de verrouiller l'issue de secours (la verification LOCALE est faite plus bas)
    assert.equal((await command(admin, 'SECOURS-1', { action: 'lock', confirm: true })).status, 400);

    // Action sure du portail : immediate, sans raison ni mot de passe
    const stopped = await command(operator, 'PORTAIL-1', { action: 'stop', confirm: true });
    assert.equal(stopped.status, 201, JSON.stringify(stopped.body));
    const stopId: string = stopped.body.command.cmdId;
    assert.equal((await untilState(operator, 'PORTAIL-1', stopId, 'acked')).ackKind, 'signed');
    const stopCall = (await until('appel stop', () => callsOf(stopId).find((c) => c.action === 'stop')))!;
    assert.equal(stopCall.durationS, undefined, 'stop est instantane : aucune duree');

    // Bien apres la fin des 2 s : aucun retour, ni local ni du PSIM (portail et issue de secours)
    await wait(Math.max(0, openCall.t + 3600 - Date.now()));
    assert.deepEqual(calls().filter((c) => c.actuatorId === 'PORTAIL-1').map((c) => c.action), ['open', 'stop']);
    assert.deepEqual(calls().filter((c) => c.actuatorId === 'SECOURS-1').map((c) => c.action), ['unlock']);
    assert.ok(!(await commandsOf(admin, 'PORTAIL-1')).some((c) => c.auto), 'le PSIM ne referme jamais un portail');
    assert.ok(!(await commandsOf(admin, 'SECOURS-1')).some((c) => c.auto), 'le PSIM ne reverrouille jamais une issue de secours');
    assert.ok(!gwHas(/(PORTAIL-1|SECOURS-1) : retour au repos/), 'la passerelle ne programme aucun repos pour eux');
  });

  // -------------------------------------------------------------------------------------------------- 3 (refus locaux)

  it('3a. plafond local : le PSIM autorise 20 s, la passerelle 10 s -> refus LOCAL « not_allowed », la commande passe « refused » par le vrai accuse', async () => {
    const r = await command(operator, 'GACHE-1', { action: 'unlock', params: { durationS: 20 }, reason: 'plafond', confirm: true, password: OPERATOR_PW });
    assert.equal(r.status, 201, 'le PSIM accepte (30 s permis chez lui)');
    const cmdId: string = r.body.command.cmdId;
    const v = await untilState(operator, 'GACHE-1', cmdId, 'refused');
    assert.equal(v.ackKind, 'signed');
    assert.match(v.ack ?? '', /refused \(not_allowed\)/);
    assert.deepEqual(callsOf(cmdId), [], 'module jamais appele');
    assert.ok(gwHas(refusedLine('GACHE-1', cmdId, 'not_allowed')));
    assert.ok(gwHas(/au-dela du plafond local \(10 s\)/));
  });

  it('3b. ordre REJOUE (meme message signe republie) : ni execution, ni accuse, journalise', async () => {
    assert.ok(s1.wire, 'ordre du premier essai capture');
    const before = { calls: calls().length, acks: acksSeen('GACHE-1', s1.cmdId).length };
    assert.ok(!gwHas(/ordre\(s\) deja vu\(s\)/));
    injectOrder('GACHE-1', s1.wire);
    await until('journal : rejeu', () => gwHas(/GACHE-1 : 1 ordre\(s\) deja vu\(s\) ignore\(s\) \(rejeu\)/));
    // Meme une fois PERIME (apres ts + ttlS), le rejeu est ignore SANS accuse « stale » : l'ordre a bel et bien ete execute
    const original = JSON.parse(s1.wire) as { ts: number; ttlS: number };
    await wait(Math.max(0, original.ts + original.ttlS * 1000 + 300 - Date.now()));
    injectOrder('GACHE-1', s1.wire);
    await wait(300);
    assert.equal(calls().filter((c) => c.cmdId === s1.cmdId).length, 1, 'jamais execute une seconde fois');
    assert.equal(calls().length, before.calls, 'aucun appel du module');
    assert.equal(acksSeen('GACHE-1', s1.cmdId).length, before.acks, 'aucun nouvel accuse');
    assert.ok(!gwHas(refusedLine('GACHE-1', s1.cmdId, 'stale')));
  });

  it('3c. ordre perime, ordre date du futur, ordre hors sequence : refus LOCAUX avec accuse signe', async () => {
    await expectLocalRefusal('GACHE-1', forge('GACHE-1', { action: 'unlock', durationS: 3, ts: Date.now() - 60_000, ttlS: 10 }), 'stale');
    await expectLocalRefusal('GACHE-1', forge('GACHE-1', { action: 'unlock', durationS: 3, ts: Date.now() + 30_000, ttlS: 10 }), 'stale');
    // Un ordre frais est accepte (temoin) ; puis un ordre plus ANCIEN, encore dans sa validite, est refuse « out_of_order »
    const fresh = forge('GACHE-1', { action: 'lock' });
    injectOrder('GACHE-1', fresh.payload);
    await until('lock frais execute', () => callsOf(fresh.cmdId)[0]);
    assert.equal((await until('accuse du temoin', () => acksSeen('GACHE-1', fresh.cmdId)[0])).result, 'done');
    await expectLocalRefusal('GACHE-1', forge('GACHE-1', { action: 'lock', ts: fresh.message.ts - 2000, ttlS: 30 }), 'out_of_order');
  });

  it('3d. action inconnue, duree manquante ou absente de la liste : refus LOCAUX « not_allowed »', async () => {
    await expectLocalRefusal('GACHE-1', forge('GACHE-1', { action: 'open', durationS: 3 }), 'not_allowed');
    await expectLocalRefusal('GACHE-1', forge('GACHE-1', { action: 'unlock' }), 'not_allowed'); // action temporisee sans duree
    await expectLocalRefusal('GACHE-1', forge('GACHE-1', { action: 'lock', durationS: 3 }), 'not_allowed'); // action instantanee avec duree
    await expectLocalRefusal('PORTAIL-1', forge('PORTAIL-1', { action: 'open', durationS: 11 }), 'not_allowed');
  });

  it('3e. issue de secours : « lock » (que le PSIM refuse deja) est refuse LOCALEMENT « emergency_exit », meme signe avec la vraie cle', async () => {
    await expectLocalRefusal('SECOURS-1', forge('SECOURS-1', { action: 'lock' }), 'emergency_exit');
    // ... et l'issue reste utilisable : un « unlock » valide passe toujours
    const ok = forge('SECOURS-1', { action: 'unlock', durationS: 2 });
    injectOrder('SECOURS-1', ok.payload);
    assert.equal((await until('accuse done', () => acksSeen('SECOURS-1', ok.cmdId)[0])).result, 'done');
  });

  it('3f. ordre mal signe, mal forme ou trop gros : ignores SANS accuse (aucun oracle), compteurs journalises', async () => {
    // Chaque variante a SON cmdId : l'absence d'appel et d'accuse se lit par cmdId
    const flipped = forge('GACHE-1', { action: 'lock' });
    const badSig = JSON.parse(flipped.payload) as { sig: string };
    badSig.sig = badSig.sig.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    // Signe avec la cle d'un AUTRE actionneur (un attaquant qui n'a que la cle de SECOURS-1)
    const otherKey = signCommand(keys['SECOURS-1']!, 'GACHE-1', { cmdId: randomBytes(16).toString('hex'), action: 'lock', params: {}, ts: Date.now(), ttlS: 10 });
    const big = forge('GACHE-1', { action: 'lock' });
    const extraParam = forge('GACHE-1', { action: 'lock' });
    const bad = [
      { cmdId: flipped.cmdId, payload: JSON.stringify(badSig) },
      { cmdId: otherKey.cmdId, payload: JSON.stringify(otherKey) },
      { cmdId: big.cmdId, payload: JSON.stringify({ ...big.message, extra: 'x'.repeat(2000) }) }, // plus de 1 024 octets
      { cmdId: extraParam.cmdId, payload: JSON.stringify({ ...extraParam.message, params: { durationS: 1, autre: 1 } }) }, // cle inconnue
      { cmdId: '', payload: 'pas du json' },
    ];
    for (const b of bad) injectOrder('GACHE-1', b.payload);
    await until('journal : signature fausse', () => gwHas(/GACHE-1 : \d+ ordre\(s\) a signature fausse ignore\(s\)/));
    await until('journal : mal forme', () => gwHas(/GACHE-1 : \d+ ordre\(s\) mal forme\(s\) ignore\(s\)/));
    // Un ordre valide juste derriere prouve que les precedents ont ete traites : seul celui-la est execute et accuse
    const good = forge('GACHE-1', { action: 'lock' });
    injectOrder('GACHE-1', good.payload);
    await until('temoin execute', () => callsOf(good.cmdId)[0]);
    await until('temoin accuse', () => acksSeen('GACHE-1', good.cmdId)[0]);
    for (const b of bad.filter((x) => x.cmdId)) {
      assert.deepEqual(callsOf(b.cmdId), [], 'module non appele');
      assert.deepEqual(acksSeen('GACHE-1', b.cmdId), [], 'aucun accuse');
    }
    assert.equal(callsOf(good.cmdId).length, 1);
    // Tous les accuses vus sur le fil concernent des ordres a signature valide : aucune reponse a exploiter pour deviner la cle
    const ackIds = relay.up.filter((m) => m.topic === 'psim/actuators/GACHE-1/ack').map((m) => (JSON.parse(m.payload.toString()) as { cmdId: string }).cmdId);
    for (const b of bad.filter((x) => x.cmdId)) assert.ok(!ackIds.includes(b.cmdId), `aucun accuse pour ${b.cmdId}`);
  });

  it('3g. le PSIM ne se laisse pas tromper par les accuses des ordres fabriques (aucune commande creee, journal scelle intact)', async () => {
    const known = new Set((await commandsOf(admin, 'GACHE-1')).map((c) => c.cmdId));
    const forgedAcked = relay.up.filter((m) => m.topic === 'psim/actuators/GACHE-1/ack').map((m) => (JSON.parse(m.payload.toString()) as { cmdId: string }).cmdId).filter((id) => !known.has(id));
    assert.ok(forgedAcked.length >= 3, 'des accuses d\'ordres inconnus du PSIM sont bien partis (stale, out_of_order, not_allowed...)');
    assert.deepEqual((await commandsOf(admin, 'GACHE-1')).filter((c) => forgedAcked.includes(c.cmdId)), []);
    // ... mais il les a vus et les a journalises (au plus une fois par minute et par actionneur)
    const audit = (await api('GET', '/api/audit?limit=300', admin)).body as { action: string; details: string | null }[];
    assert.ok(audit.some((e) => e.action === 'commande_accuse_invalide' && /commande inconnue/.test(e.details ?? '')), 'journal du PSIM : accuse pour une commande inconnue');
    assert.equal((await api('POST', '/api/system/journal/verify', admin)).body.ok, true);
  });

  // -------------------------------------------------------------------------------------------------- 5 (droits MQTT)

  it('5a. droits MQTT du compte de passerelle : SES ordres oui ; un autre actionneur, les jokers, les accuses, les detecteurs : SUBACK 128', async () => {
    const c = await rawClient(GW);
    for (const id of GW.actuators) assert.notEqual(await subscribeCode(c, `psim/actuators/${id}/command`), 128, `abonnement a ${id}`);
    for (const topic of [
      'psim/actuators/AUTRE-ACT/command',
      'psim/actuators/ORPHELIN-1/command',
      'psim/actuators/+/command',
      'psim/actuators/#',
      'psim/actuators/GACHE-1/ack',
      'psim/actuators/GACHE-/command',
      'psim/detectors/+/state',
      'psim/detectors/D-GW1-1/state',
      'psim/detectors/D-B-1/state',
      '#',
      '$SYS/#',
    ]) {
      assert.equal(await subscribeCode(c, topic), 128, `refuse : ${topic}`);
    }
    const other = await rawClient(OTHER);
    assert.notEqual(await subscribeCode(other, 'psim/actuators/AUTRE-ACT/command'), 128);
    assert.equal(await subscribeCode(other, 'psim/actuators/GACHE-1/command'), 128, 'et l\'autre passerelle n\'ecoute pas les actionneurs de la premiere');
    await c.endAsync(true);
    await other.endAsync(true);
  });

  it('5b. publications : un compte ne publie ni un ordre (meme signe avec la vraie cle), ni l\'etat d\'un detecteur d\'une autre passerelle ; il publie ses propres detecteurs', async () => {
    const watcher = await rawClient(MAIN);
    const seen: string[] = [];
    watcher.on('message', (t) => seen.push(t));
    assert.notEqual(await subscribeCode(watcher, 'psim/detectors/+/state'), 128);

    // Ordre signe avec la vraie cle, publie par le compte de la passerelle lui-meme : jamais remis a l'ecoute de la passerelle
    const order = forge('GACHE-1', { action: 'unlock', durationS: 2 });
    await attempt(await rawClient(GW), 'psim/actuators/GACHE-1/command', order.payload);
    const orderMain = forge('GACHE-1', { action: 'unlock', durationS: 2 });
    await attempt(await rawClient(MAIN), 'psim/actuators/GACHE-1/command', orderMain.payload);
    await wait(300);
    assert.deepEqual(callsOf(order.cmdId), [], 'ordre publie par la passerelle : jamais execute');
    assert.deepEqual(callsOf(orderMain.cmdId), [], 'ordre publie par le compte principal : jamais execute');
    assert.ok(!relay.down.some((m) => m.payload.toString().includes(order.cmdId) || m.payload.toString().includes(orderMain.cmdId)));

    // Detecteurs : un compte ne parle que pour SES detecteurs
    await attempt(await rawClient(GW), 'psim/detectors/D-B-1/state', JSON.stringify({ state: 'alarm' }));
    await attempt(await rawClient(GW), 'psim/detectors/ANY/state', JSON.stringify({ state: 'alarm' }));
    const mine = await rawClient(GW);
    mine.publish('psim/detectors/D-GW1-1/state', JSON.stringify({ state: 'normal' }), { qos: 1 });
    const theirs = await rawClient(OTHER);
    theirs.publish('psim/detectors/D-B-1/state', JSON.stringify({ state: 'normal' }), { qos: 1 });
    await until('temoins recus', () => seen.includes('psim/detectors/D-GW1-1/state') && seen.includes('psim/detectors/D-B-1/state'));
    await wait(200);
    assert.deepEqual([...seen].sort(), ['psim/detectors/D-B-1/state', 'psim/detectors/D-GW1-1/state'], 'seuls les temoins legitimes sont passes (D-B-1 venu de SON compte, pas de gw-pilote)');
    assert.equal(seen.filter((t) => t === 'psim/detectors/D-B-1/state').length, 1);
  });

  it('5c. accuses : un compte publie les accuses de SES actionneurs seulement ; l\'accuse signe d\'un autre actionneur est ecarte par le broker', async () => {
    // Une commande en vol sur AUTRE-ACT (que seul le compte « gw-autre » ecoute), jamais accusee par son proprietaire d'abord
    const owner = await rawClient(OTHER);
    const received: string[] = [];
    owner.on('message', (_t, p) => received.push(p.toString()));
    assert.notEqual(await subscribeCode(owner, 'psim/actuators/AUTRE-ACT/command'), 128);
    await until('liaison de AUTRE-ACT', async () => (await linkUp('AUTRE-ACT')) === true);
    const r = await command(operator, 'AUTRE-ACT', { action: 'on', params: { durationS: 2 }, confirm: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const cmdId: string = r.body.command.cmdId;
    await until('ordre recu par son proprietaire', () => received.length > 0);
    assert.equal((await viewOf(operator, 'AUTRE-ACT', cmdId))?.state, 'sent');

    // L'attaquant (compte gw-pilote) connait la cle et fabrique un accuse « done » parfait
    const forged = JSON.stringify(signAck(keys['AUTRE-ACT']!, 'AUTRE-ACT', { cmdId, result: 'done', ts: Date.now() }));
    await attempt(await rawClient(GW), 'psim/actuators/AUTRE-ACT/ack', forged);
    await wait(300);
    assert.equal((await viewOf(operator, 'AUTRE-ACT', cmdId))?.state, 'sent', 'accuse d\'un compte non autorise : ecarte');

    // Le proprietaire publie exactement le meme accuse : accepte (temoin)
    await owner.publishAsync('psim/actuators/AUTRE-ACT/ack', forged, { qos: 1 });
    const done = await untilState(operator, 'AUTRE-ACT', cmdId, 'acked');
    assert.equal(done.ackKind, 'signed');
    await owner.endAsync(true);
  });

  // -------------------------------------------------------------------------------------------------- 2 (PSIM arrete)

  it('2b. PSIM TUE juste apres l\'ordre : le module recoit quand meme « lock » a l\'heure ; le PSIM redemarre sur la meme base ne renvoie rien et reprend le retour', async () => {
    const r = await command(admin, 'GACHE-1', { action: 'unlock', params: { durationS: 3 }, reason: 'coupure du PSIM', confirm: true, password: ADMIN_PW });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const cmdId: string = r.body.command.cmdId;
    const unlock = (await until('ordre recu par le module', () => callsOf(cmdId).find((c) => c.action === 'unlock')))!;

    await killProcess(psim.proc); // plus de PSIM : ni retour automatique, ni accuse, ni broker
    await until('journal : liaison perdue', () => gwHas(/connexion au PSIM perdue|PSIM injoignable/), 10_000);

    const rest = (await until('retour au repos local, PSIM arrete', () => callsOf(cmdId).find((c) => c.cmdId === `${cmdId}:rest`), 10_000))!;
    assert.equal(rest.action, 'lock');
    const elapsed = rest.t - unlock.t;
    assert.ok(elapsed >= 2800 && elapsed <= 6000, `repos ${elapsed} ms apres l'execution (attendu ~3000 ms)`);
    await until('journal : repos fait', () => gwHas(new RegExp(`GACHE-1 : retour au repos « lock » fait \\(ordre ${cmdId.slice(0, 8)}`)));
    assert.equal(psim.proc.exitCode === null && psim.proc.signalCode === null, false, 'le PSIM est bien arrete');

    // Redemarrage sur la meme base et les memes ports : la passerelle se reconnecte seule
    psim = await startPsim(root, ports);
    admin = await login('admin', ADMIN_PW);
    for (const id of ['GACHE-1', 'SECOURS-1', 'PORTAIL-1']) await until(`liaison retablie de ${id}`, async () => (await linkUp(id)) === true, 20_000);
    const after = await viewOf(admin, 'GACHE-1', cmdId);
    assert.ok(after && (after.state === 'acked' || after.state === 'expired'), `commande en vol au moment de l'arret : ${after?.state}`);
    if (after.state === 'expired') assert.match(after.ack ?? '', /jamais renvoyee/);
    // Rien n'est renvoye par le PSIM : le meme ordre n'est execute qu'une fois
    assert.equal(calls().filter((c) => c.cmdId === cmdId).length, 1);
    // Le PSIM avait prevu un retour a l'etat sur : il le reprend (sur, idempotent) des que la passerelle est revenue
    const child = await until('retour automatique repris apres redemarrage', async () => {
      const c = (await commandsOf(admin, 'GACHE-1')).find((x) => x.parentId === cmdId && x.auto);
      return c?.state === 'acked' ? c : null;
    }, 20_000);
    assert.equal(child.action, 'lock');
    assert.equal(child.ackKind, 'signed');
  });
});
