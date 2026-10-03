/**
 * Retire la double authentification d'un compte (telephone perdu, enrolement detourne), SANS passer par l'interface :
 * c'est le recours quand plus aucun administrateur ne peut se connecter.
 *
 *   npm run reset-2fa -- admin
 *   npm run reset-2fa -- --list
 *
 * Ses sessions ouvertes sont fermees, ses codes de secours supprimes ; la 2FA reste imposee a sa prochaine connexion si la
 * regle PSIM_REQUIRE_2FA s'applique a son role. L'action est inscrite au journal (auteur « console »). Elle exige un acces a
 * la machine : c'est voulu, c'est ce qui la distingue d'un recours accessible depuis le reseau.
 */
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { appendSealed } from '../server/auditchain.ts';
import { config } from '../server/config.ts';
import { openDb } from '../server/db.ts';

/** Renvoie vrai si le compte existait et avait une 2FA. */
export function resetTwoFactor(db: DatabaseSync, username: string, now = Date.now()): boolean {
  const row = db.prepare('SELECT totp_secret FROM app_user WHERE username = ?').get(username) as { totp_secret: string | null } | undefined;
  if (!row) return false;
  const had = row.totp_secret !== null;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE app_user SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, session_epoch = session_epoch + 1 WHERE username = ?').run(username);
    db.prepare('DELETE FROM recovery_code WHERE username = ?').run(username);
    appendSealed(db, { ts: now, actor: 'console', action: 'totp_reset', incident_id: null, device_id: null, details: username });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return had;
}

export function main(args: string[], dataDir = join(resolve(import.meta.dirname, '..'), config.dataDir)): number {
  const db = openDb(join(dataDir, 'psim.db'));
  try {
    const arg = args[0];
    if (arg === '--list') {
      for (const u of db.prepare('SELECT username, role, totp_enabled_at FROM app_user ORDER BY username').all() as { username: string; role: string; totp_enabled_at: number | null }[]) {
        console.log(`${u.username.padEnd(20)} ${u.role.padEnd(9)} 2FA : ${u.totp_enabled_at ? 'activee' : 'non'}`);
      }
      return 0;
    }
    if (!arg || arg.startsWith('--')) {
      console.error('Usage : npm run reset-2fa -- <utilisateur>   (npm run reset-2fa -- --list pour les voir)');
      return 2;
    }
    if (!resetTwoFactorExists(db, arg)) {
      console.error(`Compte inconnu : ${arg}`);
      return 2;
    }
    const had = resetTwoFactor(db, arg);
    console.log(had ? `Double authentification de ${arg} retiree. Ses sessions sont fermees ; il devra la reactiver a sa prochaine connexion.` : `${arg} n'avait pas de double authentification ; ses sessions ont ete fermees.`);
    return 0;
  } finally {
    db.close();
  }
}

const resetTwoFactorExists = (db: DatabaseSync, username: string): boolean => Boolean(db.prepare('SELECT 1 AS x FROM app_user WHERE username = ?').get(username));

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = main(process.argv.slice(2));
}
