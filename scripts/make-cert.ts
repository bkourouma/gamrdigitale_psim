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
import { resolve } from 'node:path';
import { config } from '../server/config.ts';
import { generateCert } from './lib/cert.ts';

const hosts = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (hosts.length === 0) {
  console.error('Usage : npm run make-cert -- <nom-ou-adresse> [autres noms ou adresses...]');
  console.error('Exemple : npm run make-cert -- psim.local 192.168.1.10');
  process.exitCode = 2;
} else {
  try {
    const r = generateCert({ hosts, dir: resolve(import.meta.dirname, '..', config.dataDir, 'tls'), force: process.argv.includes('--force') });
    console.log(`Certificat genere (valable 825 jours) pour : ${r.names.join(', ')}`);
    console.log(`  ${r.cert}\n  ${r.key}`);
    console.log('\nDans .env :');
    console.log(`  PSIM_TLS_CERT=${r.cert}`);
    console.log(`  PSIM_TLS_KEY=${r.key}`);
    console.log('\nLa cle privee (key.pem) donne le controle du chiffrement : ne la partagez pas, ne la sauvegardez pas avec les donnees.');
  } catch (err) {
    console.error(`${(err as Error).message}${/existe deja/.test((err as Error).message) ? ' (--force pour le remplacer)' : ''}`);
    process.exitCode = /invalide/.test((err as Error).message) ? 2 : 1;
  }
}
