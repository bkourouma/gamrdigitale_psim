import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DEVICE_KEY_SCHEMA } from './devicekeys.ts';

/**
 * Images d'incident valant preuve : UN SEUL point d'enregistrement (`sealImage`) pour les images des cameras liees et pour
 * celles envoyees par les equipements. Chaque image enregistree inscrit au journal infalsifiable (auditchain.ts) une entree
 * « image_scellee » qui porte son empreinte SHA-256 et sa taille : la chaine du journal scelle donc l'image. Une image
 * modifiee, remplacee ou supprimee hors purge est detectee par `verifyImages` (npm run verify-journal -- --images).
 *
 * Limites : une image anterieure au mecanisme (sans empreinte) n'est pas protegee (comptee a part) ; comme pour le journal,
 * quelqu'un qui a un acces complet a la machine peut tout recalculer, d'ou les ancres conservees hors machine.
 */

export type ImageType = 'jpg' | 'png';
/** Nom de fichier d'une image d'incident : derive du seul identifiant numerique, jamais d'une entree externe. */
export const IMAGE_FILE = /^\d+\.(jpg|png)$/;
export const SEAL_ACTION = 'image_scellee';
export const PURGE_ACTION = 'images_purgees';
const SEAL_DETAILS = /^image (\d+) sha256=([0-9a-f]{64}) (\d+) octets/;
/** Dimensions maximales acceptees : une image « bombe » (enorme une fois decodee) ferait tomber le navigateur des operateurs. */
export const MAX_PIXELS = 50_000_000;
export const MAX_SIDE = 16_384;

export const sha256hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/**
 * Migration (idempotente, sans perte) : origine et empreinte des images d'incident, images en attente de rattachement,
 * cles d'entree par equipement. Les images existantes restent « camera », sans empreinte (non protegees).
 */
export function migrateEvidence(db: DatabaseSync): void {
  const columns = (db.prepare('PRAGMA table_info(incident_snapshot)').all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes('source')) db.exec("ALTER TABLE incident_snapshot ADD COLUMN source TEXT NOT NULL DEFAULT 'camera'");
  if (!columns.includes('sha256')) db.exec('ALTER TABLE incident_snapshot ADD COLUMN sha256 TEXT');
  if (!columns.includes('bytes')) db.exec('ALTER TABLE incident_snapshot ADD COLUMN bytes INTEGER');
  db.exec(`
CREATE TABLE IF NOT EXISTS device_image_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('jpg', 'png')),
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  event TEXT
);
CREATE INDEX IF NOT EXISTS pending_image_by_device ON device_image_pending(device_id, received_at);
${DEVICE_KEY_SCHEMA}`);
}

/**
 * Type reel d'une image d'apres ses octets (jamais d'apres l'en-tete Content-Type), avec ses dimensions lues dans l'en-tete
 * du format SANS rien decompresser. null = ni un JPEG ni un PNG complet et plausible.
 */
export function sniffImage(b: Buffer): { type: ImageType; width: number; height: number } | null {
  if (b.length >= 64 && b[0] === 0x89 && b.subarray(1, 8).equals(Buffer.from([0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    // IHDR en premier bloc, IEND en dernier : un PNG tronque ou suivi d'autre chose est refuse.
    if (b.readUInt32BE(8) !== 13 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
    if (!b.subarray(b.length - 12).equals(Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]))) return null;
    return { type: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9) {
    // Parcours des segments jusqu'au debut des donnees compressees (SOS) a la recherche des dimensions (SOFn).
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++; // octet de bourrage
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2; // marqueurs sans longueur
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null; // fin ou donnees avant toute dimension
      const length = b.readUInt16BE(i + 2);
      if (length < 2 || i + 2 + length > b.length) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (length < 7) return null;
        return { type: 'jpg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + length;
    }
    return null;
  }
  return null;
}

/** Les dimensions sont-elles acceptables (ni nulles, ni demesurees) ? */
export const sensibleSize = (s: { width: number; height: number }): boolean =>
  s.width > 0 && s.height > 0 && s.width <= MAX_SIDE && s.height <= MAX_SIDE && s.width * s.height <= MAX_PIXELS;

export type AuditFn = (actor: string, action: string, ref?: { incidentId?: number; deviceId?: string; details?: string }) => void;

export interface SealInput {
  incidentId: number;
  /** Camera liee (origine « camera ») ou equipement emetteur (origine « device »). */
  deviceId: string;
  takenAt: number;
  /** opened / escalated / confirmed (cameras liees) ; device (image envoyee par l'equipement). */
  reason: string;
  source: 'camera' | 'device';
  data: Buffer;
  type: ImageType;
  /** Precision journalisee (evenement annonce par l'equipement, heure de reception d'une image mise en attente). */
  note?: string;
}

export interface SealedImage {
  id: number;
  file: string;
  sha256: string;
  bytes: number;
}

/**
 * Enregistre une image d'incident ET la scelle au journal, atomiquement : la ligne, le fichier et l'entree du journal
 * existent tous les trois, ou aucun. Synchrone (aucune attente entre l'ecriture et le scellement).
 */
export function sealImage(db: DatabaseSync, dir: string, audit: AuditFn, input: SealInput): SealedImage {
  const sha256 = sha256hex(input.data);
  const bytes = input.data.length;
  let written: string | null = null;
  db.exec('SAVEPOINT seal_image');
  try {
    const res = db
      .prepare('INSERT INTO incident_snapshot (incident_id, camera_id, taken_at, reason, file, source, sha256, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.incidentId, input.deviceId, input.takenAt, input.reason, '', input.source, sha256, bytes);
    const id = Number(res.lastInsertRowid);
    const file = `${id}.${input.type}`;
    // Ecriture dans un fichier temporaire puis renommage : jamais d'image a moitie ecrite sous son nom definitif.
    const tmp = join(dir, `${file}.tmp`);
    writeFileSync(tmp, input.data, { flag: 'w' });
    renameSync(tmp, join(dir, file));
    written = join(dir, file);
    db.prepare('UPDATE incident_snapshot SET file = ? WHERE id = ?').run(file, id);
    const origin = input.source === 'device' ? "envoyee par l'equipement" : `camera liee, ${input.reason}`;
    audit(input.source === 'device' ? 'equipement' : 'systeme', SEAL_ACTION, {
      incidentId: input.incidentId,
      deviceId: input.deviceId,
      details: `image ${id} sha256=${sha256} ${bytes} octets (${origin})${input.note ? ` ; ${input.note}` : ''}`,
    });
    db.exec('RELEASE seal_image');
    return { id, file, sha256, bytes };
  } catch (err) {
    db.exec('ROLLBACK TO seal_image');
    db.exec('RELEASE seal_image');
    if (written) {
      try {
        unlinkSync(written);
      } catch {
        // deja absente
      }
    }
    throw err;
  }
}

/** « 1-5,8,10-12 » : liste compacte d'identifiants (ils se suivent en general). */
export function formatIds(ids: number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    parts.push(start === sorted[i] ? String(start) : `${start}-${sorted[i]}`);
  }
  return parts.join(',');
}

export function parseIds(text: string): number[] {
  const out: number[] = [];
  for (const part of text.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (b < a || b - a > 1_000_000) continue;
    for (let n = a; n <= b; n++) out.push(n);
  }
  return out;
}

/**
 * Supprime des images d'incident (purge de conservation ou de quota) et inscrit la suppression au journal : une image
 * scellee absente sans entree de purge est une suppression hors du PSIM. Une entree par tranche de 1 500 caracteres.
 */
export function deleteImages(db: DatabaseSync, dir: string, audit: AuditFn, ids: number[], why: string): number {
  if (ids.length === 0) return 0;
  const done: number[] = [];
  for (const id of ids) {
    const row = db.prepare('SELECT file FROM incident_snapshot WHERE id = ?').get(id) as { file: string } | undefined;
    if (!row) continue;
    if (IMAGE_FILE.test(row.file)) {
      try {
        unlinkSync(join(dir, row.file));
      } catch {
        // deja supprimee
      }
    }
    db.prepare('DELETE FROM incident_snapshot WHERE id = ?').run(id);
    done.push(id);
  }
  let chunk: number[] = [];
  const flush = () => {
    if (chunk.length) audit('systeme', PURGE_ACTION, { details: `images ${formatIds(chunk)} (${why})` });
    chunk = [];
  };
  for (const id of done.sort((a, b) => a - b)) {
    chunk.push(id);
    if (formatIds(chunk).length > 1500) flush();
  }
  flush();
  return done.length;
}

export interface ImageVerification {
  ok: boolean;
  /** Images scellees dont le fichier a ete recalcule et trouve conforme (ou non). */
  checked: number;
  /** Images anterieures au mecanisme (sans empreinte) : non protegees. */
  unprotected: number;
  problems: string[];
}

const MAX_IMAGE_PROBLEMS = 50;

/**
 * Recalcule l'empreinte de chaque image d'incident et la compare a celle SCELLEE au journal (la colonne en base n'est
 * qu'une copie : elle se modifie sans trace). Signale tout fichier modifie ou manquant, toute empreinte alteree en base,
 * toute image scellee supprimee sans entree de purge. A coupler avec la verification de la chaine du journal (auditchain).
 */
export function verifyImages(db: DatabaseSync, dataDir: string): ImageVerification {
  const problems: string[] = [];
  const add = (p: string) => {
    if (problems.length < MAX_IMAGE_PROBLEMS) problems.push(p);
  };
  const dir = join(dataDir, 'snapshots');
  const columns = (db.prepare('PRAGMA table_info(incident_snapshot)').all() as { name: string }[]).map((c) => c.name);
  const sealed = new Map<number, { sha256: string; bytes: number; entry: number }>();
  for (const r of db.prepare('SELECT id, details FROM audit_log WHERE action = ? AND hash IS NOT NULL ORDER BY id').all(SEAL_ACTION) as { id: number; details: string | null }[]) {
    const m = SEAL_DETAILS.exec(r.details ?? '');
    if (m) sealed.set(Number(m[1]), { sha256: m[2], bytes: Number(m[3]), entry: r.id });
  }
  const purged = new Set<number>();
  for (const r of db.prepare('SELECT details FROM audit_log WHERE action = ? AND hash IS NOT NULL').all(PURGE_ACTION) as { details: string | null }[]) {
    const m = /^images ([\d,-]+)/.exec(r.details ?? '');
    if (m) for (const id of parseIds(m[1])) purged.add(id);
  }

  let checked = 0;
  let unprotected = 0;
  const present = new Set<number>();
  const hasSha = columns.includes('sha256');
  const rows = db.prepare(`SELECT id, file${hasSha ? ', sha256' : ''} FROM incident_snapshot ORDER BY id`).all() as { id: number; file: string; sha256?: string | null }[];
  for (const r of rows) {
    present.add(r.id);
    const seal = sealed.get(r.id);
    const stored = r.sha256 ?? null;
    if (!seal) {
      if (stored) add(`image n°${r.id} : empreinte en base mais aucune entree scellee au journal (ajoutee hors du PSIM ?)`);
      else unprotected++;
      continue;
    }
    if (stored !== seal.sha256) add(`image n°${r.id} : empreinte modifiee en base (differente de celle scellee au journal, entree n°${seal.entry})`);
    if (!IMAGE_FILE.test(r.file)) {
      add(`image n°${r.id} : nom de fichier inattendu en base`);
      continue;
    }
    const path = join(dir, r.file);
    if (!existsSync(path)) {
      add(`image n°${r.id} : fichier ${r.file} MANQUANT`);
      continue;
    }
    const data = readFileSync(path);
    checked++;
    if (data.length !== seal.bytes || sha256hex(data) !== seal.sha256) add(`image n°${r.id} : fichier ${r.file} MODIFIE (empreinte differente de celle scellee au journal, entree n°${seal.entry})`);
  }
  for (const [id, seal] of sealed) {
    if (!present.has(id) && !purged.has(id)) add(`image n°${id} : supprimee sans entree de purge (scellee par l'entree n°${seal.entry})`);
  }
  return { ok: problems.length === 0, checked, unprotected, problems };
}
