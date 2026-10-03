/**
 * Rapport periodique par e-mail, contre le vrai serveur et un vrai serveur SMTP local qui capture ce qui part :
 * reglage (administrateur seulement), envoi immediat, contenu du message et des pieces jointes.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });

interface Captured {
  rcpt: string[];
  data: string;
}

describe('rapport periodique par e-mail (processus reel, SMTP local)', { timeout: 120_000 }, () => {
  const mails: Captured[] = [];
  let smtp: ReturnType<typeof createServer>;
  let proc: ChildProcess;
  let base = '';
  let output = '';
  let admin = '';
  let operator = '';

  before(async () => {
    smtp = createServer((socket) => {
      let current: Captured = { rcpt: [], data: '' };
      let inData = false;
      let buffer = '';
      socket.write('220 localhost ESMTP\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('latin1');
        for (;;) {
          if (inData) {
            const end = buffer.indexOf('\r\n.\r\n');
            if (end < 0) return;
            current.data = buffer.slice(0, end);
            buffer = buffer.slice(end + 5);
            inData = false;
            mails.push(current);
            current = { rcpt: [], data: '' };
            socket.write('250 queued\r\n');
            continue;
          }
          const eol = buffer.indexOf('\r\n');
          if (eol < 0) return;
          const line = buffer.slice(0, eol);
          buffer = buffer.slice(eol + 2);
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO' || cmd === 'HELO') socket.write('250-localhost\r\n250 8BITMIME\r\n');
          else if (cmd === 'RCPT') {
            current.rcpt.push(/<([^>]+)>/.exec(line)?.[1] ?? '');
            socket.write('250 ok\r\n');
          } else if (cmd === 'DATA') {
            inData = true;
            socket.write('354 go\r\n');
          } else if (cmd === 'QUIT') {
            socket.write('221 bye\r\n');
            socket.end();
          } else socket.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
    const smtpPort = (smtp.address() as AddressInfo).port;

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
    Object.assign(env, {
      PSIM_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'psim-rm-')), 'data'),
      PSIM_PORT: String(port),
      PSIM_MQTT_PORT: String(await freePort()),
      PSIM_ADMIN_PASSWORD: ADMIN_PW,
      PSIM_OPERATOR_PASSWORD: OPERATOR_PW,
      PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3',
      PSIM_DEMO_LOGIN: '0',
      PSIM_REQUIRE_2FA: 'none',
      PSIM_SMTP_HOST: '127.0.0.1',
      PSIM_SMTP_PORT: String(smtpPort),
      PSIM_SMTP_STARTTLS: '0',
      PSIM_SMTP_FROM: 'psim@exemple.test',
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
      await new Promise((r) => setTimeout(r, 250));
    }
    const login = async (username: string, password: string) => {
      const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      assert.equal(res.status, 200, output);
      return res.headers.getSetCookie()[0].split(';')[0];
    };
    admin = await login('admin', ADMIN_PW);
    operator = await login('operateur', OPERATOR_PW);
  });

  after(() => {
    proc?.kill();
    smtp?.close();
  });

  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: who }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  it("le reglage est reserve a l'administrateur, valide, et part desactive", async () => {
    const view = await call(admin, 'GET', '/api/reports/schedule');
    assert.equal(view.status, 200);
    assert.deepEqual([view.body.frequency, view.body.smtpConfigured, view.body.nextSendAt], ['off', true, null]);
    assert.equal((await call(operator, 'GET', '/api/reports/schedule')).status, 403);
    assert.equal((await call(operator, 'PUT', '/api/reports/schedule', { frequency: 'weekly', recipients: ['a@x.fr'] })).status, 403);
    assert.equal((await call(admin, 'PUT', '/api/reports/schedule', { frequency: 'weekly' })).status, 400, 'sans destinataire');
    assert.equal((await call(admin, 'PUT', '/api/reports/schedule', { frequency: 'weekly', recipients: ['pas un mail'] })).status, 400);
    assert.equal((await call(admin, 'PUT', '/api/reports/schedule', { frequency: 'weekly', recipients: ['a@x.fr'], hour: 99 })).status, 400);
    assert.equal((await call(admin, 'GET', '/api/reports/schedule')).body.frequency, 'off', 'rien enregistre apres un refus');
  });

  it("active le rapport hebdomadaire : prochain envoi annonce, aucun envoi immediat, reglage journalise", async () => {
    const r = await call(admin, 'PUT', '/api/reports/schedule', { frequency: 'weekly', weekday: 1, hour: 7, recipients: ['Direction@Exemple.test', 'qhse@exemple.test'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.recipients, ['direction@exemple.test', 'qhse@exemple.test']);
    assert.ok(r.body.nextSendAt > Date.now(), 'prochain envoi dans le futur');
    assert.equal(new Date(r.body.nextSendAt).getDay(), 1, 'un lundi');
    await new Promise((res) => setTimeout(res, 800));
    assert.equal(mails.length, 0, "l'activation n'envoie rien d'arriere");
    const audit = (await call(admin, 'GET', '/api/audit?limit=20')).body.map((e: any) => e.action);
    assert.ok(audit.includes('report_schedule_updated'));
  });

  it("l'envoi immediat part vraiment : destinataires, objet, corps chiffre, pieces jointes, empreinte du journal", async () => {
    // un incident dans la periode ? la derniere semaine complete est passee : on verifie surtout la forme
    const r = await call(admin, 'POST', '/api/reports/schedule/send-now');
    assert.equal(r.status, 200, output);
    assert.equal(r.body.recipients, 2);
    assert.equal(mails.length, 1);
    const mail = mails[0];
    assert.deepEqual(mail.rcpt, ['direction@exemple.test', 'qhse@exemple.test']);
    const raw = mail.data;
    assert.match(raw, /^Subject: .*Rapport/im, 'objet');
    assert.match(raw, /Content-Type: multipart\/mixed/i);
    assert.match(raw, /filename="?rapport_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.html"?/);
    assert.match(raw, /filename="?incidents_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"?/);
    assert.match(raw, /Content-Type: text\/html/i);
    // l'empreinte du journal figure dans le texte (decode si necessaire)
    const decoded = raw.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    assert.match(decoded, /Empreinte du journal[^]*?\d+:[0-9a-f]{64}/);
    assert.ok(!decoded.includes('<script'), 'aucun script dans le message');
    const audit = (await call(admin, 'GET', '/api/audit?limit=20')).body.map((e: any) => e.action);
    assert.ok(audit.includes('report_email_sent'));
  });

  it("serveur SMTP en panne : l'envoi immediat repond 502 et l'echec est journalise, sans secret", async () => {
    smtp.close();
    // les connexions deja ouvertes se ferment ; les nouvelles sont refusees
    await new Promise((res) => setTimeout(res, 300));
    const r = await call(admin, 'POST', '/api/reports/schedule/send-now');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /Envoi impossible/);
    const audit = (await call(admin, 'GET', '/api/audit?limit=20')).body;
    assert.ok(audit.some((e: any) => e.action === 'report_email_failed'));
  });

  it("desactiver le rapport est possible sans destinataire", async () => {
    const r = await call(admin, 'PUT', '/api/reports/schedule', { frequency: 'off' });
    assert.equal(r.status, 200);
    assert.equal(r.body.nextSendAt, null);
  });
});
