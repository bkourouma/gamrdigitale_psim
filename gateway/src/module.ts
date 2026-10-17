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
  /** Mode de la porte (F19), avec `event: 'door_mode'` : `normal` (les badges fonctionnent), `always_open` ou `always_closed`. */
  doorMode?: DoorMode;
}

/** Mode de fonctionnement d'une porte dans son controleur (docs/CONTROLE-ACCES.md, § 2). */
export type DoorMode = 'normal' | 'always_open' | 'always_closed';

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

// --- Synchronisation des titulaires PSIM -> controleur (docs/CONTROLE-ACCES.md, par. 7) -----------------------------------

/** Plage horaire hebdomadaire : meme forme que `Window` de server/arming.ts (jours 0 = dimanche a 6, `HH:MM`, peut passer minuit). */
export interface SyncWindow {
  days: number[];
  from: string;
  to: string;
}

/** Porte accessible a un titulaire, avec son horaire (`null` = toutes les heures). */
export interface SyncHolderDoor {
  doorNo: number;
  scheduleRef: string | null;
}

export type UpsertHolderBody = {
  type: 'upsert_holder';
  /** `H<id>`. */
  holderRef: string;
  name: string;
  active: boolean;
  /** Debut et fin de validite (ms depuis 1970) ou `null` (sans limite). */
  validFrom: number | null;
  validTo: number | null;
  /** Numeros de badge, 4 au plus. */
  credentials: string[];
  doors: SyncHolderDoor[];
};

/** Corps d'un ordre de synchronisation (champ `body` du message, JSON). Jamais de code PIN, de gabarit ni de photo. */
export type AccessSyncBody =
  | UpsertHolderBody
  | { type: 'delete_holder'; holderRef: string }
  | { type: 'upsert_schedule'; scheduleRef: string; windows: SyncWindow[]; holidays: boolean }
  | { type: 'delete_schedule'; scheduleRef: string }
  | { type: 'set_holidays'; dates: string[]; replace: boolean };

/**
 * Ordre transmis par le socle au module : `opId` et `seq` (signature et anti-rejeu deja verifies par le socle) plus le corps,
 * tel que le PSIM l'a signe (le module le valide lui-meme : `parseSyncBody` de acces-commun).
 */
export type AccessSyncOp = { opId: string; seq: number } & AccessSyncBody;

/** Rend `done`, `refused` (`not_supported`, `invalid`, `full`) ou `error` (`io`, `unreachable`, `timeout`...). Doit etre idempotent. */
export type AccessSyncHandler = (op: AccessSyncOp) => Promise<ActuatorOutcome>;

export interface ModuleContext {
  /** Envoie un message pour l'equipement PSIM `deviceId`. Ne leve jamais ; le socle met en file et renvoie. */
  emit(deviceId: string, msg: DeviceMessage): void;
  /** Ouvre une liaison MQTT vers un AUTRE broker (Zigbee2MQTT, ChirpStack...), en lecture. */
  openMqtt(url: string, opts?: { username?: string; password?: string }): Promise<MqttLink>;
  log(level: 'info' | 'warn' | 'error', text: string): void;
  /** Le module pilote l'actionneur `actuatorId` declare dans la configuration de la passerelle. */
  onActuator(actuatorId: string, handler: ActuatorHandler): void;
  /**
   * Le module recoit les ordres de synchronisation des titulaires du controleur `controllerId` (topic
   * `psim/access/<controllerId>/sync`), signes avec `opts.key` (cle de synchronisation du controleur : 64 hexadecimaux
   * minuscules, lue dans la configuration du module, jamais journalisee). Le socle verifie signature et `seq`, n'execute qu'une
   * operation a la fois par controleur et accuse ; le gestionnaire ne fait qu'ecrire dans le controleur.
   *
   * LEVE (le module doit attraper : `registerAccessSync` de acces-commun le fait) si : l'identifiant est invalide
   * (`^[A-Za-z0-9_-]{1,32}$`), la cle est invalide, le gestionnaire n'est pas une fonction, le controleur est deja enregistre
   * (par ce module ou par un autre), ou l'instance du module est arretee. Le gestionnaire est retire a l'arret du module.
   */
  onAccessSync(controllerId: string, handler: AccessSyncHandler, opts: { key: string }): void;
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
