/**
 * Regles d'acces (F15) et armement des portes (F14) : TYPES ET INTERFACES PARTAGES, figes par le superviseur du lot. Aucun code
 * d'execution ici (que des types et des constantes). Ce fichier est le contrat entre :
 *  - `accessarming.ts`  : armement des portes (F14) ;
 *  - `accessrules.ts`   : regles d'acces (F15), branchees dans `rules.ts` ;
 *  - `access.ts`        : journal des passages (points d'accroche minimes) ;
 *  - `engine.ts`        : application d'une pre-alarme decidee apres coup (`AccessHookResult.raise`) ;
 *  - `web/*.js`         : formes JSON des vues.
 * Le modifier = decision du superviseur.
 */
import type { Window } from './arming.ts';
import type { AccessDirection, AccessMethod, AccessReason, AccessResult } from './access.ts';

// ---- Evenements ajoutes a server/sources.ts (effet et libelle) -------------------------------------------------------------------

/**
 * Pre-alarmes (`prealarm`) pour une gravite « warning », alarmes (`alarm`) pour « critical » : meme principe que `face_noticed` /
 * `face_banned`. Libelles (EVENT_LABEL, a recopier dans `web/sources.js`) :
 *  - door_opened_armed        prealarm « Ouverture pendant l'armement »
 *  - badge_offhours_noticed   prealarm « Badge hors horaires signalé »        / badge_offhours  alarm « Badge utilisé hors de ses horaires »
 *  - badge_watched_noticed    prealarm « Badge surveillé signalé »            / badge_watched   alarm « Badge surveillé utilisé »
 *  - denials_spread_noticed   prealarm « Refus sur plusieurs portes signalés » / denials_spread  alarm « Refus sur plusieurs portes »
 */
export const ACCESS_RULE_EVENTS = [
  'badge_offhours', 'badge_offhours_noticed', 'badge_watched', 'badge_watched_noticed', 'denials_spread', 'denials_spread_noticed',
] as const;
export type AccessRuleEvent = (typeof ACCESS_RULE_EVENTS)[number];
export const DOOR_ARMED_EVENT = 'door_opened_armed';

// ---- Flux des passages (access.ts -> regles d'acces) --------------------------------------------------------------------------------

/** Un passage enregistre dans le journal, tel que les regles le lisent. Jamais de nom de titulaire ici (seulement `holderId`). */
export interface PassageNote {
  /** Identifiant de la ligne `access_event`. */
  id: number;
  doorId: string;
  controllerId: string;
  /** Heure du controleur (ms) : c'est elle que les regles utilisent (jamais l'heure d'arrivee). */
  at: number;
  receivedAt: number;
  direction: AccessDirection | null;
  /** Numero de badge, ou `null` (bouton de sortie, ouverture a distance, code...). Jamais recopie dans un texte d'incident. */
  credential: string | null;
  /** Titulaire du PSIM auquel le passage est rattache, ou `null`. */
  holderId: number | null;
  holderRef: string | null;
  method: AccessMethod;
  result: AccessResult;
  reason: AccessReason | null;
  /** Recu en differe (recupere dans la memoire du controleur apres une coupure). */
  late: boolean;
}

/** Fourni par `AccessService.passages`. */
export interface PassageFeed {
  /**
   * Appele pour chaque NOUVEAU passage (jamais pour un doublon), APRES la validation de la transaction qui l'a enregistre
   * (un passage annule par une erreur n'est jamais annonce). Un ecouteur qui leve est ignore (journal technique) et ne gene ni les
   * autres ecouteurs ni l'ingestion. Renvoie la fonction de desabonnement.
   */
  subscribe(listener: (passage: PassageNote) => void): () => void;
  /** Passages d'une periode `[from, to]` (heure du controleur), du plus ancien au plus recent, pour l'essai sur le passe. 20 000 au plus. */
  history(from: number, to: number, doorIds?: readonly string[]): PassageNote[];
}

// ---- Armement des portes (F14) -----------------------------------------------------------------------------------------------------------

/**
 * Choix retenu : la porte garde la zone de son detecteur (`device.zone`, deja choisie a la declaration de l'equipement) ; aucun
 * nouveau champ « zone ». Seul ajout : un interrupteur par porte, « armer avec la zone » (table `access_door_arming`, defaut
 * FAUX : une zone est armee en permanence tant qu'aucun planning n'existe, activer l'armement de toutes les portes par defaut
 * declencherait une pre-alarme a chaque ouverture).
 */
export interface DoorArmingView {
  /** La porte est rattachee a l'armement de sa zone. */
  enabled: boolean;
  /** Zone du detecteur de la porte (peut etre vide). */
  zone: string;
  /** Un armement existe pour cette zone (detecteur d'intrusion ou planning/derogation) : on peut donc la regler dans « Armement ». */
  zoneArmable: boolean;
  /** Etat de l'armement de la zone MAINTENANT (`null` si la porte n'est pas rattachee). */
  armedNow: boolean | null;
}

/** Verdict attache a un passage accepte pendant l'armement (journal et fiche de porte). */
export interface ArmingNote {
  /** Vrai : un groupe du titulaire a un droit en vigueur pour cette porte a cet instant. */
  authorized: boolean;
  groupId: number | null;
  /** Nom du groupe qui autorise (jamais le nom du titulaire). */
  groupName: string | null;
  /** « Ouverture pendant l'armement : autorisée, groupe Nuit » / « Ouverture pendant l'armement : non autorisée ». */
  label: string;
}

/** Demande de pre-alarme decidee par le module d'armement ou par un autre module, appliquee par le moteur. */
export interface RaiseRequest {
  state: 'prealarm';
  /** Evenement nomme (motif de l'incident), ex. `door_opened_armed`. */
  event: string;
  /** Texte de l'incident : nomme la porte et l'heure ; jamais un nom de titulaire, seulement `H<id>`. */
  detail: string;
}

// ---- Regles d'acces (F15) ---------------------------------------------------------------------------------------------------------------

/**
 * Specification d'une regle d'acces. Stockee dans `presence_rule.spec` (meme table, meme cycle de vie, meme detecteur virtuel
 * `R-<id>` de categorie `access` que les regles de presence). Elle se distingue d'une regle de presence par `kind: 'access'`
 * (une specification SANS `kind` est une regle de presence, comme avant).
 */
export type AccessRuleWhat =
  /** Un badge du groupe `groupId` est utilise a une heure ou le groupe n'a pas de droit sur cette porte (canPass a l'heure du passage, meme si le controleur l'a accepte). */
  | { type: 'off_hours'; groupId: number; groupName: string }
  /** Un badge precis (`badge`) ou tous les badges d'un titulaire (`holderId`) est utilise (badge vole, personne recherchee). */
  | { type: 'badge_used'; target: { by: 'badge'; number: string } | { by: 'holder'; holderId: number; label: string } }
  /** Au moins `denials` refus sur au moins `doors` portes DIFFERENTES en `windowS` secondes (un meme badge, ou tous badges confondus). */
  | { type: 'denied_spread'; subject: 'same_badge' | 'any_badge'; denials: number; doors: number; windowS: number };

export interface AccessRuleSpec {
  kind: 'access';
  what: AccessRuleWhat;
  /** Portes surveillees (identifiants de detecteurs declares dans `access_door`) ou toutes les portes declarees. */
  where: { doors: string[] } | { allDoors: true };
  /** Plages horaires (meme format que l'armement) ou a toute heure. L'heure testee est celle du passage. */
  when: { type: 'always' } | { type: 'windows'; windows: Window[] };
  then: { severity: 'warning' | 'critical' };
  /** Repos apres retour au calme, en minutes (0..1440, defaut 10). */
  cooldownMinutes: number;
}

export const DENIED_SPREAD_DEFAULTS = { denials: 2, doors: 2, windowS: 60 } as const;
/** Bornes de `denied_spread` : denials 2..20, doors 2..10, windowS 10..3600 (doors <= denials). */
export const DENIED_SPREAD_LIMITS = { denials: [2, 20], doors: [2, 10], windowS: [10, 3600] } as const;
/** Retour au calme d'une regle d'acces : 60 s apres le dernier passage correspondant (comme les regles de visage). */
export const ACCESS_CALM_MS = 60_000;
