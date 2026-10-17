/**
 * Armement des portes (F14) et flux des passages (F15) : moteur REEL + module d'acces REEL + armement REEL sur base en memoire,
 * horloge injectee (aucune attente reelle). Les droits des titulaires sont une FAUSSE implementation de `HoldersReader`.
 * Fuseau force sur Europe/Paris (changement d'heure du 25 octobre 2026), remis a l'ancien en fin de fichier.
 */
const SYSTEM_TZ = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
process.env.TZ = 'Europe/Paris';

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { after, beforeEach, describe, it } from 'node:test';
import { createAccess } from '../server/access.ts';
import type { AccessHook, AccessService } from '../server/access.ts';
import { ARMING_COVER_BEFORE_MS, ARMING_GRACE_MS, armingLabel, createDoorArming } from '../server/accessarming.ts';
import type { DoorArming } from '../server/accessarming.ts';
import type { PassDecision } from '../server/accessholderstypes.ts';
import type { PassageNote, RaiseRequest } from '../server/accessrulestypes.ts';
import { createArming, inSchedule } from '../server/arming.ts';
import type { Arming, Window } from '../server/arming.ts';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import type { Engine } from '../server/engine.ts';
import { seedDemo } from '../server/seed.ts';

after(() => {
  process.env.TZ = SYSTEM_TZ; // `delete process.env.TZ` ne remet pas le fuseau d'origine : on le reaffecte
});

const S = 1000;
const MIN = 60 * S;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SEED = join(import.meta.dirname, '..', 'seed');
/** Heure LOCALE (calculee a l'appel : le fuseau du processus est fixe plus haut). Mois 1-12. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number => new Date(y, mo - 1, d, h, mi, s).getTime();
/** Jeudi 15 octobre 2026, 22:14:00 (heure d'ete, avant le changement d'heure du 25). */
const T0 = local(2026, 10, 15, 22, 14, 0);

const NIGHT: Window[] = [{ days: [0, 1, 2, 3, 4, 5, 6], from: '22:00', to: '06:00' }];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const DOOR_A = 'A-01'; // « Porte de service entrepot », zone Entrepot
const DOOR_B = 'A-02'; // « Porte B », zone Entrepot
const NAME_A = 'Porte de service entrepot';

type Json = Record<string, unknown>;

// ---- Fausse implementation des droits (HoldersReader) ---------------------------------------------------------------------------

class FakeHolders {
  holders = new Map<number, { status: 'active' | 'suspended' | 'expired'; groups: number[] }>();
  groups = new Map<number, string>();
  rights: { groupId: number; doorIds: string[]; windows: Window[]; closedOnHoliday?: boolean }[] = [];
  /** Jours feries `AAAA-M-J` (heure locale). */
  holidays = new Set<string>();
  badges = new Map<string, number>();
  /** Force `canPass` a repondre « autorise » (pour verifier que le croisement des groupes est bien fait en plus). */
  forceAllow = false;
  throwOnCanPass = false;
  calls: { holderId: number; doorId: string; at: number | undefined }[] = [];

  resolve(credential: string | null): { id: number; name: string } | null {
    const id = credential === null ? undefined : this.badges.get(credential);
    return id === undefined ? null : { id, name: `Titulaire ${id}` };
  }

  groupsOf(holderId: number): { id: number; name: string }[] {
    return (this.holders.get(holderId)?.groups ?? []).map((id) => ({ id, name: this.groups.get(id) ?? `Groupe ${id}` }));
  }

  private day(at: number): string {
    const d = new Date(at);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  canPass(holderId: number, doorId: string, at: number = Date.now()): PassDecision {
    this.calls.push({ holderId, doorId, at });
    if (this.throwOnCanPass) throw new Error('lecteur de droits en panne');
    const h = this.holders.get(holderId);
    if (!h) return { allowed: false, reason: 'unknown_holder', groupId: null, scheduleId: null };
    if (h.status === 'suspended') return { allowed: false, reason: 'suspended', groupId: null, scheduleId: null };
    if (h.status === 'expired') return { allowed: false, reason: 'expired', groupId: null, scheduleId: null };
    if (this.forceAllow) return { allowed: true, reason: 'ok', groupId: null, scheduleId: null };
    const mine = this.rights.filter((r) => h.groups.includes(r.groupId) && r.doorIds.includes(doorId));
    if (mine.length === 0) return { allowed: false, reason: 'no_right', groupId: null, scheduleId: null };
    for (const r of mine) {
      if (r.closedOnHoliday && this.holidays.has(this.day(at))) return { allowed: false, reason: 'holiday', groupId: r.groupId, scheduleId: null };
      if (inSchedule(r.windows, at)) return { allowed: true, reason: 'ok', groupId: r.groupId, scheduleId: 1 };
    }
    return { allowed: false, reason: 'out_of_schedule', groupId: mine[0].groupId, scheduleId: null };
  }

  groupsAllowedAt(at: number, doorId?: string): { id: number; name: string; doorIds: string[] }[] {
    const out: { id: number; name: string; doorIds: string[] }[] = [];
    for (const r of this.rights) {
      if (!inSchedule(r.windows, at)) continue;
      if (r.closedOnHoliday && this.holidays.has(this.day(at))) continue;
      if (doorId !== undefined && !r.doorIds.includes(doorId)) continue;
      out.push({ id: r.groupId, name: this.groups.get(r.groupId) ?? `Groupe ${r.groupId}`, doorIds: r.doorIds });
    }
    return out;
  }
}

// ---- Montage : comme le fera main.ts ---------------------------------------------------------------------------------------------

let db: DatabaseSync;
let engine: Engine;
let access: AccessService;
let arming: Arming;
let doorArming: DoorArming;
let fake: FakeHolders;
let clock: number;
let raised: { doorId: string; request: RaiseRequest }[];
let notesOfCalls: number;
const quiet = console.error;

interface SetupOptions {
  /** Pas de module d'armement des portes (comportement d'avant). */
  noModule?: boolean;
  /** Pas de lecteur de droits. */
  noHolders?: boolean;
  start?: number;
  accessOverrides?: { purgeBatch?: number };
}

function setup(options: SetupOptions = {}): void {
  db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-armdoor-')), SEED);
  clock = options.start ?? T0;
  raised = [];
  notesOfCalls = 0;
  fake = new FakeHolders();
  fake.groups.set(7, 'Nuit');
  fake.groups.set(8, 'Jour');
  fake.holders.set(12, { status: 'active', groups: [7] });
  fake.holders.set(13, { status: 'suspended', groups: [7] });
  fake.holders.set(14, { status: 'expired', groups: [7] });
  fake.holders.set(15, { status: 'active', groups: [8] }); // groupe sans aucun droit
  fake.badges.set('0012345', 12);
  fake.badges.set('0000013', 13);
  fake.badges.set('0000014', 14);
  fake.badges.set('0000015', 15);
  fake.rights.push({ groupId: 7, doorIds: [DOOR_A, DOOR_B], windows: NIGHT });
  const key = randomBytes(32);
  arming = createArming(db, (actor, action, ref) => engine.audit(actor, action, ref), () => clock);
  const realArming = createDoorArming({
    db,
    now: () => clock,
    isArmed: (zone, at) => arming.isArmed(zone, at),
    holders: options.noHolders ? undefined : fake,
    raise: (doorId, request) => {
      raised.push({ doorId, request });
      return engine.setStateBySupervisor(doorId, request.state, request.event, request.detail);
    },
    audit: (actor, action, ref) => engine.audit(actor, action, ref),
  });
  // Compte les lectures groupees des notes (pas une requete par ligne).
  doorArming = { ...realArming, notesOf: (ids) => { notesOfCalls++; return realArming.notesOf(ids); } };
  access = createAccess({
    db,
    now: () => clock,
    key,
    audit: (actor, action, ref) => engine.audit(actor, action, ref),
    setDeviceState: (id, state, event, detail) => engine.setStateBySupervisor(id, state, event, detail ?? null),
    resolveHolder: (credential) => fake.resolve(credential),
    ...(options.accessOverrides ?? {}),
    ...(options.noModule ? {} : { doorArming }),
  });
  engine = createEngine(db, () => {}, () => clock, { access, isArmed: (zone) => arming.isArmed(zone) });
  // Zone « Entrepot » : un detecteur d'intrusion la rend armable (le defaut, sans planning : armee en permanence).
  engine.createDevice('admin', { id: 'I-ENT', kind: 'detector', name: 'Mouvement entrepot', zone: 'Entrepot', category: 'intrusion' });
  engine.createDevice('admin', { id: DOOR_B, kind: 'detector', name: 'Porte B', zone: 'Entrepot', category: 'access' });
  access.createController('admin', { id: 'CTL-1', name: 'Controleur entree', brand: 'dahua' });
  access.declareDoor('admin', { detectorId: DOOR_A, controllerId: 'CTL-1', doorNo: 1 });
  access.declareDoor('admin', { detectorId: DOOR_B, controllerId: 'CTL-1', doorNo: 2 });
}

/** Rattache la porte a l'armement de sa zone (administrateur). */
const attach = (id = DOOR_A): void => void access.updateDoor('admin', id, { armWithZone: true });

let seq = 0;
interface GrantOptions {
  ts?: number;
  credential?: string | null;
  method?: string;
  result?: 'granted' | 'denied';
  deferred?: boolean;
  holderName?: string | null;
  eventId?: string;
}
/** Passage envoye comme le fera la passerelle (docs/CONTROLE-ACCES.md § 2) ; `ts` = heure du controleur (defaut : maintenant). */
function passageMessage(o: GrantOptions = {}): Json {
  const eventId = o.eventId ?? String(++seq);
  const result = o.result ?? 'granted';
  return {
    event: result === 'granted' ? 'badge_granted' : 'badge_denied',
    ts: o.ts ?? clock,
    msgId: `acc:CTL-1:${eventId}`,
    access: {
      v: 1, controllerId: 'CTL-1', eventId, direction: 'in', credential: o.credential === undefined ? '0012345' : o.credential,
      holderName: o.holderName === undefined ? 'KONAN Yao' : o.holderName, holderRef: null, method: o.method ?? 'badge', result,
      reason: result === 'granted' ? null : 'unknown_credential', deferred: o.deferred ?? false,
    },
  };
}
const grant = (o: GrantOptions = {}, door = DOOR_A) => engine.ingest(door, passageMessage(o));
const opened = (ts = clock, door = DOOR_A) => engine.ingest(door, { event: 'door_opened', ts, msgId: `op:${++seq}` });
const closed = (ts = clock, door = DOOR_A) => engine.ingest(door, { event: 'door_closed', ts, msgId: `cl:${++seq}` });
/** Avance l'horloge puis passe le controle periodique du module d'acces. */
function advance(ms: number): void {
  clock += ms;
  access.tick();
}

const status = (id: string): string => (db.prepare('SELECT status FROM device WHERE id = ?').get(id) as { status: string }).status;
const incidents = (id: string) => engine.getSnapshot().incidents.filter((i) => i.detectorId === id);
const events = () => db.prepare('SELECT * FROM access_event ORDER BY id').all() as Json[];
const noteRows = () => db.prepare('SELECT * FROM access_event_arming ORDER BY event_id').all() as Json[];
const audits = (action: string) => engine.listAudit(500).filter((e) => e.action === action);
const lastPassage = () => access.door(DOOR_A).lastPassages[0];
const badRequest = (pattern: RegExp) => (e: unknown): boolean => e instanceof PsimError && e.status === 400 && pattern.test(e.message);

// ---- Schema ----------------------------------------------------------------------------------------------------------------------

describe('schema, cles etrangeres et cascade', () => {
  beforeEach(() => setup());

  it('les deux tables existent et PRAGMA foreign_keys est actif a l\'execution', () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('access_door_arming', 'access_event_arming') ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    assert.deepEqual(tables, ['access_door_arming', 'access_event_arming']);
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as Json).foreign_keys, 1);
  });

  it('migration idempotente : rejouee, les donnees restent', () => {
    attach();
    access.updateDoor('admin', DOOR_A, { armWithZone: true });
    assert.equal(access.door(DOOR_A).door.arming.enabled, true);
    assert.doesNotThrow(() => createDoorArming({ db, isArmed: () => true, raise: () => true, audit: () => {} }));
    assert.equal(access.door(DOOR_A).door.arming.enabled, true);
  });

  it('un reglage ou une note de passage ne peut pas viser un detecteur ou un passage inexistant', () => {
    assert.throws(() => db.prepare("INSERT INTO access_door_arming (detector_id, enabled, updated_at, updated_by) VALUES ('NOPE', 1, 0, 'x')").run());
    assert.throws(() => db.prepare('INSERT INTO access_event_arming (event_id, authorized) VALUES (999, 1)').run());
  });

  it('supprimer le detecteur supprime son reglage (cascade)', () => {
    engine.createDevice('admin', { id: 'A-09', kind: 'detector', name: 'Porte 9', zone: 'Entrepot', category: 'access' });
    db.prepare("INSERT INTO access_door_arming (detector_id, enabled, updated_at, updated_by) VALUES ('A-09', 1, 0, 'x')").run();
    engine.deleteDevice('admin', 'A-09');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM access_door_arming WHERE detector_id = 'A-09'").get()!.n as number, 0);
  });
});

// ---- Reglage de la porte -----------------------------------------------------------------------------------------------------------

describe('reglage « armer avec la zone »', () => {
  beforeEach(() => setup());

  it('par defaut une porte n\'est PAS rattachee ; sa zone est celle du detecteur, armable si un detecteur d\'intrusion y est', () => {
    assert.deepEqual(access.door(DOOR_A).door.arming, { enabled: false, zone: 'Entrepot', zoneArmable: true, armedNow: null });
    assert.deepEqual(access.doors().map((d) => d.arming.enabled), [false, false]);
  });

  it('activer rend `enabled` vrai et indique l\'armement actuel de la zone', () => {
    const v = access.updateDoor('admin', DOOR_A, { armWithZone: true });
    assert.deepEqual(v.arming, { enabled: true, zone: 'Entrepot', zoneArmable: true, armedNow: true });
    arming.setOverride('operateur', 'Entrepot', 'disarmed', 1);
    assert.equal(access.door(DOOR_A).door.arming.armedNow, false);
    assert.equal(access.doors().find((d) => d.detectorId === DOOR_A)!.arming.armedNow, false);
    assert.equal(access.doors().find((d) => d.detectorId === DOOR_B)!.arming.armedNow, null, 'porte non rattachee : pas d\'etat d\'armement');
  });

  it('refuse (400) une zone vide', () => {
    db.prepare("UPDATE device SET zone = '' WHERE id = ?").run(DOOR_A);
    assert.throws(() => access.updateDoor('admin', DOOR_A, { armWithZone: true }), badRequest(/pas de zone/));
    assert.equal(access.door(DOOR_A).door.arming.enabled, false);
    assert.equal(audits('access_door_arming').length, 0);
  });

  it('refuse (400) une zone sans armement (aucun detecteur d\'intrusion, aucun planning)', () => {
    db.prepare("UPDATE device SET zone = 'Bureaux' WHERE id = ?").run(DOOR_A);
    assert.throws(() => access.updateDoor('admin', DOOR_A, { armWithZone: true }), badRequest(/Bureaux.*n'a pas d'armement/));
    // Une ligne `arming_zone` (planning) suffit a la rendre armable.
    arming.setSchedule('admin', 'Entrepot', NIGHT);
    db.prepare("UPDATE device SET zone = 'Entrepot' WHERE id = ?").run(DOOR_A);
    db.prepare("UPDATE device SET category = 'fire' WHERE id = 'I-ENT'").run();
    assert.equal(access.updateDoor('admin', DOOR_A, { armWithZone: true }).arming.enabled, true, 'planning present : armable');
  });

  it('armWithZone doit etre un booleen strict', () => {
    for (const bad of ['true', 1, 0, null, 'oui', {}, []]) {
      assert.throws(() => access.updateDoor('admin', DOOR_A, { armWithZone: bad }), badRequest(/armWithZone/), String(bad));
    }
    assert.equal(access.door(DOOR_A).door.arming.enabled, false);
  });

  it('desactiver est toujours possible, meme si la zone n\'est plus armable', () => {
    attach();
    db.prepare("UPDATE device SET zone = '' WHERE id = ?").run(DOOR_A);
    assert.equal(access.updateDoor('admin', DOOR_A, { armWithZone: false }).arming.enabled, false);
  });

  it('une modification sans rapport ne bloque pas une porte deja rattachee dont la zone a change', () => {
    attach();
    db.prepare("UPDATE device SET zone = '' WHERE id = ?").run(DOOR_A);
    assert.doesNotThrow(() => access.updateDoor('admin', DOOR_A, { armWithZone: true, heldAlarmAfterS: 60 }));
  });

  it('journalise (access_door_arming) l\'activation et la desactivation, une seule fois par changement', () => {
    attach();
    attach(); // sans changement : rien de plus
    const [on] = audits('access_door_arming');
    assert.equal(on.actor, 'admin');
    assert.equal(on.deviceId, DOOR_A);
    assert.match(on.details ?? '', /rattachee a l'armement de la zone « Entrepot »/);
    access.updateDoor('admin', DOOR_A, { armWithZone: false });
    const all = audits('access_door_arming');
    assert.equal(all.length, 2);
    assert.match(all[0].details ?? '', /detachee/);
  });

  it('declareDoor accepte armWithZone, et refuse une zone non armable AVANT d\'ecrire quoi que ce soit', () => {
    engine.createDevice('admin', { id: 'A-03', kind: 'detector', name: 'Porte 3', zone: 'Entrepot', category: 'access' });
    engine.createDevice('admin', { id: 'A-04', kind: 'detector', name: 'Porte 4', zone: 'Nulle part', category: 'access' });
    assert.throws(() => access.declareDoor('admin', { detectorId: 'A-04', controllerId: 'CTL-1', doorNo: 3, armWithZone: true }), badRequest(/Nulle part/));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM access_door WHERE detector_id = 'A-04'").get()!.n as number, 0, 'rien n\'est ecrit');
    const v = access.declareDoor('admin', { detectorId: 'A-03', controllerId: 'CTL-1', doorNo: 3, armWithZone: true });
    assert.equal(v.arming.enabled, true);
  });

  it('retirer la porte oublie le rattachement : une redeclaration repart non rattachee', () => {
    attach();
    access.removeDoor('admin', DOOR_A);
    access.declareDoor('admin', { detectorId: DOOR_A, controllerId: 'CTL-1', doorNo: 1 });
    assert.equal(access.door(DOOR_A).door.arming.enabled, false);
  });

  it('sans module d\'armement : `arming` neutre, activer est refuse (400), desactiver est ignore', () => {
    setup({ noModule: true });
    assert.deepEqual(access.door(DOOR_A).door.arming, { enabled: false, zone: 'Entrepot', zoneArmable: false, armedNow: null });
    assert.deepEqual(access.doors()[0].arming, { enabled: false, zone: 'Entrepot', zoneArmable: false, armedNow: null });
    assert.throws(() => access.updateDoor('admin', DOOR_A, { armWithZone: true }), badRequest(/pas disponible/));
    assert.doesNotThrow(() => access.updateDoor('admin', DOOR_A, { armWithZone: false }));
    grant({ credential: null, method: 'remote' });
    assert.equal(status(DOOR_A), 'normal', 'comportement d\'avant');
    assert.equal(lastPassage().arming, null);
  });
});

// ---- Jugement d'un passage -------------------------------------------------------------------------------------------------------

describe('passage accepte pendant l\'armement', () => {
  beforeEach(() => setup());

  it('titulaire dont le groupe Nuit a un droit en vigueur : « autorisee, groupe Nuit », aucune pre-alarme', () => {
    attach();
    assert.deepEqual(grant(), { ok: true });
    assert.equal(status(DOOR_A), 'normal');
    assert.equal(incidents(DOOR_A).length, 0);
    assert.deepEqual(raised, []);
    const note = lastPassage().arming!;
    assert.deepEqual([note.authorized, note.groupId, note.groupName], [true, 7, 'Nuit']);
    assert.equal(note.label, "Ouverture pendant l'armement : autorisée, groupe Nuit");
    assert.deepEqual(noteRows().map((r) => [r.authorized, r.group_id, r.group_name]), [[1, 7, 'Nuit']]);
  });

  it('meme quand le door_opened du capteur SUIT, ou PRECEDE, le passage : aucune pre-alarme', () => {
    attach();
    grant();
    opened(clock + 1 * S);
    advance(6 * S);
    assert.equal(status(DOOR_A), 'normal', 'door_opened apres le passage');
    // Autre cas : le capteur voit l'ouverture 2 s AVANT l'arrivee du badge_granted.
    opened(clock);
    advance(2 * S);
    grant({ ts: clock });
    advance(6 * S);
    assert.equal(status(DOOR_A), 'normal', 'door_opened avant le passage');
    assert.deepEqual(raised, []);
  });

  it('titulaire sans droit : « non autorisee » + pre-alarme, avec un texte qui nomme la porte et l\'heure, sans nom ni numero de badge', () => {
    attach();
    grant({ credential: '0000015' });
    assert.equal(lastPassage().arming!.label, "Ouverture pendant l'armement : non autorisée");
    assert.equal(lastPassage().arming!.authorized, false);
    assert.equal(status(DOOR_A), 'prealarm');
    const [incident] = incidents(DOOR_A);
    assert.equal(incident.severity, 'warning');
    assert.equal(incident.event, 'door_opened_armed');
    assert.equal(incident.detail, `Ouverture de la porte « ${NAME_A} » à 22:14 pendant l'armement de la zone « Entrepot » : titulaire H15 sans droit à cette heure`);
    for (const secret of ['KONAN', 'Yao', '0000015', '0012345', 'Titulaire 15']) assert.ok(!(incident.detail ?? '').includes(secret), `ne contient pas ${secret}`);
    assert.deepEqual(raised, [], 'passage : la pre-alarme passe par le moteur (resultat du crochet), pas par le tick');
  });

  it('suspendu, expire, badge inconnu, holder NULL : tous NON autorises (dans le doute, pre-alarme)', () => {
    attach();
    const cases: [string, string | null, string][] = [
      ['suspendu', '0000013', 'titulaire H13 sans droit à cette heure'],
      ['expire', '0000014', 'titulaire H14 sans droit à cette heure'],
      ['badge inconnu', '0099999', 'aucun titulaire connu'],
      ['sans badge (holder NULL)', null, 'aucun titulaire connu'],
    ];
    for (const [label, credential, text] of cases) {
      closed(clock);
      advance(1 * S);
      db.prepare("UPDATE incident SET status = 'closed', qualification = 'false_alarm', closed_at = 0, closed_by = 'x' WHERE detector_id = ?").run(DOOR_A);
      grant({ credential });
      const note = lastPassage().arming!;
      assert.equal(note.authorized, false, label);
      assert.equal(status(DOOR_A), 'prealarm', label);
      assert.ok(incidents(DOOR_A).some((i) => i.status !== 'closed' && (i.detail ?? '').endsWith(`: ${text}`)), `${label} : ${text}`);
    }
  });

  it('un titulaire connu mais non rattache au passage (holder_id NULL) n\'est pas autorise, meme avec un nom dans le message', () => {
    attach();
    grant({ credential: '0099999', holderName: 'KONAN Yao' });
    assert.equal(events()[0].holder_id, null);
    assert.equal(lastPassage().arming!.authorized, false);
  });

  it('sans lecteur de droits : personne n\'est autorise', () => {
    setup({ noHolders: true });
    attach();
    grant();
    assert.equal(lastPassage().arming!.authorized, false);
    assert.equal(status(DOOR_A), 'prealarm');
  });

  it('un lecteur de droits qui leve : non autorise, le passage est quand meme enregistre', () => {
    attach();
    fake.throwOnCanPass = true;
    console.error = () => {};
    try {
      assert.deepEqual(grant(), { ok: true });
    } finally {
      console.error = quiet;
    }
    assert.equal(events().length, 1);
    assert.equal(lastPassage().arming!.authorized, false);
    assert.equal(status(DOOR_A), 'prealarm');
  });

  it('canPass seul ne suffit pas : un groupe du titulaire doit AUSSI avoir un droit en vigueur pour cette porte', () => {
    attach();
    fake.forceAllow = true; // canPass dit oui, mais le groupe Jour du titulaire 15 n'a aucun droit
    grant({ credential: '0000015' });
    assert.equal(lastPassage().arming!.authorized, false);
    // Le titulaire 12 (groupe Nuit, droit en vigueur) reste autorise.
    grant({ credential: '0012345' });
    assert.equal(lastPassage().arming!.authorized, true);
  });

  it('jour ferie : canPass repond `holiday` -> non autorise', () => {
    attach();
    fake.rights[0].closedOnHoliday = true;
    fake.holidays.add('2026-10-15');
    grant();
    assert.equal(lastPassage().arming!.authorized, false);
    assert.equal(status(DOOR_A), 'prealarm');
    assert.equal(fake.calls.at(-1)!.at, T0, 'jugement a l\'heure du passage');
  });

  it('ouverture a distance et bouton de sortie pendant l\'armement : pre-alarme', () => {
    attach();
    grant({ credential: null, method: 'remote', holderName: null });
    assert.equal(status(DOOR_A), 'prealarm');
    assert.equal(lastPassage().arming!.authorized, false);
    closed(clock);
    db.prepare("UPDATE incident SET status = 'closed', qualification = 'false_alarm', closed_at = 0, closed_by = 'x' WHERE detector_id = ?").run(DOOR_A);
    advance(1 * S);
    grant({ credential: null, method: 'exit_button', holderName: null });
    assert.equal(status(DOOR_A), 'prealarm');
    assert.equal(access.door(DOOR_A).lastPassages[0].arming!.authorized, false);
  });

  it('un passage REFUSE n\'ouvre rien : ni note, ni pre-alarme', () => {
    attach();
    grant({ result: 'denied', credential: '0000015' });
    assert.equal(status(DOOR_A), 'normal');
    assert.equal(noteRows().length, 0);
    assert.equal(lastPassage().arming, null);
  });

  it('porte non rattachee : aucun effet (ni note, ni pre-alarme)', () => {
    grant({ credential: '0000015' });
    assert.equal(status(DOOR_A), 'normal');
    assert.equal(noteRows().length, 0);
    opened();
    advance(10 * S);
    assert.equal(status(DOOR_A), 'normal');
  });

  it('rattachement par porte : la porte B n\'est pas concernee par le reglage de la porte A', () => {
    attach(DOOR_A);
    grant({ credential: '0000015' }, DOOR_B);
    assert.equal(status(DOOR_B), 'normal');
    assert.equal(noteRows().length, 0);
  });

  it('zone sans armement (la zone de la porte change) ou vide : aucun effet, la zone est relue a chaque jugement', () => {
    attach();
    db.prepare("UPDATE device SET zone = 'Bureaux' WHERE id = ?").run(DOOR_A);
    grant({ credential: '0000015' });
    assert.equal(status(DOOR_A), 'normal', 'Bureaux n\'a pas d\'armement');
    db.prepare("UPDATE device SET zone = '' WHERE id = ?").run(DOOR_A);
    grant({ credential: '0000015' });
    assert.equal(status(DOOR_A), 'normal', 'zone vide');
    db.prepare("UPDATE device SET zone = 'Entrepot' WHERE id = ?").run(DOOR_A);
    grant({ credential: '0000015' });
    assert.equal(status(DOOR_A), 'prealarm', 'zone retablie');
  });

  it('zone desarmee (planning de jour) : aucun effet ; armee la nuit : pre-alarme', () => {
    attach();
    arming.setSchedule('admin', 'Entrepot', NIGHT);
    const noon = local(2026, 10, 15, 12, 0);
    clock = noon;
    grant({ credential: '0000015', ts: noon });
    assert.equal(status(DOOR_A), 'normal');
    assert.equal(noteRows().length, 0);
    clock = T0; // 22:14, dans la plage de nuit
    grant({ credential: '0000015', ts: T0 });
    assert.equal(status(DOOR_A), 'prealarm');
  });

  it('jugement a l\'heure du CONTROLEUR : un desarmement decide 3 s apres le passage ne l\'excuse pas (passage recu en differe)', () => {
    attach();
    advance(3 * S);
    arming.setOverride('operateur', 'Entrepot', 'disarmed', 1); // derogation a T0+3 s
    advance(7 * S);
    // Le passage date de T0 (avant la derogation), il arrive a T0+10 s, « en differe ».
    grant({ credential: '0000015', ts: T0, deferred: true });
    assert.equal(events()[0].late, 1);
    assert.equal(lastPassage().arming!.authorized, false, 'juge a T0 : la zone etait armee');
    assert.equal(status(DOOR_A), 'prealarm');
    // Un passage posterieur a la derogation, lui, tombe en zone desarmee.
    closed(clock);
    db.prepare("UPDATE incident SET status = 'closed', qualification = 'false_alarm', closed_at = 0, closed_by = 'x' WHERE detector_id = ?").run(DOOR_A);
    grant({ credential: '0000015', ts: clock });
    assert.equal(access.door(DOOR_A).lastPassages[0].arming, null);
    assert.equal(status(DOOR_A), 'normal');
  });

  it('un passage tres ancien est juge a son heure, pas a l\'heure courante', () => {
    attach();
    arming.setSchedule('admin', 'Entrepot', NIGHT);
    clock = local(2026, 10, 16, 12, 0); // il est midi, zone desarmee...
    grant({ credential: '0000015', ts: local(2026, 10, 15, 23, 0), deferred: true }); // ...mais le passage date de 23:00 (armee)
    assert.equal(status(DOOR_A), 'prealarm');
    assert.match(incidents(DOOR_A)[0].detail ?? '', /à 23:00/);
  });
});

// ---- Minuit et changement d'heure ------------------------------------------------------------------------------------------------

describe('minuit : droit « 22:00-06:00 »', () => {
  beforeEach(() => setup());

  it('23:59:59 et 00:00:01 sont autorises, 21:59:59 et 06:00:01 ne le sont pas', () => {
    attach();
    const at = (day: number, h: number, mi: number, s: number) => local(2026, 10, day, h, mi, s);
    const cases: [number, boolean][] = [
      [at(15, 23, 59, 59), true],
      [at(16, 0, 0, 1), true],
      [at(15, 21, 59, 59), false],
      [at(16, 6, 0, 1), false],
      [at(16, 5, 59, 59), true],
      [at(16, 6, 0, 0), false],
      [at(15, 22, 0, 0), true],
    ];
    for (const [ts, authorized] of cases) {
      clock = ts;
      access.tick();
      db.prepare("UPDATE incident SET status = 'closed', qualification = 'false_alarm', closed_at = 0, closed_by = 'x' WHERE detector_id = ?").run(DOOR_A);
      db.prepare("UPDATE device SET status = 'normal' WHERE id = ?").run(DOOR_A);
      grant({ ts });
      assert.equal(access.door(DOOR_A).lastPassages.find((p) => p.atDevice === ts)!.arming!.authorized, authorized, new Date(ts).toString());
      assert.equal(status(DOOR_A), authorized ? 'normal' : 'prealarm', new Date(ts).toString());
    }
  });
});

describe('changement d\'heure du dimanche 25 octobre 2026 (Europe/Paris)', () => {
  beforeEach(() => setup());

  it('les deux « 02:30 » de la nuit sont jugees comme deux instants distincts', () => {
    attach();
    // 02:30 CEST = 00:30Z ; 02:30 CET (apres le retour a l'heure d'hiver) = 01:30Z ; 03:30 CET = 02:30Z.
    const first = Date.UTC(2026, 9, 25, 0, 30, 0);
    const second = Date.UTC(2026, 9, 25, 1, 30, 0);
    const later = Date.UTC(2026, 9, 25, 2, 30, 0);
    assert.equal(new Date(first).getHours(), 2);
    assert.equal(new Date(second).getHours(), 2);
    assert.equal(new Date(later).getHours(), 3);
    // Planning : armee seulement de 02:00 a 03:00 heure locale le dimanche.
    arming.setSchedule('admin', 'Entrepot', [{ days: [0], from: '02:00', to: '03:00' }]);
    const results: [number, boolean | null][] = [[first, true], [second, true], [later, null]];
    for (const [ts, expected] of results) {
      clock = ts + 1 * S;
      db.prepare("UPDATE incident SET status = 'closed', qualification = 'false_alarm', closed_at = 0, closed_by = 'x' WHERE detector_id = ?").run(DOOR_A);
      db.prepare("UPDATE device SET status = 'normal' WHERE id = ?").run(DOOR_A);
      grant({ ts, credential: '0012345' });
      const note = access.door(DOOR_A).lastPassages[0].arming;
      assert.equal(note?.authorized ?? null, expected, new Date(ts).toISOString());
    }
  });

  it('le texte donne l\'heure LOCALE du passage (02:30, pas 00:30 UTC)', () => {
    attach();
    const ts = Date.UTC(2026, 9, 25, 1, 30, 0);
    clock = ts + 1 * S;
    grant({ ts, credential: '0000015' });
    assert.match(incidents(DOOR_A)[0].detail ?? '', /à 02:30 pendant/);
  });
});

// ---- door_opened sans passage ---------------------------------------------------------------------------------------------------

describe('door_opened sans passage correspondant', () => {
  beforeEach(() => setup());

  it('pre-alarme une fois le delai de grace de 5 s ecoule, pas avant', () => {
    attach();
    opened();
    assert.equal(status(DOOR_A), 'normal');
    advance(ARMING_GRACE_MS - 1);
    assert.equal(status(DOOR_A), 'normal', '4,999 s : trop tot');
    advance(1);
    assert.equal(status(DOOR_A), 'prealarm', '5 s');
    const [incident] = incidents(DOOR_A);
    assert.equal(incident.event, 'door_opened_armed');
    assert.equal(incident.detail, `Ouverture de la porte « ${NAME_A} » à 22:14 pendant l'armement de la zone « Entrepot » : aucun titulaire connu`);
    assert.equal(raised.length, 1);
  });

  it('une porte non rattachee n\'attend rien', () => {
    opened();
    advance(30 * S);
    assert.equal(status(DOOR_A), 'normal');
  });

  it('la pre-alarme s\'efface par le retour a la normale (door_closed)', () => {
    attach();
    opened();
    advance(ARMING_GRACE_MS);
    assert.equal(status(DOOR_A), 'prealarm');
    closed(clock);
    assert.equal(status(DOOR_A), 'normal');
  });

  it('un passage ACCEPTE dans les 30 s avant couvre l\'ouverture (fenetre [t - 30 s, t + 5 s])', () => {
    attach();
    grant({ ts: clock - ARMING_COVER_BEFORE_MS, credential: '0012345' });
    opened();
    advance(ARMING_GRACE_MS);
    assert.equal(status(DOOR_A), 'normal');
  });

  it('un passage accepte plus de 30 s avant ne couvre plus', () => {
    attach();
    grant({ ts: clock - ARMING_COVER_BEFORE_MS - 1, credential: '0012345' });
    opened();
    advance(ARMING_GRACE_MS);
    assert.equal(status(DOOR_A), 'prealarm');
  });

  it('un passage REFUSE ne couvre pas l\'ouverture', () => {
    attach();
    grant({ result: 'denied', credential: '0099999' });
    opened();
    advance(ARMING_GRACE_MS);
    assert.equal(status(DOOR_A), 'prealarm');
  });

  it('un passage d\'une AUTRE porte ne couvre pas l\'ouverture', () => {
    attach();
    grant({ credential: '0012345' }, DOOR_B);
    opened();
    advance(ARMING_GRACE_MS);
    assert.equal(status(DOOR_A), 'prealarm');
  });

  it('un passage qui arrive pendant le delai de grace couvre l\'ouverture deja vue', () => {
    attach();
    opened();
    advance(3 * S);
    grant({ ts: clock - 2 * S });
    advance(3 * S);
    assert.equal(status(DOOR_A), 'normal');
  });

  it('un passage non autorise a deja provoque la pre-alarme : le door_opened voisin n\'en ajoute pas (une alarme par detecteur)', () => {
    attach();
    grant({ credential: '0000015' });
    opened(clock + 1 * S);
    advance(6 * S);
    assert.equal(status(DOOR_A), 'prealarm');
    assert.equal(incidents(DOOR_A).length, 1);
    assert.deepEqual(raised, []);
  });

  it('jugee a l\'heure de l\'ouverture : desarmement decide 3 s plus tard (door_opened a T, derogation a T+3 s) -> pre-alarme quand meme', () => {
    attach();
    opened(clock);
    advance(3 * S);
    arming.setOverride('operateur', 'Entrepot', 'disarmed', 1);
    advance(3 * S); // T+6 s : delai de grace ecoule
    assert.equal(status(DOOR_A), 'prealarm');
  });

  it('une ouverture survenue en zone desarmee n\'est pas jugee, meme si la zone est armee quand le delai expire', () => {
    attach();
    arming.setSchedule('admin', 'Entrepot', [{ days: ALL_DAYS, from: '23:00', to: '06:00' }]); // armee a partir de 23:00
    clock = local(2026, 10, 15, 22, 59, 58);
    opened(clock);
    advance(ARMING_GRACE_MS); // 23:00:03 : armee maintenant, mais pas a 22:59:58
    assert.equal(status(DOOR_A), 'normal');
  });

  it('deux ouvertures de la meme porte pendant le delai : une seule pre-alarme', () => {
    attach();
    opened(clock);
    advance(1 * S);
    opened(clock);
    advance(ARMING_GRACE_MS);
    assert.equal(raised.length, 1);
    assert.equal(incidents(DOOR_A).length, 1);
  });

  it('un message annule (rollback du moteur) n\'arme aucun delai de grace', () => {
    attach();
    const failing: AccessHook = {
      onMessage: (input) => {
        access.onMessage(input);
        throw new Error('disque plein');
      },
      settle: (committed) => access.settle?.(committed),
    };
    const engine2 = createEngine(db, () => {}, () => clock, { access: failing });
    console.error = () => {};
    try {
      assert.deepEqual(engine2.ingest(DOOR_A, { event: 'door_opened', ts: clock, msgId: 'x1' }), { ok: false, status: 500, error: 'Erreur interne du journal des acces' });
    } finally {
      console.error = quiet;
    }
    advance(10 * S);
    assert.equal(status(DOOR_A), 'normal');
  });

  it('un redemarrage dans le delai de grace perd l\'ouverture (limite assumee) ; l\'ouverture suivante est jugee normalement', () => {
    attach();
    opened();
    // « Redemarrage » : nouveaux modules sur la meme base ; l'etat en attente (memoire) a disparu.
    const fresh = createDoorArming({ db, now: () => clock, isArmed: (z, at) => arming.isArmed(z, at), holders: fake, raise: (id, r) => engine2.setStateBySupervisor(id, r.state, r.event, r.detail), audit: () => {} });
    const access2 = createAccess({ db, now: () => clock, key: randomBytes(32), audit: () => {}, setDeviceState: () => true, doorArming: fresh });
    const engine2 = createEngine(db, () => {}, () => clock, { access: access2 });
    clock += 10 * S;
    access2.tick();
    assert.equal(status(DOOR_A), 'normal');
    engine2.ingest(DOOR_A, { event: 'door_opened', ts: clock, msgId: 'restart-open' });
    clock += ARMING_GRACE_MS;
    access2.tick();
    assert.equal(status(DOOR_A), 'prealarm');
  });

  it('horloge revenue en arriere : l\'ouverture en attente est jugee, jamais gardee indefiniment', () => {
    attach();
    opened();
    clock -= 3 * HOUR;
    access.tick();
    assert.equal(status(DOOR_A), 'prealarm');
  });
});

// ---- L'armement n'adoucit jamais rien ------------------------------------------------------------------------------------------

describe('l\'armement n\'adoucit jamais une alarme', () => {
  beforeEach(() => setup());

  it('porte forcee pendant l\'armement : reste une ALARME', () => {
    attach();
    engine.ingest(DOOR_A, { event: 'door_forced', ts: clock, msgId: 'f1' });
    assert.equal(status(DOOR_A), 'alarm');
    assert.equal(incidents(DOOR_A)[0].severity, 'critical');
    assert.equal(incidents(DOOR_A)[0].event, 'door_forced');
  });

  it('une pre-alarme d\'armement (passage non autorise) ne retrograde pas une alarme en cours', () => {
    attach();
    engine.ingest(DOOR_A, { event: 'door_forced', ts: clock, msgId: 'f1' });
    grant({ credential: '0000015' });
    assert.equal(status(DOOR_A), 'alarm');
    const [incident] = incidents(DOOR_A);
    assert.equal(incident.severity, 'critical');
    assert.equal(incident.event, 'door_forced', 'le motif de l\'alarme n\'est pas remplace');
    assert.equal(lastPassage().arming!.authorized, false, 'le verdict est quand meme note');
  });

  it('door_opened en attente puis porte forcee avant la fin du delai : pas de pre-alarme par-dessus l\'alarme', () => {
    attach();
    opened();
    advance(2 * S);
    engine.ingest(DOOR_A, { event: 'door_forced', ts: clock, msgId: 'f2' });
    advance(4 * S);
    assert.equal(status(DOOR_A), 'alarm');
    assert.deepEqual(raised, [], 'jamais demandee sur un detecteur en alarme');
  });

  it('pre-alarme puis porte forcee : elle s\'aggrave en alarme comme avant', () => {
    attach();
    grant({ credential: '0000015' });
    assert.equal(status(DOOR_A), 'prealarm');
    engine.ingest(DOOR_A, { event: 'door_forced', ts: clock + 1 * S, msgId: 'f3' });
    assert.equal(status(DOOR_A), 'alarm');
    assert.equal(incidents(DOOR_A)[0].severity, 'critical');
  });

  it('setStateBySupervisor ne pose jamais une pre-alarme sur une alarme (garde du moteur)', () => {
    engine.ingest(DOOR_A, { event: 'door_forced', ts: clock, msgId: 'f4' });
    assert.equal(engine.setStateBySupervisor(DOOR_A, 'prealarm', 'door_opened_armed', 'x'), true);
    assert.equal(status(DOOR_A), 'alarm');
  });

  it('detecteur « hors ligne » qui repasse en ligne par ce passage : la pre-alarme est conservee (posee APRES le signe de vie)', () => {
    attach();
    db.prepare("UPDATE device SET status = 'offline' WHERE id = ?").run(DOOR_A);
    grant({ credential: '0000015' });
    assert.equal(status(DOOR_A), 'prealarm');
    // Un passage autorise, lui, remet bien la porte en ligne (comportement d'avant).
    closed(clock);
    db.prepare("UPDATE incident SET status = 'closed', qualification = 'false_alarm', closed_at = 0, closed_by = 'x' WHERE detector_id = ?").run(DOOR_A);
    db.prepare("UPDATE device SET status = 'offline' WHERE id = ?").run(DOOR_A);
    grant({ credential: '0012345' });
    assert.equal(status(DOOR_A), 'normal');
  });

  it('l\'armement ne masque jamais la categorie « access » : porte forcee en zone desarmee = alarme, et sabotage d\'un detecteur d\'intrusion aussi', () => {
    attach();
    arming.setOverride('operateur', 'Entrepot', 'disarmed', 1);
    engine.ingest(DOOR_A, { event: 'door_forced', ts: clock, msgId: 'f5' });
    assert.equal(status(DOOR_A), 'alarm');
    engine.ingest('I-ENT', { event: 'tamper', ts: clock, msgId: 't1' });
    assert.equal(status('I-ENT'), 'alarm');
  });
});

// ---- Vues, recherche, purge ---------------------------------------------------------------------------------------------------------

describe('notes dans les vues, la recherche et la purge', () => {
  beforeEach(() => setup());

  it('door() et search() portent les notes, lues par lot (une requete, pas une par ligne)', () => {
    attach();
    for (let i = 0; i < 6; i++) {
      grant({ credential: i % 2 === 0 ? '0012345' : '0000015', ts: clock - (6 - i) * S });
      closed(clock);
      db.prepare("UPDATE incident SET status = 'closed', qualification = 'false_alarm', closed_at = 0, closed_by = 'x' WHERE detector_id = ?").run(DOOR_A);
    }
    grant({ result: 'denied', credential: '0099999' });
    notesOfCalls = 0;
    const detail = access.door(DOOR_A);
    assert.equal(notesOfCalls, 1);
    assert.equal(detail.lastPassages.length, 7);
    notesOfCalls = 0;
    const found = access.search({ limit: '50' }, 'admin');
    assert.equal(notesOfCalls, 1, 'une seule lecture pour tout le lot');
    assert.equal(found.items.length, 7);
    const labels = found.items.map((p) => p.arming?.label ?? null);
    assert.equal(labels.filter((l) => l === "Ouverture pendant l'armement : autorisée, groupe Nuit").length, 3);
    assert.equal(labels.filter((l) => l === "Ouverture pendant l'armement : non autorisée").length, 3);
    assert.equal(labels.filter((l) => l === null).length, 1, 'le refus n\'a pas de note');
    assert.equal(found.items.find((p) => p.result === 'denied')!.arming, null);
  });

  it('une recherche vide n\'interroge pas les notes', () => {
    notesOfCalls = 0;
    assert.equal(access.search({}, 'admin').items.length, 0);
    assert.equal(notesOfCalls, 0);
  });

  it('armingLabel : textes figes par le contrat', () => {
    assert.equal(armingLabel(true, 'Nuit'), "Ouverture pendant l'armement : autorisée, groupe Nuit");
    assert.equal(armingLabel(false, null), "Ouverture pendant l'armement : non autorisée");
    assert.equal(armingLabel(false, 'Nuit'), "Ouverture pendant l'armement : non autorisée");
  });

  it('la purge du journal supprime aussi les notes (cascade), y compris avec la purge par lots', () => {
    setup({ accessOverrides: { purgeBatch: 2 } });
    attach();
    const old = T0 - 100 * DAY;
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = db
        .prepare("INSERT INTO access_event (door_id, controller_id, at_device, at_received, method, result, device_event_id) VALUES (?, 'CTL-1', ?, ?, 'badge', 'granted', ?)")
        .run(DOOR_A, old + i * S, old + i * S, `raw-${i}`);
      ids.push(Number(res.lastInsertRowid));
      doorArming.judgePassage({ eventId: ids[i], doorId: DOOR_A, at: old + i * S, holderId: null });
    }
    grant({ credential: '0012345' }); // un passage recent, avec sa note
    assert.equal(noteRows().length, 6);
    const result = access.purge();
    assert.equal(result.deleted, 5);
    assert.deepEqual(noteRows().map((r) => r.event_id), [events()[0].id], 'seule la note du passage recent reste');
    assert.equal(events().length, 1);
  });
});

// ---- Flux des passages -----------------------------------------------------------------------------------------------------------

describe('PassageFeed : subscribe', () => {
  beforeEach(() => setup());

  it('notifie chaque nouveau passage APRES validation (la base et le moteur sont deja a jour), avec tous les champs du contrat', () => {
    attach();
    const seen: { note: PassageNote; rows: number; deviceStatus: string }[] = [];
    access.passages.subscribe((note) => seen.push({ note, rows: events().length, deviceStatus: status(DOOR_A) }));
    grant({ credential: '0000015', ts: clock - 2 * S });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].rows, 1, 'la ligne est deja enregistree');
    assert.equal(seen[0].deviceStatus, 'prealarm', 'la pre-alarme est deja posee');
    assert.deepEqual(seen[0].note, {
      id: 1, doorId: DOOR_A, controllerId: 'CTL-1', at: T0 - 2 * S, receivedAt: T0, direction: 'in', credential: '0000015', holderId: 15, holderRef: null,
      method: 'badge', result: 'granted', reason: null, late: false,
    });
    assert.ok(!('holderName' in seen[0].note), 'jamais de nom de titulaire dans le flux');
  });

  it('notifie aussi les refus et les passages d\'une porte non rattachee, avec le motif et le drapeau « differe »', () => {
    const seen: PassageNote[] = [];
    access.passages.subscribe((n) => seen.push(n));
    grant({ result: 'denied', credential: '0099999', deferred: true });
    assert.equal(seen.length, 1);
    assert.deepEqual([seen[0].result, seen[0].reason, seen[0].late, seen[0].holderId], ['denied', 'unknown_credential', true, null]);
  });

  it('jamais pour un doublon', () => {
    const seen: PassageNote[] = [];
    access.passages.subscribe((n) => seen.push(n));
    const msg = passageMessage({ eventId: 'dup-1' });
    assert.deepEqual(engine.ingest(DOOR_A, msg), { ok: true });
    assert.deepEqual(engine.ingest(DOOR_A, msg), { ok: true, duplicate: true }); // meme msgId
    const sansMsgId = { ...msg } as Json;
    delete sansMsgId.msgId;
    assert.deepEqual(engine.ingest(DOOR_A, sansMsgId), { ok: true, duplicate: true }); // meme evenement du controleur
    assert.equal(seen.length, 1);
  });

  it('jamais pour un passage annule (la transaction du moteur est defaite)', () => {
    const seen: PassageNote[] = [];
    access.passages.subscribe((n) => seen.push(n));
    const failing: AccessHook = {
      onMessage: (input) => {
        access.onMessage(input);
        throw new Error('disque plein');
      },
      settle: (committed) => access.settle?.(committed),
    };
    const engine2 = createEngine(db, () => {}, () => clock, { access: failing });
    console.error = () => {};
    try {
      engine2.ingest(DOOR_A, passageMessage({ eventId: 'boom' }));
    } finally {
      console.error = quiet;
    }
    assert.equal(seen.length, 0);
    assert.equal(events().length, 0, 'la ligne a ete annulee avec la transaction');
    // Le renvoi du meme passage par la passerelle (moteur sain) est annonce, lui.
    grant({ eventId: 'boom' });
    assert.equal(seen.length, 1);
  });

  it('un refus du module (message invalide) n\'annonce rien', () => {
    const seen: PassageNote[] = [];
    access.passages.subscribe((n) => seen.push(n));
    const bad = passageMessage();
    delete bad.ts;
    assert.equal(engine.ingest(DOOR_A, bad).ok, false);
    assert.equal(seen.length, 0);
  });

  it('un ecouteur qui leve n\'empeche ni les autres ecouteurs ni l\'ingestion (journalise)', () => {
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => void logged.push(args);
    const seen: PassageNote[] = [];
    try {
      access.passages.subscribe(() => {
        throw new Error('ecouteur casse');
      });
      access.passages.subscribe((n) => seen.push(n));
      assert.deepEqual(grant(), { ok: true });
    } finally {
      console.error = quiet;
    }
    assert.equal(seen.length, 1);
    assert.equal(events().length, 1);
    assert.ok(logged.some((l) => String(l[0]).includes('ecouteur de passages')), 'erreur journalisee');
    // Les passages suivants continuent d'etre annonces.
    grant();
    assert.equal(seen.length, 2);
  });

  it('desabonnement : plus aucune notification ; un ecouteur peut se desabonner pendant la diffusion', () => {
    const seen: number[] = [];
    const off = access.passages.subscribe((n) => seen.push(n.id));
    grant();
    off();
    off(); // idempotent
    grant();
    assert.deepEqual(seen, [1]);
    const order: string[] = [];
    const offA = access.passages.subscribe(() => {
      order.push('A');
      offA();
    });
    access.passages.subscribe(() => order.push('B'));
    grant();
    grant();
    assert.deepEqual(order, ['A', 'B', 'B']);
  });

  it('un ecouteur qui relit le journal (passages.history) voit le passage qui vient d\'etre annonce', () => {
    let count = -1;
    access.passages.subscribe(() => {
      count = access.passages.history(0, Number.MAX_SAFE_INTEGER).length;
    });
    grant();
    assert.equal(count, 1);
  });
});

describe('PassageFeed : history', () => {
  beforeEach(() => setup());

  const insert = (at: number, door = DOOR_A, n = 0): number =>
    Number(
      db
        .prepare("INSERT INTO access_event (door_id, controller_id, at_device, at_received, direction, credential, holder_ref, holder_id, method, result, reason, device_event_id, late) VALUES (?, 'CTL-1', ?, ?, 'out', '0012345', 'H12', 12, 'badge', 'granted', NULL, ?, 1)")
        .run(door, at, at + 100, `h-${at}-${door}-${n}`).lastInsertRowid,
    );

  it('renvoie les passages de [from, to] (bornes incluses), du plus ancien au plus recent, a egalite dans l\'ordre d\'enregistrement', () => {
    const c = insert(3000);
    const a = insert(1000);
    const b1 = insert(2000, DOOR_A, 1);
    const b2 = insert(2000, DOOR_A, 2);
    insert(500);
    insert(3001);
    const rows = access.passages.history(1000, 3000);
    assert.deepEqual(rows.map((r) => r.id), [a, b1, b2, c]);
    assert.deepEqual(rows.map((r) => r.at), [1000, 2000, 2000, 3000]);
  });

  it('porte tous les champs du contrat (heure du controleur, reception, titulaire, differe)', () => {
    const id = insert(1500);
    assert.deepEqual(access.passages.history(0, 2000)[0], {
      id, doorId: DOOR_A, controllerId: 'CTL-1', at: 1500, receivedAt: 1600, direction: 'out', credential: '0012345', holderId: 12, holderRef: 'H12',
      method: 'badge', result: 'granted', reason: null, late: true,
    });
  });

  it('filtre par portes (liste vide = aucune porte, absente = toutes), sans limite de parametres', () => {
    insert(1000, DOOR_A);
    insert(1100, DOOR_B);
    assert.deepEqual(access.passages.history(0, 2000, [DOOR_B]).map((r) => r.doorId), [DOOR_B]);
    assert.deepEqual(access.passages.history(0, 2000, [DOOR_A, DOOR_B, DOOR_A]).map((r) => r.doorId), [DOOR_A, DOOR_B]);
    assert.deepEqual(access.passages.history(0, 2000, []), []);
    assert.equal(access.passages.history(0, 2000).length, 2);
    const many = Array.from({ length: 50_000 }, (_, i) => `P-${i}`);
    assert.equal(access.passages.history(0, 2000, many).length, 0, 'ni erreur ni troncature silencieuse avec 50 000 identifiants');
    assert.deepEqual(access.passages.history(0, 2000, ['\'; DROP TABLE access_event; --']), []);
    assert.ok(events().length >= 2);
  });

  it('periode incoherente ou non numerique : liste vide', () => {
    insert(1000);
    assert.deepEqual(access.passages.history(2000, 1000), []);
    assert.deepEqual(access.passages.history(Number.NaN, 5000), []);
  });

  it('borne a 20 000 lignes (les plus anciennes d\'abord)', () => {
    db.exec('BEGIN');
    const st = db.prepare("INSERT INTO access_event (door_id, controller_id, at_device, at_received, method, result, device_event_id) VALUES ('A-01', 'CTL-1', ?, ?, 'badge', 'granted', ?)");
    for (let i = 0; i < 20_005; i++) st.run(1000 + i, 1000 + i, `bulk-${i}`);
    db.exec('COMMIT');
    const rows = access.passages.history(0, 10_000_000);
    assert.equal(rows.length, 20_000);
    assert.equal(rows[0].at, 1000);
    assert.equal(rows.at(-1)!.at, 1000 + 19_999);
  });
});

// ---- Crochet du moteur (settle, raise) --------------------------------------------------------------------------------------------

describe('crochet du moteur : settle et raise', () => {
  function stub(hook: AccessHook) {
    const d = openDb(':memory:');
    seedDemo(d, mkdtempSync(join(tmpdir(), 'psim-armdoor-')), SEED);
    return { d, e: createEngine(d, () => {}, () => T0, { access: hook }) };
  }
  const st = (d: DatabaseSync, id: string) => (d.prepare('SELECT status FROM device WHERE id = ?').get(id) as { status: string }).status;

  it('settle(true) apres un message accepte ou un doublon, settle(false) apres un refus ou une exception ; jamais d\'exception', () => {
    const calls: boolean[] = [];
    let mode: 'ok' | 'dup' | 'refuse' | 'throw' = 'ok';
    const { e } = stub({
      onMessage: () => {
        if (mode === 'throw') throw new Error('boum');
        if (mode === 'refuse') return { ok: false, status: 400, error: 'non' };
        return mode === 'dup' ? { ok: true, duplicate: true } : { ok: true };
      },
      settle: (committed) => void calls.push(committed),
    });
    console.error = () => {};
    try {
      for (mode of ['ok', 'dup', 'refuse', 'throw'] as const) e.ingest('A-01', { event: 'badge_granted', msgId: `m-${mode}` });
    } finally {
      console.error = quiet;
    }
    assert.deepEqual(calls, [true, true, false, false]);
  });

  it('un settle qui leve n\'empeche pas le message d\'etre accepte', () => {
    const { e } = stub({ onMessage: () => ({ ok: true }), settle: () => { throw new Error('ecouteur'); } });
    console.error = () => {};
    try {
      assert.deepEqual(e.ingest('A-01', { event: 'badge_granted', msgId: 'm1' }), { ok: true });
    } finally {
      console.error = quiet;
    }
  });

  it('un crochet sans settle (ancien) continue de fonctionner', () => {
    const { e } = stub({ onMessage: () => ({ ok: true }) });
    assert.deepEqual(e.ingest('A-01', { event: 'badge_granted', msgId: 'm1' }), { ok: true });
  });

  it('raise : pose une pre-alarme avec son motif et son texte, APRES le signe de vie, sans toucher last_seen une seconde fois', () => {
    const { d, e } = stub({ onMessage: () => ({ ok: true, raise: { state: 'prealarm', event: 'door_opened_armed', detail: 'Ouverture de la porte « X » à 22:14 pendant l\'armement de la zone « Y » : aucun titulaire connu' } }) });
    d.prepare("UPDATE device SET status = 'offline' WHERE id = 'A-01'").run();
    assert.deepEqual(e.ingest('A-01', { event: 'badge_granted', msgId: 'm1' }), { ok: true });
    assert.equal(st(d, 'A-01'), 'prealarm');
    const [incident] = e.getSnapshot().incidents.filter((i) => i.detectorId === 'A-01');
    assert.equal(incident.event, 'door_opened_armed');
    assert.match(incident.detail ?? '', /aucun titulaire connu/);
  });

  it('raise n\'est PAS applique si le message est refuse, ni pour un doublon, ni sur une alarme', () => {
    let verdict: ReturnType<AccessHook['onMessage']> = { ok: false, status: 400, error: 'non' };
    const raise = { state: 'prealarm', event: 'door_opened_armed', detail: 'x' } as const;
    const { d, e } = stub({ onMessage: () => verdict });
    e.ingest('A-01', { event: 'badge_granted', msgId: 'm1' });
    assert.equal(st(d, 'A-01'), 'normal');
    verdict = { ok: true, duplicate: true, raise };
    e.ingest('A-01', { event: 'badge_granted', msgId: 'm2' });
    assert.equal(st(d, 'A-01'), 'normal');
    verdict = { ok: true };
    e.ingest('A-01', { event: 'door_forced' });
    verdict = { ok: true, raise };
    e.ingest('A-01', { event: 'badge_granted', msgId: 'm3' });
    assert.equal(st(d, 'A-01'), 'alarm');
  });
});

// ---- Cas hostiles et divers --------------------------------------------------------------------------------------------------------

describe('donnees hostiles et cas limites', () => {
  beforeEach(() => setup());

  it('un nom de porte ou de zone tres long reste dans la limite du texte d\'un incident (300 caracteres)', () => {
    attach();
    const longName = 'P'.repeat(80);
    db.prepare('UPDATE device SET name = ? WHERE id = ?').run(longName, DOOR_A);
    grant({ credential: '0000015' });
    assert.ok((incidents(DOOR_A)[0].detail ?? '').length <= 300);
  });

  it('un titulaire inexistant dans le lecteur (holder_id orphelin) : non autorise', () => {
    attach();
    fake.badges.set('0000099', 99); // le badge existe, mais le titulaire 99 est inconnu du lecteur de droits
    grant({ credential: '0000099' });
    assert.equal(lastPassage().arming!.authorized, false);
    assert.match(incidents(DOOR_A)[0].detail ?? '', /titulaire H99 sans droit/);
  });

  it('plusieurs passages non autorises de suite : un seul incident, jamais un par passage', () => {
    attach();
    for (let i = 0; i < 4; i++) {
      advance(1 * S);
      grant({ credential: '0000015' });
    }
    assert.equal(incidents(DOOR_A).length, 1);
    assert.equal(noteRows().length, 4);
  });

  it('reedition d\'une note : un meme passage rejuge remplace sa note, sans doublon', () => {
    attach();
    grant({ credential: '0000015' });
    const id = events()[0].id as number;
    doorArming.judgePassage({ eventId: id, doorId: DOOR_A, at: T0, holderId: 12 });
    const rows = noteRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].authorized, 1);
  });

  it('jugement direct : porte non rattachee ou inconnue -> aucune note, aucune pre-alarme', () => {
    assert.deepEqual(doorArming.judgePassage({ eventId: 1, doorId: DOOR_A, at: T0, holderId: 12 }), { note: null, raise: null });
    assert.deepEqual(doorArming.judgePassage({ eventId: 1, doorId: 'INCONNUE', at: T0, holderId: 12 }), { note: null, raise: null });
    assert.equal(noteRows().length, 0);
  });

  it('un module d\'armement qui leve : la zone est consideree armee (dans le doute, on previent)', () => {
    const throwing = createDoorArming({ db, now: () => clock, isArmed: () => { throw new Error('boum'); }, raise: () => true, audit: () => {} });
    db.prepare("INSERT INTO access_door_arming (detector_id, enabled, updated_at, updated_by) VALUES (?, 1, 0, 'x')").run(DOOR_A);
    console.error = () => {};
    try {
      assert.equal(throwing.viewOf(DOOR_A, 'Entrepot').armedNow, true);
    } finally {
      console.error = quiet;
    }
  });

  it('bout en bout : badge_granted par engine.handleDetectorMessage -> passage note, incident ouvert, flux annonce, ecran de la porte a jour', () => {
    attach();
    const seen: PassageNote[] = [];
    access.passages.subscribe((n) => seen.push(n));
    engine.handleDetectorMessage(DOOR_A, passageMessage({ credential: '0000015' }));
    engine.handleDetectorMessage(DOOR_A, { event: 'door_opened', ts: clock + 1 * S, msgId: 'e2e-open' });
    advance(6 * S);
    // 1. le passage est dans le journal, avec sa note ; 2. un seul incident, en pre-alarme ; 3. le flux l'a annonce.
    const detail = access.door(DOOR_A);
    assert.equal(detail.lastPassages.length, 1);
    assert.equal(detail.lastPassages[0].arming!.authorized, false);
    assert.equal(detail.door.deviceStatus, 'prealarm');
    assert.equal(detail.door.arming.armedNow, true);
    assert.equal(incidents(DOOR_A).length, 1);
    assert.equal(seen.length, 1);
    // 4. le titulaire autorise, ensuite, ne change rien a l'incident en cours ; la fermeture remet la porte a la normale.
    engine.handleDetectorMessage(DOOR_A, passageMessage({ credential: '0012345' }));
    assert.equal(access.door(DOOR_A).lastPassages[0].arming!.groupName, 'Nuit');
    engine.handleDetectorMessage(DOOR_A, { event: 'door_closed', ts: clock + 1 * S, msgId: 'e2e-close' });
    assert.equal(status(DOOR_A), 'normal');
    // 5. l'operateur clot l'incident ; une audit « access_door_arming » existe pour le rattachement.
    const inc = incidents(DOOR_A)[0];
    engine.close(inc.id, 'operateur', 'false_alarm', 'essai');
    assert.equal(audits('access_door_arming').length, 1);
    assert.ok(audits('incident_opened').some((a) => a.deviceId === DOOR_A));
  });
});
