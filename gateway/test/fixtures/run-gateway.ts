/**
 * Lanceur de la passerelle pour les essais de bout en bout (jamais livre) : meme chaine que gateway/src/main.ts
 * (loadConfig -> startRuntime -> arret propre), avec une seule difference : les modules sont cherches dans
 * gateway/test/fixtures/modules (main.ts ne lit que gateway/src/modules, volontairement : « jamais lu depuis la configuration »).
 *
 *   node gateway/test/fixtures/run-gateway.ts <config.json>
 *
 * Arret propre sur SIGINT / SIGTERM ou sur le message « shutdown » du processus parent (canal IPC), comme main.ts.
 */
import { join, resolve } from 'node:path';
import { ConfigError, loadConfig } from '../../src/config.ts';
import { createLogger } from '../../src/log.ts';
import { startRuntime } from '../../src/runtime.ts';

const MODULES = join(import.meta.dirname, 'modules');
const file = resolve(process.argv[2] ?? '');
const logger = createLogger({ file: null, level: 'info' });

let config;
try {
  config = loadConfig(file, { modulesDir: MODULES });
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : `Configuration illisible (${file}) : ${(err as Error).message}`);
  process.exit(2);
}
const runtime = await startRuntime({ config, logger, modulesDir: MODULES });

let leaving = false;
const leave = async (why: string) => {
  if (leaving) return;
  leaving = true;
  logger.log('info', `arret demande (${why})`);
  await runtime.stop();
  process.exit(0);
};
process.on('SIGINT', () => void leave('SIGINT'));
process.on('SIGTERM', () => void leave('SIGTERM'));
process.on('message', (m) => {
  if (m === 'shutdown') void leave('parent');
});
process.on('uncaughtException', (err) => {
  logger.log('error', `erreur fatale : ${err.stack ?? err.message}`);
  process.exit(1);
});
