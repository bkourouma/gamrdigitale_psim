import { inSchedule, parseSchedule } from './arming.ts';
import type { Window } from './arming.ts';
import { ACCESS_CALM_MS, DENIED_SPREAD_DEFAULTS, DENIED_SPREAD_LIMITS } from './accessrulestypes.ts';
import type { AccessRuleEvent, AccessRuleSpec, AccessRuleWhat, PassageNote } from './accessrulestypes.ts';
import type { HoldersReader } from './accessholderstypes.ts';
import { PsimError } from './errors.ts';
import { hasForbiddenChar, normalizeName } from './text.ts';

/**
 * Regles d'acces (F15) : tout ce qui est propre aux regles « badge hors horaires », « badge surveille » et « refus sur plusieurs
 * portes ». Ce fichier est PUR (aucune E/S, aucune horloge, aucune base) ; `rules.ts` le branche dans le meme cycle de vie que les
 * regles de presence (table `presence_rule`, detecteur virtuel `R-<id>`, API `/api/rules`).
 *
 *  - validateAccessSpec / describeAccessRule : verification stricte et phrase en francais ;
 *  - createAccessRuleMachine : machine a etats PURE, utilisee par le direct ET par l'essai sur le passe (memes declenchements) ;
 *  - jamais de nom de titulaire ni de numero de badge dans le texte d'un incident (il part par SMS et courriel) : seulement
 *    l'identifiant `H<id>` du titulaire, ou « badge non rattache a un titulaire ».
 */

/** Une specification SANS `kind: 'access'` est une regle de presence (comportement historique). */
export function isAccessSpec(spec: unknown): spec is AccessRuleSpec {
  return typeof spec === 'object' && spec !== null && !Array.isArray(spec) && Object.hasOwn(spec, 'kind') && (spec as { kind?: unknown }).kind === 'access';
}

export const DEFAULT_ACCESS_COOLDOWN_MINUTES = 10;

const MINUTE_MS = 60_000;
const MAX_MINUTES = 1440;
const MAX_LIST = 50;
const MAX_ID_TEXT = 80;
const MAX_LABEL = 80;
const MAX_BADGE = 32;
const MAX_ID = 2_147_483_647;
/** Texte d'incident : meme borne que `detail` des messages de detecteur (sources.ts). */
const MAX_DETAIL = 300;
const MAX_DOOR_NAME_IN_TEXT = 40;
/** Refus gardes par fenetre (par badge) : borne de memoire, bien au-dessus de `denials` (20 au plus). */
const MAX_KEPT_DENIALS = 200;
const MAX_KEPT_KEYS = 1000;

// ---- Petits utilitaires de validation (memes regles que rules.ts) ---------------------------------------------------------------

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Valeur d'une propriete PROPRE (jamais celle d'un prototype). */
const own = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);

/** Texte tel que saisi, rendu inoffensif pour un message d'erreur. */
const shown = (v: unknown): string => String(v).replace(/[^\x20-\x7e -￿]/g, '?').slice(0, 40);

function plain(v: unknown, label: string): Record<string, unknown> {
  if (!isPlain(v)) throw new PsimError(400, `${label} : un objet est attendu`);
  return v;
}

function only(o: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) throw new PsimError(400, `${label} : champ « ${shown(key)} » non reconnu`);
  }
}

function intIn(value: unknown, min: number, max: number, label: string, unit: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new PsimError(400, `${label} : un nombre entier de ${unit} entre ${min} et ${max} est attendu`);
  }
  return value;
}

/** Identifiant numerique (groupe, titulaire) : entier strictement positif. */
function positiveId(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_ID) {
    throw new PsimError(400, `${label} : un identifiant (nombre entier positif) est attendu`);
  }
  return value;
}

/**
 * Libelle recopie dans la regle (nom de groupe, nom de titulaire) : texte non vide, longueur bornee, sans controle ni caractere
 * invisible. Aucune verification aupres des titulaires (seule l'interface de lecture `HoldersReader` est disponible) : le libelle
 * ne sert qu'a l'affichage, jamais a la correspondance (qui se fait sur l'identifiant).
 */
function labelText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new PsimError(400, `${label} : texte requis`);
  if (value.length > MAX_LABEL) throw new PsimError(400, `${label} : ${MAX_LABEL} caracteres au plus`);
  if (hasForbiddenChar(value)) throw new PsimError(400, `${label} : caracteres de controle ou invisibles interdits`);
  const flat = normalizeName(value).replace(/\s+/gu, ' ');
  if (flat === '') throw new PsimError(400, `${label} : texte requis`);
  return flat;
}

/** Numero de badge : 1 a 32 caracteres, sans controle ni invisible ni espace (compare tel quel, au caractere pres). */
function badgeNumber(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new PsimError(400, `${label} : numero de badge requis`);
  if (value.length > MAX_BADGE) throw new PsimError(400, `${label} : ${MAX_BADGE} caracteres au plus`);
  if (hasForbiddenChar(value) || /\s/u.test(value)) throw new PsimError(400, `${label} : le numero ne doit contenir ni espace, ni caractere de controle ou invisible`);
  return value.normalize('NFC');
}

// ---- Validation -----------------------------------------------------------------------------------------------------------------

export interface AccessValidationContext {
  /** Portes declarees (identifiants des detecteurs de la table `access_door`). */
  doorIds: ReadonlySet<string>;
}

function validateWhat(raw: unknown): AccessRuleWhat {
  const what = plain(raw, 'Si');
  switch (own(what, 'type')) {
    case 'off_hours': {
      only(what, ['type', 'groupId', 'groupName'], 'Si');
      return { type: 'off_hours', groupId: positiveId(own(what, 'groupId'), 'Qui : groupe'), groupName: labelText(own(what, 'groupName'), 'Qui : nom du groupe') };
    }
    case 'badge_used': {
      only(what, ['type', 'target'], 'Si');
      const target = plain(own(what, 'target'), 'Qui');
      switch (own(target, 'by')) {
        case 'badge':
          only(target, ['by', 'number'], 'Qui');
          return { type: 'badge_used', target: { by: 'badge', number: badgeNumber(own(target, 'number'), 'Qui : badge surveille') } };
        case 'holder':
          only(target, ['by', 'holderId', 'label'], 'Qui');
          return { type: 'badge_used', target: { by: 'holder', holderId: positiveId(own(target, 'holderId'), 'Qui : titulaire'), label: labelText(own(target, 'label'), 'Qui : nom du titulaire') } };
        default:
          throw new PsimError(400, 'Qui : choisir un numéro de badge ou un titulaire');
      }
    }
    case 'denied_spread': {
      only(what, ['type', 'subject', 'denials', 'doors', 'windowS'], 'Si');
      const subject = own(what, 'subject') ?? 'same_badge';
      if (subject !== 'same_badge' && subject !== 'any_badge') throw new PsimError(400, 'Qui : choisir « un même badge » ou « tous les badges confondus »');
      const num = (key: 'denials' | 'doors' | 'windowS', label: string, unit: string): number => {
        const v = own(what, key);
        const [min, max] = DENIED_SPREAD_LIMITS[key];
        return v === undefined ? DENIED_SPREAD_DEFAULTS[key] : intIn(v, min, max, label, unit);
      };
      const denials = num('denials', 'Si : nombre de refus', 'refus');
      const doors = num('doors', 'Si : nombre de portes', 'portes');
      const windowS = num('windowS', 'Si : durée', 'secondes');
      if (doors > denials) throw new PsimError(400, `Si : le nombre de portes (${doors}) ne peut pas dépasser le nombre de refus (${denials})`);
      return { type: 'denied_spread', subject, denials, doors, windowS };
    }
    default:
      throw new PsimError(400, 'Si : choisir « badge utilisé hors de ses horaires », « badge surveillé utilisé » ou « refus sur plusieurs portes »');
  }
}

/**
 * Verifie TOUT et renvoie une specification normalisee (copie profonde, valeurs par defaut appliquees, portes sans doublon).
 * Ne fait jamais confiance a l'entree : objets simples uniquement, champs inconnus refuses, proprietes heritees ignorees
 * (`__proto__`, `constructor`...). Messages en francais prefixes « Qui : / Ou : / Quand : / Si : / Alors : ».
 */
export function validateAccessSpec(input: unknown, ctx: AccessValidationContext): AccessRuleSpec {
  const spec = plain(input, 'La regle');
  only(spec, ['kind', 'what', 'where', 'when', 'then', 'cooldownMinutes'], 'La regle');
  if (own(spec, 'kind') !== 'access') throw new PsimError(400, 'La regle : « kind » doit valoir « access »');
  const boxes: [string, string][] = [['what', 'Si'], ['where', 'Ou'], ['when', 'Quand'], ['then', 'Alors']];
  for (const [key, label] of boxes) if (own(spec, key) === undefined) throw new PsimError(400, `Il manque la case « ${label} » dans la regle`);

  // Qui / Si
  const what = validateWhat(own(spec, 'what'));

  // Ou
  const where = plain(own(spec, 'where'), 'Ou');
  only(where, ['doors', 'allDoors'], 'Ou');
  const hasDoors = Object.hasOwn(where, 'doors');
  const hasAll = Object.hasOwn(where, 'allDoors');
  if (hasDoors === hasAll) throw new PsimError(400, "Ou : choisir des portes OU toutes les portes (l'un des deux, pas les deux)");
  let placed: AccessRuleSpec['where'];
  if (hasAll) {
    if (own(where, 'allDoors') !== true) throw new PsimError(400, 'Ou : « allDoors » vaut vrai, ou choisir des portes');
    if (ctx.doorIds.size === 0) throw new PsimError(400, "Ou : Aucune porte n'est déclarée");
    placed = { allDoors: true };
  } else {
    const raw = own(where, 'doors');
    if (!Array.isArray(raw) || raw.length === 0) throw new PsimError(400, 'Ou : choisir au moins une porte');
    if (raw.length > MAX_LIST) throw new PsimError(400, `Ou : ${MAX_LIST} portes au plus`);
    const doors: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string' || item === '' || item.length > MAX_ID_TEXT) throw new PsimError(400, 'Ou : nom de porte invalide');
      if (!ctx.doorIds.has(item)) throw new PsimError(400, `Ou : porte inconnue ou non déclarée « ${shown(item)} »`);
      if (!doors.includes(item)) doors.push(item);
    }
    placed = { doors };
    if (what.type === 'denied_spread' && doors.length < what.doors) {
      throw new PsimError(400, `Ou : pour détecter des refus sur ${what.doors} portes différentes, il faut surveiller au moins ${what.doors} portes`);
    }
  }

  // Quand
  const when = plain(own(spec, 'when'), 'Quand');
  let period: AccessRuleSpec['when'];
  switch (own(when, 'type')) {
    case 'always':
      only(when, ['type'], 'Quand');
      period = { type: 'always' };
      break;
    case 'windows': {
      only(when, ['type', 'windows'], 'Quand');
      const raw = own(when, 'windows');
      if (!Array.isArray(raw) || raw.length === 0) throw new PsimError(400, 'Quand : au moins une plage horaire est nécessaire');
      for (const w of raw) only(plain(w, 'Quand : plage'), ['days', 'from', 'to'], 'Quand : plage');
      const windows = parseSchedule(raw.map((w: Record<string, unknown>) => ({ days: own(w, 'days'), from: own(w, 'from'), to: own(w, 'to') })));
      period = { type: 'windows', windows: windows as Window[] };
      break;
    }
    default:
      throw new PsimError(400, 'Quand : choisir « toujours » ou des plages horaires');
  }

  // Alors
  const then = plain(own(spec, 'then'), 'Alors');
  only(then, ['severity'], 'Alors');
  const severity = own(then, 'severity');
  if (severity !== 'warning' && severity !== 'critical') throw new PsimError(400, 'Alors : la gravité est « warning » (avertissement) ou « critical » (alerte critique)');

  // Repos
  const rawCooldown = own(spec, 'cooldownMinutes');
  const cooldownMinutes = rawCooldown === undefined ? DEFAULT_ACCESS_COOLDOWN_MINUTES : intIn(rawCooldown, 0, MAX_MINUTES, 'Repos', 'minutes');

  return { kind: 'access', what, where: placed, when: period, then: { severity }, cooldownMinutes };
}

// ---- Phrase en francais ---------------------------------------------------------------------------------------------------------

const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

/** « a, b et c » */
export function joinAnd(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`;
}

/** « a, b ou c » */
export function joinOr(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ou ${items[items.length - 1]}`;
}

function describeDays(days: number[]): string {
  const set = new Set(days);
  if (set.size === 7) return 'tous les jours';
  const parts: string[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length >= 3) parts.push(`du ${DAY_NAMES[run[0]]} au ${DAY_NAMES[run[run.length - 1]]}`);
    else for (const d of run) parts.push(`le ${DAY_NAMES[d]}`);
    run = [];
  };
  for (const d of MONDAY_FIRST) {
    if (set.has(d)) run.push(d);
    else flush();
  }
  flush();
  return joinAnd(parts);
}

export function describeWindow(w: Window): string {
  const overnight = w.from > w.to;
  return `de ${w.from} à ${w.to}${overnight ? ' le lendemain' : ''}, ${describeDays(w.days)}`;
}

/** 5 -> « 5 min », 60 -> « 1 h », 90 -> « 1 h 30 ». */
export function describeMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  if (m % 60 === 0) return `${m / 60} h`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/** 45 -> « 45 s », 90 -> « 90 s », 120 -> « 2 min », 150 -> « 2 min 30 s », 3600 -> « 1 h ». */
function describeSeconds(s: number): string {
  if (s < 120) return `${s} s`;
  if (s % 60 === 0) return describeMinutes(s / 60);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

export interface AccessDescribeContext {
  doorName: (doorId: string) => string;
  /**
   * Vrai : version SANS nom de titulaire ni numero de badge (journal d'audit). La version normale peut nommer le titulaire ou le
   * badge surveille : elle n'est vue que par les roles connectes.
   */
  anonymous?: boolean;
}

/** Phrase francaise courante, complete et sans jargon, qui dit exactement ce que fera la regle. */
export function describeAccessRule(spec: AccessRuleSpec, ctx: AccessDescribeContext): string {
  const action = spec.then.severity === 'critical' ? 'Prévenir (alerte critique)' : 'Prévenir (avertissement)';
  const what = spec.what;
  let cause: string;
  if (what.type === 'off_hours') {
    cause = `si un badge du groupe « ${what.groupName} » est utilisé hors de ses horaires`;
  } else if (what.type === 'badge_used') {
    if (what.target.by === 'badge') cause = ctx.anonymous ? 'si le badge surveillé est utilisé' : `si le badge « ${what.target.number} » est utilisé`;
    else cause = ctx.anonymous ? `si un badge du titulaire H${what.target.holderId} est utilisé` : `si un badge de « ${what.target.label} » (titulaire H${what.target.holderId}) est utilisé`;
  } else {
    const same = what.subject === 'same_badge' ? 'avec un même badge' : 'tous badges confondus';
    cause = `si ${what.denials} refus ou plus sont enregistrés sur au moins ${what.doors} portes différentes en ${describeSeconds(what.windowS)} (${same})`;
  }
  const spread = what.type === 'denied_spread';
  let where: string;
  if ('allDoors' in spec.where) {
    where = spread ? 'parmi toutes les portes' : 'à toutes les portes';
  } else {
    const names = spec.where.doors.map((id) => `« ${ctx.doorName(id)} »`);
    if (spread) where = `parmi les portes ${joinOr(names)}`;
    else where = names.length === 1 ? `à la porte ${names[0]}` : `aux portes ${joinOr(names)}`;
  }
  const when = spec.when.type === 'always' ? 'à toute heure' : `uniquement ${spec.when.windows.map(describeWindow).join(' ou ')}`;
  const rest = spec.cooldownMinutes > 0 ? `ensuite, attendre ${describeMinutes(spec.cooldownMinutes)} avant de signaler à nouveau` : 'ensuite, signaler à nouveau sans attendre';
  return `${action} ${cause} ${where}, ${when} ; ${rest}.`;
}

// ---- Machine a etats pure -------------------------------------------------------------------------------------------------------

export type AccessRuleAction =
  | { kind: 'trigger'; event: AccessRuleEvent; doorId: string; at: number; /** Texte de l'incident : porte et heure, jamais de nom ni de numero de badge. */ detail: string }
  | { kind: 'clear'; at: number };

/** Ce que la machine lit des titulaires : un sous-ensemble de `HoldersReader` (lecture seule). */
export type AccessHolders = Pick<HoldersReader, 'groupsOf' | 'canPass' | 'groupsAllowedAt'>;

export interface AccessMachineContext {
  /** Titulaires et droits. Absent : les regles « hors horaires » ne declenchent rien (les autres types n'en ont pas besoin). */
  holders?: AccessHolders;
  /** La porte est-elle dans la portee de la regle ? Les passages des autres portes sont ignores. */
  inScope: (doorId: string) => boolean;
  doorName: (doorId: string) => string;
}

export interface AccessRuleMachine {
  /**
   * Un passage (accepte ou refuse). Le temps avance d'abord jusqu'a `passage.at` (minuteries echues), puis le passage est evalue
   * avec SON heure : periode active (`when`), droits a cet instant, fenetre glissante des refus. Un passage recu en differe ou dans
   * le desordre est evalue de la meme facon ; l'horloge de la machine, elle, ne recule jamais (retour au calme et repos se
   * comptent a partir de `max(passage.at, horloge)`).
   */
  see(passage: PassageNote): AccessRuleAction[];
  /** Fait avancer le temps jusqu'a `at` : retour au calme, fin du repos. */
  tick(at: number): AccessRuleAction[];
  /** Prochain instant ou quelque chose peut changer sans nouveau passage (pour sauter les temps morts), ou null. */
  nextWake(): number | null;
  isTriggered(): boolean;
  /** Arret force (regle desactivee ou modifiee) : `clear` si elle sonnait. Aucun repos n'est ouvert. */
  release(at: number): AccessRuleAction[];
}

/** « 23:41 » : heure LOCALE du serveur (les plages horaires se lisent aussi en heure locale). */
function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** « titulaire H12 » ou « badge non rattaché à un titulaire » : jamais le nom du titulaire, jamais le numero de badge. */
const holderText = (holderId: number | null): string => (holderId === null ? 'badge non rattaché à un titulaire' : `titulaire H${holderId}`);

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const doorNameForText = (name: string): string => clip(name, MAX_DOOR_NAME_IN_TEXT);

interface Denial {
  at: number;
  doorId: string;
  holderId: number | null;
}

/**
 * Fonctionnement (identique en direct et en essai sur le passe) :
 *
 *  - PASSAGE CORRESPONDANT, selon `what` :
 *      `off_hours`     le titulaire du passage est dans le groupe X, `canPass(titulaire, porte, heure du passage)` refuse pour
 *                      « hors plage » ou « jour ferie », ET aucun groupe du titulaire n'a de droit en vigueur sur cette porte a cet
 *                      instant. Le resultat donne par le controleur n'est PAS regarde (accepte ou refuse, tout compte). Un
 *                      titulaire suspendu, expire, inconnu, un badge inconnu ou sans titulaire ne correspond pas : ce n'est pas un
 *                      « hors horaires » ;
 *      `badge_used`    le numero de badge est egal (texte exact), ou `holderId` est egal ; accepte ou refuse ;
 *      `denied_spread` passage REFUSE qui complete une fenetre de `windowS` secondes (bornes comprises : deux refus espaces de
 *                      exactement `windowS` secondes comptent) contenant au moins `denials` refus sur au moins `doors` portes
 *                      distinctes de la portee. `same_badge` regroupe par `credential` (a defaut `holderRef`; sans l'un ni l'autre le
 *                      passage n'entre pas dans ce mode) ; `any_badge` confond tous les badges. Un refus isole n'est JAMAIS une alarme.
 *  - DECLENCHEMENT : un passage correspondant, dans la portee, pendant une periode active (`when`, testee a l'heure du passage),
 *    hors repos et si la regle n'est pas deja declenchee. Les passages correspondants suivants prolongent ; `clear` a l'instant
 *    EXACT dernier-passage-correspondant + 60 s, puis repos de `cooldownMinutes`.
 *  - Les refus hors periode active ou pendant le repos restent dans la fenetre glissante : ils comptent pour un declenchement
 *    ulterieur de la meme fenetre.
 *
 * Les minuteries sont evaluees a leur instant EXACT quel que soit le rythme des appels : un tick par seconde (direct) et des sauts
 * de `nextWake` (essai) donnent les memes declenchements.
 */
export function createAccessRuleMachine(spec: AccessRuleSpec, ctx: AccessMachineContext): AccessRuleMachine {
  const cooldownMs = spec.cooldownMinutes * MINUTE_MS;
  const what = spec.what;
  const severe = spec.then.severity === 'critical';
  const event: AccessRuleEvent =
    what.type === 'off_hours' ? (severe ? 'badge_offhours' : 'badge_offhours_noticed')
    : what.type === 'badge_used' ? (severe ? 'badge_watched' : 'badge_watched_noticed')
    : severe ? 'denials_spread' : 'denials_spread_noticed';

  let clock = -Infinity; // dernier instant traite (ne recule jamais)
  let triggered = false;
  let restUntil = -Infinity;
  /** Instant de la derniere correspondance pendant que la regle est declenchee. */
  let lastMatch: number | null = null;
  /** `denied_spread` : refus recents par badge (ou tous confondus), tries par heure. */
  const denials = new Map<string, Denial[]>();

  const isActive = (at: number): boolean => spec.when.type === 'always' || inSchedule(spec.when.windows, at);

  function evaluate(t: number, out: AccessRuleAction[]): void {
    if (triggered && lastMatch !== null && t >= lastMatch + ACCESS_CALM_MS) {
      const end = lastMatch + ACCESS_CALM_MS;
      triggered = false;
      lastMatch = null;
      restUntil = end + cooldownMs;
      out.push({ kind: 'clear', at: end });
    }
  }

  function nextWake(): number | null {
    return triggered && lastMatch !== null && lastMatch + ACCESS_CALM_MS > clock ? lastMatch + ACCESS_CALM_MS : null;
  }

  function advance(to: number, out: AccessRuleAction[]): void {
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

  // -- Correspondance -----------------------------------------------------------------------------------------------

  const late = (p: PassageNote): string => (p.late ? ' (passage reçu en différé)' : '');
  const resultText = (p: PassageNote): string => (p.result === 'granted' ? 'passage accepté' : 'passage refusé');

  function offHours(p: PassageNote, w: Extract<AccessRuleWhat, { type: 'off_hours' }>): string | null {
    const holders = ctx.holders;
    if (!holders || p.holderId === null) return null;
    try {
      const groups = holders.groupsOf(p.holderId);
      const group = groups.find((g) => g.id === w.groupId);
      if (!group) return null;
      const decision = holders.canPass(p.holderId, p.doorId, p.at);
      if (decision.allowed || (decision.reason !== 'out_of_schedule' && decision.reason !== 'holiday')) return null;
      // Un autre groupe du titulaire peut avoir un droit en vigueur sur cette porte a cet heure : alors il n'est pas hors horaires.
      const mine = new Set(groups.map((g) => g.id));
      if (holders.groupsAllowedAt(p.at, p.doorId).some((g) => mine.has(g.id))) return null;
      return `Badge du ${holderText(p.holderId)} (groupe « ${group.name} ») utilisé hors de ses horaires à la porte « ${doorNameForText(ctx.doorName(p.doorId))} » à ${hhmm(p.at)}, ${resultText(p)}${late(p)}.`;
    } catch (err) {
      console.error('[accessrules] droits illisibles :', err);
      return null; // jamais une exception dans le traitement d'un passage
    }
  }

  function badgeUsed(p: PassageNote, w: Extract<AccessRuleWhat, { type: 'badge_used' }>): string | null {
    const hit = w.target.by === 'badge' ? p.credential === w.target.number : p.holderId !== null && p.holderId === w.target.holderId;
    if (!hit) return null;
    return `Badge surveillé utilisé à la porte « ${doorNameForText(ctx.doorName(p.doorId))} » à ${hhmm(p.at)} : ${holderText(p.holderId)}, ${resultText(p)}${late(p)}.`;
  }

  function deniedSpread(p: PassageNote, w: Extract<AccessRuleWhat, { type: 'denied_spread' }>): string | null {
    if (p.result !== 'denied') return null;
    const key = w.subject === 'any_badge' ? '' : (p.credential ?? p.holderRef);
    if (key === null) return null;
    let list = denials.get(key);
    if (!list) {
      if (denials.size >= MAX_KEPT_KEYS) sweep(w);
      denials.set(key, (list = []));
    }
    // Insertion triee par heure du passage (apres les refus de meme heure) : un passage en differe retrouve sa place.
    let at = list.length;
    while (at > 0 && list[at - 1].at > p.at) at--;
    list.splice(at, 0, { at: p.at, doorId: p.doorId, holderId: p.holderId });
    const windowMs = w.windowS * 1000;
    while (list.length > 0 && (list.length > MAX_KEPT_DENIALS || list[0].at < list[list.length - 1].at - windowMs)) list.shift();
    const idx = list.findIndex((d) => d.at === p.at && d.doorId === p.doorId && d.holderId === p.holderId);
    if (idx < 0) return null; // trop ancien : plus rien a combiner avec les refus gardes
    // Fenetres [debut, debut + windowS] qui contiennent ce passage ; le debut d'une fenetre qui convient est toujours un refus.
    for (let i = 0; i <= idx; i++) {
      const start = list[i].at;
      if (start + windowMs < p.at) continue;
      const inside = list.filter((d) => d.at >= start && d.at <= start + windowMs);
      const doors = [...new Set(inside.map((d) => d.doorId))];
      if (inside.length < w.denials || doors.length < w.doors) continue;
      const names = doors.map((id) => `« ${doorNameForText(ctx.doorName(id))} »`).join(', ');
      const who = w.subject === 'same_badge' ? `${holderText(p.holderId)} ; ` : '';
      return clip(`${inside.length} refus sur ${doors.length} portes différentes en ${w.windowS} s au plus, dernier refus à ${hhmm(p.at)}${late(p)} ; ${who}portes : ${names}.`, MAX_DETAIL);
    }
    return null;
  }

  /** Oublie les badges dont le dernier refus est trop ancien (borne de memoire). */
  function sweep(w: Extract<AccessRuleWhat, { type: 'denied_spread' }>): void {
    const limit = clock - w.windowS * 1000;
    for (const [key, list] of denials) if (list.length === 0 || list[list.length - 1].at < limit) denials.delete(key);
  }

  function match(p: PassageNote): string | null {
    switch (what.type) {
      case 'off_hours':
        return offHours(p, what);
      case 'badge_used':
        return badgeUsed(p, what);
      default:
        return deniedSpread(p, what);
    }
  }

  return {
    see(p) {
      const out: AccessRuleAction[] = [];
      if (!ctx.inScope(p.doorId)) return out;
      advance(p.at, out);
      const t = clock; // jamais en arriere : un passage en differe se compte a partir de maintenant
      const detail = match(p);
      if (detail === null) return out;
      if (triggered) {
        lastMatch = t; // prolonge : retour au calme 60 s apres ce passage
      } else if (t >= restUntil && isActive(p.at)) {
        triggered = true;
        lastMatch = t;
        out.push({ kind: 'trigger', event, doorId: p.doorId, at: p.at, detail: clip(detail, MAX_DETAIL) });
      }
      return out;
    },

    tick(at) {
      const out: AccessRuleAction[] = [];
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
