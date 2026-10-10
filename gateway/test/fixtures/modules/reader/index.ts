/**
 * Module FACTICE des essais : lit un autre broker MQTT (comme Zigbee2MQTT) et traduit chaque message
 * `capteurs/<id>` -> `{"state": <contenu>}` pour l'equipement PSIM <id>.
 *   { "url": "mqtt://127.0.0.1:1884", "username": "...", "password": "...", "topic": "capteurs/+" }
 */
import type { GatewayModule, MqttLink, ModuleFactory } from '../../../../src/module.ts';

export const create: ModuleFactory = (config) => {
  let link: MqttLink | null = null;
  const mod: GatewayModule = {
    name: 'reader',
    async start(ctx) {
      link = await ctx.openMqtt(String(config.url), { username: config.username as string | undefined, password: config.password as string | undefined });
      ((globalThis as { gatewayReaderLink?: unknown }).gatewayReaderLink = link);
      await link.subscribe(String(config.topic), (topic, payload) => {
        const id = topic.split('/').pop() as string;
        if (payload.toString() === 'boom') throw new Error('message illisible');
        ctx.emit(id, { state: payload.toString() as 'alarm' });
      });
    },
    async stop() {
      await link?.close();
    },
  };
  return mod;
};
