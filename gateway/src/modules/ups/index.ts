import type { GatewayModule, ModuleContext, ModuleFactory } from '../../module.ts';
import { parseConfig } from './config.ts';
import type { IdKey, MeasureKey, UpsConfig } from './config.ts';
import { NUT_VARS, nutFetch } from './nut.ts';
import type { UpsReading } from './reading.ts';
import { snmpFetch } from './snmp.ts';
import { UpsTracker } from './tracker.ts';
import type { Emission } from './tracker.ts';

/**
 * Module `ups` : supervision d'onduleur, en lecture seule, par NUT (TCP 3493) ou SNMP UPS-MIB (UDP 161).
 * Chaque grandeur est routee vers un identifiant PSIM distinct ; le PSIM applique ses seuils.
 */

function describe(cfg: UpsConfig): string {
  return `${cfg.transport} ${cfg.host}:${cfg.port}`;
}

class Poller {
  private readonly cfg: UpsConfig;
  private readonly ctx: ModuleContext;
  private readonly nextSeq: () => number;
  private readonly tracker: UpsTracker;
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private stopped = false;
  private readonly missingLogged = new Set<string>();

  constructor(cfg: UpsConfig, ctx: ModuleContext, nextSeq: () => number) {
    this.cfg = cfg;
    this.ctx = ctx;
    this.nextSeq = nextSeq;
    this.tracker = new UpsTracker(cfg);
  }

  start(): void {
    this.ctx.log('info', `Onduleur "${this.cfg.name}" (${describe(this.cfg)}) : supervision demarree`);
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort.abort();
    await this.inflight;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inflight = this.pollOnce().finally(() => {
        this.inflight = null;
        this.schedule(this.cfg.pollMs);
      });
    }, delay);
  }

  private fetch(): Promise<UpsReading> {
    const cfg = this.cfg;
    const keys = Object.keys(cfg.ids) as IdKey[];
    if (cfg.transport === 'nut') {
      const wanted = keys.map((k) => NUT_VARS[k]);
      return nutFetch({ host: cfg.host, port: cfg.port, timeoutMs: cfg.timeoutMs, upsName: cfg.upsName }, wanted, this.abort.signal);
    }
    return snmpFetch(
      { host: cfg.host, port: cfg.port, community: cfg.community, version: cfg.version, timeoutMs: cfg.timeoutMs, line: cfg.line },
      new Set<MeasureKey | 'status'>(keys),
      this.abort.signal,
    );
  }

  private send(list: Emission[], ts: number): void {
    for (const e of list) {
      const msgId = `ups-${e.deviceId}-${ts}-${this.nextSeq().toString(36)}`;
      try {
        this.ctx.emit(e.deviceId, { ...e.msg, ts, msgId });
      } catch (err) {
        this.ctx.log('error', `Onduleur "${this.cfg.name}" : envoi vers ${e.deviceId} impossible (${err instanceof Error ? err.message : 'erreur'})`);
      }
    }
  }

  private async pollOnce(): Promise<void> {
    const name = this.cfg.name;
    let reading: UpsReading;
    try {
      reading = await this.fetch();
    } catch (e) {
      if (this.stopped) return;
      const why = e instanceof Error ? e.message : 'erreur inconnue';
      const r = this.tracker.onFailure();
      if (r.fault) {
        this.ctx.log('error', `Onduleur "${name}" injoignable apres ${this.cfg.maxFailures} echec(s) consecutif(s) (${why}) : passage en defaut`);
        this.send(r.emissions, this.ctx.now());
      } else if (r.first) {
        this.ctx.log('warn', `Onduleur "${name}" : lecture impossible (${why}), nouvelle tentative`);
      }
      return;
    }
    if (this.stopped) return;
    const ts = this.ctx.now();
    const r = this.tracker.onReading(reading, ts);
    if (r.recovered) this.ctx.log('info', `Onduleur "${name}" de nouveau joignable`);
    else if (r.hadFailures) this.ctx.log('info', `Onduleur "${name}" : lecture reprise`);
    this.warnMissing(reading);
    this.send(r.emissions, ts);
  }

  private warnMissing(reading: UpsReading): void {
    for (const key of Object.keys(this.cfg.ids) as IdKey[]) {
      const present = key === 'status' ? reading.status !== undefined : reading.values[key] !== undefined;
      if (present) this.missingLogged.delete(key);
      else if (!this.missingLogged.has(key)) {
        this.missingLogged.add(key);
        this.ctx.log('warn', `Onduleur "${this.cfg.name}" : la grandeur "${key}" n'est pas fournie par l'onduleur (identifiant ${this.cfg.ids[key]} ignore)`);
      }
    }
  }
}

class UpsModule implements GatewayModule {
  readonly name = 'ups';
  private readonly configs: UpsConfig[];
  private pollers: Poller[] = [];
  private seq = 0;

  constructor(config: Record<string, unknown>) {
    this.configs = parseConfig(config);
  }

  async start(ctx: ModuleContext): Promise<void> {
    if (this.pollers.length > 0) return;
    const nextSeq = () => ++this.seq;
    this.pollers = this.configs.map((c) => new Poller(c, ctx, nextSeq));
    for (const p of this.pollers) p.start();
  }

  async stop(): Promise<void> {
    const list = this.pollers;
    this.pollers = [];
    await Promise.all(list.map((p) => p.stop()));
  }
}

export const create: ModuleFactory = (config) => new UpsModule(config);
