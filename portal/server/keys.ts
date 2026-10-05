import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cle maitresse : PORTAL_MASTER_KEY (64 hexadecimaux), sinon fichier master.key du dossier de donnees (cree au premier
 * demarrage). Elle ne quitte jamais le portail : les sites n'en recoivent que des cles derivees.
 */
export function loadMasterKey(dataDir: string, fromEnv: string): Buffer {
  if (fromEnv) {
    if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) throw new Error('PORTAL_MASTER_KEY doit contenir 64 caracteres hexadecimaux');
    return Buffer.from(fromEnv, 'hex');
  }
  const file = join(dataDir, 'master.key');
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
    if (key.length !== 32) throw new Error(`${file} est corrompu : les cles de TOUS les sites en dependent, restaurer la sauvegarde`);
    return key;
  }
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  return key;
}

/**
 * Cle de signature d'un site : HMAC(cle maitresse, identifiant + version). Rien a stocker, rien a perdre separement ;
 * changer la version (rotation) invalide l'ancienne cle du site sans toucher aux autres.
 * 64 caracteres hexadecimaux : la longueur minimale exigee par le PSIM est de 32.
 */
export function siteKey(master: Buffer, siteId: string, version: number): string {
  return createHmac('sha256', master).update(`site-key:${siteId}:${version}`).digest('hex');
}
