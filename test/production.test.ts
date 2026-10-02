import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { createBackup, listBackups, pruneBackups, restoreBackup, verifyBackup } from '../server/backup.ts';
import { openDb } from '../server/db.ts';
import { acquireLock, lockHolder } from '../server/lock.ts';
import { installFileLogger, rotate } from '../server/logger.ts';
import { preflight } from '../server/preflight.ts';
import type { PreflightInput } from '../server/preflight.ts';
import { createHttpRedirect, createWebServer } from '../server/tls.ts';

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `psim-${prefix}-`));

// ---------------------------------------------------------------- controle de demarrage

const GOOD: PreflightInput = {
  production: true,
  host: '127.0.0.1',
  mqttHost: '127.0.0.1',
  tlsEnabled: false,
  mqttTlsEnabled: false,
  trustProxy: false,
  cookieSecure: false,
  simEnabled: false,
  demoLogin: false,
  adminPassword: 'Un-vrai-mot-de-passe-1',
  operatorPassword: 'Un-autre-mot-de-passe-2',
  mqttPassword: 'Mot-de-passe-MQTT-3',
  notificationChannels: 2,
  escalationConfigured: true,
  detectorTimeoutS: 180,
  backupEveryH: 24,
  requireTotp: 'admin',
};
const errors = (c: PreflightInput) => preflight(c).filter((f) => f.level === 'error').map((f) => f.message);

describe('controle de demarrage (preflight)', () => {
  it('une configuration saine ne souleve aucun probleme', () => {
    assert.deepEqual(preflight(GOOD), []);
  });

  it('refuse en production les mots de passe de demonstration, courts ou identiques', () => {
    assert.match(errors({ ...GOOD, adminPassword: 'admin-dev-only' }).join(' '), /administrateur : valeur de demonstration/);
    assert.match(errors({ ...GOOD, operatorPassword: 'operator-dev-only' }).join(' '), /operateur/);
    assert.match(errors({ ...GOOD, mqttPassword: 'psim-dev-only' }).join(' '), /MQTT/);
    assert.match(errors({ ...GOOD, adminPassword: 'court' }).join(' '), /trop court/);
    assert.match(errors({ ...GOOD, operatorPassword: GOOD.adminPassword }).join(' '), /identiques/);
  });

  it('refuse en production le simulateur et les comptes cliquables', () => {
    assert.match(errors({ ...GOOD, simEnabled: true }).join(' '), /simulateur/i);
    assert.match(errors({ ...GOOD, demoLogin: true }).join(' '), /cliquables/);
  });

  it("refuse d'exposer l'interface au reseau sans HTTPS, accepte HTTPS ou un proxy", () => {
    assert.match(errors({ ...GOOD, host: '0.0.0.0' }).join(' '), /sans HTTPS/);
    assert.deepEqual(errors({ ...GOOD, host: '0.0.0.0', tlsEnabled: true }), []);
    assert.deepEqual(errors({ ...GOOD, host: '0.0.0.0', trustProxy: true, cookieSecure: true }), []);
    assert.deepEqual(errors({ ...GOOD, host: 'localhost' }), []);
  });

  it('avertit pour un MQTT sans TLS sur le reseau, des notifications absentes, une surveillance coupee', () => {
    const w = (c: PreflightInput) => preflight(c).filter((f) => f.level === 'warn').map((f) => f.message).join(' | ');
    assert.match(w({ ...GOOD, mqttHost: '0.0.0.0' }), /MQTT ecoute sur 0\.0\.0\.0 sans TLS/);
    assert.equal(w({ ...GOOD, mqttHost: '0.0.0.0', mqttTlsEnabled: true }), '');
    assert.match(w({ ...GOOD, notificationChannels: 0 }), /Aucun canal de notification/);
    assert.match(w({ ...GOOD, escalationConfigured: false }), /niveau 2/);
    assert.match(w({ ...GOOD, detectorTimeoutS: 0 }), /detecteurs muets desactivee/);
    assert.match(w({ ...GOOD, backupEveryH: 0 }), /Sauvegarde automatique desactivee/);
    assert.match(w({ ...GOOD, requireTotp: 'none' }), /double authentification n'est imposee a personne/);
  });

  it("hors production, les memes constats ne sont que des avertissements : le developpement reste possible", () => {
    const dev = preflight({ ...GOOD, production: false, adminPassword: 'admin-dev-only', simEnabled: true, host: '0.0.0.0' });
    assert.equal(dev.filter((f) => f.level === 'error').length, 0);
    assert.ok(dev.filter((f) => f.level === 'warn').length >= 3);
  });
});

// ---------------------------------------------------------------- journaux

describe('journaux fichier', () => {
  it('copie console.log/warn/error dans psim.log, horodate, et se restaure', () => {
    const dir = tmp('log');
    const original = console.log;
    const restore = installFileLogger({ dir, now: () => Date.UTC(2026, 9, 2, 12, 0, 0) });
    assert.notEqual(console.log, original, 'console.log est detournee pendant la journalisation');
    console.log('demarrage');
    console.warn('attention %s', 'ici');
    console.error('ligne 1\nligne 2');
    restore();
    assert.equal(console.log, original, 'console.log est restauree');
    const text = readFileSync(join(dir, 'psim.log'), 'utf8').split('\n');
    assert.match(text[0], /^2026-10-02T12:00:00\.000Z INFO  demarrage$/);
    assert.match(text[1], /WARN  attention ici$/);
    assert.match(text[2], /ERROR ligne 1$/);
    assert.match(text[3], /ERROR ligne 2$/, 'chaque ligne est horodatee');
  });

  it('fait tourner les fichiers par taille et en garde un nombre borne', () => {
    const dir = tmp('rot');
    const restore = installFileLogger({ dir, maxBytes: 200, files: 3 });
    for (let i = 0; i < 60; i++) console.log(`message numero ${i} avec du remplissage pour grossir`);
    restore();
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ['psim.1.log', 'psim.2.log', 'psim.log'], 'trois fichiers au plus');
    assert.match(readFileSync(join(dir, 'psim.log'), 'utf8'), /message numero 59/, 'le plus recent est dans psim.log');
  });

  it("rotate() ne plante pas sur un dossier vide", () => {
    assert.doesNotThrow(() => rotate(tmp('empty'), 3));
  });
});

// ---------------------------------------------------------------- verrou d'instance

describe('verrou d\'instance unique', () => {
  it('empeche une seconde instance sur les memes donnees, et se libere', () => {
    const dir = tmp('lock');
    const release = acquireLock(dir, process.pid);
    assert.equal(lockHolder(dir), process.pid);
    assert.throws(() => acquireLock(dir, process.pid + 100_000), /Un autre PSIM utilise deja/);
    release();
    assert.equal(lockHolder(dir), null);
    release(); // idempotent
    assert.doesNotThrow(() => acquireLock(dir, process.pid + 100_000)());
  });

  it("ignore un verrou orphelin laisse par un processus disparu", () => {
    const dir = tmp('orphan');
    writeFileSync(join(dir, 'psim.lock'), '2147483000'); // PID inexistant
    assert.equal(lockHolder(dir), null);
    assert.doesNotThrow(() => acquireLock(dir)());
  });
});

// ---------------------------------------------------------------- sauvegarde / restauration

function dataDirWithContent() {
  const dataDir = tmp('data');
  const db = openDb(join(dataDir, 'psim.db'));
  db.exec("INSERT INTO site (id, name, plan_file) VALUES (1, 'Site test', 'plan-1.svg')");
  writeFileSync(join(dataDir, 'plan-1.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  mkdirSync(join(dataDir, 'snapshots'));
  writeFileSync(join(dataDir, 'snapshots', '1.jpg'), Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]));
  writeFileSync(join(dataDir, 'snapshots', 'pas-une-image.txt'), 'ignore');
  writeFileSync(join(dataDir, 'secret.key'), 'a'.repeat(64));
  writeFileSync(join(dataDir, 'journal-prive.log'), 'ne doit pas etre sauvegarde');
  return { dataDir, db };
}

describe('sauvegarde', () => {
  it('copie la base (a chaud, de facon coherente), les plans et les images, avec un manifeste verifiable', () => {
    const { dataDir, db } = dataDirWithContent();
    const backupDir = tmp('bk');
    const b = createBackup({ db, dataDir, backupDir, now: () => Date.UTC(2026, 9, 2, 12, 0, 0) });
    assert.match(b.name, /^psim-\d{8}-\d{6}$/);
    assert.deepEqual(readdirSync(b.dir).sort(), ['manifest.json', 'plan-1.svg', 'psim.db', 'snapshots']);
    assert.deepEqual(readdirSync(join(b.dir, 'snapshots')), ['1.jpg'], "seules les images attendues");
    assert.equal(b.includesKey, false, 'la cle n\'est pas incluse par defaut');
    assert.equal(verifyBackup(b.dir).ok, true);
    const copy = new DatabaseSync(join(b.dir, 'psim.db'), { readOnly: true });
    assert.equal((copy.prepare('SELECT name FROM site').get() as { name: string }).name, 'Site test');
    copy.close();
  });

  it("une ecriture posterieure n'altere pas la sauvegarde deja faite", () => {
    const { dataDir, db } = dataDirWithContent();
    const b = createBackup({ db, dataDir, backupDir: tmp('bk') });
    db.exec("UPDATE site SET name = 'Modifie apres'");
    const copy = new DatabaseSync(join(b.dir, 'psim.db'), { readOnly: true });
    assert.equal((copy.prepare('SELECT name FROM site').get() as { name: string }).name, 'Site test');
    copy.close();
    assert.equal(verifyBackup(b.dir).ok, true);
  });

  it('inclut la cle seulement sur demande', () => {
    const { dataDir, db } = dataDirWithContent();
    const b = createBackup({ db, dataDir, backupDir: tmp('bk'), includeKey: true });
    assert.equal(b.includesKey, true);
    assert.ok(existsSync(join(b.dir, 'secret.key')));
  });

  it('deux sauvegardes dans la meme seconde ne se marchent pas dessus', () => {
    const { dataDir, db } = dataDirWithContent();
    const backupDir = tmp('bk');
    const now = () => Date.UTC(2026, 9, 2, 12, 0, 0);
    const a = createBackup({ db, dataDir, backupDir, now });
    const b = createBackup({ db, dataDir, backupDir, now });
    assert.notEqual(a.name, b.name);
    assert.equal(listBackups(backupDir).length, 2);
  });

  it("ne laisse jamais une sauvegarde a moitie ecrite en cas d'echec", () => {
    const { dataDir } = dataDirWithContent();
    const backupDir = tmp('bk');
    const closed = openDb(':memory:');
    closed.close();
    assert.throws(() => createBackup({ db: closed, dataDir, backupDir }));
    assert.deepEqual(readdirSync(backupDir), []);
  });
});

describe('verification d\'une sauvegarde', () => {
  const make = () => {
    const { dataDir, db } = dataDirWithContent();
    return createBackup({ db, dataDir, backupDir: tmp('bk') }).dir;
  };

  it('detecte un fichier altere ou manquant', () => {
    const dir = make();
    writeFileSync(join(dir, 'plan-1.svg'), '<svg>modifie</svg>');
    assert.match(verifyBackup(dir).problems.join(' '), /fichier altere : plan-1\.svg/);
    const dir2 = make();
    writeFileSync(join(dir2, 'snapshots', '1.jpg'), 'x');
    assert.equal(verifyBackup(dir2).ok, false);
    const dir3 = make();
    writeFileSync(join(dir3, 'psim.db'), 'pas une base');
    assert.equal(verifyBackup(dir3).ok, false);
  });

  it("refuse un dossier qui n'est pas une sauvegarde, ou un manifeste qui pointe hors du dossier", () => {
    assert.match(verifyBackup(tmp('vide')).problems[0], /pas une sauvegarde/);
    const dir = make();
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    manifest.files.push({ path: '../../secret', size: 1, sha256: 'x' });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    assert.match(verifyBackup(dir).problems.join(' '), /chemin suspect/);
  });
});

describe('retention', () => {
  it('ne garde que les N plus recentes, et ne touche a rien d\'autre dans le dossier', () => {
    const { dataDir, db } = dataDirWithContent();
    const backupDir = tmp('bk');
    mkdirSync(join(backupDir, 'mes-notes'));
    writeFileSync(join(backupDir, 'mes-notes', 'important.txt'), 'a garder');
    for (let i = 0; i < 5; i++) createBackup({ db, dataDir, backupDir, now: () => Date.UTC(2026, 9, 1 + i, 12, 0, 0) });
    const removed = pruneBackups(backupDir, 2);
    assert.equal(removed.length, 3);
    assert.deepEqual(listBackups(backupDir).map((b) => b.name.slice(5, 13)), ['20261005', '20261004'], 'garde les plus recentes');
    assert.ok(existsSync(join(backupDir, 'mes-notes', 'important.txt')), 'un dossier etranger n\'est jamais supprime');
    assert.deepEqual(pruneBackups(backupDir, 0), [], '0 = conservation illimitee');
  });
});

describe('restauration', () => {
  it("remet les donnees, met l'ancien dossier de cote (jamais supprime) et conserve la cle", () => {
    const { dataDir, db } = dataDirWithContent();
    const backup = createBackup({ db, dataDir, backupDir: tmp('bk') }).dir; // sans cle
    db.exec("UPDATE site SET name = 'Etat apres la sauvegarde'");
    db.close();

    const result = restoreBackup({ backupDir: backup, dataDir, now: () => Date.UTC(2026, 9, 2, 13, 0, 0) });
    assert.ok(result.previousMovedTo && existsSync(join(result.previousMovedTo, 'psim.db')), "l'ancien etat est rattrapable");
    assert.match(result.previousMovedTo!, /\.before-restore-/);
    const restored = new DatabaseSync(join(dataDir, 'psim.db'), { readOnly: true });
    assert.equal((restored.prepare('SELECT name FROM site').get() as { name: string }).name, 'Site test');
    restored.close();
    assert.ok(existsSync(join(dataDir, 'plan-1.svg')) && existsSync(join(dataDir, 'snapshots', '1.jpg')));
    assert.equal(readFileSync(join(dataDir, 'secret.key'), 'utf8'), 'a'.repeat(64), 'la cle precedente est reprise');
    assert.equal(result.keyKept, true);
  });

  it('refuse si le PSIM tourne, sans rien toucher', () => {
    const { dataDir, db } = dataDirWithContent();
    const backup = createBackup({ db, dataDir, backupDir: tmp('bk') }).dir;
    db.close();
    const release = acquireLock(dataDir);
    assert.throws(() => restoreBackup({ backupDir: backup, dataDir }), /Le PSIM tourne/);
    assert.ok(existsSync(join(dataDir, 'psim.db')), 'donnees intactes');
    release();
  });

  it('refuse une sauvegarde alteree, sans rien toucher', () => {
    const { dataDir, db } = dataDirWithContent();
    const backup = createBackup({ db, dataDir, backupDir: tmp('bk') }).dir;
    db.close();
    writeFileSync(join(backup, 'plan-1.svg'), 'corrompu');
    assert.throws(() => restoreBackup({ backupDir: backup, dataDir }), /Sauvegarde invalide/);
    assert.ok(existsSync(join(dataDir, 'psim.db')));
    const base = dataDir.split(/[\\/]/).pop()!;
    assert.equal(readdirSync(join(dataDir, '..')).filter((n) => n.startsWith(base) && n.includes('before-restore')).length, 0, 'rien deplace');
  });

  it('restaure aussi vers un dossier vide (nouvelle machine)', () => {
    const { dataDir, db } = dataDirWithContent();
    const backup = createBackup({ db, dataDir, backupDir: tmp('bk'), includeKey: true }).dir;
    const fresh = join(tmp('new'), 'data');
    const result = restoreBackup({ backupDir: backup, dataDir: fresh });
    assert.equal(result.previousMovedTo, null);
    assert.ok(existsSync(join(fresh, 'psim.db')) && existsSync(join(fresh, 'secret.key')));
  });
});

// ---------------------------------------------------------------- HTTPS

const OPENSSL = (() => {
  for (const bin of ['openssl', 'D:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/usr/bin/openssl.exe']) {
    if (spawnSync(bin, ['version'], { stdio: 'ignore' }).status === 0) return bin;
  }
  return null;
})();

function selfSigned(): { cert: string; key: string; pem: string } {
  const dir = tmp('tls');
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  const r = spawnSync(OPENSSL!, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'pipe' });
  assert.equal(r.status, 0, String(r.stderr));
  return { cert, key, pem: readFileSync(cert, 'utf8') };
}

describe('HTTPS integre', { skip: OPENSSL ? false : 'openssl introuvable' }, () => {
  it('sert en HTTPS avec le certificat fourni, et refuse TLS 1.1 et en dessous', async () => {
    const files = selfSigned();
    const server = createWebServer((_req, res) => res.end('bonjour'), files);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const body = await new Promise<string>((resolve, reject) => {
      httpsRequest({ host: '127.0.0.1', port, path: '/', ca: files.pem, servername: 'localhost' }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve(text));
      }).on('error', reject).end();
    });
    assert.equal(body, 'bonjour');
    const legacy = await new Promise<string>((resolve) => {
      httpsRequest({ host: '127.0.0.1', port, ca: files.pem, servername: 'localhost', maxVersion: 'TLSv1.1' as never }, () => resolve('accepte')).on('error', (e) => resolve(`refuse : ${(e as NodeJS.ErrnoException).code ?? e.message}`)).end();
    });
    assert.match(legacy, /refuse/);
    server.close();
  });

  it('refuse un certificat sans HTTPS valide : une erreur claire plutot qu\'un demarrage en clair', () => {
    assert.throws(() => createWebServer(() => {}, { cert: '/inexistant/cert.pem', key: '/inexistant/key.pem' }), /Certificat TLS illisible/);
  });
});

describe('redirection HTTP -> HTTPS', () => {
  async function get(port: number, headers: Record<string, string>, path = '/api/x?y=1') {
    return new Promise<{ status: number; location: string | undefined }>((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => resolve({ status: res.statusCode!, location: res.headers.location })).on('error', reject).end();
    });
  }

  it('redirige vers HTTPS en gardant le chemin, et ignore un en-tete Host suspect', async () => {
    const server = createHttpRedirect(8443, 'psim.exemple.fr');
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    assert.deepEqual(await get(port, { Host: 'psim.local:80' }), { status: 308, location: 'https://psim.local:8443/api/x?y=1' });
    assert.equal((await get(port, { Host: 'evil.com/@x' })).location, 'https://psim.exemple.fr:8443/api/x?y=1', 'hote invalide : repli sur l\'hote configure');
    assert.equal((await get(port, { Host: 'a@b.c' })).location, 'https://psim.exemple.fr:8443/api/x?y=1');
    server.close();
    const standard = createHttpRedirect(443, 'x.test');
    await new Promise<void>((r) => standard.listen(0, '127.0.0.1', r));
    assert.equal((await get((standard.address() as AddressInfo).port, { Host: 'psim.local' })).location, 'https://psim.local/api/x?y=1', 'port 443 omis');
    standard.close();
  });
});

// ---------------------------------------------------------------- controle de sante

describe('controle de sante (healthcheck)', () => {
  it('compte les echecs CONSECUTIFS et ne redemarre qu\'au seuil', async () => {
    const { nextState } = await import('../scripts/healthcheck.ts');
    let s = { failures: 0, restart: false };
    const seen: boolean[] = [];
    for (const healthy of [false, false, true, false, false, false]) {
      s = nextState(s.failures, healthy, 3);
      seen.push(s.restart);
    }
    assert.deepEqual(seen, [false, false, false, false, false, true], 'un succes remet le compteur a zero');
    assert.equal(nextState(99, false, 0).restart, false, '0 = jamais de redemarrage automatique');
  });

  it('interprete la reponse de /healthz : sain, degrade, muet, injoignable', async () => {
    const { probe } = await import('../scripts/healthcheck.ts');
    const { createServer: createHttp } = await import('node:http');
    let mode: 'ok' | 'degraded' | 'silent' = 'ok';
    const server = createHttp((_req, res) => {
      if (mode === 'silent') return; // ne repond jamais : PSIM bloque
      res.writeHead(mode === 'ok' ? 200 : 503).end(JSON.stringify({ status: mode }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`;
    assert.equal((await probe(url)).ok, true);
    mode = 'degraded';
    const degraded = await probe(url);
    assert.equal(degraded.ok, false);
    assert.match(degraded.detail, /HTTP 503/);
    mode = 'silent';
    const silent = await probe(url, undefined, 300);
    assert.equal(silent.ok, false);
    assert.match(silent.detail, /aucune reponse/);
    server.closeAllConnections();
    server.close();
    const down = await probe('http://127.0.0.1:1/healthz');
    assert.equal(down.ok, false);
    assert.match(down.detail, /ECONNREFUSED/);
  });
});
