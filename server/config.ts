const env = process.env;

const host = env.PSIM_HOST ?? '127.0.0.1';
const simEnabled = env.PSIM_SIM_ENABLED !== '0';
const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(host);

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
