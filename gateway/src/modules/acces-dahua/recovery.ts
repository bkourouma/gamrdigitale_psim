/**
 * Recuperation des passages manquants (F8) dans la memoire du controleur : `recordFinder.cgi?action=find&name=AccessControlCardRec`
 * [A], par fenetres de temps (`StartTime`, `EndTime`, en secondes UTC) et par pages (`count`).
 *
 * Methode officielle [A] : le controleur ne propose pas de decalage (`offset`) ; on lit une fenetre, puis on repart de la
 * `CreateTime` du dernier enregistrement rendu, en dedoublonnant (des enregistrements peuvent partager la meme seconde et se
 * chevaucher d'une page a l'autre). Ici le dedoublonnage se fait par n° d'enregistrement (`RecNo`) : seuls les enregistrements
 * dont le numero depasse le plancher (curseur persiste, puis dernier numero traite) sont rejoues, dans l'ordre CROISSANT.
 *
 *  - premier demarrage (aucun curseur) : on ne rejoue PAS tout l'historique, seulement les dernieres 24 h (A QUALIFIER). Le curseur
 *    est celui de l'EPOQUE courante (cle `sup.cursorKey`) : apres un remplacement de controleur, la recuperation repart de zero ;
 *  - le plancher `RecNo` est conserve en memoire entre deux passes : un enregistrement ignore (porte inconnue...) n'est pas relu
 *    a chaque tour ;
 *  - borne de securite : `maxRecords` enregistrements examines par passe (5 000), puis la passe rend « partial » et le module
 *    continue au tour suivant ;
 *  - le socle (via le superviseur) refuse un message : la passe s'arrete (« refused ») sans avancer le plancher ; elle sera
 *    relancee ; rien n'est perdu puisque le curseur n'a pas depasse ce passage.
 */
import { epochEventId } from '../acces-commun/commun.ts';
import type { PassageInput, PassageOutcome } from '../acces-commun/commun.ts';
import { DahuaAuthError, DahuaHttpError } from './http.ts';
import type { HttpGetter } from './driver.ts';
import { parseRecordPage, translateRecord } from './protocol.ts';
import type { TranslateContext } from './protocol.ts';

export const PAGE_SIZE = 200;
export const MAX_RECORDS_PER_PASS = 5000;
/** Historique rejoue au premier demarrage. */
export const FIRST_START_WINDOW_MS = 24 * 3600 * 1000;
/** Marge de relecture avant l'heure du curseur (l'heure d'un enregistrement et celle du flux ne coincident pas toujours). */
export const CURSOR_MARGIN_S = 600;
/** Fenetre lue apres le dernier instant connu : large pour absorber un controleur dont l'horloge avance. */
const END_MARGIN_S = 24 * 3600;

export interface RecoveryRequest {
  http: HttpGetter;
  translate: () => TranslateContext;
  submit: (p: PassageInput) => PassageOutcome;
  /** Dernier curseur persiste (n° d'enregistrement) et son heure, ou `null` si jamais vu. */
  cursor: { cursor: string; ts: number } | null;
  /** Plancher en memoire (n° d'enregistrement deja traite), ou `null`. */
  floor: number | null;
  /** Heure estimee du controleur (ms UTC). */
  deviceNowMs: number;
  /** Passages rejoues marques « en differe » (apres coupure) ou non (completion d'un evenement du flux sans numero). */
  deferred: boolean;
  /** Debut force de la fenetre (secondes UTC) : usage de la completion des evenements sans numero. */
  startSec?: number;
  maxRecords?: number;
  pageSize?: number;
  isStopped: () => boolean;
  log?: (key: string, level: 'info' | 'warn' | 'error', text: string) => void;
}

export interface RecoveredRef {
  doorNo: number;
  ts: number;
}

export interface RecoveryResult {
  status: 'complete' | 'partial' | 'refused' | 'failed' | 'unsupported' | 'stopped';
  scanned: number;
  sent: number;
  duplicates: number;
  ignored: number;
  /** Plus haut n° d'enregistrement traite (a conserver comme plancher), ou `null`. */
  floor: number | null;
  /** Passages rejoues par cette passe (pour rapprocher les evenements du flux sans numero). */
  replayed: RecoveredRef[];
  /** Raison lisible d'un echec (sans adresse ni identifiant). */
  error: string | null;
}

function floorOf(req: RecoveryRequest): number | null {
  let floor = req.floor;
  if (req.cursor && /^\d{1,15}$/.test(req.cursor.cursor)) {
    const c = Number(req.cursor.cursor);
    if (floor === null || c > floor) floor = c;
  }
  return floor;
}

export async function runRecovery(req: RecoveryRequest): Promise<RecoveryResult> {
  const pageSize = req.pageSize ?? PAGE_SIZE;
  const maxRecords = req.maxRecords ?? MAX_RECORDS_PER_PASS;
  const result: RecoveryResult = { status: 'complete', scanned: 0, sent: 0, duplicates: 0, ignored: 0, floor: floorOf(req), replayed: [], error: null };
  const deviceNowSec = Math.floor(req.deviceNowMs / 1000);
  let start: number;
  if (req.startSec !== undefined) start = Math.max(0, Math.floor(req.startSec));
  else if (req.cursor) start = Math.max(0, Math.floor(req.cursor.ts / 1000) - CURSOR_MARGIN_S);
  else start = Math.max(0, deviceNowSec - Math.floor(FIRST_START_WINDOW_MS / 1000));
  const end = deviceNowSec + END_MARGIN_S;

  for (;;) {
    if (req.isStopped()) {
      result.status = 'stopped';
      return result;
    }
    let body: string;
    try {
      const res = await req.http.get(`/cgi-bin/recordFinder.cgi?action=find&name=AccessControlCardRec&StartTime=${start}&EndTime=${end}&count=${pageSize}`);
      if (res.status === 404 || res.status === 400) {
        result.status = 'unsupported';
        result.error = `le controleur ne propose pas la lecture de sa memoire (HTTP ${res.status})`;
        return result;
      }
      if (res.status !== 200) {
        result.status = 'failed';
        result.error = `lecture de la memoire refusee (HTTP ${res.status})`;
        return result;
      }
      body = res.body;
    } catch (err) {
      if (req.isStopped()) {
        result.status = 'stopped';
        return result;
      }
      result.status = 'failed';
      result.error = err instanceof DahuaAuthError || err instanceof DahuaHttpError ? err.message : 'erreur reseau';
      return result;
    }

    const page = parseRecordPage(body);
    if (page.records.length === 0) return result;
    const ctx = req.translate();
    // Traduit puis trie par n° d'enregistrement croissant (le controleur ne garantit pas l'ordre a l'interieur d'une page).
    const items: { recNo: number; passage: PassageInput | null; createSec: number | null }[] = [];
    let lastCreate = start;
    for (const rec of page.records) {
      const recNo = Number(rec.RecNo);
      const created = Number(rec.CreateTime);
      if (Number.isFinite(created) && created > lastCreate) lastCreate = Math.floor(created);
      result.scanned++;
      if (!/^\d{1,15}$/.test(rec.RecNo ?? '')) {
        result.ignored++;
        continue;
      }
      const t = translateRecord(rec, ctx);
      items.push({ recNo, passage: t.kind === 'passage' ? { ...t.passage, deferred: req.deferred, cursor: String(recNo), eventId: epochEventId(ctx.epoch ?? 0, String(recNo)) } : null, createSec: t.kind === 'passage' ? t.createSec : null });
    }
    items.sort((a, b) => a.recNo - b.recNo);
    for (const item of items) {
      if (result.floor !== null && item.recNo <= result.floor) continue;
      if (item.passage === null) {
        result.ignored++;
        result.floor = item.recNo;
        continue;
      }
      const outcome = req.submit(item.passage);
      if (outcome === 'refused') {
        result.status = 'refused';
        return result;
      }
      if (outcome === 'sent') {
        result.sent++;
        if (result.replayed.length < 1000) result.replayed.push({ doorNo: item.passage.doorNo, ts: item.passage.ts });
      } else if (outcome === 'duplicate') result.duplicates++;
      else result.ignored++;
      result.floor = item.recNo;
    }

    const returned = page.found ?? page.records.length;
    const more = page.totalCount !== null ? page.totalCount > returned : returned >= pageSize;
    if (!more) return result;
    if (result.scanned >= maxRecords) {
      result.status = 'partial';
      return result;
    }
    if (lastCreate <= start) {
      // Plus de `count` enregistrements dans la meme seconde : on avance d'une seconde plutot que de boucler.
      req.log?.('samesecond', 'warn', "plus d'enregistrements dans une meme seconde que la taille d'une page : certains peuvent manquer");
      lastCreate = start + 1;
    }
    start = lastCreate;
  }
}
