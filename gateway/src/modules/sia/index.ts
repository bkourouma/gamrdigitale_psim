/**
 * Module `sia` de la Passerelle GAMR : recepteur SIA DC-09 (SIA-DCS / Contact ID sur IP).
 *
 * La passerelle joue le role du recepteur de telesurveillance : les centrales d'alarme (Ajax, Paradox, Texecom,
 * Risco, DSC, Honeywell...) lui envoient leurs evenements en TCP ou UDP ; chaque evenement est traduit en message
 * PSIM (`ctx.emit`) PUIS acquitte. Sans acquittement, la centrale renvoie : rien n'est perdu si la passerelle tombe.
 *
 * Securite (ce module ecoute sur le reseau) : interface explicite, trames bornees, delai de lecture, connexions
 * bornees (total et par adresse), debit limite (par adresse et par compte), comptes inconnus refuses par une reponse
 * neutre, controle d'horodatage et anti-rejeu, chiffrement exigible par compte, journaux limites et sans cle.
 */
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createHash } from 'node:crypto';
import { createServer, isIP, type Server, type Socket } from 'node:net';
import type { DeviceMessage, GatewayModule, ModuleContext, ModuleFactory } from '../../module.ts';
import { translate, type Rule } from './codes.ts';
import { parseConfig, type AccountConfig, type SiaConfig } from './config.ts';
import {
  ackFrame,
  decryptBody,
  duhFrame,
  MAX_FRAME,
  nakFrame,
  parseCidData,
  parseInner,
  parseOuter,
  parseSiaData,
  TOKENS,
  type RawEvent,
} from './protocol.ts';

export { parseConfig } from './config.ts';

/** Ecart minimal entre deux signes de vie relayes au PSIM pour une meme centrale. */
const HEARTBEAT_MIN_MS = 30_000;
/** Un meme message de journal n'est repete qu'une fois par minute (le reste est compte). */
const LOG_EVERY_MS = 60_000;
/** Taille maximale de la memoire anti-rejeu. */
const MAX_SEEN = 20_000;
/** Taille maximale des tables par adresse (compteurs de debit). */
const MAX_BUCKETS = 4096;
/** Donnees en attente d'envoi au-dela desquelles un client qui ne lit pas est deconnecte. */
const MAX_PENDING_WRITE = 16 * 1024;

export interface SiaModule extends GatewayModule {
  /** Ports effectivement ouverts (utile quand le port configure est 0, en test). */
  addresses(): { tcp: number | null; udp: number | null };
}

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
    b.tokens = Math.min(this.perMinute, b.tokens + ((now - b.at) * this.perMinute) / 60_000);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

/** Retire les caracteres de controle et borne la longueur d'un texte venu du reseau avant de le journaliser. */
function clean(text: string, max = 64): string {
  const s = text.replace(/[^\x20-\x7e]/g, '?');
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function normalizeAddress(a: string | undefined): string {
  if (!a) return 'inconnue';
  return a.startsWith('::ffff:') ? a.slice(7) : a;
}

interface PanelState {
  lastSeen: number;
  lost: boolean;
  /** Ids mis en defaut par la perte de supervision (a retablir au retour). */
  faulted: Set<string>;
  lastHeartbeat: number;
}

export function create(config: Record<string, unknown>): SiaModule {
  const cfg: SiaConfig & { overrides: ReturnType<typeof parseConfig>['overrides'] } = parseConfig(config);

  let ctx: ModuleContext | null = null;
  let tcp: Server | null = null;
  let udp: UdpSocket | null = null;
  let timer: NodeJS.Timeout | null = null;
  let started = false;
  const sockets = new Set<Socket>();
  const perAddress = new Map<string, number>();
  const addressBuckets = new Buckets(cfg.limits.perAddressPerMinute);
  const accountBuckets = new Buckets(cfg.limits.perAccountPerMinute);
  /** Anti-rejeu : cle -> instant au-dela duquel l'entree peut etre oubliee. */
  const seen = new Map<string, number>();
  const panels = new Map<string, PanelState>();
  /** Ids PSIM en alarme d'apres les evenements recus (non ecrases par un defaut ni par la supervision). */
  const alarmed = new Set<string>();
  const logged = new Map<string, { at: number; hidden: number }>();
  const unknownCodes = new Set<string>();

  const now = () => (ctx ? ctx.now() : Date.now());

  function log(level: 'info' | 'warn' | 'error', text: string): void {
    try {
      ctx?.log(level, `[sia] ${text}`);
    } catch {
      // un journal defaillant ne doit pas arreter la reception
    }
  }

  /** Journalise au plus une fois par minute pour une meme cle (pas de saturation des journaux par un attaquant). */
  function logLimited(key: string, level: 'info' | 'warn' | 'error', text: string): void {
    const t = now();
    const prev = logged.get(key);
    if (prev && t - prev.at < LOG_EVERY_MS) {
      prev.hidden++;
      return;
    }
    if (logged.size >= 1000) logged.clear();
    logged.set(key, { at: t, hidden: 0 });
    log(level, prev && prev.hidden > 0 ? `${text} (${prev.hidden} message(s) semblable(s) non affiche(s))` : text);
  }

  function emit(deviceId: string, msg: DeviceMessage): void {
    (ctx as ModuleContext).emit(deviceId, msg);
  }

  function panelIds(a: AccountConfig): string[] {
    const ids = new Set<string>([...a.zones.values(), ...a.partitions.values()]);
    if (a.defaultId) ids.add(a.defaultId);
    return [...ids];
  }

  function panelState(a: AccountConfig): PanelState {
    let p = panels.get(a.account);
    if (!p) {
      p = { lastSeen: now(), lost: false, faulted: new Set(), lastHeartbeat: -Infinity };
      panels.set(a.account, p);
    }
    return p;
  }

  /** Id PSIM d'un evenement : zone exacte, zone *, partition, partition *, defaultId. */
  function resolve(a: AccountConfig, rule: Rule, ev: RawEvent): string | null {
    if (rule.zone && ev.zone !== null) {
      const z = a.zones.get(ev.zone) ?? a.zones.get('*');
      if (z) return z;
    }
    if (ev.partition !== null) {
      const p = a.partitions.get(ev.partition);
      if (p) return p;
    }
    return a.partitions.get('*') ?? a.defaultId;
  }

  /** Signe de vie de la centrale relaye a tous ses equipements PSIM (au plus toutes les 30 s). */
  function heartbeat(a: AccountConfig, p: PanelState): void {
    if (!cfg.forwardHeartbeat) return;
    const t = now();
    if (t - p.lastHeartbeat < HEARTBEAT_MIN_MS) return;
    p.lastHeartbeat = t;
    for (const id of panelIds(a)) emit(id, { event: 'heartbeat' });
  }

  /** Trame valide recue : la centrale est vivante ; si elle etait perdue, ses equipements redeviennent normaux. */
  function markSeen(a: AccountConfig, p: PanelState): void {
    p.lastSeen = now();
    if (!p.lost) return;
    p.lost = false;
    log('info', `${a.panelName} (compte ${a.account}) de nouveau en liaison`);
    for (const id of p.faulted) if (!alarmed.has(id)) emit(id, { state: 'normal' });
    p.faulted.clear();
  }

  function checkSupervision(): void {
    const t = now();
    for (const a of cfg.accounts.values()) {
      if (a.supervisionMs <= 0) continue;
      const p = panelState(a);
      if (p.lost || t - p.lastSeen <= a.supervisionMs) continue;
      p.lost = true;
      log('warn', `${a.panelName} (compte ${a.account}) : aucune trame depuis ${Math.round((t - p.lastSeen) / 1000)} s, equipements en defaut`);
      for (const id of panelIds(a)) {
        if (alarmed.has(id)) continue; // une alarme en cours n'est jamais masquee par un defaut de liaison
        p.faulted.add(id);
        emit(id, { state: 'fault' });
      }
    }
  }

  function remember(key: string, until: number): void {
    if (seen.size >= MAX_SEEN) {
      const t = now();
      for (const [k, exp] of seen) if (exp < t) seen.delete(k);
      while (seen.size >= MAX_SEEN) seen.delete(seen.keys().next().value as string);
    }
    seen.set(key, until);
  }

  function isSeen(key: string): boolean {
    const exp = seen.get(key);
    if (exp === undefined) return false;
    if (exp < now()) {
      seen.delete(key);
      return false;
    }
    return true;
  }

  /** Traduit et transmet les evenements d'une trame. Leve si `ctx.emit` leve (la trame n'est alors pas acquittee). */
  function deliver(a: AccountConfig, p: PanelState, events: RawEvent[], ts: number | null, idBase: string): void {
    const overrides = [a.overrides, cfg.overrides];
    let n = 0;
    for (const ev of events) {
      const rule = translate(ev, overrides);
      const what = ev.format === 'sia' ? `SIA ${ev.code}` : `Contact ID ${ev.qualifier === 'R' ? 3 : ev.qualifier === 'P' ? 6 : 1}${ev.code}`;
      if (!rule) {
        const key = `${ev.format}:${ev.code}`;
        if (!unknownCodes.has(key) && unknownCodes.size < 500) {
          unknownCodes.add(key);
          log('warn', `${a.panelName} : code ${what} inconnu, ignore (a ajouter dans overrides si besoin)`);
        }
        continue;
      }
      if (rule.kind === 'ignore') continue;
      if (rule.kind === 'heartbeat') {
        heartbeat(a, p);
        continue;
      }
      const id = resolve(a, rule, ev);
      if (!id) {
        logLimited(`nomap:${a.account}:${ev.zone}:${ev.partition}`, 'warn', `${a.panelName} : ${what} (${rule.label}) zone ${ev.zone ?? '-'} partition ${ev.partition ?? '-'} sans equipement PSIM, ignore`);
        continue;
      }
      if ((rule.kind === 'fault' || rule.kind === 'restore-fault') && alarmed.has(id)) {
        logLimited(`masked:${id}:${ev.code}`, 'info', `${a.panelName} : ${what} (${rule.label}) non transmis, ${id} est en alarme`);
        continue;
      }
      if (rule.kind === 'alarm') alarmed.add(id);
      if (rule.kind === 'restore-alarm') alarmed.delete(id);
      const msg: DeviceMessage = { ...rule.out, msgId: n === 0 ? idBase : `${idBase}-${n}` };
      if (ts !== null) msg.ts = ts;
      n++;
      emit(id, msg);
    }
  }

  /** Traite une trame (octets entre LF et CR) ; renvoie la reponse a envoyer, ou `null` (pas de reponse). */
  function handleFrame(raw: Buffer, from: string): string | null {
    const t = now();
    const outer = parseOuter(raw);
    if (!outer.ok) {
      logLimited(`bad:${from}`, 'warn', `trame refusee depuis ${from} : ${outer.reason}`);
      return outer.reply === 'nak' ? nakFrame(t) : outer.reply === 'duh' ? duhFrame(null, t) : null;
    }
    const h = outer.header;
    const a = cfg.accounts.get(h.account);
    if (!a) {
      // Reponse neutre (la meme que pour une erreur de transmission) : pas d'indice sur les comptes existants.
      logLimited(`unknown:${from}`, 'warn', `compte inconnu ${h.account} depuis ${from}, refuse`);
      return nakFrame(t);
    }
    if (!TOKENS.has(h.token)) {
      logLimited(`token:${from}`, 'warn', `${a.panelName} : format ${clean(h.token)} non pris en charge (SIA-DCS, ADM-CID, NULL)`);
      return duhFrame(h, t);
    }
    if (h.encrypted && !a.key) {
      logLimited(`nokey:${a.account}`, 'warn', `${a.panelName} : trame chiffree mais aucune cle configuree pour le compte ${a.account}`);
      return nakFrame(t);
    }
    if (!h.encrypted && a.requireEncryption) {
      logLimited(`clear:${a.account}:${from}`, 'warn', `${a.panelName} : trame en clair refusee depuis ${from} (le compte ${a.account} exige le chiffrement)`);
      return nakFrame(t);
    }
    let body = h.body;
    if (h.encrypted) {
      const plain = decryptBody(h.body, a.key as Buffer);
      if (plain === null) {
        logLimited(`decrypt:${a.account}:${from}`, 'warn', `${a.panelName} : dechiffrement impossible depuis ${from} (cle differente de celle de la centrale ?)`);
        return nakFrame(t);
      }
      body = plain;
    }
    const inner = parseInner(body);
    if (!inner.ok) {
      // Chiffre : une trame illisible apres dechiffrement est le signe d'une mauvaise cle -> NAK, comme ci-dessus.
      logLimited(`inner:${a.account}:${from}`, 'warn', `${a.panelName} : trame illisible depuis ${from} (${inner.reason})`);
      return h.encrypted ? nakFrame(t) : duhFrame(h, t);
    }
    const { ts, data } = inner.inner;
    if (ts === null) {
      if (h.encrypted || !a.allowMissingTimestamp) {
        logLimited(`nots:${a.account}`, 'warn', `${a.panelName} : trame sans horodatage refusee (activer l'horodatage sur la centrale)`);
        return nakFrame(t);
      }
    } else if (Math.abs(ts - t) > cfg.maxClockSkewMs) {
      logLimited(`skew:${a.account}`, 'warn', `${a.panelName} : horodatage hors fenetre (ecart ${Math.round((ts - t) / 1000)} s) ; verifier l'heure de la centrale (NTP)`);
      return nakFrame(t);
    }

    let events: RawEvent[] = [];
    if (h.token !== 'NULL') {
      const parsed = h.token === 'SIA-DCS' ? parseSiaData(data, h.account) : parseCidData(data, h.account);
      if (!parsed.ok) {
        logLimited(`data:${a.account}`, 'warn', `${a.panelName} : donnees ${h.token} non comprises (${parsed.reason})`);
        return duhFrame(h, t);
      }
      events = parsed.events;
    }

    // Anti-rejeu : meme (compte, sequence, horodatage) -> deja traite : on acquitte sans re-emettre. Pour une trame
    // chiffree, aussi meme chiffre au meme instant : la sequence circule en clair et pourrait etre changee sur une
    // trame capturee (le bourrage aleatoire rend deux trames legitimes toujours differentes). Pas pour le clair : deux
    // evenements identiques dans la meme seconde y sont possibles, et un attaquant peut de toute facon tout forger.
    const digest = createHash('sha256').update(h.token).update('\0').update(h.body).digest('hex').slice(0, 24);
    const stamp = inner.inner.tsText ?? `sans-horodatage-${digest}`;
    const k1 = `${a.account}|${h.seq}|${stamp}`;
    const k2 = h.encrypted ? `${a.account}|${stamp}|${digest}` : null;
    const ack = ackFrame(h, t, h.encrypted ? a.key : null);
    if (isSeen(k1) || (k2 !== null && isSeen(k2))) return ack;

    if (!accountBuckets.take(a.account, t)) {
      logLimited(`rate:${a.account}`, 'warn', `${a.panelName} : debit trop eleve, trames ignorees (la centrale les renverra)`);
      return null;
    }

    const p = panelState(a);
    try {
      markSeen(a, p);
      if (h.token === 'NULL') heartbeat(a, p);
      else deliver(a, p, events, ts, `${a.account}-${h.seq}-${ts ?? digest.slice(0, 12)}`);
    } catch (err) {
      // Le socle n'a pas pris le message : pas d'acquittement, la centrale renverra.
      logLimited(`emit:${a.account}`, 'error', `${a.panelName} : transmission au PSIM impossible (${clean(err instanceof Error ? err.message : String(err), 120)})`);
      return null;
    }
    const keep = t + 2 * cfg.maxClockSkewMs + 60_000;
    remember(k1, keep);
    if (k2 !== null) remember(k2, keep);
    return ack;
  }

  function onConnection(sock: Socket): void {
    const from = normalizeAddress(sock.remoteAddress);
    const count = perAddress.get(from) ?? 0;
    if (!started || sockets.size >= cfg.limits.maxConnections || count >= cfg.limits.maxConnectionsPerAddress) {
      logLimited(`conn:${from}`, 'warn', `connexion refusee depuis ${from} (trop de connexions simultanees)`);
      sock.destroy();
      return;
    }
    let buf: Buffer = Buffer.alloc(0);
    let junk = 0;
    let frameTimer: NodeJS.Timeout | null = null;
    sockets.add(sock);
    perAddress.set(from, count + 1);
    sock.setNoDelay(true);
    sock.on('error', () => {
      /* connexion coupee par la centrale : sans consequence */
    });
    sock.on('close', () => {
      sockets.delete(sock);
      const c = (perAddress.get(from) ?? 1) - 1;
      if (c <= 0) perAddress.delete(from);
      else perAddress.set(from, c);
      if (frameTimer) clearTimeout(frameTimer);
    });
    sock.setTimeout(cfg.limits.idleTimeoutMs, () => sock.destroy());

    const armFrameTimer = () => {
      if (frameTimer) return;
      // Anti-lenteur : une trame commencee doit etre complete dans le delai, quel que soit le rythme des octets.
      frameTimer = setTimeout(() => {
        logLimited(`slow:${from}`, 'warn', `connexion lente fermee (${from})`);
        sock.destroy();
      }, cfg.limits.frameTimeoutMs);
    };
    const clearFrameTimer = () => {
      if (frameTimer) clearTimeout(frameTimer);
      frameTimer = null;
    };

    sock.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      while (buf.length > 0 && !sock.destroyed) {
        const lf = buf.indexOf(0x0a);
        if (lf < 0) {
          junk += buf.length;
          buf = Buffer.alloc(0);
          break;
        }
        if (lf > 0) {
          junk += lf;
          buf = buf.subarray(lf);
        }
        const cr = buf.indexOf(0x0d);
        if (cr < 0) {
          if (buf.length > MAX_FRAME) {
            logLimited(`big:${from}`, 'warn', `trame trop longue depuis ${from}, connexion fermee`);
            sock.destroy();
            return;
          }
          break;
        }
        // Une trame interrompue puis recommencee : on repart du dernier LF avant le CR.
        const start = buf.lastIndexOf(0x0a, cr);
        junk += start;
        const raw = buf.subarray(start + 1, cr);
        buf = buf.subarray(cr + 1);
        clearFrameTimer();
        if (raw.length + 2 > MAX_FRAME) {
          logLimited(`big:${from}`, 'warn', `trame trop longue depuis ${from}, connexion fermee`);
          sock.destroy();
          return;
        }
        if (!addressBuckets.take(from, now())) {
          logLimited(`rate:${from}`, 'warn', `debit trop eleve depuis ${from}, trames ignorees`);
          continue;
        }
        const res = handleFrame(Buffer.from(raw), from);
        if (res !== null) sock.write(res, 'latin1');
        if (sock.writableLength > MAX_PENDING_WRITE) {
          sock.destroy();
          return;
        }
      }
      if (junk > MAX_FRAME) {
        logLimited(`junk:${from}`, 'warn', `donnees hors protocole depuis ${from}, connexion fermee`);
        sock.destroy();
        return;
      }
      if (buf.length > 0) armFrameTimer();
      else clearFrameTimer();
    });
  }

  function onDatagram(msg: Buffer, rinfo: { address: string; port: number }): void {
    if (!started || msg.length > MAX_FRAME || msg.length < 10) return;
    const from = normalizeAddress(rinfo.address);
    if (!addressBuckets.take(from, now())) {
      logLimited(`rate:${from}`, 'warn', `debit trop eleve depuis ${from}, datagrammes ignores`);
      return;
    }
    let s = 0;
    let e = msg.length;
    if (msg[s] === 0x0a) s++;
    if (msg[e - 1] === 0x0d) e--;
    const res = handleFrame(Buffer.from(msg.subarray(s, e)), from);
    // Pas d'amplification : une reponse UDP n'est jamais nettement plus longue que la requete (adresse usurpee).
    if (res === null || res.length > msg.length + 16 || !udp) return;
    udp.send(Buffer.from(res, 'latin1'), rinfo.port, rinfo.address, () => {});
  }

  const mod: SiaModule = {
    name: 'sia',
    async start(c: ModuleContext): Promise<void> {
      if (started || ctx) throw new Error('module sia deja demarre');
      ctx = c;
      started = true;
      const t = now();
      for (const a of cfg.accounts.values()) panels.set(a.account, { lastSeen: t, lost: false, faulted: new Set(), lastHeartbeat: -Infinity });
      try {
        if (cfg.protocols.tcp) {
          const server = createServer({ noDelay: true }, onConnection);
          tcp = server;
          await new Promise<void>((resolveListen, reject) => {
            server.once('error', reject);
            server.listen({ host: cfg.host, port: cfg.port, exclusive: true }, () => {
              server.off('error', reject);
              resolveListen();
            });
          });
          server.on('error', (err) => log('error', `serveur TCP : ${clean(err.message, 120)}`));
        }
        if (cfg.protocols.udp) {
          const sock = createSocket({ type: isIP(cfg.host) === 6 ? 'udp6' : 'udp4' });
          udp = sock;
          await new Promise<void>((resolveBind, reject) => {
            sock.once('error', reject);
            sock.bind({ address: cfg.host, port: cfg.port, exclusive: true }, () => {
              sock.off('error', reject);
              resolveBind();
            });
          });
          sock.on('error', (err) => log('error', `socket UDP : ${clean(err.message, 120)}`));
          sock.on('message', onDatagram);
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
        await mod.stop();
        throw new Error(`module sia : ecoute impossible sur ${cfg.host}:${cfg.port} (${code})`);
      }
      const supervised = [...cfg.accounts.values()].filter((a) => a.supervisionMs > 0).map((a) => a.supervisionMs);
      if (supervised.length > 0) {
        const tick = Math.min(5000, Math.max(100, Math.floor(Math.min(...supervised) / 5)));
        timer = setInterval(checkSupervision, tick);
        timer.unref();
      }
      const proto = [cfg.protocols.tcp ? 'TCP' : '', cfg.protocols.udp ? 'UDP' : ''].filter(Boolean).join(' + ');
      log('info', `recepteur SIA DC-09 a l'ecoute sur ${cfg.host}:${cfg.port} (${proto}), ${cfg.accounts.size} centrale(s)`);
    },
    async stop(): Promise<void> {
      started = false;
      if (timer) clearInterval(timer);
      timer = null;
      for (const s of sockets) s.destroy();
      sockets.clear();
      perAddress.clear();
      const closing: Promise<void>[] = [];
      if (tcp) {
        const server = tcp;
        closing.push(new Promise((r) => server.close(() => r())));
      }
      if (udp) {
        const sock = udp;
        closing.push(
          new Promise((r) => {
            try {
              sock.close(() => r());
            } catch {
              r();
            }
          }),
        );
      }
      tcp = null;
      udp = null;
      await Promise.all(closing);
      ctx = null;
    },
    addresses() {
      const t = tcp?.address();
      let u: number | null = null;
      try {
        u = udp ? udp.address().port : null;
      } catch {
        u = null;
      }
      return { tcp: t && typeof t === 'object' ? t.port : null, udp: u };
    },
  };
  return mod;
}

create satisfies ModuleFactory;
