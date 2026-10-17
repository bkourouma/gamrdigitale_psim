/**
 * GARDE-FOUS DURABLES du canal de commande des equipements (server/actuators.ts, actuatorhttp.ts).
 *
 * Issus de la revue de securite independante (preuves « DEFAUT » S1 a S6, A1 a A5, H1, H2) : chaque defaut est ici un essai
 * de NON-REGRESSION qui ECHOUE si le defaut revient (le comportement corrige est affirme). Les essais « CONTROLE » sont ceux
 * de la revue, tels quels (attaque essayee, sans succes). Ajoutes : les comportements nouveaux (stop immediat du portail sous
 * verrou, reessais du retour a l'etat sur et `returnUnconfirmed`, {durationS} obligatoire, dedoublonnage entre comptes...).
 *
 * Fichier autonome : aucune dependance sur le dossier revue/. Horloge injectee (jamais d'attente reelle sauf les echanges
 * HTTP locaux). Les essais qui provoquent des mots de passe faux utilisent un compte DEDIE : le compteur d'echecs de
 * server/auth.ts est en memoire et partage par compte pour tout le processus.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { signAck } from '../server/actuatorproto.ts';
import type { CommandMessage } from '../server/actuatorproto.ts';
import { addressAllowed, normalizeIp, parseAllowList, sendHttp, urlProblem } from '../server/actuatorhttp.ts';
import { ACTUATOR_SCHEMA, RETURN_MAX_TRIES, createActuators, migrateActuators } from '../server/actuators.ts';
import { createUser, isRateLimited, recordFailure } from '../server/auth.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { PsimError } from '../server/errors.ts';
import { seedEmptySite } from '../server/seed.ts';
import type { Role } from '../server/types.ts';
import { startHttpRelay } from './actuator-sim.ts';

const ADMIN_PW = 'Mot-de-passe-admin-solide-1';
const OP_PW = 'Mot-de-passe-operateur-2';
const ADMIN = { username: 'admin', role: 'admin' as const };
const OP = { username: 'op', role: 'operator' as const };

const dirs: string[] = [];
const opened: DatabaseSync[] = [];
after(() => {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      // deja fermee
    }
  }
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Windows : fichier encore tenu, sans consequence pour l'essai
    }
  }
});

/** Code HTTP d'une PsimError ; toute autre exception (un « 500 ») est rendue telle quelle pour faire echouer l'essai. */
function status(fn: () => unknown): number | string {
  try {
    fn();
  } catch (err) {
    if (err instanceof PsimError) return err.status;
    return `exception ${(err as Error).constructor.name}`;
  }
  return 0;
}

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return '';
}

function setup(allow: string[] = ['127.0.0.1']) {
  const dir = mkdtempSync(join(tmpdir(), 'psim-garde-'));
  dirs.push(dir);
  const db = openDb(join(dir, 'psim.db'));
  opened.push(db);
  seedEmptySite(db);
  const clock = { t: 1_760_000_000_000, boom: false };
  const engine = createEngine(db, () => {}, () => clock.t);
  createUser(db, 'admin', 'admin', ADMIN_PW);
  createUser(db, 'op', 'operator', OP_PW);
  const sent: { id: string; msg: CommandMessage }[] = [];
  const link = {
    up: 1,
    publish: true,
    listeners: () => link.up,
    publishCommand: async (id: string, payload: Buffer) => {
      if (!link.publish) throw new Error('broker refuse');
      sent.push({ id, msg: JSON.parse(payload.toString()) as CommandMessage });
    },
  };
  const key = randomBytes(32);
  const events: unknown[] = [];
  const svc = createActuators({
    db,
    key,
    audit: engine.audit,
    publish: (e) => events.push(e),
    httpAllow: parseAllowList(allow),
    now: () => {
      if (clock.boom) {
        clock.boom = false;
        throw new Error('panne simulee de la base');
      }
      return clock.t;
    },
  });
  svc.attachMqtt(link);
  const user = (name: string, role: Role = 'operator') => {
    createUser(db, name, role, `${name}-Mot-de-passe-9`);
    return { username: name, role, password: `${name}-Mot-de-passe-9` };
  };
  const step = (ms: number) => {
    clock.t += ms;
    svc.tick();
  };
  return { dir, db, clock, engine, sent, link, svc, key, events, user, step };
}
type S = ReturnType<typeof setup>;

const audits = (db: DatabaseSync, action: string) => (db.prepare('SELECT details FROM audit_log WHERE action = ? ORDER BY id').all(action) as { details: string }[]).map((r) => r.details);
const flush = () => new Promise((r) => setImmediate(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inFlight = (db: DatabaseSync) => (db.prepare("SELECT COUNT(*) AS n FROM actuator_command WHERE state = 'sent'").get() as { n: number }).n;
/** Attend (vraies millisecondes, echange local) que plus aucune commande ne soit « envoyee ». */
async function settle(s: S): Promise<void> {
  for (let i = 0; i < 300 && inFlight(s.db) > 0; i++) await sleep(10);
  assert.equal(inFlight(s.db), 0, 'une commande est restee « envoyee »');
}
/** Accuse signe d'un actionneur MQTT (comme le ferait l'equipement). */
const ack = (s: S, key: string, id: string, cmdId: string, result: 'done' | 'refused' | 'error' = 'done') => s.svc.handleAck(id, Buffer.from(JSON.stringify(signAck(key, id, { cmdId, result, ts: s.clock.t }))));
const offs = (relay: { requests: { url: string }[] }) => relay.requests.filter((r) => r.url.includes('turn=off')).length;

// ------------------------------------------------------------------------------------------------ S1 / S5

describe('GARDE-FOU S1 / S5 : l action sure est immediate et permise a tous', () => {
  it('GARDE-FOU S1 : portail — « stop » sans raison ni mot de passe, hors de la limite de open/close : apres 4 manoeuvres, ARRETER reste possible', () => {
    const s = setup();
    s.svc.create('admin', { id: 'PORTAIL', name: 'Portail livraisons', type: 'gate', transport: 'mqtt' });
    assert.equal(s.svc.get('PORTAIL')?.safeAction, 'stop', "stop est l'action sure du portail");
    const body = (action: string, d: number) => ({ action, params: { durationS: d }, confirm: true, reason: 'livraison', password: OP_PW });
    assert.equal(status(() => s.svc.request(OP, 'PORTAIL', body('open', 5))), 0);
    // Pas de raison, pas de mot de passe pour arreter :
    assert.equal(s.svc.request(OP, 'PORTAIL', { action: 'stop', confirm: true }).status, 201, 'stop immediat');
    for (const [a, d] of [['close', 5], ['open', 6], ['close', 6]] as const) assert.equal(s.svc.request(OP, 'PORTAIL', body(a, d)).status, 201);
    assert.equal(status(() => s.svc.request(OP, 'PORTAIL', body('open', 7))), 429, 'les manoeuvres sont limitees a 4 par minute');
    const again = s.svc.request(OP, 'PORTAIL', { action: 'stop', confirm: true, reason: 'personne sous la barriere' });
    assert.ok(again.status === 200 || again.status === 201, "l'arret n'est jamais refuse par la limite des manoeuvres (ici dedoublonne : le premier est encore en vol)");
    assert.equal(s.sent.filter((m) => m.msg.action === 'stop').length, 1);
  });

  it('GARDE-FOU S1 : le « stop » du portail a sa propre limite (12 par minute), les autres manoeuvres gardent la leur', () => {
    const s = setup();
    const { key } = s.svc.create('admin', { id: 'PORTAIL', name: 'Portail', type: 'gate', transport: 'mqtt' });
    for (let i = 0; i < 12; i++) {
      const r = s.svc.request(OP, 'PORTAIL', { action: 'stop', confirm: true });
      assert.equal(r.status, 201, `arret ${i + 1}`);
      ack(s, key, 'PORTAIL', r.command.cmdId); // accuse : la commande n'est plus en vol (sinon dedoublonnee)
    }
    assert.equal(status(() => s.svc.request(OP, 'PORTAIL', { action: 'stop', confirm: true })), 429);
    assert.equal(RETURN_MAX_TRIES, 5);
  });

  it('GARDE-FOU S1 : un portail n a AUCUN retour automatique (fermer d office est plus dangereux)', () => {
    const s = setup();
    s.svc.create('admin', { id: 'PORTAIL', name: 'Portail', type: 'gate', transport: 'mqtt' });
    const open = s.svc.request(OP, 'PORTAIL', { action: 'open', params: { durationS: 5 }, confirm: true, reason: 'livraison', password: OP_PW }).command;
    assert.equal(s.svc.command(open.cmdId)?.offDueAt, null);
    s.step(60_000);
    s.step(60_000);
    assert.equal(s.sent.length, 1, 'rien d autre que l ordre de la manoeuvre');
  });

  it('GARDE-FOU S1 : « stop » du portail reste exigible sans raison, mais open et close gardent raison + mot de passe', () => {
    const s = setup();
    s.svc.create('admin', { id: 'PORTAIL', name: 'Portail', type: 'gate', transport: 'mqtt' });
    assert.equal(status(() => s.svc.request(OP, 'PORTAIL', { action: 'open', params: { durationS: 5 }, confirm: true })), 428, 'sans raison');
    assert.equal(status(() => s.svc.request(OP, 'PORTAIL', { action: 'open', params: { durationS: 5 }, confirm: true, reason: 'x' })), 428, 'sans mot de passe');
    assert.equal(status(() => s.svc.request(OP, 'PORTAIL', { action: 'stop', confirm: false })), 428, 'confirm:true reste exige, meme pour l arret');
  });

  it("GARDE-FOU S5 : l'action sure ne peut plus etre reservee a l'administrateur (configuration ET base modifiee a la main)", () => {
    const s = setup();
    const v = s.svc.create('admin', { id: 'SIR-02', name: 'Sirene', type: 'siren', transport: 'mqtt', actions: { on: { roles: ['operator', 'admin'] }, off: { roles: ['admin'] } } }).actuator;
    assert.deepEqual(v.actions.off.roles, ['operator', 'admin'], 'roles imposes a la configuration');
    assert.deepEqual(s.svc.update('admin', 'SIR-02', { actions: { on: {}, off: { roles: ['admin'] } } }).actions.off.roles, ['operator', 'admin']);
    // Base modifiee a la main : meme resultat a la lecture et a la commande.
    s.db.prepare("UPDATE actuator SET actions = ? WHERE id = 'SIR-02'").run(JSON.stringify({ on: { minS: 1, maxS: 60, roles: ['operator', 'admin'] }, off: { roles: ['admin'] } }));
    assert.equal(s.svc.request(OP, 'SIR-02', { action: 'on', params: { durationS: 60 }, confirm: true }).status, 201);
    assert.equal(s.svc.request(OP, 'SIR-02', { action: 'off', confirm: true }).status, 201, 'un operateur declenche ET arrete');
    assert.ok(s.svc.list('operator').actuators[0].allowed.includes('off'));
    // Memes regles pour les autres types.
    for (const [id, type, safe] of [['G1', 'lock', 'lock'], ['H1', 'speaker', 'stop'], ['L1', 'light', 'off'], ['R1', 'relay', 'off']] as const) {
      const w = s.svc.create('admin', { id, name: id, type, transport: 'mqtt', actions: { [safe]: { roles: ['admin'] } } }).actuator;
      assert.deepEqual(w.actions[safe].roles, ['operator', 'admin'], `${type}.${safe}`);
    }
  });
});

// ------------------------------------------------------------------------------------------------ S2

describe('GARDE-FOU S2 : mode maintenance', () => {
  it('GARDE-FOU S2 : une serrure ouverte « sans limite » peut etre REVERROUILLEE sous verrou ; tout le reste est refuse', async () => {
    const s = setup();
    s.svc.create('admin', { id: 'PORTE', name: 'Porte local technique', type: 'lock', transport: 'mqtt', actions: { unlock: { unbounded: true }, lock: {} } });
    const open = s.svc.request(OP, 'PORTE', { action: 'unlock', confirm: true, reason: 'maintenance clim', password: OP_PW }).command;
    assert.equal(open.durationS, null);
    s.svc.setLock('admin', true, 'travaux');
    assert.equal(status(() => s.svc.request(ADMIN, 'PORTE', { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'x', password: ADMIN_PW })), 409, 'ouvrir : refuse sous verrou');
    const relock = s.svc.request(ADMIN, 'PORTE', { action: 'lock', confirm: true });
    assert.equal(relock.status, 201, 'reverrouiller : permis sous verrou');
    await flush();
    assert.equal(s.sent.at(-1)?.msg.action, 'lock');
    // Rien d'autre ne part, jamais (pas de retour automatique sous verrou).
    const before = s.sent.length;
    s.step(24 * 3600_000);
    await flush();
    assert.equal(s.sent.length, before);
  });

  it("GARDE-FOU S2 : l'arret anticipe (cancel) d'une commande en cours reste permis sous verrou (serrure sans limite, sirene temporisee)", async () => {
    const s = setup();
    s.svc.create('admin', { id: 'PORTE', name: 'Porte', type: 'lock', transport: 'mqtt', actions: { unlock: { unbounded: true }, lock: {} } });
    s.svc.create('admin', { id: 'SIR-01', name: 'Sirene', type: 'siren', transport: 'mqtt' });
    const open = s.svc.request(OP, 'PORTE', { action: 'unlock', confirm: true, reason: 'maintenance', password: OP_PW }).command;
    const siren = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 100 }, confirm: true }).command;
    s.svc.setLock('admin', true, 'travaux');
    assert.equal(s.svc.command(siren.cmdId)?.offCmdId, 'verrou', 'le retour automatique prevu est annule a l activation');
    const a = s.svc.cancel(ADMIN, open.cmdId);
    assert.equal(a.stop?.action, 'lock');
    const b = s.svc.cancel(OP, siren.cmdId);
    assert.equal(b.stop?.action, 'off', 'meme si son retour automatique a ete annule par le verrou');
    await flush();
    assert.deepEqual(s.sent.slice(-2).map((m) => m.msg.action), ['lock', 'off']);
  });

  it('GARDE-FOU S2 : sous verrou, « stop » du portail part ; open / close non ; les retours automatiques restent annules', async () => {
    const s = setup();
    s.svc.create('admin', { id: 'PORTAIL', name: 'Portail', type: 'gate', transport: 'mqtt' });
    s.svc.create('admin', { id: 'SIR-01', name: 'Sirene', type: 'siren', transport: 'mqtt' });
    s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 10 }, confirm: true });
    s.svc.setLock('admin', true, 'travaux');
    assert.equal(status(() => s.svc.request(OP, 'PORTAIL', { action: 'open', params: { durationS: 5 }, confirm: true, reason: 'x', password: OP_PW })), 409);
    assert.equal(status(() => s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 5 }, confirm: true })), 409);
    assert.equal(s.svc.request(OP, 'PORTAIL', { action: 'stop', confirm: true }).status, 201);
    s.step(60_000);
    await flush();
    assert.deepEqual(s.sent.map((m) => m.msg.action), ['on', 'stop'], 'aucun « off » automatique');
    assert.match(audits(s.db, 'commandes_verrouillees')[0], /retour\(s\) automatique\(s\)/);
    s.svc.setLock('admin', false, 'fin');
    assert.equal(s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 5 }, confirm: true }).status, 201);
  });

  it("GARDE-FOU S2 : sous verrou, un incident clos n'envoie rien tout seul ; l'actionneur inactif ou sans liaison refuse meme l'action sure", () => {
    const s = setup();
    s.svc.create('admin', { id: 'SIR-01', name: 'Sirene', type: 'siren', transport: 'mqtt' });
    s.svc.setLock('admin', true, 'travaux');
    s.svc.incidentChanged(1, 'closed');
    assert.equal(s.sent.length, 0);
    s.link.up = 0;
    assert.equal(status(() => s.svc.request(OP, 'SIR-01', { action: 'off', confirm: true })), 409, 'liaison coupee');
    s.link.up = 1;
    s.svc.update('admin', 'SIR-01', { active: false });
    assert.equal(status(() => s.svc.request(OP, 'SIR-01', { action: 'off', confirm: true })), 409, 'inactif');
  });
});

// ------------------------------------------------------------------------------------------------ S3

describe('GARDE-FOU S3 : relais HTTP', () => {
  const http = (base: string, extra: { on?: object; off?: object; pulse?: object } = {}) => ({
    requests: {
      on: { method: 'GET', url: `${base}/relay/0?turn=on&timer={durationS}`, ...extra.on },
      off: { method: 'GET', url: `${base}/relay/0?turn=off`, ...extra.off },
    },
  });

  it('GARDE-FOU S3 : un gabarit d une action temporisee sans {durationS} est refuse (400 clair) ; dans le corps ou en action sans limite : accepte', () => {
    const s = setup();
    const base = 'http://127.0.0.1:9';
    const sans = { requests: { on: { method: 'GET', url: `${base}/relay/0?turn=on` }, off: { method: 'GET', url: `${base}/relay/0?turn=off` } } };
    assert.equal(status(() => s.svc.create('admin', { id: 'PROJ-1', name: 'p', type: 'light', transport: 'http', http: sans })), 400);
    assert.match(message(() => s.svc.create('admin', { id: 'PROJ-1', name: 'p', type: 'light', transport: 'http', http: sans })), /durationS/);
    assert.equal(s.svc.list('admin').actuators.length, 0);
    // {durationS} dans le corps suffit.
    const corps = { requests: { on: { method: 'POST', url: `${base}/on`, body: '{"t":{durationS}}' }, off: { method: 'POST', url: `${base}/off` } } };
    assert.equal(status(() => s.svc.create('admin', { id: 'PROJ-2', name: 'p', type: 'light', transport: 'http', http: corps })), 0);
    // Dans l'adresse : accepte.
    assert.equal(status(() => s.svc.create('admin', { id: 'PROJ-3', name: 'p', type: 'light', transport: 'http', http: http(base) })), 0);
    // Action sans limite configuree par l'administrateur : exemptee.
    assert.equal(status(() => s.svc.create('admin', { id: 'PROJ-4', name: 'p', type: 'light', transport: 'http', actions: { on: { unbounded: true }, off: {} }, http: sans })), 0);
    // L'impulsion d'un relais est temporisee aussi.
    const pulse = { requests: { ...sans.requests, pulse: { method: 'GET', url: `${base}/pulse` } } };
    assert.equal(status(() => s.svc.create('admin', { id: 'REL-1', name: 'r', type: 'relay', transport: 'http', actions: { pulse: {}, off: {} }, http: pulse })), 400);
    // Modification : retirer {durationS} est refuse aussi.
    assert.equal(status(() => s.svc.update('admin', 'PROJ-3', { http: sans })), 400);
    assert.equal(status(() => s.svc.update('admin', 'PROJ-3', { name: 'renomme' })), 0, 'sans toucher au gabarit : accepte');
  });

  it('GARDE-FOU S3 : un retour « off » en echec est REESSAYE (toutes les 5 s, 5 essais au plus) jusqu a accuse', async () => {
    const relay = await startHttpRelay('ok');
    try {
      const s = setup();
      const base = `http://127.0.0.1:${relay.port}`;
      s.svc.create('admin', { id: 'PROJ-1', name: 'Projecteur', type: 'light', transport: 'http', actions: { on: { maxS: 600 }, off: {} }, http: http(base) });
      const on = s.svc.request(OP, 'PROJ-1', { action: 'on', params: { durationS: 30 }, confirm: true }).command;
      await settle(s);
      assert.equal(s.svc.command(on.cmdId)?.state, 'acked');
      assert.ok(relay.requests[0].url.includes('timer=30'), 'la duree est transmise au relais : il s eteint seul');
      relay.mode = 'error';
      s.step(31_001);
      await settle(s);
      assert.equal(offs(relay), 1);
      s.step(4_999);
      await settle(s);
      assert.equal(offs(relay), 1, 'pas avant 5 s');
      s.step(1);
      await settle(s);
      assert.equal(offs(relay), 2, 'deuxieme essai');
      relay.mode = 'ok'; // le relais est revenu
      s.step(5_000);
      await settle(s);
      assert.equal(offs(relay), 3, 'troisieme essai : accuse');
      const origin = s.svc.command(on.cmdId)!;
      assert.equal(origin.returnUnconfirmed, false);
      const attempts = s.svc.history('PROJ-1').filter((c) => c.auto);
      assert.equal(attempts.length, 3);
      assert.deepEqual(attempts.map((c) => c.state), ['acked', 'failed', 'failed'], 'du plus recent au plus ancien');
      assert.ok(attempts.every((c) => c.parentId === on.cmdId && c.action === 'off'));
      for (let k = 0; k < 5; k++) {
        s.step(3600_000);
        await settle(s);
      }
      assert.equal(offs(relay), 3, 'plus aucun essai apres l accuse');
      assert.equal(audits(s.db, 'commande_echec').filter((d) => d.includes('NON CONFIRME')).length, 0);
    } finally {
      await relay.close();
    }
  });

  it('GARDE-FOU S3 : 5 essais sans accuse -> avertissement VISIBLE (journal « commande_echec » + returnUnconfirmed), puis plus rien', async () => {
    const relay = await startHttpRelay('error');
    try {
      const s = setup();
      const base = `http://127.0.0.1:${relay.port}`;
      s.svc.create('admin', { id: 'PROJ-1', name: 'Projecteur', type: 'light', transport: 'http', actions: { on: { maxS: 600 }, off: {} }, http: http(base) });
      relay.mode = 'ok';
      const on = s.svc.request(OP, 'PROJ-1', { action: 'on', params: { durationS: 30 }, confirm: true }).command;
      await settle(s);
      relay.mode = 'error';
      s.step(31_001);
      await settle(s);
      for (let k = 2; k <= RETURN_MAX_TRIES; k++) {
        assert.equal(s.svc.command(on.cmdId)?.returnUnconfirmed, false, `avant le ${k}e essai`);
        s.step(5_000);
        await settle(s);
        assert.equal(offs(relay), k);
      }
      const origin = s.svc.command(on.cmdId)!;
      assert.equal(origin.returnUnconfirmed, true, 'champ lu par le panneau');
      assert.equal(origin.state, 'acked', 'l etat de la commande d origine n est pas reecrit');
      const warnings = audits(s.db, 'commande_echec').filter((d) => d.includes("retour a l'etat sur NON CONFIRME"));
      assert.equal(warnings.length, 1, 'un seul avertissement');
      assert.match(warnings[0], /5 essais sans accuse/);
      assert.ok(s.events.some((e) => (e as { type: string; command?: { cmdId: string; returnUnconfirmed: boolean } }).type === 'command' && (e as { command: { cmdId: string; returnUnconfirmed: boolean } }).command.cmdId === on.cmdId && (e as { command: { returnUnconfirmed: boolean } }).command.returnUnconfirmed), 'republie en direct');
      for (let k = 0; k < 5; k++) {
        s.step(3600_000);
        await settle(s);
      }
      assert.equal(offs(relay), RETURN_MAX_TRIES, 'jamais un sixieme essai');
      assert.equal(s.svc.history('PROJ-1').filter((c) => c.auto).every((c) => !c.returnUnconfirmed), true, 'les envois automatiques eux-memes ne portent pas le drapeau');
    } finally {
      await relay.close();
    }
  });

  it('GARDE-FOU S3 : MQTT sans accuse — 5 envois, avertissement, et un accuse tardif « done » leve l avertissement', async () => {
    const s = setup();
    const { key } = s.svc.create('admin', { id: 'SIR-01', name: 'Sirene', type: 'siren', transport: 'mqtt' });
    const on = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 30 }, confirm: true }).command;
    ack(s, key, 'SIR-01', on.cmdId);
    s.step(31_001); // retour automatique n°1 (envoye, jamais accuse)
    for (let k = 2; k <= RETURN_MAX_TRIES; k++) {
      s.step(5_000); // echec faute d'accuse
      s.step(5_000); // reessai
    }
    await flush();
    assert.equal(s.sent.filter((m) => m.msg.action === 'off').length, RETURN_MAX_TRIES);
    assert.equal(s.svc.command(on.cmdId)?.returnUnconfirmed, false, 'le dernier essai est encore en vol');
    s.step(5_000); // le dernier essai echoue
    assert.equal(s.svc.command(on.cmdId)?.returnUnconfirmed, true);
    assert.equal(audits(s.db, 'commande_echec').filter((d) => d.includes('NON CONFIRME')).length, 1);
    s.step(60_000);
    await flush();
    assert.equal(s.sent.filter((m) => m.msg.action === 'off').length, RETURN_MAX_TRIES, 'pas de sixieme essai');
    const lastOff = s.sent.filter((m) => m.msg.action === 'off').at(-1)!.msg.cmdId;
    ack(s, key, 'SIR-01', lastOff); // l'equipement avait bien execute : accuse tardif
    assert.equal(s.svc.command(on.cmdId)?.returnUnconfirmed, false);
  });

  it('GARDE-FOU S3 : les reessais ne concernent JAMAIS une commande manuelle, et s arretent des qu un ordre plus recent a pris la main', async () => {
    const relay = await startHttpRelay('error');
    try {
      const s = setup();
      const base = `http://127.0.0.1:${relay.port}`;
      s.svc.create('admin', { id: 'PROJ-1', name: 'Projecteur', type: 'light', transport: 'http', actions: { on: { maxS: 600 }, off: {} }, http: http(base) });
      // Commande manuelle en echec : jamais rejouee.
      const manual = s.svc.request(OP, 'PROJ-1', { action: 'on', params: { durationS: 30 }, confirm: true }).command;
      await settle(s);
      assert.equal(s.svc.command(manual.cmdId)?.state, 'failed');
      assert.equal(s.svc.command(manual.cmdId)?.offDueAt !== null, true);
      const requestsAfterManual = relay.requests.length;
      s.step(60_000);
      await settle(s);
      // Le retour automatique part (1 requete « off » en echec), mais le « on » manuel n'est pas rejoue.
      assert.equal(relay.requests.filter((r) => r.url.includes('turn=on')).length, 1);
      assert.equal(relay.requests.length, requestsAfterManual + 1);
      assert.equal(offs(relay), 1);
      // Un ordre plus recent prend la main : le reessai du « off » n'a plus lieu.
      relay.mode = 'ok';
      const again = s.svc.request(ADMIN, 'PROJ-1', { action: 'on', params: { durationS: 20 }, confirm: true }).command;
      await settle(s);
      assert.equal(s.svc.command(again.cmdId)?.state, 'acked');
      s.step(5_000);
      await settle(s);
      assert.equal(offs(relay), 1, 'le « off » en echec n est pas reessaye par-dessus le nouvel ordre');
      assert.equal(s.svc.command(manual.cmdId)?.offCmdId, 'remplace');
    } finally {
      await relay.close();
    }
  });

  it('GARDE-FOU S3 : le mode maintenance abandonne les reessais en cours (et ils ne reprennent pas apres)', async () => {
    const relay = await startHttpRelay('ok');
    try {
      const s = setup();
      const base = `http://127.0.0.1:${relay.port}`;
      s.svc.create('admin', { id: 'PROJ-1', name: 'Projecteur', type: 'light', transport: 'http', actions: { on: { maxS: 600 }, off: {} }, http: http(base) });
      const on = s.svc.request(OP, 'PROJ-1', { action: 'on', params: { durationS: 30 }, confirm: true }).command;
      await settle(s);
      relay.mode = 'error';
      s.step(31_001);
      await settle(s);
      assert.equal(offs(relay), 1);
      s.svc.setLock('admin', true, 'travaux');
      assert.match(audits(s.db, 'commandes_verrouillees')[0], /1 reessai\(s\)/);
      s.step(10_000);
      s.svc.setLock('admin', false, 'fin');
      relay.mode = 'ok';
      s.step(10_000);
      await settle(s);
      assert.equal(offs(relay), 1, 'abandonne pour de bon');
      assert.equal(s.svc.command(on.cmdId)?.offCmdId, 'verrou');
    } finally {
      await relay.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------ S4

describe('GARDE-FOU S4 : redemarrage', () => {
  function restart(s: S, up = 0) {
    const restarted: Buffer[] = [];
    const link2 = { up, listeners: () => link2.up, publishCommand: async (_id: string, p: Buffer) => void restarted.push(p) };
    const svc2 = createActuators({ db: s.db, key: s.key, audit: s.engine.audit, publish: () => {}, httpAllow: parseAllowList([]), now: () => s.clock.t });
    svc2.attachMqtt(link2);
    return { svc2, link2, restarted };
  }

  it("GARDE-FOU S4 : un retour a l'etat sur echu pendant l'arret n'est PAS abandonne si la passerelle n'est pas encore la : le « off » finit par partir, une seule entree de journal", async () => {
    const s = setup();
    s.svc.create('admin', { id: 'SIR-01', name: 'Sirene', type: 'siren', transport: 'mqtt', actions: { on: { maxS: 120 } } });
    const on = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 30 }, confirm: true }).command;
    s.clock.t += 60_000; // le PSIM s'arrete 60 s
    const { svc2, link2, restarted } = restart(s);
    for (let i = 0; i < 5; i++) {
      s.clock.t += 1_000;
      svc2.tick(); // la passerelle n'est pas la
    }
    assert.equal(restarted.length, 0);
    assert.equal(svc2.command(on.cmdId)?.offCmdId, null, 'toujours en attente (pas « liaison_coupee »)');
    assert.equal(audits(s.db, 'commande_echec').filter((d) => d.includes('en attente')).length, 1, 'une seule entree, pas une par seconde');
    link2.up = 1; // la passerelle est de retour
    s.clock.t += 1_000;
    svc2.tick();
    await flush();
    assert.equal(restarted.length, 1, 'le « off » finit par partir');
    assert.equal((JSON.parse(restarted[0].toString()) as CommandMessage).action, 'off');
    assert.match(svc2.command(on.cmdId)!.offCmdId!, /^[0-9a-f]{32}$/);
  });

  it('GARDE-FOU S4 : l attente de la passerelle est bornee a 24 h, puis le retour est abandonne (journalise)', async () => {
    const s = setup();
    s.svc.create('admin', { id: 'SIR-01', name: 'Sirene', type: 'siren', transport: 'mqtt', actions: { on: { maxS: 120 } } });
    const on = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 30 }, confirm: true }).command;
    s.clock.t += 60_000;
    const { svc2, restarted } = restart(s);
    s.clock.t += 24 * 3600_000 - 60_000;
    svc2.tick();
    assert.equal(svc2.command(on.cmdId)?.offCmdId, null, 'encore dans les 24 h');
    s.clock.t += 60_000;
    svc2.tick();
    await flush();
    assert.equal(svc2.command(on.cmdId)?.offCmdId, 'liaison_coupee');
    assert.equal(restarted.length, 0);
  });

  it('GARDE-FOU S4 : un retour automatique en vol au moment de l arret est rejoue apres le redemarrage (5 s), au plus 5 envois', async () => {
    const s = setup();
    const { key } = s.svc.create('admin', { id: 'SIR-01', name: 'Sirene', type: 'siren', transport: 'mqtt', actions: { on: { maxS: 120 } } });
    const on = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 30 }, confirm: true }).command;
    ack(s, key, 'SIR-01', on.cmdId);
    s.step(31_001); // retour automatique envoye... puis le PSIM s'arrete avant l'accuse
    const { svc2, restarted } = restart(s, 1);
    const origin = svc2.command(on.cmdId)!;
    assert.equal(svc2.command(origin.offCmdId!)?.state, 'expired');
    svc2.tick();
    await flush();
    assert.equal(restarted.length, 0, 'pas avant 5 s');
    s.clock.t += 5_000;
    svc2.tick();
    await flush();
    assert.equal(restarted.length, 1);
    assert.equal((JSON.parse(restarted[0].toString()) as CommandMessage).action, 'off');
  });
});

// ------------------------------------------------------------------------------------------------ S6

describe('GARDE-FOU S6 : issue de secours, defense en profondeur', () => {
  it("GARDE-FOU S6 : base modifiee a la main (safe_action = 'lock' sur une issue de secours) : « lock » n'est JAMAIS envoye", async () => {
    const s = setup();
    s.svc.create('admin', { id: 'SECOURS-1', name: 'Issue de secours escalier B', type: 'lock', transport: 'mqtt', emergencyExit: true });
    assert.notEqual(status(() => s.svc.request(ADMIN, 'SECOURS-1', { action: 'lock', confirm: true })), 0, 'request() refuse lock');
    s.db.prepare("UPDATE actuator SET safe_action = 'lock' WHERE id = 'SECOURS-1'").run();
    s.svc.request(OP, 'SECOURS-1', { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'evacuation', password: OP_PW });
    s.step(6_001);
    s.step(60_000);
    await flush();
    assert.deepEqual(s.sent.map((m) => m.msg.action), ['unlock'], 'aucun ordre de verrouillage');
    assert.equal(s.svc.get('SECOURS-1')?.safeAction, null);
  });

  it("GARDE-FOU S6 : retour planifie AVANT que l'enregistrement devienne issue de secours : le tick l'ignore (sans_objet), rien ne part", async () => {
    const s = setup();
    s.svc.create('admin', { id: 'PORTE-2', name: 'Porte', type: 'lock', transport: 'mqtt' });
    const open = s.svc.request(OP, 'PORTE-2', { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'livreur', password: OP_PW }).command;
    assert.notEqual(s.svc.command(open.cmdId)?.offDueAt, null, 'un « lock » est prevu');
    s.db.prepare("UPDATE actuator SET emergency_exit = 1, safe_action = 'lock' WHERE id = 'PORTE-2'").run(); // base modifiee a la main
    s.step(6_001);
    await flush();
    assert.equal(s.sent.some((m) => m.msg.action === 'lock'), false);
    assert.equal(s.svc.command(open.cmdId)?.offCmdId, 'sans_objet');
  });

  it("GARDE-FOU S6 : actions de la base contenant « lock » sur une issue de secours : refuse a la commande (403)", () => {
    const s = setup();
    s.svc.create('admin', { id: 'ISSUE-1', name: 'Issue nord', type: 'lock', transport: 'mqtt', emergencyExit: true });
    s.db.prepare("UPDATE actuator SET actions = ? WHERE id = 'ISSUE-1'").run(JSON.stringify({ unlock: { minS: 1, maxS: 10, roles: ['operator', 'admin'] }, lock: { roles: ['operator', 'admin'] } }));
    assert.equal(status(() => s.svc.request(OP, 'ISSUE-1', { action: 'lock', confirm: true })), 403);
    assert.equal(s.sent.length, 0);
  });
});

// ------------------------------------------------------------------------------------------------ A1

describe('GARDE-FOU A1 : cles heritees d Object.prototype', () => {
  const INHERITED = ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf', 'isPrototypeOf', 'toLocaleString'];

  it("GARDE-FOU A1 : a la configuration, « constructor » & co. ne sont jamais des actions (400)", () => {
    const s = setup();
    for (const a of INHERITED) {
      assert.equal(status(() => s.svc.create('admin', { id: 'SIR-03', name: 'Sirene', type: 'siren', transport: 'mqtt', actions: { on: {}, off: {}, [a]: { roles: ['operator'] } } })), 400, a);
    }
    assert.equal(status(() => s.svc.create('admin', { id: 'SIR-03', name: 'Sirene', type: 'siren', transport: 'mqtt', actions: JSON.parse('{"__proto__":{"roles":["operator"]}}') })), 400, '__proto__ propre (JSON)');
    assert.equal(s.svc.list('admin').actuators.length, 0);
  });

  it('GARDE-FOU A1 : a la commande, ces noms donnent 400 propre (jamais 500, jamais un ordre signe)', () => {
    const s = setup();
    s.svc.create('admin', { id: 'SIR-03', name: 'Sirene', type: 'siren', transport: 'mqtt' });
    for (const a of INHERITED) assert.equal(status(() => s.svc.request(OP, 'SIR-03', { action: a, confirm: true })), 400, a);
    // Base modifiee a la main : « constructor » dans les actions enregistrees.
    s.db.prepare("UPDATE actuator SET actions = ? WHERE id = 'SIR-03'").run(JSON.stringify({ on: { minS: 1, maxS: 60, roles: ['operator'] }, off: { roles: ['operator'] }, constructor: { roles: ['operator'] } }));
    assert.equal(status(() => s.svc.request(OP, 'SIR-03', { action: 'constructor', confirm: true })), 400);
    assert.equal(s.sent.length, 0, 'aucun ordre signe');
  });

  it('GARDE-FOU A1 : parametres, annulation et gabarits HTTP ne lisent pas les cles heritees', async () => {
    const s = setup();
    s.svc.create('admin', { id: 'SIR-03', name: 'Sirene', type: 'siren', transport: 'mqtt' });
    for (const k of INHERITED) assert.equal(status(() => s.svc.request(OP, 'SIR-03', { action: 'on', confirm: true, params: { durationS: 5, [k]: 1 } })), 400, `params.${k}`);
    assert.equal(status(() => s.svc.request(OP, 'SIR-03', { action: 'on', confirm: true, params: JSON.parse('{"__proto__":1}') })), 400);
    assert.equal(status(() => s.svc.cancel(OP, 'constructor')), 404);
    // Actions de la base absentes du catalogue : l'annulation ne plante pas.
    const c = s.svc.request(OP, 'SIR-03', { action: 'on', params: { durationS: 30 }, confirm: true }).command;
    s.db.prepare("UPDATE actuator SET actions = '{}' WHERE id = 'SIR-03'").run();
    assert.equal(status(() => s.svc.cancel(OP, c.cmdId)), 403);
    // Transport HTTP : requests[action] avec une cle heritee.
    const cfg = { requests: { on: { method: 'GET' as const, url: 'http://127.0.0.1:9/' } } };
    for (const a of ['constructor', 'toString', '__proto__']) {
      const out = await sendHttp(cfg, a, {}, null, parseAllowList(['127.0.0.1']), 500);
      assert.equal(out.kind, 'not_delivered', a);
    }
    assert.equal(
      status(() => s.svc.create('admin', { id: 'H-1', name: 'h', type: 'light', transport: 'http', actions: { on: {}, off: {} }, http: { requests: { off: { method: 'GET', url: 'http://127.0.0.1:9/' } } } })),
      400,
      'requete « on » manquante : pas de repli sur Object.prototype',
    );
  });
});

// ------------------------------------------------------------------------------------------------ A2 / A3

describe('GARDE-FOU A2 / A3 : re-authentification', () => {
  it('GARDE-FOU A2 : le dedoublonnage ne dispense plus de la re-authentification — mot de passe faux = 403 journalise, jamais « 200 »', () => {
    const s = setup();
    const second = s.user('a2-admin', 'admin');
    s.svc.create('admin', { id: 'GACHE-1', name: 'Gache', type: 'lock', transport: 'mqtt' });
    const first = s.svc.request(OP, 'GACHE-1', { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'livreur', password: OP_PW });
    assert.equal(first.status, 201);
    const n = audits(s.db, 'commande_demandee').length;
    const body = { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'autre motif', password: 'mot-de-passe-FAUX' };
    assert.equal(status(() => s.svc.request(second, 'GACHE-1', body)), 403);
    assert.equal(audits(s.db, 'commande_reauth_echec').length, 1, 'echec journalise');
    assert.equal(audits(s.db, 'commande_demandee').length, n);
    assert.equal(status(() => s.svc.request(second, 'GACHE-1', { ...body, password: undefined })), 428, 'sans mot de passe aussi');
  });

  it("GARDE-FOU A2 : commande identique en vol d'un AUTRE compte : 409 sans rien reveler, pas de renvoi de sa commande ; meme compte : 200 dedoublonnee", () => {
    const s = setup();
    const second = s.user('a2-admin2', 'admin');
    s.svc.create('admin', { id: 'GACHE-1', name: 'Gache', type: 'lock', transport: 'mqtt' });
    const first = s.svc.request(OP, 'GACHE-1', { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'livreur-secret', password: OP_PW });
    const n = audits(s.db, 'commande_demandee').length;
    let caught: PsimError | null = null;
    try {
      s.svc.request(second, 'GACHE-1', { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'autre', password: second.password });
    } catch (err) {
      caught = err as PsimError;
    }
    assert.equal(caught?.status, 409);
    assert.match(caught!.message, /autre compte/);
    assert.ok(!caught!.message.includes('livreur-secret') && !/op/.test(caught!.message), 'ni sa raison ni son nom');
    assert.equal(audits(s.db, 'commande_demandee').length, n, 'rien de nouveau, rien de renvoye');
    const same = s.svc.request(OP, 'GACHE-1', { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'livreur-secret', password: OP_PW });
    assert.equal(same.status, 200);
    assert.equal(same.deduplicated, true);
    assert.equal(same.command.cmdId, first.command.cmdId);
  });

  it('GARDE-FOU A2 : sirene (sans mot de passe) — un autre compte recoit aussi 409, le meme compte 200', () => {
    const s = setup();
    s.svc.create('admin', { id: 'SIR-01', name: 'Sirene', type: 'siren', transport: 'mqtt' });
    const first = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 10 }, confirm: true });
    assert.equal(s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 10 }, confirm: true }).command.cmdId, first.command.cmdId);
    assert.equal(status(() => s.svc.request(ADMIN, 'SIR-01', { action: 'on', params: { durationS: 10 }, confirm: true })), 409);
  });

  it("GARDE-FOU A3 : la re-authentification partage le compteur de la CONNEXION (5 echecs par minute au total), ferme les sessions", () => {
    const s = setup();
    const u = s.user('a3-op');
    s.svc.create('admin', { id: 'GACHE-2', name: 'Gache', type: 'lock', transport: 'mqtt' });
    for (let i = 0; i < 3; i++) recordFailure('user:a3-op'); // trois essais ratés a la CONNEXION
    for (let i = 0; i < 2; i++) assert.equal(status(() => s.svc.request(u, 'GACHE-2', { action: 'unlock', params: { durationS: 5 + i }, confirm: true, reason: 'x', password: `essai-${i}` })), 403);
    assert.equal(isRateLimited('user:a3-op'), true, '3 + 2 = 5 : la connexion est fermee aussi');
    assert.equal(status(() => s.svc.request(u, 'GACHE-2', { action: 'unlock', params: { durationS: 9 }, confirm: true, reason: 'x', password: u.password })), 429, 'meme le bon mot de passe');
    assert.equal(audits(s.db, 'commande_reauth_echec').length, 2);
    assert.equal(audits(s.db, 'reauth_session_fermee').length, 1, 'sessions du compte fermees au 5e echec');
  });

  it('GARDE-FOU A3 : l ancien compteur « reauth: » n existe plus (la connexion par mot de passe voit chaque echec de commande)', () => {
    const s = setup();
    const u = s.user('a3-op2');
    s.svc.create('admin', { id: 'GACHE-2', name: 'Gache', type: 'lock', transport: 'mqtt' });
    for (let i = 0; i < 4; i++) status(() => s.svc.request(u, 'GACHE-2', { action: 'unlock', params: { durationS: 3 + i }, confirm: true, reason: 'x', password: `faux-${i}` }));
    assert.equal(isRateLimited('user:a3-op2'), false);
    recordFailure('user:a3-op2');
    assert.equal(isRateLimited('user:a3-op2'), true, 'quatre echecs de commande + un echec de connexion = 5');
  });

  it('GARDE-FOU A2/A3 : l action sure reste immediate (ni mot de passe ni raison) meme pour une serrure', () => {
    const s = setup();
    s.svc.create('admin', { id: 'GACHE-1', name: 'Gache', type: 'lock', transport: 'mqtt' });
    assert.equal(s.svc.request(OP, 'GACHE-1', { action: 'lock', confirm: true }).status, 201);
  });
});

// ------------------------------------------------------------------------------------------------ A4 / A5

describe('GARDE-FOU A4 : URL des relais HTTP', () => {
  it('GARDE-FOU A4 : un role autre qu admin ne voit ni jeton, ni identifiants, ni corps des requetes HTTP ; l admin voit tout', () => {
    const s = setup();
    s.svc.create('admin', {
      id: 'REL-HTTP',
      name: 'Relais portillon',
      type: 'relay',
      transport: 'http',
      actions: { pulse: {}, off: {} },
      http: {
        requests: {
          pulse: { method: 'POST', url: 'http://127.0.0.1:9/relay/0?turn=on&auth_key=JETON-SECRET-123&s={durationS}', body: '{"token":"JETON-CORPS-456","s":{durationS}}' },
          off: { method: 'GET', url: 'http://127.0.0.1:9/relay/0?turn=off&auth_key=JETON-SECRET-123' },
        },
        secretHeader: 'Authorization',
        secretValue: 'Basic c2VjcmV0',
      },
    });
    const operator = JSON.stringify(s.svc.list('operator'));
    assert.ok(!operator.includes('JETON-SECRET-123'), 'jeton de la chaine de requete masque');
    assert.ok(!operator.includes('JETON-CORPS-456'), 'corps masque');
    assert.ok(!operator.includes('c2VjcmV0'));
    assert.ok(operator.includes('http://127.0.0.1:9/relay/0?...'), 'marqueur a la place de la chaine de requete');
    const admin = JSON.stringify(s.svc.list('admin'));
    assert.ok(admin.includes('JETON-SECRET-123') && admin.includes('JETON-CORPS-456'), "l'administrateur voit tout");
    assert.ok(!admin.includes('c2VjcmV0'), "l'en-tete secret n'est jamais renvoye");
    // La liste d'un operateur reste utilisable : actions, methode, hote.
    const view = s.svc.list('operator').actuators[0];
    assert.equal(view.http?.requests.off.method, 'GET');
    assert.deepEqual(view.allowed.sort(), ['off', 'pulse']);
  });

  it('GARDE-FOU A4 : identifiants « user:pw@ » d une base modifiee a la main masques aussi', () => {
    const s = setup();
    s.svc.create('admin', { id: 'REL-HTTP', name: 'Relais', type: 'relay', transport: 'http', actions: { pulse: {}, off: {} }, http: { requests: { pulse: { method: 'GET', url: 'http://127.0.0.1:9/p?s={durationS}' }, off: { method: 'GET', url: 'http://127.0.0.1:9/o' } } } });
    s.db.prepare("UPDATE actuator SET transport_config = ? WHERE id = 'REL-HTTP'").run(
      JSON.stringify({ requests: { pulse: { method: 'GET', url: 'http://admin:MOTDEPASSE@10.0.0.5/p?k=CLE-SECRETE' }, off: { method: 'GET', url: 'https://10.0.0.5/o#frag' } } }),
    );
    const seen = JSON.stringify(s.svc.list('operator'));
    assert.ok(!seen.includes('MOTDEPASSE') && !seen.includes('CLE-SECRETE'));
    assert.ok(seen.includes('http://***@10.0.0.5/p?...'));
  });
});

describe('GARDE-FOU A5 : actionneur declare « sensible »', () => {
  it('GARDE-FOU A5 : un relais sensible exige raison + mot de passe (sauf son action sure) ; un relais ordinaire non', () => {
    const s = setup();
    const u = s.user('a5-op');
    const v = s.svc.create('admin', { id: 'REL-PORTILLON', name: 'Portillon cable sur un relais', type: 'relay', transport: 'mqtt', sensitive: true, confirm: 'simple', actions: { pulse: {}, off: {} } }).actuator;
    assert.equal(v.sensitive, true);
    assert.equal(v.confirm, 'reauth', 'mot de passe impose et non abaissable');
    assert.equal(s.svc.create('admin', { id: 'REL-LAMPE', name: 'Lampe', type: 'relay', transport: 'mqtt' }).actuator.sensitive, false);
    assert.equal(s.svc.request(OP, 'REL-LAMPE', { action: 'pulse', params: { durationS: 3 }, confirm: true }).status, 201, 'relais ordinaire : inchange');
    const p = { action: 'pulse', params: { durationS: 3 }, confirm: true };
    assert.equal(status(() => s.svc.request(u, 'REL-PORTILLON', p)), 428, 'sans raison');
    assert.equal(status(() => s.svc.request(u, 'REL-PORTILLON', { ...p, reason: 'livreur' })), 428, 'sans mot de passe');
    assert.equal(status(() => s.svc.request(u, 'REL-PORTILLON', { ...p, reason: 'livreur', password: 'faux' })), 403);
    assert.equal(s.svc.request(u, 'REL-PORTILLON', { ...p, reason: 'livreur', password: u.password }).status, 201);
    assert.equal(s.svc.request(u, 'REL-PORTILLON', { action: 'off', confirm: true }).status, 201, 'action sure : immediate');
  });

  it('GARDE-FOU A5 : la declaration se modifie, est validee, apparait dans la vue et au journal', () => {
    const s = setup();
    s.svc.create('admin', { id: 'REL-1', name: 'r', type: 'relay', transport: 'mqtt' });
    assert.equal(status(() => s.svc.update('admin', 'REL-1', { sensitive: 'oui' })), 400);
    const v = s.svc.update('admin', 'REL-1', { sensitive: true });
    assert.equal(v.sensitive, true);
    assert.equal(v.confirm, 'reauth');
    assert.match(audits(s.db, 'actionneur_modifie').at(-1)!, /SENSIBLE/);
    assert.equal(s.svc.update('admin', 'REL-1', { name: 'renomme' }).sensitive, true, 'conservee quand on ne la mentionne pas');
    assert.equal(s.svc.update('admin', 'REL-1', { sensitive: false }).sensitive, false);
    assert.equal(s.svc.create('admin', { id: 'G-1', name: 'g', type: 'lock', transport: 'mqtt', sensitive: false }).actuator.sensitive, true, 'une serrure l est de toute facon');
  });

  it('GARDE-FOU A5 : migration — une table `actuator` d avant la colonne la gagne (ALTER protege), sans perdre de donnees, deux passages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-garde-mig-'));
    dirs.push(dir);
    const db = openDb(join(dir, 'psim.db'));
    opened.push(db);
    seedEmptySite(db);
    // Ancienne table : le schema actuel sans la colonne `sensitive` (openDb avait deja migre : on remonte le temps).
    const old = ACTUATOR_SCHEMA.replace('  sensitive INTEGER NOT NULL DEFAULT 0,\n', '');
    assert.notEqual(old, ACTUATOR_SCHEMA);
    db.exec('DROP TABLE actuator');
    db.exec(old);
    db.prepare(
      `INSERT INTO actuator (id, name, type, transport, actions, key_sealed, created_at, created_by) VALUES ('VIEUX-1', 'Vieille sirene', 'siren', 'mqtt', '{"on":{"minS":1,"maxS":60,"roles":["operator","admin"]},"off":{"roles":["operator","admin"]}}', 'x', 1, 'admin')`,
    ).run();
    assert.equal((db.prepare('PRAGMA table_info(actuator)').all() as { name: string }[]).some((c) => c.name === 'sensitive'), false);
    for (const pass of [1, 2]) {
      migrateActuators(db);
      const cols = (db.prepare('PRAGMA table_info(actuator)').all() as { name: string }[]).filter((c) => c.name === 'sensitive');
      assert.equal(cols.length, 1, `passage ${pass}`);
      assert.equal((db.prepare("SELECT sensitive FROM actuator WHERE id = 'VIEUX-1'").get() as { sensitive: number }).sensitive, 0);
    }
    const engine = createEngine(db, () => {});
    const svc = createActuators({ db, key: randomBytes(32), audit: engine.audit, publish: () => {}, httpAllow: parseAllowList([]) });
    assert.equal(svc.get('VIEUX-1')?.sensitive, false);
    assert.equal(svc.create('admin', { id: 'NEUF-1', name: 'n', type: 'relay', transport: 'mqtt', sensitive: true }).actuator.sensitive, true);
  });
});

// ------------------------------------------------------------------------------------------------ H1 / H2

describe('GARDE-FOU H1 : SSRF', () => {
  it('GARDE-FOU H1 : IPv6 qui embarque une IPv4 (NAT64, compatible, inscrite hexadecimale) ramenee a l IPv4 : les refus permanents tiennent', () => {
    const allow = parseAllowList(['relais.site.local']);
    assert.equal(urlProblem('http://relais.site.local/x', allow), null);
    for (const ip of ['64:ff9b::a9fe:a9fe', '64:ff9b::169.254.169.254', '::127.0.0.1', '::7f00:1', '::ffff:a9fe:a9fe', '::ffff:169.254.169.254', '::ffff:7f00:1', '::ffff:0.0.0.5', '::169.254.169.254', '64:ff9b:1::5', 'fec0::1', '::2']) {
      assert.equal(addressAllowed(ip, allow, true), false, `${ip} via un nom autorise`);
      assert.equal(addressAllowed(ip, parseAllowList([]), false), false, `${ip} par defaut`);
    }
    assert.equal(normalizeIp('::ffff:a9fe:a9fe'), '169.254.169.254');
    assert.equal(normalizeIp('64:ff9b::a00:5'), '10.0.0.5');
    assert.equal(normalizeIp('::10.0.0.5'), '10.0.0.5');
    assert.equal(normalizeIp('::1'), '::1');
    assert.equal(normalizeIp('::'), '::');
    assert.equal(normalizeIp('FD12:0:0::5'), 'fd12::5');
    // L'IPv4 reelle est privee : acceptee par defaut, sous toutes ses formes.
    for (const ip of ['::ffff:10.0.0.5', '::ffff:a00:5', '64:ff9b::a00:5']) assert.equal(addressAllowed(ip, parseAllowList([]), false), true, ip);
    assert.notEqual(urlProblem('http://[64:ff9b::a9fe:a9fe]/x', allow), null);
    assert.notEqual(urlProblem('http://[::ffff:a9fe:a9fe]/x', parseAllowList([])), null);
  });

  it('GARDE-FOU H1 : un NOM autorise ne rend plus acceptable n importe quelle adresse resolue (rebinding vers Internet, boucle locale, metadonnees)', () => {
    const allow = parseAllowList(['relais.site.local']);
    assert.equal(addressAllowed('8.8.8.8', allow, true), false, 'adresse publique : refusee');
    assert.equal(addressAllowed('2606:4700::1111', allow, true), false);
    assert.equal(addressAllowed('127.0.0.1', allow, true), false);
    assert.equal(addressAllowed('169.254.169.254', allow, true), false);
    assert.equal(addressAllowed('100.64.0.1', allow, true), false);
    // Reseau prive : le cas d'usage.
    for (const ip of ['192.168.1.1', '10.1.2.3', '172.16.0.9', 'fd12::5']) assert.equal(addressAllowed(ip, allow, true), true, ip);
    // Sauf si la liste nomme elle-meme l'adresse (essais en boucle locale nommee) ou son bloc.
    const lit = parseAllowList(['localhost', '127.0.0.1', '203.0.113.0/24']);
    assert.equal(addressAllowed('127.0.0.1', lit, true), true);
    assert.equal(addressAllowed('127.0.0.2', lit, true), false);
    assert.equal(addressAllowed('203.0.113.7', lit, true), true);
    assert.equal(addressAllowed('8.8.8.8', lit, true), false);
    assert.equal(addressAllowed('192.168.1.1', parseAllowList(['10.20.0.0/16']), false), false, 'adresse litterale hors de la liste');
    // Entree IPv6 « deguisee » dans la liste : ramenee a l'IPv4.
    assert.equal(addressAllowed('10.0.0.5', parseAllowList(['::ffff:10.0.0.5']), false), true);
  });

  it('GARDE-FOU H1 : de bout en bout — un nom liste vers la boucle locale n est joint que si la liste nomme aussi cette adresse', async () => {
    const relay = await startHttpRelay('ok');
    try {
      const cfg = { requests: { on: { method: 'GET' as const, url: `http://localhost:${relay.port}/on` } } };
      const refused = await sendHttp(cfg, 'on', {}, null, parseAllowList(['localhost']), 2000);
      assert.equal(refused.kind, 'not_delivered');
      assert.equal(relay.requests.length, 0);
      const joined = await sendHttp(cfg, 'on', {}, null, parseAllowList(['localhost', '127.0.0.1']), 2000);
      assert.equal(joined.kind, 'acked');
      assert.equal(relay.requests.length, 1);
    } finally {
      await relay.close();
    }
  });

  it("CONTROLE : formes d'adresses deguisees dans l'URL (decimal, octal, hex, IPv6 inscrite, identifiants) refusees par defaut", () => {
    const allow = parseAllowList([]);
    for (const u of ['http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://[::ffff:127.0.0.1]/', 'http://[::1]/', 'http://localhost/', 'http://169.254.169.254/', 'http://100.64.0.1/', 'http://0.0.0.0/', 'http://[fe80::1]/', 'http://admin:pw@10.0.0.5/', 'http://metadata.google.internal/']) {
      assert.notEqual(urlProblem(u, allow), null, u);
    }
    assert.equal(urlProblem('http://10.0.0.5:8080/relay?x=1', allow), null);
  });
});

describe('GARDE-FOU H2 : serrure, portail, actionneur sensible jamais en HTTP', () => {
  const requests = (url = 'http://10.0.0.5') => ({ requests: { unlock: { method: 'GET', url: `${url}/relay/0?turn=on&t={durationS}` }, lock: { method: 'GET', url: `${url}/relay/0?turn=off` } } });

  it('GARDE-FOU H2 : creation et modification en HTTP refusees (400), message clair', () => {
    const s = setup([]);
    const http = { ...requests(), secretHeader: 'Authorization', secretValue: 'Basic YWRtaW46YWRtaW4=' };
    assert.equal(status(() => s.svc.create('admin', { id: 'PORTE-HTTP', name: 'Porte principale', type: 'lock', transport: 'http', http })), 400);
    assert.match(message(() => s.svc.create('admin', { id: 'PORTE-HTTP', name: 'Porte principale', type: 'lock', transport: 'http', http })), /MQTT/);
    const gate = { requests: { open: { method: 'GET', url: 'http://10.0.0.5/o?t={durationS}' }, close: { method: 'GET', url: 'http://10.0.0.5/c?t={durationS}' }, stop: { method: 'GET', url: 'http://10.0.0.5/s' } } };
    assert.equal(status(() => s.svc.create('admin', { id: 'PORTAIL-HTTP', name: 'Portail', type: 'gate', transport: 'http', http: gate })), 400);
    const relayHttp = { requests: { pulse: { method: 'GET', url: 'http://10.0.0.5/p?s={durationS}' }, off: { method: 'GET', url: 'http://10.0.0.5/o' } } };
    assert.equal(status(() => s.svc.create('admin', { id: 'REL-S', name: 'r', type: 'relay', transport: 'http', sensitive: true, actions: { pulse: {}, off: {} }, http: relayHttp })), 400, 'relais declare sensible');
    assert.equal(s.svc.list('admin').actuators.length, 0);
    // Un relais ordinaire en HTTP reste possible ; le declarer sensible ensuite, ou passer une serrure en HTTP, est refuse.
    s.svc.create('admin', { id: 'REL-OK', name: 'r', type: 'relay', transport: 'http', actions: { pulse: {}, off: {} }, http: relayHttp });
    assert.equal(status(() => s.svc.update('admin', 'REL-OK', { sensitive: true })), 400);
    s.svc.create('admin', { id: 'PORTE-MQTT', name: 'Porte', type: 'lock', transport: 'mqtt' });
    assert.equal(status(() => s.svc.update('admin', 'PORTE-MQTT', { transport: 'http', http })), 400);
    assert.equal(s.svc.get('PORTE-MQTT')?.transport, 'mqtt');
  });

  it('GARDE-FOU H2 : un enregistrement HTTP deja present en base (serrure) est refuse a l envoi — rien ne part vers le reseau — sauf l action sure', async () => {
    const relay = await startHttpRelay('ok');
    try {
      const s = setup();
      s.svc.create('admin', { id: 'PORTE-X', name: 'Porte', type: 'lock', transport: 'mqtt' });
      const base = `http://127.0.0.1:${relay.port}`;
      // Base modifiee a la main : la serrure passe en HTTP.
      s.db.prepare("UPDATE actuator SET transport = 'http', transport_config = ? WHERE id = 'PORTE-X'").run(JSON.stringify(requests(base)));
      const r = s.svc.request(OP, 'PORTE-X', { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'livreur', password: OP_PW });
      assert.equal(r.command.state, 'refused', 'refusee par le PSIM');
      assert.match(r.command.ack ?? '', /HTTP interdit/);
      assert.equal(audits(s.db, 'commande_refusee').length, 1);
      await sleep(50);
      assert.equal(relay.requests.length, 0, 'aucune requete HTTP envoyee');
      // L'action sure n'est pas bloquee (reverrouiller doit rester possible, la rejouer est inoffensif).
      const l = s.svc.request(OP, 'PORTE-X', { action: 'lock', confirm: true });
      assert.equal(l.status, 201);
      await settle(s);
      assert.equal(relay.requests.length, 1);
      assert.ok(relay.requests[0].url.includes('turn=off'));
    } finally {
      await relay.close();
    }
  });

  it('GARDE-FOU H2 : relais declare sensible en base mais en HTTP : l action non sure est refusee a l envoi', async () => {
    const relay = await startHttpRelay('ok');
    try {
      const s = setup();
      const base = `http://127.0.0.1:${relay.port}`;
      s.svc.create('admin', {
        id: 'REL-X',
        name: 'r',
        type: 'relay',
        transport: 'http',
        actions: { pulse: {}, off: {} },
        http: { requests: { pulse: { method: 'GET', url: `${base}/p?s={durationS}` }, off: { method: 'GET', url: `${base}/o?turn=off` } } },
      });
      s.db.prepare("UPDATE actuator SET sensitive = 1, confirm = 'reauth' WHERE id = 'REL-X'").run();
      const r = s.svc.request(OP, 'REL-X', { action: 'pulse', params: { durationS: 2 }, confirm: true, reason: 'x', password: OP_PW });
      assert.equal(r.command.state, 'refused');
      await sleep(50);
      assert.equal(relay.requests.length, 0);
    } finally {
      await relay.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------ exceptions internes

describe('GARDE-FOU : une exception interne ne doit jamais arreter le PSIM', () => {
  it('GARDE-FOU : exception pendant le traitement de la reponse HTTP -> commande en echec « erreur interne » (incertaine), journalisee, aucun rejet non gere', async () => {
    const relay = await startHttpRelay('ok');
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    const consoleError = console.error;
    process.on('unhandledRejection', onUnhandled);
    console.error = () => {};
    try {
      const s = setup();
      s.svc.create('admin', { id: 'REL-1', name: 'r', type: 'relay', transport: 'http', actions: { on: { maxS: 60 }, off: {} }, http: { requests: { on: { method: 'GET', url: `http://127.0.0.1:${relay.port}/on?t={durationS}` }, off: { method: 'GET', url: `http://127.0.0.1:${relay.port}/off` } } } });
      const c = s.svc.request(OP, 'REL-1', { action: 'on', params: { durationS: 10 }, confirm: true }).command;
      s.clock.boom = true; // la prochaine lecture de l'horloge (traitement de la reponse) leve une exception
      for (let i = 0; i < 100 && s.svc.command(c.cmdId)?.state === 'sent'; i++) await sleep(10);
      await sleep(30);
      const after = s.svc.command(c.cmdId)!;
      assert.equal(after.state, 'failed');
      assert.equal(after.uncertain, true);
      assert.match(after.ack ?? '', /erreur interne/);
      assert.match(audits(s.db, 'commande_echec').at(-1)!, /erreur interne/);
      assert.deepEqual(unhandled, []);
    } finally {
      console.error = consoleError;
      process.off('unhandledRejection', onUnhandled);
      await relay.close();
    }
  });

  it('GARDE-FOU : le broker leve ou rejette a la publication -> echec journalise, jamais d exception vers l appelant', async () => {
    const s = setup();
    const consoleError = console.error;
    console.error = () => {};
    try {
      s.svc.create('admin', { id: 'SIR-01', name: 'Sirene', type: 'siren', transport: 'mqtt' });
      s.link.publish = false; // publishCommand rejette
      const a = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 10 }, confirm: true }).command;
      await flush();
      assert.equal(s.svc.command(a.cmdId)?.state, 'failed');
      s.link.publishCommand = (() => {
        throw new Error('exception synchrone');
      }) as never;
      const b = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 11 }, confirm: true }).command;
      assert.equal(s.svc.command(b.cmdId)?.state, 'failed');
      assert.match(s.svc.command(b.cmdId)?.ack ?? '', /erreur interne/);
      assert.equal(s.svc.command(b.cmdId)?.uncertain, true);
    } finally {
      console.error = consoleError;
    }
  });
});

// ------------------------------------------------------------------------------------------------ controles de la revue

describe('CONTROLE (revue) : attaques essayees sans succes', () => {
  it('CONTROLE : types inattendus pour confirm / password / durationS / reason refuses', () => {
    const s = setup();
    s.svc.create('admin', { id: 'GACHE-3', name: 'Gache', type: 'lock', transport: 'mqtt' });
    const base = { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'x', password: OP_PW };
    for (const confirm of ['true', 1, [true], { v: true }]) assert.equal(status(() => s.svc.request(OP, 'GACHE-3', { ...base, confirm })), 428, String(confirm));
    for (const password of [[OP_PW], { p: OP_PW }, 1]) assert.equal(status(() => s.svc.request(OP, 'GACHE-3', { ...base, password })), 428);
    for (const durationS of ['5', 5.5, -1, 0, 1e999, NaN, 11, [5]]) assert.equal(status(() => s.svc.request(OP, 'GACHE-3', { ...base, params: { durationS } })), 400, String(durationS));
    for (const reason of [['x'], { x: 1 }, 5]) assert.equal(status(() => s.svc.request(OP, 'GACHE-3', { ...base, reason })), 400);
    assert.equal(status(() => s.svc.request(OP, 'GACHE-3', { ...base, reason: '   \n\t ' })), 428, 'raison vide apres nettoyage');
  });

  it('CONTROLE : accuse falsifie / d un autre actionneur / rejoue : ignore, la commande reste « envoyee »', () => {
    const s = setup();
    const { key } = s.svc.create('admin', { id: 'SIR-01', name: 'Sirene', type: 'siren', transport: 'mqtt' });
    const other = s.svc.create('admin', { id: 'SIR-02', name: 'Sirene 2', type: 'siren', transport: 'mqtt' });
    const a = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 30 }, confirm: true }).command;
    ack(s, other.key, 'SIR-01', a.cmdId); // cle d'un autre actionneur
    s.svc.handleAck('SIR-01', Buffer.from(JSON.stringify({ ...signAck(key, 'SIR-01', { cmdId: a.cmdId, result: 'done', ts: s.clock.t }), sig: '0'.repeat(64) })));
    assert.equal(s.svc.command(a.cmdId)?.state, 'sent');
    ack(s, key, 'SIR-01', a.cmdId);
    s.clock.t += 1000;
    ack(s, key, 'SIR-01', a.cmdId, 'error');
    assert.equal(s.svc.command(a.cmdId)?.state, 'acked');
  });
});
