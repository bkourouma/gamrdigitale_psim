/**
 * Synchronisation des titulaires PSIM -> centrale ZKTeco (docs/CONTROLE-ACCES.md, par. 7) : le `SyncDriver` du module. Le code
 * commun (acces-commun/sync.ts) valide l'ordre, le met en file (une operation a la fois), attribue les numeros de fuseau
 * (`SlotMap`) et traduit les echecs ; ce fichier sait seulement ECRIRE dans une centrale ZKTeco.
 *
 * Transport : la file de commandes du module (commands.ts). Le protocole PUSH est « tire » : la commande `DATA UPDATE ...` est posee
 * dans la file, l'appareil la prend a son prochain `getrequest` et annonce `Return=0` par `devicecmd`. Une methode du pilote ne se
 * resout donc QUE si l'appareil a confirme ; une commande qui depasse `commandTimeoutS` est RETIREE de la file (jamais remise en
 * retard) ; chaque commande d'une operation est posee seulement apres la confirmation de la precedente (ordre garanti, et une
 * ouverture de porte demandee entre-temps n'attend jamais plus d'une commande de synchronisation).
 *
 * ----------------------------------------------------------------------------------------------------------------------
 * OPERATIONS -> COMMANDES (tables du SDK C3 « PullSDK », memes noms dans le protocole PUSH)
 * ----------------------------------------------------------------------------------------------------------------------
 *  upsert_holder   DATA UPDATE user CardNo=<carte>  Pin=<n>  StartTime=<AAAAMMJJ|0>  EndTime=<AAAAMMJJ|0>  [Name=<nom>  Privilege=0]
 *                  DATA DELETE userauthorize Pin=<n>                                  (efface les droits precedents)
 *                  DATA UPDATE userauthorize Pin=<n>  AuthorizeTimezoneId=<fuseau>  AuthorizeDoorId=<masque des portes>
 *                    (une commande par fuseau distinct ; masque = somme de 1 << (porte - 1))
 *  delete_holder   DATA DELETE userauthorize Pin=<n>  puis  DATA DELETE user Pin=<n>
 *  upsert_schedule DATA UPDATE timezone TimezoneId=<n> SunTime1..3 MonTime1..3 ... SatTime1..3 Hol1Time1..3 Hol2Time1..3 Hol3Time1..3
 *  delete_schedule DATA UPDATE timezone TimezoneId=<n> avec tous les segments a 0 (fuseau vide : jamais d'acces)
 *  set_holidays    DATA UPDATE holiday Holiday=<AAAAMMJJ> HolidayType=1 Loop=2      (une commande par date)
 *                  DATA DELETE holiday Holiday=<AAAAMMJJ>                            (dates retirees par `replace`)
 *
 * CONFIRME (sources : pyzkaccess, enveloppe de la bibliotheque PullSDK ; depot « laravel-zkteco-adms-core ») :
 *  - tables `user` (CardNo, Pin, Password, Group, StartTime, EndTime, SuperAuthorize), `userauthorize` (Pin, AuthorizeTimezoneId,
 *    AuthorizeDoorId = masque de bits des portes), `holiday` (Holiday, HolidayType 1 a 3, Loop : 1 annuel, 2 non annuel) et
 *    `timezone` (TimezoneId, <Jour>Time1..3, Hol1Time1..Hol3Time3) ;
 *  - dates StartTime / EndTime / Holiday : texte `AAAAMMJJ` ; `0` = sans limite ;
 *  - un segment de fuseau = un entier : (heure * 100 + minute) du debut * 65536 + (heure * 100 + minute) de la fin ; 0 = segment
 *    inutilise ;
 *  - `DATA UPDATE userauthorize` SUPERPOSE l'ancien fuseau au nouveau sur beaucoup de micrologiciels : on efface TOUJOURS d'abord ;
 *  - forme `DATA DELETE userauthorize Pin=<n>` ; codes de retour -30 (parametre invalide) et -1002 (syntaxe obsolete).
 *
 * A QUALIFIER (rien de cela n'a pu etre lu dans la specification officielle) :
 *  - le separateur de champs est une tabulation (comme les lignes de donnees recues) ; les champs `Name` et `Privilege` (famille
 *    inBio / terminaux) n'existent pas dans la table `user` du SDK C3 : `sync.userExtras: false` les supprime ;
 *  - le champ `Group` n'est PAS envoye (valeur par defaut de l'appareil) ;
 *  - le champ `Password` n'est JAMAIS envoye (le code PIN reste dans le controleur, decision du chef) : on ignore si une mise a
 *    jour sans `Password` conserve le code existant ou le remet a zero ;
 *  - `DATA UPDATE` fait-il une fusion ou un remplacement de la ligne ? `DATA DELETE` d'une ligne absente rend-il 0 (suppose) ?
 *  - `EndTime` est-il INCLUS (suppose : l'acces vaut jusqu'a la fin de ce jour) ? La date est calculee dans l'heure locale de l'appareil
 *    (`utcOffsetMin`), au jour pres : une fin de validite a 14 h vaut donc la fin de la journee (le PSIM retire aussi le titulaire) ;
 *  - un seul badge par utilisateur est connu de la table `user` : le 2e a 4e badge d'un titulaire est REFUSE (`not_supported`) ;
 *  - `Pin` : 1 a 9 chiffres, sans zero de tete (`H0042` refuse : l'appareil pourrait confondre 42 et 042) ;
 *  - le fuseau « toujours » (`timezones.always`, 1) existe deja dans l'appareil et couvre toute la semaine ; capacite en fuseaux ;
 *  - les jours feries sont de type 1 (donc `Hol1Time*`) ; `holidays: false` = la plage commune aux 7 jours (jamais plus large que
 *    l'horaire du PSIM) ; `holidays: true` = ferme ;
 *  - un fuseau « supprime » est vide (segments a 0) plutot que supprime : la table est de taille fixe ;
 *  - un jour ferie ecrit n'est retire que s'il a ete ecrit par ce module (liste conservee dans le dossier d'etat) ;
 *  - code `Return` de la « capacite pleine » : inconnu, a declarer dans `sync.fullCodes`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ActuatorFailure } from '../acces-commun/commun.ts';
import type { LogFn, SyncDriver, SyncHolder, SyncWindow } from '../acces-commun/commun.ts';
import { DeviceRefusal } from './commands.ts';
import type { DeviceCommands } from './commands.ts';
import type { TimezoneConfig } from './config.ts';

/** Fichier des jours feries ecrits par le module (dossier d'etat). */
export const HOLIDAYS_FILE = 'acces-zkteco-feries.json';

const TAB = '\t';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
/** Nom maximal du titulaire envoye a l'appareil, en octets UTF-8 (champ de 24 octets sur les appareils ZKTeco : A QUALIFIER). */
export const NAME_MAX_BYTES = 24;
const MAX_HOLIDAYS_KEPT = 4096;

// --- Fonctions pures -------------------------------------------------------------------------------------------------------

/** `H<chiffres>` -> `Pin` (1 a 9 chiffres, sans zero de tete). `null` si la reference n'est pas convertible. */
export function pinOf(holderRef: string): string | null {
  const m = /^H([1-9][0-9]{0,8})$/.exec(holderRef);
  return m ? (m[1] as string) : null;
}

/** Date `AAAAMMJJ` de l'appareil (heure locale `utcOffsetMin`) pour un instant en ms, ou `null` hors de 2001-2099. */
export function zkDate(ms: number, utcOffsetMin: number): string | null {
  const d = new Date(ms + utcOffsetMin * 60_000);
  const y = d.getUTCFullYear();
  if (!Number.isFinite(y) || y < 2001 || y > 2099) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${y}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** `AAAA-MM-JJ` (date deja validee du calendrier) -> `AAAAMMJJ`, ou `null` hors de 2001-2099. */
export function holidayDate(date: string): string | null {
  const y = Number(date.slice(0, 4));
  return y >= 2001 && y <= 2099 ? date.replace(/-/g, '') : null;
}

/** Minute de la journee (0 a 1439) -> HHMM decimal (par exemple 510 -> 830). */
const hhmm = (minute: number): number => Math.floor(minute / 60) * 100 + (minute % 60);

/** Bornes de validite d'un titulaire pour l'appareil : `StartTime` et `EndTime` (`'0'` = sans limite). */
export function validityDates(validFrom: number | null, validTo: number | null, utcOffsetMin: number): { start: string; end: string } {
  let start = '0';
  if (validFrom !== null) {
    // Avant 2001 : aucune borne utile ; apres 2099 : jamais valide dans la plage de l'appareil (derniere date acceptee).
    start = zkDate(validFrom, utcOffsetMin) ?? (validFrom < Date.UTC(2001, 0, 1) ? '0' : '20991231');
  }
  let end = '0';
  if (validTo !== null) {
    // Avant 2001 : deja echu (premiere date acceptee) ; apres 2099 : sans limite.
    end = zkDate(validTo, utcOffsetMin) ?? (validTo < Date.UTC(2001, 0, 1) ? '20010101' : '0');
  }
  return { start, end };
}

/** Un jour = 1 440 minutes ; 1 = acces accorde. */
type DayBitmap = Uint8Array;

/** Minutes accordees pour chaque jour de la semaine (0 = dimanche). Une plage qui passe minuit deborde sur le jour suivant. */
export function windowBitmaps(windows: ReadonlyArray<SyncWindow>): DayBitmap[] {
  const days: DayBitmap[] = Array.from({ length: 7 }, () => new Uint8Array(1440));
  const toMinutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  for (const w of windows) {
    const from = toMinutes(w.from);
    const to = toMinutes(w.to);
    for (const d of w.days) {
      if (from < to) days[d]?.fill(1, from, to);
      else {
        days[d]?.fill(1, from, 1440);
        days[(d + 1) % 7]?.fill(1, 0, to);
      }
    }
  }
  return days;
}

/** Suites de minutes accordees : `[debut, fin exclue]`. */
function runsOf(day: DayBitmap): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let m = 0; m <= 1440; m++) {
    const on = m < 1440 && day[m] === 1;
    if (on && start < 0) start = m;
    else if (!on && start >= 0) {
      runs.push([start, m]);
      start = -1;
    }
  }
  return runs;
}

/**
 * Trois segments d'un jour (entiers de l'appareil, 0 = inutilise). La fin est la DERNIERE minute accordee (jamais une minute de plus
 * que l'horaire du PSIM). Plus de trois plages dans un meme jour : `not_supported`.
 */
export function daySegments(day: DayBitmap): [number, number, number] {
  const runs = runsOf(day);
  if (runs.length > 3) throw new ActuatorFailure('not_supported', "plus de 3 plages horaires distinctes dans un meme jour : le fuseau de l'appareil n'en admet que 3");
  const out: [number, number, number] = [0, 0, 0];
  runs.forEach(([a, b], i) => {
    // 0 = segment inutilise : la seule plage qui s'encoderait en 0 (minuit a minuit, une minute) devient 00:00-00:01.
    out[i] = Math.max(1, hhmm(a) * 65536 + hhmm(b - 1));
  });
  return out;
}

/** Plage commune aux sept jours (jours feries sans `holidays` : jamais plus large que l'horaire du PSIM). */
function commonDay(days: ReadonlyArray<DayBitmap>): DayBitmap {
  const out = new Uint8Array(1440);
  for (let m = 0; m < 1440; m++) out[m] = days.every((d) => d[m] === 1) ? 1 : 0;
  return out;
}

/** Champs `<Jour>Time<n>` et `Hol<n>Time<m>` d'un fuseau, dans l'ordre. */
export function timezoneFields(slot: number, windows: ReadonlyArray<SyncWindow>, holidays: boolean): Array<[string, number]> {
  const days = windowBitmaps(windows);
  const fields: Array<[string, number]> = [['TimezoneId', slot]];
  DAY_NAMES.forEach((name, d) => {
    daySegments(days[d] as DayBitmap).forEach((v, i) => fields.push([`${name}Time${i + 1}`, v]));
  });
  // Jours feries de type 1 : fermes si `holidays`, sinon la plage commune aux sept jours. Types 2 et 3 : jamais utilises (fermes).
  const holiday = holidays ? [0, 0, 0] : daySegments(commonDay(days));
  holiday.forEach((v, i) => fields.push([`Hol1Time${i + 1}`, v]));
  for (const type of [2, 3]) for (let i = 1; i <= 3; i++) fields.push([`Hol${type}Time${i}`, 0]);
  return fields;
}

/** Fuseau vide : tous les segments a 0. */
export function emptyTimezoneFields(slot: number): Array<[string, number]> {
  return timezoneFields(slot, [], true);
}

const record = (fields: ReadonlyArray<readonly [string, string | number]>): string => fields.map(([k, v]) => `${k}=${v}`).join(TAB);

/** `DATA UPDATE <table> Champ=valeur<TAB>Champ=valeur...` */
export const updateCommand = (table: string, fields: ReadonlyArray<readonly [string, string | number]>): string => `DATA UPDATE ${table} ${record(fields)}`;
/** `DATA DELETE <table> Champ=valeur...` */
export const deleteCommand = (table: string, fields: ReadonlyArray<readonly [string, string | number]>): string => `DATA DELETE ${table} ${record(fields)}`;

/** Nom pret pour l'appareil : sans caractere de controle ni separateur de ligne, au plus `NAME_MAX_BYTES` octets UTF-8. */
export function deviceName(name: string): string {
  const clean = name.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  let out = '';
  let bytes = 0;
  for (const ch of clean) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > NAME_MAX_BYTES) break;
    out += ch;
    bytes += n;
  }
  return out.trim();
}

// --- Jours feries ecrits par le module -------------------------------------------------------------------------------------

/**
 * Jours feries que CE module a ecrits dans chaque centrale (`AAAAMMJJ`), pour pouvoir les retirer ensuite (`replace`) sans connaitre
 * la syntaxe d'un effacement general de la table (A QUALIFIER). Fichier JSON ecrit de facon atomique ; lecture tolerante.
 */
export class HolidayStore {
  private readonly file: string;
  private readonly dir: string;
  private readonly log: LogFn;
  private readonly data = new Map<string, Set<string>>();
  private dirty = false;

  constructor(dir: string, log: LogFn) {
    this.dir = dir;
    this.file = join(dir, HOLIDAYS_FILE);
    this.log = log;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      const controllers = typeof parsed === 'object' && parsed !== null ? (parsed as { controllers?: unknown }).controllers : undefined;
      if (typeof controllers === 'object' && controllers !== null && !Array.isArray(controllers)) {
        for (const [id, list] of Object.entries(controllers)) {
          if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || !Array.isArray(list)) continue;
          this.data.set(id, new Set(list.filter((d): d is string => typeof d === 'string' && /^(20\d\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(d)).slice(0, MAX_HOLIDAYS_KEPT)));
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log('warn', 'fichier des jours feries ecrits illisible : liste vide');
    }
  }

  get(controllerId: string): ReadonlySet<string> {
    return this.data.get(controllerId) ?? new Set();
  }

  add(controllerId: string, date: string): void {
    const set = this.data.get(controllerId) ?? new Set<string>();
    if (!set.has(date) && set.size >= MAX_HOLIDAYS_KEPT) return;
    set.add(date);
    this.data.set(controllerId, set);
    this.dirty = true;
  }

  remove(controllerId: string, date: string): void {
    if (this.data.get(controllerId)?.delete(date)) this.dirty = true;
  }

  /** Ecrit si quelque chose a change. Ne leve jamais. */
  flush(): void {
    if (!this.dirty) return;
    const tmp = `${this.file}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true });
      const controllers = Object.fromEntries([...this.data].filter(([, s]) => s.size > 0).map(([id, s]) => [id, [...s].sort()]));
      writeFileSync(tmp, JSON.stringify({ v: 1, controllers }));
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      this.log('warn', `ecriture des jours feries ecrits impossible (${err instanceof Error ? err.message : 'erreur'}) : nouvel essai plus tard`);
    }
  }
}

// --- Pilote ------------------------------------------------------------------------------------------------------------------

export interface ZktecoSyncOptions {
  controllerId: string;
  commands: DeviceCommands;
  /** Ecart de l'heure locale de l'appareil a l'heure universelle (minutes). */
  utcOffsetMin: number;
  now: () => number;
  timezones: TimezoneConfig;
  /** Envoyer `Name` et `Privilege=0` avec l'utilisateur. */
  userExtras: boolean;
  /** Codes `Return` de l'appareil qui signifient « capacite pleine ». */
  fullCodes: readonly number[];
  holidays: HolidayStore;
}

/** Codes `Return` : -30 parametre invalide, -1002 syntaxe obsolete (sources tierces, A QUALIFIER). Les autres : erreur a reessayer. */
const RETURN_INVALID = -30;
const RETURN_DEPRECATED = -1002;

/** Traduit un echec de la file de commandes en echec de synchronisation (codes du par. 7 : not_supported, invalid, full, io, unreachable, timeout). */
export function translateFailure(err: unknown, fullCodes: readonly number[]): ActuatorFailure {
  if (err instanceof DeviceRefusal) {
    if (fullCodes.includes(err.returnCode)) return new ActuatorFailure('full', "capacite de l'appareil atteinte");
    if (err.returnCode === RETURN_INVALID) return new ActuatorFailure('invalid', "valeur refusee par l'appareil");
    if (err.returnCode === RETURN_DEPRECATED) return new ActuatorFailure('not_supported', "commande non prise en charge par l'appareil");
    return new ActuatorFailure('io', `commande refusee par l'appareil (code ${err.returnCode})`);
  }
  if (err instanceof ActuatorFailure) {
    if (err.code === 'offline' || err.code === 'stopped') return new ActuatorFailure('unreachable', err.message);
    return err;
  }
  return new ActuatorFailure('io', 'echec de la commande');
}

/** Le pilote de synchronisation d'UNE centrale. Aucune methode ne leve autre chose qu'une `ActuatorFailure`. */
export function createZktecoSyncDriver(o: ZktecoSyncOptions): SyncDriver {
  const send = async (text: string): Promise<void> => {
    try {
      await o.commands.enqueue(text);
    } catch (err) {
      throw translateFailure(err, o.fullCodes);
    }
  };
  const revoke = (pin: string): Promise<void> => send(deleteCommand('userauthorize', [['Pin', pin]]));

  return {
    async upsertHolder(h: SyncHolder, doorSlots): Promise<void> {
      // Tout est verifie AVANT le premier envoi : une demande refusee ne laisse jamais un etat a moitie ecrit.
      const pin = pinOf(h.holderRef);
      if (pin === null) throw new ActuatorFailure('invalid', 'reference de titulaire non convertible en numero d\'utilisateur (H suivi de 1 a 9 chiffres, sans zero de tete)');
      if (h.credentials.length > 1) throw new ActuatorFailure('not_supported', "la centrale n'accepte qu'un badge par utilisateur");
      const card = h.credentials[0] ?? '';
      if (card !== '' && (!/^[0-9]{1,10}$/.test(card) || /^0+$/.test(card) || Number(card) > 4_294_967_295)) {
        throw new ActuatorFailure('invalid', 'numero de badge inutilisable par la centrale (1 a 10 chiffres, non nul)');
      }
      const masks = new Map<number, number>();
      for (const ds of doorSlots) {
        const slot = ds.slot ?? o.timezones.always;
        masks.set(slot, (masks.get(slot) ?? 0) | (1 << (ds.doorNo - 1)));
      }
      const { start, end } = validityDates(h.validFrom, h.validTo, o.utcOffsetMin);
      const t = o.now();
      // Acces suspendu : titulaire inactif ou echu. Les droits sont alors RETIRES (l'utilisateur reste : jamais de suppression implicite).
      // Un titulaire pas encore valide garde ses droits : `StartTime` l'empeche d'entrer (le PSIM ne renvoie rien a la date de debut).
      const suspended = !h.active || (h.validTo !== null && t > h.validTo);

      const fields: Array<[string, string | number]> = [['CardNo', card], ['Pin', pin], ['StartTime', start], ['EndTime', end]];
      if (o.userExtras) {
        const name = deviceName(h.name);
        if (name !== '') fields.push(['Name', name]);
        fields.push(['Privilege', 0]);
      }
      // Jamais de champ `Password` : le code PIN reste dans la centrale.
      const userCmd = updateCommand('user', fields);

      if (suspended) {
        // D'abord retirer l'acces : si l'ecriture de l'utilisateur echoue ensuite, personne n'a d'acces en trop.
        await revoke(pin);
        await send(userCmd);
        return;
      }
      await send(userCmd);
      await revoke(pin);
      for (const [slot, mask] of [...masks].sort((a, b) => a[0] - b[0])) {
        await send(updateCommand('userauthorize', [['Pin', pin], ['AuthorizeTimezoneId', slot], ['AuthorizeDoorId', mask]]));
      }
    },

    async deleteHolder(holderRef: string): Promise<void> {
      const pin = pinOf(holderRef);
      // Une reference non convertible n'a jamais pu etre ecrite (upsert refuse) : rien a supprimer, succes.
      if (pin === null) return;
      await revoke(pin);
      await send(deleteCommand('user', [['Pin', pin]]));
    },

    async upsertSchedule(_ref: string, slot: number, windows: ReadonlyArray<SyncWindow>, holidays: boolean): Promise<void> {
      await send(updateCommand('timezone', timezoneFields(slot, windows, holidays)));
    },

    async deleteSchedule(_ref: string, slot: number): Promise<void> {
      await send(updateCommand('timezone', emptyTimezoneFields(slot)));
    },

    async setHolidays(dates: ReadonlyArray<string>, replace: boolean): Promise<void> {
      const wanted: string[] = [];
      for (const d of dates) {
        const z = holidayDate(d);
        if (z === null) throw new ActuatorFailure('invalid', "date de jour ferie hors de la plage de l'appareil (2001 a 2099)");
        wanted.push(z);
      }
      try {
        if (replace) {
          for (const old of [...o.holidays.get(o.controllerId)]) {
            if (wanted.includes(old)) continue;
            await send(deleteCommand('holiday', [['Holiday', old]]));
            o.holidays.remove(o.controllerId, old);
          }
        }
        for (const d of wanted) {
          await send(updateCommand('holiday', [['Holiday', d], ['HolidayType', 1], ['Loop', 2]]));
          o.holidays.add(o.controllerId, d);
        }
      } finally {
        o.holidays.flush();
      }
    },
  };
}
