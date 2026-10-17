/**
 * Traduction PURE (aucun reseau, aucune horloge, aucun disque) des messages d'un controleur d'acces Dahua (ASC, ASI) vers les
 * types du code commun : un passage, un evenement de porte, un evenement du boitier, ou rien. Les donnees du controleur ne sont
 * JAMAIS de confiance : JSON invalide, champ du mauvais type, chaine enorme, numero de porte hors plage... tout est tolere
 * (resultat « rien » plus un motif) et rien ne leve d'exception.
 *
 * SOURCES (voir aussi le compte rendu du lot AC1) :
 *  [A] « DAHUA ACCESS CONTROL PRODUCTS INTEGRATION INSTRUCTION » V1.0 (2021-09-28), files.dahua.support : table `Method`,
 *      champs de `recordFinder.cgi?name=AccessControlCardRec`, `openDoor`/`closeDoor`, abonnement aux evenements.
 *  [B] « Dahua Epidemic Prevention Solution - Integration Protocol » : evenement `AccessControl` (RecNo, Type, Status, Method,
 *      CardNo, UserID, ErrorCode), `Status` absent = succes.
 *  [C] Evenements reels publies par des integrateurs : terminal ASI (github.com/rroller/dahua, ticket 296) :
 *      `Code=AccessControl;action=Pulse;index=0;data={ CardName, CardNo, CardType, CreateTime, Door:0, ErrorCode:0, Method:1,
 *      ReaderID, Status:1, Type:"Entry", UTC, UserID, UserType }` (sans RecNo) ; VTO (github.com/myhomeiot/DahuaVTO, ticket 5) :
 *      `UTC` en secondes (flottant), `RecNo`, `Name:"OpenDoor"` (nom de l'action, PAS un nom de personne).
 * Tout ce qui n'est confirme par aucune de ces sources est marque `A QUALIFIER`.
 *
 * Le code PIN (`Password`) n'est JAMAIS lu : aucun champ de sortie ne peut le contenir.
 */
import { createHash } from 'node:crypto';
import { parseEventPart } from '../../../../server/dahua.ts';
import type { ControllerEventKind, DoorEventKind, PassageInput } from '../acces-commun/commun.ts';
import { cleanCredential, cleanRef, cleanText, epochEventId } from '../acces-commun/commun.ts';

/** Evenement du flux, tel que `parseEventPart` (server/dahua.ts) le rend : `channel` = `index` + 1. */
export interface RawEvent {
  code: string;
  action: string;
  channel: number;
  data: string | null;
}

export interface TranslateContext {
  /** Decalage de l'heure locale du controleur par rapport a UTC, en minutes. */
  utcOffsetMin: number;
  /** Heure de reception (ms) : repli quand l'evenement n'a pas d'heure exploitable. */
  receivedAt: number;
  /** 0 : les portes sont numerotees a partir de 0 dans les evenements ; 1 : a partir de 1. */
  doorBase: 0 | 1;
  /** Portes declarees (1 a 4) : sert a rattacher un enregistrement sans numero de porte quand il n'y en a qu'une. */
  doorNos?: readonly number[];
  /**
   * Epoque du controleur (entier >= 0, 0 par defaut) : si > 0, l'identifiant d'evenement d'un passage devient
   * `<epoque>.<n° d'enregistrement>` (`epochEventId`), y compris pour un identifiant synthetique. Le curseur de recuperation
   * reste le n° d'enregistrement SEUL (il est range sous une cle propre a l'epoque).
   */
  epoch?: number;
}

export type Translation =
  | {
      kind: 'passage';
      passage: PassageInput;
      /** N° d'enregistrement (`RecNo`) si le controleur le donne, sinon `null` (identifiant synthetique). */
      recNo: string | null;
      /** Heure de creation en secondes (UTC) si connue. */
      createSec: number | null;
      /**
       * Vrai quand l'evenement signale une CARTE DE CONTRAINTE (`CardType` = 5, table [A]) : le module emet en plus une
       * alarme de contrainte (`panic`). Jamais vrai pour un enregistrement de la memoire (pas de `CardType` conserve).
       */
      duress: boolean;
    }
  | { kind: 'door'; doorNo: number; doorKind: DoorEventKind; ts: number; idPart: string }
  | { kind: 'controller'; ctlKind: ControllerEventKind; ts: number; idPart: string }
  | { kind: 'none'; reason: string };

export const MAX_DATA_CHARS = 16_384;
/** Une heure d'evenement plus de 24 h dans le futur est consideree comme fausse (replie sur l'heure de reception). */
const MAX_FUTURE_MS = 24 * 3600 * 1000;
const MAX_DOOR_NO = 4;

// --- Tables ---------------------------------------------------------------------------------------------------------------

export type AccessMethod = PassageInput['method'];
export type AccessReason = NonNullable<PassageInput['reason']>;

/**
 * Table `Method` (numerotation de l'interface HTTP/CGI).
 *  CONFIRME [A][B] : 0 mot de passe, 1 carte, 2 carte puis mot de passe, 3 mot de passe puis carte, 6 empreinte, 15 visage.
 *  DEDUIT, A QUALIFIER : 4 ouverture a distance, 5 bouton de sortie (un ticket d'integrateur montre `Method: 5, Name: OpenDoor`
 *  pour un bouton de sortie sur un VTO ; la numerotation du SDK C, differente, donne 5 = a distance, 6 = bouton, 7 = empreinte :
 *  elle N'EST PAS utilisee ici car les evenements observes `Method: 1` + `CardNo` suivent la numerotation CGI).
 * Valeur inconnue = `unknown`, jamais une supposition.
 */
export const METHODS: Readonly<Record<number, AccessMethod>> = {
  0: 'code',
  1: 'badge',
  2: 'badge', // carte puis mot de passe : le numero de badge est connu, le mot de passe n'est jamais transmis
  3: 'badge', // mot de passe puis carte
  4: 'remote', // A QUALIFIER
  5: 'exit_button', // A QUALIFIER
  6: 'fingerprint',
  15: 'face',
};

/**
 * Table `ErrorCode` (valide quand `Status` = 0). AUCUNE table n'est publiee dans [A][B] (seuls 0x65 « temperature » et 0x66
 * « sans masque » y figurent). Les valeurs ci-dessous viennent de la memoire du SDK C de Dahua (non verifiee) : A QUALIFIER sur
 * materiel. Une valeur absente de la table donne `other`.
 */
export const ERROR_REASONS: Readonly<Record<number, AccessReason>> = {
  0x10: 'unknown_credential', // non autorise
  0x11: 'disabled', // carte perdue / annulee
  0x12: 'disabled', // pas le droit sur cette porte
  0x14: 'expired', // hors periode de validite
  0x15: 'antipassback',
  0x17: 'door_locked', // porte en mode « toujours fermee »
  0x20: 'out_of_schedule', // hors plage horaire
  0x21: 'out_of_schedule', // jour ferie
  0x65: 'other', // temperature trop elevee [B]
  0x66: 'other', // sans masque [B]
};

// --- Lecture defensive ----------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Champ propre d'un objet (jamais une propriete heritee). */
function field(o: Obj, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** Nombre fini depuis un nombre, une chaine decimale ou hexadecimale « 0x10 » ; `null` sinon. */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.length === 0 || s.length > 32) return null;
    if (/^0[xX][0-9a-fA-F]{1,8}$/.test(s)) return Number.parseInt(s, 16);
    if (/^-?\d{1,18}(\.\d{1,9})?$/.test(s)) return Number(s);
  }
  return null;
}

function toInt(v: unknown): number | null {
  const n = toNumber(v);
  return n !== null && Number.isSafeInteger(n) ? n : null;
}

/** Parse un objet JSON ; `null` si invalide, trop long ou pas un objet. */
function parseJson(text: string | null): Obj | null {
  if (text === null || text.length === 0 || text.length > MAX_DATA_CHARS) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** Secondes (ou millisecondes) depuis 1970 -> millisecondes entieres ; `null` si inexploitable. */
function epochToMs(v: unknown): number | null {
  const n = toNumber(v);
  if (n === null || n <= 0) return null;
  const ms = n >= 1e11 ? n : n * 1000; // au-dela de 1e11, c'est deja des millisecondes (annee 5138 en secondes)
  const r = Math.round(ms);
  return Number.isSafeInteger(r) && r >= 1e12 ? r : null;
}

/** « 2021-08-06 12:34:31 » (heure locale du controleur) -> ms UTC. */
export function localTimeToMs(text: unknown, utcOffsetMin: number): number | null {
  if (typeof text !== 'string' || text.length > 40) return null;
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})/.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s) - utcOffsetMin * 60_000;
  return Number.isFinite(ms) && ms >= 1e12 ? ms : null;
}

/**
 * Heure du controleur a l'evenement (ms UTC) : `UTC` (secondes, flottant possible), sinon `CreateTime` (secondes), sinon
 * `LocaleTime` (heure locale convertie avec `utcOffsetMin`), sinon l'heure de reception. Une heure plus de 24 h dans le futur est
 * rejetee (repli sur la reception) : un controleur au calendrier fou ne doit pas faire refuser ses messages.
 */
export function eventTime(o: Obj, ctx: TranslateContext): { ts: number; known: boolean } {
  const candidates = [epochToMs(field(o, 'UTC')), epochToMs(field(o, 'CreateTime')), localTimeToMs(field(o, 'LocaleTime'), ctx.utcOffsetMin)];
  for (const c of candidates) {
    if (c !== null && c <= ctx.receivedAt + MAX_FUTURE_MS) return { ts: c, known: true };
  }
  return { ts: Math.trunc(ctx.receivedAt), known: false };
}

/** Numero de porte du contrat (1 a 4) depuis `Door` (ou l'index du flux) et la numerotation du controleur ; `null` si hors plage. */
export function doorNumber(raw: number | null, ctx: TranslateContext): number | null {
  if (raw === null) return null;
  const n = ctx.doorBase === 0 ? raw + 1 : raw;
  return Number.isInteger(n) && n >= 1 && n <= MAX_DOOR_NO ? n : null;
}

/** Motif de refus depuis `ErrorCode` et le mode d'ouverture. */
export function reasonFor(errorCode: number | null, method: AccessMethod): AccessReason {
  if (errorCode !== null && errorCode !== 0) return Object.hasOwn(ERROR_REASONS, errorCode) ? ERROR_REASONS[errorCode]! : 'other';
  // Refus sans code d'erreur precis lors d'une saisie de code : le plus probable est un mauvais code. A QUALIFIER.
  return method === 'code' ? 'wrong_pin' : 'other';
}

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/**
 * Passage depuis les champs d'un evenement `AccessControl` ou d'un enregistrement `AccessControlCardRec` (memes noms). Les
 * valeurs peuvent etre des nombres ou des chaines. `fallbackDoor` : numero de porte a utiliser quand `Door` manque (l'index du
 * flux pour un evenement ; l'unique porte declaree pour un enregistrement).
 */
function passageFrom(o: Obj, ctx: TranslateContext, fallbackDoor: number | null): Translation {
  // `Door` present mais illisible ou hors plage : rien (jamais un passage attribue a la mauvaise porte).
  const doorField = field(o, 'Door');
  const doorNo = doorField === undefined || doorField === null ? fallbackDoor : doorNumber(toInt(doorField), ctx);
  if (doorNo === null) return { kind: 'none', reason: 'porte hors plage ou inconnue' };

  const methodCode = toInt(field(o, 'Method'));
  const method: AccessMethod = methodCode !== null && Object.hasOwn(METHODS, methodCode) ? METHODS[methodCode]! : 'unknown';

  // `Status` absent = succes [B] ; 1 = succes, 0 = echec ; toute autre valeur = refus par prudence (jamais un acces « accepte » suppose).
  const statusRaw = field(o, 'Status');
  const status = statusRaw === undefined || statusRaw === null ? 1 : toInt(statusRaw);
  const granted = status === 1;

  const typeRaw = field(o, 'Type');
  const direction: PassageInput['direction'] = typeof typeRaw === 'string' ? (/^entry$/i.test(typeRaw.trim()) ? 'in' : /^exit$/i.test(typeRaw.trim()) ? 'out' : null) : null;

  const errorCode = toInt(field(o, 'ErrorCode'));
  const { ts, known } = eventTime(o, ctx);

  const card = field(o, 'CardNo');
  // Mode « code » : jamais de numero dans le message (le champ pourrait contenir autre chose que l'identifiant d'une carte).
  const credential = method === 'code' ? null : cleanCredential(typeof card === 'string' || typeof card === 'number' ? card : null);
  // `CardName` seulement : `Name` est le nom de l'action ou de la porte (« OpenDoor »), pas celui d'une personne [C].
  const holderName = cleanText(field(o, 'CardName'), 64);
  const holderRef = cleanRef(field(o, 'UserID'));

  const recNoValue = toInt(field(o, 'RecNo'));
  const recNo = recNoValue !== null && recNoValue >= 0 ? String(recNoValue) : null;
  const createSec = known ? Math.floor(ts / 1000) : null;
  // Sans RecNo : identifiant synthetique deterministe (heure, porte, empreinte courte des champs d'identite). A QUALIFIER.
  const baseId = recNo ?? `x${Math.floor(ts / 1000)}.${doorNo}.${shortHash(`${ts}|${doorNo}|${card ?? ''}|${methodCode ?? ''}|${status ?? ''}|${field(o, 'UserID') ?? ''}`)}`;
  // Epoque > 0 (controleur remplace) : `<epoque>.<identifiant>`, y compris pour l'identifiant synthetique ; le curseur reste le RecNo seul.
  const eventId = epochEventId(ctx.epoch ?? 0, baseId);
  // Carte de CONTRAINTE : `CardType` = 5 (table [A]). A QUALIFIER : le champ n'est vu que dans l'exemple d'un terminal ASI (valeur 0).
  const duress = toInt(field(o, 'CardType')) === 5;

  const passage: PassageInput = {
    eventId,
    direction,
    credential,
    holderName,
    holderRef,
    method,
    result: granted ? 'granted' : 'denied',
    reason: granted ? null : reasonFor(errorCode, method),
    deferred: false,
    doorNo,
    ts,
    ...(recNo !== null ? { cursor: recNo } : {}),
  };
  return { kind: 'passage', passage, recNo, createSec, duress };
}

/** Index du flux (`index=N`) -> numero de porte du contrat. */
function indexDoor(channel: number, ctx: TranslateContext): number | null {
  if (!Number.isInteger(channel)) return null;
  return doorNumber(channel - 1, ctx);
}

/**
 * Evenement du flux -> traduction. Codes traites :
 *  - `AccessControl` [A][B][C] : un passage (accepte ou refuse) ;
 *  - `DoorStatus` (`Status` = Open / Close) : ouverture / fermeture. Format vu sur un VTO ; A QUALIFIER sur ASC/ASI ;
 *  - `DoorNotClosed` : porte maintenue ouverte (Start / Pulse) et fin (Stop). A QUALIFIER (nom du code non publie dans [A][B]) ;
 *  - `BreakIn` : porte forcee (effraction). A QUALIFIER ;
 *  - `ChassisIntruded` : ouverture du boitier = sabotage du controleur (Start) et fin (Stop). Nom vu dans la liste d'une
 *    integration Home Assistant ; A QUALIFIER.
 * `Duress` (contrainte) devient une alarme `panic` (`doorKind: 'duress'`, fin ignoree). `RepeatEnter` (anti-retour) n'est PAS
 * traduit : le refus est deja signale par le passage (voir `reason` de la reponse « none »).
 */
export function translateEvent(ev: RawEvent, ctx: TranslateContext): Translation {
  if (!isObj(ev) || typeof ev.code !== 'string' || typeof ev.action !== 'string') return { kind: 'none', reason: 'evenement illisible' };
  const action = ev.action.toLowerCase();
  const door = indexDoor(ev.channel, ctx);
  switch (ev.code) {
    case 'AccessControl': {
      const data = parseJson(ev.data);
      if (!data) return { kind: 'none', reason: 'donnees de passage illisibles' };
      return passageFrom(data, ctx, door);
    }
    case 'DoorStatus': {
      const data = parseJson(ev.data);
      if (!data) return { kind: 'none', reason: 'etat de porte illisible' };
      const status = field(data, 'Status');
      const doorField = field(data, 'Door');
      const doorNo = doorField === undefined || doorField === null ? door : doorNumber(toInt(doorField), ctx);
      if (doorNo === null) return { kind: 'none', reason: 'porte hors plage ou inconnue' };
      const word = typeof status === 'string' ? status.trim().toLowerCase() : '';
      const { ts } = eventTime(data, ctx);
      if (word === 'open') return { kind: 'door', doorNo, doorKind: 'opened', ts, idPart: action };
      if (word === 'close' || word === 'closed') return { kind: 'door', doorNo, doorKind: 'closed', ts, idPart: action };
      return { kind: 'none', reason: 'etat de porte inconnu' };
    }
    case 'DoorNotClosed':
    case 'BreakIn': {
      const data = parseJson(ev.data) ?? {};
      const doorField = field(data, 'Door');
      const doorNo = doorField === undefined || doorField === null ? door : doorNumber(toInt(doorField), ctx);
      if (doorNo === null) return { kind: 'none', reason: 'porte hors plage ou inconnue' };
      const { ts } = eventTime(data, ctx);
      if (ev.code === 'BreakIn') return action === 'stop' ? { kind: 'none', reason: 'fin d\'effraction (sans objet)' } : { kind: 'door', doorNo, doorKind: 'forced', ts, idPart: action };
      return { kind: 'door', doorNo, doorKind: action === 'stop' ? 'held_open_end' : 'held_open', ts, idPart: action };
    }
    case 'ChassisIntruded': {
      const data = parseJson(ev.data) ?? {};
      const { ts } = eventTime(data, ctx);
      return { kind: 'controller', ctlKind: action === 'stop' ? 'tamper_end' : 'tamper', ts, idPart: action };
    }
    case 'Duress': {
      // Contrainte (code ou doigt « sous menace ») : alarme `panic` toujours active, sans fin. Le nom du code est celui d'une liste
      // d'evenements d'integrateur ; ses champs ne sont pas publies dans [A][B] : A QUALIFIER (porte : `Door`, sinon l'index du flux).
      if (action === 'stop') return { kind: 'none', reason: 'fin de contrainte (sans objet : une contrainte est sans fin)' };
      const data = parseJson(ev.data) ?? {};
      const doorField = field(data, 'Door');
      const doorNo = doorField === undefined || doorField === null ? door : doorNumber(toInt(doorField), ctx);
      if (doorNo === null) return { kind: 'none', reason: 'porte hors plage ou inconnue (alarme de contrainte non transmise)' };
      const { ts } = eventTime(data, ctx);
      // idPart : distingue deux contraintes de la meme seconde sur la meme porte quand le controleur donne un n° d'enregistrement.
      const rec = toInt(field(data, 'RecNo'));
      return { kind: 'door', doorNo, doorKind: 'duress', ts, idPart: rec !== null && rec >= 0 ? `r${rec}` : action };
    }
    case 'RepeatEnter':
      return { kind: 'none', reason: 'anti-retour (le refus est deja signale par le passage)' };
    default:
      return { kind: 'none', reason: 'evenement sans objet' };
  }
}

/** Partie brute du flux -> evenement, ou `null` (signe de vie, texte inconnu). */
export function parsePart(body: string): RawEvent | null {
  if (typeof body !== 'string') return null;
  const ev = parseEventPart(body.length > 65_536 ? body.slice(0, 65_536) : body);
  if (!ev || ev.channel > 1_000_000) return null;
  return ev;
}

// --- Enregistrements (recordFinder) ---------------------------------------------------------------------------------------

/** Champs conserves d'un enregistrement : tout le reste (dont `Password`) est ecarte des la lecture. */
const RECORD_KEYS: ReadonlySet<string> = new Set(['RecNo', 'CreateTime', 'CardNo', 'CardName', 'UserID', 'Type', 'Method', 'Status', 'Door', 'ReaderID', 'ErrorCode']);
const MAX_RECORDS = 5000;
const MAX_LINES = 100_000;
const MAX_LINE = 600;

export interface RecordPage {
  totalCount: number | null;
  found: number | null;
  records: Record<string, string>[];
}

/**
 * Reponse de `recordFinder.cgi?action=find` : `totalCount=`, `found=`, `records[i].Cle=valeur` [A]. Tolere tout : lignes
 * inconnues, indices enormes, valeurs tres longues, fins de ligne CRLF.
 */
export function parseRecordPage(body: string, allowed: ReadonlySet<string> = RECORD_KEYS): RecordPage {
  const page: RecordPage = { totalCount: null, found: null, records: [] };
  const byIndex = new Map<number, Record<string, string>>();
  let lines = 0;
  for (const raw of body.split('\n')) {
    if (++lines > MAX_LINES) break;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length > MAX_LINE) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'totalCount') page.totalCount = toInt(value);
    else if (key === 'found') page.found = toInt(value);
    else {
      const m = /^records\[(\d{1,6})\]\.([A-Za-z]{1,32})$/.exec(key);
      if (!m) continue;
      const index = Number(m[1]);
      const name = m[2]!;
      if (index >= MAX_RECORDS || !allowed.has(name)) continue;
      let rec = byIndex.get(index);
      if (!rec) {
        rec = {};
        byIndex.set(index, rec);
      }
      rec[name] = value;
    }
  }
  page.records = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  return page;
}

/** Enregistrement `AccessControlCardRec` -> passage (`deferred` est decide par l'appelant). */
export function translateRecord(rec: Record<string, string>, ctx: TranslateContext): Translation {
  const only = ctx.doorNos?.length === 1 ? ctx.doorNos[0]! : null;
  return passageFrom(rec, ctx, only);
}

// --- Reponses simples -----------------------------------------------------------------------------------------------------

/** `global.cgi?action=getCurrentTime` : `result=2011-7-3 21:02:32` (heure LOCALE du controleur) -> ms UTC, ou `null`. */
export function parseCurrentTime(body: string, utcOffsetMin: number): number | null {
  const m = /result\s*=\s*([0-9]{4}-[0-9]{1,2}-[0-9]{1,2}[ T][0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2})/.exec(body.slice(0, 200));
  return m ? localTimeToMs(m[1], utcOffsetMin) : null;
}

/**
 * `accessControl.cgi?action=getDoorStatus&channel=N` -> `Info.status=Open|Close|Break`. A QUALIFIER : cette commande n'est pas
 * dans [A] (vue sur la documentation des interphones Dahua).
 */
export function parseDoorStatus(body: string): 'open' | 'closed' | 'break' | null {
  const m = /(?:^|[.\s])status\s*=\s*([A-Za-z]{1,12})/im.exec(body.slice(0, 400));
  if (!m) return null;
  const w = m[1]!.toLowerCase();
  if (w === 'open') return 'open';
  if (w === 'close' || w === 'closed') return 'closed';
  if (w === 'break') return 'break';
  return null;
}

export type DoorMode = 'Normal' | 'OpenAlways' | 'CloseAlways';

/**
 * `configManager.cgi?action=getConfig&name=AccessControl` : cherche `table.AccessControl[i].State=...` [valeurs vues dans la
 * documentation de l'API HTTP : Normal, CloseAlways, OpenAlways, NoPersonNC, NoPersonNO]. Rend le mode brut, ou `null` s'il manque.
 */
export function parseDoorMode(body: string, tableIndex: number): string | null {
  const re = new RegExp(`(?:^|\\n)\\s*table\\.AccessControl\\[${tableIndex}\\]\\.State\\s*=\\s*([A-Za-z]{1,24})`, 'm');
  const m = re.exec(body.slice(0, 200_000));
  return m ? m[1]! : null;
}
