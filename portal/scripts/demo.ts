/**
 * Portail de demonstration : npm run portal:demo
 *
 * Cree une base VIERGE (portal-demo-data/, recreee a chaque lancement) avec deux clients, cinq sites a des etats differents
 * et un historique de 35 jours produit par le vrai moteur du PSIM, puis sert le portail sur http://127.0.0.1:4301.
 * Comptes : prestataire, diallo (direction), kaloum (responsable d'un site), autre (autre client) ; mot de passe : voir la sortie.
 * Rien n'est ecrit dans portal-data/ : la demo ne touche pas a une vraie installation.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createUser } from '../server/accounts.ts';
import { addOrganization, addSite } from '../server/admin.ts';
import { createPortalApp } from '../server/api.ts';
import { openPortalDb } from '../server/db.ts';
import { storeSummary } from '../server/ingest.ts';
import { openDb } from '../../server/db.ts';
import { createEngine } from '../../server/engine.ts';
import { beginHistory, recordState } from '../../server/history.ts';
import { buildSiteSummary } from '../../server/portal.ts';
import type { SiteSummary } from '../../server/portal.ts';
import { seedDemo } from '../../server/seed.ts';

const root = resolve(import.meta.dirname, '..', '..');
const PASSWORD = 'Demo-portail-2026-x';
const HOUR = 3_600_000;
const MIN = 60_000;
const now = Date.now();

/** Generateur pseudo-aleatoire a graine : la demo est la meme a chaque lancement. */
function prng(seed: number) {
  let x = seed;
  return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

interface Plan {
  /** Cameras reelles, mesurees par test de connexion depuis le debut (les autres restent simulees, « non mesurees »). */
  cameras?: string[];
  /** Pannes passees : [il y a N heures, duree en minutes, equipement (detecteur ou camera mesuree), etat]. */
  outages: [number, number, string, 'fault' | 'offline'][];
  /** Incidents passes : [il y a N heures, detecteur, qualification]. */
  incidents: [number, string, 'fire' | 'false_alarm'][];
  /** Etat actuel : detecteur -> [etat, depuis N minutes]. */
  now?: Record<string, ['fault' | 'offline' | 'alarm' | 'prealarm', number]>;
  /** Le site s'est tu il y a N minutes (resume date d'alors). */
  silentFor?: number;
  /** Periode d'arret du PSIM : [il y a N heures, duree en minutes]. */
  blind?: [number, number][];
}

function simulate(siteId: string, plan: Plan, seed: number): { summary: SiteSummary; at: number } {
  const at = now - (plan.silentFor ?? 0) * MIN;
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-demo-')), join(root, 'seed'));
  let clock = at - 36 * 24 * HOUR;
  const engine = createEngine(db, () => {}, () => clock, { silentTimeoutMs: 0 });
  beginHistory(db, clock, null, null);
  for (const id of plan.cameras ?? []) {
    db.prepare("INSERT INTO camera_source (device_id, kind, host, port) VALUES (?, 'rtsp', '192.0.2.10', 554)").run(id);
    recordState(db, id, 'normal', clock);
  }
  const random = prng(seed);

  type Ev = { t: number; run: () => void };
  const events: Ev[] = [];
  const setState = (id: string, state: string) => () => {
    // Camera : seul son historique change (voir camerahealth.ts : l'ecran du PSIM n'est pas modifie).
    if (plan.cameras?.includes(id)) recordState(db, id, state, clock);
    else if (state === 'offline') {
      db.prepare("UPDATE device SET status = 'offline', state_since = ? WHERE id = ?").run(clock, id);
      recordState(db, id, 'offline', clock);
    } else engine.handleDetectorMessage(id, { state });
  };
  for (const [ago, minutes, id, state] of plan.outages) {
    events.push({ t: at - ago * HOUR, run: setState(id, state) }, { t: at - ago * HOUR + minutes * MIN, run: setState(id, 'normal') });
  }
  for (const [ago, id, qualification] of plan.incidents) {
    const open = at - ago * HOUR;
    let incidentId = 0;
    events.push(
      { t: open, run: () => (engine.handleDetectorMessage(id, { state: 'alarm' }), (incidentId = engine.getSnapshot().incidents.find((i) => i.detectorId === id && i.status !== 'closed')!.id)) },
      { t: open + Math.round((1 + random() * 6) * MIN), run: () => engine.acknowledge(incidentId, 'gardien') },
      { t: open + Math.round((8 + random() * 10) * MIN), run: () => engine.handleDetectorMessage(id, { state: 'normal' }) },
      { t: open + Math.round((20 + random() * 25) * MIN), run: () => engine.close(incidentId, 'gardien', qualification, null) },
    );
  }
  for (const [id, [state, minutes]] of Object.entries(plan.now ?? {})) events.push({ t: at - minutes * MIN, run: setState(id, state) });
  // Arret du PSIM : il redemarre N minutes apres son dernier signe de vie (voir history.ts : le trou n'est ni disponible ni indisponible).
  for (const [ago, minutes] of plan.blind ?? []) {
    const restart = at - ago * HOUR + minutes * MIN;
    events.push({ t: restart, run: () => beginHistory(db, restart, restart - minutes * MIN, { from: restart - minutes * MIN, to: restart, clean: false }) });
  }
  events.sort((a, b) => a.t - b.t);
  for (const e of events) {
    clock = e.t;
    e.run();
  }
  clock = at;
  return { summary: buildSiteSummary(db, { siteId, version: '0.1.0', startedAt: at - 3 * 24 * HOUR, now: at }), at };
}

const dataDir = join(root, 'portal-demo-data');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const db = openPortalDb(join(dataDir, 'portal.db'));

addOrganization(db, 'Groupe Diallo');
addOrganization(db, 'Maison Camara');
const SITES: { org: string; id: string; name: string; plan: Plan; seed: number }[] = [
  {
    org: 'Groupe Diallo', id: 'entrepot-kaloum', name: 'Entrepôt Kaloum', seed: 11,
    plan: {
      cameras: ['C-01', 'C-02', 'C-03', 'C-04'],
      outages: [[700, 25, 'D-03', 'offline'], [610, 130, 'D-02', 'fault'], [400, 12, 'D-03', 'offline'], [300, 45, 'D-01', 'fault'], [150, 75, 'C-02', 'offline'], [97, 190, 'D-03', 'offline'], [30, 18, 'D-02', 'offline']],
      incidents: [[760, 'D-01', 'false_alarm'], [520, 'D-02', 'false_alarm'], [333, 'D-04', 'fire'], [200, 'D-01', 'false_alarm'], [60, 'D-03', 'false_alarm']],
    },
  },
  {
    org: 'Groupe Diallo', id: 'depot-matoto', name: 'Dépôt Matoto', seed: 22,
    plan: { outages: [[500, 90, 'D-02', 'fault'], [250, 35, 'D-01', 'offline']], incidents: [[330, 'D-01', 'false_alarm']], now: { 'D-02': ['fault', 310] }, blind: [[120, 40]] },
  },
  {
    org: 'Groupe Diallo', id: 'boutique-ratoma', name: 'Boutique Ratoma', seed: 33,
    plan: { outages: [[600, 20, 'D-03', 'offline']], incidents: [[450, 'D-02', 'false_alarm']], now: { 'D-01': ['alarm', 12] } },
  },
  {
    org: 'Groupe Diallo', id: 'bureau-nord', name: 'Bureau Conakry Nord', seed: 44,
    plan: { outages: [[300, 60, 'D-02', 'fault']], incidents: [], now: { 'D-04': ['prealarm', 20] }, silentFor: 190 },
  },
  { org: 'Maison Camara', id: 'maison-camara', name: 'Résidence Camara', seed: 55, plan: { cameras: ['C-01', 'C-02', 'C-03', 'C-04'], outages: [[100, 8, 'D-01', 'offline']], incidents: [[200, 'D-02', 'false_alarm']], now: { 'C-03': ['offline', 45] } } },
];
for (const s of SITES) {
  addSite(db, s.org, s.id, s.name);
  const { summary, at } = simulate(s.id, s.plan, s.seed);
  storeSummary(db, s.id, summary, at);
  console.log(`[demo] ${s.name} : ${summary.incidents.length} incident(s), ${summary.outages.length} panne(s)`);
}
const orgId = (name: string) => (db.prepare('SELECT id FROM organization WHERE name = ?').get(name) as { id: number }).id;
const accounts = [
  { username: 'prestataire', role: 'admin' as const, displayName: 'Équipe de maintenance' },
  { username: 'diallo', role: 'director' as const, orgId: orgId('Groupe Diallo'), displayName: 'M. Diallo' },
  { username: 'kaloum', role: 'site_manager' as const, orgId: orgId('Groupe Diallo'), siteId: 'entrepot-kaloum', displayName: 'Responsable Kaloum' },
  { username: 'autre', role: 'director' as const, orgId: orgId('Maison Camara'), displayName: 'Mme Camara' },
];
for (const a of accounts) {
  createUser(db, a, PASSWORD);
  db.prepare('UPDATE portal_user SET must_change_password = 0 WHERE username = ?').run(a.username);
}

const port = Number(process.env.PORTAL_DEMO_PORT ?? 4301);
// L'horloge de la demo avance : les « il y a N min » et le delai « injoignable » restent vrais pendant la presentation.
const app = createPortalApp({ db, master: Buffer.alloc(32, 1), staleAfterMs: 15 * MIN, webDir: join(root, 'portal', 'web') });
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`\n[demo] portail : http://127.0.0.1:${port}`);
  console.log(`[demo] comptes : ${accounts.map((a) => a.username).join(', ')}   mot de passe : ${PASSWORD}`);
  console.log('[demo] diallo voit 4 sites (un en alarme, un injoignable, un a surveiller) ; kaloum n\'en voit qu\'un ; autre voit seulement sa résidence.');
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
