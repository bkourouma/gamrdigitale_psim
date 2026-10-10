/**
 * Protocole SIA DC-09 (SIA-DCS sur IP) : decodage et encodage des trames, sans aucun acces reseau.
 *
 * Trame : <LF><CRC 4 hex><0LLL>"<TOKEN>"<seq 4 chiffres>[R<recepteur>]L<prefixe>#<compte>[<donnees>][<etendues>...]<horodatage><CR>
 *  - CRC-16/ARC (polynome 0x8005 reflechi, valeur initiale 0) et longueur LLL (hexadecimal) portent sur la partie
 *    qui va du premier guillemet jusqu'avant le <CR> ;
 *  - chiffre (`"*SIA-DCS"`, `"*ADM-CID"`, `"*NULL"`) : apres le `[`, la suite est en hexadecimal ; une fois dechiffree
 *    (AES-CBC, vecteur initial nul, sans bourrage PKCS) elle vaut `<bourrage aleatoire>|<donnees>][<etendues>]<horodatage>` ;
 *  - horodatage UTC `_HH:MM:SS,MM-DD-YYYY`.
 *
 * Toutes les fonctions sont pures et ne levent jamais d'exception sur une entree recue du reseau.
 */
import { createCipheriv, createDecipheriv, randomInt, timingSafeEqual } from 'node:crypto';

/** Taille maximale d'une trame, LF et CR compris. */
export const MAX_FRAME = 1024;
/** Nombre maximal d'evenements lus dans une trame (au-dela : trame refusee). */
export const MAX_EVENTS_PER_FRAME = 32;
/** Nombre maximal de blocs de donnees etendues `[X...]` acceptes. */
const MAX_EXT_BLOCKS = 8;

export const TOKENS: ReadonlySet<string> = new Set(['SIA-DCS', 'ADM-CID', 'NULL']);

/** CRC-16/ARC : poly 0x8005 reflechi (0xA001), valeur initiale 0, sans XOR final. */
export function crc16(data: Buffer | string): number {
  const buf = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
  let crc = 0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, '0');

/** Habille un message (du guillemet a l'horodatage) : LF, CRC, longueur, CR. */
export function frame(message: string): string {
  return `\n${hex(crc16(message), 4)}0${hex(message.length, 3)}${message}\r`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Horodatage DC-09 (UTC) : `_HH:MM:SS,MM-DD-YYYY`. */
export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return `_${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())},${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}-${d.getUTCFullYear()}`;
}

const TS_RE = /^_(\d{2}):(\d{2}):(\d{2}),(\d{2})-(\d{2})-(\d{4})$/;

/** Lit un horodatage DC-09 ; `null` s'il est mal forme ou impossible (31 fevrier, 25 h...). */
export function parseTimestamp(text: string): number | null {
  const m = TS_RE.exec(text);
  if (!m) return null;
  const [hh, mi, ss, mo, dd, yyyy] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (hh > 23 || mi > 59 || ss > 59 || mo < 1 || mo > 12 || dd < 1 || yyyy < 2000 || yyyy > 2199) return null;
  const ms = Date.UTC(yyyy, mo - 1, dd, hh, mi, ss);
  const d = new Date(ms);
  if (d.getUTCDate() !== dd || d.getUTCMonth() !== mo - 1) return null;
  return ms;
}

/** En-tete d'une trame dont le CRC et la longueur sont corrects. */
export interface Header {
  encrypted: boolean;
  token: string;
  seq: string;
  /** `R...` tel que recu (ou chaine vide), renvoye a l'identique dans la reponse. */
  receiver: string;
  /** `L...` tel que recu. */
  prefix: string;
  /** Numero de compte, en majuscules, sans le `#`. */
  account: string;
  /** Tout ce qui suit le premier `[` (donnees en clair, ou hexadecimal chiffre). */
  body: string;
}

export type OuterResult =
  | { ok: true; header: Header }
  /** `none` : ce n'est pas une trame DC-09 (pas de reponse) ; `nak` : erreur de transmission ; `duh` : non compris. */
  | { ok: false; reply: 'none' | 'nak' | 'duh'; reason: string };

const PRINTABLE_RE = /^[\x20-\x7e]*$/;
const OUTER_RE = /^([0-9A-Fa-f]{4})0([0-9A-Fa-f]{3})/;
const HEADER_RE = /^"(\*?)([A-Z][A-Z0-9-]{1,11})"(\d{4})(R[0-9A-Fa-f]{1,6})?(L[0-9A-Fa-f]{1,6})#([0-9A-Fa-f]{3,16})\[/;

/** Premiere etape : CRC, longueur, en-tete. `raw` = octets entre le LF et le CR (exclus). */
export function parseOuter(raw: Buffer): OuterResult {
  if (raw.length + 2 > MAX_FRAME) return { ok: false, reply: 'none', reason: 'trame trop longue' };
  const text = raw.toString('latin1');
  if (!PRINTABLE_RE.test(text)) return { ok: false, reply: 'none', reason: 'caracteres non imprimables' };
  const m = OUTER_RE.exec(text);
  if (!m) return { ok: false, reply: 'none', reason: 'pas une trame DC-09' };
  const message = text.slice(8);
  if (parseInt(m[2] as string, 16) !== message.length) return { ok: false, reply: 'nak', reason: 'longueur incorrecte' };
  const expected = Buffer.from(hex(crc16(message), 4), 'latin1');
  const received = Buffer.from((m[1] as string).toUpperCase(), 'latin1');
  if (!timingSafeEqual(expected, received)) return { ok: false, reply: 'nak', reason: 'CRC incorrect' };
  const h = HEADER_RE.exec(message);
  if (!h) return { ok: false, reply: 'duh', reason: 'en-tete non reconnu' };
  return {
    ok: true,
    header: {
      encrypted: h[1] === '*',
      token: h[2] as string,
      seq: h[3] as string,
      receiver: h[4] ?? '',
      prefix: h[5] as string,
      account: (h[6] as string).toUpperCase(),
      body: message.slice(h[0].length),
    },
  };
}

function algorithm(key: Buffer): string {
  return `aes-${key.length * 8}-cbc`;
}

const ZERO_IV = Buffer.alloc(16);

/**
 * Dechiffre la partie chiffree (hexadecimal apres le `[`). Renvoie le texte qui suit le bourrage et le `|`
 * (`<donnees>][...]<horodatage>`), ou `null` si le chiffre est mal forme ou la cle mauvaise.
 */
export function decryptBody(body: string, key: Buffer): string | null {
  const cipherHex = body.endsWith(']') ? body.slice(0, -1) : body;
  if (cipherHex.length === 0 || cipherHex.length % 32 !== 0 || !/^[0-9A-Fa-f]+$/.test(cipherHex)) return null;
  let plain: Buffer;
  try {
    const d = createDecipheriv(algorithm(key), key, ZERO_IV);
    d.setAutoPadding(false);
    plain = Buffer.concat([d.update(Buffer.from(cipherHex, 'hex')), d.final()]);
  } catch {
    return null;
  }
  const bar = plain.indexOf(0x7c); // '|'
  if (bar < 0) return null;
  const rest = plain.subarray(bar + 1).toString('latin1');
  if (!PRINTABLE_RE.test(rest)) return null;
  return rest;
}

const PAD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Chiffre `contenu` selon DC-09 : bourrage aleatoire (sans `|`), `|`, contenu ; resultat en hexadecimal majuscule. */
export function encryptContent(content: string, key: Buffer): string {
  // Au moins un caractere de bourrage ; total (bourrage + '|' + contenu) multiple de 16.
  const padLen = 16 - ((content.length + 1) % 16) || 16;
  let pad = '';
  for (let i = 0; i < padLen; i++) pad += PAD_ALPHABET[randomInt(PAD_ALPHABET.length)];
  const c = createCipheriv(algorithm(key), key, ZERO_IV);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(`${pad}|${content}`, 'latin1'), c.final()]).toString('hex').toUpperCase();
}

export interface Inner {
  data: string;
  extended: string[];
  /** Horodatage en ms epoch, `null` s'il est absent. */
  ts: number | null;
  tsText: string | null;
}

/** Lit `<donnees>][<etendues>]...<horodatage>` (ce qui suit le `[` d'ouverture). */
export function parseInner(text: string): { ok: true; inner: Inner } | { ok: false; reason: string } {
  const close = text.indexOf(']');
  if (close < 0) return { ok: false, reason: 'bloc de donnees non ferme' };
  const data = text.slice(0, close);
  if (data.includes('[')) return { ok: false, reason: 'bloc de donnees mal forme' };
  let rest = text.slice(close + 1);
  const extended: string[] = [];
  while (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end < 0 || extended.length >= MAX_EXT_BLOCKS) return { ok: false, reason: 'donnees etendues mal formees' };
    extended.push(rest.slice(1, end));
    rest = rest.slice(end + 1);
  }
  if (rest === '') return { ok: true, inner: { data, extended, ts: null, tsText: null } };
  const ts = parseTimestamp(rest);
  if (ts === null) return { ok: false, reason: 'horodatage mal forme' };
  return { ok: true, inner: { data, extended, ts, tsText: rest } };
}

/** Evenement lu dans les donnees d'une trame (SIA-DCS ou Contact ID), avant traduction. */
export interface RawEvent {
  format: 'sia' | 'cid';
  /** SIA : 2 lettres (BA, FA...) ; Contact ID : 3 chiffres (130, 301...). */
  code: string;
  /** Contact ID : 'E' nouvel evenement (1), 'R' restauration (3), 'P' evenement precedent encore present (6). */
  qualifier: 'E' | 'R' | 'P';
  /** Zone (ou utilisateur selon le code), normalisee sans zeros de tete ; `null` si absente. */
  zone: string | null;
  /** Partition / groupe, normalisee ; `null` si absente. */
  partition: string | null;
}

/** `007` -> `7`, `0` -> `0`. Uniquement des chiffres (longueur deja bornee par l'appelant). */
export function normalizeNumber(text: string): string {
  return String(parseInt(text, 10));
}

const ACCOUNT_PREFIX_RE = /^#([0-9A-Fa-f]{3,16})\|/;

function stripAccount(data: string, account: string): { ok: true; rest: string } | { ok: false; reason: string } {
  const m = ACCOUNT_PREFIX_RE.exec(data);
  if (!m) return { ok: true, rest: data };
  if ((m[1] as string).toUpperCase() !== account) return { ok: false, reason: 'compte des donnees different du compte de la trame' };
  return { ok: true, rest: data.slice(m[0].length) };
}

/**
 * Donnees SIA-DCS : `#<compte>|N<champs>` ou les champs sont separes par `/` : modificateurs en minuscules
 * (`ri` partition, `id` utilisateur, `ti` heure...) et codes d'evenement en majuscules suivis de la zone
 * (`BA01`). Un texte libre `^...^` est ignore.
 */
export function parseSiaData(data: string, account: string): { ok: true; events: RawEvent[] } | { ok: false; reason: string } {
  const a = stripAccount(data, account);
  if (!a.ok) return a;
  let s = a.rest;
  if (/^[NO](?=[A-Za-z]{2})/.test(s)) s = s.slice(1);
  const events: RawEvent[] = [];
  let partition: string | null = null;
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === '/' || c === ' ') {
      i++;
      continue;
    }
    if (c === '^') {
      const end = s.indexOf('^', i + 1);
      if (end < 0) return { ok: false, reason: 'texte non ferme' };
      i = end + 1;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (/^[a-z]{2}$/.test(two)) {
      i += 2;
      const start = i;
      while (i < s.length && /[0-9:.-]/.test(s[i] as string)) i++;
      const value = s.slice(start, i);
      if (two === 'ri') partition = /^\d{1,6}$/.test(value) ? normalizeNumber(value) : null;
      continue;
    }
    if (/^[A-Z]{2}$/.test(two)) {
      i += 2;
      const start = i;
      while (i < s.length && /[0-9]/.test(s[i] as string)) i++;
      const param = s.slice(start, i);
      if (param.length > 6) return { ok: false, reason: 'numero de zone trop long' };
      if (events.length >= MAX_EVENTS_PER_FRAME) return { ok: false, reason: "trop d'evenements dans une trame" };
      events.push({ format: 'sia', code: two, qualifier: 'E', zone: param === '' ? null : normalizeNumber(param), partition });
      continue;
    }
    return { ok: false, reason: 'donnees SIA non reconnues' };
  }
  if (events.length === 0) return { ok: false, reason: "aucun code d'evenement" };
  return { ok: true, events };
}

const CID_RE = /^([136])(\d{3}) ?(\d{2}) ?(\d{3})$/;

/** Donnees Contact ID : `#<compte>|QEEE GG CCC` (qualificatif, evenement, partition, zone ou utilisateur). */
export function parseCidData(data: string, account: string): { ok: true; events: RawEvent[] } | { ok: false; reason: string } {
  const a = stripAccount(data, account);
  if (!a.ok) return a;
  const m = CID_RE.exec(a.rest.trim());
  if (!m) return { ok: false, reason: 'donnees Contact ID non reconnues' };
  const qualifier = m[1] === '3' ? 'R' : m[1] === '6' ? 'P' : 'E';
  return {
    ok: true,
    events: [{ format: 'cid', code: m[2] as string, qualifier, partition: normalizeNumber(m[3] as string), zone: normalizeNumber(m[4] as string) }],
  };
}

/** Champs de l'en-tete repris dans une reponse. */
type Echo = Pick<Header, 'seq' | 'receiver' | 'prefix' | 'account'>;

/** ACK : meme sequence, recepteur, prefixe et compte ; chiffre si la trame recue l'etait. */
export function ackFrame(h: Echo, nowMs: number, key: Buffer | null): string {
  const ts = formatTimestamp(nowMs);
  const id = `${h.seq}${h.receiver}${h.prefix}#${h.account}`;
  if (key) return frame(`"*ACK"${id}[${encryptContent(`]${ts}`, key)}`);
  return frame(`"ACK"${id}[]${ts}`);
}

/** NAK : forme fixe de la norme, avec l'heure du recepteur pour que la centrale se recale. */
export function nakFrame(nowMs: number): string {
  return frame(`"NAK"0000R0L0A0[]${formatTimestamp(nowMs)}`);
}

/** DUH : message compris jusqu'a l'en-tete mais pas au-dela (jeton ou donnees non pris en charge). */
export function duhFrame(h: Echo | null, nowMs: number): string {
  const id = h ? `${h.seq}${h.receiver}${h.prefix}#${h.account}` : '0000R0L0A0';
  return frame(`"DUH"${id}[]${formatTimestamp(nowMs)}`);
}
