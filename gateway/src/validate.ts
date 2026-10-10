/**
 * Controle d'un message AVANT sa mise en file : ce que le PSIM refuserait est rejete ici, tout de suite et avec la raison,
 * plutot que de bloquer la file ou de partir en silence (voir server/mqtt.ts, server/sources.ts et server/ingestmeta.ts).
 */
import { randomUUID } from 'node:crypto';
// Source unique : la liste des evenements et le format des msgId sont ceux du PSIM lui-meme (la passerelle est livree avec
// lui, dossier gateway\). Ces deux fichiers n'importent que des types : rien du serveur n'est charge a l'execution.
import { MSG_ID_PATTERN } from '../../server/ingestmeta.ts';
import { EVENTS } from '../../server/sources.ts';
import { normalizeMsgId } from './msgid.ts';

/** Identifiant d'equipement PSIM (topic psim/detectors/<id>/state). */
export const DEVICE_ID = /^[A-Za-z0-9_-]{1,32}$/;
/** Identifiant de message : 1 a 64 caracteres parmi lettres, chiffres, `.`, `_`, `:` et `-` (comme le PSIM). */
export const MSG_ID: RegExp = MSG_ID_PATTERN;
/** Taille maximale du message JSON accepte par le broker du PSIM. */
export const MAX_PAYLOAD_BYTES = 1024;
export const STATES: ReadonlySet<string> = new Set(['normal', 'prealarm', 'alarm', 'fault', 'offline']);
/** Format d'un nom d'evenement (minuscules, chiffres, souligne). */
const EVENT_FORMAT = /^[a-z][a-z0-9_]{0,31}$/;
/**
 * Evenements connus du PSIM : EXACTEMENT ceux de server/sources.ts (EVENTS). Un evenement absent de cette liste part quand
 * meme, mais un avertissement est journalise : le PSIM l'ignorera. Les tables des modules sont verifiees contre cette liste
 * par les essais (gateway/test/contract.test.ts).
 */
export const KNOWN_EVENTS: ReadonlySet<string> = new Set(Object.keys(EVENTS));

/** Mesure acceptee par le PSIM (server/sources.ts). */
const MAX_ABS_VALUE = 1e9;
/** Avant cette date (ms), un `ts` est certainement en SECONDES (1e12 ms = septembre 2001). */
const MIN_TS_MS = 1e12;

export interface Prepared {
  ok: true;
  topic: string;
  /** Message final, `ts` et `msgId` compris : c'est lui qui est ecrit sur disque puis renvoye tel quel. */
  payload: Record<string, unknown>;
  bytes: number;
  warnings: string[];
}

export type PrepareResult = Prepared | { ok: false; error: string };

export const newMsgId = (): string => randomUUID();

export function topicFor(deviceId: string): string {
  return `psim/detectors/${deviceId}/state`;
}

/**
 * Valide un message de module et le complete : `ts` (heure courante) et `msgId` (genere) s'ils manquent.
 * Ne leve jamais.
 */
export function prepare(deviceId: unknown, msg: unknown, now: number, makeId: () => string = newMsgId): PrepareResult {
  if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) {
    return { ok: false, error: 'identifiant d\'equipement invalide (1 a 32 caracteres : lettres, chiffres, _ et -)' };
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return { ok: false, error: 'message invalide (objet attendu)' };
  const m = msg as Record<string, unknown>;
  // Taille du message TEL QUE FOURNI : un module qui envoie un gros objet est arrete ici, avec la bonne raison.
  let rawBytes: number;
  try {
    rawBytes = Buffer.byteLength(JSON.stringify(m) ?? '');
  } catch {
    return { ok: false, error: 'message invalide (non serialisable en JSON)' };
  }
  if (rawBytes > MAX_PAYLOAD_BYTES) return { ok: false, error: `message trop gros (${rawBytes} octets, ${MAX_PAYLOAD_BYTES} au plus)` };
  const warnings: string[] = [];
  const payload: Record<string, unknown> = {};

  if (m.state !== undefined) {
    if (typeof m.state !== 'string' || !STATES.has(m.state)) return { ok: false, error: 'state invalide (normal, prealarm, alarm, fault ou offline)' };
    payload.state = m.state;
  }
  if (m.event !== undefined) {
    if (typeof m.event !== 'string' || !EVENT_FORMAT.test(m.event)) return { ok: false, error: 'event invalide (minuscules, chiffres et _, 32 caracteres au plus)' };
    if (!KNOWN_EVENTS.has(m.event)) warnings.push(`evenement « ${m.event} » inconnu de cette passerelle : le PSIM l'ignorera s'il ne le connait pas`);
    payload.event = m.event;
  }
  if (m.value !== undefined) {
    if (typeof m.value !== 'number' || !Number.isFinite(m.value)) return { ok: false, error: 'value invalide (nombre fini attendu)' };
    if (Math.abs(m.value) > MAX_ABS_VALUE) return { ok: false, error: `value hors bornes (${MAX_ABS_VALUE} au plus en valeur absolue)` };
    payload.value = m.value;
  }
  if (payload.state === undefined && payload.event === undefined && payload.value === undefined) {
    return { ok: false, error: 'message vide : au moins un de state, event ou value' };
  }

  if (m.ts !== undefined) {
    if (typeof m.ts !== 'number' || !Number.isSafeInteger(m.ts) || m.ts <= 0) return { ok: false, error: 'ts invalide (millisecondes depuis 1970, nombre entier)' };
    if (m.ts < MIN_TS_MS) return { ok: false, error: 'ts en secondes ? Les millisecondes depuis 1970 sont attendues (comme Date.now())' };
    payload.ts = m.ts;
  } else {
    payload.ts = Math.trunc(now);
  }
  if (m.msgId !== undefined) {
    if (typeof m.msgId !== 'string' || m.msgId.length === 0 || m.msgId.length > 1024) return { ok: false, error: 'msgId invalide (texte de 1 a 64 caracteres : lettres, chiffres, . _ : -)' };
    if (MSG_ID.test(m.msgId)) payload.msgId = m.msgId;
    else {
      // Jamais de message perdu pour un msgId mal forme (nom d'equipement accentue, trop long...) : il est nettoye de facon
      // deterministe (meme entree, meme msgId : l'anti-doublon du PSIM reste juste) et le module est signale.
      payload.msgId = normalizeMsgId(m.msgId);
      warnings.push('msgId hors format (1 a 64 caracteres : lettres, chiffres, . _ : -) : nettoye');
    }
  } else {
    payload.msgId = makeId();
  }

  for (const key of Object.keys(m)) {
    if (!['state', 'event', 'value', 'ts', 'msgId'].includes(key)) warnings.push(`champ « ${key.slice(0, 32)} » ignore (seuls state, event, value, ts, msgId sont transmis)`);
  }

  const bytes = Buffer.byteLength(JSON.stringify(payload));
  if (bytes > MAX_PAYLOAD_BYTES) return { ok: false, error: `message trop gros (${bytes} octets, ${MAX_PAYLOAD_BYTES} au plus)` };
  return { ok: true, topic: topicFor(deviceId), payload, bytes, warnings };
}

/** Motifs de detecteurs comme cote PSIM : identifiant exact, ou prefixe termine par `*`. */
export function allows(patterns: readonly string[], id: string): boolean {
  return patterns.some((p) => (p.endsWith('*') ? id.startsWith(p.slice(0, -1)) : p === id));
}
