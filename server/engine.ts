import type { DatabaseSync } from 'node:sqlite';
import type {
  AuditEntry,
  Device,
  DeviceKind,
  DetectorState,
  Incident,
  PsimEvent,
  Qualification,
  Severity,
  Snapshot,
} from './types.ts';

const DETECTOR_STATES: ReadonlySet<string> = new Set(['normal', 'prealarm', 'alarm', 'fault', 'offline']);
const QUALIFICATIONS: ReadonlySet<string> = new Set(['fire', 'false_alarm']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_COMMENT = 500;
const MAX_LABEL = 80;

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
        `SELECT i.*, d.name AS detector_name, d.zone AS zone
           FROM incident i JOIN device d ON d.id = i.detector_id WHERE i.id = ?`,
      )
      .get(id) as Row | undefined;
    if (!r) throw new PsimError(404, 'Incident introuvable');
    return {
      id: r.id as number,
      detectorId: r.detector_id as string,
      detectorName: r.detector_name as string,
      zone: r.zone as string,
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
    };
  }

  function audit(
    actor: string,
    action: string,
    ref: { incidentId?: number; deviceId?: string; details?: string } = {},
  ): void {
    const ts = now();
    const res = db
      .prepare('INSERT INTO audit_log (ts, actor, action, incident_id, device_id, details) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ts, actor, action, ref.incidentId ?? null, ref.deviceId ?? null, ref.details ?? null);
    const entry = rowToAudit(
      db.prepare('SELECT * FROM audit_log WHERE id = ?').get(Number(res.lastInsertRowid)) as Row,
    );
    publish({ type: 'audit', entry });
  }

  function publishDevice(id: string): void {
    const device = getDevice(id);
    if (device) publish({ type: 'device', device });
  }

  function publishIncident(id: number): void {
    publish({ type: 'incident', incident: incidentView(id) });
  }

  /** Point d'entree des messages MQTT `psim/detectors/<id>/state`. Ne leve jamais d'exception. */
  function handleDetectorMessage(deviceId: string, payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) return;
    const state = (payload as { state?: unknown }).state;
    if (typeof state !== 'string' || !DETECTOR_STATES.has(state)) return;
    const device = getDevice(deviceId);
    if (!device || device.kind !== 'detector') return;

    const previous = device.status;
    db.prepare('UPDATE device SET status = ?, last_seen = ? WHERE id = ?').run(state, now(), deviceId);
    if (previous !== state) {
      audit('detecteur', 'device_state', { deviceId, details: `${previous} -> ${state}` });
    }
    publishDevice(deviceId);

    const s = state as DetectorState;
    if (s !== 'prealarm' && s !== 'alarm') return;

    const severity: Severity = s === 'alarm' ? 'critical' : 'warning';
    const open = db
      .prepare("SELECT id, severity FROM incident WHERE detector_id = ? AND status <> 'closed'")
      .get(deviceId) as { id: number; severity: Severity } | undefined;

    if (!open) {
      const res = db
        .prepare('INSERT INTO incident (detector_id, severity, opened_at) VALUES (?, ?, ?)')
        .run(deviceId, severity, now());
      const id = Number(res.lastInsertRowid);
      audit('systeme', 'incident_opened', { incidentId: id, deviceId, details: severity });
      publishIncident(id);
    } else if (open.severity === 'warning' && severity === 'critical') {
      // Escalade : l'incident redevient "non acquitte" pour relancer l'alerte sonore.
      db.prepare(
        "UPDATE incident SET severity = 'critical', status = 'open', acked_at = NULL, acked_by = NULL WHERE id = ?",
      ).run(open.id);
      audit('systeme', 'incident_escalated', { incidentId: open.id, deviceId, details: 'warning -> critical' });
      publishIncident(open.id);
    }
  }

  /**
   * Declare « hors ligne » les detecteurs qui ne donnent plus signe de vie. A appeler regulierement.
   * Seuls les detecteurs « normal » ou « defaut » sont concernes : un detecteur en prealarme ou en
   * alarme garde son etat tant qu'il n'est pas revenu a la normale (comme une centrale), sinon un
   * silence pourrait masquer un feu en cours. Renvoie les identifiants nouvellement declares muets.
   */
  function checkSilentDetectors(): string[] {
    if (silentTimeoutMs <= 0) return [];
    const t = now();
    const rows = db
      .prepare("SELECT id, status, last_seen FROM device WHERE kind = 'detector' AND status IN ('normal', 'fault')")
      .all() as Row[];
    const silent: string[] = [];
    for (const row of rows) {
      const reference = Math.max((row.last_seen as number | null) ?? 0, startedAt);
      const silence = t - reference;
      if (silence < silentTimeoutMs) continue;
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
    return value.trim();
  }

  function cleanPercent(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new PsimError(400, `${field} doit etre un nombre entre 0 et 100`);
    }
    return value;
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
    db.prepare('INSERT INTO device (id, kind, name, zone, x, y, stream_kind) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      input.kind,
      name,
      zone,
      x,
      y,
      input.kind === 'camera' ? 'simulated' : null,
    );
    audit(actor, 'device_created', { deviceId: id, details: `${input.kind} ${name}` });
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
    db.prepare('UPDATE device SET name = ?, zone = ?, x = ?, y = ? WHERE id = ?').run(name, zone, x, y, id);
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
      incidents: incidentIds.map(incidentView),
      audit: listAudit(50),
    };
  }

  function listAudit(limit: number): AuditEntry[] {
    const n = Math.min(Math.max(Math.trunc(limit) || 50, 1), 500);
    return (db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(n) as Row[]).map(rowToAudit);
  }

  return {
    handleDetectorMessage,
    checkSilentDetectors,
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
