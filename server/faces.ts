/**
 * Visages vus par un enregistreur ou une camera Dahua : lecture des evenements « FaceRecognition » / « FaceDetection » du
 * flux eventManager.cgi (champ `data`, JSON) et des bases de visages de l'appareil (faceRecognitionServer.cgi?action=findGroup).
 *
 * Sources consultees (lot V1) :
 *  - exemple REEL de partie « Code=FaceRecognition;action=Start;index=10;data={...} » d'un NVR DHI-NVR2116HS-I/L, publie dans
 *    https://github.com/rroller/dahua/issues/573 : `Candidates[]` { `Similarity` (entier 0-100), `Person` { `UID` (chaine),
 *    `PersonID` (nombre), `GroupID` (chaine), `Name`, `GroupName`, `Sex`, ... } } au niveau racine ET repete dans `Face` et
 *    `Object` ; `UTC`, `Sequence`, `Class="FaceAnalysis"`. Le champ `ID` d'une personne est un numero de piece d'identite :
 *    on ne le lit JAMAIS ;
 *  - liste des codes d'evenements (FaceDetection = « face detect event », FaceRecognition = « face recognition event ») : Dahua HTTP
 *    API (https://pdfcoffee.com/dahua-http-api-v2841-pdf-2-pdf-free.html et https://www.scribd.com/document/634233019/DAHUA-HTTP-API-V2-841-pdf,
 *    resumes de recherche : pages non lisibles directement), et `snapManager.cgi?...Events=[FaceDetection]` dans
 *    https://files.dahua.support/Solutions/Access%20Control%20Solution/NCAC-%20Non%20Contact%20Access%20Control%20with%20thermal%20module/Integration/Dahua%20Epidemic%20Prevention%20Solution%20-%20Integration%20Protocol-.pdf ;
 *  - chemin `faceRecognitionServer.cgi?action=findGroup` (sans `groupID` : toutes les bases) : extrait de la doc HTTP API
 *    (resume de recherche) et client tiers https://github.com/brainofcoco/itips-v2-ai (v2/itips/camera/dahua_face_db.py, qui cite
 *    la « Dahua HTTP API V3.98 ») ; ce client lit des lignes « GroupList[N].champ=valeur » ;
 *  - mise en garde : https://github.com/Betotradicao/KONTRATA.AI (API_INTELBRAS/FACE_RECOGNITION_API_GUIDE.md) rapporte un
 *    enregistreur dont tous les CGI visage repondent 501 : la gestion des bases s'y fait par un autre protocole.
 * Non confirme par la documentation consultee : le format exact des lignes de findGroup (casse des noms, champ de taille), le
 * contenu d'un FaceDetection, et le comportement du vrai XVR (aujourd'hui : « 200, vide » = aucune base). Les jeux d'essai
 * (test/fixtures/dahua-face-*) sont CONSTRUITS d'apres ces sources et sont a confirmer sur le vrai XVR (lot V4).
 *
 * Variantes de noms acceptees (les fiches Dahua varient selon les versions) : `Candidates` a la racine, sinon dans `Face` ou
 * `Object` (objet seul accepte comme liste d'un element) ; `Person` objet ou tableau (ou champs directement dans le candidat) ;
 * identifiant `UID` puis `PersonID` ; nom `Name` puis `PersonName` ; `GroupID`/`GroupName` chaine ou nombre ; similarite
 * entiere 0-100 ou fraction 0-1.
 *
 * Surete :
 *  - ne leve jamais d'exception sur une donnee de l'appareil (hostile, tronquee, trop grosse) : null, ou « inconnu » si c'est
 *    bien une reconnaissance sans candidat ;
 *  - les photos (base64 ou octets apres le JSON) ne sont jamais recopiees : seuls des champs connus sont lus, par cle propre
 *    (`__proto__` et consorts n'ont aucun effet) ;
 *  - noms et identifiants nettoyes (controles, marques de sens d'ecriture, espaces) et bornes ; ils ne sont pas echappes ici :
 *    celui qui les affiche doit le faire ;
 *  - la similarite hors plage est IGNOREE (jamais ramenee a 100 : une valeur absurde ne doit pas passer pour une certitude) ;
 *  - lecture des bases : Digest seulement (jamais Basic), delai et taille de reponse bornes, le mot de passe n'apparait dans
 *    aucune erreur.
 */
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { authorization, DahuaAuthError } from './dahua.ts';
import type { Credentials } from './dahua.ts';

/** Evenements Dahua qui concernent les visages. */
export const FACE_CODES = ['FaceRecognition', 'FaceDetection'] as const;

export interface FaceObservation {
  /** Voie, a partir de 1 (meme convention que parseEventPart). */
  channel: number;
  /** ms epoch, fourni par l'appelant. */
  at: number;
  kind: 'recognized' | 'unknown' | 'detected';
  personId?: string;
  personName?: string;
  groupId?: string;
  groupName?: string;
  /** 0..100 (pourcentage). */
  similarity?: number;
}

export interface FaceGroup {
  id: string;
  name: string;
  size?: number;
}

/** Un objet JSON de `data` plus gros que cela est refuse (une vraie reponse en fait quelques Kio). */
export const MAX_FACE_DATA = 64 * 1024;
const MAX_NAME = 80;
const MAX_ID = 64;
const MAX_CANDIDATES = 32;
const MAX_GROUPS = 64;
const MAX_GROUP_TEXT = 128 * 1024;
const MAX_RESPONSE = 256 * 1024;
const TIMEOUT_MS = 10_000;
const GROUPS_PATH = '/cgi-bin/faceRecognitionServer.cgi?action=findGroup';

// ---------------------------------------------------------------- lecture d'un evenement

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Lecture par cle PROPRE seulement : rien d'herite de Object.prototype, et `__proto__` n'est jamais suivi. */
function own(o: Obj, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** Texte de personne ou de base : controles supprimes, espaces normalises, longueur bornee (en caracteres, sans couper un emoji). */
function cleanText(value: unknown, max: number): string | undefined {
  let s: string;
  if (typeof value === 'string') s = value;
  else if (typeof value === 'number' && Number.isFinite(value)) s = String(value);
  else return undefined;
  s = s
    .replace(/[\t\n\r\v\f\u0085\u2028\u2029]/g, ' ') // retours a la ligne et tabulations -> espace
    .replace(/[\p{Cc}\p{Cf}]/gu, '') // autres controles, marques de sens d'ecriture (U+202E...), espaces de largeur nulle
    .replace(/\s+/gu, ' ')
    .trim();
  if (s.length > max * 2) s = s.slice(0, max * 2); // evite de decouper un tres long texte en entier
  const chars = Array.from(s);
  if (chars.length > max) s = chars.slice(0, max).join('').trim();
  return s === '' ? undefined : s;
}

/** Pourcentage 0..100, ou undefined. Une fraction non entiere de ]0,1[ est lue comme un taux ; tout le reste hors plage est ignore. */
function similarityOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const pct = value > 0 && value < 1 ? value * 100 : value;
  if (pct < 0 || pct > 100) return undefined;
  return Math.round(pct * 100) / 100;
}

/**
 * Isole l'objet JSON qui ouvre `data` : le corps d'une partie peut se prolonger apres l'accolade fermante (octets d'image,
 * fins de ligne). Parcours borne a MAX_FACE_DATA caracteres ; un objet qui ne se ferme pas dans cette limite est refuse.
 */
function leadingObject(data: string): string | null {
  let i = 0;
  while (i < data.length && i < 1024 && /\s/.test(data[i])) i += 1;
  if (data[i] !== '{') return null;
  const end = Math.min(data.length, i + MAX_FACE_DATA);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = i; j < end; j += 1) {
    const c = data[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return data.slice(i, j + 1);
    }
  }
  return null; // tronque ou trop gros
}

function parseData(data: string | null): Obj | null {
  if (typeof data !== 'string' || data.trim() === '') return null;
  const text = leadingObject(data);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Liste de candidats : a la racine, sinon dans `Face` puis `Object` (le meme resultat y est repete par l'appareil). */
function candidatesOf(root: Obj): unknown[] {
  for (const holder of [root, own(root, 'Face'), own(root, 'Object')]) {
    if (!isObj(holder)) continue;
    const list = own(holder, 'Candidates');
    if (Array.isArray(list)) return list.slice(0, MAX_CANDIDATES);
    if (isObj(list)) return [list]; // variante : un seul candidat sans tableau
  }
  return [];
}

interface Candidate {
  similarity?: number;
  personId?: string;
  personName?: string;
  groupId?: string;
  groupName?: string;
}

/** Un candidat sans identite lisible (ni identifiant, ni nom) n'identifie personne. */
function candidateOf(raw: unknown): Candidate | null {
  if (!isObj(raw)) return null;
  const personRaw = own(raw, 'Person');
  // `Person` : objet, tableau (premier objet), ou absent (champs dans le candidat lui-meme).
  const person = isObj(personRaw) ? personRaw : Array.isArray(personRaw) ? personRaw.find(isObj) : raw;
  if (!isObj(person)) return null;
  // `ID` (numero de piece d'identite) n'est volontairement jamais lu.
  const personId = cleanText(own(person, 'UID'), MAX_ID) ?? cleanText(own(person, 'PersonID'), MAX_ID);
  const personName = cleanText(own(person, 'Name'), MAX_NAME) ?? cleanText(own(person, 'PersonName'), MAX_NAME);
  if (personId === undefined && personName === undefined) return null;
  return {
    similarity: similarityOf(own(raw, 'Similarity') ?? own(person, 'Similarity')),
    personId,
    personName,
    groupId: cleanText(own(person, 'GroupID'), MAX_ID),
    groupName: cleanText(own(person, 'GroupName'), MAX_NAME),
  };
}

/**
 * Evenement de la partie « Code=...;action=...;index=...;data=... » -> observation de visage, ou null.
 *
 * Une observation = un « Start » ou un « Pulse » (un visage vient d'etre vu) ; « Stop » et toute autre action (configuration...)
 * ne comptent pas : sinon un meme passage serait compte deux fois. Dahua envoie un « Start » pour une reconnaissance sur
 * certains appareils (exemple reel : action=Start), un « Pulse » sur d'autres : les deux sont acceptes.
 *
 * `minSimilarity` (0 par defaut) : l'appareil applique deja son propre seuil (reglage de la base sur la voie), les observations
 * qu'il nous envoie sont donc deja des correspondances ; un seuil plus haut ici ne sert qu'a durcir (ex. 80).
 * FaceDetection : « un visage est la », aucune identite ; son JSON n'est pas lu.
 */
export function parseFaceEvent(code: string, action: string, channel: number, data: string | null, at: number, opts: { minSimilarity?: number } = {}): FaceObservation | null {
  try {
    if (code !== 'FaceRecognition' && code !== 'FaceDetection') return null;
    if (!/^(start|pulse)$/i.test(action)) return null;
    if (!Number.isInteger(channel) || channel < 1 || !Number.isFinite(at)) return null;
    if (typeof data === 'string' && data.length > MAX_FACE_DATA && leadingObject(data) === null) return null;
    if (code === 'FaceDetection') return { channel, at, kind: 'detected' };
    const root = parseData(data);
    if (root === null) return null;
    const min = typeof opts.minSimilarity === 'number' && Number.isFinite(opts.minSimilarity) ? Math.min(100, Math.max(0, opts.minSimilarity)) : 0;
    let best: Candidate | null = null;
    for (const raw of candidatesOf(root)) {
      const c = candidateOf(raw);
      if (!c) continue;
      if (min > 0 && (c.similarity === undefined || c.similarity < min)) continue;
      if (!best || (c.similarity ?? -1) > (best.similarity ?? -1)) best = c;
    }
    if (!best) return { channel, at, kind: 'unknown' };
    const obs: FaceObservation = { channel, at, kind: 'recognized' };
    if (best.personId !== undefined) obs.personId = best.personId;
    if (best.personName !== undefined) obs.personName = best.personName;
    if (best.groupId !== undefined) obs.groupId = best.groupId;
    if (best.groupName !== undefined) obs.groupName = best.groupName;
    if (best.similarity !== undefined) obs.similarity = best.similarity;
    return obs;
  } catch {
    return null; // filet : une donnee d'appareil ne doit jamais faire tomber la lecture du flux
  }
}

// ---------------------------------------------------------------- bases de visages

/**
 * Reponse « cle=valeur » de findGroup -> bases, dans l'ordre d'apparition. Lignes « groupList[N].champ=valeur » (prefixe
 * « table. » et casse indifferents) avec les champs GroupID, GroupName et GroupSize ; le reste est ignore. Une base sans
 * identifiant est ignoree ; sans nom, elle porte son identifiant. Texte vide = aucune base (reponse actuelle du vrai XVR).
 */
export function parseFaceGroups(text: string): FaceGroup[] {
  if (typeof text !== 'string' || text === '') return [];
  let body = text;
  if (body.length > MAX_GROUP_TEXT) body = body.slice(0, body.lastIndexOf('\n', MAX_GROUP_TEXT) + 1);
  const byIndex = new Map<number, { id?: string; name?: string; size?: number }>();
  for (const line of body.split(/\r\n|\r|\n/)) {
    const m = /^\s*(?:table\.)?(?:groupList|groups?)\[(\d{1,3})\]\.(\w{1,32})\s*=(.*)$/i.exec(line);
    if (!m) continue;
    const index = Number(m[1]);
    const field = m[2].toLowerCase();
    if (field !== 'groupid' && field !== 'groupname' && field !== 'groupsize') continue;
    let entry = byIndex.get(index);
    if (!entry) {
      if (byIndex.size >= MAX_GROUPS) continue;
      entry = {};
      byIndex.set(index, entry);
    }
    if (field === 'groupid') entry.id = cleanText(m[3], MAX_ID);
    else if (field === 'groupname') entry.name = cleanText(m[3], MAX_NAME);
    else if (/^\s*\d{1,9}\s*$/.test(m[3])) entry.size = Number(m[3]);
  }
  const groups: FaceGroup[] = [];
  for (const e of byIndex.values()) {
    if (e.id === undefined) continue;
    const group: FaceGroup = { id: e.id, name: e.name ?? e.id };
    if (e.size !== undefined) group.size = e.size;
    groups.push(group);
  }
  return groups;
}

export interface FaceFetchRequest {
  host: string;
  port: number;
  path: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface FaceFetchResponse {
  status: number;
  /** Noms en minuscules, valeurs multiples en tableau (plusieurs « WWW-Authenticate »). */
  headers: Record<string, string[]>;
  body: string;
}

export interface FaceFetchDeps {
  /** Pour les tests : transport (par defaut node:http, delai 10 s, reponse bornee a 256 Kio). */
  request?: (o: FaceFetchRequest) => Promise<FaceFetchResponse>;
}

/** Message d'erreur en clair, sans jamais le mot de passe ni l'adresse complete. */
function explain(err: unknown): string {
  const code = (err as { code?: string }).code;
  if (code === 'ECONNREFUSED') return "connexion refusee (port HTTP de l'appareil ferme ?)";
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'appareil injoignable (reseau, VPN ?)';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return "pas de reponse de l'appareil";
  if (code === 'ECONNRESET') return "connexion coupee par l'appareil";
  if (code === 'ERESPONSETOOBIG') return "reponse de l'appareil trop grande";
  return 'erreur reseau';
}

/** Transport par defaut : un GET, delai total borne (un appareil qui goutte-a-goutte ne bloque pas), corps borne. */
function httpRequest(o: FaceFetchRequest): Promise<FaceFetchResponse> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const req = request({ host: o.host, port: o.port, path: o.path, method: 'GET', headers: o.headers, timeout: o.timeoutMs });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), o.timeoutMs);
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => finish(() => reject(err)));
    req.on('response', (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE) {
          req.destroy(Object.assign(new Error('too big'), { code: 'ERESPONSETOOBIG' }));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(() => resolve({ status: res.statusCode ?? 0, headers: res.headersDistinct as Record<string, string[]>, body: Buffer.concat(chunks).toString('utf8') })));
      res.on('error', (err) => finish(() => reject(err)));
      res.on('close', () => finish(() => reject(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))));
    });
    req.end();
  });
}

function challengesOf(headers: Record<string, string[]>): string[] {
  for (const [name, values] of Object.entries(headers)) if (name.toLowerCase() === 'www-authenticate') return values;
  return [];
}

/**
 * Bases de visages de l'appareil (findGroup). Authentification Digest : une premiere requete sans identifiants, reprise
 * avec la reponse au defi ; un second refus = identifiants refuses (DahuaAuthError, a ne pas retenter en rafale : le compte de
 * l'appareil se bloque). Reponse vide = aucune base.
 */
export async function fetchFaceGroups(creds: Credentials, deps: FaceFetchDeps = {}): Promise<FaceGroup[]> {
  const send = deps.request ?? httpRequest;
  const call = async (auth: string | null): Promise<FaceFetchResponse> => {
    try {
      return await send({ host: creds.host, port: creds.port, path: GROUPS_PATH, headers: auth ? { Authorization: auth } : {}, timeoutMs: TIMEOUT_MS });
    } catch (err) {
      throw new Error(explain(err)); // jamais le message brut : il pourrait citer l'adresse
    }
  };
  let res = await call(null);
  if (res.status === 401) {
    const challenges = challengesOf(res.headers);
    if (challenges.length === 0) throw new DahuaAuthError("identifiants refuses par l'appareil (ceux de la camera)");
    res = await call(authorization(challenges, creds.username, creds.password, GROUPS_PATH));
    if (res.status === 401) throw new DahuaAuthError("identifiants refuses par l'appareil (ceux de la camera)");
  }
  if (res.status === 404 || res.status === 501) throw new Error("l'appareil ne propose pas la reconnaissance faciale (faceRecognitionServer.cgi)");
  if (res.status !== 200) throw new Error(`refus de l'appareil (HTTP ${res.status})`);
  return parseFaceGroups(res.body);
}
