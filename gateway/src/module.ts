/** Contrat entre le socle de la Passerelle GAMR et ses modules. Ne pas modifier sans accord du lead. */
export type DetectorState = 'normal' | 'prealarm' | 'alarm' | 'fault' | 'offline';

/**
 * Passage a une porte (controle d'acces), tel que le PSIM le recoit dans le champ `access` d'un message
 * (docs/CONTROLE-ACCES.md, § 2). Jamais de gabarit biometrique, jamais de code PIN.
 */
export interface AccessPassage {
  /** Version du format. */
  v: 1;
  /** Identifiant PSIM du controleur (`access_controller.id`) : lettres, chiffres, `_` et `-`, 32 au plus. */
  controllerId: string;
  /** Identifiant de l'evenement DANS le controleur (n° d'enregistrement) ; unique par controleur. */
  eventId: string;
  direction: 'in' | 'out' | null;
  /** Numero de badge (32 caracteres au plus), ou `null` (bouton de sortie, ouverture a distance). Jamais un code PIN. */
  credential: string | null;
  /** Nom connu du controleur (64 caracteres au plus ; tronque au besoin pour tenir sous 1 024 octets). */
  holderName: string | null;
  /** Identifiant du titulaire dans le controleur (32 caracteres au plus). */
  holderRef: string | null;
  method: 'badge' | 'code' | 'fingerprint' | 'face' | 'exit_button' | 'remote' | 'unknown';
  result: 'granted' | 'denied';
  /** Motif d'un refus ; `null` pour un passage accepte. */
  reason: 'unknown_credential' | 'expired' | 'out_of_schedule' | 'disabled' | 'wrong_pin' | 'antipassback' | 'door_locked' | 'other' | null;
  /** Vrai si le passage a ete recupere dans la memoire du controleur apres une coupure. */
  deferred: boolean;
}

/** Message vers le PSIM (topic psim/detectors/<id>/state). Au moins un de state, event, value. */
export interface DeviceMessage {
  state?: DetectorState;
  event?: string;
  value?: number;
  /** Heure reelle de l'evenement (ms epoch, entier). Absent = le socle met l'heure courante. */
  ts?: number;
  /** Identifiant unique du message pour cet equipement. Absent = le socle en genere un. */
  msgId?: string;
  /** Passage a une porte (controle d'acces) : voir AccessPassage. Exige `ts` et `msgId` `acc:<controllerId>:<eventId>`. */
  access?: AccessPassage;
}

export interface MqttLink {
  subscribe(topic: string, onMessage: (topic: string, payload: Buffer) => void): Promise<void>;
  close(): Promise<void>;
}

export interface ModuleContext {
  /** Envoie un message pour l'equipement PSIM `deviceId`. Ne leve jamais ; le socle met en file et renvoie. */
  emit(deviceId: string, msg: DeviceMessage): void;
  /** Ouvre une liaison MQTT vers un AUTRE broker (Zigbee2MQTT, ChirpStack...), en lecture. */
  openMqtt(url: string, opts?: { username?: string; password?: string }): Promise<MqttLink>;
  log(level: 'info' | 'warn' | 'error', text: string): void;
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
