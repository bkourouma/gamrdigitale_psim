/**
 * Facade HTTP du module `acces-zkteco` : c'est la seule partie qui parle au reseau. Elle accepte des requetes NON
 * AUTHENTIFIEES (le protocole PUSH n'a que le numero de serie), donc elle filtre tout avant de donner la main au module :
 *
 *  - interface d'ecoute choisie par la configuration (jamais « toutes les interfaces » par defaut, voir config.ts) ;
 *  - adresse source : liste blanche facultative (`allowFrom`), controlee des l'ouverture de la connexion ;
 *  - connexions bornees (total et par adresse), delais de lecture courts (en-tetes, requete, inactivite) ;
 *  - debit limite par adresse (seau a jetons) ;
 *  - methodes et chemins stricts : /iclock/cdata (GET, POST), /iclock/getrequest (GET), /iclock/devicecmd (POST),
 *    /iclock/ping (GET) ; rien d'autre ;
 *  - numero de serie `SN` assaini puis compare a la liste des appareils declares ; TOUT refus (chemin, methode, parametre,
 *    numero inconnu) recoit la MEME reponse neutre : aucun indice sur ce qui existe ;
 *  - en-tetes et corps bornes ; un corps trop gros est refuse sans etre lu en entier ;
 *  - aucun texte venu du reseau n'est journalise (seulement l'adresse du socket, qui n'est pas un texte du client).
 * Aucune exception ne sort : un traitement qui echoue repond 500.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { inRanges } from './config.ts';
import type { CidrRange, Limits } from './config.ts';
import { PATH_CDATA, PATH_DEVICECMD, PATH_GETREQUEST, PATH_PING, SERIAL, parseTarget } from './protocol.ts';

export interface FrontRequest {
  method: 'GET' | 'POST';
  path: string;
  params: ReadonlyMap<string, string>;
  /** Numero de serie declare (deja verifie). */
  serial: string;
  /** Corps (POST), decode en UTF-8 ; vide pour un GET. */
  body: string;
  /** Adresse du socket de l'appareil. */
  remote: string;
}

export interface FrontReply {
  status: number;
  body: string;
}

export interface FrontOptions {
  host: string;
  port: number;
  allowFrom: readonly CidrRange[] | null;
  limits: Limits;
  now: () => number;
  /** Journal limite : jamais de texte venu du reseau. */
  log: (key: string, level: 'info' | 'warn' | 'error', text: string) => void;
  knownSerial: (serial: string) => boolean;
  handler: (req: FrontRequest) => FrontReply | Promise<FrontReply>;
}

export interface Front {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Port reellement ouvert (utile quand le port configure est 0). */
  port(): number | null;
  /** Nombre de connexions ouvertes (essais). */
  connections(): number;
}

/** Reponse unique de tout refus de fond : on ne dit pas pourquoi. */
export const NEUTRAL: FrontReply = { status: 404, body: 'Not Found' };

const ROUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [PATH_CDATA, new Set(['GET', 'POST'])],
  [PATH_GETREQUEST, new Set(['GET'])],
  [PATH_DEVICECMD, new Set(['POST'])],
  [PATH_PING, new Set(['GET'])],
]);

/** Taille maximale des tables par adresse (compteurs de debit, connexions). */
const MAX_BUCKETS = 4096;
/** Delai d'inactivite d'une connexion ouverte sans requete. */
const IDLE_MS = 30_000;
const KEEP_ALIVE_MS = 5_000;

/** Seau a jetons : `perMinute` jetons par minute, reserve d'une minute. */
class Buckets {
  private readonly map = new Map<string, { tokens: number; at: number }>();
  private readonly perMinute: number;
  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }
  take(key: string, now: number): boolean {
    let b = this.map.get(key);
    if (!b) {
      if (this.map.size >= MAX_BUCKETS) this.map.delete(this.map.keys().next().value as string);
      b = { tokens: this.perMinute, at: now };
      this.map.set(key, b);
    }
    // Horloge revenue en arriere : on repart de maintenant.
    const elapsed = Math.max(0, now - b.at);
    b.tokens = Math.min(this.perMinute, b.tokens + (elapsed * this.perMinute) / 60_000);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

/** Adresse IPv4 d'un socket (les adresses IPv4 ecrites en IPv6 sont ramenees a leur forme IPv4). */
export function normalizeAddress(a: string | undefined): string {
  if (!a) return 'inconnue';
  return a.startsWith('::ffff:') ? a.slice(7) : a;
}

function send(res: ServerResponse, reply: FrontReply, close: boolean): void {
  if (res.headersSent || res.writableEnded) return;
  const buf = Buffer.from(reply.body, 'utf8');
  res.writeHead(reply.status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...(close ? { Connection: 'close' } : {}),
  });
  res.end(buf);
}

export function createFront(opts: FrontOptions): Front {
  const { limits, now, log } = opts;
  let server: Server | null = null;
  let started = false;
  const sockets = new Set<Socket>();
  const perAddress = new Map<string, number>();
  const buckets = new Buckets(limits.perAddressPerMinute);

  function refuse(res: ServerResponse, reply: FrontReply, req?: IncomingMessage): void {
    // « Connection: close » : le serveur HTTP vide le corps non lu puis ferme apres la reponse. Une fermeture brutale tout
    // de suite ferait perdre la reponse a l'appareil (reinitialisation de connexion). Filet : fermeture d'office plus tard.
    send(res, reply, true);
    if (req) setTimeout(() => req.socket.destroy(), 2000).unref();
  }

  function readBody(req: IncomingMessage, res: ServerResponse, from: string): Promise<string | null> {
    return new Promise((resolve) => {
      const declared = req.headers['content-length'];
      if (declared !== undefined) {
        if (!/^\d{1,10}$/.test(declared)) {
          refuse(res, NEUTRAL, req);
          return resolve(null);
        }
        if (Number(declared) > limits.maxBodyBytes) {
          log(`big:${from}`, 'warn', `corps trop gros refuse depuis ${from}`);
          refuse(res, { status: 413, body: 'Payload Too Large' }, req);
          return resolve(null);
        }
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      req.on('data', (c: Buffer) => {
        if (done) return;
        size += c.length;
        if (size > limits.maxBodyBytes) {
          chunks.length = 0;
          log(`big:${from}`, 'warn', `corps trop gros refuse depuis ${from}`);
          refuse(res, { status: 413, body: 'Payload Too Large' }, req);
          finish(null);
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => finish(null));
      req.on('aborted', () => finish(null));
      req.on('close', () => finish(null));
    });
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const from = normalizeAddress(req.socket.remoteAddress);
    try {
      if (!started) return refuse(res, { status: 503, body: 'Service Unavailable' }, req);
      if (!buckets.take(from, now())) {
        log(`rate:${from}`, 'warn', `debit trop eleve depuis ${from}, requetes refusees`);
        return refuse(res, { status: 429, body: 'Too Many Requests' }, req);
      }
      const method = req.method ?? '';
      const target = parseTarget(req.url);
      const allowed = target ? ROUTES.get(target.path) : undefined;
      const serial = target?.params.get('sn');
      if (!target || !allowed || !allowed.has(method) || serial === undefined || !SERIAL.test(serial) || !opts.knownSerial(serial)) {
        log(`refused:${from}`, 'warn', `requete refusee depuis ${from} (appareil, chemin ou methode non reconnus)`);
        return refuse(res, NEUTRAL, req);
      }
      let body = '';
      if (method === 'POST') {
        const read = await readBody(req, res, from);
        if (read === null) return;
        body = read;
      } else if ((req.headers['content-length'] ?? '0') !== '0' || req.headers['transfer-encoding'] !== undefined) {
        return refuse(res, NEUTRAL, req);
      }
      const reply = await opts.handler({ method: method as 'GET' | 'POST', path: target.path, params: target.params, serial, body, remote: from });
      send(res, reply, false);
    } catch {
      log('error', 'error', 'erreur interne en traitant une requete (le module continue)');
      try {
        send(res, { status: 500, body: 'Internal Server Error' }, true);
      } catch {
        // la reponse est deja partie
      }
    }
  }

  function onConnection(sock: Socket): void {
    const from = normalizeAddress(sock.remoteAddress);
    const count = perAddress.get(from) ?? 0;
    const refusedBy =
      !started
        ? 'arret'
        : opts.allowFrom !== null && !inRanges(from, opts.allowFrom)
          ? 'adresse'
          : sockets.size >= limits.maxConnections || count >= limits.maxConnectionsPerAddress
            ? 'connexions'
            : null;
    if (refusedBy !== null) {
      if (refusedBy === 'adresse') log(`allow:${from}`, 'warn', `connexion refusee depuis ${from} (adresse hors de allowFrom)`);
      else if (refusedBy === 'connexions') log(`conn:${from}`, 'warn', `connexion refusee depuis ${from} (trop de connexions simultanees)`);
      sock.destroy();
      return;
    }
    sockets.add(sock);
    perAddress.set(from, count + 1);
    sock.setTimeout(IDLE_MS, () => sock.destroy());
    sock.on('error', () => {
      /* connexion coupee par l'appareil : sans consequence */
    });
    sock.on('close', () => {
      sockets.delete(sock);
      const c = (perAddress.get(from) ?? 1) - 1;
      if (c <= 0) perAddress.delete(from);
      else perAddress.set(from, c);
    });
  }

  return {
    async start(): Promise<void> {
      if (server) throw new Error('facade deja demarree');
      const srv = createServer({
        maxHeaderSize: 8192,
        // Delais courts : un client lent est coupe (les appareils ZKTeco repondent en quelques centaines de ms).
        headersTimeout: Math.min(limits.requestTimeoutMs, 10_000),
        requestTimeout: limits.requestTimeoutMs,
        keepAliveTimeout: KEEP_ALIVE_MS,
        connectionsCheckingInterval: Math.max(50, Math.min(1000, Math.floor(limits.requestTimeoutMs / 4))),
        noDelay: true,
      });
      server = srv;
      srv.maxConnections = limits.maxConnections;
      srv.on('connection', onConnection);
      srv.on('request', (req, res) => {
        void onRequest(req, res);
      });
      srv.on('clientError', (_err, sock) => {
        // En-tete illisible ou trop gros : on ferme sans repondre de detail.
        if (sock.writable) sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        else sock.destroy();
      });
      started = true;
      try {
        await new Promise<void>((resolve, reject) => {
          srv.once('error', reject);
          srv.listen({ host: opts.host, port: opts.port, exclusive: true }, () => {
            srv.off('error', reject);
            resolve();
          });
        });
      } catch (err) {
        started = false;
        server = null;
        const code = (err as NodeJS.ErrnoException).code ?? 'erreur';
        throw new Error(`ecoute impossible sur ${opts.host}:${opts.port} (${code})`);
      }
      srv.on('error', () => log('server', 'error', 'erreur du serveur HTTP (le module continue)'));
    },
    async stop(): Promise<void> {
      started = false;
      const srv = server;
      server = null;
      for (const s of sockets) s.destroy();
      sockets.clear();
      perAddress.clear();
      if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()));
    },
    port(): number | null {
      const a = server?.address();
      return a && typeof a === 'object' ? a.port : null;
    },
    connections(): number {
      return sockets.size;
    },
  };
}
