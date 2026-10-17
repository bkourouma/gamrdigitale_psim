/**
 * Protocole « PUSH » de ZKTeco (centrales C3 / inBio, terminaux de pointage) : lecture des requetes de l'appareil et
 * fabrication de ce que le serveur lui repond. Fonctions pures : aucun reseau, aucun disque, aucune horloge.
 *
 * Etat de la documentation (voir aussi l'en-tete de index.ts) : le « Security PUSH Communication Protocol » du constructeur
 * n'a pas pu etre lu en entier (copies tierces inaccessibles ou tronquees). Ce qui est CONFIRME par au moins une source
 * independante est dit tel quel ; tout le reste est marque `A QUALIFIER` : a verifier sur un appareil reel avec le
 * recueil de trames (`docs/qualification/controle-acces.md`) AVANT toute mise en service. Rien n'est devine en silence :
 * un numero d'evenement inconnu n'est jamais une alarme.
 *
 * CONFIRME (sources : paquets open source « zkteco-adms » en Go et Laravel, pyzkaccess pour les codes du SDK C3) :
 *  - l'appareil appelle le serveur : GET /iclock/cdata (poignee de main), POST /iclock/cdata?table=... (donnees),
 *    GET /iclock/getrequest (commandes), POST /iclock/devicecmd (resultat d'une commande) ;
 *  - reponse de poignee de main : une ligne `GET OPTION FROM: <SN>` puis des lignes `Cle=valeur` ;
 *  - commande remise a l'appareil : `C:<id>:<commande>` ; resultat : corps `ID=<id>&Return=<code>&CMD=<commande>`,
 *    `Return=0` = succes, valeurs negatives = erreur ;
 *  - ligne ATTLOG : champs separes par tabulation, dans l'ordre PIN, heure, Status, Verify, Workcode ;
 *  - modes de verification du SDK C3 : 1 doigt seul, 3 mot de passe seul, 4 carte seule, 6 carte ou doigt, 10 carte et doigt,
 *    11 carte et mot de passe, 200 autre ; sens : 0 entree, 1 sortie, 2 aucun.
 */
import { createHash } from 'node:crypto';
import { cleanCredential, cleanRef, validTs } from '../acces-commun/commun.ts';
import type { AccessPassage, DoorMode } from '../../module.ts';

/** Longueur maximale d'une ligne de donnees : au-dela, la ligne est illisible (donnee hostile ou tronquee). */
export const MAX_LINE = 2048;
/** Nombre maximal de champs d'une ligne. */
const MAX_FIELDS = 40;
/** Longueur maximale retenue d'une valeur de champ. */
const MAX_VALUE = 64;

type Method = AccessPassage['method'];
type Reason = NonNullable<AccessPassage['reason']>;

// ---------------------------------------------------------------------------------------------------------------------
// Requete : chemin, parametres
// ---------------------------------------------------------------------------------------------------------------------

export const PATH_CDATA = '/iclock/cdata';
export const PATH_GETREQUEST = '/iclock/getrequest';
export const PATH_DEVICECMD = '/iclock/devicecmd';
export const PATH_PING = '/iclock/ping';

/** Numero de serie : lettres et chiffres, 4 a 32 caracteres. */
export const SERIAL = /^[A-Za-z0-9]{4,32}$/;

export interface RequestTarget {
  path: string;
  /** Parametres de la requete : un parametre repete ou illisible rend toute la requete invalide. */
  params: ReadonlyMap<string, string>;
}

/**
 * Chemin et parametres d'une adresse de requete (`/iclock/cdata?SN=...&table=...`). `null` si l'adresse est illisible, trop
 * longue ou repete un parametre. Les noms de parametres sont compares sans tenir compte de la casse (`SN` / `sn`).
 */
export function parseTarget(url: string | undefined): RequestTarget | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > 1024 || !url.startsWith('/')) return null;
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  const params = new Map<string, string>();
  if (q >= 0) {
    const query = url.slice(q + 1);
    if (query.length > 0) {
      const parts = query.split('&');
      if (parts.length > 32) return null;
      for (const part of parts) {
        if (part === '') continue;
        const eq = part.indexOf('=');
        const rawKey = eq < 0 ? part : part.slice(0, eq);
        const rawVal = eq < 0 ? '' : part.slice(eq + 1);
        let key: string;
        let val: string;
        try {
          key = decodeURIComponent(rawKey).toLowerCase();
          val = decodeURIComponent(rawVal.replace(/\+/g, ' '));
        } catch {
          return null;
        }
        if (key.length === 0 || key.length > 32 || val.length > 256) return null;
        if (params.has(key)) return null;
        params.set(key, val);
      }
    }
  }
  return { path, params };
}

// ---------------------------------------------------------------------------------------------------------------------
// Heure de l'appareil
// ---------------------------------------------------------------------------------------------------------------------

const DEVICE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

/**
 * Heure `YYYY-MM-DD HH:MM:SS` de l'appareil (heure LOCALE de l'appareil) convertie en millisecondes depuis 1970 :
 * `utcOffsetMin` est l'ecart de l'appareil a l'heure universelle en minutes (0 a Abidjan, 60 a Paris l'hiver).
 * `null` si le texte est illisible ou impossible (13e mois, 30 fevrier...) ou si l'annee n'est pas comprise entre 2001 et 2099.
 */
export function parseDeviceTime(text: string | null | undefined, utcOffsetMin: number): number | null {
  if (typeof text !== 'string') return null;
  const m = DEVICE_TIME.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])] as [number, number, number, number, number, number];
  if (y < 2001 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const local = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(local);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null; // 31 avril, 30 fevrier...
  const ts = local - utcOffsetMin * 60_000;
  return validTs(ts) ? ts : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Lignes de donnees
// ---------------------------------------------------------------------------------------------------------------------

/** Lignes non vides d'un corps de requete (separateurs CRLF, LF ou CR). */
export function splitLines(body: string): string[] {
  return body.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
}

/** Champs `cle=valeur` d'une ligne separee par tabulations. Cle en minuscules ; `null` si la ligne est hostile (trop longue, trop de champs). */
export function parseKv(line: string): Map<string, string> | null {
  if (line.length > MAX_LINE) return null;
  const cells = line.split('\t');
  if (cells.length > MAX_FIELDS) return null;
  const out = new Map<string, string>();
  for (const cell of cells) {
    const eq = cell.indexOf('=');
    if (eq <= 0) continue;
    const key = cell.slice(0, eq).trim().toLowerCase();
    if (!/^[a-z0-9_]{1,24}$/.test(key)) continue;
    out.set(key, cell.slice(eq + 1).trim().slice(0, MAX_VALUE));
  }
  return out;
}

/** Entier decimal strict (au plus `digits` chiffres), ou `null`. */
export function intField(v: string | undefined, digits = 9): number | null {
  if (v === undefined || !new RegExp(`^-?\\d{1,${digits}}$`).test(v)) return null;
  return Number(v);
}

/** Numero de carte exploitable : vide ou fait de zeros = pas de carte. */
function cardField(v: string | undefined): string | null {
  if (v === undefined || v === '' || /^0+$/.test(v)) return null;
  return cleanCredential(v);
}

/** Identifiant stable d'un enregistrement qui n'a pas de numero : `<heure en secondes>-<empreinte courte des champs>`. */
export function syntheticEventId(ts: number, ...fields: (string | number | null)[]): string {
  const digest = createHash('sha256').update(fields.map((f) => String(f ?? '')).join('\u001f')).digest('hex').slice(0, 10);
  return `${Math.floor(ts / 1000)}-${digest}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// rtlog (centrales C3 / inBio) : un enregistrement = un evenement
// ---------------------------------------------------------------------------------------------------------------------

export interface RtlogRecord {
  /** Heure de l'evenement (ms depuis 1970), heure de l'appareil corrigee de `utcOffsetMin`. */
  ts: number;
  /** Identifiant du titulaire dans l'appareil (champ `pin` : le numero d'utilisateur, JAMAIS un mot de passe). */
  pin: string | null;
  card: string | null;
  /** Porte (1 a 4) ou entree auxiliaire selon l'evenement ; `null` si absent. */
  door: number | null;
  event: number;
  inout: number | null;
  verify: number | null;
  /** Numero d'enregistrement (`index`) s'il est present et conforme. */
  index: string | null;
}

/** Ligne `time=...<TAB>pin=...<TAB>cardno=...<TAB>eventaddr=...<TAB>event=...<TAB>inoutstatus=...<TAB>verifytype=...<TAB>index=...`. A QUALIFIER (noms de champs). */
export function parseRtlogLine(line: string, utcOffsetMin: number): RtlogRecord | null {
  const kv = parseKv(line);
  if (!kv) return null;
  const ts = parseDeviceTime(kv.get('time'), utcOffsetMin);
  const evNo = intField(kv.get('event'), 5);
  if (ts === null || evNo === null || evNo < 0) return null;
  const door = intField(kv.get('eventaddr'), 5);
  const index = kv.get('index');
  return {
    ts,
    pin: kv.has('pin') && kv.get('pin') !== '' ? cleanRef(kv.get('pin')) : null,
    card: cardField(kv.get('cardno')),
    door: door !== null && door >= 0 ? door : null,
    event: evNo,
    inout: intField(kv.get('inoutstatus'), 3),
    verify: intField(kv.get('verifytype'), 5),
    index: index !== undefined && /^\d{1,15}$/.test(index) ? index : null,
  };
}

/** Identifiant d'evenement d'un enregistrement rtlog : `index` s'il existe, sinon identifiant synthetique deterministe. A QUALIFIER (l'`index` repart-il de zero apres une remise a zero de la centrale ?). */
export function rtlogEventId(r: RtlogRecord): string {
  return r.index ?? syntheticEventId(r.ts, r.pin, r.card, r.door, r.event, r.inout, r.verify);
}

export type RtEffect =
  | { kind: 'granted'; method?: Method }
  | { kind: 'denied'; reason: Reason }
  | { kind: 'door'; what: 'opened' | 'closed' | 'forced' | 'held_open' }
  | { kind: 'tamper' }
  /** Contrainte (code ou doigt « sous la menace ») : passage accepte ET alarme silencieuse. */
  | { kind: 'duress'; method: Method }
  /** Changement du mode de la porte (F19) : ouverture continue ou retour au mode normal. Jamais un passage. */
  | { kind: 'mode'; mode: DoorMode }
  /** Evenement connu sans consequence pour le PSIM (journalise une fois). */
  | { kind: 'ignore' };

export interface RtEvent {
  label: string;
  effect: RtEffect;
}

const granted = (label: string, method?: Method): RtEvent => ({ label, effect: method ? { kind: 'granted', method } : { kind: 'granted' } });
const denied = (label: string, reason: Reason): RtEvent => ({ label, effect: { kind: 'denied', reason } });
const ignore = (label: string): RtEvent => ({ label, effect: { kind: 'ignore' } });
const mode = (label: string, m: DoorMode): RtEvent => ({ label, effect: { kind: 'mode', mode: m } });

/**
 * Table des numeros d'evenement `event` du rtlog. A QUALIFIER EN ENTIER : reconstituee d'apres l'annexe « Real-time Event
 * Description » du constructeur telle qu'elle est decrite dans les manuels ZKAccess / ZKBioSecurity (les NOMS des evenements y
 * sont confirmes, leurs NUMEROS viennent du SDK C3 et n'ont pu etre relus en source libre). Bandes observees : 0 a 19 reussites,
 * 20 a 99 echecs, 100 a 199 alarmes, 200 et plus etats. Un numero absent de cette table est traite par `classifyEvent`.
 */
export const RTLOG_EVENTS: Readonly<Record<number, RtEvent>> = {
  0: granted('passage normal'),
  1: granted('passage pendant la plage d ouverture permanente'),
  2: granted('premiere carte, ouverture permanente'),
  3: granted('ouverture multi-cartes'),
  4: granted('ouverture par code d urgence', 'code'),
  5: ignore('ouverture pendant la plage d ouverture permanente'),
  6: ignore('liaison declenchee'),
  7: ignore('alarme annulee'),
  8: granted('ouverture a distance', 'remote'),
  // Mode de porte (F19). Les NOMS « Remote Closing », « Disable / Enable Intraday Normal Open Time Zone », « Normal Open Time
  // Zone Over » et « Remote Normal Opening » (9, 10, 11, 204, 205) sont CONFIRMES par la liste d'evenements de pyzkaccess
  // (enveloppe du SDK C3) ; le SENS qu'on en tire pour le mode de la porte est une deduction :
  //  - 9 fermeture a distance, 10 plage d ouverture permanente desactivee pour la journee, 204 fin de la plage : la porte n'est
  //    plus en ouverture continue => `normal` (A QUALIFIER sur un appareil reel : 9 annule-t-il bien une ouverture continue ?) ;
  //  - 11 plage reactivee : la porte n'est en ouverture continue que si l'heure est dans la plage, ce que le message ne dit pas =>
  //    aucun mode emis (rien de faux) ;
  //  - 205 ouverture permanente a distance => `always_open`.
  // « Toujours fermee » n'a aucun evenement connu : jamais emis.
  9: mode('fermeture a distance', 'normal'),
  10: mode('plage d ouverture permanente desactivee', 'normal'),
  11: ignore('plage d ouverture permanente activee'),
  12: ignore('sortie auxiliaire ouverte'),
  13: ignore('sortie auxiliaire fermee'),
  14: granted('ouverture par empreinte', 'fingerprint'),
  15: granted('ouverture multi-personnes par empreinte', 'fingerprint'),
  16: granted('empreinte pendant la plage d ouverture permanente', 'fingerprint'),
  17: granted('ouverture carte et empreinte', 'badge'),
  18: granted('premiere empreinte, ouverture permanente', 'fingerprint'),
  19: granted('premiere carte et empreinte, ouverture permanente', 'badge'),
  20: denied('intervalle trop court entre deux passages', 'other'),
  21: denied('porte inactive a cette heure (carte)', 'out_of_schedule'),
  22: denied('plage horaire illegale', 'out_of_schedule'),
  23: denied('acces refuse', 'other'),
  24: denied('anti-retour', 'antipassback'),
  25: denied('verrouillage mutuel de portes', 'other'),
  26: ignore('multi-cartes en cours (carte suivante attendue)'),
  27: denied('carte inconnue', 'unknown_credential'),
  28: { label: 'porte restee ouverte trop longtemps', effect: { kind: 'door', what: 'held_open' } },
  29: denied('carte expiree', 'expired'),
  30: denied('mauvais mot de passe', 'wrong_pin'),
  31: denied('intervalle trop court entre deux empreintes', 'other'),
  32: ignore('multi-personnes en cours (empreinte suivante attendue)'),
  33: denied('empreinte expiree', 'expired'),
  34: denied('empreinte inconnue', 'unknown_credential'),
  35: denied('porte inactive a cette heure (empreinte)', 'out_of_schedule'),
  36: denied('porte inactive a cette heure (bouton de sortie)', 'out_of_schedule'),
  37: ignore('echec de fermeture pendant la plage d ouverture permanente'),
  38: denied('carte declaree perdue', 'disabled'),
  39: denied('acces desactive', 'disabled'),
  100: { label: 'sabotage', effect: { kind: 'tamper' } },
  101: { label: 'ouverture sous contrainte (code)', effect: { kind: 'duress', method: 'code' } },
  102: { label: 'porte ouverte de force', effect: { kind: 'door', what: 'forced' } },
  103: { label: 'ouverture sous contrainte (empreinte)', effect: { kind: 'duress', method: 'fingerprint' } },
  200: { label: 'porte ouverte', effect: { kind: 'door', what: 'opened' } },
  201: { label: 'porte fermee', effect: { kind: 'door', what: 'closed' } },
  202: granted('bouton de sortie', 'exit_button'),
  203: granted('ouverture multi-cartes carte et empreinte', 'badge'),
  204: mode('fin de la plage d ouverture permanente', 'normal'),
  205: mode('ouverture permanente a distance', 'always_open'),
  206: ignore('demarrage de l appareil'),
  208: granted('super utilisateur'),
  220: ignore('entree auxiliaire ouverte'),
  221: ignore('entree auxiliaire en court-circuit'),
};

/**
 * Effet d'un numero d'evenement. Un numero inconnu n'est JAMAIS une alarme : entre 20 et 99 (bande des echecs) c'est un refus de
 * motif `other` (le journal des passages reste complet) ; ailleurs il est sans effet. `known` dit si le numero figure dans la table
 * (sinon l'appelant le journalise une fois).
 */
export function classifyEvent(event: number): { label: string; effect: RtEffect; known: boolean } {
  const e = Object.hasOwn(RTLOG_EVENTS, event) ? RTLOG_EVENTS[event] : undefined;
  if (e) return { ...e, known: true };
  if (event >= 20 && event <= 99) return { label: `evenement ${event} inconnu (bande des echecs)`, effect: { kind: 'denied', reason: 'other' }, known: false };
  return { label: `evenement ${event} inconnu`, effect: { kind: 'ignore' }, known: false };
}

/**
 * Methode d'un passage accepte ou refuse d'apres le mode de verification (`verifytype`) et la presence d'une carte.
 * 1 doigt, 3 mot de passe, 4 carte, 6 carte ou doigt, 10 carte et doigt, 11 carte et mot de passe : CONFIRMES (SDK C3).
 * 15 visage : A QUALIFIER.
 */
export function verifyMethod(verify: number | null, hasCard: boolean): Method {
  switch (verify) {
    case 1:
      return 'fingerprint';
    case 3:
      return 'code';
    case 4:
    case 10:
    case 11:
      return 'badge';
    case 6:
      return hasCard ? 'badge' : 'fingerprint';
    case 15:
      return 'face';
    default:
      return hasCard ? 'badge' : 'unknown';
  }
}

/** Sens d'un passage rtlog : 0 entree, 1 sortie, 2 aucun (CONFIRME par le SDK C3). */
export function inoutDirection(v: number | null): 'in' | 'out' | null {
  return v === 0 ? 'in' : v === 1 ? 'out' : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// ATTLOG (terminaux de pointage)
// ---------------------------------------------------------------------------------------------------------------------

export interface AttlogRecord {
  ts: number;
  pin: string | null;
  status: number | null;
  verify: number | null;
}

/**
 * Ligne ATTLOG : `PIN<TAB>heure<TAB>Status<TAB>Verify<TAB>Workcode...` (ordre CONFIRME), ou la forme `PIN=...<TAB>DateTime=...`
 * (A QUALIFIER) selon le micrologiciel. Le Workcode est ignore.
 */
export function parseAttlogLine(line: string, utcOffsetMin: number): AttlogRecord | null {
  if (line.length > MAX_LINE) return null;
  const cells = line.split('\t');
  if (cells.length > MAX_FIELDS) return null;
  let pin: string | undefined;
  let time: string | undefined;
  let status: string | undefined;
  let verify: string | undefined;
  if (/^[A-Za-z]+=/.test(cells[0] ?? '')) {
    const kv = parseKv(line);
    if (!kv) return null;
    pin = kv.get('pin');
    time = kv.get('datetime') ?? kv.get('time');
    status = kv.get('status');
    verify = kv.get('verified') ?? kv.get('verify') ?? kv.get('verifytype');
  } else {
    [pin, time, status, verify] = cells.map((c) => c.trim().slice(0, MAX_VALUE));
  }
  const ts = parseDeviceTime(time, utcOffsetMin);
  if (ts === null || pin === undefined || pin === '') return null;
  return { ts, pin: cleanRef(pin), status: intField(status, 3), verify: intField(verify, 5) };
}

/** Sens d'un pointage : 0 entree, 3 retour de pause, 4 debut d'heures supplementaires = entree ; 1, 2, 5 = sortie. A QUALIFIER. */
export function attlogDirection(status: number | null): 'in' | 'out' | null {
  if (status === 0 || status === 3 || status === 4) return 'in';
  if (status === 1 || status === 2 || status === 5) return 'out';
  return null;
}

/** Mode de verification d'un pointage : 0 mot de passe, 1 empreinte, 2 carte, 15 visage. A QUALIFIER. */
export function attlogMethod(verify: number | null): Method {
  switch (verify) {
    case 0:
      return 'code';
    case 1:
      return 'fingerprint';
    case 2:
      return 'badge';
    case 15:
      return 'face';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// rtstate (etat des portes)
// ---------------------------------------------------------------------------------------------------------------------

export interface RtstateRecord {
  /** Heure ACTUELLE de l'appareil (ms), ou `null` si absente ou illisible. */
  ts: number | null;
  /** Etat du contact de chaque porte (1 a 4) : `true` ouverte, `false` fermee ; absent = inconnu. */
  open: Map<number, boolean>;
  /** Vrai si une alarme est indiquee (information, aucun message : les alarmes viennent des evenements du rtlog). */
  alarm: boolean;
}

/**
 * Ligne `time=...<TAB>sensor=...<TAB>relay=...<TAB>alarm=...`. A QUALIFIER : on suppose, pour `sensor`, un chiffre par porte
 * (dans l'ordre des portes) valant 1 (fermee) ou 2 (ouverte) ; toute autre valeur est inconnue (jamais devinee).
 *
 * MODE DE PORTE (F19) : `rtstate` n'est PAS une source du mode. Aucune documentation consultee ne decrit de champ « mode de la
 * porte » dans cette ligne, et `relay` (etat du relais de la serrure) est active aussi par une simple impulsion d'ouverture : il
 * ne distingue pas une ouverture continue. A QUALIFIER sur un appareil reel : si un champ de mode existe (ou si le parametre
 * `Door<N>Drivertime` = 255, « normalement ouvert », peut etre interroge), l'ajouter ici ; en attendant, le mode vient des seuls
 * evenements du rtlog (voir `RTLOG_EVENTS`) et reste INCONNU (rien n'est emis) tant qu'aucun changement n'a ete vu.
 */
export function parseRtstateLine(line: string, utcOffsetMin: number): RtstateRecord | null {
  const kv = parseKv(line);
  if (!kv || kv.size === 0) return null;
  const open = new Map<number, boolean>();
  const sensor = kv.get('sensor') ?? '';
  if (/^[0-9]{1,4}$/.test(sensor)) {
    for (let i = 0; i < sensor.length; i++) {
      const c = sensor[i];
      if (c === '1') open.set(i + 1, false);
      else if (c === '2') open.set(i + 1, true);
    }
  }
  const alarm = kv.get('alarm') ?? '';
  return { ts: parseDeviceTime(kv.get('time'), utcOffsetMin), open, alarm: /[1-9A-Fa-f]/.test(alarm) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reponses du serveur
// ---------------------------------------------------------------------------------------------------------------------

export interface HandshakeOptions {
  serial: string;
  /** Derniere estampille acquittee (nombre decimal) ou `null`. */
  stamp: string | null;
  delayS: number;
  errorDelayS: number;
  transFlag: string;
}

/**
 * Corps de la reponse de poignee de main. Cles CONFIRMEES : Stamp, ErrorDelay, Delay, TransTimes, TransInterval, TransFlag,
 * Realtime, Encrypt (copies du PDF « PUSH Communication Protocol » et implementations de reference). A QUALIFIER :
 *  - `ATTLOGStamp` / `OPERLOGStamp` et leurs valeurs (`None`, 9999 = ne pas envoyer le journal des operations) ;
 *  - `TransFlag` : par defaut le seul journal des passages, JAMAIS les utilisateurs, empreintes ou visages (les gabarits
 *    restent dans l'appareil, PRD § 8.5) ;
 *  - aucun `TimeZone` n'est impose : changer le fuseau de l'appareil decalerait tous ses enregistrements.
 */
export function handshakeBody(o: HandshakeOptions): string {
  const lines = [`GET OPTION FROM: ${o.serial}`];
  if (o.stamp !== null) lines.push(`Stamp=${o.stamp}`);
  lines.push(
    `ATTLOGStamp=${o.stamp ?? 'None'}`,
    'OPERLOGStamp=9999',
    `ErrorDelay=${o.errorDelayS}`,
    `Delay=${o.delayS}`,
    'TransTimes=00:00;14:05',
    'TransInterval=1',
    `TransFlag=${o.transFlag}`,
    'Realtime=1',
    'Encrypt=0',
  );
  return `${lines.join('\n')}\n`;
}

/** Estampille decimale (jusqu'a 20 chiffres) ou `null`. */
export function stampOf(v: string | undefined): string | null {
  return v !== undefined && /^\d{1,20}$/.test(v) ? v : null;
}

/** Plus petite de deux estampilles decimales (comparaison sans perte). `null` est ignore. */
export function minStamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return BigInt(a) <= BigInt(b) ? a : b;
}

export type ControlFormat = 'hex' | 'spaced';

/** Duree speciale : ouverture permanente. */
export const HOLD_OPEN = 255;
/** Duree zero : sortie relachee (porte refermee). */
export const RELEASE = 0;

/**
 * Commande `CONTROL DEVICE` de commande de la sortie « serrure » d'une porte.
 *  - `hex` : `CONTROL DEVICE 01010105` = operation 01 (sortie), porte 01, type 01 (serrure), duree 05 s. Forme relevee dans la
 *    documentation d'un paquet open source et dans une copie du manuel ; l'autre copie la decrit sur 5 octets : A QUALIFIER ;
 *  - `spaced` : `CONTROL DEVICE 1 1 1 5` (memes quatre valeurs en decimal) : A QUALIFIER.
 * Duree : 1 a 254 secondes, 255 = ouverture permanente, 0 = relache (porte refermee) : correspondances du SDK C3, A QUALIFIER.
 */
export function controlCommand(format: ControlFormat, doorNo: number, durationS: number): string {
  if (!Number.isInteger(doorNo) || doorNo < 1 || doorNo > 255) throw new RangeError('numero de porte invalide');
  if (!Number.isInteger(durationS) || durationS < 0 || durationS > 255) throw new RangeError('duree invalide (0 a 255)');
  const values = [1, doorNo, 1, durationS];
  if (format === 'spaced') return `CONTROL DEVICE ${values.join(' ')}`;
  return `CONTROL DEVICE ${values.map((v) => v.toString(16).toUpperCase().padStart(2, '0')).join('')}`;
}

export interface CommandResult {
  id: number;
  /** Code de retour de l'appareil (0 = succes). */
  code: number;
}

/**
 * Resultat(s) de commande : corps `ID=<id>&Return=<code>&CMD=<commande>`, une commande par ligne (CONFIRME). Les lignes
 * illisibles sont ignorees ; au plus 64 lignes.
 */
export function parseDeviceCmdBody(body: string): CommandResult[] {
  const out: CommandResult[] = [];
  for (const line of splitLines(body).slice(0, 64)) {
    if (line.length > MAX_LINE) continue;
    const kv = new Map<string, string>();
    for (const part of line.split('&').slice(0, 16)) {
      const eq = part.indexOf('=');
      if (eq > 0) kv.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim().slice(0, MAX_VALUE));
    }
    const id = intField(kv.get('id'), 10);
    const code = intField(kv.get('return'), 6);
    if (id !== null && id >= 0 && code !== null) out.push({ id, code });
  }
  return out;
}
