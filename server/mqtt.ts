import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { Aedes } from 'aedes';
import type { Engine } from './engine.ts';

const TOPIC = /^psim\/detectors\/([A-Za-z0-9_-]{1,32})\/state$/;
const MAX_PAYLOAD_BYTES = 1024;
const MAX_CONNECTIONS = 200;
const AUTH_FAILURE_LIMIT = 10;
const AUTH_FAILURE_WINDOW_MS = 60_000;

/** Passerelle : un compte MQTT propre, limite aux detecteurs qu'elle represente (identifiants exacts ou prefixe « D-* »). */
export interface Gateway {
  user: string;
  password: string;
  detectors: string[];
}

export interface Broker {
  server: Server;
  /** Publie un etat de detecteur comme le ferait un equipement reel (utilise par le simulateur). */
  publishDetectorState(detectorId: string, state: string): Promise<void>;
  /** Idem avec un message complet : `{state}`, `{event}` ou `{value}` (capteurs d'intrusion, d'acces, d'environnement). */
  publishDetector(detectorId: string, payload: Record<string, unknown>): Promise<void>;
  /** Nombre de clients MQTT connectes (passerelles de detecteurs). */
  clients(): number;
  close(): Promise<void>;
}

const digest = (v: string) => createHash('sha256').update(v).digest();
/** Comparaison en temps constant (les deux cotes sont ramenes a la meme longueur par le hachage). */
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** `D-*` : tout identifiant qui commence par « D- » ; sinon identifiant exact. */
export function allows(patterns: readonly string[], id: string): boolean {
  return patterns.some((p) => (p.endsWith('*') ? id.startsWith(p.slice(0, -1)) : p === id));
}

type PsimClient = { psimAllowed?: readonly string[] | null; conn?: Socket };

/**
 * Broker MQTT embarque. Les detecteurs (ou leur passerelle) publient sur
 * `psim/detectors/<id>/state` un JSON `{"state":"normal|prealarm|alarm|fault|offline"}` (ou `event`, `value`).
 * Ecoute uniquement sur l'interface configuree (127.0.0.1 par defaut) et exige un identifiant.
 *
 * Durcissement : un client ne peut JAMAIS lire les messages des autres (aucun abonnement, sauf le compte principal sur le topic
 * des detecteurs : outil de recette) ni demander l'arborescence `$SYS` ; les messages « retained » sont interdits (ils seraient
 * stockes sans limite puis redistribues) ; un message de plus de 1 Ko est refuse ; un compte de passerelle ne peut publier que
 * pour ses propres detecteurs ; les echecs d'authentification sont limites par adresse.
 */
export async function startBroker(
  engine: Engine,
  opts: { host: string; port: number; user: string; password: string; tls?: { cert: string; key: string } | null; gateways?: Gateway[] },
): Promise<Broker> {
  const aedes = await Aedes.createBroker({ connectTimeout: 10_000, maxClientsIdLength: 64 });
  const gateways = opts.gateways ?? [];
  const failures = new Map<string, number[]>();

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
      return done(null, true);
    }
    if (gateway && gatewayOk) {
      (client as unknown as PsimClient).psimAllowed = gateway.detectors;
      return done(null, true);
    }
    recent.push(t);
    failures.set(address, recent);
    if (failures.size > 1000) failures.clear();
    refuse(4);
  };

  // Un client MQTT ne peut publier que sur l'arborescence des detecteurs, pour SES detecteurs, sans « retain », et petit.
  aedes.authorizePublish = (client, packet, done) => {
    if (!client) return done(); // publication interne (simulateur)
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
    const detectorsOnly = topic === 'psim/detectors/+/state' || TOPIC.test(topic);
    done(null, allowed === null && detectorsOnly ? sub : null);
  };

  aedes.on('publish', (packet) => {
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
