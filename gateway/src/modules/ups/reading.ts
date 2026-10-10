import type { MeasureKey } from './config.ts';

/** Etat de l'alimentation, deja resume : sur batterie ou non, et gravite du defaut de l'onduleur. */
export interface UpsStatus {
  onBattery: boolean;
  /** `low_battery` : batterie faible ou a remplacer ; `fault` : surcharge, alarme, onduleur eteint. */
  degrade: 'none' | 'low_battery' | 'fault';
}

/** Lecture normalisee, quel que soit le transport. Unites canoniques : %, secondes, volts, degres C. */
export interface UpsReading {
  status?: UpsStatus | undefined;
  values: Partial<Record<MeasureKey, number>>;
}
