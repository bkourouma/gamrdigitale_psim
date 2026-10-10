/**
 * Images envoyees par les equipements (POST /api/ingest/<id>/image) : cles par equipement, controles d'entree, quotas,
 * rattachement a l'incident (immediat ou differe), scellement au journal et verification des fichiers, migration d'une
 * base ancienne, absence d'image dans le resume du portail.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { verify } from '../server/auditchain.ts';
import { createBackup, verifyBackup } from '../server/backup.ts';
import { openDb } from '../server/db.ts';
import { createDeviceImages } from '../server/deviceimages.ts';
import type { DeviceImageLimits } from '../server/deviceimages.ts';
import { createDeviceKeys } from '../server/devicekeys.ts';
import { createEngine } from '../server/engine.ts';
import { PsimError } from '../server/errors.ts';
import { formatIds, parseIds, sha256hex, sniffImage, verifyImages } from '../server/evidence.ts';
import { buildSiteSummary } from '../server/portal.ts';
import { preflight } from '../server/preflight.ts';
import type { PreflightInput } from '../server/preflight.ts';
import { seedDemo } from '../server/seed.ts';
import { createSnapshotService } from '../server/snapshots.ts';
import type { Incident } from '../server/types.ts';

/** JPEG minimal mais structurellement complet (APP0, SOF0 avec dimensions, SOS, EOI). */
function jpeg(w = 640, h = 480, pad = 32): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]),
    Buffer.alloc(pad, 0x55),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** PNG minimal (signature, IHDR, IDAT factice, IEND). Les CRC ne sont pas verifies : aucun decodage cote serveur. */
function png(w = 320, h = 240): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  const idat = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('IDAT', 'latin1'), Buffer.alloc(20, 7), Buffer.alloc(4)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, idat, Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]);
}

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));
let ipCounter = 1;

async function setup(limits: Partial<DeviceImageLimits> = {}) {
  const db = openDb(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'psim-devimg-'));
  seedDemo(db, dataDir, join(import.meta.dirname, '..', 'seed'));
  let t = Date.now();
  const clock = () => t;
  const published: number[] = [];
  let images: ReturnType<typeof createDeviceImages> | undefined;
  const engine = createEngine(db, () => {}, clock, {
    confirmWindowMs: 0,
    onIncidentEvent: (incident: Incident, kind) => {
      if (kind === 'opened') images?.attachPending(incident);
    },
  });
  const keys = createDeviceKeys({ db, audit: (a, b, c) => engine.audit(a, b, c), now: clock });
  images = createDeviceImages({ db, engine, dataDir, keys, limits: { perIpPerMin: 1000, ...limits }, publishIncident: (id) => void published.push(id), now: clock });
  const snapshots = createSnapshotService({ db, engine, dataDir, grab: async () => jpeg(), publishIncident: () => {} });

  const app = express();
  app.set('trust proxy', true); // chaque test a sa propre adresse : les verrous d'echecs (globaux) ne se melangent pas
  images.mount(app, { adminOnly: (_req, _res, next) => next(), actorOf: () => 'admin' });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof PsimError) return void res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: String(err) });
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  const ip = `10.0.0.${ipCounter++}`;

  /** Envoi brut : `body` = null => en-tetes seulement (on n'envoie jamais le corps annonce). */
  function upload(id: string, key: string | null, body: Buffer | null, headers: Record<string, string> = {}, query = ''): Promise<{ status: number; body: any; headers: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/api/ingest/${id}/image${query}`,
          headers: { 'X-Forwarded-For': ip, 'Content-Type': 'image/jpeg', ...(body ? { 'Content-Length': String(body.length) } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
        },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => {
            let parsed: any = null;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              parsed = text;
            }
            resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
          });
        },
      );
      req.on('error', reject);
      if (body) req.end(body);
      else req.flushHeaders();
    });
  }

  const createKey = (devices: string[], label = 'Camera 4G') => keys.create('admin', { label, devices });
  const incidentOf = (detectorId: string) => engine.getSnapshot().incidents.find((i) => i.detectorId === detectorId && i.status !== 'closed');
  return {
    db,
    dataDir,
    engine,
    keys,
    images,
    snapshots,
    published,
    upload,
    createKey,
    incidentOf,
    advance: (ms: number) => void (t += ms),
    alarm: (id: string) => engine.handleDetectorMessage(id, { state: 'alarm' }),
    closeIncident: (id: string) => {
      engine.handleDetectorMessage(id, { state: 'normal' });
      const incident = incidentOf(id)!;
      engine.close(incident.id, 'admin', 'false_alarm', '');
    },
  };
}

describe('reconnaissance des images (octets, jamais le Content-Type)', () => {
  it('JPEG et PNG complets reconnus, avec leurs dimensions lues sans decompression', () => {
    assert.deepEqual(sniffImage(jpeg(1920, 1080)), { type: 'jpg', width: 1920, height: 1080 });
    assert.deepEqual(sniffImage(png(800, 600)), { type: 'png', width: 800, height: 600 });
  });

  it('refuse le texte, le HTML, un JPEG tronque, un PNG sans fin, un JPEG sans dimensions', () => {
    assert.equal(sniffImage(Buffer.from('<html><script>alert(1)</script></html>')), null);
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
    assert.equal(sniffImage(jpeg().subarray(0, 40)), null);
    assert.equal(sniffImage(png().subarray(0, 60)), null);
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0, 0xff, 0xd9])), null);
    // longueur de segment qui deborde : jamais de lecture hors du tampon
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0, 0, 0xff, 0xd9])), null);
  });

  it('identifiants de purge : liste compacte et relecture fidele', () => {
    assert.equal(formatIds([5, 1, 2, 3, 8, 10, 11]), '1-3,5,8,10-11');
    assert.deepEqual(parseIds('1-3,5,8,10-11'), [1, 2, 3, 5, 8, 10, 11]);
  });
});

describe('cles par equipement', () => {
  it("seule l'empreinte est stockee ; la cle n'apparait ni en base ni au journal", async () => {
    const t = await setup();
    const k = t.createKey(['D-01']);
    assert.match(k.key, /^psk_\d+_[A-Za-z0-9_-]{43}$/);
    const dump = JSON.stringify(t.db.prepare('SELECT * FROM device_key').all()) + JSON.stringify(t.db.prepare('SELECT * FROM audit_log').all());
    assert.ok(!dump.includes(k.key) && !dump.includes(k.key.slice(-43)), 'la cle en clair ne doit jamais etre stockee');
    assert.ok(t.db.prepare('SELECT 1 FROM device_key WHERE key_hash = ?').get(sha256hex(k.key)));
    assert.ok(!('key' in t.keys.list()[0]), 'la liste ne renvoie jamais la cle');
  });

  it('controle : absente, mal formee, inconnue, autre equipement, prefixe, revoquee, rotation avec delai de grace', async () => {
    const t = await setup();
    const k = t.createKey(['D-01', 'E-*']);
    assert.equal(t.keys.check(undefined, 'D-01').ok, false);
    assert.deepEqual(t.keys.check('Bearer n-importe-quoi', 'D-01'), { ok: false, reason: 'malformed', keyId: null });
    assert.equal((t.keys.check(`Bearer ${k.key.slice(0, -1)}${k.key.endsWith('A') ? 'B' : 'A'}`, 'D-01') as { reason: string }).reason, 'unknown');
    assert.equal((t.keys.check(`Bearer ${k.key}`, 'D-02') as { reason: string }).reason, 'scope');
    assert.equal(t.keys.check(`Bearer ${k.key}`, 'E-02').ok, true, 'prefixe E-*');
    assert.equal(t.keys.check(`Bearer ${k.key}`, 'D-01').ok, true);
    const rotated = t.keys.rotate('admin', k.id, { graceMinutes: 10 });
    assert.equal(t.keys.check(`Bearer ${k.key}`, 'D-01').ok, true, 'ancienne cle encore valable pendant le delai de grace');
    assert.equal(t.keys.check(`Bearer ${rotated.key}`, 'D-01').ok, true);
    t.advance(11 * 60_000);
    assert.equal((t.keys.check(`Bearer ${k.key}`, 'D-01') as { reason: string }).reason, 'revoked');
    t.keys.revoke('admin', rotated.id);
    assert.equal((t.keys.check(`Bearer ${rotated.key}`, 'D-01') as { reason: string }).reason, 'revoked');
    assert.throws(() => t.keys.create('admin', { label: 'x', devices: ['*'] }), /prefixe invalide/, '« * » seul (tous les equipements) est refuse');
    assert.ok(t.engine.listAudit(10).some((a) => a.action === 'device_key_rotated'));
  });
});

describe('POST /api/ingest/<id>/image', () => {
  it('succes : image rattachee a l incident ouvert, scellee au journal, visible dans l incident', async () => {
    const t = await setup();
    const k = t.createKey(['D-01']);
    t.alarm('D-01');
    const image = jpeg();
    const res = await t.upload('D-01', k.key, image, {}, '?event=motion');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.attached, true);
    assert.equal(res.body.sha256, sha256hex(image));
    const incident = t.incidentOf('D-01')!;
    const shot = incident.snapshots.find((s) => s.reason === 'device')!;
    assert.ok(shot, "l'image apparait dans l'incident (meme affichage que les cameras liees)");
    assert.equal(shot.cameraId, 'D-01');
    assert.deepEqual(t.snapshots.read(shot.id), image);
    assert.ok(t.published.includes(incident.id), 'les ecrans sont prevenus');
    const seal = t.engine.listAudit(20).find((a) => a.action === 'image_scellee' && a.deviceId === 'D-01')!;
    assert.match(seal.details ?? '', new RegExp(`^image ${shot.id} sha256=${sha256hex(image)} ${image.length} octets .*evenement motion`));
    assert.equal(seal.incidentId, incident.id);
    assert.equal(seal.actor, 'equipement');
    const files = readdirSync(join(t.dataDir, 'snapshots')).filter((f) => f !== 'pending');
    assert.ok(files.every((f) => /^\d+\.(jpg|png)$/.test(f)), `noms generes par le serveur : ${files.join(', ')}`);
  });

  it('PNG accepte (Content-Type image/png)', async () => {
    const t = await setup();
    const k = t.createKey(['D-01']);
    t.alarm('D-01');
    const res = await t.upload('D-01', k.key, png(), { 'Content-Type': 'image/png' });
    assert.equal(res.status, 201);
    const shot = t.incidentOf('D-01')!.snapshots.find((s) => s.reason === 'device')!;
    assert.ok(existsSync(join(t.dataDir, 'snapshots', `${shot.id}.png`)));
  });

  it('mauvaise cle, cle absente, jeton partage, cle revoquee : 401 ; refus journalise sans la cle', async () => {
    const t = await setup();
    const k = t.createKey(['D-01']);
    t.alarm('D-01');
    const forged = `${k.key.slice(0, -4)}${k.key.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
    assert.equal((await t.upload('D-01', forged, jpeg())).status, 401);
    assert.equal((await t.upload('D-01', null, jpeg())).status, 401);
    assert.equal((await t.upload('D-01', 'jeton-partage-0123456789abcdef', jpeg())).status, 401, 'le jeton partage ne vaut pas pour les images');
    t.keys.revoke('admin', k.id);
    const revoked = await t.upload('D-01', k.key, jpeg());
    assert.equal(revoked.status, 401);
    assert.equal(t.incidentOf('D-01')!.snapshots.filter((s) => s.reason === 'device').length, 0);
    const refusals = t.engine.listAudit(50).filter((a) => a.action === 'image_refusee');
    assert.ok(refusals.length >= 1);
    const journal = JSON.stringify(t.db.prepare('SELECT details FROM audit_log').all());
    assert.ok(!journal.includes(forged.slice(4)) && !journal.includes(k.key.slice(4)), 'aucune cle (meme fausse) au journal');
  });

  it("apres 5 echecs d'authentification, l'adresse est bloquee (429) meme avec la bonne cle", async () => {
    const t = await setup();
    const k = t.createKey(['D-01']);
    for (let i = 0; i < 5; i++) assert.equal((await t.upload('D-01', `psk_${k.id}_${'x'.repeat(43)}`, jpeg())).status, 401);
    assert.equal((await t.upload('D-01', k.key, jpeg())).status, 429);
  });

  it("cle d'un autre equipement : 403, rien n'est enregistre ; l'existence du detecteur n'est revelee qu'apres authentification", async () => {
    const t = await setup();
    const k = t.createKey(['D-02']);
    t.alarm('D-01');
    assert.equal((await t.upload('D-01', k.key, jpeg())).status, 403);
    assert.equal((await t.upload('C-01', k.key, jpeg())).status, 403, 'camera : refusee par la portee de la cle');
    assert.equal((await t.upload('NOPE', null, jpeg())).status, 401, 'sans cle : 401, pas 404');
    assert.equal(t.incidentOf('D-01')!.snapshots.length, 0);
    const wide = t.createKey(['D-*']);
    assert.equal((await t.upload('D-99', wide.key, jpeg())).status, 404, 'detecteur inexistant, apres authentification');
  });

  it('image trop grosse : 413 sur Content-Length sans lire le corps, et 413 si le flux depasse', async () => {
    const t = await setup({ maxBytes: 64 * 1024 });
    const k = t.createKey(['D-01']);
    t.alarm('D-01');
    // On annonce 50 Mo sans jamais les envoyer : la reponse arrive quand meme (le serveur n'attend pas le corps).
    const declared = await t.upload('D-01', k.key, null, { 'Content-Length': String(50 * 1024 * 1024) });
    assert.equal(declared.status, 413);
    assert.equal(declared.headers.connection, 'close');
    // Transfert « chunked » (sans Content-Length) qui depasse : coupe au plafond.
    const big = jpeg(640, 480, 200 * 1024);
    const chunked = await t.upload('D-01', k.key, big, { 'Content-Length': '', 'Transfer-Encoding': 'chunked' }).catch((e: NodeJS.ErrnoException) => ({ status: e.code === 'ECONNRESET' || e.code === 'EPIPE' ? 413 : -1, body: null, headers: {} }));
    assert.equal(chunked.status, 413);
    assert.equal(t.incidentOf('D-01')!.snapshots.length, 0);
  });

  it('faux JPEG (texte, HTML) : 415 ; Content-Type mensonger (PNG annonce JPEG) : 415 ; type non image : 415', async () => {
    const t = await setup({ perDevicePerMin: 100 });
    const k = t.createKey(['D-01']);
    t.alarm('D-01');
    assert.equal((await t.upload('D-01', k.key, Buffer.from('<html><script>alert(1)</script></html>'))).status, 415);
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('<script>alert(1)</script>'), Buffer.from([0xff, 0xd9])]);
    assert.equal((await t.upload('D-01', k.key, fake)).status, 415, 'signature JPEG seule, sans structure');
    assert.equal((await t.upload('D-01', k.key, png(), { 'Content-Type': 'image/jpeg' })).status, 415);
    assert.equal((await t.upload('D-01', k.key, jpeg(), { 'Content-Type': 'image/png' })).status, 415);
    assert.equal((await t.upload('D-01', k.key, jpeg(), { 'Content-Type': 'text/html' })).status, 415);
    assert.equal((await t.upload('D-01', k.key, jpeg(), { 'Content-Encoding': 'gzip' })).status, 415, 'aucune decompression cote serveur');
    assert.equal((await t.upload('D-01', k.key, png(100_000, 100_000), { 'Content-Type': 'image/png' })).status, 415, 'image « bombe » refusee sur ses dimensions');
    assert.equal(t.incidentOf('D-01')!.snapshots.length, 0);
  });

  it("debit excessif : par equipement (429) et par adresse (429)", async () => {
    const t = await setup({ perDevicePerMin: 2 });
    const k = t.createKey(['D-01', 'D-02']);
    t.alarm('D-01');
    assert.equal((await t.upload('D-01', k.key, jpeg())).status, 201);
    assert.equal((await t.upload('D-01', k.key, jpeg())).status, 201);
    const third = await t.upload('D-01', k.key, jpeg());
    assert.equal(third.status, 429);
    assert.equal(third.headers['retry-after'], '60');
    t.alarm('D-02');
    assert.equal((await t.upload('D-02', k.key, jpeg())).status, 201, "le debit est compte par equipement");

    const u = await setup({ perIpPerMin: 3 });
    const k2 = u.createKey(['D-01']);
    u.alarm('D-01');
    for (let i = 0; i < 3; i++) assert.notEqual((await u.upload('D-01', k2.key, jpeg())).status, 429);
    assert.equal((await u.upload('D-01', k2.key, jpeg())).status, 429);
  });

  it("un envoi lent n'occupe qu'une place : le meme equipement est refuse (503) tant qu'il n'a pas fini", async () => {
    const t = await setup({ perDevicePerMin: 100 });
    const k = t.createKey(['D-01']);
    t.alarm('D-01');
    const image = jpeg();
    const port = (servers[servers.length - 1].address() as AddressInfo).port;
    const slow = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/ingest/D-01/image', headers: { 'X-Forwarded-For': '10.9.9.9', 'Content-Type': 'image/jpeg', 'Content-Length': String(image.length), Authorization: `Bearer ${k.key}` } });
    const done = new Promise<number>((r) => slow.on('response', (res) => (res.resume(), r(res.statusCode ?? 0))));
    slow.write(image.subarray(0, 10));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await t.upload('D-01', k.key, jpeg())).status, 503);
    slow.end(image.subarray(10));
    assert.equal(await done, 201);
    assert.equal((await t.upload('D-01', k.key, jpeg())).status, 201, 'place liberee');
  });

  it("quota global : les plus anciennes images d'incidents CLOS cedent la place, jamais celles d'un incident en cours (507)", async () => {
    const t = await setup({ quotaCount: 2, perDevicePerMin: 100 });
    const k = t.createKey(['D-*']);
    t.alarm('D-01');
    assert.equal((await t.upload('D-01', k.key, jpeg())).status, 201);
    const firstId = t.incidentOf('D-01')!.snapshots[0].id;
    t.closeIncident('D-01');
    t.alarm('D-02');
    assert.equal((await t.upload('D-02', k.key, jpeg())).status, 201);
    assert.equal((await t.upload('D-02', k.key, jpeg())).status, 201, "l'image de l'incident clos est purgee pour faire de la place");
    assert.equal(t.snapshots.read(firstId), null);
    assert.match(t.engine.listAudit(10).find((a) => a.action === 'images_purgees')?.details ?? '', /quota/);
    const full = await t.upload('D-02', k.key, jpeg());
    assert.equal(full.status, 507, "quota plein d'images d'un incident en cours : refus, rien n'est supprime");
    assert.equal(t.incidentOf('D-02')!.snapshots.length, 2);
    assert.ok(verifyImages(t.db, t.dataDir).ok, 'la purge de quota est tracee : la verification reste integre');
  });

  it("plafond par incident : 409 au-dela, et les images d'equipement ne consomment pas le plafond des cameras liees", async () => {
    const t = await setup({ maxPerIncident: 2, perDevicePerMin: 100 });
    const k = t.createKey(['D-01']);
    t.alarm('D-01');
    assert.equal((await t.upload('D-01', k.key, jpeg())).status, 201);
    assert.equal((await t.upload('D-01', k.key, jpeg())).status, 201);
    assert.equal((await t.upload('D-01', k.key, jpeg())).status, 409);
  });

  it("sans incident ouvert : image mise en attente (202), rattachee si un incident s'ouvre dans le delai, sinon supprimee", async () => {
    const t = await setup({ pendingS: 300 });
    const k = t.createKey(['D-01', 'D-02']);
    const image = jpeg(800, 600);
    const res = await t.upload('D-01', k.key, image);
    assert.equal(res.status, 202);
    assert.equal(res.body.attached, false);
    assert.ok(t.engine.listAudit(5).some((a) => a.action === 'image_en_attente' && (a.details ?? '').includes(sha256hex(image))), "l'arrivee est scellee meme en attente");
    t.advance(60_000);
    t.alarm('D-01'); // l'alarme arrive apres la photo
    const shots = t.incidentOf('D-01')!.snapshots.filter((s) => s.reason === 'device');
    assert.equal(shots.length, 1);
    assert.deepEqual(t.snapshots.read(shots[0].id), image);
    assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM device_image_pending').get() as { n: number }).n, 0);
    assert.deepEqual(readdirSync(join(t.dataDir, 'snapshots', 'pending')), []);

    // Trop tard : la fenetre est passee, l'image n'est pas rattachee et finit supprimee.
    assert.equal((await t.upload('D-02', k.key, jpeg())).status, 202);
    t.advance(301_000);
    t.alarm('D-02');
    assert.equal(t.incidentOf('D-02')!.snapshots.filter((s) => s.reason === 'device').length, 0);
    assert.equal(t.images.expirePending(), 1);
    assert.deepEqual(readdirSync(join(t.dataDir, 'snapshots', 'pending')), []);
    assert.ok(verifyImages(t.db, t.dataDir).ok);
  });

  it("une image en attente modifiee sur le disque n'est pas rattachee (empreinte differente)", async () => {
    const t = await setup();
    const k = t.createKey(['D-01']);
    assert.equal((await t.upload('D-01', k.key, jpeg())).status, 202);
    const [file] = readdirSync(join(t.dataDir, 'snapshots', 'pending'));
    const path = join(t.dataDir, 'snapshots', 'pending', file);
    const data = readFileSync(path);
    data[30] ^= 0xff;
    writeFileSync(path, data);
    t.alarm('D-01');
    assert.equal(t.incidentOf('D-01')!.snapshots.filter((s) => s.reason === 'device').length, 0);
    assert.match(t.engine.listAudit(10).find((a) => a.action === 'image_refusee')?.details ?? '', /MODIFIEE/);
  });

  it('sans attente configuree (0) : 409 hors incident', async () => {
    const t = await setup({ pendingS: 0 });
    const k = t.createKey(['D-01']);
    assert.equal((await t.upload('D-01', k.key, jpeg())).status, 409);
  });

  it('identifiants hostiles dans le chemin : 4xx, jamais de fichier hors du dossier', async () => {
    const t = await setup();
    const k = t.createKey(['D-01']);
    for (const id of ['..%2f..%2fetc', '%00', 'x'.repeat(200), '__proto__', "D-01'--"]) {
      const res = await t.upload(id, k.key, jpeg());
      assert.ok(res.status >= 400 && res.status < 500, `${id.slice(0, 20)} : ${res.status}`);
    }
    assert.ok(readdirSync(join(t.dataDir, 'snapshots')).every((f) => f === 'pending'));
  });
});

describe('scellement et verification des images', () => {
  it("modifier un octet d'une image (camera liee ou equipement) est detecte ; un fichier manquant aussi", async () => {
    const t = await setup();
    t.db.prepare("UPDATE device SET stream_kind = 'rtsp' WHERE id = 'C-01'").run();
    const k = t.createKey(['D-01']);
    t.alarm('D-01');
    await t.snapshots.capture(t.incidentOf('D-01')!, 'opened'); // camera liee : meme point de scellement
    assert.equal((await t.upload('D-01', k.key, jpeg())).status, 201);
    const shots = t.incidentOf('D-01')!.snapshots;
    const camera = shots.find((s) => s.reason === 'opened')!;
    const device = shots.find((s) => s.reason === 'device')!;
    assert.ok(camera && device);
    assert.ok(t.engine.listAudit(20).some((a) => a.action === 'image_scellee' && a.actor === 'systeme' && (a.details ?? '').startsWith(`image ${camera.id} sha256=`)), 'image de camera liee scellee');
    const ok = verifyImages(t.db, t.dataDir);
    assert.ok(ok.ok, JSON.stringify(ok.problems));
    assert.equal(ok.checked, shots.length);

    const path = join(t.dataDir, 'snapshots', `${device.id}.jpg`);
    const data = readFileSync(path);
    data[25] ^= 0x01; // un seul octet
    writeFileSync(path, data);
    unlinkSync(join(t.dataDir, 'snapshots', `${camera.id}.jpg`));
    const broken = verifyImages(t.db, t.dataDir);
    assert.equal(broken.ok, false);
    assert.ok(broken.problems.some((p) => p.includes(`image n°${device.id}`) && p.includes('MODIFIE')), broken.problems.join('\n'));
    assert.ok(broken.problems.some((p) => p.includes(`image n°${camera.id}`) && p.includes('MANQUANT')), broken.problems.join('\n'));
    assert.ok(verify(t.db).ok, 'la chaine du journal elle-meme reste intacte');
  });

  it("empreinte modifiee en base, image supprimee hors purge, image ajoutee hors du PSIM : detectees", async () => {
    const t = await setup();
    const k = t.createKey(['D-01']);
    t.alarm('D-01');
    await t.upload('D-01', k.key, jpeg());
    await t.upload('D-01', k.key, jpeg(320, 200));
    const [a, b] = t.incidentOf('D-01')!.snapshots;
    // Remplacement « coherent » du fichier ET de l'empreinte en base : le journal scelle l'ancienne.
    const other = jpeg(1024, 768);
    writeFileSync(join(t.dataDir, 'snapshots', `${a.id}.jpg`), other);
    t.db.prepare('UPDATE incident_snapshot SET sha256 = ?, bytes = ? WHERE id = ?').run(sha256hex(other), other.length, a.id);
    t.db.prepare('DELETE FROM incident_snapshot WHERE id = ?').run(b.id);
    t.db.prepare("INSERT INTO incident_snapshot (incident_id, camera_id, taken_at, reason, file, source, sha256, bytes) VALUES (?, 'D-01', 0, 'device', '999.jpg', 'device', ?, 1)").run(t.incidentOf('D-01')!.id, sha256hex('x'));
    const r = verifyImages(t.db, t.dataDir);
    assert.ok(r.problems.some((p) => p.includes(`image n°${a.id} : empreinte modifiee en base`)), r.problems.join('\n'));
    assert.ok(r.problems.some((p) => p.includes(`image n°${b.id} : supprimee sans entree de purge`)), r.problems.join('\n'));
    assert.ok(r.problems.some((p) => p.includes('aucune entree scellee au journal')), r.problems.join('\n'));
  });

  it('npm run verify-journal -- --images : code 1 sur une image modifiee, 0 sinon', async () => {
    const t = await setup();
    const k = t.createKey(['D-01']);
    t.alarm('D-01');
    await t.upload('D-01', k.key, jpeg());
    const dbPath = join(t.dataDir, 'psim.db');
    t.db.prepare('VACUUM INTO ?').run(dbPath);
    const { main } = await import('../scripts/verify-journal.ts');
    const log = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => void lines.push(a.join(' '));
    try {
      assert.equal(await main(['--db', dbPath, '--images']), 0, lines.join('\n'));
      const shot = t.incidentOf('D-01')!.snapshots[0];
      const path = join(t.dataDir, 'snapshots', `${shot.id}.jpg`);
      const data = readFileSync(path);
      data[data.length - 3] ^= 0x10;
      writeFileSync(path, data);
      assert.equal(await main(['--db', dbPath, '--images']), 1);
      assert.equal(await main(['--db', dbPath]), 0, 'sans --images : seule la chaine est verifiee');
    } finally {
      console.log = log;
    }
    assert.ok(lines.some((l) => l.includes('MODIFIE')), lines.join('\n'));
  });

  it('les sauvegardes contiennent les images (JPEG et PNG), pas les images en attente', async () => {
    const t = await setup();
    const k = t.createKey(['D-01', 'D-02']);
    t.alarm('D-01');
    await t.upload('D-01', k.key, jpeg());
    await t.upload('D-01', k.key, png(), { 'Content-Type': 'image/png' });
    await t.upload('D-02', k.key, jpeg()); // en attente
    const backupDir = mkdtempSync(join(tmpdir(), 'psim-devimg-bk-'));
    const result = createBackup({ db: t.db, dataDir: t.dataDir, backupDir });
    const check = verifyBackup(result.dir);
    assert.ok(check.ok, check.problems.join('\n'));
    const paths = check.manifest!.files.map((f) => f.path);
    for (const s of t.incidentOf('D-01')!.snapshots) assert.ok(paths.some((p) => p === `snapshots/${s.id}.jpg` || p === `snapshots/${s.id}.png`), paths.join(','));
    assert.ok(!paths.some((p) => p.includes('pending')));
  });
});

describe('controle de demarrage', () => {
  const GOOD: PreflightInput = {
    production: true, host: '127.0.0.1', mqttHost: '127.0.0.1', tlsEnabled: false, mqttTlsEnabled: false, trustProxy: false, cookieSecure: false,
    simEnabled: false, demoLogin: false, adminPassword: 'Un-vrai-mot-de-passe-1', operatorPassword: 'Un-autre-mot-de-passe-2', mqttPassword: 'Mot-de-passe-MQTT-3',
    notificationChannels: 2, escalationConfigured: true, detectorTimeoutS: 180, backupEveryH: 24, requireTotp: 'admin', heartbeatUrl: 'https://hc-ping.com/abc',
  };
  const said = (d: PreflightInput['deviceImages']) => preflight({ ...GOOD, deviceImages: d }).map((f) => `${f.level}:${f.message}`).join(' | ');
  it('valeurs par defaut : rien a dire ; quota plus petit qu une image : erreur ; quota en nombre trop bas : avertissement', () => {
    assert.equal(said({ maxBytes: 2 << 20, quotaBytes: 500 << 20, quotaCount: 5000, maxPerIncident: 20 }), '');
    assert.match(said({ maxBytes: 2 << 20, quotaBytes: 1 << 20, quotaCount: 5000, maxPerIncident: 20 }), /^error:PSIM_DEVICE_IMAGE_QUOTA_MB/);
    assert.match(said({ maxBytes: 2 << 20, quotaBytes: 500 << 20, quotaCount: 10, maxPerIncident: 20 }), /^warn:PSIM_DEVICE_IMAGE_QUOTA_COUNT/);
  });
});

describe('base ancienne et vie privee', () => {
  it("une base d'avant le scellement est migree sans perte (et deux fois sans effet) ; ses images restent lisibles, non protegees", () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-devimg-old-'));
    const path = join(dir, 'psim.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE incident_snapshot (id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER NOT NULL, camera_id TEXT NOT NULL, taken_at INTEGER NOT NULL, reason TEXT NOT NULL, file TEXT NOT NULL);
      INSERT INTO incident_snapshot (incident_id, camera_id, taken_at, reason, file) VALUES (7, 'C-01', 1000, 'opened', '1.jpg');`);
    old.close();
    for (let i = 0; i < 2; i++) {
      const db = openDb(path);
      const row = db.prepare('SELECT * FROM incident_snapshot WHERE id = 1').get() as Record<string, unknown>;
      assert.equal(row.camera_id, 'C-01');
      assert.equal(row.source, 'camera');
      assert.equal(row.sha256, null);
      for (const table of ['device_key', 'device_image_pending']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table), table);
      const r = verifyImages(db, dir);
      assert.equal(r.ok, true);
      assert.equal(r.unprotected, 1);
      db.close();
    }
  });

  it('verification sur une base non migree (lecture seule, sauvegarde ancienne) : pas d erreur', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE incident_snapshot (id INTEGER PRIMARY KEY, incident_id INTEGER, camera_id TEXT, taken_at INTEGER, reason TEXT, file TEXT);
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY, ts INTEGER, actor TEXT, action TEXT, incident_id INTEGER, device_id TEXT, details TEXT, prev_hash TEXT, hash TEXT);
      INSERT INTO incident_snapshot VALUES (1, 1, 'C-01', 0, 'opened', '1.jpg');`);
    const r = verifyImages(db, tmpdir());
    assert.equal(r.ok, true);
    assert.equal(r.unprotected, 1);
  });

  it("le resume envoye au portail ne contient AUCUNE image ni reference d'image", async () => {
    const t = await setup();
    const k = t.createKey(['D-01']);
    t.alarm('D-01');
    const image = jpeg(640, 480, 300);
    assert.equal((await t.upload('D-01', k.key, image)).status, 201);
    const shot = t.incidentOf('D-01')!.snapshots[0];
    const summary = JSON.stringify(buildSiteSummary(t.db, { siteId: 'site-test', version: '0', startedAt: Date.now() }));
    assert.ok(summary.includes('D-01'), 'le resume parle bien de cet incident');
    for (const forbidden of [sha256hex(image), image.toString('base64').slice(0, 40), image.toString('hex').slice(0, 40), `${shot.id}.jpg`, 'snapshot', '/api/snapshots', 'image_scellee', 'sha256']) {
      assert.ok(!summary.includes(forbidden), `le resume du portail ne doit pas contenir « ${forbidden} »`);
    }
  });
});
