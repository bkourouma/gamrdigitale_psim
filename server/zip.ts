import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Ecrivain et lecteur ZIP minimaux, sans dependance : juste ce qu'il faut pour le dossier de preuve (proofpack.ts).
 *
 * Ecrivain : entrees « stored » (images, deja compressees) ou « deflate » (texte), noms ASCII controles, aucune
 * traversee de chemin, taille et nombre d'entrees bornes. Pas de ZIP64, pas de chiffrement, pas de multi-volumes.
 *
 * Lecteur : il ne fait CONFIANCE A RIEN dans le fichier (c'est un fichier recu d'ailleurs). Il refuse : un fichier tronque,
 * une entree dupliquee, un nom piege (`../`, chemin absolu, lettre de lecteur, antislash, caracteres de controle), un
 * chiffrement, une methode inconnue, ZIP64, des entrees qui se chevauchent, une taille annoncee demesuree (bombe de
 * decompression) et une taille reelle differente de celle annoncee. Il verifie le CRC-32 de chaque entree lue.
 */

export const ZIP_MAX_ENTRIES = 300;
/** Taille maximale d'une entree decompressee, et du total : au-dela, le dossier est refuse (bombe de decompression). */
export const ZIP_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const ZIP_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** Longueur maximale d'un nom d'entree. */
export const ZIP_MAX_NAME = 120;

/** Segments autorises : lettres, chiffres, point, tiret, tiret bas ; separateur « / ». Ni « . » ni « .. » seuls. */
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export function validEntryName(name: string): boolean {
  if (name.length === 0 || name.length > ZIP_MAX_NAME) return false;
  const parts = name.split('/');
  return parts.every((p) => SEGMENT.test(p) && p !== '..' && !p.endsWith('.'));
}

export interface ZipInput {
  name: string;
  data: Buffer;
  /** true = compresser (texte) ; false = stocker tel quel (images). */
  deflate?: boolean;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

/** Date/heure MS-DOS (heure locale, 2 s de precision, annee >= 1980). */
function dosDateTime(ts: number): { time: number; date: number } {
  const d = new Date(ts);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function createZip(entries: ZipInput[], modifiedAt: number): Buffer {
  if (entries.length === 0 || entries.length > ZIP_MAX_ENTRIES) throw new Error(`zip : nombre d'entrees invalide (${entries.length})`);
  const seen = new Set<string>();
  let total = 0;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const { time, date } = dosDateTime(modifiedAt);
  for (const e of entries) {
    if (!validEntryName(e.name)) throw new Error(`zip : nom d'entree refuse « ${e.name} »`);
    const key = e.name.toLowerCase();
    if (seen.has(key)) throw new Error(`zip : entree dupliquee « ${e.name} »`);
    seen.add(key);
    if (e.data.length > ZIP_MAX_ENTRY_BYTES) throw new Error(`zip : entree trop grande « ${e.name} »`);
    total += e.data.length;
    if (total > ZIP_MAX_TOTAL_BYTES) throw new Error('zip : taille totale trop grande');
    const name = Buffer.from(e.name, 'latin1'); // ASCII (valide ci-dessus)
    const crc = crc32(e.data) >>> 0;
    const packed = e.deflate && e.data.length > 0 ? deflateRawSync(e.data, { level: 9 }) : e.data;
    const method = packed === e.data ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version necessaire
    local.writeUInt16LE(0, 6); // indicateurs : ni chiffrement, ni descripteur differe
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // fabriquee par
    central.writeUInt16LE(20, 6); // version necessaire
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0x81a40000, 38); // attributs externes : fichier ordinaire 0644 (Unix)
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  if (offset + centralSize > 0xfffffff0) throw new Error('zip : fichier trop grand (ZIP64 non gere)');
  return Buffer.concat([...locals, ...centrals, end]);
}

export interface ZipLimits {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

export class ZipError extends Error {}

/**
 * Lit tout le contenu d'un ZIP et le renvoie (nom -> octets), dans l'ordre du repertoire central. Leve une `ZipError`
 * a la moindre anomalie ; ne renvoie JAMAIS un contenu partiel.
 */
export function readZip(buf: Buffer, limits: ZipLimits = {}): Map<string, Buffer> {
  const maxEntries = limits.maxEntries ?? ZIP_MAX_ENTRIES;
  const maxEntry = limits.maxEntryBytes ?? ZIP_MAX_ENTRY_BYTES;
  const maxTotal = limits.maxTotalBytes ?? ZIP_MAX_TOTAL_BYTES;
  if (buf.length < 22) throw new ZipError('fichier trop court pour etre un zip');
  // Fin de repertoire : les 22 derniers octets, ou plus loin si un commentaire existe (le notre n'en met jamais).
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === SIG_END && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError('fin de zip introuvable : fichier tronque ou ce n\'est pas un zip');
  const disk = buf.readUInt16LE(end + 4);
  const cdDisk = buf.readUInt16LE(end + 6);
  const countHere = buf.readUInt16LE(end + 8);
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (disk !== 0 || cdDisk !== 0 || countHere !== count) throw new ZipError('zip en plusieurs volumes non pris en charge');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64 non pris en charge');
  if (count === 0) throw new ZipError('zip vide');
  if (count > maxEntries) throw new ZipError(`trop d'entrees (${count}, maximum ${maxEntries})`);
  if (cdOffset + cdSize !== end) throw new ZipError('repertoire central incoherent');

  const out = new Map<string, Buffer>();
  const seenLower = new Set<string>();
  const ranges: [number, number][] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError(`entree n°${n + 1} du repertoire illisible`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const diskStart = buf.readUInt16LE(p + 34);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > end) throw new ZipError(`entree n°${n + 1} : repertoire tronque`);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    // Noms : ASCII imprimable seulement (pas d'UTF-8 « malin », pas d'octet nul, pas d'antislash).
    if (rawName.some((c) => c < 0x20 || c > 0x7e)) throw new ZipError(`entree n°${n + 1} : nom avec caracteres interdits`);
    const name = rawName.toString('latin1');
    if (!validEntryName(name)) throw new ZipError(`nom d'entree refuse (chemin suspect) : « ${name.slice(0, 60)} »`);
    const lower = name.toLowerCase();
    if (seenLower.has(lower)) throw new ZipError(`entree dupliquee : « ${name} »`);
    seenLower.add(lower);
    if (flags & 0x1) throw new ZipError(`« ${name} » : entree chiffree non prise en charge`);
    if (method !== 0 && method !== 8) throw new ZipError(`« ${name} » : methode de compression ${method} non prise en charge`);
    if (diskStart !== 0) throw new ZipError(`« ${name} » : volume different`);
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('ZIP64 non pris en charge');
    if (usize > maxEntry) throw new ZipError(`« ${name} » : taille annoncee demesuree (${usize} octets) : bombe de decompression ?`);
    total += usize;
    if (total > maxTotal) throw new ZipError('taille totale annoncee demesuree : bombe de decompression ?');
    if (method === 0 && csize !== usize) throw new ZipError(`« ${name} » : tailles incoherentes`);

    // En-tete local : il doit reprendre le nom du repertoire central, et les donnees tenir dans le fichier.
    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new ZipError(`« ${name} » : en-tete local introuvable`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const lName = buf.subarray(localOffset + 30, localOffset + 30 + lNameLen).toString('latin1');
    if (lName !== name) throw new ZipError(`« ${name} » : le nom de l'en-tete local differe du repertoire`);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + csize;
    if (dataEnd > cdOffset) throw new ZipError(`« ${name} » : donnees hors du fichier (zip tronque)`);
    for (const [a, b] of ranges) if (localOffset < b && dataEnd > a) throw new ZipError(`« ${name} » : entrees qui se chevauchent`);
    ranges.push([localOffset, dataEnd]);

    const packed = buf.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (method === 0) data = Buffer.from(packed);
    else {
      try {
        // maxOutputLength : une bombe est interrompue au-dela de la taille annoncee, sans jamais tout decompresser.
        data = inflateRawSync(packed, { maxOutputLength: Math.max(1, usize) });
      } catch {
        throw new ZipError(`« ${name} » : donnees compressees invalides ou plus grandes que la taille annoncee`);
      }
    }
    if (data.length !== usize) throw new ZipError(`« ${name} » : taille reelle differente de la taille annoncee`);
    if ((crc32(data) >>> 0) !== crc) throw new ZipError(`« ${name} » : somme de controle CRC-32 incorrecte (donnees alterees)`);
    out.set(name, data);
  }
  if (p !== end) throw new ZipError('repertoire central : octets en trop');
  return out;
}
