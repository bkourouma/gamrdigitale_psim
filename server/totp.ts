/**
 * TOTP (RFC 6238) et codes de secours, sans dependance : compatible avec Google Authenticator,
 * Microsoft Authenticator, Aegis, FreeOTP, 1Password, etc.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) throw new Error('caractere base32 invalide');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Secret de 160 bits (la taille recommandee par la RFC 4226). */
export const newSecret = (): Buffer => randomBytes(20);

export const STEP_SECONDS = 30;

/** Code a `digits` chiffres pour la fenetre de temps `counter`. */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const stepOf = (timeMs: number): number => Math.floor(timeMs / 1000 / STEP_SECONDS);

export function totp(secret: Buffer, timeMs: number, digits = 6): string {
  return hotp(secret, stepOf(timeMs), digits);
}

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Verifie un code, avec une tolerance de +-1 fenetre (decalage d'horloge du telephone).
 * Renvoie la fenetre correspondante (a memoriser pour refuser le rejeu), ou null.
 */
export function verifyTotp(secret: Buffer, code: string, timeMs: number, window = 1, digits = 6): number | null {
  const clean = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(clean)) return null;
  const current = stepOf(timeMs);
  let match: number | null = null;
  // Toutes les fenetres sont comparees (pas de sortie anticipee) : temps de reponse constant.
  for (let step = current - window; step <= current + window; step++) {
    if (safeEqual(hotp(secret, step, digits), clean) && match === null) match = step;
  }
  return match;
}

export function otpauthUri(opts: { secret: Buffer; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(opts.secret)}&issuer=${encodeURIComponent(opts.issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

// ---------------------------------------------------------------- codes de secours

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // sans caracteres ambigus (i, l, o, 0, 1)

/** Huit codes a usage unique, de la forme `abcd-efgh` (40 bits chacun). */
export function newRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(8);
    const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });
}

export const normalizeRecoveryCode = (code: string): string => code.trim().toLowerCase().replace(/\s/g, '');

/** Seule l'empreinte est stockee : un code de secours a haute entropie n'a pas besoin de scrypt. */
export const hashRecoveryCode = (code: string): string => createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
