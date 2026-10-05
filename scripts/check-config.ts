/**
 * Verifie la configuration (.env) SANS demarrer le PSIM :
 *
 *   npm run check-config
 *   PSIM_ENV=production npm run check-config     (verdict tel qu'en production)
 *
 * Code de sortie 1 s'il y a une erreur bloquante (en production, le PSIM refuserait de demarrer).
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { channelSetup, config, serviceUrls } from '../server/config.ts';
import { formatFindings, preflight } from '../server/preflight.ts';

const n = config.notify;
// Destinataires saisis dans l'interface (base) : lus s'ils existent, en lecture seule, sans rien creer ni migrer.
const dbRecipients = new Map<string, number>();
const dbFile = join(resolve(import.meta.dirname, '..', config.dataDir), 'psim.db');
if (existsSync(dbFile)) {
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    for (const r of db.prepare('SELECT channel, level, COUNT(*) AS n FROM notification_recipient WHERE active = 1 GROUP BY channel, level').all() as { channel: string; level: number; n: number }[]) {
      dbRecipients.set(`${r.channel}:${r.level}`, r.n);
    }
    db.close();
  } catch {
    // base absente, ancienne ou verrouillee : on s'en tient au .env
  }
}
type ChannelKey = 'email' | 'telegram' | 'whatsapp' | 'callmebot' | 'webhook';
const count = (channel: ChannelKey, level: 1 | 2) => (n.recipients[channel][level - 1]?.length ?? 0) + (dbRecipients.get(`${channel}:${level}`) ?? 0);
const setup = channelSetup(n);
const channels = ([...setup.map((c) => [c.id, c.configured] as const), ['callmebot', true] as const, ['webhook', true] as const] as (readonly [ChannelKey, boolean])[]).filter(
  ([channel, configured]) => configured && count(channel, 1) + count(channel, 2) > 0,
);
const tlsEnabled = Boolean(config.tls.cert && config.tls.key);

const findings = preflight({
  production: config.production,
  host: config.host,
  mqttHost: config.mqttHost,
  tlsEnabled,
  mqttTlsEnabled: Boolean(config.mqttTls.cert && config.mqttTls.key),
  trustProxy: config.trustProxy,
  cookieSecure: config.cookieSecure || tlsEnabled,
  simEnabled: config.simEnabled,
  demoLogin: config.demoLogin,
  adminPassword: config.adminPassword,
  operatorPassword: config.operatorPassword,
  mqttPassword: config.mqttPassword,
  notificationChannels: channels.length,
  escalationConfigured: channels.some(([channel]) => count(channel, 2) > 0),
  detectorTimeoutS: config.detectorTimeoutS,
  backupEveryH: config.backup.everyH,
  requireTotp: config.requireTotp,
  ingestToken: config.ingestToken,
  heartbeatUrl: config.heartbeatUrl,
  portal: config.portal,
  mqttAllowPlaintext: config.mqttAllowPlaintext,
  smtpHost: config.notify.smtp.host,
  smtpStarttls: config.notify.smtp.starttls,
  serviceUrls: serviceUrls(n),
  orphanRecipients: setup.filter((c) => !c.configured && count(c.id, 1) + count(c.id, 2) > 0).map((c) => c.label),
});

console.log(`Mode : ${config.production ? 'PRODUCTION' : 'developpement'} (PSIM_ENV=production pour le verdict de production)`);
if (findings.length === 0) console.log('Aucun probleme releve.');
else console.log(formatFindings(findings));
const blocking = findings.filter((f) => f.level === 'error').length;
if (blocking > 0) console.log(`\n${blocking} erreur(s) bloquante(s)${config.production || findings.some((f) => f.always) ? " : le PSIM refuserait de demarrer." : "."}`);
process.exit(blocking > 0 ? 1 : 0);
