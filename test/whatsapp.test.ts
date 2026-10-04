/**
 * WhatsApp par CallMeBot, contre un faux service local (aucun message reel n'est envoye) : adresse et parametres,
 * reussite et echecs, cle jamais revelee (erreurs, journal des envois, interface), configuration stricte du .env.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkWhatsapp } from '../scripts/commission/checks.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { createNotifier, maskWhatsapp, whatsappChannel } from '../server/notifications.ts';
import type { Message } from '../server/notifications.ts';
import { createRecipientsService } from '../server/recipients.ts';
import { seedDemo } from '../server/seed.ts';

const ROOT = resolve(import.meta.dirname, '..');
const KEY = 'cleSecrete987';
const PHONE = '+2250700000042';
const RECIPIENT = `${PHONE}:${KEY}`;

const message: Message = { kind: 'opened', incidentId: 7, subject: '[PSIM] ALARME - Fumee sejour', text: 'Zone : RDC - Sejour - Etage : Rez-de-chaussée\nEtat : NON ACQUITTEE', data: {} };

describe('WhatsApp (CallMeBot), faux service local', () => {
  let base = '';
  let reply: { status: number; body: string } = { status: 200, body: '<p>Message queued. You will receive it in a few seconds.</p>' };
  const calls: URL[] = [];
  const server = createServer((req, res) => {
    calls.push(new URL(req.url ?? '/', 'http://x'));
    res.writeHead(reply.status, { 'Content-Type': 'text/html' }).end(reply.body);
  });
  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("envoie un GET whatsapp.php avec le numero, le texte (titre en gras) et la cle de CE destinataire", async () => {
    const channel = whatsappChannel({ apiBase: `${base}/` }, [[RECIPIENT, 'pas-un-destinataire'], []])!;
    assert.deepEqual(channel.recipients(1), [RECIPIENT], 'une entree mal formee est ecartee');
    await channel.send(message, RECIPIENT);
    const call = calls.at(-1)!;
    assert.equal(call.pathname, '/whatsapp.php');
    assert.equal(call.searchParams.get('phone'), PHONE);
    assert.equal(call.searchParams.get('apikey'), KEY);
    assert.equal(call.searchParams.get('text'), `*[PSIM] ALARME - Fumee sejour*\n\n${message.text}`, 'accents et retours a la ligne intacts');
    assert.equal(channel.sendImages, undefined, 'le service gratuit ne transporte pas d image');
  });

  it("un texte tres long est raccourci (il passe dans l'adresse)", async () => {
    const channel = whatsappChannel({ apiBase: base }, [[RECIPIENT], []])!;
    await channel.send({ ...message, text: 'x'.repeat(5000) }, RECIPIENT);
    assert.equal(calls.at(-1)!.searchParams.get('text')!.length, 1500);
  });

  it("echecs : HTTP d'erreur, reponse 200 qui annonce une erreur, service injoignable ; la cle n'apparait jamais", async () => {
    const channel = whatsappChannel({ apiBase: base }, [[RECIPIENT], []])!;
    reply = { status: 500, body: 'Internal error' };
    await assert.rejects(channel.send(message, RECIPIENT), /WhatsApp HTTP 500/);
    reply = { status: 200, body: `<b>APIKey is invalid.</b> apikey=${KEY} for ${PHONE}` };
    await assert.rejects(channel.send(message, RECIPIENT), (err: Error) => /WhatsApp refuse : APIKey is invalid/.test(err.message) && !err.message.includes(KEY));
    reply = { status: 200, body: 'Message queued' };
    const unreachable = whatsappChannel({ apiBase: 'http://127.0.0.1:1' }, [[RECIPIENT], []])!;
    await assert.rejects(unreachable.send(message, RECIPIENT), (err: Error) => err.message === 'WhatsApp (CallMeBot) injoignable');
  });

  it("aucun destinataire valide : pas de canal ; le numero affiche ne montre ni la cle ni le numero entier", () => {
    assert.equal(whatsappChannel({ apiBase: base }, [[], []]), null);
    assert.equal(whatsappChannel({ apiBase: base }, [['0700000042:abc'], []]), null, 'numero sans indicatif +');
    assert.equal(maskWhatsapp(RECIPIENT), '+225...42');
    assert.ok(!maskWhatsapp(RECIPIENT).includes(KEY));
  });

  it("mise en service : rien n'est envoye sans --whatsapp-test ; avec, un essai par destinataire de niveau 1, cle jamais affichee", async () => {
    assert.equal((await checkWhatsapp({ apiBase: base }, [[], []], false)).status, 'skip');
    const before = calls.length;
    const quiet = await checkWhatsapp({ apiBase: base }, [[RECIPIENT], []], false);
    assert.equal(quiet.status, 'ok');
    assert.match(quiet.detail, /1 destinataire\(s\) : \+225\.\.\.42 ; aucun message envoye/);
    assert.equal(calls.length, before, 'aucun envoi');
    const sent = await checkWhatsapp({ apiBase: base }, [[RECIPIENT], ['+33612345678:autreCle1']], true);
    assert.equal(sent.status, 'ok');
    assert.equal(calls.length, before + 1, 'niveau 1 seulement');
    reply = { status: 200, body: 'Phone not allowed' };
    const refused = await checkWhatsapp({ apiBase: base }, [[RECIPIENT], []], true);
    reply = { status: 200, body: 'Message queued' };
    assert.equal(refused.status, 'fail');
    assert.ok(!JSON.stringify(refused).includes(KEY));
  });

  it("dans le notificateur : l'alarme part sur WhatsApp, le journal des envois ne garde que le numero masque", async () => {
    const db = openDb(':memory:');
    seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-wa-')), join(ROOT, 'seed'));
    const engine = createEngine(db, () => {});
    const notifier = createNotifier({ db, engine, channels: [whatsappChannel({ apiBase: base }, [[RECIPIENT], []])!], escalateAfterMs: 0, reminderMs: 0, maxReminders: 0, retryDelaysMs: [0], secrets: [KEY] });
    engine.handleDetectorMessage('D-01', { state: 'alarm' });
    const incident = engine.getSnapshot().incidents[0];
    const before = calls.length;
    await notifier.notifyIncident(incident, 'opened');
    assert.equal(calls.length, before + 1);
    assert.match(calls.at(-1)!.searchParams.get('text')!, /ALARME/);
    const logged = db.prepare("SELECT channel, recipient, status FROM notification_log WHERE channel = 'whatsapp'").all() as { channel: string; recipient: string; status: string }[];
    assert.deepEqual(logged.map((r) => ({ ...r })), [{ channel: 'whatsapp', recipient: '+225...42', status: 'sent' }]);
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_log').all()).includes(KEY));
  });
});

describe('WhatsApp : destinataires et configuration', () => {
  it("les destinataires du .env sont affiches masques ; l'interface refuse d'en ajouter (cle secrete)", () => {
    const db = openDb(':memory:');
    const svc = createRecipientsService({
      db,
      audit: () => {},
      env: { email: [[], []], telegram: [[], []], whatsapp: [[RECIPIENT], []], webhook: [[], []] },
      available: { email: true, telegram: true, whatsapp: false, webhook: true },
    });
    const listed = svc.list().filter((r) => r.channel === 'whatsapp');
    assert.deepEqual(listed.map((r) => [r.display, r.level, r.source]), [['+225...42', 1, 'env']]);
    assert.ok(!JSON.stringify(svc.list()).includes(KEY));
    assert.deepEqual(svc.effective('whatsapp', 1), [RECIPIENT], "l'envoi, lui, recoit la cle");
    assert.throws(() => svc.add('admin', { channel: 'whatsapp', address: RECIPIENT, level: 1 }), /dans le \.env/);
  });

  it("une entree mal formee dans le .env bloque le demarrage, avec sa position, jamais son contenu", () => {
    const run = (value: string) =>
      spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./server/config.ts')"], {
        cwd: ROOT,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PSIM_NOTIFY_WHATSAPP_L1: value },
        encoding: 'utf8',
      });
    const ok = run(`${RECIPIENT},+33612345678:autreCle1`);
    assert.equal(ok.status, 0, ok.stderr);
    const bad = run(`${RECIPIENT}, 0612345678:${KEY}x`);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /PSIM_NOTIFY_WHATSAPP_L1 : l'entree n°2 est invalide/);
    assert.ok(!bad.stderr.includes(KEY), 'la cle ne fuit pas dans le message');
  });
});
