import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Express, Request, RequestHandler, Response } from 'express';
import { headOf } from './auditchain.ts';
import { PsimError } from './engine.ts';
import { IMAGE_FILE, parseIds } from './evidence.ts';
import type { AuditFn } from './evidence.ts';
import {
  FIXED_FILES,
  INCIDENT_NAME,
  JOURNAL_ALGORITHM,
  JOURNAL_NAME,
  MANIFEST_NAME,
  NOTIFICATIONS_NAME,
  PROOF_VERSION,
  README_NAME,
  REPORT_NAME,
  SEAL_ACTION,
  SEAL_DETAILS,
  formatManifest,
  sha256hex,
} from './proofformat.ts';
import type { ImageState, ProofImage, ProofJournal, ProofJournalEntry } from './proofformat.ts';
import { esc, fmtDateTime, qualificationText } from './reports.ts';
import { CATEGORY_LABEL } from './sources.ts';
import type { DeviceCategory } from './types.ts';
import { ADMIN_ONLY_DETAILS } from './visibility.ts';
import { createZip } from './zip.ts';
import type { ZipInput } from './zip.ts';

/**
 * Dossier de preuve d'un incident : UN fichier .zip a remettre a un assureur, une banque, la police ou un tribunal.
 *
 * Contenu : LISEZ-MOI.txt, incident.json, journal-extrait.json, images/ (originaux scelles), notifications.json,
 * MANIFEST.sha256 (empreinte de chaque fichier), rapport.html. Il se verifie HORS LIGNE, sans acces a la base :
 * `npm run verify-proof -- dossier.zip` (scripts/verify-proof.ts).
 *
 * HONNETETE (reprise dans le LISEZ-MOI et dans docs/PREUVE.md) : le dossier prouve sa COHERENCE INTERNE (aucun fichier
 * modifie depuis l'export, entrees du journal bien chainees, images conformes a l'empreinte scellee) et, avec une ancre
 * conservee ailleurs, que le journal n'a pas ete reecrit. Il ne prouve PAS l'heure exacte (celle du serveur, sans
 * horodatage certifie), ni qu'un faussaire disposant de la base ET connaissant le mecanisme n'a pas refabrique un
 * dossier coherent : seule l'ancre externe, et l'empreinte du .zip inscrite au journal du PSIM a l'export, le revelent.
 *
 * Une anomalie (image manquante ou modifiee, empreinte alteree en base) n'empeche JAMAIS l'export : elle est ecrite en
 * clair dans incident.json, le rapport et le LISEZ-MOI. Rien n'est cache.
 */

export const PROOF_ACTION = 'export_preuve';

const MIN = 60_000;
const DEFAULT_BEFORE_MS = 10 * MIN;
const DEFAULT_AFTER_MS = 10 * MIN;
/** Plafond d'entrees de journal dans un extrait (au-dela : signale, jamais tronque en silence). */
const DEFAULT_MAX_ENTRIES = 5000;
/** Plafond du total des images d'un dossier (octets). */
const DEFAULT_MAX_IMAGE_BYTES = 100 * 1024 * 1024;
/** Une image n'est integree au rapport (vignette) que si elle est conforme et petite. */
const INLINE_IMAGE_MAX = 1_500_000;
const INLINE_TOTAL_MAX = 8_000_000;

type Row = Record<string, unknown>;

export interface ProofOptions {
  /** Auteur de l'export (inscrit dans le dossier). */
  actor: string;
  /** L'administrateur recoit aussi les entrees de journal d'administration (reglages, securite) liees a l'equipement. */
  isAdmin: boolean;
}

export interface ProofConfig {
  db: DatabaseSync;
  dataDir: string;
  siteName: () => string;
  now?: () => number;
  /** Fenetre du journal autour de l'incident (ms avant l'ouverture, ms apres la cloture ou apres maintenant). */
  windowBeforeMs?: number;
  windowAfterMs?: number;
  maxEntries?: number;
  maxImageBytes?: number;
}

export interface ProofPack {
  zip: Buffer;
  fileName: string;
  sha256: string;
  manifestSha256: string;
  files: string[];
  anomalies: string[];
  warnings: string[];
  journalEntries: number;
  images: number;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** « 2026-02-10 09:30:00 +01:00 » : heure locale du serveur avec son decalage. */
export function localStamp(ts: number): string {
  const d = new Date(ts);
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

const when = (ts: number | null | undefined) => (ts === null || ts === undefined ? null : { ms: ts, utc: new Date(ts).toISOString(), serveur: localStamp(ts) });

/** Pas de secret dans le dossier : une adresse de webhook (peut contenir un jeton) est reduite a son serveur. */
function maskRecipient(channel: string, recipient: string): string {
  if (channel !== 'webhook') return recipient;
  try {
    return `${new URL(recipient).host} (adresse complete non reproduite)`;
  } catch {
    return '(adresse non reproduite)';
  }
}

const STATUS_NOTIF: Record<string, string> = { sent: 'envoyee', failed: 'echec', pending: 'en cours / sans reponse' };
const SEVERITY_TEXT: Record<string, string> = { critical: 'critique', warning: 'avertissement' };
const STATUS_TEXT: Record<string, string> = { open: 'ouvert, non acquitte', acknowledged: 'acquitte', closed: 'cloture' };

const IMAGE_STATE_TEXT: Record<ImageState, string> = {
  conforme: 'conforme',
  alteree: 'ALTEREE (differente de l\'empreinte scellee)',
  manquante: 'MANQUANTE (fichier absent)',
  non_scellee: 'non protegee (anterieure au scellement)',
  purgee: 'supprimee par la purge (journalisee)',
  anomalie: 'ANOMALIE',
  omise: 'non incluse (taille du dossier)',
};

/** Fabrique le dossier de preuve. Leve `PsimError(404)` si l'incident n'existe pas. Synchrone : lecture coherente de la base. */
export function buildProofPack(cfg: ProofConfig, incidentId: number, options: ProofOptions): ProofPack {
  const { db } = cfg;
  const now = (cfg.now ?? Date.now)();
  const before = cfg.windowBeforeMs ?? DEFAULT_BEFORE_MS;
  const after = cfg.windowAfterMs ?? DEFAULT_AFTER_MS;
  const maxEntries = cfg.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxImageBytes = cfg.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const snapshotDir = join(resolve(cfg.dataDir), 'snapshots');

  const inc = db
    .prepare(
      `SELECT i.*, d.name AS detector_name, d.zone AS zone, d.category AS category,
              COALESCE((SELECT f.name FROM floor f WHERE f.id = d.floor_id), (SELECT name FROM floor ORDER BY position, id LIMIT 1)) AS floor_name
         FROM incident i LEFT JOIN device d ON d.id = i.detector_id WHERE i.id = ?`,
    )
    .get(incidentId) as Row | undefined;
  if (!inc) throw new PsimError(404, 'Incident introuvable');

  const category = ((inc.category as string | null) ?? 'fire') as DeviceCategory;
  const detectorId = inc.detector_id as string;
  const openedAt = inc.opened_at as number;
  const closedAt = (inc.closed_at as number | null) ?? null;
  const winStart = openedAt - before;
  const winEnd = (closedAt ?? now) + after;
  const cameras = (db.prepare('SELECT camera_id FROM device_link WHERE detector_id = ? ORDER BY camera_id').all(detectorId) as Row[]).map((r) => r.camera_id as string);

  const anomalies: string[] = [];
  const warnings: string[] = [];

  // ---------------------------------------------------------------- images
  const snaps = db.prepare('SELECT * FROM incident_snapshot WHERE incident_id = ? ORDER BY id').all(incidentId) as Row[];
  const sealEntries = db.prepare('SELECT * FROM audit_log WHERE action = ? AND incident_id = ? AND hash IS NOT NULL ORDER BY id').all(SEAL_ACTION, incidentId) as Row[];
  const sealed = new Map<number, { sha256: string; bytes: number; entry: number }>();
  for (const e of sealEntries) {
    const m = SEAL_DETAILS.exec((e.details as string | null) ?? '');
    if (m) sealed.set(Number(m[1]), { sha256: m[2], bytes: Number(m[3]), entry: e.id as number });
  }
  const files: ZipInput[] = [];
  const images: ProofImage[] = [];
  const inlineThumbs = new Map<number, Buffer>();
  let imageBytes = 0;
  let inlineBytes = 0;
  const shown = new Set<number>();
  for (const s of snaps) {
    const id = s.id as number;
    shown.add(id);
    const seal = sealed.get(id) ?? null;
    const dbSha = (s.sha256 as string | null) ?? null;
    const source = ((s.source as string | null) ?? 'camera') === 'device' ? 'equipement' : 'camera';
    const rec: ProofImage = {
      id,
      fichier: null,
      source,
      equipement: s.camera_id as string,
      pris_le: s.taken_at as number,
      motif: s.reason as string,
      sha256_scelle: seal?.sha256 ?? null,
      octets_scelles: seal?.bytes ?? null,
      entree_journal: seal?.entry ?? null,
      sha256_dossier: null,
      octets: null,
      etat: 'conforme',
      remarque: null,
    };
    const flag = (state: ImageState, note: string, isAnomaly = true) => {
      rec.etat = state;
      rec.remarque = note;
      (isAnomaly ? anomalies : warnings).push(`image n°${id} : ${note}`);
    };
    const name = s.file as string;
    const path = IMAGE_FILE.test(name) ? join(snapshotDir, name) : null;
    let data: Buffer | null = null;
    if (path === null) flag('manquante', 'nom de fichier inattendu en base : image non incluse');
    else if (!existsSync(path)) flag('manquante', `fichier ${name} MANQUANT sur le disque du PSIM`);
    else if (statSync(path).size + imageBytes > maxImageBytes) flag('omise', `fichier ${name} non inclus : taille maximale du dossier atteinte`);
    else data = readFileSync(path);
    if (data) {
      imageBytes += data.length;
      rec.fichier = `images/${name}`;
      rec.sha256_dossier = sha256hex(data);
      rec.octets = data.length;
      files.push({ name: rec.fichier, data, deflate: false });
      if (!seal) {
        if (dbSha) flag('anomalie', 'empreinte presente en base mais aucune entree scellee au journal (ajoutee hors du PSIM ?)');
        else flag('non_scellee', 'image anterieure au mecanisme de scellement : son authenticite n\'est pas garantie par le journal', false);
      } else {
        if (dbSha !== seal.sha256) flag('anomalie', `empreinte modifiee en base (differente de celle scellee au journal, entree n°${seal.entry})`);
        if (data.length !== seal.bytes || rec.sha256_dossier !== seal.sha256) flag('alteree', `fichier ${name} MODIFIE : son empreinte differe de celle scellee au journal (entree n°${seal.entry})`);
        else if (rec.etat === 'conforme' && data.length <= INLINE_IMAGE_MAX && inlineBytes + data.length <= INLINE_TOTAL_MAX) {
          inlineThumbs.set(id, data);
          inlineBytes += data.length;
        }
      }
    }
    images.push(rec);
  }
  // Images scellees au journal pour cet incident mais plus presentes en base : purge journalisee, ou suppression hors du PSIM.
  const missingIds = [...sealed.keys()].filter((id) => !shown.has(id));
  if (missingIds.length > 0) {
    const purged = new Set<number>();
    for (const r of db.prepare("SELECT details FROM audit_log WHERE action = 'images_purgees' AND hash IS NOT NULL").all() as Row[]) {
      const m = /^images ([\d,-]+)/.exec((r.details as string | null) ?? '');
      if (m) for (const id of parseIds(m[1])) purged.add(id);
    }
    for (const id of missingIds) {
      const seal = sealed.get(id)!;
      const isPurged = purged.has(id);
      const rec: ProofImage = {
        id, fichier: null, source: 'camera', equipement: '', pris_le: 0, motif: '', sha256_scelle: seal.sha256, octets_scelles: seal.bytes, entree_journal: seal.entry,
        sha256_dossier: null, octets: null, etat: isPurged ? 'purgee' : 'manquante', remarque: null,
      };
      rec.remarque = isPurged ? 'image supprimee par la purge de conservation (entree de purge au journal)' : `image supprimee SANS entree de purge (scellee par l'entree n°${seal.entry})`;
      (isPurged ? warnings : anomalies).push(`image n°${id} : ${rec.remarque}`);
      images.push(rec);
    }
  }

  // ---------------------------------------------------------------- journal
  const deviceIds = [...new Set([detectorId, ...cameras, ...images.map((i) => i.equipement).filter(Boolean)])];
  const marks = deviceIds.map(() => '?').join(',');
  const candidates = db
    .prepare(`SELECT * FROM audit_log WHERE incident_id = ? OR (device_id IN (${marks}) AND ts >= ? AND ts <= ?) ORDER BY id LIMIT ?`)
    .all(incidentId, ...deviceIds, winStart, winEnd, maxEntries * 4 + 1) as Row[];
  const entries: ProofJournalEntry[] = [];
  let omittedRights = 0;
  let omittedCap = 0;
  const sealIds = new Set(sealEntries.map((e) => e.id as number));
  for (const r of candidates) {
    const action = r.action as string;
    // Un operateur ne voit pas, dans le PSIM, le detail de ces actions d'administration : le dossier ne les lui livre pas non plus.
    if (!options.isAdmin && ADMIN_ONLY_DETAILS.has(action)) {
      omittedRights++;
      continue;
    }
    if (entries.length >= maxEntries && !sealIds.has(r.id as number)) {
      omittedCap++;
      continue;
    }
    entries.push({
      id: r.id as number,
      ts: r.ts as number,
      actor: r.actor as string,
      action,
      incident_id: (r.incident_id as number | null) ?? null,
      device_id: (r.device_id as string | null) ?? null,
      details: (r.details as string | null) ?? null,
      prev_hash: (r.prev_hash as string | null) ?? null,
      hash: (r.hash as string | null) ?? null,
    });
  }
  // Les entrees qui scellent les images sont indispensables a la verification : toujours presentes, meme au-dela du plafond.
  const have = new Set(entries.map((e) => e.id));
  for (const r of sealEntries) {
    if (have.has(r.id as number)) continue;
    entries.push({ id: r.id as number, ts: r.ts as number, actor: r.actor as string, action: r.action as string, incident_id: (r.incident_id as number | null) ?? null, device_id: (r.device_id as string | null) ?? null, details: (r.details as string | null) ?? null, prev_hash: (r.prev_hash as string | null) ?? null, hash: (r.hash as string | null) ?? null });
  }
  entries.sort((a, b) => a.id - b.id);
  if (candidates.length > maxEntries * 4) omittedCap += 1; // lecture elle-meme plafonnee : le total exact est inconnu
  if (omittedCap > 0) anomalies.push(`journal : ${omittedCap} entree(s) non incluses (plafond de ${maxEntries} entrees atteint) : reduire la fenetre ou demander un export cible`);
  const unsealedEntries = entries.filter((e) => e.hash === null).length;
  if (unsealedEntries > 0) warnings.push(`journal : ${unsealedEntries} entree(s) anterieure(s) au mecanisme d'empreintes (non protegees)`);
  const head = headOf(db);
  const journal: ProofJournal = {
    version: PROOF_VERSION,
    incident: incidentId,
    algorithme: JOURNAL_ALGORITHM,
    fenetre: { debut: winStart, fin: winEnd, avant_ms: before, apres_ms: after },
    empreinte_precedente_premiere: entries.length > 0 ? (entries[0].prev_hash ?? null) : null,
    ancre: head ? { id: head.id, hash: head.hash } : null,
    entrees_omises: { droits: omittedRights, plafond: omittedCap },
    entrees: entries,
  };

  // ---------------------------------------------------------------- etats, notifications
  const states = (db
    .prepare('SELECT state, started_at, ended_at FROM device_state_history WHERE device_id = ? AND started_at <= ? AND COALESCE(ended_at, ?) >= ? ORDER BY started_at, id')
    .all(detectorId, winEnd, now, winStart) as Row[]).map((r) => ({
    etat: r.state as string,
    debut: when(r.started_at as number),
    fin: when((r.ended_at as number | null) ?? null),
    en_cours: r.ended_at === null,
  }));
  const notifRows = db
    .prepare("SELECT id, kind, channel, recipient, level, status, attempts, created_at FROM notification_log WHERE incident_id = ? AND channel <> 'round' ORDER BY id")
    .all(incidentId) as Row[];
  const notifications = notifRows.map((n) => ({
    numero: n.id as number,
    date: when(n.created_at as number),
    type: n.kind as string,
    canal: n.channel as string,
    destinataire: maskRecipient(n.channel as string, n.recipient as string),
    niveau: n.level as number,
    statut: STATUS_NOTIF[n.status as string] ?? (n.status as string),
    tentatives: n.attempts as number,
  }));

  // ---------------------------------------------------------------- incident.json
  const own = entries.filter((e) => e.incident_id === incidentId);
  const people = [...new Set(own.map((e) => e.actor).filter((a) => a !== 'systeme' && a !== 'equipement'))];
  const incidentDoc = {
    version: PROOF_VERSION,
    genere_le: when(now),
    genere_par: options.actor,
    site: cfg.siteName(),
    fuseau_horaire_serveur: Intl.DateTimeFormat().resolvedOptions().timeZone,
    avertissement_heure: "Toutes les heures sont celles de l'horloge du serveur du PSIM ; elles ne sont pas certifiees par un tiers.",
    incident: {
      numero: incidentId,
      gravite: SEVERITY_TEXT[inc.severity as string] ?? inc.severity,
      statut: STATUS_TEXT[inc.status as string] ?? inc.status,
      motif_evenement: (inc.event as string | null) ?? null,
      ouverture: when(openedAt),
      recu_le: when((inc.received_at as number | null) ?? null),
      confirmation: inc.confirmed_at === null || inc.confirmed_at === undefined ? null : { date: when(inc.confirmed_at as number), raison: (inc.confirmation_reason as string | null) ?? null },
      indice: (inc.hint as string | null) ?? null,
      accuse: inc.acked_at === null ? null : { date: when(inc.acked_at as number), par: (inc.acked_by as string | null) ?? null },
      qualification: (inc.qualification as string | null) ?? null,
      qualification_libelle: qualificationText(category, (inc.qualification as 'fire' | 'false_alarm' | null) ?? null),
      cloture: closedAt === null ? null : { date: when(closedAt), par: (inc.closed_by as string | null) ?? null },
      commentaire: (inc.comment as string | null) ?? null,
    },
    equipement: {
      id: detectorId,
      nom: (inc.detector_name as string | null) ?? null,
      categorie: category,
      categorie_libelle: CATEGORY_LABEL[category],
      zone: (inc.zone as string | null) ?? '',
      etage: (inc.floor_name as string | null) ?? '',
      cameras_liees: cameras,
    },
    etats_successifs: states,
    personnes_intervenues: people,
    actions: own.map((e) => ({ entree_journal: e.id, date: when(e.ts), auteur: e.actor, action: e.action, equipement: e.device_id, details: e.details })),
    images,
    notifications_resume: { total: notifications.length, envoyees: notifications.filter((n) => n.statut === 'envoyee').length, en_echec: notifications.filter((n) => n.statut === 'echec').length },
    anomalies,
    avertissements: warnings,
    journal: { fichier: JOURNAL_NAME, entrees: entries.length, fenetre_debut: when(winStart), fenetre_fin: when(winEnd), ancre: journal.ancre },
  };

  const json = (v: unknown) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`, 'utf8');
  const textFiles: { name: string; data: Buffer }[] = [
    { name: INCIDENT_NAME, data: json(incidentDoc) },
    { name: JOURNAL_NAME, data: json(journal) },
    { name: NOTIFICATIONS_NAME, data: json({ version: PROOF_VERSION, incident: incidentId, note: "Adresses de webhook reduites a leur serveur ; messages d'erreur et secrets non reproduits.", notifications }) },
    { name: README_NAME, data: Buffer.from(readme(incidentId, now, anomalies, warnings, journal.ancre), 'utf8') },
    { name: REPORT_NAME, data: Buffer.from(reportHtml({ cfg, actor: options.actor, incidentId, inc, category, now, incidentDoc, entries, states, notifications, images, anomalies, warnings, inlineThumbs, journal, omittedRights }), 'utf8') },
  ];
  const all: ZipInput[] = [...textFiles.map((f) => ({ name: f.name, data: f.data, deflate: true })), ...files];
  const manifest = Buffer.from(formatManifest(all.map((f) => ({ name: f.name, sha256: sha256hex(f.data) }))), 'utf8');
  all.push({ name: MANIFEST_NAME, data: manifest, deflate: true });
  // Ordre stable et lisible : LISEZ-MOI en premier.
  const order = [README_NAME, ...FIXED_FILES.filter((n) => n !== README_NAME)];
  all.sort((a, b) => {
    const ra = order.indexOf(a.name);
    const rb = order.indexOf(b.name);
    if (ra >= 0 || rb >= 0) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
    if (a.name === MANIFEST_NAME) return 1;
    if (b.name === MANIFEST_NAME) return -1;
    return a.name < b.name ? -1 : 1;
  });
  const zip = createZip(all, now);
  const d = new Date(now);
  return {
    zip,
    fileName: `dossier-preuve-incident-${incidentId}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`,
    sha256: sha256hex(zip),
    manifestSha256: sha256hex(manifest),
    files: all.map((f) => f.name),
    anomalies,
    warnings,
    journalEntries: entries.length,
    images: files.length,
  };
}

// ---------------------------------------------------------------- textes

function readme(incidentId: number, now: number, anomalies: string[], warnings: string[], anchor: { id: number; hash: string } | null): string {
  const lines: string[] = [];
  lines.push(`DOSSIER DE PREUVE — INCIDENT N° ${incidentId}`);
  lines.push(`Établi le ${localStamp(now)} (heure du serveur du PSIM).`);
  lines.push('');
  if (anomalies.length > 0) {
    lines.push('!!! ANOMALIES CONSTATÉES À L\'EXPORT (rien n\'est caché) !!!');
    for (const a of anomalies) lines.push(`  - ${a}`);
    lines.push('');
  }
  if (warnings.length > 0) {
    lines.push('Remarques :');
    for (const w of warnings) lines.push(`  - ${w}`);
    lines.push('');
  }
  lines.push(
    'CE QUE CONTIENT CE DOSSIER',
    '  LISEZ-MOI.txt         ce fichier',
    '  rapport.html          compte rendu lisible et imprimable (à ouvrir dans un navigateur, sans connexion)',
    '  incident.json         identité de l\'incident, équipement, zone, étage, chronologie, personnes intervenues, images',
    '  journal-extrait.json  entrées du journal liées à l\'incident et à l\'équipement, avec leurs empreintes (chaîne SHA-256)',
    '  images/               images originales de l\'incident (caméras liées ou équipement), sans retouche',
    '  notifications.json    qui a été prévenu, quand, par quel canal, avec quel résultat (sans secret)',
    '  MANIFEST.sha256       empreinte SHA-256 de chacun des autres fichiers',
    '',
    'CE QUE CE DOSSIER PEUT PROUVER',
    '  - Qu\'aucun fichier n\'a été modifié, ajouté ou retiré depuis l\'export (empreintes du MANIFEST).',
    '  - Que les entrées du journal présentées sont bien enchaînées entre elles : modifier une ligne après coup',
    '    casse la chaîne à cet endroit, et la vérification le montre.',
    '  - Que chaque image est exactement celle dont l\'empreinte a été scellée dans le journal au moment où elle a',
    '    été enregistrée : une image retouchée ou remplacée ne correspond plus.',
    '  - Avec une empreinte du journal conservée AILLEURS que sur le PSIM (rapport reçu par e-mail, sauvegarde), que',
    '    le journal n\'a pas été réécrit depuis.',
    '',
    'CE QUE CE DOSSIER NE PROUVE PAS',
    '  - L\'heure exacte : les heures sont celles de l\'horloge du serveur, sans horodatage certifié par un tiers.',
    '    Un serveur dont l\'horloge est déréglée date mal les événements.',
    '  - Qu\'un événement s\'est produit : le dossier prouve ce que le PSIM a enregistré, pas la réalité physique',
    '    (un détecteur peut se tromper ; une image montre ce que la caméra voyait).',
    '  - Qu\'une personne disposant d\'un accès complet à la base du PSIM et connaissant ce mécanisme n\'aurait pas pu',
    '    fabriquer un dossier cohérent : seule la comparaison avec une empreinte conservée hors du PSIM, ou avec',
    '    l\'inscription de l\'export dans le journal du PSIM (voir ci-dessous), permet de s\'en assurer.',
    '  - Que l\'extrait du journal est COMPLET : seuls les événements liés à l\'incident et à l\'équipement, dans la',
    '    fenêtre indiquée dans incident.json, y figurent ; les autres entrées ne sont volontairement pas incluses, et',
    '    le dossier seul ne permet pas de savoir si une entrée en a été retirée. Le journal complet est dans la base',
    '    du PSIM (l\'administrateur peut le faire contrôler : npm run verify-journal).',
    '',
    'COMMENT VÉRIFIER',
    '  Sur un poste disposant du PSIM (Node.js 24 ou plus), sans accès à sa base de données :',
    '      npm run verify-proof -- chemin\\vers\\dossier-preuve-incident-' + incidentId + '-....zip',
    '  Pour comparer à une empreinte conservée ailleurs (rapport e-mail du PSIM, ligne « Empreinte du journal ») :',
    '      npm run verify-proof -- dossier.zip --anchor 1234:<64 caractères hexadécimaux>',
    '  Pour s\'assurer que ce fichier est bien celui produit par le PSIM (et non une copie retouchée puis re-scellée) :',
    '  l\'empreinte SHA-256 du .zip est inscrite dans le journal du PSIM (action « export_preuve ») ; la fournir ainsi :',
    '      npm run verify-proof -- dossier.zip --sha256 <empreinte du .zip relevée dans le journal>',
    '  Le verdict est écrit en français ; le code de sortie est 0 si tout est conforme, 1 sinon.',
    '  Vérification partielle sans le PSIM (empreintes des fichiers) : après décompression, la commande',
    '  « sha256sum -c MANIFEST.sha256 » (Linux, macOS, Git Bash) contrôle chaque fichier.',
    '',
    'TRACE DE L\'EXPORT',
    '  Cet export a été inscrit dans le journal du PSIM (action « export_preuve »), avec l\'empreinte SHA-256 du',
    '  présent fichier .zip. Le gestionnaire du PSIM peut ainsi confirmer, plus tard, que le dossier remis est',
    '  bien celui qui a été produit (empreinte du .zip à comparer à celle de l\'entrée de journal).',
  );
  if (anchor) lines.push('', 'EMPREINTE DU JOURNAL À L\'EXPORT (ancre)', `  ${anchor.id}:${anchor.hash}`, '  À comparer à une empreinte conservée ailleurs ; elle figure aussi dans journal-extrait.json.');
  lines.push('');
  return lines.join('\r\n');
}

interface ReportInput {
  cfg: ProofConfig;
  actor: string;
  incidentId: number;
  inc: Row;
  category: DeviceCategory;
  now: number;
  incidentDoc: { incident: { ouverture: ReturnType<typeof when>; accuse: { par: string | null } | null; cloture: { par: string | null } | null; commentaire: string | null; motif_evenement: string | null; statut: unknown; gravite: unknown; qualification_libelle: string }; equipement: { id: string; nom: string | null; categorie_libelle: string; zone: string; etage: string; cameras_liees: string[] }; personnes_intervenues: string[]; fuseau_horaire_serveur: string };
  entries: ProofJournalEntry[];
  states: { etat: string; debut: ReturnType<typeof when>; fin: ReturnType<typeof when>; en_cours: boolean }[];
  notifications: { date: ReturnType<typeof when>; canal: string; destinataire: string; niveau: number; statut: string; tentatives: number; type: string }[];
  images: ProofImage[];
  anomalies: string[];
  warnings: string[];
  inlineThumbs: Map<number, Buffer>;
  journal: ProofJournal;
  omittedRights: number;
}

const STATE_TEXT: Record<string, string> = { normal: 'normal', prealarm: 'préalarme', alarm: 'alarme', fault: 'défaut', offline: 'hors ligne' };

/** Rapport lisible et imprimable : aucune ressource externe, aucun script (style integre, images integrees en base64). */
function reportHtml(r: ReportInput): string {
  const i = r.incidentDoc;
  const t = (ms: number | null | undefined) => esc(ms === null || ms === undefined ? '' : localStamp(ms));
  const table = (head: string[], rows: string[][]) =>
    rows.length === 0
      ? '<p class="empty">Aucune donnée.</p>'
      : `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const banner =
    r.anomalies.length > 0
      ? `<div class="alert"><strong>ANOMALIES CONSTATÉES À L'EXPORT</strong><ul>${r.anomalies.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>`
      : '<div class="ok">Aucune anomalie constatée à l\'export sur les images et le journal présentés.</div>';
  const warn = r.warnings.length > 0 ? `<div class="note"><strong>Remarques</strong><ul>${r.warnings.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>` : '';
  const imageCards = r.images
    .map((im) => {
      const thumb = r.inlineThumbs.get(im.id);
      const mime = thumb && thumb[0] === 0x89 ? 'image/png' : 'image/jpeg';
      const bad = im.etat !== 'conforme' && im.etat !== 'non_scellee';
      return `<figure class="${bad ? 'bad' : ''}">${thumb ? `<img alt="Image n°${im.id}" src="data:${mime};base64,${thumb.toString('base64')}">` : `<div class="noimg">${esc(IMAGE_STATE_TEXT[im.etat])}</div>`}
<figcaption><strong>Image n°${im.id}</strong> — ${esc(im.source === 'camera' ? 'caméra liée' : "envoyée par l'équipement")} ${esc(im.equipement)}${im.pris_le ? `<br>${t(im.pris_le)}` : ''}<br>État : <strong>${esc(IMAGE_STATE_TEXT[im.etat])}</strong>${im.fichier ? `<br>Fichier : ${esc(im.fichier)}` : ''}${im.sha256_scelle ? `<br>SHA-256 scellée : <code>${esc(im.sha256_scelle)}</code>` : '<br>Aucune empreinte scellée'}${im.sha256_dossier && im.sha256_dossier !== im.sha256_scelle ? `<br>SHA-256 du fichier : <code>${esc(im.sha256_dossier)}</code>` : ''}</figcaption></figure>`;
    })
    .join('');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dossier de preuve — incident n°${r.incidentId}</title>
<style>
body{font:14px/1.45 system-ui,Segoe UI,Arial,sans-serif;color:#1a1a1a;background:#fff;margin:0 auto;max-width:1000px;padding:24px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:26px 0 8px;border-bottom:1px solid #bbb;padding-bottom:3px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #ccc;padding:4px 7px;text-align:left;vertical-align:top}th{background:#f1f1f1}
td.k{width:30%;font-weight:600;background:#f7f7f7}code{font:12px Consolas,monospace;word-break:break-all}
.alert{border:2px solid #b00020;background:#fdecee;padding:8px 14px;margin:12px 0}.ok{border:1px solid #2e7d32;background:#edf7ee;padding:8px 14px;margin:12px 0}
.note{border:1px solid #b58900;background:#fff8e1;padding:8px 14px;margin:12px 0}.empty,.small{color:#555;font-size:12px}
.limits{border:1px solid #999;padding:6px 14px;margin:16px 0;background:#fafafa}
.shots{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0;width:300px;border:1px solid #ccc;padding:6px;break-inside:avoid}figure.bad{border:2px solid #b00020}
figure img{width:100%;height:auto;display:block}.noimg{background:#fdecee;color:#b00020;font-weight:600;padding:40px 8px;text-align:center}figcaption{font-size:12px;margin-top:4px}
@media print{body{padding:0}}
</style></head><body>
<h1>Dossier de preuve — incident n°${r.incidentId}</h1>
<p class="small">${esc(r.cfg.siteName())} — établi le ${t(r.now)} (heure du serveur, fuseau ${esc(i.fuseau_horaire_serveur)}) — export demandé par ${esc(r.actor)}</p>
${banner}${warn}
<div class="limits"><strong>Ce que ce document prouve et ne prouve pas.</strong> Il présente ce que le PSIM a enregistré. Les empreintes (SHA-256) permettent de constater qu'aucun fichier, aucune entrée de journal et aucune image n'a été modifié depuis l'export (vérification : <code>npm run verify-proof</code>). Les heures sont celles du serveur, sans horodatage certifié. Il ne remplace pas une expertise ; voir LISEZ-MOI.txt.</div>
<h2>Identité de l'incident</h2>
<table><tbody>
<tr><td class="k">Numéro</td><td>${r.incidentId}</td></tr>
<tr><td class="k">Équipement</td><td>${esc(i.equipement.id)} — ${esc(i.equipement.nom ?? '')} (${esc(i.equipement.categorie_libelle)})</td></tr>
<tr><td class="k">Zone / étage</td><td>${esc(i.equipement.zone || 'non renseignée')} / ${esc(i.equipement.etage || 'non renseigné')}</td></tr>
<tr><td class="k">Caméras liées</td><td>${esc(i.equipement.cameras_liees.join(', ') || 'aucune')}</td></tr>
<tr><td class="k">Gravité / statut</td><td>${esc(String(i.incident.gravite))} / ${esc(String(i.incident.statut))}</td></tr>
<tr><td class="k">Motif de l'événement</td><td>${esc(i.incident.motif_evenement ?? 'non précisé')}</td></tr>
<tr><td class="k">Ouverture</td><td>${t(i.incident.ouverture?.ms)}</td></tr>
<tr><td class="k">Acquittement</td><td>${i.incident.accuse ? esc(i.incident.accuse.par ?? 'inconnu') : 'non acquitté'}</td></tr>
<tr><td class="k">Clôture / qualification</td><td>${i.incident.cloture ? `${esc(i.incident.cloture.par ?? 'inconnu')} — ` : 'non clôturé — '}${esc(i.incident.qualification_libelle)}</td></tr>
<tr><td class="k">Commentaire</td><td>${esc(i.incident.commentaire ?? '')}</td></tr>
<tr><td class="k">Personnes intervenues</td><td>${esc(i.personnes_intervenues.join(', ') || 'aucune')}</td></tr>
</tbody></table>
<h2>États successifs de l'équipement</h2>
${table(['État', 'Début', 'Fin'], r.states.map((s) => [esc(STATE_TEXT[s.etat] ?? s.etat), t(s.debut?.ms), s.en_cours ? 'en cours' : t(s.fin?.ms)]))}
<h2>Chronologie (journal)</h2>
${table(['N°', 'Heure', 'Auteur', 'Action', 'Équipement', 'Détails'], r.entries.map((e) => [String(e.id), t(e.ts), esc(e.actor), esc(e.action), esc(e.device_id ?? ''), esc(e.details ?? '')]))}
<p class="small">${r.entries.length} entrée(s) du journal${r.omittedRights ? `, ${r.omittedRights} entrée(s) d'administration non incluses (droits de l'exportateur)` : ''}. Fenêtre : du ${t(r.journal.fenetre.debut)} au ${t(r.journal.fenetre.fin)}. Les empreintes de chaque entrée sont dans journal-extrait.json.${r.journal.ancre ? ` Empreinte du journal à l'export : <code>${r.journal.ancre.id}:${esc(r.journal.ancre.hash)}</code>` : ''}</p>
<h2>Images</h2>
${r.images.length === 0 ? '<p class="empty">Aucune image enregistrée pour cet incident.</p>' : `<div class="shots">${imageCards}</div>`}
<h2>Personnes prévenues</h2>
${table(['Heure', 'Canal', 'Destinataire', 'Niveau', 'Résultat', 'Tentatives'], r.notifications.map((n) => [t(n.date?.ms), esc(n.canal), esc(n.destinataire), String(n.niveau), esc(n.statut), String(n.tentatives)]))}
<p class="small">Document généré par le PSIM ; sans script ni ressource externe. Empreinte de chaque fichier du dossier : MANIFEST.sha256.</p>
</body></html>
`;
}

// ---------------------------------------------------------------- limitation de debit

/** Fenetre glissante par cle : renvoie 0 si la demande est acceptee, sinon le nombre de secondes a attendre. */
export function createLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return (key: string): number => {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0] + windowMs - t) / 1000));
    }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 1000) for (const [k, v] of hits) if (v.every((x) => t - x >= windowMs)) hits.delete(k);
    return 0;
  };
}

// ---------------------------------------------------------------- service

export interface ProofDeps extends ProofConfig {
  audit: AuditFn;
  /** Exports par minute et par compte (defaut 6). */
  perMinute?: number;
}

export function createProofService(deps: ProofDeps) {
  const limit = createLimiter(deps.perMinute ?? 6, MIN, deps.now);

  /**
   * Construit le dossier ET l'inscrit au journal (`export_preuve`, avec l'empreinte du .zip) avant de le rendre : sans
   * trace, pas de dossier. Si l'inscription echoue, l'exception remonte et rien n'est livre.
   */
  function exportPack(incidentId: number, options: ProofOptions): ProofPack {
    const pack = buildProofPack(deps, incidentId, options);
    deps.audit(options.actor, PROOF_ACTION, {
      incidentId,
      details: `dossier de preuve ${pack.fileName} sha256=${pack.sha256} ${pack.zip.length} octets ; manifeste sha256=${pack.manifestSha256} ; ${pack.journalEntries} entree(s) de journal, ${pack.images} image(s)${pack.anomalies.length ? ` ; ${pack.anomalies.length} ANOMALIE(S) signalee(s) dans le dossier` : ''}`,
    });
    return pack;
  }

  /** Route de telechargement. `guards.anyUser` : operateurs et administrateurs connectes, jamais le portail. A monter AVANT la route « /api » de repli. */
  function mount(app: Express, guards: { anyUser: RequestHandler; actorOf: (req: Request) => string; roleOf: (req: Request) => string }): void {
    const { anyUser } = guards; // nom lu tel quel par l'auto-test des routes (test/e2e-attack.test.ts)
    app.get('/api/incidents/:id/proof', anyUser, (req: Request, res: Response) => {
      const raw = String(req.params.id);
      const id = /^\d{1,12}$/.test(raw) ? Number(raw) : 0;
      if (id < 1) throw new PsimError(404, 'Incident introuvable');
      const actor = guards.actorOf(req);
      const wait = limit(actor);
      if (wait > 0) {
        res.setHeader('Retry-After', String(wait));
        throw new PsimError(429, `Trop d'exports de dossiers de preuve : reessayez dans ${wait} s`);
      }
      const pack = exportPack(id, { actor, isAdmin: guards.roleOf(req) === 'admin' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${pack.fileName}"`);
      res.setHeader('Content-Length', String(pack.zip.length));
      res.setHeader('Cache-Control', 'no-store');
      res.end(pack.zip);
    });
  }

  return { exportPack, mount };
}

export type ProofService = ReturnType<typeof createProofService>;
