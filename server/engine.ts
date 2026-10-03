import type { DatabaseSync } from 'node:sqlite';
import { appendSealed } from './auditchain.ts';
import { ALWAYS_ACTIVE_EVENTS, CATEGORIES, checkSensorSettings, interpret } from './sources.ts';
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

/** Erreur destinee a etre renvoyee telle quelle a l'appelant (code HTTP inclus). */
export class PsimError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Row = Record<string, unknown>;

function rowToDevice(r: Row): Device {
  return {
    id: r.id as string,
    kind: r.kind as DeviceKind,
    name: r.name as string,
    zone: r.zone as string,
    x: r.x as number,
    y: r.y as number,
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
  // Un detecteur jamais entendu depuis le demarrage dispose du meme delai de grace, compte
  // a partir du demarrage : on ne le declare pas muet avant d'avoir pu l'entendre.
  const startedAt = now();
  function getDevice(id: string): Device | null {
    const r = db.prepare('SELECT * FROM device WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToDevice(r) : null;
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
        `SELECT i.*, d.name AS detector_name, d.zone AS zone, d.category AS category, d.last_value AS last_value, d.value_unit AS value_unit
           FROM incident i JOIN device d ON d.id = i.detector_id WHERE i.id = ?`,
      )
      .get(id) as Row | undefined;
    if (!r) throw new PsimError(404, 'Incident introuvable');
    return {
      id: r.id as number,
      detectorId: r.detector_id as string,
      detectorName: r.detector_name as string,
      zone: r.zone as string,
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
      const neighbor = corroboratingNeighbor(detectorId);
      if (neighbor) confirm(row.id as number, detectorId, `neighbor:${neighbor}`);
      else if (hasPersisted(detectorId, row.opened_at as number)) confirm(row.id as number, detectorId, 'persistence');
    }
  }

  /** Detecteur isole revenu a la normale tres vite : on SUGGERE une fausse alarme (l'operateur decide). */
  function maybeHint(detectorId: string): void {
    if (hintMs <= 0) return;
    const incident = db
      .prepare("SELECT id, opened_at, hint FROM incident WHERE detector_id = ? AND status <> 'closed' AND confirmed_at IS NULL")
      .get(detectorId) as Row | undefined;
    if (!incident || incident.hint) return;
    const duration = now() - (incident.opened_at as number);
    if (duration > hintMs || corroboratingNeighbor(detectorId)) return;
    const details = `retour a la normale en ${Math.round(duration / 1000)} s, sans detecteur voisin`;
    db.prepare("UPDATE incident SET hint = 'false_alarm_likely', hint_details = ? WHERE id = ?").run(details, incident.id as number);
    audit('systeme', 'incident_hint', { incidentId: incident.id as number, deviceId: detectorId, details });
    publishIncident(incident.id as number);
  }

  /**
   * Point d'entree des messages d'equipements (MQTT `psim/detectors/<id>/state`, HTTP `/api/ingest/<id>`).
   * Ne leve jamais d'exception ; renvoie `{ ok: false }` avec la raison et le code HTTP adaptes.
   */
  function ingest(deviceId: string, payload: unknown): { ok: true } | { ok: false; status: number; error: string } {
    const device = getDevice(deviceId);
    if (!device || device.kind !== 'detector') return { ok: false, status: 404, error: 'Detecteur introuvable' };
    const reading = interpret(device, payload);
    if (!reading.ok) return { ok: false, status: 400, error: reading.error };

    const t = now();
    db.prepare('UPDATE device SET last_seen = ? WHERE id = ?').run(t, deviceId);
    if (reading.value !== null) db.prepare('UPDATE device SET last_value = ? WHERE id = ?').run(reading.value, deviceId);
    // Un equipement supervise qui donne signe de vie alors qu'on le croyait mort est de nouveau en ligne.
    const state = reading.state ?? (reading.alive && device.status === 'offline' ? 'normal' : null);
    if (state !== null && (state === 'alarm' || state === 'prealarm') && device.category === 'intrusion' && options.isArmed && !(reading.event && ALWAYS_ACTIVE_EVENTS.has(reading.event)) && !options.isArmed(device.zone)) {
      noteIgnored(device, reading.event ?? state);
      publishDevice(deviceId);
      return { ok: true };
    }
    if (state === null) {
      publishDevice(deviceId);
      return { ok: true };
    }
    applyState(device, state);
    return { ok: true };
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
      ingest(deviceId, payload);
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

  function applyState(device: Device, state: DetectorState): void {
    const deviceId = device.id;
    const previous = device.status;
    const t = now();
    db.prepare('UPDATE device SET status = ? WHERE id = ?').run(state, deviceId);
    if (previous !== state) db.prepare('UPDATE device SET state_since = ? WHERE id = ?').run(t, deviceId);
    if (previous !== state) {
      noteStateChange(deviceId, `${previous} -> ${state}`);
    }
    publishDevice(deviceId);

    const s = state;
    if (s === 'prealarm' || s === 'alarm') {
      const severity: Severity = s === 'alarm' ? 'critical' : 'warning';
      const open = db
        .prepare("SELECT id, severity, hint FROM incident WHERE detector_id = ? AND status <> 'closed'")
        .get(deviceId) as { id: number; severity: Severity; hint: string | null } | undefined;

      if (!open) {
        const res = db
          .prepare('INSERT INTO incident (detector_id, severity, opened_at) VALUES (?, ?, ?)')
          .run(deviceId, severity, now());
        const id = Number(res.lastInsertRowid);
        audit('systeme', 'incident_opened', { incidentId: id, deviceId, details: severity });
        publishIncident(id);
        emitHook(id, 'opened');
      } else if (open.severity === 'warning' && severity === 'critical') {
        // Escalade : l'incident redevient "non acquitte" pour relancer l'alerte sonore.
        db.prepare(
          "UPDATE incident SET severity = 'critical', status = 'open', acked_at = NULL, acked_by = NULL WHERE id = ?",
        ).run(open.id);
        audit('systeme', 'incident_escalated', { incidentId: open.id, deviceId, details: 'warning -> critical' });
        publishIncident(open.id);
        emitHook(open.id, 'escalated');
      }
      if (open?.hint) {
        // Le detecteur se redeclenche : la suggestion « fausse alarme » ne tient plus.
        db.prepare('UPDATE incident SET hint = NULL, hint_details = NULL WHERE id = ?').run(open.id);
        publishIncident(open.id);
      }
    } else if (s === 'normal' && (previous === 'alarm' || previous === 'prealarm')) {
      maybeHint(deviceId);
    }
    evaluateConfirmations();
  }

  /** Controle periodique (une fois par seconde environ) : detecteurs muets, confirmation par persistance. */
  function tick(): void {
    checkSilentDetectors();
    evaluateConfirmations();
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
      const reference = Math.max((row.last_seen as number | null) ?? 0, startedAt);
      const silence = t - reference;
      if (silence < timeoutMs) continue;
      const id = row.id as string;
      const res = db
        .prepare("UPDATE device SET status = 'offline' WHERE id = ? AND status IN ('normal', 'fault')")
        .run(id);
      if (res.changes === 0) continue;
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
    // Pas de retour a la ligne ni de sequence d'echappement dans un nom : ils finiraient dans des e-mails, des messages Telegram, des journaux et des terminaux.
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new PsimError(400, `${field} invalide (caracteres de controle interdits)`);
    return value.trim();
  }

  function cleanPercent(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new PsimError(400, `${field} doit etre un nombre entre 0 et 100`);
    }
    return value;
  }

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
    const sensor = input.kind === 'detector' ? cleanSensor(input, null) : cleanSensor({}, null, true);
    db.prepare(
      'INSERT INTO device (id, kind, name, zone, x, y, stream_kind, category, value_unit, warn_at, alarm_at, direction, heartbeat_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, input.kind, name, zone, x, y, input.kind === 'camera' ? 'simulated' : null, sensor.category, sensor.valueUnit, sensor.warnAt, sensor.alarmAt, sensor.direction, sensor.heartbeatS);
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
    const sensor = device.kind === 'detector' ? cleanSensor(input, device) : null;
    if (sensor && sensor.category !== device.category && db.prepare("SELECT 1 AS x FROM incident WHERE detector_id = ? AND status <> 'closed'").get(id)) {
      throw new PsimError(409, 'Un incident est en cours sur ce detecteur : le traiter avant de changer sa categorie');
    }
    if (!sensor && SENSOR_FIELDS.some((f) => input[f] !== undefined)) throw new PsimError(400, 'Ces reglages ne concernent que les detecteurs');
    db.prepare('UPDATE device SET name = ?, zone = ?, x = ?, y = ? WHERE id = ?').run(name, zone, x, y, id);
    if (sensor) {
      db.prepare('UPDATE device SET category = ?, value_unit = ?, warn_at = ?, alarm_at = ?, direction = ?, heartbeat_s = ? WHERE id = ?').run(
        sensor.category, sensor.valueUnit, sensor.warnAt, sensor.alarmAt, sensor.direction, sensor.heartbeatS, id,
      );
    }
    audit(actor, 'device_updated', { deviceId: id });
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
    const site = (db.prepare('SELECT name, plan_file, plan_version FROM site WHERE id = 1').get() as Row | undefined) ?? {
      name: 'Site',
      plan_file: null,
      plan_version: 0,
    };
    const devices = (db.prepare('SELECT * FROM device ORDER BY kind, id').all() as Row[]).map(rowToDevice);
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
        hasPlan: Boolean(site.plan_file),
        planVersion: site.plan_version as number,
      },
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
