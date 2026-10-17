import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import { checkCredentials, createSession, principalFor, visibleGroups, visibleSites } from '../../portal/server/accounts.ts';
import { addGroup, assignSite, limitUser } from '../../portal/server/admin.ts';
import { openPortalDb } from '../../portal/server/db.ts';
import { storeSummary } from '../../portal/server/ingest.ts';
import { groupsOverview } from '../../portal/server/groupviews.ts';
import { siteCards } from '../../portal/server/views.ts';
import { NOW, PASSWORD, addUser, makeSummary } from './helpers.ts';

/** Le schema exact du portail AVANT les groupes (copie de la version precedente de db.ts). */
const OLD_SCHEMA = readFileSync(join(import.meta.dirname, 'fixtures', 'schema-avant-groupes.sql'), 'utf8');

const dir = mkdtempSync(join(tmpdir(), 'portail-migration-'));
after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // fichier encore ouvert par un test en echec : le dossier temporaire sera nettoye par le systeme
  }
});

/** Une base « en service » telle qu'elle etait avant : organisations, sites avec leurs donnees, comptes, session, journal. */
function oldDatabase(file: string): { token: string } {
  // Les mots de passe sont hashes comme le fait le portail : on les prend d'une base neuve et on les copie.
  const donor = openPortalDb(':memory:');
  addUser(donor, { username: 'admin-ancien', role: 'admin' });
  const org = donor.prepare("INSERT INTO organization (name) VALUES ('Ancien client')").run();
  addUser(donor, { username: 'directeur-ancien', role: 'director', orgId: Number(org.lastInsertRowid) });
  const users = donor.prepare('SELECT * FROM portal_user').all() as Record<string, any>[];

  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(OLD_SCHEMA);
  db.prepare("INSERT INTO organization (id, name) VALUES (1, 'Ancien client')").run();
  for (const [id, name] of [['site-un', 'Site Un'], ['site-deux', 'Site Deux']]) db.prepare('INSERT INTO site (id, org_id, name, key_version, active, created_at, last_received_at) VALUES (?, 1, ?, 3, 1, ?, ?)').run(id, name, NOW - 1000, NOW);
  db.prepare("INSERT INTO site (id, org_id, name, key_version, active, created_at) VALUES ('site-ferme', 1, 'Site ferme', 1, 0, ?)").run(NOW);
  for (const id of ['site-un', 'site-deux']) {
    const summary = makeSummary(id, { risk: true });
    db.prepare('INSERT INTO snapshot (site_id, generated_at, received_at, payload) VALUES (?, ?, ?, ?)').run(id, summary.generatedAt, NOW, JSON.stringify(summary));
    db.prepare("INSERT INTO site_day (site_id, day, pct, up_s, down_s, unmonitored_s) VALUES (?, '2026-06-14', 99.5, 86000, 400, 0)").run(id);
    db.prepare("INSERT INTO site_risk_day (site_id, day, idx) VALUES (?, '2026-06-14', 24)").run(id);
    db.prepare("INSERT INTO outage (site_id, device_id, device_name, zone, from_ts, to_ts, duration_s, cause) VALUES (?, 'D-01', 'Detecteur', 'Zone', ?, ?, 400, 'fault')").run(id, NOW - 5000, NOW - 4600);
    db.prepare("INSERT INTO incident (site_id, id, device_id, device_name, zone, category, severity, status, opened_at) VALUES (?, 1, 'D-01', 'Detecteur', 'Zone', 'fire', 'critical', 'open', ?)").run(id, NOW - 3000);
  }
  for (const u of users) {
    const org1 = u.role === 'director' ? 1 : null;
    db.prepare('INSERT INTO portal_user (username, role, org_id, site_id, display_name, salt, hash, active, must_change_password, session_epoch, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, 1, 0, 0, ?)').run(u.username, u.role, org1, u.display_name, u.salt, u.hash, NOW);
  }
  db.prepare("INSERT INTO portal_user (username, role, org_id, site_id, display_name, salt, hash, active, must_change_password, session_epoch, created_at) SELECT 'resp-ancien', 'site_manager', NULL, 'site-un', 'Resp', salt, hash, 1, 0, 0, ? FROM portal_user WHERE username = 'admin-ancien'").run(NOW);
  db.prepare("INSERT INTO audit (ts, actor, action, details) VALUES (?, 'cli', 'site_created', 'site-un (Ancien client)')").run(NOW);
  // Une session ouverte avant la mise a jour : elle doit survivre.
  const token = 'c'.repeat(64);
  db.prepare("INSERT INTO session (token_hash, username, epoch, expires_at) VALUES (?, 'directeur-ancien', 0, ?)").run(createHash('sha256').update(token).digest('hex'), NOW + 3_600_000);
  db.close();
  return { token };
}

const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const columns = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe('migration d une base anterieure aux groupes', () => {
  const file = join(dir, 'ancienne.db');
  const { token } = oldDatabase(file);

  it('la base de depart n a ni groupe ni limite (le test part bien d une ancienne base)', () => {
    const raw = new DatabaseSync(file);
    assert.ok(!columns(raw, 'site').includes('group_id'));
    assert.ok(!columns(raw, 'portal_user').includes('group_limited'));
    assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'site_group'").get(), undefined);
    raw.close();
  });

  it('s ouvre sans erreur, ajoute les colonnes et les tables, et ne perd AUCUNE donnee', () => {
    const before = new DatabaseSync(file);
    const sizes: Record<string, number> = {};
    for (const t of ['organization', 'site', 'snapshot', 'site_day', 'site_risk_day', 'outage', 'incident', 'portal_user', 'session', 'audit']) sizes[t] = count(before, t);
    const plain = (rows: unknown[]) => JSON.parse(JSON.stringify(rows));
    const sites = plain(before.prepare('SELECT * FROM site ORDER BY id').all());
    const users = plain(before.prepare('SELECT username, role, org_id, site_id, display_name, salt, hash, active, must_change_password, session_epoch FROM portal_user ORDER BY username').all());
    const payloads = plain(before.prepare('SELECT site_id, payload FROM snapshot ORDER BY site_id').all());
    before.close();

    const db = openPortalDb(file);
    assert.ok(columns(db, 'site').includes('group_id'));
    assert.ok(columns(db, 'portal_user').includes('group_limited'));
    for (const t of ['site_group', 'portal_user_group']) assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(t), t);
    for (const [t, n] of Object.entries(sizes)) assert.equal(count(db, t), t === 'audit' ? n + 1 : n, `${t} : meme nombre de lignes (le journal gagne la ligne de migration)`);

    const sitesAfter = db.prepare('SELECT * FROM site ORDER BY id').all() as Record<string, any>[];
    assert.deepEqual(plain(sitesAfter.map(({ group_id, ...rest }) => rest)), sites, 'les sites sont inchanges');
    assert.ok(sitesAfter.every((s) => s.group_id === null), 'aucun site n est range : tous « Sans groupe »');
    const usersAfter = plain(db.prepare('SELECT username, role, org_id, site_id, display_name, salt, hash, active, must_change_password, session_epoch FROM portal_user ORDER BY username').all());
    assert.deepEqual(usersAfter, users, 'comptes, mots de passe et periodes de session inchanges');
    assert.ok((db.prepare('SELECT group_limited FROM portal_user').all() as { group_limited: number }[]).every((u) => u.group_limited === 0), 'aucun compte n est limite');
    assert.deepEqual(plain(db.prepare('SELECT site_id, payload FROM snapshot ORDER BY site_id').all()), payloads);
    db.close();
  });

  it('note la migration dans le journal, une seule fois', () => {
    const db = openPortalDb(file);
    const lines = db.prepare("SELECT actor, details FROM audit WHERE action = 'schema_migrated'").all() as { actor: string; details: string }[];
    assert.equal(lines.length, 1);
    assert.match(lines[0].details, /site\.group_id.*portal_user\.group_limited/);
    db.close();
  });

  it('est idempotente : l ouvrir de nouveau (ou plusieurs fois de suite) ne change rien et ne leve rien', () => {
    const a = openPortalDb(file);
    const sizes = ['site', 'portal_user', 'audit', 'site_group'].map((t) => count(a, t));
    const b = openPortalDb(file); // deux ouvertures en meme temps : le portail et la ligne de commande
    assert.deepEqual(['site', 'portal_user', 'audit', 'site_group'].map((t) => count(b, t)), sizes);
    a.close();
    b.close();
    const c = openPortalDb(file);
    assert.deepEqual(['site', 'portal_user', 'audit', 'site_group'].map((t) => count(c, t)), sizes);
    c.close();
  });

  it('les comptes existants voient exactement ce qu ils voyaient : directeur = organisation, responsable = son site, session ouverte conservee', () => {
    const db = openPortalDb(file);
    const dir1 = principalFor(db, token, NOW)!;
    assert.equal(dir1.username, 'directeur-ancien');
    assert.equal(dir1.groupScope, null, 'pas de limite de groupe');
    assert.deepEqual(visibleSites(db, dir1).map((s) => s.id), ['site-deux', 'site-un'], 'le site desactive reste cache');
    assert.deepEqual(visibleGroups(db, dir1), []);
    const login = checkCredentials(db, 'directeur-ancien', PASSWORD);
    assert.ok(login, 'son mot de passe fonctionne toujours');
    const manager = principalFor(db, createSession(db, 'resp-ancien', 0, NOW), NOW)!;
    assert.deepEqual(visibleSites(db, manager).map((s) => s.id), ['site-un']);
    const admin = principalFor(db, createSession(db, 'admin-ancien', 0, NOW), NOW)!;
    assert.deepEqual(visibleSites(db, admin).map((s) => s.id), ['site-deux', 'site-un']);
    // Les ecrans d avant : cartes, et le tableau des groupes est simplement vide.
    const cards = siteCards(db, visibleSites(db, dir1), NOW, 900_000);
    assert.deepEqual(cards.map((c) => c.groupId), [null, null]);
    assert.deepEqual(cards.map((c) => c.id).sort(), ['site-deux', 'site-un']);
    const overview = groupsOverview(db, dir1, NOW, 900_000);
    assert.equal(overview.hasGroups, false);
    assert.equal(overview.organizations[0].ungrouped?.siteIds.length, 2);
    assert.equal(overview.organizations[0].stats.sites, 2);
    db.close();
  });

  it('la base migree accepte ensuite groupes, rattachements et limites, et un nouvel envoi d un site', () => {
    const db = openPortalDb(file);
    addGroup(db, 'Ancien client', 'region-test', 'Région test', null, NOW);
    assignSite(db, 'site-un', 'region-test', NOW);
    addUser(db, { username: 'dir-regional', role: 'director', orgId: 1 });
    limitUser(db, 'dir-regional', ['region-test'], NOW);
    const p = principalFor(db, createSession(db, 'dir-regional', 0, NOW), NOW)!;
    assert.deepEqual(visibleSites(db, p).map((s) => s.id), ['site-un']);
    assert.equal(storeSummary(db, 'site-deux', makeSummary('site-deux', { at: NOW + 1000, risk: true }), NOW + 1000), 'stored');
    db.close();
  });
});
