/**
 * Epoque d'un controleur (docs/CONTROLE-ACCES.md, par. 2, " Changement de controleur ") : quand un controleur est remplace
 * (memoire effacee), ses numeros d'enregistrement repartent de zero. L'installateur augmente alors `epoch` dans la
 * configuration du module ; l'identifiant d'evenement et la cle du curseur de recuperation (F8) en tiennent compte pour qu'un
 * ancien et un nouvel enregistrement portant le meme numero ne soient jamais confondus (doublon a tort, curseur " en avance ").
 *
 * Fonctions pures : aucune horloge, aucun disque.
 */
import { MAX_EVENT_ID, cleanEventId } from './messages.ts';

/** Epoque maximale acceptee (entier sur) : assez pour des siecles de remplacements, assez court pour tenir dans une cle. */
export const MAX_EPOCH = 999_999_999_999;

/** Cle de curseur : un identifiant de controleur, suivi au besoin de `~e<epoque>` (epoque >= 1, sans zero de tete). */
export const CURSOR_KEY = /^[A-Za-z0-9_-]{1,32}(?:~e[1-9][0-9]{0,11})?$/;

/** Vrai pour une epoque valide : entier de 0 a `MAX_EPOCH`. */
export function validEpoch(epoch: unknown): epoch is number {
  return typeof epoch === 'number' && Number.isInteger(epoch) && epoch >= 0 && epoch <= MAX_EPOCH;
}

/**
 * Identifiant d'evenement d'un enregistrement du controleur pour l'epoque donnee.
 *  - epoque 0 : `recNo` tel quel (aucun changement par rapport a l'existant) ;
 *  - sinon `<epoque>.<recNo>`, rendu conforme a `^[A-Za-z0-9._:-]{1,40}$` comme `cleanEventId` (au-dela de 40 caracteres ou avec
 *    un caractere interdit : debut nettoye + empreinte de l'ORIGINAL, donc deterministe et sans collision).
 * Leve `RangeError` si l'epoque n'est pas un entier >= 0 : c'est une erreur de configuration, a refuser au chargement du
 * module (utiliser `validEpoch`), pas une donnee du reseau.
 */
export function epochEventId(epoch: number, recNo: string): string {
  if (!validEpoch(epoch)) throw new RangeError("epoque invalide (entier de 0 a 999999999999)");
  const rec = String(recNo);
  if (epoch === 0) return rec;
  const id = cleanEventId(`${epoch}.${rec}`);
  // `cleanEventId` ne rend null que pour une entree vide ou non textuelle : impossible ici, mais on ne suppose rien.
  return id ?? `${epoch}.`.slice(0, MAX_EVENT_ID);
}

/**
 * Cle du curseur de recuperation (F8) d'un controleur pour une epoque : `controllerId` pour l'epoque 0, sinon
 * `<controllerId>~e<epoque>`. Chaque epoque a son curseur : le curseur d'une epoque n'est jamais compare a celui d'une autre
 * (le comparateur par defaut ne verrait pas qu'un numero " recule " parce que le controleur a ete remplace).
 * Leve `RangeError` si l'epoque ou l'identifiant sont invalides.
 */
export function cursorKey(controllerId: string, epoch: number): string {
  if (!validEpoch(epoch)) throw new RangeError("epoque invalide (entier de 0 a 999999999999)");
  if (typeof controllerId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(controllerId)) throw new RangeError('identifiant de controleur invalide');
  return epoch === 0 ? controllerId : `${controllerId}~e${epoch}`;
}
