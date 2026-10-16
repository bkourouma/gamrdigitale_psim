import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

/** Numeros de telephone (appels vocaux) : une entree mal formee est une erreur de demarrage, avec sa position. */
function phoneList(name: string): string[] {
  const entries = list(name);
  entries.forEach((entry, index) => {
    if (!/^\+\d{8,15}$/.test(entry)) throw new Error(`${name} : l'entree n°${index + 1} est invalide. Format attendu : +<indicatif><numero>, sans espace (ex. +2250700000000), entrees separees par des virgules.`);
  });
  return entries;
}

/**
 * Appels vocaux Vonage : identifiant de l'application, cle privee (fichier PEM) et numero appelant vont ensemble. Une cle
 * illisible est une erreur de demarrage (jamais des appels qui ne partiraient pas), et son contenu n'est jamais cite.
 */
function vonageConfig(): { apiBase: string; applicationId: string; privateKey: string; from: string; language: string } {
  const applicationId = (env.PSIM_VONAGE_APPLICATION_ID ?? '').trim();
  const keyFile = (env.PSIM_VONAGE_PRIVATE_KEY_FILE ?? '').trim();
  const from = (env.PSIM_VONAGE_FROM ?? '').trim().replace(/^\+/, '');
  const language = (env.PSIM_VONAGE_LANG ?? 'fr-FR').trim() || 'fr-FR';
  const apiBase = env.PSIM_VONAGE_API ?? 'https://api.nexmo.com';
  if (!applicationId && !keyFile && !from) return { apiBase, applicationId, privateKey: '', from, language };
  if (!applicationId || !keyFile || !from) {
    throw new Error('PSIM_VONAGE_APPLICATION_ID, PSIM_VONAGE_PRIVATE_KEY_FILE et PSIM_VONAGE_FROM vont ensemble : renseigner les trois, ou aucun.');
  }
  if (!/^\d{6,15}$/.test(from)) throw new Error('PSIM_VONAGE_FROM est invalide : le numero Vonage qui appelle, chiffres seulement avec l\'indicatif (ex. 14155550100).');
  if (!/^[a-z]{2,3}-[A-Z]{2}$/.test(language)) throw new Error(`PSIM_VONAGE_LANG="${env.PSIM_VONAGE_LANG}" est invalide : une langue de synthese vocale comme fr-FR est attendue.`);
  let privateKey: string;
  try {
    privateKey = readFileSync(resolve(import.meta.dirname, '..', keyFile), 'utf8');
    if (createPrivateKey(privateKey).asymmetricKeyType !== 'rsa') throw new Error('pas RSA');
  } catch {
    throw new Error('PSIM_VONAGE_PRIVATE_KEY_FILE : fichier introuvable, ou ce n\'est pas la cle privee RSA (PEM) generee avec l\'application Vonage.');
  }
  return { apiBase, applicationId, privateKey, from, language };
}

/** Liste separee par des virgules ou des espaces ; absente = liste vide. */
function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Canaux dont les destinataires dependent d'une configuration (jeton, serveur) : libelle et presence de cette configuration. */
export function channelSetup(notify: typeof config.notify): { id: 'email' | 'telegram' | 'whatsapp' | 'vonage'; label: string; configured: boolean }[] {
  return [
    { id: 'email', label: 'e-mail', configured: Boolean(notify.smtp.host && notify.smtp.from) },
    { id: 'telegram', label: 'Telegram', configured: Boolean(notify.telegram.token) },
    { id: 'whatsapp', label: 'WhatsApp', configured: Boolean(notify.whatsapp.token && notify.whatsapp.phoneId) },
    { id: 'vonage', label: 'appel telephonique (Vonage)', configured: Boolean(notify.vonage.applicationId && notify.vonage.privateKey && notify.vonage.from) },
  ];
}

/** Adresses des services de messagerie a controler (https exige hors boucle locale). */
export function serviceUrls(notify: typeof config.notify): { name: string; url: string }[] {
  return [
    { name: 'PSIM_TELEGRAM_API', url: notify.telegram.apiBase },
    { name: 'PSIM_WHATSAPP_API', url: notify.whatsapp.apiBase },
    { name: 'PSIM_CALLMEBOT_API', url: notify.callmebot.apiBase },
    { name: 'PSIM_VONAGE_API', url: notify.vonage.apiBase },
  ];
}

/** Centres de donnees du cloud Tuya (le projet Tuya en choisit un a sa creation ; l'Afrique releve de « eu »). */
export const TUYA_REGIONS: Record<string, string> = {
  eu: 'https://openapi.tuyaeu.com', // Europe centrale (Afrique comprise)
  'eu-w': 'https://openapi-weaz.tuyaeu.com', // Europe de l'Ouest
  us: 'https://openapi.tuyaus.com', // Amerique de l'Ouest
  'us-e': 'https://openapi-ueaz.tuyaus.com', // Amerique de l'Est
  in: 'https://openapi.tuyain.com', // Inde
  sg: 'https://openapi-sg.iotbing.com', // Singapour
  cn: 'https://openapi.tuyacn.com', // Chine
};

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
  // Supervision reseau des equipements d'infrastructure (routeur, switch...) : meme principe, toutes les N secondes (0 = coupe). Voir networkhealth.ts.
  networkCheckS: num('PSIM_NETWORK_CHECK_S', 60, 0, 3_600),
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
  // Passerelle deconnectee du broker depuis N secondes : ses capteurs sont « non surveilles », avec UN avertissement, au lieu
  // d'etre declares muets un par un (voir gatewaylink.ts). 0 = desactive. A son retour, le silence de chaque capteur n'est
  // compte qu'apres le delai de grace (le temps de renvoyer les alertes gardees pendant la coupure).
  gatewayTimeoutS: num('PSIM_GATEWAY_TIMEOUT_S', 120, 0, 86_400),
  gatewayGraceS: num('PSIM_GATEWAY_GRACE_S', 120, 0, 3_600),
  // Messages dates (`ts`) et rejouables (`msgId`, voir ingestmeta.ts) : age maximal d'un message date (au-dela : refuse),
  // qui est aussi la duree de memoire des `msgId` deja traites. 7 jours par defaut.
  ingestMaxAgeS: num('PSIM_INGEST_MAX_AGE_S', 7 * 86_400, 60, 30 * 86_400),
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
  // Images prises a l'OUVERTURE d'un incident, par camera liee : une toutes les 1,5 s (1 = une seule image).
  snapshotSeries: num('PSIM_SNAPSHOT_SERIES', 5, 1, 10),
  // Images envoyees par les equipements (POST /api/ingest/<id>/image, cle par equipement) : voir server/deviceimages.ts.
  deviceImages: {
    maxBytes: num('PSIM_DEVICE_IMAGE_MAX_KB', 2048, 16, 10_240) * 1024,
    perDevicePerMin: num('PSIM_DEVICE_IMAGE_PER_MIN', 6, 1, 120),
    perIpPerMin: num('PSIM_DEVICE_IMAGE_IP_PER_MIN', 30, 1, 600),
    quotaBytes: num('PSIM_DEVICE_IMAGE_QUOTA_MB', 500, 1, 100_000) * 1024 * 1024,
    quotaCount: num('PSIM_DEVICE_IMAGE_QUOTA_COUNT', 5000, 1, 1_000_000),
    maxPerIncident: num('PSIM_DEVICE_IMAGE_PER_INCIDENT', 20, 1, 200),
    pendingS: num('PSIM_DEVICE_IMAGE_PENDING_S', 300, 0, 3600),
  },
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
    // Appels vocaux Vonage (API Voice) : message lu par synthese vocale. Identifiant d'application, cle privee (fichier) et
    // numero appelant vont ensemble ; destinataires : numeros ci-dessous ou interface.
    vonage: vonageConfig(),
    webhookSecret: process.env.PSIM_WEBHOOK_SECRET ?? '',
    recipients: {
      email: [list('PSIM_NOTIFY_EMAIL_L1'), list('PSIM_NOTIFY_EMAIL_L2')],
      telegram: [list('PSIM_NOTIFY_TELEGRAM_L1'), list('PSIM_NOTIFY_TELEGRAM_L2')],
      whatsapp: [whatsappList('PSIM_NOTIFY_WHATSAPP_L1', false), whatsappList('PSIM_NOTIFY_WHATSAPP_L2', false)],
      callmebot: [whatsappList('PSIM_NOTIFY_CALLMEBOT_L1', true), whatsappList('PSIM_NOTIFY_CALLMEBOT_L2', true)],
      vonage: [phoneList('PSIM_NOTIFY_VONAGE_L1'), phoneList('PSIM_NOTIFY_VONAGE_L2')],
      webhook: [list('PSIM_NOTIFY_WEBHOOK_L1'), list('PSIM_NOTIFY_WEBHOOK_L2')],
    },
  },
  // Gestion des risques : periode (jours) de l'historique d'incendies, et age (mois) apres lequel une evaluation est « a revoir ».
  riskFireWindowDays: seconds('PSIM_RISK_FIRE_WINDOW_DAYS', 180),
  riskStaleMonths: seconds('PSIM_RISK_STALE_MONTHS', 12),
  // Detecteurs de fumee WiFi Tuya / Smart Life, lus dans le cloud Tuya (voir server/tuya.ts et docs/TUYA.md).
  // Vide = pas de detecteur Tuya. Les deux cles vont ensemble ; la region est celle du centre de donnees du projet Tuya.
  tuya: ((): { accessId: string; accessSecret: string; baseUrl: string; region: string; pollS: number } => {
    const accessId = (env.PSIM_TUYA_ACCESS_ID ?? '').trim();
    const accessSecret = (env.PSIM_TUYA_ACCESS_SECRET ?? '').trim();
    if (Boolean(accessId) !== Boolean(accessSecret)) throw new Error('PSIM_TUYA_ACCESS_ID et PSIM_TUYA_ACCESS_SECRET vont ensemble : renseigner les deux, ou aucun.');
    const region = (env.PSIM_TUYA_REGION ?? 'eu').trim().toLowerCase() || 'eu';
    const baseUrl = TUYA_REGIONS[region];
    if (!baseUrl) throw new Error(`PSIM_TUYA_REGION="${env.PSIM_TUYA_REGION}" est invalide : ${Object.keys(TUYA_REGIONS).join(', ')}.`);
    // Une lecture toutes les 60 s par defaut : l'essai gratuit du cloud Tuya plafonne le nombre d'appels par mois.
    return { accessId, accessSecret, baseUrl, region, pollS: num('PSIM_TUYA_POLL_S', 60, 10, 120) };
  })(),
  // Assistant de regles (ecran « Regles », zone « Decrivez la regle en une phrase ») : cle de l'API Anthropic, dans le .env seulement.
  // Cle vide ou absente = assistant non configure (la zone n'est pas affichee). Seules des phrases et des noms sont envoyes, jamais d'image.
  assist: { apiKey: (env.PSIM_ASSIST_API_KEY ?? '').trim(), model: (env.PSIM_ASSIST_MODEL ?? '').trim() || 'claude-sonnet-5-5' },
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
