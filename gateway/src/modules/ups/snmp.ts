import dgram from 'node:dgram';
import net from 'node:net';
import { randomInt } from 'node:crypto';
import { buildGetRequest, decodeResponse } from './ber.ts';
import type { MeasureKey } from './config.ts';
import type { UpsReading, UpsStatus } from './reading.ts';

/**
 * Client SNMP v1 / v2c minimal, LECTURE SEULE (UPS-MIB, RFC 1628). Une requete de lecture par OID :
 * un OID absent chez l'onduleur n'invalide pas les autres. Aucune requete d'ecriture n'existe dans ce code.
 */

/** OID de la RFC 1628 (UPS-MIB, 1.3.6.1.2.1.33). Les « .0 » sont les instances de variables scalaires. */
export const OID = {
  /** upsBatteryStatus : unknown(1) batteryNormal(2) batteryLow(3) batteryDepleted(4). */
  batteryStatus: '1.3.6.1.2.1.33.1.2.1.0',
  /** upsEstimatedMinutesRemaining : minutes. */
  estimatedMinutes: '1.3.6.1.2.1.33.1.2.3.0',
  /** upsEstimatedChargeRemaining : pourcentage. */
  estimatedCharge: '1.3.6.1.2.1.33.1.2.4.0',
  /** upsBatteryVoltage : 0,1 volt continu. */
  batteryVoltage: '1.3.6.1.2.1.33.1.2.5.0',
  /** upsBatteryTemperature : degres Celsius. */
  batteryTemperature: '1.3.6.1.2.1.33.1.2.7.0',
  /** upsOutputSource : other(1) none(2) normal(3) bypass(4) battery(5) booster(6) reducer(7). */
  outputSource: '1.3.6.1.2.1.33.1.4.1.0',
  /** Prefixe de upsInputVoltage (3.3.1.3) : colonne de table, suffixe = numero de ligne. Volts RMS. */
  inputVoltage: '1.3.6.1.2.1.33.1.3.3.1.3',
  /** Prefixe de upsOutputPercentLoad (4.4.1.5) : colonne de table, suffixe = numero de ligne. Pourcentage. */
  outputPercentLoad: '1.3.6.1.2.1.33.1.4.4.1.5',
} as const;

export interface SnmpTarget {
  host: string;
  port: number;
  community: string;
  version: '1' | '2c';
  timeoutMs: number;
  /** Numero de ligne (phase) pour les colonnes de table. */
  line: number;
}

const RETRIES = 1;

class SnmpTimeout extends Error {}

/** Une session = une socket UDP ; les requetes partent l'une apres l'autre. */
class SnmpSession {
  private readonly target: SnmpTarget;
  private readonly socket: dgram.Socket;
  private pending: { requestId: number; resolve: (n: number | null) => void } | null = null;
  private socketError: Error | null = null;
  private onSocketFail: ((e: Error) => void) | null = null;

  constructor(target: SnmpTarget) {
    this.target = target;
    this.socket = dgram.createSocket(net.isIPv6(target.host) ? 'udp6' : 'udp4');
    this.socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
    this.socket.on('error', (e) => {
      this.socketError = e;
      this.onSocketFail?.(new Error(`socket UDP : ${e.message}`));
    });
  }

  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    const p = this.pending;
    if (!p) return;
    // Une adresse IPv4 litterale doit repondre depuis elle-meme, sur le port interroge.
    if (net.isIPv4(this.target.host) && (rinfo.address !== this.target.host || rinfo.port !== this.target.port)) return;
    const decoded = decodeResponse(msg, this.target.community);
    if (!decoded.ok) return; // trame illisible : ignoree, on continue d'attendre la bonne
    const r = decoded.response;
    if (r.requestId !== p.requestId) return; // reponse d'une autre requete : ignoree
    if (r.version !== (this.target.version === '1' ? 0 : 1)) return;
    if (r.errorStatus !== 0) {
      // noSuchName (v1) : la grandeur n'existe pas ; autre erreur : traitee de meme, sans bloquer les autres OID.
      this.pending = null;
      p.resolve(null);
      return;
    }
    const vb = r.varbinds[0];
    if (!vb || r.varbinds.length !== 1) return;
    this.pending = null;
    p.resolve(vb.value.kind === 'number' ? vb.value.n : null);
  }

  private once(oid: string): Promise<number | null> {
    return new Promise<number | null>((resolve, reject) => {
      if (this.socketError) return reject(new Error(`socket UDP : ${this.socketError.message}`));
      const requestId = randomInt(1, 0x7fffffff);
      const packet = buildGetRequest(this.target.version === '1' ? 0 : 1, this.target.community, requestId, oid);
      const timer = setTimeout(() => {
        this.pending = null;
        this.onSocketFail = null;
        reject(new SnmpTimeout('delai depasse'));
      }, this.target.timeoutMs);
      this.pending = {
        requestId,
        resolve: (n) => {
          clearTimeout(timer);
          this.onSocketFail = null;
          resolve(n);
        },
      };
      this.onSocketFail = (e) => {
        clearTimeout(timer);
        this.pending = null;
        this.onSocketFail = null;
        reject(e);
      };
      try {
        this.socket.send(packet, this.target.port, this.target.host, (err) => {
          if (err) this.onSocketFail?.(new Error(`envoi SNMP impossible : ${err.message}`));
        });
      } catch (e) {
        this.onSocketFail?.(new Error(`envoi SNMP impossible : ${e instanceof Error ? e.message : 'erreur'}`));
      }
    });
  }

  /** Arret demande : la requete en cours est abandonnee tout de suite. */
  abort(): void {
    this.onSocketFail?.(new Error('arret demande'));
    this.close();
  }

  /** `null` : grandeur absente chez l'onduleur. Rejette en cas de delai ou d'erreur reseau. */
  async get(oid: string): Promise<number | null> {
    let last: Error = new Error('delai depasse');
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        return await this.once(oid);
      } catch (e) {
        if (!(e instanceof SnmpTimeout)) throw e;
        last = e;
      }
    }
    throw last;
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // deja fermee
    }
  }
}

/** UPS-MIB -> etat. Sans upsOutputSource, on ne peut pas dire « sur batterie » (reste faux). */
export function statusFromSnmp(source: number | null, battery: number | null): UpsStatus | undefined {
  if (source === null && battery === null) return undefined;
  const onBattery = source === 5;
  const degrade = battery === 3 || battery === 4 ? 'low_battery' : source === 2 ? 'fault' : 'none';
  return { onBattery, degrade };
}

/** Interroge l'onduleur pour les grandeurs demandees. Rejette si l'onduleur ne repond pas. */
export async function snmpFetch(target: SnmpTarget, wanted: ReadonlySet<MeasureKey | 'status'>, signal?: AbortSignal): Promise<UpsReading> {
  const session = new SnmpSession(target);
  const onAbort = () => session.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const reading: UpsReading = { values: {} };
    const check = () => {
      if (signal?.aborted) throw new Error('arret demande');
    };
    const read = async (oid: string): Promise<number | null> => {
      check();
      return session.get(oid);
    };
    if (wanted.has('status')) {
      const source = await read(OID.outputSource);
      const battery = await read(OID.batteryStatus);
      reading.status = statusFromSnmp(source, battery);
    }
    if (wanted.has('charge')) {
      const n = await read(OID.estimatedCharge);
      if (n !== null && n >= 0 && n <= 100) reading.values.charge = n;
    }
    if (wanted.has('runtime')) {
      const n = await read(OID.estimatedMinutes);
      if (n !== null && n >= 0 && n < 100_000_000) reading.values.runtime = n * 60;
    }
    if (wanted.has('battery_voltage')) {
      const n = await read(OID.batteryVoltage);
      if (n !== null && n >= 0) reading.values.battery_voltage = n / 10;
    }
    if (wanted.has('input_voltage')) {
      const n = await read(`${OID.inputVoltage}.${target.line}`);
      if (n !== null && n >= 0) reading.values.input_voltage = n;
    }
    if (wanted.has('load')) {
      const n = await read(`${OID.outputPercentLoad}.${target.line}`);
      if (n !== null && n >= 0) reading.values.load = n;
    }
    if (wanted.has('temperature')) {
      const n = await read(OID.batteryTemperature);
      if (n !== null) reading.values.temperature = n;
    }
    return reading;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    session.close();
  }
}
