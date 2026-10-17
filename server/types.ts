import type { Request, RequestHandler } from 'express';
import type { Session } from './auth.ts';

/** `agent` : compte d'un agent de terrain (application mobile) ; limite aux routes `/api/agent/*`, jamais de poste de garde. */
export type Role = 'operator' | 'admin' | 'agent';
export type DeviceKind = 'detector' | 'camera';
/** Ce que surveille un detecteur. Les incidents, notifications et confirmations suivent le meme circuit pour toutes. */
export type DeviceCategory = 'fire' | 'intrusion' | 'access' | 'environment' | 'energy' | 'people';
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
  x: number; // % de la largeur du plan de son etage
  y: number; // % de la hauteur du plan de son etage
  /** Etage (voir `floors.ts`) : chaque equipement est sur exactement un etage. */
  floorId: number;
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
  /** Nom de l'etage du detecteur (un duplex a une « Chambre » a chaque niveau : l'etage dit laquelle). */
  floor: string;
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
  /**
   * Alarme recue en differe (passerelle qui renvoie ses messages apres une coupure) : retard en ms entre l'heure reelle
   * (`openedAt`) et la reception. `null` ou absent : recue en direct.
   */
  receivedLateMs?: number | null;
  /** Evenement nomme a l'origine de l'alarme (voir EVENT_LABEL), ou null : etat ou mesure sans evenement. */
  event: string | null;
  /**
   * Precision en clair apportee par l'equipement avec son evenement (ex. « 3 points manques : Parking, ... »), 300 caracteres
   * au plus ; `null` si le message n'en portait pas.
   */
  detail: string | null;
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
  | { type: 'config' }
  // Commandes des equipements (voir actuators.ts) : etat d'une commande, ou liste des actionneurs a relire.
  | { type: 'command'; command: import('./actuators.ts').CommandView }
  | { type: 'actuators' };

/** Un etage du site, du plus bas (`position` 0) au plus haut, avec son propre plan. */
export interface Floor {
  id: number;
  name: string;
  position: number;
  hasPlan: boolean;
  planVersion: number;
}

export interface Snapshot {
  /** `hasPlan` / `planVersion` : ceux de l'etage le plus bas (compatibilite avec l'ancien plan unique). */
  site: { name: string; hasPlan: boolean; planVersion: number };
  /** Du plus bas au plus haut ; jamais vide. */
  floors: Floor[];
  devices: Device[];
  links: Record<string, string[]>;
  /** Zones d'intrusion : `true` = armee. Les zones sans detecteur d'intrusion n'y figurent pas. */
  arming: Record<string, boolean>;
  incidents: Incident[];
  audit: AuditEntry[];
}

// ---- Application des agents (voir docs/AGENTS-RONDES.md, section « API agent ») ----

export interface AgentMe {
  username: string;
  displayName: string;
  zones: string[];
  shift: { id: number; startedAt: number; endsAt: number } | null;
  position: { checkpointId: number; name: string; at: number } | null;
}

export interface AgentAlarm {
  id: number;
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
  deviceName: string;
  zone: string;
  floorName: string;
  openedAt: number;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  hasSnapshot: boolean;
  hasLive: boolean;
  dispatch: { username: string; displayName: string; status: 'en_route' | 'on_site'; at: number }[];
}

export interface AgentRun {
  id: number;
  routeId: number;
  name: string;
  status: 'pending' | 'active' | 'done' | 'incomplete' | 'missed';
  dueStart: number;
  dueEnd: number;
  ordered: boolean;
  checkpoints: { id: number; name: string; zone: string; done: boolean; doneAt: number | null }[];
}

/**
 * Ce que `api.ts` fournit aux modules qui montent leurs propres routes (`agents.mount`, `patrols.mount`) :
 * les memes controles d'acces que le reste de l'API, sans que le module connaisse les details d'Express ou des sessions.
 */
export interface MountContext {
  /** Session valide (cookie psim_session), ou null. */
  sessionOf: (req: Request) => Session | null;
  /** 401/403 comme le reste de l'API. */
  adminOnly: RequestHandler;
  /** Administrateur ou operateur. */
  staff: RequestHandler;
  /** Nom du compte (apres adminOnly / staff). */
  actorOf: (req: Request) => string;
  /** Role de la session (apres adminOnly / staff). */
  roleOf: (req: Request) => Role;
  /** `express.json({ limit })`. */
  json: (limit: string) => RequestHandler;
  cookieSecure: boolean;
  /** Origine publique du PSIM (« https://hote:port ») pour les URL d'appairage et d'etiquette : PSIM_PUBLIC_URL, sinon la requete. */
  originOf: (req: Request) => string;
}
