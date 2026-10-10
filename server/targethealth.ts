/**
 * Mecanique commune de la mesure de disponibilite par test de connexion (cameras : camerahealth.ts ; equipements
 * d'infrastructure : networkhealth.ts). Une « cible de test » = un equipement + un hote + un port TCP.
 *
 * Ce qui est fait : ouvrir une connexion TCP vers `host:port`, puis la refermer. Ce qui n'est PAS fait : aucun identifiant
 * envoye, aucune donnee lue. Le test ne charge ni l'appareil ni le reseau, et ne peut pas verrouiller un compte.
 *
 * Anti-oscillation : hors ligne apres N echecs de suite seulement (un paquet perdu ne fait pas une panne), date du PREMIER
 * echec de la serie (c'est la que la panne a commence) ; retour en service au premier succes.
 *
 * Un seul essai par adresse (hote + port) et par serie, meme si plusieurs equipements la partagent (les voies d'un
 * enregistreur) : ils tombent et reviennent ensemble. L'etat de l'ecran du PSIM (`device.status`) n'est pas modifie :
 * seul l'historique (history.ts) et le journal le sont.
 */
import { connect } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { recordState } from './history.ts';

export const FAILURES_BEFORE_OFFLINE = 3;
const PROBE_TIMEOUT_MS = 3_000;

export type Probe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

/** Vrai si une connexion TCP s'etablit avant le delai. Ne leve jamais d'exception. */
export const tcpProbe: Probe = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });

export interface Target {
  /** Identifiant de l'equipement (`device.id`). */
  id: string;
  host: string;
  port: number;
}

export interface TargetHealthOptions<A extends string = string> {
  db: DatabaseSync;
  /** Cibles a tester, relues a chaque serie (la configuration peut changer a tout moment). */
  targets: (db: DatabaseSync) => Target[];
  /**
   * Genre d'equipement dont l'etat en cours est clos quand il n'a plus de cible (camera repassee en source simulee).
   * Absent : rien n'est clos ici (l'appelant le fait en retirant la cible).
   */
  closeUnmeasuredOf?: 'camera';
  /** Texte pour le journal d'erreurs du PSIM (« mesure des cameras »). */
  label: string;
  /** Ecrit dans le journal (action de mise hors ligne / de retour). */
  audit: (action: A, deviceId: string, details: string) => void;
  actions: { offline: A; online: A };
  everyMs: number;
  timeoutMs?: number;
  failuresBeforeOffline?: number;
  now?: () => number;
  /** Injectable pour les tests. */
  probe?: Probe;
}

export interface TargetHealthStatus {
  enabled: boolean;
  measured: number;
  /** Noms des equipements qui ne repondent pas. */
  offline: string[];
}

interface Streak {
  /** Adresse testee : si elle change (cible modifiee), la serie repart de zero. */
  target: string;
  count: number;
  firstFailAt: number;
}

export function createTargetHealth<A extends string>(options: TargetHealthOptions<A>) {
  const { db } = options;
  const now = options.now ?? Date.now;
  const probe = options.probe ?? tcpProbe;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const limit = options.failuresBeforeOffline ?? FAILURES_BEFORE_OFFLINE;
  const streaks = new Map<string, Streak>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const sources = () => options.targets(db);

  const openState = (id: string) =>
    (db.prepare('SELECT state FROM device_state_history WHERE device_id = ? AND ended_at IS NULL').get(id) as { state: string } | undefined)?.state ?? null;

  /** Equipement qui n'a plus de cible : plus rien a mesurer, sa serie d'echecs est oubliee et, pour une camera, son etat en cours est clos. */
  function forgetUnmeasured(measured: Set<string>, t: number): void {
    for (const id of streaks.keys()) if (!measured.has(id)) streaks.delete(id);
    if (!options.closeUnmeasuredOf) return;
    const open = db
      .prepare('SELECT h.id, h.device_id, h.started_at FROM device_state_history h JOIN device d ON d.id = h.device_id WHERE h.ended_at IS NULL AND d.kind = ?')
      .all(options.closeUnmeasuredOf) as { id: number; device_id: string; started_at: number }[];
    for (const row of open) {
      if (measured.has(row.device_id)) continue;
      db.prepare('UPDATE device_state_history SET ended_at = ? WHERE id = ?').run(Math.max(t, row.started_at), row.id);
    }
  }

  function apply(id: string, target: string, ok: boolean, t: number): void {
    const state = openState(id);
    let streak = streaks.get(id);
    if (!streak || streak.target !== target) streaks.set(id, (streak = { target, count: 0, firstFailAt: t }));
    if (ok) {
      streak.count = 0;
      if (state === 'normal') return;
      recordState(db, id, 'normal', t);
      if (state === 'offline') options.audit(options.actions.online, id, 'repond de nouveau');
      return;
    }
    if (streak.count === 0) streak.firstFailAt = t;
    streak.count++;
    if (streak.count < limit || state === 'offline') return;
    recordState(db, id, 'offline', streak.firstFailAt);
    options.audit(options.actions.offline, id, `ne repond plus (${limit} essais sans reponse)`);
  }

  /** Une serie de tests. Ne leve jamais d'exception ; deux series ne se chevauchent jamais. */
  async function check(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const before = sources();
      forgetUnmeasured(new Set(before.map((s) => s.id)), now());
      // Un enregistreur sert souvent plusieurs voies (meme adresse, meme port) : un seul essai par adresse.
      const tests = new Map<string, Promise<boolean>>();
      for (const s of before) {
        const key = `${s.host}:${s.port}`;
        if (!tests.has(key)) tests.set(key, probe(s.host, s.port, timeoutMs).catch(() => false));
      }
      const results = new Map<string, boolean>();
      for (const [key, test] of tests) results.set(key, await test);
      // La configuration a pu changer pendant les tests : on n'applique qu'aux equipements dont la cible n'a pas bouge.
      const t = now();
      for (const s of sources()) {
        const ok = results.get(`${s.host}:${s.port}`);
        if (ok !== undefined) apply(s.id, `${s.host}:${s.port}`, ok, t);
      }
    } catch (err) {
      console.error(`[psim] ${options.label} :`, err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (timer || options.everyMs <= 0) return;
    void check();
    timer = setInterval(() => void check(), options.everyMs);
    timer.unref();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** Nombre d'equipements mesures, et les noms de ceux qui ne repondent pas (pour l'ecran Systeme). */
  function status(): TargetHealthStatus {
    const list = sources();
    const name = db.prepare('SELECT name FROM device WHERE id = ?');
    const offline = list.filter((s) => openState(s.id) === 'offline').map((s) => (name.get(s.id) as { name: string } | undefined)?.name ?? s.id);
    return { enabled: options.everyMs > 0, measured: list.length, offline };
  }

  return { check, start, stop, status };
}
