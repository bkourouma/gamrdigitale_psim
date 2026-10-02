import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { Engine } from './engine.ts';
import { PsimError } from './engine.ts';
import { probeOnvif } from './onvif.ts';
import { seal, unseal } from './secrets.ts';
import type { PsimEvent } from './types.ts';

const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{0,199}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const BOUNDARY = 'psimframe';
const MAX_FEEDS = 6;
const IDLE_STOP_MS = 5000;
const FIRST_FRAME_TIMEOUT_MS = 15000;
const MAX_FRAME_BUFFER = 8 * 1024 * 1024;

export interface SourceView {
  kind: 'simulated' | 'onvif' | 'rtsp';
  host: string | null;
  port: number | null;
  rtspPath: string | null;
  username: string | null;
  hasPassword: boolean;
}

interface SourceRow {
  device_id: string;
  kind: 'onvif' | 'rtsp';
  host: string;
  port: number;
  rtsp_path: string | null;
  username: string | null;
  secret: string | null;
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

function defaultArgs(url: string, once: boolean): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    // Par defaut ffmpeg analyse le flux pendant 5 s avant d'afficher la premiere image ; une camera
    // decrit son flux des la connexion (SDP), 2 s suffisent et l'image apparait bien plus vite.
    '-fflags', '+nobuffer', '-probesize', '2000000', '-analyzeduration', '2000000',
    '-rtsp_transport', 'tcp', '-timeout', '10000000',
    '-i', url,
    '-an',
    '-vf', 'fps=8,scale=640:-2',
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
  argsFor?: (url: string, once: boolean) => string[];
}

export function createVideoService(opts: VideoOptions) {
  const { db, engine, key, publish } = opts;
  const ffmpeg = opts.ffmpegPath ?? 'ffmpeg';
  const argsFor = opts.argsFor ?? defaultArgs;
  const idleStop = opts.idleStopMs ?? IDLE_STOP_MS;
  const feeds = new Map<string, Feed>();

  // ---- Configuration des sources --------------------------------------------------------

  function getRow(cameraId: string): SourceRow | null {
    return (db.prepare('SELECT * FROM camera_source WHERE device_id = ?').get(cameraId) as SourceRow | undefined) ?? null;
  }

  function view(cameraId: string): SourceView {
    const row = getRow(cameraId);
    if (!row) return { kind: 'simulated', host: null, port: null, rtspPath: null, username: null, hasPassword: false };
    return {
      kind: row.kind,
      host: row.host,
      port: row.port,
      rtspPath: row.rtsp_path,
      username: row.username,
      hasPassword: Boolean(row.secret),
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

    db.prepare(
      `INSERT INTO camera_source (device_id, kind, host, port, rtsp_path, username, secret)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET kind = excluded.kind, host = excluded.host, port = excluded.port,
         rtsp_path = excluded.rtsp_path, username = excluded.username, secret = excluded.secret`,
    ).run(cameraId, kind, host, rawPort, rtspPath, username, secret);
    db.prepare('UPDATE device SET stream_kind = ? WHERE id = ?').run(kind, cameraId);
    engine.audit(actor, 'camera_source_updated', { deviceId: cameraId, details: `${kind} ${host}:${rawPort}` });
    closeFeed(cameraId);
    publish({ type: 'config' });
    return view(cameraId);
  }

  // ---- Resolution de l'adresse du flux --------------------------------------------------

  async function resolve(cameraId: string): Promise<{ url: string; note: string }> {
    const row = getRow(cameraId);
    if (!row) throw new PsimError(404, 'Cette camera utilise la source simulee');
    let password: string | null = null;
    if (row.secret) {
      try {
        password = unseal(key, row.secret);
      } catch {
        throw new PsimError(500, 'Mot de passe de la camera illisible (cle de chiffrement changee) : le saisir a nouveau');
      }
    }
    if (row.kind === 'rtsp') {
      const url = withCredentials(`rtsp://${row.host}:${row.port}${row.rtsp_path ?? '/'}`, row.username, password);
      return { url, note: `RTSP ${row.host}:${row.port}` };
    }
    const probe = await probeOnvif({ host: row.host, port: row.port, username: row.username ?? '', password: password ?? '' });
    const device = [probe.manufacturer, probe.model].filter(Boolean).join(' ') || 'camera ONVIF';
    const p = probe.profile;
    const size = p.width && p.height ? ` ${p.width}x${p.height}` : '';
    return {
      url: withCredentials(probe.uri, row.username, password),
      note: `${device}, profil ${p.name}${size}${p.encoding ? ` ${p.encoding}` : ''}`,
    };
  }

  function grabFrame(url: string): Promise<Buffer> {
    return new Promise((resolveFrame, reject) => {
      const proc = spawn(ffmpeg, argsFor(url, true), { stdio: ['ignore', 'pipe', 'pipe'] });
      let frame: Buffer | null = null;
      let stderr = '';
      const split = createJpegSplitter((f) => {
        frame ??= Buffer.from(f);
      });
      const timer = setTimeout(() => proc.kill(), 15000);
      proc.stdout.on('data', split);
      proc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
      proc.on('error', () => {
        clearTimeout(timer);
        reject(new PsimError(500, 'ffmpeg introuvable : l\'installer ou renseigner PSIM_FFMPEG'));
      });
      proc.on('close', () => {
        clearTimeout(timer);
        if (frame) return resolveFrame(frame);
        if (stderr) console.warn(`[video] test de connexion : ${redact(stderr)}`);
        reject(new PsimError(502, `Aucune image recue : ${explainFfmpeg(stderr)}`));
      });
    });
  }

  async function test(cameraId: string): Promise<TestResult> {
    requireCamera(cameraId);
    const { url, note } = await resolve(cameraId);
    const frame = await grabFrame(url);
    return { ok: true, message: `Image recue (${Math.round(frame.length / 1024)} Ko) - ${note}` };
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

  async function start(feed: Feed): Promise<void> {
    feed.starting = true;
    let url: string;
    try {
      url = (await resolve(feed.id)).url;
    } catch (err) {
      return dispose(feed, err instanceof PsimError ? err : new PsimError(502, 'Camera injoignable'));
    }
    feed.starting = false;
    if (feeds.get(feed.id) !== feed || feed.viewers.size === 0) return dispose(feed, null);

    const proc = spawn(ffmpeg, argsFor(url, false), { stdio: ['ignore', 'pipe', 'pipe'] });
    feed.proc = proc;
    feed.firstFrameTimer = setTimeout(
      () => dispose(feed, new PsimError(504, 'Aucune image recue de la camera')),
      FIRST_FRAME_TIMEOUT_MS,
    );
    const split = createJpegSplitter((frame) => {
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

  function shutdown(): void {
    for (const feed of [...feeds.values()]) dispose(feed, null);
  }

  return { view, setSource, test, attachViewer, closeFeed, shutdown, activeFeeds: () => feeds.size };
}

export type VideoService = ReturnType<typeof createVideoService>;
