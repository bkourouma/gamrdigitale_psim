/**
 * Visages Dahua : lecture des evenements FaceRecognition / FaceDetection et des bases de visages (findGroup). Jeux d'essai
 * construits d'apres la documentation (voir test/fixtures/dahua-face-README.md), a confirmer sur le vrai XVR (lot V4).
 * Aucun appareil reel n'est contacte : transports injectes et faux serveur sur 127.0.0.1.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createPartParser, DahuaAuthError, parseEventPart } from '../server/dahua.ts';
import type { Credentials } from '../server/dahua.ts';
import { FACE_CODES, fetchFaceGroups, MAX_FACE_DATA, parseFaceEvent, parseFaceGroups } from '../server/faces.ts';
import type { FaceFetchRequest, FaceFetchResponse } from '../server/faces.ts';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');
/** Fixture lue avec des fins de ligne normalisees (extraction CRLF sous Windows). */
const fixture = (name: string) => readFileSync(resolve(FIXTURES, `dahua-face-${name}.txt`), 'utf8').replace(/\r\n/g, '\n');
/** Texte apres « data= » d'une partie, comme le donnera le lot P1 a onObservation. */
const dataOf = (part: string) => {
  const i = part.indexOf('data=');
  return i < 0 ? null : part.slice(i + 5);
};
/** Comme l'appareil : la partie arrive dans un flux multipart, decoupee n'importe ou. */
function viaStream(body: string): string {
  const parts: string[] = [];
  const parse = createPartParser('myboundary', (b) => parts.push(b));
  const wire = Buffer.from(`--myboundary\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}\r\n`);
  for (let i = 0; i < wire.length; i += 13) parse(wire.subarray(i, i + 13));
  assert.equal(parts.length, 1);
  return parts[0];
}
/** Une partie du flux -> observation, par les memes fonctions que le service. */
function observe(body: string, at = 1000, opts?: { minSimilarity?: number }) {
  const ev = parseEventPart(body);
  assert.ok(ev, 'partie reconnue par parseEventPart');
  return parseFaceEvent(ev.code, ev.action, ev.channel, dataOf(body), at, opts);
}
const json = (o: unknown) => JSON.stringify(o);

describe('Visages : evenements FaceRecognition / FaceDetection', () => {
  it('codes suivis', () => {
    assert.deepEqual([...FACE_CODES], ['FaceRecognition', 'FaceDetection']);
  });

  it('personne connue : meilleur candidat, voie = index + 1, aucune donnee en trop (chaine complete flux -> partie -> observation)', () => {
    const obs = observe(viaStream(fixture('recognition-known')), 5000);
    assert.deepEqual(obs, { channel: 5, at: 5000, kind: 'recognized', personId: '5', personName: 'Jean Exemple', groupId: '1', groupName: 'Residents et personnel', similarity: 91 });
    assert.ok(!JSON.stringify(obs).includes('NUMERO-DE-PIECE'), "le numero de piece d'identite n'est jamais lu");
  });

  it('fins de ligne Windows (CRLF) dans le JSON : meme resultat', () => {
    const crlf = fixture('recognition-known').replace(/\n/g, '\r\n');
    assert.deepEqual(observe(viaStream(crlf)), observe(fixture('recognition-known')));
  });

  it("octets apres l'accolade fermante (image JPEG a la suite du JSON) : ignores, et jamais recopies", () => {
    const body = `${fixture('recognition-known')}\r\nÿØÿà JFIF ${'A'.repeat(100_000)}`;
    const ev = parseEventPart(body)!;
    const obs = parseFaceEvent(ev.code, ev.action, ev.channel, dataOf(body), 1);
    assert.equal(obs?.kind, 'recognized');
    assert.equal(obs?.personName, 'Jean Exemple');
    assert.ok(!JSON.stringify(obs).includes('JFIF'));
  });

  it('deux candidats : le plus fort gagne meme en seconde position', () => {
    const obs = observe(fixture('recognition-two-candidates'));
    assert.equal(obs?.kind, 'recognized');
    assert.equal(obs?.personName, 'Paul Fictif');
    assert.equal(obs?.groupName, 'Interdits');
    assert.equal(obs?.similarity, 88);
    assert.equal(obs?.channel, 5);
  });

  it('seuil minSimilarity : sous le seuil -> inconnu ; au-dessus -> le candidat qui le depasse', () => {
    const two = fixture('recognition-two-candidates');
    assert.deepEqual(observe(two, 1, { minSimilarity: 90 }), { channel: 5, at: 1, kind: 'unknown' });
    assert.equal(observe(two, 1, { minSimilarity: 88 })?.personName, 'Paul Fictif');
    assert.equal(observe(two, 1, { minSimilarity: 0 })?.personName, 'Paul Fictif');
    // seuil absurde : ramene dans 0..100, jamais d'exception
    assert.equal(observe(two, 1, { minSimilarity: Number.NaN })?.kind, 'recognized');
    assert.equal(observe(two, 1, { minSimilarity: 1000 })?.kind, 'unknown');
  });

  it('visage inconnu (aucun candidat) -> « unknown » sans personne', () => {
    assert.deepEqual(observe(fixture('recognition-unknown'), 9), { channel: 8, at: 9, kind: 'unknown' });
  });

  it('FaceDetection -> « detected », sans identite', () => {
    assert.deepEqual(observe(fixture('detection'), 3), { channel: 8, at: 3, kind: 'detected' });
    assert.deepEqual(parseFaceEvent('FaceDetection', 'Pulse', 2, null, 3), { channel: 2, at: 3, kind: 'detected' });
  });

  it('Start et Pulse comptent ; Stop et toute autre action : rien (un passage = une observation)', () => {
    const data = json({ Candidates: [{ Similarity: 90, Person: { UID: '1', Name: 'Jean Exemple' } }] });
    assert.equal(parseFaceEvent('FaceRecognition', 'Start', 1, data, 1)?.kind, 'recognized');
    assert.equal(parseFaceEvent('FaceRecognition', 'Pulse', 1, data, 1)?.kind, 'recognized');
    assert.equal(parseFaceEvent('FaceRecognition', 'Stop', 1, data, 1), null);
    assert.equal(parseFaceEvent('FaceRecognition', 'Config', 1, data, 1), null);
    assert.equal(parseFaceEvent('FaceDetection', 'Stop', 1, null, 1), null);
  });

  it('autre code, voie ou date invalides -> null', () => {
    const data = json({ Candidates: [] });
    assert.equal(parseFaceEvent('VideoMotion', 'Start', 1, data, 1), null);
    assert.equal(parseFaceEvent('SmartMotionHuman', 'Pulse', 1, data, 1), null);
    assert.equal(parseFaceEvent('facerecognition', 'Pulse', 1, data, 1), null);
    assert.equal(parseFaceEvent('FaceRecognition', 'Pulse', 0, data, 1), null);
    assert.equal(parseFaceEvent('FaceRecognition', 'Pulse', 1.5, data, 1), null);
    assert.equal(parseFaceEvent('FaceRecognition', 'Pulse', 1, data, Number.NaN), null);
  });

  it('data absent, vide, invalide, tronque, non-objet ou mal forme : null, sans exception', () => {
    const full = dataOf(fixture('recognition-known'))!;
    const bad: (string | null)[] = [null, '', '   ', 'pas du json', '{', '{"Candidates":[', full.slice(0, full.length >> 1), '[]', '"texte"', '123', 'null', '{"a":}', '}{'];
    for (const data of bad) assert.equal(parseFaceEvent('FaceRecognition', 'Pulse', 1, data, 1), null, `data = ${String(data).slice(0, 30)}`);
    // structures inattendues mais JSON d'objet valide : une reconnaissance sans candidat lisible = inconnu
    for (const data of ['{}', '{"Candidates":null}', '{"Candidates":"x"}', '{"Candidates":[1,null,"a",[]]}', '{"Candidates":[{}]}', '{"Candidates":[{"Person":5}]}', '{"Candidates":[{"Person":{"UID":null,"Name":"  "}}]}']) {
      assert.deepEqual(parseFaceEvent('FaceRecognition', 'Pulse', 1, data, 1), { channel: 1, at: 1, kind: 'unknown' }, data);
    }
  });

  it('trop gros (objet JSON > 64 Kio) -> null, sans lire le reste', () => {
    const huge = json({ Candidates: [{ Similarity: 90, Person: { UID: '1', Name: 'x'.repeat(MAX_FACE_DATA) } }] });
    assert.ok(huge.length > MAX_FACE_DATA);
    assert.equal(parseFaceEvent('FaceRecognition', 'Pulse', 1, huge, 1), null);
    assert.equal(parseFaceEvent('FaceDetection', 'Pulse', 1, huge, 1), null);
    const manyCandidates = json({ Candidates: Array.from({ length: 5000 }, (_, i) => ({ Similarity: 50, Person: { UID: String(i), Name: `P${i}` } })) });
    assert.equal(parseFaceEvent('FaceRecognition', 'Pulse', 1, manyCandidates, 1), null);
  });

  it('donnees hostiles : __proto__ sans effet, controles et sens d\'ecriture retires, nom borne, similarites absurdes ignorees, photo non recopiee', () => {
    const body = fixture('hostile');
    const obs = observe(body);
    // Candidats 1 (9999), 2 (« 100 » chaine), 3 (-5) : similarite ignoree ; seul le 4 (77) en a une valide -> il est le meilleur.
    assert.equal(obs?.kind, 'recognized');
    assert.equal(obs?.personId, '4');
    assert.equal(obs?.similarity, 77);
    assert.ok(obs!.personName!.length <= 80);
    assert.match(obs!.personName!, /^Quatrieme Tres/);
    const text = JSON.stringify(obs);
    assert.ok(!/Pirate|Intrus|666/.test(text), 'ce qui est sous __proto__ / constructor est ignore');
    assert.ok(!/9jAAQ|\/9j\/|SceneImage|FilePath|photo/.test(text), 'aucune photo, aucun chemin');
    assert.equal(Object.getPrototypeOf(obs), Object.prototype);
    assert.equal(({} as Record<string, unknown>).Name, undefined, 'le prototype commun n\'a pas ete pollue');
  });

  it('noms nettoyes : controles retires, espaces normalises, balises laissees telles quelles (non interpretees ici)', () => {
    const data = json({ Candidates: [{ Similarity: 80, Person: { UID: 'u\u0001-1', Name: 'A\u0007B\u202eC\u200bD  \n  E<b>x</b>', GroupID: 7, GroupName: 'Base \u0000 piege' } }] });
    const obs = parseFaceEvent('FaceRecognition', 'Pulse', 1, data, 1);
    assert.deepEqual(obs, { channel: 1, at: 1, kind: 'recognized', personId: 'u-1', personName: 'ABCD E<b>x</b>', groupId: '7', groupName: 'Base piege', similarity: 80 });
    const long = parseFaceEvent('FaceRecognition', 'Pulse', 1, json({ Candidates: [{ Person: { UID: 'i'.repeat(500), Name: 'n'.repeat(5000), GroupName: 'g'.repeat(900) } }] }), 1);
    assert.equal(long?.personName?.length, 80);
    assert.equal(long?.personId?.length, 64);
    assert.equal(long?.groupName?.length, 80);
    assert.equal(long?.similarity, undefined);
    const emoji = parseFaceEvent('FaceRecognition', 'Pulse', 1, json({ Candidates: [{ Person: { UID: '1', Name: '\u{1F600}'.repeat(200) } }] }), 1);
    assert.equal(Array.from(emoji!.personName!).length, 80, 'coupe en caracteres, jamais au milieu d\'un emoji');
  });

  it('similarite : entier 0-100 ; fraction 0-1 convertie ; NaN, negatif, >100, chaine, objet : ignores (jamais ramenes a 100)', () => {
    const sim = (value: unknown) => parseFaceEvent('FaceRecognition', 'Pulse', 1, json({ Candidates: [{ Similarity: value, Person: { UID: '1' } }] }), 1)?.similarity;
    assert.equal(sim(0), 0);
    assert.equal(sim(100), 100);
    assert.equal(sim(91), 91);
    assert.equal(sim(87.5), 87.5);
    assert.equal(sim(0.93), 93);
    for (const bad of [-1, 100.5, 101, 5000, 'abc', '90', null, {}, [], true]) assert.equal(sim(bad), undefined, String(bad));
    assert.equal(sim(Number.NaN), undefined); // NaN serialise en null par JSON.stringify
    // NaN / Infinity litteraux : pas du JSON valide
    assert.equal(parseFaceEvent('FaceRecognition', 'Pulse', 1, '{"Candidates":[{"Similarity":NaN,"Person":{"UID":"1"}}]}', 1), null);
    assert.equal(parseFaceEvent('FaceRecognition', 'Pulse', 1, '{"Candidates":[{"Similarity":Infinity,"Person":{"UID":"1"}}]}', 1), null);
  });

  it('variantes de noms de champs : Person en tableau, champs dans le candidat, PersonID/PersonName, candidats dans Face, candidat seul', () => {
    const ev = (data: unknown) => parseFaceEvent('FaceRecognition', 'Pulse', 3, json(data), 7);
    assert.deepEqual(ev({ Candidates: [{ Similarity: 90, Person: [{ PersonID: 12, PersonName: 'Marie Exemple', GroupID: 3 }] }] }), {
      channel: 3,
      at: 7,
      kind: 'recognized',
      personId: '12',
      personName: 'Marie Exemple',
      groupId: '3',
      similarity: 90,
    });
    assert.equal(ev({ Candidates: [{ Similarity: 90, UID: 'x', Name: 'Direct' }] })?.personName, 'Direct');
    assert.equal(ev({ Face: { Candidates: [{ Similarity: 70, Person: { UID: '9', Name: 'Dans Face' } }] } })?.personName, 'Dans Face');
    assert.equal(ev({ Object: { Candidates: [{ Similarity: 70, Person: { UID: '9', Name: 'Dans Object' } }] } })?.personName, 'Dans Object');
    assert.equal(ev({ Candidates: { Similarity: 0.5, Person: { UID: '9', Name: 'Seul' } } })?.personName, 'Seul');
    assert.equal(ev({ Candidates: [{ Similarity: 90, Person: { UID: 'a', Name: 'A' } }], Face: { Candidates: [{ Similarity: 99, Person: { UID: 'b', Name: 'B' } }] } })?.personName, 'A', 'la racine prime');
    // Personne sans similarite lisible mais identifiee : reconnue (l'appareil a deja decide), sans similarite
    assert.deepEqual(ev({ Candidates: [{ Person: { UID: '1', Name: 'Sans score' } }] }), { channel: 3, at: 7, kind: 'recognized', personId: '1', personName: 'Sans score' });
    // ... mais avec un seuil exige, un candidat sans score ne passe pas
    assert.equal(parseFaceEvent('FaceRecognition', 'Pulse', 3, json({ Candidates: [{ Person: { UID: '1', Name: 'Sans score' } }] }), 7, { minSimilarity: 50 })?.kind, 'unknown');
  });
});

describe('Visages : bases de visages (findGroup)', () => {
  it('fixture a deux bases : ordre d\'apparition, taille lue', () => {
    assert.deepEqual(parseFaceGroups(fixture('groups')), [
      { id: '1', name: 'Residents et personnel', size: 12 },
      { id: '2', name: 'Interdits', size: 0 },
    ]);
  });

  it('CRLF ou LF : meme resultat', () => {
    const lf = fixture('groups');
    assert.deepEqual(parseFaceGroups(lf.replace(/\n/g, '\r\n')), parseFaceGroups(lf));
  });

  it('texte vide (reponse « 200, vide » du vrai XVR) -> aucune base', () => {
    assert.deepEqual(parseFaceGroups(fixture('groups-empty')), []);
    assert.deepEqual(parseFaceGroups(''), []);
    assert.deepEqual(parseFaceGroups('\r\n\r\n'), []);
  });

  it('lignes inconnues ignorees ; base sans identifiant ignoree ; sans nom, elle porte son identifiant ; variantes de casse et de prefixe', () => {
    const text = ['found=3', 'GroupList[0].groupName=Sans id', 'blabla', 'GroupList[1].groupID=7', 'table.groupList[2].GroupID=8', 'table.groupList[2].GroupName=Autre casse', 'table.groupList[2].GroupSize=3', 'GroupList[2].inconnu=1', 'GroupList[x].groupID=9'].join('\n');
    assert.deepEqual(parseFaceGroups(text), [
      { id: '7', name: '7' },
      { id: '8', name: 'Autre casse', size: 3 },
    ]);
  });

  it('taille invalide ignoree, noms nettoyes et bornes, nombre de bases borne, aucune pollution du prototype', () => {
    const lines = ['GroupList[0].groupID=1', 'GroupList[0].groupName=Ba\u0007se' + 'x'.repeat(500), 'GroupList[0].groupSize=-3', 'GroupList[1].groupID=2', 'GroupList[1].groupSize=abc'];
    const [a, b] = parseFaceGroups(lines.join('\n'));
    assert.equal(a.name.length, 80);
    assert.match(a.name, /^Basexxx/);
    assert.equal(a.size, undefined);
    assert.equal(b.size, undefined);
    const many = Array.from({ length: 200 }, (_, i) => `GroupList[${i}].groupID=${i}`).join('\n');
    assert.equal(parseFaceGroups(many).length, 64);
    assert.deepEqual(parseFaceGroups('GroupList[0].__proto__=x\nGroupList[0].groupID=1\n__proto__.groupID=2\nconstructor[0].groupID=3'), [{ id: '1', name: '1' }]);
    assert.equal(parseFaceGroups('x'.repeat(2_000_000)).length, 0);
    assert.deepEqual(parseFaceGroups(`${'GroupList[0].groupID=1\n'.repeat(100_000)}`).length, 1);
  });
});

// ---------------------------------------------------------------- findGroup : Digest

const creds: Credentials = { host: '192.0.2.1', port: 80, username: 'psim', password: 'Mot-de-passe-secret-XYZ' };
const CHALLENGE = 'Digest realm="Login to XVR", qop="auth", nonce="abc123", opaque="op"';
const reply = (status: number, body = '', headers: Record<string, string[]> = {}): FaceFetchResponse => ({ status, headers, body });

function scripted(...responses: (FaceFetchResponse | Error)[]) {
  const calls: FaceFetchRequest[] = [];
  const request = async (o: FaceFetchRequest) => {
    calls.push(o);
    const next = responses.shift();
    if (!next) throw new Error('appel inattendu');
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, request };
}

describe('Visages : fetchFaceGroups (transport injecte)', () => {
  it('401 puis 200 : reprise Digest sur le bon chemin, mot de passe jamais en clair', async () => {
    const t = scripted(reply(401, '', { 'www-authenticate': [CHALLENGE] }), reply(200, fixture('groups')));
    const groups = await fetchFaceGroups(creds, { request: t.request });
    assert.deepEqual(groups, [
      { id: '1', name: 'Residents et personnel', size: 12 },
      { id: '2', name: 'Interdits', size: 0 },
    ]);
    assert.equal(t.calls.length, 2);
    assert.equal(t.calls[0].path, '/cgi-bin/faceRecognitionServer.cgi?action=findGroup');
    assert.deepEqual(t.calls[0].headers, {}, '1re requete sans Authorization');
    assert.equal(t.calls[0].host, '192.0.2.1');
    assert.equal(t.calls[0].port, 80);
    assert.ok(t.calls[0].timeoutMs > 0 && t.calls[0].timeoutMs <= 10_000);
    const auth = t.calls[1].headers.Authorization;
    assert.match(auth, /^Digest /);
    assert.match(auth, /username="psim"/);
    assert.match(auth, /response="[0-9a-f]{32}"/);
    assert.match(auth, /uri="\/cgi-bin\/faceRecognitionServer\.cgi\?action=findGroup"/);
    assert.ok(!auth.includes(creds.password));
    assert.ok(!/^Basic/i.test(auth));
  });

  it('en-tete WWW-Authenticate en majuscules ou en plusieurs defis : accepte', async () => {
    const t = scripted(reply(401, '', { 'WWW-Authenticate': ['Digest realm="R", qop="auth", algorithm=SHA-256, nonce="n1"', CHALLENGE] }), reply(200, ''));
    assert.deepEqual(await fetchFaceGroups(creds, { request: t.request }), []);
    assert.match(t.calls[1].headers.Authorization, /nonce="abc123"/, 'MD5 choisi parmi les defis');
  });

  it('200 sans authentification demandee, vide : aucune base', async () => {
    const t = scripted(reply(200, ''));
    assert.deepEqual(await fetchFaceGroups(creds, { request: t.request }), []);
    assert.equal(t.calls.length, 1);
  });

  it('second 401 -> DahuaAuthError « identifiants refuses », sans le mot de passe et sans troisieme essai', async () => {
    const t = scripted(reply(401, '', { 'www-authenticate': [CHALLENGE] }), reply(401, '', { 'www-authenticate': [CHALLENGE] }), reply(200, ''));
    await assert.rejects(
      () => fetchFaceGroups(creds, { request: t.request }),
      (err: unknown) => {
        assert.ok(err instanceof DahuaAuthError);
        assert.match((err as Error).message, /identifiants refuses/);
        assert.ok(!(err as Error).message.includes(creds.password));
        return true;
      },
    );
    assert.equal(t.calls.length, 2);
  });

  it('401 sans defi, ou defi Basic : refuse (jamais de mot de passe en clair)', async () => {
    await assert.rejects(() => fetchFaceGroups(creds, { request: scripted(reply(401)).request }), DahuaAuthError);
    const t = scripted(reply(401, '', { 'www-authenticate': ['Basic realm="cam"'] }));
    await assert.rejects(() => fetchFaceGroups(creds, { request: t.request }), (err: unknown) => err instanceof DahuaAuthError && /Basic/.test((err as Error).message));
    assert.equal(t.calls.length, 1);
  });

  it('404 / 501 : « ne propose pas la reconnaissance faciale » ; autre statut : refus lisible avec le code', async () => {
    await assert.rejects(() => fetchFaceGroups(creds, { request: scripted(reply(404)).request }), /ne propose pas la reconnaissance faciale/);
    await assert.rejects(() => fetchFaceGroups(creds, { request: scripted(reply(501)).request }), /ne propose pas la reconnaissance faciale/);
    await assert.rejects(() => fetchFaceGroups(creds, { request: scripted(reply(500)).request }), /refus de l'appareil \(HTTP 500\)/);
    await assert.rejects(() => fetchFaceGroups(creds, { request: scripted(reply(302)).request }), /HTTP 302/);
  });

  it('erreur reseau : message en clair, sans adresse ni mot de passe', async () => {
    const refused = Object.assign(new Error(`connect ECONNREFUSED ${creds.host}:80 pass=${creds.password}`), { code: 'ECONNREFUSED' });
    await assert.rejects(
      () => fetchFaceGroups(creds, { request: scripted(refused).request }),
      (err: unknown) => {
        const m = (err as Error).message;
        assert.match(m, /connexion refusee/);
        assert.ok(!m.includes(creds.password) && !m.includes(creds.host));
        return true;
      },
    );
    await assert.rejects(() => fetchFaceGroups(creds, { request: scripted(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).request }), /pas de reponse de l'appareil/);
    await assert.rejects(() => fetchFaceGroups(creds, { request: scripted(new Error('inconnue')).request }), /erreur reseau/);
  });

  it("nom d'utilisateur impossible en Digest (accents) : refus explique", async () => {
    const t = scripted(reply(401, '', { 'www-authenticate': [CHALLENGE] }));
    await assert.rejects(() => fetchFaceGroups({ ...creds, username: 'gardien€' }, { request: t.request }), DahuaAuthError);
  });
});

// ---------------------------------------------------------------- faux enregistreur (transport par defaut)

const USER = 'psim';
const PASSWORD = 'MotDePasse-XVR-1';

function fakeRecorder() {
  const md5 = (s: string) => createHash('md5').update(s).digest('hex');
  const realm = 'Login to XVR';
  const nonce = randomBytes(8).toString('hex');
  const seen: string[] = [];
  let mode: 'groups' | 'empty' | 'missing' | 'big' = 'groups';
  const server = createServer((req, res) => {
    seen.push(String(req.url));
    const auth = String(req.headers.authorization ?? '');
    const p = Object.fromEntries([...auth.matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1], m[2]]));
    const expected = md5(`${md5(`${USER}:${realm}:${PASSWORD}`)}:${nonce}:${p.nc}:${p.cnonce}:auth:${md5(`GET:${p.uri}`)}`);
    if (!auth.startsWith('Digest') || p.username !== USER || p.response !== expected || p.uri !== req.url) {
      res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}", opaque="abc"` }).end();
      return;
    }
    if (req.url !== '/cgi-bin/faceRecognitionServer.cgi?action=findGroup' || mode === 'missing') return void res.writeHead(404).end();
    if (mode === 'big') return void res.writeHead(200, { 'Content-Type': 'text/plain' }).end('x'.repeat(400 * 1024));
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(mode === 'empty' ? '' : fixture('groups').replace(/\n/g, '\r\n'));
  });
  return {
    start: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port))),
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
    seen,
    setMode: (m: typeof mode) => (mode = m),
  };
}

describe('Visages : findGroup contre un faux enregistreur Dahua (transport par defaut, Digest exige)', () => {
  const xvr = fakeRecorder();
  let port = 0;
  before(async () => {
    port = await xvr.start();
  });
  after(() => xvr.stop());

  it('Digest accepte : deux bases lues (reponse CRLF)', async () => {
    xvr.setMode('groups');
    const groups = await fetchFaceGroups({ host: '127.0.0.1', port, username: USER, password: PASSWORD });
    assert.deepEqual(groups, [
      { id: '1', name: 'Residents et personnel', size: 12 },
      { id: '2', name: 'Interdits', size: 0 },
    ]);
    assert.ok(xvr.seen.length >= 2 && xvr.seen.every((u) => u === '/cgi-bin/faceRecognitionServer.cgi?action=findGroup'));
  });

  it('200 vide : aucune base ; 404 : pas de reconnaissance faciale ; reponse enorme : refusee', async () => {
    xvr.setMode('empty');
    assert.deepEqual(await fetchFaceGroups({ host: '127.0.0.1', port, username: USER, password: PASSWORD }), []);
    xvr.setMode('missing');
    await assert.rejects(() => fetchFaceGroups({ host: '127.0.0.1', port, username: USER, password: PASSWORD }), /ne propose pas la reconnaissance faciale/);
    xvr.setMode('big');
    await assert.rejects(() => fetchFaceGroups({ host: '127.0.0.1', port, username: USER, password: PASSWORD }), /trop grande/);
  });

  it('mauvais mot de passe : DahuaAuthError (un seul nouvel essai), jamais le mot de passe dans le message', async () => {
    xvr.setMode('groups');
    const before = xvr.seen.length;
    await assert.rejects(
      () => fetchFaceGroups({ host: '127.0.0.1', port, username: USER, password: 'mauvais-mot-de-passe' }),
      (err: unknown) => err instanceof DahuaAuthError && !(err as Error).message.includes('mauvais-mot-de-passe'),
    );
    assert.equal(xvr.seen.length - before, 2);
  });

  it('appareil absent (port ferme) : erreur lisible', async () => {
    await assert.rejects(() => fetchFaceGroups({ host: '127.0.0.1', port: 1, username: USER, password: PASSWORD }), /connexion refusee|erreur reseau/);
  });
});
