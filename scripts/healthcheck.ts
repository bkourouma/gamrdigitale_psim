/**
 * Controle de sante, a lancer regulierement (tache planifiee toutes les minutes) :
 *
 *   npm run healthcheck                  affiche l'etat, code de sortie 0 (sain) ou 1
 *   npm run healthcheck -- --restart 3   apres 3 echecs CONSECUTIFS, arrete le PSIM bloque :
 *                                        le superviseur (service, tache planifiee) le relance
 *
 * Un PSIM qui plante est relance par le superviseur ; celui-ci traite le cas plus sournois d'un PSIM qui
 * tourne encore mais ne fait plus rien (boucle de controle bloquee, plus d'escalade ni de detection).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import { config } from '../server/config.ts';
import { lockHolder } from '../server/lock.ts';

export interface Probe {
  ok: boolean;
  detail: string;
}

/** Interroge /healthz. Un certificat auto-signe est accepte seulement s'il s'agit de celui configure. */
export function probe(url: string, ca?: Buffer, timeoutMs = 8000): Promise<Probe> {
  return new Promise((resolveProbe) => {
    const u = new URL(url);
    const request = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, ca, servername: u.hostname === '127.0.0.1' ? 'localhost' : u.hostname, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolveProbe({ ok: res.statusCode === 200, detail: `HTTP ${res.statusCode} ${body.slice(0, 120)}` }));
    });
    req.on('timeout', () => (req.destroy(), resolveProbe({ ok: false, detail: `aucune reponse en ${timeoutMs / 1000} s` })));
    req.on('error', (err) => resolveProbe({ ok: false, detail: (err as NodeJS.ErrnoException).code ?? err.message }));
    req.end();
  });
}

/** Compte les echecs consecutifs ; renvoie le nouveau total et s'il faut redemarrer. */
export function nextState(previousFailures: number, healthy: boolean, restartAfter: number): { failures: number; restart: boolean } {
  const failures = healthy ? 0 : previousFailures + 1;
  return { failures, restart: restartAfter > 0 && failures >= restartAfter };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const dataDir = resolve(import.meta.dirname, '..', config.dataDir);
  const args = process.argv.slice(2);
  const restartIdx = args.indexOf('--restart');
  const restartAfter = restartIdx >= 0 ? Number(args[restartIdx + 1]) : 0;
  const tls = config.tls.cert && config.tls.key;
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  const url = `${tls ? 'https' : 'http'}://${host}:${config.port}/healthz`;

  const result = await probe(url, tls ? readFileSync(config.tls.cert) : undefined);
  console.log(`${result.ok ? 'SAIN' : 'DEFAILLANT'} - ${url} - ${result.detail}`);

  if (restartAfter > 0) {
    const stateFile = join(dataDir, 'healthcheck.state');
    let previous = 0;
    try {
      previous = Number(readFileSync(stateFile, 'utf8')) || 0;
    } catch {
      // premier passage
    }
    const state = nextState(previous, result.ok, restartAfter);
    writeFileSync(stateFile, String(state.failures));
    if (!result.ok) console.log(`Echec ${state.failures}/${restartAfter} avant redemarrage.`);
    if (state.restart) {
      const pid = lockHolder(dataDir);
      if (pid === null) console.log("Aucun PSIM a arreter (le superviseur doit le demarrer).");
      else {
        console.log(`PSIM bloque : arret du processus ${pid} (le superviseur le relancera).`);
        process.kill(pid);
        writeFileSync(stateFile, '0');
      }
    }
  }
  process.exit(result.ok ? 0 : 1);
}
