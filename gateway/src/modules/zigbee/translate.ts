/**
 * Traduction d'un message Zigbee2MQTT (charge JSON d'un equipement) en messages PSIM.
 *
 * Fonction pure autour d'un petit etat par equipement (derniere valeur envoyee, verrou de batterie...) :
 * - les champs inconnus sont ignores ;
 * - une valeur identique a la precedente n'est pas renvoyee (Zigbee2MQTT republie tout l'etat a chaque
 *   changement, meme du seul niveau de signal) ;
 * - l'etat n'est mis a jour qu'au moment du `commit()` : si l'envoi est refuse (plafond de debit), le
 *   prochain message identique sera de nouveau propose.
 */

import type { DeviceMessage } from '../../module.ts';
import { makeMsgId } from '../../msgid.ts';
import type { DeviceSpec } from './config.ts';

/** Un message a envoyer, avec la mise a jour d'etat a appliquer une fois l'envoi accepte. */
export interface Candidate {
  deviceId: string;
  message: DeviceMessage;
  commit(): void;
}

export interface TrackerState {
  bools: Map<string, boolean>;
  boolAt: Map<string, number>;
  nums: Map<string, number>;
  numAt: Map<string, number>;
  batteryLow: boolean;
}

export function newTracker(): TrackerState {
  return { bools: new Map(), boolAt: new Map(), nums: new Map(), numAt: new Map(), batteryLow: false };
}

export interface TranslateOptions {
  now: number;
  batteryLowPercent: number;
}

/** Un niveau de batterie doit remonter de cette marge au-dessus du seuil pour lever le verrou « batterie faible ». */
export const BATTERY_HYSTERESIS = 5;

/** Plausibilite des mesures : au-dela, la valeur est ignoree (capteur defaillant, trame corrompue). */
const TEMP_RANGE: readonly [number, number] = [-80, 200];
const HUMIDITY_RANGE: readonly [number, number] = [0, 100];

function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function asNum(v: unknown, range: readonly [number, number]): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= range[0] && v <= range[1] ? v : undefined;
}

/**
 * Horodatage du message Zigbee2MQTT (`last_seen`), en ms epoch entier, ou undefined s'il est absent ou
 * invraisemblable. Zigbee2MQTT sait l'ecrire en ISO 8601, ISO local, ou en epoch (ms).
 */
export function messageTs(lastSeen: unknown, now: number): number | undefined {
  let ms: number | undefined;
  if (typeof lastSeen === 'number' && Number.isFinite(lastSeen)) {
    ms = lastSeen < 1e11 ? lastSeen * 1000 : lastSeen; // secondes ou millisecondes
  } else if (typeof lastSeen === 'string' && lastSeen !== '' && lastSeen.length <= 64) {
    const parsed = Date.parse(lastSeen);
    if (Number.isFinite(parsed)) ms = parsed;
  }
  if (ms === undefined) return undefined;
  ms = Math.round(ms);
  if (ms < 946684800000) return undefined; // avant l'an 2000 : horloge de l'equipement non reglee
  if (ms > now + 5 * 60_000) return undefined; // dans le futur : decalage d'horloge, on laisse le socle dater
  return ms;
}

/**
 * Traduit un message. `payload` est la charge JSON deja decodee (objet). `ts` est l'heure du message si connue.
 * Ordre d'emission : batterie, puis mesures/alarmes propres au type, puis action (panique), puis sabotage ; ainsi
 * une alarme n'est jamais « ecrasee » par un defaut de batterie arrive dans le meme message.
 */
export function translate(spec: DeviceSpec, t: TrackerState, payload: Record<string, unknown>, ts: number | undefined, opts: TranslateOptions): Candidate[] {
  const out: Candidate[] = [];
  const { now } = opts;

  const withTs = (m: DeviceMessage, field: string, value: string | number): DeviceMessage => {
    if (ts !== undefined) {
      m.ts = ts;
      // Nom Zigbee2MQTT libre (espaces, accents, « / », 100 caracteres...) : makeMsgId le nettoie et le borne a 64
      // caracteres (empreinte de l'original si besoin), sans perdre le determinisme qui sert a l'anti-doublon du PSIM.
      m.msgId = makeMsgId(spec.key, ts, field, value);
    }
    return m;
  };

  /**
   * Champ booleen a front : propose un message quand la valeur change (ou, pour une valeur « active », au
   * bout de repeatEveryS pour qu'une alarme remise a zero a la main alors que la cause persiste reparte).
   */
  const edge = (field: string, value: boolean, repeatWhenTrue: boolean, build: (v: boolean) => DeviceMessage | null): void => {
    const prev = t.bools.get(field);
    const changed = prev === undefined || prev !== value;
    const repeat = !changed && repeatWhenTrue && value && now - (t.boolAt.get(field) ?? 0) >= spec.repeatEveryS * 1000;
    if (!changed && !repeat) return;
    const built = build(value);
    const commit = () => {
      t.bools.set(field, value);
      t.boolAt.set(field, now);
    };
    if (built === null) {
      commit(); // rien a envoyer (ex. fin de sabotage), mais on memorise
      return;
    }
    out.push({ deviceId: spec.id, message: withTs(built, field, value ? 1 : 0), commit });
  };

  /**
   * Action ponctuelle (appui sur un bouton) : chaque appui compte, donc pas de deduplication par valeur. Si le
   * message est date, une meme heure n'est traitee qu'une fois (Zigbee2MQTT peut remettre l'action dans un
   * message ulterieur ; sans last_seen, impossible de le distinguer d'un nouvel appui).
   */
  const pulse = (event: string, action: string): void => {
    const key = `action_${event}`;
    if (ts !== undefined && t.nums.get(key) === ts) return;
    out.push({
      deviceId: spec.id,
      message: withTs({ event }, 'action', action),
      commit: () => {
        if (ts !== undefined) t.nums.set(key, ts);
      },
    });
  };

  /** Mesure : envoyee si elle a bouge d'au moins `minDelta`, ou si `repeatEveryS` s'est ecoule. */
  const measure = (field: string, deviceId: string, value: number, minDelta: number): void => {
    const prev = t.nums.get(field);
    const due = prev === undefined || Math.abs(value - prev) >= minDelta - 1e-9 || now - (t.numAt.get(field) ?? 0) >= spec.repeatEveryS * 1000;
    if (!due) return;
    out.push({
      deviceId,
      message: withTs({ value }, field, value),
      commit: () => {
        t.nums.set(field, value);
        t.numAt.set(field, now);
      },
    });
  };

  // 1. Batterie : seulement au franchissement du seuil, verrou leve apres une remontee franche.
  const batteryFlag = asBool(payload.battery_low);
  const pct = asNum(payload.battery, [0, 100]);
  const lowNow = batteryFlag === true || (pct !== undefined && pct <= opts.batteryLowPercent);
  if (lowNow && !t.batteryLow) {
    out.push({
      deviceId: spec.id,
      message: withTs({ event: 'low_battery' }, 'battery', pct ?? 1),
      commit: () => {
        t.batteryLow = true;
      },
    });
  } else if (!lowNow && t.batteryLow) {
    const recovered = pct !== undefined ? pct > opts.batteryLowPercent + BATTERY_HYSTERESIS : batteryFlag === false;
    if (recovered) t.batteryLow = false;
  }

  // 2. Champs propres au type d'equipement
  switch (spec.kind) {
    case 'motion': {
      const field = typeof payload.occupancy === 'boolean' ? 'occupancy' : 'presence';
      const v = asBool(payload[field]);
      if (v !== undefined) edge('motion', v, true, (on) => ({ event: on ? 'motion' : 'clear' }));
      break;
    }
    case 'contact': {
      // Zigbee2MQTT : contact = true quand le contact est ferme (porte fermee).
      const v = asBool(payload.contact);
      if (v !== undefined) edge('contact', v, false, (closed) => ({ event: closed ? 'door_closed' : 'door_opened' }));
      break;
    }
    case 'leak': {
      const v = asBool(payload.water_leak);
      if (v !== undefined) edge('water_leak', v, true, (wet) => ({ event: wet ? 'leak' : 'dry' }));
      break;
    }
    case 'temperature': {
      const temp = asNum(payload.temperature, TEMP_RANGE);
      if (temp !== undefined) measure('temperature', spec.id, temp, spec.minDelta);
      const hum = asNum(payload.humidity, HUMIDITY_RANGE);
      if (hum !== undefined && spec.humidityId !== undefined) measure('humidity', spec.humidityId, hum, spec.humidityMinDelta);
      break;
    }
    case 'smoke': {
      const v = asBool(payload.smoke);
      if (v !== undefined) edge('smoke', v, true, (on) => ({ state: on ? 'alarm' : 'normal' }));
      break;
    }
    case 'gas': {
      const v = asBool(payload.gas);
      if (v !== undefined) edge('gas', v, true, (on) => ({ event: on ? 'gas' : 'clear' }));
      break;
    }
    case 'co': {
      const v = asBool(payload.carbon_monoxide);
      if (v !== undefined) edge('carbon_monoxide', v, true, (on) => ({ event: on ? 'co' : 'clear' }));
      break;
    }
    case 'vibration': {
      const v = asBool(payload.vibration);
      if (v !== undefined) edge('vibration', v, true, (on) => ({ event: on ? 'vibration' : 'clear' }));
      else if (payload.action === 'vibration' || payload.action === 'tilt' || payload.action === 'drop') pulse('vibration', String(payload.action));
      break;
    }
    case 'panic':
    case 'tamper_only':
      break;
  }

  // 3. Bouton d'urgence : action ponctuelle (jamais dedupliquee, chaque appui compte)
  if (payload.action === 'emergency' || payload.action === 'panic') pulse('panic', String(payload.action));

  // 4. Sabotage : sur un contact de porte, c'est une tentative d'effraction ; ailleurs, un sabotage simple.
  const tamper = asBool(payload.tamper);
  if (tamper !== undefined) {
    edge('tamper', tamper, true, (on) => (on ? { event: spec.kind === 'contact' ? 'door_forced' : 'tamper' } : null));
  }

  return out;
}
