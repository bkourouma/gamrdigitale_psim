import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { createNotifier, emailChannel, telegramChannel, webhookChannel } from '../server/notifications.ts';
import type { Channel, ImageAttachment, Message } from '../server/notifications.ts';
import { seedDemo } from '../server/seed.ts';

const T0 = 1_000_000_000_000;
const S = 1000;
const flush = () => new Promise((r) => setTimeout(r, 15));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6, 0xff, 0xd9]);

interface FakeChannel extends Channel {
  sent: { to: string; message: Message }[];
  images: { to: string; images: ImageAttachment[] }[];
  failures: Map<string, number>; // destinataire -> nombre d'echecs restants (Infinity = toujours)
  attempts: number;
}

function fakeChannel(id: string, l1: string[], l2: string[]): FakeChannel {
  const ch: FakeChannel = {
    id,
    label: id,
    sent: [],
    images: [],
    failures: new Map(),
    attempts: 0,
    recipients: (level) => (level === 1 ? l1 : l2),
    mask: (r) => `<${r}>`,
    async send(message, to) {
      ch.attempts++;
      const left = ch.failures.get(to) ?? 0;
      if (left > 0) {
        ch.failures.set(to, left - 1);
        throw new Error(`panne ${to} avec le secret-jeton-123`);
      }
      ch.sent.push({ to, message });
    },
    async sendImages(_m, to, images) {
      ch.images.push({ to, images });
    },
  };
  return ch;
}

function setup(opts: { channels?: Channel[]; escalateAfterS?: number; reminderS?: number; maxReminders?: number; confirmWindowMs?: number } = {}) {
  const db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  let clock = T0;
  const engine = createEngine(db, () => {}, () => clock, { confirmWindowMs: opts.confirmWindowMs ?? 0 });
  const channel = fakeChannel('chat', ['a'], ['boss']);
  const notifier = createNotifier({
    db,
    engine,
    channels: opts.channels ?? [channel],
    now: () => clock,
    escalateAfterMs: (opts.escalateAfterS ?? 180) * S,
    reminderMs: (opts.reminderS ?? 300) * S,
    maxReminders: opts.maxReminders ?? 2,
    retryDelaysMs: [0, 0, 0],
    secrets: ['secret-jeton-123'],
    readSnapshot: () => JPEG,
  });
  return {
    db,
    engine,
    channel,
    notifier,
    advance: (s: number) => void (clock += s * S),
    send: (id: string, state: string) => engine.handleDetectorMessage(id, { state }),
    incident: (detector: string) => engine.getSnapshot().incidents.find((i) => i.detectorId === detector && i.status !== 'closed')!,
    subjects: () => channel.sent.map((s) => s.message.subject),
  };
}

describe('notifications : ouverture d\'un incident', () => {
  it('previent le niveau 1 seulement, avec le contenu utile', async () => {
    const t = setup();
    t.send('D-06', 'alarm');
    await t.notifier.notifyIncident(t.incident('D-06'), 'opened');
    assert.equal(t.channel.sent.length, 1);
    const { to, message } = t.channel.sent[0];
    assert.equal(to, 'a');
    assert.match(message.subject, /ALARME - a confirmer - Detecteur atelier/);
    assert.match(message.text, /Zone : Atelier/);
    assert.match(message.text, /NON ACQUITTEE/);
    assert.match(message.text, /Cameras : Camera entrepot, Camera atelier/);
  });

  it("une alarme « a confirmer » est notifiee quand meme : les regles anti-fausses alarmes ne font jamais taire", async () => {
    const t = setup();
    t.send('D-01', 'alarm'); // isolee : a confirmer
    assert.equal(t.incident('D-01').confirmedAt, null);
    await t.notifier.notifyIncident(t.incident('D-01'), 'opened');
    assert.equal(t.channel.sent.length, 1, 'notifiee');
    assert.match(t.channel.sent[0].message.text, /A confirmer .* a traiter quand meme/);
  });

  it('une alarme confirmee le dit clairement', async () => {
    const t = setup({ confirmWindowMs: 60 * S });
    t.send('D-06', 'prealarm');
    t.send('D-05', 'prealarm');
    await t.notifier.notifyIncident(t.incident('D-06'), 'confirmed');
    assert.match(t.channel.sent[0].message.subject, /ALARME CONFIRMEE/);
    assert.match(t.channel.sent[0].message.text, /Confirmee : detecteur voisin D-05/);
  });

  it('un detecteur muet previent le niveau 1', async () => {
    const t = setup();
    await t.notifier.notifySilent(t.engine.getDevice('D-02')!);
    assert.match(t.channel.sent[0].message.subject, /DETECTEUR HORS LIGNE - Detecteur bureaux/);
    assert.match(t.channel.sent[0].message.text, /plus signe de vie/);
  });
});

describe('notifications : escalade', () => {
  it('previent le niveau 2 quand personne n\'acquitte, une seule fois', async () => {
    const t = setup();
    t.send('D-06', 'alarm');
    t.advance(179);
    t.notifier.tick();
    await flush();
    assert.equal(t.channel.sent.length, 0, 'pas avant le delai');
    t.advance(2);
    t.notifier.tick();
    t.notifier.tick(); // le controle repasse : aucun doublon
    await flush();
    assert.equal(t.channel.sent.length, 1);
    assert.equal(t.channel.sent[0].to, 'boss');
    assert.match(t.channel.sent[0].message.subject, /NON ACQUITTEE depuis 3 min/);
    assert.ok(t.engine.listAudit(50).some((a) => a.action === 'notification_escalated'));
  });

  it('envoie des rappels aux deux niveaux, en nombre plafonne', async () => {
    const t = setup({ maxReminders: 2 });
    t.send('D-06', 'alarm');
    t.advance(181);
    t.notifier.tick();
    await flush();
    for (let i = 0; i < 6; i++) {
      t.advance(301);
      t.notifier.tick();
      await flush();
    }
    const reminders = t.subjects().filter((s) => /RAPPEL/.test(s));
    assert.equal(reminders.length, 4, '2 rappels x 2 niveaux (a et boss)');
    assert.deepEqual([...new Set(t.channel.sent.filter((s) => /RAPPEL/.test(s.message.subject)).map((s) => s.to))].sort(), ['a', 'boss']);
  });

  it("l'acquittement arrete tout", async () => {
    const t = setup();
    t.send('D-06', 'alarm');
    t.advance(100);
    t.engine.acknowledge(t.incident('D-06').id, 'operateur');
    t.advance(1000);
    t.notifier.tick();
    await flush();
    assert.equal(t.channel.sent.length, 0);
  });

  it("un incident clos n'escalade pas", async () => {
    const t = setup();
    t.send('D-06', 'alarm');
    t.send('D-06', 'normal');
    t.engine.close(t.incident('D-06').id, 'operateur', 'false_alarm', '');
    t.advance(1000);
    t.notifier.tick();
    await flush();
    assert.equal(t.channel.sent.length, 0);
  });

  it('une confirmation qui rouvre un incident acquitte relance le compte a rebours', async () => {
    const t = setup({ confirmWindowMs: 60 * S });
    t.send('D-06', 'prealarm');
    t.engine.acknowledge(t.incident('D-06').id, 'operateur');
    t.advance(500); // longtemps acquitte : aucune escalade
    t.notifier.tick();
    await flush();
    assert.equal(t.channel.sent.length, 0);
    t.send('D-05', 'prealarm'); // confirme D-06 : l'incident redevient « non acquitte »
    assert.equal(t.incident('D-06').status, 'open');
    t.advance(100);
    t.notifier.tick();
    await flush();
    assert.equal(t.channel.sent.length, 0, '100 s seulement depuis la confirmation');
    t.advance(100);
    t.notifier.tick();
    await flush();
    assert.ok(t.channel.sent.some((s) => s.to === 'boss'), 'escalade 180 s apres la confirmation');
  });

  it("sans destinataire de niveau 2, ou escalade desactivee, ne fait rien", async () => {
    const solo = fakeChannel('chat', ['a'], []);
    const t = setup({ channels: [solo] });
    t.send('D-06', 'alarm');
    t.advance(1000);
    t.notifier.tick();
    await flush();
    assert.equal(solo.sent.length, 0);
    const off = setup({ escalateAfterS: 0 });
    off.send('D-06', 'alarm');
    off.advance(100_000);
    off.notifier.tick();
    await flush();
    assert.equal(off.channel.sent.length, 0);
  });
});

describe('notifications : fiabilite', () => {
  it("reessaie apres un echec passager et finit par envoyer", async () => {
    const t = setup();
    t.channel.failures.set('a', 2);
    t.send('D-06', 'alarm');
    await t.notifier.notifyIncident(t.incident('D-06'), 'opened');
    assert.equal(t.channel.sent.length, 1);
    assert.equal(t.channel.attempts, 3);
    assert.equal(t.notifier.status().sentLast24h, 1);
  });

  it("apres 3 echecs : journal et audit, sans secret, et l'autre canal n'est pas affecte", async () => {
    const broken = fakeChannel('mail', ['x'], []);
    broken.failures.set('x', Infinity);
    const good = fakeChannel('chat', ['a'], []);
    const t = setup({ channels: [broken, good] });
    t.send('D-06', 'alarm');
    await t.notifier.notifyIncident(t.incident('D-06'), 'opened');
    assert.equal(good.sent.length, 1, "l'autre canal a bien envoye");
    const audit = t.engine.listAudit(50).find((a) => a.action === 'notification_failed');
    assert.ok(audit, "l'echec est visible au journal");
    assert.match(audit.details ?? '', /3 tentatives/);
    assert.ok(!JSON.stringify(t.engine.listAudit(50)).includes('secret-jeton-123'), 'jeton masque dans le journal');
    const status = t.notifier.status();
    assert.equal(status.failedLast24h, 1);
    assert.ok(!JSON.stringify(status).includes('secret-jeton-123'), 'jeton masque dans le statut');
    assert.equal(t.incident('D-06').severity, 'critical', "l'alarme elle-meme n'est pas touchee");
  });

  it("ne leve jamais d'exception, meme sans aucun canal", async () => {
    const t = setup({ channels: [] });
    t.send('D-06', 'alarm');
    await t.notifier.notifyIncident(t.incident('D-06'), 'opened');
    t.advance(1000);
    t.notifier.tick();
    assert.deepEqual(await t.notifier.test(), []);
  });

  it('le test envoie une seule tentative a tous les destinataires et rapporte chaque resultat', async () => {
    const t = setup();
    t.channel.failures.set('boss', 5);
    const results = await t.notifier.test();
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((r) => [r.recipient, r.level, r.ok]).sort(), [['<a>', 1, true], ['<boss>', 2, false]]);
    assert.equal(t.channel.attempts, 2, 'pas de reprise pour un test');
    assert.ok(!results.some((r) => /secret-jeton-123/.test(r.error ?? '')));
  });
});

describe('notifications : images en complement', () => {
  it("envoie les images prises a l'etape, apres le texte, aux destinataires de niveau 1", async () => {
    const t = setup();
    t.db.prepare("UPDATE device SET stream_kind = 'rtsp' WHERE id IN ('C-04', 'C-05')").run();
    t.send('D-06', 'alarm');
    const id = t.incident('D-06').id;
    for (const camera of ['C-04', 'C-05']) {
      t.db.prepare("INSERT INTO incident_snapshot (incident_id, camera_id, taken_at, reason, file) VALUES (?, ?, ?, 'opened', 'x.jpg')").run(id, camera, T0);
    }
    t.db.prepare("INSERT INTO incident_snapshot (incident_id, camera_id, taken_at, reason, file) VALUES (?, 'C-04', ?, 'escalated', 'y.jpg')").run(id, T0);
    await t.notifier.sendImages(id, 'opened');
    assert.equal(t.channel.images.length, 1);
    assert.equal(t.channel.images[0].to, 'a');
    assert.equal(t.channel.images[0].images.length, 2, "seulement celles de l'etape « opened »");
    assert.deepEqual(t.channel.images[0].images[0].data, JPEG);
  });
});

// ---------------------------------------------------------------- vrais canaux contre de faux serveurs

function fakeSmtp(): Promise<{ port: number; mails: { to: string[]; data: string }[]; close: () => Promise<void> }> {
  const mails: { to: string[]; data: string }[] = [];
  const server = createTcpServer((socket) => {
    let to: string[] = [];
    let data = '';
    let inData = false;
    socket.write('220 fake ESMTP\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          mails.push({ to, data });
          socket.write('250 OK queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        if (/^EHLO|^HELO/i.test(line)) socket.write('250-fake\r\n250 8BITMIME\r\n');
        else if (/^MAIL FROM/i.test(line)) socket.write('250 OK\r\n');
        else if (/^RCPT TO/i.test(line)) {
          to.push(/<([^>]+)>/.exec(line)?.[1] ?? '');
          socket.write('250 OK\r\n');
        } else if (/^DATA/i.test(line)) {
          inData = true;
          socket.write('354 go\r\n');
        } else if (/^RSET/i.test(line)) {
          to = [];
          socket.write('250 OK\r\n');
        } else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as AddressInfo).port, mails, close: () => new Promise((r) => void server.close(() => r())) }),
    ),
  );
}

const message: Message = { kind: 'opened', incidentId: 7, subject: '[PSIM] ALARME - Detecteur atelier', text: 'Zone : Atelier\nNON ACQUITTEE', data: { severity: 'critical' } };

describe('canal e-mail (faux serveur SMTP)', () => {
  it('envoie le message au destinataire, avec objet et corps', async () => {
    const smtp = await fakeSmtp();
    const channel = emailChannel({ host: '127.0.0.1', port: smtp.port, secure: false, user: '', password: '', from: 'psim@exemple.test', starttls: false }, [['agent@exemple.test'], []])!;
    await channel.send(message, 'agent@exemple.test');
    await smtp.close();
    assert.equal(smtp.mails.length, 1);
    assert.deepEqual(smtp.mails[0].to, ['agent@exemple.test']);
    assert.match(smtp.mails[0].data, /Subject: \[PSIM\] ALARME - Detecteur atelier/);
    assert.match(smtp.mails[0].data, /NON ACQUITTEE/);
    assert.equal(channel.mask('agent@exemple.test'), 'a***@exemple.test');
  });

  it('joint les images en complement', async () => {
    const smtp = await fakeSmtp();
    const channel = emailChannel({ host: '127.0.0.1', port: smtp.port, secure: false, user: '', password: '', from: 'psim@exemple.test', starttls: false }, [['agent@exemple.test'], []])!;
    await channel.sendImages!(message, 'agent@exemple.test', [{ caption: 'Camera atelier - 19:45:46', data: JPEG }]);
    await smtp.close();
    assert.match(smtp.mails[0].data, /Content-Type: image\/jpeg/);
    assert.match(smtp.mails[0].data, /filename=1-Camera_atelier_-_19_45_46\.jpg/);
  });

  it("une panne du serveur est rapportee comme une erreur, sans planter", async () => {
    const channel = emailChannel({ host: '127.0.0.1', port: 1, secure: false, user: '', password: '', from: 'psim@exemple.test', starttls: false }, [['a@b.test'], []])!;
    await assert.rejects(channel.send(message, 'a@b.test'));
  });

  it('n\'existe pas sans serveur ni expediteur configures', () => {
    assert.equal(emailChannel({ host: '', port: 25, secure: false, user: '', password: '', from: 'x@y.z' }, [[], []]), null);
  });
});

function fakeHttp(handler: (req: IncomingMessage, body: Buffer, status: { code: number }) => unknown) {
  const calls: { url: string; headers: IncomingMessage['headers']; body: Buffer }[] = [];
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      calls.push({ url: req.url ?? '', headers: req.headers, body });
      const status = { code: 200 };
      const payload = handler(req, body, status);
      res.writeHead(status.code, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload ?? { ok: true }));
    });
  });
  return new Promise<{ base: string; calls: typeof calls; close: () => Promise<void> }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => new Promise((r) => (server.close(() => r()), server.closeAllConnections())) }),
    ),
  );
}

describe('canal Telegram (faux serveur)', () => {
  it('envoie le texte puis les photos', async () => {
    const api = await fakeHttp(() => ({ ok: true }));
    const channel = telegramChannel({ token: 'TOKEN123456', apiBase: api.base }, [['42'], []])!;
    await channel.send(message, '42');
    await channel.sendImages!(message, '42', [{ caption: 'Camera atelier', data: JPEG }]);
    await api.close();
    assert.equal(api.calls[0].url, '/botTOKEN123456/sendMessage');
    const text = JSON.parse(api.calls[0].body.toString());
    assert.equal(text.chat_id, '42');
    assert.match(text.text, /ALARME - Detecteur atelier/);
    assert.equal(api.calls[1].url, '/botTOKEN123456/sendPhoto');
    assert.match(String(api.calls[1].headers['content-type']), /multipart\/form-data/);
    assert.ok(api.calls[1].body.includes(JPEG), 'les octets du JPEG sont envoyes');
  });

  it('une serie d images part en un seul album (pas un message par photo)', async () => {
    const api = await fakeHttp(() => ({ ok: true }));
    const channel = telegramChannel({ token: 'TOKEN123456', apiBase: api.base }, [['42'], []])!;
    const images = [1, 2, 3, 4, 5].map((n) => ({ caption: `Escalier - 16:26:2${n}`, data: JPEG }));
    await channel.sendImages!(message, '42', images);
    await api.close();
    assert.equal(api.calls.length, 1, 'un seul appel');
    assert.equal(api.calls[0].url, '/botTOKEN123456/sendMediaGroup');
    const body = api.calls[0].body.toString('latin1');
    const media = JSON.parse(/name="media"\r\n\r\n([^\r]+)/.exec(body)![1]) as { type: string; media: string; caption: string }[];
    assert.deepEqual(media.map((m) => m.media), ['attach://photo0', 'attach://photo1', 'attach://photo2', 'attach://photo3', 'attach://photo4']);
    assert.ok(media.every((m) => m.type === 'photo'));
    assert.equal(media[4].caption, 'Escalier - 16:26:25', 'chaque photo garde son heure');
    assert.equal(body.split('name="photo').length - 1, 5, 'les 5 fichiers sont joints');
  });

  it("une erreur de l'API ou une panne reseau ne revele jamais le jeton", async () => {
    const api = await fakeHttp((_req, _body, status) => {
      status.code = 401;
      return { ok: false, description: 'Unauthorized' };
    });
    const channel = telegramChannel({ token: 'TOKEN123456', apiBase: api.base }, [['42'], []])!;
    await assert.rejects(channel.send(message, '42'), (e: Error) => /HTTP 401 : Unauthorized/.test(e.message) && !e.message.includes('TOKEN123456'));
    await api.close();
    const down = telegramChannel({ token: 'TOKEN123456', apiBase: 'http://127.0.0.1:1' }, [['42'], []])!;
    await assert.rejects(down.send(message, '42'), (e: Error) => !e.message.includes('TOKEN123456') && /injoignable/.test(e.message));
  });

  it('n\'existe pas sans jeton', () => assert.equal(telegramChannel({ token: '', apiBase: 'x' }, [[], []]), null));
});

describe('canal webhook (faux serveur)', () => {
  it('envoie un JSON signe (HMAC SHA-256) et n\'affiche que l\'hote', async () => {
    const api = await fakeHttp(() => ({ ok: true }));
    const url = `${api.base}/hooks/jeton-secret-dans-le-chemin`;
    const channel = webhookChannel({ secret: 'cle-partagee' }, [[url], []])!;
    await channel.send(message, url);
    await api.close();
    const call = api.calls[0];
    const body = JSON.parse(call.body.toString());
    assert.equal(body.event, 'opened');
    assert.equal(body.incidentId, 7);
    assert.equal(body.severity, 'critical');
    const expected = `sha256=${createHmac('sha256', 'cle-partagee').update(call.body).digest('hex')}`;
    assert.equal(call.headers['x-psim-signature'], expected);
    assert.equal(channel.mask(url), api.base.replace('http://', ''), "ni chemin ni jeton dans l'affichage");
  });

  it('refuse les adresses qui ne sont pas http(s), et signale un statut d\'erreur', async () => {
    const none = webhookChannel({ secret: '' }, [['ftp://x', 'javascript:alert(1)', 'pas une url', 'file:///etc/passwd'], []]);
    assert.deepEqual(none.recipients(1), [], "aucune adresse invalide n'est retenue");
    assert.deepEqual(webhookChannel({ secret: '' }, [['ftp://x', 'https://ok.test/h'], []]).recipients(1), ['https://ok.test/h']);
    const api = await fakeHttp((_r, _b, status) => void (status.code = 500));
    const channel = webhookChannel({ secret: '' }, [[`${api.base}/h`], []])!;
    await assert.rejects(channel.send(message, `${api.base}/h`), /Webhook HTTP 500/);
    await api.close();
  });
});

describe('boite de reception de la demo', () => {
  it('recoit e-mails (objets accentues decodes, pieces jointes comptees) et messages Telegram', async () => {
    const { startInbox } = await import('../scripts/demo/inbox.ts');
    const lines: string[] = [];
    const inbox = await startInbox((l) => lines.push(l));
    const mail = emailChannel({ host: '127.0.0.1', port: inbox.smtpPort, secure: false, user: '', password: '', from: 'psim@demo.test', starttls: false }, [['operateur@demo.test'], []])!;
    const chat = telegramChannel({ token: 'TOK123456789', apiBase: inbox.telegramBase }, [['111'], []])!;
    const accented: Message = { ...message, subject: '[PSIM] PRÉALARME - Détecteur accueil' };
    await mail.send(accented, 'operateur@demo.test');
    await mail.sendImages!(accented, 'operateur@demo.test', [{ caption: 'Camera A', data: JPEG }, { caption: 'Camera B', data: JPEG }]);
    await chat.send(accented, '111');
    await chat.sendImages!(accented, '111', [{ caption: 'Camera A - 19:45', data: JPEG }]);
    await inbox.close();
    assert.ok(lines.some((l) => l.includes('[courrier]') && l.includes('[PSIM] PRÉALARME - Détecteur accueil')), 'objet accentue decode');
    assert.ok(lines.some((l) => l.includes('+2 images jointes')));
    assert.ok(lines.some((l) => l.includes('[telegram]') && l.includes('chat 111') && l.includes('PRÉALARME')));
    assert.ok(lines.some((l) => l.includes('(photo) Camera A - 19:45')));
    assert.equal(inbox.received.length, 4);
  });
});
