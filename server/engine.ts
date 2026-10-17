import type { DatabaseSync } from 'node:sqlite';
import type { AccessHook } from './access.ts';
import { appendSealed } from './auditchain.ts';
import { DAHUA_SUPERVISION_S } from './dahua.ts';
import { PsimError } from './errors.ts';
import { defaultFloorId, listFloors } from './floors.ts';
import { releaseLinkLoss } from './gatewaylink.ts';
import { recordState } from './history.ts';
import { alreadySeen, DEFAULT_MAX_AGE_MS, FUTURE_TOLERANCE_MS, LATE_AFTER_MS, purgeDedup, readMeta, remember, tooOld } from './ingestmeta.ts';
import type { MessageMeta } from './ingestmeta.ts';
import { hasForbiddenChar, normalizeName } from './text.ts';
import { TUYA_SUPERVISION_S } from './tuya.ts';
import { ALWAYS_ACTIVE_EVENTS, CATEGORIES, checkSensorSettings, interpret } from './sources.ts';
import type { Reading } from './sources.ts';
import type {
  AuditEntry,
  Device,
  DeviceCategory,
  DeviceKind,
  Direction,
  DetectorState,
  Incident,
  PsimEvent,
  Qualification,
  Severity,
  Snapshot,
} from './types.ts';

const QUALIFICATIONS: ReadonlySet<string> = new Set(['fire', 'false_alarm']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_COMMENT = 500;
const MAX_LABEL = 80;
const MAX_UNIT = 12;
const MAX_HEARTBEAT_S = 7 * 24 * 3600;

export { PsimError };

type Row = Record<string, unknown>;

/** `fallbackFloor` : etage d'un equipement insere sans etage depuis l'ouverture de la base (la migration le rattachera). */
function rowToDevice(r: Row, fallbackFloor: number): Device {
  return {
    id: r.id as string,
    kind: r.kind as DeviceKind,
    name: r.name as string,
    zone: r.zone as string,
    x: r.x as number,
    y: r.y as number,
    floorId: (r.floor_id as number | null) ?? fallbackFloor,
    status: r.status as string,
    streamKind: (r.stream_kind as string | null) ?? null,
    lastSeen: (r.last_seen as number | null) ?? null,
    category: ((r.category as string | null) ?? 'fire') as DeviceCategory,
    valueUnit: (r.value_unit as string | null) ?? null,
    warnAt: (r.warn_at as number | null) ?? null,
    alarmAt: (r.alarm_at as number | null) ?? null,
    direction: ((r.direction as string | null) ?? 'above') as Direction,
    lastValue: (r.last_value as number | null) ?? null,
    heartbeatS: (r.heartbeat_s as number | null) ?? null,
  };
}

function rowToAudit(r: Row): AuditEntry {
  return {
    id: r.id as number,
    ts: r.ts as number,
    actor: r.actor as string,
    action: r.action as string,
    incidentId: (r.incident_id as number | null) ?? null,
    deviceId: (r.device_id as string | null) ?? null,
    details: (r.details as string | null) ?? null,
  };
}

export type Publish = (event: PsimEvent) => void;

export interface EngineOptions {
  /**
   * Delai (ms) sans message au-dela duquel un detecteur est declare « hors ligne ». 0 = surveillance
   * desactivee. Les detecteurs reels emettent un signal de vie periodique : le silence est un defaut.
   */
  silentTimeoutMs?: number;
  /**
   * Regles anti-fausses alarmes. IMPORTANT : elles ne font que QUALIFIER un incident (« a confirmer » /
   * « confirme », ou une suggestion). Elles ne retardent, ne masquent ni ne ferment jamais une alarme.
   * 0 = regle desactivee.
   *
   * Coincidence : un detecteur voisin (meme zone, ou camera en commun) est en prealarme/alarme, ou
   * s'est declenche dans les `confirmWindowMs` dernieres millisecondes -> les deux incidents sont confirmes.
   */
  confirmWindowMs?: number;
  /** Persistance : un detecteur reste en prealarme/alarme au moins `persistMs` -> incident confirme. */
  persistMs?: number;
  /** Indice : un detecteur isole revenu a la normale en moins de `hintMs` -> « probable fausse alarme ». */
  hintMs?: number;
  /**
   * Detecteurs VIRTUELS (SOS d'un agent ou d'un telephone, rondes manquees : voir agents.ts et patrols.ts). Ils ne sont pas des
   * mesures physiques : il n'y a ni fausse alarme a ecarter, ni retour a la normale a attendre. Les regles anti-fausses alarmes
   * (confirmation par voisin ou par persistance, indice « probable fausse alarme ») ne leur sont donc jamais appliquees. Sans cela
   * `confirm` ferait repasser « non acquitte » (et renotifierait) un SOS que l'exploitation vient d'acquitter. Predicat paresseux :
   * il est fourni avant que ces modules existent (voir main.ts). Une exception vaut « non virtuel » : une alarme n'est jamais retardee.
   */
  virtualDetector?: (detectorId: string) => boolean;
  /**
   * Appele APRES publication d'un incident (ouverture, aggravation, confirmation). Ne peut ni retarder
   * ni faire echouer l'alarme : une exception est journalisee et ignoree.
   */
  onIncidentEvent?: (incident: Incident, kind: 'opened' | 'escalated' | 'confirmed') => void;
  /** Appele quand un detecteur est declare muet (zone potentiellement non surveillee). Jamais bloquant. */
  onDetectorSilent?: (device: Device) => void;
  /**
   * Armement des zones d'intrusion : `false` = la zone est desarmee, ses detecteurs d'intrusion n'ouvrent pas d'incident
   * (sabotage et panique restent toujours actifs ; incendie, acces et environnement ne sont jamais concernes).
   * Absent = toutes les zones sont armees.
   */
  isArmed?: (zone: string) => boolean;
  /** Etat d'armement de chaque zone d'intrusion, pour l'interface. */
  armingState?: () => Record<string, boolean>;
  /** Age maximal d'un message date (`ts`), et duree de memoire des `msgId` (voir ingestmeta.ts). 7 jours par defaut. */
  ingestMaxAgeMs?: number;
  /**
   * Supervision par passerelle (voir gatewaylink.ts) : instant a partir duquel compter le silence d'un detecteur ;
   * `Infinity` = sa passerelle est deconnectee, ne pas le juger seul ; `null` = rien a dire.
   */
  silenceReference?: (deviceId: string) => number | null;
  /**
   * Journal des acces (voir access.ts) : appele pour tout detecteur de categorie `access` et tout message portant un champ
   * `access`, APRES `interpret` et AVANT `applyReading`. Il peut refuser le message (rien n'est alors applique), le declarer
   * deja connu (`duplicate`) ou echouer (erreur 500, le `msgId` n'est pas retenu : la passerelle renverra).
   */
  access?: AccessHook;
}

function describeDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

export function createEngine(
  db: DatabaseSync,
  publish: Publish,
  now: () => number = Date.now,
  options: EngineOptions = {},
) {
  const silentTimeoutMs = options.silentTimeoutMs ?? 0;
  const confirmWindowMs = options.confirmWindowMs ?? 0;
  const persistMs = options.persistMs ?? 0;
  const hintMs = options.hintMs ?? 0;
  const ingestMaxAgeMs = options.ingestMaxAgeMs ?? DEFAULT_MAX_AGE_MS;
  // Un detecteur jamais entendu depuis le demarrage dispose du meme delai de grace, compte
  // a partir du demarrage : on ne le declare pas muet avant d'avoir pu l'entendre.
  const startedAt = now();
  function getDevice(id: string): Device | null {
    const r = db.prepare('SELECT * FROM device WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToDevice(r, r.floor_id === null ? defaultFloorId(db) : 0) : null;
  }

  function linkedCameras(detectorId: string): string[] {
    return (
      db
        .prepare('SELECT camera_id FROM device_link WHERE detector_id = ? ORDER BY camera_id')
        .all(detectorId) as Row[]
    ).map((r) => r.camera_id as string);
  }

  function incidentView(id: number): Incident {
    const r = db
      .prepare(
        `SELECT i.*, d.name AS detector_name, d.zone AS zone, d.category AS category, d.last_value AS last_value, d.value_unit AS value_unit,
                COALESCE(f.name, (SELECT name FROM floor ORDER BY position, id LIMIT 1)) AS floor_name
           FROM incident i JOIN device d ON d.id = i.detector_id LEFT JOIN floor f ON f.id = d.floor_id WHERE i.id = ?`,
      )
      .get(id) as Row | undefined;
    if (!r) throw new PsimError(404, 'Incident introuvable');
    return {
      id: r.id as number,
      detectorId: r.detector_id as string,
      detectorName: r.detector_name as string,
      zone: r.zone as string,
      floor: (r.floor_name as string | null) ?? '',
      category: ((r.category as string | null) ?? 'fire') as DeviceCategory,
      lastValue: (r.last_value as number | null) ?? null,
      valueUnit: (r.value_unit as string | null) ?? null,
      severity: r.severity as Severity,
      status: r.status as Incident['status'],
      qualification: (r.qualification as Qualification | null) ?? null,
      comment: (r.comment as string | null) ?? null,
      openedAt: r.opened_at as number,
      ackedAt: (r.acked_at as number | null) ?? null,
      ackedBy: (r.acked_by as string | null) ?? null,
      closedAt: (r.closed_at as number | null) ?? null,
      closedBy: (r.closed_by as string | null) ?? null,
      cameraIds: linkedCameras(r.detector_id as string),
      confirmedAt: (r.confirmed_at as number | null) ?? null,
      confirmationReason: (r.confirmation_reason as string | null) ?? null,
      hint: (r.hint as Incident['hint']) ?? null,
      hintDetails: (r.hint_details as string | null) ?? null,
      receivedLateMs: r.received_at === null || r.received_at === undefined ? null : Math.max(0, (r.received_at as number) - (r.opened_at as number)),
      event: (r.event as string | null) ?? null,
      detail: (r.detail as string | null) ?? null,
      snapshots: (
        db
          .prepare('SELECT id, camera_id, taken_at, reason FROM incident_snapshot WHERE incident_id = ? ORDER BY id')
          .all(id) as Row[]
      ).map((s) => ({ id: s.id as number, cameraId: s.camera_id as string, takenAt: s.taken_at as number, reason: s.reason as string })),
    };
  }

  function audit(
    actor: string,
    action: string,
    ref: { incidentId?: number; deviceId?: string; details?: string } = {},
  ): void {
    const ts = now();
    // Entree scellee : elle porte l'empreinte de la precedente (voir auditchain.ts).
    const id = appendSealed(db, { ts, actor, action, incident_id: ref.incidentId ?? null, device_id: ref.deviceId ?? null, details: ref.details ?? null });
    const entry = rowToAudit(db.prepare('SELECT * FROM audit_log WHERE id = ?').get(id) as Row);
    publish({ type: 'audit', entry });
  }

  function publishDevice(id: string): void {
    const device = getDevice(id);
    if (device) publish({ type: 'device', device });
  }

  function publishIncident(id: number): void {
    publish({ type: 'incident', incident: incidentView(id) });
  }

  function emitHook(id: number, kind: 'opened' | 'escalated' | 'confirmed'): void {
    if (!options.onIncidentEvent) return;
    try {
      options.onIncidentEvent(incidentView(id), kind);
    } catch (err) {
      console.error('[engine] onIncidentEvent :', err);
    }
  }

  // ---- Regles anti-fausses alarmes (qualification uniquement, jamais de suppression) -------------

  /** Detecteurs voisins de MEME categorie (un detecteur de fumee ne corrobore pas un contact de porte) : meme zone (non vide) ou au moins une camera en commun. */
  function neighborsOf(detectorId: string): string[] {
    return (
      db
        .prepare(
          `SELECT DISTINCT d2.id AS id FROM device d1
             JOIN device d2 ON d2.kind = 'detector' AND d2.id <> d1.id AND d2.category = d1.category
            WHERE d1.id = ? AND (
              (d1.zone <> '' AND d2.zone = d1.zone)
              OR EXISTS (SELECT 1 FROM device_link a JOIN device_link b ON a.camera_id = b.camera_id
                          WHERE a.detector_id = d1.id AND b.detector_id = d2.id))`,
        )
        .all(detectorId) as Row[]
    ).map((r) => r.id as string);
  }

  /** Un voisin corrobore s'il est en prealarme/alarme maintenant, ou s'est declenche dans la fenetre. */
  function corroboratingNeighbor(detectorId: string): string | null {
    if (confirmWindowMs <= 0) return null;
    const since = now() - confirmWindowMs;
    for (const id of neighborsOf(detectorId)) {
      const status = (db.prepare('SELECT status FROM device WHERE id = ?').get(id) as Row | undefined)?.status;
      if (status === 'alarm' || status === 'prealarm') return id;
      if (db.prepare('SELECT 1 AS x FROM incident WHERE detector_id = ? AND opened_at >= ? LIMIT 1').get(id, since)) return id;
    }
    return null;
  }

  function isVirtual(detectorId: string): boolean {
    if (!options.virtualDetector) return false;
    try {
      return options.virtualDetector(detectorId) === true;
    } catch (err) {
      console.error('[engine] virtualDetector :', err);
      return false;
    }
  }

  function hasPersisted(detectorId: string, openedAt: number): boolean {
    if (persistMs <= 0) return false;
    const row = db.prepare('SELECT status, state_since FROM device WHERE id = ?').get(detectorId) as Row | undefined;
    if (row?.status !== 'alarm' && row?.status !== 'prealarm') return false;
    return now() - ((row.state_since as number | null) ?? openedAt) >= persistMs;
  }

  function confirm(incidentId: number, detectorId: string, reason: string): void {
    // Une confirmation est une aggravation : un incident acquitte redevient « non acquitte »
    // pour que l'alerte reparte (toutes les expressions SET lisent l'ancienne valeur de la ligne).
    const res = db
      .prepare(
        `UPDATE incident SET confirmed_at = ?, confirmation_reason = ?, hint = NULL, hint_details = NULL,
           status = CASE WHEN status = 'acknowledged' THEN 'open' ELSE status END,
           acked_at = CASE WHEN status = 'acknowledged' THEN NULL ELSE acked_at END,
           acked_by = CASE WHEN status = 'acknowledged' THEN NULL ELSE acked_by END
         WHERE id = ? AND confirmed_at IS NULL AND status <> 'closed'`,
      )
      .run(now(), reason, incidentId);
    if (res.changes === 0) return;
    audit('systeme', 'incident_confirmed', { incidentId, deviceId: detectorId, details: reason });
    publishIncident(incidentId);
    emitHook(incidentId, 'confirmed');
  }

  function evaluateConfirmations(): void {
    if (confirmWindowMs <= 0 && persistMs <= 0) return;
    const rows = db
      .prepare("SELECT id, detector_id, opened_at FROM incident WHERE status <> 'closed' AND confirmed_at IS NULL")
      .all() as Row[];
    for (const row of rows) {
      const detectorId = row.detector_id as string;
      if (isVirtual(detectorId)) continue; // ni voisin ni persistance : voir `virtualDetector`
      const neighbor = corroboratingNeighbor(detectorId);
      if (neighbor) confirm(row.id as number, detectorId, `neighbor:${neighbor}`);
      else if (hasPersisted(detectorId, row.opened_at as number)) confirm(row.id as number, detectorId, 'persistence');
    }
  }

  /** Detecteur isole revenu a la normale tres vite : on SUGGERE une fausse alarme (l'operateur decide). `at` : heure reelle du retour. */
  function maybeHint(detectorId: string, at: number): void {
    if (hintMs <= 0 || isVirtual(detectorId)) return; // un SOS ou une ronde manquee n'est jamais « probablement une fausse alarme »
    const incident = db
      .prepare("SELECT id, opened_at, hint FROM incident WHERE detector_id = ? AND status <> 'closed' AND confirmed_at IS NULL")
      .get(detectorId) as Row | undefined;
    if (!incident || incident.hint) return;
    const duration = at - (incident.opened_at as number);
    if (duration > hintMs || corroboratingNeighbor(detectorId)) return;
    const details = `retour a la normale en ${Math.round(duration / 1000)} s, sans detecteur voisin`;
    db.prepare("UPDATE incident SET hint = 'false_alarm_likely', hint_details = ? WHERE id = ?").run(details, incident.id as number);
    audit('systeme', 'incident_hint', { incidentId: incident.id as number, deviceId: detectorId, details });
    publishIncident(incident.id as number);
  }

  /**
   * Point d'entree des messages d'equipements (MQTT `psim/detectors/<id>/state`, HTTP `/api/ingest/<id>`).
   * Ne leve jamais d'exception ; renvoie `{ ok: false }` avec la raison et le code HTTP adaptes.
   *
   * Messages dates et rejouables (voir ingestmeta.ts) : un `msgId` deja traite est un succes sans effet (`duplicate`) ;
   * `ts` est l'heure reelle de l'evenement (incident, etat, journal). Un message SANS `ts` est toujours « maintenant » :
   * comportement d'avant, meme si l'horloge du PSIM recule.
   */
  function ingest(deviceId: string, payload: unknown): IngestResult {
    const found = getDevice(deviceId);
    if (!found || found.kind !== 'detector') return { ok: false, status: 404, error: 'Detecteur introuvable' };
    const t = now();
    const read = readMeta(payload, t);
    if (!read.ok) return { ok: false, status: 400, error: read.error };
    const meta = read.meta;
    // Renvoi d'un message deja traite (passerelle qui vide sa file apres une coupure) : succes, sans aucun effet. Avant le
    // controle d'age : un renvoi tardif d'un message deja compte n'est pas une erreur.
    if (meta.msgId !== null && alreadySeen(db, deviceId, meta.msgId)) return { ok: true, duplicate: true };
    const old = tooOld(meta, ingestMaxAgeMs);
    if (old) return { ok: false, status: 400, error: old };
    const reading = interpret(found, payload);
    if (!reading.ok) return { ok: false, status: 400, error: reading.error };
    if (meta.aheadMs > FUTURE_TOLERANCE_MS) warnOnce(deviceId, `horodatage ${describeDuration(meta.aheadMs)} dans le futur, ramene a l'heure de reception (horloge de l'equipement ou de sa passerelle a regler)`);

    // Journal des acces : valide et enregistre le passage, suit l'etat de la porte (voir ingestWithAccess).
    if (options.access && (found.category === 'access' || carriesAccess(payload))) return ingestWithAccess(options.access, found, payload, reading, meta, t);
    return deliver(found, reading, meta, t);
  }

  type IngestResult = { ok: true; duplicate?: true } | { ok: false; status: number; error: string };

  /** Applique un message valide a l'equipement, puis retient son `msgId`. */
  function deliver(found: Device, reading: Extract<Reading, { ok: true }>, meta: MessageMeta, t: number): IngestResult {
    // Le capteur parle : si sa passerelle avait ete declaree injoignable, il reprend d'abord son etat d'avant la coupure.
    const device = releaseLinkLoss(db, found.id, t) ? (getDevice(found.id) as Device) : found;
    applyReading(device, reading, meta);
    if (meta.msgId !== null) remember(db, found.id, meta.msgId, t);
    return { ok: true };
  }

  /**
   * Message d'une porte ou portant un champ `access` : le journal des acces (access.ts) le valide et l'enregistre AVANT
   * l'application. Un refus n'applique rien ; un passage deja connu (index unique du journal, plus durable que la memoire des
   * `msgId`) est un succes sans effet ; une exception du module est une erreur 500 (le `msgId` n'est pas retenu : la passerelle
   * renverra). Tout est dans UNE SEULE transaction (un seul commit, donc un seul fsync par message) : si l'application du message
   * echoue, le passage n'est pas garde non plus et le renvoi le retrouvera.
   */
  function ingestWithAccess(access: AccessHook, found: Device, payload: unknown, reading: Extract<Reading, { ok: true }>, meta: MessageMeta, t: number): IngestResult {
    db.exec('SAVEPOINT ingest_access');
    let result: IngestResult;
    try {
      let verdict: ReturnType<AccessHook['onMessage']>;
      try {
        verdict = access.onMessage({ device: found, payload, event: reading.event, state: reading.state, meta });
      } catch (err) {
        console.error('[engine] journal des acces :', err);
        verdict = { ok: false, status: 500, error: 'Erreur interne du journal des acces' };
      }
      if (!verdict.ok) result = verdict;
      else if (verdict.duplicate) {
        if (meta.msgId !== null) remember(db, found.id, meta.msgId, t);
        result = { ok: true, duplicate: true };
      } else {
        result = deliver(found, reading, meta, t);
        // Pre-alarme decidee par le module (armement des portes) : APRES `deliver`, sinon un detecteur « hors ligne » repassant
        // « normal » par le signe de vie de ce message l'effacerait. setStateBySupervisor ne la pose jamais sur une alarme.
        if (result.ok && verdict.raise) setStateBySupervisor(found.id, verdict.raise.state, verdict.raise.event, verdict.raise.detail);
      }
    } catch (err) {
      db.exec('ROLLBACK TO ingest_access');
      db.exec('RELEASE ingest_access');
      settleAccess(access, false);
      throw err;
    }
    if (!result.ok) db.exec('ROLLBACK TO ingest_access');
    db.exec('RELEASE ingest_access');
    // Transaction terminee : le module peut annoncer ce qu'il avait en attente (validee) ou le jeter (annulee).
    settleAccess(access, result.ok);
    return result;
  }

  function settleAccess(access: AccessHook, committed: boolean): void {
    try {
      access.settle?.(committed);
    } catch (err) {
      console.error('[engine] journal des acces (fin de transaction) :', err);
    }
  }

  const carriesAccess = (payload: unknown): boolean => typeof payload === 'object' && payload !== null && !Array.isArray(payload) && Object.hasOwn(payload, 'access');

  /**
   * Etat decide par le PSIM lui-meme (ex. escalade d'une porte maintenue ouverte en alarme) : meme chemin que l'etat d'un message
   * (incident, journal, historique, publication), mais SANS toucher `last_seen` : un equipement muet doit pouvoir passer hors ligne.
   * Heure = maintenant. Faux si le detecteur n'existe pas. `detail` : texte de l'incident (nomme la porte et l'heure, jamais un nom
   * de personne). Une PRE-ALARME demandee pour un detecteur deja en ALARME n'est pas appliquee (vrai quand meme : le detecteur
   * existe) : une decision du PSIM n'adoucit jamais une alarme.
   */
  function setStateBySupervisor(deviceId: string, state: DetectorState, event: string | null, detail: string | null = null): boolean {
    const device = getDevice(deviceId);
    if (!device || device.kind !== 'detector') return false;
    if (state === 'prealarm' && device.status === 'alarm') return true;
    const t = now();
    applyState(device, state, { eventAt: t, receivedAt: t, dated: false, lateMs: 0, aheadMs: 0, msgId: null }, event, detail);
    return true;
  }

  /** Heure de l'etat deja applique : celle du dernier message qui l'a fixe, ou a defaut celle du dernier changement. */
  function stateReference(deviceId: string): number {
    const row = db.prepare('SELECT COALESCE(state_ts, state_since) AS r FROM device WHERE id = ?').get(deviceId) as { r: number | null } | undefined;
    return row?.r ?? -Infinity;
  }

  function applyReading(device: Device, reading: Extract<Reading, { ok: true }>, meta: MessageMeta): void {
    const deviceId = device.id;
    const at = meta.eventAt;
    // Dernier signe de vie = l'evenement le plus recent : un message rejoue ne rajeunit pas un capteur.
    const newest = !meta.dated || at >= (device.lastSeen ?? -Infinity);
    db.prepare('UPDATE device SET last_seen = ? WHERE id = ?').run(meta.dated ? Math.max(device.lastSeen ?? 0, at) : at, deviceId);
    if (reading.value !== null && newest) db.prepare('UPDATE device SET last_value = ? WHERE id = ?').run(reading.value, deviceId);
    // Un equipement supervise qui donne signe de vie alors qu'on le croyait mort est de nouveau en ligne.
    const state = reading.state ?? (reading.alive && device.status === 'offline' ? 'normal' : null);
    if (state !== null && (state === 'alarm' || state === 'prealarm') && device.category === 'intrusion' && options.isArmed && !(reading.event && ALWAYS_ACTIVE_EVENTS.has(reading.event)) && !options.isArmed(device.zone)) {
      noteIgnored(device, reading.event ?? state);
      publishDevice(deviceId);
      return;
    }
    if (state === null) {
      publishDevice(deviceId);
      return;
    }
    // ORDRE : un message date plus ancien que l'etat deja applique ne l'ecrase pas (voir recordPastAlarm pour une alarme).
    if (meta.dated && at < stateReference(deviceId)) {
      if (state === 'alarm' || state === 'prealarm') recordPastAlarm(device, state, meta, reading.event, reading.detail);
      publishDevice(deviceId);
      return;
    }
    applyState(device, state, meta, reading.event, reading.detail);
  }

  const fmtDate = (ms: number) => new Date(ms).toLocaleString('fr-FR');
  const lateText = (meta: MessageMeta) => `evenement du ${fmtDate(meta.eventAt)}, recu avec ${describeDuration(meta.lateMs)} de retard`;

  /**
   * (Pre)alarme DATEE plus ancienne que l'etat deja connu : renvoi d'une passerelle apres une coupure, ou messages arrives
   * dans le desordre. Cas type : le detecteur a ete en alarme pendant la coupure, et un message plus recent (ou son retour)
   * l'a deja dit revenu a la normale. Comportement retenu :
   *  - l'etat ACTUEL n'est pas modifie : le message plus recent fait foi ;
   *  - l'alarme n'est jamais perdue : si aucun incident ne couvre deja ce moment, un incident est ouvert A SA DATE REELLE,
   *    marque « recu en differe » (journal `alarm_late`, `receivedLateMs`), et notifie comme toute ouverture. Il n'est PAS
   *    clos automatiquement (une alarme que personne n'a vue est qualifiee par un operateur : feu reel ou fausse alarme),
   *    mais il ne reste pas « en cours » a tort : le detecteur n'est pas en alarme, l'operateur peut le cloturer aussitot ;
   *  - un incident non clos existe deja (un seul par detecteur) : l'alarme y est rattachee dans le journal, et l'aggrave
   *    si elle est plus grave ;
   *  - un incident clos couvre deja ce moment (meme alarme renvoyee sans `msgId`) : rien, pas de doublon.
   * L'historique des etats n'est pas reecrit : il dit ce que le PSIM savait, quand il le savait (une alarme compte « en
   * service » comme l'etat normal : la disponibilite n'en depend pas).
   * `event` : evenement nomme du message rejoue (gaz, sos...) ; il devient le motif de l'incident ouvert ou aggrave,
   * comme pour une alarme recue en direct (voir applyState).
   */
  function recordPastAlarm(device: Device, state: 'alarm' | 'prealarm', meta: MessageMeta, event: string | null = null, detail: string | null = null): void {
    const deviceId = device.id;
    const at = meta.eventAt;
    const severity: Severity = state === 'alarm' ? 'critical' : 'warning';
    const details = `${state === 'alarm' ? 'alarme' : 'prealarme'} anterieure a l'etat connu : ${lateText(meta)} ; etat actuel (${device.status}) inchange`;
    const open = db
      .prepare("SELECT id, severity, opened_at FROM incident WHERE detector_id = ? AND status <> 'closed'")
      .get(deviceId) as { id: number; severity: Severity; opened_at: number } | undefined;
    if (open) {
      if (open.opened_at > at) {
        audit('systeme', 'alarm_late', { incidentId: open.id, deviceId, details: `${details} ; rattachee a l'incident en cours` });
        publishIncident(open.id);
      }
      if (open.severity === 'warning' && severity === 'critical') escalate(open.id, deviceId, event, detail);
      return;
    }
    if (db.prepare('SELECT 1 AS x FROM incident WHERE detector_id = ? AND opened_at <= ? AND closed_at >= ? LIMIT 1').get(deviceId, at, at)) return;
    const res = db
      .prepare('INSERT INTO incident (detector_id, severity, opened_at, received_at, event, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(deviceId, severity, at, meta.receivedAt, event, detail);
    const id = Number(res.lastInsertRowid);
    audit('systeme', 'incident_opened', { incidentId: id, deviceId, details: severity });
    audit('systeme', 'alarm_late', { incidentId: id, deviceId, details });
    publishIncident(id);
    emitHook(id, 'opened');
  }

  // Message refuse en MQTT (pas de reponse possible) : signale dans le journal technique, au plus une fois par minute et par equipement.
  const lastWarned = new Map<string, number>();
  function warnOnce(deviceId: string, text: string): void {
    const t = Date.now();
    if (t - (lastWarned.get(deviceId) ?? -Infinity) < 60_000) return;
    lastWarned.set(deviceId, t);
    console.warn(`[engine] ${deviceId} : ${text}`);
  }

  // Un detecteur de mouvement dans une zone desarmee parle souvent : on le note, mais pas a chaque message.
  const lastIgnored = new Map<string, number>();

  function noteIgnored(device: Device, what: string): void {
    const t = now();
    if (t - (lastIgnored.get(device.id) ?? -Infinity) < 60_000) return;
    lastIgnored.set(device.id, t);
    audit('systeme', 'intrusion_ignored', { deviceId: device.id, details: `zone ${device.zone} desarmee : ${what} ignore` });
  }

  function handleDetectorMessage(deviceId: string, payload: unknown): void {
    try {
      const result = ingest(deviceId, payload);
      if (!result.ok && result.status === 400) warnOnce(deviceId, `message refuse : ${result.error}`);
    } catch (err) {
      console.error('[engine] message :', err);
    }
  }

  // Un equipement qui oscille (panne, ou client MQTT compromis) ne doit pas remplir le disque : le journal est chaine, donc non purgeable.
  // Au-dela de FLAP_LIMIT changements en FLAP_WINDOW_MS, les changements d'etat ne sont plus journalises un par un (l'etat, lui,
  // reste a jour, et les incidents ne sont jamais concernes) ; une seule ligne signale l'oscillation.
  const FLAP_LIMIT = 30;
  const FLAP_WINDOW_MS = 10 * 60_000;
  const recentChanges = new Map<string, number[]>();
  const flapReported = new Map<string, number>();

  function noteStateChange(deviceId: string, details: string): void {
    const t = now();
    const recent = (recentChanges.get(deviceId) ?? []).filter((x) => t - x < FLAP_WINDOW_MS);
    recent.push(t);
    recentChanges.set(deviceId, recent);
    if (recent.length <= FLAP_LIMIT) return void audit('detecteur', 'device_state', { deviceId, details });
    if (t - (flapReported.get(deviceId) ?? -Infinity) >= FLAP_WINDOW_MS) {
      flapReported.set(deviceId, t);
      audit('systeme', 'device_flapping', { deviceId, details: `plus de ${FLAP_LIMIT} changements d'etat en ${FLAP_WINDOW_MS / 60_000} min : journalisation limitee pour cet equipement (verifier le detecteur ou le client qui l'alimente)` });
    }
  }

  /** `event` : evenement nomme qui aggrave l'incident ; il en devient le motif (sinon le motif d'origine est garde). Meme regle pour `detail`. */
  function escalate(incidentId: number, deviceId: string, event: string | null = null, detail: string | null = null): void {
    // Escalade : l'incident redevient "non acquitte" pour relancer l'alerte sonore.
    db.prepare(
      "UPDATE incident SET severity = 'critical', status = 'open', acked_at = NULL, acked_by = NULL, event = COALESCE(?, event), detail = COALESCE(?, detail) WHERE id = ?",
    ).run(event, detail, incidentId);
    audit('systeme', 'incident_escalated', { incidentId, deviceId, details: 'warning -> critical' });
    publishIncident(incidentId);
    emitHook(incidentId, 'escalated');
  }

  /** `meta.eventAt` : heure reelle du changement (`ts` du message, sinon son arrivee). `event` : evenement nomme (motif de l'incident). */
  function applyState(device: Device, state: DetectorState, meta: MessageMeta, event: string | null = null, detail: string | null = null): void {
    const deviceId = device.id;
    const previous = device.status;
    const t = meta.eventAt;
    const late = meta.lateMs >= LATE_AFTER_MS ? lateText(meta) : null;
    db.prepare('UPDATE device SET status = ?, state_ts = ? WHERE id = ?').run(state, t, deviceId);
    if (previous !== state) db.prepare('UPDATE device SET state_since = ? WHERE id = ?').run(t, deviceId);
    if (previous !== state) {
      recordState(db, deviceId, state, t); // historique complet, meme quand le journal cesse de noter un equipement qui oscille
      noteStateChange(deviceId, `${previous} -> ${state}${late ? ` (${late})` : ''}`);
    }
    publishDevice(deviceId);

    const s = state;
    if (s === 'prealarm' || s === 'alarm') {
      const severity: Severity = s === 'alarm' ? 'critical' : 'warning';
      const open = db
        .prepare("SELECT id, severity, hint FROM incident WHERE detector_id = ? AND status <> 'closed'")
        .get(deviceId) as { id: number; severity: Severity; hint: string | null } | undefined;

      if (!open) {
        // Heure REELLE de l'alarme ; recue en differe (passerelle qui renvoie apres une coupure) : heure de reception notee.
        const res = db
          .prepare('INSERT INTO incident (detector_id, severity, opened_at, received_at, event, detail) VALUES (?, ?, ?, ?, ?, ?)')
          .run(deviceId, severity, t, late ? meta.receivedAt : null, event, detail);
        const id = Number(res.lastInsertRowid);
        audit('systeme', 'incident_opened', { incidentId: id, deviceId, details: severity });
        if (late) audit('systeme', 'alarm_late', { incidentId: id, deviceId, details: late });
        publishIncident(id);
        emitHook(id, 'opened');
      } else if (open.severity === 'warning' && severity === 'critical') {
        escalate(open.id, deviceId, event, detail);
      }
      if (open?.hint) {
        // Le detecteur se redeclenche : la suggestion « fausse alarme » ne tient plus.
        db.prepare('UPDATE incident SET hint = NULL, hint_details = NULL WHERE id = ?').run(open.id);
        publishIncident(open.id);
      }
    } else if (s === 'normal' && (previous === 'alarm' || previous === 'prealarm')) {
      maybeHint(deviceId, t);
    }
    evaluateConfirmations();
  }

  /** Controle periodique (une fois par seconde environ) : detecteurs muets, confirmation par persistance. */
  let ticks = 0;
  function tick(): void {
    checkSilentDetectors();
    evaluateConfirmations();
    if (++ticks % 60 === 0) purgeDedup(db, now() - ingestMaxAgeMs); // memoire des msgId : environ une fois par minute
  }

  /**
   * Declare « hors ligne » les detecteurs qui ne donnent plus signe de vie. A appeler regulierement.
   * Seuls les detecteurs « normal » ou « defaut » sont concernes : un detecteur en prealarme ou en
   * alarme garde son etat tant qu'il n'est pas revenu a la normale (comme une centrale), sinon un
   * silence pourrait masquer un feu en cours. Renvoie les identifiants nouvellement declares muets.
   */
  function checkSilentDetectors(): string[] {
    const t = now();
    const rows = db
      .prepare("SELECT id, status, last_seen, heartbeat_s FROM device WHERE kind = 'detector' AND status IN ('normal', 'fault')")
      .all() as Row[];
    const silent: string[] = [];
    for (const row of rows) {
      // Delai propre a l'equipement (0 = non supervise : un contact de porte n'emet qu'aux changements), sinon delai general.
      const own = (row.heartbeat_s as number | null) ?? null;
      const timeoutMs = own === null ? silentTimeoutMs : own * 1000;
      if (timeoutMs <= 0) continue;
      // Passerelle deconnectee (Infinity) ou revenue depuis peu : voir gatewaylink.ts.
      const reference = Math.max((row.last_seen as number | null) ?? 0, startedAt, options.silenceReference?.(row.id as string) ?? -Infinity);
      const silence = t - reference;
      if (silence < timeoutMs) continue;
      const id = row.id as string;
      const res = db
        .prepare("UPDATE device SET status = 'offline', state_ts = ? WHERE id = ? AND status IN ('normal', 'fault')")
        .run(t, id); // state_ts : un message rejoue, anterieur a ce constat, ne le ramene pas « en ligne »
      if (res.changes === 0) continue;
      recordState(db, id, 'offline', t);
      audit('systeme', 'detector_silent', {
        deviceId: id,
        details: `aucun message depuis ${describeDuration(silence)} (etait : ${row.status})`,
      });
      publishDevice(id);
      silent.push(id);
      try {
        const device = getDevice(id);
        if (device) options.onDetectorSilent?.(device);
      } catch (err) {
        console.error('[engine] onDetectorSilent :', err);
      }
    }
    return silent;
  }

  function acknowledge(incidentId: number, actor: string): Incident {
    const res = db
      .prepare("UPDATE incident SET status = 'acknowledged', acked_at = ?, acked_by = ? WHERE id = ? AND status = 'open'")
      .run(now(), actor, incidentId);
    if (res.changes === 0) {
      const current = incidentView(incidentId);
      throw new PsimError(409, `Incident deja ${current.status === 'closed' ? 'cloture' : 'acquitte'}`);
    }
    audit(actor, 'incident_acked', { incidentId });
    publishIncident(incidentId);
    return incidentView(incidentId);
  }

  function close(incidentId: number, actor: string, qualification: unknown, comment: unknown): Incident {
    if (typeof qualification !== 'string' || !QUALIFICATIONS.has(qualification)) {
      throw new PsimError(400, 'Qualification requise : fire ou false_alarm');
    }
    let text: string | null = null;
    if (comment !== undefined && comment !== null && comment !== '') {
      if (typeof comment !== 'string' || comment.length > MAX_COMMENT) {
        throw new PsimError(400, `Commentaire invalide (max ${MAX_COMMENT} caracteres)`);
      }
      text = comment;
    }
    const incident = incidentView(incidentId);
    if (incident.status === 'closed') throw new PsimError(409, 'Incident deja cloture');
    const detector = getDevice(incident.detectorId);
    if (detector && (detector.status === 'alarm' || detector.status === 'prealarm')) {
      throw new PsimError(409, 'Le detecteur est toujours en alarme : attendre son retour a la normale');
    }
    db.prepare(
      "UPDATE incident SET status = 'closed', qualification = ?, comment = ?, closed_at = ?, closed_by = ? WHERE id = ?",
    ).run(qualification, text, now(), actor, incidentId);
    audit(actor, 'incident_closed', { incidentId, deviceId: incident.detectorId, details: qualification });
    publishIncident(incidentId);
    return incidentView(incidentId);
  }

  // ---- Inventaire (administration) -------------------------------------------------

  function cleanLabel(value: unknown, field: string, required: boolean): string {
    if (value === undefined || value === null || value === '') {
      if (required) throw new PsimError(400, `${field} requis`);
      return '';
    }
    if (typeof value !== 'string' || value.length > MAX_LABEL) {
      throw new PsimError(400, `${field} invalide (max ${MAX_LABEL} caracteres)`);
    }
    // Pas de retour a la ligne, de sequence d'echappement ni de caractere invisible dans un nom (voir text.ts).
    if (hasForbiddenChar(value)) throw new PsimError(400, `${field} invalide (caracteres de controle ou invisibles interdits)`);
    return normalizeName(value);
  }

  /**
   * Une zone appartient a UN etage. Deux « Chambre » sur deux niveaux seraient une seule zone pour l'armement (desarmer
   * l'une ferait ignorer les intrusions de l'autre), la confirmation par un voisin et le risque : refuse, avec la marche a suivre.
   */
  function checkZoneFloor(zone: string, floorId: number, deviceId: string): void {
    if (!zone) return;
    const other = db
      .prepare('SELECT d.id AS id, f.name AS floor FROM device d LEFT JOIN floor f ON f.id = d.floor_id WHERE d.zone = ? AND d.id <> ? AND COALESCE(d.floor_id, ?) <> ? LIMIT 1')
      .get(zone, deviceId, defaultFloorId(db), floorId) as { id: string; floor: string | null } | undefined;
    if (other) {
      throw new PsimError(409, `La zone « ${zone} » est deja utilisee a l'etage « ${other.floor ?? '?'} » (${other.id}) : une zone appartient a un seul etage. Nommer la zone par niveau (ex. « ${floorName(floorId)} - ${zone} »).`);
    }
  }

  function cleanPercent(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new PsimError(400, `${field} doit etre un nombre entre 0 et 100`);
    }
    return value;
  }

  /** Etage existant (absent = l'etage le plus bas ; `null` n'est pas un etage : refuse plutot que deplacer en silence). */
  function cleanFloor(value: unknown): number {
    if (value === undefined) return defaultFloorId(db);
    if (typeof value !== 'number' || !Number.isInteger(value) || !db.prepare('SELECT 1 AS x FROM floor WHERE id = ?').get(value)) {
      throw new PsimError(400, 'Etage inconnu');
    }
    return value;
  }

  const floorName = (id: number) => (db.prepare('SELECT name FROM floor WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? String(id);

  const SENSOR_FIELDS = ['category', 'valueUnit', 'warnAt', 'alarmAt', 'direction', 'heartbeatS'];

  function cleanNumberOrNull(value: unknown, field: string): number | null {
    if (value === null || value === '') return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new PsimError(400, `${field} doit etre un nombre`);
    return value;
  }

  /**
   * Reglages d'un detecteur (categorie, seuils, supervision). `current` = valeurs actuelles pour une
   * modification partielle ; `defaults` = cameras (aucun reglage). Les detecteurs hors incendie ne sont
   * pas supervises par defaut : beaucoup n'emettent qu'aux changements d'etat.
   */
  function cleanSensor(
    input: Record<string, unknown>,
    current: Device | null,
    defaults = false,
  ): { category: DeviceCategory; valueUnit: string | null; warnAt: number | null; alarmAt: number | null; direction: Direction; heartbeatS: number | null } {
    if (defaults) return { category: 'fire', valueUnit: null, warnAt: null, alarmAt: null, direction: 'above', heartbeatS: null };
    const category = (input.category === undefined ? (current?.category ?? 'fire') : input.category) as DeviceCategory;
    if (!CATEGORIES.includes(category)) throw new PsimError(400, `categorie invalide (${CATEGORIES.join(', ')})`);
    let valueUnit = current?.valueUnit ?? null;
    if (input.valueUnit !== undefined) {
      if (input.valueUnit === null || input.valueUnit === '') valueUnit = null;
      else if (typeof input.valueUnit !== 'string' || input.valueUnit.length > MAX_UNIT) throw new PsimError(400, `unite invalide (max ${MAX_UNIT} caracteres)`);
      else valueUnit = input.valueUnit.trim() || null;
    }
    const warnAt = input.warnAt === undefined ? (current?.warnAt ?? null) : cleanNumberOrNull(input.warnAt, 'seuil de prealarme');
    const alarmAt = input.alarmAt === undefined ? (current?.alarmAt ?? null) : cleanNumberOrNull(input.alarmAt, "seuil d'alarme");
    const direction = (input.direction === undefined ? (current?.direction ?? 'above') : input.direction) as Direction;
    const problem = checkSensorSettings({ category, warnAt, alarmAt, direction });
    if (problem) throw new PsimError(400, problem);
    let heartbeatS: number | null;
    if (input.heartbeatS === undefined) heartbeatS = current ? current.heartbeatS : category === 'fire' ? null : 0;
    else if (input.heartbeatS === null || input.heartbeatS === '') heartbeatS = null;
    else if (typeof input.heartbeatS !== 'number' || !Number.isInteger(input.heartbeatS) || input.heartbeatS < 0 || input.heartbeatS > MAX_HEARTBEAT_S) {
      throw new PsimError(400, `supervision invalide (0 = non supervise, ou un nombre entier de secondes, ${MAX_HEARTBEAT_S} max)`);
    } else heartbeatS = input.heartbeatS;
    return { category, valueUnit, warnAt, alarmAt, direction, heartbeatS };
  }

  function createDevice(actor: string, input: Record<string, unknown>): Device {
    const id = input.id;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new PsimError(400, 'Identifiant invalide (lettres, chiffres, - et _ ; 32 caracteres max)');
    }
    if (input.kind !== 'detector' && input.kind !== 'camera') {
      throw new PsimError(400, 'kind doit etre detector ou camera');
    }
    if (getDevice(id)) throw new PsimError(409, 'Identifiant deja utilise');
    const name = cleanLabel(input.name, 'name', true);
    const zone = cleanLabel(input.zone, 'zone', false);
    const x = input.x === undefined ? 50 : cleanPercent(input.x, 'x');
    const y = input.y === undefined ? 50 : cleanPercent(input.y, 'y');
    const floorId = cleanFloor(input.floorId);
    checkZoneFloor(zone, floorId, id);
    const sensor = input.kind === 'detector' ? cleanSensor(input, null) : cleanSensor({}, null, true);
    db.prepare(
      'INSERT INTO device (id, kind, name, zone, x, y, floor_id, stream_kind, category, value_unit, warn_at, alarm_at, direction, heartbeat_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, input.kind, name, zone, x, y, floorId, input.kind === 'camera' ? 'simulated' : null, sensor.category, sensor.valueUnit, sensor.warnAt, sensor.alarmAt, sensor.direction, sensor.heartbeatS);
    if (input.kind === 'detector') recordState(db, id, 'normal', now());
    audit(actor, 'device_created', { deviceId: id, details: `${input.kind} ${name}${sensor.category === 'fire' ? '' : ` (${sensor.category})`}` });
    publish({ type: 'config' });
    return getDevice(id) as Device;
  }

  function updateDevice(actor: string, id: string, input: Record<string, unknown>): Device {
    const device = getDevice(id);
    if (!device) throw new PsimError(404, 'Equipement introuvable');
    const name = input.name === undefined ? device.name : cleanLabel(input.name, 'name', true);
    const zone = input.zone === undefined ? device.zone : cleanLabel(input.zone, 'zone', false);
    const x = input.x === undefined ? device.x : cleanPercent(input.x, 'x');
    const y = input.y === undefined ? device.y : cleanPercent(input.y, 'y');
    const floorId = input.floorId === undefined ? device.floorId : cleanFloor(input.floorId);
    if (zone !== device.zone || floorId !== device.floorId) checkZoneFloor(zone, floorId, id);
    const sensor = device.kind === 'detector' ? cleanSensor(input, device) : null;
    if (sensor && sensor.category !== device.category && db.prepare("SELECT 1 AS x FROM incident WHERE detector_id = ? AND status <> 'closed'").get(id)) {
      throw new PsimError(409, 'Un incident est en cours sur ce detecteur : le traiter avant de changer sa categorie');
    }
    if (!sensor && SENSOR_FIELDS.some((f) => input[f] !== undefined)) throw new PsimError(400, 'Ces reglages ne concernent que les detecteurs');
    // Detecteur alimente par un enregistreur Dahua : la regle « la nuit seulement » tient a sa categorie (intrusion) et a sa
    // zone ; sa supervision ne descend pas sous la cadence des signes de vie de l'appareil (sinon « hors ligne » en boucle).
    if (sensor && db.prepare('SELECT 1 AS x FROM detector_source WHERE device_id = ?').get(id)) {
      if (sensor.category !== 'intrusion' || !zone) {
        throw new PsimError(409, "Ce detecteur lit la detection d'un enregistreur Dahua : il reste un detecteur d'intrusion avec une zone (retirer d'abord sa source)");
      }
      if (!sensor.heartbeatS || sensor.heartbeatS < DAHUA_SUPERVISION_S) {
        throw new PsimError(409, `Ce detecteur lit la detection d'un enregistreur Dahua : supervision d'au moins ${DAHUA_SUPERVISION_S} s`);
      }
    }
    // Capteur Tuya (fumee, contact, mouvement, eau, temperature, gaz, CO, SOS) : il garde sa categorie (le type de capteur en depend),
    // supervise au moins aussi longtemps que deux lectures du cloud.
    if (sensor && db.prepare('SELECT 1 AS x FROM tuya_source WHERE device_id = ?').get(id)) {
      if (sensor.category !== device.category) {
        throw new PsimError(409, device.category === 'fire'
          ? "Ce detecteur lit un detecteur de fumee Tuya : il reste un detecteur incendie (retirer d'abord sa source)"
          : "Ce detecteur lit un capteur Tuya : il garde sa categorie (retirer d'abord sa source)");
      }
      if (!sensor.heartbeatS || sensor.heartbeatS < TUYA_SUPERVISION_S) {
        throw new PsimError(409, `Ce detecteur lit un capteur Tuya : supervision d'au moins ${TUYA_SUPERVISION_S} s`);
      }
    }
    // Equipement d'infrastructure supervise par le reseau (networkhealth.ts) : il reste de categorie « Environnement » (les
    // categories energie et personnes n'y changent rien), et sans delai « aucun message » (il n'emet rien : il serait declare
    // muet a tort, avec une alerte).
    if (sensor && db.prepare('SELECT 1 AS x FROM network_target WHERE device_id = ?').get(id)) {
      if (sensor.category !== 'environment') {
        throw new PsimError(409, "Cet equipement est supervise par le reseau : il reste de categorie « Environnement » (retirer d'abord sa supervision reseau)");
      }
      if (sensor.heartbeatS !== 0) {
        throw new PsimError(409, "Cet equipement est supervise par le reseau : sa supervision par messages reste desactivee (0)");
      }
    }
    db.prepare('UPDATE device SET name = ?, zone = ?, x = ?, y = ?, floor_id = ? WHERE id = ?').run(name, zone, x, y, floorId, id);
    if (sensor) {
      db.prepare('UPDATE device SET category = ?, value_unit = ?, warn_at = ?, alarm_at = ?, direction = ?, heartbeat_s = ? WHERE id = ?').run(
        sensor.category, sensor.valueUnit, sensor.warnAt, sensor.alarmAt, sensor.direction, sensor.heartbeatS, id,
      );
    }
    audit(actor, 'device_updated', { deviceId: id, details: floorId !== device.floorId ? `deplace vers l'etage ${floorName(floorId)}` : undefined });
    publish({ type: 'config' });
    return getDevice(id) as Device;
  }

  function deleteDevice(actor: string, id: string): void {
    const device = getDevice(id);
    if (!device) throw new PsimError(404, 'Equipement introuvable');
    const used = db.prepare('SELECT COUNT(*) AS n FROM incident WHERE detector_id = ?').get(id) as { n: number };
    if (used.n > 0) {
      throw new PsimError(409, "Ce detecteur a un historique d'incidents et ne peut pas etre supprime");
    }
    db.prepare('DELETE FROM device WHERE id = ?').run(id);
    audit(actor, 'device_deleted', { deviceId: id, details: device.name });
    publish({ type: 'config' });
  }

  function setLinks(actor: string, detectorId: string, cameraIds: unknown): string[] {
    const detector = getDevice(detectorId);
    if (!detector || detector.kind !== 'detector') throw new PsimError(404, 'Detecteur introuvable');
    if (!Array.isArray(cameraIds) || cameraIds.some((c) => typeof c !== 'string')) {
      throw new PsimError(400, 'cameraIds doit etre une liste');
    }
    const unique = [...new Set(cameraIds as string[])];
    for (const cameraId of unique) {
      if (getDevice(cameraId)?.kind !== 'camera') throw new PsimError(400, `Camera inconnue : ${cameraId}`);
    }
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM device_link WHERE detector_id = ?').run(detectorId);
      const insert = db.prepare('INSERT INTO device_link (detector_id, camera_id) VALUES (?, ?)');
      for (const cameraId of unique) insert.run(detectorId, cameraId);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    audit(actor, 'links_updated', { deviceId: detectorId, details: unique.join(',') || '(aucune)' });
    publish({ type: 'config' });
    return unique;
  }

  function getSnapshot(): Snapshot {
    const site = (db.prepare('SELECT name FROM site WHERE id = 1').get() as Row | undefined) ?? { name: 'Site' };
    const floors = listFloors(db);
    const devices = (db.prepare('SELECT * FROM device ORDER BY kind, id').all() as Row[]).map((r) => rowToDevice(r, floors[0].id));
    const links: Record<string, string[]> = {};
    for (const r of db.prepare('SELECT detector_id, camera_id FROM device_link ORDER BY camera_id').all() as Row[]) {
      (links[r.detector_id as string] ??= []).push(r.camera_id as string);
    }
    const incidentIds = (
      db
        .prepare(
          `SELECT id FROM incident WHERE status <> 'closed'
           UNION SELECT id FROM (SELECT id FROM incident WHERE status = 'closed' ORDER BY id DESC LIMIT 20)
           ORDER BY id DESC`,
        )
        .all() as Row[]
    ).map((r) => r.id as number);
    return {
      site: {
        name: site.name as string,
        hasPlan: floors[0].hasPlan,
        planVersion: floors[0].planVersion,
      },
      floors,
      devices,
      links,
      arming: options.armingState?.() ?? {},
      incidents: incidentIds.map(incidentView),
      audit: listAudit(50),
    };
  }

  function listAudit(limit: number): AuditEntry[] {
    const n = Math.min(Math.max(Math.trunc(limit) || 50, 1), 500);
    return (db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(n) as Row[]).map(rowToAudit);
  }

  return {
    ingest,
    setStateBySupervisor,
    handleDetectorMessage,
    incidentView,
    checkSilentDetectors,
    tick,
    acknowledge,
    close,
    createDevice,
    updateDevice,
    deleteDevice,
    setLinks,
    getSnapshot,
    listAudit,
    getDevice,
    audit,
  };
}

export type Engine = ReturnType<typeof createEngine>;
