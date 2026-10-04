/**
 * Etages (duplex) : migration d'une base a plan unique, gestion des etages, plan par etage, equipements par etage,
 * etage dans les incidents, les notifications, les rapports, les sauvegardes et la mise en service ; puis l'API reelle.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { checkInventory } from '../scripts/commission/checks.ts';
import { buildSheet } from '../scripts/commission/sheet.ts';
// @ts-expect-error module JS de l'interface (sans types), importe pour tester ses calculs purs
import { floorSummary, stackGap } from '../web/floors.js';
import { createBackup, verifyBackup } from '../server/backup.ts';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import { createFloors, DEFAULT_FLOOR_NAME, listFloors } from '../server/floors.ts';
import { createNotifier } from '../server/notifications.ts';
import type { Channel, Message } from '../server/notifications.ts';
import { createReports } from '../server/reports.ts';
import { seedDemo } from '../server/seed.ts';

const ROOT = resolve(import.meta.dirname, '..');
const SVG = (label: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>${label}</title></svg>`);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'psim-floor-'));
  const db = openDb(join(dir, 'psim.db'));
  seedDemo(db, dir, join(ROOT, 'seed'));
  const audits: string[] = [];
  let configs = 0;
  let clock = 1_000_000;
  const engine = createEngine(db, () => {}, () => (clock += 1000));
  const floors = createFloors({
    db,
    dataDir: dir,
    audit: (actor, action, ref) => {
      audits.push(`${actor}:${action}:${ref?.details ?? ''}`);
      engine.audit(actor, action, ref);
    },
    publishConfig: () => configs++,
  });
  return { dir, db, engine, floors, audits, configs: () => configs };
}

const expectError = (fn: () => unknown, status: number, pattern?: RegExp) =>
  assert.throws(fn, (err: unknown) => err instanceof PsimError && err.status === status && (!pattern || pattern.test(err.message)));

describe('etages : migration', () => {
  it("une base a plan unique devient un « Rez-de-chaussee » qui garde le plan, et tous les equipements y sont ranges", () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-floor-old-'));
    const path = join(dir, 'psim.db');
    // Base d'une version anterieure : pas de table floor, pas de device.floor_id.
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE site (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, plan_file TEXT, plan_version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE device (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, zone TEXT NOT NULL DEFAULT '', x REAL NOT NULL DEFAULT 50, y REAL NOT NULL DEFAULT 50, status TEXT NOT NULL DEFAULT 'normal', stream_kind TEXT, last_seen INTEGER);
      INSERT INTO site VALUES (1, 'Maison', 'plan-7.svg', 7);
      INSERT INTO device (id, kind, name, zone) VALUES ('D-01', 'detector', 'Salon', 'Salon'), ('C-01', 'camera', 'Voie 1', 'Cour');`);
    old.close();
    writeFileSync(join(dir, 'plan-7.svg'), SVG('ancien'));

    const db = openDb(path);
    const floors = listFloors(db);
    assert.deepEqual(floors, [{ id: floors[0].id, name: DEFAULT_FLOOR_NAME, position: 0, hasPlan: true, planVersion: 7 }]);
    const rows = db.prepare('SELECT id, floor_id FROM device ORDER BY id').all() as { id: string; floor_id: number }[];
    assert.deepEqual(rows.map((r) => r.floor_id), [floors[0].id, floors[0].id]);
    db.close();

    // Rouvrir ne recree rien.
    const again = openDb(path);
    assert.equal(listFloors(again).length, 1);
    const f = createFloors({ db: again, dataDir: dir, audit: () => {}, publishConfig: () => {} });
    assert.equal(f.planPath(floors[0].id)?.path, join(dir, 'plan-7.svg'), "l'ancien fichier de plan reste servi");
    again.close();
  });

  it("une base neuve a un etage sans plan ; le site de demonstration a le sien sur cet etage", () => {
    const blank = openDb(':memory:');
    assert.deepEqual(listFloors(blank).map((f) => [f.name, f.hasPlan]), [[DEFAULT_FLOOR_NAME, false]]);
    const t = setup();
    const [floor] = listFloors(t.db);
    assert.equal(floor.hasPlan, true);
    assert.ok(t.engine.getSnapshot().devices.every((d) => d.floorId === floor.id));
  });

  it("un equipement insere sans etage (outil, ancienne version) est montre sur l'etage le plus bas, jamais perdu", () => {
    const t = setup();
    t.db.prepare("INSERT INTO device (id, kind, name, zone) VALUES ('X-1', 'detector', 'Insere a la main', '')").run();
    const [floor] = listFloors(t.db);
    assert.equal(t.engine.getDevice('X-1')!.floorId, floor.id);
    assert.equal(t.engine.getSnapshot().devices.find((d) => d.id === 'X-1')!.floorId, floor.id);
  });
});

describe('etages : gestion', () => {
  it("ajouter un etage le place au-dessus ; le nom est verifie (vide, trop long, doublon, caracteres de controle)", () => {
    const t = setup();
    const up = t.floors.create('admin', { name: '  Étage  ' });
    assert.deepEqual([up.name, up.position, up.hasPlan], ['Étage', 1, false]);
    expectError(() => t.floors.create('admin', { name: 'étage' }), 409, /deja/);
    expectError(() => t.floors.create('admin', { name: '' }), 400);
    expectError(() => t.floors.create('admin', { name: 'x'.repeat(41) }), 400, /trop long/);
    expectError(() => t.floors.create('admin', { name: 'Combles\nfaux' }), 400, /controle/);
    expectError(() => t.floors.create('admin', { name: 42 }), 400);
    assert.ok(t.audits.includes('admin:floor_created:Étage'));
    assert.equal(t.configs(), 1, 'les ecrans connectes sont prevenus');
  });

  it("renommer et changer l'ordre (0 = le plus bas) ; position invalide refusee ; journal de chaque changement", () => {
    const t = setup();
    const [rdc] = listFloors(t.db);
    const etage = t.floors.create('admin', { name: 'Étage' });
    const sous = t.floors.create('admin', { name: 'Sous-sol' });
    t.floors.update('admin', sous.id, { position: 0 });
    assert.deepEqual(listFloors(t.db).map((f) => f.name), ['Sous-sol', DEFAULT_FLOOR_NAME, 'Étage']);
    assert.deepEqual(listFloors(t.db).map((f) => f.position), [0, 1, 2]);
    t.floors.update('admin', rdc.id, { name: 'RDC' });
    assert.equal(t.floors.get(rdc.id).name, 'RDC');
    expectError(() => t.floors.update('admin', etage.id, { name: 'rdc' }), 409);
    expectError(() => t.floors.update('admin', etage.id, { position: 3 }), 400);
    expectError(() => t.floors.update('admin', etage.id, { position: 1.5 }), 400);
    expectError(() => t.floors.update('admin', 999, { name: 'X' }), 404);
    expectError(() => t.floors.update('admin', 'abc', { name: 'X' }), 400);
    assert.ok(t.audits.some((a) => /floor_updated:Sous-sol : place au niveau 0/.test(a)));
    assert.ok(t.audits.some((a) => /floor_updated:RDC : renomme/.test(a)));
    const before = t.audits.length;
    t.floors.update('admin', rdc.id, { name: 'RDC' });
    assert.equal(t.audits.length, before, 'sans changement : rien au journal');
  });

  it("supprimer : jamais le dernier etage, jamais un etage qui porte des equipements ; son plan part avec lui", () => {
    const t = setup();
    const [rdc] = listFloors(t.db);
    expectError(() => t.floors.remove('admin', rdc.id), 409, /au moins un etage/);
    expectError(() => t.floors.create('admin', { name: 'Étage' }) && t.floors.remove('admin', rdc.id), 409, /16 equipement/);
    const etage = listFloors(t.db).find((f) => f.name === 'Étage')!;
    t.floors.setPlan('admin', etage.id, 'image/svg+xml', SVG('etage'));
    const file = `plan-${etage.id}-1.svg`;
    assert.ok(existsSync(join(t.dir, file)));
    t.engine.createDevice('admin', { id: 'D-20', kind: 'detector', name: 'Chambre', zone: 'Chambre', floorId: etage.id });
    expectError(() => t.floors.remove('admin', etage.id), 409, /1 equipement/);
    t.engine.deleteDevice('admin', 'D-20');
    t.floors.remove('admin', etage.id);
    assert.equal(existsSync(join(t.dir, file)), false, 'plan supprime');
    assert.deepEqual(listFloors(t.db).map((f) => [f.name, f.position]), [[DEFAULT_FLOOR_NAME, 0]]);
    assert.ok(t.audits.includes('admin:floor_deleted:Étage'));
  });

  it("20 etages au plus", () => {
    const t = setup();
    for (let i = 1; i < 20; i++) t.floors.create('admin', { name: `Niveau ${i}` });
    expectError(() => t.floors.create('admin', { name: 'Niveau 20' }), 409, /20 etages/);
  });
});

describe('etages : plan de chaque etage', () => {
  it("chaque etage a son fichier ; remplacer un plan ne supprime que l'ancien plan de CET etage", () => {
    const t = setup();
    const [rdc] = listFloors(t.db);
    const etage = t.floors.create('admin', { name: 'Étage' });
    const legacy = readdirSync(t.dir).filter((n) => n.startsWith('plan-'));
    assert.deepEqual(legacy, ['plan-0.svg'], 'plan de demonstration');
    assert.deepEqual(t.floors.setPlan('admin', etage.id, 'image/svg+xml', SVG('etage v1')), { planVersion: 1 });
    t.floors.setPlan('admin', etage.id, 'image/png', PNG);
    assert.deepEqual(readdirSync(t.dir).filter((n) => n.startsWith('plan-')).sort(), ['plan-0.svg', `plan-${etage.id}-2.png`]);
    assert.equal(t.floors.planPath(etage.id)?.mime, 'image/png');
    t.floors.setPlan('admin', rdc.id, 'image/svg+xml', SVG('rdc v1'));
    assert.deepEqual(readdirSync(t.dir).filter((n) => n.startsWith('plan-')).sort(), [`plan-${etage.id}-2.png`, `plan-${rdc.id}-1.svg`].sort(), "l'ancien plan unique part quand le rez-de-chaussee en change");
    assert.ok(t.audits.some((a) => /plan_updated:Étage - \d+ Ko/.test(a)));
  });

  it("type, signature et contenu sont verifies ; un etage sans plan n'a pas de chemin", () => {
    const t = setup();
    const etage = t.floors.create('admin', { name: 'Étage' });
    expectError(() => t.floors.setPlan('admin', etage.id, 'text/html', Buffer.from('<svg>')), 415);
    expectError(() => t.floors.setPlan('admin', etage.id, 'image/png', Buffer.from('pas un png')), 400);
    expectError(() => t.floors.setPlan('admin', etage.id, 'image/svg+xml', Buffer.alloc(0)), 415);
    expectError(() => t.floors.setPlan('admin', etage.id, 'image/svg+xml', 'texte' as unknown as Buffer), 415);
    expectError(() => t.floors.setPlan('admin', 404, 'image/svg+xml', SVG('x')), 404);
    assert.equal(t.floors.planPath(etage.id), null);
  });

  it("un nom de fichier altere dans la base n'est jamais servi (pas de traversee de chemin)", () => {
    const t = setup();
    const [rdc] = listFloors(t.db);
    for (const bad of ['../psim.db', 'secret.key', 'plan-1.svg/../../x', 'C:\\Windows\\win.ini']) {
      t.db.prepare('UPDATE floor SET plan_file = ? WHERE id = ?').run(bad, rdc.id);
      assert.equal(t.floors.planPath(rdc.id), null, bad);
    }
  });
});

describe('etages : equipements, incidents, notifications, rapports', () => {
  it("un equipement est cree sur un etage, peut en changer (journalise), et un etage inconnu est refuse", () => {
    const t = setup();
    const [rdc] = listFloors(t.db);
    const etage = t.floors.create('admin', { name: 'Étage' });
    assert.equal(t.engine.createDevice('admin', { id: 'C-10', kind: 'camera', name: 'Couloir haut' }).floorId, rdc.id, 'par defaut : le plus bas');
    assert.equal(t.engine.createDevice('admin', { id: 'D-10', kind: 'detector', name: 'Chambre 1', zone: 'Etage - Chambre 1', floorId: etage.id }).floorId, etage.id);
    expectError(() => t.engine.createDevice('admin', { id: 'D-11', kind: 'detector', name: 'X', floorId: 999 }), 400, /Etage inconnu/);
    expectError(() => t.engine.createDevice('admin', { id: 'D-11', kind: 'detector', name: 'X', floorId: '1' }), 400, /Etage inconnu/);
    assert.equal(t.engine.updateDevice('admin', 'C-10', { floorId: etage.id }).floorId, etage.id);
    const moved = t.db.prepare("SELECT details FROM audit_log WHERE action = 'device_updated' AND device_id = 'C-10'").get() as { details: string };
    assert.equal(moved.details, "deplace vers l'etage Étage");
    expectError(() => t.engine.updateDevice('admin', 'C-10', { floorId: null }), 400);
    const snap = t.engine.getSnapshot();
    assert.deepEqual(snap.floors.map((f) => f.name), [DEFAULT_FLOOR_NAME, 'Étage']);
    assert.equal(snap.site.hasPlan, true, "compatibilite : plan de l'etage le plus bas");
  });

  it("l'incident porte le nom de l'etage de son detecteur", () => {
    const t = setup();
    const etage = t.floors.create('admin', { name: 'Étage' });
    t.engine.updateDevice('admin', 'D-02', { floorId: etage.id });
    t.engine.handleDetectorMessage('D-02', { state: 'alarm' });
    t.engine.handleDetectorMessage('D-01', { state: 'alarm' });
    const incidents = t.engine.getSnapshot().incidents;
    assert.equal(incidents.find((i) => i.detectorId === 'D-02')!.floor, 'Étage');
    assert.equal(incidents.find((i) => i.detectorId === 'D-01')!.floor, DEFAULT_FLOOR_NAME);
  });

  it("notifications : l'etage est cite des qu'il y en a plusieurs (alarme et detecteur muet), pas avant", async () => {
    const t = setup();
    const sent: Message[] = [];
    const channel: Channel = { id: 'chat', label: 'chat', recipients: (l) => (l === 1 ? ['a'] : []), mask: (r) => r, send: async (m) => void sent.push(m), sendImages: async () => {} };
    const notifier = createNotifier({ db: t.db, engine: t.engine, channels: [channel], escalateAfterMs: 0, reminderMs: 0, maxReminders: 0, retryDelaysMs: [0], secrets: [], readSnapshot: () => null });
    const incidentOf = (id: string) => t.engine.getSnapshot().incidents.find((i) => i.detectorId === id && i.status !== 'closed')!;
    t.engine.handleDetectorMessage('D-01', { state: 'alarm' });
    await notifier.notifyIncident(incidentOf('D-01'), 'opened');
    assert.match(sent[0].text, /^Zone : Accueil$/m, 'un seul etage : rien de plus');
    const etage = t.floors.create('admin', { name: 'Étage' });
    t.engine.updateDevice('admin', 'D-02', { floorId: etage.id });
    t.engine.handleDetectorMessage('D-02', { state: 'alarm' });
    await notifier.notifyIncident(incidentOf('D-02'), 'opened');
    assert.match(sent[1].text, /^Zone : Bureaux - Etage : Étage$/m);
    await notifier.notifySilent(t.engine.getDevice('D-02')!);
    assert.match(sent[2].text, /\(Bureaux, etage : Étage\)/);
  });

  it("rapports : colonne « Étage » dans l'export CSV et ligne dans la fiche d'incident", () => {
    const t = setup();
    const etage = t.floors.create('admin', { name: 'Étage' });
    t.engine.updateDevice('admin', 'D-02', { floorId: etage.id });
    t.engine.handleDetectorMessage('D-02', { state: 'alarm' });
    const reports = createReports(t.db);
    const range = { from: 0, to: 10_000_000_000, label: 'tout', category: null } as unknown as Parameters<typeof reports.incidentsCsv>[0];
    const lines = reports.incidentsCsv(range).replace('﻿', '').trim().split('\r\n');
    assert.match(lines[0], /;Nom;Zone;Étage;Gravité;/);
    assert.match(lines[1], /;Bureaux;Étage;/);
    const id = t.engine.getSnapshot().incidents[0].id;
    assert.match(reports.incidentHtml(id, 2_000_000), /Bureaux — étage : Étage/);
  });
});

describe('etages : corrections de la relecture', () => {
  it("une zone appartient a UN etage : creation, changement de zone ou d'etage refuses s'ils la partageraient entre deux niveaux", () => {
    const t = setup();
    const etage = t.floors.create('admin', { name: 'Étage' });
    expectError(() => t.engine.createDevice('admin', { id: 'I-20', kind: 'detector', category: 'intrusion', name: 'Chambre haut', zone: 'Accueil', floorId: etage.id }), 409, /une zone appartient a un seul etage/);
    t.engine.createDevice('admin', { id: 'I-20', kind: 'detector', category: 'intrusion', name: 'Chambre haut', zone: 'Étage - Chambre', floorId: etage.id });
    expectError(() => t.engine.updateDevice('admin', 'I-20', { zone: 'Accueil' }), 409, /Accueil.*Rez-de-chaussée/);
    expectError(() => t.engine.updateDevice('admin', 'D-02', { zone: 'Étage - Chambre' }), 409, /Étage - Chambre/);
    expectError(() => t.engine.updateDevice('admin', 'D-01', { floorId: etage.id }), 409, /deja utilisee/);
    // Le seul equipement d'une zone peut changer d'etage avec elle ; une zone vide n'est pas concernee.
    assert.equal(t.engine.updateDevice('admin', 'D-02', { floorId: etage.id }).floorId, etage.id);
    assert.equal(t.engine.createDevice('admin', { id: 'C-20', kind: 'camera', name: 'Sans zone', floorId: etage.id }).zone, '');
    // Renommer sans changer de zone ni d'etage reste possible, meme sur une base anterieure qui melange deja.
    t.db.prepare("INSERT INTO device (id, kind, name, zone, floor_id) VALUES ('X-9', 'detector', 'Ancien', 'Accueil', ?)").run(etage.id);
    assert.equal(t.engine.updateDevice('admin', 'X-9', { name: 'Ancien renomme' }).name, 'Ancien renomme');
  });

  it("noms d'etage et d'equipement : forme Unicode unique, caracteres invisibles, bidi et C1 refuses", () => {
    const t = setup();
    t.floors.create('admin', { name: 'Étage 2' });
    expectError(() => t.floors.create('admin', { name: 'E\u0301tage 2' }), 409, /deja/);
    for (const bad of ['Étage\u200b', '\u202eegatE', 'X\u009b31m', 'Y\u0085Z', 'A\u2028B', '\u2066Niveau\u2069']) {
      expectError(() => t.floors.create('admin', { name: bad }), 400, /invisibles/);
      expectError(() => t.engine.createDevice('admin', { id: 'X-1', kind: 'detector', name: bad }), 400, /caracteres de controle/);
    }
    assert.equal(t.engine.createDevice('admin', { id: 'X-2', kind: 'detector', name: 'Cha\u0302teau', zone: 'Pie\u0300ce' }).zone, 'Pièce', 'zone en NFC');
  });

  it("ouvrir une base deja migree n'ecrit rien : pas d'echec « database is locked » pendant qu'un autre processus ecrit", () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-floor-lock-'));
    const path = join(dir, 'psim.db');
    openDb(path).close();
    const writer = new DatabaseSync(path);
    writer.exec('BEGIN IMMEDIATE');
    try {
      const started = Date.now();
      const db = openDb(path);
      assert.equal(listFloors(db).length, 1);
      assert.ok(Date.now() - started < 2000, 'aucune attente du verrou');
      db.close();
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
  });

  it("detecteur muet : l'etage est aussi dans les donnees structurees (webhook)", async () => {
    const t = setup();
    const etage = t.floors.create('admin', { name: 'Étage' });
    t.engine.updateDevice('admin', 'D-02', { floorId: etage.id });
    const sent: Message[] = [];
    const channel: Channel = { id: 'hook', label: 'hook', recipients: (l) => (l === 1 ? ['a'] : []), mask: (r) => r, send: async (m) => void sent.push(m), sendImages: async () => {} };
    const notifier = createNotifier({ db: t.db, engine: t.engine, channels: [channel], escalateAfterMs: 0, reminderMs: 0, maxReminders: 0, retryDelaysMs: [0], secrets: [], readSnapshot: () => null });
    await notifier.notifySilent(t.engine.getDevice('D-02')!);
    assert.equal((sent[0].data as { floor?: string }).floor, 'Étage');
  });

  it("fiche de recette : l'etage de chaque equipement est imprime, et l'essai le verifie", () => {
    const html = buildSheet({ site: 'Maison', generatedAt: 0, devices: [{ id: 'D-1', kind: 'detector', name: 'Chambre', zone: 'Étage - Chambre', floor: 'Étage', category: 'fire', links: [] }] });
    assert.match(html, /Étage - Chambre - etage : Étage/);
    assert.match(html, /la bonne zone et le bon etage/);
  });
});

describe('etages : calculs de l interface (web/floors.js)', () => {
  it("etat d'un etage : alarme, incident critique revenu au calme, prealarme, hors service, normal", () => {
    const d = (id: string, status: string, floorId = 1, kind = 'detector') => ({ id, status, floorId, kind });
    const open = (detectorId: string, severity = 'critical', status = 'open') => ({ detectorId, severity, status });
    assert.deepEqual(pick(floorSummary(1, [d('A', 'alarm'), d('B', 'normal')], [open('A')])), { level: 'alarm', text: '1 alarme, 1 à acquitter', firing: ['A'] });
    assert.deepEqual(pick(floorSummary(1, [d('A', 'normal')], [open('A', 'critical', 'acknowledged')])), { level: 'alarm', text: '1 incident en cours', firing: [] });
    assert.deepEqual(pick(floorSummary(1, [d('A', 'prealarm'), d('B', 'offline')], [])), { level: 'prealarm', text: '1 préalarme, 1 hors service', firing: ['A'] });
    assert.deepEqual(pick(floorSummary(1, [d('A', 'fault'), d('Z', 'alarm', 2)], [open('Z')])), { level: 'down', text: '1 hors service', firing: [] });
    assert.deepEqual(pick(floorSummary(1, [d('C', 'normal', 1, 'camera')], [])), { level: 'normal', text: 'Normal', firing: [] });
  });

  it("vue eclatee : l'ecart entre plateaux tient tout l'empilement dans le cadre jusqu'a 20 etages", () => {
    assert.equal(stackGap(1), 150);
    assert.equal(stackGap(2), 150);
    for (let n = 2; n <= 20; n++) assert.ok(stackGap(n) * (n - 1) <= 460 && stackGap(n) >= 24, `n=${n}`);
  });
});

const pick = (s: { level: string; text: string; firing: string[] }) => ({ level: s.level, text: s.text, firing: s.firing });

describe('etages : sauvegarde et mise en service', () => {
  it("la sauvegarde emporte le plan de chaque etage et passe sa propre verification", () => {
    const t = setup();
    const etage = t.floors.create('admin', { name: 'Étage' });
    t.floors.setPlan('admin', etage.id, 'image/svg+xml', SVG('etage'));
    const b = createBackup({ db: t.db, dataDir: t.dir, backupDir: join(t.dir, 'backups') });
    assert.ok(existsSync(join(b.dir, `plan-${etage.id}-1.svg`)));
    assert.ok(existsSync(join(b.dir, 'plan-0.svg')));
    assert.deepEqual(verifyBackup(b.dir).problems, []);
  });

  it("mise en service : etage sans plan, et zone a cheval sur deux etages, sont signales", () => {
    const t = setup();
    const etage = t.floors.create('admin', { name: 'Étage' });
    const by = (id: string) => checkInventory(t.db).find((c) => c.id === id);
    assert.match(by('plan')!.detail, /etage\(s\) sans plan : Étage/);
    assert.equal(by('zone-floors'), undefined);
    // L'API le refuse desormais (voir « une zone appartient a un seul etage ») : cas d'une base anterieure ou d'un outil.
    t.db.prepare("INSERT INTO device (id, kind, name, zone, floor_id) VALUES ('D-30', 'detector', 'Accueil haut', 'Accueil', ?)").run(etage.id);
    assert.match(by('zone-floors')!.detail, /zone\(s\) presente\(s\) sur plusieurs etages : Accueil/);
    t.floors.setPlan('admin', etage.id, 'image/svg+xml', SVG('etage'));
    assert.equal(by('plan'), undefined);
  });
});

// ---------------------------------------------------------------- API reelle

const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });

describe('etages : API (processus reel)', { timeout: 120_000 }, () => {
  let proc: ChildProcess;
  let base = '';
  let output = '';
  let admin = '';
  let operator = '';

  const call = async (method: string, path: string, opts: { cookie?: string; json?: unknown; body?: Buffer; type?: string } = {}) => {
    const headers: Record<string, string> = { Cookie: opts.cookie ?? admin };
    if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.type) headers['Content-Type'] = opts.type;
    const res = await fetch(`${base}${path}`, { method, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body ? new Uint8Array(opts.body) : undefined });
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // pas du JSON (plan)
    }
    return { status: res.status, body, headers: res.headers };
  };
  const login = async (username: string, password: string) => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(res.status, 200, output);
    return res.headers.get('set-cookie')!.split(';')[0];
  };

  before(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
    Object.assign(env, {
      PSIM_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'psim-floor-api-')), 'data'),
      PSIM_PORT: String(port),
      PSIM_MQTT_PORT: String(await freePort()),
      PSIM_ADMIN_PASSWORD: ADMIN_PW,
      PSIM_OPERATOR_PASSWORD: OPERATOR_PW,
      PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3',
      PSIM_DEMO_LOGIN: '0',
      PSIM_REQUIRE_2FA: 'none',
    });
    proc = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout!.on('data', (d) => (output += d));
    proc.stderr!.on('data', (d) => (output += d));
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).status === 200) break;
      } catch {
        // pas encore pret
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    admin = await login('admin', ADMIN_PW);
    operator = await login('operateur', OPERATOR_PW);
  });

  after(() => proc?.kill());

  it("parcours administrateur : ajouter l'etage, son plan, y deplacer un detecteur ; l'etat le montre a l'operateur", async () => {
    const created = await call('POST', '/api/floors', { json: { name: 'Étage' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id as number;
    const up = await call('PUT', `/api/floors/${id}/plan`, { body: SVG('etage'), type: 'image/svg+xml' });
    assert.deepEqual(up.body, { ok: true, planVersion: 1 });
    const plan = await call('GET', `/api/floors/${id}/plan`, { cookie: operator });
    assert.equal(plan.status, 200);
    assert.equal(plan.headers.get('content-type'), 'image/svg+xml');
    assert.match(plan.headers.get('content-security-policy') ?? '', /sandbox/, 'un SVG televerse ne peut pas executer de script');
    assert.match(String(plan.body), /<title>etage<\/title>/);
    const moved = await call('PATCH', '/api/devices/D-03', { json: { floorId: id } });
    assert.equal(moved.status, 409, 'D-03 partage la zone « Salle serveurs » avec C-03 et E-01 : une zone appartient a un seul etage');
    assert.match(moved.body.error, /une zone appartient a un seul etage/);
    const created2 = await call('POST', '/api/devices', { json: { id: 'D-50', kind: 'detector', name: 'Chambre parents', zone: 'Etage - Chambre parents', floorId: id } });
    assert.equal(created2.status, 201, JSON.stringify(created2.body));
    assert.equal(created2.body.floorId, id);
    const state = await call('GET', '/api/state', { cookie: operator });
    assert.deepEqual(state.body.floors.map((f: { name: string; hasPlan: boolean }) => [f.name, f.hasPlan]), [[DEFAULT_FLOOR_NAME, true], ['Étage', true]]);
    assert.equal(state.body.devices.find((d: { id: string }) => d.id === 'D-50').floorId, id);
  });

  it("l'ancien plan unique (/api/plan) reste celui de l'etage le plus bas", async () => {
    const legacy = await call('GET', '/api/plan', { cookie: operator });
    const first = await call('GET', `/api/floors/${(await call('GET', '/api/state')).body.floors[0].id}/plan`, { cookie: operator });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body, first.body);
  });

  it("refus : operateur (403), etage inconnu (404), identifiant invalide (400), etage occupe ou dernier (409)", async () => {
    assert.equal((await call('POST', '/api/floors', { cookie: operator, json: { name: 'Pirate' } })).status, 403);
    assert.equal((await call('PUT', '/api/floors/1/plan', { cookie: operator, body: SVG('x'), type: 'image/svg+xml' })).status, 403);
    assert.equal((await call('GET', '/api/floors/999/plan')).status, 404);
    assert.equal((await call('GET', '/api/floors/abc/plan')).status, 400);
    assert.equal((await call('PATCH', '/api/floors/1', { json: { position: 'haut' } })).status, 400);
    const floors = (await call('GET', '/api/state')).body.floors as { id: number }[];
    const busy = await call('DELETE', `/api/floors/${floors[1].id}`);
    assert.equal(busy.status, 409);
    assert.match(busy.body.error, /1 equipement/);
    assert.equal((await call('DELETE', '/api/devices/D-50')).status, 204);
    assert.equal((await call('DELETE', `/api/floors/${floors[1].id}`)).status, 204);
    assert.equal((await call('DELETE', `/api/floors/${floors[0].id}`)).status, 409, 'le dernier etage reste');
    assert.equal((await call('GET', `/api/floors/${floors[1].id}/plan`)).status, 404);
  });

  it("chaque changement d'etage est au journal", async () => {
    const audit = (await call('GET', '/api/audit?limit=50')).body as { action: string; details: string | null }[];
    const actions = audit.map((e) => e.action);
    for (const a of ['floor_created', 'plan_updated', 'floor_deleted']) assert.ok(actions.includes(a), a);
    assert.ok(audit.some((e) => e.action === 'device_created' && /Chambre parents/.test(e.details ?? '')));
  });
});
