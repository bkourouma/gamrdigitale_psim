/**
 * Liaison des passerelles MQTT. Une passerelle (compte `PSIM_MQTT_GATEWAYS`) represente plusieurs capteurs. Quand ELLE est
 * coupee (4G instable, coupure de courant), ses capteurs se taisent tous en meme temps : les declarer « muets » un par un
 * ferait croire a N pannes et enverrait N alertes, alors qu'il n'y a qu'un defaut, la liaison.
 *
 * Comportement :
 *  - passerelle deconnectee du broker : ses capteurs ne sont plus juges muets individuellement (engine.ts,
 *    `silenceReference`), quelle que soit la duree ;
 *  - deconnectee depuis plus de PSIM_GATEWAY_TIMEOUT_S : ses capteurs « normal » ou « defaut » deviennent NON SURVEILLES
 *    (affiches « hors ligne », jamais « normal » ; historique `unmonitored`, ni disponible ni indisponible, comme une periode
 *    aveugle ; portail : « non mesure »), avec UN avertissement (journal + ecran Systeme). Un capteur en prealarme ou en
 *    alarme garde son etat (un silence ne masque jamais un feu) ; un capteur deja hors ligne le reste ;
 *  - retour de la passerelle : chaque capteur reprend l'etat qu'il avait avant la coupure, puis les messages gardes par la
 *    passerelle (dates, voir ingestmeta.ts) le mettent a jour. Le silence de chaque capteur n'est compte qu'a partir de la
 *    fin d'un delai de grace (PSIM_GATEWAY_GRACE_S) : le temps de vider sa file d'attente.
 *
 * L'etat d'avant la coupure est garde en base (`device.link_lost_status`) : un redemarrage du PSIM pendant la coupure ne
 * perd rien. Les capteurs alimentes par le PSIM lui-meme (Dahua, Tuya) ne sont jamais concernes.
 */
import type { DatabaseSync } from 'node:sqlite';
import { recordState, UNMONITORED_STATE } from './history.ts';
import { allows } from './mqtt.ts';

export interface GatewayLinkStatus {
  user: string;
  connected: boolean;
  /** Dernier changement (connexion ou deconnexion) ; demarrage du PSIM tant qu'elle ne s'est pas connectee. */
  since: number;
  /** Declaree injoignable (deconnectee depuis plus du delai) : ses capteurs sont non surveilles. */
  down: boolean;
  /** Capteurs actuellement non surveilles a cause d'elle. */
  unmonitored: number;
}

export interface GatewayLinkOptions {
  db: DatabaseSync;
  gateways: readonly { user: string; detectors: readonly string[] }[];
  /** Deconnexion au-dela de laquelle ses capteurs sont non surveilles. 0 = desactive (capteurs juges un par un, comme avant). */
  timeoutMs: number;
  graceMs: number;
  now?: () => number;
  audit: (action: string, ref: { deviceId?: string; details?: string }) => void;
  publishDevice: (id: string) => void;
}

function describe(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

const list = (ids: string[]) => (ids.length === 0 ? '' : ` : ${ids.slice(0, 10).join(', ')}${ids.length > 10 ? '...' : ''}`);

/**
 * Le capteur parle de nouveau (sa passerelle est revenue, ou un autre canal) : il reprend l'etat d'avant la coupure.
 * Sans effet s'il n'etait pas concerne. Appele aussi par engine.ts AVANT d'appliquer un message.
 */
export function releaseLinkLoss(db: DatabaseSync, deviceId: string, at: number): boolean {
  const row = db.prepare('SELECT link_lost_status FROM device WHERE id = ? AND link_lost_at IS NOT NULL').get(deviceId) as { link_lost_status: string | null } | undefined;
  if (!row) return false;
  const status = row.link_lost_status === 'fault' ? 'fault' : 'normal';
  db.prepare('UPDATE device SET status = ?, link_lost_at = NULL, link_lost_status = NULL WHERE id = ?').run(status, deviceId);
  recordState(db, deviceId, status, at);
  return true;
}

export function createGatewayLink(options: GatewayLinkOptions) {
  const { db, timeoutMs, graceMs } = options;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const state = new Map(options.gateways.map((g) => [g.user, { clients: new Set<object>(), since: startedAt, down: false, connectedAt: null as number | null }]));

  /** Detecteurs que la passerelle represente (hors sources lues par le PSIM lui-meme). */
  function covered(user: string): string[] {
    const g = options.gateways.find((x) => x.user === user);
    if (!g) return [];
    const rows = db
      .prepare("SELECT id FROM device WHERE kind = 'detector' AND id NOT IN (SELECT device_id FROM detector_source) AND id NOT IN (SELECT device_id FROM tuya_source)")
      .all() as { id: string }[];
    return rows.map((r) => r.id).filter((id) => allows(g.detectors, id));
  }

  const covering = (deviceId: string) => options.gateways.filter((g) => allows(g.detectors, deviceId));
  const fedByPsim = (deviceId: string) =>
    db.prepare('SELECT 1 AS x FROM detector_source WHERE device_id = ? UNION ALL SELECT 1 AS x FROM tuya_source WHERE device_id = ?').get(deviceId, deviceId) !== undefined;
  const isConnected = (user: string) => (state.get(user)?.clients.size ?? 0) > 0;
  const linkLost = (ids: string[]) =>
    ids.filter((id) => db.prepare('SELECT 1 AS x FROM device WHERE id = ? AND link_lost_at IS NOT NULL').get(id) !== undefined);

  function markDown(user: string, t: number): void {
    const s = state.get(user)!;
    s.down = true;
    const lost: string[] = [];
    let kept = 0;
    for (const id of covered(user)) {
      // Represente aussi par une autre passerelle, connectee : toujours surveille.
      if (covering(id).some((g) => g.user !== user && isConnected(g.user))) continue;
      const row = db.prepare('SELECT status FROM device WHERE id = ? AND link_lost_at IS NULL').get(id) as { status: string } | undefined;
      if (!row) continue;
      if (row.status === 'alarm' || row.status === 'prealarm') kept++;
      if (row.status !== 'normal' && row.status !== 'fault') continue;
      db.prepare("UPDATE device SET link_lost_at = ?, link_lost_status = status, status = 'offline' WHERE id = ?").run(s.since, id);
      recordState(db, id, UNMONITORED_STATE, s.since);
      lost.push(id);
    }
    options.audit('gateway_offline', {
      details: `passerelle ${user} deconnectee depuis ${describe(t - s.since)} : ${lost.length} capteur(s) non surveille(s)${list(lost)}${kept ? ` ; ${kept} en alarme ou prealarme gardent leur etat` : ''}`,
    });
    for (const id of lost) options.publishDevice(id);
  }

  function markUp(user: string, t: number): void {
    const s = state.get(user)!;
    s.down = false;
    const back = linkLost(covered(user)).filter((id) => releaseLinkLoss(db, id, t));
    options.audit('gateway_online', {
      details: `passerelle ${user} de retour apres ${describe(t - s.since)} : ${back.length} capteur(s) de nouveau surveille(s)${list(back)} ; silence compte apres ${describe(graceMs)} de grace`,
    });
    for (const id of back) options.publishDevice(id);
  }

  // Demarrage : coupure en cours avant l'arret (etat en base) ; capteurs marques dont la passerelle n'existe plus.
  {
    const t = startedAt;
    const marked = (db.prepare("SELECT id FROM device WHERE kind = 'detector' AND link_lost_at IS NOT NULL").all() as { id: string }[]).map((r) => r.id);
    const orphans: string[] = [];
    for (const id of marked) {
      const owners = timeoutMs > 0 ? covering(id).filter((g) => state.has(g.user)) : [];
      if (owners.length === 0) {
        if (releaseLinkLoss(db, id, t)) orphans.push(id);
        continue;
      }
      for (const g of owners) state.get(g.user)!.down = true;
      recordState(db, id, UNMONITORED_STATE, t); // l'historique rouvert au demarrage (beginHistory) a repris « hors ligne »
    }
    if (orphans.length > 0) {
      options.audit('gateway_online', { details: `supervision des passerelles retiree de la configuration : ${orphans.length} capteur(s) de nouveau surveille(s) individuellement${list(orphans)}` });
      for (const id of orphans) options.publishDevice(id);
    }
  }

  /** Broker : un client authentifie avec le compte de cette passerelle vient de se connecter ou de partir. */
  function connection(user: string, connected: boolean, client: object): void {
    const s = state.get(user);
    if (!s) return;
    const before = s.clients.size > 0;
    if (connected) s.clients.add(client);
    else s.clients.delete(client);
    const after = s.clients.size > 0;
    if (before === after) return;
    const t = now();
    if (after) s.connectedAt = t;
    // Retour : immediat (avant les messages qu'elle renvoie). La duree de coupure est comptee depuis `since`, mis a jour apres.
    if (after && s.down) markUp(user, t);
    s.since = t;
  }

  /** A appeler regulierement (une fois par seconde). */
  function tick(): void {
    if (timeoutMs <= 0) return;
    const t = now();
    for (const [user, s] of state) {
      if (s.clients.size === 0 && !s.down && t - s.since >= timeoutMs) markDown(user, t);
    }
  }

  /**
   * Pour engine.ts (detecteurs muets) : `null` = rien a dire ; `Infinity` = passerelle(s) deconnectee(s), ne pas juger le
   * capteur ; sinon instant a partir duquel compter son silence (retour de la passerelle + grace).
   */
  function silenceReference(deviceId: string): number | null {
    if (timeoutMs <= 0) return null;
    const owners = covering(deviceId);
    if (owners.length === 0 || fedByPsim(deviceId)) return null;
    let reference = -Infinity;
    for (const g of owners) {
      const s = state.get(g.user)!;
      if (s.clients.size > 0) reference = Math.max(reference, (s.connectedAt ?? startedAt) + graceMs);
    }
    return reference === -Infinity ? Infinity : reference;
  }

  function status(): GatewayLinkStatus[] {
    return [...state].map(([user, s]) => ({
      user,
      connected: s.clients.size > 0,
      since: s.since,
      down: s.down,
      unmonitored: s.down ? linkLost(covered(user)).length : 0,
    }));
  }

  return { connection, tick, silenceReference, status };
}

export type GatewayLink = ReturnType<typeof createGatewayLink>;
