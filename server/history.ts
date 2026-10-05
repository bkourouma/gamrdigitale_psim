/**
 * Historique des etats des equipements : la base de toute mesure de disponibilite et de temps d'arret.
 *
 * La table `device` ne garde que l'etat ACTUEL ; le journal d'audit, lui, cesse de noter les changements d'un equipement
 * qui oscille (voir engine.ts, FLAP_LIMIT). Aucun des deux ne permet donc de dire « ce detecteur a ete hors service
 * 3 h 12 min ce mois-ci ». Ici, chaque etat est une ligne avec son debut et sa fin (fin NULL = etat en cours).
 *
 * Trois notions, qu'il ne faut jamais melanger :
 *  - EN SERVICE : normal, prealarme, alarme. Un detecteur en alarme fonctionne : il ne compte pas comme une panne.
 *  - HORS SERVICE : defaut, hors ligne.
 *  - NON SURVEILLE : le PSIM etait arrete. On ne sait pas ce qui s'est passe ; ce temps n'est compte ni comme
 *    disponible ni comme indisponible, il est rapporte a part (sinon une coupure de courant ferait mentir le chiffre
 *    dans un sens ou dans l'autre).
 *
 * Sont suivis : les detecteurs, et les cameras REELLES (avec une source video), mesurees par un test de connexion
 * regulier (voir camerahealth.ts). Une camera simulee n'est pas mesuree : lui inventer 100 % de disponibilite serait faux.
 */
import type { DatabaseSync } from 'node:sqlite';

export const DOWN_STATES: ReadonlySet<string> = new Set(['fault', 'offline']);

/** Une periode d'arret d'un equipement : etats « defaut » et « hors ligne » consecutifs fusionnes. */
export interface Outage {
  deviceId: string;
  from: number;
  /** `null` : toujours en cours. */
  to: number | null;
  durationS: number;
  /** Etat qui a ouvert la periode : `fault` (le detecteur l'annonce) ou `offline` (il s'est tu). */
  cause: 'fault' | 'offline';
}

export interface Availability {
  upS: number;
  downS: number;
  unmonitoredS: number;
  /** `null` si rien n'a ete observe (jamais un 100 % invente). */
  pct: number | null;
}

export interface BlindPeriod {
  from: number;
  to: number;
  clean: boolean;
}

interface Interval {
  state: string;
  start: number;
  end: number;
  /** Etat encore en cours dans la base (pas seulement rogne par la fenetre demandee). */
  open: boolean;
}

/**
 * Note qu'un equipement est (maintenant) dans cet etat. Sans effet s'il y est deja : on peut donc l'appeler sans precaution.
 * L'etat precedent est clos au meme instant : aucun trou, aucun chevauchement.
 */
export function recordState(db: DatabaseSync, deviceId: string, state: string, at: number): void {
  const open = db.prepare('SELECT id, state, started_at FROM device_state_history WHERE device_id = ? AND ended_at IS NULL').get(deviceId) as
    | { id: number; state: string; started_at: number }
    | undefined;
  if (open?.state === state) return;
  // Horloge revenue en arriere : jamais de duree negative.
  const t = open ? Math.max(at, open.started_at) : at;
  if (open) db.prepare('UPDATE device_state_history SET ended_at = ? WHERE id = ?').run(t, open.id);
  db.prepare('INSERT INTO device_state_history (device_id, state, started_at) VALUES (?, ?, ?)').run(deviceId, state, t);
}

/**
 * A appeler une fois au demarrage du PSIM. Les etats ouverts sont clos au dernier signe de vie (le temps entre ce
 * moment et maintenant n'a pas ete surveille), puis rouverts a l'instant present avec l'etat reellement connu.
 * `previousAlive` : dernier signe de vie du demarrage precedent (null = premier demarrage).
 */
export function beginHistory(db: DatabaseSync, now: number, previousAlive: number | null, gap: BlindPeriod | null): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const open = db.prepare('SELECT id, started_at FROM device_state_history WHERE ended_at IS NULL').all() as { id: number; started_at: number }[];
    const close = db.prepare('UPDATE device_state_history SET ended_at = ? WHERE id = ?');
    for (const row of open) {
      const end = previousAlive !== null && previousAlive <= now ? previousAlive : row.started_at;
      close.run(Math.max(end, row.started_at), row.id);
    }
    const insert = db.prepare('INSERT INTO device_state_history (device_id, state, started_at) VALUES (?, ?, ?)');
    const devices = db.prepare("SELECT id, status, state_since FROM device WHERE kind = 'detector'").all() as { id: string; status: string; state_since: number | null }[];
    for (const d of devices) {
      // Un detecteur sans historique (premiere mise en route de cette fonction) est date de son dernier changement connu.
      const known = db.prepare('SELECT 1 AS x FROM device_state_history WHERE device_id = ? LIMIT 1').get(d.id);
      const since = !known && d.state_since !== null && d.state_since <= now ? d.state_since : now;
      insert.run(d.id, d.status, since);
    }
    // Camera reelle : son etat n'est pas dans `device.status` mais dans son dernier etat mesure, qui reprend ici. Jamais
    // mesuree : rien a reprendre, le premier test (quelques secondes apres le demarrage) le dira.
    const cameras = db.prepare("SELECT d.id FROM device d JOIN camera_source c ON c.device_id = d.id WHERE d.kind = 'camera'").all() as { id: string }[];
    for (const c of cameras) {
      const last = db.prepare('SELECT state FROM device_state_history WHERE device_id = ? ORDER BY started_at DESC, id DESC LIMIT 1').get(c.id) as { state: string } | undefined;
      if (last) insert.run(c.id, last.state, now);
    }
    if (gap) db.prepare('INSERT INTO blind_period (from_ts, to_ts, clean) VALUES (?, ?, ?)').run(gap.from, gap.to, gap.clean ? 1 : 0);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Supprime ce qui est termine avant `before` (la table ne grossit pas sans fin, meme avec un detecteur qui oscille). */
export function purgeHistory(db: DatabaseSync, before: number): number {
  const a = db.prepare('DELETE FROM device_state_history WHERE ended_at IS NOT NULL AND ended_at < ?').run(before).changes;
  db.prepare('DELETE FROM blind_period WHERE to_ts < ?').run(before);
  return Number(a);
}

export function blindPeriods(db: DatabaseSync, from: number, to: number): BlindPeriod[] {
  return (db.prepare('SELECT from_ts, to_ts, clean FROM blind_period WHERE to_ts > ? AND from_ts < ? ORDER BY from_ts').all(from, to) as { from_ts: number; to_ts: number; clean: number }[]).map((r) => ({
    from: Math.max(r.from_ts, from),
    to: Math.min(r.to_ts, to),
    clean: r.clean === 1,
  }));
}

/** Intervalles de chaque equipement, rognes a [from, to] ; l'etat en cours s'arrete a `min(to, now)`. */
export function loadIntervals(db: DatabaseSync, from: number, to: number, now: number): Map<string, Interval[]> {
  const cap = Math.min(to, now);
  const rows = db
    .prepare('SELECT device_id, state, started_at, ended_at FROM device_state_history WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY device_id, started_at')
    .all(cap, from) as { device_id: string; state: string; started_at: number; ended_at: number | null }[];
  const byDevice = new Map<string, Interval[]>();
  for (const r of rows) {
    const start = Math.max(r.started_at, from);
    const end = Math.min(r.ended_at ?? cap, cap);
    if (end <= start) continue;
    let list = byDevice.get(r.device_id);
    if (!list) byDevice.set(r.device_id, (list = []));
    list.push({ state: r.state, start, end, open: r.ended_at === null });
  }
  return byDevice;
}

/** Disponibilite d'un equipement sur [from, to] a partir de ses intervalles (voir `loadIntervals`). */
export function availabilityOf(intervals: Interval[], from: number, to: number, now: number): Availability {
  const cap = Math.min(to, now);
  let up = 0;
  let down = 0;
  for (const i of intervals) {
    const clipped = Math.min(i.end, cap) - Math.max(i.start, from);
    if (clipped <= 0) continue;
    if (DOWN_STATES.has(i.state)) down += clipped;
    else up += clipped;
  }
  // Le temps observable commence au premier etat connu : un detecteur ajoute en cours de periode n'etait pas « non surveille » avant.
  const first = intervals.length > 0 ? Math.max(intervals[0].start, from) : cap;
  const unmonitored = Math.max(0, cap - first - up - down);
  const observed = up + down;
  return {
    upS: Math.round(up / 1000),
    downS: Math.round(down / 1000),
    unmonitoredS: Math.round(unmonitored / 1000),
    pct: observed > 0 ? Math.round((up / observed) * 10_000) / 100 : null,
  };
}

/** Somme de plusieurs disponibilites (parc, zone) : les secondes s'ajoutent, le pourcentage est recalcule. */
export function combine(parts: Availability[]): Availability {
  const up = parts.reduce((s, p) => s + p.upS, 0);
  const down = parts.reduce((s, p) => s + p.downS, 0);
  return {
    upS: up,
    downS: down,
    unmonitoredS: parts.reduce((s, p) => s + p.unmonitoredS, 0),
    pct: up + down > 0 ? Math.round((up / (up + down)) * 10_000) / 100 : null,
  };
}

/** Periodes d'arret (defaut et hors ligne consecutifs fusionnes), de la plus recente a la plus ancienne. */
export function outagesOf(deviceId: string, intervals: Interval[], now: number, to: number): Outage[] {
  const cap = Math.min(to, now);
  const out: Outage[] = [];
  const stillOpen = new Set<Outage>();
  let current: Outage | null = null;
  for (const i of intervals) {
    if (!DOWN_STATES.has(i.state)) {
      current = null;
      continue;
    }
    // Contigu a la periode precedente : meme panne (le detecteur est passe de « defaut » a « hors ligne »).
    if (current && current.to === i.start) {
      current.to = i.end;
    } else {
      current = { deviceId, from: i.start, to: i.end, durationS: 0, cause: i.state as 'fault' | 'offline' };
      out.push(current);
    }
    if (i.open && cap >= now) stillOpen.add(current);
    else stillOpen.delete(current);
  }
  for (const o of out) {
    o.durationS = Math.round(((o.to ?? cap) - o.from) / 1000);
    // « En cours » = l'etat est encore ouvert dans la base. Une panne finie a l'instant present n'est pas en cours.
    if (stillOpen.has(o)) o.to = null;
  }
  return out.reverse();
}
