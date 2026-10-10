import type { GatewayModule, ModuleContext, ModuleFactory } from '../../module.ts';
import { parseConfig } from './config.ts';
import type { ModbusConfig } from './config.ts';
import { DeviceRunner } from './device.ts';

export { ConfigError, parseConfig } from './config.ts';

/**
 * Module Modbus TCP (lecture seule) : modules d'entrees a contacts secs, 4-20 mA, compteurs d'energie, groupes
 * electrogenes, niveaux de cuve... Voir gateway/docs/modbus.md.
 */
class ModbusModule implements GatewayModule {
  readonly name = 'modbus';
  readonly #config: ModbusConfig;
  #runners: DeviceRunner[] = [];

  constructor(config: ModbusConfig) {
    this.#config = config;
  }

  async start(ctx: ModuleContext): Promise<void> {
    if (this.#runners.length > 0) return;
    this.#runners = this.#config.devices.map((d) => new DeviceRunner(d, ctx));
    const points = this.#config.devices.reduce((n, d) => n + d.points.length, 0);
    ctx.log('info', `modbus : ${this.#config.devices.length} equipement(s), ${points} point(s) surveille(s)`);
    for (const r of this.#runners) r.start();
  }

  async stop(): Promise<void> {
    const runners = this.#runners;
    this.#runners = [];
    await Promise.all(runners.map((r) => r.stop()));
  }
}

/** Valide la configuration (leve ConfigError, en francais, si elle est incorrecte) puis cree le module. */
export const create: ModuleFactory = (config) => new ModbusModule(parseConfig(config));
