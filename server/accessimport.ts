/**
 * Import CSV des titulaires (F25, docs/ACCES.md § 12.5).
 *
 *  - `parseHolderCsv` est PURE : decodage, separateur, RFC 4180 en une passe, controle de tout ce qui releve du fichier.
 *  - `runImport` applique les lignes valides par l'interface `HoldersService` (dans `batch`, ou `simulate` pour un essai a blanc),
 *    chaque ligne isolee des autres.
 * Rien ne leve : toute entree hostile donne un `ImportReport` (avec `fatal` si le fichier entier est inutilisable).
 */
import { PsimError } from './errors.ts';
import type { HolderInput, HolderStatus, HolderView, HoldersService, ImportLineReport, ImportReport } from './accessholderstypes.ts';
import { hasForbiddenChar, normalizeName } from './text.ts';

// ---- Plafonds -----------------------------------------------------------------------------------------------------------------

export const IMPORT_MAX_BYTES = 1024 * 1024;
export const IMPORT_MAX_ROWS = 5000;
export const IMPORT_MAX_COLS = 20;
export const IMPORT_MAX_CELL = 500;
export const IMPORT_MAX_ITEMS = 2000;

const NAME_MAX = 40;
const REF_MAX = 32;
const MAX_GROUPS = 20;
const BADGE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,32}$/;

// ---- Types ----------------------------------------------------------------------------------------------------------------------

export type Delimiter = ';' | ',' | '\t';

/** Champs normalises d'une ligne valide. `undefined` : colonne absente ou cellule vide (valeur actuelle inchangee). */
export interface ParsedFields {
  lastName: string;
  firstName?: string;
  externalRef?: string;
  badges: string[];
  /** `null` : colonne `groupe` absente ou vide (les groupes ne changent pas). */
  groups: string[] | null;
  validFrom?: number;
  validTo?: number;
  status?: HolderStatus;
}

export interface ParsedRow {
  /** Numero de ligne dans le fichier (l'en-tete est la ligne 1). */
  line: number;
  /** « NOM Prenom » si la cellule du nom est saine, sinon `null`. */
  name: string | null;
  fields: ParsedFields | null;
  errors: string[];
  warnings: string[];
}

export interface ParsedCsv {
  fatal: string | null;
  encoding: 'utf-8' | 'windows-1252';
  delimiter: Delimiter;
  /** Remarques sur le fichier entier (colonne inconnue ignoree...). */
  warnings: string[];
  rows: ParsedRow[];
}

// ---- Decodage ------------------------------------------------------------------------------------------------------------------

interface Decoded {
  text: string;
  encoding: 'utf-8' | 'windows-1252';
}

function decode(bytes: Buffer): Decoded {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }; // le BOM est retire
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

/** Sans accents ni majuscules. */
const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

// ---- Analyse RFC 4180 (une passe) ---------------------------------------------------------------------------------------------

interface Cell {
  v: string;
  long: boolean;
}

interface RawRecord {
  line: number;
  cells: Cell[];
  dropped: number;
}

/** Separateur le plus frequent hors guillemets sur la premiere ligne (egalite : `;`). */
function detectDelimiter(text: string): Delimiter {
  const count = { ';': 0, ',': 0, '\t': 0 };
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34) inQ = !inQ;
    else if (!inQ) {
      if (c === 10 || c === 13) break;
      if (c === 59) count[';']++;
      else if (c === 44) count[',']++;
      else if (c === 9) count['\t']++;
    }
  }
  if (count[';'] >= count[','] && count[';'] >= count['\t']) return ';';
  return count[','] >= count['\t'] ? ',' : '\t';
}

function scan(text: string, delimiter: Delimiter): { records: RawRecord[]; unclosed: boolean; tooMany: boolean } {
  const delim = delimiter.charCodeAt(0);
  const records: RawRecord[] = [];
  let cells: Cell[] = [];
  let dropped = 0;
  let cur = '';
  let curLen = 0;
  let state = 0; // 0 debut de champ, 1 champ nu, 2 entre guillemets, 3 apres le guillemet fermant
  let line = 1;
  let recLine = 1;
  let tooMany = false;

  const endField = (): void => {
    if (cells.length <= IMPORT_MAX_COLS) cells.push({ v: cur, long: curLen > IMPORT_MAX_CELL });
    else dropped++;
    cur = '';
    curLen = 0;
    state = 0;
  };
  const endRecord = (): void => {
    endField();
    const blank = dropped === 0 && cells.every((c) => !c.long && c.v.trim() === '');
    if (!blank) {
      records.push({ line: recLine, cells, dropped });
      if (records.length > IMPORT_MAX_ROWS + 1) tooMany = true;
    }
    cells = [];
    dropped = 0;
    recLine = line;
  };
  const add = (ch: string): void => {
    if (curLen <= IMPORT_MAX_CELL) cur += ch;
    curLen++;
  };

  const n = text.length;
  let i = 0;
  for (; i < n && !tooMany; i++) {
    const c = text.charCodeAt(i);
    if (state === 2) {
      if (c === 34) {
        if (text.charCodeAt(i + 1) === 34) {
          add('"');
          i++;
        } else state = 3;
      } else {
        if (c === 10) line++;
        add(text[i] as string);
      }
      continue;
    }
    if (c === delim) endField();
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      line++;
      endRecord();
    } else if (c === 10) {
      line++;
      endRecord();
    } else if (c === 34 && state === 0) state = 2;
    else {
      add(text[i] as string);
      if (state === 0) state = 1;
    }
  }
  if (!tooMany) {
    if (state === 2) return { records, unclosed: true, tooMany };
    if (cells.length > 0 || curLen > 0 || state !== 0) endRecord();
  }
  return { records, unclosed: false, tooMany };
}

// ---- Controle des cellules ------------------------------------------------------------------------------------------------------

type Column = 'nom' | 'prenom' | 'matricule' | 'badge1' | 'badge2' | 'badge3' | 'badge4' | 'groupe' | 'debut' | 'fin' | 'statut';
const COLUMNS: readonly string[] = ['nom', 'prenom', 'matricule', 'badge1', 'badge2', 'badge3', 'badge4', 'groupe', 'debut', 'fin', 'statut'];
const BADGE_COLUMNS: Column[] = ['badge1', 'badge2', 'badge3', 'badge4'];
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Motif de refus d'une cellule, ou `null`. */
function cellProblem(cell: Cell): string | null {
  if (cell.long) return `plus de ${IMPORT_MAX_CELL} caractères`;
  const t = cell.v.trim();
  if (/^[=+\-@\t\r]/.test(cell.v) || /^[=+\-@]/.test(t)) return 'injection de formule (la cellule ne doit pas commencer par = + - @)';
  if (CONTROL.test(cell.v)) return 'caractère de contrôle interdit (retour à la ligne, tabulation...)';
  if (hasForbiddenChar(cell.v)) return 'caractère invisible interdit';
  if (/[<>]/.test(cell.v)) return 'caractères « < » et « > » interdits';
  return null;
}

/** `AAAA-MM-JJ` ou `JJ/MM/AAAA` -> [annee, mois, jour] d'une vraie date du calendrier, sinon `null`. */
function parseDate(s: string): [number, number, number] | null {
  let y: number;
  let m: number;
  let d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (r) {
    y = Number(r[1]);
    m = Number(r[2]);
    d = Number(r[3]);
  } else {
    r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (!r) return null;
    d = Number(r[1]);
    m = Number(r[2]);
    y = Number(r[3]);
  }
  if (y < 1970 || y > 2100) return null;
  const t = new Date(y, m - 1, d);
  if (t.getFullYear() !== y || t.getMonth() !== m - 1 || t.getDate() !== d) return null;
  return [y, m, d];
}

// ---- parseHolderCsv ------------------------------------------------------------------------------------------------------------

const emptyParsed = (fatal: string, encoding: ParsedCsv['encoding'] = 'utf-8', delimiter: Delimiter = ';'): ParsedCsv => ({
  fatal,
  encoding,
  delimiter,
  warnings: [],
  rows: [],
});

export function parseHolderCsv(bytes: Buffer): ParsedCsv {
  try {
    return parse(bytes);
  } catch {
    return emptyParsed('Fichier illisible.');
  }
}

function parse(bytes: Buffer): ParsedCsv {
  if (bytes.length === 0) return emptyParsed('Le fichier est vide.');
  if (bytes.length > IMPORT_MAX_BYTES) return emptyParsed('Fichier trop grand (1 Mo au plus).');
  if (bytes.includes(0)) return emptyParsed("Ce fichier n'est pas un fichier texte CSV (octets nuls).");
  const { text, encoding } = decode(bytes);
  const delimiter = detectDelimiter(text);
  const { records, unclosed, tooMany } = scan(text, delimiter);
  const fail = (m: string): ParsedCsv => emptyParsed(m, encoding, delimiter);
  if (unclosed) return fail('Guillemet non fermé : le fichier est mal formé.');
  if (tooMany) return fail(`Plus de ${IMPORT_MAX_ROWS} lignes de données : découpez le fichier.`);
  const header = records[0];
  if (!header) return fail('Le fichier est vide.');
  if (header.dropped > 0 || header.cells.length > IMPORT_MAX_COLS) return fail(`Plus de ${IMPORT_MAX_COLS} colonnes.`);

  // En-tete : colonnes reconnues sans accents ni casse ; `badge` vaut `badge1`.
  const index = new Map<Column, number>();
  const warnings: string[] = [];
  const unknown: string[] = [];
  for (let c = 0; c < header.cells.length; c++) {
    const raw = (header.cells[c] as Cell).v;
    let key = fold(raw);
    if (key === 'badge') key = 'badge1';
    if (key === '') continue;
    if (!COLUMNS.includes(key)) {
      unknown.push(raw.trim().slice(0, 40).replace(CONTROL, ' '));
      continue;
    }
    if (index.has(key as Column)) return fail(`Colonne en double dans l'en-tête : « ${key} ».`);
    index.set(key as Column, c);
  }
  if (!index.has('nom')) return fail("Colonne obligatoire absente : « nom ». L'en-tête doit être la première ligne.");
  if (unknown.length > 0) warnings.push(`Colonne(s) ignorée(s) : ${unknown.map((u) => `« ${u} »`).join(', ')}.`);

  const rows: ParsedRow[] = [];
  const seenRef = new Map<string, number>();
  const seenBadge = new Map<string, number>();
  for (let r = 1; r < records.length; r++) rows.push(parseRow(records[r] as RawRecord, header.cells.length, index, seenRef, seenBadge));
  return { fatal: null, encoding, delimiter, warnings, rows };
}

function parseRow(rec: RawRecord, headerLen: number, index: Map<Column, number>, seenRef: Map<string, number>, seenBadge: Map<string, number>): ParsedRow {
  const errors: string[] = [];
  const bad = new Set<Column>();
  const blank: Cell = { v: '', long: false };
  const cell = (k: Column): Cell => {
    const i = index.get(k);
    return i === undefined ? blank : (rec.cells[i] ?? blank);
  };
  // Controle de chaque cellule des colonnes reconnues.
  for (const k of index.keys()) {
    const p = cellProblem(cell(k));
    if (p) {
      errors.push(`Colonne « ${k} » : ${p}.`);
      bad.add(k);
    }
  }
  if (rec.dropped > 0 || rec.cells.length > IMPORT_MAX_COLS) errors.push(`Plus de ${IMPORT_MAX_COLS} colonnes.`);
  for (let c = headerLen; c < rec.cells.length; c++) {
    // Cellules au-dela des colonnes de l'en-tete : tolerees si vides.
    if ((rec.cells[c] as Cell).v.trim() !== '') {
      errors.push("Plus de valeurs que de colonnes dans l'en-tête.");
      break;
    }
  }
  const val = (k: Column): string => cell(k).v.trim();

  // Nom et prenom.
  const lastName = normalizeName(val('nom'));
  const firstName = normalizeName(val('prenom'));
  if (!bad.has('nom')) {
    if (lastName === '') errors.push('Colonne « nom » : obligatoire.');
    else if ([...lastName].length > NAME_MAX) errors.push(`Colonne « nom » : ${NAME_MAX} caractères au plus.`);
  }
  if (!bad.has('prenom') && [...firstName].length > NAME_MAX) errors.push(`Colonne « prenom » : ${NAME_MAX} caractères au plus.`);

  // Matricule.
  let externalRef = '';
  if (!bad.has('matricule') && val('matricule') !== '') {
    externalRef = val('matricule');
    if (!REF_RE.test(externalRef)) {
      errors.push(`Colonne « matricule » : caractères permis A-Z a-z 0-9 . _ / - (${REF_MAX} au plus).`);
      externalRef = '';
    }
  }

  // Badges.
  const badges: string[] = [];
  for (const k of BADGE_COLUMNS) {
    if (bad.has(k) || val(k) === '') continue;
    const b = val(k);
    if (!BADGE_RE.test(b)) {
      errors.push(`Colonne « ${k} » : numéro de badge invalide (lettres, chiffres, _ et - ; 32 au plus).`);
    } else if (badges.some((x) => x.toLowerCase() === b.toLowerCase())) {
      errors.push(`Colonne « ${k} » : le badge ${b} est répété sur cette ligne.`);
    } else badges.push(b);
  }

  // Groupes.
  let groups: string[] | null = null;
  if (!bad.has('groupe') && val('groupe') !== '') {
    const list: string[] = [];
    for (const g of val('groupe').split('|')) {
      const name = normalizeName(g);
      if (name !== '' && !list.some((x) => fold(x) === fold(name))) list.push(name);
    }
    if (list.length > MAX_GROUPS) errors.push(`Colonne « groupe » : ${MAX_GROUPS} groupes au plus.`);
    else if (list.length > 0) groups = list;
  }

  // Dates.
  let validFrom: number | undefined;
  let validTo: number | undefined;
  for (const k of ['debut', 'fin'] as const) {
    if (bad.has(k) || val(k) === '') continue;
    const d = parseDate(val(k));
    if (!d) {
      errors.push(`Colonne « ${k} » : date invalide (AAAA-MM-JJ ou JJ/MM/AAAA, jour réel du calendrier).`);
    } else if (k === 'debut') validFrom = new Date(d[0], d[1] - 1, d[2], 0, 0, 0, 0).getTime();
    else validTo = new Date(d[0], d[1] - 1, d[2], 23, 59, 59, 0).getTime();
  }
  if (validFrom !== undefined && validTo !== undefined && validTo < validFrom) errors.push('La date de fin précède la date de début.');

  // Statut.
  let status: HolderStatus | undefined;
  if (!bad.has('statut') && val('statut') !== '') {
    const s = fold(val('statut'));
    if (s === 'actif') status = 'active';
    else if (s === 'suspendu') status = 'suspended';
    else errors.push('Colonne « statut » : « actif » ou « suspendu » attendu.');
  }

  // Doublons avec une ligne precedente du fichier (seules les lignes valides reservent leurs identifiants).
  if (errors.length === 0) {
    if (externalRef !== '') {
      const first = seenRef.get(externalRef.toLowerCase());
      if (first !== undefined) errors.push(`Matricule ${externalRef} déjà présent à la ligne ${first} du fichier.`);
    }
    for (const b of badges) {
      const first = seenBadge.get(b.toLowerCase());
      if (first !== undefined) errors.push(`Badge ${b} déjà présent à la ligne ${first} du fichier.`);
    }
    if (errors.length === 0) {
      if (externalRef !== '') seenRef.set(externalRef.toLowerCase(), rec.line);
      for (const b of badges) seenBadge.set(b.toLowerCase(), rec.line);
    }
  }

  const name = !bad.has('nom') && !bad.has('prenom') && lastName !== '' ? `${lastName}${firstName ? ' ' + firstName : ''}` : null;
  if (errors.length > 0) return { line: rec.line, name, fields: null, errors, warnings: [] };
  const fields: ParsedFields = { lastName, badges, groups };
  if (firstName !== '') fields.firstName = firstName;
  if (externalRef !== '') fields.externalRef = externalRef;
  if (validFrom !== undefined) fields.validFrom = validFrom;
  if (validTo !== undefined) fields.validTo = validTo;
  if (status) fields.status = status;
  return { line: rec.line, name, fields, errors, warnings: [] };
}

// ---- runImport ------------------------------------------------------------------------------------------------------------------

export interface ImportDeps {
  holders: HoldersService;
  actor: string;
  audit: (actor: string, action: string, ref?: { details?: string }) => void;
  dryRun: boolean;
}

type Outcome = ImportLineReport['outcome'];
const INTERNAL = "Erreur interne : cette ligne n'a pas pu être traitée.";
const QUIET = { quiet: true } as const;

const sameName = (h: HolderView, f: ParsedFields): boolean =>
  fold(h.lastName) === fold(f.lastName) && fold(h.firstName) === fold(f.firstName ?? '');

function emptyReport(dryRun: boolean, parsed: ParsedCsv, fatal: string | null): ImportReport {
  return {
    dryRun,
    encoding: parsed.encoding,
    delimiter: parsed.delimiter,
    lines: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    errors: 0,
    items: [],
    truncated: false,
    fatal,
  };
}

export function runImport(bytes: Buffer, deps: ImportDeps): ImportReport {
  let parsed: ParsedCsv;
  try {
    parsed = parseHolderCsv(bytes);
  } catch {
    parsed = emptyParsed('Fichier illisible.');
  }
  if (parsed.fatal) return emptyReport(deps.dryRun, parsed, parsed.fatal);

  const results: ImportLineReport[] = [];
  const apply = (): void => {
    for (const row of parsed.rows) {
      const item: ImportLineReport = { line: row.line, outcome: 'error', name: row.name, errors: [...row.errors], warnings: [...row.warnings] };
      if (row.fields && row.errors.length === 0) {
        try {
          item.outcome = applyRow(deps.holders, deps.actor, row.fields, item);
        } catch (e) {
          item.outcome = 'error';
          item.errors.push(e instanceof PsimError ? e.message : INTERNAL);
        }
      }
      if (item.errors.length > 0) item.outcome = 'error';
      results.push(item);
    }
  };

  try {
    if (deps.dryRun) deps.holders.simulate(apply);
    else deps.holders.batch(apply);
  } catch {
    // Echec d'ensemble (transaction) : rien n'est applique, on ne donne pas de resultat partiel.
    return emptyReport(deps.dryRun, parsed, "Erreur interne : l'import n'a pas pu être appliqué. Aucune ligne n'a été enregistrée.");
  }

  // Les avertissements du fichier (colonne ignoree) sont rattaches a la premiere ligne de donnees.
  const first = results[0];
  if (first) first.warnings.unshift(...parsed.warnings);

  const report = emptyReport(deps.dryRun, parsed, null);
  report.lines = results.length;
  for (const r of results) {
    if (r.outcome === 'created') report.created++;
    else if (r.outcome === 'updated') report.updated++;
    else if (r.outcome === 'unchanged') report.unchanged++;
    else report.errors++;
  }
  const rank = (r: ImportLineReport): number => (r.outcome === 'error' ? 0 : r.warnings.length > 0 ? 1 : 2);
  const ordered = [...results.filter((r) => rank(r) === 0), ...results.filter((r) => rank(r) === 1), ...results.filter((r) => rank(r) === 2)];
  report.truncated = ordered.length > IMPORT_MAX_ITEMS;
  report.items = ordered.slice(0, IMPORT_MAX_ITEMS);

  if (!deps.dryRun) {
    try {
      deps.audit(deps.actor, 'access_import', {
        details: `${report.created} créé(s), ${report.updated} modifié(s), ${report.unchanged} inchangé(s), ${report.errors} en erreur`,
      });
    } catch {
      /* le journal ne doit jamais faire echouer le rapport */
    }
  }
  return report;
}

/** Applique une ligne valide. Leve `PsimError` (erreur de ligne) ; ajoute ses remarques a `item.warnings`. */
function applyRow(holders: HoldersService, actor: string, f: ParsedFields, item: ImportLineReport): Outcome {
  // Groupes : tous les noms doivent exister.
  let groupIds: number[] | undefined;
  if (f.groups) {
    const ids: number[] = [];
    const unknown: string[] = [];
    for (const g of f.groups) {
      const found = holders.groupByName(g);
      if (found) ids.push(found.id);
      else unknown.push(g);
    }
    if (unknown.length > 0) {
      item.errors.push(`Groupe(s) inconnu(s) : ${unknown.join(', ')}.`);
      return 'error';
    }
    groupIds = ids;
  }

  // Appariement.
  let existing: HolderView | null = null;
  if (f.externalRef) existing = holders.findByExternalRef(f.externalRef);
  const owners = new Map<string, HolderView>(); // numero de badge -> porteur
  for (const b of f.badges) {
    const o = holders.findByBadge(b);
    if (o) owners.set(b, o);
  }
  if (!f.externalRef) {
    const candidates = new Map<number, HolderView>();
    for (const o of owners.values()) {
      if (o.kind === 'visitor') {
        item.errors.push('Les visiteurs ne s’importent pas : ce badge est porté par un visiteur.');
        return 'error';
      }
      if (sameName(o, f)) candidates.set(o.id, o);
    }
    if (candidates.size > 1) {
      item.errors.push('Les badges de cette ligne appartiennent à deux titulaires différents.');
      return 'error';
    }
    existing = candidates.values().next().value ?? null;
  }
  if (existing && existing.kind === 'visitor') {
    item.errors.push('Les visiteurs ne s’importent pas : ce matricule est celui d’un visiteur.');
    return 'error';
  }
  for (const [b, o] of owners) {
    if (!existing || o.id !== existing.id) {
      item.errors.push(`Le badge ${b} est déjà porté par un autre titulaire (${o.displayName}).`);
      return 'error';
    }
  }

  if (!existing) {
    const input: HolderInput = { lastName: f.lastName, firstName: f.firstName ?? '', status: f.status ?? 'active' };
    if (f.externalRef) input.externalRef = f.externalRef;
    if (f.validFrom !== undefined) input.validFrom = f.validFrom;
    if (f.validTo !== undefined) input.validTo = f.validTo;
    if (groupIds) input.groupIds = groupIds;
    if (f.badges.length > 0) input.badges = f.badges;
    if (!f.externalRef && holders.findByName(f.lastName, f.firstName ?? '').length > 0) {
      item.warnings.push('Homonyme : un titulaire de même nom existe déjà, un nouveau titulaire a été créé.');
    }
    holders.create(actor, input, QUIET);
    return 'created';
  }

  // Mise a jour : seulement ce qui change, champs vides inchangés.
  const patch: HolderInput = {};
  if (existing.lastName !== f.lastName) patch.lastName = f.lastName;
  if (f.firstName !== undefined && existing.firstName !== f.firstName) patch.firstName = f.firstName;
  if (f.status !== undefined && existing.status !== f.status) patch.status = f.status;
  if (f.validFrom !== undefined && existing.validFrom !== f.validFrom) patch.validFrom = f.validFrom;
  if (f.validTo !== undefined && existing.validTo !== f.validTo) patch.validTo = f.validTo;
  if (groupIds) {
    const current = new Set(existing.groups.map((g) => g.id));
    if (current.size !== groupIds.length || groupIds.some((g) => !current.has(g))) patch.groupIds = groupIds;
  }
  const have = new Set(existing.badges.filter((b) => b.state !== 'returned').map((b) => b.number.toLowerCase()));
  const missing = f.badges.filter((b) => !have.has(b.toLowerCase()));

  if (Object.keys(patch).length === 0 && missing.length === 0) return 'unchanged';
  if (Object.keys(patch).length > 0) holders.update(actor, existing.id, patch, QUIET);
  for (const b of missing) holders.addBadge(actor, existing.id, b, QUIET);
  return 'updated';
}
