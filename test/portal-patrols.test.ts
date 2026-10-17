import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { resetThrottles } from '../portal/server/accounts.ts';
import type { VisibleSite } from '../portal/server/accounts.ts';
import { parseSummary, storeSummary } from '../portal/server/ingest.ts';
import { siteKey } from '../portal/server/keys.ts';
import { siteDetail } from '../portal/server/views.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { beginHistory } from '../server/history.ts';
import { MAX_PATROL_WEEKS, buildSiteSummary } from '../server/portal.ts';
import type { PatrolsSummary, SiteSummary } from '../server/portal.ts';
import { seedDemo } from '../server/seed.ts';
import { MASTER, addUser, get, login, post, provision, startPortal } from './portal/helpers.ts';
import type { Portal } from './portal/helpers.ts';

/**
 * Rondes de securite dans le resume du portail (F25) : calcul cote PSIM (semaines locales, taux, SOS, absence du champ,
 * tolerance aux erreurs, aucun nom), validation stricte a la reception, retrocompatibilite, restitution par la vue.
 * Les tables de rondes sont creees a la main (le modele de docs/AGENTS-RONDES.md) : le calcul ne depend que d'elles.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ROUTE_RUN_DDL = `
CREATE TABLE patrol_route (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, checkpoints TEXT NOT NULL DEFAULT '[]', ordered INTEGER NOT NULL DEFAULT 0,
  max_minutes INTEGER NOT NULL DEFAULT 30, schedule TEXT NOT NULL DEFAULT '[]', agents TEXT NOT NULL DEFAULT '[]', grace_minutes INTEGER NOT NULL DEFAULT 10,
  enabled INTEGER NOT NULL DEFAULT 1, archived_at INTEGER);
CREATE TABLE patrol_run (id INTEGER PRIMARY KEY AUTOINCREMENT, route_id INTEGER NOT NULL, due_start INTEGER NOT NULL, due_end INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','done','incomplete','missed')), started_by TEXT, started_at INTEGER, finished_at INTEGER,
  UNIQUE (route_id, due_start));`;

/** Heure LOCALE (calculee a l'appel : le fuseau du processus peut avoir ete change par le test). */
const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime();

/** Execute `fn` dans un autre fuseau horaire (le processus Node le prend en compte a chaud), puis remet l'ancien. */
const SYSTEM_TZ = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
function inTimeZone<T>(tz: string, fn: () => T): T {
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    // `delete process.env.TZ` ne remet pas le fuseau d'origine : on le reaffecte explicitement.
    process.env.TZ = SYSTEM_TZ;
  }
}

function psim(opts: { tables?: boolean; route?: boolean } = {}) {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  const clock = 0;
  const engine = createEngine(db, () => {}, () => clock, { silentTimeoutMs: 0 });
  beginHistory(db, clock, null, null);
  if (opts.tables !== false) db.exec(ROUTE_RUN_DDL);
  if (opts.tables !== false && opts.route !== false) db.prepare("INSERT INTO patrol_route (name) VALUES ('Circuit')").run();
  const run = (dueStart: number, status: string) => db.prepare('INSERT INTO patrol_run (route_id, due_start, due_end, status) VALUES (1, ?, ?, ?)').run(dueStart, dueStart + 30 * 60_000, status);
  const sos = (openedAt: number, event: string | null = 'sos', detector = 'D-01') => {
    db.prepare("INSERT INTO incident (detector_id, severity, status, opened_at, closed_at, event) VALUES (?, 'critical', 'closed', ?, ?, ?)").run(detector, openedAt, openedAt + 60_000, event);
  };
  const summary = (now: number, windowDays?: number): SiteSummary => buildSiteSummary(db, { siteId: 'site-a', version: '1', startedAt: now - 1000, now, windowDays });
  return { db, engine, run, sos, summary };
}

// Lundi 15 juin 2026, midi : la fenetre de 35 jours commence le lundi 11 mai a midi (premiere semaine partielle).
const T0 = () => at(2026, 6, 15, 12);

/** Le jeu de reference : voir les commentaires de chaque ligne pour la semaine ou elle tombe. */
function seedReference(t: ReturnType<typeof psim>): void {
  t.run(at(2026, 5, 11, 10), 'done'); // avant la fenetre (11 mai 10 h < 11 mai 12 h) : ignoree
  t.run(at(2026, 5, 11, 13), 'done'); // semaine 1
  t.run(at(2026, 5, 17, 23, 59), 'missed'); // dimanche soir : encore semaine 1
  t.run(at(2026, 5, 18, 0, 0), 'done'); // lundi 0 h pile : semaine 2
  t.run(at(2026, 5, 18, 2, 0), 'incomplete'); // semaine 2
  t.run(at(2026, 6, 8, 22, 0), 'pending'); // semaine 5 : prevue, pas echue
  t.run(at(2026, 6, 14, 23, 30), 'active'); // semaine 5 : en cours
  t.run(at(2026, 6, 15, 2, 0), 'done'); // semaine 6
  t.run(at(2026, 6, 15, 13, 0), 'pending'); // apres « maintenant » : hors fenetre
  t.sos(at(2026, 5, 10, 9)); // avant la fenetre
  t.sos(at(2026, 5, 12, 9)); // semaine 1
  t.sos(at(2026, 6, 10, 3));
  t.sos(at(2026, 6, 11, 3), 'sos', 'D-02'); // semaine 5 (deux SOS)
  t.sos(at(2026, 6, 12, 3), 'intrusion'); // autre evenement : pas un SOS
  t.sos(at(2026, 6, 13, 3), null); // incident sans evenement nomme : pas un SOS
  t.sos(at(2026, 6, 15, 13, 0)); // apres « maintenant »
}

describe('rondes dans le resume : semaines, taux, SOS', () => {
  it('compte par semaine locale (lundi a dimanche), sur la fenetre seulement', () => {
    const t = psim();
    seedReference(t);
    const p = t.summary(T0()).patrols!;
    assert.deepEqual(p.weeks.map((w) => w.weekStart), ['2026-05-11', '2026-05-18', '2026-05-25', '2026-06-01', '2026-06-08', '2026-06-15']);
    assert.deepEqual(p.weeks[0], { weekStart: '2026-05-11', planned: 2, done: 1, incomplete: 0, missed: 1, ratePct: 50, sos: 1 });
    assert.deepEqual(p.weeks[1], { weekStart: '2026-05-18', planned: 2, done: 1, incomplete: 1, missed: 0, ratePct: 50, sos: 0 });
    assert.deepEqual(p.weeks[2], { weekStart: '2026-05-25', planned: 0, done: 0, incomplete: 0, missed: 0, ratePct: null, sos: 0 });
    assert.deepEqual(p.weeks[3], { weekStart: '2026-06-01', planned: 0, done: 0, incomplete: 0, missed: 0, ratePct: null, sos: 0 });
    assert.deepEqual(p.weeks[4], { weekStart: '2026-06-08', planned: 2, done: 0, incomplete: 0, missed: 0, ratePct: null, sos: 2 });
    assert.deepEqual(p.weeks[5], { weekStart: '2026-06-15', planned: 1, done: 1, incomplete: 0, missed: 0, ratePct: 100, sos: 0 });
    assert.deepEqual(p.totals, { planned: 7, done: 3, incomplete: 1, missed: 1, ratePct: 60, sos: 3 });
  });

  it('les semaines couvrent la fenetre existante : une seule semaine si la fenetre est courte', () => {
    const t = psim();
    t.run(at(2026, 6, 15, 8), 'done');
    const p = t.summary(T0(), 1).patrols!;
    assert.deepEqual(p.weeks.map((w) => w.weekStart), ['2026-06-08', '2026-06-15'], 'la fenetre commence dimanche midi : elle touche deux semaines');
  });

  it('une fenetre qui commence en milieu de semaine : la premiere semaine est partielle, son lundi est avant la fenetre', () => {
    const t = psim();
    t.run(at(2026, 6, 9, 9), 'done'); // mardi 9 h, avant le debut de la fenetre (mardi 10 h)
    t.run(at(2026, 6, 9, 11), 'missed');
    const p = t.summary(at(2026, 6, 16, 10), 7).patrols!; // fenetre : de mardi 9 juin 10 h a mardi 16 juin 10 h
    assert.deepEqual(p.weeks.map((w) => w.weekStart), ['2026-06-08', '2026-06-15']);
    assert.deepEqual([p.weeks[0].done, p.weeks[0].missed], [0, 1], 'la ronde de 9 h est avant la fenetre');
  });

  it('le taux est arrondi a l entier (2 sur 3 = 67 %) et vaut null sans ronde echue', () => {
    const t = psim();
    t.run(at(2026, 6, 15, 1), 'done');
    t.run(at(2026, 6, 15, 2), 'done');
    t.run(at(2026, 6, 15, 3), 'missed');
    t.run(at(2026, 6, 15, 4), 'pending');
    const p = t.summary(T0(), 7).patrols!;
    assert.equal(p.totals.ratePct, 67);
    assert.equal(p.totals.planned, 4, 'la ronde en attente est prevue, sans entrer dans le taux');

    const none = psim();
    none.run(at(2026, 6, 15, 1), 'pending');
    none.run(at(2026, 6, 15, 2), 'active');
    const q = none.summary(T0(), 7).patrols!;
    assert.equal(q.totals.ratePct, null);
    assert.ok(q.weeks.every((w) => w.ratePct === null));
    assert.equal(q.totals.planned, 2);
  });

  it('compte les SOS par leur ouverture, et seulement ceux dont l evenement est « sos »', () => {
    const t = psim();
    t.sos(at(2026, 6, 14, 1));
    t.sos(at(2026, 6, 14, 2), 'sos', 'D-02');
    t.sos(at(2026, 6, 14, 3), 'intrusion', 'D-03');
    t.sos(at(2026, 6, 14, 4), null, 'D-04');
    const p = t.summary(T0(), 7).patrols!;
    assert.equal(p.totals.sos, 2);
    assert.equal(p.weeks.reduce((n, w) => n + w.sos, 0), 2);
  });

  it('un SOS ouvert avant la fenetre mais encore ouvert n est pas compte (il est classe par son ouverture)', () => {
    const t = psim();
    t.db.prepare("INSERT INTO incident (detector_id, severity, status, opened_at, event) VALUES ('D-01', 'critical', 'open', ?, 'sos')").run(T0() - 40 * DAY);
    assert.equal(t.summary(T0()).patrols!.totals.sos, 0);
  });

  it('plafonne le nombre de semaines (les plus recentes) et ignore ce qui est au-dela', () => {
    const t = psim();
    const now = T0();
    t.run(now - 3 * DAY, 'done'); // semaine courante
    t.run(now - 450 * DAY, 'done'); // dans la fenetre de 500 jours, mais au-dela des 60 semaines gardees
    const p = t.summary(now, 500).patrols!;
    assert.equal(p.weeks.length, MAX_PATROL_WEEKS);
    assert.equal(p.weeks.at(-1)!.weekStart, '2026-06-15');
    assert.ok(p.weeks.every((w, i) => i === 0 || w.weekStart > p.weeks[i - 1].weekStart), 'ordre croissant');
    assert.equal(p.totals.planned, 1);
  });
});

describe('rondes dans le resume : fuseau horaire', () => {
  it('Inde (UTC+5:30) : dimanche 23 h 30 et lundi 0 h 15 locaux sont dans deux semaines, alors qu elles sont le meme jour en UTC', () => {
    inTimeZone('Asia/Kolkata', () => {
      const t = psim();
      t.run(at(2026, 5, 24, 23, 30), 'done'); // dimanche 24 mai local (18 h UTC, meme jour UTC que ...)
      t.run(at(2026, 5, 25, 0, 15), 'missed'); // lundi 25 mai local (18 h 45 UTC dimanche)
      const s = t.summary(T0(), 35);
      assert.equal(s.utcOffsetMin, 330);
      const p = s.patrols!;
      const w = (day: string) => p.weeks.find((x) => x.weekStart === day)!;
      assert.deepEqual([w('2026-05-18').done, w('2026-05-18').missed], [1, 0]);
      assert.deepEqual([w('2026-05-25').done, w('2026-05-25').missed], [0, 1]);
    });
  });

  it('New York (UTC-4 en juin) : dimanche 22 h local (lundi 2 h UTC) reste dans la semaine qui se termine', () => {
    inTimeZone('America/New_York', () => {
      const t = psim();
      t.run(at(2026, 5, 24, 22, 0), 'done');
      t.run(at(2026, 5, 25, 0, 30), 'done');
      const s = t.summary(T0(), 35);
      assert.equal(s.utcOffsetMin, -240);
      const w = (day: string) => s.patrols!.weeks.find((x) => x.weekStart === day)!;
      assert.equal(w('2026-05-18').done, 1);
      assert.equal(w('2026-05-25').done, 1);
    });
  });

  it('les semaines suivent les jours locaux du resume (availability.daily) : le lundi d une semaine est un jour qui y figure', () => {
    inTimeZone('Asia/Kolkata', () => {
      const t = psim();
      t.run(at(2026, 6, 15, 1), 'done');
      const s = t.summary(T0(), 35);
      const days = new Set(s.availability.daily.map((d) => d.day));
      for (const w of s.patrols!.weeks.slice(1)) assert.ok(days.has(w.weekStart), `${w.weekStart} est un jour local du resume`);
    });
  });

  it('changement d heure (Paris, 29 mars 2026) : les lundis restent des lundis, aucune semaine sautee ni doublee', () => {
    inTimeZone('Europe/Paris', () => {
      const t = psim();
      t.run(at(2026, 3, 30, 0, 30), 'done'); // lundi juste apres le passage a l'heure d'ete
      t.run(at(2026, 3, 29, 23, 0), 'missed'); // dimanche, veille du lundi
      const s = t.summary(at(2026, 4, 2, 12), 14);
      const p = s.patrols!;
      assert.deepEqual(p.weeks.map((w) => w.weekStart), ['2026-03-16', '2026-03-23', '2026-03-30']);
      assert.deepEqual([p.weeks[1].missed, p.weeks[1].done], [1, 0]);
      assert.deepEqual([p.weeks[2].missed, p.weeks[2].done], [0, 1]);
    });
  });
});

describe('rondes dans le resume : presence du champ', () => {
  it('absent sans les tables de rondes (PSIM sans application des agents), et la cle n existe meme pas dans le JSON', () => {
    const t = psim({ tables: false });
    const s = t.summary(T0());
    assert.equal(s.patrols, undefined);
    assert.ok(!('patrols' in JSON.parse(JSON.stringify(s))));
  });

  it('absent avec les tables mais ni circuit ni ronde dans la fenetre', () => {
    const t = psim({ route: false });
    t.run(T0() - 60 * DAY, 'done'); // une ronde, mais hors fenetre
    assert.equal(t.summary(T0()).patrols, undefined);
  });

  it('present avec un circuit seul (meme archive) : des semaines a zero, taux null', () => {
    const t = psim();
    t.db.prepare('UPDATE patrol_route SET archived_at = ?').run(T0() - DAY);
    const p = t.summary(T0()).patrols!;
    assert.ok(p, 'un circuit archive prouve que l application existe');
    assert.equal(p.weeks.length, 6);
    assert.deepEqual(p.totals, { planned: 0, done: 0, incomplete: 0, missed: 0, ratePct: null, sos: 0 });
  });

  it('present avec une ronde dans la fenetre mais plus aucun circuit (circuit supprime)', () => {
    const t = psim({ route: false });
    t.run(at(2026, 6, 14, 22), 'done');
    assert.equal(t.summary(T0()).patrols!.totals.done, 1);
  });

  it('un calcul qui echoue ne gene jamais l envoi : le resume part, sans le champ', () => {
    const t = psim({ tables: false });
    // Tables presentes mais incompatibles (colonne `status` absente) : la requete leve une exception.
    t.db.exec('CREATE TABLE patrol_route (id INTEGER PRIMARY KEY); CREATE TABLE patrol_run (id INTEGER PRIMARY KEY, due_start INTEGER)');
    t.db.prepare('INSERT INTO patrol_route (id) VALUES (1)').run();
    const s = t.summary(T0());
    assert.equal(s.patrols, undefined);
    assert.ok(s.devices.length > 0 && s.availability.daily.length === 35, 'le reste du resume est intact');
  });
});

describe('rondes dans le resume : aucun nom, aucune position', () => {
  it('un PSIM avec des agents nommes, des circuits, des points, des rondes et un SOS : rien de nominatif dans `patrols`', () => {
    const t = psim();
    t.db.exec(`
      CREATE TABLE checkpoint (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, zone TEXT NOT NULL DEFAULT '', floor_id INTEGER NOT NULL, x REAL, y REAL, code TEXT NOT NULL UNIQUE, archived_at INTEGER);
      CREATE TABLE agent_position (username TEXT PRIMARY KEY, checkpoint_id INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE agent_profile (username TEXT PRIMARY KEY, display_name TEXT NOT NULL);
      CREATE TABLE agent_phone (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL);
      INSERT INTO agent_profile (username, display_name) VALUES ('kouassi_yao', 'Kouassi Yao');
      INSERT INTO agent_phone (label) VALUES ('Telephone Dupont');
    `);
    const now = T0();
    t.db.prepare("INSERT INTO checkpoint (name, zone, floor_id, x, y, code) VALUES ('Local bouteilles CAVE-B7', 'Zone Cave', 1, 12.5, 77.25, 'qrcode-secret-abc')").run();
    t.db.prepare('INSERT INTO agent_position (username, checkpoint_id, at) VALUES (?, 1, ?)').run('kouassi_yao', now - 60_000);
    t.db.prepare("INSERT INTO app_user (username, role, salt, hash, display_name) VALUES ('kouassi_yao', 'agent', 's', 'h', 'Kouassi Yao')").run();
    t.db.prepare("UPDATE patrol_route SET name = 'Ronde Parking-Nord', checkpoints = '[1]', agents = '[\"kouassi_yao\"]'").run();
    t.db.prepare("INSERT INTO patrol_run (route_id, due_start, due_end, status, started_by, started_at, finished_at) VALUES (1, ?, ?, 'done', 'kouassi_yao', ?, ?)").run(now - 5 * HOUR, now - 4 * HOUR, now - 5 * HOUR, now - 4 * HOUR);
    t.db.prepare("INSERT INTO patrol_run (route_id, due_start, due_end, status, started_by) VALUES (1, ?, ?, 'incomplete', 'kouassi_yao')").run(now - 3 * HOUR, now - 2 * HOUR);
    t.engine.createDevice('systeme', { id: 'A-kouassi_yao', kind: 'detector', name: 'Agent Kouassi Yao', zone: 'Zone Cave', category: 'people', heartbeatS: 0 });
    t.db.prepare("INSERT INTO incident (detector_id, severity, status, opened_at, closed_at, event, detail) VALUES ('A-kouassi_yao', 'critical', 'closed', ?, ?, 'sos', 'Kouassi : Local bouteilles CAVE-B7')").run(now - 2 * HOUR, now - HOUR);

    t.engine.createDevice('systeme', { id: 'A-phone-1', kind: 'detector', name: 'Telephone Dupont', zone: 'Zone Cave', category: 'people', heartbeatS: 0 });
    t.db.prepare("INSERT INTO incident (detector_id, severity, status, opened_at, closed_at, event, detail) VALUES ('A-phone-1', 'critical', 'closed', ?, ?, 'sos', 'SOS')").run(now - 90 * 60_000, now - HOUR);

    const whole = t.summary(now);
    // Rien de nominatif nulle part dans le resume : ni equipement d'agent, ni nom d'agent dans un incident.
    const all = JSON.stringify(whole);
    for (const secret of ['Kouassi', 'kouassi', 'Dupont', 'A-phone', 'Zone Cave']) assert.ok(!all.includes(secret), `« ${secret} » ne doit pas partir vers le portail`);
    assert.ok(whole.devices.every((d) => d.id !== 'A-kouassi_yao' && d.id !== 'A-phone-1'));
    assert.equal(whole.incidents.filter((i) => i.deviceId === 'agent').length, 2, 'les SOS restent visibles, sous un nom anonyme');
    const p = whole.patrols!;
    assert.equal(p.totals.sos, 2);
    assert.equal(p.totals.done, 1);
    const text = JSON.stringify(p);
    for (const secret of ['Kouassi', 'kouassi', 'Yao', 'Parking', 'Nord', 'bouteilles', 'CAVE', 'Cave', 'qrcode', 'secret', '12.5', '77.25', 'agent']) {
      assert.ok(!text.includes(secret), `« ${secret} » ne doit pas partir vers le portail avec les rondes`);
    }
    // Structure fermee : uniquement des compteurs et la date d'un lundi.
    const counts = ['planned', 'done', 'incomplete', 'missed', 'ratePct', 'sos'];
    assert.deepEqual(Object.keys(p), ['weeks', 'totals']);
    assert.deepEqual(Object.keys(p.totals), counts);
    for (const w of p.weeks) {
      assert.deepEqual(Object.keys(w), ['weekStart', ...counts]);
      assert.match(w.weekStart, /^\d{4}-\d{2}-\d{2}$/);
      for (const k of counts) assert.ok((w as unknown as Record<string, unknown>)[k] === null || typeof (w as unknown as Record<string, unknown>)[k] === 'number');
    }
  });
});

// ------------------------------------------------------------------------------------------------ reception

/** Un resume reel (PSIM de test) qui porte des rondes, sous forme de JSON : de quoi le deformer comme le ferait un emetteur fautif. */
function summaryWithPatrols(now = T0()): { json: any; patrols: PatrolsSummary } {
  const t = psim();
  seedReference(t);
  const s = t.summary(now);
  return { json: JSON.parse(JSON.stringify(s)), patrols: s.patrols! };
}

describe('reception des rondes : validation stricte', () => {
  it('un resume avec rondes est accepte et les rondes sont conservees a l identique', () => {
    const { json, patrols } = summaryWithPatrols();
    const r = parseSummary(json);
    assert.ok(r.ok);
    assert.deepEqual(r.summary.patrols, patrols);
  });

  it('retrocompatibilite : un resume d ancien PSIM, sans le champ (ou avec null), est accepte tel quel', () => {
    const { json } = summaryWithPatrols();
    delete json.patrols;
    const a = parseSummary(json);
    assert.ok(a.ok);
    assert.equal(a.summary.patrols, undefined);
    json.patrols = null;
    const b = parseSummary(json);
    assert.ok(b.ok);
    assert.equal(b.summary.patrols, undefined);
  });

  const week = (over: Record<string, unknown> = {}) => ({ weekStart: '2026-06-08', planned: 3, done: 2, incomplete: 0, missed: 1, ratePct: 67, sos: 1, ...over });
  const patrols = (weeks: unknown[], totals: Record<string, unknown> = { planned: 3, done: 2, incomplete: 0, missed: 1, ratePct: 67, sos: 1 }) => ({ weeks, totals });
  const cases: [string, unknown][] = [
    ['patrols qui n est pas un objet', 'beaucoup'],
    ['patrols tableau', [1, 2]],
    ['patrols sans semaines', { totals: week() }],
    ['semaines qui ne sont pas une liste', { weeks: 'x', totals: week() }],
    ['trop de semaines', patrols(Array.from({ length: MAX_PATROL_WEEKS + 1 }, (_, i) => week({ weekStart: new Date(Date.UTC(2020, 0, 6 + 7 * i)).toISOString().slice(0, 10), planned: 0, done: 0, incomplete: 0, missed: 0, ratePct: null, sos: 0 })), { planned: 0, done: 0, incomplete: 0, missed: 0, ratePct: null, sos: 0 })],
    ['semaine qui n est pas un lundi', patrols([week({ weekStart: '2026-06-09' })])],
    ['date impossible', patrols([week({ weekStart: '2026-02-30' })])],
    ['date injectee', patrols([week({ weekStart: "2026-06-08'; DROP TABLE site;--" })])],
    ['semaines desordonnees', patrols([week({ weekStart: '2026-06-15' }), week()], { planned: 6, done: 4, incomplete: 0, missed: 2, ratePct: 67, sos: 2 })],
    ['semaine en double', patrols([week(), week()], { planned: 6, done: 4, incomplete: 0, missed: 2, ratePct: 67, sos: 2 })],
    ['compteur negatif', patrols([week({ sos: -1 })])],
    ['compteur fractionnaire', patrols([week({ done: 1.5 })])],
    ['compteur en texte', patrols([week({ done: '2' })])],
    ['compteur demesure', patrols([week({ sos: 10 ** 9 })])],
    ['compteur infini (null apres JSON)', patrols([week({ planned: null })])],
    ['plus d echues que de prevues', patrols([week({ planned: 2 })], { planned: 2, done: 2, incomplete: 0, missed: 1, ratePct: 67, sos: 1 })],
    ['taux hors bornes', patrols([week({ ratePct: 150 })])],
    ['taux en texte', patrols([week({ ratePct: '67 %' })])],
    ['taux fractionnaire', patrols([week({ ratePct: 66.7 })])],
    ['taux present sans ronde echue', patrols([week({ planned: 2, done: 0, incomplete: 0, missed: 0, ratePct: 100 })], { planned: 2, done: 0, incomplete: 0, missed: 0, ratePct: null, sos: 1 })],
    ['taux null avec des rondes echues', patrols([week({ ratePct: null })])],
    ['taux qui contredit les compteurs', patrols([week({ ratePct: 99 })])],
    ['total absent', { weeks: [week()] }],
    ['total different de la somme des semaines', patrols([week()], { planned: 3, done: 2, incomplete: 0, missed: 1, ratePct: 67, sos: 9 })],
    ['semaine qui n est pas un objet', patrols([42])],
  ];
  for (const [name, bad] of cases) {
    it(`valeur absurde (${name}) : le champ est ignore, le resume est accepte`, () => {
      const { json } = summaryWithPatrols();
      json.patrols = bad;
      const r = parseSummary(json);
      assert.ok(r.ok, 'le resume n est pas rejete');
      assert.equal(r.summary.patrols, undefined, 'seul le champ des rondes est ecarte');
      assert.equal(r.summary.devices.length, json.devices.length);
      assert.equal(r.summary.siteId, 'site-a');
    });
  }

  it('un indice de risque absurde reste un motif de refus : les rondes ne changent rien a ce comportement', () => {
    const { json } = summaryWithPatrols();
    json.patrols = patrols([week({ weekStart: 'hier' })]);
    json.risk = { index: 61, worstZone: 'A', assessedZones: 1, totalZones: 1, zones: [], history: [] };
    assert.equal(parseSummary(json).ok, false, 'un indice absurde reste un motif de refus (comportement inchange)');
  });

  it('ne garde que les champs connus : noms ou champs ajoutes par l emetteur ne sont ni stockes ni renvoyes', () => {
    const { json } = summaryWithPatrols();
    json.patrols.agents = ['Kouassi Yao'];
    json.patrols.totals.circuit = 'Parking-Nord';
    json.patrols.weeks[0].agent = 'Kouassi Yao';
    json.patrols.weeks[0].points = ['Cave B7'];
    const r = parseSummary(json);
    assert.ok(r.ok);
    const text = JSON.stringify(r.summary.patrols);
    for (const x of ['Kouassi', 'Parking', 'Cave', 'agent', 'points', 'circuit']) assert.ok(!text.includes(x), x);
    assert.deepEqual(r.summary.patrols, summaryWithPatrols().patrols);
  });

  it('le taux est recalcule : un envoi qui arrondit autrement (a 1 point pres) est ramene au calcul du portail', () => {
    const { json } = summaryWithPatrols();
    json.patrols = patrols([week({ ratePct: 66 })]); // 2 sur 3 = 67 ; 66 est a un point
    const r = parseSummary(json);
    assert.ok(r.ok);
    assert.equal(r.summary.patrols!.weeks[0].ratePct, 67);
  });

  it('une semaine sans ronde echue accepte un taux absent ou null (les deux veulent dire « pas de taux »)', () => {
    const { json } = summaryWithPatrols();
    const empty = { weekStart: '2026-06-08', planned: 1, done: 0, incomplete: 0, missed: 0, sos: 0 }; // sans ratePct
    json.patrols = patrols([empty], { planned: 1, done: 0, incomplete: 0, missed: 0, ratePct: null, sos: 0 });
    const r = parseSummary(json);
    assert.ok(r.ok && r.summary.patrols);
    assert.equal(r.summary.patrols.weeks[0].ratePct, null);
  });
});

describe('restitution : enregistrement, vue du site, anciens enregistrements', () => {
  let portal: Portal;
  before(async () => {
    portal = await startPortal();
    provision(portal.db, 'Client A', 'site-a', 'Entrepôt A');
    provision(portal.db, 'Client A', 'site-b', 'Entrepôt B');
    const orgId = (portal.db.prepare("SELECT id FROM organization WHERE name = 'Client A'").get() as { id: number }).id;
    addUser(portal.db, { username: 'directeur-rondes', role: 'director', orgId });
  });
  after(() => portal.close());
  beforeEach(() => resetThrottles());

  const detail = async (site: string) => (await get(portal, `/api/sites/${site}?days=30`, await login(portal, 'directeur-rondes'))).json;

  it('de bout en bout : le PSIM envoie ses rondes, le portail les enregistre et la vue du site les restitue', async () => {
    const { json, patrols } = summaryWithPatrols();
    const r = await post(portal, { body: JSON.stringify(json) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const d = await detail('site-a');
    assert.deepEqual(d.patrols, patrols);
    assert.equal(d.patrols.weeks.length, 6);
    assert.equal(d.patrols.totals.ratePct, 60);
    assert.equal(d.patrols.totals.sos, 3);
    // La restitution ne ressort que des compteurs.
    assert.deepEqual(Object.keys(d.patrols), ['weeks', 'totals']);
  });

  it('un site qui n envoie pas de rondes : `patrols` vaut null dans la vue, le reste s affiche comme avant', async () => {
    const { json } = summaryWithPatrols();
    delete json.patrols;
    json.siteId = 'site-b';
    const r = await post(portal, { body: JSON.stringify(json), siteId: 'site-b', key: siteKey(MASTER, 'site-b', 1) });
    assert.equal(r.status, 200);
    const d = await detail('site-b');
    assert.equal(d.patrols, null);
    assert.ok(d.devices.length > 0 && d.daily.length > 0);
  });

  it('des rondes absurdes envoyees par un site : resume accepte, vue sans rondes (jamais d erreur 400)', async () => {
    const { json } = summaryWithPatrols(T0() + 60_000);
    json.patrols.weeks[0].done = -4;
    portal.setNow(T0() + 60_000);
    const r = await post(portal, { body: JSON.stringify(json), timestamp: portal.now() });
    assert.equal(r.status, 200);
    assert.equal((await detail('site-a')).patrols, null, 'l instantane le plus recent n a pas de rondes valides');
    portal.setNow(T0());
  });

  it('un enregistrement fait avant cette fonction (instantane sans `patrols`) se lit sans erreur', () => {
    const { json } = summaryWithPatrols();
    delete json.patrols;
    const parsed = parseSummary(json);
    assert.ok(parsed.ok);
    const db = portal.db;
    // Le contenu stocke est exactement ce que l ancienne version ecrivait : pas de cle `patrols`.
    storeSummary(db, 'site-b', parsed.summary, T0() + 120_000);
    const stored = JSON.parse((db.prepare('SELECT payload FROM snapshot WHERE site_id = ?').get('site-b') as { payload: string }).payload);
    assert.ok(!('patrols' in stored));
    const site = db.prepare("SELECT s.id, s.org_id, s.name, s.key_version, s.active, s.last_received_at, s.group_id, o.name AS org_name FROM site s JOIN organization o ON o.id = s.org_id WHERE s.id = 'site-b'").get() as unknown as VisibleSite;
    const d = siteDetail(db, site, 30, T0() + 120_000, 900_000);
    assert.equal(d.patrols, null);
  });

  it('les anciennes donnees stockees ne sont pas modifiees : aucune table ni colonne ajoutee pour les rondes', () => {
    const tables = (portal.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    assert.ok(!tables.some((n) => /patrol|ronde/i.test(n)));
  });
});
