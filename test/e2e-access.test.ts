/**
 * Controle d'acces (journal des passages, portes, controleurs) contre le VRAI serveur : routes /api/access/* (docs/ACCES.md § 3),
 * roles, anti-CSRF, ingestion HTTP de vrais messages (docs/CONTROLE-ACCES.md § 2), recherche, export CSV, conservation, journal
 * infalsifiable, et secret des controleurs (jamais relu, ni dans une reponse, ni dans l'etat, ni dans le journal, ni en clair sur disque).
 * Horloge reelle ; l'escalade « maintenue ouverte » est testee avec horloge injectee dans test/access.test.ts.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OPERATOR_PW = 'Mot-de-passe-operateur-2';
const TOKEN = 'jeton-equipements-0123456789abcdef';
const CTL_USER = 'utilisateur-controleur-unique';
const CTL_PASS = 'Mdp-Controleur-Unique-9f3k!x';

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Started {
  proc: ChildProcess;
  base: string;
  dataDir: string;
  output: () => string;
}

async function start(): Promise<Started> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const root = mkdtempSync(join(tmpdir(), 'psim-e2e-access-'));
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
      if ((await fetch(`${base}/healthz`)).status === 200) return { proc, base, dataDir: join(root, 'data'), output: () => output };
    } catch {
      // pas encore pret
    }
    await wait(250);
  }
  proc.kill();
  throw new Error(`serveur non demarre :\n${output}`);
}

async function login(base: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie()[0].split(';')[0];
}

/** Tout fichier du dossier de donnees (base, journal de transactions, journaux...) contenant ce texte en clair. */
function filesContaining(dir: string, needle: string): string[] {
  const found: string[] = [];
  const bytes = Buffer.from(needle, 'utf8');
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (readFileSync(p).includes(bytes)) found.push(p);
    }
  };
  walk(dir);
  return found;
}

const SECRETS = [CTL_PASS, CTL_USER];

describe('controle d acces : API, ingestion, journal, export (processus reel)', { timeout: 180_000 }, () => {
  let s: Started;
  let admin = '';
  let operator = '';
  /** Toutes les reponses vues par le test (texte brut) : aucune ne doit contenir un identifiant de controleur. */
  const seen: string[] = [];

  interface Reply {
    status: number;
    body: any;
    text: string;
    headers: Headers;
  }
  const api = async (method: string, path: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const res = await fetch(`${s.base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    seen.push(text);
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, text, headers: res.headers };
  };
  /** Message d'un equipement (jeton partage), tel que le ferait la passerelle. */
  const ingest = async (id: string, body: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${s.base}/api/ingest/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  /** Message de passage conforme au § 2 de docs/CONTROLE-ACCES.md. */
  const passage = (eventId: string, over: Record<string, unknown> = {}, acc: Record<string, unknown> = {}): Record<string, unknown> => ({
    event: 'badge_granted',
    ts: Date.now() - 1000,
    msgId: `acc:CTL-1:${eventId}`,
    access: { v: 1, controllerId: 'CTL-1', eventId, direction: 'in', credential: '0012345', holderName: 'KONAN Yao', holderRef: '101', method: 'badge', result: 'granted', reason: null, deferred: false, ...acc },
    ...over,
  });
  const door = async (id: string): Promise<any> => (await api('GET', `/api/access/doors/${id}`, admin)).body.door;
  const incidentsOf = async (detectorId: string): Promise<any[]> => ((await api('GET', '/api/state', admin)).body.incidents as any[]).filter((i) => i.detectorId === detectorId);
  async function until<T>(read: () => Promise<T | undefined | false>, ms = 6000): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = await read();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`condition non atteinte en ${ms} ms\n${s.output().slice(-600)}`);
      await wait(50);
    }
  }

  before(async () => {
    s = await start();
    admin = await login(s.base, 'admin', ADMIN_PW);
    operator = await login(s.base, 'operateur', OPERATOR_PW);
  });
  after(() => s?.proc.kill());

  // -------------------------------------------------------------------------------------------------------------------------
  describe('droits', () => {
    const routes: [string, string][] = [
      ['GET', '/api/access/controllers'],
      ['POST', '/api/access/controllers'],
      ['PUT', '/api/access/controllers/CTL-1'],
      ['DELETE', '/api/access/controllers/CTL-1'],
      ['GET', '/api/access/doors'],
      ['GET', '/api/access/doors/P-ENTREE'],
      ['POST', '/api/access/doors'],
      ['PUT', '/api/access/doors/P-ENTREE'],
      ['DELETE', '/api/access/doors/P-ENTREE'],
      ['GET', '/api/access/events'],
      ['GET', '/api/access/events.csv'],
      ['GET', '/api/access/settings'],
      ['PUT', '/api/access/settings'],
    ];

    it('les 13 routes du contrat existent et aucune ne repond sans session (401, jamais de donnee)', async () => {
      assert.equal(routes.length, 13);
      for (const [method, path] of routes) {
        const r = await api(method, path, null, method === 'GET' || method === 'DELETE' ? undefined : { retentionDays: 30, id: 'X', name: 'x', brand: 'dahua' });
        assert.equal(r.status, 401, `${method} ${path} sans session`);
        assert.deepEqual(r.body, { error: 'Non authentifie' }, `${method} ${path}`);
      }
      // Cookie bidon ou d'une autre origine de session : meme refus.
      assert.equal((await api('GET', '/api/access/doors', 'psim_session=pas-une-session')).status, 401);
    });

    it("operateur : consultation permise (portes, fiche, passages, export, reglages) ; controleurs et mutations refuses (403)", async () => {
      assert.equal((await api('GET', '/api/access/doors', operator)).status, 200);
      assert.equal((await api('GET', '/api/access/doors/INCONNUE', operator)).status, 404, 'la fiche d une porte non declaree : 404, pas 403');
      assert.equal((await api('GET', '/api/access/events', operator)).status, 200);
      const csv = await api('GET', '/api/access/events.csv', operator);
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get('content-type') ?? '', /^text\/csv; charset=utf-8$/);
      assert.equal((await api('GET', '/api/access/settings', operator)).status, 200);
      for (const [method, path] of routes) {
        if (method === 'GET' && !path.endsWith('/controllers')) continue;
        const r = await api(method, path, operator, method === 'GET' || method === 'DELETE' ? undefined : { retentionDays: 30, id: 'X', name: 'x', brand: 'dahua' });
        assert.equal(r.status, 403, `${method} ${path} en operateur`);
        assert.equal(r.body.error, 'Droits insuffisants');
      }
    });

    it("session « restreinte » (mot de passe a changer) : tout est refuse, meme la consultation", async () => {
      const pw = 'Hippopotame-bleu-42-lune';
      assert.equal((await api('POST', '/api/users', admin, { username: 'restreint', role: 'admin', password: pw, reauth: ADMIN_PW })).status, 201);
      const restricted = await login(s.base, 'restreint', pw);
      for (const [method, path] of routes) {
        const r = await api(method, path, restricted, method === 'GET' || method === 'DELETE' ? undefined : {});
        assert.equal(r.status, 403, `${method} ${path} en session restreinte`);
        assert.ok(r.body.restricted, `${method} ${path} : doit expliquer l etape requise`);
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------
  describe('cycle complet en administrateur', () => {
    it('controleur : creation (201, identifiants jamais renvoyes), doublon 409, donnees invalides 400, modification, effacement des identifiants', async () => {
      const created = await api('POST', '/api/access/controllers', admin, {
        id: 'CTL-1', name: 'Controleur entree', brand: 'dahua', model: 'ASC1204B', host: '192.168.1.50', gatewayId: 'gw-site', credentials: { username: CTL_USER, password: CTL_PASS },
      });
      assert.equal(created.status, 201, created.text);
      assert.equal(created.body.id, 'CTL-1');
      assert.equal(created.body.hasCredentials, true);
      assert.equal(created.body.doorCount, 0);
      assert.equal(created.body.createdBy, 'admin');
      assert.equal(created.body.clockOffsetMs, null);
      for (const k of ['credentials', 'credentialsSealed', 'credentials_sealed', 'password', 'username']) assert.ok(!(k in created.body), `champ ${k} interdit`);

      assert.equal((await api('POST', '/api/access/controllers', admin, { id: 'CTL-1', name: 'Autre', brand: 'dahua' })).status, 409);
      const bad = await api('POST', '/api/access/controllers', admin, { id: 'CTL-2', name: 'x', brand: 'inconnue' });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /brand/);
      assert.equal((await api('POST', '/api/access/controllers', admin, { id: 'a b', name: 'x', brand: 'dahua' })).status, 400, 'identifiant hors motif');
      assert.equal((await api('POST', '/api/access/controllers', admin, { id: 'CTL-3', name: 'x', brand: 'dahua', host: 'http://x/y' })).status, 400, 'adresse invalide');
      assert.equal((await api('POST', '/api/access/controllers', admin, { id: 'CTL-3', name: 'x', brand: 'dahua', credentials: { username: 'u' } })).status, 400, 'mot de passe manquant');
      // Corps non conformes : refus propre (jamais 5xx).
      assert.equal((await api('POST', '/api/access/controllers', admin, [])).status, 400);
      const broken = await fetch(`${s.base}/api/access/controllers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin }, body: '{"id":' });
      assert.equal(broken.status, 400);
      const big = await fetch(`${s.base}/api/access/controllers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin }, body: JSON.stringify({ id: 'CTL-9', name: 'x'.repeat(12_000), brand: 'dahua' }) });
      assert.equal(big.status, 413, 'au dela de 10 ko');

      const listed = await api('GET', '/api/access/controllers', admin);
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.body.map((c: { id: string }) => c.id), ['CTL-1']);

      const renamed = await api('PUT', '/api/access/controllers/CTL-1', admin, { name: 'Controleur principal' });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.body.name, 'Controleur principal');
      assert.equal(renamed.body.hasCredentials, true, 'champ credentials absent = inchange');
      assert.equal(renamed.body.host, '192.168.1.50');
      const cleared = await api('PUT', '/api/access/controllers/CTL-1', admin, { credentials: null });
      assert.equal(cleared.body.hasCredentials, false);
      const replaced = await api('PUT', '/api/access/controllers/CTL-1', admin, { credentials: { username: CTL_USER, password: CTL_PASS } });
      assert.equal(replaced.body.hasCredentials, true);
      assert.equal((await api('PUT', '/api/access/controllers/CTL-1', admin, { brand: 'moto' })).status, 400);
      assert.equal((await api('PUT', '/api/access/controllers/CTL-77', admin, { name: 'x' })).status, 404);
      // Identifiant d'URL hors motif : 404 sans toucher la base.
      for (const id of ['..%2Fx', 'a.b', 'x'.repeat(40), '%00']) {
        assert.equal((await api('PUT', `/api/access/controllers/${id}`, admin, { name: 'x' })).status, 404, id);
        assert.equal((await api('DELETE', `/api/access/controllers/${id}`, admin)).status, 404, id);
      }
    });

    it('porte : detecteur de categorie access cree via l API des equipements, declaree avec ses regles (400/409/404), fiche, modification', async () => {
      for (const id of ['P-ENTREE', 'P-SORTIE']) {
        const dev = await api('POST', '/api/devices', admin, { id, kind: 'detector', name: id === 'P-ENTREE' ? 'Entree personnel' : 'Sortie livraison', zone: 'Rez-de-chaussee', category: 'access' });
        assert.equal(dev.status, 201, dev.text);
      }
      assert.equal((await api('POST', '/api/access/doors', admin, { detectorId: 'D-01', controllerId: 'CTL-1', doorNo: 1 })).status, 400, 'un detecteur d une autre categorie n est pas une porte');
      assert.equal((await api('POST', '/api/access/doors', admin, { detectorId: 'P-INCONNU', controllerId: 'CTL-1', doorNo: 1 })).status, 400);
      assert.equal((await api('POST', '/api/access/doors', admin, { detectorId: 'P-ENTREE', controllerId: 'CTL-42', doorNo: 1 })).status, 400, 'controleur inconnu');
      assert.equal((await api('POST', '/api/access/doors', admin, { detectorId: 'P-ENTREE', controllerId: 'CTL-1', doorNo: 5 })).status, 400);
      assert.equal((await api('POST', '/api/access/doors', admin, { detectorId: 'P-ENTREE', controllerId: 'CTL-1', doorNo: 1, heldAlarmAfterS: 5 })).status, 400);
      assert.equal((await api('POST', '/api/access/doors', admin, { detectorId: 'P-ENTREE', controllerId: 'CTL-1', doorNo: 1, kind: 'trappe' })).status, 400);

      const created = await api('POST', '/api/access/doors', admin, { detectorId: 'P-ENTREE', controllerId: 'CTL-1', doorNo: 1, kind: 'door', emergencyExit: false });
      assert.equal(created.status, 201, created.text);
      assert.equal(created.body.detectorId, 'P-ENTREE');
      assert.equal(created.body.name, 'Entree personnel', 'le nom reste celui du detecteur');
      assert.equal(created.body.controllerId, 'CTL-1');
      assert.equal(created.body.heldAlarmAfterS, 300);
      assert.equal(created.body.state, 'unknown', 'aucun message recu : jamais « fermee » sans le savoir');
      assert.equal((await api('POST', '/api/access/doors', admin, { detectorId: 'P-ENTREE', controllerId: 'CTL-1', doorNo: 2 })).status, 409, 'deja declaree');
      assert.equal((await api('POST', '/api/access/doors', admin, { detectorId: 'P-SORTIE', controllerId: 'CTL-1', doorNo: 1 })).status, 409, 'numero de porte deja pris sur ce controleur');
      assert.equal((await api('POST', '/api/access/doors', admin, { detectorId: 'P-SORTIE', controllerId: 'CTL-1', doorNo: 2, kind: 'gate', heldAlarmAfterS: 600 })).status, 201);

      const list = await api('GET', '/api/access/doors', operator);
      assert.deepEqual(list.body.map((d: { detectorId: string }) => d.detectorId).sort(), ['P-ENTREE', 'P-SORTIE']);
      const sheet = await api('GET', '/api/access/doors/P-ENTREE', operator);
      assert.equal(sheet.status, 200);
      assert.equal(sheet.body.door.detectorId, 'P-ENTREE');
      assert.deepEqual(sheet.body.lastPassages, []);
      assert.ok(Array.isArray(sheet.body.cameras));
      assert.equal(sheet.body.remote.available, false);
      assert.equal((await api('GET', '/api/access/doors/P-INCONNU', admin)).status, 404);
      for (const id of ['..%2Fx', 'a.b', 'x'.repeat(40)]) assert.equal((await api('GET', `/api/access/doors/${id}`, admin)).status, 404, id);

      const updated = await api('PUT', '/api/access/doors/P-SORTIE', admin, { heldAlarmAfterS: 120, kind: 'barrier', emergencyExit: true });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.heldAlarmAfterS, 120);
      assert.equal(updated.body.kind, 'barrier');
      assert.equal(updated.body.emergencyExit, true);
      assert.equal(updated.body.controllerId, 'CTL-1', 'champs absents = inchanges');
      assert.equal((await api('PUT', '/api/access/doors/P-SORTIE', admin, { doorNo: 1 })).status, 409);
      assert.equal((await api('PUT', '/api/access/doors/P-SORTIE', admin, { heldAlarmAfterS: 99999999 })).status, 400);
      assert.equal((await api('PUT', '/api/access/doors/P-INCONNU', admin, { doorNo: 3 })).status, 404);
      assert.equal((await api('DELETE', '/api/access/controllers/CTL-1', admin)).status, 409, 'le controleur a encore des portes');
    });

    it('ingestion : passage accepte, refus, passage differe, doublon (autre msgId -> 200 duplicate), message invalide (400 avec la raison)', async () => {
      const t = Date.now();
      assert.equal((await ingest('P-ENTREE', passage('1001', { ts: t - 45_000 }))).status, 204);
      assert.equal(
        (await ingest('P-ENTREE', passage('1002', { event: 'badge_denied', ts: t - 50_000 }, { result: 'denied', reason: 'unknown_credential', credential: '0099999', holderName: null, holderRef: null }))).status,
        204,
      );
      // Recupere dans la memoire du controleur apres une coupure : heure ancienne et drapeau `deferred`.
      assert.equal((await ingest('P-ENTREE', passage('1003', { ts: t - 3_600_000 }, { deferred: true, credential: '0012346', holderName: 'ZÉBIÉ Noël', holderRef: '102' }))).status, 204);
      // Un retard de plus d'une minute rend le passage « differe » meme sans le drapeau.
      assert.equal((await ingest('P-SORTIE', passage('1004', { ts: t - 120_000 }, { direction: 'out', credential: '0012347', holderName: 'TRAORE Awa', holderRef: '103', method: 'face' }))).status, 204);
      // Cellules de tableur piegees (injection de formule) : conservees telles quelles, neutralisees a l'export.
      assert.equal((await ingest('P-SORTIE', passage('1005', { ts: t - 30_000 }, { credential: '+330102', holderName: '=cmd|calc', holderRef: '@ref' }))).status, 204);

      // Doublon : meme controleur, meme eventId, AUTRE msgId (la memoire des msgId n'est pas ce qui protege le journal).
      const dup = await ingest('P-ENTREE', passage('1001', { ts: t - 45_000, msgId: 'acc:CTL-1:1001-bis' }));
      assert.equal(dup.status, 200);
      assert.deepEqual(dup.body, { ok: true, duplicate: true });
      // Meme msgId renvoye (reprise apres coupure) : succes sans effet aussi.
      const again = await ingest('P-ENTREE', passage('1001', { ts: t - 45_000 }));
      assert.equal(again.status, 200);
      assert.equal(again.body.duplicate, true);

      // Messages invalides : refus HTTP 400 avec la raison, rien n'est enregistre.
      const badResult = await ingest('P-ENTREE', passage('2001', {}, { result: 'peut-etre' }));
      assert.equal(badResult.status, 400);
      assert.match(badResult.body.error, /access\.result/);
      const badMethod = await ingest('P-ENTREE', passage('2002', {}, { method: 'telepathie' }));
      assert.equal(badMethod.status, 400);
      assert.match(badMethod.body.error, /method/);
      const noTs = passage('2003');
      delete noTs.ts;
      const noTsReply = await ingest('P-ENTREE', noTs);
      assert.equal(noTsReply.status, 400);
      assert.match(noTsReply.body.error, /ts/);
      assert.equal((await ingest('P-ENTREE', passage('2004', { event: 'badge_denied' }))).status, 400, 'event incoherent avec result');
      assert.equal((await ingest('P-ENTREE', passage('2005', {}, { holderName: 'Jean\u0007Bell' }))).status, 400, 'caractere de controle');
      assert.equal((await ingest('P-ENTREE', passage('2006', {}, { controllerId: 'a b' }))).status, 400);
      assert.equal((await ingest('P-ENTREE', { event: 'badge_granted', ts: Date.now(), access: 'oui' })).status, 400);
      assert.equal((await ingest('D-01', passage('2007'))).status, 400, 'un detecteur d une autre categorie refuse un champ access');

      // Seuls les 5 passages valides sont dans le journal.
      const all = await api('GET', '/api/access/events?count=1', admin);
      assert.equal(all.body.total, 5);
      assert.equal(all.body.items.length, 5);
      const settings = await api('GET', '/api/access/settings', admin);
      assert.equal(settings.body.eventCount, 5);
    });

    it("etat des portes : ouverte, forcee (incident ouvert), refermee, maintenue ouverte", async () => {
      const step = async (event: string): Promise<void> => {
        await wait(5);
        assert.equal((await ingest('P-ENTREE', { event })).status, 204, event);
      };
      await step('door_opened');
      const opened = await door('P-ENTREE');
      assert.equal(opened.state, 'open');
      assert.equal(opened.stateLabel, 'Ouverte');
      assert.equal(opened.doorState, 'open');
      assert.ok(opened.lastPassageAt !== null, 'dernier passage connu');

      await step('door_forced');
      const forced = await until(async () => {
        const d = await door('P-ENTREE');
        return d.state === 'forced' ? d : false;
      });
      assert.equal(forced.stateLabel, 'Forcée');
      assert.match(forced.stateHint, /camera|caméra/i, 'le texte dit quoi faire');
      const incident = await until(async () => (await incidentsOf('P-ENTREE')).find((i) => i.event === 'door_forced'));
      assert.equal(incident.severity, 'critical');
      assert.equal(incident.status, 'open');
      assert.equal(incident.category, 'access');

      await step('door_closed');
      const closed = await door('P-ENTREE');
      assert.equal(closed.state, 'closed');
      assert.equal(closed.doorState, 'closed');

      await step('door_opened');
      await step('door_held_open');
      const held = await door('P-ENTREE');
      assert.equal(held.state, 'held_open', 'la route d etat montre la porte maintenue ouverte');
      assert.equal(held.stateLabel, 'Maintenue ouverte');
      assert.equal(held.deviceStatus, 'prealarm', 'pre-alarme tant que le delai n est pas ecoule');
      const inList = (await api('GET', '/api/access/doors', operator)).body.find((d: { detectorId: string }) => d.detectorId === 'P-ENTREE');
      assert.equal(inList.state, 'held_open');
      const snapshot = (await api('GET', '/api/state', operator)).body;
      assert.equal(snapshot.devices.find((d: { id: string }) => d.id === 'P-ENTREE').status, 'prealarm');

      await step('door_closed');
      assert.equal((await door('P-ENTREE')).state, 'closed');
      // L'autre porte n'a rien recu d'autre qu'un passage : son etat physique reste inconnu.
      assert.equal((await door('P-SORTIE')).doorState, 'unknown');
    });

    it('recherche : filtres, pagination par curseur, total plafonne et demande, validation', async () => {
      // Pagination : 2 par page, du plus recent au plus ancien, sans doublon ni trou.
      const ids: number[] = [];
      const times: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Reply = await api('GET', `/api/access/events?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${pages === 0 ? '&count=1' : ''}`, operator);
        assert.equal(page.status, 200, page.text);
        if (pages === 0) {
          assert.equal(page.body.total, 5);
          assert.equal(page.body.totalCapped, false);
        } else assert.equal(page.body.total, null, 'le total n est calcule que sur demande');
        for (const it of page.body.items) {
          ids.push(it.id);
          times.push(it.atDevice);
        }
        cursor = page.body.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      assert.equal(pages, 3);
      assert.equal(new Set(ids).size, 5);
      assert.deepEqual([...times].sort((a, b) => b - a), times, 'plus recent d abord');

      const one = (await api('GET', '/api/access/events?limit=1', admin)).body.items[0];
      for (const k of ['id', 'doorId', 'doorName', 'controllerId', 'eventId', 'atDevice', 'atReceived', 'direction', 'credential', 'holderName', 'holderRef', 'method', 'methodLabel', 'result', 'reason', 'resultLabel', 'late']) {
        assert.ok(k in one, `champ ${k} du passage`);
      }
      assert.equal(one.doorName === 'Entree personnel' || one.doorName === 'Sortie livraison', true);

      const q = async (qs: string): Promise<any> => {
        const r = await api('GET', `/api/access/events?${qs}`, admin);
        assert.equal(r.status, 200, `${qs} : ${r.text}`);
        return r.body;
      };
      const refused = await q('result=denied&count=1');
      assert.equal(refused.total, 1);
      assert.equal(refused.items[0].resultLabel, 'Refusé — badge inconnu');
      assert.equal(refused.items[0].reason, 'unknown_credential');
      assert.equal((await q('result=granted&count=1')).total, 4);
      const late = await q('late=1&count=1');
      assert.equal(late.total, 2, 'le passage differe et celui recu avec plus d une minute de retard');
      assert.ok(late.items.every((i: { late: boolean }) => i.late));
      assert.equal((await q('door=P-SORTIE&count=1')).total, 2);
      assert.equal((await q('door=P-ENTREE&count=1')).total, 3);
      assert.equal((await q('holder=konan&count=1')).total, 1, 'sans tenir compte de la casse');
      assert.equal((await q(`holder=${encodeURIComponent('zebie noel')}&count=1`)).total, 1, 'ni des accents');
      assert.equal((await q(`holder=${encodeURIComponent('ZÉBIÉ')}&count=1`)).total, 1);
      assert.equal((await q('holder=personne-de-ce-nom&count=1')).total, 0);
      assert.equal((await q('credential=00123&count=1')).total, 3, 'debut du numero');
      assert.equal((await q('credential=0012345&count=1')).total, 1);
      assert.equal((await q('credential=0099&count=1')).total, 1);
      assert.equal((await q('credential=00123&result=granted&door=P-ENTREE&count=1')).total, 2);
      const now = Date.now();
      assert.equal((await q(`from=${now - 100_000}&count=1`)).total, 3, 'depuis 100 s : 1001, 1002, 1005 (heure du controleur)');
      assert.equal((await q(`from=${now - 100_000}&to=${now - 35_000}&count=1`)).total, 2, 'to exclu');
      assert.equal((await q(`to=${now - 1_000_000}&count=1`)).total, 1, 'le passage differe d il y a une heure');
      assert.equal((await q('unknown=1&count=1')).total, 5, 'parametre inconnu ignore');
      assert.equal((await q('holder=&credential=&door=&result=&count=1')).total, 5, 'filtres vides ignores');

      // Syntaxe `a[b]=1` : le serveur ne construit pas d objets (analyse simple de Express 5), la cle est ignoree.
      assert.equal((await api('GET', '/api/access/events?credential[a]=1&holder[$ne]=1&count=1', admin)).body.total, 5);

      // Parametres invalides : 400 avec une raison en francais, jamais 5xx.
      for (const qs of ['limit=0', 'limit=201', 'limit=abc', 'limit=-1', 'cursor=pas-un-curseur', 'cursor=1:2:3', 'result=peut-etre', 'door=a%20b', 'door=..%2Fx', 'late=2', 'count=2', 'from=abc', 'to=1.5', `from=${now}&to=${now - 5}`, 'holder=a&holder=b', `holder=${'x'.repeat(200)}`, 'holder=a%00b']) {
        const r = await api('GET', `/api/access/events?${qs}`, admin);
        assert.equal(r.status, 400, `${qs} : ${r.status} ${r.text.slice(0, 80)}`);
        assert.equal(typeof r.body.error, 'string');
      }
    });

    it('export CSV : en-tetes, BOM, lignes, filtres, injection de formule neutralisee', async () => {
      const r = await api('GET', '/api/access/events.csv', operator);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8');
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('x-export-rows'), '5');
      assert.equal(r.headers.get('x-export-truncated'), null);
      const today = new Date();
      const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      assert.equal(r.headers.get('content-disposition'), `attachment; filename="passages_${stamp}.csv"`);
      // fetch retire le BOM du texte : on le cherche dans les octets recus.
      const raw = Buffer.from(await (await fetch(`${s.base}/api/access/events.csv`, { headers: { Cookie: operator } })).arrayBuffer());
      assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM UTF-8');
      const lines = r.text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l !== '');
      assert.equal(lines.length, 6, 'en-tete + 5 passages');
      assert.deepEqual(lines[0].split(';').map((c) => c.replace(/^"|"$/g, '')), [
        'Date et heure du contrôleur', 'Reçu le', 'Porte', 'Contrôleur', 'Sens', 'Badge', 'Titulaire', 'Référence titulaire', 'Méthode', 'Résultat', 'Motif', 'Reçu en différé',
      ]);
      const konan = lines.find((l) => l.includes('KONAN Yao'));
      assert.ok(konan, r.text);
      assert.ok(konan.includes('Entree personnel') && konan.includes('Controleur principal') && konan.includes('Accepté') && konan.includes('Badge'), konan);
      assert.ok(lines.some((l) => l.includes('Refusé') && l.includes('0099999')));
      // Injection : aucune cellule ne commence par = + - @ ; le prefixe ' les rend inertes.
      assert.ok(r.text.includes("'=cmd|calc"), 'titulaire neutralise');
      assert.ok(r.text.includes("'+330102"), 'badge neutralise');
      assert.ok(r.text.includes("'@ref"), 'reference neutralisee');
      assert.ok(!/(^|;)"?[=+\-@]/m.test(r.text.replace(/^﻿/, '')), `une cellule commence par un caractere de formule :\n${r.text}`);

      const filtered = await api('GET', '/api/access/events.csv?result=denied&door=P-ENTREE', admin);
      assert.equal(filtered.status, 200);
      assert.equal(filtered.headers.get('x-export-rows'), '1');
      assert.equal(filtered.text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l !== '').length, 2);
      const empty = await api('GET', '/api/access/events.csv?holder=personne-de-ce-nom', admin);
      assert.equal(empty.headers.get('x-export-rows'), '0');
      assert.equal((await api('GET', '/api/access/events.csv?limit=1&cursor=1:1&count=1', admin)).headers.get('x-export-rows'), '5', 'limit, cursor et count sont ignores');
      for (const qs of ['result=x', 'from=abc', 'door=a%20b']) assert.equal((await api('GET', `/api/access/events.csv?${qs}`, admin)).status, 400, qs);
    });

    it('conservation : lecture, reglage (admin), validation, persistance', async () => {
      const before = await api('GET', '/api/access/settings', operator);
      assert.equal(before.status, 200);
      assert.equal(before.body.retentionDays, 90);
      assert.equal(before.body.defaultDays, 90);
      assert.equal(before.body.eventCount, 5);
      assert.equal(typeof before.body.oldestAt, 'number');
      assert.equal(before.body.lastPurge, null);

      const set = await api('PUT', '/api/access/settings', admin, { retentionDays: 120 });
      assert.equal(set.status, 200);
      assert.equal(set.body.retentionDays, 120);
      assert.equal(set.body.defaultDays, 90);
      assert.equal((await api('GET', '/api/access/settings', operator)).body.retentionDays, 120);
      for (const bad of [{ retentionDays: 6 }, { retentionDays: 3651 }, { retentionDays: '120' }, { retentionDays: 1.5 }, { retentionDays: null }, {}, { jours: 30 }, []]) {
        const r = await api('PUT', '/api/access/settings', admin, bad);
        assert.equal(r.status, 400, JSON.stringify(bad));
        assert.match(r.body.error, /retentionDays|Corps/);
      }
      assert.equal((await api('GET', '/api/access/settings', admin)).body.retentionDays, 120, 'une valeur refusee ne change rien');
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------
  describe('securite', () => {
    it('anti-CSRF : une mutation venue d une autre origine est refusee (403) et ne change rien', async () => {
      const evil = { Origin: 'https://attaquant.example' };
      assert.equal((await api('POST', '/api/access/controllers', admin, { id: 'CTL-X', name: 'x', brand: 'dahua' }, evil)).status, 403);
      assert.equal((await api('PUT', '/api/access/controllers/CTL-1', admin, { name: 'pirate' }, evil)).status, 403);
      assert.equal((await api('DELETE', '/api/access/doors/P-SORTIE', admin, undefined, evil)).status, 403);
      assert.equal((await api('POST', '/api/access/doors', admin, { detectorId: 'P-SORTIE', controllerId: 'CTL-1', doorNo: 3 }, evil)).status, 403);
      assert.equal((await api('PUT', '/api/access/settings', admin, { retentionDays: 7 }, evil)).status, 403);
      assert.equal((await api('PUT', '/api/access/settings', admin, { retentionDays: 7 }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
      assert.equal((await api('PUT', '/api/access/settings', admin, { retentionDays: 7 }, { Origin: 'null' })).status, 403);
      const check = await api('GET', '/api/access/controllers', admin);
      assert.deepEqual(check.body.map((c: { id: string; name: string }) => [c.id, c.name]), [['CTL-1', 'Controleur principal']]);
      assert.equal((await api('GET', '/api/access/settings', admin)).body.retentionDays, 120);
      assert.equal((await api('GET', '/api/access/doors', admin)).body.length, 2);
      // Meme origine que le serveur : acceptee.
      assert.equal((await api('PUT', '/api/access/settings', admin, { retentionDays: 120 }, { Origin: s.base })).status, 200);
    });

    it("journal infalsifiable : creation de controleur, declaration, recherche nominative, export, reglage ; aucun mot de passe nulle part", async () => {
      // Recherche nominative et export : inscrits (une recherche sans nom ni badge ne l'est pas).
      await api('GET', `/api/access/events?holder=${encodeURIComponent('Dupont-Introuvable')}`, operator);
      await api('GET', '/api/access/events?credential=00123', admin);
      await api('GET', '/api/access/events?result=denied', admin);
      await api('GET', '/api/access/doors/P-ENTREE', admin);
      await api('GET', '/api/access/events.csv?door=P-SORTIE', operator);

      const log: any[] = (await api('GET', '/api/audit?limit=500', admin)).body;
      const by = (action: string): any[] => log.filter((e) => e.action === action);
      assert.equal(by('access_controller_created').length, 1);
      assert.equal(by('access_controller_created')[0].actor, 'admin');
      assert.match(by('access_controller_created')[0].details, /CTL-1.*identifiants enregistres/);
      assert.ok(by('access_controller_updated').length >= 3);
      assert.equal(by('access_door_declared').length, 2);
      assert.equal(by('access_door_declared').find((e) => e.deviceId === 'P-ENTREE')?.deviceId, 'P-ENTREE');
      assert.ok(by('access_door_updated').length >= 1);
      const searches = by('access_search');
      assert.ok(searches.some((e) => e.actor === 'operateur' && /titulaire « Dupont-Introuvable »/.test(e.details)), JSON.stringify(searches));
      assert.ok(searches.some((e) => e.actor === 'admin' && /badge « 00123 »/.test(e.details)));
      assert.ok(!searches.some((e) => /refuses/.test(e.details) && !/badge|titulaire/.test(e.details)), 'une recherche sans nom ni badge n est pas inscrite');
      assert.ok(!searches.some((e) => /KONAN Yao|ZÉBIÉ Noël|TRAORE/.test(e.details)), 'jamais le contenu des resultats');
      const exports = by('access_export');
      assert.ok(exports.length >= 3);
      assert.ok(exports.some((e) => e.actor === 'operateur' && /^\d+ ligne\(s\)/.test(e.details) && e.deviceId === 'P-SORTIE'), JSON.stringify(exports.slice(0, 3)));
      assert.equal(by('access_retention_changed').length >= 1, true);
      assert.match(by('access_retention_changed').at(-1).details, /90 -> 120|120 -> 120/);
      // Les passages eux-memes ne sont PAS dans le journal infalsifiable (volume).
      assert.ok(!log.some((e) => /KONAN Yao|ZÉBIÉ Noël|badge_granted/.test(`${e.details ?? ''}`)), 'aucun passage dans le journal');

      // La chaine du journal reste integre apres toutes ces inscriptions.
      const verify = await api('POST', '/api/system/journal/verify', admin);
      assert.equal(verify.status, 200);
      assert.equal(verify.body.ok, true, verify.text);
    });

    it('identifiants de controleur : jamais dans une reponse HTTP, ni /api/state, ni le journal, ni en clair sur le disque', async () => {
      const state = await api('GET', '/api/state', admin);
      const audit = await api('GET', '/api/audit?limit=500', admin);
      const everything = [state.text, audit.text, ...seen].join('\n');
      for (const secret of SECRETS) {
        assert.ok(!everything.includes(secret), `« ${secret.slice(0, 8)}… » est apparu dans une reponse HTTP`);
        assert.ok(!s.output().includes(secret), 'ni dans la sortie du serveur');
        assert.deepEqual(filesContaining(s.dataDir, secret), [], `« ${secret.slice(0, 8)}… » en clair dans le dossier de donnees`);
      }
      // Garde-fou du balayage : il lit bien la base (le nom du controleur, lui, y est en clair).
      assert.ok(filesContaining(s.dataDir, 'Controleur principal').length > 0, 'le balayage du dossier de donnees ne trouve rien : il ne prouve rien');
      // Ce qu'on peut savoir : qu'il y en a.
      const ctl = (await api('GET', '/api/access/controllers', admin)).body[0];
      assert.equal(ctl.hasCredentials, true);
      assert.ok(!Object.keys(ctl).some((k) => /cred|pass|user|secret/i.test(k.replace('hasCredentials', ''))), Object.keys(ctl).join(','));
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------
  describe('retrait', () => {
    it("retirer une porte puis le controleur : 204 ; 404 ensuite ; l'historique des passages reste consultable", async () => {
      assert.equal((await api('DELETE', '/api/access/doors/P-SORTIE', admin)).status, 204);
      assert.equal((await api('GET', '/api/access/doors/P-SORTIE', admin)).status, 404);
      assert.equal((await api('DELETE', '/api/access/doors/P-SORTIE', admin)).status, 404, 'deja retiree');
      assert.equal((await api('DELETE', '/api/access/controllers/CTL-1', admin)).status, 409, 'il reste P-ENTREE');
      // Un detecteur retire de la liste des portes continue d'etre un detecteur ordinaire : ses messages ne font plus rien de plus.
      assert.equal((await ingest('P-SORTIE', { event: 'door_opened' })).status, 204);

      assert.equal((await api('DELETE', '/api/access/doors/P-ENTREE', admin)).status, 204);
      assert.equal((await api('DELETE', '/api/access/controllers/CTL-1', admin)).status, 204);
      assert.equal((await api('DELETE', '/api/access/controllers/CTL-1', admin)).status, 404);
      assert.deepEqual((await api('GET', '/api/access/controllers', admin)).body, []);
      assert.deepEqual((await api('GET', '/api/access/doors', admin)).body, []);
      const history = await api('GET', '/api/access/events?count=1', operator);
      assert.equal(history.body.total, 5, 'l historique survit a la suppression des portes et du controleur');

      const log: any[] = (await api('GET', '/api/audit?limit=500', admin)).body;
      assert.equal(log.filter((e) => e.action === 'access_door_removed').length, 2);
      assert.equal(log.filter((e) => e.action === 'access_controller_deleted').length, 1);
      // Un message de passage pour une porte qui n'est plus declaree ne plante rien.
      const late = await ingest('P-ENTREE', passage('3001'));
      assert.ok(late.status < 500, `${late.status} ${JSON.stringify(late.body)}`);
      assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
    });
  });
});
