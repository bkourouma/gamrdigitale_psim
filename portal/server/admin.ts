/**
 * Administration du portail (organisations, sites, cles) : en ligne de commande uniquement, volontairement. L'interface web
 * reste en lecture seule pour les clients : aucune page d'administration a attaquer depuis internet.
 */
import type { DatabaseSync } from 'node:sqlite';
import { SITE_ID_PATTERN } from '../../server/portal.ts';
import { writeAudit } from './db.ts';
import { siteKey } from './keys.ts';

export function addOrganization(db: DatabaseSync, name: string, now = Date.now()): number {
  const clean = name.trim();
  if (clean.length < 2 || clean.length > 80) throw new Error("nom d'organisation : 2 a 80 caracteres");
  const res = db.prepare('INSERT INTO organization (name) VALUES (?)').run(clean);
  writeAudit(db, 'cli', 'organization_created', clean, now);
  return Number(res.lastInsertRowid);
}

export function organizationId(db: DatabaseSync, name: string): number {
  const row = db.prepare('SELECT id FROM organization WHERE name = ?').get(name.trim()) as { id: number } | undefined;
  if (!row) throw new Error(`organisation introuvable : ${name}`);
  return row.id;
}

export function addSite(db: DatabaseSync, orgName: string, siteId: string, name: string, now = Date.now()): void {
  if (!SITE_ID_PATTERN.test(siteId)) throw new Error('identifiant de site invalide : 3 a 40 caracteres, minuscules, chiffres et tirets (ex. entrepot-kaloum)');
  const clean = name.trim();
  if (clean.length < 2 || clean.length > 80) throw new Error('nom du site : 2 a 80 caracteres');
  db.prepare('INSERT INTO site (id, org_id, name, created_at) VALUES (?, ?, ?, ?)').run(siteId, organizationId(db, orgName), clean, now);
  writeAudit(db, 'cli', 'site_created', `${siteId} (${orgName})`, now);
}

function versionOf(db: DatabaseSync, siteId: string): number {
  const row = db.prepare('SELECT key_version FROM site WHERE id = ?').get(siteId) as { key_version: number } | undefined;
  if (!row) throw new Error(`site introuvable : ${siteId}`);
  return row.key_version;
}

/** Les lignes a copier dans le .env du PSIM de ce site. */
export function siteEnvLines(db: DatabaseSync, master: Buffer, siteId: string, portalUrl: string): string {
  return [`PSIM_PORTAL_URL=${portalUrl.replace(/\/+$/, '')}/api/ingest`, `PSIM_PORTAL_SITE_ID=${siteId}`, `PSIM_PORTAL_KEY=${siteKey(master, siteId, versionOf(db, siteId))}`].join('\n');
}

/** Nouvelle cle pour ce site ; l'ancienne cesse de fonctionner aussitot. */
export function rotateSiteKey(db: DatabaseSync, siteId: string, now = Date.now()): number {
  versionOf(db, siteId);
  db.prepare('UPDATE site SET key_version = key_version + 1 WHERE id = ?').run(siteId);
  writeAudit(db, 'cli', 'site_key_rotated', siteId, now);
  return versionOf(db, siteId);
}

export function setSiteActive(db: DatabaseSync, siteId: string, active: boolean, now = Date.now()): void {
  versionOf(db, siteId);
  db.prepare('UPDATE site SET active = ? WHERE id = ?').run(active ? 1 : 0, siteId);
  writeAudit(db, 'cli', active ? 'site_enabled' : 'site_disabled', siteId, now);
}

export function listAll(db: DatabaseSync): string {
  const lines: string[] = [];
  for (const o of db.prepare('SELECT id, name FROM organization ORDER BY name').all() as { id: number; name: string }[]) {
    lines.push(`Organisation : ${o.name}`);
    for (const s of db.prepare('SELECT id, name, active, last_received_at FROM site WHERE org_id = ? ORDER BY name').all(o.id) as { id: string; name: string; active: number; last_received_at: number | null }[]) {
      const last = s.last_received_at === null ? 'jamais de signal' : `dernier signal ${new Date(s.last_received_at).toLocaleString('fr-FR')}`;
      lines.push(`  site ${s.id} — ${s.name}${s.active ? '' : ' (DESACTIVE)'} — ${last}`);
    }
    for (const u of db.prepare('SELECT username, role, site_id, active FROM portal_user WHERE org_id = ? OR site_id IN (SELECT id FROM site WHERE org_id = ?) ORDER BY username').all(o.id, o.id) as { username: string; role: string; site_id: string | null; active: number }[]) {
      lines.push(`  compte ${u.username} — ${u.role}${u.site_id ? ` (${u.site_id})` : ''}${u.active ? '' : ' (DESACTIVE)'}`);
    }
  }
  for (const u of db.prepare("SELECT username, active FROM portal_user WHERE role = 'admin' ORDER BY username").all() as { username: string; active: number }[]) {
    lines.push(`Administrateur : ${u.username}${u.active ? '' : ' (DESACTIVE)'}`);
  }
  return lines.join('\n') || 'Rien de configure.';
}
