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

// ---------------------------------------------------------------- groupes (regions, agences, branches)

/** Meme forme que l'identifiant d'un site : minuscules, chiffres et tirets, 3 a 40 caracteres. */
export const GROUP_CODE_PATTERN = SITE_ID_PATTERN;

interface GroupInfo {
  id: number;
  org_id: number;
  code: string;
  name: string;
  parent_id: number | null;
}

function groupByCode(db: DatabaseSync, code: string): GroupInfo {
  const row = db.prepare('SELECT id, org_id, code, name, parent_id FROM site_group WHERE code = ?').get(code.trim()) as GroupInfo | undefined;
  if (!row) throw new Error(`groupe introuvable : ${code} (voir « list » pour les codes)`);
  return row;
}

/** Id des groupes designes par leurs codes, dans la meme organisation. */
export function groupIdsByCodes(db: DatabaseSync, codes: string[]): number[] {
  const ids = codes.map((c) => groupByCode(db, c).id);
  return [...new Set(ids)];
}

function cleanGroupName(name: string): string {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (clean.length < 2 || clean.length > 80) throw new Error('nom du groupe : 2 a 80 caracteres');
  if (/[\u0000-\u001f\u007f]/.test(clean)) throw new Error('nom du groupe : caracteres de controle interdits');
  return clean;
}

/**
 * Cree un groupe dans une organisation, ou un sous-groupe sous `parentCode` (deux niveaux au plus ; l'organisation est alors
 * celle du parent).
 */
export function addGroup(db: DatabaseSync, orgName: string | null, code: string, name: string, parentCode: string | null = null, now = Date.now()): number {
  if (!GROUP_CODE_PATTERN.test(code)) throw new Error('code de groupe invalide : 3 a 40 caracteres, minuscules, chiffres et tirets (ex. region-nord)');
  const clean = cleanGroupName(name);
  let orgId: number;
  let parentId: number | null = null;
  if (parentCode) {
    const parent = groupByCode(db, parentCode);
    if (parent.parent_id !== null) throw new Error(`« ${parent.name} » est deja un sous-groupe : deux niveaux au plus (groupe puis sous-groupe)`);
    orgId = parent.org_id;
    parentId = parent.id;
    if (orgName && organizationId(db, orgName) !== orgId) throw new Error("le groupe parent n'appartient pas a cette organisation");
  } else {
    if (!orgName) throw new Error('indiquer l\'organisation : --org <organisation>');
    orgId = organizationId(db, orgName);
  }
  if (db.prepare('SELECT 1 FROM site_group WHERE code = ?').get(code)) throw new Error(`le code « ${code} » est deja utilise`);
  try {
    const res = db.prepare('INSERT INTO site_group (org_id, code, name, parent_id, created_at) VALUES (?, ?, ?, ?, ?)').run(orgId, code, clean, parentId, now);
    writeAudit(db, 'cli', 'group_created', `${code} (${clean})${parentCode ? ` sous ${parentCode}` : ''} dans l'organisation ${orgId}`, now);
    return Number(res.lastInsertRowid);
  } catch (err) {
    if (/UNIQUE/i.test((err as Error).message)) throw new Error(`un groupe nomme « ${clean} » existe deja ${parentCode ? 'dans ce groupe' : 'dans cette organisation'}`);
    throw err;
  }
}

export function renameGroup(db: DatabaseSync, code: string, newName: string, now = Date.now()): void {
  const group = groupByCode(db, code);
  const clean = cleanGroupName(newName);
  try {
    db.prepare('UPDATE site_group SET name = ? WHERE id = ?').run(clean, group.id);
  } catch (err) {
    if (/UNIQUE/i.test((err as Error).message)) throw new Error(`un groupe nomme « ${clean} » existe deja au meme niveau`);
    throw err;
  }
  writeAudit(db, 'cli', 'group_renamed', `${group.code} : « ${group.name} » -> « ${clean} »`, now);
}

/**
 * Supprime un groupe VIDE. Refuse s'il contient des sites (meme desactives), des sous-groupes ou s'il limite des comptes :
 * le supprimer elargirait leur perimetre a toute l'organisation, jamais en silence.
 */
export function removeGroup(db: DatabaseSync, code: string, now = Date.now()): void {
  const group = groupByCode(db, code);
  const sites = db.prepare('SELECT id FROM site WHERE group_id = ? ORDER BY id').all(group.id) as { id: string }[];
  if (sites.length > 0) throw new Error(`groupe non vide : ${sites.length} site(s) (${sites.slice(0, 5).map((s) => s.id).join(', ')}${sites.length > 5 ? ', ...' : ''}) ; les deplacer d'abord (assign-site) ou les retirer du groupe (unassign-site)`);
  const children = db.prepare('SELECT code FROM site_group WHERE parent_id = ? ORDER BY code').all(group.id) as { code: string }[];
  if (children.length > 0) throw new Error(`groupe non vide : ${children.length} sous-groupe(s) (${children.map((c) => c.code).join(', ')}) ; les supprimer d'abord`);
  const users = db.prepare('SELECT username FROM portal_user_group WHERE group_id = ? ORDER BY username').all(group.id) as { username: string }[];
  if (users.length > 0) throw new Error(`groupe utilise par ${users.length} compte(s) limite(s) (${users.map((u) => u.username).join(', ')}) ; changer ou lever leur limite d'abord (limit-user / unlimit-user)`);
  db.prepare('DELETE FROM site_group WHERE id = ?').run(group.id);
  writeAudit(db, 'cli', 'group_removed', `${group.code} (${group.name})`, now);
}

/** Range un site dans un groupe de sa propre organisation, ou le sort de tout groupe (`null` : « Sans groupe »). */
export function assignSite(db: DatabaseSync, siteId: string, groupCode: string | null, now = Date.now()): void {
  const site = db.prepare('SELECT id, org_id, group_id FROM site WHERE id = ?').get(siteId) as { id: string; org_id: number; group_id: number | null } | undefined;
  if (!site) throw new Error(`site introuvable : ${siteId}`);
  let target: GroupInfo | null = null;
  if (groupCode !== null) {
    target = groupByCode(db, groupCode);
    if (target.org_id !== site.org_id) throw new Error('le site et le groupe doivent appartenir a la meme organisation');
  }
  const before = site.group_id === null ? null : (db.prepare('SELECT code FROM site_group WHERE id = ?').get(site.group_id) as { code: string } | undefined)?.code ?? null;
  db.prepare('UPDATE site SET group_id = ? WHERE id = ?').run(target?.id ?? null, siteId);
  writeAudit(db, 'cli', target ? 'site_group_assigned' : 'site_group_cleared', `${siteId} : ${before ?? 'sans groupe'} -> ${target?.code ?? 'sans groupe'}`, now);
}

/**
 * Limite un directeur a ces groupes (remplace sa limite precedente). Immediat : le perimetre est relu a chaque requete.
 * Des groupes de plusieurs organisations, ou un compte qui n'est pas directeur : refuse.
 */
export function limitUser(db: DatabaseSync, username: string, codes: string[], now = Date.now()): void {
  const user = db.prepare('SELECT role, org_id FROM portal_user WHERE username = ?').get(username) as { role: string; org_id: number | null } | undefined;
  if (!user) throw new Error('compte introuvable');
  if (user.role !== 'director') throw new Error('seul un directeur (role director) peut etre limite a des groupes');
  if (codes.length === 0) throw new Error('indiquer au moins un groupe (ou unlimit-user pour lever la limite)');
  const ids = groupIdsByCodes(db, codes);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM portal_user_group WHERE username = ?').run(username);
    for (const id of ids) db.prepare('INSERT INTO portal_user_group (username, group_id) VALUES (?, ?)').run(username, id);
    db.prepare('UPDATE portal_user SET group_limited = 1 WHERE username = ?').run(username);
    writeAudit(db, 'cli', 'user_limited', `${username} : ${[...new Set(codes)].join(', ')}`, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Leve la limite : le directeur revoit toute son organisation (y compris les sites sans groupe). */
export function unlimitUser(db: DatabaseSync, username: string, now = Date.now()): void {
  const user = db.prepare('SELECT role FROM portal_user WHERE username = ?').get(username) as { role: string } | undefined;
  if (!user) throw new Error('compte introuvable');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM portal_user_group WHERE username = ?').run(username);
    db.prepare('UPDATE portal_user SET group_limited = 0 WHERE username = ?').run(username);
    writeAudit(db, 'cli', 'user_unlimited', username, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listAll(db: DatabaseSync): string {
  const lines: string[] = [];
  const limits = new Map<string, string[]>();
  for (const l of db.prepare('SELECT ug.username, g.code FROM portal_user_group ug JOIN site_group g ON g.id = ug.group_id ORDER BY g.code').all() as { username: string; code: string }[]) limits.set(l.username, [...(limits.get(l.username) ?? []), l.code]);
  for (const o of db.prepare('SELECT id, name FROM organization ORDER BY name').all() as { id: number; name: string }[]) {
    lines.push(`Organisation : ${o.name}`);
    const siteLine = (s: { id: string; name: string; active: number; last_received_at: number | null }, indent: string) => {
      const last = s.last_received_at === null ? 'jamais de signal' : `dernier signal ${new Date(s.last_received_at).toLocaleString('fr-FR')}`;
      return `${indent}site ${s.id} — ${s.name}${s.active ? '' : ' (DESACTIVE)'} — ${last}`;
    };
    const sitesOf = (groupId: number | null) =>
      (groupId === null
        ? db.prepare('SELECT id, name, active, last_received_at FROM site WHERE org_id = ? AND group_id IS NULL ORDER BY name').all(o.id)
        : db.prepare('SELECT id, name, active, last_received_at FROM site WHERE org_id = ? AND group_id = ? ORDER BY name').all(o.id, groupId)) as { id: string; name: string; active: number; last_received_at: number | null }[];
    const groups = db.prepare('SELECT id, code, name, parent_id FROM site_group WHERE org_id = ? ORDER BY name').all(o.id) as { id: number; code: string; name: string; parent_id: number | null }[];
    const printGroup = (g: (typeof groups)[number], indent: string) => {
      lines.push(`${indent}groupe ${g.code} — ${g.name}`);
      for (const s of sitesOf(g.id)) lines.push(siteLine(s, `${indent}  `));
      for (const child of groups.filter((c) => c.parent_id === g.id)) printGroup(child, `${indent}  `);
    };
    for (const g of groups.filter((g) => g.parent_id === null)) printGroup(g, '  ');
    const loose = sitesOf(null);
    if (loose.length > 0 && groups.length > 0) lines.push('  sans groupe :');
    for (const s of loose) lines.push(siteLine(s, groups.length > 0 ? '    ' : '  '));
    for (const u of db.prepare('SELECT username, role, site_id, active, group_limited FROM portal_user WHERE org_id = ? OR site_id IN (SELECT id FROM site WHERE org_id = ?) ORDER BY username').all(o.id, o.id) as { username: string; role: string; site_id: string | null; active: number; group_limited: number }[]) {
      const limit = limits.get(u.username);
      const scope = limit ? ` (limite a : ${limit.join(', ')})` : u.group_limited ? ' (limite, AUCUN groupe : ne voit rien)' : '';
      lines.push(`  compte ${u.username} — ${u.role}${u.site_id ? ` (${u.site_id})` : ''}${scope}${u.active ? '' : ' (DESACTIVE)'}`);
    }
  }
  for (const u of db.prepare("SELECT username, active FROM portal_user WHERE role = 'admin' ORDER BY username").all() as { username: string; active: number }[]) {
    lines.push(`Administrateur : ${u.username}${u.active ? '' : ' (DESACTIVE)'}`);
  }
  return lines.join('\n') || 'Rien de configure.';
}
