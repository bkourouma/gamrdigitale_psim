/**
 * Mesure de l'etat des cameras reelles : un simple test de connexion reseau, regulier, vers l'adresse de chaque camera.
 *
 * Ce qui est fait : ouvrir une connexion TCP vers `host:port` de la source video (port ONVIF ou RTSP), puis la refermer.
 * Ce qui n'est PAS fait : aucun identifiant envoye, aucune image lue. Le test ne charge ni la camera ni le reseau, et ne
 * peut pas verrouiller un compte par erreur de mot de passe.
 *
 * Limite, a dire au client : une reponse prouve que l'APPAREIL repond (camera ou enregistreur), pas que l'image est bonne.
 * Derriere un enregistreur, toutes les voies partagent la meme adresse : elles tombent et reviennent ensemble.
 *
 * Anti-oscillation : hors ligne apres N echecs de suite seulement (un paquet perdu ne fait pas une panne), date du PREMIER
 * echec de la serie (c'est la que la panne a commence) ; retour en service au premier succes.
 *
 * Les cameras simulees (sans ligne dans `camera_source`) n'ont rien a mesurer : elles n'ont pas d'historique. L'etat de
 * l'ecran du PSIM (`device.status`) n'est pas modifie : seul l'historique (history.ts) et le journal le sont.
 */
import { connect } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { recordState } from './history.ts';

export const CAMERA_FAILURES_BEFORE_OFFLINE = 3;
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

export interface CameraHealthOptions {
  db: DatabaseSync;
  /** Ecrit dans le journal (camera_offline / camera_online). */
  audit: (action: 'camera_offline' | 'camera_online', deviceId: string, details: string) => void;
  everyMs: number;
  timeoutMs?: number;
  failuresBeforeOffline?: number;
  now?: () => number;
  /** Injectable pour les tests. */
  probe?: Probe;
}

export interface CameraHealthStatus {
  enabled: boolean;
  measured: number;
  /** Noms des cameras qui ne repondent pas. */
  offline: string[];
}

interface Streak {
  /** Adresse testee : si elle change (source modifiee), la serie repart de zero. */
  target: string;
  count: number;
  firstFailAt: number;
}

interface SourceRow {
  id: string;
  host: string;
  port: number;
}

export function createCameraHealth(options: CameraHealthOptions) {
  const { db } = options;
  const now = options.now ?? Date.now;
  const probe = options.probe ?? tcpProbe;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const limit = options.failuresBeforeOffline ?? CAMERA_FAILURES_BEFORE_OFFLINE;
  const streaks = new Map<string, Streak>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const sources = () =>
    db.prepare("SELECT c.device_id AS id, c.host, c.port FROM camera_source c JOIN device d ON d.id = c.device_id WHERE d.kind = 'camera'").all() as unknown as SourceRow[];

  const openState = (id: string) =>
    (db.prepare('SELECT state FROM device_state_history WHERE device_id = ? AND ended_at IS NULL').get(id) as { state: string } | undefined)?.state ?? null;

  /** Camera repassee en source simulee : plus rien a mesurer, son etat en cours est clos (elle ne compte plus). */
  function forgetUnmeasured(measured: Set<string>, t: number): void {
    const open = db
      .prepare("SELECT h.id, h.device_id, h.started_at FROM device_state_history h JOIN device d ON d.id = h.device_id WHERE h.ended_at IS NULL AND d.kind = 'camera'")
      .all() as { id: number; device_id: string; started_at: number }[];
    for (const row of open) {
      if (measured.has(row.device_id)) continue;
      db.prepare('UPDATE device_state_history SET ended_at = ? WHERE id = ?').run(Math.max(t, row.started_at), row.id);
      streaks.delete(row.device_id);
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
      if (state === 'offline') options.audit('camera_online', id, 'repond de nouveau');
      return;
    }
    if (streak.count === 0) streak.firstFailAt = t;
    streak.count++;
    if (streak.count < limit || state === 'offline') return;
    recordState(db, id, 'offline', streak.firstFailAt);
    options.audit('camera_offline', id, `ne repond plus (${limit} essais sans reponse)`);
  }

  /** Une serie de tests. Ne leve jamais d'exception ; deux series ne se chevauchent jamais. */
  async function check(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const before = sources();
      forgetUnmeasured(new Set(before.map((s) => s.id)), now());
      // Un enregistreur sert souvent plusieurs cameras (meme adresse, meme port) : un seul essai par adresse.
      const tests = new Map<string, Promise<boolean>>();
      for (const s of before) {
        const key = `${s.host}:${s.port}`;
        if (!tests.has(key)) tests.set(key, probe(s.host, s.port, timeoutMs).catch(() => false));
      }
      const results = new Map<string, boolean>();
      for (const [key, test] of tests) results.set(key, await test);
      // La configuration a pu changer pendant les tests : on n'applique qu'aux cameras dont la source n'a pas bouge.
      const t = now();
      for (const s of sources()) {
        const ok = results.get(`${s.host}:${s.port}`);
        if (ok !== undefined) apply(s.id, `${s.host}:${s.port}`, ok, t);
      }
    } catch (err) {
      console.error('[psim] mesure des cameras :', err instanceof Error ? err.message : err);
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

  /** Nombre de cameras mesurees, et les noms de celles qui ne repondent pas (pour l'ecran Systeme). */
  function status(): CameraHealthStatus {
    const list = sources();
    const name = db.prepare('SELECT name FROM device WHERE id = ?');
    const offline = list.filter((s) => openState(s.id) === 'offline').map((s) => (name.get(s.id) as { name: string } | undefined)?.name ?? s.id);
    return { enabled: options.everyMs > 0, measured: list.length, offline };
  }

  return { check, start, stop, status };
}
