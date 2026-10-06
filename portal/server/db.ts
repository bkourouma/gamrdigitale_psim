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

export function openPortalDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function writeAudit(db: DatabaseSync, actor: string, action: string, details?: string, now = Date.now()): void {
  db.prepare('INSERT INTO audit (ts, actor, action, details) VALUES (?, ?, ?, ?)').run(now, actor, action, details ?? null);
}
