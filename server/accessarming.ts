/**
 * Controle d'acces, lot F14 : armement des portes. Contrats : server/accessrulestypes.ts (types figes), docs/CONTROLE-ACCES.md,
 * docs/PRD-CONTROLE-ACCES.md (F14), docs/ACCES.md.
 *
 * Principe : une porte peut etre RATTACHEE a l'armement de sa zone (la zone de son detecteur, `device.zone` : aucun nouveau champ).
 * Tant que cette zone est armee, TOUTE ouverture de la porte devient une PRE-ALARME (`door_opened_armed`), meme un badge accepte,
 * meme une ouverture a distance, sauf si le titulaire du passage appartient a un groupe dont un droit est en vigueur a cet instant
 * pour cette porte. Une porte forcee reste une alarme comme avant : l'armement n'adoucit JAMAIS rien (ni alarme -> pre-alarme, ni
 * effet sur sabotage, panique ou porte forcee).
 *
 * Deux chemins, qui ne se doublent pas :
 *  - un PASSAGE accepte (`judgePassage`, appele par access.ts a l'enregistrement) : verdict note dans `access_event_arming`, et
 *    pre-alarme immediate si le titulaire n'est pas autorise (le moteur l'applique APRES le message, voir AccessHookResult.raise) ;
 *  - un message `door_opened` SANS passage accepte voisin (`noteOpened` puis `tick`) : sur un vrai controleur le `badge_granted`
 *    precede (ou suit de peu) le `door_opened` du capteur ; l'ouverture n'est donc jugee qu'une fois le delai de grace ecoule
 *    (ARMING_GRACE_MS), et seulement si aucun passage accepte ne la couvre.
 *
 * Heure du jugement = heure du CONTROLEUR (`at_device` du passage, `ts` du `door_opened`), jamais l'heure courante : « la zone
 * etait-elle armee a ce moment-la ? ». Un desarmement decide 3 secondes apres le passage ne l'excuse pas. La zone de la porte est
 * relue a chaque jugement.
 *
 * Prudence maximale : dans le doute, pre-alarme. Titulaire inconnu, suspendu, expire, sans droit a cette heure, jour ferie,
 * lecteur de droits absent ou en erreur : NON autorise. Aucun nom de titulaire ni numero de badge dans les textes (seulement `H<id>`).
 *
 * Limite assumee : les ouvertures en attente de jugement (delai de grace) vivent en MEMOIRE. Un redemarrage du PSIM dans ces
 * quelques secondes les perd (le passage, lui, est dans la base et a deja ete juge).
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { HoldersReader } from './accessholderstypes.ts';
import { DOOR_ARMED_EVENT } from './accessrulestypes.ts';
import type { ArmingNote, DoorArmingView, RaiseRequest } from './accessrulestypes.ts';
import { PsimError } from './errors.ts';

type Row = Record<string, unknown>;

/** Delai laisse au `badge_granted` pour arriver apres un `door_opened` avant de juger l'ouverture « sans passage ». */
export const ARMING_GRACE_MS = 5_000;
/** Un passage accepte couvre un `door_opened` survenu jusqu'a 30 s apres lui (temps d'ouvrir la porte), ou ARMING_GRACE_MS avant lui. */
export const ARMING_COVER_BEFORE_MS = 30_000;
/** Ouvertures en attente : au plus ce nombre (au-dela, les plus anciennes partent d'abord, jamais de croissance sans borne). */
const MAX_PENDING = 200;
/** Longueur maximale du texte d'un incident (meme borne que `detail` des messages d'equipement). */
const MAX_DETAIL = 300;

/** Libelle de la note d'un passage (journal et fiche de porte). */
export function armingLabel(authorized: boolean, groupName: string | null): string {
  if (!authorized) return "Ouverture pendant l'armement : non autorisée";
  return groupName ? `Ouverture pendant l'armement : autorisée, groupe ${groupName}` : "Ouverture pendant l'armement : autorisée";
}

/**
 * Tables du lot F14 : `CREATE ... IF NOT EXISTS` seulement (appelee par migrateAccess).
 *  - `access_door_arming` : l'interrupteur « armer avec la zone », par porte, FAUX par defaut (une zone sans planning est armee en
 *    permanence : l'activer partout declencherait une pre-alarme a chaque ouverture) ;
 *  - `access_event_arming` : le verdict attache a un passage accepte pendant l'armement. La purge du journal des passages
 *    (`DELETE FROM access_event`) le supprime en cascade (`PRAGMA foreign_keys` est actif, voir openDb).
 */
export function migrateAccessArming(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS access_door_arming (
  detector_id TEXT PRIMARY KEY REFERENCES device(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS access_event_arming (
  event_id INTEGER PRIMARY KEY REFERENCES access_event(id) ON DELETE CASCADE,
  authorized INTEGER NOT NULL,
  group_id INTEGER,
  group_name TEXT
);
`);
}

// ---- Interface consommee par access.ts ---------------------------------------------------------------------------------------

/** Un passage accepte a juger. */
export interface PassageToJudge {
  /** Ligne `access_event` deja inseree. */
  eventId: number;
  doorId: string;
  /** Heure du controleur (ms). */
  at: number;
  /** Titulaire rattache au passage par le PSIM, ou `null`. */
  holderId: number | null;
}

export interface PassageJudgement {
  /** `null` : la porte n'est pas concernee (non rattachee, zone sans armement ou desarmee a cette heure). */
  note: ArmingNote | null;
  /** Pre-alarme a poser (titulaire non autorise), a appliquer par le moteur apres le message. */
  raise: RaiseRequest | null;
}

export interface DoorArming {
  /** Reglage d'une porte pour sa fiche (zone relue par l'appelant : `device.zone`). */
  viewOf(detectorId: string, zone: string): DoorArmingView;
  /** Reglages de plusieurs portes d'un coup (liste des portes : pas une requete par ligne). */
  viewsOf(doors: readonly { detectorId: string; zone: string }[]): Map<string, DoorArmingView>;
  /** Leve une 400 claire si la porte ne peut pas etre rattachee (zone vide ou sans armement). Sans effet si elle l'est deja. */
  assertCanEnable(detectorId: string): void;
  /** Active ou desactive « armer avec la zone ». Journalise (`access_door_arming`) quand la valeur change. */
  setEnabled(actor: string, detectorId: string, enabled: boolean): DoorArmingView;
  /** Oublie le reglage d'une porte retiree. */
  forget(detectorId: string): void;
  /** Juge un passage ACCEPTE d'une porte rattachee, note le verdict, propose la pre-alarme. Ne juge jamais un refus. */
  judgePassage(passage: PassageToJudge): PassageJudgement;
  /** Notes de plusieurs passages en une requete (decorer un lot de `PassageView`). */
  notesOf(eventIds: readonly number[]): Map<number, ArmingNote>;
  /** Un `door_opened` a ete valide pour cette porte, a l'heure `at` du controleur : jugement apres le delai de grace. */
  noteOpened(detectorId: string, at: number): void;
  /** Juge les ouvertures dont le delai de grace est ecoule. A appeler chaque seconde. Ne leve jamais. */
  tick(): void;
}

export interface DoorArmingOptions {
  db: DatabaseSync;
  /** Horloge injectee (tests). */
  now?: () => number;
  /** La zone etait-elle armee a l'instant `at` ? (arming.ts : `isArmed(zone, at)`). */
  isArmed: (zone: string, at: number) => boolean;
  /** Lecture des droits des titulaires. Absent : aucun titulaire n'est jamais autorise. */
  holders?: Pick<HoldersReader, 'groupsOf' | 'canPass' | 'groupsAllowedAt'>;
  /** Pose d'une pre-alarme sur le detecteur de la porte (engine.setStateBySupervisor). Faux si le detecteur n'existe pas. */
  raise: (doorId: string, request: RaiseRequest) => boolean;
  audit: (actor: string, action: string, ref?: { deviceId?: string; details?: string }) => void;
}

const two = (n: number): string => String(n).padStart(2, '0');
/** Heure LOCALE du serveur, « 22:14 ». */
const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};
const clip = (text: string, max = MAX_DETAIL): string => {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
};

export function createDoorArming(opts: DoorArmingOptions): DoorArming {
  const { db, holders } = opts;
  const now = opts.now ?? Date.now;
  migrateAccessArming(db);

  const statements = new Map<string, StatementSync>();
  function sql(text: string): StatementSync {
    let st = statements.get(text);
    if (!st) {
      if (statements.size >= 50) statements.clear();
      st = db.prepare(text);
      statements.set(text, st);
    }
    return st;
  }

  // ---- Reglage d'une porte --------------------------------------------------------------------------------------------------

  const isEnabled = (detectorId: string): boolean => (sql('SELECT enabled FROM access_door_arming WHERE detector_id = ?').get(detectorId) as { enabled: number } | undefined)?.enabled === 1;

  /** Un armement existe pour cette zone : detecteur d'intrusion dans la zone, ou ligne `arming_zone` (planning, derogation). */
  function zoneArmable(zone: string): boolean {
    if (zone === '') return false;
    try {
      if (sql("SELECT 1 AS x FROM device WHERE kind = 'detector' AND category = 'intrusion' AND zone = ? LIMIT 1").get(zone)) return true;
    } catch {
      // table device absente : impossible en pratique (openDb) ; on continue
    }
    try {
      return sql('SELECT 1 AS x FROM arming_zone WHERE zone = ?').get(zone) !== undefined;
    } catch {
      return false; // base ouverte sans le module d'armement : aucune zone n'est armable
    }
  }

  /** La zone etait-elle armee a `at` ? Une erreur du module d'armement vaut « armee » (dans le doute, on previent). */
  function armedAt(zone: string, at: number): boolean {
    try {
      return opts.isArmed(zone, at) !== false;
    } catch (err) {
      console.error(`[access] armement de la zone ${zone} :`, err);
      return true;
    }
  }

  function viewFor(enabled: boolean, zone: string, armable: boolean): DoorArmingView {
    return { enabled, zone, zoneArmable: armable, armedNow: enabled ? armable && armedAt(zone, now()) : null };
  }

  function viewOf(detectorId: string, zone: string): DoorArmingView {
    return viewFor(isEnabled(detectorId), zone, zoneArmable(zone));
  }

  function viewsOf(doors: readonly { detectorId: string; zone: string }[]): Map<string, DoorArmingView> {
    const enabled = new Set((sql('SELECT detector_id FROM access_door_arming WHERE enabled = 1').all() as Row[]).map((r) => r.detector_id as string));
    const armable = new Map<string, boolean>();
    const out = new Map<string, DoorArmingView>();
    for (const d of doors) {
      let ok = armable.get(d.zone);
      if (ok === undefined) {
        ok = zoneArmable(d.zone);
        armable.set(d.zone, ok);
      }
      out.set(d.detectorId, viewFor(enabled.has(d.detectorId), d.zone, ok));
    }
    return out;
  }

  const deviceOf = (id: string): { name: string; zone: string } | undefined => sql('SELECT name, zone FROM device WHERE id = ?').get(id) as { name: string; zone: string } | undefined;

  function assertCanEnable(detectorId: string): void {
    const dev = deviceOf(detectorId);
    if (!dev) throw new PsimError(404, 'Porte introuvable');
    if (isEnabled(detectorId)) return; // déjà rattachée : une modification sans rapport n'est jamais bloquée par une zone qui a changé depuis
    if (dev.zone === '') {
      throw new PsimError(400, "Cette porte n'a pas de zone : choisissez d'abord une zone pour son détecteur (écran Équipements), puis rattachez-la à l'armement.");
    }
    if (!zoneArmable(dev.zone)) {
      throw new PsimError(400, `La zone « ${dev.zone} » n'a pas d'armement : ajoutez-y un détecteur d'intrusion ou réglez son planning dans l'écran Armement, puis rattachez la porte.`);
    }
  }

  function setEnabled(actor: string, detectorId: string, enabled: boolean): DoorArmingView {
    const dev = deviceOf(detectorId);
    if (!dev) throw new PsimError(404, 'Porte introuvable');
    const was = isEnabled(detectorId);
    if (enabled && !was) assertCanEnable(detectorId);
    if (enabled !== was) {
      sql(
        `INSERT INTO access_door_arming (detector_id, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(detector_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ).run(detectorId, enabled ? 1 : 0, now(), actor);
      opts.audit(actor, 'access_door_arming', {
        deviceId: detectorId,
        details: clip(enabled ? `porte rattachee a l'armement de la zone « ${dev.zone} » : toute ouverture armee devient une pre-alarme` : "porte detachee de l'armement de sa zone", 120),
      });
    }
    return viewOf(detectorId, dev.zone);
  }

  function forget(detectorId: string): void {
    sql('DELETE FROM access_door_arming WHERE detector_id = ?').run(detectorId);
  }

  // ---- Jugement -------------------------------------------------------------------------------------------------------------

  /** Porte rattachee ET zone armable ET armee a `at` : son nom et sa zone, sinon `null` (aucun effet). */
  function armedContext(doorId: string, at: number): { name: string; zone: string } | null {
    if (!isEnabled(doorId)) return null;
    const dev = deviceOf(doorId);
    if (!dev || !zoneArmable(dev.zone)) return null; // zone relue a chaque jugement : sans armement, rien n'est « armé »
    return armedAt(dev.zone, at) ? dev : null;
  }

  interface Verdict {
    authorized: boolean;
    groupId: number | null;
    groupName: string | null;
  }
  const UNAUTHORIZED: Verdict = { authorized: false, groupId: null, groupName: null };

  /**
   * Titulaire autorise : connu, `canPass` a `at`, ET un de ses groupes a un droit en vigueur a `at` pour cette porte. Tout le reste
   * (suspendu, expire, jour ferie, badge inconnu, lecteur absent ou en erreur) : non autorise.
   */
  function verdictFor(holderId: number | null, doorId: string, at: number): Verdict {
    if (holders === undefined || holderId === null || !Number.isSafeInteger(holderId)) return UNAUTHORIZED;
    try {
      const decision = holders.canPass(holderId, doorId, at);
      if (decision.allowed !== true) return UNAUTHORIZED;
      const mine = holders.groupsOf(holderId);
      const allowed = holders.groupsAllowedAt(at, doorId);
      if (!Array.isArray(mine) || !Array.isArray(allowed)) return UNAUTHORIZED;
      const inForce = new Set(allowed.filter((g) => !Array.isArray(g.doorIds) || g.doorIds.includes(doorId)).map((g) => g.id));
      const common = mine.filter((g) => inForce.has(g.id));
      if (common.length === 0) return UNAUTHORIZED;
      const chosen = (decision.groupId !== null ? common.find((g) => g.id === decision.groupId) : undefined) ?? common[0];
      return { authorized: true, groupId: chosen.id, groupName: typeof chosen.name === 'string' && chosen.name !== '' ? chosen.name : null };
    } catch (err) {
      console.error('[access] droits du titulaire (armement des portes) :', err);
      return UNAUTHORIZED;
    }
  }

  function raiseRequest(ctx: { name: string; zone: string }, at: number, holderId: number | null): RaiseRequest {
    const who = holderId === null ? 'aucun titulaire connu' : `titulaire H${holderId} sans droit à cette heure`;
    return {
      state: 'prealarm',
      event: DOOR_ARMED_EVENT,
      detail: clip(`Ouverture de la porte « ${ctx.name} » à ${hhmm(at)} pendant l'armement de la zone « ${ctx.zone} » : ${who}`),
    };
  }

  function judgePassage(p: PassageToJudge): PassageJudgement {
    const ctx = armedContext(p.doorId, p.at);
    if (ctx === null) return { note: null, raise: null };
    const verdict = verdictFor(p.holderId, p.doorId, p.at);
    sql(
      `INSERT INTO access_event_arming (event_id, authorized, group_id, group_name) VALUES (?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET authorized = excluded.authorized, group_id = excluded.group_id, group_name = excluded.group_name`,
    ).run(p.eventId, verdict.authorized ? 1 : 0, verdict.groupId, verdict.groupName);
    const note: ArmingNote = { authorized: verdict.authorized, groupId: verdict.groupId, groupName: verdict.groupName, label: armingLabel(verdict.authorized, verdict.groupName) };
    return { note, raise: verdict.authorized ? null : raiseRequest(ctx, p.at, p.holderId) };
  }

  function notesOf(eventIds: readonly number[]): Map<number, ArmingNote> {
    const out = new Map<number, ArmingNote>();
    if (eventIds.length === 0) return out;
    // json_each : une seule requete quel que soit le nombre de lignes, sans limite de parametres.
    const rows = sql('SELECT event_id, authorized, group_id, group_name FROM access_event_arming WHERE event_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(eventIds)) as Row[];
    for (const r of rows) {
      const authorized = r.authorized === 1;
      const groupName = (r.group_name as string | null) ?? null;
      out.set(r.event_id as number, { authorized, groupId: (r.group_id as number | null) ?? null, groupName, label: armingLabel(authorized, groupName) });
    }
    return out;
  }

  // ---- Ouvertures sans passage (door_opened) -------------------------------------------------------------------------------------

  interface Pending {
    doorId: string;
    /** Heure du controleur de l'ouverture. */
    at: number;
    /** Heure (horloge du PSIM) a partir de laquelle on la juge. */
    dueAt: number;
  }
  let pending: Pending[] = [];

  function noteOpened(detectorId: string, at: number): void {
    if (!Number.isFinite(at) || !isEnabled(detectorId)) return; // porte non rattachee : rien a attendre
    pending.push({ doorId: detectorId, at, dueAt: now() + ARMING_GRACE_MS });
    if (pending.length > MAX_PENDING) pending = pending.slice(pending.length - MAX_PENDING);
  }

  /** Un passage ACCEPTE de cette porte couvre-t-il l'ouverture a `at` ? (de 30 s avant a ARMING_GRACE_MS apres) */
  const covered = (doorId: string, at: number): boolean =>
    sql("SELECT 1 AS x FROM access_event WHERE door_id = ? AND result = 'granted' AND at_device >= ? AND at_device <= ? LIMIT 1").get(doorId, at - ARMING_COVER_BEFORE_MS, at + ARMING_GRACE_MS) !== undefined;

  /** Vrai si une pre-alarme a ete demandee. */
  function judgeOpening(p: Pending): boolean {
    if (covered(p.doorId, p.at)) return false; // le passage l'a deja juge (ou l'a autorise)
    const ctx = armedContext(p.doorId, p.at);
    if (ctx === null) return false;
    // Jamais sur un detecteur deja en alarme : l'armement n'adoucit rien (le moteur le garantit aussi).
    const status = (sql('SELECT status FROM device WHERE id = ?').get(p.doorId) as { status: string } | undefined)?.status;
    if (status === undefined || status === 'alarm') return false;
    return opts.raise(p.doorId, raiseRequest(ctx, p.at, null));
  }

  function tick(): void {
    if (pending.length === 0) return;
    const t = now();
    // Horloge revenue en arriere de plus d'un delai de grace : on ne reste pas bloque en attente d'un instant lointain.
    const isDue = (p: Pending): boolean => p.dueAt <= t || p.dueAt - t > ARMING_GRACE_MS;
    const due = pending.filter(isDue);
    if (due.length === 0) return;
    pending = pending.filter((p) => !isDue(p));
    const done = new Set<string>();
    for (const p of due) {
      if (done.has(p.doorId)) continue; // une seule pre-alarme par porte et par controle
      try {
        if (judgeOpening(p)) done.add(p.doorId);
      } catch (err) {
        console.error(`[access] armement de la porte ${p.doorId} :`, err);
      }
    }
  }

  return { viewOf, viewsOf, assertCanEnable, setEnabled, forget, judgePassage, notesOf, noteOpened, tick };
}
