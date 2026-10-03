/**
 * Superviseur portable : lance le PSIM et le relance.
 *
 *   npm run supervise
 *
 * Il couvre ce que ne fait pas un simple « Restart=always » :
 *  - le PSIM PLANTE ou est tue -> relance avec une pause croissante (1 s, 2 s, 4 s... 60 s au plus), remise a 1 s
 *    des qu'il a tenu 10 minutes. Il ne renonce JAMAIS : un systeme de securite qui reste arrete est pire qu'un
 *    systeme qui replante en boucle (et chaque redemarrage est tracé et notifié par le PSIM) ;
 *  - le PSIM est BLOQUE (il tourne mais /healthz ne repond plus ou signale une boucle de controle figee) ->
 *    apres 3 echecs consecutifs, il est arrete de force puis relance ;
 *  - arret volontaire (Ctrl+C, arret du service) -> demande au PSIM de s'arreter proprement (message IPC, valable
 *    aussi sous Windows), puis le force au bout de 10 s. Le superviseur ne relance alors rien.
 *
 * Sous Windows, a lancer au demarrage de la machine (tache planifiee) ; sous Linux, systemd fait deja la relance :
 * ce superviseur reste utile pour la detection des blocages. Voir README, « Reprise automatique ».
 */
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface SupervisorOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Sonde de sante ; absente = on ne surveille que les plantages. */
  probe?: () => Promise<{ ok: boolean; detail?: string }>;
  probeEveryMs?: number;
  /** Delai apres le lancement pendant lequel on ne sonde pas (le PSIM demarre). */
  graceMs?: number;
  failuresBeforeKill?: number;
  backoff?: { minMs: number; maxMs: number; resetAfterMs: number };
  /** Delai laisse au PSIM pour s'arreter proprement avant de le forcer. */
  stopTimeoutMs?: number;
  log?: (message: string) => void;
  now?: () => number;
  /** Injectables pour les tests. */
  spawn?: typeof nodeSpawn;
  kill?: (child: ChildProcess) => void;
}

/** Arret force, y compris des processus enfants (ffmpeg) : `taskkill /T` sous Windows. */
function forceKill(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

export function createSupervisor(options: SupervisorOptions) {
  const log = options.log ?? ((m) => console.log(`[supervision] ${m}`));
  const now = options.now ?? Date.now;
  const spawn = options.spawn ?? nodeSpawn;
  const kill = options.kill ?? forceKill;
  const backoff = options.backoff ?? { minMs: 1000, maxMs: 60_000, resetAfterMs: 10 * 60_000 };
  const probeEveryMs = options.probeEveryMs ?? 30_000;
  const graceMs = options.graceMs ?? 60_000;
  const failuresBeforeKill = options.failuresBeforeKill ?? 3;
  const stopTimeoutMs = options.stopTimeoutMs ?? 10_000;

  let child: ChildProcess | null = null;
  let startedAt = 0;
  let delay = backoff.minMs;
  let stopping = false;
  let failures = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let probeTimer: NodeJS.Timeout | null = null;
  let probing = false;
  let exited: (() => void) | null = null;
  const stats = { starts: 0, crashes: 0, hangKills: 0 };

  function launch(): void {
    restartTimer = null;
    if (stopping) return;
    failures = 0;
    startedAt = now();
    stats.starts++;
    // Canal IPC : permet de demander un arret propre (le signal SIGTERM n'existe pas sous Windows).
    const c = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    child = c;
    log(`PSIM lance (processus ${c.pid ?? '?'}), lancement n°${stats.starts}`);
    // Fin du processus, qu'il se soit arrete ou n'ait jamais pu demarrer (commande introuvable : « error » sans « exit »).
    let ended = false;
    const onEnd = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (ended) return;
      ended = true;
      if (child === c) child = null;
      if (stopping) {
        exited?.();
        return;
      }
      stats.crashes++;
      const uptime = now() - startedAt;
      // Une longue periode de bon fonctionnement efface l'historique des pannes : la prochaine repart de la pause minimale.
      if (uptime >= backoff.resetAfterMs) delay = backoff.minMs;
      log(`PSIM arrete (${signal ?? `code ${code}`}) apres ${Math.round(uptime / 1000)} s : relance dans ${delay >= 1000 ? `${delay / 1000} s` : `${delay} ms`}`);
      restartTimer = setTimeout(launch, delay);
      delay = Math.min(delay * 2, backoff.maxMs);
    };
    c.on('error', (err) => {
      log(c.pid === undefined ? `lancement impossible : ${err.message}` : `erreur du processus : ${err.message}`);
      if (c.pid === undefined) onEnd(null, null); // jamais demarre
    });
    c.once('exit', onEnd);
  }

  async function checkHealth(): Promise<void> {
    if (!options.probe || probing || !child || stopping) return;
    if (now() - startedAt < graceMs) return;
    probing = true;
    const target = child;
    try {
      const result = await options.probe();
      if (child !== target || stopping) return; // il a ete relance entre-temps
      if (result.ok) {
        failures = 0;
        return;
      }
      failures++;
      log(`sante defaillante ${failures}/${failuresBeforeKill}${result.detail ? ` (${result.detail})` : ''}`);
      if (failures >= failuresBeforeKill) {
        stats.hangKills++;
        log('PSIM bloque : arret force, puis relance');
        kill(target); // le gestionnaire d'arret relance
      }
    } catch (err) {
      log(`sonde en erreur : ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      probing = false;
    }
  }

  function start(): void {
    stopping = false;
    launch();
    if (options.probe) {
      probeTimer = setInterval(() => void checkHealth(), probeEveryMs);
      probeTimer.unref();
    }
  }

  /** Arret volontaire : demande un arret propre, force au bout de `stopTimeoutMs`. Ne relance rien. */
  async function stop(): Promise<void> {
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (probeTimer) clearInterval(probeTimer);
    const c = child;
    if (!c || c.pid === undefined) return; // rien a arreter (jamais demarre)
    await new Promise<void>((resolveStop) => {
      exited = resolveStop;
      const force = setTimeout(() => {
        log("arret propre non obtenu dans les delais : arret force");
        kill(c);
      }, stopTimeoutMs);
      c.once('exit', () => clearTimeout(force));
      try {
        // Le canal peut deja etre ferme : l'erreur arrive alors dans le rappel, pas en exception.
        c.send('shutdown', (err) => {
          if (err) kill(c);
        });
      } catch {
        kill(c);
      }
    });
    log('PSIM arrete');
  }

  return { start, stop, stats: () => ({ ...stats }), running: () => child !== null, checkHealth };
}

export type Supervisor = ReturnType<typeof createSupervisor>;

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { config } = await import('../server/config.ts');
  const { probe } = await import('./healthcheck.ts');
  const root = resolve(import.meta.dirname, '..');
  const tls = config.tls.cert && config.tls.key;
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  const url = `${tls ? 'https' : 'http'}://${host}:${config.port}/healthz`;
  const ca = tls ? readFileSync(config.tls.cert) : undefined;

  const supervisor = createSupervisor({
    command: process.execPath,
    // Meme fichier d'environnement que le superviseur (PSIM_ENV_FILE, defini par `init-production`), sinon .env.
    args: [`--env-file-if-exists=${process.env.PSIM_ENV_FILE ?? '.env'}`, 'server/index.ts'],
    cwd: root,
    env: process.env,
    probe: () => probe(url, ca),
  });
  console.log(`[supervision] surveillance de ${url} (arret force apres 3 echecs consecutifs) ; Ctrl+C pour arreter`);
  supervisor.start();
  let leaving = false;
  const leave = async () => {
    if (leaving) return;
    leaving = true;
    await supervisor.stop();
    process.exit(0);
  };
  process.on('SIGINT', leave);
  process.on('SIGTERM', leave);
}
