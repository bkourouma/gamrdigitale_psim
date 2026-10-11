import { DatabaseSync } from 'node:sqlite';

/**
 * Donnees du portail.
 *
 * Le portail garde deux choses : le DERNIER instantane de chaque site (etat courant, equipements, disponibilite par zone)
 * et un HISTORIQUE qui s'accumule (un point par jour, les pannes, les incidents). L'instantane d'un site ne couvre que
 * ses 35 derniers jours ; c'est le portail qui conserve ce qui en sort, par remplacement jour par jour.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS organization (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS site (
  id TEXT PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organization(id),
  name TEXT NOT NULL,
  -- La cle de signature du site n'est PAS stockee : elle se derive de la cle maitresse, de l'identifiant et de cette version.
  key_version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_received_at INTEGER
);
-- Groupes de sites d'une organisation (regions, agences, branches) : DEUX niveaux au plus (groupe -> sous-groupe).
-- Un groupe appartient a une seule organisation ; son code est l'identifiant utilise en ligne de commande.
CREATE TABLE IF NOT EXISTS site_group (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organization(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES site_group(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot (
  site_id TEXT PRIMARY KEY REFERENCES site(id) ON DELETE CASCADE,
  generated_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS site_day (
  site_id TEXT NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  pct REAL,
  up_s INTEGER NOT NULL,
  down_s INTEGER NOT NULL,
  unmonitored_s INTEGER NOT NULL,
  PRIMARY KEY (site_id, day)
);
-- Indice de securite GAMR du site, un point par jour (meme principe que site_day : le portail garde ce qui sort de la
-- fenetre de l'instantane).
CREATE TABLE IF NOT EXISTS site_risk_day (
  site_id TEXT NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  idx INTEGER NOT NULL,
  PRIMARY KEY (site_id, day)
);
CREATE TABLE IF NOT EXISTS outage (
  site_id TEXT NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  zone TEXT NOT NULL,
  from_ts INTEGER NOT NULL,
  to_ts INTEGER,
  duration_s INTEGER NOT NULL,
  cause TEXT NOT NULL,
  PRIMARY KEY (site_id, device_id, from_ts)
);
CREATE INDEX IF NOT EXISTS outage_by_site ON outage(site_id, from_ts);
CREATE TABLE IF NOT EXISTS incident (
  site_id TEXT NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  zone TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  qualification TEXT,
  opened_at INTEGER NOT NULL,
  acked_at INTEGER,
  closed_at INTEGER,
  confirmed_at INTEGER,
  PRIMARY KEY (site_id, id)
);
CREATE INDEX IF NOT EXISTS incident_by_site ON incident(site_id, opened_at);
CREATE TABLE IF NOT EXISTS portal_user (
  username TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin', 'director', 'site_manager')),
  -- director : toute son organisation ; site_manager : un seul site ; admin : tout (aucun des deux).
  org_id INTEGER REFERENCES organization(id),
  site_id TEXT REFERENCES site(id),
  display_name TEXT,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  -- Incremente a chaque changement de mot de passe, de role ou de statut : toute session ouverte avant est invalide.
  session_epoch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  CHECK ((role = 'admin' AND org_id IS NULL AND site_id IS NULL) OR (role = 'director' AND org_id IS NOT NULL AND site_id IS NULL) OR (role = 'site_manager' AND site_id IS NOT NULL))
);
-- Directeur limite a certains groupes (ex. directeur regional). Pas de ligne et group_limited = 0 : toute son organisation.
-- Pas de suppression en cascade cote groupe : supprimer un groupe ne doit JAMAIS elargir silencieusement le perimetre d'un compte.
CREATE TABLE IF NOT EXISTS portal_user_group (
  username TEXT NOT NULL REFERENCES portal_user(username) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES site_group(id),
  PRIMARY KEY (username, group_id)
);
-- Seule l'empreinte du jeton est stockee : une copie de la base ne donne aucune session.
CREATE TABLE IF NOT EXISTS session (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL REFERENCES portal_user(username) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT
);
`;

/**
 * Ajouts faits APRES coup sur une base existante (CREATE TABLE IF NOT EXISTS ne modifie pas une table deja la) :
 *   - site.group_id           : groupe du site (NULL = « Sans groupe ») ;
 *   - portal_user.group_limited : 1 = compte limite a des groupes ; sans aucune ligne dans portal_user_group, il ne voit RIEN
 *     (ferme par defaut : jamais « toute l'organisation » par oubli).
 * Idempotent, et atomique (deux processus qui ouvrent la meme base ensemble ne se marchent pas dessus).
 */
const GUARDS = `
-- Un groupe appartient a l'organisation de son parent ; deux niveaux au plus ; pas de boucle.
CREATE TRIGGER IF NOT EXISTS site_group_parent_ins BEFORE INSERT ON site_group
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'un sous-groupe ne peut pas avoir lui-meme de sous-groupe (deux niveaux au plus)') WHERE (SELECT parent_id FROM site_group WHERE id = NEW.parent_id) IS NOT NULL;
  SELECT RAISE(ABORT, 'un sous-groupe doit etre dans la meme organisation que son parent') WHERE (SELECT org_id FROM site_group WHERE id = NEW.parent_id) IS NOT NEW.org_id;
END;
CREATE TRIGGER IF NOT EXISTS site_group_parent_upd BEFORE UPDATE OF parent_id, org_id ON site_group
BEGIN
  SELECT RAISE(ABORT, 'un groupe ne peut pas etre son propre parent') WHERE NEW.parent_id = NEW.id;
  SELECT RAISE(ABORT, 'un sous-groupe ne peut pas avoir lui-meme de sous-groupe (deux niveaux au plus)') WHERE NEW.parent_id IS NOT NULL AND ((SELECT parent_id FROM site_group WHERE id = NEW.parent_id) IS NOT NULL OR EXISTS (SELECT 1 FROM site_group WHERE parent_id = NEW.id));
  SELECT RAISE(ABORT, 'un sous-groupe doit etre dans la meme organisation que son parent') WHERE NEW.parent_id IS NOT NULL AND (SELECT org_id FROM site_group WHERE id = NEW.parent_id) IS NOT NEW.org_id;
END;
-- Un site n'est rattache qu'a un groupe de SA organisation.
CREATE TRIGGER IF NOT EXISTS site_group_org_ins BEFORE INSERT ON site
WHEN NEW.group_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'un site ne peut etre que dans un groupe de sa propre organisation') WHERE (SELECT org_id FROM site_group WHERE id = NEW.group_id) IS NOT NEW.org_id;
END;
CREATE TRIGGER IF NOT EXISTS site_group_org_upd BEFORE UPDATE OF group_id, org_id ON site
WHEN NEW.group_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'un site ne peut etre que dans un groupe de sa propre organisation') WHERE (SELECT org_id FROM site_group WHERE id = NEW.group_id) IS NOT NEW.org_id;
END;
-- Seul un directeur est limite a des groupes, et seulement a ceux de son organisation.
CREATE TRIGGER IF NOT EXISTS portal_user_group_ins BEFORE INSERT ON portal_user_group
BEGIN
  SELECT RAISE(ABORT, 'seul un directeur peut etre limite a des groupes') WHERE (SELECT role FROM portal_user WHERE username = NEW.username) IS NOT 'director';
  SELECT RAISE(ABORT, 'un compte ne peut etre limite qu''a des groupes de son organisation') WHERE (SELECT org_id FROM site_group WHERE id = NEW.group_id) IS NOT (SELECT org_id FROM portal_user WHERE username = NEW.username);
END;
CREATE INDEX IF NOT EXISTS site_by_group ON site(group_id);
CREATE INDEX IF NOT EXISTS site_group_by_parent ON site_group(parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS site_group_name ON site_group(org_id, COALESCE(parent_id, 0), name COLLATE NOCASE);
`;

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

export function migratePortalDb(db: DatabaseSync): { migrated: string[] } {
  const migrated: string[] = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!hasColumn(db, 'site', 'group_id')) {
      db.exec('ALTER TABLE site ADD COLUMN group_id INTEGER REFERENCES site_group(id)');
      migrated.push('site.group_id');
    }
    if (!hasColumn(db, 'portal_user', 'group_limited')) {
      db.exec('ALTER TABLE portal_user ADD COLUMN group_limited INTEGER NOT NULL DEFAULT 0');
      migrated.push('portal_user.group_limited');
    }
    db.exec(GUARDS);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { migrated };
}

export function openPortalDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  // Base deja en service (et non pas creee a l'instant) : la migration est notee dans l'audit.
  const existing = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'site'").get() !== undefined;
  db.exec(SCHEMA);
  const { migrated } = migratePortalDb(db);
  if (existing && migrated.length > 0) writeAudit(db, 'systeme', 'schema_migrated', `groupes : ${migrated.join(', ')}`);
  return db;
}

export function writeAudit(db: DatabaseSync, actor: string, action: string, details?: string, now = Date.now()): void {
  db.prepare('INSERT INTO audit (ts, actor, action, details) VALUES (?, ?, ?, ?)').run(now, actor, action, details ?? null);
}
