/**
 * Messages dates et rejouables. Sur un site en 4G instable, une passerelle garde les alertes pendant une coupure puis les
 * renvoie : l'alerte doit garder son heure REELLE, et un renvoi ne doit jamais compter deux fois.
 *
 * Deux champs FACULTATIFS, a cote de `state` / `event` / `value` (sans eux, rien ne change) :
 *  - `ts`    : heure reelle de l'evenement, en MILLISECONDES depuis le 1er janvier 1970 UTC (entier, comme `Date.now()`).
 *              Des secondes (`1760000000`) sont refusees, avec un message qui le dit : deviner l'unite serait une erreur
 *              silencieuse de 1000 fois sur l'heure d'une alarme.
 *  - `msgId` : identifiant unique du message POUR CET EQUIPEMENT, 1 a 64 caracteres parmi lettres, chiffres, `.`, `_`,
 *              `:` et `-` (un UUID, ou « gw1-000123 »). Un message deja traite avec le meme `msgId` est un succes sans effet.
 *
 * Bornes (anti-abus, et parce qu'une alarme ne doit jamais etre perdue pour une question d'horloge) :
 *  - `ts` dans le futur : RAMENE A L'HEURE D'ARRIVEE, jamais refuse. Un evenement ne peut pas etre posterieur a sa reception ;
 *    une passerelle a l'horloge en avance ne doit pas faire perdre une alarme ; et un message date dans le futur ne peut pas
 *    servir a « bloquer » les messages suivants (voir l'ordre des messages dans engine.ts). Au-dela de FUTURE_TOLERANCE_MS,
 *    l'ecart est signale dans le journal technique (horloge de la passerelle a regler).
 *  - `ts` plus ancien que l'age maximal (PSIM_INGEST_MAX_AGE_S, 7 jours par defaut) : REFUSE (HTTP 400, ignore en MQTT).
 *  - La memoire des `msgId` couvre la meme duree, et sa taille est bornee (par equipement et au total) : purge automatique.
 */
import type { DatabaseSync } from 'node:sqlite';

/** Ecart d'horloge tolere sans le signaler (un `ts` dans le futur est de toute facon ramene a l'heure d'arrivee). */
export const FUTURE_TOLERANCE_MS = 2 * 60_000;
/** Au-dela de ce retard entre l'evenement et sa reception, l'alerte est marquee « recue en differe ». */
export const LATE_AFTER_MS = 60_000;
/** Age maximal par defaut d'un message date (et duree de memoire des `msgId`). */
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 3_600_000;
export const MSG_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
/** Memoire des `msgId` : par equipement, et au total (environ 100 octets par ligne). */
export const DEDUP_MAX_PER_DEVICE = 10_000;
export const DEDUP_MAX_TOTAL = 500_000;

export interface MessageMeta {
  /** Heure retenue pour l'evenement : `ts` s'il est fourni (jamais apres l'arrivee), sinon l'heure d'arrivee. */
  eventAt: number;
  receivedAt: number;
  /** `ts` fourni : seuls ces messages sont soumis a l'ordre (un message sans `ts` est toujours « maintenant »). */
  dated: boolean;
  /** Retard entre l'evenement et sa reception (0 si non date ou dans le futur). */
  lateMs: number;
  /** De combien `ts` etait dans le futur (0 sinon). */
  aheadMs: number;
  msgId: string | null;
}

/** Lit `ts` et `msgId` (format seulement ; l'age est controle par `tooOld`, APRES la deduplication). Ne leve jamais. */
export function readMeta(payload: unknown, receivedAt: number): { ok: true; meta: MessageMeta } | { ok: false; error: string } {
  const meta: MessageMeta = { eventAt: receivedAt, receivedAt, dated: false, lateMs: 0, aheadMs: 0, msgId: null };
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return { ok: true, meta }; // refuse ensuite par interpret()
  const { ts, msgId } = payload as { ts?: unknown; msgId?: unknown };
  if (msgId !== undefined) {
    if (typeof msgId !== 'string' || !MSG_ID_PATTERN.test(msgId)) return { ok: false, error: 'msgId invalide (1 a 64 caracteres : lettres, chiffres, . _ : -)' };
    meta.msgId = msgId;
  }
  if (ts !== undefined) {
    if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts <= 0) return { ok: false, error: 'ts invalide (millisecondes depuis 1970, nombre entier)' };
    meta.dated = true;
    meta.eventAt = Math.min(ts, receivedAt);
    meta.lateMs = receivedAt - meta.eventAt;
    meta.aheadMs = Math.max(0, ts - receivedAt);
  }
  return { ok: true, meta };
}

/** Message trop ancien : la raison du refus, ou `null`. */
export function tooOld(meta: MessageMeta, maxAgeMs: number): string | null {
  if (!meta.dated || meta.lateMs <= maxAgeMs) return null;
  // `ts` en secondes : il tombe dans la fenetre une fois multiplie par 1000. On le dit plutot que de deviner.
  const asSeconds = meta.eventAt * 1000;
  if (Math.abs(meta.receivedAt - asSeconds) <= maxAgeMs) return 'ts en secondes ? Les millisecondes depuis 1970 sont attendues (comme Date.now())';
  return `ts trop ancien (plus de ${Math.round(maxAgeMs / 3_600_000)} h) : message refuse`;
}

export function alreadySeen(db: DatabaseSync, deviceId: string, msgId: string): boolean {
  return db.prepare('SELECT 1 AS x FROM ingest_dedup WHERE device_id = ? AND msg_id = ?').get(deviceId, msgId) !== undefined;
}

let sinceCap = 0;

/** Note un message traite. Toutes les 1000 insertions, les plafonds sont appliques sans attendre la purge periodique. */
export function remember(db: DatabaseSync, deviceId: string, msgId: string, receivedAt: number): void {
  db.prepare('INSERT OR IGNORE INTO ingest_dedup (device_id, msg_id, received_at) VALUES (?, ?, ?)').run(deviceId, msgId, receivedAt);
  if (++sinceCap >= 1000) {
    sinceCap = 0;
    capDedup(db);
  }
}

/** Plafonds : les plus anciens `msgId` sont oublies en premier (ex aequo sur l'heure : on garde un peu plus). */
export function capDedup(db: DatabaseSync, perDevice = DEDUP_MAX_PER_DEVICE, total = DEDUP_MAX_TOTAL): number {
  let removed = 0;
  const crowded = db.prepare('SELECT device_id FROM ingest_dedup GROUP BY device_id HAVING COUNT(*) > ?').all(perDevice) as { device_id: string }[];
  for (const { device_id } of crowded) {
    const edge = db.prepare('SELECT received_at FROM ingest_dedup WHERE device_id = ? ORDER BY received_at DESC LIMIT 1 OFFSET ?').get(device_id, perDevice - 1) as { received_at: number } | undefined;
    if (edge) removed += Number(db.prepare('DELETE FROM ingest_dedup WHERE device_id = ? AND received_at < ?').run(device_id, edge.received_at).changes);
  }
  const edge = db.prepare('SELECT received_at FROM ingest_dedup ORDER BY received_at DESC LIMIT 1 OFFSET ?').get(total - 1) as { received_at: number } | undefined;
  if (edge) removed += Number(db.prepare('DELETE FROM ingest_dedup WHERE received_at < ?').run(edge.received_at).changes);
  return removed;
}

/** Oublie les `msgId` recus avant `before` (au-dela, un renvoi date serait de toute facon refuse comme trop ancien), puis applique les plafonds. */
export function purgeDedup(db: DatabaseSync, before: number): number {
  return Number(db.prepare('DELETE FROM ingest_dedup WHERE received_at < ?').run(before).changes) + capDedup(db);
}
