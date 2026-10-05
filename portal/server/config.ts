/**
 * Configuration du portail (variables d'environnement PORTAL_*). Une valeur invalide est une erreur de demarrage,
 * jamais un repli silencieux.
 */
const env = process.env;

const envName = (env.PORTAL_ENV ?? '').trim().toLowerCase();
if (!['', 'production', 'development', 'dev', 'test'].includes(envName)) {
  throw new Error(`PORTAL_ENV="${env.PORTAL_ENV}" est invalide : production, development, ou absent.`);
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name}="${raw}" est invalide : un nombre entre ${min} et ${max} est attendu.`);
  return n;
}

export const config = {
  production: envName === 'production',
  host: env.PORTAL_HOST ?? '127.0.0.1',
  port: num('PORTAL_PORT', 4300, 1, 65535),
  dataDir: env.PORTAL_DATA_DIR ?? 'portal-data',
  /** Cle maitresse (64 hexadecimaux) dont sont derivees les cles des sites. Vide : fichier master.key du dossier de donnees. */
  masterKey: env.PORTAL_MASTER_KEY ?? '',
  /** Au-dela de ce silence, un site est declare « injoignable ». Trois envois manques de suite, avec l'envoi par defaut (300 s). */
  staleAfterS: num('PORTAL_STALE_AFTER_S', 900, 60, 86_400),
  /** Derriere un proxy HTTPS : fait confiance a X-Forwarded-For (adresse du client) et pose le cookie en Secure. */
  trustProxy: env.PORTAL_TRUST_PROXY === '1',
  cookieSecure: env.PORTAL_COOKIE_SECURE === '1' || env.PORTAL_TRUST_PROXY === '1',
};
