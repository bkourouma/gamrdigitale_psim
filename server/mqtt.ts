import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { Aedes } from 'aedes';
import type { Engine } from './engine.ts';

const TOPIC = /^psim\/detectors\/([A-Za-z0-9_-]{1,32})\/state$/;
// Commandes des equipements (voir actuators.ts, docs/COMMANDES.md) : ordres publies par le PSIM seul, accuses par la passerelle.
const COMMAND_TOPIC = /^psim\/actuators\/([A-Za-z0-9_-]{1,32})\/command$/;
const ACK_TOPIC = /^psim\/actuators\/([A-Za-z0-9_-]{1,32})\/ack$/;
const MAX_PAYLOAD_BYTES = 1024;
const MAX_CONNECTIONS = 200;
const AUTH_FAILURE_LIMIT = 10;
const AUTH_FAILURE_WINDOW_MS = 60_000;

/** Passerelle : un compte MQTT propre, limite aux detecteurs qu'elle represente (identifiants exacts ou prefixe « D-* »). */
export interface Gateway {
  user: string;
  password: string;
  detectors: string[];
  /** Actionneurs dont elle recoit les ordres et publie les accuses (identifiants exacts ou prefixes « R-* »). Absent = aucun. */
  actuators?: string[];
}

export interface Broker {
  server: Server;
  /** Publie un etat de detecteur comme le ferait un equipement reel (utilise par le simulateur). */
  publishDetectorState(detectorId: string, state: string): Promise<void>;
  /** Idem avec un message complet : `{state}`, `{event}` ou `{value}` (capteurs d'intrusion, d'acces, d'environnement). */
  publishDetector(detectorId: string, payload: Record<string, unknown>): Promise<void>;
  /** Nombre de clients MQTT connectes (passerelles de detecteurs). */
  clients(): number;
  /** Publie un ordre signe sur `psim/actuators/<id>/command` (QoS 0, jamais conserve). */
  publishCommand(actuatorId: string, payload: Buffer): Promise<void>;
  /** Clients de passerelle autorises actuellement abonnes aux ordres de cet actionneur. */
  actuatorListeners(actuatorId: string): number;
  close(): Promise<void>;
}

const digest = (v: string) => createHash('sha256').update(v).digest();
/** Comparaison en temps constant (les deux cotes sont ramenes a la meme longueur par le hachage). */
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** `D-*` : tout identifiant qui commence par « D- » ; sinon identifiant exact. */
export function allows(patterns: readonly string[], id: string): boolean {
  return patterns.some((p) => (p.endsWith('*') ? id.startsWith(p.slice(0, -1)) : p === id));
}

type PsimClient = { psimAllowed?: readonly string[] | null; psimGateway?: string; psimActuators?: readonly string[]; conn?: Socket };

/**
 * Broker MQTT embarque. Les detecteurs (ou leur passerelle) publient sur
 * `psim/detectors/<id>/state` un JSON `{"state":"normal|prealarm|alarm|fault|offline"}` (ou `event`, `value`).
 * Ecoute uniquement sur l'interface configuree (127.0.0.1 par defaut) et exige un identifiant.
 *
 * Durcissement : un client ne peut JAMAIS lire les messages des autres (aucun abonnement, sauf le compte principal sur le topic
 * des detecteurs : outil de recette, et un compte de passerelle sur les ORDRES de SES actionneurs, topic exact, voir
 * docs/COMMANDES.md) ni demander l'arborescence `$SYS` ; les messages « retained » sont interdits (ils seraient
 * stockes sans limite puis redistribues) ; un message de plus de 1 Ko est refuse ; un compte de passerelle ne peut publier que
 * pour ses propres detecteurs ; les echecs d'authentification sont limites par adresse.
 */
export async function startBroker(
  engine: Engine,
  opts: {
    host: string;
    port: number;
    user: string;
    password: string;
    tls?: { cert: string; key: string } | null;
    gateways?: Gateway[];
    /** Connexion / deconnexion d'un client authentifie avec un compte de passerelle (voir gatewaylink.ts). Jamais bloquant. */
    onGateway?: (user: string, connected: boolean, client: object) => void;
    /** Accuse de commande recu d'un compte autorise pour cet actionneur (voir actuators.ts, qui verifie la signature). */
    onActuatorAck?: (actuatorId: string, payload: Buffer) => void;
  },
): Promise<Broker> {
  const aedes = await Aedes.createBroker({ connectTimeout: 10_000, maxClientsIdLength: 64 });
  const gateways = opts.gateways ?? [];
  const failures = new Map<string, number[]>();
  // Abonnes aux ordres de chaque actionneur (une commande que personne ne recevrait est refusee, voir actuators.ts).
  const listeners = new Map<string, Set<unknown>>();
  const trackListener = (client: unknown, actuatorId: string, on: boolean) => {
    const set = listeners.get(actuatorId) ?? new Set<unknown>();
    if (on) set.add(client);
    else set.delete(client);
    if (set.size === 0) listeners.delete(actuatorId);
    else listeners.set(actuatorId, set);
  };

  aedes.authenticate = (client, username, password, done) => {
    const address = (client as unknown as PsimClient).conn?.remoteAddress ?? 'inconnue';
    const t = Date.now();
    const recent = (failures.get(address) ?? []).filter((x) => t - x < AUTH_FAILURE_WINDOW_MS);
    // Trop d'echecs depuis cette adresse : on refuse meme le bon mot de passe pendant une minute (force brute en ligne).
    const refuse = (code: number) => done(Object.assign(new Error('Auth failed'), { returnCode: code as never }), false);
    if (recent.length >= AUTH_FAILURE_LIMIT) return refuse(5);
    const pass = password?.toString() ?? '';
    const user = username ?? '';
    const gateway = gateways.find((g) => same(g.user, user));
    // Les deux comparaisons sont toujours faites (pas de sortie anticipee qui trahirait le compte).
    const mainOk = same(opts.user, user) && same(opts.password, pass);
    const gatewayOk = gateway ? same(gateway.password, pass) : false;
    if (mainOk) {
      (client as unknown as PsimClient).psimAllowed = null; // compte principal : tous les detecteurs
      (client as unknown as PsimClient).psimActuators = []; // ... mais aucun actionneur (ni ordre ni accuse)
      return done(null, true);
    }
    if (gateway && gatewayOk) {
      (client as unknown as PsimClient).psimAllowed = gateway.detectors;
      (client as unknown as PsimClient).psimGateway = gateway.user;
      (client as unknown as PsimClient).psimActuators = gateway.actuators ?? [];
      return done(null, true);
    }
    recent.push(t);
    failures.set(address, recent);
    if (failures.size > 1000) failures.clear();
    refuse(4);
  };

  // Un client MQTT ne peut publier que sur l'arborescence des detecteurs, pour SES detecteurs, sans « retain », et petit.
  aedes.authorizePublish = (client, packet, done) => {
    if (!client) return done(); // publication interne (simulateur, ordres du PSIM)
    // Accuse de commande : seulement un compte de passerelle autorise pour CET actionneur. Les ordres eux-memes
    // (`.../command`) ne sont jamais publiables par un client : ils tombent dans le refus general ci-dessous.
    const ack = ACK_TOPIC.exec(packet.topic);
    if (ack) {
      const actuators = (client as unknown as PsimClient).psimActuators ?? [];
      if (!allows(actuators, ack[1])) return done(new Error('Actionneur non autorise pour ce compte'));
      if ((packet.payload as Buffer).length > MAX_PAYLOAD_BYTES) return done(new Error('Message trop gros'));
      packet.retain = false;
      return done();
    }
    const match = TOPIC.exec(packet.topic);
    if (!match) return done(new Error('Topic non autorise'));
    const allowed = (client as unknown as PsimClient).psimAllowed;
    if (allowed && !allows(allowed, match[1])) return done(new Error('Detecteur non autorise pour ce compte'));
    if ((packet.payload as Buffer).length > MAX_PAYLOAD_BYTES) return done(new Error('Message trop gros'));
    packet.retain = false; // jamais de message conserve : il serait stocke sans limite et redistribue a tout nouvel abonne
    done();
  };

  // Aucun abonnement, sauf pour le compte principal sur les topics des detecteurs (outil de recette). Jamais « # », « + » seul, ni « $SYS ».
  aedes.authorizeSubscribe = (client, sub, done) => {
    const allowed = (client as unknown as PsimClient).psimAllowed;
    const topic = sub.topic;
    // Ordres d'un actionneur : topic EXACT (jamais + ni #), compte de passerelle autorise pour cet id, force en QoS 0 :
    // aucun ordre n'est garde pour un client deconnecte (pas de commande « fantome » executee au retour de la liaison).
    const command = COMMAND_TOPIC.exec(topic);
    if (command) {
      const actuators = (client as unknown as PsimClient).psimActuators ?? [];
      if (!allows(actuators, command[1])) return done(null, null);
      trackListener(client, command[1], true);
      // Le PSIM publie ses ordres en QoS 0 (jamais mis en file hors ligne par aedes) ; l'abonnement est ramene a 0 aussi,
      // y compris dans la session memorisee d'un client « clean: false ».
      sub.qos = 0;
      return done(null, sub);
    }
    const detectorsOnly = topic === 'psim/detectors/+/state' || TOPIC.test(topic);
    done(null, allowed === null && detectorsOnly ? sub : null);
  };

  // Liaison des passerelles : leurs capteurs ne sont pas declares muets un par un quand c'est la passerelle qui est coupee.
  const gatewayEvent = (client: unknown, connected: boolean) => {
    const user = (client as PsimClient).psimGateway;
    if (!user || !opts.onGateway) return;
    try {
      opts.onGateway(user, connected, client as object);
    } catch (err) {
      console.error('[mqtt] liaison passerelle :', err);
    }
  };
  aedes.on('client', (client) => gatewayEvent(client, true));
  aedes.on('clientDisconnect', (client) => {
    gatewayEvent(client, false);
    for (const [id, set] of listeners) {
      set.delete(client);
      if (set.size === 0) listeners.delete(id);
    }
  });
  aedes.on('unsubscribe', (topics, client) => {
    for (const topic of topics) {
      const m = COMMAND_TOPIC.exec(topic);
      if (m && client) trackListener(client, m[1], false);
    }
  });

  aedes.on('publish', (packet, client) => {
    const ack = ACK_TOPIC.exec(packet.topic);
    if (ack) {
      // Seuls les accuses venus d'un client (deja autorise ci-dessus) comptent ; la signature est verifiee par actuators.ts.
      if (!client || (packet.payload as Buffer).length > MAX_PAYLOAD_BYTES || !opts.onActuatorAck) return;
      try {
        opts.onActuatorAck(ack[1], packet.payload as Buffer);
      } catch (err) {
        console.error('[mqtt] accuse de commande :', err);
      }
      return;
    }
    const match = TOPIC.exec(packet.topic);
    if (!match) return;
    const raw = packet.payload as Buffer;
    if (raw.length > MAX_PAYLOAD_BYTES) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    engine.handleDetectorMessage(match[1], parsed);
  });

  // TLS optionnel (mqtts) : indispensable des que le broker est ouvert au reseau.
  const server = opts.tls
    ? createTlsServer({ cert: readFileSync(opts.tls.cert), key: readFileSync(opts.tls.key), minVersion: 'TLSv1.2' }, aedes.handle)
    : createServer(aedes.handle);
  server.maxConnections = MAX_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, resolve);
  });

  const broker: Broker = {
    server: server as Server,
    clients: () => aedes.connectedClients,
    actuatorListeners: (actuatorId) => listeners.get(actuatorId)?.size ?? 0,
    publishCommand(actuatorId, payload) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(actuatorId) || payload.length > MAX_PAYLOAD_BYTES) return Promise.reject(new Error('ordre invalide'));
      return new Promise((resolve, reject) => {
        aedes.publish(
          { cmd: 'publish', qos: 0, dup: false, retain: false, topic: `psim/actuators/${actuatorId}/command`, payload },
          (err) => (err ? reject(err) : resolve()),
        );
      });
    },
    publishDetectorState: (detectorId, state) => broker.publishDetector(detectorId, { state }),
    publishDetector(detectorId, payload) {
      return new Promise((resolve, reject) => {
        aedes.publish(
          {
            cmd: 'publish',
            qos: 0,
            dup: false,
            retain: false,
            topic: `psim/detectors/${detectorId}/state`,
            payload: Buffer.from(JSON.stringify({ ...payload, ts: Date.now() })),
          },
          (err) => (err ? reject(err) : resolve()),
        );
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close();
        aedes.close(() => resolve());
      });
    },
  };
  return broker;
}
