import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';

export interface LoggerOptions {
  dir: string;
  /** Taille maximale d'un fichier avant rotation. */
  maxBytes?: number;
  /** Nombre de fichiers conserves (psim.log, psim.1.log, ...). */
  files?: number;
  now?: () => number;
}

/** Rotation par taille : psim.log -> psim.1.log -> ... ; le plus ancien est supprime. */
export function rotate(dir: string, files: number): void {
  const name = (n: number) => join(dir, n === 0 ? 'psim.log' : `psim.${n}.log`);
  const oldest = name(files - 1);
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let n = files - 2; n >= 0; n--) if (existsSync(name(n))) renameSync(name(n), name(n + 1));
}

/**
 * Duplique console.log/info/warn/error dans `dir/psim.log` (horodate, avec rotation). Indispensable
 * quand le PSIM tourne en service, sans fenetre de terminal. Renvoie une fonction de restauration.
 */
export function installFileLogger(options: LoggerOptions): () => void {
  const { dir } = options;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const files = Math.max(2, options.files ?? 5);
  const now = options.now ?? Date.now;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'psim.log');

  const write = (level: string, args: unknown[]): void => {
    try {
      if (existsSync(file) && statSync(file).size >= maxBytes) rotate(dir, files);
      const text = format(...(args as [unknown]));
      // Un message sur plusieurs lignes reste lisible : chaque ligne porte l'horodatage.
      const lines = text.split('\n').map((l) => `${new Date(now()).toISOString()} ${level.padEnd(5)} ${l}`);
      appendFileSync(file, `${lines.join('\n')}\n`);
    } catch {
      // Un probleme de journalisation ne doit jamais arreter le PSIM.
    }
  };

  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = (...args) => (original.log(...args), write('INFO', args));
  console.info = (...args) => (original.info(...args), write('INFO', args));
  console.warn = (...args) => (original.warn(...args), write('WARN', args));
  console.error = (...args) => (original.error(...args), write('ERROR', args));
  return () => Object.assign(console, original);
}
