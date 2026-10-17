/**
 * Transport HTTP des commandes : le PSIM appelle directement un relais IP (voir docs/COMMANDES.md, 5.4).
 *
 * Protections (SSRF : un administrateur malveillant ou trompe ne doit pas pouvoir viser autre chose qu'un equipement) :
 *  - adresses TOUJOURS refusees : metadonnees cloud, lien local (169.254/16, fe80::/10), 0.0.0.0/8, multidiffusion,
 *    diffusion ; la boucle locale (127/8, ::1) seulement si elle est nommee explicitement dans la liste autorisee (essais) ;
 *  - toute IPv6 qui embarque une IPv4 (::ffff:a.b.c.d ou ::ffff:a9fe:a9fe, ::a.b.c.d, NAT64 64:ff9b::/96) est ramenee a cette
 *    IPv4 AVANT de decider : les refus permanents s'appliquent a l'adresse reelle ;
 *  - par defaut (liste vide) : adresses IP privees seulement (10/8, 172.16/12, 192.168/16, fc00::/7), jamais un nom ;
 *  - avec une liste (PSIM_ACTUATOR_HTTP_HOSTS) : noms, adresses ou blocs IPv4 (a.b.c.d/n) de la liste seulement ; un NOM de la
 *    liste n'ouvre pas pour autant n'importe quelle adresse : celle qu'il designe doit rester privee (RFC 1918 / ULA), sauf si
 *    la liste nomme elle-meme cette adresse (adresse litterale ou bloc) ;
 *  - la verification porte sur l'adresse RESOLUE au moment de la connexion (un nom qui se met a pointer ailleurs, DNS
 *    rebinding, est refuse) ; les redirections ne sont jamais suivies (un 3xx est un echec) ;
 *  - un seul essai, delai court, corps de reponse lu au plus 4 Ko et JAMAIS journalise.
 */
import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { PsimError } from './errors.ts';

const METADATA_NAMES = new Set(['metadata.google.internal', 'metadata', 'instance-data', 'instance-data.ec2.internal']);
const METADATA_IPS = new Set(['169.254.169.254', '100.100.100.200', 'fd00:ec2::254', '169.254.170.2']);
const PLACEHOLDERS = new Set(['action', 'durationS', 'clip', 'cmdId', 'ts', 'sig']);
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'content-type', 'cookie', 'expect', 'upgrade', 'te']);
const CONTENT_TYPES = new Set(['application/json', 'application/x-www-form-urlencoded', 'text/plain']);
const MAX_RESPONSE_BYTES = 4096;

export interface HttpAllow {
  names: Set<string>;
  ips: Set<string>;
  cidrs: { base: number; bits: number }[];
}

export interface HttpRequestTemplate {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  body?: string;
}

export interface HttpTransportConfig {
  requests: Record<string, HttpRequestTemplate>;
  contentType?: string;
  /** Nom de l'en-tete secret (sa valeur est chiffree a part, jamais renvoyee). */
  secretHeader?: string;
}

const ipv4ToInt = (ip: string): number => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);

/** Lit PSIM_ACTUATOR_HTTP_HOSTS : noms, adresses IP, ou blocs IPv4 « 192.168.10.0/24 ». Une entree invalide arrete le demarrage. */
export function parseAllowList(entries: readonly string[]): HttpAllow {
  const allow: HttpAllow = { names: new Set(), ips: new Set(), cidrs: [] };
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!entry) continue;
    const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(entry);
    if (cidr && isIP(cidr[1]) === 4 && Number(cidr[2]) >= 8 && Number(cidr[2]) <= 32) {
      allow.cidrs.push({ base: ipv4ToInt(cidr[1]), bits: Number(cidr[2]) });
    } else if (isIP(entry)) allow.ips.add(normalizeIp(entry));
    else if (/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/.test(entry) && !METADATA_NAMES.has(entry)) allow.names.add(entry);
    else throw new Error(`PSIM_ACTUATOR_HTTP_HOSTS : entree invalide « ${raw.slice(0, 64)} » (nom, adresse IP ou bloc IPv4 a.b.c.d/n ; 8 bits au moins)`);
  }
  return allow;
}

/** Les 16 octets d'une adresse IPv6 (formes compressee, hexadecimale et pointee finale admises), ou null si illisible. */
function ipv6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const g = dotted.slice(1, 5).map(Number);
    if (g.some((n) => n > 255)) return null;
    s = `${s.slice(0, dotted.index)}${((g[0] << 8) | g[1]).toString(16)}:${((g[2] << 8) | g[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array<string>(Math.max(fill, 0)).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]);
}

/**
 * Ramene a l'IPv4 sous-jacente toute adresse IPv6 qui en embarque une, AVANT toute decision : IPv4 inscrite (::ffff:a.b.c.d et
 * sa forme hexadecimale ::ffff:a9fe:a9fe), IPv4-compatible (::a.b.c.d) et NAT64 (64:ff9b::/96). Les refus permanents
 * (metadonnees, lien local, boucle locale...) s'appliquent ainsi a l'adresse reelle. Le reste est mis en forme canonique.
 */
export function normalizeIp(ip: string): string {
  if (isIP(ip) === 4) return ip;
  const b = ipv6Bytes(ip);
  if (!b) return ip.toLowerCase();
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4;
  if (zeros(0, 12) && !(zeros(12, 15) && b[15] <= 1)) return v4; // :: et ::1 restent ce qu'ils sont
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return v4;
  const zoneless = ip.split('%')[0];
  try {
    return new URL(`http://[${zoneless}]/`).hostname.slice(1, -1);
  } catch {
    return zoneless.toLowerCase();
  }
}

function inV4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
}

function alwaysForbidden(ip: string): boolean {
  if (METADATA_IPS.has(ip)) return true;
  if (isIP(ip) === 4) {
    return inV4(ip, '0.0.0.0', 8) || inV4(ip, '169.254.0.0', 16) || inV4(ip, '224.0.0.0', 4) || inV4(ip, '240.0.0.0', 4) || ip === '255.255.255.255' || inV4(ip, '100.64.0.0', 10);
  }
  // ::, lien local fe80::/10, site-local obsolete fec0::/10, multidiffusion, metadonnees AWS, NAT64 d'usage local 64:ff9b:1::/48
  return ip === '::' || /^fe[89abcdef]/.test(ip) || ip.startsWith('ff') || ip.startsWith('fd00:ec2:') || ip.startsWith('64:ff9b:1:');
}

const isLoopback = (ip: string) => (isIP(ip) === 4 ? inV4(ip, '127.0.0.0', 8) : ip === '::1');
const isPrivate = (ip: string) => (isIP(ip) === 4 ? inV4(ip, '10.0.0.0', 8) || inV4(ip, '172.16.0.0', 12) || inV4(ip, '192.168.0.0', 16) : /^f[cd]/.test(ip));
function inCidr(ip: string, c: { base: number; bits: number }): boolean {
  const mask = (0xffffffff << (32 - c.bits)) >>> 0;
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((c.base & mask) >>> 0);
}
const inList = (ip: string, allow: HttpAllow) => allow.ips.has(ip) || (isIP(ip) === 4 && allow.cidrs.some((c) => inCidr(ip, c)));
const listEmpty = (allow: HttpAllow) => allow.names.size === 0 && allow.ips.size === 0 && allow.cidrs.length === 0;

/**
 * Adresse (deja resolue) autorisee ? `byName` : le nom de l'URL figure dans la liste.
 * Un nom autorise ne rend PAS acceptable n'importe quelle adresse : celle qu'il designe doit rester privee (RFC 1918 / ULA),
 * sauf si la liste la nomme elle-meme (adresse litterale ou bloc). Sinon un nom qui se met a pointer vers Internet recevrait
 * les ordres et l'en-tete secret (rebinding).
 */
export function addressAllowed(rawIp: string, allow: HttpAllow, byName: boolean): boolean {
  const ip = normalizeIp(rawIp);
  if (!isIP(ip) || alwaysForbidden(ip)) return false;
  if (isLoopback(ip)) return inList(ip, allow); // jamais par defaut, jamais via un nom : seulement nommee telle quelle
  if (listEmpty(allow)) return isPrivate(ip);
  return inList(ip, allow) || (byName && isPrivate(ip));
}

/** Controle statique d'une URL (configuration) : renvoie un motif de refus, ou null. */
export function urlProblem(raw: string, allow: HttpAllow): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'adresse illisible';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'http:// ou https:// attendu';
  if (u.username || u.password) return "pas d'identifiant dans l'adresse (utiliser l'en-tete secret)";
  if (u.hash) return "pas de fragment (#) dans l'adresse";
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (METADATA_NAMES.has(host)) return 'adresse de metadonnees refusee';
  if (isIP(host)) return addressAllowed(host, allow, false) ? null : 'adresse refusee (metadonnees, lien local, boucle locale ou hors de la liste autorisee)';
  return allow.names.has(host) ? null : 'nom refuse : seuls les noms listes dans PSIM_ACTUATOR_HTTP_HOSTS sont acceptes';
}

const originOf = (raw: string) => {
  const u = new URL(raw);
  return `${u.protocol}//${u.host}`;
};

/**
 * Validation de la configuration HTTP d'un actionneur (administrateur). `actions` : actions configurees ; chacune doit
 * avoir sa requete, toutes vers la meme origine.
 */
export function cleanHttpConfig(input: unknown, actions: string[], allow: HttpAllow): HttpTransportConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new PsimError(400, 'http : configuration attendue ({ requests: { <action>: { method, url, body? } } })');
  const o = input as Record<string, unknown>;
  const reqs = o.requests;
  if (reqs === null || typeof reqs !== 'object' || Array.isArray(reqs)) throw new PsimError(400, 'http.requests : une requete par action attendue');
  const out: Record<string, HttpRequestTemplate> = {};
  let origin: string | null = null;
  for (const action of actions) {
    // Object.hasOwn : "constructor", "toString"... ne sont jamais des requetes configurees (cles heritees d'Object.prototype)
    const r = Object.hasOwn(reqs, action) ? (reqs as Record<string, unknown>)[action] : undefined;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) throw new PsimError(400, `http.requests.${action} : requete manquante`);
    const { method, url, body } = r as Record<string, unknown>;
    if (method !== 'GET' && method !== 'POST' && method !== 'PUT') throw new PsimError(400, `http.requests.${action}.method : GET, POST ou PUT`);
    if (typeof url !== 'string' || url.length > 500) throw new PsimError(400, `http.requests.${action}.url : 500 caracteres au plus`);
    for (const m of url.matchAll(/\{([A-Za-z]+)\}/g)) if (!PLACEHOLDERS.has(m[1])) throw new PsimError(400, `http.requests.${action} : variable inconnue {${m[1].slice(0, 20)}}`);
    const problem = urlProblem(url.replace(/\{[A-Za-z]+\}/g, '0'), allow);
    if (problem) throw new PsimError(400, `http.requests.${action}.url : ${problem}`);
    const o2 = originOf(url.replace(/\{[A-Za-z]+\}/g, '0'));
    if (origin !== null && o2 !== origin) throw new PsimError(400, 'http : toutes les requetes vont vers le meme equipement (meme hote et port)');
    origin = o2;
    if (body !== undefined && body !== null && body !== '') {
      if (typeof body !== 'string' || body.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body)) throw new PsimError(400, `http.requests.${action}.body : texte de 1000 caracteres au plus`);
      if (method === 'GET') throw new PsimError(400, `http.requests.${action} : pas de corps pour GET`);
      for (const m of body.matchAll(/\{([A-Za-z]+)\}/g)) if (!PLACEHOLDERS.has(m[1])) throw new PsimError(400, `http.requests.${action}.body : variable inconnue`);
      out[action] = { method, url, body };
    } else out[action] = { method, url };
  }
  const config: HttpTransportConfig = { requests: out };
  if (o.contentType !== undefined) {
    if (typeof o.contentType !== 'string' || !CONTENT_TYPES.has(o.contentType)) throw new PsimError(400, `http.contentType : ${[...CONTENT_TYPES].join(', ')}`);
    config.contentType = o.contentType;
  }
  if (o.secretHeader !== undefined && o.secretHeader !== null && o.secretHeader !== '') {
    if (typeof o.secretHeader !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(o.secretHeader) || FORBIDDEN_HEADERS.has(o.secretHeader.toLowerCase())) {
      throw new PsimError(400, "http.secretHeader : nom d'en-tete invalide (ex. Authorization)");
    }
    config.secretHeader = o.secretHeader;
  }
  return config;
}

export function cleanSecretValue(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new PsimError(400, "http.secretValue : valeur d'en-tete de 1 a 512 caracteres, sur une ligne");
  return value;
}

export type HttpOutcome =
  | { kind: 'acked'; status: number }
  /** Refus net du relais (code HTTP non 2xx, redirection comprise). */
  | { kind: 'rejected'; status: number }
  /** Requete jamais partie (adresse refusee, connexion refusee) : l'ordre n'a pas ete execute. */
  | { kind: 'not_delivered'; error: string }
  /** Requete partie, reponse absente (delai, coupure) : l'ordre a PU etre execute. */
  | { kind: 'uncertain'; error: string };

function fill(template: string, values: Record<string, string>, encode: boolean): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (_m, name: string) => {
    const v = Object.hasOwn(values, name) ? (values[name] ?? '') : '';
    return encode ? encodeURIComponent(v) : v;
  });
}

/**
 * Un seul appel, jamais rejoue. `values` : variables du gabarit (alphabets restreints, voir actuatorproto.ts).
 * N'echoue jamais : le resultat dit ce qui s'est passe.
 */
export function sendHttp(
  config: HttpTransportConfig,
  action: string,
  values: Record<string, string>,
  secretValue: string | null,
  allow: HttpAllow,
  timeoutMs: number,
): Promise<HttpOutcome> {
  return new Promise((resolve) => {
    const template = Object.hasOwn(config.requests, action) ? config.requests[action] : undefined;
    if (!template) return resolve({ kind: 'not_delivered', error: 'aucune requete configuree pour cette action' });
    const url = fill(template.url, values, true);
    const problem = urlProblem(url, allow);
    if (problem) return resolve({ kind: 'not_delivered', error: `adresse refusee : ${problem}` });
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const byName = allow.names.has(host.toLowerCase());
    const body = template.body ? fill(template.body, values, false) : null;
    const headers: Record<string, string> = { 'User-Agent': 'PSIM-commandes/1', Accept: '*/*' };
    if (body !== null) {
      headers['Content-Type'] = config.contentType ?? 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    if (config.secretHeader && secretValue) headers[config.secretHeader] = secretValue;
    let connected = false;
    let settled = false;
    let req: ClientRequest;
    const finish = (outcome: HttpOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req?.destroy();
      resolve(outcome);
    };
    // Resolution controlee : l'adresse REELLEMENT jointe est verifiee (un nom ne contourne pas la liste).
    const lookup = (hostname: string, options: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return cb(err, '', 4);
        const list = (addresses as LookupAddress[]).filter((a) => addressAllowed(a.address, allow, byName));
        if (list.length === 0) return cb(Object.assign(new Error('adresse resolue refusee'), { code: 'EACCES' }), '', 4);
        if ((options as { all?: boolean }).all) cb(null, list);
        else cb(null, list[0].address, list[0].family);
      });
    };
    const timer = setTimeout(() => finish(connected ? { kind: 'uncertain', error: `pas de reponse en ${timeoutMs} ms` } : { kind: 'not_delivered', error: `connexion impossible en ${timeoutMs} ms` }), timeoutMs);
    const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
    try {
      req = send(
        { protocol: u.protocol, hostname: host, port: u.port || undefined, path: `${u.pathname}${u.search}`, method: template.method, headers, agent: false, lookup: lookup as never },
        (res: IncomingMessage) => {
          let read = 0;
          res.on('data', (chunk: Buffer) => {
            read += chunk.length;
            if (read > MAX_RESPONSE_BYTES) res.destroy();
          });
          const status = res.statusCode ?? 0;
          const done = () => finish(status >= 200 && status < 300 ? { kind: 'acked', status } : { kind: 'rejected', status });
          res.on('end', done);
          res.on('close', done);
          res.on('error', done);
        },
      );
    } catch (err) {
      return finish({ kind: 'not_delivered', error: (err as Error).message.slice(0, 120) });
    }
    req.on('socket', (socket) => {
      socket.on(u.protocol === 'https:' ? 'secureConnect' : 'connect', () => (connected = true));
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      const text = err.code ?? err.message.slice(0, 80);
      finish(connected ? { kind: 'uncertain', error: `liaison coupee (${text})` } : { kind: 'not_delivered', error: `connexion impossible (${text})` });
    });
    req.end(body ?? undefined);
  });
}
