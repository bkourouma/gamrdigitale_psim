/**
 * Titulaires de badges (lot AC5) : titulaires, badges, groupes, horaires, jours feries, visiteurs, droits attendus par controleur,
 * notifications, simulation, rattachement des passages. Base en memoire, horloge injectee (aucune attente reelle), moteur et
 * module d'acces REELS pour le journal et le rattachement des passages.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, it, mock } from 'node:test';
import { createAccess } from '../server/access.ts';
import type { AccessService } from '../server/access.ts';
import { createHolders, migrateHolders, BUILTIN_SCHEDULE_NAME, MAX_GROUPS, MAX_HOLDERS, MAX_SCHEDULES } from '../server/accessholders.ts';
import type { HolderInput } from '../server/accessholderstypes.ts';
import type { HoldersService } from '../server/accessholderstypes.ts';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import type { Engine } from '../server/engine.ts';
import { seedDemo } from '../server/seed.ts';

// Caracteres invisibles ou de controle, construits par code (illisibles et fragiles dans un fichier source).
const BIDI = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const LINESEP = String.fromCharCode(0x2028);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const S = 1000;
const MIN = 60 * S;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T = Date.UTC(2026, 9, 17, 8, 0, 0);
const SEED = join(import.meta.dirname, '..', 'seed');

let db: DatabaseSync;
let engine: Engine;
let access: AccessService;
let holders: HoldersService;
let clock: number;
let retention: number;
let calls: string[][];
let seq = 0;

function setup(): void {
  db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-holders-')), SEED);
  clock = T;
  retention = 90;
  seq = 0;
  holders = createHolders({ db, now: () => clock, audit: (actor, action, ref) => engine.audit(actor, action, ref), retentionDays: () => retention });
  access = createAccess({
    db,
    now: () => clock,
    key: randomBytes(32),
    audit: (actor, action, ref) => engine.audit(actor, action, ref),
    setDeviceState: (id, state, event) => engine.setStateBySupervisor(id, state, event),
    resolveHolder: holders.resolve,
  });
  engine = createEngine(db, () => {}, () => clock, { access });
  // Controleurs : CTL-1 (A-01 n°1, A-02 n°2), CTL-2 (A-03 n°1, A-04 n°2), CTL-3 sans porte.
  for (const id of ['A-02', 'A-03', 'A-04']) engine.createDevice('admin', { id, kind: 'detector', name: `Porte ${id}`, zone: 'Entrepot', category: 'access' });
  for (const id of ['CTL-1', 'CTL-2', 'CTL-3']) access.createController('admin', { id, name: `Controleur ${id}`, brand: 'dahua' });
  access.declareDoor('admin', { detectorId: 'A-01', controllerId: 'CTL-1', doorNo: 1 });
  access.declareDoor('admin', { detectorId: 'A-02', controllerId: 'CTL-1', doorNo: 2 });
  access.declareDoor('admin', { detectorId: 'A-03', controllerId: 'CTL-2', doorNo: 1 });
  access.declareDoor('admin', { detectorId: 'A-04', controllerId: 'CTL-2', doorNo: 2 });
  calls = [];
  holders.subscribe((ids) => calls.push(ids));
}

/** L'appel doit lever une PsimError du statut donne (et dont le message correspond). */
function refuses(fn: () => unknown, status: number, match?: RegExp, label = ''): void {
  assert.throws(
    fn,
    (e: unknown) => {
      assert.ok(e instanceof PsimError, `${label} : PsimError attendue, recu ${String(e)}`);
      assert.equal(e.status, status, `${label} : statut ${e.status} (${e.message})`);
      if (match) assert.match(e.message, match, label);
      return true;
    },
    label,
  );
}

const audits = (action: string) => (db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as Record<string, unknown>[]);
const auditCount = () => (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
const always = (): number => holders.schedules().find((s) => s.builtin)!.id;
const rowCount = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Horaire « jours ouvres ». */
function workdays(name = 'Jours ouvres'): number {
  return holders.createSchedule('admin', { name, windows: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }] }).id;
}

/** Groupe donnant ces portes avec l'horaire (par defaut « Tout le temps »). */
function mkGroup(name: string, doors: [string, number?][], extra: Record<string, unknown> = {}): number {
  return holders.createGroup('admin', { name, doors: doors.map(([doorId, scheduleId]) => ({ doorId, scheduleId: scheduleId ?? always() })), ...extra }).id;
}

function mkStaff(lastName: string, firstName = '', extra: HolderInput = {}): number {
  return holders.create('admin', { lastName, firstName, ...extra }).id;
}

const noPhoto = (): Buffer => Buffer.alloc(0);
const JPEG = (n = 40): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);
const PNG = (n = 40): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 7)]);
const WEBP = (n = 40): Buffer => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x30, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(n, 7)]);

type Json = Record<string, unknown>;
/** Message de passage conforme au contrat (docs/CONTROLE-ACCES.md § 2). */
function passage(acc: Json = {}, over: Json = {}): Json {
  const eventId = String(++seq);
  return {
    event: 'badge_granted',
    ts: clock - 5 * S,
    msgId: `acc:CTL-1:${eventId}`,
    access: { v: 1, controllerId: 'CTL-1', eventId, direction: 'in', credential: null, holderName: null, holderRef: null, method: 'badge', result: 'granted', reason: null, deferred: false, ...acc },
    ...over,
  };
}
const events = () => db.prepare('SELECT * FROM access_event ORDER BY id').all() as Json[];

// ---------------------------------------------------------------------------------------------------------------------------------

describe('migration et ouverture', () => {
  beforeEach(setup);

  it('la migration est rejouable et la plage « Tout le temps » existe une seule fois', () => {
    migrateHolders(db);
    migrateHolders(db);
    createHolders({ db, audit: () => {} });
    const builtin = holders.schedules().filter((s) => s.builtin);
    assert.equal(builtin.length, 1);
    assert.equal(builtin[0].name, BUILTIN_SCHEDULE_NAME);
    assert.equal(builtin[0].ref, `S${builtin[0].id}`);
    assert.equal(builtin[0].closedOnHolidays, false);
    assert.deepEqual(builtin[0].windows, [
      { days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '12:00' },
      { days: [0, 1, 2, 3, 4, 5, 6], from: '12:00', to: '00:00' },
    ]);
  });

  it('les deux plages de « Tout le temps » couvrent chaque minute de la semaine', () => {
    // Reference de lecture : server/arming.ts (inSchedule) ; tout instant de la semaine doit etre dans l'une des plages.
    return import('../server/arming.ts').then(({ inSchedule }) => {
      const windows = holders.schedules().find((s) => s.builtin)!.windows;
      for (let ts = T; ts < T + 8 * DAY; ts += 7 * MIN + 13 * S) assert.ok(inSchedule(windows, ts), new Date(ts).toISOString());
    });
  });

  it('controllerIds() liste les controleurs declares, tries', () => {
    assert.deepEqual(holders.controllerIds(), ['CTL-1', 'CTL-2', 'CTL-3']);
  });
});

describe('titulaires : creation, lecture, modification, suppression', () => {
  beforeEach(setup);

  it('cree un titulaire avec ses badges et ses groupes, et le relit', () => {
    const g = mkGroup('Direction', [['A-01']]);
    clock += 1000;
    const v = holders.create('admin', { lastName: 'KONAN', firstName: 'Yao', externalRef: 'M-001', badges: ['0012345', 'AB_cd-9'], groupIds: [g], validFrom: T, validTo: T + 30 * DAY });
    assert.equal(v.ref, `H${v.id}`);
    assert.equal(v.displayName, 'KONAN Yao');
    assert.equal(v.externalRef, 'M-001');
    assert.equal(v.kind, 'staff');
    assert.equal(v.status, 'active');
    assert.equal(v.phase, 'valid');
    assert.equal(v.hasPhoto, false);
    assert.equal(v.visitor, null);
    assert.deepEqual(v.badges.map((b) => [b.number, b.state, b.stateLabel]), [['0012345', 'active', 'Actif'], ['AB_cd-9', 'active', 'Actif']]);
    assert.deepEqual(v.groups, [{ id: g, name: 'Direction' }]);
    assert.equal(v.createdBy, 'admin');
    assert.equal(v.createdAt, clock);
    const detail = holders.get(v.id);
    assert.equal(detail.id, v.id);
    assert.deepEqual(detail.recentPassages, []);
  });

  it('un titulaire sans prenom ni matricule : prenom vide, matricule null ; les zeros du badge sont conserves', () => {
    const v = holders.create('admin', { lastName: 'Diallo', badges: ['000123'] });
    assert.equal(v.firstName, '');
    assert.equal(v.displayName, 'Diallo');
    assert.equal(v.externalRef, null);
    assert.equal(v.badges[0].number, '000123');
  });

  it('noms : forme composee (NFC), espaces de bord retires, accents et apostrophes acceptes', () => {
    const decomposed = `Re${String.fromCharCode(0x301)}nee`; // e + accent combinant
    const v = holders.create('admin', { lastName: `  ${decomposed} `, firstName: " Jean-Pierre O'Brien " });
    assert.equal(v.lastName, decomposed.normalize('NFC'));
    assert.equal(v.lastName.length, 5);
    assert.equal(v.firstName, "Jean-Pierre O'Brien");
  });

  it('modifie : champs absents inchanges, nom recalcule, matricule vide efface, journal par identifiants', () => {
    const id = mkStaff('Konan', 'Yao', { externalRef: 'M-1', validTo: T + DAY });
    clock += 5 * S;
    const v = holders.update('admin2', id, { lastName: 'Kouassi', externalRef: null, status: 'suspended' });
    assert.equal(v.lastName, 'Kouassi');
    assert.equal(v.firstName, 'Yao');
    assert.equal(v.externalRef, null);
    assert.equal(v.status, 'suspended');
    assert.equal(v.validTo, T + DAY);
    assert.equal(v.updatedBy, 'admin2');
    assert.equal(v.updatedAt, clock);
    assert.equal(holders.findByName('kouassi', 'YAO').length, 1);
    assert.equal(holders.findByName('Konan', 'Yao').length, 0);
    const [entry] = audits('access_holder_updated');
    assert.equal(entry.details, `H${id} : nom, matricule, statut`);
  });

  it('une modification sans effet ne journalise rien, ne notifie rien et ne touche pas la date', () => {
    const id = mkStaff('Konan', 'Yao');
    const before = holders.get(id);
    clock += 10 * S;
    const n = auditCount();
    const v = holders.update('admin', id, { lastName: 'Konan', firstName: 'Yao', status: 'active' });
    assert.equal(v.updatedAt, before.updatedAt);
    assert.equal(auditCount(), n);
    assert.deepEqual(calls, []);
  });

  it('efface le prenom (null) et les dates de validite (null)', () => {
    const id = mkStaff('Konan', 'Yao', { validFrom: T - DAY, validTo: T + DAY });
    const v = holders.update('admin', id, { firstName: null, validFrom: null, validTo: null });
    assert.equal(v.firstName, '');
    assert.equal(v.validFrom, null);
    assert.equal(v.validTo, null);
  });

  it('phase : a venir, valide, expire', () => {
    const upcoming = holders.create('admin', { lastName: 'A', validFrom: T + HOUR });
    const expired = holders.create('admin', { lastName: 'B', validTo: T - 1 });
    const valid = holders.create('admin', { lastName: 'C', validFrom: T - HOUR, validTo: T + HOUR });
    assert.deepEqual([upcoming.phase, expired.phase, valid.phase], ['upcoming', 'expired', 'valid']);
  });

  it('supprime un titulaire : badges, groupes, photo supprimes ; le numero du titulaire n\'est jamais reutilise ; les passages restent', () => {
    const g = mkGroup('Direction', [['A-01']]);
    const id = mkStaff('Konan', 'Yao', { badges: ['111'], groupIds: [g] });
    holders.setPhoto('admin', id, 'image/jpeg', JPEG());
    send('A-01', passage({ credential: '111' }));
    assert.equal(events()[0].holder_id, id);
    holders.remove('admin', id);
    assert.equal(rowCount('access_holder'), 0);
    assert.equal(rowCount('access_badge'), 0);
    assert.equal(rowCount('access_holder_group'), 0);
    assert.equal(rowCount('access_holder_photo'), 0);
    assert.equal(rowCount('access_event'), 1);
    refuses(() => holders.get(id), 404, /Titulaire introuvable/);
    assert.equal(mkStaff('Autre') > id, true);
    assert.equal(holders.resolve('111', null), null);
    assert.equal(audits('access_holder_deleted').length, 1);
  });

  it('identifiants invalides ou inconnus : 404 sans interroger la base', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, '1', null, undefined, {}, [1], 99999]) {
      refuses(() => holders.get(bad as never), 404, /Titulaire introuvable/, `get ${String(bad)}`);
      refuses(() => holders.update('admin', bad as never, { lastName: 'X' }), 404, /Titulaire introuvable/, `update ${String(bad)}`);
      refuses(() => holders.remove('admin', bad as never), 404, /Titulaire introuvable/, `remove ${String(bad)}`);
      refuses(() => holders.setPhoto('admin', bad as never, 'image/jpeg', JPEG()), 404, /Titulaire introuvable/, `photo ${String(bad)}`);
    }
  });

  it('findByExternalRef (sans tenir compte de la casse), findByBadge, findByName (sans accents)', () => {
    const id = mkStaff('Noël', 'Éloïse', { externalRef: 'Mat/01', badges: ['AbC123'] });
    assert.equal(holders.findByExternalRef('mat/01')?.id, id);
    assert.equal(holders.findByExternalRef('MAT/01')?.id, id);
    assert.equal(holders.findByExternalRef('autre'), null);
    assert.equal(holders.findByExternalRef(['x'] as never), null);
    assert.equal(holders.findByBadge('abc123')?.id, id);
    assert.equal(holders.findByBadge('zzz'), null);
    assert.equal(holders.findByBadge({} as never), null);
    assert.equal(holders.findByName('noel', 'ELOISE')[0].id, id);
    assert.equal(holders.findByName('noel', '').length, 0);
    assert.deepEqual(holders.findByName(5 as never, 'x'), []);
    // Homonymes : « Jean Pierre » + « Dupont » n'est pas « Jean » + « Pierre Dupont ».
    mkStaff('Dupont', 'Jean Pierre');
    mkStaff('Pierre Dupont', 'Jean');
    assert.equal(holders.findByName('Dupont', 'Jean Pierre').length, 1);
    mkStaff('Dupont', 'Jean Pierre');
    assert.equal(holders.findByName('Dupont', 'Jean Pierre').length, 2);
  });

  it('un titulaire sans badge actif est possible ; matricule unique sans tenir compte de la casse', () => {
    mkStaff('A', '', { externalRef: 'Mat-1' });
    refuses(() => holders.create('admin', { lastName: 'B', externalRef: 'mat-1' }), 409, /matricule/);
    const b = mkStaff('B', '', { externalRef: 'Mat-2' });
    refuses(() => holders.update('admin', b, { externalRef: 'MAT-1' }), 409, /matricule/);
    // Son propre matricule dans une autre casse reste permis.
    assert.equal(holders.update('admin', b, { externalRef: 'MAT-2' }).externalRef, 'MAT-2');
  });
});

describe('entrees hostiles', () => {
  beforeEach(setup);

  const badNames: [string, unknown][] = [
    ['tableau', ['A']], ['nombre', 123], ['objet', {}], ['booleen', true], ['null', null], ['vide', ''], ['espaces', '   '],
    ['41 caracteres', 'A'.repeat(41)], ['enorme', 'A'.repeat(1_000_000)], ['=cmd', '=cmd|calc'], ['+1', '+33'], ['-1', '-5'], ['@x', '@SUM(1)'],
    ['balise', '<script>alert(1)</script>'], ['chevron', 'a>b'], ['tabulation', 'a\tb'], ['retour', 'a\nb'], ['nul', 'a\u0000b'],
    ['bidi', `ab${BIDI}cd`], ['largeur nulle', `ab${ZWSP}cd`], ['separateur de ligne', `ab${LINESEP}cd`], ['substitut isole', `ab${LONE_SURROGATE}`], ['C1', 'a\u0085b'],
  ];

  it('nom : refus 400 precis pour chaque entree hostile', () => {
    for (const [label, value] of badNames) {
      refuses(() => holders.create('admin', { lastName: value as never }), 400, /nom/i, `nom ${label}`);
    }
  });

  it('prenom : memes refus (sauf vide et null, permis)', () => {
    for (const [label, value] of badNames) {
      if (value === '' || value === null || (typeof value === 'string' && value.trim() === '')) continue;
      refuses(() => holders.create('admin', { lastName: 'Ok', firstName: value as never }), 400, /prénom/i, `prenom ${label}`);
    }
    assert.equal(holders.create('admin', { lastName: 'Ok', firstName: '' }).firstName, '');
    assert.equal(holders.create('admin', { lastName: 'Ok', firstName: null }).firstName, '');
  });

  it('nom + prenom : 63 caracteres au plus, ensemble', () => {
    const ok = holders.create('admin', { lastName: 'A'.repeat(40), firstName: 'b'.repeat(22) });
    assert.equal(ok.displayName.length, 63);
    refuses(() => holders.create('admin', { lastName: 'A'.repeat(40), firstName: 'b'.repeat(23) }), 400, /63/);
    assert.equal(holders.create('admin', { lastName: 'A'.repeat(40), firstName: '' }).lastName.length, 40);
    refuses(() => holders.create('admin', { lastName: 'A', firstName: 'b'.repeat(41) }), 400, /prénom/);
    // Un trait d'union ou une apostrophe au milieu d'un nom restent permis.
    assert.equal(holders.create('admin', { lastName: 'Ben-Ali', firstName: "N'Dri" }).displayName, "Ben-Ali N'Dri");
  });

  it('creer un titulaire avec kind = visiteur est refuse (createVisitor existe pour cela)', () => {
    refuses(() => holders.create('admin', { lastName: 'A', kind: 'visitor' } as never), 400, /accueil/);
    refuses(() => holders.create('admin', { lastName: 'A', kind: null } as never), 400, /accueil/);
    assert.equal(holders.create('admin', { lastName: 'A', kind: 'staff' } as never).kind, 'staff');
  });

  it('corps qui n\'est pas un objet : 400', () => {
    for (const body of [null, undefined, [], ['lastName'], 'x', 5, true]) {
      refuses(() => holders.create('admin', body as never), 400, /objet/, `create ${String(body)}`);
    }
    const id = mkStaff('A');
    for (const body of [null, [], 'x', 5]) refuses(() => holders.update('admin', id, body as never), 400, /objet/, `update ${String(body)}`);
  });

  it('matricule : format, longueur, types', () => {
    for (const bad of [12, ['a'], {}, 'a b', 'é', 'x'.repeat(33), '=1', 'a;b', 'a<b', 'a\tb', true]) {
      refuses(() => holders.create('admin', { lastName: 'A', externalRef: bad as never }), 400, /matricule/i, `matricule ${String(bad)}`);
    }
    assert.equal(holders.create('admin', { lastName: 'A', externalRef: 'x'.repeat(32) }).externalRef?.length, 32);
    assert.equal(holders.create('admin', { lastName: 'B', externalRef: 'A.b_c/d-e' }).externalRef, 'A.b_c/d-e');
    assert.equal(holders.create('admin', { lastName: 'C', externalRef: '' }).externalRef, null);
    assert.equal(holders.create('admin', { lastName: 'D', externalRef: '  ' }).externalRef, null);
  });

  it('statut, dates, groupes et badges : types et bornes', () => {
    for (const bad of ['x', 1, ['active'], {}, true]) refuses(() => holders.create('admin', { lastName: 'A', status: bad as never }), 400, /statut/i, `statut ${String(bad)}`);
    for (const bad of [1.5, '1', NaN, Infinity, -1, true, {}, [1], T * 1000 * 1000]) {
      refuses(() => holders.create('admin', { lastName: 'A', validFrom: bad as never }), 400, /début de validité/, `validFrom ${String(bad)}`);
      refuses(() => holders.create('admin', { lastName: 'A', validTo: bad as never }), 400, /fin de validité/, `validTo ${String(bad)}`);
    }
    refuses(() => holders.create('admin', { lastName: 'A', validFrom: T + HOUR, validTo: T + HOUR }), 400, /postérieure/);
    refuses(() => holders.create('admin', { lastName: 'A', validFrom: T + HOUR, validTo: T }), 400, /postérieure/);
    refuses(() => holders.create('admin', { lastName: 'A', validTo: T + 21 * 365 * DAY }), 400, /20 ans/);
    assert.equal(holders.create('admin', { lastName: 'A', validTo: T + 19 * 365 * DAY }).phase, 'valid');
    const g = mkGroup('G', [['A-01']]);
    for (const bad of ['x', 5, {}, [1.5], ['1'], [0], [-1], [9999], [null], Array.from({ length: 21 }, (_, i) => i + 1)]) {
      refuses(() => holders.create('admin', { lastName: 'A', groupIds: bad as never }), 400, /groupe/i, `groupIds ${JSON.stringify(bad)}`);
    }
    assert.deepEqual(holders.create('admin', { lastName: 'A', groupIds: [g, g] }).groups.length, 1);
    for (const bad of ['x', 5, {}, [5], ['a b'], [''], ['é'], ['x'.repeat(33)], ['1', '2', '3', '4', '5'], ['AA', 'aa'], [['1']], [null]]) {
      refuses(() => holders.create('admin', { lastName: 'A', badges: bad as never }), 400, /badge/i, `badges ${JSON.stringify(bad)}`);
    }
    assert.equal(rowCount('access_holder'), 2, 'aucun titulaire a moitie cree');
    assert.equal(rowCount('access_badge'), 0);
  });

  it('un echec en cours de creation n\'en laisse aucune trace (badge deja pris)', () => {
    mkStaff('A', '', { badges: ['111'] });
    const n = rowCount('access_holder');
    refuses(() => holders.create('admin', { lastName: 'B', badges: ['222', '111'] }), 409, /badge/);
    assert.equal(rowCount('access_holder'), n);
    assert.equal(rowCount('access_badge'), 1);
    assert.deepEqual(calls, []);
  });

  it('modification : badges refuses, type de titulaire inchange, fenetre de validite verifiee sur les valeurs fusionnees', () => {
    const id = mkStaff('A', '', { validFrom: T, validTo: T + DAY });
    refuses(() => holders.update('admin', id, { badges: ['1'] }), 400, /un par un/);
    refuses(() => holders.update('admin', id, { kind: 'visitor' } as never), 409, /visiteur/);
    assert.equal(holders.update('admin', id, { kind: 'staff' } as never).kind, 'staff');
    refuses(() => holders.update('admin', id, { validTo: T - 1 }), 400, /postérieure/);
    refuses(() => holders.update('admin', id, { validFrom: T + 2 * DAY }), 400, /postérieure/);
    assert.equal(holders.update('admin', id, { validFrom: T - DAY, validTo: T + 3 * DAY }).validTo, T + 3 * DAY);
    refuses(() => holders.update('admin', id, { lastName: '=x' }), 400, /nom/i);
    refuses(() => holders.update('admin', id, { lastName: null as never }), 400, /nom/i);
    refuses(() => holders.update('admin', id, { groupIds: [12345] }), 400, /groupe/i);
  });

  it('__proto__ et propriete heritee : ignores, jamais lus', () => {
    const body = JSON.parse('{"__proto__":{"lastName":"Pirate"},"constructor":{"x":1},"lastName":"Dupont"}');
    assert.equal(holders.create('admin', body).lastName, 'Dupont');
    refuses(() => holders.create('admin', JSON.parse('{"__proto__":{"lastName":"Pirate"}}')), 400, /nom/i);
    (Object.prototype as Json).lastName = 'Pollue';
    try {
      refuses(() => holders.create('admin', {}), 400, /nom/i);
    } finally {
      delete (Object.prototype as Json).lastName;
    }
    assert.equal(({} as Json).lastName, undefined);
  });

  it('visiteur, groupe, horaire et jours feries : memes regles sur les textes', () => {
    refuses(() => holders.createGroup('admin', { name: '=SOMME(A1)' }), 400, /nom du groupe/);
    refuses(() => holders.createGroup('admin', { name: 'ok', description: '<b>x</b>' }), 400, /description/);
    refuses(() => holders.createGroup('admin', { name: ['x'] as never }), 400, /nom du groupe/);
    refuses(() => holders.createGroup('admin', { name: 'x'.repeat(61) }), 400, /nom du groupe/);
    refuses(() => holders.createSchedule('admin', { name: `a${BIDI}b`, windows: [{ days: [1], from: '08:00', to: '09:00' }] }), 400, /nom de l’horaire/);
    refuses(() => holders.setHolidays('admin', [{ date: '2026-12-25', label: '+cmd' }]), 400, /libellé/);
    refuses(() => holders.setHolidays('admin', [{ date: '2026-12-25', label: `x${ZWSP}` }]), 400, /libellé/);
  });
});

describe('badges', () => {
  beforeEach(setup);

  it('un numero est unique tant que le badge n\'est pas rendu ; un badge rendu libere son numero ; un badge perdu le garde', () => {
    const a = mkStaff('A');
    const b = mkStaff('B');
    const badge = holders.addBadge('admin', a, '0042');
    refuses(() => holders.addBadge('admin', b, '0042'), 409, /déjà enregistré/);
    refuses(() => holders.addBadge('admin', a, '0042'), 409, /ce titulaire/);
    refuses(() => holders.addBadge('admin', b, '0042'.toLowerCase()), 409);
    holders.setBadgeState('admin', badge.id, 'lost');
    refuses(() => holders.addBadge('admin', b, '0042'), 409, /perdu/);
    holders.setBadgeState('admin', badge.id, 'returned');
    const again = holders.addBadge('admin', b, '0042');
    assert.equal(holders.findByBadge('0042')?.id, b);
    // L'ancien badge rendu ne revient pas : le numero appartient a un autre.
    refuses(() => holders.setBadgeState('admin', badge.id, 'active'), 409, /attribué à quelqu’un d’autre/);
    holders.setBadgeState('admin', again.id, 'returned');
    assert.equal(holders.setBadgeState('admin', badge.id, 'active').state, 'active');
    assert.equal(holders.findByBadge('0042')?.id, a);
  });

  it('la casse ne distingue pas deux numeros', () => {
    const a = mkStaff('A');
    holders.addBadge('admin', a, 'abCD12');
    refuses(() => holders.addBadge('admin', mkStaff('B'), 'ABcd12'), 409);
  });

  it('quatre badges actifs au plus, a l\'ajout comme a la reactivation', () => {
    const a = mkStaff('A', '', { badges: ['1', '2', '3', '4'] });
    refuses(() => holders.addBadge('admin', a, '5'), 409, /4 badges actifs/);
    const first = holders.get(a).badges[0];
    holders.setBadgeState('admin', first.id, 'disabled');
    const fifth = holders.addBadge('admin', a, '5');
    assert.equal(fifth.state, 'active');
    refuses(() => holders.setBadgeState('admin', first.id, 'active'), 409, /4 badges actifs/);
    holders.setBadgeState('admin', fifth.id, 'lost');
    assert.equal(holders.setBadgeState('admin', first.id, 'active').state, 'active');
  });

  it('douze lignes au plus ; en supprimer libere une place', () => {
    const a = mkStaff('A');
    for (let i = 0; i < 12; i++) {
      const b = holders.addBadge('admin', a, `B${i}`);
      holders.setBadgeState('admin', b.id, 'returned');
    }
    refuses(() => holders.addBadge('admin', a, 'B99'), 409, /12 badges/);
    holders.removeBadge('admin', holders.get(a).badges[0].id);
    assert.equal(holders.addBadge('admin', a, 'B99').number, 'B99');
  });

  it('etat : valeurs permises seulement, badge inconnu = 404, meme etat = sans effet', () => {
    const a = mkStaff('A', '', { badges: ['1'] });
    const id = holders.get(a).badges[0].id;
    for (const bad of ['x', '', 1, null, undefined, ['active'], {}, 'ACTIVE']) refuses(() => holders.setBadgeState('admin', id, bad), 400, /état du badge/, String(bad));
    for (const bad of [0, -1, 1.5, '1', NaN, 9999, null]) refuses(() => holders.setBadgeState('admin', bad as never, 'lost'), 404, /Badge introuvable/, String(bad));
    for (const bad of [0, 9999, '1']) refuses(() => holders.removeBadge('admin', bad as never), 404, /Badge introuvable/);
    const n = auditCount();
    calls.length = 0;
    assert.equal(holders.setBadgeState('admin', id, 'active').state, 'active');
    assert.equal(auditCount(), n);
    assert.deepEqual(calls, []);
    clock += 3 * S;
    const v = holders.setBadgeState('operateur', id, 'disabled');
    assert.deepEqual([v.state, v.stateLabel, v.stateBy, v.stateAt], ['disabled', 'Désactivé', 'operateur', clock]);
    assert.equal(holders.setBadgeState('admin', id, 'lost').stateLabel, 'Perdu');
    assert.equal(holders.setBadgeState('admin', id, 'returned').stateLabel, 'Rendu');
    assert.equal(audits('access_badge_state_changed').length, 3);
  });

  it('numero invalide : types et format', () => {
    const a = mkStaff('A');
    for (const bad of [123, null, undefined, ['1'], {}, '', ' ', 'a b', 'é1', 'x'.repeat(33), 'x'.repeat(10000), '1;2', '=1', `1${ZWSP}`, '<1>']) {
      refuses(() => holders.addBadge('admin', a, bad), 400, /badge/i, String(bad));
    }
    assert.equal(holders.addBadge('admin', a, ' 77 ').number, '77');
    refuses(() => holders.addBadge('admin', 9999, '1'), 404, /Titulaire introuvable/);
  });

  it('un badge desactive ou perdu reste attribue au titulaire pour le rattachement des passages', () => {
    const a = mkStaff('Konan', 'Yao', { badges: ['111'] });
    holders.setBadgeState('admin', holders.get(a).badges[0].id, 'disabled');
    assert.equal(holders.resolve('111', null)?.id, a);
  });
});

describe('plages horaires et jours feries', () => {
  beforeEach(setup);

  const win = (from = '08:00', to = '18:00', days = [1, 2, 3, 4, 5]) => ({ days, from, to });

  it('cree, relit, modifie, supprime ; jours tries et sans doublon ; reference S<id>', () => {
    const s = holders.createSchedule('admin', { name: 'Equipe de nuit', windows: [{ days: [5, 1, 1, 3], from: '22:00', to: '06:00' }], closedOnHolidays: true });
    assert.equal(s.ref, `S${s.id}`);
    assert.deepEqual(s.windows, [{ days: [1, 3, 5], from: '22:00', to: '06:00' }]);
    assert.equal(s.closedOnHolidays, true);
    assert.equal(s.builtin, false);
    assert.equal(s.groupCount, 0);
    const u = holders.updateSchedule('admin', s.id, { windows: [win()] });
    assert.deepEqual(u.windows, [win()]);
    assert.equal(u.closedOnHolidays, true, 'champ absent = inchange');
    assert.equal(u.name, 'Equipe de nuit');
    assert.equal(holders.updateSchedule('admin', s.id, { closedOnHolidays: false, name: 'Equipe' }).closedOnHolidays, false);
    holders.deleteSchedule('admin', s.id);
    refuses(() => holders.schedule(s.id), 404, /Plage horaire introuvable/);
    assert.deepEqual(['access_schedule_created', 'access_schedule_updated', 'access_schedule_deleted'].map((a) => audits(a).length), [1, 2, 1]);
  });

  it('refuse les plages invalides', () => {
    const base = { name: 'X' };
    const cases: [string, unknown][] = [
      ['absentes', undefined], ['null', null], ['pas un tableau', 'x'], ['objet', {}], ['vide', []],
      ['9 plages', Array.from({ length: 9 }, () => win())], ['heure 25:00', [win('08:00', '25:00')]], ['heure 8:00', [win('8:00', '18:00')]],
      ['debut = fin', [win('08:00', '08:00')]], ['jour 7', [win('08:00', '18:00', [7])]], ['jour decimal', [win('08:00', '18:00', [1.5])]],
      ['aucun jour', [win('08:00', '18:00', [])]], ['jours pas un tableau', [{ days: 'lundi', from: '08:00', to: '09:00' }]], ['8 jours', [win('08:00', '18:00', [0, 1, 2, 3, 4, 5, 6, 0])]],
      ['plage nulle', [null]], ['plage chaine', ['08:00-18:00']], ['heures nombres', [{ days: [1], from: 800, to: 1800 }]],
    ];
    for (const [label, windows] of cases) refuses(() => holders.createSchedule('admin', { ...base, windows } as never), 400, undefined, label);
    assert.equal(holders.createSchedule('admin', { name: 'Huit', windows: Array.from({ length: 8 }, (_, i) => win(`0${i}:00`, `0${i}:30`)) }).windows.length, 8);
    refuses(() => holders.createSchedule('admin', { name: 'Z', windows: [win()], closedOnHolidays: 'oui' as never }), 400, /vrai ou faux/);
    refuses(() => holders.createSchedule('admin', { windows: [win()] }), 400, /nom de l’horaire/);
  });

  it('nom unique sans tenir compte de la casse ni des accents ; la plage systeme est inalterable', () => {
    holders.createSchedule('admin', { name: 'Équipe', windows: [win()] });
    refuses(() => holders.createSchedule('admin', { name: 'equipe', windows: [win()] }), 409, /porte déjà ce nom/);
    refuses(() => holders.createSchedule('admin', { name: 'tout le TEMPS', windows: [win()] }), 409, /porte déjà ce nom/);
    const other = holders.createSchedule('admin', { name: 'Autre', windows: [win()] });
    refuses(() => holders.updateSchedule('admin', other.id, { name: 'ÉQUIPE' }), 409, /porte déjà ce nom/);
    refuses(() => holders.updateSchedule('admin', always(), { name: 'x' }), 409, /système/);
    refuses(() => holders.deleteSchedule('admin', always()), 409, /système/);
    for (const bad of [0, -1, 1.5, '1', null, 9999]) {
      refuses(() => holders.schedule(bad as never), 404);
      refuses(() => holders.updateSchedule('admin', bad as never, {}), 404);
      refuses(() => holders.deleteSchedule('admin', bad as never), 404);
    }
  });

  it('suppression refusee tant qu\'un groupe utilise la plage', () => {
    const s = workdays();
    const g = mkGroup('G', [['A-01', s]]);
    assert.equal(holders.schedule(s).groupCount, 1);
    refuses(() => holders.deleteSchedule('admin', s), 409, /utilisé par 1 groupe/);
    holders.updateGroup('admin', g, { doors: [] });
    holders.deleteSchedule('admin', s);
  });

  it('au plus 100 plages (celle du systeme comprise)', () => {
    for (let i = 0; i < MAX_SCHEDULES - 1; i++) holders.createSchedule('admin', { name: `P${i}`, windows: [win()] });
    refuses(() => holders.createSchedule('admin', { name: 'P-de-trop', windows: [win()] }), 409, /maximal/);
  });

  it('jours feries : calendrier reel de 2020 a 2100, 400 au plus, remplacement complet', () => {
    const r = holders.setHolidays('admin', [{ date: '2026-12-25', label: 'Noël' }, '2026-01-01', { date: '2024-02-29' }]);
    assert.deepEqual(r, [{ date: '2024-02-29', label: null }, { date: '2026-01-01', label: null }, { date: '2026-12-25', label: 'Noël' }]);
    assert.deepEqual(holders.holidays(), r);
    assert.equal(holders.setHolidays('admin', []).length, 0);
    assert.equal(holders.holidays().length, 0);
    const bad: [string, unknown][] = [
      ['pas une liste', 'x'], ['objet', {}], ['null', null], ['30 fevrier', [{ date: '2026-02-30' }]], ['29 fevrier 2025', [{ date: '2025-02-29' }]],
      ['mois 13', [{ date: '2026-13-01' }]], ['jour 00', [{ date: '2026-01-00' }]], ['2019', [{ date: '2019-12-31' }]], ['2101', [{ date: '2101-01-01' }]],
      ['format', [{ date: '25/12/2026' }]], ['date nombre', [{ date: 20261225 }]], ['sans date', [{ label: 'x' }]], ['entree nombre', [5]], ['entree null', [null]],
      ['doublon', [{ date: '2026-12-25' }, '2026-12-25']], ['libelle tableau', [{ date: '2026-12-25', label: ['x'] }]], ['libelle trop long', [{ date: '2026-12-25', label: 'x'.repeat(61) }]],
      ['date enorme', [{ date: '2026-12-25'.padEnd(10000, '0') }]],
    ];
    for (const [label, entries] of bad) refuses(() => holders.setHolidays('admin', entries), 400, undefined, label);
    assert.equal(holders.holidays().length, 0, 'un refus ne modifie rien');
  });

  it('400 jours feries passent, 401 sont refuses ; un refus laisse la liste intacte', () => {
    holders.setHolidays('admin', ['2026-01-01']);
    const dates = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
    assert.equal(holders.setHolidays('admin', dates(400)).length, 400);
    refuses(() => holders.setHolidays('admin', dates(401)), 400, /trop de jours/);
    assert.equal(holders.holidays().length, 400);
  });
});

describe('groupes', () => {
  beforeEach(setup);

  it('cree, relit (portes, horaire, controleur, nombre de titulaires), modifie, supprime', () => {
    const s = workdays();
    const g = holders.createGroup('admin', { name: 'Maintenance', description: 'Equipe technique', forVisitors: false, doors: [{ doorId: 'A-03', scheduleId: s }, { doorId: 'A-01', scheduleId: always() }] });
    assert.deepEqual(g.doors.map((d) => [d.doorId, d.doorName, d.controllerId, d.scheduleName]), [
      ['A-01', (db.prepare("SELECT name FROM device WHERE id = 'A-01'").get() as { name: string }).name, 'CTL-1', BUILTIN_SCHEDULE_NAME],
      ['A-03', 'Porte A-03', 'CTL-2', 'Jours ouvres'],
    ]);
    assert.equal(g.holderCount, 0);
    mkStaff('Konan', '', { groupIds: [g.id] });
    assert.equal(holders.group(g.id).holderCount, 1);
    const u = holders.updateGroup('admin', g.id, { description: 'Nouvelle', forVisitors: true });
    assert.equal(u.description, 'Nouvelle');
    assert.equal(u.forVisitors, true);
    assert.equal(u.doors.length, 2, 'champ absent = inchange');
    assert.deepEqual(holders.groups().map((x) => x.id), [g.id]);
    assert.equal(holders.groupByName('MAINTENANCE')?.id, g.id);
    assert.equal(holders.groupByName('inconnu'), null);
    assert.equal(holders.groupByName(['x'] as never), null);
  });

  it('refuse les portes et horaires inconnus, les doublons et les types faux', () => {
    const ok = { doorId: 'A-01', scheduleId: always() };
    const bad: [string, unknown][] = [
      ['pas un tableau', 'x'], ['porte inconnue', [{ doorId: 'Z-99', scheduleId: always() }]], ['horaire inconnu', [{ doorId: 'A-01', scheduleId: 9999 }]],
      ['horaire texte', [{ doorId: 'A-01', scheduleId: '1' }]], ['porte nombre', [{ doorId: 5, scheduleId: 1 }]], ['porte format', [{ doorId: 'A 01', scheduleId: 1 }]],
      ['doublon', [ok, ok]], ['entree null', [null]], ['entree chaine', ['A-01']], ['201 portes', Array.from({ length: 201 }, () => ok)],
    ];
    for (const [label, doors] of bad) refuses(() => holders.createGroup('admin', { name: `G ${label}`, doors } as never), 400, undefined, label);
    refuses(() => holders.createGroup('admin', { name: 'G', forVisitors: 'oui' as never }), 400, /vrai ou faux/);
    assert.equal(holders.groups().length, 0, 'aucun groupe a moitie cree');
  });

  it('une porte non declaree depuis reste visible (nom null) et sans effet sur les droits', () => {
    const g = mkGroup('G', [['A-01']]);
    const id = mkStaff('Konan', '', { badges: ['1'], groupIds: [g] });
    assert.equal(holders.desired('CTL-1').holders.length, 1);
    access.removeDoor('admin', 'A-01');
    const view = holders.group(g);
    assert.deepEqual([view.doors[0].doorId, view.doors[0].doorName, view.doors[0].controllerId], ['A-01', null, null]);
    assert.equal(holders.desired('CTL-1').holders.length, 0);
    assert.equal(holders.get(id).groups.length, 1);
  });

  it('nom unique sans tenir compte de la casse ni des accents ; suppression refusee tant que le groupe a des titulaires', () => {
    const g = mkGroup('Équipe A', []);
    refuses(() => holders.createGroup('admin', { name: 'equipe a' }), 409, /porte déjà ce nom/);
    const h = mkGroup('B', []);
    refuses(() => holders.updateGroup('admin', h, { name: 'ÉQUIPE A' }), 409, /porte déjà ce nom/);
    const t = mkStaff('Konan', '', { groupIds: [g] });
    refuses(() => holders.deleteGroup('admin', g), 409, /encore 1 titulaire/);
    holders.update('admin', t, { groupIds: [] });
    holders.deleteGroup('admin', g);
    refuses(() => holders.group(g), 404, /Groupe introuvable/);
    for (const bad of [0, -1, '1', 1.5, null, 9999]) {
      refuses(() => holders.group(bad as never), 404);
      refuses(() => holders.updateGroup('admin', bad as never, {}), 404);
      refuses(() => holders.deleteGroup('admin', bad as never), 404);
    }
  });

  it('au plus 200 groupes', () => {
    for (let i = 0; i < MAX_GROUPS; i++) holders.createGroup('admin', { name: `Groupe ${i}` });
    refuses(() => holders.createGroup('admin', { name: 'de trop' }), 409, /maximal/);
  });

  it('au plus 20 groupes par titulaire', () => {
    const ids = Array.from({ length: 21 }, (_, i) => holders.createGroup('admin', { name: `G${i}` }).id);
    assert.equal(holders.create('admin', { lastName: 'A', groupIds: ids.slice(0, 20) }).groups.length, 20);
    refuses(() => holders.create('admin', { lastName: 'B', groupIds: ids }), 400, /20 groupes/);
  });

  it('le groupe d\'un titulaire se retrouve par filtre', () => {
    const g = mkGroup('G', [['A-01']]);
    mkStaff('Dans', '', { groupIds: [g] });
    mkStaff('Hors');
    assert.deepEqual(holders.list({ groupId: g }, 'admin').items.map((h) => h.lastName), ['Dans']);
    assert.deepEqual(holders.list({ groupId: String(g) }, 'admin').items.map((h) => h.lastName), ['Dans']);
  });
});

describe('conflits de droits (une porte, deux groupes, deux horaires)', () => {
  beforeEach(setup);

  it('affectation : deux groupes donnent la meme porte avec des horaires differents = 409 a la creation et a la modification', () => {
    const w = workdays();
    const g1 = mkGroup('Tous horaires', [['A-01']]);
    const g2 = mkGroup('Jours ouvres seulement', [['A-01', w]]);
    refuses(() => holders.create('admin', { lastName: 'Konan', groupIds: [g1, g2] }), 409, /La porte « Porte d.*» est déjà donnée à ce titulaire par le groupe « Tous horaires » avec d’autres horaires/);
    assert.equal(rowCount('access_holder'), 0, 'rien n\'est cree');
    const id = mkStaff('Konan', '', { groupIds: [g1] });
    calls.length = 0;
    refuses(() => holders.update('admin', id, { groupIds: [g1, g2] }), 409, /déjà donnée à ce titulaire/);
    assert.deepEqual(holders.get(id).groups.map((g) => g.id), [g1], 'groupes inchanges');
    assert.deepEqual(calls, []);
  });

  it('affectation : le meme horaire, ou des portes differentes, passent', () => {
    const g1 = mkGroup('G1', [['A-01']]);
    const g2 = mkGroup('G2', [['A-01'], ['A-02']]);
    const g3 = mkGroup('G3', [['A-03', workdays()]]);
    const id = mkStaff('Konan', '', { groupIds: [g1, g2, g3] });
    assert.equal(holders.get(id).groups.length, 3);
    const d = holders.desired('CTL-1').holders[0];
    assert.deepEqual(d.doors.map((x) => x.doorNo), [1, 2], 'A-01 une seule fois');
  });

  it('modification des portes d\'un groupe : le conflit est cherche sur tous ses titulaires', () => {
    const w = workdays();
    const g1 = mkGroup('G1', [['A-01']]);
    const g2 = mkGroup('G2', [['A-02']]);
    mkStaff('Libre', '', { groupIds: [g2] });
    const both = mkStaff('Konan', 'Yao', { groupIds: [g1, g2] });
    refuses(() => holders.updateGroup('admin', g2, { doors: [{ doorId: 'A-01', scheduleId: w }] }), 409, /Konan Yao.*membre de ce groupe.*« G1 ».*d’autres horaires/);
    assert.deepEqual(holders.group(g2).doors.map((d) => d.doorId), ['A-02'], 'groupe inchange');
    // Meme horaire : pas de conflit.
    assert.equal(holders.updateGroup('admin', g2, { doors: [{ doorId: 'A-01', scheduleId: always() }] }).doors[0].doorId, 'A-01');
    // Un groupe sans autre groupe en commun avec ses titulaires change librement.
    const g3 = mkGroup('G3', [['A-04']]);
    mkStaff('Seul', '', { groupIds: [g3] });
    assert.equal(holders.updateGroup('admin', g3, { doors: [{ doorId: 'A-01', scheduleId: w }] }).doors.length, 1);
    assert.equal(holders.get(both).groups.length, 2);
  });

  it('modifier la plage elle-meme ne cree jamais de conflit (meme identifiant)', () => {
    const w = workdays();
    const g1 = mkGroup('G1', [['A-01', w]]);
    const g2 = mkGroup('G2', [['A-01', w]]);
    mkStaff('Konan', '', { groupIds: [g1, g2] });
    holders.updateSchedule('admin', w, { windows: [{ days: [1], from: '09:00', to: '10:00' }] });
    assert.equal(holders.desired('CTL-1').schedules[0].windows[0].from, '09:00');
  });
});

describe('desired : contenu attendu de chaque controleur', () => {
  beforeEach(setup);

  it('portes reparties sur deux controleurs, tri, suspendu, badge perdu, sans porte', () => {
    const w = workdays();
    const all = mkGroup('Tout', [['A-03'], ['A-01']]);
    const ops = mkGroup('Ops', [['A-02', w], ['A-04', w]]);
    const yao = mkStaff('Konan', 'Yao', { externalRef: 'M-1', badges: ['0200', '0100'], groupIds: [all], validFrom: T - DAY, validTo: T + 30 * DAY });
    const awa = mkStaff('Diallo', 'Awa', { groupIds: [ops], status: 'suspended', badges: ['0300'] });
    const lost = mkStaff('Kone', 'Moussa', { badges: ['0400', '0401'], groupIds: [all] });
    holders.setBadgeState('admin', holders.get(lost).badges[1].id, 'lost');
    const disabled = mkStaff('Traore', '', { badges: ['0500'], groupIds: [all] });
    holders.setBadgeState('admin', holders.get(disabled).badges[0].id, 'disabled');
    mkStaff('Sansporte', 'Sam', { badges: ['0600'] });
    const noOps = mkStaff('Pasdeportes', '', { badges: ['0700'], groupIds: [mkGroup('Vide', [])] });

    const c1 = holders.desired('CTL-1');
    assert.deepEqual(c1.holders.map((h) => h.ref), [`H${yao}`, `H${awa}`, `H${lost}`, `H${disabled}`]);
    assert.deepEqual(c1.holders[0], {
      ref: `H${yao}`, name: 'Konan Yao', active: true, validFrom: T - DAY, validTo: T + 30 * DAY, credentials: ['0100', '0200'],
      doors: [{ doorNo: 1, scheduleRef: `S${always()}` }],
    });
    assert.deepEqual(c1.holders[1], { ref: `H${awa}`, name: 'Diallo Awa', active: false, validFrom: null, validTo: null, credentials: ['0300'], doors: [{ doorNo: 2, scheduleRef: `S${w}` }] });
    assert.deepEqual(c1.holders[2].credentials, ['0400'], 'badge perdu retire');
    assert.deepEqual(c1.holders[3].credentials, [], 'badge desactive retire, le titulaire reste connu');
    assert.deepEqual(c1.schedules.map((s) => s.ref), [`S${always()}`, `S${w}`].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
    const c2 = holders.desired('CTL-2');
    assert.deepEqual(c2.holders.map((h) => h.ref), [`H${yao}`, `H${awa}`, `H${lost}`, `H${disabled}`]);
    assert.deepEqual(c2.holders[0].doors, [{ doorNo: 1, scheduleRef: `S${always()}` }]);
    assert.deepEqual(c2.holders[1].doors, [{ doorNo: 2, scheduleRef: `S${w}` }]);
    assert.ok(!c2.holders.some((h) => h.ref === `H${noOps}`));
    assert.deepEqual(holders.desired('CTL-3'), { holders: [], schedules: [], holidays: [] });
    assert.deepEqual(holders.desired('INCONNU'), { holders: [], schedules: [], holidays: [] });
  });

  it('portes d\'un meme titulaire triees par numero de porte, quel que soit l\'ordre de saisie', () => {
    const g = mkGroup('G', [['A-02'], ['A-01']]);
    mkStaff('Konan', '', { groupIds: [g] });
    assert.deepEqual(holders.desired('CTL-1').holders[0].doors.map((d) => d.doorNo), [1, 2]);
  });

  it('les plages utilisees portent les plages et l\'option jours feries ; seules celles utilisees sont listees', () => {
    const closed = holders.createSchedule('admin', { name: 'Ferme feries', windows: [{ days: [1, 2], from: '07:00', to: '19:00' }], closedOnHolidays: true }).id;
    workdays('Inutilisee');
    mkStaff('Konan', '', { groupIds: [mkGroup('G', [['A-01', closed]])] });
    const d = holders.desired('CTL-1');
    assert.deepEqual(d.schedules, [{ ref: `S${closed}`, windows: [{ days: [1, 2], from: '07:00', to: '19:00' }], holidays: true }]);
  });

  it('jours feries : depuis le 1er janvier de l\'annee courante, tries', () => {
    holders.setHolidays('admin', ['2027-01-01', '2025-12-25', '2026-12-25', '2026-01-01', '2026-05-01']);
    assert.deepEqual(holders.desired('CTL-1').holidays, ['2026-01-01', '2026-05-01', '2026-12-25', '2027-01-01']);
    clock = Date.UTC(2027, 5, 1);
    assert.deepEqual(holders.desired('CTL-2').holidays, ['2027-01-01']);
  });

  it('un titulaire dont la validite est depassee reste sur le controleur (qui le refuse « expire »)', () => {
    mkStaff('Konan', '', { groupIds: [mkGroup('G', [['A-01']])], validTo: T - DAY, badges: ['1'] });
    const [h] = holders.desired('CTL-1').holders;
    assert.equal(h.validTo, T - DAY);
    assert.equal(h.active, true);
  });

  it('nom = « NOM Prenom », 64 caracteres au plus', () => {
    mkStaff('A'.repeat(40), 'b'.repeat(22), { groupIds: [mkGroup('G', [['A-01']])] });
    assert.equal(holders.desired('CTL-1').holders[0].name.length, 63);
  });

  it('sortie stable : memes octets d\'un appel a l\'autre, refs triees numeriquement (H2 avant H10), aucun champ en trop ni photo', () => {
    const g = mkGroup('G', [['A-01'], ['A-02']]);
    const ids: number[] = [];
    for (let i = 0; i < 12; i++) ids.push(mkStaff(`Nom${i}`, `P${i}`, { groupIds: [g], badges: [`B${i}b`, `B${i}a`] }));
    holders.setPhoto('admin', ids[3], 'image/png', PNG());
    const a = JSON.stringify(holders.desired('CTL-1'));
    const b = JSON.stringify(holders.desired('CTL-1'));
    assert.equal(a, b);
    const d = holders.desired('CTL-1');
    assert.deepEqual(d.holders.map((h) => h.ref), ids.map((id) => `H${id}`));
    assert.ok(ids.some((id) => id >= 10), 'le test couvre bien H9 < H10');
    for (const h of d.holders) {
      assert.deepEqual(Object.keys(h), ['ref', 'name', 'active', 'validFrom', 'validTo', 'credentials', 'doors']);
      assert.deepEqual(h.credentials, [...h.credentials].sort());
    }
    assert.deepEqual(Object.keys(d), ['holders', 'schedules', 'holidays']);
    assert.ok(!/photo|image|mime|png/i.test(a));
    for (const s of d.schedules) assert.deepEqual(Object.keys(s), ['ref', 'windows', 'holidays']);
    // Un autre ordre de creation des groupes ne change pas la sortie.
    const h0 = d.holders[0];
    holders.update('admin', ids[0], { groupIds: [] });
    holders.update('admin', ids[0], { groupIds: [g] });
    assert.deepEqual(holders.desired('CTL-1').holders[0], h0);
  });

  it('un visiteur en cours figure sur le controleur, un visiteur termine ou echu n\'y figure pas', () => {
    const vg = mkGroup('Visiteurs', [['A-01']], { forVisitors: true });
    const v1 = holders.createVisitor('garde', { lastName: 'Martin', firstName: 'Paul', host: 'Konan', badge: 'V001', groupId: vg, durationMinutes: 60 });
    const v2 = holders.createVisitor('garde', { lastName: 'Durand', host: 'Konan', badge: 'V002', groupId: vg, durationMinutes: 30 });
    assert.deepEqual(holders.desired('CTL-1').holders.map((h) => h.ref), [v1.holder.ref, v2.holder.ref]);
    assert.equal(holders.desired('CTL-1').holders[0].validTo, T + 60 * MIN);
    holders.endVisitor('garde', v2.holder.id);
    assert.deepEqual(holders.desired('CTL-1').holders.map((h) => h.ref), [v1.holder.ref]);
    clock += 61 * MIN; // echu, mais `tick` n'a pas tourne
    assert.deepEqual(holders.desired('CTL-1').holders, []);
  });
});

describe('notifications', () => {
  beforeEach(setup);

  it('ciblees : seuls les controleurs concernes sont prevenus, apres l\'ecriture', () => {
    const g1 = mkGroup('G1', [['A-01']]);
    const g2 = mkGroup('G2', [['A-03']]);
    calls.length = 0;
    const id = mkStaff('Konan', '', { groupIds: [g1] });
    assert.deepEqual(calls, [['CTL-1']]);
    calls.length = 0;
    holders.update('admin', id, { groupIds: [g2] });
    assert.deepEqual(calls, [['CTL-1', 'CTL-2']], 'ancien et nouveau controleur');
    calls.length = 0;
    holders.update('admin', id, { lastName: 'Kouassi' });
    assert.deepEqual(calls, [['CTL-2']], 'le nom part vers les controleurs');
    calls.length = 0;
    holders.update('admin', id, { externalRef: 'M-9' });
    assert.deepEqual(calls, [], 'le matricule ne part pas');
    holders.update('admin', id, { status: 'suspended' });
    assert.deepEqual(calls, [['CTL-2']]);
    calls.length = 0;
    const b = holders.addBadge('admin', id, '111');
    assert.deepEqual(calls, [['CTL-2']]);
    holders.setBadgeState('admin', b.id, 'disabled');
    assert.deepEqual(calls, [['CTL-2'], ['CTL-2']]);
    holders.setBadgeState('admin', b.id, 'lost');
    assert.equal(calls.length, 2, 'desactive -> perdu ne change rien pour le controleur');
    holders.setBadgeState('admin', b.id, 'active');
    assert.equal(calls.length, 3);
    holders.removeBadge('admin', b.id);
    assert.equal(calls.length, 4);
    holders.remove('admin', id);
    assert.deepEqual(calls[4], ['CTL-2']);
  });

  it('un titulaire sans groupe, un groupe sans titulaire, une photo : personne n\'est prevenu', () => {
    const id = mkStaff('Seul', '', { badges: ['1'] });
    holders.update('admin', id, { lastName: 'Seule' });
    holders.addBadge('admin', id, '2');
    holders.setPhoto('admin', id, 'image/jpeg', JPEG());
    holders.clearPhoto('admin', id);
    const g = mkGroup('Vide', [['A-01']]);
    holders.updateGroup('admin', g, { doors: [{ doorId: 'A-03', scheduleId: always() }] });
    holders.updateGroup('admin', g, { name: 'Renomme' });
    workdays('Libre');
    holders.deleteGroup('admin', g);
    holders.remove('admin', id);
    assert.deepEqual(calls, []);
  });

  it('portes d\'un groupe : controleurs avant et apres ; renommer ne notifie pas', () => {
    const g = mkGroup('G', [['A-01']]);
    mkStaff('Konan', '', { groupIds: [g] });
    calls.length = 0;
    holders.updateGroup('admin', g, { name: 'Renomme', description: 'x' });
    assert.deepEqual(calls, []);
    holders.updateGroup('admin', g, { doors: [{ doorId: 'A-03', scheduleId: always() }] });
    assert.deepEqual(calls, [['CTL-1', 'CTL-2']]);
  });

  it('plage : seuls les controleurs des groupes qui l\'utilisent (avec titulaires) ; le nom seul ne notifie pas', () => {
    const w = workdays();
    const unused = workdays('Autre');
    const g = mkGroup('G', [['A-03', w]]);
    mkStaff('Konan', '', { groupIds: [g] });
    calls.length = 0;
    holders.updateSchedule('admin', w, { name: 'Renommee' });
    holders.updateSchedule('admin', unused, { windows: [{ days: [1], from: '08:00', to: '09:00' }] });
    assert.deepEqual(calls, []);
    holders.updateSchedule('admin', w, { closedOnHolidays: true });
    assert.deepEqual(calls, [['CTL-2']]);
  });

  it('jours feries : tous les controleurs', () => {
    holders.setHolidays('admin', ['2026-12-25']);
    assert.deepEqual(calls, [['CTL-1', 'CTL-2', 'CTL-3']]);
  });

  it('rien n\'est notifie quand l\'ecriture echoue', () => {
    const g = mkGroup('G', [['A-01']]);
    mkStaff('Konan', '', { groupIds: [g], badges: ['1'] });
    calls.length = 0;
    refuses(() => holders.create('admin', { lastName: 'B', groupIds: [g], badges: ['1'] }), 409);
    refuses(() => holders.addBadge('admin', 1, '1'), 409);
    refuses(() => holders.update('admin', 1, { groupIds: [9999] }), 400);
    assert.deepEqual(calls, []);
  });

  it('batch : une seule transaction, notifications regroupees et dedoublonnees a la fin', () => {
    const g1 = mkGroup('G1', [['A-01']]);
    const g2 = mkGroup('G2', [['A-03']]);
    calls.length = 0;
    const out = holders.batch(() => {
      const a = mkStaff('A', '', { groupIds: [g1], badges: ['1'] });
      mkStaff('B', '', { groupIds: [g2], badges: ['2'] });
      holders.update('admin', a, { lastName: 'AA' });
      holders.addBadge('admin', a, '3');
      assert.deepEqual(calls, [], 'rien avant la fin');
      return 'fini';
    });
    assert.equal(out, 'fini');
    assert.deepEqual(calls, [['CTL-1', 'CTL-2']]);
    assert.equal(rowCount('access_holder'), 2);
  });

  it('batch : lance dans un batch, tout est annule et rien n\'est notifie ni journalise', () => {
    const g = mkGroup('G', [['A-01']]);
    calls.length = 0;
    const n = auditCount();
    const marker = new Error('boum');
    assert.throws(() => holders.batch(() => {
      mkStaff('A', '', { groupIds: [g], badges: ['1'] });
      mkStaff('B', '', { groupIds: [g] });
      throw marker;
    }), marker);
    assert.equal(rowCount('access_holder'), 0);
    assert.equal(rowCount('access_badge'), 0);
    assert.equal(auditCount(), n);
    assert.deepEqual(calls, []);
    // Le service reste utilisable et notifie de nouveau normalement.
    mkStaff('C', '', { groupIds: [g] });
    assert.deepEqual(calls, [['CTL-1']]);
  });

  it('batch imbriques : l\'echec d\'un batch interne rattrape par l\'appelant n\'annule pas le reste', () => {
    const g1 = mkGroup('G1', [['A-01']]);
    const g2 = mkGroup('G2', [['A-03']]);
    calls.length = 0;
    holders.batch(() => {
      mkStaff('A', '', { groupIds: [g1] });
      assert.throws(() => holders.batch(() => {
        mkStaff('B', '', { groupIds: [g2] });
        throw new Error('interne');
      }));
    });
    assert.deepEqual(holders.list({}, 'admin').items.map((h) => h.lastName), ['A']);
    assert.deepEqual(calls, [['CTL-1']], 'le controleur du batch annule n\'est pas prevenu');
  });

  it('une erreur d\'ecouteur est capturee : l\'ecriture reussit et les autres ecouteurs sont appeles', () => {
    const quiet = mock.method(console, 'error', () => {});
    try {
      holders.subscribe(() => {
        throw new Error('ecouteur casse');
      });
      let third = 0;
      holders.subscribe(() => third++);
      const g = mkGroup('G', [['A-01']]);
      const v = holders.create('admin', { lastName: 'A', groupIds: [g] });
      assert.equal(v.groups.length, 1);
      assert.equal(third, 1);
      assert.ok(quiet.mock.callCount() >= 1);
    } finally {
      quiet.mock.restore();
    }
  });

  it('un ecouteur recoit une copie : la modifier ne change pas ce que voient les autres', () => {
    const seen: string[][] = [];
    holders.subscribe((ids) => ids.push('PIRATE'));
    holders.subscribe((ids) => seen.push(ids));
    mkStaff('A', '', { groupIds: [mkGroup('G', [['A-01']])] });
    assert.deepEqual(seen, [['CTL-1']]);
  });
});

describe('simulate', () => {
  beforeEach(setup);

  it('execute puis annule : aucune ligne, aucune entree de journal, aucune notification ; renvoie le resultat', () => {
    const g = mkGroup('G', [['A-01']]);
    mkStaff('Existant', '', { groupIds: [g], badges: ['9'] });
    const snapshot = () => ['access_holder', 'access_badge', 'access_group', 'access_holder_group', 'access_schedule', 'access_holiday', 'audit_log'].map(rowCount);
    const sequenceBefore = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'access_holder'").get() as { seq: number };
    const before = snapshot();
    calls.length = 0;
    const out = holders.simulate(() => {
      const a = mkStaff('Fantome', 'X', { groupIds: [g], badges: ['1', '2'] });
      holders.update('admin', a, { status: 'suspended' });
      mkGroup('Fantome', [['A-03']]);
      holders.setHolidays('admin', ['2026-12-25']);
      workdays('Fantome');
      holders.addBadge('admin', a, '3');
      assert.equal(holders.findByBadge('1')?.id, a, 'visible a l\'interieur de la simulation');
      assert.equal(holders.desired('CTL-1').holders.length, 2);
      return { a, listed: holders.list({}, 'admin').total };
    });
    assert.equal(out.listed, 2);
    assert.deepEqual(snapshot(), before);
    assert.equal(holders.findByBadge('1'), null);
    assert.deepEqual(calls, []);
    assert.deepEqual(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'access_holder'").get(), sequenceBefore, 'les numeros sont rendus aussi');
    assert.equal(holders.desired('CTL-1').holders.length, 1);
  });

  it('une erreur dans la simulation la traverse apres annulation, et les ecritures suivantes notifient normalement', () => {
    const g = mkGroup('G', [['A-01']]);
    const n = rowCount('access_holder');
    refuses(() => holders.simulate(() => {
      mkStaff('A', '', { groupIds: [g] });
      return holders.create('admin', { lastName: '=boum' });
    }), 400);
    assert.equal(rowCount('access_holder'), n);
    calls.length = 0;
    mkStaff('Vrai', '', { groupIds: [g] });
    assert.deepEqual(calls, [['CTL-1']]);
  });

  it('simulate dans un batch : les ecritures du batch sont gardees et notifiees, la simulation non', () => {
    const g1 = mkGroup('G1', [['A-01']]);
    const g2 = mkGroup('G2', [['A-03']]);
    calls.length = 0;
    holders.batch(() => {
      mkStaff('Vrai', '', { groupIds: [g1] });
      holders.simulate(() => mkStaff('Fantome', '', { groupIds: [g2] }));
    });
    assert.deepEqual(holders.list({}, 'admin').items.map((h) => h.lastName), ['Vrai']);
    assert.deepEqual(calls, [['CTL-1']]);
  });

  it('batch dans une simulation : rien n\'est notifie', () => {
    const g = mkGroup('G', [['A-01']]);
    calls.length = 0;
    holders.simulate(() => holders.batch(() => mkStaff('A', '', { groupIds: [g] })));
    assert.deepEqual(calls, []);
    assert.equal(rowCount('access_holder'), 0);
  });

  it('une simulation d\'import detecte les memes erreurs que la realite (badge deja pris) sans rien laisser', () => {
    mkStaff('A', '', { badges: ['1'] });
    refuses(() => holders.simulate(() => holders.create('admin', { lastName: 'B', badges: ['1'] })), 409);
    assert.equal(rowCount('access_holder'), 1);
  });
});

describe('visiteurs', () => {
  let vg: number;
  beforeEach(() => {
    setup();
    vg = mkGroup('Visiteurs', [['A-01']], { forVisitors: true });
  });

  const visitor = (over: Record<string, unknown> = {}) => ({ lastName: 'Martin', firstName: 'Paul', host: 'Konan Yao', reason: 'Livraison', badge: 'V001', groupId: vg, durationMinutes: 60, ...over });

  it('cree un visiteur : titulaire visiteur, badge actif, debut = maintenant, fin = maintenant + duree', () => {
    calls.length = 0;
    const v = holders.createVisitor('garde', visitor());
    assert.equal(v.state, 'present');
    assert.equal(v.startsAt, T);
    assert.equal(v.endsAt, T + 60 * MIN);
    assert.equal(v.remainingMs, 60 * MIN);
    assert.equal(v.host, 'Konan Yao');
    assert.equal(v.reason, 'Livraison');
    assert.equal(v.lastPassage, null);
    assert.equal(v.holder.kind, 'visitor');
    assert.deepEqual(v.holder.visitor, { host: 'Konan Yao', reason: 'Livraison', endedAt: null });
    assert.deepEqual(v.holder.badges.map((b) => [b.number, b.state]), [['V001', 'active']]);
    assert.deepEqual(v.holder.groups, [{ id: vg, name: 'Visiteurs' }]);
    assert.equal(v.holder.createdBy, 'garde');
    assert.deepEqual(calls, [['CTL-1']]);
    assert.equal(audits('access_visitor_created').length, 1);
    // Il n'apparait pas dans la liste du personnel.
    assert.equal(holders.list({}, 'admin').items.length, 0);
    assert.equal(holders.list({ kind: 'visitor' }, 'admin').items.length, 1);
    assert.equal(holders.list({ kind: 'all' }, 'admin').items.length, 1);
  });

  it('le reste du temps s\'ecoule : remainingMs diminue, jamais negatif', () => {
    const v = holders.createVisitor('garde', visitor());
    clock += 45 * MIN;
    assert.equal(holders.visitors()[0].remainingMs, 15 * MIN);
    clock += 30 * MIN;
    assert.deepEqual(holders.visitors(), [], 'echu : plus "en cours"');
    const recent = holders.visitors('recent');
    assert.equal(recent.length, 1);
    assert.equal(recent[0].remainingMs, 0);
    assert.equal(recent[0].state, 'ended');
    assert.equal(recent[0].holder.id, v.holder.id);
  });

  it('refuse un groupe qui n\'est pas reserve aux visiteurs, un groupe inconnu ou invalide', () => {
    const staff = mkGroup('Personnel', [['A-01']]);
    refuses(() => holders.createVisitor('garde', visitor({ groupId: staff })), 400, /réservé aux visiteurs/);
    refuses(() => holders.createVisitor('garde', visitor({ groupId: 9999 })), 400, /n’existe pas/);
    for (const bad of ['1', 0, -1, 1.5, null, undefined, [vg]]) refuses(() => holders.createVisitor('garde', visitor({ groupId: bad })), 400, /groupe/i, String(bad));
    assert.equal(rowCount('access_holder'), 0);
  });

  it('duree : de 15 a 44 640 minutes, entiere', () => {
    for (const bad of [14, 0, -15, 44_641, 15.5, '60', null, undefined, NaN, Infinity, [60]]) {
      refuses(() => holders.createVisitor('garde', visitor({ durationMinutes: bad, badge: `X${String(bad).length}` })), 400, /durée/, String(bad));
    }
    assert.equal(holders.createVisitor('garde', visitor({ durationMinutes: 15, badge: 'A1' })).remainingMs, 15 * MIN);
    assert.equal(holders.createVisitor('garde', visitor({ durationMinutes: 44_640, badge: 'A2' })).remainingMs, 44_640 * MIN);
  });

  it('badge deja porte (non rendu) = 409 ; champs obligatoires et textes hostiles = 400 ; rien n\'est cree a moitie', () => {
    holders.createVisitor('garde', visitor());
    refuses(() => holders.createVisitor('garde', visitor({ lastName: 'Autre' })), 409, /badge/);
    mkStaff('Staff', '', { badges: ['S1'] });
    refuses(() => holders.createVisitor('garde', visitor({ badge: 'S1' })), 409, /badge/);
    const n = rowCount('access_holder');
    const bad: [string, Record<string, unknown>][] = [
      ['nom absent', { lastName: undefined }], ['nom =', { lastName: '=1' }], ['nom <', { lastName: '<b>' }], ['nom tableau', { lastName: ['a'] }],
      ['prenom bidi', { firstName: `a${BIDI}` }], ['accompagnateur absent', { host: undefined }], ['accompagnateur vide', { host: '  ' }],
      ['accompagnateur long', { host: 'h'.repeat(65) }], ['accompagnateur @', { host: '@x' }], ['motif long', { reason: 'r'.repeat(121) }], ['motif <', { reason: 'a<b' }],
      ['motif nombre', { reason: 5 }], ['badge absent', { badge: undefined }], ['badge espace', { badge: 'a b' }], ['badge nombre', { badge: 5 }], ['badge long', { badge: 'x'.repeat(33) }],
    ];
    for (const [label, over] of bad) refuses(() => holders.createVisitor('garde', visitor({ badge: 'NEUF', ...over })), 400, undefined, label);
    refuses(() => holders.createVisitor('garde', null as never), 400, /objet/);
    assert.equal(rowCount('access_holder'), n);
    assert.equal(holders.createVisitor('garde', visitor({ badge: 'OK1', reason: undefined, firstName: undefined })).reason, '');
    assert.equal(holders.createVisitor('garde', visitor({ badge: 'OK2', host: 'h'.repeat(64), reason: 'r'.repeat(120) })).host.length, 64);
  });

  it('fin automatique : l\'horloge avance, tick() termine la visite, rend le badge et previent le controleur', () => {
    const v = holders.createVisitor('garde', visitor());
    calls.length = 0;
    clock += 59 * MIN;
    holders.tick();
    assert.equal(holders.visitors()[0].state, 'present');
    clock += 2 * MIN;
    holders.tick();
    const after = holders.get(v.holder.id);
    assert.equal(after.visitor?.endedAt, T + 60 * MIN, 'fin effective = echeance');
    assert.equal(after.phase, 'expired');
    assert.deepEqual(after.badges.map((b) => b.state), ['returned']);
    assert.equal(after.badges[0].stateBy, 'systeme');
    assert.deepEqual(calls, [['CTL-1']]);
    const [entry] = audits('access_visitor_ended');
    assert.equal(entry.actor, 'systeme');
    assert.equal(entry.details, `H${v.holder.id} : visite échue, badge rendu`);
    assert.deepEqual(holders.desired('CTL-1').holders, []);
    // Le badge rendu peut etre redonne.
    const second = holders.createVisitor('garde', visitor({ lastName: 'Bernard' }));
    assert.deepEqual(second.holder.badges.map((b) => b.number), ['V001']);
    assert.equal(holders.findByBadge('V001')?.id, second.holder.id);
  });

  it('tick : plusieurs visites echues sont terminees d\'un coup, une seule notification', () => {
    holders.createVisitor('garde', visitor({ durationMinutes: 15, badge: 'A1' }));
    holders.createVisitor('garde', visitor({ durationMinutes: 15, badge: 'A2' }));
    calls.length = 0;
    clock += 15 * MIN + 1 * S;
    holders.tick();
    assert.equal(holders.visitors().length, 0);
    assert.equal(audits('access_visitor_ended').length, 2);
    assert.deepEqual(calls, [['CTL-1']]);
  });

  it('tick : au plus toutes les 5 secondes (horloge injectee) ; une horloge qui recule relance le controle', () => {
    holders.tick(); // dernier controle = T
    const last = clock;
    const c = holders.createVisitor('garde', visitor({ durationMinutes: 15, badge: 'A1' }));
    holders.update('admin', c.holder.id, { validTo: last + 2 * S });
    clock = last + 3 * S; // echu, mais moins de 5 s apres le dernier controle
    holders.tick();
    assert.equal(holders.get(c.holder.id).visitor?.endedAt, null, 'ignore par le garde-fou');
    clock = last + 5 * S - 1;
    holders.tick();
    assert.equal(holders.get(c.holder.id).visitor?.endedAt, null);
    clock = last + 5 * S;
    holders.tick();
    assert.equal(holders.get(c.holder.id).visitor?.endedAt, last + 2 * S);
    // L'horloge recule : le controle repart.
    const control = clock;
    clock = control - 10 * S;
    const d = holders.createVisitor('garde', visitor({ durationMinutes: 15, badge: 'A2' }));
    holders.update('admin', d.holder.id, { validTo: control - 8 * S });
    clock = control - 7 * S;
    holders.tick();
    assert.notEqual(holders.get(d.holder.id).visitor?.endedAt, null);
  });

  it('purge : les visiteurs termines depuis plus de la duree de conservation sont supprimes, pas avant', () => {
    const v = holders.createVisitor('garde', visitor({ durationMinutes: 15 }));
    clock += 16 * MIN;
    holders.tick();
    assert.notEqual(holders.get(v.holder.id).visitor?.endedAt, null);
    const live = holders.createVisitor('garde', visitor({ badge: 'V2', durationMinutes: 44_640 }));
    clock += 89 * DAY;
    holders.tick();
    assert.equal(holders.get(v.holder.id).id, v.holder.id, '89 jours : encore la');
    clock += 2 * DAY;
    holders.tick();
    refuses(() => holders.get(v.holder.id), 404, /Titulaire introuvable/);
    assert.equal(rowCount('access_badge'), 1, 'ses badges sont partis avec lui (reste celui du visiteur en cours)');
    assert.equal(holders.get(live.holder.id).id, live.holder.id);
    const purge = audits('access_holder_deleted').find((e) => e.actor === 'systeme');
    assert.match(String(purge?.details), /purge : 1 fiche/);
    assert.ok(!String(purge?.details).includes('Martin'));
  });

  it('purge : la duree de conservation est lue a chaque fois (reglable) ; les valeurs absurdes retombent sur 90 jours', () => {
    const v = holders.createVisitor('garde', visitor({ durationMinutes: 15 }));
    clock += 16 * MIN;
    holders.tick();
    retention = 7;
    clock += 8 * DAY;
    holders.tick();
    refuses(() => holders.get(v.holder.id), 404);
    const w = holders.createVisitor('garde', visitor({ badge: 'V3', durationMinutes: 15 }));
    clock += 16 * MIN;
    holders.tick();
    for (const absurd of [0, -5, NaN, Infinity]) {
      retention = absurd;
      clock += 10 * S;
      holders.tick();
    }
    assert.equal(holders.get(w.holder.id).id, w.holder.id);
  });

  it('tick ne leve jamais, meme si la base ne repond plus', () => {
    const broken = openDb(':memory:');
    const h = createHolders({ db: broken, now: () => clock, audit: () => {} });
    const quiet = mock.method(console, 'error', () => {});
    try {
      broken.close();
      assert.doesNotThrow(() => h.tick());
      clock += 10 * S;
      assert.doesNotThrow(() => h.tick());
      assert.ok(quiet.mock.callCount() >= 1);
    } finally {
      quiet.mock.restore();
    }
  });

  it('fin manuelle : badge rendu, retrait des controleurs, notification ; deuxieme fin = 409 ; un titulaire du personnel = 404', () => {
    const v = holders.createVisitor('garde', visitor());
    clock += 10 * MIN;
    calls.length = 0;
    const ended = holders.endVisitor('garde2', v.holder.id);
    assert.equal(ended.state, 'ended');
    assert.equal(ended.remainingMs, 0);
    assert.equal(ended.holder.visitor?.endedAt, T + 10 * MIN);
    assert.deepEqual(ended.holder.badges.map((b) => [b.state, b.stateBy]), [['returned', 'garde2']]);
    assert.deepEqual(calls, [['CTL-1']]);
    assert.deepEqual(holders.desired('CTL-1').holders, []);
    assert.equal(audits('access_visitor_ended')[0].actor, 'garde2');
    refuses(() => holders.endVisitor('garde', v.holder.id), 409, /déjà terminée/);
    refuses(() => holders.endVisitor('garde', mkStaff('Staff')), 404, /Visiteur introuvable/);
    refuses(() => holders.endVisitor('garde', 9999), 404, /Titulaire introuvable/);
    refuses(() => holders.endVisitor('garde', 0), 404);
    // Plus de badge pour une visite terminee.
    refuses(() => holders.addBadge('admin', v.holder.id, 'NEUF'), 409, /visite/);
    refuses(() => holders.setBadgeState('admin', v.holder.badges[0].id, 'active'), 409, /visite/);
  });

  it('visites en cours / a venir / terminees depuis moins de 24 h', () => {
    const a = holders.createVisitor('garde', visitor({ badge: 'A1', durationMinutes: 15 }));
    const b = holders.createVisitor('garde', visitor({ badge: 'A2', durationMinutes: 300 }));
    const c = holders.createVisitor('garde', visitor({ badge: 'A3', durationMinutes: 300 }));
    holders.endVisitor('garde', c.holder.id);
    // Un visiteur "a venir" : debut repousse apres sa creation.
    holders.update('admin', b.holder.id, { validFrom: T + HOUR });
    assert.deepEqual(holders.visitors().map((v) => [v.holder.id, v.state]), [[a.holder.id, 'present'], [b.holder.id, 'upcoming']]);
    assert.equal(holders.visitors('recent').length, 3);
    clock += 30 * HOUR;
    holders.tick();
    assert.equal(holders.visitors('recent').length, 0, 'tout est termine depuis plus de 24 h');
    for (const bad of ['tous', '', 1, null]) refuses(() => holders.visitors(bad as never), 400, /portée/);
  });

  it('modifier un visiteur : toujours un visiteur, fin obligatoire', () => {
    const v = holders.createVisitor('garde', visitor());
    refuses(() => holders.update('admin', v.holder.id, { kind: 'staff' } as never), 409, /visiteur/);
    refuses(() => holders.update('admin', v.holder.id, { validTo: null }), 400, /fin de visite est obligatoire/);
    assert.equal(holders.update('admin', v.holder.id, { validTo: T + 5 * HOUR }).kind, 'visitor');
    assert.equal(holders.visitors()[0].endsAt, T + 5 * HOUR);
    holders.remove('admin', v.holder.id);
    assert.equal(holders.visitors('recent').length, 0);
  });

  it('dernier passage du visiteur : retrouve par son numero de badge puis par son identifiant', () => {
    const v = holders.createVisitor('garde', visitor());
    send('A-01', passage({ credential: 'V001' }));
    clock += 10 * S;
    send('A-01', passage({ credential: 'V001', result: 'denied', reason: 'out_of_schedule' }, { event: 'badge_denied' }));
    const last = holders.visitors()[0].lastPassage;
    assert.ok(last);
    assert.equal(last.credential, 'V001');
    assert.equal(last.result, 'denied');
    assert.equal(last.resultLabel, 'Refusé — hors des horaires');
    assert.equal(last.doorId, 'A-01');
    assert.equal(last.atDevice, clock - 5 * S);
    // Passage par empreinte, rattache par `holderRef` : retrouve par `holder_id`.
    clock += 10 * S;
    send('A-01', passage({ credential: null, method: 'fingerprint', holderRef: v.holder.ref }));
    assert.equal(holders.visitors()[0].lastPassage?.method, 'fingerprint');
    // Une carte redonnee a un autre visiteur n'herite pas des passages du precedent.
    holders.endVisitor('garde', v.holder.id);
    const second = holders.createVisitor('garde', visitor({ lastName: 'Bernard' }));
    assert.equal(holders.visitors().find((x) => x.holder.id === second.holder.id)?.lastPassage, null);
  });

  it('un visiteur peut etre supprime', () => {
    const v = holders.createVisitor('garde', visitor());
    holders.remove('admin', v.holder.id);
    assert.equal(rowCount('access_holder'), 0);
    assert.deepEqual(holders.desired('CTL-1').holders, []);
  });
});

describe('resolve : rattachement des passages', () => {
  beforeEach(setup);

  it('par H<id> d\'abord, sinon par badge non rendu, sinon null', () => {
    const a = mkStaff('Konan', 'Yao', { badges: ['111'] });
    const b = mkStaff('Diallo', 'Awa', { badges: ['222'] });
    assert.deepEqual(holders.resolve(null, `H${a}`), { id: a, name: 'Konan Yao' });
    assert.deepEqual(holders.resolve('222', `H${a}`), { id: a, name: 'Konan Yao' }, 'la reference prime sur le badge');
    assert.deepEqual(holders.resolve('222', null), { id: b, name: 'Diallo Awa' });
    assert.deepEqual(holders.resolve('222', 'H99999'), { id: b, name: 'Diallo Awa' }, 'reference inconnue : on tente le badge');
    assert.deepEqual(holders.resolve('222', '101'), { id: b, name: 'Diallo Awa' }, 'reference du controleur (pas H<id>) : badge');
    assert.equal(holders.resolve('999', null), null);
    assert.equal(holders.resolve(null, null), null);
    assert.equal(holders.resolve('', ''), null);
  });

  it('badge rendu : plus rattache ; titulaire supprime : null ; references hostiles : null, sans erreur', () => {
    const a = mkStaff('Konan', '', { badges: ['111'] });
    holders.setBadgeState('admin', holders.get(a).badges[0].id, 'returned');
    assert.equal(holders.resolve('111', null), null);
    assert.equal(holders.resolve(null, `H${a}`)?.id, a);
    holders.remove('admin', a);
    assert.equal(holders.resolve('111', `H${a}`), null);
    for (const ref of ['H0', 'h1', 'H01', 'H-1', 'H1; DROP TABLE access_holder', 'H' + '9'.repeat(40), ' H1', 'H1 ', 'H1.5', '__proto__', 5 as never, {} as never]) {
      assert.equal(holders.resolve(null, ref), null, String(ref));
    }
    assert.equal(holders.resolve('x'.repeat(33), null), null);
    assert.equal(holders.resolve(5 as never, null), null);
    assert.equal(rowCount('access_holder'), 0);
  });

  it('nom tronque a 64 caracteres', () => {
    const a = mkStaff('A'.repeat(40), 'b'.repeat(22), { badges: ['111'] });
    assert.equal(holders.resolve('111', null)?.id, a);
    assert.ok((holders.resolve('111', null)?.name.length ?? 99) <= 64);
  });

  it('ne leve jamais, meme base fermee', () => {
    const broken = openDb(':memory:');
    const h = createHolders({ db: broken, audit: () => {} });
    broken.close();
    assert.equal(h.resolve('1', 'H1'), null);
  });
});

describe('rattachement par access.ts (resolveHolder)', () => {
  beforeEach(setup);

  it('un passage recoit holder_id et, sans nom du controleur, le nom du PSIM ; la recherche du journal en profite', () => {
    const g = mkGroup('G', [['A-01']]);
    const id = mkStaff('Konan', 'Yao', { badges: ['0012345'], groupIds: [g] });
    assert.deepEqual(send('A-01', passage({ credential: '0012345', holderName: null, holderRef: null })), { ok: true });
    const [e] = events();
    assert.equal(e.holder_id, id);
    assert.equal(e.holder_name, 'Konan Yao');
    assert.equal(e.holder_key, 'konan yao');
    assert.equal(access.search({ holder: 'konan' }, 'admin').items.length, 1);
    assert.equal(access.search({}, 'admin').items[0].holderId, id);
  });

  it('le nom donne par le controleur est garde ; holder_id est quand meme pose (par H<id> ou par badge)', () => {
    const id = mkStaff('Konan', 'Yao', { badges: ['0012345'] });
    send('A-01', passage({ credential: 'inconnu-du-psim', holderName: 'NOM DU CONTROLEUR', holderRef: `H${id}` }));
    send('A-01', passage({ credential: '0012345', holderName: 'AUTRE NOM', holderRef: '101' }));
    const rows = events();
    assert.deepEqual(rows.map((r) => [r.holder_id, r.holder_name]), [[id, 'NOM DU CONTROLEUR'], [id, 'AUTRE NOM']]);
  });

  it('badge inconnu du PSIM : holder_id nul, passage garde tel quel', () => {
    send('A-01', passage({ credential: '777', holderName: 'Quelqu\'un', holderRef: '5' }));
    const [e] = events();
    assert.equal(e.holder_id, null);
    assert.equal(e.holder_name, 'Quelqu\'un');
  });

  it('badge desactive : le passage refuse est quand meme rattache au titulaire', () => {
    const id = mkStaff('Konan', 'Yao', { badges: ['0012345'] });
    holders.setBadgeState('admin', holders.get(id).badges[0].id, 'disabled');
    send('A-01', passage({ credential: '0012345', result: 'denied', reason: 'unknown_credential' }, { event: 'badge_denied' }));
    assert.equal(events()[0].holder_id, id);
    assert.equal(events()[0].holder_name, 'Konan Yao');
  });

  it('fiche : dix derniers passages au plus, du plus recent au plus ancien, avec le nom de la porte', () => {
    const id = mkStaff('Konan', 'Yao', { badges: ['0012345'] });
    for (let i = 0; i < 13; i++) {
      clock += 7 * S;
      send(i % 2 === 0 ? 'A-01' : 'A-02', passage({ credential: '0012345' }));
    }
    const detail = holders.get(id);
    assert.equal(detail.recentPassages.length, 10);
    const times = detail.recentPassages.map((p) => p.atDevice);
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
    assert.equal(times[0], clock - 5 * S);
    assert.equal(detail.recentPassages[0].doorId, 'A-01');
    assert.equal(detail.recentPassages[0].doorName, engine.getSnapshot().devices.find((d) => d.id === 'A-01')?.name);
    assert.equal(detail.recentPassages[1].doorId, 'A-02');
    assert.equal(detail.recentPassages[1].doorName, 'Porte A-02');
    assert.equal(detail.recentPassages[0].resultLabel, 'Accepté');
    assert.deepEqual(Object.keys(detail.recentPassages[0]).sort(), ['atDevice', 'credential', 'doorId', 'doorName', 'id', 'method', 'reason', 'result', 'resultLabel']);
  });

  it('passages anterieurs a la fiche : retrouves par le numero du badge tant qu\'ils n\'ont pas de titulaire', () => {
    send('A-01', passage({ credential: '0012345' }));
    const id = mkStaff('Konan', 'Yao', { badges: ['0012345'] });
    assert.equal(events()[0].holder_id, null);
    assert.equal(holders.get(id).recentPassages.length, 1);
  });
});

describe('photo', () => {
  beforeEach(setup);

  it('JPEG, PNG et WebP acceptes, relus a l\'identique ; hasPhoto dans les vues ; remplacee, effacee', () => {
    const id = mkStaff('Konan');
    assert.equal(holders.photo(id), null);
    for (const [mime, data] of [['image/jpeg', JPEG()], ['image/png', PNG()], ['image/webp', WEBP()]] as const) {
      holders.setPhoto('admin', id, mime, data);
      const p = holders.photo(id)!;
      assert.equal(p.mime, mime);
      assert.ok(Buffer.isBuffer(p.data));
      assert.deepEqual(p.data, data);
      assert.equal(holders.get(id).hasPhoto, true);
      assert.equal(holders.list({}, 'admin').items[0].hasPhoto, true);
    }
    assert.equal(rowCount('access_holder_photo'), 1, 'une seule photo par titulaire');
    holders.clearPhoto('admin', id);
    assert.equal(holders.photo(id), null);
    assert.equal(holders.get(id).hasPhoto, false);
    refuses(() => holders.clearPhoto('admin', id), 404, /pas de photo/);
  });

  it('la signature du fichier est verifiee en plus du type annonce', () => {
    const id = mkStaff('Konan');
    refuses(() => holders.setPhoto('admin', id, 'image/jpeg', PNG()), 400, /ne correspond pas/);
    refuses(() => holders.setPhoto('admin', id, 'image/png', JPEG()), 400, /ne correspond pas/);
    refuses(() => holders.setPhoto('admin', id, 'image/webp', JPEG()), 400, /ne correspond pas/);
    refuses(() => holders.setPhoto('admin', id, 'image/jpeg', Buffer.from('<?xml version="1.0"?><svg onload="alert(1)"/>')), 400, /pas une image/);
    refuses(() => holders.setPhoto('admin', id, 'image/jpeg', Buffer.from('<script>alert(1)</script>')), 400, /pas une image/);
    refuses(() => holders.setPhoto('admin', id, 'image/jpeg', Buffer.from('GIF89a......')), 400, /pas une image/);
    refuses(() => holders.setPhoto('admin', id, 'image/jpeg', Buffer.from([0xff, 0xd8])), 400, /pas une image/);
    refuses(() => holders.setPhoto('admin', id, 'image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(20)])), 400, /pas une image/);
    assert.equal(holders.photo(id), null);
  });

  it('type SVG, GIF, vide ou deguise refuse ; 64 Ko au plus', () => {
    const id = mkStaff('Konan');
    for (const mime of ['image/svg+xml', 'image/gif', 'text/html', 'image/jpeg; charset=x', 'IMAGE/JPEG', 'image/jpg', '', ' image/jpeg', 5, null, undefined, ['image/jpeg']]) {
      refuses(() => holders.setPhoto('admin', id, mime as never, JPEG()), 400, /JPEG, PNG ou WebP/, String(mime));
    }
    refuses(() => holders.setPhoto('admin', id, 'image/jpeg', noPhoto()), 400, /vide/);
    for (const data of ['texte', null, undefined, [0xff, 0xd8, 0xff], { length: 5 }]) refuses(() => holders.setPhoto('admin', id, 'image/jpeg', data as never), 400, /vide/);
    refuses(() => holders.setPhoto('admin', id, 'image/jpeg', JPEG(64 * 1024)), 400, /trop lourde/);
    holders.setPhoto('admin', id, 'image/jpeg', JPEG(64 * 1024 - 4));
    assert.equal(holders.photo(id)?.data.length, 64 * 1024);
    assert.equal(rowCount('access_holder_photo'), 1);
  });

  it('titulaire inconnu : 404 ; la photo ne part jamais dans le journal, ni dans les vues, ni vers les controleurs', () => {
    refuses(() => holders.setPhoto('admin', 9999, 'image/jpeg', JPEG()), 404, /Titulaire introuvable/);
    const g = mkGroup('G', [['A-01']]);
    const id = mkStaff('Konan', '', { groupIds: [g], badges: ['1'] });
    holders.setPhoto('admin', id, 'image/png', PNG(100));
    const dump = JSON.stringify([holders.get(id), holders.list({}, 'admin'), holders.desired('CTL-1'), db.prepare('SELECT * FROM audit_log').all()]);
    assert.ok(!dump.includes('base64'));
    assert.ok(!/PNG|\\u0089/.test(dump));
    const [entry] = audits('access_holder_photo_set');
    assert.equal(entry.details, `H${id} : photo enregistrée (image/png, ${8 + 100} octets)`);
    // Ce que le service renvoie ne contient pas la photo : seulement l'indicateur.
    assert.equal(Object.hasOwn(holders.get(id), 'photo'), false);
  });

  it('une copie : modifier le tampon d\'origine ne change pas la photo stockee', () => {
    const id = mkStaff('Konan');
    const data = JPEG();
    holders.setPhoto('admin', id, 'image/jpeg', data);
    data.fill(0);
    assert.deepEqual(holders.photo(id)?.data, JPEG());
    const out = holders.photo(id)!;
    out.data.fill(1);
    assert.deepEqual(holders.photo(id)?.data, JPEG());
  });
});

describe('liste et recherche', () => {
  beforeEach(setup);

  it('recherche sans accents ni casse : nom, prenom, « prenom nom », matricule, debut de numero de badge', () => {
    const a = mkStaff('Noël', 'Éloïse', { externalRef: 'MAT-042', badges: ['0012345'] });
    const b = mkStaff('Konan', 'Yao', { externalRef: 'MAT-043', badges: ['0099999'] });
    const q = (text: string) => holders.list({ q: text }, 'admin').items.map((h) => h.id);
    assert.deepEqual(q('noel'), [a]);
    assert.deepEqual(q('NOËL'), [a]);
    assert.deepEqual(q('eloise'), [a]);
    assert.deepEqual(q('eloise noel'), [a]);
    assert.deepEqual(q('noel eloise'), [a]);
    assert.deepEqual(q('  éloïse   noël '), [a]);
    assert.deepEqual(q('mat-04'), [a, b]);
    assert.deepEqual(q('mat-043'), [b]);
    assert.deepEqual(q('00123'), [a]);
    assert.deepEqual(q('12345'), [], 'le numero se cherche par son debut');
    assert.deepEqual(q('yao konan'), [b]);
    assert.deepEqual(q('kon'), [b]);
    assert.deepEqual(q('zzz'), []);
    assert.deepEqual(q(''), [a, b]);
    // Caracteres speciaux de LIKE pris pour eux-memes.
    assert.deepEqual(q('%'), []);
    assert.deepEqual(q('_'), []);
    assert.deepEqual(q("a' OR '1'='1"), []);
    assert.deepEqual(q('\\'), []);
  });

  it('un badge rendu ne se retrouve plus par son numero', () => {
    const a = mkStaff('A', '', { badges: ['0555'] });
    holders.setBadgeState('admin', holders.get(a).badges[0].id, 'returned');
    assert.deepEqual(holders.list({ q: '0555' }, 'admin').items, []);
    assert.deepEqual(holders.list({ q: 'a' }, 'admin').items.map((h) => h.id), [a]);
  });

  it('filtres : type (personnel par defaut), statut, groupe ; valeurs invalides = 400', () => {
    const g = mkGroup('Visiteurs', [['A-01']], { forVisitors: true });
    const staff = mkStaff('Staff');
    const susp = mkStaff('Suspendu', '', { status: 'suspended' });
    const vis = holders.createVisitor('garde', { lastName: 'Vis', host: 'x', badge: 'V1', groupId: g, durationMinutes: 30 });
    const ids = (f: Record<string, unknown>) => holders.list(f, 'admin').items.map((h) => h.id);
    assert.deepEqual(ids({}), [staff, susp]);
    assert.deepEqual(ids({ kind: 'staff' }), [staff, susp]);
    assert.deepEqual(ids({ kind: 'visitor' }), [vis.holder.id]);
    assert.deepEqual(ids({ kind: 'all' }), [staff, susp, vis.holder.id]);
    assert.deepEqual(ids({ status: 'suspended' }), [susp]);
    assert.deepEqual(ids({ status: 'active', kind: 'all' }), [staff, vis.holder.id]);
    assert.deepEqual(ids({ groupId: g, kind: 'all' }), [vis.holder.id]);
    assert.deepEqual(ids({ kind: '', status: '', groupId: '', q: '' }), [staff, susp]);
    for (const bad of [{ kind: 'x' }, { kind: 5 }, { status: 'x' }, { status: ['active'] }, { groupId: 'x' }, { groupId: -1 }, { groupId: 1.5 }, { groupId: ['1'] }, { groupId: '1; DROP' }, { limit: 0 }, { limit: 101 }, { limit: 'x' }, { limit: 1.5 }, { limit: -1 },
      { q: ['a'] }, { q: 5 }, { q: {} }, { q: 'x'.repeat(65) }, { q: 'x'.repeat(100_000) }, { q: 'a\tb' }, { q: `a${BIDI}` }, { q: 'a b c d e f g' }, { cursor: 'abc!' }, { cursor: 5 }, { cursor: 'AAAA' }, { cursor: 'x'.repeat(65) }]) {
      refuses(() => holders.list(bad as never, 'admin'), 400, undefined, JSON.stringify(bad).slice(0, 40));
    }
    refuses(() => holders.list(null as never, 'admin'), 400, /objet/);
    // Le filtre ne lit que ses propres proprietes.
    assert.deepEqual(holders.list(JSON.parse('{"__proto__":{"kind":"all"}}'), 'admin').items.length, 2);
  });

  it('pagination par curseur opaque : parcours complet sans doublon ni oubli, nextCursor nul a la fin', () => {
    const made = Array.from({ length: 7 }, (_, i) => mkStaff(`Nom${i}`));
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = holders.list({ limit: 3, ...(cursor ? { cursor } : {}) }, 'admin');
      assert.equal(page.total, 7);
      seen.push(...page.items.map((h) => h.id));
      assert.ok(page.items.length <= 3);
      cursor = page.nextCursor;
      pages++;
      if (cursor) assert.doesNotMatch(cursor, /\d{2}/, 'curseur opaque');
    } while (cursor && pages < 10);
    assert.deepEqual(seen, made);
    assert.equal(pages, 3);
    // Exactement une page pleine : pas de curseur superflu.
    const exact = holders.list({ limit: 7 }, 'admin');
    assert.equal(exact.items.length, 7);
    assert.equal(exact.nextCursor, null);
    assert.equal(holders.list({ limit: '2' }, 'admin').items.length, 2);
    assert.equal(holders.list({}, 'admin').items.length, 7);
  });

  it('total plafonne a 10 000', () => {
    const insert = db.prepare("INSERT INTO access_holder (last_name, first_name, name_key, created_at, created_by, updated_at, updated_by) VALUES ('X', '', 'x', 0, 'test', 0, 'test')");
    db.exec('BEGIN');
    for (let i = 0; i < 10_050; i++) insert.run();
    db.exec('COMMIT');
    const page = holders.list({ limit: 1 }, 'admin');
    assert.equal(page.total, 10_000);
    assert.equal(page.items.length, 1);
  });

  it('au plus 20 000 titulaires', () => {
    const insert = db.prepare("INSERT INTO access_holder (last_name, first_name, name_key, created_at, created_by, updated_at, updated_by) VALUES ('X', '', 'x', 0, 'test', 0, 'test')");
    db.exec('BEGIN');
    for (let i = 0; i < MAX_HOLDERS; i++) insert.run();
    db.exec('COMMIT');
    refuses(() => holders.create('admin', { lastName: 'De trop' }), 409, /maximal/);
    const g = mkGroup('V', [['A-01']], { forVisitors: true });
    refuses(() => holders.createVisitor('garde', { lastName: 'V', host: 'x', badge: 'V1', groupId: g, durationMinutes: 30 }), 409, /maximal/);
  });

  it('une recherche avec texte est journalisee (acteur, texte), au plus une fois par minute pour le meme acteur et le meme texte ; pas la page 2', () => {
    mkStaff('Konan');
    const searches = () => audits('access_holder_search');
    holders.list({ q: 'konan' }, 'alice');
    holders.list({ q: 'KONAN' }, 'alice');
    holders.list({ q: ' Konan ' }, 'alice');
    assert.equal(searches().length, 1);
    assert.equal(searches()[0].actor, 'alice');
    assert.match(String(searches()[0].details), /konan/i);
    holders.list({ q: 'konan' }, 'bob');
    assert.equal(searches().length, 2);
    holders.list({ q: 'autre' }, 'alice');
    assert.equal(searches().length, 3);
    clock += 59 * S;
    holders.list({ q: 'konan' }, 'alice');
    assert.equal(searches().length, 3);
    clock += 2 * S;
    holders.list({ q: 'konan' }, 'alice');
    assert.equal(searches().length, 4);
    // Sans texte, ou page suivante : rien.
    holders.list({}, 'alice');
    holders.list({ q: '' }, 'alice');
    mkStaff('Konan2');
    const cursor = holders.list({ q: 'konan', limit: 1 }, 'carol').nextCursor;
    assert.equal(searches().length, 5);
    holders.list({ q: 'konan', limit: 1, cursor: cursor! }, 'carol');
    assert.equal(searches().length, 5);
    // Une recherche refusee n'est pas journalisee.
    refuses(() => holders.list({ q: 'x'.repeat(65) }, 'dave'), 400);
    assert.equal(searches().length, 5);
    assert.ok(String(searches()[0].details).length <= 120);
  });
});

describe('journal infalsifiable : des identifiants, jamais de nom ni de numero de badge', () => {
  beforeEach(setup);

  it('aucune entree ne contient un nom, un prenom, un matricule, une description, un numero de badge ni un octet de photo', () => {
    const w = holders.createSchedule('admin', { name: 'HorairSecret', windows: [{ days: [1], from: '08:00', to: '09:00' }] }).id;
    const g = holders.createGroup('admin', { name: 'GroupeSecret', description: 'DescriptionSecrete', forVisitors: true, doors: [{ doorId: 'A-01', scheduleId: w }] }).id;
    const id = holders.create('admin', { lastName: 'Zorglub', firstName: 'Quentin', externalRef: 'MATRICULE-SECRET', badges: ['BADGESECRET1'], groupIds: [g] }).id;
    holders.update('admin', id, { lastName: 'Zorglubb', firstName: 'Quentine', externalRef: 'MATRICULE-SECRET-2', status: 'suspended' });
    const badge = holders.addBadge('admin', id, 'BADGESECRET2');
    holders.setBadgeState('admin', badge.id, 'lost');
    holders.setBadgeState('admin', badge.id, 'returned');
    holders.removeBadge('admin', badge.id);
    holders.setPhoto('admin', id, 'image/jpeg', Buffer.concat([JPEG(0), Buffer.from('PHOTOSECRETE')]));
    holders.clearPhoto('admin', id);
    holders.setHolidays('admin', [{ date: '2026-12-25', label: 'FerieSecret' }]);
    holders.updateGroup('admin', g, { name: 'GroupeSecret2', description: 'DescriptionSecrete2' });
    holders.updateSchedule('admin', w, { name: 'HorairSecret2' });
    const v = holders.createVisitor('garde', { lastName: 'VisiteurSecret', firstName: 'Zoe', host: 'AccompagnateurSecret', reason: 'MotifSecret', badge: 'VISITSECRET', groupId: g, durationMinutes: 15 });
    holders.endVisitor('garde', v.holder.id);
    holders.createVisitor('garde', { lastName: 'VisiteurSecret2', host: 'AccompagnateurSecret', reason: 'MotifSecret', badge: 'VISITSECRET', groupId: g, durationMinutes: 15 });
    clock += 20 * MIN;
    holders.tick();
    clock += 91 * DAY;
    holders.tick();
    holders.remove('admin', id);
    const dump = JSON.stringify(db.prepare('SELECT * FROM audit_log').all()).toLowerCase();
    for (const secret of ['zorglub', 'quentin', 'matricule-secret', 'badgesecret', 'groupesecret', 'descriptionsecrete', 'horairsecret', 'photosecrete', 'feriesecret', 'visiteursecret', 'accompagnateursecret', 'motifsecret', 'visitsecret', 'zoe']) {
      assert.ok(!dump.includes(secret), `le journal contient « ${secret} »`);
    }
    // Les identifiants, eux, y sont.
    assert.match(String(audits('access_holder_created')[0].details), /^H\d+ :/);
    assert.match(String(audits('access_badge_state_changed')[0].details), /^B\d+ \(H\d+\) : active -> lost$/);
    assert.match(String(audits('access_group_created')[0].details), /^G\d+/);
    assert.match(String(audits('access_schedule_created')[0].details), /^S\d+/);
    const actions = new Set((db.prepare('SELECT action FROM audit_log').all() as { action: string }[]).map((r) => r.action));
    for (const a of ['access_holder_created', 'access_holder_updated', 'access_holder_deleted', 'access_holder_photo_set', 'access_holder_photo_cleared', 'access_badge_added',
      'access_badge_state_changed', 'access_badge_removed', 'access_group_created', 'access_group_updated', 'access_schedule_created', 'access_schedule_updated', 'access_holidays_replaced',
      'access_visitor_created', 'access_visitor_ended']) assert.ok(actions.has(a), a);
  });

  it('suppression de groupe et de plage journalisees par identifiant ; quiet supprime l\'entree par ligne', () => {
    const g = mkGroup('G', []);
    const s = workdays('H');
    holders.deleteGroup('admin', g);
    holders.deleteSchedule('admin', s);
    assert.equal(audits('access_group_deleted')[0].details, `G${g}`);
    assert.equal(audits('access_schedule_deleted')[0].details, `S${s}`);
    const n = auditCount();
    const a = holders.create('admin', { lastName: 'Quiet', badges: ['Q1'] }, { quiet: true });
    holders.update('admin', a.id, { lastName: 'Quiet2' }, { quiet: true });
    holders.addBadge('admin', a.id, 'Q2', { quiet: true });
    assert.equal(auditCount(), n, 'import : aucune entree par ligne');
    // Hors quiet, l'entree existe.
    holders.update('admin', a.id, { lastName: 'Quiet3' });
    assert.equal(auditCount(), n + 1);
  });

  it('les entrees du journal ecrites dans un batch qui echoue disparaissent avec lui', () => {
    const n = auditCount();
    assert.throws(() => holders.batch(() => {
      mkStaff('A');
      throw new Error('x');
    }));
    assert.equal(auditCount(), n);
  });
});

describe('suppression en cascade et integrite', () => {
  beforeEach(setup);

  it('supprimer un titulaire retire tout ce qui s\'y rattache, mais pas les groupes ni les plages', () => {
    const g = mkGroup('G', [['A-01']]);
    const id = mkStaff('Konan', '', { groupIds: [g], badges: ['1', '2'] });
    holders.setPhoto('admin', id, 'image/webp', WEBP());
    holders.remove('admin', id);
    assert.deepEqual(['access_holder', 'access_badge', 'access_holder_photo', 'access_holder_group'].map(rowCount), [0, 0, 0, 0]);
    assert.equal(holders.group(g).holderCount, 0);
    assert.equal(holders.group(g).doors.length, 1);
  });

  it('les index uniques tiennent meme sans les controles du service', () => {
    const a = mkStaff('A', '', { badges: ['1'], externalRef: 'M1' });
    assert.throws(() => db.prepare("INSERT INTO access_badge (holder_id, number, state, state_at, state_by, created_at) VALUES (?, '1', 'active', 0, 'x', 0)").run(a), /UNIQUE/);
    assert.throws(() => db.prepare("INSERT INTO access_badge (holder_id, number, state, state_at, state_by, created_at) VALUES (?, '1', 'lost', 0, 'x', 0)").run(a), /UNIQUE/);
    db.prepare("INSERT INTO access_badge (holder_id, number, state, state_at, state_by, created_at) VALUES (?, '1', 'returned', 0, 'x', 0)").run(a);
    assert.throws(() => db.prepare("INSERT INTO access_holder (last_name, name_key, external_ref, created_at, created_by, updated_at, updated_by) VALUES ('B', 'b', 'm1', 0, 'x', 0, 'x')").run(), /UNIQUE/);
  });

  it('un doublon decouvert pendant l\'ecriture (concurrence) devient un 409, pas une erreur interne', () => {
    // On simule : le service croit le numero libre, la base le refuse.
    const a = mkStaff('A');
    db.prepare("INSERT INTO access_badge (holder_id, number, state, state_at, state_by, created_at) VALUES (?, 'ZZ', 'active', 0, 'x', 0)").run(mkStaff('B'));
    refuses(() => holders.addBadge('admin', a, 'zz'), 409);
  });

  it('plusieurs instances sur la meme base cohabitent (migration rejouee, plage systeme unique)', () => {
    const other = createHolders({ db, audit: () => {} });
    assert.equal(other.schedules().filter((s) => s.builtin).length, 1);
    const id = other.create('admin', { lastName: 'Via autre instance', badges: ['9'] }).id;
    assert.equal(holders.get(id).badges[0].number, '9');
  });
});

/** Envoie un message d'equipement au moteur (le module d'acces enregistre le passage). */
function send(id: string, payload: unknown) {
  const res = engine.ingest(id, payload);
  return res;
}

describe('lecture des droits (HoldersReader)', () => {
  beforeEach(setup);

  /** Instant en heure LOCALE du serveur (mois 1-12). */
  const L = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime();
  const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
  const NOON = L(2026, 10, 19, 12, 0); // un lundi
  const night = (closed = false): number =>
    holders.createSchedule('admin', { name: `Nuit${closed ? ' ferie' : ''}`, windows: [{ days: ALL_DAYS, from: '22:00', to: '06:00' }], closedOnHolidays: closed }).id;
  const day = (closed = false): number =>
    holders.createSchedule('admin', { name: `Jour${closed ? ' ferie' : ''}`, windows: [{ days: ALL_DAYS, from: '08:00', to: '18:00' }], closedOnHolidays: closed }).id;
  /** Titulaire actif avec un badge, dans un groupe qui donne une porte avec l'horaire. */
  function worker(name: string, scheduleId: number, door = 'A-01', extra: HolderInput = {}): { id: number; groupId: number } {
    const groupId = mkGroup(`G ${name}`, [[door, scheduleId]]);
    const id = mkStaff(name, '', { badges: [`B${name}`], groupIds: [groupId], ...extra });
    return { id, groupId };
  }

  it('chaque raison de canPass, dans l\'ordre', () => {
    clock = NOON;
    const w = worker('OK', always());
    assert.deepEqual(holders.canPass(w.id, 'A-01'), { allowed: true, reason: 'ok', groupId: w.groupId, scheduleId: always() });
    assert.equal(holders.canPass(99999, 'A-01').reason, 'unknown_holder');
    const sus = worker('Sus', always(), 'A-01', { status: 'suspended' });
    assert.equal(holders.canPass(sus.id, 'A-01').reason, 'suspended');
    const fut = worker('Fut', always(), 'A-01', { validFrom: NOON + HOUR });
    assert.equal(holders.canPass(fut.id, 'A-01').reason, 'not_started');
    assert.equal(holders.canPass(fut.id, 'A-01', NOON + 2 * HOUR).reason, 'ok');
    const old = worker('Old', always(), 'A-01', { validFrom: NOON - 2 * HOUR, validTo: NOON - HOUR });
    assert.equal(holders.canPass(old.id, 'A-01').reason, 'expired');
    const nob = mkStaff('Nobadge', '', { groupIds: [w.groupId] });
    assert.equal(holders.canPass(nob, 'A-01').reason, 'no_badge');
    const lost = mkStaff('Lost', '', { badges: ['LOST1'], groupIds: [w.groupId] });
    holders.setBadgeState('admin', holders.get(lost).badges[0].id, 'lost');
    assert.equal(holders.canPass(lost, 'A-01').reason, 'no_badge');
    assert.equal(holders.canPass(w.id, 'A-03').reason, 'no_right');
    assert.equal(holders.canPass(w.id, 'INCONNUE').reason, 'no_right');
    const nogroup = mkStaff('Nogroup', '', { badges: ['NG1'] });
    assert.equal(holders.canPass(nogroup, 'A-01').reason, 'no_right');
  });

  it('une visite terminee est expiree', () => {
    clock = NOON;
    const vg = mkGroup('Visiteurs', [['A-01']], { forVisitors: true });
    const v = holders.createVisitor('garde', { lastName: 'Martin', host: 'Konan', badge: 'V001', groupId: vg, durationMinutes: 60 });
    assert.equal(holders.canPass(v.holder.id, 'A-01').reason, 'ok');
    holders.endVisitor('garde', v.holder.id);
    assert.equal(holders.canPass(v.holder.id, 'A-01').reason, 'expired');
    const v2 = holders.createVisitor('garde', { lastName: 'Durand', host: 'Konan', badge: 'V002', groupId: vg, durationMinutes: 30 });
    assert.equal(holders.canPass(v2.holder.id, 'A-01', NOON + HOUR).reason, 'expired');
  });

  it('plage de nuit a cheval sur minuit : 23:30 et 05:00 passent, 12:00 non', () => {
    const w = worker('Nuit', night());
    assert.equal(holders.canPass(w.id, 'A-01', L(2026, 10, 19, 23, 30)).allowed, true);
    assert.equal(holders.canPass(w.id, 'A-01', L(2026, 10, 20, 5, 0)).allowed, true);
    const refused = holders.canPass(w.id, 'A-01', L(2026, 10, 19, 12, 0));
    assert.equal(refused.allowed, false);
    assert.equal(refused.reason, 'out_of_schedule');
    assert.equal(refused.groupId, w.groupId);
  });

  it('jour ferie : plage fermee -> holiday, plage non fermee -> ok', () => {
    holders.setHolidays('admin', [{ date: '2026-10-19', label: 'Test' }]);
    const closed = worker('Ferme', day(true));
    const open = worker('Ouvert', day(false), 'A-02');
    assert.equal(holders.isHoliday(NOON), true);
    assert.equal(holders.canPass(closed.id, 'A-01', NOON).reason, 'holiday');
    assert.equal(holders.canPass(open.id, 'A-02', NOON).reason, 'ok');
    assert.equal(holders.canPass(closed.id, 'A-01', L(2026, 10, 20, 12, 0)).reason, 'ok');
    // Hors plage ET ferie : « holiday » est prefere.
    assert.equal(holders.canPass(closed.id, 'A-01', L(2026, 10, 19, 23, 0)).reason, 'holiday');
  });

  it('isHoliday suit le calendrier en heure locale', () => {
    holders.setHolidays('admin', [{ date: '2026-12-25' }]);
    assert.equal(holders.isHoliday(L(2026, 12, 25, 0, 0)), true);
    assert.equal(holders.isHoliday(L(2026, 12, 25, 23, 59)), true);
    assert.equal(holders.isHoliday(L(2026, 12, 24, 23, 59)), false);
    assert.equal(holders.isHoliday(L(2026, 12, 26, 0, 0)), false);
  });

  it('deux groupes en conflit (base alteree) : un droit qui autorise suffit', () => {
    const dayS = day();
    const nightS = night();
    const g1 = mkGroup('Jour seul', [['A-01', dayS]]);
    const g2 = mkGroup('Nuit seule', [['A-02', nightS]]);
    const id = mkStaff('Deux', '', { badges: ['D1'], groupIds: [g1] });
    // Conflit impossible via le service : on force le second groupe et la meme porte directement.
    db.prepare('INSERT INTO access_holder_group (holder_id, group_id) VALUES (?, ?)').run(id, g2);
    db.prepare('INSERT INTO access_group_door (group_id, door_id, schedule_id) VALUES (?, ?, ?)').run(g2, 'A-01', nightS);
    const d = holders.canPass(id, 'A-01', L(2026, 10, 19, 12, 0));
    assert.deepEqual([d.allowed, d.groupId, d.scheduleId], [true, g1, dayS]);
    const n = holders.canPass(id, 'A-01', L(2026, 10, 19, 23, 30));
    assert.deepEqual([n.allowed, n.groupId, n.scheduleId], [true, g2, nightS]);
    assert.equal(holders.canPass(id, 'A-01', L(2026, 10, 19, 20, 0)).allowed, false);
  });

  it('groupsAllowedAt : de nuit, de jour, par porte, portes retirees ignorees', () => {
    const dayS = day();
    const nightS = night();
    const gDay = mkGroup('Jour', [['A-01', dayS], ['A-02', dayS]]);
    const gNight = mkGroup('Nuit', [['A-01', nightS], ['A-03', nightS]]);
    const gAlways = mkGroup('Toujours', [['A-04']]);
    const at12 = L(2026, 10, 19, 12, 0);
    const at23 = L(2026, 10, 19, 23, 30);
    assert.deepEqual(holders.groupsAllowedAt(at12), [
      { id: gDay, name: 'Jour', doorIds: ['A-01', 'A-02'] },
      { id: gAlways, name: 'Toujours', doorIds: ['A-04'] },
    ]);
    assert.deepEqual(holders.groupsAllowedAt(at23), [
      { id: gNight, name: 'Nuit', doorIds: ['A-01', 'A-03'] },
      { id: gAlways, name: 'Toujours', doorIds: ['A-04'] },
    ]);
    assert.deepEqual(holders.groupsAllowedAt(at23, 'A-01'), [{ id: gNight, name: 'Nuit', doorIds: ['A-01'] }]);
    assert.deepEqual(holders.groupsAllowedAt(at12, 'A-03'), []);
    // Porte retiree de access_door : ignoree.
    db.prepare('DELETE FROM access_door WHERE detector_id = ?').run('A-04');
    assert.deepEqual(holders.groupsAllowedAt(at12).map((g) => g.id), [gDay]);
    assert.equal(holders.canPass(mkStaff('X', '', { badges: ['X1'], groupIds: [gAlways] }), 'A-04', at12).reason, 'no_right');
  });

  it('groupsAllowedAt tient compte des jours feries fermes', () => {
    holders.setHolidays('admin', [{ date: '2026-10-19' }]);
    const gClosed = mkGroup('Ferme', [['A-01', day(true)]]);
    const gOpen = mkGroup('Ouvert', [['A-02', day(false)]]);
    assert.deepEqual(holders.groupsAllowedAt(NOON).map((g) => g.id), [gOpen]);
    assert.deepEqual(holders.groupsAllowedAt(L(2026, 10, 20, 12, 0)).map((g) => g.id), [gClosed, gOpen]);
  });

  it('groupsOf et holderOfBadge', () => {
    const w = worker('Lecture', always());
    assert.deepEqual(holders.groupsOf(w.id), [{ id: w.groupId, name: 'G Lecture' }]);
    assert.deepEqual(holders.groupsOf(99999), []);
    assert.equal(holders.holderOfBadge('BLecture')?.id, w.id);
    assert.deepEqual(holders.holderOfBadge('BLecture'), holders.findByBadge('BLecture'));
    assert.equal(holders.holderOfBadge('INCONNU'), null);
  });

  it('entrees hostiles : jamais d\'exception, reponse « refuse » ou liste vide', () => {
    clock = NOON;
    const w = worker('Hostile', always());
    for (const id of [-1, 0, 1.5, NaN, Infinity, 2 ** 60]) {
      assert.equal(holders.canPass(id, 'A-01').reason, 'unknown_holder');
      assert.deepEqual(holders.groupsOf(id), []);
    }
    for (const door of ['../x', '', 'A 01', "A-01'; DROP TABLE access_holder;--", 'x'.repeat(100), 42 as unknown as string, null as unknown as string]) {
      const d = holders.canPass(w.id, door);
      assert.deepEqual([d.allowed, d.reason], [false, 'no_right']);
    }
    assert.deepEqual(holders.groupsAllowedAt(NOON, '../x'), []);
    assert.deepEqual(holders.groupsAllowedAt(NOON, 42 as unknown as string), []);
    // `at` invalide : traite comme maintenant (l'horloge injectee).
    for (const at of [NaN, Infinity, 'x' as unknown as number, 1e300]) {
      assert.equal(holders.canPass(w.id, 'A-01', at).reason, 'ok');
      assert.deepEqual(holders.groupsAllowedAt(at, 'A-01').map((g) => g.id), [w.groupId]);
      assert.equal(typeof holders.isHoliday(at), 'boolean');
    }
    assert.equal(holders.holderOfBadge(42 as unknown as string), null);
    assert.equal(holders.holderOfBadge('../x'), null);
  });

  it('rien n\'est ecrit : journal, titulaires, droits et passages inchanges', () => {
    const w = worker('Pur', night());
    holders.setHolidays('admin', [{ date: '2026-10-19' }]);
    const snapshot = (): string => JSON.stringify({
      audit: auditCount(),
      holders: db.prepare('SELECT * FROM access_holder ORDER BY id').all(),
      badges: db.prepare('SELECT * FROM access_badge ORDER BY id').all(),
      rights: db.prepare('SELECT * FROM access_group_door ORDER BY group_id, door_id').all(),
      links: db.prepare('SELECT * FROM access_holder_group ORDER BY 1, 2').all(),
      events: rowCount('access_event'),
      holidays: rowCount('access_holiday'),
    });
    const before = snapshot();
    const notified = calls.length;
    holders.canPass(w.id, 'A-01', L(2026, 10, 19, 23, 30));
    holders.canPass(99999, '../x', NaN);
    holders.groupsAllowedAt(NOON);
    holders.groupsAllowedAt(NOON, 'A-01');
    holders.groupsOf(w.id);
    holders.holderOfBadge('BPur');
    holders.isHoliday(NOON);
    assert.equal(snapshot(), before);
    assert.equal(calls.length, notified);
  });
});
