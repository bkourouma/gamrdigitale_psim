/**
 * Synchronisation des titulaires PSIM -> controleur Dahua (docs/CONTROLE-ACCES.md, par. 7) : le `SyncDriver` du code commun
 * (`makeSyncHandler`) pour UN controleur. Le gestionnaire commun valide l'ordre, le met en file (une operation a la fois),
 * attribue les numeros de plage (`SlotMap`) et traduit les echecs ; ici on ne fait que dire a Dahua quoi ecrire.
 *
 * CORRESPONDANCE (voir aussi gateway/docs/acces-dahua.md) :
 *
 *   operation PSIM    appels Dahua (HTTP GET, Digest)                                                   statut
 *   ----------------  ---------------------------------------------------------------------------------  ----------------------
 *   upsert_holder     recordFinder.cgi?action=find&name=AccessControlCard&condition.UserID=<id>          find : usage reel [C]
 *                     (+ condition.CardNo=<n°> pour une carte deja presente chez un autre titulaire)    (Intelbras, firmware SS)
 *                     recordUpdater.cgi?action=insert&name=AccessControlCard&CardNo=..&UserID=..&...     CONFIRME [A]
 *                     recordUpdater.cgi?action=update&name=AccessControlCard&recno=<RecNo>&...           confirme [C], A QUALIFIER
 *                     recordUpdater.cgi?action=remove&name=AccessControlCard&recno=<RecNo>               (carte retiree du titulaire)
 *   delete_holder     find (UserID) puis remove (recno) de CHAQUE carte du titulaire                      idem
 *   upsert_schedule   configManager.cgi?action=setConfig&AccessTimeSchedule[<n°>].Name / .TimeSchedule    A QUALIFIER (SDK [D])
 *   delete_schedule   setConfig : 28 segments desactives + nom vide                                     A QUALIFIER
 *   set_holidays      recordFinder/recordUpdater name=AccessControlHoliday (insert / update / remove)    A QUALIFIER (SDK [D])
 *
 * Sources : [A] « DAHUA ACCESS CONTROL PRODUCTS INTEGRATION INSTRUCTION » V1.0 (enregistrement d'un utilisateur : CardName, CardNo,
 * UserID, CardStatus, CardType, Password, Doors[i], TimeSections[i], VTOPosition, ValidDateStart, ValidDateEnd, IsValid ; reponse
 * `RecNo=<n>` ; modeles ASI3xxx / ASI6xxx / ASI7xxx) ; [C] integrations publiees (Intelbras, firmware « SS 55xx » : find par
 * `condition.UserID`, `update` par `recno`, `remove` par `recno`, `HTTP 400 Bad Request` sans detail quand un champ optionnel est
 * refuse) ; [D] SDK reseau Dahua (NET_RECORDSET_ACCESS_CTL_CARD : `sznDoors` = indice du tableau de `AccessControl`, `sznTimeSectionNo`
 * = indice du tableau `AccessTimeSchedule`, `nUserTime` = UseTimes ; CFG_ACCESS_TIMESCHEDULE_INFO : 7 jours x 4 segments, jour 0 =
 * dimanche, 128 plages ; NET_RECORDSET_HOLIDAY : numero, debut, fin, activation, portes).
 *
 * Choix (tous A QUALIFIER sur materiel) :
 *  - \`holderRef\` -> \`UserID\` TEL QUEL (le `H` est conserve) : l'identifiant du titulaire dans les passages (\`access.holderRef\` =
 *    \`UserID\`) est alors exactement celui du PSIM, sans conversion. Un firmware qui n'accepte qu'un \`UserID\` numerique refusera la
 *    synchronisation (erreur \`refused_by_device\`, visible) : il faudra alors retirer le `H`.
 *  - une carte par numero de badge du titulaire ; titulaire inactif, ou dont la validite est depassee : carte GELEE (\`CardStatus=4\`),
 *    JAMAIS supprimee ; un titulaire sans aucune porte est gele de la meme facon (une carte sans porte n'ouvre rien) ;
 *  - validite : \`ValidDateStart\` / \`ValidDateEnd\` TOUJOURS envoyees (des valeurs larges quand le PSIM n'a pas de limite), pour qu'une
 *    \`update\` efface une ancienne limite ; \`IsValid=true\` a la mise a jour d'une carte non gelee (le controleur le passe seul a faux
 *    a l'expiration) ;
 *  - \`scheduleRef\` null -> \`TimeSections[i]=255\` (« toutes les heures ») ;
 *  - jamais de \`Password\` (le code PIN reste dans le controleur), de gabarit, de visage ni de photo : aucun appel vers
 *    \`FaceInfoManager.cgi\` ni \`AccessUser.cgi\` ; une \`update\` laisse intacts les champs qu'elle n'envoie pas (PIN compris) ;
 *  - un echec n'est JAMAIS un succes : une methode ne se resout que sur la reponse attendue du controleur (\`RecNo=<n>\` pour
 *    \`insert\`, \`OK\` pour le reste) ; HTTP 404 = \`not_supported\` ; refus de capacite = \`full\` ; tout autre refus ou coupure =
 *    erreur (le PSIM retente avec attente croissante). Chaque requete est bornee par le delai de \`DahuaHttp\`.
 */
import { ActuatorFailure } from '../acces-commun/actuator.ts';
import { cleanText } from '../acces-commun/commun.ts';
import type { LogFn, SyncDriver, SyncHolder, SyncWindow } from '../acces-commun/commun.ts';
import { NO_RESTRICTION_SLOT } from './config.ts';
import { failure } from './driver.ts';
import type { HttpGetter } from './driver.ts';
import { parseRecordPage } from './protocol.ts';

/** Champs conserves d'une fiche carte lue : jamais `Password`. */
const CARD_KEYS: ReadonlySet<string> = new Set(['RecNo', 'CardNo', 'CardName', 'UserID', 'CardStatus', 'CardType', 'ValidDateStart', 'ValidDateEnd', 'IsValid', 'UseTimes']);
const HOLIDAY_KEYS: ReadonlySet<string> = new Set(['RecNo', 'HolidayNo', 'StartTime', 'EndTime', 'Enable']);

/** `CardStatus` : 0 normale, 1 perdue, 2 annulee, 4 gelee (SDK [D] et [A] : bits 1<<0, 1<<1, 1<<2...). Gelee = reversible. */
export const CARD_NORMAL = 0;
export const CARD_FROZEN = 4;
/** Longueur maximale de `CardName` ([A] : 32 caracteres). */
export const MAX_CARD_NAME = 32;
/** Segments par jour d'une plage horaire (SDK [D] : 4). */
export const SEGMENTS_PER_DAY = 4;
/** Validite par defaut d'une carte sans limite (le controleur manipule des dates jusqu'en 2037). */
export const DEFAULT_VALID_START = '20000101 000000';
export const DEFAULT_VALID_END = '20371231 235959';
/** Prefixe du numero de jour ferie ecrit par le module : seuls ces enregistrements sont geres (ceux de l'installateur restent). */
export const HOLIDAY_PREFIX = 'PSIM-';
/** Garde-fou : nombre maximal de requetes pour UNE operation. */
const MAX_CALLS = 400;
/** Mots d'une reponse d'erreur qui disent « plus de place » (A QUALIFIER : aucun texte n'est publie). */
const FULL_RE = /(no\s*space|not\s*enough\s*(space|memory)|full|capacity|overflow|exceed|too\s*many|out\s*of\s*(space|memory))/i;

// --- Fonctions pures --------------------------------------------------------------------------------------------------------

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Encodage d'une valeur de requete : pourcentage, sauf les deux-points (lisibles, comme dans les exemples du constructeur). */
export function enc(v: string): string {
  return encodeURIComponent(v).replace(/%3A/gi, ':');
}

/** Heure locale du controleur « aaaammjj hhmmss » (format de `ValidDateStart`) depuis un instant UTC (ms). */
export function formatLocal(ms: number, utcOffsetMin: number): string {
  const d = new Date(ms + utcOffsetMin * 60_000);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())} ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** `AAAA-MM-JJ` -> debut et fin de journee « aaaammjj hhmmss » (heure locale du controleur, sans conversion de fuseau). */
export function dayBounds(date: string): { start: string; end: string } {
  const compact = date.replace(/-/g, '');
  return { start: `${compact} 000000`, end: `${compact} 235959` };
}

const hhmm = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
// Fin de journee : 24:00 (fin d'une plage qui passe minuit) comme 23:59 (la plus grande heure du PSIM) s'ecrivent 23:59:59.
const clock = (minutes: number, endOfDay: boolean): string => (endOfDay && minutes >= 1439 ? '23:59:59' : `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`);

/**
 * Plages hebdomadaires du PSIM -> 7 jours (0 = dimanche, comme le PSIM et le SDK) de 4 segments « <actif> hh:mm:ss-hh:mm:ss ».
 *  - une plage qui passe minuit (fin <= debut) est coupee en deux : fin de journee du jour J, debut du jour suivant ;
 *  - les segments d'un meme jour qui se touchent ou se chevauchent sont fusionnes ;
 *  - un segment inutilise s'ecrit « 0 00:00:00-00:00:00 » (ecrit quand meme : l'ancien contenu de la plage est remplace) ;
 *  - plus de 4 segments un meme jour apres fusion : \`ActuatorFailure('not_supported')\` (limite du materiel).
 */
export function scheduleSegments(windows: ReadonlyArray<SyncWindow>): string[][] {
  const days: Array<Array<[number, number]>> = Array.from({ length: 7 }, () => []);
  for (const w of windows) {
    const from = hhmm(w.from);
    const to = hhmm(w.to);
    for (const d of w.days) {
      if (to > from) days[d]!.push([from, to]);
      else {
        days[d]!.push([from, 1440]);
        if (to > 0) days[(d + 1) % 7]!.push([0, to]);
      }
    }
  }
  return days.map((list) => {
    list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<[number, number]> = [];
    for (const seg of list) {
      const last = merged[merged.length - 1];
      if (last && seg[0] <= last[1]) last[1] = Math.max(last[1], seg[1]);
      else merged.push([seg[0], seg[1]]);
    }
    if (merged.length > SEGMENTS_PER_DAY) throw new ActuatorFailure('not_supported', `plus de ${SEGMENTS_PER_DAY} plages par jour : le controleur ne sait pas les ecrire`);
    const out = merged.map(([a, b]) => `1 ${clock(a, false)}-${clock(b, true)}`);
    while (out.length < SEGMENTS_PER_DAY) out.push('0 00:00:00-00:00:00');
    return out;
  });
}

/** Parametres `TimeSchedule[jour][segment]` d'une plage (28 entrees). */
export function scheduleParams(index: number, name: string, segments: string[][]): string {
  const parts = [`AccessTimeSchedule[${index}].Name=${enc(name)}`];
  segments.forEach((day, d) => day.forEach((seg, s) => parts.push(`AccessTimeSchedule[${index}].TimeSchedule[${d}][${s}]=${enc(seg)}`)));
  return parts.join('&');
}

const EMPTY_SEGMENTS: string[][] = Array.from({ length: 7 }, () => Array.from({ length: SEGMENTS_PER_DAY }, () => '0 00:00:00-00:00:00'));

// --- Pilote ---------------------------------------------------------------------------------------------------------------------

export interface DahuaSyncOptions {
  http: HttpGetter;
  /** Portes declarees du controleur (no -> detecteur) : une porte inconnue du module est refusee (\`invalid\`). */
  doors: ReadonlyMap<number, string>;
  /** Decalage de l'heure locale du controleur par rapport a UTC (minutes) : sert aux dates de validite. */
  utcOffsetMin: number;
  now: () => number;
  log?: LogFn;
}

interface CardRec {
  recNo: string;
  cardNo: string;
  userId: string | null;
}

export class DahuaSyncDriver implements SyncDriver {
  private readonly http: HttpGetter;
  private readonly doors: ReadonlyMap<number, string>;
  private readonly utcOffsetMin: number;
  private readonly now: () => number;
  private readonly log: LogFn;
  /** Requetes de l'operation en cours (garde-fou). */
  private calls = 0;

  constructor(opts: DahuaSyncOptions) {
    this.http = opts.http;
    this.doors = opts.doors;
    this.utcOffsetMin = opts.utcOffsetMin;
    this.now = opts.now;
    this.log = opts.log ?? (() => undefined);
  }

  // --- Requetes ----------------------------------------------------------------------------------------------------------------

  /** GET borne dans le temps (delai de la liaison) : tout echec reseau devient un \`ActuatorFailure\` (unreachable, timeout...). */
  private async get(path: string): Promise<{ status: number; body: string }> {
    if (++this.calls > MAX_CALLS) throw new ActuatorFailure('io', 'trop de requetes pour une seule operation de synchronisation');
    try {
      return await this.http.get(path);
    } catch (err) {
      throw failure(err);
    }
  }

  /** Reponse de lecture : 200 attendu ; 404 = fonction absente du materiel ; le reste = refus du materiel. */
  private async read(path: string, what: string): Promise<string> {
    const res = await this.get(path);
    if (res.status === 404) throw new ActuatorFailure('not_supported', `${what} : non pris en charge par ce controleur`);
    if (res.status !== 200) throw new ActuatorFailure('refused_by_device', `${what} : HTTP ${res.status}`);
    return res.body;
  }

  /** Ecriture : \`OK\` attendu (ou \`RecNo=<n>\` pour une insertion, dont le n° est rendu). */
  private async write(path: string, what: string, expect: 'ok' | 'recno'): Promise<string> {
    const res = await this.get(path);
    if (res.status === 404) throw new ActuatorFailure('not_supported', `${what} : non pris en charge par ce controleur`);
    const head = res.body.slice(0, 200);
    if (res.status !== 200 || /^\s*error/i.test(head)) {
      if (FULL_RE.test(head)) throw new ActuatorFailure('full', `${what} : controleur plein`);
      throw new ActuatorFailure('refused_by_device', `${what} : refuse par le controleur (HTTP ${res.status})`);
    }
    if (expect === 'ok') {
      if (!/^\s*OK\s*$/i.test(head)) throw new ActuatorFailure('refused_by_device', `${what} : reponse inattendue du controleur`);
      return '';
    }
    const m = /(?:^|\n)\s*RecNo\s*=\s*(\d{1,15})\s*(?:\r?\n|$)/.exec(head);
    if (!m) throw new ActuatorFailure('refused_by_device', `${what} : reponse inattendue du controleur (n° d'enregistrement absent)`);
    return m[1]!;
  }

  // --- Fiches carte --------------------------------------------------------------------------------------------------------------

  /** Fiches dont \`field\` vaut exactement \`value\` (le filtre est REFAIT ici : un firmware qui ignorerait \`condition.\` rendrait toutes les cartes). */
  private async findCards(field: 'UserID' | 'CardNo', value: string): Promise<CardRec[]> {
    const body = await this.read(`/cgi-bin/recordFinder.cgi?action=find&name=AccessControlCard&condition.${field}=${enc(value)}`, 'lecture des cartes');
    const out: CardRec[] = [];
    for (const rec of parseRecordPage(body, CARD_KEYS).records) {
      if (!/^\d{1,15}$/.test(rec.RecNo ?? '') || !rec.CardNo) continue;
      const mine = field === 'UserID' ? rec.UserID === value : rec.CardNo.toLowerCase() === value.toLowerCase();
      if (mine) out.push({ recNo: rec.RecNo!, cardNo: rec.CardNo, userId: rec.UserID ?? null });
    }
    return out;
  }

  /** Statut de la fiche : gelee si le titulaire est inactif, hors validite (fin depassee) ou sans porte ; sinon normale. */
  private cardStatus(h: SyncHolder, hasDoors: boolean): number {
    const expired = h.validTo !== null && this.now() > h.validTo;
    return !h.active || expired || !hasDoors ? CARD_FROZEN : CARD_NORMAL;
  }

  private cardQuery(h: SyncHolder, cardNo: string, doorSlots: ReadonlyArray<{ doorNo: number; slot: number | null }>, mode: 'insert' | 'update'): string {
    const status = this.cardStatus(h, doorSlots.length > 0);
    const name = (cleanText(h.name, MAX_CARD_NAME) ?? 'PSIM').slice(0, MAX_CARD_NAME);
    const start = h.validFrom === null ? DEFAULT_VALID_START : formatLocal(h.validFrom, this.utcOffsetMin);
    const end = h.validTo === null ? DEFAULT_VALID_END : formatLocal(h.validTo, this.utcOffsetMin);
    const parts = [`CardName=${enc(name)}`, `CardNo=${enc(cardNo)}`, `UserID=${enc(h.holderRef)}`, `CardStatus=${status}`];
    // CardType : seulement a la creation (une carte de contrainte posee par l'installateur ne doit pas redevenir ordinaire).
    if (mode === 'insert') parts.push('CardType=0');
    doorSlots.forEach((d, k) => {
      parts.push(`Doors[${k}]=${d.doorNo - 1}`);
      parts.push(`TimeSections[${k}]=${d.slot ?? NO_RESTRICTION_SLOT}`);
    });
    parts.push(`ValidDateStart=${enc(start)}`, `ValidDateEnd=${enc(end)}`);
    // Une carte expiree a ete marquee invalide par le controleur : une validite prolongee doit la rendre valide.
    if (mode === 'update' && status === CARD_NORMAL) parts.push('IsValid=true');
    return parts.join('&');
  }

  async upsertHolder(h: SyncHolder, doorSlots: ReadonlyArray<{ doorNo: number; slot: number | null }>): Promise<void> {
    this.calls = 0;
    for (const d of doorSlots) if (!this.doors.has(d.doorNo)) throw new ActuatorFailure('invalid', 'porte non declaree dans la configuration du module');
    const existing = await this.findCards('UserID', h.holderRef);
    const wanted = new Set<string>();
    for (const cardNo of h.credentials) {
      wanted.add(cardNo.toLowerCase());
      let rec = existing.find((c) => c.cardNo.toLowerCase() === cardNo.toLowerCase());
      if (!rec) {
        // Carte deja connue du controleur sous un AUTRE titulaire (ou sans titulaire) : elle est reprise, pas dupliquee.
        rec = (await this.findCards('CardNo', cardNo))[0];
        if (rec) this.log('info', 'une carte deja presente chez un autre titulaire est reprise par le titulaire synchronise');
      }
      if (rec) await this.write(`/cgi-bin/recordUpdater.cgi?action=update&name=AccessControlCard&recno=${rec.recNo}&${this.cardQuery(h, cardNo, doorSlots, 'update')}`, 'mise a jour de la carte', 'ok');
      else await this.write(`/cgi-bin/recordUpdater.cgi?action=insert&name=AccessControlCard&${this.cardQuery(h, cardNo, doorSlots, 'insert')}`, 'ajout de la carte', 'recno');
    }
    // Les badges que le PSIM ne connait plus pour ce titulaire sont retires, APRES l'ecriture des autres (jamais de titulaire sans carte entre deux).
    for (const old of existing) {
      if (wanted.has(old.cardNo.toLowerCase())) continue;
      await this.write(`/cgi-bin/recordUpdater.cgi?action=remove&name=AccessControlCard&recno=${old.recNo}`, 'retrait d\'une carte', 'ok');
    }
  }

  async deleteHolder(holderRef: string): Promise<void> {
    this.calls = 0;
    for (const rec of await this.findCards('UserID', holderRef)) {
      await this.write(`/cgi-bin/recordUpdater.cgi?action=remove&name=AccessControlCard&recno=${rec.recNo}`, 'suppression d\'une carte', 'ok');
    }
  }

  // --- Plages horaires -----------------------------------------------------------------------------------------------------------

  async upsertSchedule(scheduleRef: string, slot: number, windows: ReadonlyArray<SyncWindow>, holidays: boolean): Promise<void> {
    this.calls = 0;
    // « Ferme les jours feries » n'a pas de correspondance documentee sur ce materiel (A QUALIFIER) : plutot que d'ouvrir l'acces
    // un jour que le PSIM croit ferme, l'horaire est REFUSE (echec visible, l'administrateur decide).
    if (holidays) throw new ActuatorFailure('not_supported', 'horaire « ferme les jours feries » non pris en charge par ce controleur');
    if (!Number.isInteger(slot) || slot < 0 || slot >= NO_RESTRICTION_SLOT) throw new ActuatorFailure('invalid', 'numero de plage hors limites');
    // Les 28 segments sont toujours ecrits : l'ancien contenu de la plage est remplace, jamais complete.
    const segments = scheduleSegments(windows);
    // Les jours feries eux-memes sont ecrits par `setHolidays` (sans effet de fermeture par plage : voir plus haut).
    await this.write(`/cgi-bin/configManager.cgi?action=setConfig&${scheduleParams(slot, `PSIM ${scheduleRef}`, segments)}`, 'ecriture de la plage horaire', 'ok');
  }

  async deleteSchedule(_scheduleRef: string, slot: number): Promise<void> {
    this.calls = 0;
    if (!Number.isInteger(slot) || slot < 0 || slot >= NO_RESTRICTION_SLOT) throw new ActuatorFailure('invalid', 'numero de plage hors limites');
    await this.write(`/cgi-bin/configManager.cgi?action=setConfig&${scheduleParams(slot, '', EMPTY_SEGMENTS)}`, 'vidage de la plage horaire', 'ok');
  }

  // --- Jours feries ---------------------------------------------------------------------------------------------------------------

  async setHolidays(dates: ReadonlyArray<string>, replace: boolean): Promise<void> {
    this.calls = 0;
    const body = await this.read('/cgi-bin/recordFinder.cgi?action=find&name=AccessControlHoliday', 'lecture des jours feries');
    const existing = new Map<string, string>(); // n° de jour ferie -> RecNo (seulement ceux du module)
    for (const rec of parseRecordPage(body, HOLIDAY_KEYS).records) {
      if (/^\d{1,15}$/.test(rec.RecNo ?? '') && rec.HolidayNo?.startsWith(HOLIDAY_PREFIX)) existing.set(rec.HolidayNo, rec.RecNo!);
    }
    const doorParts = [...this.doors.keys()].map((n, k) => `Doors[${k}]=${n - 1}`).join('&');
    const keep = new Set<string>();
    for (const date of dates) {
      const no = `${HOLIDAY_PREFIX}${date}`;
      keep.add(no);
      const { start, end } = dayBounds(date);
      const fields = `HolidayNo=${enc(no)}&StartTime=${enc(start)}&EndTime=${enc(end)}&Enable=true&${doorParts}`;
      const recNo = existing.get(no);
      if (recNo !== undefined) await this.write(`/cgi-bin/recordUpdater.cgi?action=update&name=AccessControlHoliday&recno=${recNo}&${fields}`, 'mise a jour d\'un jour ferie', 'ok');
      else await this.write(`/cgi-bin/recordUpdater.cgi?action=insert&name=AccessControlHoliday&${fields}`, 'ajout d\'un jour ferie', 'recno');
    }
    if (replace) {
      for (const [no, recNo] of existing) {
        if (keep.has(no)) continue;
        await this.write(`/cgi-bin/recordUpdater.cgi?action=remove&name=AccessControlHoliday&recno=${recNo}`, 'retrait d\'un jour ferie', 'ok');
      }
    }
  }
}
