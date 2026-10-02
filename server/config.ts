const env = process.env;

const host = env.PSIM_HOST ?? '127.0.0.1';
const simEnabled = env.PSIM_SIM_ENABLED !== '0';
const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(host);

/** Lit un delai en secondes ; valeur absente ou invalide = defaut ; 0 desactive la regle. */
function seconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Liste separee par des virgules ou des espaces ; absente = liste vide. */
function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export const config = {
  port: Number(env.PSIM_PORT ?? 3033),
  host,
  mqttPort: Number(env.PSIM_MQTT_PORT ?? 1883),
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
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : simEnabled ? 0 : 180;
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
    webhookSecret: process.env.PSIM_WEBHOOK_SECRET ?? '',
    recipients: {
      email: [list('PSIM_NOTIFY_EMAIL_L1'), list('PSIM_NOTIFY_EMAIL_L2')],
      telegram: [list('PSIM_NOTIFY_TELEGRAM_L1'), list('PSIM_NOTIFY_TELEGRAM_L2')],
      webhook: [list('PSIM_NOTIFY_WEBHOOK_L1'), list('PSIM_NOTIFY_WEBHOOK_L2')],
    },
  },
  confirmWindowS: seconds('PSIM_CONFIRM_WINDOW_S', 60),
  confirmPersistS: seconds('PSIM_CONFIRM_PERSIST_S', 120),
  falseAlarmHintS: seconds('PSIM_FALSE_ALARM_HINT_S', 30),
  // Comptes cliquables sur la page de connexion (mots de passe visibles depuis le navigateur).
  // Actif par defaut uniquement en poste local avec les mots de passe de developpement ;
  // PSIM_DEMO_LOGIN=1 / 0 force le choix.
  demoLogin:
    env.PSIM_DEMO_LOGIN !== undefined
      ? env.PSIM_DEMO_LOGIN === '1'
      : loopbackOnly && !env.PSIM_ADMIN_PASSWORD && !env.PSIM_OPERATOR_PASSWORD,
};

export function usesDevDefaults(): boolean {
  return !env.PSIM_ADMIN_PASSWORD || !env.PSIM_OPERATOR_PASSWORD || !env.PSIM_MQTT_PASSWORD;
}
