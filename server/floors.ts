/**
 * Etages du site (duplex, immeuble) : chaque etage a son nom, sa place dans l'empilement et son propre plan ; chaque
 * equipement appartient a un etage. Il existe TOUJOURS au moins un etage : une base anterieure (un seul plan) est migree
 * en un etage « Rez-de-chaussee » qui reprend ce plan (voir `migrateFloors`, appele a l'ouverture de la base).
 *
 * Les fichiers de plan s'appellent `plan-<etage>-<version>.<ext>` ; le fichier d'une base anterieure (`plan-<version>.<ext>`)
 * reste valable tant que son etage ne change pas de plan. Seuls les fichiers qu'aucun etage ne reference sont supprimes.
 */
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { PsimError } from './errors.ts';
import { hasForbiddenChar, normalizeName } from './text.ts';
import type { Floor } from './types.ts';

export const DEFAULT_FLOOR_NAME = 'Rez-de-chaussée';
export const MAX_FLOORS = 20;
const MAX_FLOOR_NAME = 40;
/** Fichier de plan, ancien (`plan-3.svg`) ou par etage (`plan-2-5.svg`). */
export const PLAN_FILE_PATTERN = /^plan-\d+(-\d+)?\.(png|jpg|webp|svg)$/;

export const PLAN_TYPES: Record<string, { ext: string; mime: string }> = {
  'image/png': { ext: 'png', mime: 'image/png' },
  'image/jpeg': { ext: 'jpg', mime: 'image/jpeg' },
  'image/webp': { ext: 'webp', mime: 'image/webp' },
  'image/svg+xml': { ext: 'svg', mime: 'image/svg+xml' },
};

type Row = Record<string, unknown>;

function rowToFloor(r: Row): Floor {
  return {
    id: r.id as number,
    name: r.name as string,
    position: r.position as number,
    hasPlan: Boolean(r.plan_file),
    planVersion: r.plan_version as number,
  };
}

/** Etages du bas vers le haut. */
export function listFloors(db: DatabaseSync): Floor[] {
  return (db.prepare('SELECT * FROM floor ORDER BY position, id').all() as Row[]).map(rowToFloor);
}

/** Etage le plus bas : celui des equipements sans etage et des anciennes routes `/api/plan`. */
export function defaultFloorId(db: DatabaseSync): number {
  const row = db.prepare('SELECT id FROM floor ORDER BY position, id LIMIT 1').get() as { id: number } | undefined;
  if (!row) throw new PsimError(500, 'Aucun etage : base incoherente');
  return row.id;
}

/**
 * Migration (a chaque ouverture de la base, sans effet si deja faite) : cree l'etage par defaut avec le plan de l'ancien
 * site, et rattache a l'etage le plus bas tout equipement sans etage valide. Une base neuve recoit un etage sans plan.
 */
export function migrateFloors(db: DatabaseSync): void {
  // Rien n'est ecrit si la migration est deja faite : une ecriture prendrait le verrou de la base a chaque ouverture
  // (sauvegarde planifiee, outils) pendant que le PSIM ecrit.
  const count = (db.prepare('SELECT COUNT(*) AS n FROM floor').get() as { n: number }).n;
  if (count === 0) {
    const site = db.prepare('SELECT plan_file, plan_version FROM site WHERE id = 1').get() as Row | undefined;
    db.prepare('INSERT INTO floor (name, position, plan_file, plan_version) VALUES (?, 0, ?, ?)').run(
      DEFAULT_FLOOR_NAME,
      (site?.plan_file as string | null | undefined) ?? null,
      (site?.plan_version as number | undefined) ?? 0,
    );
  }
  const orphan = db.prepare('SELECT 1 AS x FROM device WHERE floor_id IS NULL OR floor_id NOT IN (SELECT id FROM floor) LIMIT 1').get();
  if (orphan) db.prepare('UPDATE device SET floor_id = ? WHERE floor_id IS NULL OR floor_id NOT IN (SELECT id FROM floor)').run(defaultFloorId(db));
}

/** Le contenu ressemble-t-il vraiment au type d'image annonce ? (un SVG est servi avec une CSP qui interdit tout script) */
export function looksLike(mime: string, body: Buffer): boolean {
  switch (mime) {
    case 'image/png':
      return body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    case 'image/jpeg':
      return body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case 'image/webp':
      return body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'image/svg+xml':
      return body.subarray(0, 2048).toString('utf8').includes('<svg');
    default:
      return false;
  }
}

export interface FloorsDeps {
  db: DatabaseSync;
  dataDir: string;
  audit: (actor: string, action: string, ref?: { details?: string }) => void;
  /** Previent les interfaces connectees qu'il faut recharger l'etat. */
  publishConfig: () => void;
}

export function createFloors(deps: FloorsDeps) {
  const { db } = deps;

  function get(id: unknown): Floor & { planFile: string | null } {
    const n = typeof id === 'number' ? id : Number(id);
    if (!Number.isInteger(n) || n < 1) throw new PsimError(400, 'Etage invalide');
    const row = db.prepare('SELECT * FROM floor WHERE id = ?').get(n) as Row | undefined;
    if (!row) throw new PsimError(404, 'Etage introuvable');
    return { ...rowToFloor(row), planFile: (row.plan_file as string | null) ?? null };
  }

  function cleanName(value: unknown, exceptId: number | null): string {
    if (typeof value !== 'string' || !value.trim()) throw new PsimError(400, "Nom de l'etage requis");
    // Comme les noms d'equipements (voir text.ts) : il finit dans des e-mails, des messages Telegram, des journaux et des terminaux.
    if (hasForbiddenChar(value)) throw new PsimError(400, "Nom de l'etage invalide (caracteres de controle ou invisibles interdits)");
    const name = normalizeName(value);
    if (name.length > MAX_FLOOR_NAME) throw new PsimError(400, `Nom de l'etage trop long (max ${MAX_FLOOR_NAME} caracteres)`);
    // Doublon : meme forme Unicode, sans tenir compte de la casse (« Étage » saisi de deux facons reste un seul nom).
    const key = (s: string) => s.normalize('NFC').toLocaleLowerCase('fr');
    const clash = listFloors(db).find((f) => f.id !== exceptId && key(f.name) === key(name));
    if (clash) throw new PsimError(409, `Un etage s'appelle deja « ${clash.name} »`);
    return name;
  }

  /** Renumerote 0..n-1 dans l'ordre donne (transaction : jamais d'ordre a moitie applique). */
  function renumber(ids: number[]): void {
    const update = db.prepare('UPDATE floor SET position = ? WHERE id = ?');
    ids.forEach((id, index) => update.run(index, id));
  }

  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function create(actor: string, input: Record<string, unknown>): Floor {
    const floor = transaction(() => {
      const floors = listFloors(db);
      if (floors.length >= MAX_FLOORS) throw new PsimError(409, `${MAX_FLOORS} etages au plus`);
      const name = cleanName(input.name, null);
      const id = Number(db.prepare('INSERT INTO floor (name, position, plan_file, plan_version) VALUES (?, ?, NULL, 0)').run(name, floors.length).lastInsertRowid);
      return get(id);
    });
    deps.audit(actor, 'floor_created', { details: floor.name });
    deps.publishConfig();
    return strip(floor);
  }

  /** Renommer (`name`) et/ou deplacer dans l'empilement (`position` : 0 = le plus bas). */
  function update(actor: string, id: unknown, input: Record<string, unknown>): Floor {
    const before = get(id);
    const changes: string[] = [];
    transaction(() => {
      if (input.name !== undefined) {
        const name = cleanName(input.name, before.id);
        if (name !== before.name) {
          db.prepare('UPDATE floor SET name = ? WHERE id = ?').run(name, before.id);
          changes.push(`renomme « ${before.name} » -> « ${name} »`);
        }
      }
      if (input.position !== undefined) {
        const floors = listFloors(db);
        const target = input.position;
        if (typeof target !== 'number' || !Number.isInteger(target) || target < 0 || target >= floors.length) {
          throw new PsimError(400, `Position invalide (0 a ${floors.length - 1})`);
        }
        const ids = floors.map((f) => f.id).filter((x) => x !== before.id);
        ids.splice(target, 0, before.id);
        renumber(ids);
        if (target !== floors.findIndex((f) => f.id === before.id)) changes.push(`place au niveau ${target}`);
      }
    });
    const after = get(before.id);
    if (changes.length) {
      deps.audit(actor, 'floor_updated', { details: `${after.name} : ${changes.join(', ')}` });
      deps.publishConfig();
    }
    return strip(after);
  }

  /** Refuse de supprimer le dernier etage, ou un etage qui porte encore des equipements (ils disparaitraient du plan). */
  function remove(actor: string, id: unknown): void {
    const floor = get(id);
    transaction(() => {
      if (listFloors(db).length <= 1) throw new PsimError(409, 'Il faut au moins un etage');
      const used = (db.prepare('SELECT COUNT(*) AS n FROM device WHERE floor_id = ?').get(floor.id) as { n: number }).n;
      if (used > 0) throw new PsimError(409, `${used} equipement(s) sont sur cet etage : les deplacer ou les supprimer d'abord`);
      db.prepare('DELETE FROM floor WHERE id = ?').run(floor.id);
      renumber(listFloors(db).map((f) => f.id));
    });
    removeUnusedPlans();
    deps.audit(actor, 'floor_deleted', { details: floor.name });
    deps.publishConfig();
  }

  /** Chemin du plan d'un etage, ou null (pas de plan, ou fichier absent). Le nom vient de la base, jamais de la requete. */
  function planPath(id: unknown): { path: string; mime: string } | null {
    const floor = get(id);
    if (!floor.planFile || !PLAN_FILE_PATTERN.test(floor.planFile)) return null;
    const path = resolve(deps.dataDir, floor.planFile);
    if (!path.startsWith(resolve(deps.dataDir) + sep) || !existsSync(path)) return null;
    const mime = Object.values(PLAN_TYPES).find((t) => floor.planFile!.endsWith(`.${t.ext}`))?.mime ?? 'application/octet-stream';
    return { path, mime };
  }

  function setPlan(actor: string, id: unknown, mime: string, body: unknown): { planVersion: number } {
    const floor = get(id);
    const type = PLAN_TYPES[mime];
    if (!type || !Buffer.isBuffer(body) || body.length === 0) throw new PsimError(415, 'Envoyer une image PNG, JPEG, WEBP ou SVG');
    if (!looksLike(mime, body)) throw new PsimError(400, "Le contenu ne correspond pas au type d'image annonce");
    mkdirSync(deps.dataDir, { recursive: true });
    const version = floor.planVersion + 1;
    const file = `plan-${floor.id}-${version}.${type.ext}`;
    writeFileSync(join(deps.dataDir, file), body);
    db.prepare('UPDATE floor SET plan_file = ?, plan_version = ? WHERE id = ?').run(file, version, floor.id);
    removeUnusedPlans();
    deps.audit(actor, 'plan_updated', { details: `${floor.name} - ${(body.length / 1024).toFixed(0)} Ko` });
    deps.publishConfig();
    return { planVersion: version };
  }

  /** Supprime les fichiers de plan qu'aucun etage ne reference (anciens plans remplaces, etages supprimes). */
  function removeUnusedPlans(): void {
    if (!existsSync(deps.dataDir)) return;
    const used = new Set((db.prepare('SELECT plan_file FROM floor WHERE plan_file IS NOT NULL').all() as Row[]).map((r) => r.plan_file as string));
    for (const name of readdirSync(deps.dataDir)) {
      if (!PLAN_FILE_PATTERN.test(name) || used.has(name)) continue;
      try {
        unlinkSync(resolve(deps.dataDir, name));
      } catch {
        // fichier en cours de lecture (Windows) : il sera supprime au prochain remplacement
      }
    }
  }

  return { list: () => listFloors(db), get: (id: unknown) => strip(get(id)), defaultId: () => defaultFloorId(db), create, update, remove, planPath, setPlan };
}

function strip(floor: Floor & { planFile?: string | null }): Floor {
  const { planFile: _ignored, ...rest } = floor;
  return rest;
}

export type Floors = ReturnType<typeof createFloors>;
