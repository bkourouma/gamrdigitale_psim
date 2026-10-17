/**
 * Controle d'acces, lot AC4 (server/accessremote.ts) : lien porte <-> actionneur et issues de secours (F17, F18), mode de porte (F19),
 * resume `remote` de la fiche, « Tout ouvrir » (F20). Moteur, module d'acces ET service des commandes REELS, base en memoire, horloge
 * injectee (aucune attente reelle). La liaison avec les passerelles est un faux (comme test/actuators.test.ts) : les ordres signes
 * qui "partent" sont recueillis sans reseau.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DatabaseSync as Db } from 'node:sqlite';
import { beforeEach, describe, it } from 'node:test';
import { createAccess } from '../server/access.ts';
import type { AccessService } from '../server/access.ts';
import { checkDoorLink, createEvacuation, migrateAccessRemote, DOOR_MODE_LABELS, doorModeFields, linkProblem, parseDoorMode, readActuatorFacts, remoteOf } from '../server/accessremote.ts';
import type { EvacuationService } from '../server/accessremote.ts';
import type { CommandMessage } from '../server/actuatorproto.ts';
import { parseAllowList } from '../server/actuatorhttp.ts';
import { createActuators } from '../server/actuators.ts';
import type { Actuators } from '../server/actuators.ts';
import { verify } from '../server/auditchain.ts';
import { createUser, isRateLimited } from '../server/auth.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import type { Engine } from '../server/engine.ts';
import { PsimError } from '../server/errors.ts';
import { readMeta } from '../server/ingestmeta.ts';
import { seedDemo } from '../server/seed.ts';
import type { DetectorState } from '../server/types.ts';

const S = 1000;
const MIN = 60 * S;
const T = Date.UTC(2026, 9, 17, 8, 0, 0);
const SEED = join(import.meta.dirname, '..', 'seed');
const PW = 'Mot-de-passe-admin-solide-1';

type Json = Record<string, unknown>;

let db: Db;
let engine: Engine;
let access: AccessService;
let actuators: Actuators;
let evacuation: EvacuationService;
let clock: number;
let key: Buffer;
let up: Set<string>;
let sent: { id: string; msg: CommandMessage; auditActions: string[] }[];
let adminSeq = 0;

/** Compte administrateur neuf (le compteur de mots de passe faux est en memoire, par compte : un essai ne doit pas gener l'autre). */
function newAdmin(): string {
  const name = `chef${++adminSeq}`;
  createUser(db, name, 'admin', PW);
  return name;
}

function status(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    if (err instanceof PsimError) return err.status;
    throw err;
  }
  return 0;
}

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof PsimError) return err.message;
    throw err;
  }
  return '';
}

const auditRows = () => db.prepare('SELECT id, actor, action, device_id, details FROM audit_log ORDER BY id').all() as { id: number; actor: string; action: string; device_id: string | null; details: string | null }[];
const audits = (action: string) => auditRows().filter((r) => r.action === action);
const commandRows = () => db.prepare('SELECT * FROM actuator_command ORDER BY rowid').all() as Json[];

/** Moteur + acces + commandes cables comme main.ts. Detecteurs d'acces A-01 a A-04, controleur CTL-1. */
function setup(): void {
  db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-accessremote-')), SEED);
  clock = T;
  key = randomBytes(32);
  up = new Set();
  sent = [];
  access = createAccess({
    db,
    now: () => clock,
    key,
    audit: (actor, action, ref) => engine.audit(actor, action, ref),
    setDeviceState: (id, state, event) => engine.setStateBySupervisor(id, state, event),
  });
  engine = createEngine(db, () => {}, () => clock, { access });
  for (const id of ['A-02', 'A-03', 'A-04']) engine.createDevice('admin', { id, kind: 'detector', name: `Porte ${id}`, zone: 'Entrepot', category: 'access' });
  access.createController('admin', { id: 'CTL-1', name: 'Controleur entree', brand: 'dahua' });
  actuators = createActuators({ db, key, audit: (a, b, c) => engine.audit(a, b, c), publish: () => {}, httpAllow: parseAllowList(['127.0.0.1']), now: () => clock });
  actuators.attachMqtt({
    listeners: (id) => (up.has(id) ? 1 : 0),
    publishCommand: async (id, payload) => {
      sent.push({ id, msg: JSON.parse(payload.toString()) as CommandMessage, auditActions: auditRows().map((r) => r.action) });
    },
  });
  evacuation = createEvacuation({ db, actuators, audit: (a, b, c) => engine.audit(a, b, c), now: () => clock });
}

/** Cree un actionneur (administrateur) ; `listening` : une passerelle ecoute ses ordres. Renvoie sa cle (montree une fois). */
function actuator(id: string, type: 'lock' | 'gate' | 'siren', extra: Json = {}, listening = true): string {
  const made = actuators.create('admin', { id, name: `Actionneur ${id}`, type, transport: 'mqtt', ...extra });
  if (listening) up.add(id);
  return made.key;
}

const declare = (detectorId: string, doorNo: number, extra: Json = {}) => access.declareDoor('admin', { detectorId, controllerId: 'CTL-1', doorNo, ...extra });
const door = (id: string) => access.doors().find((d) => d.detectorId === id)!;
const doorRow = (id: string) => db.prepare('SELECT * FROM access_door WHERE detector_id = ?').get(id) as Json;

// ---------------------------------------------------------------------------------------------------------------------------------
describe('lien porte <-> actionneur (F17) et issues de secours (F18) : validation a l\'ecriture', () => {
  beforeEach(setup);

  it('declarer une porte liee a un actionneur de type coherent : acceptee, visible dans la vue', () => {
    actuator('LOCK-1', 'lock');
    const d = declare('A-01', 1, { actuatorId: 'LOCK-1' });
    assert.equal(d.actuatorId, 'LOCK-1');
    assert.equal(door('A-01').actuatorId, 'LOCK-1');
  });

  it('actionneur inconnu : 400, rien n\'est cree', () => {
    assert.equal(status(() => declare('A-01', 1, { actuatorId: 'FANTOME' })), 400);
    assert.equal(doorRow('A-01'), undefined);
    actuator('LOCK-1', 'lock');
    declare('A-01', 1);
    assert.equal(status(() => access.updateDoor('admin', 'A-01', { actuatorId: 'FANTOME' })), 400);
    assert.equal(doorRow('A-01').actuator_id, null);
  });

  it('identifiant d\'actionneur de forme invalide ou hostile : 400', () => {
    for (const bad of ['', 'a b', "x'; DROP TABLE actuator;--", 'a'.repeat(33), 12, true, {}, ['LOCK-1'], '__proto__']) {
      assert.equal(status(() => declare('A-01', 1, { actuatorId: bad })), 400, JSON.stringify(bad));
    }
    assert.equal(doorRow('A-01'), undefined);
  });

  it('type : porte -> serrure ; portail, barriere, tourniquet -> portail ; l\'autre combinaison est refusee (400)', () => {
    actuator('LOCK-1', 'lock');
    actuator('GATE-1', 'gate');
    actuator('SIR-1', 'siren');
    assert.equal(status(() => declare('A-01', 1, { kind: 'door', actuatorId: 'GATE-1' })), 400);
    assert.equal(status(() => declare('A-01', 1, { kind: 'gate', actuatorId: 'LOCK-1' })), 400);
    assert.equal(status(() => declare('A-01', 1, { kind: 'barrier', actuatorId: 'LOCK-1' })), 400);
    assert.equal(status(() => declare('A-01', 1, { kind: 'turnstile', actuatorId: 'LOCK-1' })), 400);
    assert.equal(status(() => declare('A-01', 1, { actuatorId: 'SIR-1' })), 400, 'une sirene n\'ouvre pas une porte');
    assert.equal(status(() => declare('A-01', 1, { kind: 'gate', actuatorId: 'SIR-1' })), 400);
    assert.match(message(() => declare('A-01', 1, { kind: 'door', actuatorId: 'GATE-1' })), /incoherent/);
    declare('A-01', 1, { kind: 'door', actuatorId: 'LOCK-1' });
    actuator('GATE-2', 'gate');
    actuator('GATE-3', 'gate');
    declare('A-02', 2, { kind: 'gate', actuatorId: 'GATE-1' });
    declare('A-03', 3, { kind: 'barrier', actuatorId: 'GATE-2' });
    declare('A-04', 4, { kind: 'turnstile', actuatorId: 'GATE-3' });
    assert.deepEqual(access.doors().map((d) => d.actuatorId), ['GATE-1', 'GATE-2', 'GATE-3', 'LOCK-1'], 'ordre des noms de porte');
  });

  it('un actionneur ne sert qu\'une seule porte (409), a la declaration comme a la modification', () => {
    actuator('LOCK-1', 'lock');
    declare('A-01', 1, { actuatorId: 'LOCK-1' });
    assert.equal(status(() => declare('A-02', 2, { actuatorId: 'LOCK-1' })), 409);
    assert.equal(doorRow('A-02'), undefined);
    declare('A-02', 2);
    assert.equal(status(() => access.updateDoor('admin', 'A-02', { actuatorId: 'LOCK-1' })), 409);
    assert.match(message(() => access.updateDoor('admin', 'A-02', { actuatorId: 'LOCK-1' })), /A-01/);
    assert.equal(doorRow('A-02').actuator_id, null);
  });

  it('renvoyer le lien deja en place n\'est pas un doublon ; delier libere l\'actionneur pour une autre porte', () => {
    actuator('LOCK-1', 'lock');
    declare('A-01', 1, { actuatorId: 'LOCK-1' });
    declare('A-02', 2);
    assert.equal(access.updateDoor('admin', 'A-01', { actuatorId: 'LOCK-1', heldAlarmAfterS: 60 }).actuatorId, 'LOCK-1');
    assert.equal(access.updateDoor('admin', 'A-01', { actuatorId: null }).actuatorId, null);
    assert.equal(access.updateDoor('admin', 'A-02', { actuatorId: 'LOCK-1' }).actuatorId, 'LOCK-1');
    assert.equal(access.door('A-01').remote.available, false);
    assert.match(access.door('A-01').remote.reason ?? '', /Aucun actionneur/);
  });

  it('F18 : issue de secours = les deux ou aucun, dans les deux sens (400)', () => {
    actuator('ISSUE-1', 'lock', { emergencyExit: true });
    actuator('LOCK-1', 'lock');
    // La porte l'est, pas l'actionneur.
    assert.equal(status(() => declare('A-01', 1, { emergencyExit: true, actuatorId: 'LOCK-1' })), 400);
    assert.match(message(() => declare('A-01', 1, { emergencyExit: true, actuatorId: 'LOCK-1' })), /Issue de secours/);
    // L'actionneur l'est, pas la porte.
    assert.equal(status(() => declare('A-01', 1, { actuatorId: 'ISSUE-1' })), 400);
    assert.equal(status(() => declare('A-01', 1, { emergencyExit: false, actuatorId: 'ISSUE-1' })), 400);
    assert.match(message(() => declare('A-01', 1, { actuatorId: 'ISSUE-1' })), /Issue de secours/);
    assert.equal(doorRow('A-01'), undefined);
    // Les deux, ou aucun : acceptes.
    assert.equal(declare('A-01', 1, { emergencyExit: true, actuatorId: 'ISSUE-1' }).emergencyExit, true);
    assert.equal(declare('A-02', 2, { actuatorId: 'LOCK-1' }).emergencyExit, false);
  });

  it('revalidation au changement de type ou d\'issue de secours d\'une porte DEJA liee (etat resultant)', () => {
    actuator('LOCK-1', 'lock');
    actuator('GATE-1', 'gate');
    actuator('ISSUE-1', 'lock', { emergencyExit: true });
    declare('A-01', 1, { actuatorId: 'LOCK-1' });
    declare('A-02', 2, { emergencyExit: true, actuatorId: 'ISSUE-1' });
    // Porte normale devenant issue de secours sans que l'actionneur le soit.
    assert.equal(status(() => access.updateDoor('admin', 'A-01', { emergencyExit: true })), 400);
    assert.equal(doorRow('A-01').emergency_exit, 0);
    // Issue de secours qui cesse de l'etre alors que son actionneur l'est.
    assert.equal(status(() => access.updateDoor('admin', 'A-02', { emergencyExit: false })), 400);
    assert.equal(doorRow('A-02').emergency_exit, 1);
    // Type de porte qui ne correspond plus a l'actionneur lie.
    assert.equal(status(() => access.updateDoor('admin', 'A-01', { kind: 'gate' })), 400);
    assert.equal(status(() => access.updateDoor('admin', 'A-01', { kind: 'barrier' })), 400);
    assert.equal(doorRow('A-01').kind, 'door');
    // Changement ENSEMBLE du type et du lien : l'etat resultant est coherent.
    assert.equal(access.updateDoor('admin', 'A-01', { kind: 'gate', actuatorId: 'GATE-1' }).kind, 'gate');
    // Delier puis changer le type : plus rien a verifier.
    access.updateDoor('admin', 'A-02', { actuatorId: null });
    assert.equal(access.updateDoor('admin', 'A-02', { emergencyExit: false }).emergencyExit, false);
  });

  it('une modification qui ne touche ni le type, ni l\'issue de secours, ni le lien n\'est pas bloquee par un ancien lien incoherent', () => {
    actuator('LOCK-1', 'lock');
    declare('A-01', 1, { actuatorId: 'LOCK-1' });
    db.prepare("UPDATE actuator SET emergency_exit = 1 WHERE id = 'LOCK-1'").run(); // l'actionneur a change depuis (base d'avant ce controle)
    assert.equal(access.updateDoor('admin', 'A-01', { heldAlarmAfterS: 90 }).heldAlarmAfterS, 90);
    assert.equal(access.updateDoor('admin', 'A-01', { kind: 'door', emergencyExit: false, actuatorId: 'LOCK-1', heldAlarmAfterS: 95 }).heldAlarmAfterS, 95, 'meme valeurs renvoyees par un formulaire');
    // En revanche la corriger passe par un etat coherent.
    assert.equal(status(() => access.updateDoor('admin', 'A-01', { kind: 'door', emergencyExit: false, actuatorId: 'LOCK-1', doorNo: 2 })), 0);
    assert.equal(status(() => access.updateDoor('admin', 'A-01', { emergencyExit: true })), 0, 'devient coherent avec l\'actionneur');
  });

  it('un index unique protege aussi la base contre deux portes sur le meme actionneur', () => {
    actuator('LOCK-1', 'lock');
    declare('A-01', 1, { actuatorId: 'LOCK-1' });
    declare('A-02', 2);
    assert.throws(() => db.prepare("UPDATE access_door SET actuator_id = 'LOCK-1' WHERE detector_id = 'A-02'").run());
    // Plusieurs portes sans actionneur : permis.
    declare('A-03', 3);
    assert.equal(doorRow('A-03').actuator_id, null);
  });

  it('un lien deja double dans une base ancienne n\'empeche pas le demarrage (index non cree, avertissement)', () => {
    const legacy = new DatabaseSync(':memory:');
    legacy.exec('CREATE TABLE device (id TEXT PRIMARY KEY); CREATE TABLE access_controller (id TEXT PRIMARY KEY);');
    legacy.exec(`CREATE TABLE access_door (detector_id TEXT PRIMARY KEY, controller_id TEXT, door_no INTEGER, kind TEXT, emergency_exit INTEGER, held_alarm_after_s INTEGER, actuator_id TEXT);
                 INSERT INTO access_door VALUES ('P1', 'C', 1, 'door', 0, 300, 'X'), ('P2', 'C', 2, 'door', 0, 300, 'X');`);
    // La migration (appelee par migrateAccess a chaque ouverture) ne doit pas lever meme si l'index unique est impossible.
    const seen: string[] = [];
    const noisy = console.error;
    console.error = (...args: unknown[]) => void seen.push(args.join(' '));
    try {
      assert.doesNotThrow(() => migrateAccessRemote(legacy));
      assert.doesNotThrow(() => migrateAccessRemote(legacy), 'idempotente');
      assert.ok(seen.some((m) => /index/.test(m)), 'avertissement ecrit');
      assert.equal(legacy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'access_door_by_actuator'").get()!.n, 0);
      assert.equal(legacy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'access_door_mode'").get()!.n, 1, 'la table du mode existe quand meme');
    } finally {
      console.error = noisy;
      legacy.close();
    }
  });

  it('le journal garde la trace du lien a la declaration', () => {
    actuator('LOCK-1', 'lock');
    declare('A-01', 1, { actuatorId: 'LOCK-1' });
    assert.match(audits('access_door_declared')[0].details ?? '', /actionneur LOCK-1/);
  });

  it('base sans table `actuator` (essai qui n\'a migre que l\'acces) : aucun lien possible, aucune erreur', () => {
    const bare = new DatabaseSync(':memory:');
    try {
      assert.equal(readActuatorFacts(bare, 'LOCK-1'), null);
      assert.equal(status(() => checkDoorLink(bare, { detectorId: 'A-01', kind: 'door', emergencyExit: false, actuatorId: 'LOCK-1' })), 400);
      assert.equal(status(() => checkDoorLink(bare, { detectorId: 'A-01', kind: 'door', emergencyExit: false, actuatorId: null })), 0);
      const r = remoteOf(bare, { kind: 'door', emergencyExit: false, actuatorId: 'LOCK-1' });
      assert.equal(r.available, false);
      assert.match(r.reason ?? '', /n'existe plus/);
    } finally {
      bare.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('fiche de porte : `remote` (F17)', () => {
  beforeEach(setup);

  it('aucun actionneur lie', () => {
    declare('A-01', 1);
    assert.deepEqual(access.door('A-01').remote, { available: false, reason: "Aucun actionneur n'est lié à cette porte", actuatorId: null, actuatorName: null, actuatorType: null });
  });

  it('lien valide : disponible, avec le nom et le type de l\'actionneur (serrure puis portail)', () => {
    actuator('LOCK-1', 'lock');
    actuator('GATE-1', 'gate');
    declare('A-01', 1, { actuatorId: 'LOCK-1' });
    declare('A-02', 2, { kind: 'gate', actuatorId: 'GATE-1' });
    assert.deepEqual(access.door('A-01').remote, { available: true, reason: null, actuatorId: 'LOCK-1', actuatorName: 'Actionneur LOCK-1', actuatorType: 'lock' });
    assert.deepEqual(access.door('A-02').remote, { available: true, reason: null, actuatorId: 'GATE-1', actuatorName: 'Actionneur GATE-1', actuatorType: 'gate' });
  });

  it('l\'actionneur lie a ete supprime : "n\'existe plus", l\'identifiant lie reste visible', () => {
    actuator('LOCK-1', 'lock');
    declare('A-01', 1, { actuatorId: 'LOCK-1' });
    actuators.remove('admin', 'LOCK-1');
    assert.deepEqual(access.door('A-01').remote, { available: false, reason: "L'actionneur lié n'existe plus", actuatorId: 'LOCK-1', actuatorName: null, actuatorType: null });
  });

  it('actionneur desactive : non disponible, la raison nomme l\'actionneur ; reactive : disponible', () => {
    actuator('LOCK-1', 'lock');
    declare('A-01', 1, { actuatorId: 'LOCK-1' });
    actuators.update('admin', 'LOCK-1', { active: false });
    const r = access.door('A-01').remote;
    assert.equal(r.available, false);
    assert.match(r.reason ?? '', /désactivé/);
    assert.match(r.reason ?? '', /Actionneur LOCK-1/);
    assert.equal(r.actuatorName, 'Actionneur LOCK-1');
    assert.equal(r.actuatorType, 'lock');
    actuators.update('admin', 'LOCK-1', { active: true });
    assert.equal(access.door('A-01').remote.available, true);
  });

  it('incoherence de type (base modifiee apres coup) : non disponible, phrase claire ; le type inconnu ne sort jamais en `actuatorType`', () => {
    actuator('LOCK-1', 'lock');
    declare('A-01', 1, { actuatorId: 'LOCK-1' });
    db.prepare("UPDATE access_door SET kind = 'gate' WHERE detector_id = 'A-01'").run();
    let r = access.door('A-01').remote;
    assert.equal(r.available, false);
    assert.match(r.reason ?? '', /Incohérence/);
    assert.match(r.reason ?? '', /portail/);
    assert.equal(r.actuatorType, 'lock');
    // Lien vers une sirene (impossible par l'API) : indisponible, type non expose.
    actuator('SIR-1', 'siren');
    db.prepare("UPDATE access_door SET kind = 'door', actuator_id = 'SIR-1' WHERE detector_id = 'A-01'").run();
    r = access.door('A-01').remote;
    assert.equal(r.available, false);
    assert.match(r.reason ?? '', /sirène/);
    assert.equal(r.actuatorType, null);
    // Type de porte inconnu (donnee corrompue) : indisponible, sans exception.
    assert.equal(remoteOf(db, { kind: 'zzz', emergencyExit: false, actuatorId: 'SIR-1' }).available, false);
  });

  it('issue de secours d\'un seul cote, dans les deux sens', () => {
    actuator('LOCK-1', 'lock');
    declare('A-01', 1, { actuatorId: 'LOCK-1' });
    db.prepare("UPDATE access_door SET emergency_exit = 1 WHERE detector_id = 'A-01'").run();
    let r = access.door('A-01').remote;
    assert.equal(r.available, false);
    assert.match(r.reason ?? '', /issue de secours d'un seul côté/);
    assert.match(r.reason ?? '', /la porte en est une/);
    db.prepare("UPDATE access_door SET emergency_exit = 0 WHERE detector_id = 'A-01'").run();
    db.prepare("UPDATE actuator SET emergency_exit = 1 WHERE id = 'LOCK-1'").run();
    r = access.door('A-01').remote;
    assert.equal(r.available, false);
    assert.match(r.reason ?? '', /issue de secours d'un seul côté/);
    assert.match(r.reason ?? '', /l'actionneur lié en est une/);
  });

  it('linkProblem : ordre des constats (aucun, absent, desactive, type, issue de secours)', () => {
    const facts = { id: 'X', name: 'X', type: 'lock', emergencyExit: false, active: true };
    const link = { kind: 'door', emergencyExit: false, actuatorId: 'X' };
    assert.equal(linkProblem(link, facts), null);
    assert.match(linkProblem({ ...link, actuatorId: null }, null) ?? '', /Aucun actionneur/);
    assert.match(linkProblem(link, null) ?? '', /n'existe plus/);
    assert.match(linkProblem(link, { ...facts, active: false, type: 'gate' }) ?? '', /désactivé/);
    assert.match(linkProblem(link, { ...facts, type: 'gate', emergencyExit: true }) ?? '', /Incohérence : cette porte est une porte/);
  });

  it('une fiche de porte de la base d\'origine (aucune porte liee) ne leve jamais ; porte inconnue : 404', () => {
    declare('A-01', 1);
    assert.doesNotThrow(() => access.door('A-01'));
    assert.equal(status(() => access.door('INCONNUE')), 404);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('issue de secours : le PSIM ne verrouille jamais (refus a l\'execution, F18)', () => {
  beforeEach(setup);

  it('configuration honnete : « lock » n\'existe pas pour une issue de secours (400), rien n\'est cree ni envoye', () => {
    actuator('ISSUE-1', 'lock', { emergencyExit: true });
    const user = { username: newAdmin(), role: 'admin' as const };
    const err = (() => {
      try {
        actuators.request(user, 'ISSUE-1', { action: 'lock', confirm: true, reason: 'x', password: PW });
      } catch (e) {
        return e as PsimError;
      }
      return null;
    })();
    assert.ok(err instanceof PsimError);
    assert.ok([400, 403].includes(err.status), `refus attendu, recu ${err.status}`);
    assert.equal(commandRows().length, 0);
    assert.equal(sent.length, 0);
  });

  it('configuration falsifiee en base (action « lock » ajoutee a la main) : 403, aucune commande, aucun envoi', () => {
    actuator('ISSUE-1', 'lock', { emergencyExit: true });
    db.prepare("UPDATE actuator SET actions = ? WHERE id = 'ISSUE-1'").run(JSON.stringify({ unlock: { minS: 1, maxS: 10, roles: ['operator', 'admin'] }, lock: { roles: ['operator', 'admin'] } }));
    const user = { username: newAdmin(), role: 'admin' as const };
    assert.equal(status(() => actuators.request(user, 'ISSUE-1', { action: 'lock', confirm: true, reason: 'x', password: PW })), 403);
    assert.equal(commandRows().length, 0);
    assert.equal(sent.length, 0);
    // Meme sans raison ni mot de passe : le refus ne depend pas d'eux.
    assert.equal(status(() => actuators.request(user, 'ISSUE-1', { action: 'lock', confirm: true })), 403);
  });

  it('issue de secours : aucune action sure n\'est exposee (jamais « lock »), seul le deverrouillage est possible', () => {
    actuator('ISSUE-1', 'lock', { emergencyExit: true });
    const v = actuators.get('ISSUE-1')!;
    assert.equal(v.safeAction, null);
    assert.deepEqual(Object.keys(v.actions), ['unlock']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('mode de porte (F19) : crochet `access.onMessage`', () => {
  beforeEach(() => {
    setup();
    declare('A-01', 1);
    declare('A-02', 2);
  });

  const hook = (id: string, payload: Json, event: string | null = 'door_mode', state: DetectorState | null = null) => {
    const read = readMeta(payload, clock);
    if (!read.ok) throw new Error(read.error);
    return access.onMessage({ device: engine.getDevice(id)!, payload, event, state, meta: read.meta });
  };
  const modeRow = (id: string) => db.prepare('SELECT * FROM access_door_mode WHERE detector_id = ?').get(id) as Json | undefined;

  it('aucun message : doorMode, libelle et date sont null', () => {
    assert.deepEqual(
      { m: door('A-01').doorMode, l: door('A-01').doorModeLabel, a: door('A-01').doorModeAt },
      { m: null, l: null, a: null },
    );
  });

  it('les trois modes sont retenus avec leur libelle et l\'heure du message', () => {
    const labels: Record<string, string> = {
      normal: 'Mode normal : les badges fonctionnent',
      always_open: 'Ouverte en permanence (réglée dans le contrôleur)',
      always_closed: 'Verrouillée en permanence (réglée dans le contrôleur)',
    };
    let ts = clock - 60 * S;
    for (const mode of ['always_open', 'always_closed', 'normal']) {
      ts += 10 * S;
      assert.deepEqual(hook('A-01', { event: 'door_mode', doorMode: mode, ts }), { ok: true });
      const d = door('A-01');
      assert.equal(d.doorMode, mode);
      assert.equal(d.doorModeLabel, labels[mode]);
      assert.equal(d.doorModeAt, ts);
      assert.equal(access.door('A-01').door.doorMode, mode);
    }
    assert.deepEqual({ ...DOOR_MODE_LABELS }, labels);
    assert.equal(door('A-02').doorMode, null, 'l\'autre porte n\'est pas touchee');
  });

  it('`doorMode` est lu quel que soit `event` (event: null avec un etat, ou autre evenement)', () => {
    hook('A-01', { state: 'normal', doorMode: 'always_open', ts: clock - 5 * S }, null, 'normal');
    assert.equal(door('A-01').doorMode, 'always_open');
    hook('A-01', { event: 'door_closed', doorMode: 'always_closed', ts: clock - 4 * S }, 'door_closed');
    assert.equal(door('A-01').doorMode, 'always_closed');
    assert.equal(door('A-01').doorState, 'closed');
  });

  it('un message plus ancien (ts) n\'ecrase pas un plus recent ; a date egale, le dernier arrive gagne ; un plus recent l\'emporte', () => {
    const t = clock - 30 * S;
    hook('A-01', { event: 'door_mode', doorMode: 'always_open', ts: t });
    hook('A-01', { event: 'door_mode', doorMode: 'always_closed', ts: t - 1 });
    assert.equal(door('A-01').doorMode, 'always_open');
    assert.equal(door('A-01').doorModeAt, t);
    hook('A-01', { event: 'door_mode', doorMode: 'normal', ts: t });
    assert.equal(door('A-01').doorMode, 'normal');
    hook('A-01', { event: 'door_mode', doorMode: 'always_closed', ts: t + 1 });
    assert.equal(door('A-01').doorMode, 'always_closed');
    assert.equal(door('A-01').doorModeAt, t + 1);
  });

  it('un message sans ts compte comme « maintenant »', () => {
    hook('A-01', { event: 'door_mode', doorMode: 'always_open', ts: clock - 60 * S });
    hook('A-01', { event: 'door_mode', doorMode: 'always_closed' });
    assert.equal(door('A-01').doorMode, 'always_closed');
    assert.equal(door('A-01').doorModeAt, clock);
  });

  it('valeur invalide : ignoree (le mode precedent est conserve), sans erreur', () => {
    hook('A-01', { event: 'door_mode', doorMode: 'always_open', ts: clock - 20 * S });
    for (const bad of ['open', 'ALWAYS_OPEN', ' normal', '', 'constructor', '__proto__', 'toString', 5, true, null, {}, ['normal'], 'normal\u0000']) {
      assert.deepEqual(hook('A-01', { event: 'door_mode', doorMode: bad, ts: clock - 10 * S }), { ok: true }, JSON.stringify(bad));
    }
    assert.equal(door('A-01').doorMode, 'always_open');
    assert.equal(door('A-01').doorModeAt, clock - 20 * S);
    // Jamais de mode retenu pour une porte sans message valide.
    hook('A-02', { event: 'door_mode', doorMode: 'bizarre', ts: clock - 10 * S });
    assert.equal(modeRow('A-02'), undefined);
    // Message sans champ doorMode : rien ne change non plus.
    hook('A-01', { event: 'door_mode', ts: clock - 5 * S });
    assert.equal(door('A-01').doorMode, 'always_open');
  });

  it('porte non declaree : message accepte, rien n\'est retenu', () => {
    // A-03 est un detecteur d'acces mais n'a pas ete declare comme porte.
    assert.deepEqual(hook('A-03', { event: 'door_mode', doorMode: 'always_open', ts: clock - 5 * S }), { ok: true });
    assert.equal(modeRow('A-03'), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM access_door_mode').get()!.n, 0);
  });

  it('detecteur qui n\'est pas de categorie acces : le champ est ignore, jamais refuse, jamais retenu', () => {
    assert.deepEqual(hook('D-01', { event: 'door_mode', doorMode: 'always_open', ts: clock - 5 * S }), { ok: true });
    assert.equal(modeRow('D-01'), undefined);
    // Un champ `access` sur ce meme detecteur reste refuse (comportement d'avant).
    assert.equal((hook('D-01', { event: 'door_mode', doorMode: 'always_open', access: { v: 1 } }) as { ok: boolean }).ok, false);
  });

  it('un signe de vie `door_mode` ne change PAS l\'etat physique de la porte (ouverte reste ouverte, fermee reste fermee)', () => {
    hook('A-01', { event: 'door_opened', ts: clock - 20 * S }, 'door_opened');
    assert.equal(door('A-01').doorState, 'open');
    hook('A-01', { event: 'door_mode', doorMode: 'always_open', ts: clock - 10 * S });
    assert.equal(door('A-01').doorState, 'open');
    hook('A-01', { event: 'door_closed', ts: clock - 8 * S }, 'door_closed');
    hook('A-01', { event: 'door_mode', doorMode: 'normal', ts: clock - 5 * S });
    assert.equal(door('A-01').doorState, 'closed');
    assert.equal(door('A-01').doorMode, 'normal');
  });

  it('porte hors ligne : le signe de vie ne devine pas « fermee » (etat inconnu), le dernier mode connu est conserve', () => {
    hook('A-01', { event: 'door_closed', ts: clock - 20 * S }, 'door_closed');
    hook('A-01', { event: 'door_mode', doorMode: 'always_closed', ts: clock - 15 * S });
    db.prepare("UPDATE device SET status = 'offline' WHERE id = 'A-01'").run();
    assert.equal(door('A-01').doorMode, 'always_closed', 'le mode survit a la coupure');
    hook('A-01', { event: 'door_mode', doorMode: 'always_closed', ts: clock - 5 * S });
    assert.equal(door('A-01').doorState, 'unknown');
  });

  it('seul un CHANGEMENT de mode est journalise (entree infalsifiable, auteur systeme) ; un message identique ne l\'est pas', () => {
    hook('A-01', { event: 'door_mode', doorMode: 'always_open', ts: clock - 30 * S });
    hook('A-01', { event: 'door_mode', doorMode: 'always_open', ts: clock - 20 * S });
    hook('A-01', { event: 'door_mode', doorMode: 'always_closed', ts: clock - 10 * S });
    hook('A-01', { event: 'door_mode', doorMode: 'normal', ts: clock - 40 * S }); // ancien : ignore, pas de journal
    const rows = audits('access_door_mode');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].actor, 'systeme');
    assert.equal(rows[0].device_id, 'A-01');
    assert.match(rows[0].details ?? '', /inconnu -> always_open/);
    assert.match(rows[1].details ?? '', /always_open -> always_closed/);
    assert.equal(verify(db).ok, true);
  });

  it('retirer la porte oublie son mode : redeclaree, elle repart sans mode', () => {
    hook('A-01', { event: 'door_mode', doorMode: 'always_open', ts: clock - 10 * S });
    access.removeDoor('admin', 'A-01');
    assert.equal(modeRow('A-01'), undefined);
    declare('A-01', 1);
    assert.equal(door('A-01').doorMode, null);
    // Un detecteur supprime emporte aussi son mode (cle etrangere en cascade).
    hook('A-02', { event: 'door_mode', doorMode: 'always_open', ts: clock - 5 * S });
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare("DELETE FROM device WHERE id = 'A-02'").run();
    assert.equal(modeRow('A-02'), undefined);
  });

  it('moteur reel : un etat accompagne de doorMode traverse le moteur ; l\'evenement `door_mode` depend de sources.ts', () => {
    const ok = engine.ingest('A-01', { state: 'normal', doorMode: 'always_open', ts: clock - 5 * S });
    assert.deepEqual(ok, { ok: true });
    assert.equal(door('A-01').doorMode, 'always_open');
    const res = engine.ingest('A-01', { event: 'door_mode', doorMode: 'always_closed', ts: clock - 2 * S });
    if (res.ok) {
      // sources.ts connait `door_mode` (branche fusionnee) : le mode est pris en compte, la porte garde son etat physique.
      assert.equal(door('A-01').doorMode, 'always_closed');
    } else {
      // Etat d'aujourd'hui : le moteur rejette l'evenement inconnu AVANT le crochet. Ne pas contourner : voir le compte rendu.
      assert.equal(res.status, 400);
      assert.match(res.error, /event inconnu/);
      assert.equal(door('A-01').doorMode, 'always_open');
    }
  });

  it('parseDoorMode et doorModeFields : valeurs hostiles', () => {
    assert.equal(parseDoorMode('normal'), 'normal');
    assert.equal(parseDoorMode('hasOwnProperty'), null);
    assert.deepEqual(doorModeFields('always_open', 'pas un nombre'), { doorMode: null, doorModeLabel: null, doorModeAt: null });
    assert.deepEqual(doorModeFields('zzz', 5), { doorMode: null, doorModeLabel: null, doorModeAt: null });
    assert.equal(doorModeFields('normal', 5).doorModeAt, 5);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('« Tout ouvrir » (F20)', () => {
  let admin: string;
  const body = (over: Json = {}): Json => ({ reason: 'Evacuation incendie', password: PW, confirm: true, confirmPhrase: 'TOUT OUVRIR', ...over });

  /**
   * A-01 -> LOCK-1 (passerelle a l'ecoute) ; A-02 -> LOCK-2 (aucune passerelle) ; A-03 -> LOCK-3 (actionneur desactive) ;
   * A-04 -> GATE-1 (barriere, passerelle a l'ecoute). Une porte non liee (D-ex) ne figure jamais dans la liste.
   */
  function fourDoors(): Record<string, string> {
    const keys: Record<string, string> = {};
    keys.lock1 = actuator('LOCK-1', 'lock');
    keys.lock2 = actuator('LOCK-2', 'lock', {}, false);
    keys.lock3 = actuator('LOCK-3', 'lock');
    keys.gate1 = actuator('GATE-1', 'gate');
    declare('A-01', 1, { actuatorId: 'LOCK-1' });
    declare('A-02', 2, { actuatorId: 'LOCK-2' });
    declare('A-03', 3, { actuatorId: 'LOCK-3' });
    declare('A-04', 4, { kind: 'barrier', actuatorId: 'GATE-1' });
    actuators.update('admin', 'LOCK-3', { active: false });
    return keys;
  }

  beforeEach(() => {
    setup();
    admin = newAdmin();
  });

  it('succes : resultats mixtes porte par porte (envoyee, sans passerelle, actionneur inactif, barriere)', () => {
    fourDoors();
    const res = evacuation.run(admin, body());
    assert.match(res.batchId, /^[0-9a-f]{16}$/);
    assert.equal(res.at, clock);
    assert.deepEqual(res.counts, { total: 4, sent: 2, failed: 2 });
    const by = Object.fromEntries(res.results.map((r) => [r.doorId, r]));
    assert.equal(by['A-01'].status, 'sent');
    assert.match(by['A-01'].cmdId ?? '', /^[0-9a-f]{32}$/);
    assert.equal(by['A-01'].actuatorId, 'LOCK-1');
    assert.equal(by['A-01'].doorName, 'Porte de service entrepot');
    assert.equal(by['A-02'].status, 'no_gateway');
    assert.match(by['A-02'].error ?? '', /passerelle/);
    assert.equal(by['A-02'].cmdId, undefined);
    assert.equal(by['A-03'].status, 'refused');
    assert.match(by['A-03'].error ?? '', /désactivé/);
    assert.equal(by['A-04'].status, 'sent');
    // Les ordres partis : « unlock » pour la serrure, « open » pour la barriere, durees reelles rapportees.
    assert.deepEqual(sent.map((s) => [s.id, s.msg.action]).sort(), [['GATE-1', 'open'], ['LOCK-1', 'unlock']]);
    assert.equal(commandRows().length, 2, 'aucune commande pour les portes refusees');
    assert.equal(by['A-01'].durationS, 10, 'duree demandee 300 s ramenee au maximum de la serrure (10 s)');
    assert.equal(by['A-04'].durationS, 10);
    assert.equal(sent.find((s) => s.id === 'LOCK-1')!.msg.params.durationS, 10);
    // L'ordre dans la reponse suit les noms de porte.
    assert.deepEqual(res.results.map((r) => r.doorId), ['A-02', 'A-03', 'A-04', 'A-01']);
  });

  it('les commandes portent la raison et le lot, sont a la charge de l\'administrateur, avec ses garde-fous (journal AVANT l\'envoi)', () => {
    fourDoors();
    const res = evacuation.run(admin, body({ reason: '  Exercice\nd\'evacuation  ' }));
    const short = res.batchId.slice(0, 8);
    const history = actuators.history('LOCK-1');
    assert.equal(history.length, 1);
    assert.equal(history[0].requestedBy, admin);
    assert.equal(history[0].reason, `Tout ouvrir (lot ${short}) : Exercice d'evacuation`);
    assert.equal(history[0].cmdId, res.results.find((r) => r.doorId === 'A-01')!.cmdId);
    // Au moment ou l'ordre part, le journal contient deja l'entree d'evacuation ET la demande de commande.
    for (const s of sent) {
      assert.ok(s.auditActions.includes('access_evacuation'), 'evacuation journalisee avant l\'envoi');
      assert.ok(s.auditActions.includes('commande_demandee'));
    }
    const rows = auditRows();
    const idOf = (action: string) => rows.find((r) => r.action === action)!.id;
    assert.ok(idOf('access_evacuation') < idOf('commande_demandee'));
    assert.ok(idOf('commande_demandee') < idOf('access_evacuation_bilan'));
    const start = audits('access_evacuation');
    assert.equal(start.length, 1);
    assert.equal(start[0].actor, admin);
    assert.match(start[0].details ?? '', new RegExp(`lot ${short}`));
    assert.match(start[0].details ?? '', /4 porte\(s\)/);
    assert.match(start[0].details ?? '', /Exercice d'evacuation/);
    const bilan = audits('access_evacuation_bilan');
    assert.equal(bilan.length, 1);
    assert.match(bilan[0].details ?? '', /2 porte\(s\) sur 4/);
    assert.match(bilan[0].details ?? '', /A-02/);
    assert.match(bilan[0].details ?? '', /A-03/);
    assert.equal(verify(db).ok, true, 'chaine du journal intacte');
  });

  it('mot de passe faux : 403, RIEN n\'est envoye et AUCUNE commande n\'est creee ; echec journalise a part, mot de passe jamais ecrit', () => {
    fourDoors();
    const wrong = 'Un-faux-mot-de-passe-9';
    assert.equal(status(() => evacuation.run(admin, body({ password: wrong }))), 403);
    assert.equal(sent.length, 0);
    assert.equal(commandRows().length, 0);
    assert.equal(audits('access_evacuation').length, 0, 'pas d\'entree d\'evacuation : elle n\'a pas eu lieu');
    assert.equal(audits('access_evacuation_reauth_echec').length, 1);
    assert.ok(!JSON.stringify(auditRows()).includes(wrong));
    // Le refus ne consomme pas la limite par minute : deux evacuations valides suivent.
    assert.equal(evacuation.run(admin, body()).counts.total, 4);
    assert.equal(evacuation.run(admin, body()).counts.total, 4);
  });

  it('mot de passe absent, vide ou non textuel : 428 (rien n\'est envoye)', () => {
    fourDoors();
    for (const password of [undefined, '', null, 12345, { $ne: '' }, ['x']]) {
      assert.equal(status(() => evacuation.run(admin, body({ password }))), 428, JSON.stringify(password));
    }
    assert.equal(sent.length, 0);
    assert.equal(commandRows().length, 0);
  });

  it('une bonne saisie ne fait pas monter le compteur d\'echecs, malgre la reverification par chaque commande', () => {
    fourDoors();
    const before = isRateLimited(`user:${admin}`);
    evacuation.run(admin, body());
    assert.equal(before, false);
    assert.equal(isRateLimited(`user:${admin}`), false);
    assert.equal(audits('access_evacuation_reauth_echec').length, 0);
    assert.equal(audits('commande_reauth_echec').length, 0);
    // Cinq evacuations de suite (le compteur de la connexion est de 5 echecs par minute) : jamais verrouille.
    clock += 2 * MIN;
    evacuation.run(admin, body());
    assert.equal(isRateLimited(`user:${admin}`), false);
  });

  it('confirmation : 428 sans confirm:true, sans la phrase exacte, sans raison ; 400 pour une duree ou un corps invalide', () => {
    fourDoors();
    for (const over of [{ confirm: false }, { confirm: 'true' }, { confirm: undefined }, { confirmPhrase: undefined }, { confirmPhrase: 'tout ouvrir' }, { confirmPhrase: 'TOUT OUVRIR ' }, { confirmPhrase: 'OUVRIR' }, { reason: undefined }, { reason: '' }, { reason: '   ' }, { reason: '\n\t' }]) {
      assert.equal(status(() => evacuation.run(admin, body(over))), 428, JSON.stringify(over));
    }
    for (const over of [{ durationS: 0 }, { durationS: -5 }, { durationS: 3601 }, { durationS: 1.5 }, { durationS: '300' }, { durationS: NaN }, { durationS: {} }, { reason: 5 }, { reason: 'x'.repeat(151) }]) {
      assert.equal(status(() => evacuation.run(admin, body(over))), 400, JSON.stringify(over));
    }
    for (const bad of [null, undefined, 'texte', 12, [], [body()]]) assert.equal(status(() => evacuation.run(admin, bad)), 400, JSON.stringify(bad));
    assert.equal(sent.length, 0);
    assert.equal(commandRows().length, 0);
    assert.equal(audits('access_evacuation').length, 0);
  });

  it('cles heritees (`__proto__`, `constructor`) dans le corps : jamais prises pour des champs', () => {
    fourDoors();
    const hostile = JSON.parse('{"__proto__":{"confirm":true,"confirmPhrase":"TOUT OUVRIR","reason":"x","password":"' + PW + '"}}') as Json;
    assert.equal(status(() => evacuation.run(admin, hostile)), 428);
    assert.equal(sent.length, 0);
  });

  it('aucune porte liee : 409, la limite par minute n\'est pas consommee', () => {
    declare('A-01', 1);
    assert.equal(status(() => evacuation.run(admin, body())), 409);
    assert.equal(audits('access_evacuation').length, 0);
    actuator('LOCK-1', 'lock');
    access.updateDoor('admin', 'A-01', { actuatorId: 'LOCK-1' });
    assert.equal(evacuation.run(admin, body()).counts.sent, 1);
    assert.equal(status(() => evacuation.run(admin, body())), 0, 'deuxieme evacuation de la minute : encore permise');
  });

  it('duree demandee : bornee au maximum de CHAQUE actionneur (et a son minimum), la duree reelle est rapportee', () => {
    actuator('LOCK-1', 'lock', { actions: { unlock: { minS: 3, maxS: 60 } } });
    actuator('LOCK-2', 'lock');
    actuator('GATE-1', 'gate');
    declare('A-01', 1, { actuatorId: 'LOCK-1' });
    declare('A-02', 2, { actuatorId: 'LOCK-2' });
    declare('A-03', 3, { kind: 'gate', actuatorId: 'GATE-1' });
    let res = evacuation.run(admin, body({ durationS: 45 }));
    assert.deepEqual(Object.fromEntries(res.results.map((r) => [r.doorId, r.durationS])), { 'A-01': 45, 'A-02': 10, 'A-03': 10 });
    clock += 2 * MIN;
    actuators.tick();
    res = evacuation.run(admin, body({ durationS: 1 }));
    assert.deepEqual(Object.fromEntries(res.results.map((r) => [r.doorId, r.durationS])), { 'A-01': 3, 'A-02': 1, 'A-03': 1 });
    clock += 2 * MIN;
    actuators.tick();
    res = evacuation.run(admin, body()); // defaut : 300 s
    assert.deepEqual(Object.fromEntries(res.results.map((r) => [r.doorId, r.durationS])), { 'A-01': 60, 'A-02': 10, 'A-03': 10 });
    assert.deepEqual(sent.slice(-3).map((s) => s.msg.params.durationS).sort((a, b) => (a ?? 0) - (b ?? 0)), [10, 10, 60]);
  });

  it('une issue de secours est deverrouillee comme les autres (jamais verrouillee)', () => {
    actuator('ISSUE-1', 'lock', { emergencyExit: true });
    declare('A-01', 1, { emergencyExit: true, actuatorId: 'ISSUE-1' });
    const res = evacuation.run(admin, body());
    assert.equal(res.results[0].status, 'sent');
    assert.equal(sent[0].msg.action, 'unlock');
  });

  it('lien incoherent ou actionneur supprime : porte `refused` avec un message, jamais ignoree en silence', () => {
    actuator('LOCK-1', 'lock');
    actuator('LOCK-2', 'lock');
    actuator('LOCK-3', 'lock');
    actuator('SIR-1', 'siren');
    declare('A-01', 1, { actuatorId: 'LOCK-1' });
    declare('A-02', 2, { actuatorId: 'LOCK-2' });
    declare('A-03', 3, { actuatorId: 'LOCK-3' });
    declare('A-04', 4);
    db.prepare("UPDATE actuator SET emergency_exit = 1 WHERE id = 'LOCK-1'").run(); // issue de secours d'un seul cote
    actuators.remove('admin', 'LOCK-2'); // supprime apres coup
    db.prepare("UPDATE access_door SET actuator_id = 'SIR-1' WHERE detector_id = 'A-03'").run(); // type incoherent (sirene)
    const preview = evacuation.preview();
    assert.equal(preview.doors.length, 3, 'la porte non liee n\'est pas listee');
    assert.ok(preview.doors.every((d) => !d.ready && d.problem));
    const res = evacuation.run(admin, body());
    assert.deepEqual(res.counts, { total: 3, sent: 0, failed: 3 });
    assert.ok(res.results.every((r) => r.status === 'refused' && r.error));
    assert.match(res.results.find((r) => r.doorId === 'A-01')!.error!, /issue de secours/);
    assert.match(res.results.find((r) => r.doorId === 'A-02')!.error!, /n'existe plus/);
    assert.match(res.results.find((r) => r.doorId === 'A-03')!.error!, /Incohérence/);
    assert.equal(sent.length, 0);
    assert.equal(commandRows().length, 0);
    assert.equal(audits('access_evacuation_bilan').length, 1, 'le bilan est ecrit meme quand rien n\'est parti');
  });

  it('mode maintenance des commandes : chaque porte est rapportee refusee avec son motif, l\'apercu le dit', () => {
    fourDoors();
    actuators.setLock('admin', true, 'travaux');
    const preview = evacuation.preview();
    assert.ok(preview.doors.every((d) => !d.ready));
    assert.ok(preview.doors.some((d) => /maintenance/.test(d.problem ?? '')));
    const res = evacuation.run(admin, body());
    assert.equal(res.counts.sent, 0);
    assert.equal(res.results.find((r) => r.doorId === 'A-01')!.status, 'refused');
    assert.match(res.results.find((r) => r.doorId === 'A-01')!.error!, /maintenance/);
    assert.equal(sent.length, 0);
    actuators.setLock('admin', false, null);
    clock += 2 * MIN;
    assert.equal(evacuation.run(admin, body()).counts.sent, 2);
  });

  it('la liaison coupee en cours de route (service des commandes) est rapportee `no_gateway`, sans arreter les autres', () => {
    fourDoors();
    // L'apercu dit « prete » ; la commande, elle, trouve la liaison coupee : on simule en retirant la passerelle apres l'apercu.
    const real = actuators;
    let calls = 0;
    const flaky = {
      get: real.get,
      lockState: real.lockState,
      request: ((u, id, b) => {
        calls++;
        if (id === 'LOCK-1') throw new PsimError(409, "Liaison coupee : aucune passerelle autorisee n'ecoute cet actionneur");
        return real.request(u, id, b);
      }) as Actuators['request'],
    };
    const svc = createEvacuation({ db, actuators: flaky, audit: (a, b, c) => engine.audit(a, b, c), now: () => clock });
    const res = svc.run(admin, body());
    assert.equal(calls, 2, 'les deux portes pretes sont tentees');
    assert.equal(res.results.find((r) => r.doorId === 'A-01')!.status, 'no_gateway');
    assert.equal(res.results.find((r) => r.doorId === 'A-04')!.status, 'sent');
  });

  it('erreur imprevue sur une porte : `error` sans fuite du detail, les autres portes sont traitees', () => {
    fourDoors();
    const real = actuators;
    const noisy = console.error;
    console.error = () => {};
    try {
      const boom = {
        get: real.get,
        lockState: real.lockState,
        request: ((u, id, b) => {
          if (id === 'LOCK-1') throw new Error('SQLITE_CORRUPT secret interne');
          return real.request(u, id, b);
        }) as Actuators['request'],
      };
      const res = createEvacuation({ db, actuators: boom, audit: (a, b, c) => engine.audit(a, b, c), now: () => clock }).run(admin, body());
      const r = res.results.find((x) => x.doorId === 'A-01')!;
      assert.equal(r.status, 'error');
      assert.ok(!JSON.stringify(res).includes('SQLITE_CORRUPT'));
      assert.equal(res.results.find((x) => x.doorId === 'A-04')!.status, 'sent');
      assert.deepEqual(res.counts, { total: 4, sent: 1, failed: 3 });
    } finally {
      console.error = noisy;
    }
  });

  it('journal impossible a ecrire AVANT l\'envoi : l\'evacuation echoue, rien ne part', () => {
    fourDoors();
    const svc = createEvacuation({
      db,
      actuators,
      audit: (actor, action, ref) => {
        if (action === 'access_evacuation') throw new Error('disque plein');
        engine.audit(actor, action, ref);
      },
      now: () => clock,
    });
    assert.throws(() => svc.run(admin, body()), /disque plein/);
    assert.equal(sent.length, 0);
    assert.equal(commandRows().length, 0);
  });

  it('limite : 2 evacuations par minute et par administrateur (429), liberee apres une minute ; un autre administrateur n\'est pas touche', () => {
    fourDoors();
    const other = newAdmin();
    assert.equal(evacuation.run(admin, body()).counts.total, 4);
    clock += 10 * S;
    assert.equal(evacuation.run(admin, body()).counts.total, 4);
    clock += 10 * S;
    assert.equal(status(() => evacuation.run(admin, body())), 429);
    assert.equal(status(() => evacuation.run(admin, body({ password: 'faux-mot-de-passe-1' }))), 429, 'le 429 est donne avant toute verification du mot de passe');
    assert.equal(audits('access_evacuation_reauth_echec').length, 0);
    assert.equal(audits('access_evacuation').length, 2);
    assert.equal(evacuation.run(other, body()).counts.total, 4, 'autre administrateur');
    clock += 41 * S; // 61 s apres la premiere
    actuators.tick();
    assert.equal(evacuation.run(admin, body()).counts.total, 4);
    // La fenetre glisse : a +61 s la premiere est sortie, la deuxieme (+10 s) et celle-ci comptent, donc une troisieme est refusee...
    assert.equal(status(() => evacuation.run(admin, body())), 429);
    clock += 10 * S; // ... jusqu'a ce que la deuxieme ait elle aussi plus d'une minute
    actuators.tick();
    assert.equal(status(() => evacuation.run(admin, body())), 0);
  });

  it('horloge qui recule : les anciens horodatages futurs ne bloquent pas la limite', () => {
    fourDoors();
    evacuation.run(admin, body());
    evacuation.run(admin, body());
    clock -= 10 * MIN;
    assert.equal(evacuation.run(admin, body()).counts.total, 4);
  });

  it('apercu : portes liees avec action, duree maximale, etat pret ou probleme ; aucun secret', () => {
    const keys = fourDoors();
    const { doors } = evacuation.preview();
    assert.equal(doors.length, 4);
    const by = Object.fromEntries(doors.map((d) => [d.doorId, d]));
    assert.deepEqual(by['A-01'], { doorId: 'A-01', doorName: 'Porte de service entrepot', actuatorId: 'LOCK-1', actuatorName: 'Actionneur LOCK-1', action: 'unlock', maxDurationS: 10, ready: true, problem: null });
    assert.equal(by['A-04'].action, 'open');
    assert.equal(by['A-04'].ready, true);
    assert.equal(by['A-02'].ready, false);
    assert.match(by['A-02'].problem ?? '', /passerelle/);
    assert.equal(by['A-03'].ready, false);
    assert.match(by['A-03'].problem ?? '', /désactivé/);
    const text = JSON.stringify(doors);
    for (const k of Object.values(keys)) assert.ok(!text.includes(k), 'aucune cle d\'actionneur');
    assert.ok(!/key|secret|sig|password/i.test(Object.keys(doors[0]).join(',')));
    assert.equal(sent.length, 0, 'l\'apercu n\'envoie rien');
    assert.equal(commandRows().length, 0);
    assert.equal(audits('access_evacuation').length, 0, 'ni ne journalise une evacuation');
  });

  it('apercu sans porte liee : liste vide', () => {
    declare('A-01', 1);
    assert.deepEqual(evacuation.preview(), { doors: [] });
  });

  it('apercu : l\'action n\'est plus configuree (base modifiee) -> porte non prete', () => {
    actuator('LOCK-1', 'lock');
    declare('A-01', 1, { actuatorId: 'LOCK-1' });
    db.prepare("UPDATE actuator SET actions = ? WHERE id = 'LOCK-1'").run(JSON.stringify({}));
    const d = evacuation.preview().doors[0];
    // `toView` ajoute toujours l'action sure ; « unlock » a disparu de la configuration.
    assert.equal(d.ready, false);
    assert.match(d.problem ?? '', /unlock/);
    assert.equal(d.maxDurationS, null);
  });

  it('redemarrage du PSIM en cours de route : rien n\'est renvoye (pas de file, pas de rejeu)', () => {
    fourDoors();
    evacuation.run(admin, body());
    const countBefore = sent.length;
    assert.equal(countBefore, 2);
    // Nouveau service des commandes sur la meme base = redemarrage.
    const restarted = createActuators({ db, key, audit: (a, b, c) => engine.audit(a, b, c), publish: () => {}, httpAllow: parseAllowList(['127.0.0.1']), now: () => clock });
    restarted.attachMqtt({ listeners: (id) => (up.has(id) ? 1 : 0), publishCommand: async (id, payload) => void sent.push({ id, msg: JSON.parse(payload.toString()) as CommandMessage, auditActions: [] }) });
    clock += 5 * MIN;
    restarted.tick();
    // Les retours automatiques a l'etat sur (verrouillage) peuvent partir, mais JAMAIS un ordre d'ouverture.
    assert.ok(sent.slice(countBefore).every((s) => s.msg.action === 'lock'));
  });

  it('une commande deja en vol, identique et du meme administrateur, est dedoublonnee : la porte est rapportee envoyee avec la meme commande', () => {
    actuator('LOCK-1', 'lock');
    declare('A-01', 1, { actuatorId: 'LOCK-1' });
    const first = evacuation.run(admin, body());
    clock += 1 * MIN + 1;
    const second = evacuation.run(admin, body({ reason: 'Deuxieme essai' }));
    assert.equal(second.results[0].status, 'sent');
    assert.equal(second.results[0].cmdId, first.results[0].cmdId, 'meme commande, rien n\'est reemis');
    assert.equal(sent.length, 1);
  });

  it('commande en vol d\'un AUTRE compte sur le meme actionneur : refusee (409), rapportee `refused`', () => {
    actuator('LOCK-1', 'lock');
    declare('A-01', 1, { actuatorId: 'LOCK-1' });
    const other = newAdmin();
    evacuation.run(other, body());
    const res = evacuation.run(admin, body());
    assert.equal(res.results[0].status, 'refused');
    assert.match(res.results[0].error ?? '', /autre compte/);
  });
});
