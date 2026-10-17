/**
 * CHAINE COMPLETE du controle d'acces, sans aucun faux maillon cote PSIM ni cote passerelle :
 *
 *   faux controleur Dahua (gateway/test/fake-dahua.ts, HTTP Digest, 127.0.0.1)
 *     <--> module REEL `acces-dahua`, charge par le socle REEL de la passerelle (startRuntime, section `actuators` + cle de signature)
 *     <--> broker MQTT du VRAI PSIM (processus `server/index.ts`, base temporaire, compte de passerelle)
 *     <--> API reelle du PSIM : /api/access/events, /api/access/doors, /api/state (incidents), /api/actuators/:id/commands, /ws.
 *
 * Seul le controleur est un faux. Les ordres d'ouverture partent de l'API du PSIM (ordre signe), traversent le broker, sont verifies
 * par le pilote de la passerelle, executes par le module (`openDoor` / `closeDoor` REELLEMENT recus par le faux controleur) et
 * accuses (accuse signe, verifie par le PSIM). Rien ne publie un ordre autrement que par la route POST /api/actuators/:id/commands.
 *
 * La passerelle tourne DANS le processus de l'essai (startRuntime), le PSIM dans un processus separe ; tout est arrete et efface
 * a la fin. Ports libres pris au hasard (web, broker, controleurs), dossiers temporaires, rien dans data/ ni data-prod/.
 *
 * Scenarios : 1 passage puis porte forcee ; 2 ouverture a distance ; 3 issue de secours ; 4 coupure du controleur ;
 * 5 mode de porte (conditionnel, voir plus bas) ; 6 mesures chiffrees des objectifs du PRD, section 12.
 *
 * Ce que ce fichier ne verifie PAS, faute de support dans ce worktree : voir les `skip` du scenario 5 (chacun dit pourquoi).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { after, afterEach, before, describe, it } from 'node:test';
import mqtt from 'mqtt';
import WebSocket from 'ws';
import { loadConfig } from '../gateway/src/config.ts';
import type { Level, Logger } from '../gateway/src/log.ts';
import { startRuntime } from '../gateway/src/runtime.ts';
import type { GatewayRuntime } from '../gateway/src/runtime.ts';
import { FakeDahua } from '../gateway/test/fake-dahua.ts';

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';
const MQTT_PW = 'Mot-de-passe-mqtt-solide-3';
/** Compte de la passerelle de l'essai : ses detecteurs `ACC-*` et ses actionneurs `LK-*` (serrures). */
const GW = { user: 'gw-chaine', password: 'Mot-de-passe-passerelle-chaine-1', detectors: ['ACC-*'], actuators: ['LK-*'] };

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });

/** Attend une condition (sonde asynchrone) ; en cas d'echec, joint la fin des journaux du PSIM et de la passerelle courante. */
async function until<T>(what: string, probe: () => T | Promise<T>, ms = 10_000, every = 25): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) assert.fail(`delai depasse (${ms} ms) : ${what}\n--- PSIM ---\n${psim?.output().split('\n').slice(-12).join('\n')}\n--- passerelle ---\n${lastLog.split('\n').slice(-12).join('\n')}`);
    await wait(every);
  }
}

// ---------------------------------------------------------------------------------------------------------------- statistiques

interface Stats {
  n: number;
  min: number;
  mediane: number;
  p95: number;
  max: number;
}
/** Rang le plus proche pour le centile ; mediane = moyenne des deux valeurs centrales si n est pair. */
function stats(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const rank = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
  const mid = s.length / 2;
  const mediane = s.length % 2 === 1 ? s[Math.floor(mid)]! : (s[mid - 1]! + s[mid]!) / 2;
  const r = (v: number) => Math.round(v * 10) / 10;
  return { n: s.length, min: r(s[0]!), mediane: r(mediane), p95: r(rank(0.95)), max: r(s[s.length - 1]!) };
}

// ---------------------------------------------------------------------------------------------------------------- PSIM reel

interface Psim {
  proc: ChildProcess;
  base: string;
  mqttPort: number;
  output: () => string;
}

let root = '';
let psim: Psim | null = null;
let admin = '';
let operator = '';
/** Journal de la passerelle de l'essai en cours (diagnostic). */
let lastLog = '';

async function startPsim(): Promise<Psim> {
  const web = await freePort();
  const mqttPort = await freePort();
  const base = `http://127.0.0.1:${web}`;
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    PSIM_DATA_DIR: join(root, 'data'),
    PSIM_BACKUP_DIR: join(root, 'backups'),
    PSIM_PORT: String(web),
    PSIM_MQTT_PORT: String(mqttPort),
    PSIM_ADMIN_PASSWORD: ADMIN_PW,
    PSIM_OPERATOR_PASSWORD: OPERATOR_PW,
    PSIM_MQTT_PASSWORD: MQTT_PW,
    PSIM_DEMO_LOGIN: '0',
    PSIM_REQUIRE_2FA: 'none',
    PSIM_MQTT_GATEWAYS: JSON.stringify([GW]),
  });
  let output = '';
  const proc = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (d) => (output += d));
  proc.stderr!.on('data', (d) => (output += d));
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).status === 200) return { proc, base, mqttPort, output: () => output };
    } catch {
      // pas encore pret
    }
    await wait(250);
  }
  proc.kill();
  throw new Error(`serveur non demarre :\n${output}`);
}

async function killProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((res) => proc.once('exit', res));
  proc.kill('SIGKILL');
  await exited;
}

interface Reply {
  status: number;
  body: any;
  text: string;
}
async function api(method: string, path: string, cookie: string | null, body?: unknown): Promise<Reply> {
  const res = await fetch(`${psim!.base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text };
}
async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${psim!.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200, `connexion de ${username}`);
  return res.headers.getSetCookie()[0]!.split(';')[0]!;
}

const doorOf = async (id: string): Promise<any> => (await api('GET', `/api/access/doors/${id}`, admin)).body;
const eventsOf = async (query = ''): Promise<any> => (await api('GET', `/api/access/events?limit=200&count=1${query}`, admin)).body;
const incidentsOf = async (detectorId: string): Promise<any[]> => ((await api('GET', '/api/state', admin)).body.incidents as any[]).filter((i) => i.detectorId === detectorId);
const commandsOf = async (actuatorId: string): Promise<any[]> => (await api('GET', `/api/actuators/${actuatorId}/commands`, admin)).body;
const auditLog = async (): Promise<any[]> => (await api('GET', '/api/audit?limit=500', admin)).body;
const linkUp = async (id: string): Promise<boolean | null | undefined> => ((await api('GET', '/api/actuators', admin)).body.actuators as { id: string; linkUp: boolean | null }[]).find((a) => a.id === id)?.linkUp;

// ---------------------------------------------------------------------------------------------------------------- temps reel (/ws)

interface Live {
  /** Heure (performance.now) de la premiere apparition de chaque incident. */
  incidents: Map<number, { detectorId: string; at: number }>;
  /** Heure de la premiere apparition de chaque commande a l'etat `acked`. */
  acked: Map<string, number>;
  close(): void;
}
/** Ecoute le temps reel du PSIM comme le fait l'ecran de supervision (meme cookie de session, meme origine). */
async function openLive(cookie: string): Promise<Live> {
  const ws = new WebSocket(`${psim!.base.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie } });
  const live: Live = { incidents: new Map(), acked: new Map(), close: () => ws.terminate() };
  ws.on('message', (data) => {
    const at = performance.now();
    let ev: any;
    try {
      ev = JSON.parse(String(data));
    } catch {
      return;
    }
    if (ev.type === 'incident' && ev.incident && !live.incidents.has(ev.incident.id)) live.incidents.set(ev.incident.id, { detectorId: ev.incident.detectorId, at });
    else if (ev.type === 'command' && ev.command?.state === 'acked' && !live.acked.has(ev.command.cmdId)) live.acked.set(ev.command.cmdId, at);
  });
  ws.on('error', () => undefined);
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
    ws.once('close', () => rej(new Error('temps reel ferme')));
  });
  await wait(100); // l'instantane initial (snapshot) est passe
  return live;
}

// ---------------------------------------------------------------------------------------------------------------- une chaine

interface DoorSpec {
  /** Detecteur PSIM de la porte. */
  id: string;
  /** Numero de porte du controleur (1 a 4). */
  no: number;
  name: string;
  emergencyExit?: boolean;
}
interface ActSpec {
  id: string;
  /** Numero de porte du controleur commandee par cet actionneur. */
  doorNo: number;
  maxS?: number;
  emergencyExit?: boolean;
  /** Detecteur de la porte a lier a cet actionneur dans le PSIM des la mise en place (sinon : liaison faite par l'essai). */
  link?: string;
  /** Actionneur cree dans le PSIM avec les actions PAR DEFAUT (donc avec `evacuate`), au lieu des actions explicites d'une base ancienne. */
  psimDefaultActions?: boolean;
  /** La passerelle declare aussi l'action `evacuate` (plafond 900 s) dans sa liste locale. */
  gatewayEvacuate?: boolean;
}
interface ChainOpts {
  tag: string;
  doors: DoorSpec[];
  actuators?: ActSpec[];
}
interface Chain {
  controllerId: string;
  fake: FakeDahua;
  runtime: GatewayRuntime;
  keys: Record<string, string>;
  log: () => string;
  stop(): Promise<void>;
}
/** Journal de la passerelle d'un essai, garde en memoire (jamais de cle ni de mot de passe dedans : le socle les masque). */
function memoryLogger(): Logger & { text: () => string } {
  const lines: string[] = [];
  return { log: (level: Level, text: string) => void lines.push(`${level} ${text}`), text: () => lines.join('\n') };
}

const chains: Chain[] = [];

/**
 * Monte la chaine d'un scenario : faux controleur, objets du PSIM (detecteurs, controleur, portes, actionneurs, cles), configuration
 * de la passerelle, demarrage du socle reel ; rend la main quand les portes donnent signe de vie et que les actionneurs sont ecoutes.
 */
async function buildChain(o: ChainOpts): Promise<Chain> {
  const tag = o.tag.toUpperCase();
  const controllerId = `CTL-${tag}`;
  const dir = mkdtempSync(join(root, `${o.tag}-`));
  mkdirSync(join(dir, 'secrets'), { recursive: true });
  const fake = await FakeDahua.start({ heartbeatMs: 100 });
  const logger = memoryLogger();
  const chain: Chain = { controllerId, fake, runtime: null as never, keys: {}, log: () => logger.text(), stop: async () => undefined };
  let stopped = false;
  chain.stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await chain.runtime?.stop();
    } catch {
      // arret au mieux
    }
    await fake.close().catch(() => undefined);
  };
  chains.push(chain);

  // --- Objets du PSIM ---
  for (const d of o.doors) {
    const r = await api('POST', '/api/devices', admin, { id: d.id, kind: 'detector', name: d.name, zone: 'Essai', category: 'access' });
    assert.equal(r.status, 201, r.text);
  }
  const ctl = await api('POST', '/api/access/controllers', admin, { id: controllerId, name: `Controleur ${tag}`, brand: 'dahua', model: 'ASC1204B', host: '127.0.0.1', gatewayId: 'gw-chaine' });
  assert.equal(ctl.status, 201, ctl.text);
  for (const d of o.doors) {
    const r = await api('POST', '/api/access/doors', admin, { detectorId: d.id, controllerId, doorNo: d.no, kind: 'door', emergencyExit: d.emergencyExit === true });
    assert.equal(r.status, 201, r.text);
  }
  for (const a of o.actuators ?? []) {
    const r = await api('POST', '/api/actuators', admin, {
      reauth: ADMIN_PW,
      transport: 'mqtt',
      id: a.id,
      name: `Serrure ${a.id}`,
      type: 'lock',
      ...(a.emergencyExit ? { emergencyExit: true } : {}),
      ...(a.psimDefaultActions ? {} : { actions: { unlock: { maxS: a.maxS ?? 30 } } }),
    });
    assert.equal(r.status, 201, r.text);
    assert.match(r.body.key, /^[0-9a-f]{64}$/);
    chain.keys[a.id] = r.body.key;
    writeFileSync(join(dir, 'secrets', `${a.id.toLowerCase()}.key`), `${r.body.key}\n`);
  }

  // --- Passerelle reelle : module acces-dahua + section actuators ---
  const doors: Record<string, string> = {};
  for (const d of o.doors) doors[String(d.no)] = d.id;
  const moduleActuators: Record<string, { door: number; type: 'lock' }> = {};
  for (const a of o.actuators ?? []) moduleActuators[a.id] = { door: a.doorNo, type: 'lock' };
  const config: Record<string, unknown> = {
    name: `passerelle-${o.tag}`,
    psim: { url: `mqtt://127.0.0.1:${psim!.mqttPort}`, username: GW.user, password: GW.password, detectors: GW.detectors },
    dataDir: join(dir, 'gw-data'),
    retry: { minMs: 100, maxMs: 400 },
    moduleRetry: { minMs: 100, maxMs: 400 },
    log: { file: false },
    modules: [
      {
        name: 'acces-dahua',
        config: {
          stateDir: join(dir, 'acces-state'),
          controllers: [{ id: controllerId, host: fake.host, port: fake.port, username: fake.username, password: fake.password, doors, actuators: moduleActuators }],
          thresholds: { offlineGraceMs: 500, silenceMs: 10_000 },
          reconnect: { minMs: 100, maxMs: 400 },
        },
      },
    ],
  };
  if ((o.actuators ?? []).length > 0) {
    config.actuators = (o.actuators ?? []).map((a) => ({
      id: a.id,
      keyFile: join(dir, 'secrets', `${a.id.toLowerCase()}.key`),
      module: 'acces-dahua',
      ...(a.emergencyExit
        ? { emergencyExit: true, actions: { unlock: { maxS: a.maxS ?? 30 } } }
        : { actions: { unlock: { maxS: a.maxS ?? 30 }, ...(a.gatewayEvacuate ? { evacuate: { maxS: 900 } } : {}), lock: {} }, rest: 'lock' }),
    }));
  }
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(config, null, 2));
  chain.runtime = await startRuntime({ config: loadConfig(file), logger });
  lastLog = '';
  const refresh = setInterval(() => (lastLog = logger.text()), 200);
  refresh.unref();
  const stop = chain.stop;
  chain.stop = async () => {
    clearInterval(refresh);
    lastLog = logger.text();
    await stop();
  };

  // --- Liaisons demandees des la mise en place ---
  for (const a of o.actuators ?? []) {
    if (!a.link) continue;
    const r = await api('PUT', `/api/access/doors/${a.link}`, admin, { actuatorId: a.id });
    assert.equal(r.status, 200, r.text);
  }

  // --- Pret : portes vivantes dans le PSIM, memoire du controleur relue, file videe, actionneurs ecoutes ---
  await until(
    'les portes donnent signe de vie dans le PSIM',
    async () => {
      const list = (await api('GET', '/api/access/doors', admin)).body as { detectorId: string; lastSeen: number | null }[];
      return o.doors.every((d) => list.find((x) => x.detectorId === d.id)?.lastSeen != null);
    },
    20_000,
  );
  await until('memoire du controleur relue', () => fake.recordFinds > 0, 10_000);
  await until('file de la passerelle videe', () => chain.runtime.status().queue.pending === 0, 10_000);
  for (const a of o.actuators ?? []) await until(`liaison de ${a.id}`, async () => (await linkUp(a.id)) === true, 15_000);
  return chain;
}

/** Releve les ordres recus par le faux controleur avec l'heure d'arrivee de chacun (performance.now). */
function watchCommands(fake: FakeDahua): { seen: { action: string; channel: number | null; type: string | undefined; at: number }[]; stop(): void } {
  const seen: { action: string; channel: number | null; type: string | undefined; at: number }[] = [];
  const timer = setInterval(() => {
    while (seen.length < fake.commands.length) {
      const c = fake.commands[seen.length]!;
      seen.push({ action: c.action, channel: c.channel, type: c.query.Type, at: performance.now() });
    }
  }, 5);
  timer.unref();
  return { seen, stop: () => clearInterval(timer) };
}

// ---------------------------------------------------------------------------------------------------------------- essai

describe('chaine complete : faux controleur Dahua -> module acces-dahua -> socle de la passerelle -> broker -> PSIM reel', { timeout: 240_000 }, () => {
  const rawClients: mqtt.MqttClient[] = [];
  const lives: Live[] = [];

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'psim-e2e-chaine-'));
    psim = await startPsim();
    admin = await login('admin', ADMIN_PW);
    operator = await login('operateur', OPERATOR_PW);
  });

  afterEach(async () => {
    for (const l of lives.splice(0)) l.close();
    for (const c of rawClients.splice(0)) await c.endAsync(true).catch(() => undefined);
    for (const c of chains.splice(0).reverse()) await c.stop();
  });

  after(async () => {
    for (const l of lives.splice(0)) l.close();
    for (const c of rawClients.splice(0)) await c.endAsync(true).catch(() => undefined);
    for (const c of chains.splice(0).reverse()) await c.stop();
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

  // ------------------------------------------------------------------------------------------------------------------------
  // 1. Passage accepte puis porte forcee
  // ------------------------------------------------------------------------------------------------------------------------

  it('1. un passage accepte arrive dans /api/access/events (porte, titulaire, methode, resultat, heure du controleur) ; puis la porte forcee ouvre un incident critique', { timeout: 40_000 }, async () => {
    const c = await buildChain({
      tag: 's1',
      doors: [
        { id: 'ACC-S1-ENT', no: 1, name: 'Entree personnel' },
        { id: 'ACC-S1-SAL', no: 2, name: 'Salle serveur' },
      ],
    });

    // Passage accepte a la premiere porte (le numero 0 du controleur), puis un refus.
    const granted = c.fake.emitAccess({ recNo: 1001, cardNo: '0012345', cardName: 'KONAN Yao', userId: '101', door: 0 });
    c.fake.emitAccess({ recNo: 1002, cardNo: '0099999', status: 0, errorCode: 0x10, door: 0 });
    const list = await until('deux passages dans le journal du PSIM', async () => {
      const r = await eventsOf('&door=ACC-S1-ENT');
      return r.total === 2 ? r : null;
    });
    const item = list.items.find((i: any) => i.eventId === '1001');
    assert.ok(item, JSON.stringify(list.items));
    assert.equal(item.doorId, 'ACC-S1-ENT');
    assert.equal(item.doorName, 'Entree personnel');
    assert.equal(item.controllerId, c.controllerId);
    assert.equal(item.holderName, 'KONAN Yao');
    assert.equal(item.holderRef, '101');
    assert.equal(item.credential, '0012345');
    assert.equal(item.method, 'badge');
    assert.equal(item.methodLabel, 'Badge');
    assert.equal(item.direction, 'in');
    assert.equal(item.result, 'granted');
    assert.equal(item.late, false);
    assert.equal(item.atDevice, granted.CreateTime * 1000, "heure du CONTROLEUR (pas celle de l'arrivee)");
    assert.ok(item.atReceived >= item.atDevice, 'recu apres');
    assert.ok(item.atReceived - item.atDevice < 15_000, `recu avec ${item.atReceived - item.atDevice} ms de retard`);
    const refused = list.items.find((i: any) => i.eventId === '1002');
    assert.equal(refused.result, 'denied');
    assert.equal(refused.reason, 'unknown_credential');
    assert.equal(refused.resultLabel, 'Refusé — badge inconnu');
    // Un refus isole n'est pas un incident ; la fiche de la porte montre le dernier passage.
    assert.deepEqual(await incidentsOf('ACC-S1-ENT'), []);
    const sheet = await doorOf('ACC-S1-ENT');
    assert.equal(sheet.lastPassages[0].eventId, '1002');
    assert.equal(sheet.door.lastPassageAt, Math.max(item.atDevice, refused.atDevice));
    assert.equal(sheet.door.deviceStatus, 'normal');
    assert.notEqual(sheet.door.state, 'forced');

    // Porte forcee sur la SECONDE porte (index 1 du controleur) : incident critique, etat « forcee ».
    c.fake.emitDoor('BreakIn', { action: 'Start', index: 1, data: { UTC: Date.now() } });
    const incident = await until('incident porte forcee', async () => (await incidentsOf('ACC-S1-SAL')).find((i) => i.event === 'door_forced'), 15_000);
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.status, 'open');
    assert.equal(incident.category, 'access');
    assert.equal(incident.detectorId, 'ACC-S1-SAL');
    const forced = await until('porte « forcee »', async () => {
      const d = (await doorOf('ACC-S1-SAL')).door;
      return d.state === 'forced' ? d : null;
    });
    assert.equal(forced.stateLabel, 'Forcée');
    assert.equal(forced.deviceStatus, 'alarm');
    assert.match(forced.stateHint, /camera|caméra/i, 'le texte dit quoi faire');
    // L'autre porte n'est pas touchee.
    assert.deepEqual(await incidentsOf('ACC-S1-ENT'), []);
    assert.notEqual((await doorOf('ACC-S1-ENT')).door.state, 'forced');
    // Un seul incident, meme si le message est presente plusieurs fois.
    await wait(300);
    assert.equal((await incidentsOf('ACC-S1-SAL')).length, 1);

    // Fermeture : retour a la normale ; l'incident reste a traiter (jamais clos tout seul).
    c.fake.emitDoor('DoorStatus', { index: 1, data: { Status: 'Close', UTC: Date.now() } });
    await until('porte refermee', async () => ((await doorOf('ACC-S1-SAL')).door.state === 'closed' ? true : null));
    assert.equal((await incidentsOf('ACC-S1-SAL'))[0]!.status, 'open');
    assert.ok(!/message rejete/.test(c.log()), c.log());
  });

  // ------------------------------------------------------------------------------------------------------------------------
  // 2. Ouverture a distance
  // ------------------------------------------------------------------------------------------------------------------------

  it('2. ouverture a distance : ordre signe -> pilote -> module -> openDoor REEL -> accuse signe -> « acked » -> retour a l\'etat sur ; refus (428, 428, 403, 428) sans rien envoyer', { timeout: 60_000 }, async () => {
    const DOOR = 'ACC-S2-ENT';
    const ACT = 'LK-S2-ENT';
    const c = await buildChain({ tag: 's2', doors: [{ id: DOOR, no: 1, name: 'Entree principale' }], actuators: [{ id: ACT, doorNo: 1, maxS: 30 }] });

    // Avant la liaison : la fiche dit pourquoi l'ouverture a distance n'est pas disponible.
    const before = (await doorOf(DOOR)).remote;
    assert.equal(before.available, false);
    assert.match(before.reason, /actionneur/i);
    assert.equal(before.actuatorId, null);

    // Liaison porte <-> actionneur.
    const linked = await api('PUT', `/api/access/doors/${DOOR}`, admin, { actuatorId: ACT });
    assert.equal(linked.status, 200, linked.text);
    assert.equal(linked.body.actuatorId, ACT);
    const sheet = await doorOf(DOOR);
    assert.equal(sheet.door.actuatorId, ACT);
    assert.equal(sheet.remote.available, true, JSON.stringify(sheet.remote));
    assert.equal(sheet.remote.reason, null);
    assert.equal(sheet.remote.actuatorId, ACT);
    assert.equal(sheet.remote.actuatorName, `Serrure ${ACT}`);
    assert.equal(sheet.remote.actuatorType, 'lock');

    // Cas refuses : aucun ordre ne part, aucune commande n'est creee.
    const body = { action: 'unlock', params: { durationS: 2 }, reason: 'Visiteur attendu', confirm: true, password: ADMIN_PW };
    const post = (over: Record<string, unknown>, drop: string[] = []) => {
      const b: Record<string, unknown> = { ...body, ...over };
      for (const k of drop) delete b[k];
      return api('POST', `/api/actuators/${ACT}/commands`, admin, b);
    };
    assert.equal((await post({}, ['reason'])).status, 428, 'sans raison');
    assert.equal((await post({}, ['password'])).status, 428, 'sans mot de passe');
    assert.equal((await post({}, ['confirm'])).status, 428, 'sans confirmation');
    assert.equal((await post({ confirm: false })).status, 428, 'confirmation fausse');
    assert.equal((await post({ reason: '   ' })).status, 428, 'raison blanche');
    const wrong = await post({ password: 'Un-mauvais-mot-de-passe-1' });
    assert.equal(wrong.status, 403, wrong.text);
    await wait(400); // un ordre aurait eu le temps d'arriver
    assert.deepEqual(c.fake.commands, [], 'le controleur n\'a rien recu');
    assert.deepEqual(await commandsOf(ACT), [], 'aucune commande creee');
    const refusedLog = await auditLog();
    assert.ok(refusedLog.some((e) => e.action === 'commande_reauth_echec' && e.deviceId === ACT), 'le mot de passe faux est journalise');
    assert.ok(!refusedLog.some((e) => e.action === 'commande_demandee' && e.deviceId === ACT), 'aucune demande journalisee');

    // L'ordre reel.
    const watch = watchCommands(c.fake);
    const t0 = performance.now();
    const sent = await post({});
    assert.equal(sent.status, 201, sent.text);
    const cmd = sent.body.command;
    assert.equal(cmd.actuatorId, ACT);
    assert.equal(cmd.action, 'unlock');
    assert.equal(cmd.durationS, 2);
    assert.equal(cmd.reason, 'Visiteur attendu');
    assert.equal(cmd.requestedBy, 'admin');
    const acked = await until('commande acked', async () => {
      const v = (await commandsOf(ACT)).find((x) => x.cmdId === cmd.cmdId);
      return v?.state === 'acked' ? v : null;
    });
    assert.equal(acked.ackKind, 'signed', 'accuse SIGNE, verifie par le PSIM');
    assert.match(acked.ack, /^done/);
    // Le faux controleur a REELLEMENT recu `openDoor` sur le canal de la porte 1, en mode distant.
    await until('openDoor recu par le controleur', () => watch.seen.some((s) => s.action === 'openDoor'));
    const opens = watch.seen.filter((s) => s.action === 'openDoor');
    assert.equal(opens.length, 1);
    assert.equal(opens[0]!.channel, 1);
    assert.equal(opens[0]!.type, 'Remote');
    assert.ok(opens[0]!.at >= t0, 'apres la demande');
    assert.equal(c.fake.doorStates[0], 'Open');
    // Le controleur produit le passage « ouverture a distance » (le faux ne le fait pas seul : l'essai joue le controleur ici).
    c.fake.emitAccess({ recNo: 7001, method: 4, cardNo: '', cardName: '', userId: '1', door: 0 });
    const remote = await until('passage « Ouverture a distance »', async () => (await eventsOf(`&door=${DOOR}`)).items.find((i: any) => i.eventId === '7001'));
    assert.equal(remote.method, 'remote');
    assert.equal(remote.methodLabel, 'Ouverture à distance');
    assert.equal(remote.result, 'granted');
    assert.equal(remote.doorId, DOOR);

    // Retour a l'etat sur apres durationS : le socle rappelle `lock` LOCALEMENT (closeDoor) puis le PSIM envoie le sien.
    await until('retour local : closeDoor', () => watch.seen.some((s) => s.action === 'closeDoor'), 8000);
    const closes = watch.seen.filter((s) => s.action === 'closeDoor');
    const elapsed = closes[0]!.at - opens[0]!.at;
    assert.ok(elapsed >= 1800 && elapsed <= 5000, `closeDoor ${Math.round(elapsed)} ms apres openDoor (attendu ~2000 ms)`);
    assert.equal(closes[0]!.channel, 1);
    const child = await until('retour automatique du PSIM acquitte', async () => {
      const x = (await commandsOf(ACT)).find((v) => v.parentId === cmd.cmdId && v.auto);
      return x?.state === 'acked' ? x : null;
    }, 12_000);
    assert.equal(child.action, 'lock');
    assert.equal(child.ackKind, 'signed');
    assert.equal(c.fake.doorStates[0], 'Close', 'la porte est refermee');
    watch.stop();
    // Jamais « toujours fermee » : restoreNormal ne ecrit rien quand le controleur est deja en mode normal.
    assert.deepEqual(c.fake.configWrites, [], 'le mode de la porte n\'a pas ete touche');

    // Journal scelle : demande (qui, raison), envoi, accuse ; la chaine reste integre.
    const log = await auditLog();
    const asked = log.find((e) => e.action === 'commande_demandee' && e.deviceId === ACT && /unlock/.test(e.details));
    assert.ok(asked, 'commande_demandee');
    assert.equal(asked.actor, 'admin');
    assert.match(asked.details, /raison : Visiteur attendu/);
    assert.ok(log.some((e) => e.action === 'commande_accusee' && e.deviceId === ACT && /accuse signe/.test(e.details)), 'commande_accusee');
    assert.equal((await api('POST', '/api/system/journal/verify', admin)).body.ok, true);
    assert.ok(!c.log().includes(c.keys[ACT]!), 'la cle n\'apparait pas dans le journal de la passerelle');
    assert.ok(!psim!.output().includes(c.keys[ACT]!), 'ni dans celui du PSIM');
  });

  // ------------------------------------------------------------------------------------------------------------------------
  // 2b. « Tout ouvrir » reel (evacuation) jusqu'au faux controleur, par la passerelle reelle
  // ------------------------------------------------------------------------------------------------------------------------

  it("2b. « Tout ouvrir » reel : repli sur unlock pour un actionneur ancien (la porte s'ouvre) ; l'action evacuate n'est pas encore traduite par la passerelle : commande « refused », aucune ouverture, aucun faux « ouvert »", { timeout: 60_000 }, async () => {
    // Etat d'integration : la traduction de `evacuate` dans gateway/src/modules/acces-commun/actuator.ts n'est pas encore faite.
    // Cet essai constate et documente le comportement actuel ; il changera avec le lot d'integration (la porte s'ouvrira alors).
    const D_OLD = 'ACC-S2B-OLD';
    const D_DECL = 'ACC-S2B-DECL';
    const D_NONE = 'ACC-S2B-NONE';
    const A_OLD = 'LK-S2B-OLD';
    const A_DECL = 'LK-S2B-DECL';
    const A_NONE = 'LK-S2B-NONE';
    const c = await buildChain({
      tag: 's2b',
      doors: [
        { id: D_OLD, no: 1, name: 'Porte ancienne' },
        { id: D_DECL, no: 2, name: 'Porte evacuate declaree' },
        { id: D_NONE, no: 3, name: 'Porte evacuate non declaree' },
      ],
      actuators: [
        // Actionneur d'une base ancienne : actions explicites sans `evacuate`.
        { id: A_OLD, doorNo: 1, maxS: 30, link: D_OLD },
        // Actionneurs neufs : actions par defaut du PSIM (avec `evacuate`) ; la passerelle declare ou non l'action dans sa liste locale.
        { id: A_DECL, doorNo: 2, maxS: 10, link: D_DECL, psimDefaultActions: true, gatewayEvacuate: true },
        { id: A_NONE, doorNo: 3, maxS: 10, link: D_NONE, psimDefaultActions: true },
      ],
    });

    // Apercu : le repli est annonce pour l'ancien, rien pour les neufs.
    const preview = await api('GET', '/api/access/evacuation', admin);
    assert.equal(preview.status, 200, preview.text);
    const pv = Object.fromEntries((preview.body.doors as any[]).map((d) => [d.doorId, d]));
    assert.equal(pv[D_OLD].action, 'unlock');
    assert.equal(pv[D_OLD].maxDurationS, 30);
    assert.equal(pv[D_OLD].warning, "ne s'ouvrira que 30 s : ajoutez l'action évacuation");
    for (const id of [D_DECL, D_NONE]) {
      assert.equal(pv[id].action, 'evacuate', id);
      assert.equal(pv[id].maxDurationS, 900, id);
      assert.equal(pv[id].warning, null, id);
      assert.equal(pv[id].ready, true, id);
    }

    const watch = watchCommands(c.fake);
    const res = await api('POST', '/api/access/evacuation', admin, { reason: 'Exercice evacuation', password: ADMIN_PW, confirm: true, confirmPhrase: 'TOUT OUVRIR', durationS: 20 });
    assert.equal(res.status, 200, res.text);
    const by = Object.fromEntries((res.body.results as any[]).map((r) => [r.doorId, r]));
    // Le PSIM de l'essai est partage : les portes liees par les scenarios precedents (passerelle arretee) sont rapportees sans passerelle.
    const sentDoors = (res.body.results as any[]).filter((r) => r.status === 'sent').map((r) => r.doorId).sort();
    assert.deepEqual(sentDoors, [D_DECL, D_NONE, D_OLD].sort(), "le PSIM a envoye les trois ordres : le refus ne vient qu'apres, avec l'accuse");
    for (const r of res.body.results as any[]) if (!sentDoors.includes(r.doorId)) assert.equal(r.status, 'no_gateway', `${r.doorId} : aucune passerelle a l'ecoute`);
    assert.deepEqual([by[D_OLD].action, by[D_OLD].durationS], ['unlock', 20]);
    assert.equal(by[D_OLD].warning, "ne s'ouvrira que 30 s : ajoutez l'action évacuation");
    for (const id of [D_DECL, D_NONE]) {
      assert.deepEqual([by[id].status, by[id].action, by[id].durationS, by[id].warning], ['sent', 'evacuate', 20, null], id);
    }

    // 1. Repli : unlock accuse, openDoor REELLEMENT recu par le faux controleur sur le canal 1.
    const acked = await until('ouverture de repli accusee', async () => {
      const v = (await commandsOf(A_OLD)).find((x) => x.cmdId === by[D_OLD].cmdId);
      return v?.state === 'acked' ? v : null;
    });
    assert.equal(acked.action, 'unlock');
    assert.equal(acked.ackKind, 'signed');
    await until('openDoor recu sur la porte 1', () => watch.seen.some((s) => s.action === 'openDoor'));

    // 2. evacuate : le pilote ou le module refuse. Le PSIM l'affiche « refused » (accuse signe), l'ordre n'a rien ouvert.
    const refusal = async (actuatorId: string, doorId: string) =>
      until(`commande evacuate de ${actuatorId} refusee`, async () => {
        const v = (await commandsOf(actuatorId)).find((x) => x.cmdId === by[doorId].cmdId);
        return v && v.state !== 'sent' && v.state !== 'pending' ? v : null;
      });
    const declared = await refusal(A_DECL, D_DECL);
    const undeclared = await refusal(A_NONE, D_NONE);
    assert.equal(declared.action, 'evacuate');
    assert.equal(declared.state, 'refused', JSON.stringify(declared));
    assert.equal(declared.ackKind, 'signed', 'refus SIGNE par la passerelle, verifie par le PSIM');
    assert.match(declared.ack, /not_supported/, 'declaree dans la passerelle : le module du controleur ne sait pas la traduire (comportement actuel)');
    assert.equal(undeclared.state, 'refused', JSON.stringify(undeclared));
    assert.equal(undeclared.ackKind, 'signed');
    assert.match(undeclared.ack, /not_allowed/, 'absente de la liste locale de la passerelle');

    // Aucune ouverture pour les deux portes refusees : ni cote controleur, ni cote PSIM (jamais de faux « ouvert »).
    await wait(500);
    watch.stop();
    assert.deepEqual(watch.seen.map((s) => `${s.action}:${s.channel}`), ['openDoor:1'], 'le controleur n\'a recu qu\'une ouverture, celle de la porte ancienne');
    assert.equal(c.fake.doorStates[0], 'Open');
    assert.notEqual(c.fake.doorStates[1], 'Open');
    assert.notEqual(c.fake.doorStates[2], 'Open');
    for (const id of [D_DECL, D_NONE]) {
      const sheet = await doorOf(id);
      assert.notEqual(sheet.door.doorState, 'open', `${id} : la fiche ne dit pas « ouverte »`);
    }
    // Le refus est au journal infalsifiable ; la chaine reste integre.
    const log = await auditLog();
    for (const id of [A_DECL, A_NONE]) assert.ok(log.some((e) => e.action === 'commande_refusee' && e.deviceId === id), `${id} : commande_refusee au journal`);
    assert.ok(log.some((e) => e.action === 'access_evacuation'));
    const bilan = log.find((e) => e.action === 'access_evacuation_bilan');
    assert.ok(bilan, 'bilan');
    assert.match(bilan.details, /ouverture breve faute d'action evacuation : ACC-S2B-OLD/);
    assert.equal((await api('POST', '/api/system/journal/verify', admin)).body.ok, true);
  });

  // ------------------------------------------------------------------------------------------------------------------------
  // 3. Issue de secours
  // ------------------------------------------------------------------------------------------------------------------------

  it('3. issue de secours : « lock » refuse sans rien envoyer au controleur, « unlock » possible ; liaison porte/actionneur : issue de secours des DEUX cotes ou d\'aucun (400)', { timeout: 60_000 }, async () => {
    const SECOURS = 'ACC-S3-SEC';
    const NORMALE = 'ACC-S3-NOR';
    const A_SEC = 'LK-S3-SEC';
    const A_NOR = 'LK-S3-NOR';
    const c = await buildChain({
      tag: 's3',
      doors: [
        { id: SECOURS, no: 1, name: 'Issue de secours', emergencyExit: true },
        { id: NORMALE, no: 2, name: 'Porte ordinaire' },
      ],
      actuators: [
        { id: A_SEC, doorNo: 1, maxS: 30, emergencyExit: true },
        { id: A_NOR, doorNo: 2, maxS: 30 },
      ],
    });

    // F18 : l'issue de secours est des deux cotes ou d'aucun.
    const link = (door: string, actuatorId: string | null) => api('PUT', `/api/access/doors/${door}`, admin, { actuatorId });
    const cross1 = await link(NORMALE, A_SEC);
    assert.equal(cross1.status, 400, 'porte ordinaire <- actionneur d\'issue de secours');
    assert.match(cross1.body.error, /issue de secours/i);
    const cross2 = await link(SECOURS, A_NOR);
    assert.equal(cross2.status, 400, 'issue de secours <- actionneur ordinaire');
    assert.match(cross2.body.error, /issue de secours/i);
    assert.equal((await doorOf(NORMALE)).door.actuatorId, null, 'un refus ne lie rien');
    assert.equal((await doorOf(SECOURS)).door.actuatorId, null);
    // Les liaisons coherentes passent.
    assert.equal((await link(SECOURS, A_SEC)).status, 200);
    assert.equal((await link(NORMALE, A_NOR)).status, 200);
    assert.equal((await doorOf(SECOURS)).remote.available, true);
    assert.equal((await doorOf(NORMALE)).remote.available, true);
    // L'etat resultant est revalide : changer seulement `emergencyExit` d'une porte deja liee est refuse.
    assert.equal((await api('PUT', `/api/access/doors/${SECOURS}`, admin, { emergencyExit: false })).status, 400);
    assert.equal((await api('PUT', `/api/access/doors/${NORMALE}`, admin, { emergencyExit: true })).status, 400);
    assert.equal((await doorOf(SECOURS)).door.emergencyExit, true);
    assert.equal((await doorOf(NORMALE)).door.emergencyExit, false);
    // Un actionneur ne sert qu'une porte.
    assert.equal((await link(NORMALE, A_SEC)).status, 400);

    // « lock » sur l'issue de secours : refuse, le controleur ne recoit RIEN.
    const lockBody = { action: 'lock', reason: 'Fermeture de nuit', confirm: true, password: ADMIN_PW };
    const watch = watchCommands(c.fake);
    const lock = await api('POST', `/api/actuators/${A_SEC}/commands`, admin, lockBody);
    // Par l'API normale l'action « lock » n'existe meme pas pour cet actionneur (400) ; le contrat annonce 403.
    assert.ok(lock.status === 400 || lock.status === 403, `lock sur une issue de secours : ${lock.status} ${lock.text}`);
    await wait(400);
    assert.deepEqual(c.fake.commands, []);
    assert.deepEqual(await commandsOf(A_SEC), []);

    // Defense en profondeur : une base modifiee a la main (action lock ajoutee) est quand meme refusee, 403, rien ne part.
    const dbFile = join(root, 'data', 'psim.db');
    const handle = new DatabaseSync(dbFile);
    handle.exec('PRAGMA busy_timeout = 5000');
    const original = (handle.prepare('SELECT actions FROM actuator WHERE id = ?').get(A_SEC) as { actions: string }).actions;
    try {
      const tampered = { ...(JSON.parse(original) as Record<string, unknown>), lock: { roles: ['operator', 'admin'] } };
      handle.prepare('UPDATE actuator SET actions = ? WHERE id = ?').run(JSON.stringify(tampered), A_SEC);
      const hand = await api('POST', `/api/actuators/${A_SEC}/commands`, admin, lockBody);
      assert.equal(hand.status, 403, hand.text);
      assert.match(hand.body.error, /Issue de secours/);
      const handOperator = await api('POST', `/api/actuators/${A_SEC}/commands`, operator, { ...lockBody, password: OPERATOR_PW });
      assert.equal(handOperator.status, 403, handOperator.text);
    } finally {
      handle.prepare('UPDATE actuator SET actions = ? WHERE id = ?').run(original, A_SEC);
      handle.close();
    }
    await wait(300);
    assert.deepEqual(c.fake.commands, [], 'toujours rien recu par le controleur');
    assert.deepEqual(await commandsOf(A_SEC), [], 'aucune commande creee');

    // « unlock » reste possible, sans aucun retour automatique (ni du PSIM ni du socle).
    const sent = await api('POST', `/api/actuators/${A_SEC}/commands`, admin, { action: 'unlock', params: { durationS: 1 }, reason: 'Evacuation', confirm: true, password: ADMIN_PW });
    assert.equal(sent.status, 201, sent.text);
    const acked = await until('unlock accuse', async () => {
      const v = (await commandsOf(A_SEC)).find((x) => x.cmdId === sent.body.command.cmdId);
      return v?.state === 'acked' ? v : null;
    });
    assert.equal(acked.ackKind, 'signed');
    await until('openDoor recu', () => watch.seen.some((s) => s.action === 'openDoor'));
    await wait(2600); // bien au-dela de durationS (1 s) + marge du PSIM
    watch.stop();
    assert.deepEqual(watch.seen.map((s) => `${s.action}:${s.channel}`), ['openDoor:1'], 'ni closeDoor ni changement de mode');
    assert.deepEqual(c.fake.configWrites, []);
    assert.ok(!(await commandsOf(A_SEC)).some((x) => x.auto), 'le PSIM ne reverrouille jamais une issue de secours');
    assert.equal(c.fake.doorStates[0], 'Open', 'la porte reste telle que le controleur la gere');
  });

  // ------------------------------------------------------------------------------------------------------------------------
  // 4. Coupure du controleur
  // ------------------------------------------------------------------------------------------------------------------------

  it('4. controleur injoignable : porte « hors ligne » (jamais « fermee »), passages recuperes « en differe » au retour, sans doublon', { timeout: 60_000 }, async () => {
    const DOOR = 'ACC-S4-ENT';
    const c = await buildChain({ tag: 's4', doors: [{ id: DOOR, no: 1, name: 'Entree' }] });
    const ids = async () => ((await eventsOf(`&door=${DOOR}`)).items as any[]).map((i) => i.eventId).sort();

    // Un passage en direct, puis la porte est refermee (etat connu : « fermee »).
    c.fake.emitDoor('DoorStatus', { index: 0, data: { Status: 'Close', UTC: Date.now() } });
    c.fake.emitAccess({ recNo: 5001, door: 0, cardNo: '0011111', cardName: 'KONAN Yao' });
    await until('passage direct', async () => (await ids()).includes('5001'));
    await until('porte « fermee »', async () => ((await doorOf(DOOR)).door.state === 'closed' ? true : null));

    // Le controleur disparait.
    await c.fake.pause();
    const sampled: string[] = [];
    await until(
      'porte « hors ligne »',
      async () => {
        const d = (await doorOf(DOOR)).door;
        sampled.push(d.state);
        return d.state === 'offline' ? d : null;
      },
      30_000,
      100,
    );
    const offline = (await doorOf(DOOR)).door;
    assert.equal(offline.state, 'offline');
    assert.equal(offline.stateLabel, 'Hors ligne');
    assert.equal(offline.deviceStatus, 'offline');
    // Tant que le controleur se tait, la porte n'est jamais dite « fermee » une fois la coupure constatee.
    await wait(600);
    assert.equal((await doorOf(DOOR)).door.state, 'offline');
    assert.ok(sampled.every((s) => s === 'closed' || s === 'unknown' || s === 'offline'), sampled.join(','));
    assert.deepEqual(sampled.slice(sampled.indexOf('offline')).filter((s) => s === 'closed'), [], 'jamais « fermee » apres le passage hors ligne');

    // Pendant la coupure : des passages se produisent (memoire du controleur seulement).
    const during = [5002, 5003, 5004].map((n) => c.fake.emitAccess({ recNo: n, send: false, door: 0, cardNo: `77${n}`, cardName: `PASSAGE ${n}`, utc: Math.floor(Date.now() / 1000) - 3 }));
    c.fake.emitAccess({ recNo: 5005, send: false, door: 0, status: 0, errorCode: 0x14, cardNo: '0088888' });
    await wait(300);
    assert.deepEqual(await ids(), ['5001'], 'rien n\'est arrive pendant la coupure');

    // Retour du controleur.
    await c.fake.resume();
    await until('les passages de la coupure sont recuperes', async () => (await ids()).length === 5, 30_000);
    await until('la porte n\'est plus hors ligne', async () => ((await doorOf(DOOR)).door.state !== 'offline' ? true : null), 30_000);
    const all = (await eventsOf(`&door=${DOOR}`)).items as any[];
    assert.deepEqual(all.map((i) => i.eventId).sort(), ['5001', '5002', '5003', '5004', '5005'], 'chaque passage UNE fois');
    assert.equal(new Set(all.map((i) => i.id)).size, 5, 'ids d\'evenement distincts');
    assert.equal(all.find((i) => i.eventId === '5001').late, false, 'le passage direct reste « en direct »');
    for (const n of [5002, 5003, 5004, 5005]) assert.equal(all.find((i) => i.eventId === String(n)).late, true, `${n} recu en differe`);
    for (const rec of during) assert.equal(all.find((i) => i.eventId === String(rec.RecNo)).atDevice, rec.CreateTime * 1000, 'heure du CONTROLEUR conservee');
    assert.equal(all.find((i) => i.eventId === '5005').reason, 'expired');
    assert.equal((await eventsOf(`&late=1&door=${DOOR}`)).total, 4);
    assert.equal((await doorOf(DOOR)).door.deviceStatus, 'normal');
    assert.deepEqual(await incidentsOf(DOOR), [], 'des passages recuperes ne sont pas des incidents');

    // Une deuxieme coupure BRUTALE des connexions relit la memoire du controleur : toujours aucun doublon.
    const finds = c.fake.recordFinds;
    c.fake.dropAll();
    await until('memoire relue apres la reconnexion', () => c.fake.recordFinds > finds, 15_000);
    await wait(800);
    assert.equal((await eventsOf(`&door=${DOOR}`)).total, 5, 'aucun doublon apres une nouvelle recuperation');
    assert.ok(!/message rejete/.test(c.log()), c.log());
  });

  // ------------------------------------------------------------------------------------------------------------------------
  // 5. Mode de porte (F19)
  // ------------------------------------------------------------------------------------------------------------------------
  // Dependances de fusion, detectees plutot que supposees :
  //  (a) le module `acces-dahua` de CE worktree doit remonter le mode de porte (branche acces-passerelle, non fusionnee) ;
  //  (b) le moteur doit reconnaitre l'evenement `door_mode` (server/sources.ts, meme branche) ;
  //  (c) le serveur AC4 (DoorView.doorMode / doorModeAt) est le travail de la tache T1.
  // Chaque test ci-dessous se desactive en disant laquelle manque ; aucun n'echoue pour une dependance de fusion.

  const read = (rel: string): string => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');
  const moduleReportsDoorMode = ['index.ts', 'controller.ts', 'driver.ts', 'protocol.ts', 'recovery.ts'].some((f) => /door_mode|doorMode/.test(read(`gateway/src/modules/acces-dahua/${f}`)));
  const engineKnowsDoorMode = /\bdoor_mode\b/.test(read('server/sources.ts'));

  it(
    '5a. mode de porte remonte par le module acces-dahua : doorMode / doorModeAt dans /api/access/doors/:id',
    {
      timeout: 40_000,
      skip: !moduleReportsDoorMode
        ? "le module acces-dahua de ce worktree ne remonte pas le mode de porte (branche acces-passerelle non fusionnee) ; le faux controleur sait pourtant le porter (FakeDahua.modes)"
        : !engineKnowsDoorMode
          ? "server/sources.ts ne reconnait pas encore l'evenement door_mode (branche acces-passerelle non fusionnee)"
          : false,
    },
    async () => {
      const c = await buildChain({ tag: 's5', doors: [{ id: 'ACC-S5-A', no: 1, name: 'Porte A' }, { id: 'ACC-S5-B', no: 2, name: 'Porte B' }] });
      // Le module lit le mode de chaque porte a la connexion : modes reglés avant, relus apres une reconnexion.
      c.fake.modes[0] = 'OpenAlways';
      c.fake.modes[1] = 'CloseAlways';
      c.fake.dropAll();
      const a = await until('porte A : toujours ouverte', async () => {
        const d = (await doorOf('ACC-S5-A')).door;
        return d.doorMode === 'always_open' ? d : null;
      }, 20_000);
      assert.equal(a.doorModeLabel, 'Ouverte en permanence (réglée dans le contrôleur)');
      assert.equal(typeof a.doorModeAt, 'number');
      const b = await until('porte B : toujours fermee', async () => {
        const d = (await doorOf('ACC-S5-B')).door;
        return d.doorMode === 'always_closed' ? d : null;
      });
      assert.equal(b.doorModeLabel, 'Verrouillée en permanence (réglée dans le contrôleur)');
      c.fake.modes[0] = 'Normal';
      c.fake.dropAll();
      const normal = await until('porte A : mode normal', async () => {
        const d = (await doorOf('ACC-S5-A')).door;
        return d.doorMode === 'normal' ? d : null;
      }, 20_000);
      assert.equal(normal.doorModeLabel, 'Mode normal : les badges fonctionnent');
      assert.ok(normal.doorModeAt >= a.doorModeAt);
    },
  );

  it("5b. contrat du PSIM pour le champ `doorMode` d'un message de porte (injecte au broker avec le compte de la passerelle) : dernier mode connu, date, ordre des messages, valeur invalide ignoree", { timeout: 40_000 }, async (t) => {
    const DOOR = 'ACC-S5-C';
    const ctl = 'CTL-S5C';
    assert.equal((await api('POST', '/api/devices', admin, { id: DOOR, kind: 'detector', name: 'Porte mode', zone: 'Essai', category: 'access' })).status, 201);
    assert.equal((await api('POST', '/api/access/controllers', admin, { id: ctl, name: 'Controleur mode', brand: 'dahua' })).status, 201);
    assert.equal((await api('POST', '/api/access/doors', admin, { detectorId: DOOR, controllerId: ctl, doorNo: 1, kind: 'door' })).status, 201);
    const first = (await doorOf(DOOR)).door;
    if (!('doorMode' in first)) return t.skip("DoorView sans doorMode : serveur AC4 (tache T1, contrat point 2) pas encore en place");
    assert.equal(first.doorMode, null, 'aucun message door_mode : null');
    assert.equal(first.doorModeAt, null);
    assert.equal(first.doorModeLabel, null);

    const client = mqtt.connect(`mqtt://127.0.0.1:${psim!.mqttPort}`, { username: GW.user, password: GW.password, reconnectPeriod: 0, connectTimeout: 5000, clean: true });
    rawClients.push(client);
    client.on('error', () => undefined);
    await new Promise<void>((res, rej) => {
      client.once('connect', () => res());
      client.once('error', rej);
    });
    // Contrat point 5 : le mode est lu dans `doorMode` quel que soit `event`. Tant que server/sources.ts ne connait pas l'evenement
    // `door_mode` (branche acces-passerelle), le message porte le champ avec un simple signe de vie (`state: normal`) : le moteur
    // l'accepte, et seul le crochet du journal des acces lit `doorMode`.
    const carrier: Record<string, unknown> = engineKnowsDoorMode ? { event: 'door_mode' } : { state: 'normal' };
    const publish = (msg: Record<string, unknown>) => client.publishAsync(`psim/detectors/${DOOR}/state`, JSON.stringify({ ...carrier, ...msg }), { qos: 1 });
    const T = Date.now();
    await publish({ doorMode: 'always_open', ts: T - 5000, msgId: 'mode-1-a' });
    const settled = await until('message traite : doorMode renseigne', async () => {
      const d = (await doorOf(DOOR)).door;
      return d.doorMode !== null ? d : null;
    }, 5000);
    assert.equal(settled.doorMode, 'always_open');
    assert.equal(settled.doorModeLabel, 'Ouverte en permanence (réglée dans le contrôleur)');
    assert.equal(settled.doorModeAt, T - 5000, 'date = heure du message');

    // Un message plus ANCIEN n'ecrase pas un plus recent.
    await publish({ doorMode: 'always_closed', ts: T - 60_000, msgId: 'mode-0-old' });
    await wait(400);
    assert.equal((await doorOf(DOOR)).door.doorMode, 'always_open');
    // Un plus recent le remplace.
    await publish({ doorMode: 'normal', ts: T - 1000, msgId: 'mode-2-new' });
    const normal = await until('mode normal', async () => ((await doorOf(DOOR)).door.doorMode === 'normal' ? (await doorOf(DOOR)).door : null));
    assert.equal(normal.doorModeLabel, 'Mode normal : les badges fonctionnent');
    assert.equal(normal.doorModeAt, T - 1000);
    // Valeur invalide : ignoree.
    await publish({ doorMode: 'tout-ouvert', ts: T, msgId: 'mode-3-bad' });
    await wait(400);
    const after = (await doorOf(DOOR)).door;
    assert.equal(after.doorMode, 'normal');
    assert.equal(after.doorModeAt, T - 1000);
  });

  // ------------------------------------------------------------------------------------------------------------------------
  // 6. Mesures chiffrees (PRD, section 12)
  // ------------------------------------------------------------------------------------------------------------------------

  it('6a. mesure : porte forcee sur le controleur -> incident visible dans le PSIM (objectif : mediane < 3 s), 20 essais', { timeout: 90_000 }, async () => {
    const DOORS = ['ACC-S6-D1', 'ACC-S6-D2', 'ACC-S6-D3', 'ACC-S6-D4'];
    const c = await buildChain({ tag: 's6', doors: DOORS.map((id, i) => ({ id, no: i + 1, name: `Porte mesure ${i + 1}` })) });
    const live = await openLive(admin);
    lives.push(live);
    const samples: number[] = [];
    const TRIALS = 20;
    for (let i = 0; i < TRIALS; i++) {
      const index = i % 4;
      const id = DOORS[index]!;
      const known = new Set(live.incidents.keys());
      const t0 = performance.now();
      c.fake.emitDoor('BreakIn', { action: 'Start', index, data: { UTC: Date.now() } });
      const found = await until(`essai ${i + 1} : incident sur ${id}`, () => [...live.incidents].find(([n, v]) => v.detectorId === id && !known.has(n)), 10_000, 2);
      samples.push(found[1].at - t0);
      // Il est bien visible par l'API (ce que lit l'ecran), critique, sur la bonne porte.
      const incident = (await incidentsOf(id)).find((x) => x.id === found[0]);
      assert.ok(incident, `essai ${i + 1} : incident ${found[0]} absent de /api/state`);
      assert.equal(incident.severity, 'critical');
      assert.equal(incident.event, 'door_forced');
      // Remise a zero : porte refermee, retour a la normale, incident clos (sinon l'alarme suivante se rattacherait a celui-ci).
      c.fake.emitDoor('DoorStatus', { index, data: { Status: 'Close', UTC: Date.now() } });
      await until(`essai ${i + 1} : retour a la normale`, async () => ((await doorOf(id)).door.deviceStatus === 'normal' ? true : null), 10_000, 5);
      const closed = await api('POST', `/api/incidents/${found[0]}/close`, admin, { qualification: 'false_alarm', comment: 'mesure' });
      assert.equal(closed.status, 200, closed.text);
    }
    const s = stats(samples);
    console.log(JSON.stringify({ mesure: 'porte_forcee_vers_incident_visible', objectif: 'mediane < 3000 ms', unite: 'ms', ...s }));
    assert.equal(s.n, TRIALS);
    assert.ok(s.mediane < 3000, `mediane ${s.mediane} ms (objectif PRD 12 : < 3000 ms) ${JSON.stringify(s)}`);
  });

  it("6b. mesure : POST de la commande -> commande « acked » (objectif : 95e centile < 2 s), 20 ouvertures sur 4 portes et 2 comptes (limite de 4 commandes par minute respectee)", { timeout: 90_000 }, async () => {
    const DOORS = ['ACC-S7-D1', 'ACC-S7-D2', 'ACC-S7-D3', 'ACC-S7-D4'];
    const ACTS = ['LK-S7-D1', 'LK-S7-D2', 'LK-S7-D3', 'LK-S7-D4'];
    const c = await buildChain({
      tag: 's7',
      doors: DOORS.map((id, i) => ({ id, no: i + 1, name: `Porte ouverture ${i + 1}` })),
      actuators: ACTS.map((id, i) => ({ id, doorNo: i + 1, maxS: 30, link: DOORS[i]! })),
    });
    const live = await openLive(admin);
    lives.push(live);
    const watch = watchCommands(c.fake);
    const samples: number[] = [];
    const TRIALS = 20;
    for (let i = 0; i < TRIALS; i++) {
      const k = i % 4;
      const round = Math.floor(i / 4);
      // 5 tours : l'administrateur (3 fois) puis l'operateur (2 fois) -> au plus 3 ordres par compte et par actionneur (limite : 4).
      const as = round < 3 ? { cookie: admin, pw: ADMIN_PW, who: 'admin' } : { cookie: operator, pw: OPERATOR_PW, who: 'operateur' };
      const t0 = performance.now();
      const r = await api('POST', `/api/actuators/${ACTS[k]}/commands`, as.cookie, { action: 'unlock', params: { durationS: 2 }, reason: `Mesure ${i + 1}`, confirm: true, password: as.pw });
      assert.equal(r.status, 201, `essai ${i + 1} : ${r.text}`);
      assert.equal(r.body.command.requestedBy, as.who);
      const cmdId: string = r.body.command.cmdId;
      const at = await until(`essai ${i + 1} : commande acked`, () => live.acked.get(cmdId), 10_000, 2);
      samples.push(at - t0);
      const view = (await commandsOf(ACTS[k]!)).find((x) => x.cmdId === cmdId);
      assert.equal(view.state, 'acked');
      assert.equal(view.ackKind, 'signed');
      await wait(40);
    }
    watch.stop();
    const s = stats(samples);
    console.log(JSON.stringify({ mesure: 'post_commande_vers_acked', objectif: 'p95 < 2000 ms', unite: 'ms', ...s }));
    assert.equal(s.n, TRIALS);
    // Les 20 ordres sont REELLEMENT arrives au controleur : 5 par porte, en mode distant.
    const opens = watch.seen.filter((x) => x.action === 'openDoor');
    assert.equal(opens.length, TRIALS, `openDoor recus : ${opens.length}`);
    for (let ch = 1; ch <= 4; ch++) assert.equal(opens.filter((x) => x.channel === ch).length, 5, `canal ${ch}`);
    assert.ok(opens.every((x) => x.type === 'Remote'));
    assert.ok(s.p95 < 2000, `95e centile ${s.p95} ms (objectif PRD 12 : < 2000 ms) ${JSON.stringify(s)}`);
  });
});
