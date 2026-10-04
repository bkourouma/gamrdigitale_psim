import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import {
  checkBackups, checkCameras, checkClock, checkDisk, checkFfmpeg, checkHeartbeat, checkInventory, checkJournal, checkSmtp, checkTelegram, checkTls, checkWebhooks, exitCodeFor, formatChecks, safely, schemaProblem,
} from '../scripts/commission/checks.ts';
import type { Check } from '../scripts/commission/checks.ts';
import { buildSheet } from '../scripts/commission/sheet.ts';
import { createWatcher, formatSummary } from '../scripts/commission/watch.ts';
import type { WatchDevice } from '../scripts/commission/watch.ts';
import { appendSealed } from '../server/auditchain.ts';
import { createBackup } from '../server/backup.ts';
import { openDb } from '../server/db.ts';
import { startBroker } from '../server/mqtt.ts';
import { seedDemo } from '../server/seed.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OPENSSL = ['openssl', 'D:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/usr/bin/openssl.exe'].find((c) => spawnSync(c, ['version']).status === 0);
const DAY = 86_400_000;
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });
const cleanup: (() => void)[] = [];
after(() => cleanup.forEach((f) => f()));

const devices: WatchDevice[] = [
  { id: 'D-01', name: 'Fumee accueil', zone: 'Accueil', category: 'fire', warnAt: null, alarmAt: null, direction: 'above', valueUnit: null },
  { id: 'A-01', name: 'Porte service', zone: 'Entrepot', category: 'access', warnAt: null, alarmAt: null, direction: 'above', valueUnit: null },
  { id: 'E-01', name: 'Temperature', zone: 'Serveurs', category: 'environment', warnAt: 30, alarmAt: 38, direction: 'above', valueUnit: '°C' },
  { id: 'E-02', name: 'Humidite', zone: 'Stock', category: 'environment', warnAt: null, alarmAt: null, direction: 'above', valueUnit: '%' },
];
const buf = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v));

describe('recette des detecteurs : ce que le PSIM comprend de chaque message', () => {
  it("lit un etat, un evenement, une mesure et un signe de vie, comme le moteur", () => {
    const w = createWatcher(devices, () => 1_000_000);
    assert.match(w.handle('psim/detectors/D-01/state', buf({ state: 'alarm' }))!.text, /Fumee accueil : -> ALARME/);
    assert.match(w.handle('psim/detectors/A-01/state', buf({ event: 'door_forced' }))!.text, /evenement « door_forced » -> ALARME/);
    assert.match(w.handle('psim/detectors/E-01/state', buf({ value: 41.5 }))!.text, /mesure 41\.5 °C -> ALARME/);
    assert.match(w.handle('psim/detectors/E-01/state', buf({ value: 32 }))!.text, /-> PREALARME/);
    assert.match(w.handle('psim/detectors/E-01/state', buf({ value: 20 }))!.text, /-> normal/);
    assert.match(w.handle('psim/detectors/A-01/state', buf({ event: 'badge_granted' }))!.text, /signe de vie, aucun changement/);
    assert.match(w.handle('psim/detectors/E-02/state', buf({ value: 55 }))!.text, /aucun seuil regle : mesure seulement affichee/);
  });

  it("signale ce que le PSIM ignorerait : JSON illisible, etat invalide, evenement inconnu, message trop gros, id inconnu", () => {
    const w = createWatcher(devices);
    const verdict = (topic: string, payload: Buffer) => w.handle(topic, payload)!;
    assert.equal(verdict('psim/detectors/D-01/state', buf('pas du json')).verdict, 'invalid');
    assert.match(verdict('psim/detectors/D-01/state', buf('ALARM')).text, /pas du JSON/);
    const bad = verdict('psim/detectors/D-01/state', buf({ state: 'ALARM' }));
    assert.equal(bad.verdict, 'invalid');
    assert.match(bad.text, /state invalide.*Attendu : \{"state": "alarm"\}/);
    assert.match(verdict('psim/detectors/A-01/state', buf({ event: 'open' })).text, /event inconnu/);
    assert.match(verdict('psim/detectors/E-01/state', buf({ value: 'chaud' })).text, /value doit etre un nombre/);
    assert.match(verdict('psim/detectors/D-01/state', Buffer.alloc(2000, 97)).text, /trop gros \(2000 octets\)/);
    const unknown = verdict('psim/detectors/D-99/state', buf({ state: 'alarm' }));
    assert.equal(unknown.verdict, 'unknown');
    assert.match(unknown.text, /EXACTEMENT cet identifiant/);
  });

  it("ignore tout autre topic et ne leve jamais d'exception", () => {
    const w = createWatcher(devices);
    assert.equal(w.handle('autre/topic', buf({ state: 'alarm' })), null);
    assert.equal(w.handle('psim/detectors/D-01/autre', buf({ state: 'alarm' })), null);
    assert.equal(w.handle('psim/detectors/ID TROP LONG ET INVALIDE/state', buf({})), null);
    assert.doesNotThrow(() => w.handle('psim/detectors/D-01/state', buf('{"state":')));
    assert.doesNotThrow(() => w.handle('psim/detectors/D-01/state', buf('null')));
  });

  it("le bilan separe entendus, silencieux, inconnus et illisibles ; un message invalide ne compte pas comme « entendu »", () => {
    const w = createWatcher(devices);
    w.handle('psim/detectors/D-01/state', buf({ state: 'normal' }));
    w.handle('psim/detectors/D-01/state', buf({ state: 'alarm' }));
    w.handle('psim/detectors/A-01/state', buf('n importe quoi'));
    w.handle('psim/detectors/Z-1/state', buf({ state: 'alarm' }));
    const s = w.summary();
    assert.deepEqual(s.heard.map((h) => [h.id, h.count, h.states]), [['D-01', 2, ['normal', 'alarm']]]);
    assert.deepEqual(s.missing.map((m) => m.id), ['A-01', 'E-01', 'E-02']);
    assert.deepEqual(s.unknown, [{ id: 'Z-1', count: 1 }]);
    assert.equal(s.invalid[0].id, 'A-01');
    assert.equal(s.allHeard, false);
    const text = formatSummary(s);
    assert.match(text, /entendus : 1 \/ 4/);
    assert.match(text, /SILENCE {2}A-01/);
    assert.match(text, /INCONNU {2}Z-1/);
    assert.match(text, /ILLISIBLE A-01/);
  });

  it("tous entendus : le bilan le dit", () => {
    const w = createWatcher(devices);
    for (const d of devices) w.handle(`psim/detectors/${d.id}/state`, buf({ state: 'normal' }));
    assert.equal(w.summary().allHeard, true);
  });
});

describe('controles : heure, ffmpeg, certificat', () => {
  const fakeFetch = (date: string | null) => async () => ({ headers: { get: (n: string) => (n.toLowerCase() === 'date' ? date : null) } });

  it("mesure l'ecart d'heure avec une reference : ok, attention, echec ; ignore sans reference ou si elle est injoignable", async () => {
    const now = () => Date.parse('2026-02-10T12:00:00Z');
    const at = (offsetS: number) => new Date(now() - offsetS * 1000).toUTCString();
    assert.equal((await checkClock({ referenceUrl: 'https://x.test', now, fetch: fakeFetch(at(5)) })).status, 'ok');
    const warn = await checkClock({ referenceUrl: 'https://x.test', now, fetch: fakeFetch(at(300)) });
    assert.equal(warn.status, 'warn');
    assert.match(warn.detail, /ecart de \+300 s/);
    assert.equal((await checkClock({ referenceUrl: 'https://x.test', now, fetch: fakeFetch(at(-3000)) })).status, 'fail');
    assert.equal((await checkClock({ now })).status, 'skip');
    assert.equal((await checkClock({ referenceUrl: 'https://x.test', now, fetch: async () => { throw new Error('reseau'); } })).status, 'skip');
    assert.equal((await checkClock({ referenceUrl: 'https://x.test', now, fetch: fakeFetch(null) })).status, 'skip');
    assert.match((await checkClock({ now })).detail, /\(UTC[+-]\d/, "l'heure locale et le fuseau sont toujours affiches");
  });

  it("ffmpeg : trouve un executable valide, signale un chemin faux", () => {
    assert.equal(checkFfmpeg('chemin-inexistant-ffmpeg').status, 'fail');
    assert.match(checkFfmpeg('chemin-inexistant-ffmpeg').fix ?? '', /PSIM_FFMPEG/);
    const ok = spawnSync('ffmpeg', ['-version']).status === 0 ? checkFfmpeg('ffmpeg') : null;
    if (ok) assert.equal(ok.status, 'ok');
  });

  it('certificat : non configure = attention ; fichiers absents = echec', () => {
    assert.equal(checkTls({ cert: '', key: '' }).status, 'warn');
    assert.equal(checkTls({ cert: 'absent.pem', key: 'absent.key' }).status, 'fail');
  });

  it("certificat reel : validite, correspondance avec la cle, expiration proche ou depassee", { skip: OPENSSL ? false : 'openssl introuvable' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-cert-'));
    const make = (name: string, days: number) => {
      const r = spawnSync(OPENSSL!, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.pem`), '-days', String(days), '-subj', '/CN=psim.test', '-addext', 'subjectAltName=DNS:psim.test,IP:127.0.0.1'], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return { cert: join(dir, `${name}.pem`), key: join(dir, `${name}.key`) };
    };
    const good = make('bon', 365);
    const c = checkTls(good);
    assert.equal(c.status, 'ok');
    assert.match(c.detail, /psim\.test/);
    assert.match(c.detail, /auto-signe/);
    const soon = make('bientot', 10);
    assert.equal(checkTls(soon).status, 'warn');
    assert.equal(checkTls(good, Date.now() + 400 * DAY).status, 'fail', 'expire');
    assert.match(checkTls(good, Date.now() + 400 * DAY).detail, /EXPIRE depuis \d+ j/);
    const other = make('autre', 365);
    assert.match(checkTls({ cert: good.cert, key: other.key }).detail, /ne correspond pas/);
  });
});

describe('controles reseau : SMTP, Telegram, webhooks, supervision externe', () => {
  it("SMTP : verifie la connexion sans rien envoyer, envoie un test sur demande, explique les pannes", async () => {
    const received: string[] = [];
    const server = createServer((socket) => {
      socket.write('220 localhost ESMTP\r\n');
      let data = false;
      socket.on('data', (chunk) => {
        for (const line of chunk.toString().split('\r\n')) {
          if (data) {
            if (line === '.') { data = false; received.push('mail'); socket.write('250 ok\r\n'); }
            continue;
          }
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO') socket.write('250-localhost\r\n250 8BITMIME\r\n');
          else if (cmd === 'DATA') { data = true; socket.write('354 go\r\n'); }
          else if (cmd === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
          else if (line) socket.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    const cfg = { host: '127.0.0.1', port, secure: false, user: '', password: '', from: 'psim@exemple.test', starttls: false };

    const verified = await checkSmtp(cfg);
    assert.equal(verified.status, 'ok');
    assert.match(verified.detail, /aucun message envoye/);
    assert.equal(received.length, 0);
    const sent = await checkSmtp(cfg, 'direction@exemple.test');
    assert.equal(sent.status, 'ok');
    assert.match(sent.detail, /d\*\*\*@exemple\.test/, "l'adresse est masquee");
    assert.equal(received.length, 1);

    const closed = await checkSmtp({ ...cfg, port: await freePort() });
    assert.equal(closed.status, 'fail');
    assert.match(closed.detail, /connexion refusee/);
    assert.equal((await checkSmtp({ ...cfg, host: '' })).status, 'skip');
  });

  it("Telegram : jeton valide / refuse / injoignable ; le jeton n'apparait jamais dans le resultat", async () => {
    const TOKEN = '123456:SECRET-token-value';
    const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
    const ok = await checkTelegram({ token: TOKEN, apiBase: 'https://t.test' }, undefined, reply(200, { ok: true, result: { username: 'psim_bot' } }) as never);
    assert.equal(ok.status, 'ok');
    assert.match(ok.detail, /@psim_bot/);
    const refused = await checkTelegram({ token: TOKEN, apiBase: 'https://t.test' }, undefined, reply(401, { ok: false, description: 'Unauthorized' }) as never);
    assert.equal(refused.status, 'fail');
    assert.match(refused.detail, /Unauthorized/);
    const down = await checkTelegram({ token: TOKEN, apiBase: 'https://t.test' }, undefined, (async () => { throw new Error(`fetch failed https://t.test/bot${TOKEN}/getMe`); }) as never);
    assert.equal(down.status, 'fail');
    for (const c of [ok, refused, down]) assert.ok(!JSON.stringify(c).includes('SECRET-token-value'), 'jamais le jeton');
    assert.equal((await checkTelegram({ token: '', apiBase: '' })).status, 'skip');
    let calls = 0;
    const noChatNoSend = await checkTelegram({ token: TOKEN, apiBase: 'https://t.test' }, undefined, (async () => (calls++, new Response(JSON.stringify({ ok: true, result: { username: 'b' } })))) as never);
    assert.equal(calls, 1, 'sans --telegram-chat : aucun message envoye');
    assert.equal(noChatNoSend.status, 'ok');
    const withChat = await checkTelegram({ token: TOKEN, apiBase: 'https://t.test' }, '42', (async () => new Response(JSON.stringify({ ok: true, result: { username: 'b' } }))) as never);
    assert.match(withChat.detail, /message de test envoye a la conversation 42/);
  });

  it("webhooks : joignables (TCP seulement, rien envoye), refuses, invalides", async () => {
    let requests = 0;
    const server = createHttpServer((_req, res) => (requests++, res.end('ok')));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    const ok = await checkWebhooks([`http://127.0.0.1:${port}/hook/jeton-secret`]);
    assert.equal(ok.status, 'ok');
    assert.equal(requests, 0, 'aucune requete HTTP : aucune alerte envoyee');
    assert.ok(!ok.detail.includes('jeton-secret'));
    const closed = await checkWebhooks([`http://127.0.0.1:${await freePort()}/x`]);
    assert.equal(closed.status, 'fail');
    assert.match(closed.detail, /connexion refusee/);
    assert.match((await checkWebhooks(['pas une adresse'])).detail, /adresse invalide/);
    assert.equal((await checkWebhooks([])).status, 'skip');
  });

  it("supervision externe : signal recu, refuse (HTTP 500), injoignable ; non configuree = attention", async () => {
    let code = 200;
    const hits: string[] = [];
    const server = createHttpServer((req, res) => (hits.push(req.url ?? ''), res.writeHead(code).end('x')));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => server.close());
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ping/jeton-secret`;
    const ok = await checkHeartbeat(url);
    assert.equal(ok.status, 'ok');
    assert.deepEqual(hits, ['/ping/jeton-secret']);
    code = 500;
    assert.match((await checkHeartbeat(url)).detail, /HTTP 500/);
    assert.equal((await checkHeartbeat(`http://127.0.0.1:${await freePort()}/ping/x`)).status, 'fail');
    assert.equal((await checkHeartbeat('')).status, 'warn');
    for (const c of [ok, await checkHeartbeat(url)]) assert.ok(!JSON.stringify(c).includes('jeton-secret'));
  });
});

describe('controles locaux : disque, sauvegardes, inventaire, journal, cameras', () => {
  const seeded = () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-comm-'));
    const db = openDb(join(dir, 'psim.db'));
    seedDemo(db, dir, join(ROOT, 'seed'));
    return { dir, db };
  };

  it("disque : dossier inscriptible ok ; dossier absent = echec ; ne laisse aucun fichier derriere lui", () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-disk-'));
    assert.equal(checkDisk(dir).status === 'ok' || checkDisk(dir).status === 'warn', true);
    assert.match(checkDisk(dir).detail, /Go libres/);
    assert.equal(checkDisk(join(dir, 'absent')).status, 'fail');
    assert.deepEqual(readdirSync(dir), [], 'fichier temporaire supprime');
  });

  it("sauvegardes : aucune = attention/echec, valide = ok, alteree = echec, trop ancienne = attention", () => {
    const { dir, db } = seeded();
    const backups = join(dir, 'backups');
    assert.equal(checkBackups(backups, 24).status, 'warn');
    assert.equal(checkBackups(backups, 0).status, 'warn', 'hors production : simple attention');
    assert.equal(checkBackups(backups, 0, Date.now(), true).status, 'fail', 'en production sans sauvegarde automatique : echec');
    const b = createBackup({ db, dataDir: dir, backupDir: backups });
    assert.equal(checkBackups(backups, 24).status, 'ok');
    assert.equal(checkBackups(backups, 24, Date.now() + 5 * DAY).status, 'warn');
    writeFileSync(join(b.dir, 'psim.db'), 'corrompu');
    const bad = checkBackups(backups, 24);
    assert.equal(bad.status, 'fail');
    assert.match(bad.detail, /INVALIDE/);
  });

  it("inventaire : detecteurs jamais entendus, sans zone, sans camera liee, administrateur sans 2FA", () => {
    const { db } = seeded();
    db.prepare("INSERT INTO app_user (username, role, salt, hash, active) VALUES ('admin', 'admin', 's', 'h', 1)").run();
    db.prepare("INSERT INTO device (id, kind, name, zone) VALUES ('X-1', 'detector', 'Sans zone ni camera', '')").run();
    const out = checkInventory(db);
    const by = (id: string) => out.find((c) => c.id === id);
    assert.match(by('inventory')!.detail, /12 detecteur\(s\), 5 camera\(s\)/);
    assert.match(by('zones')!.detail, /X-1/);
    assert.match(by('links')!.detail, /X-1/);
    assert.match(by('heard')!.detail, /12 detecteur\(s\) n'ont jamais emis/);
    assert.match(by('2fa')!.detail, /admin/);
    db.prepare('UPDATE device SET last_seen = 1 WHERE kind = \'detector\'').run();
    assert.equal(checkInventory(db).find((c) => c.id === 'heard'), undefined, 'tous entendus : plus d\'avertissement');
  });

  it("une base d'une version anterieure est reconnue (au lieu de planter), une base a jour passe", () => {
    const { db } = seeded();
    assert.equal(schemaProblem(db), null);
    const old = new DatabaseSync(':memory:');
    old.exec("CREATE TABLE device (id TEXT PRIMARY KEY, kind TEXT, name TEXT); CREATE TABLE audit_log (id INTEGER PRIMARY KEY, ts INTEGER, actor TEXT, action TEXT); CREATE TABLE app_user (username TEXT PRIMARY KEY, role TEXT)");
    assert.match(schemaProblem(old)!, /base d'une version anterieure \(manque : device\.category, audit_log\.hash, table notification_recipient, app_user\.totp_enabled_at, table floor, device\.floor_id\)/);
  });

  it("journal : intact = ok ; altere = echec avec l'entree en cause", () => {
    const { db } = seeded();
    for (let i = 1; i <= 4; i++) appendSealed(db, { ts: i, actor: 'admin', action: `a${i}`, incident_id: null, device_id: null, details: `d${i}` });
    const ok = checkJournal(db);
    assert.equal(ok.status, 'ok');
    assert.match(ok.detail, /4 entree\(s\) protegee\(s\), chaine intacte/);
    db.prepare("UPDATE audit_log SET details = 'falsifie' WHERE id = 3").run();
    const bad = checkJournal(db);
    assert.equal(bad.status, 'fail');
    assert.match(bad.detail, /ALTERE : n°3 contenu modifie/);
  });

  it("cameras : simulees = attention, reelles testees une a une (succes / echec lisible), test absent = ignore", async () => {
    const { db } = seeded();
    db.prepare("INSERT INTO camera_source (device_id, kind, host, port) VALUES ('C-01', 'rtsp', '10.0.0.5', 554)").run();
    db.prepare("INSERT INTO camera_source (device_id, kind, host, port) VALUES ('C-02', 'onvif', '10.0.0.6', 80)").run();
    const tester = {
      async test(id: string) {
        if (id === 'C-02') throw new Error('Aucune image recue : identifiants refuses');
        return { ok: true, message: 'Image recue (12 Ko)' };
      },
    };
    const out = await checkCameras(db, tester);
    const by = (id: string) => out.find((c) => c.id === `camera-${id}`)!;
    assert.equal(by('C-01').status, 'ok');
    assert.equal(by('C-02').status, 'fail');
    assert.match(by('C-02').detail, /identifiants refuses/);
    assert.equal(by('C-03').status, 'warn');
    assert.match(by('C-03').detail, /simulee/);
    assert.equal((await checkCameras(db, null)).find((c) => c.id === 'camera-C-01')!.status, 'skip');
  });

  it("un controle qui plante devient un echec, jamais une exception ; le bilan et le code de sortie suivent", async () => {
    const boom = await safely('x', 'Controle', () => { throw new Error('plantage interne'); });
    assert.equal(boom.status, 'fail');
    const checks: Check[] = [{ id: 'a', title: 'A', status: 'ok', detail: 'bien' }, { id: 'b', title: 'B', status: 'warn', detail: 'moyen', fix: 'faire X' }, boom];
    const text = formatChecks(checks);
    assert.match(text, /ATTENTION\s+B : moyen\n\s+-> faire X/);
    assert.match(text, /Bilan : 1 ok, 1 attention, 1 echec\(s\), 0 ignore\(s\)/);
    assert.equal(exitCodeFor(checks), 1);
    assert.equal(exitCodeFor([checks[0], checks[1]]), 0, 'un avertissement ne fait pas echouer');
  });
});

describe('fiche de recette', () => {
  it("une ligne par equipement, echappee, avec cases a cocher et essais de bout en bout", () => {
    const html = buildSheet({
      site: 'Site <test>', generatedAt: Date.UTC(2026, 1, 10, 12),
      devices: [
        { id: 'D-01', kind: 'detector', name: '<b>Fumee</b>', zone: 'Accueil', category: 'fire', links: ['C-01'] },
        { id: 'I-01', kind: 'detector', name: 'Mouvement', zone: '', category: 'intrusion' },
        { id: 'C-01', kind: 'camera', name: 'Camera', zone: 'Accueil', category: 'fire', source: 'ONVIF 10.0.0.5:80' },
      ],
    });
    assert.ok(!html.includes('<b>Fumee</b>') && html.includes('&lt;b&gt;Fumee&lt;/b&gt;'));
    assert.ok(html.includes('Site &lt;test&gt;'));
    assert.match(html, /cameras : C-01/);
    assert.match(html, /aucune camera liee/);
    assert.match(html, /ONVIF 10\.0\.0\.5:80/);
    assert.match(html, /Intrusion/);
    assert.match(html, /Alarme de bout en bout/);
    assert.match(html, /Pannes et reprise/);
    assert.match(html, /Installateur : nom, date, signature/);
    assert.equal((html.match(/<tr><td><b>/g) ?? []).length, 3);
  });
});

describe('outil en ligne de commande (processus reels, broker reel)', { timeout: 120_000 }, () => {
  async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'psim-cli-'));
    const data = join(dir, 'data');
    mkdirSync(data);
    const db = openDb(join(data, 'psim.db'));
    seedDemo(db, data, join(ROOT, 'seed'));
    db.close();
    const port = await freePort();
    const broker = await startBroker({ handleDetectorMessage: () => {} } as never, { host: '127.0.0.1', port, user: 'psim', password: 'Mot-de-passe-mqtt-solide-3' });
    cleanup.push(() => void broker.close());
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PSIM_DATA_DIR: data, PSIM_MQTT_PORT: String(port), PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3', PSIM_MQTT_HOST: '127.0.0.1' };
    return { data, broker, env, dir };
  }

  function runWatch(env: NodeJS.ProcessEnv, args: string[]) {
    const proc = spawn(process.execPath, ['scripts/commission.ts', 'watch', ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (out += d));
    const exit = new Promise<number | null>((r) => proc.on('exit', (c) => r(c)));
    const ready = async () => {
      for (let i = 0; i < 100 && !out.includes('Declenchez maintenant'); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(out.includes('Declenchez maintenant'), out);
    };
    return { out: () => out, exit, ready };
  }

  it("watch : tous les detecteurs parlent -> OK et code 0, des l'instant ou le dernier est entendu", async () => {
    const f = await fixture();
    const w = runWatch(f.env, ['--minutes', '1', '--until-all']);
    await w.ready();
    const ids = ['D-01', 'D-02', 'D-03', 'D-04', 'D-05', 'D-06', 'D-07', 'I-01', 'A-01', 'E-01', 'E-02'];
    for (const id of ids) {
      const payload = id === 'E-01' ? { value: 41 } : id === 'A-01' ? { event: 'door_forced' } : { state: 'normal' };
      await f.broker.publishDetector(id, payload);
    }
    assert.equal(await w.exit, 0, w.out());
    assert.match(w.out(), /OK .*E-01 .*mesure 41 °C -> ALARME/);
    assert.match(w.out(), /Detecteurs entendus : 11 \/ 11/);
  });

  it("watch : silence, identifiant inconnu et message illisible -> bilan precis et code 1", async () => {
    const f = await fixture();
    const w = runWatch(f.env, ['--minutes', '0.08']);
    await w.ready();
    await f.broker.publishDetector('D-01', { state: 'normal' });
    await f.broker.publishDetector('ZZ-9', { state: 'alarm' });
    await f.broker.publishDetector('D-02', { state: 'ALARM' });
    assert.equal(await w.exit, 1, w.out());
    assert.match(w.out(), /INCONNU {2}ZZ-9/);
    assert.match(w.out(), /ILLISIBLE D-02 : state invalide/);
    assert.match(w.out(), /SILENCE {2}D-03/);
    assert.match(w.out(), /Detecteurs entendus : 1 \/ 11/);
  });

  it("watch : refuse sans base (code 2), broker injoignable (code 2), duree invalide (code 2)", async () => {
    const f = await fixture();
    const empty = mkdtempSync(join(tmpdir(), 'psim-vide-'));
    const run = (extra: NodeJS.ProcessEnv, args: string[]) => spawnSync(process.execPath, ['scripts/commission.ts', 'watch', ...args], { cwd: ROOT, env: { ...f.env, ...extra }, encoding: 'utf8' });
    assert.equal(run({ PSIM_DATA_DIR: empty }, ['--minutes', '1']).status, 2);
    const noBroker = run({ PSIM_MQTT_PORT: String(await freePort()) }, ['--minutes', '1']);
    assert.equal(noBroker.status, 2);
    assert.match(noBroker.stderr, /Connexion au broker impossible/);
    assert.equal(run({}, ['--minutes', '9999']).status, 2);
    assert.equal(spawnSync(process.execPath, ['scripts/commission.ts', 'inconnu'], { cwd: ROOT, env: f.env, encoding: 'utf8' }).status, 2);
  });

  it("sheet : ecrit la fiche de recette de l'inventaire reel ; check : bilan, journal et inventaire", async () => {
    const f = await fixture();
    const out = join(f.dir, 'recette.html');
    const r = spawnSync(process.execPath, ['scripts/commission.ts', 'sheet', '--out', out], { cwd: ROOT, env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const html = readFileSync(out, 'utf8');
    for (const id of ['D-01', 'D-07', 'I-01', 'A-01', 'E-01', 'E-02', 'C-01', 'C-05']) assert.ok(html.includes(`<b>${id}</b>`), id);
    assert.match(html, /Fiche de recette - Site de demonstration/);

    const check = spawnSync(process.execPath, ['scripts/commission.ts', '--skip-cameras'], { cwd: ROOT, env: { ...f.env, PSIM_SMTP_HOST: '', PSIM_TELEGRAM_TOKEN: '', PSIM_HEARTBEAT_URL: '' }, encoding: 'utf8' });
    assert.match(check.stdout, /Bilan : \d+ ok/);
    assert.match(check.stdout, /Journal infalsifiable : \d+ entree\(s\) protegee\(s\)|Journal infalsifiable : 0 entree/);
    assert.match(check.stdout, /Inventaire : 11 detecteur\(s\), 5 camera\(s\)/);
    assert.match(check.stdout, /Detecteurs jamais entendus : 11 detecteur\(s\)/);
    chmodSync(out, 0o644);
  });
});
