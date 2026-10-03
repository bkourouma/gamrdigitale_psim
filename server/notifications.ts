/**
 * Notifications (e-mail, Telegram, webhook) avec escalade.
 *
 * Regles de conception :
 *  - une alarme notifie TOUJOURS, meme « a confirmer » : les regles anti-fausses alarmes qualifient,
 *    elles ne font jamais taire ;
 *  - jamais bloquant : tout part en tache de fond avec reprises ; l'echec d'un canal n'empeche pas les autres ;
 *  - escalade : si personne n'acquitte, le niveau 2 est prevenu, puis des rappels (nombre plafonne) ;
 *  - aucun secret (mot de passe SMTP, jeton, adresse de webhook complete) dans les journaux.
 */
import { createHmac } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import nodemailer from 'nodemailer';
import type { Engine } from './engine.ts';
import { CATEGORY_LABEL_PLAIN } from './sources.ts';
import type { Device, Incident } from './types.ts';

export type Kind = 'opened' | 'escalated' | 'confirmed' | 'unacked' | 'reminder' | 'silent' | 'restart' | 'test';
export type Level = 1 | 2;

export interface Message {
  kind: Kind;
  incidentId: number | null;
  subject: string;
  text: string;
  data: Record<string, unknown>;
}

export interface ImageAttachment {
  caption: string;
  data: Buffer;
}

export interface Channel {
  id: 'email' | 'telegram' | 'webhook' | string;
  label: string;
  recipients(level: Level): string[];
  send(message: Message, recipient: string): Promise<void>;
  sendImages?(message: Message, recipient: string, images: ImageAttachment[]): Promise<void>;
  /** Forme affichable du destinataire (jamais un secret). */
  mask(recipient: string): string;
}

const TIMEOUT_MS = 15_000;

/** Destinataires : liste fixe par niveau, ou fonction relue a chaque envoi (destinataires modifiables a chaud). */
export type Recipients = string[][] | ((level: Level) => string[]);
const resolveRecipients = (r: Recipients) => (level: Level): string[] => (typeof r === 'function' ? r(level) : (r[level - 1] ?? []));

// ---------------------------------------------------------------- canaux

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  /** false = n'essaie pas STARTTLS (relais interne en clair, ou tests). */
  starttls?: boolean;
}

export function emailChannel(cfg: EmailConfig, recipientsSource: Recipients): Channel | null {
  const recipients = resolveRecipients(recipientsSource);
  if (!cfg.host || !cfg.from) return null;
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    ignoreTLS: cfg.starttls === false,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: TIMEOUT_MS,
  });
  const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 60);
  return {
    id: 'email',
    label: 'E-mail',
    recipients,
    mask: (to) => to.replace(/^(.).*(@.*)$/, '$1***$2'),
    async send(message, to) {
      await transporter.sendMail({ from: cfg.from, to, subject: message.subject, text: message.text });
    },
    async sendImages(message, to, images) {
      await transporter.sendMail({
        from: cfg.from,
        to,
        subject: `${message.subject} (images)`,
        text: `Images prises par les cameras liees a l'incident :\n${images.map((i) => `- ${i.caption}`).join('\n')}`,
        attachments: images.map((i, n) => ({ filename: `${n + 1}-${safeName(i.caption)}.jpg`, content: i.data, contentType: 'image/jpeg' })),
      });
    },
  };
}

export function telegramChannel(cfg: { token: string; apiBase: string }, recipientsSource: Recipients): Channel | null {
  const recipients = resolveRecipients(recipientsSource);
  if (!cfg.token) return null;
  const call = async (method: string, body: FormData | string): Promise<void> => {
    let res: Response;
    try {
      res = await fetch(`${cfg.apiBase.replace(/\/$/, '')}/bot${cfg.token}/${method}`, {
        method: 'POST',
        headers: typeof body === 'string' ? { 'Content-Type': 'application/json' } : undefined,
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // Le message d'origine de fetch contient l'adresse complete, donc le jeton : on ne le propage pas.
      throw new Error('Telegram injoignable');
    }
    if (!res.ok) {
      const detail = await res.json().then((j: { description?: string }) => j.description ?? '', () => '');
      throw new Error(`Telegram HTTP ${res.status}${detail ? ` : ${String(detail).slice(0, 80)}` : ''}`);
    }
  };
  return {
    id: 'telegram',
    label: 'Telegram',
    recipients,
    mask: (chat) => chat,
    send: (message, chat) => call('sendMessage', JSON.stringify({ chat_id: chat, text: `${message.subject}\n\n${message.text}`.slice(0, 4000) })),
    async sendImages(_message, chat, images) {
      for (const image of images) {
        const form = new FormData();
        form.set('chat_id', chat);
        form.set('caption', image.caption.slice(0, 900));
        form.set('photo', new Blob([new Uint8Array(image.data)], { type: 'image/jpeg' }), 'camera.jpg');
        await call('sendPhoto', form);
      }
    },
  };
}

/** Le canal webhook n'a pas de configuration propre : il existe toujours, ses destinataires peuvent etre ajoutes a chaud. */
export function webhookChannel(cfg: { secret: string }, recipientsSource: Recipients): Channel {
  const source = resolveRecipients(recipientsSource);
  const valid = (urls: string[]) =>
    urls.filter((u) => {
      try {
        return ['http:', 'https:'].includes(new URL(u).protocol);
      } catch {
        return false;
      }
    });
  return {
    id: 'webhook',
    label: 'Webhook',
    recipients: (level) => valid(source(level)),
    // L'adresse complete peut contenir un secret (jeton dans le chemin) : on n'affiche que l'hote.
    mask: (url) => {
      try {
        return new URL(url).host;
      } catch {
        return 'webhook';
      }
    },
    async send(message, url) {
      const body = JSON.stringify({ event: message.kind, incidentId: message.incidentId, subject: message.subject, text: message.text, ...message.data });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (cfg.secret) headers['X-PSIM-Signature'] = `sha256=${createHmac('sha256', cfg.secret).update(body).digest('hex')}`;
      let res: Response;
      try {
        res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        throw new Error('Webhook injoignable');
      }
      if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
    },
  };
}

// ---------------------------------------------------------------- notificateur

export interface NotifierDeps {
  db: DatabaseSync;
  engine: Engine;
  channels: Channel[];
  now?: () => number;
  /** 0 = pas d'escalade. */
  escalateAfterMs: number;
  reminderMs: number;
  maxReminders: number;
  publicUrl?: string;
  /** Delais (ms) avant chaque tentative d'envoi ; [0, 2000, 10000] = 3 tentatives. */
  retryDelaysMs?: number[];
  readSnapshot?: (snapshotId: number) => Buffer | null;
  /** Textes a ne jamais laisser apparaitre dans les journaux (jetons, mots de passe). */
  secrets?: string[];
}

const KIND_TITLE: Record<Kind, string> = {
  opened: 'ALARME',
  escalated: 'ALARME AGGRAVEE',
  confirmed: 'ALARME CONFIRMEE',
  unacked: 'NON ACQUITTEE',
  reminder: 'RAPPEL - TOUJOURS NON ACQUITTEE',
  silent: 'DETECTEUR HORS LIGNE',
  restart: 'SURVEILLANCE INTERROMPUE',
  test: 'MESSAGE DE TEST',
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createNotifier(deps: NotifierDeps) {
  const { db, engine, channels } = deps;
  const now = deps.now ?? Date.now;
  const delays = deps.retryDelaysMs ?? [0, 2_000, 10_000];
  const secrets = (deps.secrets ?? []).filter((s) => s.length >= 4);

  const redact = (text: string): string => secrets.reduce((t, s) => t.split(s).join('***'), text).slice(0, 200);
  const hasRecipients = (level: Level) => channels.some((c) => c.recipients(level).length > 0);

  function minutes(ms: number): string {
    // Sous 90 s on garde les secondes : « 1 min » pour 25 s serait trompeur.
    if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
    return `${Math.round(ms / 60_000)} min`;
  }

  function incidentMessage(incident: Incident, kind: Kind, ageMs = 0): Message {
    const critical = incident.severity === 'critical';
    const confirmed = incident.confirmedAt !== null;
    // Hors incendie, le type d'alarme figure dans le titre : « ALARME INTRUSION », « PREALARME CONTROLE D'ACCES »...
    const type = incident.category === 'fire' ? '' : ` ${CATEGORY_LABEL_PLAIN[incident.category].toUpperCase()}`;
    const level = `${critical ? 'ALARME' : 'PREALARME'}${type}`;
    let title: string;
    switch (kind) {
      case 'opened':
        title = `${level}${confirmed ? ' CONFIRMEE' : ' - a confirmer'}`;
        break;
      case 'unacked':
        title = `${level} NON ACQUITTEE depuis ${minutes(ageMs)}`;
        break;
      case 'reminder':
        title = `RAPPEL - ${level} TOUJOURS NON ACQUITTEE depuis ${minutes(ageMs)}`;
        break;
      default:
        title = `${KIND_TITLE[kind]}`;
    }
    const cameras = incident.cameraIds.map((id) => engine.getDevice(id)?.name ?? id);
    const lines = [
      `${title} - ${incident.detectorName}`,
      `Zone : ${incident.zone || 'non renseignee'}`,
      incident.lastValue === null ? '' : `Derniere mesure : ${incident.lastValue}${incident.valueUnit ? ` ${incident.valueUnit}` : ''}`,
      `Incident n°${incident.id}, ouvert a ${new Date(incident.openedAt).toLocaleTimeString('fr-FR')}`,
      confirmed ? `Confirmee : ${incident.confirmationReason?.replace('neighbor:', 'detecteur voisin ').replace('persistence', 'persistance')}` : "A confirmer : rien ne la corrobore pour l'instant, a traiter quand meme",
      incident.status === 'open' ? 'Etat : NON ACQUITTEE' : `Etat : acquittee par ${incident.ackedBy}`,
      cameras.length ? `Cameras : ${cameras.join(', ')}` : '',
      deps.publicUrl ? `Ouvrir le PSIM : ${deps.publicUrl}` : '',
    ].filter(Boolean);
    return {
      kind,
      incidentId: incident.id,
      subject: `[PSIM] ${title} - ${incident.detectorName}`,
      text: lines.join('\n'),
      data: {
        severity: incident.severity,
        category: incident.category,
        value: incident.lastValue,
        confirmed,
        status: incident.status,
        detectorId: incident.detectorId,
        detector: incident.detectorName,
        zone: incident.zone,
        cameras,
      },
    };
  }

  function logStart(incidentId: number | null, kind: Kind, channel: string, recipient: string, level: Level): number {
    const res = db
      .prepare("INSERT INTO notification_log (incident_id, kind, channel, recipient, level, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)")
      .run(incidentId, kind, channel, recipient, level, now());
    return Number(res.lastInsertRowid);
  }

  function logEnd(id: number, ok: boolean, attempts: number, error: string | null): void {
    db.prepare('UPDATE notification_log SET status = ?, attempts = ?, error = ? WHERE id = ?').run(ok ? 'sent' : 'failed', attempts, error, id);
  }

  /** Envoie a un destinataire avec reprises. Ne leve jamais d'exception. */
  async function deliver(
    channel: Channel,
    recipient: string,
    message: Message,
    level: Level,
    action: (c: Channel, r: string) => Promise<void> = (c, r) => c.send(message, r),
    attemptDelays: number[] = delays,
  ): Promise<{ ok: boolean; error: string | null }> {
    const row = logStart(message.incidentId, message.kind, channel.id, channel.mask(recipient), level);
    let error: string | null = null;
    let attempts = 0;
    for (const delay of attemptDelays) {
      if (delay > 0) await sleep(delay);
      attempts++;
      try {
        await action(channel, recipient);
        logEnd(row, true, attempts, null);
        return { ok: true, error: null };
      } catch (err) {
        error = redact(err instanceof Error ? err.message : 'echec');
      }
    }
    logEnd(row, false, attempts, error);
    engine.audit('systeme', 'notification_failed', {
      incidentId: message.incidentId ?? undefined,
      details: `${channel.label} ${channel.mask(recipient)} : ${error} (${attempts} tentative${attempts > 1 ? 's' : ''})`,
    });
    return { ok: false, error };
  }

  async function dispatch(message: Message, levels: Level[]): Promise<void> {
    const jobs: Promise<unknown>[] = [];
    for (const channel of channels) {
      for (const level of levels) {
        for (const recipient of channel.recipients(level)) jobs.push(deliver(channel, recipient, message, level));
      }
    }
    await Promise.all(jobs);
  }

  /** Ouverture, aggravation, confirmation : niveau 1. A lancer sans attendre. */
  function notifyIncident(incident: Incident, kind: 'opened' | 'escalated' | 'confirmed'): Promise<void> {
    return dispatch(incidentMessage(incident, kind), [1]);
  }

  /** Un detecteur muet laisse une zone sans surveillance : niveau 1. */
  function notifySilent(device: Device): Promise<void> {
    const text = `${device.name} (${device.zone || 'zone non renseignee'}) ne donne plus signe de vie : la zone n'est peut-etre plus surveillee.`;
    const title = device.category === 'fire' ? KIND_TITLE.silent : `CAPTEUR ${CATEGORY_LABEL_PLAIN[device.category].toUpperCase()} HORS LIGNE`;
    return dispatch({ kind: 'silent', incidentId: null, subject: `[PSIM] ${title} - ${device.name}`, text: deps.publicUrl ? `${text}\nOuvrir le PSIM : ${deps.publicUrl}` : text, data: { detectorId: device.id, detector: device.name, zone: device.zone, category: device.category } }, [1]);
  }

  /**
   * Le PSIM redemarre apres une periode ou il ne surveillait rien : des alarmes ont pu passer inapercues.
   * Niveau 1 (les destinataires d'ouverture). Jamais bloquant.
   */
  function notifyRestart(gap: { from: number; to: number; durationMs: number; clean: boolean }, openIncidents: number): Promise<void> {
    const when = (ts: number) => new Date(ts).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    const text = [
      `Le PSIM n'a rien surveille de ${when(gap.from)} a ${when(gap.to)} (${minutes(gap.durationMs)}).`,
      gap.clean ? 'Cause : arret volontaire (maintenance ?).' : 'Cause : arret INATTENDU (plantage, coupure de courant ou processus tue).',
      "Pendant ce temps, une alarme a pu passer inapercue : verifier les zones et l'etat des detecteurs.",
      openIncidents > 0 ? `${openIncidents} incident(s) restent ouverts.` : '',
      deps.publicUrl ? `Ouvrir le PSIM : ${deps.publicUrl}` : '',
    ].filter(Boolean).join('\n');
    return dispatch({ kind: 'restart', incidentId: null, subject: `[PSIM] ${KIND_TITLE.restart} - ${minutes(gap.durationMs)}`, text, data: { from: gap.from, to: gap.to, durationS: Math.round(gap.durationMs / 1000), clean: gap.clean, openIncidents } }, [1]);
  }

  /** Images prises a l'etape `kind`, envoyees en complement (apres le texte, qui part sans attendre). */
  async function sendImages(incidentId: number, kind: 'opened' | 'escalated' | 'confirmed'): Promise<void> {
    if (!deps.readSnapshot) return;
    const incident = engine.incidentView(incidentId);
    const images: ImageAttachment[] = [];
    for (const shot of incident.snapshots.filter((s) => s.reason === kind)) {
      const data = deps.readSnapshot(shot.id);
      if (data) images.push({ caption: `${engine.getDevice(shot.cameraId)?.name ?? shot.cameraId} - ${new Date(shot.takenAt).toLocaleTimeString('fr-FR')}`, data });
    }
    if (images.length === 0) return;
    const message = incidentMessage(incident, kind);
    const jobs: Promise<unknown>[] = [];
    for (const channel of channels) {
      if (!channel.sendImages) continue;
      for (const recipient of channel.recipients(1)) {
        jobs.push(deliver(channel, recipient, { ...message, kind }, 1, (c, r) => c.sendImages!(message, r, images)));
      }
    }
    await Promise.all(jobs);
  }

  /** Escalade : a appeler regulierement (une fois par seconde). */
  function tick(): void {
    if (deps.escalateAfterMs <= 0 || !hasRecipients(2)) return;
    const t = now();
    const ids = db.prepare("SELECT id FROM incident WHERE status = 'open'").all() as { id: number }[];
    for (const { id } of ids) {
      const last = (
        db
          .prepare("SELECT MAX(ts) AS t FROM audit_log WHERE incident_id = ? AND action IN ('incident_opened', 'incident_escalated', 'incident_confirmed')")
          .get(id) as { t: number | null }
      ).t;
      if (last === null || t - last < deps.escalateAfterMs) continue;

      // Les « tours » d'escalade sont materialises par des lignes-repere (canal 'round') : ecrites AVANT
      // l'envoi asynchrone, elles empechent tout double envoi meme si le controle repasse.
      const first = db
        .prepare("SELECT created_at FROM notification_log WHERE incident_id = ? AND channel = 'round' AND kind = 'unacked' AND created_at >= ? LIMIT 1")
        .get(id, last) as { created_at: number } | undefined;
      let round: 'unacked' | 'reminder' | null = null;
      if (!first) round = 'unacked';
      else {
        const rem = db
          .prepare("SELECT COUNT(*) AS n, MAX(created_at) AS m FROM notification_log WHERE incident_id = ? AND channel = 'round' AND kind = 'reminder' AND created_at >= ?")
          .get(id, last) as { n: number; m: number | null };
        if (rem.n < deps.maxReminders && t - (rem.m ?? first.created_at) >= deps.reminderMs) round = 'reminder';
      }
      if (!round) continue;

      db.prepare("INSERT INTO notification_log (incident_id, kind, channel, recipient, level, status, attempts, created_at) VALUES (?, ?, 'round', '-', 0, 'marker', 0, ?)").run(id, round, t);
      engine.audit('systeme', round === 'unacked' ? 'notification_escalated' : 'notification_reminder', {
        incidentId: id,
        details: round === 'unacked' ? `non acquittee depuis ${minutes(t - last)} : niveau 2 prevenu` : `rappel, toujours non acquittee depuis ${minutes(t - last)}`,
      });
      void dispatch(incidentMessage(engine.incidentView(id), round, t - last), round === 'unacked' ? [2] : [1, 2]);
    }
  }

  /** Message de test immediat (une seule tentative) vers tous les destinataires des deux niveaux. */
  async function test(): Promise<{ channel: string; recipient: string; level: Level; ok: boolean; error: string | null }[]> {
    const message: Message = {
      kind: 'test',
      incidentId: null,
      subject: '[PSIM] MESSAGE DE TEST',
      text: `Ceci est un message de test du PSIM, envoye a ${new Date(now()).toLocaleTimeString('fr-FR')}. Aucune action n'est requise.`,
      data: {},
    };
    const results: { channel: string; recipient: string; level: Level; ok: boolean; error: string | null }[] = [];
    await Promise.all(
      channels.flatMap((channel) =>
        ([1, 2] as Level[]).flatMap((level) =>
          channel.recipients(level).map(async (recipient) => {
            const r = await deliver(channel, recipient, message, level, undefined, [0]);
            results.push({ channel: channel.label, recipient: channel.mask(recipient), level, ok: r.ok, error: r.error });
          }),
        ),
      ),
    );
    return results;
  }

  function status() {
    const since = now() - 24 * 3_600_000;
    return {
      escalateAfterS: Math.round(deps.escalateAfterMs / 1000),
      reminderS: Math.round(deps.reminderMs / 1000),
      maxReminders: deps.maxReminders,
      channels: channels.map((c) => ({ id: c.id, label: c.label, level1: c.recipients(1).length, level2: c.recipients(2).length })),
      /** Canaux qui ont au moins un destinataire (ceux qui previennent reellement quelqu'un). */
      activeChannels: channels.filter((c) => c.recipients(1).length + c.recipients(2).length > 0).length,
      sentLast24h: (db.prepare("SELECT COUNT(*) AS n FROM notification_log WHERE channel <> 'round' AND status = 'sent' AND created_at >= ?").get(since) as { n: number }).n,
      failedLast24h: (db.prepare("SELECT COUNT(*) AS n FROM notification_log WHERE channel <> 'round' AND status = 'failed' AND created_at >= ?").get(since) as { n: number }).n,
      recent: (
        db
          .prepare("SELECT incident_id, kind, channel, recipient, level, status, error, created_at FROM notification_log WHERE channel <> 'round' ORDER BY id DESC LIMIT 20")
          .all() as Record<string, unknown>[]
      ).map((r) => ({ incidentId: r.incident_id, kind: r.kind, channel: r.channel, recipient: r.recipient, level: r.level, status: r.status, error: r.error, at: r.created_at })),
    };
  }

  return { notifyIncident, notifySilent, notifyRestart, sendImages, tick, test, status };
}

export type Notifier = ReturnType<typeof createNotifier>;
