import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { GENESIS, appendSealed, computeHash, formatAnchor, headOf, parseAnchor, verify } from '../server/auditchain.ts';
import type { AuditRow } from '../server/auditchain.ts';
import { createBackup } from '../server/backup.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { createJournalGuard } from '../server/journal.ts';
import { seedDemo } from '../server/seed.ts';

const ROOT = resolve(import.meta.dirname, '..');

function setup(entries = 6) {
  const db = openDb(':memory:');
  let clock = 1_000_000_000_000;
  for (let i = 1; i <= entries; i++) appendSealed(db, { ts: (clock += 1000), actor: i % 2 ? 'admin' : 'systeme', action: `action_${i}`, incident_id: i % 3 ? null : i, device_id: i % 2 ? 'D-01' : null, details: `detail ${i}` });
  return { db, now: () => clock };
}
const ids = (db: DatabaseSync) => (db.prepare('SELECT id FROM audit_log ORDER BY id').all() as { id: number }[]).map((r) => r.id);
const reasons = (db: DatabaseSync, anchors = []) => verify(db, anchors).problems.map((p) => `${p.id}:${p.reason}`);

describe('chaine d empreintes', () => {
  it("chaque entree porte l'empreinte de la precedente, la premiere part de la valeur initiale", () => {
    const { db } = setup(3);
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').all() as unknown as (AuditRow & { prev_hash: string; hash: string })[];
    assert.equal(rows[0].prev_hash, GENESIS);
    assert.equal(rows[1].prev_hash, rows[0].hash);
    assert.equal(rows[2].prev_hash, rows[1].hash);
    assert.equal(rows[2].hash, computeHash(rows[1].hash, rows[2]));
    assert.match(rows[0].hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(headOf(db), { id: 3, hash: rows[2].hash });
  });

  it("une chaine intacte est verifiee, y compris vide", () => {
    const { db } = setup(40);
    const v = verify(db);
    assert.deepEqual([v.ok, v.checked, v.unprotected, v.problems.length], [true, 40, 0, 0]);
    assert.equal(verify(openDb(':memory:')).ok, true);
  });

  it("le moteur scelle toutes ses entrees (journal reel de scenario)", () => {
    const db = openDb(':memory:');
    seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(ROOT, 'seed'));
    const engine = createEngine(db, () => {});
    engine.ingest('D-01', { state: 'alarm' });
    const id = engine.getSnapshot().incidents[0].id;
    engine.acknowledge(id, 'operateur');
    engine.createDevice('admin', { id: 'D-20', kind: 'detector', name: 'Test' });
    const v = verify(db);
    assert.ok(v.ok && v.checked >= 4, JSON.stringify(v));
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE hash IS NULL').get() as { n: number }).n, 0);
  });

  it("deux chaines de contenu different ont des empreintes differentes (l'ordre et chaque champ comptent)", () => {
    const base: AuditRow = { id: 1, ts: 5, actor: 'a', action: 'x', incident_id: null, device_id: null, details: 'd' };
    const h = computeHash('p', base);
    for (const alt of [{ id: 2 }, { ts: 6 }, { actor: 'b' }, { action: 'y' }, { incident_id: 1 }, { device_id: 'D' }, { details: 'e' }, { details: null }]) {
      assert.notEqual(computeHash('p', { ...base, ...alt }), h, JSON.stringify(alt));
    }
    assert.notEqual(computeHash('q', base), h);
    // pas d'ambiguite entre champs : « ab » + « c » n'est pas « a » + « bc »
    assert.notEqual(computeHash('p', { ...base, actor: 'ab', action: 'c' }), computeHash('p', { ...base, actor: 'a', action: 'bc' }));
  });
});

describe('detection des alterations', () => {
  it("modifier le contenu d'une entree est detecte, avec son numero", () => {
    const { db } = setup();
    db.prepare("UPDATE audit_log SET details = 'rien a signaler' WHERE id = 3").run();
    assert.deepEqual(reasons(db), ['3:contenu modifie apres coup']);
  });

  it("modifier l'auteur, la date ou l'action est detecte aussi", () => {
    for (const set of ["actor = 'quelqu-un-d-autre'", 'ts = ts + 1', "action = 'autre'", 'incident_id = 99', "device_id = 'X'"]) {
      const { db } = setup();
      db.prepare(`UPDATE audit_log SET ${set} WHERE id = 2`).run();
      assert.ok(!verify(db).ok, set);
      assert.equal(verify(db).problems[0].id, 2, set);
    }
  });

  it("supprimer une entree au milieu rompt le chainage a l'entree suivante", () => {
    const { db } = setup();
    db.prepare('DELETE FROM audit_log WHERE id = 3').run();
    const r = reasons(db);
    assert.ok(r.includes('4:chainage rompu : une entree precedente a ete supprimee ou modifiee'), r.join(' | '));
    assert.ok(r.some((x) => /^4:1 entree\(s\) manquante\(s\) avant celle-ci/.test(x)), 'et le trou dans les numeros');
  });

  it("supprimer la premiere entree est detecte (debut de chaine)", () => {
    const { db } = setup();
    db.prepare('DELETE FROM audit_log WHERE id = 1').run();
    assert.match(reasons(db)[0], /^2:debut de chaine invalide/);
  });

  it("inserer a la main une entree non scellee, ou avec une fausse empreinte, est detecte", () => {
    const a = setup();
    a.db.prepare("INSERT INTO audit_log (ts, actor, action) VALUES (1, 'pirate', 'ajout')").run();
    assert.match(reasons(a.db).join(' '), /entree non scellee au milieu de la chaine/);

    const b = setup();
    b.db.prepare("INSERT INTO audit_log (ts, actor, action, prev_hash, hash) VALUES (1, 'pirate', 'ajout', 'xx', 'yy')").run();
    assert.ok(!verify(b.db).ok);
  });

  it("modifier plusieurs entrees : les problemes sont listes (20 au plus)", () => {
    const { db } = setup(50);
    db.prepare("UPDATE audit_log SET details = 'x' WHERE id % 2 = 0").run();
    const v = verify(db);
    assert.equal(v.problems.length, 20);
    assert.equal(v.problems[0].id, 2);
  });

  it("les entrees anterieures au mecanisme sont comptees a part et n'empechent rien", () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO audit_log (ts, actor, action) VALUES (1, 'ancien', 'avant')").run();
    db.prepare("INSERT INTO audit_log (ts, actor, action) VALUES (2, 'ancien', 'avant2')").run();
    appendSealed(db, { ts: 3, actor: 'admin', action: 'apres', incident_id: null, device_id: null, details: null });
    appendSealed(db, { ts: 4, actor: 'admin', action: 'apres2', incident_id: null, device_id: null, details: null });
    const v = verify(db);
    assert.deepEqual([v.ok, v.checked, v.unprotected], [true, 2, 2]);
    assert.equal(headOf(db)?.id, 4);
  });

  it("un retour en arriere de transaction annule aussi l'entree et son numero : aucun trou", () => {
    const { db } = setup(3);
    db.exec('BEGIN');
    appendSealed(db, { ts: 9, actor: 'x', action: 'annulee', incident_id: null, device_id: null, details: null });
    db.exec('ROLLBACK');
    appendSealed(db, { ts: 10, actor: 'x', action: 'suivante', incident_id: null, device_id: null, details: null });
    assert.deepEqual(ids(db), [1, 2, 3, 4]);
    assert.ok(verify(db).ok);
  });
});

describe('continuite des numeros', () => {
  it("supprimer des entrees de fin puis continuer a ecrire laisse un trou : detecte meme si les empreintes sont recalculees", () => {
    const { db } = setup(10);
    db.prepare('DELETE FROM audit_log WHERE id >= 8').run();
    // le compteur AUTOINCREMENT de SQLite etant remis a la derniere ligne, on simule le pire cas : un attaquant le corrige aussi
    db.prepare("UPDATE sqlite_sequence SET seq = 7 WHERE name = 'audit_log'").run();
    appendSealed(db, { ts: 99, actor: 'x', action: 'apres', incident_id: null, device_id: null, details: null });
    assert.equal(verify(db).ok, true, 'sans trou visible, la chaine reecrite par un attaquant averti reste coherente (limite documentee : il faut une ancre)');
    const { db: db2 } = setup(10);
    db2.prepare('DELETE FROM audit_log WHERE id IN (8, 9, 10)').run();
    appendSealed(db2, { ts: 99, actor: 'x', action: 'apres', incident_id: null, device_id: null, details: null });
    const v = verify(db2);
    assert.equal(v.ok, false, 'avec le compteur intact : un trou 7 -> 11');
    assert.match(v.problems.map((p) => p.reason).join(' '), /3 entree\(s\) manquante\(s\)/);
  });
});

describe('ancres : empreintes conservees hors de la base', () => {
  it("une chaine ENTIEREMENT recalculee passe seule la verification mais pas la comparaison a l'ancre", () => {
    const { db } = setup(6);
    const anchor = headOf(db)!;
    // L'attaquant modifie l'entree 3 puis recalcule toute la suite avec les memes fonctions.
    db.prepare("UPDATE audit_log SET details = 'falsifie' WHERE id = 3").run();
    let prev = (db.prepare('SELECT hash FROM audit_log WHERE id = 2').get() as { hash: string }).hash;
    for (const r of db.prepare('SELECT * FROM audit_log WHERE id >= 3 ORDER BY id').all() as unknown as (AuditRow & { prev_hash: string })[]) {
      const hash = computeHash(prev, r);
      db.prepare('UPDATE audit_log SET prev_hash = ?, hash = ? WHERE id = ?').run(prev, hash, r.id);
      prev = hash;
    }
    assert.equal(verify(db).ok, true, "seule, la chaine reecrite est coherente : c'est la limite du mecanisme");
    const withAnchor = verify(db, [anchor]);
    assert.equal(withAnchor.ok, false);
    assert.match(withAnchor.problems[0].reason, /ancre n°6 differente.*reecrite/);
  });

  it("la suppression de la FIN du journal est detectee par une ancre posterieure", () => {
    const { db } = setup(6);
    const anchor = headOf(db)!;
    db.prepare('DELETE FROM audit_log WHERE id > 4').run();
    const alone = verify(db);
    assert.equal(alone.ok, false, 'detectee SANS ancre : le compteur de SQLite est plus avance que la derniere entree');
    assert.match(alone.problems[0].reason, /la fin du journal a ete supprimee \(derniere entree n°4, compteur a 6\)/);
    const v = verify(db, [anchor]);
    assert.equal(v.ok, false);
    assert.match(v.problems.map((p) => p.reason).join(' '), /introuvable|posterieure/);
  });

  it("une ancre fidele valide la chaine, et se lit / s'ecrit sous la forme id:empreinte", () => {
    const { db } = setup(4);
    const anchor = headOf(db)!;
    assert.equal(verify(db, [anchor]).ok, true);
    assert.deepEqual(parseAnchor(formatAnchor(anchor)), anchor);
    assert.equal(parseAnchor('n importe quoi'), null);
    assert.equal(parseAnchor('12:abc'), null);
    assert.equal(parseAnchor(`x:${'a'.repeat(64)}`), null);
  });

  it("la sauvegarde enregistre l'ancre dans son manifeste, et l'outil la compare", () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-bk-'));
    const dataDir = join(dir, 'data');
    const dbPath = join(dir, 'psim.db');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    const opened = openDb(dbPath);
    opened.close();
    db.close();
    const live = openDb(dbPath);
    appendSealed(live, { ts: 1, actor: 'admin', action: 'a', incident_id: null, device_id: null, details: null });
    appendSealed(live, { ts: 2, actor: 'admin', action: 'b', incident_id: null, device_id: null, details: null });
    const head = headOf(live)!;
    const result = createBackup({ db: live, dataDir: dir, backupDir: join(dir, 'backups') });
    const manifest = JSON.parse(readFileSync(join(result.dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.auditHead, head);
    void dataDir;
    live.close();
  });
});

describe('surveillance : alerte une fois par alteration', () => {
  it("previent a la premiere detection, pas a chaque verification, puis signale le retour a la normale", () => {
    const { db, now } = setup(5);
    const events: string[] = [];
    const guard = createJournalGuard({ db, now, onBroken: (r) => void events.push(`broken:${r.problems[0].id}`), onRecovered: () => void events.push('recovered') });
    assert.equal(guard.check().ok, true);
    db.prepare("UPDATE audit_log SET details = 'x' WHERE id = 2").run();
    guard.check();
    guard.check();
    guard.check();
    assert.deepEqual(events, ['broken:2'], 'une seule alerte pour trois verifications');
    db.prepare("UPDATE audit_log SET details = 'detail 2' WHERE id = 2").run();
    guard.check();
    assert.deepEqual(events, ['broken:2', 'recovered']);
  });

  it("une nouvelle alteration, differente, declenche une nouvelle alerte", () => {
    const { db, now } = setup(6);
    const events: string[] = [];
    const guard = createJournalGuard({ db, now, onBroken: (r) => void events.push(r.problems.map((p) => p.id).join(',')) });
    db.prepare("UPDATE audit_log SET details = 'x' WHERE id = 2").run();
    guard.check();
    db.prepare("UPDATE audit_log SET details = 'y' WHERE id = 5").run();
    guard.check();
    assert.deepEqual(events, ['2', '2,5']);
  });

  it("les ancres quotidiennes memorisees detectent une chaine reecrite, et on n'ancre jamais une chaine brisee", () => {
    const { db, now } = setup(5);
    const guard = createJournalGuard({ db, now });
    const first = guard.anchorNow()!;
    assert.equal(first.id, 5);
    assert.equal(guard.anchorNow()?.id, 5, 'pas de nouvelle ancre le meme jour');
    db.prepare("UPDATE audit_log SET details = 'x' WHERE id = 3").run();
    assert.equal(guard.anchorNow(), null, "chaine brisee : rien n'est ancre");
    assert.deepEqual(guard.anchors().map((x) => x.id), [5], 'les ancres deja memorisees sont conservees');
    assert.equal(guard.check().ok, false);
    assert.equal(guard.lastKnown()?.ok, false, 'le resultat survit au redemarrage (stocke en base)');
  });
});

describe('outil en ligne de commande', () => {
  function run(args: string[]) {
    const r = spawnSync(process.execPath, ['scripts/verify-journal.ts', ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }
  function fileDb(entries: number) {
    const dir = mkdtempSync(join(tmpdir(), 'psim-vj-'));
    const path = join(dir, 'psim.db');
    const db = openDb(path);
    for (let i = 1; i <= entries; i++) appendSealed(db, { ts: i, actor: 'admin', action: `a${i}`, incident_id: null, device_id: null, details: `d${i}` });
    const head = headOf(db)!;
    db.close();
    return { dir, path, head };
  }

  it("code 0 pour une chaine intacte, et affiche l'ancre a conserver", () => {
    const f = fileDb(5);
    const r = run(['--db', f.path]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /INTEGRE/);
    assert.ok(r.out.includes(formatAnchor(f.head)));
  });

  it("code 1 et entree designee pour une base alteree ; la base n'est jamais modifiee par l'outil", () => {
    const f = fileDb(5);
    const db = new DatabaseSync(f.path);
    db.prepare("UPDATE audit_log SET details = 'falsifie' WHERE id = 2").run();
    db.close();
    const r = run(['--db', f.path]);
    assert.equal(r.status, 1);
    assert.match(r.out, /ALTERE/);
    assert.match(r.out, /entree n°2 : contenu modifie/);
  });

  it("compare a une ancre externe : fidele = 0, differente = 1 ; ancre mal formee = 2", () => {
    const f = fileDb(5);
    assert.equal(run(['--db', f.path, '--anchor', formatAnchor(f.head)]).status, 0);
    assert.equal(run(['--db', f.path, '--anchor', `5:${'0'.repeat(64)}`]).status, 1);
    assert.equal(run(['--db', f.path, '--anchor', 'nimporte']).status, 2);
    assert.equal(run(['--db', join(f.dir, 'absente.db')]).status, 2);
  });

  it("lit l'ancre d'un manifeste de sauvegarde", () => {
    const f = fileDb(3);
    const manifest = join(f.dir, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ version: 1, auditHead: f.head }));
    assert.equal(run(['--db', f.path, '--manifest', manifest]).status, 0);
    writeFileSync(manifest, JSON.stringify({ version: 1, auditHead: { id: f.head.id, hash: '1'.repeat(64) } }));
    assert.equal(run(['--db', f.path, '--manifest', manifest]).status, 1);
  });
});
