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
  armWithZone: boolean;
}
interface View {
  show: (container: unknown, sub?: string) => Promise<void>;
  hide: () => void;
  openDoor: (id: string, o?: { origin?: string }) => void;
  reset: () => void;
  refresh: () => void;
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
  CONTROLLER_LONG: string;
  LATE_LABEL: string;
  LATE_HELP: string;
  PERIOD_HINT: string;
  SEARCH_HINT: string;
  EXPORT_LABEL: string;
  EXPORT_HELP: string;
  REMOTE_FALLBACK_TEXT: string;
  REMOTE_ADMIN_HINT: string;
  DOOR_CARD_EVENT: string;
  BACK_LABELS: Record<string, string>;
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
  resultParts: (p: unknown) => { word: string; reason: string; full: string };
  resultIcon: (p: unknown) => string;
  explainController: (text: unknown) => { text: string; explained: boolean };
  incidentForDoor: (door: unknown, incidents: unknown) => { id: number; status: string; detectorId: string } | null;
  hiddenFilterCount: (f: Partial<Filters>) => number;
  moreFiltersText: (n: number) => string;
  lastPassageSentence: (p: unknown, now: number) => string;
  kindLabel: (k: unknown) => string;
  brandLabel: (b: unknown) => string;
  doorPlaceText: (door: unknown, floor?: string) => string;
  videoNoteText: (ts: unknown, now: number) => string;
  playbackSrc: (cameraId: unknown, ts: unknown) => string | null;
  playbackNoteText: (ts: unknown) => string;
  liveReasonText: (reason: unknown) => string;
  planVideo: (cameras: { id: string; name: string }[], replayableIds: unknown, ts: unknown) => { items: { id: string; name: string; replay: boolean; reason: string | null }[]; start: number };
  videoBanner: (mode: string, reason: unknown, ts: unknown, now: number) => { kind: string; title: string; detail: string };
  PLAYBACK_BEFORE_S: number;
  PLAYBACK_AFTER_S: number;
  PLAYBACK_FAILED_TEXT: string;
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
  armingFieldInfo: (o: { zone?: string; zoneArmable?: boolean; enabled?: boolean }) => { disabled: boolean; help: string; reason: string };
  armingFactInfo: (door: unknown) => { text: string; attached: boolean; armed: boolean | null } | null;
  armingNoteOf: (p: unknown) => { text: string; authorized: boolean } | null;
  parseRetention: (text: unknown) => { ok: true; days: number } | { ok: false; message: string };
  lastPurgeText: (purge: unknown, now: number) => string;
  createAccessView: (deps: Record<string, unknown>) => View;
}
const A = (await import(pathToFileURL(join(WEB, 'access.js')).href)) as Access;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const DB = (await import(pathToFileURL(join(WEB, 'doorbadges.js')).href)) as {
  BADGE_GAP: number;
  placeDoorBadges: (badges: (Rect & { id: string })[], obstacles?: (Rect & { owner?: string })[], bounds?: Rect | null, o?: { gap?: number; rows?: number }) => Map<string, { dx: number; dy: number }>;
};

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
    assert.deepEqual(A.PRESETS.map((p) => p.label), ['Aujourd’hui', 'Dernières 24 h', 'Hier', '7 derniers jours']);
  });

  it('« Aujourd’hui » commence à minuit, « Dernières 24 h » englobe la ronde de nuit', () => {
    const early = at(2026, 10, 17, 6, 40, 12); // le matin : la ronde de 23 h 30 est de la veille
    assert.equal(A.quickRange('today', early)!.from, '2026-10-17T00:00', 'depuis 00:00');
    assert.deepEqual(A.quickRange('last24', early), { from: '2026-10-16T06:40', to: '2026-10-17T06:40' });
    const roundAt = at(2026, 10, 16, 23, 30);
    const last24 = A.quickRange('last24', early)!;
    const from = A.fromInputValue(last24.from)!;
    const to = A.fromInputValue(last24.to)!;
    assert.ok(roundAt >= from && roundAt <= to, 'la ronde de 23 h 30 est dans les dernières 24 h');
    const today = A.quickRange('today', early)!;
    assert.ok(roundAt < A.fromInputValue(today.from)!, 'et pas dans « Aujourd’hui »');
    // la requête envoyée inclut la minute présente (le serveur exclut sa borne)
    const q = new URLSearchParams(A.buildEventsQuery({ ...A.defaultFilters(early), ...last24 }));
    assert.equal(q.get('to'), String(at(2026, 10, 17, 6, 41)));
  });

  it('« Dernières 24 h » reste enfoncé quelques minutes, puis se relâche ; une autre largeur ne la reconnaît pas', () => {
    const last24 = A.quickRange('last24', NOW)!;
    assert.equal(A.matchPreset(last24, NOW), 'last24');
    assert.equal(A.matchPreset(last24, NOW + 3 * 60_000), 'last24', 'trois minutes plus tard : toujours reconnu');
    assert.equal(A.matchPreset(last24, NOW + 30 * 60_000), null, 'une demi-heure plus tard : ce sont des dates saisies');
    assert.equal(A.matchPreset({ from: last24.from, to: '2026-10-17T14:00' }, NOW), null, 'pas 24 h pile');
    assert.equal(A.matchPreset({ from: '2026-10-18T14:32', to: '2026-10-19T14:32' }, NOW), null, 'dans le futur');
    assert.equal(A.matchPreset({ from: '', to: '' }, NOW), null);
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

  it('résultat : pastille courte, raison à part, nom complet conservé ; icône de refus, jamais un cadenas', () => {
    const unknown = { result: 'denied', resultLabel: 'Refusé — badge inconnu' };
    assert.deepEqual(A.resultParts(unknown), { word: 'Refusé', reason: 'Badge inconnu', full: 'Refusé — badge inconnu' });
    assert.deepEqual(A.resultParts(denied), { word: 'Refusé', reason: 'Badge expiré', full: 'Refusé — badge expiré' });
    assert.deepEqual(A.resultParts(granted), { word: 'Accepté', reason: '', full: 'Accepté' });
    assert.deepEqual(A.resultParts({ result: 'denied' }), { word: 'Refusé', reason: '', full: 'Refusé' });
    assert.deepEqual(A.resultParts({ result: 'denied', resultLabel: 'Refusé — hors horaires — porte 2' }), { word: 'Refusé', reason: 'Hors horaires — porte 2', full: 'Refusé — hors horaires — porte 2' });
    assert.equal(A.resultParts({ result: 'denied', resultLabel: '— badge inconnu' }).word, 'Refusé', 'libellé sans mot : le mot de secours');
    assert.equal(A.resultParts(null).word, 'Refusé');
    assert.equal(A.resultIcon(granted), 'state-ok');
    assert.equal(A.resultIcon(denied), 'state-denied');
    assert.notEqual(A.resultIcon(denied), 'lock');
    const sprite = read('icons.svg');
    assert.match(sprite, /<symbol[^>]*\bid="state-denied"/, 'le symbole de refus existe dans le sprite');
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

  it('relecture : adresse de la caméra à l’heure du passage (id encodé, heure entière), null si invalide', () => {
    const ts = at(2026, 10, 16, 14, 32, 5);
    assert.equal(A.playbackSrc('CAM-1', ts), `/api/cameras/CAM-1/playback?at=${ts}`);
    assert.equal(A.playbackSrc('CAM-1', ts + 0.9), `/api/cameras/CAM-1/playback?at=${ts}`, 'millisecondes entières');
    assert.equal(A.playbackSrc('a/b?x=1#y', ts), `/api/cameras/a%2Fb%3Fx%3D1%23y/playback?at=${ts}`, 'un identifiant hostile ne sort pas de son segment');
    for (const bad of [null, undefined, NaN, Infinity, -Infinity, 0, -5, '1760000000000', {}, 8.64e15 + 1]) assert.equal(A.playbackSrc('CAM-1', bad), null, String(bad));
    for (const bad of [null, undefined, '', 12, {}]) assert.equal(A.playbackSrc(bad, ts), null, String(bad));
  });

  it('relecture : bandeau « Enregistrement du JJ/MM/AAAA à HH:MM:SS (10 s avant à 20 s après) »', () => {
    assert.equal(A.PLAYBACK_BEFORE_S, 10);
    assert.equal(A.PLAYBACK_AFTER_S, 20);
    assert.equal(A.playbackNoteText(at(2026, 10, 16, 14, 32, 5)), 'Enregistrement du 16/10/2026 à 14:32:05 (10 s avant à 20 s après).');
    assert.equal(A.playbackNoteText(at(2026, 1, 2, 3, 4, 9)), 'Enregistrement du 02/01/2026 à 03:04:09 (10 s avant à 20 s après).');
    assert.equal(A.playbackNoteText(null), 'Enregistrement du passage (10 s avant à 20 s après).');
  });

  it('direct de repli : une phrase dit pourquoi', () => {
    assert.equal(A.liveReasonText('unsupported'), 'Cette caméra ne permet pas la relecture depuis le PSIM.');
    assert.match(A.liveReasonText('unverified'), /n’a pas pu vérifier/);
    assert.match(A.liveReasonText('no-time'), /L’heure du passage n’est pas connue/);
    assert.match(A.liveReasonText('failed'), /L’enregistrement n’a pas pu être lu/);
    assert.equal(A.liveReasonText('autre chose'), A.liveReasonText('unsupported'), 'raison inconnue : la phrase par défaut, jamais « undefined »');
    assert.equal(A.liveReasonText(undefined), A.liveReasonText('unsupported'));
  });

  it('choix de la caméra : la première relisible est ouverte d’abord ; les autres restent en direct avec leur raison', () => {
    const cams = [{ id: 'CAM-A', name: 'Hall' }, { id: 'CAM-B', name: 'Parking' }, { id: 'CAM-C', name: 'Quai' }];
    const ts = at(2026, 10, 16, 14, 32, 5);
    const plan = A.planVideo(cams, ['CAM-C', 'CAM-B', 'ailleurs'], ts);
    assert.equal(plan.start, 1, 'la première relisible dans l’ordre de la porte');
    assert.deepEqual(plan.items.map((c) => [c.id, c.replay, c.reason]), [['CAM-A', false, 'unsupported'], ['CAM-B', true, null], ['CAM-C', true, null]]);
    assert.deepEqual(plan.items.map((c) => c.name), ['Hall', 'Parking', 'Quai'], 'les noms sont conservés');
    assert.equal(A.planVideo(cams, [], ts).start, 0, 'aucune relisible : la première, en direct');
    assert.deepEqual(A.planVideo(cams, [], ts).items.map((c) => c.reason), ['unsupported', 'unsupported', 'unsupported']);
    // liste illisible (null, ou autre chose qu’un tableau) : tout en direct, « non vérifié »
    for (const bad of [null, undefined, 'CAM-A', { ids: ['CAM-A'] }]) {
      const p = A.planVideo(cams, bad, ts);
      assert.deepEqual(p.items.map((c) => [c.replay, c.reason]), [[false, 'unverified'], [false, 'unverified'], [false, 'unverified']]);
    }
    // heure du passage inconnue : pas de relecture possible
    assert.deepEqual(A.planVideo(cams, ['CAM-A'], null).items.map((c) => [c.replay, c.reason]), [[false, 'no-time'], [false, 'no-time'], [false, 'no-time']]);
    // éléments hostiles dans la liste : ignorés
    assert.equal(A.planVideo(cams, [null, 3, {}, 'CAM-B'], ts).start, 1);
    assert.deepEqual(A.planVideo([], ['CAM-A'], ts), { items: [], start: 0 });
    assert.deepEqual(A.planVideo(null as never, ['CAM-A'], ts), { items: [], start: 0 });
  });

  it('bandeau de la fenêtre vidéo : enregistrement, direct avec raison, ou relecture en échec', () => {
    const ts = at(2026, 10, 17, 14, 31, 5);
    const rec = A.videoBanner('playback', null, ts, NOW);
    assert.equal(rec.kind, 'info');
    assert.equal(rec.title, 'Enregistrement du 17/10/2026 à 14:31:05 (10 s avant à 20 s après).');
    assert.doesNotMatch(`${rec.title} ${rec.detail}`, /Image en direct/);
    const live = A.videoBanner('live', 'unsupported', ts, NOW);
    assert.equal(live.kind, 'warning');
    assert.equal(live.title, 'Image en direct, pas l’enregistrement de 14:31.');
    assert.equal(live.detail, 'Cette caméra ne permet pas la relecture depuis le PSIM.');
    const failed = A.videoBanner('failed', 'failed', ts, NOW);
    assert.equal(failed.kind, 'warning');
    assert.equal(failed.title, 'Enregistrement indisponible.');
    assert.equal(failed.detail, A.PLAYBACK_FAILED_TEXT);
    assert.match(A.PLAYBACK_FAILED_TEXT, /aucun enregistrement à cette heure, ou l’enregistreur ne répond pas/);
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

  it('filtres cachés : le bouton « Plus de filtres » dit combien sont posés', () => {
    assert.equal(A.hiddenFilterCount(base()), 0);
    assert.equal(A.hiddenFilterCount(base({ holder: 'Konan' })), 1);
    assert.equal(A.hiddenFilterCount(base({ holder: ' ' })), 0, 'des espaces ne filtrent rien');
    assert.equal(A.hiddenFilterCount(base({ holder: 'Konan', credential: '00', late: true })), 3);
    assert.equal(A.hiddenFilterCount(base({ door: 'P1', result: 'denied' })), 0, 'porte et résultat sont toujours visibles');
    assert.equal(A.moreFiltersText(0), 'Plus de filtres');
    assert.equal(A.moreFiltersText(2), 'Plus de filtres (2)');
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
    // une date vide est refusée (chercher sans borne relirait tout le journal)
    const both = A.filterProblems(base());
    assert.equal(both.length, 1);
    assert.equal(both[0].field, 'from');
    assert.match(both[0].message, /dates de début et de fin sont vides/);
    const noFrom = A.filterProblems(base({ to: '2026-10-17T18:00' }));
    assert.deepEqual(noFrom.map((p) => p.field), ['from']);
    assert.match(noFrom[0].message, /La date de début est vide ou incomplète : choisissez un jour et une heure\./);
    const noTo = A.filterProblems(base({ from: '2026-10-17T08:00' }));
    assert.deepEqual(noTo.map((p) => p.field), ['to']);
    assert.match(noTo[0].message, /La date de fin est vide ou incomplète/);
    assert.deepEqual(A.filterProblems(base({ from: '2026-10-17T08:00', to: '2026-10-17T18:00' })), [], 'deux dates : rien à dire');
    const reversed = A.filterProblems(base({ from: '2026-10-17T18:00', to: '2026-10-17T08:00' }));
    assert.equal(reversed.length, 1);
    assert.equal(reversed[0].field, 'from');
    assert.match(reversed[0].message, /début est après la date de fin/);
    assert.deepEqual(A.filterProblems(base({ from: '2026-10-17T08:00', to: '2026-10-17T08:00' })), [], 'une minute exactement est permise');
    const dates = { from: '2026-10-17T08:00', to: '2026-10-17T18:00' };
    assert.equal(A.filterProblems(base({ ...dates, from: 'x' }))[0].field, 'from');
    assert.equal(A.filterProblems(base({ ...dates, to: 'x' }))[0].field, 'to');
    assert.equal(A.filterProblems(base({ ...dates, holder: 'x'.repeat(65) }))[0].field, 'holder');
    assert.equal(A.filterProblems(base({ ...dates, credential: 'x'.repeat(33) }))[0].field, 'credential');
    assert.equal(A.filterProblems(base({ ...dates, door: 'a b' }))[0].field, 'door');
    assert.equal(A.filterProblems(base({ ...dates, result: 'zzz' }))[0].field, 'result');
    assert.equal(A.filterProblems(base({ ...dates, holder: 'x'.repeat(64), credential: 'y'.repeat(32) })).length, 0, 'les bornes exactes passent');
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

  it('texte du serveur : la première mention de « contrôleur » est expliquée, une seule fois', () => {
    const offline = A.explainController('Le PSIM n’a plus de nouvelles de cette porte. Faites vérifier l’alimentation et le réseau du contrôleur.');
    assert.equal(offline.text, 'Le PSIM n’a plus de nouvelles de cette porte. Faites vérifier l’alimentation et le réseau du boîtier de contrôle d’accès (contrôleur).');
    assert.equal(offline.explained, true);
    const fault = A.explainController('Faites vérifier le contrôleur et le lecteur, puis le contrôleur.');
    assert.equal(fault.text, 'Faites vérifier le boîtier de contrôle d’accès (contrôleur) et le lecteur, puis le contrôleur.', 'seule la première mention');
    assert.equal(A.explainController('Contrôleur muet.').text, 'Boîtier de contrôle d’accès (contrôleur) muet.', 'début de phrase : majuscule');
    assert.deepEqual(A.explainController('La porte est fermée. Rien à faire.'), { text: 'La porte est fermée. Rien à faire.', explained: false });
    assert.deepEqual(A.explainController('Le boîtier de contrôle d’accès (contrôleur) est muet.'), { text: 'Le boîtier de contrôle d’accès (contrôleur) est muet.', explained: false }, 'déjà expliqué');
    assert.deepEqual(A.explainController(null), { text: '', explained: false });
  });

  it('carte d’ouverture à distance : texte de repli, nom de l’évènement du contrat', () => {
    assert.equal(A.REMOTE_FALLBACK_TEXT, 'Ouverture à distance : aucune serrure ou barrière n’est reliée à cette porte.');
    assert.equal(A.REMOTE_ADMIN_HINT + 'Déclaration.', 'Reliez-en une dans Déclaration.');
    assert.equal(A.DOOR_CARD_EVENT, 'psim:door-card');
  });

  it('« Aller à l’alarme » : l’incident en cours d’une porte qui sonne, sinon rien', () => {
    const incidents = new Map([
      [1, { id: 1, detectorId: 'P1', status: 'closed', openedAt: 900 }],
      [2, { id: 2, detectorId: 'P1', status: 'acked', openedAt: 1000 }],
      [3, { id: 3, detectorId: 'P1', status: 'open', openedAt: 800 }],
      [4, { id: 4, detectorId: 'P2', status: 'open', openedAt: 5000 }],
    ]);
    const forced = { detectorId: 'P1', state: 'forced', deviceStatus: 'alarm' };
    assert.equal(A.incidentForDoor(forced, incidents)?.id, 3, 'le non acquitté d’abord');
    assert.equal(A.incidentForDoor({ ...forced, state: 'held_open', deviceStatus: 'prealarm' }, incidents)?.id, 3);
    assert.equal(A.incidentForDoor({ detectorId: 'P1', state: 'closed', deviceStatus: 'alarm' }, incidents)?.id, 3, 'détecteur en alarme, même porte fermée');
    assert.equal(A.incidentForDoor({ detectorId: 'P1', state: 'closed', deviceStatus: 'prealarm' }, incidents)?.id, 3);
    assert.equal(A.incidentForDoor({ detectorId: 'P1', state: 'closed', deviceStatus: 'normal' }, incidents), null, 'porte calme : pas de bouton');
    assert.equal(A.incidentForDoor({ detectorId: 'P1', state: 'open', deviceStatus: 'normal' }, incidents), null);
    assert.equal(A.incidentForDoor({ detectorId: 'P9', state: 'forced', deviceStatus: 'alarm' }, incidents), null, 'aucun incident pour ce détecteur');
    assert.equal(A.incidentForDoor(forced, new Map([[1, { id: 1, detectorId: 'P1', status: 'closed' }]])), null, 'incident clos : rien à ouvrir');
    assert.equal(A.incidentForDoor(forced, [{ id: 7, detectorId: 'P1', status: 'acked', openedAt: 1 }])?.id, 7, 'une liste convient aussi');
    for (const bad of [null, undefined, {}, { state: 'forced' }]) assert.equal(A.incidentForDoor(bad, incidents), null);
    for (const bad of [null, undefined, 'x', 3]) assert.equal(A.incidentForDoor(forced, bad), null);
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
    assert.equal(A.JOURNAL_NOTE, 'Les recherches par nom ou par badge et les exports sont notés dans le journal des actions du PSIM.');
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
    assert.deepEqual(A.emptyDoorForm(), { detectorId: '', controllerId: '', doorNo: '1', kind: 'door', emergencyExit: false, heldMinutes: '5', armWithZone: false });
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

  it('armement : `armWithZone` n’est envoyé que s’il a changé', () => {
    assert.equal('armWithZone' in A.doorBody(good()), false, 'création sans la case : rien envoyé');
    assert.equal(A.doorBody(good({ armWithZone: true })).armWithZone, true, 'création avec la case');
    const original = { detectorId: 'P1', controllerId: 'CTL-1', doorNo: 1, kind: 'door', emergencyExit: false, heldAlarmAfterS: 300, armWithZone: false };
    const same = A.doorFormFrom({ ...original, arming: { enabled: false, zone: 'Hall', zoneArmable: true, armedNow: null } });
    assert.equal(same.armWithZone, false);
    assert.deepEqual(A.doorBody(same, { editing: true, original }), {}, 'inchangé : rien');
    assert.deepEqual(A.doorBody({ ...same, armWithZone: true }, { editing: true, original }), { armWithZone: true });
    const armed = { ...original, armWithZone: true };
    assert.deepEqual(A.doorBody({ ...same, armWithZone: true }, { editing: true, original: armed }), {});
    assert.deepEqual(A.doorBody({ ...same, armWithZone: false }, { editing: true, original: armed }), { armWithZone: false }, 'décocher est envoyé');
    assert.equal(A.doorFormFrom({ ...original, arming: { enabled: true, zone: 'Hall', zoneArmable: true, armedNow: true } }).armWithZone, true);
    assert.equal(A.doorFormFrom(original).armWithZone, false, 'ancien serveur sans `arming`');
  });
});

describe('écran « Accès » : armement des portes (F14), textes', () => {
  it('case : active avec une zone armable, désactivée et expliquée sinon', () => {
    const ok = A.armingFieldInfo({ zone: 'Hall', zoneArmable: true });
    assert.equal(ok.disabled, false);
    assert.equal(ok.reason, '');
    assert.match(ok.help, /Quand la zone « Hall » est armée \(écran Armement\), toute ouverture de cette porte donne une pré-alarme/);
    assert.match(ok.help, /Une porte forcée reste une alarme\./);
    const none = A.armingFieldInfo({ zone: '  ', zoneArmable: true });
    assert.equal(none.disabled, true);
    assert.equal(none.reason, 'Cette porte n’est dans aucune zone : choisissez-en une dans sa fiche d’équipement.');
    const flat = A.armingFieldInfo({ zone: 'Hall', zoneArmable: false });
    assert.equal(flat.disabled, true);
    assert.equal(flat.reason, 'Cette zone n’a pas d’armement : ajoutez-y un détecteur d’intrusion ou réglez-la dans l’écran Armement.');
    assert.equal(A.armingFieldInfo({ zone: '', zoneArmable: false, enabled: true }).disabled, false, 'une porte déjà rattachée peut toujours être décochée');
  });

  it('ligne de la fiche : non rattachée, armée, désarmée, inconnue, ancien serveur', () => {
    const door = (arming: unknown) => ({ detectorId: 'P1', arming });
    assert.equal(A.armingFactInfo(door({ enabled: false, zone: 'Hall', zoneArmable: true, armedNow: null }))!.text, 'Non rattachée');
    const on = A.armingFactInfo(door({ enabled: true, zone: 'Hall', zoneArmable: true, armedNow: true }))!;
    assert.equal(on.text, 'Rattachée à la zone « Hall » — armée maintenant');
    assert.equal(on.armed, true);
    assert.equal(A.armingFactInfo(door({ enabled: true, zone: 'Hall', zoneArmable: true, armedNow: false }))!.text, 'Rattachée à la zone « Hall » — désarmée maintenant');
    assert.equal(A.armingFactInfo(door({ enabled: true, zone: 'Hall', zoneArmable: true, armedNow: null }))!.text, 'Rattachée à la zone « Hall »');
    assert.equal(A.armingFactInfo({ detectorId: 'P1' }), null, 'ancien serveur : pas de ligne, pas d’erreur');
    assert.equal(A.armingFactInfo(null), null);
  });

  it('note de passage : autorisée, non autorisée, absente', () => {
    const ok = A.armingNoteOf({ arming: { authorized: true, groupId: 3, groupName: 'Nuit', label: 'Ouverture pendant l’armement : autorisée, groupe Nuit' } })!;
    assert.deepEqual(ok, { text: 'Ouverture pendant l’armement : autorisée, groupe Nuit', authorized: true });
    const no = A.armingNoteOf({ arming: { authorized: false, groupId: null, groupName: null, label: 'Ouverture pendant l’armement : non autorisée' } })!;
    assert.equal(no.authorized, false);
    assert.equal(no.text, 'Ouverture pendant l’armement : non autorisée');
    assert.equal(A.armingNoteOf({ arming: null }), null);
    assert.equal(A.armingNoteOf({}), null, 'ancien serveur');
    assert.equal(A.armingNoteOf(null), null);
  });
});

// ================================================================================================ pastilles de portes du plan

describe('plan : placement des pastilles d’état des portes (doorbadges.js)', () => {
  const badge = (id: string, x: number, y: number, w = 90, h = 25) => ({ id, x, y, w, h });
  const moved = (b: Rect & { id: string }, m: Map<string, { dx: number; dy: number }>): Rect => ({ x: b.x + m.get(b.id)!.dx, y: b.y + m.get(b.id)!.dy, w: b.w, h: b.h });
  const touch = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const SHEET = { x: 0, y: 0, w: 254, h: 152 };

  it('rien ne gêne : aucune pastille ne bouge', () => {
    const badges = [badge('A', 10, 10), badge('B', 120, 10), badge('C', 10, 90)];
    const out = DB.placeDoorBadges(badges, [], SHEET);
    assert.deepEqual([...out.entries()], [['A', { dx: 0, dy: 0 }], ['B', { dx: 0, dy: 0 }], ['C', { dx: 0, dy: 0 }]]);
  });

  it('deux pastilles qui se recouvrent : la plus urgente (la première) reste, l’autre descend d’un rang, sans toucher la première', () => {
    const a = badge('A', 50, 40);
    const b = badge('B', 70, 45);
    const out = DB.placeDoorBadges([a, b], [], { x: 0, y: 0, w: 400, h: 400 });
    assert.deepEqual(out.get('A'), { dx: 0, dy: 0 }, 'la plus urgente garde sa place');
    assert.ok(out.get('B')!.dy > 0 || out.get('B')!.dx !== 0, 'l’autre s’écarte');
    assert.equal(touch(moved(a, out), moved(b, out)), false);
    // l'ordre de priorité est celui de la liste : inversé, c'est B qui garde sa place
    const flipped = DB.placeDoorBadges([b, a], [], { x: 0, y: 0, w: 400, h: 400 });
    assert.deepEqual(flipped.get('B'), { dx: 0, dy: 0 });
    assert.notDeepEqual(flipped.get('A'), { dx: 0, dy: 0 });
  });

  it('des portes serrées (cinq pastilles dans un petit plan, comme à 1024 px) : jamais deux pastilles l’une sur l’autre, toutes dans la largeur du plan', () => {
    const badges = [badge('P-LIVRAISON', 0, 122, 86, 30), badge('P-BARRIERE', 96, 110, 128), badge('P-ENTREE', 0, 76, 87), badge('P-SERVEURS', 151, 113, 104), badge('P-ISSUE', 108, 155, 89)];
    const out = DB.placeDoorBadges(badges, [], SHEET);
    assert.equal(out.size, 5, 'chacune a un décalage');
    const rects = badges.map((b) => moved(b, out));
    for (let i = 0; i < rects.length; i++) {
      assert.ok(rects[i].x >= SHEET.x - 0.5 && rects[i].x + rects[i].w <= SHEET.x + SHEET.w + 0.5, `${badges[i].id} reste dans la largeur du plan`);
      for (let j = i + 1; j < rects.length; j++) assert.equal(touch(rects[i], rects[j]), false, `${badges[i].id} / ${badges[j].id} ne se recouvrent pas`);
    }
  });

  it('jamais très loin de sa porte : au plus trois rangs et deux demi-largeurs', () => {
    const badges = Array.from({ length: 6 }, (_, i) => badge(`D${i}`, 40 + i * 4, 40 + i * 2));
    const out = DB.placeDoorBadges(badges, [], { x: 0, y: 0, w: 600, h: 600 });
    for (const b of badges) {
      const { dx, dy } = out.get(b.id)!;
      assert.ok(Math.abs(dy) <= 3 * (b.h + DB.BADGE_GAP), `${b.id} : ${dy}`);
      assert.ok(Math.abs(dx) <= 2 * Math.round(b.w * 0.5), `${b.id} : ${dx}`);
    }
  });

  it('une pastille qui déborde à gauche ou à droite du plan est ramenée dedans', () => {
    const out = DB.placeDoorBadges([badge('L', -30, 10), badge('R', 200, 60)], [], SHEET);
    assert.equal(out.get('L')!.dx, 30);
    assert.equal(out.get('R')!.dx, 254 - (200 + 90));
    assert.equal(DB.placeDoorBadges([badge('X', 5, 5)], [], null).get('X')!.dx, 0, 'sans zone, pas de rabattement');
  });

  it('elle évite la forme d’un équipement voisin quand un rang plus bas suffit', () => {
    const glyph = { x: 60, y: 42, w: 24, h: 24 };
    const out = DB.placeDoorBadges([badge('A', 50, 40)], [glyph], { x: 0, y: 0, w: 400, h: 400 });
    const rect = moved(badge('A', 50, 40), out);
    assert.equal(touch(rect, glyph), false);
    assert.ok(out.get('A')!.dy > 0 || out.get('A')!.dx !== 0);
    // ses propres pièces (même propriétaire) ne comptent pas à la place naturelle
    const own = DB.placeDoorBadges([badge('A', 50, 40)], [{ ...glyph, owner: 'A' }], { x: 0, y: 0, w: 400, h: 400 });
    assert.deepEqual(own.get('A'), { dx: 0, dy: 0 });
  });

  it('près du bord bas du plan : elle passe au-dessus plutôt que de sortir du plan', () => {
    const low = badge('B', 100, 140);
    const out = DB.placeDoorBadges([low], [], SHEET);
    assert.ok(out.get('B')!.dy < 0, `remontée : ${out.get('B')!.dy}`);
    assert.ok(moved(low, out).y + low.h <= SHEET.h + 2);
  });

  it('données absurdes : aucune exception, les pastilles valides sont quand même placées', () => {
    const out = DB.placeDoorBadges([null, { id: 3, x: 1, y: 1, w: 1, h: 1 }, badge('N', Number.NaN, 1), badge('OK', 1, 1)] as never, [null, { x: Number.NaN, y: 0, w: 1, h: 1 }, 'x'] as never, SHEET);
    assert.deepEqual([...out.keys()], ['OK']);
    assert.equal(DB.placeDoorBadges('x' as never, 'y' as never).size, 0);
    assert.equal(DB.placeDoorBadges(undefined as never).size, 0);
    assert.equal(DB.placeDoorBadges([], [], SHEET).size, 0);
  });

  it('un plan saturé : chacune garde un décalage fini, et le résultat est le même à chaque calcul', () => {
    const badges = Array.from({ length: 14 }, (_, i) => badge(`S${i}`, 20 + (i % 2) * 5, 30 + i));
    const tiny = { x: 0, y: 0, w: 130, h: 70 };
    const first = DB.placeDoorBadges(badges, [], tiny);
    const again = DB.placeDoorBadges(badges, [], tiny);
    assert.equal(first.size, 14);
    for (const v of first.values()) assert.ok(Number.isFinite(v.dx) && Number.isFinite(v.dy));
    assert.deepEqual([...first.entries()], [...again.entries()]);
  });

  it('CSP et sobriété : module pur (aucun accès à la page), aucun HTML ni style construit', () => {
    const js = read('doorbadges.js');
    for (const pattern of [/\bdocument\b/, /\bwindow\b/, /innerHTML/, /\.style\b/, /\bimport\b/]) assert.ok(!pattern.test(js.replace(/\/\*[\s\S]*?\*\//g, '')), String(pattern));
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
    assert.ok(!js.includes('acc-video-help'), 'la note « enregistrement ou direct » n’est plus écrite sous le tableau');
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
      'Seulement les passages reçus après coupure',
      'Exporter (tableur)',
      'Voir la vidéo du passage de',
      'Plus récents',
      'Plus anciens',
      'Reçu après coupure',
      'Aucun passage sur cette période.',
      'Les passages arrivent des boîtiers de contrôle d’accès déclarés dans l’onglet Déclaration.',
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
      'décide seul d’ouvrir la porte pour un badge',
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
    assert.match(app, /createAccessView\(\{\s*api,\s*h,\s*toast,\s*getMe: \(\) => S\.me,\s*dialogs,[\s\S]*?goToAlarm:/);
    assert.match(app, /goToPlan: \(\) => \{/);
    assert.match(app, /accessView\.refresh\(\)/);
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
  dispatchEvent(event: { type: string }) {
    for (const fn of docListeners.get(event.type) ?? []) fn(event as unknown as Record<string, unknown>);
    return true;
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
  S: { doors: Map<string, Door>; devices: Map<string, Record<string, unknown>>; floors: unknown[]; incidents: Map<number, Record<string, unknown>> };
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
/** Boutons « Vidéo » du journal : nom accessible « Voir la vidéo du passage de HH:MM ». */
const videoButtons = (root: FakeEl) => root.findAll((e) => e.tagName === 'button' && (e.attrs.get('aria-label') ?? '').startsWith('Voir la vidéo du passage de'));
const videoButton = (root: FakeEl) => videoButtons(root)[0] ?? null;
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
function setup(opts: { admin?: boolean; routes?: Record<string, (call: Call) => unknown>; deps?: Record<string, unknown> } = {}) {
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
    'GET /api/cameras/replayable': () => ({ ids: [] }),
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
  const view = A.createAccessView({ api, h, toast: (m: string) => void toasts.push(m), getMe: () => ({ role: admin ? 'admin' : 'operator', username: admin ? 'admin' : 'garde' }), dialogs, ...opts.deps });
  return { view, container, calls, toasts, dialogState, dialogBody, api };
}

describe('écran « Accès » : la vue dans un DOM minimal', () => {
  beforeEach(() => {
    core.S.doors = new Map();
    core.S.floors = [];
    core.S.incidents = new Map();
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
    assert.deepEqual(container.findAll((e) => e.tagName === 'th').map((e) => text(e)), ['Date et heure', 'Porte', 'Entrée / sortie', 'Titulaire', 'Moyen d’accès', 'Résultat', 'Vidéo'], 'en-têtes en français courant');
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
    assert.match(body, /Refusé — badge inconnu/, 'résultat du serveur, tel quel (nom lu par les lecteurs d’écran)');
    assert.match(body, /Accepté/);
    assert.match(body, /Reçu après coupure/);
    assert.ok(!/différé/.test(body), 'plus de « différé » à l’écran');
    assert.match(body, /Titulaire inconnu/);
    assert.match(body, /Les recherches par nom ou par badge et les exports sont notés dans le journal des actions du PSIM\./);
    assert.match(body, /Les passages sont conservés 90 jours/, 'durée de conservation visible de tous');
    const videos = videoButtons(container);
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
    assert.match(container.textContent, /Les passages arrivent des boîtiers de contrôle d’accès déclarés dans l’onglet Déclaration\./);
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

  it('« Voir la vidéo » : caméra non relisible = image en direct de la caméra de la porte, avec la mise en garde et la raison ; flux arrêtés à la fermeture', async () => {
    const { view, container, dialogState, calls } = setup();
    await view.show(container, '');
    await flush();
    const open = videoButton(container)!;
    fakeDocument.active = open;
    open.click();
    assert.equal(dialogState.open, true, 'la fenêtre s’ouvre tout de suite');
    assert.match(dialogState.heading, /Entrée personnel/);
    const content = dialogState.content as FakeEl;
    assert.match(content.textContent, /Recherche de l’enregistrement/);
    await flush();
    assert.equal(calls.filter((c) => c.path === '/api/cameras/replayable').length, 1, 'la liste des caméras relisibles est lue une fois à l’ouverture');
    assert.match(content.textContent, /Image en direct, pas l’enregistrement de \d\d:\d\d\./);
    assert.match(content.textContent, /Cette caméra ne permet pas la relecture depuis le PSIM\./);
    assert.equal(content.findAll((e) => e.tagName === 'img' && e.attrs.has('src')).length, 0, 'aucune relecture demandée');
    assert.equal(rafActive.size, 1, 'un flux ouvert');
    dialogState.onClose?.();
    assert.equal(rafActive.size, 0, 'flux arrêté à la fermeture de la fenêtre');
    view.hide();
  });

  describe('« Voir la vidéo » : relecture de l’enregistrement', () => {
    const REPLAYABLE = { 'GET /api/cameras/replayable': () => ({ ids: ['CAM-1'] }) };
    const openFirst = async (opts: Parameters<typeof setup>[0] = {}) => {
      const ctx = setup({ ...opts, routes: { ...REPLAYABLE, ...opts.routes } });
      await ctx.view.show(ctx.container, '');
      await flush();
      videoButton(ctx.container)!.click();
      await flush();
      return { ...ctx, content: ctx.dialogState.content as FakeEl };
    };
    const playbackImg = (content: FakeEl) => content.find((e) => e.tagName === 'img')!;

    it('caméra relisible : image de relecture à l’heure du passage, bandeau « Enregistrement du … », rien en direct', async () => {
      const { view, content, dialogState } = await openFirst();
      const img = playbackImg(content);
      assert.equal(img.attrs.get('src'), `/api/cameras/CAM-1/playback?at=${NOW - 60_000}`, 'l’heure du contrôleur du passage, en millisecondes');
      assert.equal(img.hidden, false);
      assert.match(img.attrs.get('alt') ?? '', /Enregistrement : Caméra entrée/);
      assert.match(content.textContent, /Enregistrement du 17\/10\/2026 à 14:31:05 \(10 s avant à 20 s après\)\./);
      assert.match(content.textContent, /Enregistrement de « Caméra entrée » \(10 s avant, 20 s après le passage\)\./);
      assert.doesNotMatch(content.textContent, /Image en direct/);
      assert.doesNotMatch(content.textContent, /Recherche de l’enregistrement/, 'le message d’attente a disparu');
      assert.equal(rafActive.size, 0, 'aucun flux en direct ouvert');
      assert.equal(content.find((e) => e.tagName === 'canvas')!.hidden, true);
      assert.equal(byText(content, 'button', 'Voir l’image en direct')!.parent!.hidden, true, 'bouton de repli caché tant que la relecture marche');
      dialogState.onClose?.();
      assert.match(img.attrs.get('src') ?? '', /^data:image\/gif/, 'fermeture : la source est vidée, le navigateur coupe la connexion');
      view.hide();
    });

    it('échec de la relecture : message clair et bouton « Voir l’image en direct », qui bascule sur le direct avec la raison', async () => {
      const { view, content } = await openFirst();
      const img = playbackImg(content);
      img.dispatch('error');
      assert.match(content.textContent, /L’enregistrement n’a pas pu être lu : aucun enregistrement à cette heure, ou l’enregistreur ne répond pas\./);
      assert.match(content.textContent, /Enregistrement indisponible\./);
      assert.equal(img.hidden, true);
      const live = byText(content, 'button', 'Voir l’image en direct')!;
      assert.ok(live, 'bouton de repli');
      assert.equal(live.parent!.hidden, false);
      assert.equal(rafActive.size, 0);
      live.click();
      assert.equal(rafActive.size, 1, 'image en direct ouverte');
      assert.match(content.textContent, /Image en direct, pas l’enregistrement de 14:31\./);
      assert.match(content.textContent, /L’enregistrement n’a pas pu être lu : vous voyez la caméra telle qu’elle est maintenant\./);
      assert.match(content.textContent, /Image en direct de « Caméra entrée »\./);
      assert.equal(live.parent!.hidden, true, 'le bouton disparaît une fois le direct affiché');
      assert.match(img.attrs.get('src') ?? '', /^data:image\/gif/, 'la relecture en erreur est coupée');
      view.hide();
      assert.equal(rafActive.size, 0);
    });

    it('une erreur de l’image arrivée après la coupure ne change plus rien', async () => {
      const { view, content, dialogState } = await openFirst();
      const img = playbackImg(content);
      dialogState.onClose?.();
      img.dispatch('error');
      assert.doesNotMatch(content.textContent, /Enregistrement indisponible/);
      view.hide();
    });

    it('plusieurs caméras liées : la première relisible s’ouvre, le choix change de caméra (enregistrement ou direct avec la raison)', async () => {
      const doors = () => [{ ...DOOR_FORCED, cameraIds: ['CAM-2', 'CAM-1'] }];
      const ctx = setup({ routes: { ...REPLAYABLE, 'GET /api/access/doors': doors } });
      core.S.devices.set('CAM-2', { id: 'CAM-2', kind: 'camera', name: 'Caméra couloir', zone: 'Couloir', streamKind: 'sim' });
      await ctx.view.show(ctx.container, '');
      await flush();
      videoButton(ctx.container)!.click();
      await flush();
      const content = ctx.dialogState.content as FakeEl;
      const pickers = content.findAll((e) => e.tagName === 'button' && e.attrs.has('aria-pressed'));
      assert.deepEqual(pickers.map((b) => b.textContent.trim()), ['Caméra couloir', 'Caméra entrée']);
      assert.deepEqual(pickers.map((b) => b.attrs.get('aria-pressed')), ['false', 'true'], 'la caméra relisible est ouverte d’abord, même en seconde position');
      assert.match(pickers[0].attrs.get('title') ?? '', /Image en direct/);
      assert.match(pickers[1].attrs.get('title') ?? '', /Enregistrement/);
      const img = playbackImg(content);
      assert.equal(img.attrs.get('src'), `/api/cameras/CAM-1/playback?at=${NOW - 60_000}`);
      pickers[0].click(); // caméra non relisible : direct, avec la phrase qui dit pourquoi
      assert.equal(rafActive.size, 1);
      assert.match(img.attrs.get('src') ?? '', /^data:image\/gif/, 'la relecture est coupée');
      assert.match(content.textContent, /Image en direct, pas l’enregistrement de 14:31\./);
      assert.match(content.textContent, /Cette caméra ne permet pas la relecture depuis le PSIM\./);
      assert.match(content.textContent, /Image en direct de « Caméra couloir »\./);
      pickers[1].click(); // retour à la caméra relisible
      assert.equal(rafActive.size, 0, 'le direct est coupé');
      assert.equal(img.attrs.get('src'), `/api/cameras/CAM-1/playback?at=${NOW - 60_000}`);
      assert.match(content.textContent, /Enregistrement du 17\/10\/2026 à 14:31:05/);
      ctx.view.hide();
    });

    it('liste des caméras relisibles illisible : image en direct, et la fenêtre dit qu’elle n’a pas pu vérifier', async () => {
      const { view, content } = await openFirst({ routes: { 'GET /api/cameras/replayable': () => { throw new Error('Serveur indisponible'); } } });
      assert.equal(content.findAll((e) => e.tagName === 'img' && e.attrs.has('src')).length, 0);
      assert.equal(rafActive.size, 1);
      assert.match(content.textContent, /Image en direct, pas l’enregistrement de 14:31\./);
      assert.match(content.textContent, /n’a pas pu vérifier si cette caméra se relit/);
      view.hide();
      for (const body of [{}, { ids: 'CAM-1' }, null]) {
        const again = await openFirst({ routes: { 'GET /api/cameras/replayable': () => body } });
        assert.equal(again.content.findAll((e) => e.tagName === 'img' && e.attrs.has('src')).length, 0, JSON.stringify(body));
        again.view.hide();
      }
    });

    it('fenêtre fermée pendant la lecture de la liste : rien ne s’ouvre après coup', async () => {
      let release!: (v: unknown) => void;
      const { view, container, dialogState } = setup({ routes: { 'GET /api/cameras/replayable': () => new Promise((r) => (release = r)) } });
      await view.show(container, '');
      await flush();
      videoButton(container)!.click();
      await flush();
      const content = dialogState.content as FakeEl;
      assert.match(content.textContent, /Recherche de l’enregistrement/);
      dialogState.onClose?.(); // l’opérateur ferme (Échap, Fermer…)
      release({ ids: ['CAM-1'] });
      await flush();
      assert.equal(content.findAll((e) => e.tagName === 'img').length, 0, 'aucune relecture démarrée');
      assert.equal(rafActive.size, 0, 'aucun flux démarré');
      view.hide();
    });

    it('seconde fenêtre ouverte avant la fin de la première lecture : la réponse tardive de la première n’écrit rien', async () => {
      const releases: ((v: unknown) => void)[] = [];
      const { view, container, dialogState } = setup({ routes: { 'GET /api/cameras/replayable': () => new Promise((r) => releases.push(r)) } });
      await view.show(container, '');
      await flush();
      const open = videoButton(container)!;
      open.click();
      const first = dialogState.content as FakeEl;
      dialogState.onClose?.();
      open.click();
      const second = dialogState.content as FakeEl;
      releases[0]({ ids: ['CAM-1'] });
      await flush();
      assert.equal(first.findAll((e) => e.tagName === 'img').length, 0);
      assert.equal(second.findAll((e) => e.tagName === 'img').length, 0, 'la seconde attend encore sa propre réponse');
      releases[1]({ ids: ['CAM-1'] });
      await flush();
      assert.equal(second.findAll((e) => e.tagName === 'img' && e.attrs.has('src')).length, 1);
      view.hide();
    });

    it('quitter l’écran pendant une relecture : fenêtre fermée, flux coupé', async () => {
      const { view, content, dialogState } = await openFirst();
      const img = playbackImg(content);
      assert.equal(img.attrs.get('src')?.startsWith('/api/cameras/'), true);
      view.hide();
      assert.equal(dialogState.open, false);
      assert.match(img.attrs.get('src') ?? '', /^data:image\/gif/, 'la relecture est coupée');
    });

    it('les noms de caméra venus du serveur restent du texte', async () => {
      const hostile = '<img src=x onerror=alert(1)>';
      core.S.devices.set('CAM-1', { id: 'CAM-1', kind: 'camera', name: hostile, zone: 'Hall', streamKind: 'sim' });
      const { view, content } = await openFirst();
      assert.ok(content.textContent.includes(hostile));
      assert.equal(content.findAll((e) => e.tagName === 'img').length, 1, 'une seule image : celle de la relecture');
      assert.equal(playbackImg(content).attrs.get('src'), `/api/cameras/CAM-1/playback?at=${NOW - 60_000}`);
      view.hide();
    });
  });

  it('quitter l’écran (alarme) ferme la fenêtre vidéo, arrête les flux et retire l’écouteur du clavier', async () => {
    const { view, container, dialogState } = setup();
    const keydownBefore = fakeDocument.count('keydown');
    await view.show(container, '');
    await flush();
    assert.equal(fakeDocument.count('keydown'), keydownBefore + 1);
    videoButton(container)!.click();
    await flush();
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
    videoButton(container)!.click();
    await flush();
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

  it('export (tableur) : mêmes filtres, téléchargement, message « limité à 100 000 lignes » si tronqué', async () => {
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
      const button = byText(container, 'button', 'Exporter (tableur)')!;
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
      const button = byText(container, 'button', 'Exporter (tableur)')!;
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
    assert.ok(first.find((e) => e.tagName === 'button' && e.attrs.get('aria-label') === 'Détails de la porte Entrée personnel'));
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
    const trigger = container.find((e) => e.tagName === 'button' && e.attrs.get('aria-label') === 'Détails de la porte Entrée personnel')!;
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
    assert.match(t, /Alarme si la porte reste ouverte/);
    assert.match(t, /Après 5 minutes d’ouverture/);
    assert.match(t, /Issue de secours/);
    assert.match(t, /10 derniers passages/);
    assert.match(t, /Titulaire 1/);
    assert.match(t, /Refusé — badge expiré/);
    assert.match(t, /Reçu après coupure/);
    assert.match(t, /Image en direct de « Caméra entrée »\./);
    assert.equal(rafActive.size, 1, 'image en direct ouverte');
    const slot = fiche.querySelector('div[data-slot="remote-open"]')!;
    assert.ok(slot, 'emplacement réservé identifié');
    assert.equal(text(slot), 'Ouverture à distance : aucune serrure ou barrière n’est reliée à cette porte.Reliez-en une dans Déclaration.', 'repli : administrateur');
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

  it('fiche : ligne « Armement avec la zone » et notes d’armement des passages', async () => {
    const armed = { ...DOOR_FORCED, arming: { enabled: true, zone: 'Hall', zoneArmable: true, armedNow: true } };
    const { view, container } = setup({
      routes: {
        'GET /api/access/doors': () => [DOOR_CLOSED, DOOR_OFFLINE, armed],
        'GET /api/access/doors/P-ENTREE': () => ({
          door: armed,
          lastPassages: [PASSAGE(1, { arming: { authorized: true, groupId: 3, groupName: 'Nuit', label: 'Ouverture pendant l’armement : autorisée, groupe Nuit' } }), PASSAGE(2, { arming: { authorized: false, groupId: null, groupName: null, label: 'Ouverture pendant l’armement : non autorisée' } }), PASSAGE(3, { arming: null })],
          cameras: [],
          remote: { available: false, reason: '' },
        }),
      },
    });
    await view.show(container, 'portes/P-ENTREE');
    await flush();
    const t = container.textContent;
    assert.match(t, /Armement avec la zone/);
    assert.match(t, /Rattachée à la zone « Hall » — armée maintenant/);
    assert.ok(byText(container, 'a', 'Ouvrir l’écran Armement'));
    assert.match(t, /Ouverture pendant l’armement : autorisée, groupe Nuit/);
    assert.match(t, /Ouverture pendant l’armement : non autorisée/);
    const notes = container.findAll((e) => e.className.includes('acc-arming-note'));
    assert.equal(notes.length, 2, 'le passage sans note n’en a pas');
    assert.ok(notes[0].className.includes('is-ok'));
    assert.ok(notes[1].className.includes('is-warning'));
    view.hide();
  });

  it('fiche d’une porte non rattachée, ou d’un ancien serveur sans `arming` : aucune erreur', async () => {
    const offDoor = { ...DOOR_FORCED, arming: { enabled: false, zone: 'Hall', zoneArmable: true, armedNow: null } };
    const off = setup({ routes: { 'GET /api/access/doors': () => [DOOR_CLOSED, DOOR_OFFLINE, offDoor], 'GET /api/access/doors/P-ENTREE': () => ({ door: offDoor, lastPassages: [PASSAGE(1)], cameras: [], remote: { available: false, reason: '' } }) } });
    await off.view.show(off.container, 'portes/P-ENTREE');
    await flush();
    assert.match(off.container.textContent, /Non rattachée/);
    assert.equal(off.container.findAll((e) => e.className.includes('acc-arming-note')).length, 0);
    off.view.hide();

    const old = setup();
    await old.view.show(old.container, 'portes/P-ENTREE');
    await flush();
    assert.doesNotMatch(old.container.textContent, /Armement avec la zone/);
    assert.match(old.container.textContent, /Titulaire 1/);
    old.view.hide();
  });

  it('journal : la note d’armement figure sur la ligne du passage concerné', async () => {
    const { view, container } = setup({
      routes: { 'GET /api/access/events': () => ({ items: [PASSAGE(1, { arming: { authorized: false, groupId: null, groupName: null, label: 'Ouverture pendant l’armement : non autorisée' } }), PASSAGE(2)], nextCursor: null, total: 2, totalCapped: false }) },
    });
    await view.show(container);
    await flush();
    const notes = container.findAll((e) => e.className.includes('acc-arming-note'));
    assert.equal(notes.length, 1);
    assert.match(notes[0].textContent, /non autorisée/);
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

    let backToPlan = 0;
    const again = setup({ deps: { goToPlan: () => void backToPlan++ } });
    const p = again.view.show(again.container, '');
    again.view.openDoor('P-ENTREE');
    await p;
    await flush();
    const fiche = again.container.find((e) => e.tagName === 'section' && e.attrs.get('aria-labelledby') === 'acc-fiche-title')!;
    assert.equal(fiche.hidden, false);
    assert.match(fiche.textContent, /Entrée personnel/);
    // Échap : la fiche vient du plan, on y retourne
    fakeDocument.dispatch('keydown', { key: 'Escape' });
    assert.equal(backToPlan, 1, 'retour au plan demandé');
    // appel suivant, écran déjà prêt
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

  it('déclaration : la case « Armer cette porte avec sa zone » (zone vide, non armable, armable) et le corps envoyé', async () => {
    const edit = async (door: Record<string, unknown>, routes: Record<string, (c: Call) => unknown> = {}) => {
      const ctx = setup({ routes: { 'GET /api/access/doors': () => [door], ...routes } });
      await ctx.view.show(ctx.container, 'declaration');
      await flush();
      ctx.container.find((e) => e.tagName === 'button' && e.attrs.get('aria-label') === `Modifier la porte ${door.name}`)!.click();
      await flush();
      const form = declForm(ctx.container)!;
      const box = form.find((e) => e.type === 'checkbox' && e.parent!.textContent.includes('Armer cette porte avec sa zone'))!;
      return { ...ctx, form, box };
    };
    const arming = (over: Record<string, unknown>) => ({ enabled: false, zone: 'Hall', zoneArmable: true, armedNow: null, ...over });

    const free = await edit({ ...DOOR_CLOSED, arming: arming({}) }, { 'PUT /api/access/doors/': () => ({}) });
    assert.equal(free.box.disabled, false);
    assert.match(free.form.textContent, /Quand la zone « Hall » est armée/);
    free.box.checked = true;
    free.form.dispatch('submit');
    await flush();
    assert.deepEqual(free.calls.find((c) => c.method === 'PUT')!.body, { armWithZone: true });
    free.view.hide();

    const empty = await edit({ ...DOOR_CLOSED, zone: '', arming: arming({ zone: '' }) });
    assert.equal(empty.box.disabled, true);
    assert.match(empty.form.textContent, /Cette porte n’est dans aucune zone : choisissez-en une dans sa fiche d’équipement\./);
    empty.view.hide();

    const flat = await edit({ ...DOOR_CLOSED, arming: arming({ zoneArmable: false }) });
    assert.equal(flat.box.disabled, true);
    assert.match(flat.form.textContent, /Cette zone n’a pas d’armement/);
    flat.view.hide();

    const refused = await edit({ ...DOOR_CLOSED, arming: arming({}) }, { 'PUT /api/access/doors/': () => { throw new Error('Cette zone n’a pas d’armement.'); } });
    refused.box.checked = true;
    refused.form.dispatch('submit');
    await flush();
    assert.match(refused.form.textContent, /Cette zone n’a pas d’armement\./, 'le message du serveur reste affiché');
    refused.view.hide();

    const old = await edit(DOOR_CLOSED);
    assert.equal(old.form.find((e) => e.type === 'checkbox' && e.parent!.textContent.includes('Armer cette porte avec sa zone')), null, 'ancien serveur : pas de case');
    old.view.hide();
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

  describe('fiche : le retour ramène d’où l’on vient', () => {
    const ficheOf = (container: FakeEl) => container.find((e) => e.tagName === 'section' && e.attrs.get('aria-labelledby') === 'acc-fiche-title')!;
    const paneOf = (container: FakeEl, id: string) => container.find((e) => e.id === `acc-pane-${id}`)!;

    it('depuis la liste des portes : « Retour aux portes », le focus rendu au bouton', async () => {
      const { view, container } = setup();
      await view.show(container, 'portes');
      await flush();
      const trigger = container.find((e) => e.tagName === 'button' && e.attrs.get('data-door-trigger') === 'P-ENTREE')!;
      fakeDocument.active = trigger;
      trigger.click();
      await flush();
      const back = byText(ficheOf(container), 'button', 'Retour aux portes')!;
      assert.ok(back, 'bouton de retour aux portes');
      back.click();
      assert.equal(ficheOf(container).hidden, true);
      assert.equal(paneOf(container, 'portes').hidden, false, 'la liste des portes revient');
      assert.equal(fakeDocument.activeElement, trigger);
      assert.equal(fakeLocation.hash, '#/acces/portes');
      view.hide();
    });

    it('depuis le plan : « Retour au plan » ramène sur Surveillance (une seule fois), la fiche est rangée', async () => {
      let toPlan = 0;
      const { view, container } = setup({ deps: { goToPlan: () => void toPlan++ } });
      await view.show(container, '');
      await flush();
      view.openDoor('P-ENTREE'); // l'évènement « open-door » du plan
      await flush();
      const fiche = ficheOf(container);
      assert.equal(fiche.hidden, false);
      const back = byText(fiche, 'button', 'Retour au plan')!;
      assert.ok(back, 'bouton « Retour au plan »');
      assert.equal(byText(fiche, 'button', 'Retour aux portes'), null);
      back.click();
      assert.equal(toPlan, 1, 'retour effectif sur Surveillance');
      assert.equal(fiche.hidden, true, 'la fiche n’est pas laissée ouverte derrière');
      view.hide();
    });

    it('depuis un passage du journal : « Retour au journal », filtres et liste gardés ; Échap fait de même', async () => {
      const { view, container, calls } = setup();
      await view.show(container, '');
      await flush();
      const link = container.find((e) => e.tagName === 'button' && e.className.includes('acc-door-link') && e.attrs.get('aria-label') === 'Détails de la porte Entrée personnel')!;
      assert.ok(link, 'le nom de la porte, dans le journal, est un lien vers ses détails');
      const lateBox = container.find((e) => e.id === 'acc-late')!;
      lateBox.checked = true; // un filtre posé avant d'ouvrir la fiche
      fakeDocument.active = link;
      link.click();
      await flush();
      const fiche = ficheOf(container);
      assert.equal(fiche.hidden, false);
      assert.ok(byText(fiche, 'button', 'Retour au journal'), 'bouton « Retour au journal »');
      assert.equal(paneOf(container, 'journal').hidden, true);
      const events = calls.filter((c) => c.path.startsWith('/api/access/events?')).length;
      byText(fiche, 'button', 'Retour au journal')!.click();
      assert.equal(fiche.hidden, true);
      assert.equal(paneOf(container, 'journal').hidden, false, 'le journal revient');
      assert.equal(container.find((e) => e.id === 'acc-late')!.checked, true, 'le filtre est resté');
      assert.equal(container.findAll((e) => e.tagName === 'tr' && e.attrs.has('data-passage')).length, 2, 'la liste est restée');
      assert.equal(calls.filter((c) => c.path.startsWith('/api/access/events?')).length, events, 'rien n’est relu pour revenir');
      assert.equal(fakeDocument.activeElement, link, 'le focus revient au lien');
      assert.equal(fakeLocation.hash, '#/acces/journal');
      // Échap, depuis le journal
      link.click();
      await flush();
      assert.equal(ficheOf(container).hidden, false);
      fakeDocument.dispatch('keydown', { key: 'Escape' });
      assert.equal(ficheOf(container).hidden, true);
      assert.equal(paneOf(container, 'journal').hidden, false);
      view.hide();
    });

    it('le libellé suit chaque ouverture : le plan, puis la liste, puis le journal', async () => {
      const { view, container } = setup({ deps: { goToPlan() {} } });
      await view.show(container, '');
      await flush();
      const label = () => text(ficheOf(container).find((e) => e.tagName === 'button')!);
      view.openDoor('P-ENTREE');
      await flush();
      assert.equal(label(), 'Retour au plan');
      fakeDocument.dispatch('keydown', { key: 'Escape' });
      view.hide();
      await view.show(container, 'portes/P-ENTREE'); // adresse directe : on revient aux portes
      await flush();
      assert.equal(label(), 'Retour aux portes');
      view.hide();
    });

    it('un opérateur voit les mêmes retours', async () => {
      let toPlan = 0;
      const { view, container } = setup({ admin: false, deps: { goToPlan: () => void toPlan++ } });
      await view.show(container, '');
      await flush();
      view.openDoor('P-ENTREE');
      await flush();
      byText(ficheOf(container), 'button', 'Retour au plan')!.click();
      assert.equal(toPlan, 1);
      view.hide();
    });
  });

  describe('fiche : « Aller à l’alarme »', () => {
    const goButton = (root: FakeEl) => byText(root, 'button', 'Aller à l’alarme');
    const incidentOf = (id: number, detectorId: string, status = 'open') => ({ id, detectorId, status, openedAt: NOW - 60_000, severity: 'critical' });

    it('porte forcée avec un incident en cours : le bouton ouvre cet incident ; clos entre-temps : il le dit', async () => {
      const opened: { id: number }[] = [];
      const { view, container, toasts } = setup({ deps: { goToAlarm: (i: { id: number }) => void opened.push(i) } });
      core.S.incidents = new Map([[5, incidentOf(5, 'P-ENTREE')]]);
      await view.show(container, 'portes/P-ENTREE');
      await flush();
      const button = goButton(container)!;
      assert.ok(button, 'bouton dans le bloc d’état');
      assert.equal(button.attrs.get('aria-label'), 'Aller à l’alarme de la porte Entrée personnel');
      const block = container.find((e) => e.className.includes('acc-fiche-state'))!;
      assert.ok(block.contains(button), 'dans le bloc d’état, sous la phrase qui dit quoi faire');
      button.click();
      assert.deepEqual(opened.map((i) => i.id), [5], 'l’incident en cours de ce détecteur');
      // l'alarme se clôt avant le clic suivant
      core.S.incidents = new Map([[5, incidentOf(5, 'P-ENTREE', 'closed')]]);
      button.click();
      assert.equal(opened.length, 1, 'rien ne s’ouvre');
      assert.deepEqual(toasts, ['Cette alarme n’est plus en cours.']);
      assert.equal(goButton(container), null, 'le bouton disparaît');
      view.hide();
    });

    it('sans incident en cours, ou porte calme : pas de bouton ; les changements d’alarme sont suivis (refresh)', async () => {
      const { view, container } = setup({ deps: { goToAlarm() {} } });
      await view.show(container, 'portes/P-ENTREE');
      await flush();
      assert.equal(goButton(container), null, 'forcée mais aucun incident : pas de bouton qui ne mène nulle part');
      core.S.incidents = new Map([[8, incidentOf(8, 'P-ENTREE', 'acked')]]);
      view.refresh();
      assert.ok(goButton(container), 'un incident acquitté reste en cours');
      core.S.incidents = new Map();
      view.refresh();
      assert.equal(goButton(container), null);
      view.hide();
      // une porte calme n'a pas de bouton, même avec un incident ouvert sur son détecteur
      const calm = setup({ deps: { goToAlarm() {} } });
      core.S.incidents = new Map([[9, incidentOf(9, 'P-ARRIERE')]]);
      await calm.view.show(calm.container, 'portes/P-ARRIERE');
      await flush();
      assert.equal(goButton(calm.container), null);
      calm.view.hide();
    });

    it('porte maintenue ouverte (préalarme) : le bouton est là aussi', async () => {
      const held = { ...DOOR_CLOSED, state: 'held_open', stateLabel: 'Maintenue ouverte', stateHint: 'Quelqu’un retient la porte.', deviceStatus: 'prealarm' };
      const { view, container } = setup({ routes: { 'GET /api/access/doors/': () => ({ door: held, lastPassages: [], cameras: [] }), 'GET /api/access/doors': () => [held] }, deps: { goToAlarm() {} } });
      core.S.incidents = new Map([[3, incidentOf(3, 'P-ARRIERE')]]);
      await view.show(container, 'portes/P-ARRIERE');
      await flush();
      assert.ok(goButton(container));
      view.hide();
    });
  });

  describe('fiche : carte « Ouverture à distance » (évènement psim:door-card)', () => {
    type Card = { slot: FakeEl; door: { detectorId: string } };
    const listen = () => {
      const seen: Card[] = [];
      const fn = (e: Record<string, unknown>) => void seen.push((e as unknown as { detail: Card }).detail);
      fakeDocument.addEventListener('psim:door-card', fn);
      return { seen, stop: () => fakeDocument.removeEventListener('psim:door-card', fn) };
    };

    it('après chaque rendu de la fiche : nom, emplacement `data-slot="remote-open"` et porte (DoorView)', async () => {
      const { seen, stop } = listen();
      try {
        const { view, container } = setup();
        await view.show(container, 'portes/P-ENTREE');
        await flush();
        assert.ok(seen.length >= 1, 'émis à l’ouverture');
        const first = seen.at(-1)!;
        assert.equal(first.door.detectorId, 'P-ENTREE');
        assert.equal(first.slot.attrs.get('data-slot'), 'remote-open');
        assert.ok(container.contains(first.slot), 'l’emplacement est celui de la fiche');
        const count = seen.length;
        core.emit('doors', []); // le temps réel redessine la fiche
        assert.equal(seen.length, count + 1, 'ré-émis à chaque rendu');
        assert.equal(seen.at(-1)!.slot, first.slot, 'toujours le même emplacement');
        view.hide();
      } finally {
        stop();
      }
    });

    it('aucun composant branché : texte de repli, et le lien « Déclaration » pour l’administrateur seulement', async () => {
      const admin = setup();
      await admin.view.show(admin.container, 'portes/P-ENTREE');
      await flush();
      const slot = admin.container.querySelector('div[data-slot="remote-open"]')!;
      assert.equal(text(slot), 'Ouverture à distance : aucune serrure ou barrière n’est reliée à cette porte.Reliez-en une dans Déclaration.');
      const link = byText(slot, 'a', 'Déclaration')!;
      assert.equal(hrefOf(link), '#/acces/declaration');
      admin.view.hide();
      const operator = setup({ admin: false });
      await operator.view.show(operator.container, 'portes/P-ENTREE');
      await flush();
      const slot2 = operator.container.querySelector('div[data-slot="remote-open"]')!;
      assert.equal(text(slot2), 'Ouverture à distance : aucune serrure ou barrière n’est reliée à cette porte.');
      assert.ok(!text(slot2).includes('Reliez-en'), 'pas de consigne d’administration pour un opérateur');
      assert.ok(!text(slot2).includes('pas encore disponible'), 'l’ancien texte a disparu');
      operator.view.hide();
    });

    it('un composant qui pose `dataset.filled` garde sa carte : le rendu ne la reconstruit pas, il ré-émet seulement', async () => {
      let fills = 0;
      const button = new FakeEl('button');
      const component = (e: Record<string, unknown>) => {
        const { slot } = (e as unknown as { detail: Card }).detail;
        if (slot.dataset.filled === '1') return;
        slot.replaceChildren(button);
        slot.dataset.filled = '1';
        fills++;
      };
      fakeDocument.addEventListener('psim:door-card', component);
      const { seen, stop } = listen();
      try {
        const { view, container } = setup();
        await view.show(container, 'portes/P-ENTREE');
        await flush();
        const slot = container.querySelector('div[data-slot="remote-open"]')!;
        assert.equal(fills, 1);
        assert.deepEqual(slot.childElements, [button], 'la carte du composant, sans texte de repli');
        assert.ok(!text(slot).includes('aucune serrure'));
        const count = seen.length;
        core.emit('doors', []);
        core.emit('doors', []);
        await flush();
        assert.deepEqual(slot.childElements, [button], 'jamais reconstruite par le rendu');
        assert.ok(seen.length >= count + 2, 'mais l’évènement est ré-émis');
        view.hide();
      } finally {
        fakeDocument.removeEventListener('psim:door-card', component);
        stop();
      }
    });

    it('chaque ouverture de fiche remet la carte à zéro : jamais les commandes d’une autre porte', async () => {
      const { view, container } = setup();
      await view.show(container, 'portes/P-ENTREE');
      await flush();
      const slot = container.querySelector('div[data-slot="remote-open"]')!;
      const stale = new FakeEl('button');
      slot.replaceChildren(stale); // un composant a rempli la carte de P-ENTREE
      slot.dataset.filled = '1';
      fakeDocument.dispatch('keydown', { key: 'Escape' });
      view.openDoor('P-STOCK');
      await flush();
      assert.ok(!slot.contains(stale), 'la carte de l’autre porte a disparu');
      assert.equal(slot.dataset.filled, undefined);
      assert.match(text(slot), /aucune serrure ou barrière/);
      assert.equal(slot.dataset.door, 'P-STOCK');
      view.hide();
    });
  });

  describe('journal : filtres repliables, dates et libellés', () => {
    const detailsOf = (container: FakeEl) => container.find((e) => e.tagName === 'details' && e.className.includes('acc-more'))! as FakeEl & { open: boolean };
    const summaryText = (container: FakeEl) => text(detailsOf(container).find((e) => e.tagName === 'summary')!);
    const withPhone = async (body: () => Promise<void>) => {
      const real = g.matchMedia;
      g.matchMedia = (q: string) => ({ matches: /max-width:\s*600px/.test(q), addEventListener() {} });
      try {
        await body();
      } finally {
        g.matchMedia = real;
      }
    };

    it('au-dessus de 600 px : « Plus de filtres » est ouvert ; période, porte et résultat ne sont jamais dedans', async () => {
      const { view, container } = setup();
      await view.show(container, '');
      await flush();
      const more = detailsOf(container);
      assert.ok(more, 'bloc repliable natif (details/summary : clavier, Entrée, Espace)');
      assert.equal(more.open, true);
      assert.equal(summaryText(container), 'Plus de filtres');
      for (const id of ['acc-from', 'acc-to', 'acc-door']) assert.ok(!more.contains(container.find((e) => e.id === id)), `${id} reste visible`);
      for (const b of container.findAll((e) => e.tagName === 'button' && e.attrs.has('data-result'))) assert.ok(!more.contains(b), 'les boutons de résultat restent visibles');
      assert.ok(!more.contains(container.find((e) => e.attrs.has('data-preset'))), 'les raccourcis de période restent visibles');
      for (const id of ['acc-holder', 'acc-credential', 'acc-late']) assert.ok(more.contains(container.find((e) => e.id === id)), `${id} est dans le bloc`);
      const hints = container.textContent.split('Appuyez sur Entrée ou sur Rechercher.').length - 1;
      assert.equal(hints, 2, 'à côté de Titulaire et de Numéro de badge : ils attendent « Rechercher »');
      assert.match(container.textContent, /Seulement les passages reçus après coupure/);
      assert.match(container.textContent, /Passages récupérés dans la mémoire du boîtier de contrôle d’accès \(contrôleur\) après une coupure\./);
      assert.match(container.textContent, /Heure affichée : celle de la porte\./);
      assert.ok(!/Heures du contrôleur/.test(container.textContent));
      view.hide();
    });

    it('téléphone : fermé par défaut ; un filtre actif caché est signalé (« Plus de filtres (2) ») ; un champ fautif le rouvre', async () => {
      await withPhone(async () => {
        const { view, container, calls } = setup();
        await view.show(container, '');
        await flush();
        const more = detailsOf(container);
        assert.equal(more.open, false);
        assert.equal(summaryText(container), 'Plus de filtres');
        const holder = container.find((e) => e.id === 'acc-holder')!;
        holder.value = 'Konan';
        holder.dispatch('input');
        assert.equal(summaryText(container), 'Plus de filtres (1)', 'le filtre est signalé sur le bouton fermé');
        const late = container.find((e) => e.id === 'acc-late')!;
        late.checked = true;
        late.dispatch('change');
        await flush();
        assert.equal(summaryText(container), 'Plus de filtres (2)');
        assert.equal(new URLSearchParams(calls.filter((c) => c.path.startsWith('/api/access/events?')).at(-1)!.path.split('?')[1]).get('late'), '1', 'la case relance la recherche');
        // un champ du bloc refusé : le bloc s'ouvre, le focus y va
        holder.value = 'x'.repeat(65);
        container.find((e) => e.tagName === 'form' && e.attrs.get('aria-label') === 'Filtres du journal des passages')!.dispatch('submit');
        await flush();
        assert.equal(more.open, true, 'le champ fautif n’est pas laissé caché');
        assert.equal(holder.attrs.get('aria-invalid'), 'true');
        assert.equal(fakeDocument.activeElement, holder);
        // « Effacer les filtres » : le compteur retombe
        byText(container, 'button', 'Effacer les filtres')!.click();
        await flush();
        assert.equal(summaryText(container), 'Plus de filtres');
        view.hide();
      });
    });

    it('une date modifiée relance la recherche (sans voler le focus) ; une date vide est refusée avec un message annoncé', async () => {
      const { view, container, calls } = setup();
      await view.show(container, '');
      await flush();
      const searches = () => calls.filter((c) => c.path.startsWith('/api/access/events?'));
      const from = container.find((e) => e.id === 'acc-from')!;
      const error = container.find((e) => e.tagName === 'p' && e.className.includes('form-error'))!;
      assert.equal(error.attrs.get('role'), 'alert', 'message annoncé');
      const before = searches().length;
      from.value = '2026-10-16T22:00';
      from.dispatch('change');
      await flush();
      assert.equal(searches().length, before + 1, 'la recherche repart sans appuyer sur « Rechercher »');
      assert.equal(new URLSearchParams(searches().at(-1)!.path.split('?')[1]).get('from'), String(at(2026, 10, 16, 22, 0)));
      // date vidée
      fakeDocument.active = null;
      from.value = '';
      from.dispatch('change');
      await flush();
      assert.equal(searches().length, before + 1, 'aucune recherche sans borne');
      assert.equal(text(error), 'La date de début est vide ou incomplète : choisissez un jour et une heure.');
      assert.equal(from.attrs.get('aria-invalid'), 'true');
      assert.notEqual(fakeDocument.activeElement, from, 'le focus n’est pas volé pendant la saisie');
      // « Rechercher » refuse aussi, et mène au champ
      container.find((e) => e.tagName === 'form' && e.attrs.get('aria-label') === 'Filtres du journal des passages')!.dispatch('submit');
      assert.equal(searches().length, before + 1);
      assert.equal(fakeDocument.activeElement, from);
      // les deux vides : une phrase pour les deux
      container.find((e) => e.id === 'acc-to')!.value = '';
      container.find((e) => e.id === 'acc-to')!.dispatch('change');
      assert.equal(text(error), 'Les dates de début et de fin sont vides : choisissez la période à chercher.');
      // une date valide efface le message et relance
      from.value = '2026-10-16T22:00';
      container.find((e) => e.id === 'acc-to')!.value = '2026-10-17T08:00';
      container.find((e) => e.id === 'acc-to')!.dispatch('change');
      await flush();
      assert.equal(text(error), '');
      assert.equal(from.attrs.has('aria-invalid'), false);
      assert.equal(searches().length, before + 2);
      view.hide();
    });

    it('« Dernières 24 h » : de la minute d’il y a 24 heures à la minute présente, enfoncé après le clic', async () => {
      const { view, container, calls } = setup();
      await view.show(container, '');
      await flush();
      const button = container.find((e) => e.tagName === 'button' && e.attrs.get('data-preset') === 'last24')!;
      assert.equal(text(button), 'Dernières 24 h');
      assert.equal(container.findAll((e) => e.tagName === 'button' && e.attrs.has('data-preset')).map((b) => text(b)).join('|'), 'Aujourd’hui|Dernières 24 h|Hier|7 derniers jours');
      button.click();
      await flush();
      const q = new URLSearchParams(calls.filter((c) => c.path.startsWith('/api/access/events?')).at(-1)!.path.split('?')[1]);
      assert.equal(Number(q.get('to')) - Number(q.get('from')), 86_400_000 + 60_000, '24 h, plus la minute incluse');
      assert.equal(button.attrs.get('aria-pressed'), 'true');
      assert.equal(container.find((e) => e.attrs.get('data-preset') === 'today')!.attrs.get('aria-pressed'), 'false');
      view.hide();
    });
  });

  describe('journal : résultat, vidéo et mots du métier', () => {
    it('refusé : pastille « Refusé » avec l’icône de refus, la raison à côté (hors de la pastille), nom complet pour les lecteurs d’écran', async () => {
      const { view, container } = setup();
      await view.show(container, '');
      await flush();
      const rows = container.findAll((e) => e.tagName === 'tr' && e.attrs.has('data-passage'));
      const cell = rows[1].querySelector('td[data-label="Résultat"]')!;
      assert.ok(cell.className.includes('acc-result'));
      const pill = cell.find((e) => e.className.includes('pill'))!;
      assert.equal(text(pill), 'Refusé', 'un mot court dans la pastille');
      assert.equal(pill.attrs.get('aria-hidden'), 'true');
      assert.equal(pill.find((e) => e.tagName === 'use')!.attrs.get('href'), 'icons.svg#state-denied', 'icône de refus, pas un cadenas');
      assert.equal(cell.findAll((e) => e.tagName === 'use' && /#lock$/.test(e.attrs.get('href') ?? '')).length, 0);
      const reason = cell.find((e) => e.className.includes('acc-reason'))!;
      assert.equal(text(reason), 'Badge inconnu');
      assert.ok(!pill.contains(reason), 'la raison est hors de la pastille');
      assert.equal(cell.find((e) => e.className === 'sr-only')!.textContent, 'Refusé — badge inconnu', 'le nom accessible complet');
      assert.match(text(cell), /Reçu après coupure/);
      const ok = rows[0].querySelector('td[data-label="Résultat"]')!;
      assert.equal(text(ok.find((e) => e.className.includes('pill'))!), 'Accepté');
      assert.equal(ok.find((e) => e.className.includes('pill'))!.find((e) => e.tagName === 'use')!.attrs.get('href'), 'icons.svg#state-ok');
      assert.equal(ok.find((e) => e.className.includes('acc-reason')), null, 'pas de raison pour un passage accepté');
      view.hide();
    });

    it('« Voir la vidéo » : bouton discret (ghost, caméra, « Vidéo »), nom complet pour les lecteurs, plus de note sous le tableau', async () => {
      const { view, container } = setup();
      await view.show(container, '');
      await flush();
      const button = videoButton(container)!;
      assert.ok(button.className.includes('btn-ghost'));
      assert.equal(text(button), 'Vidéo');
      assert.equal(button.find((e) => e.tagName === 'use')!.attrs.get('href'), 'icons.svg#camera');
      assert.match(button.attrs.get('aria-label') ?? '', /^Voir la vidéo du passage de \d\d:\d\d$/);
      assert.ok(!container.textContent.includes('montre l’enregistrement du passage'), 'la note est retirée du bas du tableau');
      assert.ok(!/ou l’image en direct de la caméra, et la fenêtre le dit/.test(container.textContent));
      view.hide();
    });

    it('vocabulaire : N° de personne, entrée / sortie, tableur, détails de la porte ; plus de « Réf. », « différé », « CSV » ni « Fiche »', async () => {
      const { view, container } = setup();
      await view.show(container, '');
      await flush();
      let t = container.textContent;
      assert.match(t, /N° de personne 101/);
      assert.match(t, /Entrée \/ sortie/);
      assert.match(t, /Exporter \(tableur\)/);
      assert.match(t, /Exporter \(tableur\) : fichier lisible dans Excel\./);
      assert.equal(container.find((e) => e.tagName === 'button' && text(e) === 'Exporter (tableur)')!.attrs.get('title'), 'Fichier lisible dans Excel.');
      for (const jargon of [/Réf\./, /différé/i, /\bCSV\b/, /Heures du contrôleur/, /Sens\b/]) assert.doesNotMatch(t, jargon, String(jargon));
      view.hide();
      await view.show(container, 'portes');
      await flush();
      t = container.textContent;
      assert.match(t, /Détails de la porte/);
      assert.doesNotMatch(t, /\bFiche\b/);
      assert.match(t, /Alarme si la porte reste ouverte|Dernier passage/);
      view.hide();
    });

    it('« contrôleur » est expliqué à sa première apparition visible de chaque écran', async () => {
      const firstMention = (t: string) => {
        const i = t.search(/contrôleur/i);
        return i < 0 ? null : t.slice(0, i + 'contrôleur'.length + 1).toLowerCase();
      };
      const pane = (container: FakeEl, id: string) => container.find((e) => e.id === `acc-pane-${id}`)!;
      const fiche = (container: FakeEl) => container.find((e) => e.tagName === 'section' && e.attrs.get('aria-labelledby') === 'acc-fiche-title')!;
      const screens: [string, (c: FakeEl) => FakeEl][] = [
        ['journal', (c) => pane(c, 'journal')],
        ['portes', (c) => pane(c, 'portes')],
        ['portes/P-ENTREE', fiche],
        ['declaration', (c) => pane(c, 'declaration')],
      ];
      for (const [sub, area] of screens) {
        const { view, container } = setup();
        await view.show(container, sub);
        await flush();
        const mention = firstMention(text(area(container)));
        assert.ok(mention, `« contrôleur » apparaît sur l’écran ${sub}`);
        assert.ok(mention.endsWith(A.CONTROLLER_LONG), `${sub} : première apparition = « ${A.CONTROLLER_LONG} » (lu : …${mention.slice(-60)})`);
        view.hide();
      }
    });

    it('porte hors ligne : le texte du serveur, premier de la fiche, explique le contrôleur ; le libellé de la liste reste court', async () => {
      const offline = { ...DOOR_OFFLINE, stateHint: 'Le PSIM n’a plus de nouvelles de cette porte. Faites vérifier l’alimentation et le réseau du contrôleur.' };
      const { view, container } = setup({ routes: { 'GET /api/access/doors/': () => ({ door: offline, lastPassages: [], cameras: [] }), 'GET /api/access/doors': () => [offline] } });
      await view.show(container, 'portes/P-STOCK');
      await flush();
      const fiche = container.find((e) => e.tagName === 'section' && e.attrs.get('aria-labelledby') === 'acc-fiche-title')!;
      const t = text(fiche);
      assert.ok(t.includes('réseau du boîtier de contrôle d’accès (contrôleur).'));
      assert.ok(t.search(/contrôleur/i) === t.indexOf('contrôleur)'), 'la première mention est celle qui explique');
      assert.ok(fiche.findAll((e) => e.tagName === 'dt').some((e) => text(e) === 'Contrôleur'), 'la liste dit « Contrôleur » ensuite');
      view.hide();
    });

    it('le sous-titre de l’écran est court', () => {
      assert.match(read('app.js'), /acces: \{ title: 'Accès', sub: 'Passages et portes' \}/);
    });
  });

  describe('plan : pastilles d’état des portes', () => {
    it('le mot court de « maintenue ouverte » est « Reste ouverte », partout (plan, légende)', () => {
      assert.match(read('core.js'), /held_open: \{ label: 'Maintenue ouverte', short: 'Reste ouverte'/);
      assert.match(read('index.html'), /<span>Reste ouverte<\/span><\/span>retenue ouverte/);
      assert.ok(!/<span>Maintenue<\/span>/.test(read('index.html')));
    });

    it('le bouton du plan s’appelle « Détails de la porte »', () => {
      const plan = read('plan.js');
      assert.match(plan, /'aria-label': `Détails de la porte \$\{door\.name \|\| d\.name\}`/);
      assert.match(plan, /icon\('door'\), 'Détails de la porte'/);
      assert.ok(!/Fiche de la porte/.test(plan));
    });

    it('pastille plus grande : icône de 16 px, texte d’au moins --fs-sm, placement anti-recouvrement branché', () => {
      const css = read('surveillance.css');
      const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.[\]*+?^${}()|\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
      assert.match(rule('.pin-door'), /font-size: var\(--fs-sm\)/);
      assert.match(rule('.pin-door .icon'), /width: 16px; height: 16px/);
      assert.doesNotMatch(rule('.pin-door'), /--fs-xs|--ink-3/);
      const plan = read('plan.js');
      assert.match(plan, /import \{ placeDoorBadges \} from '\.\/doorbadges\.js'/);
      assert.match(plan, /layoutDoorBadges\(\)/);
      assert.ok(!/\.style\.(left|top)\s*=[^;]*pin-door/.test(plan));
    });
  });

  describe('textes secondaires : taille et contraste', () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const base = read('base.css');
    const tokens = (header: string) => {
      const start = base.indexOf(header);
      const block = base.slice(start, base.indexOf('}', start));
      return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
    };
    const themes = { jour: tokens(':root {'), nuit: tokens(":root[data-theme='night'] {") };

    it('.acc-sub, libellés de carte (td[data-label]::before), noms de faits et .pin-door : au moins --fs-sm, jamais --ink-3', () => {
      const css = read('access.css');
      const bodies = (needle: string) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1].includes(needle)).map((m) => m[2]);
      for (const needle of ['.acc-sub {', '[data-label]::before', '.acc-facts > dt']) {
        const found = (needle === '.acc-sub {' ? bodies('.acc-sub ') : bodies(needle)).filter((b) => /font-size|color:/.test(b));
        assert.ok(found.length >= 1, needle);
        for (const body of found) {
          assert.match(body, /font-size: var\(--fs-sm\)/, `${needle} : taille`);
          assert.match(body, /color: var\(--ink-2\)/, `${needle} : couleur`);
          assert.doesNotMatch(body, /--ink-3|--fs-xs/);
        }
      }
      const pin = /\.pin-door \{([^}]*)\}/.exec(read('surveillance.css'))![1];
      assert.match(pin, /font-size: var\(--fs-sm\)/);
      assert.doesNotMatch(pin, /--ink-3/);
    });

    it('--ink-2 passe 4,5:1 sur la feuille et les fonds de carte, de jour comme de nuit', () => {
      for (const [name, t] of Object.entries(themes)) {
        for (const bg of ['surface', 'surface-2', 'warning-soft', 'alarm-soft', 'offline-soft', 'info-soft']) {
          assert.ok(t[bg] && t['ink-2'], `${name} : jetons ${bg}`);
          assert.ok(contrast(t['ink-2'], t[bg]) >= 4.5, `${name} : --ink-2 sur --${bg} = ${contrast(t['ink-2'], t[bg]).toFixed(2)}`);
        }
      }
    });

    it('texte des pastilles de porte : 4,5:1 sur son fond, de jour comme de nuit', () => {
      const pairs: [string, string][] = [['ink', 'surface'], ['ok-ink', 'surface'], ['info-ink', 'surface'], ['warning-ink', 'warning-soft'], ['alarm-ink', 'alarm-soft'], ['offline-ink', 'offline-soft']];
      for (const [name, t] of Object.entries(themes)) {
        for (const [fg, bg] of pairs) assert.ok(contrast(t[fg], t[bg]) >= 4.5, `${name} : --${fg} sur --${bg} = ${contrast(t[fg], t[bg]).toFixed(2)}`);
      }
    });

    it('journal en cartes : le résultat passe en premier, à côté de l’heure', () => {
      const css = read('access.css');
      const container = css.slice(css.indexOf('@container acctable (max-width: 960px)'));
      assert.match(container, /table\.acc-journal-table td\.acc-result \{ grid-column: 1; grid-row: 1;/);
      assert.match(container, /table\.acc-journal-table td\.acc-when \{ grid-column: 2; grid-row: 1;/);
      assert.match(container, /table\.acc-journal-table td\.acc-result::before \{ display: none; \}/, 'pas de libellé devant la pastille');
    });
  });

  it('hrefs de l’écran : seulement des liens internes', async () => {
    const { view, container } = setup();
    await view.show(container, 'portes/P-ARRIERE');
    await flush();
    for (const a of container.findAll((e) => e.tagName === 'a')) assert.match(hrefOf(a), /^#\//, hrefOf(a));
    view.hide();
  });
});
