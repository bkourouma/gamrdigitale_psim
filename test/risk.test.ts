import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import {
  DEFENSES,
  LEVELS,
  baseVulnerability,
  buildPriorities,
  computeImpact,
  computeProbability,
  computeVulnerability,
  computeZone,
  createRiskService,
  levelOf,
} from '../server/risk.ts';
import type { Assessment, ZoneFacts } from '../server/risk.ts';
import { seedDemo } from '../server/seed.ts';

const DAY = 86_400_000;
const T0 = 1_800_000_000_000;

const facts = (over: Partial<ZoneFacts> = {}): ZoneFacts => ({ detectors: 1, cameras: 1, detectorsDown: [], fires: 0, ...over });
const assessment = (over: Partial<Assessment> = {}): Assessment => ({
  probability: 2,
  defenses: ['extincteurs', 'consignes'],
  impactImage: 2,
  impactEconomy: 3,
  impactHuman: 4,
  notes: '',
  assessedBy: 'test',
  assessedAt: T0,
  ...over,
});

describe('calcul : probabilite, vulnerabilite, repercussions', () => {
  it('la vulnerabilite de base baisse avec les lignes de defense en place', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(baseVulnerability), [4, 4, 3, 2, 2, 1]);
  });

  it("l'historique d'incendies releve la probabilite, sans jamais depasser 3", () => {
    assert.equal(computeProbability(assessment({ probability: 1 }), facts({ fires: 0 })).value, 1);
    assert.equal(computeProbability(assessment({ probability: 1 }), facts({ fires: 1 })).value, 2);
    assert.equal(computeProbability(assessment({ probability: 1 }), facts({ fires: 2 })).value, 2);
    assert.equal(computeProbability(assessment({ probability: 1 }), facts({ fires: 3 })).value, 3);
    assert.equal(computeProbability(assessment({ probability: 3 }), facts({ fires: 9 })).value, 3, 'plafonnee');
    assert.match(computeProbability(assessment({ probability: 1 }), facts({ fires: 1 })).reasons.join(' '), /\+1 : 1 incendie/);
  });

  it("l'etat reel majore la vulnerabilite, chaque defaut explique, plafonnee a 4", () => {
    const a = assessment({ defenses: ['extincteurs', 'consignes', 'personnel', 'compartimentage', 'desenfumage'] }); // base 1
    assert.equal(computeVulnerability(a, facts()).value, 1);
    const noDetector = computeVulnerability(a, facts({ detectors: 0 }));
    assert.equal(noDetector.value, 2);
    assert.match(noDetector.reasons.join(' '), /aucun détecteur/);
    assert.equal(computeVulnerability(a, facts({ detectorsDown: ['D-01'] })).value, 2);
    assert.match(computeVulnerability(a, facts({ detectorsDown: ['D-01'] })).reasons.join(' '), /hors service \(D-01\)/);
    assert.equal(computeVulnerability(a, facts({ cameras: 0 })).value, 2);
    assert.equal(computeVulnerability(a, facts({ detectors: 0, cameras: 0, detectorsDown: ['D-9'] })).value, 4, 'cumul des trois defauts');
    assert.equal(computeVulnerability(assessment({ defenses: [] }), facts({ detectors: 0, cameras: 0 })).value, 4, 'plafond a 4');
  });

  it('ignore une ligne de defense inconnue au lieu de la compter', () => {
    assert.equal(computeVulnerability(assessment({ defenses: ['extincteurs', 'inventee', 'autre'] }), facts()).base, 4);
  });

  it("les repercussions retiennent la plus grave des trois, et le disent", () => {
    const r = computeImpact(assessment({ impactImage: 5, impactEconomy: 1, impactHuman: 2 }));
    assert.equal(r.value, 5);
    assert.match(r.reasons[0], /image : 5\/5/);
    assert.equal(computeImpact(assessment({ impactImage: 1, impactEconomy: 1, impactHuman: 4 })).value, 4, "un risque humain n'est pas dilue");
  });

  it("l'indice est P x V x R, de 1 a 60, pour TOUTES les combinaisons", () => {
    let min = Infinity;
    let max = 0;
    for (let p = 1; p <= 3; p++) {
      for (let checked = 0; checked <= 5; checked++) {
        for (let r = 1; r <= 5; r++) {
          const z = computeZone('Z', assessment({ probability: p, defenses: DEFENSES.slice(0, checked).map((d) => d.id), impactImage: r, impactEconomy: 1, impactHuman: 1 }), facts());
          assert.ok(Number.isInteger(z.index) && z.index! >= 1 && z.index! <= 60, `indice ${z.index}`);
          assert.equal(z.index, z.p!.value * z.v!.value * z.r!.value);
          min = Math.min(min, z.index!);
          max = Math.max(max, z.index!);
        }
      }
    }
    assert.equal(min, 1);
    assert.equal(max, 3 * 4 * 5, 'echelle complete 1-60 atteignable');
  });

  it('les seuils de niveau sont continus et couvrent 1 a 60', () => {
    assert.deepEqual([1, 8, 9, 20, 21, 36, 37, 60].map((i) => levelOf(i).level), ['faible', 'faible', 'modere', 'modere', 'eleve', 'eleve', 'critique', 'critique']);
    assert.equal(LEVELS[LEVELS.length - 1].max, 60);
  });

  it("une zone non evaluee n'a aucune note : pas de chiffre invente", () => {
    const z = computeZone('Atelier', null, facts());
    assert.equal(z.assessed, false);
    assert.equal(z.index, null);
    assert.equal(z.p, null);
    assert.equal(z.level, null);
  });
});

function setup(clock = { t: T0 }) {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  const engine = createEngine(db, () => {}, () => clock.t);
  const risk = createRiskService(db, engine, { now: () => clock.t });
  const zone = (name: string) => risk.overview().zones.find((z) => z.zone === name)!;
  return { db, engine, risk, clock, zone };
}

describe('risque du site de demonstration', () => {
  it('donne les indices attendus (calcules a la main) et classe les zones du plus au moins risque', () => {
    const t = setup();
    const o = t.risk.overview();
    const byZone = Object.fromEntries(o.zones.map((z) => [z.zone, z.index]));
    assert.deepEqual(byZone, { Accueil: 8, Bureaux: 6, 'Salle serveurs': 30, Couloir: 9, Entrepot: 30, Atelier: 36, Stockage: 12 });
    assert.equal(o.zones[0].zone, 'Atelier', 'trie par indice decroissant');
    assert.deepEqual(o.zones.map((z) => z.index), [...o.zones.map((z) => z.index)].sort((a, b) => b! - a!));
    assert.equal(o.site.index, 36);
    assert.equal(o.site.worstZone, 'Atelier');
    assert.equal(o.site.level, 'eleve');
    assert.equal(o.site.assessedZones, 7);
  });

  it("un detecteur hors service fait monter l'indice de sa zone, et il redescend a sa reprise", () => {
    const t = setup();
    assert.equal(t.zone('Atelier').index, 36);
    t.engine.handleDetectorMessage('D-06', { state: 'offline' });
    const down = t.zone('Atelier');
    assert.equal(down.v!.value, 4);
    assert.equal(down.index, 48);
    assert.equal(down.level, 'critique');
    assert.match(down.v!.reasons.join(' '), /hors service \(D-06\)/);
    assert.equal(t.risk.overview().site.index, 48);
    t.engine.handleDetectorMessage('D-06', { state: 'normal' });
    assert.equal(t.zone('Atelier').index, 36);
  });

  it("un incendie confirme dans la zone releve la probabilite ; hors periode, il est ignore", () => {
    const t = setup();
    assert.equal(t.zone('Accueil').index, 8);
    t.engine.handleDetectorMessage('D-01', { state: 'alarm' });
    t.engine.handleDetectorMessage('D-01', { state: 'normal' });
    const incidentId = t.engine.getSnapshot().incidents[0].id;
    t.engine.close(incidentId, 'operateur', 'fire', 'Constate');
    assert.equal(t.zone('Accueil').p!.value, 2);
    assert.equal(t.zone('Accueil').index, 16);
    assert.match(t.zone('Accueil').p!.reasons.join(' '), /1 incendie\(s\) confirmé/);
    t.clock.t += 200 * DAY; // au-dela de la periode de 180 jours
    assert.equal(t.zone('Accueil').p!.value, 1);
  });

  it("une fausse alarme qualifiee comme telle ne compte pas comme un incendie", () => {
    const t = setup();
    t.engine.handleDetectorMessage('D-01', { state: 'alarm' });
    t.engine.handleDetectorMessage('D-01', { state: 'normal' });
    t.engine.close(t.engine.getSnapshot().incidents[0].id, 'operateur', 'false_alarm', '');
    assert.equal(t.zone('Accueil').p!.value, 1);
  });

  it('une zone sans evaluation (nouvel equipement) apparait « a evaluer » sans note', () => {
    const t = setup();
    t.engine.createDevice('admin', { id: 'D-08', kind: 'detector', name: 'Nouveau', zone: 'Quai' });
    const z = t.zone('Quai');
    assert.equal(z.assessed, false);
    assert.equal(z.index, null);
    const o = t.risk.overview();
    assert.equal(o.site.totalZones, 8);
    assert.equal(o.site.assessedZones, 7);
    assert.ok(o.priorities.some((p) => p.zone === 'Quai' && p.horizon === 'court' && /Évaluer/.test(p.title)));
  });

  it('signale une evaluation ancienne (a revoir apres 12 mois)', () => {
    const t = setup();
    assert.equal(t.zone('Atelier').stale, false);
    t.clock.t += 400 * DAY;
    assert.equal(t.zone('Atelier').stale, true);
  });
});

describe('evaluation d\'une zone (saisie)', () => {
  const valid = { probability: 2, defenses: ['extincteurs'], impactImage: 3, impactEconomy: 3, impactHuman: 3, notes: 'ok' };

  it('enregistre, recalcule et journalise', () => {
    const t = setup();
    const z = t.risk.assess('admin', 'Couloir', { ...valid, defenses: ['extincteurs', 'consignes', 'personnel'], impactHuman: 5 });
    assert.equal(z.index, 2 * 2 * 5);
    assert.equal(z.assessedBy, 'admin');
    assert.equal(t.zone('Couloir').index, 20);
    const audit = t.engine.listAudit(5).find((a) => a.action === 'risk_assessed');
    assert.match(audit?.details ?? '', /Couloir : indice 20 \(Modéré\)/);
  });

  it('rejette toute valeur hors des echelles', () => {
    const t = setup();
    const bad = (input: Record<string, unknown>) => assert.throws(() => t.risk.assess('admin', 'Couloir', input), (e) => e instanceof PsimError && e.status === 400);
    bad({ ...valid, probability: 0 });
    bad({ ...valid, probability: 4 });
    bad({ ...valid, probability: 1.5 });
    bad({ ...valid, probability: '2' });
    bad({ ...valid, impactImage: 6 });
    bad({ ...valid, impactEconomy: 0 });
    bad({ ...valid, impactHuman: null });
    bad({ ...valid, defenses: ['inventee'] });
    bad({ ...valid, defenses: 'extincteurs' });
    bad({ ...valid, notes: 'x'.repeat(501) });
    assert.equal(t.zone('Couloir').index, 9, 'rien n\'a ete modifie');
  });

  it("refuse une zone qui n'existe pas", () => {
    const t = setup();
    assert.throws(() => t.risk.assess('admin', 'Inconnue', valid), (e) => e instanceof PsimError && e.status === 404);
  });

  it('dedoublonne les lignes de defense', () => {
    const t = setup();
    const z = t.risk.assess('admin', 'Couloir', { ...valid, defenses: ['extincteurs', 'extincteurs', 'consignes'] });
    assert.deepEqual(z.defenses, ['extincteurs', 'consignes']);
  });
});

describe('priorites d\'action', () => {
  it("chiffre le gain de chaque mesure et classe court, moyen, long terme", () => {
    const t = setup();
    t.engine.handleDetectorMessage('D-06', { state: 'offline' }); // Atelier : 48 (critique)
    const p = t.risk.overview().priorities;
    const horizons = p.map((x) => x.horizon);
    assert.deepEqual(horizons, [...horizons].sort((a, b) => ['court', 'moyen', 'long'].indexOf(a) - ['court', 'moyen', 'long'].indexOf(b)), 'court terme d\'abord');

    const repair = p.find((x) => /Remettre en service D-06/.test(x.title))!;
    assert.equal(repair.horizon, 'court');
    assert.equal(repair.gain, 12, '48 -> 36 une fois le detecteur remis en service');

    const consignes = p.find((x) => /Consignes/.test(x.title) && x.zone === 'Atelier')!;
    assert.equal(consignes.horizon, 'moyen');
    assert.ok(consignes.gain! > 0);

    const structural = p.find((x) => /Compartimentage/.test(x.title) && x.zone === 'Atelier')!;
    assert.equal(structural.horizon, 'long');
  });

  it('propose un second detecteur dans une zone a risque eleve couverte par un seul', () => {
    const t = setup();
    const p = t.risk.overview().priorities;
    assert.ok(p.some((x) => x.zone === 'Atelier' && /second détecteur/.test(x.title) && x.gain === null));
    assert.ok(!p.some((x) => x.zone === 'Bureaux' && /second détecteur/.test(x.title)), 'pas pour une zone a faible risque');
  });

  it("ne propose rien d'inutile pour une zone a faible risque", () => {
    const t = setup();
    const p = t.risk.overview().priorities;
    assert.equal(p.filter((x) => x.zone === 'Bureaux').length, 0);
  });

  it("propose d'installer un detecteur / une camera quand il en manque, avec le gain", () => {
    const t = setup();
    t.db.prepare("DELETE FROM device_link WHERE detector_id = 'D-03'").run(); // la salle serveurs perd ses cameras liees
    t.db.prepare("UPDATE device SET zone = 'Ailleurs' WHERE id = 'C-03'").run();
    const z = t.zone('Salle serveurs');
    assert.equal(z.facts.cameras, 0);
    assert.equal(z.index, 2 * 4 * 5); // vulnerabilite 3 + 1
    const camera = t.risk.overview().priorities.find((x) => x.zone === 'Salle serveurs' && /caméra/.test(x.title))!;
    assert.equal(camera.gain, 10);
    assert.equal(camera.horizon, 'moyen');
  });

  it('une zone sans evaluation passe en tete (court terme) sans gain chiffre', () => {
    const zones = [computeZone('Quai', null, facts())];
    const p = buildPriorities(zones, new Map());
    assert.deepEqual(p.map((x) => [x.horizon, x.gain]), [['court', null]]);
  });
});

describe('historique et tendances', () => {
  it("enregistre un point par jour (zones et site), jamais deux fois le meme jour", () => {
    const t = setup();
    assert.ok(t.risk.recordHistory() > 0);
    assert.equal(t.risk.recordHistory(), 0, 'deja fait aujourd\'hui');
    t.clock.t += DAY;
    t.engine.handleDetectorMessage('D-06', { state: 'offline' }); // l'indice change entre les deux jours
    assert.ok(t.risk.recordHistory() > 0);
    const h = t.risk.overview().history;
    assert.equal(h.Atelier.length, 2);
    assert.deepEqual(h.Atelier.map((p) => p.index), [36, 48]);
    assert.deepEqual(h.__site__.map((p) => p.index), [36, 48]);
  });

  it("ne garde pas de point pour une zone non evaluee", () => {
    const t = setup();
    t.engine.createDevice('admin', { id: 'D-08', kind: 'detector', name: 'Nouveau', zone: 'Quai' });
    t.risk.recordHistory();
    assert.equal(t.risk.overview().history.Quai, undefined);
  });
});
