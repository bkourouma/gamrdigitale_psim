/**
 * Detecteurs de fumee WiFi Tuya / Smart Life : un faux cloud Tuya (signature des requetes verifiee, jeton, lecture groupee)
 * alimente des detecteurs incendie du PSIM. Aucun appareil ni cloud reel n'est contacte.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { seedDemo } from '../server/seed.ts';
import { createTuya, createTuyaClient, readDevice, TUYA_SUPERVISION_S } from '../server/tuya.ts';
import type { TuyaDevice } from '../server/tuya.ts';

const ROOT = resolve(import.meta.dirname, '..');
const ACCESS_ID = 'abcd1234efgh5678';
const SECRET = 'secret-de-test-0123456789abcdef';
const DEV_A = 'a1b2c3d4e5f6a7b8c9d0e1';
const DEV_B = 'b1b2c3d4e5f6a7b8c9d0e2';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('delai depasse');
    await wait(15);
  }
}

const smoke = (value: string, extra: { code: string; value: unknown }[] = []) => [{ code: 'smoke_sensor_status', value }, ...extra];

/** Faux cloud : recalcule la signature selon la documentation Tuya (independamment du code teste). */
function fakeCloud() {
  const devices = new Map<string, TuyaDevice>();
  const state = { tokens: 0, lists: 0, badSignatures: 0, mode: 'ok' as 'ok' | 'down' | 'denied', batches: [] as number[] };
  const TOKEN = 'tok-0123456789';
  const server = createServer((req, res) => {
    const json = (body: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (state.mode === 'down') return void req.socket.destroy();
    const h = req.headers;
    const isToken = req.url!.startsWith('/v1.0/token');
    const token = isToken ? '' : String(h.access_token ?? '');
    const stringToSign = `GET\n${createHash('sha256').update('').digest('hex')}\n\n${req.url}`;
    const expected = createHmac('sha256', state.mode === 'denied' ? 'autre-secret' : SECRET)
      .update(`${h.client_id}${token}${h.t}${h.nonce}${stringToSign}`)
      .digest('hex')
      .toUpperCase();
    if (h.client_id !== ACCESS_ID || h.sign !== expected || h.sign_method !== 'HMAC-SHA256' || !/^\d{13}$/.test(String(h.t))) {
      state.badSignatures += 1;
      return json({ success: false, code: 1004, msg: 'sign invalid', t: Date.now() });
    }
    if (isToken) {
      state.tokens += 1;
      return json({ success: true, result: { access_token: TOKEN, expire_time: 7200, refresh_token: 'r', uid: 'u' }, t: Date.now() });
    }
    if (token !== TOKEN) return json({ success: false, code: 1010, msg: 'token invalid' });
    const url = new URL(req.url!, 'http://x');
    if (url.pathname !== '/v1.0/devices') return json({ success: false, code: 1108, msg: 'uri path invalid' }, 404);
    const ids = (url.searchParams.get('device_ids') ?? '').split(',').filter(Boolean);
    state.lists += 1;
    state.batches.push(ids.length);
    json({ success: true, result: { devices: ids.map((id) => devices.get(id)).filter(Boolean), total: ids.length }, t: Date.now() });
  });
  return {
    state,
    devices,
    start: () => new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

describe('Tuya : lecture de l\'etat d\'un detecteur de fumee', () => {
  it("fumee -> alarme, meme si l'appareil est hors ligne ; hors ligne sans fumee -> aucun signe de vie ; donnees inconnues -> defaut (jamais « normal »)", () => {
    assert.equal(readDevice({ id: 'x', online: true, status: smoke('alarm') }).kind, 'alarm');
    assert.equal(readDevice({ id: 'x', online: false, status: smoke('alarm') }).kind, 'alarm', 'une alarme lue reste une alarme');
    assert.equal(readDevice({ id: 'x', online: true, status: smoke('normal') }).kind, 'normal');
    assert.equal(readDevice({ id: 'x', online: false, status: smoke('normal') }).kind, 'silent');
    assert.equal(readDevice({ id: 'x', online: true, status: [{ code: 'battery_percentage', value: 90 }] }).kind, 'fault');
    assert.equal(readDevice({ id: 'x', online: true }).kind, 'fault');
    assert.equal(readDevice({ id: 'x', online: true, status: [{ code: 'smoke_sensor_state', value: 'alarm' }] }).kind, 'alarm', 'autre nom de donnee selon le modele');
  });

  it('pile faible (etat ou pourcentage) -> defaut ; pile pleine -> normal', () => {
    assert.deepEqual(readDevice({ id: 'x', online: true, status: smoke('normal', [{ code: 'battery_state', value: 'low' }]) }), { kind: 'fault', reason: 'pile faible' });
    assert.equal(readDevice({ id: 'x', online: true, status: smoke('normal', [{ code: 'battery_percentage', value: 12 }]) }).kind, 'fault');
    assert.equal(readDevice({ id: 'x', online: true, status: smoke('normal', [{ code: 'battery_percentage', value: 80 }, { code: 'battery_state', value: 'high' }]) }).kind, 'normal');
  });
});

describe('Tuya : cloud et detecteurs du PSIM', () => {
  const cloud = fakeCloud();
  let baseUrl = '';
  before(async () => {
    baseUrl = await cloud.start();
  });
  after(() => cloud.stop());

  function setup(opts: { secret?: string; account?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'psim-tuya-'));
    const db = openDb(join(dir, 'psim.db'));
    seedDemo(db, dir, join(ROOT, 'seed'));
    const engine = createEngine(db, () => {}, Date.now, {});
    const audits: string[] = [];
    const realAudit = engine.audit;
    const account = opts.account === false ? null : { accessId: ACCESS_ID, accessSecret: opts.secret ?? SECRET, baseUrl };
    const tuya = createTuya({ db, engine: { ...engine, audit: (a, b, c) => (audits.push(`${b}:${c?.details ?? ''}`), realAudit(a, b, c)) }, account, pollS: 120, log: () => {} });
    const incidents = (id: string) => engine.getSnapshot().incidents.filter((i) => i.detectorId === id && i.status !== 'closed');
    return { db, engine, tuya, audits, incidents };
  }

  it('la fumee lue dans le cloud ouvre un incident incendie ; le retour au calme ramene le detecteur a « normal » ; supervision posee', async () => {
    cloud.devices.set(DEV_A, { id: DEV_A, name: 'Cuisine', online: true, status: smoke('normal', [{ code: 'battery_percentage', value: 90 }]) });
    const t = setup();
    const view = t.tuya.setSource('admin', 'D-01', { deviceId: DEV_A });
    assert.equal(view.tuyaId, DEV_A);
    await until(() => t.tuya.view('D-01').connection?.state === 'connected');
    assert.equal(t.engine.getDevice('D-01')!.status, 'normal');
    assert.equal(t.engine.getDevice('D-01')!.heartbeatS, TUYA_SUPERVISION_S);
    assert.ok(t.audits.some((a) => a === `tuya_source_updated:appareil Tuya ${DEV_A} ; supervision ${TUYA_SUPERVISION_S} s`));
    assert.ok(t.engine.getDevice('D-01')!.lastSeen, 'une lecture reussie vaut signe de vie');

    cloud.devices.set(DEV_A, { id: DEV_A, online: true, status: smoke('alarm') });
    await t.tuya.poll();
    assert.equal(t.engine.getDevice('D-01')!.status, 'alarm');
    assert.equal(t.incidents('D-01').length, 1);
    await t.tuya.poll();
    assert.equal(t.incidents('D-01').length, 1, 'une alarme qui dure ne rouvre pas d\'incident');
    assert.equal(t.tuya.view('D-01').connection?.reading, 'alarm');

    cloud.devices.set(DEV_A, { id: DEV_A, online: true, status: smoke('normal') });
    await t.tuya.poll();
    assert.equal(t.engine.getDevice('D-01')!.status, 'normal');
    t.tuya.stop();
  });

  it('jeton demande une seule fois pour de nombreuses lectures ; 25 appareils = 2 requetes groupees (20 au plus)', async () => {
    const before = { tokens: cloud.state.tokens, lists: cloud.state.lists };
    cloud.state.batches.length = 0;
    const client = createTuyaClient({ accessId: ACCESS_ID, accessSecret: SECRET, baseUrl });
    const ids = Array.from({ length: 25 }, (_, i) => `dev${String(i).padStart(10, '0')}`);
    for (const id of ids) cloud.devices.set(id, { id, online: true, status: smoke('normal') });
    assert.equal((await client.devices(ids)).length, 25);
    await client.devices([ids[0]]);
    await client.devices([ids[1]]);
    assert.equal(cloud.state.tokens - before.tokens, 1);
    assert.deepEqual(cloud.state.batches, [20, 5, 1, 1]);
  });

  it('secret refuse par le cloud : message clair, aucune alarme inventee, le detecteur n\'est plus alimente', async () => {
    const t = setup({ secret: 'mauvais-secret' });
    cloud.devices.set(DEV_B, { id: DEV_B, online: true, status: smoke('alarm') });
    t.tuya.setSource('admin', 'D-02', { deviceId: DEV_B });
    await until(() => t.tuya.view('D-02').connection?.state === 'error');
    assert.match(t.tuya.view('D-02').connection!.error!, /Access ID ou Access Secret incorrect/);
    assert.doesNotMatch(JSON.stringify(t.tuya.view('D-02')), /mauvais-secret/);
    assert.equal(t.incidents('D-02').length, 0);
    assert.equal(t.engine.getDevice('D-02')!.lastSeen, null);
    t.tuya.stop();
  });

  it('cloud injoignable : erreur affichee, rien n\'est envoye au moteur (le detecteur deviendra « hors ligne » par supervision) ; reprise au retour', async () => {
    cloud.devices.set(DEV_A, { id: DEV_A, online: true, status: smoke('normal') });
    const t = setup();
    t.tuya.setSource('admin', 'D-01', { deviceId: DEV_A });
    await until(() => t.tuya.view('D-01').connection?.state === 'connected');
    const seen = t.engine.getDevice('D-01')!.lastSeen;
    cloud.state.mode = 'down';
    await wait(5);
    await t.tuya.poll();
    assert.equal(t.tuya.view('D-01').connection?.state, 'error');
    assert.equal(t.engine.getDevice('D-01')!.lastSeen, seen, 'aucun signe de vie pendant la panne');
    cloud.state.mode = 'ok';
    await wait(5);
    await t.tuya.poll();
    assert.equal(t.tuya.view('D-01').connection?.state, 'connected');
    t.tuya.stop();
  });

  it("appareil hors ligne pour Tuya : aucun signe de vie ; appareil absent du compte : erreur explicite", async () => {
    cloud.devices.set(DEV_A, { id: DEV_A, online: true, status: smoke('normal') });
    const t = setup();
    t.tuya.setSource('admin', 'D-01', { deviceId: DEV_A });
    await until(() => t.tuya.view('D-01').connection?.state === 'connected');
    const seen = t.engine.getDevice('D-01')!.lastSeen!;
    await wait(5);
    cloud.devices.set(DEV_A, { id: DEV_A, online: false, status: smoke('normal') });
    await t.tuya.poll();
    assert.equal(t.tuya.view('D-01').connection?.reading, 'silent');
    assert.equal(t.engine.getDevice('D-01')!.lastSeen, seen);
    cloud.devices.delete(DEV_A);
    await t.tuya.poll();
    assert.match(t.tuya.view('D-01').connection!.error!, /introuvable dans le compte Tuya/);
    t.tuya.stop();
  });

  it('regles : detecteur incendie seulement, un appareil Tuya = un detecteur, compte configure, identifiant valide ; categorie et supervision verrouillees', () => {
    const t = setup();
    assert.throws(() => t.tuya.setSource('admin', 'I-01', { deviceId: DEV_A }), /INCENDIE/);
    assert.throws(() => t.tuya.setSource('admin', 'D-01', { deviceId: 'court' }), /invalide/);
    assert.throws(() => t.tuya.setSource('admin', 'C-01', { deviceId: DEV_A }), /introuvable/);
    t.tuya.setSource('admin', 'D-01', { deviceId: DEV_A });
    assert.throws(() => t.tuya.setSource('admin', 'D-02', { deviceId: DEV_A }), /alimente deja le detecteur D-01/);
    assert.throws(() => t.engine.updateDevice('admin', 'D-01', { category: 'environment' }), /reste un detecteur incendie/);
    assert.throws(() => t.engine.updateDevice('admin', 'D-01', { heartbeatS: 60 }), /supervision d'au moins 300 s/);
    assert.equal(t.engine.updateDevice('admin', 'D-01', { name: 'Cuisine' }).name, 'Cuisine', 'un simple renommage reste possible');
    t.tuya.removeSource('admin', 'D-01');
    assert.equal(t.tuya.view('D-01').tuyaId, null);
    assert.throws(() => t.tuya.removeSource('admin', 'D-01'), /Aucune source/);
    assert.equal(t.engine.updateDevice('admin', 'D-01', { category: 'environment' }).category, 'environment', 'source retiree : categorie libre');
    t.tuya.stop();

    const none = setup({ account: false });
    assert.equal(none.tuya.view('D-01').configured, false);
    assert.throws(() => none.tuya.setSource('admin', 'D-01', { deviceId: DEV_A }), /PSIM_TUYA_ACCESS_ID/);
    none.tuya.stop();
  });

  it("essai : montre les donnees lues (sans rien envoyer au moteur) et explique un appareil inconnu", async () => {
    cloud.devices.set(DEV_A, { id: DEV_A, name: 'Cuisine', online: true, status: smoke('alarm', [{ code: 'battery_state', value: 'high' }]) });
    const t = setup();
    const r = await t.tuya.test(DEV_A);
    assert.equal(r.ok, true);
    assert.equal(r.reading, 'alarm');
    assert.equal(r.name, 'Cuisine');
    assert.deepEqual(r.data, [{ code: 'smoke_sensor_status', value: '"alarm"' }, { code: 'battery_state', value: '"high"' }]);
    assert.equal(t.engine.getDevice('D-01')!.status, 'normal', "un essai n'ouvre jamais d'incident");
    cloud.devices.delete(DEV_B);
    const missing = await t.tuya.test(DEV_B);
    assert.equal(missing.ok, false);
    assert.match(missing.message, /cet appareil n'y est pas/);
    const odd = (cloud.devices.set(DEV_B, { id: DEV_B, online: true, status: [{ code: 'switch_1', value: true }] }), await t.tuya.test(DEV_B));
    assert.equal(odd.ok, false);
    assert.match(odd.message, /aucune donnee de fumee reconnue.*switch_1/);
    t.tuya.stop();
  });
});
