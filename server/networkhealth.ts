/**
 * Supervision reseau des equipements d'infrastructure : routeur 4G, switch PoE, passerelle, point d'acces, enregistreur,
 * serveur... Ces equipements n'emettent aucun message : le PSIM teste, a intervalle regulier, qu'ils repondent encore.
 *
 * Un equipement reseau est un detecteur (categorie « environnement ») auquel on associe une CIBLE : un hote et un port TCP
 * (80, 443, 22, 161... : celui que l'equipement ecoute vraiment). La mecanique du test (une connexion, rien envoye, hors
 * ligne apres 3 echecs de suite date du premier, retour au premier succes) est celle des cameras : targethealth.ts.
 *
 * Limite, a dire au client : une reponse prouve que l'equipement ACCEPTE une connexion sur ce port, pas qu'il rend le
 * service attendu (un routeur 4G peut repondre et ne plus avoir de signal). Un equipement jamais teste n'a PAS d'etat :
 * il n'est jamais affiche « normal » (voir history.ts, portal.ts). Le journal ne contient jamais l'adresse.
 */
import type { DatabaseSync } from 'node:sqlite';
import { PsimError } from './errors.ts';
import { recordState } from './history.ts';
import { createTargetHealth, tcpProbe } from './targethealth.ts';
import type { Probe, Target, TargetHealthStatus } from './targethealth.ts';
// Meme regle d'adresse que les cameras : adresse IPv4 ou nom de machine, sans http:// ni chemin.
import { HOST_PATTERN } from './video.ts';

export type NetworkHealthStatus = TargetHealthStatus;

export interface NetworkHealthOptions {
  db: DatabaseSync;
  /** Ecrit dans le journal (network_offline / network_online). */
  audit: (action: 'network_offline' | 'network_online', deviceId: string, details: string) => void;
  everyMs: number;
  timeoutMs?: number;
  failuresBeforeOffline?: number;
  now?: () => number;
  /** Injectable pour les tests. */
  probe?: Probe;
}

const networkTargets = (db: DatabaseSync): Target[] =>
  db.prepare("SELECT t.device_id AS id, t.host, t.port FROM network_target t JOIN device d ON d.id = t.device_id WHERE d.kind = 'detector'").all() as unknown as Target[];

export function createNetworkHealth(options: NetworkHealthOptions) {
  return createTargetHealth({
    ...options,
    targets: networkTargets,
    label: 'mesure des equipements reseau',
    actions: { offline: 'network_offline', online: 'network_online' },
  });
}

/** Adresse saisie, validee strictement (la meme regle que l'adresse d'une camera). */
export function cleanHost(value: unknown): string {
  if (typeof value !== 'string') throw new PsimError(400, 'Adresse requise (adresse IPv4 ou nom de machine)');
  const host = value.trim();
  if (!HOST_PATTERN.test(host)) throw new PsimError(400, 'Adresse invalide (adresse IPv4 ou nom de machine, sans http:// ni chemin)');
  return host;
}

/** Port TCP saisi : un entier de 1 a 65535 (un nombre ecrit en texte, comme « 443 », est accepte ; « 80abc » ou 80.5 non). */
export function cleanPort(value: unknown): number {
  const n = typeof value === 'string' && /^\d{1,5}$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 65535) throw new PsimError(400, 'Port invalide (1 a 65535)');
  return n;
}

export interface NetworkTargetView {
  host: string;
  port: number;
  /** `null` : jamais teste (aucun etat : jamais « normal » par defaut). */
  state: 'normal' | 'offline' | null;
  /** Debut de l'etat en cours. */
  since: number | null;
}

export interface NetworkTargetsOptions {
  db: DatabaseSync;
  /** Ecrit dans le journal sous le nom de l'utilisateur. */
  audit: (actor: string, action: string, ref: { deviceId?: string; details?: string }) => void;
  now?: () => number;
  probe?: Probe;
  /** Le delai d'un essai manuel. */
  timeoutMs?: number;
}

/** Cible reseau d'un equipement : lecture, enregistrement, retrait, et essai avant enregistrement. */
export function createNetworkTargets(options: NetworkTargetsOptions) {
  const { db } = options;
  const now = options.now ?? Date.now;
  const probe = options.probe ?? tcpProbe;
  const timeoutMs = options.timeoutMs ?? 3_000;

  const device = (id: string) => db.prepare('SELECT id, kind, category, status, last_seen FROM device WHERE id = ?').get(id) as
    | { id: string; kind: string; category: string; status: string; last_seen: number | null }
    | undefined;

  function requireDevice(id: string) {
    const d = device(id);
    if (!d || d.kind !== 'detector') throw new PsimError(404, 'Equipement introuvable');
    return d;
  }

  function view(id: string): NetworkTargetView | null {
    requireDevice(id);
    const row = db.prepare('SELECT host, port FROM network_target WHERE device_id = ?').get(id) as { host: string; port: number } | undefined;
    if (!row) return null;
    const open = db.prepare('SELECT state, started_at FROM device_state_history WHERE device_id = ? AND ended_at IS NULL').get(id) as { state: string; started_at: number } | undefined;
    const state = open?.state === 'normal' || open?.state === 'offline' ? open.state : null;
    return { host: row.host, port: row.port, state, since: state ? open!.started_at : null };
  }

  function set(actor: string, id: string, input: Record<string, unknown>): NetworkTargetView {
    const d = requireDevice(id);
    if (d.category !== 'environment') {
      throw new PsimError(409, "La supervision reseau concerne un equipement de categorie « Environnement » : changer d'abord la categorie dans les reglages");
    }
    if (db.prepare('SELECT 1 AS x FROM detector_source WHERE device_id = ?').get(id)) {
      throw new PsimError(409, "Cet equipement lit la detection d'un enregistreur : retirer d'abord cette source");
    }
    const host = cleanHost(input.host);
    const port = cleanPort(input.port);
    const known = db.prepare('SELECT 1 AS x FROM network_target WHERE device_id = ?').get(id);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO network_target (device_id, host, port) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET host = excluded.host, port = excluded.port').run(id, host, port);
      // Sa supervision est le test reseau : le delai « aucun message » du moteur le declarerait muet a tort.
      db.prepare('UPDATE device SET heartbeat_s = 0 WHERE id = ?').run(id);
      if (!known) {
        // L'etat « normal » ecrit a la creation de l'equipement n'est pas une mesure : il disparait (jamais teste = aucun etat).
        // Un equipement qui avait un vrai historique (il a deja parle) le garde, clos a cet instant.
        const open = db.prepare('SELECT id, started_at FROM device_state_history WHERE device_id = ? AND ended_at IS NULL').get(id) as { id: number; started_at: number } | undefined;
        if (open && d.last_seen === null) db.prepare('DELETE FROM device_state_history WHERE id = ?').run(open.id);
        else if (open) db.prepare('UPDATE device_state_history SET ended_at = ? WHERE id = ?').run(Math.max(now(), open.started_at), open.id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    // Jamais l'adresse dans le journal (comme camera_offline) : le port suffit a dire ce qui est teste.
    options.audit(actor, 'network_target_updated', { deviceId: id, details: `supervision reseau, port ${port}` });
    return view(id)!;
  }

  function remove(actor: string, id: string): void {
    const d = requireDevice(id);
    const res = db.prepare('DELETE FROM network_target WHERE device_id = ?').run(id);
    if (Number(res.changes) === 0) throw new PsimError(404, 'Aucune supervision reseau pour cet equipement');
    // Il redevient un detecteur ordinaire : son etat en cours reprend celui de l'ecran (ou rien, s'il n'avait jamais ete teste).
    const open = db.prepare('SELECT 1 AS x FROM device_state_history WHERE device_id = ? AND ended_at IS NULL').get(id);
    if (open) recordState(db, id, d.status, now());
    options.audit(actor, 'network_target_removed', { deviceId: id });
  }

  /** Un seul essai, rien d'enregistre. Ne leve que pour une saisie invalide. */
  async function test(input: Record<string, unknown>): Promise<{ ok: boolean; message: string; ms: number | null }> {
    const host = cleanHost(input.host);
    const port = cleanPort(input.port);
    const t0 = Date.now();
    const ok = await probe(host, port, timeoutMs).catch(() => false);
    return ok
      ? { ok: true, message: `L'equipement repond sur le port ${port}.`, ms: Date.now() - t0 }
      : { ok: false, message: `Aucune reponse sur le port ${port} (adresse erronee, equipement eteint, ou port ferme).`, ms: null };
  }

  return { view, set, remove, test };
}

export type NetworkTargets = ReturnType<typeof createNetworkTargets>;
