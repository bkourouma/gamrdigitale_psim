/**
 * Faux controleur d'acces Dahua (HTTP, 127.0.0.1, port libre) pour les essais du module `acces-dahua`. AUCUN reseau reel.
 *
 * Reproduit ce que le module utilise :
 *  - authentification Digest MD5 avec nonce (401 puis 200), qop=auth, verification de l'URI ;
 *  - `eventManager.cgi?action=attach` : flux multipart, un « Heartbeat » regulier et des evenements
 *    `Code=...;action=...;index=...;data={...}` (JSON sur plusieurs lignes, comme un vrai controleur) ;
 *  - `recordFinder.cgi?action=find&name=AccessControlCardRec` : memoire d'enregistrements numerotes (RecNo croissants), fenetre de
 *    temps `StartTime` / `EndTime`, `count`, `condition.CardNo`, reponse `totalCount=`, `found=`, `records[i].Cle=` ;
 *  - `global.cgi?action=getCurrentTime` (horloge decalable, heure LOCALE) ;
 *  - `accessControl.cgi` : `openDoor`, `closeDoor`, `getDoorStatus` ;
 *  - `configManager.cgi` : `getConfig` / `setConfig` de `AccessControl[i].State` (le reste de la configuration est conserve).
 * Les formats suivent les documents Dahua cites dans gateway/src/modules/acces-dahua/protocol.ts ; ce qui est une hypothese du
 * module (A QUALIFIER) l'est ici aussi.
 *
 * Pilotage depuis l'essai : emitAccess, emitDoor, cutStream, dropAll, setClockOffset, failAuth, setMuted, setRecordFinder,
 * commandBehavior, compteurs et journaux.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface FakeRecord {
  RecNo: number;
  CreateTime: number;
  CardNo: string;
  CardName: string;
  UserID: string;
  Type: string;
  Method: number;
  Status: number;
  Door: number;
  ReaderID: string;
  ErrorCode: number;
  Password?: string;
}

export interface AccessInput {
  /** Numero de porte tel que le controleur l'ecrit (0 = premiere porte). */
  door?: number;
  cardNo?: string;
  cardName?: string;
  userId?: string;
  method?: number;
  /** 1 = accepte (defaut), 0 = refuse ; `null` = champ absent. */
  status?: number | null;
  errorCode?: number;
  type?: 'Entry' | 'Exit';
  /** N° d'enregistrement ; auto-incremente par defaut. */
  recNo?: number;
  /** Faux : l'evenement du flux ne porte pas de `RecNo` (comme certains terminaux), mais l'enregistrement existe. */
  streamRecNo?: boolean;
  /** Heure de l'evenement en secondes UTC (defaut : horloge du controleur). */
  utc?: number;
  /** Code PIN saisi : stocke et envoye par le faux controleur, pour verifier qu'il ne ressort jamais. */
  password?: string;
  /** Faux : n'enregistre pas dans la memoire (evenement seulement). */
  store?: boolean;
  /** Faux : n'envoie pas sur le flux (enregistrement seulement : passage pendant une coupure). */
  send?: boolean;
}

export type CommandBehavior = 'ok' | 'error' | 'hang' | 'empty' | 'http500';

export interface FakeDahuaOptions {
  username?: string;
  password?: string;
  heartbeatMs?: number;
  /** Fonction horloge du controleur (defaut `Date.now`) : la meme que le `now` du module pour les essais deterministes. */
  now?: () => number;
  /** Decalage de l'heure locale par rapport a UTC, en minutes. */
  utcOffsetMin?: number;
  doors?: number;
  recordFinder?: boolean;
  getDoorStatus?: boolean;
  /** Plafond du nombre d'enregistrements rendus par page (le vrai controleur en impose un). */
  pageCap?: number;
}

export interface RequestLog {
  path: string;
  authenticated: boolean;
}

export interface CommandLog {
  action: string;
  channel: number | null;
  query: Record<string, string>;
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

function parseAuth(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of header.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) out[m[1]!.toLowerCase()] = m[2] ?? m[3]!;
  return out;
}

export class FakeDahua {
  readonly host = '127.0.0.1';
  port = 0;
  readonly username: string;
  readonly password: string;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly streams = new Set<ServerResponse>();
  private readonly nonces = new Set<string>();
  private readonly clock: () => number;
  private readonly utcOffsetMin: number;
  private heartbeatMs: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly doorCount: number;
  private clockOffsetMs = 0;
  private muted = false;
  private authFailures = 0;
  private recordFinderOn: boolean;
  private doorStatusOn: boolean;
  private pageCap: number;
  private nextRecNo = 1;
  private readonly boundary = 'myboundary';

  readonly records: FakeRecord[] = [];
  /** Requetes recues avec authentification reussie. */
  readonly requests: RequestLog[] = [];
  /** Ordres de porte (openDoor, closeDoor). */
  readonly commands: CommandLog[] = [];
  /** Ecritures de configuration : chaque element = les parametres recus (hors action). */
  readonly configWrites: Record<string, string>[] = [];
  /** Mode de chaque porte (index de table). */
  readonly modes: string[];
  /** Etat de chaque porte (index de table) : Open / Close / Break. */
  readonly doorStates: string[];
  /** Autres cles de configuration par porte : elles ne doivent JAMAIS etre modifiees par le module. */
  readonly otherConfig: Record<string, string>[];

  /** Connexions TCP acceptees, flux ouverts (attach), defis 401 envoyes, authentifications reussies, refusees. */
  connections = 0;
  attaches = 0;
  challenges = 0;
  authOk = 0;
  authRejected = 0;
  recordFinds = 0;
  behavior: { openDoor: CommandBehavior; closeDoor: CommandBehavior; setConfig: CommandBehavior } = { openDoor: 'ok', closeDoor: 'ok', setConfig: 'ok' };
  /** Delai ajoute a chaque reponse (ms). */
  latencyMs = 0;

  private constructor(opts: FakeDahuaOptions) {
    this.username = opts.username ?? 'psim';
    this.password = opts.password ?? 'Mot-de-passe-Dahua-essai-1';
    this.clock = opts.now ?? Date.now;
    this.utcOffsetMin = opts.utcOffsetMin ?? 0;
    this.heartbeatMs = opts.heartbeatMs ?? 200;
    this.doorCount = opts.doors ?? 4;
    this.recordFinderOn = opts.recordFinder ?? true;
    this.doorStatusOn = opts.getDoorStatus ?? true;
    this.pageCap = opts.pageCap ?? 1024;
    this.modes = Array.from({ length: this.doorCount }, () => 'Normal');
    this.doorStates = Array.from({ length: this.doorCount }, () => 'Close');
    this.otherConfig = Array.from({ length: this.doorCount }, (_, i) => ({ UnlockHoldInterval: '2500', Enable: 'true', Name: `Porte${i + 1}`, 'CloseTimeout': '60' }));
    this.server = createServer((req, res) => this.onRequest(req, res));
    this.server.on('connection', (s) => {
      this.connections++;
      this.sockets.add(s);
      s.on('error', () => undefined);
      s.on('close', () => this.sockets.delete(s));
    });
  }

  static async start(opts: FakeDahuaOptions = {}): Promise<FakeDahua> {
    const fake = new FakeDahua(opts);
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', () => resolve()));
    fake.port = (fake.server.address() as AddressInfo).port;
    fake.restartHeartbeat();
    return fake;
  }

  /** Heure du controleur (ms UTC). */
  deviceNow(): number {
    return this.clock() + this.clockOffsetMs;
  }

  // --- Pilotage ---------------------------------------------------------------------------------------------------------

  setClockOffset(ms: number): void {
    this.clockOffsetMs = ms;
  }

  /** Les `n` prochaines authentifications sont refusees meme avec le bon mot de passe. */
  failAuth(n: number): void {
    this.authFailures = n;
  }

  /** Flux ouvert mais muet : ni signe de vie ni evenement. */
  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  setHeartbeat(ms: number): void {
    this.heartbeatMs = ms;
    this.restartHeartbeat();
  }

  setRecordFinder(on: boolean): void {
    this.recordFinderOn = on;
  }

  setDoorStatus(on: boolean): void {
    this.doorStatusOn = on;
  }

  setPageCap(n: number): void {
    this.pageCap = n;
  }

  /** Nombre de flux d'evenements ouverts en ce moment. */
  get openStreams(): number {
    return this.streams.size;
  }

  /** Ferme proprement tous les flux (le client voit la fin du flux) ; les requetes restent possibles. */
  cutStream(): void {
    for (const res of [...this.streams]) {
      try {
        res.end();
      } catch {
        // deja ferme
      }
    }
    this.streams.clear();
  }

  /** Detruit toutes les connexions TCP (coupure brutale). */
  dropAll(): void {
    for (const s of [...this.sockets]) s.destroy();
    this.streams.clear();
  }

  /** Arrete d'ecouter (le controleur « disparait ») ; `resume()` le remet sur le MEME port. */
  async pause(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  async resume(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  clearRecords(): void {
    this.records.length = 0;
  }

  /**
   * Un passage : enregistre dans la memoire du controleur (sauf `store: false`) ET envoie sur les flux ouverts (sauf `send: false`).
   * Rend l'enregistrement.
   */
  emitAccess(input: AccessInput = {}): FakeRecord {
    const recNo = input.recNo ?? this.nextRecNo;
    this.nextRecNo = Math.max(this.nextRecNo, recNo + 1);
    const utc = input.utc ?? Math.floor(this.deviceNow() / 1000);
    const rec: FakeRecord = {
      RecNo: recNo,
      CreateTime: utc,
      CardNo: input.cardNo ?? '0012345',
      CardName: input.cardName ?? 'KONAN Yao',
      UserID: input.userId ?? '101',
      Type: input.type ?? 'Entry',
      Method: input.method ?? 1,
      Status: input.status === undefined ? 1 : (input.status ?? 1),
      Door: input.door ?? 0,
      ReaderID: '1',
      ErrorCode: input.errorCode ?? 0,
      ...(input.password !== undefined ? { Password: input.password } : {}),
    };
    if (input.store !== false) this.records.push(rec);
    if (input.send !== false) {
      const data: Record<string, unknown> = {
        CardName: rec.CardName,
        CardNo: rec.CardNo,
        CardType: 0,
        CreateTime: utc,
        Door: rec.Door,
        ErrorCode: rec.ErrorCode,
        Method: rec.Method,
        ReaderID: rec.ReaderID,
        ...(input.status === null ? {} : { Status: rec.Status }),
        Type: rec.Type,
        UTC: utc,
        UserID: rec.UserID,
        UserType: 0,
        ...(input.streamRecNo === false ? {} : { RecNo: rec.RecNo }),
        ...(input.password !== undefined ? { Password: input.password } : {}),
      };
      this.writeEvent('AccessControl', 'Pulse', rec.Door, data);
    }
    return rec;
  }

  /** Evenement quelconque sur le flux (DoorStatus, DoorNotClosed, BreakIn, ChassisIntruded...). */
  emitDoor(code: string, opts: { action?: string; index?: number; data?: Record<string, unknown> | string | null } = {}): void {
    const data = opts.data === undefined ? { LocaleTime: this.localTime(this.deviceNow()) } : opts.data;
    this.writeEvent(code, opts.action ?? 'Pulse', opts.index ?? 0, data);
  }

  /** Envoie une partie brute sur les flux. */
  emitRaw(body: string): void {
    this.writePart(body);
  }

  // --- Interne ----------------------------------------------------------------------------------------------------------

  private restartHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.writePart('Heartbeat'), this.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  private writeEvent(code: string, action: string, index: number, data: Record<string, unknown> | string | null): void {
    const json = data === null ? '' : typeof data === 'string' ? data : JSON.stringify(data, null, 3);
    this.writePart(`Code=${code};action=${action};index=${index}${data === null ? '' : `;data=${json}`}`);
  }

  private writePart(body: string, force = false): void {
    if (this.muted && !force) return;
    const bytes = Buffer.byteLength(body);
    const frame = `--${this.boundary}\r\nContent-Type: text/plain\r\nContent-Length: ${bytes}\r\n\r\n${body}\r\n`;
    for (const res of this.streams) {
      try {
        res.write(frame);
      } catch {
        // flux ferme entre-temps
      }
    }
  }

  /** Heure locale du controleur « 2021-8-6 12:34:31 ». */
  private localTime(utcMs: number): string {
    const d = new Date(utcMs + this.utcOffsetMin * 60_000);
    return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
  }

  private challenge(res: ServerResponse): void {
    const nonce = randomBytes(12).toString('hex');
    this.nonces.add(nonce);
    if (this.nonces.size > 200) this.nonces.delete(this.nonces.values().next().value as string);
    this.challenges++;
    res.writeHead(401, { 'WWW-Authenticate': `Digest realm="Login to FAKEDAHUA", qop="auth", nonce="${nonce}", opaque="${md5(nonce)}"`, 'Content-Length': 0 });
    res.end();
  }

  private verify(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (!header || !/^Digest\s/i.test(header)) return false;
    const a = parseAuth(header);
    if (!a.nonce || !this.nonces.has(a.nonce)) return false;
    if (a.username !== this.username || a.uri !== req.url || a.qop !== 'auth') return false;
    const ha1 = md5(`${this.username}:${a.realm}:${this.password}`);
    const ha2 = md5(`GET:${a.uri}`);
    const expected = md5(`${ha1}:${a.nonce}:${a.nc}:${a.cnonce}:auth:${ha2}`);
    return expected === a.response;
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    req.on('error', () => undefined);
    const run = () => {
      if (!this.verify(req)) {
        if (req.headers.authorization) this.authRejected++;
        return this.challenge(res);
      }
      if (this.authFailures > 0) {
        this.authFailures--;
        this.authRejected++;
        return this.challenge(res);
      }
      this.authOk++;
      this.requests.push({ path: req.url ?? '', authenticated: true });
      this.route(req, res);
    };
    if (this.latencyMs > 0) setTimeout(run, this.latencyMs);
    else run();
  }

  private text(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://fake');
    const q = Object.fromEntries(url.searchParams.entries());
    const path = url.pathname;
    const action = q.action ?? '';
    if (path === '/cgi-bin/eventManager.cgi' && action === 'attach') return this.attach(res);
    if (path === '/cgi-bin/global.cgi' && action === 'getCurrentTime') return this.text(res, 200, `result=${this.localTime(this.deviceNow())}\r\n`);
    if (path === '/cgi-bin/recordFinder.cgi' && action === 'find') return this.find(res, q);
    if (path === '/cgi-bin/accessControl.cgi') return this.accessControl(res, action, q);
    if (path === '/cgi-bin/configManager.cgi') return this.config(res, action, url, q);
    this.text(res, 404, 'Not Found');
  }

  private attach(res: ServerResponse): void {
    this.attaches++;
    res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${this.boundary}`, 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    this.streams.add(res);
    res.on('close', () => this.streams.delete(res));
    res.on('error', () => undefined);
    // Un vrai controleur commence par un signe de vie.
    if (!this.muted) this.writePart('Heartbeat');
  }

  private find(res: ServerResponse, q: Record<string, string>): void {
    this.recordFinds++;
    if (!this.recordFinderOn || q.name !== 'AccessControlCardRec') return this.text(res, 404, 'Not Found');
    const start = Number(q.StartTime ?? 0);
    const end = Number(q.EndTime ?? Number.MAX_SAFE_INTEGER);
    const count = Math.max(1, Math.min(Number(q.count ?? 1024) || 1024, this.pageCap));
    const card = q['condition.CardNo'];
    const matching = this.records
      .filter((r) => r.CreateTime >= start && r.CreateTime <= end && (card === undefined || r.CardNo === card))
      .sort((a, b) => a.CreateTime - b.CreateTime || a.RecNo - b.RecNo);
    const page = matching.slice(0, count);
    const lines = [`totalCount=${matching.length}`, `found=${page.length}`];
    page.forEach((r, i) => {
      for (const [k, v] of Object.entries(r)) lines.push(`records[${i}].${k}=${v}`);
    });
    this.text(res, 200, `${lines.join('\r\n')}\r\n`);
  }

  private accessControl(res: ServerResponse, action: string, q: Record<string, string>): void {
    const channel = q.channel === undefined ? null : Number(q.channel);
    if (action === 'getDoorStatus') {
      if (!this.doorStatusOn || channel === null || channel < 1 || channel > this.doorCount) return this.text(res, 404, 'Not Found');
      return this.text(res, 200, `Info.status=${this.doorStates[channel - 1]}\r\n`);
    }
    if (action !== 'openDoor' && action !== 'closeDoor') return this.text(res, 400, 'Error\r\nBad Request!');
    this.commands.push({ action, channel, query: q });
    if (channel === null || !Number.isInteger(channel) || channel < 1 || channel > this.doorCount) return this.text(res, 400, 'Error\r\nBad Request!');
    this.respondCommand(res, this.behavior[action], () => {
      this.doorStates[channel - 1] = action === 'openDoor' ? 'Open' : 'Close';
    });
  }

  private respondCommand(res: ServerResponse, behavior: CommandBehavior, onOk: () => void): void {
    switch (behavior) {
      case 'ok':
        onOk();
        return this.text(res, 200, 'OK\r\n');
      case 'error':
        return this.text(res, 200, 'Error\r\nBad Request!');
      case 'empty':
        return this.text(res, 200, '');
      case 'http500':
        return this.text(res, 500, 'Error');
      case 'hang':
        return; // ne repond jamais
    }
  }

  private config(res: ServerResponse, action: string, url: URL, q: Record<string, string>): void {
    if (action === 'getConfig') {
      if (q.name !== 'AccessControl') return this.text(res, 404, 'Not Found');
      const lines: string[] = [];
      for (let i = 0; i < this.doorCount; i++) {
        lines.push(`table.AccessControl[${i}].State=${this.modes[i]}`);
        for (const [k, v] of Object.entries(this.otherConfig[i]!)) lines.push(`table.AccessControl[${i}].${k}=${v}`);
      }
      return this.text(res, 200, `${lines.join('\r\n')}\r\n`);
    }
    if (action === 'setConfig') {
      const params: Record<string, string> = {};
      for (const [k, v] of url.searchParams.entries()) if (k !== 'action') params[k] = v;
      this.configWrites.push(params);
      return this.respondCommand(res, this.behavior.setConfig, () => {
        for (const [k, v] of Object.entries(params)) {
          const m = /^AccessControl\[(\d+)\]\.(\w+)$/.exec(k);
          if (!m) continue;
          const i = Number(m[1]);
          if (i < 0 || i >= this.doorCount) continue;
          if (m[2] === 'State') this.modes[i] = v;
          else this.otherConfig[i]![m[2]!] = v;
        }
      });
    }
    this.text(res, 400, 'Error');
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.dropAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
