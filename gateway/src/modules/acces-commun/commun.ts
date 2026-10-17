/**
 * Code COMMUN aux modules de controle d'acces (`acces-dahua`, `acces-zkteco`). Point d'entree unique :
 *
 *     import { ControllerSupervisor, CursorStore } from '../acces-commun/commun.ts';
 *
 * Ce dossier n'est PAS un module de passerelle : il n'a pas de `index.ts` (donc `moduleEntry` de gateway/src/config.ts ne
 * le charge jamais) et il ne cree aucun temporisateur. Tout est pilote par un `now()` injecte et par `tick()` que le
 * module de marque appelle a intervalle regulier (1 s). Aucune dependance hors `node:` et les types de gateway/src/module.ts.
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
 *     sup.controllerEvent('tamper' | 'tamper_end', ts, idPart?)   sabotage du boitier : toutes les portes
 *     sup.deviceTime(heureControleurMs, instantDeLecture?) -> ecart signe (ms) ou null si l'heure est aberrante
 *     sup.driftDue()                    vrai quand il faut relire l'heure du controleur (a chaque reconnexion, puis toutes les 300 s)
 *     sup.tick()  sup.flush()  sup.state()
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
 *  - Limite connue : le PSIM ne garde qu'un seul etat par detecteur. Un `door_closed` (retour a la normale) recu pendant un
 *    sabotage ou une derive d'horloge encore actifs les efface cote PSIM ; la derive est re-emise toutes les 300 s, pas le sabotage.
 *  - Journaux : jamais de badge, de nom ni de mot de passe ; textes du reseau nettoyes et bornes ; un meme message au plus une
 *    fois par minute (et 30 lignes par minute en tout).
 *  - Aucune exception ne sort des methodes d'emission ; les erreurs de configuration (identifiant de controleur ou de detecteur
 *    invalide, aucune porte) levent `RangeError` au constructeur.
 */
export { emitted } from './types.ts';
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
export { CURSOR_FILE, CursorStore, defaultCursorCompare } from './cursor.ts';
export type { CursorCompare, CursorEntry, CursorIo, CursorStoreOptions } from './cursor.ts';
export { createLimitedLog } from './limitedlog.ts';
export type { LimitedLog } from './limitedlog.ts';
export { ControllerSupervisor, DEFAULT_THRESHOLDS } from './supervisor.ts';
export type { DoorSnapshot, LinkState, PartialThresholds, SupervisorOptions, SupervisorState, Thresholds } from './supervisor.ts';
