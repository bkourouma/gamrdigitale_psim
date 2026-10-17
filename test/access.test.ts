/**
 * Controle d'acces (lot AC2) : journal des passages, etat des portes, escalade « maintenue ouverte », recherche, export, purge,
 * controleurs. Moteur REEL + module d'acces REEL, base en memoire, horloge injectee (aucune attente reelle).
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, it } from 'node:test';
import { createAccess, displayState, EXPORT_MAX_ROWS, holderKey, migrateAccess, resultLabel, validateAccessField } from '../server/access.ts';
import type { AccessHook, AccessService } from '../server/access.ts';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import type { Engine, EngineOptions } from '../server/engine.ts';
import { seedDemo } from '../server/seed.ts';
import { unseal } from '../server/secrets.ts';

// Caracteres invisibles ou de controle, construits par code (illisibles et fragiles dans un fichier source).
const BIDI = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const LINESEP = String.fromCharCode(0x2028);
const S = 1000;
const MIN = 60 * S;
const DAY = 24 * 60 * MIN;
const T = Date.UTC(2026, 9, 17, 8, 0, 0);
const SEED = join(import.meta.dirname, '..', 'seed');

let db: DatabaseSync;
let engine: Engine;
let access: AccessService;
let clock: number;
let key: Buffer;
let stateCalls: { id: string; state: string; event: string }[];

/** Moteur + module d'acces cables comme le fera main.ts : le module appelle le journal et l'etat du moteur, le moteur appelle le module. */
function setup(engineOptions: EngineOptions = {}, accessOverrides: { retentionDays?: number; purgeBatch?: number; purgeMaxRows?: number } = {}): void {
  db = openDb(':memory:');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-access-')), SEED);
  clock = T;
  key = randomBytes(32);
  stateCalls = [];
  access = createAccess({
    db,
    now: () => clock,
    key,
    audit: (actor, action, ref) => engine.audit(actor, action, ref),
    setDeviceState: (id, state, event) => {
      stateCalls.push({ id, state, event });
      return engine.setStateBySupervisor(id, state, event);
    },
    ...accessOverrides,
  });
  engine = createEngine(db, () => {}, () => clock, { access, ...engineOptions });
  engine.createDevice('admin', { id: 'A-02', kind: 'detector', name: 'Porte B', zone: 'Entrepot', category: 'access' });
  access.createController('admin', { id: 'CTL-1', name: 'Controleur entree', brand: 'dahua' });
  access.declareDoor('admin', { detectorId: 'A-01', controllerId: 'CTL-1', doorNo: 1 });
  access.declareDoor('admin', { detectorId: 'A-02', controllerId: 'CTL-1', doorNo: 2 });
}

let seq = 0;
type Json = Record<string, unknown>;

/** Message de passage conforme au contrat (docs/CONTROLE-ACCES.md § 2). `over` : champs du message ; `acc` : champs de `access`. */
function passage(over: Json = {}, acc: Json = {}): Json {
  const eventId = String(++seq);
  return {
    event: 'badge_granted',
    ts: clock - 5 * S,
    msgId: `acc:CTL-1:${eventId}`,
    access: {
      v: 1, controllerId: 'CTL-1', eventId, direction: 'in', credential: '0012345', holderName: 'KONAN Yao', holderRef: '101',
      method: 'badge', result: 'granted', reason: null, deferred: false, ...acc,
    },
    ...over,
  };
}

const events = () => db.prepare('SELECT * FROM access_event ORDER BY id').all() as Json[];
const dev = (id: string) => db.prepare('SELECT * FROM device WHERE id = ?').get(id) as Json;
const doorRow = (id: string) => db.prepare('SELECT * FROM access_door WHERE detector_id = ?').get(id) as Json;
const audits = (action: string) => engine.listAudit(500).filter((e) => e.action === action).reverse(); // du plus ancien au plus recent
const incidents = (id: string) => engine.getSnapshot().incidents.filter((i) => i.detectorId === id);
const send = (id: string, payload: unknown) => engine.ingest(id, payload);
const door = (id: string) => access.doors().find((d) => d.detectorId === id)!;

/** Insere un passage directement (jeux de donnees des recherches, de la purge et de l'export). */
let rawSeq = 0;
function insertRaw(f: { at: number; door?: string; controller?: string; credential?: string | null; holder?: string | null; ref?: string | null; result?: 'granted' | 'denied'; reason?: string | null; late?: boolean; direction?: string | null; method?: string; received?: number }): number {
  const res = db
    .prepare(
      `INSERT INTO access_event (door_id, controller_id, at_device, at_received, direction, credential, holder_name, holder_key, holder_ref, method, result, reason, device_event_id, late)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      f.door ?? 'A-01', f.controller ?? 'CTL-1', f.at, f.received ?? f.at + 500, f.direction ?? null, f.credential ?? null, f.holder ?? null,
      f.holder ? holderKey(f.holder) : null, f.ref ?? null, f.method ?? 'badge', f.result ?? 'granted', f.reason ?? null, `raw-${++rawSeq}`, f.late ? 1 : 0,
    );
  return Number(res.lastInsertRowid);
}

describe('enregistrement des passages', () => {
  beforeEach(() => setup());

  it("un passage accepte est enregistre avec l'heure BRUTE du controleur, l'heure de reception et tous ses champs", () => {
    const ts = clock - 5 * S;
    assert.deepEqual(send('A-01', passage({ ts })), { ok: true });
    const [e] = events();
    assert.equal(e.door_id, 'A-01');
    assert.equal(e.controller_id, 'CTL-1');
    assert.equal(e.at_device, ts);
    assert.equal(e.at_received, clock);
    assert.equal(e.direction, 'in');
    assert.equal(e.credential, '0012345');
    assert.equal(e.holder_name, 'KONAN Yao');
    assert.equal(e.holder_key, 'konan yao');
    assert.equal(e.holder_ref, '101');
    assert.equal(e.method, 'badge');
    assert.equal(e.result, 'granted');
    assert.equal(e.reason, null);
    assert.equal(e.late, 0);
    assert.equal(e.holder_id, null);
    assert.equal(doorRow('A-01').last_passage_at, ts);
  });

  it("un passage accepte ne change ni l'etat de l'equipement ni n'ouvre d'incident (signe de vie)", () => {
    send('A-01', passage());
    assert.equal(dev('A-01').status, 'normal');
    assert.equal(dev('A-01').last_seen, clock - 5 * S); // le dernier signe de vie est l'heure REELLE de l'evenement (ts)
    assert.equal(incidents('A-01').length, 0);
  });

  it('la reception est « en differe » si le controleur le dit (deferred) ou si le retard atteint une minute', () => {
    send('A-01', passage({ ts: clock - 59 * S }));
    send('A-01', passage({ ts: clock - 60 * S }));
    send('A-01', passage({ ts: clock - 2 * S }, { deferred: true }));
    send('A-01', passage({ ts: clock - 3 * DAY }));
    assert.deepEqual(events().map((e) => e.late), [0, 1, 1, 1]);
  });

  it("l'ecart d'horloge n'est mesure que sur un passage en direct (ni differe, ni tardif)", () => {
    send('A-01', passage({ ts: clock - 30 * S }));
    assert.equal(access.controller('CTL-1').clockOffsetMs, -30 * S);
    send('A-01', passage({ ts: clock - 2 * S }, { deferred: true }));
    send('A-01', passage({ ts: clock - 10 * MIN }));
    assert.equal(access.controller('CTL-1').clockOffsetMs, -30 * S); // inchange
    send('A-01', passage({ ts: clock + 90 * S })); // controleur en avance
    assert.equal(access.controller('CTL-1').clockOffsetMs, 90 * S);
  });

  it("un ts dans le futur proche est garde brut ; au-dela de 24 h il est ramene a l'heure d'arrivee (jamais une ligne impossible a purger)", () => {
    const quiet = console.warn;
    console.warn = () => {};
    try {
      send('A-01', passage({ ts: clock + 3 * MIN }));
      send('A-01', passage({ ts: clock + 3 * DAY }));
    } finally {
      console.warn = quiet;
    }
    assert.deepEqual(events().map((e) => e.at_device), [clock + 3 * MIN, clock]);
  });

  it('le dernier signe de vie du controleur est mis a jour', () => {
    assert.equal(access.controller('CTL-1').lastSeen, null);
    send('A-01', passage());
    assert.equal(access.controller('CTL-1').lastSeen, clock);
    clock += 40 * S;
    send('A-02', { event: 'heartbeat' }); // un signe de vie d'une porte suffit
    assert.equal(access.controller('CTL-1').lastSeen, clock);
    clock += 40 * S;
    send('A-02', { state: 'offline' }); // « injoignable » n'est pas un signe de vie
    assert.equal(access.controller('CTL-1').lastSeen, clock - 40 * S);
  });

  it("une porte NON declaree enregistre quand meme le passage (door_id = detecteur) ; son etat n'est pas suivi", () => {
    engine.createDevice('admin', { id: 'A-09', kind: 'detector', name: 'Porte libre', zone: 'Entrepot', category: 'access' });
    assert.deepEqual(send('A-09', passage()), { ok: true });
    assert.equal(events()[0].door_id, 'A-09');
    assert.deepEqual(send('A-09', { event: 'door_opened' }), { ok: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM access_door WHERE detector_id = ?').get('A-09')!.n, 0);
  });

  it('un controleur non declare est accepte : on ne perd jamais un passage', () => {
    engine.createDevice('admin', { id: 'A-08', kind: 'detector', name: 'Porte sans controleur', zone: 'Entrepot', category: 'access' });
    assert.deepEqual(send('A-08', passage({ msgId: 'acc:CTL-X:1' }, { controllerId: 'CTL-X', eventId: '1' })), { ok: true });
    assert.equal(events()[0].controller_id, 'CTL-X');
    assert.equal(access.controller('CTL-1').lastSeen, null); // le controleur declare n'est pas touche
  });

  it('refus sans motif : « other » ; motif fourni sur un passage accepte : ignore', () => {
    send('A-01', passage({ event: 'badge_denied' }, { result: 'denied', reason: null }));
    send('A-01', passage({ event: 'badge_denied' }, { result: 'denied', reason: 'expired' }));
    send('A-01', passage({}, { result: 'granted', reason: 'expired' }));
    send('A-01', passage({ event: 'badge_denied' }, { result: 'denied' })); // champ absent
    assert.deepEqual(events().map((e) => e.reason), ['other', 'expired', null, 'other']);
  });

  it('les champs facultatifs absents valent null ; aucun champ inconnu, code PIN ou gabarit n\'est jamais stocke', () => {
    const msg = passage({ template: 'GABARIT-SECRET', pin: '4321' }, { pin: '987654', template: 'EMPREINTE-SECRETE', password: 'x', extra: { a: 1 } });
    delete (msg.access as Json).direction;
    delete (msg.access as Json).credential;
    delete (msg.access as Json).holderName;
    delete (msg.access as Json).holderRef;
    delete (msg.access as Json).reason;
    delete (msg.access as Json).deferred;
    assert.deepEqual(send('A-01', msg), { ok: true });
    const [e] = events();
    assert.equal(e.direction, null);
    assert.equal(e.credential, null);
    assert.equal(e.holder_name, null);
    assert.equal(e.holder_key, null);
    assert.equal(e.holder_ref, null);
    assert.equal(e.late, 0);
    const dump = JSON.stringify(db.prepare('SELECT * FROM access_event').all()) + JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
    for (const secret of ['GABARIT-SECRET', '4321', '987654', 'EMPREINTE-SECRETE']) assert.ok(!dump.includes(secret), secret);
    assert.deepEqual(Object.keys(e).sort(), [
      'at_device', 'at_received', 'controller_id', 'credential', 'device_event_id', 'direction', 'door_id', 'holder_id', 'holder_key', 'holder_name', 'holder_ref', 'id', 'late', 'method', 'reason', 'result',
    ]);
  });

  it('nom et badge : forme composee (NFC) et espaces de bord retires', () => {
    send('A-01', passage({}, { holderName: '  Renée  ', credential: ' 77 ' }));
    const [e] = events();
    assert.equal(e.holder_name, 'Renée');
    assert.equal(e.credential, '77');
  });

  it("les limites exactes passent (badge 32, nom 64, reference 32, identifiants 32 et 40) et le contrat d'exemple est valide", () => {
    assert.deepEqual(send('A-02', passage({}, { eventId: 'e'.repeat(40), credential: 'c'.repeat(32), holderName: 'n'.repeat(64), holderRef: 'r'.repeat(32) })), { ok: true });
    assert.equal(validateAccessField({ v: 1, controllerId: 'C'.repeat(32), eventId: 'e', method: 'badge', result: 'granted' }).ok, true);
    assert.equal(validateAccessField({ v: 1, controllerId: 'CTL-1', eventId: '123456', direction: 'in', credential: '0012345', holderName: 'KONAN Yao', holderRef: '101', method: 'badge', result: 'granted', reason: null, deferred: false }).ok, true);
  });
});

describe('doublons', () => {
  beforeEach(() => setup());

  it("le meme eventId avec un autre msgId est un doublon : succes sans effet, un seul passage, msgId retenu", () => {
    const first = passage({ msgId: 'acc:CTL-1:a' }, { eventId: '42' });
    assert.deepEqual(send('A-01', first), { ok: true });
    clock += 10 * S;
    const lastSeen = dev('A-01').last_seen;
    const again = passage({ msgId: 'acc:CTL-1:b' }, { eventId: '42', credential: '9999999' });
    assert.deepEqual(send('A-01', again), { ok: true, duplicate: true });
    assert.equal(events().length, 1);
    assert.equal(events()[0].credential, '0012345'); // la premiere version fait foi
    assert.equal(dev('A-01').last_seen, lastSeen); // rien n'est applique
    assert.ok(db.prepare("SELECT 1 FROM ingest_dedup WHERE device_id = 'A-01' AND msg_id = 'acc:CTL-1:b'").get());
  });

  it("le msgId deja traite est un doublon du socle ; apres perte de la memoire des msgId, l'index du journal prend le relais", () => {
    const msg = passage({}, { eventId: '7' });
    assert.deepEqual(send('A-01', msg), { ok: true });
    assert.deepEqual(send('A-01', msg), { ok: true, duplicate: true });
    db.exec('DELETE FROM ingest_dedup');
    assert.deepEqual(send('A-01', msg), { ok: true, duplicate: true });
    assert.equal(events().length, 1);
  });

  it('un doublon ne rejoue ni le dernier passage de la porte ni son etat', () => {
    send('A-01', passage({ ts: clock - 20 * S }, { eventId: '5' }));
    send('A-01', { event: 'door_opened', ts: clock - 10 * S });
    const before = doorRow('A-01');
    send('A-01', passage({ ts: clock - 1 * S, msgId: 'acc:CTL-1:x' }, { eventId: '5' }));
    assert.deepEqual(doorRow('A-01'), before);
  });

  it('le meme eventId sur deux controleurs differents n\'est pas un doublon', () => {
    access.createController('admin', { id: 'CTL-2', name: 'Controleur 2', brand: 'zkteco' });
    engine.createDevice('admin', { id: 'A-03', kind: 'detector', name: 'Porte C', zone: 'Entrepot', category: 'access' });
    access.declareDoor('admin', { detectorId: 'A-03', controllerId: 'CTL-2', doorNo: 1 });
    assert.deepEqual(send('A-01', passage({ msgId: 'acc:CTL-1:1' }, { eventId: '1' })), { ok: true });
    assert.deepEqual(send('A-03', passage({ msgId: 'acc:CTL-2:1' }, { eventId: '1', controllerId: 'CTL-2' })), { ok: true });
    assert.equal(events().length, 2);
  });

  it('apres un redemarrage (nouveau module sur la meme base) le doublon est toujours detecte', () => {
    const msg = passage({}, { eventId: '77' });
    send('A-01', msg);
    const restarted = createAccess({ db, now: () => clock, key, audit: () => {}, setDeviceState: () => true });
    const engine2 = createEngine(db, () => {}, () => clock, { access: restarted });
    db.exec('DELETE FROM ingest_dedup');
    assert.deepEqual(engine2.ingest('A-01', msg), { ok: true, duplicate: true });
    assert.equal(events().length, 1);
  });
});

describe('passage refuse (400) : rien n\'est applique', () => {
  beforeEach(() => setup());

  /** Chaque variante est refusee en 400 avec une raison, sans passage enregistre ni signe de vie. */
  function refused(label: string, payload: unknown, device = 'A-01', fragment?: RegExp): void {
    const before = dev(device).last_seen;
    const res = send(device, payload);
    assert.equal(res.ok, false, label);
    if (!res.ok) {
      assert.equal(res.status, 400, label);
      assert.ok(res.error.length > 0, label);
      if (fragment) assert.match(res.error, fragment, label);
    }
    assert.equal(events().length, 0, `${label} : aucun passage`);
    assert.equal(dev(device).last_seen, before, `${label} : last_seen inchange`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingest_dedup').get()!.n, 0, `${label} : msgId non retenu`);
  }

  const variants: [string, (a: Json) => void][] = [
    ['v absent', (a) => delete a.v],
    ['v = 2', (a) => (a.v = 2)],
    ['v = "1"', (a) => (a.v = '1')],
    ['controllerId avec espace', (a) => (a.controllerId = 'CTL 1')],
    ['controllerId vide', (a) => (a.controllerId = '')],
    ['controllerId de 33 caracteres', (a) => (a.controllerId = 'C'.repeat(33))],
    ['controllerId nombre', (a) => (a.controllerId = 5)],
    ['controllerId tableau', (a) => (a.controllerId = ['CTL-1'])],
    ['controllerId absent', (a) => delete a.controllerId],
    ['eventId absent', (a) => delete a.eventId],
    ['eventId avec espace', (a) => (a.eventId = '12 3')],
    ['eventId de 41 caracteres', (a) => (a.eventId = 'e'.repeat(41))],
    ['eventId nombre', (a) => (a.eventId = 123)],
    ['direction inconnue', (a) => (a.direction = 'up')],
    ['direction nombre', (a) => (a.direction = 1)],
    ['credential nombre', (a) => (a.credential = 12345)],
    ['credential de 33 caracteres', (a) => (a.credential = 'c'.repeat(33))],
    ['credential tableau', (a) => (a.credential = ['1'])],
    ['credential objet', (a) => (a.credential = { n: 1 })],
    ['holderName de 65 caracteres', (a) => (a.holderName = 'n'.repeat(65))],
    ['holderName objet', (a) => (a.holderName = { first: 'a' })],
    ['holderName tableau', (a) => (a.holderName = ['a'])],
    ['holderName booleen', (a) => (a.holderName = true)],
    ['holderRef de 33 caracteres', (a) => (a.holderRef = 'r'.repeat(33))],
    ['holderRef nombre', (a) => (a.holderRef = 101)],
    ['method absent', (a) => delete a.method],
    ['method inconnue', (a) => (a.method = 'telepathie')],
    ['method nombre', (a) => (a.method = 1)],
    ['result absent', (a) => delete a.result],
    ['result inconnu', (a) => (a.result = 'maybe')],
    ['result majuscules', (a) => (a.result = 'GRANTED')],
    ['reason inconnue', (a) => (a.reason = 'pas_de_chance')],
    ['reason nombre', (a) => (a.reason = 3)],
    ['reason objet', (a) => (a.reason = {})],
    ['deferred texte', (a) => (a.deferred = 'true')],
    ['deferred nombre', (a) => (a.deferred = 1)],
    ['caractere de controle (retour a la ligne) dans le nom', (a) => (a.holderName = 'KONAN\nYao')],
    ['caractere de controle (bip) dans le badge', (a) => (a.credential = '12\u000745')],
    ['caractere nul dans la reference', (a) => (a.holderRef = '1\u00002')],
    ['bidi U+202E dans le nom', (a) => (a.holderName = `Yao${BIDI}gpj.exe`)],
    ['espace de largeur nulle U+200B dans le badge', (a) => (a.credential = `12${ZWSP}3`)],
    ['separateur de ligne U+2028 dans le nom', (a) => (a.holderName = `a${LINESEP}b`)],
    ['tabulation dans le nom', (a) => (a.holderName = 'a\tb')],
    ['surrogate isole dans le nom', (a) => (a.holderName = 'a\ud800b')],
    ['nom de 100 Ko', (a) => (a.holderName = 'x'.repeat(100_000))],
    ['badge de 100 Ko', (a) => (a.credential = '9'.repeat(100_000))],
    ['controllerId de 100 Ko', (a) => (a.controllerId = 'C'.repeat(100_000))],
  ];
  for (const [label, mutate] of variants) {
    it(`access invalide : ${label}`, () => {
      const msg = passage();
      mutate(msg.access as Json);
      refused(label, msg);
    });
  }

  for (const [label, access_] of [['null', null], ['tableau', []], ['texte', 'badge'], ['nombre', 5], ['booleen', true], ['tableau de passages', [{ v: 1 }]]] as [string, unknown][]) {
    it(`access n'est pas un objet : ${label}`, () => refused(label, passage({ access: access_ })));
  }

  it('ts absent : refuse, avec la raison', () => {
    const msg = passage();
    delete msg.ts;
    refused('ts absent', msg, 'A-01', /ts requis/);
  });

  it("ts invalide (secondes, negatif, texte) : refuse par le socle avant le module", () => {
    refused('ts texte', passage({ ts: '1760000000000' }));
    refused('ts negatif', passage({ ts: -5 }));
    refused('ts decimal', passage({ ts: 1.5 }));
  });

  it("event incoherent avec le resultat : refuse", () => {
    refused('accepte annonce comme refuse', passage({ event: 'badge_denied' }), 'A-01', /badge_granted/);
    refused('refuse annonce comme accepte', passage({ event: 'badge_granted' }, { result: 'denied' }), 'A-01', /badge_denied/);
    refused('autre evenement', passage({ event: 'door_opened' }));
    refused('signe de vie', passage({ event: 'heartbeat' }));
    refused('etat a la place', (() => { const m = passage(); delete m.event; m.state = 'normal'; return m; })());
    refused('evenement inconnu', passage({ event: 'badge_grantd' }));
  });

  it("controleur different de celui declare pour la porte : refuse", () => {
    access.createController('admin', { id: 'CTL-2', name: 'Controleur 2', brand: 'zkteco' });
    refused('autre controleur', passage({}, { controllerId: 'CTL-2' }), 'A-01', /autre controleur/);
  });

  it("detecteur qui n'est pas de categorie access : refuse (champ access refuse)", () => {
    refused('detecteur incendie', passage(), 'D-01', /categorie/);
  });

  it("detecteur introuvable : 404 du socle, rien n'est ecrit", () => {
    const res = send('A-77', passage());
    assert.equal(res.ok, false);
    assert.equal(events().length, 0);
  });

  it("un message qui n'est pas un passage sur une porte sans champ access reste accepte (signe de vie)", () => {
    assert.deepEqual(send('A-01', { event: 'heartbeat' }), { ok: true });
    assert.deepEqual(send('A-01', { event: 'badge_granted' }), { ok: true }); // sans access : comportement d'avant
    assert.equal(events().length, 0);
  });
});

describe('donnees hostiles', () => {
  beforeEach(() => setup());

  it('__proto__ / constructor dans access : ignores, jamais stockes ni promus', () => {
    const msg = JSON.parse(
      '{"event":"badge_granted","ts":' + (clock - 1000) + ',"access":{"v":1,"controllerId":"CTL-1","eventId":"p1","direction":null,"credential":"1","holderName":null,"holderRef":null,"method":"badge","result":"granted","reason":null,"deferred":false,"__proto__":{"result":"denied","method":"face"},"constructor":{"prototype":{"result":"denied"}}}}',
    );
    assert.deepEqual(send('A-01', msg), { ok: true });
    assert.equal(events()[0].result, 'granted');
    assert.equal(events()[0].method, 'badge');
    assert.equal(({} as Json).result, undefined);
  });

  it("un champ `access` herite d'un prototype n'est pas un champ de passage", () => {
    const payload = Object.create({ access: { v: 1 } }) as Json;
    payload.event = 'heartbeat';
    assert.deepEqual(send('A-01', payload), { ok: true });
    assert.equal(events().length, 0);
  });

  it("__proto__ comme cle de premier niveau n'introduit pas de champ access", () => {
    const msg = JSON.parse('{"event":"heartbeat","__proto__":{"access":{"v":1}}}');
    assert.deepEqual(send('A-01', msg), { ok: true });
  });

  it("apostrophes, % et _ dans un nom ou un badge : stockes tels quels (parametres), jamais interpretes", () => {
    send('A-01', passage({}, { holderName: "O'Brien'); DROP TABLE access_event;--", credential: "5' OR '1'='1" }));
    send('A-01', passage({}, { holderName: '100% _Rémy_', credential: 'A%B_C\\D' }));
    assert.equal(events().length, 2);
    assert.equal(events()[0].holder_name, "O'Brien'); DROP TABLE access_event;--");
    assert.equal(events()[1].credential, 'A%B_C\\D');
  });

  it("access valide mais message enorme a cote (champ inconnu de 1 Mo) : le module n'y touche pas", () => {
    const msg = passage({ noise: 'z'.repeat(1_000_000) });
    assert.deepEqual(send('A-01', msg), { ok: true });
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM access_event').all()).includes('zzzzzzzz'));
  });

  it('validateAccessField ne leve jamais, quelle que soit l\'entree', () => {
    for (const [i, v] of [undefined, null, 0, '', 'x', [], {}, { v: 1 }, () => 1, 10n, Object.create(null), new Date(), /x/, NaN].entries()) {
      assert.doesNotThrow(() => validateAccessField(v), `entree n°${i}`);
    }
  });
});

describe("etat physique de la porte", () => {
  beforeEach(() => setup());

  it('door_opened -> ouverte ; door_closed -> fermee ; etat inconnu tant qu aucun message', () => {
    assert.equal(doorRow('A-01').door_state, 'unknown');
    assert.equal(door('A-01').state, 'unknown');
    send('A-01', { event: 'door_opened' });
    assert.equal(doorRow('A-01').door_state, 'open');
    assert.equal(door('A-01').state, 'open');
    send('A-01', { event: 'door_closed' });
    assert.equal(doorRow('A-01').door_state, 'closed');
    assert.equal(door('A-01').state, 'closed');
  });

  it('porte forcee : alarme critique, ouverte + forced_at ; refermee : efface', () => {
    send('A-01', { event: 'door_forced' });
    const r = doorRow('A-01');
    assert.equal(r.door_state, 'open');
    assert.equal(r.forced_at, clock);
    assert.equal(door('A-01').state, 'forced');
    assert.equal(dev('A-01').status, 'alarm');
    assert.equal(incidents('A-01')[0].severity, 'critical');
    clock += 30 * S;
    send('A-01', { event: 'door_closed' });
    assert.equal(doorRow('A-01').forced_at, null);
    assert.equal(door('A-01').state, 'closed');
  });

  it('porte maintenue ouverte : pre-alarme, held_since pose une seule fois', () => {
    send('A-01', { event: 'door_held_open' });
    assert.equal(doorRow('A-01').held_since, T);
    assert.equal(dev('A-01').status, 'prealarm');
    clock += 20 * S;
    send('A-01', { event: 'door_held_open' });
    assert.equal(doorRow('A-01').held_since, T); // pas deplace
    assert.equal(door('A-01').state, 'held_open');
    clock += 5 * S;
    send('A-01', { event: 'door_closed' });
    assert.equal(doorRow('A-01').held_since, null);
    assert.equal(door('A-01').state, 'closed');
  });

  it('normal / clear / restored / alarm_reset effacent forced et held sans changer la position', () => {
    for (const ev of ['normal', 'clear', 'restored', 'alarm_reset']) {
      send('A-01', { event: 'door_forced' });
      send('A-01', { event: 'door_held_open' });
      assert.equal(doorRow('A-01').door_state, 'open');
      clock += S;
      send('A-01', { event: ev });
      const r = doorRow('A-01');
      assert.equal(r.forced_at, null, ev);
      assert.equal(r.held_since, null, ev);
      assert.equal(r.door_state, 'open', ev);
    }
  });

  it("messages dates dans le desordre : un message plus ancien que l'etat connu ne l'ecrase pas", () => {
    send('A-01', { event: 'door_opened', ts: T - 10 * S });
    clock += 2 * S;
    send('A-01', { event: 'door_closed', ts: T - 20 * S }); // arrive apres, mais plus ancien
    assert.equal(doorRow('A-01').door_state, 'open');
    assert.equal(doorRow('A-01').door_state_at, T - 10 * S);
    send('A-01', { event: 'door_closed', ts: T - 5 * S });
    assert.equal(doorRow('A-01').door_state, 'closed');
    send('A-01', { event: 'door_opened', ts: T - 7 * S }); // ancien : ignore
    assert.equal(doorRow('A-01').door_state, 'closed');
    assert.equal(doorRow('A-01').door_state_at, T - 5 * S);
  });

  it('un message ancien ne rend ni une porte forcee ni maintenue ouverte apres sa fermeture plus recente', () => {
    send('A-01', { event: 'door_closed', ts: T - 5 * S });
    send('A-01', { event: 'door_forced', ts: T - 30 * S });
    send('A-01', { event: 'door_held_open', ts: T - 25 * S });
    const r = doorRow('A-01');
    assert.equal(r.door_state, 'closed');
    assert.equal(r.forced_at, null);
    assert.equal(r.held_since, null);
  });

  it("un passage enregistre date ancien n'ecrase pas non plus l'etat ; il met a jour le dernier passage au plus recent", () => {
    send('A-01', { event: 'door_opened', ts: T - 10 * S });
    send('A-01', passage({ ts: T - 40 * S }));
    send('A-01', passage({ ts: T - 3 * S }));
    send('A-01', passage({ ts: T - 60 * S }));
    assert.equal(doorRow('A-01').door_state, 'open');
    assert.equal(doorRow('A-01').last_passage_at, T - 3 * S);
  });

  it("message {state:'offline'} : etat inconnu, held et forced effaces", () => {
    send('A-01', { event: 'door_forced' });
    send('A-01', { event: 'door_held_open' });
    clock += S;
    send('A-01', { state: 'offline' });
    const r = doorRow('A-01');
    assert.equal(r.door_state, 'unknown');
    assert.equal(r.forced_at, null);
    assert.equal(r.held_since, null);
    assert.equal(door('A-01').state, 'offline');
  });

  it("apres une panne de silence, un signe de vie ne dit JAMAIS « fermee » : etat inconnu tant qu'aucun evenement de porte ne le confirme", () => {
    setup({ silentTimeoutMs: 120 * S });
    engine.updateDevice('admin', 'A-01', { heartbeatS: 60 });
    send('A-01', { event: 'door_closed' });
    assert.equal(door('A-01').state, 'closed');
    clock += 61 * S;
    assert.deepEqual(engine.checkSilentDetectors(), ['A-01']);
    assert.equal(dev('A-01').status, 'offline');
    assert.equal(door('A-01').state, 'offline');
    assert.equal(doorRow('A-01').door_state, 'closed'); // ancienne valeur en base, jamais affichee
    clock += 5 * S;
    send('A-01', { event: 'heartbeat' });
    assert.equal(dev('A-01').status, 'normal');
    assert.equal(doorRow('A-01').door_state, 'unknown');
    assert.equal(door('A-01').state, 'unknown');
    send('A-01', passage()); // un passage non plus ne confirme rien
    assert.equal(door('A-01').state, 'unknown');
    send('A-01', { event: 'door_closed' });
    assert.equal(door('A-01').state, 'closed');
  });

  it('un evenement de porte recu hors ligne la confirme', () => {
    setup();
    db.prepare("UPDATE device SET status = 'offline' WHERE id = 'A-01'").run();
    send('A-01', { event: 'door_opened' });
    assert.equal(doorRow('A-01').door_state, 'open');
    assert.equal(door('A-01').state, 'open');
  });

  it("un passage recu pendant que la porte est hors ligne la rend inconnue, meme si un normal arrive", () => {
    db.prepare("UPDATE device SET status = 'offline' WHERE id = 'A-01'").run();
    send('A-01', { event: 'door_closed' });
    db.prepare("UPDATE device SET status = 'offline' WHERE id = 'A-01'").run();
    send('A-01', { event: 'normal' });
    assert.equal(doorRow('A-01').door_state, 'unknown');
  });

  it('perte de liaison de la passerelle : meme regle (statut hors ligne)', () => {
    send('A-01', { event: 'door_closed' });
    db.prepare("UPDATE device SET status = 'offline' WHERE id = 'A-01'").run();
    send('A-01', { event: 'ping' });
    assert.equal(doorRow('A-01').door_state, 'unknown');
  });

  it("l'etat affiche d'une porte en defaut (fault) prime sur forcee / ouverte", () => {
    send('A-01', { event: 'door_forced' });
    send('A-01', { event: 'fault' });
    assert.equal(door('A-01').state, 'fault');
  });

  it("un evenement sur une porte non declaree n'echoue pas et ne cree rien", () => {
    engine.createDevice('admin', { id: 'A-07', kind: 'detector', name: 'Libre', zone: 'Entrepot', category: 'access' });
    for (const ev of ['door_opened', 'door_closed', 'door_forced', 'door_held_open', 'normal']) assert.deepEqual(send('A-07', { event: ev }), { ok: true });
    assert.equal(access.doors().length, 2);
  });
});

describe('escalade « maintenue ouverte »', () => {
  beforeEach(() => setup());

  it("avant le delai : rien ; au delai : alarme par le PSIM, incident aggrave, une ligne au journal, last_seen intact", () => {
    send('A-01', { event: 'door_held_open' });
    assert.equal(incidents('A-01')[0].severity, 'warning');
    clock = T + 299 * S;
    access.tick();
    assert.equal(stateCalls.length, 0);
    assert.equal(dev('A-01').status, 'prealarm');
    const lastSeen = dev('A-01').last_seen;
    assert.equal(lastSeen, T);
    clock = T + 300 * S;
    access.tick();
    assert.deepEqual(stateCalls, [{ id: 'A-01', state: 'alarm', event: 'door_held_open' }]);
    assert.equal(dev('A-01').status, 'alarm');
    assert.equal(dev('A-01').last_seen, lastSeen); // une porte muette doit pouvoir passer hors ligne
    assert.equal(incidents('A-01').length, 1);
    assert.equal(incidents('A-01')[0].severity, 'critical');
    assert.equal(incidents('A-01')[0].event, 'door_held_open');
    assert.equal(doorRow('A-01').held_escalated_at, T + 300 * S);
    const [line] = audits('access_door_held_escalated');
    assert.equal(line.actor, 'systeme');
    assert.equal(line.deviceId, 'A-01');
    assert.match(line.details!, /300 s/);
    assert.equal(door('A-01').state, 'held_open');
    assert.match(door('A-01').stateHint, /alarme est déclenchée/);
  });

  it('une seule escalade, meme si tick est appele souvent', () => {
    send('A-01', { event: 'door_held_open' });
    clock = T + 400 * S;
    for (let i = 0; i < 10; i++) {
      access.tick();
      clock += S;
    }
    assert.equal(stateCalls.length, 1);
    assert.equal(audits('access_door_held_escalated').length, 1);
  });

  it('porte refermee entre-temps : aucune escalade', () => {
    send('A-01', { event: 'door_held_open' });
    clock = T + 200 * S;
    send('A-01', { event: 'door_closed' });
    clock = T + 1000 * S;
    access.tick();
    assert.equal(stateCalls.length, 0);
    assert.equal(dev('A-01').status, 'normal');
    assert.equal(audits('access_door_held_escalated').length, 0);
  });

  it('porte hors ligne : aucune escalade, rien du tout', () => {
    send('A-01', { event: 'door_held_open' });
    db.prepare("UPDATE device SET status = 'offline' WHERE id = 'A-01'").run();
    clock = T + 1000 * S;
    access.tick();
    assert.equal(stateCalls.length, 0);
    assert.equal(doorRow('A-01').held_escalated_at, null);
    assert.equal(audits('access_door_held_escalated').length, 0);
  });

  it('retour en ligne apres coupure : etat inconnu, held efface, aucune escalade tardive', () => {
    send('A-01', { event: 'door_held_open' });
    db.prepare("UPDATE device SET status = 'offline' WHERE id = 'A-01'").run();
    clock = T + 1000 * S;
    send('A-01', { event: 'heartbeat' });
    access.tick();
    assert.equal(stateCalls.length, 0);
    assert.equal(doorRow('A-01').held_since, null);
  });

  it('detecteur deja en alarme (porte forcee en plus) : pas d\'escalade, pas de journal', () => {
    send('A-01', { event: 'door_held_open' });
    send('A-01', { event: 'door_forced' });
    clock = T + 1000 * S;
    access.tick();
    assert.equal(stateCalls.length, 0);
    assert.equal(doorRow('A-01').held_escalated_at, null);
  });

  it('delai propre a la porte (10 s au minimum)', () => {
    access.updateDoor('admin', 'A-01', { heldAlarmAfterS: 20 });
    send('A-01', { event: 'door_held_open' });
    clock = T + 19 * S;
    access.tick();
    assert.equal(stateCalls.length, 0);
    clock = T + 20 * S;
    access.tick();
    assert.equal(stateCalls.length, 1);
  });

  it('porte maintenue ouverte non declaree : pas de suivi (rien a escalader), pre-alarme du moteur seule', () => {
    engine.createDevice('admin', { id: 'A-07', kind: 'detector', name: 'Libre', zone: 'Entrepot', category: 'access' });
    send('A-07', { event: 'door_held_open' });
    clock = T + 1000 * S;
    access.tick();
    assert.equal(stateCalls.length, 0);
    assert.equal(dev('A-07').status, 'prealarm');
  });

  it("l'escalade d'un message rejoue (date) part de l'heure reelle de l'ouverture", () => {
    send('A-01', { event: 'door_held_open', ts: T - 290 * S });
    clock = T + 9 * S;
    access.tick();
    assert.equal(stateCalls.length, 0);
    clock = T + 10 * S;
    access.tick();
    assert.equal(stateCalls.length, 1);
  });

  it("une exception de setDeviceState ne plante jamais tick et n'enregistre pas l'escalade (nouvel essai a la seconde suivante)", () => {
    setup();
    let calls = 0;
    const flaky = createAccess({
      db, now: () => clock, key, audit: (a, act, ref) => engine.audit(a, act, ref),
      setDeviceState: () => {
        if (++calls === 1) throw new Error('boom');
        return true;
      },
    });
    send('A-01', { event: 'door_held_open' });
    clock = T + 400 * S;
    const quiet = console.error;
    console.error = () => {};
    try {
      assert.doesNotThrow(() => flaky.tick());
    } finally {
      console.error = quiet;
    }
    assert.equal(doorRow('A-01').held_escalated_at, null);
    clock += S;
    flaky.tick();
    assert.equal(calls, 2);
    assert.notEqual(doorRow('A-01').held_escalated_at, null);
  });

  it("un detecteur supprime du moteur : setDeviceState faux, rien n'est note", () => {
    setup();
    const ghost = createAccess({ db, now: () => clock, key, audit: () => {}, setDeviceState: () => false });
    send('A-01', { event: 'door_held_open' });
    clock = T + 400 * S;
    ghost.tick();
    assert.equal(doorRow('A-01').held_escalated_at, null);
  });
});

describe('refus de badge', () => {
  beforeEach(() => setup());

  it('un refus isole, et meme une rafale de refus de la porte, ne sont jamais un incident (journalises seulement)', () => {
    for (let i = 0; i < 12; i++) {
      assert.deepEqual(send('A-01', passage({ event: 'badge_denied' }, { result: 'denied', reason: 'unknown_credential' })), { ok: true });
      clock += S;
    }
    assert.equal(events().length, 12);
    assert.equal(incidents('A-01').length, 0);
    assert.equal(dev('A-01').status, 'normal');
    assert.equal(door('A-01').state, 'unknown'); // un refus ne dit rien de la position de la porte
  });

  it('badge_denied_repeated (compte par la passerelle) est une pre-alarme, sans toucher au journal des passages', () => {
    send('A-01', { event: 'badge_denied_repeated' });
    assert.equal(dev('A-01').status, 'prealarm');
    assert.equal(incidents('A-01')[0].severity, 'warning');
    assert.equal(events().length, 0);
  });
});

describe('point d\'accroche du moteur', () => {
  function stubEngine(hook: AccessHook) {
    const d = openDb(':memory:');
    seedDemo(d, mkdtempSync(join(tmpdir(), 'psim-access-')), SEED);
    return { d, e: createEngine(d, () => {}, () => T, { access: hook }) };
  }

  it("un refus du module est renvoye tel quel et rien n'est applique", () => {
    const { d, e } = stubEngine({ onMessage: () => ({ ok: false, status: 400, error: 'refuse pour la raison X' }) });
    assert.deepEqual(e.ingest('A-01', { event: 'badge_granted', msgId: 'm1' }), { ok: false, status: 400, error: 'refuse pour la raison X' });
    assert.equal((d.prepare("SELECT last_seen FROM device WHERE id = 'A-01'").get() as Json).last_seen, null);
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM ingest_dedup').get() as Json).n, 0);
  });

  it('duplicate : le msgId est retenu, succes sans effet', () => {
    const { d, e } = stubEngine({ onMessage: () => ({ ok: true, duplicate: true }) });
    assert.deepEqual(e.ingest('A-01', { event: 'door_forced', msgId: 'm1' }), { ok: true, duplicate: true });
    assert.equal((d.prepare("SELECT status FROM device WHERE id = 'A-01'").get() as Json).status, 'normal');
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM ingest_dedup').get() as Json).n, 1);
    // sans msgId : rien a retenir
    assert.deepEqual(e.ingest('A-01', { event: 'door_forced' }), { ok: true, duplicate: true });
  });

  it("exception du module : 500, message precis, msgId NON retenu (la passerelle renverra), jamais d'exception", () => {
    let boom = true;
    const { d, e } = stubEngine({
      onMessage: () => {
        if (boom) throw new Error('disque plein');
        return { ok: true };
      },
    });
    const quiet = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(e.ingest('A-01', { event: 'badge_granted', msgId: 'm1' }), { ok: false, status: 500, error: 'Erreur interne du journal des acces' });
      assert.doesNotThrow(() => e.handleDetectorMessage('A-01', { event: 'badge_granted', msgId: 'm2' }));
    } finally {
      console.error = quiet;
    }
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM ingest_dedup').get() as Json).n, 0);
    boom = false;
    assert.deepEqual(e.ingest('A-01', { event: 'badge_granted', msgId: 'm1' }), { ok: true });
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM ingest_dedup').get() as Json).n, 1);
  });

  it("tout le message dans UNE transaction : si son application echoue apres l'enregistrement du passage, rien n'est garde et le renvoi le retrouve", () => {
    setup();
    let fail = true;
    const flaky = createEngine(db, () => { if (fail) throw new Error('publication impossible'); }, () => clock, { access });
    const msg = passage();
    send('A-01', { event: 'door_opened' }); // etat deja en place, pour verifier qu'il n'est pas touche par l'echec
    const before = JSON.stringify(doorRow('A-01'));
    assert.throws(() => flaky.ingest('A-01', msg), /publication impossible/);
    assert.equal(events().length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingest_dedup').get()!.n, 0);
    assert.equal(JSON.stringify(doorRow('A-01')), before);
    assert.equal(access.controller('CTL-1').lastSeen, T); // celui du door_opened, pas celui du passage annule
    fail = false;
    assert.deepEqual(flaky.ingest('A-01', msg), { ok: true });
    assert.equal(events().length, 1);
    assert.deepEqual(flaky.ingest('A-01', msg), { ok: true, duplicate: true });
    assert.equal(events().length, 1);
  });

  it("un refus ou une exception du module n'ecrit rien, y compris ce que le moteur aurait ecrit avant (journal inclus)", () => {
    setup();
    const audit = engine.listAudit(500).length;
    send('A-01', passage({}, { method: 'telepathie' }));
    send('A-01', passage({ ts: undefined }));
    assert.equal(engine.listAudit(500).length, audit);
    assert.equal(events().length, 0);
  });

  it("le module n'est appele que pour une categorie access ou un message portant `access`", () => {
    const seen: string[] = [];
    const { e } = stubEngine({
      onMessage: (i) => {
        seen.push(i.device.id);
        return { ok: true };
      },
    });
    e.ingest('D-01', { state: 'normal' }); // incendie
    e.ingest('D-02', { event: 'heartbeat' });
    e.ingest('A-01', { event: 'heartbeat' }); // categorie access
    e.ingest('D-03', { event: 'badge_granted', access: { v: 1 } }); // champ access sur un autre detecteur
    e.ingest('D-04', { event: 'badge_granted', access: null });
    assert.deepEqual(seen, ['A-01', 'D-03', 'D-04']);
  });

  it("le module recoit l'evenement, l'etat lu et les metadonnees apres interpret", () => {
    let received: Json | null = null;
    const { e } = stubEngine({
      onMessage: (i) => {
        received = { event: i.event, state: i.state, dated: i.meta.dated, eventAt: i.meta.eventAt, id: i.device.id };
        return { ok: true };
      },
    });
    e.ingest('A-01', { event: 'door_forced', ts: T - 5000 });
    assert.deepEqual(received, { event: 'door_forced', state: 'alarm', dated: true, eventAt: T - 5000, id: 'A-01' });
    e.ingest('A-01', { state: 'offline' });
    assert.deepEqual(received, { event: null, state: 'offline', dated: false, eventAt: T, id: 'A-01' });
  });

  it("un message invalide pour interpret() est refuse AVANT le module", () => {
    let called = 0;
    const { e } = stubEngine({
      onMessage: () => {
        called++;
        return { ok: true };
      },
    });
    assert.equal(e.ingest('A-01', { event: 'inconnu' }).ok, false);
    assert.equal(called, 0);
  });

  it('sans module d\'acces, le moteur se comporte comme avant (le champ access est simplement ignore)', () => {
    const d = openDb(':memory:');
    seedDemo(d, mkdtempSync(join(tmpdir(), 'psim-access-')), SEED);
    const e = createEngine(d, () => {}, () => T);
    assert.deepEqual(e.ingest('A-01', { event: 'badge_granted', access: { v: 'nimporte quoi' } }), { ok: true });
  });
});

describe('setStateBySupervisor', () => {
  beforeEach(() => setup());

  it("applique l'etat par le chemin normal (incident, journal, historique) sans rajeunir last_seen", () => {
    send('A-01', { event: 'heartbeat' });
    const lastSeen = dev('A-01').last_seen;
    clock += 30 * S;
    assert.equal(engine.setStateBySupervisor('A-01', 'alarm', 'door_held_open'), true);
    assert.equal(dev('A-01').status, 'alarm');
    assert.equal(dev('A-01').last_seen, lastSeen);
    assert.equal(dev('A-01').state_since, clock);
    assert.equal(incidents('A-01')[0].severity, 'critical');
    assert.equal(incidents('A-01')[0].openedAt, clock);
    assert.ok(engine.listAudit(50).some((a) => a.action === 'incident_opened' && a.deviceId === 'A-01'));
  });

  it('faux si le detecteur n\'existe pas, ou si c\'est une camera', () => {
    assert.equal(engine.setStateBySupervisor('NOPE', 'alarm', 'x'), false);
    assert.equal(engine.setStateBySupervisor('C-01', 'alarm', 'x'), false);
  });

  it("n'est pas soumis a l'ordre des messages : un message date ancien arrive ensuite ne l'ecrase pas", () => {
    engine.setStateBySupervisor('A-01', 'alarm', 'door_held_open');
    send('A-01', { event: 'door_closed', ts: T - 60 * S });
    assert.equal(dev('A-01').status, 'alarm');
  });
});

describe('affichage de l\'etat (F2)', () => {
  it('priorite : hors ligne > en defaut > forcee > maintenue ouverte > ouverte > fermee > inconnu (toutes les combinaisons)', () => {
    for (const deviceStatus of ['offline', 'fault', 'alarm', 'prealarm', 'normal']) {
      for (const doorState of ['closed', 'open', 'unknown'] as const) {
        for (const forced of [false, true]) {
          for (const heldOpen of [false, true]) {
            const expected = deviceStatus === 'offline' ? 'offline' : deviceStatus === 'fault' ? 'fault' : forced ? 'forced' : heldOpen ? 'held_open' : doorState === 'open' ? 'open' : doorState === 'closed' ? 'closed' : 'unknown';
            const shown = displayState({ deviceStatus, doorState, forced, heldOpen });
            assert.equal(shown.state, expected, JSON.stringify({ deviceStatus, doorState, forced, heldOpen }));
            assert.ok(shown.label.length > 0 && shown.hint.length > 20);
          }
        }
      }
    }
  });

  it('libelles du contrat et textes en francais courant', () => {
    const base = { deviceStatus: 'normal', doorState: 'closed' as const, forced: false, heldOpen: false };
    assert.equal(displayState(base).label, 'Fermée');
    assert.equal(displayState({ ...base, doorState: 'open' }).label, 'Ouverte');
    assert.equal(displayState({ ...base, forced: true }).label, 'Forcée');
    assert.equal(displayState({ ...base, heldOpen: true }).label, 'Maintenue ouverte');
    assert.equal(displayState({ ...base, deviceStatus: 'offline' }).label, 'Hors ligne');
    assert.equal(displayState({ ...base, deviceStatus: 'fault' }).label, 'En défaut');
    assert.equal(displayState({ ...base, doorState: 'unknown' }).label, 'État inconnu');
    const offline = displayState({ ...base, deviceStatus: 'offline' }).hint;
    assert.match(offline, /badges/);
    assert.match(offline, /alimentation/);
    assert.match(offline, /réseau/);
    assert.equal(displayState({ ...base, forced: true }).hint, "La porte s'est ouverte sans autorisation. Regardez la caméra, puis traitez l'alarme.");
    // une porte maintenue ouverte DEJA escaladee en alarme change de texte
    assert.notEqual(displayState({ ...base, heldOpen: true, deviceStatus: 'alarm' }).hint, displayState({ ...base, heldOpen: true, deviceStatus: 'prealarm' }).hint);
  });

  it("DoorView : etat, date de l'etat, positions et cameras liees", () => {
    send('A-01', { event: 'door_opened' });
    const v = door('A-01');
    assert.equal(v.state, 'open');
    assert.equal(v.stateLabel, 'Ouverte');
    assert.equal(v.stateSince, T);
    assert.equal(v.doorState, 'open');
    assert.equal(v.deviceStatus, 'normal');
    assert.deepEqual(v.cameraIds, ['C-04']);
    assert.equal(v.controllerName, 'Controleur entree');
    assert.equal(v.kind, 'door');
    assert.equal(v.emergencyExit, false);
    assert.equal(v.heldAlarmAfterS, 300);
    assert.equal(v.actuatorId, null);
    assert.equal(v.name, 'Porte de service entrepot');
  });

  beforeEach(() => setup());
});

describe('fiche de porte', () => {
  beforeEach(() => setup());

  it('10 derniers passages du plus recent au plus ancien, cameras liees, ouverture a distance reservee', () => {
    for (let i = 0; i < 12; i++) insertRaw({ at: T - (12 - i) * MIN, door: 'A-01', credential: `B${i}` });
    insertRaw({ at: T, door: 'A-02', credential: 'AUTRE' });
    const d = access.door('A-01');
    assert.equal(d.lastPassages.length, 10);
    assert.deepEqual(d.lastPassages.map((p) => p.credential), ['B11', 'B10', 'B9', 'B8', 'B7', 'B6', 'B5', 'B4', 'B3', 'B2']);
    assert.deepEqual(d.cameras, [{ id: 'C-04', name: 'Camera entrepot', status: 'normal' }]);
    assert.equal(d.remote.available, false);
    assert.match(d.remote.reason, /AC4/);
    assert.equal(d.door.detectorId, 'A-01');
  });

  it("404 si la porte n'est pas declaree, ou si l'identifiant est farfelu", () => {
    for (const id of ['D-01', 'NOPE', "x'; --", '', 'a'.repeat(100)]) {
      assert.throws(() => access.door(id), (e) => e instanceof PsimError && e.status === 404, id);
    }
  });

  it('la fiche ne journalise rien (elle ne cherche personne)', () => {
    access.door('A-01');
    assert.equal(audits('access_search').length, 0);
  });
});

describe('recherche', () => {
  beforeEach(() => {
    setup();
    insertRaw({ at: T - 3 * DAY, door: 'A-01', credential: '0012345', holder: 'KONAN Yao', ref: '101', result: 'granted', direction: 'in' });
    insertRaw({ at: T - 2 * DAY, door: 'A-01', credential: '0012346', holder: 'Rémy Dupont', ref: '102', result: 'granted', direction: 'out' });
    insertRaw({ at: T - 2 * DAY, door: 'A-02', credential: '0099999', holder: null, result: 'denied', reason: 'unknown_credential' });
    insertRaw({ at: T - 1 * DAY, door: 'A-02', credential: 'A_B%7', holder: "O'Brien", result: 'denied', reason: 'expired', late: true });
    insertRaw({ at: T - 1 * DAY + 1, door: 'A-01', credential: 'A_B%7', holder: '50% Rémy_Bis', result: 'granted' });
    insertRaw({ at: T - 3 * 60 * MIN, door: 'A-09', credential: 'back\\slash', holder: 'Back\\Slash', result: 'granted' });
  });

  const run = (f: Json) => access.search(f, 'operateur');
  const creds = (f: Json) => run(f).items.map((i) => i.credential);

  it('sans filtre : tout, du plus recent au plus ancien (puis id decroissant)', () => {
    const r = run({});
    assert.equal(r.items.length, 6);
    assert.equal(r.nextCursor, null);
    assert.equal(r.total, null);
    assert.equal(r.totalCapped, false);
    const sorted = [...r.items].sort((a, b) => b.atDevice - a.atDevice || b.id - a.id);
    assert.deepEqual(r.items.map((i) => i.id), sorted.map((i) => i.id));
  });

  it('periode : from inclus, to exclu ; chaines de requete acceptees', () => {
    assert.deepEqual(creds({ from: String(T - 2 * DAY), to: String(T - 1 * DAY) }), ['0099999', '0012346']);
    assert.equal(run({ from: T - 2 * DAY, to: T - 2 * DAY + 1 }).items.length, 2);
    assert.equal(run({ from: T - 2 * DAY + 1, to: T - 1 * DAY }).items.length, 0);
    assert.equal(run({ from: T - 3 * DAY }).items.length, 6);
    assert.equal(run({ to: T - 3 * DAY }).items.length, 0);
    assert.equal(run({ to: T - 3 * DAY + 1 }).items.length, 1);
  });

  it('porte, resultat, differe', () => {
    assert.equal(run({ door: 'A-01' }).items.length, 3);
    assert.equal(run({ door: 'A-02' }).items.length, 2);
    assert.equal(run({ door: 'A-77' }).items.length, 0);
    assert.equal(run({ result: 'denied' }).items.length, 2);
    assert.equal(run({ result: 'granted' }).items.length, 4);
    assert.deepEqual(creds({ late: '1' }), ['A_B%7']);
    assert.equal(run({ late: '0' }).items.length, 6);
    assert.equal(run({ late: true }).items.length, 1);
    assert.equal(run({ door: 'A-02', result: 'denied', late: 1 }).items.length, 1);
  });

  it("titulaire : contient, sans tenir compte des majuscules ni des accents", () => {
    assert.deepEqual(creds({ holder: 'konan' }), ['0012345']);
    assert.deepEqual(creds({ holder: 'KONAN YAO' }), ['0012345']);
    assert.equal(run({ holder: 'remy' }).items.length, 2);
    assert.equal(run({ holder: 'Rémy' }).items.length, 2);
    assert.equal(run({ holder: 'REMY DUP' }).items.length, 1);
    assert.equal(run({ holder: "o'brien" }).items.length, 1);
    assert.equal(run({ holder: 'zzz' }).items.length, 0);
  });

  it("badge : debut du numero ; % _ \\ et ' sont des caracteres ordinaires", () => {
    assert.equal(run({ credential: '00123' }).items.length, 2);
    assert.equal(run({ credential: '0012345' }).items.length, 1);
    assert.equal(run({ credential: '0' }).items.length, 3);
    assert.equal(run({ credential: 'A_B' }).items.length, 2);
    assert.equal(run({ credential: 'A%' }).items.length, 0); // « % » n'est pas un joker : aucun numero ne commence par « A% »
    assert.equal(run({ credential: 'A_B%' }).items.length, 2);
    assert.equal(run({ credential: '%' }).items.length, 0);
    assert.equal(run({ credential: '_' }).items.length, 0);
    assert.equal(run({ credential: '0_' }).items.length, 0);
    assert.equal(run({ credential: 'back\\' }).items.length, 1);
    assert.equal(run({ credential: "' OR '1'='1" }).items.length, 0);
  });

  it("titulaire : % _ \\ et ' ne sont jamais des jokers", () => {
    assert.equal(run({ holder: '%' }).items.length, 1); // « 50% Rémy_Bis »
    assert.equal(run({ holder: '50%' }).items.length, 1);
    assert.equal(run({ holder: '_' }).items.length, 1); // « Rémy_Bis »
    assert.equal(run({ holder: 'y_b' }).items.length, 1);
    assert.equal(run({ holder: 'k_n' }).items.length, 0); // « _ » ne remplace pas une lettre
    assert.equal(run({ holder: 'k%n' }).items.length, 0);
    assert.equal(run({ holder: '\\' }).items.length, 1);
    assert.equal(run({ holder: 'back\\slash' }).items.length, 1);
    assert.equal(run({ holder: "' OR 1=1 --" }).items.length, 0);
    assert.equal(run({ holder: "'; DROP TABLE access_event; --" }).items.length, 0);
    assert.equal(events().length, 6);
  });

  it('filtres combines et vides (un formulaire envoie des champs vides)', () => {
    assert.equal(run({ holder: '', credential: '', door: '', result: '', from: '', to: '', late: '', limit: '', cursor: '', count: '' }).items.length, 6);
    assert.deepEqual(creds({ holder: 'remy', door: 'A-01', result: 'granted' }).sort(), ['0012346', 'A_B%7']);
  });

  it('PassageView : libelles, nom de la porte, differe, null quand la porte n\'existe plus', () => {
    const r = run({ door: 'A-02' }).items;
    const refus = r.find((p) => p.reason === 'expired')!;
    assert.equal(refus.resultLabel, 'Refusé — badge expiré');
    assert.equal(refus.methodLabel, 'Badge');
    assert.equal(refus.doorName, 'Porte B');
    assert.equal(refus.late, true);
    assert.equal(r.find((p) => p.reason === 'unknown_credential')!.resultLabel, 'Refusé — badge inconnu');
    assert.equal(run({ door: 'A-09' }).items[0].doorName, null); // porte jamais declaree ni creee
    db.exec("DELETE FROM device WHERE id = 'A-02'");
    assert.equal(run({ door: 'A-02' }).items[0].doorName, null);
    assert.equal(run({ door: 'A-02' }).items.length, 2); // l'historique survit a la suppression de la porte
  });

  it('resultLabel : tous les motifs du contrat', () => {
    assert.equal(resultLabel('granted', null), 'Accepté');
    assert.equal(resultLabel('denied', 'unknown_credential'), 'Refusé — badge inconnu');
    assert.equal(resultLabel('denied', 'expired'), 'Refusé — badge expiré');
    assert.equal(resultLabel('denied', 'out_of_schedule'), 'Refusé — hors des horaires');
    assert.equal(resultLabel('denied', 'disabled'), 'Refusé — badge désactivé');
    assert.equal(resultLabel('denied', 'wrong_pin'), 'Refusé — code erroné');
    assert.equal(resultLabel('denied', 'antipassback'), 'Refusé — anti-retour');
    assert.equal(resultLabel('denied', 'door_locked'), 'Refusé — porte verrouillée');
    assert.equal(resultLabel('denied', 'other'), 'Refusé');
    assert.equal(resultLabel('denied', null), 'Refusé');
    assert.equal(resultLabel('denied', '__proto__'), 'Refusé');
  });

  it('valeurs invalides : 400 (PsimError) avec une raison', () => {
    const bad: [string, Json][] = [
      ['from texte', { from: 'abc' }], ['from negatif', { from: -1 }], ['from decimal', { from: 1.5 }], ['from NaN', { from: NaN }], ['from Infinity', { from: Infinity }],
      ['from tableau', { from: ['1'] }], ['from objet', { from: { a: 1 } }], ['from 17 chiffres', { from: '12345678901234567' }], ['from hexa', { from: '0x10' }],
      ['to texte', { to: 'demain' }], ['periode inversee', { from: 10, to: 5 }], ['periode vide', { from: 5, to: 5 }],
      ['door espace', { door: 'A 01' }], ['door injection', { door: "A-01' OR '1'='1" }], ['door tableau', { door: ['A-01'] }], ['door objet', { door: {} }], ['door long', { door: 'A'.repeat(33) }],
      ['holder 65 caracteres', { holder: 'a'.repeat(65) }], ['holder controle', { holder: 'a\nb' }], ['holder bidi', { holder: `a${BIDI}b` }], ['holder tableau', { holder: ['a'] }], ['holder objet', { holder: { $ne: 1 } }], ['holder nombre', { holder: 12 }], ['holder 100 Ko', { holder: 'a'.repeat(100_000) }],
      ['credential 33 caracteres', { credential: 'a'.repeat(33) }], ['credential tabulation', { credential: 'a\tb' }], ['credential tableau', { credential: ['1'] }], ['credential nombre', { credential: 12 }],
      ['result inconnu', { result: 'ok' }], ['result tableau', { result: ['granted'] }], ['result majuscules', { result: 'DENIED' }],
      ['late = 2', { late: '2' }], ['late = oui', { late: 'oui' }], ['late tableau', { late: ['1'] }],
      ['limit 0', { limit: 0 }], ['limit 201', { limit: 201 }], ['limit texte', { limit: 'beaucoup' }], ['limit decimal', { limit: '1.5' }], ['limit negatif', { limit: '-3' }], ['limit tableau', { limit: [5] }],
      ['cursor texte', { cursor: 'abc' }], ['cursor sans id', { cursor: '123:' }], ['cursor injection', { cursor: '1:2;DROP TABLE access_event' }], ['cursor negatif', { cursor: '-1:5' }], ['cursor trois parties', { cursor: '1:2:3' }], ['cursor nombre', { cursor: 5 }], ['cursor objet', { cursor: {} }], ['cursor 17 chiffres', { cursor: '12345678901234567:1' }],
      ['count = 2', { count: '2' }], ['count tableau', { count: ['1'] }],
    ];
    for (const [label, f] of bad) {
      assert.throws(() => run(f), (e) => e instanceof PsimError && e.status === 400 && e.message.length > 0, label);
    }
    assert.throws(() => access.search(null as never, 'x'), (e) => e instanceof PsimError && e.status === 400);
    assert.throws(() => access.search([] as never, 'x'), (e) => e instanceof PsimError && e.status === 400);
    assert.throws(() => access.search('x' as never, 'x'), (e) => e instanceof PsimError && e.status === 400);
    assert.equal(events().length, 6);
  });

  it("un curseur falsifie (bien forme) ne fait rien d'autre qu'une autre page", () => {
    assert.equal(run({ cursor: '99999999999999:99999999' }).items.length, 6);
    assert.equal(run({ cursor: '1:1' }).items.length, 0);
    assert.equal(run({ cursor: `${T}:0` }).items.length, 6); // tout ce qui est strictement avant
  });

  it('un nom de propriete hostile (__proto__) dans les filtres est ignore', () => {
    const f = JSON.parse('{"__proto__":{"holder":"konan"},"constructor":{"x":1}}');
    assert.equal(run(f).items.length, 6);
  });

  it('total : seulement sur demande, plafonne a 10 000', () => {
    assert.equal(run({}).total, null);
    assert.deepEqual(run({ count: '1' }).total, 6);
    assert.equal(run({ count: 1, door: 'A-02' }).total, 2);
    assert.equal(run({ count: '1', limit: 2 }).total, 6);
    assert.equal(run({ count: '1', limit: 2, cursor: run({ limit: 2 }).nextCursor }).total, 6); // le total ne depend pas de la page
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10050)
       INSERT INTO access_event (door_id, controller_id, at_device, at_received, method, result, device_event_id, late)
       SELECT 'A-01', 'CTL-1', ? + i, ? + i, 'badge', 'granted', 'bulk' || i, 0 FROM n`,
    ).run(T, T);
    const big = run({ count: '1', door: 'A-01' });
    assert.equal(big.total, 10_000);
    assert.equal(big.totalCapped, true);
    assert.equal(run({ count: '1', door: 'A-02' }).totalCapped, false);
  });
});

describe('pagination', () => {
  beforeEach(() => {
    setup();
    // 45 passages, plusieurs a la meme seconde (le tri secondaire par id doit les departager sans trou ni doublon)
    for (let i = 0; i < 45; i++) insertRaw({ at: T - Math.floor(i / 4) * MIN, door: i % 2 ? 'A-01' : 'A-02', credential: `P${String(i).padStart(2, '0')}`, holder: i % 3 ? 'Dupont' : 'Durand' });
  });

  function walk(filters: Json, limit: number): number[] {
    const ids: number[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 100; pages++) {
      const r = access.search({ ...filters, limit, cursor: cursor ?? undefined }, 'operateur');
      assert.ok(r.items.length <= limit);
      ids.push(...r.items.map((i) => i.id));
      cursor = r.nextCursor;
      if (cursor === null) return ids;
      assert.ok(r.items.length === limit, 'une page non finale est pleine');
    }
    throw new Error('pagination sans fin');
  }

  it('toutes les pages, sans trou ni doublon, dans l\'ordre at_device decroissant puis id decroissant', () => {
    const expected = (db.prepare('SELECT id FROM access_event ORDER BY at_device DESC, id DESC').all() as { id: number }[]).map((r) => r.id);
    for (const limit of [1, 3, 4, 7, 44, 45, 46, 200]) assert.deepEqual(walk({}, limit), expected, `limit ${limit}`);
  });

  it('avec filtres', () => {
    const expected = (db.prepare("SELECT id FROM access_event WHERE door_id = 'A-01' AND holder_key = 'dupont' ORDER BY at_device DESC, id DESC").all() as { id: number }[]).map((r) => r.id);
    assert.ok(expected.length > 5);
    assert.deepEqual(walk({ door: 'A-01', holder: 'dupont' }, 4), expected);
    const byCred = (db.prepare("SELECT id FROM access_event WHERE credential >= 'P1' AND credential < 'P2' ORDER BY at_device DESC, id DESC").all() as { id: number }[]).map((r) => r.id);
    assert.deepEqual(walk({ credential: 'P1' }, 3), byCred);
  });

  it('une insertion pendant la lecture ne casse pas les pages suivantes (curseur sur la cle, pas sur un decalage)', () => {
    const first = access.search({ limit: 10 }, 'operateur');
    insertRaw({ at: T + 5 * MIN, credential: 'NOUVEAU' }); // plus recent que tout : n'apparait pas dans les pages suivantes
    const second = access.search({ limit: 10, cursor: first.nextCursor! }, 'operateur');
    const ids = new Set(first.items.map((i) => i.id));
    for (const i of second.items) assert.ok(!ids.has(i.id));
    assert.ok(!second.items.some((i) => i.credential === 'NOUVEAU'));
  });

  it('limite par defaut 50, maximum 200', () => {
    for (let i = 0; i < 160; i++) insertRaw({ at: T - 10 * DAY - i, credential: `Z${i}` });
    assert.equal(access.search({}, 'op').items.length, 50);
    assert.equal(access.search({ limit: 200 }, 'op').items.length, 200);
    assert.equal(access.search({ limit: '200' }, 'op').items.length, 200);
  });
});

describe('recherche par debut de badge : prefixe frequent', () => {
  beforeEach(() => {
    setup();
    // 6 000 passages de badges F00..F29 (prefixe « F » tres frequent : plus de 5 000), 3 000 par porte, et 60 passages d'un badge G1
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000)
       INSERT INTO access_event (door_id, controller_id, at_device, at_received, credential, method, result, device_event_id, late)
       SELECT CASE WHEN i % 2 = 0 THEN 'A-01' ELSE 'A-02' END, 'CTL-1', ? - i * 1000, ? - i * 1000 + 100, 'F' || printf('%02d', i % 30), 'badge', 'granted', 'f' || i, 0 FROM n`,
    ).run(T, T);
    for (let i = 0; i < 60; i++) insertRaw({ at: T - i * 7000, door: 'A-02', credential: 'G1' });
  });

  const expected = (where: string, params: (string | number)[] = []): number[] =>
    (db.prepare(`SELECT id FROM access_event WHERE ${where} ORDER BY at_device DESC, id DESC`).all(...params) as { id: number }[]).map((r) => r.id);

  function walk(filters: Json, limit: number): number[] {
    const ids: number[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 500; pages++) {
      const r = access.search({ ...filters, limit, cursor: cursor ?? undefined }, 'operateur');
      ids.push(...r.items.map((i) => i.id));
      cursor = r.nextCursor;
      if (cursor === null) return ids;
    }
    throw new Error('pagination sans fin');
  }

  it('un prefixe tres frequent donne les bons passages, dans le bon ordre, sans trou ni doublon', () => {
    const all = expected("credential >= 'F' AND credential < 'F\u{10FFFF}'");
    assert.equal(all.length, 6000);
    assert.deepEqual(access.search({ credential: 'F', limit: 200 }, 'op').items.map((i) => i.id), all.slice(0, 200));
    assert.deepEqual(walk({ credential: 'F' }, 200), all);
  });

  it('prefixe frequent et porte : meme resultat que la requete directe', () => {
    const all = expected("credential >= 'F' AND credential < 'F\u{10FFFF}' AND door_id = 'A-02'");
    assert.equal(all.length, 3000);
    assert.deepEqual(walk({ credential: 'F', door: 'A-02' }, 200), all);
  });

  it('prefixe frequent avec periode, resultat, differe et titulaire', () => {
    const win = [T - 3000 * 1000, T - 1000 * 1000];
    const all = expected("credential >= 'F' AND credential < 'F\u{10FFFF}' AND at_device >= ? AND at_device < ?", win);
    assert.deepEqual(walk({ credential: 'F', from: win[0], to: win[1] }, 100), all);
    assert.equal(access.search({ credential: 'F', result: 'denied' }, 'op').items.length, 0);
    assert.equal(access.search({ credential: 'F', late: '1' }, 'op').items.length, 0);
    assert.equal(access.search({ credential: 'F', holder: 'personne' }, 'op').items.length, 0);
  });

  it('numero complet, prefixe rare, prefixe absent : memes garanties', () => {
    const one = expected("credential = 'F07'");
    assert.equal(one.length, 200);
    assert.deepEqual(walk({ credential: 'F07' }, 50), one);
    assert.deepEqual(walk({ credential: 'G1' }, 25), expected("credential = 'G1'"));
    assert.equal(access.search({ credential: 'ZZZ' }, 'op').items.length, 0);
    assert.equal(access.search({ credential: 'F', count: '1' }, 'op').total, 6000);
    assert.equal(access.search({ credential: 'G', count: '1' }, 'op').total, 60);
  });

  it("l'export suit le meme plan et rend les memes lignes", () => {
    const r = access.exportCsv({ credential: 'F', door: 'A-01' }, 'admin');
    assert.equal(r.rows, 3000);
  });
});

describe('journalisation des recherches et des exports', () => {
  beforeEach(() => setup());

  it('une recherche par titulaire ou par badge est journalisee ; une recherche par porte ou periode ne l\'est pas', () => {
    access.search({ holder: 'konan' }, 'operateur');
    access.search({ credential: '0012' }, 'operateur');
    access.search({ door: 'A-01', from: T - DAY }, 'operateur');
    access.search({}, 'operateur');
    const lines = audits('access_search');
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.actor === 'operateur'));
    assert.match(lines.map((l) => l.details).join('|'), /konan/);
    assert.match(lines.map((l) => l.details).join('|'), /0012/);
  });

  it("page 1 seulement, et au plus une fois par minute pour (auteur, memes filtres)", () => {
    access.search({ holder: 'konan', limit: 1 }, 'operateur');
    insertRaw({ at: T - 1000, holder: 'KONAN A' });
    insertRaw({ at: T - 2000, holder: 'KONAN B' });
    assert.equal(audits('access_search').length, 1);
    const page1 = access.search({ holder: 'konan', limit: 1 }, 'operateur');
    access.search({ holder: 'konan', limit: 1, cursor: page1.nextCursor! }, 'operateur'); // page 2 : jamais journalisee
    assert.equal(audits('access_search').length, 1);
    clock += 59 * S;
    access.search({ holder: 'konan' }, 'operateur');
    assert.equal(audits('access_search').length, 1);
    clock += 1 * S; // 60 s
    access.search({ holder: 'konan' }, 'operateur');
    assert.equal(audits('access_search').length, 2);
  });

  it('un autre auteur ou d\'autres filtres sont journalises a part', () => {
    access.search({ holder: 'konan' }, 'operateur');
    access.search({ holder: 'konan' }, 'admin');
    access.search({ holder: 'konan', door: 'A-01' }, 'operateur');
    access.search({ holder: 'dupont' }, 'operateur');
    assert.equal(audits('access_search').length, 4);
    assert.equal(audits('access_search')[2].deviceId, 'A-01');
  });

  it("l'horloge qui recule ne bloque pas la journalisation", () => {
    access.search({ holder: 'konan' }, 'operateur');
    clock -= 10 * MIN;
    access.search({ holder: 'konan' }, 'operateur');
    assert.equal(audits('access_search').length, 2);
  });

  it('details tronques a 120 caracteres, jamais le contenu des resultats', () => {
    insertRaw({ at: T - 1000, holder: 'SECRET-TITULAIRE', credential: 'SECRET-BADGE' });
    access.search({ holder: 'h'.repeat(64), credential: 'c'.repeat(32), door: 'A-01', from: T - DAY, to: T, result: 'granted', late: 1 }, 'operateur');
    const [line] = audits('access_search');
    assert.ok([...line.details!].length <= 120, String([...line.details!].length));
    assert.ok(line.details!.endsWith('…'));
    access.search({ holder: 'titulaire' }, 'operateur2');
    const all = JSON.stringify(engine.listAudit(500));
    assert.ok(!all.includes('SECRET-TITULAIRE'));
    assert.ok(!all.includes('SECRET-BADGE'));
  });

  it('une recherche invalide n\'est pas journalisee', () => {
    assert.throws(() => access.search({ holder: 'a\nb' }, 'operateur'));
    assert.equal(audits('access_search').length, 0);
  });

  it("l'export est toujours journalise (auteur, filtres, nombre de lignes), meme sans filtre ni titulaire", () => {
    insertRaw({ at: T - 1000, holder: 'Yao' });
    insertRaw({ at: T - 2000, holder: 'Kofi' });
    access.exportCsv({}, 'admin');
    access.exportCsv({}, 'admin'); // pas de limitation a une par minute pour un export
    access.exportCsv({ holder: 'yao', door: 'A-01' }, 'operateur');
    const lines = audits('access_export');
    assert.equal(lines.length, 3);
    assert.equal(lines[0].actor, 'admin');
    assert.match(lines[0].details!, /2 ligne/);
    assert.equal(lines[2].actor, 'operateur');
    assert.match(lines[2].details!, /1 ligne/);
    assert.match(lines[2].details!, /yao/);
    assert.equal(lines[2].deviceId, 'A-01');
  });

  it("un export dont les filtres sont invalides n'est pas journalise et ne produit rien", () => {
    assert.throws(() => access.exportCsv({ from: 'x' }, 'admin'), (e) => e instanceof PsimError && e.status === 400);
    assert.equal(audits('access_export').length, 0);
  });
});

describe('export CSV', () => {
  beforeEach(() => setup());

  const lines = (csv: string) => csv.replace(/^\uFEFF/, '').split('\r\n').filter((l) => l !== '');

  it('BOM, separateur « ; », fins de ligne CRLF, en-tete et colonnes du contrat', () => {
    insertRaw({ at: T - 60 * S, door: 'A-01', credential: '0012345', holder: 'KONAN Yao', ref: '101', direction: 'in', method: 'face', result: 'denied', reason: 'out_of_schedule', late: true });
    insertRaw({ at: T - 120 * S, door: 'A-09', credential: null, result: 'granted', direction: 'out', method: 'exit_button' });
    const r = access.exportCsv({}, 'operateur');
    assert.equal(r.csv.charCodeAt(0), 0xfeff);
    assert.equal(r.rows, 2);
    assert.equal(r.truncated, false);
    const l = lines(r.csv);
    assert.equal(l[0], 'Date et heure du contrôleur;Reçu le;Porte;Contrôleur;Sens;Badge;Titulaire;Référence titulaire;Méthode;Résultat;Motif;Reçu en différé');
    const cells = l[1].split(';');
    assert.equal(cells.length, 12);
    assert.deepEqual(cells.slice(2), ['Porte de service entrepot', 'Controleur entree', 'Entrée', '0012345', 'KONAN Yao', '101', 'Visage', 'Refusé', 'hors des horaires', 'Oui']);
    const second = l[2].split(';');
    assert.deepEqual(second.slice(2), ['A-09', 'Controleur entree', 'Sortie', '', '', '', 'Bouton de sortie', 'Accepté', '', 'Non']);
  });

  it("neutralise les formules (= + - @ tabulation retour chariot) dans le nom, le badge, la reference : prefixe '", () => {
    const evil = ['=1+1', '+SUM(A1)', '-2+3', '@SUM(A1)', '\tx', '\rx', "=cmd|' /C calc'!A0"];
    for (const [i, v] of evil.entries()) insertRaw({ at: T - (i + 1) * S, holder: v, credential: v, ref: v });
    const csv = access.exportCsv({}, 'admin').csv;
    for (const v of evil) {
      const cell = v.includes('"') || v.includes(';') || v.includes('\r') || v.includes('\n') ? `"'${v.replace(/"/g, '""')}"` : `'${v}`;
      assert.ok(csv.includes(cell), `cellule neutralisee pour ${JSON.stringify(v)}`);
    }
    // jamais une cellule qui commence par le caractere de formule lui-meme
    for (const v of evil) {
      assert.ok(!csv.includes(`;${v}`), `cellule brute : ${JSON.stringify(v)}`);
      assert.ok(!csv.includes(`;"${v}`), `cellule brute entre guillemets : ${JSON.stringify(v)}`);
    }
  });

  it("une cellule qui contient « ; » ou un guillemet est protegee", () => {
    insertRaw({ at: T - S, holder: 'Dupont; "le" grand' });
    const csv = access.exportCsv({}, 'admin').csv;
    assert.ok(csv.includes('"Dupont; ""le"" grand"'));
  });

  it("reprend les filtres de la recherche (et ignore limit, cursor, count)", () => {
    for (let i = 0; i < 5; i++) insertRaw({ at: T - i * MIN, door: 'A-01', holder: 'Durand' });
    for (let i = 0; i < 3; i++) insertRaw({ at: T - i * MIN, door: 'A-02', holder: 'Dupont' });
    assert.equal(access.exportCsv({ door: 'A-02' }, 'admin').rows, 3);
    assert.equal(access.exportCsv({ holder: 'du', limit: 1, cursor: 'zzz', count: '1' }, 'admin').rows, 8);
    assert.equal(access.exportCsv({ from: T - 2 * MIN }, 'admin').rows, 6);
  });

  it('export vide : seulement l\'en-tete', () => {
    const r = access.exportCsv({ holder: 'personne' }, 'admin');
    assert.equal(r.rows, 0);
    assert.equal(lines(r.csv).length, 1);
  });

  it(`au plus ${EXPORT_MAX_ROWS} lignes, drapeau « tronque » au-dela, les plus recentes d'abord`, () => {
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO access_event (door_id, controller_id, at_device, at_received, credential, method, result, device_event_id, late)
       SELECT 'A-01', 'CTL-1', ? + i * 1000, ? + i * 1000, 'B' || (i % 500), 'badge', 'granted', 'bulk' || i, 0 FROM n`,
    ).run(EXPORT_MAX_ROWS + 1, T - 400 * DAY, T - 400 * DAY);
    const r = access.exportCsv({}, 'admin');
    assert.equal(r.rows, EXPORT_MAX_ROWS);
    assert.equal(r.truncated, true);
    assert.equal(lines(r.csv).length, EXPORT_MAX_ROWS + 1);
    assert.match(audits('access_export')[0].details!, /tronque/);
    const exact = access.exportCsv({ to: T - 400 * DAY + EXPORT_MAX_ROWS * 1000 + 1 }, 'admin');
    assert.equal(exact.rows, EXPORT_MAX_ROWS);
    assert.equal(exact.truncated, false);
  });
});

describe('purge et conservation', () => {
  it('par defaut 90 jours : les plus vieux sont supprimes, les autres gardes, une ligne de journal', () => {
    setup();
    insertRaw({ at: T - 91 * DAY });
    insertRaw({ at: T - 90 * DAY - 1 });
    insertRaw({ at: T - 90 * DAY });
    insertRaw({ at: T - 89 * DAY });
    insertRaw({ at: T });
    assert.deepEqual(access.purge(), { deleted: 2, remaining: 0 });
    assert.equal(events().length, 3);
    const [line] = audits('access_purge');
    assert.equal(line.actor, 'systeme');
    assert.match(line.details!, /2 passage/);
    assert.match(line.details!, new RegExp(new Date(T - 90 * DAY).toISOString()));
    assert.deepEqual(access.settings().lastPurge, { at: T, deleted: 2, before: T - 90 * DAY });
  });

  it("rien a supprimer : aucune ligne de journal, derniere purge inchangee", () => {
    setup();
    insertRaw({ at: T });
    assert.deepEqual(access.purge(), { deleted: 0, remaining: 0 });
    assert.equal(audits('access_purge').length, 0);
    assert.equal(access.settings().lastPurge, null);
  });

  it('la duree vient de la configuration (option), puis du reglage enregistre', () => {
    setup({}, { retentionDays: 30 });
    insertRaw({ at: T - 31 * DAY });
    insertRaw({ at: T - 29 * DAY });
    assert.equal(access.settings().retentionDays, 30);
    assert.equal(access.settings().defaultDays, 30);
    access.setRetention('admin', 200);
    assert.equal(access.purge().deleted, 0);
    access.setRetention('admin', 7);
    assert.equal(access.purge().deleted, 2);
    assert.equal(events().length, 0);
  });

  it('un reglage enregistre survit a un redemarrage (nouveau module sur la meme base)', () => {
    setup();
    access.setRetention('admin', 45);
    const again = createAccess({ db, now: () => clock, key, audit: () => {}, setDeviceState: () => true });
    assert.equal(again.settings().retentionDays, 45);
  });

  it('suppression par lots : jamais une seule requete geante ; au plus la limite par appel, le reste au suivant', () => {
    setup({}, { purgeBatch: 1000, purgeMaxRows: 2500 });
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3200)
       INSERT INTO access_event (door_id, controller_id, at_device, at_received, method, result, device_event_id, late)
       SELECT 'A-01', 'CTL-1', ? + i, ? + i, 'badge', 'granted', 'old' || i, 0 FROM n`,
    ).run(T - 200 * DAY, T - 200 * DAY);
    insertRaw({ at: T });
    const first = access.purge();
    assert.deepEqual(first, { deleted: 2500, remaining: 700 });
    assert.equal(audits('access_purge').length, 1);
    const second = access.purge();
    assert.deepEqual(second, { deleted: 700, remaining: 0 });
    assert.equal(audits('access_purge').length, 2);
    assert.equal(events().length, 1);
    assert.deepEqual(access.purge(), { deleted: 0, remaining: 0 });
    assert.equal(audits('access_purge').length, 2);
  });

  it('les requetes de suppression sont bornees par lot (verifie sur les appels reels)', () => {
    const real = openDb(':memory:');
    const calls: unknown[][] = [];
    const spy = new Proxy(real, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target) as unknown;
        if (prop !== 'prepare') return typeof v === 'function' ? v.bind(target) : v;
        return (text: string) => {
          const st = target.prepare(text);
          if (!text.startsWith('DELETE FROM access_event')) return st;
          return new Proxy(st, {
            get(s, p) {
              if (p === 'run') return (...a: unknown[]) => (calls.push(a), (s.run as (...x: unknown[]) => unknown)(...a));
              const x = Reflect.get(s, p, s) as unknown;
              return typeof x === 'function' ? x.bind(s) : x;
            },
          });
        };
      },
    });
    clock = T;
    const svc = createAccess({ db: spy, now: () => clock, key: randomBytes(32), audit: () => {}, setDeviceState: () => true });
    real
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 25000)
         INSERT INTO access_event (door_id, controller_id, at_device, at_received, method, result, device_event_id, late)
         SELECT 'X', 'C', ? + i, ? + i, 'badge', 'granted', 'e' || i, 0 FROM n`,
      )
      .run(T - 300 * DAY, T - 300 * DAY);
    assert.deepEqual(svc.purge(), { deleted: 25_000, remaining: 0 });
    assert.deepEqual(calls.map((c) => c[1]), [10_000, 10_000, 10_000]);
  });

  it('la purge automatique de tick() passe une fois par heure (et au premier tick), jamais plus', () => {
    setup();
    insertRaw({ at: T - 100 * DAY });
    access.tick(); // premier tick : purge
    assert.equal(events().length, 0);
    assert.equal(audits('access_purge').length, 1);
    insertRaw({ at: T - 100 * DAY });
    clock += 59 * MIN;
    access.tick();
    assert.equal(events().length, 1); // pas encore l'heure
    clock += 1 * MIN;
    access.tick();
    assert.equal(events().length, 0);
    assert.equal(audits('access_purge').length, 2);
  });

  it("purge automatique avec un arriere (apres une baisse de la duree) : UN lot par controle, 5 secondes d'intervalle", () => {
    setup({}, { purgeBatch: 1000, purgeMaxRows: 100_000 });
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500)
       INSERT INTO access_event (door_id, controller_id, at_device, at_received, method, result, device_event_id, late)
       SELECT 'A-01', 'CTL-1', ? + i, ? + i, 'badge', 'granted', 'old' || i, 0 FROM n`,
    ).run(T - 200 * DAY, T - 200 * DAY);
    access.tick();
    assert.equal(events().length, 1500);
    clock += 4 * S;
    access.tick();
    assert.equal(events().length, 1500); // trop tot
    clock += 1 * S;
    access.tick();
    assert.equal(events().length, 500);
    clock += 5 * S;
    access.tick();
    assert.equal(events().length, 0);
    clock += 5 * S;
    access.tick(); // plus rien d'echu : retour au rythme d'une fois par heure
    insertRaw({ at: T - 200 * DAY });
    clock += 30 * MIN;
    access.tick();
    assert.equal(events().length, 1);
    assert.equal(audits('access_purge').length, 3);
  });

  it('une horloge revenue tres en arriere ne bloque pas la purge automatique', () => {
    setup();
    access.tick(); // prochain controle a T + 1 h
    insertRaw({ at: T - 120 * DAY });
    insertRaw({ at: T - 95 * DAY });
    clock = T - 10 * DAY; // l'horloge recule de 10 jours : echeance de la conservation = T - 100 jours
    access.tick();
    assert.deepEqual(events().map((e) => e.at_device), [T - 95 * DAY]); // la ligne echue pour l'heure courante est supprimee, l'autre non
  });

  it('une purge qui echoue dans tick() ne plante pas la boucle de controle', () => {
    setup();
    const broken = createAccess({ db, now: () => clock, key, audit: () => { throw new Error('journal ferme'); }, setDeviceState: () => true });
    insertRaw({ at: T - 100 * DAY });
    const quiet = console.error;
    console.error = () => {};
    try {
      assert.doesNotThrow(() => broken.tick());
    } finally {
      console.error = quiet;
    }
  });

  it('settings() : compte, plus ancien, derniere purge', () => {
    setup();
    assert.deepEqual(access.settings(), { retentionDays: 90, defaultDays: 90, eventCount: 0, oldestAt: null, lastPurge: null });
    insertRaw({ at: T - 10 * DAY });
    insertRaw({ at: T - 5 * DAY });
    const s = access.settings();
    assert.equal(s.eventCount, 2);
    assert.equal(s.oldestAt, T - 10 * DAY);
  });

  it('setRetention : 7 a 3650 jours, entier ; journalise ; le reste est refuse', () => {
    setup();
    for (const ok of [7, 90, 3650]) assert.equal(access.setRetention('admin', ok).retentionDays, ok);
    for (const bad of [0, 6, 3651, 1.5, -90, NaN, Infinity, '90', null, undefined, [90], { days: 90 }, true]) {
      assert.throws(() => access.setRetention('admin', bad), (e) => e instanceof PsimError && e.status === 400, String(bad));
    }
    assert.equal(access.settings().retentionDays, 3650);
    const lines = audits('access_retention_changed');
    assert.equal(lines.length, 3);
    assert.equal(lines[0].actor, 'admin');
    assert.match(lines[0].details!, /90 -> 7/);
  });

  it('createAccess refuse une duree de configuration invalide', () => {
    setup();
    for (const bad of [0, 6, 3651, 1.5, NaN]) assert.throws(() => createAccess({ db, key, audit: () => {}, setDeviceState: () => true, retentionDays: bad }));
  });
});

describe('controleurs', () => {
  beforeEach(() => setup());
  const SECRET = 'S3cr3t-Mot-De-Passe-Unique!';
  const USER = 'utilisateur-unique-xyz';

  function everything(): string {
    const dump: unknown[] = [access.controllers(), access.doors(), engine.listAudit(500), engine.getSnapshot()];
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'access_controller'").all() as { name: string }[]) {
      dump.push(db.prepare(`SELECT * FROM ${name}`).all());
    }
    return JSON.stringify(dump);
  }

  it("identifiants en ECRITURE SEULE : scelles, jamais dans une vue, un journal ou la base en clair", () => {
    const view = access.createController('admin', { id: 'CTL-9', name: 'Neuf', brand: 'dahua', host: '192.168.1.50', credentials: { username: USER, password: SECRET } });
    assert.equal(view.hasCredentials, true);
    assert.ok(!JSON.stringify(view).includes(SECRET));
    assert.ok(!JSON.stringify(view).includes(USER));
    assert.ok(!Object.keys(view).some((k) => /pass|secret|cred|sealed/i.test(k) && k !== 'hasCredentials'));
    access.updateController('admin', 'CTL-9', { name: 'Neuf bis', credentials: { username: USER, password: SECRET + '2' } });
    assert.ok(!everything().includes(SECRET));
    assert.ok(!everything().includes(USER));
    // la ligne de la base ne contient ni mot de passe, ni identifiant en clair
    const row = db.prepare('SELECT * FROM access_controller WHERE id = ?').get('CTL-9') as Json;
    assert.ok(!JSON.stringify(row).includes(SECRET));
    assert.ok(!JSON.stringify(row).includes(USER));
    assert.equal(typeof row.credentials_sealed, 'string');
    // ... mais ils sont bien la, scelles avec la cle du PSIM
    assert.deepEqual(JSON.parse(unseal(key, row.credentials_sealed as string)), { username: USER, password: SECRET + '2' });
    // fichier de base : meme verdict (octets bruts)
    assert.ok(!Buffer.from(JSON.stringify(row)).includes(SECRET));
  });

  it("hasCredentials : faux sans identifiants ; PUT sans credentials = inchange ; null = effacement", () => {
    assert.equal(access.controller('CTL-1').hasCredentials, false);
    access.updateController('admin', 'CTL-1', { credentials: { username: 'u', password: 'p' } });
    assert.equal(access.controller('CTL-1').hasCredentials, true);
    access.updateController('admin', 'CTL-1', { name: 'Autre nom' });
    assert.equal(access.controller('CTL-1').hasCredentials, true);
    access.updateController('admin', 'CTL-1', { credentials: null });
    assert.equal(access.controller('CTL-1').hasCredentials, false);
    assert.equal((db.prepare('SELECT credentials_sealed AS c FROM access_controller WHERE id = ?').get('CTL-1') as Json).c, null);
  });

  it("le journal dit qu'il y a eu des identifiants, jamais lesquels ; les messages d'erreur non plus", () => {
    access.createController('admin', { id: 'CTL-9', name: 'Neuf', brand: 'relay', credentials: { username: USER, password: SECRET } });
    const lines = audits('access_controller_created');
    assert.match(lines.at(-1)!.details!, /identifiants enregistres/);
    for (const bad of [{ username: USER, password: '' }, { username: '', password: SECRET }, { username: USER, password: SECRET.repeat(20) }, { username: [USER], password: SECRET }, { username: USER }, SECRET, [SECRET], 42, { username: USER, password: { p: SECRET } }]) {
      try {
        access.updateController('admin', 'CTL-9', { credentials: bad });
        assert.fail('aurait du etre refuse');
      } catch (e) {
        assert.ok(e instanceof PsimError && e.status === 400);
        assert.ok(!e.message.includes(SECRET) && !e.message.includes(USER), e.message);
      }
    }
    assert.ok(!everything().includes(SECRET));
  });

  it('creation : validations de docs/ACCES.md § 3.1', () => {
    const bad = (input: Json, status = 400) => assert.throws(() => access.createController('admin', input), (e) => e instanceof PsimError && e.status === status, JSON.stringify(input).slice(0, 80));
    const ok = { id: 'CTL-2', name: 'Deux', brand: 'zkteco' };
    bad({ ...ok, id: undefined });
    bad({ ...ok, id: 'a b' });
    bad({ ...ok, id: 'x'.repeat(33) });
    bad({ ...ok, id: 'CTL-1' }, 409);
    bad({ ...ok, name: undefined });
    bad({ ...ok, name: '' });
    bad({ ...ok, name: 'x'.repeat(81) });
    bad({ ...ok, name: 'a\nb' });
    bad({ ...ok, name: `a${BIDI}b` });
    bad({ ...ok, name: ['a'] });
    bad({ ...ok, name: { a: 1 } });
    bad({ ...ok, brand: undefined });
    bad({ ...ok, brand: 'hikvision' });
    bad({ ...ok, brand: 5 });
    bad({ ...ok, model: 'm'.repeat(41) });
    bad({ ...ok, model: 'm\u0000' });
    bad({ ...ok, host: 'http://192.168.1.5' });
    bad({ ...ok, host: '192.168.1.5/admin' });
    bad({ ...ok, host: 'a b' });
    bad({ ...ok, host: 'x'.repeat(300) });
    bad({ ...ok, gatewayId: 'gw 1' });
    bad({ ...ok, gatewayId: 'g'.repeat(33) });
    bad({ ...ok, credentials: 'x' });
    assert.throws(() => access.createController('admin', null as never));
    assert.throws(() => access.createController('admin', 'x' as never));
    assert.equal(access.controllers().length, 1);
    const view = access.createController('admin', { ...ok, model: 'ASC1204B', host: 'controleur.local', gatewayId: 'gw-site' });
    assert.deepEqual({ ...view, createdAt: 0, updatedAt: 0, lastSeen: 0 }, {
      id: 'CTL-2', name: 'Deux', brand: 'zkteco', model: 'ASC1204B', host: 'controleur.local', gatewayId: 'gw-site', hasCredentials: false,
      clockOffsetMs: null, lastSeen: 0, doorCount: 0, createdAt: 0, createdBy: 'admin', updatedAt: 0, updatedBy: 'admin',
    });
    assert.equal(audits('access_controller_created').at(-1)!.actor, 'admin');
  });

  it('modification : champs absents inchanges, null efface un champ facultatif, id immuable', () => {
    access.updateController('admin', 'CTL-1', { model: 'M1', host: '10.0.0.5', gatewayId: 'gw1' });
    clock += S;
    const v = access.updateController('operateur2', 'CTL-1', { name: 'Renomme' });
    assert.equal(v.name, 'Renomme');
    assert.equal(v.model, 'M1');
    assert.equal(v.host, '10.0.0.5');
    assert.equal(v.updatedBy, 'operateur2');
    assert.equal(v.updatedAt, clock);
    assert.equal(v.createdBy, 'admin');
    const cleared = access.updateController('admin', 'CTL-1', { host: null, model: '' });
    assert.equal(cleared.host, null);
    assert.equal(cleared.model, null);
    assert.equal(cleared.gatewayId, 'gw1');
    access.updateController('admin', 'CTL-1', { id: 'CTL-77' }); // ignore
    assert.equal(access.controllers()[0].id, 'CTL-1');
    assert.throws(() => access.updateController('admin', 'CTL-1', { name: '' }), (e) => e instanceof PsimError && e.status === 400);
    assert.throws(() => access.updateController('admin', 'CTL-1', { brand: 'x' }), (e) => e instanceof PsimError && e.status === 400);
    assert.throws(() => access.updateController('admin', 'NOPE', { name: 'x' }), (e) => e instanceof PsimError && e.status === 404);
    assert.equal(audits('access_controller_updated').length, 4);
  });

  it('suppression : 409 tant qu\'il a des portes, puis possible ; l\'historique des passages survit', () => {
    assert.throws(() => access.deleteController('admin', 'CTL-1'), (e) => e instanceof PsimError && e.status === 409);
    send('A-01', passage());
    access.removeDoor('admin', 'A-01');
    access.removeDoor('admin', 'A-02');
    access.deleteController('admin', 'CTL-1');
    assert.equal(access.controllers().length, 0);
    assert.equal(events().length, 1);
    assert.equal(audits('access_controller_deleted').length, 1);
    assert.throws(() => access.deleteController('admin', 'CTL-1'), (e) => e instanceof PsimError && e.status === 404);
  });

  it('doorCount et liste triee par nom', () => {
    access.createController('admin', { id: 'CTL-0', name: 'Alpha', brand: 'relay' });
    assert.deepEqual(access.controllers().map((c) => [c.id, c.doorCount]), [['CTL-0', 0], ['CTL-1', 2]]);
  });
});

describe('declaration des portes', () => {
  beforeEach(() => setup());
  const bad = (input: Json, status = 400) => assert.throws(() => access.declareDoor('admin', input), (e) => e instanceof PsimError && e.status === status, JSON.stringify(input));

  it('le detecteur doit exister et etre de categorie access (400) ; pas deja declare (409)', () => {
    engine.createDevice('admin', { id: 'A-05', kind: 'detector', name: 'Nouvelle', zone: 'Entrepot', category: 'access' });
    bad({ detectorId: 'D-01', controllerId: 'CTL-1', doorNo: 3 });
    bad({ detectorId: 'C-01', controllerId: 'CTL-1', doorNo: 3 });
    bad({ detectorId: 'NOPE', controllerId: 'CTL-1', doorNo: 3 });
    bad({ detectorId: undefined, controllerId: 'CTL-1', doorNo: 3 });
    bad({ detectorId: 'A 05', controllerId: 'CTL-1', doorNo: 3 });
    bad({ detectorId: ['A-05'], controllerId: 'CTL-1', doorNo: 3 });
    bad({ detectorId: 'A-01', controllerId: 'CTL-1', doorNo: 3 }, 409);
  });

  it('controleur existant, doorNo de 1 a 4 entier, unique par controleur (409)', () => {
    engine.createDevice('admin', { id: 'A-05', kind: 'detector', name: 'Nouvelle', zone: 'Entrepot', category: 'access' });
    bad({ detectorId: 'A-05', controllerId: 'CTL-X', doorNo: 3 });
    bad({ detectorId: 'A-05', controllerId: undefined, doorNo: 3 });
    bad({ detectorId: 'A-05', controllerId: 'CTL-1' });
    for (const n of [0, 5, -1, 1.5, '1', null, NaN, [1]]) bad({ detectorId: 'A-05', controllerId: 'CTL-1', doorNo: n });
    bad({ detectorId: 'A-05', controllerId: 'CTL-1', doorNo: 1 }, 409);
    bad({ detectorId: 'A-05', controllerId: 'CTL-1', doorNo: 2 }, 409);
    access.createController('admin', { id: 'CTL-2', name: 'Deux', brand: 'zkteco' });
    const v = access.declareDoor('admin', { detectorId: 'A-05', controllerId: 'CTL-2', doorNo: 1 }); // meme numero, autre controleur
    assert.equal(v.doorNo, 1);
    assert.equal(v.controllerId, 'CTL-2');
  });

  it('kind, issue de secours, delai (10 a 86400), actionneur : valeurs et defauts', () => {
    engine.createDevice('admin', { id: 'A-05', kind: 'detector', name: 'Nouvelle', zone: 'Entrepot', category: 'access' });
    const base = { detectorId: 'A-05', controllerId: 'CTL-1', doorNo: 3 };
    for (const k of ['porte', 'DOOR', 5, null, ['door']]) bad({ ...base, kind: k });
    for (const e of ['true', 1, 0, null, 'oui']) bad({ ...base, emergencyExit: e });
    for (const h of [9, 86_401, 10.5, '300', null, NaN, -10]) bad({ ...base, heldAlarmAfterS: h });
    for (const a of ['a b', 5, ['x'], 'x'.repeat(33)]) bad({ ...base, actuatorId: a });
    const v = access.declareDoor('admin', { ...base, kind: 'barrier', emergencyExit: true, heldAlarmAfterS: 10, actuatorId: 'ACT-1' });
    assert.equal(v.kind, 'barrier');
    assert.equal(v.emergencyExit, true);
    assert.equal(v.heldAlarmAfterS, 10);
    assert.equal(v.actuatorId, 'ACT-1');
    assert.equal(access.doors().find((d) => d.detectorId === 'A-01')!.heldAlarmAfterS, 300);
  });

  it("le nom, la zone et la position restent ceux du detecteur ; la declaration est journalisee", () => {
    const v = access.doors().find((d) => d.detectorId === 'A-01')!;
    assert.equal(v.name, 'Porte de service entrepot');
    assert.equal(v.zone, 'Entrepot');
    const line = audits('access_door_declared')[0];
    assert.equal(line.actor, 'admin');
    assert.equal(line.deviceId, 'A-01');
  });

  it('modification : champs absents inchanges, numero unique, controleur existant', () => {
    access.updateDoor('admin', 'A-01', { kind: 'gate', emergencyExit: true, actuatorId: 'ACT-9' });
    let v = door('A-01');
    assert.deepEqual([v.kind, v.emergencyExit, v.actuatorId, v.doorNo, v.heldAlarmAfterS], ['gate', true, 'ACT-9', 1, 300]);
    access.updateDoor('admin', 'A-01', { actuatorId: null });
    assert.equal(door('A-01').actuatorId, null);
    assert.throws(() => access.updateDoor('admin', 'A-01', { doorNo: 2 }), (e) => e instanceof PsimError && e.status === 409);
    assert.throws(() => access.updateDoor('admin', 'A-01', { controllerId: 'CTL-X' }), (e) => e instanceof PsimError && e.status === 400);
    assert.throws(() => access.updateDoor('admin', 'A-01', { heldAlarmAfterS: 5 }), (e) => e instanceof PsimError && e.status === 400);
    assert.throws(() => access.updateDoor('admin', 'D-01', { kind: 'gate' }), (e) => e instanceof PsimError && e.status === 404);
    access.updateDoor('admin', 'A-01', { doorNo: 3 });
    v = door('A-01');
    assert.equal(v.doorNo, 3);
    assert.equal(access.updateDoor('admin', 'A-01', { doorNo: 3 }).doorNo, 3); // son propre numero n'est pas un conflit
    assert.ok(audits('access_door_updated').length >= 3);
  });

  it("retirer une porte garde l'historique ; 404 si elle n'est pas declaree ; le detecteur supprime emporte sa declaration", () => {
    send('A-01', passage());
    access.removeDoor('admin', 'A-01');
    assert.equal(events().length, 1);
    assert.equal(access.doors().length, 1);
    assert.throws(() => access.removeDoor('admin', 'A-01'), (e) => e instanceof PsimError && e.status === 404);
    assert.throws(() => access.removeDoor('admin', "x'; --"), (e) => e instanceof PsimError && e.status === 404);
    assert.equal(audits('access_door_removed').length, 1);
    engine.deleteDevice('admin', 'A-02');
    assert.equal(access.doors().length, 0);
  });
});

describe('migration', () => {
  it('idempotente : appelee plusieurs fois, sur une base rouverte, les donnees restent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-access-db-'));
    const file = join(dir, 'psim.db');
    const first = openDb(file);
    first.prepare("INSERT INTO access_setting (key, value) VALUES ('x', '1')").run();
    migrateAccess(first);
    migrateAccess(first);
    first.close();
    const second = openDb(file);
    assert.equal((second.prepare("SELECT value FROM access_setting WHERE key = 'x'").get() as Json).value, '1');
    const tables = (second.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'access_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    assert.deepEqual(tables, ['access_controller', 'access_door', 'access_event', 'access_setting']);
    const indexes = (second.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'access_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    assert.deepEqual(indexes, ['access_door_by_controller', 'access_event_by_credential', 'access_event_by_device_event', 'access_event_by_door', 'access_event_by_time']);
    second.close();
  });

  it('index unique (controleur, evenement) tenu par la base elle-meme', () => {
    setup();
    insertRaw({ at: T });
    assert.throws(() => db.prepare("INSERT INTO access_event (door_id, controller_id, at_device, at_received, method, result, device_event_id) VALUES ('A-01', 'CTL-1', 1, 1, 'badge', 'granted', ?)").run(`raw-${rawSeq}`));
  });

  it('pas de cle etrangere sur access_event : l\'historique survit a tout', () => {
    setup();
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'access_event'").get() as { sql: string }).sql;
    assert.ok(!/REFERENCES/i.test(sql));
  });
});

describe('plans de requete', () => {
  beforeEach(() => setup());

  it('la recherche par periode, par porte et par badge utilise un index (pas de parcours complet)', () => {
    const plan = (text: string, ...params: (string | number)[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...params) as { detail: string }[]).map((r) => r.detail).join(' | ');
    assert.match(plan('SELECT * FROM access_event e WHERE e.at_device >= ? AND e.at_device < ? ORDER BY e.at_device DESC, e.id DESC LIMIT 51', 1, 2), /USING INDEX access_event_by_time/);
    assert.match(plan('SELECT * FROM access_event e WHERE e.door_id = ? ORDER BY e.at_device DESC, e.id DESC LIMIT 51', 'A'), /USING INDEX access_event_by_door/);
    assert.match(plan('SELECT * FROM access_event e WHERE e.credential >= ? AND e.credential < ? ORDER BY e.at_device DESC, e.id DESC LIMIT 51', 'a', 'b'), /USING INDEX access_event_by_credential/);
  });
});
