import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PsimError } from './errors.ts';
import { allows } from './mqtt.ts';

/**
 * Cles d'entree PAR EQUIPEMENT (ou par passerelle), pour l'entree HTTP des equipements (`/api/ingest/<id>` et
 * `/api/ingest/<id>/image`). Remplacent le jeton unique partage (PSIM_INGEST_TOKEN), qui reste accepte pour les messages
 * d'etat (retrocompatibilite) mais JAMAIS pour les images.
 *
 *  - forme de la cle : `psk_<n>_<43 caracteres base64url>` (256 bits aleatoires) ; `<n>` = numero de la cle, public ;
 *  - seule l'empreinte SHA-256 de la cle complete est stockee (256 bits aleatoires ne se retrouvent pas par force brute a
 *    partir de l'empreinte : un sel ou un HMAC n'ajouteraient rien) ; comparaison en temps constant ;
 *  - la cle n'est affichee qu'UNE fois, a la creation (ou a la rotation), jamais journalisee ;
 *  - une cle n'agit que sur SES equipements : identifiants exacts ou prefixes « D-* », comme les passerelles MQTT ;
 *  - revocation immediate, ou differee (rotation avec delai de grace pour reconfigurer l'equipement sur le terrain).
 */

export const KEY_PATTERN = /^psk_(\d{1,9})_([A-Za-z0-9_-]{43})$/;
const PATTERN_ITEM = /^[A-Za-z0-9_-]{1,32}\*?$/;
const MAX_PATTERNS = 50;
const MAX_ACTIVE_KEYS = 500;

export const DEVICE_KEY_SCHEMA = `
CREATE TABLE IF NOT EXISTS device_key (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  devices TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT,
  replaced_by INTEGER,
  last_used_at INTEGER
);
`;

export interface DeviceKeyView {
  id: number;
  label: string;
  devices: string[];
  createdAt: number;
  createdBy: string;
  /** Fin de validite (passee = revoquee ; future = rotation en cours, l'ancienne cle vit encore), ou null. */
  revokedAt: number | null;
  revokedBy: string | null;
  replacedBy: number | null;
  lastUsedAt: number | null;
  active: boolean;
}

type Row = Record<string, unknown>;

const sha256hex = (v: string) => createHash('sha256').update(v).digest('hex');
// Empreinte de reference pour une cle mal formee ou inconnue : meme travail, meme duree, toujours refusee.
const DUMMY_HASH = sha256hex(`psk_0_${'A'.repeat(43)}-jamais-valide`);

export function cleanPatterns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATTERNS) {
    throw new PsimError(400, `devices : liste de 1 a ${MAX_PATTERNS} identifiants (« D-01 ») ou prefixes (« D-* »)`);
  }
  const out = new Set<string>();
  for (const v of value) {
    if (typeof v !== 'string' || !PATTERN_ITEM.test(v.trim())) {
      throw new PsimError(400, 'devices : identifiant ou prefixe invalide (lettres, chiffres, - et _, 32 caracteres, « * » final pour un prefixe)');
    }
    out.add(v.trim());
  }
  return [...out];
}

function cleanLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  if (!label || label.length > 80) throw new PsimError(400, 'label : nom de la cle requis (80 caracteres au plus)');
  return label;
}

function view(r: Row, now: number): DeviceKeyView {
  const revokedAt = (r.revoked_at as number | null) ?? null;
  return {
    id: r.id as number,
    label: r.label as string,
    devices: JSON.parse(r.devices as string) as string[],
    createdAt: r.created_at as number,
    createdBy: r.created_by as string,
    revokedAt,
    revokedBy: (r.revoked_by as string | null) ?? null,
    replacedBy: (r.replaced_by as number | null) ?? null,
    lastUsedAt: (r.last_used_at as number | null) ?? null,
    active: revokedAt === null || revokedAt > now,
  };
}

export type KeyCheck =
  | { ok: true; keyId: number; label: string }
  | { ok: false; reason: 'absent' | 'malformed' | 'unknown' | 'revoked' | 'scope'; keyId: number | null };

export interface DeviceKeysDeps {
  db: DatabaseSync;
  audit: (actor: string, action: string, ref?: { deviceId?: string; details?: string }) => void;
  now?: () => number;
}

export function createDeviceKeys(deps: DeviceKeysDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  db.exec(DEVICE_KEY_SCHEMA);

  function get(id: number): DeviceKeyView | null {
    const r = db.prepare('SELECT * FROM device_key WHERE id = ?').get(id) as Row | undefined;
    return r ? view(r, now()) : null;
  }

  function issue(actor: string, label: string, devices: string[]): { view: DeviceKeyView; key: string } {
    const active = (db.prepare('SELECT COUNT(*) AS n FROM device_key WHERE revoked_at IS NULL OR revoked_at > ?').get(now()) as { n: number }).n;
    if (active >= MAX_ACTIVE_KEYS) throw new PsimError(409, `Trop de cles actives (${MAX_ACTIVE_KEYS}) : revoquez celles qui ne servent plus`);
    // Numero reserve d'abord (empreinte provisoire unique, inutilisable), puis cle definitive : la cle contient son numero.
    const res = db
      .prepare('INSERT INTO device_key (label, devices, key_hash, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(label, JSON.stringify(devices), `provisoire-${randomBytes(16).toString('hex')}`, now(), actor);
    const id = Number(res.lastInsertRowid);
    const key = `psk_${id}_${randomBytes(32).toString('base64url')}`;
    db.prepare('UPDATE device_key SET key_hash = ? WHERE id = ?').run(sha256hex(key), id);
    return { view: get(id)!, key };
  }

  /** Execute `fn` dans un point de sauvegarde (utilisable dans ou hors d'une transaction). */
  function atomically<T>(name: string, fn: () => T): T {
    db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      db.exec(`RELEASE ${name}`);
      return out;
    } catch (err) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw err;
    }
  }

  const keyIdOf = (value: unknown): number => {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 1) throw new PsimError(404, 'Cle introuvable');
    return id;
  };

  return {
    list(): DeviceKeyView[] {
      return (db.prepare('SELECT * FROM device_key ORDER BY id').all() as Row[]).map((r) => view(r, now()));
    },

    /** Cree une cle ; la valeur en clair n'est renvoyee qu'ICI (jamais stockee, jamais journalisee). */
    create(actor: string, input: Record<string, unknown>): DeviceKeyView & { key: string } {
      const label = cleanLabel(input.label);
      const devices = cleanPatterns(input.devices);
      return atomically('device_key_create', () => {
        const { view: v, key } = issue(actor, label, devices);
        deps.audit(actor, 'device_key_created', { details: `cle n°${v.id} « ${label} » pour ${devices.join(',')}` });
        return { ...v, key };
      });
    },

    /** Revocation immediate. Idempotente ; une rotation en cours (fin de validite future) est avancee a maintenant. */
    revoke(actor: string, idValue: unknown): DeviceKeyView {
      const id = keyIdOf(idValue);
      const current = get(id);
      if (!current) throw new PsimError(404, 'Cle introuvable');
      if (current.active) {
        db.prepare('UPDATE device_key SET revoked_at = ?, revoked_by = ? WHERE id = ?').run(now(), actor, id);
        deps.audit(actor, 'device_key_revoked', { details: `cle n°${id} « ${current.label} »` });
      }
      return get(id)!;
    },

    /**
     * Rotation : nouvelle cle, memes equipements ; l'ancienne reste valable `graceMinutes` (0 a 1440, defaut 0) le temps de
     * reconfigurer l'equipement, puis expire d'elle-meme.
     */
    rotate(actor: string, idValue: unknown, input: Record<string, unknown> = {}): DeviceKeyView & { key: string } {
      const id = keyIdOf(idValue);
      const current = get(id);
      if (!current) throw new PsimError(404, 'Cle introuvable');
      if (!current.active) throw new PsimError(409, 'Cle deja revoquee : creez-en une nouvelle');
      const grace = input.graceMinutes === undefined || input.graceMinutes === null ? 0 : Number(input.graceMinutes);
      if (!Number.isInteger(grace) || grace < 0 || grace > 1440) throw new PsimError(400, 'graceMinutes : entier de 0 a 1440');
      return atomically('device_key_rotate', () => {
        const { view: v, key } = issue(actor, current.label, current.devices);
        // Une rotation ne prolonge jamais une cle dont la fin etait deja programmee plus tot.
        const end = Math.min(now() + grace * 60_000, current.revokedAt ?? Number.MAX_SAFE_INTEGER);
        db.prepare('UPDATE device_key SET revoked_at = ?, revoked_by = ?, replaced_by = ? WHERE id = ?').run(end, actor, v.id, id);
        deps.audit(actor, 'device_key_rotated', { details: `cle n°${id} remplacee par la cle n°${v.id}${grace > 0 ? `, ancienne valable encore ${grace} min` : ''}` });
        return { ...v, key };
      });
    },

    /**
     * Controle d'un en-tete `Authorization: Bearer psk_...` pour l'equipement `deviceId`. Ne leve jamais d'exception.
     * Toujours un hachage et une comparaison en temps constant, quelle que soit l'issue (pas d'oracle de duree).
     */
    check(authorization: unknown, deviceId: string): KeyCheck {
      const header = typeof authorization === 'string' ? authorization : '';
      const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!given) return { ok: false, reason: 'absent', keyId: null };
      const m = KEY_PATTERN.exec(given);
      const keyId = m ? Number(m[1]) : null;
      const row = keyId !== null ? (db.prepare('SELECT * FROM device_key WHERE id = ?').get(keyId) as Row | undefined) : undefined;
      const expected = Buffer.from((row?.key_hash as string | undefined) ?? DUMMY_HASH, 'utf8');
      const actual = Buffer.from(sha256hex(given), 'utf8');
      const same = expected.length === actual.length && timingSafeEqual(expected, actual);
      if (!m) return { ok: false, reason: 'malformed', keyId: null };
      if (!row || !same) return { ok: false, reason: 'unknown', keyId };
      const v = view(row, now());
      if (!v.active) return { ok: false, reason: 'revoked', keyId };
      if (!allows(v.devices, deviceId)) return { ok: false, reason: 'scope', keyId };
      db.prepare('UPDATE device_key SET last_used_at = ? WHERE id = ?').run(now(), v.id);
      return { ok: true, keyId: v.id, label: v.label };
    },

    /** L'en-tete presente-t-il une cle par equipement (et non le jeton partage) ? */
    presentsKey(authorization: unknown): boolean {
      return typeof authorization === 'string' && authorization.startsWith('Bearer psk_');
    },
  };
}

export type DeviceKeys = ReturnType<typeof createDeviceKeys>;
