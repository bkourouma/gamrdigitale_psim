import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS site (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  plan_file TEXT,
  plan_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS device (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('detector', 'camera')),
  name TEXT NOT NULL,
  zone TEXT NOT NULL DEFAULT '',
  x REAL NOT NULL DEFAULT 50,
  y REAL NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'normal',
  stream_kind TEXT,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS device_link (
  detector_id TEXT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  camera_id TEXT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  PRIMARY KEY (detector_id, camera_id)
);
-- Source video reelle d'une camera. Pas de ligne = camera simulee.
-- Le mot de passe est chiffre (AES-256-GCM, cle hors base) : voir server/secrets.ts.
CREATE TABLE IF NOT EXISTS camera_source (
  device_id TEXT PRIMARY KEY REFERENCES device(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('onvif', 'rtsp')),
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  rtsp_path TEXT,
  username TEXT,
  secret TEXT
);
CREATE TABLE IF NOT EXISTS incident (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  detector_id TEXT NOT NULL REFERENCES device(id),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'closed')),
  qualification TEXT CHECK (qualification IN ('fire', 'false_alarm')),
  comment TEXT,
  opened_at INTEGER NOT NULL,
  acked_at INTEGER,
  acked_by TEXT,
  closed_at INTEGER,
  closed_by TEXT
);
-- Un seul incident non cloture par detecteur : garanti par la base, pas seulement par le code.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_incident_per_detector
  ON incident(detector_id) WHERE status <> 'closed';
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  incident_id INTEGER,
  device_id TEXT,
  details TEXT
);
CREATE TABLE IF NOT EXISTS app_user (
  username TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('operator', 'admin')),
  salt TEXT NOT NULL,
  hash TEXT NOT NULL
);
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}
