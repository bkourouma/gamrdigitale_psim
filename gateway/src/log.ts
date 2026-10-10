/**
 * Journal de la passerelle : console, et fichier `<dossier de donnees>/logs/gateway.log` (rotation par taille).
 * Une ligne par message, jamais de retour a la ligne venu d'un equipement (pas de fausse ligne injectee dans le journal).
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type Level = 'info' | 'warn' | 'error';
const RANK: Record<Level, number> = { info: 0, warn: 1, error: 2 };

export interface Logger {
  log(level: Level, text: string): void;
}

export interface LoggerOptions {
  /** Fichier journal ; absent = console seulement. */
  file?: string | null;
  /** Niveau minimal journalise (info par defaut). */
  level?: Level;
  console?: boolean;
  /** Taille au-dela de laquelle le fichier est tourne (5 Mo), et nombre d'anciens fichiers gardes (3). */
  maxBytes?: number;
  keep?: number;
  /** Recepteur supplementaire (tests). */
  sink?: (level: Level, line: string) => void;
}

/** Retire les caracteres de controle (retours a la ligne compris) et borne la longueur. */
export function clean(text: unknown, max = 2000): string {
  const s = String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const min = RANK[opts.level ?? 'info'];
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = opts.keep ?? 3;
  const file = opts.file ?? null;
  let size = 0;
  // Fichier indisponible (disque plein, droits) : console seule, nouvel essai une minute plus tard.
  let brokenUntil = 0;
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      size = existsSync(file) ? statSync(file).size : 0;
    } catch {
      brokenUntil = Date.now() + 60_000;
    }
  }

  function rotate(path: string): void {
    for (let i = keep - 1; i >= 1; i--) {
      if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    }
    if (keep >= 1) renameSync(path, `${path}.1`);
    else rmSync(path, { force: true });
    size = 0;
  }

  return {
    log(level, text) {
      const lvl: Level = level in RANK ? level : 'info';
      if (RANK[lvl] < min) return;
      const line = `${new Date().toISOString()} [${lvl}] ${clean(text)}`;
      if (opts.console !== false) (lvl === 'info' ? console.log : console.error)(line);
      opts.sink?.(lvl, line);
      if (!file || Date.now() < brokenUntil) return;
      try {
        if (size > maxBytes) rotate(file);
        appendFileSync(file, `${line}\n`);
        size += Buffer.byteLength(line) + 1;
      } catch (err) {
        // Disque plein, droits : on continue en console plutot que d'arreter la passerelle.
        brokenUntil = Date.now() + 60_000;
        console.error(`${new Date().toISOString()} [error] journal fichier indisponible (${(err as Error).message}) : console seulement pendant une minute`);
      }
    },
  };
}
