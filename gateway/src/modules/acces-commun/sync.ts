/**
 * Synchronisation des titulaires PSIM -> controleur, COTE MODULE (docs/CONTROLE-ACCES.md, par. 7). Le socle de la passerelle
 * verifie la signature et le `seq` d'un ordre puis appelle le gestionnaire enregistre par le module (`registerAccessSync`) ;
 * ce fichier fournit :
 *  - les types de l'ordre (definis dans gateway/src/module.ts, contrat du socle, et reexportes ici pour les marques) ;
 *  - `registerAccessSync` : declaration TOLERANTE aupres du socle (une erreur ne coupe jamais la remontee des passages) ;
 *  - `parseSyncBody` : validation STRICTE d'une entree hostile (jamais d'exception) ;
 *  - `makeSyncHandler` : le gestionnaire COMMUN a toutes les marques. Chaque marque ne fournit que `SyncDriver` (comment ecrire un
 *    titulaire, une plage horaire, des jours feries dans SON controleur) ; la validation, la serialisation, l'attribution des
 *    numeros de plage (`SlotMap`), l'idempotence et la traduction des echecs sont ici.
 *
 * Regles de securite :
 *  - aucun code PIN, gabarit biometrique ni photo ne traverse ce code : ces champs sont refuses a la validation, et le pilote ne
 *    les recoit jamais ;
 *  - les operations d'un meme controleur sont executees UNE A LA FOIS, dans l'ordre d'arrivee (file bornee) ;
 *  - une allocation de plage n'est jamais conservee si le controleur n'a pas confirme (annulee en cas d'echec) ;
 *  - le gestionnaire ne journalise jamais de nom, de numero de badge ni de reference de titulaire ;
 *  - une methode du pilote ne se resout que si le CONTROLEUR a confirme ; elle doit etre bornee dans le temps par la marque
 *    (delai d'attente de sa liaison) : le gestionnaire n'a pas de minuterie et une promesse jamais resolue bloquerait la file.
 */
import type { AccessSyncBody, AccessSyncHandler, AccessSyncOp, ModuleContext, SyncHolderDoor, SyncWindow, UpsertHolderBody } from '../../module.ts';
import { ActuatorFailure } from './actuator.ts';
import type { ActuatorOutcome } from './actuator.ts';
import { createLimitedLog } from './limitedlog.ts';
import { CONTROLLER_ID, cleanCredential, cleanText } from './messages.ts';
import { SCHEDULE_REF } from './slots.ts';
import type { SlotMap } from './slots.ts';
import type { LogFn } from './types.ts';

// --- Types de l'ordre (docs/CONTROLE-ACCES.md, par. 7) : contrat du socle, gateway/src/module.ts ----------------------------

export type { AccessSyncBody, AccessSyncHandler, AccessSyncOp, SyncHolderDoor, SyncWindow, UpsertHolderBody };

/** Texte court pour le journal, sans caractere de controle (le socle assainit aussi, mais un contexte d'essai non). */
const shortText = (v: unknown, max: number): string => String(v).replace(/\p{Cc}/gu, '?').slice(0, max);

/**
 * Declare le gestionnaire du controleur `controllerId` aupres du socle, avec sa cle de synchronisation (`syncKey` de la
 * configuration du module). Le socle LEVE quand la declaration est impossible (identifiant ou cle invalide, controleur deja pris,
 * module arrete) : une erreur de la SYNCHRONISATION ne doit JAMAIS couper la remontee des passages. L'erreur est donc attrapee et
 * journalisee clairement (`warn`), et le module continue sans synchronisation pour ce controleur. Renvoie vrai si le gestionnaire
 * est enregistre. La cle n'apparait jamais dans le journal (le socle ne la met pas non plus dans ses messages d'erreur).
 */
export function registerAccessSync(ctx: ModuleContext, controllerId: string, handler: AccessSyncHandler, key: string): boolean {
  const id = shortText(controllerId, 40);
  const say = (level: 'info' | 'warn', text: string): void => {
    try {
      ctx.log(level, text);
    } catch {
      // un journal defaillant ne doit pas faire echouer le module
    }
  };
  try {
    if (typeof ctx?.onAccessSync !== 'function') {
      // Contexte sans synchronisation (essai, socle ancien) : rien a enregistrer, le module surveille ses portes normalement.
      say('info', `controleur ${id} : synchronisation des titulaires indisponible, le socle de cette passerelle n'a pas de canal de synchronisation des titulaires (surveillance des portes seule)`);
      return false;
    }
    ctx.onAccessSync(controllerId, handler, { key });
    return true;
  } catch (err) {
    const why = err instanceof Error ? err.message : 'erreur inconnue';
    say('warn', `controleur ${id} : synchronisation des titulaires non enregistree, surveillance des portes seule (${shortText(why, 200)})`);
    return false;
  }
}

// --- Validation -----------------------------------------------------------------------------------------------------------

export type SyncParse = { ok: true; op: AccessSyncBody & { opId?: string; seq?: number } } | { ok: false; error: string };

export const HOLDER_REF = /^H[A-Za-z0-9_-]{1,31}$/;
export const MAX_NAME = 64;
export const MAX_CREDENTIALS = 4;
export const MAX_DOORS = 4;
export const MAX_WINDOWS = 14;
export const MAX_DATES = 40;
const MAX_TIME_MS = 8.64e15;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const OP_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Noms de champs qui designeraient un secret ou une donnee biometrique : refus explicite (en plus du refus des champs inconnus). */
const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set(['pin', 'pincode', 'password', 'passwd', 'template', 'photo', 'face', 'fingerprint', 'biometric']);

const KEYS: Readonly<Record<AccessSyncBody['type'], { required: readonly string[]; optional: readonly string[] }>> = {
  upsert_holder: { required: ['holderRef', 'name', 'active', 'validFrom', 'validTo', 'credentials', 'doors'], optional: [] },
  delete_holder: { required: ['holderRef'], optional: [] },
  upsert_schedule: { required: ['scheduleRef', 'windows', 'holidays'], optional: [] },
  delete_schedule: { required: ['scheduleRef'], optional: [] },
  set_holidays: { required: ['dates'], optional: ['replace'] },
};

class Invalid extends Error {}
const fail = (text: string): never => {
  throw new Invalid(text);
};

type Obj = Record<string, unknown>;

function isPlainObject(v: unknown): v is Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Verifie l'ensemble exact des champs d'un objet : aucun champ interdit, aucun champ inconnu, aucun champ obligatoire manquant. */
function checkKeys(o: Obj, required: readonly string[], optional: readonly string[], what: string): void {
  for (const key of Object.keys(o)) {
    if (FORBIDDEN_FIELDS.has(key.toLowerCase().replace(/[^a-z]/g, ''))) fail(`${what} : champ interdit (aucun code PIN, gabarit ni photo dans une synchronisation)`);
  }
  for (const key of Object.keys(o)) if (!required.includes(key) && !optional.includes(key)) fail(`${what} : champ inconnu`);
  for (const key of required) if (!Object.hasOwn(o, key)) fail(`${what} : champ obligatoire manquant (${key})`);
}

function ref(v: unknown, pattern: RegExp, what: string): string {
  if (typeof v !== 'string' || v.length > 64 || !pattern.test(v)) return fail(`${what} invalide`);
  return v;
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') return fail(`${what} : booleen attendu`);
  return v;
}

function timeOrNull(v: unknown, what: string): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > MAX_TIME_MS) return fail(`${what} : entier (ms) ou null attendu`);
  return v;
}

/** Tableau a longueur bornee, controlee AVANT toute lecture d'element (un tableau creux enorme ne coute rien). */
function list(v: unknown, min: number, max: number, what: string): unknown[] {
  if (!Array.isArray(v)) return fail(`${what} : liste attendue`);
  if (v.length < min || v.length > max) return fail(`${what} : ${min === max ? min : `${min} a ${max}`} element(s) attendu(s)`);
  return v;
}

function parseCredentials(v: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list(v, 0, MAX_CREDENTIALS, 'credentials')) {
    // Le numero doit etre deja " propre " : le corriger en silence pourrait donner le numero d'un AUTRE badge.
    const clean = typeof raw === 'string' ? cleanCredential(raw) : null;
    if (clean === null || clean !== raw) return fail('credentials : numero de badge invalide');
    const key = clean.toLowerCase();
    if (seen.has(key)) return fail('credentials : numero en double');
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function parseDoors(v: unknown): SyncHolderDoor[] {
  const out: SyncHolderDoor[] = [];
  const seen = new Set<number>();
  for (const d of list(v, 0, MAX_DOORS, 'doors')) {
    if (!isPlainObject(d)) return fail('doors : objet attendu');
    checkKeys(d, ['doorNo', 'scheduleRef'], [], 'doors');
    const doorNo = d.doorNo;
    if (typeof doorNo !== 'number' || !Number.isInteger(doorNo) || doorNo < 1 || doorNo > 4) return fail('doors : numero de porte invalide (1 a 4)');
    if (seen.has(doorNo)) return fail('doors : porte en double');
    seen.add(doorNo);
    out.push({ doorNo, scheduleRef: d.scheduleRef === null ? null : ref(d.scheduleRef, SCHEDULE_REF, 'doors : scheduleRef') });
  }
  return out;
}

function parseWindows(v: unknown): SyncWindow[] {
  const out: SyncWindow[] = [];
  for (const w of list(v, 1, MAX_WINDOWS, 'windows')) {
    if (!isPlainObject(w)) return fail('windows : objet attendu');
    checkKeys(w, ['days', 'from', 'to'], [], 'windows');
    const days = list(w.days, 1, 7, 'windows : days');
    const set = new Set<number>();
    for (let k = 0; k < days.length; k++) {
      const d = days[k];
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6 || set.has(d)) return fail('windows : jours invalides (entiers uniques de 0 a 6)');
      set.add(d);
    }
    if (typeof w.from !== 'string' || typeof w.to !== 'string' || !TIME.test(w.from) || !TIME.test(w.to)) return fail('windows : heures invalides (HH:MM)');
    if (w.from === w.to) return fail('windows : debut et fin identiques');
    out.push({ days: [...set].sort((a, b) => a - b), from: w.from, to: w.to });
  }
  return out;
}

/** Vraie date du calendrier `AAAA-MM-JJ` (annees 1970 a 2200) : pas de 31 avril, de 29 fevrier hors annee bissextile, de mois 13... */
export function validCalendarDate(s: unknown): s is string {
  if (typeof s !== 'string' || s.length !== 10) return false;
  const m = DATE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1970 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= days;
}

function parseDates(v: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of list(v, 0, MAX_DATES, 'dates')) {
    if (!validCalendarDate(d)) return fail('dates : date invalide (AAAA-MM-JJ, jour reel du calendrier)');
    if (seen.has(d)) return fail('dates : date en double');
    seen.add(d);
    out.push(d);
  }
  return out;
}

/**
 * Valide un ordre de synchronisation venu du reseau et le rend normalise. JAMAIS d'exception : toute anomalie donne
 * `{ ok: false, error }` (texte fixe, sans echo de la donnee hostile) ; le gestionnaire repond alors `refused` / `invalid`.
 *
 * `raw` est le corps (champs du par. 7), auquel s'ajoutent facultativement `opId` et `seq` (conserves tels quels dans `op` s'ils
 * sont valides : c'est la forme de `AccessSyncOp`). Regles : champ inconnu = refus ; champ nommant un PIN, un mot de passe, un
 * gabarit, une photo, un visage ou une empreinte = refus explicite ; tous les champs du `type` sont obligatoires (un `validFrom`
 * absent n'est PAS un `null`), sauf `replace` (faux par defaut).
 */
export function parseSyncBody(raw: unknown): SyncParse {
  try {
    if (!isPlainObject(raw)) return fail('ordre de synchronisation : objet attendu');
    for (const key of Object.keys(raw)) {
      if (FORBIDDEN_FIELDS.has(key.toLowerCase().replace(/[^a-z]/g, ''))) fail('champ interdit (aucun code PIN, gabarit ni photo dans une synchronisation)');
    }
    const type = raw.type;
    if (typeof type !== 'string' || !Object.hasOwn(KEYS, type)) return fail('type de synchronisation inconnu');
    const spec = KEYS[type as AccessSyncBody['type']];
    const extra: { opId?: string; seq?: number } = {};
    // Sans prototype : une cle "__proto__" venue du reseau reste une cle ordinaire (donc refusee comme inconnue).
    const rest: Obj = Object.create(null) as Obj;
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'opId') extra.opId = ref(v, OP_ID, 'opId');
      else if (k === 'seq') {
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail('seq invalide');
        extra.seq = v as number;
      } else rest[k] = v;
    }
    checkKeys(rest, ['type', ...spec.required], spec.optional, 'ordre');
    let body: AccessSyncBody;
    switch (type as AccessSyncBody['type']) {
      case 'upsert_holder': {
        const name = cleanText(typeof rest.name === 'string' ? rest.name : null, 4096);
        if (name === null || name.length > MAX_NAME) return fail(`name invalide (texte de 1 a ${MAX_NAME} caracteres)`);
        const validFrom = timeOrNull(rest.validFrom, 'validFrom');
        const validTo = timeOrNull(rest.validTo, 'validTo');
        if (validFrom !== null && validTo !== null && validTo <= validFrom) return fail('validTo doit etre posterieur a validFrom');
        body = {
          type: 'upsert_holder',
          holderRef: ref(rest.holderRef, HOLDER_REF, 'holderRef'),
          name,
          active: bool(rest.active, 'active'),
          validFrom,
          validTo,
          credentials: parseCredentials(rest.credentials),
          doors: parseDoors(rest.doors),
        };
        break;
      }
      case 'delete_holder':
        body = { type: 'delete_holder', holderRef: ref(rest.holderRef, HOLDER_REF, 'holderRef') };
        break;
      case 'upsert_schedule':
        body = { type: 'upsert_schedule', scheduleRef: ref(rest.scheduleRef, SCHEDULE_REF, 'scheduleRef'), windows: parseWindows(rest.windows), holidays: bool(rest.holidays, 'holidays') };
        break;
      case 'delete_schedule':
        body = { type: 'delete_schedule', scheduleRef: ref(rest.scheduleRef, SCHEDULE_REF, 'scheduleRef') };
        break;
      default:
        body = { type: 'set_holidays', dates: parseDates(rest.dates), replace: Object.hasOwn(rest, 'replace') ? bool(rest.replace, 'replace') : false };
    }
    return { ok: true, op: { ...body, ...extra } };
  } catch (err) {
    return { ok: false, error: err instanceof Invalid ? err.message : 'ordre de synchronisation illisible' };
  }
}

// --- Gestionnaire commun --------------------------------------------------------------------------------------------------

/** Titulaire tel que le pilote le recoit : le corps de `upsert_holder` sans son `type`. */
export type SyncHolder = Omit<UpsertHolderBody, 'type'>;

/** Ce que sait faire un controleur. Chaque methode ne se resout que si le controleur a CONFIRME ; echec = `ActuatorFailure`. */
export interface SyncDriver {
  /**
   * Cree ou remplace le titulaire. `doorSlots` donne, pour chaque porte du titulaire, le numero de plage du controleur
   * (`null` = toutes les heures). Doit etre idempotent (rejeu apres une coupure).
   */
  upsertHolder(holder: SyncHolder, doorSlots: ReadonlyArray<{ doorNo: number; slot: number | null }>): Promise<void>;
  /** Supprime le titulaire ; absent du controleur = succes (idempotent). */
  deleteHolder(holderRef: string): Promise<void>;
  /** Ecrit la plage `slot` du controleur. Idempotent. */
  upsertSchedule(scheduleRef: string, slot: number, windows: ReadonlyArray<SyncWindow>, holidays: boolean): Promise<void>;
  /** Vide la plage `slot` ; deja vide = succes. */
  deleteSchedule(scheduleRef: string, slot: number): Promise<void>;
  /** Ecrit les jours feries ; `replace` = remplace toute la liste, sinon ajoute. */
  setHolidays(dates: ReadonlyArray<string>, replace: boolean): Promise<void>;
}

export interface SyncHandlerOptions {
  /** Correspondance `scheduleRef` -> numero de plage, partagee par les gestionnaires des controleurs du module. */
  slots: SlotMap;
  now?: () => number;
  log?: LogFn;
  /** Operations en attente au maximum, y compris celle en cours (32). Au-dela : `error` / `busy` (le PSIM reessaie). */
  maxQueue?: number;
}

/** Codes de refus (la demande elle-meme est inacceptable : inutile de la rejouer telle quelle). */
const REFUSED_CODES: ReadonlySet<string> = new Set(['not_supported', 'invalid', 'full']);
const DEFAULT_MAX_QUEUE = 32;

const refused = (code: string): ActuatorOutcome => ({ result: 'refused', code });

/** Traduit une exception du pilote en reponse : refus pour not_supported / invalid / full, erreur (`io` par defaut) sinon. */
function outcomeOf(err: unknown): ActuatorOutcome {
  const code = err instanceof ActuatorFailure && /^[a-z0-9_]{1,32}$/.test(err.code) ? err.code : 'io';
  return REFUSED_CODES.has(code) ? refused(code) : { result: 'error', code };
}

/**
 * Fabrique le gestionnaire d'UN controleur (a passer a `registerAccessSync`). Ne leve jamais pour une operation : toute anomalie
 * devient une reponse. Leve `RangeError` si `controllerId` est invalide.
 *
 * Pour chaque ordre : validation (`parseSyncBody`) -> file d'attente (une operation a la fois) -> attribution de plage ->
 * appel du pilote -> confirmation (ou annulation) de l'attribution -> `done`.
 *  - `upsert_schedule` : numero de plage attribue par `SlotMap` ; plus de numero libre = `refused` / `full` SANS appeler le
 *    controleur ; echec du controleur = attribution annulee (jamais de plage fantome) ;
 *  - `upsert_holder` : chaque `scheduleRef` doit etre deja connu de `SlotMap`, sinon `refused` / `invalid` (le PSIM doit d'abord
 *    envoyer l'horaire) ; `null` = toutes les heures ;
 *  - `delete_schedule` d'une reference inconnue : `done` sans appeler le controleur (rien n'a jamais ete ecrit) ;
 *  - le meme `upsert` rejoue deux fois donne deux fois `done` et la meme plage.
 */
export function makeSyncHandler(controllerId: string, driver: SyncDriver, opts: SyncHandlerOptions): AccessSyncHandler {
  if (typeof controllerId !== 'string' || !CONTROLLER_ID.test(controllerId)) throw new RangeError('identifiant de controleur invalide');
  const slots = opts.slots;
  const maxQueue = typeof opts.maxQueue === 'number' && Number.isInteger(opts.maxQueue) && opts.maxQueue >= 1 ? opts.maxQueue : DEFAULT_MAX_QUEUE;
  const logLimited = createLimitedLog(opts.log ?? (() => undefined), opts.now ?? (() => 0));
  const note = (key: string, level: 'info' | 'warn', text: string): void => {
    try {
      logLimited(key, level, text);
    } catch {
      // un journal defaillant ne change pas la reponse
    }
  };
  let tail: Promise<unknown> = Promise.resolve();
  let waiting = 0;

  const supported = (method: keyof SyncDriver): boolean => typeof (driver as Partial<SyncDriver>)[method] === 'function';
  const persist = (): void => {
    if (!slots.flush()) note('slotsflush', 'warn', `controleur ${controllerId} : attribution des plages non ecrite sur le disque (nouvel essai plus tard)`);
  };

  async function run(body: AccessSyncBody): Promise<ActuatorOutcome> {
    switch (body.type) {
      case 'upsert_holder': {
        if (!supported('upsertHolder')) return refused('not_supported');
        const doorSlots: Array<{ doorNo: number; slot: number | null }> = [];
        for (const d of body.doors) {
          if (d.scheduleRef === null) {
            doorSlots.push({ doorNo: d.doorNo, slot: null });
            continue;
          }
          const slot = slots.get(controllerId, d.scheduleRef);
          if (slot === null) return refused('invalid'); // horaire inconnu : le PSIM doit l'envoyer d'abord
          doorSlots.push({ doorNo: d.doorNo, slot });
        }
        const { type: _type, ...holder } = body;
        await driver.upsertHolder(holder, doorSlots);
        return { result: 'done' };
      }
      case 'delete_holder':
        if (!supported('deleteHolder')) return refused('not_supported');
        await driver.deleteHolder(body.holderRef);
        return { result: 'done' };
      case 'upsert_schedule': {
        if (!supported('upsertSchedule')) return refused('not_supported');
        const existed = slots.get(controllerId, body.scheduleRef) !== null;
        const slot = slots.allocate(controllerId, body.scheduleRef);
        if (slot === 'full') return refused('full');
        try {
          await driver.upsertSchedule(body.scheduleRef, slot, body.windows, body.holidays);
        } catch (err) {
          if (!existed) slots.release(controllerId, body.scheduleRef); // jamais d'attribution fantome
          throw err;
        }
        persist();
        return { result: 'done' };
      }
      case 'delete_schedule': {
        if (!supported('deleteSchedule')) return refused('not_supported');
        const slot = slots.get(controllerId, body.scheduleRef);
        if (slot === null) return { result: 'done' };
        await driver.deleteSchedule(body.scheduleRef, slot);
        slots.release(controllerId, body.scheduleRef);
        persist();
        return { result: 'done' };
      }
      case 'set_holidays':
        if (!supported('setHolidays')) return refused('not_supported');
        await driver.setHolidays(body.dates, body.replace);
        return { result: 'done' };
    }
  }

  async function execute(body: AccessSyncBody, opId: string | undefined): Promise<ActuatorOutcome> {
    let out: ActuatorOutcome;
    try {
      out = await run(body);
    } catch (err) {
      out = outcomeOf(err);
      if (!(err instanceof ActuatorFailure)) note('unexpected', 'warn', `controleur ${controllerId} : exception inattendue pendant une synchronisation (${err instanceof Error ? err.name : 'erreur'})`);
    }
    // Journal : nature et resultat seulement. Jamais de nom, de numero de badge ni de reference de titulaire.
    note(`${body.type}:${out.result}:${out.code ?? ''}`, out.result === 'done' ? 'info' : 'warn', `controleur ${controllerId} : synchronisation ${body.type} -> ${out.result}${out.code ? ` (${out.code})` : ''}${opId ? ` [op ${opId.slice(0, 8)}]` : ''}`);
    return out;
  }

  return (op) => {
    try {
      const parsed = parseSyncBody(op);
      if (!parsed.ok) {
        note('invalid', 'warn', `controleur ${controllerId} : ordre de synchronisation refuse (${parsed.error})`);
        return Promise.resolve(refused('invalid'));
      }
      if (waiting >= maxQueue) {
        note('busy', 'warn', `controleur ${controllerId} : trop de synchronisations en attente`);
        return Promise.resolve({ result: 'error', code: 'busy' });
      }
      const { opId, seq: _seq, ...body } = parsed.op;
      waiting++;
      const result = tail.then(() => execute(body as AccessSyncBody, opId));
      // La file avance quoi qu'il arrive (execute ne leve pas, mais on ne le suppose pas).
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result.finally(() => {
        waiting--;
      });
    } catch {
      return Promise.resolve({ result: 'error', code: 'io' });
    }
  };
}
