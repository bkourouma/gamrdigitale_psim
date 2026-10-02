import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { createApp, sessionFromRequest } from './api.ts';
import { config, usesDevDefaults } from './config.ts';
import { openDb } from './db.ts';
import { createEngine } from './engine.ts';
import { startBroker } from './mqtt.ts';
import { loadSecretKey } from './secrets.ts';
import { seedDemo, seedUsers } from './seed.ts';
import type { PsimEvent } from './types.ts';
import { createVideoService } from './video.ts';

const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(root, config.dataDir);
mkdirSync(dataDir, { recursive: true });

const db = openDb(join(dataDir, 'psim.db'));
if (seedDemo(db, dataDir, join(root, 'seed'))) console.log('[seed] site de demonstration cree');
seedUsers(db, config.adminPassword, config.operatorPassword);

const bus = new EventEmitter();
const publish = (event: PsimEvent) => bus.emit('event', event);
const engine = createEngine(db, publish, Date.now, { silentTimeoutMs: config.detectorTimeoutS * 1000 });
const video = createVideoService({
  db,
  engine,
  key: loadSecretKey(dataDir, config.secretKey),
  publish,
  ffmpegPath: config.ffmpegPath,
});

const broker = await startBroker(engine, {
  host: config.host,
  port: config.mqttPort,
  user: config.mqttUser,
  password: config.mqttPassword,
});

const app = createApp({
  db,
  engine,
  video,
  dataDir,
  webDir: join(root, 'web'),
  cookieSecure: config.cookieSecure,
  simEnabled: config.simEnabled,
  demoAccounts: config.demoLogin
    ? [
        { username: 'admin', label: 'Administrateur', password: config.adminPassword },
        { username: 'operateur', label: 'Opérateur', password: config.operatorPassword },
      ]
    : null,
  triggerSim: (id, state) => broker.publishDetectorState(id, state),
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  // Cookie de session obligatoire + meme origine (empeche le detournement depuis un autre site).
  const origin = req.headers.origin;
  const sameOrigin = !origin || new URL(origin).host === req.headers.host;
  if (url.pathname !== '/ws' || !sameOrigin || !sessionFromRequest(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return void socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(JSON.stringify({ type: 'snapshot', ...engine.getSnapshot() }));
  });
});

bus.on('event', (event: PsimEvent) => {
  const message = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
});

// Surveillance des detecteurs muets : controle regulier, plusieurs fois par delai.
const silentTimer =
  config.detectorTimeoutS > 0
    ? setInterval(() => engine.checkSilentDetectors(), Math.min(5000, Math.max(500, (config.detectorTimeoutS * 1000) / 4)))
    : null;

server.listen(config.port, config.host, () => {
  console.log(`[psim] interface  : http://${config.host}:${config.port}`);
  console.log(`[psim] broker MQTT: mqtt://${config.host}:${config.mqttPort}  (topic psim/detectors/<id>/state)`);
  console.log(
    config.detectorTimeoutS > 0
      ? `[psim] detecteurs muets : declares hors ligne apres ${config.detectorTimeoutS} s sans message`
      : '[psim] detecteurs muets : surveillance desactivee (PSIM_DETECTOR_TIMEOUT_S=0, ou mode simulateur)',
  );
  if (config.demoLogin) {
    console.warn('[psim] Mode demo : les comptes sont cliquables sur la page de connexion (poste local uniquement).');
  }
  if (usesDevDefaults()) {
    console.warn('[psim] ATTENTION : mots de passe de developpement par defaut. Copier .env.example en .env et les changer.');
  }
});

async function shutdown() {
  if (silentTimer) clearInterval(silentTimer);
  video.shutdown();
  wss.close();
  server.close();
  await broker.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
