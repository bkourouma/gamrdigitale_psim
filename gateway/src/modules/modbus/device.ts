import type { ModuleContext } from '../../module.ts';
import { ModbusClient, ModbusError } from './client.ts';
import type { ReadFunction } from './client.ts';
import type { DeviceConfig, PointConfig } from './config.ts';
import { evaluate } from './decode.ts';
import { PointTracker } from './points.ts';

/** Un groupe de points contigus lus en une seule requete. */
export interface Block {
  fn: ReadFunction;
  start: number;
  count: number;
  points: PointConfig[];
}

/** Regroupe les points en blocs : meme fonction, adresses contigues (ou separees d'au plus `maxGap`), taille bornee. */
export function planBlocks(dev: Pick<DeviceConfig, 'points' | 'maxGap' | 'maxRegisters' | 'maxBits'>): Block[] {
  const blocks: Block[] = [];
  for (const fn of [1, 2, 3, 4] as const) {
    const pts = dev.points.filter((p) => p.fn === fn).sort((a, b) => a.address - b.address);
    const limit = fn <= 2 ? dev.maxBits : dev.maxRegisters;
    let cur: Block | null = null;
    for (const p of pts) {
      const end = p.address + p.span; // premiere adresse apres le point
      if (cur && p.address <= cur.start + cur.count + dev.maxGap && Math.max(end, cur.start + cur.count) - cur.start <= limit) {
        cur.count = Math.max(end, cur.start + cur.count) - cur.start;
        cur.points.push(p);
      } else {
        cur = { fn, start: p.address, count: p.span, points: [p] };
        blocks.push(cur);
      }
    }
  }
  return blocks;
}

/** Interroge un equipement Modbus en boucle et traduit les lectures en messages PSIM. */
export class DeviceRunner {
  readonly #dev: DeviceConfig;
  readonly #ctx: ModuleContext;
  readonly #client: ModbusClient;
  readonly #blocks: Block[];
  readonly #trackers = new Map<string, PointTracker>();
  #stopped = false;
  #loop: Promise<void> | null = null;
  #wake: (() => void) | null = null;
  #timer: NodeJS.Timeout | null = null;
  #linkFails = 0;
  #down = false;
  readonly #blockBroken = new Set<string>();

  constructor(dev: DeviceConfig, ctx: ModuleContext) {
    this.#dev = dev;
    this.#ctx = ctx;
    this.#client = new ModbusClient({ host: dev.host, port: dev.port, unitId: dev.unitId, timeoutMs: dev.timeoutMs });
    this.#blocks = planBlocks(dev);
    for (const p of dev.points) this.#trackers.set(p.id, new PointTracker(p, dev.failThreshold));
  }

  start(): void {
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#client.close();
    if (this.#timer) clearTimeout(this.#timer);
    this.#wake?.();
    await this.#loop;
  }

  async #run(): Promise<void> {
    while (!this.#stopped) {
      const linkFailed = await this.#cycle();
      if (this.#stopped) break;
      await this.#sleep(this.#delay(linkFailed));
    }
  }

  /** Delai avant le prochain cycle : la periode normale, ou une temporisation exponentielle apres un echec de liaison. */
  #delay(linkFailed: boolean): number {
    const d = this.#dev;
    if (!linkFailed) {
      this.#linkFails = 0;
      return d.pollMs;
    }
    this.#linkFails++;
    const backoff = d.reconnectMinMs * 2 ** Math.min(this.#linkFails - 1, 20);
    return Math.max(d.pollMs, Math.min(d.reconnectMaxMs, backoff));
  }

  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#wake = resolve;
      this.#timer = setTimeout(resolve, ms);
    });
  }

  /** Un tour de lecture. Renvoie true si la liaison a echoue (reseau ou trame), pas pour une simple exception Modbus. */
  async #cycle(): Promise<boolean> {
    let linkError: ModbusError | null = null;
    for (const block of this.#blocks) {
      if (this.#stopped) return false;
      if (linkError) {
        this.#failBlock(block, linkError.message);
        continue;
      }
      try {
        const data = await this.#client.read(block.fn, block.start, block.count);
        if (this.#stopped) return false;
        this.#blockOk(block, data, this.#ctx.now());
      } catch (e) {
        if (this.#stopped) return false;
        const err = e instanceof ModbusError ? e : new ModbusError('protocol', e instanceof Error ? e.message : String(e));
        if (err.isLink) linkError = err;
        this.#failBlock(block, err.message, err.isLink ? null : blockKey(block));
      }
    }
    this.#report(linkError);
    return linkError !== null;
  }

  #blockOk(block: Block, data: boolean[] | number[], ts: number): void {
    this.#blockBroken.delete(blockKey(block));
    for (const p of block.points) {
      const off = p.address - block.start;
      const raw = block.fn <= 2 ? (data as boolean[])[off] : (data as number[]).slice(off, off + p.span);
      this.#send(p.id, this.#tracker(p).sample(evaluate(p, raw), ts));
    }
  }

  #failBlock(block: Block, reason: string, exceptionKey: string | null = null): void {
    const ts = this.#ctx.now();
    if (exceptionKey && !this.#blockBroken.has(exceptionKey)) {
      this.#blockBroken.add(exceptionKey);
      const ids = block.points.map((p) => p.id).join(', ');
      this.#ctx.log('warn', `modbus ${this.#dev.name} : lecture refusee (${reason}) pour ${ids} ; adresses ${block.start} a ${block.start + block.count - 1}`);
    }
    for (const p of block.points) this.#send(p.id, this.#tracker(p).failure(ts));
  }

  #tracker(p: PointConfig): PointTracker {
    return this.#trackers.get(p.id) as PointTracker;
  }

  #send(id: string, msgs: ReturnType<PointTracker['failure']>): void {
    for (const m of msgs) {
      try {
        this.#ctx.emit(id, m);
      } catch {
        // emit ne doit jamais lever ; une erreur du socle ne doit pas arreter la surveillance
      }
    }
  }

  /** Journalise les changements d'accessibilite de l'equipement, sans repeter. */
  #report(linkError: ModbusError | null): void {
    const name = this.#dev.name;
    if (linkError) {
      if (!this.#down && this.#linkFails + 1 >= this.#dev.failThreshold) {
        this.#down = true;
        this.#ctx.log('warn', `modbus ${name} (${this.#dev.host}:${this.#dev.port}) injoignable : ${linkError.message} ; les points passent en defaut`);
      }
    } else if (this.#down) {
      this.#down = false;
      this.#ctx.log('info', `modbus ${name} : equipement de nouveau joignable`);
    }
  }
}

function blockKey(b: Block): string {
  return `${b.fn}:${b.start}:${b.count}`;
}
