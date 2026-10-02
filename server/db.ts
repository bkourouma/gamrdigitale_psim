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
  last_seen INTEGER,
  state_since INTEGER
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
  closed_by TEXT,
  confirmed_at INTEGER,
  confirmation_reason TEXT,
  hint TEXT,
  hint_details TEXT
);
-- Un seul incident non cloture par detecteur : garanti par la base, pas seulement par le code.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_incident_per_detector
  ON incident(detector_id) WHERE status <> 'closed';
-- Images des cameras liees, prises a l'ouverture / l'aggravation / la confirmation d'un incident.
CREATE TABLE IF NOT EXISTS incident_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incident(id),
  camera_id TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  file TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshot_by_incident ON incident_snapshot(incident_id);
-- Journal des notifications envoyees (e-mail, Telegram, webhook) et de leur escalade.
CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER,
  kind TEXT NOT NULL,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  level INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notification_by_incident ON notification_log(incident_id, created_at);
-- Evaluation de risque par zone (saisie) ; les valeurs calculees ne sont pas stockees, sauf l'historique.
CREATE TABLE IF NOT EXISTS risk_zone (
  zone TEXT PRIMARY KEY,
  probability INTEGER NOT NULL CHECK (probability BETWEEN 1 AND 3),
  defenses TEXT NOT NULL DEFAULT '[]',
  impact_image INTEGER NOT NULL CHECK (impact_image BETWEEN 1 AND 5),
  impact_economy INTEGER NOT NULL CHECK (impact_economy BETWEEN 1 AND 5),
  impact_human INTEGER NOT NULL CHECK (impact_human BETWEEN 1 AND 5),
  notes TEXT NOT NULL DEFAULT '',
  assessed_by TEXT NOT NULL,
  assessed_at INTEGER NOT NULL
);
-- Un point par jour et par zone (zone vide = indice du site) pour les tendances.
CREATE TABLE IF NOT EXISTS risk_history (
  day TEXT NOT NULL,
  zone TEXT NOT NULL,
  probability INTEGER NOT NULL,
  vulnerability INTEGER NOT NULL,
  impact INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  PRIMARY KEY (day, zone)
);
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

/** Colonnes ajoutees apres la premiere version : `CREATE TABLE IF NOT EXISTS` ne modifie pas une table existante. */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'device', column: 'state_since', definition: 'INTEGER' },
  { table: 'incident', column: 'confirmed_at', definition: 'INTEGER' },
  { table: 'incident', column: 'confirmation_reason', definition: 'TEXT' },
  { table: 'incident', column: 'hint', definition: 'TEXT' },
  { table: 'incident', column: 'hint_details', definition: 'TEXT' },
];

function migrate(db: DatabaseSync): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!existing.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db); // les donnees existantes sont conservees
  return db;
}
