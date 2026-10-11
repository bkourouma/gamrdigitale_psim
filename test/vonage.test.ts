/**
 * Appel telephonique (Vonage, API Voice), contre un faux service local (aucun appel reel n'est passe) : format de l'appel,
 * jeton signe, texte lu, erreurs en clair, cle jamais revelee, appels reserves aux alarmes, destinataires de l'interface,
 * migration de la base, configuration stricte du .env, controle de mise en service.
 */
import assert from 'node:assert/strict';
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { checkVonage } from '../scripts/commission/checks.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { createNotifier, spokenText, vonageChannel, vonageToken } from '../server/notifications.ts';
import type { Message, VonageConfig } from '../server/notifications.ts';
import { createRecipientsService } from '../server/recipients.ts';
import { seedDemo } from '../server/seed.ts';

const ROOT = resolve(import.meta.dirname, '..');
const PHONE = '+2250700000042';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const message: Message = {
  kind: 'opened',
  incidentId: 7,
  subject: '[PSIM] ALARME - a confirmer - Fumee sejour',
  text: 'ALARME - Fumee sejour\nZone : RDC - Sejour',
  data: { zone: 'RDC - Sejour', floor: 'Rez-de-chaussée' },
};

interface Seen {
  method: string;
  path: string;
  auth: string;
  body: any;
}

/** Faux service HTTP : enregistre chaque requete, repond ce qu'on lui dit. */
function fakeService() {
  const seen: Seen[] = [];
  let reply: { status: number; body: string } = { status: 201, body: '{}' };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', path: req.url ?? '', auth: String(req.headers.authorization ?? ''), body: raw ? JSON.parse(raw) : null });
      res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(reply.body);
    });
  });
  return {
    seen,
    reply: (status: number, body: unknown) => (reply = { status, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    start: () => new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    stop: () => server.close(),
  };
}

describe('Appel vocal Vonage, faux service local', () => {
  const vonage = fakeService();
  let cfg: VonageConfig;
  before(async () => {
    cfg = { apiBase: `${await vonage.start()}/`, applicationId: 'app-1234', privateKey, from: '14155550100', language: 'fr-FR' };
  });
  after(() => vonage.stop());
  const started = () => vonage.reply(201, { uuid: 'abc-123', status: 'started', direction: 'outbound', conversation_uuid: 'CON-1' });

  it("lance l'appel : POST /v1/calls, numero sans « + », message lu deux fois en francais, jeton signe par la cle de l'application", async () => {
    started();
    const channel = vonageChannel(cfg, [[PHONE, '0700000042', '+225 07'], []])!;
    assert.equal(channel.id, 'vonage');
    assert.deepEqual(channel.recipients(1), [PHONE], 'seuls les numeros internationaux sans espace sont gardes');
    await channel.send(message, PHONE);
    const req = vonage.seen.at(-1)!;
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/v1/calls');
    assert.deepEqual(req.body.to, [{ type: 'phone', number: '2250700000042' }]);
    assert.deepEqual(req.body.from, { type: 'phone', number: '14155550100' });
    assert.equal(req.body.ncco.length, 1);
    assert.deepEqual({ ...req.body.ncco[0], text: undefined }, { action: 'talk', text: undefined, language: 'fr-FR', loop: 2 });
    assert.equal(req.body.ncco[0].text, 'Alerte P S I M. alarme, a confirmer, fumee sejour. Lieu : rdc, sejour, rez-de-chaussée. Ouvrez le P S I M pour traiter l\'alarme.');

    const [head, payload, signature] = req.auth.replace('Bearer ', '').split('.');
    assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url').toString()), { typ: 'JWT', alg: 'RS256' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(claims.application_id, 'app-1234');
    assert.equal(claims.exp - claims.iat, 300);
    assert.ok(claims.jti);
    assert.ok(createVerify('RSA-SHA256').update(`${head}.${payload}`).verify(createPublicKey(publicKey), Buffer.from(signature, 'base64url')), 'signature valide avec la cle publique');
  });

  it("ne sonne que pour une alarme, son escalade et l'essai : jamais pour un redemarrage, une alerte de compte ou un journal altere", () => {
    const channel = vonageChannel(cfg, [[PHONE], []])!;
    for (const kind of ['opened', 'escalated', 'unacked', 'reminder', 'test'] as const) assert.equal(channel.accepts!(kind), true, kind);
    for (const kind of ['confirmed', 'silent', 'restart', 'integrity', 'security'] as const) assert.equal(channel.accepts!(kind), false, kind);
    assert.equal(channel.sendImages, undefined);
  });

  it("texte lu : sans majuscules ni balisage, borne ; l'essai dit qu'aucune action n'est requise", () => {
    assert.match(spokenText({ ...message, subject: '[PSIM] ALARME - <speak>Fumee & co</speak>' }), /^Alerte P S I M\. alarme, speak fumee co \/speak\./);
    assert.ok(!/[<>&"]/.test(spokenText({ ...message, data: { zone: '<break/>' } })));
    assert.ok(spokenText({ ...message, subject: `[PSIM] ${'X'.repeat(900)}` }).length <= 400);
    assert.match(spokenText({ ...message, kind: 'test' }), /appel de test.*Aucune action/);
    assert.ok(!/Lieu/.test(spokenText({ ...message, data: {} })), 'sans lieu, pas de lieu invente');
  });

  it("echecs expliques en clair (identifiants, credit, numero, debit, service) ; ni le jeton ni la cle n'apparaissent", async () => {
    const channel = vonageChannel(cfg, [[PHONE], []])!;
    const cases: [number, unknown, RegExp][] = [
      [401, { title: 'Unauthorized' }, /Vonage HTTP 401 : identifiants refuses/],
      [402, { title: 'Payment' }, /Vonage HTTP 402 : credit Vonage insuffisant/],
      [422, { title: 'Unprocessable' }, /Vonage HTTP 422 : appel refuse/],
      [429, {}, /Vonage HTTP 429 : trop d'appels/],
      [500, '', /Vonage HTTP 500 : Vonage indisponible/],
      [400, { title: 'Bad request', detail: 'Invalid NCCO' }, /Vonage HTTP 400 : Invalid NCCO/],
    ];
    for (const [status, body, expected] of cases) {
      vonage.reply(status, body);
      await assert.rejects(channel.send(message, PHONE), (err: Error) => expected.test(err.message) && !err.message.includes('PRIVATE'));
    }
    vonage.reply(201, {});
    await assert.rejects(channel.send(message, PHONE), /sans identifiant d'appel/);
    const down = vonageChannel({ ...cfg, apiBase: 'http://127.0.0.1:1' }, [[PHONE], []])!;
    await assert.rejects(down.send(message, PHONE), (err: Error) => err.message === 'Vonage injoignable');
    await assert.rejects(vonageChannel({ ...cfg, privateKey: 'pas une cle' }, [[PHONE], []])!.send(message, PHONE), (err: Error) => /cle privee illisible/.test(err.message) && !err.message.includes('pas une cle'));
    assert.equal(vonageChannel({ ...cfg, privateKey: '' }, [[PHONE], []]), null, 'sans cle : canal absent');
    assert.equal(vonageChannel({ ...cfg, from: '' }, [[PHONE], []]), null);
    assert.ok(vonageToken(cfg, 0).split('.').length === 3);
  });

  it("le notificateur appelle pour une alarme, pas pour un redemarrage ; l'essai appelle chaque destinataire", async () => {
    const db = openDb(':memory:');
    seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-vonage-')), join(ROOT, 'seed'));
    const engine = createEngine(db, () => {});
    const channel = vonageChannel(cfg, [[PHONE], ['+2250500000001']])!;
    const notifier = createNotifier({ db, engine, channels: [channel], escalateAfterMs: 0, reminderMs: 0, maxReminders: 0, retryDelaysMs: [0], secrets: [] });
    started();
    const before = vonage.seen.length;
    await notifier.notifyRestart({ from: 0, to: 60_000, durationMs: 60_000, clean: false }, 0);
    await notifier.notifySecurity('admin', 'user_created', 'x');
    assert.equal(vonage.seen.length, before, 'aucun appel pour un redemarrage ni une alerte de securite');
    engine.handleDetectorMessage('D-01', { state: 'alarm' });
    await notifier.notifyIncident(engine.getSnapshot().incidents.find((i) => i.detectorId === 'D-01')!, 'opened');
    assert.equal(vonage.seen.length, before + 1, 'un appel pour une alarme, au niveau 1');
    assert.equal(vonage.seen.at(-1)!.body.to[0].number, '2250700000042');
    const results = await notifier.test();
    assert.deepEqual(results.map((r) => [r.ok, r.level]).sort(), [[true, 1], [true, 2]]);
    assert.equal(vonage.seen.length, before + 3);
    assert.match(vonage.seen.at(-1)!.body.ncco[0].text, /appel de test/);
  });

  it("mise en service : sans --vonage-to on verifie les identifiants sans appeler ; avec, un seul appel de test", async () => {
    started();
    assert.equal((await checkVonage({ ...cfg, applicationId: '', privateKey: '' }, [[], []])).status, 'skip');
    assert.equal((await checkVonage({ ...cfg, applicationId: '', privateKey: '' }, [[PHONE], []])).status, 'fail', 'destinataires sans canal configure');
    const before = vonage.seen.length;
    const probe = await checkVonage(cfg, [[PHONE], []]);
    assert.equal(probe.status, 'ok');
    assert.match(probe.detail, /identifiants acceptes ; 1 destinataire\(s\) ; aucun appel passe/);
    assert.equal(vonage.seen.at(-1)!.method, 'GET');
    assert.equal(vonage.seen.length, before + 1);
    assert.equal((await checkVonage(cfg, [[], []])).status, 'warn', 'identifiants bons mais personne a appeler');
    vonage.reply(401, { title: 'Unauthorized' });
    assert.match((await checkVonage(cfg, [[PHONE], []])).detail, /Vonage refuse l'application \(HTTP 401\)/);
    started();
    const calls = vonage.seen.length;
    const test = await checkVonage(cfg, [[], []], { to: PHONE });
    assert.equal(test.status, 'ok');
    assert.match(test.detail, /appel de test lance vers \+225\.\.\.42/);
    assert.equal(vonage.seen.filter((s) => s.method === 'POST').length, vonage.seen.slice(0, calls).filter((s) => s.method === 'POST').length + 1, 'un seul appel');
    assert.equal((await checkVonage(cfg, [[], []], { to: '0700000042' })).status, 'fail');
    assert.equal((await checkVonage({ ...cfg, apiBase: 'http://127.0.0.1:1' }, [[PHONE], []])).status, 'fail');
  });
});

describe('Appel vocal : destinataires, base et configuration', () => {
  const service = (available: boolean) =>
    createRecipientsService({
      db: openDb(':memory:'),
      audit: () => {},
      env: { email: [[], []], telegram: [[], []], whatsapp: [[], []], callmebot: [[], []], vonage: [[PHONE], []], webhook: [[], []] },
      available: { email: true, telegram: true, whatsapp: false, callmebot: false, vonage: available, webhook: true },
    });

  it("l'interface ajoute des numeros d'appel (canal configure), refuse un numero mal ecrit ou un canal non regle", () => {
    const svc = service(true);
    const added = svc.add('admin', { channel: 'vonage', address: '+2250500000099', level: 2, label: 'Astreinte' });
    assert.deepEqual([added.channel, added.display, added.level, added.source], ['vonage', '+225...99', 2, 'db']);
    assert.deepEqual(svc.effective('vonage', 1), [PHONE]);
    assert.deepEqual(svc.effective('vonage', 2), ['+2250500000099']);
    assert.throws(() => svc.add('admin', { channel: 'vonage', address: '07 00 00 00 99', level: 1 }), /format international/);
    assert.throws(() => service(false).add('admin', { channel: 'vonage', address: '+2250500000099', level: 1 }), /PSIM_VONAGE_APPLICATION_ID, PSIM_VONAGE_PRIVATE_KEY_FILE et PSIM_VONAGE_FROM/);
  });

  it("une base qui a deja WhatsApp et les zones accepte ensuite les appels, sans rien perdre (identifiants, zones)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-vonage-db-'));
    const path = join(dir, 'psim.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE notification_recipient (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL CHECK (channel IN ('email', 'telegram', 'whatsapp', 'webhook')),
      address TEXT NOT NULL, level INTEGER NOT NULL CHECK (level IN (1, 2)), label TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, created_by TEXT NOT NULL, zones TEXT, UNIQUE (channel, address, level));
      INSERT INTO notification_recipient (id, channel, address, level, label, active, created_at, created_by, zones) VALUES (5, 'whatsapp', '${PHONE}', 1, 'Gardien', 1, 1, 'admin', '["Portail"]');`);
    old.close();
    const db = openDb(path);
    assert.deepEqual({ ...(db.prepare('SELECT id, channel, label, zones FROM notification_recipient').get() as object) }, { id: 5, channel: 'whatsapp', label: 'Gardien', zones: '["Portail"]' });
    db.prepare("INSERT INTO notification_recipient (channel, address, level, label, active, created_at, created_by) VALUES ('vonage', ?, 1, '', 1, 2, 'admin')").run(PHONE);
    assert.equal((db.prepare("SELECT id FROM notification_recipient WHERE channel = 'vonage'").get() as { id: number }).id, 6, 'la numerotation continue');
    assert.throws(() => db.prepare("INSERT INTO notification_recipient (channel, address, level, label, active, created_at, created_by) VALUES ('fax', 'x', 1, '', 1, 2, 'a')").run(), /CHECK/);
    db.close();
    openDb(path).close(); // deja migree : rien a refaire
  });

  it(".env : numero mal ecrit, trio incomplet ou cle illisible bloquent le demarrage, sans jamais citer la cle ; un reglage complet passe", () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-vonage-env-'));
    const keyFile = join(dir, 'private.key');
    writeFileSync(keyFile, privateKey);
    writeFileSync(join(dir, 'garbage.key'), 'pas une cle - SECRET-VONAGE');
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./server/config.ts')"], {
        cwd: ROOT,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
        encoding: 'utf8',
      });
    const full = { PSIM_VONAGE_APPLICATION_ID: 'app-1', PSIM_VONAGE_PRIVATE_KEY_FILE: keyFile, PSIM_VONAGE_FROM: '+14155550100' };
    assert.equal(run({ ...full, PSIM_NOTIFY_VONAGE_L1: `${PHONE},+33612345678` }).status, 0);
    assert.equal(run({}).status, 0, 'sans rien : pas de canal');
    assert.match(run({ ...full, PSIM_NOTIFY_VONAGE_L1: `${PHONE},0700000042` }).stderr, /PSIM_NOTIFY_VONAGE_L1 : l'entree n°2 est invalide/);
    assert.match(run({ PSIM_VONAGE_APPLICATION_ID: 'app-1' }).stderr, /vont ensemble/);
    assert.match(run({ ...full, PSIM_VONAGE_FROM: 'abc' }).stderr, /PSIM_VONAGE_FROM est invalide/);
    assert.match(run({ ...full, PSIM_VONAGE_LANG: 'francais' }).stderr, /PSIM_VONAGE_LANG/);
    const missing = run({ ...full, PSIM_VONAGE_PRIVATE_KEY_FILE: join(dir, 'absent.key') });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /PSIM_VONAGE_PRIVATE_KEY_FILE : fichier introuvable/);
    const garbage = run({ ...full, PSIM_VONAGE_PRIVATE_KEY_FILE: join(dir, 'garbage.key') });
    assert.notEqual(garbage.status, 0);
    assert.ok(!garbage.stderr.includes('SECRET-VONAGE'), 'le contenu du fichier n\'est jamais cite');
  });
});
