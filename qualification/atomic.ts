/**
 * Ecritures atomiques de fichiers : on ecrit dans un fichier temporaire voisin, on force l'ecriture sur le disque, puis on
 * renomme par-dessus la cible. Un arret brutal laisse donc soit l'ancien fichier, soit le nouveau, jamais un fichier tronque.
 */
import { closeSync, existsSync, fsyncSync, linkSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Remplace (ou cree) `file` par `content`. Le fichier temporaire est nettoye en cas d'echec. */
export function writeFileAtomic(file: string, content: string): void {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'wx');
    writeSync(fd, content, null, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameWithRetry(tmp, file);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // deja ferme
      }
    }
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // rien de plus a faire
    }
    throw err;
  }
}

/**
 * Cree `file` seulement s'il n'existe pas (echoue sinon) : sert aux fichiers de resultats, qu'on n'ecrase jamais.
 * Le contenu est d'abord ecrit atomiquement ailleurs puis lie au nom final : jamais de fichier de resultat a moitie ecrit.
 */
export function createFileExclusive(file: string, content: string): void {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.new`);
  writeFileAtomic(tmp, content);
  try {
    linkSync(tmp, file); // echoue (EEXIST) si le fichier existe deja : jamais d'ecrasement, meme en cas de course
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // deja disparu
    }
  }
}

// Sous Windows, un antivirus ou un indexeur peut garder le fichier cible ouvert une fraction de seconde.
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      const until = Date.now() + 20 * (attempt + 1);
      while (Date.now() < until) {
        // attente active tres courte (appel synchrone voulu)
      }
    }
  }
}
