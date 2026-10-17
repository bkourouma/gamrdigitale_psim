/**
 * Nettoyage des donnees venues d'un controleur (jamais de confiance) et fabrication des messages vers le PSIM
 * (docs/CONTROLE-ACCES.md, par. 2). Aucune horloge, aucun reseau, aucun disque.
 */
import { createHash } from 'node:crypto';
import type { AccessPassage, DeviceMessage } from '../../module.ts';
import { normalizeMsgId } from '../../msgid.ts';
import type { PassageInput } from './types.ts';

/** Limite du message JSON accepte par le broker du PSIM. */
export const MAX_MESSAGE_BYTES = 1024;
/** Longueurs maximales du contrat (par. 2). */
export const MAX_HOLDER_NAME = 64;
export const MAX_CREDENTIAL = 32;
export const MAX_HOLDER_REF = 32;
export const MAX_EVENT_ID = 40;
export const MAX_CONTROLLER_ID = 32;

/** Format d'un identifiant de controleur (`access_controller.id`) et d'un identifiant d'equipement PSIM. */
export const CONTROLLER_ID = /^[A-Za-z0-9_-]{1,32}$/;
/** Une entree plus longue est coupee AVANT tout traitement : une chaine hostile de plusieurs Mo ne coute rien. */
const PRE_LIMIT = 4096;
const FORBIDDEN_ID_CHARS = /[^A-Za-z0-9._:-]/g;
/** Caracteres invisibles qui servent a tromper l'oeil (sens de lecture inverse, largeur nulle, marque d'ordre d'octets). */
const INVISIBLE_CODES: ReadonlySet<number> = new Set([0xad, 0x200b, 0x200e, 0x200f, 0x2060, 0xfeff]);
/** Plages (bornes incluses) : controles du sens de lecture, et moities de paire de substitution (jamais valides seules). */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [[0x202a, 0x202e], [0x2066, 0x2069], [0xd800, 0xdfff]];

/** Retire les caracteres invisibles. L'iteration se fait par point de code : une paire valide reste entiere, une moitie seule est retiree. */
function stripInvisible(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (INVISIBLE_CODES.has(c) || INVISIBLE_RANGES.some(([a, b]) => c >= a && c <= b)) continue;
    out += ch;
  }
  return out;
}
const DIGEST_LEN = 12;

/** Texte d'une valeur inconnue : chaine, nombre fini ou entier long seulement. Tout le reste (objet, tableau...) est refuse. */
function toText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw.length > PRE_LIMIT ? raw.slice(0, PRE_LIMIT) : raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'bigint') return String(raw).slice(0, PRE_LIMIT);
  return null;
}

/** Borne a `max` unites UTF-16 sans couper une paire de substitution (un emoji ne reste jamais a moitie). */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return s.slice(0, end).trimEnd();
}

/**
 * Texte libre venu du reseau (nom, motif...) : caracteres de controle remplaces par une espace, caracteres invisibles
 * et moities de paire retires, espaces multiples ramenees a une, normalise NFC, borne a `max` unites UTF-16 sans couper
 * une paire de substitution. `null` si le resultat est vide ou si l'entree n'est ni une chaine ni un nombre.
 */
export function cleanText(raw: unknown, max: number): string | null {
  const limit = Math.floor(max);
  if (!Number.isFinite(limit) || limit < 1) return null;
  const text = toText(raw);
  if (text === null) return null;
  const s = stripInvisible(text.replace(/\p{Cc}/gu, ' '))
    .replace(/\s+/gu, ' ')
    .trim()
    .normalize('NFC');
  const out = cut(s, limit);
  return out === '' ? null : out;
}

function cleanId(raw: unknown, max: number): string | null {
  const text = toText(raw);
  if (text === null) return null;
  const s = text.replace(FORBIDDEN_ID_CHARS, '').slice(0, max);
  return s === '' ? null : s;
}

/** Numero de badge : alphabet `[A-Za-z0-9._:-]`, 32 caracteres au plus ; `null` si vide. */
export function cleanCredential(raw: unknown): string | null {
  return cleanId(raw, MAX_CREDENTIAL);
}

/** Identifiant du titulaire dans le controleur : meme alphabet, 32 caracteres au plus ; `null` si vide. */
export function cleanRef(raw: unknown): string | null {
  return cleanId(raw, MAX_HOLDER_REF);
}

/**
 * Identifiant d'evenement conforme (`^[A-Za-z0-9._:-]{1,40}$`). Une valeur deja conforme est rendue telle quelle ; sinon
 * (caracteres interdits ou plus de 40) elle est remplacee par un debut nettoye suivi d'une empreinte de l'ORIGINAL :
 * deterministe, et deux originaux differents gardent deux identifiants differents. `null` si l'entree est vide ou invalide.
 */
export function cleanEventId(raw: unknown): string | null {
  const text = toText(raw);
  if (text === null || text === '') return null;
  const cleaned = text.replace(FORBIDDEN_ID_CHARS, '');
  if (cleaned === text && text.length <= MAX_EVENT_ID) return text;
  const digest = createHash('sha256').update(text).digest('hex').slice(0, DIGEST_LEN);
  return `${cleaned.slice(0, MAX_EVENT_ID - DIGEST_LEN - 1) || 'x'}.${digest}`;
}

const DIRECTIONS: ReadonlySet<string> = new Set(['in', 'out']);
const METHODS: ReadonlySet<string> = new Set(['badge', 'code', 'fingerprint', 'face', 'exit_button', 'remote', 'unknown']);
const REASONS: ReadonlySet<string> = new Set(['unknown_credential', 'expired', 'out_of_schedule', 'disabled', 'wrong_pin', 'antipassback', 'door_locked', 'other']);

/** Heure d'evenement acceptable pour le PSIM : entier en millisecondes, apres septembre 2001 (sinon c'est des secondes). */
export function validTs(ts: unknown): ts is number {
  return typeof ts === 'number' && Number.isSafeInteger(ts) && ts >= 1e12;
}

/** Identifiant de message d'un passage : `acc:<controllerId>:<eventId>`, nettoye par `normalizeMsgId` s'il depasse 64 caracteres. */
export function passageMsgId(controllerId: string, eventId: string): string {
  return normalizeMsgId(`acc:${controllerId}:${eventId}`);
}

/**
 * Message de passage conforme au contrat par. 2 : `{ event, ts, msgId, access }`, rien d'autre.
 *
 * Toutes les donnees sont re-verifiees ici, meme si la marque a deja nettoye :
 *  - `controllerId` invalide, `ts` invalide, `result` inconnu : exception (rien de valable a envoyer) ;
 *  - `eventId` rendu conforme par `cleanEventId` ; `direction` inconnue = `null` ; `method` inconnue = `unknown` ;
 *  - un passage accepte a toujours `reason = null` ; un refus sans motif connu a `reason = 'other'` ;
 *  - mode  "code" (PIN) : `credential` est force a `null` (jamais un code PIN dans le message, hypothese prudente) ;
 *  - `holderName` est nettoye, borne a 64 caracteres, puis raccourci jusqu'a ce que le message tienne dans `maxBytes`
 *    (1 024 octets par defaut) ; il devient `null` s'il ne reste rien.
 * Les exceptions ne citent jamais une donnee du controleur.
 */
export function passageMessage(controllerId: string, p: PassageInput, maxBytes: number = MAX_MESSAGE_BYTES): DeviceMessage {
  if (typeof controllerId !== 'string' || !CONTROLLER_ID.test(controllerId)) throw new Error("identifiant de controleur invalide");
  if (!validTs(p.ts)) throw new Error("heure du passage invalide (millisecondes depuis 1970, entier)");
  if (p.result !== 'granted' && p.result !== 'denied') throw new Error('resultat du passage invalide');
  const eventId = cleanEventId(p.eventId);
  if (eventId === null) throw new Error("identifiant d'evenement vide ou invalide");
  const method = (typeof p.method === 'string' && METHODS.has(p.method) ? p.method : 'unknown') as AccessPassage['method'];
  const granted = p.result === 'granted';
  const reason = granted ? null : ((typeof p.reason === 'string' && REASONS.has(p.reason) ? p.reason : 'other') as AccessPassage['reason']);
  const access: AccessPassage = {
    v: 1,
    controllerId,
    eventId,
    direction: (typeof p.direction === 'string' && DIRECTIONS.has(p.direction) ? p.direction : null) as AccessPassage['direction'],
    credential: method === 'code' ? null : cleanCredential(p.credential),
    holderName: cleanText(p.holderName, MAX_HOLDER_NAME),
    holderRef: cleanRef(p.holderRef),
    method,
    result: p.result,
    reason,
    deferred: p.deferred === true,
  };
  const msg: DeviceMessage = {
    event: granted ? 'badge_granted' : 'badge_denied',
    ts: p.ts,
    msgId: passageMsgId(controllerId, eventId),
    access,
  };
  // Le nom est la seule partie variable : on le raccourcit caractere par caractere (jamais une paire coupee) jusqu'a tenir.
  while (Buffer.byteLength(JSON.stringify(msg)) > maxBytes) {
    if (access.holderName === null) throw new Error(`message de passage trop gros (plus de ${maxBytes} octets)`);
    const chars = Array.from(access.holderName);
    chars.pop();
    access.holderName = chars.join('').trimEnd() || null;
  }
  return msg;
}

/** Description d'un evenement d'etat a envoyer pour une porte. */
export interface DoorEventSpec {
  controllerId: string;
  doorNo: number;
  /** Nature de l'evenement cote module (`opened`, `forced`, `clock_drift`...) : sert uniquement a fabriquer le msgId. */
  kind: string;
  /** Evenement PSIM envoye (un de EVENTS de server/sources.ts). */
  psimEvent: string;
  /** Heure de l'evenement (ms, entier). */
  ts: number;
  /** Complement d'identification (no d'enregistrement...) pour distinguer deux evenements de meme nature au meme instant. */
  idPart?: string;
}

/**
 * Message d'etat d'une porte : `{ event, ts, msgId }`. Le msgId est deterministe
 * (`acc:<controllerId>:<kind>-<porte>-<ts>[-<idPart>]`, nettoye et borne a 64 caracteres) : le meme evenement redonne le meme
 * msgId (renvoi, recuperation F8), deux evenements distincts donnent deux msgId distincts.
 */
export function doorEventMessage(spec: DoorEventSpec): DeviceMessage {
  if (!CONTROLLER_ID.test(spec.controllerId)) throw new Error("identifiant de controleur invalide");
  if (!validTs(spec.ts)) throw new Error("heure de l'evenement invalide");
  const part = spec.idPart === undefined ? '' : String(spec.idPart);
  // Un complement long est remplace par son empreinte (entiere) : jamais deux evenements distincts avec le meme msgId.
  const idPart = part === '' ? '' : part.length > 64 ? `-${createHash('sha256').update(part).digest('hex').slice(0, DIGEST_LEN)}` : `-${part}`;
  const raw = `acc:${spec.controllerId}:${spec.kind}-${spec.doorNo}-${spec.ts}${idPart}`;
  return { event: spec.psimEvent, ts: spec.ts, msgId: normalizeMsgId(raw) };
}
