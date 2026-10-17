/** Contrat entre le socle de la Passerelle GAMR et ses modules. Ne pas modifier sans accord du lead. */
export type DetectorState = 'normal' | 'prealarm' | 'alarm' | 'fault' | 'offline';

/** Message vers le PSIM (topic psim/detectors/<id>/state). Au moins un de state, event, value. */
export interface DeviceMessage {
  state?: DetectorState;
  event?: string;
  value?: number;
  /** Heure reelle de l'evenement (ms epoch, entier). Absent = le socle met l'heure courante. */
  ts?: number;
  /** Identifiant unique du message pour cet equipement. Absent = le socle en genere un. */
  msgId?: string;
}

export interface MqttLink {
  subscribe(topic: string, onMessage: (topic: string, payload: Buffer) => void): Promise<void>;
  close(): Promise<void>;
}

/** Ordre deja verifie par le socle (signature, fraicheur, anti-rejeu, plafonds locaux). */
export interface ActuatorRequest {
  actuatorId: string;
  cmdId: string;
  action: string; // ex. 'unlock', 'lock', 'open', 'close', 'stop'
  durationS?: number; // present pour une action temporisee
  clip?: string;
}
export interface ActuatorOutcome {
  result: 'done' | 'refused' | 'error';
  code?: string;
}
export type ActuatorHandler = (req: ActuatorRequest) => Promise<ActuatorOutcome>;

export interface ModuleContext {
  /** Envoie un message pour l'equipement PSIM `deviceId`. Ne leve jamais ; le socle met en file et renvoie. */
  emit(deviceId: string, msg: DeviceMessage): void;
  /** Ouvre une liaison MQTT vers un AUTRE broker (Zigbee2MQTT, ChirpStack...), en lecture. */
  openMqtt(url: string, opts?: { username?: string; password?: string }): Promise<MqttLink>;
  log(level: 'info' | 'warn' | 'error', text: string): void;
  /** Le module pilote l'actionneur `actuatorId` declare dans la configuration de la passerelle. */
  onActuator(actuatorId: string, handler: ActuatorHandler): void;
  /** Section de configuration propre au module. */
  config: Record<string, unknown>;
  now(): number;
}

export interface GatewayModule {
  readonly name: string;
  start(ctx: ModuleContext): Promise<void>;
  stop(): Promise<void>;
}

/** Chaque module exporte `create` depuis gateway/src/modules/<nom>/index.ts. */
export type ModuleFactory = (config: Record<string, unknown>) => GatewayModule;
