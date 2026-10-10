/**
 * Liaison MQTT vers un AUTRE broker (Zigbee2MQTT, ChirpStack...), en LECTURE seule : le module s'abonne, il ne publie pas.
 * Reconnexion automatique (abonnements repris), TLS si l'adresse est mqtts:// (autorites de certification du systeme ;
 * NODE_EXTRA_CA_CERTS pour une autorite privee).
 *
 * La promesse est tenue a la PREMIERE connexion reussie ; elle est rompue (et la liaison fermee) si le broker refuse les
 * identifiants ou reste injoignable : le demarrage du module echoue alors, et le socle le retente plus tard.
 */
import { randomBytes } from 'node:crypto';
import mqtt from 'mqtt';
import { redactUrl } from './config.ts';
import type { Logger } from './log.ts';
import type { MqttLink } from './module.ts';

export interface OpenOptions {
  username?: string;
  password?: string;
  log: Logger;
  /** Prefixe des lignes de journal (nom du module). */
  label: string;
  connectTimeoutMs?: number;
  reconnectMs?: number;
}

/** Le filtre MQTT `filter` (avec + et #) couvre-t-il `topic` ? */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return i < t.length || (i === t.length && i > 0);
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

export async function openMqtt(url: string, opts: OpenOptions): Promise<MqttLink> {
  const log = opts.log;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('adresse MQTT illisible');
  }
  if (u.protocol !== 'mqtt:' && u.protocol !== 'mqtts:') throw new Error('adresse MQTT : mqtt:// ou mqtts:// attendu');
  if (u.username || u.password) throw new Error("adresse MQTT : pas d'identifiant dans l'adresse (utiliser username / password)");
  const where = redactUrl(url);
  const client = mqtt.connect(url, {
    username: opts.username,
    password: opts.password,
    clientId: `gamr-gw-src-${randomBytes(6).toString('hex')}`,
    clean: true,
    keepalive: 30,
    reconnectPeriod: opts.reconnectMs ?? 5000,
    connectTimeout: opts.connectTimeoutMs ?? 10_000,
    resubscribe: true,
    protocolVersion: 4,
  });
  const subs: { filter: string; onMessage: (topic: string, payload: Buffer) => void }[] = [];
  let closed = false;
  let online = false;

  await new Promise<void>((resolve, reject) => {
    const timeoutMs = (opts.connectTimeoutMs ?? 10_000) + 5000;
    const fail = (why: string) => {
      clearTimeout(timer);
      client.removeListener('connect', ok);
      client.removeListener('error', onError);
      client.end(true);
      closed = true;
      reject(new Error(`${where} : ${why}`));
    };
    const ok = () => {
      clearTimeout(timer);
      client.removeListener('error', onError);
      resolve();
    };
    const onError = (err: Error & { code?: number }) => {
      if (err.code === 4 || err.code === 5) fail('connexion refusee (identifiant ou mot de passe)');
    };
    const timer = setTimeout(() => fail('injoignable'), timeoutMs);
    client.once('connect', ok);
    client.on('error', onError);
  });
  online = true;
  log.log('info', `[${opts.label}] connecte a ${where}`);

  client.on('error', (err) => log.log('warn', `[${opts.label}] ${where} : ${err.message}`));
  client.on('offline', () => {
    if (online && !closed) log.log('warn', `[${opts.label}] liaison perdue avec ${where}, reconnexion automatique`);
    online = false;
  });
  client.on('connect', () => {
    if (!online) log.log('info', `[${opts.label}] reconnecte a ${where}`);
    online = true;
  });
  client.on('message', (topic, payload) => {
    for (const s of subs) {
      if (!topicMatches(s.filter, topic)) continue;
      try {
        s.onMessage(topic, payload);
      } catch (err) {
        // Une erreur du module sur un message ne doit ni couper la liaison ni arreter la passerelle.
        log.log('error', `[${opts.label}] erreur en traitant ${topic.slice(0, 200)} : ${(err as Error).message}`);
      }
    }
  });

  return {
    async subscribe(filter, onMessage) {
      if (closed) throw new Error('liaison MQTT fermee');
      if (typeof filter !== 'string' || !filter || filter.length > 512) throw new Error('filtre de topic invalide');
      if (typeof onMessage !== 'function') throw new Error('fonction de reception attendue');
      // Recepteur enregistre AVANT l'abonnement : les messages conserves (retained) arrivent parfois avant l'accuse.
      const sub = { filter, onMessage };
      subs.push(sub);
      const drop = () => subs.splice(subs.indexOf(sub), 1);
      try {
        const granted = await client.subscribeAsync(filter, { qos: 1 });
        if (granted.some((g) => g.qos === 128)) throw new Error(`abonnement refuse par ${where} : ${filter}`);
      } catch (err) {
        if (subs.includes(sub)) drop();
        throw err;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      subs.length = 0;
      await client.endAsync(true).catch(() => undefined);
    },
  };
}
