/**
 * Prepare une installation de PRODUCTION sure, sans rien demarrer ni installer :
 *
 *   npm run init-production -- --host psim.local --host 192.168.1.22 --listen 0.0.0.0
 *
 *  - ecrit `.env.production` avec des mots de passe ALEATOIRES (administrateur, operateur, MQTT) : ils ne sont JAMAIS
 *    affiches, ils sont dans ce fichier, dont l'acces est restreint a votre compte ;
 *  - genere un certificat HTTPS auto-signe pour les noms/adresses donnes (sauf --no-tls) ;
 *  - choisit un dossier de donnees SEPARE de celui du developpement (`data-prod` par defaut) ;
 *  - verifie le resultat avec le controle de demarrage de production.
 *
 * Il refuse d'ecraser un fichier existant : supprimez-le vous-meme si vous voulez recommencer. Il n'installe aucune
 * tache planifiee et ne demarre pas le PSIM (voir docs/MISE-EN-SERVICE.md).
 *
 * Options : --host <nom-ou-ip> (repetable)   --listen <adresse> (127.0.0.1 par defaut ; 0.0.0.0 pour tout le reseau)
 *           --port 3033   --data-dir data-prod   --backup-dir <dossier>   --out .env.production   --no-tls
 */
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { validatePassword } from '../server/auth.ts';
import { HOST_PATTERN, generateCert } from './lib/cert.ts';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // sans caracteres ambigus (0 O 1 l I)

/** Mot de passe aleatoire de 24 caracteres, accepte par la politique du PSIM pour ce compte. */
export function randomPassword(username: string, length = 24): string {
  for (;;) {
    const p = Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    if (validatePassword(p, username) === null) return p;
  }
}

export interface EnvOptions {
  listen: string;
  port: number;
  dataDir: string;
  backupDir: string;
  tls: { cert: string; key: string } | null;
  publicHost: string | null;
  passwords: { admin: string; operator: string; mqtt: string };
}

/** Contenu de `.env.production`. Fonction pure : testable sans rien ecrire. */
export function buildEnv(o: EnvOptions): string {
  const q = (v: string) => (/[\s#"']/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v);
  return [
    '# Genere par `npm run init-production`. CONTIENT DES MOTS DE PASSE : ne pas partager, ne pas versionner,',
    '# en garder une copie chiffree HORS de cette machine.',
    '# Demarrer : npm run start:prod   (ou npm run supervise:prod pour la relance automatique)',
    '# Verifier  : npm run check-config:prod   puis   npm run commission:prod',
    '',
    'PSIM_ENV=production',
    'PSIM_ENV_FILE=.env.production',
    `PSIM_HOST=${o.listen}`,
    `PSIM_PORT=${o.port}`,
    `PSIM_DATA_DIR=${q(o.dataDir)}`,
    `PSIM_BACKUP_DIR=${q(o.backupDir)}`,
    'PSIM_BACKUP_EVERY_H=24',
    'PSIM_LOG_FILE=1',
    '',
    '# Comptes initiaux (crees au premier demarrage, puis geres depuis l\'interface).',
    '# La double authentification est imposee aux administrateurs.',
    `PSIM_ADMIN_PASSWORD=${o.passwords.admin}`,
    `PSIM_OPERATOR_PASSWORD=${o.passwords.operator}`,
    `PSIM_MQTT_PASSWORD=${o.passwords.mqtt}`,
    'PSIM_REQUIRE_2FA=admin',
    'PSIM_SIM_ENABLED=0',
    'PSIM_DEMO_LOGIN=0',
    '',
    o.tls ? `PSIM_TLS_CERT=${q(o.tls.cert)}\nPSIM_TLS_KEY=${q(o.tls.key)}` : '# HTTPS non configure : acceptable uniquement sur un reseau isole (voir README).',
    o.publicHost && o.tls ? `PSIM_PUBLIC_URL=https://${o.publicHost}${o.port === 443 ? '' : `:${o.port}`}` : '# PSIM_PUBLIC_URL=https://psim.exemple.fr:3033   adresse citee dans les alertes',
    '',
    '# Broker MQTT local uniquement. Pour des detecteurs distants : PSIM_MQTT_HOST=0.0.0.0 AVEC PSIM_MQTT_TLS_CERT / PSIM_MQTT_TLS_KEY.',
    'PSIM_MQTT_HOST=127.0.0.1',
    'PSIM_DETECTOR_TIMEOUT_S=180',
    '',
    '# A renseigner avant la mise en service (voir docs/MISE-EN-SERVICE.md) :',
    '# PSIM_SMTP_HOST=  PSIM_SMTP_PORT=587  PSIM_SMTP_USER=  PSIM_SMTP_PASSWORD=  PSIM_SMTP_FROM=',
    '# PSIM_NOTIFY_EMAIL_L1=agent@exemple.fr          PSIM_NOTIFY_EMAIL_L2=responsable@exemple.fr',
    '# PSIM_HEARTBEAT_URL=https://hc-ping.com/xxxx    supervision externe (recommandee)',
    '',
  ].join('\n');
}

/** Restreint le fichier a l'utilisateur courant (Windows : ACL ; POSIX : chmod 600). */
export function restrictToCurrentUser(path: string): boolean {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME;
    if (!user) return false;
    const r = spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' });
    return r.status === 0;
  }
  chmodSync(path, 0o600);
  return true;
}

const valueOf = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const valuesOf = (args: string[], flag: string): string[] => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));

export async function main(args: string[], root = resolve(import.meta.dirname, '..')): Promise<number> {
  const out = resolve(root, valueOf(args, '--out') ?? '.env.production');
  if (existsSync(out)) {
    console.error(`${out} existe deja : rien n'a ete modifie. Supprimez-le vous-meme pour recommencer (il contient les mots de passe actuels).`);
    return 1;
  }
  const listen = valueOf(args, '--listen') ?? '127.0.0.1';
  if (!/^[0-9.:a-fA-F]{2,45}$/.test(listen)) {
    console.error('--listen : une adresse IP (127.0.0.1, 0.0.0.0, ...)');
    return 2;
  }
  const port = Number(valueOf(args, '--port') ?? 3033);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('--port : un entier de 1 a 65535');
    return 2;
  }
  const hosts = valuesOf(args, '--host');
  if (hosts.some((h) => !HOST_PATTERN.test(h))) {
    console.error('--host : nom ou adresse invalide (lettres, chiffres, points et tirets seulement)');
    return 2;
  }
  const noTls = args.includes('--no-tls');
  const exposed = !['127.0.0.1', 'localhost', '::1'].includes(listen);
  if (exposed && noTls) {
    console.error("--no-tls avec une adresse d'ecoute ouverte au reseau : identifiants et sessions circuleraient en clair. Le PSIM refuserait de demarrer en production.");
    return 2;
  }
  const dataDir = valueOf(args, '--data-dir') ?? 'data-prod';
  const dataAbs = isAbsolute(dataDir) ? dataDir : resolve(root, dataDir);
  if (dataAbs === resolve(root, 'data')) {
    console.error('--data-dir : ne pas reutiliser le dossier `data` du developpement (base de demonstration, mots de passe de demonstration).');
    return 2;
  }
  const backupDir = valueOf(args, '--backup-dir') ?? resolve(root, 'backups-prod');

  let tls: EnvOptions['tls'] = null;
  if (!noTls) {
    try {
      const names = hosts.length ? hosts : ['localhost'];
      const cert = generateCert({ hosts: names, dir: resolve(dataAbs, 'tls') });
      tls = { cert: cert.cert, key: cert.key };
      console.log(`Certificat HTTPS auto-signe genere (825 jours) pour : ${cert.names.join(', ')}`);
    } catch (err) {
      console.error(`Certificat impossible : ${(err as Error).message} (utilisez --no-tls sur un poste local, ou fournissez votre certificat dans le fichier genere)`);
      return 1;
    }
  }

  mkdirSync(dataAbs, { recursive: true });
  const env = buildEnv({
    listen, port, dataDir: dataAbs, backupDir, tls, publicHost: hosts[0] ?? null,
    passwords: { admin: randomPassword('admin'), operator: randomPassword('operateur'), mqtt: randomPassword('psim') },
  });
  writeFileSync(out, env, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const restricted = restrictToCurrentUser(out) && (tls ? restrictToCurrentUser(tls.key) : true);
  console.log(`\n${out} ecrit${restricted ? ', acces restreint a votre compte' : ' (ATTENTION : restreignez vous-meme son acces, il contient des mots de passe)'}.`);
  console.log('Les mots de passe (administrateur, operateur, MQTT) y sont ; ils ne sont pas affiches ici.');

  // Meme verdict que le demarrage de production.
  const check = spawnSync(process.execPath, [`--env-file=${out}`, 'scripts/check-config.ts'], { cwd: root, encoding: 'utf8' });
  const verdict = `${check.stdout}${check.stderr}`.split(/\r?\n/).filter((l) => l && !/ExperimentalWarning|trace-warnings/.test(l));
  console.log(`\nControle de demarrage de production :\n${verdict.map((l) => `  ${l}`).join('\n')}`);
  console.log('\nEtapes suivantes (docs/MISE-EN-SERVICE.md) :');
  console.log('  1. renseigner SMTP / destinataires / supervision externe dans le fichier ;');
  console.log('  2. npm run start:prod, puis ouvrir l\'interface, activer la double authentification (obligatoire pour l\'administrateur) ;');
  console.log('  3. declarer l\'inventaire, puis npm run commission:prod ; recette des detecteurs : npm run commission:prod -- watch.');
  return check.status === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main(process.argv.slice(2));
}
