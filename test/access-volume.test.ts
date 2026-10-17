/**
 * Controle d'acces : tenue en charge (lot AC2). Objectif du PRD (§ 8.6) : 10 000 passages par jour, recherche sur 3 mois en moins de
 * 2 secondes, sans ralentir la supervision. Ce test insere environ 900 000 passages (10 000 par jour sur 90 jours, 20 portes,
 * 500 badges) puis MESURE et AFFICHE la duree de chaque operation, et le cout d'ingestion d'un passage avec et sans le module.
 *
 * Il n'est lance que sur demande (il prend quelques dizaines de secondes) :
 *     PSIM_VOLUME_TEST=1 node --test test/access-volume.test.ts
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { createAccess, holderKey, migrateAccess } from '../server/access.ts';
import type { AccessService } from '../server/access.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import type { Engine } from '../server/engine.ts';
import { seedDemo } from '../server/seed.ts';

const enabled = process.env.PSIM_VOLUME_TEST === '1';
const skip = enabled ? false : 'mesure de volume : lancer avec PSIM_VOLUME_TEST=1';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const SEED = join(import.meta.dirname, '..', 'seed');
const DAYS = 90;
const PER_DAY = 10_000;
const DOORS = 20;
const BADGES = 500;
const INGEST_MESSAGES = 2000;

const say = (line: string): void => console.log(line);
const ms = (n: number): string => `${n.toFixed(n < 10 ? 2 : 1)} ms`;

/** Duree (ms) d'une operation : mediane de `runs` executions. */
function measure(label: string, fn: () => unknown, runs = 3): number {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  say(`  ${label.padEnd(58)} ${ms(median).padStart(11)}   (min ${ms(times[0])}, max ${ms(times[times.length - 1])})`);
  return median;
}

describe('volume du journal des acces', { skip }, () => {
  let dir: string;
  let db: DatabaseSync;
  let access: AccessService;
  let engine: Engine;
  let clock = NOW;
  const start = NOW - (DAYS + 1) * DAY; // 90 jours de donnees, de J-91 a J-1 : la purge a 90 jours retire le premier jour

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'psim-volume-'));
    db = openDb(join(dir, 'psim.db'));
    seedDemo(db, dir, SEED);
    const key = randomBytes(32);
    access = createAccess({
      db, now: () => clock, key,
      audit: (a, act, ref) => engine.audit(a, act, ref),
      setDeviceState: (id, state, event) => engine.setStateBySupervisor(id, state, event),
    });
    engine = createEngine(db, () => {}, () => clock, { access });
    access.createController('admin', { id: 'CTL-1', name: 'Controleur entree', brand: 'dahua' });
    access.declareDoor('admin', { detectorId: 'A-01', controllerId: 'CTL-1', doorNo: 1 });

    // 500 titulaires et leurs badges, puis 900 000 passages en une transaction (generateur SQL : une seule requete).
    db.exec('CREATE TEMP TABLE person (k INTEGER PRIMARY KEY, credential TEXT, name TEXT, key TEXT, ref TEXT)');
    const insertPerson = db.prepare('INSERT INTO person VALUES (?, ?, ?, ?, ?)');
    const firstNames = ['Yao', 'Kofi', 'Awa', 'Fatou', 'Moussa', 'Aya', 'Koffi', 'Mariam', 'Ibrahim', 'Adjoua'];
    const lastNames = ['KONAN', 'TRAORE', 'COULIBALY', 'DIALLO', 'KOUAME', 'BAMBA', 'OUATTARA', "N'GUESSAN", 'SANGARE', 'YAO'];
    for (let k = 0; k < BADGES; k++) {
      const name = `${lastNames[k % 10]} ${firstNames[Math.floor(k / 10) % 10]} ${k}`;
      insertPerson.run(k, String(k).padStart(7, '0'), name, holderKey(name), String(100 + k));
    }
    const total = DAYS * PER_DAY;
    const t0 = process.hrtime.bigint();
    // Les index sont recrees apres l'insertion en masse (trois fois plus rapide que de les tenir a jour ligne par ligne) ; ils
    // sont identiques ensuite, a la compacite des pages pres.
    db.exec('DROP INDEX access_event_by_time; DROP INDEX access_event_by_door; DROP INDEX access_event_by_credential; DROP INDEX access_event_by_device_event;');
    db.exec('BEGIN');
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO access_event (door_id, controller_id, at_device, at_received, direction, credential, holder_name, holder_key, holder_ref, method, result, reason, device_event_id, late)
       SELECT CASE WHEN n.i % ${DOORS} = 0 THEN 'A-01' ELSE 'V-' || printf('%02d', n.i % ${DOORS}) END, 'CTL-1',
              ? + (n.i / ${PER_DAY}) * ${DAY} + (n.i % ${PER_DAY}) * ${Math.floor(DAY / PER_DAY)}, ? + (n.i / ${PER_DAY}) * ${DAY} + (n.i % ${PER_DAY}) * ${Math.floor(DAY / PER_DAY)} + 400,
              CASE n.i % 3 WHEN 0 THEN 'in' WHEN 1 THEN 'out' ELSE NULL END, p.credential, p.name, p.key, p.ref,
              'badge', CASE WHEN n.i % 10 = 7 THEN 'denied' ELSE 'granted' END, CASE WHEN n.i % 10 = 7 THEN 'unknown_credential' ELSE NULL END,
              'v' || n.i, CASE WHEN n.i % 200 = 0 THEN 1 ELSE 0 END
         FROM n JOIN person p ON p.k = n.i % ${BADGES}`,
    ).run(total - 1, start, start);
    db.exec('COMMIT');
    migrateAccess(db);
    const inserted = (db.prepare('SELECT COUNT(*) AS n FROM access_event').get() as { n: number }).n;
    say(`\nVolume : ${inserted.toLocaleString('fr-FR')} passages (${PER_DAY.toLocaleString('fr-FR')}/jour sur ${DAYS} jours, ${DOORS} portes, ${BADGES} badges), insertion SQL en ${ms(Number(process.hrtime.bigint() - t0) / 1e6)}`);
    assert.equal(inserted, total);
    clock = NOW;
  });

  after(() => {
    try {
      db.close();
    } catch {
      /* deja ferme */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows garde parfois un verrou sur le fichier de la base juste apres sa fermeture : sans importance pour un dossier temporaire */
    }
  });

  it('recherches, export et purge sur 900 000 passages', () => {
    say('\nRecherche (premiere page de 50, mediane de 3 executions)');
    const week = [NOW - 45 * DAY, NOW - 38 * DAY];
    const results = {
      semaine: measure('par periode (une semaine)', () => access.search({ from: week[0], to: week[1] }, 'perf')),
      periodeComplete: measure('par periode (les 90 jours)', () => access.search({ from: start, to: NOW }, 'perf')),
      sansFiltre: measure('sans filtre (50 plus recents)', () => access.search({}, 'perf')),
      porte: measure('par porte (A-01, ~45 000 passages)', () => access.search({ door: 'A-01' }, 'perf')),
      porteEtSemaine: measure('par porte et par semaine', () => access.search({ door: 'V-05', from: week[0], to: week[1] }, 'perf')),
      badgeComplet: measure('par badge (numero complet, ~1 800 passages)', () => access.search({ credential: '0000042' }, 'perf')),
      badgeUnChiffre: measure('par badge (prefixe a 1 chiffre : tous les passages)', () => access.search({ credential: '0' }, 'perf')),
      badgeAbsent: measure('par badge (numero absent)', () => access.search({ credential: '9999999' }, 'perf')),
      badgePrefixe: measure('par badge (prefixe de 5 chiffres, ~180 000 passages)', () => access.search({ credential: '00001' }, 'perf')),
      titulaire: measure('par titulaire (LIKE, nom frequent)', () => access.search({ holder: 'konan yao' }, 'perf')),
      titulaireAbsent: measure('par titulaire (LIKE, nom absent : parcours complet)', () => access.search({ holder: 'zzzzzz' }, 'perf')),
      refus: measure('refus seulement', () => access.search({ result: 'denied' }, 'perf')),
      differes: measure('recus en differe seulement', () => access.search({ late: '1' }, 'perf')),
      count: measure('count=1 (sans filtre, plafonne a 10 000)', () => access.search({ count: '1' }, 'perf')),
      countAbsent: measure('count=1 (titulaire absent : parcours complet)', () => access.search({ count: '1', holder: 'zzzzzz' }, 'perf')),
      countSemaine: measure('count=1 (une semaine)', () => access.search({ count: '1', from: week[0], to: week[1] }, 'perf')),
    };
    // pagination : 20 pages de suite en suivant les curseurs (pas de degradation en profondeur)
    const deep = measure('20 pages de suite (curseurs), duree totale', () => {
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const r: ReturnType<AccessService['search']> = access.search({ cursor: cursor ?? undefined }, 'perf');
        cursor = r.nextCursor;
      }
    }, 1);
    const totalWeek = access.search({ count: '1', from: week[0], to: week[1] }, 'perf');
    assert.equal(totalWeek.total, 10_000); // 70 000 passages dans la semaine : plafonne
    assert.equal(totalWeek.totalCapped, true);
    for (const [name, t] of Object.entries({ ...results, deep })) assert.ok(t < 2000, `${name} : ${t.toFixed(0)} ms, la limite est de 2 000 ms`);

    say('\nExport CSV');
    let exported: ReturnType<AccessService['exportCsv']> | null = null;
    const exportMs = measure('export de 100 000 lignes (tronque)', () => {
      exported = access.exportCsv({}, 'perf');
    }, 1);
    assert.equal(exported!.rows, 100_000);
    assert.equal(exported!.truncated, true);
    say(`  taille du fichier : ${(exported!.csv.length / 1_048_576).toFixed(1)} Mo`);
    const weekExport = measure('export d une semaine par porte', () => access.exportCsv({ door: 'V-05', from: week[0], to: week[1] }, 'perf'), 1);
    assert.ok(exportMs < 30_000 && weekExport < 30_000);

    say('\nPurge (conservation 90 jours : le premier jour de donnees est echu)');
    const before = (db.prepare('SELECT COUNT(*) AS n FROM access_event').get() as { n: number }).n;
    let purged = { deleted: 0, remaining: 0 };
    const purgeMs = measure('purge d un jour (10 000 lignes, un lot)', () => {
      purged = access.purge();
    }, 1);
    say(`  supprime : ${purged.deleted.toLocaleString('fr-FR')} ligne(s), reste a purger : ${purged.remaining}`);
    assert.equal(purged.deleted, PER_DAY);
    assert.equal(purged.remaining, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM access_event').get() as { n: number }).n, before - PER_DAY);
    assert.ok(purgeMs < 10_000);
    const again = measure('purge suivante (rien a supprimer)', () => access.purge(), 1);
    assert.ok(again < 2000);
    const settings = measure('settings() (compte total, plus ancien)', () => access.settings(), 3);
    assert.ok(settings < 2000);
  });

  it(`cout d'ingestion : ${INGEST_MESSAGES} passages avec le module sur 900 000 lignes, contre le moteur seul`, () => {
    // Moteur SEUL : memes messages, sur une base de meme forme mais vide, sans module d'acces (le champ access est ignore).
    const plainDb = openDb(join(dir, 'plain.db'));
    seedDemo(plainDb, dir, SEED);
    const plain = createEngine(plainDb, () => {}, () => clock, {});

    let counter = 0;
    const message = (): unknown => {
      const n = ++counter;
      return {
        event: 'badge_granted', ts: clock - 2000, msgId: `acc:CTL-1:m${n}`,
        access: { v: 1, controllerId: 'CTL-1', eventId: `m${n}`, direction: 'in', credential: String(n % BADGES).padStart(7, '0'), holderName: `KONAN Yao ${n % BADGES}`, holderRef: String(100 + (n % BADGES)), method: 'badge', result: 'granted', reason: null, deferred: false },
      };
    };
    const run = (e: Engine): number => {
      const batch = Array.from({ length: INGEST_MESSAGES }, message);
      const t0 = process.hrtime.bigint();
      for (const m of batch) {
        const r = e.ingest('A-01', m);
        if (!r.ok) throw new Error(r.error);
      }
      return Number(process.hrtime.bigint() - t0) / 1000 / INGEST_MESSAGES; // microsecondes par message
    };
    // Chauffe (compilation des requetes, cache de pages), puis mesure ; trois passes, la meilleure est retenue (bruit du disque).
    run(engine);
    run(plain);
    const withModule: number[] = [];
    const without: number[] = [];
    for (let pass = 0; pass < 3; pass++) {
      withModule.push(run(engine));
      without.push(run(plain));
    }
    const usWith = Math.min(...withModule);
    const usWithout = Math.min(...without);
    say(`\nIngestion de ${INGEST_MESSAGES} messages badge_granted (base sur disque, 3 passes, meilleure retenue)`);
    say(`  moteur seul (base vide)                         ${usWithout.toFixed(0).padStart(8)} us/message   (passes : ${without.map((x) => x.toFixed(0)).join(', ')})`);
    say(`  moteur + journal des acces (~890 000 lignes)    ${usWith.toFixed(0).padStart(8)} us/message   (passes : ${withModule.map((x) => x.toFixed(0)).join(', ')})`);
    say(`  rapport : x${(usWith / usWithout).toFixed(2)}  (supplement du journal : ${(usWith - usWithout).toFixed(0)} us/message)`);

    const stored = (db.prepare("SELECT COUNT(*) AS n FROM access_event WHERE device_event_id LIKE 'm%'").get() as { n: number }).n;
    assert.equal(stored, INGEST_MESSAGES * 4); // chauffe + 3 passes, tous enregistres
    assert.ok(usWith < 3 * usWithout, `ingestion avec le module : ${usWith.toFixed(0)} us, plus de 3 fois le moteur seul (${usWithout.toFixed(0)} us)`);
    assert.ok(usWith < 2000, `ingestion avec le module : ${usWith.toFixed(0)} us/message, la limite est de 2 000 us`);
    plainDb.close();
  });
});
