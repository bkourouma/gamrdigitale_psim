/**
 * Simulateur d'actionneur pour les essais (pas un fichier de test : importe par les tests).
 *
 *  - MQTT : client du broker du PSIM avec un compte de passerelle ; s'abonne aux ordres d'UN actionneur, verifie chaque
 *    ordre comme le fera le pilote (signature, fraicheur, anti-rejeu par cmdId) et repond selon le mode : accuse
 *    (`ack`), refuse (`refuse`), ne repond pas (`silent`), repond en retard (`late`), ou accuse avec une signature fausse
 *    (`forge`) ;
 *  - HTTP : relais IP factice qui repond 200, 500, une redirection, ou ne repond jamais (`hang`).
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { signAck, verifyCommand } from '../server/actuatorproto.ts';
import type { CommandMessage } from '../server/actuatorproto.ts';

export type SimMode = 'ack' | 'refuse' | 'silent' | 'late' | 'forge';

export interface MqttSim {
  client: MqttClient;
  /** Ordres valides recus (apres verification). */
  received: CommandMessage[];
  /** Ordres rejetes par la verification (motif). */
  rejected: string[];
  mode: SimMode;
  lateMs: number;
  close(): Promise<void>;
}

export async function startMqttActuator(opts: { url: string; username: string; password: string; actuatorId: string; key: string; mode?: SimMode; lateMs?: number }): Promise<MqttSim> {
  const client = mqtt.connect(opts.url, { username: opts.username, password: opts.password, reconnectPeriod: 0, connectTimeout: 5000, clean: true });
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });
  const topic = `psim/actuators/${opts.actuatorId}/command`;
  const granted = await client.subscribeAsync(topic, { qos: 1 });
  if (granted[0]?.qos === 128) throw new Error(`abonnement refuse : ${topic}`);
  const seen = new Map<string, number>();
  const sim: MqttSim = {
    client,
    received: [],
    rejected: [],
    mode: opts.mode ?? 'ack',
    lateMs: opts.lateMs ?? 0,
    close: () => client.endAsync(true).then(() => undefined),
  };
  client.on('message', (t, payload) => {
    if (t !== topic) return;
    const check = verifyCommand(opts.key, opts.actuatorId, payload);
    if (!check.ok) {
      sim.rejected.push(check.reason);
      return;
    }
    const m = check.message;
    const now = Date.now();
    for (const [id, at] of seen) if (now - at > 120_000) seen.delete(id);
    if (seen.has(m.cmdId)) {
      sim.rejected.push('replay');
      return;
    }
    seen.set(m.cmdId, now);
    sim.received.push(m);
    if (sim.mode === 'silent') return;
    const answer = () => {
      const ack = signAck(opts.key, opts.actuatorId, { cmdId: m.cmdId, result: sim.mode === 'refuse' ? 'refused' : 'done', ...(sim.mode === 'refuse' ? { code: 'not_allowed' } : {}), ts: Date.now() });
      if (sim.mode === 'forge') ack.sig = ack.sig.replace(/^./, (c) => (c === '0' ? '1' : '0'));
      client.publish(`psim/actuators/${opts.actuatorId}/ack`, JSON.stringify(ack), { qos: 1 });
    };
    if (sim.mode === 'late') setTimeout(answer, sim.lateMs);
    else answer();
  });
  return sim;
}

export type RelayMode = 'ok' | 'error' | 'redirect' | 'hang';

export interface HttpRelay {
  server: Server;
  port: number;
  requests: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[];
  mode: RelayMode;
  close(): Promise<void>;
}

export async function startHttpRelay(mode: RelayMode = 'ok'): Promise<HttpRelay> {
  const relay: HttpRelay = { server: null as unknown as Server, port: 0, requests: [], mode, close: async () => undefined };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      relay.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (relay.mode === 'hang') return; // ne repond jamais
      if (relay.mode === 'redirect') return void res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }).end();
      res.writeHead(relay.mode === 'ok' ? 200 : 500, { 'Content-Type': 'text/plain' }).end(relay.mode === 'ok' ? 'OK secret-dans-la-reponse' : 'erreur');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  relay.server = server;
  relay.port = (server.address() as AddressInfo).port;
  relay.close = () =>
    new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return relay;
}
