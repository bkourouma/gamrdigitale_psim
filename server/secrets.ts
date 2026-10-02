import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = 'v1';

/**
 * Cle de chiffrement des identifiants des cameras stockes en base.
 * Ordre : variable PSIM_SECRET_KEY (64 caracteres hexadecimaux), sinon fichier data/secret.key
 * (cree au premier demarrage). Perdre la cle oblige a ressaisir les mots de passe des cameras.
 */
export function loadSecretKey(dataDir: string, fromEnv: string | undefined): Buffer {
  if (fromEnv) {
    if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) throw new Error('PSIM_SECRET_KEY doit contenir 64 caracteres hexadecimaux');
    return Buffer.from(fromEnv, 'hex');
  }
  const file = join(dataDir, 'secret.key');
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
    if (key.length !== 32) throw new Error(`${file} est corrompu : supprimer le fichier et ressaisir les mots de passe des cameras`);
    return key;
  }
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  return key;
}

export function seal(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** Leve une exception si la valeur a ete alteree ou si la cle est mauvaise. */
export function unseal(key: Buffer, sealed: string): string {
  const [version, iv, tag, data] = sealed.split(':');
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error('Format de secret inconnu');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
