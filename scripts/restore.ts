/**
 * Restauration d'une sauvegarde :
 *
 *   npm run restore -- backups/psim-20261002-120000          (affiche ce qui serait fait)
 *   npm run restore -- backups/psim-20261002-120000 --yes    (restaure)
 *
 * Le PSIM doit etre ARRETE. La sauvegarde est verifiee d'abord. L'ancien dossier de donnees est mis de cote
 * (data.before-restore-...), jamais supprime : une mauvaise restauration reste rattrapable.
 */
import { resolve } from 'node:path';
import { restoreBackup, verifyBackup } from '../server/backup.ts';
import { config } from '../server/config.ts';
import { lockHolder } from '../server/lock.ts';

const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(root, config.dataDir);
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const confirmed = args.includes('--yes');

if (!target) {
  console.error('Usage : npm run restore -- <dossier-de-sauvegarde> [--yes]');
  process.exit(2);
}
const backupDir = resolve(target);

const check = verifyBackup(backupDir);
if (!check.ok || !check.manifest) {
  console.error(`Sauvegarde invalide, rien n'a ete modifie :\n  - ${check.problems.join('\n  - ')}`);
  process.exit(1);
}
const holder = lockHolder(dataDir);
if (holder !== null) {
  console.error(`Le PSIM tourne (PID ${holder}) : arretez-le avant de restaurer.`);
  process.exit(1);
}

const when = new Date(check.manifest.createdAt).toLocaleString('fr-FR');
console.log(`Sauvegarde du ${when} : ${check.manifest.files.length} fichiers, verifiee.`);
console.log(`Elle remplacera le dossier de donnees : ${dataDir}`);
console.log('(l\'ancien dossier sera conserve a cote, jamais supprime)');
if (!confirmed) {
  console.log('\nRien n\'a ete modifie. Relancez avec --yes pour restaurer.');
  process.exit(0);
}
try {
  const result = restoreBackup({ backupDir, dataDir });
  console.log(`\nRestauration terminee (${result.files} fichiers).`);
  if (result.previousMovedTo) console.log(`Ancien etat conserve dans : ${result.previousMovedTo}`);
  console.log(result.keyKept ? 'La cle de chiffrement des cameras est en place.' : 'ATTENTION : aucune cle de chiffrement : il faudra ressaisir les mots de passe des cameras.');
  console.log('Vous pouvez redemarrer le PSIM.');
} catch (err) {
  console.error(`Restauration impossible : ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
