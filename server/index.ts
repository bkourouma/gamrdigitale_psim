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
import { createNotifier, emailChannel, telegramChannel, webhookChannel } from './notifications.ts';
import type { Notifier } from './notifications.ts';
import { createSnapshotService } from './snapshots.ts';
import type { SnapshotService } from './snapshots.ts';
import { createVideoService } from './video.ts';

const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(root, config.dataDir);
mkdirSync(dataDir, { recursive: true });

const db = openDb(join(dataDir, 'psim.db'));
if (seedDemo(db, dataDir, join(root, 'seed'))) console.log('[seed] site de demonstration cree');
seedUsers(db, config.adminPassword, config.operatorPassword);

const bus = new EventEmitter();
const publish = (event: PsimEvent) => bus.emit('event', event);
const engine = createEngine(db, publish, Date.now, {
  silentTimeoutMs: config.detectorTimeoutS * 1000,
  confirmWindowMs: config.confirmWindowS * 1000,
  persistMs: config.confirmPersistS * 1000,
  hintMs: config.falseAlarmHintS * 1000,
  // Image des cameras liees a chaque etape d'un incident, en tache de fond : l'alarme est deja publiee.
  // Sur chaque etape d'un incident : le texte part tout de suite, les images en complement des qu'elles
  // sont prises. Tout en tache de fond : rien ne retarde ni ne fait echouer l'alarme.
  onIncidentEvent: (incident, kind) => {
    void notifier?.notifyIncident(incident, kind);
    void snapshots?.capture(incident, kind).then((saved) => (saved > 0 ? notifier?.sendImages(incident.id, kind) : undefined));
  },
  onDetectorSilent: (device) => void notifier?.notifySilent(device),
});
let snapshots: SnapshotService | undefined;
let notifier: Notifier | undefined;
const video = createVideoService({
  db,
  engine,
  key: loadSecretKey(dataDir, config.secretKey),
  publish,
  ffmpegPath: config.ffmpegPath,
});

snapshots = createSnapshotService({
  db,
  engine,
  dataDir,
  grab: (cameraId) => video.snapshot(cameraId),
  publishIncident: (id) => publish({ type: 'incident', incident: engine.incidentView(id) }),
});
const notify = config.notify;
notifier = createNotifier({
  db,
  engine,
  channels: [
    emailChannel({ ...notify.smtp }, notify.recipients.email),
    telegramChannel({ token: notify.telegram.token, apiBase: notify.telegram.apiBase }, notify.recipients.telegram),
    webhookChannel({ secret: notify.webhookSecret }, notify.recipients.webhook),
  ].filter((c) => c !== null),
  escalateAfterMs: notify.escalateAfterS * 1000,
  reminderMs: notify.reminderS * 1000,
  maxReminders: notify.maxReminders,
  publicUrl: notify.publicUrl,
  readSnapshot: (id) => snapshots?.read(id) ?? null,
  secrets: [notify.smtp.password, notify.telegram.token, notify.webhookSecret],
});
const purged = snapshots.purge(config.snapshotDays);
if (purged > 0) console.log(`[psim] ${purged} image(s) d'incident de plus de ${config.snapshotDays} jours supprimee(s)`);
const purgeTimer = setInterval(() => snapshots?.purge(config.snapshotDays), 6 * 3600 * 1000);

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
  snapshots,
  notifier,
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

// Controle periodique : detecteurs muets et confirmation des incidents par persistance.
const tickTimer = setInterval(() => {
  engine.tick();
  notifier?.tick(); // escalade des incidents non acquittes
}, 1000);

server.listen(config.port, config.host, () => {
  console.log(`[psim] interface  : http://${config.host}:${config.port}`);
  console.log(`[psim] broker MQTT: mqtt://${config.host}:${config.mqttPort}  (topic psim/detectors/<id>/state)`);
  console.log(
    config.detectorTimeoutS > 0
      ? `[psim] detecteurs muets : declares hors ligne apres ${config.detectorTimeoutS} s sans message`
      : '[psim] detecteurs muets : surveillance desactivee (PSIM_DETECTOR_TIMEOUT_S=0, ou mode simulateur)',
  );
  {
    const status = notifier!.status();
    const channelsText = status.channels.map((c) => `${c.label} (${c.level1} niveau 1, ${c.level2} niveau 2)`).join(', ');
    console.log(
      status.channels.length > 0
        ? `[psim] notifications : ${channelsText} ; escalade ${config.notify.escalateAfterS > 0 ? `apres ${config.notify.escalateAfterS} s sans acquittement` : 'desactivee'}`
        : '[psim] notifications : aucun canal configure (voir .env.example) : les alarmes ne previennent personne hors de cet ecran',
    );
  }
  console.log(
    `[psim] regles anti-fausses alarmes : confirmation par voisin ${config.confirmWindowS > 0 ? `${config.confirmWindowS} s` : 'off'}, ` +
      `par persistance ${config.confirmPersistS > 0 ? `${config.confirmPersistS} s` : 'off'}, ` +
      `indice fausse alarme ${config.falseAlarmHintS > 0 ? `< ${config.falseAlarmHintS} s` : 'off'} (qualification seule : aucune alarme n'est retardee ni masquee)`,
  );
  if (config.demoLogin) {
    console.warn('[psim] Mode demo : les comptes sont cliquables sur la page de connexion (poste local uniquement).');
  }
  if (usesDevDefaults()) {
    console.warn('[psim] ATTENTION : mots de passe de developpement par defaut. Copier .env.example en .env et les changer.');
  }
});

async function shutdown() {
  clearInterval(tickTimer);
  clearInterval(purgeTimer);
  video.shutdown();
  wss.close();
  server.close();
  await broker.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
