/**
 * Packs d'installation : un pack (dossier avec `pack.json` et ses plans) decrit une installation type ; il s'installe
 * en une commande et s'accompagne de sa recette. Format et bonnes pratiques : docs/PACKS.md.
 *
 *   npm run pack -- check <pack>                    validation seule (format, references, secrets, modeles)
 *   npm run pack -- plan <pack>                     SIMULATION : ce qui serait cree / modifie / ignore, rien n'est ecrit
 *   npm run pack -- apply <pack>                    montre le plan, demande confirmation, applique (tout ou rien)
 *   npm run pack -- export --out <dossier>          exporte l'installation courante en pack, sans aucun secret
 *
 * Options :
 *   --answers <fichier.json>   reponses aux valeurs demandees ({"libelle": "valeur"}) ; sinon saisie au clavier (masquee
 *                              pour les mots de passe) ; les {"$env": "NOM"} sont lus dans l'environnement
 *   --update                   remplace l'existant different du pack (sinon : conflit, rien n'est applique)
 *   --keep-existing            garde l'existant different du pack et applique le reste
 *   --allow-unqualified        accepte des modeles a qualifier (apply)
 *   --yes                      confirme sans question (apply) ; le plan est quand meme affiche
 *   --by "Nom"                 installateur, cite au journal (`pack_applique`)
 *   --recette                  lance la recette (`commission --pack`) juste apres l'application
 *   --data-dir <dossier>       dossier de donnees (sinon PSIM_DATA_DIR, ou data)
 *   export : --id --name --segment --level --version --description --force
 *
 * Production : `npm run pack:prod -- ...` (lit .env.production). `apply` refuse d'agir pendant que le PSIM tourne : le PSIM
 * garde la configuration en memoire et ne verrait pas les changements ; il prend le verrou du dossier de donnees le temps
 * de l'application (le PSIM ne peut pas demarrer pendant ce temps). `plan`, `check` et `export` ne modifient rien et
 * peuvent tourner a cote du PSIM.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.ts';
import { acquireLock, lockHolder } from '../server/lock.ts';
import type { ChannelId } from '../server/recipients.ts';
import { loadSecretKey } from '../server/secrets.ts';
import { hasForbiddenChar } from '../server/text.ts';
import { applyPack } from './pack/apply.ts';
import type { Action, Mode, Report, Section } from './pack/apply.ts';
import { exportPack } from './pack/export.ts';
import { checkAnswer, collectAnswers, loadPack } from './pack/load.ts';
import type { Answers, LoadedPack } from './pack/load.ts';
import { qualify, withRegistryStatus } from './pack/qualification.ts';
import type { QualificationReport } from './pack/qualification.ts';
import { LEVELS, SEGMENTS } from './pack/schema.ts';
import type { Pack, Question } from './pack/schema.ts';

const ROOT = resolve(import.meta.dirname, '..');

export interface Io {
  print: (line: string) => void;
  error: (line: string) => void;
  /** Question au clavier ; absente = pas de terminal (les reponses doivent venir d'un fichier). */
  ask: ((prompt: string, hidden: boolean) => Promise<string>) | null;
  env: NodeJS.ProcessEnv;
  /** Dossier de qualification dont le registre fait foi (par defaut qualification/ a la racine du depot). */
  qualificationDir: string;
}

const SECTIONS: Record<Section, string> = {
  etage: 'Etages',
  plan: "Plans d'etage",
  equipement: 'Equipements',
  source: 'Sources',
  liens: 'Liens detecteur -> cameras',
  armement: "Planning d'armement",
  risque: 'Evaluation de risque',
  destinataire: 'Destinataires',
};
const MARKS: Record<Action, [string, string]> = {
  create: ['+ a creer      ', '+ cree         '],
  update: ['~ a modifier   ', '~ modifie      '],
  same: ['= deja conforme', '= deja conforme'],
  conflict: ['! CONFLIT      ', '! CONFLIT      '],
  skip: ['- ignore       ', '- ignore       '],
};

export function formatReport(report: Report, done: boolean): string {
  const lines: string[] = [];
  for (const [section, title] of Object.entries(SECTIONS) as [Section, string][]) {
    const items = report.items.filter((i) => i.section === section);
    if (!items.length) continue;
    lines.push(title);
    for (const i of items) lines.push(`  ${MARKS[i.action][done ? 1 : 0]} ${i.ref}${i.detail ? `  -  ${i.detail}` : ''}`);
  }
  lines.push('', `Bilan : ${report.summary}`);
  if (report.warnings.length) lines.push('', 'AVERTISSEMENTS', ...report.warnings.map((w) => `  ! ${w}`));
  if (report.error) lines.push('', `ECHEC : ${report.error}`);
  return lines.join('\n');
}

const optionValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

function modeOf(args: string[]): Mode | string {
  if (args.includes('--update') && args.includes('--keep-existing')) return '--update et --keep-existing sont incompatibles';
  return args.includes('--update') ? 'update' : args.includes('--keep-existing') ? 'keep' : 'strict';
}

function describePack(pack: Pack, loaded: LoadedPack): string[] {
  const cams = pack.devices.filter((d) => d.kind === 'camera').length;
  return [
    `Pack « ${pack.name} » (${pack.id} v${pack.version}, ${pack.segment} / ${pack.level}) - ${loaded.file}`,
    `  ${pack.floors.length} etage(s), ${pack.zones.length} zone(s), ${pack.devices.length - cams} detecteur(s), ${cams} camera(s), ${Object.keys(pack.links).length} detecteur(s) lie(s), ${pack.arming.length} planning(s), ${pack.risk.length} evaluation(s) de risque, ${pack.recipients.length} destinataire(s)`,
  ];
}

function qualificationLines(q: QualificationReport): string[] {
  const lines: string[] = [];
  if (q.blocking) lines.push(`  ! ${q.blocking}`);
  for (const w of q.warnings) lines.push(`  ! ${w}`);
  if (q.unqualified.length) {
    const byModel = new Map<string, string[]>();
    for (const u of q.unqualified) byModel.set(u.model, [...(byModel.get(u.model) ?? []), u.deviceId]);
    lines.push(`  ! AVERTISSEMENT : ${q.unqualified.length} equipement(s) d'un modele A QUALIFIER (jamais essaye sur materiel reel avec le PSIM) :`);
    for (const [model, ids] of byModel) lines.push(`      ${model} : ${ids.join(', ')}`);
    lines.push('    -> apply exige --allow-unqualified ; prevoir une recette renforcee (docs/PACKS.md, « Qualification »).');
  }
  return lines;
}

function questionLines(questions: Question[]): string[] {
  if (!questions.length) return [];
  return ['Valeurs demandees a l\'installation (jamais ecrites dans le pack) :', ...questions.map((q) => `  - ${q.env ? `variable ${q.env}` : `« ${q.label} »`}${q.secret ? ' (secret, saisie masquee)' : ''}  -> ${q.paths.join(', ')}`)];
}

interface Env {
  dataDir: string;
  dbFile: string;
  config: Awaited<typeof import('../server/config.ts')>['config'];
}

async function environment(args: string[]): Promise<Env> {
  const { config } = await import('../server/config.ts');
  const dataDir = resolve(ROOT, optionValue(args, '--data-dir') ?? config.dataDir);
  return { dataDir, dbFile: join(dataDir, 'psim.db'), config };
}

function channelsOf(config: Env['config']): Record<ChannelId, boolean> {
  const n = config.notify;
  return {
    email: Boolean(n.smtp.host && n.smtp.from),
    telegram: Boolean(n.telegram.token),
    whatsapp: Boolean(n.whatsapp.token && n.whatsapp.phoneId),
    callmebot: false,
    vonage: Boolean(n.vonage.applicationId && n.vonage.privateKey && n.vonage.from),
    webhook: true,
  };
}

/** Notes hors base : comptes de passerelle (.env), compte Tuya, modules conseilles. */
function siteNotes(pack: Pack, config: Env['config']): string[] {
  const lines: string[] = [];
  for (const a of pack.gateway.accounts) {
    const acc = config.mqttGateways.find((g) => g.user === a.name);
    const covered = (p: string) => acc?.detectors.some((q) => q === p || (q.endsWith('*') && p.replace(/\*$/, '').startsWith(q.slice(0, -1))));
    if (!acc || !a.devices.every(covered)) {
      lines.push(`  ! Passerelle : compte « ${a.name} » ${acc ? 'incomplet' : 'absent'} dans PSIM_MQTT_GATEWAYS (.env). Ligne a ajouter, avec un mot de passe genere (12 caracteres au moins), puis redemarrer le PSIM :`);
      lines.push(`      PSIM_MQTT_GATEWAYS=[{"user":"${a.name}","password":"<a generer>","detectors":${JSON.stringify(a.devices)}}]`);
    } else lines.push(`  = Passerelle : compte « ${a.name} » present et suffisant`);
  }
  if (pack.gateway.modules.length) lines.push(`  Modules de passerelle conseilles : ${pack.gateway.modules.map((m) => `${m.module}${m.note ? ` (${m.note})` : ''}`).join(' ; ')} - voir docs/PASSERELLE.md`);
  if (pack.devices.some((d) => d.source?.type === 'tuya') && !config.tuya.accessId) {
    lines.push('  ! Compte Tuya non configure (PSIM_TUYA_ACCESS_ID / PSIM_TUYA_ACCESS_SECRET) : les capteurs Tuya seront enregistres mais resteront « hors ligne » jusqu\'a sa configuration (docs/TUYA.md).');
  }
  return lines;
}

function readAnswersFile(path: string | undefined): { values: Record<string, unknown>; error: string | null } {
  if (!path) return { values: {}, error: null };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8').trimStart()) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { values: {}, error: `${path} : un objet {"libelle": "valeur"} est attendu` };
    return { values: raw as Record<string, unknown>, error: null };
  } catch (err) {
    return { values: {}, error: `${path} : ${(err as Error).message}` };
  }
}

/** Copie coherente de la base (lecture seule de l'originale) : la simulation s'y deroule, puis elle est jetee. */
function simulateOnCopy<T>(dbFile: string, run: (db: DatabaseSync) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'psim-pack-plan-'));
  try {
    const copy = join(dir, 'psim.db');
    const ro = new DatabaseSync(dbFile, { readOnly: true });
    try {
      ro.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    } finally {
      ro.close();
    }
    const db = openDb(copy);
    try {
      return run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function keyFor(env: Env, create: boolean): { key: Buffer; real: boolean } {
  if (env.config.secretKey || existsSync(join(env.dataDir, 'secret.key')) || create) return { key: loadSecretKey(env.dataDir, env.config.secretKey), real: true };
  return { key: randomBytes(32), real: false };
}

async function load(path: string | undefined, io: Io): Promise<{ loaded: LoadedPack; pack: Pack; q: QualificationReport } | null> {
  if (!path || path.startsWith('--')) {
    io.error('Chemin du pack manquant (dossier contenant pack.json, ou le fichier lui-meme).');
    return null;
  }
  const loaded = loadPack(path);
  if (!loaded.pack) {
    io.error(`Pack refuse : ${loaded.errors.length} erreur(s)`);
    for (const e of loaded.errors) io.error(`  - ${e}`);
    return null;
  }
  // Le registre de qualification fait foi : statut effectif de chaque equipement, et refus ferme si le registre est
  // inutilisable ou si un modele est rejete par l'atelier.
  const q = qualify(loaded.pack, io.qualificationDir);
  if (q.blocking) {
    io.error(`Pack refuse : ${q.blocking}`);
    return null;
  }
  return { loaded, pack: withRegistryStatus(loaded.pack, q), q };
}

async function cmdCheck(args: string[], io: Io): Promise<number> {
  const l = await load(args[0], io);
  if (!l) return 1;
  for (const line of describePack(l.pack, l.loaded)) io.print(line);
  io.print('Format, references et absence de secret : OK');
  for (const line of qualificationLines(l.q)) io.print(line);
  for (const line of questionLines(l.loaded.questions)) io.print(line);
  return 0;
}

interface Prepared {
  l: NonNullable<Awaited<ReturnType<typeof load>>>;
  env: Env;
  mode: Mode;
  answers: Answers;
  /** Questions utiles (sans les adresses d'un canal non configure). */
  questions: Question[];
}

async function prepare(args: string[], io: Io, interactive: boolean): Promise<Prepared | number> {
  const mode = modeOf(args);
  if (mode !== 'strict' && mode !== 'update' && mode !== 'keep') {
    io.error(mode);
    return 2;
  }
  const l = await load(args[0], io);
  if (!l) return 1;
  const env = await environment(args);
  if (!existsSync(env.dbFile)) {
    io.error(`Aucune base dans ${env.dataDir} : demarrer le PSIM une premiere fois (il cree la base et les comptes), l'arreter, puis relancer.`);
    return 2;
  }
  const file = readAnswersFile(optionValue(args, '--answers'));
  if (file.error) {
    io.error(`Reponses illisibles : ${file.error}`);
    return 1;
  }
  // Adresses de destinataires d'un canal non configure : le destinataire sera laisse de cote, inutile de la demander.
  const channels = channelsOf(env.config);
  const questions = l.loaded.questions.filter((q) => !q.kind.startsWith('address:') || channels[q.kind.slice('address:'.length) as ChannelId]);
  const got = collectAnswers(questions, file.values, io.env);
  if (got.errors.length) {
    for (const e of got.errors) io.error(`  - ${e}`);
    return 1;
  }
  for (const k of got.unused) io.print(`  (reponse « ${k} » sans question correspondante : ignoree)`);
  if (interactive && got.missing.length) {
    const envMissing = got.missing.filter((q) => q.env);
    if (envMissing.length) {
      io.error(`Variable(s) d'environnement absente(s) : ${envMissing.map((q) => q.env).join(', ')}`);
      return 1;
    }
    if (!io.ask) {
      io.error(`Reponses manquantes (pas de terminal pour les demander) : ${got.missing.map((q) => `« ${q.label} »`).join(', ')}. Les fournir avec --answers <fichier.json>.`);
      return 1;
    }
    io.print('Valeurs a fournir (jamais ecrites dans le pack ni au journal ; Entree vide sur une adresse = destinataire laisse de cote) :');
    for (const q of got.missing) {
      for (;;) {
        const v = await io.ask(`  ${q.label} : `, q.secret);
        const problem = checkAnswer(q.kind, v);
        if (!problem) {
          got.answers.set(q.key, q.kind === 'password' ? v : v.trim());
          break;
        }
        io.error(`    ${problem}`);
      }
    }
  }
  return { l, env, mode, answers: got.answers, questions };
}

function header(p: Prepared, io: Io, simulation: boolean): void {
  for (const line of describePack(p.l.pack, p.l.loaded)) io.print(line);
  io.print(`Base : ${p.env.dbFile}${simulation ? '  -  SIMULATION : rien n\'est ecrit' : ''}`);
  io.print(`Existant different du pack : ${p.mode === 'update' ? 'REMPLACE (--update)' : p.mode === 'keep' ? 'conserve (--keep-existing)' : 'conflit, rien n\'est applique (par defaut)'}`);
  io.print('');
}

function simulate(p: Prepared): Report {
  const k = keyFor(p.env, false);
  return simulateOnCopy(p.env.dbFile, (db) =>
    applyPack(db, p.l.pack, {
      dataDir: p.env.dataDir, mode: p.mode, dryRun: true, answers: p.answers, key: k.key, keyIsReal: k.real, plans: p.l.loaded.plans,
      channels: channelsOf(p.env.config), envRecipients: p.env.config.notify.recipients, sha256: p.l.loaded.sha256,
    }),
  );
}

function verdict(report: Report, mode: Mode): string | null {
  if (report.error) return report.error;
  const conflicts = report.items.filter((i) => i.action === 'conflict').length;
  if (conflicts && mode === 'strict') return `${conflicts} conflit(s) avec l'existant : apply refuserait. Choisir --update (valeurs du pack) ou --keep-existing (garder l'existant).`;
  return null;
}

async function cmdPlan(args: string[], io: Io): Promise<number> {
  const p = await prepare(args, io, false);
  if (typeof p === 'number') return p;
  header(p, io, true);
  const report = simulate(p);
  io.print(formatReport(report, false));
  const extra = [...qualificationLines(p.l.q), ...siteNotes(p.l.pack, p.env.config)];
  if (extra.length) io.print(['', 'A SAVOIR', ...extra].join('\n'));
  const unknown = p.questions.filter((q) => !p.answers.has(q.key));
  if (unknown.length) io.print(['', ...questionLines(unknown), '  (simulation faite avec des valeurs fictives ; apply les demandera)'].join('\n'));
  const problem = verdict(report, p.mode);
  io.print('');
  io.print(problem ? `Le pack ne peut pas etre applique tel quel : ${problem}` : `Applicable : npm run pack -- apply ${args[0]}${p.l.q.unqualified.length ? ' --allow-unqualified' : ''}`);
  return problem ? 1 : 0;
}

function recetteLines(packPath: string, id: string, env: NodeJS.ProcessEnv): string[] {
  const script = (env.PSIM_ENV_FILE ?? '').includes('production') ? 'commission:prod' : 'commission';
  const rel = relative(process.cwd(), resolve(packPath)) || '.';
  const shown = /\s/.test(rel) ? `"${rel}"` : rel;
  return [
    'Recette du pack (PSIM redemarre) :',
    `  1. npm run ${script} -- --pack ${shown}                       controles + « le pack est complet »`,
    `  2. npm run ${script} -- watch --pack ${shown} --until-all     declencher chaque detecteur du pack`,
    `  3. npm run ${script} -- sheet --pack ${shown} --out recette-${id}.html   fiche de recette a imprimer et signer (cite le pack et sa version)`,
  ];
}

async function cmdApply(args: string[], io: Io): Promise<number> {
  // Avant toute question : modeles a qualifier, et PSIM en marche.
  const pre = await load(args[0], io);
  if (!pre) return 1;
  if (pre.q.unqualified.length && !args.includes('--allow-unqualified')) {
    for (const line of qualificationLines(pre.q)) io.error(line);
    io.error(`Application refusee : ${pre.q.unqualified.length} equipement(s) de modele a qualifier. Lire le plan (npm run pack -- plan ${args[0]}), puis relancer avec --allow-unqualified si l'essai sur site est prevu.`);
    return 1;
  }
  const preEnv = await environment(args);
  const holder = lockHolder(preEnv.dataDir);
  if (holder !== null) {
    io.error(`Le PSIM tourne sur ce dossier de donnees (PID ${holder}) : l'arreter, appliquer le pack, puis le redemarrer. (Il garde la configuration en memoire : un pack applique pendant qu'il tourne ne serait pas pris en compte.) Le plan, lui, peut se faire PSIM en marche.`);
    return 1;
  }
  const by = optionValue(args, '--by') ?? null;
  if (by !== null && (!by.trim() || by.length > 60 || hasForbiddenChar(by))) {
    io.error('--by : nom de 1 a 60 caracteres, sans caractere de controle');
    return 2;
  }
  const p = await prepare(args, io, true);
  if (typeof p === 'number') return p;
  header(p, io, false);
  io.print('PLAN (simulation sur une copie de la base) :');
  const plan = simulate(p);
  io.print(formatReport(plan, false));
  const extra = [...qualificationLines(p.l.q), ...siteNotes(p.l.pack, p.env.config)];
  if (extra.length) io.print(['', 'A SAVOIR', ...extra].join('\n'));
  const problem = verdict(plan, p.mode);
  if (problem) {
    io.error(`\nApplication refusee : ${problem}`);
    return 1;
  }
  if (!args.includes('--yes')) {
    if (!io.ask) {
      io.error('\nConfirmation requise : relancer avec --yes apres avoir lu le plan ci-dessus.');
      return 1;
    }
    const answer = (await io.ask('\nAppliquer ce plan ? Taper « oui » pour confirmer : ', false)).trim().toLowerCase();
    if (answer !== 'oui') {
      io.print('Abandon : rien n\'a ete modifie.');
      return 1;
    }
  }
  let release: () => void;
  try {
    release = acquireLock(p.env.dataDir);
  } catch (err) {
    io.error((err as Error).message);
    return 1;
  }
  let report: Report;
  try {
    const needsKey = p.l.pack.devices.some((d) => d.source && 'credentials' in d.source && d.source.credentials);
    const k = keyFor(p.env, needsKey);
    const db = openDb(p.env.dbFile);
    try {
      report = applyPack(db, p.l.pack, {
        dataDir: p.env.dataDir, mode: p.mode, dryRun: false, answers: p.answers, key: k.key, keyIsReal: k.real, plans: p.l.loaded.plans,
        channels: channelsOf(p.env.config), envRecipients: p.env.config.notify.recipients, sha256: p.l.loaded.sha256, by,
        unqualified: p.l.q.unqualified.length,
      });
    } finally {
      db.close();
    }
  } finally {
    release();
  }
  io.print('\nRESULTAT :');
  io.print(formatReport(report, true));
  if (!report.committed) return 1;
  io.print(`\nPack applique et inscrit au journal (pack_applique ${p.l.pack.id}@${p.l.pack.version}).`);
  io.print(recetteLines(args[0], p.l.pack.id, io.env).join('\n'));
  if (args.includes('--recette')) {
    io.print('\nRecette (controles) :');
    const { main: commission } = await import('./commission.ts');
    return commission(['check', '--pack', args[0]]);
  }
  return 0;
}

async function cmdExport(args: string[], io: Io): Promise<number> {
  const out = optionValue(args, '--out');
  if (!out) {
    io.error('Usage : npm run pack -- export --out <dossier> [--id mon-site --name "..." --segment autre --level essentiel --version 1.0.0] [--force]');
    return 2;
  }
  const env = await environment(args);
  if (!existsSync(env.dbFile)) {
    io.error(`Aucune base dans ${env.dataDir}`);
    return 2;
  }
  const target = resolve(out);
  if (existsSync(join(target, 'pack.json')) && !args.includes('--force')) {
    io.error(`${join(target, 'pack.json')} existe deja : choisir un autre dossier, ou --force pour le remplacer.`);
    return 1;
  }
  const db = new DatabaseSync(env.dbFile, { readOnly: true });
  let result;
  try {
    const site = (db.prepare('SELECT name FROM site WHERE id = 1').get() as { name: string } | undefined)?.name ?? 'Site';
    const segment = optionValue(args, '--segment') ?? 'autre';
    const level = optionValue(args, '--level') ?? 'essentiel';
    if (!(SEGMENTS as readonly string[]).includes(segment) || !(LEVELS as readonly string[]).includes(level)) {
      io.error(`--segment (${SEGMENTS.join(', ')}) / --level (${LEVELS.join(', ')}) invalide`);
      return 2;
    }
    result = exportPack(db, env.dataDir, {
      id: optionValue(args, '--id') ?? 'export-site',
      name: optionValue(args, '--name') ?? `Installation ${site}`,
      segment: segment as Pack['segment'],
      level: level as Pack['level'],
      version: optionValue(args, '--version') ?? '1.0.0',
      description: optionValue(args, '--description'),
      gatewayAccounts: env.config.mqttGateways.map((g) => ({ user: g.user, detectors: g.detectors })),
    });
  } finally {
    db.close();
  }
  if (!result.pack) {
    for (const e of result.errors) io.error(`  - ${e}`);
    return 1;
  }
  const files = [...result.files, { path: 'pack.json', body: Buffer.from(`${JSON.stringify(result.pack, null, 2)}\n`, 'utf8') }];
  for (const f of files) {
    const dest = join(target, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    const temp = `${dest}.tmp-${process.pid}`;
    writeFileSync(temp, f.body);
    renameSync(temp, dest);
  }
  io.print(`Pack exporte dans ${target} (${files.length} fichier(s)), sans aucun secret : identifiants des cameras et adresses des destinataires deviennent des questions.`);
  for (const n of result.notes) io.print(`  ! ${n}`);
  io.print(`Verifier : npm run pack -- check ${out}`);
  return 0;
}

// ---------------------------------------------------------------- terminal

function readHidden(prompt: string): Promise<string> {
  return new Promise((done) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return done(value);
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\nAnnule : rien n\'a ete modifie.\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

const USAGE = 'Usage : npm run pack -- check <pack> | plan <pack> | apply <pack> [--yes] [--answers f.json] [--update|--keep-existing] [--allow-unqualified] [--by "Nom"] | export --out <dossier>';

export async function main(args: string[], partial: Partial<Io> = {}): Promise<number> {
  const io: Io = {
    print: (l) => console.log(l),
    error: (l) => console.error(l),
    ask: process.stdin.isTTY ? (prompt, hidden) => (hidden ? readHidden(prompt) : readLine(prompt)) : null,
    env: process.env,
    qualificationDir: join(ROOT, 'qualification'),
    ...partial,
  };
  const [command, ...rest] = args;
  switch (command) {
    case 'check':
      return cmdCheck(rest, io);
    case 'plan':
      return cmdPlan(rest, io);
    case 'apply':
      return cmdApply(rest, io);
    case 'export':
      return cmdExport(rest, io);
    default:
      io.error(USAGE);
      return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main(process.argv.slice(2));
}
