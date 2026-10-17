/**
 * Relecture de l'enregistreur depuis le PSIM (exigence F6 du controle d'acces) : adresse de relecture Dahua deduite de la
 * source de la camera, service `attachPlayback` (un ffmpeg PAR demande, plafond, arret), routes `/api/cameras/replayable`
 * et `/api/cameras/:id/playback` contre le vrai serveur.
 *
 * AUCUN materiel : ffmpeg est remplace par un faux flux local. Deux faux flux :
 *  - un petit programme Node (ecrit ici) qui emet des images JPEG : il sert a tout verifier sans ffmpeg (plafond, arret,
 *    erreurs, absence de mot de passe) ; le vrai ffmpeg n'est pas necessaire ;
 *  - la mire `testsrc` du vrai ffmpeg (mecanisme `argsFor` de test/video.test.ts), ignoree si ffmpeg est absent.
 * Dans les deux cas, l'adresse RTSP construite est celle qui est passee a `argsFor`.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import { seedDemo } from '../server/seed.ts';
import {
  MAX_PLAYBACKS,
  NO_RECORDING_MESSAGE,
  PLAYBACK_AFTER_MS,
  PLAYBACK_BEFORE_MS,
  createJpegSplitter,
  createVideoService,
  dahuaChannel,
  localDateTime,
  localStamp,
  playbackUrl,
} from '../server/video.ts';
import type { PsimEvent } from '../server/types.ts';

const key = Buffer.alloc(32, 7);
const ROOT = resolve(import.meta.dirname, '..');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const NO_FFMPEG = HAS_FFMPEG ? false : 'ffmpeg absent de cet environnement';

/** Heure locale -> ms (le test ne depend donc pas du fuseau de la machine). */
const local = (y: number, mo: number, d: number, h: number, mi: number, s: number) => new Date(y, mo - 1, d, h, mi, s).getTime();

// ================================================================================================ adresse de relecture

describe('voie d\'enregistreur Dahua : numero de voie', () => {
  it('accepte /cam/realmonitor?channel=N, avec ou sans subtype, dans les deux ordres', () => {
    assert.equal(dahuaChannel('/cam/realmonitor?channel=1'), 1);
    assert.equal(dahuaChannel('/cam/realmonitor?channel=1&subtype=0'), 1);
    assert.equal(dahuaChannel('/cam/realmonitor?channel=12&subtype=1'), 12);
    assert.equal(dahuaChannel('/cam/realmonitor?subtype=1&channel=7'), 7);
    assert.equal(dahuaChannel('/cam/realmonitor?channel=256&subtype=0'), 256);
  });

  it('refuse les voies hors bornes ou mal ecrites', () => {
    for (const bad of ['0', '257', '999', '1000', '-1', '01', '1.5', '1e2', '', 'abc', '1 ', ' 1', '%31', '+1', '0x10']) {
      assert.equal(dahuaChannel(`/cam/realmonitor?channel=${bad}`), null, `channel=${JSON.stringify(bad)}`);
    }
    assert.equal(dahuaChannel('/cam/realmonitor?channel=1&subtype='), null);
    assert.equal(dahuaChannel('/cam/realmonitor?channel=1&subtype=abc'), null);
    assert.equal(dahuaChannel('/cam/realmonitor?channel=1&subtype=123'), null);
  });

  it('refuse tout autre chemin, tout parametre en plus, tout caractere parasite', () => {
    const foreign = [
      '/', '/stream1', '/live', '/h264/ch1/main/av_stream', '/Streaming/Channels/101', '/cam/realmonitor', '/cam/realmonitor?',
      '/cam/realmonitor?channel=', '/cam/realmonitor?subtype=0', '/cam/playback?channel=1', '//cam/realmonitor?channel=1',
      '/cam/realmonitor/?channel=1', '/CAM/realmonitor?channel=1', '/cam/realmonitor?channel=1&unicast=true',
      '/cam/realmonitor?channel=1&subtype=0&x=1', '/cam/realmonitor?channel=1&subtype=0&', '/cam/realmonitor?channel=1#x',
      '/cam/realmonitor?channel=1\n', '/cam/realmonitor?channel=1\r\nX: y', '/cam/realmonitor?channel=1&channel=2',
      '/cam/realmonitor?channel=1&starttime=2020_01_01_00_00_00', 'x/cam/realmonitor?channel=1', 'rtsp://evil/cam/realmonitor?channel=1',
    ];
    for (const path of foreign) assert.equal(dahuaChannel(path), null, JSON.stringify(path));
    for (const notAPath of [null, undefined, 3, {}, [], true]) assert.equal(dahuaChannel(notAPath as never), null);
  });
});

describe('adresse de relecture Dahua', () => {
  const at = local(2026, 10, 16, 14, 32, 5);

  it('construit starttime = passage - 10 s et endtime = passage + 20 s, en heure locale', () => {
    assert.equal(
      playbackUrl('/cam/realmonitor?channel=3&subtype=1', '192.168.1.13', 554, at),
      'rtsp://192.168.1.13:554/cam/playback?channel=3&subtype=0&starttime=2026_10_16_14_31_55&endtime=2026_10_16_14_32_25',
    );
    assert.equal(PLAYBACK_BEFORE_MS, 10_000);
    assert.equal(PLAYBACK_AFTER_MS, 20_000);
  });

  it('la relecture est toujours en flux principal (subtype=0), quel que soit le sous-flux du direct', () => {
    for (const path of ['/cam/realmonitor?channel=2', '/cam/realmonitor?channel=2&subtype=0', '/cam/realmonitor?channel=2&subtype=1']) {
      assert.match(playbackUrl(path, 'nvr.local', 554, at)!, /\?channel=2&subtype=0&starttime=/);
    }
  });

  it('passe minuit, la fin d\'annee et un changement de mois sans erreur', () => {
    const midnight = playbackUrl('/cam/realmonitor?channel=1', 'h', 554, local(2026, 10, 17, 0, 0, 5))!;
    assert.match(midnight, /starttime=2026_10_16_23_59_55&endtime=2026_10_17_00_00_25$/);
    const newYear = playbackUrl('/cam/realmonitor?channel=1', 'h', 554, local(2027, 1, 1, 0, 0, 3))!;
    assert.match(newYear, /starttime=2026_12_31_23_59_53&endtime=2027_01_01_00_00_23$/);
    const leap = playbackUrl('/cam/realmonitor?channel=1', 'h', 554, local(2028, 3, 1, 0, 0, 0))!;
    assert.match(leap, /starttime=2028_02_29_23_59_50&endtime=2028_03_01_00_00_20$/);
  });

  it('localStamp et localDateTime : deux chiffres partout, heure locale', () => {
    assert.equal(localStamp(local(2026, 1, 2, 3, 4, 5)), '2026_01_02_03_04_05');
    assert.equal(localDateTime(local(2026, 1, 2, 3, 4, 5)), '2026-01-02 03:04:05');
  });

  it('renvoie null pour un chemin qui n\'est pas une voie d\'enregistreur, et ne recopie rien de ce chemin', () => {
    assert.equal(playbackUrl('/stream1', '192.168.1.13', 554, at), null);
    assert.equal(playbackUrl(null, '192.168.1.13', 554, at), null);
    assert.equal(playbackUrl('/cam/realmonitor?channel=0', '192.168.1.13', 554, at), null);
    assert.equal(playbackUrl('/cam/realmonitor?channel=257', '192.168.1.13', 554, at), null);
    const hostile = '/cam/realmonitor?channel=1&starttime=2000_01_01_00_00_00&endtime=EVIL';
    assert.equal(playbackUrl(hostile, '192.168.1.13', 554, at), null);
    // meme un chemin valide ne laisse passer que le numero de voie : ni sous-flux, ni parametre libre
    const url = playbackUrl('/cam/realmonitor?channel=5&subtype=1', '192.168.1.13', 554, at)!;
    assert.deepEqual([...new URL(url).searchParams.keys()], ['channel', 'subtype', 'starttime', 'endtime']);
  });

  it('refuse un hote ou un port invalide', () => {
    for (const host of ['', 'a b', 'h/../x', 'user@h', 'rtsp://h', 'h:554', 'h?x=1', 'h\n', '-h.', 'h'.repeat(300)]) {
      assert.equal(playbackUrl('/cam/realmonitor?channel=1', host, 554, at), null, JSON.stringify(host.slice(0, 20)));
    }
    for (const port of [0, -1, 65536, 1.5, NaN, Infinity]) assert.equal(playbackUrl('/cam/realmonitor?channel=1', 'h', port, at), null, String(port));
  });

  it('l\'heure du passage doit etre un entier borne', () => {
    for (const bad of [NaN, Infinity, -Infinity, 1.5, -1, 0, 1e20, Number.MAX_SAFE_INTEGER, 946_684_799_999, 4_102_444_800_001, '1760000000000' as never, null as never, undefined as never]) {
      assert.equal(playbackUrl('/cam/realmonitor?channel=1', 'h', 554, bad), null, String(bad));
    }
    assert.ok(playbackUrl('/cam/realmonitor?channel=1', 'h', 554, 946_684_800_000));
    assert.ok(playbackUrl('/cam/realmonitor?channel=1', 'h', 554, 4_102_444_800_000));
  });
});

// ================================================================================================ service

const FAKE_SCRIPT = `
import { writeFileSync } from 'node:fs';
const [, , mode, pidFile] = process.argv;
if (pidFile) writeFileSync(pidFile, String(process.pid));
process.stdout.on('error', () => process.exit(0));
if (mode === 'refuse') {
  process.stderr.write('[rtsp] method DESCRIBE failed: 401 Unauthorized (rtsp://viewer:p%40ss%2Fword@127.0.0.1:554/cam/playback)\\n');
  process.exit(1);
}
if (mode === 'silent') setInterval(() => {}, 1000);
else {
  const frame = (n) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(40, (n % 200) + 1), Buffer.from([0xff, 0xd9])]);
  const limit = mode === 'finite' ? 5 : Infinity;
  let n = 0;
  const timer = setInterval(() => {
    process.stdout.write(frame(n++));
    if (n >= limit) { clearInterval(timer); process.stdout.end(); }
  }, 30);
}
`;

type Mode = 'finite' | 'forever' | 'refuse' | 'silent';
const NOW = local(2026, 10, 17, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 86_400_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(condition: () => boolean, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await sleep(25);
  }
  return condition();
}

interface Ctx {
  video: ReturnType<typeof createVideoService>;
  urls: string[];
  mode: { value: Mode };
  pidOf: (n: number) => number;
  url: (cameraId: string, at: number) => string;
  engine: ReturnType<typeof createEngine>;
  close: () => void;
}

/** Service video + serveur HTTP minimal (la route du vrai serveur est testee plus bas) ; faux flux Node, horloge fixe. */
async function setup(opts: { playbackMaxMs?: number; ffmpegPath?: string; argsFor?: (url: string) => string[] } = {}): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'psim-playback-'));
  const script = join(dir, 'fake-ffmpeg.mjs');
  writeFileSync(script, FAKE_SCRIPT);
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(ROOT, 'seed'));
  const events: PsimEvent[] = [];
  const engine = createEngine(db, (e) => events.push(e));
  const urls: string[] = [];
  const mode = { value: 'forever' as Mode };
  const video = createVideoService({
    db,
    engine,
    key,
    publish: (e) => events.push(e),
    now: () => NOW,
    ffmpegPath: opts.ffmpegPath ?? process.execPath,
    argsFor: (url) => {
      urls.push(url);
      return opts.argsFor ? opts.argsFor(url) : [script, mode.value, join(dir, `pid-${urls.length}`)];
    },
    ...(opts.playbackMaxMs ? { playbackMaxMs: opts.playbackMaxMs } : {}),
  });
  video.setSource('admin', 'C-01', { kind: 'rtsp', host: '127.0.0.1', port: 554, rtspPath: '/cam/realmonitor?channel=3&subtype=1', username: 'viewer', password: 'p@ss/word' });
  video.setSource('admin', 'C-02', { kind: 'onvif', host: '127.0.0.1', username: 'u', password: 'secret' });
  video.setSource('admin', 'C-03', { kind: 'rtsp', host: '127.0.0.1', rtspPath: '/stream1' });
  // C-04 reste simulee ; C-05 : autre voie, autre port, sous-flux 1
  video.setSource('admin', 'C-05', { kind: 'rtsp', host: 'nvr.local', port: 8554, rtspPath: '/cam/realmonitor?channel=2&subtype=1', username: 'viewer', password: 'p@ss/word' });
  const server: Server = createServer((req, res) => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    try {
      video.attachPlayback(q.get('id') ?? '', Number(q.get('at')), res);
    } catch (err) {
      const e = err instanceof PsimError ? err : new PsimError(500, 'Erreur interne');
      res.writeHead(e.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return {
    video,
    urls,
    mode,
    engine,
    pidOf: (n) => Number(readFileSync(join(dir, `pid-${n}`), 'utf8')),
    url: (id, at) => `${base}?id=${encodeURIComponent(id)}&at=${at}`,
    close: () => {
      video.shutdown();
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Lit une reponse de relecture : en-tetes, nombre d'images, fin eventuelle. `abortAfter` images : coupe comme le navigateur. */
async function play(url: string, abortAfter = Infinity) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('multipart/')) return { res, status: res.status, type, frames: 0, ended: true, json: (await res.json()) as { error?: string }, controller };
  let frames = 0;
  const split = createJpegSplitter(() => frames++);
  const reader = res.body!.getReader();
  let ended = false;
  while (frames < abortAfter) {
    const { value, done } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    split(Buffer.from(value));
  }
  if (!ended) controller.abort();
  return { res, status: res.status, type, frames, ended, json: null, controller };
}

describe('relecture : camera relisible ou non', () => {
  let ctx: Ctx;
  before(async () => {
    ctx = await setup();
  });
  after(() => ctx.close());

  it('seules les voies d\'enregistreur Dahua en RTSP sont relisibles', () => {
    assert.equal(ctx.video.replayable('C-01'), true);
    assert.equal(ctx.video.replayable('C-05'), true);
    assert.equal(ctx.video.replayable('C-02'), false, 'ONVIF : direct seulement');
    assert.equal(ctx.video.replayable('C-03'), false, 'RTSP d\'un autre chemin');
    assert.equal(ctx.video.replayable('C-04'), false, 'camera simulee');
    assert.equal(ctx.video.replayable('D-01'), false, 'un detecteur n\'est pas une camera');
    assert.equal(ctx.video.replayable('inconnue'), false);
    assert.deepEqual(ctx.video.listReplayable(), ['C-01', 'C-05']);
  });

  it('suit la source : repassee en simulee ou changee de chemin, la camera n\'est plus relisible', () => {
    ctx.video.setSource('admin', 'C-05', { kind: 'rtsp', host: 'nvr.local', rtspPath: '/live' });
    assert.deepEqual(ctx.video.listReplayable(), ['C-01']);
    ctx.video.setSource('admin', 'C-01', { kind: 'simulated' });
    assert.deepEqual(ctx.video.listReplayable(), []);
    ctx.video.setSource('admin', 'C-01', { kind: 'rtsp', host: '127.0.0.1', port: 554, rtspPath: '/cam/realmonitor?channel=3&subtype=1', username: 'viewer', password: 'p@ss/word' });
    ctx.video.setSource('admin', 'C-05', { kind: 'rtsp', host: 'nvr.local', port: 8554, rtspPath: '/cam/realmonitor?channel=2&subtype=1', username: 'viewer', password: 'p@ss/word' });
    assert.deepEqual(ctx.video.listReplayable(), ['C-01', 'C-05']);
  });

  it('refuse sans lancer ffmpeg : camera simulee, ONVIF, autre chemin RTSP, detecteur, camera inconnue', async () => {
    const at = NOW - HOUR;
    for (const [id, status] of [['C-04', 404], ['C-02', 409], ['C-03', 409], ['D-01', 404], ['inconnue', 404]] as const) {
      const r = await play(ctx.url(id, at));
      assert.equal(r.status, status, id);
      assert.ok(r.json?.error, id);
    }
    assert.equal(ctx.urls.length, 0, 'aucun ffmpeg lance');
    assert.equal(ctx.video.activePlaybacks(), 0);
  });

  it('l\'heure : entier, pas dans le futur de plus d\'une minute, pas plus vieille que 400 jours', async () => {
    for (const at of ['abc', '', '1.5', 'NaN', 'Infinity', '-5', '1e30']) {
      const r = await play(`${ctx.url('C-01', 0).replace(/&at=.*/, '')}&at=${encodeURIComponent(at)}`);
      assert.equal(r.status, 400, `at=${at}`);
    }
    assert.equal((await play(ctx.url('C-01', NOW + 60_001))).status, 400, 'futur de plus d\'une minute');
    assert.equal((await play(ctx.url('C-01', NOW + DAY))).status, 400);
    assert.equal((await play(ctx.url('C-01', NOW - 400 * DAY - 1))).status, 400, 'plus de 400 jours');
    assert.equal((await play(ctx.url('C-01', 1))).status, 400);
    assert.equal(ctx.urls.length, 0);
    // limites incluses : acceptees (le faux flux tourne, on coupe)
    for (const at of [NOW + 60_000, NOW - 400 * DAY]) {
      const r = await play(ctx.url('C-01', at), 2);
      assert.equal(r.status, 200, `at=${at}`);
    }
    assert.equal(ctx.urls.length, 2);
    await until(() => ctx.video.activePlaybacks() === 0);
  });
});

describe('relecture : faux flux local', () => {
  let ctx: Ctx;
  afterEach(() => ctx?.close());

  it('l\'adresse passee a ffmpeg est la relecture Dahua de la voie, avec les identifiants de la camera, en heure locale', async () => {
    ctx = await setup();
    ctx.mode.value = 'finite';
    const at = local(2026, 10, 16, 14, 32, 5);
    const r = await play(ctx.url('C-01', at));
    assert.equal(r.status, 200);
    assert.equal(ctx.urls.length, 1);
    const url = new URL(ctx.urls[0]);
    assert.equal(url.protocol, 'rtsp:');
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.pathname, '/cam/playback');
    assert.equal(decodeURIComponent(url.username), 'viewer');
    assert.equal(decodeURIComponent(url.password), 'p@ss/word');
    assert.deepEqual(Object.fromEntries(url.searchParams), { channel: '3', subtype: '0', starttime: '2026_10_16_14_31_55', endtime: '2026_10_16_14_32_25' });
    // autre voie, autre hote, autre port
    await play(ctx.url('C-05', at));
    const other = new URL(ctx.urls[1]);
    assert.equal(other.host, 'nvr.local:8554');
    assert.equal(other.searchParams.get('channel'), '2');
  });

  it('diffuse du multipart MJPEG comme le direct, sans mot de passe dans les en-tetes, et se ferme a la fin du clip', async () => {
    ctx = await setup();
    ctx.mode.value = 'finite';
    const r = await play(ctx.url('C-01', NOW - HOUR));
    assert.equal(r.status, 200);
    assert.match(r.type, /^multipart\/x-mixed-replace; boundary=psimframe$/);
    assert.equal(r.res.headers.get('cache-control'), 'no-store');
    assert.equal(r.frames, 5);
    assert.equal(r.ended, true, 'la reponse se ferme toute seule a la fin du clip');
    const headers = JSON.stringify([...r.res.headers.entries()]);
    for (const secret of ['p@ss', 'p%40ss', 'word', 'viewer', 'rtsp://']) assert.ok(!headers.includes(secret), `${secret} dans les en-tetes`);
    assert.ok(await until(() => ctx.video.activePlaybacks() === 0), 'place rendue');
    assert.ok(await until(() => !alive(ctx.pidOf(1))), 'ffmpeg termine');
  });

  it('un ffmpeg PAR demande : deux relectures de la meme camera ne partagent rien', async () => {
    ctx = await setup();
    const a = play(ctx.url('C-01', NOW - HOUR), 3);
    const b = play(ctx.url('C-01', NOW - HOUR), 3);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.frames, 3);
    assert.equal(rb.frames, 3);
    assert.equal(ctx.urls.length, 2, 'deux processus');
    assert.notEqual(ctx.pidOf(1), ctx.pidOf(2));
    assert.equal(ctx.video.activeFeeds(), 0, 'le flux partage du direct n\'est pas touche');
  });

  it('plafond : la 3e relecture simultanee est refusee (503), puis une place libre est reutilisee', async () => {
    ctx = await setup();
    assert.equal(MAX_PLAYBACKS, 2);
    const open: Array<{ controller: AbortController }> = [];
    for (let i = 0; i < MAX_PLAYBACKS; i++) {
      const controller = new AbortController();
      const res = await fetch(ctx.url('C-01', NOW - HOUR), { signal: controller.signal });
      assert.equal(res.status, 200);
      open.push({ controller });
    }
    assert.equal(ctx.video.activePlaybacks(), 2);
    const third = await play(ctx.url('C-05', NOW - HOUR));
    assert.equal(third.status, 503);
    assert.equal(third.json?.error, 'Trop de relectures en cours');
    assert.equal(ctx.urls.length, 2, 'le refus ne lance aucun ffmpeg');
    open[0].controller.abort();
    assert.ok(await until(() => ctx.video.activePlaybacks() === 1), 'place rendue a la fermeture');
    const fourth = await play(ctx.url('C-05', NOW - HOUR), 2);
    assert.equal(fourth.status, 200);
    open[1].controller.abort();
  });

  it('la fermeture de la reponse arrete ffmpeg', async () => {
    ctx = await setup();
    const r = await play(ctx.url('C-01', NOW - HOUR), 3);
    assert.equal(r.ended, false);
    const pid = ctx.pidOf(1);
    assert.ok(await until(() => ctx.video.activePlaybacks() === 0), 'relecture terminee');
    assert.ok(await until(() => !alive(pid)), 'processus ffmpeg arrete apres la fermeture du navigateur');
  });

  it('arret automatique apres la duree maximale, meme si ffmpeg ne s\'arrete pas tout seul', async () => {
    ctx = await setup({ playbackMaxMs: 2000 }); // assez pour laisser demarrer le faux flux, meme machine chargee
    const t0 = Date.now();
    const r = await play(ctx.url('C-01', NOW - HOUR));
    assert.equal(r.status, 200);
    assert.equal(r.ended, true);
    assert.ok(Date.now() - t0 < 8000);
    assert.ok(r.frames >= 1);
    assert.ok(await until(() => !alive(ctx.pidOf(1))));
    assert.equal(ctx.video.activePlaybacks(), 0);
  });

  it('shutdown arrete les relectures en cours', async () => {
    ctx = await setup();
    const res = await fetch(ctx.url('C-01', NOW - HOUR)); // les en-tetes arrivent avec la premiere image
    assert.equal(ctx.video.activePlaybacks(), 1);
    ctx.video.shutdown();
    await res.arrayBuffer(); // la reponse se ferme (sinon le test reste suspendu)
    assert.equal(ctx.video.activePlaybacks(), 0);
    assert.ok(await until(() => !alive(ctx.pidOf(1))));
  });

  it('ffmpeg qui echoue (identifiants refuses) : message clair, jamais le mot de passe, ni dans la reponse ni dans le journal', async () => {
    ctx = await setup();
    ctx.mode.value = 'refuse';
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
    try {
      const r = await play(ctx.url('C-01', NOW - HOUR));
      assert.equal(r.status, 502);
      assert.equal(r.json?.error, `${NO_RECORDING_MESSAGE} (identifiants refuses par l'enregistreur)`);
      assert.ok(!JSON.stringify(r.json).match(/p@ss|p%40ss|word/));
      assert.ok(warnings.length > 0, 'la cause est journalisee pour l\'installateur');
      assert.ok(!warnings.join('\n').match(/p@ss|p%40ss|word/), warnings.join('\n'));
    } finally {
      console.warn = original;
    }
    assert.equal(ctx.video.activePlaybacks(), 0);
  });

  it('ffmpeg qui ne dit rien et ne sort aucune image : arret par la duree maximale, message clair', async () => {
    ctx = await setup({ playbackMaxMs: 1500 });
    ctx.mode.value = 'silent';
    const r = await play(ctx.url('C-01', NOW - HOUR));
    assert.equal(r.status, 504);
    assert.equal(r.json?.error, NO_RECORDING_MESSAGE);
    assert.ok(await until(() => !alive(ctx.pidOf(1))));
    assert.equal(ctx.video.activePlaybacks(), 0);
  });

  it('ffmpeg introuvable : erreur claire, la place est rendue', async () => {
    ctx = await setup({ ffmpegPath: join(tmpdir(), 'ffmpeg-qui-n-existe-pas') });
    const r = await play(ctx.url('C-01', NOW - HOUR));
    assert.equal(r.status, 500);
    assert.match(r.json?.error ?? '', /ffmpeg introuvable/);
    assert.ok(await until(() => ctx.video.activePlaybacks() === 0));
  });
});

describe('relecture : mot de passe illisible', () => {
  it('cle de chiffrement changee : 500 clair, aucun ffmpeg, aucune place prise', async () => {
    const db = openDb(':memory:');
    seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(ROOT, 'seed'));
    const engine = createEngine(db, () => {});
    const make = (k: Buffer) => createVideoService({ db, engine, key: k, publish: () => {}, now: () => NOW, argsFor: () => assert.fail('ffmpeg ne doit pas etre lance') as never });
    make(key).setSource('admin', 'C-01', { kind: 'rtsp', host: '127.0.0.1', rtspPath: '/cam/realmonitor?channel=1', username: 'u', password: 'secret' });
    const changed = make(Buffer.alloc(32, 9));
    const fake = { on() {}, writeHead() {}, end() {} } as never;
    assert.throws(() => changed.attachPlayback('C-01', NOW - HOUR, fake), (e: unknown) => e instanceof PsimError && e.status === 500 && /illisible/.test(e.message));
    assert.equal(changed.activePlaybacks(), 0);
  });
});

describe('relecture : vrai ffmpeg sur une mire locale (faux flux lavfi)', { skip: NO_FFMPEG }, () => {
  let ctx: Ctx;
  before(async () => {
    // Mire generee localement : ffmpeg ne se connecte a rien, mais l'adresse RTSP de relecture est bien celle recue par argsFor.
    ctx = await setup({
      ffmpegPath: 'ffmpeg',
      argsFor: () => ['-hide_banner', '-loglevel', 'error', '-nostdin', '-re', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-frames:v', '60', '-q:v', '7', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
    });
  });
  after(() => ctx.close());

  it('sert de vraies images JPEG, dans le meme format que le direct, avec la bonne adresse de relecture', async () => {
    const at = local(2026, 10, 16, 14, 32, 5);
    const r = await play(ctx.url('C-01', at), 5);
    assert.equal(r.status, 200);
    assert.match(r.type, /^multipart\/x-mixed-replace; boundary=psimframe$/);
    assert.ok(r.frames >= 5);
    assert.equal(ctx.urls.length, 1);
    assert.match(ctx.urls[0], /^rtsp:\/\/viewer:p%40ss%2Fword@127\.0\.0\.1:554\/cam\/playback\?channel=3&subtype=0&starttime=2026_10_16_14_31_55&endtime=2026_10_16_14_32_25$/);
    assert.ok(await until(() => ctx.video.activePlaybacks() === 0), 'ffmpeg arrete a la fermeture');
  });

  it('le clip se termine tout seul quand la mire est finie', async () => {
    const r = await play(ctx.url('C-05', NOW - HOUR));
    assert.equal(r.status, 200);
    assert.equal(r.ended, true);
    assert.ok(r.frames >= 50 && r.frames <= 60, `${r.frames} images (un client lent peut en sauter quelques-unes)`);
  });
});

// ================================================================================================ routes (vrai serveur)

const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';
const freePort = () =>
  new Promise<number>((r) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });

describe('routes de relecture (processus reel, ffmpeg remplace par un executable qui echoue)', { timeout: 120_000 }, () => {
  let proc: ChildProcess;
  let base = '';
  let output = '';
  let admin = '';
  let operator = '';

  async function login(username: string, password: string): Promise<string> {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(res.status, 200);
    return res.headers.getSetCookie()[0].split(';')[0];
  }
  async function call(method: string, path: string, cookie: string | null, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
  }

  before(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
    Object.assign(env, {
      PSIM_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'psim-playback-e2e-')), 'data'),
      PSIM_PORT: String(port),
      PSIM_MQTT_PORT: String(await freePort()),
      PSIM_ADMIN_PASSWORD: ADMIN_PW,
      PSIM_OPERATOR_PASSWORD: OPERATOR_PW,
      PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3',
      PSIM_DEMO_LOGIN: '0',
      PSIM_REQUIRE_2FA: 'none',
      // « ffmpeg » = node : il refuse les options de ffmpeg et sort aussitot, sans reseau ni materiel.
      PSIM_FFMPEG: process.execPath,
    });
    proc = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout!.on('data', (d) => (output += d));
    proc.stderr!.on('data', (d) => (output += d));
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).status === 200) break;
      } catch {
        // pas encore pret
      }
      await sleep(250);
    }
    admin = await login('admin', ADMIN_PW);
    operator = await login('operateur', OPERATOR_PW);
    const set = (id: string, body: unknown) => call('PUT', `/api/cameras/${id}/source`, admin, body);
    assert.equal((await set('C-01', { kind: 'rtsp', host: '127.0.0.1', port: 9, rtspPath: '/cam/realmonitor?channel=4&subtype=1', username: 'viewer', password: 'SECRETPASS-1' })).status, 200);
    assert.equal((await set('C-03', { kind: 'rtsp', host: '127.0.0.1', port: 9, rtspPath: '/stream1' })).status, 200);
  });

  after(() => proc?.kill());

  it('GET /api/cameras/replayable : session requise, liste les voies relisibles, avant la route :id', async () => {
    assert.equal((await call('GET', '/api/cameras/replayable', null)).status, 401);
    for (const cookie of [admin, operator]) {
      const r = await call('GET', '/api/cameras/replayable', cookie);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { ids: ['C-01'] });
    }
  });

  it('GET /api/cameras/:id/playback : session requise ; heure, camera et type de source controles', async () => {
    const at = Date.now() - HOUR;
    assert.equal((await call('GET', `/api/cameras/C-01/playback?at=${at}`, null)).status, 401);
    for (const bad of ['', '?at=', '?at=abc', '?at=1.5', '?at=-1', '?at[]=1', `?at=${at}&at=${at}`, '?at=99999999999999999999', `?at=${Date.now() + 3_600_000}`, `?at=${Date.now() - 500 * DAY}`]) {
      const r = await call('GET', `/api/cameras/C-01/playback${bad}`, operator);
      assert.equal(r.status, 400, bad);
      assert.ok(r.body.error, bad);
    }
    assert.equal((await call('GET', `/api/cameras/C-02/playback?at=${at}`, operator)).status, 404, 'camera simulee');
    assert.equal((await call('GET', `/api/cameras/C-03/playback?at=${at}`, operator)).status, 409, 'RTSP d\'un autre chemin');
    assert.equal((await call('GET', `/api/cameras/D-01/playback?at=${at}`, operator)).status, 404, 'detecteur');
    assert.equal((await call('GET', `/api/cameras/inconnue/playback?at=${at}`, operator)).status, 404);
    const audit = await call('GET', '/api/audit?limit=200', admin);
    assert.equal(audit.body.filter((a: any) => a.action === 'camera_playback').length, 0, 'une demande refusee n\'est pas une relecture');
  });

  it('une relecture acceptee est journalisee (acteur, camera, heure demandee), une ligne par demande, sans mot de passe', async () => {
    // le serveur reel utilise l'horloge reelle : on demande une heure recente
    const recent = Date.now() - 2 * HOUR;
    for (let i = 0; i < 2; i++) {
      const r = await call('GET', `/api/cameras/C-01/playback?at=${recent + i * 1000}`, operator);
      // le faux ffmpeg echoue : 502 avec le message clair ; la demande etait pourtant acceptee et est journalisee
      assert.equal(r.status, 502, JSON.stringify(r.body));
      assert.equal(r.body.error, NO_RECORDING_MESSAGE);
      assert.ok(!JSON.stringify(r.body).includes('SECRETPASS'));
    }
    const audit = (await call('GET', '/api/audit?limit=200', admin)).body.filter((a: any) => a.action === 'camera_playback');
    assert.equal(audit.length, 2);
    for (const [i, a] of audit.reverse().entries()) {
      assert.equal(a.actor, 'operateur');
      assert.equal(a.deviceId, 'C-01');
      assert.equal(a.details, `heure demandee ${localDateTime(recent + i * 1000)}`);
      assert.ok(!JSON.stringify(a).includes('SECRETPASS'));
    }
    assert.ok(!output.includes('SECRETPASS'), 'mot de passe absent des journaux du serveur');
  });
});
