/**
 * Module FACTICE des essais de bout en bout (jamais livre) : comme `door`, mais il tourne dans un AUTRE PROCESSUS que le test,
 * donc il consigne chaque appel dans un fichier (une ligne JSON par appel) que le test relit.
 *   { "actuators": ["GACHE-1", ...], "callsFile": "C:\...\calls.jsonl" }
 * Chaque appel de `ctx.onActuator` repond `done` tout de suite ; `t` est l'heure du module (ctx.now()), comparable a celle du test
 * (meme machine).
 */
import { appendFileSync } from 'node:fs';
import type { GatewayModule, ModuleFactory } from '../../../../src/module.ts';

export const create: ModuleFactory = (config) => {
  const file = String(config.callsFile);
  const mod: GatewayModule = {
    name: 'doorlog',
    async start(ctx) {
      for (const id of (config.actuators as string[] | undefined) ?? []) {
        ctx.onActuator(id, async (req) => {
          appendFileSync(file, `${JSON.stringify({ t: ctx.now(), ...req })}\n`);
          return { result: 'done' };
        });
      }
    },
    async stop() {
      // rien a arreter
    },
  };
  return mod;
};
