/**
 * Codage BER minimal pour SNMP v1 / v2c, en lecture seule : seules les requetes « lecture d'une valeur »
 * (GetRequest) sont construites ; les reponses (GetResponse) sont decodees avec des controles stricts.
 *
 * Le decodeur ne leve jamais d'exception vers l'appelant (voir decodeResponse) : toute trame tronquee,
 * mal formee ou absurde donne un resultat `ok: false`. Les boucles avancent toujours d'au moins 2 octets
 * et sont bornees par la taille du tampon, donc ne peuvent pas tourner indefiniment.
 */

export class BerError extends Error {}

export const TAG_INTEGER = 0x02;
export const TAG_OCTETS = 0x04;
export const TAG_NULL = 0x05;
export const TAG_OID = 0x06;
export const TAG_SEQUENCE = 0x30;
export const TAG_COUNTER32 = 0x41;
export const TAG_GAUGE32 = 0x42;
export const TAG_TIMETICKS = 0x43;
/** Lecture d'une valeur (l'unique type de requete emis par ce module). */
export const TAG_GET_REQUEST = 0xa0;
export const TAG_GET_RESPONSE = 0xa2;
export const TAG_NO_SUCH_OBJECT = 0x80;
export const TAG_NO_SUCH_INSTANCE = 0x81;
export const TAG_END_OF_MIB = 0x82;

const MAX_VARBINDS = 64;
const MAX_OID_ARCS = 128;

// ---------- encodage ----------

export function encodeLength(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new BerError('longueur BER hors limites');
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, n >> 8, n & 0xff]);
}

export function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

/** Entier positif 0..2^31-1 (numero de version, request-id, statuts). */
export function encodeInteger(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 0x7fffffff) throw new BerError('entier BER hors limites');
  const bytes: number[] = [];
  let v = n;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(TAG_INTEGER, Buffer.from(bytes));
}

export function encodeOctets(data: Buffer | string): Buffer {
  return tlv(TAG_OCTETS, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
}

export function encodeNull(): Buffer {
  return Buffer.from([TAG_NULL, 0]);
}

/** « 1.3.6.1.2.1.33.1.2.4.0 » -> TLV OID. */
export function encodeOid(oid: string): Buffer {
  if (!/^\d+(\.\d+){1,127}$/.test(oid)) throw new BerError('OID invalide');
  const arcs = oid.split('.').map(Number);
  const first = arcs[0]!;
  const second = arcs[1]!;
  if (first > 2 || (first < 2 && second > 39)) throw new BerError('OID invalide');
  const sub = [first * 40 + second, ...arcs.slice(2)];
  const out: number[] = [];
  for (const s of sub) {
    if (!Number.isSafeInteger(s) || s > 0xffffffff) throw new BerError('OID invalide');
    const chunk: number[] = [s & 0x7f];
    let v = Math.floor(s / 128);
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...chunk);
  }
  return tlv(TAG_OID, Buffer.from(out));
}

/** Requete de lecture (GetRequest) d'un seul OID. `version` : 0 = SNMP v1, 1 = SNMP v2c. */
export function buildGetRequest(version: 0 | 1, community: string, requestId: number, oid: string): Buffer {
  const varbind = tlv(TAG_SEQUENCE, encodeOid(oid), encodeNull());
  const pdu = tlv(TAG_GET_REQUEST, encodeInteger(requestId), encodeInteger(0), encodeInteger(0), tlv(TAG_SEQUENCE, varbind));
  return tlv(TAG_SEQUENCE, encodeInteger(version), encodeOctets(community), pdu);
}

// ---------- decodage ----------

export interface Tlv {
  tag: number;
  start: number;
  end: number;
}

/** Lit un en-tete BER a `pos` sans jamais depasser `limit`. */
export function readTlv(buf: Buffer, pos: number, limit: number): Tlv {
  if (limit > buf.length) limit = buf.length;
  if (pos < 0 || pos + 2 > limit) throw new BerError('trame tronquee');
  const tag = buf[pos]!;
  if ((tag & 0x1f) === 0x1f) throw new BerError('etiquette multi-octets non geree');
  let len = buf[pos + 1]!;
  let p = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0) throw new BerError('longueur indefinie refusee');
    if (n > 4) throw new BerError('longueur absurde');
    if (p + n > limit) throw new BerError('trame tronquee');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++]!;
  }
  if (len > limit - p) throw new BerError('longueur incoherente avec la trame');
  return { tag, start: p, end: p + len };
}

export function decodeInteger(buf: Buffer, t: Tlv, signed: boolean): number {
  const n = t.end - t.start;
  if (n < 1 || n > 9) throw new BerError('entier de taille invalide');
  let v = 0n;
  for (let i = t.start; i < t.end; i++) v = (v << 8n) | BigInt(buf[i]!);
  if (signed && buf[t.start]! & 0x80) v -= 1n << BigInt(8 * n);
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) throw new BerError('entier trop grand');
  return Number(v);
}

export function decodeOid(buf: Buffer, t: Tlv): string {
  if (t.end - t.start < 1) throw new BerError('OID vide');
  const arcs: number[] = [];
  let cur = 0;
  let bytes = 0;
  let open = false;
  for (let i = t.start; i < t.end; i++) {
    const b = buf[i]!;
    cur = cur * 128 + (b & 0x7f);
    bytes++;
    if (bytes > 5 || cur > 0xffffffff) throw new BerError('sous-identifiant OID absurde');
    if (b & 0x80) {
      open = true;
      continue;
    }
    open = false;
    if (arcs.length === 0) {
      if (cur < 40) arcs.push(0, cur);
      else if (cur < 80) arcs.push(1, cur - 40);
      else arcs.push(2, cur - 80);
    } else arcs.push(cur);
    if (arcs.length > MAX_OID_ARCS) throw new BerError('OID trop long');
    cur = 0;
    bytes = 0;
  }
  if (open) throw new BerError('OID tronque');
  return arcs.join('.');
}

export type SnmpValue = { kind: 'number'; n: number } | { kind: 'absent' } | { kind: 'other' };

export interface SnmpVarbind {
  oid: string;
  value: SnmpValue;
}

export interface SnmpResponse {
  version: number;
  requestId: number;
  errorStatus: number;
  errorIndex: number;
  varbinds: SnmpVarbind[];
}

export type DecodeResult = { ok: true; response: SnmpResponse } | { ok: false; reason: string };

/** Etiquettes de valeur : `noSuch*` et `endOfMibView` signifient « cette grandeur n'existe pas ». */
function decodeValue(buf: Buffer, t: Tlv): SnmpValue {
  switch (t.tag) {
    case TAG_INTEGER:
      return { kind: 'number', n: decodeInteger(buf, t, true) };
    case TAG_COUNTER32:
    case TAG_GAUGE32:
    case TAG_TIMETICKS:
      return { kind: 'number', n: decodeInteger(buf, t, false) };
    case TAG_NO_SUCH_OBJECT:
    case TAG_NO_SUCH_INSTANCE:
    case TAG_END_OF_MIB:
    case TAG_NULL:
      return { kind: 'absent' };
    default:
      return { kind: 'other' };
  }
}

function decodeStrict(buf: Buffer, expectCommunity: string | null): SnmpResponse {
  const msg = readTlv(buf, 0, buf.length);
  if (msg.tag !== TAG_SEQUENCE) throw new BerError('message SNMP attendu');
  if (msg.end !== buf.length) throw new BerError('octets en trop apres le message');
  const ver = readTlv(buf, msg.start, msg.end);
  if (ver.tag !== TAG_INTEGER) throw new BerError('version attendue');
  const version = decodeInteger(buf, ver, true);
  const com = readTlv(buf, ver.end, msg.end);
  if (com.tag !== TAG_OCTETS) throw new BerError('communaute attendue');
  if (expectCommunity !== null && !buf.subarray(com.start, com.end).equals(Buffer.from(expectCommunity, 'utf8'))) {
    throw new BerError('communaute differente');
  }
  const pdu = readTlv(buf, com.end, msg.end);
  if (pdu.tag !== TAG_GET_RESPONSE) throw new BerError('reponse de lecture attendue');
  if (pdu.end !== msg.end) throw new BerError('octets en trop apres la reponse');
  const rid = readTlv(buf, pdu.start, pdu.end);
  if (rid.tag !== TAG_INTEGER) throw new BerError('request-id attendu');
  const requestId = decodeInteger(buf, rid, true);
  const es = readTlv(buf, rid.end, pdu.end);
  if (es.tag !== TAG_INTEGER) throw new BerError('error-status attendu');
  const errorStatus = decodeInteger(buf, es, true);
  const ei = readTlv(buf, es.end, pdu.end);
  if (ei.tag !== TAG_INTEGER) throw new BerError('error-index attendu');
  const errorIndex = decodeInteger(buf, ei, true);
  const vbl = readTlv(buf, ei.end, pdu.end);
  if (vbl.tag !== TAG_SEQUENCE) throw new BerError('liste de valeurs attendue');
  if (vbl.end !== pdu.end) throw new BerError('octets en trop apres la liste');
  const varbinds: SnmpVarbind[] = [];
  let pos = vbl.start;
  while (pos < vbl.end) {
    if (varbinds.length >= MAX_VARBINDS) throw new BerError('trop de valeurs');
    const vb = readTlv(buf, pos, vbl.end);
    if (vb.tag !== TAG_SEQUENCE) throw new BerError('valeur attendue');
    const name = readTlv(buf, vb.start, vb.end);
    if (name.tag !== TAG_OID) throw new BerError('OID attendu');
    const val = readTlv(buf, name.end, vb.end);
    if (val.end !== vb.end) throw new BerError('octets en trop apres la valeur');
    varbinds.push({ oid: decodeOid(buf, name), value: decodeValue(buf, val) });
    pos = vb.end;
  }
  return { version, requestId, errorStatus, errorIndex, varbinds };
}

/**
 * Decode une reponse SNMP. Ne leve JAMAIS : un paquet invalide donne `{ ok: false, reason }`.
 * `expectCommunity` : si fourni, une reponse portant une autre communaute est refusee.
 */
export function decodeResponse(buf: Buffer, expectCommunity: string | null = null): DecodeResult {
  try {
    return { ok: true, response: decodeStrict(buf, expectCommunity) };
  } catch (e) {
    return { ok: false, reason: e instanceof BerError ? e.message : 'trame illisible' };
  }
}
