/**
 * Regles pures de l'ecran « Cles et passerelles » (aucun acces a la page : testables sous Node, voir
 * test/keys-ui.test.ts) : validation des identifiants d'une cle, etat d'une cle, exemple de commande d'envoi.
 */

// Meme regle que le serveur (server/devicekeys.ts, cleanPatterns) : identifiant exact, ou prefixe termine par « * ».
export const PATTERN_ITEM = /^[A-Za-z0-9_-]{1,32}\*?$/;
export const MAX_PATTERNS = 50;

/** Pourquoi un identifiant saisi est refuse (texte pour l'installateur), ou null s'il est valable. « * » seul est refuse. */
export function patternProblem(token) {
  if (/^\*+$/.test(token)) {
    return 'Le signe « * » seul est refusé : une clé ne peut pas ouvrir tous les équipements. Indiquez un identifiant exact (I-01) ou un début d’identifiant suivi de « * » (D-*).';
  }
  if (!PATTERN_ITEM.test(token)) {
    return `« ${token} » n’est pas valable : lettres, chiffres, tiret ou tiret bas (32 caractères au plus), avec un seul « * » à la fin pour un début d’identifiant.`;
  }
  return null;
}

/** Etat d'une cle d'apres ce que le serveur renvoie : 'active', 'rotating' (fin de validite a venir) ou 'revoked'. */
export function keyState(k) {
  if (!k.active) return 'revoked';
  return k.revokedAt ? 'rotating' : 'active';
}

/** Commande curl a coller (une seule ligne : valable sous bash, cmd et PowerShell avec curl.exe). */
export function curlExample(origin, deviceId, key) {
  return `curl -X POST "${origin}/api/ingest/${deviceId}/image" -H "Authorization: Bearer ${key}" -H "Content-Type: image/jpeg" --data-binary "@photo.jpg"`;
}

/** Identifiant a mettre dans l'exemple : le premier identifiant exact de la cle, sinon un exemple bati sur son prefixe. */
export function exampleDevice(devices) {
  const exact = devices.find((d) => !d.endsWith('*'));
  if (exact) return exact;
  const prefix = (devices[0] ?? 'D-*').slice(0, -1);
  return `${prefix}01`;
}
