export type Role = 'operator' | 'admin';
export type DeviceKind = 'detector' | 'camera';
/** Ce que surveille un detecteur. Les incidents, notifications et confirmations suivent le meme circuit pour toutes. */
export type DeviceCategory = 'fire' | 'intrusion' | 'access' | 'environment';
/** Sens du depassement d'un seuil : `above` = trop haut (chaleur), `below` = trop bas (gel, batterie). */
export type Direction = 'above' | 'below';
export type DetectorState = 'normal' | 'prealarm' | 'alarm' | 'fault' | 'offline';
export type IncidentStatus = 'open' | 'acknowledged' | 'closed';
export type Severity = 'warning' | 'critical';
/** `fire` = evenement reel, quelle que soit la categorie (intrusion averee, effraction...) ; le mot est conserve pour les donnees existantes. */
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
  /** Detecteurs : ce qu'ils surveillent. `fire` pour les cameras. */
  category: DeviceCategory;
  /** Capteurs a mesure : unite, seuils et derniere valeur recue. */
  valueUnit: string | null;
  warnAt: number | null;
  alarmAt: number | null;
  direction: Direction;
  lastValue: number | null;
  /** Delai (s) sans message avant « hors ligne » : `null` = delai general, 0 = non supervise. */
  heartbeatS: number | null;
}

export interface Incident {
  id: number;
  detectorId: string;
  detectorName: string;
  zone: string;
  category: DeviceCategory;
  /** Derniere mesure du capteur (affichee a titre indicatif). */
  lastValue: number | null;
  valueUnit: string | null;
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
  /** Zones d'intrusion : `true` = armee. Les zones sans detecteur d'intrusion n'y figurent pas. */
  arming: Record<string, boolean>;
  incidents: Incident[];
  audit: AuditEntry[];
}
