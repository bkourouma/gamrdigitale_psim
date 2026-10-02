import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import type { EngineOptions } from '../server/engine.ts';
import { seedDemo } from '../server/seed.ts';
import type { Incident, PsimEvent } from '../server/types.ts';

const T0 = 1_000_000_000_000;
const S = 1000;
const RULES: EngineOptions = { confirmWindowMs: 60 * S, persistMs: 120 * S, hintMs: 30 * S };

/**
 * Site de demonstration : D-05 (entrepot) et D-06 (atelier) partagent la camera C-04 : voisins.
 * D-01 (accueil) et D-07 (stockage) n'ont aucune camera en commun : ils ne sont pas voisins.
 */
function setup(options: EngineOptions = RULES) {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  const events: PsimEvent[] = [];
  let clock = T0;
  const engine = createEngine(db, (e) => events.push(e), () => clock, options);
  return {
    db,
    engine,
    events,
    advance: (seconds: number) => void (clock += seconds * S),
    send: (id: string, state: string) => engine.handleDetectorMessage(id, { state }),
    incident: (detectorId: string): Incident => {
      const found = engine.getSnapshot().incidents.find((i) => i.detectorId === detectorId && i.status !== 'closed');
      assert.ok(found, `incident de ${detectorId}`);
      return found;
    },
    actions: () => engine.listAudit(200).map((a) => a.action),
  };
}

describe('regles anti-fausses alarmes : ce qu\'elles ne font JAMAIS', () => {
  it("une alarme isolee ouvre l'incident IMMEDIATEMENT, en critique, sans delai ni attente de confirmation", () => {
    const t = setup();
    t.send('D-01', 'alarm');
    const incident = t.incident('D-01');
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.status, 'open');
    assert.equal(incident.confirmedAt, null, 'a confirmer, mais bien la, bien visible');
    assert.ok(t.events.some((e) => e.type === 'incident'), 'les ecrans sont prevenus tout de suite');
  });

  it("ne ferme jamais un incident tout seul, meme avec un indice de fausse alarme", () => {
    const t = setup();
    t.send('D-01', 'prealarm');
    t.advance(10);
    t.send('D-01', 'normal');
    t.advance(86_400);
    t.engine.tick();
    const incident = t.incident('D-01');
    assert.equal(incident.hint, 'false_alarm_likely');
    assert.notEqual(incident.status, 'closed', "l'operateur doit toujours qualifier");
    assert.equal(incident.qualification, null);
  });

  it("l'indice ne baisse ni la gravite ni la visibilite : une alarme revenue vite a la normale reste critique", () => {
    const t = setup();
    t.send('D-07', 'alarm');
    t.advance(5);
    t.send('D-07', 'normal');
    const incident = t.incident('D-07');
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.hint, 'false_alarm_likely');
    assert.equal(incident.status, 'open', 'toujours a acquitter');
  });

  it("desactivees (delais a 0), les regles ne changent rien : ni confirmation ni indice", () => {
    const t = setup({});
    t.send('D-05', 'alarm');
    t.send('D-06', 'alarm');
    t.advance(10_000);
    t.engine.tick();
    for (const id of ['D-05', 'D-06']) {
      assert.equal(t.incident(id).confirmedAt, null);
      assert.equal(t.incident(id).hint, null);
    }
    t.send('D-06', 'normal');
    assert.equal(t.incident('D-06').hint, null);
    assert.ok(!t.actions().includes('incident_confirmed') && !t.actions().includes('incident_hint'));
  });
});

describe('confirmation par coincidence (detecteur voisin)', () => {
  it('deux detecteurs voisins qui se declenchent confirment CHACUN des deux incidents', () => {
    const t = setup();
    t.send('D-06', 'prealarm');
    assert.equal(t.incident('D-06').confirmedAt, null);
    t.advance(10);
    t.send('D-05', 'prealarm');
    assert.equal(t.incident('D-05').confirmationReason, 'neighbor:D-06');
    assert.equal(t.incident('D-06').confirmationReason, 'neighbor:D-05', 'le premier est confirme retroactivement');
    assert.ok(t.incident('D-06').confirmedAt !== null);
  });

  it("des detecteurs non voisins ne se confirment pas", () => {
    const t = setup();
    t.send('D-01', 'alarm');
    t.send('D-07', 'alarm');
    assert.equal(t.incident('D-01').confirmedAt, null);
    assert.equal(t.incident('D-07').confirmedAt, null);
  });

  it('un detecteur de la meme zone est voisin, meme sans camera commune', () => {
    const t = setup();
    t.engine.createDevice('admin', { id: 'D-08', kind: 'detector', name: 'Deuxieme detecteur accueil', zone: 'Accueil' });
    t.send('D-01', 'prealarm');
    t.send('D-08', 'prealarm');
    assert.equal(t.incident('D-01').confirmationReason, 'neighbor:D-08');
  });

  it('un voisin qui s\'est declenche puis est revenu a la normale confirme encore, dans la fenetre', () => {
    const t = setup();
    t.send('D-06', 'prealarm');
    t.advance(8);
    t.send('D-06', 'normal');
    t.advance(30);
    t.send('D-05', 'prealarm'); // 38 s apres le voisin : dans la fenetre de 60 s
    assert.equal(t.incident('D-05').confirmationReason, 'neighbor:D-06');
  });

  it('hors de la fenetre, un voisin revenu a la normale ne confirme plus', () => {
    const t = setup();
    t.send('D-06', 'prealarm');
    t.advance(8);
    t.send('D-06', 'normal');
    t.advance(120); // bien apres les 60 s
    t.send('D-05', 'prealarm');
    assert.equal(t.incident('D-05').confirmedAt, null);
  });

  it("une confirmation est une aggravation : un incident deja acquitte redevient « non acquitte »", () => {
    const t = setup();
    t.send('D-06', 'prealarm');
    t.engine.acknowledge(t.incident('D-06').id, 'operateur');
    assert.equal(t.incident('D-06').status, 'acknowledged');
    t.advance(20);
    t.send('D-05', 'alarm');
    const after = t.incident('D-06');
    assert.equal(after.status, 'open', "l'alerte repart");
    assert.equal(after.ackedBy, null);
    assert.ok(after.confirmedAt !== null);
    assert.ok(t.actions().includes('incident_confirmed'));
  });
});

describe('confirmation par persistance', () => {
  it('une alarme qui dure est confirmee au bout du delai, pas avant', () => {
    const t = setup();
    t.send('D-01', 'alarm');
    t.advance(119);
    t.engine.tick();
    assert.equal(t.incident('D-01').confirmedAt, null);
    t.advance(2);
    t.engine.tick();
    assert.equal(t.incident('D-01').confirmationReason, 'persistence');
  });

  it('les signaux de vie repetes (meme etat) ne remettent pas le compteur a zero', () => {
    const t = setup();
    t.send('D-01', 'alarm');
    for (let i = 0; i < 14; i++) {
      t.advance(10);
      t.send('D-01', 'alarm'); // signal de vie
    }
    t.engine.tick();
    assert.equal(t.incident('D-01').confirmationReason, 'persistence');
  });

  it("repart de zero quand le detecteur revient a la normale puis se redeclenche", () => {
    const t = setup();
    t.send('D-01', 'alarm');
    t.advance(100);
    t.send('D-01', 'normal');
    t.advance(60);
    t.send('D-01', 'alarm'); // meme incident toujours ouvert, nouvel episode
    t.advance(100);
    t.engine.tick();
    assert.equal(t.incident('D-01').confirmedAt, null, '100 s seulement depuis le dernier declenchement');
    t.advance(25);
    t.engine.tick();
    assert.equal(t.incident('D-01').confirmationReason, 'persistence');
  });

  it("une prealarme qui persiste est confirmee aussi, et reste une prealarme", () => {
    const t = setup();
    t.send('D-07', 'prealarm');
    t.advance(130);
    t.engine.tick();
    const incident = t.incident('D-07');
    assert.equal(incident.confirmationReason, 'persistence');
    assert.equal(incident.severity, 'warning', 'la confirmation ne change pas la gravite');
  });

  it("confirme une seule fois, sans bruit dans le journal", () => {
    const t = setup();
    t.send('D-01', 'alarm');
    t.advance(130);
    t.engine.tick();
    t.engine.tick();
    t.advance(60);
    t.engine.tick();
    assert.equal(t.actions().filter((a) => a === 'incident_confirmed').length, 1);
  });
});

describe('indice « probable fausse alarme »', () => {
  it('un detecteur isole revenu a la normale en moins de 30 s est signale', () => {
    const t = setup();
    t.send('D-01', 'prealarm');
    t.advance(18);
    t.send('D-01', 'normal');
    const incident = t.incident('D-01');
    assert.equal(incident.hint, 'false_alarm_likely');
    assert.match(incident.hintDetails ?? '', /retour a la normale en 18 s, sans detecteur voisin/);
    assert.ok(t.actions().includes('incident_hint'));
  });

  it("pas d'indice si le detecteur est reste en alarme plus de 30 s", () => {
    const t = setup();
    t.send('D-01', 'prealarm');
    t.advance(45);
    t.send('D-01', 'normal');
    assert.equal(t.incident('D-01').hint, null);
  });

  it("pas d'indice quand un voisin corrobore : l'incident est confirme a la place", () => {
    const t = setup();
    t.send('D-06', 'prealarm');
    t.advance(5);
    t.send('D-05', 'prealarm');
    t.advance(5);
    t.send('D-06', 'normal');
    const incident = t.incident('D-06');
    assert.equal(incident.hint, null);
    assert.ok(incident.confirmedAt !== null);
  });

  it("l'indice disparait si le detecteur se redeclenche", () => {
    const t = setup();
    t.send('D-01', 'prealarm');
    t.advance(10);
    t.send('D-01', 'normal');
    assert.equal(t.incident('D-01').hint, 'false_alarm_likely');
    t.advance(5);
    t.send('D-01', 'alarm');
    assert.equal(t.incident('D-01').hint, null);
  });

  it("un voisin qui se declenche apres coup annule l'indice et confirme", () => {
    const t = setup();
    t.send('D-06', 'prealarm');
    t.advance(10);
    t.send('D-06', 'normal');
    assert.equal(t.incident('D-06').hint, 'false_alarm_likely');
    t.advance(15);
    t.send('D-05', 'alarm'); // dans la fenetre : le feu n'etait peut-etre pas une fausse alarme
    const incident = t.incident('D-06');
    assert.equal(incident.hint, null);
    assert.equal(incident.confirmationReason, 'neighbor:D-05');
    assert.equal(incident.status, 'open');
  });

  it("la qualification de l'operateur reste libre : clore en « feu confirme » malgre l'indice", () => {
    const t = setup();
    t.send('D-01', 'prealarm');
    t.advance(10);
    t.send('D-01', 'normal');
    const incident = t.incident('D-01');
    const closed = t.engine.close(incident.id, 'operateur', 'fire', 'Constate sur place');
    assert.equal(closed.status, 'closed');
    assert.equal(closed.qualification, 'fire');
  });
});

describe('base de donnees existante', () => {
  it("une base creee avant ces regles est migree sans perdre ses donnees", () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-mig-'));
    const path = join(dir, 'old.db');
    // Schema de la premiere version : aucune des colonnes de confirmation.
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE device (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, zone TEXT NOT NULL DEFAULT '', x REAL NOT NULL DEFAULT 50, y REAL NOT NULL DEFAULT 50, status TEXT NOT NULL DEFAULT 'normal', stream_kind TEXT, last_seen INTEGER);
      CREATE TABLE incident (id INTEGER PRIMARY KEY AUTOINCREMENT, detector_id TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', qualification TEXT, comment TEXT, opened_at INTEGER NOT NULL, acked_at INTEGER, acked_by TEXT, closed_at INTEGER, closed_by TEXT);
      INSERT INTO device (id, kind, name, zone) VALUES ('D-01', 'detector', 'Ancien detecteur', 'Accueil');
      INSERT INTO incident (detector_id, severity, status, qualification, opened_at, closed_at, closed_by) VALUES ('D-01', 'critical', 'closed', 'fire', 1, 2, 'operateur');
    `);
    old.close();

    const db = openDb(path);
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    assert.ok(columns('incident').includes('confirmed_at') && columns('incident').includes('hint'));
    assert.ok(columns('device').includes('state_since'));
    assert.equal((db.prepare('SELECT qualification FROM incident WHERE id = 1').get() as { qualification: string }).qualification, 'fire', 'historique conserve');
    assert.doesNotThrow(() => openDb(path), 'une seconde ouverture ne re-ajoute pas les colonnes');
  });
});
