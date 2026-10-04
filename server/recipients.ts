/**
 * Destinataires de notification. Deux sources, additionnees :
 *  - le .env (PSIM_NOTIFY_*) : en lecture seule dans l'interface, repere « .env » ;
 *  - la base : ajoutes, desactives et retires par l'administrateur depuis l'interface.
 * Les secrets des canaux (mot de passe SMTP, jetons Telegram et WhatsApp, cles CallMeBot) restent dans le .env : jamais
 * en base ni dans l'interface. Les destinataires CallMeBot ne se declarent donc QUE dans le .env (chacun a sa cle).
 */
import type { DatabaseSync } from 'node:sqlite';
import { PsimError } from './engine.ts';
import { PHONE_E164, maskCallmebot, maskPhone } from './notifications.ts';

export type ChannelId = 'email' | 'telegram' | 'whatsapp' | 'callmebot' | 'webhook';
export type Level = 1 | 2;

const CHANNELS: ChannelId[] = ['email', 'telegram', 'whatsapp', 'callmebot', 'webhook'];
const MAX_RECIPIENTS = 100;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface RecipientView {
  /** null pour un destinataire du .env (non modifiable). */
  id: number | null;
  channel: ChannelId;
  /** Forme affichable : jamais l'adresse complete d'un webhook (elle peut contenir un jeton). */
  display: string;
  level: Level;
  label: string;
  active: boolean;
  source: 'env' | 'db';
  createdBy: string | null;
  createdAt: number | null;
  /** Zones dont il recoit les alarmes ; null = toutes (et les messages generaux : redemarrage, securite...). */
  zones: string[] | null;
}

/**
 * Portee d'un envoi : la zone de l'alarme, `null` pour un message general (redemarrage, journal, securite, alarme sans
 * zone). Absente = tout le monde (message de test, decompte).
 */
export interface Scope {
  zone: string | null;
}

/** Un destinataire limite a des zones ne recoit que les alarmes de ces zones ; les autres recoivent tout. */
export const inScope = (zones: string[] | null, scope?: Scope): boolean => !scope || zones === null || (scope.zone !== null && zones.includes(scope.zone));

const parseZones = (raw: unknown): string[] | null => {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((z): z is string => typeof z === 'string') : null;
  } catch {
    return null;
  }
};

export interface RecipientsDeps {
  db: DatabaseSync;
  audit: (actor: string, action: string, ref?: { details?: string }) => void;
  now?: () => number;
  /** Destinataires du .env, par canal puis par niveau (indice 0 = niveau 1). */
  env: Record<ChannelId, string[][]>;
  /** Canaux dont la configuration (SMTP, jeton) est presente : on ne peut ajouter de destinataire qu'a ceux-la. */
  available: Record<ChannelId, boolean>;
}

export function maskAddress(channel: ChannelId, address: string): string {
  if (channel === 'email') return address.replace(/^(.).*(@.*)$/, '$1***$2');
  if (channel === 'whatsapp') return maskPhone(address);
  if (channel === 'callmebot') return maskCallmebot(address);
  if (channel === 'webhook') {
    try {
      return new URL(address).host;
    } catch {
      return 'webhook';
    }
  }
  return address;
}

export function validateAddress(channel: ChannelId, raw: unknown): string {
  if (typeof raw !== 'string') throw new PsimError(400, 'Adresse requise');
  const address = raw.trim();
  if (!address || address.length > 500 || CONTROL.test(address)) throw new PsimError(400, 'Adresse invalide');
  if (channel === 'email' && !(address.length <= 254 && /^[^\s@,;<>()]{1,64}@[^\s@,;<>()]+\.[^\s@,;<>()]{2,}$/.test(address))) {
    throw new PsimError(400, 'Adresse e-mail invalide');
  }
  if (channel === 'whatsapp' && !PHONE_E164.test(address)) {
    throw new PsimError(400, 'Numero WhatsApp invalide : format international, sans espace (ex. +2250700000000)');
  }
  if (channel === 'telegram' && !/^(-?\d{5,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(address)) {
    throw new PsimError(400, "Identifiant Telegram invalide (numero de conversation, ou @canal)");
  }
  if (channel === 'webhook') {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      throw new PsimError(400, 'Adresse de webhook invalide');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PsimError(400, 'Le webhook doit etre en http ou https');
    // Adresses de metadonnees d'infrastructure (nuage) et adresses « lien-local » : aucune raison legitime d'y envoyer des alertes.
    if (/^169\.254\./.test(url.hostname) || /^\[?fe80:/i.test(url.hostname) || ['metadata.google.internal', 'metadata'].includes(url.hostname.toLowerCase()) || url.hostname === '0.0.0.0') {
      throw new PsimError(400, 'Adresse de webhook refusee (adresse reservee : lien-local ou metadonnees)');
    }
  }
  return address;
}

export function createRecipientsService(deps: RecipientsDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;

  /**
   * Adresses effectives d'un canal et d'un niveau : .env (toutes les alarmes) + base (actives, dans la portee), sans doublon.
   * Sans portee : tout le monde (test, decompte).
   */
  function effective(channel: ChannelId, level: Level, scope?: Scope): string[] {
    const fromDb = (
      db.prepare('SELECT address, zones FROM notification_recipient WHERE channel = ? AND level = ? AND active = 1 ORDER BY id').all(channel, level) as { address: string; zones: string | null }[]
    )
      .filter((r) => inScope(parseZones(r.zones), scope))
      .map((r) => r.address);
    return [...new Set([...(deps.env[channel]?.[level - 1] ?? []), ...fromDb])];
  }

  function list(): RecipientView[] {
    const out: RecipientView[] = [];
    for (const channel of CHANNELS) {
      for (const level of [1, 2] as Level[]) {
        for (const address of deps.env[channel]?.[level - 1] ?? []) {
          out.push({ id: null, channel, display: maskAddress(channel, address), level, label: '', active: true, source: 'env', createdBy: null, createdAt: null, zones: null });
        }
      }
    }
    for (const r of db.prepare('SELECT * FROM notification_recipient ORDER BY channel, level, id').all() as Record<string, unknown>[]) {
      out.push({
        id: r.id as number,
        channel: r.channel as ChannelId,
        display: maskAddress(r.channel as ChannelId, r.address as string),
        level: r.level as Level,
        label: r.label as string,
        active: r.active === 1,
        source: 'db',
        createdBy: r.created_by as string,
        createdAt: r.created_at as number,
        zones: parseZones(r.zones),
      });
    }
    return out;
  }

  function view(id: number): RecipientView {
    const found = list().find((r) => r.id === id);
    if (!found) throw new PsimError(404, 'Destinataire introuvable');
    return found;
  }

  function cleanLabel(value: unknown): string {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string' || value.length > 80 || CONTROL.test(value)) throw new PsimError(400, 'Libelle invalide (80 caracteres max)');
    return value.trim();
  }

  /** Zones des detecteurs, telles qu'ecrites sur les detecteurs. */
  const detectorZones = (): string[] => (db.prepare("SELECT DISTINCT zone FROM device WHERE kind = 'detector' AND zone <> ''").all() as { zone: string }[]).map((r) => r.zone);
  const fold = (zone: string) => zone.normalize('NFC').trim().toLocaleLowerCase('fr');

  /**
   * Zones : null / absent = toutes ; sinon 1 a 50 zones EXISTANTES (celles des detecteurs), ramenees a leur ecriture exacte
   * (« portail » devient « Portail ») : une zone mal ecrite ne correspondrait a aucune alarme, sans que rien ne le signale.
   */
  function cleanZones(value: unknown): string[] | null {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value) || value.length === 0 || value.length > 50) throw new PsimError(400, 'Zones : une liste de 1 a 50 noms, ou null pour toutes les alarmes');
    const known = new Map(detectorZones().map((z) => [fold(z), z]));
    const zones = value.map((z) => {
      if (typeof z !== 'string' || !z.trim() || z.length > 80 || CONTROL.test(z)) throw new PsimError(400, 'Nom de zone invalide');
      const zone = known.get(fold(z));
      if (!zone) throw new PsimError(400, `Zone inconnue : « ${z.trim()} » (aucun detecteur n'est dans cette zone)`);
      return zone;
    });
    return [...new Set(zones)];
  }

  /**
   * Destinataires actifs limites a une zone qui n'a plus de detecteur (zone renommee, detecteur deplace) : ils ne recoivent
   * plus rien de cette zone, sans erreur d'envoi. A signaler en rouge.
   */
  function orphanZones(): { recipient: string; zones: string[] }[] {
    const known = new Set(detectorZones());
    return list()
      .filter((r) => r.active && r.zones)
      .map((r) => ({ recipient: `${r.display}${r.label ? ` (${r.label})` : ''}`, zones: (r.zones ?? []).filter((z) => !known.has(z)) }))
      .filter((r) => r.zones.length > 0);
  }

  function cleanLevel(value: unknown): Level {
    if (value !== 1 && value !== 2) throw new PsimError(400, 'Niveau invalide (1 ou 2)');
    return value;
  }

  function add(actor: string, input: Record<string, unknown>): RecipientView {
    const channel = input.channel as ChannelId;
    if (!CHANNELS.includes(channel)) throw new PsimError(400, 'Canal invalide (email, telegram, whatsapp ou webhook)');
    if (channel === 'callmebot') {
      throw new PsimError(409, 'Les destinataires CallMeBot se declarent dans le .env (PSIM_NOTIFY_CALLMEBOT_L1 / L2) : chacun a sa cle, qui est secrete');
    }
    if (!deps.available[channel]) {
      const missing: Record<string, string> = {
        email: 'Canal e-mail non configure (PSIM_SMTP_HOST et PSIM_SMTP_FROM dans le .env)',
        telegram: 'Canal Telegram non configure (PSIM_TELEGRAM_TOKEN dans le .env)',
        whatsapp: 'Canal WhatsApp non configure (PSIM_WHATSAPP_TOKEN et PSIM_WHATSAPP_PHONE_ID dans le .env)',
      };
      throw new PsimError(409, missing[channel] ?? 'Canal non configure');
    }
    const address = validateAddress(channel, input.address);
    const level = cleanLevel(input.level);
    const label = cleanLabel(input.label);
    const zones = cleanZones(input.zones);
    if ((db.prepare('SELECT COUNT(*) AS n FROM notification_recipient').get() as { n: number }).n >= MAX_RECIPIENTS) {
      throw new PsimError(409, `Limite de ${MAX_RECIPIENTS} destinataires atteinte`);
    }
    if (deps.env[channel]?.[level - 1]?.includes(address)) throw new PsimError(409, 'Ce destinataire est deja defini dans le .env');
    try {
      const res = db
        .prepare('INSERT INTO notification_recipient (channel, address, level, label, active, created_at, created_by, zones) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
        .run(channel, address, level, label, now(), actor, zones ? JSON.stringify(zones) : null);
      deps.audit(actor, 'recipient_added', { details: `${channel} ${maskAddress(channel, address)} niveau ${level}${zones ? ` (zones : ${zones.join(', ')})` : ''}` });
      return view(Number(res.lastInsertRowid));
    } catch (err) {
      if (/UNIQUE/i.test((err as Error).message)) throw new PsimError(409, 'Ce destinataire existe deja pour ce niveau');
      throw err;
    }
  }

  function update(actor: string, id: number, patch: Record<string, unknown>): RecipientView {
    const before = view(id);
    const sets: string[] = [];
    const values: (string | number)[] = [];
    if (patch.level !== undefined) {
      sets.push('level = ?');
      values.push(cleanLevel(patch.level));
    }
    if (patch.active !== undefined) {
      if (typeof patch.active !== 'boolean') throw new PsimError(400, 'active doit etre vrai ou faux');
      sets.push('active = ?');
      values.push(patch.active ? 1 : 0);
    }
    if (patch.label !== undefined) {
      sets.push('label = ?');
      values.push(cleanLabel(patch.label));
    }
    if (patch.zones !== undefined) {
      const zones = cleanZones(patch.zones);
      sets.push('zones = ?');
      values.push(zones ? JSON.stringify(zones) : (null as unknown as string));
    }
    if (sets.length === 0) return before;
    try {
      db.prepare(`UPDATE notification_recipient SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    } catch (err) {
      if (/UNIQUE/i.test((err as Error).message)) throw new PsimError(409, 'Ce destinataire existe deja pour ce niveau');
      throw err;
    }
    deps.audit(actor, 'recipient_updated', { details: `${before.channel} ${before.display} : ${Object.keys(patch).join(', ')}` });
    return view(id);
  }

  function remove(actor: string, id: number): void {
    const before = view(id);
    db.prepare('DELETE FROM notification_recipient WHERE id = ?').run(id);
    deps.audit(actor, 'recipient_removed', { details: `${before.channel} ${before.display} niveau ${before.level}` });
  }

  return { effective, list, add, update, remove, orphanZones, available: deps.available };
}

export type RecipientsService = ReturnType<typeof createRecipientsService>;
