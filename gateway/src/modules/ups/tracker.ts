import type { DeviceMessage } from '../../module.ts';
import { MEASURE_KEYS } from './config.ts';
import type { IdKey, MeasureKey, UpsConfig } from './config.ts';
import type { UpsReading, UpsStatus } from './reading.ts';

/** Message a envoyer pour un identifiant PSIM, sans ts ni msgId (ajoutes par l'appelant). */
export interface Emission {
  deviceId: string;
  kind: string;
  msg: DeviceMessage;
}

type Settings = Pick<UpsConfig, 'ids' | 'runtimeUnit' | 'heartbeatMs' | 'minIntervalMs' | 'deadband' | 'maxFailures'>;

const BASELINE: UpsStatus = { onBattery: false, degrade: 'none' };

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Messages a envoyer quand l'alimentation passe de `prev` a `cur`. `prev = null` : premiere lecture (ou retour
 * apres injoignabilite) ; on pose alors la base : un onduleur normal donne « normal » une seule fois.
 * Le PSIM garde le dernier etat recu : apres chaque changement, le dernier message reflete la situation la plus
 * grave encore presente.
 */
export function statusMessages(prev: UpsStatus | null, cur: UpsStatus): Array<{ kind: string; msg: DeviceMessage }> {
  const out: Array<{ kind: string; msg: DeviceMessage }> = [];
  const before = prev ?? BASELINE;
  const batteryChanged = before.onBattery !== cur.onBattery;
  if (batteryChanged) {
    out.push(cur.onBattery ? { kind: 'power_loss', msg: { event: 'power_loss' } } : { kind: 'power_restored', msg: { event: 'power_restored' } });
  }
  if (cur.degrade !== 'none') {
    if (before.degrade !== cur.degrade || batteryChanged) {
      const event = cur.degrade === 'low_battery' ? 'low_battery' : 'fault';
      out.push({ kind: event, msg: { event } });
    }
  } else if (before.degrade !== 'none') {
    if (cur.onBattery) {
      if (!batteryChanged) out.push({ kind: 'power_loss', msg: { event: 'power_loss' } });
    } else {
      out.push({ kind: 'normal', msg: { state: 'normal' } });
    }
  } else if (prev === null && out.length === 0) {
    out.push({ kind: 'normal', msg: { state: 'normal' } });
  }
  return out;
}

/** Memoire d'un onduleur : ne produit un message que sur changement, signe de vie ou grandeur utile. */
export class UpsTracker {
  private readonly s: Settings;
  private prevStatus: UpsStatus | null = null;
  private lastStatusEmit = Number.NEGATIVE_INFINITY;
  private readonly measures = new Map<MeasureKey, { last: number; at: number }>();
  private readonly needsClear = new Set<MeasureKey>();
  private fails = 0;
  private faulted = false;

  constructor(settings: Settings) {
    this.s = settings;
  }

  get isFaulted(): boolean {
    return this.faulted;
  }

  private ids(): Array<[IdKey, string]> {
    return Object.entries(this.s.ids) as Array<[IdKey, string]>;
  }

  /** Une lecture reussie. `recovered` : l'onduleur etait declare en defaut et redevient joignable. */
  onReading(reading: UpsReading, now: number): { emissions: Emission[]; recovered: boolean; hadFailures: boolean } {
    const hadFailures = this.fails > 0;
    const recovered = this.faulted;
    this.fails = 0;
    if (this.faulted) {
      // Retour apres defaut : on repart de zero pour que chaque identifiant recoive un etat explicite.
      this.faulted = false;
      this.prevStatus = null;
      this.measures.clear();
      for (const [k] of this.ids()) if (k !== 'status') this.needsClear.add(k);
    }
    const emissions: Emission[] = [];

    const statusId = this.s.ids.status;
    if (statusId && reading.status) {
      let msgs = statusMessages(this.prevStatus, reading.status);
      this.prevStatus = reading.status;
      if (msgs.length === 0 && this.s.heartbeatMs > 0 && now - this.lastStatusEmit >= this.s.heartbeatMs) {
        msgs = [{ kind: 'heartbeat', msg: { event: 'heartbeat' } }];
      }
      if (msgs.length > 0) this.lastStatusEmit = now;
      for (const m of msgs) emissions.push({ deviceId: statusId, kind: m.kind, msg: m.msg });
    }

    for (const key of MEASURE_KEYS) {
      const deviceId = this.s.ids[key];
      const raw = reading.values[key];
      if (!deviceId || raw === undefined) continue;
      const v = round1(key === 'runtime' && this.s.runtimeUnit === 'min' ? raw / 60 : raw);
      const mem = this.measures.get(key);
      if (mem) {
        const diff = Math.abs(v - mem.last);
        const changed = diff > 0 && diff >= this.s.deadband[key] && now - mem.at >= this.s.minIntervalMs;
        const refresh = this.s.heartbeatMs > 0 && now - mem.at >= this.s.heartbeatMs;
        if (!changed && !refresh) continue;
      }
      if (this.needsClear.delete(key)) emissions.push({ deviceId, kind: `clear-${key}`, msg: { state: 'normal' } });
      emissions.push({ deviceId, kind: key, msg: { value: v } });
      this.measures.set(key, { last: v, at: now });
    }
    return { emissions, recovered, hadFailures };
  }

  /** Un echec de lecture. `fault` : le seuil d'echecs consecutifs vient d'etre atteint (une seule fois). */
  onFailure(): { emissions: Emission[]; first: boolean; fault: boolean } {
    this.fails++;
    const first = this.fails === 1;
    if (this.fails < this.s.maxFailures || this.faulted) return { emissions: [], first, fault: false };
    this.faulted = true;
    const emissions = this.ids().map(([, deviceId]): Emission => ({ deviceId, kind: 'fault', msg: { state: 'fault' } }));
    return { emissions, first, fault: true };
  }
}
