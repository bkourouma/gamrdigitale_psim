/**
 * Commandes des equipements (server/actuators.ts, actuatorproto.ts, actuatorhttp.ts) : protocole signe (vecteurs de
 * docs/COMMANDES.md), droits, confirmation, raison, re-authentification, limites, dedoublonnage, bornes de duree,
 * journal avant envoi, accuses (valides, falsifies, rejoues, tardifs, d'une autre commande), TTL, retour a l'etat sur,
 * mode maintenance, issue de secours, liaison coupee, redemarrage, incident clos, transport HTTP et SSRF, migration.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { ackCanonical, commandCanonical, signAck, signCommand, verifyAck, verifyCommand } from '../server/actuatorproto.ts';
import type { CommandMessage } from '../server/actuatorproto.ts';
import { addressAllowed, parseAllowList, sendHttp, urlProblem } from '../server/actuatorhttp.ts';
import { createActuators } from '../server/actuators.ts';
import { verify } from '../server/auditchain.ts';
import { createUser } from '../server/auth.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { PsimError } from '../server/errors.ts';
import { seedDemo, seedEmptySite } from '../server/seed.ts';
import type { PsimEvent } from '../server/types.ts';
import { startHttpRelay } from './actuator-sim.ts';

const VECTOR_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
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

function status(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    if (err instanceof PsimError) return err.status;
    throw err;
  }
  return 0;
}

function setup(options: { allow?: string[]; dir?: string; secret?: Buffer; demo?: boolean } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'psim-act-'));
  if (!options.dir) dirs.push(dir);
  const db = openDb(join(dir, 'psim.db'));
  opened.push(db);
  if (options.demo) seedDemo(db, dir, join(import.meta.dirname, '..', 'seed'));
  else seedEmptySite(db);
  const clock = { t: 1_760_000_000_000 };
  const engine = createEngine(db, () => {}, () => clock.t);
  if (!options.dir) {
    createUser(db, 'admin', 'admin', ADMIN_PW);
    createUser(db, 'op', 'operator', OP_PW);
  }
  const events: PsimEvent[] = [];
  const sent: { id: string; msg: CommandMessage; auditBefore: string[] }[] = [];
  const link = {
    up: 1,
    listeners: () => link.up,
    publishCommand: async (id: string, payload: Buffer) => {
      // Ce que le journal contient AU MOMENT de l'envoi : la demande doit y etre, scellee.
      const rows = db.prepare('SELECT action, details FROM audit_log ORDER BY id DESC LIMIT 4').all() as { action: string; details: string }[];
      sent.push({ id, msg: JSON.parse(payload.toString()) as CommandMessage, auditBefore: rows.map((r) => r.action) });
    },
  };
  const key = options.secret ?? randomBytes(32);
  const svc = createActuators({ db, key, audit: engine.audit, publish: (e) => events.push(e), httpAllow: parseAllowList(options.allow ?? ['127.0.0.1']), now: () => clock.t });
  svc.attachMqtt(link);
  return { dir, db, clock, engine, events, sent, link, svc, key };
}

const audits = (db: DatabaseSync, action: string) => (db.prepare('SELECT details FROM audit_log WHERE action = ? ORDER BY id').all(action) as { details: string }[]).map((r) => r.details);
const flush = () => new Promise((r) => setImmediate(r));

describe('protocole signe : vecteurs de docs/COMMANDES.md', () => {
  it('ordre et accuse : chaines canoniques et signatures exactes', () => {
    const cmd = { cmdId: '0123456789abcdef0123456789abcdef', action: 'on', params: { durationS: 30 }, ts: 1760000000000, ttlS: 10 };
    assert.equal(commandCanonical('SIR-01', cmd), 'psim-cmd-v1|SIR-01|0123456789abcdef0123456789abcdef|on|30||1760000000000|10');
    assert.equal(signCommand(VECTOR_KEY, 'SIR-01', cmd).sig, '6093f1a2a2059ef774346df9dde1becae2176df72ffcdee8e4778d504845c7f5');
    const ack = { cmdId: '0123456789abcdef0123456789abcdef', result: 'done' as const, ts: 1760000000850 };
    assert.equal(ackCanonical('SIR-01', ack), 'psim-ack-v1|SIR-01|0123456789abcdef0123456789abcdef|done||1760000000850');
    assert.equal(signAck(VECTOR_KEY, 'SIR-01', ack).sig, '255db3b9fa4c4c174c08f66202c5d6e31ff30d5bb17aafb51e928a807f59b3d4');
    const gache = { cmdId: 'fedcba9876543210fedcba9876543210', action: 'unlock', params: { durationS: 5 }, ts: 1760000000000, ttlS: 10 };
    assert.equal(signCommand(VECTOR_KEY, 'GACHE-1', gache).sig, '600b7c96c85b2c774d2e382e8a7dc9ab38bb1ff785322eb330dd2824fcf83f8f');
  });

  it('recepteur : signature falsifiee, autre actionneur, TTL depasse, date future, champ en trop : refuses', () => {
    const m = signCommand(VECTOR_KEY, 'SIR-01', { cmdId: '0123456789abcdef0123456789abcdef', action: 'on', params: { durationS: 30 }, ts: 1760000000000, ttlS: 10 });
    const raw = JSON.stringify(m);
    assert.equal(verifyCommand(VECTOR_KEY, 'SIR-01', raw, 1760000000000 + 9_999).ok, true);
    assert.deepEqual(verifyCommand(VECTOR_KEY, 'SIR-01', raw, 1760000000000 + 10_001), { ok: false, reason: 'stale' }, 'TTL depasse');
    assert.deepEqual(verifyCommand(VECTOR_KEY, 'SIR-01', raw, 1760000000000 - 5_001), { ok: false, reason: 'stale' }, 'trop dans le futur');
    assert.deepEqual(verifyCommand(VECTOR_KEY, 'SIR-02', raw, 1760000000000), { ok: false, reason: 'signature' }, "rejoue vers un autre actionneur");
    const longer = JSON.stringify({ ...m, params: { durationS: 300 } });
    assert.deepEqual(verifyCommand(VECTOR_KEY, 'SIR-01', longer, 1760000000000), { ok: false, reason: 'signature' }, 'duree allongee');
    const flipped = JSON.stringify({ ...m, sig: m.sig.replace(/.$/, (c) => (c === '0' ? '1' : '0')) });
    assert.deepEqual(verifyCommand(VECTOR_KEY, 'SIR-01', flipped, 1760000000000), { ok: false, reason: 'signature' });
    assert.deepEqual(verifyCommand(VECTOR_KEY, 'SIR-01', JSON.stringify({ ...m, extra: 1 }), 1760000000000), { ok: false, reason: 'format' });
    assert.deepEqual(verifyCommand(VECTOR_KEY, 'SIR-01', JSON.stringify({ ...m, ttlS: 3600 }), 1760000000000), { ok: false, reason: 'format' }, 'ttl hors bornes');
    assert.deepEqual(verifyCommand(VECTOR_KEY, 'SIR-01', 'x'.repeat(2000), 1760000000000), { ok: false, reason: 'format' });
  });

  it("un ordre ne vaut jamais accuse (separation des domaines), et l'inverse", () => {
    const m = signCommand(VECTOR_KEY, 'SIR-01', { cmdId: '0123456789abcdef0123456789abcdef', action: 'on', params: {}, ts: 1, ttlS: 10 });
    assert.equal(verifyAck(VECTOR_KEY, 'SIR-01', JSON.stringify({ v: 1, cmdId: m.cmdId, result: 'done', ts: 1, sig: m.sig })), null);
    const a = signAck(VECTOR_KEY, 'SIR-01', { cmdId: m.cmdId, result: 'done', ts: 1 });
    assert.ok(verifyAck(VECTOR_KEY, 'SIR-01', JSON.stringify(a)));
    assert.equal(verifyAck(VECTOR_KEY, 'SIR-02', JSON.stringify(a)), null);
    assert.equal(verifyAck(VECTOR_KEY, 'SIR-01', JSON.stringify({ ...a, result: 'refused' })), null);
  });
});

describe('actionneurs : configuration (administrateur)', () => {
  it('la cle est montree une seule fois et chiffree en base', () => {
    const { svc, db } = setup();
    const { key, actuator } = svc.create('admin', { id: 'SIR-01', name: 'Sirene hall', type: 'siren', transport: 'mqtt' });
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(actuator.actions.on.maxS, 120);
    assert.ok(!JSON.stringify(svc.list('admin')).includes(key));
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM actuator').all()).includes(key), 'jamais en clair en base');
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_log').all()).includes(key), 'jamais au journal');
    const rotated = svc.rotateKey('admin', 'SIR-01');
    assert.notEqual(rotated.key, key);
    assert.equal(rotated.keyVersion, 2);
  });

  it('bornes : plafonds par type, sans limite seulement si permis, fumigene et types inconnus refuses', () => {
    const { svc } = setup();
    assert.equal(status(() => svc.create('admin', { id: 'S1', name: 's', type: 'siren', transport: 'mqtt', actions: { on: { maxS: 601 } } })), 400);
    assert.equal(status(() => svc.create('admin', { id: 'G1', name: 'g', type: 'gate', transport: 'mqtt', actions: { open: { maxS: 10, unbounded: true } } })), 400);
    assert.equal(status(() => svc.create('admin', { id: 'R1', name: 'r', type: 'relay', transport: 'mqtt', actions: { pulse: { maxS: 11 } } })), 400);
    assert.equal(status(() => svc.create('admin', { id: 'F1', name: 'f', type: 'smoke', transport: 'mqtt' })), 400);
    assert.equal(status(() => svc.create('admin', { id: 'bad id', name: 'x', type: 'siren', transport: 'mqtt' })), 400);
    assert.equal(status(() => svc.create('admin', { id: 'S2', name: 's', type: 'siren', transport: 'mqtt', actions: { off: { maxS: 5 } } })), 400, 'action instantanee sans duree');
    // L'action sure est toujours ajoutee : arreter une sirene n'est jamais impossible.
    const v = svc.create('admin', { id: 'S3', name: 's', type: 'siren', transport: 'mqtt', actions: { on: { maxS: 30, roles: ['operator', 'admin'] } } }).actuator;
    assert.deepEqual(Object.keys(v.actions).sort(), ['off', 'on']);
    assert.equal(v.safeAction, 'off');
  });

  it("issue de secours : l'action lock est interdite, pas d'etat sur « verrouille », mot de passe toujours exige", () => {
    const { svc } = setup();
    assert.equal(status(() => svc.create('admin', { id: 'P1', name: 'p', type: 'lock', transport: 'mqtt', emergencyExit: true, actions: { unlock: {}, lock: {} } })), 400);
    const v = svc.create('admin', { id: 'P2', name: 'Issue nord', type: 'lock', transport: 'mqtt', emergencyExit: true, confirm: 'simple' }).actuator;
    assert.deepEqual(Object.keys(v.actions), ['unlock']);
    assert.equal(v.safeAction, null);
    assert.equal(v.confirm, 'reauth', 'jamais abaissable pour une serrure');
    assert.equal(status(() => svc.create('admin', { id: 'P3', name: 'p', type: 'siren', transport: 'mqtt', emergencyExit: true })), 400);
  });

  it('transport HTTP : adresses de metadonnees et noms non listes refuses a la configuration', () => {
    const { svc } = setup({ allow: [] });
    const http = (url: string) => ({ requests: { on: { method: 'POST', url: `${url}?t={durationS}` }, off: { method: 'POST', url } } });
    for (const url of ['http://169.254.169.254/latest/meta-data', 'http://metadata.google.internal/x', 'http://127.0.0.1/x', 'http://relais.local/x', 'http://[::ffff:169.254.169.254]/x', 'file:///etc/passwd', 'http://u:p@10.0.0.5/x']) {
      assert.equal(status(() => svc.create('admin', { id: 'H1', name: 'h', type: 'light', transport: 'http', http: http(url) })), 400, url);
    }
    assert.equal(status(() => svc.create('admin', { id: 'H2', name: 'h', type: 'light', transport: 'http', http: { requests: { on: { method: 'POST', url: 'http://10.0.0.5/on' }, off: { method: 'POST', url: 'http://10.0.0.6/off' } } } })), 400, 'un seul equipement');
    assert.equal(status(() => svc.create('admin', { id: 'H3', name: 'h', type: 'light', transport: 'http', http: { requests: { on: { method: 'POST', url: 'http://10.0.0.5/{evil}' }, off: { method: 'POST', url: 'http://10.0.0.5/' } } } })), 400, 'variable inconnue');
    const ok = svc.create('admin', { id: 'H4', name: 'h', type: 'light', transport: 'http', http: { requests: { on: { method: 'GET', url: 'http://192.168.1.50/relay/0?turn=on&timer={durationS}' }, off: { method: 'GET', url: 'http://192.168.1.50/relay/0?turn=off' } }, secretHeader: 'Authorization', secretValue: 'Basic c2VjcmV0' } });
    assert.equal(ok.actuator.http?.hasSecret, true);
    assert.ok(!JSON.stringify(svc.list('admin')).includes('c2VjcmV0'), 'secret jamais renvoye');
  });
});

describe('actionneurs : commandes', () => {
  function withSiren(extra: Record<string, unknown> = {}) {
    const s = setup();
    const { key } = s.svc.create('admin', { id: 'SIR-01', name: 'Sirene hall', type: 'siren', transport: 'mqtt', actions: { on: { maxS: 60 } }, ...extra });
    return { ...s, akey: key };
  }
  const ack = (s: ReturnType<typeof withSiren>, cmdId: string, result: 'done' | 'refused' | 'error' = 'done', key = s.akey, id = 'SIR-01', ts = s.clock.t) =>
    s.svc.handleAck(id, Buffer.from(JSON.stringify(signAck(key, id, { cmdId, result, ts }))));

  it('sans confirm:true, sans droit, sans duree ou hors bornes : refuse, rien ne part', () => {
    const s = withSiren({ actions: { on: { maxS: 60, roles: ['admin'] }, off: {} } });
    assert.equal(status(() => s.svc.request(ADMIN, 'SIR-01', { action: 'on', params: { durationS: 10 } })), 428);
    assert.equal(status(() => s.svc.request(ADMIN, 'SIR-01', { action: 'on', params: { durationS: 10 }, confirm: 'true' })), 428);
    assert.equal(status(() => s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 10 }, confirm: true })), 403, 'operateur sans permission');
    assert.equal(status(() => s.svc.request(ADMIN, 'SIR-01', { action: 'on', confirm: true })), 400, 'duree absente : jamais permanent');
    assert.equal(status(() => s.svc.request(ADMIN, 'SIR-01', { action: 'on', params: { durationS: 61 }, confirm: true })), 400, 'au-dela du maximum');
    assert.equal(status(() => s.svc.request(ADMIN, 'SIR-01', { action: 'on', params: { durationS: 0 }, confirm: true })), 400);
    assert.equal(status(() => s.svc.request(ADMIN, 'SIR-01', { action: 'on', params: { durationS: 1.5 }, confirm: true })), 400);
    assert.equal(status(() => s.svc.request(ADMIN, 'SIR-01', { action: 'on', params: { durationS: 5, x: 1 }, confirm: true })), 400);
    assert.equal(status(() => s.svc.request(ADMIN, 'SIR-01', { action: 'off', params: { durationS: 5 }, confirm: true })), 400);
    assert.equal(status(() => s.svc.request(ADMIN, 'SIR-01', { action: 'explode', confirm: true })), 400);
    assert.equal(status(() => s.svc.request(ADMIN, 'NOPE', { action: 'on', confirm: true })), 404);
    assert.equal(s.sent.length, 0);
    assert.equal(s.svc.request(OP, 'SIR-01', { action: 'off', confirm: true }).status, 201, "l'action sure reste permise a l'operateur");
  });

  it('sans limite seulement si un administrateur l a configure (et c est dit au journal)', () => {
    const s = withSiren({ actions: { on: { maxS: 60, unbounded: true } } });
    const r = s.svc.request(ADMIN, 'SIR-01', { action: 'on', confirm: true });
    assert.equal(r.status, 201);
    assert.equal(s.sent[0].msg.params.durationS, undefined);
    assert.match(audits(s.db, 'actionneur_cree')[0], /SANS LIMITE/);
    assert.match(audits(s.db, 'commande_demandee')[0], /sans limite de duree/);
  });

  it("journal scelle AVANT l'envoi, message signe et verifiable par l'equipement", async () => {
    const s = withSiren();
    const r = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 30 }, confirm: true, reason: 'levee de doute' });
    assert.equal(r.status, 201);
    await flush();
    assert.equal(s.sent.length, 1);
    assert.deepEqual(s.sent[0].auditBefore.slice(0, 2), ['commande_envoyee', 'commande_demandee']);
    const check = verifyCommand(s.akey, 'SIR-01', JSON.stringify(s.sent[0].msg), s.clock.t);
    assert.equal(check.ok, true);
    assert.equal(s.sent[0].msg.cmdId, r.command.cmdId);
    assert.equal(s.sent[0].msg.params.durationS, 30, "duree portee par le message : l'equipement s'arrete seul");
    assert.match(r.command.cmdId, /^[0-9a-f]{32}$/);
    assert.equal(s.svc.command(r.command.cmdId)?.state, 'sent');
    assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM audit_log').all()).includes(s.sent[0].msg.sig), 'jamais de signature au journal');
    assert.equal(verify(s.db).ok, true);
  });

  it('accuse signe valide : accusee ; refus : refusee ; erreur : echec', () => {
    const s = withSiren();
    const a = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 30 }, confirm: true }).command;
    ack(s, a.cmdId);
    assert.equal(s.svc.command(a.cmdId)?.state, 'acked');
    assert.equal(s.svc.command(a.cmdId)?.ackKind, 'signed');
    const b = s.svc.request(OP, 'SIR-01', { action: 'off', confirm: true }).command;
    ack(s, b.cmdId, 'refused');
    assert.equal(s.svc.command(b.cmdId)?.state, 'refused');
    const c = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 20 }, confirm: true }).command;
    ack(s, c.cmdId, 'error');
    assert.equal(s.svc.command(c.cmdId)?.state, 'failed');
    assert.equal(audits(s.db, 'commande_accusee').length, 1);
    assert.equal(audits(s.db, 'commande_refusee').length, 1);
  });

  it('accuses falsifies, rejoues, dates de facon impossible, pour une autre commande ou un autre actionneur : ignores', () => {
    const s = withSiren();
    const other = s.svc.create('admin', { id: 'SIR-02', name: 'Sirene 2', type: 'siren', transport: 'mqtt' });
    const a = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 30 }, confirm: true }).command;
    const b = s.svc.request(OP, 'SIR-02', { action: 'on', params: { durationS: 30 }, confirm: true }).command;
    const good = signAck(s.akey, 'SIR-01', { cmdId: a.cmdId, result: 'done', ts: s.clock.t });
    s.svc.handleAck('SIR-01', Buffer.from(JSON.stringify({ ...good, sig: '0'.repeat(64) })));
    s.svc.handleAck('SIR-01', Buffer.from(JSON.stringify({ ...good, result: 'refused' })));
    ack(s, a.cmdId, 'done', other.key); // cle d'un autre actionneur
    ack(s, b.cmdId, 'done', s.akey, 'SIR-01'); // commande d'un autre actionneur, cle de celui-ci
    ack(s, 'ffffffffffffffffffffffffffffffff'); // commande inconnue
    ack(s, a.cmdId, 'done', s.akey, 'SIR-01', s.clock.t - 60_000); // anterieur a l'ordre
    ack(s, a.cmdId, 'done', s.akey, 'SIR-01', s.clock.t + 60_000); // futur
    s.svc.handleAck('SIR-01', Buffer.from('{"v":1}'));
    s.svc.handleAck('SIR-01', Buffer.alloc(5000, 0x20));
    assert.equal(s.svc.command(a.cmdId)?.state, 'sent');
    assert.equal(s.svc.command(b.cmdId)?.state, 'sent');
    assert.equal(audits(s.db, 'commande_accuse_invalide').length, 1, 'journalise une fois par minute au plus');
    ack(s, a.cmdId);
    assert.equal(s.svc.command(a.cmdId)?.state, 'acked');
    const ackedAt = s.svc.command(a.cmdId)?.ackedAt;
    s.clock.t += 1000;
    ack(s, a.cmdId, 'error'); // rejeu / second accuse : sans effet
    assert.equal(s.svc.command(a.cmdId)?.state, 'acked');
    assert.equal(s.svc.command(a.cmdId)?.ackedAt, ackedAt);
  });

  it("sans accuse a l'echeance : echec « execution incertaine » ; l'accuse tardif est journalise sans reecrire l'etat", () => {
    const s = withSiren({ ackTimeoutS: 5 });
    const a = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 60 }, confirm: true }).command;
    s.clock.t += 4_999;
    s.svc.tick();
    assert.equal(s.svc.command(a.cmdId)?.state, 'sent');
    s.clock.t += 2;
    s.svc.tick();
    const failed = s.svc.command(a.cmdId)!;
    assert.equal(failed.state, 'failed');
    assert.equal(failed.uncertain, true);
    assert.equal(audits(s.db, 'commande_echec').length, 1);
    assert.ok(s.events.some((e) => e.type === 'command' && e.command.cmdId === a.cmdId && e.command.state === 'failed'), 'visible en direct');
    ack(s, a.cmdId);
    const late = s.svc.command(a.cmdId)!;
    assert.equal(late.state, 'failed', 'jamais d histoire reecrite');
    assert.equal(late.lateAck, 'done');
    assert.equal(audits(s.db, 'commande_accuse_tardif').length, 1);
  });

  it("retour automatique a l'etat sur a la fin de la duree, meme sans accuse", async () => {
    const s = withSiren();
    const a = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 30 }, confirm: true }).command;
    s.clock.t += 30_000;
    s.svc.tick();
    assert.equal(s.sent.length, 1);
    s.clock.t += 1_001;
    s.svc.tick();
    await flush();
    assert.equal(s.sent.length, 2);
    assert.equal(s.sent[1].msg.action, 'off');
    assert.equal(s.sent[1].msg.params.durationS, undefined);
    const parent = s.svc.command(a.cmdId)!;
    assert.equal(parent.offCmdId, s.sent[1].msg.cmdId);
    const off = s.svc.command(s.sent[1].msg.cmdId)!;
    assert.equal(off.auto, true);
    assert.equal(off.requestedBy, 'systeme');
    s.clock.t += 60_000;
    s.svc.tick();
    assert.equal(s.sent.length, 2, 'un seul retour');
  });

  it('dedoublonnage : un double-clic ne reemet rien ; limite de 4 commandes par minute', () => {
    const s = withSiren();
    const first = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 10 }, confirm: true });
    const again = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 10 }, confirm: true });
    assert.equal(again.status, 200);
    assert.equal(again.deduplicated, true);
    assert.equal(again.command.cmdId, first.command.cmdId);
    assert.equal(s.sent.length, 1);
    for (const d of [11, 12, 13]) s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: d }, confirm: true });
    assert.equal(status(() => s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 14 }, confirm: true })), 429);
    assert.equal(s.svc.request(ADMIN, 'SIR-01', { action: 'on', params: { durationS: 14 }, confirm: true }).status, 201, 'par utilisateur');
    assert.equal(s.svc.request(OP, 'SIR-01', { action: 'off', confirm: true }).status, 201, "l'arret n'est pas bloque par la limite");
    s.clock.t += 60_001;
    assert.equal(s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 15 }, confirm: true }).status, 201);
  });

  it("mode maintenance : tout est refuse SAUF l'action sure ; les retours prevus sont annules ; actionneur inactif ; liaison coupee", () => {
    const s = withSiren();
    s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 10 }, confirm: true });
    assert.equal(status(() => s.svc.setLock(OP.username, true, 'x')), 0, 'le service ne juge pas le role : la route est adminOnly');
    assert.equal(status(() => s.svc.request(ADMIN, 'SIR-01', { action: 'on', params: { durationS: 20 }, confirm: true })), 409);
    s.clock.t += 20_000;
    s.svc.tick();
    assert.equal(s.sent.length, 1, 'aucun retour automatique en mode maintenance');
    assert.equal(s.svc.request(ADMIN, 'SIR-01', { action: 'off', confirm: true }).status, 201, "l'action sure (arreter) reste permise sous verrou");
    s.svc.setLock('admin', false, 'fin des travaux');
    s.svc.update('admin', 'SIR-01', { active: false });
    assert.equal(status(() => s.svc.request(ADMIN, 'SIR-01', { action: 'off', confirm: true })), 409);
    s.svc.update('admin', 'SIR-01', { active: true });
    s.link.up = 0;
    assert.equal(status(() => s.svc.request(ADMIN, 'SIR-01', { action: 'off', confirm: true })), 409, 'liaison coupee');
    assert.equal(audits(s.db, 'commandes_verrouillees').length, 1);
  });

  it('serrure : raison et mot de passe exiges ; mauvais mot de passe journalise ; reverrouiller reste immediat', () => {
    const s = setup();
    s.svc.create('admin', { id: 'GACHE-1', name: 'Gache accueil', type: 'lock', transport: 'mqtt' });
    assert.equal(status(() => s.svc.request(OP, 'GACHE-1', { action: 'unlock', params: { durationS: 5 }, confirm: true, password: OP_PW })), 428, 'sans raison');
    assert.equal(status(() => s.svc.request(OP, 'GACHE-1', { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'livreur' })), 428, 'sans mot de passe');
    assert.equal(status(() => s.svc.request(OP, 'GACHE-1', { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'livreur', password: 'faux-mot-de-passe' })), 403);
    assert.equal(audits(s.db, 'commande_reauth_echec').length, 1);
    assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM audit_log').all()).includes('faux-mot-de-passe'));
    assert.equal(status(() => s.svc.request(OP, 'GACHE-1', { action: 'unlock', params: { durationS: 11 }, confirm: true, reason: 'livreur', password: OP_PW })), 400, 'impulsion 1 a 10 s');
    assert.equal(s.svc.request(OP, 'GACHE-1', { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'livreur', password: OP_PW }).status, 201);
    assert.equal(s.svc.request(OP, 'GACHE-1', { action: 'lock', confirm: true }).status, 201, 'reverrouiller : ni raison ni mot de passe');
    for (let i = 0; i < 5; i++) status(() => s.svc.request(ADMIN, 'GACHE-1', { action: 'unlock', params: { durationS: 3 }, confirm: true, reason: 'x', password: 'mauvais' }));
    assert.equal(status(() => s.svc.request(ADMIN, 'GACHE-1', { action: 'unlock', params: { durationS: 3 }, confirm: true, reason: 'x', password: ADMIN_PW })), 429, 'force brute du mot de passe bornee');
  });

  it("issue de secours : jamais « lock », meme si la base a ete modifiee a la main", () => {
    const s = setup();
    // Compte neuf : le compteur de mots de passe faux (en memoire, par compte) ne doit pas venir d'un autre essai.
    createUser(s.db, 'chef', 'admin', ADMIN_PW);
    const CHEF = { username: 'chef', role: 'admin' as const };
    s.svc.create('admin', { id: 'ISSUE-1', name: 'Issue nord', type: 'lock', transport: 'mqtt', emergencyExit: true });
    s.db.prepare(`UPDATE actuator SET actions = ? WHERE id = 'ISSUE-1'`).run(JSON.stringify({ unlock: { minS: 1, maxS: 10, roles: ['operator', 'admin'] }, lock: { roles: ['operator', 'admin'] } }));
    assert.equal(status(() => s.svc.request(CHEF, 'ISSUE-1', { action: 'lock', confirm: true, reason: 'x', password: ADMIN_PW })), 403);
    assert.equal(s.sent.length, 0);
    // Deverrouiller : pas de retour automatique (la gache se referme seule, cote equipement).
    s.svc.request(CHEF, 'ISSUE-1', { action: 'unlock', params: { durationS: 5 }, confirm: true, reason: 'evacuation', password: ADMIN_PW });
    s.clock.t += 10_000;
    s.svc.tick();
    assert.equal(s.sent.length, 1);
  });

  it("incident clos : commandes en cours ramenees a l'etat sur ; annulation par l'operateur", async () => {
    const s = setup({ demo: true });
    s.svc.create('admin', { id: 'SIR-01', name: 'Sirene', type: 'siren', transport: 'mqtt' });
    s.engine.handleDetectorMessage('D-01', { state: 'alarm' });
    const incident = s.engine.getSnapshot().incidents[0];
    const a = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 100 }, confirm: true, incidentId: incident.id }).command;
    s.engine.handleDetectorMessage('D-01', { state: 'normal' });
    s.engine.close(incident.id, 'op', 'false_alarm', null);
    s.svc.incidentChanged(incident.id, 'closed');
    await flush();
    assert.equal(s.sent.length, 2);
    assert.equal(s.sent[1].msg.action, 'off');
    assert.equal(s.svc.command(a.cmdId)?.cancelledBy, 'systeme');
    assert.equal(status(() => s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 10 }, confirm: true, incidentId: incident.id })), 409);
    // Annulation manuelle d'une commande en cours = arret anticipe.
    const b = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 50 }, confirm: true }).command;
    const res = s.svc.cancel(OP, b.cmdId);
    assert.equal(res.stop?.action, 'off');
    assert.equal(status(() => s.svc.cancel(OP, b.cmdId)), 409, 'deja arretee');
  });

  it('redemarrage : les commandes en vol expirent, aucune n est renvoyee ; les retours a l etat sur sont replanifies', async () => {
    const s = withSiren();
    const a = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 30 }, confirm: true }).command;
    const sentBefore = s.sent.length;
    // Second service sur la meme base (le PSIM redemarre) : nouvelle liaison, rien ne doit partir au demarrage.
    const restarted: Buffer[] = [];
    const svc2 = createActuators({ db: s.db, key: s.key, audit: s.engine.audit, publish: () => {}, httpAllow: parseAllowList([]), now: () => s.clock.t });
    svc2.attachMqtt({ listeners: () => 1, publishCommand: async (_id, p) => void restarted.push(p) });
    assert.equal(svc2.command(a.cmdId)?.state, 'expired');
    assert.match(audits(s.db, 'commande_expiree')[0], /jamais renvoyee/);
    svc2.tick();
    await flush();
    assert.equal(restarted.length, 0);
    assert.equal(s.sent.length, sentBefore);
    s.clock.t += 31_001;
    svc2.tick();
    await flush();
    assert.equal(restarted.length, 1);
    assert.equal((JSON.parse(restarted[0].toString()) as CommandMessage).action, 'off', "seul le retour a l'etat sur part");
  });

  it('suppression : refusee tant qu une commande est en vol ; historique conserve', () => {
    const s = withSiren();
    const a = s.svc.request(OP, 'SIR-01', { action: 'on', params: { durationS: 30 }, confirm: true }).command;
    assert.equal(status(() => s.svc.remove('admin', 'SIR-01')), 409);
    ack(s, a.cmdId);
    s.svc.remove('admin', 'SIR-01');
    assert.equal(s.svc.history('SIR-01').length, 1);
    s.clock.t += 40_000;
    s.svc.tick();
    assert.equal(s.sent.length, 1, 'pas de retour pour un actionneur supprime');
  });
});

describe('transport HTTP : SSRF, un seul essai, accuse = 2xx', () => {
  it('adresses : metadonnees, lien local, boucle locale par defaut refusees ; reseau prive accepte', () => {
    const none = parseAllowList([]);
    for (const ip of ['169.254.169.254', '::ffff:169.254.169.254', '100.100.100.200', 'fd00:ec2::254', 'fe80::1', '0.0.0.0', '127.0.0.1', '::1', '224.0.0.1', '255.255.255.255', '8.8.8.8']) {
      assert.equal(addressAllowed(ip, none, false), false, ip);
    }
    for (const ip of ['10.1.2.3', '172.16.0.9', '192.168.1.50', 'fd12::5']) assert.equal(addressAllowed(ip, none, false), true, ip);
    assert.notEqual(urlProblem('http://0x7f.1/x', none), null, 'ecriture detournee de 127.0.0.1');
    assert.notEqual(urlProblem('http://2130706433/x', none), null);
    const list = parseAllowList(['127.0.0.1', '10.20.0.0/16', 'relais.site']);
    assert.equal(addressAllowed('127.0.0.1', list, false), true);
    assert.equal(addressAllowed('127.0.0.2', list, false), false);
    assert.equal(addressAllowed('10.20.3.4', list, false), true);
    assert.equal(addressAllowed('10.21.3.4', list, false), false);
    assert.equal(addressAllowed('169.254.169.254', list, true), false, 'meme par un nom autorise');
    assert.throws(() => parseAllowList(['metadata.google.internal']));
    assert.throws(() => parseAllowList(['0.0.0.0/0']));
  });

  it("un nom autorise qui se resout vers la boucle locale est refuse a la connexion (pas de contournement DNS)", async () => {
    const relay = await startHttpRelay('ok');
    try {
      const out = await sendHttp({ requests: { on: { method: 'GET', url: `http://localhost:${relay.port}/on` } } }, 'on', {}, null, parseAllowList(['localhost']), 2000);
      assert.equal(out.kind, 'not_delivered');
      assert.equal(relay.requests.length, 0);
    } finally {
      await relay.close();
    }
  });

  it('200 : accusee (http) ; 500 et redirection : echec, jamais suivie ni rejouee ; pas de reponse : echec incertain', async () => {
    const relay = await startHttpRelay('ok');
    const s = setup({ allow: ['127.0.0.1'] });
    try {
      const base = `http://127.0.0.1:${relay.port}`;
      s.svc.create('admin', {
        id: 'REL-1',
        name: 'Relais portail',
        type: 'relay',
        transport: 'http',
        ackTimeoutS: 1,
        http: { requests: { on: { method: 'POST', url: `${base}/relay/0?turn=on&timer={durationS}`, body: '{"cmd":"{cmdId}","sig":"{sig}"}' }, off: { method: 'GET', url: `${base}/relay/0?turn=off` }, pulse: { method: 'GET', url: `${base}/pulse?s={durationS}` } }, secretHeader: 'Authorization', secretValue: 'Basic c2VjcmV0' },
      });
      const wait = async (cmdId: string) => {
        for (let i = 0; i < 100; i++) {
          const st = s.svc.command(cmdId)!.state;
          if (st !== 'sent') return s.svc.command(cmdId)!;
          await new Promise((r) => setTimeout(r, 20));
        }
        return s.svc.command(cmdId)!;
      };
      const a = s.svc.request(OP, 'REL-1', { action: 'on', params: { durationS: 30 }, confirm: true }).command;
      const done = await wait(a.cmdId);
      assert.equal(done.state, 'acked');
      assert.equal(done.ackKind, 'http');
      assert.equal(relay.requests.length, 1);
      assert.equal(relay.requests[0].url, '/relay/0?turn=on&timer=30');
      assert.equal(relay.requests[0].headers.authorization, 'Basic c2VjcmV0');
      assert.match(relay.requests[0].body, new RegExp(a.cmdId));
      assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM audit_log').all()).includes('secret-dans-la-reponse'), 'reponse jamais journalisee');

      relay.mode = 'error';
      const b = await wait(s.svc.request(OP, 'REL-1', { action: 'pulse', params: { durationS: 2 }, confirm: true }).command.cmdId);
      assert.equal(b.state, 'failed');
      assert.equal(b.uncertain, false);
      relay.mode = 'redirect';
      const c = await wait(s.svc.request(OP, 'REL-1', { action: 'pulse', params: { durationS: 3 }, confirm: true }).command.cmdId);
      assert.equal(c.state, 'failed');
      relay.mode = 'hang';
      const d = await wait(s.svc.request(ADMIN, 'REL-1', { action: 'pulse', params: { durationS: 4 }, confirm: true }).command.cmdId);
      assert.equal(d.state, 'failed');
      assert.equal(d.uncertain, true, "envoyee, accuse non recu : l'ordre a pu etre execute");
      assert.equal(relay.requests.length, 4, 'un seul essai par commande, jamais rejoue');
    } finally {
      await relay.close();
    }
  });

  it('relais injoignable : non remise (certain), pas incertaine', async () => {
    const relay = await startHttpRelay('ok');
    const port = relay.port;
    await relay.close();
    const out = await sendHttp({ requests: { on: { method: 'GET', url: `http://127.0.0.1:${port}/` } } }, 'on', {}, null, parseAllowList(['127.0.0.1']), 1000);
    assert.equal(out.kind, 'not_delivered');
  });
});

describe('migration', () => {
  it('base ancienne (sans tables de commandes) rouverte deux fois : tables ajoutees, donnees et journal intacts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-act-mig-'));
    dirs.push(dir);
    const file = join(dir, 'psim.db');
    const old = openDb(file);
    seedDemo(old, dir, join(import.meta.dirname, '..', 'seed'));
    createEngine(old, () => {}).handleDetectorMessage('D-02', { state: 'alarm' });
    old.exec('DROP TABLE actuator; DROP TABLE actuator_command; DROP TABLE actuator_lock;');
    const before = (old.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    old.close();
    for (const pass of [1, 2]) {
      const db = openDb(file);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'actuator%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
      assert.deepEqual(tables, ['actuator', 'actuator_command', 'actuator_lock'], `passage ${pass}`);
      assert.deepEqual((db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((r) => r.integrity_check), ['ok']);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n, before);
      assert.equal(verify(db).ok, true);
      db.close();
    }
  });
});
