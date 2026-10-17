/**
 * Controle d'acces vu par le portail (F28) : l'agregat calcule cote PSIM (server/accessportal.ts), sa validation a la reception
 * (portal/server/ingest.ts), ce que le portail en montre (views.ts, groupviews.ts) et le perimetre. Moteur et module d'acces
 * REELS, bases en memoire, horloge injectee (aucune attente reelle).
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { createAccess, displayState } from '../../server/access.ts';
import type { AccessService } from '../../server/access.ts';
import { ACCESS_STATE_KEYS, buildAccessSummary, shownState } from '../../server/accessportal.ts';
import type { AccessStateKey } from '../../server/accessportal.ts';
import { openDb } from '../../server/db.ts';
import { createEngine } from '../../server/engine.ts';
import type { Engine } from '../../server/engine.ts';
import { beginHistory } from '../../server/history.ts';
import { buildSiteSummary } from '../../server/portal.ts';
import type { SiteSummary } from '../../server/portal.ts';
import { seedDemo } from '../../server/seed.ts';
import { addGroup, addOrganization, addSite, assignSite, groupIdsByCodes } from '../../portal/server/admin.ts';
import { groupDetail, groupsOverview } from '../../portal/server/groupviews.ts';
import { openPortalDb } from '../../portal/server/db.ts';
import { parseSummary, storeSummary } from '../../portal/server/ingest.ts';
import { siteKey } from '../../portal/server/keys.ts';
import { accessOf, siteDetail } from '../../portal/server/views.ts';
import type { Principal } from '../../portal/server/accounts.ts';
import { visibleSite } from '../../portal/server/accounts.ts';
import { HOUR, MASTER, NOW, addUser, get, login, makeSummary, post, provision, startPortal } from './helpers.ts';

const DAY = 24 * HOUR;
const SEED = join(import.meta.dirname, '..', '..', 'seed');
const STALE = 15 * 60_000;
const ADMIN: Principal = { username: 'prestataire', role: 'admin', orgId: null, siteId: null, displayName: 'P', mustChangePassword: false, groupScope: null };

interface World {
  db: ReturnType<typeof openDb>;
  engine: Engine;
  access: AccessService;
  goTo: (t: number) => void;
  send: (id: string, payload: unknown) => unknown;
  summary: () => SiteSummary;
}

/** Un PSIM de test : moteur + module d'acces reels cables comme le fait main.ts, historique ouvert 30 jours avant `NOW`. */
function world(): World {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-accessportal-')), SEED);
  let clock = NOW - 30 * DAY;
  let engine: Engine;
  const access = createAccess({
    db,
    now: () => clock,
    key: randomBytes(32),
    audit: (actor, action, ref) => engine.audit(actor, action, ref),
    setDeviceState: (id, state, event) => engine.setStateBySupervisor(id, state, event),
  });
  engine = createEngine(db, () => {}, () => clock, { access, silentTimeoutMs: 0 });
  beginHistory(db, clock, null, null);
  return {
    db,
    engine,
    access,
    goTo: (t) => void (clock = t),
    send: (id, payload) => engine.ingest(id, payload),
    summary: () => buildSiteSummary(db, { siteId: 'site-acces', version: '9.9.9', startedAt: NOW - 1000, now: NOW }),
  };
}

/** Declare `n` portes (A-02 ...) sur deux controleurs ; A-01 (de la demo) est declaree aussi. Retourne leurs identifiants. */
function declareDoors(w: World, n: number): string[] {
  w.access.createController('admin', { id: 'CTL-1', name: 'Controleur 1', brand: 'dahua' });
  w.access.createController('admin', { id: 'CTL-2', name: 'Controleur 2', brand: 'dahua' });
  const ids = ['A-01'];
  for (let i = 2; i <= n; i++) {
    const id = `A-0${i}`;
    w.engine.createDevice('admin', { id, kind: 'detector', name: `Porte ${i}`, zone: 'Entrepot', category: 'access' });
    ids.push(id);
  }
  ids.forEach((id, i) => w.access.declareDoor('admin', { detectorId: id, controllerId: i < 4 ? 'CTL-1' : 'CTL-2', doorNo: (i % 4) + 1 }));
  return ids;
}

/** Les sept etats, une porte chacun, plus des incidents de chaque type. Voir les attentes dans le test « chiffres ». */
function sevenStates(): World {
  const w = world();
  declareDoors(w, 7);
  const at = (t: number) => w.goTo(t);
  // A-01 : fermee ; deux series de refus a repetition (veille, puis il y a 3 h), chacune traitee.
  at(NOW - 26 * HOUR);
  w.send('A-01', { event: 'badge_denied_repeated' });
  const first = w.engine.getSnapshot().incidents.find((i) => i.detectorId === 'A-01')!;
  at(NOW - 25 * HOUR);
  w.engine.acknowledge(first.id, 'gardien');
  w.send('A-01', { state: 'normal' });
  w.engine.close(first.id, 'gardien', 'false_alarm', null);
  at(NOW - 3 * HOUR);
  w.send('A-01', { event: 'badge_denied_repeated' });
  const second = w.engine.getSnapshot().incidents.find((i) => i.detectorId === 'A-01' && i.status !== 'closed')!;
  w.engine.acknowledge(second.id, 'gardien');
  w.send('A-01', { state: 'normal' });
  w.engine.close(second.id, 'gardien', 'false_alarm', null);
  w.send('A-01', { event: 'door_closed' });
  // A-02 : ouverte ; un sabotage il y a 10 jours, traite.
  at(NOW - 10 * DAY);
  w.send('A-02', { event: 'tamper' });
  const tamper = w.engine.getSnapshot().incidents.find((i) => i.detectorId === 'A-02')!;
  w.engine.acknowledge(tamper.id, 'gardien');
  w.send('A-02', { state: 'normal' });
  w.engine.close(tamper.id, 'gardien', 'fire', null);
  at(NOW - 20 * 60_000);
  w.send('A-02', { event: 'door_opened' });
  // A-03 : forcee il y a 2 h, alarme encore ouverte.
  at(NOW - 2 * HOUR);
  w.send('A-03', { event: 'door_forced' });
  // A-04 : hors ligne depuis 3 h (le controleur s'est tu).
  at(NOW - 3 * HOUR);
  w.send('A-04', { state: 'offline' });
  // A-05 : en defaut depuis 1 h.
  at(NOW - HOUR);
  w.send('A-05', { state: 'fault' });
  // A-06 : maintenue ouverte (pre-alarme) depuis 1 h.
  w.send('A-06', { event: 'door_held_open' });
  // A-07 : alarme sans evenement nomme (« autre »), jamais vue ouverte ni fermee : etat inconnu.
  at(NOW - 30 * 60_000);
  w.send('A-07', { state: 'alarm' });
  at(NOW);
  return w;
}

describe('agregat de controle d acces du resume', () => {
  it('absent quand le site n a aucune porte declaree : le champ n existe pas dans le JSON envoye', () => {
    const w = world();
    const s = w.summary();
    assert.equal(s.access, undefined);
    assert.ok(!('access' in JSON.parse(JSON.stringify(s))), 'ni cle access, ni null');
    // Une porte (detecteur de categorie access) non declaree dans access_door n est pas une porte pour le portail.
    assert.equal((w.db.prepare("SELECT COUNT(*) AS n FROM device WHERE category = 'access'").get() as { n: number }).n, 1);
    assert.equal(buildAccessSummary(w.db, { now: NOW, from: NOW - 35 * DAY }), undefined);
  });

  it('les chiffres d un jeu connu : portes, etats, disponibilite, incidents par type', () => {
    const w = sevenStates();
    const a = w.summary().access!;
    assert.ok(a, 'bloc present');
    assert.equal(a.doors, 7);
    assert.deepEqual(a.states, { offline: 1, fault: 1, forced: 1, heldOpen: 1, open: 1, closed: 1, unknown: 1 });
    assert.equal(Object.values(a.states).reduce((n, x) => n + x, 0), a.doors, 'la somme des etats vaut le nombre de portes');
    // Hors ligne depuis 3 h + en defaut depuis 1 h = 4 h d arret. Les 7 portes sont observees 30 jours.
    assert.equal(a.availability.downS, 4 * 3600);
    assert.equal(a.availability.upS + a.availability.downS, 7 * 30 * 24 * 3600);
    assert.equal(a.availability.unmonitoredS, 0);
    assert.equal(a.availability.pct, Math.round((a.availability.upS / (a.availability.upS + a.availability.downS)) * 10_000) / 100);
    assert.ok(a.availability.pct! < 100 && a.availability.pct! > 99.4, 'une porte hors ligne ne donne jamais 100 %');
    // Incidents ouverts pendant la fenetre : 1 forcee, 1 maintenue ouverte, 2 refus a repetition, 1 sabotage, 1 autre.
    assert.deepEqual(
      { ...a.incidents, byDay: undefined },
      { total: 6, forced: 1, heldOpen: 1, repeatedDenials: 2, tamper: 1, other: 1, openNow: 3, byDay: undefined },
    );
    // Par jour LOCAL : 4 aujourd hui, 1 la veille, 1 il y a 10 jours.
    assert.deepEqual(a.incidents.byDay, [{ day: '2026-06-05', n: 1 }, { day: '2026-06-14', n: 1 }, { day: '2026-06-15', n: 4 }]);
  });

  it('un incident plus ancien que la fenetre n est pas compte, sauf s il est encore ouvert (« en cours »)', () => {
    const w = sevenStates();
    w.db.prepare("INSERT INTO incident (detector_id, severity, status, opened_at, closed_at, qualification, event) VALUES ('A-05', 'critical', 'closed', ?, ?, 'fire', 'door_forced')").run(NOW - 50 * DAY, NOW - 50 * DAY + 60_000);
    w.db.prepare("INSERT INTO incident (detector_id, severity, status, opened_at, event) VALUES ('A-04', 'critical', 'open', ?, 'door_forced')").run(NOW - 40 * DAY);
    const a = w.summary().access!;
    assert.equal(a.incidents.total, 6, 'les deux anciens ne sont pas comptes dans la fenetre');
    assert.equal(a.incidents.forced, 1);
    assert.equal(a.incidents.openNow, 4, 'mais celui qui n est pas clos est « en cours »');
  });

  it('les incidents d un autre equipement que les portes ne comptent pas', () => {
    const w = sevenStates();
    w.goTo(NOW - HOUR);
    w.engine.handleDetectorMessage('D-01', { state: 'alarm' });
    w.goTo(NOW);
    assert.equal(w.summary().access!.incidents.total, 6);
    assert.equal(w.summary().access!.incidents.openNow, 3);
  });

  it('une porte retiree n est plus comptee (nombre, etats, disponibilite, incidents) ; sans plus aucune porte le bloc disparait', () => {
    const w = sevenStates();
    w.access.removeDoor('admin', 'A-04'); // la porte hors ligne
    w.access.removeDoor('admin', 'A-07'); // la porte a l etat inconnu, avec un incident « autre » ouvert
    const a = w.summary().access!;
    assert.equal(a.doors, 5);
    assert.deepEqual(a.states, { offline: 0, fault: 1, forced: 1, heldOpen: 1, open: 1, closed: 1, unknown: 0 });
    assert.equal(a.availability.downS, 3600, 'plus que la porte en defaut');
    assert.equal(a.availability.upS + a.availability.downS, 5 * 30 * DAY / 1000);
    assert.equal(a.incidents.other, 0);
    assert.equal(a.incidents.total, 5);
    for (const id of ['A-01', 'A-02', 'A-03', 'A-05', 'A-06']) w.access.removeDoor('admin', id);
    assert.equal(w.summary().access, undefined);
  });

  it('aucune observation : pas de pourcentage (jamais un 100 % invente)', () => {
    const w = world();
    declareDoors(w, 2);
    w.db.prepare('DELETE FROM device_state_history').run();
    const a = w.summary().access!;
    assert.equal(a.doors, 2);
    assert.deepEqual(a.availability, { upS: 0, downS: 0, unmonitoredS: 0, pct: null });
  });

  it('le PSIM arrete : ce temps est « non surveille », ni disponible ni indisponible', () => {
    const w = world();
    declareDoors(w, 2);
    // Arret de 6 h : le dernier signe de vie est a NOW-10h, redemarrage a NOW-4h.
    beginHistory(w.db, NOW - 4 * HOUR, NOW - 10 * HOUR, { from: NOW - 10 * HOUR, to: NOW - 4 * HOUR, clean: false });
    const a = w.summary().access!;
    assert.equal(a.availability.unmonitoredS, 2 * 6 * 3600, 'deux portes, 6 h chacune');
    assert.equal(a.availability.downS, 0);
    assert.equal(a.availability.pct, 100, 'observe et sans arret : 100 % est vrai ici');
  });

  it('la priorite des etats est celle de displayState (access.ts), pour toutes les combinaisons', () => {
    const map: Record<string, AccessStateKey> = { offline: 'offline', fault: 'fault', forced: 'forced', held_open: 'heldOpen', open: 'open', closed: 'closed', unknown: 'unknown' };
    let n = 0;
    for (const deviceStatus of ['normal', 'prealarm', 'alarm', 'fault', 'offline', 'autre'])
      for (const doorState of ['closed', 'open', 'unknown'] as const)
        for (const forced of [false, true])
          for (const heldOpen of [false, true]) {
            assert.equal(shownState({ deviceStatus, doorState, forced, heldOpen }), map[displayState({ deviceStatus, doorState, forced, heldOpen }).state], JSON.stringify({ deviceStatus, doorState, forced, heldOpen }));
            n++;
          }
    assert.equal(n, 72);
    assert.deepEqual([...ACCESS_STATE_KEYS], ['offline', 'fault', 'forced', 'heldOpen', 'open', 'closed', 'unknown'], 'ordre de priorite');
  });

  it('lecture seule : le calcul ne modifie rien dans la base', () => {
    const w = sevenStates();
    const dump = () => JSON.stringify(['access_door', 'access_event', 'access_controller', 'incident', 'device', 'device_state_history'].map((t) => w.db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()));
    const before = dump();
    w.summary();
    w.summary();
    assert.equal(dump(), before);
  });

  it('un calcul en echec ne bloque jamais l envoi du resume (il part sans le bloc)', () => {
    const w = sevenStates();
    w.db.exec('DROP TABLE access_door');
    const s = w.summary();
    assert.equal(s.access, undefined);
    assert.ok(s.devices.length > 0, 'le reste du resume est intact');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------

/** Le bloc d un PSIM reel, a partir duquel on fabrique des blocs hostiles. */
const goodBlock = () => structuredClone(sevenStates().summary().access!);
const withAccess = (access: unknown): unknown => ({ ...JSON.parse(JSON.stringify(makeSummary('site-acces'))), access });

describe('validation du bloc a la reception (portail)', () => {
  let block: ReturnType<typeof goodBlock>;
  before(() => {
    block = goodBlock();
  });
  const clone = () => structuredClone(block) as Record<string, any>;
  const rejected = (access: unknown, pattern: RegExp, why: string) => {
    const r = parseSummary(withAccess(access));
    assert.equal(r.ok, false, why);
    if (!r.ok) assert.match(r.error, pattern, why);
  };

  it('accepte un bloc valide tel quel', () => {
    const r = parseSummary(withAccess(block));
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.summary.access, block);
  });

  it('un resume sans bloc (PSIM plus ancien, ou site sans porte) reste valable ; null aussi', () => {
    for (const v of [undefined, null]) {
      const r = parseSummary(withAccess(v));
      assert.ok(r.ok);
      if (r.ok) assert.equal(r.summary.access, undefined);
    }
  });

  it('refuse les mauvais types, valeurs et bornes', () => {
    for (const bad of ['texte', 3, true, [], [block]]) rejected(bad, /access/, `bloc ${JSON.stringify(bad)}`);
    const cases: [string, (b: Record<string, any>) => void, RegExp][] = [
      ['doors zero', (b) => (b.doors = 0), /access\.doors/],
      ['doors negatif', (b) => (b.doors = -1), /access\.doors/],
      ['doors fractionnaire', (b) => (b.doors = 2.5), /access\.doors/],
      ['doors texte', (b) => (b.doors = '7'), /access\.doors/],
      ['doors demesure', (b) => (b.doors = 10_001), /access\.doors/],
      ['doors absent', (b) => delete b.doors, /access\.doors/],
      ['states absent', (b) => delete b.states, /access\.states/],
      ['states liste', (b) => (b.states = []), /access\.states/],
      ['un etat manquant', (b) => delete b.states.forced, /access\.states\.forced/],
      ['un etat negatif', (b) => (b.states.offline = -1), /access\.states\.offline/],
      ['un etat texte', (b) => (b.states.open = '1'), /access\.states\.open/],
      ['plus d etats que de portes', (b) => (b.states.closed = 50), /plus de portes/],
      ['availability absent', (b) => delete b.availability, /access\.availability/],
      ['pct au dela de 100', (b) => (b.availability.pct = 100.5), /pct/],
      ['pct negatif', (b) => (b.availability.pct = -1), /pct/],
      ['secondes fractionnaires', (b) => (b.availability.upS = 1.5), /upS/],
      ['incidents absent', (b) => delete b.incidents, /access\.incidents/],
      ['total texte', (b) => (b.incidents.total = 'beaucoup'), /access\.incidents\.total/],
      ['total negatif', (b) => (b.incidents.total = -3), /access\.incidents\.total/],
      ['total demesure', (b) => (b.incidents.total = 2_000_000), /access\.incidents\.total/],
      ['types plus nombreux que le total', (b) => (b.incidents.forced = 99), /types plus nombreux/],
      ['openNow manquant', (b) => delete b.incidents.openNow, /openNow/],
      ['byDay pas une liste', (b) => (b.incidents.byDay = { a: 1 }), /byDay/],
      ['byDay jour mal forme', (b) => (b.incidents.byDay[0].day = '15/06/2026'), /byDay\[0\]\.day/],
      ['byDay jour injecte', (b) => (b.incidents.byDay[0].day = '<script>'), /byDay/],
      ['byDay compte negatif', (b) => (b.incidents.byDay[0].n = -1), /byDay\[0\]\.n/],
      ['byDay element nul', (b) => (b.incidents.byDay[0] = null), /byDay\[0\]/],
      ['byDay enorme (401 elements)', (b) => (b.incidents.byDay = Array.from({ length: 401 }, () => ({ day: '2026-06-15', n: 1 }))), /byDay/],
      ['byDay gigantesque', (b) => (b.incidents.byDay = Array.from({ length: 200_000 }, () => ({ day: '2026-06-15', n: 1 }))), /byDay/],
    ];
    for (const [why, mutate, pattern] of cases) {
      const b = clone();
      mutate(b);
      rejected(b, pattern, why);
    }
  });

  it('ne garde AUCUN champ inconnu : ni dans le bloc, ni dans ses sous-objets (noms, identifiants, adresses)', () => {
    const b = clone();
    b.controllerId = 'CTL-SECRET-7';
    b.host = '10.99.88.77';
    b.doorNames = ['Porte du directeur'];
    b.holderName = 'ZORRO-NOM-TEST';
    b.states.zorro = 5;
    b.availability.credential = '99887766';
    b.incidents.holderRef = 'HREF-4242';
    b.incidents.byDay[0].badge = '99887766';
    const r = parseSummary(withAccess(b));
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.summary.access, block, 'exactement le bloc d origine');
      const json = JSON.stringify(r.summary);
      for (const marker of ['CTL-SECRET-7', '10.99.88.77', 'Porte du directeur', 'ZORRO-NOM-TEST', '99887766', 'HREF-4242', 'zorro']) assert.ok(!json.includes(marker), marker);
    }
  });

  it('une cle « __proto__ » ne pollue rien et n est pas conservee', () => {
    const text = JSON.stringify(withAccess(block)).replace('"doors":', '"__proto__":{"polluted":true},"doors":');
    const r = parseSummary(JSON.parse(text));
    assert.ok(r.ok);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    if (r.ok) assert.ok(!JSON.stringify(r.summary.access).includes('polluted'));
  });

  it('un bloc refuse fait refuser le resume entier avec un message precis (comme l indice de securite), jamais un plantage', () => {
    for (const hostile of [{}, { doors: 1 }, { doors: 1, states: {}, availability: {}, incidents: {} }, { doors: Number.MAX_SAFE_INTEGER }]) {
      const r = parseSummary(withAccess(hostile));
      assert.equal(r.ok, false);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------

describe('ce que le portail montre', () => {
  it('le detail d un site expose le bloc, date et avec la fenetre ; « non transmis » (null) sans bloc', () => {
    const db = openPortalDb(':memory:');
    addOrganization(db, 'Client', NOW);
    addSite(db, 'Client', 'avec-portes', 'Avec portes', NOW);
    addSite(db, 'Client', 'sans-portes', 'Sans portes', NOW);
    const s = sevenStates().summary();
    storeSummary(db, 'avec-portes', { ...s, siteId: 'avec-portes' }, NOW);
    storeSummary(db, 'sans-portes', { ...makeSummary('sans-portes') }, NOW);
    const site = (id: string) => visibleSite(db, ADMIN, id)!;
    const d = siteDetail(db, site('avec-portes'), 30, NOW, STALE);
    assert.ok(d.access);
    assert.equal(d.access!.doors, 7);
    assert.deepEqual(d.access!.states, s.access!.states);
    assert.equal(d.access!.windowDays, 35);
    assert.equal(d.access!.at, NOW);
    assert.equal(d.access!.incidents.total, 6);
    assert.equal(siteDetail(db, site('sans-portes'), 30, NOW, STALE).access, null);
    assert.equal(accessOf(null), null);
    assert.equal(accessOf(undefined), null);
  });

  it('un vieux resume (sans access) d un site qui a des detecteurs d acces : le portail dit « non transmis » (donnee de l ecran)', () => {
    const db = openPortalDb(':memory:');
    addOrganization(db, 'Client', NOW);
    addSite(db, 'Client', 'ancien', 'Ancien PSIM', NOW);
    const old = makeSummary('ancien'); // la demo contient un detecteur de categorie access (A-01), sans bloc
    assert.equal(old.access, undefined);
    storeSummary(db, 'ancien', old, NOW);
    const d = siteDetail(db, visibleSite(db, ADMIN, 'ancien')!, 30, NOW, STALE);
    assert.equal(d.access, null);
    assert.ok(d.devices.some((x) => x.category === 'access'), 'l ecran en deduit « non transmis » plutot que de cacher la carte');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------

/** Un resume de site dont on impose les etats de portes (offline, fault, ...) : de quoi tester les totaux de groupe. */
function withDoors(siteId: string, states: Partial<Record<AccessStateKey, number>>): SiteSummary {
  const base = makeSummary(siteId);
  const full = Object.fromEntries(ACCESS_STATE_KEYS.map((k) => [k, states[k] ?? 0])) as Record<AccessStateKey, number>;
  const doors = Object.values(full).reduce((n, x) => n + x, 0);
  return {
    ...base,
    access: { doors, states: full, availability: { upS: 1000, downS: 10, unmonitoredS: 0, pct: 99.01 }, incidents: { total: 0, forced: 0, heldOpen: 0, repeatedDenials: 0, tamper: 0, other: 0, openNow: 0, byDay: [] } },
  };
}

describe('groupes : portes hors ligne ou en defaut, agregees', () => {
  function bank() {
    const db = openPortalDb(':memory:');
    addOrganization(db, 'Banque', NOW);
    addGroup(db, 'Banque', 'region-a', 'Région A', null, NOW);
    addGroup(db, 'Banque', 'region-b', 'Région B', null, NOW);
    const put = (id: string, group: string | null, summary: SiteSummary | null, silentForMs = 0) => {
      addSite(db, 'Banque', id, `Site ${id}`, NOW);
      if (group) assignSite(db, id, group, NOW);
      if (summary) storeSummary(db, id, { ...summary, siteId: id, generatedAt: NOW - silentForMs }, NOW - silentForMs);
    };
    return { db, put };
  }
  const stats = (db: ReturnType<typeof openPortalDb>, code: string, p: Principal = ADMIN) => {
    const id = (db.prepare('SELECT id FROM site_group WHERE code = ?').get(code) as { id: number }).id;
    return groupDetail(db, p, id, NOW, STALE)!.stats.access;
  };

  it('additionne portes, hors ligne et en defaut des sites qui repondent ; un site sans porte n y compte pas', () => {
    const { db, put } = bank();
    put('agence-1', 'region-a', withDoors('agence-1', { closed: 3, offline: 2, fault: 1 }));
    put('agence-2', 'region-a', withDoors('agence-2', { closed: 4, open: 1 }));
    put('agence-3', 'region-a', makeSummary('agence-3')); // aucune porte transmise
    put('agence-4', 'region-a', null); // n a jamais rien envoye
    assert.deepEqual(stats(db, 'region-a'), { sites: 2, doors: 11, offline: 2, fault: 1, unverifiedDown: 0 });
    assert.deepEqual(stats(db, 'region-b'), { sites: 0, doors: 0, offline: 0, fault: 0, unverifiedDown: 0 }, 'groupe vide : rien, pas « tout va bien »');
  });

  it('les portes d un site MUET sont le dernier etat connu : comptees a part, jamais dans les portes hors ligne confirmees', () => {
    const { db, put } = bank();
    put('agence-1', 'region-a', withDoors('agence-1', { closed: 3, offline: 1 }));
    put('agence-2', 'region-a', withDoors('agence-2', { closed: 2, offline: 2, fault: 1 }), 5 * HOUR);
    assert.deepEqual(stats(db, 'region-a'), { sites: 1, doors: 4, offline: 1, fault: 0, unverifiedDown: 3 });
  });

  it('un directeur limite a un groupe ne voit que les portes de son groupe, jamais celles d un autre groupe ni le total de l organisation', () => {
    const { db, put } = bank();
    put('agence-1', 'region-a', withDoors('agence-1', { closed: 3, offline: 1 }));
    put('agence-b1', 'region-b', withDoors('agence-b1', { closed: 5, offline: 4, fault: 2 }));
    put('siege', null, withDoors('siege', { closed: 1, fault: 1 }));
    addUser(db, { username: 'dir-a', role: 'director', orgId: 1, groupIds: groupIdsByCodes(db, ['region-a']) });
    const principal = (name: string): Principal => {
      const row = db.prepare('SELECT * FROM portal_user WHERE username = ?').get(name) as { org_id: number };
      return { username: name, role: 'director', orgId: row.org_id, siteId: null, displayName: name, mustChangePassword: false, groupScope: groupIdsByCodes(db, ['region-a']) };
    };
    const limited = principal('dir-a');
    assert.deepEqual(stats(db, 'region-a', limited), { sites: 1, doors: 4, offline: 1, fault: 0, unverifiedDown: 0 });
    const all = groupsOverview(db, limited, NOW, STALE).total.access;
    assert.deepEqual(all, { sites: 1, doors: 4, offline: 1, fault: 0, unverifiedDown: 0 }, 'la vue d ensemble ne compte que le perimetre');
    assert.equal(groupDetail(db, limited, (db.prepare("SELECT id FROM site_group WHERE code = 'region-b'").get() as { id: number }).id, NOW, STALE), null, 'un groupe hors perimetre est introuvable');
    // Le directeur non limite voit tout.
    const full = groupsOverview(db, { ...limited, groupScope: null }, NOW, STALE).total.access;
    assert.deepEqual(full, { sites: 3, doors: 17, offline: 5, fault: 3, unverifiedDown: 0 });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------

describe('perimetre : le bloc d un site hors perimetre n est jamais visible (portail reel)', () => {
  it('par HTTP : directeur limite, directeur de l organisation, responsable de site, autre client', async () => {
    const portal = await startPortal();
    try {
      for (const org of ['Banque', 'Autre']) addOrganization(portal.db, org, NOW);
      addGroup(portal.db, 'Banque', 'region-nord', 'Région Nord', null, NOW);
      addGroup(portal.db, 'Banque', 'region-sud', 'Région Sud', null, NOW);
      const sites: [string, string, string | null][] = [
        ['nord-1', 'Banque', 'region-nord'],
        ['sud-1', 'Banque', 'region-sud'],
        ['autre-1', 'Autre', null],
      ];
      for (const [id, org, group] of sites) {
        provision(portal.db, org, id, `Site ${id}`);
        if (group) assignSite(portal.db, id, group, NOW);
        // Chaque site a un nombre de portes different, pour reconnaitre d ou vient un total.
        const doors = id === 'nord-1' ? { closed: 2 } : id === 'sud-1' ? { closed: 3, offline: 4 } : { closed: 6, fault: 5 };
        const summary = { ...withDoors(id, doors), siteId: id };
        assert.equal((await post(portal, { siteId: id, key: siteKey(MASTER, id, 1), body: JSON.stringify(summary) })).status, 200, id);
      }
      const org = (name: string) => (portal.db.prepare('SELECT id FROM organization WHERE name = ?').get(name) as { id: number }).id;
      addUser(portal.db, { username: 'dir-nord', role: 'director', orgId: org('Banque'), groupIds: groupIdsByCodes(portal.db, ['region-nord']) });
      addUser(portal.db, { username: 'dir-banque', role: 'director', orgId: org('Banque') });
      addUser(portal.db, { username: 'resp-sud', role: 'site_manager', orgId: org('Banque'), siteId: 'sud-1' });
      addUser(portal.db, { username: 'dir-autre', role: 'director', orgId: org('Autre') });
      const as = async (user: string) => login(portal, user);

      const nord = await as('dir-nord');
      assert.equal((await get(portal, '/api/sites/nord-1', nord)).json.access.doors, 2);
      for (const hidden of ['sud-1', 'autre-1']) {
        const r = await get(portal, `/api/sites/${hidden}`, nord);
        assert.equal(r.status, 404, hidden);
        assert.ok(!JSON.stringify(r.json).includes('access'), 'rien du bloc dans un 404');
      }
      const list = await get(portal, '/api/sites', nord);
      assert.deepEqual(list.json.map((s: { id: string }) => s.id), ['nord-1']);
      const groups = await get(portal, '/api/groups', nord);
      assert.deepEqual(groups.json.total.access, { sites: 1, doors: 2, offline: 0, fault: 0, unverifiedDown: 0 });

      const banque = await as('dir-banque');
      assert.equal((await get(portal, '/api/sites/sud-1', banque)).json.access.states.offline, 4);
      assert.equal((await get(portal, '/api/sites/autre-1', banque)).status, 404, 'l autre client reste invisible');
      assert.deepEqual((await get(portal, '/api/groups', banque)).json.total.access, { sites: 2, doors: 9, offline: 4, fault: 0, unverifiedDown: 0 });

      const resp = await as('resp-sud');
      assert.equal((await get(portal, '/api/sites/sud-1', resp)).json.access.doors, 7);
      assert.equal((await get(portal, '/api/sites/nord-1', resp)).status, 404);
      assert.equal((await get(portal, '/api/sites/nord-1')).status, 401, 'sans session : rien');

      const autre = await as('dir-autre');
      assert.equal((await get(portal, '/api/sites/autre-1', autre)).json.access.doors, 11);
      assert.equal((await get(portal, '/api/sites/nord-1', autre)).status, 404);
    } finally {
      await portal.close();
    }
  });

  it('un PSIM recent avec portes puis un ancien sans : le portail accepte les deux et n invente rien', async () => {
    const portal = await startPortal();
    try {
      provision(portal.db, 'Client', 'site-a', 'Site A');
      addUser(portal.db, { username: 'directeur', role: 'director', orgId: (portal.db.prepare('SELECT id FROM organization').get() as { id: number }).id });
      const cookie = await login(portal, 'directeur');
      const key = siteKey(MASTER, 'site-a', 1);
      const recent = { ...withDoors('site-a', { closed: 2, offline: 1 }), generatedAt: NOW - 10 * 60_000 };
      assert.equal((await post(portal, { siteId: 'site-a', key, body: JSON.stringify(recent) })).status, 200);
      assert.equal((await get(portal, '/api/sites/site-a', cookie)).json.access.doors, 3);
      // Le meme site renvoie ensuite (plus tard) un resume SANS bloc : l instantane est remplace, le bloc disparait.
      const without = { ...makeSummary('site-a'), generatedAt: NOW };
      assert.equal((await post(portal, { siteId: 'site-a', key, body: JSON.stringify(without) })).status, 200);
      assert.equal((await get(portal, '/api/sites/site-a', cookie)).json.access, null);
    } finally {
      await portal.close();
    }
  });
});
