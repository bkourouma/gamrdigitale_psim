/**
 * Écran « Accès » (web/access.js, web/access.css, lot AC3) : l'interface est testée comme le reste du web statique.
 *  1. les fonctions PURES de access.js (dates, filtres et chaîne de requête, pile de curseurs, sous-route, tri des portes,
 *     formulaires de déclaration) sont exécutées telles quelles : le fichier s'importe sans navigateur ;
 *  2. les fichiers servis sont lus pour les garde-fous (CSP : aucun style en ligne ni HTML construit ; icônes du sprite ;
 *     classes de la feuille de style ; branchement dans index.html et app.js) ;
 *  3. la vue est exécutée contre un DOM minimal fait pour ce test : l'écran se construit, charge, trie, ouvre la fiche,
 *     se ferme à Échap, déclare un contrôleur, arrête ses flux à la sortie. Ce DOM n'est pas un navigateur : il attrape
 *     les erreurs d'exécution (références nulles, mauvais appels), pas la mise en page (à vérifier dans le navigateur).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { HOST_PATTERN as SERVER_HOST_PATTERN } from '../server/video.ts';

const WEB = join(import.meta.dirname, '..', 'web');
// Fins de ligne normalisées : le dépôt est extrait en CRLF sous Windows (core.autocrlf).
const read = (file: string) => readFileSync(join(WEB, file), 'utf8').replace(/\r\n/g, '\n');

// ================================================================================================ types

interface Problem {
  field: string;
  message: string;
}
interface Filters {
  from: string;
  to: string;
  door: string;
  holder: string;
  credential: string;
  result: string;
  late: boolean;
}
interface Door {
  detectorId: string;
  name?: string;
  state?: string;
  deviceStatus?: string;
  [key: string]: unknown;
}
interface Stack {
  readonly current: string | null;
  readonly next: string | null;
  readonly depth: number;
  setNext: (cursor: unknown) => void;
  canOlder: () => boolean;
  canNewer: () => boolean;
  older: () => string | null;
  newer: () => string | null;
  reset: () => void;
}
interface Route {
  tab: string | null;
  doorId: string | null;
  filters: { door?: string; result?: string; late?: boolean };
}
interface ControllerForm {
  id: string;
  name: string;
  brand: string;
  model: string;
  host: string;
  gatewayId: string;
  username: string;
  password: string;
}
interface DoorForm {
  detectorId: string;
  controllerId: string;
  doorNo: string;
  kind: string;
  emergencyExit: boolean;
  heldMinutes: string;
}
interface View {
  show: (container: unknown, sub?: string) => Promise<void>;
  hide: () => void;
  openDoor: (id: string) => void;
  reset: () => void;
}
interface Access {
  PAGE_SIZE: number;
  HELD_DEFAULT_S: number;
  TABS: { id: string; label: string; icon: string; admin?: boolean }[];
  PRESETS: { id: string; label: string }[];
  DOOR_ORDER: string[];
  STATE_HINT: Record<string, string>;
  HOST_PATTERN: RegExp;
  ID_PATTERN: RegExp;
  EXPORT_TRUNCATED_TEXT: string;
  JOURNAL_NOTE: string;
  REMOTE_UNAVAILABLE_TEXT: string;
  UNDECLARED_TEXT: string;
  dayStart: (ts: number, offset?: number) => number;
  formatClock: (ts: unknown) => string;
  formatClockSeconds: (ts: unknown) => string;
  formatDate: (ts: unknown) => string;
  dayWord: (ts: number, now: number) => string;
  formatWhen: (ts: unknown, now: number, o?: { seconds?: boolean }) => string;
  passageStamp: (ts: unknown, now: number) => { day: string; time: string };
  toInputValue: (ts: unknown) => string;
  fromInputValue: (text: unknown) => number | null;
  quickRange: (id: string, now: number) => { from: string; to: string } | null;
  matchPreset: (filters: { from: string; to: string }, now: number) => string | null;
  durationText: (ms: number) => string;
  formatInt: (n: unknown) => string;
  plural: (n: number, one: string, many?: string) => string;
  totalText: (total: unknown, capped?: boolean) => string;
  rangeText: (page: number, limit: number, count: number, total: unknown, capped?: boolean) => string;
  directionLabel: (d: unknown) => string;
  holderLine: (p: unknown) => string;
  badgeLine: (p: unknown) => string;
  resultLabelOf: (p: unknown) => string;
  resultTone: (p: unknown) => string;
  lastPassageSentence: (p: unknown, now: number) => string;
  kindLabel: (k: unknown) => string;
  brandLabel: (b: unknown) => string;
  doorPlaceText: (door: unknown, floor?: string) => string;
  videoNoteText: (ts: unknown, now: number) => string;
  remoteSlotText: (remote: unknown) => string;
  defaultFilters: (now: number) => Filters;
  hasNarrowingFilter: (f: Filters) => boolean;
  hasPersonalFilter: (f: Filters) => boolean;
  filterProblems: (f: Filters) => Problem[];
  buildEventsQuery: (f: Filters, o?: { limit?: number | null; cursor?: string | null; count?: boolean }) => string;
  createCursorStack: () => Stack;
  exportFileName: (now: number) => string;
  fileNameFromDisposition: (header: unknown) => string | null;
  exportDoneText: (rows: number, truncated: boolean) => string;
  parseRoute: (sub: unknown) => Route;
  buildRoute: (r: { tab: string; doorId?: string | null; filters?: Partial<Filters> | null }) => string;
  doorRank: (d: unknown) => number;
  sortDoors: (doors: Door[]) => Door[];
  doorsSummary: (doors: Door[]) => string;
  doorsNeedingAttention: (doors: Door[]) => number;
  undeclaredAccessDetectors: (devices: unknown[], doors: Door[] | Map<string, Door>) => { id: string; name: string; zone: string }[];
  secondsText: (s: unknown) => string;
  parseHeldDelay: (text: unknown) => { ok: true; seconds: number } | { ok: false; message: string };
  minutesInput: (s: unknown) => string;
  clockOffsetInfo: (ms: unknown) => { tone: string; warn: boolean; text: string; hint: string };
  emptyControllerForm: () => ControllerForm;
  controllerFormFrom: (c: Record<string, unknown>) => ControllerForm;
  controllerProblems: (f: ControllerForm, o?: { editing?: boolean }) => Problem[];
  controllerBody: (f: ControllerForm, o?: { editing?: boolean; original?: Record<string, unknown> | null }) => Record<string, unknown>;
  emptyDoorForm: () => DoorForm;
  doorFormFrom: (d: Record<string, unknown>) => DoorForm;
  doorProblems: (f: DoorForm, o?: { editing?: boolean; controllerIds?: string[] | null }) => Problem[];
  doorBody: (f: DoorForm, o?: { editing?: boolean; original?: Record<string, unknown> | null }) => Record<string, unknown>;
  parseRetention: (text: unknown) => { ok: true; days: number } | { ok: false; message: string };
  lastPurgeText: (purge: unknown, now: number) => string;
  createAccessView: (deps: Record<string, unknown>) => View;
}
const A = (await import(pathToFileURL(join(WEB, 'access.js')).href)) as Access;

/** 17 octobre 2026, 14:32:05, heure locale (les dates de l'écran sont locales). */
const NOW = new Date(2026, 9, 17, 14, 32, 5).getTime();
const at = (y: number, mo: number, d: number, hh = 0, mi = 0, ss = 0) => new Date(y, mo - 1, d, hh, mi, ss).getTime();

// ================================================================================================ dates et nombres

describe('écran « Accès » : dates, heures et nombres', () => {
  it('heure, date et « quand » en français courant', () => {
    assert.equal(A.formatClock(NOW), '14:32');
    assert.equal(A.formatClockSeconds(NOW), '14:32:05');
    assert.equal(A.formatDate(NOW), '17/10/2026');
    assert.equal(A.formatClock(at(2026, 1, 2, 7, 5)), '07:05', 'zéro devant');
    assert.equal(A.formatWhen(NOW, NOW), 'aujourd’hui à 14:32');
    assert.equal(A.formatWhen(at(2026, 10, 16, 8, 10), NOW), 'hier à 08:10');
    assert.equal(A.formatWhen(at(2026, 10, 12, 17, 5), NOW), 'le 12/10/2026 à 17:05');
    assert.equal(A.formatWhen(NOW, NOW, { seconds: true }), 'aujourd’hui à 14:32:05');
    assert.equal(A.dayWord(at(2026, 10, 17, 0, 0, 1), at(2026, 10, 17, 23, 59, 59)), 'aujourd’hui', 'même jour, aux extrémités');
    assert.equal(A.dayWord(at(2026, 10, 16, 23, 59, 59), at(2026, 10, 17, 0, 0, 1)), 'hier', 'minuit passé de deux secondes');
  });

  it('une date absente ou folle ne casse rien : texte vide', () => {
    for (const bad of [null, undefined, Number.NaN, 'abc', Number.POSITIVE_INFINITY, 8.64e15 * 2]) {
      assert.equal(A.formatClock(bad), '');
      assert.equal(A.formatClockSeconds(bad), '');
      assert.equal(A.formatDate(bad), '');
      assert.equal(A.formatWhen(bad, NOW), '');
      assert.equal(A.toInputValue(bad), '');
      assert.deepEqual(A.passageStamp(bad, NOW), { day: '', time: '' });
    }
  });

  it('un passage : l’heure d’un côté, le jour de l’autre', () => {
    assert.deepEqual(A.passageStamp(NOW, NOW), { day: 'Aujourd’hui', time: '14:32:05' });
    assert.deepEqual(A.passageStamp(at(2026, 10, 16, 22, 1, 9), NOW), { day: 'Hier', time: '22:01:09' });
    assert.deepEqual(A.passageStamp(at(2026, 9, 3, 6, 0, 0), NOW), { day: '03/09/2026', time: '06:00:00' });
  });

  it('champ date + heure : aller-retour exact, dates impossibles refusées', () => {
    assert.equal(A.toInputValue(NOW), '2026-10-17T14:32');
    assert.equal(A.fromInputValue('2026-10-17T14:32'), at(2026, 10, 17, 14, 32));
    assert.equal(A.fromInputValue('2026-10-17T14:32:30'), at(2026, 10, 17, 14, 32, 30), 'avec secondes');
    assert.equal(A.fromInputValue(A.toInputValue(NOW)), at(2026, 10, 17, 14, 32));
    for (const bad of ['', null, undefined, 'hier', '2026-02-30T10:00', '2026-13-01T10:00', '2026-10-17T25:00', '2026-10-17 14:32', '17/10/2026', '2026-10-17T14:60']) {
      assert.equal(A.fromInputValue(bad), null, String(bad));
    }
    assert.equal(A.fromInputValue('2028-02-29T00:00'), at(2028, 2, 29), 'année bissextile');
    assert.equal(A.fromInputValue('2026-02-29T00:00'), null, 'pas bissextile');
  });

  it('raccourcis de période : jour entier, « Au » inclus à la minute près', () => {
    assert.deepEqual(A.quickRange('today', NOW), { from: '2026-10-17T00:00', to: '2026-10-17T23:59' });
    assert.deepEqual(A.quickRange('yesterday', NOW), { from: '2026-10-16T00:00', to: '2026-10-16T23:59' });
    assert.deepEqual(A.quickRange('week', NOW), { from: '2026-10-11T00:00', to: '2026-10-17T23:59' });
    assert.equal(A.quickRange('mois', NOW), null);
    assert.deepEqual(A.PRESETS.map((p) => p.label), ['Aujourd’hui', 'Hier', '7 derniers jours']);
  });

  it('un raccourci reste « enfoncé » tant que les dates collent, et le suit au changement de jour', () => {
    assert.equal(A.matchPreset(A.quickRange('today', NOW)!, NOW), 'today');
    assert.equal(A.matchPreset(A.quickRange('week', NOW)!, NOW), 'week');
    assert.equal(A.matchPreset({ from: '2026-10-17T00:00', to: '2026-10-17T18:00' }, NOW), null, 'dates saisies à la main');
    assert.equal(A.matchPreset(A.quickRange('today', NOW)!, NOW + 86_400_000), 'yesterday', 'le lendemain, ces mêmes dates sont « Hier »');
    assert.equal(A.matchPreset(A.quickRange('week', NOW)!, NOW + 86_400_000), null, 'et les 7 jours ne collent plus à aucun raccourci');
  });

  it('les raccourcis restent justes autour d’un changement d’heure', () => {
    // Nuit du 25 au 26 octobre 2026 en Europe : jour de 25 h. Les bornes restent minuit local.
    const day = at(2026, 10, 25, 12);
    assert.equal(A.toInputValue(A.dayStart(day)), '2026-10-25T00:00');
    assert.equal(A.toInputValue(A.dayStart(day, 1)), '2026-10-26T00:00');
    assert.equal(A.toInputValue(A.dayStart(day, -1)), '2026-10-24T00:00');
  });

  it('durées lisibles', () => {
    assert.equal(A.durationText(45_000), '45 s');
    assert.equal(A.durationText(72_000), '1 min 12 s');
    assert.equal(A.durationText(120_000), '2 min');
    assert.equal(A.durationText(7_500_000), '2 h 05 min');
    assert.equal(A.durationText(-5), '0 s');
  });

  it('entiers avec espace insécable, pluriels et totaux', () => {
    assert.equal(A.formatInt(1234), '1\u00a0234');
    assert.equal(A.formatInt(1234567), '1\u00a0234\u00a0567');
    assert.equal(A.formatInt(0), '0');
    assert.equal(A.formatInt(-1500), '-1\u00a0500');
    assert.equal(A.formatInt('abc'), '');
    assert.equal(A.plural(1, 'porte'), '1 porte');
    assert.equal(A.plural(2, 'porte'), '2 portes');
    assert.equal(A.plural(0, 'porte'), '0 porte', 'zéro est singulier en français');
    assert.equal(A.totalText(1234), '1\u00a0234 passages');
    assert.equal(A.totalText(10_000, true), 'plus de 10\u00a0000 passages');
    assert.equal(A.totalText(0), 'Aucun passage');
    assert.equal(A.totalText(1), '1 passage');
    assert.equal(A.totalText(null), '');
    assert.equal(A.totalText(-3), '');
    assert.equal(A.rangeText(0, 50, 50, 1234), 'Passages 1 à 50 sur 1\u00a0234');
    assert.equal(A.rangeText(2, 50, 12, 112), 'Passages 101 à 112 sur 112');
    assert.equal(A.rangeText(1, 50, 50, 10_000, true), 'Passages 51 à 100 sur plus de 10\u00a0000');
    assert.equal(A.rangeText(0, 50, 7, null), 'Passages 1 à 7');
    assert.equal(A.rangeText(0, 50, 0, 0), '');
  });
});

// ================================================================================================ passages

describe('écran « Accès » : libellés d’un passage', () => {
  const granted = { id: 1, doorId: 'P1', atDevice: NOW, holderName: 'KONAN Yao', credential: '0012345', result: 'granted', resultLabel: 'Accepté', methodLabel: 'Badge', direction: 'in' };
  const denied = { id: 2, doorId: 'P1', atDevice: NOW - 3_600_000, holderName: null, credential: '0099', result: 'denied', resultLabel: 'Refusé — badge expiré', direction: 'out' };

  it('titulaire, badge, sens et résultat en clair', () => {
    assert.equal(A.holderLine(granted), 'KONAN Yao');
    assert.equal(A.holderLine(denied), 'Titulaire inconnu');
    assert.equal(A.holderLine({ holderName: '   ' }), 'Titulaire inconnu');
    assert.equal(A.holderLine(null), 'Titulaire inconnu');
    assert.equal(A.badgeLine(granted), 'Badge 0012345');
    assert.equal(A.badgeLine({ credential: null }), '');
    assert.equal(A.directionLabel('in'), 'Entrée');
    assert.equal(A.directionLabel('out'), 'Sortie');
    assert.equal(A.directionLabel(null), 'Non précisé');
    assert.equal(A.resultLabelOf(denied), 'Refusé — badge expiré', 'le libellé du serveur, sans le réécrire');
    assert.equal(A.resultLabelOf({ result: 'granted' }), 'Accepté', 'mot de secours');
    assert.equal(A.resultLabelOf({ result: 'denied', resultLabel: '  ' }), 'Refusé');
    assert.equal(A.resultTone(granted), 'ok');
    assert.equal(A.resultTone(denied), 'warning');
  });

  it('dernier passage d’une porte en une phrase', () => {
    assert.equal(A.lastPassageSentence(granted, NOW), 'KONAN Yao — Accepté, aujourd’hui à 14:32');
    assert.equal(A.lastPassageSentence({ ...denied, atDevice: at(2026, 10, 16, 18, 2) }, NOW), 'Titulaire inconnu — Refusé — badge expiré, hier à 18:02');
    assert.equal(A.lastPassageSentence(null, NOW), '');
  });

  it('un nom ou un badge hostile reste un texte : rien n’est transformé', () => {
    const hostile = { holderName: '<img src=x onerror=alert(1)>', credential: '"><script>x</script>' };
    assert.equal(A.holderLine(hostile), '<img src=x onerror=alert(1)>');
    assert.equal(A.badgeLine(hostile), 'Badge "><script>x</script>');
  });

  it('« Voir la vidéo » dit toujours que l’image est en direct, pas l’enregistrement', () => {
    assert.equal(A.videoNoteText(NOW, NOW), 'Image en direct, pas l’enregistrement de 14:32.');
    assert.equal(A.videoNoteText(at(2026, 10, 12, 9, 5), NOW), 'Image en direct, pas l’enregistrement du 12/10/2026 à 09:05.');
    assert.equal(A.videoNoteText(null, NOW), 'Image en direct, pas l’enregistrement du passage.');
  });

  it('type, marque, lieu', () => {
    assert.equal(A.kindLabel('gate'), 'Portail');
    assert.equal(A.kindLabel('turnstile'), 'Tourniquet');
    assert.equal(A.kindLabel('autre'), 'Porte');
    assert.equal(A.brandLabel('zkteco'), 'ZKTeco');
    assert.equal(A.brandLabel('relay'), 'Contact sec (relais IP)');
    assert.equal(A.brandLabel('inconnue'), 'inconnue');
    assert.equal(A.doorPlaceText({ zone: 'Rez-de-chaussée' }), 'Rez-de-chaussée');
    assert.equal(A.doorPlaceText({ zone: 'Hall' }, 'Étage 1'), 'Hall · Étage 1');
    assert.equal(A.doorPlaceText({ zone: '  ' }), 'Zone non renseignée');
    assert.equal(A.doorPlaceText(null), 'Zone non renseignée');
  });
});

// ================================================================================================ filtres et requête

describe('écran « Accès » : filtres du journal et chaîne de requête', () => {
  const base = (over: Partial<Filters> = {}): Filters => ({ from: '', to: '', door: '', holder: '', credential: '', result: '', late: false, ...over });

  it('par défaut : aujourd’hui, tous les passages', () => {
    assert.deepEqual(A.defaultFilters(NOW), { from: '2026-10-17T00:00', to: '2026-10-17T23:59', door: '', holder: '', credential: '', result: '', late: false });
    assert.equal(A.hasNarrowingFilter(A.defaultFilters(NOW)), false);
    assert.equal(A.hasNarrowingFilter(base({ door: 'P1' })), true);
    assert.equal(A.hasNarrowingFilter(base({ late: true })), true);
    assert.equal(A.hasNarrowingFilter(base({ holder: ' ' })), false, 'des espaces ne filtrent rien');
    assert.equal(A.hasPersonalFilter(base({ holder: 'Konan' })), true);
    assert.equal(A.hasPersonalFilter(base({ credential: '00' })), true);
    assert.equal(A.hasPersonalFilter(base({ door: 'P1', result: 'denied' })), false);
  });

  it('sans filtre : requête vide ; « Au » est inclus (le serveur exclut sa borne, on envoie la minute suivante)', () => {
    assert.equal(A.buildEventsQuery(base()), '');
    const q = new URLSearchParams(A.buildEventsQuery(A.defaultFilters(NOW)));
    assert.equal(q.get('from'), String(at(2026, 10, 17, 0, 0)));
    assert.equal(q.get('to'), String(at(2026, 10, 18, 0, 0)), '23:59 inclus = 00:00 du lendemain exclu');
  });

  it('tous les filtres, dans un ordre stable', () => {
    const f = base({ from: '2026-10-11T08:00', to: '2026-10-17T18:30', door: 'P-ENTREE', holder: 'konan', credential: '0012', result: 'denied', late: true });
    const query = A.buildEventsQuery(f, { limit: 50, cursor: '1760000000000:98765', count: true });
    assert.equal(
      query,
      `from=${at(2026, 10, 11, 8, 0)}&to=${at(2026, 10, 17, 18, 31)}&door=P-ENTREE&holder=konan&credential=0012&result=denied&late=1&limit=50&cursor=1760000000000%3A98765&count=1`,
    );
  });

  it('l’export reprend les mêmes filtres, sans pagination ni total', () => {
    const f = base({ door: 'P1', result: 'granted' });
    assert.equal(A.buildEventsQuery(f), 'door=P1&result=granted');
    assert.ok(!/limit|cursor|count/.test(A.buildEventsQuery(f)));
  });

  it('texte nettoyé, borné, encodé ; une valeur invalide n’est jamais envoyée', () => {
    const q = new URLSearchParams(A.buildEventsQuery(base({ holder: `  ${'x'.repeat(100)}  `, credential: ' 00 12 ' })));
    assert.equal(q.get('holder')?.length, 64, 'borné à 64 comme le serveur');
    assert.equal(q.get('credential'), '00 12');
    assert.match(A.buildEventsQuery(base({ holder: 'D’Almeida & fils=1' })), /holder=D%E2%80%99Almeida\+%26\+fils%3D1/, 'encodé : rien ne s’échappe du paramètre');
    assert.equal(A.buildEventsQuery(base({ door: '../etc' })), '', 'porte invalide ignorée');
    assert.equal(A.buildEventsQuery(base({ result: 'tout' })), '');
    assert.equal(A.buildEventsQuery(base({ from: 'n’importe quoi' })), '');
    assert.equal(A.buildEventsQuery(base(), { limit: 500 }), '', 'limite hors 1 à 200 ignorée');
    assert.equal(A.buildEventsQuery(base(), { limit: 0 }), '');
    assert.equal(A.buildEventsQuery(base(), { limit: 200 }), 'limit=200');
    assert.equal(A.buildEventsQuery(base(), { cursor: '' }), '');
  });

  it('ce qui empêche la recherche est dit en mots simples', () => {
    assert.deepEqual(A.filterProblems(A.defaultFilters(NOW)), []);
    assert.deepEqual(A.filterProblems(base()), [], 'tout vide est permis');
    const reversed = A.filterProblems(base({ from: '2026-10-17T18:00', to: '2026-10-17T08:00' }));
    assert.equal(reversed.length, 1);
    assert.equal(reversed[0].field, 'from');
    assert.match(reversed[0].message, /début est après la date de fin/);
    assert.deepEqual(A.filterProblems(base({ from: '2026-10-17T08:00', to: '2026-10-17T08:00' })), [], 'une minute exactement est permise');
    assert.equal(A.filterProblems(base({ from: 'x' }))[0].field, 'from');
    assert.equal(A.filterProblems(base({ to: 'x' }))[0].field, 'to');
    assert.equal(A.filterProblems(base({ holder: 'x'.repeat(65) }))[0].field, 'holder');
    assert.equal(A.filterProblems(base({ credential: 'x'.repeat(33) }))[0].field, 'credential');
    assert.equal(A.filterProblems(base({ door: 'a b' }))[0].field, 'door');
    assert.equal(A.filterProblems(base({ result: 'zzz' }))[0].field, 'result');
    assert.equal(A.filterProblems(base({ holder: 'x'.repeat(64), credential: 'y'.repeat(32) })).length, 0, 'les bornes exactes passent');
  });
});

// ================================================================================================ pagination

describe('écran « Accès » : pile des curseurs (Plus récents / Plus anciens)', () => {
  it('on avance avec les curseurs du serveur et on revient avec ceux qu’on a gardés', () => {
    const s = A.createCursorStack();
    assert.equal(s.current, null);
    assert.equal(s.depth, 0);
    assert.equal(s.canOlder(), false);
    assert.equal(s.canNewer(), false);

    s.setNext('c1'); // page 1 chargée : le serveur donne le curseur de la page 2
    assert.equal(s.canOlder(), true);
    assert.equal(s.older(), 'c1');
    assert.equal(s.depth, 1);
    assert.equal(s.canNewer(), true);
    assert.equal(s.canOlder(), false, 'le curseur suivant n’est connu qu’après le chargement de la page');

    s.setNext('c2');
    assert.equal(s.older(), 'c2');
    assert.equal(s.depth, 2);
    s.setNext(null); // dernière page
    assert.equal(s.canOlder(), false);
    assert.equal(s.older(), 'c2', 'rien de plus ancien : on reste');

    assert.equal(s.newer(), 'c1');
    assert.equal(s.depth, 1);
    assert.equal(s.newer(), null, 'retour à la première page');
    assert.equal(s.depth, 0);
    assert.equal(s.newer(), null, 'déjà au début');
    assert.equal(s.canNewer(), false);
  });

  it('nouveaux filtres : retour à la première page', () => {
    const s = A.createCursorStack();
    s.setNext('c1');
    s.older();
    s.setNext('c2');
    s.reset();
    assert.equal(s.current, null);
    assert.equal(s.depth, 0);
    assert.equal(s.canOlder(), false);
    assert.equal(s.canNewer(), false);
  });

  it('un curseur absent ou qui n’est pas du texte n’avance à rien', () => {
    const s = A.createCursorStack();
    for (const bad of [undefined, null, '', 42, {}, ['x']]) {
      s.setNext(bad);
      assert.equal(s.canOlder(), false, JSON.stringify(bad));
    }
  });
});

// ================================================================================================ sous-route

describe('écran « Accès » : sous-route, sans donnée personnelle', () => {
  it('lit les formes prévues', () => {
    assert.deepEqual(A.parseRoute('journal?door=P1'), { tab: 'journal', doorId: null, filters: { door: 'P1' } });
    assert.deepEqual(A.parseRoute('journal?door=P-ENTREE&result=denied&late=1'), { tab: 'journal', doorId: null, filters: { door: 'P-ENTREE', result: 'denied', late: true } });
    assert.deepEqual(A.parseRoute('portes'), { tab: 'portes', doorId: null, filters: {} });
    assert.deepEqual(A.parseRoute('portes/P1'), { tab: 'portes', doorId: 'P1', filters: {} });
    assert.deepEqual(A.parseRoute('porte/P1'), { tab: 'portes', doorId: 'P1', filters: {} }, 'forme au singulier tolérée');
    assert.deepEqual(A.parseRoute('declaration'), { tab: 'declaration', doorId: null, filters: {} });
    assert.deepEqual(A.parseRoute(''), { tab: null, doorId: null, filters: {} });
    assert.deepEqual(A.parseRoute(undefined), { tab: null, doorId: null, filters: {} });
  });

  it('tolère le préfixe de l’adresse complète', () => {
    assert.deepEqual(A.parseRoute('#/acces/journal?door=P1'), { tab: 'journal', doorId: null, filters: { door: 'P1' } });
    assert.deepEqual(A.parseRoute('/acces/portes/P2'), { tab: 'portes', doorId: 'P2', filters: {} });
    assert.deepEqual(A.parseRoute('acces'), { tab: null, doorId: null, filters: {} });
  });

  it('une adresse hostile ou absurde ne donne rien de dangereux', () => {
    for (const bad of ['journal?door=../../etc', 'journal?door=<script>', 'portes/../x', 'portes/a b', 'journal?result=tout', 'journal?late=0', 'journal?door=' + 'x'.repeat(40), '???', '%%%', '\u0000', 'journal?door=%00']) {
      const r = A.parseRoute(bad);
      assert.ok(r.filters.door === undefined || A.ID_PATTERN.test(r.filters.door), bad);
      assert.ok(r.doorId === null || A.ID_PATTERN.test(r.doorId), bad);
      assert.ok(r.filters.result === undefined || ['granted', 'denied'].includes(r.filters.result), bad);
    }
    assert.equal(A.parseRoute('portes/../x').doorId, null);
    assert.equal(A.parseRoute('journal?late=0').filters.late, undefined);
    assert.equal(A.parseRoute({} as unknown).tab, null, 'pas un texte');
  });

  it('l’adresse construite ne porte jamais ni nom ni numéro de badge', () => {
    const f = { door: 'P1', result: 'denied', late: true, holder: 'KONAN Yao', credential: '0012345' };
    const url = A.buildRoute({ tab: 'journal', filters: f });
    assert.equal(url, 'journal?door=P1&result=denied&late=1');
    assert.ok(!/KONAN|Yao|0012345|holder|credential/.test(url));
    assert.equal(A.buildRoute({ tab: 'journal', filters: { holder: 'Konan' } }), 'journal');
    assert.equal(A.buildRoute({ tab: 'journal' }), 'journal');
    assert.equal(A.buildRoute({ tab: 'portes' }), 'portes');
    assert.equal(A.buildRoute({ tab: 'portes', doorId: 'P1' }), 'portes/P1');
    assert.equal(A.buildRoute({ tab: 'portes', doorId: 'P 1' }), 'portes', 'identifiant invalide : pas dans l’adresse');
    assert.equal(A.buildRoute({ tab: 'declaration' }), 'declaration');
  });

  it('aller-retour : ce qu’on écrit se relit à l’identique', () => {
    for (const filters of [{ door: 'P1' }, { result: 'granted' }, { late: true }, { door: 'P-2', result: 'denied', late: true }]) {
      const url = A.buildRoute({ tab: 'journal', filters });
      assert.deepEqual(A.parseRoute(url).filters, filters, url);
    }
    assert.deepEqual(A.parseRoute(A.buildRoute({ tab: 'portes', doorId: 'P-ENTREE' })), { tab: 'portes', doorId: 'P-ENTREE', filters: {} });
  });

  it('onglets : Déclaration réservé à l’administrateur', () => {
    assert.deepEqual(A.TABS.map((t) => t.id), ['journal', 'portes', 'declaration']);
    assert.deepEqual(A.TABS.filter((t) => t.admin).map((t) => t.id), ['declaration']);
  });
});

// ================================================================================================ portes

describe('écran « Accès » : tri et résumé des portes', () => {
  const door = (id: string, state: string, over: Partial<Door> = {}): Door => ({ detectorId: id, name: `Porte ${id}`, state, deviceStatus: 'normal', ...over });

  it('les portes en alarme, forcées, maintenues ouvertes ou hors ligne passent d’abord', () => {
    const doors = [door('A', 'closed'), door('B', 'open'), door('C', 'offline'), door('D', 'held_open'), door('E', 'forced'), door('F', 'fault'), door('G', 'unknown')];
    assert.deepEqual(A.sortDoors(doors).map((d) => d.state), ['forced', 'held_open', 'offline', 'fault', 'unknown', 'open', 'closed']);
    assert.deepEqual(A.DOOR_ORDER, ['forced', 'held_open', 'offline', 'fault', 'unknown', 'open', 'closed']);
  });

  it('une alarme en cours passe avant tout, même sur une porte « maintenue ouverte » ou « fermée »', () => {
    const doors = [door('A', 'forced'), door('B', 'held_open', { deviceStatus: 'alarm' }), door('C', 'closed', { deviceStatus: 'alarm' })];
    assert.deepEqual(A.sortDoors(doors).map((d) => d.detectorId), ['B', 'C', 'A'].sort((x, y) => A.doorRank(doors.find((d) => d.detectorId === x)) - A.doorRank(doors.find((d) => d.detectorId === y)) || x.localeCompare(y)));
    assert.equal(A.sortDoors(doors)[0].deviceStatus, 'alarm');
    assert.equal(A.doorRank(door('X', 'closed', { deviceStatus: 'alarm' })), -1);
  });

  it('à gravité égale : par nom, puis par identifiant ; la liste d’origine n’est pas modifiée', () => {
    const doors = [door('3', 'closed', { name: 'Zèbre' }), door('2', 'closed', { name: 'Atelier' }), door('1', 'closed', { name: 'Atelier' }), door('0', 'closed', { name: 'Étage' })];
    const copy = doors.map((d) => d.detectorId);
    const sorted = A.sortDoors(doors).map((d) => `${d.name}/${d.detectorId}`);
    assert.deepEqual(sorted, ['Atelier/1', 'Atelier/2', 'Étage/0', 'Zèbre/3'], 'les accents se rangent à leur place (É après A, avant Z)');
    assert.deepEqual(doors.map((d) => d.detectorId), copy, 'tri sur une copie');
  });

  it('un état inconnu du serveur est traité comme « état inconnu », jamais comme « fermée »', () => {
    assert.equal(A.doorRank(door('X', 'bizarre')), A.DOOR_ORDER.indexOf('unknown'));
    assert.equal(A.doorRank(null), A.DOOR_ORDER.indexOf('unknown'));
    assert.deepEqual(A.sortDoors([door('A', 'closed'), door('B', 'bizarre')]).map((d) => d.detectorId), ['B', 'A']);
  });

  it('résumé en une phrase', () => {
    assert.equal(A.doorsSummary([]), 'Aucune porte déclarée');
    assert.equal(A.doorsSummary([door('A', 'closed')]), '1 porte : 1 fermée');
    assert.equal(
      A.doorsSummary([door('A', 'closed'), door('B', 'closed'), door('C', 'forced'), door('D', 'offline'), door('E', 'held_open'), door('F', 'held_open')]),
      '6 portes : 1 forcée, 2 maintenues ouvertes, 1 hors ligne, 2 fermées',
    );
    assert.equal(A.doorsSummary([door('A', 'bizarre')]), '1 porte : 1 d’état inconnu');
  });

  it('portes qui demandent de l’attention', () => {
    assert.equal(A.doorsNeedingAttention([door('A', 'closed'), door('B', 'open')]), 0);
    assert.equal(A.doorsNeedingAttention([door('A', 'forced'), door('B', 'offline'), door('C', 'fault'), door('D', 'held_open'), door('E', 'closed', { deviceStatus: 'alarm' })]), 5);
  });

  it('détecteurs d’accès non déclarés : signalés, qu’on donne une liste ou une table', () => {
    const devices = [
      { id: 'P1', kind: 'detector', category: 'access', name: 'Entrée', zone: 'Hall' },
      { id: 'P2', kind: 'detector', category: 'access', name: 'Arrière' },
      { id: 'F1', kind: 'detector', category: 'fire', name: 'Fumée' },
      { id: 'CAM', kind: 'camera', category: 'access', name: 'Pas un détecteur' },
    ];
    assert.deepEqual(A.undeclaredAccessDetectors(devices, [{ detectorId: 'P1' }]), [{ id: 'P2', name: 'Arrière', zone: '' }]);
    assert.deepEqual(A.undeclaredAccessDetectors(devices, new Map([['P2', { detectorId: 'P2' }]])), [{ id: 'P1', name: 'Entrée', zone: 'Hall' }]);
    assert.equal(A.undeclaredAccessDetectors(devices, [{ detectorId: 'P1' }, { detectorId: 'P2' }]).length, 0);
    assert.equal(A.undeclaredAccessDetectors([], []).length, 0);
    assert.match(A.UNDECLARED_TEXT, /n’est rattaché à aucun contrôleur : ses passages seront enregistrés mais la porte n’a pas d’état/);
  });

  it('chaque état a un texte de secours qui dit quoi faire', () => {
    for (const s of A.DOOR_ORDER) assert.ok(A.STATE_HINT[s]?.length > 10, s);
    assert.match(A.STATE_HINT.forced, /caméra.*alarme/);
    assert.match(A.STATE_HINT.offline, /alimentation et le réseau/);
  });

  it('emplacement d’ouverture à distance : un texte sobre, jamais de bouton factice', () => {
    assert.equal(A.REMOTE_UNAVAILABLE_TEXT, 'Ouverture à distance : pas encore disponible sur cette installation.');
    assert.equal(A.remoteSlotText({ available: false, reason: 'Ouverture à distance : disponible avec le lot AC4' }), A.REMOTE_UNAVAILABLE_TEXT);
    assert.equal(A.remoteSlotText({ available: false, reason: '' }), A.REMOTE_UNAVAILABLE_TEXT);
    assert.equal(A.remoteSlotText(undefined), A.REMOTE_UNAVAILABLE_TEXT);
    assert.equal(A.remoteSlotText({ available: false, reason: 'Cette porte n’a pas d’actionneur.' }), 'Cette porte n’a pas d’actionneur.');
    assert.equal(A.remoteSlotText({ available: true }), 'Ouverture à distance disponible sur cette porte.');
  });
});

// ================================================================================================ délais et horloge

describe('écran « Accès » : délai « maintenue ouverte », horloge, conservation', () => {
  it('le serveur compte en secondes, l’écran en minutes lisibles', () => {
    assert.equal(A.secondsText(300), '5 minutes');
    assert.equal(A.secondsText(60), '1 minute');
    assert.equal(A.secondsText(90), '1 min 30 s');
    assert.equal(A.secondsText(30), '30 secondes');
    assert.equal(A.secondsText(1), '1 seconde');
    assert.equal(A.secondsText(3600), '1 heure');
    assert.equal(A.secondsText(5400), '1 h 30 min');
    assert.equal(A.secondsText(86_400), '24 heures');
    assert.equal(A.secondsText(-1), '');
    assert.equal(A.secondsText('x'), '');
  });

  it('saisie en minutes -> secondes (virgule ou point), bornes 10 s et 24 h', () => {
    for (const [text, seconds] of [['5', 300], ['0,5', 30], ['0.5', 30], [' 1,5 ', 90], ['10', 600], ['1440', 86_400], ['0,17', 10]] as const) {
      assert.deepEqual(A.parseHeldDelay(text), { ok: true, seconds }, text);
    }
    for (const bad of ['', ' ', 'abc', '-1', '1e3', '0', '0,1', '1441', '5 min', '5;', '٥']) {
      const r = A.parseHeldDelay(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      if (!r.ok) assert.ok(r.message.length > 10);
    }
    assert.match((A.parseHeldDelay('0,1') as { message: string }).message, /10 secondes au moins/);
    assert.match((A.parseHeldDelay('1441') as { message: string }).message, /24 heures/);
  });

  it('secondes -> champ : ce qu’on lit se resaisit à l’identique', () => {
    assert.equal(A.minutesInput(300), '5');
    assert.equal(A.minutesInput(30), '0,5');
    assert.equal(A.minutesInput(90), '1,5');
    assert.equal(A.minutesInput(10), '0,17');
    assert.equal(A.minutesInput('x'), '');
    for (const s of [10, 30, 45, 60, 90, 300, 600, 3600, 86_400]) {
      const back = A.parseHeldDelay(A.minutesInput(s));
      assert.ok(back.ok, String(s));
      if (back.ok) assert.ok(Math.abs(back.seconds - s) <= 1, `${s} -> ${back.seconds}`);
    }
    assert.equal(A.minutesInput(A.HELD_DEFAULT_S), '5', 'défaut du serveur : 5 minutes');
  });

  it('écart d’horloge : à l’heure, léger, ou à régler (au-delà de 2 minutes)', () => {
    assert.deepEqual(A.clockOffsetInfo(null), { tone: 'muted', warn: false, text: 'Pas encore mesuré', hint: 'Mesuré au premier passage reçu en direct.' });
    assert.equal(A.clockOffsetInfo(undefined).tone, 'muted');
    assert.equal(A.clockOffsetInfo(Number.NaN).tone, 'muted');
    assert.deepEqual(A.clockOffsetInfo(400), { tone: 'ok', warn: false, text: 'À l’heure', hint: '' });
    assert.deepEqual(A.clockOffsetInfo(-1200), { tone: 'ok', warn: false, text: '1 s en retard', hint: '' });
    assert.equal(A.clockOffsetInfo(45_000).text, '45 s en avance');
    assert.equal(A.clockOffsetInfo(120_000).warn, false, 'exactement 2 minutes : pas encore un défaut');
    const late = A.clockOffsetInfo(-180_000);
    assert.equal(late.warn, true);
    assert.equal(late.tone, 'warning');
    assert.equal(late.text, '3 min en retard');
    assert.match(late.hint, /Plus de 2 minutes/);
  });

  it('conservation des passages : entier de 7 à 3 650 jours', () => {
    assert.deepEqual(A.parseRetention('90'), { ok: true, days: 90 });
    assert.deepEqual(A.parseRetention(' 7 '), { ok: true, days: 7 });
    assert.deepEqual(A.parseRetention('3650'), { ok: true, days: 3650 });
    for (const bad of ['', '6', '3651', '0', '-5', '12,5', '9e1', 'abc', '100000', '１２']) {
      assert.equal(A.parseRetention(bad).ok, false, JSON.stringify(bad));
    }
    assert.match((A.parseRetention('3') as { message: string }).message, /7 jours au moins/);
  });

  it('dernière purge en une phrase', () => {
    assert.equal(A.lastPurgeText(null, NOW), 'Aucune purge pour l’instant.');
    assert.equal(A.lastPurgeText({ at: at(2026, 10, 16, 3, 0), deleted: 4200, before: 1 }, NOW), 'Hier à 03:00 : 4\u00a0200 passages supprimés.');
    assert.equal(A.lastPurgeText({ at: at(2026, 10, 17, 3, 0), deleted: 1 }, NOW), 'Aujourd’hui à 03:00 : 1 passage supprimé.');
    assert.equal(A.lastPurgeText({ at: at(2026, 10, 17, 3, 0), deleted: 0 }, NOW), 'Aujourd’hui à 03:00 : aucun passage supprimé.');
    assert.equal(A.lastPurgeText({ at: 'x' }, NOW), 'Aucune purge pour l’instant.');
  });

  it('export : nom de fichier sûr, message de troncature, nombre de lignes', () => {
    assert.equal(A.exportFileName(NOW), 'passages-2026-10-17.csv');
    assert.equal(A.fileNameFromDisposition('attachment; filename="passages-2026-10-17.csv"'), 'passages-2026-10-17.csv');
    assert.equal(A.fileNameFromDisposition("attachment; filename*=UTF-8''acces_1.csv"), 'acces_1.csv');
    assert.equal(A.fileNameFromDisposition('attachment; filename="../../x.csv"'), null, 'jamais de chemin');
    assert.equal(A.fileNameFromDisposition('attachment; filename="a b.csv"'), null);
    assert.equal(A.fileNameFromDisposition(null), null);
    assert.equal(A.EXPORT_TRUNCATED_TEXT, 'Export limité à 100 000 lignes, réduisez la période.');
    assert.equal(A.exportDoneText(0, true), 'Export limité à 100 000 lignes, réduisez la période.');
    assert.match(A.exportDoneText(1234, false), /^1\u00a0234 passages exportés/);
    assert.match(A.exportDoneText(1, false), /^1 passage exporté/);
    assert.match(A.exportDoneText(0, false), /aucun passage ne correspond/);
    assert.match(A.exportDoneText(Number.NaN, false), /Téléchargements/);
    assert.equal(A.JOURNAL_NOTE, 'Les recherches par titulaire ou badge et les exports sont inscrits au journal.');
  });
});

// ================================================================================================ formulaires de déclaration

describe('écran « Accès » : formulaire d’un contrôleur', () => {
  const good = (over: Partial<ControllerForm> = {}): ControllerForm => ({ ...A.emptyControllerForm(), id: 'CTL-1', name: 'Contrôleur entrée', ...over });

  it('mêmes règles que le serveur : adresse, identifiants, marque, tailles', () => {
    assert.equal(A.HOST_PATTERN.source, SERVER_HOST_PATTERN.source, 'même motif d’adresse que server/video.ts');
    assert.deepEqual(A.controllerProblems(good()), []);
    assert.deepEqual(A.controllerProblems(good({ host: '192.168.1.50', gatewayId: 'gw-site', model: 'ASC1204B', brand: 'zkteco' })), []);
    const field = (f: ControllerForm, o?: { editing?: boolean }) => A.controllerProblems(f, o).map((p) => p.field);
    assert.deepEqual(field(good({ id: '' })), ['id']);
    assert.deepEqual(field(good({ id: 'a b' })), ['id']);
    assert.deepEqual(field(good({ id: 'x'.repeat(33) })), ['id']);
    assert.deepEqual(field(good({ id: '' }), { editing: true }), [], 'l’identifiant ne se modifie pas');
    assert.deepEqual(field(good({ name: '  ' })), ['name']);
    assert.deepEqual(field(good({ name: 'x'.repeat(81) })), ['name']);
    assert.deepEqual(field(good({ name: 'x'.repeat(80) })), []);
    assert.deepEqual(field(good({ name: 'Entrée\u202Eprincipale' })), ['name'], 'caractère de format invisible refusé comme au serveur');
    assert.deepEqual(field(good({ name: 'ligne\nsuivante' })), ['name']);
    assert.deepEqual(field(good({ brand: 'hikvision' })), ['brand']);
    assert.deepEqual(field(good({ model: 'x'.repeat(41) })), ['model']);
    assert.deepEqual(field(good({ host: 'http://192.168.1.50' })), ['host']);
    assert.deepEqual(field(good({ host: '192.168.1.50/admin' })), ['host']);
    assert.deepEqual(field(good({ host: '-mauvais' })), ['host']);
    assert.deepEqual(field(good({ gatewayId: 'gw site' })), ['gatewayId']);
  });

  it('identifiants : les deux ou aucun, jamais préremplis', () => {
    assert.deepEqual(A.controllerProblems(good({ username: 'admin', password: 'secret' })), []);
    assert.deepEqual(A.controllerProblems(good({ username: 'admin' })).map((p) => p.field), ['password']);
    assert.deepEqual(A.controllerProblems(good({ password: 'secret' })).map((p) => p.field), ['username']);
    assert.deepEqual(A.controllerProblems(good({ username: 'x'.repeat(129), password: 'y' })).map((p) => p.field), ['username']);
    const edit = A.controllerFormFrom({ id: 'CTL-1', name: 'Entrée', brand: 'dahua', host: '10.0.0.5', hasCredentials: true, username: 'ne-doit-pas-passer', password: 'non' });
    assert.equal(edit.username, '', 'jamais d’identifiant relu');
    assert.equal(edit.password, '');
    assert.equal(edit.host, '10.0.0.5');
    assert.equal(A.emptyControllerForm().password, '');
  });

  it('création : seulement ce qui est renseigné ; les identifiants partent s’ils sont saisis', () => {
    assert.deepEqual(A.controllerBody(good()), { id: 'CTL-1', name: 'Contrôleur entrée', brand: 'dahua' });
    assert.deepEqual(A.controllerBody(good({ id: ' CTL-2 ', name: '  Salle  ', model: ' M1 ', host: ' 10.0.0.9 ', gatewayId: ' gw ', username: 'u', password: 'p' })), {
      id: 'CTL-2',
      name: 'Salle',
      brand: 'dahua',
      model: 'M1',
      host: '10.0.0.9',
      gatewayId: 'gw',
      credentials: { username: 'u', password: 'p' },
    });
  });

  it('modification : seulement ce qui a changé (« champs absents = inchangés »), champ vidé = null', () => {
    const original = { id: 'CTL-1', name: 'Entrée', brand: 'dahua', model: 'M1', host: '10.0.0.5', gatewayId: 'gw' };
    const same = A.controllerFormFrom(original);
    assert.deepEqual(A.controllerBody(same, { editing: true, original }), {}, 'rien de changé : rien à envoyer');
    assert.deepEqual(A.controllerBody({ ...same, name: 'Entrée principale' }, { editing: true, original }), { name: 'Entrée principale' });
    assert.deepEqual(A.controllerBody({ ...same, host: '' }, { editing: true, original }), { host: null });
    assert.deepEqual(A.controllerBody({ ...same, gatewayId: '', model: '' }, { editing: true, original }), { model: null, gatewayId: null });
    assert.deepEqual(A.controllerBody({ ...same, brand: 'relay' }, { editing: true, original }), { brand: 'relay' });
    assert.deepEqual(A.controllerBody({ ...same, username: 'n', password: 'm' }, { editing: true, original }), { credentials: { username: 'n', password: 'm' } }, 'remplacement des identifiants');
    assert.equal('id' in A.controllerBody(same, { editing: true, original }), false);
    assert.deepEqual(A.controllerBody({ ...same, host: '10.0.0.5 ' }, { editing: true, original }), {}, 'des espaces autour ne sont pas un changement');
  });
});

describe('écran « Accès » : formulaire d’une porte', () => {
  const good = (over: Partial<DoorForm> = {}): DoorForm => ({ ...A.emptyDoorForm(), detectorId: 'P1', controllerId: 'CTL-1', ...over });
  const controllers = ['CTL-1', 'CTL-2'];

  it('valeurs de départ : porte, numéro 1, 5 minutes, pas une issue de secours', () => {
    assert.deepEqual(A.emptyDoorForm(), { detectorId: '', controllerId: '', doorNo: '1', kind: 'door', emergencyExit: false, heldMinutes: '5' });
  });

  it('contrôles : détecteur, contrôleur connu, numéro 1 à 4, type, délai', () => {
    assert.deepEqual(A.doorProblems(good(), { controllerIds: controllers }), []);
    const field = (f: DoorForm, o: { editing?: boolean; controllerIds?: string[] | null } = { controllerIds: controllers }) => A.doorProblems(f, o).map((p) => p.field);
    assert.deepEqual(field(good({ detectorId: '' })), ['detectorId']);
    assert.deepEqual(field(good({ detectorId: '' }), { editing: true, controllerIds: controllers }), [], 'en modification, le détecteur ne change pas');
    assert.deepEqual(field(good({ controllerId: '' })), ['controllerId']);
    assert.deepEqual(field(good({ controllerId: 'CTL-9' })), ['controllerId'], 'contrôleur inconnu');
    assert.deepEqual(field(good({ controllerId: 'CTL-9' }), { controllerIds: null }), [], 'sans liste de référence, seul le format compte');
    for (const bad of ['0', '5', '1.5', '', 'a']) assert.deepEqual(field(good({ doorNo: bad })), ['doorNo'], bad);
    for (const ok of ['1', '2', '3', '4']) assert.deepEqual(field(good({ doorNo: ok })), [], ok);
    assert.deepEqual(field(good({ kind: 'fenetre' })), ['kind']);
    assert.deepEqual(field(good({ heldMinutes: '0' })), ['heldMinutes']);
    assert.deepEqual(field(good({ heldMinutes: '2000' })), ['heldMinutes']);
    assert.deepEqual(field(good({ heldMinutes: '' })), ['heldMinutes']);
  });

  it('création : le délai part en secondes, l’issue de secours en booléen', () => {
    assert.deepEqual(A.doorBody(good({ doorNo: '2', kind: 'barrier', emergencyExit: true, heldMinutes: '0,5' })), {
      detectorId: 'P1',
      controllerId: 'CTL-1',
      doorNo: 2,
      kind: 'barrier',
      emergencyExit: true,
      heldAlarmAfterS: 30,
    });
    assert.equal(A.doorBody(good()).heldAlarmAfterS, 300);
  });

  it('modification : seulement ce qui change ; jamais le détecteur', () => {
    const original = { detectorId: 'P1', controllerId: 'CTL-1', doorNo: 1, kind: 'door', emergencyExit: false, heldAlarmAfterS: 300 };
    const same = A.doorFormFrom(original);
    assert.deepEqual(same, good());
    assert.deepEqual(A.doorBody(same, { editing: true, original }), {});
    assert.deepEqual(A.doorBody({ ...same, heldMinutes: '10' }, { editing: true, original }), { heldAlarmAfterS: 600 });
    assert.deepEqual(A.doorBody({ ...same, emergencyExit: true, kind: 'gate' }, { editing: true, original }), { kind: 'gate', emergencyExit: true });
    assert.deepEqual(A.doorBody({ ...same, controllerId: 'CTL-2', doorNo: '3' }, { editing: true, original }), { controllerId: 'CTL-2', doorNo: 3 });
    assert.equal('detectorId' in A.doorBody({ ...same, heldMinutes: '1' }, { editing: true, original }), false);
  });
});

// ================================================================================================ garde-fous sur les fichiers servis

describe('écran « Accès » : fichiers servis', () => {
  const js = read('access.js');
  const css = read('access.css');

  it('CSP : aucun HTML construit, aucun style en ligne, aucun script évalué', () => {
    for (const pattern of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function\(/, /\.style\./, /\.style\[/, /setAttribute\(\s*['"]style['"]/, /\bstyle:\s/, /cssText/, /javascript:/]) {
      assert.ok(!pattern.test(js), `access.js ne doit pas contenir ${pattern}`);
    }
    assert.ok(!/style\s*=/.test(js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'pas d’attribut style');
  });

  it('feuille de style : jetons du thème seulement (pas de couleur en dur), rien d’extérieur', () => {
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const colors = noComments.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(colors.filter((c) => c.toLowerCase() !== '#fff'), [], 'seul le blanc du texte sur fond plein est écrit en dur, comme ailleurs');
    assert.ok(!/@import|url\(|expression\(/.test(noComments), 'aucune ressource extérieure');
    assert.ok(!/rgba?\(/.test(noComments), 'pas de couleur écrite à la main');
    // Les composants de base.css réutilisés ne sont jamais redéfinis ici, seulement précisés sous un parent `acc-`.
    for (const m of noComments.matchAll(/([^{}]+)\{/g)) {
      const head = m[1].trim();
      if (head.startsWith('@')) continue;
      for (const selector of head.split(',')) assert.match(selector, /\.acc-|\.access-/, `sélecteur sans préfixe acc- : ${selector.trim()}`);
    }
  });

  it('chaque classe `acc-` écrite dans le script a sa règle dans la feuille (sauf simples accroches)', () => {
    const hooks = new Set(['acc-retention', 'acc-pane', 'acc-privacy']);
    const used = new Set<string>();
    for (const m of js.matchAll(/class:\s*'([^']*)'/g)) for (const c of m[1].split(/\s+/)) if (c.startsWith('acc-')) used.add(c);
    for (const m of js.matchAll(/classList\.add\('([^']*)'\)/g)) if (m[1].startsWith('acc-')) used.add(m[1]);
    assert.ok(used.size > 40, `classes trouvées : ${used.size}`);
    const missing = [...used].filter((c) => !css.includes(`.${c}`) && !hooks.has(c));
    assert.deepEqual(missing, [], 'classes sans règle CSS');
  });

  it('toutes les icônes utilisées existent dans le sprite', () => {
    const sprite = read('icons.svg');
    const core = read('core.js');
    const names = new Set<string>();
    for (const m of js.matchAll(/ico\('([a-z-]+)'/g)) names.add(m[1]);
    for (const m of js.matchAll(/icon:\s*'([a-z-]+)'/g)) names.add(m[1]);
    for (const m of core.matchAll(/icon:\s*'([a-z-]+)'/g)) if (/DOOR_STATE/.test(core)) names.add(m[1]);
    assert.ok(names.size > 20);
    const missing = [...names].filter((n) => !new RegExp(`<symbol[^>]*\\bid="${n}"`).test(sprite));
    assert.deepEqual(missing, [], 'icônes absentes du sprite');
  });

  it('textes d’interface attendus (français courant)', () => {
    for (const text of [
      'Seulement les passages reçus en différé',
      'Exporter en CSV',
      'Voir la vidéo',
      'Plus récents',
      'Plus anciens',
      'Reçu en différé',
      'Aucun passage sur cette période.',
      'Les passages arrivent depuis les contrôleurs déclarés dans l’onglet Déclaration.',
      'Aucun passage ne correspond à ces filtres.',
      'Pas de caméra liée',
      'Lier une caméra',
      'Effacer les identifiants',
      'Écriture seule : le PSIM les range scellés et ne les réaffiche jamais.',
      'Cette porte est une issue de secours',
      'Une issue de secours ne se verrouille jamais à distance',
      'Retour aux portes',
      '10 derniers passages',
      'Réessayer',
      'Conserver les passages pendant',
      'La suppression est automatique',
      'Le contrôleur décide seul d’ouvrir la porte pour un badge',
      'data-slot',
      'remote-open',
    ]) {
      assert.ok(js.includes(text), `texte manquant : ${text}`);
    }
  });

  it('identifiants de contrôleur : en écriture seule (type password, jamais prérempli, jamais dans le stockage du navigateur)', () => {
    assert.match(js, /password: h\('input', \{ type: 'password'/);
    assert.match(js, /autocomplete: 'new-password'/);
    assert.ok(!/localStorage|sessionStorage|indexedDB/.test(js), 'aucune donnée personnelle gardée dans le navigateur');
    assert.ok(!/username\.value\s*=|password\.value\s*=/.test(js.replace(/inputs\.password\.value = ''/, '')), 'les champs d’identifiants ne sont jamais remplis');
    assert.match(js, /inputs\.password\.value = ''/, 'le mot de passe saisi est effacé après l’envoi');
  });

  it('branchement : feuille de style, conteneur et appels du module dans index.html et app.js', () => {
    const html = read('index.html');
    const app = read('app.js');
    assert.match(html, /<link rel="stylesheet" href="access\.css">/);
    assert.match(html, /id="access-view"/);
    assert.match(app, /import \{ createAccessView \} from '\.\/access\.js';/);
    assert.match(app, /createAccessView\(\{ api, h, toast, getMe: \(\) => S\.me, dialogs \}\)/);
    assert.match(app, /accessView\.show\(/);
    assert.match(app, /accessView\.hide\(\)/);
    assert.match(app, /accessView\.openDoor\(/);
  });

  it('pas d’intervalle ni de minuteur qui tourne en continu dans le module', () => {
    assert.ok(!/setInterval\(/.test(js), 'les portes sont relues par l’application (toutes les 15 s tant que l’écran est visible)');
    const timeouts = [...js.matchAll(/setTimeout\(/g)].length;
    assert.equal(timeouts, 1, 'un seul minuteur ponctuel : la libération du fichier exporté');
  });

  it('chaque abonnement se défait : écouteur du clavier retiré à la sortie, un seul abonnement au bus', () => {
    assert.match(js, /document\.addEventListener\('keydown', onKey\)/);
    assert.match(js, /document\.removeEventListener\('keydown', onKey\)/);
    assert.equal([...js.matchAll(/core\.on\(/g)].length, 1, 'core.on n’a pas de désabonnement : un seul appel, protégé par un drapeau');
    assert.match(js, /if \(!wired\)/);
  });
});

// ================================================================================================ la vue, dans un DOM minimal

type Handler = (event: Record<string, unknown>) => void;

/** Nœud de texte du DOM minimal. */
class FakeText {
  data: string;
  parent: FakeEl | null = null;
  constructor(data: string) {
    this.data = data;
  }
}

/**
 * Élément du DOM minimal : assez pour construire l'écran, l'interroger et simuler un clic, une frappe ou un envoi. Ce n'est
 * ni un navigateur ni un modèle de mise en page.
 */
class FakeEl {
  tagName: string;
  attrs = new Map<string, string>();
  children: (FakeEl | FakeText)[] = [];
  parent: FakeEl | null = null;
  listeners = new Map<string, Handler[]>();
  _value: string | null = null;
  _checked = false;
  _disabled = false;
  width = 0;
  height = 0;
  constructor(tag: string) {
    this.tagName = tag.toLowerCase();
  }
  get className(): string {
    return this.attrs.get('class') ?? '';
  }
  set className(v: string) {
    this.attrs.set('class', String(v));
  }
  get id(): string {
    return this.attrs.get('id') ?? '';
  }
  set id(v: string) {
    this.attrs.set('id', String(v));
  }
  get hidden(): boolean {
    return this.attrs.has('hidden');
  }
  set hidden(v: boolean) {
    if (v) this.attrs.set('hidden', '');
    else this.attrs.delete('hidden');
  }
  get tabIndex(): number {
    return Number(this.attrs.get('tabindex') ?? -1);
  }
  set tabIndex(v: number) {
    this.attrs.set('tabindex', String(v));
  }
  get type(): string {
    return this.attrs.get('type') ?? '';
  }
  get title(): string {
    return this.attrs.get('title') ?? '';
  }
  set title(v: string) {
    this.attrs.set('title', String(v));
  }
  get disabled(): boolean {
    return this._disabled;
  }
  set disabled(v: boolean) {
    this._disabled = Boolean(v);
  }
  get checked(): boolean {
    return this._checked;
  }
  set checked(v: boolean) {
    this._checked = Boolean(v);
  }
  get value(): string {
    if (this._value !== null) return this._value;
    if (this.tagName === 'select') {
      const first = this.find((e) => e.tagName === 'option');
      return first?.attrs.get('value') ?? '';
    }
    return this.attrs.get('value') ?? '';
  }
  set value(v: string) {
    this._value = String(v);
  }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      add: (...c: string[]) => (el.className = [...new Set([...list(), ...c])].join(' ')),
      remove: (...c: string[]) => (el.className = list().filter((x) => !c.includes(x)).join(' ')),
      toggle: (c: string, force?: boolean) => {
        const has = list().includes(c);
        const want = force ?? !has;
        el.className = (want ? [...new Set([...list(), c])] : list().filter((x) => x !== c)).join(' ');
        return want;
      },
      contains: (c: string) => list().includes(c),
    };
  }
  get dataset(): Record<string, string> {
    const el = this;
    const key = (k: string) => `data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
    return new Proxy({} as Record<string, string>, {
      get: (_t, k: string) => el.attrs.get(key(k)),
      set: (_t, k: string, v) => {
        el.attrs.set(key(k), String(v));
        return true;
      },
      has: (_t, k: string) => el.attrs.has(key(k)),
      ownKeys: () => [...el.attrs.keys()].filter((k) => k.startsWith('data-')),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
  }
  get textContent(): string {
    return this.children.map((c) => (c instanceof FakeText ? c.data : c.textContent)).join('');
  }
  set textContent(v: string) {
    this.replaceChildren(String(v));
  }
  get isConnected(): boolean {
    let n: FakeEl | null = this;
    while (n) {
      if (n === fakeBody) return true;
      n = n.parent;
    }
    return false;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  hasAttribute(k: string) {
    return this.attrs.has(k);
  }
  toggleAttribute(k: string, force?: boolean) {
    const want = force ?? !this.attrs.has(k);
    if (want) this.attrs.set(k, '');
    else this.attrs.delete(k);
  }
  private adopt(nodes: unknown[]): (FakeEl | FakeText)[] {
    return nodes.map((n) => (n instanceof FakeEl || n instanceof FakeText ? n : new FakeText(String(n))));
  }
  private attach(n: FakeEl | FakeText) {
    if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n);
    n.parent = this;
  }
  append(...nodes: unknown[]) {
    for (const n of this.adopt(nodes)) {
      this.attach(n);
      this.children.push(n);
    }
  }
  replaceChildren(...nodes: unknown[]) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  insertBefore(node: FakeEl, ref: FakeEl | FakeText | null) {
    this.attach(node);
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(node);
    else this.children.splice(i, 0, node);
    return node;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  contains(node: unknown): boolean {
    if (node === this) return true;
    return this.children.some((c) => c instanceof FakeEl && c.contains(node));
  }
  get childElements(): FakeEl[] {
    return this.children.filter((c): c is FakeEl => c instanceof FakeEl);
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  find(pred: (e: FakeEl) => boolean): FakeEl | null {
    for (const c of this.childElements) {
      if (pred(c)) return c;
      const deep = c.find(pred);
      if (deep) return deep;
    }
    return null;
  }
  findAll(pred: (e: FakeEl) => boolean, out: FakeEl[] = []): FakeEl[] {
    for (const c of this.childElements) {
      if (pred(c)) out.push(c);
      c.findAll(pred, out);
    }
    return out;
  }
  querySelector(sel: string) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel: string): FakeEl[] {
    const parts = sel.trim().split(/\s+/);
    const out: FakeEl[] = [];
    const walk = (el: FakeEl, ancestors: FakeEl[]) => {
      for (const c of el.childElements) {
        const chain = [...ancestors, c];
        if (matchChain(chain, parts)) out.push(c);
        walk(c, chain);
      }
    };
    walk(this, []);
    return out;
  }
  getClientRects() {
    let n: FakeEl | null = this;
    while (n) {
      if (n.hidden) return [];
      n = n.parent;
    }
    return this.isConnected ? [{}] : [];
  }
  addEventListener(type: string, fn: Handler) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  dispatch(type: string, extra: Record<string, unknown> = {}) {
    const event = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra };
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  click() {
    if (this.disabled || !this.isConnected) return;
    this.dispatch('click');
  }
  focus() {
    if (this.disabled || !this.isConnected || this.getClientRects().length === 0) return;
    fakeDocument.active = this;
  }
  getContext() {
    return new Proxy({}, { get: (_t, k) => (k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {}), set: () => true });
  }
}

function matchCompound(el: FakeEl, compound: string): boolean {
  const re = /^([a-z][a-z0-9]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/i.exec(compound);
  if (!re) return false;
  if (re[1] && el.tagName !== re[1].toLowerCase()) return false;
  for (const m of re[2].matchAll(/([.#])([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|([^\]]*)))?\]/g)) {
    if (m[1] === '.' && !el.className.split(/\s+/).includes(m[2])) return false;
    if (m[1] === '#' && el.id !== m[2]) return false;
    if (m[3]) {
      if (!el.attrs.has(m[3])) return false;
      const want = m[4] ?? m[5];
      if (want !== undefined && el.attrs.get(m[3]) !== want) return false;
    }
  }
  return true;
}

function matchChain(chain: FakeEl[], parts: string[]): boolean {
  let i = chain.length - 1;
  if (!matchCompound(chain[i], parts[parts.length - 1])) return false;
  let p = parts.length - 2;
  i--;
  while (p >= 0 && i >= 0) {
    if (matchCompound(chain[i], parts[p])) p--;
    i--;
  }
  return p < 0;
}

const fakeBody = new FakeEl('body');
const docListeners = new Map<string, Handler[]>();
const fakeDocument = {
  body: fakeBody,
  active: null as FakeEl | null,
  hidden: false,
  get activeElement() {
    return this.active ?? fakeBody;
  },
  createElement: (tag: string) => new FakeEl(tag),
  createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
  getElementById: (id: string) => (fakeBody.id === id ? fakeBody : fakeBody.find((e) => e.id === id)),
  addEventListener(type: string, fn: Handler) {
    docListeners.set(type, [...(docListeners.get(type) ?? []), fn]);
  },
  removeEventListener(type: string, fn: Handler) {
    docListeners.set(type, (docListeners.get(type) ?? []).filter((f) => f !== fn));
  },
  dispatch(type: string, extra: Record<string, unknown> = {}) {
    for (const fn of docListeners.get(type) ?? []) fn({ type, preventDefault() {}, ...extra });
  },
  count: (type: string) => (docListeners.get(type) ?? []).length,
};

const fakeLocation = { hash: '#/acces' };
let rafId = 0;
const rafActive = new Set<number>();

/** Installe le DOM minimal avant le premier import de core.js, qui touche à `document` en se chargeant. */
const g = globalThis as Record<string, unknown>;
g.document = fakeDocument;
g.HTMLElement = FakeEl;
g.location = fakeLocation;
g.history = { replaceState: (_s: unknown, _t: string, url: string) => void (fakeLocation.hash = url.replace(/^.*(?=#)/, '')) };
g.CSS = { escape: (s: string) => s };
g.requestAnimationFrame = () => {
  rafActive.add(++rafId);
  return rafId;
};
g.cancelAnimationFrame = (id: number) => void rafActive.delete(id);
g.matchMedia = () => ({ matches: false, addEventListener() {} });

interface Core {
  S: { doors: Map<string, Door>; devices: Map<string, Record<string, unknown>>; floors: unknown[] };
  on: (name: string, fn: (...a: unknown[]) => void) => void;
  emit: (name: string, ...a: unknown[]) => void;
}
const core = (await import(pathToFileURL(join(WEB, 'core.js')).href)) as Core;

const text = (el: FakeEl | null) => el?.textContent ?? '';
const byText = (root: FakeEl, tag: string, wanted: string) => root.find((e) => e.tagName === tag && e.textContent.trim() === wanted);
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const hrefOf = (el: FakeEl) => el.attrs.get('href') ?? '';
/** Formulaire d'ajout ou de modification d'un contrôleur ou d'une porte (le réglage de conservation n'en est pas un). */
const declForm = (root: FakeEl) => root.find((e) => e.tagName === 'form' && e.className.includes('acc-form') && e.attrs.has('aria-labelledby'));

const DOOR_FORCED = { detectorId: 'P-ENTREE', name: 'Entrée personnel', zone: 'Rez-de-chaussée', floorId: 1, controllerId: 'CTL-1', controllerName: 'Contrôleur entrée', doorNo: 1, kind: 'door', emergencyExit: false, heldAlarmAfterS: 300, state: 'forced', stateLabel: 'Forcée', stateHint: 'La porte s’est ouverte sans autorisation. Regardez la caméra, puis traitez l’alarme.', stateSince: NOW - 60_000, doorState: 'open', deviceStatus: 'alarm', lastSeen: NOW - 1000, lastPassageAt: NOW - 3_600_000, cameraIds: ['CAM-1'] };
const DOOR_CLOSED = { ...DOOR_FORCED, detectorId: 'P-ARRIERE', name: 'Arrière', zone: 'Cour', doorNo: 2, state: 'closed', stateLabel: 'Fermée', stateHint: 'La porte est fermée. Rien à faire.', deviceStatus: 'normal', lastPassageAt: null, cameraIds: [] };
const DOOR_OFFLINE = { ...DOOR_FORCED, detectorId: 'P-STOCK', name: 'Stock', zone: 'Entrepôt', doorNo: 3, state: 'offline', stateLabel: 'Hors ligne', stateHint: 'Le PSIM n’a plus de nouvelles du contrôleur.', deviceStatus: 'offline', lastPassageAt: NOW - 86_400_000, cameraIds: [] };
const PASSAGE = (n: number, over: Record<string, unknown> = {}) => ({ id: n, doorId: 'P-ENTREE', doorName: 'Entrée personnel', controllerId: 'CTL-1', eventId: String(n), atDevice: NOW - n * 60_000, atReceived: NOW - n * 60_000 + 1500, direction: 'in', credential: `00${n}`, holderName: `Titulaire ${n}`, holderRef: '101', method: 'badge', methodLabel: 'Badge', result: 'granted', reason: null, resultLabel: 'Accepté', late: false, ...over });
const CONTROLLER = { id: 'CTL-1', name: 'Contrôleur entrée', brand: 'dahua', model: 'ASC1204B', host: '192.168.1.50', gatewayId: 'gw-site', hasCredentials: true, clockOffsetMs: -180_000, lastSeen: NOW - 5000, doorCount: 3 };

interface Call {
  path: string;
  method: string;
  body?: unknown;
}

/** Monte l'écran contre un faux serveur ; `routes` répond aux appels (le premier motif qui correspond). */
function setup(opts: { admin?: boolean; routes?: Record<string, (call: Call) => unknown> } = {}) {
  const admin = opts.admin ?? true;
  const calls: Call[] = [];
  const toasts: string[] = [];
  const container = new FakeEl('div');
  fakeBody.append(container);
  const dialogState: { onClose: (() => void) | null; heading: string; content: unknown; open: boolean; confirms: { heading: string }[]; confirmError: string | null; closeCalls: number; refuse: boolean } = { onClose: null, heading: '', content: null, open: false, confirms: [], confirmError: null, closeCalls: 0, refuse: false };
  const dialogBody = new FakeEl('div');
  dialogBody.id = 'dialog-body';
  fakeBody.append(dialogBody);
  const dialogs = {
    open(heading: string, content: unknown, o: { onClose?: () => void } = {}) {
      dialogState.open = true;
      dialogState.heading = heading;
      dialogState.content = content;
      dialogState.onClose = o.onClose ?? null;
      dialogBody.replaceChildren(content); // le contenu est dans la page, comme dans la vraie fenêtre
    },
    close() {
      dialogState.closeCalls++;
      dialogBody.replaceChildren();
      if (!dialogState.open) return;
      dialogState.open = false;
      const cb = dialogState.onClose;
      dialogState.onClose = null;
      cb?.();
    },
    // Comme la vraie fenêtre : l'erreur de l'action est affichée sur place (ici retenue), la fenêtre ne confirme pas.
    async confirm(o: { heading: string; onConfirm?: () => Promise<unknown> }) {
      dialogState.confirms.push({ heading: o.heading });
      if (dialogState.refuse) return false; // l'utilisateur clique « Annuler »
      try {
        await o.onConfirm?.();
        return true;
      } catch (err) {
        dialogState.confirmError = (err as Error).message;
        return false;
      }
    },
  };
  const routes: Record<string, (call: Call) => unknown> = {
    'GET /api/access/doors/': (c) => {
      const id = decodeURIComponent(c.path.split('/').pop() ?? '');
      const door = [DOOR_FORCED, DOOR_CLOSED, DOOR_OFFLINE].find((d) => d.detectorId === id);
      if (!door) throw new Error('Porte introuvable');
      return { door, lastPassages: [PASSAGE(1), PASSAGE(2, { result: 'denied', resultLabel: 'Refusé — badge expiré', holderName: null, late: true })], cameras: door.cameraIds.map((cid: string) => ({ id: cid, name: 'Caméra entrée', status: 'normal' })), remote: { available: false, reason: 'Ouverture à distance : disponible avec le lot AC4' } };
    },
    'GET /api/access/doors': () => [DOOR_CLOSED, DOOR_OFFLINE, DOOR_FORCED],
    'GET /api/access/events': () => ({ items: [PASSAGE(1), PASSAGE(2, { result: 'denied', resultLabel: 'Refusé — badge inconnu', holderName: null, credential: null, late: true, doorId: 'P-ARRIERE', doorName: 'Arrière' })], nextCursor: null, total: 2, totalCapped: false }),
    'GET /api/access/settings': () => ({ retentionDays: 90, defaultDays: 90, eventCount: 1234, oldestAt: NOW - 90 * 86_400_000, lastPurge: { at: NOW - 86_400_000, deleted: 4200, before: NOW - 91 * 86_400_000 } }),
    'GET /api/access/controllers': () => [CONTROLLER],
    'POST /api/access/controllers': () => ({ ...CONTROLLER, id: 'CTL-2' }),
    ...opts.routes,
  };
  const api = async (path: string, o: { method?: string; body?: unknown } = {}) => {
    const call: Call = { path, method: o.method ?? 'GET', body: o.body };
    calls.push(call);
    const url = path.split('?')[0];
    const keys = Object.keys(routes).filter((k) => k.startsWith(`${call.method} `) && url.startsWith(k.slice(call.method.length + 1)));
    keys.sort((a, b) => b.length - a.length);
    if (!keys.length) throw new Error(`Pas de route de test pour ${call.method} ${path}`);
    return routes[keys[0]](call);
  };
  const h = (tag: string, attrs: Record<string, unknown> = {}, ...children: unknown[]) => {
    const el = new FakeEl(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key === 'text') el.textContent = String(value);
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value as Handler);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) if (child) el.append(child);
    return el;
  };
  const view = A.createAccessView({ api, h, toast: (m: string) => void toasts.push(m), getMe: () => ({ role: admin ? 'admin' : 'operator', username: admin ? 'admin' : 'garde' }), dialogs });
  return { view, container, calls, toasts, dialogState, dialogBody, api };
}

describe('écran « Accès » : la vue dans un DOM minimal', () => {
  beforeEach(() => {
    core.S.doors = new Map();
    core.S.floors = [];
    core.S.devices = new Map([
      ['CAM-1', { id: 'CAM-1', kind: 'camera', name: 'Caméra entrée', zone: 'Hall', streamKind: 'sim' }],
      ['P-ENTREE', { id: 'P-ENTREE', kind: 'detector', category: 'access', name: 'Entrée personnel', zone: 'Rez-de-chaussée' }],
      ['P-NEUF', { id: 'P-NEUF', kind: 'detector', category: 'access', name: 'Porte neuve', zone: 'Cour' }],
    ]);
    fakeBody.replaceChildren();
    fakeDocument.active = null;
    fakeLocation.hash = '#/acces';
    rafActive.clear();
  });
  afterEach(() => {
    fakeBody.replaceChildren();
  });

  it('s’ouvre sur le journal : filtres, total, tableau avec résultat en clair, « reçu en différé » et lien vidéo', async () => {
    const { view, container, calls } = setup();
    await view.show(container, '');
    await flush();
    const tabs = container.findAll((e) => e.attrs.get('role') === 'tab');
    assert.deepEqual(tabs.map((t) => text(t)), ['Journal', 'Portes', 'Déclaration']);
    assert.equal(tabs[0].attrs.get('aria-selected'), 'true');
    assert.equal(tabs[1].attrs.get('aria-selected'), 'false');
    assert.equal(tabs[0].tabIndex, 0, 'un seul onglet dans l’ordre de tabulation (flèches pour les autres)');
    assert.equal(tabs[1].tabIndex, -1);

    const events = calls.find((c) => c.path.startsWith('/api/access/events?'));
    assert.ok(events, 'journal lu');
    const q = new URLSearchParams(events.path.split('?')[1]);
    assert.equal(q.get('limit'), '50');
    assert.equal(q.get('count'), '1', 'le total est demandé sur la première page');
    assert.ok(q.get('from') && q.get('to'), 'période du jour');

    const body = container.textContent;
    assert.match(body, /2 passages/);
    assert.match(body, /Titulaire 1/);
    assert.match(body, /Badge 001/);
    assert.match(body, /Refusé — badge inconnu/, 'résultat du serveur, tel quel');
    assert.match(body, /Accepté/);
    assert.match(body, /Reçu en différé/);
    assert.match(body, /Titulaire inconnu/);
    assert.match(body, /Les recherches par titulaire ou badge et les exports sont inscrits au journal\./);
    assert.match(body, /Les passages sont conservés 90 jours/, 'durée de conservation visible de tous');
    const videos = container.findAll((e) => e.tagName === 'button' && text(e) === 'Voir la vidéo');
    assert.equal(videos.length, 1, 'seulement pour la porte qui a une caméra liée');
    assert.match(body, /Pas de caméra liée/);
    assert.ok(byText(container, 'a', 'Lier une caméra'), 'l’administrateur peut lier une caméra');
    const rows = container.findAll((e) => e.tagName === 'tr' && e.attrs.has('data-passage'));
    assert.equal(rows.length, 2);
    assert.ok(rows[0].querySelector('td[data-label="Résultat"]'), 'chaque cellule porte son libellé (carte sur téléphone)');
    view.hide();
  });

  it('un opérateur ne voit ni l’onglet Déclaration ni le lien « Lier une caméra »', async () => {
    const { view, container } = setup({ admin: false });
    await view.show(container, 'declaration');
    await flush();
    const tabs = container.findAll((e) => e.attrs.get('role') === 'tab');
    assert.deepEqual(tabs.map((t) => text(t)), ['Journal', 'Portes']);
    assert.equal(tabs[0].attrs.get('aria-selected'), 'true', 'route réservée : retour au journal');
    assert.equal(byText(container, 'a', 'Lier une caméra'), null);
    assert.ok(!container.textContent.includes('Ajouter un contrôleur'));
    view.hide();
  });

  it('données hostiles : noms et badges restent du texte, jamais des éléments', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { view, container } = setup({ routes: { 'GET /api/access/events': () => ({ items: [PASSAGE(1, { holderName: hostile, credential: '"><script>', doorName: hostile })], nextCursor: null, total: 1, totalCapped: false }) } });
    await view.show(container, '');
    await flush();
    assert.ok(container.textContent.includes(hostile));
    assert.equal(container.findAll((e) => e.tagName === 'img' || e.tagName === 'script').length, 0);
    view.hide();
  });

  it('état vide qui apprend, et filtres qui ne trouvent rien', async () => {
    const { view, container } = setup({ routes: { 'GET /api/access/events': () => ({ items: [], nextCursor: null, total: 0, totalCapped: false }) } });
    await view.show(container, '');
    await flush();
    assert.match(container.textContent, /Aucun passage sur cette période\./);
    assert.match(container.textContent, /Les passages arrivent depuis les contrôleurs déclarés dans l’onglet Déclaration\./);
    assert.ok(byText(container, 'button', 'Ouvrir la déclaration'));
    // un filtre posé change le message
    const door = container.find((e) => e.id === 'acc-late')!;
    door.checked = true;
    door.dispatch('change');
    await flush();
    assert.match(container.textContent, /Aucun passage ne correspond à ces filtres\./);
    assert.ok(byText(container, 'button', 'Effacer les filtres'));
    view.hide();
  });

  it('erreur de lecture : message clair et bouton « Réessayer » qui relit', async () => {
    let fail = true;
    const { view, container, calls } = setup({
      routes: {
        'GET /api/access/events': () => {
          if (fail) throw new Error('Le PSIM ne répond pas');
          return { items: [PASSAGE(1)], nextCursor: null, total: 1, totalCapped: false };
        },
      },
    });
    await view.show(container, '');
    await flush();
    assert.match(container.textContent, /Le journal n’a pas pu être lu\. Le PSIM ne répond pas\./);
    const retry = byText(container, 'button', 'Réessayer')!;
    assert.ok(retry);
    fail = false;
    const before = calls.filter((c) => c.path.startsWith('/api/access/events')).length;
    retry.click();
    await flush();
    assert.equal(calls.filter((c) => c.path.startsWith('/api/access/events')).length, before + 1);
    assert.match(container.textContent, /1 passage/);
    assert.ok(!container.textContent.includes('n’a pas pu être lu'));
    view.hide();
  });

  it('pagination par curseur : « Plus anciens » envoie le curseur, « Plus récents » revient sans le total relu', async () => {
    const seen: string[] = [];
    const { view, container } = setup({
      routes: {
        'GET /api/access/events': (c) => {
          const q = new URLSearchParams(c.path.split('?')[1]);
          seen.push(`${q.get('cursor') ?? '-'}|${q.get('count') ?? '-'}`);
          if (!q.get('cursor')) return { items: [PASSAGE(1)], nextCursor: 'C2', total: 120, totalCapped: false };
          return { items: [PASSAGE(2)], nextCursor: null };
        },
      },
    });
    await view.show(container, '');
    await flush();
    const older = byText(container, 'button', 'Plus anciens')!;
    const newer = byText(container, 'button', 'Plus récents')!;
    assert.equal(older.disabled, false);
    assert.equal(newer.disabled, true, 'page 1 : rien de plus récent');
    assert.match(container.textContent, /120 passages/);
    older.click();
    await flush();
    assert.deepEqual(seen, ['-|1', 'C2|-']);
    assert.match(container.textContent, /Passages 51 à 51 sur 120/);
    assert.match(container.textContent, /Page 2/);
    assert.equal(older.disabled, true, 'dernière page');
    assert.equal(newer.disabled, false);
    newer.click();
    await flush();
    assert.equal(seen.at(-1), '-|1', 'retour à la première page : curseur absent, total relu');
    view.hide();
  });

  it('une réponse tardive d’une ancienne recherche n’écrase pas la plus récente', async () => {
    const releases: (() => void)[] = [];
    let n = 0;
    const { view, container } = setup({
      routes: {
        'GET /api/access/events': () => {
          const mine = ++n;
          return new Promise((resolve) => {
            releases.push(() => resolve({ items: [PASSAGE(mine, { holderName: `Réponse ${mine}` })], nextCursor: null, total: 1, totalCapped: false }));
          });
        },
      },
    });
    await view.show(container, '');
    await flush();
    const late = container.find((e) => e.id === 'acc-late')!;
    late.checked = true;
    late.dispatch('change'); // 2e recherche, lancée avant la fin de la 1re
    await flush();
    assert.equal(releases.length, 2);
    releases[1]();
    await flush();
    releases[0]();
    await flush();
    assert.match(container.textContent, /Réponse 2/);
    assert.ok(!container.textContent.includes('Réponse 1'));
    view.hide();
  });

  it('filtres : valeurs invalides refusées avec le focus sur le champ, requête jamais envoyée', async () => {
    const { view, container, calls } = setup();
    await view.show(container, '');
    await flush();
    const before = calls.length;
    const from = container.find((e) => e.id === 'acc-from')!;
    const to = container.find((e) => e.id === 'acc-to')!;
    from.value = '2026-10-17T18:00';
    to.value = '2026-10-17T08:00';
    const form = container.find((e) => e.tagName === 'form' && e.attrs.get('aria-label') === 'Filtres du journal des passages')!;
    form.dispatch('submit');
    await flush();
    assert.match(container.textContent, /La date de début est après la date de fin/);
    assert.equal(calls.length, before, 'aucune requête');
    assert.equal(from.attrs.get('aria-invalid'), 'true');
    assert.equal(fakeDocument.activeElement, from, 'le focus va au champ à corriger');
    view.hide();
  });

  it('filtres de l’adresse appliqués ; l’adresse ne reçoit jamais de nom ni de badge', async () => {
    const { view, container, calls } = setup();
    await view.show(container, 'journal?door=P-ENTREE&result=denied&late=1');
    await flush();
    const events = calls.filter((c) => c.path.startsWith('/api/access/events?'));
    const q = new URLSearchParams(events.at(-1)!.path.split('?')[1]);
    assert.equal(q.get('door'), 'P-ENTREE');
    assert.equal(q.get('result'), 'denied');
    assert.equal(q.get('late'), '1');
    assert.equal(fakeLocation.hash, '#/acces/journal?door=P-ENTREE&result=denied&late=1');
    const holder = container.find((e) => e.id === 'acc-holder')!;
    holder.value = 'Konan';
    container.find((e) => e.id === 'acc-credential')!.value = '0012345';
    container.find((e) => e.tagName === 'form')!.dispatch('submit');
    await flush();
    assert.ok(!/Konan|0012345/.test(fakeLocation.hash), `adresse : ${fakeLocation.hash}`);
    assert.ok(new URLSearchParams(calls.filter((c) => c.path.startsWith('/api/access/events?')).at(-1)!.path.split('?')[1]).get('holder') === 'Konan', 'mais la recherche part bien avec');
    view.hide();
  });

  it('« Voir la vidéo » : image en direct de la caméra de la porte, avec la mise en garde ; flux arrêtés à la fermeture', async () => {
    const { view, container, dialogState } = setup();
    await view.show(container, '');
    await flush();
    const open = byText(container, 'button', 'Voir la vidéo')!;
    fakeDocument.active = open;
    open.click();
    assert.equal(dialogState.open, true);
    assert.match(dialogState.heading, /Entrée personnel/);
    const content = dialogState.content as FakeEl;
    assert.match(content.textContent, /Image en direct, pas l’enregistrement de \d\d:\d\d\./);
    assert.match(content.textContent, /Le PSIM ne relit pas encore l’enregistreur/);
    assert.equal(rafActive.size, 1, 'un flux ouvert');
    dialogState.onClose?.();
    assert.equal(rafActive.size, 0, 'flux arrêté à la fermeture de la fenêtre');
    view.hide();
  });

  it('quitter l’écran (alarme) ferme la fenêtre vidéo, arrête les flux et retire l’écouteur du clavier', async () => {
    const { view, container, dialogState } = setup();
    const keydownBefore = fakeDocument.count('keydown');
    await view.show(container, '');
    await flush();
    assert.equal(fakeDocument.count('keydown'), keydownBefore + 1);
    byText(container, 'button', 'Voir la vidéo')!.click();
    assert.equal(dialogState.open, true);
    assert.equal(rafActive.size, 1);
    view.hide();
    assert.equal(dialogState.open, false, 'une alarme ne reste pas cachée derrière une fenêtre de l’écran Accès');
    assert.equal(rafActive.size, 0);
    assert.equal(fakeDocument.count('keydown'), keydownBefore, 'écouteur retiré');
    view.hide(); // sans effet la seconde fois
    await view.show(container, '');
    await flush();
    assert.equal(fakeDocument.count('keydown'), keydownBefore + 1, 'un seul écouteur après un retour sur l’écran');
    await view.show(container, '');
    await flush();
    assert.equal(fakeDocument.count('keydown'), keydownBefore + 1, 'show() répété n’empile pas les écouteurs');
    view.hide();
  });

  it('quitter l’écran ne ferme pas une autre fenêtre ouverte entre-temps (Mon compte), mais arrête quand même le flux', async () => {
    const { view, container, dialogState, dialogBody } = setup();
    await view.show(container, '');
    await flush();
    byText(container, 'button', 'Voir la vidéo')!.click();
    assert.equal(rafActive.size, 1);
    dialogBody.replaceChildren('Mon compte : mot de passe à changer'); // une autre fenêtre a pris la place sans fermer la nôtre
    const closes = dialogState.closeCalls;
    view.hide();
    assert.equal(dialogState.closeCalls, closes, 'la fenêtre des autres n’est pas fermée');
    assert.equal(rafActive.size, 0, 'le flux est arrêté');
  });

  it('un mot de passe de contrôleur tapé et non envoyé ne reste pas dans la page quand on quitte l’écran', async () => {
    const { view, container } = setup();
    await view.show(container, 'declaration');
    await flush();
    byText(container, 'button', 'Ajouter un contrôleur')!.click();
    const password = declForm(container)!.find((e) => e.type === 'password')!;
    password.value = 'pas-envoye';
    view.hide();
    assert.equal(password.value, '');
  });

  it('les relevés réguliers ne refont pas un message d’erreur ni un bouton qui a le focus', async () => {
    const { view, container } = setup({
      routes: {
        'GET /api/access/events': () => {
          throw new Error('Le PSIM ne répond pas');
        },
      },
    });
    await view.show(container, '');
    await flush();
    const notice = container.find((e) => e.attrs.get('role') === 'alert' && e.className.includes('notice'))!;
    const retry = byText(notice, 'button', 'Réessayer')!;
    fakeDocument.active = retry;
    core.S.doors = new Map([[DOOR_FORCED.detectorId, DOOR_FORCED]]);
    core.emit('doors', []);
    core.emit('doors', []);
    assert.equal(container.find((e) => e.attrs.get('role') === 'alert' && e.className.includes('notice')), notice, 'même message, pas ré-annoncé');
    assert.equal(fakeDocument.activeElement, retry, 'le focus reste sur « Réessayer »');
    view.hide();
  });

  it('les cartes de portes ne sont pas refaites par un relevé identique', async () => {
    const { view, container } = setup();
    await view.show(container, 'portes');
    await flush();
    const list = container.find((e) => e.attrs.get('aria-label') === 'Portes, les plus urgentes d’abord')!;
    const hint = list.childElements[0].find((e) => e.className === 'acc-door-hint')!;
    const textNode = hint.children[0];
    core.emit('doors', []);
    assert.equal(hint.children[0], textNode, 'texte non réécrit');
    view.hide();
  });

  it('résultat : le bouton choisi est enfoncé, et la recherche part avec ce résultat', async () => {
    const { view, container, calls } = setup();
    await view.show(container, '');
    await flush();
    const denied = container.find((e) => e.tagName === 'button' && e.attrs.get('data-result') === 'denied')!;
    const all = container.find((e) => e.tagName === 'button' && e.attrs.get('data-result') === '')!;
    assert.equal(all.attrs.get('aria-pressed'), 'true', 'par défaut : Tous');
    denied.click();
    await flush();
    assert.equal(denied.attrs.get('aria-pressed'), 'true');
    assert.equal(all.attrs.get('aria-pressed'), 'false');
    assert.equal(new URLSearchParams(calls.filter((c) => c.path.startsWith('/api/access/events?')).at(-1)!.path.split('?')[1]).get('result'), 'denied');
    assert.equal(fakeLocation.hash, '#/acces/journal?result=denied');
    view.hide();
  });

  it('titres de l’écran : un titre de niveau 2 par onglet, pour les lecteurs d’écran', async () => {
    const { view, container } = setup();
    await view.show(container, '');
    await flush();
    const h2 = container.findAll((e) => e.tagName === 'h2' && e.className === 'sr-only').map((e) => text(e));
    assert.deepEqual(h2, ['Journal des passages', 'Portes']);
    view.hide();
  });

  it('export CSV : mêmes filtres, téléchargement, message « limité à 100 000 lignes » si tronqué', async () => {
    const { view, container } = setup();
    await view.show(container, '');
    await flush();
    const urls: string[] = [];
    const realFetch = g.fetch;
    const realTimeout = g.setTimeout;
    g.setTimeout = () => 0; // la libération du fichier (10 s) ne retient pas le test
    let truncated = '0';
    g.fetch = async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, headers: { get: (k: string) => ({ 'X-Export-Rows': '100000', 'X-Export-Truncated': truncated, 'Content-Disposition': 'attachment; filename="passages.csv"' })[k] ?? null }, blob: async () => new Blob(['a;b']) };
    };
    try {
      const button = byText(container, 'button', 'Exporter en CSV')!;
      button.click();
      await flush(10);
      assert.equal(urls.length, 1);
      assert.match(urls[0], /^\/api\/access\/events\.csv\?/);
      assert.ok(!/limit=|cursor=|count=/.test(urls[0]), 'export : sans pagination');
      assert.match(container.textContent, /100\u00a0000 passages exportés/);
      assert.ok(!container.textContent.includes('Export limité'));
      truncated = '1';
      button.click();
      await flush(10);
      assert.match(container.textContent, /Export limité à 100 000 lignes, réduisez la période\./);
    } finally {
      g.fetch = realFetch;
      g.setTimeout = realTimeout;
    }
    view.hide();
  });

  it('export refusé : l’erreur du serveur est dite, le bouton redevient disponible', async () => {
    const { view, container } = setup();
    await view.show(container, '');
    await flush();
    const realFetch = g.fetch;
    g.fetch = async () => ({ ok: false, status: 403, headers: { get: () => null }, json: async () => ({ error: 'Droits insuffisants' }) });
    try {
      const button = byText(container, 'button', 'Exporter en CSV')!;
      button.click();
      await flush(10);
      assert.match(container.textContent, /L’export n’a pas pu être fait : Droits insuffisants\./);
      assert.equal(button.disabled, false);
    } finally {
      g.fetch = realFetch;
    }
    view.hide();
  });

  it('portes : les plus urgentes d’abord, état en mots, signification, dernier passage, boutons « Fiche »', async () => {
    const { view, container } = setup();
    await view.show(container, 'portes');
    await flush();
    const list = container.find((e) => e.attrs.get('aria-label') === 'Portes, les plus urgentes d’abord')!;
    const names = list.childElements.map((li) => li.find((e) => e.tagName === 'h3')!.textContent);
    assert.deepEqual(names, ['Entrée personnel', 'Stock', 'Arrière'], 'forcée, hors ligne, fermée');
    const first = list.childElements[0];
    assert.match(first.textContent, /Forcée/);
    assert.match(first.textContent, /Regardez la caméra, puis traitez l’alarme\./, 'ce que signifie l’état et quoi faire');
    assert.ok(!/Alarme en cours/.test(first.textContent), 'forcée : le mot « Forcée » suffit, pas de second badge');
    assert.ok(!first.textContent.includes('null'), 'aucun « null » écrit à la place d’un élément absent');
    assert.match(first.textContent, /Contrôleur entrée · porte n° 1/);
    assert.match(first.textContent, /Titulaire 1 — Accepté/, 'dernier passage : qui, résultat, quand');
    assert.match(list.childElements[2].textContent, /Aucun passage enregistré/);
    assert.match(container.textContent, /3 portes : 1 forcée, 1 hors ligne, 1 fermée/);
    assert.ok(first.find((e) => e.tagName === 'button' && e.attrs.get('aria-label') === 'Fiche de la porte Entrée personnel'));
    assert.equal(first.attrs.get('class')?.includes('tone-alarm'), true);
    view.hide();
  });

  it('portes : le temps réel réordonne les cartes sans refaire celles qui ne changent pas, et garde le focus', async () => {
    const { view, container, calls } = setup();
    await view.show(container, 'portes');
    await flush();
    const list = container.find((e) => e.attrs.get('aria-label') === 'Portes, les plus urgentes d’abord')!;
    const cardOf = (id: string) => list.childElements.find((li) => li.attrs.get('data-door') === id)!;
    const closedCard = cardOf('P-ARRIERE');
    const button = closedCard.find((e) => e.tagName === 'button')!;
    fakeDocument.active = button;
    // l'arrière devient « maintenue ouverte » : il remonte
    core.S.doors = new Map([DOOR_FORCED, { ...DOOR_CLOSED, state: 'held_open', stateLabel: 'Maintenue ouverte', stateHint: 'Quelqu’un retient la porte.', deviceStatus: 'prealarm' }, DOOR_OFFLINE].map((d) => [d.detectorId, d]));
    core.emit('doors', []);
    await flush();
    assert.deepEqual(list.childElements.map((li) => li.attrs.get('data-door')), ['P-ENTREE', 'P-ARRIERE', 'P-STOCK']);
    assert.equal(cardOf('P-ARRIERE'), closedCard, 'même carte, mise à jour sur place');
    assert.match(closedCard.textContent, /Maintenue ouverte/);
    assert.match(closedCard.textContent, /Quelqu’un retient la porte\./);
    assert.equal(fakeDocument.activeElement, button, 'le focus clavier reste sur le bouton');
    assert.equal(calls.filter((c) => c.path === '/api/access/doors/P-ENTREE').length, 1, 'le dernier passage n’est relu que s’il a changé');
    // une porte disparaît
    core.S.doors = new Map([[DOOR_FORCED.detectorId, DOOR_FORCED]]);
    core.emit('doors', []);
    assert.equal(list.childElements.length, 1);
    view.hide();
  });

  it('aucune porte déclarée : état vide qui explique quoi faire (administrateur, opérateur)', async () => {
    for (const admin of [true, false]) {
      const { view, container } = setup({ admin, routes: { 'GET /api/access/doors': () => [] } });
      await view.show(container, 'portes');
      await flush();
      assert.match(container.textContent, /Aucune porte déclarée pour l’instant\./);
      assert.match(container.textContent, admin ? /Déclarez d’abord un contrôleur/ : /Un administrateur déclare les contrôleurs et les portes/);
      assert.match(container.textContent, /1 détecteur de contrôle d’accès attend|2 détecteurs de contrôle d’accès attendent/);
      assert.equal(Boolean(byText(container, 'button', 'Ouvrir la déclaration')), admin);
      view.hide();
    }
  });

  it('portes illisibles : le message dit pourquoi, « Réessayer » relit', async () => {
    let fail = true;
    const { view, container } = setup({
      routes: {
        'GET /api/access/doors': () => {
          if (fail) throw new Error('Réseau coupé');
          return [DOOR_CLOSED];
        },
      },
    });
    await view.show(container, 'portes');
    await flush();
    assert.match(container.textContent, /L’état des portes n’a pas pu être lu\. Réseau coupé\./);
    fail = false;
    byText(container, 'button', 'Réessayer')!.click();
    await flush();
    assert.ok(!container.textContent.includes('n’a pas pu être lu'));
    assert.match(container.textContent, /Arrière/);
    view.hide();
  });

  it('fiche : état en grand, informations, dix derniers passages, caméra en direct, emplacement d’ouverture à distance', async () => {
    const { view, container } = setup();
    await view.show(container, 'portes');
    await flush();
    const trigger = container.find((e) => e.tagName === 'button' && e.attrs.get('aria-label') === 'Fiche de la porte Entrée personnel')!;
    fakeDocument.active = trigger;
    trigger.click();
    await flush();
    const fiche = container.find((e) => e.tagName === 'section' && e.attrs.get('aria-labelledby') === 'acc-fiche-title')!;
    assert.equal(fiche.hidden, false);
    assert.equal(container.find((e) => e.attrs.get('role') === 'tablist')!.hidden, true, 'les onglets laissent la place à la fiche');
    const t = fiche.textContent;
    assert.match(t, /Entrée personnel/);
    assert.match(t, /Forcée/);
    assert.match(t, /Regardez la caméra, puis traitez l’alarme\./);
    assert.match(t, /Contrôleur entrée/);
    assert.match(t, /n° 1 sur le contrôleur/);
    assert.match(t, /Après 5 minutes porte ouverte/);
    assert.match(t, /Issue de secours/);
    assert.match(t, /10 derniers passages/);
    assert.match(t, /Titulaire 1/);
    assert.match(t, /Refusé — badge expiré/);
    assert.match(t, /Reçu en différé/);
    assert.match(t, /Image en direct de « Caméra entrée »\./);
    assert.equal(rafActive.size, 1, 'image en direct ouverte');
    const slot = fiche.querySelector('div[data-slot="remote-open"]')!;
    assert.ok(slot, 'emplacement réservé identifié');
    assert.equal(text(slot), 'Ouverture à distance : pas encore disponible sur cette installation.');
    assert.equal(slot.findAll((e) => e.tagName === 'button').length, 0, 'aucun bouton d’ouverture factice');
    assert.equal(fakeLocation.hash, '#/acces/portes/P-ENTREE');
    // Échap ferme et rend le focus à l'origine
    fakeDocument.dispatch('keydown', { key: 'Escape' });
    assert.equal(fiche.hidden, true);
    assert.equal(rafActive.size, 0, 'flux arrêté à la fermeture');
    assert.equal(fakeDocument.activeElement, trigger, 'focus rendu au bouton « Fiche »');
    assert.equal(fakeLocation.hash, '#/acces/portes');
    view.hide();
  });

  it('fiche : Échap ne ferme pas la fiche quand une fenêtre est ouverte par-dessus', async () => {
    const { view, container } = setup();
    const dialog = new FakeEl('div');
    dialog.id = 'dialog';
    dialog.hidden = false;
    fakeBody.append(dialog);
    await view.show(container, 'portes/P-ENTREE');
    await flush();
    const fiche = container.find((e) => e.tagName === 'section' && e.attrs.get('aria-labelledby') === 'acc-fiche-title')!;
    fakeDocument.dispatch('keydown', { key: 'Escape' });
    assert.equal(fiche.hidden, false, 'la fenêtre se ferme d’abord');
    dialog.hidden = true;
    fakeDocument.dispatch('keydown', { key: 'Escape' });
    assert.equal(fiche.hidden, true);
    view.hide();
  });

  it('fiche d’une porte sans caméra ni passage : vides qui apprennent ; porte inconnue : message et retour', async () => {
    const { view, container } = setup({ routes: { 'GET /api/access/doors/P-ARRIERE': () => ({ door: DOOR_CLOSED, lastPassages: [], cameras: [], remote: { available: false, reason: '' } }) } });
    await view.show(container, 'portes/P-ARRIERE');
    await flush();
    assert.match(container.textContent, /Aucun passage enregistré pour cette porte\./);
    assert.match(container.textContent, /Aucune caméra n’est liée à cette porte\./);
    assert.ok(byText(container, 'a', 'Ouvrir Équipements et plan'));
    assert.equal(rafActive.size, 0);
    view.hide();

    const second = setup();
    await second.view.show(second.container, 'portes/P-FANTOME');
    await flush();
    assert.match(second.container.textContent, /Porte introuvable/);
    assert.match(second.container.textContent, /n’est pas déclarée/);
    assert.ok(byText(second.container, 'button', 'Retour aux portes'));
    byText(second.container, 'button', 'Retour aux portes')!.click();
    assert.match(second.container.textContent, /Entrée personnel/, 'retour à la liste');
    second.view.hide();
  });

  it('openDoor juste après show() (le plan demande la fiche) : la fiche s’ouvre une fois l’écran prêt', async () => {
    const { view, container } = setup();
    const shown = view.show(container, '');
    view.openDoor('P-OFFLINE-INCONNUE'.slice(0, 8).replace('-', '_') + 'X'); // identifiant valide mais inconnu : ne casse rien
    await shown;
    await flush();
    view.hide();

    const again = setup();
    const p = again.view.show(again.container, '');
    again.view.openDoor('P-ENTREE');
    await p;
    await flush();
    const fiche = again.container.find((e) => e.tagName === 'section' && e.attrs.get('aria-labelledby') === 'acc-fiche-title')!;
    assert.equal(fiche.hidden, false);
    assert.match(fiche.textContent, /Entrée personnel/);
    // appel suivant, écran déjà prêt
    fakeDocument.dispatch('keydown', { key: 'Escape' });
    again.view.openDoor('P-STOCK');
    await flush();
    assert.match(fiche.textContent, /Stock/);
    again.view.openDoor('pas un identifiant!');
    assert.match(fiche.textContent, /Stock/, 'identifiant invalide ignoré');
    again.view.hide();
  });

  it('fiche : le temps réel met l’état à jour tout de suite, sans relancer l’image en direct', async () => {
    const { view, container, calls } = setup();
    await view.show(container, 'portes/P-ENTREE');
    await flush();
    const frames = rafActive.size;
    assert.equal(frames, 1);
    const fiche = container.find((e) => e.tagName === 'section' && e.attrs.get('aria-labelledby') === 'acc-fiche-title')!;
    core.S.doors = new Map([[DOOR_FORCED.detectorId, { ...DOOR_FORCED, state: 'closed', stateLabel: 'Fermée', stateHint: 'La porte est fermée. Rien à faire.', deviceStatus: 'normal' }]]);
    core.emit('doors', []);
    await flush();
    assert.match(fiche.textContent, /La porte est fermée\. Rien à faire\./);
    assert.equal(rafActive.size, 1, 'même flux');
    // un nouveau passage : la liste est relue
    const before = calls.filter((c) => c.path === '/api/access/doors/P-ENTREE').length;
    core.S.doors = new Map([[DOOR_FORCED.detectorId, { ...DOOR_FORCED, lastPassageAt: NOW }]]);
    core.emit('doors', []);
    await flush();
    assert.equal(calls.filter((c) => c.path === '/api/access/doors/P-ENTREE').length, before + 1);
    view.hide();
  });

  it('Voir les passages d’une porte : le journal filtré sur cette porte', async () => {
    const { view, container, calls } = setup();
    await view.show(container, 'portes');
    await flush();
    const card = container.find((e) => e.attrs.get('data-door') === 'P-ENTREE')!;
    card.find((e) => e.tagName === 'button' && e.attrs.get('aria-label') === 'Voir les passages de la porte Entrée personnel')!.click();
    await flush();
    const q = new URLSearchParams(calls.filter((c) => c.path.startsWith('/api/access/events?')).at(-1)!.path.split('?')[1]);
    assert.equal(q.get('door'), 'P-ENTREE');
    assert.equal(container.find((e) => e.id === 'acc-door')!.value, 'P-ENTREE');
    assert.equal(fakeLocation.hash, '#/acces/journal?door=P-ENTREE');
    view.hide();
  });

  it('déclaration : contrôleurs (identifiants oui/non, écart d’horloge), détecteur non rattaché signalé', async () => {
    const { view, container } = setup();
    await view.show(container, 'declaration');
    await flush();
    const t = container.textContent;
    assert.match(t, /Contrôleur entrée/);
    assert.match(t, /ASC1204B/);
    assert.match(t, /192\.168\.1\.50/);
    assert.match(t, /gw-site/);
    assert.match(t, /3 min en retard/);
    assert.match(t, /Plus de 2 minutes d’écart/);
    const row = container.querySelector('tr[data-controller="CTL-1"]')!;
    assert.match(row.find((e) => e.attrs.get('data-label') === 'Identifiants enregistrés')!.textContent, /Oui/);
    assert.match(t, /Ce détecteur n’est rattaché à aucun contrôleur : ses passages seront enregistrés mais la porte n’a pas d’état\./);
    assert.match(t, /Porte neuve/);
    assert.ok(!t.includes('Entrée personnel (P-ENTREE)'), 'une porte déclarée n’est pas signalée comme non rattachée');
    assert.match(t, /Conserver les passages pendant/);
    assert.match(t, /Dernière purge/);
    assert.match(t, /Hier à \d\d:\d\d : 4\u00a0200 passages supprimés\./);
    assert.match(t, /La suppression est automatique/);
    view.hide();
  });

  it('déclaration : ajout d’un contrôleur — champs en écriture seule, validation, envoi, liste relue', async () => {
    const { view, container, calls, toasts } = setup();
    await view.show(container, 'declaration');
    await flush();
    byText(container, 'button', 'Ajouter un contrôleur')!.click();
    const form = declForm(container)!;
    const inputs = form.findAll((e) => e.tagName === 'input' || e.tagName === 'select');
    const password = inputs.find((e) => e.type === 'password')!;
    assert.equal(password.attrs.get('autocomplete'), 'new-password');
    assert.equal(password.value, '', 'jamais prérempli');
    assert.match(form.textContent, /Écriture seule : le PSIM les range scellés et ne les réaffiche jamais\./);
    assert.equal(byText(form, 'button', 'Effacer les identifiants'), null, 'pas d’identifiants à effacer sur un nouveau contrôleur');

    form.dispatch('submit'); // tout vide
    await flush();
    assert.match(form.textContent, /Identifiant invalide/);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);

    const [id, name, model, host, gateway, user] = inputs.filter((e) => e.tagName === 'input');
    id.value = 'CTL-2';
    name.value = 'Contrôleur parking';
    model.value = 'ASC2204';
    host.value = 'http://10.0.0.7';
    form.dispatch('submit');
    await flush();
    assert.match(form.textContent, /Adresse invalide/);
    host.value = '10.0.0.7';
    gateway.value = 'gw-site';
    user.value = 'admin';
    form.dispatch('submit'); // identifiant sans mot de passe
    await flush();
    assert.match(form.textContent, /Renseignez l’identifiant ET le mot de passe/);
    password.value = 'S3cret!';
    form.dispatch('submit');
    await flush();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/access/controllers')!;
    assert.deepEqual(post.body, { id: 'CTL-2', name: 'Contrôleur parking', brand: 'dahua', model: 'ASC2204', host: '10.0.0.7', gatewayId: 'gw-site', credentials: { username: 'admin', password: 'S3cret!' } });
    assert.deepEqual(toasts, ['Contrôleur « Contrôleur parking » ajouté']);
    assert.equal(declForm(container), null, 'formulaire fermé');
    assert.ok(!container.textContent.includes('S3cret!'), 'le mot de passe n’est affiché nulle part');
    assert.ok(calls.filter((c) => c.path === '/api/access/controllers' && c.method === 'GET').length >= 2, 'liste relue');
    view.hide();
  });

  it('déclaration : modification d’un contrôleur — champs jamais préremplis, « Effacer les identifiants » demande confirmation', async () => {
    const { view, container, calls, dialogState } = setup({ routes: { 'PUT /api/access/controllers/': () => CONTROLLER } });
    await view.show(container, 'declaration');
    await flush();
    container.querySelector('tr[data-controller="CTL-1"]')!.find((e) => e.tagName === 'button' && text(e) === 'Modifier')!.click();
    const form = declForm(container)!;
    const fields = form.findAll((e) => e.tagName === 'input');
    assert.equal(fields[0].value, 'CTL-1');
    assert.ok(fields[0].attrs.has('readonly'), 'identifiant fixe');
    assert.equal(fields[1].value, 'Contrôleur entrée');
    assert.equal(form.find((e) => e.type === 'password')!.value, '');
    assert.equal(form.find((e) => e.type === 'text' && e.attrs.get('autocomplete') === 'off' && e.attrs.get('data-lpignore') === 'true')!.value, '');
    form.dispatch('submit'); // rien de changé
    await flush();
    assert.match(form.textContent, /Aucun changement à enregistrer\./);
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
    fields[1].value = 'Entrée principale';
    form.dispatch('submit');
    await flush();
    const put = calls.find((c) => c.method === 'PUT')!;
    assert.equal(put.path, '/api/access/controllers/CTL-1');
    assert.deepEqual(put.body, { name: 'Entrée principale' }, 'seulement ce qui a changé');

    // effacer les identifiants
    container.querySelector('tr[data-controller="CTL-1"]')!.find((e) => e.tagName === 'button' && text(e) === 'Modifier')!.click();
    const clear = byText(container, 'button', 'Effacer les identifiants')!;
    assert.ok(clear, 'visible quand le contrôleur en a');
    clear.click();
    await flush();
    assert.equal(dialogState.confirms.at(-1)?.heading, 'Effacer les identifiants de « Contrôleur entrée »');
    const last = calls.filter((c) => c.method === 'PUT').at(-1)!;
    assert.deepEqual(last.body, { credentials: null });
    view.hide();
  });

  it('déclaration : suppression d’un contrôleur confirmée ; le message du serveur (409) est affiché par la fenêtre', async () => {
    const { view, container, dialogState } = setup({
      routes: {
        'DELETE /api/access/controllers/': () => {
          throw new Error('Ce contrôleur a encore des portes');
        },
      },
    });
    await view.show(container, 'declaration');
    await flush();
    // la fenêtre de confirmation exécute l'action : l'erreur du serveur lui revient, elle l'affiche sur place
    const remove = container.querySelector('tr[data-controller="CTL-1"]')!.find((e) => e.tagName === 'button' && text(e) === 'Supprimer')!;
    remove.click();
    await flush();
    assert.equal(dialogState.confirms.length, 1);
    assert.match(dialogState.confirms[0].heading, /Supprimer le contrôleur « Contrôleur entrée »/);
    assert.equal(dialogState.confirmError, 'Ce contrôleur a encore des portes', 'message du serveur transmis tel quel à la fenêtre');
    assert.ok(container.querySelector('tr[data-controller="CTL-1"]'), 'le contrôleur reste dans la liste');
    assert.equal(fakeDocument.activeElement, remove, 'le focus revient au bouton');
    view.hide();
  });

  it('déclaration : déclarer une porte — détecteur libre, contrôleur, numéro, délai en minutes envoyé en secondes, issue de secours', async () => {
    const { view, container, calls } = setup({ routes: { 'POST /api/access/doors': () => DOOR_CLOSED } });
    await view.show(container, 'declaration');
    await flush();
    byText(container, 'button', 'Déclarer la porte')!.click(); // depuis le signalement du détecteur « Porte neuve »
    const form = declForm(container)!;
    assert.match(form.textContent, /Porte neuve \(P-NEUF\)/, 'le détecteur non rattaché est proposé');
    assert.ok(!form.textContent.includes('Entrée personnel (P-ENTREE)'), 'une porte déjà déclarée n’est pas proposée');
    const [detector, controller, number, kind] = form.findAll((e) => e.tagName === 'select');
    const [held, exit] = form.findAll((e) => e.tagName === 'input'); // le délai, puis la case « issue de secours »
    assert.equal(detector.value, 'P-NEUF', 'détecteur déjà choisi');
    assert.equal(controller.value, 'CTL-1', 'un seul contrôleur : choisi d’office');
    assert.equal(held.value, '5');
    held.value = '0,5';
    exit.checked = true;
    number.value = '2';
    kind.value = 'barrier';
    form.dispatch('submit');
    await flush();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/access/doors')!;
    assert.deepEqual(post.body, { detectorId: 'P-NEUF', controllerId: 'CTL-1', doorNo: 2, kind: 'barrier', emergencyExit: true, heldAlarmAfterS: 30 });
    view.hide();
  });

  it('déclaration : délai invalide refusé avec un message, aucune requête', async () => {
    const { view, container, calls } = setup();
    await view.show(container, 'declaration');
    await flush();
    byText(container, 'button', 'Déclarer la porte')!.click();
    const form = declForm(container)!;
    form.findAll((e) => e.tagName === 'input')[0].value = '5000';
    form.dispatch('submit');
    await flush();
    assert.match(form.textContent, /Délai trop long/);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
    view.hide();
  });

  it('déclaration : retrait d’une porte confirmé, puis liste relue', async () => {
    const { view, container, calls, dialogState } = setup({ routes: { 'DELETE /api/access/doors/': () => null } });
    await view.show(container, 'declaration');
    await flush();
    const row = container.querySelector('tr[data-door-row="P-STOCK"]')!;
    assert.match(row.textContent, /Entrepôt|Stock/);
    row.find((e) => e.tagName === 'button' && text(e) === 'Retirer')!.click();
    await flush();
    assert.equal(dialogState.confirms.at(-1)?.heading, 'Retirer la porte « Stock »');
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/api/access/doors/P-STOCK'));
    view.hide();
  });

  it('déclaration : conservation — borne 7 à 3 650 jours, envoi, message', async () => {
    const { view, container, calls, toasts } = setup({ routes: { 'PUT /api/access/settings': (c) => ({ retentionDays: (c.body as { retentionDays: number }).retentionDays, defaultDays: 90, eventCount: 1234, oldestAt: NOW, lastPurge: null }) } });
    await view.show(container, 'declaration');
    await flush();
    const input = container.find((e) => e.id === 'acc-retention')!;
    assert.equal(input.value, '90');
    const form = input.parent!.parent!;
    input.value = '3';
    form.dispatch('submit');
    await flush();
    assert.match(form.textContent, /7 jours au moins/);
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
    input.value = '120';
    form.dispatch('submit');
    await flush();
    assert.deepEqual(calls.find((c) => c.method === 'PUT')!.body, { retentionDays: 120 });
    assert.deepEqual(toasts, ['Les passages seront conservés 120 jours']);
    view.hide();
  });

  it('déclaration : raccourcir la conservation supprime des passages : confirmation demandée, rien n’est envoyé si on annule', async () => {
    const { view, container, calls, dialogState, toasts } = setup({ routes: { 'PUT /api/access/settings': (c) => ({ retentionDays: (c.body as { retentionDays: number }).retentionDays }) } });
    await view.show(container, 'declaration');
    await flush();
    const input = container.find((e) => e.id === 'acc-retention')!;
    const form = input.parent!.parent!;
    input.value = '30';
    dialogState.refuse = true;
    form.dispatch('submit');
    await flush();
    assert.equal(dialogState.confirms.at(-1)?.heading, 'Réduire la durée de conservation');
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0, 'annulé : rien d’envoyé');
    dialogState.refuse = false;
    form.dispatch('submit');
    await flush();
    assert.deepEqual(calls.find((c) => c.method === 'PUT')!.body, { retentionDays: 30 });
    assert.deepEqual(toasts, ['Les passages seront conservés 30 jours']);
    // rallonger ne demande rien ; la même valeur n'envoie rien
    const confirms = dialogState.confirms.length;
    input.value = '365';
    form.dispatch('submit');
    await flush();
    assert.equal(dialogState.confirms.length, confirms, 'allonger la durée ne supprime rien : pas de confirmation');
    assert.deepEqual(calls.filter((c) => c.method === 'PUT').at(-1)!.body, { retentionDays: 365 });
    const puts = calls.filter((c) => c.method === 'PUT').length;
    form.dispatch('submit');
    await flush();
    assert.equal(calls.filter((c) => c.method === 'PUT').length, puts);
    assert.match(form.textContent, /Aucun changement à enregistrer./);
    view.hide();
  });

  it('déclaration : sans contrôleur, « Déclarer une porte » est grisé et le dit ; liste des contrôleurs illisible : « Réessayer »', async () => {
    const empty = setup({ routes: { 'GET /api/access/controllers': () => [] } });
    await empty.view.show(empty.container, 'declaration');
    await flush();
    const add = byText(empty.container, 'button', 'Déclarer une porte')!;
    assert.equal(add.disabled, true);
    assert.equal(add.attrs.get('title'), 'Déclarez d’abord un contrôleur.');
    assert.match(empty.container.textContent, /Aucun contrôleur déclaré\./);
    empty.view.hide();

    let fail = true;
    const broken = setup({
      routes: {
        'GET /api/access/controllers': () => {
          if (fail) throw new Error('Serveur injoignable');
          return [CONTROLLER];
        },
      },
    });
    await broken.view.show(broken.container, 'declaration');
    await flush();
    assert.match(broken.container.textContent, /La liste des contrôleurs n’a pas pu être lue\. Serveur injoignable\./);
    fail = false;
    byText(broken.container, 'button', 'Réessayer')!.click();
    await flush();
    assert.ok(broken.container.querySelector('tr[data-controller="CTL-1"]'));
    broken.view.hide();
  });

  it('navigation clavier des onglets : flèches, Début, Fin ; un seul onglet dans l’ordre de tabulation', async () => {
    const { view, container } = setup();
    await view.show(container, '');
    await flush();
    const tabs = container.findAll((e) => e.attrs.get('role') === 'tab');
    tabs[0].dispatch('keydown', { key: 'ArrowRight' });
    await flush();
    assert.equal(tabs[1].attrs.get('aria-selected'), 'true');
    assert.equal(tabs[1].tabIndex, 0);
    assert.equal(tabs[0].tabIndex, -1);
    assert.equal(fakeDocument.activeElement, tabs[1]);
    tabs[1].dispatch('keydown', { key: 'End' });
    await flush();
    assert.equal(tabs[2].attrs.get('aria-selected'), 'true');
    tabs[2].dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(tabs[0].attrs.get('aria-selected'), 'true', 'boucle');
    tabs[0].dispatch('keydown', { key: 'ArrowLeft' });
    assert.equal(tabs[2].attrs.get('aria-selected'), 'true');
    for (const t of tabs) {
      const pane = container.find((e) => e.id === t.attrs.get('aria-controls'));
      assert.ok(pane, 'chaque onglet commande un panneau');
      assert.equal(pane.attrs.get('role'), 'tabpanel');
      assert.equal(pane.hidden, t.attrs.get('aria-selected') !== 'true');
    }
    view.hide();
  });

  it('autre compte sur le poste : rien de la session précédente ne reste ; reset() vide l’écran', async () => {
    let admin = true;
    const calls: string[] = [];
    const container = new FakeEl('div');
    fakeBody.append(container);
    const base = setup({ routes: {} });
    const view = A.createAccessView({
      api: async (p: string, o: { method?: string } = {}) => {
        calls.push(p);
        return base.api(p, o);
      },
      h: (tag: string, attrs: Record<string, unknown> = {}, ...children: unknown[]) => {
        const el = new FakeEl(tag);
        for (const [k, v] of Object.entries(attrs)) {
          if (v === undefined || v === null || v === false) continue;
          if (k === 'class') el.className = String(v);
          else if (k === 'text') el.textContent = String(v);
          else if (k.startsWith('on')) el.addEventListener(k.slice(2), v as Handler);
          else el.setAttribute(k, v === true ? '' : String(v));
        }
        for (const c of children.flat()) if (c) el.append(c);
        return el;
      },
      toast() {},
      getMe: () => ({ role: admin ? 'admin' : 'operator', username: admin ? 'admin' : 'garde' }),
      dialogs: base.dialogState && { open() {}, close() {}, confirm: async () => true },
    });
    await view.show(container, 'declaration');
    await flush();
    assert.match(container.textContent, /Ajouter un contrôleur/);
    view.hide();
    admin = false;
    await view.show(container, 'declaration');
    await flush();
    assert.ok(!container.textContent.includes('Ajouter un contrôleur'), 'le nouveau compte opérateur ne voit rien de la déclaration');
    assert.ok(!container.textContent.includes('192.168.1.50'));
    view.reset();
    assert.equal(container.children.length, 0);
  });

  it('retour sur l’écran : pas de doublon d’abonnement aux portes ; masqué, le temps réel ne dessine rien', async () => {
    const { view, container, calls } = setup();
    await view.show(container, 'portes');
    await flush();
    view.hide();
    const before = calls.length;
    core.S.doors = new Map([[DOOR_FORCED.detectorId, DOOR_FORCED]]);
    core.emit('doors', []);
    await flush();
    assert.equal(calls.length, before, 'écran masqué : aucun appel réseau déclenché par le temps réel');
    await view.show(container, 'portes');
    await flush();
    await view.show(container, 'portes');
    await flush();
    const list = container.find((e) => e.attrs.get('aria-label') === 'Portes, les plus urgentes d’abord')!;
    assert.equal(list.childElements.length, 3, 'chaque porte une seule fois');
    view.hide();
  });

  it('hrefs de l’écran : seulement des liens internes', async () => {
    const { view, container } = setup();
    await view.show(container, 'portes/P-ARRIERE');
    await flush();
    for (const a of container.findAll((e) => e.tagName === 'a')) assert.match(hrefOf(a), /^#\//, hrefOf(a));
    view.hide();
  });
});
