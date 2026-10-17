/**
 * Lecture des certificats du PSIM (aucune ecriture, aucune cle privee).
 *
 * Le fichier PSIM_TLS_CERT peut contenir un seul certificat (ancien mode : auto-signe) ou une chaine
 * « certificat du serveur + autorite locale » (mode actuel de `npm run make-cert`). Le telephone Android
 * n'accepte d'installer comme « certificat CA » qu'une AUTORITE (basicConstraints CA:TRUE) : c'est celle-la qu'il faut
 * lui servir, jamais le certificat du serveur seul.
 */
import { X509Certificate } from 'node:crypto';

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Les certificats d'un fichier PEM, dans l'ordre. Ignore tout ce qui n'est pas un bloc CERTIFICATE (cles, texte). */
export function certificateBlocks(pem: Buffer | string): string[] {
  return String(pem).match(PEM_BLOCK) ?? [];
}

/** Les blocs lisibles, avec leur certificat analyse. Un bloc illisible est ignore. */
export function parseCertificates(pem: Buffer | string): Array<{ pem: string; cert: X509Certificate }> {
  const out: Array<{ pem: string; cert: X509Certificate }> = [];
  for (const block of certificateBlocks(pem)) {
    try {
      out.push({ pem: `${block}\n`, cert: new X509Certificate(block) });
    } catch {
      // bloc corrompu : ignore
    }
  }
  return out;
}

/** Vrai si le certificat est signe par sa propre cle (racine). */
export function isSelfSigned(cert: X509Certificate): boolean {
  try {
    return cert.subject === cert.issuer && cert.verify(cert.publicKey);
  } catch {
    return false;
  }
}

/**
 * Le certificat a installer sur le telephone : l'autorite (CA:TRUE), de preference la racine auto-signee.
 * `null` si le fichier ne contient aucune autorite lisible (certificat de serveur seul, illisible ou vide).
 */
export function pickPhoneCa(pem: Buffer | string): { pem: string; cert: X509Certificate } | null {
  const cas = parseCertificates(pem).filter((c) => c.cert.ca);
  return cas.find((c) => isSelfSigned(c.cert)) ?? cas[cas.length - 1] ?? null;
}
