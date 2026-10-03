/**
 * Reprise apres panne, contre le vrai serveur : un PSIM tue sans prevenir, relance, doit dire qu'il a ete aveugle
 * (journal, avertissement, notification) ; un arret propre ne doit pas etre pris pour un plantage ; le signal de
 * supervision externe doit partir.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await condition()) && Date.now() - start < timeoutMs) await wait(50);
}

describe('reprise apres panne (processus reel)', { timeout: 180_000 }, () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'psim-res-')), 'data');
  const hits: { url: string; body: string }[] = [];
  let collector: ReturnType<typeof createHttpServer>;
  let collectorPort = 0;
  let proc: ChildProcess | null = null;
  let output = '';
  let base = '';

  async function startPsim(): Promise<void> {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
    Object.assign(env, {
      PSIM_DATA_DIR: dataDir,
      PSIM_PORT: String(port),
      PSIM_MQTT_PORT: String(await freePort()),
      PSIM_ADMIN_PASSWORD: ADMIN_PW,
      PSIM_OPERATOR_PASSWORD: OPERATOR_PW,
      PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3',
      PSIM_DEMO_LOGIN: '0',
      PSIM_REQUIRE_2FA: 'none',
      PSIM_HEARTBEAT_URL: `http://127.0.0.1:${collectorPort}/ping/jeton-secret-xyz`,
      PSIM_HEARTBEAT_EVERY_S: '1',
      PSIM_GAP_NOTIFY_S: '1',
      PSIM_NOTIFY_WEBHOOK_L1: `http://127.0.0.1:${collectorPort}/hook`,
    });
    output = '';
    // Canal IPC : permet la demande d'arret propre, comme le fait le superviseur.
    proc = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    proc.stdout!.on('data', (d) => (output += d));
    proc.stderr!.on('data', (d) => (output += d));
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).status === 200) return;
      } catch {
        // pas encore pret
      }
      await wait(250);
    }
    throw new Error(`serveur non demarre :\n${output}`);
  }

  async function adminCookie(): Promise<string> {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PW }) });
    assert.equal(res.status, 200);
    return res.headers.getSetCookie()[0].split(';')[0];
  }

  const audit = async (cookie: string): Promise<{ action: string; details: string | null }[]> => (await (await fetch(`${base}/api/audit?limit=200`, { headers: { Cookie: cookie } })).json()) as never;

  before(async () => {
    collector = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits.push({ url: req.url ?? '', body });
        res.writeHead(200).end('OK');
      });
    });
    await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
    collectorPort = (collector.address() as AddressInfo).port;
  });

  after(() => {
    proc?.kill();
    collector?.close();
  });

  it("premier demarrage : aucune periode aveugle, et le signal de supervision externe part des le lancement", async () => {
    await startPsim();
    await until(() => hits.some((h) => h.url === '/ping/jeton-secret-xyz'));
    assert.ok(hits.some((h) => h.url === '/ping/jeton-secret-xyz'), 'signal recu par le service externe');
    const cookie = await adminCookie();
    assert.ok(!(await audit(cookie)).some((a) => a.action === 'supervision_gap'), 'rien a signaler au premier demarrage');
    assert.ok(!output.includes('jeton-secret-xyz'), "l'adresse de supervision (jeton) ne figure pas dans les journaux");
    assert.match(output, /supervision externe : signal toutes les 1 s vers 127\.0\.0\.1/);
    const system = (await (await fetch(`${base}/api/system`, { headers: { Cookie: cookie } })).json()) as { heartbeat: { host: string; consecutiveFailures: number } };
    assert.equal(system.heartbeat.consecutiveFailures, 0);
    assert.ok(!JSON.stringify(system).includes('jeton-secret-xyz'));
  });

  it("un PSIM TUE sans prevenir, puis relance : periode aveugle journalisee, signalee a l'ecran et notifiee", async () => {
    await wait(1500); // laisse un signe de vie s'inscrire
    proc!.kill('SIGKILL'); // arret brutal : aucun gestionnaire n'a la main
    await until(() => proc!.exitCode !== null || proc!.signalCode !== null);
    hits.length = 0;
    await wait(2500); // la « panne »
    await startPsim();
    const cookie = await adminCookie();
    const entries = await audit(cookie);
    const gap = entries.find((a) => a.action === 'supervision_gap');
    assert.ok(gap, 'la periode aveugle est inscrite au journal');
    assert.match(gap!.details ?? '', /arret INATTENDU/);
    assert.match(output, /REDEMARRAGE APRES ARRET INATTENDU/);

    const system = (await (await fetch(`${base}/api/system`, { headers: { Cookie: cookie } })).json()) as { warnings: { message: string }[]; continuity: { lastGap: { clean: boolean; durationMs: number } } };
    assert.ok(system.warnings.some((w) => /arret inattendu/.test(w.message)), "l'avertissement est visible dans l'etat systeme");
    assert.equal(system.continuity.lastGap.clean, false);
    assert.ok(system.continuity.lastGap.durationMs >= 2000, `duree : ${system.continuity.lastGap.durationMs} ms`);

    await until(() => hits.some((h) => h.url === '/hook'));
    const alert = hits.find((h) => h.url === '/hook');
    assert.ok(alert, 'la notification de redemarrage est partie');
    const payload = JSON.parse(alert!.body);
    assert.equal(payload.event, 'restart');
    assert.match(payload.subject, /SURVEILLANCE INTERROMPUE/);
    assert.match(payload.text, /INATTENDU/);
    assert.match(payload.text, /alarme a pu passer inapercue/);
  });

  it("un arret PROPRE (demande par le superviseur) n'est pas pris pour un plantage au demarrage suivant", async () => {
    const before = (await audit(await adminCookie())).filter((a) => a.action === 'supervision_gap').length;
    const exited = new Promise<number | null>((r) => proc!.once('exit', (code) => r(code)));
    proc!.send('shutdown');
    assert.equal(await exited, 0, 'sortie propre (code 0)');
    hits.length = 0;
    await wait(1200);
    await startPsim();
    const cookie = await adminCookie();
    const entries = (await audit(cookie)).filter((a) => a.action === 'supervision_gap');
    assert.equal(entries.length, before, 'un redemarrage propre et court ne cree pas de periode aveugle');
    assert.ok(!hits.some((h) => h.url === '/hook'), 'aucune notification pour un arret volontaire court');
    assert.ok(!/REDEMARRAGE APRES ARRET INATTENDU/.test(output));
  });
});
