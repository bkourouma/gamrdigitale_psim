/**
 * Verifie HORS LIGNE un dossier de preuve exporte par le PSIM (server/proofpack.ts), sans acces a la base ni au PSIM.
 *
 *   npm run verify-proof -- dossier-preuve-incident-12-20260210-093000.zip
 *   npm run verify-proof -- dossier.zip --anchor 1234:ab12...   (empreinte du journal conservee AILLEURS : rapport e-mail)
 *   npm run verify-proof -- dossier.zip --sha256 <empreinte>     (empreinte du .zip relevee au journal du PSIM, action export_preuve)
 *
 * Controles : empreinte de chaque fichier contre MANIFEST.sha256 (fichier modifie, ajoute, supprime) ; chaine du
 * journal-extrait (chaque entree recalculee a partir de l'empreinte precedente, liaison des entrees consecutives) ;
 * chaque image contre l'empreinte SCELLEE dans une entree « image_scellee » du journal-extrait ; coherence entre
 * incident.json et le journal ; ancre eventuellement fournie.
 *
 * Le fichier est traite comme NON FIABLE : zip tronque, entrees dupliquees, noms pieges (`../`), bombe de decompression
 * sont refuses (voir server/zip.ts). Rien n'est extrait sur le disque.
 *
 * Code de sortie 0 : tout est conforme ; 1 : dossier altere, refuse, anomalie signalee ou ancre non comparable ;
 * 2 : erreur d'usage. LIMITE : sans ancre externe, un dossier entierement refabrique de facon coherente par quelqu'un qui
 * connait le mecanisme n'est pas detecte (voir docs/PREUVE.md).
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeHash, parseAnchor } from '../server/auditchain.ts';
import type { Anchor } from '../server/auditchain.ts';
import {
  FIXED_FILES,
  HASH64,
  IMAGE_ENTRY,
  INCIDENT_NAME,
  JOURNAL_NAME,
  MANIFEST_NAME,
  NOTIFICATIONS_NAME,
  SEAL_ACTION,
  SEAL_DETAILS,
  parseManifest,
  sha256hex,
} from '../server/proofformat.ts';
import { ZipError, readZip } from '../server/zip.ts';

/** Taille maximale d'un dossier accepte par la verification. */
export const MAX_PROOF_FILE_BYTES = 300 * 1024 * 1024;

export interface ProofVerdict {
  /** Le fichier n'a pas pu etre lu comme un dossier (zip invalide, piege, trop gros). */
  refused: string | null;
  /** Modifications constatees DEPUIS l'export (fichier, entree de journal, manifeste...). */
  altered: string[];
  /** Anomalies SIGNALEES par l'export lui-meme (image manquante ou modifiee avant l'export...) et confirmees. */
  anomalies: string[];
  warnings: string[];
  info: string[];
  /** Ancres fournies mais impossibles a comparer (numero absent du dossier). */
  inconclusiveAnchors: string[];
  zipSha256: string | null;
  anchor: Anchor | null;
  ok: boolean;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

interface Entry {
  id: number;
  ts: number;
  actor: string;
  action: string;
  incident_id: number | null;
  device_id: string | null;
  details: string | null;
  prev_hash: string | null;
  hash: string | null;
}

function parseJson(name: string, files: Map<string, Buffer>, altered: string[]): Json | null {
  const raw = files.get(name);
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw.toString('utf8'));
    if (isObj(v)) return v;
  } catch {
    // traite plus bas
  }
  altered.push(`${name} : contenu illisible (JSON invalide)`);
  return null;
}

/** Verifie un dossier (octets du .zip). Ne leve jamais d'exception : tout est rapporte dans le verdict. */
export function verifyProof(zip: Buffer, userAnchors: Anchor[] = [], expectedZipSha256: string | null = null): ProofVerdict {
  const v: ProofVerdict = { refused: null, altered: [], anomalies: [], warnings: [], info: [], inconclusiveAnchors: [], zipSha256: sha256hex(zip), anchor: null, ok: false };
  // Empreinte du .zip relevee dans le journal du PSIM (« export_preuve ») : prouve que c'est bien le fichier produit par le PSIM.
  if (expectedZipSha256 !== null) {
    if (expectedZipSha256 === v.zipSha256) v.info.push("empreinte du .zip : IDENTIQUE a celle fournie (relevee au journal du PSIM)");
    else v.altered.push(`empreinte du .zip DIFFERENTE de celle fournie (${expectedZipSha256}) : ce n'est pas le fichier produit par le PSIM`);
  }
  let files: Map<string, Buffer>;
  try {
    files = readZip(zip);
  } catch (err) {
    v.refused = err instanceof ZipError ? err.message : `fichier illisible : ${err instanceof Error ? err.message : String(err)}`;
    return v;
  }

  // ---- 1. Manifeste : l'empreinte de chaque fichier
  const manifestRaw = files.get(MANIFEST_NAME);
  let manifest: Map<string, string> | null = null;
  if (!manifestRaw) v.altered.push(`${MANIFEST_NAME} ABSENT : impossible de verifier les fichiers`);
  else {
    try {
      manifest = parseManifest(manifestRaw.toString('utf8'));
    } catch (err) {
      v.altered.push(`${MANIFEST_NAME} invalide : ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (manifest) {
    for (const [name, data] of files) {
      if (name === MANIFEST_NAME) continue;
      const expected = manifest.get(name);
      if (expected === undefined) v.altered.push(`fichier AJOUTE, absent du manifeste : ${name}`);
      else if (sha256hex(data) !== expected) v.altered.push(`fichier MODIFIE depuis l'export : ${name} (empreinte differente du manifeste)`);
    }
    for (const name of manifest.keys()) if (!files.has(name)) v.altered.push(`fichier SUPPRIME du dossier : ${name} (liste par le manifeste)`);
    for (const required of FIXED_FILES) if (!manifest.has(required) && files.has(required)) v.altered.push(`${required} non liste par le manifeste`);
  }
  for (const required of FIXED_FILES) if (!files.has(required)) v.altered.push(`fichier obligatoire ABSENT : ${required}`);

  const incidentDoc = parseJson(INCIDENT_NAME, files, v.altered);
  const journalDoc = parseJson(JOURNAL_NAME, files, v.altered);
  parseJson(NOTIFICATIONS_NAME, files, v.altered);
  if (!incidentDoc || !journalDoc) return finish(v);

  const incNumber = isObj(incidentDoc.incident) && isInt(incidentDoc.incident.numero) ? incidentDoc.incident.numero : null;
  if (incNumber === null) v.altered.push(`${INCIDENT_NAME} : numero d'incident absent`);
  if (journalDoc.incident !== incNumber) v.altered.push(`${JOURNAL_NAME} : concerne l'incident ${String(journalDoc.incident)}, ${INCIDENT_NAME} l'incident ${String(incNumber)}`);

  // ---- 2. Journal : chaine d'empreintes
  const entries: Entry[] = [];
  const rawEntries = Array.isArray(journalDoc.entrees) ? journalDoc.entrees : null;
  if (!rawEntries) v.altered.push(`${JOURNAL_NAME} : liste d'entrees absente`);
  for (const e of rawEntries ?? []) {
    const ok =
      isObj(e) && isInt(e.id) && e.id > 0 && isInt(e.ts) && typeof e.actor === 'string' && typeof e.action === 'string' &&
      (e.incident_id === null || isInt(e.incident_id)) && strOrNull(e.device_id) && strOrNull(e.details) && strOrNull(e.prev_hash) && strOrNull(e.hash) &&
      (e.hash === null || HASH64.test(e.hash as string)) && (e.prev_hash === null || e.prev_hash === 'GENESIS' || HASH64.test(e.prev_hash as string));
    if (!ok) {
      v.altered.push(`${JOURNAL_NAME} : entree mal formee (${JSON.stringify(e).slice(0, 80)})`);
      continue;
    }
    entries.push(e as unknown as Entry);
  }
  let protectedCount = 0;
  let unprotected = 0;
  let gaps = 0;
  const trusted = new Map<number, Entry>(); // entrees dont l'empreinte est confirmee
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (i > 0 && e.id <= entries[i - 1].id) {
      v.altered.push(`journal : numeros d'entrees non croissants ou dupliques (n°${e.id} apres n°${entries[i - 1].id})`);
      continue;
    }
    if (e.hash === null) {
      unprotected++;
      continue;
    }
    if (computeHash(e.prev_hash ?? '', { id: e.id, ts: e.ts, actor: e.actor, action: e.action, incident_id: e.incident_id, device_id: e.device_id, details: e.details }) !== e.hash) {
      v.altered.push(`journal : entree n°${e.id} MODIFIEE (son contenu ne correspond plus a son empreinte)`);
    } else {
      protectedCount++;
      trusted.set(e.id, e);
    }
    if (i > 0) {
      const p = entries[i - 1];
      if (e.id === p.id + 1) {
        if (p.hash !== null && e.prev_hash !== p.hash) v.altered.push(`journal : chainage ROMPU entre l'entree n°${p.id} et la n°${e.id}`);
      } else gaps++;
    }
  }
  if (unprotected > 0) v.warnings.push(`journal : ${unprotected} entree(s) anterieure(s) au mecanisme d'empreintes : non protegee(s)`);
  if (entries.length > 0 && journalDoc.empreinte_precedente_premiere !== (entries[0].prev_hash ?? null)) {
    v.altered.push(`journal : l'empreinte precedente de la premiere entree (n°${entries[0].id}) ne correspond pas a celle annoncee`);
  }
  if (gaps > 0) v.info.push(`journal : ${gaps} intervalle(s) entre entrees non consecutives (entrees sans rapport non incluses) : la liaison entre elles n'est pas verifiable hors ligne`);
  v.info.push(`journal : ${protectedCount} entree(s) recalculee(s) et conforme(s) sur ${entries.length}`);

  // ---- 3. Ancre
  const own = journalDoc.ancre;
  if (isObj(own) && isInt(own.id) && typeof own.hash === 'string' && HASH64.test(own.hash)) {
    v.anchor = { id: own.id, hash: own.hash };
    const last = entries[entries.length - 1];
    if (last && last.id > own.id) v.altered.push(`journal : entree n°${last.id} posterieure a l'ancre annoncee (n°${own.id})`);
    const same = trusted.get(own.id);
    if (same && same.hash !== own.hash) v.altered.push(`journal : l'ancre annoncee differe de l'empreinte de l'entree n°${own.id}`);
  } else if (own !== null) v.altered.push(`${JOURNAL_NAME} : ancre mal formee`);
  for (const a of userAnchors) {
    const label = `${a.id}:${a.hash}`;
    const inExtract = trusted.get(a.id);
    if (inExtract) {
      if (inExtract.hash === a.hash) v.info.push(`ancre ${a.id} : IDENTIQUE a l'entree n°${a.id} du dossier (journal non reecrit jusque-la)`);
      else v.altered.push(`ancre ${a.id} : DIFFERENTE de l'entree n°${a.id} du dossier (journal reecrit ou ancre d'un autre PSIM)`);
    } else if (v.anchor && v.anchor.id === a.id) {
      if (v.anchor.hash === a.hash) v.info.push(`ancre ${a.id} : IDENTIQUE a l'ancre du journal a l'export`);
      else v.altered.push(`ancre ${a.id} : DIFFERENTE de l'ancre du journal a l'export (journal reecrit ou ancre d'un autre PSIM)`);
    } else v.inconclusiveAnchors.push(label);
  }

  // ---- 4. Images : empreinte scellee au journal et empreinte du fichier
  const sealed = new Map<number, { sha256: string; bytes: number; entry: number }>();
  for (const e of trusted.values()) {
    if (e.action !== SEAL_ACTION || e.incident_id !== incNumber) continue;
    const m = SEAL_DETAILS.exec(e.details ?? '');
    if (m) sealed.set(Number(m[1]), { sha256: m[2], bytes: Number(m[3]), entry: e.id });
  }
  const declared = new Set<number>();
  const list = Array.isArray(incidentDoc.images) ? incidentDoc.images : null;
  if (!list) v.altered.push(`${INCIDENT_NAME} : liste d'images absente`);
  let imagesOk = 0;
  for (const im of list ?? []) {
    if (!isObj(im) || !isInt(im.id)) {
      v.altered.push(`${INCIDENT_NAME} : image mal formee`);
      continue;
    }
    const id = im.id;
    declared.add(id);
    const seal = sealed.get(id) ?? null;
    const state = String(im.etat);
    const fichier = typeof im.fichier === 'string' ? im.fichier : null;
    const note = typeof im.remarque === 'string' ? ` (${im.remarque})` : '';
    if (seal && im.sha256_scelle !== seal.sha256) v.altered.push(`image n°${id} : l'empreinte scellee annoncee par ${INCIDENT_NAME} differe de celle du journal (entree n°${seal.entry})`);
    if (fichier === null) {
      // Pas de fichier : l'export l'a declare (manquante, purgee, omise). Jamais silencieux.
      if (state === 'purgee') v.warnings.push(`image n°${id} : supprimee par la purge de conservation${note}`);
      else v.anomalies.push(`image n°${id} : ${state === 'omise' ? 'NON INCLUSE' : 'MANQUANTE'} dans le dossier${note}`);
      continue;
    }
    const data = IMAGE_ENTRY.test(fichier) ? files.get(fichier) : undefined;
    if (!data) {
      v.altered.push(`image n°${id} : fichier ${fichier} annonce par ${INCIDENT_NAME} mais ABSENT du dossier`);
      continue;
    }
    const sha = sha256hex(data);
    if (im.sha256_dossier !== sha) v.altered.push(`image n°${id} : l'empreinte annoncee par ${INCIDENT_NAME} ne correspond pas au fichier ${fichier}`);
    if (!seal) {
      if (state === 'conforme') v.altered.push(`image n°${id} : declaree conforme mais aucune entree scellee dans le journal du dossier`);
      else if (state === 'non_scellee') v.warnings.push(`image n°${id} : anterieure au scellement, non protegee par le journal`);
      else v.anomalies.push(`image n°${id} : aucune entree scellee au journal${note}`);
      continue;
    }
    const matches = sha === seal.sha256 && data.length === seal.bytes;
    if (matches) {
      if (state !== 'conforme') v.altered.push(`image n°${id} : l'export la declare « ${state} » alors qu'elle correspond a l'empreinte scellee`);
      else imagesOk++;
    } else if (state === 'alteree' || state === 'anomalie') v.anomalies.push(`image n°${id} : fichier ${fichier} DIFFERENT de l'empreinte scellee au journal (entree n°${seal.entry}) : image modifiee avant l'export`);
    else v.altered.push(`image n°${id} : fichier ${fichier} DIFFERENT de l'empreinte scellee au journal (entree n°${seal.entry}) alors que l'export la declarait ${state}`);
  }
  for (const [id, seal] of sealed) if (!declared.has(id)) v.altered.push(`image n°${id} : scellee au journal (entree n°${seal.entry}) mais absente de la liste du dossier`);
  for (const name of files.keys()) {
    const m = IMAGE_ENTRY.exec(name);
    if (m && !declared.has(Number(m[1]))) v.altered.push(`image ${name} presente mais non declaree par ${INCIDENT_NAME}`);
    if (name.startsWith('images/') && !m) v.altered.push(`fichier inattendu dans images/ : ${name}`);
  }
  v.info.push(`images : ${imagesOk} fichier(s) conforme(s) a l'empreinte scellee au journal sur ${(list ?? []).length} annoncee(s)`);

  // ---- 5. Anomalies et remarques annoncees par l'export (reprises telles quelles : rien n'est cache)
  const exportAnomalies = Array.isArray(incidentDoc.anomalies) ? incidentDoc.anomalies.filter((x): x is string => typeof x === 'string') : [];
  for (const a of exportAnomalies) {
    const key = a.includes(" :") ? a.slice(0, a.indexOf(" :")) : a; // « image n°3 » : deja rapportee en detail ci-dessus
    if (!v.anomalies.some((x) => x.startsWith(key))) v.anomalies.push(`signalee par l'export : ${a}`);
  }
  const exportWarnings = Array.isArray(incidentDoc.avertissements) ? incidentDoc.avertissements.filter((x): x is string => typeof x === 'string') : [];
  for (const w of exportWarnings) if (!v.warnings.some((x) => x.includes(w))) v.warnings.push(w);
  return finish(v);
}

function finish(v: ProofVerdict): ProofVerdict {
  v.ok = v.refused === null && v.altered.length === 0 && v.anomalies.length === 0 && v.inconclusiveAnchors.length === 0;
  return v;
}

/** Texte du verdict (francais). */
export function formatVerdict(v: ProofVerdict, path: string): string[] {
  const out: string[] = [`Dossier : ${path}`];
  if (v.zipSha256) out.push(`Empreinte SHA-256 du fichier .zip : ${v.zipSha256}`, '  (a comparer a celle inscrite au journal du PSIM, action « export_preuve »)');
  if (v.anchor) out.push(`Ancre du journal a l'export : ${v.anchor.id}:${v.anchor.hash}`);
  for (const i of v.info) out.push(`  ${i}`);
  if (v.refused !== null) {
    out.push('', `DOSSIER REFUSE : ${v.refused}`, 'Ce fichier n\'est pas un dossier de preuve exploitable (zip invalide, tronque, ou piege). Rien n\'a ete extrait.');
    return out;
  }
  for (const w of v.warnings) out.push(`  REMARQUE : ${w}`);
  if (v.altered.length) {
    out.push('', 'DOSSIER ALTERE : il a ete modifie depuis son export, ou il est incoherent :');
    for (const a of v.altered) out.push(`  - ${a}`);
  }
  if (v.anomalies.length) {
    out.push('', 'ANOMALIES SIGNALEES (la preuve est fragilisee sur ces points) :');
    for (const a of v.anomalies) out.push(`  - ${a}`);
  }
  if (v.inconclusiveAnchors.length) {
    out.push('', 'ANCRE NON COMPARABLE : le numero de l\'ancre fournie ne figure pas dans ce dossier :');
    for (const a of v.inconclusiveAnchors) out.push(`  - ${a}`);
    out.push('  Fournissez l\'ancre d\'une entree de l\'extrait, ou celle de l\'ancre a l\'export (voir ci-dessus).');
  }
  if (v.ok) {
    out.push('', v.anchor && v.info.some((i) => i.startsWith('ancre ')) ? 'CONFORME : aucun fichier modifie, journal bien chaine, images conformes, ancre fournie retrouvee.' : 'CONFORME : aucun fichier modifie, journal bien chaine, images conformes (non comparee a une ancre externe).');
    if (!v.info.some((i) => i.startsWith('ancre '))) out.push('Rappel : sans ancre conservee hors du PSIM, un dossier entierement refabrique de facon coherente ne serait pas detecte (voir LISEZ-MOI.txt).');
  } else if (v.altered.length === 0 && v.anomalies.length > 0 && v.inconclusiveAnchors.length === 0) {
    out.push('', 'VERDICT : le dossier n\'a pas ete modifie depuis l\'export, MAIS il signale des anomalies sur la preuve.');
  } else if (v.altered.length > 0) out.push('', 'VERDICT : NON CONFORME.');
  else out.push('', 'VERDICT : NON CONCLUANT (ancre non comparable).');
  return out;
}

/** Renvoie le code de sortie (sans process.exit : sous Windows, une sortie immediate peut interrompre l'ecriture). */
export function main(args: string[]): number {
  const anchors: Anchor[] = [];
  let path: string | null = null;
  let zipSha: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--anchor') {
      const text = args[++i] ?? '';
      const a = parseAnchor(text);
      if (!a) {
        console.error(`Ancre invalide « ${text} » (forme attendue : 1234:<64 caracteres hexadecimaux>)`);
        return 2;
      }
      anchors.push(a);
    } else if (args[i] === '--sha256') {
      zipSha = (args[++i] ?? '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(zipSha)) {
        console.error('Empreinte --sha256 invalide (64 caracteres hexadecimaux attendus)');
        return 2;
      }
    } else if (args[i].startsWith('--')) {
      console.error(`Option inconnue : ${args[i]}`);
      return 2;
    } else if (path === null) path = args[i];
    else {
      console.error('Un seul fichier .zip a la fois.');
      return 2;
    }
  }
  if (path === null) {
    console.error('Usage : npm run verify-proof -- dossier.zip [--anchor 1234:<empreinte>] [--sha256 <empreinte du .zip>]');
    return 2;
  }
  const file = resolve(path);
  let buf: Buffer;
  try {
    if (statSync(file).size > MAX_PROOF_FILE_BYTES) {
      console.log(`DOSSIER REFUSE : fichier trop gros (plus de ${MAX_PROOF_FILE_BYTES / 1024 / 1024} Mo).`);
      return 1;
    }
    buf = readFileSync(file);
  } catch {
    console.log(`DOSSIER REFUSE : fichier introuvable ou illisible : ${file}`);
    return 1;
  }
  const verdict = verifyProof(buf, anchors, zipSha);
  for (const line of formatVerdict(verdict, file)) console.log(line);
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = main(process.argv.slice(2));
}
