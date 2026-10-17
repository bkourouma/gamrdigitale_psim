/**
 * Types partages par le code commun des modules de controle d'acces (acces-dahua, acces-zkteco).
 * Aucune dependance : seulement les types du contrat de la passerelle (gateway/src/module.ts).
 */
import type { AccessPassage, DeviceMessage } from '../../module.ts';

export type LogLevel = 'info' | 'warn' | 'error';
/** Meme forme que `ctx.log` du socle. Les textes passes ici ne contiennent JAMAIS de badge, de nom ni de mot de passe. */
export type LogFn = (level: LogLevel, text: string) => void;

/**
 * Envoi d'un message pour un equipement PSIM. Le socle (`ctx.emit`) renvoie `false` quand le message n'est PAS en file
 * (disque plein, arret, message rejete) : il faut alors le retenter plus tard. Un retour `void` ou `true` = en file.
 */
export type Emitter = (deviceId: string, msg: DeviceMessage) => boolean | void;

/** Vrai si le message est en file (tout sauf un `false` explicite). */
export function emitted(result: boolean | void): boolean {
  return result !== false;
}

/**
 * Passage tel que la marque le fournit au superviseur : les champs de `AccessPassage` sauf `v` et `controllerId`
 * (connus du superviseur), plus le numero de porte, l'heure du controleur et, facultatif, le curseur de recuperation.
 */
export type PassageInput = Omit<AccessPassage, 'v' | 'controllerId'> & {
  /** Numero de porte dans le controleur (cle de la table `doors` du superviseur). */
  doorNo: number;
  /** Heure DU CONTROLEUR a l'evenement (ms depuis 1970, entier). */
  ts: number;
  /**
   * Curseur de recuperation (F8) de CET evenement : chaine opaque choisie par la marque (no d'enregistrement Dahua,
   * estampille ZKTeco...). Memorise par le superviseur seulement quand le message est en file.
   */
  cursor?: string;
};

/**
 * Evenements d'etat d'une porte que la marque signale (traduits en evenements PSIM, voir supervisor.ts).
 * `duress` = contrainte (code ou doigt " sous menace ") : alarme `panic`, sans fin ni effet sur l'etat memorise de la porte.
 */
export type DoorEventKind = 'opened' | 'closed' | 'forced' | 'held_open' | 'held_open_end' | 'tamper' | 'tamper_end' | 'duress';
/** Evenements qui concernent tout le controleur (sabotage du boitier) : appliques a toutes ses portes. */
export type ControllerEventKind = 'tamper' | 'tamper_end';

/** Resultat de `ControllerSupervisor.submit` : dit a la marque s'il faut retenter. */
export type PassageOutcome =
  /** En file : memorise, curseur avance. */
  | 'sent'
  /** Deja emis auparavant (meme `eventId`) : rien envoye, rien a retenter. */
  | 'duplicate'
  /** Le socle a refuse le message (disque plein...) : a RETENTER plus tard (recuperation F8). */
  | 'refused'
  /** Porte inconnue ou donnees inutilisables : ne sera jamais envoye, inutile de retenter (la marque peut passer au suivant). */
  | 'ignored';
