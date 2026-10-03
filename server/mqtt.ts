import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { Aedes } from 'aedes';
import type { Engine } from './engine.ts';

const TOPIC = /^psim\/detectors\/([A-Za-z0-9_-]{1,32})\/state$/;
const MAX_PAYLOAD_BYTES = 1024;

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

/**
 * Broker MQTT embarque. Les detecteurs (ou leur passerelle) publient sur
 * `psim/detectors/<id>/state` un JSON `{"state":"normal|prealarm|alarm|fault|offline"}`.
 * Ecoute uniquement sur l'interface configuree (127.0.0.1 par defaut) et exige un identifiant.
 */
export async function startBroker(
  engine: Engine,
  opts: { host: string; port: number; user: string; password: string; tls?: { cert: string; key: string } | null },
): Promise<Broker> {
  const aedes = await Aedes.createBroker();

  aedes.authenticate = (_client, username, password, done) => {
    const ok = username === opts.user && password?.toString() === opts.password;
    done(ok ? null : Object.assign(new Error('Auth failed'), { returnCode: 4 as never }), ok);
  };

  // Un client MQTT ne peut publier que sur l'arborescence des detecteurs.
  aedes.authorizePublish = (client, packet, done) => {
    if (client && !TOPIC.test(packet.topic)) return done(new Error('Topic non autorise'));
    done();
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
