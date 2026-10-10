/**
 * Passerelle GAMR : point d'entree.
 *
 *   npm run gateway                                   configuration gateway/config.json
 *   npm run gateway -- C:\gamr\passerelle.json        autre fichier (ou variable GAMR_GATEWAY_CONFIG)
 *   npm run gateway:check-config [-- fichier]         verifie la configuration et la connexion au PSIM, sans rien lancer
 *
 * Codes de sortie : 0 normal ; 1 erreur d'execution ou PSIM injoignable (verification) ; 2 configuration invalide.
 * Arret propre sur Ctrl+C, SIGTERM, ou message « shutdown » du superviseur (gateway/src/supervise.ts).
 */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mqtt from 'mqtt';
import { ConfigError, loadConfig, moduleEntry, redactUrl } from './config.ts';
import type { GatewayConfig } from './config.ts';
import { createLogger } from './log.ts';
import type { ModuleFactory } from './module.ts';
import { startRuntime } from './runtime.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
export const DEFAULT_CONFIG = join(ROOT, 'gateway', 'config.json');

export function configPathFrom(argv: string[], env: NodeJS.ProcessEnv): string {
  const positional = argv.filter((a) => !a.startsWith('--'));
  return resolve(positional[0] ?? env.GAMR_GATEWAY_CONFIG ?? DEFAULT_CONFIG);
}

/** Verification sans lancement : configuration, chaque module (create), connexion et authentification au PSIM. */
async function check(config: GatewayConfig): Promise<number> {
  let code = 0;
  console.log(`Configuration : ${config.file}`);
  console.log(`  passerelle   : ${config.name}`);
  console.log(`  PSIM         : ${redactUrl(config.psim.url)} ; compte ${config.psim.username} ; mot de passe : ${config.psim.passwordSource}`);
  console.log(`  donnees      : ${config.dataDir}`);
  console.log(`  file        : ${config.queue.maxMessages} messages / ${config.queue.maxBytes} octets au plus`);
  for (const spec of config.modules) {
    try {
      const file = moduleEntry(spec.name);
      if (!file) throw new Error('introuvable');
      const mod = (await import(pathToFileURL(file).href)) as { create?: ModuleFactory };
      if (typeof mod.create !== 'function') throw new Error("pas de fonction create exportee");
      mod.create(structuredClone(spec.config));
      console.log(`  module       : ${spec.label} (${spec.name}) : configuration acceptee`);
    } catch (err) {
      code = 2;
      console.log(`  module       : ${spec.label} (${spec.name}) : ERREUR ${(err as Error).message}`);
    }
  }
  try {
    const c = await mqtt.connectAsync(config.psim.url, {
      username: config.psim.username,
      password: config.psim.password,
      clientId: `${config.psim.clientId}-check`,
      reconnectPeriod: 0,
      connectTimeout: 8000,
      protocolVersion: 4,
      ...(config.psim.ca ? { ca: config.psim.ca } : {}),
    });
    await c.endAsync();
    console.log('  connexion    : PSIM joignable, identifiants acceptes');
  } catch (err) {
    const e = err as Error & { code?: number };
    if (code === 0) code = 1;
    console.log(`  connexion    : ECHEC ${e.code === 4 || e.code === 5 ? 'identifiant ou mot de passe refuse (voir PSIM_MQTT_GATEWAYS cote PSIM)' : e.message}`);
  }
  console.log(code === 0 ? 'OK' : 'A corriger avant la mise en service.');
  return code;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const file = configPathFrom(argv, process.env);
  let config: GatewayConfig;
  try {
    config = loadConfig(file);
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : `Configuration illisible (${file}) : ${(err as Error).message}`);
    if (err instanceof ConfigError && err.errors[0] === 'fichier introuvable') console.error("Copier gateway/config.example.json en gateway/config.json, ou indiquer le chemin : npm run gateway -- C:\\chemin\\config.json");
    process.exit(2);
  }
  if (argv.includes('--check')) process.exit(await check(config));

  const logger = createLogger({ file: config.log.file ? join(config.dataDir, 'logs', 'gateway.log') : null, level: config.log.level });
  let runtime: Awaited<ReturnType<typeof startRuntime>>;
  try {
    runtime = await startRuntime({ config, logger });
  } catch (err) {
    logger.log('error', `demarrage impossible : ${(err as Error).message}`);
    process.exit(1);
  }

  let leaving = false;
  const leave = async (why: string) => {
    if (leaving) return;
    leaving = true;
    logger.log('info', `arret demande (${why})`);
    const force = setTimeout(() => {
      logger.log('error', 'arret propre trop long : sortie forcee (la file disque est intacte)');
      process.exit(1);
    }, 30_000);
    force.unref();
    await runtime.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void leave('SIGINT'));
  process.on('SIGTERM', () => void leave('SIGTERM'));
  process.on('SIGBREAK', () => void leave('SIGBREAK'));
  process.on('message', (m) => {
    if (m === 'shutdown') void leave('superviseur');
  });
  process.on('unhandledRejection', (err) => logger.log('error', `promesse rejetee non traitee : ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
  process.on('uncaughtException', (err) => {
    // Etat incertain : on sort, le superviseur relance ; les messages acceptes sont deja sur disque.
    logger.log('error', `erreur fatale : ${err.stack ?? err.message} ; arret (relance par le superviseur)`);
    process.exit(1);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
