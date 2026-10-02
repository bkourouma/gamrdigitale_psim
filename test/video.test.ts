import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import { probeMatches, startDiscoveryResponder, startOnvifDevice } from '../scripts/demo/onvif-device.ts';
import type { OnvifDevice } from '../scripts/demo/onvif-device.ts';
import { pickProfile, probeOnvif } from '../server/onvif.ts';
import { loadSecretKey, seal, unseal } from '../server/secrets.ts';
import { seedDemo } from '../server/seed.ts';
import { createJpegSplitter, createVideoService, explainFfmpeg } from '../server/video.ts';
import type { VideoService } from '../server/video.ts';
import type { PsimEvent } from '../server/types.ts';

const key = Buffer.alloc(32, 7);
const isPsimError = (status: number) => (e: unknown) => e instanceof PsimError && e.status === status;

// Source ffmpeg de test : une mire generee localement, sans camera ni reseau.
const testPattern = () => ['-hide_banner', '-loglevel', 'error', '-nostdin', '-re', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-frames:v', '60', '-q:v', '7', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'];
const testPatternOnce = () => testPattern().map((a) => (a === '60' ? '1' : a));

function setup(overrides: { idleStopMs?: number } = {}) {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  const events: PsimEvent[] = [];
  const engine = createEngine(db, (e) => events.push(e));
  const video = createVideoService({
    db,
    engine,
    key,
    publish: (e) => events.push(e),
    argsFor: (_url, once) => (once ? testPatternOnce() : testPattern()),
    ...overrides,
  });
  return { db, engine, video, events };
}

describe('chiffrement des identifiants', () => {
  it('chiffre puis dechiffre, avec un chiffre different a chaque fois', () => {
    const a = seal(key, 'motdepasse');
    assert.notEqual(a, seal(key, 'motdepasse'));
    assert.ok(!a.includes('motdepasse'));
    assert.equal(unseal(key, a), 'motdepasse');
  });

  it('refuse une valeur alteree ou une mauvaise cle', () => {
    const sealed = seal(key, 'secret');
    const parts = sealed.split(':');
    parts[3] = Buffer.from('autre chose').toString('base64');
    assert.throws(() => unseal(key, parts.join(':')));
    assert.throws(() => unseal(Buffer.alloc(32, 9), sealed));
  });

  it('cree la cle une fois puis la relit ; rejette une cle mal formee', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-key-'));
    const first = loadSecretKey(dir, undefined);
    assert.deepEqual(loadSecretKey(dir, undefined), first);
    assert.throws(() => loadSecretKey(dir, 'trop-court'));
    assert.equal(loadSecretKey(dir, 'ab'.repeat(32)).length, 32);
  });
});

describe('decoupage du flux JPEG', () => {
  const jpeg = (fill: number, size = 50) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(size, fill), Buffer.from([0xff, 0xd9])]);

  it('extrait les images meme coupees en morceaux arbitraires, en ignorant les octets parasites', () => {
    const frames: Buffer[] = [];
    const push = createJpegSplitter((f) => frames.push(Buffer.from(f)));
    const stream = Buffer.concat([Buffer.from([1, 2, 3]), jpeg(0x11), jpeg(0x22, 200), Buffer.from([0xff]), jpeg(0x33)]);
    for (let i = 0; i < stream.length; i += 7) push(stream.subarray(i, i + 7));
    assert.equal(frames.length, 3);
    assert.deepEqual(frames[0], jpeg(0x11));
    assert.deepEqual(frames[1], jpeg(0x22, 200));
    assert.deepEqual(frames[2], jpeg(0x33));
  });

  it("gere un marqueur de debut coupe entre deux paquets", () => {
    const frames: Buffer[] = [];
    const push = createJpegSplitter((f) => frames.push(Buffer.from(f)));
    const one = jpeg(0x44);
    push(one.subarray(0, 1));
    push(one.subarray(1));
    assert.equal(frames.length, 1);
  });
});

describe('configuration de la source video', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("enregistre une source RTSP, chiffre le mot de passe et ne le renvoie jamais", () => {
    const view = ctx.video.setSource('admin', 'C-01', { kind: 'rtsp', host: '192.168.1.50', rtspPath: '/stream1', username: 'viewer', password: 'p@ss/word' });
    assert.deepEqual(view, { kind: 'rtsp', host: '192.168.1.50', port: 554, rtspPath: '/stream1', username: 'viewer', hasPassword: true });
    const row = ctx.db.prepare('SELECT secret FROM camera_source WHERE device_id = ?').get('C-01') as { secret: string };
    assert.ok(!row.secret.includes('p@ss'));
    assert.equal(ctx.engine.getDevice('C-01')?.streamKind, 'rtsp');
    assert.ok(ctx.events.some((e) => e.type === 'config'));
    const logged = JSON.stringify(ctx.engine.listAudit(20));
    assert.ok(!logged.includes('p@ss'), 'le mot de passe ne doit jamais atteindre le journal');
  });

  it("conserve le mot de passe quand il est omis a la modification", () => {
    ctx.video.setSource('admin', 'C-01', { kind: 'onvif', host: '10.0.0.5', username: 'u', password: 'secret' });
    const before = (ctx.db.prepare('SELECT secret FROM camera_source').get() as { secret: string }).secret;
    const view = ctx.video.setSource('admin', 'C-01', { kind: 'onvif', host: '10.0.0.6', username: 'u', password: '' });
    assert.equal(view.host, '10.0.0.6');
    assert.equal(view.port, 80);
    assert.equal((ctx.db.prepare('SELECT secret FROM camera_source').get() as { secret: string }).secret, before);
  });

  it('revient a la camera simulee', () => {
    ctx.video.setSource('admin', 'C-01', { kind: 'rtsp', host: '10.0.0.5' });
    assert.equal(ctx.video.setSource('admin', 'C-01', { kind: 'simulated' }).kind, 'simulated');
    assert.equal(ctx.engine.getDevice('C-01')?.streamKind, 'simulated');
  });

  it('rejette les entrees dangereuses ou invalides', () => {
    const bad = (input: Record<string, unknown>) => assert.throws(() => ctx.video.setSource('admin', 'C-01', input), isPsimError(400));
    bad({ kind: 'http', host: '10.0.0.5' });
    bad({ kind: 'onvif', host: 'http://10.0.0.5' });
    bad({ kind: 'onvif', host: '10.0.0.5/../x' });
    bad({ kind: 'onvif', host: 'user@10.0.0.5' });
    bad({ kind: 'onvif', host: '10.0.0.5', port: 70000 });
    bad({ kind: 'onvif', host: '10.0.0.5', port: 'abc' });
    bad({ kind: 'rtsp', host: '10.0.0.5', rtspPath: 'sans-slash' });
    bad({ kind: 'rtsp', host: '10.0.0.5', rtspPath: '/a b' });
    bad({ kind: 'onvif', host: '10.0.0.5', username: 'a\nb' });
    bad({ kind: 'onvif', host: '10.0.0.5', password: 'x'.repeat(200) });
    assert.throws(() => ctx.video.setSource('admin', 'D-01', { kind: 'onvif', host: '10.0.0.5' }), isPsimError(404));
    assert.equal(ctx.video.view('C-01').kind, 'simulated');
  });
});

describe('diffusion partagee (ffmpeg reel, mire de test)', () => {
  let server: Server;
  let url: string;
  let ctx: ReturnType<typeof setup>;

  before(async () => {
    ctx = setup({ idleStopMs: 300 });
    ctx.video.setSource('admin', 'C-01', { kind: 'rtsp', host: '127.0.0.1', rtspPath: '/live' });
    server = createServer((req, res) => {
      try {
        ctx.video.attachViewer('C-01', res);
      } catch (err) {
        res.writeHead(err instanceof PsimError ? err.status : 500).end();
      }
      void req;
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  after(() => {
    ctx.video.shutdown();
    server.close();
  });

  async function countFrames(wanted: number, controller: AbortController): Promise<{ frames: number; type: string | null }> {
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body!.getReader();
    const split = createJpegSplitter(() => frames++);
    let frames = 0;
    while (frames < wanted) {
      const { value, done } = await reader.read();
      if (done) break;
      // Le flux est du multipart : les images JPEG s'y retrouvent telles quelles.
      split(Buffer.from(value));
    }
    return { frames, type: res.headers.get('content-type') };
  }

  it('sert des images en multipart et partage un seul ffmpeg entre deux viewers', async () => {
    const a = new AbortController();
    const b = new AbortController();
    const [first, second] = await Promise.all([countFrames(5, a), countFrames(5, b)]);
    assert.match(first.type ?? '', /^multipart\/x-mixed-replace; boundary=/);
    assert.ok(first.frames >= 5 && second.frames >= 5);
    assert.equal(ctx.video.activeFeeds(), 1, 'un seul flux ffmpeg pour deux viewers');
    a.abort();
    b.abort();
  });

  it("arrete ffmpeg quand plus personne ne regarde", async () => {
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(ctx.video.activeFeeds(), 0);
  });

  it('refuse le flux d\'une camera simulee', () => {
    const fake = { on() {}, writeHead() {}, end() {} } as never;
    assert.throws(() => ctx.video.attachViewer('C-02', fake), isPsimError(404));
    assert.throws(() => ctx.video.attachViewer('D-01', fake), isPsimError(404));
  });

  it('le test de connexion renvoie une image et decrit la source', async () => {
    const result = await ctx.video.test('C-01');
    assert.equal(result.ok, true);
    assert.match(result.message, /Image recue/);
  });
});

describe('diagnostic des erreurs ffmpeg', () => {
  it('distingue refus, identifiants, chemin, delai et format', () => {
    // Le mot "timeout" figure dans l'URL passee a ffmpeg : il ne doit pas fausser le diagnostic.
    assert.match(explainFfmpeg('Connection to tcp://10.0.0.5:554?timeout=10000000 failed: Connection refused'), /refusee/);
    assert.match(explainFfmpeg('method DESCRIBE failed: 401 Unauthorized'), /identifiants/);
    assert.match(explainFfmpeg('method DESCRIBE failed: 404 Not Found'), /chemin/);
    assert.match(explainFfmpeg('Connection timed out'), /ne repond pas/);
    assert.match(explainFfmpeg('Invalid data found when processing input'), /format/);
    assert.equal(explainFfmpeg(''), 'flux illisible');
  });
});

describe('ffmpeg absent', () => {
  it('renvoie une erreur claire au lieu de planter', async () => {
    const broken = createVideoService(setupWith('ffmpeg-inexistant-xyz'));
    broken.setSource('admin', 'C-01', { kind: 'rtsp', host: '127.0.0.1' });
    await assert.rejects(broken.test('C-01'), (e) => e instanceof PsimError && /ffmpeg introuvable/.test(e.message));
  });
});

function setupWith(ffmpegPath: string) {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  const engine = createEngine(db, () => {});
  return { db, engine, key, publish: () => {}, ffmpegPath };
}

// ---- Dialogue ONVIF avec le faux appareil de la demonstration -----------------------------------

const RTSP = { host: '10.255.255.1', port: 8554, path: '/C-01' }; // adresse "interne" volontairement fausse

describe('dialogue ONVIF (faux appareil de la demo)', () => {
  let device: OnvifDevice;
  before(async () => {
    device = await startOnvifDevice({ port: 18801, username: 'cam', password: 'secret-cam', rtsp: RTSP });
  });
  after(() => device.close());

  it("choisit le profil le plus leger et force l'hote configure dans l'adresse du flux", async () => {
    const probe = await probeOnvif({ host: '127.0.0.1', port: device.port, username: 'cam', password: 'secret-cam' });
    assert.equal(probe.manufacturer, 'DemoCam');
    assert.equal(probe.model, 'DC-100');
    assert.equal(probe.profile.name, 'sub');
    assert.equal(probe.profile.width, 480);
    assert.equal(probe.profile.encoding, 'H264');
    const url = new URL(probe.uri);
    assert.equal(url.hostname, '127.0.0.1', "l'adresse interne annoncee par la camera doit etre remplacee");
    assert.equal(url.port, '8554');
    assert.equal(url.pathname, '/C-01', 'le profil secondaire, pas le principal');
    assert.equal(url.username, '', "aucun identifiant dans l'adresse renvoyee");
  });

  it("se replie sur GetCapabilities quand GetServices n'est pas implemente", async () => {
    device.requests.length = 0;
    await probeOnvif({ host: '127.0.0.1', port: device.port, username: 'cam', password: 'secret-cam' });
    assert.ok(device.requests.includes('GetServices') && device.requests.includes('GetCapabilities'));
    assert.ok(device.requests.indexOf('GetSystemDateAndTime') < device.requests.indexOf('GetProfiles'));
  });

  it("refuse un mauvais mot de passe avec un message clair, et la camera le constate", async () => {
    const failuresBefore = device.authFailures;
    await assert.rejects(
      probeOnvif({ host: '127.0.0.1', port: device.port, username: 'cam', password: 'mauvais' }),
      (e) => e instanceof PsimError && e.status === 502 && /Identifiants refuses/.test(e.message),
    );
    assert.ok(device.authFailures > failuresBefore, 'la verification WS-Security a bien eu lieu');
  });

  it('refuse un mauvais utilisateur', async () => {
    await assert.rejects(
      probeOnvif({ host: '127.0.0.1', port: device.port, username: 'intrus', password: 'secret-cam' }),
      (e) => e instanceof PsimError && /Identifiants refuses/.test(e.message),
    );
  });

  it('traduit une camera injoignable en message clair', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const freePort = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    await assert.rejects(
      probeOnvif({ host: '127.0.0.1', port: freePort, username: 'u', password: 'p' }),
      (e) => e instanceof PsimError && e.status === 502 && /refusee|repond/.test(e.message),
    );
  });

  it('pickProfile ecarte le H.265 quand une alternative existe', () => {
    const p = (token: string, encoding: string | null, width: number | null) => ({ token, name: token, width, height: width && width * 0.5625, encoding });
    assert.equal(pickProfile([p('a', 'H265', 640), p('b', 'H264', 1920)])?.token, 'b');
    assert.equal(pickProfile([p('a', 'H265', 3840), p('b', 'H265', 640)])?.token, 'b');
    assert.equal(pickProfile([]), null);
  });
});

describe('decouverte reseau (faux appareils de la demo)', () => {
  it('le repondeur renvoie une reponse WS-Discovery exploitable par la recherche du PSIM', async () => {
    const devices = [
      { host: '127.0.0.1', port: 8801, name: 'DemoCam C-01', hardware: 'DC-100' },
      { host: '127.0.0.1', port: 8802, name: 'DemoCam C-02', hardware: 'DC-100' },
    ];
    const responder = await startDiscoveryResponder(devices, 0);
    const client = createSocket('udp4');
    const replies: string[] = [];
    client.on('message', (msg) => replies.push(msg.toString()));
    await new Promise<void>((r) => client.bind(0, '127.0.0.1', r));
    const probe = '<Envelope><Header><wsa:MessageID>urn:uuid:test-1</wsa:MessageID></Header><Body><Probe><Types>dn:NetworkVideoTransmitter</Types></Probe></Body></Envelope>';
    client.send(probe, responder.port, '127.0.0.1');
    await new Promise((r) => setTimeout(r, 400));
    client.close();
    await responder.close();

    assert.equal(replies.length, 2, 'une reponse par appareil');
    assert.match(replies[0], /<d:XAddrs>http:\/\/127\.0\.0\.1:8801\/onvif\/device_service</);
    assert.match(replies[1], /8802/);
    assert.match(replies[0], /RelatesTo>urn:uuid:test-1</, 'repond a la bonne requete');
    assert.match(replies[0], /name\/DemoCam%20C-01/);
  });

  it("ignore les messages qui ne sont pas des recherches", async () => {
    const responder = await startDiscoveryResponder([{ host: '127.0.0.1', port: 8801, name: 'x', hardware: 'y' }], 0);
    const client = createSocket('udp4');
    let got = 0;
    client.on('message', () => got++);
    await new Promise<void>((r) => client.bind(0, '127.0.0.1', r));
    client.send('n importe quoi', responder.port, '127.0.0.1');
    await new Promise((r) => setTimeout(r, 250));
    client.close();
    await responder.close();
    assert.equal(got, 0);
  });

  it('une camera annoncee est stable (meme identifiant a chaque reponse)', () => {
    const d = { host: '127.0.0.1', port: 8801, name: 'A', hardware: 'B' };
    const urn = (xml: string) => /Address>(urn:uuid:[^<]+)</.exec(xml)?.[1];
    assert.equal(urn(probeMatches(d, 'r1')), urn(probeMatches(d, 'r2')));
  });
});
