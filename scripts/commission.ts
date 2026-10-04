/**
 * Mise en service : verifie l'installation reelle et fait la recette des equipements.
 *
 *   npm run commission                       controles d'environnement (heure, certificat, ffmpeg, SMTP, Telegram,
 *                                            webhooks, supervision externe, disque, sauvegardes, cameras, inventaire, journal)
 *   npm run commission -- --send-mail moi@exemple.fr    + envoie un message de test par e-mail
 *   npm run commission -- --telegram-chat 123456       + envoie un message de test Telegram
 *   npm run commission -- --whatsapp-to +2250700000000 + envoie un message de test WhatsApp (Meta) a ce numero
 *   npm run commission -- --callmebot-test             + envoie un message de test CallMeBot au niveau 1
 *   npm run commission -- --skip-cameras                ne teste pas les cameras (plus rapide)
 *   npm run commission -- watch              ecoute les detecteurs : montre ce que le PSIM comprend de chaque message
 *        options : --minutes 10 (duree)  --until-all (s'arrete quand tous ont parle)  --allow-missing
 *   npm run commission -- sheet --out recette.html     fiche de recette imprimable (une ligne par equipement)
 *
 * Aucune commande n'envoie d'alerte reelle ni ne modifie les donnees du PSIM (lecture seule de la base). Les messages de
 * test ne partent que sur demande explicite. Code de sortie 1 s'il y a au moins un echec.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  checkBackups, checkCameras, checkClock, checkDisk, checkFfmpeg, checkHeartbeat, checkInventory, checkJournal, checkCallmebot, checkSmtp, checkTelegram, checkTls, checkWebhooks, checkWhatsapp, exitCodeFor, formatChecks, safely, schemaProblem,
} from './commission/checks.ts';
import type { Check } from './commission/checks.ts';
import { buildSheet } from './commission/sheet.ts';
import type { SheetDevice } from './commission/sheet.ts';
import { createWatcher, formatSummary } from './commission/watch.ts';
import type { WatchDevice } from './commission/watch.ts';

type Row = Record<string, unknown>;

const root = resolve(import.meta.dirname, '..');

function openReadOnly(dataDir: string): DatabaseSync | null {
  const file = join(dataDir, 'psim.db');
  if (!existsSync(file)) return null;
  return new DatabaseSync(file, { readOnly: true });
}

const optionValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

async function runChecks(args: string[]): Promise<number> {
  const { config } = await import('../server/config.ts');
  const { preflight } = await import('../server/preflight.ts');
  const dataDir = resolve(root, config.dataDir);
  const n = config.notify;
  const checks: Check[] = [];

  console.log(`Mise en service - ${config.production ? 'PRODUCTION' : 'hors production'} - donnees : ${dataDir}\n`);

  // Configuration (le meme verdict que `npm run check-config`)
  const findings = preflight({
    production: config.production, host: config.host, mqttHost: config.mqttHost,
    tlsEnabled: Boolean(config.tls.cert && config.tls.key), mqttTlsEnabled: Boolean(config.mqttTls.cert && config.mqttTls.key),
    trustProxy: config.trustProxy, cookieSecure: config.production, simEnabled: config.simEnabled, demoLogin: config.demoLogin,
    adminPassword: config.adminPassword, operatorPassword: config.operatorPassword, mqttPassword: config.mqttPassword,
    notificationChannels: 1, escalationConfigured: true, detectorTimeoutS: config.detectorTimeoutS, backupEveryH: config.backup.everyH,
    requireTotp: config.requireTotp, ingestToken: config.ingestToken, heartbeatUrl: config.heartbeatUrl,
  });
  const errors = findings.filter((f) => f.level === 'error');
  checks.push({
    id: 'config', title: 'Configuration (.env)', status: errors.length ? 'fail' : findings.length ? 'warn' : 'ok',
    detail: findings.length ? findings.map((f) => f.message).join(' | ') : 'aucun probleme releve', fix: findings.length ? 'Voir `npm run check-config` et .env.example.' : undefined,
  });

  checks.push(await safely('clock', 'Heure du serveur', () => checkClock({ referenceUrl: config.heartbeatUrl || undefined })));
  checks.push(await safely('tls', 'Certificat HTTPS', () => checkTls(config.tls)));
  checks.push(await safely('ffmpeg', 'ffmpeg', () => checkFfmpeg(config.ffmpegPath)));
  checks.push(await safely('smtp', 'E-mail (SMTP)', () => checkSmtp(n.smtp, optionValue(args, '--send-mail'))));
  checks.push(await safely('telegram', 'Telegram', () => checkTelegram(n.telegram, optionValue(args, '--telegram-chat'))));
  // Destinataires WhatsApp saisis dans l'interface (base, lecture seule) : comptes avec ceux du .env.
  const recipientsDb = openReadOnly(dataDir);
  let whatsappInDb = 0;
  try {
    whatsappInDb = recipientsDb ? (recipientsDb.prepare("SELECT COUNT(*) AS n FROM notification_recipient WHERE channel = 'whatsapp' AND active = 1").get() as { n: number }).n : 0;
  } catch {
    // base ancienne : pas encore de destinataire WhatsApp possible
  } finally {
    recipientsDb?.close();
  }
  checks.push(await safely('whatsapp', 'WhatsApp', () => checkWhatsapp(n.whatsapp, n.recipients.whatsapp, { to: optionValue(args, '--whatsapp-to'), dbRecipients: whatsappInDb })));
  checks.push(await safely('callmebot', 'WhatsApp (CallMeBot)', () => checkCallmebot(n.callmebot, n.recipients.callmebot, args.includes('--callmebot-test'))));
  checks.push(await safely('heartbeat', 'Supervision externe', () => checkHeartbeat(config.heartbeatUrl)));

  let db = openReadOnly(dataDir);
  const outdated = db ? schemaProblem(db) : null;
  if (db && outdated) {
    db.close();
    db = null;
  }
  const webhooks = [...(n.recipients.webhook[0] ?? []), ...(n.recipients.webhook[1] ?? [])];
  if (db) {
    for (const r of db.prepare("SELECT address FROM notification_recipient WHERE channel = 'webhook' AND active = 1").all() as Row[]) webhooks.push(r.address as string);
  }
  checks.push(await safely('webhook', 'Webhooks', () => checkWebhooks([...new Set(webhooks)])));
  checks.push(await safely('disk', 'Disque', () => checkDisk(dataDir)));
  checks.push(await safely('backup', 'Sauvegardes', () => checkBackups(resolve(root, config.backup.dir || 'backups'), config.backup.everyH, Date.now(), config.production)));

  if (!db) {
    checks.push(
      outdated
        ? { id: 'db', title: 'Base de donnees', status: 'fail', detail: `${outdated}`, fix: 'Demarrer le PSIM (version actuelle) une fois : il migre la base sans rien perdre. Puis relancer ce controle.' }
        : { id: 'db', title: 'Base de donnees', status: 'fail', detail: `aucune base dans ${dataDir}`, fix: 'Demarrer le PSIM une premiere fois pour creer la base, puis relancer ce controle.' },
    );
  } else {
    try {
      checks.push(...checkInventory(db));
      checks.push(checkJournal(db));
      if (!args.includes('--skip-cameras')) {
        let tester: Parameters<typeof checkCameras>[1] = null;
        if (config.secretKey || existsSync(join(dataDir, 'secret.key'))) {
          const { createEngine } = await import('../server/engine.ts');
          const { createVideoService } = await import('../server/video.ts');
          const { loadSecretKey } = await import('../server/secrets.ts');
          const engine = createEngine(db, () => {});
          tester = createVideoService({ db, engine, key: loadSecretKey(dataDir, config.secretKey), publish: () => {}, ffmpegPath: config.ffmpegPath });
        }
        console.log('Test des cameras (quelques secondes chacune)...');
        checks.push(...(await checkCameras(db, tester)));
      }
    } finally {
      db.close();
    }
  }

  console.log(formatChecks(checks));
  return exitCodeFor(checks);
}

function readDevices(dataDir: string): { detectors: WatchDevice[]; sheet: SheetDevice[]; site: string } | null {
  const db = openReadOnly(dataDir);
  if (!db) return null;
  try {
    const rows = db.prepare('SELECT * FROM device ORDER BY kind DESC, id').all() as Row[];
    const links = new Map<string, string[]>();
    for (const l of db.prepare('SELECT detector_id, camera_id FROM device_link ORDER BY camera_id').all() as Row[]) {
      links.set(l.detector_id as string, [...(links.get(l.detector_id as string) ?? []), l.camera_id as string]);
    }
    const sources = new Map((db.prepare('SELECT device_id, kind, host, port FROM camera_source').all() as Row[]).map((s) => [s.device_id as string, `${String(s.kind).toUpperCase()} ${s.host}:${s.port}`]));
    const site = (db.prepare('SELECT name FROM site WHERE id = 1').get() as { name: string } | undefined)?.name ?? 'Site';
    // Plusieurs etages : la recette verifie aussi le rattachement de chaque equipement a son etage (c'est lui qui dit ou aller).
    const floors = schemaProblem(db) ? [] : (db.prepare('SELECT id, name FROM floor ORDER BY position, id').all() as Row[]);
    const floorOf = (r: Row) => (floors.length > 1 ? ((floors.find((f) => f.id === r.floor_id) ?? floors[0]).name as string) : undefined);
    return {
      site,
      detectors: rows.filter((r) => r.kind === 'detector').map((r) => ({
        id: r.id as string, name: r.name as string, zone: r.zone as string, floor: floorOf(r), category: ((r.category as string) ?? 'fire') as WatchDevice['category'],
        warnAt: (r.warn_at as number | null) ?? null, alarmAt: (r.alarm_at as number | null) ?? null, direction: ((r.direction as string) ?? 'above') as WatchDevice['direction'], valueUnit: (r.value_unit as string | null) ?? null,
      })),
      sheet: rows.map((r) => ({
        id: r.id as string, kind: r.kind as 'detector' | 'camera', name: r.name as string, zone: r.zone as string, floor: floorOf(r), category: ((r.category as string) ?? 'fire') as SheetDevice['category'],
        source: r.kind === 'camera' ? (sources.get(r.id as string) ?? 'simulee') : undefined, links: links.get(r.id as string),
      })),
    };
  } finally {
    db.close();
  }
}

async function runWatch(args: string[]): Promise<number> {
  const { config } = await import('../server/config.ts');
  const { default: mqtt } = await import('mqtt');
  const data = readDevices(resolve(root, config.dataDir));
  if (!data) {
    console.error('Aucune base : demarrer le PSIM une premiere fois, declarer les detecteurs, puis relancer.');
    return 2;
  }
  const minutes = Number(optionValue(args, '--minutes') ?? 10);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 240) {
    console.error('--minutes : un nombre entre 1 et 240');
    return 2;
  }
  const watcher = createWatcher(data.detectors);
  const tls = Boolean(config.mqttTls.cert && config.mqttTls.key);
  const host = config.mqttHost === '0.0.0.0' ? '127.0.0.1' : config.mqttHost;
  const url = `${tls ? 'mqtts' : 'mqtt'}://${host}:${config.mqttPort}`;
  let client;
  try {
    client = await mqtt.connectAsync(url, { username: config.mqttUser, password: config.mqttPassword, connectTimeout: 8000, ...(tls ? { ca: readFileSync(config.mqttTls.cert), servername: host === '127.0.0.1' ? 'localhost' : host } : {}) });
  } catch (err) {
    console.error(`Connexion au broker impossible (${url}) : ${(err as Error).message}. Le PSIM est-il demarre ? Identifiant et mot de passe MQTT corrects ?`);
    return 2;
  }
  await client.subscribeAsync('psim/detectors/+/state');
  console.log(`Ecoute de ${url} pendant ${minutes} min (Ctrl+C pour arreter) : ${data.detectors.length} detecteur(s) attendu(s).`);
  console.log('Declenchez maintenant chaque detecteur (bouton test, ou en provoquant l\'alarme) :');
  for (const d of data.detectors) console.log(`  - ${d.id}  ${d.name}${d.zone ? ` (${d.zone})` : ''}`);
  console.log('\nATTENTION : le PSIM traite ces messages comme de vraies alarmes (incidents, alertes). Prevenez les destinataires, ou cloturez ensuite les incidents « fausse alarme : recette ».\n');

  const untilAll = args.includes('--until-all');
  const finished = new Promise<void>((resolveDone) => {
    const timer = setTimeout(resolveDone, minutes * 60_000);
    const stop = () => (clearTimeout(timer), resolveDone());
    process.once('SIGINT', stop);
    client.on('message', (topic, payload) => {
      const o = watcher.handle(topic, payload);
      if (!o) return;
      const tag = { ok: 'OK      ', invalid: 'ILLISIBLE', unknown: 'INCONNU ', ignored: 'IGNORE  ' }[o.verdict];
      console.log(`${new Date(o.at).toLocaleTimeString('fr-FR')}  ${tag} ${o.id}  ${o.text}`);
      if (untilAll && watcher.summary().allHeard) stop();
    });
  });
  await finished;
  await client.endAsync();
  const s = watcher.summary();
  console.log(`\n${formatSummary(s)}`);
  const bad = s.unknown.length > 0 || s.invalid.length > 0 || (s.missing.length > 0 && !args.includes('--allow-missing'));
  return bad ? 1 : 0;
}

async function runSheetWithConfig(args: string[]): Promise<number> {
  const { config } = await import('../server/config.ts');
  const data = readDevices(resolve(root, config.dataDir));
  if (!data) {
    console.error('Aucune base : demarrer le PSIM une premiere fois et declarer les equipements.');
    return 2;
  }
  return writeSheet(data, args);
}

function writeSheet(data: NonNullable<ReturnType<typeof readDevices>>, args: string[]): number {
  const html = buildSheet({ site: data.site, generatedAt: Date.now(), devices: data.sheet });
  const out = optionValue(args, '--out');
  if (out) {
    writeFileSync(out, html, 'utf8');
    console.log(`Fiche de recette ecrite dans ${out} (${data.sheet.length} equipement(s)) : l'ouvrir dans un navigateur, puis Imprimer ou Enregistrer au format PDF.`);
  } else {
    process.stdout.write(html);
  }
  return 0;
}

export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args[0] && !args[0].startsWith('--') ? args : ['check', ...args];
  switch (command) {
    case 'check':
      return runChecks(rest);
    case 'watch':
      return runWatch(rest);
    case 'sheet':
      return runSheetWithConfig(rest);
    default:
      console.error(`Commande inconnue « ${command} ». Usage : npm run commission [-- watch | sheet --out recette.html]`);
      return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main(process.argv.slice(2));
}
