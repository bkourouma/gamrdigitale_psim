/**
 * Regle « mouvement devant le portail la nuit -> prevenir le gardien » : evenements d'un faux enregistreur Dahua
 * (authentification Digest, flux multipart) traduits en alarmes d'un detecteur d'intrusion (armement compris), et
 * destinataires limites a une zone. Aucun appareil reel n'est contacte.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { authorization, createDahuaEvents, createPartParser, parseChallenge, parseEventPart } from '../server/dahua.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { buildChannels, createNotifier, maskPhone } from '../server/notifications.ts';
import type { Channel, Message } from '../server/notifications.ts';
import { createRecipientsService, inScope } from '../server/recipients.ts';
import { seal } from '../server/secrets.ts';
import { seedDemo } from '../server/seed.ts';
import { checkInventory } from '../scripts/commission/checks.ts';

const ROOT = resolve(import.meta.dirname, '..');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('delai depasse');
    await wait(20);
  }
}

describe('Dahua : lecture du flux', () => {
  it("evenement « Code=...;action=...;index=... » -> voie a partir de 1 ; un Heartbeat n'est pas un evenement", () => {
    assert.deepEqual(parseEventPart('Code=SmartMotionHuman;action=Start;index=0;data={\n "RegionName": ["Portail"]\n}'), { code: 'SmartMotionHuman', action: 'Start', channel: 1 });
    assert.deepEqual(parseEventPart('Code=VideoMotion;action=Stop;index=7'), { code: 'VideoMotion', action: 'Stop', channel: 8 });
    assert.equal(parseEventPart('Heartbeat'), null);
  });

  it("parties decoupees n'importe ou : chacune livree des qu'elle est complete (Content-Length), sans attendre la suivante", () => {
    const parts: string[] = [];
    const parse = createPartParser('myboundary', (b) => parts.push(b.trim()));
    const part = (body: string) => `--myboundary\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const stream = Buffer.from(part('Heartbeat') + part('Code=SmartMotionHuman;action=Start;index=2') + part('Code=Ça;action=Stop;index=0'));
    for (let i = 0; i < stream.length; i += 7) parse(stream.subarray(i, i + 7));
    assert.deepEqual(parts, ['Heartbeat', 'Code=SmartMotionHuman;action=Start;index=2', 'Code=Ça;action=Stop;index=0']);
    const noLength: string[] = [];
    const parse2 = createPartParser('--b', (b) => noLength.push(b.trim()));
    parse2(Buffer.from('--b\r\n\r\nA\r\n--b\r\n\r\nB\r\n'));
    assert.deepEqual(noLength, ['A'], 'sans Content-Length : la partie se termine a la frontiere suivante');
  });

  it("authentification Digest : reponse conforme a la RFC 2617 (exemple de reference) ; Basic refuse (mot de passe en clair)", () => {
    const header = 'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"';
    assert.equal(parseChallenge(header).params.realm, 'testrealm@host.com');
    const auth = authorization(header, 'Mufasa', 'Circle Of Life', '/dir/index.html', '0a4f113b');
    assert.match(auth, /response="6629fae49393a05397450978507c4ef1"/);
    assert.match(auth, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
    assert.match(auth, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
    assert.throws(() => authorization('Basic realm="x"', 'u', 'p', '/'), /en clair \(Basic\) : refusee/);
  });

  it("plusieurs defis : MD5 choisi (celui des Dahua), sinon SHA-256 calcule comme tel ; algorithme inconnu ou utilisateur accentue : refus explique, sans plantage", () => {
    const md5 = (s: string) => createHash('md5').update(s).digest('hex');
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    const two = ['Digest realm="R", qop="auth", algorithm=SHA-256, nonce="n-sha"', 'Digest realm="R", qop="auth", algorithm=MD5, nonce="n-md5"'];
    const auth = authorization(two, 'u', 'p', '/x', 'c');
    assert.match(auth, /nonce="n-md5"/);
    assert.match(auth, new RegExp(`response="${md5(`${md5('u:R:p')}:n-md5:00000001:c:auth:${md5('GET:/x')}`)}"`));
    const shaOnly = authorization('Digest realm="R", qop="auth", algorithm=SHA-256, nonce="n"', 'u', 'p', '/x', 'c');
    assert.match(shaOnly, new RegExp(`response="${sha(`${sha('u:R:p')}:n:00000001:c:auth:${sha('GET:/x')}`)}"`));
    const sess = authorization('Digest realm="R", qop="auth", algorithm=MD5-sess, nonce="n"', 'u', 'p', '/x', 'c');
    assert.match(sess, new RegExp(`response="${md5(`${md5(`${md5('u:R:p')}:n:c`)}:n:00000001:c:auth:${md5('GET:/x')}`)}"`));
    assert.throws(() => authorization('Digest realm="R", algorithm=SHA-512-256, nonce="n"', 'u', 'p', '/'), /algorithme d'authentification non pris en charge/);
    assert.throws(() => authorization('Digest realm="R", nonce="n"', 'gardien€', 'p', '/'), /nom d'utilisateur/);
    assert.throws(() => authorization('Digest realm="R", nonce="n"', 'a"b', 'p', '/'), /nom d'utilisateur/);
  });
});

// ---------------------------------------------------------------- faux enregistreur Dahua

const USER = 'psim';
const PASSWORD = 'MotDePasse-XVR-1';

function fakeRecorder() {
  const md5 = (s: string) => createHash('md5').update(s).digest('hex');
  const realm = 'Login to XVR';
  const nonce = randomBytes(8).toString('hex');
  let password = PASSWORD;
  // 'html' : un autre appareil qui repond « 200 » avec sa page ; 'basic' : un appareil qui demande Basic.
  let mode: 'dahua' | 'html' | 'basic' = 'dahua';
  const streams = new Set<ServerResponse>();
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    if (mode === 'html') return void res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>Connexion</html>');
    if (mode === 'basic' && !req.headers.authorization) return void res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="cam"' }).end();
    const auth = String(req.headers.authorization ?? '');
    const p = Object.fromEntries([...auth.matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1], m[2]]));
    const expected = md5(`${md5(`${USER}:${realm}:${password}`)}:${nonce}:${p.nc}:${p.cnonce}:auth:${md5(`GET:${p.uri}`)}`);
    if (!auth.startsWith('Digest') || p.username !== USER || p.response !== expected || p.uri !== req.url) {
      res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}", opaque="abc"` }).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=myboundary' });
    streams.add(res);
    res.on('close', () => streams.delete(res));
    send(res, 'Heartbeat');
  });
  const send = (res: ServerResponse, body: string) => res.write(`--myboundary\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  return {
    start: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port))),
    stop: () => {
      for (const s of streams) s.destroy();
      server.close();
    },
    emit: (body: string) => streams.forEach((s) => send(s, body)),
    cut: () => streams.forEach((s) => s.destroy()),
    connected: () => streams.size,
    requests: () => requests,
    setPassword: (p: string) => (password = p),
    setMode: (m: typeof mode) => (mode = m),
  };
}

describe('Dahua : regle « mouvement au portail la nuit »', () => {
  const xvr = fakeRecorder();
  let port = 0;
  before(async () => {
    port = await xvr.start();
  });
  after(() => xvr.stop());

  function setup(opts: { armed?: (zone: string) => boolean; password?: string; user?: string; aliveEveryMs?: number } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'psim-dahua-'));
    const db = openDb(join(dir, 'psim.db'));
    seedDemo(db, dir, join(ROOT, 'seed'));
    const key = randomBytes(32);
    db.prepare("INSERT INTO camera_source (device_id, kind, host, port, rtsp_path, username, secret) VALUES ('C-01', 'rtsp', '127.0.0.1', 554, '/cam/realmonitor?channel=1&subtype=1', ?, ?)").run(opts.user ?? USER, seal(key, opts.password ?? PASSWORD));
    const audits: string[] = [];
    const isArmed = opts.armed ?? (() => true);
    const engine = createEngine(db, () => {}, Date.now, { isArmed });
    const realAudit = engine.audit;
    const dahua = createDahuaEvents({ db, engine: { ...engine, audit: (a, b, c) => (audits.push(`${b}:${c?.details ?? ''}`), realAudit(a, b, c)) }, key, log: () => {}, isArmed, aliveEveryMs: opts.aliveEveryMs });
    const incidents = () => engine.getSnapshot().incidents.filter((i) => i.detectorId === 'I-01' && i.status !== 'closed');
    return { db, engine, dahua, audits, incidents, status: () => engine.getDevice('I-01')!.status };
  }

  it("un humain detecte sur la voie du portail ouvre une alarme ; sa fin ramene le detecteur au calme ; une autre voie ou un autre type n'y touche pas", async () => {
    const t = setup();
    t.dahua.setSource('admin', 'I-01', { cameraId: 'C-01', channel: 1, events: ['SmartMotionHuman'], httpPort: port });
    await until(() => xvr.connected() === 1);
    await until(() => t.dahua.view('I-01')!.connection.state === 'connected');
    xvr.emit('Code=SmartMotionHuman;action=Start;index=1'); // voie 2 : pas la notre
    xvr.emit('Code=VideoMotion;action=Start;index=0'); // mouvement simple : pas suivi
    await wait(150);
    assert.equal(t.incidents().length, 0);
    xvr.emit('Code=SmartMotionHuman;action=Start;index=0;data={"Object":"Human"}');
    await until(() => t.incidents().length === 1);
    assert.equal(t.status(), 'alarm');
    assert.deepEqual(t.dahua.view('I-01')!.connection.lastEvent?.code, 'SmartMotionHuman');
    xvr.emit('Code=SmartMotionHuman;action=Stop;index=0');
    await until(() => t.status() === 'normal');
    assert.ok(t.audits.some((a) => /detector_source_updated:Dahua C-01 voie 1 : SmartMotionHuman ; supervision 120 s/.test(a)));
    assert.equal(t.engine.getDevice('I-01')!.heartbeatS, 120, 'supervision posee : un appareil muet rendra le detecteur « hors ligne »');
    t.dahua.stop();
  });

  it("la nuit seulement : zone desarmee (journee) = mouvement ignore et journalise ; armee = alarme", async () => {
    let armed = false;
    const t = setup({ armed: () => armed });
    t.dahua.setSource('admin', 'I-01', { cameraId: 'C-01', channel: 1, events: ['SmartMotionHuman', 'SmartMotionVehicle'], httpPort: port });
    await until(() => t.dahua.view('I-01')!.connection.state === 'connected');
    xvr.emit('Code=SmartMotionVehicle;action=Start;index=0');
    await wait(150);
    assert.equal(t.incidents().length, 0, 'journee : rien');
    assert.ok((t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'intrusion_ignored'").get() as { n: number }).n >= 1);
    xvr.emit('Code=SmartMotionVehicle;action=Stop;index=0');
    armed = true;
    xvr.emit('Code=SmartMotionVehicle;action=Start;index=0');
    await until(() => t.incidents().length === 1);
    t.dahua.stop();
  });

  it("perte video de la voie : la nuit (zone armee) une alarme de sabotage, le jour un simple defaut ; coupure de l'appareil = reconnexion automatique", async () => {
    let armed = false;
    const t = setup({ armed: () => armed });
    t.dahua.setSource('admin', 'I-01', { cameraId: 'C-01', channel: 1, events: ['SmartMotionHuman'], httpPort: port });
    await until(() => t.dahua.view('I-01')!.connection.state === 'connected');
    xvr.emit('Code=VideoLoss;action=Start;index=0');
    await until(() => t.status() === 'fault');
    assert.equal(t.incidents().length, 0, 'journee : pas une alarme');
    xvr.emit('Code=VideoLoss;action=Stop;index=0');
    await until(() => t.status() === 'normal');
    armed = true;
    xvr.emit('Code=VideoLoss;action=Start;index=0');
    await until(() => t.incidents().length === 1);
    assert.equal(t.status(), 'alarm', 'nuit : camera du portail aveuglee = sabotage possible, le gardien est prevenu');
    xvr.emit('Code=VideoLoss;action=Stop;index=0');
    await until(() => t.status() === 'normal');
    const before = xvr.requests();
    xvr.cut();
    await until(() => t.dahua.view('I-01')!.connection.state === 'error');
    await until(() => xvr.requests() > before && t.dahua.view('I-01')!.connection.state === 'connected', 5000);
    t.dahua.stop();
  });

  it("perte video commencee le jour et toujours en cours a l'armement du soir : elle devient l'alarme de sabotage", async () => {
    let armed = false;
    const t = setup({ armed: () => armed, aliveEveryMs: 100 });
    t.dahua.setSource('admin', 'I-01', { cameraId: 'C-01', channel: 1, events: ['SmartMotionHuman'], httpPort: port });
    await until(() => t.dahua.view('I-01')!.connection.state === 'connected');
    xvr.emit('Code=VideoLoss;action=Start;index=0');
    await until(() => t.status() === 'fault');
    await wait(300);
    assert.equal(t.incidents().length, 0);
    armed = true; // 19:00
    await until(() => t.incidents().length === 1);
    assert.equal(t.status(), 'alarm');
    await wait(300);
    assert.equal(t.incidents().length, 1, 'une seule alarme pour une meme perte');
    t.dahua.stop();
  });

  it("alarme en cours jamais bloquee : Stop d'un code retire du reglage, connexion coupee pendant un Start, source retiree", async () => {
    const t = setup();
    t.dahua.setSource('admin', 'I-01', { cameraId: 'C-01', channel: 1, events: ['VideoMotion', 'SmartMotionHuman'], httpPort: port });
    await until(() => t.dahua.view('I-01')!.connection.state === 'connected');
    // 1. Start d'un code, puis ce code est retire du reglage : son Stop termine quand meme l'alarme.
    xvr.emit('Code=VideoMotion;action=Start;index=0');
    await until(() => t.status() === 'alarm');
    t.dahua.setSource('admin', 'I-01', { cameraId: 'C-01', channel: 1, events: ['SmartMotionHuman'], httpPort: port });
    await until(() => t.status() === 'normal');
    // 2. Coupure de la connexion entre Start et Stop : retour au calme (le Stop ne viendra jamais).
    xvr.emit('Code=SmartMotionHuman;action=Start;index=0');
    await until(() => t.status() === 'alarm');
    xvr.cut();
    await until(() => t.status() === 'normal');
    await until(() => t.dahua.view('I-01')!.connection.state === 'connected', 5000);
    // 3. Source retiree pendant un Start : idem.
    xvr.emit('Code=SmartMotionHuman;action=Start;index=0');
    await until(() => t.status() === 'alarm');
    t.dahua.removeSource('admin', 'I-01');
    await until(() => t.status() === 'normal');
    assert.equal(t.incidents().length, 1, "l'incident reste ouvert : il se traite comme les autres");
    t.dahua.stop();
  });

  it("un « 200 » qui n'est pas un flux Dahua, ou une demande d'authentification Basic : refus explique, detecteurs jamais declares vivants", async () => {
    const t = setup();
    xvr.setMode('html');
    try {
      const html = await t.dahua.test('C-01', port, 3);
      assert.equal(html.ok, false);
      assert.match(html.message, /pas un flux d'evenements Dahua/);
      xvr.setMode('basic');
      const basic = await t.dahua.test('C-01', port, 3);
      assert.equal(basic.ok, false);
      assert.match(basic.message, /Basic/);
    } finally {
      xvr.setMode('dahua');
    }
    t.dahua.stop();
  });

  it("utilisateur accentue : la source est refusee ; deja en base, la connexion echoue proprement (pas de plantage du PSIM)", async () => {
    const t = setup({ user: 'gardien€' });
    assert.throws(() => t.dahua.setSource('admin', 'I-01', { cameraId: 'C-01', channel: 1, events: ['SmartMotionHuman'], httpPort: port }), /Nom d'utilisateur/);
    t.db.prepare("INSERT INTO detector_source (device_id, kind, camera_id, channel, events, http_port) VALUES ('I-01', 'dahua', 'C-01', 1, '[\"SmartMotionHuman\"]', ?)").run(port);
    t.dahua.reload();
    await until(() => t.dahua.view('I-01')!.connection.error !== null);
    assert.match(t.dahua.view('I-01')!.connection.error!, /nom d'utilisateur/);
    t.dahua.stop();
  });

  it("la regle tient dans la duree : categorie, zone et supervision (>= 120 s) du detecteur verrouillees tant que la source existe", () => {
    const t = setup();
    t.db.prepare("UPDATE device SET heartbeat_s = 20 WHERE id = 'I-01'").run();
    t.dahua.setSource('admin', 'I-01', { cameraId: 'C-01', channel: 1, events: ['SmartMotionHuman'], httpPort: port });
    assert.equal(t.engine.getDevice('I-01')!.heartbeatS, 120, 'supervision trop courte relevee (signes de vie toutes les 30 s)');
    assert.throws(() => t.engine.updateDevice('admin', 'I-01', { category: 'fire' }), /reste un detecteur d'intrusion/);
    assert.throws(() => t.engine.updateDevice('admin', 'I-01', { zone: '' }), /reste un detecteur d'intrusion avec une zone/);
    assert.throws(() => t.engine.updateDevice('admin', 'I-01', { heartbeatS: 30 }), /au moins 120 s/);
    t.engine.updateDevice('admin', 'I-01', { name: 'Portail (nuit)', heartbeatS: 300 });
    t.dahua.removeSource('admin', 'I-01');
    t.engine.updateDevice('admin', 'I-01', { category: 'fire' });
    t.dahua.stop();
  });

  it("identifiants refuses : explique, sans le mot de passe, et pas de nouvel essai avant 5 min (le compte de l'appareil ne se bloque pas)", async () => {
    const t = setup({ password: 'mauvais-mot-de-passe' });
    const before = xvr.requests();
    t.dahua.setSource('admin', 'I-01', { cameraId: 'C-01', channel: 1, events: ['SmartMotionHuman'], httpPort: port });
    await until(() => t.dahua.view('I-01')!.connection.error !== null);
    const view = t.dahua.view('I-01')!;
    assert.match(view.connection.error!, /identifiants refuses/);
    assert.ok(!JSON.stringify(view).includes('mauvais-mot-de-passe'));
    await wait(1500);
    assert.equal(xvr.requests() - before, 2, 'une demande, une reponse au defi : puis rien');
    t.dahua.stop();
  });

  it("essai de 20 s (raccourci ici) : rapporte tous les evenements et signes de vie, toutes voies ; refus explique", async () => {
    const t = setup();
    const pending = t.dahua.test('C-01', port, 3);
    await until(() => xvr.connected() >= 1);
    await wait(100);
    xvr.emit('Code=SmartMotionHuman;action=Start;index=4');
    const r = await pending;
    assert.equal(r.ok, true, r.message);
    assert.ok(r.heartbeats >= 1);
    assert.deepEqual(r.events.map((e) => [e.code, e.action, e.channel]), [['SmartMotionHuman', 'Start', 5]]);
    const bad = await t.dahua.test('C-01', 1, 3);
    assert.equal(bad.ok, false);
    assert.match(bad.message, /connexion refusee/);
  });

  it("refus de configuration : detecteur hors intrusion ou sans zone, camera sans identifiants, evenement inconnu, voie hors bornes", () => {
    const t = setup();
    assert.throws(() => t.dahua.setSource('admin', 'D-01', { cameraId: 'C-01', channel: 1, events: ['SmartMotionHuman'] }), /INTRUSION/);
    t.db.prepare("UPDATE device SET zone = '' WHERE id = 'I-01'").run();
    assert.throws(() => t.dahua.setSource('admin', 'I-01', { cameraId: 'C-01', channel: 1, events: ['SmartMotionHuman'] }), /Donner d'abord une zone/);
    t.db.prepare("UPDATE device SET zone = 'Accueil' WHERE id = 'I-01'").run();
    assert.throws(() => t.dahua.setSource('admin', 'I-01', { cameraId: 'C-02', channel: 1, events: ['SmartMotionHuman'] }), /pas de source video reelle/);
    assert.throws(() => t.dahua.setSource('admin', 'I-01', { cameraId: 'C-01', channel: 1, events: ['Explosion'] }), /Evenements invalides/);
    assert.throws(() => t.dahua.setSource('admin', 'I-01', { cameraId: 'C-01', channel: 0, events: ['SmartMotionHuman'] }), /Voie invalide/);
    assert.throws(() => t.dahua.removeSource('admin', 'I-01'), /Aucune source/);
    t.dahua.stop();
  });
});

// ---------------------------------------------------------------- destinataires limites a une zone

describe('destinataires limites a des zones (le gardien : zone Portail)', () => {
  it("portee : un destinataire limite ne recoit que ses zones ; les messages generaux vont aux seuls destinataires sans limite", () => {
    assert.equal(inScope(null, { zone: 'Accueil' }), true);
    assert.equal(inScope(['Portail'], { zone: 'Portail' }), true);
    assert.equal(inScope(['Portail'], { zone: 'Accueil' }), false);
    assert.equal(inScope(['Portail'], { zone: null }), false, 'redemarrage, securite : pas pour le gardien');
    assert.equal(inScope(['Portail'], undefined), true, 'message de test : tout le monde');
  });

  it("alarme du portail : le gardien et le responsable ; alarme de l'accueil et redemarrage : le responsable seul ; zone sans personne signalee", async () => {
    const db = openDb(':memory:');
    seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-zone-')), join(ROOT, 'seed'));
    db.prepare("UPDATE device SET zone = 'Portail' WHERE id = 'I-01'").run();
    const engine = createEngine(db, () => {});
    const recipients = createRecipientsService({
      db,
      audit: () => {},
      env: { email: [[], []], telegram: [[], []], whatsapp: [['+2250100000001'], []], callmebot: [[], []], webhook: [[], []] },
      available: { email: false, telegram: false, whatsapp: true, callmebot: false, webhook: true },
    });
    const gardien = recipients.add('admin', { channel: 'whatsapp', address: '+2250700000002', level: 1, label: 'Gardien', zones: ['Portail'] });
    assert.deepEqual(gardien.zones, ['Portail']);
    assert.throws(() => recipients.add('admin', { channel: 'whatsapp', address: '+2250700000003', level: 1, zones: [] }), /1 a 50 noms/);
    const sent: { to: string; subject: string }[] = [];
    const channel: Channel = {
      id: 'whatsapp',
      label: 'WhatsApp',
      recipients: (level, scope) => recipients.effective('whatsapp', level, scope),
      mask: (r) => r,
      send: async (m: Message, to) => void sent.push({ to, subject: m.subject }),
    };
    const notifier = createNotifier({ db, engine, channels: [channel], escalateAfterMs: 0, reminderMs: 0, maxReminders: 0, retryDelaysMs: [0], secrets: [] });
    engine.handleDetectorMessage('I-01', { event: 'motion' });
    const portail = engine.getSnapshot().incidents.find((i) => i.detectorId === 'I-01')!;
    await notifier.notifyIncident(portail, 'opened');
    assert.deepEqual(sent.map((s) => s.to).sort(), ['+2250100000001', '+2250700000002']);
    sent.length = 0;
    engine.handleDetectorMessage('D-01', { state: 'alarm' });
    await notifier.notifyIncident(engine.getSnapshot().incidents.find((i) => i.detectorId === 'D-01')!, 'opened');
    assert.deepEqual(sent.map((s) => s.to), ['+2250100000001'], 'accueil : pas le gardien');
    sent.length = 0;
    await notifier.notifyRestart({ from: 0, to: 60_000, durationMs: 60_000, clean: false }, 0);
    assert.deepEqual(sent.map((s) => s.to), ['+2250100000001'], 'message general : pas le gardien');
    assert.deepEqual(notifier.status().uncoveredZones, [], 'le responsable couvre toutes les zones');
    // Sans le responsable, seules les alarmes du portail previennent quelqu'un : les autres zones sont signalees.
    const solo = createNotifier({ db, engine, channels: [{ ...channel, recipients: (level, scope) => recipients.effective('whatsapp', level, scope).filter((r) => r !== '+2250100000001') }], escalateAfterMs: 0, reminderMs: 0, maxReminders: 0, retryDelaysMs: [0], secrets: [] });
    assert.ok(solo.status().uncoveredZones.includes('Accueil'));
    assert.ok(!solo.status().uncoveredZones.includes('Portail'));
    recipients.update('admin', gardien.id!, { zones: null });
    assert.equal(recipients.list().find((r) => r.id === gardien.id)!.zones, null, 'retour a « toutes les alarmes »');
  });

  function site() {
    const db = openDb(':memory:');
    seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-zone-')), join(ROOT, 'seed'));
    db.prepare("UPDATE device SET zone = 'Portail' WHERE id = 'I-01'").run();
    const engine = createEngine(db, () => {});
    const recipients = createRecipientsService({
      db,
      audit: () => {},
      env: { email: [[], []], telegram: [[], []], whatsapp: [[], []], callmebot: [[], []], webhook: [[], []] },
      available: { email: false, telegram: false, whatsapp: true, callmebot: false, webhook: true },
    });
    return { db, engine, recipients };
  }

  it("branchement du serveur (buildChannels) : la zone de l'envoi arrive jusqu'aux destinataires", () => {
    const { recipients } = site();
    recipients.add('admin', { channel: 'whatsapp', address: '+2250700000002', level: 1, label: 'Gardien', zones: ['Portail'] });
    recipients.add('admin', { channel: 'whatsapp', address: '+2250100000001', level: 1 });
    const channels = buildChannels(
      {
        smtp: { host: '', port: 25, secure: false, user: '', password: '', from: '' },
        telegram: { token: '', apiBase: '' },
        whatsapp: { apiBase: 'http://127.0.0.1:9', token: 'jeton', phoneId: '123', template: 'psim_alerte', language: 'fr' },
        callmebot: { apiBase: '' },
        webhookSecret: '',
      },
      recipients.effective,
    );
    const whatsapp = channels.find((c) => c.id === 'whatsapp')!;
    assert.deepEqual(whatsapp.recipients(1, { zone: 'Portail' }), ['+2250700000002', '+2250100000001']);
    assert.deepEqual(whatsapp.recipients(1, { zone: 'Accueil' }), ['+2250100000001'], 'alarme de l\'accueil : pas le gardien');
    assert.deepEqual(whatsapp.recipients(1, { zone: null }), ['+2250100000001'], 'message general : pas le gardien');
    assert.equal(whatsapp.recipients(1).length, 2, 'message de test : tout le monde');
  });

  it("personne pour une zone ou pour les messages generaux : repli sur TOUS les destinataires du niveau (une alarme notifie toujours), signale a l'avance ; escalade idem", async () => {
    const { db, engine, recipients } = site();
    recipients.add('admin', { channel: 'whatsapp', address: '+2250700000002', level: 1, label: 'Gardien', zones: ['Portail'] });
    recipients.add('admin', { channel: 'whatsapp', address: '+2250700000003', level: 2, label: 'Chef gardien', zones: ['Portail'] });
    const sent: { to: string; kind: string }[] = [];
    const channel: Channel = {
      id: 'whatsapp',
      label: 'WhatsApp',
      recipients: (level, scope) => recipients.effective('whatsapp', level, scope),
      mask: (r) => r,
      send: async (m: Message, to) => void sent.push({ to, kind: m.kind }),
    };
    let t = Date.now();
    const notifier = createNotifier({ db, engine, channels: [channel], now: () => t, escalateAfterMs: 60_000, reminderMs: 600_000, maxReminders: 1, retryDelaysMs: [0], secrets: [] });
    assert.ok(notifier.status().uncoveredZones.includes('Accueil'));
    assert.equal(notifier.status().generalFallback, true);
    engine.handleDetectorMessage('D-01', { state: 'alarm' }); // Accueil : personne n'y est designe
    const accueil = engine.getSnapshot().incidents.find((i) => i.detectorId === 'D-01')!;
    await notifier.notifyIncident(accueil, 'opened');
    assert.deepEqual(sent.map((s) => s.to), ['+2250700000002'], 'repli : le gardien plutot que personne');
    sent.length = 0;
    await notifier.notifyRestart({ from: 0, to: 60_000, durationMs: 60_000, clean: false }, 1);
    assert.deepEqual(sent.map((s) => s.to), ['+2250700000002'], 'redemarrage : repli aussi');
    sent.length = 0;
    t += 61_000;
    notifier.tick();
    await until(() => sent.length > 0);
    assert.deepEqual(sent, [{ to: '+2250700000003', kind: 'unacked' }], "escalade : « niveau 2 prevenu » est vrai");
  });

  it("zones verifiees a l'enregistrement (ecriture exacte, zone existante) ; zone renommee ensuite : signalee", () => {
    const { db, engine, recipients } = site();
    const gardien = recipients.add('admin', { channel: 'whatsapp', address: '+2250700000002', level: 1, zones: [' portail '] });
    assert.deepEqual(gardien.zones, ['Portail'], 'ramenee a l\'ecriture des detecteurs');
    assert.throws(() => recipients.add('admin', { channel: 'whatsapp', address: '+2250700000003', level: 1, zones: ['Garage'] }), /Zone inconnue : « Garage »/);
    assert.deepEqual(recipients.orphanZones(), []);
    engine.updateDevice('admin', 'I-01', { zone: 'Portail principal' });
    assert.deepEqual(recipients.orphanZones(), [{ recipient: maskPhone('+2250700000002'), zones: ['Portail'] }], 'le gardien ne recevrait plus rien du portail');
    assert.match(checkInventory(db).find((c) => c.id === 'recipient-zones')?.detail ?? '', /zone sans detecteur : Portail/, 'npm run commission le signale aussi');
    assert.throws(() => recipients.update('admin', gardien.id!, { zones: ['Portail'] }), /Zone inconnue/);
    recipients.update('admin', gardien.id!, { zones: ['Portail principal'] });
    assert.deepEqual(recipients.orphanZones(), []);
  });
});
