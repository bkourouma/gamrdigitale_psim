/** Generation d'un certificat HTTPS auto-signe (OpenSSL). Partage par `make-cert` et `init-production`. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CANDIDATES = ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe', 'D:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/OpenSSL-Win64/bin/openssl.exe'];
export const HOST_PATTERN = /^[A-Za-z0-9.-]{1,253}$/;

export function findOpenssl(): string | null {
  return CANDIDATES.find((c) => spawnSync(c, ['version'], { stdio: 'ignore' }).status === 0) ?? null;
}

export interface CertResult {
  cert: string;
  key: string;
  names: string[];
}

/** Cree `cert.pem` et `key.pem` dans `dir`. Leve une erreur lisible ; ne remplace jamais un certificat existant sans `force`. */
export function generateCert(opts: { hosts: string[]; dir: string; force?: boolean; days?: number }): CertResult {
  if (opts.hosts.length === 0) throw new Error('Au moins un nom ou une adresse est requis.');
  if (opts.hosts.some((h) => !HOST_PATTERN.test(h))) throw new Error('Nom ou adresse invalide (lettres, chiffres, points et tirets seulement).');
  const openssl = findOpenssl();
  if (!openssl) throw new Error("OpenSSL est introuvable. Installez Git for Windows (il l'inclut) ou OpenSSL, ou fournissez un certificat existant.");
  mkdirSync(opts.dir, { recursive: true });
  const cert = join(opts.dir, 'cert.pem');
  const key = join(opts.dir, 'key.pem');
  if (existsSync(cert) && !opts.force) throw new Error(`${cert} existe deja : rien n'a ete modifie.`);
  const names = [...new Set(['localhost', ...opts.hosts])].map((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? `IP:${h}` : `DNS:${h}`)).concat('IP:127.0.0.1');
  const r = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', String(opts.days ?? 825), '-subj', `/CN=${opts.hosts[0]}`, '-addext', `subjectAltName=${names.join(',')}`], { stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`Echec d'OpenSSL : ${r.stderr?.toString().trim()}`);
  return { cert, key, names };
}
