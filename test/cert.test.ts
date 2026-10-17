import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { connect } from 'node:tls';
import type { DetailedPeerCertificate } from 'node:tls';
import { findOpenssl, generateCert, generateSiteCert } from '../scripts/lib/cert.ts';
import { certificateBlocks, isSelfSigned, pickPhoneCa } from '../server/cert-info.ts';

const SKIP = findOpenssl() ? false : 'openssl introuvable';
const DAY = 86_400_000;
const HOSTS = ['psim.test', '192.168.1.10'];

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'psim-cert-test-'));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const read = (p: string): X509Certificate => new X509Certificate(readFileSync(p));
const days = (c: X509Certificate): number => (new Date(c.validTo).getTime() - new Date(c.validFrom).getTime()) / DAY;
/** Les entrees du SAN, sans le libelle « IP Address: ». */
const san = (c: X509Certificate): string[] => (c.subjectAltName ?? '').split(/,\s*/).map((e) => e.replace('IP Address:', 'IP:')).sort();

// Un site partage entre les tests de lecture (generer une autorite RSA 3072 prend un moment).
const shared = SKIP ? null : tmp();
const first = SKIP ? null : generateSiteCert({ hosts: HOSTS, dir: shared! });

describe('generateSiteCert : autorite locale et certificat du serveur', { skip: SKIP }, () => {
  it("cree l'autorite, le certificat du serveur et leurs cles dans le dossier, sans rien laisser d'autre", () => {
    assert.equal(first!.caCreated, true);
    assert.deepEqual(readdirSync(shared!).sort(), ['ca-key.pem', 'ca.pem', 'cert.pem', 'key.pem']);
    assert.deepEqual([first!.cert, first!.key, first!.ca, first!.caKey], ['cert.pem', 'key.pem', 'ca.pem', 'ca-key.pem'].map((f) => join(shared!, f)));
  });

  it("l'autorite : CA:TRUE, ~10 ans, sujet distinct de celui du serveur, auto-signee, cle privee jointe", () => {
    const ca = read(first!.ca);
    const leaf = read(first!.cert);
    assert.equal(ca.ca, true);
    assert.ok(Math.abs(days(ca) - 3650) <= 1, `duree ${days(ca)}`);
    assert.match(ca.subject, /CN=PSIM Autorite locale \(psim\.test\)/);
    assert.notEqual(ca.subject, leaf.subject);
    assert.equal(isSelfSigned(ca), true);
    assert.equal(ca.checkPrivateKey(createPrivateKey(readFileSync(first!.caKey))), true);
    assert.equal(ca.publicKey.asymmetricKeyDetails?.modulusLength, 3072);
  });

  it("l'autorite porte des extensions explicites : basicConstraints critique pathlen:0, keyCertSign, subjectKeyIdentifier", () => {
    const r = openssl(['x509', '-in', first!.ca, '-noout', '-text']);
    assert.match(r, /X509v3 Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
    assert.match(r, /X509v3 Key Usage: critical\s+Certificate Sign, CRL Sign/);
    assert.match(r, /X509v3 Subject Key Identifier/);
  });

  it('le certificat du serveur : CA:FALSE, 825 jours au plus, SAN exact, serverAuth, signe par l\'autorite', () => {
    const leaf = read(first!.cert);
    const ca = read(first!.ca);
    assert.equal(leaf.ca, false);
    assert.ok(days(leaf) <= 825 && days(leaf) > 800, `duree ${days(leaf)}`);
    assert.match(leaf.subject, /CN=psim\.test/);
    assert.deepEqual(san(leaf), ['DNS:localhost', 'DNS:psim.test', 'IP:127.0.0.1', 'IP:192.168.1.10']);
    assert.deepEqual(leaf.keyUsage, ['1.3.6.1.5.5.7.3.1']);
    assert.equal(leaf.checkIssued(ca), true);
    assert.equal(leaf.verify(ca.publicKey), true);
    assert.equal(leaf.verify(leaf.publicKey), false, 'pas auto-signe');
    assert.equal(leaf.publicKey.asymmetricKeyDetails?.modulusLength, 2048);
    assert.equal(leaf.issuer, ca.subject);
    const r = openssl(['x509', '-in', first!.cert, '-noout', '-text']);
    assert.match(r, /X509v3 Basic Constraints: critical\s+CA:FALSE/);
    assert.match(r, /X509v3 Key Usage: critical\s+Digital Signature, Key Encipherment/);
    assert.match(r, /Authority Key Identifier/);
  });

  it('cert.pem : feuille puis autorite (deux certificats), jamais une cle ; la cle du serveur correspond ; ca-key.pem n\'est dans aucun fichier public', () => {
    const chain = readFileSync(first!.cert, 'utf8');
    const blocks = certificateBlocks(chain);
    assert.equal(blocks.length, 2);
    assert.equal(new X509Certificate(blocks[0]).fingerprint256, read(first!.cert).fingerprint256);
    assert.equal(new X509Certificate(blocks[0]).ca, false);
    assert.equal(new X509Certificate(blocks[1]).fingerprint256, read(first!.ca).fingerprint256);
    assert.ok(!chain.includes('PRIVATE KEY'));
    assert.ok(!readFileSync(first!.ca, 'utf8').includes('PRIVATE KEY'));
    assert.equal(read(first!.cert).checkPrivateKey(createPrivateKey(readFileSync(first!.key))), true);
    const caKeyPem = readFileSync(first!.caKey, 'utf8');
    const body = caKeyPem.split('\n').slice(1, 4).join('');
    assert.ok(!chain.includes(body) && !readFileSync(first!.key, 'utf8').includes(body));
  });

  it('deux generations donnent des numeros de serie differents', () => {
    const other = generateSiteCert({ hosts: ['a.test'], dir: tmp() });
    assert.notEqual(read(other.cert).serialNumber, read(first!.cert).serialNumber);
    assert.notEqual(read(other.ca).serialNumber, read(first!.ca).serialNumber);
  });

  it("refuse de remplacer un certificat existant sans `force`, sans rien modifier", () => {
    const before = readFileSync(first!.cert);
    assert.throws(() => generateSiteCert({ hosts: HOSTS, dir: shared! }), /existe deja/);
    assert.throws(() => generateSiteCert({ hosts: HOSTS, dir: shared!, newCa: true }), /existe deja/);
    assert.deepEqual(readFileSync(first!.cert), before);
    assert.deepEqual(readdirSync(shared!).sort(), ['ca-key.pem', 'ca.pem', 'cert.pem', 'key.pem']);
  });

  it("refuse un nom invalide ou une liste vide, sans creer de fichier", () => {
    const dir = tmp();
    assert.throws(() => generateSiteCert({ hosts: ['mauvais host!'], dir }), /invalide/);
    assert.throws(() => generateSiteCert({ hosts: ['ok.test', 'a;b'], dir }), /invalide/);
    assert.throws(() => generateSiteCert({ hosts: [], dir }), /Au moins un nom/);
    assert.deepEqual(readdirSync(dir), []);
  });

  it("`force` renouvelle le certificat du serveur et GARDE l'autorite (meme empreinte, cle intacte)", () => {
    const dir = tmp();
    const a = generateSiteCert({ hosts: HOSTS, dir });
    const caBefore = readFileSync(a.ca);
    const caKeyBefore = readFileSync(a.caKey);
    const leafBefore = read(a.cert).fingerprint256;
    const b = generateSiteCert({ hosts: [...HOSTS, 'autre.test'], dir, force: true });
    assert.equal(b.caCreated, false);
    assert.deepEqual(readFileSync(b.ca), caBefore);
    assert.deepEqual(readFileSync(b.caKey), caKeyBefore);
    assert.equal(read(b.ca).fingerprint256, read(a.ca).fingerprint256);
    assert.notEqual(read(b.cert).fingerprint256, leafBefore);
    assert.ok(san(read(b.cert)).includes('DNS:autre.test'));
    // le nouveau certificat est bien signe par l'ancienne autorite, et la chaine l'embarque
    assert.equal(read(b.cert).verify(read(a.ca).publicKey), true);
    assert.equal(certificateBlocks(readFileSync(b.cert, 'utf8')).length, 2);
    assert.equal(new X509Certificate(certificateBlocks(readFileSync(b.cert, 'utf8'))[1]).fingerprint256, read(a.ca).fingerprint256);
    assert.deepEqual(readdirSync(dir).sort(), ['ca-key.pem', 'ca.pem', 'cert.pem', 'key.pem']);
  });

  it("`newCa` (avec `force`) regenere aussi l'autorite : nouvelle empreinte, nouvelle cle, chaine coherente", () => {
    const dir = tmp();
    const a = generateSiteCert({ hosts: HOSTS, dir });
    const oldCa = read(a.ca); // a.ca et b.ca sont le meme fichier : on garde l'ancien en memoire
    const caBefore = oldCa.fingerprint256;
    const caKeyBefore = readFileSync(a.caKey, 'utf8');
    const b = generateSiteCert({ hosts: HOSTS, dir, force: true, newCa: true });
    assert.equal(b.caCreated, true);
    assert.notEqual(read(b.ca).fingerprint256, caBefore);
    assert.notEqual(readFileSync(b.caKey, 'utf8'), caKeyBefore);
    assert.equal(read(b.cert).verify(read(b.ca).publicKey), true);
    assert.equal(read(b.cert).verify(oldCa.publicKey), false, "plus signe par l'ancienne autorite");
  });

  it("le certificat du serveur ne depasse jamais 825 jours, ni la fin de validite de l'autorite", () => {
    const dir = tmp();
    const a = generateSiteCert({ hosts: HOSTS, dir, days: 5000, caDays: 100 });
    assert.ok(Math.abs(days(read(a.ca)) - 100) <= 1);
    assert.ok(days(read(a.cert)) <= 100, `duree ${days(read(a.cert))}`);
    const renewed = generateSiteCert({ hosts: HOSTS, dir, force: true });
    assert.equal(renewed.caCreated, false);
    assert.ok(days(read(renewed.cert)) <= 100, `renouvelement : ${days(read(renewed.cert))}`);
    assert.ok(new Date(read(renewed.cert).validTo) <= new Date(read(renewed.ca).validTo), 'fin de validite <= celle de l\'autorite');
    const long = generateSiteCert({ hosts: HOSTS, dir: tmp(), days: 5000 });
    assert.ok(days(read(long.cert)) <= 825);
    const short = generateSiteCert({ hosts: HOSTS, dir: tmp(), days: 30 });
    assert.ok(Math.abs(days(read(short.cert)) - 30) <= 1);
  });

  it('une autorite incoherente (cle qui ne correspond pas) ou illisible est refusee, sans rien modifier', () => {
    const dir = tmp();
    const a = generateSiteCert({ hosts: HOSTS, dir });
    const other = generateSiteCert({ hosts: ['x.test'], dir: tmp() });
    writeFileSync(a.caKey, readFileSync(other.caKey));
    const certBefore = readFileSync(a.cert);
    assert.throws(() => generateSiteCert({ hosts: HOSTS, dir, force: true }), /autorite exploitable/);
    assert.deepEqual(readFileSync(a.cert), certBefore);
    writeFileSync(a.ca, 'pas un certificat');
    assert.throws(() => generateSiteCert({ hosts: HOSTS, dir, force: true }), /--nouvelle-autorite/);
    // la reparation prevue fonctionne
    const fixed = generateSiteCert({ hosts: HOSTS, dir, force: true, newCa: true });
    assert.equal(fixed.caCreated, true);
    assert.equal(read(fixed.cert).verify(read(fixed.ca).publicKey), true);
  });

  it("une autorite incomplete (cle seule ou certificat seul) est recreee plutot que d'echouer", () => {
    const dir = tmp();
    const a = generateSiteCert({ hosts: HOSTS, dir });
    rmSync(a.caKey);
    const b = generateSiteCert({ hosts: HOSTS, dir, force: true });
    assert.equal(b.caCreated, true);
    assert.equal(read(b.ca).checkPrivateKey(createPrivateKey(readFileSync(b.caKey))), true);
  });

  it("un echec de signature ne laisse aucun etat a moitie ecrit (ni autorite, ni dossier de travail)", () => {
    const dir = tmp();
    // 999.1.1.1 est pris pour une IP : OpenSSL refuse cette extension au moment de signer, apres avoir cree l'autorite
    assert.throws(() => generateSiteCert({ hosts: ['999.1.1.1'], dir }), /Echec d'OpenSSL/);
    assert.deepEqual(readdirSync(dir), []);
    // avec un certificat et une autorite existants : tout reste en l'etat
    const a = generateSiteCert({ hosts: HOSTS, dir });
    const snapshot = ['cert.pem', 'key.pem', 'ca.pem', 'ca-key.pem'].map((f) => readFileSync(join(dir, f)));
    assert.throws(() => generateSiteCert({ hosts: ['999.1.1.1'], dir, force: true, newCa: true }), /Echec d'OpenSSL/);
    assert.deepEqual(['cert.pem', 'key.pem', 'ca.pem', 'ca-key.pem'].map((f) => readFileSync(join(dir, f))), snapshot);
    assert.deepEqual(readdirSync(dir).sort(), ['ca-key.pem', 'ca.pem', 'cert.pem', 'key.pem']);
    assert.equal(a.caCreated, true);
  });

  it("n'utilise pas le openssl.cnf de la machine : un fichier de configuration piege n'a aucun effet", () => {
    const trap = join(tmp(), 'piege.cnf');
    writeFileSync(trap, 'openssl_conf = nope\n[nope]\nunknown_section = missing\n');
    const before = process.env.OPENSSL_CONF;
    process.env.OPENSSL_CONF = trap;
    try {
      const r = generateSiteCert({ hosts: ['piege.test'], dir: tmp() });
      assert.equal(read(r.ca).ca, true);
      assert.equal(read(r.cert).ca, false);
    } finally {
      if (before === undefined) delete process.env.OPENSSL_CONF;
      else process.env.OPENSSL_CONF = before;
    }
  });

  it("le dedoublonnage du SAN : 127.0.0.1 et localhost passes explicitement n'apparaissent qu'une fois", () => {
    const r = generateSiteCert({ hosts: ['localhost', '127.0.0.1'], dir: tmp() });
    assert.deepEqual(san(read(r.cert)), ['DNS:localhost', 'IP:127.0.0.1']);
    assert.deepEqual(r.names, ['DNS:localhost', 'IP:127.0.0.1']);
  });
});

describe('generateSiteCert : un vrai echange TLS', { skip: SKIP }, () => {
  const tlsCase = (host: string, servername?: string) =>
    new Promise<{ authorized: boolean; error: string | null; chain: string[] }>((resolve, reject) => {
      const server = createServer({ cert: readFileSync(first!.cert), key: readFileSync(first!.key) }, (_req, res) => res.end('ok'));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        const socket = connect({ host, port, ca: readFileSync(first!.ca), servername, rejectUnauthorized: false }, () => {
          const chain: string[] = [];
          for (let c: DetailedPeerCertificate | undefined = socket.getPeerCertificate(true) as DetailedPeerCertificate; c && c.fingerprint256; ) {
            chain.push(c.fingerprint256);
            const next: DetailedPeerCertificate | undefined = c.issuerCertificate;
            if (!next || next === c || next.fingerprint256 === c.fingerprint256) break;
            c = next;
          }
          const out = { authorized: socket.authorized, error: socket.authorizationError ? String(socket.authorizationError) : null, chain };
          socket.destroy();
          server.close(() => resolve(out));
        });
        socket.on('error', (e) => {
          server.close();
          reject(e);
        });
      });
    });

  it("un client qui ne connait QUE l'autorite accepte le serveur (adresse IP du certificat)", async () => {
    const r = await tlsCase('127.0.0.1');
    assert.equal(r.authorized, true, r.error ?? '');
    assert.deepEqual(r.chain, [read(first!.cert).fingerprint256, read(first!.ca).fingerprint256], 'chaine complete : feuille puis autorite');
  });

  it('... et pour un nom du certificat (SNI)', async () => {
    const r = await tlsCase('127.0.0.1', 'psim.test');
    assert.equal(r.authorized, true, r.error ?? '');
    const r2 = await tlsCase('127.0.0.1', 'localhost');
    assert.equal(r2.authorized, true, r2.error ?? '');
  });

  it("un nom absent du certificat est refuse", async () => {
    const r = await tlsCase('127.0.0.1', 'intrus.test');
    assert.equal(r.authorized, false);
    assert.match(r.error ?? '', /ALTNAME_INVALID|altnames|Hostname/i);
  });

  it("le serveur envoie bien toute la chaine (un client qui ne fait confiance a rien la voit)", async () => {
    const server = createServer({ cert: readFileSync(first!.cert), key: readFileSync(first!.key) }, (_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const fingerprints = await new Promise<string[]>((resolve, reject) => {
        // sans verification : la chaine lue est celle que le serveur a envoyee (pas reconstituee depuis un magasin de confiance)
        const socket = connect({ host: '127.0.0.1', port, rejectUnauthorized: false, ca: [] }, () => {
          const leaf = socket.getPeerCertificate(true) as DetailedPeerCertificate;
          const out = [leaf.fingerprint256, leaf.issuerCertificate?.fingerprint256 ?? ''];
          socket.destroy();
          resolve(out);
        });
        socket.on('error', reject);
      });
      assert.deepEqual(fingerprints, [read(first!.cert).fingerprint256, read(first!.ca).fingerprint256]);
    } finally {
      server.close();
    }
  });

  it("un client qui ne connait pas l'autorite refuse le serveur", async () => {
    const other = generateSiteCert({ hosts: ['x.test'], dir: tmp() });
    const server = createServer({ cert: readFileSync(first!.cert), key: readFileSync(first!.key) }, (_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const error = await new Promise<Error>((resolve) => {
        const socket = connect({ host: '127.0.0.1', port, ca: readFileSync(other.ca), rejectUnauthorized: true });
        socket.on('error', resolve);
        socket.on('secureConnect', () => resolve(new Error('connecte')));
      });
      assert.notEqual(error.message, 'connecte');
    } finally {
      server.close();
    }
  });
});

describe('generateCert : ancien mode auto-signe', { skip: SKIP }, () => {
  it('produit toujours un certificat unique auto-signe avec le meme SAN', () => {
    const dir = tmp();
    const r = generateCert({ hosts: HOSTS, dir });
    const c = read(r.cert);
    assert.equal(certificateBlocks(readFileSync(r.cert, 'utf8')).length, 1);
    assert.equal(isSelfSigned(c), true);
    assert.deepEqual(san(c), ['DNS:localhost', 'DNS:psim.test', 'IP:127.0.0.1', 'IP:192.168.1.10']);
    assert.equal(c.checkPrivateKey(createPrivateKey(readFileSync(r.key))), true);
    assert.throws(() => generateCert({ hosts: HOSTS, dir }), /existe deja/);
    assert.ok(!existsSync(join(dir, 'ca.pem')));
  });
});

describe('pickPhoneCa : le certificat a installer sur le telephone', { skip: SKIP }, () => {
  // lus a la demande : le bloc est saute (et `first` est null) quand OpenSSL est absent
  const chain = SKIP ? '' : readFileSync(first!.cert, 'utf8');
  const caPem = SKIP ? '' : readFileSync(first!.ca, 'utf8');
  const leafPem = certificateBlocks(chain)[0];

  it("chaine « serveur + autorite » : l'autorite", () => {
    const ca = pickPhoneCa(chain);
    assert.equal(ca?.cert.fingerprint256, read(first!.ca).fingerprint256);
    assert.equal(ca?.cert.ca, true);
    assert.equal(certificateBlocks(ca!.pem).length, 1);
    assert.equal(ca!.pem, `${certificateBlocks(caPem)[0]}\n`, 'exactement le bloc de ca.pem');
  });

  it("l'ordre du fichier n'y change rien (autorite en premier)", () => {
    const reversed = `${caPem}\n${leafPem}\n`;
    assert.equal(pickPhoneCa(reversed)?.cert.fingerprint256, read(first!.ca).fingerprint256);
  });

  it('certificat unique CA:TRUE : lui-meme', () => {
    assert.equal(pickPhoneCa(caPem)?.cert.fingerprint256, read(first!.ca).fingerprint256);
    assert.equal(pickPhoneCa(Buffer.from(caPem))?.cert.fingerprint256, read(first!.ca).fingerprint256);
  });

  it('certificat de serveur seul (CA:FALSE) : null', () => {
    assert.equal(pickPhoneCa(leafPem), null);
  });

  it('vide, texte, bloc corrompu, cle seule : null', () => {
    assert.equal(pickPhoneCa(''), null);
    assert.equal(pickPhoneCa('bonjour'), null);
    assert.equal(pickPhoneCa('-----BEGIN CERTIFICATE-----\nMIIBFAKE\n-----END CERTIFICATE-----\n'), null);
    assert.equal(pickPhoneCa(readFileSync(first!.key)), null);
  });

  it("un bloc corrompu n'empeche pas de trouver l'autorite voisine", () => {
    const junk = '-----BEGIN CERTIFICATE-----\nMIIBFAKE\n-----END CERTIFICATE-----\n';
    assert.equal(pickPhoneCa(`${junk}${leafPem}\n${caPem}`)?.cert.fingerprint256, read(first!.ca).fingerprint256);
  });

  it('ne renvoie jamais une cle privee, meme si le fichier en contient une', () => {
    const picked = pickPhoneCa(`${chain}\n${readFileSync(first!.key, 'utf8')}`);
    assert.ok(picked);
    assert.ok(!picked.pem.includes('PRIVATE KEY'));
  });
});

// ---------------------------------------------------------------- utilitaires de test

/** Sortie texte d'une commande openssl (pour verifier des extensions que `node:crypto` n'expose pas). */
function openssl(args: string[]): string {
  const r = spawnSync(findOpenssl()!, args, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
