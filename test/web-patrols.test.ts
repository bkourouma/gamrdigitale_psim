/**
 * Ecran « Rondes » (web/patrols.js, web/agents-admin.js, web/patrols.css, web/agents-admin.css) : l'interface est testee
 * comme le reste du web statique, par lecture des fichiers servis (le code d'ecran touche au DOM, il n'est pas execute
 * ici) et par execution de ses fonctions PURES (ces deux modules n'importent que rules.js : aucune page n'est necessaire).
 *
 * Garde-fous verifies : route ouverte aux operateurs (journal) et onglets d'administration reserves a l'administrateur,
 * menu et page presents, feuilles de style chargees, aucune mise en forme en ligne ni HTML construit a partir de donnees
 * (CSP stricte), aucun code d'agent ni stockage navigateur, plages horaires acceptees par le serveur (server/arming.ts),
 * code personnel et identifiant d'agent conformes au contrat.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { parseSchedule } from '../server/arming.ts';

const ROOT = join(import.meta.dirname, '..');
const WEB = join(ROOT, 'web');
// Fins de ligne normalisees : le depot est extrait en CRLF sous Windows (core.autocrlf), les motifs ci-dessous sont ecrits en LF.
const read = (file: string) => readFileSync(join(WEB, file), 'utf8').replace(/\r\n/g, '\n');
const SERVER_USERS = readFileSync(join(ROOT, 'server', 'users.ts'), 'utf8');

interface Win {
  days: number[];
  from: string;
  to: string;
}
interface Problem {
  key: string;
  message: string;
}
interface RouteForm {
  name: string;
  checkpoints: number[];
  ordered: boolean;
  maxMinutes: string;
  schedule: Win[];
  agentsMode: string;
  agents: string[];
  graceMinutes: string;
  enabled: boolean;
}
interface Patrols {
  tabsFor: (role: string) => { key: string }[];
  defaultTab: (role: string) => string;
  tabFromHash: (hash: string, role: string) => string | null;
  listOf: (data: unknown, key: string) => Record<string, unknown>[];
  defaultRouteForm: () => RouteForm;
  formFromRoute: (route: unknown) => RouteForm;
  routeProblems: (form: RouteForm, ctx?: { checkpointIds?: Set<number>; agentNames?: Set<string> | null } | null) => Problem[];
  buildRoutePayload: (form: RouteForm) => { name: string; checkpoints: number[]; ordered: boolean; maxMinutes: number; schedule: Win[]; agents: string[]; graceMinutes: number; enabled: boolean };
  describeRoute: (route: unknown, opts?: { agentName?: (u: string) => string }) => string;
  checkpointProblems: (form: { name: string; zone: string; floorId: unknown }) => Problem[];
  buildCheckpointPayload: (form: { name: string; zone: string; floorId: unknown }) => { name: string; zone: string; floorId: number };
  labelUrl: (origin: string, code: string) => string;
  periodRange: (preset: string, now: number) => { from: number; to: number };
  statusLabel: (s: string) => string;
  verdictLabel: (s: string) => string;
  categoryLabel: (s: string) => string;
  runProgress: (run: unknown, expected: { id: number; name: string }[] | null) => { done: number; total: number | null; missed: { id: number; name: string }[] };
  normRun: (raw: unknown) => unknown;
  normEntry: (raw: unknown) => { hasPhoto: boolean; category: string; incidentId: number | null };
}
interface Agents {
  AGENT_USERNAME: RegExp;
  pinProblem: (pin: unknown) => string | null;
  agentProblems: (form: Record<string, unknown>, opts?: { edit?: boolean }) => Problem[];
  buildAgentPayload: (form: Record<string, unknown>, opts?: { edit?: boolean }) => Record<string, unknown>;
  phoneState: (phone: Record<string, unknown>, now: number) => { key: string; label: string };
  phoneAgo: (ts: unknown, now: number) => string;
  shiftText: (shift: unknown, now: number) => string;
  randomPin: (length?: number) => string;
  countdownText: (expiresAt: unknown, now: number) => string;
}
const patrols = (await import(pathToFileURL(join(WEB, 'patrols.js')).href)) as Patrols;
const agents = (await import(pathToFileURL(join(WEB, 'agents-admin.js')).href)) as Agents;

const validRoute = (over: Partial<RouteForm> = {}): RouteForm => ({
  ...patrols.defaultRouteForm(),
  name: 'Ronde de nuit',
  checkpoints: [3, 1, 2],
  schedule: [{ days: [1, 2, 3, 4, 5], from: '22:00', to: '06:00' }],
  ...over,
});

describe('ecran « Rondes » : page et navigation', () => {
  const html = read('index.html');

  it('le menu principal porte l’entree (visible des operateurs), la page existe, les feuilles de style sont chargees', () => {
    const main = /<nav class="rail-nav"[\s\S]*?<div id="nav-admin"/.exec(html)?.[0] ?? '';
    assert.match(main, /href="#\/rondes" data-view="rondes"[\s\S]*?Rondes/, 'entree hors du groupe Administration (masque aux operateurs)');
    assert.match(html, /<section class="view view-rondes[^"]*" id="view-rondes"[^>]*hidden>/);
    for (const key of ['points', 'routes', 'agents', 'phones', 'journal']) {
      assert.match(html, new RegExp(`<section id="pt-panel-${key}" class="pt-panel" role="tabpanel" aria-labelledby="pt-tab-${key}"[^>]*hidden></section>`), `panneau ${key}`);
    }
    assert.match(html, /<link rel="stylesheet" href="patrols\.css">/);
    assert.match(html, /<link rel="stylesheet" href="agents-admin\.css">/);
  });

  it('la route n’est pas reservee aux administrateurs : les onglets d’administration le sont, dans le module', () => {
    const app = read('app.js');
    const line = /^\s*rondes: \{[^\n]*\},$/m.exec(app)?.[0] ?? '';
    assert.ok(line, 'entree ROUTES rondes');
    assert.doesNotMatch(line, /admin: true/, 'un operateur lit le journal des rondes');
    assert.deepEqual(patrols.tabsFor('operator').map((t) => t.key), ['agents', 'journal'], 'avenant 2 : le chef de poste a Agents (déverrouiller, terminer un service) et le journal');
    assert.deepEqual(patrols.tabsFor('admin').map((t) => t.key), ['points', 'routes', 'agents', 'phones', 'journal']);
    assert.equal(patrols.defaultTab('operator'), 'journal');
    assert.equal(patrols.defaultTab('admin'), 'points');
    assert.equal(patrols.tabFromHash('#/rondes/agents', 'admin'), 'agents');
    assert.equal(patrols.tabFromHash('#/rondes/agents', 'operator'), 'agents');
    assert.equal(patrols.tabFromHash('#/rondes/phones', 'operator'), null, 'un operateur ne peut pas ouvrir Telephones par l’adresse');
    assert.equal(patrols.tabFromHash('#/rondes/points', 'operator'), null);
    assert.equal(patrols.tabFromHash('#/rondes/journal', 'operator'), 'journal');
    assert.equal(patrols.tabFromHash('#/rondes/inconnu', 'admin'), null);
  });

  it('app.js branche les deux modules : entree, sortie et deconnexion', () => {
    const app = read('app.js');
    assert.match(app, /import \{ createPatrolsView \} from '\.\/patrols\.js';/);
    assert.match(app, /import \{ createAgentsAdmin \} from '\.\/agents-admin\.js';/);
    assert.match(app, /view === 'rondes'\) \{\s*patrolsView\.hide\(\);\s*agentsAdmin\.hide\(\);/);
    assert.match(app, /view === 'rondes'\) \{\s*patrolsView\.show\(\)/);
    assert.match(app, /patrolsView\.reset\(\);\s*agentsAdmin\.reset\(\);/, 'rien du compte precedent ne reste apres une deconnexion');
  });

  it('avenant 2 : le chef de poste deverrouille par la route dediee et ne voit ni creation, ni modification, ni retrait', () => {
    const src = read('agents-admin.js');
    assert.match(src, /api\(`\$\{path\}\/unlock`, \{ method: 'POST' \}\)/);
    assert.match(src, /api\(`\$\{path\}\/end-shift`, \{ method: 'POST' \}\)/);
    assert.match(src, /const isAdmin = \(\) => getMe\(\)\?\.role === 'admin'/);
    assert.match(src, /if \(admin\) actions\.push\(retire\)/, 'retrait reserve a l’administrateur');
    assert.match(src, /const editBtn = admin \?/, 'modification reservee a l’administrateur');
    assert.match(src, /createPanel\.hidden = !isAdmin\(\)/, 'creation reservee a l’administrateur');
  });

  it('l’ecran des comptes ne liste pas les agents de terrain', () => {
    assert.match(read('users.js'), /list\.filter\(\(u\) => u\.role !== 'agent'\)/);
    assert.match(html, /href="#\/rondes\/agents"/);
  });
});

describe('ecran « Rondes » : securite du code servi (CSP stricte, aucun secret conserve)', () => {
  for (const file of ['patrols.js', 'agents-admin.js']) {
    const src = read(file);
    it(`${file} : aucun HTML construit, aucun style en ligne, aucun import hors rules.js`, () => {
      assert.doesNotMatch(src, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|eval\(|new Function\(/);
      assert.doesNotMatch(src, /setAttribute\(\s*['"]style['"]/);
      assert.doesNotMatch(src, /\bstyle=\s*["']/);
      assert.doesNotMatch(src, /\bon(click|error|load)=/i);
      const imports = [...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
      assert.deepEqual(imports.filter((i) => i !== './rules.js'), []);
    });

    it(`${file} : ni stockage du navigateur ni journal de console`, () => {
      assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|console\.(log|info|debug)/);
    });
  }

  it('le code personnel d’un agent est tire avec crypto.getRandomValues, jamais Math.random', () => {
    const src = read('agents-admin.js');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(/\bcrypto\b/.test(code) && /\.getRandomValues\(/.test(code), 'crypto.getRandomValues utilise');
    assert.ok(!/Math\.random/.test(code), 'Math.random absent du code');
  });

  it('les feuilles de style n’utilisent que les jetons du produit (pas de couleur en dur hors impression et QR)', () => {
    for (const file of ['patrols.css', 'agents-admin.css']) {
      const screen = read(file).replace(/@media print\s*\{[\s\S]*$/, '');
      const hard = [...screen.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
      assert.deepEqual(hard.filter((c) => c !== '#ffffff' && c !== '#fff' && c !== '#10264a'), [], `${file} : couleur en dur`);
    }
  });

  it('les images (QR, photos) passent par une adresse de meme origine, jamais par data: ni blob:', () => {
    const src = `${read('patrols.js')}\n${read('agents-admin.js')}`;
    assert.match(src, /\/api\/patrols\/checkpoints\/\$\{[^}]+\}\/qr\.svg/);
    assert.match(src, /\/api\/agent-phones\/\$\{[^}]+\}\/pair\.svg/);
    assert.match(src, /\/api\/agent-cert\.svg/);
    assert.match(src, /\/api\/patrols\/logbook\/\$\{[^}]+\}\/photo/);
    assert.doesNotMatch(src, /createObjectURL|data:image/);
  });

  it('impression : la planche est seule imprimee (le reste du cadre est masque)', () => {
    const css = read('patrols.css');
    assert.match(css, /@media print/);
    assert.match(css, /body\.pt-printing :is\([^)]*\.rail[^)]*\.topbar[^)]*\)\s*\{\s*display: none !important/);
    assert.match(css, /break-inside: avoid/);
  });
});

describe('circuits : validation et corps envoye', () => {
  it('un circuit valide ne signale rien et son corps est accepte par le serveur (plages)', () => {
    const form = validRoute({ ordered: true });
    assert.deepEqual(patrols.routeProblems(form), []);
    const body = patrols.buildRoutePayload(form);
    assert.deepEqual(body.checkpoints, [3, 1, 2], 'l’ordre choisi est conserve');
    assert.equal(body.maxMinutes, 45);
    assert.equal(body.graceMinutes, 10);
    assert.deepEqual(body.agents, [], '« tout agent en service » = liste vide');
    assert.deepEqual(parseSchedule(body.schedule), body.schedule, 'plages acceptees telles quelles par server/arming.ts');
  });

  it('les jours sont tries et dedoublonnes, comme le serveur les attend', () => {
    const body = patrols.buildRoutePayload(validRoute({ schedule: [{ days: [5, 1, 1, 0], from: '07:00', to: '09:00' }] }));
    assert.deepEqual(body.schedule[0].days, [0, 1, 5]);
    assert.deepEqual(parseSchedule(body.schedule), body.schedule);
  });

  it('chaque refus est en mots simples et porte la cle du champ a corriger', () => {
    const keys = (form: RouteForm) => patrols.routeProblems(form).map((p) => p.key);
    assert.deepEqual(keys(validRoute({ name: '  ' })), ['name']);
    assert.deepEqual(keys(validRoute({ checkpoints: [] })), ['checkpoints']);
    assert.deepEqual(keys(validRoute({ maxMinutes: '0' })), ['maxMinutes']);
    assert.deepEqual(keys(validRoute({ maxMinutes: '1441' })), ['maxMinutes']);
    assert.deepEqual(keys(validRoute({ maxMinutes: '4,5' })), ['maxMinutes']);
    assert.deepEqual(keys(validRoute({ graceMinutes: '121' })), ['graceMinutes']);
    assert.deepEqual(keys(validRoute({ graceMinutes: '0' })), [], '0 : pas d’attente, permis');
    assert.deepEqual(keys(validRoute({ schedule: [] })), ['schedule']);
    assert.deepEqual(keys(validRoute({ schedule: [{ days: [], from: '22:00', to: '06:00' }] })), ['schedule:0']);
    assert.deepEqual(keys(validRoute({ schedule: [{ days: [1], from: '22:00', to: '22:00' }] })), ['schedule:0'], 'debut = fin refuse, comme server/arming.ts');
    assert.deepEqual(keys(validRoute({ agentsMode: 'some', agents: [] })), ['agents']);
    for (const p of patrols.routeProblems(validRoute({ name: '' }))) assert.match(p.message, /[a-zé]{4}/);
  });

  it('plus de 14 plages : refuse (limite du serveur)', () => {
    const many = Array.from({ length: 15 }, () => ({ days: [1], from: '07:00', to: '08:00' }));
    assert.ok(patrols.routeProblems(validRoute({ schedule: many })).some((p) => p.key === 'schedule'));
    assert.throws(() => parseSchedule(many), /trop de plages/);
  });

  it('un point ou un agent disparu entre-temps est signale', () => {
    const ctx = { checkpointIds: new Set([1, 2]), agentNames: new Set(['kouassi']) };
    assert.ok(patrols.routeProblems(validRoute(), ctx).some((p) => p.key === 'checkpoints'));
    assert.ok(patrols.routeProblems(validRoute({ agentsMode: 'some', agents: ['inconnu'] }), ctx).some((p) => p.key === 'agents'));
  });

  it('modifier un circuit : le formulaire est une copie, le corps renvoie ce qui est affiche', () => {
    const route = { id: 7, name: 'Tour', checkpoints: [4, 5], ordered: true, maxMinutes: 30, schedule: [{ days: [1, 2], from: '07:00', to: '09:00' }], agents: ['kouassi'], graceMinutes: 15, enabled: false };
    const form = patrols.formFromRoute(route);
    form.schedule[0].days.push(3);
    assert.deepEqual(route.schedule[0].days, [1, 2], 'le circuit affiche n’est jamais modifie par son formulaire');
    form.schedule[0].days.pop();
    assert.deepEqual(patrols.buildRoutePayload(form), { name: 'Tour', checkpoints: [4, 5], ordered: true, maxMinutes: 30, schedule: route.schedule, agents: ['kouassi'], graceMinutes: 15, enabled: false });
  });

  it('la phrase d’un circuit dit tout', () => {
    const phrase = patrols.describeRoute({ checkpoints: [1, 2, 3, 4, 5, 6, 7, 8], ordered: true, maxMinutes: 45, schedule: [{ days: [1, 2, 3, 4, 5], from: '22:00', to: '06:00' }], agents: [] });
    assert.match(phrase, /^8 points, dans l'ordre, à finir en 45 min\./);
    assert.match(phrase, /de 22:00 à 06:00 le lendemain/);
    assert.match(phrase, /Agents : tout agent en service\.$/);
    assert.match(patrols.describeRoute({ checkpoints: [1], ordered: false, maxMinutes: 30, schedule: [{ days: [0], from: '07:00', to: '09:00' }], agents: ['a', 'b'] }, { agentName: (u) => u.toUpperCase() }), /Agents : A et B\.$/);
  });
});

describe('points de contrôle : formulaire et étiquette', () => {
  it('nom obligatoire, étage obligatoire, zone facultative', () => {
    assert.deepEqual(patrols.checkpointProblems({ name: 'Portail', zone: '', floorId: 1 }), []);
    assert.deepEqual(patrols.checkpointProblems({ name: '', zone: '', floorId: 1 }).map((p) => p.key), ['name']);
    assert.deepEqual(patrols.checkpointProblems({ name: 'x', zone: '', floorId: '' }).map((p) => p.key), ['floor']);
    assert.deepEqual(patrols.checkpointProblems({ name: 'x'.repeat(81), zone: '', floorId: 1 }).map((p) => p.key), ['name']);
  });

  it('le corps envoyé est nettoyé et l’étage est un nombre', () => {
    assert.deepEqual(patrols.buildCheckpointPayload({ name: '  Parking ', zone: ' Extérieur ', floorId: '2' }), { name: 'Parking', zone: 'Extérieur', floorId: 2 });
  });

  it('l’étiquette contient l’adresse du contrat : https://<hôte>/agent/#cp=<code>', () => {
    assert.equal(patrols.labelUrl('https://psim.local:3033', 'abcde23456'), 'https://psim.local:3033/agent/#cp=abcde23456');
    assert.equal(patrols.labelUrl('https://psim.local/', 'abcde23456'), 'https://psim.local/agent/#cp=abcde23456');
  });
});

describe('journal : lecture tolérante et libellés', () => {
  it('listOf accepte un tableau nu ou enveloppé et ignore le reste', () => {
    assert.deepEqual(patrols.listOf([{ id: 1 }, 3, null], 'runs'), [{ id: 1 }]);
    assert.deepEqual(patrols.listOf({ runs: [{ id: 2 }] }, 'runs'), [{ id: 2 }]);
    assert.deepEqual(patrols.listOf({ error: 'x' }, 'runs'), []);
    assert.deepEqual(patrols.listOf(null, 'runs'), []);
  });

  it('les périodes vont du début de la journée locale à la fin d’aujourd’hui', () => {
    const now = new Date(2026, 9, 17, 14, 30).getTime();
    const day = patrols.periodRange('today', now);
    assert.equal(day.from, new Date(2026, 9, 17).getTime());
    assert.equal(day.to, new Date(2026, 9, 18).getTime() - 1);
    assert.equal(patrols.periodRange('7d', now).from, new Date(2026, 9, 11).getTime());
    assert.equal(patrols.periodRange('30d', now).from, new Date(2026, 8, 18).getTime());
  });

  it('chaque état, verdict et catégorie a un mot (jamais la couleur seule)', () => {
    assert.deepEqual(['pending', 'active', 'done', 'incomplete', 'missed'].map(patrols.statusLabel), ['À venir', 'En cours', 'Faite', 'Incomplète', 'Non faite']);
    assert.equal(patrols.verdictLabel('out_of_order'), 'Hors ordre');
    assert.equal(patrols.categoryLabel('damage'), 'Dégradation');
    assert.equal(patrols.categoryLabel('???'), 'Autre');
  });

  it('seuls les passages valides comptent ; les points manqués sont nommés', () => {
    const run = patrols.normRun({ id: 1, routeId: 1, status: 'incomplete', scans: [{ checkpointId: 1, verdict: 'ok' }, { checkpointId: 2, verdict: 'out_of_order' }, { checkpointId: 3, verdict: 'duplicate' }] });
    const progress = patrols.runProgress(run, [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }]);
    assert.equal(progress.done, 1);
    assert.equal(progress.total, 3);
    assert.deepEqual(progress.missed.map((m) => m.name), ['B', 'C']);
    assert.deepEqual(patrols.runProgress(run, null), { done: 1, total: null, missed: [] });
  });

  it('une entrée de main courante : photo reconnue, catégorie inconnue = autre', () => {
    assert.equal(patrols.normEntry({ id: 1, hasPhoto: true }).hasPhoto, true);
    assert.equal(patrols.normEntry({ id: 1, photoFile: 'x.jpg' }).hasPhoto, true);
    assert.equal(patrols.normEntry({ id: 1 }).hasPhoto, false);
    assert.equal(patrols.normEntry({ id: 1, category: 'zzz' }).category, 'other');
    assert.equal(patrols.normEntry({ id: 1, incidentId: 42 }).incidentId, 42);
  });
});

describe('agents et téléphones : règles du contrat', () => {
  it('l’identifiant d’un agent suit la règle des comptes du serveur', () => {
    const server = /const USERNAME_PATTERN = (\/[^\n]+\/);/.exec(SERVER_USERS)?.[1];
    assert.ok(server, 'regle d’identifiant du serveur');
    assert.equal(agents.AGENT_USERNAME.source, new RegExp(server.slice(1, -1)).source);
    assert.equal(agents.AGENT_USERNAME.test('kouassi.yao'), true);
    assert.equal(agents.AGENT_USERNAME.test('Kouassi'), false);
    assert.equal(agents.AGENT_USERNAME.test('ab'), false);
  });

  it('le code personnel a 4 à 6 chiffres exactement', () => {
    for (const ok of ['1234', '12345', '123456']) assert.equal(agents.pinProblem(ok), null);
    for (const bad of ['', '123', '1234567', '12a4', '12 34', null, undefined]) assert.ok(agents.pinProblem(bad), `refuse : ${String(bad)}`);
  });

  it('la création demande nom, identifiant, code, zones et durée ; la modification laisse le code vide', () => {
    const form = { displayName: 'Kouassi Yao', username: 'kouassi', pin: '4821', allZones: true, zones: [], hours: '12' };
    assert.deepEqual(agents.agentProblems(form), []);
    assert.deepEqual(agents.buildAgentPayload(form), { username: 'kouassi', displayName: 'Kouassi Yao', pin: '4821', zones: [], maxShiftMinutes: 720 });
    assert.deepEqual(agents.agentProblems({ ...form, displayName: '', username: 'X', pin: '1' }).map((p) => p.key), ['displayName', 'username', 'pin']);
    assert.deepEqual(agents.agentProblems({ ...form, allZones: false, zones: [] }).map((p) => p.key), ['zones']);
    assert.deepEqual(agents.agentProblems({ ...form, hours: '25' }).map((p) => p.key), ['hours']);
    const edit = { ...form, pin: '' };
    assert.deepEqual(agents.agentProblems(edit, { edit: true }), []);
    const body = agents.buildAgentPayload(edit, { edit: true });
    assert.equal('pin' in body, false, 'un code vide n’est jamais envoyé');
    assert.equal('username' in body, false);
  });

  it('randomPin : des chiffres, la longueur demandée, jamais un code trivial', () => {
    for (let i = 0; i < 500; i++) {
      const pin = agents.randomPin(4);
      assert.match(pin, /^\d{4}$/);
      assert.ok(!['0000', '1234', '4321'].includes(pin));
    }
    assert.match(agents.randomPin(6), /^\d{6}$/);
  });

  it('état d’un téléphone : révoqué, appairé, en attente ou code expiré', () => {
    const now = 1_000_000;
    assert.equal(agents.phoneState({ revokedAt: 5, pairedAt: 3 }, now).key, 'revoked');
    assert.equal(agents.phoneState({ pairedAt: 3 }, now).key, 'paired');
    assert.equal(agents.phoneState({ pending: true, expiresAt: now + 60_000 }, now).key, 'pending');
    assert.equal(agents.phoneState({ pending: true, expiresAt: now - 1 }, now).key, 'expired');
    assert.equal(agents.phoneState({ pending: false }, now).key, 'expired');
  });

  it('dernière activité et compte à rebours en français courant', () => {
    const now = 10_000_000_000;
    assert.equal(agents.phoneAgo(null, now), 'jamais');
    assert.equal(agents.phoneAgo(now - 5_000, now), "à l'instant");
    assert.equal(agents.phoneAgo(now - 4 * 60_000, now), 'il y a 4 min');
    assert.equal(agents.phoneAgo(now - 2 * 3_600_000, now), 'il y a 2 h');
    assert.equal(agents.phoneAgo(now - 3 * 86_400_000, now), 'il y a 3 jours');
    assert.equal(agents.countdownText(now + 12 * 60_000, now), 'Valable encore 12 min');
    assert.match(agents.countdownText(now - 1, now), /expiré/);
    assert.equal(agents.shiftText(null, now), 'Hors service');
  });

  it('aucun secret ne reste dans la page : ni code d’appairage ni code d’agent hors fenêtre dédiée', () => {
    const src = read('agents-admin.js');
    assert.doesNotMatch(src, /dataset\.(pin|code|pair)/i);
    assert.match(src, /Agent créé/);
    assert.match(src, /une seule fois|ne sera plus affiché/i);
  });
});
