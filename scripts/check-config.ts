/**
 * Verifie la configuration (.env) SANS demarrer le PSIM :
 *
 *   npm run check-config
 *   PSIM_ENV=production npm run check-config     (verdict tel qu'en production)
 *
 * Code de sortie 1 s'il y a une erreur bloquante (en production, le PSIM refuserait de demarrer).
 */
import { config } from '../server/config.ts';
import { emailChannel, telegramChannel, webhookChannel } from '../server/notifications.ts';
import { formatFindings, preflight } from '../server/preflight.ts';

const n = config.notify;
const channels = [
  emailChannel({ ...n.smtp }, n.recipients.email),
  telegramChannel({ token: n.telegram.token, apiBase: n.telegram.apiBase }, n.recipients.telegram),
  webhookChannel({ secret: n.webhookSecret }, n.recipients.webhook),
].filter((c) => c !== null);
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
  escalationConfigured: channels.some((c) => c.recipients(2).length > 0),
  detectorTimeoutS: config.detectorTimeoutS,
  backupEveryH: config.backup.everyH,
});

console.log(`Mode : ${config.production ? 'PRODUCTION' : 'developpement'} (PSIM_ENV=production pour le verdict de production)`);
if (findings.length === 0) console.log('Aucun probleme releve.');
else console.log(formatFindings(findings));
const blocking = findings.filter((f) => f.level === 'error').length;
if (blocking > 0) console.log(`\n${blocking} erreur(s) bloquante(s)${config.production ? " : le PSIM refuserait de demarrer." : "."}`);
process.exit(blocking > 0 ? 1 : 0);
