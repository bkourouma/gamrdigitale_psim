/**
 * Traduction des codes d'evenement SIA-DCS (2 lettres) et Contact ID (3 chiffres) en messages PSIM.
 *
 * Principe : une table EXPLICITE. Un code absent de la table n'est jamais devine (pas d'alarme inventee) :
 * il est journalise une fois et ignore. L'installateur peut completer ou corriger la table par `overrides`.
 */
import type { DetectorState } from '../../module.ts';
import type { RawEvent } from './protocol.ts';

/**
 * - alarm / fault : evenement qui met l'equipement en alarme / en defaut ;
 * - restore-alarm / restore-fault : retour a la normale apres une alarme / un defaut ;
 * - heartbeat : signe de vie de la centrale (test cyclique, armement, desarmement) ;
 * - ignore : code connu, purement informatif, rien a transmettre.
 */
export type RuleKind = 'alarm' | 'fault' | 'restore-alarm' | 'restore-fault' | 'heartbeat' | 'ignore';

export interface Out {
  state?: DetectorState;
  event?: string;
}

export interface Rule {
  kind: RuleKind;
  /** Message PSIM (absent pour heartbeat / ignore). */
  out?: Out;
  /** Vrai : le numero transmis est une zone (detecteur) ; faux : evenement de la centrale (alimentation, armement...). */
  zone: boolean;
  /** Libelle francais (documentation, journaux). */
  label: string;
  /** Contact ID seulement : message a envoyer pour une restauration (qualificatif 3), si different de `restored`. */
  restoreOut?: Out;
}

/** Evenements PSIM que ce module peut produire, et leur effet (pour valider les `overrides`). */
export const PSIM_EVENTS: Readonly<Record<string, 'alarm' | 'prealarm' | 'normal' | 'fault' | 'alive'>> = {
  intrusion: 'alarm',
  motion: 'alarm',
  glass_break: 'alarm',
  tamper: 'alarm',
  panic: 'alarm',
  door_forced: 'alarm',
  forced_entry: 'alarm',
  leak: 'alarm',
  flood: 'alarm',
  over_temperature: 'alarm',
  gas: 'alarm',
  co: 'alarm',
  sos: 'alarm',
  fall: 'alarm',
  camera_masked: 'alarm',
  door_held_open: 'prealarm',
  normal: 'normal',
  clear: 'normal',
  restored: 'normal',
  door_closed: 'normal',
  alarm_reset: 'normal',
  power_restored: 'normal',
  fault: 'fault',
  low_battery: 'fault',
  power_loss: 'fault',
  heartbeat: 'alive',
  door_opened: 'alive',
};

const RESTORED: Out = { event: 'restored' };
const FIRE: Out = { state: 'alarm' };

const alarm = (out: Out, label: string, zone = true): Rule => ({ kind: 'alarm', out, zone, label });
const fault = (out: Out, label: string, zone = true, restoreOut?: Out): Rule => ({ kind: 'fault', out, zone, label, ...(restoreOut ? { restoreOut } : {}) });
const restoreAlarm = (label: string, out: Out = RESTORED, zone = true): Rule => ({ kind: 'restore-alarm', out, zone, label });
const restoreFault = (label: string, out: Out = RESTORED, zone = true): Rule => ({ kind: 'restore-fault', out, zone, label });
const beat = (label: string): Rule => ({ kind: 'heartbeat', zone: false, label });
const ignore = (label: string): Rule => ({ kind: 'ignore', zone: false, label });

/**
 * Familles SIA a suffixes reguliers : xA alarme, xH fin d'alarme, xR retablissement, xT derangement,
 * xJ fin de derangement, xB isolement (zone non surveillee), xU fin d'isolement, xS supervision.
 */
function family(letter: string, out: Out, name: string): Record<string, Rule> {
  return {
    [`${letter}A`]: alarm(out, `${name} : alarme`),
    [`${letter}H`]: restoreAlarm(`${name} : fin d'alarme`),
    [`${letter}R`]: restoreAlarm(`${name} : retablissement`),
    [`${letter}T`]: fault({ event: 'fault' }, `${name} : derangement`),
    [`${letter}J`]: restoreFault(`${name} : fin de derangement`),
    [`${letter}B`]: fault({ event: 'fault' }, `${name} : zone isolee (non surveillee)`),
    [`${letter}U`]: restoreFault(`${name} : fin d'isolement`),
    [`${letter}S`]: fault({ event: 'fault' }, `${name} : defaut de supervision`),
  };
}

export const SIA_CODES: Readonly<Record<string, Rule>> = {
  ...family('B', { event: 'intrusion' }, 'Intrusion'),
  BV: alarm({ event: 'intrusion' }, 'Intrusion verifiee'),
  BM: alarm({ event: 'intrusion' }, 'Intrusion (point croise)'),
  BG: alarm({ state: 'prealarm' }, 'Intrusion non verifiee'),
  BC: restoreAlarm('Intrusion : annulation', { event: 'alarm_reset' }),
  BX: beat('Intrusion : test'),
  ...family('F', FIRE, 'Incendie'),
  FX: beat('Incendie : test'),
  FI: ignore('Incendie : debut de test'),
  FK: ignore('Incendie : fin de test'),
  ...family('K', FIRE, 'Chaleur'),
  ...family('S', FIRE, 'Sprinkler'),
  ...family('G', { event: 'gas' }, 'Gaz'),
  ...family('H', { event: 'panic' }, 'Hold-up / agression'),
  ...family('P', { event: 'panic' }, 'Panique'),
  ...family('M', { event: 'sos' }, 'Medical'),
  ...family('Q', { event: 'sos' }, 'Urgence'),
  ...family('W', { event: 'leak' }, "Fuite d'eau"),
  ...family('Z', { state: 'alarm' }, 'Gel'),
  ...family('U', { state: 'alarm' }, 'Zone non typee'),
  TA: alarm({ event: 'tamper' }, 'Sabotage'),
  TR: restoreAlarm('Sabotage : retablissement'),
  TS: ignore('Debut de test'),
  TE: ignore('Fin de test'),
  TX: beat('Rapport de test'),
  JA: alarm({ event: 'tamper' }, "Code utilisateur : tentative d'effraction", false),
  DF: alarm({ event: 'door_forced' }, 'Porte forcee'),
  DD: ignore('Acces refuse'),
  DG: ignore('Acces accorde'),
  AT: fault({ event: 'power_loss' }, 'Perte secteur', false),
  AR: restoreFault('Retour secteur', { event: 'power_restored' }, false),
  YT: fault({ event: 'low_battery' }, 'Batterie de la centrale faible', false),
  YM: fault({ event: 'low_battery' }, 'Batterie de la centrale absente', false),
  YR: restoreFault('Batterie de la centrale retablie', RESTORED, false),
  YP: fault({ event: 'fault' }, "Defaut d'alimentation", false),
  YQ: restoreFault("Alimentation retablie", RESTORED, false),
  YC: fault({ event: 'fault' }, 'Echec de transmission', false),
  YS: fault({ event: 'fault' }, 'Derangement de transmission', false),
  YK: restoreFault('Transmission retablie', RESTORED, false),
  XT: fault({ event: 'low_battery' }, 'Pile faible (detecteur sans fil)'),
  XR: restoreFault('Pile du detecteur retablie'),
  XQ: fault({ event: 'fault' }, 'Brouillage radio', false),
  XH: restoreFault('Fin de brouillage radio', RESTORED, false),
  LT: fault({ event: 'fault' }, 'Derangement ligne telephonique', false),
  LR: restoreFault('Ligne telephonique retablie', RESTORED, false),
  ET: fault({ event: 'fault' }, "Derangement d'un module d'extension", false),
  ER: restoreFault("Module d'extension retabli", RESTORED, false),
  CL: beat('Armement (fermeture)'),
  CA: beat('Armement automatique'),
  CG: beat('Armement de groupe'),
  CF: beat('Armement force'),
  NL: beat('Armement partiel'),
  OP: beat('Desarmement (ouverture)'),
  OA: beat('Desarmement automatique'),
  OG: beat('Desarmement de groupe'),
  RP: beat('Test periodique automatique'),
  RX: beat('Test manuel'),
  RR: beat('Mise sous tension de la centrale'),
  RS: ignore('Telechargement de programmation reussi'),
  RB: ignore('Debut de programmation a distance'),
  LB: ignore('Debut de programmation locale'),
  LX: ignore('Fin de programmation locale'),
};

const cidRange = (from: number, to: number, rule: Rule): Record<string, Rule> => {
  const r: Record<string, Rule> = {};
  for (let c = from; c <= to; c++) r[String(c)] = rule;
  return r;
};

/** Contact ID : le qualificatif 3 (restauration) est traite a part (voir `translate`). */
export const CID_CODES: Readonly<Record<string, Rule>> = {
  '100': alarm({ event: 'sos' }, 'Urgence medicale'),
  '101': alarm({ event: 'sos' }, 'Urgence personnelle'),
  '102': fault({ event: 'fault' }, 'Absence de rapport', false),
  ...cidRange(110, 117, alarm(FIRE, 'Incendie')),
  '118': alarm({ state: 'prealarm' }, 'Incendie : presque alarme'),
  '120': alarm({ event: 'panic' }, 'Panique'),
  '121': alarm({ event: 'panic' }, 'Contrainte (code sous la menace)'),
  '122': alarm({ event: 'panic' }, 'Panique silencieuse'),
  '123': alarm({ event: 'panic' }, 'Panique sonore'),
  '130': alarm({ event: 'intrusion' }, 'Intrusion'),
  '131': alarm({ event: 'intrusion' }, 'Intrusion perimetrique'),
  '132': alarm({ event: 'intrusion' }, 'Intrusion interieure'),
  '133': alarm({ event: 'intrusion' }, 'Intrusion zone 24 h'),
  '134': alarm({ event: 'intrusion' }, 'Intrusion entree / sortie'),
  '135': alarm({ event: 'intrusion' }, 'Intrusion jour / nuit'),
  '136': alarm({ event: 'intrusion' }, 'Intrusion exterieure'),
  '137': alarm({ event: 'tamper' }, 'Sabotage'),
  '138': alarm({ state: 'prealarm' }, 'Intrusion : presque alarme'),
  '139': alarm({ event: 'intrusion' }, 'Intrusion verifiee'),
  '140': alarm({ state: 'alarm' }, 'Alarme generale'),
  '141': fault({ event: 'fault' }, 'Boucle de scrutation ouverte'),
  '142': fault({ event: 'fault' }, 'Boucle de scrutation en court-circuit'),
  '143': fault({ event: 'fault' }, "Defaut d'un module d'extension", false),
  '144': alarm({ event: 'tamper' }, 'Sabotage du detecteur'),
  '145': alarm({ event: 'tamper' }, "Sabotage d'un module d'extension", false),
  '146': alarm({ event: 'intrusion' }, 'Intrusion silencieuse'),
  '147': fault({ event: 'fault' }, 'Defaut de supervision du detecteur'),
  '150': alarm({ state: 'alarm' }, 'Alarme technique 24 h'),
  '151': alarm({ event: 'gas' }, 'Gaz detecte'),
  '154': alarm({ event: 'leak' }, "Fuite d'eau"),
  '155': alarm({ event: 'intrusion' }, 'Rupture de feuillard'),
  '156': fault({ event: 'fault' }, 'Derangement de jour'),
  '158': alarm({ event: 'over_temperature' }, 'Temperature haute'),
  '162': alarm({ event: 'co' }, 'Monoxyde de carbone'),
  ...cidRange(200, 206, fault({ event: 'fault' }, 'Supervision incendie')),
  '300': fault({ event: 'fault' }, 'Derangement systeme', false),
  '301': fault({ event: 'power_loss' }, 'Perte secteur', false, { event: 'power_restored' }),
  '302': fault({ event: 'low_battery' }, 'Batterie de la centrale faible', false),
  '303': fault({ event: 'fault' }, 'Erreur memoire (RAM)', false),
  '304': fault({ event: 'fault' }, 'Erreur memoire (ROM)', false),
  '305': ignore('Redemarrage du systeme'),
  '306': ignore('Programmation modifiee'),
  '307': fault({ event: 'fault' }, "Echec de l'autotest", false),
  '308': fault({ event: 'fault' }, 'Arret du systeme', false),
  '309': fault({ event: 'low_battery' }, 'Echec du test batterie', false),
  '310': fault({ event: 'fault' }, 'Defaut de terre', false),
  '311': fault({ event: 'low_battery' }, 'Batterie absente ou hors service', false),
  '312': fault({ event: 'fault' }, "Surintensite de l'alimentation", false),
  '313': ignore('Reinitialisation installateur'),
  ...cidRange(320, 322, fault({ event: 'fault' }, 'Derangement sirene / relais', false)),
  ...cidRange(330, 333, fault({ event: 'fault' }, 'Derangement peripherique', false)),
  '337': fault({ event: 'fault' }, "Module d'extension : perte d'alimentation", false),
  '338': fault({ event: 'low_battery' }, "Module d'extension : batterie faible", false),
  '339': ignore("Module d'extension : redemarrage"),
  '341': alarm({ event: 'tamper' }, "Module d'extension : sabotage", false),
  '342': fault({ event: 'power_loss' }, "Module d'extension : perte secteur", false, { event: 'power_restored' }),
  '343': fault({ event: 'fault' }, "Module d'extension : echec de l'autotest", false),
  '344': fault({ event: 'fault' }, 'Brouillage radio', false),
  ...cidRange(350, 356, fault({ event: 'fault' }, 'Derangement de transmission', false)),
  ...cidRange(370, 373, fault({ event: 'fault' }, 'Derangement de boucle')),
  ...cidRange(380, 382, fault({ event: 'fault' }, 'Derangement du detecteur')),
  '383': alarm({ event: 'tamper' }, 'Sabotage du detecteur'),
  '384': fault({ event: 'low_battery' }, 'Pile faible (detecteur sans fil)'),
  ...cidRange(385, 389, fault({ event: 'fault' }, 'Derangement du detecteur')),
  '391': fault({ event: 'fault' }, 'Derangement du detecteur'),
  '392': fault({ event: 'fault' }, 'Derangement du detecteur'),
  '393': fault({ event: 'fault' }, 'Entretien requis'),
  ...cidRange(400, 405, beat('Armement / desarmement')),
  '406': ignore('Annulation par un utilisateur'),
  ...cidRange(407, 409, beat('Armement / desarmement')),
  '441': beat('Armement partiel'),
  '442': beat('Armement partiel (cle)'),
  ...cidRange(570, 573, fault({ event: 'fault' }, 'Zone isolee (non surveillee)')),
  '574': fault({ event: 'fault' }, 'Groupe isole (non surveille)', false),
  '601': beat('Test manuel'),
  '602': beat('Test periodique'),
  '603': beat('Transmission radio periodique'),
  '604': beat('Test incendie'),
  '605': ignore('Rapport de statut a suivre'),
  '606': ignore('Ecoute / interpellation'),
  '607': ignore('Mode test de marche'),
  '608': beat('Test periodique (derangement present)'),
  '627': ignore('Entree en programmation'),
  '628': ignore('Sortie de programmation'),
};

/** Correction ou ajout de l'installateur : `'ignore'`, ou le message PSIM a produire. */
export type Override = 'ignore' | { event?: string; state?: DetectorState; kind?: 'alarm' | 'fault' | 'restore' | 'heartbeat'; zone?: boolean };

export interface Overrides {
  sia: Map<string, Rule>;
  cid: Map<string, Rule>;
}

/** Transforme une correction (deja validee) en regle. */
export function ruleFromOverride(code: string, o: Override): Rule {
  if (o === 'ignore') return ignore(`${code} (ignore par la configuration)`);
  const out: Out = o.state !== undefined ? { state: o.state } : { event: o.event as string };
  const effect = o.state ?? PSIM_EVENTS[o.event as string];
  const kind: RuleKind =
    o.kind === 'heartbeat' || effect === 'alive'
      ? 'heartbeat'
      : o.kind === 'restore' || effect === 'normal'
        ? 'restore-alarm'
        : o.kind === 'fault' || effect === 'fault' || effect === 'offline'
          ? 'fault'
          : 'alarm';
  return { kind, out: kind === 'heartbeat' ? undefined : out, zone: o.zone ?? kind !== 'heartbeat', label: `${code} (configuration)` } as Rule;
}

/**
 * Regle a appliquer a un evenement : corrections du compte, puis corrections generales, puis table.
 * `undefined` = code inconnu. Pour Contact ID, une restauration (qualificatif 3) d'une alarme ou d'un defaut
 * devient `restore-alarm` / `restore-fault`.
 */
export function translate(ev: RawEvent, overrides: readonly Overrides[]): Rule | undefined {
  let rule: Rule | undefined;
  for (const o of overrides) {
    rule = (ev.format === 'sia' ? o.sia : o.cid).get(ev.code);
    if (rule) break;
  }
  if (!rule) {
    const table = ev.format === 'sia' ? SIA_CODES : CID_CODES;
    rule = Object.hasOwn(table, ev.code) ? table[ev.code] : undefined;
  }
  if (!rule || ev.format !== 'cid' || ev.qualifier !== 'R') return rule;
  if (rule.kind === 'alarm') return { kind: 'restore-alarm', out: RESTORED, zone: rule.zone, label: `${rule.label} : retablissement` };
  if (rule.kind === 'fault') return { kind: 'restore-fault', out: rule.restoreOut ?? RESTORED, zone: rule.zone, label: `${rule.label} : retablissement` };
  return rule;
}
