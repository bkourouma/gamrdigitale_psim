const env = process.env;

const host = env.PSIM_HOST ?? '127.0.0.1';
// Une faute de frappe (« Production », « prod ») ne doit JAMAIS desactiver en silence toute la protection de production.
const envName = (env.PSIM_ENV ?? '').trim().toLowerCase();
if (!['', 'production', 'development', 'dev', 'test'].includes(envName)) {
  throw new Error(`PSIM_ENV="${env.PSIM_ENV}" est invalide : production, development, ou absent. (Une valeur inconnue desactiverait la protection de production.)`);
}
const production = envName === 'production';
// En production le simulateur est desactive par defaut (il permet de declencher de fausses alarmes).
const simEnabled = env.PSIM_SIM_ENABLED === undefined ? !production : env.PSIM_SIM_ENABLED !== '0';
const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(host);

/**
 * Lit un nombre : absent ou vide = defaut ; INVALIDE = erreur de demarrage (jamais un repli silencieux : « 14d » ou
 * « 24h » valaient NaN, ce qui coupait les sauvegardes sans un mot, voire les supprimait toutes). 0 desactive la regle.
 */
function num(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name}="${raw}" est invalide : un nombre entre ${min} et ${max} est attendu.`);
  return n;
}
const seconds = (name: string, fallback: number): number => num(name, fallback);

/**
 * Destinataires WhatsApp : une entree mal formee est une erreur de demarrage (jamais un destinataire ignore en silence).
 * Le message ne cite jamais l'entree (une entree CallMeBot contient une cle) : seulement sa position.
 */
function whatsappList(name: string, withKey: boolean): string[] {
  const entries = list(name);
  entries.forEach((entry, index) => {
    const ok = withKey ? /^\+\d{8,15}:[A-Za-z0-9]{3,64}$/.test(entry) : /^\+\d{8,15}$/.test(entry);
    if (ok) return;
    const hint = withKey
      ? 'Format attendu : +<indicatif><numero>:<cle CallMeBot>, sans espace (ex. +2250700000000:1234567)'
      : /:/.test(entry)
        ? "Format attendu : +<indicatif><numero>, sans cle (une entree « numero:cle » est pour CallMeBot : PSIM_NOTIFY_CALLMEBOT_L1 / L2)"
        : 'Format attendu : +<indicatif><numero>, sans espace (ex. +2250700000000)';
    throw new Error(`${name} : l'entree n°${index + 1} est invalide. ${hint}, entrees separees par des virgules.`);
  });
  return entries;
}

/** Liste separee par des virgules ou des espaces ; absente = liste vide. */
function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Canaux dont les destinataires dependent d'une configuration (jeton, serveur) : libelle et presence de cette configuration. */
export function channelSetup(notify: typeof config.notify): { id: 'email' | 'telegram' | 'whatsapp'; label: string; configured: boolean }[] {
  return [
    { id: 'email', label: 'e-mail', configured: Boolean(notify.smtp.host && notify.smtp.from) },
    { id: 'telegram', label: 'Telegram', configured: Boolean(notify.telegram.token) },
    { id: 'whatsapp', label: 'WhatsApp', configured: Boolean(notify.whatsapp.token && notify.whatsapp.phoneId) },
  ];
}

/** Adresses des services de messagerie a controler (https exige hors boucle locale). */
export function serviceUrls(notify: typeof config.notify): { name: string; url: string }[] {
  return [
    { name: 'PSIM_TELEGRAM_API', url: notify.telegram.apiBase },
    { name: 'PSIM_WHATSAPP_API', url: notify.whatsapp.apiBase },
    { name: 'PSIM_CALLMEBOT_API', url: notify.callmebot.apiBase },
  ];
}

export const config = {
  production,
  port: num('PSIM_PORT', 3033, 0, 65535),
  host,
  // Broker MQTT : LOCAL par defaut, meme si l'interface web est ouverte au reseau. A ouvrir pour des detecteurs distants,
  // de preference en TLS (PSIM_MQTT_TLS_CERT / KEY) : sinon le mot de passe partage circule en clair.
  mqttHost: env.PSIM_MQTT_HOST ?? '127.0.0.1',
  mqttPort: num('PSIM_MQTT_PORT', 1883, 0, 65535),
  // Accord explicite pour un broker ouvert au reseau SANS TLS (reseau dedie aux detecteurs) : sans lui, la production refuse.
  mqttAllowPlaintext: env.PSIM_MQTT_ALLOW_PLAINTEXT === '1',
  mqttTls: { cert: env.PSIM_MQTT_TLS_CERT ?? '', key: env.PSIM_MQTT_TLS_KEY ?? '' },
  // HTTPS integre (PEM). Sans certificat : HTTP. `httpRedirectPort` : port HTTP qui redirige vers HTTPS (0 = aucun).
  tls: { cert: env.PSIM_TLS_CERT ?? '', key: env.PSIM_TLS_KEY ?? '' },
  httpRedirectPort: num('PSIM_HTTP_REDIRECT_PORT', 0, 0, 65535),
  // Derriere un proxy HTTPS (IIS, nginx, Caddy) : fait confiance a X-Forwarded-For pour l'adresse du client.
  trustProxy: env.PSIM_TRUST_PROXY === '1',
  backup: {
    dir: env.PSIM_BACKUP_DIR ?? '',
    everyH: num('PSIM_BACKUP_EVERY_H', production ? 24 : 0),
    keep: num('PSIM_BACKUP_KEEP', 14, 1),
  },
  // Supervision externe : signal HTTP regulier vers un service qui s'inquiete s'il ne le recoit plus (healthchecks.io, Uptime Kuma...).
  heartbeatUrl: env.PSIM_HEARTBEAT_URL ?? '',
  heartbeatEveryS: num('PSIM_HEARTBEAT_EVERY_S', 60),
  // Mesure de l'etat des cameras reelles : test de connexion toutes les N secondes (0 = coupe). Voir camerahealth.ts.
  cameraCheckS: num('PSIM_CAMERA_CHECK_S', 60, 0, 3_600),
  // Portail de suivi a distance : le site lui envoie un resume (voir portal.ts). Vide = pas de portail.
  portal: {
    url: env.PSIM_PORTAL_URL ?? '',
    siteId: (env.PSIM_PORTAL_SITE_ID ?? '').trim(),
    key: env.PSIM_PORTAL_KEY ?? '',
    everyS: num('PSIM_PORTAL_EVERY_S', 300, 0, 86_400),
  },
  // Periode aveugle (PSIM arrete) a partir de laquelle on previent par notification, en secondes.
  gapNotifyS: num('PSIM_GAP_NOTIFY_S', 60),
  logFile: env.PSIM_LOG_FILE === undefined ? production : env.PSIM_LOG_FILE === '1',
  // Passerelles : un compte MQTT PAR passerelle, limite a ses detecteurs (JSON : [{"user":"gw1","password":"...","detectors":["D-*","A-01"]}]).
  // Un identifiant partage par tous les equipements permettrait a n'importe lequel de forger ou de masquer l'alarme d'un autre.
  mqttGateways: ((): { user: string; password: string; detectors: string[] }[] => {
    const raw = env.PSIM_MQTT_GATEWAYS;
    if (!raw || raw.trim() === '') return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('PSIM_MQTT_GATEWAYS : JSON invalide (attendu : [{"user":"gw1","password":"...","detectors":["D-*"]}])');
    }
    if (!Array.isArray(parsed) || parsed.length > 50) throw new Error('PSIM_MQTT_GATEWAYS : une liste de 50 passerelles au plus est attendue');
    const principal = env.PSIM_MQTT_USER ?? 'psim';
    return parsed.map((g, i) => {
      const gw = g as { user?: unknown; password?: unknown; detectors?: unknown };
      const n = i + 1;
      if (typeof gw.user !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(gw.user) || gw.user === principal) throw new Error(`PSIM_MQTT_GATEWAYS[${n}] : identifiant invalide (ou identique au compte principal)`);
      if (typeof gw.password !== 'string' || gw.password.length < 12) throw new Error(`PSIM_MQTT_GATEWAYS[${n}] : mot de passe de 12 caracteres minimum`);
      if (!Array.isArray(gw.detectors) || gw.detectors.length === 0 || gw.detectors.some((d) => typeof d !== 'string' || !/^[A-Za-z0-9_-]{1,32}\*?$/.test(d))) {
        throw new Error(`PSIM_MQTT_GATEWAYS[${n}] : detectors doit lister des identifiants (« D-01 ») ou des prefixes (« D-* »)`);
      }
      return { user: gw.user, password: gw.password, detectors: gw.detectors as string[] };
    });
  })(),
  mqttUser: env.PSIM_MQTT_USER ?? 'psim',
  mqttPassword: env.PSIM_MQTT_PASSWORD ?? 'psim-dev-only',
  dataDir: env.PSIM_DATA_DIR ?? 'data',
  adminPassword: env.PSIM_ADMIN_PASSWORD ?? 'admin-dev-only',
  operatorPassword: env.PSIM_OPERATOR_PASSWORD ?? 'operator-dev-only',
  simEnabled,
  // Delai (secondes) sans message avant de declarer un detecteur « hors ligne ». 0 = desactive.
  // Par defaut : 180 s en exploitation, desactive en mode simulateur (le simulateur n'envoie pas
  // de signal de vie, les detecteurs simules passeraient sinon hors ligne au bout de 3 minutes).
  detectorTimeoutS: (() => {
    const raw = env.PSIM_DETECTOR_TIMEOUT_S;
    if (raw === undefined || raw.trim() === '') return simEnabled ? 0 : 180;
    return num('PSIM_DETECTOR_TIMEOUT_S', simEnabled ? 0 : 180);
  })(),
  cookieSecure: env.PSIM_COOKIE_SECURE === '1',
  ffmpegPath: env.PSIM_FFMPEG ?? 'ffmpeg',
  secretKey: env.PSIM_SECRET_KEY,
  // Regles anti-fausses alarmes : elles QUALIFIENT les incidents (a confirmer / confirme / probable
  // fausse alarme) sans jamais retarder, masquer ni fermer une alarme. Actives par defaut. 0 = desactivee.
  // Conservation des images d'incident (jours ; 0 = indefiniment).
  snapshotDays: seconds('PSIM_SNAPSHOT_DAYS', 30),
  // Notifications : e-mail (SMTP), Telegram, webhook. Niveau 1 = prevenu a l'ouverture ; niveau 2 =
  // prevenu si personne n'acquitte. Les secrets (mot de passe SMTP, jeton Telegram) restent dans .env.
  notify: {
    publicUrl: process.env.PSIM_PUBLIC_URL ?? '',
    escalateAfterS: seconds('PSIM_ESCALATE_AFTER_S', 180),
    reminderS: seconds('PSIM_REMINDER_S', 300),
    maxReminders: seconds('PSIM_MAX_REMINDERS', 3),
    smtp: {
      host: process.env.PSIM_SMTP_HOST ?? '',
      port: seconds('PSIM_SMTP_PORT', 587),
      secure: process.env.PSIM_SMTP_SECURE === '1',
      user: process.env.PSIM_SMTP_USER ?? '',
      password: process.env.PSIM_SMTP_PASSWORD ?? '',
      from: process.env.PSIM_SMTP_FROM ?? '',
      starttls: process.env.PSIM_SMTP_STARTTLS !== '0',
    },
    telegram: { token: process.env.PSIM_TELEGRAM_TOKEN ?? '', apiBase: process.env.PSIM_TELEGRAM_API ?? 'https://api.telegram.org' },
    // WhatsApp officiel (Meta, WhatsApp Cloud API) : jeton permanent d'un utilisateur systeme, identifiant du numero
    // expediteur, modele approuve a 3 variables (titre, lieu, details). Destinataires : numeros ci-dessous ou interface.
    whatsapp: {
      apiBase: process.env.PSIM_WHATSAPP_API ?? 'https://graph.facebook.com/v25.0',
      token: process.env.PSIM_WHATSAPP_TOKEN ?? '',
      phoneId: process.env.PSIM_WHATSAPP_PHONE_ID ?? '',
      template: process.env.PSIM_WHATSAPP_TEMPLATE ?? 'psim_alerte',
      language: process.env.PSIM_WHATSAPP_LANG ?? 'fr',
      wabaId: process.env.PSIM_WHATSAPP_WABA_ID ?? '',
    },
    // WhatsApp par CallMeBot (gratuit, usage personnel, sans garantie) : une cle par telephone, dans le .env seulement.
    callmebot: { apiBase: process.env.PSIM_CALLMEBOT_API ?? 'https://api.callmebot.com' },
    webhookSecret: process.env.PSIM_WEBHOOK_SECRET ?? '',
    recipients: {
      email: [list('PSIM_NOTIFY_EMAIL_L1'), list('PSIM_NOTIFY_EMAIL_L2')],
      telegram: [list('PSIM_NOTIFY_TELEGRAM_L1'), list('PSIM_NOTIFY_TELEGRAM_L2')],
      whatsapp: [whatsappList('PSIM_NOTIFY_WHATSAPP_L1', false), whatsappList('PSIM_NOTIFY_WHATSAPP_L2', false)],
      callmebot: [whatsappList('PSIM_NOTIFY_CALLMEBOT_L1', true), whatsappList('PSIM_NOTIFY_CALLMEBOT_L2', true)],
      webhook: [list('PSIM_NOTIFY_WEBHOOK_L1'), list('PSIM_NOTIFY_WEBHOOK_L2')],
    },
  },
  // Gestion des risques : periode (jours) de l'historique d'incendies, et age (mois) apres lequel une evaluation est « a revoir ».
  riskFireWindowDays: seconds('PSIM_RISK_FIRE_WINDOW_DAYS', 180),
  riskStaleMonths: seconds('PSIM_RISK_STALE_MONTHS', 12),
  // Entree HTTP pour les systemes qui poussent leurs evenements (controle d'acces, passerelles IoT) : POST /api/ingest/<id>
  // avec « Authorization: Bearer <jeton> ». Desactivee si le jeton est vide. 24 caracteres minimum (verifie au demarrage).
  ingestToken: env.PSIM_INGEST_TOKEN ?? '',
  // Double authentification obligatoire : 'none', 'admin' (les administrateurs) ou 'all'. Par defaut : administrateurs en production.
  requireTotp: ((): 'none' | 'admin' | 'all' => {
    const v = env.PSIM_REQUIRE_2FA;
    return v === 'none' || v === 'admin' || v === 'all' ? v : production ? 'admin' : 'none';
  })(),
  confirmWindowS: seconds('PSIM_CONFIRM_WINDOW_S', 60),
  confirmPersistS: seconds('PSIM_CONFIRM_PERSIST_S', 120),
  falseAlarmHintS: seconds('PSIM_FALSE_ALARM_HINT_S', 30),
  // Comptes cliquables sur la page de connexion (mots de passe visibles depuis le navigateur).
  // Actif par defaut uniquement en poste local avec les mots de passe de developpement ;
  // PSIM_DEMO_LOGIN=1 / 0 force le choix.
  demoLogin:
    env.PSIM_DEMO_LOGIN !== undefined
      ? env.PSIM_DEMO_LOGIN === '1'
      : !production && loopbackOnly && !env.PSIM_ADMIN_PASSWORD && !env.PSIM_OPERATOR_PASSWORD,
};

export function usesDevDefaults(): boolean {
  return !env.PSIM_ADMIN_PASSWORD || !env.PSIM_OPERATOR_PASSWORD || !env.PSIM_MQTT_PASSWORD;
}
