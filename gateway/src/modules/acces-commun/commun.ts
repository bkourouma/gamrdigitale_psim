/**
 * Code COMMUN aux modules de controle d'acces (`acces-dahua`, `acces-zkteco`). Point d'entree unique :
 *
 *     import { ControllerSupervisor, CursorStore } from '../acces-commun/commun.ts';
 *
 * Ce dossier n'est PAS un module de passerelle : il n'a pas de `index.ts` (donc `moduleEntry` de gateway/src/config.ts ne
 * le charge jamais) et il ne cree aucun temporisateur. Tout est pilote par un `now()` injecte et par `tick()` que le
 * module de marque appelle a intervalle regulier (1 s). Aucune dependance hors `node:` et les types de gateway/src/module.ts et le code de actuator.ts (`ActuatorFailure`).
 * Contrat des messages : docs/CONTROLE-ACCES.md, section 2.
 *
 * ----------------------------------------------------------------------------------------------------------------------
 * UTILISATION PAR UN MODULE DE MARQUE
 * ----------------------------------------------------------------------------------------------------------------------
 *
 *   start(ctx):
 *     const cursors = new CursorStore({ dir: <dossier d'etat du module>, now: ctx.now, log: ctx.log });
 *     const sup = new ControllerSupervisor({
 *       controllerId: 'CTL-1',                               // ^[A-Za-z0-9_-]{1,32}$ (leve RangeError sinon)
 *       doors: new Map([[1, 'PORTE-ENTREE'], [2, 'PORTE-SERVEUR']]),   // no de porte -> id detecteur PSIM (1 a 32 car.)
 *       emit: (id, msg) => ctx.emit(id, msg),                // renvoie false si le message n'est PAS en file
 *       now: ctx.now, log: ctx.log, cursors,
 *       epoch: cfg.epoch,                                    // facultatif (0) : controleur remplace, voir "Epoque" plus bas
 *       thresholds: { denied: { count: 3, windowS: 60 } },   // facultatif, tout a une valeur par defaut
 *     });
 *     // un minuteur de 1 s (cree PAR LE MODULE, arrete dans stop()) : sup.tick(); puis, si sup.driftDue(), lire l'heure du
 *     // controleur et appeler sup.deviceTime(heureControleurMs).
 *   stop(): sup.flush()  (ecrit les curseurs sur le disque), puis fermer la liaison.
 *
 *   Ce que la marque appelle :
 *     sup.alive()                       a CHAQUE preuve de vie (octets du flux, reponse a une interrogation, lecture de l'heure).
 *     sup.linkLost(raison, opts?)       flux ferme / hote injoignable. Hors ligne apres `offlineGraceMs` (15 s) sans retour,
 *                                       une seule fois ; `{ immediate: true }` = sans delai. Ne JAMAIS emettre soi-meme `offline`.
 *     sup.submit(passage)  -> 'sent' | 'duplicate' | 'refused' | 'ignored'
 *     sup.passage(passage) -> boolean   vrai = en file (ou deja emis). Faux = refuse OU ignore : preferer `submit`.
 *     sup.doorEvent(porte, nature, ts, idPart?)        nature : opened | closed | forced | held_open | held_open_end | tamper | tamper_end
 *                                       | duress (contrainte : alarme `panic`, sans fin, sans effet sur l'etat memorise de la porte)
 *     sup.controllerEvent('tamper' | 'tamper_end', ts, idPart?)   sabotage du boitier : toutes les portes
 *     sup.doorMode(porte, mode, ts?) -> boolean   mode COURANT de la porte (F19) : 'normal' | 'always_open' | 'always_closed'
 *     sup.deviceTime(heureControleurMs, instantDeLecture?) -> ecart signe (ms) ou null si l'heure est aberrante
 *     sup.driftDue()                    vrai quand il faut relire l'heure du controleur (a chaque reconnexion, puis toutes les 300 s)
 *     sup.tick()  sup.flush()  sup.state()    state().doors[i].mode = dernier mode connu de la porte (null si inconnu)
 *     sup.cursorKey                     cle du curseur de recuperation de CE controleur et de son epoque
 *
 * Mode de porte (F19) : appeler `sup.doorMode(porte, mode)` a la connexion (lecture du mode de chaque porte) puis a chaque
 * changement. Le superviseur ne re-emet pas un mode identique, re-emet le dernier mode connu une fois a chaque retour en ligne
 * (`alive()` apres une coupure), differe tout envoi tant que le controleur n'est pas en ligne (`door_mode` est un signe de vie
 * pour le PSIM) et retente seul si le socle refuse. N'appeler qu'avec le mode COURANT, jamais un mode lu dans l'historique.
 *
 * Epoque (controleur remplace, numeros d'enregistrement repartis de zero) : `epoch` (entier >= 0) vient de la configuration du
 * module (`validEpoch(epoch)` pour la controler au chargement). La marque fabrique les identifiants d'evenement avec
 * `epochEventId(epoch, String(rec.recNo))` (epoque 0 : numero inchange ; sinon "<epoque>.<numero>") et lit/ecrit le curseur sous
 * `sup.cursorKey` (= `cursorKey(controllerId, epoch)` : le controleur seul pour l'epoque 0, sinon "<controleur>~e<epoque>").
 * Le curseur d'une epoque n'est donc jamais compare a celui d'une autre, et la recuperation repart de zero a la nouvelle epoque.
 *
 * Synchronisation des titulaires PSIM -> controleur (docs/CONTROLE-ACCES.md, par. 7). La marque ne fournit que ce qu'elle sait
 * ecrire dans SON controleur ; validation, file, numeros de plage, idempotence et traduction des echecs sont communs :
 *
 *     const slots = new SlotMap({ dir, now: ctx.now, log: ctx.log, min: 1, max: 8 });   // plages libres du controleur (une SlotMap par module)
 *     const driver: SyncDriver = {                       // chaque methode ne se resout que si le controleur a CONFIRME
 *       async upsertHolder(h, doorSlots) { ... },        // h : holderRef, name, active, validFrom, validTo, credentials, doors
 *       async deleteHolder(holderRef) { ... },           // absent = succes
 *       async upsertSchedule(ref, slot, windows, holidays) { ... },
 *       async deleteSchedule(ref, slot) { ... },
 *       async setHolidays(dates, replace) { ... },
 *     };                                                 // echec : throw new ActuatorFailure('io', 'message') ; delai d'attente = a la marque
 *     registerAccessSync(ctx, 'CTL-1', makeSyncHandler('CTL-1', driver, { slots, now: ctx.now, log: ctx.log }));   // faux si le socle n'a pas onAccessSync
 *     // dans le minuteur de 1 s : slots.tick() ; dans stop() : slots.flush()
 *
 *   Reponses : `done` ; `refused` (codes not_supported, invalid, full) ; `error` (io, unreachable, timeout, busy...). Un echec du
 *   controleur n'alloue jamais de plage ; `ActuatorFailure('not_supported' | 'invalid' | 'full')` devient un refus, tout autre code
 *   (ou toute autre exception) une erreur. Aucun PIN, gabarit ni photo ne traverse ce code (champs refuses a la validation).
 *   `parseSyncBody(raw)` valide a part une entree hostile : `{ ok: true, op }` ou `{ ok: false, error }`, sans exception.
 *
 * Recuperation des passages manquants (F8), schema type d'une boucle de la marque apres un retour de liaison :
 *
 *     const from = cursors.get('CTL-1');                      // { cursor, ts } ou null (jamais vu)
 *     for (const rec of lireMemoireControleurApres(from?.cursor)) {   // dans l'ordre chronologique
 *       const r = sup.submit({ ...traduire(rec), deferred: true, cursor: String(rec.recNo) });
 *       if (r === 'refused') break;                           // le socle est plein : on retentera au prochain passage
 *       // 'ignored' (porte inconnue, donnees inutilisables) : on passe au suivant sans rien faire de plus
 *     }
 *
 *   Le curseur n'avance QUE pour un message en file (ou un doublon). Les passages recus en direct portent aussi `cursor`
 *   (avec `deferred: false`) pour que la recuperation reparte du bon endroit apres un redemarrage.
 *
 * ----------------------------------------------------------------------------------------------------------------------
 * COMPORTEMENT GARANTI
 * ----------------------------------------------------------------------------------------------------------------------
 *  - Passage : un message `badge_granted` / `badge_denied` par `eventId` (doublons ignores, anneau de 4 096 par controleur,
 *    memorise seulement quand le socle a mis le message en file). Message = `{ event, ts, msgId, access }`, msgId
 *    `acc:<controllerId>:<eventId>` (empreinte courte au-dela de 64 car.), 1 024 octets au plus (le nom est raccourci).
 *    Jamais de PIN (`credential = null` si la methode est `code`), jamais de champ en plus.
 *  - Refus : jamais une alarme a lui seul. X refus (3) en Y secondes (60) sur une porte => `badge_denied_repeated`
 *    (pre-alarme, heure du refus declencheur, msgId deterministe) ; le compteur de la porte repart de zero. Fenetre calculee sur
 *    l'heure du controleur. Un passage accepte ne remet pas le compteur a zero. Si le socle refuse ce message, il est renvoye au
 *    `tick()` suivant.
 *  - Liaison : en ligne => `heartbeat` par porte toutes les 60 s ; premiere preuve de vie ou retour apres
 *    `offline` => `heartbeat` immediat. Controleur muet (aucun `alive()`) depuis 30 s => traite comme une coupure. Hors ligne =>
 *    `{ state: 'offline' }` par porte, UNE fois, aucun signe de vie tant que la panne dure. Un controleur jamais joint depuis la
 *    creation du superviseur est traite de meme au bout de 30 s.
 *  - Horloge : ecart > 2 min => `clock_drift` par porte (repete toutes les 300 s tant que ca dure) ; retour sous 1 min =>
 *    `restored`, sauf sur une porte encore forcee / maintenue ouverte / sabotee (son retour viendra de son propre evenement).
 *  - Contrainte : `doorEvent(porte, 'duress', ts, idPart?)` => `{ event: 'panic' }` (alarme toujours active), msgId deterministe
 *    `duress-<porte>-<ts>[-idPart]`, aucune fin de contrainte, aucun effet sur les etats memorises (forcee, maintenue, sabotee, derive).
 *  - Mode de porte : `{ event: 'door_mode', doorMode, ts, msgId }` (msgId `mode-<porte>-<ts>-<mode>`) ; jamais deux fois le meme
 *    mode d'affilee, sauf une fois par retour en ligne ; jamais emis hors ligne ; jamais de `heartbeat` en plus.
 *  - Limite connue : le PSIM ne garde qu'un seul etat par detecteur. Un `door_closed` (retour a la normale) recu pendant un
 *    sabotage ou une derive d'horloge encore actifs les efface cote PSIM ; la derive est re-emise toutes les 300 s, pas le sabotage.
 *  - Journaux : jamais de badge, de nom ni de mot de passe ; textes du reseau nettoyes et bornes ; un meme message au plus une
 *    fois par minute (et 30 lignes par minute en tout).
 *  - Aucune exception ne sort des methodes d'emission ; les erreurs de configuration (identifiant de controleur ou de detecteur
 *    invalide, aucune porte) levent `RangeError` au constructeur.
 */
export { emitted } from './types.ts';
export { ActuatorFailure } from './actuator.ts';
export type { ActuatorOutcome } from './actuator.ts';
export type {
  ControllerEventKind,
  DoorEventKind,
  Emitter,
  LogFn,
  LogLevel,
  PassageInput,
  PassageOutcome,
} from './types.ts';
export {
  CONTROLLER_ID,
  MAX_MESSAGE_BYTES,
  cleanCredential,
  cleanEventId,
  cleanRef,
  cleanText,
  doorEventMessage,
  passageMessage,
  passageMsgId,
  validTs,
} from './messages.ts';
export type { DoorEventSpec } from './messages.ts';
export { DenialCounter } from './denials.ts';
export type { DenialOptions } from './denials.ts';
export { CURSOR_FILE, CursorStore, defaultCursorCompare, realCursorIo } from './cursor.ts';
export type { CursorCompare, CursorEntry, CursorIo, CursorStoreOptions } from './cursor.ts';
export { CURSOR_KEY, MAX_EPOCH, cursorKey, epochEventId, validEpoch } from './epoch.ts';
export { SCHEDULE_REF, SLOTS_FILE, SlotMap } from './slots.ts';
export type { SlotIo, SlotMapOptions } from './slots.ts';
export { HOLDER_REF, makeSyncHandler, parseSyncBody, registerAccessSync, validCalendarDate } from './sync.ts';
export type {
  AccessSyncBody,
  AccessSyncHandler,
  AccessSyncOp,
  SyncDriver,
  SyncHandlerOptions,
  SyncHolder,
  SyncHolderDoor,
  SyncParse,
  SyncWindow,
  UpsertHolderBody,
} from './sync.ts';
export { createLimitedLog } from './limitedlog.ts';
export type { LimitedLog } from './limitedlog.ts';
export { ControllerSupervisor, DEFAULT_THRESHOLDS } from './supervisor.ts';
export type { DoorSnapshot, LinkState, PartialThresholds, SupervisorOptions, SupervisorState, Thresholds } from './supervisor.ts';
