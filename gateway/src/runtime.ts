/**
 * Socle de la Passerelle GAMR : charge les modules, leur donne un contexte (module.ts), met chaque message en file disque
 * et le fait suivre au PSIM.
 *
 *  - Un module qui echoue au demarrage est journalise, arrete, puis relance avec une pause croissante (moduleRetry) ;
 *    les autres modules continuent.
 *  - `emit` ne leve jamais : message invalide = rejete et journalise ; message valide = sur le disque avant de rendre la main.
 *  - Un verrou (gateway.lock) empeche deux passerelles d'utiliser la meme file.
 *  - Actionneurs (section `actuators`) : le pilote de commandes (actuators.ts) recoit les ordres signes du PSIM par la liaison
 *    PSIM et les remet au gestionnaire que le module a enregistre par `ctx.onActuator`. A l'arret, le pilote ramene au repos,
 *    une fois et au mieux, les actionneurs dont un retour automatique est programme, AVANT d'arreter les modules.
 *  - Un fichier d'etat (status.json) est reecrit toutes les 10 s : le superviseur s'en sert pour detecter un blocage.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createActuatorPilot } from './actuators.ts';
import type { ActuatorPilot, ActuatorStats, Scheduler } from './actuators.ts';
import { MODULES_DIR, moduleEntry, redactUrl } from './config.ts';
import type { GatewayConfig, ModuleSpec } from './config.ts';
import { clean } from './log.ts';
import type { Level, Logger } from './log.ts';
import type { ActuatorHandler, DeviceMessage, GatewayModule, ModuleContext, ModuleFactory, MqttLink } from './module.ts';
import { openMqtt } from './mqttlink.ts';
import { createPsimLink } from './psimlink.ts';
import type { PsimLink } from './psimlink.ts';
import { DiskQueue } from './queue.ts';
import type { QueueStats } from './queue.ts';
import { allows, newMsgId, prepare } from './validate.ts';

export interface RuntimeOptions {
  config: GatewayConfig;
  logger: Logger;
  /** Dossier des modules (essais : modules factices). Jamais lu depuis la configuration. */
  modulesDir?: string;
  now?: () => number;
  statusEveryMs?: number;
  /** Delai laisse a un module pour demarrer (60 s) ou s'arreter (10 s). */
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Essais : delais de la liaison PSIM. */
  publishTimeoutMs?: number;
  rejectAfter?: number;
  /** Essais : delais et planificateur du pilote de commandes. */
  actuators?: { handlerTimeoutMs?: number; restRetryMs?: number; restRetries?: number; schedule?: Scheduler };
}

export type ModuleState = 'starting' | 'running' | 'retrying' | 'stopping' | 'stopped';

export interface ModuleStatus {
  label: string;
  name: string;
  state: ModuleState;
  /** Demarrages echoues depuis le lancement de la passerelle. */
  failures: number;
  lastError: string | null;
}

export interface GatewayStatus {
  pid: number;
  at: number;
  name: string;
  psim: { url: string; connected: boolean };
  queue: QueueStats;
  modules: ModuleStatus[];
  /** Pilote de commandes : absent si aucun actionneur n'est configure. */
  actuators?: ActuatorStats & { pendingRests: number };
}

export interface GatewayRuntime {
  /** Meme comportement que `ctx.emit` (outils et essais). */
  /** Vrai si le message est en file (donc sera livre) ; faux s'il est refuse ou perdu (la raison est journalisee). */
  emit(deviceId: string, msg: DeviceMessage): boolean;
  status(): GatewayStatus;
  queue: DiskQueue;
  /** Pilote de commandes d'actionneurs ; null si la section `actuators` est vide. */
  actuators: ActuatorPilot | null;
  stop(): Promise<void>;
}

export const STATUS_FILE = 'status.json';
export const LOCK_FILE = 'gateway.lock';
/** Memoire anti-rejeu des ordres d'actionneurs (dans le dossier de donnees). */
export const ACTUATORS_STATE_FILE = 'actuators-state.json';

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Verrou d'instance unique sur le dossier de donnees (meme principe que le PSIM : PID, ignore s'il date d'avant le demarrage de la machine). */
function acquireLock(dataDir: string): () => void {
  const file = join(dataDir, LOCK_FILE);
  if (existsSync(file)) {
    let holder: number | null = null;
    try {
      if (statSync(file).mtimeMs >= Date.now() - uptime() * 1000 - 5000) {
        const pid = Number(readFileSync(file, 'utf8').trim());
        if (pid !== process.pid && alive(pid)) holder = pid;
      }
    } catch {
      holder = null;
    }
    if (holder !== null) {
      throw new Error(`Une autre passerelle utilise deja ce dossier de donnees (${dataDir}, processus ${holder}) : deux passerelles melangeraient la file d'envoi. Si aucune ne tourne, supprimez ${file}.`);
    }
  }
  writeFileSync(file, String(process.pid));
  return () => {
    try {
      if (readFileSync(file, 'utf8').trim() === String(process.pid)) unlinkSync(file);
    } catch {
      // deja supprime
    }
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} : pas de reponse en ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]);
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function startRuntime(opts: RuntimeOptions): Promise<GatewayRuntime> {
  const { config, logger } = opts;
  const now = opts.now ?? Date.now;
  const modulesDir = opts.modulesDir ?? MODULES_DIR;
  const startTimeoutMs = opts.startTimeoutMs ?? 60_000;
  const stopTimeoutMs = opts.stopTimeoutMs ?? 10_000;

  mkdirSync(config.dataDir, { recursive: true });
  const releaseLock = acquireLock(config.dataDir);
  const queue = new DiskQueue(config.dataDir, { ...config.queue, log: logger });
  let link: PsimLink;
  let pilot: ActuatorPilot | null = null;
  try {
    queue.open();
    if (config.actuators.length > 0) {
      pilot = createActuatorPilot({
        actuators: config.actuators,
        log: logger,
        now,
        stateFile: join(config.dataDir, ACTUATORS_STATE_FILE),
        // `link` est affecte juste apres : aucun ordre n'arrive avant que la liaison soit demarree.
        // Un accuse plus tardif que le delai d'accuse du PSIM (5 s) n'a plus de valeur : 5 s au plus, jamais mis en file.
        publishAck: (actuatorId, payload) => link.publishNow(`psim/actuators/${actuatorId}/ack`, payload, 5000),
        ...opts.actuators,
      });
    }
    const pilotRef = pilot;
    link = createPsimLink({
      url: config.psim.url,
      username: config.psim.username,
      password: config.psim.password,
      ca: config.psim.ca,
      clientId: config.psim.clientId,
      queue,
      retry: config.retry,
      log: logger,
      publishTimeoutMs: opts.publishTimeoutMs,
      rejectAfter: opts.rejectAfter,
      ...(pilotRef ? { actuators: { ids: pilotRef.ids(), onCommand: (id: string, payload: Buffer) => void pilotRef.handleMessage(id, payload) } } : {}),
    });
  } catch (err) {
    void pilot?.stop();
    queue.close();
    releaseLock();
    throw err;
  }

  /** Arret demande : plus de nouvel essai de demarrage. */
  let stopped = false;
  /** File fermee : plus aucun message accepte (les modules ont pu emettre un dernier etat pendant leur arret). */
  let closed = false;
  const warnedOnce = new Set<string>();
  const warnOnce = (key: string, text: string) => {
    if (warnedOnce.has(key) || warnedOnce.size > 1000) return;
    warnedOnce.add(key);
    logger.log('warn', text);
  };

  /**
   * Met le message en file. Ne leve jamais. Renvoie vrai s'il est ecrit dans la file, faux sinon : le contrat des modules
   * (module.ts) type `emit` en `void`, mais un module qui peut faire renvoyer sa source (recepteur SIA : pas d'acquittement)
   * lit ce booleen pour ne jamais acquitter un message perdu.
   */
  function emitFrom(label: string, deviceId: string, msg: DeviceMessage): boolean {
    try {
      const shownId = clean(deviceId, 40);
      if (closed) {
        logger.log('warn', `[${label}] message pour ${shownId} ignore : passerelle arretee`);
        return false;
      }
      const r = prepare(deviceId, msg, now(), newMsgId);
      if (!r.ok) {
        logger.log('error', `[${label}] message rejete pour ${shownId} : ${r.error}`);
        return false;
      }
      if (config.psim.detectors && !allows(config.psim.detectors, deviceId)) {
        logger.log('error', `[${label}] message rejete pour ${shownId} : equipement hors de psim.detectors (le PSIM le refuserait pour ce compte)`);
        return false;
      }
      for (const w of r.warnings) warnOnce(`${label}|${w}`, `[${label}] ${w}`);
      queue.push(deviceId, r.payload);
      link.kick();
      return true;
    } catch (err) {
      // Disque plein ou illisible : rien ne doit remonter dans le module, mais la perte est signalee.
      logger.log('error', `[${label}] message pour ${clean(deviceId, 40)} PERDU : ecriture de la file impossible (${errText(err)})`);
      return false;
    }
  }

  // --- Modules ----------------------------------------------------------------------------------------------------
  interface Slot {
    spec: ModuleSpec;
    status: ModuleStatus;
    instance: GatewayModule | null;
    links: Set<MqttLink>;
    /** Retraits des gestionnaires d'actionneurs enregistres par l'instance vivante. */
    actuatorOffs: Map<string, () => void>;
    ctxAlive: { value: boolean };
    timer: NodeJS.Timeout | null;
    delay: number;
    attempt: Promise<void> | null;
  }

  const slots: Slot[] = config.modules.map((spec) => ({
    spec,
    status: { label: spec.label, name: spec.name, state: 'starting', failures: 0, lastError: null },
    instance: null,
    links: new Set(),
    actuatorOffs: new Map(),
    ctxAlive: { value: false },
    timer: null,
    delay: config.moduleRetry.minMs,
    attempt: null,
  }));

  /** Actionneur -> instance de module qui le pilote (une seule instance vivante a la fois). */
  const actuatorOwner = new Map<string, Slot>();

  async function loadFactory(name: string): Promise<ModuleFactory> {
    const file = moduleEntry(name, modulesDir);
    if (!file) throw new Error(`module « ${name} » introuvable`);
    const mod = (await import(pathToFileURL(file).href)) as { create?: unknown };
    if (typeof mod.create !== 'function') throw new Error(`le module « ${name} » n'exporte pas de fonction create`);
    return mod.create as ModuleFactory;
  }

  function makeContext(slot: Slot, alive: { value: boolean }): ModuleContext {
    const label = slot.spec.label;
    return {
      emit: (deviceId, msg) => {
        if (!alive.value) {
          warnOnce(`${label}|dead`, `[${label}] message emis par une instance arretee du module : ignore`);
          return false;
        }
        return emitFrom(label, deviceId, msg);
      },
      openMqtt: async (url, o) => {
        if (!alive.value) throw new Error('module arrete');
        const l = await openMqtt(url, { username: o?.username, password: o?.password, log: logger, label });
        if (!alive.value) {
          await l.close();
          throw new Error('module arrete');
        }
        slot.links.add(l);
        return {
          subscribe: (topic, onMessage) => l.subscribe(topic, onMessage),
          close: async () => {
            slot.links.delete(l);
            await l.close();
          },
        };
      },
      log: (level, text) => logger.log((['info', 'warn', 'error'].includes(level) ? level : 'info') as Level, `[${label}] ${clean(text)}`),
      onActuator: (actuatorId: string, handler: ActuatorHandler) => {
        // Toute erreur ici fait echouer le demarrage du module (comportement du socle : journal, arret, nouvel essai).
        if (!alive.value) throw new Error('module arrete');
        const shown = clean(actuatorId, 40);
        const spec = typeof actuatorId === 'string' ? config.actuators.find((a) => a.id === actuatorId) : undefined;
        if (!spec || !pilot) throw new Error(`actionneur « ${shown} » non declare dans la section « actuators » de la configuration de la passerelle`);
        if (spec.module !== label) throw new Error(`actionneur « ${shown} » declare pour le module « ${spec.module} » et non pour « ${label} » (section « actuators » de la configuration)`);
        if (typeof handler !== 'function') throw new Error(`onActuator(« ${shown} ») : un gestionnaire (fonction) est attendu`);
        const owner = actuatorOwner.get(spec.id);
        if (owner) throw new Error(`actionneur « ${shown} » deja enregistre par ${owner === slot ? 'ce module' : `le module « ${owner.spec.label} »`}`);
        slot.actuatorOffs.set(spec.id, pilot.register(spec.id, handler));
        actuatorOwner.set(spec.id, slot);
      },
      config: structuredClone(slot.spec.config),
      now,
    };
  }

  async function shutdownInstance(slot: Slot): Promise<void> {
    const inst = slot.instance;
    slot.instance = null;
    if (inst) {
      try {
        await withTimeout(Promise.resolve().then(() => inst.stop()), stopTimeoutMs, `arret de ${slot.spec.label}`);
      } catch (err) {
        logger.log('warn', `[${slot.spec.label}] arret incomplet : ${errText(err)}`);
      }
    }
    // Le contexte reste valable pendant stop() (un module peut emettre un dernier etat), plus apres.
    slot.ctxAlive.value = false;
    // Les gestionnaires de cette instance sont retires : un ordre recu pendant un redemarrage est refuse « unavailable ».
    for (const [id, off] of slot.actuatorOffs) {
      off();
      actuatorOwner.delete(id);
    }
    slot.actuatorOffs.clear();
    const links = [...slot.links];
    slot.links.clear();
    await Promise.all(links.map((l) => l.close().catch(() => undefined)));
  }

  async function attempt(slot: Slot): Promise<void> {
    slot.timer = null;
    if (stopped) return;
    slot.status.state = 'starting';
    const alive = { value: true };
    slot.ctxAlive = alive;
    try {
      const factory = await loadFactory(slot.spec.name);
      const inst = factory(structuredClone(slot.spec.config));
      if (!inst || typeof inst.start !== 'function' || typeof inst.stop !== 'function') throw new Error('create() doit renvoyer { name, start, stop }');
      slot.instance = inst;
      await withTimeout(Promise.resolve().then(() => inst.start(makeContext(slot, alive))), startTimeoutMs, `demarrage de ${slot.spec.label}`);
      if (stopped) return;
      slot.status.state = 'running';
      slot.status.lastError = null;
      slot.delay = config.moduleRetry.minMs;
      logger.log('info', `[${slot.spec.label}] module demarre`);
    } catch (err) {
      slot.status.failures++;
      slot.status.lastError = clean(errText(err), 300);
      await shutdownInstance(slot);
      if (stopped) return;
      const wait = slot.delay;
      slot.delay = Math.min(slot.delay * 2, config.moduleRetry.maxMs);
      slot.status.state = 'retrying';
      logger.log('error', `[${slot.spec.label}] echec du demarrage (${slot.status.lastError}) ; nouvel essai dans ${Math.round(wait / 100) / 10} s`);
      slot.timer = setTimeout(() => {
        slot.attempt = attempt(slot);
      }, wait);
    }
  }

  function status(): GatewayStatus {
    return {
      pid: process.pid,
      at: Date.now(),
      name: config.name,
      psim: { url: redactUrl(config.psim.url), connected: link.connected() },
      queue: queue.stats(),
      modules: slots.map((s) => ({ ...s.status })),
      ...(pilot ? { actuators: { ...pilot.stats(), pendingRests: pilot.pendingRests().length } } : {}),
    };
  }

  const statusFile = join(config.dataDir, STATUS_FILE);
  function writeStatus(): void {
    try {
      const tmp = `${statusFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(status(), null, 2));
      renameSync(tmp, statusFile);
    } catch {
      // fichier d'etat : best-effort
    }
  }

  logger.log('info', `passerelle « ${config.name} » : PSIM ${redactUrl(config.psim.url)} (compte ${config.psim.username}), donnees ${config.dataDir}, ${slots.length} module(s)`);
  link.start();
  for (const slot of slots) slot.attempt = attempt(slot);
  if (slots.length === 0) logger.log('warn', 'aucun module actif dans la configuration');
  writeStatus();
  const statusTimer = setInterval(writeStatus, opts.statusEveryMs ?? 10_000);

  let stopping: Promise<void> | null = null;
  return {
    emit: (deviceId, msg) => emitFrom('passerelle', deviceId, msg),
    status,
    queue,
    actuators: pilot,
    stop() {
      stopping ??= (async () => {
        logger.log('info', 'arret de la passerelle...');
        clearInterval(statusTimer);
        stopped = true;
        for (const slot of slots) if (slot.timer) clearTimeout(slot.timer);
        // Laisse finir un demarrage en cours (borne par startTimeoutMs), puis arrete chaque module.
        await Promise.all(slots.map((s) => s.attempt?.catch(() => undefined)));
        // Les actionneurs d'abord : leur gestionnaire (dans le module) doit etre encore la pour ramener au repos.
        if (pilot) {
          try {
            await pilot.stop();
          } catch (err) {
            logger.log('error', `arret du pilote de commandes : ${errText(err)}`);
          }
        }
        await Promise.all(
          slots.map(async (slot) => {
            slot.status.state = 'stopping';
            await shutdownInstance(slot);
            slot.status.state = 'stopped';
          }),
        );
        closed = true;
        await link.stop(3000);
        writeStatus();
        queue.close();
        rmSync(`${statusFile}.tmp`, { force: true });
        releaseLock();
        logger.log('info', `passerelle arretee (${queue.stats().pending} message(s) gardes sur disque pour le prochain demarrage)`);
      })();
      return stopping;
    },
  };
}
