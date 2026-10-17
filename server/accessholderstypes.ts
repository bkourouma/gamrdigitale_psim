/**
 * Titulaires de badges (lot AC5, phase 2) : TYPES ET INTERFACES PARTAGES, figes par le superviseur du lot. Aucun code ici.
 * Ce fichier est le contrat entre les modules :
 *  - `accessholders.ts`   : titulaires, badges, groupes, plages horaires, jours feries, visiteurs, calcul des droits ;
 *  - `accesssync.ts`      : synchronisation PSIM -> controleurs (docs/CONTROLE-ACCES.md § 7) ;
 *  - `accessimport.ts`    : import CSV ;
 *  - `accessholdersapi.ts`: routes `/api/access/*` des titulaires (docs/ACCES.md § 12).
 * Chaque module n'importe QUE ce fichier pour connaitre les autres. Le modifier = decision du superviseur.
 */
import type { Window } from './arming.ts';
import type { AccessMethod, AccessResult, AccessReason } from './access.ts';

// ---- Vocabulaire ----------------------------------------------------------------------------------------------------------

export type HolderStatus = 'active' | 'suspended';
export type HolderKind = 'staff' | 'visitor';
/** `returned` : badge rendu (visiteur parti, carte restituee) : le numero redevient disponible. `lost` garde son numero reserve. */
export type BadgeState = 'active' | 'disabled' | 'lost' | 'returned';
/** Periode de validite par rapport a l'heure du PSIM. */
export type HolderPhase = 'upcoming' | 'valid' | 'expired';

export const HOLDER_STATUSES = ['active', 'suspended'] as const;
export const BADGE_STATES = ['active', 'disabled', 'lost', 'returned'] as const;

// ---- Vues (ce que les routes renvoient) -------------------------------------------------------------------------------------

export interface BadgeView {
  id: number;
  number: string;
  state: BadgeState;
  stateLabel: string; // « Actif », « Désactivé », « Perdu », « Rendu »
  stateAt: number;
  stateBy: string;
  createdAt: number;
}

export interface VisitorInfo {
  host: string; // accompagnateur
  reason: string;
  /** Fin de visite effective (rendu du badge, expiration) ou `null` tant qu'elle est en cours ou a venir. */
  endedAt: number | null;
}

export interface HolderView {
  id: number;
  /** Identifiant envoye aux controleurs : `H<id>`. */
  ref: string;
  lastName: string;
  firstName: string;
  /** « KONAN Yao » : nom puis prenom (63 caracteres au plus). */
  displayName: string;
  /** Matricule ou numero interne (facultatif, unique). */
  externalRef: string | null;
  kind: HolderKind;
  status: HolderStatus;
  validFrom: number | null;
  validTo: number | null;
  phase: HolderPhase;
  hasPhoto: boolean;
  badges: BadgeView[];
  groups: { id: number; name: string }[];
  visitor: VisitorInfo | null;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
}

export interface GroupDoorView {
  /** Identifiant du detecteur (porte). */
  doorId: string;
  /** `null` si la porte n'est plus declaree : le droit est alors sans effet. */
  doorName: string | null;
  controllerId: string | null;
  scheduleId: number;
  scheduleName: string;
}

export interface GroupView {
  id: number;
  name: string;
  description: string;
  /** Groupe que l'operateur peut donner a un visiteur depuis le poste de garde. */
  forVisitors: boolean;
  doors: GroupDoorView[];
  holderCount: number;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
}

export interface ScheduleView {
  id: number;
  /** Identifiant envoye aux controleurs : `S<id>`. */
  ref: string;
  name: string;
  /** Format `Window` de server/arming.ts (8 plages au plus). */
  windows: Window[];
  /** Vrai : la porte reste fermee les jours feries. */
  closedOnHolidays: boolean;
  /** « Tout le temps » (creee par le systeme, ni modifiable ni supprimable). */
  builtin: boolean;
  /** Nombre de groupes qui l'utilisent. */
  groupCount: number;
}

export interface HolidayView {
  date: string; // AAAA-MM-JJ
  label: string | null;
}

/** Dernier passage connu d'un titulaire (resume). */
export interface PassageBrief {
  id: number;
  doorId: string;
  doorName: string | null;
  atDevice: number;
  result: AccessResult;
  reason: AccessReason | null;
  resultLabel: string;
  method: AccessMethod;
  credential: string | null;
}

export interface HolderDetail extends HolderView {
  /** Dix derniers passages rattaches au titulaire (par `holder_id`). */
  recentPassages: PassageBrief[];
}

export interface VisitorView {
  holder: HolderView;
  host: string;
  reason: string;
  startsAt: number | null;
  endsAt: number;
  /** `present` : visite en cours ; `upcoming` : pas encore commencee ; `ended` : terminee (rendu ou expiree). */
  state: 'present' | 'upcoming' | 'ended';
  /** Millisecondes restantes (0 si terminee). */
  remainingMs: number;
  lastPassage: PassageBrief | null;
}

// ---- Entrees (corps des requetes, tout est valide par le service) -------------------------------------------------------------

export interface HolderInput {
  lastName?: unknown;
  firstName?: unknown;
  externalRef?: unknown;
  status?: unknown;
  validFrom?: unknown;
  validTo?: unknown;
  /** Remplace l'ensemble des groupes du titulaire. */
  groupIds?: unknown;
  /** A la creation seulement : numeros de badges (1 a 4), crees actifs. */
  badges?: unknown;
}

export interface GroupInput {
  name?: unknown;
  description?: unknown;
  forVisitors?: unknown;
  /** Remplace les droits du groupe : `[{ doorId, scheduleId }]`. */
  doors?: unknown;
}

export interface ScheduleInput {
  name?: unknown;
  windows?: unknown;
  closedOnHolidays?: unknown;
}

export interface VisitorInput {
  lastName?: unknown;
  firstName?: unknown;
  host?: unknown;
  reason?: unknown;
  /** Numero du badge remis au visiteur. */
  badge?: unknown;
  /** Groupe marque `forVisitors`. */
  groupId?: unknown;
  /** Duree de la visite en minutes (15 a 44 640 = 31 jours). */
  durationMinutes?: unknown;
}

export interface HolderFilters {
  /** Texte libre : nom, prenom, matricule ou debut de numero de badge (sans accents ni majuscules). */
  q?: unknown;
  status?: unknown;
  /** `staff` (defaut), `visitor` ou `all`. */
  kind?: unknown;
  groupId?: unknown;
  limit?: unknown;
  cursor?: unknown;
}

export interface HolderList {
  items: HolderView[];
  nextCursor: string | null;
  /** Nombre total de titulaires correspondant, plafonne a 10 000. */
  total: number;
}

// ---- Lecture des droits (pour les autres modules serveur : regles d'acces, armement des portes) ---------------------------------

/** Pourquoi un titulaire peut ou ne peut pas passer une porte a un instant donne. */
export type PassDecisionReason =
  | 'ok'
  | 'unknown_holder' // titulaire inconnu
  | 'suspended' // statut suspendu
  | 'not_started' // validFrom pas encore atteint
  | 'expired' // validTo depasse, ou visite terminee
  | 'no_badge' // aucun badge actif
  | 'no_right' // aucun groupe ne donne cette porte
  | 'out_of_schedule' // hors des plages du droit
  | 'holiday'; // jour ferie et la plage est fermee les jours feries

export interface PassDecision {
  allowed: boolean;
  reason: PassDecisionReason;
  /** Groupe dont le droit s'applique (le premier qui autorise, ou celui qui refuse en dernier) ; `null` si aucun. */
  groupId: number | null;
  scheduleId: number | null;
}

/** Interface de LECTURE stable des titulaires et de leurs droits (aucune ecriture, aucun effet de bord, aucune entree de journal). */
export interface HoldersReader {
  /** Groupes d'un titulaire (vide si inconnu). */
  groupsOf(holderId: number): { id: number; name: string }[];
  /** Titulaire qui porte ce numero de badge (hors badges rendus), ou `null`. */
  holderOfBadge(number: string): HolderView | null;
  /**
   * Ce titulaire a-t-il le droit de passer cette porte (identifiant du detecteur) a l'instant `at` (ms, defaut maintenant) ?
   * Tient compte du statut, des dates de validite, de la visite, des badges actifs, des groupes, de la plage horaire du droit
   * (format `Window`, heure locale du serveur) et des jours feries. C'est le droit THEORIQUE du PSIM : le controleur reste seul a decider.
   */
  canPass(holderId: number, doorId: string, at?: number): PassDecision;
  /**
   * Groupes dont un droit est en vigueur a l'instant `at` (donc « autorises a cette heure »), pour une porte ou pour toutes
   * si `doorId` est absent. Un module de regles compare par exemple `at` a une heure de nuit.
   */
  groupsAllowedAt(at: number, doorId?: string): { id: number; name: string; doorIds: string[] }[];
  /** Vrai si l'instant `at` tombe un jour ferie du calendrier du PSIM. */
  isHoliday(at: number): boolean;
}

// ---- Droits : ce que chaque controleur doit contenir ---------------------------------------------------------------------------

export interface DesiredHolder {
  /** `H<id>` */
  ref: string;
  /** « KONAN Yao », 64 caracteres au plus. */
  name: string;
  /** Faux : titulaire suspendu (le controleur refuse, mais le connait). */
  active: boolean;
  validFrom: number | null;
  validTo: number | null;
  /** Numeros des badges ACTIFS seulement (4 au plus), tries. */
  credentials: string[];
  /** Portes de CE controleur autorisees (4 au plus), triees par `doorNo`. */
  doors: { doorNo: number; scheduleRef: string }[];
}

export interface DesiredSchedule {
  /** `S<id>` */
  ref: string;
  windows: Window[];
  holidays: boolean;
}

/** Contenu attendu d'un controleur. Tous les tableaux sont tries (ordre stable : l'empreinte en depend). Jamais de photo, de PIN ni de gabarit. */
export interface DesiredState {
  /** Titulaires ayant au moins une porte sur ce controleur et dont la visite n'est pas terminee. */
  holders: DesiredHolder[];
  /** Plages horaires utilisees par ces titulaires. */
  schedules: DesiredSchedule[];
  /** Jours feries `AAAA-MM-JJ` a partir du 1er janvier de l'annee courante, tries, 400 au plus. */
  holidays: string[];
}

export type RightsListener = (controllerIds: string[]) => void;

/** Ce que la synchronisation demande au calcul des droits. Implemente par `HoldersService`. */
export interface RightsSource {
  /** Controleurs declares (table `access_controller`). */
  controllerIds(): string[];
  desired(controllerId: string): DesiredState;
  /** Appele (de facon synchrone, apres l'ecriture) avec les controleurs dont le contenu attendu a pu changer. */
  subscribe(listener: RightsListener): void;
}

// ---- Service des titulaires -----------------------------------------------------------------------------------------------------

export interface MutationOptions {
  /** Import en masse : pas d'entree de journal par ligne (l'import en ecrit une seule). */
  quiet?: boolean;
}

export interface HoldersService extends RightsSource, HoldersReader {
  list(filters: HolderFilters, actor: string): HolderList;
  get(id: number): HolderDetail;
  /** Identifiant d'URL -> entier, ou 404 (« Titulaire introuvable »). */
  create(actor: string, input: HolderInput, opts?: MutationOptions): HolderView;
  update(actor: string, id: number, input: HolderInput, opts?: MutationOptions): HolderView;
  remove(actor: string, id: number): void;
  /** Cherche un titulaire par matricule (insensible a la casse) ou `null`. */
  findByExternalRef(ref: string): HolderView | null;
  /** Cherche le titulaire qui porte ce numero de badge (hors badges rendus) ou `null`. */
  findByBadge(number: string): HolderView | null;
  findByName(lastName: string, firstName: string): HolderView[];

  photo(id: number): { mime: string; data: Buffer } | null;
  setPhoto(actor: string, id: number, mime: string, data: Buffer): void;
  clearPhoto(actor: string, id: number): void;

  addBadge(actor: string, holderId: number, number: unknown, opts?: MutationOptions): BadgeView;
  setBadgeState(actor: string, badgeId: number, state: unknown): BadgeView;
  removeBadge(actor: string, badgeId: number): void;

  groups(): GroupView[];
  group(id: number): GroupView;
  createGroup(actor: string, input: GroupInput): GroupView;
  updateGroup(actor: string, id: number, input: GroupInput): GroupView;
  deleteGroup(actor: string, id: number): void;
  groupByName(name: string): GroupView | null;

  schedules(): ScheduleView[];
  schedule(id: number): ScheduleView;
  createSchedule(actor: string, input: ScheduleInput): ScheduleView;
  updateSchedule(actor: string, id: number, input: ScheduleInput): ScheduleView;
  deleteSchedule(actor: string, id: number): void;

  holidays(): HolidayView[];
  /** Remplace toute la liste (400 dates au plus). */
  setHolidays(actor: string, entries: unknown): HolidayView[];

  /** Visiteurs en cours et a venir, plus ceux terminés depuis moins de 24 h (`scope: 'recent'`). */
  visitors(scope?: 'current' | 'recent'): VisitorView[];
  createVisitor(actor: string, input: VisitorInput): VisitorView;
  /** Fin de visite immediate : badge rendu, retrait des controleurs. */
  endVisitor(actor: string, holderId: number): VisitorView;

  /** Rattachement d'un passage (appele par access.ts a l'enregistrement) : `holderRef` `H<id>` d'abord, puis numero de badge. */
  resolve(credential: string | null, holderRef: string | null): { id: number; name: string } | null;

  /** Fin automatique des visites, purge des visiteurs anciens. A appeler chaque seconde (peu couteux). Ne leve jamais. */
  tick(): void;
  /** Regroupe les ecritures d'une operation en masse : une seule transaction, une seule notification des controleurs. */
  batch<T>(fn: () => T): T;
  /**
   * Simulation (import « a blanc ») : execute `fn` (qui appelle les memes methodes que pour de vrai), puis ANNULE toutes les ecritures
   * (savepoint) ; aucune notification, aucune entree de journal ne subsiste. Renvoie ce que renvoie `fn`.
   */
  simulate<T>(fn: () => T): T;
}

// ---- Synchronisation -------------------------------------------------------------------------------------------------------------

/** Transport vers la passerelle (MQTT, `psim/access/<controllerId>/sync`, QoS 1, jamais retain). */
export interface SyncTransport {
  /** Publie le message ; faux si le transport n'est pas pret (non connecte) : l'essai n'est alors pas compte. Ne leve jamais. */
  publish(controllerId: string, payload: string): boolean;
}

export type SyncItemKind = 'holder' | 'schedule' | 'holidays';
/**
 * synced : le controleur a accuse le contenu actuel ; pending : en attente ou en cours d'essai ; failed : refuse, ou sans accuse
 * apres plus de 5 essais ; blocked : suppression en attente de confirmation de l'administrateur.
 */
export type SyncState = 'synced' | 'pending' | 'failed' | 'blocked';

export interface SyncItemView {
  kind: SyncItemKind;
  ref: string;
  /** `upsert` : creer ou mettre a jour ; `delete` : retirer du controleur. */
  op: 'upsert' | 'delete';
  state: SyncState;
  attempts: number;
  /** Code de l'accuse (`invalid`, `full`, `not_supported`, `io`, `unreachable`) ou `no_ack` (aucune reponse). */
  code: string | null;
  /** Phrase en francais : ce qui s'est passe et que faire. */
  message: string | null;
  since: number;
}

export interface SyncControllerStatus {
  controllerId: string;
  controllerName: string;
  /** Une cle de synchronisation existe. */
  enabled: boolean;
  keyCreatedAt: number | null;
  /** `disabled` : pas de cle ; `ok` : tout est synchronise ; `pending` ; `failed` ; `blocked` : suppressions a confirmer. Le plus grave l'emporte (blocked > failed > pending > ok). */
  state: 'disabled' | 'ok' | 'pending' | 'failed' | 'blocked';
  counts: Record<SyncState, number>;
  lastAckAt: number | null;
  /** Dernier incident (refus ou absence d'accuse), ou `null`. */
  lastProblem: { code: string; message: string; at: number } | null;
  /** Suppressions retenues : nombre et references (20 au plus listees). */
  awaitingConfirmation: { count: number; refs: string[] } | null;
  /** Faux : le transport n'est pas connecte (rien n'est perdu, tout part des qu'il l'est). */
  transportReady: boolean;
  /** Phrase en francais : etat et quoi faire. */
  hint: string;
}

export interface SyncControllerDetail extends SyncControllerStatus {
  /** Elements non synchronises (en attente, echec, bloque), 200 au plus, les plus graves d'abord. */
  items: SyncItemView[];
}

export interface HolderSyncView {
  controllerId: string;
  controllerName: string;
  state: SyncState;
  message: string | null;
}

export type AckVerdict =
  | { accepted: true }
  | { accepted: false; reason: 'unknown_controller' | 'no_key' | 'format' | 'signature' | 'no_operation' | 'mismatch' };

export interface SyncService {
  /** Au demarrage : tout est a reconcilier, l'operation en vol (persistee) est renvoyee. */
  start(): void;
  /** Chaque seconde : renvois echus, envoi de l'operation suivante. Ne leve jamais. */
  tick(): void;
  /** Les droits ont change (ou tous si absent) : recalcul de ce qui est attendu, sans attendre le tick. */
  notify(controllerIds?: string[]): void;
  /** Entree des accusés (`psim/access/<controllerId>/sync-ack`). Signature fausse : ignoree sans effet. Ne leve jamais. */
  receiveAck(controllerId: string, payload: string | Buffer): AckVerdict;

  status(): SyncControllerStatus[];
  /** 404 si le controleur n'existe pas. */
  controller(controllerId: string): SyncControllerDetail;
  /** Etat d'un titulaire sur chacun des controleurs ou il est attendu (ou a ete envoye). Vide : aucune porte. */
  holderStatus(holderRef: string): HolderSyncView[];

  /** Cree la cle (ou la renouvelle). Renvoie la cle en hexadecimal (64 car.) : montree UNE fois, jamais relue. */
  issueKey(actor: string, controllerId: string): { key: string; createdAt: number; renewed: boolean };
  /** Autorise l'envoi des suppressions actuellement retenues (liste figee au moment de l'appel). */
  confirmDeletions(actor: string, controllerId: string): { confirmed: number };
  /** Remet en file les elements en echec (nouvel essai immediat). */
  retry(actor: string, controllerId: string): { requeued: number };
}

// ---- Import CSV --------------------------------------------------------------------------------------------------------------------

export interface ImportLineReport {
  /** Numero de ligne dans le fichier (l'en-tete est la ligne 1). */
  line: number;
  outcome: 'created' | 'updated' | 'unchanged' | 'error';
  /** Nom affiche si connu (pour que l'administrateur reconnaisse la ligne). */
  name: string | null;
  /** Erreurs bloquantes (la ligne n'est pas appliquee). */
  errors: string[];
  /** Remarques (homonyme, encodage...) : la ligne est appliquee. */
  warnings: string[];
}

export interface ImportReport {
  dryRun: boolean;
  /** Encodage detecte : `utf-8` ou `windows-1252`. */
  encoding: 'utf-8' | 'windows-1252';
  /** Separateur detecte. */
  delimiter: ';' | ',' | '\t';
  lines: number;
  created: number;
  updated: number;
  unchanged: number;
  errors: number;
  /** Une entree par ligne en erreur ou avec remarque, puis les autres (plafond 2 000 entrees renvoyees ; `truncated` le dit). */
  items: ImportLineReport[];
  truncated: boolean;
  /** Refus global (fichier vide, en-tete inconnu, trop grand...) : aucune ligne n'est appliquee. */
  fatal: string | null;
}
