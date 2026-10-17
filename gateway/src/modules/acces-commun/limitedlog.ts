/**
 * Journal limite : un meme message n'est pas repete plus d'une fois par minute (et au plus 30 lignes par minute en tout), pour
 * qu'un controleur bavard ou hostile ne sature pas le journal. Le nombre de messages masques est signale a la ligne suivante.
 * Le texte est nettoye (caracteres de controle) et borne : jamais de retour a la ligne venu du reseau dans le journal.
 * Rappel : ne JAMAIS passer ici un numero de badge, un nom ou un mot de passe.
 */
import { cleanText } from './messages.ts';
import type { LogFn, LogLevel } from './types.ts';

const EVERY_MS = 60_000;
const GLOBAL_MAX = 30;
const MAX_KEYS = 500;
const MAX_TEXT = 300;

export type LimitedLog = (key: string, level: LogLevel, text: string) => void;

export function createLimitedLog(log: LogFn, now: () => number): LimitedLog {
  const seen = new Map<string, { at: number; hidden: number }>();
  const global = { since: Number.NEGATIVE_INFINITY, count: 0, hidden: 0 };
  return (key, level, text) => {
    const t = now();
    const prev = seen.get(key);
    // Horloge revenue en arriere : l'entree est consideree comme expiree.
    if (prev && t >= prev.at && t - prev.at < EVERY_MS) {
      prev.hidden++;
      return;
    }
    if (t < global.since || t - global.since >= EVERY_MS) {
      if (global.hidden > 0) log('warn', `${global.hidden} message(s) du journal d'acces non affiche(s) la minute precedente (trop de messages)`);
      global.since = t;
      global.count = 0;
      global.hidden = 0;
    }
    if (global.count >= GLOBAL_MAX) {
      global.hidden++;
      return;
    }
    global.count++;
    if (seen.size >= MAX_KEYS) seen.clear();
    seen.set(key, { at: t, hidden: 0 });
    const shown = cleanText(text, MAX_TEXT) ?? '';
    log(level, prev && prev.hidden > 0 ? `${shown} (${prev.hidden} message(s) semblable(s) non affiche(s))` : shown);
  };
}
