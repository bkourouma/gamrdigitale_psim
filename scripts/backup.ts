/**
 * Sauvegarde manuelle ou planifiee (tache planifiee Windows, cron) :
 *
 *   npm run backup                  sauvegarde dans ./backups (ou PSIM_BACKUP_DIR)
 *   npm run backup -- --with-key    inclut aussi data/secret.key (cle des mots de passe de cameras)
 *   npm run backup -- --keep 30     conserve les 30 dernieres sauvegardes
 *
 * Peut tourner pendant que le PSIM fonctionne : la copie de la base est coherente.
 */
import { join, resolve } from 'node:path';
import { createBackup, pruneBackups, verifyBackup } from '../server/backup.ts';
import { config } from '../server/config.ts';
import { openDb } from '../server/db.ts';

const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(root, config.dataDir);
const backupDir = resolve(root, config.backup.dir || 'backups');
const args = process.argv.slice(2);
const keepArg = args.indexOf('--keep');
const keep = keepArg >= 0 ? Number(args[keepArg + 1]) : config.backup.keep;
const withKey = args.includes('--with-key');

try {
  const db = openDb(join(dataDir, 'psim.db'));
  const result = createBackup({ db, dataDir, backupDir, includeKey: withKey });
  db.close();
  const check = verifyBackup(result.dir);
  if (!check.ok) throw new Error(`verification echouee : ${check.problems.join(' ; ')}`);
  const removed = Number.isFinite(keep) ? pruneBackups(backupDir, keep) : [];
  console.log(`Sauvegarde ${result.name} : ${(result.bytes / 1024 / 1024).toFixed(1)} Mo, ${result.files} fichiers, verifiee (SHA-256 + integrite de la base).`);
  console.log(`Dossier : ${result.dir}`);
  if (removed.length) console.log(`${removed.length} ancienne(s) sauvegarde(s) supprimee(s) (on garde les ${keep} dernieres).`);
  if (!withKey) {
    console.log('\nLa cle de chiffrement des mots de passe de cameras (data/secret.key) n\'est PAS dans cette sauvegarde.');
    console.log('Conservez-la a part, dans un coffre : sans elle, il faudra ressaisir les mots de passe des cameras apres une restauration sur une autre machine.');
  }
  console.log('\nRappel : une sauvegarde sur le meme disque ne protege pas d\'une panne de disque. Copiez ce dossier ailleurs (disque externe, reseau).');
} catch (err) {
  console.error(`Sauvegarde impossible : ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
