import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import {
  checkCertificates, checkDatabase, checkHttps, checkListen, checkLive, checkPublicUrl, fetchAgentCert, skipDatabaseChecks,
} from '../scripts/check-agents/checks.ts';
import type { Check } from '../scripts/commission/checks.ts';
import { findOpenssl } from '../scripts/lib/cert.ts';

const DAY = 86_400_000;
const openssl = findOpenssl();
const work = mkdtempSync(join(tmpdir(), 'check-agents-'));
after(() => rmSync(work, { recursive: true, force: true }));
const byId = (checks: Check[], id: string): Check => checks.find((c) => c.id === id)!;

// ---------------------------------------------------------------- adresse et ecoute (sans OpenSSL)

describe('adresse publique', () => {
  it('vide, http, localhost : echec', () => {
    assert.equal(checkPublicUrl('').status, 'fail');
    assert.equal(checkPublicUrl('   ').status, 'fail');
    assert.equal(checkPublicUrl('http://192.168.1.10:3000').status, 'fail');
    assert.equal(checkPublicUrl('https://localhost:3000').status, 'fail');
    assert.equal(checkPublicUrl('https://127.0.0.1:3000').status, 'fail');
    assert.equal(checkPublicUrl('https://[::1]:3000').status, 'fail');
    assert.equal(checkPublicUrl('pas une adresse').status, 'fail');
  });
  it('nom NetBIOS sans point : avertissement ; IP ou nom complet : ok', () => {
    const w = checkPublicUrl('https://DESKTOP-ABC123:3000');
    assert.equal(w.status, 'warn');
    assert.match(w.fix ?? '', /adresse IP fixe/);
    assert.equal(checkPublicUrl('https://192.168.1.10:3000').status, 'ok');
    assert.equal(checkPublicUrl('https://psim.exemple.fr').status, 'ok');
  });
});

describe('ecoute sur le reseau', () => {
  it('boucle locale : echec ; sinon ok avec adresse:port', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1']) assert.equal(checkListen(h, 3000).status, 'fail');
    assert.match(checkListen('127.0.0.1', 3000).fix ?? '', /PSIM_HOST=0\.0\.0\.0/);
    const ok = checkListen('0.0.0.0', 3000);
    assert.equal(ok.status, 'ok');
    assert.equal(ok.detail, '0.0.0.0:3000');
  });
});

describe('HTTPS actif sans certificat', () => {
  it('rien de configure : echec ; proxy : avertissement et controles de certificat ignores', () => {
    assert.equal(checkHttps({ cert: '', key: '', trustProxy: false }).status, 'fail');
    assert.equal(checkHttps({ cert: 'a.pem', key: '', trustProxy: false }).status, 'fail');
    const proxy = { cert: '', key: '', trustProxy: true };
    assert.equal(checkHttps(proxy).status, 'warn');
    assert.match(checkHttps(proxy).detail, /proxy/);
    const skipped = checkCertificates({ ...proxy, publicUrl: 'https://192.168.1.10' });
    assert.deepEqual(skipped.map((c) => [c.id, c.status]), [['cert-ca', 'skip'], ['cert-names', 'skip']]);
  });
  it('fichiers introuvables : echec', () => {
    assert.equal(checkHttps({ cert: join(work, 'absent.pem'), key: join(work, 'absent.key'), trustProxy: false }).status, 'fail');
    assert.equal(byId(checkCertificates({ cert: join(work, 'absent.pem'), key: 'k', trustProxy: false, publicUrl: '' }), 'cert-ca').status, 'fail');
  });
});

// ---------------------------------------------------------------- base de donnees (sans OpenSSL)

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE floor (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, position INTEGER NOT NULL, plan_file TEXT, plan_version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE app_user (username TEXT PRIMARY KEY, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE agent_profile (username TEXT PRIMARY KEY, display_name TEXT NOT NULL);
    CREATE TABLE agent_phone (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, paired_at INTEGER, revoked_at INTEGER);
    CREATE TABLE checkpoint (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, floor_id INTEGER NOT NULL, x REAL NOT NULL DEFAULT 50, y REAL NOT NULL DEFAULT 50, archived_at INTEGER);
    CREATE TABLE patrol_route (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, checkpoints TEXT NOT NULL, archived_at INTEGER);
  `);
  return db;
}

/** Une base complete et saine : tout est ok. */
function healthyDb(): DatabaseSync {
  const db = makeDb();
  db.exec(`
    INSERT INTO floor (name, position, plan_file) VALUES ('RDC', 0, 'plan-1.png');
    INSERT INTO app_user VALUES ('agent1', 'agent', 1);
    INSERT INTO agent_profile VALUES ('agent1', 'Awa');
    INSERT INTO agent_phone (label, paired_at) VALUES ('Tel 1', 1000);
    INSERT INTO checkpoint (name, floor_id) VALUES ('Hall', 1), ('Cour', 1);
    INSERT INTO patrol_route (name, checkpoints) VALUES ('Soir', '[1,2]');
  `);
  return db;
}

describe('controles de la base', () => {
  it('base saine : cinq controles ok', () => {
    const checks = checkDatabase(healthyDb());
    assert.deepEqual(checks.map((c) => c.id), ['plan', 'agents', 'phones', 'routes', 'checkpoints']);
    assert.deepEqual(checks.map((c) => c.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
  });

  it('base vide : plan, agents, telephones, circuits et points en echec, avec la marche a suivre', () => {
    const checks = checkDatabase(makeDb());
    assert.ok(checks.every((c) => c.status === 'fail'), JSON.stringify(checks.map((c) => c.status)));
    assert.match(byId(checks, 'agents').fix ?? '', /Rondes > Agents/);
    assert.ok(checks.every((c) => c.fix));
  });

  it('plan : un etage sans image ne compte pas', () => {
    const db = healthyDb();
    db.exec('UPDATE floor SET plan_file = NULL');
    assert.equal(byId(checkDatabase(db), 'plan').status, 'fail');
    db.exec("UPDATE floor SET plan_file = ''");
    assert.equal(byId(checkDatabase(db), 'plan').status, 'fail');
  });

  it('agents : un compte desactive ou un compte non agent ne compte pas', () => {
    const db = healthyDb();
    db.exec("UPDATE app_user SET active = 0");
    assert.equal(byId(checkDatabase(db), 'agents').status, 'fail');
    db.exec("UPDATE app_user SET active = 1, role = 'operator'");
    assert.equal(byId(checkDatabase(db), 'agents').status, 'fail');
  });

  it('telephones : aucun -> echec ; cree mais non appaire -> avertissement ; revoque ne compte pas', () => {
    const db = healthyDb();
    db.exec('UPDATE agent_phone SET paired_at = NULL');
    assert.equal(byId(checkDatabase(db), 'phones').status, 'warn');
    db.exec('UPDATE agent_phone SET revoked_at = 5');
    assert.equal(byId(checkDatabase(db), 'phones').status, 'fail');
    db.exec('DELETE FROM agent_phone');
    assert.equal(byId(checkDatabase(db), 'phones').status, 'fail');
  });

  it('circuits : un circuit archive ne compte pas', () => {
    const db = healthyDb();
    db.exec('UPDATE patrol_route SET archived_at = 9');
    assert.equal(byId(checkDatabase(db), 'routes').status, 'fail');
  });

  it("points : tous archives -> echec ; un point actif non place -> avertissement avec son nom", () => {
    const db = healthyDb();
    db.exec("INSERT INTO floor (name, position) VALUES ('Sous-sol sans plan', 1)");
    db.exec("INSERT INTO checkpoint (name, floor_id) VALUES ('Parking', 2)");
    const warn = byId(checkDatabase(db), 'checkpoints');
    assert.equal(warn.status, 'warn');
    assert.match(warn.detail, /Parking/);
    db.exec('UPDATE checkpoint SET archived_at = 1');
    assert.equal(byId(checkDatabase(db), 'checkpoints').status, 'fail');
  });

  it("points : un point non place archive n'alerte pas ; plus de 5 points non places sont abreges", () => {
    const db = healthyDb();
    db.exec("INSERT INTO floor (name, position) VALUES ('Sans plan', 1)");
    db.exec("INSERT INTO checkpoint (name, floor_id, archived_at) VALUES ('Ancien', 2, 1)");
    assert.equal(byId(checkDatabase(db), 'checkpoints').status, 'ok');
    for (let i = 1; i <= 7; i++) db.exec(`INSERT INTO checkpoint (name, floor_id) VALUES ('Point-${i}', 2)`);
    const w = byId(checkDatabase(db), 'checkpoints');
    assert.equal(w.status, 'warn');
    assert.match(w.detail, /7 point\(s\)/);
    assert.match(w.detail, /Point-5\.\.\./);
    assert.doesNotMatch(w.detail, /Point-6/);
  });

  it('points : un circuit actif qui passe par un point non place -> avertissement', () => {
    const db = healthyDb();
    db.exec("INSERT INTO floor (name, position) VALUES ('Sans plan', 1)");
    db.exec("INSERT INTO checkpoint (name, floor_id) VALUES ('Parking', 2)");
    db.exec("UPDATE patrol_route SET checkpoints = '[1,3]'");
    const w = byId(checkDatabase(db), 'checkpoints');
    assert.equal(w.status, 'warn');
    assert.match(w.detail, /circuit.*Soir/);
    // liste illisible : pas d'exception
    db.exec("UPDATE patrol_route SET checkpoints = 'pas du json'");
    assert.equal(byId(checkDatabase(db), 'checkpoints').status, 'warn'); // seul le point non place reste signale
  });

  it("base ancienne (table absente) : echec lisible, pas d'exception", () => {
    const db = new DatabaseSync(':memory:');
    const checks = checkDatabase(db);
    assert.equal(checks.length, 5);
    assert.ok(checks.every((c) => c.status === 'fail' && /migre la base/.test(c.fix ?? '')));
  });

  it('base absente : les cinq controles sont ignores', () => {
    const checks = skipDatabaseChecks();
    assert.equal(checks.length, 5);
    assert.ok(checks.every((c) => c.status === 'skip' && /lancer le PSIM une fois/.test(c.detail)));
  });
});

// ---------------------------------------------------------------- certificats (OpenSSL requis)

const ssl = (args: string[]): void => {
  const r = spawnSync(openssl!, args, { encoding: 'utf8' });
  assert.equal(r.status, 0, `openssl ${args.join(' ')} : ${r.stderr}`);
};

interface Pki {
  /** Fichier « certificat du serveur + autorite » */
  chain: string;
  key: string;
  caPem: string;
}

/** Petite autorite de test + certificat de serveur signe par elle. */
function makePki(name: string, o: { caDays?: number; hosts?: string[]; caAsOtherCa?: boolean } = {}): Pki {
  const dir = join(work, name);
  mkdirSync(dir);
  const f = (n: string) => join(dir, n);
  ssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', f('ca.key'), '-out', f('ca.pem'), '-days', String(o.caDays ?? 1000),
    '-subj', '/CN=Autorite de test', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  ssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', f('server.key'), '-out', f('server.csr'), '-subj', '/CN=serveur']);
  const san = (o.hosts ?? ['192.168.1.10']).map((h) => (/^[\d.]+$/.test(h) ? `IP:${h}` : `DNS:${h}`)).join(',');
  writeFileSync(f('ext.cnf'), `basicConstraints=CA:FALSE\nsubjectAltName=${san}\n`);
  ssl(['x509', '-req', '-in', f('server.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f('server.pem'), '-days', '800', '-extfile', f('ext.cnf')]);
  const caPem = readFileSync(f('ca.pem'), 'utf8');
  writeFileSync(f('chain.pem'), readFileSync(f('server.pem'), 'utf8') + caPem);
  return { chain: f('chain.pem'), key: f('server.key'), caPem };
}

/** Ancien mode : un seul certificat auto-signe (avec CA:TRUE, comme `openssl req -x509`). */
function makeSelfSigned(name: string, host: string): Pki {
  const dir = join(work, name);
  mkdirSync(dir);
  const f = (n: string) => join(dir, n);
  ssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', f('key.pem'), '-out', f('cert.pem'), '-days', '800',
    '-subj', '/CN=psim', '-addext', `subjectAltName=IP:${host}`, '-addext', 'basicConstraints=critical,CA:TRUE']);
  return { chain: f('cert.pem'), key: f('key.pem'), caPem: readFileSync(f('cert.pem'), 'utf8') };
}

/** Certificat de serveur seul, non signe en tant qu'autorite. */
function makeLeafOnly(name: string): Pki {
  const pki = makePki(name);
  const dir = join(work, name);
  const server = readFileSync(join(dir, 'server.pem'), 'utf8');
  writeFileSync(join(dir, 'leaf.pem'), server);
  return { chain: join(dir, 'leaf.pem'), key: pki.key, caPem: pki.caPem };
}

const skipSsl = openssl ? false : 'OpenSSL introuvable';

describe('certificats (OpenSSL)', { skip: skipSsl }, () => {
  const tls = (p: Pki) => ({ cert: p.chain, key: p.key, trustProxy: false });

  it('chaine saine : HTTPS ok, autorite ok avec sa date, adresse couverte', () => {
    const p = makePki('sain');
    assert.equal(checkHttps(tls(p)).status, 'ok');
    const checks = checkCertificates({ ...tls(p), publicUrl: 'https://192.168.1.10:3000' });
    assert.equal(byId(checks, 'cert-ca').status, 'ok');
    assert.match(byId(checks, 'cert-ca').detail, /valable jusqu'au/);
    assert.equal(byId(checks, 'cert-names').status, 'ok');
  });

  it('cle qui ne correspond pas : echec', () => {
    const a = makePki('cle-a');
    const b = makePki('cle-b');
    const r = checkHttps({ cert: a.chain, key: b.key, trustProxy: false });
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /cle privee/);
  });

  it('certificat du serveur expire : echec ; proche de son terme : avertissement', () => {
    const p = makePki('expire');
    assert.equal(checkHttps(tls(p), Date.now() + 900 * DAY).status, 'fail');
    assert.equal(checkHttps(tls(p), Date.now() + 790 * DAY).status, 'warn');
  });

  it('autorite expiree : echec ; moins de 90 jours : avertissement', () => {
    const p = makePki('ca-courte', { caDays: 60 });
    const now = Date.now();
    const soon = byId(checkCertificates({ ...tls(p), publicUrl: 'https://192.168.1.10' }, now), 'cert-ca');
    assert.equal(soon.status, 'warn');
    assert.match(soon.detail, /dans \d+ jours/);
    assert.equal(byId(checkCertificates({ ...tls(p), publicUrl: 'https://192.168.1.10' }, now + 100 * DAY), 'cert-ca').status, 'fail');
  });

  it('ancien mode (un seul certificat auto-signe) : installable mais avertissement de reinstallation', () => {
    const p = makeSelfSigned('ancien', '192.168.1.10');
    assert.equal(checkHttps(tls(p)).status, 'ok');
    const ca = byId(checkCertificates({ ...tls(p), publicUrl: 'https://192.168.1.10' }), 'cert-ca');
    assert.equal(ca.status, 'warn');
    assert.match(ca.detail, /reinstaller sur chaque telephone/);
    assert.match(ca.detail, /dans \d+ jours/);
  });

  it('certificat de serveur seul (sans autorite) : echec avec make-cert', () => {
    const p = makeLeafOnly('feuille');
    const ca = byId(checkCertificates({ ...tls(p), publicUrl: 'https://192.168.1.10' }), 'cert-ca');
    assert.equal(ca.status, 'fail');
    assert.match(ca.fix ?? '', /npm run make-cert -- <adresse-IP> <nom> \(voir docs\/ESSAI-AGENTS-KOUROUMA\.md\)/);
  });

  it("serveur signe par une autre autorite que celle du fichier : echec", () => {
    const a = makePki('chaine-a');
    const b = makePki('chaine-b');
    const mixed = join(work, 'melange.pem');
    writeFileSync(mixed, readFileSync(join(work, 'chaine-a', 'server.pem'), 'utf8') + b.caPem);
    const ca = byId(checkCertificates({ cert: mixed, key: a.key, trustProxy: false, publicUrl: 'https://192.168.1.10' }), 'cert-ca');
    assert.equal(ca.status, 'fail');
    assert.match(ca.detail, /pas signe par l'autorite/);
  });

  it("adresse publique absente du certificat : echec ; nom DNS couvert : ok ; sans adresse : ignore", () => {
    const p = makePki('noms', { hosts: ['192.168.1.10', 'psim.local'] });
    const run = (publicUrl: string) => byId(checkCertificates({ ...tls(p), publicUrl }), 'cert-names');
    assert.equal(run('https://192.168.1.10:3000').status, 'ok');
    assert.equal(run('https://psim.local:3000').status, 'ok');
    const bad = run('https://192.168.1.99:3000');
    assert.equal(bad.status, 'fail');
    assert.match(bad.fix ?? '', /make-cert -- --force 192\.168\.1\.99/);
    assert.equal(run('https://autre.local').status, 'fail');
    assert.equal(run('').status, 'skip');
  });

  it('aucun secret dans les messages (la cle privee n\'apparait jamais)', () => {
    const p = makePki('secret');
    const all = [checkHttps(tls(p)), ...checkCertificates({ ...tls(p), publicUrl: 'https://192.168.1.10' })];
    const keyBody = readFileSync(p.key, 'utf8').split('\n')[1];
    assert.ok(all.every((c) => !JSON.stringify(c).includes(keyBody)));
  });
});

// ---------------------------------------------------------------- --live

describe('controle --live', () => {
  it('sans adresse publique : ignore', async () => {
    assert.equal((await checkLive({ publicUrl: '', certFile: 'x' })).status, 'skip');
  });

  it('injoignable (port ferme) : ignore avec un message clair', async () => {
    const free = await new Promise<number>((r) => {
      const s = createNetServer();
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => r(port));
      });
    });
    const r = await checkLive({ publicUrl: `https://127.0.0.1:${free}`, certFile: 'x' });
    assert.equal(r.status, 'skip');
    assert.match(r.detail, /injoignable/);
  });

  describe('avec OpenSSL', { skip: skipSsl }, () => {
    it('autorite identique : ok ; autre autorite : echec ; reponse qui n\'est pas une autorite : echec', async () => {
      const a = makePki('live-a');
      const b = makePki('live-b');
      const same = await checkLive({ publicUrl: 'https://x', certFile: a.chain, fetchCert: async () => a.caPem });
      assert.equal(same.status, 'ok');
      const other = await checkLive({ publicUrl: 'https://x', certFile: a.chain, fetchCert: async () => b.caPem });
      assert.equal(other.status, 'fail');
      assert.match(other.fix ?? '', /Redemarrer/);
      const notCa = await checkLive({ publicUrl: 'https://x', certFile: a.chain, fetchCert: async () => '<html>autre chose</html>' });
      assert.equal(notCa.status, 'fail');
    });

    it('vrai echange HTTPS avec certificat non verifie : lit /api/agent-cert et compare', async () => {
      const a = makePki('live-reel');
      const server = createServer({ cert: readFileSync(a.chain), key: readFileSync(a.key) }, (req, res) => {
        if (req.url === '/api/agent-cert') res.writeHead(200, { 'content-type': 'application/x-pem-file' }).end(a.caPem);
        else res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      try {
        const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
        assert.equal((await fetchAgentCert(url)).trim(), a.caPem.trim());
        const r = await checkLive({ publicUrl: url, certFile: a.chain });
        assert.equal(r.status, 'ok');
        const wrong = await checkLive({ publicUrl: url, certFile: makePki('live-autre').chain });
        assert.equal(wrong.status, 'fail');
      } finally {
        server.close();
        server.closeAllConnections();
      }
    });
  });
});
