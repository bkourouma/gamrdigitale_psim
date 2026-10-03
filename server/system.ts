/**
 * Etat du PSIM lui-meme : qui surveille le surveillant ? Deux usages :
 *  - /healthz (sans authentification, minimal) pour un surveillant externe (superviseur, tache planifiee, load balancer) ;
 *  - /api/system (administrateur) : etat detaille et liste d'avertissements actionnables.
 */
import { existsSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Gap } from './continuity.ts';
import type { HeartbeatStatus } from './heartbeat.ts';

export interface BackupStatus {
  at: number | null;
  ok: boolean | null;
  name: string | null;
  bytes: number | null;
  error: string | null;
}

export interface SystemDeps {
  db: DatabaseSync;
  dataDir: string;
  version: string;
  now?: () => number;
  startedAt: number;
  lastTickAt: () => number;
  brokerClients: () => number;
  snapshotsBytes: () => number;
  /** Espace disque (injectable pour les tests) ; par defaut celui du dossier de donnees. */
  disk?: () => { freeBytes: number; totalBytes: number } | null;
  notificationChannels: () => { channels: number; failedLast24h: number; sentLast24h: number };
  backup: { everyH: number; dir: string; last: () => BackupStatus; count: () => number };
  /** Derniere periode aveugle (PSIM arrete), et etat du signal de supervision externe. */
  lastGap?: () => Gap | null;
  heartbeat?: () => HeartbeatStatus;
  /** Derniere verification du journal (chaine d'empreintes). */
  journal?: () => { ok: boolean; at: number; checked: number; unprotected?: number } | null;
  /** Rapport periodique par e-mail. */
  reportMail?: () => { enabled: boolean; lastError: string | null; lastSentAt: number | null };
  /** Comptes dont le secret 2FA est illisible (cle de chiffrement differente). */
  unreadableSecrets?: () => string[];
}

const GB = 1024 ** 3;
// Seuils ABSOLUS : le PSIM ecrit quelques Mo par jour, un pourcentage serait trompeur sur un gros disque.
const LOW_FREE_BYTES = 2 * GB;
const CRITICAL_FREE_BYTES = GB / 2;

export interface Warning {
  level: 'critique' | 'attention';
  message: string;
}

export function createSystemStatus(deps: SystemDeps) {
  const now = deps.now ?? Date.now;

  /** Sante minimale : la base repond et la boucle de controle tourne (sinon plus de detection de panne ni d'escalade). */
  function health(): { ok: boolean; reason?: string } {
    try {
      deps.db.prepare('SELECT 1').get();
    } catch {
      return { ok: false, reason: 'base de donnees inaccessible' };
    }
    const age = now() - deps.lastTickAt();
    if (age > 15_000) return { ok: false, reason: `boucle de controle bloquee depuis ${Math.round(age / 1000)} s` };
    return { ok: true };
  }

  function disk(): { freeBytes: number; totalBytes: number } | null {
    if (deps.disk) return deps.disk();
    try {
      const s = statfsSync(deps.dataDir);
      return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
    } catch {
      return null;
    }
  }

  function detail() {
    const t = now();
    const dbFile = join(deps.dataDir, 'psim.db');
    const dbBytes = [dbFile, `${dbFile}-wal`].reduce((sum, f) => sum + (existsSync(f) ? statSync(f).size : 0), 0);
    const detectors = deps.db.prepare("SELECT status, COUNT(*) AS n FROM device WHERE kind = 'detector' GROUP BY status").all() as { status: string; n: number }[];
    const byStatus = Object.fromEntries(detectors.map((d) => [d.status, d.n]));
    const open = (deps.db.prepare("SELECT COUNT(*) AS n FROM incident WHERE status <> 'closed'").get() as { n: number }).n;
    const d = disk();
    const backup = deps.backup.last();
    const notif = deps.notificationChannels();
    const h = health();

    const warnings: Warning[] = [];
    if (!h.ok) warnings.push({ level: 'critique', message: `Sante degradee : ${h.reason}.` });
    if (d && d.freeBytes < LOW_FREE_BYTES) {
      warnings.push({ level: d.freeBytes < CRITICAL_FREE_BYTES ? 'critique' : 'attention', message: `Disque presque plein : ${(d.freeBytes / GB).toFixed(1)} Go libres. Sans espace, la base ne peut plus enregistrer les alarmes.` });
    }
    const offline = (byStatus.offline ?? 0) + (byStatus.fault ?? 0);
    if (offline > 0) warnings.push({ level: 'attention', message: `${offline} detecteur(s) hors service : leurs zones ne sont pas surveillees.` });
    if (notif.channels === 0) warnings.push({ level: 'attention', message: "Aucun canal de notification configure : une alarme ne previent personne hors de l'ecran." });
    if (notif.failedLast24h > 0) warnings.push({ level: 'attention', message: `${notif.failedLast24h} notification(s) en echec sur 24 h.` });
    const journal = deps.journal?.() ?? null;
    if (journal && !journal.ok) warnings.push({ level: 'critique', message: "Le journal a ete ALTERE (verification d'integrite en echec) : traiter comme un incident de securite, voir `npm run verify-journal`." });
    const unreadable = deps.unreadableSecrets?.() ?? [];
    if (unreadable.length > 0) warnings.push({ level: 'critique', message: `La cle de chiffrement (data/secret.key ou PSIM_SECRET_KEY) ne correspond pas a celle qui a scelle les secrets 2FA de : ${unreadable.join(', ')}. Ces comptes ne peuvent se connecter qu'avec un code de secours, ou apres \`npm run reset-2fa -- <compte>\`. Les mots de passe des cameras sont aussi illisibles : les ressaisir.` });
    const rm = deps.reportMail?.() ?? null;
    if (rm?.enabled && rm.lastError) warnings.push({ level: 'attention', message: `Le dernier rapport periodique par e-mail n'a pas pu partir : ${rm.lastError}.` });
    const gap = deps.lastGap?.() ?? null;
    if (gap && !gap.clean && t - gap.to < 24 * 3_600_000) {
      warnings.push({ level: 'attention', message: `Redemarrage apres un arret inattendu : le PSIM n'a rien surveille pendant ${Math.round(gap.durationMs / 60_000) || 1} min (${new Date(gap.from).toLocaleString('fr-FR')}). Verifier ce qui s'est passe.` });
    }
    const beat = deps.heartbeat?.() ?? null;
    if (beat?.configured && beat.consecutiveFailures >= 3) {
      warnings.push({ level: 'attention', message: `Supervision externe : ${beat.consecutiveFailures} signaux sans succes (${beat.lastError ?? 'erreur'}). Si le PSIM s'arrete, personne ne sera prevenu.` });
    }
    if (deps.backup.everyH > 0) {
      const limit = deps.backup.everyH * 2 * 3_600_000;
      if (backup.ok === false) warnings.push({ level: 'critique', message: `La derniere sauvegarde a echoue : ${backup.error ?? 'erreur inconnue'}.` });
      else if (backup.at === null && t - deps.startedAt > limit) warnings.push({ level: 'critique', message: 'Aucune sauvegarde depuis le demarrage.' });
      else if (backup.at !== null && t - backup.at > limit) warnings.push({ level: 'critique', message: `Derniere sauvegarde reussie il y a ${Math.round((t - backup.at) / 3_600_000)} h.` });
    } else {
      warnings.push({ level: 'attention', message: 'Sauvegarde automatique desactivee : planifiez `npm run backup`.' });
    }

    return {
      health: h,
      version: deps.version,
      node: process.version,
      uptimeS: Math.round((t - deps.startedAt) / 1000),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      database: { bytes: dbBytes },
      snapshotsBytes: deps.snapshotsBytes(),
      disk: d,
      brokerClients: deps.brokerClients(),
      detectors: byStatus,
      openIncidents: open,
      notifications: notif,
      backup: { ...backup, everyH: deps.backup.everyH, count: deps.backup.count(), dir: deps.backup.dir },
      continuity: { lastGap: gap },
      journal,
      heartbeat: beat,
      warnings,
    };
  }

  return { health, detail };
}

export type SystemStatus = ReturnType<typeof createSystemStatus>;
