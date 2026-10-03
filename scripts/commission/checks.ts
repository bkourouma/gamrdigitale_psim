/**
 * Controles de mise en service : chaque fonction verifie UN point de l'installation reelle (heure, certificat,
 * ffmpeg, SMTP, Telegram, webhooks, supervision externe, disque, sauvegardes, cameras, inventaire, journal) et rend un
 * verdict lisible avec, en cas de probleme, la marche a suivre. Aucune ne leve d'exception ; aucune n'envoie de message
 * d'alerte (sauf demande explicite d'un message de test) ; aucune ne modifie les donnees du PSIM.
 */
import { spawnSync } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { statfsSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import nodemailer from 'nodemailer';
import { verify as verifyJournal } from '../../server/auditchain.ts';
import { listBackups, verifyBackup } from '../../server/backup.ts';

export type Status = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  id: string;
  title: string;
  status: Status;
  detail: string;
  /** Marche a suivre quand le point n'est pas bon. */
  fix?: string;
}

const check = (id: string, title: string, status: Status, detail: string, fix?: string): Check => ({ id, title, status, detail, fix });
const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 160);
const code = (err: unknown): string => (err as NodeJS.ErrnoException | undefined)?.code ?? '';

/** Execute un controle sans jamais laisser remonter d'exception : un controle qui plante est un controle en echec. */
export async function safely(id: string, title: string, fn: () => Promise<Check> | Check): Promise<Check> {
  try {
    return await fn();
  } catch (err) {
    return check(id, title, 'fail', `controle impossible : ${msg(err)}`);
  }
}

// ---------------------------------------------------------------- heure

export interface ClockOptions {
  /** Adresse HTTP(S) dont on lit l'en-tete Date pour mesurer l'ecart (le service de supervision externe, par exemple). */
  referenceUrl?: string;
  now?: () => number;
  fetch?: (url: string, init: { method: string; signal: AbortSignal }) => Promise<{ headers: { get(name: string): string | null } }>;
}

export async function checkClock(opts: ClockOptions = {}): Promise<Check> {
  const now = opts.now ?? Date.now;
  const local = `${new Date(now()).toLocaleString('fr-FR')} (UTC${-new Date(now()).getTimezoneOffset() >= 0 ? '+' : '-'}${Math.abs(new Date(now()).getTimezoneOffset() / 60)}, ${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
  const fix = "Regler l'heure et le fuseau de la machine (synchronisation NTP). Les plannings d'armement, les rapports et le journal suivent cette heure.";
  if (!opts.referenceUrl) return check('clock', 'Heure du serveur', 'skip', `${local} ; aucune reference externe pour mesurer l'ecart (renseigner PSIM_HEARTBEAT_URL, ou comparer a une horloge fiable)`, fix);
  try {
    const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
    const res = await doFetch(opts.referenceUrl, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    const date = res.headers.get('date');
    const remote = date ? Date.parse(date) : NaN;
    if (!Number.isFinite(remote)) return check('clock', 'Heure du serveur', 'skip', `${local} ; le serveur de reference ne donne pas son heure`, fix);
    const drift = Math.round((now() - remote) / 1000);
    const text = `${local} ; ecart de ${drift >= 0 ? '+' : ''}${drift} s avec la reference`;
    if (Math.abs(drift) > 600) return check('clock', 'Heure du serveur', 'fail', text, fix);
    if (Math.abs(drift) > 120) return check('clock', 'Heure du serveur', 'warn', text, fix);
    return check('clock', 'Heure du serveur', 'ok', text);
  } catch (err) {
    return check('clock', 'Heure du serveur', 'skip', `${local} ; reference injoignable (${msg(err)})`, fix);
  }
}

// ---------------------------------------------------------------- certificat HTTPS

export function checkTls(files: { cert: string; key: string }, now = Date.now()): Check {
  if (!files.cert || !files.key) {
    return check('tls', 'Certificat HTTPS', 'warn', 'HTTPS non configure : identifiants et sessions circulent en clair', 'Acceptable uniquement sur un reseau isole. Sinon : `npm run make-cert -- <nom> <adresse>` puis PSIM_TLS_CERT / PSIM_TLS_KEY, ou un proxy HTTPS (PSIM_TRUST_PROXY=1).');
  }
  if (!existsSync(files.cert) || !existsSync(files.key)) return check('tls', 'Certificat HTTPS', 'fail', 'fichier de certificat ou de cle introuvable', 'Verifier PSIM_TLS_CERT et PSIM_TLS_KEY.');
  const cert = new X509Certificate(readFileSync(files.cert));
  let matches = false;
  try {
    matches = cert.checkPrivateKey(createPrivateKey(readFileSync(files.key)));
  } catch {
    matches = false;
  }
  if (!matches) return check('tls', 'Certificat HTTPS', 'fail', 'la cle privee ne correspond pas au certificat', 'Utiliser la cle qui a servi a produire ce certificat, ou regenerer les deux.');
  const days = Math.floor((new Date(cert.validTo).getTime() - now) / 86_400_000);
  const names = (cert.subjectAltName ?? '').replace(/DNS:|IP Address:/g, '').trim() || cert.subject.replace(/\s+/g, ' ');
  const selfSigned = cert.subject === cert.issuer;
  const detail = `valable jusqu'au ${new Date(cert.validTo).toLocaleDateString('fr-FR')} (${days} j) pour ${names}${selfSigned ? ' ; auto-signe' : ''}`;
  if (days < 0) return check('tls', 'Certificat HTTPS', 'fail', `EXPIRE depuis ${-days} j : ${detail}`, 'Renouveler le certificat (npm run make-cert, ou votre autorite) et redemarrer le PSIM.');
  if (days < 30) return check('tls', 'Certificat HTTPS', 'warn', `expire bientot : ${detail}`, 'Prevoir le renouvellement avant expiration : apres, les navigateurs refuseront le site.');
  return check('tls', 'Certificat HTTPS', 'ok', detail);
}

// ---------------------------------------------------------------- ffmpeg

export function checkFfmpeg(path: string): Check {
  const r = spawnSync(path, ['-version'], { encoding: 'utf8', timeout: 8000 });
  if (r.error || r.status !== 0) {
    return check('ffmpeg', 'ffmpeg (images des cameras)', 'fail', `introuvable ou inutilisable (« ${path} »)`, 'Installer ffmpeg et l\'ajouter au PATH, ou renseigner PSIM_FFMPEG avec son chemin complet. Sans lui : aucune image de camera reelle.');
  }
  return check('ffmpeg', 'ffmpeg (images des cameras)', 'ok', (r.stdout.split(/\r?\n/)[0] ?? 'ffmpeg').slice(0, 90));
}

// ---------------------------------------------------------------- SMTP

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  starttls: boolean;
}

function explainSmtp(err: unknown): string {
  const c = code(err);
  const text = msg(err);
  if (c === 'ECONNREFUSED' || /ECONNREFUSED/.test(text)) return "connexion refusee : mauvais hote ou port, ou pare-feu";
  if (c === 'ETIMEDOUT' || c === 'ESOCKET' || /timeout/i.test(text)) return 'aucune reponse : hote ou port injoignable (pare-feu, mauvais port)';
  if (c === 'ENOTFOUND' || c === 'EDNS') return "nom de serveur introuvable (verifier PSIM_SMTP_HOST et le DNS)";
  if (c === 'EAUTH' || /auth|535|credentials/i.test(text)) return "authentification refusee (identifiant ou mot de passe, ou mot de passe d'application requis)";
  if (/certificate|self.signed|CERT_/i.test(text)) return 'certificat du serveur SMTP non reconnu';
  if (/wrong version|ssl|tls/i.test(text)) return 'echec TLS : essayer PSIM_SMTP_SECURE=1 avec le port 465, ou PSIM_SMTP_STARTTLS=0 sur un relais interne en clair';
  return text;
}

/** Verifie la connexion et l'authentification SMTP SANS envoyer de message ; `sendTo` envoie un message de test. */
export async function checkSmtp(cfg: SmtpOptions, sendTo?: string): Promise<Check> {
  if (!cfg.host || !cfg.from) return check('smtp', 'E-mail (SMTP)', 'skip', 'non configure (PSIM_SMTP_HOST, PSIM_SMTP_FROM) : pas d\'alerte ni de rapport par e-mail');
  const transporter = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure, ignoreTLS: cfg.starttls === false,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined, connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10_000,
  });
  try {
    await transporter.verify();
  } catch (err) {
    return check('smtp', 'E-mail (SMTP)', 'fail', `${cfg.host}:${cfg.port} : ${explainSmtp(err)}`, 'Corriger PSIM_SMTP_* dans .env, puis relancer ce controle.');
  }
  if (!sendTo) return check('smtp', 'E-mail (SMTP)', 'ok', `${cfg.host}:${cfg.port} : connexion et authentification reussies (aucun message envoye ; --send-mail <adresse> pour un essai)`);
  try {
    await transporter.sendMail({ from: cfg.from, to: sendTo, subject: '[PSIM] Message de test de mise en service', text: "Ceci est un message de test envoye pendant la mise en service du PSIM. Aucune action n'est requise." });
    return check('smtp', 'E-mail (SMTP)', 'ok', `${cfg.host}:${cfg.port} : message de test envoye a ${sendTo.replace(/^(.).*(@.*)$/, '$1***$2')} (verifier sa reception, y compris dans les indesirables)`);
  } catch (err) {
    return check('smtp', 'E-mail (SMTP)', 'fail', `connexion reussie mais envoi refuse : ${explainSmtp(err)}`, "Verifier PSIM_SMTP_FROM (certains serveurs n'acceptent qu'une adresse autorisee) et le destinataire.");
  }
}

// ---------------------------------------------------------------- Telegram

export async function checkTelegram(cfg: { token: string; apiBase: string }, chat?: string, fetchImpl: typeof fetch = fetch): Promise<Check> {
  if (!cfg.token) return check('telegram', 'Telegram', 'skip', 'non configure (PSIM_TELEGRAM_TOKEN)');
  const base = `${cfg.apiBase.replace(/\/$/, '')}/bot${cfg.token}`;
  try {
    const res = await fetchImpl(`${base}/getMe`, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { username?: string }; description?: string };
    if (!res.ok || !body.ok) return check('telegram', 'Telegram', 'fail', `jeton refuse (HTTP ${res.status}${body.description ? ` : ${String(body.description).slice(0, 60)}` : ''})`, "Verifier PSIM_TELEGRAM_TOKEN aupres de @BotFather.");
    if (!chat) return check('telegram', 'Telegram', 'ok', `jeton valide (robot @${body.result?.username ?? '?'}) ; aucun message envoye (--telegram-chat <id> pour un essai)`);
    const sent = await fetchImpl(`${base}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: '[PSIM] Message de test de mise en service. Aucune action requise.' }), signal: AbortSignal.timeout(8000) });
    if (!sent.ok) return check('telegram', 'Telegram', 'fail', `jeton valide, mais envoi refuse a la conversation ${chat} (HTTP ${sent.status})`, "Le destinataire doit avoir ecrit au robot au moins une fois (/start) ; verifier l'identifiant de conversation.");
    return check('telegram', 'Telegram', 'ok', `message de test envoye a la conversation ${chat}`);
  } catch {
    // Le message d'erreur de fetch contient l'adresse, donc le jeton : jamais propage.
    return check('telegram', 'Telegram', 'fail', 'Telegram injoignable (reseau, pare-feu ou proxy)', "Le serveur doit pouvoir joindre api.telegram.org en HTTPS.");
  }
}

// ---------------------------------------------------------------- webhooks

/** Verifie que chaque adresse de webhook est joignable (DNS + connexion TCP), SANS rien envoyer. */
export async function checkWebhooks(urls: string[], connectTimeoutMs = 5000): Promise<Check> {
  if (urls.length === 0) return check('webhook', 'Webhooks', 'skip', 'aucun webhook configure');
  const problems: string[] = [];
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      problems.push('adresse invalide');
      continue;
    }
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    try {
      const { address } = await lookup(u.hostname);
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: address, port, timeout: connectTimeoutMs }, () => (socket.destroy(), resolve()));
        socket.on('timeout', () => (socket.destroy(), reject(new Error('delai depasse'))));
        socket.on('error', reject);
      });
    } catch (err) {
      problems.push(`${u.host} : ${code(err) === 'ENOTFOUND' ? 'nom introuvable' : code(err) === 'ECONNREFUSED' ? 'connexion refusee' : msg(err)}`);
    }
  }
  return problems.length
    ? check('webhook', 'Webhooks', 'fail', problems.join(' ; '), "Verifier l'adresse et l'acces reseau depuis le serveur du PSIM.")
    : check('webhook', 'Webhooks', 'ok', `${urls.length} adresse(s) joignable(s) (connexion TCP seulement : aucune alerte envoyee)`);
}

// ---------------------------------------------------------------- supervision externe

export async function checkHeartbeat(url: string, fetchImpl: typeof fetch = fetch): Promise<Check> {
  if (!url) return check('heartbeat', 'Supervision externe', 'warn', 'non configuree (PSIM_HEARTBEAT_URL) : si le PSIM s\'arrete, personne n\'est prevenu', "Creer un moniteur « dead man's switch » (healthchecks.io, Uptime Kuma) et renseigner son adresse.");
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  })();
  if (!host) return check('heartbeat', 'Supervision externe', 'fail', 'adresse invalide', 'Verifier PSIM_HEARTBEAT_URL.');
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!res.ok) return check('heartbeat', 'Supervision externe', 'fail', `${host} a repondu HTTP ${res.status}`, "Verifier l'adresse (jeton) dans le service de supervision.");
    return check('heartbeat', 'Supervision externe', 'ok', `signal recu par ${host} : verifier dans le service qu'il apparait, et que l'alerte part vers quelqu'un hors du reseau du PSIM`);
  } catch {
    return check('heartbeat', 'Supervision externe', 'fail', `${host} injoignable (reseau, pare-feu, ou redirection refusee)`, "Le serveur doit pouvoir joindre ce service en HTTPS.");
  }
}

// ---------------------------------------------------------------- disque et sauvegardes

const GB = 1024 ** 3;

export function checkDisk(dataDir: string): Check {
  let free = NaN;
  try {
    const s = statfsSync(dataDir);
    free = Number(s.bavail) * Number(s.bsize);
  } catch {
    // dossier absent
  }
  if (!existsSync(dataDir)) return check('disk', 'Disque et dossier de donnees', 'fail', `dossier introuvable : ${dataDir}`, 'Verifier PSIM_DATA_DIR.');
  let writable = true;
  try {
    const dir = mkdtempSync(join(dataDir, '.commission-'));
    writeFileSync(join(dir, 't'), 'ok');
    rmSync(dir, { recursive: true, force: true });
  } catch {
    writable = false;
  }
  if (!writable) return check('disk', 'Disque et dossier de donnees', 'fail', `${dataDir} n'est pas accessible en ecriture`, "Le compte qui execute le PSIM doit pouvoir ecrire dans ce dossier.");
  const text = Number.isFinite(free) ? `${(free / GB).toFixed(1)} Go libres` : 'espace libre inconnu';
  if (Number.isFinite(free) && free < GB / 2) return check('disk', 'Disque et dossier de donnees', 'fail', `${text} : critique`, 'Liberer de la place : sans espace, la base ne peut plus enregistrer les alarmes.');
  if (Number.isFinite(free) && free < 2 * GB) return check('disk', 'Disque et dossier de donnees', 'warn', `${text}`, 'Liberer de la place ou deplacer le dossier de donnees.');
  return check('disk', 'Disque et dossier de donnees', 'ok', `${text}, ecriture possible`);
}

/** Sans aucune sauvegarde, c'est un echec en production et une simple attention sinon. */
export function checkBackups(backupDir: string, everyH: number, now = Date.now(), production = false): Check {
  const list = existsSync(backupDir) ? listBackups(backupDir) : [];
  if (list.length === 0) {
    return check('backup', 'Sauvegardes', production && everyH <= 0 ? 'fail' : 'warn', `aucune sauvegarde dans ${backupDir}${everyH > 0 ? ' (la premiere part peu apres le demarrage)' : ''}`, '`npm run backup`, puis planifier (PSIM_BACKUP_EVERY_H) et copier les sauvegardes HORS de cette machine.');
  }
  const latest = list[0];
  const v = verifyBackup(join(backupDir, latest.name));
  if (!v.ok) return check('backup', 'Sauvegardes', 'fail', `la derniere sauvegarde (${latest.name}) est INVALIDE : ${v.problems.slice(0, 2).join(' ; ')}`, 'Refaire une sauvegarde et en verifier une restauration.');
  const ageH = Math.round((now - latest.createdAt) / 3_600_000);
  const text = `${list.length} sauvegarde(s), derniere il y a ${ageH} h (${latest.name}), integrite verifiee`;
  if (everyH > 0 && ageH > everyH * 2) return check('backup', 'Sauvegardes', 'warn', `${text} : trop ancienne`, 'Verifier que la sauvegarde automatique tourne.');
  return check('backup', 'Sauvegardes', 'ok', `${text} ; penser a un essai de restauration sur une autre machine`);
}

// ---------------------------------------------------------------- inventaire, cameras, journal

type Row = Record<string, unknown>;

/**
 * La base a-t-elle le schema de cette version ? Une base d'une version anterieure n'est migree qu'au demarrage du PSIM :
 * tant que ce n'est pas fait, les controles qui la lisent ne sont pas fiables. Renvoie la raison, ou `null` si tout va bien.
 */
export function schemaProblem(db: DatabaseSync): string | null {
  const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const missing: string[] = [];
  if (!columns('device').includes('category')) missing.push('device.category');
  if (!columns('audit_log').includes('hash')) missing.push('audit_log.hash');
  if (columns('notification_recipient').length === 0) missing.push('table notification_recipient');
  if (columns('app_user').length > 0 && !columns('app_user').includes('totp_enabled_at')) missing.push('app_user.totp_enabled_at');
  return missing.length ? `base d'une version anterieure (manque : ${missing.join(', ')})` : null;
}

export function checkInventory(db: DatabaseSync): Check[] {
  const out: Check[] = [];
  const detectors = db.prepare("SELECT id, name, category, zone, last_seen FROM device WHERE kind = 'detector' ORDER BY id").all() as Row[];
  const cameras = db.prepare("SELECT id, name FROM device WHERE kind = 'camera' ORDER BY id").all() as Row[];
  const site = db.prepare('SELECT plan_file FROM site WHERE id = 1').get() as Row | undefined;
  out.push(
    detectors.length === 0
      ? check('inventory', 'Inventaire', 'fail', 'aucun detecteur declare', 'Ajouter les detecteurs (Edition du plan et de l\'inventaire).')
      : check('inventory', 'Inventaire', 'ok', `${detectors.length} detecteur(s), ${cameras.length} camera(s)`),
  );
  const unplaced = detectors.filter((d) => !d.zone);
  if (unplaced.length) out.push(check('zones', 'Zones', 'warn', `${unplaced.length} detecteur(s) sans zone : ${unplaced.map((d) => d.id).join(', ')}`, "Sans zone, pas de confirmation par un voisin, ni de risque par zone."));
  const unlinked = detectors.filter((d) => !(db.prepare('SELECT 1 AS x FROM device_link WHERE detector_id = ? LIMIT 1').get(d.id as string)));
  if (unlinked.length) out.push(check('links', 'Cameras liees', 'warn', `${unlinked.length} detecteur(s) sans camera liee : ${unlinked.map((d) => d.id).join(', ')}`, "Sans camera liee, l'operateur n'a pas d'image a l'ouverture de l'incident."));
  if (site && !site.plan_file) out.push(check('plan', 'Plan', 'warn', 'aucun plan du site', 'Edition du plan : remplacer le plan, puis placer les pastilles.'));
  const silent = detectors.filter((d) => d.last_seen === null);
  if (silent.length) out.push(check('heard', 'Detecteurs jamais entendus', 'warn', `${silent.length} detecteur(s) n'ont jamais emis : ${silent.slice(0, 12).map((d) => d.id).join(', ')}${silent.length > 12 ? '...' : ''}`, 'Lancer `npm run commission -- watch` et declencher chaque detecteur (voir la fiche de recette).'));
  const admins = db.prepare("SELECT username, totp_enabled_at FROM app_user WHERE role = 'admin' AND active = 1").all() as Row[];
  const without2fa = admins.filter((a) => !a.totp_enabled_at);
  if (admins.length && without2fa.length) out.push(check('2fa', 'Double authentification', 'warn', `administrateur(s) sans 2FA : ${without2fa.map((a) => a.username).join(', ')}`, 'Chaque administrateur : Mon compte, Activer la double authentification.'));
  const recipients = (db.prepare('SELECT COUNT(*) AS n FROM notification_recipient WHERE active = 1').get() as { n: number }).n;
  out.push(check('recipients', 'Destinataires (interface)', recipients > 0 ? 'ok' : 'skip', recipients > 0 ? `${recipients} destinataire(s) actif(s) saisi(s) dans l'interface (s'ajoutent a ceux du .env)` : "aucun destinataire saisi dans l'interface (ceux du .env comptent aussi)"));
  return out;
}

export function checkJournal(db: DatabaseSync): Check {
  const v = verifyJournal(db);
  if (!v.ok) return check('journal', 'Journal infalsifiable', 'fail', `ALTERE : ${v.problems.slice(0, 2).map((p) => `n°${p.id} ${p.reason}`).join(' ; ')}`, 'Ne rien modifier ; conserver une copie de la base ; voir README, « Journal infalsifiable ».');
  return check('journal', 'Journal infalsifiable', 'ok', `${v.checked} entree(s) protegee(s), chaine intacte${v.head ? ` (ancre ${v.head.id}:${v.head.hash.slice(0, 12)}...)` : ''}`);
}

export interface CameraTester {
  /** Teste une camera reelle : renvoie un message (« Image recue ... ») ou leve une erreur lisible. */
  test(cameraId: string): Promise<{ ok: boolean; message: string }>;
}

/** Teste chaque camera reelle (ONVIF/RTSP) en tentant de recevoir une image. Les cameras simulees sont signalees. */
export async function checkCameras(db: DatabaseSync, tester: CameraTester | null): Promise<Check[]> {
  const cameras = db.prepare("SELECT d.id, d.name, s.kind FROM device d LEFT JOIN camera_source s ON s.device_id = d.id WHERE d.kind = 'camera' ORDER BY d.id").all() as Row[];
  if (cameras.length === 0) return [check('cameras', 'Cameras', 'warn', 'aucune camera declaree', 'Ajouter les cameras dans l\'inventaire, puis leur source video.')];
  const out: Check[] = [];
  for (const c of cameras) {
    const id = c.id as string;
    const title = `Camera ${id} (${c.name})`;
    if (!c.kind) {
      out.push(check(`camera-${id}`, title, 'warn', 'source simulee : aucune image reelle', "Renseigner sa source (ONVIF ou RTSP) dans l'inventaire."));
      continue;
    }
    if (!tester) {
      out.push(check(`camera-${id}`, title, 'skip', 'test non effectue (cle de chiffrement introuvable)'));
      continue;
    }
    try {
      const r = await tester.test(id);
      out.push(check(`camera-${id}`, title, r.ok ? 'ok' : 'fail', r.message));
    } catch (err) {
      out.push(check(`camera-${id}`, title, 'fail', msg(err), "Verifier l'adresse, le port, l'identifiant, le mot de passe et que le flux RTSP est active sur la camera."));
    }
  }
  return out;
}

// ---------------------------------------------------------------- rendu

const ICON: Record<Status, string> = { ok: 'OK    ', warn: 'ATTENTION', fail: 'ECHEC ', skip: 'ignore' };

export function formatChecks(checks: Check[]): string {
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${ICON[c.status].padEnd(9)} ${c.title} : ${c.detail}`);
    if (c.fix && c.status !== 'ok' && c.status !== 'skip') lines.push(`          -> ${c.fix}`);
  }
  const count = (s: Status) => checks.filter((c) => c.status === s).length;
  lines.push('', `Bilan : ${count('ok')} ok, ${count('warn')} attention, ${count('fail')} echec(s), ${count('skip')} ignore(s).`);
  return lines.join('\n');
}

/** Code de sortie : 1 s'il y a au moins un echec. */
export const exitCodeFor = (checks: Check[]): number => (checks.some((c) => c.status === 'fail') ? 1 : 0);
