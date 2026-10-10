/**
 * Module FACTICE des essais (jamais livre : il vit sous gateway/test/fixtures, hors du dossier des modules).
 * Il expose son contexte aux essais par `globalThis.gatewayProbes[key]`, et peut echouer a la demande :
 *   { "key": "a" }                       demarre normalement
 *   { "key": "b", "failTimes": 2 }       echoue aux 2 premiers demarrages
 *   { "key": "c", "failTimes": -1 }      echoue toujours
 *   { "key": "d", "throwInCreate": true } configuration refusee par create()
 *   { "key": "e", "emitOnStop": "D-01" } emet un dernier etat pendant son arret
 */
import type { GatewayModule, ModuleContext, ModuleFactory } from '../../../../src/module.ts';

export interface ProbeRecord {
  ctx: ModuleContext | null;
  starts: number;
  stops: number;
}

const registry = ((globalThis as { gatewayProbes?: Record<string, ProbeRecord> }).gatewayProbes ??= {});

export const create: ModuleFactory = (config) => {
  const key = String(config.key);
  if (config.throwInCreate) throw new Error('configuration refusee par le module');
  const rec = (registry[key] ??= { ctx: null, starts: 0, stops: 0 });
  const mod: GatewayModule = {
    name: 'probe',
    async start(ctx) {
      rec.starts++;
      const failTimes = Number(config.failTimes ?? 0);
      if (failTimes === -1 || rec.starts <= failTimes) throw new Error(`panne simulee au demarrage no ${rec.starts}`);
      rec.ctx = ctx;
    },
    async stop() {
      rec.stops++;
      if (typeof config.emitOnStop === 'string') rec.ctx?.emit(config.emitOnStop, { state: 'offline' });
    },
  };
  return mod;
};
