/**
 * Module FACTICE des essais (jamais livre) : un « module d'acces » qui pilote des actionneurs par `ctx.onActuator`.
 * Il expose son etat aux essais par `globalThis.gatewayDoors[key]` :
 *   { "key": "a", "actuators": ["GACHE-1"] }          enregistre un gestionnaire par actionneur
 *   { "key": "b", "actuators": [...], "twice": true }  enregistre deux fois le premier (doit echouer au demarrage)
 *   { "key": "c", "actuators": [...], "failTimes": 1 } enregistre puis echoue aux N premiers demarrages
 * `rec.behavior` decide de la reponse (par defaut : done) ; `rec.calls` garde les appels dans l'ordre ; `rec.events` melange
 * les appels et l'arret du module (ordre d'arret de la passerelle).
 */
import type { ActuatorOutcome, ActuatorRequest, GatewayModule, ModuleContext, ModuleFactory } from '../../../../src/module.ts';

export interface DoorRecord {
  ctx: ModuleContext | null;
  /** Tous les contextes recus, dans l'ordre des demarrages (le premier est celui d'une instance morte apres un redemarrage). */
  ctxs: ModuleContext[];
  starts: number;
  stops: number;
  calls: ActuatorRequest[];
  events: string[];
  behavior: (req: ActuatorRequest) => Promise<ActuatorOutcome> | ActuatorOutcome;
}

const registry = ((globalThis as { gatewayDoors?: Record<string, DoorRecord> }).gatewayDoors ??= {});

export const create: ModuleFactory = (config) => {
  const key = String(config.key);
  const rec = (registry[key] ??= { ctx: null, ctxs: [], starts: 0, stops: 0, calls: [], events: [], behavior: () => ({ result: 'done' }) });
  const mod: GatewayModule = {
    name: 'door',
    async start(ctx) {
      rec.starts++;
      rec.ctx = ctx;
      rec.ctxs.push(ctx);
      const ids = (config.actuators as string[] | undefined) ?? [];
      for (const id of ids) {
        ctx.onActuator(id, async (req) => {
          rec.calls.push(req);
          rec.events.push(`call:${req.action}`);
          return rec.behavior(req);
        });
      }
      if (config.twice && ids[0]) ctx.onActuator(ids[0], async () => ({ result: 'done' }));
      const failTimes = Number(config.failTimes ?? 0);
      if (failTimes > 0 && rec.starts <= failTimes) throw new Error(`panne simulee au demarrage no ${rec.starts}`);
    },
    async stop() {
      rec.stops++;
      rec.events.push('stop');
    },
  };
  return mod;
};
