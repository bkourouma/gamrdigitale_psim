/**
 * Portail de demonstration : npm run portal:demo
 *
 * Cree une base VIERGE (portal-demo-data/, recreee a chaque lancement) avec trois clients (dont une banque a deux regions), treize sites a des etats differents
 * et un historique de 35 jours produit par le vrai moteur du PSIM, puis sert le portail sur http://127.0.0.1:4301.
 * Comptes : prestataire, diallo (direction), kaloum (responsable d'un site), autre (autre client), dg-banque / dir-conakry / dir-haute-guinee (la banque) ; mot de passe : voir la sortie.
 * Rien n'est ecrit dans portal-data/ : la demo ne touche pas a une vraie installation.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createUser } from '../server/accounts.ts';
import { addGroup, addOrganization, addSite, assignSite, groupIdsByCodes } from '../server/admin.ts';
import { createPortalApp } from '../server/api.ts';
import { openPortalDb } from '../server/db.ts';
import { storeSummary } from '../server/ingest.ts';
import { createAccess } from '../../server/access.ts';
import { openDb } from '../../server/db.ts';
import { createEngine } from '../../server/engine.ts';
import { beginHistory, recordState } from '../../server/history.ts';
import { buildSiteSummary } from '../../server/portal.ts';
import type { SiteSummary } from '../../server/portal.ts';
import { createRiskService } from '../../server/risk.ts';
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
  /** Evaluation du risque propre au site : probabilite de base par zone (null : zone non evaluee). */
  riskP?: Record<string, number | null>;
  /** Detecteurs d'une autre categorie que l'incendie (l'etape 2 du PSIM en envoie : energie, personnes...). */
  categories?: Record<string, 'energy' | 'people' | 'environment'>;
  /**
   * Controle d'acces : `n` portes (P-01 a P-0n) sur un controleur. Leurs pannes passees et leur etat actuel se decrivent comme ceux
   * des detecteurs (`outages`, `now`, avec les identifiants P-01...). `incidents` : [il y a N heures, numero de porte (0 = P-01),
   * evenement de la passerelle, qualification] ; le portail n'en recoit que des comptes (jamais de nom, de badge ni de controleur).
   */
  doors?: { n: number; incidents: [number, number, 'door_forced' | 'door_held_open' | 'badge_denied_repeated' | 'tamper', 'fire' | 'false_alarm'][] };
  /** Le site a l'application des agents : des rondes de nuit sur 35 jours (tables minimales) et quelques SOS. */
  patrols?: boolean;
}

/**
 * Rondes de demonstration : trois par nuit, la plupart effectuees, quelques-unes incompletes ou ratees, les dernieres encore
 * a venir ; deux SOS. Seules les colonnes lues par le resume (statut, heures) sont creees : le portail ne voit que des compteurs.
 */
function addPatrolDemo(db: ReturnType<typeof openDb>, at: number, random: () => number): void {
  db.exec(`CREATE TABLE patrol_route (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE patrol_run (id INTEGER PRIMARY KEY AUTOINCREMENT, route_id INTEGER NOT NULL, due_start INTEGER NOT NULL, due_end INTEGER NOT NULL, status TEXT NOT NULL, UNIQUE (route_id, due_start))`);
  db.prepare("INSERT INTO patrol_route (name) VALUES ('Circuit de nuit')").run();
  const insert = db.prepare('INSERT INTO patrol_run (route_id, due_start, due_end, status) VALUES (1, ?, ?, ?)');
  for (let day = 34; day >= 0; day--) {
    const base = new Date(new Date(at).getFullYear(), new Date(at).getMonth(), new Date(at).getDate() - day).getTime();
    for (const hour of [22, 24, 26]) {
      const start = base + hour * HOUR;
      if (start > at + 3 * HOUR) continue;
      const r = random();
      // Une semaine un peu moins bonne (jours 14 a 20) pour que la courbe ne soit pas plate.
      const bad = day >= 14 && day <= 20 ? 0.25 : 0.06;
      const status = start > at ? 'pending' : r < bad ? 'missed' : r < bad * 2 ? 'incomplete' : 'done';
      insert.run(start, start + HOUR, status);
    }
  }
  const sos = db.prepare("INSERT INTO incident (detector_id, severity, status, opened_at, closed_at, event) VALUES ('D-01', 'critical', 'closed', ?, ?, 'sos')");
  for (const ago of [20, 9]) sos.run(at - ago * 24 * HOUR, at - ago * 24 * HOUR + 10 * MIN);
}

function simulate(siteId: string, plan: Plan, seed: number): { summary: SiteSummary; at: number } {
  const at = now - (plan.silentFor ?? 0) * MIN;
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-demo-')), join(root, 'seed'));
  let clock = at - 36 * 24 * HOUR;
  const access = createAccess({ db, now: () => clock, key: randomBytes(32), audit: (actor, action, ref) => engine.audit(actor, action, ref), setDeviceState: (id, state, event) => engine.setStateBySupervisor(id, state, event) });
  const engine = createEngine(db, () => {}, () => clock, { silentTimeoutMs: 0, ...(plan.doors ? { access } : {}) });
  const risk = createRiskService(db, engine, { now: () => clock });
  for (const [zone, p] of Object.entries(plan.riskP ?? {})) {
    if (p === null) db.prepare('DELETE FROM risk_zone WHERE zone = ?').run(zone);
    else db.prepare('UPDATE risk_zone SET probability = ? WHERE zone = ?').run(p, zone);
  }
  for (const [id, category] of Object.entries(plan.categories ?? {})) db.prepare('UPDATE device SET category = ? WHERE id = ?').run(category, id);
  beginHistory(db, clock, null, null);
  for (const id of plan.cameras ?? []) {
    db.prepare("INSERT INTO camera_source (device_id, kind, host, port) VALUES (?, 'rtsp', '192.0.2.10', 554)").run(id);
    recordState(db, id, 'normal', clock);
  }
  const doorIds = Array.from({ length: plan.doors?.n ?? 0 }, (_, i) => `P-0${i + 1}`);
  if (doorIds.length > 0) {
    access.createController('demo', { id: 'CTL-DEMO', name: 'Contrôleur de démonstration', brand: 'dahua' });
    doorIds.forEach((id, i) => {
      engine.createDevice('demo', { id, kind: 'detector', name: `Porte ${i + 1}`, zone: 'Entrepot', category: 'access' });
      access.declareDoor('demo', { detectorId: id, controllerId: 'CTL-DEMO', doorNo: (i % 4) + 1 });
      engine.ingest(id, { event: 'door_closed' });
    });
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
  for (const [ago, door, event, qualification] of plan.doors?.incidents ?? []) {
    const id = doorIds[door];
    const open = at - ago * HOUR;
    let incidentId = 0;
    events.push(
      { t: open, run: () => (engine.ingest(id, { event }), (incidentId = engine.getSnapshot().incidents.find((i) => i.detectorId === id && i.status !== 'closed')!.id)) },
      { t: open + 3 * MIN, run: () => engine.acknowledge(incidentId, 'gardien') },
      { t: open + 10 * MIN, run: () => (engine.ingest(id, { state: 'normal' }), engine.ingest(id, { event: 'door_closed' })) },
      { t: open + 30 * MIN, run: () => engine.close(incidentId, 'gardien', qualification, null) },
    );
  }
  for (const [id, [state, minutes]] of Object.entries(plan.now ?? {})) events.push({ t: at - minutes * MIN, run: setState(id, state) });
  // Arret du PSIM : il redemarre N minutes apres son dernier signe de vie (voir history.ts : le trou n'est ni disponible ni indisponible).
  for (const [ago, minutes] of plan.blind ?? []) {
    const restart = at - ago * HOUR + minutes * MIN;
    events.push({ t: restart, run: () => beginHistory(db, restart, restart - minutes * MIN, { from: restart - minutes * MIN, to: restart, clean: false }) });
  }
  // Un point d'indice par jour, comme le PSIM (il le note au premier calcul de la journee) : la tendance du portail.
  for (let t = at - 35 * 24 * HOUR; t <= at; t += 24 * HOUR) events.push({ t, run: () => void risk.recordHistory() });
  events.sort((a, b) => a.t - b.t);
  for (const e of events) {
    clock = e.t;
    e.run();
  }
  clock = at;
  if (plan.patrols) addPatrolDemo(db, at, random);
  return { summary: buildSiteSummary(db, { siteId, version: '0.1.0', startedAt: at - 3 * 24 * HOUR, now: at, risk: () => risk.overview() }), at };
}

const dataDir = join(root, 'portal-demo-data');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const db = openPortalDb(join(dataDir, 'portal.db'));

addOrganization(db, 'Groupe Diallo');
addOrganization(db, 'Maison Camara');
addOrganization(db, 'Banque du Fouta');
// La banque : deux regions (l'une avec deux groupes d'agences), un siege sans groupe. Groupe Diallo et Maison Camara
// n'ont pas de groupe : leur portail reste celui d'avant.
addGroup(db, 'Banque du Fouta', 'region-conakry', 'Région Conakry');
addGroup(db, null, 'agences-kaloum', 'Agences de Kaloum', 'region-conakry');
addGroup(db, null, 'agences-ratoma', 'Agences de Ratoma', 'region-conakry');
addGroup(db, 'Banque du Fouta', 'region-haute-guinee', 'Région Haute-Guinée');
const SITES: { org: string; id: string; name: string; plan: Plan; seed: number; group?: string; neverSends?: boolean }[] = [
  {
    org: 'Groupe Diallo', id: 'entrepot-kaloum', name: 'Entrepôt Kaloum', seed: 11,
    plan: {
      cameras: ['C-01', 'C-02', 'C-03', 'C-04'],
      outages: [[700, 25, 'D-03', 'offline'], [200, 95, 'P-02', 'offline'], [610, 130, 'D-02', 'fault'], [400, 12, 'D-03', 'offline'], [300, 45, 'D-01', 'fault'], [150, 75, 'C-02', 'offline'], [97, 190, 'D-03', 'offline'], [30, 18, 'D-02', 'offline']],
      incidents: [[760, 'D-01', 'false_alarm'], [520, 'D-02', 'false_alarm'], [333, 'D-04', 'fire'], [200, 'D-01', 'false_alarm'], [60, 'D-03', 'false_alarm']],
      // Quatre portes : une série de refus et une porte restée ouverte (fausses alarmes), une porte forcée avérée, une porte hors ligne depuis 40 min.
      now: { 'P-04': ['offline', 40] },
      doors: { n: 4, incidents: [[300, 0, 'door_held_open', 'false_alarm'], [120, 1, 'badge_denied_repeated', 'false_alarm'], [48, 2, 'door_forced', 'fire']] },
      patrols: true,
    },
  },
  {
    org: 'Groupe Diallo', id: 'depot-matoto', name: 'Dépôt Matoto', seed: 22,
    plan: { outages: [[500, 90, 'D-02', 'fault'], [250, 35, 'D-01', 'offline']], incidents: [[330, 'D-01', 'false_alarm']], now: { 'D-02': ['fault', 310] }, blind: [[120, 40]], riskP: { Atelier: 2 } },
  },
  {
    org: 'Groupe Diallo', id: 'boutique-ratoma', name: 'Boutique Ratoma', seed: 33,
    plan: { outages: [[600, 20, 'D-03', 'offline']], incidents: [[450, 'D-02', 'false_alarm']], now: { 'D-01': ['alarm', 12] }, riskP: { Atelier: 1, Entrepot: 1, 'Salle serveurs': 1 } },
  },
  {
    org: 'Groupe Diallo', id: 'bureau-nord', name: 'Bureau Conakry Nord', seed: 44,
    plan: { outages: [[300, 60, 'D-02', 'fault']], incidents: [], now: { 'D-04': ['prealarm', 20] }, silentFor: 190, riskP: { Accueil: null, Bureaux: null, 'Salle serveurs': null, Couloir: null, Entrepot: null, Atelier: null, Stockage: null } },
  },
  { org: 'Maison Camara', id: 'maison-camara', name: 'Résidence Camara', seed: 55, plan: { cameras: ['C-01', 'C-02', 'C-03', 'C-04'], outages: [[100, 8, 'D-01', 'offline']], incidents: [[200, 'D-02', 'false_alarm']], now: { 'C-03': ['offline', 45] }, riskP: { Atelier: 1, Entrepot: 1, 'Salle serveurs': 1, Stockage: 1 } } },
  // ---- Banque du Fouta
  { org: 'Banque du Fouta', group: 'agences-kaloum', id: 'agence-kaloum-centre', name: 'Agence Kaloum Centre', seed: 61, plan: { cameras: ['C-01', 'C-02'], outages: [[200, 20, 'D-02', 'offline']], incidents: [[300, 'D-01', 'false_alarm']], riskP: { Atelier: 1, Entrepot: 1, 'Salle serveurs': 1, Stockage: 1 } } },
  { org: 'Banque du Fouta', group: 'agences-kaloum', id: 'agence-kaloum-port', name: 'Agence du Port', seed: 62, plan: { outages: [[400, 45, 'D-03', 'fault']], incidents: [[120, 'D-02', 'false_alarm']], now: { 'D-01': ['alarm', 9] }, riskP: { Atelier: 3, Entrepot: 3 } } },
  { org: 'Banque du Fouta', group: 'agences-ratoma', id: 'agence-ratoma-marche', name: 'Agence Marché de Ratoma', seed: 63, plan: { outages: [[300, 30, 'D-01', 'offline'], [200, 90, 'P-01', 'offline']], incidents: [], now: { 'D-02': ['fault', 150], 'P-02': ['fault', 180] }, riskP: { Atelier: 2 }, doors: { n: 2, incidents: [[90, 0, 'tamper', 'false_alarm']] } } },
  { org: 'Banque du Fouta', group: 'agences-ratoma', id: 'agence-ratoma-nord', name: 'Agence Ratoma Nord', seed: 64, plan: { categories: { 'D-05': 'energy' }, outages: [], incidents: [], now: { 'D-05': ['alarm', 25] }, riskP: { Atelier: 1, Entrepot: 2 } } },
  { org: 'Banque du Fouta', group: 'region-haute-guinee', id: 'agence-kankan-centre', name: 'Agence Kankan Centre', seed: 65, plan: { cameras: ['C-01', 'C-03'], outages: [[100, 15, 'D-01', 'offline']], incidents: [], now: { 'D-04': ['alarm', 330] }, silentFor: 360, riskP: { Atelier: 2, Entrepot: 2 } } },
  { org: 'Banque du Fouta', group: 'region-haute-guinee', id: 'agence-kankan-gare', name: 'Agence de la Gare', seed: 66, plan: { categories: { 'D-06': 'people' }, outages: [], incidents: [[3, 'D-06', 'fire']], riskP: { Atelier: 1, Entrepot: 1, 'Salle serveurs': 1 } } },
  { org: 'Banque du Fouta', group: 'region-haute-guinee', id: 'agence-siguiri', name: 'Agence de Siguiri (nouvelle)', seed: 67, plan: { outages: [], incidents: [] }, neverSends: true },
  { org: 'Banque du Fouta', id: 'siege-conakry', name: 'Siège de Conakry', seed: 68, plan: { cameras: ['C-01', 'C-02', 'C-03'], outages: [[500, 10, 'D-03', 'offline']], incidents: [[250, 'D-03', 'false_alarm']], riskP: { Atelier: 1, Entrepot: 1, 'Salle serveurs': 1 } } },
];
for (const s of SITES) {
  addSite(db, s.org, s.id, s.name);
  if (s.group) assignSite(db, s.id, s.group);
  if (s.neverSends) {
    console.log(`[demo] ${s.name} : créé, n'a encore rien envoyé`);
    continue;
  }
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
  // La banque : la direction generale voit tout ; chaque directeur regional n'a que sa region.
  { username: 'dg-banque', role: 'director' as const, orgId: orgId('Banque du Fouta'), displayName: 'Direction générale' },
  { username: 'dir-conakry', role: 'director' as const, orgId: orgId('Banque du Fouta'), displayName: 'Directeur région Conakry', groupIds: groupIdsByCodes(db, ['region-conakry']) },
  { username: 'dir-haute-guinee', role: 'director' as const, orgId: orgId('Banque du Fouta'), displayName: 'Directrice Haute-Guinée', groupIds: groupIdsByCodes(db, ['region-haute-guinee']) },
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
  console.log('[demo] dg-banque voit toute la banque (2 régions, un siège sans groupe) ; dir-conakry ne voit que la région Conakry ; dir-haute-guinee que la Haute-Guinée (un site muet, un site jamais vu).');
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
