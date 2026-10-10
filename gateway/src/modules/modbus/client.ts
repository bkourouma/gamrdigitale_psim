import { createConnection } from 'node:net';
import type { Socket } from 'node:net';

/**
 * Client Modbus TCP en LECTURE SEULE (fonctions 01, 02, 03, 04). Aucune fonction d'ecriture n'existe dans ce code :
 * la passerelle observe l'installation, elle ne la commande jamais.
 *
 * Trame (MBAP) : identifiant de transaction (2) | protocole = 0 (2) | longueur (2) | unite (1) | PDU.
 * Une seule requete en vol par connexion ; la reponse est validee (transaction, unite, fonction, longueur,
 * nombre d'octets) et sa taille est bornee. Toute anomalie de trame ferme la connexion.
 */

export type ReadFunction = 1 | 2 | 3 | 4;

export type ErrorKind = 'argument' | 'connect' | 'timeout' | 'closed' | 'protocol' | 'exception';

export class ModbusError extends Error {
  readonly kind: ErrorKind;
  readonly exceptionCode: number | null;
  constructor(kind: ErrorKind, message: string, exceptionCode: number | null = null) {
    super(message);
    this.name = 'ModbusError';
    this.kind = kind;
    this.exceptionCode = exceptionCode;
  }
  /** Erreur de liaison (reseau ou trame) : l'equipement est injoignable ou incoherent, par opposition a une exception Modbus. */
  get isLink(): boolean {
    return this.kind === 'connect' || this.kind === 'timeout' || this.kind === 'closed' || this.kind === 'protocol';
  }
}

const EXCEPTION_TEXT: Record<number, string> = {
  1: 'fonction non supportee',
  2: 'adresse inexistante dans l\'equipement',
  3: 'valeur ou quantite refusee',
  4: 'defaut interne de l\'equipement',
  5: 'acquittement (traitement long)',
  6: 'equipement occupe',
  8: 'erreur de parite memoire',
  10: 'passerelle : chemin indisponible',
  11: 'passerelle : equipement cible sans reponse',
};

/** Longueur maximale du champ « longueur » d'une reponse valide : unite + PDU (253 octets) = 254. */
const MAX_FRAME_LENGTH = 254;
const MAX_BITS = 2000;
const MAX_REGISTERS = 125;

export interface ClientOptions {
  host: string;
  port: number;
  unitId: number;
  timeoutMs: number;
}

export type ReadResult = boolean[] | number[];

interface Pending {
  tid: number;
  fn: ReadFunction;
  quantity: number;
  resolve: (r: ReadResult) => void;
  reject: (e: ModbusError) => void;
  timer: NodeJS.Timeout;
}

export class ModbusClient {
  readonly #opts: ClientOptions;
  #socket: Socket | null = null;
  #rx: Buffer = Buffer.alloc(0);
  #pending: Pending | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #tid = 0;
  #closed = false;

  constructor(opts: ClientOptions) {
    this.#opts = opts;
  }

  /** Lit `quantity` bits (fonctions 1 et 2) ou mots (fonctions 3 et 4) a partir de `address`. */
  read(fn: ReadFunction, address: number, quantity: number): Promise<ReadResult> {
    const bad = checkArguments(fn, address, quantity);
    if (bad) return Promise.reject(new ModbusError('argument', bad));
    const run = this.#queue.then(() => this.#exchange(fn, address, quantity));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Ferme la connexion et refuse toute lecture ulterieure. */
  close(): void {
    this.#closed = true;
    this.#drop(new ModbusError('closed', 'connexion fermee'));
  }

  async #exchange(fn: ReadFunction, address: number, quantity: number): Promise<ReadResult> {
    if (this.#closed) throw new ModbusError('closed', 'connexion fermee');
    const socket = this.#socket ?? (await this.#connect());
    if (this.#closed) throw new ModbusError('closed', 'connexion fermee');
    this.#tid = (this.#tid % 0xffff) + 1;
    const tid = this.#tid;
    const frame = Buffer.alloc(12);
    frame.writeUInt16BE(tid, 0);
    frame.writeUInt16BE(0, 2);
    frame.writeUInt16BE(6, 4);
    frame.writeUInt8(this.#opts.unitId, 6);
    frame.writeUInt8(fn, 7);
    frame.writeUInt16BE(address, 8);
    frame.writeUInt16BE(quantity, 10);
    return new Promise<ReadResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#drop(new ModbusError('timeout', `pas de reponse en ${this.#opts.timeoutMs} ms`));
      }, this.#opts.timeoutMs);
      this.#pending = { tid, fn, quantity, resolve, reject, timer };
      this.#rx = Buffer.alloc(0);
      socket.write(frame, (err) => {
        if (err) this.#drop(new ModbusError('closed', `envoi impossible : ${err.message}`));
      });
    });
  }

  #connect(): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = createConnection({ host: this.#opts.host, port: this.#opts.port });
      socket.setNoDelay(true);
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(new ModbusError('connect', message));
      };
      const timer = setTimeout(() => fail(`connexion impossible en ${this.#opts.timeoutMs} ms`), this.#opts.timeoutMs);
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#closed) {
          socket.destroy();
          reject(new ModbusError('closed', 'connexion fermee'));
          return;
        }
        this.#socket = socket;
        this.#rx = Buffer.alloc(0);
        socket.on('data', (chunk: Buffer) => this.#onData(socket, chunk));
        socket.on('error', (err) => this.#onSocketGone(socket, `erreur reseau : ${err.message}`));
        socket.on('close', () => this.#onSocketGone(socket, 'connexion coupee par l\'equipement'));
        resolve(socket);
      });
      socket.once('error', (err) => fail(`connexion refusee ou impossible : ${err.message}`));
    });
  }

  #onSocketGone(socket: Socket, message: string): void {
    if (this.#socket !== socket) return;
    this.#drop(new ModbusError('closed', message));
  }

  /** Detruit la connexion et fait echouer la requete en cours. La lecture suivante se reconnecte. */
  #drop(error: ModbusError): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#rx = Buffer.alloc(0);
    if (socket) {
      socket.removeAllListeners('data');
      socket.on('error', () => undefined);
      socket.destroy();
    }
    const p = this.#pending;
    this.#pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(error);
    }
  }

  #onData(socket: Socket, chunk: Buffer): void {
    if (this.#socket !== socket) return;
    const p = this.#pending;
    if (!p) {
      this.#drop(new ModbusError('protocol', 'donnees recues sans requete en cours'));
      return;
    }
    if (this.#rx.length + chunk.length > 260) {
      this.#drop(new ModbusError('protocol', 'reponse trop longue'));
      return;
    }
    this.#rx = Buffer.concat([this.#rx, chunk]);
    const rx = this.#rx;
    if (rx.length < 7) return;
    if (rx.readUInt16BE(2) !== 0) {
      this.#drop(new ModbusError('protocol', 'identifiant de protocole different de 0 (ce n\'est pas du Modbus TCP)'));
      return;
    }
    const length = rx.readUInt16BE(4);
    if (length < 3 || length > MAX_FRAME_LENGTH) {
      this.#drop(new ModbusError('protocol', `longueur de trame incoherente (${length})`));
      return;
    }
    if (rx.length < 6 + length) return; // trame incomplete : on attend la suite (ou le delai)
    if (rx.length > 6 + length) {
      this.#drop(new ModbusError('protocol', 'octets en trop apres la reponse'));
      return;
    }
    const rxTid = rx.readUInt16BE(0);
    if (rxTid !== p.tid) {
      this.#drop(new ModbusError('protocol', `identifiant de transaction inattendu (${rxTid} au lieu de ${p.tid})`));
      return;
    }
    if (rx.readUInt8(6) !== this.#opts.unitId) {
      this.#drop(new ModbusError('protocol', `identifiant d'unite inattendu (${rx.readUInt8(6)})`));
      return;
    }
    const pdu = rx.subarray(7, 6 + length);
    const outcome = parsePdu(pdu, p.fn, p.quantity);
    if (outcome instanceof ModbusError) {
      if (outcome.kind === 'exception') {
        // Trame valide : l'equipement a repondu par une exception. La connexion reste utilisable.
        this.#pending = null;
        this.#rx = Buffer.alloc(0);
        clearTimeout(p.timer);
        p.reject(outcome);
      } else {
        this.#drop(outcome);
      }
      return;
    }
    this.#pending = null;
    this.#rx = Buffer.alloc(0);
    clearTimeout(p.timer);
    p.resolve(outcome);
  }
}

function checkArguments(fn: number, address: number, quantity: number): string | null {
  if (fn !== 1 && fn !== 2 && fn !== 3 && fn !== 4) return `fonction ${fn} refusee : lecture seule (fonctions 1 a 4)`;
  if (!Number.isInteger(address) || address < 0 || address > 65535) return `adresse invalide (${address})`;
  const max = fn <= 2 ? MAX_BITS : MAX_REGISTERS;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > max) return `quantite invalide (${quantity}, maximum ${max})`;
  if (address + quantity > 65536) return 'la plage depasse l\'adresse 65535';
  return null;
}

/** Valide le PDU d'une reponse et en extrait les bits ou mots. Renvoie une ModbusError au lieu de lever. */
function parsePdu(pdu: Buffer, fn: ReadFunction, quantity: number): ReadResult | ModbusError {
  const code = pdu[0];
  if (code === (fn | 0x80)) {
    if (pdu.length !== 2) return new ModbusError('protocol', 'reponse d\'exception mal formee');
    const ex = pdu[1];
    return new ModbusError('exception', `exception Modbus ${ex} : ${EXCEPTION_TEXT[ex] ?? 'code inconnu'}`, ex);
  }
  if (code !== fn) return new ModbusError('protocol', `fonction de reponse inattendue (${code} au lieu de ${fn})`);
  if (pdu.length < 2) return new ModbusError('protocol', 'reponse sans nombre d\'octets');
  const byteCount = pdu[1];
  const expected = fn <= 2 ? Math.ceil(quantity / 8) : quantity * 2;
  if (byteCount !== expected || pdu.length !== 2 + byteCount) {
    return new ModbusError('protocol', `nombre d'octets incoherent (${byteCount} recus, ${expected} attendus)`);
  }
  const data = pdu.subarray(2);
  if (fn <= 2) {
    const bits: boolean[] = [];
    for (let i = 0; i < quantity; i++) bits.push(((data[i >> 3] >> (i & 7)) & 1) === 1);
    return bits;
  }
  const words: number[] = [];
  for (let i = 0; i < quantity; i++) words.push(data.readUInt16BE(i * 2));
  return words;
}
