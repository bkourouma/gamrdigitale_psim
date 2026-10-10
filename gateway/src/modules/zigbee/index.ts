/**
 * Module « zigbee » de la Passerelle GAMR : pont vers Zigbee2MQTT (logiciel libre).
 *
 * Il se branche en lecture sur le broker MQTT de Zigbee2MQTT, s'abonne uniquement aux equipements declares
 * (jamais a tout le broker), traduit leurs messages et les envoie au PSIM par le socle (ctx.emit).
 * Voir gateway/docs/zigbee.md.
 */

import type { GatewayModule, ModuleContext, ModuleFactory, MqttLink } from '../../module.ts';
import { parseConfig, type DeviceSpec, type ZigbeeConfig } from './config.ts';
import { messageTs, newTracker, translate, type TrackerState } from './translate.ts';

/** Au-dela, la charge est ignoree : un capteur Zigbee envoie quelques centaines d'octets. */
export const MAX_PAYLOAD_BYTES = 32 * 1024;

const WARN_EVERY_MS = 60_000;

interface Entry {
  spec: DeviceSpec;
  topic: string;
  tracker: TrackerState;
  /** Dernier message recu de cet equipement (horloge locale du module). */
  lastSeenAt: number;
  /** Instants des derniers envois (fenetre glissante d'une minute) pour le plafond de debit. */
  sent: number[];
}

export const create: ModuleFactory = (config) => new ZigbeeModule(parseConfig(config));

class ZigbeeModule implements GatewayModule {
  readonly name = 'zigbee';
  private readonly cfg: ZigbeeConfig;
  private link: MqttLink | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private started = false;
  /** null = inconnu (aucun message du pont recu), true = en ligne, false = hors ligne. */
  private bridgeOnline: boolean | null = null;
  private readonly lastWarn = new Map<string, number>();

  constructor(cfg: ZigbeeConfig) {
    this.cfg = cfg;
  }

  async start(ctx: ModuleContext): Promise<void> {
    if (this.started) throw new Error('Zigbee : module deja demarre');
    this.started = true;
    this.stopped = false;
    this.bridgeOnline = null;
    const cfg = this.cfg;
    const begin = ctx.now();
    const byTopic = new Map<string, Entry>();
    for (const spec of cfg.devices) {
      byTopic.set(`${cfg.baseTopic}/${spec.key}`, { spec, topic: `${cfg.baseTopic}/${spec.key}`, tracker: newTracker(), lastSeenAt: begin, sent: [] });
    }
    const bridgeTopic = `${cfg.baseTopic}/bridge/state`;

    const warn = (key: string, text: string): void => {
      const t = ctx.now();
      const last = this.lastWarn.get(key);
      if (last !== undefined && t - last < WARN_EVERY_MS) return;
      this.lastWarn.set(key, t);
      ctx.log('warn', text);
    };

    const onBridge = (payload: Buffer): void => {
      if (payload.length > 4096) return warn('bridge', 'Zigbee : etat du pont trop volumineux, ignore');
      const text = payload.toString('utf8').trim();
      let state: unknown = text;
      if (text.startsWith('{')) {
        try {
          state = (JSON.parse(text) as { state?: unknown }).state;
        } catch {
          state = undefined;
        }
      }
      if (state !== 'online' && state !== 'offline') return warn('bridge', 'Zigbee : etat du pont illisible, ignore');
      const online = state === 'online';
      if (this.bridgeOnline === online) return;
      const before = this.bridgeOnline;
      this.bridgeOnline = online;
      if (online) ctx.log('info', before === false ? 'Zigbee : le pont Zigbee2MQTT est de nouveau en ligne' : 'Zigbee : pont Zigbee2MQTT en ligne');
      // Pont hors ligne : on journalise seulement. Les capteurs ne sont PAS declares en panne (on ne sait rien d'eux) ;
      // le silence est juge par le delai propre a chaque equipement cote PSIM.
      else ctx.log('warn', 'Zigbee : le pont Zigbee2MQTT est hors ligne (aucun capteur declare en panne ; les messages reprendront a son retour)');
    };

    const onDevice = (entry: Entry, payload: Buffer): void => {
      if (payload.length === 0) return; // effacement d'un message conserve
      if (payload.length > MAX_PAYLOAD_BYTES) return warn(`big:${entry.topic}`, `Zigbee : message trop volumineux (${payload.length} octets) pour « ${entry.spec.key} », ignore`);
      let data: unknown;
      try {
        data = JSON.parse(payload.toString('utf8'));
      } catch {
        return warn(`json:${entry.topic}`, `Zigbee : message illisible (JSON invalide) pour « ${entry.spec.key} », ignore`);
      }
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return warn(`json:${entry.topic}`, `Zigbee : message inattendu (objet JSON attendu) pour « ${entry.spec.key} », ignore`);
      }
      const t = ctx.now();
      const payloadObj = data as Record<string, unknown>;
      const ts = messageTs(payloadObj.last_seen, t);
      // Message conserve par le broker, devenu trop ancien : l'etat de l'equipement est inconnu, on n'en deduit rien.
      if (ts !== undefined && cfg.maxAgeS > 0 && t - ts > cfg.maxAgeS * 1000) {
        return warn(`old:${entry.topic}`, `Zigbee : message trop ancien (${Math.round((t - ts) / 1000)} s) pour « ${entry.spec.key} », ignore`);
      }
      entry.lastSeenAt = t;

      for (const c of translate(entry.spec, entry.tracker, payloadObj, ts, { now: t, batteryLowPercent: cfg.batteryLowPercent })) {
        entry.sent = entry.sent.filter((s) => t - s < 60_000);
        if (entry.sent.length >= cfg.maxPerMinute) {
          warn(`rate:${entry.topic}`, `Zigbee : « ${entry.spec.key} » envoie trop de messages (plus de ${cfg.maxPerMinute} par minute), le surplus est ignore`);
          continue;
        }
        entry.sent.push(t);
        c.commit();
        try {
          ctx.emit(c.deviceId, c.message);
        } catch (err) {
          ctx.log('error', `Zigbee : envoi impossible pour « ${entry.spec.key} » : ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };

    const opts: { username?: string; password?: string } = {};
    if (cfg.username !== undefined) opts.username = cfg.username;
    if (cfg.password !== undefined) opts.password = cfg.password;
    const link = await ctx.openMqtt(cfg.brokerUrl, opts);
    if (this.stopped) {
      await link.close().catch(() => {});
      return;
    }
    this.link = link;
    try {
      await link.subscribe(bridgeTopic, (_topic, payload) => {
        if (!this.stopped) onBridge(payload);
      });
      for (const entry of byTopic.values()) {
        await link.subscribe(entry.topic, (topic, payload) => {
          if (this.stopped) return;
          const e = byTopic.get(topic);
          if (e) onDevice(e, payload);
        });
      }
    } catch (err) {
      await this.stop();
      throw err;
    }

    if (cfg.staleAfterS !== null) {
      const staleMs = cfg.staleAfterS * 1000;
      // Signe de vie pour le PSIM tant que l'equipement a parle recemment ; au-dela, on se tait et le PSIM le declare muet.
      this.timer = setInterval(() => {
        if (this.stopped || this.bridgeOnline === false) return;
        const t = ctx.now();
        for (const e of byTopic.values()) {
          if (t - e.lastSeenAt > staleMs) continue;
          ctx.emit(e.spec.id, { event: 'heartbeat' });
          if (e.spec.humidityId !== undefined) ctx.emit(e.spec.humidityId, { event: 'heartbeat' });
        }
      }, cfg.heartbeatEveryS * 1000);
      this.timer.unref?.();
    }

    const host = (() => {
      try {
        return new URL(cfg.brokerUrl).host;
      } catch {
        return '?';
      }
    })();
    ctx.log('info', `Zigbee : ${byTopic.size} equipement(s) surveille(s) via ${host} (sujet ${cfg.baseTopic})`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const link = this.link;
    this.link = null;
    if (link) await link.close().catch(() => {});
  }
}
