/**
 * Generation des certificats HTTPS (OpenSSL). Partage par `make-cert` et `init-production`.
 *
 *  - `generateSiteCert` (mode normal) : une petite autorite locale + un certificat de serveur signe par elle ;
 *  - `generateCert` (ancien mode, `--autosigne`) : un certificat unique auto-signe.
 */
import { spawnSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// ---------------------------------------------------------------- autorite locale + certificat du site

export interface SiteCertResult extends CertResult {
  /** Certificat de l'autorite locale (`ca.pem`) : c'est lui que le telephone installe. */
  ca: string;
  /** Cle de l'autorite (`ca-key.pem`) : SECRETE, jamais servie, jamais copiee ailleurs. */
  caKey: string;
  /** Vrai si l'autorite vient d'etre creee (les telephones doivent alors installer son certificat). */
  caCreated: boolean;
}

const DAY_MS = 86_400_000;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/** Lance OpenSSL ; leve une erreur lisible en cas d'echec. */
function run(openssl: string, args: string[]): void {
  const r = spawnSync(openssl, args, { stdio: 'pipe' });
  if (r.error) throw new Error(`Echec d'OpenSSL : ${r.error.message}`);
  if (r.status !== 0) throw new Error(`Echec d'OpenSSL : ${r.stderr?.toString().trim()}`);
}

/** Chemin accepte par OpenSSL (celui de Git for Windows est un binaire MSYS) : separateurs `/`. */
const slash = (p: string): string => p.replace(/\\/g, '/');

/** Numero de serie aleatoire de 128 bits, positif et non nul, en hexadecimal pour `-set_serial`. */
function randomSerial(): string {
  const b = randomBytes(16);
  b[0] = (b[0] & 0x7f) | 0x10;
  return `0x${b.toString('hex')}`;
}

/** Jours de validite restants de l'autorite existante de `dir` ; `null` si elle est absente. Leve si elle est inutilisable. */
function existingCaDays(caPath: string, caKeyPath: string, now: number): number | null {
  if (!existsSync(caPath) || !existsSync(caKeyPath)) return null;
  let ca: X509Certificate;
  try {
    ca = new X509Certificate(readFileSync(caPath));
    if (!ca.ca || !ca.checkPrivateKey(createPrivateKey(readFileSync(caKeyPath)))) throw new Error('incoherente');
  } catch {
    throw new Error(`${caPath} et ${caKeyPath} ne forment pas une autorite exploitable : rien n'a ete modifie. Relancez avec --nouvelle-autorite pour la remplacer (les telephones devront reinstaller son certificat).`);
  }
  const remaining = Math.floor((new Date(ca.validTo).getTime() - now) / DAY_MS);
  if (remaining < 1) throw new Error(`L'autorite locale (${caPath}) a expire : rien n'a ete modifie. Relancez avec --nouvelle-autorite (les telephones devront reinstaller son certificat).`);
  return remaining;
}

/**
 * Cree (ou reutilise) une petite autorite locale dans `dir` (`ca.pem`, `ca-key.pem`), puis signe avec elle le certificat HTTPS
 * du serveur : `cert.pem` = certificat du serveur PUIS de l'autorite (chaine complete), `key.pem` = cle du serveur.
 *
 * - Avec `force`, le certificat du serveur est renouvele mais l'autorite existante est GARDEE : les telephones qui l'ont
 *   installee n'ont rien a refaire. `newCa` regenere aussi l'autorite (reinstallation sur chaque telephone).
 * - Ne depend d'aucun openssl.cnf de la machine : les extensions sont ecrites explicitement dans des fichiers temporaires.
 * - Tout est produit dans un dossier de travail puis deplace : un echec de signature ne laisse aucun etat a moitie ecrit.
 * - Le certificat du serveur ne depasse jamais 825 jours, ni la fin de validite de l'autorite.
 */
export function generateSiteCert(opts: { hosts: string[]; dir: string; force?: boolean; newCa?: boolean; days?: number; caDays?: number }): SiteCertResult {
  if (opts.hosts.length === 0) throw new Error('Au moins un nom ou une adresse est requis.');
  if (opts.hosts.some((h) => !HOST_PATTERN.test(h))) throw new Error('Nom ou adresse invalide (lettres, chiffres, points et tirets seulement).');
  const openssl = findOpenssl();
  if (!openssl) throw new Error("OpenSSL est introuvable. Installez Git for Windows (il l'inclut) ou OpenSSL, ou fournissez un certificat existant.");
  mkdirSync(opts.dir, { recursive: true });
  const cert = join(opts.dir, 'cert.pem');
  const key = join(opts.dir, 'key.pem');
  const ca = join(opts.dir, 'ca.pem');
  const caKey = join(opts.dir, 'ca-key.pem');
  if (existsSync(cert) && !opts.force) throw new Error(`${cert} existe deja : rien n'a ete modifie.`);

  const remaining = opts.newCa ? null : existingCaDays(ca, caKey, Date.now());
  const caCreated = remaining === null;
  const caDays = Math.max(1, Math.floor(opts.caDays ?? 3650));
  const days = Math.max(1, Math.min(Math.floor(opts.days ?? 825), 825, remaining ?? caDays));
  const names = [...new Set(['localhost', ...opts.hosts].map((h) => (IPV4.test(h) ? `IP:${h}` : `DNS:${h}`)).concat('IP:127.0.0.1'))];

  // Configurations temporaires (sans secret) ; produits (cles) dans un dossier de travail du meme volume que `dir`.
  const conf = mkdtempSync(join(tmpdir(), 'psim-cert-conf-'));
  const stage = mkdtempSync(join(opts.dir, '.stage-'));
  try {
    const f = (name: string): string => slash(join(conf, name));
    const s = (name: string): string => slash(join(stage, name));
    writeFileSync(
      join(conf, 'ca.cnf'),
      '[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=v3_ca\n[dn]\nCN=x\n[v3_ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n',
    );
    writeFileSync(join(conf, 'csr.cnf'), '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=x\n');
    writeFileSync(
      join(conf, 'leaf.cnf'),
      `[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\nsubjectAltName=${names.join(',')}\n`,
    );

    // 1. L'autorite : creee, ou reutilisee telle quelle.
    let caFile = ca;
    let caKeyFile = caKey;
    if (caCreated) {
      run(openssl, ['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-keyout', s('ca-key.pem'), '-out', s('ca.pem'), '-days', String(caDays), '-sha256', '-config', f('ca.cnf'), '-extensions', 'v3_ca', '-subj', `/CN=PSIM Autorite locale (${opts.hosts[0]})`]);
      caFile = join(stage, 'ca.pem');
      caKeyFile = join(stage, 'ca-key.pem');
    }

    // 2. Le certificat du serveur, signe par l'autorite.
    run(openssl, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', s('key.pem'), '-out', s('server.csr'), '-config', f('csr.cnf'), '-subj', `/CN=${opts.hosts[0]}`]);
    run(openssl, ['x509', '-req', '-in', s('server.csr'), '-CA', slash(caFile), '-CAkey', slash(caKeyFile), '-out', s('leaf.pem'), '-days', String(days), '-sha256', '-set_serial', randomSerial(), '-extfile', f('leaf.cnf'), '-extensions', 'leaf']);

    // 3. Chaine complete : feuille puis autorite.
    writeFileSync(join(stage, 'cert.pem'), `${readFileSync(join(stage, 'leaf.pem'), 'utf8').trim()}\n${readFileSync(caFile, 'utf8').trim()}\n`);

    // 4. Mise en place (le dossier de travail est sur le meme volume : simples renommages, l'autorite d'abord).
    if (caCreated) {
      renameSync(join(stage, 'ca-key.pem'), caKey);
      renameSync(join(stage, 'ca.pem'), ca);
    }
    renameSync(join(stage, 'key.pem'), key);
    renameSync(join(stage, 'cert.pem'), cert);
    for (const secret of [key, caKey]) {
      try {
        chmodSync(secret, 0o600);
      } catch {
        // systeme de fichiers sans droits POSIX : l'appelant restreint l'acces (voir init-production)
      }
    }
  } finally {
    rmSync(conf, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
  return { cert, key, ca, caKey, names, caCreated };
}
