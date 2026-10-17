/**
 * Ouverture a distance d'une porte (F17), mode de porte (F19), « Tout ouvrir » (F20) : web/dooractions.js, ses additions a
 * web/commands.js et web/incidents.js. Comme pour le reste du web statique : lecture des fichiers servis et execution des
 * fonctions PURES du composant (le module ne touche pas au DOM a l'import).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const WEB = join(import.meta.dirname, '..', 'web');
const read = (file: string) => readFileSync(join(WEB, file), 'utf8').replace(/\r\n/g, '\n');

interface Cfg {
  minS?: number;
  maxS?: number;
}
interface Actuator {
  id: string;
  type: string;
  active?: boolean;
  linkUp?: boolean | null;
  emergencyExit?: boolean;
  allowed: string[];
  safeAction?: string;
  actions: Record<string, Cfg>;
}
interface Button {
  key: string;
  action: string;
  label: string;
  safe: boolean;
  durationS?: number | null;
}
interface Plan {
  state: string;
  message: string | null;
  blocked: string | null;
  notes: string[];
  buttons: Button[];
  minutes: { ok: boolean; maxMinutes: number; reason: string | null; defaultMinutes: number | null } | null;
}
interface RowState {
  key: string;
  label: string;
  detail: string;
  open: boolean;
  final: boolean;
}
interface Mod {
  EVACUATION_PHRASE: string;
  EVACUATION_WARNING: string;
  EMERGENCY_NOTE: string;
  doorModeText: (door: unknown) => { known: boolean; text: string; at: number | null };
  pulseDurationS: (cfg?: Cfg) => number | null;
  minutesLimit: (cfg?: Cfg) => { ok: boolean; maxMinutes: number; reason: string | null };
  minutesToSeconds: (m: unknown, cfg?: Cfg) => number | null;
  minutesLabel: (n: number) => string;
  doorActionPlan: (x: { door?: unknown; remote?: unknown; actuator?: Actuator | null; maintenance?: boolean }) => Plan;
  commandStateText: (c: unknown) => string;
  commandTone: (c: unknown) => string;
  evacuationPhraseOk: (t: unknown) => boolean;
  evacuationPayload: (x: { reason?: string; phrase?: string; password?: string }) => { ok: boolean; missing?: string[]; body?: Record<string, unknown> };
  evacuationPreview: (d: unknown) => { total: number; ready: number; notReady: unknown[]; canGo: boolean };
  evacuationRowState: (r: unknown, c?: unknown) => RowState;
  evacuationBilan: (s: RowState[]) => { opened: number; total: number; pending: number; text: string; complete: boolean; allOpen: boolean };
  actuatorTypeForKind: (k: unknown) => string | null;
  compatibleActuators: (x: { door: unknown; actuators: unknown[]; doors: unknown[] }) => { id: string }[];
  doorActions: unknown;
  evacuationButton: unknown;
}
const m = (await import(pathToFileURL(join(WEB, 'dooractions.js')).href)) as Mod;

const lock = (over: Partial<Actuator> = {}): Actuator => ({
  id: 'gache1',
  type: 'lock',
  active: true,
  linkUp: true,
  emergencyExit: false,
  allowed: ['unlock', 'lock'],
  safeAction: 'lock',
  actions: { unlock: { minS: 1, maxS: 600 }, lock: {} },
  ...over,
});
const gate = (over: Partial<Actuator> = {}): Actuator => ({
  id: 'portail',
  type: 'gate',
  active: true,
  linkUp: true,
  allowed: ['open', 'close', 'stop'],
  safeAction: 'stop',
  actions: { open: { minS: 1, maxS: 120 }, close: {}, stop: {} },
  ...over,
});
const remote = (type: 'lock' | 'gate' = 'lock') => ({ available: true, reason: null, actuatorId: type === 'lock' ? 'gache1' : 'portail', actuatorName: 'X', actuatorType: type });
const keys = (p: Plan) => p.buttons.map((b) => b.key);

describe('composant porte : boutons selon type, droits, issue de secours, maintenance', () => {
  it('serrure : impulsion de 5 s, ouvrir N minutes, verrouiller (action sure)', () => {
    const p = m.doorActionPlan({ door: {}, remote: remote(), actuator: lock() });
    assert.equal(p.state, 'ready');
    assert.deepEqual(keys(p), ['unlock_pulse', 'lock']);
    assert.equal(p.buttons[0].label, 'Ouvrir (impulsion)');
    assert.equal(p.buttons[0].durationS, 5);
    assert.equal(p.buttons[1].safe, true);
    assert.equal(p.buttons[0].safe, false);
    assert.equal(p.minutes?.ok, true);
    assert.equal(p.minutes?.maxMinutes, 10);
    assert.equal(p.minutes?.defaultMinutes, 5);
  });

  it('issue de secours : aucun bouton Verrouiller, la phrase du produit est affichee', () => {
    for (const p of [m.doorActionPlan({ door: { emergencyExit: true }, remote: remote(), actuator: lock() }), m.doorActionPlan({ door: {}, remote: remote(), actuator: lock({ emergencyExit: true }) })]) {
      assert.ok(!keys(p).includes('lock'));
      assert.deepEqual(p.notes, ['Issue de secours : le PSIM ne la verrouille jamais.']);
      assert.ok(keys(p).includes('unlock_pulse'));
    }
    assert.equal(m.EMERGENCY_NOTE, 'Issue de secours : le PSIM ne la verrouille jamais.');
  });

  it('duree maximale trop petite : pas de bouton minutes, explication donnee ; l’impulsion reste bornee', () => {
    const p = m.doorActionPlan({ door: {}, remote: remote(), actuator: lock({ actions: { unlock: { minS: 1, maxS: 3 }, lock: {} } }) });
    assert.equal(p.minutes?.ok, false);
    assert.match(p.minutes?.reason ?? '', /3 s/);
    assert.equal(p.buttons[0].durationS, 3);
  });

  it('barriere / portail : Ouvrir, Fermer, Arreter (arret = action sure) selon les droits', () => {
    const p = m.doorActionPlan({ door: {}, remote: remote('gate'), actuator: gate() });
    assert.deepEqual(keys(p), ['open', 'close', 'stop']);
    assert.deepEqual(p.buttons.map((b) => b.safe), [false, false, true]);
    assert.equal(p.minutes, null);
    const partial = m.doorActionPlan({ door: {}, remote: remote('gate'), actuator: gate({ allowed: ['stop'] }) });
    assert.deepEqual(keys(partial), ['stop']);
  });

  it('droits : un compte sans action permise voit un message clair et aucun bouton', () => {
    for (const actuator of [lock({ allowed: [] }), null]) {
      const p = m.doorActionPlan({ door: {}, remote: remote(), actuator });
      assert.equal(p.state, 'not_allowed');
      assert.equal(p.buttons.length, 0);
      assert.match(p.message ?? '', /pas le droit/);
    }
    const onlyLock = m.doorActionPlan({ door: {}, remote: remote(), actuator: lock({ allowed: ['lock'] }) });
    assert.deepEqual(keys(onlyLock), ['lock']);
    assert.equal(onlyLock.minutes, null);
  });

  it('remote.available faux : aucun bouton, la raison du serveur est affichee', () => {
    const p = m.doorActionPlan({ door: {}, remote: { available: false, reason: 'Aucun actionneur n’est lié à cette porte' }, actuator: lock() });
    assert.equal(p.state, 'unavailable');
    assert.equal(p.message, 'Aucun actionneur n’est lié à cette porte');
    assert.equal(p.buttons.length, 0);
    assert.match(m.doorActionPlan({ door: {}, remote: null, actuator: null }).message ?? '', /pas disponible/);
  });

  it('maintenance, actionneur inactif, liaison coupee : boutons presents mais bloques avec le motif', () => {
    const maint = m.doorActionPlan({ door: {}, remote: remote(), actuator: lock(), maintenance: true });
    assert.match(maint.blocked ?? '', /maintenance/);
    assert.match(m.doorActionPlan({ door: {}, remote: remote(), actuator: lock({ active: false }) }).blocked ?? '', /désactivé/);
    assert.match(m.doorActionPlan({ door: {}, remote: remote(), actuator: lock({ linkUp: false }) }).blocked ?? '', /Liaison coupée/);
    assert.equal(m.doorActionPlan({ door: {}, remote: remote(), actuator: lock({ linkUp: null }) }).blocked, null);
    assert.ok(maint.buttons.length > 0);
  });
});

describe('liaison porte <-> actionneur (administrateur)', () => {
  const act = (id: string, type: string, emergencyExit = false) => ({ id, type, emergencyExit });
  const actuators = [act('g1', 'lock'), act('g2', 'lock'), act('s1', 'lock', true), act('p1', 'gate'), act('sir', 'siren')];
  const ids = (door: unknown, doors: unknown[] = []) => m.compatibleActuators({ door, actuators, doors }).map((a) => a.id);

  it('genre de porte -> type d’actionneur', () => {
    assert.equal(m.actuatorTypeForKind('door'), 'lock');
    for (const k of ['gate', 'barrier', 'turnstile']) assert.equal(m.actuatorTypeForKind(k), 'gate');
    assert.equal(m.actuatorTypeForKind('autre'), null);
  });

  it('seuls les actionneurs de type coherent, de meme issue de secours et libres sont proposes', () => {
    assert.deepEqual(ids({ detectorId: 'd1', kind: 'door', emergencyExit: false }), ['g1', 'g2']);
    assert.deepEqual(ids({ detectorId: 'd1', kind: 'door', emergencyExit: true }), ['s1']);
    assert.deepEqual(ids({ detectorId: 'd1', kind: 'barrier', emergencyExit: false }), ['p1']);
    assert.deepEqual(ids({ detectorId: 'd1', kind: 'door', emergencyExit: false }, [{ detectorId: 'd2', actuatorId: 'g1' }]), ['g2']);
    // l’actionneur de CETTE porte reste proposable
    assert.deepEqual(ids({ detectorId: 'd1', kind: 'door', emergencyExit: false }, [{ detectorId: 'd1', actuatorId: 'g1' }]), ['g1', 'g2']);
    assert.deepEqual(ids({ detectorId: 'd1', kind: 'inconnu' }), []);
  });

  it('le bloc est reserve a l’administrateur, visible aussi sans actionneur lie', () => {
    const src = read('dooractions.js');
    assert.match(src, /const isAdmin = core\.S\.me\?\.role === 'admin'/);
    assert.match(src, /if \(isAdmin\) \{[\s\S]*?Actionneur lié/);
    assert.match(read('dooractions.css'), /.dooract-link/);
  });
});

describe('composant porte : durees, mode de porte, etat des commandes', () => {
  it('impulsion = min(5 s, maxS) et jamais sous le minimum', () => {
    assert.equal(m.pulseDurationS({ minS: 1, maxS: 600 }), 5);
    assert.equal(m.pulseDurationS({ minS: 1, maxS: 2 }), 2);
    assert.equal(m.pulseDurationS({ minS: 8, maxS: 60 }), 8);
    assert.equal(m.pulseDurationS({}), null);
  });

  it('minutes -> secondes bornees par maxS (secondes dans l’API)', () => {
    const cfg = { minS: 1, maxS: 600 };
    assert.equal(m.minutesToSeconds(3, cfg), 180);
    assert.equal(m.minutesToSeconds('10', cfg), 600);
    assert.equal(m.minutesToSeconds(11, cfg), null);
    assert.equal(m.minutesToSeconds(0, cfg), null);
    assert.equal(m.minutesToSeconds(1.5, cfg), null);
    assert.equal(m.minutesToSeconds('', cfg), null);
    assert.equal(m.minutesToSeconds(1, { maxS: 59 }), null);
    assert.equal(m.minutesToSeconds(1, { maxS: 60 }), 60);
    assert.equal(m.minutesLabel(1), 'Ouvrir 1 minute');
    assert.equal(m.minutesLabel(5), 'Ouvrir 5 minutes');
  });

  it('mode de porte : libelle du serveur, repli par valeur, « non communique » sinon', () => {
    assert.deepEqual(m.doorModeText({ doorMode: null, doorModeLabel: null, doorModeAt: null }), { known: false, text: 'Mode de la porte : non communiqué par le contrôleur', at: null });
    assert.equal(m.doorModeText({}).known, false);
    const open = m.doorModeText({ doorMode: 'always_open', doorModeLabel: 'Ouverte en permanence (réglée dans le contrôleur)', doorModeAt: 1000 });
    assert.equal(open.text, 'Ouverte en permanence (réglée dans le contrôleur)');
    assert.equal(open.at, 1000);
    assert.equal(m.doorModeText({ doorMode: 'normal' }).text, 'Mode normal : les badges fonctionnent');
    assert.equal(m.doorModeText({ doorMode: 'always_closed' }).text, 'Verrouillée en permanence (réglée dans le contrôleur)');
  });

  it('etat d’une commande : jamais « fait » sans accuse, echec et accuse tardif visibles', () => {
    assert.equal(m.commandStateText({ state: 'sent' }), 'Envoyée — accusé attendu');
    assert.equal(m.commandStateText({ state: 'acked' }), 'Accusée par l’équipement');
    assert.match(m.commandStateText({ state: 'acked', ackKind: 'http' }), /non confirmée/);
    assert.equal(m.commandStateText({ state: 'failed', ack: 'verrou bloque' }), 'Échec : verrou bloque');
    assert.match(m.commandStateText({ state: 'failed', uncertain: true }), /a pu être exécuté/);
    assert.match(m.commandStateText({ state: 'failed', lateAck: 'ok' }), /accusé tardif « ok »/);
    assert.equal(m.commandTone({ state: 'acked' }), 'is-ok');
    assert.equal(m.commandTone({ state: 'failed' }), 'is-alarm');
    assert.equal(m.commandTone({ state: 'sent' }), 'is-warning');
  });
});

describe('« Tout ouvrir » : confirmations, etat porte par porte, bilan', () => {
  it('la phrase TOUT OUVRIR doit etre saisie telle quelle et le message de securite est affiche', () => {
    assert.equal(m.evacuationPhraseOk('TOUT OUVRIR'), true);
    assert.equal(m.evacuationPhraseOk('  TOUT OUVRIR '), true);
    assert.equal(m.evacuationPhraseOk('tout ouvrir'), false);
    assert.equal(m.evacuationPhraseOk('TOUT'), false);
    assert.equal(m.evacuationPhraseOk(undefined), false);
    assert.match(m.EVACUATION_WARNING, /^Cela ne remplace jamais le déverrouillage matériel par la centrale incendie\. Les issues de secours doivent s’ouvrir par ce dispositif matériel\.$/);
  });

  it('corps du POST : raison, phrase et mot de passe obligatoires ; confirm: true', () => {
    const bad = m.evacuationPayload({ reason: ' ', phrase: 'non', password: '' });
    assert.equal(bad.ok, false);
    assert.equal(bad.missing?.length, 3);
    const ok = m.evacuationPayload({ reason: ' exercice ', phrase: 'TOUT OUVRIR', password: 'x' });
    assert.deepEqual(ok.body, { reason: 'exercice', password: 'x', confirm: true, confirmPhrase: 'TOUT OUVRIR' });
  });

  it('apercu : portes pretes et non pretes', () => {
    const p = m.evacuationPreview([{ ready: true }, { ready: false, problem: 'liaison coupée' }, { ready: true }]);
    assert.deepEqual([p.total, p.ready, p.notReady.length, p.canGo], [3, 2, 1, true]);
    assert.equal(m.evacuationPreview([{ ready: false }]).canGo, false);
    assert.equal(m.evacuationPreview(undefined).total, 0);
  });

  it('etat d’une porte : seul un accuse compte comme ouverte', () => {
    const sent = { status: 'sent', cmdId: 'c1', durationS: 300 };
    assert.equal(m.evacuationRowState(sent, null).open, false);
    assert.equal(m.evacuationRowState(sent, null).detail, 'Envoyée — accusé attendu');
    assert.equal(m.evacuationRowState(sent, { state: 'sent' }).open, false);
    assert.equal(m.evacuationRowState(sent, { state: 'pending' }).final, false);
    const acked = m.evacuationRowState(sent, { state: 'acked' });
    assert.deepEqual([acked.key, acked.open, acked.final], ['acked', true, true]);
    const failed = m.evacuationRowState(sent, { state: 'failed', ack: 'bloquée' });
    assert.deepEqual([failed.key, failed.open], ['failed', false]);
    assert.match(failed.detail, /bloquée/);
    for (const status of ['no_gateway', 'refused', 'error']) {
      const s = m.evacuationRowState({ status, error: 'motif X' }, { state: 'acked' }); // un accuse parasite ne change rien
      assert.equal(s.open, false);
      assert.equal(s.final, true);
      assert.match(s.detail, /motif X/);
    }
    assert.equal(m.evacuationRowState({ status: 'no_gateway' }, null).label, 'Sans passerelle');
    assert.equal(m.evacuationRowState({ status: 'mystere' }, null).open, false);
  });

  it('bilan « N portes sur M ouvertes » avec accuses attendus', () => {
    const rows = [
      m.evacuationRowState({ status: 'sent' }, { state: 'acked' }),
      m.evacuationRowState({ status: 'sent' }, { state: 'acked' }),
      m.evacuationRowState({ status: 'sent' }, { state: 'sent' }),
      m.evacuationRowState({ status: 'no_gateway' }, null),
    ];
    const b = m.evacuationBilan(rows);
    assert.equal(b.text, '2 portes sur 4 ouvertes');
    assert.equal(b.pending, 1);
    assert.equal(b.complete, false);
    assert.equal(b.allOpen, false);
    assert.equal(m.evacuationBilan([rows[0]]).text, '1 porte sur 1 ouverte');
    assert.equal(m.evacuationBilan([rows[0]]).allOpen, true);
    assert.equal(m.evacuationBilan([rows[3]]).text, '0 porte sur 1 ouverte');
    assert.equal(m.evacuationBilan([]).allOpen, false);
  });
});

describe('interface : integration et securite du code servi (CSP stricte, route unique des ordres)', () => {
  const dooract = read('dooractions.js');
  const commands = read('commands.js');
  const incidents = read('incidents.js');
  const loadDoorBlock = incidents.match(/function loadDoorBlock[\s\S]*?\n}\n/)?.[0] ?? '';

  it('la feuille de style existe et est chargee par index.html apres les autres', () => {
    const html = read('index.html');
    assert.match(html, /<link rel="stylesheet" href="dooractions\.css">/);
    assert.ok(html.indexOf('dooractions.css') > html.indexOf('agents-admin.css'));
    const css = read('dooractions.css');
    assert.match(css, /\.dooract\b/);
    assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{3,8}\b/, 'aucune couleur en dur');
    assert.match(css, /min-height: var\(--control-h\)/);
    for (const cls of [...css.matchAll(/^\.(dooract[\w-]*)/gm)].map((x) => x[1])) assert.ok(cls.startsWith('dooract'));
  });

  it('dooractions.js : aucun HTML construit, aucun style en ligne, aucun stockage navigateur, aucun import statique', () => {
    assert.doesNotMatch(dooract, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|eval\(|new Function\(/);
    assert.doesNotMatch(dooract, /setAttribute\(\s*['"]style['"]|\.style\.|\bstyle=\s*["']/);
    assert.doesNotMatch(dooract, /\bon(click|error|load)=/i);
    assert.doesNotMatch(dooract, /localStorage|sessionStorage|indexedDB|console\.(log|info|debug)/);
    assert.deepEqual([...dooract.matchAll(/^import .* from '([^']+)';/gm)], []);
  });

  it('les ordres passent uniquement par /api/actuators/:id/commands ; “Tout ouvrir” par /api/access/evacuation', () => {
    assert.doesNotMatch(dooract.replace(/\/\*[\s\S]*?\*\//g, ''), /\/commands(?!\.js)|\/api\/actuators/);
    const sends = [...commands.matchAll(/method: 'POST',\n\s+body: \{ action,/g)];
    assert.equal(sends.length, 1, 'un seul envoi d’ordre, partage');
    assert.match(commands, /async function sendCommand[\s\S]*?\/api\/actuators\/\$\{encodeURIComponent\(a\.id\)\}\/commands/);
    const routes = [...dooract.matchAll(/api\(\s*['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
    // Lecture de la fiche de la porte (GET, remplissage de l'emplacement de l'ecran Acces) et « Tout ouvrir » : aucun ordre ici.
    assert.deepEqual([...new Set(routes)].sort(), ['/api/access/doors', '/api/access/doors/${encodeURIComponent(door.detectorId)}', '/api/access/evacuation']);
    // Liaison porte <-> actionneur : PUT /api/access/doors/:id { actuatorId } (sans mot de passe), jamais une autre ecriture
    assert.match(dooract, /method: 'PUT', body: { actuatorId }/);
    assert.deepEqual([...dooract.matchAll(/method: '(\w+)'/g)].map((x) => x[1]).sort(), ['POST', 'PUT']);
    assert.doesNotMatch(dooract + loadDoorBlock, /mqtt|publish\(/i);
  });

  it('commands.js exporte les moyens du composant et place « Tout ouvrir » dans la barre de l’administration', () => {
    for (const name of ['openPanel', 'commandAction', 'listActuators', 'liveCommand', 'watchCommands', 'commandsButton']) assert.match(commands, new RegExp(`export (async )?(function|const) ${name}\\b`));
    assert.match(commands, /focusActuatorId/);
    const admin = commands.slice(commands.indexOf('export async function loadActuatorsAdmin'));
    assert.match(admin, /evacuationButton\(\)/);
    assert.match(commands, /import \{ evacuationButton \} from '\.\/dooractions\.js'/);
    assert.equal(typeof m.evacuationButton, 'function');
    assert.equal(typeof m.doorActions, 'function');
  });

  it('la fiche d’un incident d’acces charge la porte a la demande, sans bloc pour un incident clos, et garde le bouton Commandes', () => {
    assert.match(incidents, /import \{ doorActions \} from '\.\/dooractions\.js'/);
    assert.match(loadDoorBlock, /category !== 'access' \|\| incident\.status === 'closed'/);
    assert.match(loadDoorBlock, /\/api\/access\/doors\//);
    assert.match(loadDoorBlock, /incidentId: incident\.id/);
    assert.match(loadDoorBlock, /\.catch\(/);
    assert.match(incidents, /commandsButton\(current, \(\) => \(\{ focusActuatorId: refs\.doorActuatorId \}\)\)/);
    assert.match(incidents, /loadDoorBlock\(card, incident, expanded\)/);
  });

  it('aucun appel reseau direct hors core.js `api` dans les fichiers du lot', () => {
    for (const src of [dooract, commands, incidents]) assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|EventSource\(|WebSocket\(/);
  });

  it('la fiche de porte de l’ecran Acces est remplie par l’evenement psim:door-card (access.js n’importe rien)', () => {
    assert.match(dooract, /addEventListener\('psim:door-card'/);
    assert.match(dooract, /export async function fillDoorCard\(slot, door\)/);
    assert.match(dooract, /typeof document !== 'undefined'/);
    assert.match(dooract, /\/api\/access\/doors\//);
    assert.doesNotMatch(read('access.js'), /dooractions/);
  });
});
