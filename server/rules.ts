import type { DatabaseSync } from 'node:sqlite';
import { createAccessRuleMachine, describeAccessRule, describeMinutes, describeWindow, isAccessSpec, joinOr, validateAccessSpec } from './accessrules.ts';
import type { AccessRuleAction, AccessRuleMachine } from './accessrules.ts';
import type { AccessRuleSpec, PassageFeed, PassageNote } from './accessrulestypes.ts';
import type { HoldersReader } from './accessholderstypes.ts';
import { inSchedule, parseSchedule } from './arming.ts';
import type { Window } from './arming.ts';
import type { Engine } from './engine.ts';
import { PsimError } from './errors.ts';
import type { FaceObs } from './faceobs.ts';
import type { Presence, PresenceChange } from './presence.ts';
import { hasForbiddenChar, normalizeName } from './text.ts';
import type { Device } from './types.ts';

/**
 * Regles de presence (contrat : docs/PRESENCE-REGLES.md).
 *
 * Une regle = « qui / ou / quand / si / alors » + un repos. Elle regarde les changements de presence (presence.ts) et,
 * quand sa condition est remplie, parle a SON detecteur virtuel `R-<id>` : on reutilise ainsi tout le traitement d'alarme
 * existant (incident, cameras liees, images, notifications, escalade, journal). L'IA ne decide jamais : ce moteur est
 * deterministe et local.
 *
 * REGLES D'ACCES (F15) : une specification portant `kind: 'access'` est une regle d'acces (badge hors horaires, badge surveille,
 * refus sur plusieurs portes). Meme table, meme cycle de vie, meme detecteur virtuel, meme API ; la logique propre est dans
 * `accessrules.ts`, ce fichier ne fait que la brancher (une specification SANS `kind` reste une regle de presence).
 *
 * Trois couches :
 *  - validateSpec / describeRule : fonctions pures (verification stricte, phrase en francais) ;
 *  - createRuleMachine : machine a etats PURE (aucune E/S, aucune horloge : le temps lui est donne). Le direct ET l'essai
 *    sur le passe utilisent la MEME machine, c'est ce qui garantit qu'ils donnent les memes declenchements ;
 *  - createRules : base de donnees, detecteurs virtuels, journal, direct (tick + abonnement a la presence), essai.
 */

/**
 * Qui : n'importe qui (presence) ou une identite de visage (reconnaissance faciale de l'enregistreur). Les noms de liste et de
 * personne sont recopies dans la regle : aucune verification aupres de l'enregistreur (qui peut etre injoignable).
 *
 * Les bases de visages et les personnes sont numerotees PAR APPAREIL Dahua (liste « 1 », personne « 1 » existent sur chaque
 * appareil) : `cameraId` est la camera du PSIM par laquelle la base est lue (comme `cameraId` de GET /api/faces/lists). C'est
 * l'APPAREIL de cette camera (son hote, dans camera_source) qui compte, pas la voie : un enregistreur a plusieurs voies n'a
 * qu'une seule base. Une regle ancienne sans `cameraId` ne correspond a rien (voir `needsReview`).
 *
 * `listName` / `personName` ne sont pas qu'un libelle : une observation qui porte un nom different (casse et espaces ignores) ne
 * correspond pas, meme avec le bon appareil et le bon numero (voir `faceMatches`).
 */
export type Who =
  | { type: 'anyone' }
  | { type: 'list'; cameraId: string; listId: string; listName: string }
  | { type: 'person'; cameraId: string; personId: string; personName: string }
  | { type: 'unknown' };

export interface RuleSpec {
  who: Who;
  where: { cameras: string[] } | { zones: string[] };
  when: { type: 'always' } | { type: 'windows'; windows: Window[] } | { type: 'armed' };
  trigger: { type: 'appears' } | { type: 'stays'; minutes: number };
  then: { severity: 'warning' | 'critical' };
  cooldownMinutes: number;
}

export interface Rule {
  id: number;
  name: string;
  enabled: boolean;
  /** Regle de presence (sans `kind`) ou regle d'acces (`kind: 'access'`). */
  spec: RuleSpec | AccessRuleSpec;
  /** Derive de `spec`. */
  kind: 'presence' | 'access';
  deviceId: string;
  summary: string;
  /**
   * Vrai : regle d'identite (liste ou personne) a reenregistrer. Elle ne se declenche pas, et ne peut pas etre reactivee telle
   * quelle. Cas : enregistree avant l'ajout de la camera source (`who.cameraId` absent), ou camera supprimee / sans source video.
   * Toujours faux pour une regle d'acces.
   */
  needsReview: boolean;
  sourceText: string | null;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
}

export { isAccessSpec };

/** Duree de lissage : un « stop » suivi d'un « start » en moins de 60 s ne coupe pas la presence. */
export const SMOOTHING_MS = 60_000;
export const DEFAULT_COOLDOWN_MINUTES = 10;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_MINUTES = 1440;
const MAX_NAME = 80;
const MAX_SOURCE_TEXT = 1000;
const MAX_LIST = 50;
const MAX_ID_TEXT = 80;
/** Identifiant de liste ou de personne (meme borne que faces.ts) et noms recopies dans la regle. */
const MAX_FACE_ID = 64;
const MAX_FACE_NAME = 80;
/** Essai sur le passe : on lit un peu au-dela de la fin pour retrouver la fin des presences commencees avant. */
const SIM_MARGIN_MS = DAY_MS;
const SIM_MAX_SPAN_MS = 31 * DAY_MS;

// ---- Validation ---------------------------------------------------------------------------------------------------

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Valeur d'une propriete PROPRE (jamais celle d'un prototype). */
const own = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);

/** Texte d'un nom tel que saisi, rendu inoffensif pour un message d'erreur. */
const shown = (v: unknown): string => String(v).replace(/[^\x20-\x7e -￿]/g, '?').slice(0, 40);

function plain(v: unknown, label: string): Record<string, unknown> {
  if (!isPlain(v)) throw new PsimError(400, `${label} : un objet est attendu`);
  return v;
}

function only(o: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) throw new PsimError(400, `${label} : champ « ${shown(key)} » non reconnu`);
  }
}

function idList(value: unknown, known: ReadonlySet<string>, label: string, what: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new PsimError(400, `${label} : choisir au moins ${what}`);
  if (value.length > MAX_LIST) throw new PsimError(400, `${label} : ${MAX_LIST} elements au plus`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || item.length > MAX_ID_TEXT) throw new PsimError(400, `${label} : nom invalide`);
    if (!known.has(item)) throw new PsimError(400, `${label} : ${what.startsWith('une zone') ? 'zone' : 'camera'} inconnue « ${shown(item)} »`);
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * Texte d'identite (identifiant ou nom) : chaine non vide, longueur bornee, sans controle ni caractere invisible. Les espaces
 * sont normalises comme dans faces.ts (c'est avec ce texte qu'une observation sera comparee).
 */
function faceText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new PsimError(400, `${label} : texte requis`);
  if (value.length > max) throw new PsimError(400, `${label} : ${max} caracteres au plus`);
  if (hasForbiddenChar(value)) throw new PsimError(400, `${label} : caracteres de controle ou invisibles interdits`);
  const flat = normalizeName(value).replace(/\s+/gu, ' ');
  if (flat === '') throw new PsimError(400, `${label} : texte requis`);
  return flat;
}

/** Camera source d'une identite (liste, personne) : obligatoire, et connue du PSIM (la comparaison se fait sur son appareil). */
function faceCamera(who: Record<string, unknown>, what: string, cameraIds: ReadonlySet<string>): string {
  const id = own(who, 'cameraId');
  if (typeof id !== 'string' || id.trim() === '') throw new PsimError(400, `Qui : la camera de la ${what} est requise`);
  if (!cameraIds.has(id)) throw new PsimError(400, `Qui : camera inconnue « ${shown(id)} »`);
  return id;
}

function validateWho(raw: unknown, ctx: { cameraIds: ReadonlySet<string> }): Who {
  const who = plain(raw, 'Qui');
  switch (own(who, 'type')) {
    case 'anyone':
      only(who, ['type'], 'Qui');
      return { type: 'anyone' };
    case 'unknown':
      only(who, ['type'], 'Qui');
      return { type: 'unknown' };
    case 'list': {
      only(who, ['type', 'cameraId', 'listId', 'listName'], 'Qui');
      const cameraId = faceCamera(who, 'liste', ctx.cameraIds);
      return { type: 'list', cameraId, listId: faceText(own(who, 'listId'), MAX_FACE_ID, 'Qui : identifiant de la liste'), listName: faceText(own(who, 'listName'), MAX_FACE_NAME, 'Qui : nom de la liste') };
    }
    case 'person': {
      only(who, ['type', 'cameraId', 'personId', 'personName'], 'Qui');
      const cameraId = faceCamera(who, 'personne', ctx.cameraIds);
      return { type: 'person', cameraId, personId: faceText(own(who, 'personId'), MAX_FACE_ID, 'Qui : identifiant de la personne'), personName: faceText(own(who, 'personName'), MAX_FACE_NAME, 'Qui : nom de la personne') };
    }
    default:
      throw new PsimError(400, 'Qui : choisir « n\'importe qui », une liste de visages, une personne ou « un visage inconnu »');
  }
}

function intIn(value: unknown, min: number, max: number, label: string, unit: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new PsimError(400, `${label} : un nombre entier de ${unit} entre ${min} et ${max} est attendu`);
  }
  return value;
}

/**
 * Verifie TOUT et renvoie une specification normalisee (copie profonde, valeurs par defaut appliquees, listes sans
 * doublon). Ne fait jamais confiance a l'entree : objets simples uniquement, champs inconnus refuses, proprietes
 * heritees ignorees (`__proto__`, `constructor`...).
 */
export function validateSpec(input: unknown, ctx: { cameraIds: ReadonlySet<string>; zones: ReadonlySet<string> }): RuleSpec {
  const spec = plain(input, 'La regle');
  only(spec, ['who', 'where', 'when', 'trigger', 'then', 'cooldownMinutes'], 'La regle');
  const boxes: [string, string][] = [['who', 'Qui'], ['where', 'Ou'], ['when', 'Quand'], ['trigger', 'Si'], ['then', 'Alors']];
  for (const [key, label] of boxes) if (own(spec, key) === undefined) throw new PsimError(400, `Il manque la case « ${label} » dans la regle`);

  // Qui
  const whoOut = validateWho(own(spec, 'who'), ctx);

  // Ou
  const where = plain(own(spec, 'where'), 'Ou');
  only(where, ['cameras', 'zones'], 'Ou');
  const hasCameras = Object.hasOwn(where, 'cameras');
  const hasZones = Object.hasOwn(where, 'zones');
  if (hasCameras === hasZones) throw new PsimError(400, 'Ou : choisir des cameras OU des zones (l\'un des deux, pas les deux)');
  const placed: RuleSpec['where'] = hasCameras
    ? { cameras: idList(own(where, 'cameras'), ctx.cameraIds, 'Ou', 'une camera') }
    : { zones: idList(own(where, 'zones'), ctx.zones, 'Ou', 'une zone') };

  // Quand
  const when = plain(own(spec, 'when'), 'Quand');
  let period: RuleSpec['when'];
  switch (own(when, 'type')) {
    case 'always':
      only(when, ['type'], 'Quand');
      period = { type: 'always' };
      break;
    case 'armed':
      only(when, ['type'], 'Quand');
      period = { type: 'armed' };
      break;
    case 'windows': {
      only(when, ['type', 'windows'], 'Quand');
      const raw = own(when, 'windows');
      if (!Array.isArray(raw) || raw.length === 0) throw new PsimError(400, 'Quand : au moins une plage horaire est necessaire');
      for (const w of raw) {
        const win = plain(w, 'Quand : plage');
        only(win, ['days', 'from', 'to'], 'Quand : plage');
      }
      const windows = parseSchedule(raw.map((w: Record<string, unknown>) => ({ days: own(w, 'days'), from: own(w, 'from'), to: own(w, 'to') })));
      period = { type: 'windows', windows: windows as Window[] };
      break;
    }
    default:
      throw new PsimError(400, 'Quand : choisir « toujours », des plages horaires ou « quand la zone est armee »');
  }

  // Si
  const trigger = plain(own(spec, 'trigger'), 'Si');
  let cause: RuleSpec['trigger'];
  switch (own(trigger, 'type')) {
    case 'appears':
      only(trigger, ['type'], 'Si');
      cause = { type: 'appears' };
      break;
    case 'stays':
      only(trigger, ['type', 'minutes'], 'Si');
      cause = { type: 'stays', minutes: intIn(own(trigger, 'minutes'), 1, MAX_MINUTES, 'Si : duree de presence', 'minutes') };
      break;
    default:
      throw new PsimError(400, 'Si : choisir « quelqu\'un apparait » ou « quelqu\'un reste plus de N minutes »');
  }

  if (whoOut.type !== 'anyone' && cause.type === 'stays') {
    throw new PsimError(400, 'Si : pour reconnaitre un visage, seul « apparait » est possible (un visage est vu a un instant, pas pendant une duree)');
  }

  // Alors
  const then = plain(own(spec, 'then'), 'Alors');
  only(then, ['severity'], 'Alors');
  const severity = own(then, 'severity');
  if (severity !== 'warning' && severity !== 'critical') throw new PsimError(400, 'Alors : la gravite est « warning » (avertissement) ou « critical » (alerte critique)');

  // Repos
  const rawCooldown = own(spec, 'cooldownMinutes');
  const cooldownMinutes = rawCooldown === undefined ? DEFAULT_COOLDOWN_MINUTES : intIn(rawCooldown, 0, MAX_MINUTES, 'Repos', 'minutes');

  return { who: whoOut, where: placed, when: period, trigger: cause, then: { severity }, cooldownMinutes };
}

// ---- Phrase en francais -------------------------------------------------------------------------------------------

/** « (caméra « Portail ») » ; une regle ancienne sans camera (ou avec une valeur qui n'est pas du texte) : « (caméra non précisée) ». */
function faceCameraPhrase(cameraId: unknown, cameraName: (id: string) => string): string {
  return typeof cameraId === 'string' && cameraId !== '' ? `(caméra « ${cameraName(cameraId)} »)` : '(caméra non précisée)';
}

/**
 * Phrase francaise courante, complete et sans jargon, qui dit exactement ce que fera la regle. Une regle d'acces est decrite par
 * `describeAccessRule` (version normale, avec le titulaire ou le badge surveille) ; `doorName` absent : l'identifiant de la porte.
 */
export function describeRule(spec: RuleSpec | AccessRuleSpec, ctx: { cameraName: (id: string) => string; doorName?: (id: string) => string }): string {
  if (isAccessSpec(spec)) return describeAccessRule(spec, { doorName: ctx.doorName ?? ((id) => id) });
  const action = spec.then.severity === 'critical' ? 'Prévenir (alerte critique)' : 'Prévenir (avertissement)';
  let cause: string;
  if (spec.who.type === 'unknown') cause = 'si un visage inconnu est vu';
  else if (spec.who.type === 'list') cause = `si une personne de la liste « ${spec.who.listName} » ${faceCameraPhrase(spec.who.cameraId, ctx.cameraName)} est reconnue`;
  else if (spec.who.type === 'person') cause = `si la personne « ${spec.who.personName} » ${faceCameraPhrase(spec.who.cameraId, ctx.cameraName)} est reconnue`;
  else cause = spec.trigger.type === 'appears' ? "si quelqu'un apparaît" : `si quelqu'un reste au moins ${describeMinutes(spec.trigger.minutes)}`;
  let where: string;
  if ('cameras' in spec.where) {
    const names = spec.where.cameras.map((id) => `« ${ctx.cameraName(id)} »`);
    where = names.length === 1 ? `devant la caméra ${names[0]}` : `devant les caméras ${joinOr(names)}`;
  } else {
    const names = spec.where.zones.map((z) => `« ${z} »`);
    where = names.length === 1 ? `dans la zone ${names[0]}` : `dans les zones ${joinOr(names)}`;
  }
  let when: string;
  if (spec.when.type === 'always') when = 'à toute heure';
  else if (spec.when.type === 'armed') when = 'uniquement quand la zone est armée';
  else when = `uniquement ${spec.when.windows.map(describeWindow).join(' ou ')}`;
  const rest = spec.cooldownMinutes > 0 ? `ensuite, attendre ${describeMinutes(spec.cooldownMinutes)} avant de signaler à nouveau` : 'ensuite, signaler à nouveau sans attendre';
  return `${action} ${cause} ${where}, ${when} ; ${rest}.`;
}

// ---- Machine a etats pure -----------------------------------------------------------------------------------------

export type RuleEventName = 'person_detected' | 'person_lingering' | 'person_noticed' | 'face_unknown' | 'face_banned' | 'face_noticed';

/** Un visage vu (forme de FaceSeen, faceobs.ts) : ce que la machine d'une regle d'identite lit. */
export interface FaceSighting {
  cameraId: string;
  at: number;
  kind: 'recognized' | 'unknown';
  personId?: string | null;
  groupId?: string | null;
  /** Noms portes par l'observation (recus de l'appareil) : garde contre une liste / personne renumerotee ou deplacee. Absents : sans effet. */
  personName?: string | null;
  groupName?: string | null;
}

/** Hote d'un appareil tel que compare : sans espaces autour, en minuscules ; absent ou vide : null. */
function deviceKey(host: unknown): string | null {
  if (typeof host !== 'string') return null;
  const key = host.trim().toLowerCase();
  return key === '' ? null : key;
}

/**
 * Deux cameras sont-elles lues par le MEME appareil (meme hote) ? Faux des qu'un hote est inconnu (camera supprimee, sans source
 * video, valeur absente) : jamais de « tous appareils ».
 */
function sameDevice(hostOf: (cameraId: string) => string | null, a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || a === '' || typeof b !== 'string' || b === '') return false;
  const ha = deviceKey(hostOf(a));
  return ha !== null && ha === deviceKey(hostOf(b));
}

type FaceProbe = Pick<FaceSighting, 'cameraId' | 'kind' | 'personId' | 'groupId' | 'personName' | 'groupName'>;

/** Nom compare : normalise comme faceText (NFC, espaces compactes, trim), casse ignoree. Absent ou vide : null. */
function nameKey(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const key = normalizeName(name).replace(/\s+/gu, ' ').toLowerCase();
  return key === '' ? null : key;
}

/**
 * Verdict d'une observation pour une liste ou une personne : `match` (meme appareil, meme identifiant, et nom egal ou absent),
 * `mismatch` (meme appareil et meme identifiant, mais nom different) ou `none`. Une seule lecture de `hostOf` par comparaison.
 */
function faceVerdict(who: Who, obs: FaceProbe, hostOf: (cameraId: string) => string | null): 'match' | 'mismatch' | 'none' {
  if (obs.kind !== 'recognized') return 'none';
  let seenId: unknown;
  let wantedId: string;
  let seenName: unknown;
  let wantedName: string;
  if (who.type === 'list') {
    [seenId, wantedId, seenName, wantedName] = [obs.groupId, who.listId, obs.groupName, who.listName];
  } else if (who.type === 'person') {
    [seenId, wantedId, seenName, wantedName] = [obs.personId, who.personId, obs.personName, who.personName];
  } else {
    return 'none';
  }
  if (typeof seenId !== 'string' || seenId !== wantedId || !sameDevice(hostOf, obs.cameraId, who.cameraId)) return 'none';
  const seen = nameKey(seenName);
  return seen === null || seen === nameKey(wantedName) ? 'match' : 'mismatch';
}

/**
 * Une observation correspond-elle a la case « Qui » ? « n'importe qui » ne correspond a aucun visage (c'est la presence qui le pilote).
 *
 * Liste et personne : les numeros sont ceux de l'APPAREIL qui les connait, donc l'observation doit venir du meme appareil que
 * `who.cameraId` (`hostOf` : hote de la source video d'une camera, ou null) ET porter le meme identifiant. Un `who` sans
 * `cameraId` (regle ancienne) ou une camera sans hote ne correspond a rien. « Inconnu » : tout visage inconnu, quel que soit l'appareil.
 *
 * GARDE DE NOM : si l'observation porte un nom (de liste, ou de personne), il doit etre egal a `listName` (ou `personName`) de la
 * regle, casse et espaces ignores ; sinon pas de correspondance (une camera deplacee vers un autre appareil dont la liste « 1 » est
 * une autre liste ne doit pas declencher une regle sur la liste « 1 » de l'ancien). Une observation sans nom garde la
 * correspondance par (appareil, identifiant). Pure : aucune E/S.
 */
export function faceMatches(who: Who, obs: FaceProbe, hostOf: (cameraId: string) => string | null): boolean {
  if (who.type === 'unknown') return obs.kind === 'unknown';
  return faceVerdict(who, obs, hostOf) === 'match';
}

/** Meme appareil et meme identifiant, mais un NOM different : la liste / personne de la regle n'est plus celle de l'appareil (a reenregistrer). */
export function faceMismatch(who: Who, obs: FaceProbe, hostOf: (cameraId: string) => string | null): boolean {
  return faceVerdict(who, obs, hostOf) === 'mismatch';
}

/** Regle d'identite a reenregistrer : pas de camera source (regle ancienne), ou camera supprimee / sans source video. */
export function whoNeedsReview(who: Who, hostOf: (cameraId: string) => string | null): boolean {
  if (who.type !== 'list' && who.type !== 'person') return false;
  const cameraId: unknown = who.cameraId;
  return typeof cameraId !== 'string' || cameraId === '' || deviceKey(hostOf(cameraId)) === null;
}

export type RuleAction =
  | { kind: 'trigger'; event: RuleEventName; cameraId: string; at: number }
  | { kind: 'clear'; at: number };

export interface MachineContext {
  /** Cameras visees par la regle (la portee). Les changements des autres cameras sont ignores. */
  cameras: readonly string[];
  /** La zone de cette camera est-elle armee ? Ne sert qu'a `when.armed`. */
  isArmed: (cameraId: string, at: number) => boolean;
  /**
   * Hote (appareil) de la source video d'une camera, ou null (camera supprimee, sans source). Ne sert qu'aux regles liste / personne
   * (`faceMatches`). Appelee a chaque comparaison, jamais mise en cache. Pure du point de vue de la machine : aucune E/S ici.
   */
  hostOf: (cameraId: string) => string | null;
  /**
   * Optionnel : appele (sans argument) quand une observation de la portee a le meme appareil et le meme identifiant que la liste /
   * personne de la regle mais un NOM different (`faceMismatch`). Le direct y branche un avertissement unique ; l'essai sur le passe
   * ne le fournit pas. La machine ne fait rien d'autre de cette information : l'observation ne correspond simplement pas.
   */
  onMismatch?: () => void;
}

export interface RuleMachine {
  /**
   * Etat de depart du direct (au demarrage ou a l'activation) : les cameras deja occupees. Rien n'est signale pour le passe
   * (`appears` ne se declenche pas pour quelqu'un deja la) ; `stays` peut se declencher si la presence dure deja assez.
   */
  init(occupied: Record<string, { since: number }>, at: number): RuleAction[];
  /** Un changement de presence. Le temps avance d'abord jusqu'a `change.at` (minuteries echues), puis le changement est applique. */
  feed(change: Pick<PresenceChange, 'cameraId' | 'kind' | 'at'>): RuleAction[];
  /**
   * Un visage vu (regles d'identite seulement : sans effet pour « n'importe qui »). Le temps avance d'abord jusqu'a `obs.at`.
   * Une observation correspondante declenche (periode active, hors repos, pas deja declenchee) ou prolonge ; le retour au calme
   * a lieu 60 s apres la derniere observation correspondante.
   */
  see(obs: FaceSighting): RuleAction[];
  /** Fait avancer le temps jusqu'a `at` : fin de presence, duree atteinte, plage horaire ouverte, repos ecoule. */
  tick(at: number): RuleAction[];
  /** Prochain instant ou quelque chose peut changer sans nouvel evenement (pour sauter les temps morts), ou null. */
  nextWake(): number | null;
  isTriggered(): boolean;
  /** Arret force (regle desactivee ou modifiee) : `clear` si elle sonnait. Aucun repos n'est ouvert. */
  release(at: number): RuleAction[];
}

/**
 * Fonctionnement (identique en direct et en essai sur le passe) :
 *
 *  - PRESENCE LISSEE : la presence agregee est la reunion de toutes les cameras de la portee. Elle continue tant qu'une
 *    camera est occupee, et 60 s apres le dernier « stop » sans reprise (un « start » arrive moins de 60 s apres le « stop »
 *    la prolonge ; a 60 s pile, elle est deja finie). Sa duree se compte depuis son debut (premier « start » apres une fin).
 *  - `appears` : se declenche au « start » d'une camera, si la regle n'est pas deja declenchee, pas en repos, et si la
 *    periode est active pour cette camera. Un « start » en dehors des periodes actives est oublie, mais un « start »
 *    ulterieur de la meme presence, pendant une periode active, declenche (quelqu'un qui bouge encore a 22 h 05 alors
 *    qu'il est la depuis 21 h 50 est bien « apparu » dans la plage).
 *  - `stays` : se declenche des que la presence lissee dure au moins `minutes`, pendant une periode active. Si la periode
 *    active ne commence qu'en cours de presence, la duree compte depuis le DEBUT de la presence (pas depuis l'ouverture de
 *    la plage) : quelqu'un present depuis 20 h 00 declenche des 22 h 00 pour « plus de 30 min la nuit ». Se declenche aussi
 *    des la fin du repos si la presence dure toujours.
 *  - FIN : quand la presence lissee cesse, `clear` (a l'instant exact 60 s apres le dernier « stop »). Une fois declenchee,
 *    la regle reste declenchee jusqu'a cette fin, meme si la periode active se termine entre-temps.
 *  - REPOS : apres la fin d'une presence ayant declenche, aucun declenchement avant `cooldownMinutes`.
 *  - PERIODE ACTIVE (`when`) : toujours ; plages horaires (heure locale du serveur, plages a cheval sur minuit comprises) ;
 *    ou zone armee (pour `appears` : la camera du « start » ; pour `stays` : au moins une camera presente a cet instant).
 *
 * REGLES D'IDENTITE (`who` : liste, personne, inconnu) : la machine ignore la presence (`feed`) et n'est pilotee que par les
 * visages vus (`see`). Une observation correspondante (faceMatches : meme appareil que `who.cameraId`, via `ctx.hostOf`, et meme
 * identifiant), dans la portee, pendant une periode active (`appears` : la
 * camera de l'observation), hors repos et si la regle n'est pas deja declenchee, declenche. Les observations correspondantes
 * suivantes prolongent ; `clear` a l'instant EXACT derniere-observation-correspondante + 60 s, puis repos `cooldownMinutes`.
 *
 * Les minuteries sont evaluees a leur instant EXACT quel que soit le rythme des appels : un tick toutes les secondes (direct)
 * et des sauts de `nextWake` (essai) donnent les memes declenchements.
 */
export function createRuleMachine(spec: RuleSpec, ctx: MachineContext): RuleMachine {
  const scope = new Set(ctx.cameras);
  const cooldownMs = spec.cooldownMinutes * MINUTE_MS;
  const stays = spec.trigger.type === 'stays';
  const stayMs = spec.trigger.type === 'stays' ? spec.trigger.minutes * MINUTE_MS : 0;
  const identity = spec.who.type !== 'anyone';
  const event: RuleEventName = identity
    ? spec.then.severity === 'warning' ? 'face_noticed' : spec.who.type === 'unknown' ? 'face_unknown' : 'face_banned'
    : spec.then.severity === 'warning' ? 'person_noticed' : stays ? 'person_lingering' : 'person_detected';

  /** `since` : occupee depuis ; sinon `stoppedAt` : dernier « stop » (la camera compte encore pendant 60 s). */
  const cams = new Map<string, { since: number | null; stoppedAt: number | null }>();
  let clock = -Infinity; // dernier instant traite
  let presenceSince: number | null = null;
  let triggered = false;
  let restUntil = -Infinity;
  /** Regles d'identite : instant de la derniere observation correspondante pendant que la regle est declenchee. */
  let lastMatch: number | null = null;

  const anyOccupied = (): boolean => [...cams.values()].some((c) => c.since !== null);

  /** Instant ou la presence lissee se termine, si plus aucune camera n'est occupee. */
  function endsAt(): number | null {
    if (presenceSince === null || anyOccupied()) return null;
    let last = -Infinity;
    for (const c of cams.values()) if (c.stoppedAt !== null && c.stoppedAt > last) last = c.stoppedAt;
    return Number.isFinite(last) ? last + SMOOTHING_MS : clock;
  }

  function isActive(cameraId: string, at: number): boolean {
    if (spec.when.type === 'always') return true;
    if (spec.when.type === 'windows') return inSchedule(spec.when.windows, at);
    return ctx.isArmed(cameraId, at);
  }

  /** Camera « concernee » d'une presence en cours : la plus anciennement occupee, sinon la derniere a s'etre arretee. */
  function activeCamera(at: number): string | null {
    const present = [...cams.entries()]
      .filter(([, c]) => c.since !== null || (c.stoppedAt !== null && at < c.stoppedAt + SMOOTHING_MS))
      .sort(([ia, a], [ib, b]) => {
        if ((a.since === null) !== (b.since === null)) return a.since === null ? 1 : -1;
        if (a.since !== null && b.since !== null) return a.since - b.since || (ia < ib ? -1 : 1);
        return (b.stoppedAt ?? 0) - (a.stoppedAt ?? 0) || (ia < ib ? -1 : 1);
      });
    for (const [id] of present) if (isActive(id, at)) return id;
    return null;
  }

  function evaluate(t: number, out: RuleAction[]): void {
    if (identity) {
      if (triggered && lastMatch !== null && t >= lastMatch + SMOOTHING_MS) {
        const end = lastMatch + SMOOTHING_MS;
        triggered = false;
        lastMatch = null;
        restUntil = end + cooldownMs;
        out.push({ kind: 'clear', at: end });
      }
      return;
    }
    const end = endsAt();
    if (end !== null && t >= end) {
      presenceSince = null;
      for (const c of cams.values()) c.stoppedAt = null;
      if (triggered) {
        triggered = false;
        restUntil = end + cooldownMs;
        out.push({ kind: 'clear', at: end });
      }
    }
    if (stays && !triggered && presenceSince !== null && t >= presenceSince + stayMs && t >= restUntil) {
      const cameraId = activeCamera(t);
      if (cameraId !== null) {
        triggered = true;
        out.push({ kind: 'trigger', event, cameraId, at: t });
      }
    }
  }

  const nextMinute = (t: number): number => (Math.floor(t / MINUTE_MS) + 1) * MINUTE_MS;

  function nextWake(): number | null {
    let wake: number | null = null;
    const take = (x: number) => {
      if (x > clock && (wake === null || x < wake)) wake = x;
    };
    if (identity) {
      if (triggered && lastMatch !== null) take(lastMatch + SMOOTHING_MS);
      return wake;
    }
    const end = endsAt();
    if (end !== null) take(end);
    if (stays && !triggered && presenceSince !== null) {
      const threshold = Math.max(presenceSince + stayMs, restUntil);
      // Duree atteinte : il ne manque plus qu'une periode active (plage horaire, armement) ; on regarde a chaque minute.
      take(threshold > clock ? threshold : nextMinute(clock));
    }
    return wake;
  }

  function advance(to: number, out: RuleAction[]): void {
    const target = Math.max(to, clock);
    for (;;) {
      const w = nextWake();
      if (w === null || w > target) break;
      clock = w;
      evaluate(w, out);
    }
    clock = target;
    evaluate(target, out);
  }

  return {
    init(occupied, at) {
      const out: RuleAction[] = [];
      clock = Math.max(clock, at);
      if (identity) return out; // rien n'est signale pour le passe, et la presence ne pilote pas une regle d'identite
      for (const [id, o] of Object.entries(occupied)) {
        if (!scope.has(id)) continue;
        cams.set(id, { since: Math.min(o.since, at), stoppedAt: null });
        presenceSince = presenceSince === null ? Math.min(o.since, at) : Math.min(presenceSince, o.since);
      }
      evaluate(clock, out);
      return out;
    },

    feed(change) {
      const out: RuleAction[] = [];
      if (identity || !scope.has(change.cameraId)) return out;
      advance(change.at, out);
      const t = clock;
      let cam = cams.get(change.cameraId);
      if (!cam) cams.set(change.cameraId, (cam = { since: null, stoppedAt: null }));
      if (change.kind === 'start') {
        if (cam.since !== null) return out; // doublon
        cam.since = t;
        cam.stoppedAt = null;
        if (presenceSince === null) presenceSince = t;
        if (!stays && !triggered && t >= restUntil && isActive(change.cameraId, t)) {
          triggered = true;
          out.push({ kind: 'trigger', event, cameraId: change.cameraId, at: t });
        }
      } else {
        if (cam.since === null) return out; // arret d'une presence inconnue
        cam.since = null;
        cam.stoppedAt = t;
      }
      evaluate(t, out);
      return out;
    },

    see(obs) {
      const out: RuleAction[] = [];
      if (!identity || !scope.has(obs.cameraId)) return out;
      advance(obs.at, out);
      const t = clock;
      if (ctx.onMismatch && faceMismatch(spec.who, obs, ctx.hostOf)) ctx.onMismatch();
      if (!faceMatches(spec.who, obs, ctx.hostOf)) return out;
      if (triggered) {
        lastMatch = t; // prolonge : retour au calme 60 s apres cette observation
      } else if (t >= restUntil && isActive(obs.cameraId, t)) {
        triggered = true;
        lastMatch = t;
        out.push({ kind: 'trigger', event, cameraId: obs.cameraId, at: t });
      }
      return out;
    },

    tick(at) {
      const out: RuleAction[] = [];
      advance(at, out);
      return out;
    },

    nextWake,
    isTriggered: () => triggered,

    release(at) {
      if (!triggered) return [];
      triggered = false;
      lastMatch = null;
      return [{ kind: 'clear', at }];
    },
  };
}

// ---- Regles, detecteurs virtuels, direct, essai -------------------------------------------------------------------

const DDL = `
CREATE TABLE IF NOT EXISTS presence_rule (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  spec TEXT NOT NULL,
  device_id TEXT NOT NULL UNIQUE,
  source_text TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);`;

type Row = Record<string, unknown>;

/**
 * Un declenchement de l'essai sur le passe. Regle de presence : `{ at, endedAt, cameraId }` (inchange). Regle d'acces : `cameraId`
 * vide, plus `doorId` et `detail` (texte de l'incident : porte et heure, jamais de nom de titulaire ni de numero de badge).
 */
export interface SimTrigger {
  at: number;
  endedAt: number | null;
  cameraId: string;
  doorId?: string;
  detail?: string;
}

export interface SimulationResult {
  summary: string;
  triggers: SimTrigger[];
  /** Limite de l'essai a montrer a l'administrateur (regle d'acces : droits d'aujourd'hui, journal indisponible). */
  note?: string;
}

export function createRules(deps: {
  db: DatabaseSync;
  engine: Pick<Engine, 'handleDetectorMessage' | 'audit' | 'getDevice' | 'createDevice' | 'updateDevice' | 'deleteDevice' | 'setLinks' | 'getSnapshot'>;
  presence: Pick<Presence, 'subscribe' | 'history' | 'current'>;
  /** Visages vus (regles d'identite). Absent : ces regles existent mais ne recoivent rien, et leur essai ne declenche rien. */
  faces?: Pick<FaceObs, 'subscribe' | 'history'>;
  /** Passages du journal des acces (regles d'acces). Absent : ces regles existent mais ne declenchent rien, et leur essai non plus. */
  passages?: PassageFeed;
  /** Titulaires et droits (lecture seule), pour « badge hors de ses horaires ». Absent : cette regle ne declenche rien. */
  holders?: HoldersReader;
  isArmed: (zone: string) => boolean;
  now?: () => number;
}) {
  const { db, engine, presence } = deps;
  const now = deps.now ?? Date.now;
  db.exec(DDL);

  interface PresenceLive {
    kind: 'presence';
    machine: RuleMachine;
    scope: ReadonlySet<string>;
    deviceId: string;
    /** Regle d'identite : pilotee par les visages, pas par la presence. */
    identity: boolean;
  }
  /** Regle d'acces : pilotee par les passages (la portee est jugee par la machine elle-meme). */
  interface AccessLive {
    kind: 'access';
    machine: AccessRuleMachine;
    deviceId: string;
  }
  type Live = PresenceLive | AccessLive;
  const live = new Map<number, Live>();

  // -- Environnement (cameras, zones) ------------------------------------------------------------------------------

  /** Portes declarees (table `access_door` du journal des acces), par identifiant. Table absente ou illisible : aucune porte. */
  function declaredDoors(devices: Device[]): Device[] {
    try {
      const ids = (db.prepare('SELECT detector_id FROM access_door ORDER BY detector_id').all() as Row[]).map((r) => r.detector_id as string);
      const byId = new Map(devices.map((d) => [d.id, d] as const));
      return ids.flatMap((id) => byId.get(id) ?? []);
    } catch {
      return [];
    }
  }

  function environment() {
    const snapshot = engine.getSnapshot();
    const devices = snapshot.devices;
    const cameras = devices.filter((d) => d.kind === 'camera');
    const doors = declaredDoors(devices);
    return {
      devices,
      cameras,
      doors,
      links: snapshot.links,
      doorCtx: { doorIds: new Set(doors.map((d) => d.id)) as ReadonlySet<string> },
      ctx: {
        cameraIds: new Set(cameras.map((c) => c.id)) as ReadonlySet<string>,
        zones: new Set(devices.map((d) => d.zone).filter((z) => z !== '')) as ReadonlySet<string>,
      },
    };
  }

  /** Cameras visees, dans l'ordre : celles de la liste, ou celles de chaque zone (par identifiant). Zone sans camera : refuse. */
  function resolveScope(spec: RuleSpec, cameras: Device[]): Device[] {
    const out: Device[] = [];
    const add = (d: Device) => {
      if (!out.some((o) => o.id === d.id)) out.push(d);
    };
    if ('cameras' in spec.where) {
      for (const id of spec.where.cameras) {
        const cam = cameras.find((c) => c.id === id);
        if (!cam) throw new PsimError(400, `Camera inconnue : « ${shown(id)} »`);
        add(cam);
      }
    } else {
      for (const zone of spec.where.zones) {
        const inZone = cameras.filter((c) => c.zone === zone).sort((a, b) => (a.id < b.id ? -1 : 1));
        if (inZone.length === 0) throw new PsimError(400, `La zone « ${shown(zone)} » n'a aucune camera : choisir des cameras ou une autre zone`);
        inZone.forEach(add);
      }
    }
    return out;
  }

  /** Comme resolveScope, sans erreur : pour une regle deja enregistree dont une camera ou une zone a pu disparaitre. */
  function tolerantScope(spec: RuleSpec, cameras: Device[]): Device[] {
    const out: Device[] = [];
    const add = (d: Device) => {
      if (!out.some((o) => o.id === d.id)) out.push(d);
    };
    if ('cameras' in spec.where) for (const id of spec.where.cameras) cameras.filter((c) => c.id === id).forEach(add);
    else for (const zone of spec.where.zones) cameras.filter((c) => c.zone === zone).sort((a, b) => (a.id < b.id ? -1 : 1)).forEach(add);
    return out;
  }

  /**
   * Portes visees par une regle d'acces, par identifiant : celles de la liste, ou TOUTES les portes declarees (portee dynamique).
   * Saisie : une porte inconnue est refusee.
   */
  function resolveDoors(spec: AccessRuleSpec, doors: Device[]): Device[] {
    if ('allDoors' in spec.where) return doors;
    const out: Device[] = [];
    for (const id of spec.where.doors) {
      const door = doors.find((d) => d.id === id);
      if (!door) throw new PsimError(400, `Porte inconnue ou non declaree : « ${shown(id)} »`);
      if (!out.includes(door)) out.push(door);
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** Comme resolveDoors, sans erreur : une porte retiree depuis l'enregistrement de la regle est simplement ignoree. */
  function tolerantDoors(spec: AccessRuleSpec, doors: Device[]): Device[] {
    if ('allDoors' in spec.where) return doors;
    const wanted = new Set(spec.where.doors);
    return doors.filter((d) => wanted.has(d.id));
  }

  /** Portee resolue : les equipements vises (cameras ou portes, la 1re donne la zone et la position) et les cameras a lier. */
  interface Placement {
    devices: Device[];
    links: string[];
  }

  function placement(spec: RuleSpec | AccessRuleSpec, env: ReturnType<typeof environment>, strict: boolean): Placement {
    if (isAccessSpec(spec)) {
      const devices = strict ? resolveDoors(spec, env.doors) : tolerantDoors(spec, env.doors);
      // Cameras des portes de la portee (union, triee) : l'incident montre ce que voient les cameras de ces portes.
      const known = new Set(env.cameras.map((c) => c.id));
      const links = [...new Set(devices.flatMap((d) => env.links[d.id] ?? []))].filter((id) => known.has(id)).sort();
      return { devices, links };
    }
    const devices = strict ? resolveScope(spec, env.cameras) : tolerantScope(spec, env.cameras);
    return { devices, links: devices.map((c) => c.id).sort() };
  }

  const cameraName = (id: string): string => engine.getDevice(id)?.name ?? id;
  const doorName = cameraName; // une porte est un equipement comme un autre : son nom est celui de son detecteur
  /** Phrase d'une regle telle que les ecrans la montrent (avec le titulaire ou le badge surveille pour une regle d'acces). */
  const phrase = (spec: RuleSpec | AccessRuleSpec): string => describeRule(spec, { cameraName, doorName });
  /** Phrase pour le journal d'audit : jamais de nom de titulaire ni de numero de badge. */
  const auditPhrase = (spec: RuleSpec | AccessRuleSpec): string => (isAccessSpec(spec) ? describeAccessRule(spec, { doorName, anonymous: true }) : phrase(spec));

  /**
   * Hote (appareil) de la source video d'une camera : relu a chaque comparaison (une camera dont on change l'adresse reste
   * coherente), meme fonction pour le direct, l'essai sur le passe et la verification. Camera supprimee, sans source ou hote vide : null.
   */
  let hostQuery: ReturnType<DatabaseSync['prepare']> | null = null;
  function hostOf(cameraId: string): string | null {
    if (typeof cameraId !== 'string' || cameraId === '') return null;
    try {
      hostQuery ??= db.prepare('SELECT host FROM camera_source WHERE device_id = ?');
      const row = hostQuery.get(cameraId) as { host?: unknown } | undefined;
      return typeof row?.host === 'string' && row.host.trim() !== '' ? row.host : null;
    } catch {
      return null; // base illisible : jamais de correspondance plutot qu'une exception dans le traitement d'un visage
    }
  }

  /**
   * Une regle liste / personne ne peut se declencher que si une camera de sa portee est lue par l'APPAREIL de `who.cameraId`
   * (sinon aucune observation de la portee ne correspondrait jamais). Refus 400 sinon ; sans effet de bord. Ne s'applique qu'a une
   * saisie : une regle deja enregistree n'est jamais verifiee ainsi au chargement.
   */
  function checkReachable(spec: RuleSpec, scope: Device[]): void {
    const who = spec.who;
    if (who.type !== 'list' && who.type !== 'person') return;
    const label = who.type === 'list' ? `de la liste « ${shown(who.listName)} »` : `de la personne « ${shown(who.personName)} »`;
    if (deviceKey(hostOf(who.cameraId)) === null) {
      throw new PsimError(400, `Qui : la camera « ${shown(cameraName(who.cameraId))} » ${label} n'est reliee a aucun appareil (pas de source video) : la regle ne pourrait jamais se declencher`);
    }
    if (!scope.some((c) => sameDevice(hostOf, c.id, who.cameraId))) {
      throw new PsimError(400, `Ou : aucune camera choisie n'appartient a l'appareil ${label} (camera « ${shown(cameraName(who.cameraId))} ») : elle ne pourrait jamais se declencher`);
    }
  }

  /** Saisie complete : forme (validateSpec), portee (cameras ou zones existantes) puis possibilite de declenchement. Sans effet de bord. */
  function checked(input: unknown, env: ReturnType<typeof environment>): { spec: RuleSpec | AccessRuleSpec; place: Placement } {
    if (isAccessSpec(input)) {
      const spec = validateAccessSpec(input, env.doorCtx);
      return { spec, place: placement(spec, env, true) };
    }
    const spec = validateSpec(input, env.ctx);
    const place = placement(spec, env, true);
    checkReachable(spec, place.devices);
    return { spec, place };
  }

  /** Verification d'une specification telle que la ferait `create` (l'API l'utilise pour la proposition de l'assistant). */
  function validate(input: unknown): RuleSpec | AccessRuleSpec {
    return checked(input, environment()).spec;
  }

  // -- Lecture ------------------------------------------------------------------------------------------------------

  const rowOf = (id: number): Row | undefined => db.prepare('SELECT * FROM presence_rule WHERE id = ?').get(id) as Row | undefined;

  function toRule(r: Row): Rule {
    const spec = JSON.parse(r.spec as string) as RuleSpec | AccessRuleSpec;
    const access = isAccessSpec(spec);
    return {
      id: r.id as number,
      name: r.name as string,
      enabled: r.enabled === 1,
      spec,
      kind: access ? 'access' : 'presence',
      deviceId: r.device_id as string,
      summary: phrase(spec),
      needsReview: access ? false : whoNeedsReview(spec.who, hostOf),
      sourceText: (r.source_text as string | null) ?? null,
      createdBy: r.created_by as string,
      createdAt: r.created_at as number,
      updatedBy: r.updated_by as string,
      updatedAt: r.updated_at as number,
    };
  }

  const list = (): Rule[] => (db.prepare('SELECT * FROM presence_rule ORDER BY id').all() as Row[]).map(toRule);
  const get = (id: number): Rule | null => {
    const r = rowOf(id);
    return r ? toRule(r) : null;
  };

  // -- Detecteur virtuel --------------------------------------------------------------------------------------------

  /**
   * Cree ou met a jour le detecteur `R-<id>` : nom de la regle, zone de la 1re camera (ou 1re porte), liens = la portee (pour une
   * regle d'acces : les cameras liees aux portes). Etage et position ne suivent la 1re camera que si elle a change (`moveToFirst`) : on ne ramene pas a sa place un detecteur que
   * l'administrateur a deplace sur le plan.
   */
  function syncDevice(actor: string, deviceId: string, name: string, place: Placement, moveToFirst: boolean): void {
    const first = place.devices[0];
    const existing = engine.getDevice(deviceId);
    if (!existing) {
      engine.createDevice(actor, { id: deviceId, kind: 'detector', name, zone: first.zone, floorId: first.floorId, x: first.x, y: first.y, category: 'access', heartbeatS: 0 });
    } else {
      const patch: Record<string, unknown> = {};
      if (existing.name !== name) patch.name = name;
      if (existing.zone !== first.zone) patch.zone = first.zone;
      if (moveToFirst && (existing.floorId !== first.floorId || existing.x !== first.x || existing.y !== first.y)) Object.assign(patch, { floorId: first.floorId, x: first.x, y: first.y });
      if (Object.keys(patch).length > 0) engine.updateDevice(actor, deviceId, patch);
    }
    const wanted = place.links;
    const current = (db.prepare('SELECT camera_id FROM device_link WHERE detector_id = ? ORDER BY camera_id').all(deviceId) as Row[]).map((r) => r.camera_id as string);
    if (wanted.length !== current.length || wanted.some((id, i) => id !== current[i])) engine.setLinks(actor, deviceId, wanted);
  }

  const incidentCount = (deviceId: string): number => (db.prepare('SELECT COUNT(*) AS n FROM incident WHERE detector_id = ?').get(deviceId) as { n: number }).n;

  // -- Direct -------------------------------------------------------------------------------------------------------

  /** Un declenchement d'une regle d'acces porte le texte de l'incident (`detail`) ; celui d'une regle de presence n'en a pas. */
  function dispatch(entry: Pick<Live, 'deviceId'>, actions: (RuleAction | AccessRuleAction)[]): void {
    for (const a of actions) {
      if (a.kind === 'clear') engine.handleDetectorMessage(entry.deviceId, { event: 'clear' });
      else engine.handleDetectorMessage(entry.deviceId, 'detail' in a ? { event: a.event, detail: a.detail } : { event: a.event });
    }
  }

  /** Une porte est-elle declaree maintenant ? (portee « toutes les portes » : dynamique, une porte declaree plus tard est couverte.) */
  let doorQuery: ReturnType<DatabaseSync['prepare']> | null = null;
  function isDeclaredDoor(doorId: string): boolean {
    try {
      doorQuery ??= db.prepare('SELECT 1 AS x FROM access_door WHERE detector_id = ?');
      return doorQuery.get(doorId) !== undefined;
    } catch {
      return false;
    }
  }

  /** La machine d'une regle d'acces : meme fabrique pour le direct et pour l'essai (les memes droits, les memes portes). */
  function accessMachine(spec: AccessRuleSpec, inScope: (doorId: string) => boolean): AccessRuleMachine {
    return createAccessRuleMachine(spec, { holders: deps.holders, inScope, doorName });
  }

  const accessScope = (spec: AccessRuleSpec): ((doorId: string) => boolean) => {
    if ('allDoors' in spec.where) return isDeclaredDoor;
    const doors = new Set(spec.where.doors);
    return (doorId) => doors.has(doorId);
  };

  const ringing = (deviceId: string): boolean => {
    const status = engine.getDevice(deviceId)?.status;
    return status === 'alarm' || status === 'prealarm';
  };

  /** Machine + abonnement d'une regle activee, initialisee avec les presences en cours. */
  function startLive(id: number, spec: RuleSpec | AccessRuleSpec, deviceId: string, devices: Device[]): Live {
    if (isAccessSpec(spec)) {
      const access: AccessLive = { kind: 'access', machine: accessMachine(spec, accessScope(spec)), deviceId };
      live.set(id, access);
      return access;
    }
    const cameras = devices.filter((d) => d.kind === 'camera');
    const scope = tolerantScope(spec, cameras);
    const zones = new Map(scope.map((c) => [c.id, c.zone] as const));
    let warned = false;
    const machine = createRuleMachine(spec, {
      cameras: scope.map((c) => c.id),
      // La zone est relue a chaque fois : une camera deplacee dans une autre zone est jugee sur sa zone actuelle.
      isArmed: (cameraId) => deps.isArmed(engine.getDevice(cameraId)?.zone ?? zones.get(cameraId) ?? ''),
      hostOf,
      // Avertissement UNIQUE par vie du direct (reinitialise quand la regle est reconstruite). L'essai sur le passe ne journalise rien.
      onMismatch: () => {
        if (warned) return;
        warned = true;
        const who = spec.who;
        if (who.type !== 'list' && who.type !== 'person') return;
        const what = who.type === 'list' ? `la liste « ${shown(who.listName)} »` : `la personne « ${shown(who.personName)} »`;
        console.warn(`[rules] regle ${id} : ${what} n'est plus trouvee sur l'appareil de la camera « ${shown(cameraName(who.cameraId))} » : reenregistrez la regle`);
      },
    });
    const entry: PresenceLive = { kind: 'presence', machine, scope: new Set(scope.map((c) => c.id)), deviceId, identity: spec.who.type !== 'anyone' };
    live.set(id, entry);
    dispatch(entry, machine.init(presence.current(), now()));
    return entry;
  }

  /** Arrete le direct d'une regle ; `clear` d'abord si elle sonnait (ou si son detecteur est reste en alarme). */
  function stopLive(id: number, deviceId: string): void {
    const entry = live.get(id);
    live.delete(id);
    const actions = entry ? entry.machine.release(now()) : [];
    if (actions.length > 0) dispatch({ ...entry!, deviceId }, actions);
    else if (ringing(deviceId)) engine.handleDetectorMessage(deviceId, { event: 'clear' });
  }

  function tick(): void {
    const t = now();
    for (const entry of live.values()) {
      try {
        dispatch(entry, entry.machine.tick(t));
      } catch (err) {
        console.error('[rules] tick :', err);
      }
    }
  }

  const unsubscribe = presence.subscribe((change) => {
    for (const entry of live.values()) {
      if (entry.kind !== 'presence' || entry.identity || !entry.scope.has(change.cameraId)) continue;
      try {
        dispatch(entry, entry.machine.feed(change));
      } catch (err) {
        console.error('[rules] presence :', err);
      }
    }
  });

  // Visages vus : seules les regles d'identite les recoivent (jamais les regles « n'importe qui »).
  const unsubscribeFaces = deps.faces
    ? deps.faces.subscribe((seen) => {
        for (const entry of live.values()) {
          if (entry.kind !== 'presence' || !entry.identity || !entry.scope.has(seen.cameraId)) continue;
          try {
            dispatch(entry, entry.machine.see(seen));
          } catch (err) {
            console.error('[rules] visage :', err);
          }
        }
      })
    : () => {};
  // Passages : seules les regles d'acces activees les recoivent (la machine ignore les portes hors de sa portee).
  const unsubscribePassages = deps.passages
    ? deps.passages.subscribe((passage: PassageNote) => {
        for (const entry of live.values()) {
          if (entry.kind !== 'access') continue;
          try {
            dispatch(entry, entry.machine.see(passage));
          } catch (err) {
            console.error('[rules] passage :', err);
          }
        }
      })
    : () => {};
  const close = (): void => {
    unsubscribe();
    unsubscribeFaces();
    unsubscribePassages();
  };

  // -- Saisie -------------------------------------------------------------------------------------------------------

  function cleanName(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') throw new PsimError(400, 'Nom de la regle requis');
    if (value.length > MAX_NAME) throw new PsimError(400, `Nom de la regle invalide (max ${MAX_NAME} caracteres)`);
    if (hasForbiddenChar(value)) throw new PsimError(400, 'Nom de la regle invalide (caracteres de controle ou invisibles interdits)');
    return normalizeName(value);
  }

  function cleanSourceText(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > MAX_SOURCE_TEXT) throw new PsimError(400, `Phrase d'origine invalide (max ${MAX_SOURCE_TEXT} caracteres)`);
    const flat = value.replace(/\s+/g, ' ');
    if (hasForbiddenChar(flat)) throw new PsimError(400, "Phrase d'origine invalide (caracteres de controle ou invisibles interdits)");
    return normalizeName(flat) || null;
  }

  function cleanEnabled(value: unknown, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new PsimError(400, 'enabled doit etre vrai ou faux');
    return value;
  }

  // -- API ----------------------------------------------------------------------------------------------------------

  function create(actor: string, input: { name: string; spec: unknown; sourceText?: string | null; enabled?: boolean }): Rule {
    const body = plain(input, 'La demande');
    only(body, ['name', 'spec', 'sourceText', 'enabled'], 'La demande');
    const name = cleanName(own(body, 'name'));
    const env = environment();
    const { spec, place } = checked(own(body, 'spec'), env);
    const sourceText = cleanSourceText(own(body, 'sourceText'));
    const enabled = cleanEnabled(own(body, 'enabled'), true);

    // Identifiant : jamais celui d'un equipement existant (un detecteur R-n a conserver pour son historique, par exemple).
    let id = (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM presence_rule').get() as { m: number }).m + 1;
    for (const d of env.devices) {
      const m = /^R-(\d+)$/.exec(d.id);
      if (m && Number(m[1]) >= id) id = Number(m[1]) + 1;
    }
    const deviceId = `R-${id}`;
    const t = now();
    db.prepare('INSERT INTO presence_rule (id, name, enabled, spec, device_id, source_text, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, enabled ? 1 : 0, JSON.stringify(spec), deviceId, sourceText, actor, t, actor, t);
    try {
      syncDevice(actor, deviceId, name, place, true);
    } catch (err) {
      db.prepare('DELETE FROM presence_rule WHERE id = ?').run(id);
      if (engine.getDevice(deviceId) && incidentCount(deviceId) === 0) {
        try {
          engine.deleteDevice(actor, deviceId);
        } catch {
          /* le detecteur reste : le prochain demarrage le signale */
        }
      }
      throw err;
    }
    const summary = auditPhrase(spec);
    engine.audit(actor, 'rule_created', { deviceId, details: `${name} : ${summary}${sourceText ? ` | phrase d'origine : « ${sourceText} »` : ''}${enabled ? '' : ' | desactivee'}` });
    if (enabled) startLive(id, spec, deviceId, env.devices);
    return get(id) as Rule;
  }

  function update(actor: string, id: number, input: { name?: string; spec?: unknown; enabled?: boolean }): Rule {
    const row = rowOf(id);
    if (!row) throw new PsimError(404, 'Regle introuvable');
    const body = plain(input, 'La demande');
    only(body, ['name', 'spec', 'enabled'], 'La demande');
    if (Object.keys(body).length === 0) throw new PsimError(400, 'Rien a modifier');
    const old = toRule(row);
    const env = environment();
    const name = own(body, 'name') === undefined ? old.name : cleanName(own(body, 'name'));
    const enabled = cleanEnabled(own(body, 'enabled'), old.enabled);
    const specGiven = own(body, 'spec') !== undefined;
    // Une regle d'identite a reenregistrer ne se reactive pas telle quelle (elle ne se declencherait jamais) ; la desactiver,
    // la renommer ou la supprimer reste possible, et un nouveau spec valide la reenregistre normalement.
    if (enabled && !old.enabled && !specGiven && old.needsReview) {
      throw new PsimError(400, 'Cette regle doit etre reenregistree : choisissez a nouveau la liste');
    }
    const previousPlace = placement(old.spec, env, false);
    const given = specGiven ? checked(own(body, 'spec'), env) : null;
    const spec = given ? given.spec : old.spec;
    const place = given ? given.place : previousPlace;
    const scope = place.devices;
    const previousScope = previousPlace.devices;
    const specChanged = JSON.stringify(spec) !== JSON.stringify(old.spec);
    // Portee changee : les equipements vises (cameras ou portes) OU, pour une regle d'acces, les cameras des portes.
    const scopeChanged =
      specGiven &&
      (scope.length !== previousScope.length ||
        scope.some((c, i) => c.id !== previousScope[i].id) ||
        place.links.length !== previousPlace.links.length ||
        place.links.some((id, i) => id !== previousPlace.links[i]));
    const renamed = name !== old.name;
    if (!renamed && !specChanged && !scopeChanged && enabled === old.enabled) return old;

    // Detecteur d'abord : si le plan ou le nom est refuse, rien n'a encore change dans la regle.
    if (scope.length > 0 && (specGiven || renamed)) syncDevice(actor, old.deviceId, name, place, scope[0].id !== previousScope[0]?.id);
    const t = now();
    db.prepare('UPDATE presence_rule SET name = ?, enabled = ?, spec = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(name, enabled ? 1 : 0, JSON.stringify(spec), actor, t, id);

    const rebuild = specChanged || scopeChanged || (enabled && !old.enabled);
    if (!enabled) {
      if (old.enabled || ringing(old.deviceId)) stopLive(id, old.deviceId);
    } else if (rebuild) {
      stopLive(id, old.deviceId);
      startLive(id, spec, old.deviceId, env.devices);
    }

    if (renamed || specChanged || scopeChanged) {
      engine.audit(actor, 'rule_updated', { deviceId: old.deviceId, details: `${name} : ${auditPhrase(spec)}` });
    }
    if (enabled !== old.enabled) engine.audit(actor, enabled ? 'rule_enabled' : 'rule_disabled', { deviceId: old.deviceId, details: name });
    return get(id) as Rule;
  }

  function remove(actor: string, id: number): void {
    const row = rowOf(id);
    if (!row) throw new PsimError(404, 'Regle introuvable');
    const rule = toRule(row);
    // Le detecteur d'une regle ne doit jamais rester orphelin, et le moteur refuse de supprimer un detecteur qui a un
    // historique d'incidents : une telle regle se desactive, elle ne se supprime pas.
    if (incidentCount(rule.deviceId) > 0) {
      throw new PsimError(409, 'Cette regle a deja declenche des incidents : la desactiver plutot que la supprimer');
    }
    stopLive(id, rule.deviceId); // `clear` AVANT la suppression du detecteur
    try {
      if (engine.getDevice(rule.deviceId)) engine.deleteDevice(actor, rule.deviceId);
    } catch (err) {
      if (rule.enabled) startLive(id, rule.spec, rule.deviceId, engine.getSnapshot().devices);
      throw err;
    }
    db.prepare('DELETE FROM presence_rule WHERE id = ?').run(id);
    engine.audit(actor, 'rule_deleted', { deviceId: rule.deviceId, details: `${rule.name} : ${auditPhrase(rule.spec)}` });
  }

  /**
   * Essai sur le passe : rejoue l'historique de presence dans la MEME machine que le direct. Aucun effet de bord : rien
   * n'est ecrit et le moteur ne recoit aucun message.
   *
   * LIMITE : l'historique d'armement n'est pas conserve ; pour `when.armed`, l'etat d'armement ACTUEL de chaque zone est
   * utilise pour toute la periode. Les presences deja en cours au debut de la periode ne sont pas connues (la lecture
   * commence a `from`) : leur premiere detection compte comme le debut de la presence.
   *
   * REGLE D'ACCES : les passages du journal sont rejoues dans la MEME machine (sans `passages`, rien ne se declenche). LIMITE : les
   * droits des titulaires sont ceux d'AUJOURD'HUI appliques a l'heure des passages passes (`note`). Un declenchement porte alors
   * `doorId` et `detail` (le texte de l'incident, sans nom ni numero de badge) ; `cameraId` y est vide.
   */
  function simulate(specInput: unknown, from: number, to: number): SimulationResult {
    if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      throw new PsimError(400, 'Periode invalide : le debut doit preceder la fin');
    }
    if (to - from > SIM_MAX_SPAN_MS) throw new PsimError(400, 'Periode trop longue (31 jours au plus)');
    const env = environment();
    const { spec, place } = checked(specInput, env);
    const scope = place.devices;
    const ids = scope.map((c) => c.id);
    if (isAccessSpec(spec)) return simulateAccess(spec, ids, from, to);
    const zones = new Map(scope.map((c) => [c.id, c.zone] as const));
    // Meme `hostOf` que le direct : un meme historique donne les memes declenchements.
    const machine = createRuleMachine(spec, { cameras: ids, isArmed: (cameraId) => deps.isArmed(zones.get(cameraId) ?? ''), hostOf });

    const horizon = to + SIM_MARGIN_MS;
    const identity = spec.who.type !== 'anyone';
    // Regle d'identite : ce sont les visages vus qui sont rejoues (sans `faces`, rien ne se declenche).
    const sightings = identity && deps.faces
      ? deps.faces
          .history(from, horizon, ids)
          .map((c, i) => ({ c, i }))
          .sort((a, b) => a.c.at - b.c.at || a.i - b.i)
          .map((x) => x.c)
      : [];
    const changes = identity
      ? []
      : presence
          .history(from, horizon, ids)
          .map((c, i) => ({ c, i }))
          .sort((a, b) => a.c.at - b.c.at || a.i - b.i)
          .map((x) => x.c);

    const triggers: SimTrigger[] = [];
    const collect = (actions: RuleAction[]) => {
      for (const a of actions) {
        if (a.kind === 'trigger') triggers.push({ at: a.at, endedAt: null, cameraId: a.cameraId });
        else if (triggers.length > 0 && triggers[triggers.length - 1].endedAt === null) triggers[triggers.length - 1].endedAt = a.at;
      }
    };
    machine.tick(from);
    for (const change of changes) collect(machine.feed(change));
    for (const seen of sightings) collect(machine.see(seen));
    collect(machine.tick(horizon));
    return { summary: describeRule(spec, { cameraName: (id) => scope.find((c) => c.id === id)?.name ?? cameraName(id) }), triggers: triggers.filter((t) => t.at >= from && t.at <= to) };
  }

  /** Essai d'une regle d'acces (voir `simulate`) : rejoue les passages de la portee, du plus ancien au plus recent. */
  function simulateAccess(spec: AccessRuleSpec, doorIds: string[], from: number, to: number): SimulationResult {
    const machine = accessMachine(spec, accessScope(spec));
    const horizon = to + SIM_MARGIN_MS;
    const passages = deps.passages
      ? deps.passages
          .history(from, horizon, doorIds)
          .map((p, i) => ({ p, i }))
          .sort((a, b) => a.p.at - b.p.at || a.i - b.i)
          .map((x) => x.p)
      : [];
    const triggers: SimTrigger[] = [];
    const collect = (actions: AccessRuleAction[]) => {
      for (const a of actions) {
        if (a.kind === 'trigger') triggers.push({ at: a.at, endedAt: null, cameraId: '', doorId: a.doorId, detail: a.detail });
        else if (triggers.length > 0 && triggers[triggers.length - 1].endedAt === null) triggers[triggers.length - 1].endedAt = a.at;
      }
    };
    machine.tick(from);
    for (const p of passages) collect(machine.see(p));
    collect(machine.tick(horizon));
    const notes: string[] = [];
    if (!deps.passages) notes.push("Le journal des passages n'est pas disponible : rien ne peut être rejoué.");
    if (spec.what.type === 'off_hours') notes.push("Les droits des titulaires sont ceux d'aujourd'hui, appliqués à l'heure des passages passés.");
    return {
      summary: phrase(spec),
      triggers: triggers.filter((t) => t.at >= from && t.at <= to),
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    };
  }

  // -- Demarrage : reconciliation -----------------------------------------------------------------------------------

  function reconcile(): void {
    const env = environment();
    const devices = env.devices;
    const known = new Set<string>();
    for (const row of db.prepare('SELECT * FROM presence_rule ORDER BY id').all() as Row[]) {
      const id = row.id as number;
      const deviceId = row.device_id as string;
      known.add(deviceId);
      try {
        const rule = toRule(row);
        const place = placement(rule.spec, env, false);
        if (!engine.getDevice(deviceId)) {
          if (place.devices.length === 0) console.warn(`[rules] regle ${id} : detecteur ${deviceId} absent et aucune ${rule.kind === 'access' ? 'porte' : 'camera'} disponible pour le recreer`);
          else syncDevice(rule.updatedBy, deviceId, rule.name, place, true);
        }
        if (!engine.getDevice(deviceId)) continue;
        if (rule.enabled) startLive(id, rule.spec, deviceId, devices);
        // Alarme laissee par un arret brutal alors que la machine est au repos : retour a la normale.
        if (!live.get(id)?.machine.isTriggered() && ringing(deviceId)) engine.handleDetectorMessage(deviceId, { event: 'clear' });
      } catch (err) {
        console.error(`[rules] regle ${id} :`, err);
      }
    }
    // Detecteurs « R-<n> » sans regle : supprimes s'ils n'ont aucun historique, sinon seulement signales.
    for (const d of devices) {
      if (d.kind !== 'detector' || known.has(d.id) || !/^R-\d+$/.test(d.id) || d.category !== 'access' || d.heartbeatS !== 0) continue;
      if (incidentCount(d.id) > 0) {
        console.warn(`[rules] detecteur ${d.id} sans regle, conserve pour son historique d'incidents`);
        continue;
      }
      try {
        engine.deleteDevice('systeme', d.id);
      } catch (err) {
        console.warn(`[rules] detecteur ${d.id} sans regle, suppression impossible :`, err);
      }
    }
  }

  reconcile();

  return { list, get, create, update, remove, tick, simulate, validate, close };
}

export type Rules = ReturnType<typeof createRules>;
