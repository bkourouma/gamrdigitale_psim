import type { DatabaseSync } from 'node:sqlite';
import { PsimError } from './engine.ts';

/**
 * Armement des zones d'intrusion. Un detecteur d'intrusion (mouvement, bris de vitre) n'a de sens que lorsque
 * la zone est vide : en journee il declencherait en permanence. Une zone est donc « armee » ou « desarmee ».
 *
 * Etat effectif d'une zone, du plus prioritaire au moins prioritaire :
 *  1. une DEROGATION manuelle (armer / desarmer) ET encore valable : elle expire toujours (24 h maximum), de sorte
 *     qu'un desarmement oublie ne laisse jamais une zone non surveillee indefiniment ;
 *  2. le PLANNING hebdomadaire, s'il y en a un : armee dans les plages definies, desarmee en dehors ;
 *  3. sinon la zone est armee en permanence (comportement par defaut : rien ne change tant qu'on ne configure rien).
 *
 * Ce que le desarmement ne masque JAMAIS (voir engine.ts) : le sabotage (`tamper`), l'alarme de panique, et tout
 * ce qui n'est pas de l'intrusion (incendie, acces, environnement). Seuls les detecteurs d'intrusion sont concernes.
 */

export const DAYS = [0, 1, 2, 3, 4, 5, 6] as const; // 0 = dimanche (comme Date.getDay)
export const MAX_OVERRIDE_HOURS = 24;
const MAX_WINDOWS = 14;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface Window {
  /** Jours de DEBUT de la plage (0 = dimanche). Une plage 22:00 -> 06:00 du lundi couvre la nuit de lundi a mardi. */
  days: number[];
  from: string;
  to: string;
}

export interface Override {
  mode: 'armed' | 'disarmed';
  until: number;
  by: string;
  at: number;
}

export interface ZoneArming {
  zone: string;
  armed: boolean;
  /** Pourquoi la zone est dans cet etat : « override », « schedule » ou « default ». */
  source: 'override' | 'schedule' | 'default';
  schedule: Window[] | null;
  override: Override | null;
  /** Prochain changement d'etat prevu (planning ou fin de derogation), ou null. */
  nextChange: number | null;
}

const minutesOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/** Valide un planning ; renvoie le planning normalise (jours tries, sans doublon) ou leve une erreur 400. */
export function parseSchedule(input: unknown): Window[] | null {
  if (input === null || input === undefined) return null;
  if (!Array.isArray(input)) throw new PsimError(400, 'planning invalide : une liste de plages est attendue');
  if (input.length === 0) throw new PsimError(400, 'planning vide : supprimez-le pour armer la zone en permanence');
  if (input.length > MAX_WINDOWS) throw new PsimError(400, `trop de plages (${MAX_WINDOWS} maximum)`);
  return input.map((raw, i) => {
    const w = raw as Partial<Window> | null;
    const n = i + 1;
    if (typeof w !== 'object' || w === null) throw new PsimError(400, `plage ${n} invalide`);
    if (!Array.isArray(w.days) || w.days.length === 0 || w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new PsimError(400, `plage ${n} : jours invalides (0 = dimanche ... 6 = samedi)`);
    }
    if (typeof w.from !== 'string' || typeof w.to !== 'string' || !TIME.test(w.from) || !TIME.test(w.to)) {
      throw new PsimError(400, `plage ${n} : heures invalides (HH:MM)`);
    }
    // from == to ne designerait ni « jamais » ni « toujours » sans ambiguite : refuse.
    if (w.from === w.to) throw new PsimError(400, `plage ${n} : debut et fin identiques`);
    return { days: [...new Set(w.days)].sort((a, b) => a - b), from: w.from, to: w.to };
  });
}

/** La date `ts` (heure locale du serveur) est-elle dans l'une des plages ? */
export function inSchedule(windows: Window[], ts: number): boolean {
  const d = new Date(ts);
  const day = d.getDay();
  const minute = d.getHours() * 60 + d.getMinutes();
  for (const w of windows) {
    const from = minutesOf(w.from);
    const to = minutesOf(w.to);
    if (from < to) {
      if (w.days.includes(day) && minute >= from && minute < to) return true;
    } else {
      // Plage a cheval sur minuit : la partie du soir appartient au jour de debut, celle du matin au lendemain.
      if (w.days.includes(day) && minute >= from) return true;
      if (w.days.includes((day + 6) % 7) && minute < to) return true;
    }
  }
  return false;
}

export function createArming(db: DatabaseSync, audit: (actor: string, action: string, ref?: { details?: string }) => void, now: () => number = Date.now, onChange: () => void = () => {}) {
  type Row = Record<string, unknown>;
  const lastKnown = new Map<string, boolean>();

  function row(zone: string): Row | undefined {
    return db.prepare('SELECT * FROM arming_zone WHERE zone = ?').get(zone) as Row | undefined;
  }

  /** `withNext` : calcule aussi le prochain changement (couteux : a eviter sur le chemin des alarmes). */
  function stateOf(zone: string, ts = now(), withNext = true): ZoneArming {
    const r = row(zone);
    const schedule = r?.schedule ? (JSON.parse(r.schedule as string) as Window[]) : null;
    const override: Override | null =
      r?.override_mode && (r.override_until as number) > ts
        ? { mode: r.override_mode as Override['mode'], until: r.override_until as number, by: r.override_by as string, at: r.override_at as number }
        : null;
    const compute = (t: number): { armed: boolean; source: ZoneArming['source'] } => {
      if (override && t < override.until) return { armed: override.mode === 'armed', source: 'override' };
      if (schedule) return { armed: inSchedule(schedule, t), source: 'schedule' };
      return { armed: true, source: 'default' };
    };
    const current = compute(ts);
    // Prochain changement : on balaie les 8 prochains jours minute par minute (peu couteux, et sans cas particulier).
    let nextChange: number | null = null;
    if (withNext && (override || schedule)) {
      const step = 60_000;
      const start = Math.floor(ts / step) * step;
      const limit = 8 * 24 * 60;
      for (let i = 1; i <= limit; i++) {
        const t = start + i * step;
        if (compute(t).armed !== current.armed) {
          nextChange = t;
          break;
        }
      }
    }
    return { zone, armed: current.armed, source: current.source, schedule, override, nextChange };
  }

  /** Zones qui ont au moins un detecteur d'intrusion (les seules concernees) ou une configuration. */
  function zones(): string[] {
    const names = new Set<string>();
    for (const r of db.prepare("SELECT DISTINCT zone FROM device WHERE kind = 'detector' AND category = 'intrusion' AND zone <> ''").all() as Row[]) names.add(r.zone as string);
    for (const r of db.prepare('SELECT zone FROM arming_zone').all() as Row[]) names.add(r.zone as string);
    return [...names].sort((a, b) => a.localeCompare(b, 'fr'));
  }

  const list = (): ZoneArming[] => zones().map((z) => stateOf(z));

  /** Utilise par le moteur a chaque message d'intrusion. Une zone inconnue ou sans nom est armee. */
  function isArmed(zone: string): boolean {
    if (!zone) return true;
    return stateOf(zone, now(), false).armed;
  }

  function checkZone(zone: unknown): string {
    if (typeof zone !== 'string' || zone.trim() === '' || zone.length > 80) throw new PsimError(400, 'zone invalide');
    const known = db.prepare("SELECT 1 AS x FROM device WHERE kind = 'detector' AND category = 'intrusion' AND zone = ? LIMIT 1").get(zone);
    if (!known && !row(zone)) throw new PsimError(404, "Aucun detecteur d'intrusion dans cette zone");
    return zone;
  }

  function upsert(zone: string, fields: Record<string, unknown>): void {
    if (!row(zone)) db.prepare('INSERT INTO arming_zone (zone) VALUES (?)').run(zone);
    const keys = Object.keys(fields);
    db.prepare(`UPDATE arming_zone SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE zone = ?`).run(...(keys.map((k) => fields[k]) as never[]), zone);
  }

  const describe = (s: ZoneArming) => (s.armed ? 'armee' : 'desarmee');

  /** Arme ou desarme une zone pour `hours` heures au plus ; ensuite le planning (ou l'armement permanent) reprend. */
  function setOverride(actor: string, zoneName: unknown, mode: unknown, hours: unknown): ZoneArming {
    const zone = checkZone(zoneName);
    if (mode !== 'armed' && mode !== 'disarmed') throw new PsimError(400, 'mode doit etre armed ou disarmed');
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > MAX_OVERRIDE_HOURS) {
      throw new PsimError(400, `duree invalide : de quelques minutes a ${MAX_OVERRIDE_HOURS} h (une derogation expire toujours)`);
    }
    const t = now();
    upsert(zone, { override_mode: mode, override_until: t + Math.round(hours * 3_600_000), override_by: actor, override_at: t });
    lastKnown.set(zone, stateOf(zone, now(), false).armed);
    audit(actor, mode === 'armed' ? 'zone_armed' : 'zone_disarmed', { details: `${zone} : ${mode === 'armed' ? 'armement' : 'desarmement'} manuel pour ${hours} h` });
    onChange();
    return stateOf(zone);
  }

  /** Annule la derogation : la zone reprend son planning. */
  function clearOverride(actor: string, zoneName: unknown): ZoneArming {
    const zone = checkZone(zoneName);
    upsert(zone, { override_mode: null, override_until: null, override_by: null, override_at: null });
    const s = stateOf(zone);
    lastKnown.set(zone, s.armed);
    audit(actor, s.armed ? 'zone_armed' : 'zone_disarmed', { details: `${zone} : derogation annulee, zone ${describe(s)} (${s.source === 'schedule' ? 'planning' : 'arme en permanence'})` });
    onChange();
    return s;
  }

  function setSchedule(actor: string, zoneName: unknown, input: unknown): ZoneArming {
    const zone = checkZone(zoneName);
    const windows = parseSchedule(input);
    upsert(zone, { schedule: windows ? JSON.stringify(windows) : null });
    const s = stateOf(zone);
    lastKnown.set(zone, s.armed);
    audit(actor, 'arming_schedule', { details: `${zone} : ${windows ? `${windows.length} plage(s), zone ${describe(s)} maintenant` : 'planning supprime, zone armee en permanence'}` });
    onChange();
    return s;
  }

  /** Controle periodique : journalise et diffuse les changements d'etat dus au planning ou a la fin d'une derogation. */
  function tick(): void {
    for (const zone of zones()) {
      const s = stateOf(zone, now(), false);
      const before = lastKnown.get(zone);
      lastKnown.set(zone, s.armed);
      if (before === undefined || before === s.armed) continue;
      audit('systeme', s.armed ? 'zone_armed' : 'zone_disarmed', { details: `${zone} : ${s.armed ? 'armement' : 'desarmement'} automatique (${s.source === 'schedule' ? 'planning' : s.source === 'override' ? 'derogation' : 'fin de derogation'})` });
      onChange();
    }
  }

  /** Photographie pour l'interface : etat effectif par zone. */
  function snapshot(): Record<string, boolean> {
    return Object.fromEntries(zones().map((z) => [z, stateOf(z, now(), false).armed]));
  }

  return { list, get: stateOf, isArmed, setOverride, clearOverride, setSchedule, tick, snapshot };
}

export type Arming = ReturnType<typeof createArming>;
