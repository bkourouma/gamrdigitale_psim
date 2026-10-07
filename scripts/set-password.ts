/**
 * Change le mot de passe d'un compte. Les mots de passe de .env ne servent qu'a la creation des
 * comptes (premier demarrage) : ensuite, c'est cette commande.
 *
 *   npm run set-password -- operateur
 *   npm run set-password -- --list
 *
 * Saisie masquee, jamais dans l'historique du terminal ni en argument. Les sessions ouvertes de ce
 * compte sont fermees immediatement (le PSIM verifie les identifiants a chaque requete).
 *
 *   npm run set-password -- --temp operateur
 *
 * Sans terminal interactif (ou pour un assistant) : genere un mot de passe PROVISOIRE, l'affiche une seule fois, et
 * impose son changement a la prochaine connexion. Aucun mot de passe ne passe en argument.
 *
 * Production : `node --env-file=.env.production scripts/set-password.ts ...` (le script npm lit `.env`, pas `.env.production`).
 */
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { appendSealed } from '../server/auditchain.ts';
import { createUser, validatePassword } from '../server/auth.ts';
import { config } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import type { Role } from '../server/types.ts';

export { validatePassword };

/** Mot de passe provisoire : 18 caracteres sans ambiguite (ni 0/O ni 1/l/I). */
export function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(randomBytes(18), (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Remplace le mot de passe par un mot de passe provisoire a changer a la prochaine connexion. Les sessions ouvertes sont
 * invalidees (createUser incremente la version des identifiants). Renvoie le mot de passe, ou null si le compte n'existe pas.
 */
export function resetToTemporaryPassword(db: DatabaseSync, username: string, now = Date.now()): string | null {
  const user = db.prepare('SELECT role FROM app_user WHERE username = ?').get(username) as { role: Role } | undefined;
  if (!user) return null;
  let password = generatePassword();
  while (validatePassword(password, username)) password = generatePassword();
  db.exec('BEGIN');
  try {
    createUser(db, username, user.role, password, now);
    db.prepare('UPDATE app_user SET must_change_password = 1 WHERE username = ?').run(username);
    appendSealed(db, { ts: now, actor: 'console', action: 'password_reset', incident_id: null, device_id: null, details: `${username} (set-password --temp, mot de passe provisoire)` });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return password;
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
  let arg = process.argv[2];
  const temporary = arg === '--temp';
  if (temporary) arg = process.argv[3];
  if (arg === '--list') {
    for (const u of db.prepare('SELECT username, role FROM app_user ORDER BY username').all() as { username: string; role: string }[]) console.log(`${u.username.padEnd(20)} ${u.role}`);
    process.exit(0);
  }
  const user = arg && !arg.startsWith('--') ? (db.prepare('SELECT username, role FROM app_user WHERE username = ?').get(arg) as { username: string; role: 'operator' | 'admin' } | undefined) : undefined;
  if (!user) {
    console.error(`Usage : npm run set-password -- [--temp] <utilisateur>   (npm run set-password -- --list pour les voir)`);
    process.exit(2);
  }
  if (temporary) {
    const password = resetToTemporaryPassword(db, user.username);
    console.log(`Nouveau mot de passe provisoire pour ${user.username} (affiche une seule fois, a changer a la prochaine connexion) :\n\n${password}\n\nSes sessions ouvertes sont fermees immediatement.`);
    process.exit(0);
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
  // Trace dans le journal scelle (auteur « console ») : un changement de mot de passe hors interface ne doit pas passer inapercu.
  appendSealed(db, { ts: Date.now(), actor: 'console', action: 'password_reset', incident_id: null, device_id: null, details: `${user.username} (npm run set-password)` });
  console.log(`Mot de passe de ${user.username} modifie. Ses sessions ouvertes sont fermees immediatement.`);
}
