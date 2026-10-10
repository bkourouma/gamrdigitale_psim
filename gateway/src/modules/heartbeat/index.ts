/**
 * Module « heartbeat » : signe de vie de la passerelle elle-meme.
 *
 * Envoie `{"event":"heartbeat"}` pour l'equipement PSIM `deviceId` au demarrage puis toutes les `everyS` secondes. Declare
 * dans le PSIM comme un detecteur ordinaire (delai de silence PSIM_DETECTOR_TIMEOUT_S : 3 a 4 fois everyS), il fait apparaitre une passerelle
 * arretee, debranchee ou coupee du reseau comme un equipement « hors ligne ». Sert aussi a la mise en service : il valide
 * toute la chaine (compte MQTT, file disque, broker du PSIM) sans aucun equipement branche.
 *
 * Configuration : { "deviceId": "GW-01", "everyS": 60 }   (everyS : 1 a 86400, 60 par defaut)
 * C'est aussi l'exemple de reference d'un module (contrat : ../../module.ts).
 */
import type { GatewayModule, ModuleContext, ModuleFactory } from '../../module.ts';

const DEVICE_ID = /^[A-Za-z0-9_-]{1,32}$/;

export const create: ModuleFactory = (config) => {
  const known = ['deviceId', 'everyS'];
  for (const k of Object.keys(config)) if (!known.includes(k)) throw new Error(`heartbeat : cle inconnue « ${k} » (attendues : ${known.join(', ')})`);
  const deviceId = config.deviceId;
  if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) throw new Error('heartbeat : deviceId obligatoire (identifiant du detecteur PSIM, ex. « GW-01 »)');
  const everyS = config.everyS ?? 60;
  if (typeof everyS !== 'number' || !Number.isFinite(everyS) || everyS < 1 || everyS > 86_400) throw new Error('heartbeat : everyS entre 1 et 86400 secondes');

  let timer: NodeJS.Timeout | null = null;
  const mod: GatewayModule = {
    name: 'heartbeat',
    async start(ctx: ModuleContext) {
      const beat = () => ctx.emit(deviceId, { event: 'heartbeat' });
      beat();
      timer = setInterval(beat, everyS * 1000);
      ctx.log('info', `signe de vie pour ${deviceId} toutes les ${everyS} s`);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return mod;
};
