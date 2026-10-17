/**
 * Pilote de porte ZKTeco : traduit les trois operations du gestionnaire commun (`DoorDriver`, acces-commun/actuator.ts) en
 * commandes `CONTROL DEVICE` mises dans la file de l'appareil. Chaque operation ne se resout que quand l'appareil a CONFIRME
 * (`Return=0`) ; sinon `ActuatorFailure` (`timeout`, `refused_by_device`, `offline`).
 *
 *  - pulse        : ouverture momentanee, duree `pulseS` de la porte (1 a 254 s) ;
 *  - holdOpen     : ouverture continue (duree speciale 255) ;
 *  - restoreNormal: sortie relachee (duree 0) : la porte se referme et les badges fonctionnent de nouveau. JAMAIS « toujours
 *                   fermee » ;
 *  - stop         : absent (une serrure n'a rien a arreter) : le gestionnaire commun repond `not_supported`.
 * Format exact de la commande et valeurs 0 / 255 : A QUALIFIER (voir protocol.ts, `controlCommand`).
 */
import type { DoorDriver } from '../acces-commun/actuator.ts';
import type { DeviceCommands } from './commands.ts';
import { HOLD_OPEN, RELEASE, controlCommand } from './protocol.ts';
import type { ControlFormat } from './protocol.ts';

export interface ZktecoDriverOptions {
  format: ControlFormat;
  /** Duree d'impulsion par porte (secondes) ; 5 s si la porte n'est pas citee. */
  pulseS: ReadonlyMap<number, number>;
}

export const DEFAULT_PULSE_S = 5;

export function createZktecoDriver(commands: DeviceCommands, opts: ZktecoDriverOptions): DoorDriver {
  return {
    pulse: (doorNo) => commands.enqueue(controlCommand(opts.format, doorNo, opts.pulseS.get(doorNo) ?? DEFAULT_PULSE_S)),
    holdOpen: (doorNo) => commands.enqueue(controlCommand(opts.format, doorNo, HOLD_OPEN)),
    restoreNormal: (doorNo) => commands.enqueue(controlCommand(opts.format, doorNo, RELEASE)),
  };
}
