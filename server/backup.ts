/**
 * Sauvegarde et restauration.
 *
 * Une sauvegarde est un dossier `psim-AAAAMMJJ-HHMMSS/` : la base (copie COHERENTE faite a chaud
 * par SQLite, sans arreter le PSIM), les images d'incident, les plans, et un `manifest.json` avec
 * l'empreinte SHA-256 de chaque fichier. Elle est verifiee a la creation et avant toute restauration.
 *
 * La cle de chiffrement des mots de passe des cameras (`secret.key`) n'est PAS incluse par defaut :
 * la ranger avec la base annulerait l'interet de la chiffrer. Sans elle, un PSIM restaure sur une
 * autre machine demandera de ressaisir les mots de passe des cameras.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { headOf } from './auditchain.ts';
import { lockHolder } from './lock.ts';

const NAME_PATTERN = /^psim-\d{8}-\d{6}(-\d+)?$/;
const PLAN_PATTERN = /^plan-\d+\.(png|jpg|webp|svg)$/;
const SNAPSHOT_PATTERN = /^\d+\.jpg$/;

/** Contenu legitime d'une sauvegarde : la base, la cle (si demandee), les plans et les images d'incident. */
const ALLOWED_BACKUP_FILE = /^(psim\.db|secret\.key|plan-\d+\.(png|jpg|webp|svg)|snapshots\/\d+\.jpg)$/;

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface Manifest {
  version: 1;
  app: 'gamrdigitale-psim';
  createdAt: number;
  includesKey: boolean;
  /** Empreinte de fin de journal au moment de la sauvegarde : une ancre conservee avec la sauvegarde (voir auditchain.ts). */
  auditHead?: { id: number; hash: string } | null;
  files: ManifestFile[];
}

export interface BackupResult {
  dir: string;
  name: string;
  bytes: number;
  files: number;
  includesKey: boolean;
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function stamp(t: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function integrityOk(dbPath: string): boolean {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    return rows.length === 1 && rows[0].integrity_check === 'ok';
  } finally {
    db.close();
  }
}

export interface BackupOptions {
  db: DatabaseSync;
  dataDir: string;
  backupDir: string;
  now?: () => number;
  includeKey?: boolean;
}

export function createBackup(opts: BackupOptions): BackupResult {
  const t = (opts.now ?? Date.now)();
  mkdirSync(opts.backupDir, { recursive: true });
  let name = `psim-${stamp(t)}`;
  for (let n = 2; existsSync(join(opts.backupDir, name)); n++) name = `psim-${stamp(t)}-${n}`;
  const dir = join(opts.backupDir, name);
  mkdirSync(dir);

  try {
    const files: ManifestFile[] = [];
    const add = (relative: string) => {
      const full = join(dir, relative);
      files.push({ path: relative.split(sep).join('/'), size: statSync(full).size, sha256: sha256(full) });
    };

    // Copie coherente de la base, faite a chaud (le PSIM continue de tourner).
    opts.db.prepare('VACUUM INTO ?').run(join(dir, 'psim.db'));
    if (!integrityOk(join(dir, 'psim.db'))) throw new Error('la copie de la base ne passe pas le controle d\'integrite');
    add('psim.db');

    for (const f of readdirSync(opts.dataDir).filter((n) => PLAN_PATTERN.test(n))) {
      copyFileSync(join(opts.dataDir, f), join(dir, f));
      add(f);
    }
    const snapshots = join(opts.dataDir, 'snapshots');
    if (existsSync(snapshots)) {
      mkdirSync(join(dir, 'snapshots'));
      for (const f of readdirSync(snapshots).filter((n) => SNAPSHOT_PATTERN.test(n))) {
        copyFileSync(join(snapshots, f), join(dir, 'snapshots', f));
        add(join('snapshots', f));
      }
    }
    const key = join(opts.dataDir, 'secret.key');
    const includesKey = Boolean(opts.includeKey) && existsSync(key);
    if (includesKey) {
      copyFileSync(key, join(dir, 'secret.key'));
      add('secret.key');
    }

    const manifest: Manifest = { version: 1, app: 'gamrdigitale-psim', createdAt: t, includesKey, auditHead: headOf(opts.db), files };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return { dir, name, bytes: files.reduce((s, f) => s + f.size, 0), files: files.length, includesKey };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true }); // jamais de sauvegarde a moitie ecrite
    throw err;
  }
}

export interface Verification {
  ok: boolean;
  problems: string[];
  manifest: Manifest | null;
}

export function verifyBackup(dir: string): Verification {
  const problems: string[] = [];
  let manifest: Manifest | null = null;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    return { ok: false, problems: ['manifest.json absent ou illisible : ce dossier n\'est pas une sauvegarde du PSIM'], manifest: null };
  }
  if (manifest.version !== 1 || manifest.app !== 'gamrdigitale-psim' || !Array.isArray(manifest.files)) {
    return { ok: false, problems: ['manifest.json inattendu'], manifest: null };
  }
  const root = resolve(dir);
  for (const f of manifest.files) {
    const full = resolve(dir, String(f.path));
    // Un manifeste alteré ne doit jamais faire lire ou copier hors du dossier de sauvegarde.
    if (!full.startsWith(root + sep)) {
      problems.push(`chemin suspect dans le manifeste : ${f.path}`);
      continue;
    }
    // ... ni designer autre chose que ce qu'une sauvegarde contient reellement (un manifeste forge, empreintes comprises, ne peut pas faire ecrire ailleurs).
    if (typeof f.path !== 'string' || !ALLOWED_BACKUP_FILE.test(f.path)) {
      problems.push(`fichier non prevu dans le manifeste : ${String(f.path).slice(0, 80)}`);
      continue;
    }
    if (!existsSync(full)) problems.push(`fichier manquant : ${f.path}`);
    else if (statSync(full).size !== f.size || sha256(full) !== f.sha256) problems.push(`fichier altere : ${f.path}`);
  }
  if (!manifest.files.some((f) => f.path === 'psim.db')) problems.push('la base psim.db n\'est pas dans la sauvegarde');
  else if (existsSync(join(dir, 'psim.db')) && !problems.some((p) => p.includes('psim.db'))) {
    try {
      if (!integrityOk(join(dir, 'psim.db'))) problems.push('la base ne passe pas le controle d\'integrite');
    } catch {
      problems.push('la base est illisible');
    }
  }
  return { ok: problems.length === 0, problems, manifest };
}

export function listBackups(backupDir: string): { name: string; createdAt: number; bytes: number }[] {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((n) => NAME_PATTERN.test(n) && existsSync(join(backupDir, n, 'manifest.json')))
    .map((name) => {
      try {
        const m = JSON.parse(readFileSync(join(backupDir, name, 'manifest.json'), 'utf8')) as Manifest;
        return { name, createdAt: m.createdAt, bytes: m.files.reduce((s, f) => s + f.size, 0) };
      } catch {
        return null;
      }
    })
    .filter((b) => b !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Ne garde que les `keep` sauvegardes les plus recentes ; ne supprime que des dossiers au nom attendu. */
export function pruneBackups(backupDir: string, keep: number): string[] {
  // Valeur invalide (NaN, negative, nulle) : on ne supprime RIEN. `slice(NaN)` vaut `slice(0)` et effacerait toutes les sauvegardes.
  if (!Number.isFinite(keep) || keep < 1) return [];
  const removed: string[] = [];
  for (const b of listBackups(backupDir).slice(keep)) {
    const target = resolve(backupDir, b.name);
    if (!NAME_PATTERN.test(basename(target)) || !target.startsWith(resolve(backupDir) + sep)) continue;
    rmSync(target, { recursive: true, force: true });
    removed.push(b.name);
  }
  return removed;
}

export interface RestoreResult {
  from: string;
  /** Dossier ou l'ancien dossier de donnees a ete mis de cote (jamais supprime), ou null s'il n'existait pas. */
  previousMovedTo: string | null;
  files: number;
  keyKept: boolean;
}

/**
 * Restaure une sauvegarde. Refuse si le PSIM tourne ou si la sauvegarde est alteree. L'ancien dossier de
 * donnees est DEPLACE, pas supprime : une mauvaise restauration reste rattrapable.
 */
export function restoreBackup(opts: { backupDir: string; dataDir: string; now?: () => number }): RestoreResult {
  const check = verifyBackup(opts.backupDir);
  if (!check.ok || !check.manifest) throw new Error(`Sauvegarde invalide : ${check.problems.join(' ; ')}`);
  const holder = lockHolder(opts.dataDir);
  if (holder !== null) throw new Error(`Le PSIM tourne (PID ${holder}) : l'arreter avant de restaurer.`);

  const t = (opts.now ?? Date.now)();
  let previousMovedTo: string | null = null;
  if (existsSync(opts.dataDir)) {
    previousMovedTo = `${opts.dataDir}.before-restore-${stamp(t)}`;
    renameSync(opts.dataDir, previousMovedTo);
  }
  mkdirSync(opts.dataDir, { recursive: true });
  for (const f of check.manifest.files) {
    const target = join(opts.dataDir, f.path);
    mkdirSync(join(target, '..'), { recursive: true });
    copyFileSync(join(opts.backupDir, f.path), target);
  }
  // Sans cle dans la sauvegarde, on garde celle de l'installation precedente (memes mots de passe de cameras).
  let keyKept = check.manifest.includesKey;
  if (!check.manifest.includesKey && previousMovedTo && existsSync(join(previousMovedTo, 'secret.key'))) {
    copyFileSync(join(previousMovedTo, 'secret.key'), join(opts.dataDir, 'secret.key'));
    keyKept = true;
  }
  return { from: opts.backupDir, previousMovedTo, files: check.manifest.files.length, keyKept };
}
