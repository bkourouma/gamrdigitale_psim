/**
 * Faux appareil ZKTeco « push » pour les essais du module `acces-zkteco` (centrale ou terminal). Ce n'est PAS un fichier
 * d'essai : il est importe par `acces-zkteco.test.ts` et `e2e-acces-zkteco.test.ts`.
 *
 * Il se comporte comme un vrai appareil, dans les limites de ce que le protocole documente (voir protocol.ts) :
 *  - poignee de main, puis envoi des enregistrements (`rtlog` / `rtstate` / `ATTLOG`) ; les enregistrements restent en memoire
 *    et sont RENVOYES tant que le serveur n'a pas repondu `OK` (comme la memoire hors ligne d'un vrai appareil) ;
 *  - interrogation `getrequest` a la demande, execution simulee des `CONTROL DEVICE` et envoi du resultat `devicecmd`
 *    (code configurable, ou silence) ;
 *  - coupures (`goOffline` / `goOnline`), horloge decalable, numero de serie modifiable ;
 *  - AUCUNE connexion hors de 127.0.0.1.
 */
import { request } from 'node:http';

export interface RawReply {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Requete HTTP brute vers 127.0.0.1 (essais de securite : methodes, chemins et corps de toute sorte). */
export function rawRequest(port: number, method: string, path: string, opts: { body?: string | Buffer; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : Buffer.from(opts.body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: { ...(body ? { 'Content-Length': String(body.length) } : {}), ...(opts.headers ?? {}) },
        timeout: opts.timeoutMs ?? 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('delai depasse')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export type Table = 'rtlog' | 'ATTLOG';

interface Pending {
  table: Table;
  line: string;
  stamp: number;
}

export interface FakeZkOptions {
  port: number;
  serial: string;
  kind?: 'controller' | 'terminal';
  /** Ecart de l'heure locale de l'appareil a l'heure universelle, en minutes. */
  utcOffsetMin?: number;
  /** Heure « reelle » (ms) : celle du test. */
  now: () => number;
}

export interface Executed {
  id: number;
  text: string;
}

/** Heure locale `YYYY-MM-DD HH:MM:SS` d'un instant (ms), pour un appareil d'ecart `utcOffsetMin`. */
export function deviceTimeText(ms: number, utcOffsetMin = 0): string {
  const d = new Date(ms + utcOffsetMin * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export interface RtlogFields {
  /** Instant de l'evenement (ms, heure reelle) ; par defaut maintenant (heure de l'appareil, decalage compris). */
  at?: number;
  pin?: string;
  card?: string;
  door?: number;
  event: number;
  inout?: number;
  verify?: number;
  /** Numero d'enregistrement ; `null` = champ absent. Par defaut : compteur de l'appareil. */
  index?: number | null;
}

export class FakeZk {
  serial: string;
  readonly kind: 'controller' | 'terminal';
  readonly utcOffsetMin: number;
  /** Decalage de l'horloge de l'appareil par rapport a l'heure reelle (ms). */
  clockSkewMs = 0;
  /** Comportement face a une commande : `'ok'` repond Return=0, un nombre repond ce code, `'silent'` ne repond rien. */
  commandReply: 'ok' | 'silent' | number = 'ok';
  /** Commandes remises par le serveur (dans l'ordre) ; `executed` : celles que l'appareil a « executees » (avant sa reponse). */
  readonly received: Executed[] = [];
  readonly executed: Executed[] = [];
  /** Reponses du serveur aux envois de donnees (statut). */
  readonly postStatuses: number[] = [];
  private readonly port: number;
  private readonly now: () => number;
  private online = true;
  private counter = 0;
  private pending: Pending[] = [];

  constructor(o: FakeZkOptions) {
    this.port = o.port;
    this.serial = o.serial;
    this.kind = o.kind ?? 'controller';
    this.utcOffsetMin = o.utcOffsetMin ?? 0;
    this.now = o.now;
  }

  // --- Reseau --------------------------------------------------------------------------------------------------------

  goOffline(): void {
    this.online = false;
  }
  goOnline(): void {
    this.online = true;
  }
  get isOnline(): boolean {
    return this.online;
  }

  private async call(method: 'GET' | 'POST', path: string, query: Record<string, string>, body?: string): Promise<RawReply> {
    if (!this.online) throw new Error('appareil hors ligne');
    const q = new URLSearchParams({ SN: this.serial, ...query }).toString();
    return rawRequest(this.port, method, `${path}?${q}`, { body, headers: body !== undefined ? { 'Content-Type': 'text/plain' } : {} });
  }

  // --- Heure ---------------------------------------------------------------------------------------------------------

  /** Heure de l'appareil (ms), decalage d'horloge compris. */
  deviceNow(): number {
    return this.now() + this.clockSkewMs;
  }
  timeText(ms: number = this.deviceNow()): string {
    return deviceTimeText(ms, this.utcOffsetMin);
  }

  // --- Poignee de main -----------------------------------------------------------------------------------------------

  /** Poignee de main. Rend la reponse brute et les options `Cle=valeur` decodees. */
  async handshake(extra: Record<string, string> = {}): Promise<RawReply & { options: Map<string, string> }> {
    const r = await this.call('GET', '/iclock/cdata', { options: 'all', pushver: '2.4.1', ...extra });
    const options = new Map<string, string>();
    for (const line of r.body.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) options.set(line.slice(0, eq), line.slice(eq + 1));
    }
    return { ...r, options };
  }

  ping(): Promise<RawReply> {
    return this.call('GET', '/iclock/ping', {});
  }

  // --- Enregistrements -----------------------------------------------------------------------------------------------

  /** Ligne rtlog complete (sans la mettre en memoire). */
  rtlogLine(f: RtlogFields): string {
    const at = f.at ?? this.deviceNow();
    const idx = f.index === undefined ? ++this.counter : f.index;
    const cells = [
      `time=${deviceTimeText(at, this.utcOffsetMin)}`,
      `pin=${f.pin ?? '0'}`,
      `cardno=${f.card ?? '0'}`,
      `eventaddr=${f.door ?? 1}`,
      `event=${f.event}`,
      `inoutstatus=${f.inout ?? 0}`,
      `verifytype=${f.verify ?? 4}`,
      ...(idx === null ? [] : [`index=${idx}`]),
      'sitecode=',
      'linkid=0',
    ];
    return cells.join('\t');
  }

  /** Enregistre un evenement dans la memoire de l'appareil (non envoye). Rend la ligne. */
  record(f: RtlogFields): string {
    const line = this.rtlogLine(f);
    this.pending.push({ table: 'rtlog', line, stamp: ++this.stampCounter });
    return line;
  }

  /** Enregistre un pointage de terminal (ordre PIN, heure, Status, Verify, Workcode). */
  recordAttlog(f: { at?: number; pin: string; status?: number; verify?: number }): string {
    const at = f.at ?? this.deviceNow();
    const line = [f.pin, deviceTimeText(at, this.utcOffsetMin), String(f.status ?? 0), String(f.verify ?? 1), '0'].join('\t');
    this.pending.push({ table: 'ATTLOG', line, stamp: ++this.stampCounter });
    return line;
  }

  /** Enregistre une ligne brute (donnee hostile, tronquee...). */
  recordRaw(table: Table, line: string): void {
    this.pending.push({ table, line, stamp: ++this.stampCounter });
  }

  private stampCounter = 0;

  get unacked(): number {
    return this.pending.length;
  }

  /** Oublie la memoire (essais de reprise). */
  clearMemory(): void {
    this.pending = [];
  }

  /**
   * Envoie toute la memoire non acquittee, une requete par table. Un enregistrement n'est efface que si le serveur a repondu
   * 200 avec un corps commencant par `OK`. Rend les reponses.
   */
  async flush(): Promise<RawReply[]> {
    const replies: RawReply[] = [];
    for (const table of ['rtlog', 'ATTLOG'] as const) {
      const batch = this.pending.filter((p) => p.table === table);
      if (batch.length === 0) continue;
      const last = batch[batch.length - 1] as Pending;
      const r = await this.call('POST', '/iclock/cdata', { table, Stamp: String(last.stamp) }, batch.map((p) => p.line).join('\r\n') + '\r\n');
      this.postStatuses.push(r.status);
      replies.push(r);
      if (r.status === 200 && r.body.startsWith('OK')) this.pending = this.pending.filter((p) => !batch.includes(p));
    }
    return replies;
  }

  /** Envoi d'un etat (rtstate) : heure actuelle de l'appareil et contact de chaque porte (1 = fermee, 2 = ouverte). */
  async sendRtstate(sensor: string, opts: { alarm?: string; at?: number } = {}): Promise<RawReply> {
    const line = [`time=${this.timeText(opts.at)}`, `sensor=${sensor}`, 'relay=0000', `alarm=${opts.alarm ?? '0000'}`].join('\t');
    const r = await this.call('POST', '/iclock/cdata', { table: 'rtstate', Stamp: '0' }, `${line}\r\n`);
    this.postStatuses.push(r.status);
    return r;
  }

  /** Enregistre puis envoie tout (cas courant d'un envoi en temps reel). */
  async push(f: RtlogFields): Promise<RawReply[]> {
    this.record(f);
    return this.flush();
  }

  // --- Commandes -----------------------------------------------------------------------------------------------------

  /**
   * Interroge le serveur (`getrequest`), « execute » les commandes recues et repond selon `commandReply`.
   * Rend les commandes recues et la reponse brute.
   */
  async poll(): Promise<{ reply: RawReply; commands: Executed[] }> {
    const reply = await this.call('GET', '/iclock/getrequest', {});
    const commands: Executed[] = [];
    for (const line of reply.body.split(/\r?\n/)) {
      const m = /^C:(\d+):(.+)$/.exec(line);
      if (!m) continue;
      const cmd = { id: Number(m[1]), text: m[2] as string };
      commands.push(cmd);
      this.received.push(cmd);
      this.executed.push(cmd);
      if (this.commandReply !== 'silent') await this.answer(cmd, this.commandReply === 'ok' ? 0 : this.commandReply);
    }
    return { reply, commands };
  }

  /** Resultat d'une commande (`devicecmd`), a la demande (reponse differee, tardive...). */
  async answer(cmd: Executed, code: number): Promise<RawReply> {
    return this.call('POST', '/iclock/devicecmd', {}, `ID=${cmd.id}&Return=${code}&CMD=${cmd.text}\r\n`);
  }
}
