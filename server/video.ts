import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { Engine } from './engine.ts';
import { PsimError } from './engine.ts';
import { probeOnvif } from './onvif.ts';
import { seal, unseal } from './secrets.ts';
import type { PsimEvent } from './types.ts';

export const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{0,199}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const BOUNDARY = 'psimframe';
const MAX_FEEDS = 6;
const IDLE_STOP_MS = 5000;
const FIRST_FRAME_TIMEOUT_MS = 15000;
/** Serie d'images d'incident : une toutes les 1,5 s, apres 0,5 s de flux (voir `snapshotSeries`). */
const SERIES_EVERY_MS = 1500;
const SERIES_SETTLE_MS = 500;

/** Une image d'une serie, avec l'heure REELLE a laquelle elle a ete retenue. */
export interface TimedFrame {
  frame: Buffer;
  at: number;
}
const MAX_FRAME_BUFFER = 8 * 1024 * 1024;

/**
 * Format d'affichage de l'image. Les enregistreurs (XVR, NVR) envoient souvent une image « compressee en largeur » :
 * 704x576, 352x288 ou 176x144 (tailles analogiques), 1440x1620 ou 960x1080 (demi-largeur d'une image 16:9), 1296x1944
 * (demi-largeur d'une image 4:3), sans dire comment l'afficher. Telle quelle, l'image parait ecrasee.
 *  - auto : rapport de pixel annonce par le flux s'il est plausible ; sinon ces tailles connues -> 16:9 (ou 4:3 pour la
 *    demi-largeur 4:3) ; sinon tel quel. Une taille analogique est ambigue (camera HD 16:9 ou ancienne camera 4:3) :
 *    16:9 est choisi (cameras HD actuelles) ; une ancienne camera analogique se regle a la main en 4:3 ;
 *  - 16:9 / 4:3 : impose (camera dont le format est connu) ;
 *  - source : tel que recu, sans correction.
 * Les memes regles existent en deux formes : expression ffmpeg (l'image) et displayRatio (le message de test) ; un test
 * verifie qu'elles s'accordent.
 */
export const ASPECTS = ['auto', '16:9', '4:3', 'source'] as const;
export type Aspect = (typeof ASPECTS)[number];

/** Tailles d'enregistreur representant une image 16:9 compressee en largeur (analogiques, ou demi-largeur 16:9). */
const ANAMORPHIC_16_9 =
  'eq(18*iw,16*ih)+(eq(iw,704)+eq(iw,720)+eq(iw,352)+eq(iw,360)+eq(iw,176))*(eq(ih,576)+eq(ih,480)+eq(ih,288)+eq(ih,240)+eq(ih,144)+eq(ih,120))';
/** Demi-largeur d'une image 4:3 (5M-N : 1296x1944 pour 2592x1944). */
const ANAMORPHIC_4_3 = 'eq(3*iw,2*ih)';
/** Rapport de pixel annonce par le flux, retenu seulement s'il donne une image plausible (sinon un en-tete faux deformerait). */
const SAR_OK = 'gt(abs(sar-1),0.01)*between(iw*sar/ih,1.2,2)';

/** Filtre ffmpeg de mise a l'echelle (640 px de large, pixels carres) pour un format d'affichage. */
export function scaleFilter(aspect: Aspect): string {
  if (aspect === '16:9') return 'scale=640:360,setsar=1';
  if (aspect === '4:3') return 'scale=640:480,setsar=1';
  if (aspect === 'source') return 'scale=640:-2,setsar=1';
  const height = `if(${SAR_OK},2*trunc(320*ih/(iw*sar)),if(${ANAMORPHIC_16_9},360,if(${ANAMORPHIC_4_3},480,2*trunc(320*ih/iw))))`;
  // Borne : une taille fantaisiste ne doit ni faire echouer ffmpeg ni reserver une image demesuree.
  return `scale=w=640:h='clip(${height},2,2048)',setsar=1`;
}

/**
 * Chaine complete : 8 images/s, format d'affichage, puis toujours une image 640x360 (bandes noires si besoin). La taille de
 * sortie ne change jamais : si l'enregistreur change la taille de son flux en cours de route, ffmpeg ne deforme pas les
 * images suivantes pour les ramener a la taille de la premiere (il garde leurs proportions).
 */
export function videoFilter(aspect: Aspect): string {
  return `fps=8,${scaleFilter(aspect)},scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=640:360:-1:-1,setsar=1`;
}

const near = (a: number, b: number) => Math.abs(a / b - 1) < 0.01;

/** Rapport largeur/hauteur affiche pour une image recue `width`x`height` (rapport de pixel `sar`) : meme regle que scaleFilter. */
export function displayRatio(aspect: Aspect, width: number, height: number, sar = 1): number {
  if (aspect === '16:9') return 16 / 9;
  if (aspect === '4:3') return 4 / 3;
  if (aspect === 'source') return width / height;
  const shown = (width * sar) / height;
  if (Math.abs(sar - 1) > 0.01 && shown >= 1.2 && shown <= 2) return shown;
  if (18 * width === 16 * height || ([704, 720, 352, 360, 176].includes(width) && [576, 480, 288, 240, 144, 120].includes(height))) return 16 / 9;
  if (3 * width === 2 * height) return 4 / 3;
  return width / height;
}

/** « 16:9 », « 4:3 », « en hauteur » ou « 1,25:1 ». */
export function ratioLabel(ratio: number): string {
  if (near(ratio, 16 / 9)) return '16:9';
  if (near(ratio, 4 / 3)) return '4:3';
  if (ratio < 1) return 'en hauteur';
  return `${ratio.toFixed(2).replace('.', ',')}:1`;
}

/** Taille et rapport de pixel du flux recu, lus dans le journal ffmpeg (niveau info) : premiere ligne « Stream ... Video: ». */
export function inputVideo(stderr: string): { width: number; height: number; sar: number | null } | null {
  const m = /Stream #\d+:\d+[^\n]*?Video:[^\n]*?, (\d{2,5})x(\d{2,5})(?: \[SAR (\d+):(\d+))?/.exec(stderr);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]), sar: m[3] && Number(m[4]) ? Number(m[3]) / Number(m[4]) : null };
}

/** Lignes d'erreur d'un journal ffmpeg prefixe par niveau (sans les informations, qui citent l'adresse du flux). */
const errorLines = (stderr: string) =>
  stderr
    .split('\n')
    .filter((l) => !/\[(info|verbose|debug)\]/.test(l))
    .join('\n');

/** Dimensions d'une image JPEG (segment SOF), ou null. */
export function jpegSize(jpeg: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) return null;
    const marker = jpeg[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    }
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return null;
}

export interface SourceView {
  kind: 'simulated' | 'onvif' | 'rtsp';
  host: string | null;
  port: number | null;
  rtspPath: string | null;
  username: string | null;
  hasPassword: boolean;
  aspect: Aspect;
}

interface SourceRow {
  device_id: string;
  kind: 'onvif' | 'rtsp';
  host: string;
  port: number;
  rtsp_path: string | null;
  username: string | null;
  secret: string | null;
  aspect: Aspect;
}

export interface TestResult {
  ok: true;
  message: string;
}

/** Decoupe un flux d'images JPEG concatenees (sortie ffmpeg `image2pipe`) en images completes. */
export function createJpegSplitter(onFrame: (frame: Buffer) => void): (chunk: Buffer) => void {
  const SOI = Buffer.from([0xff, 0xd8]);
  const EOI = Buffer.from([0xff, 0xd9]);
  let buf: Buffer = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length > 0 ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const start = buf.indexOf(SOI);
      if (start < 0) {
        // Un debut de marqueur peut etre coupe entre deux paquets : on garde l'octet 0xFF final.
        buf = buf.length > 0 && buf[buf.length - 1] === 0xff ? buf.subarray(buf.length - 1) : Buffer.alloc(0);
        return;
      }
      const end = buf.indexOf(EOI, start + 2);
      if (end < 0) {
        buf = buf.length - start > MAX_FRAME_BUFFER ? Buffer.alloc(0) : buf.subarray(start);
        return;
      }
      onFrame(buf.subarray(start, end + 2));
      buf = buf.subarray(end + 2);
    }
  };
}

/** Ne jamais laisser un identifiant dans les journaux, meme s'il apparait dans un message ffmpeg. */
function redact(text: string): string {
  return text.replace(/(\w+:\/\/)[^@/\s]+@/g, '$1***@').slice(-400);
}

/** Traduit la sortie d'erreur de ffmpeg en une cause comprehensible par un operateur. */
export function explainFfmpeg(stderr: string): string {
  if (/401|unauthorized/i.test(stderr)) return 'identifiants refuses par la camera';
  if (/refused|error number -138|-111\b/i.test(stderr)) return 'connexion refusee : verifier l\'adresse et le port du flux';
  if (/404|not found/i.test(stderr)) return 'chemin du flux introuvable : verifier le chemin RTSP';
  if (/timed out|etimedout|no route|unreachable|error number -110|-60\b/i.test(stderr)) {
    return 'la camera ne repond pas : verifier l\'adresse, le reseau et le pare-feu';
  }
  if (/invalid data|unsupported|unknown codec|decoder/i.test(stderr)) return 'format video non pris en charge par ffmpeg';
  return 'flux illisible';
}

function withCredentials(uri: string, username: string | null, password: string | null): string {
  const url = new URL(uri);
  if (username) url.username = username;
  if (password) url.password = password;
  return url.toString();
}

// ---- Relecture de l'enregistreur (voies Dahua) ------------------------------------------

/** Le clip relu : 10 s avant le passage, 20 s apres. */
export const PLAYBACK_BEFORE_MS = 10_000;
export const PLAYBACK_AFTER_MS = 20_000;
/** Relectures simultanees (un ffmpeg PAR demande : on borne la charge de l'enregistreur et du poste). */
export const MAX_PLAYBACKS = 2;
/** Temps de relecture au plus : le clip dure 30 s a vitesse reelle, plus une marge de connexion. */
const PLAYBACK_MAX_MS = PLAYBACK_BEFORE_MS + PLAYBACK_AFTER_MS + 15_000;
/** Une heure demandee ne peut pas etre dans le futur de plus d'une minute, ni plus vieille que 400 jours. */
const PLAYBACK_FUTURE_MS = 60_000;
const PLAYBACK_MAX_AGE_MS = 400 * 86_400_000;
/** Bornes de l'heure d'un passage pour la fonction pure (1er janvier 2000 - 1er janvier 2100). */
const AT_MIN = 946_684_800_000;
const AT_MAX = 4_102_444_800_000;
export const NO_RECORDING_MESSAGE = 'Aucun enregistrement a cette heure ou enregistreur injoignable';

/** Voie d'enregistreur Dahua : `/cam/realmonitor?channel=N` avec eventuellement `&subtype=M` (dans l'un ou l'autre ordre). */
const DAHUA_LIVE_PATH = /^\/cam\/realmonitor\?(?:channel=([1-9]\d{0,2})(?:&subtype=\d{1,2})?|subtype=\d{1,2}&channel=([1-9]\d{0,2}))$/;

/** Numero de voie (1 a 256) d'un chemin RTSP de type enregistreur Dahua, ou null pour tout autre chemin. */
export function dahuaChannel(rtspPath: string | null | undefined): number | null {
  if (typeof rtspPath !== 'string') return null;
  const m = DAHUA_LIVE_PATH.exec(rtspPath);
  if (!m) return null;
  const channel = Number(m[1] ?? m[2]);
  return channel >= 1 && channel <= 256 ? channel : null;
}

const two = (n: number) => String(n).padStart(2, '0');

/** Heure locale du PSIM (celle de l'enregistreur sur un site) : `AAAA_MM_JJ_HH_mm_ss`. */
export function localStamp(ms: number): string {
  const d = new Date(ms);
  return [d.getFullYear(), two(d.getMonth() + 1), two(d.getDate()), two(d.getHours()), two(d.getMinutes()), two(d.getSeconds())].join('_');
}

/** Meme heure locale, lisible (journal d'audit) : `AAAA-MM-JJ HH:mm:ss`. */
export function localDateTime(ms: number): string {
  const [y, mo, d, h, mi, s] = localStamp(ms).split('_');
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

/**
 * Adresse de relecture Dahua d'une voie d'enregistreur, SANS identifiants :
 * `rtsp://hote:port/cam/playback?channel=N&subtype=0&starttime=AAAA_MM_JJ_HH_mm_ss&endtime=AAAA_MM_JJ_HH_mm_ss`.
 * Debut = passage - 10 s, fin = passage + 20 s, en heure locale du PSIM. Renvoie null pour tout chemin qui n'est pas une
 * voie d'enregistreur Dahua, un hote ou un port invalide, ou une heure qui n'est pas un entier plausible : aucun
 * morceau du chemin recu n'est recopie (seul le numero de voie, relu en entier, l'est).
 */
export function playbackUrl(rtspPath: string | null | undefined, host: string, port: number, atMs: number): string | null {
  const channel = dahuaChannel(rtspPath);
  if (channel === null) return null;
  if (typeof host !== 'string' || !HOST_PATTERN.test(host)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!Number.isSafeInteger(atMs) || atMs < AT_MIN || atMs > AT_MAX) return null;
  const start = localStamp(atMs - PLAYBACK_BEFORE_MS);
  const end = localStamp(atMs + PLAYBACK_AFTER_MS);
  return `rtsp://${host}:${port}/cam/playback?channel=${channel}&subtype=0&starttime=${start}&endtime=${end}`;
}

/**
 * Retient l'image courante toutes les `everyMs` (la premiere apres `settleMs`), jusqu'a `count` images ou la fin du flux.
 * Une image deja retenue (meme objet : rien de neuf n'est arrive) n'est pas reprise.
 */
export function sampleEvery(current: () => Buffer | null, count: number, everyMs: number, settleMs: number, over: () => boolean): Promise<TimedFrame[]> {
  return new Promise((resolveFrames) => {
    const shots: TimedFrame[] = [];
    let previous: Buffer | null = null;
    let timer: NodeJS.Timeout;
    const take = () => {
      const frame = current();
      if (frame && frame !== previous) {
        shots.push({ frame, at: Date.now() });
        previous = frame;
      }
      if (shots.length >= count || over()) return resolveFrames(shots);
      timer = setTimeout(take, everyMs);
    };
    timer = setTimeout(take, settleMs);
    void timer;
  });
}

/** `info` : journal au niveau info, prefixe par niveau (pour lire la taille du flux recu lors d'un test). */
function defaultArgs(url: string, once: boolean, aspect: Aspect = 'auto', info = false): string[] {
  return [
    '-hide_banner', '-loglevel', info ? 'level+info' : 'error', '-nostdin',
    // Par defaut ffmpeg analyse le flux pendant 5 s avant d'afficher la premiere image ; une camera
    // decrit son flux des la connexion (SDP), 2 s suffisent et l'image apparait bien plus vite.
    '-fflags', '+nobuffer', '-probesize', '2000000', '-analyzeduration', '2000000',
    '-rtsp_transport', 'tcp', '-timeout', '10000000',
    '-i', url,
    '-an',
    '-vf', videoFilter(aspect),
    '-q:v', '7',
    ...(once ? ['-frames:v', '1'] : []),
    '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1',
  ];
}

interface Viewer {
  res: ServerResponse;
  started: boolean;
}

interface Feed {
  id: string;
  proc: ChildProcess | null;
  starting: boolean;
  viewers: Set<Viewer>;
  last: Buffer | null;
  idleTimer: NodeJS.Timeout | null;
  firstFrameTimer: NodeJS.Timeout | null;
  stderr: string;
}

export interface VideoOptions {
  db: DatabaseSync;
  engine: Engine;
  key: Buffer;
  publish: (event: PsimEvent) => void;
  ffmpegPath?: string;
  /** Delai avant d'arreter ffmpeg quand plus personne ne regarde (defaut 5 s). */
  idleStopMs?: number;
  /** Surcharge des arguments ffmpeg (tests uniquement). */
  argsFor?: (url: string, once: boolean, aspect: Aspect, info: boolean) => string[];
  /** Horloge injectee (tests) : bornes de l'heure d'une relecture. */
  now?: () => number;
  /** Duree maximale d'une relecture (tests uniquement ; defaut : clip de 30 s plus une marge). */
  playbackMaxMs?: number;
}

/** Une relecture en cours : son ffmpeg, sa reponse, ses minuteries. */
interface Playback {
  proc: ChildProcess | null;
  viewer: Viewer;
  frames: number;
  stderr: string;
  maxTimer: NodeJS.Timeout | null;
  firstFrameTimer: NodeJS.Timeout | null;
  done: boolean;
}

export function createVideoService(opts: VideoOptions) {
  const { db, engine, key, publish } = opts;
  const ffmpeg = opts.ffmpegPath ?? 'ffmpeg';
  const argsFor = opts.argsFor ?? defaultArgs;
  const idleStop = opts.idleStopMs ?? IDLE_STOP_MS;
  const now = opts.now ?? Date.now;
  const playbackMax = opts.playbackMaxMs ?? PLAYBACK_MAX_MS;
  const feeds = new Map<string, Feed>();
  /** Relectures en cours (une par demande, jamais partagees). */
  const playbacks = new Set<Playback>();

  // ---- Configuration des sources --------------------------------------------------------

  function getRow(cameraId: string): SourceRow | null {
    return (db.prepare('SELECT * FROM camera_source WHERE device_id = ?').get(cameraId) as SourceRow | undefined) ?? null;
  }

  function view(cameraId: string): SourceView {
    const row = getRow(cameraId);
    if (!row) return { kind: 'simulated', host: null, port: null, rtspPath: null, username: null, hasPassword: false, aspect: 'auto' };
    return {
      kind: row.kind,
      host: row.host,
      port: row.port,
      rtspPath: row.rtsp_path,
      username: row.username,
      hasPassword: Boolean(row.secret),
      aspect: ASPECTS.includes(row.aspect) ? row.aspect : 'auto',
    };
  }

  function requireCamera(cameraId: string): void {
    if (engine.getDevice(cameraId)?.kind !== 'camera') throw new PsimError(404, 'Camera introuvable');
  }

  function text(value: unknown, field: string, max: number, required: boolean): string | null {
    if (value === undefined || value === null || value === '') {
      if (required) throw new PsimError(400, `${field} requis`);
      return null;
    }
    if (typeof value !== 'string' || value.length > max || CONTROL_CHARS.test(value)) {
      throw new PsimError(400, `${field} invalide (max ${max} caracteres, sans caractere de controle)`);
    }
    return value;
  }

  function setSource(actor: string, cameraId: string, input: Record<string, unknown>): SourceView {
    requireCamera(cameraId);
    const kind = input.kind;

    if (kind === 'simulated') {
      db.prepare('DELETE FROM camera_source WHERE device_id = ?').run(cameraId);
      db.prepare("UPDATE device SET stream_kind = 'simulated' WHERE id = ?").run(cameraId);
      engine.audit(actor, 'camera_source_updated', { deviceId: cameraId, details: 'simulated' });
      closeFeed(cameraId);
      publish({ type: 'config' });
      return view(cameraId);
    }
    if (kind !== 'onvif' && kind !== 'rtsp') throw new PsimError(400, 'kind doit etre simulated, onvif ou rtsp');

    const host = text(input.host, 'Adresse', 253, true) as string;
    if (!HOST_PATTERN.test(host)) throw new PsimError(400, 'Adresse invalide (adresse IPv4 ou nom de machine, sans http:// ni chemin)');
    const rawPort = input.port === undefined || input.port === '' ? (kind === 'onvif' ? 80 : 554) : Number(input.port);
    if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) throw new PsimError(400, 'Port invalide (1 a 65535)');
    let rtspPath: string | null = null;
    if (kind === 'rtsp') {
      rtspPath = text(input.rtspPath, 'Chemin RTSP', 200, false) ?? '/';
      if (!PATH_PATTERN.test(rtspPath)) throw new PsimError(400, 'Chemin RTSP invalide (doit commencer par /)');
    }
    const username = text(input.username, 'Utilisateur', 64, false);
    const existing = getRow(cameraId);
    const newPassword = text(input.password, 'Mot de passe', 128, false);
    // Mot de passe vide = on conserve celui deja enregistre (il n'est jamais renvoye au navigateur).
    const secret = newPassword !== null ? seal(key, newPassword) : (existing?.secret ?? null);
    // Format absent = on conserve celui deja choisi (automatique pour une nouvelle source).
    const aspect = input.aspect === undefined ? (existing?.aspect ?? 'auto') : input.aspect;
    if (typeof aspect !== 'string' || !ASPECTS.includes(aspect as Aspect)) throw new PsimError(400, `Format d'image invalide (${ASPECTS.join(', ')})`);

    db.prepare(
      `INSERT INTO camera_source (device_id, kind, host, port, rtsp_path, username, secret, aspect)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET kind = excluded.kind, host = excluded.host, port = excluded.port,
         rtsp_path = excluded.rtsp_path, username = excluded.username, secret = excluded.secret, aspect = excluded.aspect`,
    ).run(cameraId, kind, host, rawPort, rtspPath, username, secret, aspect);
    db.prepare('UPDATE device SET stream_kind = ? WHERE id = ?').run(kind, cameraId);
    engine.audit(actor, 'camera_source_updated', { deviceId: cameraId, details: `${kind} ${host}:${rawPort}${aspect === 'auto' ? '' : ` ; image ${aspect}`}` });
    restartFeed(cameraId);
    publish({ type: 'config' });
    return view(cameraId);
  }

  // ---- Resolution de l'adresse du flux --------------------------------------------------

  function passwordOf(row: SourceRow): string | null {
    if (!row.secret) return null;
    try {
      return unseal(key, row.secret);
    } catch {
      throw new PsimError(500, 'Mot de passe de la camera illisible (cle de chiffrement changee) : le saisir a nouveau');
    }
  }

  async function resolve(cameraId: string): Promise<{ url: string; note: string; aspect: Aspect }> {
    const row = getRow(cameraId);
    if (!row) throw new PsimError(404, 'Cette camera utilise la source simulee');
    const aspect: Aspect = ASPECTS.includes(row.aspect) ? row.aspect : 'auto';
    const password = passwordOf(row);
    if (row.kind === 'rtsp') {
      const url = withCredentials(`rtsp://${row.host}:${row.port}${row.rtsp_path ?? '/'}`, row.username, password);
      return { url, note: `RTSP ${row.host}:${row.port}`, aspect };
    }
    const probe = await probeOnvif({ host: row.host, port: row.port, username: row.username ?? '', password: password ?? '' });
    const device = [probe.manufacturer, probe.model].filter(Boolean).join(' ') || 'camera ONVIF';
    const p = probe.profile;
    const size = p.width && p.height ? ` ${p.width}x${p.height}` : '';
    return {
      url: withCredentials(probe.uri, row.username, password),
      note: `${device}, profil ${p.name}${size}${p.encoding ? ` ${p.encoding}` : ''}`,
      aspect,
    };
  }

  function grabFrame(url: string, aspect: Aspect, info = false): Promise<{ frame: Buffer; stderr: string }> {
    return new Promise((resolveFrame, reject) => {
      const proc = spawn(ffmpeg, argsFor(url, true, aspect, info), { stdio: ['ignore', 'pipe', 'pipe'] });
      let frame: Buffer | null = null;
      let stderr = '';
      const split = createJpegSplitter((f) => {
        frame ??= Buffer.from(f);
      });
      const timer = setTimeout(() => proc.kill(), 15000);
      proc.stdout.on('data', split);
      // Le journal au niveau info est plus long : on garde son debut (la description du flux) et sa fin (les erreurs).
      proc.stderr.on('data', (d: Buffer) => (stderr = stderr.length < 8000 ? stderr + d.toString() : (stderr + d.toString()).slice(-8000)));
      proc.on('error', () => {
        clearTimeout(timer);
        reject(new PsimError(500, 'ffmpeg introuvable : l\'installer ou renseigner PSIM_FFMPEG'));
      });
      proc.on('close', () => {
        clearTimeout(timer);
        if (frame) return resolveFrame({ frame, stderr });
        const errors = errorLines(stderr);
        if (errors.trim()) console.warn(`[video] test de connexion : ${redact(errors)}`);
        reject(new PsimError(502, `Aucune image recue : ${explainFfmpeg(errors)}`));
      });
    });
  }

  async function test(cameraId: string): Promise<TestResult> {
    requireCamera(cameraId);
    const { url, note, aspect } = await resolve(cameraId);
    const { frame, stderr } = await grabFrame(url, aspect, true);
    // La taille RECUE (et son rapport de pixel), puis le format AFFICHE : l'installateur voit si une correction a ete faite.
    const input = inputVideo(stderr);
    if (!input) return { ok: true, message: `Image recue (${Math.round(frame.length / 1024)} Ko) - ${note}` };
    const ratio = displayRatio(aspect, input.width, input.height, input.sar ?? 1);
    const corrected = aspect === 'auto' && !near(ratio, (input.width * (input.sar ?? 1)) / input.height);
    const sar = input.sar && Math.abs(input.sar - 1) > 0.01 ? ` (pixels ${input.sar.toFixed(2).replace('.', ',')})` : '';
    return {
      ok: true,
      message:
        `Image recue en ${input.width}x${input.height}${sar}, affichee en ${ratioLabel(ratio)}` +
        `${corrected ? " (correction automatique : si les personnes paraissent trop larges, choisir 4:3)" : ''} - ${note}`,
    };
  }

  // ---- Diffusion : un seul ffmpeg par camera, partage entre tous les operateurs ----------

  function sendFrame(viewer: Viewer, frame: Buffer): void {
    const { res } = viewer;
    if (res.writableEnded || res.destroyed) return;
    if (!viewer.started) {
      res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      viewer.started = true;
    }
    if (res.writableNeedDrain) return; // client lent : on saute l'image plutot que d'accumuler du retard
    res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    res.write(frame);
    res.write('\r\n');
  }

  function endViewer(viewer: Viewer, err: PsimError | null): void {
    const { res } = viewer;
    if (res.writableEnded || res.destroyed) return;
    if (!viewer.started && err) {
      res.writeHead(err.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    } else {
      res.end();
    }
  }

  function dispose(feed: Feed, err: PsimError | null): void {
    if (feeds.get(feed.id) === feed) feeds.delete(feed.id);
    if (feed.idleTimer) clearTimeout(feed.idleTimer);
    if (feed.firstFrameTimer) clearTimeout(feed.firstFrameTimer);
    feed.proc?.kill();
    feed.proc = null;
    const viewers = [...feed.viewers];
    feed.viewers.clear();
    for (const viewer of viewers) endViewer(viewer, err);
  }

  function closeFeed(cameraId: string): void {
    const feed = feeds.get(cameraId);
    if (feed) dispose(feed, null);
  }

  /**
   * Source modifiee (adresse, format...) d'une camera regardee : nouveau ffmpeg sans couper les operateurs (pas de
   * « flux interrompu » sur le mur) ; la nouvelle image arrive des qu'elle est prete. Plus personne ne regarde : on ferme.
   */
  function restartFeed(cameraId: string): void {
    const feed = feeds.get(cameraId);
    if (!feed || feed.starting || feed.viewers.size === 0) return closeFeed(cameraId);
    const old = feed.proc;
    feed.proc = null; // le gestionnaire « close » de l'ancien processus l'ignore alors (arret voulu)
    old?.kill();
    if (feed.firstFrameTimer) clearTimeout(feed.firstFrameTimer);
    feed.firstFrameTimer = null;
    feed.last = null; // pas d'image d'incident a l'ancien format
    feed.stderr = '';
    void start(feed);
  }

  async function start(feed: Feed): Promise<void> {
    feed.starting = true;
    let url: string;
    let aspect: Aspect;
    try {
      ({ url, aspect } = await resolve(feed.id));
    } catch (err) {
      return dispose(feed, err instanceof PsimError ? err : new PsimError(502, 'Camera injoignable'));
    }
    feed.starting = false;
    if (feeds.get(feed.id) !== feed || feed.viewers.size === 0) return dispose(feed, null);

    const proc = spawn(ffmpeg, argsFor(url, false, aspect, false), { stdio: ['ignore', 'pipe', 'pipe'] });
    feed.proc = proc;
    feed.firstFrameTimer = setTimeout(
      () => dispose(feed, new PsimError(504, 'Aucune image recue de la camera')),
      FIRST_FRAME_TIMEOUT_MS,
    );
    const split = createJpegSplitter((frame) => {
      if (feed.proc !== proc) return; // ancien ffmpeg (source modifiee) : ses dernieres images sont ignorees
      if (feed.firstFrameTimer) {
        clearTimeout(feed.firstFrameTimer);
        feed.firstFrameTimer = null;
      }
      const copy = Buffer.from(frame);
      feed.last = copy;
      for (const viewer of feed.viewers) sendFrame(viewer, copy);
    });
    proc.stdout.on('data', split);
    proc.stderr.on('data', (d: Buffer) => (feed.stderr = (feed.stderr + d.toString()).slice(-2000)));
    proc.on('error', () => dispose(feed, new PsimError(500, 'ffmpeg introuvable : l\'installer ou renseigner PSIM_FFMPEG')));
    proc.on('close', (code) => {
      if (feed.proc !== proc) return; // arret voulu
      if (code) console.warn(`[video] ${feed.id} : ffmpeg a quitte (code ${code}) ${redact(feed.stderr)}`);
      dispose(
        feed,
        new PsimError(502, feed.last ? 'Le flux de la camera s\'est interrompu' : `Camera injoignable : ${explainFfmpeg(feed.stderr)}`),
      );
    });
  }

  function attachViewer(cameraId: string, res: ServerResponse): void {
    requireCamera(cameraId);
    if (!getRow(cameraId)) throw new PsimError(404, 'Cette camera utilise la source simulee');
    let feed = feeds.get(cameraId);
    if (!feed) {
      if (feeds.size >= MAX_FEEDS) throw new PsimError(503, 'Trop de flux video simultanes');
      feed = { id: cameraId, proc: null, starting: false, viewers: new Set(), last: null, idleTimer: null, firstFrameTimer: null, stderr: '' };
      feeds.set(cameraId, feed);
    }
    if (feed.idleTimer) {
      clearTimeout(feed.idleTimer);
      feed.idleTimer = null;
    }
    const viewer: Viewer = { res, started: false };
    feed.viewers.add(viewer);
    const owner = feed;
    res.on('close', () => {
      owner.viewers.delete(viewer);
      if (owner.viewers.size === 0 && feeds.get(owner.id) === owner && !owner.idleTimer) {
        owner.idleTimer = setTimeout(() => dispose(owner, null), idleStop);
      }
    });
    if (feed.last) sendFrame(viewer, feed.last);
    if (!feed.proc && !feed.starting) void start(feed);
  }

  // ---- Relecture de l'enregistreur : un ffmpeg PAR demande, arrete a la fin du clip ---------

  /** Voie d'enregistreur Dahua relisible : source RTSP dont le chemin est `/cam/realmonitor?channel=N`. */
  function isReplayable(row: SourceRow | null): row is SourceRow {
    return row !== null && row.kind === 'rtsp' && dahuaChannel(row.rtsp_path) !== null && HOST_PATTERN.test(row.host);
  }

  function replayable(cameraId: string): boolean {
    return engine.getDevice(cameraId)?.kind === 'camera' && isReplayable(getRow(cameraId));
  }

  function listReplayable(): string[] {
    const rows = db.prepare("SELECT * FROM camera_source WHERE kind = 'rtsp' ORDER BY device_id").all() as unknown as SourceRow[];
    return rows.filter((r) => engine.getDevice(r.device_id)?.kind === 'camera' && isReplayable(r)).map((r) => r.device_id);
  }

  /** Fin d'une relecture (une seule fois) : ffmpeg tue, minuteries coupees, place rendue, reponse fermee. */
  function endPlayback(pb: Playback, err: PsimError | null): void {
    if (pb.done) return;
    pb.done = true;
    playbacks.delete(pb);
    if (pb.maxTimer) clearTimeout(pb.maxTimer);
    if (pb.firstFrameTimer) clearTimeout(pb.firstFrameTimer);
    pb.maxTimer = null;
    pb.firstFrameTimer = null;
    pb.proc?.kill();
    pb.proc = null;
    endViewer(pb.viewer, err);
  }

  /**
   * Relit l'enregistrement de la camera autour de `atMs` (10 s avant, 20 s apres) et le diffuse comme le direct
   * (multipart MJPEG). Seule l'heure vient du navigateur (entier, ms) ; l'adresse est toujours deduite de la source
   * enregistree. Un ffmpeg par demande, au plus MAX_PLAYBACKS a la fois ; il s'arrete a la fin du clip, a la
   * fermeture de la reponse ou apres PLAYBACK_MAX_MS.
   */
  function attachPlayback(cameraId: string, atMs: number, res: ServerResponse): void {
    requireCamera(cameraId);
    const row = getRow(cameraId);
    if (!row) throw new PsimError(404, 'Cette camera utilise la source simulee');
    if (!isReplayable(row)) throw new PsimError(409, 'Cette camera ne permet pas la relecture depuis le PSIM');
    if (!Number.isSafeInteger(atMs)) throw new PsimError(400, 'Heure invalide');
    const t = now();
    if (atMs > t + PLAYBACK_FUTURE_MS) throw new PsimError(400, 'Heure invalide : dans le futur');
    if (atMs < t - PLAYBACK_MAX_AGE_MS) throw new PsimError(400, 'Heure trop ancienne : les enregistrements ne remontent pas a plus de 400 jours');
    const bare = playbackUrl(row.rtsp_path, row.host, row.port, atMs);
    if (!bare) throw new PsimError(400, 'Heure invalide');
    if (playbacks.size >= MAX_PLAYBACKS) throw new PsimError(503, 'Trop de relectures en cours');
    const url = withCredentials(bare, row.username, passwordOf(row));
    const aspect: Aspect = ASPECTS.includes(row.aspect) ? row.aspect : 'auto';

    const viewer: Viewer = { res, started: false };
    const pb: Playback = { proc: null, viewer, frames: 0, stderr: '', maxTimer: null, firstFrameTimer: null, done: false };
    playbacks.add(pb);
    res.on('close', () => endPlayback(pb, null));

    const proc = spawn(ffmpeg, argsFor(url, false, aspect, false), { stdio: ['ignore', 'pipe', 'pipe'] });
    pb.proc = proc;
    pb.maxTimer = setTimeout(() => endPlayback(pb, pb.frames > 0 ? null : new PsimError(504, NO_RECORDING_MESSAGE)), playbackMax);
    pb.firstFrameTimer = setTimeout(() => endPlayback(pb, new PsimError(504, NO_RECORDING_MESSAGE)), FIRST_FRAME_TIMEOUT_MS);
    proc.stdout.on(
      'data',
      createJpegSplitter((frame) => {
        if (pb.done) return;
        if (pb.frames++ === 0 && pb.firstFrameTimer) {
          clearTimeout(pb.firstFrameTimer);
          pb.firstFrameTimer = null;
        }
        sendFrame(viewer, Buffer.from(frame));
      }),
    );
    proc.stderr.on('data', (d: Buffer) => (pb.stderr = (pb.stderr + d.toString()).slice(-2000)));
    proc.on('error', () => endPlayback(pb, new PsimError(500, "ffmpeg introuvable : l'installer ou renseigner PSIM_FFMPEG")));
    proc.on('close', (code) => {
      if (pb.done) return;
      if (pb.frames === 0 || code) {
        const errors = errorLines(pb.stderr);
        if (errors.trim()) console.warn(`[video] relecture ${cameraId} : ${redact(errors)}`);
      }
      // Fin normale du clip (des images ont ete servies) : la reponse se ferme sans erreur.
      if (pb.frames > 0) return endPlayback(pb, null);
      const refused = /401|unauthorized/i.test(pb.stderr) ? " (identifiants refuses par l'enregistreur)" : '';
      endPlayback(pb, new PsimError(502, `${NO_RECORDING_MESSAGE}${refused}`));
    });
  }

  function shutdown(): void {
    for (const feed of [...feeds.values()]) dispose(feed, null);
    for (const pb of [...playbacks]) endPlayback(pb, null);
  }

  /**
   * Une image JPEG de la camera. Si un flux est deja actif, on reprend sa derniere image (instantane) ;
   * sinon on se connecte a la camera pour en lire une seule.
   */
  async function snapshot(cameraId: string): Promise<Buffer> {
    requireCamera(cameraId);
    const live = feeds.get(cameraId)?.last;
    if (live) return Buffer.from(live);
    const { url, aspect } = await resolve(cameraId);
    return (await grabFrame(url, aspect)).frame;
  }

  /**
   * Plusieurs images espacees dans le temps, sur UNE seule connexion : une personne qui traverse le champ en 3 ou 4 s
   * echappe facilement a une image unique (la detection de l'enregistreur a deja 1 a 3 s de retard).
   * Le debut d'un flux peut etre ancien (certains enregistreurs envoient d'abord les secondes gardees en memoire, d'un
   * coup) : on attend `settleMs` apres la premiere image, puis on retient l'image la plus recente toutes les `everyMs`,
   * a l'heure reelle (pas a l'horodatage du flux). Une image identique a la precedente (flux fige) n'est pas reprise.
   * Flux deja regarde par un operateur : ses images sont deja actuelles, on les echantillonne sans nouvelle connexion.
   */
  async function snapshotSeries(cameraId: string, count: number, everyMs = SERIES_EVERY_MS, settleMs = SERIES_SETTLE_MS): Promise<TimedFrame[]> {
    requireCamera(cameraId);
    const live = feeds.get(cameraId);
    if (live?.last) return sampleEvery(() => live.last, count, everyMs, 0, () => feeds.get(cameraId) !== live);
    const { url, aspect } = await resolve(cameraId);
    let last: Buffer | null = null;
    let stderr = '';
    let ended = false;
    const proc = spawn(ffmpeg, argsFor(url, false, aspect, false), { stdio: ['ignore', 'pipe', 'pipe'] });
    let timer: NodeJS.Timeout | undefined;
    // Premiere image recue (le flux est la), ou l'echec : delai depasse, ffmpeg absent, flux termine sans image.
    const started = new Promise<void>((resolveStart, rejectStart) => {
      timer = setTimeout(() => rejectStart(new PsimError(504, 'Aucune image recue de la camera')), FIRST_FRAME_TIMEOUT_MS);
      proc.on('error', () => rejectStart(new PsimError(500, "ffmpeg introuvable : l'installer ou renseigner PSIM_FFMPEG")));
      proc.on('close', () => {
        ended = true;
        rejectStart(new PsimError(502, `Aucune image recue : ${explainFfmpeg(errorLines(stderr))}`));
      });
      proc.stdout.on('data', createJpegSplitter((f) => {
        last = Buffer.from(f);
        resolveStart();
      }));
    });
    proc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    try {
      await started;
      return await sampleEvery(() => last, count, everyMs, settleMs, () => ended);
    } finally {
      clearTimeout(timer);
      proc.kill();
    }
  }

  return { view, setSource, test, snapshot, snapshotSeries, attachViewer, replayable, listReplayable, attachPlayback, closeFeed, shutdown, activeFeeds: () => feeds.size, activePlaybacks: () => playbacks.size };
}

export type VideoService = ReturnType<typeof createVideoService>;
