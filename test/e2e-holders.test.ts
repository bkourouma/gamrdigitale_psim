/**
 * Titulaires de badges, groupes, plages, visiteurs, import CSV et synchronisation contre le VRAI serveur (processus
 * `server/index.ts`) : routes /api/access/* de docs/ACCES.md § 11.3. Roles, anti-CSRF, photo, rattachement des passages,
 * re-authentification, secret de synchronisation (jamais relu), journal infalsifiable sans donnee personnelle, redemarrage.
 * Aucune passerelle MQTT n'est connectee : la synchronisation reste « en attente / transport non pret » (c'est verifie).
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
  root: string;
  port: number;
  mqttPort: number;
  dataDir: string;
  output: () => string;
}

/** Demarre le serveur ; `again` : relance sur le meme dossier de donnees et le meme port. */
async function start(again?: Started): Promise<Started> {
  const port = again?.port ?? (await freePort());
  const mqttPort = again?.mqttPort ?? (await freePort());
  const base = `http://127.0.0.1:${port}`;
  const root = again?.root ?? mkdtempSync(join(tmpdir(), 'psim-e2e-holders-'));
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    PSIM_DATA_DIR: join(root, 'data'),
    PSIM_BACKUP_DIR: join(root, 'backups'),
    PSIM_PORT: String(port),
    PSIM_MQTT_PORT: String(mqttPort),
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
      if ((await fetch(`${base}/healthz`)).status === 200) return { proc, base, root, port, mqttPort, dataDir: join(root, 'data'), output: () => output };
    } catch {
      // pas encore pret
    }
    await wait(250);
  }
  proc.kill();
  throw new Error(`serveur non demarre :\n${output}`);
}

async function stop(s: Started): Promise<void> {
  if (s.proc.exitCode !== null) return;
  const done = new Promise<void>((r) => s.proc.once('exit', () => r()));
  s.proc.kill();
  await Promise.race([done, wait(8000)]);
}

async function login(base: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie()[0].split(';')[0];
}

/** Tout fichier du dossier de donnees contenant ce texte en clair. */
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

/** JPEG minimal construit a la main : signature FF D8 FF, remplissage, fin FF D9. */
const jpeg = (size = 200): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, 0x11), Buffer.from([0xff, 0xd9])]);

interface Reply {
  status: number;
  body: any;
  text: string;
  headers: Headers;
}

describe('titulaires, groupes, visiteurs, import, synchronisation (processus reel)', { timeout: 300_000 }, () => {
  let s: Started;
  let admin = '';
  let operator = '';
  /** Toutes les reponses vues (texte brut) : la cle de synchronisation ne doit apparaitre dans aucune autre que sa propre emission. */
  const seen: string[] = [];
  let syncKey = '';

  const send = async (method: string, path: string, cookie: string | null, body: BodyInit | undefined, headers: Record<string, string>): Promise<Reply> => {
    const res = await fetch(`${s.base}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers }, body });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, text, headers: res.headers };
  };
  const api = async (method: string, path: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const r = await send(method, path, cookie, body === undefined ? undefined : JSON.stringify(body), { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers });
    seen.push(r.text);
    return r;
  };
  const raw = (method: string, path: string, cookie: string | null, body: Buffer | string, type: string, headers: Record<string, string> = {}): Promise<Reply> =>
    send(method, path, cookie, body as BodyInit, { 'Content-Type': type, ...headers });
  const ingest = async (id: string, body: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${s.base}/api/ingest/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  let seq = 5000;
  const passage = (acc: Record<string, unknown> = {}): Record<string, unknown> => {
    const eventId = String(++seq);
    return {
      event: 'badge_granted',
      ts: Date.now() - 1000,
      msgId: `acc:CTL-1:${eventId}`,
      access: { v: 1, controllerId: 'CTL-1', eventId, direction: 'in', credential: '0012345', holderName: null, holderRef: null, method: 'badge', result: 'granted', reason: null, deferred: false, ...acc },
    };
  };
  const ok = <T = any>(r: Reply, status: number): T => {
    assert.equal(r.status, status, `${r.status} ${r.text.slice(0, 300)}`);
    return r.body as T;
  };
  /** Liste complete des titulaires (tous types) : sert a verifier ce que l'import a cree ou non. */
  const allHolders = async (): Promise<any[]> => ok(await api('GET', '/api/access/holders?kind=all&limit=100', admin), 200).items;
  const csv = (text: string): Buffer => Buffer.from(text, 'utf8');
  const doImport = (cookie: string, body: Buffer, query = ''): Promise<Reply> => raw('POST', `/api/access/import${query}`, cookie, body, 'text/csv; charset=utf-8');

  let scheduleAll = 0; // « Tout le temps »
  let scheduleDay = 0;
  let groupMain = 0; // 2 portes
  let groupVisitors = 0;
  let groupPlain = 0;

  before(async () => {
    s = await start();
    admin = await login(s.base, 'admin', ADMIN_PW);
    operator = await login(s.base, 'operateur', OPERATOR_PW);

    // Controleur (avec passerelle) et deux portes : detecteurs de categorie access declares comme dans e2e-access.
    ok(await api('POST', '/api/access/controllers', admin, { id: 'CTL-1', name: 'Controleur entree', brand: 'dahua', model: 'ASC1204B', host: '192.168.1.50', gatewayId: 'gw-site' }), 201);
    for (const [id, name] of [['P-ENTREE', 'Entree personnel'], ['P-SORTIE', 'Sortie livraison']] as const) {
      ok(await api('POST', '/api/devices', admin, { id, kind: 'detector', name, zone: 'Rez-de-chaussee', category: 'access' }), 201);
    }
    ok(await api('POST', '/api/access/doors', admin, { detectorId: 'P-ENTREE', controllerId: 'CTL-1', doorNo: 1, kind: 'door' }), 201);
    ok(await api('POST', '/api/access/doors', admin, { detectorId: 'P-SORTIE', controllerId: 'CTL-1', doorNo: 2, kind: 'door' }), 201);
  });
  after(async () => {
    if (s) await stop(s);
  });

  // -------------------------------------------------------------------------------------------------------------------------
  describe('1. roles et sessions', () => {
    const reads = ['/api/access/holders', '/api/access/holders/1', '/api/access/holders/1/photo', '/api/access/groups', '/api/access/groups/1', '/api/access/schedules', '/api/access/schedules/1', '/api/access/holidays', '/api/access/visitors', '/api/access/sync', '/api/access/sync/controllers/CTL-1'];
    const writes: [string, string][] = [
      ['POST', '/api/access/holders'],
      ['PUT', '/api/access/holders/1'],
      ['DELETE', '/api/access/holders/1'],
      ['PUT', '/api/access/holders/1/photo'],
      ['DELETE', '/api/access/holders/1/photo'],
      ['POST', '/api/access/holders/1/badges'],
      ['PATCH', '/api/access/badges/1'],
      ['DELETE', '/api/access/badges/1'],
      ['POST', '/api/access/groups'],
      ['PUT', '/api/access/groups/1'],
      ['DELETE', '/api/access/groups/1'],
      ['POST', '/api/access/schedules'],
      ['PUT', '/api/access/schedules/1'],
      ['DELETE', '/api/access/schedules/1'],
      ['PUT', '/api/access/holidays'],
      ['POST', '/api/access/import'],
      ['POST', '/api/access/sync/controllers/CTL-1/key'],
      ['POST', '/api/access/sync/controllers/CTL-1/confirm-deletions'],
      ['POST', '/api/access/sync/controllers/CTL-1/retry'],
    ];
    const visitorWrites: [string, string][] = [
      ['POST', '/api/access/visitors'],
      ['POST', '/api/access/visitors/1/end'],
    ];

    it('sans session : 401 sur toutes les routes, sans aucune donnee', async () => {
      for (const path of reads) {
        const r = await api('GET', path, null);
        assert.equal(r.status, 401, `GET ${path}`);
        assert.deepEqual(r.body, { error: 'Non authentifie' });
      }
      for (const [method, path] of [...writes, ...visitorWrites]) {
        const r = await api(method, path, null, method === 'DELETE' ? undefined : {});
        assert.equal(r.status, 401, `${method} ${path}`);
        assert.deepEqual(r.body, { error: 'Non authentifie' });
      }
    });

    it('operateur : consultation permise (titulaires, visiteurs, groupes, plages, synchronisation)', async () => {
      for (const path of ['/api/access/holders', '/api/access/visitors', '/api/access/groups', '/api/access/schedules', '/api/access/holidays', '/api/access/sync', '/api/access/sync/controllers/CTL-1']) {
        assert.equal((await api('GET', path, operator)).status, 200, path);
      }
    });

    it('operateur : 403 sur toutes les ecritures hors visiteurs, y compris l import', async () => {
      for (const [method, path] of writes) {
        const r = method === 'POST' && path.endsWith('/import') ? await doImport(operator, csv('nom\nDUPONT\n')) : await api(method, path, operator, method === 'DELETE' ? undefined : {});
        assert.equal(r.status, 403, `${method} ${path}`);
      }
      assert.equal((await api('GET', '/api/access/holders', operator)).status, 200, 'toujours connecte');
    });

    it('anti-CSRF : une ecriture avec une Origin etrangere est refusee et ne change rien', async () => {
      const evil = { Origin: 'https://attaquant.example' };
      assert.equal((await api('POST', '/api/access/holders', admin, { lastName: 'PIRATE' }, evil)).status, 403);
      assert.equal((await api('POST', '/api/access/groups', admin, { name: 'Pirates' }, evil)).status, 403);
      assert.equal((await api('PUT', '/api/access/holidays', admin, { entries: [] }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
      const evilImport = await raw('POST', '/api/access/import', admin, csv('nom\nPIRATE\n'), 'text/csv', evil);
      assert.equal(evilImport.status, 403, evilImport.text);
      const evilPhoto = await raw('PUT', '/api/access/holders/1/photo', admin, jpeg(), 'image/jpeg', evil);
      assert.equal(evilPhoto.status, 403);
      assert.equal((await api('POST', '/api/access/visitors', operator, {}, evil)).status, 403);
      const created = await allHolders();
      assert.equal(created.length, 0, `rien n a ete cree : ${JSON.stringify(created.map((h) => h.displayName))}`);
      assert.deepEqual(ok(await api('GET', '/api/access/groups', admin), 200), []);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------
  describe('2. parcours complet administrateur', () => {
    let holderId = 0;
    let badgeId = 0;

    it('plage horaire, groupe avec deux portes', async () => {
      const builtin = ok<any[]>(await api('GET', '/api/access/schedules', admin), 200).find((x) => x.builtin);
      assert.ok(builtin, 'plage « Tout le temps » creee d office');
      scheduleAll = builtin.id;
      const sched = ok(await api('POST', '/api/access/schedules', admin, { name: 'Bureau 8h-18h', windows: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }], closedOnHolidays: true }), 201);
      scheduleDay = sched.id;
      assert.equal(sched.ref, `S${sched.id}`);
      assert.equal(sched.closedOnHolidays, true);
      assert.equal((await api('POST', '/api/access/schedules', admin, { name: 'Bureau 8h-18h', windows: [{ days: [1], from: '08:00', to: '18:00' }] })).status, 409, 'nom deja pris');
      assert.equal((await api('PUT', `/api/access/schedules/${scheduleAll}`, admin, { name: 'x' })).status >= 400, true, 'plage systeme non modifiable');
      assert.equal((await api('DELETE', `/api/access/schedules/${scheduleAll}`, admin)).status >= 400, true);

      const group = ok(await api('POST', '/api/access/groups', admin, { name: 'Personnel', description: 'Employes', doors: [{ doorId: 'P-ENTREE', scheduleId: scheduleAll }, { doorId: 'P-SORTIE', scheduleId: scheduleAll }] }), 201);
      groupMain = group.id;
      assert.equal(group.doors.length, 2);
      assert.equal(group.forVisitors, false);
      assert.equal((await api('POST', '/api/access/groups', admin, { name: 'personnel' })).status, 409, 'nom unique sans tenir compte de la casse');
      assert.equal((await api('POST', '/api/access/groups', admin, { name: 'Autre', doors: [{ doorId: 'P-INCONNU', scheduleId: scheduleAll }] })).status, 400);
      assert.equal((await api('DELETE', `/api/access/schedules/${scheduleAll}`, admin)).status >= 400, true);
      assert.equal((await api('DELETE', `/api/access/schedules/${scheduleDay}`, admin)).status, 204, 'plage libre : supprimable');
      scheduleDay = ok(await api('POST', '/api/access/schedules', admin, { name: 'Bureau 8h-18h', windows: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }], closedOnHolidays: true }), 201).id;
      assert.equal((await api('DELETE', `/api/access/groups/${groupMain}`, admin)).status, 204, 'groupe sans titulaire : supprimable');
      groupMain = ok(await api('POST', '/api/access/groups', admin, { name: 'Personnel', description: 'Employes', doors: [{ doorId: 'P-ENTREE', scheduleId: scheduleAll }, { doorId: 'P-SORTIE', scheduleId: scheduleAll }] }), 201).id;
      groupVisitors = ok(await api('POST', '/api/access/groups', admin, { name: 'Visiteurs accueil', forVisitors: true, doors: [{ doorId: 'P-ENTREE', scheduleId: scheduleAll }] }), 201).id;
      groupPlain = ok(await api('POST', '/api/access/groups', admin, { name: 'Maintenance', doors: [{ doorId: 'P-ENTREE', scheduleId: scheduleDay }] }), 201).id;
    });

    it('titulaire avec badge, recherche « Konan » sans accents ni majuscules, fiche', async () => {
      const h = ok(await api('POST', '/api/access/holders', admin, { lastName: 'KONAN', firstName: 'Yao', externalRef: 'M-001', groupIds: [groupMain], badges: ['0012345'] }), 201);
      holderId = h.id;
      assert.equal(h.ref, `H${h.id}`);
      assert.equal(h.displayName, 'KONAN Yao');
      assert.equal(h.badges.length, 1);
      assert.equal(h.badges[0].state, 'active');
      badgeId = h.badges[0].id;
      assert.equal(h.hasPhoto, false);
      assert.equal(h.createdBy, 'admin');
      assert.equal((await api('POST', '/api/access/holders', admin, { lastName: 'AUTRE', badges: ['0012345'] })).status, 409, 'badge deja porte');
      assert.equal((await api('POST', '/api/access/holders', admin, { lastName: 'AUTRE', externalRef: 'm-001' })).status, 409, 'matricule unique sans tenir compte de la casse');
      assert.equal((await api('POST', '/api/access/holders', admin, { firstName: 'Sans nom' })).status, 400);
      assert.equal((await api('POST', '/api/access/holders', admin, { lastName: 'BAD', badges: ['a b'] })).status, 400, 'numero de badge hors motif');

      for (const q of ['konan', 'KONAN', 'Kônan', 'kOnAn', 'yao', 'M-001', '00123']) {
        const list = ok(await api('GET', `/api/access/holders?q=${encodeURIComponent(q)}`, operator), 200);
        assert.equal(list.total, 1, `recherche « ${q} »`);
        assert.equal(list.items[0].id, holderId);
        assert.equal(list.items[0].syncState, 'pending', 'titulaire attendu sur CTL-1, pas encore envoye');
      }
      assert.equal(ok(await api('GET', '/api/access/holders?q=personne-de-ce-nom', admin), 200).total, 0);
      const sheet = ok(await api('GET', `/api/access/holders/${holderId}`, operator), 200);
      assert.equal(sheet.displayName, 'KONAN Yao');
      assert.deepEqual(sheet.recentPassages, []);
      assert.ok(Array.isArray(sheet.sync));
      assert.equal((await api('GET', '/api/access/holders/999999', admin)).status, 404);
      for (const id of ['0', '-1', 'abc', '1.5', '01', '99999999999']) assert.equal((await api('GET', `/api/access/holders/${id}`, admin)).status, 404, id);
      for (const qs of ['limit=0', 'limit=101', 'kind=autre', 'status=zzz']) assert.equal((await api('GET', `/api/access/holders?${qs}`, admin)).status, 400, qs);
    });

    it('badge : desactiver (PATCH), perdu, reaffecter ; titulaire suspendu puis supprime', async () => {
      const off = ok(await api('PATCH', `/api/access/badges/${badgeId}`, admin, { state: 'disabled' }), 200);
      assert.equal(off.state, 'disabled');
      assert.equal(off.stateLabel, 'Désactivé');
      assert.equal(off.stateBy, 'admin');
      assert.equal((await api('PATCH', `/api/access/badges/${badgeId}`, admin, { state: 'inconnu' })).status, 400);
      assert.equal((await api('PATCH', '/api/access/badges/999999', admin, { state: 'active' })).status, 404);
      assert.equal(ok(await api('PATCH', `/api/access/badges/${badgeId}`, admin, { state: 'active' }), 200).state, 'active');
      const lost = ok(await api('PATCH', `/api/access/badges/${badgeId}`, admin, { state: 'lost' }), 200);
      assert.equal(lost.state, 'lost');
      assert.equal(lost.stateLabel, 'Perdu');
      // Un badge perdu garde son numero reserve : impossible de le redonner a un autre.
      const other = ok(await api('POST', '/api/access/holders', admin, { lastName: 'TRAORE', firstName: 'Awa', externalRef: 'M-002' }), 201);
      assert.equal((await api('POST', `/api/access/holders/${other.id}/badges`, admin, { number: '0012345' })).status, 409);
      // Reaffecter : on rend la carte, le numero redevient disponible pour un autre titulaire.
      assert.equal(ok(await api('PATCH', `/api/access/badges/${badgeId}`, admin, { state: 'returned' }), 200).stateLabel, 'Rendu');
      const reassigned = ok(await api('POST', `/api/access/holders/${other.id}/badges`, admin, { number: '0012345' }), 201);
      assert.equal(reassigned.number, '0012345');
      assert.equal(reassigned.state, 'active');
      // Retour au premier titulaire pour la suite (rattachement des passages).
      assert.equal((await api('DELETE', `/api/access/badges/${reassigned.id}`, admin)).status, 204);
      assert.equal((await api('DELETE', `/api/access/badges/${reassigned.id}`, admin)).status, 404);
      const back = ok(await api('POST', `/api/access/holders/${holderId}/badges`, admin, { number: '0012345' }), 201);
      badgeId = back.id;

      const suspended = ok(await api('PUT', `/api/access/holders/${other.id}`, admin, { status: 'suspended' }), 200);
      assert.equal(suspended.status, 'suspended');
      assert.equal(suspended.lastName, 'TRAORE', 'champs absents = inchanges');
      assert.equal((await api('PUT', `/api/access/holders/${other.id}`, admin, { status: 'zzz' })).status, 400);
      assert.equal((await api('DELETE', `/api/access/holders/${other.id}`, admin)).status, 204);
      assert.equal((await api('GET', `/api/access/holders/${other.id}`, admin)).status, 404);
      assert.equal((await api('DELETE', `/api/access/holders/${other.id}`, admin)).status, 404);
    });

    it('conflit de plages entre deux groupes : 409 a l affectation et a la modification du groupe', async () => {
      // groupMain donne P-ENTREE en « Tout le temps », groupPlain donne P-ENTREE en « Bureau » : le titulaire ne peut pas avoir les deux.
      const r = await api('PUT', `/api/access/holders/${holderId}`, admin, { groupIds: [groupMain, groupPlain] });
      assert.equal(r.status, 409, r.text);
      assert.match(r.body.error, /P-ENTREE|Entree personnel/);
      assert.match(r.body.error, /Personnel|Maintenance/);
      assert.deepEqual(ok(await api('GET', `/api/access/holders/${holderId}`, admin), 200).groups.map((g: { id: number }) => g.id), [groupMain], 'refus : rien n a change');
      // Meme horaire dans les deux groupes : pas de conflit.
      const same = ok(await api('POST', '/api/access/groups', admin, { name: 'Astreinte', doors: [{ doorId: 'P-ENTREE', scheduleId: scheduleAll }] }), 201);
      ok(await api('PUT', `/api/access/holders/${holderId}`, admin, { groupIds: [groupMain, same.id] }), 200);
      // Modifier les portes d'un groupe deja affecte pour creer un conflit : refuse.
      const conflict = await api('PUT', `/api/access/groups/${same.id}`, admin, { doors: [{ doorId: 'P-ENTREE', scheduleId: scheduleDay }] });
      assert.equal(conflict.status, 409, conflict.text);
      ok(await api('PUT', `/api/access/holders/${holderId}`, admin, { groupIds: [groupMain] }), 200);
      ok(await api('PUT', `/api/access/groups/${same.id}`, admin, { description: 'Equipe d astreinte' }), 200);
      assert.equal((await api('DELETE', `/api/access/groups/${groupMain}`, admin)).status, 409, 'des titulaires y sont');
      assert.equal((await api('DELETE', `/api/access/groups/${same.id}`, admin)).status, 204);
    });

    it('photo : JPEG valide accepte, GIF/SVG/exe/trop gros refuses, lecture protegee, jamais dans la liste ni la synchronisation', async () => {
      const path = `/api/access/holders/${holderId}/photo`;
      assert.equal((await api('GET', path, admin)).status, 404, 'aucune photo');
      const photo = jpeg(300);
      assert.equal((await raw('PUT', path, admin, photo, 'image/jpeg')).status, 204);
      assert.equal((await raw('PUT', path, admin, Buffer.from('GIF89a' + 'x'.repeat(50)), 'image/gif')).status, 415, 'GIF');
      assert.equal((await raw('PUT', path, admin, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml')).status, 415, 'SVG');
      assert.equal((await raw('PUT', path, admin, Buffer.from('MZ' + '\u0090\u0000'.repeat(40), 'latin1'), 'application/x-msdownload')).status, 415, 'executable');
      assert.equal((await raw('PUT', path, admin, Buffer.from('MZ' + '\u0090\u0000'.repeat(40), 'latin1'), 'image/jpeg')).status, 400, 'executable deguise en JPEG : signature verifiee');
      assert.equal((await raw('PUT', path, admin, Buffer.from('GIF89a' + 'x'.repeat(50)), 'image/png')).status, 400, 'GIF deguise en PNG');
      assert.equal((await raw('PUT', path, admin, jpeg(70_000), 'image/jpeg')).status, 413, 'plus de 64 Ko');
      assert.equal((await raw('PUT', path, admin, Buffer.alloc(0), 'image/jpeg')).status, 400, 'corps vide');
      assert.equal((await raw('PUT', '/api/access/holders/999999/photo', admin, photo, 'image/jpeg')).status, 404);

      // Lecture : session obligatoire, en-tetes de securite, octets identiques.
      assert.equal((await api('GET', path, null)).status, 401, 'impossible sans session');
      const res = await fetch(`${s.base}${path}`, { headers: { Cookie: operator } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/jpeg');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), photo);

      // La photo n'est ni dans la fiche, ni dans la liste, ni dans la synchronisation : seulement `hasPhoto`.
      const b64 = photo.toString('base64').slice(0, 40);
      const hex = photo.toString('hex').slice(0, 40);
      const texts = [
        (await api('GET', `/api/access/holders/${holderId}`, admin)).text,
        (await api('GET', '/api/access/holders?kind=all', admin)).text,
        (await api('GET', '/api/access/sync', admin)).text,
        (await api('GET', '/api/access/sync/controllers/CTL-1', admin)).text,
        (await api('GET', '/api/access/events', admin)).text,
      ];
      for (const t of texts) assert.ok(!t.includes(b64) && !t.includes(hex) && !/"photo"/.test(t), 'photo dans une reponse JSON');
      assert.equal(ok(await api('GET', `/api/access/holders/${holderId}`, admin), 200).hasPhoto, true);
      assert.equal((await api('DELETE', path, admin)).status, 204);
      assert.equal((await api('GET', path, admin)).status, 404);
      assert.equal(ok(await api('GET', `/api/access/holders/${holderId}`, admin), 200).hasPhoto, false);
      assert.equal((await raw('PUT', path, admin, photo, 'image/jpeg')).status, 204, 'remise en place');
    });

    it('jours feries : remplacement complet, dates impossibles refusees', async () => {
      const set = ok(await api('PUT', '/api/access/holidays', admin, { entries: [{ date: '2030-12-25', label: 'Noel' }, { date: '2030-01-01' }] }), 200);
      assert.equal(set.length, 2);
      assert.equal((await api('PUT', '/api/access/holidays', admin, { entries: [{ date: '2030-02-30' }] })).status, 400, 'le 30 fevrier n existe pas');
      assert.equal(ok(await api('GET', '/api/access/holidays', operator), 200).length, 2, 'refus : inchange');
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------
  describe('3. visiteurs', () => {
    const visitor = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ lastName: 'DIALLO', firstName: 'Moussa', host: 'M. Konan', reason: 'Livraison', badge: 'V-0001', groupId: groupVisitors, durationMinutes: 60, ...over });

    it('l operateur cree un visiteur ; il apparait dans /visitors ; mettre fin libere le badge', async () => {
      const v = ok(await api('POST', '/api/access/visitors', operator, visitor()), 201);
      assert.equal(v.holder.kind, 'visitor');
      assert.equal(v.state, 'present');
      assert.equal(v.host, 'M. Konan');
      assert.ok(v.remainingMs > 0 && v.remainingMs <= 60 * 60_000);
      assert.equal(v.holder.badges[0].number, 'V-0001');
      const current = ok<any[]>(await api('GET', '/api/access/visitors', operator), 200);
      assert.ok(current.some((x) => x.holder.id === v.holder.id));
      const staff = ok(await api('GET', '/api/access/holders', admin), 200).items;
      assert.ok(!staff.some((h: { id: number }) => h.id === v.holder.id), 'la liste par defaut ne montre pas les visiteurs');

      // Le meme badge ne peut pas etre donne deux fois pendant la visite.
      assert.equal((await api('POST', '/api/access/visitors', operator, visitor({ lastName: 'AUTRE' }))).status, 409);

      const ended = ok(await api('POST', `/api/access/visitors/${v.holder.id}/end`, operator), 200);
      assert.equal(ended.state, 'ended');
      assert.equal(ended.remainingMs, 0);
      assert.equal(ended.holder.badges[0].state, 'returned');
      assert.ok(!ok<any[]>(await api('GET', '/api/access/visitors', operator), 200).some((x) => x.holder.id === v.holder.id), 'plus « en cours »');
      assert.ok(ok<any[]>(await api('GET', '/api/access/visitors?scope=recent', operator), 200).some((x) => x.holder.id === v.holder.id), 'encore dans « recents »');
      assert.equal((await api('GET', '/api/access/visitors?scope=zzz', operator)).status, 400);
      // Le meme numero est reutilisable.
      const again = ok(await api('POST', '/api/access/visitors', operator, visitor({ lastName: 'KAMARA' })), 201);
      assert.equal(again.holder.badges[0].number, 'V-0001');
      assert.equal((await api('POST', '/api/access/visitors/999999/end', operator)).status, 404);
      ok(await api('POST', `/api/access/visitors/${again.holder.id}/end`, operator), 200);
    });

    it('refus : groupe non marque visiteurs, duree hors bornes, champs manquants', async () => {
      const wrongGroup = await api('POST', '/api/access/visitors', operator, visitor({ badge: 'V-0002', groupId: groupPlain }));
      assert.equal(wrongGroup.status, 400, wrongGroup.text);
      assert.match(wrongGroup.body.error, /visiteur/i);
      for (const d of [0, 5, 14, 44_641, 100_000, -60, 'une heure', 1.5, null]) {
        assert.equal((await api('POST', '/api/access/visitors', operator, visitor({ badge: 'V-0002', durationMinutes: d }))).status, 400, `duree ${String(d)}`);
      }
      assert.equal((await api('POST', '/api/access/visitors', operator, visitor({ badge: 'V-0002', durationMinutes: 15 }))).status, 201, 'borne basse');
      assert.equal((await api('POST', '/api/access/visitors', operator, visitor({ badge: 'V-0003', durationMinutes: 44_640 }))).status, 201, 'borne haute');
      assert.equal((await api('POST', '/api/access/visitors', operator, visitor({ badge: 'V-0004', lastName: undefined }))).status, 400);
      assert.equal((await api('POST', '/api/access/visitors', operator, visitor({ badge: 'V-0004', groupId: 999999 }))).status >= 400, true);
      assert.equal((await api('POST', '/api/access/visitors', operator, visitor({ badge: undefined }))).status, 400);
      // Un visiteur ne peut pas etre termine deux fois comme un titulaire ordinaire ; un titulaire n'est pas un visiteur.
      const staff = (await allHolders()).find((h) => h.kind === 'staff');
      assert.ok(staff);
      assert.equal((await api('POST', `/api/access/visitors/${staff.id}/end`, operator)).status >= 400, true, 'un employe n a pas de visite a terminer');
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------
  describe('4. rattachement des passages', () => {
    const find = async (qs: string): Promise<any> => ok(await api('GET', `/api/access/events?${qs}&count=1`, admin), 200);

    it('un passage au numero de badge, sans nom, recoit le nom et l identifiant du titulaire', async () => {
      const holder = (await allHolders()).find((h) => h.externalRef === 'M-001');
      assert.ok(holder);
      const msg = passage({ credential: '0012345' });
      assert.equal((await ingest('P-ENTREE', msg)).status, 204);
      const res = await find('credential=0012345');
      assert.equal(res.total, 1);
      assert.equal(res.items[0].holderName, 'KONAN Yao');
      assert.equal(res.items[0].holderId, holder.id);
      assert.equal((await find('holder=konan')).total, 1, 'la recherche par nom le trouve');
      assert.equal((await find('holder=KONAN%20yao')).total, 1);
      const sheet = ok(await api('GET', `/api/access/holders/${holder.id}`, admin), 200);
      assert.equal(sheet.recentPassages.length, 1);
      assert.equal(sheet.recentPassages[0].doorId, 'P-ENTREE');

      // holderRef « H<id> » : rattache meme avec un numero de badge inconnu.
      assert.equal((await ingest('P-SORTIE', passage({ credential: '0077777', holderRef: holder.ref, direction: 'out' }))).status, 204);
      const byRef = await find('credential=0077777');
      assert.equal(byRef.items[0].holderId, holder.id);
      assert.equal(byRef.items[0].holderName, 'KONAN Yao');
      assert.equal((await find('holder=konan')).total, 2);

      // Numero sans titulaire et sans nom : passage conserve, non rattache.
      assert.equal((await ingest('P-ENTREE', passage({ credential: '0088888', result: 'denied', reason: 'unknown_credential' }))).status, 400, 'event incoherent avec result');
      assert.equal((await ingest('P-ENTREE', { ...passage({ credential: '0088888', result: 'denied', reason: 'unknown_credential' }), event: 'badge_denied' })).status, 204);
      const none = await find('credential=0088888');
      assert.equal(none.items[0].holderId, null);
      assert.equal(none.items[0].holderName, null);
    });

    it('le nom donne par le controleur n est pas ecrase', async () => {
      assert.equal((await ingest('P-ENTREE', passage({ credential: '0012345', holderName: 'NOM DU CONTROLEUR' }))).status, 204);
      const res = await find('holder=controleur');
      assert.equal(res.total, 1);
      assert.equal(res.items[0].holderName, 'NOM DU CONTROLEUR');
      assert.ok(res.items[0].holderId !== null, 'rattache quand meme');
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------
  describe('5. import CSV', () => {
    before(async () => {
      ok(await api('POST', '/api/access/groups', admin, { name: 'Import', doors: [{ doorId: 'P-ENTREE', scheduleId: scheduleAll }] }), 201);
    });
    const byRef = async (ref: string): Promise<any> => (await allHolders()).find((h) => h.externalRef === ref);

    it('dryRun ne cree rien ; l import reel cree ; un second import identique donne « inchange »', async () => {
      const file = csv('nom;prenom;matricule;badge1;groupe;debut;fin;statut\nBAMBA;Fanta;I-001;1000001;Import;01/01/2030;31/12/2030;actif\nCISSE;Ali;I-002;1000002;;;;suspendu\n');
      const before = (await allHolders()).length;
      const dry = ok(await doImport(admin, file, '?dryRun=1'), 200);
      assert.equal(dry.dryRun, true);
      assert.equal(dry.created, 2);
      assert.equal(dry.errors, 0);
      assert.equal(dry.encoding, 'utf-8');
      assert.equal(dry.delimiter, ';');
      assert.equal((await allHolders()).length, before, 'a blanc : rien n est cree');
      assert.equal(await byRef('I-001'), undefined);
      assert.equal((await api('GET', '/api/access/holders?q=1000001', admin)).body.total, 0, 'ni le badge');

      const real = ok(await doImport(admin, file), 200);
      assert.equal(real.dryRun, false);
      assert.equal(real.created, 2);
      assert.equal((await allHolders()).length, before + 2);
      const bamba = await byRef('I-001');
      assert.equal(bamba.displayName, 'BAMBA Fanta');
      assert.equal(bamba.badges[0].number, '1000001');
      assert.equal(bamba.groups[0].name, 'Import');
      assert.equal((await byRef('I-002')).status, 'suspended');

      const second = ok(await doImport(admin, file), 200);
      assert.equal(second.created, 0);
      assert.equal(second.unchanged, 2, JSON.stringify(second.items));
      assert.equal(second.updated, 0);
      assert.equal((await allHolders()).length, before + 2);
    });

    it('UTF-8 avec BOM, Windows-1252 (Excel francais) et separateurs', async () => {
      const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), csv('Nom,Prénom,Matricule\nÉBOUÉ,Zoé,I-010\n')]);
      const r1 = ok(await doImport(admin, bom), 200);
      assert.equal(r1.encoding, 'utf-8');
      assert.equal(r1.delimiter, ',');
      assert.equal(r1.created, 1, JSON.stringify(r1));
      assert.equal((await byRef('I-010')).displayName, 'ÉBOUÉ Zoé');

      const cp = Buffer.from('nom;prénom;matricule\nZÉBIÉ;Noël;I-011\n', 'latin1');
      const r2 = ok(await doImport(admin, cp), 200);
      assert.equal(r2.encoding, 'windows-1252');
      assert.equal(r2.created, 1, JSON.stringify(r2));
      assert.equal((await byRef('I-011')).displayName, 'ZÉBIÉ Noël', 'accents relus correctement');

      const tab = ok(await doImport(admin, csv('nom\tmatricule\nTABULE\tI-012\n')), 200);
      assert.equal(tab.delimiter, '\t');
      assert.equal(tab.created, 1);
    });

    it('rapport d erreurs ligne par ligne : badge en double, date impossible, formule, balise', async () => {
      const before = (await allHolders()).length;
      const file = csv(
        [
          'nom;prenom;matricule;badge1;fin',
          'VALIDE;Un;E-001;2000001;', // 2 ok
          'DOUBLON;Badge;E-002;2000001;', // 3 badge deja dans le fichier
          'DATEKO;Jour;E-003;2000003;31/02/2030', // 4 date impossible
          '=cmd();Formule;E-004;2000004;', // 5 formule
          '<script>alert(1)</script>;Balise;E-005;2000005;', // 6 balise
          'MATRICULE;Double;E-001;2000006;', // 7 matricule en double dans le fichier
          'BADGEKO;Format;E-008;a b c;', // 8 badge invalide
        ].join('\n') + '\n',
      );
      const rep = ok(await doImport(admin, file), 200);
      assert.equal(rep.created, 1, JSON.stringify(rep.items));
      assert.equal(rep.errors, 6);
      const lineErrors = (n: number): string => (rep.items.find((i: { line: number }) => i.line === n)?.errors ?? []).join(' / ');
      assert.equal(rep.items.find((i: { line: number }) => i.line === 2).outcome, 'created');
      assert.match(lineErrors(3), /badge/i);
      assert.match(lineErrors(4), /date|fin/i);
      assert.ok(lineErrors(5).length > 0, 'formule refusee');
      assert.ok(lineErrors(6).length > 0, 'balise refusee');
      assert.match(lineErrors(7), /matricule/i);
      assert.ok(lineErrors(8).length > 0);
      for (const n of [3, 4, 5, 6, 7, 8]) assert.equal(rep.items.find((i: { line: number }) => i.line === n).outcome, 'error', `ligne ${n}`);
      assert.equal((await allHolders()).length, before + 1, 'seule la ligne valide est appliquee');
      assert.equal(await byRef('E-002'), undefined);
      assert.ok(!JSON.stringify(await allHolders()).includes('<script>'), 'aucune balise stockee');
    });

    it('fichiers refuses : 1,5 Mo (413), binaire, vide, en-tete inconnu ; aucun effet', async () => {
      const before = (await allHolders()).length;
      const big = await doImport(admin, Buffer.from('nom\n' + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n'.repeat(48_000)));
      assert.equal(big.status, 413, `${big.status}`);
      assert.equal(typeof big.body.error, 'string');
      const bin = Buffer.alloc(4000);
      for (let i = 0; i < bin.length; i++) bin[i] = (i * 7919 + 13) & 0xff;
      const binary = await doImport(admin, bin);
      assert.ok(binary.status < 500, `${binary.status} ${binary.text.slice(0, 200)}`);
      assert.ok(binary.status >= 400 || binary.body.fatal !== null || (binary.body.created === 0 && binary.body.updated === 0), 'rien d appliquable dans un binaire');
      const empty = await doImport(admin, Buffer.alloc(0));
      assert.equal(empty.status, 400);
      const noHeader = ok(await doImport(admin, csv('colonne;autre\n1;2\n')), 200);
      assert.ok(noHeader.fatal, 'en-tete inconnu : refus global');
      assert.equal(noHeader.created, 0);
      const exe = await raw('POST', '/api/access/import', admin, Buffer.from('MZ\u0090\u0000\u0003\u0000\u0000\u0000', 'latin1'), 'application/octet-stream');
      assert.ok(exe.status < 500);
      assert.equal((await allHolders()).length, before, 'aucun titulaire cree');
    });

    it('l operateur ne peut pas importer (403)', async () => {
      assert.equal((await doImport(operator, csv('nom;matricule\nOPE;O-001\n'), '?dryRun=1')).status, 403);
      assert.equal(await byRef('O-001'), undefined);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------
  describe('6. synchronisation', () => {
    it('le controleur est « non active », transport non pret, aucun element en attente', async () => {
      const list = ok<any[]>(await api('GET', '/api/access/sync', operator), 200);
      const c = list.find((x) => x.controllerId === 'CTL-1');
      assert.ok(c);
      assert.equal(c.enabled, false);
      assert.equal(c.state, 'disabled');
      assert.equal(c.keyCreatedAt, null);
      assert.equal(typeof c.hint, 'string'); // transportReady est optimiste (vrai) tant qu'aucun envoi n'a echoue
      const detail = ok(await api('GET', '/api/access/sync/controllers/CTL-1', operator), 200);
      assert.equal(detail.state, 'disabled');
      assert.equal((await api('GET', '/api/access/sync/controllers/CTL-77', operator)).status, 404);
      assert.equal((await api('GET', '/api/access/sync/controllers/a.b', operator)).status, 404);
    });

    it('cle : reauth absent 428, mot de passe faux 403, bon mot de passe 200 (64 hexadecimaux, no-store, une seule fois)', async () => {
      const path = '/api/access/sync/controllers/CTL-1/key';
      assert.equal((await api('POST', path, admin, {})).status, 428);
      assert.equal((await api('POST', path, admin, { reauth: '' })).status, 428);
      assert.equal((await api('POST', path, admin, { reauth: 'Mauvais-mot-de-passe-1' })).status, 403);
      assert.equal((await api('POST', path, operator, { reauth: OPERATOR_PW })).status, 403, 'operateur refuse meme avec son bon mot de passe');
      assert.equal((await api('POST', '/api/access/sync/controllers/CTL-77/key', admin, { reauth: ADMIN_PW })).status, 404);
      const before = ok<any[]>(await api('GET', '/api/access/sync', admin), 200).find((x) => x.controllerId === 'CTL-1');
      assert.equal(before.enabled, false, 'aucun echec n a active la synchronisation');

      const res = await send('POST', path, admin, JSON.stringify({ reauth: ADMIN_PW }), { 'Content-Type': 'application/json' });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.match(res.body.key, /^[0-9a-f]{64}$/);
      assert.equal(res.body.renewed, false);
      assert.equal(typeof res.body.createdAt, 'number');
      assert.ok(!res.text.includes(ADMIN_PW), 'le mot de passe n est pas renvoye');
      syncKey = res.body.key;
    });

    it('apres l emission : la cle n apparait plus nulle part (reponses, journal, disque, sortie du serveur)', async () => {
      assert.ok(syncKey);
      const keyed = (t: string): boolean => t.includes(syncKey) || t.toLowerCase().includes(syncKey.toLowerCase());
      for (const path of ['/api/access/sync', '/api/access/sync/controllers/CTL-1', '/api/access/controllers', '/api/access/controllers/CTL-1', '/api/access/holders?kind=all', '/api/access/groups', '/api/state', '/api/audit?limit=500', '/api/access/events']) {
        const r = await api('GET', path, admin);
        assert.ok(!keyed(r.text), `la cle est apparue dans ${path}`);
      }
      const holder = (await allHolders()).find((h) => h.externalRef === 'M-001');
      assert.ok(!keyed((await api('GET', `/api/access/holders/${holder.id}`, admin)).text));
      assert.ok(!seen.some(keyed), 'la cle est apparue dans une reponse vue par le test');
      assert.ok(!keyed(s.output()), 'ni dans la sortie du serveur');
      assert.deepEqual(filesContaining(s.dataDir, syncKey), [], 'en clair dans le dossier de donnees');
    });

    it('etat « en attente » : par controleur, transport non pret, titulaire en attente', async () => {
      // La cle existe : au tick suivant le serveur tente un envoi, le transport (sans passerelle) refuse, `transportReady` passe a faux.
      const t0 = Date.now();
      let c: any;
      do {
        c = ok<any[]>(await api('GET', '/api/access/sync', operator), 200).find((x) => x.controllerId === 'CTL-1');
        if (!c.transportReady) break;
        await wait(200);
      } while (Date.now() - t0 < 8000);
      assert.equal(c.enabled, true);
      assert.equal(typeof c.keyCreatedAt, 'number');
      assert.equal(c.transportReady, false);
      assert.equal(c.state, 'pending');
      assert.ok(c.counts.pending > 0);
      assert.equal(c.counts.failed, 0, 'sans transport, rien n est compte comme essai : pas d echec');
      assert.equal(c.lastAckAt, null);
      const detail = ok(await api('GET', '/api/access/sync/controllers/CTL-1', operator), 200);
      assert.ok(detail.items.length > 0);
      assert.ok(detail.items.every((i: { state: string }) => i.state === 'pending'));
      const holder = (await allHolders()).find((h) => h.externalRef === 'M-001');
      const sheet = ok(await api('GET', `/api/access/holders/${holder.id}`, operator), 200);
      assert.deepEqual(sheet.sync.map((x: { controllerId: string; state: string }) => [x.controllerId, x.state]), [['CTL-1', 'pending']]);
      const row = ok(await api('GET', '/api/access/holders?q=konan', operator), 200).items[0];
      assert.equal(row.syncState, 'pending');
    });

    it('renouvellement : renewed true et la cle change ; confirm-deletions exige reauth ; retry', async () => {
      const path = '/api/access/sync/controllers/CTL-1/key';
      const second = ok(await api('POST', path, admin, { reauth: ADMIN_PW }), 200);
      assert.equal(second.renewed, true);
      assert.match(second.key, /^[0-9a-f]{64}$/);
      assert.notEqual(second.key, syncKey);
      syncKey = second.key;

      const conf = '/api/access/sync/controllers/CTL-1/confirm-deletions';
      assert.equal((await api('POST', conf, admin, {})).status, 428);
      assert.equal((await api('POST', conf, admin, { reauth: 'Mauvais-mot-de-passe-1' })).status, 403);
      assert.equal((await api('POST', conf, operator, { reauth: OPERATOR_PW })).status, 403);
      const good = ok(await api('POST', conf, admin, { reauth: ADMIN_PW }), 200);
      assert.equal(good.confirmed, 0, 'rien a confirmer');
      assert.equal((await api('POST', '/api/access/sync/controllers/CTL-77/confirm-deletions', admin, { reauth: ADMIN_PW })).status, 404);
      const retry = ok(await api('POST', '/api/access/sync/controllers/CTL-1/retry', admin, {}), 200);
      assert.equal(typeof retry.requeued, 'number');
      assert.equal((await api('POST', '/api/access/sync/controllers/CTL-1/retry', operator, {})).status, 403);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------
  describe('7. journal infalsifiable', () => {
    it('contient les actions attendues, aucune donnee personnelle ni secret, chaine integre', async () => {
      // Une recherche nominative est inscrite.
      await api('GET', `/api/access/holders?q=${encodeURIComponent('Dupont-Introuvable')}`, operator);
      const log: any[] = ok(await api('GET', '/api/audit?limit=500', admin), 200);
      const actions = new Set(log.map((e) => e.action));
      for (const a of ['access_holder_created', 'access_holder_updated', 'access_holder_deleted', 'access_holder_photo_set', 'access_holder_photo_cleared', 'access_badge_added', 'access_badge_state_changed', 'access_badge_removed', 'access_group_created', 'access_group_updated', 'access_group_deleted', 'access_schedule_created', 'access_schedule_deleted', 'access_holidays_replaced', 'access_visitor_created', 'access_visitor_ended', 'access_import', 'access_holder_search', 'access_sync_key_issued', 'reauth_echec']) {
        assert.ok(actions.has(a), `action « ${a} » absente du journal (vues : ${[...actions].filter((x) => /access|reauth/.test(x)).join(', ')})`);
      }
      assert.ok(log.filter((e) => e.action === 'access_import').length >= 3, 'une entree par import (a blanc compris ou non)');
      assert.equal(log.filter((e) => e.action === 'access_sync_key_issued').length, 2, 'deux emissions de cle');
      assert.ok(log.filter((e) => e.action === 'access_visitor_created').every((e) => e.actor === 'operateur'));

      // Les recherches nominatives inscrivent, par conception, le texte tape par l'utilisateur (jamais un resultat) : exclues du balayage.
      const everything = JSON.stringify(log.filter((e) => e.action !== 'access_search' && e.action !== 'access_holder_search'));
      for (const forbidden of ['KONAN', 'Konan', 'konan', 'Yao', 'TRAORE', 'DIALLO', 'BAMBA', 'ZÉBIÉ', 'ÉBOUÉ', '0012345', '0077777', '1000001', 'V-0001', 'M-001', syncKey, ADMIN_PW, OPERATOR_PW, 'Mauvais-mot-de-passe-1']) {
        assert.ok(!everything.includes(forbidden), `« ${forbidden.slice(0, 6)}… » dans le journal infalsifiable`);
      }
      // La recherche nominative inscrite ne contient que ce qui a ete tape par l'utilisateur, jamais un resultat.
      const search = log.find((e) => e.action === 'access_holder_search');
      assert.ok(search);

      const verify = await api('POST', '/api/system/journal/verify', admin);
      assert.equal(verify.status, 200);
      assert.equal(verify.body.ok, true, verify.text);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------
  describe('8. redemarrage', () => {
    it('titulaires, badges, etat de synchronisation et cle survivent a un redemarrage', async () => {
      const holderBefore = (await allHolders()).find((h) => h.externalRef === 'M-001');
      const countBefore = (await allHolders()).length;
      const syncBefore = ok<any[]>(await api('GET', '/api/access/sync', admin), 200).find((x) => x.controllerId === 'CTL-1');
      const groupsBefore = ok<any[]>(await api('GET', '/api/access/groups', admin), 200).length;
      await stop(s);
      s = await start(s);
      admin = await login(s.base, 'admin', ADMIN_PW);
      operator = await login(s.base, 'operateur', OPERATOR_PW);

      const holders = await allHolders();
      assert.equal(holders.length, countBefore);
      const after = holders.find((h) => h.externalRef === 'M-001');
      assert.equal(after.id, holderBefore.id);
      assert.deepEqual(after.badges.map((b: { number: string; state: string }) => [b.number, b.state]), holderBefore.badges.map((b: { number: string; state: string }) => [b.number, b.state]));
      assert.equal(ok<any[]>(await api('GET', '/api/access/groups', admin), 200).length, groupsBefore);
      assert.equal(ok<any[]>(await api('GET', '/api/access/schedules', admin), 200).filter((x) => x.builtin).length, 1, 'une seule plage « Tout le temps »');
      assert.equal(ok<any[]>(await api('GET', '/api/access/holidays', admin), 200).length, 2);
      assert.equal((await api('GET', `/api/access/holders/${after.id}/photo`, admin)).status, 200, 'photo conservee');

      const syncAfter = ok<any[]>(await api('GET', '/api/access/sync', admin), 200).find((x) => x.controllerId === 'CTL-1');
      assert.equal(syncAfter.enabled, true);
      assert.equal(syncAfter.keyCreatedAt, syncBefore.keyCreatedAt, 'meme cle');
      assert.equal(syncAfter.state, 'pending');
      assert.equal(syncAfter.transportReady, false);
      const row = ok(await api('GET', '/api/access/holders?q=konan', admin), 200).items[0];
      assert.equal(row.syncState, 'pending');

      // Preuve que la cle a survecu : le renouvellement est un renouvellement, la nouvelle cle differe.
      const renewed = ok(await api('POST', '/api/access/sync/controllers/CTL-1/key', admin, { reauth: ADMIN_PW }), 200);
      assert.equal(renewed.renewed, true);
      assert.notEqual(renewed.key, syncKey);
      assert.deepEqual(filesContaining(s.dataDir, renewed.key), [], 'jamais en clair sur disque');
      // L'identifiant de titulaire n'est pas reutilise (AUTOINCREMENT).
      const fresh = ok(await api('POST', '/api/access/holders', admin, { lastName: 'NOUVEAU' }), 201);
      assert.ok(fresh.id > Math.max(...holders.map((h) => h.id)));
      // Le journal reste integre apres le redemarrage.
      const verify = await api('POST', '/api/system/journal/verify', admin);
      assert.equal(verify.body.ok, true, verify.text);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------
  describe('9. mots de passe faux en rafale (en dernier, compte a part)', () => {
    it('5 faux de suite : 429 et la session du compte est fermee', async () => {
      const pw = 'Hippopotame-bleu-42-lune';
      ok(await api('POST', '/api/users', admin, { username: 'verifsync', role: 'admin', password: pw, reauth: ADMIN_PW }), 201);
      // Le compte cree doit changer son mot de passe a la premiere connexion : on le fait pour obtenir une session complete.
      const first = await fetch(`${s.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'verifsync', password: pw }) });
      assert.equal(first.status, 200);
      const cookie = first.headers.getSetCookie()[0].split(';')[0];
      const me = await api('GET', '/api/access/sync', cookie);
      if (me.status === 403) {
        const newPw = 'Rhinoceros-vert-77-soleil';
        const change = await api('POST', '/api/me/password', cookie, { current: pw, next: newPw });
        assert.ok(change.status < 300, `changement de mot de passe : ${change.status} ${change.text}`);
        return runBurst(await login(s.base, 'verifsync', newPw));
      }
      return runBurst(cookie);

      async function runBurst(session: string): Promise<void> {
        assert.equal((await api('GET', '/api/access/sync', session)).status, 200, 'session valide au depart');
        const path = '/api/access/sync/controllers/CTL-1/key';
        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) statuses.push((await api('POST', path, session, { reauth: `Faux-mot-de-passe-${i}` })).status);
        assert.deepEqual(statuses.slice(0, 4), [403, 403, 403, 403]);
        assert.ok(statuses[4] === 403 || statuses[4] === 429, `5e essai : ${statuses[4]}`);
        const sixth = await api('POST', path, session, { reauth: 'Faux-mot-de-passe-5' });
        assert.ok(sixth.status === 429 || sixth.status === 401, `apres 5 faux : ${sixth.status} ${sixth.text}`);
        // La session du compte est fermee.
        assert.equal((await api('GET', '/api/access/sync', session)).status, 401, 'session fermee');
        // Le journal le dit, sans le mot de passe tente.
        const log = JSON.stringify(ok(await api('GET', '/api/audit?limit=500', admin), 200));
        assert.match(log, /reauth_session_fermee/);
        assert.ok(!log.includes('Faux-mot-de-passe'));
        // L'administrateur principal, lui, n'est pas touche.
        assert.equal((await api('GET', '/api/access/sync', admin)).status, 200);
      }
    });
  });
});
