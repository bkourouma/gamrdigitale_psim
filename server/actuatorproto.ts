/**
 * Protocole signe des commandes d'actionneurs (voir docs/COMMANDES.md, section 5). Fonctions pures, sans base ni reseau :
 * le futur pilote cote passerelle peut reprendre ce fichier tel quel.
 *
 *   ordre  : psim-cmd-v1|<id>|<cmdId>|<action>|<durationS>|<clip>|<ts>|<ttlS>
 *   accuse : psim-ack-v1|<id>|<cmdId>|<result>|<code>|<ts>
 *
 * Chaque champ a un alphabet sans « | » (verifie AVANT de construire la chaine) : la chaine canonique est sans ambiguite.
 * L'identifiant de l'actionneur n'est jamais lu dans le message : c'est celui du topic attendu par le recepteur.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 1024;
/** Tolerance d'horloge entre le PSIM et l'equipement (un message date de plus loin dans le futur est refuse). */
export const CLOCK_SKEW_MS = 5000;
export const TTL_MIN_S = 2;
export const TTL_MAX_S = 30;
export const DURATION_MAX_S = 86_400;

export const ACTUATOR_ID = /^[A-Za-z0-9_-]{1,32}$/;
export const CMD_ID = /^[0-9a-f]{32}$/;
export const ACTION = /^[a-z_]{1,16}$/;
export const CLIP = /^[A-Za-z0-9_-]{1,32}$/;
export const ACK_CODE = /^[a-z0-9_]{1,32}$/;
const SIG = /^[0-9a-f]{64}$/;
export const KEY_HEX = /^[0-9a-f]{64}$/;

export type AckResult = 'done' | 'refused' | 'error';
const RESULTS = new Set<AckResult>(['done', 'refused', 'error']);

export interface CommandParams {
  durationS?: number;
  clip?: string;
}

export interface CommandMessage {
  v: 1;
  cmdId: string;
  action: string;
  params: CommandParams;
  ts: number;
  ttlS: number;
  sig: string;
}

export interface AckMessage {
  v: 1;
  cmdId: string;
  result: AckResult;
  code?: string;
  ts: number;
  sig: string;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

function keyBytes(keyHex: string): Buffer {
  if (!KEY_HEX.test(keyHex)) throw new Error('Cle d actionneur invalide (64 hexadecimaux minuscules attendus)');
  return Buffer.from(keyHex, 'hex');
}

const hmac = (keyHex: string, text: string): string => createHmac('sha256', keyBytes(keyHex)).update(text, 'utf8').digest('hex');

/** Comparaison en temps constant de deux signatures hexadecimales de 64 caracteres. */
function sameSig(a: string, b: string): boolean {
  if (!SIG.test(a) || !SIG.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function checkParams(params: CommandParams): void {
  if (params.durationS !== undefined && (!isInt(params.durationS) || params.durationS < 1 || params.durationS > DURATION_MAX_S)) throw new Error('durationS invalide');
  if (params.clip !== undefined && (typeof params.clip !== 'string' || !CLIP.test(params.clip))) throw new Error('clip invalide');
}

export function commandCanonical(actuatorId: string, m: Omit<CommandMessage, 'v' | 'sig'>): string {
  if (!ACTUATOR_ID.test(actuatorId) || !CMD_ID.test(m.cmdId) || !ACTION.test(m.action) || !isInt(m.ts) || !isInt(m.ttlS)) throw new Error('Champ de commande invalide');
  checkParams(m.params);
  return ['psim-cmd-v1', actuatorId, m.cmdId, m.action, m.params.durationS ?? '', m.params.clip ?? '', m.ts, m.ttlS].join('|');
}

export function ackCanonical(actuatorId: string, m: Omit<AckMessage, 'v' | 'sig'>): string {
  if (!ACTUATOR_ID.test(actuatorId) || !CMD_ID.test(m.cmdId) || !RESULTS.has(m.result) || !isInt(m.ts)) throw new Error("Champ d'accuse invalide");
  if (m.code !== undefined && !ACK_CODE.test(m.code)) throw new Error("Code d'accuse invalide");
  return ['psim-ack-v1', actuatorId, m.cmdId, m.result, m.code ?? '', m.ts].join('|');
}

/** Ordre signe, pret a publier. Les parametres absents ne figurent pas dans `params`. */
export function signCommand(keyHex: string, actuatorId: string, m: Omit<CommandMessage, 'v' | 'sig'>): CommandMessage {
  const params: CommandParams = {};
  if (m.params.durationS !== undefined) params.durationS = m.params.durationS;
  if (m.params.clip !== undefined) params.clip = m.params.clip;
  const body = { cmdId: m.cmdId, action: m.action, params, ts: m.ts, ttlS: m.ttlS };
  return { v: 1, ...body, sig: hmac(keyHex, commandCanonical(actuatorId, body)) };
}

export function signAck(keyHex: string, actuatorId: string, m: Omit<AckMessage, 'v' | 'sig'>): AckMessage {
  const body: Omit<AckMessage, 'v' | 'sig'> = { cmdId: m.cmdId, result: m.result, ts: m.ts };
  if (m.code !== undefined) body.code = m.code;
  return { v: 1, ...body, sig: hmac(keyHex, ackCanonical(actuatorId, body)) };
}

function parseObject(raw: Buffer | string): Record<string, unknown> | null {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length;
  if (size > MAX_MESSAGE_BYTES) return null;
  try {
    const value = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const onlyKeys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));

/**
 * Lecture d'un accuse par le PSIM : formats stricts puis signature (temps constant). `null` = a ignorer.
 * La fraicheur et le rattachement a une commande attendue sont verifies par l'appelant (il connait la commande).
 */
export function verifyAck(keyHex: string, actuatorId: string, raw: Buffer | string): AckMessage | null {
  const o = parseObject(raw);
  if (!o || !onlyKeys(o, ['v', 'cmdId', 'result', 'code', 'ts', 'sig'])) return null;
  if (o.v !== PROTOCOL_VERSION || typeof o.cmdId !== 'string' || !CMD_ID.test(o.cmdId)) return null;
  if (typeof o.result !== 'string' || !RESULTS.has(o.result as AckResult) || !isInt(o.ts) || typeof o.sig !== 'string' || !SIG.test(o.sig)) return null;
  if (o.code !== undefined && (typeof o.code !== 'string' || !ACK_CODE.test(o.code))) return null;
  const body: Omit<AckMessage, 'v' | 'sig'> = { cmdId: o.cmdId, result: o.result as AckResult, ts: o.ts };
  if (o.code !== undefined) body.code = o.code as string;
  const expected = hmac(keyHex, ackCanonical(actuatorId, body));
  if (!sameSig(expected, o.sig)) return null;
  return { v: 1, ...body, sig: o.sig };
}

export type CommandCheck = { ok: true; message: CommandMessage } | { ok: false; reason: 'format' | 'signature' | 'stale' };

/**
 * Lecture d'un ordre par un RECEPTEUR (pilote de passerelle, simulateur d'essai) : formats, signature, fraicheur
 * (`ts - 5 s <= maintenant <= ts + ttlS`). L'anti-rejeu par cmdId et les plafonds locaux restent au recepteur.
 */
export function verifyCommand(keyHex: string, actuatorId: string, raw: Buffer | string, now = Date.now()): CommandCheck {
  const o = parseObject(raw);
  if (!o || !onlyKeys(o, ['v', 'cmdId', 'action', 'params', 'ts', 'ttlS', 'sig'])) return { ok: false, reason: 'format' };
  const p = o.params;
  if (o.v !== PROTOCOL_VERSION || typeof o.cmdId !== 'string' || !CMD_ID.test(o.cmdId) || typeof o.action !== 'string' || !ACTION.test(o.action)) return { ok: false, reason: 'format' };
  if (p === null || typeof p !== 'object' || Array.isArray(p) || !onlyKeys(p as Record<string, unknown>, ['durationS', 'clip'])) return { ok: false, reason: 'format' };
  if (!isInt(o.ts) || !isInt(o.ttlS) || o.ttlS < TTL_MIN_S || o.ttlS > TTL_MAX_S || typeof o.sig !== 'string' || !SIG.test(o.sig)) return { ok: false, reason: 'format' };
  const params = p as CommandParams;
  try {
    checkParams(params);
  } catch {
    return { ok: false, reason: 'format' };
  }
  const body = { cmdId: o.cmdId, action: o.action, params, ts: o.ts, ttlS: o.ttlS };
  if (!sameSig(hmac(keyHex, commandCanonical(actuatorId, body)), o.sig)) return { ok: false, reason: 'signature' };
  if (now < o.ts - CLOCK_SKEW_MS || now > o.ts + o.ttlS * 1000) return { ok: false, reason: 'stale' };
  return { ok: true, message: { v: 1, ...body, sig: o.sig } };
}
