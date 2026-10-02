export type Role = 'operator' | 'admin';
export type DeviceKind = 'detector' | 'camera';
export type DetectorState = 'normal' | 'prealarm' | 'alarm' | 'fault' | 'offline';
export type IncidentStatus = 'open' | 'acknowledged' | 'closed';
export type Severity = 'warning' | 'critical';
export type Qualification = 'fire' | 'false_alarm';

export interface Device {
  id: string;
  kind: DeviceKind;
  name: string;
  zone: string;
  x: number; // % de la largeur du plan
  y: number; // % de la hauteur du plan
  status: string;
  streamKind: string | null;
  lastSeen: number | null;
}

export interface Incident {
  id: number;
  detectorId: string;
  detectorName: string;
  zone: string;
  severity: Severity;
  status: IncidentStatus;
  qualification: Qualification | null;
  comment: string | null;
  openedAt: number;
  ackedAt: number | null;
  ackedBy: string | null;
  closedAt: number | null;
  closedBy: string | null;
  cameraIds: string[];
  /**
   * Un incident est « a confirmer » tant que rien ne le corrobore, puis « confirme » (detecteur voisin
   * ou persistance). Ce n'est qu'une qualification : l'incident est visible et actif dans les deux cas.
   */
  confirmedAt: number | null;
  /** `neighbor:<idDetecteur>` ou `persistence`. */
  confirmationReason: string | null;
  /** Suggestion pour l'operateur ; ne ferme jamais l'incident. */
  hint: 'false_alarm_likely' | null;
  hintDetails: string | null;
  /** Images des cameras liees prises au moment de l'incident (ordre chronologique). */
  snapshots: { id: number; cameraId: string; takenAt: number; reason: string }[];
}

export interface AuditEntry {
  id: number;
  ts: number;
  actor: string;
  action: string;
  incidentId: number | null;
  deviceId: string | null;
  details: string | null;
}

export type PsimEvent =
  | { type: 'device'; device: Device }
  | { type: 'incident'; incident: Incident }
  | { type: 'audit'; entry: AuditEntry }
  | { type: 'config' };

export interface Snapshot {
  site: { name: string; hasPlan: boolean; planVersion: number };
  devices: Device[];
  links: Record<string, string[]>;
  incidents: Incident[];
  audit: AuditEntry[];
}
