/**
 * Superviseur de la passerelle : la lance et la RELANCE (meme superviseur que le PSIM, scripts/supervise.ts).
 *
 *   npm run gateway:supervise [-- fichier-de-configuration]
 *
 *  - la passerelle s'arrete (plantage, processus tue) -> relance avec une pause croissante (1 s ... 60 s), sans jamais renoncer ;
 *  - la passerelle est BLOQUEE (son fichier d'etat status.json n'est plus reecrit depuis 90 s) -> arret force puis relance ;
 *  - arret volontaire (Ctrl+C, arret de la tache) -> arret propre de la passerelle (la file disque est conservee).
 * Lance par la tache planifiee de scripts/gateway-service.ps1.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createSupervisor } from '../../scripts/supervise.ts';
import { peekDataDir } from './config.ts';
import { configPathFrom } from './main.ts';
import { STATUS_FILE } from './runtime.ts';

/** Fichier d'etat frais (reecrit toutes les 10 s par une passerelle vivante) ? */
export function statusProbe(configFile: string, maxAgeMs = 90_000): () => Promise<{ ok: boolean; detail?: string }> {
  return async () => {
    const file = join(peekDataDir(configFile), STATUS_FILE);
    try {
      const s = JSON.parse(readFileSync(file, 'utf8')) as { at?: number };
      const age = Date.now() - Number(s.at);
      return Number.isFinite(age) && age <= maxAgeMs ? { ok: true } : { ok: false, detail: `etat non mis a jour depuis ${Math.round(age / 1000)} s` };
    } catch (err) {
      return { ok: false, detail: `etat illisible (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})` };
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = resolve(import.meta.dirname, '..', '..');
  const configFile = configPathFrom(process.argv.slice(2), process.env);
  const supervisor = createSupervisor({
    command: process.execPath,
    args: ['gateway/src/main.ts', configFile],
    cwd: root,
    env: process.env,
    probe: statusProbe(configFile),
    // Le superviseur commun parle du « PSIM » : ici, c'est la passerelle.
    log: (m) =>
      console.log(
        `${new Date().toISOString()} [supervision passerelle] ${m.replace(/\bPSIM (lance|arrete|bloque)\b/g, 'passerelle $1e').replace(/\bPSIM\b/g, 'passerelle')}`,
      ),
  });
  console.log(`[supervision passerelle] configuration ${configFile} ; Ctrl+C pour arreter`);
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
  process.on('SIGBREAK', leave);
}
