/**
 * Change le mot de passe d'un compte. Les mots de passe de .env ne servent qu'a la creation des
 * comptes (premier demarrage) : ensuite, c'est cette commande.
 *
 *   npm run set-password -- operateur
 *   npm run set-password -- --list
 *
 * Saisie masquee, jamais dans l'historique du terminal ni en argument. Les sessions deja ouvertes
 * restent valides jusqu'a leur expiration (12 h) ou au redemarrage du PSIM.
 */
import { join, resolve } from 'node:path';
import { createUser } from '../server/auth.ts';
import { config } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { DEV_PASSWORDS, MIN_PASSWORD_LENGTH } from '../server/preflight.ts';

export function validatePassword(password: string, username: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `trop court (${MIN_PASSWORD_LENGTH} caracteres minimum)`;
  if (DEV_PASSWORDS.includes(password)) return 'valeur de demonstration publique';
  if (password.toLowerCase().includes(username.toLowerCase())) return "ne doit pas contenir le nom d'utilisateur";
  if (/^(.)\1+$/.test(password)) return 'un seul caractere repete';
  return null;
}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolveInput) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolveInput(value);
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\nAnnule.\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const db = openDb(join(resolve(import.meta.dirname, '..', config.dataDir), 'psim.db'));
  const arg = process.argv[2];
  if (arg === '--list') {
    for (const u of db.prepare('SELECT username, role FROM app_user ORDER BY username').all() as { username: string; role: string }[]) console.log(`${u.username.padEnd(20)} ${u.role}`);
    process.exit(0);
  }
  const user = arg && !arg.startsWith('--') ? (db.prepare('SELECT username, role FROM app_user WHERE username = ?').get(arg) as { username: string; role: 'operator' | 'admin' } | undefined) : undefined;
  if (!user) {
    console.error(`Usage : npm run set-password -- <utilisateur>   (npm run set-password -- --list pour les voir)`);
    process.exit(2);
  }
  if (!process.stdin.isTTY) {
    console.error('Cette commande demande un terminal interactif (saisie masquee).');
    process.exit(2);
  }
  const first = await readHidden(`Nouveau mot de passe pour ${user.username} : `);
  const problem = validatePassword(first, user.username);
  if (problem) {
    console.error(`Refuse : ${problem}.`);
    process.exit(1);
  }
  if ((await readHidden('Confirmer : ')) !== first) {
    console.error('Les deux saisies different : rien n\'a ete modifie.');
    process.exit(1);
  }
  createUser(db, user.username, user.role, first);
  console.log(`Mot de passe de ${user.username} modifie. Les sessions ouvertes expirent d'ici 12 h ; redemarrez le PSIM pour les fermer tout de suite.`);
}
