/**
 * Essai reel de bout en bout (F28) : un VRAI PSIM (processus `node server/index.ts`) configure pour envoyer ses resumes a un VRAI
 * portail (createPortalApp, port libre). On declare un controleur et des portes par l'API du PSIM, on envoie de vrais messages de
 * passage (format de docs/CONTROLE-ACCES.md § 2, avec un nom, un badge et une reference de titulaire reconnaissables), des refus
 * repetes et une porte forcee, puis on attend l'envoi au portail et on interroge l'API du portail.
 *
 * Verifie : le bloc `access` recu est juste (portes, etats, incidents) ; aucun marqueur nominatif ni identifiant de controleur
 * nulle part (octets reellement echanges entre le PSIM et le portail, reponses du portail, base du portail). Un petit relais
 * HTTP place entre les deux enregistre les octets de chaque envoi.
 * Dossier temporaire, ports libres au hasard, horloge reelle ; cadence d'envoi ramenee a 2 s (PSIM_PORTAL_EVERY_S).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createUser } from '../portal/server/accounts.ts';
import { addOrganization, addSite } from '../portal/server/admin.ts';
import { createPortalApp } from '../portal/server/api.ts';
import { openPortalDb } from '../portal/server/db.ts';
import { siteKey } from '../portal/server/keys.ts';

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const TOKEN = 'jeton-equipements-0123456789abcdef';
const PORTAL_PW = 'Un-vrai-mot-de-passe-9';
const MASTER = Buffer.alloc(32, 9);
const SITE = 'site-reel-acces';

const MARKERS = {
  controllerId: 'CTL-SECRET-7',
  controllerName: 'Controleur-Hall-ZETA',
  host: '10.99.88.77',
  holderName: 'ZORRO-NOM-TEST',
  badge: '99887766',
  holderRef: 'HREF-4242',
  controllerUser: 'utilisateur-ctl-ZZ',
  controllerPassword: 'Mdp-ctl-ZZ-9x',
};
/** Fragment du badge : cherche seulement dans les TEXTES (cles et chaines), car des horodatages reels peuvent contenir ces chiffres. */
const FRAGMENT = '9988';

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chaines d'un JSON (cles et valeurs), y compris celles qui contiennent elles-memes du JSON (colonne `payload` d'une base). */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    if (/^\s*[[{]/.test(value)) {
      try {
        strings(JSON.parse(value), out);
      } catch {
        // simple texte
      }
    }
  } else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, (out.push(k), out));
  return out;
}

/** Echoue si un marqueur figure dans `text` (JSON ou non). */
function assertClean(where: string, text: string): void {
  for (const [name, marker] of Object.entries(MARKERS)) assert.ok(!text.includes(marker), `${name} (« ${marker} ») trouve dans : ${where}`);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  for (const s of strings(parsed)) assert.ok(!s.includes(FRAGMENT), `fragment du badge trouve dans un texte de : ${where} (« ${s.slice(0, 60)} »)`);
}

describe('portail et controle d acces : PSIM reel -> portail reel', { timeout: 120_000 }, () => {
  let psim: ChildProcess | null = null;
  let psimOutput = '';
  let psimBase = '';
  let relay: Server;
  let portalServer: Server;
  let portalBase = '';
  const portalDb = openPortalDb(':memory:');
  /** Octets de chaque envoi du PSIM au portail (corps et en-tetes), tels que le relais les a vus. */
  const wire: { headers: string; body: string; status: number }[] = [];

  async function until<T>(read: () => Promise<T | undefined | false>, ms: number, what: string): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = await read();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`${what} : non atteint en ${ms} ms\n${psimOutput.slice(-800)}`);
      await wait(250);
    }
  }

  async function psimApi(method: string, path: string, cookie: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
    const res = await fetch(`${psimBase}${path}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  }
  async function ingest(id: string, body: unknown): Promise<number> {
    const res = await fetch(`${psimBase}/api/ingest/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    const text = await res.text();
    // Succes = 200 ou 204 (sans corps) ; tout autre code fait echouer le test avec la reponse du PSIM.
    assert.ok(res.status === 200 || res.status === 204, `ingestion de ${id} : HTTP ${res.status} ${text}`);
    return res.status;
  }
  async function portalGet(path: string, cookie: string): Promise<{ status: number; text: string; json: any }> {
    const res = await fetch(`${portalBase}${path}`, { headers: { cookie } });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  }
  async function portalLogin(username: string): Promise<string> {
    const res = await fetch(`${portalBase}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PORTAL_PW }) });
    assert.equal(res.status, 200);
    return (res.headers.get('set-cookie') ?? '').split(';')[0];
  }

  before(async () => {
    // 1. Le vrai portail : un client, un site, un directeur et un prestataire.
    addOrganization(portalDb, 'Client reel');
    addSite(portalDb, 'Client reel', SITE, 'Entrepot reel');
    const orgId = (portalDb.prepare('SELECT id FROM organization').get() as { id: number }).id;
    createUser(portalDb, { username: 'directeur', role: 'director', orgId }, PORTAL_PW);
    createUser(portalDb, { username: 'prestataire', role: 'admin' }, PORTAL_PW);
    createUser(portalDb, { username: 'responsable', role: 'site_manager', orgId, siteId: SITE }, PORTAL_PW);
    portalDb.prepare('UPDATE portal_user SET must_change_password = 0').run();
    const app = createPortalApp({ db: portalDb, master: MASTER, staleAfterMs: 900_000, webDir: join(ROOT, 'portal', 'web') });
    portalServer = await new Promise<Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    portalBase = `http://127.0.0.1:${(portalServer.address() as AddressInfo).port}`;

    // 2. Un relais entre le PSIM et le portail : il enregistre les octets echanges, puis transmet tel quel.
    relay = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k.startsWith('x-psim-')) headers[k] = v;
        headers['content-type'] = String(req.headers['content-type'] ?? '');
        fetch(`${portalBase}/api/ingest`, { method: 'POST', headers, body })
          .then(async (r) => {
            const text = await r.text();
            wire.push({ headers: JSON.stringify(req.headers), body: body.toString('utf8'), status: r.status });
            res.writeHead(r.status, { 'content-type': 'application/json' }).end(text);
          })
          .catch(() => res.writeHead(502).end());
      });
    });
    await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
    const relayPort = (relay.address() as AddressInfo).port;

    // 3. Le vrai PSIM, configure pour envoyer au portail toutes les 2 s (par le relais).
    const port = await freePort();
    psimBase = `http://127.0.0.1:${port}`;
    const root = mkdtempSync(join(tmpdir(), 'psim-e2e-portal-access-'));
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
    Object.assign(env, {
      PSIM_DATA_DIR: join(root, 'data'),
      PSIM_BACKUP_DIR: join(root, 'backups'),
      PSIM_PORT: String(port),
      PSIM_MQTT_PORT: String(await freePort()),
      PSIM_ADMIN_PASSWORD: ADMIN_PW,
      PSIM_OPERATOR_PASSWORD: 'Mot-de-passe-operateur-2',
      PSIM_MQTT_PASSWORD: 'Mot-de-passe-mqtt-solide-3',
      PSIM_DEMO_LOGIN: '0',
      PSIM_REQUIRE_2FA: 'none',
      PSIM_INGEST_TOKEN: TOKEN,
      PSIM_PORTAL_URL: `http://127.0.0.1:${relayPort}/api/ingest`,
      PSIM_PORTAL_SITE_ID: SITE,
      PSIM_PORTAL_KEY: siteKey(MASTER, SITE, 1),
      PSIM_PORTAL_EVERY_S: '2',
    });
    psim = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    psim.stdout!.on('data', (d) => (psimOutput += d));
    psim.stderr!.on('data', (d) => (psimOutput += d));
    await until(async () => {
      try {
        return (await fetch(`${psimBase}/healthz`)).status === 200;
      } catch {
        return false;
      }
    }, 30_000, 'demarrage du PSIM');
  });

  after(async () => {
    psim?.kill();
    relay?.close();
    relay?.closeAllConnections();
    portalServer?.close();
    portalServer?.closeAllConnections();
  });

  it('declaration, passages nominatifs, refus repetes, porte forcee : le portail recoit un bloc juste et rien de nominatif', async () => {
    const login = await fetch(`${psimBase}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PW }) });
    assert.equal(login.status, 200);
    const admin = login.headers.getSetCookie()[0].split(';')[0];

    // Controleur marque, trois portes (detecteurs de categorie access).
    const ctl = await psimApi('POST', '/api/access/controllers', admin, {
      id: MARKERS.controllerId, name: MARKERS.controllerName, brand: 'dahua', host: MARKERS.host, credentials: { username: MARKERS.controllerUser, password: MARKERS.controllerPassword },
    });
    assert.equal(ctl.status, 201, ctl.text);
    const doors: [string, string][] = [['P-ENTREE', 'Entree personnel'], ['P-QUAI', 'Quai de chargement'], ['P-PORTAIL', 'Portail livraison']];
    for (const [i, [id, name]] of doors.entries()) {
      assert.equal((await psimApi('POST', '/api/devices', admin, { id, kind: 'detector', name, zone: 'Rez-de-chaussee', category: 'access' })).status, 201, id);
      const d = await psimApi('POST', '/api/access/doors', admin, { detectorId: id, controllerId: MARKERS.controllerId, doorNo: i + 1, kind: 'door' });
      assert.equal(d.status, 201, d.text);
    }

    // Vrais messages (contrat § 2). P-ENTREE fermee, P-QUAI ouverte.
    let seq = 0;
    const passage = (door: string, event: 'badge_granted' | 'badge_denied', ageMs: number) => {
      const eventId = String(++seq);
      return ingest(door, {
        event,
        ts: Date.now() - ageMs,
        msgId: `acc:${MARKERS.controllerId}:${eventId}`,
        access: {
          v: 1, controllerId: MARKERS.controllerId, eventId, direction: 'in', credential: MARKERS.badge, holderName: MARKERS.holderName, holderRef: MARKERS.holderRef,
          method: 'badge', result: event === 'badge_granted' ? 'granted' : 'denied', reason: event === 'badge_granted' ? null : 'unknown_credential', deferred: false,
        },
      });
    };
    await ingest('P-ENTREE', { event: 'door_closed', ts: Date.now() - 20_000 });
    await ingest('P-QUAI', { event: 'door_opened', ts: Date.now() - 20_000 });
    for (let k = 0; k < 4; k++) await passage('P-ENTREE', 'badge_granted', 15_000 - k * 1000);
    for (let k = 0; k < 3; k++) await passage('P-QUAI', 'badge_denied', 8000 - k * 1000);
    await ingest('P-QUAI', { event: 'badge_denied_repeated', ts: Date.now() - 4000 });
    await ingest('P-PORTAIL', { event: 'door_forced', ts: Date.now() - 2000 });

    // Le journal du PSIM garde bien le nominatif (le test cherche a bon escient).
    const journal = await psimApi('GET', '/api/access/events', admin);
    assert.equal(journal.status, 200);
    assert.ok(journal.text.includes(MARKERS.holderName) && journal.text.includes(MARKERS.badge), 'le PSIM a bien enregistre le nom et le badge');

    // Le portail finit par recevoir un resume qui contient les incidents d'acces.
    const director = await portalLogin('directeur');
    const detail = await until(async () => {
      const r = await portalGet(`/api/sites/${SITE}`, director);
      return r.status === 200 && r.json.access?.incidents?.forced === 1 && r.json.access.incidents.repeatedDenials === 1 ? r.json : false;
    }, 40_000, 'reception du bloc d acces par le portail');

    // Le bloc est juste.
    const a = detail.access;
    assert.equal(a.doors, 3);
    assert.deepEqual(a.states, { offline: 0, fault: 0, forced: 1, heldOpen: 0, open: 1, closed: 1, unknown: 0 });
    assert.equal(a.incidents.total, 2);
    assert.equal(a.incidents.other, 0);
    assert.equal(a.incidents.openNow, 2, 'la porte forcee et la serie de refus sont encore ouvertes');
    assert.equal(a.incidents.byDay.reduce((n: number, d: { n: number }) => n + d.n, 0), 2);
    assert.equal(a.windowDays, 35);
    assert.ok(a.availability.pct === null || (a.availability.pct >= 0 && a.availability.pct <= 100));
    assert.deepEqual(Object.keys(a).sort(), ['at', 'availability', 'doors', 'incidents', 'states', 'windowDays']);
    // Les detecteurs d'acces figurent dans les equipements du site (un equipement comme un autre, sans lien avec le controleur). A-01 vient de
    // la demonstration du PSIM : detecteur d'acces non declare comme porte, donc absent du bloc (3 portes, pas 4).
    assert.deepEqual(detail.devices.filter((d: { category: string }) => d.category === 'access').map((d: { id: string }) => d.id).sort(), ['A-01', 'P-ENTREE', 'P-PORTAIL', 'P-QUAI']);

    // Rien de nominatif nulle part : octets echanges, reponses du portail pour chaque role, base du portail.
    assert.ok(wire.length >= 1 && wire.every((w) => w.status === 200), `${wire.length} envoi(s) vus par le relais, tous acceptes`);
    assert.ok(wire.some((w) => JSON.parse(w.body).access?.incidents?.forced === 1), 'au moins un envoi porte le bloc complet');
    for (const [i, w] of wire.entries()) {
      assertClean(`envoi ${i + 1} du PSIM au portail (corps)`, w.body);
      assertClean(`envoi ${i + 1} du PSIM au portail (en-tetes)`, w.headers);
    }
    for (const user of ['directeur', 'prestataire', 'responsable']) {
      const cookie = await portalLogin(user);
      for (const p of ['/api/me', '/api/overview', '/api/sites', `/api/sites/${SITE}`, `/api/sites/${SITE}?days=7`, `/api/sites/${SITE}?days=90`, '/api/groups']) {
        const r = await portalGet(p, cookie);
        assert.equal(r.status, 200, `${user} ${p}`);
        assertClean(`${user} ${p}`, r.text);
      }
    }
    const tables = (portalDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
    for (const table of tables) assertClean(`table ${table} du portail`, JSON.stringify(portalDb.prepare(`SELECT * FROM ${table}`).all()));
    const stored = JSON.parse((portalDb.prepare('SELECT payload FROM snapshot WHERE site_id = ?').get(SITE) as { payload: string }).payload);
    assert.equal(stored.access.doors, 3, 'le bloc est stocke avec le resume');

    // Le PSIM n'a pas eu d'echec d'envoi vers le portail.
    const system = await psimApi('GET', '/api/system', admin);
    assert.equal(system.status, 200);
    assert.equal(system.body.portal.configured, true);
    assert.equal(system.body.portal.consecutiveFailures, 0);
    assert.ok(system.body.portal.sent >= 1);
  });
});
