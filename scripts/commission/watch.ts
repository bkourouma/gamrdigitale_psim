/**
 * Recette des detecteurs : ecoute le broker MQTT du PSIM pendant que l'on declenche chaque equipement reel, et dit
 * pour chaque message ce que le PSIM en comprend. Repond a « est-ce que ce detecteur parle, avec le bon identifiant
 * et un message que le PSIM sait lire ? » avant la mise en service, equipement par equipement.
 *
 * Meme lecture que le moteur (server/sources.ts), meme topic, meme limite de taille que le broker (server/mqtt.ts).
 */
import { interpret } from '../../server/sources.ts';
import type { SensorSettings } from '../../server/sources.ts';

export const TOPIC = /^psim\/detectors\/([A-Za-z0-9_-]{1,32})\/state$/;
export const MAX_PAYLOAD_BYTES = 1024;

export interface WatchDevice extends SensorSettings {
  id: string;
  name: string;
  zone: string;
  /** Nom de l'etage, s'il y en a plusieurs. */
  floor?: string;
  valueUnit: string | null;
}

export type Verdict = 'ok' | 'invalid' | 'unknown' | 'ignored';

export interface Observation {
  at: number;
  id: string;
  verdict: Verdict;
  text: string;
}

const STATE_FR: Record<string, string> = { normal: 'normal', prealarm: 'PREALARME', alarm: 'ALARME', fault: 'defaut', offline: 'hors ligne' };

export function createWatcher(devices: WatchDevice[], now: () => number = Date.now) {
  const known = new Map(devices.map((d) => [d.id, d]));
  const heard = new Map<string, { count: number; first: number; last: number; states: Set<string> }>();
  const unknown = new Map<string, number>();
  const invalid = new Map<string, { reason: string; count: number }>();

  /** Traite un message recu sur le broker. Ne leve jamais d'exception. */
  function handle(topic: string, payload: Buffer): Observation | null {
    const m = TOPIC.exec(topic);
    if (!m) return null; // un autre topic : pas notre affaire (le broker du PSIM refuse de toute facon d'autres topics)
    const id = m[1];
    const t = now();
    const device = known.get(id);

    if (payload.length > MAX_PAYLOAD_BYTES) {
      invalid.set(id, { reason: `message de ${payload.length} octets : le PSIM ignore au-dela de ${MAX_PAYLOAD_BYTES}`, count: (invalid.get(id)?.count ?? 0) + 1 });
      return { at: t, id, verdict: 'invalid', text: `message trop gros (${payload.length} octets) : le PSIM l'ignorera` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch {
      invalid.set(id, { reason: 'le contenu n\'est pas du JSON', count: (invalid.get(id)?.count ?? 0) + 1 });
      return { at: t, id, verdict: 'invalid', text: `contenu illisible (pas du JSON) : « ${payload.toString('utf8').slice(0, 60).replace(/\s+/g, ' ')} » - le PSIM l'ignorera` };
    }
    if (!device) {
      unknown.set(id, (unknown.get(id) ?? 0) + 1);
      return { at: t, id, verdict: 'unknown', text: `identifiant inconnu du PSIM : l'ajouter a l'inventaire avec EXACTEMENT cet identifiant, sinon ses messages sont ignores` };
    }
    const r = interpret(device, parsed);
    if (!r.ok) {
      invalid.set(id, { reason: r.error, count: (invalid.get(id)?.count ?? 0) + 1 });
      return { at: t, id, verdict: 'invalid', text: `${r.error} - le PSIM l'ignorera. Attendu : {"state": "alarm"}, {"event": "door_forced"} ou {"value": 41.5}` };
    }
    const h = heard.get(id) ?? { count: 0, first: t, last: t, states: new Set<string>() };
    h.count++;
    h.last = t;
    if (r.state) h.states.add(r.state);
    heard.set(id, h);

    const bits: string[] = [];
    if (r.event) bits.push(`evenement « ${r.event} »`);
    if (r.value !== null) bits.push(`mesure ${r.value}${device.valueUnit ? ` ${device.valueUnit}` : ''}`);
    if (r.state) bits.push(`-> ${STATE_FR[r.state] ?? r.state}`);
    else if (r.value !== null && device.alarmAt === null) bits.push("(aucun seuil regle : mesure seulement affichee)");
    else bits.push('(signe de vie, aucun changement d\'etat)');
    return { at: t, id, verdict: 'ok', text: `${device.name} : ${bits.join(' ')}` };
  }

  function summary() {
    const missing = devices.filter((d) => !heard.has(d.id));
    return {
      heard: devices.filter((d) => heard.has(d.id)).map((d) => ({ id: d.id, name: d.name, count: heard.get(d.id)!.count, states: [...heard.get(d.id)!.states] })),
      missing: missing.map((d) => ({ id: d.id, name: d.name, zone: d.floor ? `${d.zone || 'sans zone'}, etage : ${d.floor}` : d.zone })),
      unknown: [...unknown].map(([id, count]) => ({ id, count })),
      invalid: [...invalid].map(([id, v]) => ({ id, reason: v.reason, count: v.count })),
      allHeard: missing.length === 0,
    };
  }

  return { handle, summary };
}

export type Watcher = ReturnType<typeof createWatcher>;

export function formatSummary(s: ReturnType<Watcher['summary']>): string {
  const lines: string[] = [`Detecteurs entendus : ${s.heard.length} / ${s.heard.length + s.missing.length}`];
  for (const h of s.heard) lines.push(`  OK       ${h.id} ${h.name} (${h.count} message(s)${h.states.length ? `, etats vus : ${h.states.join(', ')}` : ''})`);
  for (const m of s.missing) lines.push(`  SILENCE  ${m.id} ${m.name}${m.zone ? ` (${m.zone})` : ''} : aucun message recu`);
  for (const u of s.unknown) lines.push(`  INCONNU  ${u.id} : ${u.count} message(s) d'un identifiant absent de l'inventaire`);
  for (const i of s.invalid) lines.push(`  ILLISIBLE ${i.id} : ${i.reason} (${i.count} fois)`);
  if (s.missing.length) lines.push('', "Detecteurs muets : verifier l'alimentation, le reseau, la passerelle, l'identifiant et le topic psim/detectors/<id>/state.");
  return lines.join('\n');
}
