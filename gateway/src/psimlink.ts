/**
 * Liaison vers le broker MQTT du PSIM : vide la file disque DANS L'ORDRE, un message a la fois, en QoS 1 (le message n'est
 * retire de la file qu'apres l'accuse de reception du broker). Broker injoignable : nouvel essai avec une pause qui double
 * (minMs, 2 x minMs... maxMs au plus), remise au minimum des qu'un message passe.
 *
 * Message refuse par le PSIM (detecteur hors du perimetre du compte de passerelle : le broker coupe la connexion au lieu
 * d'accuser reception) : apres REJECT_AFTER coupures de suite sur CE message, juste apres son envoi, il est mis de cote
 * (rejected.jsonl) pour ne pas bloquer toute la file derriere lui. Une simple panne reseau ne produit pas ce schema.
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
}

export interface PsimLink {
  start(): void;
  /** Nouveau message en file : l'envoyer des que possible. */
  kick(): void;
  connected(): boolean;
  /** Arret : laisse au plus `flushMs` pour vider la file si le PSIM est joignable. */
  stop(flushMs?: number): Promise<void>;
}

/** Une coupure qui survient moins de QUICK_CLOSE_MS apres l'envoi est attribuee au message (refus du broker). */
const QUICK_CLOSE_MS = 3000;

export function createPsimLink(opts: PsimLinkOptions): PsimLink {
  const log = opts.log;
  const publishTimeoutMs = opts.publishTimeoutMs ?? 15_000;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  const rejectAfter = opts.rejectAfter ?? 5;
  const where = redactUrl(opts.url);

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
      void pump();
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
