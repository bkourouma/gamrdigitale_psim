/**
 * Environnement de demonstration complet, en une commande :
 *
 *   npm run demo                         menu interactif
 *   npm run demo -- --auto               scenarios en boucle (presentation)
 *   npm run demo -- --scenario=incendie-atelier
 *   options : --speed=2 (scenarios plus rapides)  --duration=60 (s'arrete seul apres 60 s)
 *             --no-onvif (toutes les cameras en RTSP direct, sans faux appareils ONVIF)
 *
 * Lance : MediaMTX (serveur RTSP) + 5 cameras RTSP simulees + le PSIM (base vierge dans data-demo/).
 * Les 4 premieres cameras sont aussi exposees par de faux appareils ONVIF (authentifies, decouvrables
 * sur le reseau) ; la 5e est lue en RTSP direct. Le PSIM est configure pour les lire comme de vraies cameras.
 * Rien n'est ecrit dans data/ : la demo ne touche pas a votre installation.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import mqtt from 'mqtt';
import { MEDIAMTX_BIN, installMediamtx } from './install-mediamtx.ts';
import { startInbox } from './demo/inbox.ts';
import { startDiscoveryResponder, startOnvifDevice } from './demo/onvif-device.ts';
import { createRunner, findScenario } from './demo/runner.ts';
import {
  DEMO_CAMERAS,
  DEMO_CONFIRM_PERSIST_S,
  DEMO_CONFIRM_WINDOW_S,
  DEMO_ESCALATE_AFTER_S,
  DEMO_FALSE_ALARM_HINT_S,
  DEMO_MAX_REMINDERS,
  DEMO_REMINDER_S,
  DEMO_HEARTBEAT_S,
  DEMO_SILENT_TIMEOUT_S,
  SCENARIOS,
} from './demo/scenarios.ts';
import { HEIGHT, Scene, WIDTH } from './demo/scene.ts';

const root = resolve(import.meta.dirname, '..');
const dataDir = join(root, 'data-demo');
const PSIM_PORT = 3034;
const MQTT_PORT = 1884;
const RTSP_PORT = 8554;
const ONVIF_BASE_PORT = 8801; // un faux appareil ONVIF par camera : 8801, 8802, ...
const ONVIF_CAMERAS = 4; // les 4 premieres cameras ; la 5e reste en RTSP direct
const FPS = 8;
const FFMPEG = process.env.PSIM_FFMPEG ?? 'ffmpeg';

// La demo utilise toujours les identifiants de developpement, jamais ceux de votre .env.
for (const name of [...Object.keys(process.env).filter((k) => /^PSIM_(NOTIFY_|SMTP_|TELEGRAM_|WEBHOOK_|ESCALATE_|REMINDER_|MAX_REMINDERS|PUBLIC_URL)/.test(k)), 'PSIM_CONFIRM_WINDOW_S', 'PSIM_CONFIRM_PERSIST_S', 'PSIM_FALSE_ALARM_HINT_S', 'PSIM_DETECTOR_TIMEOUT_S', 'PSIM_ADMIN_PASSWORD', 'PSIM_OPERATOR_PASSWORD', 'PSIM_MQTT_PASSWORD', 'PSIM_SECRET_KEY', 'PSIM_DEMO_LOGIN']) {
  delete process.env[name];
}
const { config } = await import('../server/config.ts');

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagValue = (name: string) => flag(name)?.split('=')[1];
const speed = Number(flagValue('speed') ?? 1);
const useOnvif = !flag('no-onvif');

const children: ChildProcess[] = [];
const log = (message: string) => console.log(message);

function fail(message: string): never {
  console.error(`\nERREUR : ${message}`);
  shutdown(1);
  throw new Error(message);
}

let shuttingDown = false;
function shutdown(code = 0): void {
  shuttingDown = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`${what} ne repond pas apres ${timeoutMs / 1000} s`);
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => socket.end(() => done(true)));
    socket.once('error', () => done(false));
  });
}

// ---------------------------------------------------------------- 1. preparation

console.log('GAMRdigitale PSIM - environnement de demonstration\n');

const ffmpegCheck = await new Promise<boolean>((done) => {
  const p = spawn(FFMPEG, ['-version'], { stdio: 'ignore' });
  p.once('error', () => done(false));
  p.once('exit', (code) => done(code === 0));
});
if (!ffmpegCheck) fail('ffmpeg est introuvable (installez-le ou renseignez PSIM_FFMPEG).');

const needed: [number, string][] = [[PSIM_PORT, 'PSIM de demonstration'], [MQTT_PORT, 'broker MQTT de demonstration'], [RTSP_PORT, 'serveur RTSP']];
if (useOnvif) for (let i = 0; i < ONVIF_CAMERAS; i++) needed.push([ONVIF_BASE_PORT + i, `faux appareil ONVIF ${i + 1}`]);
for (const [port, name] of needed) {
  if (!(await portFree(port))) {
    fail(`le port ${port} (${name}) est deja utilise. Une autre demo tourne-t-elle ? Fermez-la, ou liberez ce port.`);
  }
}

await installMediamtx(log).catch((err) => fail(err instanceof Error ? err.message : String(err)));

// La base de demo est jetable : on repart de zero a chaque lancement.
if (resolve(dataDir) !== join(root, 'data-demo')) fail('chemin de demo inattendu');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const publisherUser = 'demo-publisher';
const publisherPass = randomBytes(12).toString('hex');
const viewerUser = 'demo-camera';
const viewerPass = randomBytes(12).toString('hex');

// ---------------------------------------------------------------- 2. MediaMTX

const mediamtxConfig = join(dataDir, 'mediamtx.yml');
writeFileSync(
  mediamtxConfig,
  `logLevel: warn
api: false
metrics: false
pprof: false
playback: false
rtmp: false
hls: false
webrtc: false
srt: false
moq: false
rtsp: true
rtspTransports: [tcp]
rtspAddress: 127.0.0.1:${RTSP_PORT}
authMethod: internal
authInternalUsers:
  - user: ${publisherUser}
    pass: ${publisherPass}
    ips: ["127.0.0.1", "::1"]
    permissions:
      - action: publish
  - user: ${viewerUser}
    pass: ${viewerPass}
    ips: ["127.0.0.1", "::1"]
    permissions:
      - action: read
paths:
  all_others:
`,
);

// cwd = data-demo : MediaMTX n'ecrit jamais de fichier dans le projet.
const mediamtx = spawn(MEDIAMTX_BIN, [mediamtxConfig], { cwd: dataDir, stdio: ['ignore', 'pipe', 'pipe'] });
children.push(mediamtx);
mediamtx.stdout.on('data', (d: Buffer) => process.stdout.write(`[mediamtx] ${d}`));
mediamtx.stderr.on('data', (d: Buffer) => process.stdout.write(`[mediamtx] ${d}`));
mediamtx.once('exit', (code) => {
  if (code && !shuttingDown) fail(`MediaMTX s'est arrete (code ${code})`);
});
await waitFor('MediaMTX', () => tcpOpen(RTSP_PORT));

// ---------------------------------------------------------------- 2b. faux appareils ONVIF

const onvifPorts = new Map<string, number>(); // idCamera -> port de l'appareil ONVIF
const onvifCleanup: (() => Promise<void>)[] = [];
let discoveryResponding = false;
if (useOnvif) {
  for (const [i, camera] of DEMO_CAMERAS.slice(0, ONVIF_CAMERAS).entries()) {
    const port = ONVIF_BASE_PORT + i;
    const device = await startOnvifDevice({
      port,
      username: viewerUser,
      password: viewerPass,
      manufacturer: 'DemoCam',
      model: 'DC-100',
      // Adresse "interne" volontairement fausse, comme beaucoup de cameras reelles : le PSIM doit l'ignorer.
      rtsp: { host: '10.255.255.1', port: RTSP_PORT, path: `/${camera.id}` },
      width: WIDTH,
      height: HEIGHT,
    }).catch((err) => fail(`faux appareil ONVIF ${camera.id} : ${err.message}`));
    onvifCleanup.push(device.close);
    onvifPorts.set(camera.id, port);
  }
  // Repond a « Rechercher sur le reseau » (multidiffusion UDP). Facultatif : la demo marche sans.
  try {
    const responder = await startDiscoveryResponder(
      [...onvifPorts].map(([id, port]) => ({ host: '127.0.0.1', port, name: `DemoCam ${id}`, hardware: 'DC-100' })),
    );
    onvifCleanup.push(responder.close);
    discoveryResponding = true;
  } catch (err) {
    console.log(`(recherche reseau ONVIF indisponible : ${err instanceof Error ? err.message : err})`);
  }
}

// ---------------------------------------------------------------- 2c. boite de reception (notifications)

// Faux SMTP + faux Telegram locaux : rien ne quitte la machine, tout s'affiche ici.
const inbox = await startInbox((line) => console.log(line), 2525, 2526).catch((err) =>
  fail(`boite de reception de la demo (ports 2525 et 2526) : ${err.message}`),
);
const telegramToken = randomBytes(12).toString('hex');

// ---------------------------------------------------------------- 3. PSIM

const server = spawn(process.execPath, [join(root, 'server', 'index.ts')], {
  cwd: root,
  env: {
    ...process.env,
    PSIM_PORT: String(PSIM_PORT),
    PSIM_MQTT_PORT: String(MQTT_PORT),
    PSIM_DATA_DIR: 'data-demo',
    PSIM_DEMO_LOGIN: '1',
    // Notifications vers la boite de reception locale ; escalade a l'echelle de temps de la demo.
    PSIM_SMTP_HOST: '127.0.0.1',
    PSIM_SMTP_PORT: String(inbox.smtpPort),
    PSIM_SMTP_STARTTLS: '0',
    PSIM_SMTP_FROM: 'psim@demo.test',
    PSIM_NOTIFY_EMAIL_L1: 'operateur@demo.test',
    PSIM_NOTIFY_EMAIL_L2: 'responsable@demo.test',
    PSIM_TELEGRAM_TOKEN: telegramToken,
    PSIM_TELEGRAM_API: inbox.telegramBase,
    PSIM_NOTIFY_TELEGRAM_L1: '111',
    PSIM_NOTIFY_TELEGRAM_L2: '222',
    PSIM_ESCALATE_AFTER_S: String(Math.max(2, Math.round(DEMO_ESCALATE_AFTER_S / speed))),
    PSIM_REMINDER_S: String(Math.max(2, Math.round(DEMO_REMINDER_S / speed))),
    PSIM_MAX_REMINDERS: String(DEMO_MAX_REMINDERS),
    // La demo envoie des signaux de vie : la surveillance des detecteurs muets est donc active.
    PSIM_DETECTOR_TIMEOUT_S: String(Math.max(2, Math.round(DEMO_SILENT_TIMEOUT_S / speed))),
    // Regles anti-fausses alarmes, a l'echelle de temps de la demo.
    PSIM_CONFIRM_WINDOW_S: String(Math.max(2, Math.round(DEMO_CONFIRM_WINDOW_S / speed))),
    PSIM_CONFIRM_PERSIST_S: String(Math.max(2, Math.round(DEMO_CONFIRM_PERSIST_S / speed))),
    PSIM_FALSE_ALARM_HINT_S: String(Math.max(2, Math.round(DEMO_FALSE_ALARM_HINT_S / speed))),
    PSIM_FFMPEG: FFMPEG,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(server);
let serverOutput = '';
server.stdout.on('data', (d: Buffer) => (serverOutput += d));
server.stderr.on('data', (d: Buffer) => (serverOutput += d));
server.once('exit', (code) => {
  if (code && !shuttingDown) fail(`le PSIM s'est arrete (code ${code}) :\n${serverOutput.slice(-600)}`);
});
const base = `http://127.0.0.1:${PSIM_PORT}`;
await waitFor('le PSIM', async () => (await fetch(`${base}/api/me`)).status === 401);

// ---------------------------------------------------------------- 4. cameras RTSP simulees

const fire = new Map<string, 0 | 1 | 2>();
const setFire = (zone: string, level: 0 | 1 | 2) => fire.set(zone, level);

function startCamera(id: string, zone: string): void {
  const scene = new Scene(id, zone, () => fire.get(zone) ?? 0);
  const url = `rtsp://${publisherUser}:${publisherPass}@127.0.0.1:${RTSP_PORT}/${id}`;
  let proc: ChildProcess | null = null;
  const launch = () => {
    proc = spawn(
      FFMPEG,
      [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-video_size', `${WIDTH}x${HEIGHT}`, '-framerate', String(FPS), '-i', 'pipe:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', String(FPS * 2), '-b:v', '700k',
        '-f', 'rtsp', '-rtsp_transport', 'tcp', url,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    children.push(proc);
    proc.stdin?.on('error', () => {}); // ffmpeg ferme : on relancera
    proc.once('exit', () => {
      proc = null;
      if (!shuttingDown) setTimeout(launch, 2000);
    });
  };
  launch();
  setInterval(() => {
    const stdin = proc?.stdin;
    if (stdin?.writable && !stdin.writableNeedDrain) stdin.write(scene.render(Date.now()));
  }, 1000 / FPS);
}
for (const camera of DEMO_CAMERAS) startCamera(camera.id, camera.zone);

// ---------------------------------------------------------------- 5. configuration du PSIM

async function adminSession(): Promise<string> {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: config.adminPassword }),
  });
  if (!res.ok) fail(`connexion admin impossible (${res.status})`);
  return (res.headers.getSetCookie()[0] ?? '').split(';')[0];
}

const cookie = await adminSession();
const call = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...init.headers } });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
};

console.log('\nConfiguration des cameras dans le PSIM ...');
for (const camera of DEMO_CAMERAS) {
  const onvifPort = onvifPorts.get(camera.id);
  const source = onvifPort
    ? { kind: 'onvif', host: '127.0.0.1', port: onvifPort, username: viewerUser, password: viewerPass }
    : { kind: 'rtsp', host: '127.0.0.1', port: RTSP_PORT, rtspPath: `/${camera.id}`, username: viewerUser, password: viewerPass };
  const r = await call(`/api/cameras/${camera.id}/source`, { method: 'PUT', body: JSON.stringify(source) });
  if (!r.ok) fail(`configuration de ${camera.id} refusee : ${JSON.stringify(r.body)}`);
}

// Les cameras publient depuis quelques secondes : on laisse le temps aux premiers flux d'arriver.
let allOk = true;
for (const camera of DEMO_CAMERAS) {
  let ok = false;
  let message = '';
  for (let attempt = 0; attempt < 6 && !ok; attempt++) {
    const r = await call(`/api/cameras/${camera.id}/test`, { method: 'POST' });
    ok = r.ok;
    message = r.ok ? r.body?.message : (r.body?.error ?? `HTTP ${r.status}`);
    if (!ok) await new Promise((res) => setTimeout(res, 2000));
  }
  allOk &&= ok;
  const via = onvifPorts.has(camera.id) ? 'ONVIF' : 'RTSP ';
  console.log(`  ${ok ? 'OK ' : 'ECHEC'} ${camera.id} (${camera.zone}) [${via}] : ${message}`);
}
if (!allOk) fail('toutes les cameras ne repondent pas : voir ci-dessus.');

if (discoveryResponding) {
  const found = await call('/api/onvif/discover');
  const n = Array.isArray(found.body) ? found.body.length : 0;
  console.log(
    n > 0
      ? `  OK  Recherche reseau ONVIF : ${n} camera(s) trouvee(s)`
      : '  --  Recherche reseau ONVIF : aucune reponse (multidiffusion bloquee sur ce poste ? la saisie manuelle reste possible)',
  );
}

// ---------------------------------------------------------------- 6. detecteurs (MQTT) et scenarios

const client = await mqtt.connectAsync(`mqtt://127.0.0.1:${MQTT_PORT}`, { username: config.mqttUser, password: config.mqttPassword });
const runner = createRunner({
  publish: (id, state) => client.publishAsync(`psim/detectors/${id}/state`, JSON.stringify({ state, ts: Date.now() }), { qos: 1 }).then(() => undefined),
  publishMessage: (id, message) => client.publishAsync(`psim/detectors/${id}/state`, JSON.stringify({ ...message, ts: Date.now() }), { qos: 1 }).then(() => undefined),
  setFire,
  log,
  speed,
});
// Les boutons du simulateur de l'interface publient sur le meme broker : le signal de vie en tient compte.
await client.subscribeAsync('psim/detectors/+/state');
client.on('message', (topic, payload) => {
  const id = topic.split('/')[2];
  try {
    runner.observe(id, JSON.parse(payload.toString('utf8')));
  } catch {
    // message illisible : ignore
  }
});
runner.reset(true);
runner.startHeartbeat(DEMO_HEARTBEAT_S);

console.log(`
============================================================
 Demonstration prete

 Interface PSIM  : ${base}
                   (cliquer sur "Administrateur" ou "Operateur" pour remplir la connexion)
 Cameras RTSP    : rtsp://127.0.0.1:${RTSP_PORT}/C-01 ... C-05
${useOnvif ? ` Faux ONVIF      : 127.0.0.1 ports ${ONVIF_BASE_PORT} a ${ONVIF_BASE_PORT + ONVIF_CAMERAS - 1} (C-01 a C-0${ONVIF_CAMERAS}) ; C-05 en RTSP direct\n` : ''} Identifiants    : ${viewerUser} / ${viewerPass}  (ONVIF et RTSP)
 Notifications   : faux courrier (port 2525) et faux Telegram (2526) : les messages s'affichent ici
                   niveau 1 : operateur@demo.test / chat 111 ; niveau 2 (escalade) : responsable@demo.test / chat 222
 Base de demo    : data-demo/ (recreee a chaque lancement)
============================================================`);

function printMenu(): void {
  console.log('\nScenarios :');
  SCENARIOS.forEach((s, i) => console.log(`  ${i + 1}. ${s.id.padEnd(22)} ${s.title}`));
  console.log('  r. reset (tout revient au calme)     a. mode automatique     q. quitter');
}

const wanted = flagValue('scenario');
if (wanted) {
  const scenario = findScenario(wanted);
  if (!scenario) fail(`scenario inconnu : ${wanted}`);
  runner.run(scenario);
}

const duration = Number(flagValue('duration') ?? 0);
if (duration > 0) setTimeout(() => shutdown(0), duration * 1000); // arret automatique (tests)

if (flag('auto')) {
  void runner.auto();
} else if (process.stdin.isTTY) {
  printMenu();
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\ndemo> ' });
  rl.prompt();
  rl.on('line', (line) => {
    const cmd = line.trim().toLowerCase();
    if (cmd === 'q' || cmd === 'quit') return void shutdown(0);
    if (cmd === 'r' || cmd === 'reset') runner.reset();
    else if (cmd === 'a' || cmd === 'auto') void runner.auto();
    else if (cmd === '' || cmd === 'm' || cmd === 'menu') printMenu();
    else {
      const scenario = findScenario(cmd);
      if (scenario) {
        runner.stopAuto();
        runner.run(scenario);
      } else console.log('Commande inconnue (taper m pour le menu).');
    }
    rl.prompt();
  });
  rl.on('close', () => shutdown(0));
} else {
  console.log('\n(terminal non interactif : Ctrl+C pour arreter ; utiliser --auto ou --scenario=<id>)');
}

