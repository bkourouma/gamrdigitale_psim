/**
 * Fabrication d'un `msgId` deterministe et TOUJOURS accepte par le PSIM (1 a 64 caracteres parmi lettres, chiffres, `.`, `_`,
 * `:` et `-`, voir server/ingestmeta.ts). Un msgId refuse ferait rejeter le message par le socle : une alarme perdue.
 *
 * Les morceaux (nom d'equipement Zigbee, cle de regle, horodatage, valeur...) sont nettoyes : accents retires, tout caractere
 * interdit remplace par `_`. Si le resultat depasse 64 caracteres, il est tronque et termine par une empreinte courte de
 * l'identifiant COMPLET d'origine : deux messages differents gardent deux msgId differents, et le meme message donne
 * toujours le meme msgId (rejeu de la file, redemarrage) : l'anti-doublon du PSIM reste juste.
 */
import { createHash } from 'node:crypto';

/** Identifiant de message accepte par le PSIM (meme motif que server/ingestmeta.ts, MSG_ID_PATTERN). */
export const MSG_ID_MAX = 64;
const FORBIDDEN = /[^A-Za-z0-9._:-]/g;
/** Longueur de l'empreinte ajoutee quand il faut tronquer (12 hexadecimaux = 48 bits). */
const DIGEST_LEN = 12;

function clean(part: string): string {
  return part.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(FORBIDDEN, '_');
}

/** Nettoie un identifiant deja forme (ex. msgId fourni par un module). Toujours valide, deterministe. */
export function normalizeMsgId(raw: string): string {
  const cleaned = clean(raw);
  if (cleaned === raw && raw.length > 0 && raw.length <= MSG_ID_MAX) return raw;
  // Modifie ou trop long : l'empreinte de l'ORIGINAL distingue « a b » de « a/b », et deux longs noms de meme debut.
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, DIGEST_LEN);
  return `${cleaned.slice(0, MSG_ID_MAX - DIGEST_LEN - 1) || 'm'}.${digest}`;
}

/** Assemble des morceaux par `-` en un msgId valide (voir normalizeMsgId). */
export function makeMsgId(...parts: (string | number)[]): string {
  return normalizeMsgId(parts.map(String).join('-'));
}
