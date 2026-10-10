/**
 * Mesure de l'etat des cameras reelles : un simple test de connexion reseau, regulier, vers l'adresse de chaque camera.
 * La mecanique (test TCP, serie d'echecs, historique) est commune avec les equipements d'infrastructure : targethealth.ts.
 *
 * Ce qui est fait : ouvrir une connexion TCP vers `host:port` de la source video (port ONVIF ou RTSP), puis la refermer.
 * Ce qui n'est PAS fait : aucun identifiant envoye, aucune image lue. Le test ne charge ni la camera ni le reseau, et ne
 * peut pas verrouiller un compte par erreur de mot de passe.
 *
 * Limite, a dire au client : une reponse prouve que l'APPAREIL repond (camera ou enregistreur), pas que l'image est bonne.
 * Derriere un enregistreur, toutes les voies partagent la meme adresse : elles tombent et reviennent ensemble.
 *
 * Les cameras simulees (sans ligne dans `camera_source`) n'ont rien a mesurer : elles n'ont pas d'historique. L'etat de
 * l'ecran du PSIM (`device.status`) n'est pas modifie : seul l'historique (history.ts) et le journal le sont.
 */
import type { DatabaseSync } from 'node:sqlite';
import { createTargetHealth, FAILURES_BEFORE_OFFLINE, tcpProbe } from './targethealth.ts';
import type { Probe, Target, TargetHealthStatus } from './targethealth.ts';

export { tcpProbe };
export type { Probe };
export const CAMERA_FAILURES_BEFORE_OFFLINE = FAILURES_BEFORE_OFFLINE;

export interface CameraHealthOptions {
  db: DatabaseSync;
  /** Ecrit dans le journal (camera_offline / camera_online). */
  audit: (action: 'camera_offline' | 'camera_online', deviceId: string, details: string) => void;
  everyMs: number;
  timeoutMs?: number;
  failuresBeforeOffline?: number;
  now?: () => number;
  /** Injectable pour les tests. */
  probe?: Probe;
}

export type CameraHealthStatus = TargetHealthStatus;

const cameraTargets = (db: DatabaseSync): Target[] =>
  db.prepare("SELECT c.device_id AS id, c.host, c.port FROM camera_source c JOIN device d ON d.id = c.device_id WHERE d.kind = 'camera'").all() as unknown as Target[];

export function createCameraHealth(options: CameraHealthOptions) {
  return createTargetHealth({
    ...options,
    targets: cameraTargets,
    closeUnmeasuredOf: 'camera',
    label: 'mesure des cameras',
    actions: { offline: 'camera_offline', online: 'camera_online' },
  });
}
