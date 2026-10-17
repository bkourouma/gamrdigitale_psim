/**
 * Genere le certificat HTTPS du PSIM pour un reseau interne :
 *
 *   npm run make-cert -- psim.local 192.168.1.10
 *
 * Chaque argument devient un nom (DNS) ou une adresse (IP) valide du certificat. Resultat dans data/tls/.
 *
 * Mode par defaut : une petite AUTORITE LOCALE (ca.pem, ca-key.pem, valable 10 ans) signe le certificat du serveur
 * (cert.pem = serveur + autorite, key.pem, valable 825 jours). Le telephone des agents installe UNE SEULE FOIS le
 * certificat de l'autorite (ouvrir https://<adresse>/api/agent-cert) : les renouvellements du certificat du serveur
 * ne demandent plus rien sur les telephones, tant que l'autorite est conservee.
 *
 * Options :
 *   --force              renouvelle le certificat du serveur ET GARDE l'autorite (les telephones n'ont rien a refaire) ;
 *   --nouvelle-autorite  remplace aussi l'autorite (chaque telephone devra reinstaller son certificat) ;
 *   --autosigne          ancien mode : un seul certificat auto-signe, sans autorite.
 *
 * Necessite OpenSSL (livre avec Git for Windows).
 */
import { resolve } from 'node:path';
import { config } from '../server/config.ts';
import { generateCert, generateSiteCert } from './lib/cert.ts';

const args = process.argv.slice(2);
const hosts = args.filter((a) => !a.startsWith('--'));
const unknown = args.filter((a) => a.startsWith('--') && !['--force', '--nouvelle-autorite', '--autosigne'].includes(a));
if (hosts.length === 0 || unknown.length > 0) {
  if (unknown.length > 0) console.error(`Option inconnue : ${unknown.join(', ')}`);
  console.error('Usage : npm run make-cert -- <nom-ou-adresse> [autres noms ou adresses...] [--force] [--nouvelle-autorite] [--autosigne]');
  console.error('Exemple : npm run make-cert -- psim.local 192.168.1.10');
  process.exitCode = 2;
} else {
  const dir = resolve(import.meta.dirname, '..', config.dataDir, 'tls');
  const force = args.includes('--force') || args.includes('--nouvelle-autorite');
  try {
    if (args.includes('--autosigne')) {
      const r = generateCert({ hosts, dir, force });
      console.log(`Certificat auto-signe genere (valable 825 jours) pour : ${r.names.join(', ')}`);
      console.log(`  ${r.cert}\n  ${r.key}`);
      console.log('\nDans .env :');
      console.log(`  PSIM_TLS_CERT=${r.cert}`);
      console.log(`  PSIM_TLS_KEY=${r.key}`);
      console.log('\nLa cle privee (key.pem) donne le controle du chiffrement : ne la partagez pas, ne la sauvegardez pas avec les donnees.');
      console.log('Le telephone doit reinstaller ce certificat a chaque renouvellement (ouvrir /api/agent-cert). Le mode par defaut evite cela.');
    } else {
      const r = generateSiteCert({ hosts, dir, force, newCa: args.includes('--nouvelle-autorite') });
      console.log(`Certificat du serveur genere (valable 825 jours) pour : ${r.names.join(', ')}`);
      console.log(r.caCreated ? 'Autorite locale creee (valable 10 ans).' : 'Autorite locale existante conservee : les telephones qui l\'ont installee n\'ont rien a refaire.');
      console.log(`  ${r.cert}   certificat du serveur + autorite\n  ${r.key}\n  ${r.ca}   certificat de l'autorite\n  ${r.caKey}`);
      console.log('\nDans .env :');
      console.log(`  PSIM_TLS_CERT=${r.cert}`);
      console.log(`  PSIM_TLS_KEY=${r.key}`);
      console.log('\nSECRETS : key.pem et ca-key.pem donnent le controle du chiffrement. Ne les partagez pas et ne les sauvegardez pas avec les donnees partagees.');
      console.log('Le PSIM ne sert jamais ces cles ; il ne sert que le certificat de l\'autorite.');
      if (r.caCreated) {
        console.log("\nTelephones : installer le certificat de l'autorite en ouvrant https://<adresse>/api/agent-cert depuis le telephone,");
        console.log('ou depuis l\'ecran Rondes > Telephones. A faire une seule fois par telephone.');
        if (args.includes('--nouvelle-autorite')) console.log('ATTENTION : l\'autorite a ete remplacee, chaque telephone doit reinstaller son certificat.');
      } else {
        console.log('\nTelephones : rien a refaire (meme autorite). Redemarrez le PSIM pour utiliser le nouveau certificat.');
      }
    }
  } catch (err) {
    console.error(`${(err as Error).message}${/existe deja/.test((err as Error).message) ? ' (--force pour le renouveler)' : ''}`);
    process.exitCode = /invalide/.test((err as Error).message) ? 2 : 1;
  }
}
