/**
 * Ecran « Regles » (web/rules.js, web/rules.css) : l'interface est testee comme le reste du web statique, par lecture des
 * fichiers servis (le code d'ecran touche au DOM, il n'est pas execute ici) et par execution de ses fonctions PURES
 * (rules.js n'importe rien : aucune page n'est necessaire), comparees a celles du serveur (server/rules.ts).
 *
 * Garde-fous verifies : route reservee aux administrateurs, menu et page presents, feuille de style chargee, aucune
 * mise en forme en ligne ni HTML construit a partir de donnees (CSP stricte), memes bornes et meme phrase que le serveur,
 * toute regle construite par l'ecran est acceptee par la verification du serveur.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { describeRule, validateSpec } from '../server/rules.ts';
import type { RuleSpec, Who } from '../server/rules.ts';

const WEB = join(import.meta.dirname, '..', 'web');
// Fins de ligne normalisees : le depot est extrait en CRLF sous Windows (core.autocrlf), les motifs ci-dessous sont ecrits en LF.
const read = (file: string) => readFileSync(join(WEB, file), 'utf8').replace(/\r\n/g, '\n');
const SERVER_RULES = readFileSync(join(import.meta.dirname, '..', 'server', 'rules.ts'), 'utf8');

interface Win {
  days: number[];
  from: string;
  to: string;
}
interface Form {
  name: string;
  who: Who;
  whereMode: 'cameras' | 'zones';
  cameras: string[];
  zones: string[];
  whenMode: 'always' | 'windows' | 'armed';
  windows: Win[];
  triggerMode: 'appears' | 'stays';
  minutes: string;
  severity: 'warning' | 'critical';
  cooldown: string;
  enabled: boolean;
}
interface Problem {
  key: string;
  message: string;
}
interface Hit {
  at: number;
  endedAt: number | null;
  cameraId: string;
}
interface Rules {
  MAX_WINDOWS: number;
  MAX_MINUTES: number;
  MAX_NAME: number;
  MAX_PLACES: number;
  TRIAL_DAYS: number[];
  ARMED_NOTE: string;
  defaultForm: () => Form;
  formFromRule: (rule: { name: string; enabled: boolean; spec: RuleSpec; needsReview?: boolean }) => Form;
  buildSpec: (form: Form) => RuleSpec;
  formKey: (form: Form) => string;
  formProblems: (form: Form, ctx?: { cameraIds: Set<string>; zones: Set<string> } | null) => Problem[];
  windowProblem: (w: Win) => string | null;
  nightNote: (w: Win) => string;
  describeDays: (days: number[]) => string;
  describeSpec: (spec: RuleSpec, cameraName?: (id: string) => string) => string;
  liveSentence: (form: Form, cameraName?: (id: string) => string) => string | null;
  minutesText: (m: number) => string;
  placeItems: (cameras: { id: string; name: string; zone: string }[], form: Form) => { id: string; label: string; note: string; missing: boolean }[];
  scopeCameras: (spec: RuleSpec, cameras: { id: string; zone: string }[]) => string[];
  clockText: (ts: number) => string;
  durationText: (ms: number) => string;
  describeTrigger: (t: Hit, cameraName?: (id: string) => string) => { day: string; time: string; until: string; duration: string; ongoing: boolean; camera: string };
  periodText: (days: number) => string;
  trialButtonText: (days: number) => string;
  trialHeadline: (count: number, days: number) => string;
  MAX_FACE_ID: number;
  MAX_FACE_NAME: number;
  MAX_SOURCE_TEXT: number;
  MAX_ASSIST_TURN: number;
  MAX_ASSIST_HISTORY: number;
  RELIABILITY_NOTE: string;
  CAUTION_NOTE: string;
  NO_LIST_NOTE: string;
  STAYS_FACE_NOTE: string;
  isFaceWho: (who: unknown) => boolean;
  cloneWho: (who: unknown) => Who;
  buildWho: (who: unknown) => Who;
  triggerForWho: (who: Who, mode: 'appears' | 'stays') => { triggerMode: 'appears' | 'stays'; changed: boolean };
  severityForWho: (a: { from: string; to: string; severity: 'warning' | 'critical'; touched: boolean }) => { severity: 'warning' | 'critical'; changed: boolean };
  restoreForAnyone: (a: { triggerMode: 'appears' | 'stays'; severity: 'warning' | 'critical'; autoTrigger: boolean; autoSeverity: 'warning' | 'critical' | null; touched: boolean }) => { triggerMode: 'appears' | 'stays'; severity: 'warning' | 'critical' };
  severityTexts: (face: boolean) => { warning: string; critical: string };
  appearsTexts: (who: Who) => { label: string; desc: string };
  REVIEW_NOTE: string;
  REVIEW_PERSON_NOTE: string;
  UNSPECIFIED_CAMERA: string;
  isDeviceWho: (who: unknown) => boolean;
  whoToReview: (who: unknown) => Who;
  reviewNote: (who: unknown) => string;
  ruleState: (rule: { enabled?: boolean; needsReview?: boolean }) => { running: boolean; review: boolean; word: string; title: string };
  serverProblem: (message: unknown) => { key: 'who' | 'where' | null; box: string; text: string };
  personCameraChoices: (cameras: { id: string; name: string; zone: string }[], current: string) => { id: string; label: string; missing: boolean }[];
  listMatches: (list: unknown, who: unknown) => boolean;
  listChoices: (lists: FaceList[], whos?: (Who | null)[], cameraName?: (id: string) => string) => ListItem[];
  selectedListIndex: (items: ListItem[], who: Who) => number;
  facesView: (faces: { status: string; lists?: FaceList[]; notes?: string[] }, who: Who, stored?: Who | null, cameraName?: (id: string) => string) => { kind: 'loading' | 'error' | 'empty' | 'select'; items: ListItem[]; notes: string[] };
  formFromProposal: (proposal: { name: string; spec: RuleSpec; summary?: string }, ctx?: { cameraIds?: Set<string>; zones?: Set<string>; lists?: { id: string; name?: string; cameraId?: string; deviceCameraIds?: string[] }[] | null }) => { form: Form; issues: string[] };
  historyForAssist: (turns: Turn[]) => Turn[];
  sourceTextOf: (turns: Turn[]) => string;
  nextAssistTurns: (turns: Turn[], sent: string, result: unknown) => { turns: Turn[]; sourceText: string };
}
interface FaceList {
  id: string;
  name: string;
  cameraId: string;
  cameraName: string;
  /** Cameras du PSIM lues par le meme appareil (la representante comprise) ; absent dans une ancienne reponse. */
  deviceCameraIds?: string[];
}
/** Entree du menu des listes : le couple (camera, liste), son etiquette et sa remarque. */
interface ListItem {
  key: string;
  id: string;
  cameraId: string;
  deviceCameraIds: string[];
  cameraName: string;
  name: string;
  label: string;
  note: string;
  missing: boolean;
}
interface Turn {
  role: 'user' | 'assistant';
  text: string;
}
const rules = (await import(pathToFileURL(join(WEB, 'rules.js')).href)) as Rules;

const CAMERAS = [
  { id: 'D05', name: 'Avant cour', zone: 'Cour' },
  { id: 'D08', name: 'Escalier', zone: 'Intérieur' },
  { id: 'D01', name: 'Portail', zone: 'Cour' },
];
const CTX = { cameraIds: new Set(CAMERAS.map((c) => c.id)), zones: new Set(['Cour', 'Intérieur']) };
const nameOf = (id: string) => CAMERAS.find((c) => c.id === id)?.name ?? id;

/** Un formulaire complet, modifiable. */
function form(over: Partial<Form> = {}): Form {
  return { ...rules.defaultForm(), name: 'Cour de nuit', cameras: ['D05'], ...over };
}
const win = (days: number[], from: string, to: string): Win => ({ days, from, to });

describe('ecran « Regles » : page et navigation', () => {
  const html = read('index.html');

  it("le menu d'administration porte l'entree « Regles » apres « Personnes prevenues », la page existe, sa feuille de style est chargee", () => {
    const admin = /<div id="nav-admin"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
    assert.match(admin, /href="#\/regles" data-view="regles"[\s\S]*?Règles/, "entree dans le groupe Administration (masque aux operateurs)");
    assert.ok(admin.indexOf('data-view="notifications"') < admin.indexOf('data-view="regles"') && admin.indexOf('data-view="regles"') < admin.indexOf('data-view="utilisateurs"'));
    assert.match(html, /<section class="view view-regles[^"]*" id="view-regles"[^>]*hidden>/);
    assert.match(html, /<link rel="stylesheet" href="rules\.css">/);
    for (const id of ['rules-intro', 'rules-denied', 'rules-loading', 'rules-error', 'rules-form-slot', 'rules-card', 'rules-title', 'rules-count', 'rules-new', 'rules-empty', 'rules-empty-new', 'rules-list']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.ok(!/<nav class="tabbar"[\s\S]*#\/regles/.test(html), "pas d'onglet rapide : reglage d'administration");
  });

  it("l'icone du menu existe dans le sprite", () => {
    const icon = /href="#\/regles"[^>]*><svg[^>]*><use href="icons\.svg#([a-z-]+)"/.exec(html)?.[1];
    assert.ok(icon, 'icone du menu');
    assert.match(read('icons.svg'), new RegExp(`<symbol id="${icon}"`));
  });

  it('app.js : la route est reservee aux administrateurs et branchee a rules.js (arret du minuteur a la sortie)', () => {
    const app = read('app.js');
    assert.match(app, /regles: \{[^}]*title: 'Règles'[^}]*admin: true[^}]*\}/, 'route admin : un operateur est ramene a Surveillance par le routeur');
    assert.match(app, /import \{ createRulesView \} from '\.\/rules\.js';/);
    assert.match(app, /view === 'regles'\) \{\s*rulesView\.show\(\)/);
    assert.match(app, /view === 'regles'\) \{\s*rulesView\.hide\(\)/, "le releve periodique s'arrete quand on quitte l'ecran");
    assert.match(app, /rulesView\.reset\(\)/, 'rien du compte precedent ne reste apres une deconnexion');
    assert.match(app, /getDevices: \(\) => devicesOf\('camera'\)/, "les cameras viennent de l'etat deja en memoire");
  });

  it('textes pour l utilisateur presents (français courant)', () => {
    const all = `${html}\n${read('rules.js')}`;
    for (const text of [
      'Aucune règle pour l\'instant',
      'Créer une règle',
      'Nouvelle règle',
      'Qui',
      'Où',
      'Quand',
      'Alors',
      'N’importe qui',
      'Des caméras',
      'Des zones',
      'À toute heure',
      'Certaines heures',
      'Quand la zone est armée',
      'Quelqu’un apparaît',
      'Quelqu’un reste plus de',
      'Avertissement',
      'Alerte critique',
      'Repos, en minutes',
      'Ce que fera cette règle',
      'Essayer avant d’enregistrer',
      'L’essai ne modifie rien',
      'Essai en cours',
      'Enregistrer la règle',
      'Modifier',
      'Supprimer',
      'Inactive',
      'Active',
      'Oui, supprimer la règle',
      'ne peut pas être supprimée',
      'Désactiver la règle',
      'Écran réservé aux administrateurs',
      'Modifications non enregistrées',
      'Abandonner la saisie',
      'Ajouter une plage',
      'Une personne de la liste…',
      'Un visage inconnu',
      'Décrivez la règle en une phrase',
      'Proposer une règle',
      'Proposition de l’assistant : relisez chaque case, puis enregistrez.',
      'Aucune liste de visages : ajoutez une caméra à reconnaissance faciale et créez-y une base',
      'recommandé tant que l’essai de fiabilité n’est pas terminé',
      'une reconnaissance peut se tromper : un humain doit vérifier avant d’agir',
      'Les listes de visages n’ont pas pu être lues',
      'Réessayer',
      'Répondre',
      'À revoir',
      'Cette règle doit être réenregistrée : choisissez à nouveau la liste.',
      'Caméra qui connaît cette personne',
    ]) {
      assert.ok(all.includes(text), `texte absent : ${text}`);
    }
    assert.ok(read('rules.js').includes('Aucune caméra n’est installée'));
  });

  it("l'essai propose 1, 3, 7, 14 et 30 jours (7 par defaut) : dans la plage acceptee par le serveur (1 a 30)", () => {
    assert.deepEqual(rules.TRIAL_DAYS, [1, 3, 7, 14, 30]);
    assert.equal(rules.trialButtonText(7), 'Essayer sur les 7 derniers jours');
    assert.equal(rules.trialButtonText(1), 'Essayer sur les dernières 24 heures');
    assert.match(read('rules.js'), /DEFAULT_TRIAL_DAYS = 7/);
  });
});

describe('ecran « Regles » : politique de securite du contenu et donnees', () => {
  const code = read('rules.js');
  const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it("aucun style en ligne, aucun HTML construit, aucun stockage, aucun import (fonctions pures sans page)", () => {
    for (const forbidden of [/\bstyle\s*=/, /\bstyle:/, /\.style\b/, /setAttribute\(\s*['"]style/, /cssText/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/, /localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /console\./, /<script/i]) {
      assert.ok(!forbidden.test(withoutComments), `interdit dans rules.js : ${forbidden}`);
    }
    assert.ok(!/^import /m.test(code), "rules.js n'importe rien (core.js touche au DOM des son chargement)");
  });

  it("les noms de regles, de cameras et de zones n'entrent dans la page que par du texte (h / textContent)", () => {
    // Aucun gabarit HTML (balise ouvrante dans une chaine) : tout element est cree par h().
    assert.ok(!/[`'"]<[a-z]+[ >]/.test(withoutComments), 'balise HTML dans une chaine');
  });

  it('rules.css : jetons de base.css seulement (aucune couleur en dur), cibles tactiles, mouvement reduit respecte', () => {
    const css = read('rules.css').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'couleur en dur');
    assert.ok(!/\brgba?\(/.test(css), 'couleur en dur');
    assert.ok(!/@import|url\(/.test(css));
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.match(css, /var\(--control-h\)/);
    assert.match(css, /:focus-visible/);
    assert.match(css, /@container/);
    assert.match(css, /@media \(max-width: 760px\)/);
  });

  it("appelle les routes du contrat d'API et seulement elles", () => {
    const paths = new Set([...withoutComments.matchAll(/['`](\/api\/[^'`$]*)/g)].map((m) => m[1]));
    assert.deepEqual([...paths].sort(), ['/api/faces/lists', '/api/presence', '/api/rules', '/api/rules/', '/api/rules/assist', '/api/rules/simulate'].sort());
    assert.match(withoutComments, /api\('\/api\/faces\/lists'\)/, 'lecture des listes : GET');
    assert.match(withoutComments, /api\('\/api\/rules\/assist'\)/, "l'assistant est-il configure : GET");
    assert.match(withoutComments, /api\('\/api\/rules\/assist', \{ method: 'POST', body \}\)/, "la proposition : POST { text, history? }");
    assert.match(withoutComments, /method: 'DELETE'/);
    assert.match(withoutComments, /method: 'PUT', body: \{ enabled: on \}/);
    assert.match(withoutComments, /method: 'POST', body: \{ spec: buildSpec\(state\), days \}/);
  });

  it("le refus du serveur de supprimer une regle qui a deja declenche des incidents est reconnu (409) et propose « Desactiver »", () => {
    const message = /new PsimError\(409, '([^']+)'\)/.exec(SERVER_RULES)?.[1] ?? '';
    assert.match(message, /desactiver plutot que la supprimer/);
    const pattern = /d\[ée\]sactiv\/i/.exec(code);
    assert.ok(pattern, 'detection du refus par son message');
    assert.match(message, /d[ée]sactiv/i);
    assert.match(code, /function cannotDelete\(\)/);
  });
});

describe('ecran « Regles » : la regle construite est acceptee par le serveur, avec la meme phrase', () => {
  const wheres: Partial<Form>[] = [{ whereMode: 'cameras', cameras: ['D05'] }, { whereMode: 'cameras', cameras: ['D05', 'D08'] }, { whereMode: 'cameras', cameras: ['D05', 'D08', 'D01'] }, { whereMode: 'zones', zones: ['Cour'] }, { whereMode: 'zones', zones: ['Cour', 'Intérieur'] }];
  const whens: Partial<Form>[] = [
    { whenMode: 'always' },
    { whenMode: 'armed' },
    { whenMode: 'windows', windows: [win([1, 2, 3, 4, 5], '19:00', '07:00')] },
    { whenMode: 'windows', windows: [win([6, 0], '08:00', '12:30'), win([1, 3], '22:00', '23:59')] },
  ];
  const triggers: Partial<Form>[] = [{ triggerMode: 'appears' }, { triggerMode: 'stays', minutes: '5' }, { triggerMode: 'stays', minutes: '90' }, { triggerMode: 'stays', minutes: '1440' }];
  const thens: Partial<Form>[] = [{ severity: 'warning' }, { severity: 'critical' }];
  const cooldowns = ['0', '10', '60', '1440'];

  it('chaque combinaison Qui / Ou / Quand / Si / Alors / Repos : validateSpec (serveur) accepte et normalise a l’identique, describeRule dit la meme phrase', () => {
    let n = 0;
    for (const w of wheres) for (const q of whens) for (const t of triggers) for (const a of thens) for (const c of cooldowns) {
      const f = form({ ...w, ...q, ...t, ...a, cooldown: c });
      assert.deepEqual(rules.formProblems(f, CTX), [], JSON.stringify(f));
      const spec = rules.buildSpec(f);
      const checked = validateSpec(spec, CTX);
      assert.deepEqual(checked, spec, 'le serveur ne change rien a ce que l’ecran construit');
      assert.equal(rules.describeSpec(spec, nameOf), describeRule(checked, { cameraName: nameOf }), 'meme phrase que le serveur');
      assert.equal(rules.liveSentence(f, nameOf), describeRule(checked, { cameraName: nameOf }));
      n++;
    }
    assert.equal(n, 5 * 4 * 4 * 2 * 4);
  });

  it('forme exacte de la regle selon les cases', () => {
    assert.deepEqual(rules.buildSpec(form({ whereMode: 'zones', zones: ['Cour'], cameras: ['D05'], whenMode: 'armed', triggerMode: 'stays', minutes: '15', severity: 'critical', cooldown: '0' })), {
      who: { type: 'anyone' },
      where: { zones: ['Cour'] },
      when: { type: 'armed' },
      trigger: { type: 'stays', minutes: 15 },
      then: { severity: 'critical' },
      cooldownMinutes: 0,
    });
    // « Ou » : seule la case active compte (les deux listes sont gardees quand on bascule, une seule part au serveur).
    assert.deepEqual(rules.buildSpec(form({ whereMode: 'cameras', cameras: ['D05'], zones: ['Cour'] })).where, { cameras: ['D05'] });
    // « Si » : « apparait » ne porte pas de duree, meme si une duree est saisie.
    assert.deepEqual(rules.buildSpec(form({ triggerMode: 'appears', minutes: '30' })).trigger, { type: 'appears' });
    // « Quand » : les plages ne partent que pour « Certaines heures » ; jours triés sans doublon.
    assert.deepEqual(rules.buildSpec(form({ whenMode: 'always', windows: [win([1], '10:00', '11:00')] })).when, { type: 'always' });
    assert.deepEqual(rules.buildSpec(form({ whenMode: 'windows', windows: [win([5, 1, 5, 0], '10:00', '11:00')] })).when, { type: 'windows', windows: [{ days: [0, 1, 5], from: '10:00', to: '11:00' }] });
    // Les listes du formulaire ne sont pas partagees avec la regle construite.
    const f = form({ whenMode: 'windows', windows: [win([1], '10:00', '11:00')] });
    const spec = rules.buildSpec(f);
    (spec.where as { cameras: string[] }).cameras.push('X');
    assert.deepEqual(f.cameras, ['D05']);
  });

  it('la phrase reprend celle du serveur : jours, plages de nuit, durees', () => {
    const spec: RuleSpec = {
      who: { type: 'anyone' },
      where: { cameras: ['D05', 'D08', 'D01'] },
      when: { type: 'windows', windows: [{ days: [1, 2, 3, 4, 5], from: '19:00', to: '07:00' }, { days: [6, 0], from: '08:00', to: '12:00' }] },
      trigger: { type: 'stays', minutes: 90 },
      then: { severity: 'critical' },
      cooldownMinutes: 10,
    };
    const text = rules.describeSpec(spec, nameOf);
    assert.equal(text, describeRule(spec, { cameraName: nameOf }));
    assert.match(text, /^Prévenir \(alerte critique\) si quelqu'un reste au moins 1 h 30 devant les caméras « Avant cour », « Escalier » ou « Portail », uniquement de 19:00 à 07:00 le lendemain, du lundi au vendredi ou de 08:00 à 12:00, le samedi et le dimanche ; ensuite, attendre 10 min avant de signaler à nouveau\.$/);
    for (const days of [[0], [1, 2, 3], [1, 2, 4], [0, 1, 2, 6], [0, 1, 2, 3, 4, 5, 6], [5, 6, 0], [6, 0], [3]]) {
      const s: RuleSpec = { ...spec, when: { type: 'windows', windows: [{ days, from: '08:00', to: '09:00' }] } };
      assert.equal(rules.describeSpec(s, nameOf), describeRule(s, { cameraName: nameOf }), JSON.stringify(days));
    }
    for (const m of [1, 59, 60, 61, 90, 120, 1440]) {
      assert.equal(rules.minutesText(m), describeRule({ ...spec, trigger: { type: 'stays', minutes: m } }, { cameraName: nameOf }).match(/au moins (.+?) devant/)![1]);
    }
  });

  it("une regle enregistree rouvre le meme formulaire (Modifier -> Enregistrer ne change rien)", () => {
    for (const w of wheres) for (const q of whens) for (const t of triggers) {
      const f = form({ ...w, ...q, ...t, severity: 'critical', cooldown: '25' });
      const spec = rules.buildSpec(f);
      const back = rules.formFromRule({ name: f.name, enabled: true, spec });
      assert.deepEqual(rules.buildSpec(back), spec);
      assert.equal(rules.formKey(back), rules.formKey({ ...f, enabled: true }));
    }
  });

  it("formKey sert a detecter un brouillon : change avec la saisie utile, pas avec une case masquee ni les espaces autour du nom", () => {
    const base = form();
    assert.equal(rules.formKey(base), rules.formKey(form({ name: '  Cour de nuit ' })));
    assert.equal(rules.formKey(base), rules.formKey(form({ minutes: '99' })), '« reste plus de » masque tant que « apparait » est choisi');
    assert.equal(rules.formKey(base), rules.formKey(form({ zones: ['Cour'] })), 'les zones sont masquees tant que « Des cameras » est choisi');
    assert.notEqual(rules.formKey(base), rules.formKey(form({ cameras: ['D05', 'D08'] })));
    assert.notEqual(rules.formKey(base), rules.formKey(form({ severity: 'critical' })));
    assert.notEqual(rules.formKey(base), rules.formKey(form({ cooldown: '11' })));
    assert.notEqual(rules.formKey(base), rules.formKey(form({ name: 'Autre' })));
  });
});

describe('ecran « Regles » : verification avant envoi, memes bornes que le serveur', () => {
  /** Le serveur accepte-t-il cette regle ? (le nom est verifie ailleurs que dans validateSpec). */
  const serverAccepts = (f: Form) => {
    try {
      validateSpec(rules.buildSpec(f), CTX);
      return true;
    } catch {
      return false;
    }
  };
  const clientAccepts = (f: Form) => rules.formProblems(f, CTX).filter((p) => p.key !== 'name').length === 0;
  const keys = (f: Form) => rules.formProblems(f, CTX).map((p) => p.key);

  it('duree « reste plus de » : entier de 1 a 1440 minutes', () => {
    for (const m of ['0', '1', '2', '59', '1440', '1441', '-1', '5.5', '', ' ', 'abc', '1e2', '00005', '99999999']) {
      const f = form({ triggerMode: 'stays', minutes: m });
      assert.equal(clientAccepts(f), serverAccepts(f), `minutes « ${m} »`);
    }
    assert.deepEqual(keys(form({ triggerMode: 'stays', minutes: '0' })), ['minutes']);
    assert.deepEqual(keys(form({ triggerMode: 'stays', minutes: '1441' })), ['minutes']);
    assert.deepEqual(keys(form({ triggerMode: 'stays', minutes: '1' })), []);
    assert.deepEqual(keys(form({ triggerMode: 'appears', minutes: 'n’importe quoi' })), [], 'sans objet pour « apparait »');
    assert.match(rules.formProblems(form({ triggerMode: 'stays', minutes: '' }))[0].message, /entre 1 et 1440/);
  });

  it('repos : entier de 0 a 1440 minutes', () => {
    for (const c of ['0', '1', '10', '1440', '1441', '-1', '2.5', '', 'x']) {
      const f = form({ cooldown: c });
      assert.equal(clientAccepts(f), serverAccepts(f), `repos « ${c} »`);
    }
    assert.deepEqual(keys(form({ cooldown: '-1' })), ['cooldown']);
    assert.deepEqual(keys(form({ cooldown: '0' })), []);
    assert.match(rules.formProblems(form({ cooldown: '' }))[0].message, /entre 0 et 1440/);
  });

  it('nom : requis, 80 caracteres au plus', () => {
    assert.deepEqual(keys(form({ name: '' })), ['name']);
    assert.deepEqual(keys(form({ name: '   ' })), ['name']);
    assert.deepEqual(keys(form({ name: 'x'.repeat(rules.MAX_NAME) })), []);
    assert.deepEqual(keys(form({ name: 'x'.repeat(rules.MAX_NAME + 1) })), ['name']);
    assert.match(SERVER_RULES, new RegExp(`const MAX_NAME = ${rules.MAX_NAME};`));
  });

  it('ou : au moins une camera (ou une zone), 50 au plus, un choix disparu est refuse', () => {
    assert.deepEqual(keys(form({ cameras: [] })), ['where']);
    assert.match(rules.formProblems(form({ cameras: [] }))[0].message, /au moins une caméra/);
    assert.match(rules.formProblems(form({ whereMode: 'zones', zones: [] }))[0].message, /au moins une zone/);
    assert.deepEqual(keys(form({ whereMode: 'zones', zones: [], cameras: ['D05'] })), ['where'], 'seule la case choisie compte');
    const many = (n: number) => Array.from({ length: n }, (_, i) => `C${i}`);
    assert.equal(rules.formProblems(form({ cameras: many(rules.MAX_PLACES) })).length, 0);
    assert.deepEqual(keys(form({ cameras: many(rules.MAX_PLACES + 1) })), ['where']);
    assert.match(SERVER_RULES, new RegExp(`const MAX_LIST = ${rules.MAX_PLACES};`));
    assert.deepEqual(keys(form({ cameras: ['D05', 'ZZ'] })), ['where']);
    assert.match(rules.formProblems(form({ cameras: ['ZZ'] }), CTX)[0].message, /introuvable : « ZZ »/);
    assert.deepEqual(keys(form({ whereMode: 'zones', zones: ['Cour', 'Cave'] })), ['where']);
  });

  it('quand : « Certaines heures » demande 1 a 14 plages, jours + heures valides, debut different de la fin', () => {
    const f = (windows: Win[]) => form({ whenMode: 'windows', windows });
    assert.deepEqual(keys(f([])), ['windows']);
    assert.equal(rules.MAX_WINDOWS, 14);
    assert.match(SERVER_ARMING(), /MAX_WINDOWS = 14/);
    const ok = (n: number) => Array.from({ length: n }, (_, i) => win([i % 7], '08:00', '09:00'));
    assert.deepEqual(keys(f(ok(14))), []);
    assert.deepEqual(keys(f(ok(15))), ['windows']);
    for (const w of [win([], '08:00', '09:00'), win([1], '', '09:00'), win([1], '08:00', ''), win([1], '8:00', '09:00'), win([1], '24:00', '09:00'), win([1], '08:60', '09:00'), win([1], '08:00', '08:00'), win([1], '00:00', '00:00')]) {
      const frm = f([w]);
      assert.deepEqual(keys(frm), ['window:0'], JSON.stringify(w));
      assert.equal(clientAccepts(frm), serverAccepts(frm), JSON.stringify(w));
    }
    for (const w of [win([1], '08:00', '09:00'), win([0, 6], '23:59', '00:00'), win([1, 2], '00:00', '23:59'), win([3], '22:00', '06:00')]) {
      const frm = f([w]);
      assert.deepEqual(keys(frm), [], JSON.stringify(w));
      assert.equal(serverAccepts(frm), true);
    }
    assert.deepEqual(keys(f([win([1], '08:00', '09:00'), win([], '08:00', '09:00')])), ['window:1']);
    assert.match(rules.formProblems(f([win([1], '08:00', '09:00'), win([], '08:00', '09:00')]))[0].message, /^Plage 2 : choisissez au moins un jour\.$/);
    assert.equal(rules.windowProblem(win([1], '08:00', '08:00')), 'Le début et la fin sont identiques : choisissez deux heures différentes.');
  });

  it('les problemes sont donnes dans l’ordre de l’ecran (le premier recoit le focus)', () => {
    const bad = form({ name: '', cameras: [], whenMode: 'windows', windows: [], triggerMode: 'stays', minutes: '0', cooldown: 'x' });
    assert.deepEqual(keys(bad), ['name', 'where', 'windows', 'minutes', 'cooldown']);
    assert.equal(rules.liveSentence(bad, nameOf), null, 'pas de phrase tant que les cases ne sont pas completes');
    assert.equal(rules.liveSentence(form({ name: '' }), nameOf) !== null, true, 'le nom n’entre pas dans la phrase');
  });

  it('plage qui passe minuit : expliquee en mots, jours = jours de debut', () => {
    assert.equal(rules.nightNote(win([1], '19:00', '07:00')), 'Plage de nuit : elle commence les jours choisis à 19:00 et se termine le lendemain à 07:00.');
    assert.equal(rules.nightNote(win([1], '08:00', '12:00')), '');
    assert.equal(rules.nightNote(win([1], '22:00', '00:00')), '', 'jusqu’a minuit : meme jour');
    assert.equal(rules.nightNote(win([], '19:00', '07:00')), '', 'plage incomplete : pas de note');
    const text = rules.describeSpec(rules.buildSpec(form({ whenMode: 'windows', windows: [win([5], '22:00', '06:00')] })), nameOf);
    assert.match(text, /uniquement de 22:00 à 06:00 le lendemain, le vendredi ;/);
  });
});

function SERVER_ARMING() {
  return readFileSync(join(import.meta.dirname, '..', 'server', 'arming.ts'), 'utf8');
}

describe('ecran « Regles » : choix des cameras et zones', () => {
  it('cameras : nom et zone ; zones : nombre de cameras, triees ; un choix disparu reste visible pour etre decoche', () => {
    assert.deepEqual(rules.placeItems(CAMERAS, form()).map((i) => [i.id, i.label, i.note, i.missing]), [
      ['D05', 'Avant cour', 'Cour', false],
      ['D08', 'Escalier', 'Intérieur', false],
      ['D01', 'Portail', 'Cour', false],
    ]);
    assert.deepEqual(rules.placeItems(CAMERAS, form({ whereMode: 'zones' })).map((i) => [i.id, i.note]), [['Cour', '2 caméras'], ['Intérieur', '1 caméra']]);
    const gone = rules.placeItems(CAMERAS, form({ cameras: ['D05', 'X9'] }));
    assert.deepEqual(gone.at(-1), { id: 'X9', label: 'X9', note: 'Caméra introuvable', missing: true });
    assert.equal(rules.placeItems([], form({ whereMode: 'zones', zones: ['Cave'] }))[0].note, 'Zone introuvable');
    assert.deepEqual(rules.placeItems([{ id: 'C1', name: '', zone: '' }], form({ cameras: [] })).map((i) => i.label), ['C1'], 'sans nom : l’identifiant');
    assert.deepEqual(rules.placeItems([{ id: 'C1', name: 'A', zone: '' }], form({ whereMode: 'zones' })), [], 'une camera sans zone n’apparait pas dans les zones');
  });

  it('les cameras que regarde une regle : par camera, ou par zone', () => {
    const base = rules.buildSpec(form());
    assert.deepEqual(rules.scopeCameras(base, CAMERAS), ['D05']);
    assert.deepEqual(rules.scopeCameras(rules.buildSpec(form({ whereMode: 'zones', zones: ['Cour'] })), CAMERAS), ['D05', 'D01']);
  });
});

describe('ecran « Regles » : resultat de l’essai sur le passe', () => {
  const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime(); // heure locale : indépendant du fuseau

  it('un declenchement en mots : jour, heure, « jusqu’a 22:41 », duree, camera', () => {
    const t = rules.describeTrigger({ at: at(12, 22, 10), endedAt: at(12, 22, 41), cameraId: 'D05' }, nameOf);
    assert.deepEqual(t, { day: 'lundi 12 octobre', time: '22:10', until: "jusqu'à 22:41", duration: '31 min', ongoing: false, camera: 'Avant cour' });
  });

  it('fin le lendemain, plus tard, ou toujours en cours', () => {
    assert.equal(rules.describeTrigger({ at: at(12, 23, 50), endedAt: at(13, 0, 5), cameraId: 'D05' }, nameOf).until, "jusqu'à 00:05 le lendemain");
    assert.equal(rules.describeTrigger({ at: at(12, 23, 50), endedAt: at(15, 6, 0), cameraId: 'D05' }, nameOf).until, "jusqu'au 15 octobre à 06:00");
    const live = rules.describeTrigger({ at: at(12, 22, 10), endedAt: null, cameraId: 'D08' }, nameOf);
    assert.equal(live.until, 'toujours en cours');
    assert.equal(live.ongoing, true);
    assert.equal(live.duration, '');
    assert.equal(live.camera, 'Escalier');
    assert.equal(rules.describeTrigger({ at: at(12, 22, 10), endedAt: at(12, 22, 10), cameraId: 'D05' }).duration, "moins d'une minute");
    assert.equal(rules.describeTrigger({ at: at(12, 8, 0), cameraId: 'ZZ' } as Hit).camera, 'ZZ', 'camera inconnue : son identifiant');
  });

  it('durees et heures', () => {
    assert.equal(rules.durationText(0), "moins d'une minute");
    assert.equal(rules.durationText(29_000), "moins d'une minute");
    assert.equal(rules.durationText(60_000), '1 min');
    assert.equal(rules.durationText(125 * 60_000), '2 h 05');
    assert.equal(rules.durationText(120 * 60_000), '2 h');
    assert.equal(rules.clockText(at(1, 5, 7)), '05:07');
  });

  it('phrases du resultat', () => {
    assert.equal(rules.trialHeadline(0, 7), 'Elle ne se serait jamais déclenchée sur cette période.');
    assert.equal(rules.trialHeadline(3, 7), 'Cette règle aurait déclenché 3 fois sur les 7 derniers jours.');
    assert.equal(rules.trialHeadline(1, 14), 'Cette règle aurait déclenché 1 fois sur les 14 derniers jours.');
    assert.equal(rules.trialHeadline(2, 1), 'Cette règle aurait déclenché 2 fois sur les dernières 24 heures.');
    assert.equal(rules.periodText(30), 'sur les 30 derniers jours');
    assert.equal(rules.ARMED_NOTE, "L'armement des zones d'autrefois n'est pas conservé : l'essai utilise l'armement d'aujourd'hui pour toute la période.");
    // La reserve est affichee quand le serveur le demande (armedNote) et seulement alors.
    assert.match(read('rules.js'), /res\.armedNote \? [\s\S]{0,80}ARMED_NOTE/);
  });
});

describe('ecran « Regles » : un brouillon n’est jamais ecrase', () => {
  const code = read('rules.js');

  it("la liste est relue sans toucher au formulaire ; une modification faite ailleurs est signalee ; changer de regle demande confirmation", () => {
    // Le formulaire est construit une fois ; le rafraichissement ne fait que `form.sync()` (avertissement) et `showPresence()`.
    assert.match(code, /render\(\);\s*form\.sync\(\);\s*form\.showPresence\(\);/);
    assert.match(code, /sync\(\) \{[\s\S]{0,900}vient d’être modifiée par/);
    assert.match(code, /sync\(\) \{[\s\S]{0,900}n’existe plus/);
    assert.match(code, /Une règle est en cours de saisie et n’est pas enregistrée/);
    assert.match(code, /if \(form\.isOpen\(\) && form\.isDirty\(\)\)/);
    // Annuler un brouillon modifie demande aussi confirmation.
    assert.match(code, /cancel\.addEventListener\('click', async \(\) => \{\s*if \(isDirty\(\)\)/);
  });

  it("l'ecran masque garde son brouillon (hide() n'arrete que le minuteur) ; reset() ne sert qu'au changement de compte", () => {
    assert.match(code, /function hide\(\) \{\s*clearInterval\(timer\);\s*timer = 0;\s*\}/);
    assert.match(code, /shownFor !== getMe\(\)\.username/);
    assert.match(code, /timer = setInterval\(\(\) => !document\.hidden && load\(\), 30_000\)/);
  });

  it("une carte de regle est mise a jour sur place : une confirmation ouverte survit au rafraichissement", () => {
    assert.match(code, /const card = cards\.get\(rule\.id\)|let card = cards\.get\(rule\.id\)/);
    assert.match(code, /if \(!c\.busy\) \{\s*toggle\.checked = state\.running;/, 'pendant une action, l’interrupteur n’est pas touche');
    assert.match(code, /current\.length !== order\.length \|\| current\.some\(\(el, i\) => el !== order\[i\]\)/);
  });

  it("interrupteur : un vrai role=switch avec mot et icone ; l'etat « Inactive » se dit en mots", () => {
    assert.match(code, /type: 'checkbox', role: 'switch'/);
    // L'etat vient de ruleState : « Active », « Inactive » ou « À revoir » (une regle a revoir n'est jamais « Active »).
    assert.match(code, /if \(rule\?\.enabled\) return \{ running: true, review: false, word: 'Active'/);
    assert.match(code, /word: 'Inactive'/);
    assert.match(code, /stateWord\.textContent = state\.word;/);
    assert.match(code, /icon\(state\.review \? 'state-warning' : state\.running \? 'state-ok' : 'state-offline'\)/);
  });
});

// ------------------------------------------------------------------------------------------------ visages et assistant

const LIST_WHO: Who = { type: 'list', cameraId: 'D05', listId: '1', listName: 'Résidents et personnel' };
const PERSON_WHO: Who = { type: 'person', cameraId: 'D05', personId: 'P-42', personName: 'Awa Koné' };
const WHOS: Who[] = [{ type: 'anyone' }, { type: 'unknown' }, LIST_WHO, { type: 'list', cameraId: 'D01', listId: '7', listName: 'Interdits' }, PERSON_WHO];
/** Une liste de visages « Famille », sur la camera D05 sauf indication contraire. */
const listOf = (over: Partial<Extract<Who, { type: 'list' }>> = {}): Who => ({ type: 'list', cameraId: 'D05', listId: '1', listName: 'Famille', ...over });
const LISTS = [
  { id: '1', name: 'Résidents et personnel', cameraId: 'D05', cameraName: 'Avant cour' },
  { id: '2', name: 'Interdits', cameraId: 'D05', cameraName: 'Avant cour' },
];

describe('ecran « Regles » : case « Qui » etendue aux visages, meme verification et meme phrase que le serveur', () => {
  it('chaque « Qui » x Ou x Quand x Alors : validateSpec (serveur) accepte et normalise a l’identique, describeRule dit la meme phrase', () => {
    const whens: Partial<Form>[] = [{ whenMode: 'always' }, { whenMode: 'armed' }, { whenMode: 'windows', windows: [win([1, 2, 3, 4, 5], '19:00', '07:00')] }];
    const wheres: Partial<Form>[] = [{ whereMode: 'cameras', cameras: ['D05'] }, { whereMode: 'cameras', cameras: ['D05', 'D08'] }, { whereMode: 'zones', zones: ['Cour', 'Intérieur'] }];
    let n = 0;
    for (const who of WHOS) for (const w of wheres) for (const q of whens) for (const severity of ['warning', 'critical'] as const) for (const cooldown of ['0', '10']) {
      const f = form({ who, ...w, ...q, severity, cooldown });
      assert.deepEqual(rules.formProblems(f, CTX), [], JSON.stringify(f));
      const spec = rules.buildSpec(f);
      assert.deepEqual(spec.who, who);
      const checked = validateSpec(spec, CTX);
      assert.deepEqual(checked, spec, 'le serveur ne change rien a ce que l’ecran construit');
      assert.equal(rules.describeSpec(spec, nameOf), describeRule(checked, { cameraName: nameOf }), 'meme phrase que le serveur');
      assert.equal(rules.liveSentence(f, nameOf), describeRule(checked, { cameraName: nameOf }));
      n++;
    }
    assert.equal(n, 5 * 3 * 3 * 2 * 2);
  });

  it('« reste plus de N » reste possible pour « n’importe qui » (comportement inchange)', () => {
    const f = form({ triggerMode: 'stays', minutes: '15' });
    assert.deepEqual(rules.buildSpec(f).who, { type: 'anyone' });
    assert.deepEqual(rules.buildSpec(f).trigger, { type: 'stays', minutes: 15 });
    assert.deepEqual(rules.formProblems(f, CTX), []);
    assert.match(rules.liveSentence(f, nameOf) ?? '', /si quelqu'un reste au moins 15 min /);
  });

  it('les trois phrases de visage sont celles du serveur', () => {
    const phrase = (who: Who) => rules.liveSentence(form({ who }), nameOf) ?? '';
    assert.match(phrase({ type: 'unknown' }), /^Prévenir \(avertissement\) si un visage inconnu est vu devant la caméra « Avant cour », à toute heure ;/);
    assert.match(phrase(LIST_WHO), /si une personne de la liste « Résidents et personnel » \(caméra « Avant cour »\) est reconnue devant/);
    assert.match(phrase(PERSON_WHO), /si la personne « Awa Koné » \(caméra « Avant cour »\) est reconnue devant/);
  });

  it('la camera de la liste est dite dans la phrase ; sans camera : « caméra non précisée » (comme le serveur)', () => {
    assert.match(rules.describeSpec(rules.buildSpec(form({ who: listOf({ cameraId: 'D01' }) })), nameOf), /de la liste « Famille » \(caméra « Portail »\) est reconnue/);
    // Camera inconnue de l'ecran : son identifiant, comme le serveur.
    assert.match(rules.describeSpec(rules.buildSpec(form({ who: listOf({ cameraId: 'ZZ' }) })), nameOf), /\(caméra « ZZ »\)/);
    const old = { type: 'list', listId: '1', listName: 'Famille' } as unknown as Who;
    const text = rules.describeSpec({ ...rules.buildSpec(form()), who: old }, nameOf);
    assert.match(text, /si une personne de la liste « Famille » \(caméra non précisée\) est reconnue/);
    assert.equal(text, describeRule({ ...rules.buildSpec(form()), who: old }, { cameraName: nameOf }), 'meme phrase que le serveur, camera absente comprise');
    assert.equal(rules.UNSPECIFIED_CAMERA, '(caméra non précisée)');
    const person = { type: 'person', personId: 'P1', personName: 'Awa' } as unknown as Who;
    assert.equal(rules.describeSpec({ ...rules.buildSpec(form()), who: person }, nameOf), describeRule({ ...rules.buildSpec(form()), who: person }, { cameraName: nameOf }));
  });

  it('le « Qui » envoye au serveur porte la camera (liste et personne), telle quelle', () => {
    assert.deepEqual(rules.buildSpec(form({ who: listOf({ cameraId: 'D01' }) })).who, { type: 'list', cameraId: 'D01', listId: '1', listName: 'Famille' });
    assert.deepEqual(rules.buildSpec(form({ who: PERSON_WHO })).who, PERSON_WHO);
    assert.deepEqual(rules.cloneWho({ type: 'list', listId: '1', listName: 'A' }), { type: 'list', cameraId: '', listId: '1', listName: 'A' }, 'camera absente : texte vide, jamais « undefined »');
    assert.equal(rules.isDeviceWho(LIST_WHO), true);
    assert.equal(rules.isDeviceWho(PERSON_WHO), true);
    assert.equal(rules.isDeviceWho({ type: 'unknown' }), false);
    assert.equal(rules.isDeviceWho(undefined), false);
    // Deux formulaires qui ne different que par la camera ne sont pas le meme brouillon.
    assert.notEqual(rules.formKey(form({ who: listOf({ cameraId: 'D05' }) })), rules.formKey(form({ who: listOf({ cameraId: 'D01' }) })));
    // Le serveur accepte et ne change rien.
    const spec = rules.buildSpec(form({ who: listOf({ cameraId: 'D01' }) }));
    assert.deepEqual(validateSpec(spec, CTX), spec);
  });

  it('pour un visage, « reste plus de N minutes » est refuse par l’ecran comme par le serveur', () => {
    for (const who of WHOS.filter((w) => w.type !== 'anyone')) {
      const f = form({ who, triggerMode: 'stays', minutes: '5' });
      assert.deepEqual(rules.formProblems(f, CTX).map((p) => p.key), ['trigger'], who.type);
      assert.match(rules.formProblems(f, CTX)[0].message, /seul « un visage est vu » est possible/);
      assert.equal(rules.liveSentence(f, nameOf), null);
      assert.throws(() => validateSpec(rules.buildSpec(f), CTX), /seul « apparait » est possible/);
    }
    // Meme une duree absurde ne produit qu'un seul message : la condition elle-meme est refusee.
    assert.deepEqual(rules.formProblems(form({ who: { type: 'unknown' }, triggerMode: 'stays', minutes: '0' }), CTX).map((p) => p.key), ['trigger']);
  });

  it('une liste est requise ; identifiant et nom bornes comme au serveur ; textes ranges comme au serveur', () => {
    const serverAccepts = (f: Form) => {
      try {
        validateSpec(rules.buildSpec(f), CTX);
        return true;
      } catch {
        return false;
      }
    };
    const keys = (f: Form) => rules.formProblems(f, CTX).map((p) => p.key);
    const none = form({ who: { type: 'list', cameraId: '', listId: '', listName: '' } });
    assert.deepEqual(keys(none), ['who']);
    assert.match(rules.formProblems(none, CTX)[0].message, /^Choisissez une liste de visages\.$/);
    assert.equal(serverAccepts(none), false);
    const cases: [string, Who][] = [
      ['id de 64', { type: 'list', cameraId: 'D05', listId: 'x'.repeat(rules.MAX_FACE_ID), listName: 'A' }],
      ['id de 65', { type: 'list', cameraId: 'D05', listId: 'x'.repeat(rules.MAX_FACE_ID + 1), listName: 'A' }],
      ['nom de 80', { type: 'list', cameraId: 'D05', listId: '1', listName: 'x'.repeat(rules.MAX_FACE_NAME) }],
      ['nom de 81', { type: 'list', cameraId: 'D05', listId: '1', listName: 'x'.repeat(rules.MAX_FACE_NAME + 1) }],
      ['nom vide', { type: 'list', cameraId: 'D05', listId: '1', listName: '   ' }],
      ['nom avec controle', { type: 'list', cameraId: 'D05', listId: '1', listName: 'A\u0007B' }],
      ['nom avec caractere invisible', { type: 'list', cameraId: 'D05', listId: '1', listName: 'A​B' }],
      ['personne sans id', { type: 'person', cameraId: 'D05', personId: '', personName: 'Awa' }],
      ['personne sans nom', { type: 'person', cameraId: 'D05', personId: 'P1', personName: '' }],
      ['liste sans camera', { type: 'list', cameraId: '', listId: '1', listName: 'A' }],
      ['liste d’une camera inconnue', { type: 'list', cameraId: 'ZZ', listId: '1', listName: 'A' }],
      ['personne sans camera', { type: 'person', cameraId: '', personId: 'P1', personName: 'Awa' }],
      ['personne d’une camera inconnue', { type: 'person', cameraId: 'ZZ', personId: 'P1', personName: 'Awa' }],
    ];
    for (const [label, who] of cases) {
      const f = form({ who });
      assert.equal(keys(f).includes('who'), !serverAccepts(f), label);
    }
    assert.equal(rules.MAX_FACE_ID, 64);
    assert.equal(rules.MAX_FACE_NAME, 80);
    assert.match(SERVER_RULES, /const MAX_FACE_ID = 64;/);
    assert.match(SERVER_RULES, /const MAX_FACE_NAME = 80;/);
    // Espaces et composition Unicode : l'ecran envoie ce que le serveur gardera.
    const messy = form({ who: { type: 'list', cameraId: 'D05', listId: ' 1 ', listName: '  Résidents   et\tpersonnel ' } });
    assert.deepEqual(rules.buildSpec(messy).who, LIST_WHO);
    assert.deepEqual(validateSpec(rules.buildSpec(messy), CTX).who, LIST_WHO);
    const decomposed = form({ who: { type: 'list', cameraId: 'D05', listId: '1', listName: 'Résidents et personnel' } });
    assert.deepEqual(rules.buildSpec(decomposed).who, LIST_WHO);
  });

  it('la camera de la liste est exigee en mots clairs : absente, ou disparue du PSIM ; la personne aussi', () => {
    const msg = (who: Who, ctx: { cameraIds: Set<string>; zones: Set<string> } | null = CTX) => rules.formProblems(form({ who }), ctx).filter((p) => p.key === 'who').map((p) => p.message);
    assert.deepEqual(msg(listOf({ cameraId: '' })), ['Choisissez à nouveau la liste : la caméra qui la lit n’est pas précisée.']);
    assert.deepEqual(msg(listOf({ cameraId: 'ZZ' })), ['La caméra de la liste n’existe plus (« ZZ ») : choisissez à nouveau la liste.']);
    assert.deepEqual(msg({ type: 'person', cameraId: '', personId: 'P1', personName: 'Awa' }), ['Choisissez la caméra qui connaît cette personne.']);
    assert.deepEqual(msg({ type: 'person', cameraId: 'ZZ', personId: 'P1', personName: 'Awa' }), ['La caméra de la personne n’existe plus (« ZZ ») : choisissez-en une autre.']);
    // Sans contexte (cameras pas encore connues) : l'existence de la camera n'est pas jugee, sa presence oui.
    assert.deepEqual(msg(listOf({ cameraId: 'ZZ' }), null), []);
    assert.equal(msg(listOf({ cameraId: '' }), null).length, 1);
    // Un formulaire dont la liste n'a pas de camera n'a pas de phrase en direct (cases incompletes).
    assert.equal(rules.liveSentence(form({ who: listOf({ cameraId: '' }) }), nameOf), null);
  });

  it('une liste qui n’est plus lue n’empeche pas d’enregistrer : seul le contexte des cameras et zones est controle', () => {
    const f = form({ who: { type: 'list', cameraId: 'D05', listId: 'disparue', listName: 'Ancienne base' } });
    assert.deepEqual(rules.formProblems(f, CTX), []);
    assert.deepEqual(validateSpec(rules.buildSpec(f), CTX).who, { type: 'list', cameraId: 'D05', listId: 'disparue', listName: 'Ancienne base' });
  });

  it('une regle enregistree rouvre le meme formulaire pour chaque « Qui » (Modifier -> Enregistrer ne change rien)', () => {
    for (const who of WHOS) {
      const f = form({ who, severity: 'critical', cooldown: '25' });
      const spec = rules.buildSpec(f);
      const back = rules.formFromRule({ name: f.name, enabled: true, spec });
      assert.deepEqual(back.who, who);
      assert.deepEqual(rules.buildSpec(back), spec);
      assert.equal(rules.formKey(back), rules.formKey({ ...f, enabled: true }));
    }
    // Les copies ne sont pas partagees avec la regle.
    const spec = rules.buildSpec(form({ who: LIST_WHO }));
    const back = rules.formFromRule({ name: 'x', enabled: true, spec });
    (back.who as { listName: string }).listName = 'Autre';
    assert.equal((spec.who as { listName: string }).listName, 'Résidents et personnel');
    assert.notEqual(rules.formKey(form({ who: LIST_WHO })), rules.formKey(form({ who: { type: 'unknown' } })));
    assert.notEqual(rules.formKey(form({ who: LIST_WHO })), rules.formKey(form({ who: { ...LIST_WHO, listId: '2' } })));
    assert.notEqual(rules.formKey(form({ who: LIST_WHO })), rules.formKey(form({ who: { ...LIST_WHO, cameraId: 'D01' } })), 'meme numero sur une autre camera : une autre liste');
  });

  it('une regle sans « Qui » (ancienne forme) se rouvre comme « n’importe qui »', () => {
    const spec = rules.buildSpec(form());
    const old = { ...spec } as Partial<RuleSpec>;
    delete old.who;
    assert.deepEqual(rules.formFromRule({ name: 'x', enabled: true, spec: old as RuleSpec }).who, { type: 'anyone' });
    assert.deepEqual(rules.cloneWho(undefined), { type: 'anyone' });
    assert.deepEqual(rules.cloneWho({ type: 'inconnu' }), { type: 'anyone' });
  });
});

describe('ecran « Regles » : « Si » et « Alors » suivent le « Qui »', () => {
  it('passer a un visage ramene « reste plus de N » a « apparait » en le disant', () => {
    assert.deepEqual(rules.triggerForWho({ type: 'unknown' }, 'stays'), { triggerMode: 'appears', changed: true });
    assert.deepEqual(rules.triggerForWho(LIST_WHO, 'stays'), { triggerMode: 'appears', changed: true });
    assert.deepEqual(rules.triggerForWho(LIST_WHO, 'appears'), { triggerMode: 'appears', changed: false });
    assert.deepEqual(rules.triggerForWho({ type: 'anyone' }, 'stays'), { triggerMode: 'stays', changed: false });
    const code = read('rules.js');
    assert.match(code, /if \(trigger\.changed\) \{\s*autoTrigger = true;\s*ifNote\.textContent = 'La condition est passée à « un visage est vu »/);
  });

  it('textes de « Si » : « Quelqu’un apparait » pour n’importe qui, « Un visage est vu » pour un visage ; « reste plus de » expliquee', () => {
    assert.equal(rules.appearsTexts({ type: 'anyone' }).label, 'Quelqu’un apparaît');
    for (const who of [{ type: 'unknown' }, LIST_WHO, PERSON_WHO] as Who[]) assert.equal(rules.appearsTexts(who).label, 'Un visage est vu');
    assert.equal(rules.STAYS_FACE_NOTE, 'Pas proposé pour un visage : un visage est vu à un instant, pas pendant une durée.');
    const code = read('rules.js');
    assert.match(code, /ifStays\.input\.disabled = face;/);
    assert.match(code, /minutesInput\.disabled = face;/);
  });

  it('gravite : « avertissement » (signalement) recommande pour un visage ; « alarme » reste possible avec un rappel prudent', () => {
    const face = rules.severityTexts(true);
    assert.match(face.warning, /recommandé tant que l’essai de fiabilité n’est pas terminé/);
    assert.match(face.critical, /une reconnaissance peut se tromper : un humain doit vérifier avant d’agir/);
    assert.ok(!rules.severityTexts(false).warning.includes('fiabilité'));
    assert.ok(!rules.severityTexts(false).critical.includes('reconnaissance'));
    assert.deepEqual(rules.severityTexts(false), { warning: 'Une alerte à regarder, moins urgente.', critical: 'Une alarme rouge, la plus urgente : à traiter tout de suite.' });
    // « Alarme » reste choisissable : une regle visage critique est acceptee par le serveur.
    const f = form({ who: { type: 'unknown' }, severity: 'critical' });
    assert.deepEqual(validateSpec(rules.buildSpec(f), CTX).then, { severity: 'critical' });
    // Le defaut d'un formulaire neuf ne change pas (« avertissement », pour tout le monde).
    assert.equal(rules.defaultForm().severity, 'warning');
    assert.deepEqual(rules.defaultForm().who, { type: 'anyone' });
  });

  it('changement automatique de gravite : seulement de « n’importe qui » vers un visage, gravite non touchee', () => {
    const run = (a: Partial<{ from: string; to: string; severity: 'warning' | 'critical'; touched: boolean }>) => rules.severityForWho({ from: 'anyone', to: 'unknown', severity: 'critical', touched: false, ...a });
    assert.deepEqual(run({}), { severity: 'warning', changed: true });
    assert.deepEqual(run({ to: 'list' }), { severity: 'warning', changed: true });
    assert.deepEqual(run({ touched: true }), { severity: 'critical', changed: false }, 'gravite choisie a la main : on n’y touche pas');
    assert.deepEqual(run({ from: 'unknown', to: 'list' }), { severity: 'critical', changed: false }, 'd’un visage a un autre : rien ne change');
    assert.deepEqual(run({ to: 'anyone' }), { severity: 'critical', changed: false }, 'retour a n’importe qui : rien ne change');
    assert.deepEqual(run({ severity: 'warning' }), { severity: 'warning', changed: false });
    assert.deepEqual(run({ from: 'anyone', to: 'anyone' }), { severity: 'critical', changed: false });
    // Retour a « n'importe qui » : ce que l'ecran a change tout seul est remis, sauf une gravite choisie entre-temps.
    const back = (a: Partial<Parameters<Rules['restoreForAnyone']>[0]>) => rules.restoreForAnyone({ triggerMode: 'appears', severity: 'warning', autoTrigger: true, autoSeverity: 'critical', touched: false, ...a });
    assert.deepEqual(back({}), { triggerMode: 'stays', severity: 'critical' });
    assert.deepEqual(back({ touched: true }), { triggerMode: 'stays', severity: 'warning' });
    assert.deepEqual(back({ autoTrigger: false, autoSeverity: null }), { triggerMode: 'appears', severity: 'warning' });
    const code = read('rules.js');
    assert.match(code, /severityTouched = true;\s*thenNote\.textContent = '';/, 'toucher la gravite la verrouille');
    assert.match(code, /severityTouched = false;/, 'un formulaire ouvert repart sans gravite touchee');
  });
});

describe('ecran « Regles » : listes de visages (lecture de /api/faces/lists)', () => {
  const PORTAIL: FaceList[] = [
    { id: '1', name: 'Famille', cameraId: 'D01', cameraName: 'Portail' },
    { id: '2', name: 'Interdits', cameraId: 'D01', cameraName: 'Portail' },
  ];
  const ESCALIER: FaceList = { id: '1', name: 'Visiteurs', cameraId: 'D08', cameraName: 'Escalier' };
  const row = (i: ListItem) => [i.cameraId, i.id, i.name, i.label, i.note, i.missing];

  it('un seul appareil : le menu garde l’etiquette actuelle, « Nom de la liste », sans camera', () => {
    const items = rules.listChoices(LISTS, [{ type: 'anyone' }]);
    assert.deepEqual(items.map(row), [
      ['D05', '1', 'Résidents et personnel', 'Résidents et personnel', '', false],
      ['D05', '2', 'Interdits', 'Interdits', '', false],
    ]);
    assert.ok(items.every((i) => !i.label.includes('caméra')));
    assert.deepEqual(items.map((i) => i.cameraName), ['Avant cour', 'Avant cour']);
    assert.deepEqual(rules.listChoices([{ id: '5', name: '', cameraId: 'D05', cameraName: '' }], null as unknown as Who[]).map((i) => i.label), ['5'], 'sans nom : l’identifiant');
  });

  it('plusieurs appareils : chaque option porte le couple (camera, liste) et se lit « Famille — caméra Portail »', () => {
    const items = rules.listChoices([...PORTAIL, ESCALIER], []);
    assert.deepEqual(items.map(row), [
      ['D01', '1', 'Famille', 'Famille — caméra Portail', '', false],
      ['D01', '2', 'Interdits', 'Interdits — caméra Portail', '', false],
      ['D08', '1', 'Visiteurs', 'Visiteurs — caméra Escalier', '', false],
    ]);
    assert.equal(new Set(items.map((i) => i.key)).size, 3, 'trois couples distincts, dont deux listes « 1 »');
    // Le nom enregistre dans la regle est le nom de la liste, jamais l'etiquette.
    assert.equal(items[0].name, 'Famille');
  });

  it('deux entrees de meme nom : l’etiquette dit la camera, et le numero si cela ne suffit pas', () => {
    const same = rules.listChoices([{ id: '1', name: 'Famille', cameraId: 'D01', cameraName: 'Portail' }, { id: '1', name: 'Famille', cameraId: 'D08', cameraName: 'Escalier' }], []);
    assert.deepEqual(same.map((i) => i.label), ['Famille — caméra Portail', 'Famille — caméra Escalier']);
    // Meme nom sur une seule camera : deux entrees identiques a l'ecran seraient un piege, le numero les distingue.
    const twin = rules.listChoices([{ id: '1', name: 'Famille', cameraId: 'D01', cameraName: 'Portail' }, { id: '2', name: 'Famille', cameraId: 'D01', cameraName: 'Portail' }], []);
    assert.deepEqual(twin.map((i) => i.label), ['Famille — caméra Portail (n° 1)', 'Famille — caméra Portail (n° 2)']);
    // Le nom de la camera vient de la lecture, sinon de l'ecran, sinon son identifiant.
    const bare = [{ id: '1', name: 'A', cameraId: 'D01' }, { id: '1', name: 'B', cameraId: 'D08' }] as FaceList[];
    assert.deepEqual(rules.listChoices(bare, [], nameOf).map((i) => i.label), ['A — caméra Portail', 'B — caméra Escalier']);
    assert.deepEqual(rules.listChoices(bare, []).map((i) => i.label), ['A — caméra D01', 'B — caméra D08']);
  });

  it('une liste enregistree qui n’est plus lue reste proposee, avec son nom, et se retrouve dans le menu', () => {
    const gone: Who = { type: 'list', cameraId: 'D05', listId: '99', listName: 'Ancienne base' };
    const items = rules.listChoices(LISTS, [gone]);
    assert.deepEqual(row(items.at(-1)!), ['D05', '99', 'Ancienne base', 'Ancienne base', 'Liste non retrouvée', true]);
    assert.equal(rules.selectedListIndex(items, gone), 2);
    // Apres avoir choisi une autre liste, la liste enregistree reste proposee (via `stored`) pour revenir en arriere.
    const afterPick = rules.listChoices(LISTS, [LIST_WHO, gone]);
    assert.deepEqual(afterPick.at(-1)?.label, 'Ancienne base');
    assert.equal(afterPick.filter((i) => i.id === '99').length, 1);
    // Une liste lue n’est pas ajoutee deux fois.
    assert.equal(rules.listChoices(LISTS, [LIST_WHO, LIST_WHO]).length, 2);
    assert.equal(rules.listChoices(LISTS, [{ type: 'list', cameraId: '', listId: '', listName: '' }]).length, 2);
    // Sans camera, une liste enregistree n'est pas proposee : elle ne correspondrait a aucun appareil.
    assert.equal(rules.listChoices(LISTS, [{ type: 'list', cameraId: '', listId: '99', listName: 'Ancienne base' }]).length, 2);
    // Avec plusieurs appareils, la liste non retrouvee dit aussi sa camera (nom pris a l'ecran).
    const several = rules.listChoices([...PORTAIL, ESCALIER], [{ type: 'list', cameraId: 'D05', listId: '99', listName: 'Ancienne base' }], nameOf);
    assert.deepEqual(several.at(-1)?.label, 'Ancienne base — caméra Avant cour');
    assert.deepEqual(several.at(-1)?.note, 'Liste non retrouvée');
  });

  it('le meme numero sur un autre appareil n’est PAS la meme liste : il est propose a part, « non retrouvee »', () => {
    // La regle vise la liste « 1 » de D08 ; seule la liste « 1 » de D01 est lue.
    const who: Who = { type: 'list', cameraId: 'D08', listId: '1', listName: 'Visiteurs' };
    const items = rules.listChoices(PORTAIL, [who], nameOf);
    assert.equal(items.length, 3);
    assert.deepEqual(row(items[2]), ['D08', '1', 'Visiteurs', 'Visiteurs — caméra Escalier', 'Liste non retrouvée', true]);
    assert.equal(rules.selectedListIndex(items, who), 2, 'la liste de D08, pas celle de D01 qui a le meme numero');
  });

  it('deux listes « 1 » sur deux appareils restent distinctes a la selection et a la re-selection d’une regle existante', () => {
    const lists = [{ id: '1', name: 'Famille', cameraId: 'D01', cameraName: 'Portail' }, { id: '1', name: 'Famille', cameraId: 'D08', cameraName: 'Escalier' }];
    const items = rules.listChoices(lists, []);
    const on = (cameraId: string, listName = 'Famille'): Who => ({ type: 'list', cameraId, listId: '1', listName });
    assert.equal(rules.selectedListIndex(items, on('D01')), 0);
    assert.equal(rules.selectedListIndex(items, on('D08')), 1);
    assert.equal(rules.selectedListIndex(items, on('D01', 'Autre nom')), 0, 'liste renommee sur l’appareil : le couple (camera, numero) fait foi, pas le nom');
    assert.equal(rules.selectedListIndex(items, on('D09')), -1, 'meme numero, camera sans cette liste : rien n’est selectionne');
    assert.equal(rules.selectedListIndex(items, { type: 'list', cameraId: '', listId: '1', listName: 'Famille' }), -1, 'regle ancienne sans camera : jamais l’identifiant seul');
    assert.equal(rules.selectedListIndex(items, { type: 'list', cameraId: 'D01', listId: '', listName: '' }), -1);
    assert.equal(rules.selectedListIndex(items, { type: 'unknown' }), -1);
    assert.equal(rules.selectedListIndex(items, { type: 'person', cameraId: 'D01', personId: '1', personName: 'x' }), -1);

    // Re-selection : la regle enregistree sur D08 rouvre sur l'entree de D08, celle de D01 sur l'entree de D01.
    for (const [cameraId, index] of [['D01', 0], ['D08', 1]] as const) {
      const spec = rules.buildSpec(form({ who: on(cameraId), cameras: [cameraId === 'D01' ? 'D01' : 'D08'] }));
      const back = rules.formFromRule({ name: 'Famille', enabled: true, spec, needsReview: false });
      const view = rules.facesView({ status: 'ok', lists, notes: [] }, back.who, back.who, nameOf);
      assert.equal(view.items.length, 2, 'aucune entree « non retrouvee » en plus');
      assert.equal(rules.selectedListIndex(view.items, back.who), index);
    }
  });

  it('une regle creee depuis une autre voie du meme enregistreur est retrouvee dans la liste via deviceCameraIds', () => {
    // Deux appareils, une liste « 1 » chacun ; la camera representante est D01 (appareil A) et D08 (appareil B).
    const lists: FaceList[] = [
      { id: '1', name: 'Famille', cameraId: 'D01', cameraName: 'Portail', deviceCameraIds: ['D01', 'D05'] },
      { id: '1', name: 'Visiteurs', cameraId: 'D08', cameraName: 'Escalier', deviceCameraIds: ['D08'] },
    ];
    const items = rules.listChoices(lists, []);
    assert.deepEqual(items.map((i) => i.deviceCameraIds), [['D01', 'D05'], ['D08']]);
    // La regle a ete creee par la voie D05 (autre voie de l'appareil A) : c'est bien la liste « Famille » de l'appareil A.
    const viaOtherChannel: Who = { type: 'list', cameraId: 'D05', listId: '1', listName: 'Famille' };
    assert.equal(rules.selectedListIndex(items, viaOtherChannel), 0);
    assert.equal(rules.selectedListIndex(items, { ...viaOtherChannel, cameraId: 'D01' }), 0, 'la representante elle-meme');
    assert.equal(rules.selectedListIndex(items, { ...viaOtherChannel, cameraId: 'D08' }), 1, 'meme numero, autre appareil : l’autre liste');
    assert.equal(rules.selectedListIndex(items, { ...viaOtherChannel, listId: '2' }), -1, 'autre numero sur le bon appareil');
    assert.equal(rules.selectedListIndex(items, { ...viaOtherChannel, cameraId: 'D09' }), -1, 'camera d’aucun appareil lu');
    // Re-selection d'une regle existante : elle rouvre sur la liste de l'appareil, sans entree « non retrouvee » en plus.
    const view = rules.facesView({ status: 'ok', lists, notes: [] }, viaOtherChannel, viaOtherChannel, nameOf);
    assert.equal(view.items.length, 2);
    assert.equal(view.items.some((i) => i.missing), false);
    assert.equal(rules.selectedListIndex(view.items, viaOtherChannel), 0);
    // Une camera d'aucun appareil lu reste proposee comme « non retrouvee ».
    const lost = rules.facesView({ status: 'ok', lists, notes: [] }, { ...viaOtherChannel, cameraId: 'D09' }, null, nameOf);
    assert.deepEqual(lost.items.map((i) => i.missing), [false, false, true]);
    // Si l'utilisateur rechoisit la liste, c'est la camera representante qui part avec la regle.
    const reselected: Who = { type: 'list', cameraId: items[0].cameraId, listId: items[0].id, listName: items[0].name };
    assert.equal((rules.buildSpec(form({ who: reselected })).who as { cameraId: string }).cameraId, 'D01');
    // Une ancienne reponse sans deviceCameraIds : retombe sur l'egalite de cameraId.
    const old = rules.listChoices([{ id: '1', name: 'Famille', cameraId: 'D01', cameraName: 'Portail' }], []);
    assert.deepEqual(old[0].deviceCameraIds, ['D01']);
    assert.equal(rules.selectedListIndex(old, viaOtherChannel), -1);
    assert.equal(rules.selectedListIndex(old, { ...viaOtherChannel, cameraId: 'D01' }), 0);
  });

  it('listMatches : meme numero ET camera lue par l’appareil, rien d’autre ; entrees hostiles sans effet', () => {
    const list = { id: '1', cameraId: 'D01', deviceCameraIds: ['D01', 'D05'] };
    assert.equal(rules.listMatches(list, { listId: '1', cameraId: 'D05' }), true);
    assert.equal(rules.listMatches(list, { listId: '1', cameraId: 'D01' }), true);
    assert.equal(rules.listMatches({ ...list, id: 1 }, { listId: '1', cameraId: 'D05' }), true, 'numero lu comme nombre');
    assert.equal(rules.listMatches(list, { listId: '2', cameraId: 'D05' }), false);
    assert.equal(rules.listMatches(list, { listId: '1', cameraId: 'D08' }), false);
    assert.equal(rules.listMatches(list, { listId: '1', cameraId: '' }), false);
    assert.equal(rules.listMatches(list, { listId: '', cameraId: 'D05' }), false);
    assert.equal(rules.listMatches(list, { listId: '1' }), false);
    assert.equal(rules.listMatches(list, undefined), false);
    assert.equal(rules.listMatches(undefined, { listId: '1', cameraId: 'D05' }), false);
    assert.equal(rules.listMatches({ id: null, cameraId: 'D01' }, { listId: 'null', cameraId: 'D01' }), false);
    // Champ mal forme : ignore, la camera representante compte toujours.
    for (const bad of ['D05', 7, null, { 0: 'D05' }, [null, 3, '', 'D05']]) {
      const l = { id: '1', cameraId: 'D01', deviceCameraIds: bad };
      assert.equal(rules.listMatches(l, { listId: '1', cameraId: 'D01' }), true, JSON.stringify(bad));
      assert.equal(rules.listMatches(l, { listId: '1', cameraId: 'D05' }), Array.isArray(bad), JSON.stringify(bad));
    }
    // La comparaison est UNE fonction, utilisee partout (menu, selection, proposition).
    const code = read('rules.js');
    assert.equal([...code.matchAll(/\bdeviceCameras\(/g)].length >= 2, true);
    assert.match(code, /if \(items\.some\(\(i\) => listMatches\(i, who\)\)\) continue;/);
    assert.match(code, /return items\.findIndex\(\(i\) => listMatches\(i, who\)\);/);
    assert.match(code, /!ctx\.lists\.some\(\(l\) => listMatches\(l, form\.who\)\)/);
    assert.ok(!/i\.cameraId === who\.cameraId/.test(code), 'plus d’egalite stricte sur la camera');
  });

  it('le « Qui » envoye porte la camera de l’entree choisie dans le menu', () => {
    const lists = [{ id: '1', name: 'Famille', cameraId: 'D01', cameraName: 'Portail' }, { id: '1', name: 'Famille', cameraId: 'D08', cameraName: 'Escalier' }];
    const view = rules.facesView({ status: 'ok', lists, notes: [] }, { type: 'list', cameraId: '', listId: '', listName: '' }, null, nameOf);
    // Ce que fait le menu (web/rules.js, facesSelect « change ») : le couple de l'entree, avec le nom de la liste (pas l'etiquette).
    const picked = (n: number): Who => ({ type: 'list', cameraId: view.items[n].cameraId, listId: view.items[n].id, listName: view.items[n].name });
    assert.deepEqual(rules.buildSpec(form({ who: picked(0), cameras: ['D01'] })).who, { type: 'list', cameraId: 'D01', listId: '1', listName: 'Famille' });
    assert.deepEqual(rules.buildSpec(form({ who: picked(1), cameras: ['D08'] })).who, { type: 'list', cameraId: 'D08', listId: '1', listName: 'Famille' });
    const code = read('rules.js');
    assert.match(code, /state\.who = item && facesSelect\.value !== '' \? \{ type: 'list', cameraId: item\.cameraId, listId: item\.id, listName: item\.name \}/);
    assert.ok(!/listName: item\.label/.test(code), 'l’etiquette (avec la camera) n’est jamais enregistree comme nom de liste');
    // Le serveur accepte ces deux regles et les distingue.
    const specA = rules.buildSpec(form({ who: picked(0), cameras: ['D01'] }));
    const specB = rules.buildSpec(form({ who: picked(1), cameras: ['D08'] }));
    assert.deepEqual(validateSpec(specA, CTX), specA);
    assert.deepEqual(validateSpec(specB, CTX), specB);
    assert.notEqual(rules.formKey(form({ who: picked(0) })), rules.formKey(form({ who: picked(1) })));
  });

  it('ce que montre la zone : lecture en cours, erreur, aucune liste, menu (avec les remarques du serveur)', () => {
    const who: Who = { type: 'list', cameraId: '', listId: '', listName: '' };
    assert.equal(rules.facesView({ status: 'loading', lists: [] }, who).kind, 'loading');
    assert.equal(rules.facesView({ status: 'idle', lists: [] }, who).kind, 'loading');
    assert.equal(rules.facesView({ status: 'error', lists: [] }, who).kind, 'error');
    const empty = rules.facesView({ status: 'ok', lists: [], notes: ['La caméra « Portail » n’a pas répondu.', '  '] }, who);
    assert.equal(empty.kind, 'empty');
    assert.deepEqual(empty.notes, ['La caméra « Portail » n’a pas répondu.']);
    const ok = rules.facesView({ status: 'ok', lists: LISTS, notes: [] }, who);
    assert.equal(ok.kind, 'select');
    assert.equal(ok.items.length, 2);
    // Une liste deja choisie reste affichee meme si la lecture a echoue ou ne la voit plus.
    const stored: Who = { type: 'list', cameraId: 'D05', listId: '9', listName: 'Ancienne base' };
    assert.equal(rules.facesView({ status: 'error', lists: [] }, stored).items[0].label, 'Ancienne base');
    assert.equal(rules.facesView({ status: 'ok', lists: [] }, stored).kind, 'select', 'pas « aucune liste » quand une liste est deja choisie');
    assert.equal(rules.facesView({ status: 'loading', lists: [] }, stored).items.length, 1);
    // Des entrees illisibles de la lecture sont ignorees, jamais affichees.
    const junk = rules.facesView({ status: 'ok', lists: [null, 3, {}, { id: 4 }] as unknown as FaceList[], notes: [] }, who);
    assert.deepEqual(junk.items.map((i) => i.id), ['4']);
  });

  it("le texte « aucune liste » est celui demande, et les remarques, l'erreur et « Reessayer » sont branches", () => {
    assert.equal(rules.NO_LIST_NOTE, 'Aucune liste de visages : ajoutez une caméra à reconnaissance faciale et créez-y une base.');
    const code = read('rules.js');
    assert.match(code, /facesNotes\.replaceChildren\(\.\.\.view\.notes\.map\(\(n\) => h\('li', \{ text: n \}\)\)\)/, 'remarques en texte seulement');
    assert.match(code, /Les listes de visages n’ont pas pu être lues\. /);
    assert.match(code, /facesRetry\.addEventListener\('click'/);
    assert.match(code, /Lecture des listes de visages sur les caméras…/);
    // Les listes ne sont lues qu'a la demande (choix de la liste, ou regle deja sur une liste), pas a chaque ouverture.
    assert.match(code, /if \(type === 'list'\) loadFaces\(\);/);
    assert.match(code, /if \(state\.who\.type === 'list'\) loadFaces\(\);/);
    assert.match(code, /FACES_FRESH_MS = 5 \* 60_000/);
  });

  it('« Une personne precise » n’est pas proposee a l’ecran, mais une regle existante s’affiche et se rouvre sans perte, camera comprise', () => {
    const code = read('rules.js');
    assert.match(code, /whoPerson\.el\.hidden = true;/, 'cachee par defaut');
    assert.match(code, /whoPerson\.el\.hidden = !\(type === 'person' \|\| keptPerson\);/, 'visible seulement pour une regle qui en a une');
    assert.match(code, /Une personne précise : « \$\{person\.personName\} »/);
    const spec = rules.buildSpec(form({ who: PERSON_WHO }));
    const back = rules.formFromRule({ name: 'Awa', enabled: true, spec });
    assert.deepEqual(rules.buildSpec(back).who, PERSON_WHO);
    assert.deepEqual((rules.buildSpec(back).who as { cameraId: string }).cameraId, 'D05', 'la camera de la personne repart avec la regle');
  });

  it('personne precise : la camera qui la lit se choisit parmi les cameras, une camera disparue reste visible', () => {
    assert.deepEqual(rules.personCameraChoices(CAMERAS, 'D01'), [
      { id: 'D05', label: 'Avant cour (Cour)', missing: false },
      { id: 'D08', label: 'Escalier (Intérieur)', missing: false },
      { id: 'D01', label: 'Portail (Cour)', missing: false },
    ]);
    assert.deepEqual(rules.personCameraChoices(CAMERAS, 'X9').at(-1), { id: 'X9', label: 'X9 (caméra introuvable)', missing: true });
    assert.equal(rules.personCameraChoices(CAMERAS, '').length, 3, 'rien de choisi : aucune entree en plus');
    assert.deepEqual(rules.personCameraChoices([{ id: 'C1', name: '', zone: '' }], '').map((i) => i.label), ['C1']);
    const code = read('rules.js');
    assert.match(code, /state\.who = \{ \.\.\.state\.who, cameraId: personSelect\.value \};/);
  });
});

describe('ecran « Regles » : regle « a revoir » (needsReview)', () => {
  const lists = [{ id: '1', name: 'Famille', cameraId: 'D01', cameraName: 'Portail' }, { id: '1', name: 'Visiteurs', cameraId: 'D08', cameraName: 'Escalier' }];
  const stored = (who: unknown): RuleSpec => ({ ...rules.buildSpec(form()), who: who as Who });
  const oldList = { type: 'list', listId: '1', listName: 'Famille' }; // enregistree avant la camera source
  const code = read('rules.js');

  it('les messages sont ceux du serveur, en francais courant', () => {
    assert.equal(rules.REVIEW_NOTE, 'Cette règle doit être réenregistrée : choisissez à nouveau la liste.');
    assert.match(rules.REVIEW_PERSON_NOTE, /^Cette règle doit être réenregistrée : choisissez à nouveau la caméra/);
    assert.equal(rules.reviewNote(LIST_WHO), rules.REVIEW_NOTE);
    assert.equal(rules.reviewNote(PERSON_WHO), rules.REVIEW_PERSON_NOTE);
    assert.equal(rules.reviewNote({ type: 'unknown' }), '');
    assert.equal(rules.reviewNote(undefined), '');
    // Le serveur dit la meme chose (sans accents) : si son message change, l'ecran doit suivre.
    assert.match(SERVER_RULES, /needsReview/);
    assert.match(SERVER_RULES, /Cette regle doit etre reenregistree : choisissez a nouveau la liste/);
  });

  it('dans la liste : badge « À revoir », interrupteur verrouille et jamais « Active », message sur la carte', () => {
    assert.deepEqual(rules.ruleState({ enabled: true, needsReview: false }), { running: true, review: false, word: 'Active', title: 'Active : touchez pour la désactiver' });
    assert.deepEqual(rules.ruleState({ enabled: false, needsReview: false }), { running: false, review: false, word: 'Inactive', title: 'Inactive : touchez pour la réactiver' });
    assert.deepEqual(rules.ruleState({ enabled: false }), { running: false, review: false, word: 'Inactive', title: 'Inactive : touchez pour la réactiver' });
    // « Activee » en base mais a revoir : montree comme ne se declenchant pas.
    for (const enabled of [true, false]) {
      const s = rules.ruleState({ enabled, needsReview: true });
      assert.equal(s.running, false);
      assert.equal(s.review, true);
      assert.equal(s.word, 'À revoir');
      assert.match(s.title, /ne se déclenche pas/);
      assert.match(s.title, /Modifier/);
    }
    // Seul `needsReview === true` compte (une valeur approximative n'est pas une alerte).
    assert.equal(rules.ruleState({ enabled: true, needsReview: 'oui' as unknown as boolean }).review, false);
    // Cablage de la carte : badge, message, interrupteur verrouille, jamais de PUT depuis une carte « a revoir ».
    assert.match(code, /h\('span', \{ class: 'tag is-warning', hidden: true \}, icon\('state-warning', 'icon-sm'\), 'À revoir'\)/);
    assert.match(code, /toggle\.checked = state\.running;\s*toggle\.disabled = state\.review;/);
    assert.match(code, /c\.el\.classList\.toggle\('is-inactive', !state\.running\)/);
    assert.match(code, /reviewTag\.hidden = !state\.review;\s*reviewBox\.hidden = !state\.review;/);
    assert.match(code, /Elle ne se déclenche pas tant que ce n’est pas fait : touchez « Modifier »/);
    assert.match(code, /live\.hidden = !ruleState\(rule\)\.running \|\| ids\.length === 0;/, 'pas de « quelqu’un est vu » sur une regle qui ne se declenche pas');
    assert.match(code, /toggle\.checked = ruleState\(c\.rule\)\.running;/, 'apres un echec, l’interrupteur dit ce que fait vraiment la regle');
    assert.match(code, /h\('div', \{ class: 'rl-rule-head' \}, nameEl, reviewTag, editingTag, toggleLabel\)/);
    // Les classes de style existent deja (badge, avertissement) : rien de nouveau dans la feuille de style.
    const css = read('base.css');
    assert.match(css, /\.tag\.is-warning/);
    assert.match(css, /\.notice\.is-warning/);
  });

  it('le compte en haut de la liste ne compte pas une regle a revoir comme active', () => {
    assert.match(code, /const running = rules\.filter\(\(r\) => ruleState\(r\)\.running\)\.length;/);
    assert.match(code, /const review = rules\.filter\(\(r\) => ruleState\(r\)\.review\)\.length;/);
    assert.match(code, /\$\{review \? ` et \$\{review\} à revoir` : ''\}/);
  });

  it('a l’ouverture en edition, la liste est vide et a re-choisir ; l’enregistrement exige ce nouveau choix', () => {
    const rule = { name: 'Famille la nuit', enabled: true, needsReview: true, spec: stored(oldList) };
    const f = rules.formFromRule(rule);
    assert.deepEqual(f.who, { type: 'list', cameraId: '', listId: '', listName: '' });
    // Case « Qui » vide : selection vide meme si la liste « 1 » existe sur un appareil.
    const view = rules.facesView({ status: 'ok', lists, notes: [] }, f.who, null, nameOf);
    assert.equal(rules.selectedListIndex(view.items, f.who), -1);
    assert.equal(view.items.length, 2, 'aucune entree « non retrouvee » reprise de l’ancienne regle');
    assert.ok(view.items.every((i) => !i.missing));
    // Enregistrer exige le choix : tant que la liste est vide, le probleme est sur la case « Qui » (donc sur la liste).
    const problems = rules.formProblems(f, CTX);
    assert.deepEqual(problems.map((p) => p.key), ['who']);
    assert.equal(problems[0].message, 'Choisissez une liste de visages.');
    // Apres le choix d'une liste : plus de probleme, et le serveur accepte.
    const chosen = { ...f, who: { type: 'list', cameraId: view.items[0].cameraId, listId: view.items[0].id, listName: view.items[0].name } as Who, cameras: ['D01'] };
    assert.deepEqual(rules.formProblems(chosen, CTX), []);
    assert.deepEqual(validateSpec(rules.buildSpec(chosen), CTX), rules.buildSpec(chosen));
    // Le brouillon ouvert ne compte pas comme modifie tant que rien n'est touche, puis oui apres le choix.
    assert.equal(rules.formKey(f), rules.formKey(rules.formFromRule(rule)));
    assert.notEqual(rules.formKey(f), rules.formKey(chosen));
    // Cablage : message dans la case « Qui », tant que la liste n'est pas rechoisie.
    assert.match(code, /reviewWho = Boolean\(rule\?\.needsReview\) && isDeviceWho\(rule\?\.spec\?\.who\);/);
    assert.match(code, /const pending = reviewWho && \(\(t === 'list' && !state\.who\.listId\) \|\| \(t === 'person' && !state\.who\.cameraId\)\);/);
    assert.match(code, /whoReviewText\.textContent = pending \? reviewNote\(state\.who\) : '';/);
  });

  it('une regle ordinaire (sans needsReview) rouvre telle quelle, camera comprise', () => {
    for (const needsReview of [false, undefined]) {
      const f = rules.formFromRule({ name: 'x', enabled: true, needsReview, spec: stored(LIST_WHO) });
      assert.deepEqual(f.who, LIST_WHO);
    }
    assert.deepEqual(rules.formFromRule({ name: 'x', enabled: true, needsReview: true, spec: stored({ type: 'unknown' }) }).who, { type: 'unknown' }, 'rien a revoir pour un visage inconnu');
    assert.deepEqual(rules.formFromRule({ name: 'x', enabled: true, needsReview: true, spec: stored({ type: 'anyone' }) }).who, { type: 'anyone' });
  });

  it('une personne precise a revoir garde son identite et attend sa camera', () => {
    const f = rules.formFromRule({ name: 'Awa', enabled: false, needsReview: true, spec: stored({ type: 'person', personId: 'P-42', personName: 'Awa Koné' }) });
    assert.deepEqual(f.who, { type: 'person', cameraId: '', personId: 'P-42', personName: 'Awa Koné' });
    assert.deepEqual(rules.formProblems(f, CTX).map((p) => [p.key, p.message]), [['who', 'Choisissez la caméra qui connaît cette personne.']]);
    // Meme avec une camera deja inscrite (disparue du PSIM), elle est a rechoisir.
    const gone = rules.formFromRule({ name: 'Awa', enabled: true, needsReview: true, spec: stored({ type: 'person', cameraId: 'ZZ', personId: 'P-42', personName: 'Awa Koné' }) });
    assert.equal((gone.who as { cameraId: string }).cameraId, '');
    assert.deepEqual(rules.whoToReview(PERSON_WHO), { ...PERSON_WHO, cameraId: '' });
    assert.deepEqual(rules.whoToReview(LIST_WHO), { type: 'list', cameraId: '', listId: '', listName: '' });
    assert.deepEqual(rules.whoToReview({ type: 'unknown' }), { type: 'unknown' });
  });

  it('liste ancienne sans camera, ou camera disparue : la phrase de la carte est celle du serveur', () => {
    const rule = stored(oldList);
    assert.match(rules.describeSpec(rule, nameOf), /de la liste « Famille » \(caméra non précisée\) est reconnue/);
    assert.equal(rules.describeSpec(rule, nameOf), describeRule(rule, { cameraName: nameOf }));
    assert.throws(() => validateSpec(rule, CTX), /camera de la liste est requise/, 'le serveur la refuse tant qu’elle n’est pas reenregistree');
  });
});

describe('ecran « Regles » : un refus du serveur sur « Qui » ou « Ou » s’affiche sur la bonne case', () => {
  const code = read('rules.js');
  const OU = "Ou : aucune camera choisie n'appartient a l'appareil de la liste « Famille » (camera « Portail ») : elle ne pourrait jamais se declencher";

  it('« Ou : aucune camera choisie n’appartient a l’appareil… » -> case « Où », sans le prefixe, en phrase', () => {
    const p = rules.serverProblem(OU);
    assert.equal(p.key, 'where');
    assert.equal(p.box, 'Où');
    assert.equal(p.text, "Aucune camera choisie n'appartient a l'appareil de la liste « Famille » (camera « Portail ») : elle ne pourrait jamais se declencher.");
    assert.match(SERVER_RULES, /Ou : aucune camera choisie n'appartient a l'appareil \$\{label\} \(camera « \$\{shown\(cameraName\(who\.cameraId\)\)\} »\) : elle ne pourrait jamais se declencher/, 'le message du serveur est bien celui que l’ecran reconnait');
    assert.equal(rules.serverProblem('Où : une autre formulation').key, 'where');
  });

  it('« Qui : camera inconnue … » et « Qui : la camera de la liste est requise » -> case « Qui »', () => {
    for (const message of ['Qui : camera inconnue « D99 »', 'Qui : la camera de la liste est requise', 'Qui : la camera de la personne est requise', "Qui : la camera « Portail » de la liste « Famille » n'est reliee a aucun appareil (pas de source video) : la regle ne pourrait jamais se declencher"]) {
      const p = rules.serverProblem(message);
      assert.equal(p.key, 'who', message);
      assert.equal(p.box, 'Qui');
      assert.ok(!p.text.startsWith('Qui'), 'prefixe retire');
      assert.match(p.text, /^[A-ZÀ-Ý].*\.$/u, 'phrase : majuscule et point');
    }
    // Les vrais refus du serveur (validateSpec) sont bien rattaches a « Qui ».
    const msgOf = (who: unknown) => {
      try {
        validateSpec({ ...rules.buildSpec(form()), who }, CTX);
      } catch (err) {
        return (err as Error).message;
      }
      return '';
    };
    assert.equal(rules.serverProblem(msgOf({ type: 'list', cameraId: 'D99', listId: '1', listName: 'A' })).key, 'who');
    assert.equal(rules.serverProblem(msgOf({ type: 'list', cameraId: '', listId: '1', listName: 'A' })).key, 'who');
    assert.equal(rules.serverProblem(msgOf({ type: 'person', personId: 'P1', personName: 'Awa' })).key, 'who');
    assert.match(rules.serverProblem(msgOf({ type: 'list', cameraId: 'D99', listId: '1', listName: 'A' })).text, /^Camera inconnue « D99 »\.$/);
  });

  it('tout autre message reste en bas du formulaire, en phrase ; les mots qui commencent comme un prefixe ne comptent pas', () => {
    for (const message of ['Nom de la regle requis', 'Quand : au moins une plage horaire est necessaire', 'Ouverture : impossible', 'Oui : non', 'Quiconque : x', '', undefined, null]) {
      const p = rules.serverProblem(message);
      assert.equal(p.key, null, String(message));
      assert.equal(p.box, '');
    }
    assert.equal(rules.serverProblem('Nom de la regle requis').text, 'Nom de la regle requis.');
    assert.equal(rules.serverProblem(undefined).text, 'Le serveur n’a donné aucune explication.', 'message absent : une phrase, pas un point seul');
  });

  it('cablage : l’enregistrement ET l’essai posent le message sur la case, qui reçoit le focus, et le disent en bas', () => {
    assert.match(code, /const problem = serverProblem\(err\.message\);\s*if \(problem\.key\) \{[\s\S]{0,200}showProblems\(\[\{ key: problem\.key, message: problem\.text \}\]\);\s*formError\.textContent = `La règle n’a pas été enregistrée : corrigez la case « \$\{problem\.box\} »\.`;/);
    assert.match(code, /const problem = serverProblem\(err\.message\);\s*if \(problem\.key\) \{\s*showProblems\(\[\{ key: problem\.key, message: problem\.text \}\]\);\s*trialError\.textContent = `L’essai n’a pas pu avoir lieu : corrigez la case « \$\{problem\.box\} »\.`;/);
    // Les cles 'who' et 'where' existent bien parmi les cases : le message arrive sur leurs zones d'erreur.
    assert.match(code, /who: \{ input: [^\n]*, err: whoErr \}/);
    assert.match(code, /where: \{ input: [^\n]*, err: whereErr \}/);
    // Un message sur « Qui » avec une personne : le focus va au menu de la camera de la personne.
    assert.match(code, /state\.who\.type === 'list' \? facesSelect : state\.who\.type === 'person' \? personSelect : whoAnyone\.input/);
  });
});

describe('ecran « Regles » : assistant « Decrivez la regle en une phrase »', () => {
  const code = read('rules.js');
  const part = (from: string, to: string) => {
    const a = code.indexOf(from);
    const b = code.indexOf(to, a);
    assert.ok(a >= 0 && b > a, `${from} .. ${to}`);
    return code.slice(a, b);
  };

  it('la zone n’existe que si le serveur dit « configured: true » (lue une fois par session, masquee sans bruit en cas d’echec)', () => {
    assert.match(code, /assistBox\.hidden = assistConfigured !== true;/);
    assert.match(code, /assistConfigured = res\?\.configured === true;/);
    const probe = part('async function ensureAssist()', 'function clearAssistMessages()');
    assert.match(probe, /if \(assistConfigured !== null \|\| assistProbing\) return;/, 'une seule lecture par session');
    assert.match(probe, /catch \{\s*assistConfigured = null;/, 'echec : zone masquee, rien d’affiche, on reessaiera');
    assert.ok(!/toast\(|textContent/.test(probe), 'aucun message');
    assert.match(code, /assistConfigured = null;\s*assistProbing = false;\s*form\.reset\(\)/, 'un autre compte : lecture a refaire');
    assert.match(code, /ensureAssist\(\);\s*if \(state\.who\.type === 'list'\) loadFaces\(\);/, 'lue a l’ouverture du formulaire (creation et modification)');
  });

  it('une proposition REMPLIT le formulaire : elle n’enregistre jamais (aucun appel d’API ecrivant une regle hors du bouton Enregistrer)', () => {
    const apply = part('async function applyProposal(', 'async function askAssistant(');
    assert.ok(!/\bapi\(/.test(apply), 'applyProposal ne parle pas au serveur (les listes passent par loadFaces)');
    assert.match(code, /h\('strong', \{ text: 'Proposition de l’assistant : relisez chaque case, puis enregistrez\.' \}\)/);
    assert.match(apply, /assistProposalSummary\.textContent = res\.summary \?\? '';/, 'la phrase du serveur est montree');
    // Seuls trois appels ecrivent : l'essai (sans rien enregistrer), l'assistant (sans rien enregistrer) et le bouton Enregistrer.
    const posts = [...code.matchAll(/api\(([^)]*)method: 'POST'/g)].map((m) => m[1]);
    assert.equal(posts.length, 3, posts.join(' | '));
    assert.match(code, /el\.addEventListener\('submit'/);
    // Une saisie en cours n'est pas ecrasee sans demander.
    assert.match(apply, /Remplacer votre saisie par la proposition \?/);
    assert.match(apply, /formKey\(state\) !== \(appliedKey \?\? baseKey\)/);
  });

  it('la phrase d’origine accompagne la creation seulement (jamais la modification), et seulement apres une proposition', () => {
    assert.match(code, /proposalSource = editing \? null : sourceText \|\| null;/);
    assert.match(code, /const created = \{ \.\.\.body, enabled: state\.enabled, \.\.\.\(proposalSource \? \{ sourceText: proposalSource \} : \{\}\) \};/);
    assert.match(code, /editing \? await api\(`\/api\/rules\/\$\{editing\.id\}`, \{ method: 'PUT', body \}\) : await api\('\/api\/rules', \{ method: 'POST', body: created \}\)/);
    assert.match(code, /proposalSource = null;/, 'remise a zero a chaque ouverture');
    assert.equal(rules.MAX_SOURCE_TEXT, 1000);
    assert.match(SERVER_RULES, /const MAX_SOURCE_TEXT = 1000;/);
    assert.match(code, /maxlength: String\(MAX_SOURCE_TEXT\)/);
  });

  it('la question affiche un champ de reponse ; Entree envoie la reponse sans enregistrer la regle ; bouton occupe pendant l’appel', () => {
    assert.match(code, /assistAnswer\.addEventListener\('keydown', \(e\) => \{\s*if \(e\.key === 'Enter'\) \{\s*e\.preventDefault\(\);/);
    assert.match(code, /'Répondre'/);
    const ask = part('async function askAssistant(', 'assistText.addEventListener');
    assert.match(ask, /if \(assistBusy\) return;/);
    assert.match(ask, /setAssistBusy\(true\);/);
    assert.match(ask, /if \(!isAnswer\) assistTurns = \[\];/, '« Proposer une règle » repart d’un echange neuf ; « Repondre » le prolonge');
    assert.match(ask, /if \(history\.length\) body\.history = history;/);
    assert.match(code, /busy\(assistSend, on\);\s*busy\(assistReply, on\);/);
    assert.match(code, /if \(n !== assistSeq\) return;/, 'une reponse arrivee apres la fermeture du formulaire est ignoree');
  });

  it('refus, question, erreurs : message en texte, formulaire intact', () => {
    const ask = part('async function askAssistant(', 'assistText.addEventListener');
    assert.match(ask, /assistRefusedText\.textContent = sentence\(res\.reason\);/);
    assert.match(ask, /assistQuestionText\.textContent = String\(res\.question \?\? ''\);/);
    assert.match(ask, /assistError\.textContent = err\?\.message \? sentence\(err\.message\) : 'L’assistant n’a pas pu répondre\. Réessayez dans un instant\.';/, 'message du serveur (503, 429, 502, 504) tel quel');
    const refused = ask.slice(ask.indexOf("res?.kind === 'refused'"), ask.indexOf("res?.kind === 'rule'"));
    assert.ok(!/state\s*=|paint\(|changed\(/.test(refused), 'un refus ne touche pas au formulaire');
    assert.match(ask, /catch \(err\) \{\s*if \(n !== assistSeq\) return;\s*setAssistBusy\(false\);\s*assistError\.textContent/, 'une erreur n’affiche qu’un message');
  });

  it('les textes de la zone, la confidentialite et le plafond de 1000 caracteres sont presents', () => {
    for (const text of ['Décrivez la règle en une phrase', 'Proposer une règle', 'il ne l’enregistre jamais', 'aucune image n’est envoyée', 'Écrivez d’abord une phrase qui décrit la règle.']) assert.ok(code.includes(text), text);
    assert.match(code, /`\$\{assistText\.value\.length\} \/ \$\{MAX_SOURCE_TEXT\}`/, 'compteur discret');
  });
});

describe('ecran « Regles » : proposition de l’assistant -> formulaire (fonction pure)', () => {
  const proposal = (over: Partial<RuleSpec> = {}, name = 'Inconnus la nuit') => ({
    name,
    summary: 'phrase du serveur',
    spec: { ...rules.buildSpec(form({ who: { type: 'unknown' }, cameras: ['D05'], whenMode: 'windows', windows: [win([1, 2, 3], '19:00', '07:00')], cooldown: '30' })), ...over } as RuleSpec,
  });
  const ctx = { cameraIds: CTX.cameraIds, zones: CTX.zones, lists: LISTS };

  it('une proposition complete donne un formulaire que l’ecran et le serveur acceptent, case par case', () => {
    const { form: f, issues } = rules.formFromProposal(proposal(), ctx);
    assert.deepEqual(issues, []);
    assert.equal(f.name, 'Inconnus la nuit');
    assert.deepEqual(f.who, { type: 'unknown' });
    assert.deepEqual(f.cameras, ['D05']);
    assert.equal(f.whenMode, 'windows');
    assert.deepEqual(f.windows, [win([1, 2, 3], '19:00', '07:00')]);
    assert.equal(f.triggerMode, 'appears');
    assert.equal(f.severity, 'warning');
    assert.equal(f.cooldown, '30');
    assert.deepEqual(rules.formProblems(f, CTX), [], 'meme verification locale que la saisie manuelle');
    assert.deepEqual(rules.buildSpec(f), proposal().spec);
    assert.deepEqual(validateSpec(rules.buildSpec(f), CTX), rules.buildSpec(f));
    assert.equal(rules.liveSentence(f, nameOf), describeRule(proposal().spec, { cameraName: nameOf }));
  });

  it('reprend chaque « Qui », « Ou », « Quand », « Si », « Alors » (zones, armement, reste plus de N, alarme)', () => {
    for (const who of WHOS) {
      const stays = who.type === 'anyone';
      const src = form({ who, whereMode: 'zones', zones: ['Cour'], whenMode: 'armed', triggerMode: stays ? 'stays' : 'appears', minutes: '12', severity: 'critical', cooldown: '0' });
      const spec = rules.buildSpec(src);
      const { form: f, issues } = rules.formFromProposal({ name: 'x', spec }, { ...ctx, lists: stays ? null : [{ id: '1', cameraId: 'D05' }, { id: '7', cameraId: 'D01' }] });
      assert.deepEqual(issues, [], who.type);
      assert.deepEqual(rules.buildSpec(f), spec);
    }
  });

  it('une camera ou une zone inconnue de l’ecran n’est PAS reprise : la case reste a completer, et c’est dit', () => {
    const cams = rules.formFromProposal(proposal({ where: { cameras: ['D05', 'ZZ'] } }), ctx);
    assert.deepEqual(cams.form.cameras, ['D05']);
    assert.equal(cams.issues.length, 1);
    assert.match(cams.issues[0], /^Caméra inconnue sur cet écran : « ZZ »\. Choisissez les caméras dans la case « Où »\.$/);
    const allGone = rules.formFromProposal(proposal({ where: { cameras: ['ZZ', 'YY'] } }), ctx);
    assert.deepEqual(allGone.form.cameras, []);
    assert.match(allGone.issues[0], /^Caméras inconnues sur cet écran : « ZZ », « YY »\./);
    assert.deepEqual(rules.formProblems(allGone.form, CTX).map((p) => p.key), ['where'], 'la verification locale demande de completer la case');
    const zone = rules.formFromProposal(proposal({ where: { zones: ['Cave'] } }), ctx);
    assert.equal(zone.form.whereMode, 'zones');
    assert.deepEqual(zone.form.zones, []);
    assert.match(zone.issues[0], /^Zone inconnue sur cet écran : « Cave »\. Choisissez les zones dans la case « Où »\.$/);
    // Sans contexte (ecran pas pret) : rien n'est retire.
    assert.deepEqual(rules.formFromProposal(proposal({ where: { cameras: ['ZZ'] } }), {}).form.cameras, ['ZZ']);
  });

  it('une liste inconnue de l’ecran : la case « Qui » reste a completer ; listes pas encore lues : on garde le choix', () => {
    const spec = { who: { type: 'list', cameraId: 'D05', listId: '99', listName: 'Fantomes' } } as Partial<RuleSpec>;
    const known = rules.formFromProposal(proposal(spec), ctx);
    assert.deepEqual(known.form.who, { type: 'list', cameraId: '', listId: '', listName: '' });
    assert.match(known.issues[0], /^La liste « Fantomes » n’existe pas dans les listes lues sur l’enregistreur\. Choisissez-la dans la case « Qui »\.$/);
    assert.deepEqual(rules.formProblems(known.form, CTX).map((p) => p.key), ['who']);
    const unread = rules.formFromProposal(proposal(spec), { ...ctx, lists: null });
    assert.deepEqual(unread.form.who, { type: 'list', cameraId: 'D05', listId: '99', listName: 'Fantomes' });
    assert.deepEqual(unread.issues, []);
    assert.deepEqual(rules.formFromProposal(proposal({ who: LIST_WHO }), ctx).form.who, LIST_WHO);
  });

  it('une proposition retrouve sa liste par la camera ET le numero : le meme numero ailleurs est une autre liste', () => {
    const two = [{ id: '1', name: 'Famille', cameraId: 'D01' }, { id: '1', name: 'Visiteurs', cameraId: 'D08' }];
    const on = (cameraId: string, listId = '1'): Partial<RuleSpec> => ({ who: { type: 'list', cameraId, listId, listName: 'Famille' } });
    for (const cameraId of ['D01', 'D08']) {
      const { form: f, issues } = rules.formFromProposal(proposal(on(cameraId)), { ...ctx, lists: two });
      assert.deepEqual(issues, [], cameraId);
      assert.deepEqual(f.who, { type: 'list', cameraId, listId: '1', listName: 'Famille' });
    }
    // Une autre voie du meme appareil (deviceCameraIds) retrouve la liste.
    const viaChannel = rules.formFromProposal(proposal(on('D05')), { ...ctx, lists: [{ id: '1', name: 'Famille', cameraId: 'D01', deviceCameraIds: ['D01', 'D05'] }] });
    assert.deepEqual(viaChannel.issues, []);
    assert.deepEqual(viaChannel.form.who, { type: 'list', cameraId: 'D05', listId: '1', listName: 'Famille' });
    // Numero connu, mais pas sur cette camera : la case reste a completer, comme pour une liste inconnue.
    const other = rules.formFromProposal(proposal(on('D05')), { ...ctx, lists: two });
    assert.deepEqual(other.form.who, { type: 'list', cameraId: '', listId: '', listName: '' });
    assert.match(other.issues[0], /n’existe pas dans les listes lues/);
    // Une proposition sans camera pour la liste : jamais reprise (le serveur la refuserait), meme si les listes ne sont pas lues.
    const noCamera = { who: { type: 'list', listId: '1', listName: 'Famille' } } as unknown as Partial<RuleSpec>;
    for (const lists of [two, null]) {
      const res = rules.formFromProposal(proposal(noCamera), { ...ctx, lists });
      assert.deepEqual(res.form.who, { type: 'list', cameraId: '', listId: '', listName: '' });
      assert.match(res.issues[0], /^La proposition ne dit pas de quelle caméra vient la liste « Famille »\. Choisissez-la dans la case « Qui »\.$/);
    }
    // Personne : reprise avec sa camera ; sans camera, reprise mais a completer.
    assert.deepEqual(rules.formFromProposal(proposal({ who: PERSON_WHO }), ctx).form.who, PERSON_WHO);
    const person = rules.formFromProposal(proposal({ who: { type: 'person', personId: 'P1', personName: 'Awa' } as unknown as Who }), ctx);
    assert.deepEqual(person.form.who, { type: 'person', cameraId: '', personId: 'P1', personName: 'Awa' });
    assert.match(person.issues[0], /^La proposition ne dit pas de quelle caméra vient la personne « Awa »\./);
    assert.deepEqual(rules.formProblems(person.form, CTX).map((p) => p.key), ['who']);
  });

  it('nom borne, valeurs par defaut, pas de partage avec la proposition', () => {
    assert.equal(rules.formFromProposal(proposal({}, 'x'.repeat(200)), ctx).form.name.length, rules.MAX_NAME);
    assert.equal(rules.formFromProposal({ name: undefined as unknown as string, spec: {} as RuleSpec }, ctx).form.name, '');
    const p = proposal();
    const f = rules.formFromProposal(p, ctx).form;
    f.windows[0].days.push(0);
    f.cameras.push('D08');
    assert.deepEqual((p.spec.when as { windows: Win[] }).windows[0].days, [1, 2, 3]);
    assert.deepEqual((p.spec.where as { cameras: string[] }).cameras, ['D05']);
  });
});

describe('ecran « Regles » : echange avec l’assistant (historique, phrase d’origine)', () => {
  it('historique : tours valides seulement, 10 derniers, 500 caracteres au plus, comme le serveur', () => {
    assert.equal(rules.MAX_ASSIST_TURN, 500);
    assert.equal(rules.MAX_ASSIST_HISTORY, 10);
    const SERVER_ASSIST = readFileSync(join(import.meta.dirname, '..', 'server', 'ruleassist.ts'), 'utf8');
    assert.match(SERVER_ASSIST, /const MAX_HISTORY = 10;/);
    assert.match(SERVER_ASSIST, /const MAX_TURN = 500;/);
    assert.deepEqual(rules.historyForAssist([]), []);
    assert.deepEqual(rules.historyForAssist([{ role: 'user', text: '  la nuit  ' }, { role: 'assistant', text: 'Quelles heures ?' }, { role: 'user', text: '   ' }, { role: 'system' as 'user', text: 'x' }]), [
      { role: 'user', text: 'la nuit' },
      { role: 'assistant', text: 'Quelles heures ?' },
    ]);
    const many = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? ('assistant' as const) : ('user' as const), text: `t${i}` }));
    assert.deepEqual(rules.historyForAssist(many).map((t) => t.text), ['t4', 't5', 't6', 't7', 't8', 't9', 't10', 't11', 't12', 't13']);
    assert.equal(rules.historyForAssist([{ role: 'user', text: 'x'.repeat(900) }])[0].text.length, 500);
  });

  it('phrase d’origine : ce que l’utilisateur a ecrit durant l’echange, 1000 caracteres au plus', () => {
    assert.equal(rules.sourceTextOf([]), '');
    assert.equal(rules.sourceTextOf([{ role: 'user', text: 'Préviens-moi la nuit' }, { role: 'assistant', text: 'Quelle caméra ?' }, { role: 'user', text: 'Le portail' }]), 'Préviens-moi la nuit — Le portail');
    assert.equal(rules.sourceTextOf([{ role: 'user', text: 'x'.repeat(1500) }]).length, 1000);
  });

  it('une question prolonge l’echange (phrase puis question dans l’historique) ; une regle ou un refus le terminent', () => {
    const q = rules.nextAssistTurns([], 'Préviens-moi la nuit', { kind: 'question', question: 'Quelle caméra ?' });
    assert.deepEqual(q.turns, [{ role: 'user', text: 'Préviens-moi la nuit' }, { role: 'assistant', text: 'Quelle caméra ?' }]);
    const q2 = rules.nextAssistTurns(q.turns, 'Le portail', { kind: 'question', question: 'Quelles heures ?' });
    assert.equal(q2.turns.length, 4);
    assert.deepEqual(rules.historyForAssist(q2.turns).map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
    const done = rules.nextAssistTurns(q2.turns, 'De 19 h à 7 h', { kind: 'rule', name: 'x', spec: {}, summary: 'y' });
    assert.deepEqual(done.turns, []);
    assert.equal(done.sourceText, 'Préviens-moi la nuit — Le portail — De 19 h à 7 h');
    assert.deepEqual(rules.nextAssistTurns(q.turns, 'Autre chose', { kind: 'refused', reason: 'non' }), { turns: [], sourceText: '' });
    assert.equal(rules.nextAssistTurns([], 'une seule phrase', { kind: 'rule' }).sourceText, 'une seule phrase');
  });
});

describe('ecran « Regles » : feuille de style des visages et de l’assistant', () => {
  const css = read('rules.css').replace(/\/\*[\s\S]*?\*\//g, '');

  it('les classes nouvelles existent, sans couleur en dur, avec le rendu telephone', () => {
    for (const cls of ['.rl-assist', '.rl-assist-reply', '.rl-assist-proposal', '.rl-faces', '.rl-choice.is-disabled', '.rl-change-note']) assert.ok(css.includes(cls), cls);
    const phone = /@media \(max-width: 480px\) \{[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
    assert.match(phone, /\.rl-assist/);
    assert.match(phone, /\.rl-faces/);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(css));
  });

  it('chaque classe posee par rules.js sur les elements nouveaux est stylee', () => {
    const code = read('rules.js');
    for (const cls of ['rl-assist', 'rl-assist-row', 'rl-assist-count', 'rl-assist-ask-body', 'rl-assist-question', 'rl-assist-reply', 'rl-assist-proposal', 'rl-assist-proposal-body', 'rl-assist-summary', 'rl-assist-issues', 'rl-faces', 'rl-faces-field', 'rl-faces-status', 'rl-faces-fail-body', 'rl-faces-notes', 'rl-who-caution', 'rl-change-note']) {
      assert.ok(code.includes(cls), `classe absente du JS : ${cls}`);
      assert.ok(css.includes(`.${cls}`), `classe non stylee : ${cls}`);
    }
  });
});
