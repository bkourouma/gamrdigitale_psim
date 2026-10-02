import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createUser } from './auth.ts';

interface SeedDevice {
  id: string;
  kind: 'detector' | 'camera';
  name: string;
  zone: string;
  x: number; // en % du plan (plan demo : 1000 x 600)
  y: number;
}

const pct = (px: number, total: number) => Math.round((px / total) * 1000) / 10;
const at = (x: number, y: number) => ({ x: pct(x, 1000), y: pct(y, 600) });

export const DEMO_DEVICES: SeedDevice[] = [
  { id: 'D-01', kind: 'detector', name: 'Detecteur accueil', zone: 'Accueil', ...at(170, 150) },
  { id: 'D-02', kind: 'detector', name: 'Detecteur bureaux', zone: 'Bureaux', ...at(460, 150) },
  { id: 'D-03', kind: 'detector', name: 'Detecteur salle serveurs', zone: 'Salle serveurs', ...at(790, 150) },
  { id: 'D-04', kind: 'detector', name: 'Detecteur couloir', zone: 'Couloir', ...at(500, 300) },
  { id: 'D-05', kind: 'detector', name: 'Detecteur entrepot', zone: 'Entrepot', ...at(270, 450) },
  { id: 'D-06', kind: 'detector', name: 'Detecteur atelier', zone: 'Atelier', ...at(640, 450) },
  { id: 'D-07', kind: 'detector', name: 'Detecteur stockage', zone: 'Stockage', ...at(870, 450) },
  { id: 'C-01', kind: 'camera', name: 'Camera accueil', zone: 'Accueil', ...at(90, 90) },
  { id: 'C-02', kind: 'camera', name: 'Camera couloir', zone: 'Couloir', ...at(150, 300) },
  { id: 'C-03', kind: 'camera', name: 'Camera serveurs', zone: 'Salle serveurs', ...at(920, 90) },
  { id: 'C-04', kind: 'camera', name: 'Camera entrepot', zone: 'Entrepot', ...at(70, 530) },
  { id: 'C-05', kind: 'camera', name: 'Camera atelier', zone: 'Atelier', ...at(750, 370) },
];

export const DEMO_LINKS: Record<string, string[]> = {
  'D-01': ['C-01', 'C-02'],
  'D-02': ['C-02'],
  'D-03': ['C-03', 'C-02'],
  'D-04': ['C-02', 'C-01'],
  'D-05': ['C-04'],
  'D-06': ['C-05', 'C-04'],
  'D-07': ['C-05'],
};

/** Ne fait rien si la base contient deja un site : ne jamais ecraser des donnees existantes. */
export function seedDemo(db: DatabaseSync, dataDir: string, seedDir: string): boolean {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM site').get() as { n: number };
  if (existing.n > 0) return false;

  mkdirSync(dataDir, { recursive: true });
  const planFile = 'plan-0.svg';
  copyFileSync(join(seedDir, 'plan-demo.svg'), join(dataDir, planFile));

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO site (id, name, plan_file, plan_version) VALUES (1, ?, ?, 0)').run('Site de demonstration', planFile);
    const insertDevice = db.prepare(
      'INSERT INTO device (id, kind, name, zone, x, y, stream_kind) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const d of DEMO_DEVICES) {
      insertDevice.run(d.id, d.kind, d.name, d.zone, d.x, d.y, d.kind === 'camera' ? 'simulated' : null);
    }
    const insertLink = db.prepare('INSERT INTO device_link (detector_id, camera_id) VALUES (?, ?)');
    for (const [detectorId, cameraIds] of Object.entries(DEMO_LINKS)) {
      for (const cameraId of cameraIds) insertLink.run(detectorId, cameraId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return true;
}

export function seedUsers(db: DatabaseSync, adminPassword: string, operatorPassword: string): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM app_user').get() as { n: number };
  if (existing.n > 0) return;
  createUser(db, 'admin', 'admin', adminPassword);
  createUser(db, 'operateur', 'operator', operatorPassword);
}
