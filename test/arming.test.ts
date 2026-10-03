import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createArming, inSchedule, parseSchedule } from '../server/arming.ts';
import type { Window } from '../server/arming.ts';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import { seedDemo } from '../server/seed.ts';

const HOUR = 3_600_000;
/** Date locale precise (le planning suit l'heure locale du serveur) : mois 0-11, jour de la semaine deduit. */
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();
// 2026-02-02 est un lundi, 2026-02-07 un samedi, 2026-02-08 un dimanche (fevrier : pas de changement d heure).
const MON = (h: number, min = 0) => at(2026, 1, 2, h, min);
const SAT = (h: number, min = 0) => at(2026, 1, 7, h, min);

const night: Window[] = [{ days: [1, 2, 3, 4, 5], from: '19:00', to: '07:00' }]; // soirs de semaine, jusqu'au matin
const badRequest = (pattern: RegExp) => (e: unknown) => e instanceof PsimError && e.status === 400 && pattern.test(e.message);

function setup(start = MON(12)) {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  let clock = start;
  const audits: string[] = [];
  const changes: number[] = [];
  const engine = createEngine(db, () => {}, () => clock, {
    isArmed: (zone) => arming.isArmed(zone),
  });
  const arming = createArming(db, (actor, action, ref) => void audits.push(`${actor}:${action}:${ref?.details ?? ''}`), () => clock, () => void changes.push(clock));
  return { db, engine, arming, audits, changes, set: (t: number) => void (clock = t), advance: (ms: number) => void (clock += ms) };
}

describe('planning hebdomadaire', () => {
  it("une plage de nuit couvre le soir et le matin suivant, a cheval sur minuit", () => {
    // lundi 19:00 -> mardi 07:00
    assert.equal(inSchedule(night, MON(18, 59)), false);
    assert.equal(inSchedule(night, MON(19, 0)), true);
    assert.equal(inSchedule(night, MON(23, 59)), true);
    assert.equal(inSchedule(night, at(2026, 1, 3, 0, 0)), true, 'mardi 00:00 appartient a la nuit de lundi');
    assert.equal(inSchedule(night, at(2026, 1, 3, 6, 59)), true);
    assert.equal(inSchedule(night, at(2026, 1, 3, 7, 0)), false, 'la fin est exclue');
    assert.equal(inSchedule(night, at(2026, 1, 3, 12, 0)), false);
  });

  it("la nuit du vendredi se prolonge le samedi matin, mais pas la nuit du samedi (jour non liste)", () => {
    assert.equal(inSchedule(night, at(2026, 1, 6, 23, 0)), true, 'vendredi soir');
    assert.equal(inSchedule(night, SAT(3, 0)), true, 'samedi 03:00 = fin de la nuit de vendredi');
    assert.equal(inSchedule(night, SAT(19, 0)), false, 'samedi soir : pas dans les jours listes');
    assert.equal(inSchedule(night, at(2026, 1, 8, 3, 0)), false, 'dimanche 03:00 : la nuit de samedi n est pas armee');
  });

  it("une plage dans la meme journee, plusieurs plages cumulees", () => {
    const w: Window[] = [{ days: [6], from: '08:00', to: '12:00' }, { days: [0], from: '00:00', to: '23:59' }];
    assert.equal(inSchedule(w, SAT(9, 0)), true);
    assert.equal(inSchedule(w, SAT(12, 0)), false);
    assert.equal(inSchedule(w, at(2026, 1, 8, 15, 0)), true);
  });

  it("valide les plages : jours, heures, doublons, vide, trop nombreuses", () => {
    assert.equal(parseSchedule(null), null);
    assert.deepEqual(parseSchedule([{ days: [3, 1, 3], from: '08:00', to: '18:00' }]), [{ days: [1, 3], from: '08:00', to: '18:00' }]);
    assert.throws(() => parseSchedule([]), badRequest(/vide/));
    assert.throws(() => parseSchedule('toujours'), badRequest(/liste/));
    assert.throws(() => parseSchedule([{ days: [7], from: '08:00', to: '18:00' }]), badRequest(/jours/));
    assert.throws(() => parseSchedule([{ days: [], from: '08:00', to: '18:00' }]), badRequest(/jours/));
    assert.throws(() => parseSchedule([{ days: [1], from: '8:00', to: '18:00' }]), badRequest(/heures/));
    assert.throws(() => parseSchedule([{ days: [1], from: '24:00', to: '18:00' }]), badRequest(/heures/));
    assert.throws(() => parseSchedule([{ days: [1], from: '08:00', to: '08:00' }]), badRequest(/identiques/));
    assert.throws(() => parseSchedule([null]), badRequest(/invalide/));
    assert.throws(() => parseSchedule(Array.from({ length: 15 }, () => ({ days: [1], from: '08:00', to: '09:00' }))), badRequest(/trop de plages/));
  });
});

describe('etat effectif d une zone', () => {
  it("sans rien configurer, la zone est armee en permanence (comportement d'avant)", () => {
    const t = setup();
    const s = t.arming.get('Accueil');
    assert.deepEqual([s.armed, s.source, s.nextChange], [true, 'default', null]);
    assert.equal(t.arming.isArmed('Accueil'), true);
    assert.equal(t.arming.isArmed(''), true);
    assert.equal(t.arming.isArmed('Zone inconnue'), true, 'une zone inconnue reste armee');
  });

  it("avec un planning, la zone est armee la nuit et desarmee le jour, et annonce son prochain changement", () => {
    const t = setup(MON(12));
    t.arming.setSchedule('admin', 'Accueil', night);
    let s = t.arming.get('Accueil');
    assert.deepEqual([s.armed, s.source], [false, 'schedule']);
    assert.equal(s.nextChange, MON(19, 0));
    t.set(MON(20));
    s = t.arming.get('Accueil');
    assert.equal(s.armed, true);
    assert.equal(s.nextChange, at(2026, 1, 3, 7, 0));
  });

  it("une derogation manuelle prime sur le planning, puis expire d'elle-meme", () => {
    const t = setup(MON(20)); // nuit : armee
    t.arming.setSchedule('admin', 'Accueil', night);
    t.arming.setOverride('operateur', 'Accueil', 'disarmed', 2);
    let s = t.arming.get('Accueil');
    assert.deepEqual([s.armed, s.source, s.override?.by], [false, 'override', 'operateur']);
    assert.equal(s.nextChange, MON(22), 'la derogation prend fin dans 2 h');
    t.advance(2 * HOUR + 1000);
    s = t.arming.get('Accueil');
    assert.deepEqual([s.armed, s.source, s.override], [true, 'schedule', null], 'planning repris : on ne reste jamais desarme par oubli');
  });

  it("sans planning, un desarmement expire et la zone redevient armee en permanence", () => {
    const t = setup();
    t.arming.setOverride('operateur', 'Accueil', 'disarmed', 1);
    assert.equal(t.arming.isArmed('Accueil'), false);
    t.advance(HOUR + 1);
    assert.deepEqual([t.arming.isArmed('Accueil'), t.arming.get('Accueil').source], [true, 'default']);
  });

  it("armer manuellement pendant le jour, et annuler la derogation rend la main au planning", () => {
    const t = setup(MON(12));
    t.arming.setSchedule('admin', 'Accueil', night);
    t.arming.setOverride('operateur', 'Accueil', 'armed', 4);
    assert.equal(t.arming.isArmed('Accueil'), true);
    const s = t.arming.clearOverride('operateur', 'Accueil');
    assert.deepEqual([s.armed, s.source], [false, 'schedule']);
  });

  it("supprimer le planning arme la zone en permanence", () => {
    const t = setup(MON(12));
    t.arming.setSchedule('admin', 'Accueil', night);
    assert.equal(t.arming.isArmed('Accueil'), false);
    t.arming.setSchedule('admin', 'Accueil', null);
    assert.equal(t.arming.isArmed('Accueil'), true);
  });
});

describe('validation et traces', () => {
  it("refuse une duree absente, nulle, negative, trop longue ou non numerique : une derogation expire toujours", () => {
    const t = setup();
    for (const hours of [undefined, 0, -1, 25, Infinity, NaN, '2', null]) {
      assert.throws(() => t.arming.setOverride('operateur', 'Accueil', 'disarmed', hours), badRequest(/duree/), `duree ${String(hours)}`);
    }
    assert.equal(t.arming.isArmed('Accueil'), true);
    assert.doesNotThrow(() => t.arming.setOverride('operateur', 'Accueil', 'disarmed', 24));
    assert.doesNotThrow(() => t.arming.setOverride('operateur', 'Accueil', 'disarmed', 0.25));
  });

  it("refuse un mode inconnu et une zone sans detecteur d'intrusion", () => {
    const t = setup();
    assert.throws(() => t.arming.setOverride('operateur', 'Accueil', 'off', 1), badRequest(/mode/));
    assert.throws(() => t.arming.setOverride('operateur', 'Bureaux', 'disarmed', 1), (e: unknown) => e instanceof PsimError && e.status === 404);
    assert.throws(() => t.arming.setOverride('operateur', '', 'disarmed', 1), badRequest(/zone/));
    assert.throws(() => t.arming.setSchedule('admin', 'Atelier', night), (e: unknown) => e instanceof PsimError && e.status === 404);
  });

  it("chaque armement, desarmement et changement de planning est journalise avec son auteur", () => {
    const t = setup();
    t.arming.setOverride('operateur', 'Accueil', 'disarmed', 3);
    t.arming.setSchedule('admin', 'Accueil', night);
    t.arming.clearOverride('operateur', 'Accueil');
    assert.equal(t.audits.length, 3);
    assert.match(t.audits[0], /^operateur:zone_disarmed:Accueil : desarmement manuel pour 3 h/);
    assert.match(t.audits[1], /^admin:arming_schedule:Accueil : 1 plage/);
    assert.match(t.audits[2], /^operateur:zone_(armed|disarmed):Accueil : derogation annulee/);
    assert.equal(t.changes.length, 3, 'les ecrans sont prevenus a chaque changement');
  });

  it("le controle periodique journalise les changements dus au planning, une seule fois", () => {
    const t = setup(MON(18, 58));
    t.arming.setSchedule('admin', 'Accueil', night);
    t.audits.length = 0;
    t.arming.tick(); // premier passage : etat connu, rien a dire
    t.advance(60_000);
    t.arming.tick();
    assert.equal(t.audits.length, 0, '18:59, toujours desarmee');
    t.advance(60_000);
    t.arming.tick();
    t.arming.tick();
    assert.equal(t.audits.length, 1);
    assert.match(t.audits[0], /^systeme:zone_armed:Accueil : armement automatique \(planning\)/);
    assert.equal(t.arming.snapshot().Accueil, true);
  });
});

describe('moteur : ce que le desarmement masque et ce qu il ne masque jamais', () => {
  it("un mouvement dans une zone desarmee n'ouvre aucun incident et laisse une trace", () => {
    const t = setup();
    t.arming.setOverride('operateur', 'Accueil', 'disarmed', 2);
    t.engine.ingest('I-01', { event: 'motion' });
    assert.equal(t.engine.getSnapshot().incidents.length, 0);
    assert.equal(t.engine.getDevice('I-01')?.status, 'normal');
    assert.ok(t.engine.listAudit(10).some((a) => a.action === 'intrusion_ignored' && a.deviceId === 'I-01'));
  });

  it("la meme trace n'est pas ecrite a chaque message (un mouvement dans une zone desarmee est frequent)", () => {
    const t = setup();
    t.arming.setOverride('operateur', 'Accueil', 'disarmed', 2);
    for (let i = 0; i < 20; i++) {
      t.engine.ingest('I-01', { event: 'motion' });
      t.advance(1000);
    }
    assert.equal(t.engine.listAudit(100).filter((a) => a.action === 'intrusion_ignored').length, 1);
    t.advance(60_000);
    t.engine.ingest('I-01', { event: 'motion' });
    assert.equal(t.engine.listAudit(100).filter((a) => a.action === 'intrusion_ignored').length, 2);
  });

  it("le sabotage et la panique alarment TOUJOURS, zone desarmee ou non", () => {
    const t = setup();
    t.arming.setOverride('operateur', 'Accueil', 'disarmed', 2);
    t.engine.ingest('I-01', { event: 'tamper' });
    assert.equal(t.engine.getDevice('I-01')?.status, 'alarm');
    assert.equal(t.engine.getSnapshot().incidents.length, 1);
    t.engine.ingest('I-01', { event: 'clear' });
    const s2 = setup();
    s2.arming.setOverride('operateur', 'Accueil', 'disarmed', 2);
    s2.engine.ingest('I-01', { event: 'panic' });
    assert.equal(s2.engine.getSnapshot().incidents.length, 1);
  });

  it("un etat d'alarme brut d'un detecteur d'intrusion est traite comme un mouvement (ignore si desarme)", () => {
    const t = setup();
    t.arming.setOverride('operateur', 'Accueil', 'disarmed', 2);
    t.engine.ingest('I-01', { state: 'alarm' });
    t.engine.ingest('I-01', { state: 'prealarm' });
    assert.equal(t.engine.getSnapshot().incidents.length, 0);
  });

  it("le retour a la normale et le defaut passent toujours (jamais ignores)", () => {
    const t = setup();
    t.engine.ingest('I-01', { event: 'motion' }); // armee : incident ouvert
    t.arming.setOverride('operateur', 'Accueil', 'disarmed', 2);
    t.engine.ingest('I-01', { event: 'low_battery' });
    assert.equal(t.engine.getDevice('I-01')?.status, 'fault', 'un defaut est toujours signale');
    t.engine.ingest('I-01', { event: 'clear' });
    assert.equal(t.engine.getDevice('I-01')?.status, 'normal');
  });

  it("un incident deja ouvert n'est pas ferme par un desarmement", () => {
    const t = setup();
    t.engine.ingest('I-01', { event: 'motion' });
    t.arming.setOverride('operateur', 'Accueil', 'disarmed', 2);
    const [incident] = t.engine.getSnapshot().incidents;
    assert.equal(incident.status, 'open');
    assert.equal(t.engine.getDevice('I-01')?.status, 'alarm');
  });

  it("incendie, controle d'acces et environnement ne sont JAMAIS concernes par l'armement", () => {
    const t = setup();
    t.db.prepare("UPDATE device SET zone = 'Accueil' WHERE id IN ('A-01', 'E-01', 'D-01')").run();
    t.arming.setOverride('operateur', 'Accueil', 'disarmed', 24);
    t.engine.ingest('D-01', { state: 'alarm' });
    t.engine.ingest('A-01', { event: 'door_forced' });
    t.engine.ingest('E-01', { value: 45 });
    assert.deepEqual(t.engine.getSnapshot().incidents.map((i) => i.detectorId).sort(), ['A-01', 'D-01', 'E-01']);
  });

  it("la zone armee fonctionne comme avant, et le planning s'applique aussi aux messages bruts", () => {
    const t = setup(MON(12));
    t.arming.setSchedule('admin', 'Accueil', night);
    t.engine.ingest('I-01', { event: 'motion' });
    assert.equal(t.engine.getSnapshot().incidents.length, 0, 'lundi midi : desarmee');
    t.set(MON(23));
    t.engine.ingest('I-01', { event: 'motion' });
    assert.equal(t.engine.getSnapshot().incidents.length, 1, 'lundi 23 h : armee');
  });

  it("sans service d'armement (option absente), tout reste arme", () => {
    const db = openDb(':memory:');
    seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
    const engine = createEngine(db, () => {});
    engine.ingest('I-01', { event: 'motion' });
    assert.equal(engine.getSnapshot().incidents.length, 1);
  });
});
