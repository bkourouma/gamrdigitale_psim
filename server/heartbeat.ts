/**
 * Supervision externe (« dead man's switch »). Un PSIM qui meurt ne peut pas prevenir qu'il est mort : c'est donc
 * un service EXTERNE qui doit s'inquieter de ne plus rien recevoir (healthchecks.io, Uptime Kuma, un monitoring
 * maison...). Le PSIM envoie un simple signal HTTP regulier, sans aucune donnee du site :
 *
 *   - sante OK        -> GET <url>
 *   - sante degradee  -> GET <url>/fail   (convention healthchecks.io ; ignore sans effet ailleurs)
 *
 * L'adresse contient souvent un jeton : elle n'apparait jamais en entier (journaux, ecran), seul l'hote est affiche.
 * Un echec d'envoi ne gene jamais le PSIM : il est compte, signale une fois par changement d'etat, et reessaye.
 */

export interface HeartbeatStatus {
  configured: boolean;
  /** Hote seul (jamais le chemin, qui peut contenir un jeton). */
  host: string | null;
  everyS: number;
  lastOkAt: number | null;
  lastFailAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  sent: number;
}

export interface HeartbeatOptions {
  url: string;
  everyMs: number;
  health: () => { ok: boolean; reason?: string };
  timeoutMs?: number;
  now?: () => number;
  /** Injectable pour les tests. */
  fetch?: (url: string, init: { method: string; signal: AbortSignal; redirect: 'error' }) => Promise<{ ok: boolean; status: number }>;
  /** Appele quand l'etat change (premier echec apres des succes, ou reprise) : jamais a chaque tentative. */
  onChange?: (state: 'failing' | 'recovered', status: HeartbeatStatus) => void;
}

export function validateHeartbeatUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'doit commencer par https://';
    if (u.username || u.password) return "ne doit pas contenir d'identifiants (utilisez un jeton dans le chemin)";
    return null;
  } catch {
    return 'adresse invalide';
  }
}

export function createHeartbeat(options: HeartbeatOptions) {
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const configured = options.url !== '' && options.everyMs > 0 && validateHeartbeatUrl(options.url) === null;
  let host: string | null = null;
  try {
    host = configured ? new URL(options.url).host : null;
  } catch {
    host = null;
  }
  const state: HeartbeatStatus = { configured, host, everyS: Math.round(options.everyMs / 1000), lastOkAt: null, lastFailAt: null, lastError: null, consecutiveFailures: 0, sent: 0 };
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;

  /** Une tentative. Ne leve jamais d'exception. */
  async function ping(): Promise<boolean> {
    if (!configured || inFlight) return false;
    inFlight = true;
    const healthy = (() => {
      try {
        return options.health().ok;
      } catch {
        return false;
      }
    })();
    const target = healthy ? options.url : `${options.url.replace(/\/+$/, '')}/fail`;
    try {
      // `redirect: 'error'` : on ne suit jamais une redirection (l'adresse porte un jeton).
      const res = await doFetch(target, { method: 'GET', signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.sent++;
      const wasFailing = state.consecutiveFailures > 0;
      state.lastOkAt = now();
      state.consecutiveFailures = 0;
      state.lastError = null;
      if (wasFailing) options.onChange?.('recovered', { ...state });
      return true;
    } catch (err) {
      const first = state.consecutiveFailures === 0;
      state.consecutiveFailures++;
      state.lastFailAt = now();
      // Le message d'erreur d'une requete peut citer l'adresse : on n'en garde que la nature.
      state.lastError = err instanceof Error ? (err.name === 'TimeoutError' ? `delai de ${timeoutMs / 1000} s depasse` : err.message.replace(/https?:\/\/\S+/g, '[adresse]').slice(0, 120)) : 'echec';
      if (first && state.lastOkAt !== null) options.onChange?.('failing', { ...state });
      return false;
    } finally {
      inFlight = false;
    }
  }

  function start(): void {
    if (!configured || timer) return;
    void ping(); // un premier signal tout de suite : on sait vite si l'adresse est bonne
    timer = setInterval(() => void ping(), options.everyMs);
    timer.unref();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, ping, status: (): HeartbeatStatus => ({ ...state }) };
}

export type Heartbeat = ReturnType<typeof createHeartbeat>;
