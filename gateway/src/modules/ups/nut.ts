import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { NUT_NAME_PATTERN } from './config.ts';
import type { MeasureKey } from './config.ts';
import type { UpsReading, UpsStatus } from './reading.ts';

/**
 * Client du protocole NUT (Network UPS Tools), texte sur TCP 3493, LECTURE SEULE.
 * Seules trois commandes sont emises : `LIST UPS`, `LIST VAR <ups>` et `GET VAR <ups> <variable>`.
 * Aucune ecriture, aucune authentification, aucune commande de pilotage.
 */

const MAX_LINE = 4096;
const MAX_BYTES = 262_144;
const MAX_VARS = 2000;
const VAR_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export interface NutTarget {
  host: string;
  port: number;
  timeoutMs: number;
  upsName: string | null;
}

/** Variable NUT lue pour chaque grandeur (en unites NUT : %, secondes, volts, degres C). */
export const NUT_VARS: Record<MeasureKey | 'status', string> = {
  status: 'ups.status',
  charge: 'battery.charge',
  runtime: 'battery.runtime',
  load: 'ups.load',
  battery_voltage: 'battery.voltage',
  input_voltage: 'input.voltage',
  temperature: 'ups.temperature',
};

/** Lecteur de lignes borne : ligne trop longue, trop d'octets, fermeture ou delai = erreur. */
class LineSocket {
  private readonly socket: net.Socket;
  private readonly decoder = new StringDecoder('utf8');
  private buf = '';
  private bytes = 0;
  private readonly lines: string[] = [];
  private waiter: { resolve: (l: string) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (e) => this.fail(new Error(`connexion NUT : ${e.message}`)));
    socket.on('close', () => this.fail(new Error('connexion NUT fermee avant la fin de la reponse')));
    socket.on('end', () => this.fail(new Error('connexion NUT fermee avant la fin de la reponse')));
  }

  fail(e: Error): void {
    if (this.failure) return;
    this.failure = e;
    this.socket.destroy();
    // Les lignes deja recues restent lisibles ; l'erreur ne sort que quand elles sont epuisees.
    this.flush();
  }

  private onData(chunk: Buffer): void {
    if (this.failure) return;
    this.bytes += chunk.length;
    if (this.bytes > MAX_BYTES) return this.fail(new Error('reponse NUT trop volumineuse'));
    this.buf += this.decoder.write(chunk);
    for (;;) {
      const i = this.buf.indexOf('\n');
      if (i < 0) break;
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > MAX_LINE) return this.fail(new Error('ligne NUT trop longue'));
      this.lines.push(line);
    }
    if (this.buf.length > MAX_LINE) return this.fail(new Error('ligne NUT trop longue'));
    this.flush();
  }

  private flush(): void {
    const w = this.waiter;
    if (!w) return;
    if (this.lines.length > 0) {
      this.waiter = null;
      w.resolve(this.lines.shift()!);
    } else if (this.failure) {
      this.waiter = null;
      w.reject(this.failure);
    }
  }

  next(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.flush();
    });
  }

  send(line: string): void {
    this.socket.write(`${line}\n`);
  }

  close(): void {
    this.socket.destroy();
  }
}

function unquote(raw: string): string {
  return raw.replace(/\\(.)/g, '$1');
}

function parseVarLine(line: string, ups: string): { name: string; value: string } {
  const m = /^VAR (\S+) (\S+) "((?:[^"\\]|\\.)*)"$/.exec(line);
  if (!m || m[1] !== ups || !VAR_NAME_RE.test(m[2]!)) throw new Error('reponse NUT mal formee');
  return { name: m[2]!, value: unquote(m[3]!) };
}

function nutError(line: string): Error {
  return new Error(`le serveur NUT a refuse la demande (${line.slice(0, 60).replace(/[^\x20-\x7e]/g, '?')})`);
}

async function listUps(io: LineSocket): Promise<string> {
  io.send('LIST UPS');
  const head = await io.next();
  if (head.startsWith('ERR ')) throw nutError(head);
  if (head !== 'BEGIN LIST UPS') throw new Error('reponse NUT mal formee');
  const found: string[] = [];
  for (let i = 0; i < MAX_VARS; i++) {
    const line = await io.next();
    if (line === 'END LIST UPS') {
      if (found.length === 0) throw new Error('le serveur NUT ne declare aucun onduleur');
      if (found.length > 1) throw new Error(`plusieurs onduleurs chez le serveur NUT (${found.join(', ')}) : precisez "upsName"`);
      return found[0]!;
    }
    const m = /^UPS (\S+) "(?:[^"\\]|\\.)*"$/.exec(line);
    if (!m || !NUT_NAME_PATTERN.test(m[1]!)) throw new Error('reponse NUT mal formee');
    found.push(m[1]!);
  }
  throw new Error('reponse NUT trop longue');
}

/** Renvoie les variables, ou `null` si le serveur refuse LIST VAR (on retombe alors sur GET VAR). */
async function listVars(io: LineSocket, ups: string): Promise<Record<string, string> | null> {
  io.send(`LIST VAR ${ups}`);
  const head = await io.next();
  if (head.startsWith('ERR ')) return null;
  if (head !== `BEGIN LIST VAR ${ups}`) throw new Error('reponse NUT mal formee');
  const vars: Record<string, string> = {};
  for (let i = 0; i < MAX_VARS; i++) {
    const line = await io.next();
    if (line === `END LIST VAR ${ups}`) return vars;
    const v = parseVarLine(line, ups);
    vars[v.name] = v.value;
  }
  throw new Error('reponse NUT trop longue');
}

async function getVars(io: LineSocket, ups: string, names: string[]): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};
  for (const n of names) {
    io.send(`GET VAR ${ups} ${n}`);
    const line = await io.next();
    if (line.startsWith('ERR VAR-NOT-SUPPORTED') || line.startsWith('ERR DATA-STALE')) continue;
    if (line.startsWith('ERR ')) throw nutError(line);
    const v = parseVarLine(line, ups);
    if (v.name !== n) throw new Error('reponse NUT mal formee');
    vars[v.name] = v.value;
  }
  return vars;
}

/** Interprete `ups.status` (liste de drapeaux separes par des espaces : OL, OB, LB, RB, OVER, CHRG...). */
export function parseNutStatus(raw: string): UpsStatus | undefined {
  const tokens = raw.trim().toUpperCase().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  const has = (t: string) => tokens.includes(t);
  const onBattery = has('OB') || has('DISCHRG');
  const degrade = has('LB') || has('RB') ? 'low_battery' : has('OVER') || has('ALARM') || has('OFF') ? 'fault' : 'none';
  return { onBattery, degrade };
}

function numberOf(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && Math.abs(n) <= 1e9 ? n : undefined;
}

/** Normalise les variables NUT en grandeurs canoniques (runtime en secondes). */
export function readingFromNut(vars: Record<string, string>): UpsReading {
  const reading: UpsReading = { values: {} };
  const status = vars[NUT_VARS.status];
  if (status !== undefined) reading.status = parseNutStatus(status);
  for (const key of ['charge', 'runtime', 'load', 'battery_voltage', 'input_voltage', 'temperature'] as const) {
    const n = numberOf(vars[NUT_VARS[key]]);
    if (n !== undefined) reading.values[key] = n;
  }
  return reading;
}

/** Une interrogation complete : connexion, lecture, fermeture. Rejette en cas d'echec, de delai ou d'arret. */
export function nutFetch(target: NutTarget, wanted: string[], signal?: AbortSignal): Promise<UpsReading> {
  return new Promise<UpsReading>((resolve, reject) => {
    const socket = net.connect({ host: target.host, port: target.port });
    socket.setNoDelay(true);
    const io = new LineSocket(socket);
    let done = false;
    const finish = (err: Error | null, value?: UpsReading) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      io.close();
      if (err) reject(err);
      else resolve(value!);
    };
    const timer = setTimeout(() => {
      io.fail(new Error('delai depasse'));
      finish(new Error('delai depasse'));
    }, target.timeoutMs);
    const onAbort = () => finish(new Error('arret demande'));
    if (signal?.aborted) return finish(new Error('arret demande'));
    signal?.addEventListener('abort', onAbort, { once: true });

    (async () => {
      const ups = target.upsName ?? (await listUps(io));
      let vars = await listVars(io, ups);
      if (vars === null) vars = await getVars(io, ups, wanted);
      return readingFromNut(vars);
    })().then(
      (r) => finish(null, r),
      (e: unknown) => finish(e instanceof Error ? e : new Error('erreur NUT')),
    );
  });
}
