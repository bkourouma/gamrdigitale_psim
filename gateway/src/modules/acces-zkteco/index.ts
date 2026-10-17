/**
 * Module `acces-zkteco` de la Passerelle GAMR : controle d'acces ZKTeco (centrales C3 / inBio, terminaux de pointage) par le
 * protocole « PUSH » du constructeur. La passerelle joue le role du SERVEUR : les appareils l'appellent en HTTP, lui envoient
 * leurs evenements en temps reel (`rtlog`, `rtstate`, `ATTLOG`) et viennent chercher ses ordres (ouverture a distance).
 *
 * ======================================================================================================================
 * FAIBLESSE DE SECURITE A CONNAITRE (a lire avant toute mise en service)
 * ======================================================================================================================
 * Le protocole PUSH est EN CLAIR (HTTP, pas de TLS) et SANS AUTHENTIFICATION : seul le numero de serie (`SN`) de l'appareil
 * l'identifie, et ce numero est imprime sur l'etiquette, affiche par l'appareil et facile a deviner. Un voisin du reseau
 * (poste infecte, prestataire branche au mauvais endroit) peut donc :
 *   - injecter de FAUX PASSAGES (journal des acces falsifie) ou de FAUSSES ALARMES (porte forcee, sabotage) ;
 *   - ecouter le trafic (numeros de badge, heures de passage) ;
 *   - falsifier l'ACCUSE d'une commande (faire croire a l'operateur qu'une porte s'est ouverte ou refermee), ou, en repondant
 *     a la place du module, envoyer un faux ordre a l'appareil s'il se place entre lui et la passerelle.
 * Le module ne peut pas supprimer cette faiblesse (elle est dans le protocole du constructeur) ; il la reduit par :
 *   1. un RESEAU DEDIE (VLAN) controleurs <-> passerelle, sans autre poste ;
 *   2. un PARE-FEU qui n'ouvre le port du module que depuis les adresses des appareils ;
 *   3. `allowFrom` : liste d'adresses IPv4 / plages autorisees, controlee des l'ouverture de la connexion (hors liste = fermee) ;
 *   4. une liste blanche de numeros de serie : tout numero inconnu recoit une reponse neutre identique a toute autre erreur ;
 *   5. l'ecoute sur UNE interface choisie (jamais « toutes les interfaces » sans `allowAnyInterface`), des delais courts, des
 *      connexions, corps et debits bornes, des journaux limites et sans numero de badge ni nom ;
 *   6. AUCUNE exposition a Internet ; aucune ouverture a distance sans le canal de commande signe du PSIM (le module n'ouvre
 *      jamais une porte de lui-meme) ;
 *   7. a l'echelle suivante, un VPN ou un reverse proxy TLS devant le port (le protocole n'accepte pas TLS nativement
 *      sur tous les modeles).
 * Les decisions d'ouverture par badge restent DANS l'appareil : ce module ne fait que lire et rapporter.
 *
 * Fonctionnement :
 *   - poignee de main (`GET /iclock/cdata`) : le module repond la configuration (envoi en temps reel, delai d'interrogation
 *     court, seul le journal des passages demande : jamais utilisateurs, empreintes ni visages) et la derniere estampille acquittee ;
 *   - donnees (`POST /iclock/cdata?table=...`) : `OK` SEULEMENT quand toutes les lignes exploitables sont en file de la
 *     passerelle (F8) ; sinon 503, l'appareil conserve ses enregistrements et les renvoie ; lignes illisibles ignorees ;
 *   - ordres (`GET /iclock/getrequest`, `POST /iclock/devicecmd`) : voir commands.ts ;
 *   - supervision, doublons, refus repetes, derive d'horloge, hors ligne : superviseur commun (acces-commun) ;
 *   - contrainte (evenements 101 / 103) : nature commune `duress` du superviseur (alarme `panic`) ;
 *   - epoque (`epoch` du controleur) : identifiants d'evenement `<epoque>.<n°>` et curseur propre a l'epoque (controleur remplace) ;
 *   - mode de porte (F19) : deduit des seuls evenements du rtlog (ouverture continue, retour au mode normal), jamais d'un mode
 *     ancien ; `rtstate` ne le donne pas (A QUALIFIER, voir protocol.ts) ;
 *   - synchronisation des titulaires (par. 7) : sync.ts, par la file de commandes (centrales seulement ; un terminal repond
 *     « non pris en charge »).
 * Etat de recuperation (curseurs F8, fuseaux attribues, jours feries ecrits) : `stateDir` (defaut `<gateway>/data/acces`, relatif resolu depuis `gateway/`).
 * Voir protocol.ts pour ce qui est confirme par la documentation et ce qui reste `A QUALIFIER` sur un appareil reel.
 */
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GatewayModule, ModuleContext, ModuleFactory } from '../../module.ts';
import { makeActuatorHandler, registerActuator } from '../acces-commun/actuator.ts';
import {
  ControllerSupervisor,
  CursorStore,
  SlotMap,
  createLimitedLog,
  epochEventId,
  makeSyncHandler,
  registerAccessSync,
  type AccessSyncHandler,
  type Emitter,
  type PassageInput,
  type SupervisorState,
} from '../acces-commun/commun.ts';
import { DeviceCommands } from './commands.ts';
import { parseConfig } from './config.ts';
import type { ControllerConfig, ZktecoConfig } from './config.ts';
import { createZktecoDriver } from './driver.ts';
import {
  PATH_CDATA,
  PATH_DEVICECMD,
  PATH_GETREQUEST,
  PATH_PING,
  attlogDirection,
  attlogMethod,
  classifyEvent,
  handshakeBody,
  inoutDirection,
  minStamp,
  parseAttlogLine,
  parseDeviceCmdBody,
  parseRtlogLine,
  parseRtstateLine,
  rtlogEventId,
  splitLines,
  stampOf,
  syntheticEventId,
  verifyMethod,
} from './protocol.ts';
import type { RtlogRecord } from './protocol.ts';
import { NEUTRAL, createFront } from './server.ts';
import type { Front, FrontReply, FrontRequest } from './server.ts';
import { HolidayStore, createZktecoSyncDriver } from './sync.ts';

export { parseConfig } from './config.ts';

/** Dossier de la passerelle (`gateway/`) : les chemins relatifs de `stateDir` se resolvent a partir d'ici (comme acces-dahua). */
const GATEWAY_DIR = fileURLToPath(new URL('../../../', import.meta.url));
/** Dossier d'etat par defaut (curseurs de recuperation), commun aux modules d'acces : `<gateway>/data/acces`. */
export const DEFAULT_STATE_DIR = resolve(GATEWAY_DIR, 'data', 'acces');

/** Dossier d'etat effectif : defaut, chemin absolu tel quel, chemin relatif resolu depuis `gateway/`. Pure : ne touche pas au disque. */
export function resolveStateDir(stateDir: string | null, gatewayDir: string = GATEWAY_DIR): string {
  if (stateDir === null) return gatewayDir === GATEWAY_DIR ? DEFAULT_STATE_DIR : resolve(gatewayDir, 'data', 'acces');
  return isAbsolute(stateDir) ? stateDir : resolve(gatewayDir, stateDir);
}

export interface ZktecoModule extends GatewayModule {
  /** Port effectivement ouvert (utile quand le port configure est 0, en test). */
  addresses(): { http: number | null };
  /** Un tour de supervision (superviseurs, delais des commandes, curseurs) : fait toutes les secondes, appelable en essai. */
  tick(): void;
  /** Etat de chaque appareil (essais, diagnostic). Jamais de badge ni de nom. */
  state(): { controllers: Record<string, SupervisorState & { commandsPending: number }> };
}

const OK: FrontReply = { status: 200, body: 'OK' };
const REFUSED: FrontReply = { status: 503, body: 'Service Unavailable' };
const TICK_MS = 1000;
/** Memoire des identifiants d'evenements d'etat deja mis en file, par appareil. */
const SENT_RING = 4096;
/** Au-dela de cet avance (ms), un enregistrement date du futur est la preuve certaine d'une horloge en avance. */
const FUTURE_SLACK_MS = 5000;

interface Device {
  cfg: ControllerConfig;
  sup: ControllerSupervisor;
  cmds: DeviceCommands;
  /** Numeros d'evenement inconnus ou sans effet deja journalises. */
  noted: Set<number>;
  /** Evenements d'etat deja mis en file (cle `nature:identifiant`) : un renvoi de l'appareil ne les emet pas deux fois. */
  sent: Map<string, true>;
  firstContact: boolean;
}

export function create(config: Record<string, unknown>): ZktecoModule {
  const cfg: ZktecoConfig = parseConfig(config);

  let ctx: ModuleContext | null = null;
  let front: Front | null = null;
  let timer: NodeJS.Timeout | null = null;
  let cursors: CursorStore | null = null;
  /** Fuseaux horaires attribues aux horaires du PSIM, et jours feries ecrits (synchronisation des titulaires). */
  let slots: SlotMap | null = null;
  let holidays: HolidayStore | null = null;
  let started = false;
  let commandSeq = 0;
  const devices = new Map<string, Device>();
  const bySerial = new Map<string, Device>();
  let limited: (key: string, level: 'info' | 'warn' | 'error', text: string) => void = () => undefined;

  const now = () => (ctx ? ctx.now() : Date.now());

  function log(level: 'info' | 'warn' | 'error', text: string): void {
    try {
      ctx?.log(level, text);
    } catch {
      // un journal defaillant ne doit pas arreter la reception
    }
  }

  /** Envoi au socle : `false` si le message n'est PAS en file (le module renvoie alors une erreur a l'appareil). */
  const emit: Emitter = (deviceId, msg) => {
    if (!ctx) return false;
    return (ctx.emit(deviceId, msg) as unknown as boolean | void) !== false;
  };

  // --- Enregistrements ----------------------------------------------------------------------------------------------

  const deferredOf = (ts: number): boolean => now() - ts > cfg.thresholds.deferredAfterS * 1000;

  /** Retient un evenement d'etat mis en file. */
  function remember(dev: Device, key: string): void {
    dev.sent.set(key, true);
    if (dev.sent.size > SENT_RING) {
      const oldest = dev.sent.keys().next();
      if (!oldest.done) dev.sent.delete(oldest.value);
    }
  }

  /** Porte du PSIM visee par un enregistrement, ou `null` (porte non declaree : l'enregistrement n'a pas de destination). */
  function doorOf(dev: Device, rec: RtlogRecord): number | null {
    if (dev.cfg.kind === 'terminal') return 1;
    return rec.door !== null && dev.cfg.doors.has(rec.door) ? rec.door : null;
  }

  function note(dev: Device, event: number, text: string): void {
    if (dev.noted.has(event) || dev.noted.size > 200) return;
    dev.noted.add(event);
    log('info', `controleur ${dev.cfg.id} : ${text} (journalise une seule fois)`);
  }

  /** Vrai si l'enregistrement est en file (ou n'avait rien a envoyer). */
  function applyRtlog(dev: Device, rec: RtlogRecord): boolean {
    const ev = classifyEvent(rec.event);
    // Epoque > 0 (controleur remplace) : "<epoque>.<n° d'enregistrement>" ; epoque 0 : identifiant inchange.
    const eventId = epochEventId(dev.cfg.epoch, rtlogEventId(rec));
    const door = doorOf(dev, rec);
    const effect = ev.effect;
    if (!ev.known) note(dev, rec.event, `evenement ${rec.event} inconnu du module (traite comme ${effect.kind === 'denied' ? 'un refus de motif other' : 'sans effet'}, a qualifier)`);
    switch (effect.kind) {
      case 'ignore':
        if (ev.known) note(dev, rec.event, `evenement ${rec.event} (${ev.label}) sans effet pour le PSIM`);
        return true;
      case 'granted':
      case 'denied': {
        if (door === null) {
          limited(`nodoor:${dev.cfg.id}`, 'warn', `controleur ${dev.cfg.id} : passage pour une porte non declaree, ignore`);
          return true;
        }
        const method = effect.kind === 'granted' && effect.method ? effect.method : verifyMethod(rec.verify, rec.card !== null);
        return submitPassage(dev, {
          doorNo: door,
          ts: rec.ts,
          eventId,
          direction: inoutDirection(rec.inout),
          credential: method === 'exit_button' || method === 'remote' ? null : rec.card,
          holderName: null,
          holderRef: method === 'exit_button' || method === 'remote' ? null : rec.pin,
          method,
          result: effect.kind,
          reason: effect.kind === 'denied' ? effect.reason : null,
          deferred: deferredOf(rec.ts),
        });
      }
      case 'door': {
        if (door === null) {
          limited(`nodoor:${dev.cfg.id}`, 'warn', `controleur ${dev.cfg.id} : evenement pour une porte non declaree, ignore`);
          return true;
        }
        const key = `${effect.what}:${eventId}`;
        if (dev.sent.has(key)) return true;
        if (!dev.sup.doorEvent(door, effect.what, rec.ts, eventId)) return false;
        remember(dev, key);
        return true;
      }
      case 'tamper': {
        const key = `tamper:${eventId}`;
        if (dev.sent.has(key)) return true;
        const ok = door !== null ? dev.sup.doorEvent(door, 'tamper', rec.ts, eventId) : dev.sup.controllerEvent('tamper', rec.ts, eventId);
        if (!ok) return false;
        remember(dev, key);
        return true;
      }
      case 'duress': {
        if (door === null) {
          limited(`nodoor:${dev.cfg.id}`, 'warn', `controleur ${dev.cfg.id} : alarme de contrainte pour une porte non declaree, ignoree`);
          return true;
        }
        // Le passage est accepte (la porte s'est ouverte) ET une alarme silencieuse part : jamais l'un sans l'autre.
        const passage = submitPassage(dev, {
          doorNo: door,
          ts: rec.ts,
          eventId,
          direction: inoutDirection(rec.inout),
          credential: rec.card,
          holderName: null,
          holderRef: rec.pin,
          method: effect.method,
          result: 'granted',
          reason: null,
          deferred: deferredOf(rec.ts),
        });
        if (!passage) return false;
        const key = `duress:${eventId}`;
        if (dev.sent.has(key)) return true;
        // Nature commune « contrainte » du superviseur : alarme `panic`, sans fin, sans effet sur l'etat memorise de la porte.
        if (!dev.sup.doorEvent(door, 'duress', rec.ts, eventId)) return false;
        remember(dev, key);
        return true;
      }
      case 'mode': {
        // Un enregistrement ancien (recupere apres une coupure) est de l'HISTOIRE : le mode COURANT de la porte n'en decoule pas.
        // Le superviseur ne doit recevoir que le mode actuel ; il retente seul si le socle refuse, donc l'appareil n'a rien a renvoyer.
        if (door !== null && !deferredOf(rec.ts)) dev.sup.doorMode(door, effect.mode);
        return true;
      }
    }
  }

  function submitPassage(dev: Device, p: PassageInput): boolean {
    const outcome = dev.sup.submit(p);
    return outcome !== 'refused';
  }

  /** Preuve d'horloge en avance : un enregistrement date du futur ne peut pas etre un enregistrement stocke. */
  function futureEvidence(dev: Device, ts: number): void {
    if (ts - now() > cfg.thresholds.clockDriftMs + FUTURE_SLACK_MS) dev.sup.deviceTime(ts);
  }

  /** Un enregistrement isole et tout proche de l'heure locale ne peut que RAMENER une derive a la normale. */
  function nearEvidence(dev: Device, ts: number, single: boolean): void {
    if (single && dev.sup.state().drifting && Math.abs(ts - now()) <= cfg.thresholds.clockDriftMs / 2) dev.sup.deviceTime(ts);
  }

  interface BatchResult {
    ok: boolean;
    bad: number;
    lastTs: number | null;
    lastIndex: string | null;
    lines: number;
  }

  function processRtlog(dev: Device, body: string): BatchResult {
    const lines = splitLines(body);
    const r: BatchResult = { ok: true, bad: 0, lastTs: null, lastIndex: null, lines: lines.length };
    for (const line of lines) {
      const rec = parseRtlogLine(line, dev.cfg.utcOffsetMin);
      if (!rec) {
        r.bad++;
        continue;
      }
      futureEvidence(dev, rec.ts);
      nearEvidence(dev, rec.ts, lines.length === 1);
      if (!applyRtlog(dev, rec)) {
        r.ok = false;
        break;
      }
      r.lastTs = rec.ts;
      r.lastIndex = rec.index;
    }
    return r;
  }

  function processAttlog(dev: Device, body: string): BatchResult {
    const lines = splitLines(body);
    const r: BatchResult = { ok: true, bad: 0, lastTs: null, lastIndex: null, lines: lines.length };
    for (const line of lines) {
      const rec = parseAttlogLine(line, dev.cfg.utcOffsetMin);
      if (!rec) {
        r.bad++;
        continue;
      }
      futureEvidence(dev, rec.ts);
      nearEvidence(dev, rec.ts, lines.length === 1);
      // Un terminal d'horodatage ne trace que des succes.
      const ok = submitPassage(dev, {
        doorNo: 1,
        ts: rec.ts,
        eventId: epochEventId(dev.cfg.epoch, syntheticEventId(rec.ts, rec.pin, rec.status, rec.verify)),
        direction: attlogDirection(rec.status),
        credential: null,
        holderName: null,
        holderRef: rec.pin,
        method: attlogMethod(rec.verify),
        result: 'granted',
        reason: null,
        deferred: deferredOf(rec.ts),
      });
      if (!ok) {
        r.ok = false;
        break;
      }
      r.lastTs = rec.ts;
    }
    return r;
  }

  function processRtstate(dev: Device, body: string): BatchResult {
    const lines = splitLines(body);
    const r: BatchResult = { ok: true, bad: 0, lastTs: null, lastIndex: null, lines: lines.length };
    for (const line of lines) {
      const rec = parseRtstateLine(line, dev.cfg.utcOffsetMin);
      if (!rec) {
        r.bad++;
        continue;
      }
      // L'heure d'un etat est l'heure ACTUELLE de l'appareil : seule mesure fiable de la derive d'horloge.
      if (rec.ts !== null) dev.sup.deviceTime(rec.ts, now());
      const at = rec.ts ?? now();
      const known = new Map(dev.sup.state().doors.map((d) => [d.doorNo, d.open] as const));
      for (const [doorNo, isOpen] of rec.open) {
        if (!dev.cfg.doors.has(doorNo)) continue;
        if (known.get(doorNo) === isOpen) continue;
        if (!dev.sup.doorEvent(doorNo, isOpen ? 'opened' : 'closed', at)) {
          r.ok = false;
          return r;
        }
      }
    }
    return r;
  }

  // --- Synchronisation des titulaires (docs/CONTROLE-ACCES.md, par. 7) -------------------------------------------------

  /** Reponse d'un appareil qui ne sait pas recevoir de titulaires (terminal de pointage). */
  const NOT_SUPPORTED: AccessSyncHandler = () => Promise.resolve({ result: 'refused', code: 'not_supported' });

  /**
   * Declare le gestionnaire de synchronisation de l'appareil aupres du socle. Une centrale (`controller`) recoit les titulaires par
   * `DATA UPDATE` (sync.ts) ; un terminal repond toujours « non pris en charge ». Un socle sans `onAccessSync` (ou qui refuse
   * l'enregistrement) ne coupe jamais la remontee des passages : le module journalise et continue.
   */
  function registerSync(c: ModuleContext, cc: ControllerConfig, cmds: DeviceCommands): void {
    let handler: AccessSyncHandler = NOT_SUPPORTED;
    if (cc.kind === 'controller' && slots && holidays) {
      const driver = createZktecoSyncDriver({
        controllerId: cc.id,
        commands: cmds,
        utcOffsetMin: cc.utcOffsetMin,
        now: c.now,
        timezones: cfg.timezones,
        userExtras: cfg.sync.userExtras,
        fullCodes: cfg.sync.fullCodes,
        holidays,
      });
      handler = makeSyncHandler(cc.id, driver, { slots, now: c.now, log: (level, text) => log(level, text) });
    }
    try {
      if (!registerAccessSync(c, cc.id, handler)) {
        log('info', `controleur ${cc.id} : cette passerelle n'a pas de canal de synchronisation des titulaires (surveillance des portes seule)`);
      }
    } catch (err) {
      log('warn', `controleur ${cc.id} : synchronisation des titulaires non enregistree, surveillance des portes seule (${(err instanceof Error ? err.message : 'erreur').slice(0, 200)})`);
    }
  }

  // --- Requetes -----------------------------------------------------------------------------------------------------

  function badLines(dev: Device, r: BatchResult): void {
    if (r.bad > 0) limited(`bad:${dev.cfg.id}`, 'warn', `controleur ${dev.cfg.id} : ${r.bad} ligne(s) illisible(s) ignoree(s) sur ${r.lines}`);
  }

  function onData(dev: Device, req: FrontRequest): FrontReply {
    const table = (req.params.get('table') ?? '').toLowerCase();
    let r: BatchResult;
    if (table === 'rtlog' && dev.cfg.kind === 'controller') r = processRtlog(dev, req.body);
    else if (table === 'attlog' && dev.cfg.kind === 'terminal') r = processAttlog(dev, req.body);
    else if (table === 'rtstate') r = processRtstate(dev, req.body);
    else {
      // Autre table (utilisateurs, empreintes, journal des operations...) : jamais lue ni conservee, et acquittee pour que
      // l'appareil ne la renvoie pas indefiniment. Aucun texte du reseau n'est journalise.
      limited(`table:${dev.cfg.id}`, 'info', `controleur ${dev.cfg.id} : donnees d'une table non exploitee recues, ignorees`);
      return OK;
    }
    badLines(dev, r);
    if (!r.ok) {
      limited(`refused:${dev.cfg.id}`, 'warn', `controleur ${dev.cfg.id} : donnees non acquittees (la passerelle n'a pas pu les mettre en file) ; l'appareil les renverra`);
      return REFUSED;
    }
    // Curseur : seulement quand TOUT le lot est en file (jamais d'avance sur ce que l'appareil doit renvoyer).
    if (r.lastTs !== null && cursors) {
      const stamp = stampOf(req.params.get('stamp')) ?? r.lastIndex;
      // Cle propre a l'epoque : un controleur remplace repart de zero, jamais compare a l'estampille de l'ancien.
      if (stamp !== null) cursors.set(dev.sup.cursorKey, stamp, r.lastTs);
    }
    return table === 'attlog' ? { status: 200, body: `OK:${r.lines}` } : OK;
  }

  function onHandshake(dev: Device, req: FrontRequest): FrontReply {
    const saved = cursors?.get(dev.sup.cursorKey)?.cursor;
    const stamp = minStamp(stampOf(saved), stampOf(req.params.get('attlogstamp') ?? req.params.get('stamp')));
    return {
      status: 200,
      body: handshakeBody({ serial: dev.cfg.serial, stamp, delayS: cfg.push.delayS, errorDelayS: cfg.push.errorDelayS, transFlag: cfg.push.transFlag }),
    };
  }

  function onDeviceCmd(dev: Device, req: FrontRequest): FrontReply {
    for (const res of parseDeviceCmdBody(req.body)) {
      if (!dev.cmds.ack(res.id, res.code)) limited(`lateack:${dev.cfg.id}`, 'info', `controleur ${dev.cfg.id} : resultat de commande inconnu ou tardif, ignore`);
    }
    return OK;
  }

  function handle(req: FrontRequest): FrontReply {
    const dev = bySerial.get(req.serial);
    if (!dev || !started) return NEUTRAL;
    // Tout contact valide d'un appareil declare est une preuve de vie.
    dev.cmds.touch();
    dev.sup.alive();
    if (dev.firstContact) {
      dev.firstContact = false;
      log('info', `controleur ${dev.cfg.id} : premier contact`);
    }
    if (req.path === PATH_CDATA) return req.method === 'GET' ? onHandshake(dev, req) : onData(dev, req);
    if (req.path === PATH_GETREQUEST) {
      const next = dev.cmds.take();
      return next ? { status: 200, body: `${next.line}\n` } : OK;
    }
    if (req.path === PATH_DEVICECMD) return onDeviceCmd(dev, req);
    if (req.path === PATH_PING) return OK;
    return NEUTRAL;
  }

  function tick(): void {
    for (const dev of devices.values()) {
      try {
        dev.sup.tick();
        dev.cmds.sweep();
      } catch {
        limited(`tick:${dev.cfg.id}`, 'error', `controleur ${dev.cfg.id} : erreur interne pendant la supervision (le module continue)`);
      }
    }
    try {
      slots?.tick();
    } catch {
      limited('tick:slots', 'error', 'erreur interne en ecrivant les fuseaux horaires (le module continue)');
    }
  }

  const mod: ZktecoModule = {
    name: 'acces-zkteco',
    async start(c: ModuleContext): Promise<void> {
      if (started || ctx) throw new Error('module acces-zkteco deja demarre');
      ctx = c;
      limited = createLimitedLog((level, text) => log(level, text), now);
      commandSeq = Math.floor(now() / 1000);
      try {
        const dir = resolveStateDir(cfg.stateDir);
        cursors = new CursorStore({ dir, now: c.now, log: (level, text) => log(level, text) });
        // Une seule table de fuseaux pour le module (une attribution par controleur) ; inutile sans centrale.
        if (cfg.controllers.some((cc) => cc.kind === 'controller')) {
          slots = new SlotMap({ dir, now: c.now, log: (level, text) => log(level, text), min: cfg.timezones.min, max: cfg.timezones.max });
          holidays = new HolidayStore(dir, (level, text) => log(level, text));
        }
        for (const cc of cfg.controllers) {
          const sup = new ControllerSupervisor({
            controllerId: cc.id,
            doors: cc.doors,
            emit,
            now: c.now,
            log: (level, text) => log(level, text),
            cursors,
            epoch: cc.epoch,
            thresholds: {
              denied: { count: cfg.thresholds.deniedCount, windowS: cfg.thresholds.deniedWindowS },
              heartbeatS: cfg.thresholds.heartbeatS,
              driftMs: cfg.thresholds.clockDriftMs,
              silenceMs: cfg.thresholds.silenceMs,
              offlineGraceMs: cfg.thresholds.offlineGraceMs,
            },
          });
          const cmds = new DeviceCommands({
            now: c.now,
            timeoutMs: cfg.thresholds.commandTimeoutS * 1000,
            reachableMs: cfg.thresholds.silenceMs,
            nextId: () => ++commandSeq,
          });
          const dev: Device = { cfg: cc, sup, cmds, noted: new Set(), sent: new Map(), firstContact: true };
          devices.set(cc.id, dev);
          bySerial.set(cc.serial, dev);
          if (cc.actuators.length > 0) {
            const driver = createZktecoDriver(cmds, { format: cfg.push.controlFormat, pulseS: new Map(cc.actuators.map((a) => [a.doorNo, a.pulseS])) });
            for (const a of cc.actuators) {
              const handler = makeActuatorHandler({ kind: a.kind, doorNo: a.doorNo }, driver, { longUnlockS: cfg.thresholds.longUnlockS, log: (level, text) => log(level, text) });
              // Si l'actionneur n'est pas declare dans la section `actuators` de la passerelle, `registerActuator` journalise deja
              // la cause (ouverture a distance indisponible, surveillance seule) et le module continue : rien a ajouter ici.
              registerActuator(c, a.id, handler);
            }
          }
          registerSync(c, cc, cmds);
        }
        started = true;
        front = createFront({
          host: cfg.host,
          port: cfg.port,
          allowFrom: cfg.allowFrom,
          limits: cfg.limits,
          now: c.now,
          log: (key, level, text) => limited(key, level, text),
          knownSerial: (sn) => bySerial.has(sn),
          handler: handle,
        });
        await front.start();
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        await mod.stop();
        throw new Error(`module acces-zkteco : ${text}`);
      }
      timer = setInterval(tick, TICK_MS);
      timer.unref();
      const doors = cfg.controllers.reduce((n, cc) => n + cc.doors.size, 0);
      log('info', `serveur ZKTeco PUSH a l'ecoute sur ${cfg.host}:${front.port() ?? cfg.port}, ${cfg.controllers.length} appareil(s), ${doors} porte(s)${cfg.allowFrom ? `, ${cfg.allowFrom.length} adresse(s)/plage(s) autorisee(s)` : ', toutes adresses sources (allowFrom absent)'}`);
    },
    async stop(): Promise<void> {
      started = false;
      if (timer) clearInterval(timer);
      timer = null;
      const f = front;
      front = null;
      if (f) await f.stop();
      for (const dev of devices.values()) {
        dev.cmds.failAll('stopped', 'module arrete');
        try {
          dev.sup.flush();
        } catch {
          // ecriture des curseurs au mieux
        }
      }
      try {
        cursors?.flush();
        slots?.flush();
        holidays?.flush();
      } catch {
        // idem
      }
      devices.clear();
      bySerial.clear();
      cursors = null;
      slots = null;
      holidays = null;
      ctx = null;
    },
    addresses() {
      return { http: front ? front.port() : null };
    },
    tick,
    state() {
      const out: Record<string, SupervisorState & { commandsPending: number }> = {};
      for (const [id, dev] of devices) out[id] = { ...dev.sup.state(), commandsPending: dev.cmds.pending };
      return { controllers: out };
    },
  };
  return mod;
}

create satisfies ModuleFactory;
