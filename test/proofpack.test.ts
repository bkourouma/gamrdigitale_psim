/**
 * Dossier de preuve (server/proofpack.ts) et sa verification hors ligne (scripts/verify-proof.ts) : contenu complet d'un
 * export reel sur base de test, relecture, falsification de CHAQUE element, anomalies declarees, zip piege, ancre.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { inflateRawSync, deflateRawSync, crc32 } from 'node:zlib';
import { openDb } from '../server/db.ts';
import { createEngine, PsimError } from '../server/engine.ts';
import { sealImage } from '../server/evidence.ts';
import type { AuditFn } from '../server/evidence.ts';
import { buildProofPack, createLimiter, createProofService } from '../server/proofpack.ts';
import { formatManifest, sha256hex } from '../server/proofformat.ts';
import { seedDemo } from '../server/seed.ts';
import { ZipError, createZip, readZip } from '../server/zip.ts';
import { formatVerdict, main as verifyMain, verifyProof } from '../scripts/verify-proof.ts';
import { headOf } from '../server/auditchain.ts';

const MIN = 60_000;
const jpeg = (n: number) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]),
    Buffer.alloc(64, n),
    Buffer.from([0xff, 0xd9]),
  ]);

function setup() {
  const db = openDb(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'psim-proof-'));
  seedDemo(db, dataDir, join(import.meta.dirname, '..', 'seed'));
  const snapDir = join(dataDir, 'snapshots');
  mkdirSync(snapDir, { recursive: true });
  let clock = new Date(2026, 1, 10, 9, 0, 0).getTime();
  const engine = createEngine(db, () => {}, () => clock);
  const audit: AuditFn = (a, b, c) => engine.audit(a, b, c);
  const advance = (ms: number) => void (clock += ms);

  // Incident reel de bout en bout : D-06 (cameras liees C-04, C-05), images camera + image d'equipement, alertes, cloture.
  engine.handleDetectorMessage('D-06', { state: 'alarm' });
  const id = engine.getSnapshot().incidents.find((i) => i.detectorId === 'D-06')!.id;
  advance(5_000);
  const cam4 = sealImage(db, snapDir, audit, { incidentId: id, deviceId: 'C-04', takenAt: clock, reason: 'opened', source: 'camera', data: jpeg(1), type: 'jpg' });
  advance(2_000);
  const cam5 = sealImage(db, snapDir, audit, { incidentId: id, deviceId: 'C-05', takenAt: clock, reason: 'opened', source: 'camera', data: jpeg(2), type: 'jpg' });
  advance(1_000);
  const dev = sealImage(db, snapDir, audit, { incidentId: id, deviceId: 'D-06', takenAt: clock, reason: 'device', source: 'device', data: jpeg(3), type: 'jpg', note: 'alarme annoncee' });
  const notif = db.prepare("INSERT INTO notification_log (incident_id, kind, channel, recipient, level, status, error, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  notif.run(id, 'initial', 'email', 'responsable@exemple.test', 1, 'sent', null, 1, clock);
  notif.run(id, 'initial', 'webhook', 'https://hooks.exemple.test/T0123/JETON-SECRET-ABCDEF', 1, 'failed', 'ECONNREFUSED https://hooks.exemple.test/T0123/JETON-SECRET-ABCDEF', 3, clock + 1000);
  notif.run(id, 'unacked', 'round', '-', 0, 'marker', null, 0, clock + 2000);
  advance(60_000);
  engine.acknowledge(id, 'operateur');
  advance(4 * MIN);
  engine.handleDetectorMessage('D-06', { state: 'normal' });
  engine.close(id, 'operateur', 'fire', 'Depart de feu maitrise a l\'extincteur');
  advance(2 * MIN);
  const cfg = { db, dataDir, siteName: () => 'Site <test>', now: () => clock };
  return { db, dataDir, snapDir, engine, audit, id, cam4, cam5, dev, cfg, advance, now: () => clock };
}

type T = ReturnType<typeof setup>;
const pack = (t: T, isAdmin = true) => buildProofPack(t.cfg, t.id, { actor: 'admin', isAdmin });

/** Reecrit un zip apres modification de ses fichiers ; `fix` recalcule le manifeste (faussaire soigneux). */
function rewrite(zip: Buffer, edit: (files: Map<string, Buffer>) => void, fix = false): Buffer {
  const files = readZip(zip);
  edit(files);
  if (fix) {
    files.delete('MANIFEST.sha256');
    files.set('MANIFEST.sha256', Buffer.from(formatManifest([...files].map(([name, data]) => ({ name, sha256: sha256hex(data) }))), 'utf8'));
  }
  return createZip([...files].map(([name, data]) => ({ name, data, deflate: !name.startsWith('images/') })), Date.now());
}
const editJson = (files: Map<string, Buffer>, name: string, fn: (o: any) => void) => {
  const o = JSON.parse(files.get(name)!.toString('utf8'));
  fn(o);
  files.set(name, Buffer.from(`${JSON.stringify(o, null, 2)}\n`, 'utf8'));
};

/** Lecteur ZIP INDEPENDANT de l'ecrivain et du lecteur de production : parcours sequentiel des en-tetes locaux. */
function independentRead(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const crc = buf.readUInt32LE(p + 14);
    const csize = buf.readUInt32LE(p + 18);
    const usize = buf.readUInt32LE(p + 22);
    const nl = buf.readUInt16LE(p + 26);
    const xl = buf.readUInt16LE(p + 28);
    const name = buf.toString('latin1', p + 30, p + 30 + nl);
    const raw = buf.subarray(p + 30 + nl + xl, p + 30 + nl + xl + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(data.length, usize, name);
    assert.equal(crc32(data) >>> 0, crc, name);
    out.set(name, data);
    p += 30 + nl + xl + csize;
  }
  assert.equal(buf.readUInt32LE(p), 0x02014b50, 'le repertoire central suit les fichiers');
  return out;
}

describe('ecrivain et lecteur ZIP', () => {
  const sample = [
    { name: 'a.txt', data: Buffer.from('bonjour '.repeat(50)), deflate: true },
    { name: 'images/1.jpg', data: jpeg(9), deflate: false },
    { name: 'vide.json', data: Buffer.alloc(0), deflate: true },
  ];

  it('relu par un lecteur independant et par le lecteur de production, octet pour octet', () => {
    const z = createZip(sample, Date.now());
    for (const read of [independentRead, readZip]) {
      const got = read(z);
      assert.deepEqual([...got.keys()].sort(), ['a.txt', 'images/1.jpg', 'vide.json']);
      for (const s of sample) assert.deepEqual(got.get(s.name), s.data, s.name);
    }
  });

  it("s'ouvre avec l'outil du systeme (tar/bsdtar lit les zip), quand il est disponible", (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), 'psim-tar-'));
    const file = join(dir, 'x.zip');
    writeFileSync(file, createZip(sample, Date.now()));
    // Windows : bsdtar (System32) lit les zip ; le tar GNU de Git Bash prend « C: » pour un hote distant.
    const tarExe = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const r = spawnSync(tarExe, ['-tf', 'x.zip'], { encoding: 'utf8', cwd: dir });
    if (r.error || r.status !== 0) return void ctx.skip(`tar indisponible ou sans support zip : ${r.error?.message ?? r.stderr}`);
    assert.deepEqual(r.stdout.split(/\r?\n/).filter(Boolean).sort(), ['a.txt', 'images/1.jpg', 'vide.json']);
  });

  it("l'ecrivain refuse les noms dangereux, les doublons, l'excès", () => {
    for (const name of ['../x.txt', '/etc/passwd', 'a/../b', 'C:/x', 'a\\b.txt', '.cache', 'a//b', '', 'a b.txt', 'é.txt', 'x\0.txt', 'a/.']) {
      assert.throws(() => createZip([{ name, data: Buffer.from('x') }], 0), /nom d'entree refuse/, JSON.stringify(name));
    }
    assert.throws(() => createZip([{ name: 'a.txt', data: Buffer.from('1') }, { name: 'A.TXT', data: Buffer.from('2') }], 0), /dupliquee/);
    assert.throws(() => createZip([], 0), /nombre d'entrees/);
  });

  const reject = (zip: Buffer, pattern: RegExp, limits?: Parameters<typeof readZip>[1]) =>
    assert.throws(() => readZip(zip, limits), (e: unknown) => e instanceof ZipError && pattern.test(e.message), `attendu ${pattern}`);

  it('lecteur : refuse un zip tronque ou qui n\'en est pas un', () => {
    const z = createZip(sample, Date.now());
    reject(z.subarray(0, z.length - 5), /fin de zip introuvable/);
    reject(z.subarray(0, 40), /trop court|fin de zip/);
    reject(Buffer.from('ceci n est pas un zip du tout, mais assez long pour passer'), /fin de zip/);
    reject(Buffer.concat([z, Buffer.from('xx')]), /fin de zip/);
    // repertoire central vide de sens : le nombre d'entrees annonce ne correspond pas
    const bad = Buffer.from(z);
    bad.writeUInt16LE(7, bad.length - 22 + 10);
    bad.writeUInt16LE(7, bad.length - 22 + 8);
    assert.throws(() => readZip(bad), ZipError);
  });

  it('lecteur : refuse les noms pieges (traversee de chemin) meme ecrits dans le fichier', () => {
    const z = createZip([{ name: 'aa/bb.txt', data: Buffer.from('1') }], 0);
    for (const evil of ['../bb.txt', '/abcd.txt', 'a\\bbb.txt', 'a/../b.tx', 'C:/bb.txt']) {
      assert.equal(evil.length, 9, evil);
      const patched = Buffer.from(z.toString('latin1').split('aa/bb.txt').join(evil), 'latin1');
      assert.equal(patched.length, z.length);
      assert.throws(() => readZip(patched), (e: unknown) => e instanceof ZipError && /nom|chemin/.test(e.message), JSON.stringify(evil));
    }
  });

  it('lecteur : refuse les entrees dupliquees', () => {
    const z = createZip([{ name: 'aa.txt', data: Buffer.from('1') }, { name: 'bb.txt', data: Buffer.from('2') }], 0);
    const patched = Buffer.from(z.toString('latin1').split('bb.txt').join('aa.txt'), 'latin1');
    reject(patched, /dupliquee/);
  });

  it('lecteur : bombe de decompression refusee (taille annoncee demesuree, ou reelle superieure a l\'annoncee)', () => {
    const big = createZip([{ name: 'bombe.bin', data: Buffer.alloc(3_000_000, 0), deflate: true }], 0);
    assert.ok(big.length < 10_000, 'tres compressible');
    reject(big, /demesuree|bombe/, { maxEntryBytes: 1_000_000 });
    reject(big, /demesuree|bombe/, { maxTotalBytes: 1_000_000 });
    // La taille annoncee ment : 10 octets annonces, 3 Mo reels.
    const lying = Buffer.from(big);
    lying.writeUInt32LE(10, 22); // local
    const cd = lying.length - 22 - 46 - 'bombe.bin'.length;
    lying.writeUInt32LE(10, cd + 24); // repertoire central
    reject(lying, /plus grandes que la taille annoncee|invalides/);
  });

  it('lecteur : refuse chiffrement, methode inconnue, CRC faux, entrees qui se chevauchent', () => {
    const z = createZip([{ name: 'aa.txt', data: Buffer.from('bonjour tout le monde') }, { name: 'bb.txt', data: Buffer.from('autre contenu ici') }], 0);
    const cdOffset = z.readUInt32LE(z.length - 22 + 16);
    const enc = Buffer.from(z);
    enc.writeUInt16LE(1, cdOffset + 8);
    reject(enc, /chiffree/);
    const meth = Buffer.from(z);
    meth.writeUInt16LE(99, cdOffset + 10);
    reject(meth, /methode/);
    const crc = Buffer.from(z);
    crc.writeUInt32LE(0xdeadbeef, cdOffset + 16);
    reject(crc, /CRC/);
    const flipped = Buffer.from(z);
    flipped[30 + 'aa.txt'.length] ^= 0xff; // un octet du contenu
    reject(flipped, /CRC/);
    // le second fichier pointe sur le premier
    const second = cdOffset + 46 + 'aa.txt'.length;
    const overlap = Buffer.from(z);
    overlap.writeUInt32LE(0, second + 42);
    assert.throws(() => readZip(overlap), ZipError);
  });
});

describe('contenu du dossier de preuve', () => {
  const t = setup();
  const p = pack(t);
  const files = readZip(p.zip);
  const json = (name: string) => JSON.parse(files.get(name)!.toString('utf8'));

  it('contient exactement les fichiers annonces (zip relu par un lecteur independant)', () => {
    assert.deepEqual([...independentRead(p.zip).keys()].sort(), [...files.keys()].sort());
    assert.deepEqual(
      [...files.keys()].sort(),
      ['LISEZ-MOI.txt', 'MANIFEST.sha256', 'incident.json', 'journal-extrait.json', 'notifications.json', 'rapport.html', `images/${t.cam4.id}.jpg`, `images/${t.cam5.id}.jpg`, `images/${t.dev.id}.jpg`].sort(),
    );
    assert.match(p.fileName, /^dossier-preuve-incident-\d+-\d{8}-\d{6}\.zip$/);
    assert.equal(p.sha256, sha256hex(p.zip));
  });

  it('le manifeste liste l\'empreinte de CHAQUE autre fichier (format sha256sum)', () => {
    const lines = files.get('MANIFEST.sha256')!.toString('utf8').trim().split('\n');
    assert.equal(lines.length, files.size - 1);
    for (const line of lines) {
      const [hash, name] = [line.slice(0, 64), line.slice(66)];
      assert.equal(line.slice(64, 66), '  ');
      assert.equal(sha256hex(files.get(name)!), hash, name);
    }
    assert.ok(!lines.some((l) => l.endsWith('MANIFEST.sha256')));
  });

  it("incident.json : identite, equipement, zone, etage, categorie, etats, accuse, qualification, cloture, personnes", () => {
    const d = json('incident.json');
    assert.equal(d.incident.numero, t.id);
    assert.equal(d.equipement.id, 'D-06');
    assert.equal(d.equipement.nom, 'Detecteur atelier');
    assert.equal(d.equipement.zone, 'Atelier');
    assert.ok(d.equipement.etage.length > 0);
    assert.equal(d.equipement.categorie, 'fire');
    assert.deepEqual(d.equipement.cameras_liees, ['C-04', 'C-05']);
    assert.equal(d.incident.accuse.par, 'operateur');
    assert.equal(d.incident.cloture.par, 'operateur');
    assert.equal(d.incident.qualification, 'fire');
    assert.equal(d.incident.commentaire, "Depart de feu maitrise a l'extincteur", 'commentaire inclus');
    assert.deepEqual(d.etats_successifs.map((s: { etat: string }) => s.etat), ['alarm', 'normal']);
    assert.ok(d.etats_successifs[0].debut.utc.endsWith('Z') && d.etats_successifs[0].debut.serveur);
    assert.ok(d.personnes_intervenues.includes('operateur'), 'noms d\'operateurs inclus');
    assert.ok(d.actions.some((a: { action: string }) => a.action === 'incident_opened'));
    assert.ok(d.actions.some((a: { action: string; auteur: string }) => a.action === 'incident_acked' && a.auteur === 'operateur'));
    assert.deepEqual(d.anomalies, []);
    assert.match(d.avertissement_heure, /serveur/);
    assert.equal(d.genere_par, 'admin');
  });

  it('images : originaux sceles, source camera ou equipement, empreintes, aucune anomalie', () => {
    const d = json('incident.json');
    assert.equal(d.images.length, 3);
    for (const im of d.images) {
      assert.equal(im.etat, 'conforme');
      assert.equal(im.sha256_dossier, im.sha256_scelle);
      assert.equal(sha256hex(files.get(im.fichier)!), im.sha256_scelle);
      assert.ok(im.entree_journal > 0);
    }
    assert.deepEqual(d.images.map((i: { source: string }) => i.source), ['camera', 'camera', 'equipement']);
    assert.deepEqual(files.get(`images/${t.cam4.id}.jpg`), jpeg(1), 'original, octet pour octet');
  });

  it('journal-extrait : entrees de l\'incident et de l\'equipement, empreintes, empreinte precedente et ancre', () => {
    const j = json('journal-extrait.json');
    assert.equal(j.incident, t.id);
    assert.ok(j.entrees.length >= 8);
    assert.ok(j.entrees.every((e: { hash: string; prev_hash: string }) => /^[0-9a-f]{64}$/.test(e.hash) && e.prev_hash));
    assert.equal(j.empreinte_precedente_premiere, j.entrees[0].prev_hash);
    assert.deepEqual(j.ancre, headOf(t.db), 'ancre = fin de la chaine a l\'export');
    assert.equal(j.entrees.filter((e: { action: string }) => e.action === 'image_scellee').length, 3);
    assert.ok(j.entrees.every((e: { incident_id: number | null; device_id: string | null }) => e.incident_id === t.id || ['D-06', 'C-04', 'C-05'].includes(e.device_id ?? '')));
    assert.deepEqual(j.entrees_omises, { droits: 0, plafond: 0 });
  });

  it('notifications.json : qui, quand, canal, statut ; ni secret ni marqueur interne', () => {
    const raw = files.get('notifications.json')!.toString('utf8');
    const n = JSON.parse(raw);
    assert.equal(n.notifications.length, 2, 'les marqueurs de ronde ne sont pas des alertes');
    assert.equal(n.notifications[0].destinataire, 'responsable@exemple.test');
    assert.equal(n.notifications[0].statut, 'envoyee');
    assert.equal(n.notifications[1].statut, 'echec');
    assert.ok(!raw.includes('JETON-SECRET') && !raw.includes('ECONNREFUSED'), 'ni jeton de webhook ni message d\'erreur');
    assert.match(n.notifications[1].destinataire, /^hooks\.exemple\.test /);
  });

  it('rapport.html : lisible, echappe, sans script ni ressource externe ; LISEZ-MOI honnete', () => {
    const html = files.get('rapport.html')!.toString('utf8');
    assert.ok(!/<script/i.test(html) && !/https?:\/\//i.test(html) && !/<link/i.test(html) && !/\son[a-z]+=/i.test(html));
    assert.ok(!/src="(?!data:)/.test(html), 'aucune image externe');
    assert.match(html, /Site &lt;test&gt;/, 'le nom du site est echappe');
    assert.match(html, /Depart de feu/);
    assert.match(html, /data:image\/jpeg;base64,/);
    assert.match(html, /Aucune anomalie constat/);
    const readme = files.get('LISEZ-MOI.txt')!.toString('utf8');
    for (const phrase of ['NE PROUVE PAS', 'horodatage certifié', 'verify-proof', 'export_preuve', 'ancre']) assert.ok(readme.includes(phrase), phrase);
  });

  it('le dossier d\'un incident INEXISTANT : 404', () => {
    assert.throws(() => buildProofPack(t.cfg, 99_999, { actor: 'a', isAdmin: true }), (e: unknown) => e instanceof PsimError && e.status === 404);
  });

  it('un incident non clos peut etre exporte', () => {
    const t2 = setup();
    t2.engine.handleDetectorMessage('D-01', { state: 'alarm' });
    const open = t2.engine.getSnapshot().incidents.find((i) => i.detectorId === 'D-01')!;
    const d = JSON.parse(readZip(buildProofPack(t2.cfg, open.id, { actor: 'a', isAdmin: true }).zip).get('incident.json')!.toString('utf8'));
    assert.equal(d.incident.cloture, null);
    assert.equal(verifyProof(buildProofPack(t2.cfg, open.id, { actor: 'a', isAdmin: true }).zip).ok, true);
  });
});

describe('verification hors ligne : dossier intact', () => {
  const t = setup();
  const p = pack(t);

  it('verdict conforme, code de sortie 0, empreinte du zip et ancre affichees', () => {
    const v = verifyProof(p.zip);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.deepEqual(v.altered, []);
    assert.equal(v.zipSha256, p.sha256);
    const text = formatVerdict(v, 'x.zip').join('\n');
    assert.match(text, /CONFORME/);
    assert.match(text, /Rappel : sans ancre/);
    const dir = mkdtempSync(join(tmpdir(), 'psim-vp-'));
    const file = join(dir, p.fileName);
    writeFileSync(file, p.zip);
    assert.equal(verifyMain([file]), 0);
    assert.equal(verifyMain([join(dir, 'absent.zip')]), 1);
    assert.equal(verifyMain([]), 2);
    assert.equal(verifyMain([file, '--anchor', 'pas-une-ancre']), 2);
  });

  it('ancre conservee ailleurs : identique = conforme ; differente = ALTERE ; numero absent = non concluant', () => {
    const head = headOf(t.db)!;
    const ok = verifyProof(p.zip, [{ id: head.id, hash: head.hash }]);
    assert.equal(ok.ok, true);
    assert.match(formatVerdict(ok, 'x').join('\n'), /ancre fournie retrouvee/);
    const bad = verifyProof(p.zip, [{ id: head.id, hash: 'f'.repeat(64) }]);
    assert.equal(bad.ok, false);
    assert.ok(bad.altered.some((a) => /DIFFERENTE/.test(a)));
    const other = verifyProof(p.zip, [{ id: head.id + 50, hash: 'a'.repeat(64) }]);
    assert.equal(other.ok, false);
    assert.equal(other.altered.length, 0);
    assert.equal(other.inconclusiveAnchors.length, 1);
    assert.match(formatVerdict(other, 'x').join('\n'), /NON CONCLUANT/);
    // ancre d'une entree de l'extrait (ex. une entree du milieu) : retrouvee
    const j = JSON.parse(readZip(p.zip).get('journal-extrait.json')!.toString('utf8'));
    const mid = j.entrees[3];
    assert.equal(verifyProof(p.zip, [{ id: mid.id, hash: mid.hash }]).ok, true);
    assert.equal(verifyProof(p.zip, [{ id: mid.id, hash: '0'.repeat(64) }]).ok, false);
  });
});

describe('verification hors ligne : falsification detectee dans CHAQUE cas', () => {
  const t = setup();
  const p = pack(t);
  const imageName = `images/${t.cam4.id}.jpg`;
  const bad = (zip: Buffer, pattern: RegExp, where: 'altered' | 'anomalies' = 'altered') => {
    const v = verifyProof(zip);
    assert.equal(v.ok, false, 'doit etre detecte');
    assert.ok(v[where].some((m) => pattern.test(m)), `${pattern} introuvable dans ${JSON.stringify(v[where])} (refuse: ${v.refused})`);
    return v;
  };

  it('un octet d\'une image modifie (manifeste inchange)', () => {
    bad(rewrite(p.zip, (f) => { const b = Buffer.from(f.get(imageName)!); b[b.length - 10] ^= 1; f.set(imageName, b); }), /MODIFIE depuis l'export : images\//);
  });

  it('une image remplacee ET le manifeste recalcule ET incident.json corrige : le journal scelle la vraie empreinte', () => {
    const fake = jpeg(77);
    const z = rewrite(
      p.zip,
      (f) => {
        f.set(imageName, fake);
        editJson(f, 'incident.json', (o) => { o.images.find((i: { id: number }) => i.id === t.cam4.id).sha256_dossier = sha256hex(fake); });
      },
      true,
    );
    const v = bad(z, /DIFFERENT de l'empreinte scellee/);
    assert.ok(v.altered.length > 0, 'declaree conforme alors qu\'elle ne l\'est pas');
  });

  it('une entree du journal modifiee (manifeste inchange, puis manifeste recalcule)', () => {
    const edit = (f: Map<string, Buffer>) => editJson(f, 'journal-extrait.json', (o) => { o.entrees[2].details = `${o.entrees[2].details ?? ''} (retouche)`; });
    bad(rewrite(p.zip, edit), /MODIFIE depuis l'export : journal-extrait\.json/);
    bad(rewrite(p.zip, edit, true), /entree n°\d+ MODIFIEE/);
  });

  it('l\'auteur d\'une entree change et recalcule son empreinte : la chaine casse a l\'entree suivante', () => {
    const z = rewrite(
      p.zip,
      (f) =>
        editJson(f, 'journal-extrait.json', (o) => {
          // on prend une entree dont la suivante est consecutive
          const k = o.entrees.findIndex((e: { id: number }, i: number) => i > 0 && o.entrees[i + 1] && o.entrees[i + 1].id === e.id + 1);
          assert.ok(k > 0);
          o.entrees[k].actor = 'complice';
          o.entrees[k].hash = sha256hex('recalcule a la main'); // incoherent avec le contenu : detecte d'une facon ou d'une autre
        }),
      true,
    );
    bad(z, /MODIFIEE|ROMPU/);
  });

  it('prev_hash d\'une entree change : detecte (l\'empreinte precedente fait partie du calcul)', () => {
    bad(rewrite(p.zip, (f) => editJson(f, 'journal-extrait.json', (o) => { o.entrees[3].prev_hash = 'b'.repeat(64); }), true), /MODIFIEE|ROMPU/);
  });

  it("l'entree qui scelle une image retiree du journal (manifeste recalcule) : image declaree conforme sans sceau", () => {
    const sealId = (JSON.parse(readZip(p.zip).get('incident.json')!.toString('utf8')).images as { id: number; entree_journal: number }[]).find((i) => i.id === t.cam4.id)!.entree_journal;
    bad(
      rewrite(p.zip, (f) => editJson(f, 'journal-extrait.json', (o) => { o.entrees = o.entrees.filter((e: { id: number }) => e.id !== sealId); }), true),
      /declaree conforme mais aucune entree scellee|annoncee par incident\.json differe/,
    );
  });

  it("LIMITE assumee : une entree ordinaire retiree de l'extrait est indiscernable d'une entree non incluse ; seule l'empreinte du .zip inscrite au journal du PSIM la revele", () => {
    const t2 = setup();
    const svc = createProofService({ ...t2.cfg, audit: t2.audit });
    const real = svc.exportPack(t2.id, { actor: 'admin', isAdmin: true });
    const recorded = (t2.db.prepare("SELECT details FROM audit_log WHERE action = 'export_preuve'").get() as { details: string }).details.match(/sha256=([0-9a-f]{64})/)![1];
    assert.equal(recorded, real.sha256);
    const forged = rewrite(
      real.zip,
      (f) => editJson(f, 'journal-extrait.json', (o) => { const k = o.entrees.findIndex((e: { action: string }) => e.action === 'incident_acked'); o.entrees.splice(k, 1); }),
      true,
    );
    assert.equal(verifyProof(forged).ok, true, 'le dossier seul ne peut pas le voir (limite documentee dans LISEZ-MOI et docs/PREUVE.md)');
    const v = verifyProof(forged, [], recorded);
    assert.equal(v.ok, false);
    assert.ok(v.altered.some((a) => /empreinte du \.zip DIFFERENTE/.test(a)));
    assert.equal(verifyProof(real.zip, [], recorded).ok, true);
    assert.equal(verifyMain([join(mkdtempSync(join(tmpdir(), 'x-')), 'absent.zip'), '--sha256', 'zz']), 2);
  });


  it('le MANIFEST modifie (une empreinte changee, une ligne retiree, supprime)', () => {
    bad(rewrite(p.zip, (f) => f.set('MANIFEST.sha256', Buffer.from(f.get('MANIFEST.sha256')!.toString('utf8').replace(/^./, (c) => (c === '0' ? '1' : '0'))))), /MODIFIE depuis l'export/);
    bad(rewrite(p.zip, (f) => f.set('MANIFEST.sha256', Buffer.from(f.get('MANIFEST.sha256')!.toString('utf8').split('\n').slice(1).join('\n')))), /AJOUTE, absent du manifeste/);
    bad(rewrite(p.zip, (f) => f.delete('MANIFEST.sha256')), /MANIFEST\.sha256 ABSENT/);
    bad(rewrite(p.zip, (f) => f.set('MANIFEST.sha256', Buffer.from('n importe quoi\n'))), /manifeste invalide|mal formee/i);
  });

  it('un fichier supprime (image, journal, incident.json, rapport), avec ou sans manifeste recalcule', () => {
    bad(rewrite(p.zip, (f) => f.delete(imageName)), /SUPPRIME du dossier : images\//);
    bad(rewrite(p.zip, (f) => f.delete(imageName), true), /ABSENT du dossier|ABSENT/);
    bad(rewrite(p.zip, (f) => f.delete('journal-extrait.json')), /SUPPRIME du dossier : journal-extrait\.json/);
    bad(rewrite(p.zip, (f) => f.delete('incident.json'), true), /fichier obligatoire ABSENT : incident\.json/);
    bad(rewrite(p.zip, (f) => f.delete('rapport.html'), true), /fichier obligatoire ABSENT : rapport\.html/);
  });

  it('image retiree du zip ET de la liste d\'images (manifeste recalcule) : le journal l\'a scellee', () => {
    const z = rewrite(
      p.zip,
      (f) => {
        f.delete(imageName);
        editJson(f, 'incident.json', (o) => { o.images = o.images.filter((i: { id: number }) => i.id !== t.cam4.id); });
      },
      true,
    );
    bad(z, /scellee au journal .* mais absente de la liste/);
  });

  it('un fichier ajoute (image non declaree, fichier quelconque)', () => {
    bad(rewrite(p.zip, (f) => f.set('images/999.jpg', jpeg(5))), /AJOUTE, absent du manifeste/);
    bad(rewrite(p.zip, (f) => f.set('images/999.jpg', jpeg(5)), true), /non declaree/);
    bad(rewrite(p.zip, (f) => f.set('extra.txt', Buffer.from('x'))), /AJOUTE/);
  });

  it('LISEZ-MOI ou rapport retouches', () => {
    bad(rewrite(p.zip, (f) => f.set('rapport.html', Buffer.from('<p>autre</p>'))), /MODIFIE depuis l'export : rapport\.html/);
    bad(rewrite(p.zip, (f) => f.set('LISEZ-MOI.txt', Buffer.from('rien a signaler'))), /MODIFIE depuis l'export : LISEZ-MOI\.txt/);
  });

  it('incident.json declare l\'autre incident / journal d\'un autre incident', () => {
    bad(rewrite(p.zip, (f) => editJson(f, 'journal-extrait.json', (o) => { o.incident = 12345; }), true), /concerne l'incident 12345/);
  });

  it('zip tronque, aleatoire ou piege : refuse proprement', () => {
    for (const z of [p.zip.subarray(0, p.zip.length - 30), p.zip.subarray(0, 200), Buffer.alloc(0), Buffer.from('PK pas un zip'), Buffer.alloc(5000, 7)]) {
      const v = verifyProof(z);
      assert.equal(v.ok, false);
      assert.ok(v.refused, 'refuse');
      assert.match(formatVerdict(v, 'x').join('\n'), /DOSSIER REFUSE/);
    }
    // fuzz : un octet quelconque change dans tout le fichier ne donne JAMAIS « conforme »
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let i = 0; i < 400; i++) {
      const z = Buffer.from(p.zip);
      z[rnd(z.length)] ^= 1 + rnd(255);
      const v = verifyProof(z);
      // Seuls des octets sans effet (champs ignores de l'en-tete : date, version, attributs) peuvent rester conformes.
      if (v.ok) assert.deepEqual(readZip(z), readZip(p.zip), 'si conforme, le contenu est identique');
    }
  });

  it('bombe de decompression dans un dossier : refusee sans rien extraire', () => {
    const z = createZip([{ name: 'MANIFEST.sha256', data: Buffer.alloc(3_000_000, 0x41), deflate: true }], 0);
    const lying = Buffer.from(z);
    const cd = lying.readUInt32LE(lying.length - 22 + 16);
    lying.writeUInt32LE(0x20000000, 22); // local : 512 Mo annonces
    lying.writeUInt32LE(0x20000000, cd + 24);
    const v = verifyProof(lying);
    assert.equal(v.ok, false);
    assert.match(v.refused ?? '', /bombe/);
    assert.match(formatVerdict(v, 'x').join('\n'), /DOSSIER REFUSE/);
  });
});

describe('anomalies : jamais cachees, le dossier est quand meme produit', () => {
  it('image supprimee du disque : dossier produit, anomalie ecrite dans incident.json, LISEZ-MOI et rapport', () => {
    const t = setup();
    unlinkSync(join(t.snapDir, t.cam5.file));
    const p = pack(t);
    const f = readZip(p.zip);
    const d = JSON.parse(f.get('incident.json')!.toString('utf8'));
    const im = d.images.find((i: { id: number }) => i.id === t.cam5.id);
    assert.equal(im.etat, 'manquante');
    assert.equal(im.fichier, null);
    assert.ok(im.sha256_scelle, 'l\'empreinte scellee reste indiquee');
    assert.ok(d.anomalies.some((a: string) => /MANQUANT/.test(a)));
    assert.match(f.get('LISEZ-MOI.txt')!.toString('utf8'), /ANOMALIES CONSTAT/);
    assert.match(f.get('rapport.html')!.toString('utf8'), /ANOMALIES CONSTAT[\s\S]*MANQUANT/);
    assert.ok(!f.has(`images/${t.cam5.id}.jpg`));
    const v = verifyProof(p.zip);
    assert.equal(v.ok, false, 'la verification ne passe pas sous silence une image manquante');
    assert.deepEqual(v.altered, [], 'le dossier lui-meme n\'a pas ete modifie');
    assert.ok(v.anomalies.some((a) => /image n°\d+ : MANQUANTE/.test(a)));
    assert.match(formatVerdict(v, 'x').join('\n'), /n'a pas ete modifie depuis l'export, MAIS/);
  });

  it('image modifiee sur le disque : fichier inclus tel quel, marque ALTEREE partout', () => {
    const t = setup();
    const b = jpeg(2);
    b[40] ^= 0xff;
    writeFileSync(join(t.snapDir, t.cam5.file), b);
    const p = pack(t);
    const f = readZip(p.zip);
    assert.deepEqual(f.get(`images/${t.cam5.id}.jpg`), b, 'le fichier modifie est fourni tel quel, comme piece de l\'anomalie');
    const d = JSON.parse(f.get('incident.json')!.toString('utf8'));
    assert.equal(d.images.find((i: { id: number }) => i.id === t.cam5.id).etat, 'alteree');
    assert.ok(d.anomalies.some((a: string) => /MODIFIE/.test(a)));
    assert.match(f.get('rapport.html')!.toString('utf8'), /ALTEREE/);
    assert.ok(!f.get('rapport.html')!.toString('utf8').includes(b.toString('base64').slice(0, 60)), 'l\'image altérée n\'est pas affichée comme preuve');
    const v = verifyProof(p.zip);
    assert.equal(v.ok, false);
    assert.deepEqual(v.altered, []);
    assert.ok(v.anomalies.some((a) => /DIFFERENT de l'empreinte scellee/.test(a)));
  });

  it('empreinte alteree en base : signalee ; image purgee avec entree de purge : simple remarque', () => {
    const t = setup();
    t.db.prepare('UPDATE incident_snapshot SET sha256 = ? WHERE id = ?').run('a'.repeat(64), t.cam4.id);
    const d = JSON.parse(readZip(pack(t).zip).get('incident.json')!.toString('utf8'));
    assert.ok(d.anomalies.some((a: string) => /empreinte modifiee en base/.test(a)));
    const t2 = setup();
    t2.audit('systeme', 'images_purgees', { details: `images ${t2.dev.id} (conservation 30 jours)` });
    t2.db.prepare('DELETE FROM incident_snapshot WHERE id = ?').run(t2.dev.id);
    unlinkSync(join(t2.snapDir, t2.dev.file));
    const p = pack(t2);
    const d2 = JSON.parse(readZip(p.zip).get('incident.json')!.toString('utf8'));
    assert.deepEqual(d2.anomalies, []);
    assert.ok(d2.avertissements.some((a: string) => /purge/.test(a)));
    const v = verifyProof(p.zip);
    assert.equal(v.ok, true, JSON.stringify(v));
    // supprimee SANS entree de purge : anomalie
    const t3 = setup();
    t3.db.prepare('DELETE FROM incident_snapshot WHERE id = ?').run(t3.dev.id);
    const d3 = JSON.parse(readZip(pack(t3).zip).get('incident.json')!.toString('utf8'));
    assert.ok(d3.anomalies.some((a: string) => /SANS entree de purge/.test(a)));
  });

  it('image anterieure au scellement : incluse, signalee en remarque (pas une anomalie)', () => {
    const t = setup();
    t.db.prepare("INSERT INTO incident_snapshot (incident_id, camera_id, taken_at, reason, file) VALUES (?, 'C-04', ?, 'opened', '')").run(t.id, t.now());
    const rowId = Number((t.db.prepare('SELECT MAX(id) AS m FROM incident_snapshot').get() as { m: number }).m);
    t.db.prepare('UPDATE incident_snapshot SET file = ? WHERE id = ?').run(`${rowId}.jpg`, rowId);
    writeFileSync(join(t.snapDir, `${rowId}.jpg`), jpeg(8));
    const p = pack(t);
    const d = JSON.parse(readZip(p.zip).get('incident.json')!.toString('utf8'));
    assert.equal(d.images.find((i: { id: number }) => i.id === rowId).etat, 'non_scellee');
    assert.deepEqual(d.anomalies, []);
    assert.ok(d.avertissements.some((a: string) => /anterieure/.test(a)));
    assert.equal(verifyProof(p.zip).ok, true);
  });

  it('plafond de taille des images : les images en trop sont signalees, pas ignorees en silence', () => {
    const t = setup();
    const p = buildProofPack({ ...t.cfg, maxImageBytes: jpeg(1).length + 5 }, t.id, { actor: 'a', isAdmin: true });
    const d = JSON.parse(readZip(p.zip).get('incident.json')!.toString('utf8'));
    assert.equal(d.images.filter((i: { etat: string }) => i.etat === 'omise').length, 2);
    assert.ok(d.anomalies.length >= 2);
    assert.equal(verifyProof(p.zip).ok, false);
  });
});

describe('fenetre, droits et plafond du journal', () => {
  it("l'operateur ne recoit pas les entrees d'administration (invisibles pour lui dans le PSIM), l'administrateur si", () => {
    const t = setup();
    t.audit('systeme', 'notification_failed', { incidentId: t.id, deviceId: 'D-06', details: 'SMTP 10.0.0.5 : refuse' });
    t.audit('systeme', 'camera_source_updated', { deviceId: 'C-04', details: 'rtsp://10.0.0.9/flux' });
    const admin = JSON.parse(readZip(pack(t, true).zip).get('journal-extrait.json')!.toString('utf8'));
    const op = JSON.parse(readZip(pack(t, false).zip).get('journal-extrait.json')!.toString('utf8'));
    assert.ok(admin.entrees.some((e: { action: string }) => e.action === 'notification_failed'));
    assert.ok(!op.entrees.some((e: { action: string }) => e.action === 'notification_failed' || e.action === 'camera_source_updated'));
    assert.equal(op.entrees_omises.droits, 2);
    assert.equal(admin.entrees_omises.droits, 0);
    assert.equal(verifyProof(pack(t, false).zip).ok, true, 'un extrait avec trous reste verifiable');
    assert.equal(verifyProof(pack(t, true).zip).ok, true);
  });

  it('fenetre configurable : une entree d\'equipement hors fenetre n\'est pas incluse', () => {
    const t = setup();
    t.advance(3 * 60 * MIN);
    t.audit('systeme', 'device_state', { deviceId: 'D-06', details: 'tard dans la nuit' });
    const small = JSON.parse(readZip(buildProofPack({ ...t.cfg, windowAfterMs: 5 * MIN }, t.id, { actor: 'a', isAdmin: true }).zip).get('journal-extrait.json')!.toString('utf8'));
    const wide = JSON.parse(readZip(buildProofPack({ ...t.cfg, windowAfterMs: 6 * 60 * MIN }, t.id, { actor: 'a', isAdmin: true }).zip).get('journal-extrait.json')!.toString('utf8'));
    assert.ok(!small.entrees.some((e: { details: string }) => e.details === 'tard dans la nuit'));
    assert.ok(wide.entrees.some((e: { details: string }) => e.details === 'tard dans la nuit'));
    assert.equal(small.fenetre.apres_ms, 5 * MIN);
  });

  it('plafond d\'entrees : signale comme anomalie, les entrees d\'images restent', () => {
    const t = setup();
    for (let i = 0; i < 30; i++) t.audit('systeme', 'device_state', { incidentId: t.id, deviceId: 'D-06', details: `bruit ${i}` });
    const p = buildProofPack({ ...t.cfg, maxEntries: 10 }, t.id, { actor: 'a', isAdmin: true });
    const d = JSON.parse(readZip(p.zip).get('incident.json')!.toString('utf8'));
    assert.ok(d.anomalies.some((a: string) => /plafond/.test(a)));
    const j = JSON.parse(readZip(p.zip).get('journal-extrait.json')!.toString('utf8'));
    assert.equal(j.entrees.filter((e: { action: string }) => e.action === 'image_scellee').length, 3);
    assert.equal(verifyProof(p.zip).ok, false, 'un extrait tronque n\'est jamais presente comme complet');
  });
});

describe('export : trace au journal AVANT livraison, debit limite', () => {
  it("exportPack inscrit « export_preuve » (qui, quel incident, empreinte du zip) et echoue sans livrer si l'inscription echoue", () => {
    const t = setup();
    const svc = createProofService({ ...t.cfg, audit: t.audit });
    const before = headOf(t.db)!.id;
    const out = svc.exportPack(t.id, { actor: 'operateur', isAdmin: false });
    const row = t.db.prepare("SELECT * FROM audit_log WHERE action = 'export_preuve'").get() as { actor: string; incident_id: number; details: string; id: number };
    assert.equal(row.actor, 'operateur');
    assert.equal(row.incident_id, t.id);
    assert.ok(row.id > before);
    assert.ok(row.details.includes(`sha256=${out.sha256}`) && row.details.includes(out.fileName) && row.details.includes(`manifeste sha256=${out.manifestSha256}`));
    const failing = createProofService({ ...t.cfg, audit: () => { throw new Error('disque plein'); } });
    assert.throws(() => failing.exportPack(t.id, { actor: 'operateur', isAdmin: false }), /disque plein/, 'pas de journal, pas de dossier');
    assert.throws(() => svc.exportPack(424242, { actor: 'x', isAdmin: false }), (e: unknown) => e instanceof PsimError && e.status === 404);
    assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'export_preuve'").get() as { n: number }).n, 1, 'un incident inexistant ne laisse pas de trace d\'export');
  });

  it('limiteur de debit : fenetre glissante par compte', () => {
    let now = 1_000_000;
    const take = createLimiter(3, 60_000, () => now);
    assert.deepEqual([take('a'), take('a'), take('a')], [0, 0, 0]);
    assert.ok(take('a') > 0, 'quatrieme refuse');
    assert.equal(take('b'), 0, 'un autre compte n\'est pas touche');
    now += 61_000;
    assert.equal(take('a'), 0, 'fenetre ecoulee');
  });
});

describe('pas de fuite vers le portail', () => {
  it('le portail ne connait ni le dossier de preuve ni les images', () => {
    for (const f of ['server/portal.ts', 'portal/server/main.ts']) {
      if (!existsSync(join(import.meta.dirname, '..', f))) continue;
      const src = readFileSync(join(import.meta.dirname, '..', f), 'utf8');
      assert.ok(!/proofpack|\/proof\b|export_preuve/.test(src), f);
    }
  });
});

// Evite un avertissement de module inutilise si deflateRawSync n'est plus requis par un test.
void deflateRawSync;
