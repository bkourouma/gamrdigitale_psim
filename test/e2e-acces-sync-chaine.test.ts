/**
 * CHAINE REELLE de la synchronisation des titulaires (docs/CONTROLE-ACCES.md § 7, docs/ACCES.md § 12), sans aucun faux maillon
 * cote PSIM ni cote passerelle :
 *
 *   API admin du VRAI PSIM (processus `server/index.ts`, base SQLite temporaire, ports libres au hasard)
 *     -> moteur de synchronisation reel (server/accesssync.ts) -> VRAI courtier MQTT du PSIM (server/mqtt.ts, ses droits)
 *     -> VRAI socle de passerelle (`startRuntime`, compte MQTT declare dans PSIM_MQTT_GATEWAYS, `access_controller.gateway_id` = compte)
 *     -> VRAI module `acces-dahua` (ou `acces-zkteco`) -> FAUX controleur (gateway/test/fake-dahua.ts, fake-zkteco.ts).
 *
 * Seul le controleur est un faux. La cle de synchronisation est emise par l'API (POST .../sync/controllers/:id/key, mot de passe
 * redemande) puis recopiee dans la configuration du module (`syncKey`) avant le demarrage de la passerelle. Rien n'est publie sur
 * le courtier autrement que par le PSIM et la passerelle (les essais de droits MQTT du scenario 6 sont l'exception : ils sont l'objet
 * de l'essai).
 *
 * Scenarios (chacun monte SON site : controleur, portes, passerelle, faux controleur ; un seul PSIM partage, sauf 5, 5b, 8 et 10) :
 *   1. creation : plage, groupe, titulaire a deux badges -> cartes et plages dans le controleur, titulaire « synchronise »
 *   2. parcours P3 : desactiver un badge -> carte retiree (delai mesure) ; passage refuse rattache au titulaire dans le journal
 *   3. suspension / reactivation / suppression d'un titulaire
 *   4. passerelle arretee puis relancee, trois modifications en attente : une seule fois, dans l'ordre ; coupure de la liaison MQTT
 *      (proxy TCP entre la passerelle et le courtier du PSIM : coupe puis retabli)
 *   5. redemarrage du PSIM (processus tue) en cours de synchronisation : reprise, aucune perte, `seq` jamais en arriere ;
 *      5b (todo) : PSIM restaure depuis une ancienne sauvegarde, `seq` en retard sur la passerelle
 *   6. droits MQTT constates avec le vrai client de la passerelle (SUBACK, publication de l'accuse, refus de l'ordre)
 *   7. plage « fermee les jours feries » (refus not_supported + phrase exacte), plage « Tout le temps », jours feries
 *   8. cle : mauvaise cle (rien d'applique, en attente puis echec), bonne cle retablie, cle renouvelee (horloge du PSIM acceleree)
 *   9. controleur ZKTeco (cycle d'interrogation `getrequest` de 3 s)
 *  10. erreur du controleur puis retour a la normale : nouvel essai du PSIM avec un NOUVEAU `seq`, code d'erreur libre
 *
 * Horloge : le PSIM tourne dans un processus separe, son horloge ne s'injecte pas. Les attentes sont toutes SUR CONDITION ; les seuls
 * PSIM a horloge acceleree sont ceux des scenarios 8 et 10 (lances avec `--import` d'un module en ligne qui remplace `Date.now`) :
 * l'etat « echec » (plus de 5 essais espaces de 10 s, 20 s, 40 s... en temps reel) et le nouvel essai arrivent alors en quelques
 * secondes. Aucun `sleep` fixe superieur a 1 s pour ce qui DOIT arriver ; les attentes « rien ne doit arriver » sont d'environ une seconde.
 *
 * Mesures (une ligne « [mesure] » chacune, a la fin) : premier envoi, desactiver -> applique, reprise apres coupure, redemarrage du
 * PSIM, ZKTeco.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { after, afterEach, before, describe, it } from 'node:test';
import mqtt from 'mqtt';
import { loadConfig } from '../gateway/src/config.ts';
import type { Level, Logger } from '../gateway/src/log.ts';
import { startRuntime } from '../gateway/src/runtime.ts';
import type { GatewayRuntime } from '../gateway/src/runtime.ts';
import { FakeDahua } from '../gateway/test/fake-dahua.ts';
import { FakeZk } from '../gateway/test/fake-zkteco.ts';

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';
const MQTT_PW = 'Mot-de-passe-mqtt-solide-3';

/** Un compte de passerelle par site d'essai : tous declares des le demarrage du PSIM (la variable d'environnement est fixe). */
const TAGS = ['s1', 's2', 's3', 's4', 's4b', 's5', 's6', 's6b', 's7', 's8', 's9'] as const;
type Tag = (typeof TAGS)[number];
const gwUser = (tag: Tag): string => `gw-${tag}`;
const gwPassword = (tag: Tag): string => `Mot-de-passe-passerelle-${tag}-essai`;
const doorId = (tag: Tag, n: number): string => `ACC-${tag.toUpperCase()}-${n}`;
const GATEWAYS = JSON.stringify(TAGS.map((t) => ({ user: gwUser(t), password: gwPassword(t), detectors: [`ACC-${t.toUpperCase()}-*`] })));

/** Cycle d'interrogation du faux ZKTeco (le vrai appareil interroge toutes les 3 s par defaut). */
const ZK_POLL_MS = 3000;
/** Marge confortable de chaque attente sur condition (jamais atteinte quand tout va bien). */
const LONG = 20_000;

const EXPECTED_HOLIDAY_MESSAGE = "Ce contrôleur ne sait pas encore appliquer « fermé les jours fériés » : retirez l'option de cette plage ou attendez la qualification.";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });
const ms = (since: number): number => Math.round(performance.now() - since);

// ---------------------------------------------------------------------------------------------------------------- mesures

const measures: string[] = [];
const measure = (what: string, value: string): void => {
  measures.push(`${what} : ${value}`);
};

interface Stats {
  n: number;
  min: number;
  mediane: number;
  p95: number;
  max: number;
}
function stats(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const rank = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
  const mid = s.length / 2;
  const mediane = s.length % 2 === 1 ? s[Math.floor(mid)]! : (s[mid - 1]! + s[mid]!) / 2;
  return { n: s.length, min: s[0]!, mediane: Math.round(mediane), p95: rank(0.95), max: s[s.length - 1]! };
}
const fmt = (st: Stats): string => `n=${st.n} min=${st.min} ms, mediane=${st.mediane} ms, p95=${st.p95} ms, max=${st.max} ms`;

// ---------------------------------------------------------------------------------------------------------------- nettoyage

const cleanups: Array<() => unknown> = [];
/** Ce qui sert au diagnostic en cas d'echec d'une attente (journaux du PSIM et des passerelles du scenario courant). */
let diag: () => string = () => '';

async function runCleanups(): Promise<void> {
  for (const f of cleanups.splice(0).reverse()) {
    try {
      await f();
    } catch {
      // nettoyage au mieux
    }
  }
}

/** Attend une condition (sonde asynchrone) ; en cas d'echec, joint le diagnostic du scenario. */
async function until<T>(what: string, probe: () => T | Promise<T>, timeoutMs = LONG, every = 20): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) assert.fail(`delai depasse (${timeoutMs} ms) : ${what}\n${diag()}`);
    await wait(every);
  }
}

// ---------------------------------------------------------------------------------------------------------------- PSIM reel

interface Reply {
  status: number;
  body: any;
  text: string;
}
interface Psim {
  proc: ChildProcess;
  base: string;
  web: number;
  mqttPort: number;
  root: string;
  accelerate: number | null;
  cookie: string;
  output: () => string;
  api: (method: string, path: string, body?: unknown) => Promise<Reply>;
}

async function bootPsim(o: { root: string; web?: number; mqttPort?: number; accelerate?: number }): Promise<Psim> {
  const web = o.web ?? (await freePort());
  const mqttPort = o.mqttPort ?? (await freePort());
  const base = `http://127.0.0.1:${web}`;
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    PSIM_DATA_DIR: join(o.root, 'data'),
    PSIM_BACKUP_DIR: join(o.root, 'backups'),
    PSIM_PORT: String(web),
    PSIM_MQTT_PORT: String(mqttPort),
    PSIM_ADMIN_PASSWORD: ADMIN_PW,
    PSIM_OPERATOR_PASSWORD: OPERATOR_PW,
    PSIM_MQTT_PASSWORD: MQTT_PW,
    PSIM_DEMO_LOGIN: '0',
    PSIM_REQUIRE_2FA: 'none',
    PSIM_MQTT_GATEWAYS: GATEWAYS,
  });
  const args = ['server/index.ts'];
  if (o.accelerate !== undefined) {
    // Horloge acceleree du PSIM : `Date.now` avance `accelerate` fois plus vite que le temps reel (les minuteries restent reelles).
    const code = `const r=Date.now.bind(Date);const t=r();Date.now=()=>t+(r()-t)*${o.accelerate};`;
    args.unshift('--import', `data:text/javascript,${encodeURIComponent(code)}`);
  }
  let output = '';
  const proc = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (d) => (output += d));
  proc.stderr!.on('data', (d) => (output += d));
  let ready = false;
  for (let i = 0; i < 160 && !ready; i++) {
    try {
      ready = (await fetch(`${base}/healthz`)).status === 200;
    } catch {
      // pas encore pret
    }
    if (!ready) await wait(250);
  }
  if (!ready) {
    proc.kill();
    throw new Error(`serveur non demarre :\n${output}`);
  }
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PW }) });
  assert.equal(res.status, 200, 'connexion administrateur');
  const cookie = res.headers.getSetCookie()[0]!.split(';')[0]!;
  const psim: Psim = {
    proc,
    base,
    web,
    mqttPort,
    root: o.root,
    accelerate: o.accelerate ?? null,
    cookie,
    output: () => output,
    api: async (method, path, body) => {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { status: r.status, body: parsed, text };
    },
  };
  return psim;
}

async function killPsim(psim: Psim): Promise<void> {
  const proc = psim.proc;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((res) => proc.once('exit', res));
  proc.kill('SIGKILL');
  await exited;
}

/** Dossier temporaire d'un PSIM (supprime a la fin, avec une nouvelle tentative : Windows garde un fichier ouvert un instant). */
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(async () => {
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(root, { recursive: true, force: true });
        return;
      } catch {
        await wait(200);
      }
    }
  });
  return root;
}

const ok = <T = any>(r: Reply, status: number): T => {
  assert.equal(r.status, status, `${r.status} ${r.text.slice(0, 400)}`);
  return r.body as T;
};

// ---------------------------------------------------------------------------------------------------------------- objets du PSIM

interface Site {
  tag: Tag;
  psim: Psim;
  ctl: string;
  doors: string[];
  gw: string;
  dir: string;
  brand: 'dahua' | 'zkteco';
  /** Faux controleur Dahua (brand dahua). */
  fake: FakeDahua | null;
  /** Cle de synchronisation emise par le PSIM, ou null. */
  key: string | null;
}

/** Declare dans le PSIM les detecteurs, le controleur (rattache a SON compte de passerelle) et ses deux portes. */
async function mkSite(psim: Psim, tag: Tag, brand: 'dahua' | 'zkteco' = 'dahua'): Promise<Site> {
  const ctl = `CTL-${tag.toUpperCase()}`;
  const doors = [doorId(tag, 1), doorId(tag, 2)];
  const dir = mkdtempSync(join(psim.root, `${tag}-`));
  for (const [i, id] of doors.entries()) ok(await psim.api('POST', '/api/devices', { id, kind: 'detector', name: `Porte ${tag} ${i + 1}`, zone: 'Essai', category: 'access' }), 201);
  ok(await psim.api('POST', '/api/access/controllers', { id: ctl, name: `Controleur ${tag}`, brand, model: brand === 'dahua' ? 'ASC1204B' : 'C3-400', host: '127.0.0.1', gatewayId: gwUser(tag) }), 201);
  for (const [i, id] of doors.entries()) ok(await psim.api('POST', '/api/access/doors', { detectorId: id, controllerId: ctl, doorNo: i + 1, kind: 'door' }), 201);
  const fake = brand === 'dahua' ? await FakeDahua.start({ heartbeatMs: 100 }) : null;
  if (fake) cleanups.push(() => fake.close());
  return { tag, psim, ctl, doors, gw: gwUser(tag), dir, brand, fake, key: null };
}

const builtinSchedule = async (psim: Psim): Promise<any> => ok<any[]>(await psim.api('GET', '/api/access/schedules'), 200).find((s) => s.builtin);
const mkSchedule = async (psim: Psim, name: string, windows: unknown[] = [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '17:00' }], closedOnHolidays = false): Promise<any> =>
  ok(await psim.api('POST', '/api/access/schedules', { name, windows, closedOnHolidays }), 201);
const mkGroup = async (psim: Psim, name: string, doors: { doorId: string; scheduleId: number }[]): Promise<any> => ok(await psim.api('POST', '/api/access/groups', { name, doors }), 201);
const mkHolder = async (psim: Psim, lastName: string, firstName: string, groupIds: number[], badges: string[]): Promise<any> =>
  ok(await psim.api('POST', '/api/access/holders', { lastName, firstName, groupIds, badges }), 201);

async function issueKey(site: Site, renew = false): Promise<string> {
  const r = ok<{ key: string; createdAt: number; renewed: boolean }>(await site.psim.api('POST', `/api/access/sync/controllers/${site.ctl}/key`, { reauth: ADMIN_PW }), 200);
  assert.match(r.key, /^[0-9a-f]{64}$/);
  assert.equal(r.renewed, renew);
  site.key = r.key;
  return r.key;
}

// ---------------------------------------------------------------------------------------------------------------- etat de synchronisation (API)

const syncStatus = async (psim: Psim, ctl: string): Promise<any> => ok<any[]>(await psim.api('GET', '/api/access/sync'), 200).find((c) => c.controllerId === ctl);
const syncDetail = async (psim: Psim, ctl: string): Promise<any> => ok(await psim.api('GET', `/api/access/sync/controllers/${ctl}`), 200);
const holderSync = async (psim: Psim, id: number): Promise<any[]> => ok(await psim.api('GET', `/api/access/holders/${id}`), 200).sync;

/** Tout est synchronise : etat « ok », rien en attente, en echec ni retenu, au moins un element acquitte. */
async function settled(psim: Psim, ctl: string): Promise<any | null> {
  const s = await syncStatus(psim, ctl);
  return s && s.state === 'ok' && s.counts.pending === 0 && s.counts.failed === 0 && s.counts.blocked === 0 && s.counts.synced > 0 ? s : null;
}
const waitSettled = (psim: Psim, ctl: string, timeoutMs = LONG): Promise<any> => until(`${ctl} entierement synchronise`, () => settled(psim, ctl), timeoutMs);

// ---------------------------------------------------------------------------------------------------------------- passerelle reelle

interface TestLogger extends Logger {
  lines: { level: Level; text: string }[];
  has(re: RegExp): boolean;
  text(): string;
}
function memoryLogger(): TestLogger {
  const lines: { level: Level; text: string }[] = [];
  return { lines, log: (level, text) => void lines.push({ level, text }), has: (re) => lines.some((l) => re.test(l.text)), text: () => lines.map((l) => `${l.level} ${l.text}`).join('\n') };
}

interface Gw {
  rt: GatewayRuntime;
  log: TestLogger;
  stop(): Promise<void>;
}
interface GwOptions {
  /** Cle de synchronisation du module (null : pas de syncKey). Defaut : celle du site. */
  key?: string | null;
  /** Adresse MQTT (defaut : le courtier du PSIM) ; sert aux coupures de liaison. */
  mqttPort?: number;
  /** Controleurs Dahua supplementaires dans le meme module (essai de droits). */
  extraControllers?: Record<string, unknown>[];
  zk?: { httpPort: number; serial: string };
}

const lastLogs: TestLogger[] = [];

/** Demarre la passerelle du site (meme dossier de donnees a chaque appel : un redemarrage reprend le `seq` et les plages). */
async function startGateway(site: Site, o: GwOptions = {}): Promise<Gw> {
  const key = o.key === undefined ? site.key : o.key;
  const common = key === null ? {} : { syncKey: key };
  let module: Record<string, unknown>;
  if (site.brand === 'dahua') {
    const fake = site.fake!;
    module = {
      name: 'acces-dahua',
      config: {
        stateDir: join(site.dir, 'acces-state'),
        controllers: [
          { id: site.ctl, host: fake.host, port: fake.port, username: fake.username, password: fake.password, doors: { '1': site.doors[0], '2': site.doors[1] }, ...common },
          ...(o.extraControllers ?? []),
        ],
        thresholds: { offlineGraceMs: 500, silenceMs: 10_000, modeCheckS: 0 },
        reconnect: { minMs: 100, maxMs: 400 },
      },
    };
  } else {
    module = {
      name: 'acces-zkteco',
      config: {
        stateDir: join(site.dir, 'zk-state'),
        listen: { host: '127.0.0.1', port: o.zk!.httpPort },
        allowFrom: ['127.0.0.1'],
        controllers: [{ id: site.ctl, serial: o.zk!.serial, doors: { '1': site.doors[0], '2': site.doors[1] }, ...common }],
      },
    };
  }
  const file = join(site.dir, 'gateway.json');
  writeFileSync(
    file,
    JSON.stringify({
      name: `passerelle-${site.tag}`,
      psim: { url: `mqtt://127.0.0.1:${o.mqttPort ?? site.psim.mqttPort}`, username: gwUser(site.tag), password: gwPassword(site.tag), detectors: [`ACC-${site.tag.toUpperCase()}-*`] },
      dataDir: join(site.dir, 'gw-data'),
      retry: { minMs: 100, maxMs: 400 },
      moduleRetry: { minMs: 100, maxMs: 400 },
      log: { file: false },
      modules: [module],
    }),
  );
  const log = memoryLogger();
  lastLogs.push(log);
  const rt = await startRuntime({ config: loadConfig(file), logger: log });
  let stopped = false;
  const gw: Gw = {
    rt,
    log,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await rt.stop();
    },
  };
  cleanups.push(() => gw.stop());
  await until('module de la passerelle demarre', () => rt.status().modules[0]?.state === 'running', LONG);
  await until('liaison de la passerelle avec le PSIM', () => rt.status().psim.connected, LONG);
  if (site.brand === 'dahua') await until('controleur joint par le module', () => site.fake!.recordFinds > 0, LONG);
  return gw;
}

/** Dernier numero de sequence applique par la passerelle pour ce controleur (fichier d'etat de son dossier de donnees). */
function gatewaySeq(site: Site): number {
  try {
    const state = JSON.parse(readFileSync(join(site.dir, 'gw-data', 'access-sync-state.json'), 'utf8')) as { controllers?: Record<string, { seq: number }> };
    return state.controllers?.[site.ctl]?.seq ?? 0;
  } catch {
    return 0;
  }
}

/** Dernier `seq` attribue par le PSIM a ce controleur, lu dans SA base (lecture seule, a faire PSIM arrete ou au repos). */
function psimLastSeq(root: string, ctl: string): number {
  const db = new DatabaseSync(join(root, 'data', 'psim.db'), { readOnly: true });
  try {
    return (db.prepare('SELECT last_seq FROM access_sync_controller WHERE controller_id = ?').get(ctl) as { last_seq: number } | undefined)?.last_seq ?? 0;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------- faux Dahua : lecture de l'etat et des ecritures

const cardsOf = (fake: FakeDahua, holderId: number) => fake.cardsOf(`H${holderId}`);
const cardNosOf = (fake: FakeDahua, holderId: number): string[] => cardsOf(fake, holderId).map((c) => c.CardNo).sort();

interface Write {
  action: 'insert' | 'update' | 'remove';
  family: 'card' | 'holiday';
  recNo: string | null;
  cardNo: string | null;
}
/** Ecritures de cartes et de jours feries recues par le faux controleur (hors lecture), dans l'ordre. */
function writesOf(fake: FakeDahua): Write[] {
  const out: Write[] = [];
  for (const r of fake.requests) {
    const m = /^\/cgi-bin\/recordUpdater\.cgi\?(.*)$/.exec(r.path);
    if (!m) continue;
    const q = new URLSearchParams(m[1]);
    const action = q.get('action');
    if (action !== 'insert' && action !== 'update' && action !== 'remove') continue;
    out.push({ action, family: q.get('name') === 'AccessControlHoliday' ? 'holiday' : 'card', recNo: q.get('recno'), cardNo: q.get('CardNo') });
  }
  return out;
}
const cardWrites = (fake: FakeDahua): Write[] => writesOf(fake).filter((w) => w.family === 'card');

/** Plage horaire du controleur portant ce nom (« PSIM S<id> »). */
const slotOf = (fake: FakeDahua, scheduleRef: string): [number, { Name: string; TimeSchedule: string[][] }] | undefined => [...fake.schedules].find(([, s]) => s.Name === `PSIM ${scheduleRef}`);

const allDay = (): string[] => ['1 00:00:00-23:59:59', '0 00:00:00-00:00:00', '0 00:00:00-00:00:00', '0 00:00:00-00:00:00'];
const none = (): string[] => ['0 00:00:00-00:00:00', '0 00:00:00-00:00:00', '0 00:00:00-00:00:00', '0 00:00:00-00:00:00'];
const officeDay = (): string[] => ['1 08:00:00-17:00:00', '0 00:00:00-00:00:00', '0 00:00:00-00:00:00', '0 00:00:00-00:00:00'];

// ---------------------------------------------------------------------------------------------------------------- site « complet »

/** Numero de badge au hasard (8 chiffres, premier chiffre non nul : accepte aussi par un ZKTeco) ; la collision est negligeable. */
const badgeNo = (): string => String(Math.floor(10_000_000 + Math.random() * 89_999_999));

interface Rig {
  site: Site;
  gw: Gw;
  bureau: any;
  all: any;
  group: any;
  holder: any;
  badges: string[];
}

/**
 * Site Dahua synchronise de bout en bout : plage « Bureau » (lundi-vendredi 8 h-17 h) sur la porte 1, « Tout le temps » sur la
 * porte 2, un groupe, un titulaire a deux badges, cle emise, passerelle demarree, tout acquitte.
 */
async function rig(psim: Psim, tag: Tag, o: { holder?: boolean } = {}): Promise<Rig> {
  const site = await mkSite(psim, tag);
  const all = await builtinSchedule(psim);
  const bureau = await mkSchedule(psim, `${tag} Bureau`);
  const group = await mkGroup(psim, `${tag} Personnel`, [
    { doorId: site.doors[0]!, scheduleId: bureau.id },
    { doorId: site.doors[1]!, scheduleId: all.id },
  ]);
  // Numeros de badge propres au site (un numero est unique dans tout le PSIM partage).
  const badges = [badgeNo(), badgeNo()];
  const holder = o.holder === false ? null : await mkHolder(psim, 'KONAN', 'Yao', [group.id], badges);
  await issueKey(site);
  diag = () => `--- PSIM ---\n${psim.output().split('\n').slice(-12).join('\n')}\n--- passerelle ---\n${lastLogs.at(-1)?.text().split('\n').slice(-14).join('\n') ?? ''}`;
  const gw = await startGateway(site);
  if (holder) await waitSettled(psim, site.ctl);
  return { site, gw, bureau, all, group, holder, badges };
}

// ---------------------------------------------------------------------------------------------------------------- proxy MQTT (coupures et observation des SUBACK)

interface Subscription {
  topic: string;
  requestedQos: number;
  granted: number;
}
interface MqttProxy {
  port: number;
  subscriptions: Subscription[];
  cut(): Promise<void>;
  restore(): Promise<void>;
  close(): Promise<void>;
}

/** Decoupe un flux MQTT en paquets (octet 1, longueur restante variable, contenu). */
function framer(onPacket: (type: number, payload: Buffer) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      let len = 0;
      let mul = 1;
      let i = 1;
      let complete = false;
      for (; i < buf.length && i <= 4; i++) {
        len += (buf[i]! & 0x7f) * mul;
        mul *= 128;
        if ((buf[i]! & 0x80) === 0) {
          complete = true;
          i++;
          break;
        }
      }
      if (!complete || buf.length < i + len) return;
      onPacket(buf[0]! >> 4, buf.subarray(i, i + len));
      buf = buf.subarray(i + len);
    }
  };
}

async function startProxy(targetPort: number): Promise<MqttProxy> {
  const port = await freePort();
  const sockets = new Set<Socket>();
  const subscriptions: Subscription[] = [];
  const pending = new Map<number, { topic: string; qos: number }[]>();
  let server: Server | null = null;
  const make = (): Server =>
    createServer((client) => {
      const up = connect(targetPort, '127.0.0.1');
      sockets.add(client);
      sockets.add(up);
      const fromClient = framer((type, payload) => {
        if (type !== 8) return; // SUBSCRIBE
        const id = payload.readUInt16BE(0);
        const subs: { topic: string; qos: number }[] = [];
        for (let i = 2; i < payload.length; ) {
          const n = payload.readUInt16BE(i);
          subs.push({ topic: payload.subarray(i + 2, i + 2 + n).toString('utf8'), qos: payload[i + 2 + n]! });
          i += 3 + n;
        }
        pending.set(id, subs);
      });
      const fromBroker = framer((type, payload) => {
        if (type !== 9) return; // SUBACK
        const subs = pending.get(payload.readUInt16BE(0)) ?? [];
        pending.delete(payload.readUInt16BE(0));
        subs.forEach((s, k) => subscriptions.push({ topic: s.topic, requestedQos: s.qos, granted: payload[2 + k]! }));
      });
      const drop = () => {
        client.destroy();
        up.destroy();
        sockets.delete(client);
        sockets.delete(up);
      };
      client.on('data', (d: Buffer) => {
        fromClient(d);
        up.write(d);
      });
      up.on('data', (d: Buffer) => {
        fromBroker(d);
        client.write(d);
      });
      client.on('error', drop);
      up.on('error', drop);
      client.on('close', drop);
      up.on('close', drop);
    });
  const listen = (): Promise<void> =>
    new Promise((res, rej) => {
      server = make();
      server.once('error', rej);
      server.listen(port, '127.0.0.1', () => res());
    });
  await listen();
  const cut = async (): Promise<void> => {
    const s = server;
    server = null;
    for (const sock of sockets) sock.destroy();
    sockets.clear();
    if (s) await new Promise<void>((r) => s.close(() => r()));
  };
  const proxy: MqttProxy = { port, subscriptions, cut, restore: async () => (server ? undefined : listen()), close: cut };
  cleanups.push(() => proxy.close());
  return proxy;
}

// ---------------------------------------------------------------------------------------------------------------- ordres signes (essais de droits)

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function signedOrder(key: string, ctl: string, seq: number, body: Record<string, unknown>): string {
  const opId = randomBytes(16).toString('hex');
  const ts = Date.now();
  const text = JSON.stringify(body);
  const sig = createHmac('sha256', Buffer.from(key, 'hex')).update(`psim-sync-v1|${ctl}|${opId}|${seq}|${ts}|${sha256(text)}`, 'utf8').digest('hex');
  return JSON.stringify({ v: 1, opId, seq, ts, body: text, sig });
}

// ---------------------------------------------------------------------------------------------------------------- essai

describe('synchronisation des titulaires : API du PSIM -> courtier -> passerelle -> module -> faux controleur', { timeout: 280_000 }, () => {
  let psim: Psim;

  before(async () => {
    psim = await bootPsim({ root: tempRoot('psim-e2e-sync-') });
    cleanups.push(() => killPsim(psim));
  });

  afterEach(async () => {
    diag = () => '';
    // Les passerelles et faux controleurs du scenario, mais pas le PSIM partage : il est le premier de la pile, donc le dernier a partir.
    const keep = cleanups.splice(0, 2); // [dossier du PSIM, processus du PSIM]
    await runCleanups();
    cleanups.push(...keep);
  });

  after(async () => {
    await runCleanups();
    for (const line of measures) console.log(`[mesure] ${line}`);
  });

  // ------------------------------------------------------------------------------------------------------------------------
  // 1. Creation
  // ------------------------------------------------------------------------------------------------------------------------

  it('1. creation : plage, groupe, titulaire a deux badges -> cartes et plages dans le controleur, titulaire « synchronise » (premier envoi mesure)', { timeout: 60_000 }, async () => {
    const site = await mkSite(psim, 's1');
    const fake = site.fake!;
    const all = await builtinSchedule(psim);
    const bureau = await mkSchedule(psim, 'S1 Bureau');
    const group = await mkGroup(psim, 'S1 Personnel', [
      { doorId: site.doors[0]!, scheduleId: bureau.id },
      { doorId: site.doors[1]!, scheduleId: all.id },
    ]);
    const holder = await mkHolder(psim, 'KONAN', 'Yao', [group.id], ['0012345', '0012346']);
    assert.equal(holder.ref, `H${holder.id}`);

    // Avant la cle : « non active », titulaire en attente.
    const before = await syncStatus(psim, site.ctl);
    assert.equal(before.state, 'disabled');
    assert.equal(before.enabled, false);

    const key = await issueKey(site);
    diag = () => `--- PSIM ---\n${psim.output().split('\n').slice(-12).join('\n')}\n--- passerelle ---\n${lastLogs.at(-1)?.text().split('\n').slice(-14).join('\n') ?? ''}`;
    const afterKey = await syncStatus(psim, site.ctl);
    assert.equal(afterKey.state, 'pending');
    assert.equal(afterKey.counts.pending, 3, 'deux plages et un titulaire attendus');
    assert.equal(afterKey.counts.synced, 0);
    assert.equal((await holderSync(psim, holder.id))[0].state, 'pending');
    assert.equal(fake.cards.length + fake.schedules.size, 0, 'rien n\'est ecrit avant la passerelle');

    // Passerelle : la cle est recopiee dans la configuration du module (`syncKey`).
    const t0 = performance.now();
    const gw = await startGateway(site, { key });
    const tGateway = ms(t0);
    await until('cartes et plages dans le controleur', () => fake.cards.length === 2 && fake.schedules.size === 2);
    const tApplied = ms(t0);
    await waitSettled(psim, site.ctl);
    const tSynced = ms(t0);
    measure('premier envoi (2 plages + 1 titulaire a 2 badges), depart de la passerelle -> ecrit dans le controleur', `${tApplied} ms (passerelle prete apres ${tGateway} ms)`);
    measure('premier envoi, depart de la passerelle -> etat PSIM « synchronise »', `${tSynced} ms`);

    // Contenu exact du controleur.
    const [bureauSlot, bureauSchedule] = slotOf(fake, bureau.ref)!;
    const [allSlot, allSchedule] = slotOf(fake, all.ref)!;
    assert.notEqual(bureauSlot, allSlot);
    assert.deepEqual(bureauSchedule.TimeSchedule, [none(), officeDay(), officeDay(), officeDay(), officeDay(), officeDay(), none()], 'lundi a vendredi 8 h-17 h (jour 0 = dimanche)');
    assert.deepEqual(allSchedule.TimeSchedule, Array.from({ length: 7 }, allDay), '« Tout le temps » : 7 jours entiers');
    assert.deepEqual(cardNosOf(fake, holder.id), ['0012345', '0012346']);
    for (const card of cardsOf(fake, holder.id)) {
      assert.equal(card.CardName, 'KONAN Yao');
      assert.equal(card.UserID, `H${holder.id}`);
      assert.equal(card.CardStatus, 0, 'titulaire actif : carte normale');
      assert.deepEqual(card.Doors, [0, 1], 'les deux portes du controleur');
      assert.deepEqual(card.TimeSections, [bureauSlot, allSlot], 'plage « Bureau » sur la porte 1, « Tout le temps » sur la porte 2');
      assert.equal(card.ValidDateStart, '20000101 000000');
      assert.equal(card.ValidDateEnd, '20371231 235959');
      assert.equal(card.Password, undefined, 'jamais de code PIN');
    }
    assert.equal(fake.holidays.length, 0, 'aucun jour ferie declare');
    assert.deepEqual(fake.forbidden, [], 'aucune donnee interdite recue');
    assert.deepEqual(fake.forbiddenPaths, []);

    // Ce que voit l'administrateur.
    const sync = await holderSync(psim, holder.id);
    assert.deepEqual(sync.map((s) => [s.controllerId, s.state, s.message]), [[site.ctl, 'synced', null]]);
    const status = await syncStatus(psim, site.ctl);
    assert.equal(status.state, 'ok');
    assert.equal(status.enabled, true);
    assert.deepEqual(status.counts, { synced: 3, pending: 0, failed: 0, blocked: 0 });
    assert.equal(status.lastProblem, null);
    assert.ok(status.lastAckAt !== null && Math.abs(status.lastAckAt - Date.now()) < 30_000);
    assert.equal(status.hint, 'Le contrôleur est à jour.');
    const list = ok(await psim.api('GET', '/api/access/holders?q=konan'), 200);
    assert.equal(list.items[0].syncState, 'synced');
    assert.deepEqual((await syncDetail(psim, site.ctl)).items, [], 'rien a signaler');

    // Cote passerelle : trois operations faites, ni refus ni rejet, et le journal ne contient ni nom, ni badge, ni cle.
    const st = gw.rt.status().accessSync;
    assert.deepEqual([st.controllers, st.done, st.refused, st.failed, st.ignored, st.replayed], [1, 3, 0, 0, 0, 0]);
    assert.equal(gatewaySeq(site), 3);
    const text = gw.log.text();
    assert.equal(new RegExp(`KONAN|0012345|0012346|${key.slice(0, 16)}`).test(text), false, text);
    // ... ni le PSIM : la cle n'est plus relisible.
    assert.ok(!psim.output().includes(key), 'la cle ne sort pas dans la sortie du PSIM');
  });

  // ------------------------------------------------------------------------------------------------------------------------
  // 2. Parcours P3 : desactiver un badge
  // ------------------------------------------------------------------------------------------------------------------------

  it('2. parcours P3 : desactiver un badge -> carte retiree du controleur (delai mesure) ; le passage refuse remonte et nomme le titulaire', { timeout: 90_000 }, async (t) => {
    const r = await rig(psim, 's2');
    const fake = r.site.fake!;
    const [badge, other] = r.badges as [string, string];
    const ref = `H${r.holder.id}`;
    const badgeId = r.holder.badges.find((b: any) => b.number === badge).id as number;
    assert.deepEqual(cardNosOf(fake, r.holder.id), [badge, other].sort());

    const disableToApplied: number[] = [];
    const disableToSynced: number[] = [];
    const enableToApplied: number[] = [];
    for (let i = 0; i < 5; i++) {
      // Le PSIM n'envoie qu'au battement d'une seconde : un decalage au hasard evite de mesurer toujours la meme phase.
      await wait(Math.floor(Math.random() * 900));
      // Desactivation.
      let t0 = performance.now();
      const off = ok(await psim.api('PATCH', `/api/access/badges/${badgeId}`, { state: 'disabled' }), 200);
      assert.equal(off.state, 'disabled');
      const instant = (await holderSync(psim, r.holder.id))[0];
      assert.equal(instant.state, 'pending', 'des la reponse de l\'API le titulaire est « en attente »');
      await until('carte retiree', () => cardNosOf(fake, r.holder.id).join() === other, LONG, 5);
      disableToApplied.push(ms(t0));
      await until('titulaire « synchronise »', async () => (await holderSync(psim, r.holder.id))[0].state === 'synced', LONG, 10);
      disableToSynced.push(ms(t0));
      // Reactivation : la carte revient.
      await wait(Math.floor(Math.random() * 900));
      t0 = performance.now();
      ok(await psim.api('PATCH', `/api/access/badges/${badgeId}`, { state: 'active' }), 200);
      await until('carte retablie', () => cardNosOf(fake, r.holder.id).join() === [badge, other].sort().join(), LONG, 5);
      enableToApplied.push(ms(t0));
      await waitSettled(psim, r.site.ctl);
    }
    const a = stats(disableToApplied);
    const s = stats(disableToSynced);
    const e = stats(enableToApplied);
    measure('desactiver un badge -> carte retiree du controleur (PATCH -> faux controleur)', fmt(a));
    measure('desactiver un badge -> « synchronise » dans l\'API PSIM (acquittement compris)', fmt(s));
    measure('reactiver un badge -> carte de retour', fmt(e));
    t.diagnostic(`desactiver -> applique : ${fmt(a)}`);
    // Le PSIM n'envoie qu'au battement (1 s) apres l'ecriture : sous 3 s dans ce montage local, sinon le parcours P3 est trop lent.
    assert.ok(a.max < 3000, `desactiver -> applique trop lent : ${fmt(a)}`);

    // Etat final : badge desactive, carte retiree, l'autre badge intact.
    ok(await psim.api('PATCH', `/api/access/badges/${badgeId}`, { state: 'disabled' }), 200);
    await until('carte retiree (etat final)', () => cardNosOf(fake, r.holder.id).join() === other, LONG, 5);
    await waitSettled(psim, r.site.ctl);
    assert.equal(cardsOf(fake, r.holder.id).length, 1);
    assert.equal(cardsOf(fake, r.holder.id)[0]!.CardStatus, 0);

    // Passage avec le badge desactive : le controleur ne le connait plus (0x10), refus « badge inconnu », sans nom ni titulaire.
    const t1 = performance.now();
    const denied = fake.emitAccess({ cardNo: badge, cardName: '', userId: '', status: 0, errorCode: 0x10, door: 0 });
    const events = await until('passage refuse dans le journal du PSIM', async () => {
      const res = ok(await psim.api('GET', `/api/access/events?limit=50&count=1&credential=${badge}`), 200);
      return res.total >= 1 ? res : null;
    });
    measure('passage refuse (badge desactive) : controleur -> journal du PSIM', `${ms(t1)} ms`);
    const item = events.items[0];
    assert.equal(item.result, 'denied');
    assert.equal(item.reason, 'unknown_credential');
    assert.equal(item.resultLabel, 'Refusé — badge inconnu');
    assert.equal(item.doorId, r.site.doors[0]);
    assert.equal(item.controllerId, r.site.ctl);
    assert.equal(item.credential, badge);
    assert.equal(item.holderId, r.holder.id, 'rattache au titulaire par le numero de badge');
    assert.equal(item.holderName, 'KONAN Yao');
    assert.equal(item.atDevice, denied.CreateTime * 1000);
    const sheet = ok(await psim.api('GET', `/api/access/holders/${r.holder.id}`), 200);
    assert.equal(sheet.recentPassages[0].credential, badge);
    assert.equal(sheet.recentPassages[0].result, 'denied');
    // Un passage accepte avec l'autre badge est rattache par la reference du controleur.
    fake.emitAccess({ cardNo: other, cardName: 'KONAN Yao', userId: ref, status: 1, door: 1 });
    const granted = await until('passage accepte dans le journal', async () => {
      const res = ok(await psim.api('GET', `/api/access/events?limit=50&count=1&credential=${other}`), 200);
      return res.total >= 1 ? res.items[0] : null;
    });
    assert.deepEqual([granted.result, granted.holderId, granted.doorId], ['granted', r.holder.id, r.site.doors[1]]);
  });

  // ------------------------------------------------------------------------------------------------------------------------
  // 3. Suspension, reactivation, suppression
  // ------------------------------------------------------------------------------------------------------------------------

  it('3. suspension -> cartes gelees ; reactivation -> cartes rétablies ; suppression -> cartes retirees', { timeout: 60_000 }, async () => {
    const r = await rig(psim, 's3');
    const fake = r.site.fake!;
    const id = r.holder.id as number;
    const nos = [...r.badges].sort();
    assert.deepEqual(cardsOf(fake, id).map((c) => c.CardStatus), [0, 0]);

    let t0 = performance.now();
    ok(await psim.api('PUT', `/api/access/holders/${id}`, { status: 'suspended' }), 200);
    await until('cartes gelees', () => cardsOf(fake, id).length === 2 && cardsOf(fake, id).every((c) => c.CardStatus === 4), LONG, 5);
    measure('suspension d\'un titulaire (2 cartes gelees)', `${ms(t0)} ms`);
    assert.deepEqual(cardNosOf(fake, id), nos, 'gelee : jamais supprimee');
    for (const c of cardsOf(fake, id)) assert.deepEqual(c.Doors, [0, 1], 'droits conservés');
    await waitSettled(psim, r.site.ctl);

    t0 = performance.now();
    ok(await psim.api('PUT', `/api/access/holders/${id}`, { status: 'active' }), 200);
    await until('cartes retablies', () => cardsOf(fake, id).length === 2 && cardsOf(fake, id).every((c) => c.CardStatus === 0 && c.IsValid === true), LONG, 5);
    measure('reactivation d\'un titulaire (2 cartes retablies)', `${ms(t0)} ms`);
    assert.deepEqual(cardNosOf(fake, id), nos);
    await waitSettled(psim, r.site.ctl);

    t0 = performance.now();
    assert.equal((await psim.api('DELETE', `/api/access/holders/${id}`)).status, 204);
    assert.equal((await psim.api('GET', `/api/access/holders/${id}`)).status, 404);
    await until('cartes retirees', () => cardsOf(fake, id).length === 0, LONG, 5);
    measure('suppression d\'un titulaire (2 cartes retirees)', `${ms(t0)} ms`);
    const status = await until('etat « ok » sans titulaire', async () => {
      const s = await syncStatus(psim, r.site.ctl);
      return s.state === 'ok' && s.counts.pending === 0 ? s : null;
    });
    assert.equal(status.counts.failed, 0);
    // Plus aucun titulaire n'utilise les deux plages : le PSIM les fait vider dans le controleur (nom vide, segments inactifs).
    const slotsLeft = [...fake.schedules.values()];
    assert.equal(slotsLeft.length, 2);
    assert.deepEqual(slotsLeft.map((x) => x.Name), ['', ''], 'plages videes');
    assert.deepEqual(slotsLeft.map((x) => x.TimeSchedule), [Array.from({ length: 7 }, none), Array.from({ length: 7 }, none)]);
    const done = r.gw.rt.status().accessSync;
    assert.equal(done.refused + done.failed, 0);
  });

  // ------------------------------------------------------------------------------------------------------------------------
  // 4. Coupures
  // ------------------------------------------------------------------------------------------------------------------------

  it('4a. passerelle arretee, trois modifications dans le PSIM (« en attente »), passerelle relancee : tout arrive, une seule fois, dans l\'ordre', { timeout: 90_000 }, async () => {
    const r = await rig(psim, 's4');
    const fake = r.site.fake!;
    const a = r.holder; // 2 badges
    const c = await mkHolder(psim, 'TRAORE', 'Awa', [r.group.id], ['0022222']);
    await waitSettled(psim, r.site.ctl);
    const cRecNo = String(cardsOf(fake, c.id)[0]!.RecNo);
    const seqBefore = gatewaySeq(r.site);

    const t0 = performance.now();
    await r.gw.stop();
    const writes0 = writesOf(fake).length;
    const cardsBefore = JSON.stringify(fake.cards);

    // Trois modifications : creation de B, suspension de A, suppression de C.
    const b = await mkHolder(psim, 'BAMBA', 'Issa', [r.group.id], ['0033333']);
    ok(await psim.api('PUT', `/api/access/holders/${a.id}`, { status: 'suspended' }), 200);
    assert.equal((await psim.api('DELETE', `/api/access/holders/${c.id}`)).status, 204);

    // Elles restent « en attente » : visibles, pas perdues, rien d'ecrit, aucun essai compte tant que personne n'ecoute.
    await wait(1500); // au moins un battement du PSIM
    const status = await syncStatus(psim, r.site.ctl);
    assert.equal(status.state, 'pending');
    assert.equal(status.counts.pending, 3);
    assert.equal(status.counts.synced, 2, 'les deux plages sont acquittees ; A, B et la suppression de C attendent');
    const detail = await syncDetail(psim, r.site.ctl);
    assert.deepEqual(detail.items.map((i: any) => [i.ref, i.op, i.state, i.attempts]).sort(), [[`H${a.id}`, 'upsert', 'pending', 0], [`H${b.id}`, 'upsert', 'pending', 0], [`H${c.id}`, 'delete', 'pending', 0]].sort());
    assert.equal(detail.transportReady, false, 'le PSIM sait que le lien avec la passerelle est coupe');
    assert.match(detail.hint, /lien avec la passerelle/);
    assert.equal(writesOf(fake).length, writes0, 'rien n\'est ecrit pendant l\'arret');
    assert.equal(JSON.stringify(fake.cards), cardsBefore);
    assert.equal(gatewaySeq(r.site), seqBefore);

    // Relance de la passerelle (meme cle, meme dossier) : reprise.
    const t1 = performance.now();
    const gw2 = await startGateway(r.site);
    await waitSettled(psim, r.site.ctl);
    const tResume = ms(t1);
    measure('reprise apres arret de la passerelle (3 modifications en attente) : redemarrage -> « synchronise »', `${tResume} ms`);
    measure('arret de la passerelle -> tout rattrape (arret compris)', `${ms(t0)} ms`);

    // Etat final.
    assert.deepEqual(cardNosOf(fake, a.id), [...r.badges].sort());
    assert.ok(cardsOf(fake, a.id).every((x) => x.CardStatus === 4), 'A suspendu : cartes gelees');
    assert.deepEqual(cardNosOf(fake, b.id), ['0033333']);
    assert.equal(cardsOf(fake, b.id)[0]!.CardStatus, 0);
    assert.deepEqual(cardsOf(fake, c.id), [], 'C supprime');

    // Une seule fois, dans l'ordre (creations et mises a jour d'abord, suppressions ensuite), sans doublon.
    const writes = cardWrites(fake).slice(writes0);
    const upserts = [
      ...[a, b].map((h: any) => ({ ref: `H${h.id}`, cards: h === a ? [...r.badges].sort() : ['0033333'], action: h === a ? 'update' : 'insert' })),
    ].sort((x, y) => (x.ref < y.ref ? -1 : 1));
    const expected: string[] = [];
    for (const u of upserts) for (const n of u.cards) expected.push(`${u.action} ${n}`);
    expected.push('remove 0022222');
    const got = writes.map((w) => (w.action === 'remove' ? `remove ${w.recNo === cRecNo ? '0022222' : `recno ${w.recNo}`}` : `${w.action} ${w.cardNo}`));
    assert.deepEqual(got, expected, 'ecritures du controleur : ni doublon, ni perte, ni desordre');
    const st = gw2.rt.status().accessSync;
    assert.deepEqual([st.done, st.refused, st.failed, st.ignored, st.replayed, st.reacked], [3, 0, 0, 0, 0, 0]);
    assert.equal(gatewaySeq(r.site), seqBefore + 3, 'trois operations, trois numeros de sequence, aucun gaspille');
  });

  it('4b. coupure de la liaison MQTT (proxy coupe puis retabli) : la modification faite pendant la coupure arrive une fois la liaison revenue', { timeout: 90_000 }, async () => {
    const site = await mkSite(psim, 's4b');
    const proxy = await startProxy(psim.mqttPort);
    const all = await builtinSchedule(psim);
    const group = await mkGroup(psim, 's4b Personnel', [{ doorId: site.doors[0]!, scheduleId: all.id }]);
    const h = await mkHolder(psim, 'DIALLO', 'Mamadou', [group.id], ['0044444']);
    await issueKey(site);
    diag = () => `--- PSIM ---\n${psim.output().split('\n').slice(-12).join('\n')}\n--- passerelle ---\n${lastLogs.at(-1)?.text().split('\n').slice(-14).join('\n') ?? ''}`;
    const gw = await startGateway(site, { mqttPort: proxy.port });
    await waitSettled(psim, site.ctl);
    const fake = site.fake!;
    const seq0 = gatewaySeq(site);

    const t0 = performance.now();
    await proxy.cut();
    await until('passerelle consciente de la coupure', () => !gw.rt.status().psim.connected);
    ok(await psim.api('PUT', `/api/access/holders/${h.id}`, { status: 'suspended' }), 200);
    await wait(1200);
    assert.equal(cardsOf(fake, h.id)[0]!.CardStatus, 0, 'rien n\'arrive pendant la coupure');
    assert.equal((await holderSync(psim, h.id))[0].state, 'pending');
    const writes0 = writesOf(fake).length;
    const t1 = performance.now();
    await proxy.restore();
    await until('carte gelee apres le retour de la liaison', () => cardsOf(fake, h.id)[0]?.CardStatus === 4, LONG, 5);
    measure('reprise apres coupure de la liaison MQTT : liaison rétablie -> carte gelee', `${ms(t1)} ms`);
    await waitSettled(psim, site.ctl);
    assert.equal(writesOf(fake).length - writes0, 1, 'une seule ecriture (mise a jour de la carte), pas de doublon');
    assert.equal(gatewaySeq(site), seq0 + 1);
    const st = gw.rt.status().accessSync;
    assert.deepEqual([st.refused, st.failed, st.ignored], [0, 0, 0]);
    assert.ok(ms(t0) < 40_000);
    // Le retour de la liaison a bien refait l'abonnement en QoS 1 (session « clean »).
    const mine = proxy.subscriptions.filter((s) => s.topic === `psim/access/${site.ctl}/sync`);
    assert.ok(mine.length >= 2, `abonnement refait apres la coupure : ${JSON.stringify(proxy.subscriptions)}`);
    assert.ok(mine.every((s) => s.requestedQos === 1 && s.granted === 1));
  });

  // ------------------------------------------------------------------------------------------------------------------------
  // 6. Droits MQTT avec le vrai client de la passerelle
  // ------------------------------------------------------------------------------------------------------------------------

  it('6. droits MQTT : SUBACK en QoS 1 pour SES controleurs, refus pour celui d\'une autre passerelle, accuse publiable, ordre jamais publiable', { timeout: 90_000 }, async () => {
    const site = await mkSite(psim, 's6');
    const foreign = await mkSite(psim, 's6b'); // appartient a la passerelle gw-s6b
    const all = await builtinSchedule(psim);
    const group = await mkGroup(psim, 's6 Personnel', [{ doorId: site.doors[0]!, scheduleId: all.id }]);
    await mkHolder(psim, 'SYLLA', 'Fanta', [group.id], ['0055555']);
    const key = await issueKey(site);
    const foreignKey = await issueKey(foreign);
    diag = () => `--- PSIM ---\n${psim.output().split('\n').slice(-12).join('\n')}\n--- passerelle ---\n${lastLogs.map((l) => l.text().split('\n').slice(-8).join('\n')).join('\n--\n')}`;

    // Passerelle 1 : la sienne (CTL-S6). Passerelle 2 (compte gw-s6b) : declare SON controleur ET celui de la passerelle 1.
    const proxy1 = await startProxy(psim.mqttPort);
    const proxy2 = await startProxy(psim.mqttPort);
    const gw1 = await startGateway(site, { mqttPort: proxy1.port });
    const fake2 = foreign.fake!;
    const gw2 = await startGateway(foreign, {
      mqttPort: proxy2.port,
      extraControllers: [{ id: site.ctl, host: fake2.host, port: fake2.port, username: fake2.username, password: fake2.password, doors: { '1': doorId('s6b', 9) }, syncKey: key }],
    });
    await waitSettled(psim, site.ctl);
    await until('abonnements constates sur le fil', () => proxy1.subscriptions.length >= 1 && proxy2.subscriptions.length >= 2);

    // SUBACK constates sur le fil.
    const sub1 = proxy1.subscriptions.filter((s) => s.topic === `psim/access/${site.ctl}/sync`);
    assert.deepEqual(sub1.map((s) => [s.requestedQos, s.granted]), [[1, 1]], 'sa propre passerelle : abonnement accorde en QoS 1');
    const own2 = proxy2.subscriptions.filter((s) => s.topic === `psim/access/${foreign.ctl}/sync`);
    assert.deepEqual(own2.map((s) => [s.requestedQos, s.granted]), [[1, 1]], 'la 2e passerelle a bien le sien');
    const stolen = proxy2.subscriptions.filter((s) => s.topic === `psim/access/${site.ctl}/sync`);
    assert.deepEqual(stolen.map((s) => [s.requestedQos, s.granted]), [[1, 128]], 'le controleur d\'une AUTRE passerelle : SUBACK 128 (refuse)');
    await until('erreur claire dans le journal de la 2e passerelle', () => gw2.log.has(/controleur CTL-S6 non autorise pour ce compte \(voir la liste des controleurs d'acces de PSIM_MQTT_GATEWAYS\)/));
    assert.equal(gw2.rt.status().modules[0]?.state, 'running', 'le module de la 2e passerelle continue');
    // La passerelle volee n'a rien recu ni ecrit : l'ordre du PSIM n'a pas ete livre a la 2e.
    assert.equal(gw2.rt.status().accessSync.done, 0);
    assert.equal(fake2.cards.length, 0);

    // Le vrai client de la passerelle 1 : un client brut avec le MEME compte. Les droits sont ceux du compte.
    const raw = async (user: Tag): Promise<mqtt.MqttClient> => {
      const c = mqtt.connect(`mqtt://127.0.0.1:${psim.mqttPort}`, { clientId: `essai-${user}-${randomBytes(3).toString('hex')}`, username: gwUser(user), password: gwPassword(user), clean: true, reconnectPeriod: 0, protocolVersion: 4 });
      cleanups.push(() => new Promise<void>((r) => c.end(true, {}, () => r())));
      await new Promise<void>((res, rej) => {
        c.once('connect', () => res());
        c.once('error', rej);
      });
      return c;
    };
    const subscribe = (c: mqtt.MqttClient, topic: string): Promise<number | undefined> =>
      new Promise((res) => {
        c.subscribe(topic, { qos: 1 }, (err, granted) => res((err as { packet?: { granted?: number[] } } | null)?.packet?.granted?.[0] ?? granted?.[0]?.qos));
      });
    const c1 = await raw('s6');
    assert.equal(await subscribe(c1, `psim/access/${site.ctl}/sync`), 1, 'ses controleurs : QoS 1');
    assert.equal(await subscribe(c1, `psim/access/${foreign.ctl}/sync`), 128, 'celui d\'une autre passerelle');
    assert.equal(await subscribe(c1, 'psim/access/+/sync'), 128, 'joker interdit');
    assert.equal(await subscribe(c1, 'psim/access/#'), 128);
    assert.equal(await subscribe(c1, `psim/access/${site.ctl}/sync-ack`), 128, 'les accuses ne sont remis a personne');
    assert.equal(await subscribe(c1, 'psim/detectors/+/state'), 128, 'les etats des detecteurs sont reserves au compte principal');
    // Publication de l'accuse sur SON controleur : accordee (PUBACK).
    const published = await new Promise<Error | null | undefined>((res) => c1.publish(`psim/access/${site.ctl}/sync-ack`, '{}', { qos: 1 }, (err) => res(err)));
    assert.ok(!published, `accuse publiable : ${published}`);

    // Publication refusee : l'ordre (jamais publiable par un client, meme avec une signature VALIDE) et l'accuse d'un autre controleur.
    const events = { acks: gw1.rt.status().accessSync.done + gw1.rt.status().accessSync.ignored + gw1.rt.status().accessSync.replayed };
    const refusedPublish = async (user: Tag, topic: string, payload: string): Promise<'refuse'> => {
      const c = await raw(user);
      const outcome = await new Promise<'puback' | 'refuse'>((res) => {
        c.once('close', () => res('refuse'));
        c.publish(topic, payload, { qos: 1 }, (err) => res(err ? 'refuse' : 'puback'));
        setTimeout(() => res('puback'), 3000).unref();
      });
      assert.equal(outcome, 'refuse', `publication sur ${topic} par ${gwUser(user)} : doit etre refusee`);
      return 'refuse';
    };
    const forged = signedOrder(key, site.ctl, 90_000, { type: 'delete_holder', holderRef: 'H99999' });
    await refusedPublish('s6', `psim/access/${site.ctl}/sync`, forged);
    await refusedPublish('s6b', `psim/access/${site.ctl}/sync`, forged);
    await refusedPublish('s6b', `psim/access/${site.ctl}/sync-ack`, '{}');
    await refusedPublish('s6', `psim/access/${foreign.ctl}/sync-ack`, '{}');
    await refusedPublish('s6', `psim/access/${site.ctl}/sync/extra`, '{}');
    await wait(500);
    const after = gw1.rt.status().accessSync;
    assert.equal(after.done + after.ignored + after.replayed, events.acks, 'aucun ordre forge n\'a atteint la passerelle');
    assert.equal(gatewaySeq(site), 2, 'seq inchange (une plage et un titulaire)');
    assert.equal(gw2.rt.status().accessSync.done, 0);

    // Et la synchronisation normale continue apres tous ces refus.
    const h2 = await mkHolder(psim, 'KEITA', 'Moussa', [group.id], ['0066666']);
    await until('titulaire synchronise malgre les refus', () => cardNosOf(site.fake!, h2.id).join() === '0066666', LONG, 5);
    await waitSettled(psim, site.ctl);
    void foreignKey;
  });

  // ------------------------------------------------------------------------------------------------------------------------
  // 7. Plage « fermee les jours feries »
  // ------------------------------------------------------------------------------------------------------------------------

  it('7. « fermé les jours fériés » refuse par le module Dahua (not_supported) et visible dans l\'API ; « Tout le temps » et les jours feries passent', { timeout: 60_000 }, async () => {
    const site = await mkSite(psim, 's7');
    const fake = site.fake!;
    const year = new Date().getFullYear();
    const holidays = [`${year}-12-25`, `${year + 1}-01-01`];
    ok(await psim.api('PUT', '/api/access/holidays', { entries: holidays.map((date) => ({ date, label: 'Ferie' })) }), 200);
    // Le PSIM est partage : les jours feries sont retires a la fin pour ne pas alourdir les scenarios suivants.
    cleanups.push(async () => void (await psim.api('PUT', '/api/access/holidays', { entries: [] })));
    const all = await builtinSchedule(psim);
    const closed = await mkSchedule(psim, 's7 Ferme les feries', [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '17:00' }], true);
    const gOk = await mkGroup(psim, 's7 Tout le temps', [{ doorId: site.doors[0]!, scheduleId: all.id }]);
    const gClosed = await mkGroup(psim, 's7 Ferme', [{ doorId: site.doors[1]!, scheduleId: closed.id }]);
    const good = await mkHolder(psim, 'OUATTARA', 'Seydou', [gOk.id], ['0077771']);
    const bad = await mkHolder(psim, 'COULIBALY', 'Aminata', [gClosed.id], ['0077772']);
    await issueKey(site);
    diag = () => `--- PSIM ---\n${psim.output().split('\n').slice(-12).join('\n')}\n--- passerelle ---\n${lastLogs.at(-1)?.text().split('\n').slice(-14).join('\n') ?? ''}`;
    const gw = await startGateway(site);

    // Les elements acceptes arrivent ; la plage « fermee les jours feries » est refusee, et le titulaire qui l'utilise avec elle.
    const status = await until('echec constate', async () => {
      const s = await syncStatus(psim, site.ctl);
      return s.counts.failed >= 1 && s.counts.pending === 0 ? s : null;
    });
    assert.equal(status.state, 'failed');
    assert.equal(fake.holidays.length, 2, 'set_holidays accepte');
    assert.deepEqual(fake.holidays.map((h) => h.HolidayNo).sort(), holidays.map((d) => `PSIM-${d}`));
    assert.ok(slotOf(fake, all.ref), '« Tout le temps » accepte');
    assert.equal(slotOf(fake, closed.ref), undefined, 'rien d\'ecrit pour la plage refusee');
    assert.deepEqual(cardNosOf(fake, good.id), ['0077771']);
    assert.deepEqual(cardsOf(fake, bad.id), [], 'le titulaire de la plage refusee n\'est pas ecrit non plus (horaire inconnu du controleur)');
    assert.equal((await holderSync(psim, good.id))[0].state, 'synced');

    const detail = await syncDetail(psim, site.ctl);
    const item = detail.items.find((i: any) => i.kind === 'schedule' && i.ref === closed.ref);
    assert.ok(item, JSON.stringify(detail.items));
    assert.equal(item.state, 'failed');
    assert.equal(item.code, 'not_supported');
    assert.ok(item.attempts <= 1, 'un refus est definitif : pas de renvoi');
    assert.equal(item.message, EXPECTED_HOLIDAY_MESSAGE);
    const badSync = (await holderSync(psim, bad.id))[0];
    assert.equal(badSync.state, 'failed', 'le titulaire est envoye puis refuse : horaire inconnu du controleur');
    assert.equal(badSync.message, `L'horaire de ce titulaire n'a pas pu être envoyé au contrôleur (voir l'état de la plage ${closed.ref}).`);
    const badItem = detail.items.find((i: any) => i.kind === 'holder' && i.ref === `H${bad.id}`);
    assert.deepEqual([badItem.state, badItem.code], ['failed', 'invalid']);
    assert.equal(detail.lastProblem.code, 'invalid', 'dernier incident : le titulaire refuse apres la plage');
    const st = gw.rt.status().accessSync;
    assert.equal(st.refused >= 2, true);
    assert.equal(st.failed, 0);

    // Un refus definitif ne repart pas tout seul.
    const requests = fake.requests.length;
    await wait(1200);
    assert.equal(writesOf(fake).filter((w) => w.cardNo === '0077772').length, 0);
    assert.equal(gw.rt.status().accessSync.refused, st.refused, 'aucun renvoi');
    void requests;
  });

  // ------------------------------------------------------------------------------------------------------------------------
  // 8. Cle (PSIM a horloge acceleree)
  // ------------------------------------------------------------------------------------------------------------------------

  it('8. cle : mauvaise cle (rien d\'applique, « en attente » puis « echec »), bonne cle rétablie (tout arrive), cle renouvelee (la synchronisation reprend)', { timeout: 120_000 }, async () => {
    const FACTOR = 120;
    const fast = await bootPsim({ root: tempRoot('psim-e2e-sync-cle-'), accelerate: FACTOR });
    cleanups.push(() => killPsim(fast));
    const site = await mkSite(fast, 's8');
    const fake = site.fake!;
    const all = await builtinSchedule(fast);
    const group = await mkGroup(fast, 's8 Personnel', [{ doorId: site.doors[0]!, scheduleId: all.id }]);
    const h = await mkHolder(fast, 'CAMARA', 'Fode', [group.id], ['0088881']);
    const good = await issueKey(site);
    const wrong = randomBytes(32).toString('hex');
    assert.notEqual(wrong, good);
    diag = () => `--- PSIM ---\n${fast.output().split('\n').slice(-12).join('\n')}\n--- passerelle ---\n${lastLogs.at(-1)?.text().split('\n').slice(-14).join('\n') ?? ''}`;

    // a. Mauvaise cle cote passerelle : les ordres sont ignores sans accuse, rien n'est ecrit.
    const gw1 = await startGateway(site, { key: wrong });
    await until('ordre recu et ignore par la passerelle', () => gw1.rt.status().accessSync.ignored >= 1);
    let status = await syncStatus(fast, site.ctl);
    assert.equal(status.state, 'pending', 'en attente (pas encore d\'echec)');
    assert.equal(fake.cards.length, 0);
    assert.equal(fake.schedules.size, 0);
    assert.equal(writesOf(fake).length, 0);
    assert.equal(gw1.rt.status().accessSync.done, 0);
    const detail0 = await syncDetail(fast, site.ctl);
    assert.ok(detail0.items.every((i: any) => i.state === 'pending'));
    assert.match(detail0.items[0].message, /Envoyé \d+ fois, en attente|En attente d'envoi/);
    // ... puis « echec » apres plus de 5 essais sans accuse (temps accelere du PSIM : 10 s, 20 s, 40 s... virtuelles).
    const t0 = performance.now();
    status = await until('echec « sans accuse » (no_ack)', async () => {
      const s = await syncStatus(fast, site.ctl);
      return s.state === 'failed' ? s : null;
    }, 60_000, 100);
    measure(`cle fausse : « en attente » -> « echec » (horloge PSIM x${FACTOR}, soit environ ${Math.round((ms(t0) * FACTOR) / 1000)} s virtuelles)`, `${ms(t0)} ms reelles`);
    assert.equal(status.lastProblem.code, 'no_ack');
    assert.match(status.lastProblem.message, /passerelle/);
    assert.match(status.lastProblem.message, /clé de synchronisation/);
    const detail1 = await syncDetail(fast, site.ctl);
    assert.ok(detail1.items.some((i: any) => i.state === 'failed' && i.code === 'no_ack'));
    assert.equal(fake.cards.length + fake.schedules.size + writesOf(fake).length, 0, 'toujours rien dans le controleur');
    assert.ok(gw1.rt.status().accessSync.ignored >= 5, `ordres ignores : ${gw1.rt.status().accessSync.ignored}`);
    assert.equal(gw1.rt.status().accessSync.done, 0);

    // b. Bonne cle retablie (redemarrage de la passerelle) : le renvoi automatique du PSIM aboutit, tout arrive.
    await gw1.stop();
    const t1 = performance.now();
    const gw2 = await startGateway(site, { key: good });
    await waitSettled(fast, site.ctl, 60_000);
    measure(`bonne cle retablie : redemarrage de la passerelle -> « synchronise » (horloge PSIM x${FACTOR})`, `${ms(t1)} ms reelles`);
    assert.deepEqual(cardNosOf(fake, h.id), ['0088881']);
    assert.equal((await syncStatus(fast, site.ctl)).lastProblem, null, 'le dernier incident est resolu');

    // c. Cle renouvelee : l'ancienne ne marche plus, la passerelle doit recevoir la nouvelle.
    const seq0 = gatewaySeq(site);
    const renewed = await issueKey(site, true);
    assert.notEqual(renewed, good);
    ok(await fast.api('PUT', `/api/access/holders/${h.id}`, { status: 'suspended' }), 200);
    await until('ordre refuse par la passerelle (ancienne cle)', () => gw2.rt.status().accessSync.ignored >= 1);
    assert.equal(cardsOf(fake, h.id)[0]!.CardStatus, 0, 'avec l\'ancienne cle rien n\'est applique');
    assert.equal((await holderSync(fast, h.id))[0].state, 'pending');
    await gw2.stop();
    const gw3 = await startGateway(site, { key: renewed });
    await until('carte gelee avec la nouvelle cle', () => cardsOf(fake, h.id)[0]?.CardStatus === 4, 60_000, 20);
    await waitSettled(fast, site.ctl, 60_000);
    assert.ok(gw3.log.has(/cle de synchronisation changee depuis le dernier demarrage : numero de sequence remis a zero/), gw3.log.text());
    assert.ok(gatewaySeq(site) > 0);
    assert.ok(seq0 > 0);
  });

  // ------------------------------------------------------------------------------------------------------------------------
  // 5. Redemarrage du PSIM en cours de synchronisation
  // ------------------------------------------------------------------------------------------------------------------------

  it('5. le PSIM (processus tue) redemarre en pleine synchronisation : l\'operation en vol repart, aucune perte, aucun doublon, seq jamais en arriere', { timeout: 120_000 }, async () => {
    const root = tempRoot('psim-e2e-sync-redem-');
    let p = await bootPsim({ root });
    cleanups.push(() => killPsim(p));
    const site = await mkSite(p, 's5');
    const fake = site.fake!;
    const all = await builtinSchedule(p);
    const group = await mkGroup(p, 's5 Personnel', [{ doorId: site.doors[0]!, scheduleId: all.id }]);
    const first = await mkHolder(p, 'PREMIER', 'Titulaire', [group.id], [badgeNo()]);
    await issueKey(site);
    diag = () => `--- PSIM ---\n${p.output().split('\n').slice(-12).join('\n')}\n--- passerelle ---\n${lastLogs.at(-1)?.text().split('\n').slice(-14).join('\n') ?? ''}`;
    const gw = await startGateway(site);
    await waitSettled(p, site.ctl);
    const seq0 = gatewaySeq(site);
    assert.equal(seq0, 2, 'une plage et un titulaire');
    const cardsBase = fake.cards.length;

    // Le controleur est lent : chaque titulaire demande une demi-seconde, la synchronisation dure assez pour etre interrompue.
    fake.latencyMs = 250;
    const N = 6;
    const wanted: { id: number; card: string }[] = [];
    for (let i = 0; i < N; i++) {
      const card = badgeNo();
      const h = await mkHolder(p, `LOT${i}`, 'Essai', [group.id], [card]);
      wanted.push({ id: h.id, card });
    }
    const seqs: number[] = [];
    const sampler = setInterval(() => seqs.push(gatewaySeq(site)), 20);
    cleanups.push(() => clearInterval(sampler));
    await until('synchronisation en cours (au moins 2 titulaires ecrits, pas tous)', () => fake.cards.length >= cardsBase + 2 && fake.cards.length < cardsBase + N, LONG, 5);
    const writtenAtKill = fake.cards.length - cardsBase;
    const seqAtKill = gatewaySeq(site);

    // Coup d'arret brutal du PSIM, puis redemarrage sur le MEME dossier de donnees et les MEMES ports.
    const t0 = performance.now();
    await killPsim(p);
    const psimSeqAtKill = psimLastSeq(root, site.ctl);
    await until('passerelle consciente de la coupure', () => !gw.rt.status().psim.connected);
    p = await bootPsim({ root, web: p.web, mqttPort: p.mqttPort });
    const tBoot = ms(t0);
    await until('passerelle reconnectee au PSIM', () => gw.rt.status().psim.connected);
    await waitSettled(p, site.ctl);
    const tResume = ms(t0);
    clearInterval(sampler);
    seqs.push(gatewaySeq(site));
    measure(`redemarrage du PSIM en pleine synchronisation (${writtenAtKill}/${N} titulaires deja ecrits) : arret -> PSIM relance`, `${tBoot} ms`);
    measure('redemarrage du PSIM en pleine synchronisation : arret -> tout rattrape et « synchronise »', `${tResume} ms`);
    fake.latencyMs = 0;

    // Aucune perte, aucun doublon : une insertion par carte, jamais de mise a jour (l'operation en vol n'a pas ete rejouee dans le controleur).
    for (const w of wanted) {
      assert.deepEqual(cardNosOf(fake, w.id), [w.card], `titulaire LOT${w.id}`);
      assert.equal(fake.cards.filter((c) => c.CardNo === w.card).length, 1);
      const mine = cardWrites(fake).filter((x) => x.cardNo === w.card);
      assert.deepEqual(mine.map((x) => x.action), ['insert'], `ecritures de la carte ${w.card}`);
    }
    assert.equal(fake.cards.length, cardsBase + N);
    // seq : jamais en arriere, et exactement un numero par operation (celle en vol est renvoyee a l'identique, pas rejouee sous un autre).
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i]! >= seqs[i - 1]!, `seq a recule : ${seqs.join(',')}`);
    assert.equal(gatewaySeq(site), seq0 + N, `seq final (avant l'arret : ${seqAtKill})`);
    assert.ok(psimSeqAtKill >= seqAtKill, `le PSIM avait attribue au moins le seq applique par la passerelle (${psimSeqAtKill} >= ${seqAtKill})`);
    assert.equal(psimLastSeq(root, site.ctl), seq0 + N, 'seq du PSIM : continue apres le redemarrage, sans trou ni regression');
    const st = gw.rt.status().accessSync;
    assert.deepEqual([st.done, st.refused, st.failed, st.ignored], [seq0 + N, 0, 0, 0]);
    assert.equal(gw.log.has(/deja applique\(s\) ou plus ancien\(s\) ignore\(s\) \(rejeu\)/), false, 'aucun ordre de seq ancien');
    // Etat du PSIM apres redemarrage.
    const status = await syncStatus(p, site.ctl);
    assert.deepEqual(status.counts, { synced: 2 + N + 0, pending: 0, failed: 0, blocked: 0 });
    void first;
    await until('liste des titulaires coherente', async () => ok(await p.api('GET', '/api/access/holders?limit=100'), 200).total === 1 + N);
  });

  it('5b. [a corriger] PSIM restaure depuis une ancienne sauvegarde (seq en retard sur la passerelle) : la synchronisation devrait reprendre seule', { timeout: 120_000, todo: 'procedure « remettre les deux cotes a zero » en cours chez un autre agent : le seq du PSIM restaure est <= au dernier seq de la passerelle, tout est ignore (aucun accuse), l\'operation reste en vol' }, async (t) => {
    const root = tempRoot('psim-e2e-sync-sauvegarde-');
    let p = await bootPsim({ root });
    cleanups.push(() => killPsim(p));
    const site = await mkSite(p, 's5');
    const fake = site.fake!;
    const all = await builtinSchedule(p);
    const group = await mkGroup(p, 's5b Personnel', [{ doorId: site.doors[0]!, scheduleId: all.id }]);
    await mkHolder(p, 'AVANT', 'Sauvegarde', [group.id], [badgeNo()]);
    await issueKey(site);
    diag = () => `--- PSIM ---\n${p.output().split('\n').slice(-12).join('\n')}\n--- passerelle ---\n${lastLogs.at(-1)?.text().split('\n').slice(-14).join('\n') ?? ''}`;
    const gw = await startGateway(site);
    await waitSettled(p, site.ctl);
    // Sauvegarde (PSIM arrete : copie coherente du dossier de donnees), puis la vie continue.
    await killPsim(p);
    const snapshot = join(root, 'sauvegarde');
    cpSync(join(root, 'data'), snapshot, { recursive: true });
    p = await bootPsim({ root, web: p.web, mqttPort: p.mqttPort });
    for (let i = 0; i < 3; i++) await mkHolder(p, `APRES${i}`, 'Sauvegarde', [group.id], [badgeNo()]);
    await waitSettled(p, site.ctl);
    const seqPasserelle = gatewaySeq(site);
    assert.equal(seqPasserelle, 5);
    // Panne : on restaure la sauvegarde. Le PSIM croit en etre au seq 2 ; la passerelle est au 5.
    await killPsim(p);
    rmSync(join(root, 'data'), { recursive: true, force: true });
    cpSync(snapshot, join(root, 'data'), { recursive: true });
    p = await bootPsim({ root, web: p.web, mqttPort: p.mqttPort });
    await until('passerelle reconnectee', () => gw.rt.status().psim.connected);
    // (Les identifiants de titulaires sont reutilises par la base restauree : on suit le NUMERO de carte, pas l'identifiant.)
    const card = badgeNo();
    await mkHolder(p, 'DEPUIS', 'Restauration', [group.id], [card]);
    const t0 = performance.now();
    const applied = await until('titulaire applique', () => fake.cards.some((c) => c.CardNo === card), 5000, 50).then(
      () => true,
      () => false,
    );
    const status = await syncStatus(p, site.ctl);
    const psimSeq = psimLastSeq(root, site.ctl);
    t.diagnostic(`seq du PSIM restaure : ${psimSeq}`);
    console.log(`[note] sc.5b : seq du PSIM apres restauration = ${psimSeq}, seq de la passerelle = ${gatewaySeq(site)}`);
    t.diagnostic(`apres restauration : applique=${applied} (${ms(t0)} ms), etat PSIM=${status.state}, seq passerelle=${gatewaySeq(site)}, ordres rejoues ignores : ${gw.rt.status().accessSync.replayed}`);
    console.log(`[note] sc.5b : apres restauration d'une ancienne sauvegarde du PSIM, applique=${applied}, etat PSIM=${status.state}, ordres ignores par la passerelle (seq ancien)=${gw.rt.status().accessSync.replayed}`);
    assert.equal(applied, true, 'la synchronisation reprend seule apres une restauration');
  });

  // ------------------------------------------------------------------------------------------------------------------------
  // 9. ZKTeco
  // ------------------------------------------------------------------------------------------------------------------------

  it('9. ZKTeco : creation puis desactivation d\'un badge (cycle d\'interrogation getrequest de 3 s) ; delais mesures', { timeout: 120_000 }, async (t) => {
    const site = await mkSite(psim, 's9', 'zkteco');
    const bureau = await mkSchedule(psim, 's9 Bureau');
    const group = await mkGroup(psim, 's9 Personnel', [
      { doorId: site.doors[0]!, scheduleId: bureau.id },
      { doorId: site.doors[1]!, scheduleId: bureau.id },
    ]);
    const card = badgeNo();
    const holder = await mkHolder(psim, 'KONE', 'Adama', [group.id], [card]);
    const pin = String(holder.id);
    await issueKey(site);
    diag = () => `--- PSIM ---\n${psim.output().split('\n').slice(-12).join('\n')}\n--- passerelle ---\n${lastLogs.at(-1)?.text().split('\n').slice(-14).join('\n') ?? ''}`;

    const httpPort = await freePort();
    const serial = 'CJDK900000009';
    const t0 = performance.now();
    const gw = await startGateway(site, { zk: { httpPort, serial } });
    const dev = new FakeZk({ port: httpPort, serial, now: () => Date.now() });
    await dev.handshake();
    // L'appareil interroge le serveur a son rythme (3 s) et execute les commandes recues, une par passage.
    let polling = true;
    cleanups.push(() => {
      polling = false;
    });
    void (async () => {
      while (polling) {
        try {
          await dev.poll();
        } catch {
          // appareil injoignable un instant : prochain cycle
        }
        await wait(ZK_POLL_MS);
      }
    })();

    await until('titulaire ecrit dans la centrale', () => dev.users.get(pin)?.CardNo === card && dev.authorizations.size === 1, 60_000, 50);
    const tApplied = ms(t0);
    await waitSettled(psim, site.ctl, 30_000);
    measure(`ZKTeco (cycle ${ZK_POLL_MS} ms) premier envoi (1 plage + 1 titulaire = 4 commandes), depart de la passerelle -> ecrit dans la centrale`, `${tApplied} ms`);
    measure(`ZKTeco (cycle ${ZK_POLL_MS} ms) premier envoi -> « synchronise » dans l'API PSIM`, `${ms(t0)} ms`);
    const user = dev.users.get(pin)!;
    assert.equal(user.Pin, pin);
    assert.equal(user.CardNo, card);
    assert.equal(user.Name, 'KONE Adama');
    assert.equal(user.StartTime, '0');
    assert.equal(user.EndTime, '0');
    const [auth] = [...dev.authorizations.values()];
    assert.equal(auth!.pin, pin);
    assert.equal(auth!.doors, 3, 'masque des portes 1 et 2');
    const tz = dev.timezones.get(auth!.timezone)!;
    assert.ok(tz, 'fuseau cree');
    assert.deepEqual(dev.forbiddenSeen, []);
    assert.deepEqual((await holderSync(psim, holder.id)).map((s) => [s.controllerId, s.state]), [[site.ctl, 'synced']]);
    const stOk = gw.rt.status().accessSync;
    assert.deepEqual([stOk.done, stOk.refused, stOk.failed, stOk.ignored], [2, 0, 0, 0]);

    // Parcours P3 : desactiver le badge (un cycle de 3 s par commande).
    const badgeId = holder.badges[0].id as number;
    const t1 = performance.now();
    ok(await psim.api('PATCH', `/api/access/badges/${badgeId}`, { state: 'disabled' }), 200);
    assert.equal((await holderSync(psim, holder.id))[0].state, 'pending');
    await until('badge retire de la centrale', () => dev.users.get(pin)?.CardNo === '', 60_000, 50);
    const tOff = ms(t1);
    await waitSettled(psim, site.ctl, 30_000);
    const tOffSynced = ms(t1);
    measure(`ZKTeco (cycle ${ZK_POLL_MS} ms) desactiver un badge -> badge efface dans la centrale`, `${tOff} ms`);
    measure(`ZKTeco (cycle ${ZK_POLL_MS} ms) desactiver un badge -> « synchronise » dans l'API PSIM`, `${tOffSynced} ms`);
    t.diagnostic(`ZKTeco : desactiver -> applique ${tOff} ms, synchronise ${tOffSynced} ms`);
    assert.deepEqual(dev.forbiddenSeen, []);

    // Le passage refuse avec ce badge remonte et nomme le titulaire.
    await dev.push({ event: 27, card, door: 1 });
    const events = await until('passage refuse dans le journal du PSIM', async () => {
      const res = ok(await psim.api('GET', `/api/access/events?limit=50&count=1&credential=${card}`), 200);
      return res.total >= 1 ? res : null;
    }, 30_000, 50);
    assert.equal(events.items[0].result, 'denied');
    assert.equal(events.items[0].holderId, holder.id);
    assert.equal(events.items[0].holderName, 'KONE Adama');
  });

  // ------------------------------------------------------------------------------------------------------------------------
  // 10. Erreur du controleur puis nouvel essai avec un NOUVEAU seq (attend la correction de server/accesssync.ts)
  // ------------------------------------------------------------------------------------------------------------------------

  it(
    '10. le controleur repond par une erreur puis redevient joignable : le PSIM reessaie avec un NOUVEAU seq (code libre inclus) et l\'element finit « synchronise »',
    {
      timeout: 120_000,
    },
    async () => {
      const FACTOR = 120;
      const fast = await bootPsim({ root: tempRoot('psim-e2e-sync-erreur-'), accelerate: FACTOR });
      cleanups.push(() => killPsim(fast));
      const r = await rig(fast, 's8');
      const fake = r.site.fake!;
      const id = r.holder.id as number;
      const seq0 = gatewaySeq(r.site);
      // Le controleur repond « HTTP 500 » aux ecritures de cartes : le module accuse une erreur (pas un refus).
      fake.syncBehavior.cards = 'http500';
      ok(await fast.api('PUT', `/api/access/holders/${id}`, { status: 'suspended' }), 200);
      await until('erreur accusee par la passerelle', () => r.gw.rt.status().accessSync.failed >= 1, 30_000, 50);
      const detail = await syncDetail(fast, r.site.ctl);
      assert.ok(detail.items.some((i: any) => i.ref === `H${id}` && i.state !== 'synced'), 'visible dans l\'API');
      assert.equal(cardsOf(fake, id)[0]!.CardStatus, 0, 'rien n\'a ete applique');
      // Le controleur est de retour : le PSIM doit retenter avec un autre seq (la passerelle ne rejoue jamais un seq deja consomme).
      fake.syncBehavior.cards = 'ok';
      await until('carte gelee apres le nouvel essai', () => cardsOf(fake, id)[0]?.CardStatus === 4, 90_000, 50);
      await waitSettled(fast, r.site.ctl, 60_000);
      assert.ok(gatewaySeq(r.site) > seq0 + 1, 'le nouvel essai a un nouveau seq');
    },
  );
});
