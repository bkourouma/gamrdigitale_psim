/**
 * Genere un certificat HTTPS AUTO-SIGNE pour un reseau interne :
 *
 *   npm run make-cert -- psim.local 192.168.1.10
 *
 * Chaque argument devient un nom (DNS) ou une adresse (IP) valide du certificat. Resultat dans data/tls/.
 *
 * Un certificat auto-signe chiffre bien les echanges, mais les navigateurs affichent un avertissement tant
 * que ce certificat n'est pas installe comme « autorite de confiance » sur chaque poste. Pour un usage
 * durable, preferer un certificat d'une autorite (Let's Encrypt, autorite interne) ou un proxy HTTPS.
 * Necessite OpenSSL (livre avec Git for Windows).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../server/config.ts';

const hosts = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (hosts.length === 0) {
  console.error('Usage : npm run make-cert -- <nom-ou-adresse> [autres noms ou adresses...]');
  console.error('Exemple : npm run make-cert -- psim.local 192.168.1.10');
  process.exit(2);
}
const valid = /^[A-Za-z0-9.-]{1,253}$/;
if (hosts.some((h) => !valid.test(h))) {
  console.error('Nom ou adresse invalide (lettres, chiffres, points et tirets seulement).');
  process.exit(2);
}

const candidates = ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe', 'D:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/OpenSSL-Win64/bin/openssl.exe'];
const openssl = candidates.find((c) => spawnSync(c, ['version'], { stdio: 'ignore' }).status === 0);
if (!openssl) {
  console.error('OpenSSL est introuvable. Installez Git for Windows (il l\'inclut) ou OpenSSL, ou fournissez un certificat existant.');
  process.exit(1);
}

const dir = resolve(import.meta.dirname, '..', config.dataDir, 'tls');
mkdirSync(dir, { recursive: true });
const cert = join(dir, 'cert.pem');
const key = join(dir, 'key.pem');
if (existsSync(cert) && !process.argv.includes('--force')) {
  console.error(`${cert} existe deja : rien n'a ete modifie (--force pour le remplacer).`);
  process.exit(1);
}
const san = [...new Set(['localhost', ...hosts])].map((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? `IP:${h}` : `DNS:${h}`)).concat('IP:127.0.0.1');
const result = spawnSync(
  openssl,
  ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '825', '-subj', `/CN=${hosts[0]}`, '-addext', `subjectAltName=${san.join(',')}`],
  { stdio: 'pipe' },
);
if (result.status !== 0) {
  console.error(`Echec d'OpenSSL : ${result.stderr?.toString().trim()}`);
  process.exit(1);
}
console.log(`Certificat genere (valable 825 jours) pour : ${san.join(', ')}`);
console.log(`  ${cert}\n  ${key}`);
console.log('\nDans .env :');
console.log(`  PSIM_TLS_CERT=${cert}`);
console.log(`  PSIM_TLS_KEY=${key}`);
console.log('\nLa cle privee (key.pem) donne le controle du chiffrement : ne la partagez pas, ne la sauvegardez pas avec les donnees.');
