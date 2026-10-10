import type { CompareOp, DataType, Order, PointConfig } from './config.ts';
import { wordSpan } from './config.ts';

/**
 * Decodage des valeurs lues : types de donnees, ordre des mots et des octets, mise a l'echelle, 4-20 mA.
 * Les registres Modbus sont des mots de 16 bits transmis octet de poids fort en premier. Pour un type sur 32 bits,
 * les constructeurs different sur l'ordre des deux mots (wordOrder) et parfois sur celui des octets (byteOrder).
 *   wordOrder big,    byteOrder big    -> ABCD (le plus courant)
 *   wordOrder little, byteOrder big    -> CDAB (mots inverses)
 *   wordOrder big,    byteOrder little -> BADC
 *   wordOrder little, byteOrder little -> DCBA
 */

export function swapBytes(word: number): number {
  return ((word & 0xff) << 8) | ((word >> 8) & 0xff);
}

/** Decode un nombre a partir de mots bruts (0..65535). `words` doit contenir au moins wordSpan(dataType) mots. */
export function decodeNumber(words: readonly number[], dataType: DataType, wordOrder: Order, byteOrder: Order): number {
  const n = wordSpan(dataType);
  if (words.length < n) throw new RangeError('pas assez de mots pour ce type');
  const w = words.slice(0, n).map((x) => (byteOrder === 'little' ? swapBytes(x) : x));
  if (n === 1) return dataType === 'int16' ? (w[0] > 0x7fff ? w[0] - 0x10000 : w[0]) : w[0];
  const ordered = wordOrder === 'little' ? [w[1], w[0]] : [w[0], w[1]];
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(ordered[0], 0);
  buf.writeUInt16BE(ordered[1], 2);
  if (dataType === 'uint32') return buf.readUInt32BE(0);
  if (dataType === 'int32') return buf.readInt32BE(0);
  return buf.readFloatBE(0);
}

export type Evaluation =
  | { ok: true; kind: 'bool'; bool: boolean }
  | { ok: true; kind: 'num'; num: number; ma: number | null }
  | { ok: false; reason: string };

const MAX_ABS_VALUE = 1e9;

function round(x: number, decimals: number): number {
  const r = Number(x.toFixed(decimals));
  return r === 0 ? 0 : r;
}

function compare(op: CompareOp, a: number, b: number): boolean {
  switch (op) {
    case 'gt': return a > b;
    case 'ge': return a >= b;
    case 'lt': return a < b;
    case 'le': return a <= b;
    case 'eq': return a === b;
    default: return a !== b;
  }
}

/**
 * Interprete une lecture brute selon la definition du point.
 *  - bit : `raw` est un booleen (entree ou bobine) ;
 *  - registres : `raw` est la liste de mots du point.
 * Une valeur inutilisable (NaN, hors plage, boucle 4-20 mA coupee) donne `ok: false` : le point compte un echec.
 */
export function evaluate(p: PointConfig, raw: boolean | readonly number[]): Evaluation {
  if (typeof raw === 'boolean') return { ok: true, kind: 'bool', bool: p.invert ? !raw : raw };

  if (p.kind === 'regbit') {
    const word = p.byteOrder === 'little' ? swapBytes(raw[0]) : raw[0];
    const b = ((word >> p.bit) & 1) === 1;
    return { ok: true, kind: 'bool', bool: p.invert ? !b : b };
  }

  const n = decodeNumber(raw, p.dataType, p.wordOrder, p.byteOrder);
  if (!Number.isFinite(n)) return { ok: false, reason: 'valeur non numerique (NaN ou infini) dans le registre' };

  if (p.kind === 'compare') {
    const scaled = n * p.scale + p.offset;
    const b = compare(p.compare?.op ?? 'eq', scaled, p.compare?.value ?? 0);
    return { ok: true, kind: 'bool', bool: p.invert ? !b : b };
  }

  const c = p.current4_20;
  if (c) {
    const ratio = (n - c.rawMin) / (c.rawMax - c.rawMin);
    const ma = 4 + ratio * 16;
    if (ma < c.loopBreakMa) return { ok: false, reason: `rupture de boucle 4-20 mA (${round(ma, 2)} mA)` };
    if (c.overRangeMa !== null && ma > c.overRangeMa) return { ok: false, reason: `boucle 4-20 mA hors plage (${round(ma, 2)} mA)` };
    return finish(round(c.engMin + ratio * (c.engMax - c.engMin), p.decimals), round(ma, 2));
  }
  return finish(round(n * p.scale + p.offset, p.decimals), null);
}

function finish(num: number, ma: number | null): Evaluation {
  if (!Number.isFinite(num) || Math.abs(num) > MAX_ABS_VALUE) return { ok: false, reason: 'valeur hors limites apres mise a l\'echelle' };
  return { ok: true, kind: 'num', num, ma };
}
