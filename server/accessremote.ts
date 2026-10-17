/**
 * Controle d'acces, lot AC4 : ouverture et verrouillage a distance (F17), issues de secours (F18), mode de porte (F19) et
 * « Tout ouvrir » (F20). Contrat : docs/CONTROLE-ACCES.md (§ 2, 3, 5), docs/PRD-CONTROLE-ACCES.md, docs/COMMANDES.md.
 *
 * Ce module ne parle JAMAIS a un equipement. Toute ouverture ou tout verrouillage passe par le service des commandes
 * (server/actuators.ts, `request`) avec ses garde-fous : droits, raison, mot de passe, limite, mode maintenance, journal scelle
 * AVANT l'envoi, issue de secours jamais verrouillee. Ici :
 *  - le LIEN porte <-> actionneur (`access_door.actuator_id`) : controle a l'ecriture, et resume lisible (`remote`) pour la fiche ;
 *  - le MODE de porte annonce par le controleur (always_open / always_closed / normal), dernier mode connu et sa date ;
 *  - le service « Tout ouvrir » : un apercu, et une ouverture groupee de toutes les portes liees, reservee a l'administrateur.
 *
 * `createAccess` ne connait pas le service des commandes (il est cree apres dans main.ts) : le lien se controle donc en lisant la
 * table `actuator` de la meme base. Une base ou cette table n'existe pas (essai qui n'a migre que l'acces) se comporte comme une
 * base sans actionneur : aucune erreur, simplement aucun lien possible.
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Actuators } from './actuators.ts';
import { PsimError } from './errors.ts';
import { reauthenticate } from './reauth.ts';
import type { AuditFn } from './reauth.ts';

type Row = Record<string, unknown>;

// ---- Mode de porte (F19) -----------------------------------------------------------------------------------------------------

export const DOOR_MODES = ['normal', 'always_open', 'always_closed'] as const;
export type DoorMode = (typeof DOOR_MODES)[number];

export const DOOR_MODE_LABELS: Readonly<Record<DoorMode, string>> = {
  normal: 'Mode normal : les badges fonctionnent',
  always_open: 'Ouverte en permanence (réglée dans le contrôleur)',
  always_closed: 'Verrouillée en permanence (réglée dans le contrôleur)',
};

/** Mode annonce par un message, ou `null` s'il est absent ou invalide (jamais une cle heritee : « constructor »...). */
export function parseDoorMode(value: unknown): DoorMode | null {
  return typeof value === 'string' && Object.hasOwn(DOOR_MODE_LABELS, value) ? (value as DoorMode) : null;
}

/** Champs `doorMode*` d'une vue de porte : tout `null` tant qu'aucun message `door_mode` n'est arrive. */
export function doorModeFields(mode: unknown, at: unknown): { doorMode: DoorMode | null; doorModeLabel: string | null; doorModeAt: number | null } {
  const parsed = parseDoorMode(mode);
  if (parsed === null || typeof at !== 'number') return { doorMode: null, doorModeLabel: null, doorModeAt: null };
  return { doorMode: parsed, doorModeLabel: DOOR_MODE_LABELS[parsed], doorModeAt: at };
}

/**
 * Retient le mode d'une porte DECLAREE. Un message plus ancien (`at` inferieur a la date retenue) n'ecrase pas un plus recent ;
 * a date egale, le dernier arrive l'emporte. `changed` : le mode differe du precedent (premier message compris) : seul un
 * changement merite une entree de journal.
 */
export function recordDoorMode(db: DatabaseSync, detectorId: string, mode: DoorMode, at: number): { applied: boolean; changed: boolean; previous: DoorMode | null } {
  const before = db.prepare('SELECT mode FROM access_door_mode WHERE detector_id = ?').get(detectorId) as { mode: string } | undefined;
  const res = db
    .prepare(
      `INSERT INTO access_door_mode (detector_id, mode, at) VALUES (?, ?, ?)
       ON CONFLICT(detector_id) DO UPDATE SET mode = excluded.mode, at = excluded.at WHERE excluded.at >= access_door_mode.at`,
    )
    .run(detectorId, mode, at);
  const applied = Number(res.changes) > 0;
  const previous = before ? parseDoorMode(before.mode) : null;
  return { applied, changed: applied && previous !== mode, previous };
}

/** Oublie le mode d'une porte retiree (le mode d'une porte redeclaree plus tard ne doit pas ressortir d'un ancien message). */
export function forgetDoorMode(db: DatabaseSync, detectorId: string): void {
  db.prepare('DELETE FROM access_door_mode WHERE detector_id = ?').run(detectorId);
}

/**
 * Tables du lot AC4 : `CREATE ... IF NOT EXISTS` seulement. Appelee par migrateAccess. L'index unique « un actionneur ne sert
 * qu'une porte » est une seconde ligne de defense : une base ou des doublons existent deja (declares avant ce controle) le refuse,
 * et le PSIM demarre quand meme (le controle applicatif et le champ `remote` restent actifs).
 */
export function migrateAccessRemote(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS access_door_mode (
  detector_id TEXT PRIMARY KEY REFERENCES device(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('normal', 'always_open', 'always_closed')),
  at INTEGER NOT NULL
);
`);
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS access_door_by_actuator ON access_door(actuator_id) WHERE actuator_id IS NOT NULL');
  } catch (err) {
    console.error("[access] index « un actionneur, une porte » non cree (doublons existants ?) :", (err as Error).message);
  }
}

// ---- Lien porte <-> actionneur (F17, F18) ----------------------------------------------------------------------------------

/** Ce que le controle du lien sait de l'actionneur. */
export interface ActuatorFacts {
  id: string;
  name: string;
  type: string;
  emergencyExit: boolean;
  active: boolean;
}

/** Faits d'un actionneur lus dans la base, ou `null` (absent, ou table `actuator` pas encore creee). Ne leve jamais. */
export function readActuatorFacts(db: DatabaseSync, id: string): ActuatorFacts | null {
  try {
    const r = db.prepare('SELECT id, name, type, emergency_exit, active FROM actuator WHERE id = ?').get(id) as Row | undefined;
    return r ? { id: r.id as string, name: r.name as string, type: r.type as string, emergencyExit: r.emergency_exit === 1, active: r.active === 1 } : null;
  } catch {
    return null;
  }
}

const DOOR_KIND_NOUN: Readonly<Record<string, string>> = { door: 'une porte', gate: 'un portail', barrier: 'une barrière', turnstile: 'un tourniquet' };
const ACTUATOR_TYPE_NOUN: Readonly<Record<string, string>> = {
  siren: 'une sirène',
  light: 'un projecteur',
  relay: 'un relais',
  lock: 'une serrure ou une gâche',
  gate: 'un portail ou une barrière',
  speaker: 'un haut-parleur',
};

/** Type d'actionneur attendu pour un type de porte : `door` -> `lock` ; `gate`, `barrier`, `turnstile` -> `gate`. */
export function expectedActuatorType(kind: string): 'lock' | 'gate' | null {
  if (kind === 'door') return 'lock';
  if (kind === 'gate' || kind === 'barrier' || kind === 'turnstile') return 'gate';
  return null;
}

export interface DoorLinkInput {
  kind: string;
  emergencyExit: boolean;
  actuatorId: string | null;
}

/** Le lien d'une porte avec son actionneur est-il coherent ? Phrase francaise sinon (ordre : aucun, absent, desactive, type, issue de secours). */
export function linkProblem(door: DoorLinkInput, actuator: ActuatorFacts | null): string | null {
  if (door.actuatorId === null) return "Aucun actionneur n'est lié à cette porte";
  if (actuator === null) return "L'actionneur lié n'existe plus";
  if (!actuator.active) return `L'actionneur « ${actuator.name} » est désactivé : un administrateur doit le réactiver`;
  const wanted = expectedActuatorType(door.kind);
  if (wanted === null || actuator.type !== wanted) {
    return `Incohérence : cette porte est ${DOOR_KIND_NOUN[door.kind] ?? 'de type inconnu'} mais l'actionneur lié est ${ACTUATOR_TYPE_NOUN[actuator.type] ?? 'd\'un autre type'}`;
  }
  if (door.emergencyExit !== actuator.emergencyExit) {
    return door.emergencyExit
      ? "Incohérence : issue de secours d'un seul côté (la porte en est une, pas l'actionneur lié)"
      : "Incohérence : issue de secours d'un seul côté (l'actionneur lié en est une, pas la porte)";
  }
  return null;
}

/**
 * Controle d'ecriture du lien (POST / PUT /api/access/doors), sur l'etat RESULTANT de la porte :
 *  - l'actionneur existe (400), son type est coherent avec le type de porte (400) ;
 *  - F18 : issue de secours = les deux ou aucun (400) ;
 *  - un actionneur ne sert qu'une seule porte (409).
 * Un actionneur desactive est accepte (on peut preparer le lien) : `remote` et « Tout ouvrir » le signalent.
 */
export function checkDoorLink(db: DatabaseSync, door: DoorLinkInput & { detectorId: string }): void {
  if (door.actuatorId === null) return;
  const actuator = readActuatorFacts(db, door.actuatorId);
  if (actuator === null) throw new PsimError(400, "Actionneur inconnu : le creer d'abord (configuration des actionneurs)");
  const wanted = expectedActuatorType(door.kind);
  if (wanted === null || actuator.type !== wanted) {
    throw new PsimError(400, `Type d'actionneur incoherent : une porte de type « ${door.kind} » demande un actionneur de type « ${wanted ?? '?'} » (celui-ci est de type « ${actuator.type} »)`);
  }
  if (door.emergencyExit !== actuator.emergencyExit) {
    throw new PsimError(
      400,
      door.emergencyExit
        ? "Issue de secours : la porte l'est mais pas l'actionneur lie. Une issue de secours doit l'etre des deux cotes, ou aucun des deux (le PSIM ne la verrouille jamais)"
        : "Issue de secours : l'actionneur lie l'est mais pas la porte. Une issue de secours doit l'etre des deux cotes, ou aucun des deux (le PSIM ne la verrouille jamais)",
    );
  }
  const other = db.prepare('SELECT detector_id FROM access_door WHERE actuator_id = ? AND detector_id <> ? LIMIT 1').get(door.actuatorId, door.detectorId) as { detector_id: string } | undefined;
  if (other) throw new PsimError(409, `Cet actionneur sert deja une autre porte (${other.detector_id}) : en delier d'abord cette porte`);
}

/** Fiche de porte, `remote` : l'ouverture a distance est-elle possible ? Ne depend pas des droits de l'utilisateur. */
export interface DoorRemote {
  available: boolean;
  reason: string | null;
  actuatorId: string | null;
  actuatorName: string | null;
  actuatorType: 'lock' | 'gate' | null;
}

export function remoteOf(db: DatabaseSync, door: DoorLinkInput): DoorRemote {
  const actuator = door.actuatorId === null ? null : readActuatorFacts(db, door.actuatorId);
  const reason = linkProblem(door, actuator);
  return {
    available: reason === null,
    reason,
    actuatorId: door.actuatorId,
    actuatorName: actuator?.name ?? null,
    actuatorType: actuator !== null && (actuator.type === 'lock' || actuator.type === 'gate') ? actuator.type : null,
  };
}

// ---- « Tout ouvrir » (F20) ---------------------------------------------------------------------------------------------------

export const EVACUATION_PHRASE = 'TOUT OUVRIR';
export const EVACUATION_DEFAULT_DURATION_S = 300;
const EVACUATION_MAX_DURATION_S = 3600;
const EVACUATION_MAX_REASON = 150;
/** Au plus 2 evacuations par minute et par administrateur. */
export const EVACUATION_RATE_PER_MIN = 2;
const RATE_WINDOW_MS = 60_000;

export interface EvacuationDoor {
  doorId: string;
  doorName: string;
  actuatorId: string;
  actuatorName: string | null;
  action: 'unlock' | 'open';
  maxDurationS: number | null;
  ready: boolean;
  problem: string | null;
}

export type EvacuationStatus = 'sent' | 'no_gateway' | 'refused' | 'error';

export interface EvacuationDoorResult {
  doorId: string;
  doorName: string;
  actuatorId: string;
  status: EvacuationStatus;
  cmdId?: string;
  durationS?: number;
  error?: string;
}

export interface EvacuationResult {
  batchId: string;
  at: number;
  results: EvacuationDoorResult[];
  counts: { total: number; sent: number; failed: number };
}

export interface EvacuationService {
  /** Portes qui seraient ouvertes : rien n'est envoye. */
  preview(): { doors: EvacuationDoor[] };
  /** Ouvre toutes les portes liees. `actor` : administrateur connecte (la route est reservee aux administrateurs). */
  run(actor: string, body: unknown): EvacuationResult;
}

export interface EvacuationDeps {
  db: DatabaseSync;
  /** Service des commandes : seul chemin vers une serrure. */
  actuators: Pick<Actuators, 'get' | 'request' | 'lockState'>;
  audit: AuditFn;
  now?: () => number;
}

interface Plan {
  door: EvacuationDoor;
  /** Statut a rapporter si la porte ne part pas. */
  failure: Exclude<EvacuationStatus, 'sent' | 'error'>;
  minS: number | null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
const clipText = (text: string, max: number): string => ([...text].length <= max ? text : `${[...text].slice(0, max - 1).join('')}…`);

export function createEvacuation(deps: EvacuationDeps): EvacuationService {
  const { db, actuators, audit } = deps;
  const now = deps.now ?? Date.now;
  /** Evacuations demarrees, par administrateur (minute glissante). En memoire : un redemarrage remet a zero, sans rejouer quoi que ce soit. */
  const started = new Map<string, number[]>();

  /** Etat de chaque porte liee : prete, ou le probleme qui l'empeche (jamais ignoree en silence). */
  function plan(): Plan[] {
    const rows = db
      .prepare(
        `SELECT a.detector_id AS id, a.kind AS kind, a.emergency_exit AS emergency_exit, a.actuator_id AS actuator_id, d.name AS name
           FROM access_door a JOIN device d ON d.id = a.detector_id
          WHERE a.actuator_id IS NOT NULL
          ORDER BY d.name COLLATE NOCASE, a.detector_id`,
      )
      .all() as Row[];
    const maintenance = actuators.lockState().locked;
    return rows.map((r): Plan => {
      const actuatorId = r.actuator_id as string;
      const view = actuators.get(actuatorId);
      const facts: ActuatorFacts | null = view ? { id: view.id, name: view.name, type: view.type, emergencyExit: view.emergencyExit, active: view.active } : null;
      const link: DoorLinkInput = { kind: r.kind as string, emergencyExit: r.emergency_exit === 1, actuatorId };
      const action: 'unlock' | 'open' = facts?.type === 'gate' ? 'open' : 'unlock';
      let problem = linkProblem(link, facts);
      let failure: Plan['failure'] = 'refused';
      const config = view && Object.hasOwn(view.actions, action) ? view.actions[action] : null;
      if (problem === null && !config) problem = `L'action « ${action} » n'est pas disponible sur cet actionneur`;
      if (problem === null && view && view.transport === 'mqtt' && view.linkUp === false) {
        problem = "Aucune passerelle n'écoute cet actionneur (liaison coupée) : la porte ne peut pas être ouverte d'ici";
        failure = 'no_gateway';
      }
      if (problem === null && maintenance) problem = 'Les commandes sont verrouillées (mode maintenance)';
      return {
        door: {
          doorId: r.id as string,
          doorName: r.name as string,
          actuatorId,
          actuatorName: facts?.name ?? null,
          action,
          maxDurationS: config?.maxS ?? null,
          ready: problem === null,
          problem,
        },
        failure,
        minS: config?.minS ?? null,
      };
    });
  }

  function preview(): { doors: EvacuationDoor[] } {
    return { doors: plan().map((p) => p.door) };
  }

  /** Limite de debit : verifie AVANT le mot de passe (un refus n'apprend rien), consommee seulement quand l'evacuation part. */
  function checkRate(actor: string, t: number): void {
    const recent = (started.get(actor) ?? []).filter((at) => t - at < RATE_WINDOW_MS && at <= t);
    if (recent.length >= EVACUATION_RATE_PER_MIN) {
      started.set(actor, recent);
      throw new PsimError(429, `Trop d'evacuations : ${EVACUATION_RATE_PER_MIN} par minute au plus. Si une evacuation vient d'etre lancee, ses portes sont deja en cours d'ouverture`);
    }
  }
  function consumeRate(actor: string, t: number): void {
    const recent = (started.get(actor) ?? []).filter((at) => t - at < RATE_WINDOW_MS && at <= t);
    recent.push(t);
    started.set(actor, recent);
    if (started.size > 200) for (const [k, list] of started) if (list.every((at) => t - at >= RATE_WINDOW_MS)) started.delete(k);
  }

  function run(actor: string, input: unknown): EvacuationResult {
    if (!isPlainObject(input)) throw new PsimError(400, 'Corps de requete invalide : un objet est attendu');
    const reasonRaw = own(input, 'reason');
    if (reasonRaw !== undefined && typeof reasonRaw !== 'string') throw new PsimError(400, 'reason : texte attendu');
    const reason = (reasonRaw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!reason) throw new PsimError(428, 'Raison obligatoire pour ouvrir toutes les portes');
    if ([...reason].length > EVACUATION_MAX_REASON) throw new PsimError(400, `reason : ${EVACUATION_MAX_REASON} caracteres au plus`);
    if (own(input, 'confirm') !== true) throw new PsimError(428, 'Confirmation explicite requise (confirm: true)');
    if (own(input, 'confirmPhrase') !== EVACUATION_PHRASE) throw new PsimError(428, `Confirmation requise : saisir la phrase « ${EVACUATION_PHRASE} »`);
    const durationRaw = own(input, 'durationS');
    let requestedS = EVACUATION_DEFAULT_DURATION_S;
    if (durationRaw !== undefined && durationRaw !== null) {
      if (typeof durationRaw !== 'number' || !Number.isInteger(durationRaw) || durationRaw < 1 || durationRaw > EVACUATION_MAX_DURATION_S) {
        throw new PsimError(400, `durationS : entier de 1 a ${EVACUATION_MAX_DURATION_S} secondes`);
      }
      requestedS = durationRaw;
    }
    const t = now();
    checkRate(actor, t);
    // Mot de passe verifie UNE fois, avant tout envoi. Echec : 403 (428 s'il manque), journal dedie, rien n'est envoye ni cree.
    const password = own(input, 'password');
    reauthenticate(db, actor, password, audit, { what: 'ouverture de toutes les portes', failAction: 'access_evacuation_reauth_echec' });

    const plans = plan();
    if (plans.length === 0) throw new PsimError(409, "Aucune porte n'est liee a un actionneur : rien a ouvrir");
    consumeRate(actor, t);

    const batchId = randomBytes(8).toString('hex');
    const short = batchId.slice(0, 8);
    // Journal infalsifiable AVANT tout envoi : si l'ecriture echoue, rien ne part.
    audit(actor, 'access_evacuation', {
      details: clipText(`TOUT OUVRIR (lot ${short}) : ${plans.length} porte(s), duree demandee ${requestedS} s ; raison : ${reason}`, 300),
    });

    const results: EvacuationDoorResult[] = [];
    for (const p of plans) {
      const base = { doorId: p.door.doorId, doorName: p.door.doorName, actuatorId: p.door.actuatorId };
      if (!p.door.ready) {
        results.push({ ...base, status: p.failure, error: p.door.problem ?? 'Porte non ouvrable' });
        continue;
      }
      // Duree demandee, ramenee dans les bornes de l'action de CET actionneur.
      const maxS = p.door.maxDurationS ?? requestedS;
      const durationS = Math.min(Math.max(requestedS, p.minS ?? 1), maxS);
      try {
        const out = actuators.request({ username: actor, role: 'admin' }, p.door.actuatorId, {
          action: p.door.action,
          params: { durationS },
          confirm: true,
          reason: clipText(`Tout ouvrir (lot ${short}) : ${reason}`, 200),
          password,
        });
        results.push({ ...base, status: 'sent', cmdId: out.command.cmdId, durationS });
      } catch (err) {
        if (err instanceof PsimError) {
          const noGateway = err.status === 409 && err.message.startsWith('Liaison coupee');
          results.push({ ...base, status: noGateway ? 'no_gateway' : 'refused', error: err.message });
        } else {
          console.error(`[access] Tout ouvrir, porte ${p.door.doorId} :`, err);
          results.push({ ...base, status: 'error', error: "Erreur inattendue : l'ordre n'a pas pu être suivi, vérifier la porte sur place" });
        }
      }
    }

    const sent = results.filter((r) => r.status === 'sent').length;
    const failedDoors = results.filter((r) => r.status !== 'sent').map((r) => r.doorId);
    try {
      audit(actor, 'access_evacuation_bilan', {
        details: clipText(`TOUT OUVRIR (lot ${short}) : ${sent} porte(s) sur ${results.length} en cours d'ouverture${failedDoors.length > 0 ? ` ; echec : ${failedDoors.join(', ')}` : ''}`, 300),
      });
    } catch (err) {
      // Les ordres sont partis : le bilan manquant ne doit pas faire croire a l'operateur que rien n'a ete fait.
      console.error("[access] Tout ouvrir : bilan non ecrit au journal :", err);
    }
    return { batchId, at: t, results, counts: { total: results.length, sent, failed: results.length - sent } };
  }

  return { preview, run };
}
