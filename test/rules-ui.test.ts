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
import type { RuleSpec } from '../server/rules.ts';

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
  formFromRule: (rule: { name: string; enabled: boolean; spec: RuleSpec }) => Form;
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
    assert.deepEqual([...paths].sort(), ['/api/presence', '/api/rules', '/api/rules/', '/api/rules/simulate'].sort());
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
    assert.match(code, /if \(!c\.busy\) toggle\.checked = rule\.enabled/);
    assert.match(code, /current\.length !== order\.length \|\| current\.some\(\(el, i\) => el !== order\[i\]\)/);
  });

  it("interrupteur : un vrai role=switch avec mot et icone ; l'etat « Inactive » se dit en mots", () => {
    assert.match(code, /type: 'checkbox', role: 'switch'/);
    assert.match(code, /rule\.enabled \? 'Active' : 'Inactive'/);
    assert.match(code, /icon\(rule\.enabled \? 'state-ok' : 'state-offline'\)/);
  });
});
