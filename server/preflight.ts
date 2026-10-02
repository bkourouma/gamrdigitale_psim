/**
 * Controle de demarrage. En production (PSIM_ENV=production), le PSIM REFUSE de demarrer si un
 * point « erreur » est releve : mieux vaut un arret franc qu'un systeme de securite expose avec
 * des mots de passe de demonstration ou des identifiants qui circulent en clair.
 * Hors production, les memes constats sont affiches comme avertissements.
 */

export const DEV_PASSWORDS = ['admin-dev-only', 'operator-dev-only', 'psim-dev-only'];
export const MIN_PASSWORD_LENGTH = 12;

export interface Finding {
  level: 'error' | 'warn';
  message: string;
}

export interface PreflightInput {
  production: boolean;
  host: string;
  mqttHost: string;
  tlsEnabled: boolean;
  mqttTlsEnabled: boolean;
  trustProxy: boolean;
  cookieSecure: boolean;
  simEnabled: boolean;
  demoLogin: boolean;
  adminPassword: string;
  operatorPassword: string;
  mqttPassword: string;
  /** Nombre de canaux de notification configures, et ceux qui ont un destinataire de niveau 2. */
  notificationChannels: number;
  escalationConfigured: boolean;
  detectorTimeoutS: number;
  backupEveryH: number;
}

const isLoopback = (host: string) => ['127.0.0.1', 'localhost', '::1'].includes(host);

export function preflight(c: PreflightInput): Finding[] {
  const out: Finding[] = [];
  const add = (level: Finding['level'], message: string) => out.push({ level, message });
  // Ce qui est une erreur en production n'est qu'un avertissement ailleurs.
  const strict: Finding['level'] = c.production ? 'error' : 'warn';

  for (const [name, value] of [
    ['administrateur', c.adminPassword],
    ['operateur', c.operatorPassword],
    ['MQTT', c.mqttPassword],
  ] as const) {
    if (DEV_PASSWORDS.includes(value)) add(strict, `Mot de passe ${name} : valeur de demonstration publique (changez-la dans .env).`);
    else if (value.length < MIN_PASSWORD_LENGTH) add(strict, `Mot de passe ${name} trop court (${MIN_PASSWORD_LENGTH} caracteres minimum).`);
  }
  if (c.adminPassword === c.operatorPassword) add(strict, "Les mots de passe administrateur et operateur sont identiques.");

  if (c.simEnabled) add(strict, 'Le simulateur est actif (PSIM_SIM_ENABLED) : il permet de declencher de fausses alarmes. Mettre 0 en production.');
  if (c.demoLogin) add(strict, 'Les comptes cliquables de la page de connexion sont actifs (PSIM_DEMO_LOGIN) : les mots de passe seraient lisibles depuis le navigateur.');

  const webExposed = !isLoopback(c.host);
  if (webExposed && !c.tlsEnabled && !c.trustProxy) {
    add(strict, `L'interface ecoute sur ${c.host} sans HTTPS : identifiants et sessions circuleraient en clair. Configurez PSIM_TLS_CERT/PSIM_TLS_KEY, ou placez un proxy HTTPS devant (PSIM_TRUST_PROXY=1).`);
  }
  if (c.production && (c.tlsEnabled || c.trustProxy) && !c.cookieSecure && !c.tlsEnabled) {
    add('warn', 'Derriere un proxy HTTPS, definissez PSIM_COOKIE_SECURE=1 pour que le cookie de session ne circule qu\'en HTTPS.');
  }
  if (!isLoopback(c.mqttHost) && !c.mqttTlsEnabled) {
    add('warn', `Le broker MQTT ecoute sur ${c.mqttHost} sans TLS : le mot de passe MQTT circule en clair sur le reseau. Preferer PSIM_MQTT_TLS_CERT/KEY, ou un reseau dedie aux detecteurs.`);
  }

  if (c.notificationChannels === 0) add('warn', "Aucun canal de notification : une alarme ne previent personne en dehors de l'ecran du PSIM.");
  else if (!c.escalationConfigured) add('warn', "Aucun destinataire de niveau 2 : si personne n'acquitte, l'alerte n'est escaladee a personne.");
  if (c.detectorTimeoutS <= 0) add(c.production ? 'warn' : 'warn', "Surveillance des detecteurs muets desactivee : un detecteur en panne resterait affiche « Normal » (PSIM_DETECTOR_TIMEOUT_S).");
  if (c.production && c.backupEveryH <= 0) add('warn', 'Sauvegarde automatique desactivee (PSIM_BACKUP_EVERY_H) : planifiez `npm run backup`.');
  return out;
}

export function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `  ${f.level === 'error' ? 'ERREUR ' : 'attention'} ${f.message}`).join('\n');
}
