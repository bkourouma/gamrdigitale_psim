/**
 * Commandes des equipements (actionneurs) : sirene, projecteur, relais, serrure / gache, portail / barriere, haut-parleur.
 * Conception, modele de menaces et specification du message : docs/COMMANDES.md (a lire avant toute modification).
 *
 * Garde-fous tenus ICI (et nulle part ailleurs : c'est le seul chemin d'envoi) :
 *  - droits par action et par role, `confirm:true` toujours, raison et mot de passe pour les serrures et portails ;
 *  - durees bornees (plafond par type), jamais d'ordre permanent sauf action `unbounded` configuree par un administrateur ;
 *  - 4 commandes / minute / utilisateur / actionneur, dedoublonnage des commandes identiques en vol (APRES la
 *    re-authentification, et jamais au profit d'un autre compte : 409) ;
 *  - ACTION SURE (off, lock, stop du haut-parleur, stop du portail) : toujours immediate et toujours permise a operator + admin
 *    (roles imposes a la configuration), ni raison ni mot de passe, limite de debit SEPAREE (SAFE_RATE_PER_MIN) ;
 *  - journal scelle AVANT l'envoi (`commande_demandee`), puis a chaque changement d'etat ;
 *  - un seul envoi par commande manuelle, jamais rejoue (ni apres une erreur, ni au redemarrage) ; seul le RETOUR AUTOMATIQUE a
 *    l'etat sur est reessaye (toutes les 5 s, 5 essais au plus) : l'oublier laisserait une sortie active indefiniment ;
 *  - sans accuse dans le delai : echec, jamais « fait » par supposition ; retour automatique a l'etat sur, et si ses 5 essais
 *    echouent, avertissement visible (journal `commande_echec` + `returnUnconfirmed`) ;
 *  - verrou global (mode maintenance) : refuse tout SAUF l'action sure demandee a la main (arreter une sirene, reverrouiller
 *    une serrure, y compris ouverte « sans limite », arreter un portail) et l'arret anticipe d'une commande en cours : un verrou
 *    qui empecherait de faire cesser une action en cours serait pire que l'absence de verrou. Les retours automatiques prevus
 *    et les reessais restent annules a l'activation du verrou (les equipements s'arretent seuls grace a `durationS`) ;
 *  - issue de secours jamais verrouillee (verifie a la configuration, a la demande ET a l'envoi), liaison coupee = refus ;
 *  - serrure, portail, actionneur declare « sensible » : jamais pilotes en HTTP (requete en clair, rejouable) ;
 *  - aucune cle fournie par l'utilisateur n'est lue sans `Object.hasOwn` (« constructor », « toString »... : 400, jamais un ordre).
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import type { Express, Request, RequestHandler } from 'express';
import { CLOCK_SKEW_MS, TTL_MAX_S, TTL_MIN_S, ACTUATOR_ID, CLIP, CMD_ID, signCommand, verifyAck } from './actuatorproto.ts';
import type { CommandParams } from './actuatorproto.ts';
import { cleanHttpConfig, cleanSecretValue, sendHttp } from './actuatorhttp.ts';
import type { HttpAllow, HttpOutcome, HttpRequestTemplate, HttpTransportConfig } from './actuatorhttp.ts';
import { PsimError } from './errors.ts';
import { reauthenticate } from './reauth.ts';
import { seal, unseal } from './secrets.ts';
import type { PsimEvent, Role } from './types.ts';

export type ActuatorType = 'siren' | 'light' | 'relay' | 'lock' | 'gate' | 'speaker';
export type CommandState = 'pending' | 'sent' | 'acked' | 'refused' | 'failed' | 'expired' | 'cancelled';

interface ActionSpec {
  /** Action temporisee : `durationS` exige (borne), sauf `unbounded` configure par un administrateur. */
  timed: boolean;
  ceilingS?: number;
  defaultMaxS?: number;
  /** Un administrateur peut autoriser cette action sans limite de duree (jusqu'a l'ordre contraire). */
  unboundable?: boolean;
  /** Identifiant de message preenregistre exige (haut-parleur). */
  clip?: boolean;
}

/** Catalogue : actions possibles par type, plafonds de duree, action sure, sensibilite (raison + mot de passe). */
export const CATALOG: Record<ActuatorType, { actions: Record<string, ActionSpec>; safe: string | null; sensitive: boolean; noAutoReturn?: boolean }> = {
  siren: { actions: { on: { timed: true, ceilingS: 600, defaultMaxS: 120, unboundable: true }, off: { timed: false } }, safe: 'off', sensitive: false },
  light: { actions: { on: { timed: true, ceilingS: 3600, defaultMaxS: 600, unboundable: true }, off: { timed: false } }, safe: 'off', sensitive: false },
  relay: {
    actions: { on: { timed: true, ceilingS: 3600, defaultMaxS: 600, unboundable: true }, off: { timed: false }, pulse: { timed: true, ceilingS: 10, defaultMaxS: 10 } },
    safe: 'off',
    sensitive: false,
  },
  lock: { actions: { unlock: { timed: true, ceilingS: 3600, defaultMaxS: 10, unboundable: true }, lock: { timed: false } }, safe: 'lock', sensitive: true },
  // Pas de retour automatique : fermer d'office une barriere sur un vehicule ou une personne est plus dangereux (docs, 4.8).
  // `stop` est tout de meme l'action sure (immediate, sans raison ni mot de passe, limite de debit a part) : arreter une
  // barriere en mouvement ne doit jamais etre plus difficile que la declencher.
  gate: { actions: { open: { timed: true, ceilingS: 10, defaultMaxS: 10 }, close: { timed: true, ceilingS: 10, defaultMaxS: 10 }, stop: { timed: false } }, safe: 'stop', sensitive: true, noAutoReturn: true },
  speaker: { actions: { play: { timed: true, ceilingS: 300, defaultMaxS: 60, clip: true }, stop: { timed: false } }, safe: 'stop', sensitive: false },
};
const TYPES = Object.keys(CATALOG) as ActuatorType[];
const ROLES: Role[] = ['operator', 'admin'];

/** Action decrite par le catalogue, ou undefined : jamais une cle heritee d'Object.prototype (« constructor »...). */
const specOf = (type: ActuatorType, action: string): ActionSpec | undefined => (Object.hasOwn(CATALOG[type].actions, action) ? CATALOG[type].actions[action] : undefined);

/** Action sure d'un type : jamais « lock » pour une issue de secours (elle n'a alors aucune action sure). */
const safeActionOf = (type: ActuatorType, emergencyExit: boolean): string | null => (type === 'lock' && emergencyExit ? null : CATALOG[type].safe);

export const ACK_TIMEOUT_DEFAULT_S = 5;
export const TTL_DEFAULT_S = 10;
/** Commandes acceptees par minute, par utilisateur et par actionneur (l'action sure a sa propre limite, plus large). */
export const RATE_PER_MIN = 4;
export const SAFE_RATE_PER_MIN = 12;
const MAX_REASON = 200;
const MAX_ACTUATORS = 200;
/** Retour a l'etat sur prevu avant un arret du PSIM : abandonne s'il date de plus d'un jour (l'equipement s'est arrete seul). */
const STALE_RETURN_MS = 24 * 3600_000;
/** Retour automatique en echec : 5 envois au plus (le premier compris), 5 s entre deux, et plus rien passe ce delai. */
export const RETURN_MAX_TRIES = 5;
const RETURN_RETRY_DELAY_MS = 5_000;
const RETURN_RETRY_WINDOW_MS = 10 * 60_000;
const AUDIT_THROTTLE_MS = 60_000;

export const ACTUATOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS actuator (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('siren', 'light', 'relay', 'lock', 'gate', 'speaker')),
  zone TEXT NOT NULL DEFAULT '',
  floor_id INTEGER,
  transport TEXT NOT NULL CHECK (transport IN ('mqtt', 'http')),
  transport_config TEXT NOT NULL DEFAULT '{}',
  transport_secret TEXT,
  actions TEXT NOT NULL,
  safe_action TEXT,
  confirm TEXT NOT NULL DEFAULT 'simple' CHECK (confirm IN ('simple', 'reauth')),
  emergency_exit INTEGER NOT NULL DEFAULT 0,
  sensitive INTEGER NOT NULL DEFAULT 0,
  ack_timeout_s INTEGER NOT NULL DEFAULT 5,
  ttl_s INTEGER NOT NULL DEFAULT 10,
  key_sealed TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER,
  updated_by TEXT
);
-- Historique des commandes : jamais relu pour envoyer quoi que ce soit (pas de file, pas de rejeu au demarrage).
-- Pas de cle etrangere : l'historique survit a la suppression de l'actionneur.
CREATE TABLE IF NOT EXISTS actuator_command (
  id TEXT PRIMARY KEY,
  actuator_id TEXT NOT NULL,
  action TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  duration_s INTEGER,
  requested_by TEXT NOT NULL,
  reason TEXT,
  incident_id INTEGER,
  auto INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'acked', 'refused', 'failed', 'expired', 'cancelled')),
  requested_at INTEGER NOT NULL,
  sent_at INTEGER,
  ack_deadline INTEGER,
  acked_at INTEGER,
  finished_at INTEGER,
  ts INTEGER,
  ttl_s INTEGER,
  ack TEXT,
  ack_kind TEXT,
  uncertain INTEGER NOT NULL DEFAULT 0,
  late_ack TEXT,
  late_ack_at INTEGER,
  off_due_at INTEGER,
  off_cmd_id TEXT,
  cancelled_by TEXT,
  cancelled_at INTEGER
);
CREATE INDEX IF NOT EXISTS actuator_command_by_actuator ON actuator_command(actuator_id, requested_at);
CREATE INDEX IF NOT EXISTS actuator_command_in_flight ON actuator_command(state) WHERE state IN ('pending', 'sent');
CREATE INDEX IF NOT EXISTS actuator_command_returns ON actuator_command(off_due_at) WHERE off_due_at IS NOT NULL AND off_cmd_id IS NULL;
-- Reessais du retour automatique (tick) : seules les commandes automatiques en echec figurent dans cet index.
CREATE INDEX IF NOT EXISTS actuator_command_failed_auto ON actuator_command(finished_at) WHERE auto = 1 AND state IN ('failed', 'refused', 'expired');
CREATE INDEX IF NOT EXISTS actuator_command_by_parent ON actuator_command(parent_id) WHERE parent_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS actuator_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  locked INTEGER NOT NULL DEFAULT 0,
  locked_by TEXT,
  locked_at INTEGER,
  reason TEXT
);
`;

/**
 * Migration : tables nouvelles (CREATE ... IF NOT EXISTS), aucune table des autres modules n'est touchee. Une base de
 * developpement qui aurait deja la table `actuator` d'avant la colonne `sensitive` la gagne (ALTER protege par table_info).
 */
export function migrateActuators(db: DatabaseSync): void {
  db.exec(ACTUATOR_SCHEMA);
  const columns = db.prepare('PRAGMA table_info(actuator)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'sensitive')) db.exec('ALTER TABLE actuator ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0');
}

export interface ActionConfig {
  minS?: number;
  maxS?: number;
  roles: Role[];
  unbounded?: boolean;
}

export interface ActuatorView {
  id: string;
  name: string;
  type: ActuatorType;
  zone: string;
  floorId: number | null;
  transport: 'mqtt' | 'http';
  /** HTTP : requetes (sans le secret) ; `hasSecret` dit seulement si un en-tete secret est enregistre. */
  http: (HttpTransportConfig & { hasSecret: boolean }) | null;
  actions: Record<string, ActionConfig>;
  safeAction: string | null;
  confirm: 'simple' | 'reauth';
  /** Type sensible (serrure, portail) OU actionneur declare « sensible » : raison, mot de passe, jamais de HTTP. */
  sensitive: boolean;
  emergencyExit: boolean;
  ackTimeoutS: number;
  ttlS: number;
  keyVersion: number;
  active: boolean;
  createdAt: number;
  createdBy: string;
  updatedAt: number | null;
  updatedBy: string | null;
  /** MQTT : une passerelle autorisee ecoute-t-elle ses ordres ? null = sans objet (HTTP). */
  linkUp: boolean | null;
}

export interface CommandView {
  cmdId: string;
  actuatorId: string;
  action: string;
  params: CommandParams;
  durationS: number | null;
  requestedBy: string;
  reason: string | null;
  incidentId: number | null;
  auto: boolean;
  parentId: string | null;
  state: CommandState;
  requestedAt: number;
  sentAt: number | null;
  ackedAt: number | null;
  finishedAt: number | null;
  ack: string | null;
  /** `signed` : accuse signe de l'equipement ; `http` : code 2xx du relais (reception, pas preuve d'execution). */
  ackKind: 'signed' | 'http' | null;
  /** Echec sans reponse : l'ordre a PU etre execute. */
  uncertain: boolean;
  lateAck: string | null;
  lateAckAt: number | null;
  offDueAt: number | null;
  offCmdId: string | null;
  cancelledBy: string | null;
  cancelledAt: number | null;
  /**
   * Le retour automatique a l'etat sur de cette commande a echoue (au moins un envoi, 5 essais epuises, aucun accuse) :
   * l'equipement peut etre reste dans l'etat de la commande. Calcule a la lecture, jamais stocke.
   */
  returnUnconfirmed: boolean;
}

export interface MqttCommandLink {
  /** Clients de passerelle autorises abonnes aux ordres de cet actionneur. */
  listeners(actuatorId: string): number;
  publishCommand(actuatorId: string, payload: Buffer): Promise<void>;
}

export interface ActuatorsDeps {
  db: DatabaseSync;
  /** Cle de chiffrement des secrets (server/secrets.ts). */
  key: Buffer;
  audit: (actor: string, action: string, ref?: { incidentId?: number; deviceId?: string; details?: string }) => void;
  publish: (event: PsimEvent) => void;
  httpAllow: HttpAllow;
  /** Statut d'un incident (null = inconnu). */
  incidentStatus?: (id: number) => string | null;
  now?: () => number;
}

type Row = Record<string, unknown>;
const IN_FLIGHT = "('pending', 'sent')";

function cleanText(value: unknown, field: string, max: number, required: boolean): string {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
  if (value !== undefined && value !== null && typeof value !== 'string') throw new PsimError(400, `${field} : texte attendu`);
  if (required && !text) throw new PsimError(400, `${field} : requis`);
  if (text.length > max) throw new PsimError(400, `${field} : ${max} caracteres au plus`);
  return text;
}

const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** Parametres canoniques (cles dans un ordre fixe) : sert au dedoublonnage. */
const canonicalParams = (p: CommandParams): string => JSON.stringify({ ...(p.durationS !== undefined ? { durationS: p.durationS } : {}), ...(p.clip !== undefined ? { clip: p.clip } : {}) });

function describeDuration(s: number | null): string {
  if (s === null) return 'sans limite de duree';
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

export function createActuators(deps: ActuatorsDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  migrateActuators(db);
  let mqtt: MqttCommandLink | null = null;
  const incidentStatus =
    deps.incidentStatus ?? ((id: number) => (db.prepare('SELECT status FROM incident WHERE id = ?').get(id) as { status: string } | undefined)?.status ?? null);
  const lastInvalidAudit = new Map<string, number>();
  /** Retours automatiques deja signales « en attente de liaison » (une seule entree de journal par retour). */
  const waitingForLink = new Set<string>();

  // ---------------------------------------------------------------- lecture

  function actuatorRow(id: string): Row | null {
    if (typeof id !== 'string' || !ACTUATOR_ID.test(id)) return null;
    return (db.prepare('SELECT * FROM actuator WHERE id = ?').get(id) as Row | undefined) ?? null;
  }

  function linkUp(r: Row): boolean | null {
    if (r.transport !== 'mqtt') return null;
    return (mqtt?.listeners(r.id as string) ?? 0) > 0;
  }

  /** Action sure d'un enregistrement : recalculee depuis le type, jamais lue dans la colonne (une base modifiee a la main n'y change rien). */
  const safeOf = (r: Row): string | null => safeActionOf(r.type as ActuatorType, r.emergency_exit === 1);
  /** Sensible : par son type (serrure, portail) ou declare tel par l'administrateur. */
  const sensitiveOf = (r: Row): boolean => CATALOG[r.type as ActuatorType].sensitive || r.sensitive === 1;

  function toView(r: Row): ActuatorView {
    const type = r.type as ActuatorType;
    const http = r.transport === 'http' ? { ...(JSON.parse(r.transport_config as string) as HttpTransportConfig), hasSecret: Boolean(r.transport_secret) } : null;
    const actions = JSON.parse(r.actions as string) as Record<string, ActionConfig>;
    const safe = safeOf(r);
    // L'action sure est toujours disponible, a tous les roles (meme si la base dit autre chose).
    if (safe) actions[safe] = { ...(Object.hasOwn(actions, safe) ? actions[safe] : {}), roles: [...ROLES] };
    return {
      id: r.id as string,
      name: r.name as string,
      type,
      zone: r.zone as string,
      floorId: (r.floor_id as number | null) ?? null,
      transport: r.transport as 'mqtt' | 'http',
      http,
      actions,
      safeAction: safe,
      confirm: r.confirm as 'simple' | 'reauth',
      sensitive: sensitiveOf(r),
      emergencyExit: r.emergency_exit === 1,
      ackTimeoutS: r.ack_timeout_s as number,
      ttlS: r.ttl_s as number,
      keyVersion: r.key_version as number,
      active: r.active === 1,
      createdAt: r.created_at as number,
      createdBy: r.created_by as string,
      updatedAt: (r.updated_at as number | null) ?? null,
      updatedBy: (r.updated_by as string | null) ?? null,
      linkUp: linkUp(r),
    };
  }

  function commandView(r: Row): CommandView {
    return {
      cmdId: r.id as string,
      actuatorId: r.actuator_id as string,
      action: r.action as string,
      params: JSON.parse(r.params as string) as CommandParams,
      durationS: (r.duration_s as number | null) ?? null,
      requestedBy: r.requested_by as string,
      reason: (r.reason as string | null) ?? null,
      incidentId: (r.incident_id as number | null) ?? null,
      auto: r.auto === 1,
      parentId: (r.parent_id as string | null) ?? null,
      state: r.state as CommandState,
      requestedAt: r.requested_at as number,
      sentAt: (r.sent_at as number | null) ?? null,
      ackedAt: (r.acked_at as number | null) ?? null,
      finishedAt: (r.finished_at as number | null) ?? null,
      ack: (r.ack as string | null) ?? null,
      ackKind: (r.ack_kind as 'signed' | 'http' | null) ?? null,
      uncertain: r.uncertain === 1,
      lateAck: (r.late_ack as string | null) ?? null,
      lateAckAt: (r.late_ack_at as number | null) ?? null,
      offDueAt: (r.off_due_at as number | null) ?? null,
      offCmdId: (r.off_cmd_id as string | null) ?? null,
      cancelledBy: (r.cancelled_by as string | null) ?? null,
      cancelledAt: (r.cancelled_at as number | null) ?? null,
      returnUnconfirmed: r.auto !== 1 && typeof r.off_cmd_id === 'string' && CMD_ID.test(r.off_cmd_id) && returnUnconfirmed(r.id as string),
    };
  }

  /** Envois du retour automatique (ou de l'arret anticipe) decide pour une commande, dans l'ordre. */
  const returnAttempts = (parentId: string): Row[] => db.prepare('SELECT id, state, late_ack FROM actuator_command WHERE parent_id = ? AND auto = 1 ORDER BY rowid').all(parentId) as Row[];
  /** Un accuse (ou un accuse tardif « done ») prouve que l'ordre est passe. */
  const confirmed = (r: Row): boolean => r.state === 'acked' || (typeof r.late_ack === 'string' && r.late_ack.startsWith('done'));
  const failedState = (r: Row): boolean => r.state === 'failed' || r.state === 'refused' || r.state === 'expired';
  /** Les 5 essais sont epuises, le dernier a echoue, aucun n'a ete accuse : l'equipement a pu rester dans l'etat de la commande. */
  function returnUnconfirmed(parentId: string): boolean {
    const rows = returnAttempts(parentId);
    return rows.length >= RETURN_MAX_TRIES && failedState(rows[rows.length - 1]) && !rows.some(confirmed);
  }

  const commandRow = (cmdId: string): Row | null =>
    typeof cmdId === 'string' && CMD_ID.test(cmdId) ? ((db.prepare('SELECT * FROM actuator_command WHERE id = ?').get(cmdId) as Row | undefined) ?? null) : null;

  function publishCommand(cmdId: string): void {
    const r = commandRow(cmdId);
    if (r) deps.publish({ type: 'command', command: commandView(r) });
  }

  function lockState(): { locked: boolean; by: string | null; at: number | null; reason: string | null } {
    const r = db.prepare('SELECT * FROM actuator_lock WHERE id = 1').get() as Row | undefined;
    return { locked: r?.locked === 1, by: (r?.locked_by as string | null) ?? null, at: (r?.locked_at as number | null) ?? null, reason: (r?.reason as string | null) ?? null };
  }

  // ---------------------------------------------------------------- configuration (administrateur)

  function cleanActions(type: ActuatorType, input: unknown, emergencyExit: boolean): Record<string, ActionConfig> {
    const source: Record<string, unknown> =
      input === undefined || input === null
        ? Object.fromEntries(Object.keys(CATALOG[type].actions).filter((a) => !(emergencyExit && a === 'lock')).map((a) => [a, {}]))
        : typeof input === 'object' && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : (() => {
              throw new PsimError(400, 'actions : objet { <action>: { maxS, minS, roles, unbounded } } attendu');
            })();
    const out: Record<string, ActionConfig> = {};
    for (const [action, raw] of Object.entries(source)) {
      // Object.hasOwn (via specOf) : « constructor », « toString », « __proto__ » ne sont pas des actions
      const spec = specOf(type, action);
      if (!spec) throw new PsimError(400, `actions : « ${action.slice(0, 20)} » n'existe pas pour le type ${type} (${Object.keys(CATALOG[type].actions).join(', ')})`);
      if (emergencyExit && action === 'lock') throw new PsimError(400, 'Issue de secours : le PSIM ne doit jamais pouvoir la verrouiller (action lock interdite)');
      const cfg = (raw ?? {}) as Record<string, unknown>;
      if (typeof cfg !== 'object' || Array.isArray(cfg)) throw new PsimError(400, `actions.${action} : objet attendu`);
      const roles = cfg.roles === undefined ? [...ROLES] : cfg.roles;
      if (!Array.isArray(roles) || roles.length === 0 || roles.some((r) => !ROLES.includes(r as Role))) throw new PsimError(400, `actions.${action}.roles : operator et / ou admin`);
      const entry: ActionConfig = { roles: [...new Set(roles as Role[])] };
      if (spec.timed) {
        const ceiling = spec.ceilingS!;
        const minS = cfg.minS === undefined ? 1 : cfg.minS;
        const maxS = cfg.maxS === undefined ? spec.defaultMaxS! : cfg.maxS;
        if (!intIn(minS, 1, ceiling)) throw new PsimError(400, `actions.${action}.minS : entier de 1 a ${ceiling}`);
        if (!intIn(maxS, minS, ceiling)) throw new PsimError(400, `actions.${action}.maxS : entier de ${minS} a ${ceiling} s (plafond du type ${type})`);
        entry.minS = minS;
        entry.maxS = maxS;
        if (cfg.unbounded !== undefined && cfg.unbounded !== false) {
          if (cfg.unbounded !== true || !spec.unboundable) throw new PsimError(400, `actions.${action}.unbounded : impossible pour cette action (duree toujours bornee)`);
          entry.unbounded = true;
        }
      } else if (cfg.maxS !== undefined || cfg.minS !== undefined || cfg.unbounded !== undefined) {
        throw new PsimError(400, `actions.${action} : action instantanee, sans duree`);
      }
      out[action] = entry;
    }
    if (Object.keys(out).length === 0) throw new PsimError(400, 'actions : au moins une action');
    // L'action sure est toujours disponible ET toujours permise a operator + admin, quoi que dise la configuration : arreter
    // une sirene, reverrouiller une serrure, arreter une barriere ne doit jamais devenir impossible pour un operateur.
    const safe = safeActionOf(type, emergencyExit);
    if (safe) out[safe] = { roles: [...ROLES] };
    return out;
  }

  interface Cleaned {
    name: string;
    zone: string;
    floorId: number | null;
    transport: 'mqtt' | 'http';
    transportConfig: string;
    secret: string | null | undefined;
    actions: Record<string, ActionConfig>;
    safeAction: string | null;
    confirm: 'simple' | 'reauth';
    emergencyExit: boolean;
    /** Declare « sensible » par l'administrateur (le type serrure / portail l'est de toute facon). */
    sensitive: boolean;
    ackTimeoutS: number;
    ttlS: number;
    active: boolean;
  }

  function clean(type: ActuatorType, input: Record<string, unknown>, previous: ActuatorView | null, previousDeclared = false): Cleaned {
    const pick = <T>(key: string, fallback: T): unknown => (input[key] === undefined ? fallback : input[key]);
    const name = cleanText(pick('name', previous?.name), 'name', 80, true);
    const zone = cleanText(pick('zone', previous?.zone ?? ''), 'zone', 60, false);
    const floorRaw = pick('floorId', previous?.floorId ?? null);
    if (floorRaw !== null && !intIn(floorRaw, 1, Number.MAX_SAFE_INTEGER)) throw new PsimError(400, 'floorId : identifiant d etage ou null');
    if (floorRaw !== null && !db.prepare('SELECT 1 AS x FROM floor WHERE id = ?').get(floorRaw)) throw new PsimError(400, 'floorId : etage inconnu');
    const transport = pick('transport', previous?.transport);
    if (transport !== 'mqtt' && transport !== 'http') throw new PsimError(400, 'transport : mqtt ou http');
    const emergencyRaw = pick('emergencyExit', previous?.emergencyExit ?? false);
    if (typeof emergencyRaw !== 'boolean') throw new PsimError(400, 'emergencyExit : vrai ou faux');
    if (emergencyRaw && type !== 'lock') throw new PsimError(400, 'emergencyExit : seulement pour une serrure (type lock)');
    const actions = cleanActions(type, input.actions === undefined ? previous?.actions : input.actions, emergencyRaw);
    if (emergencyRaw && actions.lock) throw new PsimError(400, 'Issue de secours : action lock interdite');
    const confirmRaw = pick('confirm', previous?.confirm ?? 'simple');
    if (confirmRaw !== 'simple' && confirmRaw !== 'reauth') throw new PsimError(400, 'confirm : simple ou reauth');
    const sensitiveRaw = pick('sensitive', previousDeclared);
    if (typeof sensitiveRaw !== 'boolean') throw new PsimError(400, 'sensitive : vrai ou faux');
    const sensitive = CATALOG[type].sensitive || sensitiveRaw;
    // Serrures, portails et actionneurs declares sensibles : mot de passe redemande, jamais abaissable.
    const confirm = sensitive ? 'reauth' : confirmRaw;
    const ackTimeoutS = pick('ackTimeoutS', previous?.ackTimeoutS ?? ACK_TIMEOUT_DEFAULT_S);
    if (!intIn(ackTimeoutS, 1, 30)) throw new PsimError(400, 'ackTimeoutS : entier de 1 a 30');
    const ttlS = pick('ttlS', previous?.ttlS ?? TTL_DEFAULT_S);
    if (!intIn(ttlS, TTL_MIN_S, TTL_MAX_S)) throw new PsimError(400, `ttlS : entier de ${TTL_MIN_S} a ${TTL_MAX_S}`);
    const active = pick('active', previous?.active ?? true);
    if (typeof active !== 'boolean') throw new PsimError(400, 'active : vrai ou faux');
    let transportConfig = '{}';
    let secret: string | null | undefined;
    if (transport === 'http') {
      // Une serrure, un portail, un actionneur sensible : jamais en HTTP (requete en clair, rejouable, en-tete secret lisible).
      if (sensitive) throw new PsimError(400, 'Transport HTTP interdit pour une serrure, un portail ou un actionneur sensible : passer par le transport MQTT signe via une passerelle');
      const httpInput = input.http === undefined ? previous?.http : input.http;
      const cfg = cleanHttpConfig(httpInput, Object.keys(actions), deps.httpAllow);
      // Une action temporisee doit transmettre sa duree au relais : c'est elle qui l'eteint seul si le retour automatique echoue.
      for (const [action, ac] of Object.entries(actions)) {
        if (!specOf(type, action)?.timed || ac.unbounded) continue;
        const tpl = cfg.requests[action];
        if (!tpl.url.includes('{durationS}') && !(tpl.body ?? '').includes('{durationS}')) {
          throw new PsimError(400, `http.requests.${action} : action temporisee, l'adresse ou le corps doit contenir {durationS} (sinon le relais ne s'eteindra pas seul si le retour automatique echoue)`);
        }
      }
      transportConfig = JSON.stringify(cfg);
      const secretInput = (input.http as Record<string, unknown> | undefined)?.secretValue;
      if (secretInput !== undefined && secretInput !== null && secretInput !== '') {
        if (!cfg.secretHeader) throw new PsimError(400, 'http.secretValue : indiquer aussi secretHeader');
        secret = seal(deps.key, cleanSecretValue(secretInput));
      } else if (!cfg.secretHeader) secret = null;
    } else {
      if (input.http !== undefined && input.http !== null) throw new PsimError(400, 'http : seulement pour le transport http');
      secret = null;
    }
    return { name, zone, floorId: floorRaw as number | null, transport, transportConfig, secret, actions, safeAction: safeActionOf(type, emergencyRaw), confirm, emergencyExit: emergencyRaw, sensitive: sensitiveRaw, ackTimeoutS: ackTimeoutS as number, ttlS: ttlS as number, active };
  }

  const newKey = () => randomBytes(32).toString('hex');

  function create(actor: string, input: Record<string, unknown>): { actuator: ActuatorView; key: string } {
    const id = input.id;
    if (typeof id !== 'string' || !ACTUATOR_ID.test(id)) throw new PsimError(400, 'id : lettres, chiffres, - et _, 32 caracteres au plus');
    const type = input.type;
    if (typeof type !== 'string' || !TYPES.includes(type as ActuatorType)) throw new PsimError(400, `type : ${TYPES.join(', ')} (fumigene, PTZ et dock : pas encore pris en charge)`);
    if (actuatorRow(id)) throw new PsimError(409, 'Un actionneur porte deja cet identifiant');
    if ((db.prepare('SELECT COUNT(*) AS n FROM actuator').get() as { n: number }).n >= MAX_ACTUATORS) throw new PsimError(409, `${MAX_ACTUATORS} actionneurs au plus`);
    const c = clean(type as ActuatorType, input, null);
    const key = newKey();
    const t = now();
    db.prepare(
      `INSERT INTO actuator (id, name, type, zone, floor_id, transport, transport_config, transport_secret, actions, safe_action, confirm, emergency_exit, sensitive,
         ack_timeout_s, ttl_s, key_sealed, key_version, active, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(id, c.name, type, c.zone, c.floorId, c.transport, c.transportConfig, c.secret ?? null, JSON.stringify(c.actions), c.safeAction, c.confirm, c.emergencyExit ? 1 : 0, c.sensitive ? 1 : 0, c.ackTimeoutS, c.ttlS, seal(deps.key, key), c.active ? 1 : 0, t, actor);
    deps.audit(actor, 'actionneur_cree', { deviceId: id, details: describeConfig(type as ActuatorType, c) });
    deps.publish({ type: 'actuators' });
    return { actuator: toView(actuatorRow(id)!), key };
  }

  function describeConfig(type: ActuatorType, c: Cleaned): string {
    const actions = Object.entries(c.actions)
      .map(([a, cfg]) => `${a}${cfg.maxS !== undefined ? ` ${cfg.minS}-${cfg.maxS} s` : ''}${cfg.unbounded ? ' SANS LIMITE' : ''} [${cfg.roles.join('+')}]`)
      .join(', ');
    return `${type} « ${c.name} » via ${c.transport}${c.emergencyExit ? ', ISSUE DE SECOURS' : ''}${c.sensitive ? ', SENSIBLE' : ''}, ${c.active ? 'actif' : 'inactif'} ; actions : ${actions}`;
  }

  function update(actor: string, id: string, input: Record<string, unknown>): ActuatorView {
    const r = actuatorRow(id);
    if (!r) throw new PsimError(404, 'Actionneur introuvable');
    if (input.id !== undefined && input.id !== id) throw new PsimError(400, "L'identifiant ne change pas : supprimer et recreer");
    if (input.type !== undefined && input.type !== r.type) throw new PsimError(400, 'Le type ne change pas : supprimer et recreer');
    const previous = toView(r);
    const c = clean(r.type as ActuatorType, input, previous, r.sensitive === 1);
    db.prepare(
      `UPDATE actuator SET name = ?, zone = ?, floor_id = ?, transport = ?, transport_config = ?, transport_secret = ?, actions = ?, safe_action = ?, confirm = ?,
         emergency_exit = ?, sensitive = ?, ack_timeout_s = ?, ttl_s = ?, active = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
    ).run(
      c.name, c.zone, c.floorId, c.transport, c.transportConfig, c.secret === undefined ? ((r.transport_secret as string | null) ?? null) : c.secret,
      JSON.stringify(c.actions), c.safeAction, c.confirm, c.emergencyExit ? 1 : 0, c.sensitive ? 1 : 0, c.ackTimeoutS, c.ttlS, c.active ? 1 : 0, now(), actor, id,
    );
    deps.audit(actor, 'actionneur_modifie', { deviceId: id, details: describeConfig(r.type as ActuatorType, c) });
    if (!c.active && previous.active) cancelPending({ actuatorId: id }, actor, 'actionneur desactive');
    deps.publish({ type: 'actuators' });
    return toView(actuatorRow(id)!);
  }

  function remove(actor: string, id: string): void {
    const r = actuatorRow(id);
    if (!r) throw new PsimError(404, 'Actionneur introuvable');
    const busy = db.prepare(`SELECT 1 AS x FROM actuator_command WHERE actuator_id = ? AND state IN ${IN_FLIGHT}`).get(id);
    if (busy) throw new PsimError(409, 'Une commande est en cours : attendre son accuse avant de supprimer');
    // Retours a l'etat sur encore prevus : sans objet (plus de cle pour signer) ; l'equipement s'arrete seul (durationS).
    db.prepare("UPDATE actuator_command SET off_cmd_id = 'supprime' WHERE actuator_id = ? AND off_due_at IS NOT NULL AND off_cmd_id IS NULL").run(id);
    db.prepare('DELETE FROM actuator WHERE id = ?').run(id);
    deps.audit(actor, 'actionneur_supprime', { deviceId: id, details: `${r.type} « ${r.name} » (historique des commandes conserve)` });
    deps.publish({ type: 'actuators' });
  }

  function rotateKey(actor: string, id: string): { key: string; keyVersion: number } {
    const r = actuatorRow(id);
    if (!r) throw new PsimError(404, 'Actionneur introuvable');
    const key = newKey();
    db.prepare('UPDATE actuator SET key_sealed = ?, key_version = key_version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(seal(deps.key, key), now(), actor, id);
    const version = (actuatorRow(id)!.key_version as number) ?? 1;
    deps.audit(actor, 'actionneur_cle_renouvelee', { deviceId: id, details: `cle n°${version} (l'ancienne cesse immediatement)` });
    deps.publish({ type: 'actuators' });
    return { key, keyVersion: version };
  }

  function setLock(actor: string, locked: unknown, reasonRaw: unknown): ReturnType<typeof lockState> {
    if (typeof locked !== 'boolean') throw new PsimError(400, 'locked : vrai ou faux');
    const reason = cleanText(reasonRaw, 'reason', MAX_REASON, locked);
    const t = now();
    db.prepare(
      'INSERT INTO actuator_lock (id, locked, locked_by, locked_at, reason) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET locked = excluded.locked, locked_by = excluded.locked_by, locked_at = excluded.locked_at, reason = excluded.reason',
    ).run(locked ? 1 : 0, actor, t, reason || null);
    if (locked) {
      const skipped = db.prepare("UPDATE actuator_command SET off_cmd_id = 'verrou' WHERE off_due_at IS NOT NULL AND off_cmd_id IS NULL").run().changes;
      const retries = abandonRetries('verrou');
      deps.audit(actor, 'commandes_verrouillees', {
        details: `mode maintenance : seules l'action sure demandee a la main et l'arret anticipe partent${skipped ? ` ; ${skipped} retour(s) automatique(s) a l'etat sur annule(s), les equipements s'arretent seuls` : ''}${retries ? ` ; ${retries} reessai(s) de retour automatique abandonne(s)` : ''} ; raison : ${reason}`,
      });
      cancelPending({}, actor, 'mode maintenance');
    } else deps.audit(actor, 'commandes_deverrouillees', { details: reason ? `raison : ${reason}` : undefined });
    deps.publish({ type: 'actuators' });
    return lockState();
  }

  // ---------------------------------------------------------------- envoi

  function setState(cmdId: string, fields: Record<string, unknown>): void {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE actuator_command SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...(keys.map((k) => fields[k]) as never[]), cmdId);
  }

  function fail(cmdId: string, actuatorId: string, text: string, uncertain: boolean): void {
    const r = commandRow(cmdId);
    if (!r || (r.state !== 'sent' && r.state !== 'pending')) return;
    setState(cmdId, { state: 'failed', finished_at: now(), ack: text, uncertain: uncertain ? 1 : 0 });
    deps.audit('systeme', 'commande_echec', {
      deviceId: actuatorId,
      incidentId: (r.incident_id as number | null) ?? undefined,
      details: `${r.action} (cmd ${cmdId.slice(0, 8)}) : ${text}${uncertain ? " ; l'ordre a PU etre execute" : ''}`,
    });
    publishCommand(cmdId);
    noteReturnFailure(cmdId);
  }

  /** Refus decide par le PSIM lui-meme au moment d'envoyer : rien n'est parti, etat `refused`, motif au journal. */
  function refuse(cmdId: string, actuatorId: string, text: string): void {
    const r = commandRow(cmdId);
    if (!r || (r.state !== 'sent' && r.state !== 'pending')) return;
    setState(cmdId, { state: 'refused', finished_at: now(), ack: text, uncertain: 0 });
    deps.audit('systeme', 'commande_refusee', {
      deviceId: actuatorId,
      incidentId: (r.incident_id as number | null) ?? undefined,
      details: `${r.action} (cmd ${cmdId.slice(0, 8)}) : refusee par le PSIM, rien n'est parti : ${text}`,
    });
    publishCommand(cmdId);
    noteReturnFailure(cmdId);
  }

  /**
   * Dernier essai du retour automatique en echec : avertissement VISIBLE (journal + `returnUnconfirmed` de la commande
   * d'origine, republiee). Appelee a chaque passage d'une commande a l'echec : le dernier essai ne passe qu'une fois.
   */
  function noteReturnFailure(cmdId: string): void {
    const r = commandRow(cmdId);
    if (!r || r.auto !== 1 || typeof r.parent_id !== 'string') return;
    const attempts = returnAttempts(r.parent_id);
    if (attempts.length < RETURN_MAX_TRIES || attempts.some(confirmed) || attempts[attempts.length - 1].id !== cmdId) return;
    deps.audit('systeme', 'commande_echec', {
      deviceId: r.actuator_id as string,
      incidentId: (r.incident_id as number | null) ?? undefined,
      details: `retour a l'etat sur NON CONFIRME : « ${r.action} » apres la commande ${r.parent_id.slice(0, 8)}, ${attempts.length} essais sans accuse ; l'equipement peut etre reste dans l'etat de la commande, verifier sur place`,
    });
    publishCommand(r.parent_id);
  }

  const safely = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      console.error('[actionneurs]', err);
    }
  };

  /** Exception inattendue pendant un envoi : la commande est marquee en echec (incertaine), le PSIM continue. */
  function internalError(cmdId: string, actuatorId: string, err: unknown): void {
    console.error('[actionneurs] erreur interne :', err);
    safely(() => fail(cmdId, actuatorId, "erreur interne : la commande n'a pas pu etre suivie", true));
  }

  function onHttpOutcome(cmdId: string, actuatorId: string, outcome: HttpOutcome): void {
    const r = commandRow(cmdId);
    if (!r || r.state !== 'sent') return;
    if (outcome.kind === 'acked') {
      setState(cmdId, { state: 'acked', acked_at: now(), finished_at: now(), ack: `HTTP ${outcome.status}`, ack_kind: 'http' });
      deps.audit('systeme', 'commande_accusee', { deviceId: actuatorId, incidentId: (r.incident_id as number | null) ?? undefined, details: `${r.action} (cmd ${cmdId.slice(0, 8)}) : HTTP ${outcome.status} (recu par le relais)` });
      publishCommand(cmdId);
    } else if (outcome.kind === 'rejected') fail(cmdId, actuatorId, `refus du relais (HTTP ${outcome.status})`, false);
    else if (outcome.kind === 'not_delivered') fail(cmdId, actuatorId, `non remise : ${outcome.error}`, false);
    else fail(cmdId, actuatorId, `aucun accuse : ${outcome.error}`, true);
  }

  /**
   * Un seul envoi. La commande est deja journalisee (`commande_demandee`). Etat `sent` et `commande_envoyee` sont ecrits
   * AVANT de remettre le message au transport (un accuse ne peut donc jamais arriver avant).
   */
  function dispatch(cmdId: string): void {
    const c = commandRow(cmdId)!;
    const a = actuatorRow(c.actuator_id as string);
    if (!a) return fail(cmdId, c.actuator_id as string, 'actionneur supprime', false);
    const type = a.type as ActuatorType;
    const safe = safeOf(a);
    // Issue de secours : l'ordre « lock » ne part JAMAIS, quelle que soit la base (request() le verifie aussi : defense en profondeur).
    if (type === 'lock' && a.emergency_exit === 1 && c.action === 'lock') return refuse(cmdId, a.id as string, "issue de secours : l'ordre « lock » n'est jamais envoye");
    // Serrure, portail, actionneur sensible : jamais en HTTP (requete en clair, rejouable). Seule l'action sure peut encore partir
    // (un enregistrement ancien ne doit pas empecher de reverrouiller ; la rejouer est inoffensif).
    if (a.transport === 'http' && sensitiveOf(a) && c.action !== safe) {
      return refuse(cmdId, a.id as string, 'transport HTTP interdit pour une serrure, un portail ou un actionneur sensible : passer par le transport MQTT signe via une passerelle');
    }
    const t = now();
    const params = JSON.parse(c.params as string) as CommandParams;
    const durationS = (c.duration_s as number | null) ?? null;
    // Retour a l'etat sur planifie des l'envoi, meme sans accuse : l'equipement a pu executer. Jamais pour un portail (docs, 4.8).
    const offDue = durationS !== null && safe && safe !== c.action && !CATALOG[type].noAutoReturn ? t + durationS * 1000 + 1000 : null;
    let keyHex: string;
    try {
      keyHex = unseal(deps.key, a.key_sealed as string);
    } catch {
      return fail(cmdId, a.id as string, 'cle de signature illisible (cle de chiffrement du PSIM changee ?) : renouveler la cle', false);
    }
    const message = signCommand(keyHex, a.id as string, { cmdId, action: c.action as string, params, ts: t, ttlS: a.ttl_s as number });
    // Un nouvel ordre remplace les retours automatiques encore prevus pour cet actionneur (sa propre duree fait foi).
    db.prepare("UPDATE actuator_command SET off_cmd_id = 'remplace' WHERE actuator_id = ? AND off_due_at IS NOT NULL AND off_cmd_id IS NULL AND id <> ?").run(a.id as string, cmdId);
    setState(cmdId, { state: 'sent', sent_at: t, ts: t, ttl_s: a.ttl_s, ack_deadline: t + (a.ack_timeout_s as number) * 1000, off_due_at: offDue });
    deps.audit('systeme', 'commande_envoyee', {
      deviceId: a.id as string,
      incidentId: (c.incident_id as number | null) ?? undefined,
      details: `${c.action} (cmd ${cmdId.slice(0, 8)}) via ${a.transport}${offDue ? ` ; retour a « ${safe} » prevu dans ${durationS} s` : ''}`,
    });
    publishCommand(cmdId);
    // Une exception (base, JSON...) apres l'envoi ne doit jamais arreter le PSIM : la commande passe en echec incertain.
    try {
      if (a.transport === 'mqtt') {
        if (!mqtt) return fail(cmdId, a.id as string, 'broker MQTT indisponible', false);
        mqtt
          .publishCommand(a.id as string, Buffer.from(JSON.stringify(message)))
          .catch((err: unknown) => safely(() => fail(cmdId, a.id as string, `publication impossible (${String((err as Error)?.message ?? err).slice(0, 80)})`, false)));
        return;
      }
      const config = JSON.parse(a.transport_config as string) as HttpTransportConfig;
      let secret: string | null = null;
      if (a.transport_secret) {
        try {
          secret = unseal(deps.key, a.transport_secret as string);
        } catch {
          return fail(cmdId, a.id as string, 'secret HTTP illisible : le ressaisir', false);
        }
      }
      const values = { action: message.action, durationS: params.durationS === undefined ? '' : String(params.durationS), clip: params.clip ?? '', cmdId, ts: String(t), sig: message.sig };
      void sendHttp(config, message.action, values, secret, deps.httpAllow, (a.ack_timeout_s as number) * 1000)
        .then((outcome) => onHttpOutcome(cmdId, a.id as string, outcome))
        .catch((err: unknown) => internalError(cmdId, a.id as string, err));
    } catch (err) {
      internalError(cmdId, a.id as string, err);
    }
  }

  /** Cree la commande (journalisee) puis l'envoie. `auto` : retour a l'etat sur decide par le PSIM. */
  function createAndDispatch(a: Row, fields: { action: string; params: CommandParams; requestedBy: string; reason: string | null; incidentId: number | null; auto: boolean; parentId: string | null }): string {
    const cmdId = randomBytes(16).toString('hex');
    const durationS = fields.params.durationS ?? null;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO actuator_command (id, actuator_id, action, params, duration_s, requested_by, reason, incident_id, auto, parent_id, state, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(cmdId, a.id as string, fields.action, canonicalParams(fields.params), durationS, fields.requestedBy, fields.reason, fields.incidentId, fields.auto ? 1 : 0, fields.parentId, now());
      // Journal scelle AVANT tout envoi : si l'ecriture echoue, rien ne part.
      deps.audit(fields.requestedBy, 'commande_demandee', {
        deviceId: a.id as string,
        incidentId: fields.incidentId ?? undefined,
        details: `${fields.action}${specOf(a.type as ActuatorType, fields.action)?.timed ? ` ${describeDuration(durationS)}` : ''}${fields.params.clip ? ` message ${fields.params.clip}` : ''} sur « ${a.name} » (cmd ${cmdId.slice(0, 8)})${fields.auto ? ' : retour automatique a l etat sur' : ''}${fields.reason ? ` ; raison : ${fields.reason}` : ''}`,
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    dispatch(cmdId);
    return cmdId;
  }

  // ---------------------------------------------------------------- commande (operateur / administrateur)

  function cleanParams(a: ActuatorView, action: string, raw: unknown): CommandParams {
    const spec = specOf(a.type, action)!;
    const cfg = a.actions[action];
    const input = raw === undefined || raw === null ? {} : raw;
    if (typeof input !== 'object' || Array.isArray(input)) throw new PsimError(400, 'params : objet attendu');
    const o = input as Record<string, unknown>;
    for (const k of Object.keys(o)) if (k !== 'durationS' && k !== 'clip') throw new PsimError(400, `params : « ${k.slice(0, 20)} » inconnu (durationS, clip)`);
    const params: CommandParams = {};
    if (spec.timed) {
      if (o.durationS === undefined || o.durationS === null) {
        // Garde-fou : jamais d'ordre permanent, sauf action declaree sans limite par un administrateur.
        if (!cfg.unbounded) throw new PsimError(400, `durationS requis : ${cfg.minS} a ${cfg.maxS} s`);
      } else {
        if (!intIn(o.durationS, cfg.minS ?? 1, cfg.maxS ?? 1)) throw new PsimError(400, `durationS : entier de ${cfg.minS} a ${cfg.maxS} s`);
        params.durationS = o.durationS;
      }
    } else if (o.durationS !== undefined) throw new PsimError(400, `${action} : action instantanee, sans duree`);
    if (spec.clip) {
      if (typeof o.clip !== 'string' || !CLIP.test(o.clip)) throw new PsimError(400, 'clip : identifiant du message preenregistre requis (lettres, chiffres, - et _)');
      params.clip = o.clip;
    } else if (o.clip !== undefined) throw new PsimError(400, 'clip : seulement pour le haut-parleur (play)');
    return params;
  }

  function request(user: { username: string; role: Role }, id: string, body: Record<string, unknown>): { status: 200 | 201; command: CommandView; deduplicated?: true } {
    const r = actuatorRow(id);
    if (!r) throw new PsimError(404, 'Actionneur introuvable');
    const a = toView(r);
    const action = body.action;
    // Object.hasOwn : « constructor », « toString », « __proto__ » ne sont jamais des actions (400, jamais un ordre signe).
    if (typeof action !== 'string' || !Object.hasOwn(a.actions, action) || !specOf(a.type, action)) throw new PsimError(400, `action : ${Object.keys(a.actions).join(', ')}`);
    // Issue de secours : verifie ici aussi, quelle que soit la configuration enregistree (base modifiee a la main).
    if (a.type === 'lock' && a.emergencyExit && action === 'lock') throw new PsimError(403, 'Issue de secours : le PSIM ne la verrouille jamais');
    // Action sure : immediate, permise a operator + admin, hors verrou, sans raison ni mot de passe, limite de debit a part.
    const isSafe = action === a.safeAction;
    if (!a.actions[action].roles.includes(user.role)) throw new PsimError(403, 'Droits insuffisants pour cette action');
    if (body.confirm !== true) throw new PsimError(428, 'Confirmation explicite requise (confirm: true)');
    const reason = cleanText(body.reason, 'reason', MAX_REASON, false);
    // Serrure, portail, actionneur sensible : raison obligatoire, sauf pour l'action sure (reverrouiller, arreter doivent rester immediats).
    if (a.sensitive && !reason && !isSafe) throw new PsimError(428, 'Raison obligatoire pour une serrure, un portail ou un actionneur sensible');
    const params = cleanParams(a, action, body.params);
    let incidentId: number | null = null;
    if (body.incidentId !== undefined && body.incidentId !== null) {
      if (!intIn(body.incidentId, 1, Number.MAX_SAFE_INTEGER)) throw new PsimError(400, 'incidentId invalide');
      const status = incidentStatus(body.incidentId);
      if (status === null) throw new PsimError(404, 'Incident introuvable');
      if (status === 'closed') throw new PsimError(409, 'Incident clos : plus de commande en son nom');
      incidentId = body.incidentId;
    }
    // Mode maintenance : tout est refuse SAUF l'action sure demandee a la main (faire cesser une action ne doit jamais etre impossible).
    if (lockState().locked && !isSafe) throw new PsimError(409, 'Commandes verrouillees (mode maintenance)');
    if (!a.active) throw new PsimError(409, 'Actionneur desactive');
    if (a.linkUp === false) throw new PsimError(409, "Liaison coupee : aucune passerelle autorisee n'ecoute cet actionneur");
    // Re-authentification AVANT le dedoublonnage : sinon la reponse « deja en cours » dispenserait de prouver son identite.
    // Compteur d'echecs PARTAGE avec la connexion (server/reauth.ts). L'action sure reste immediate.
    if (a.confirm === 'reauth' && !isSafe) reauthenticate(db, user.username, body.password, deps.audit, { what: `commande ${action}`, failAction: 'commande_reauth_echec', deviceId: a.id });
    // Double-clic, double envoi : la commande identique deja en vol est renvoyee, rien n'est reemis. Jamais celle d'un AUTRE compte
    // (sa raison, son nom ne regardent pas ce compte) : 409 sans rien reveler.
    const same = db
      .prepare(`SELECT * FROM actuator_command WHERE actuator_id = ? AND action = ? AND params = ? AND auto = 0 AND state IN ${IN_FLIGHT} ORDER BY requested_at DESC LIMIT 1`)
      .get(a.id, action, canonicalParams(params)) as Row | undefined;
    if (same) {
      if (same.requested_by !== user.username) throw new PsimError(409, 'Commande identique deja en cours par un autre compte');
      return { status: 200, command: commandView(same), deduplicated: true };
    }
    const recent = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM actuator_command WHERE actuator_id = ? AND requested_by = ? AND auto = 0 AND requested_at > ? AND action ${isSafe ? '=' : '<>'} ?`)
        .get(a.id, user.username, now() - 60_000, a.safeAction ?? '') as { n: number }
    ).n;
    if (recent >= (isSafe ? SAFE_RATE_PER_MIN : RATE_PER_MIN)) throw new PsimError(429, `Trop de commandes sur cet actionneur : ${isSafe ? SAFE_RATE_PER_MIN : RATE_PER_MIN} par minute au plus`);
    const cmdId = createAndDispatch(r, { action, params, requestedBy: user.username, reason: reason || null, incidentId, auto: false, parentId: null });
    return { status: 201, command: commandView(commandRow(cmdId)!) };
  }

  /** Commande temporisee encore en cours (retour a l'etat sur pas encore parti) ou sans limite, arretable par l'action sure. */
  function running(c: Row, a: Row | null): boolean {
    const safe = a ? safeOf(a) : null;
    if (!a || !safe || c.action === safe || c.cancelled_at !== null) return false;
    if (c.state !== 'sent' && c.state !== 'acked') return false;
    if (c.duration_s === null) return true;
    // Retour prevu pas encore parti. En mode maintenance il est annule (« verrou ») mais l'equipement tourne jusqu'a la fin de sa duree : arretable.
    return c.off_due_at !== null && (c.off_cmd_id === null || c.off_cmd_id === 'verrou') && (c.off_due_at as number) > now();
  }

  /**
   * Arret anticipe : l'action sure part tout de suite, le retour planifie est retire. Renvoie la commande d'arret.
   * Permis en mode maintenance (c'est justement faire cesser une action en cours) ; les arrets automatiques (incident clos)
   * verifient eux-memes le verrou avant d'appeler.
   */
  function stopEarly(c: Row, a: Row, actor: string, why: string): string {
    setState(c.id as string, { cancelled_by: actor, cancelled_at: now() });
    const stopId = createAndDispatch(a, { action: safeOf(a) as string, params: {}, requestedBy: actor, reason: why, incidentId: (c.incident_id as number | null) ?? null, auto: true, parentId: c.id as string });
    setState(c.id as string, { off_cmd_id: stopId });
    deps.audit(actor, 'commande_annulee', { deviceId: a.id as string, incidentId: (c.incident_id as number | null) ?? undefined, details: `${c.action} (cmd ${(c.id as string).slice(0, 8)}) : arret anticipe (${why}), « ${safeOf(a)} » envoye` });
    publishCommand(c.id as string);
    return stopId;
  }

  function cancel(user: { username: string; role: Role }, cmdId: string): { command: CommandView; stop?: CommandView } {
    const c = commandRow(cmdId);
    if (!c) throw new PsimError(404, 'Commande introuvable');
    const a = actuatorRow(c.actuator_id as string);
    const actions = a ? (JSON.parse(a.actions as string) as Record<string, ActionConfig>) : null;
    const cfg = actions && Object.hasOwn(actions, c.action as string) ? actions[c.action as string] : null;
    if (user.role !== 'admin' && !cfg?.roles.includes(user.role)) throw new PsimError(403, 'Droits insuffisants pour cette commande');
    if (c.state === 'pending') {
      setState(cmdId, { state: 'cancelled', finished_at: now(), cancelled_by: user.username, cancelled_at: now(), ack: 'annulee avant envoi' });
      deps.audit(user.username, 'commande_annulee', { deviceId: c.actuator_id as string, details: `${c.action} (cmd ${cmdId.slice(0, 8)}) annulee avant envoi` });
      publishCommand(cmdId);
      return { command: commandView(commandRow(cmdId)!) };
    }
    if (a && running(c, a)) {
      if (a.transport === 'mqtt' && linkUp(a) === false) throw new PsimError(409, 'Liaison coupee : arret impossible (l equipement s arretera seul a la fin de sa duree)');
      const stopId = stopEarly(c, a, user.username, `arret demande par ${user.username}`);
      return { command: commandView(commandRow(cmdId)!), stop: commandView(commandRow(stopId)!) };
    }
    throw new PsimError(409, 'Commande terminee : rien a annuler');
  }

  /** Annule les commandes pas encore parties (`pending`) correspondant au filtre. */
  function cancelPending(filter: { actuatorId?: string; incidentId?: number }, actor: string, why: string): number {
    const rows = db
      .prepare(`SELECT id, actuator_id, action FROM actuator_command WHERE state = 'pending' ${filter.actuatorId ? 'AND actuator_id = ?' : ''} ${filter.incidentId ? 'AND incident_id = ?' : ''}`)
      .all(...([filter.actuatorId, filter.incidentId].filter((v) => v !== undefined) as never[])) as Row[];
    for (const r of rows) {
      setState(r.id as string, { state: 'cancelled', finished_at: now(), cancelled_by: actor, cancelled_at: now(), ack: why });
      deps.audit(actor, 'commande_annulee', { deviceId: r.actuator_id as string, details: `${r.action} (cmd ${(r.id as string).slice(0, 8)}) : ${why}` });
      publishCommand(r.id as string);
    }
    return rows.length;
  }

  /** Incident clos : commandes en attente annulees, commandes temporisees en cours ramenees a l'etat sur. */
  function incidentChanged(incidentId: number, status: string): void {
    if (status !== 'closed') return;
    cancelPending({ incidentId }, 'systeme', `incident n°${incidentId} clos`);
    if (lockState().locked) return;
    for (const c of db.prepare("SELECT * FROM actuator_command WHERE incident_id = ? AND state IN ('sent', 'acked') AND cancelled_at IS NULL AND auto = 0").all(incidentId) as Row[]) {
      const a = actuatorRow(c.actuator_id as string);
      if (a && running(c, a)) stopEarly(c, a, 'systeme', `incident n°${incidentId} clos`);
    }
  }

  // ---------------------------------------------------------------- accuses (MQTT)

  function noteInvalid(actuatorId: string, why: string): void {
    const t = now();
    if (t - (lastInvalidAudit.get(actuatorId) ?? 0) < AUDIT_THROTTLE_MS) return;
    lastInvalidAudit.set(actuatorId, t);
    if (lastInvalidAudit.size > 1000) lastInvalidAudit.clear();
    deps.audit('systeme', 'commande_accuse_invalide', { deviceId: actuatorId, details: `${why} : ignore (journalise une fois par minute au plus)` });
  }

  /**
   * Accuse recu sur `psim/actuators/<id>/ack` (le broker a deja verifie que le compte est autorise pour cet id).
   * Tout ce qui n'est pas un accuse signe, attendu et date de facon plausible est ignore.
   */
  function handleAck(actuatorId: string, raw: Buffer): void {
    const a = actuatorRow(actuatorId);
    if (!a || a.transport !== 'mqtt') return;
    let keyHex: string;
    try {
      keyHex = unseal(deps.key, a.key_sealed as string);
    } catch {
      return;
    }
    const ack = verifyAck(keyHex, actuatorId, raw);
    if (!ack) return noteInvalid(actuatorId, 'accuse mal forme ou signature fausse');
    const c = db.prepare('SELECT * FROM actuator_command WHERE id = ? AND actuator_id = ?').get(ack.cmdId, actuatorId) as Row | undefined;
    if (!c || c.ts === null) return noteInvalid(actuatorId, 'accuse signe pour une commande inconnue');
    const t = now();
    if (ack.ts < (c.ts as number) - CLOCK_SKEW_MS || ack.ts > t + CLOCK_SKEW_MS) return noteInvalid(actuatorId, 'accuse date de facon impossible');
    const text = `${ack.result}${ack.code ? ` (${ack.code})` : ''}`;
    const ref = { deviceId: actuatorId, incidentId: (c.incident_id as number | null) ?? undefined };
    if (c.state === 'sent') {
      const state: CommandState = ack.result === 'done' ? 'acked' : ack.result === 'refused' ? 'refused' : 'failed';
      setState(ack.cmdId, { state, acked_at: t, finished_at: t, ack: text, ack_kind: 'signed', uncertain: 0 });
      const action = state === 'acked' ? 'commande_accusee' : state === 'refused' ? 'commande_refusee' : 'commande_echec';
      deps.audit('systeme', action, { ...ref, details: `${c.action} (cmd ${ack.cmdId.slice(0, 8)}) : ${text}, accuse signe en ${t - (c.sent_at as number)} ms` });
      publishCommand(ack.cmdId);
      if (state !== 'acked') noteReturnFailure(ack.cmdId);
    } else if ((c.state === 'failed' || c.state === 'expired') && c.ack_kind === null && c.late_ack === null) {
      // Jamais d'histoire reecrite : l'etat reste, mais l'operateur doit savoir que l'ordre a ete execute.
      setState(ack.cmdId, { late_ack: text, late_ack_at: t });
      deps.audit('systeme', 'commande_accuse_tardif', { ...ref, details: `${c.action} (cmd ${ack.cmdId.slice(0, 8)}) : accuse « ${text} » recu ${Math.round((t - (c.sent_at as number)) / 1000)} s apres l'envoi, apres l'echeance` });
      publishCommand(ack.cmdId);
      if (typeof c.parent_id === 'string') publishCommand(c.parent_id); // un accuse tardif « done » leve l'avertissement du retour non confirme
    }
  }

  // ---------------------------------------------------------------- controle periodique et demarrage

  // Controle periodique (chaque seconde) : requetes preparees une fois, indexees ; rien a suivre = deux lectures vides (cas courant).
  const anyWork = db.prepare("SELECT 1 AS x FROM actuator_command WHERE state IN ('pending', 'sent') OR (off_due_at IS NOT NULL AND off_cmd_id IS NULL) LIMIT 1");
  const retryWork = db.prepare("SELECT 1 AS x FROM actuator_command WHERE auto = 1 AND state IN ('failed', 'refused', 'expired') AND finished_at > ? LIMIT 1");

  /** Derniers envois en echec de chaque retour automatique (un par commande d'origine) dans la fenetre de reessai [from, to]. */
  const retryCandidates = (from: number, to: number): Row[] =>
    db
      .prepare(
        `SELECT c.id, c.rowid AS rid, c.actuator_id, c.parent_id, c.incident_id FROM actuator_command c
         WHERE c.auto = 1 AND c.state IN ('failed', 'refused', 'expired') AND c.finished_at > ? AND c.finished_at <= ? AND c.parent_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM actuator_command n WHERE n.parent_id = c.parent_id AND n.auto = 1 AND n.rowid > c.rowid)`,
      )
      .all(from, to) as Row[];

  /** Les reessais en cours sont abandonnes (mode maintenance...) : le pointeur de la commande d'origine recoit le motif. */
  function abandonRetries(marker: string): number {
    let n = 0;
    const t = now();
    for (const c of retryCandidates(t - RETURN_RETRY_WINDOW_MS, t)) {
      const p = commandRow(c.parent_id as string);
      if (!p || typeof p.off_cmd_id !== 'string' || !CMD_ID.test(p.off_cmd_id)) continue;
      const attempts = returnAttempts(p.id as string);
      if (attempts.length >= RETURN_MAX_TRIES || attempts.some(confirmed)) continue;
      setState(p.id as string, { off_cmd_id: marker });
      n++;
    }
    return n;
  }

  /**
   * Retour automatique a l'etat sur en echec : nouvel envoi (toutes les 5 s, 5 essais au plus, envoi initial compris) jusqu'a
   * accuse. Sans objet des qu'un ordre plus recent a pris la main sur l'actionneur, en mode maintenance, ou si l'actionneur
   * a disparu. Ne concerne jamais les commandes manuelles (jamais rejouees).
   */
  function retryReturn(c: Row): void {
    const parentId = c.parent_id as string;
    const p = commandRow(parentId);
    if (!p || typeof p.off_cmd_id !== 'string' || !CMD_ID.test(p.off_cmd_id)) return; // chaine abandonnee (verrou, remplace...)
    const attempts = returnAttempts(parentId);
    if (attempts.length >= RETURN_MAX_TRIES || attempts.some(confirmed)) return;
    const a = actuatorRow(c.actuator_id as string);
    if (!a) return void setState(parentId, { off_cmd_id: 'supprime' });
    // Un ordre plus recent (envoye, accuse, ou peut-etre execute) a pris la main : y toucher serait pire que d'attendre.
    const newer = db
      .prepare(
        `SELECT 1 AS x FROM actuator_command WHERE actuator_id = ? AND rowid > ? AND NOT (auto = 1 AND parent_id = ?)
           AND state NOT IN ('refused', 'cancelled') AND NOT (state = 'expired' AND sent_at IS NULL) LIMIT 1`,
      )
      .get(a.id as string, c.rid as number, parentId);
    if (newer) return void setState(parentId, { off_cmd_id: 'remplace' });
    if (lockState().locked) {
      setState(parentId, { off_cmd_id: 'verrou' });
      deps.audit('systeme', 'commande_echec', { deviceId: a.id as string, details: `retour automatique apres cmd ${parentId.slice(0, 8)} non reessaye : mode maintenance ; l'equipement s'arrete seul (durationS)` });
      return;
    }
    const safe = safeOf(a);
    if (!safe) return void setState(parentId, { off_cmd_id: 'sans_objet' });
    if (a.transport === 'mqtt' && linkUp(a) === false) return; // la passerelle reviendra : on attend, dans la fenetre de reessai
    createAndDispatch(a, {
      action: safe,
      params: {},
      requestedBy: 'systeme',
      reason: `retour automatique a l'etat sur (essai ${attempts.length + 1}/${RETURN_MAX_TRIES})`,
      incidentId: (c.incident_id as number | null) ?? null,
      auto: true,
      parentId,
    });
  }

  function tick(): void {
    const t = now();
    if (anyWork.get() === undefined && retryWork.get(t - RETURN_RETRY_WINDOW_MS) === undefined) return;
    // Sans accuse a l'echeance : echec, jamais « fait » par supposition (HTTP : sa propre echeance, celle-ci en filet).
    for (const c of db.prepare("SELECT c.id, c.actuator_id, c.ack_deadline, a.transport FROM actuator_command c LEFT JOIN actuator a ON a.id = c.actuator_id WHERE c.state = 'sent'").all() as Row[]) {
      const deadline = (c.ack_deadline as number) + (c.transport === 'http' ? 2000 : 0);
      if (t >= deadline) fail(c.id as string, c.actuator_id as string, 'aucun accuse dans le delai', true);
    }
    for (const c of db.prepare("SELECT id, actuator_id, action FROM actuator_command WHERE state = 'pending' AND requested_at < ?").all(t - 30_000) as Row[]) {
      setState(c.id as string, { state: 'expired', finished_at: t, ack: 'jamais envoyee' });
      deps.audit('systeme', 'commande_expiree', { deviceId: c.actuator_id as string, details: `${c.action} (cmd ${(c.id as string).slice(0, 8)}) jamais envoyee` });
      publishCommand(c.id as string);
    }
    // Retours automatiques a l'etat sur arrives a echeance.
    for (const c of db.prepare('SELECT * FROM actuator_command WHERE off_due_at IS NOT NULL AND off_cmd_id IS NULL AND off_due_at <= ?').all(t) as Row[]) {
      const a = actuatorRow(c.actuator_id as string);
      const safe = a ? safeOf(a) : null;
      if (!a || !safe || lockState().locked) {
        setState(c.id as string, { off_cmd_id: lockState().locked ? 'verrou' : 'sans_objet' });
        continue;
      }
      if (a.transport === 'mqtt' && linkUp(a) === false) {
        // La passerelle n'est pas (encore) abonnee, au redemarrage par exemple : le retour reste en attente et part des qu'elle
        // revient, au plus pendant STALE_RETURN_MS. Une seule entree de journal, pas une par seconde.
        if (t - (c.off_due_at as number) > STALE_RETURN_MS) {
          setState(c.id as string, { off_cmd_id: 'liaison_coupee' });
          waitingForLink.delete(c.id as string);
          deps.audit('systeme', 'commande_echec', { deviceId: a.id as string, details: `retour automatique a « ${safe} » (apres cmd ${(c.id as string).slice(0, 8)}) abandonne : liaison coupee depuis plus de 24 h ; l'equipement s'est arrete seul (durationS)` });
        } else if (!waitingForLink.has(c.id as string)) {
          if (waitingForLink.size > 1000) waitingForLink.clear();
          waitingForLink.add(c.id as string);
          deps.audit('systeme', 'commande_echec', { deviceId: a.id as string, details: `retour automatique a « ${safe} » (apres cmd ${(c.id as string).slice(0, 8)}) en attente : liaison coupee ; il partira des le retour de la passerelle` });
        }
        continue;
      }
      waitingForLink.delete(c.id as string);
      setState(c.id as string, { off_cmd_id: 'en_cours' });
      try {
        const stopId = createAndDispatch(a, { action: safe, params: {}, requestedBy: 'systeme', reason: "retour automatique a l'etat sur", incidentId: (c.incident_id as number | null) ?? null, auto: true, parentId: c.id as string });
        setState(c.id as string, { off_cmd_id: stopId });
      } catch (err) {
        console.error('[actionneurs] retour automatique :', err);
        safely(() => setState(c.id as string, { off_cmd_id: 'abandonne' }));
      }
    }
    // Retours automatiques en echec : reessais.
    for (const c of retryCandidates(t - RETURN_RETRY_WINDOW_MS, t - RETURN_RETRY_DELAY_MS)) safely(() => retryReturn(c));
  }

  // Demarrage : une commande en vol au moment de l'arret n'est JAMAIS renvoyee ; on dit seulement qu'elle n'a pas ete suivie.
  {
    const t = now();
    const stale = db.prepare(`SELECT id, actuator_id, action, state, auto FROM actuator_command WHERE state IN ${IN_FLIGHT}`).all() as Row[];
    for (const [i, c] of stale.entries()) {
      setState(c.id as string, { state: 'expired', finished_at: t, ack: `PSIM redemarre (etait ${c.state}) : jamais renvoyee` });
      if (c.auto === 1) noteReturnFailure(c.id as string);
      if (i < 20) deps.audit('systeme', 'commande_expiree', { deviceId: c.actuator_id as string, details: `${c.action} (cmd ${(c.id as string).slice(0, 8)}) : PSIM redemarre, commande non suivie et jamais renvoyee` });
    }
    if (stale.length > 20) deps.audit('systeme', 'commande_expiree', { details: `${stale.length - 20} autre(s) commande(s) expiree(s) au redemarrage` });
    // Retours a l'etat sur prevus avant l'arret : replanifies (envoyer « off » est toujours sur), sauf s'ils sont trop anciens.
    db.prepare("UPDATE actuator_command SET off_cmd_id = 'abandonne' WHERE off_due_at IS NOT NULL AND off_cmd_id IS NULL AND off_due_at < ?").run(t - STALE_RETURN_MS);
    db.prepare("UPDATE actuator_command SET off_cmd_id = NULL WHERE off_cmd_id = 'en_cours'").run();
  }

  // ---------------------------------------------------------------- lecture (API)

  const MASK = '?...';
  /** Identifiants `user:pw@` et chaine de requete d'une URL (jetons, cles) remplaces par un marqueur. */
  const maskUrl = (url: string): string => url.replace(/^(https?:\/\/)[^/?#]*@/i, '$1***@').replace(/\?[\s\S]*$/, MASK);

  /** Pour un role autre qu'administrateur : le detail des requetes HTTP (jetons, cles, corps) n'est pas montre. */
  function redactHttp(http: NonNullable<ActuatorView['http']>): NonNullable<ActuatorView['http']> {
    const requests: Record<string, HttpRequestTemplate> = {};
    for (const [action, req] of Object.entries(http.requests)) requests[action] = { method: req.method, url: maskUrl(req.url), ...(req.body ? { body: '(masque)' } : {}) };
    return { ...http, requests };
  }

  function list(role: Role): { actuators: (ActuatorView & { allowed: string[] })[]; lock: ReturnType<typeof lockState> } {
    const rows = db.prepare('SELECT * FROM actuator ORDER BY zone, name, id').all() as Row[];
    return {
      actuators: rows.map((r) => {
        const v = toView(r);
        const view = role === 'admin' || !v.http ? v : { ...v, http: redactHttp(v.http) };
        return { ...view, allowed: Object.entries(v.actions).filter(([, c]) => c.roles.includes(role)).map(([a]) => a) };
      }),
      lock: lockState(),
    };
  }

  function history(id: string, limit = 100): CommandView[] {
    if (!ACTUATOR_ID.test(id)) throw new PsimError(404, 'Actionneur introuvable');
    const n = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
    return (db.prepare('SELECT * FROM actuator_command WHERE actuator_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT ?').all(id, n) as Row[]).map(commandView);
  }

  function mount(
    app: Express,
    guards: { anyUser: RequestHandler; adminOnly: RequestHandler; actorOf: (req: Request) => string; roleOf: (req: Request) => Role; reauth: (what: string) => RequestHandler },
  ): void {
    const { anyUser, adminOnly, actorOf, roleOf, reauth } = guards;
    const json = express.json({ limit: '8kb' });
    const userOf = (req: Request) => ({ username: actorOf(req), role: roleOf(req) });
    app.get('/api/actuators', anyUser, (req, res) => res.json(list(roleOf(req))));
    app.post('/api/actuators', adminOnly, json, reauth('creation d un actionneur'), (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json(create(actorOf(req), (req.body ?? {}) as Record<string, unknown>));
    });
    app.patch('/api/actuators/:id', adminOnly, json, reauth('modification d un actionneur'), (req, res) => res.json(update(actorOf(req), String(req.params.id), (req.body ?? {}) as Record<string, unknown>)));
    app.delete('/api/actuators/:id', adminOnly, json, reauth('suppression d un actionneur'), (req, res) => {
      remove(actorOf(req), String(req.params.id));
      res.json({ ok: true });
    });
    app.post('/api/actuators/:id/key', adminOnly, json, reauth('renouvellement de cle d actionneur'), (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(rotateKey(actorOf(req), String(req.params.id)));
    });
    app.put('/api/actuator-lock', adminOnly, json, reauth('mode maintenance des commandes'), (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(setLock(actorOf(req), body.locked, body.reason));
    });
    app.post('/api/actuators/commands/:cmdId/cancel', anyUser, (req, res) => res.json(cancel(userOf(req), String(req.params.cmdId))));
    app.post('/api/actuators/:id/commands', anyUser, json, (req, res) => {
      const result = request(userOf(req), String(req.params.id), (req.body ?? {}) as Record<string, unknown>);
      res.status(result.status).json(result.deduplicated ? { command: result.command, deduplicated: true } : { command: result.command });
    });
    app.get('/api/actuators/:id/commands', anyUser, (req, res) => res.json(history(String(req.params.id), Number(req.query.limit ?? 100))));
  }

  return {
    attachMqtt(link: MqttCommandLink | null): void {
      mqtt = link;
    },
    list,
    get: (id: string) => {
      const r = actuatorRow(id);
      return r ? toView(r) : null;
    },
    create,
    update,
    remove,
    rotateKey,
    setLock,
    lockState,
    request,
    cancel,
    history,
    command: (cmdId: string) => {
      const r = commandRow(cmdId);
      return r ? commandView(r) : null;
    },
    handleAck,
    incidentChanged,
    tick,
    mount,
  };
}

export type Actuators = ReturnType<typeof createActuators>;
