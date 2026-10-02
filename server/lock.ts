import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Verrou d'instance unique : deux PSIM sur la meme base la corrompraient, et une restauration ne doit
 * jamais ecraser une base en cours d'utilisation. Le verrou est un fichier contenant le PID.
 */
export function lockPath(dataDir: string): string {
  return join(dataDir, 'psim.lock');
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // n'envoie aucun signal : teste seulement l'existence du processus
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // existe mais appartient a un autre compte
  }
}

/** PID du PSIM qui tient le verrou, ou null s'il n'y en a pas (un verrou orphelin est ignore). */
export function lockHolder(dataDir: string): number | null {
  const file = lockPath(dataDir);
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, 'utf8').trim());
  return alive(pid) ? pid : null;
}

/** Prend le verrou ; leve une exception si un autre PSIM vivant le tient. Renvoie la fonction de liberation. */
export function acquireLock(dataDir: string, pid = process.pid): () => void {
  const holder = lockHolder(dataDir);
  if (holder !== null && holder !== pid) {
    throw new Error(`Un autre PSIM utilise deja ce dossier de donnees (PID ${holder}). Deux instances corrompraient la base.`);
  }
  writeFileSync(lockPath(dataDir), String(pid));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(lockPath(dataDir), 'utf8').trim() === String(pid)) unlinkSync(lockPath(dataDir));
    } catch {
      // deja supprime
    }
  };
}
