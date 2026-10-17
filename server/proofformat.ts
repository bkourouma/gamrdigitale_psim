import { createHash } from 'node:crypto';

/**
 * Format du dossier de preuve (voir proofpack.ts pour la fabrication, scripts/verify-proof.ts pour la verification).
 * Ce module ne depend de rien d'autre que de node:crypto : il est partage par l'export et par la verification hors ligne.
 */

export const PROOF_VERSION = 1;
export const MANIFEST_NAME = 'MANIFEST.sha256';
export const README_NAME = 'LISEZ-MOI.txt';
export const INCIDENT_NAME = 'incident.json';
export const JOURNAL_NAME = 'journal-extrait.json';
export const NOTIFICATIONS_NAME = 'notifications.json';
export const REPORT_NAME = 'rapport.html';
/** Fichiers toujours presents (hors images et manifeste). */
export const FIXED_FILES = [README_NAME, INCIDENT_NAME, JOURNAL_NAME, NOTIFICATIONS_NAME, REPORT_NAME];
/** Une image du dossier : `images/<identifiant>.jpg|png`. */
export const IMAGE_ENTRY = /^images\/(\d+)\.(jpg|png)$/;
/** Details d'une entree « image_scellee » du journal (voir evidence.ts) : identifiant, empreinte, taille. */
export const SEAL_DETAILS = /^image (\d+) sha256=([0-9a-f]{64}) (\d+) octets/;
export const SEAL_ACTION = 'image_scellee';
export const HASH64 = /^[0-9a-f]{64}$/;

export const sha256hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** Une entree du journal telle qu'exportee : les champs hashes (voir auditchain.computeHash) + les deux empreintes. */
export interface ProofJournalEntry {
  id: number;
  ts: number;
  actor: string;
  action: string;
  incident_id: number | null;
  device_id: string | null;
  details: string | null;
  prev_hash: string | null;
  hash: string | null;
}

export interface ProofJournal {
  version: number;
  incident: number;
  algorithme: string;
  fenetre: { debut: number; fin: number; avant_ms: number; apres_ms: number };
  /** Empreinte de l'entree qui precede la premiere du extrait (null si l'extrait est vide). */
  empreinte_precedente_premiere: string | null;
  /** Fin de la chaine du journal au moment de l'export : a comparer a une ancre conservee ailleurs. */
  ancre: { id: number; hash: string } | null;
  entrees_omises: { droits: number; plafond: number };
  entrees: ProofJournalEntry[];
}

export const JOURNAL_ALGORITHM = 'SHA-256 de JSON([empreinte_precedente, id, ts, actor, action, incident_id, device_id, details]) ; voir server/auditchain.ts';

/** Etat d'une image au moment de l'export. */
export type ImageState = 'conforme' | 'alteree' | 'manquante' | 'non_scellee' | 'purgee' | 'anomalie' | 'omise';

export interface ProofImage {
  id: number;
  /** Chemin dans le dossier (`images/12.jpg`), ou null si le fichier est absent/omis. */
  fichier: string | null;
  source: 'camera' | 'equipement';
  equipement: string;
  pris_le: number;
  motif: string;
  /** Empreinte et taille SCELLEES au journal (null si aucune entree scellee). */
  sha256_scelle: string | null;
  octets_scelles: number | null;
  entree_journal: number | null;
  /** Empreinte et taille du fichier tel qu'il est dans le dossier (null s'il est absent). */
  sha256_dossier: string | null;
  octets: number | null;
  etat: ImageState;
  remarque: string | null;
}

/** « <empreinte>  <chemin> » par ligne, comme `sha256sum` (verifiable avec `sha256sum -c MANIFEST.sha256`). */
export function formatManifest(items: { name: string; sha256: string }[]): string {
  return `${[...items].sort((a, b) => (a.name < b.name ? -1 : 1)).map((i) => `${i.sha256}  ${i.name}`).join('\n')}\n`;
}

/** Lit un manifeste ; leve une erreur sur toute ligne mal formee ou tout nom en double. */
export function parseManifest(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) throw new Error('manifeste vide');
  for (const line of lines) {
    const m = /^([0-9a-f]{64}) {2}([A-Za-z0-9_./-]{1,120})$/.exec(line);
    if (!m) throw new Error(`ligne de manifeste mal formee : « ${line.slice(0, 80)} »`);
    if (out.has(m[2])) throw new Error(`fichier liste deux fois dans le manifeste : ${m[2]}`);
    out.set(m[2], m[1]);
  }
  return out;
}
