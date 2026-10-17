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

/** Champ `access` (passage a une porte, docs/CONTROLE-ACCES.md § 2). */
const CONTROLLER_ID = /^[A-Za-z0-9_-]{1,32}$/;
const EVENT_ID = /^[A-Za-z0-9._:-]{1,40}$/;
const ACCESS_METHODS: ReadonlySet<string> = new Set(['badge', 'code', 'fingerprint', 'face', 'exit_button', 'remote', 'unknown']);
const ACCESS_REASONS: ReadonlySet<string> = new Set(['unknown_credential', 'expired', 'out_of_schedule', 'disabled', 'wrong_pin', 'antipassback', 'door_locked', 'other']);
const ACCESS_KEYS = ['v', 'controllerId', 'eventId', 'direction', 'credential', 'holderName', 'holderRef', 'method', 'result', 'reason', 'deferred'];
const HOLDER_NAME_MAX = 64;
const CREDENTIAL_MAX = 32;
const HOLDER_REF_MAX = 32;
// Texte libre venu d'un controleur : interdit de laisser passer un caractere de controle (journaux, CSV, affichage).
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

/** Coupe un texte a `max` caracteres sans separer une paire de substitution (emoji). */
function cutText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/**
 * Controle du champ `access`. Renvoie une copie propre (cles dans l'ordre du contrat, `holderName` tronque a 64 caracteres)
 * ou la raison du refus. Jamais de champ en plus : ce qu'un controleur peut envoyer d'autre (code PIN, gabarit) ne passe pas.
 */
function checkAccess(raw: unknown, warnings: string[]): { ok: true; access: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'access invalide (objet attendu)' };
  const a = raw as Record<string, unknown>;
  for (const key of Object.keys(a)) {
    if (!ACCESS_KEYS.includes(key)) return { ok: false, error: `access : champ « ${key.slice(0, 32)} » inconnu` };
  }
  if (a.v !== 1) return { ok: false, error: 'access.v invalide (1 attendu)' };
  if (typeof a.controllerId !== 'string' || !CONTROLLER_ID.test(a.controllerId)) return { ok: false, error: 'access.controllerId invalide (1 a 32 caracteres : lettres, chiffres, _ et -)' };
  if (typeof a.eventId !== 'string' || !EVENT_ID.test(a.eventId)) return { ok: false, error: 'access.eventId invalide (1 a 40 caracteres : lettres, chiffres, . _ : -)' };
  if (a.direction !== 'in' && a.direction !== 'out' && a.direction !== null) return { ok: false, error: 'access.direction invalide (in, out ou null)' };
  if (typeof a.method !== 'string' || !ACCESS_METHODS.has(a.method)) return { ok: false, error: 'access.method invalide (badge, code, fingerprint, face, exit_button, remote ou unknown)' };
  if (a.result !== 'granted' && a.result !== 'denied') return { ok: false, error: 'access.result invalide (granted ou denied)' };
  if (a.reason !== null && (typeof a.reason !== 'string' || !ACCESS_REASONS.has(a.reason))) return { ok: false, error: 'access.reason invalide (null ou un motif du contrat)' };
  if (a.result === 'granted' && a.reason !== null) return { ok: false, error: 'access.reason doit etre null pour un passage accepte' };
  if (typeof a.deferred !== 'boolean') return { ok: false, error: 'access.deferred invalide (booleen attendu)' };
  const text = (field: 'credential' | 'holderRef', max: number): { ok: true; value: string | null } | { ok: false; error: string } => {
    const v = a[field];
    if (v === null) return { ok: true, value: null };
    if (typeof v !== 'string' || v.length === 0 || Array.from(v).length > max || CONTROL_CHARS.test(v)) return { ok: false, error: `access.${field} invalide (texte de ${max} caracteres au plus, sans caractere de controle, ou null)` };
    return { ok: true, value: v };
  };
  const credential = text('credential', CREDENTIAL_MAX);
  if (!credential.ok) return credential;
  const holderRef = text('holderRef', HOLDER_REF_MAX);
  if (!holderRef.ok) return holderRef;
  let holderName: string | null;
  if (a.holderName === null) holderName = null;
  else if (typeof a.holderName !== 'string' || a.holderName.length === 0 || CONTROL_CHARS.test(a.holderName)) return { ok: false, error: 'access.holderName invalide (texte sans caractere de controle, ou null)' };
  else {
    holderName = cutText(a.holderName, HOLDER_NAME_MAX);
    if (holderName !== a.holderName) warnings.push(`access.holderName tronque a ${HOLDER_NAME_MAX} caracteres`);
  }
  return {
    ok: true,
    access: {
      v: 1, controllerId: a.controllerId, eventId: a.eventId, direction: a.direction, credential: credential.value, holderName,
      holderRef: holderRef.value, method: a.method, result: a.result, reason: a.reason, deferred: a.deferred,
    },
  };
}

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
  let m = msg as Record<string, unknown>;
  const warnings: string[] = [];
  // Passage a une porte : controle et nettoye AVANT la mesure de la taille (un nom trop long est tronque, pas refuse).
  let access: Record<string, unknown> | undefined;
  if (m.access !== undefined) {
    const checked = checkAccess(m.access, warnings);
    if (!checked.ok) return checked;
    access = checked.access;
    m = { ...m, access };
  }
  // Taille du message TEL QUE FOURNI : un module qui envoie un gros objet est arrete ici, avec la bonne raison.
  let rawBytes: number;
  try {
    rawBytes = Buffer.byteLength(JSON.stringify(m) ?? '');
  } catch {
    return { ok: false, error: 'message invalide (non serialisable en JSON)' };
  }
  if (rawBytes > MAX_PAYLOAD_BYTES) return { ok: false, error: `message trop gros (${rawBytes} octets, ${MAX_PAYLOAD_BYTES} au plus)` };
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

  if (access !== undefined) {
    const expected = normalizeMsgId(`acc:${access.controllerId as string}:${access.eventId as string}`);
    if (m.ts === undefined) return { ok: false, error: 'un passage exige ts (heure du controleur)' };
    if (m.msgId === undefined) payload.msgId = expected;
    else if (payload.msgId !== expected) return { ok: false, error: `msgId d'un passage invalide (${expected} attendu : acc:<controllerId>:<eventId>)` };
    const wanted = access.result === 'granted' ? 'badge_granted' : 'badge_denied';
    if (payload.event !== wanted) return { ok: false, error: `un passage ${access.result as string} exige event = ${wanted}` };
    if (payload.state !== undefined) return { ok: false, error: 'un passage ne porte pas de state (event seulement)' };
    payload.access = access;
  }

  for (const key of Object.keys(m)) {
    if (!['state', 'event', 'value', 'ts', 'msgId', 'access'].includes(key)) warnings.push(`champ « ${key.slice(0, 32)} » ignore (seuls state, event, value, ts, msgId, access sont transmis)`);
  }

  let bytes = Buffer.byteLength(JSON.stringify(payload));
  // Message final trop gros a cause du seul nom du titulaire : le nom est raccourci (jamais le passage perdu).
  if (bytes > MAX_PAYLOAD_BYTES && access !== undefined && typeof access.holderName === 'string') {
    const chars = Array.from(access.holderName);
    while (bytes > MAX_PAYLOAD_BYTES && chars.length > 1) {
      chars.length = Math.max(1, chars.length - Math.max(1, Math.ceil((bytes - MAX_PAYLOAD_BYTES) / 4)));
      access.holderName = chars.join('');
      bytes = Buffer.byteLength(JSON.stringify(payload));
    }
    warnings.push('access.holderName tronque pour tenir sous 1 024 octets');
  }
  if (bytes > MAX_PAYLOAD_BYTES) return { ok: false, error: `message trop gros (${bytes} octets, ${MAX_PAYLOAD_BYTES} au plus)` };
  return { ok: true, topic: topicFor(deviceId), payload, bytes, warnings };
}

/** Motifs de detecteurs comme cote PSIM : identifiant exact, ou prefixe termine par `*`. */
export function allows(patterns: readonly string[], id: string): boolean {
  return patterns.some((p) => (p.endsWith('*') ? id.startsWith(p.slice(0, -1)) : p === id));
}
