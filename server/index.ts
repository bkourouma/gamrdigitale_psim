import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { createApp, sessionFromRequest } from './api.ts';
import { createBackup, listBackups, pruneBackups } from './backup.ts';
import { config } from './config.ts';
import { openDb } from './db.ts';
import { createEngine } from './engine.ts';
import { acquireLock } from './lock.ts';
import { installFileLogger } from './logger.ts';
import { startBroker } from './mqtt.ts';
import { createNotifier, emailChannel, telegramChannel, webhookChannel } from './notifications.ts';
import type { Notifier } from './notifications.ts';
import { formatFindings, preflight } from './preflight.ts';
import { createRiskService } from './risk.ts';
import { loadSecretKey } from './secrets.ts';
import { seedDemo, seedUsers } from './seed.ts';
import { createSnapshotService } from './snapshots.ts';
import type { SnapshotService } from './snapshots.ts';
import { createSystemStatus } from './system.ts';
import type { BackupStatus } from './system.ts';
import { createHttpRedirect, createWebServer } from './tls.ts';
import type { PsimEvent } from './types.ts';
import { createVideoService } from './video.ts';

const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(root, config.dataDir);
mkdirSync(dataDir, { recursive: true });
const startedAt = Date.now();
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;

// En service (sans fenetre de terminal), tout ce que le PSIM dit doit aller dans un fichier.
if (config.logFile) installFileLogger({ dir: join(dataDir, 'logs') });

// Un etat incoherent vaut mieux arrete que boiteux : le superviseur (service, tache planifiee) relance.
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (err) => {
    console.error(`[psim] ERREUR FATALE (${event}) :`, err);
    setTimeout(() => process.exit(1), 200);
  });
}

// ---------------------------------------------------------------- notifications (construites tot : le controle de demarrage les compte)

const notify = config.notify;
const channels = [
  emailChannel({ ...notify.smtp }, notify.recipients.email),
  telegramChannel({ token: notify.telegram.token, apiBase: notify.telegram.apiBase }, notify.recipients.telegram),
  webhookChannel({ secret: notify.webhookSecret }, notify.recipients.webhook),
].filter((c) => c !== null);

const tlsFiles = config.tls.cert && config.tls.key ? { cert: config.tls.cert, key: config.tls.key } : null;
const mqttTlsFiles = config.mqttTls.cert && config.mqttTls.key ? { cert: config.mqttTls.cert, key: config.mqttTls.key } : null;
const cookieSecure = config.cookieSecure || tlsFiles !== null;

// ---------------------------------------------------------------- controle de demarrage

const findings = preflight({
  production: config.production,
  host: config.host,
  mqttHost: config.mqttHost,
  tlsEnabled: tlsFiles !== null,
  mqttTlsEnabled: mqttTlsFiles !== null,
  trustProxy: config.trustProxy,
  cookieSecure,
  simEnabled: config.simEnabled,
  demoLogin: config.demoLogin,
  adminPassword: config.adminPassword,
  operatorPassword: config.operatorPassword,
  mqttPassword: config.mqttPassword,
  notificationChannels: channels.length,
  escalationConfigured: channels.some((c) => c.recipients(2).length > 0),
  detectorTimeoutS: config.detectorTimeoutS,
  backupEveryH: config.backup.everyH,
});
if (findings.length > 0) {
  const fatal = config.production && findings.some((f) => f.level === 'error');
  console[fatal ? 'error' : 'warn'](`[psim] controle de demarrage${config.production ? ' (production)' : ''} :\n${formatFindings(findings)}`);
  if (fatal) {
    console.error('[psim] Demarrage refuse : corrigez les erreurs ci-dessus (voir .env.example et README, « Mise en production »).');
    process.exit(1);
  }
}

let releaseLock: () => void;
try {
  releaseLock = acquireLock(dataDir);
} catch (err) {
  console.error(`[psim] ${(err as Error).message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- donnees et services

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
notifier = createNotifier({
  db,
  engine,
  channels,
  escalateAfterMs: notify.escalateAfterS * 1000,
  reminderMs: notify.reminderS * 1000,
  maxReminders: notify.maxReminders,
  publicUrl: notify.publicUrl,
  readSnapshot: (id) => snapshots?.read(id) ?? null,
  secrets: [notify.smtp.password, notify.telegram.token, notify.webhookSecret],
});
const risk = createRiskService(db, engine, { fireWindowDays: config.riskFireWindowDays, staleMonths: config.riskStaleMonths });
risk.recordHistory(); // un point par jour pour les tendances (une seule ecriture par jour)
const riskTimer = setInterval(() => risk.recordHistory(), 10 * 60 * 1000);
const purged = snapshots.purge(config.snapshotDays);
if (purged > 0) console.log(`[psim] ${purged} image(s) d'incident de plus de ${config.snapshotDays} jours supprimee(s)`);
const purgeTimer = setInterval(() => snapshots?.purge(config.snapshotDays), 6 * 3600 * 1000);

// ---------------------------------------------------------------- sauvegarde automatique

const backupDir = resolve(root, config.backup.dir || 'backups');
const latest = listBackups(backupDir)[0];
let lastBackup: BackupStatus = latest
  ? { at: latest.createdAt, ok: true, name: latest.name, bytes: latest.bytes, error: null }
  : { at: null, ok: null, name: null, bytes: null, error: null };

function runBackup(): void {
  try {
    const result = createBackup({ db, dataDir, backupDir });
    const removed = pruneBackups(backupDir, config.backup.keep);
    lastBackup = { at: Date.now(), ok: true, name: result.name, bytes: result.bytes, error: null };
    console.log(`[psim] sauvegarde ${result.name} (${(result.bytes / 1024 / 1024).toFixed(1)} Mo, ${result.files} fichiers)${removed.length ? `, ${removed.length} ancienne(s) supprimee(s)` : ''}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastBackup = { at: lastBackup.at, ok: false, name: lastBackup.name, bytes: lastBackup.bytes, error: message };
    console.error(`[psim] SAUVEGARDE EN ECHEC : ${message}`);
    engine.audit('systeme', 'backup_failed', { details: message.slice(0, 200) });
  }
}

const backupEveryMs = config.backup.everyH * 3_600_000;
const backupTimer =
  backupEveryMs > 0
    ? setInterval(() => {
        if (lastBackup.at === null || Date.now() - lastBackup.at >= backupEveryMs || lastBackup.ok === false) runBackup();
      }, 10 * 60 * 1000)
    : null;
// Premiere sauvegarde peu apres le demarrage si la derniere est trop ancienne (ou absente).
if (backupEveryMs > 0 && (lastBackup.at === null || Date.now() - lastBackup.at >= backupEveryMs)) setTimeout(runBackup, 30_000);

// ---------------------------------------------------------------- broker, web

let lastTickAt = Date.now();
const broker = await startBroker(engine, {
  host: config.mqttHost,
  port: config.mqttPort,
  user: config.mqttUser,
  password: config.mqttPassword,
  tls: mqttTlsFiles,
}).catch((err) => {
  console.error(`[psim] broker MQTT impossible a demarrer (${config.mqttHost}:${config.mqttPort}) : ${err.message}`);
  releaseLock();
  process.exit(1);
});

const system = createSystemStatus({
  db,
  dataDir,
  version,
  startedAt,
  lastTickAt: () => lastTickAt,
  brokerClients: () => broker.clients(),
  snapshotsBytes: () => snapshots?.sizeOnDisk() ?? 0,
  notificationChannels: () => {
    const s = notifier!.status();
    return { channels: s.channels.length, failedLast24h: s.failedLast24h, sentLast24h: s.sentLast24h };
  },
  backup: { everyH: config.backup.everyH, dir: backupDir, last: () => lastBackup, count: () => listBackups(backupDir).length },
});

const app = createApp({
  db,
  engine,
  video,
  snapshots,
  notifier,
  risk,
  tls: tlsFiles !== null,
  trustProxy: config.trustProxy,
  health: () => system.health(),
  system: () => system.detail(),
  backupNow: () => {
    runBackup();
    return lastBackup;
  },
  dataDir,
  webDir: join(root, 'web'),
  cookieSecure,
  simEnabled: config.simEnabled,
  demoAccounts: config.demoLogin
    ? [
        { username: 'admin', label: 'Administrateur', password: config.adminPassword },
        { username: 'operateur', label: 'Opérateur', password: config.operatorPassword },
      ]
    : null,
  triggerSim: (id, state) => broker.publishDetectorState(id, state),
});

const server: Server = createWebServer(app, tlsFiles);
const redirect = tlsFiles && config.httpRedirectPort > 0 ? createHttpRedirect(config.port, config.host) : null;
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

// Controle periodique : detecteurs muets, confirmation par persistance, escalade des incidents non acquittes.
const tickTimer = setInterval(() => {
  lastTickAt = Date.now();
  engine.tick();
  notifier?.tick();
}, 1000);

server.once('error', (err: NodeJS.ErrnoException) => {
  console.error(`[psim] interface impossible a demarrer (${config.host}:${config.port}) : ${err.code === 'EADDRINUSE' ? 'port deja utilise' : err.message}`);
  releaseLock();
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const scheme = tlsFiles ? 'https' : 'http';
  console.log(`[psim] PSIM ${version}${config.production ? ' (production)' : ''}`);
  console.log(`[psim] interface  : ${scheme}://${config.host}:${config.port}`);
  console.log(`[psim] broker MQTT: ${mqttTlsFiles ? 'mqtts' : 'mqtt'}://${config.mqttHost}:${config.mqttPort}  (topic psim/detectors/<id>/state)`);
  console.log(`[psim] sante      : ${scheme}://${config.host}:${config.port}/healthz`);
  if (redirect) redirect.listen(config.httpRedirectPort, config.host, () => console.log(`[psim] redirection HTTP -> HTTPS sur le port ${config.httpRedirectPort}`));
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
  console.log(
    backupEveryMs > 0
      ? `[psim] sauvegarde automatique : toutes les ${config.backup.everyH} h dans ${backupDir} (${config.backup.keep} conservees)`
      : '[psim] sauvegarde automatique : desactivee (npm run backup)',
  );
  if (config.demoLogin) {
    console.warn('[psim] Mode demo : les comptes sont cliquables sur la page de connexion (poste local uniquement).');
  }
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(tickTimer);
  clearInterval(purgeTimer);
  clearInterval(riskTimer);
  if (backupTimer) clearInterval(backupTimer);
  video.shutdown();
  wss.close();
  server.close();
  redirect?.close();
  await broker.close();
  db.close();
  releaseLock();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => releaseLock());
