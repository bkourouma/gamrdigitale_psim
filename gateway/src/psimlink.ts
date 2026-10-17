/**
 * Liaison vers le broker MQTT du PSIM : vide la file disque DANS L'ORDRE, un message a la fois, en QoS 1 (le message n'est
 * retire de la file qu'apres l'accuse de reception du broker). Broker injoignable : nouvel essai avec une pause qui double
 * (minMs, 2 x minMs... maxMs au plus), remise au minimum des qu'un message passe.
 *
 * Message refuse par le PSIM (detecteur hors du perimetre du compte de passerelle : le broker coupe la connexion au lieu
 * d'accuser reception) : apres REJECT_AFTER coupures de suite sur CE message, juste apres son envoi, il est mis de cote
 * (rejected.jsonl) pour ne pas bloquer toute la file derriere lui. Une simple panne reseau ne produit pas ce schema.
 *
 * Commandes d'actionneurs (docs/COMMANDES.md) : a CHAQUE connexion (la liaison est « clean: true »), un abonnement par actionneur
 * configure a `psim/actuators/<id>/command` (topic exact, QoS 0, jamais de joker) ; chaque ordre recu est remis au pilote avec
 * l'identifiant du TOPIC. Les accuses partent par `publishNow` : QoS 1, immediats, JAMAIS dans la file disque (un ordre ou un
 * accuse en retard n'a aucune valeur, et rejouer un accuse apres une coupure serait trompeur).
 *
 * Synchronisation des titulaires (docs/CONTROLE-ACCES.md, par. 7) : abonnement DYNAMIQUE, un par controleur enregistre par un
 * module (`watchSync` / `unwatchSync`), au topic EXACT `psim/access/<id>/sync` en QoS 1 (jamais de joker), applique tout de
 * suite si la liaison est etablie et de nouveau a chaque (re)connexion. Message « retain » ignore ; l'identifiant du controleur
 * est celui du TOPIC, jamais une valeur du message. Les accuses (`.../sync-ack`) partent par `publishNow`, comme ceux des commandes.
 */
import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { redactUrl } from './config.ts';
import type { Logger } from './log.ts';
import type { DiskQueue, QueueEntry } from './queue.ts';
import { topicFor } from './validate.ts';

export interface PsimLinkOptions {
  url: string;
  username: string;
  password: string;
  ca: Buffer | null;
  clientId: string;
  queue: DiskQueue;
  retry: { minMs: number; maxMs: number };
  log: Logger;
  /** Sans accuse de reception dans ce delai, la connexion est consideree comme morte (15 s). */
  publishTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Coupures de suite, juste apres l'envoi du meme message, avant de le mettre de cote (5). */
  rejectAfter?: number;
  /** Ordres d'actionneurs : identifiants dont on s'abonne aux ordres (a chaque connexion) et fonction qui les recoit. */
  actuators?: { ids: readonly string[]; onCommand: (actuatorId: string, payload: Buffer) => void };
  /** Synchronisation des titulaires : fonction qui recoit les ordres des controleurs suivis par `watchSync`. */
  accessSync?: { onSync: (controllerId: string, payload: Buffer) => void };
}

export interface PsimLink {
  start(): void;
  /** Nouveau message en file : l'envoyer des que possible. */
  kick(): void;
  connected(): boolean;
  /**
   * Publication IMMEDIATE (accuse de commande) : QoS 1, retain false, sans file disque. Vrai si le PSIM a accuse reception ;
   * faux si la liaison est coupee ou si l'accuse de reception n'est pas venu : le message est alors perdu, volontairement.
   */
  publishNow(topic: string, payload: string, timeoutMs?: number): Promise<boolean>;
  /**
   * Suit les ordres de synchronisation du controleur `controllerId` (`^[A-Za-z0-9_-]{1,32}$`, sinon leve) : abonnement QoS 1 a
   * `psim/access/<id>/sync`, tout de suite si la liaison est etablie, et a chaque (re)connexion. Sans effet si deja suivi.
   */
  watchSync(controllerId: string): void;
  /** Cesse de suivre ce controleur (desabonnement immediat si la liaison est etablie). Sans effet s'il n'etait pas suivi. */
  unwatchSync(controllerId: string): void;
  /** Controleurs suivis (essais, statut). */
  watchedSync(): string[];
  /** Arret : laisse au plus `flushMs` pour vider la file si le PSIM est joignable. */
  stop(flushMs?: number): Promise<void>;
}

/** Une coupure qui survient moins de QUICK_CLOSE_MS apres l'envoi est attribuee au message (refus du broker). */
const QUICK_CLOSE_MS = 3000;
const COMMAND_TOPIC = /^psim\/actuators\/([A-Za-z0-9_-]{1,32})\/command$/;
const SYNC_TOPIC = /^psim\/access\/([A-Za-z0-9_-]{1,32})\/sync$/;
const SYNC_ID = /^[A-Za-z0-9_-]{1,32}$/;
const syncTopic = (id: string) => `psim/access/${id}/sync`;

export function createPsimLink(opts: PsimLinkOptions): PsimLink {
  const log = opts.log;
  const publishTimeoutMs = opts.publishTimeoutMs ?? 15_000;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  const rejectAfter = opts.rejectAfter ?? 5;
  const where = redactUrl(opts.url);
  const commandIds = new Set(opts.actuators?.ids ?? []);
  /** Controleurs dont on suit les ordres de synchronisation. */
  const syncIds = new Set<string>();

  let client: MqttClient | null = null;
  let isConnected = false;
  let stopping = false;
  let pumping = false;
  let delay = opts.retry.minMs;
  let timer: NodeJS.Timeout | null = null;
  let failuresInRow = 0;
  let lastError = '';
  let lastFailureLog = 0;
  let wasConnected = false;
  /** Message en cours d'envoi et son heure d'envoi. */
  let inflight: { entry: QueueEntry; sentAt: number; fail: (closed: boolean) => void } | null = null;
  /** Refus probables du message en tete : seq -> nombre de coupures juste apres son envoi. */
  let suspect = { seq: 0, count: 0 };
  let drained: (() => void) | null = null;

  function schedule(): void {
    if (stopping || timer) return;
    const wait = delay;
    delay = Math.min(delay * 2, opts.retry.maxMs);
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, wait);
    timer.unref?.();
    const t = Date.now();
    // Premier echec, puis au plus une ligne par minute (un PSIM arrete une nuit ne doit pas remplir le journal).
    if (failuresInRow === 1 || t - lastFailureLog >= 60_000) {
      lastFailureLog = t;
      const pending = opts.queue.stats().pending;
      log.log('warn', `PSIM injoignable (${where}${lastError ? ` : ${lastError}` : ''}) ; nouvel essai dans ${Math.round(wait / 100) / 10} s ; ${pending} message(s) en attente sur disque`);
    }
  }

  function connect(): void {
    if (stopping) return;
    lastError = '';
    const c = mqtt.connect(opts.url, {
      username: opts.username,
      password: opts.password,
      clientId: opts.clientId,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 0, // reconnexion geree ici (pause croissante)
      connectTimeout: connectTimeoutMs,
      protocolVersion: 4,
      ...(opts.ca ? { ca: opts.ca } : {}),
    });
    client = c;
    c.on('connect', () => {
      if (client !== c) return;
      isConnected = true;
      wasConnected = true;
      failuresInRow = 0;
      log.log('info', `connecte au PSIM (${where}) ; ${opts.queue.stats().pending} message(s) a envoyer`);
      subscribeActuators(c);
      for (const id of syncIds) subscribeSync(c, id);
      void pump();
    });
    c.on('message', (topic, payload, packet) => {
      if (client !== c) return;
      // Un ordre « conserve » par le broker est perime (commande, M7) ou rejouable (synchronisation) : jamais lu.
      if (packet?.retain) return;
      const m = COMMAND_TOPIC.exec(topic);
      // Seul un topic EXACT de la configuration est ecoute.
      if (m && opts.actuators && commandIds.has(m[1])) {
        try {
          opts.actuators.onCommand(m[1], payload);
        } catch (err) {
          log.log('error', `ordre d'actionneur : erreur interne (${(err as Error).message})`);
        }
        return;
      }
      const s = SYNC_TOPIC.exec(topic);
      if (s && opts.accessSync && syncIds.has(s[1])) {
        try {
          opts.accessSync.onSync(s[1], payload);
        } catch (err) {
          log.log('error', `ordre de synchronisation : erreur interne (${(err as Error).message})`);
        }
      }
    });
    c.on('error', (err) => {
      const code = (err as { code?: number }).code;
      lastError = code === 4 || code === 5 ? 'connexion refusee : identifiant ou mot de passe de la passerelle incorrect (voir PSIM_MQTT_GATEWAYS)' : err.message;
    });
    c.on('close', () => {
      if (client !== c) return;
      client = null;
      const was = isConnected;
      isConnected = false;
      c.removeAllListeners('connect');
      c.end(true);
      inflight?.fail(true);
      if (stopping) return;
      if (was) log.log('warn', `connexion au PSIM perdue${lastError ? ` (${lastError})` : ''}`);
      failuresInRow++;
      schedule();
    });
  }

  /** Un abonnement par actionneur (jamais de joker) ; SUBACK 128 = compte non autorise pour cet actionneur. */
  function subscribeActuators(c: MqttClient): void {
    for (const id of commandIds) {
      const refused = () => log.log('error', `actionneur ${id} non autorise pour ce compte : voir PSIM_MQTT_GATEWAYS, liste actuators (les ordres de ${id} ne seront pas recus)`);
      c.subscribe(`psim/actuators/${id}/command`, { qos: 0 }, (err, granted) => {
        // Sur un refus (SUBACK 128), la bibliotheque leve une erreur qui PORTE le SUBACK, tandis que `granted` repete le QoS
        // demande (0) : c'est donc l'erreur qui fait foi.
        const code = (err as { packet?: { granted?: number[] } } | null)?.packet?.granted?.[0] ?? granted?.[0]?.qos;
        if (code === 128) return refused();
        if (err && client === c && isConnected) log.log('warn', `abonnement aux ordres de l'actionneur ${id} impossible (${err.message})`);
      });
    }
  }

  /** Abonnement exact, QoS 1 ; SUBACK 128 = compte de passerelle non autorise pour ce controleur. */
  function subscribeSync(c: MqttClient, id: string): void {
    c.subscribe(syncTopic(id), { qos: 1 }, (err, granted) => {
      // Comme pour les actionneurs : sur un refus, c'est l'erreur qui porte le SUBACK.
      const code = (err as { packet?: { granted?: number[] } } | null)?.packet?.granted?.[0] ?? granted?.[0]?.qos;
      if (code === 128) {
        log.log('error', `controleur ${id} non autorise pour ce compte (voir la liste des controleurs d'acces de PSIM_MQTT_GATEWAYS) : la synchronisation de ses titulaires ne sera pas recue`);
        return;
      }
      if (err && client === c && isConnected) log.log('warn', `abonnement a la synchronisation du controleur ${id} impossible (${err.message})`);
    });
  }

  function publishOne(c: MqttClient, entry: QueueEntry): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const sentAt = Date.now();
      const done = (err: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        inflight = null;
        if (err) reject(err);
        else resolve();
      };
      const guard = setTimeout(() => done(Object.assign(new Error('pas d\'accuse de reception du PSIM'), { timeout: true })), publishTimeoutMs);
      inflight = { entry, sentAt, fail: (closed) => done(Object.assign(new Error('connexion fermee pendant l\'envoi'), { closed, quick: Date.now() - sentAt < QUICK_CLOSE_MS })) };
      // Erreur rendue par la bibliotheque (connexion fermee avant l'accuse) : meme traitement qu'une fermeture.
      c.publish(topicFor(entry.id), JSON.stringify(entry.m), { qos: 1, retain: false }, (err) =>
        done(err ? Object.assign(err, { closed: true, quick: Date.now() - sentAt < QUICK_CLOSE_MS }) : null),
      );
    });
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      while (!stopping || drained) {
        const c = client;
        if (!c || !isConnected) break;
        const entry = opts.queue.peek();
        if (!entry) break;
        try {
          await publishOne(c, entry);
          opts.queue.ack(entry.seq);
          delay = opts.retry.minMs;
          if (suspect.seq === entry.seq) suspect = { seq: 0, count: 0 };
        } catch (err) {
          const e = err as Error & { quick?: boolean; timeout?: boolean };
          if (stopping) break; // arret volontaire : le message reste en file
          if (e.quick) {
            suspect = suspect.seq === entry.seq ? { seq: entry.seq, count: suspect.count + 1 } : { seq: entry.seq, count: 1 };
            if (suspect.count >= rejectAfter) {
              log.log('error', `message pour ${entry.id} refuse ${suspect.count} fois par le PSIM (detecteur hors du perimetre de ce compte de passerelle ? voir PSIM_MQTT_GATEWAYS) : mis de cote dans rejected.jsonl`);
              opts.queue.reject(entry, 'refuse par le PSIM (connexion coupee apres envoi, a repetition)');
              suspect = { seq: 0, count: 0 };
            }
          } else if (e.timeout) {
            lastError = e.message;
          }
          // Connexion douteuse : on la ferme ; la fermeture planifie la reconnexion.
          if (client === c) c.end(true);
          break;
        }
      }
    } finally {
      pumping = false;
      if (drained && !opts.queue.peek()) drained();
    }
  }

  return {
    start() {
      stopping = false;
      connect();
    },
    kick() {
      if (isConnected && !pumping) void pump();
    },
    connected: () => isConnected,
    publishNow(topic, payload, timeoutMs) {
      const c = client;
      if (!c || !isConnected) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const done = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(guard);
          resolve(ok);
        };
        const guard = setTimeout(() => done(false), timeoutMs ?? publishTimeoutMs);
        guard.unref?.();
        try {
          c.publish(topic, payload, { qos: 1, retain: false }, (err) => done(!err));
        } catch {
          done(false);
        }
      });
    },
    watchSync(controllerId) {
      if (typeof controllerId !== 'string' || !SYNC_ID.test(controllerId)) throw new Error('identifiant de controleur invalide (lettres, chiffres, _ et -, 32 au plus)');
      if (syncIds.has(controllerId)) return;
      syncIds.add(controllerId);
      const c = client;
      if (c && isConnected) subscribeSync(c, controllerId);
    },
    unwatchSync(controllerId) {
      if (!syncIds.delete(controllerId)) return;
      const c = client;
      if (c && isConnected) {
        try {
          c.unsubscribe(syncTopic(controllerId), () => undefined);
        } catch {
          // liaison en train de se fermer : la prochaine connexion ne s'abonnera plus
        }
      }
    },
    watchedSync: () => [...syncIds],
    async stop(flushMs = 3000) {
      if (isConnected && opts.queue.peek() && flushMs > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, flushMs);
          drained = () => {
            clearTimeout(t);
            resolve();
          };
          if (!pumping) void pump();
        });
        drained = null;
      }
      stopping = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const c = client;
      client = null;
      isConnected = false;
      // Fermeture immediate : un message encore en vol reste dans la file disque et repartira (meme msgId) au prochain demarrage.
      if (c) await new Promise<void>((resolve) => c.end(true, {}, () => resolve()));
      inflight?.fail(true);
      if (wasConnected) log.log('info', 'liaison PSIM fermee');
    },
  };
}
