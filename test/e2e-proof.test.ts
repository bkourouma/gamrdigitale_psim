/**
 * Dossier de preuve contre le vrai serveur : telechargement reserve aux comptes connectes, incident inexistant = 404,
 * zip relu et verifie hors ligne, export inscrit au journal avec l'empreinte du zip livre, debit limite.
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
import { verifyProof } from '../scripts/verify-proof.ts';
import { sha256hex } from '../server/proofformat.ts';
import { readZip } from '../server/zip.ts';

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';
const TOKEN = 'jeton-equipements-0123456789abcdef';

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
  Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]),
  Buffer.alloc(64, 0x42),
  Buffer.from([0xff, 0xd9]),
]);

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });

async function start(): Promise<{ proc: ChildProcess; base: string; output: () => string }> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const root = mkdtempSync(join(tmpdir(), 'psim-e2e-proof-'));
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    PSIM_DATA_DIR: join(root, 'data'),
    PSIM_BACKUP_DIR: join(root, 'backups'),
    PSIM_PORT: String(port),
    PSIM_MQTT_PORT: String(await freePort()),
    PSIM_ADMIN_PASSWORD: ADMIN_PW,
    PSIM_OPERATOR_PASSWORD: OPERATOR_PW,
    PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3',
    PSIM_DEMO_LOGIN: '0',
    PSIM_REQUIRE_2FA: 'none',
    PSIM_INGEST_TOKEN: TOKEN,
  });
  let output = '';
  const proc = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (d) => (output += d));
  proc.stderr!.on('data', (d) => (output += d));
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).status === 200) return { proc, base, output: () => output };
    } catch {
      // pas encore pret
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error(`serveur non demarre :\n${output}`);
}

async function login(base: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie()[0].split(';')[0];
}

describe('dossier de preuve (processus reel)', { timeout: 120_000 }, () => {
  let s: Awaited<ReturnType<typeof start>>;
  let admin = '';
  let operator = '';
  let incidentId = 0;

  const api = async (method: string, path: string, cookie: string | null, body?: unknown) => {
    const res = await fetch(`${s.base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const proof = (id: number | string, cookie: string | null) => fetch(`${s.base}/api/incidents/${id}/proof`, { headers: cookie ? { Cookie: cookie } : {} });

  before(async () => {
    s = await start();
    admin = await login(s.base, 'admin', ADMIN_PW);
    operator = await login(s.base, 'operateur', OPERATOR_PW);
    // Un incident reel avec une image d'equipement scellee.
    const { body: k } = await api('POST', '/api/device-keys', admin, { label: 'Camera 4G', devices: ['D-01'] });
    const sent = await fetch(`${s.base}/api/ingest/D-01/image`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${k.key}` }, body: JPEG });
    assert.equal(sent.status, 202, await sent.clone().text());
    const alarm = await fetch(`${s.base}/api/ingest/D-01`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k.key}` }, body: JSON.stringify({ state: 'alarm' }) });
    assert.equal(alarm.status, 204);
    for (let i = 0; i < 60 && !incidentId; i++) {
      const snap = await api('GET', '/api/state', operator);
      const inc = snap.body.incidents.find((x: { detectorId: string; snapshots: unknown[] }) => x.detectorId === 'D-01' && x.snapshots.length > 0);
      if (inc) incidentId = inc.id;
      else await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(incidentId, s.output().slice(-500));
    assert.equal((await api('POST', `/api/incidents/${incidentId}/ack`, operator)).status, 200);
  });
  after(() => s?.proc.kill());

  it("sans session : 401 ; incident inexistant ou identifiant invalide : 404 et aucune trace d'export", async () => {
    assert.equal((await proof(incidentId, null)).status, 401);
    for (const id of [99999, 'abc', '0', '-1', '1e3', '1.5']) assert.equal((await proof(id, operator)).status, 404, String(id));
    const audit = await api('GET', '/api/audit?limit=500', admin);
    assert.ok(!audit.body.some((a: { action: string }) => a.action === 'export_preuve'));
  });

  it("l'operateur telecharge le zip : en-tetes sobres, nom genere par le serveur, contenu verifiable hors ligne", async () => {
    const res = await proof(incidentId, operator);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.match(res.headers.get('content-disposition') ?? '', new RegExp(`^attachment; filename="dossier-preuve-incident-${incidentId}-\\d{8}-\\d{6}\\.zip"$`));
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const zip = Buffer.from(await res.arrayBuffer());
    assert.equal(zip.length, Number(res.headers.get('content-length')));
    const files = readZip(zip);
    assert.ok(files.has('LISEZ-MOI.txt') && files.has('MANIFEST.sha256') && files.has('rapport.html'));
    const image = [...files].find(([n]) => n.startsWith('images/'));
    assert.ok(image, "image de l'equipement dans le dossier");
    assert.deepEqual(image![1], JPEG);
    const d = JSON.parse(files.get('incident.json')!.toString('utf8'));
    assert.equal(d.equipement.id, 'D-01');
    assert.equal(d.incident.accuse.par, 'operateur');
    assert.deepEqual(d.images.map((i: { source: string }) => i.source), ['equipement']);
    const v = verifyProof(zip);
    assert.equal(v.ok, true, JSON.stringify(v));

    // L'export est inscrit au journal (qui, quel incident, empreinte du zip LIVRE).
    const audit = await api('GET', '/api/audit?limit=500', admin);
    const entry = audit.body.find((a: { action: string }) => a.action === 'export_preuve');
    assert.ok(entry, 'export_preuve au journal');
    assert.equal(entry.actor, 'operateur');
    assert.equal(entry.incidentId, incidentId);
    assert.ok(entry.details.includes(`sha256=${sha256hex(zip)}`), entry.details);
    assert.equal(verifyProof(zip, [], sha256hex(zip)).ok, true);
  });

  it("l'administrateur aussi", async () => {
    const res = await proof(incidentId, admin);
    assert.equal(res.status, 200);
    const v = verifyProof(Buffer.from(await res.arrayBuffer()));
    assert.equal(v.ok, true, JSON.stringify(v));
  });

  it('debit limite par compte : 429 avec Retry-After apres quelques exports rapproches', async () => {
    let limited: Response | null = null;
    for (let i = 0; i < 12 && !limited; i++) {
      const res = await proof(incidentId, operator);
      if (res.status === 429) limited = res;
      else await res.arrayBuffer();
    }
    assert.ok(limited, 'au moins un 429');
    assert.ok(Number(limited!.headers.get('retry-after')) >= 1);
    assert.equal((await proof(incidentId, admin)).status, 200, "un autre compte n'est pas touche");
  });
});
