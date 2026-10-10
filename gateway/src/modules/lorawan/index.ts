import type { DeviceMessage, GatewayModule, ModuleContext, ModuleFactory, MqttLink } from '../../module.ts';
import { parseConfig } from './config.ts';
import type { BoolRule, DeviceConfig, Emit, EnumRule, LorawanConfig, NumberRule, Rule } from './config.ts';

/**
 * Module « lorawan » : capteurs LoRaWAN (reseau gere par ChirpStack v4) -> PSIM.
 *
 * ChirpStack publie sur SON broker MQTT : application/<appId>/device/<devEui>/event/<up|status|join>.
 * Ce module s'y abonne (devEui declares uniquement, jamais « # »), lit le JSON, applique les regles de
 * traduction configurees (ou un profil predefini) et envoie des messages au PSIM via `ctx.emit`.
 *
 * Garanties :
 *  - charge bornee (64 Kio), JSON invalide ignore et journalise ; chemins surs (jamais d'eval) ;
 *  - une retransmission reseau (meme fCnt) n'est traitee qu'une fois ; msgId deterministe <devEui>-<fCnt>-<champ> ;
 *  - pas d'inondation : bande morte, delai minimal par regle, plafond par capteur ;
 *  - chaque trame valide sans autre message produit un `heartbeat` (le PSIM surveille ainsi le silence).
 */

const MAX_PAYLOAD_BYTES = 64 * 1024;
const SEEN_FCNT_MAX = 64;
const WARN_EVERY_MS = 60_000;
const MAX_MESSAGES_PER_MINUTE = 60;
/** Une heure de trame plus de 5 minutes dans le futur n'est pas crue : on prend l'heure de la passerelle. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;
/** Avant l'an 2000 : horloge de capteur non reglee, on ne la croit pas. */
const MIN_PLAUSIBLE_TS = 946_684_800_000;
const EVENT_KINDS = new Set(['up', 'status', 'join']);

interface RuleState {
  /** Derniere condition / valeur vue (pour ne reagir qu'au changement). */
  prev: boolean | string | null;
  lastSent: number | null;
  lastAt: number | null;
}

interface DeviceState {
  seen: Set<number>;
  rules: RuleState[];
  statusLow: boolean | null;
  windowStart: number;
  windowCount: number;
}

interface Pending {
  key: string;
  emit: Emit;
  value?: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Lit un chemin dans `object` : proprietes propres uniquement, indices de tableau bornes. */
export function lookup(root: unknown, path: readonly string[]): unknown {
  let cur = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d{1,3}$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
      continue;
    }
    if (!Object.hasOwn(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 0 || v === 1) return v === 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return undefined;
}

const NUMBER_TEXT_RE = /^\s*(-?\d+(?:\.\d+)?)\s*[A-Za-z%°µ/]{0,6}\s*$/;

/** Nombre, ou texte « 430 mm » / « 21.5 » (certains codecs ajoutent l'unite). */
function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.length <= 24) {
    const m = NUMBER_TEXT_RE.exec(v);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function toEnumKey(v: unknown): string | undefined {
  if (typeof v === 'string') return v.length <= 64 ? v : undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return undefined;
}

function conditionHolds(rule: NumberRule, x: number, wasActive: boolean): boolean {
  // Hysteresis : une fois actif, on ne repasse a l'etat repos qu'apres avoir depasse le seuil de `hysteresis`.
  const t = rule.threshold;
  const h = wasActive ? rule.hysteresis : 0;
  switch (rule.when) {
    case 'above': return x > t - h;
    case 'atLeast': return x >= t - h;
    case 'below': return x < t + h;
    case 'atMost': return x <= t + h;
    default: return false;
  }
}

export const create: ModuleFactory = (rawConfig): GatewayModule => {
  const cfg: LorawanConfig = parseConfig(rawConfig);
  const states = new Map<string, DeviceState>();
  let ctx: ModuleContext | null = null;
  let link: MqttLink | null = null;
  let stopped = false;
  const warnings = new Map<string, { at: number; n: number }>();

  function stateOf(dev: DeviceConfig): DeviceState {
    let st = states.get(dev.eui);
    if (!st) {
      st = {
        seen: new Set(),
        rules: dev.rules.map(() => ({ prev: null, lastSent: null, lastAt: null })),
        statusLow: null,
        windowStart: 0,
        windowCount: 0,
      };
      states.set(dev.eui, st);
    }
    return st;
  }

  /** Avertissement limite a un par minute et par (capteur, nature) : un capteur defaillant n'inonde pas le journal. */
  function warn(category: string, eui: string, text: string): void {
    if (!ctx) return;
    const k = `${eui}:${category}`;
    const t = ctx.now();
    const s = warnings.get(k);
    if (s && t - s.at < WARN_EVERY_MS) {
      s.n += 1;
      return;
    }
    ctx.log('warn', `lorawan ${eui} : ${text}${s && s.n > 0 ? ` (+${s.n} similaires)` : ''}`);
    warnings.set(k, { at: t, n: 0 });
  }

  function rateOk(rule: Rule, st: RuleState, nowMs: number): boolean {
    return rule.minIntervalMs === 0 || st.lastAt === null || nowMs - st.lastAt >= rule.minIntervalMs;
  }

  // ---- Evaluation d'une regle sur une trame : renvoie le message a emettre, ou null ----

  function evalBool(rule: BoolRule, st: RuleState, raw: unknown, nowMs: number, eui: string): Pending | null {
    const v = toBool(raw);
    if (v === undefined) {
      warn(`bad:${rule.key}`, eui, `champ « ${rule.key} » : valeur non booleenne ignoree`);
      return null;
    }
    const cond = v === rule.equals;
    if (st.prev === cond && !rule.repeat) return null;
    const branch = cond ? rule.emit : rule.emitElse;
    if (!branch) {
      st.prev = cond;
      return null;
    }
    if (!rateOk(rule, st, nowMs)) return null;
    st.prev = cond;
    st.lastAt = nowMs;
    return { key: rule.key, emit: branch };
  }

  function evalEnum(rule: EnumRule, st: RuleState, raw: unknown, nowMs: number, eui: string): Pending | null {
    const k = toEnumKey(raw);
    if (k === undefined) {
      warn(`bad:${rule.key}`, eui, `champ « ${rule.key} » : valeur non reconnue ignoree`);
      return null;
    }
    if (st.prev === k && !rule.repeat) return null;
    const branch = rule.map.get(k);
    if (!branch) {
      st.prev = k;
      return null;
    }
    if (!rateOk(rule, st, nowMs)) return null;
    st.prev = k;
    st.lastAt = nowMs;
    return { key: rule.key, emit: branch };
  }

  function evalNumber(rule: NumberRule, st: RuleState, raw: unknown, nowMs: number, eui: string): Pending | null {
    const n = toNumber(raw);
    if (n === undefined) {
      warn(`bad:${rule.key}`, eui, `champ « ${rule.key} » : valeur non numerique ignoree`);
      return null;
    }
    let x = n * rule.scale + rule.offset;
    if (rule.accept && (x < rule.accept[0] || x > rule.accept[1])) {
      warn(`range:${rule.key}`, eui, `champ « ${rule.key} » : valeur ${x} hors plage, ignoree`);
      return null;
    }
    if (rule.clamp) x = Math.min(rule.clamp[1], Math.max(rule.clamp[0], x));
    x = Math.round(x * 1000) / 1000;

    if (rule.when === null) {
      // Mesure : bande morte + delai minimal.
      if (st.lastSent !== null && Math.abs(x - st.lastSent) < rule.deadband) return null;
      if (!rateOk(rule, st, nowMs)) return null;
      st.lastSent = x;
      st.lastAt = nowMs;
      return { key: rule.key, emit: rule.emit ?? { value: true }, value: x };
    }

    const cond = conditionHolds(rule, x, st.prev === true);
    if (st.prev === cond) return null;
    const branch = cond ? rule.emit : rule.emitElse;
    if (!branch) {
      st.prev = cond;
      return null;
    }
    if (!rateOk(rule, st, nowMs)) return null;
    st.prev = cond;
    st.lastAt = nowMs;
    return branch.value ? { key: rule.key, emit: branch, value: x } : { key: rule.key, emit: branch };
  }

  // ---- Envoi ----

  function send(dev: DeviceConfig, tag: string, ts: number, p: Pending): void {
    if (!ctx) return;
    const msg: DeviceMessage = { ts, msgId: `${dev.eui}-${tag}-${p.key}` };
    if (p.emit.state !== undefined) msg.state = p.emit.state;
    if (p.emit.event !== undefined) msg.event = p.emit.event;
    if (p.value !== undefined && p.emit.value === true) msg.value = p.value;
    try {
      ctx.emit(dev.id, msg);
    } catch (err) {
      // emit ne doit jamais lever ; si le socle le fait malgre le contrat, on ne perd pas le module.
      ctx.log('error', `lorawan ${dev.eui} : envoi impossible (${(err as Error).message})`);
    }
  }

  function overRate(st: DeviceState, nowMs: number): boolean {
    if (nowMs - st.windowStart >= 60_000) {
      st.windowStart = nowMs;
      st.windowCount = 0;
    }
    st.windowCount += 1;
    return st.windowCount > MAX_MESSAGES_PER_MINUTE;
  }

  function frameTime(time: unknown, nowMs: number): { ts: number; fromFrame: boolean } {
    if (typeof time === 'string' && time.length <= 40) {
      const parsed = Date.parse(time);
      if (Number.isFinite(parsed) && parsed >= MIN_PLAUSIBLE_TS && parsed <= nowMs + FUTURE_TOLERANCE_MS) {
        return { ts: Math.trunc(parsed), fromFrame: true };
      }
    }
    return { ts: Math.trunc(nowMs), fromFrame: false };
  }

  // ---- Traitement des trois types d'evenements ChirpStack ----

  function handleUp(dev: DeviceConfig, body: Record<string, unknown>, nowMs: number): void {
    const st = stateOf(dev);
    let fCnt = 0; // ChirpStack omet fCnt quand il vaut 0 (JSON proto3)
    if (body.fCnt !== undefined) {
      if (typeof body.fCnt !== 'number' || !Number.isInteger(body.fCnt) || body.fCnt < 0 || body.fCnt > 0xffffffff) {
        warn('fcnt', dev.eui, 'fCnt invalide, trame ignoree');
        return;
      }
      fCnt = body.fCnt;
    }
    if (st.seen.has(fCnt)) return; // retransmission reseau : deja traitee
    st.seen.add(fCnt);
    if (st.seen.size > SEEN_FCNT_MAX) {
      const oldest = st.seen.values().next().value;
      if (oldest !== undefined) st.seen.delete(oldest);
    }

    const { ts, fromFrame } = frameTime(body.time, nowMs);
    if (cfg.staleAfterS > 0 && fromFrame && nowMs - ts > cfg.staleAfterS * 1000) {
      ctx?.log('info', `lorawan ${dev.eui} : trame ${fCnt} datee de plus de ${cfg.staleAfterS} s, ignoree`);
      return;
    }
    if (overRate(st, nowMs)) {
      warn('rate', dev.eui, 'trop de messages (plus de 60 par minute), trame ignoree');
      return;
    }

    const object = body.object;
    if (!isObj(object)) {
      warn('noobject', dev.eui, "trame sans objet decode : verifiez le codec de l'appareil dans ChirpStack");
    }

    const tag = String(fCnt);
    let sent = 0;
    if (isObj(object)) {
      dev.rules.forEach((rule, i) => {
        const raw = lookup(object, rule.path);
        if (raw === undefined || raw === null) return;
        const rs = st.rules[i]!;
        const pending =
          rule.type === 'bool' ? evalBool(rule, rs, raw, nowMs, dev.eui)
          : rule.type === 'enum' ? evalEnum(rule, rs, raw, nowMs, dev.eui)
          : evalNumber(rule, rs, raw, nowMs, dev.eui);
        if (pending) {
          send(dev, tag, ts, pending);
          sent += 1;
        }
      });
    }
    // Aucun autre message : la trame prouve quand meme que le capteur est vivant.
    if (sent === 0) send(dev, tag, ts, { key: 'heartbeat', emit: { event: 'heartbeat' } });
  }

  function handleStatus(dev: DeviceConfig, body: Record<string, unknown>, nowMs: number): void {
    const st = stateOf(dev);
    const { ts } = frameTime(body.time, nowMs);
    if (overRate(st, nowMs)) return;
    const tag = `status-${ts}`;
    let sent = 0;
    const level = body.batteryLevel;
    if (body.externalPowerSource !== true && body.batteryLevelUnavailable !== true && typeof level === 'number' && Number.isFinite(level) && level >= 0 && level <= 100) {
      const low = st.statusLow === true ? level <= cfg.lowBatteryPercent + 3 : level <= cfg.lowBatteryPercent;
      if (low !== st.statusLow) {
        st.statusLow = low;
        if (low) {
          send(dev, tag, ts, { key: 'battery', emit: { event: 'low_battery' } });
          sent += 1;
        }
      }
    }
    if (sent === 0) send(dev, tag, ts, { key: 'heartbeat', emit: { event: 'heartbeat' } });
  }

  function handleJoin(dev: DeviceConfig, body: Record<string, unknown>, nowMs: number): void {
    const st = stateOf(dev);
    const { ts } = frameTime(body.time, nowMs);
    // Nouvelle session : le compteur de trames repart de zero, l'historique anti-doublon n'a plus de sens.
    st.seen.clear();
    send(dev, `join-${ts}`, ts, { key: 'heartbeat', emit: { event: 'heartbeat' } });
  }

  // ---- Reception ----

  function onMessage(topic: string, payload: Buffer): void {
    if (stopped || !ctx) return;
    const parts = topic.split('/');
    // application/<appId>/device/<devEui>/event/<type>
    if (parts.length !== 6 || parts[0] !== 'application' || parts[2] !== 'device' || parts[4] !== 'event') return;
    const appId = parts[1]!;
    const eui = parts[3]!.toLowerCase();
    const kind = parts[5]!;
    if (!EVENT_KINDS.has(kind)) return;
    if (cfg.applicationId !== '+' && appId !== cfg.applicationId) return;
    const dev = cfg.devices.get(eui);
    if (!dev) return;

    if (payload.length > MAX_PAYLOAD_BYTES) {
      warn('size', eui, `message trop gros (${payload.length} octets), ignore`);
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(payload.toString('utf8'));
    } catch {
      warn('json', eui, 'JSON invalide, message ignore');
      return;
    }
    if (!isObj(body)) {
      warn('json', eui, "le message n'est pas un objet JSON, ignore");
      return;
    }
    // Le devEui du contenu doit correspondre a celui du topic : sinon message incoherent, on ne l'attribue a personne.
    const info = body.deviceInfo;
    if (isObj(info) && info.devEui !== undefined) {
      if (typeof info.devEui !== 'string' || info.devEui.toLowerCase() !== eui) {
        warn('deveui', eui, 'devEui du contenu different de celui du topic, message ignore');
        return;
      }
    }
    const nowMs = ctx.now();
    if (kind === 'up') handleUp(dev, body, nowMs);
    else if (kind === 'status') handleStatus(dev, body, nowMs);
    else handleJoin(dev, body, nowMs);
  }

  function safeOnMessage(topic: string, payload: Buffer): void {
    try {
      onMessage(topic, payload);
    } catch (err) {
      // Un message mal forme ne doit jamais arreter le module.
      ctx?.log('error', `lorawan : erreur de traitement (${(err as Error).message})`);
    }
  }

  return {
    name: 'lorawan',

    async start(context: ModuleContext): Promise<void> {
      if (ctx) throw new Error('lorawan : module deja demarre');
      ctx = context;
      stopped = false;
      const opts: { username?: string; password?: string } = {};
      if (cfg.username !== undefined) opts.username = cfg.username;
      if (cfg.password !== undefined) opts.password = cfg.password;
      const opened = await context.openMqtt(cfg.brokerUrl, opts);
      link = opened;
      try {
        for (const dev of cfg.devices.values()) {
          for (const kind of ['up', 'status', 'join']) {
            await opened.subscribe(`application/${cfg.applicationId}/device/${dev.eui}/event/${kind}`, safeOnMessage);
          }
        }
      } catch (err) {
        await opened.close().catch(() => {});
        link = null;
        ctx = null;
        throw new Error(`lorawan : abonnement impossible (${(err as Error).message})`);
      }
      context.log('info', `lorawan : ${cfg.devices.size} capteur(s) surveille(s) sur ${new URL(cfg.brokerUrl).host}`);
    },

    async stop(): Promise<void> {
      stopped = true;
      const l = link;
      link = null;
      const c = ctx;
      ctx = null;
      states.clear();
      warnings.clear();
      if (l) {
        try {
          await l.close();
        } catch (err) {
          c?.log('warn', `lorawan : fermeture de la liaison MQTT : ${(err as Error).message}`);
        }
      }
    },
  };
};
