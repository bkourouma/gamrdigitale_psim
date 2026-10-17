/**
 * Écran « Rondes » : points de contrôle, circuits et journal des rondes (administrateur), journal et main courante
 * (opérateur). Les rubriques « Agents » et « Téléphones » sont remplies par agents-admin.js ; cet écran n'en possède que
 * les onglets.
 *
 * Rubriques :
 *  - Points de contrôle : placement sur le plan de l'étage (glisser, flèches), éditeur, ajout, liste, planche d'étiquettes
 *    à imprimer (QR + code en clair) ;
 *  - Circuits : une phrase qui dit tout (« 8 points, dans l'ordre, à finir en 45 min. Du lundi au vendredi… »), un
 *    formulaire (points, ordre, durée, plages horaires, agents, délai avant alarme critique) ;
 *  - Journal : rondes de la période (état, avancement, détail des passages) et main courante, avec « En faire un incident ».
 *
 * Ce fichier n'importe que `./rules.js` (pur, sans DOM) : tout le reste arrive par l'objet de dépendances de
 * `createPatrolsView`. Aucun accès à `document` ou `window` au chargement du module : ses fonctions pures (validation,
 * corps envoyés, phrases, libellés, périodes) se testent sous Node.
 *
 * Règles tenues ici :
 *  - un formulaire est un brouillon : ni un rafraîchissement, ni un changement d'onglet ne l'efface ; on demande avant
 *    d'abandonner une saisie ;
 *  - une réponse tardive d'un onglet quitté n'écrase jamais l'écran (numéro de requête) ;
 *  - un état se dit par une icône ET un mot ; tout texte venu du serveur passe par textContent ;
 *  - les pastilles d'un étage ne sont jamais dessinées sur le plan d'un autre.
 */
import { MAX_NAME, MAX_WINDOWS, windowProblem, nightNote, describeDays, minutesText, clockText } from './rules.js';

// ---------------------------------------------------------------- constantes

export const MAX_ZONE = 80;
export const MAX_ROUTE_MINUTES = 1440;
export const MAX_GRACE = 120;
export const DEFAULT_MAX_MINUTES = 45;
export const DEFAULT_GRACE = 10;
/** Rafraîchissement automatique du journal, tant que l'onglet est affiché. */
export const REFRESH_MS = 30_000;
/** Délai avant d'enregistrer un déplacement fait aux flèches (un seul envoi par série d'appuis). */
export const NUDGE_MS = 500;
/** Au-delà de ce nombre de points, la planche est refusée par prudence (une page de navigateur lourde ne sert à rien). */
export const MAX_ROUTE_POINTS = 200;

/** Rubriques, dans l'ordre des onglets. `admin` : réservée aux administrateurs. */
export const TABS = [
  { key: 'points', label: 'Points de contrôle', admin: true },
  { key: 'routes', label: 'Circuits', admin: true },
  { key: 'agents', label: 'Agents', admin: false }, // l'opérateur : liste, déverrouillage et fin de service (avenant 2)
  { key: 'phones', label: 'Téléphones', admin: true },
  { key: 'journal', label: 'Journal', admin: false },
];
export const PERIODS = [
  { key: 'today', label: "Aujourd’hui" },
  { key: '7d', label: '7 jours' },
  { key: '30d', label: '30 jours' },
];
const PERIOD_DAYS = { today: 1, '1d': 1, '7d': 7, week: 7, '30d': 30, month: 30 };

const DAY_SHORT = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const DAY_LONG = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // la semaine commence le lundi
/** Plage proposée à « Ajouter une plage » : toute la nuit, tous les jours. */
const SUGGESTED_WINDOW = () => ({ days: [0, 1, 2, 3, 4, 5, 6], from: '22:00', to: '06:00' });

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
const joinAnd = (items) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} et ${items.at(-1)}`);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Entier écrit en chiffres (« 45 »), sinon NaN : « 4,5 », « 1e2 », « » et « -3 » ne sont pas des durées. */
const asInt = (v) => {
  const s = String(v ?? '').trim();
  return /^\d{1,6}$/.test(s) ? Number(s) : Number.NaN;
};
const intIn = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]/u;
const num = (v, fallback = null) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const text = (v) => (typeof v === 'string' ? v : '');
const uniq = (list) => [...new Set(list)];

// ---------------------------------------------------------------- navigation entre rubriques

/** Rubriques visibles pour un rôle : l'opérateur ne voit que le journal. */
export const tabsFor = (role) => TABS.filter((t) => role === 'admin' || !t.admin);
export const defaultTab = (role) => (role === 'admin' ? 'points' : 'journal');

/** Rubrique nommée par l'adresse `#/rondes/<clé>`, si elle existe pour ce rôle ; sinon null. */
export function tabFromHash(hash, role) {
  const m = /^#\/rondes\/([a-z]+)\/?$/.exec(typeof hash === 'string' ? hash : '');
  return m && tabsFor(role).some((t) => t.key === m[1]) ? m[1] : null;
}

// ---------------------------------------------------------------- lecture tolérante des réponses

/** Liste d'une réponse : tableau nu ou enveloppé (`{ checkpoints: [...] }`). Tout élément qui n'est pas un objet est ignoré. */
export function listOf(data, key) {
  const raw = Array.isArray(data) ? data : isObject(data) && Array.isArray(data[key]) ? data[key] : [];
  return raw.filter((x) => isObject(x));
}

const positiveId = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

/** Point de contrôle : { id, name, zone, floorId, x, y, code, archived }. Un champ absent prend une valeur sûre. */
export function normCheckpoint(raw) {
  const r = isObject(raw) ? raw : {};
  return {
    id: positiveId(r.id) ?? Number.NaN,
    name: text(r.name).trim(),
    zone: text(r.zone).trim(),
    floorId: num(r.floorId, Number.NaN),
    x: Math.min(100, Math.max(0, num(r.x, 50))),
    y: Math.min(100, Math.max(0, num(r.y, 50))),
    code: text(r.code),
    archived: r.archivedAt !== null && r.archivedAt !== undefined && r.archivedAt !== false,
  };
}

function normWindow(raw) {
  const w = isObject(raw) ? raw : {};
  const days = Array.isArray(w.days) ? uniq(w.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)).sort((a, b) => a - b) : [];
  return { days, from: text(w.from), to: text(w.to) };
}

/** Circuit : { id, name, checkpoints:number[], ordered, maxMinutes, schedule:Window[], agents:string[], graceMinutes, enabled, archived }. */
export function normRoute(raw) {
  const r = isObject(raw) ? raw : {};
  return {
    id: positiveId(r.id) ?? Number.NaN,
    name: text(r.name).trim(),
    checkpoints: Array.isArray(r.checkpoints) ? r.checkpoints.filter((n) => Number.isSafeInteger(n) && n > 0) : [],
    ordered: r.ordered === true,
    maxMinutes: num(r.maxMinutes, DEFAULT_MAX_MINUTES),
    schedule: Array.isArray(r.schedule) ? r.schedule.map(normWindow) : [],
    agents: Array.isArray(r.agents) ? uniq(r.agents.filter((a) => typeof a === 'string' && a !== '')) : [],
    graceMinutes: num(r.graceMinutes, DEFAULT_GRACE),
    enabled: r.enabled !== false,
    archived: r.archivedAt !== null && r.archivedAt !== undefined && r.archivedAt !== false,
  };
}

const METHODS = ['nfc', 'qr', 'manual'];

function normScan(raw) {
  const s = isObject(raw) ? raw : {};
  return {
    id: num(s.id),
    checkpointId: positiveId(s.checkpointId) ?? Number.NaN,
    checkpointName: text(s.checkpointName).trim(),
    username: text(s.username),
    method: METHODS.includes(s.method) ? s.method : '',
    phoneAt: num(s.phoneAt),
    serverAt: num(s.serverAt),
    deferred: s.deferred === true,
    verdict: text(s.verdict),
  };
}

/** Ronde : { id, routeId, routeName, status, dueStart, dueEnd, startedBy, startedAt, finishedAt, scans, checkpoints|null }. */
export function normRun(raw) {
  const r = isObject(raw) ? raw : {};
  const expected = Array.isArray(r.checkpoints)
    ? r.checkpoints.filter((c) => isObject(c) && positiveId(c.id)).map((c) => ({ id: c.id, name: text(c.name).trim() }))
    : null;
  return {
    id: positiveId(r.id) ?? Number.NaN,
    routeId: positiveId(r.routeId) ?? Number.NaN,
    routeName: text(r.routeName).trim(),
    status: text(r.status),
    dueStart: num(r.dueStart),
    dueEnd: num(r.dueEnd),
    startedBy: typeof r.startedBy === 'string' && r.startedBy !== '' ? r.startedBy : null,
    startedAt: num(r.startedAt),
    finishedAt: num(r.finishedAt),
    scans: Array.isArray(r.scans) ? r.scans.filter(isObject).map(normScan) : [],
    checkpoints: expected,
  };
}

export const CATEGORIES = ['anomaly', 'damage', 'visitor', 'other'];

/** Entrée de la main courante : { id, username, displayName, category, text, checkpointId, checkpointName, hasPhoto, phoneAt, serverAt, deferred, incidentId }. */
export function normEntry(raw) {
  const e = isObject(raw) ? raw : {};
  return {
    id: positiveId(e.id) ?? Number.NaN,
    username: text(e.username),
    displayName: text(e.displayName).trim(),
    category: CATEGORIES.includes(e.category) ? e.category : 'other',
    text: text(e.text),
    checkpointId: positiveId(e.checkpointId),
    checkpointName: text(e.checkpointName).trim(),
    hasPhoto: e.hasPhoto === true || (typeof e.photoFile === 'string' && e.photoFile !== ''),
    phoneAt: num(e.phoneAt),
    serverAt: num(e.serverAt),
    deferred: e.deferred === true,
    incidentId: positiveId(e.incidentId),
  };
}

/** Agent (liste des agents) : { username, displayName }. */
export function normAgent(raw) {
  const a = isObject(raw) ? raw : {};
  const username = text(a.username);
  return { username, displayName: text(a.displayName).trim() || username };
}

// ---------------------------------------------------------------- libellés

const STATUS = { pending: 'À venir', active: 'En cours', done: 'Faite', incomplete: 'Incomplète', missed: 'Non faite' };
const VERDICT = { ok: 'Valide', out_of_route: 'Hors circuit', out_of_order: 'Hors ordre', no_run: 'Sans ronde en cours', duplicate: 'Doublon' };
const CATEGORY = { anomaly: 'Anomalie', damage: 'Dégradation', visitor: 'Visiteur', other: 'Autre' };
const METHOD = { nfc: 'NFC', qr: 'QR', manual: 'Saisie du code' };

export const statusLabel = (status) => STATUS[status] ?? 'État inconnu';
export const verdictLabel = (verdict) => VERDICT[verdict] ?? 'À vérifier';
export const categoryLabel = (cat) => CATEGORY[cat] ?? 'Autre';
export const methodLabel = (m) => METHOD[m] ?? 'Méthode inconnue';

/** Adresse que contient l'étiquette (QR et NFC) : la même que celle de l'application des agents. */
export const labelUrl = (origin, code) => `${String(origin ?? '').replace(/\/+$/, '')}/agent/#cp=${code}`;

// ---------------------------------------------------------------- période du journal

/**
 * Bornes d'une période, en millisecondes : du début de la journée locale (il y a N-1 jours) à la fin de la journée
 * d'aujourd'hui (les rondes à venir du jour s'affichent). `preset` : 'today', '7d', '30d' (ou 'week', 'month').
 */
export function periodRange(preset, now = Date.now()) {
  const days = PERIOD_DAYS[preset] ?? 1;
  const at = now instanceof Date ? now : new Date(now);
  const day = Number.isNaN(at.getTime()) ? new Date() : at;
  const y = day.getFullYear();
  const m = day.getMonth();
  const d = day.getDate();
  return { from: new Date(y, m, d - (days - 1)).getTime(), to: new Date(y, m, d + 1).getTime() - 1 };
}

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
/** « lun. 12 oct. » */
export const dayShort = (ts) => new Date(ts).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
/** « 22:00 » aujourd'hui ; « lun. 12 oct., 22:00 » un autre jour ; « — » sans heure. */
export function whenText(ts, now = Date.now()) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—';
  return sameDay(ts, now) ? clockText(ts) : `${dayShort(ts)}, ${clockText(ts)}`;
}
/** « 22:03:41 » : l'heure du téléphone et celle du serveur se comparent à la seconde. */
export const clockSec = (ts) => (typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts).toLocaleTimeString('fr-FR') : '—');

// ---------------------------------------------------------------- points de contrôle : formulaire

export const defaultCheckpointForm = (floorId = '') => ({ name: '', zone: '', floorId });

/** Ce qui empêche d'enregistrer un point, en mots : [{ key: 'name'|'zone'|'floor', message }]. */
export function checkpointProblems(form) {
  const out = [];
  const name = String(form?.name ?? '').trim();
  if (!name) out.push({ key: 'name', message: 'Donnez un nom au point, par exemple « Portail principal ».' });
  else if (name.length > MAX_NAME) out.push({ key: 'name', message: `Le nom est trop long : ${MAX_NAME} caractères au plus.` });
  else if (CONTROL_CHARS.test(name)) out.push({ key: 'name', message: 'Le nom contient un caractère invisible : retapez-le.' });
  const zone = String(form?.zone ?? '').trim();
  if (zone.length > MAX_ZONE) out.push({ key: 'zone', message: `La zone est trop longue : ${MAX_ZONE} caractères au plus.` });
  else if (CONTROL_CHARS.test(zone)) out.push({ key: 'zone', message: 'La zone contient un caractère invisible : retapez-la.' });
  const raw = form?.floorId;
  const floor = typeof raw === 'number' ? raw : /^\d{1,9}$/.test(String(raw ?? '').trim()) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(floor)) out.push({ key: 'floor', message: 'Choisissez l’étage où se trouve le point.' });
  return out;
}

/** Corps de `POST` / `PATCH /api/patrols/checkpoints` (sans x ni y : le placement se fait sur le plan). */
export function buildCheckpointPayload(form) {
  return { name: String(form.name ?? '').trim(), zone: String(form.zone ?? '').trim(), floorId: Number(form.floorId) };
}

// ---------------------------------------------------------------- circuits : formulaire

/** Circuit neuf : rien de choisi, le reste a une valeur raisonnable. `agentsMode` : 'all' (tout agent en service) ou 'some'. */
export function defaultRouteForm() {
  return {
    name: '',
    checkpoints: [],
    ordered: false,
    maxMinutes: String(DEFAULT_MAX_MINUTES),
    schedule: [],
    agentsMode: 'all',
    agents: [],
    graceMinutes: String(DEFAULT_GRACE),
    enabled: true,
  };
}

/** Formulaire d'un circuit existant (copie : modifier le formulaire ne touche jamais le circuit affiché). */
export function formFromRoute(route) {
  const r = normRoute(route);
  return {
    name: r.name,
    checkpoints: uniq(r.checkpoints),
    ordered: r.ordered,
    maxMinutes: String(r.maxMinutes),
    schedule: r.schedule.map((w) => ({ days: [...w.days], from: w.from, to: w.to })),
    agentsMode: r.agents.length ? 'some' : 'all',
    agents: [...r.agents],
    graceMinutes: String(r.graceMinutes),
    enabled: r.enabled,
  };
}

const modeOf = (form) => (form.agentsMode === 'some' || (form.agentsMode === undefined && form.agents?.length) ? 'some' : 'all');

/**
 * Tout ce qui empêche d'enregistrer, dans l'ordre de l'écran : [{ key, message }].
 * key : 'name', 'checkpoints', 'maxMinutes', 'schedule', 'schedule:<n>' (n à partir de 0), 'agents', 'graceMinutes'.
 * `ctx` (facultatif) : { checkpointIds: Set<number>, agentNames: Set<string> | null } pour refuser un choix qui n'existe plus.
 */
export function routeProblems(form, ctx = null) {
  const out = [];
  const name = String(form?.name ?? '').trim();
  if (!name) out.push({ key: 'name', message: 'Donnez un nom au circuit, pour le retrouver dans la liste.' });
  else if (name.length > MAX_NAME) out.push({ key: 'name', message: `Le nom est trop long : ${MAX_NAME} caractères au plus.` });
  else if (CONTROL_CHARS.test(name)) out.push({ key: 'name', message: 'Le nom contient un caractère invisible : retapez-le.' });

  const points = Array.isArray(form?.checkpoints) ? form.checkpoints : [];
  if (points.length === 0) out.push({ key: 'checkpoints', message: 'Choisissez au moins un point à contrôler.' });
  else if (points.length > MAX_ROUTE_POINTS) out.push({ key: 'checkpoints', message: `${MAX_ROUTE_POINTS} points au plus : créez un autre circuit pour le reste.` });
  else if (ctx?.checkpointIds) {
    const gone = points.filter((id) => !ctx.checkpointIds.has(id));
    if (gone.length) out.push({ key: 'checkpoints', message: `${gone.length > 1 ? 'Des points ont été retirés' : 'Un point a été retiré'} : retirez-${gone.length > 1 ? 'les' : 'le'} de la liste « Ordre de passage ».` });
  }

  if (!intIn(asInt(form?.maxMinutes), 1, MAX_ROUTE_MINUTES)) {
    out.push({ key: 'maxMinutes', message: `Indiquez un nombre entier de minutes, entre 1 et ${MAX_ROUTE_MINUTES}.` });
  }

  const schedule = Array.isArray(form?.schedule) ? form.schedule : [];
  if (schedule.length === 0) out.push({ key: 'schedule', message: 'Ajoutez au moins une plage horaire.' });
  else if (schedule.length > MAX_WINDOWS) out.push({ key: 'schedule', message: `${MAX_WINDOWS} plages au plus : regroupez les jours qui ont les mêmes heures.` });
  schedule.forEach((w, i) => {
    const p = windowProblem({ days: Array.isArray(w?.days) ? w.days : [], from: text(w?.from), to: text(w?.to) });
    if (p) out.push({ key: `schedule:${i}`, message: `Plage ${i + 1} : ${p.charAt(0).toLowerCase()}${p.slice(1)}` });
  });

  if (modeOf(form) === 'some') {
    const chosen = Array.isArray(form?.agents) ? form.agents : [];
    if (chosen.length === 0) out.push({ key: 'agents', message: 'Cochez au moins un agent, ou choisissez « Tout agent en service ».' });
    else if (ctx?.agentNames) {
      const gone = chosen.filter((a) => !ctx.agentNames.has(a));
      if (gone.length) out.push({ key: 'agents', message: `Agent introuvable : ${gone.map((g) => `« ${g} »`).join(', ')}. Décochez-le.` });
    }
  }

  if (!intIn(asInt(form?.graceMinutes), 0, MAX_GRACE)) {
    out.push({ key: 'graceMinutes', message: `Indiquez un nombre entier de minutes, entre 0 et ${MAX_GRACE} (0 : pas d'attente).` });
  }
  return out;
}

/** Corps de `POST` / `PATCH /api/patrols/routes` ; à n'appeler que si `routeProblems` ne signale rien. */
export function buildRoutePayload(form) {
  return {
    name: String(form.name ?? '').trim(),
    checkpoints: uniq(form.checkpoints.map(Number)),
    ordered: Boolean(form.ordered),
    maxMinutes: asInt(form.maxMinutes),
    schedule: form.schedule.map((w) => ({ days: uniq(w.days).sort((a, b) => a - b), from: w.from, to: w.to })),
    agents: modeOf(form) === 'all' ? [] : uniq(form.agents),
    graceMinutes: asInt(form.graceMinutes),
    enabled: Boolean(form.enabled),
  };
}

/** Empreinte d'un formulaire de circuit : deux formulaires de même contenu ont la même (détecte une saisie non enregistrée). */
export function routeFormKey(form) {
  return JSON.stringify([
    String(form.name ?? '').trim(),
    form.checkpoints,
    Boolean(form.ordered),
    String(form.maxMinutes ?? '').trim(),
    form.schedule.map((w) => [[...w.days].sort((a, b) => a - b), w.from, w.to]),
    modeOf(form),
    modeOf(form) === 'all' ? [] : [...form.agents].sort(),
    String(form.graceMinutes ?? '').trim(),
    Boolean(form.enabled),
  ]);
}

/** « Du lundi au vendredi de 22:00 à 06:00 le lendemain » (le début de la plage donne les jours). */
export function windowSentence(w) {
  const days = describeDays(Array.isArray(w.days) ? w.days : []);
  return `${days} de ${w.from} à ${w.to}${w.from > w.to ? ' le lendemain' : ''}`;
}

/**
 * La phrase d'un circuit, qui dit tout : « 8 points, dans l'ordre, à finir en 45 min. Du lundi au vendredi de 22:00 à 06:00
 * le lendemain. Agents : tout agent en service. »
 * `agentName(username)` donne le nom affiché d'un agent. `checkpointName` est accepté pour l'avenir (les noms des points
 * s'affichent à part, sur la carte : la phrase reste la même quelle que soit la longueur du circuit).
 */
export function describeRoute(route, { checkpointName = null, agentName = (u) => u } = {}) {
  void checkpointName;
  const n = uniq(Array.isArray(route?.checkpoints) ? route.checkpoints : []).length;
  const max = Number(route?.maxMinutes);
  const order = n > 1 ? (route?.ordered ? ", dans l'ordre" : ", dans n'importe quel ordre") : '';
  const first = `${n === 0 ? 'Aucun point' : plural(n, 'point')}${order}, à finir en ${Number.isFinite(max) && max >= 1 ? minutesText(max) : '… min'}.`;
  const schedule = Array.isArray(route?.schedule) ? route.schedule : [];
  const when = schedule.length ? `${cap(schedule.map(windowSentence).join(' ; '))}.` : 'Aucune plage horaire.';
  const agents = Array.isArray(route?.agents) ? route.agents : [];
  const who = agents.length ? `Agents : ${joinAnd(agents.map((a) => agentName(a)))}.` : 'Agents : tout agent en service.';
  return `${first} ${when} ${who}`;
}

// ---------------------------------------------------------------- journal des rondes

/**
 * Points attendus d'une ronde : [{ id, name }], ou null si on ne les connaît pas. `lookup` : { routeCheckpoints: Map<routeId,
 * number[]>, checkpointName: (id) => string } (circuits déjà chargés) pour les rondes qui ne portent pas leur liste.
 */
export function expectedPoints(run, lookup = {}) {
  if (run.checkpoints) return run.checkpoints.map((c) => ({ id: c.id, name: c.name || lookup.checkpointName?.(c.id) || `Point n° ${c.id}` }));
  const ids = lookup.routeCheckpoints?.get?.(run.routeId);
  if (!Array.isArray(ids)) return null;
  return ids.map((id) => ({ id, name: lookup.checkpointName?.(id) || `Point n° ${id}` }));
}

/** Avancement : { done, total|null, missed:[{id,name}] }. Seul un passage « valide » compte (hors ordre, doublon : non). */
export function runProgress(run, expected) {
  const ok = new Set(run.scans.filter((s) => s.verdict === 'ok').map((s) => s.checkpointId));
  if (!expected) return { done: ok.size, total: null, missed: [] };
  const missed = expected.filter((p) => !ok.has(p.id));
  return { done: expected.length - missed.length, total: expected.length, missed };
}

/** « 5 points sur 8 » ; sans le total : « 5 points validés ». */
export function progressText({ done, total }) {
  if (total === null) return done === 0 ? 'Aucun point validé' : `${plural(done, 'point')} ${done > 1 ? 'validés' : 'validé'}`;
  return `${plural(done, 'point')} sur ${total}`;
}

/** Agents d'une ronde : celui qui l'a commencée, puis ceux qui ont scanné. */
export const runAgents = (run) => uniq([run.startedBy, ...run.scans.map((s) => s.username)].filter((u) => typeof u === 'string' && u !== ''));

/** Rondes, la plus récente d'abord (puis l'identifiant, pour un ordre stable). */
export const sortRuns = (runs) => [...runs].sort((a, b) => (b.dueStart ?? 0) - (a.dueStart ?? 0) || (b.id || 0) - (a.id || 0));
/** Main courante, la plus récente d'abord. */
export const sortEntries = (entries) => [...entries].sort((a, b) => (b.phoneAt ?? b.serverAt ?? 0) - (a.phoneAt ?? a.serverAt ?? 0) || (b.id || 0) - (a.id || 0));
/** Zones proposées dans les champs « zone » : celles des équipements et des points, sans doublon, triées. */
export const zoneChoices = (zones, points) => uniq([...(Array.isArray(zones) ? zones : []), ...points.map((p) => p.zone)].filter((z) => typeof z === 'string' && z.trim() !== '').map((z) => z.trim())).sort((a, b) => a.localeCompare(b, 'fr'));


// ---------------------------------------------------------------- l'écran

/**
 * Dépendances : api, h, icon, toast, dialogs, ui ({ field, setBusy, markInvalid, clearInvalid, copyButton, uid }), getMe,
 * getFloors() ([{ id, name, hasPlan, planVersion }]), getZones() (string[]), agents (agents-admin.js : loadAgents,
 * loadPhones, hide). Renvoie { show(), hide(), reset(), refresh() }.
 */
export function createPatrolsView({ api, h, icon, toast, dialogs, ui, getMe = () => null, getFloors = () => [], getZones = () => [], agents = null }) {
  const byId = (id) => document.getElementById(id);
  const els = { tabs: byId('pt-tabs'), panel: Object.fromEntries(TABS.map((t) => [t.key, byId(`pt-panel-${t.key}`)])) };
  const state = { role: null, tab: null, visible: false };
  const modules = {};

  // ---------------------------------------------------------------- aides communes

  const sentence = (message) => {
    const t = cap(String(message ?? 'Erreur inconnue').trim());
    return /[.!?…]$/.test(t) ? t : `${t}.`;
  };
  const th = (label) => h('th', { scope: 'col', text: label });
  const loadError = (title, err, retry) =>
    h('div', { class: 'notice is-alarm', role: 'alert' }, icon('state-alarm'), h('span', {}, h('strong', { text: `${title} ` }), `${sentence(err?.message)} `, h('button', { class: 'btn btn-sm', type: 'button', text: 'Réessayer', onclick: retry })));

  /** Panneau chargé : « Chargement… », puis le contenu ; une erreur réseau donne un message avec « Réessayer ». */
  function shell(rootEl) {
    const status = h('div', { class: 'pt-status', 'aria-live': 'polite' });
    const content = h('div', { class: 'pt-content', hidden: true });
    rootEl.replaceChildren(status, content);
    return {
      content,
      loading() {
        status.replaceChildren(h('p', { class: 'muted pt-loading', role: 'status', text: 'Chargement…' }));
        content.hidden = true;
      },
      ready() {
        status.replaceChildren();
        content.hidden = false;
      },
      /** `keep` : le contenu déjà affiché reste (un rafraîchissement raté n'efface rien). */
      fail(title, err, retry, keep = false) {
        status.replaceChildren(loadError(title, err, retry));
        content.hidden = !keep;
      },
    };
  }

  /** Clé (data-key) de la commande qui a le focus dans le conteneur, à lui rendre une fois la liste reconstruite. */
  const focusKeyIn = (container) => {
    const a = document.activeElement;
    return a && container.contains(a) && a.dataset.key ? a.dataset.key : null;
  };
  /** Rend le focus à la commande de même clé ; si elle a disparu, à `fallback`. */
  const restoreFocus = (container, key, fallback) => {
    if (!key) return;
    const el = container.querySelector(`[data-key="${CSS.escape(key)}"]`);
    (el && !el.disabled ? el : fallback)?.focus({ preventScroll: Boolean(el) });
  };
  /** Champ avec libellé, aide et zone d'erreur reliée (jamais écrasée : construite une fois). */
  function fieldBlock(label, input, hint = '') {
    const err = h('p', { class: 'form-error', id: ui.uid('pt-err'), 'aria-live': 'polite' });
    return { el: h('div', { class: 'pt-field' }, ui.field(h, label, input, hint), err), err };
  }
  const clearErrors = (form, errs) => {
    for (const e of errs) e.textContent = '';
    for (const el of form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
  };
  /** Pose les erreurs en mots, chacune reliée à son champ ; le focus va au PREMIER champ en erreur (on parcourt à l'envers). */
  function showProblems(problems, target) {
    for (const p of [...problems].reverse()) {
      const t = target(p.key);
      if (t) ui.markInvalid(t.control, t.err, p.message);
    }
  }
  /** Remet les enfants d'un conteneur dans l'ordre voulu en ne déplaçant que ce qui doit l'être (le focus reste en place). */
  function syncChildren(parent, wanted) {
    wanted.forEach((el, i) => {
      if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] ?? null);
    });
    while (parent.children.length > wanted.length) parent.lastElementChild.remove();
  }
  /** Annonce aux lecteurs d'écran (zone polie) : le message est relu même s'il est identique au précédent. */
  function sayIn(el, message) {
    el.textContent = el.textContent === message ? `${message} ` : message;
  }
  const checkRow = (input, label) => h('label', { class: 'check pt-check' }, input, h('span', { text: label }));

  // ================================================================ Points de contrôle

  function createPoints(rootEl) {
    const sh = shell(rootEl);
    const st = { items: [], loaded: false, floorId: null, selectedId: null, picks: new Set(), base: null, addFloorTouched: false };
    const drag = { active: false };
    const nudge = { id: null, x: 0, y: 0, from: null, timer: 0 };
    const r = {};
    const labelCards = new Map();
    let built = false;
    let req = 0;
    let printCleanup = null;
    let printWaiting = false;

    const floors = () => (Array.isArray(getFloors?.()) ? getFloors().filter((f) => f && Number.isFinite(f.id)) : []);
    const floorName = (id) => floors().find((f) => f.id === id)?.name ?? 'Étage inconnu';
    const byId2 = (id) => st.items.find((c) => c.id === id) ?? null;
    const selected = () => byId2(st.selectedId);
    const sortedItems = () => {
      const order = floors().map((f) => f.id);
      const rank = (c) => (order.includes(c.floorId) ? order.indexOf(c.floorId) : order.length);
      return [...st.items].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'fr') || a.id - b.id);
    };
    const say = (message) => sayIn(r.announce, message);
    const address = (cp) => labelUrl(location.origin, cp.code);

    // -------------------------------------------------------------- construction (une seule fois)

    function build() {
      built = true;
      const help = h('p', { class: 'hint pt-help', id: 'pt-plan-help', text: 'Glissez un point pour le placer. Au clavier : les flèches le déplacent (Maj pour aller plus vite).' });
      r.floorBar = h('div', { class: 'pt-floor-bar' });
      r.img = h('img', { alt: 'Plan du site', draggable: 'false' });
      r.none = h('div', { class: 'plan-none', hidden: true });
      r.pins = h('div', { class: 'plan-pins' });
      r.stage = h('div', { class: 'plan-stage is-editing' }, h('div', { class: 'plan-sheet' }, r.img, r.none, r.pins));
      r.announce = h('p', { class: 'sr-only', 'aria-live': 'polite' });
      const planPanel = h(
        'section',
        { class: 'panel c-plan pt-plan-panel', 'aria-labelledby': 'pt-plan-title' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'pt-plan-title' }, icon('plan'), 'Plan et points'), r.floorBar),
        h('div', { class: 'panel-body' }, help, r.stage, r.announce),
      );

      // Éditeur du point sélectionné.
      r.zoneList = h('datalist', { id: 'pt-zone-options' });
      r.edName = h('input', { type: 'text', autocomplete: 'off', required: true });
      r.edZone = h('input', { type: 'text', autocomplete: 'off', list: 'pt-zone-options' });
      r.edFloor = h('select', { required: true });
      const fName = fieldBlock('Nom du point', r.edName, 'Ce que l’agent lit sur son téléphone : « Portail principal ».');
      const fZone = fieldBlock('Zone', r.edZone, 'Choisissez une zone existante ou écrivez-en une.');
      const fFloor = fieldBlock('Étage', r.edFloor);
      r.edErrs = { name: fName.err, zone: fZone.err, floor: fFloor.err };
      r.edControls = { name: r.edName, zone: r.edZone, floor: r.edFloor };
      r.edSave = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('check'), 'Enregistrer');
      r.edPrint = h('button', { class: 'btn', type: 'button', onclick: printOne }, icon('printer'), 'Imprimer son étiquette');
      r.edRecode = h('button', { class: 'btn', type: 'button', onclick: recode }, icon('refresh'), 'Nouveau code');
      r.edRemove = h('button', { class: 'btn btn-danger', type: 'button', onclick: removePoint }, icon('trash'), 'Retirer ce point');
      r.edCode = h('code', { class: 'pt-code' });
      r.edAddr = h('code', { class: 'pt-addr' });
      r.edCopy = ui.copyButton(h, { label: 'Copier l’adresse', text: () => r.edAddr.textContent, select: () => r.edAddr });
      r.edError = h('p', { class: 'form-error', role: 'alert' });
      r.edForm = h(
        'form',
        { class: 'pt-form', novalidate: true, onsubmit: saveEditor },
        fName.el,
        fZone.el,
        fFloor.el,
        r.edError,
        h('div', { class: 'actions' }, r.edSave, r.edPrint, r.edRecode),
      );
      r.edBody = h(
        'div',
        { class: 'pt-editor-body', hidden: true },
        r.edForm,
        h(
          'dl',
          { class: 'pt-facts' },
          h('div', {}, h('dt', { text: 'Code du point' }), h('dd', {}, r.edCode)),
          h('div', {}, h('dt', { text: 'Adresse que contient l’étiquette' }), h('dd', {}, r.edAddr, r.edCopy)),
        ),
        h('div', { class: 'pt-danger' }, h('p', { class: 'hint', text: 'Retirer un point le fait disparaître des circuits ; l’historique des passages est conservé.' }), h('div', { class: 'actions' }, r.edRemove)),
      );
      r.edEmpty = h('div', { class: 'empty pt-editor-empty' });
      const editorPanel = h(
        'section',
        { class: 'panel pt-editor-panel', 'aria-labelledby': 'pt-editor-title' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'pt-editor-title' }, icon('pencil'), 'Point sélectionné')),
        h('div', { class: 'panel-body' }, r.edEmpty, r.edBody),
      );

      // Ajout d'un point : formulaire construit une fois, jamais réécrit par un rafraîchissement.
      r.addName = h('input', { type: 'text', autocomplete: 'off', required: true });
      r.addZone = h('input', { type: 'text', autocomplete: 'off', list: 'pt-zone-options' });
      r.addFloor = h('select', { required: true });
      const aName = fieldBlock('Nom du point', r.addName);
      const aZone = fieldBlock('Zone', r.addZone);
      const aFloor = fieldBlock('Étage', r.addFloor);
      r.addErrs = { name: aName.err, zone: aZone.err, floor: aFloor.err };
      r.addControls = { name: r.addName, zone: r.addZone, floor: r.addFloor };
      r.addSubmit = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('plus'), 'Ajouter le point');
      r.addError = h('p', { class: 'form-error', role: 'alert' });
      r.addFloor.addEventListener('change', () => (st.addFloorTouched = true));
      r.addForm = h(
        'form',
        { class: 'pt-form', novalidate: true, onsubmit: addPoint },
        aName.el,
        aZone.el,
        aFloor.el,
        h('p', { class: 'hint', text: 'Le point apparaît au centre du plan : glissez-le ensuite à sa place.' }),
        r.addError,
        h('div', { class: 'actions' }, r.addSubmit),
      );
      const addPanel = h(
        'section',
        { class: 'panel pt-add-panel', 'aria-labelledby': 'pt-add-title' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'pt-add-title' }, icon('plus'), 'Ajouter un point')),
        h('div', { class: 'panel-body' }, r.addForm),
      );

      // Liste des points.
      r.listTitle = h('h2', { id: 'pt-list-title', tabindex: '-1' }, icon('list'), 'Liste des points');
      r.count = h('p', { class: 'pt-count' });
      r.listAdd = h('button', { class: 'btn btn-primary is-apart', type: 'button', onclick: () => r.addName.focus() }, icon('plus'), 'Ajouter un point');
      r.listBody = h('div', { class: 'panel-body' });
      const listPanel = h('section', { class: 'panel pt-list-panel', 'aria-labelledby': 'pt-list-title' }, h('div', { class: 'panel-head' }, r.listTitle, r.count, r.listAdd), r.listBody);

      // Planche d'étiquettes : aperçu à l'écran, impression de la planche seule.
      r.sheetCount = h('p', { class: 'pt-count', 'aria-live': 'polite' });
      r.pickAll = h('button', { class: 'btn btn-sm', type: 'button', text: 'Tout choisir', onclick: () => setPicks(st.items.map((c) => c.id)) });
      r.pickNone = h('button', { class: 'btn btn-sm', type: 'button', text: 'Aucun', onclick: () => setPicks([]) });
      r.printBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: printSheet }, icon('printer'), 'Imprimer la planche');
      r.sheetGrid = h('div', { class: 'pt-sheet-grid' });
      r.sheetEmpty = h('div', { class: 'empty pt-no-print', hidden: true });
      const sheetPanel = h(
        'section',
        { class: 'panel pt-sheet-panel', 'aria-labelledby': 'pt-sheet-title' },
        h('div', { class: 'panel-head pt-no-print' }, h('h2', { id: 'pt-sheet-title' }, icon('printer'), 'Planche d’étiquettes'), r.sheetCount, h('div', { class: 'actions is-apart' }, r.pickAll, r.pickNone, r.printBtn)),
        h(
          'div',
          { class: 'panel-body' },
          h('p', { class: 'hint pt-no-print', text: 'Choisissez les étiquettes dans la liste (colonne « Étiquette »). Imprimez, découpez, puis collez chaque étiquette à l’endroit de son point. Le code sous le QR sert de secours si le scan ne marche pas.' }),
          r.sheetEmpty,
          r.sheetGrid,
        ),
      );

      sh.content.replaceChildren(h('div', { class: 'pt-points-layout' }, planPanel, h('div', { class: 'pt-side' }, editorPanel, addPanel)), listPanel, sheetPanel, r.zoneList);
      // Un clic sur le vide du plan ne change rien ; on ne défait pas une sélection par accident.
      r.edEmpty.append(icon('pin'), h('strong', { text: 'Aucun point sélectionné' }), h('span', { text: 'Touchez un point sur le plan, ou « Modifier » dans la liste, pour le renommer, imprimer son étiquette, changer son code ou le retirer.' }));
    }

    // -------------------------------------------------------------- dessin

    /** Empreinte des étages affichés : un état arrivé après l'ouverture de l'écran (page rechargée sur #/rondes) le redessine. */
    const floorsSignature = () => JSON.stringify(floors().map((f) => [f.id, f.name, f.hasPlan, f.planVersion]));
    let drawnFloors = null;

    function renderAll() {
      drawnFloors = floorsSignature();
      st.floorId = currentFloor()?.id ?? null;
      fillFloors();
      renderZones();
      renderPlan();
      syncEditor();
      renderList();
      renderSheet();
    }

    function fillFloors() {
      const list = floors();
      const key = JSON.stringify(list.map((f) => [f.id, f.name]));
      for (const sel of [r.edFloor, r.addFloor]) {
        if (sel.dataset.key === key) continue;
        const keep = sel.value;
        sel.dataset.key = key;
        sel.replaceChildren(h('option', { value: '', text: list.length ? 'Choisissez un étage' : 'Aucun étage' }), ...list.map((f) => h('option', { value: String(f.id), text: f.name })));
        sel.value = list.some((f) => String(f.id) === keep) ? keep : '';
      }
      const none = list.length === 0;
      r.addSubmit.disabled = none;
      r.addError.textContent = none ? 'Aucun étage : créez-en un dans « Équipements et plan » avant d’ajouter un point.' : r.addError.dataset.kind === 'server' ? r.addError.textContent : '';
      if (!st.addFloorTouched && st.floorId !== null) r.addFloor.value = String(st.floorId);
    }

    function renderZones() {
      const zones = zoneChoices(getZones?.(), st.items);
      const key = JSON.stringify(zones);
      if (r.zoneList.dataset.key === key) return;
      r.zoneList.dataset.key = key;
      r.zoneList.replaceChildren(...zones.map((z) => h('option', { value: z })));
    }

    function currentFloor() {
      const list = floors();
      return list.find((f) => f.id === st.floorId) ?? list[0] ?? null;
    }

    function showFloor(id) {
      st.floorId = id;
      if (!st.addFloorTouched) r.addFloor.value = String(id);
      renderPlan();
      say(`Étage affiché : ${floorName(id)}.`);
    }

    function renderFloorBar(list, floor) {
      const key = JSON.stringify(list.map((f) => [f.id, f.name]));
      r.floorBar.hidden = list.length < 2;
      if (r.floorBar.dataset.key !== key) {
        r.floorBar.dataset.key = key;
        r.floorBar.replaceChildren(
          ...(list.length > 1
            ? [h('div', { class: 'segmented floor-tabs', role: 'group', 'aria-label': 'Étages' }, ...list.map((f) => h('button', { type: 'button', class: 'floor-tab', 'aria-pressed': 'false', dataset: { floor: String(f.id) }, text: f.name, onclick: () => showFloor(f.id) })))]
            : []),
        );
      }
      for (const b of r.floorBar.querySelectorAll('.floor-tab')) b.setAttribute('aria-pressed', String(Number(b.dataset.floor) === floor?.id));
    }

    /** Message posé sur le fond du plan quand l'image n'est pas affichée : chargement, échec, ou pas encore de plan. */
    function planMessage(kind, floor) {
      const key = `${kind}|${floor?.id ?? ''}|${floor?.name ?? ''}`;
      if (r.none.dataset.key === key) return;
      r.none.dataset.key = key;
      r.none.dataset.state = kind;
      const card = (...children) => r.none.replaceChildren(h('div', { class: 'plan-none-card' }, ...children));
      if (kind === 'loading') card(h('span', { class: 'plan-spinner', 'aria-hidden': 'true' }), h('strong', { text: 'Chargement du plan…' }));
      else if (kind === 'error') {
        card(
          icon('state-offline'),
          h('strong', { text: 'Le plan n’a pas pu être chargé.' }),
          h('span', { text: 'Vérifiez le réseau, puis réessayez.' }),
          h('button', { class: 'btn btn-sm', type: 'button', text: 'Réessayer', onclick: () => {
            r.img.dataset.src = '';
            r.img.dataset.failed = '';
            r.none.dataset.key = '';
            renderPlan();
          } }),
        );
      } else if (kind === 'nofloor') {
        card(icon('plan'), h('strong', { text: 'Aucun étage' }), h('span', { text: 'Créez un étage dans Équipements et plan, puis téléversez son plan.' }));
      } else card(icon('plan'), h('strong', { text: 'Pas encore de plan pour cet étage' }), h('span', { text: 'Téléversez-le dans Équipements et plan. Vous pouvez déjà placer les points sur cette grille.' }));
    }

    function pinEl(cp) {
      const isSel = cp.id === st.selectedId;
      const pin = h(
        'button',
        {
          type: 'button',
          class: `pin detector normal cat-people editable${isSel ? ' selected' : ''}`,
          title: `${cp.name}${cp.zone ? ` - ${cp.zone}` : ''}`,
          'aria-label': `Point de contrôle ${cp.name}, zone ${cp.zone || 'non précisée'}${isSel ? ', sélectionné' : ''}`,
          'aria-describedby': 'pt-plan-help',
          dataset: { id: String(cp.id) },
        },
        h('span', { class: 'pin-glyph' }, icon('pin')),
        h('span', { class: 'pin-label', text: cp.name }),
      );
      pin.style.left = `${cp.x}%`;
      pin.style.top = `${cp.y}%`;
      // Étiquette près du bord du plan : à côté ou au-dessus, pour ne pas sortir de la feuille.
      const side = cp.x > 86 ? 'lbl-left' : cp.x < 14 ? 'lbl-right' : cp.y > 84 ? 'lbl-top' : '';
      if (side) pin.classList.add(side);
      pin.addEventListener('pointerdown', (ev) => onPinDown(ev, cp.id, pin));
      // Clavier (Entrée, Espace) : un « click » sans pointeur (detail 0) ; le clic souris est déjà traité au relâchement.
      pin.addEventListener('click', (ev) => ev.detail === 0 && chooseFromPin(cp.id));
      pin.addEventListener('keydown', (ev) => onPinKey(ev, cp.id));
      return pin;
    }

    function renderPlan() {
      if (drag.active) return;
      const list = floors();
      const floor = currentFloor();
      st.floorId = floor?.id ?? null;
      renderFloorBar(list, floor);
      // Les pastilles d'un étage ne sont jamais dessinées sur le plan d'un autre : l'image de CET étage doit être chargée.
      const hasPlan = Boolean(floor?.hasPlan);
      const src = floor && hasPlan ? `/api/floors/${floor.id}/plan?v=${floor.planVersion ?? 0}` : '';
      if (hasPlan && r.img.dataset.src !== src) {
        r.img.dataset.src = src;
        r.img.dataset.ready = '';
        r.img.dataset.failed = '';
        r.img.onload = () => {
          if (r.img.dataset.src !== src) return;
          r.img.dataset.ready = '1';
          renderPlan();
        };
        r.img.onerror = () => {
          if (r.img.dataset.src !== src) return;
          r.img.dataset.failed = '1';
          renderPlan();
        };
        r.img.src = src;
      }
      const planShown = hasPlan && r.img.dataset.ready === '1';
      r.stage.classList.toggle('no-plan', !planShown);
      r.none.hidden = planShown;
      if (!planShown) planMessage(!floor ? 'nofloor' : !hasPlan ? 'none' : r.img.dataset.failed === '1' ? 'error' : 'loading', floor);
      r.img.hidden = !planShown;
      r.img.alt = floor ? `Plan : ${floor.name}` : 'Plan du site';

      const focusedId = r.pins.contains(document.activeElement) ? document.activeElement.dataset.id : null;
      const here = !hasPlan || planShown ? st.items.filter((c) => c.floorId === floor?.id) : [];
      r.pins.replaceChildren(...here.map(pinEl));
      if (focusedId) r.pins.querySelector(`[data-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
    }

    function focusPin(id, scroll = false) {
      r.pins.querySelector(`[data-id="${CSS.escape(String(id))}"]`)?.focus({ preventScroll: !scroll });
    }

    // -------------------------------------------------------------- éditeur

    const editorDirty = () => Boolean(st.base) && (r.edName.value !== st.base.name || r.edZone.value !== st.base.zone || r.edFloor.value !== st.base.floorId);

    /** Remplit l'éditeur du point sélectionné ; une saisie en cours n'est jamais écrasée par un rafraîchissement. */
    function syncEditor() {
      const cp = selected();
      r.edEmpty.hidden = Boolean(cp);
      r.edBody.hidden = !cp;
      if (!cp) {
        st.base = null;
        r.edEmpty.querySelector('span').textContent = st.items.length
          ? 'Touchez un point sur le plan, ou « Modifier » dans la liste, pour le renommer, imprimer son étiquette, changer son code ou le retirer.'
          : 'Aucun point pour l’instant. Ajoutez-en un avec « Ajouter un point » : il apparaît au centre du plan, il ne reste qu’à le glisser à sa place.';
        return;
      }
      const switched = st.base?.id !== cp.id;
      if (switched || !editorDirty()) {
        r.edName.value = cp.name;
        r.edZone.value = cp.zone;
        r.edFloor.value = String(cp.floorId);
        if (r.edFloor.value !== String(cp.floorId)) r.edFloor.value = '';
        st.base = { id: cp.id, name: cp.name, zone: cp.zone, floorId: r.edFloor.value };
        if (switched) {
          clearErrors(r.edForm, [...Object.values(r.edErrs), r.edError]);
        }
      }
      r.edCode.textContent = cp.code || '—';
      r.edAddr.textContent = cp.code ? address(cp) : '—';
    }

    /** Choisit un point. Si l'éditeur contient une saisie non enregistrée d'un autre point, on demande avant de l'abandonner. */
    async function select(id) {
      if (id === st.selectedId) return true;
      if (st.base && editorDirty()) {
        const ok = await dialogs.confirm({
          heading: 'Modifications non enregistrées',
          message: `Vous avez modifié le point « ${st.base.name} » sans l’enregistrer. Les abandonner ?`,
          confirmLabel: 'Abandonner mes modifications',
          danger: false,
        });
        if (!ok) return false;
      }
      st.selectedId = id;
      st.base = null;
      renderPlan();
      syncEditor();
      renderList();
      const cp = selected();
      if (cp) say(`Point « ${cp.name} » sélectionné. Modifiez-le dans « Point sélectionné », ou déplacez-le avec les flèches.`);
      return true;
    }

    /** Touche ou Entrée sur une pastille : la sélectionne et rend son éditeur visible. Le focus reste sur la pastille (les flèches la déplacent). */
    async function chooseFromPin(id) {
      if (!(await select(id))) return focusPin(id);
      focusPin(id);
      const box = r.edBody.getBoundingClientRect();
      if (box.top > window.innerHeight || box.bottom < 0) r.edBody.scrollIntoView({ block: 'nearest' });
    }

    async function saveEditor(ev) {
      ev.preventDefault();
      const cp = selected();
      if (!cp || r.edSave.disabled) return;
      const errs = [...Object.values(r.edErrs), r.edError];
      clearErrors(r.edForm, errs);
      const form = { name: r.edName.value, zone: r.edZone.value, floorId: r.edFloor.value };
      const problems = checkpointProblems(form);
      if (problems.length) return showProblems(problems, (key) => ({ control: r.edControls[key], err: r.edErrs[key] }));
      ui.setBusy(r.edSave, true);
      try {
        await api(`/api/patrols/checkpoints/${cp.id}`, { method: 'PATCH', body: buildCheckpointPayload(form) });
      } catch (err) {
        ui.setBusy(r.edSave, false);
        r.edError.textContent = `Le point n’a pas été enregistré : ${sentence(err.message)}`;
        r.edSave.focus();
        return;
      }
      ui.setBusy(r.edSave, false);
      const payload = buildCheckpointPayload(form);
      st.base = { id: cp.id, name: payload.name, zone: payload.zone, floorId: String(payload.floorId) };
      Object.assign(cp, { name: payload.name, zone: payload.zone, floorId: payload.floorId });
      if (payload.floorId !== st.floorId) st.floorId = payload.floorId; // le point change d'étage : on le suit
      toast(`Point « ${payload.name} » enregistré`, 'ok');
      renderAll();
      r.edSave.focus();
      load();
    }

    async function recode() {
      const cp = selected();
      if (!cp) return;
      const ok = await dialogs.confirm({
        heading: 'Nouveau code',
        message: 'Les étiquettes déjà imprimées de ce point ne marcheront plus : il faudra les remplacer.',
        details: `Un nouveau code est créé pour « ${cp.name} ». Imprimez ensuite sa nouvelle étiquette et remplacez l’ancienne.`,
        confirmLabel: 'Créer un nouveau code',
        onConfirm: () => api(`/api/patrols/checkpoints/${cp.id}/recode`, { method: 'POST' }),
      });
      if (!ok) return;
      toast(`Nouveau code créé pour « ${cp.name} » : imprimez sa nouvelle étiquette`, 'ok');
      await load();
      r.edPrint.focus();
    }

    async function removePoint() {
      const cp = selected();
      if (!cp) return;
      const ok = await dialogs.confirm({
        heading: 'Retirer ce point',
        message: `Retirer le point « ${cp.name} » ? Il disparaît des circuits ; l'historique des passages est conservé.`,
        details: 'Son étiquette collée ne servira plus à rien : pensez à la décoller.',
        confirmLabel: 'Retirer le point',
        onConfirm: () => api(`/api/patrols/checkpoints/${cp.id}`, { method: 'DELETE' }),
      });
      if (!ok) return;
      st.items = st.items.filter((c) => c.id !== cp.id);
      st.picks.delete(cp.id);
      st.selectedId = null;
      st.base = null;
      toast(`Point « ${cp.name} » retiré`, 'ok');
      renderAll();
      (r.pins.querySelector('.pin') ?? r.addName).focus();
      load();
    }

    // -------------------------------------------------------------- ajout

    async function addPoint(ev) {
      ev.preventDefault();
      if (r.addSubmit.disabled) return;
      const errs = [...Object.values(r.addErrs), r.addError];
      clearErrors(r.addForm, errs);
      delete r.addError.dataset.kind;
      const form = { name: r.addName.value, zone: r.addZone.value, floorId: r.addFloor.value };
      const problems = checkpointProblems(form);
      if (problems.length) return showProblems(problems, (key) => ({ control: r.addControls[key], err: r.addErrs[key] }));
      ui.setBusy(r.addSubmit, true);
      let created;
      try {
        const res = await api('/api/patrols/checkpoints', { method: 'POST', body: { ...buildCheckpointPayload(form), x: 50, y: 50 } });
        created = normCheckpoint(isObject(res) && isObject(res.checkpoint) ? res.checkpoint : res);
      } catch (err) {
        ui.setBusy(r.addSubmit, false);
        r.addError.dataset.kind = 'server';
        r.addError.textContent = `Le point n’a pas été ajouté : ${sentence(err.message)}`;
        r.addSubmit.focus();
        return;
      }
      ui.setBusy(r.addSubmit, false);
      const name = buildCheckpointPayload(form).name;
      r.addName.value = '';
      r.addZone.value = '';
      st.addFloorTouched = false;
      // Le nouveau point rejoint la planche. La saisie en cours dans l'éditeur n'est jamais remplacée.
      const floorId = Number(form.floorId);
      if (Number.isFinite(floorId)) st.floorId = floorId;
      if (Number.isFinite(created.id)) {
        st.picks.add(created.id);
        if (!byId2(created.id)) st.items = [...st.items, { ...created, name: created.name || name, floorId: Number.isFinite(created.floorId) ? created.floorId : floorId }];
      }
      const keepDraft = Boolean(st.base) && editorDirty();
      if (Number.isFinite(created.id) && !keepDraft) {
        st.selectedId = created.id;
        st.base = null;
      }
      renderAll();
      toast(`Point « ${name} » ajouté`, 'ok');
      if (Number.isFinite(created.id)) {
        focusPin(created.id, true);
        say(keepDraft ? `Point « ${name} » ajouté au centre du plan. Appuyez sur Entrée pour le sélectionner.` : `Point « ${name} » ajouté au centre du plan. Glissez-le à sa place, ou utilisez les flèches.`);
      } else say(`Point « ${name} » ajouté.`);
      load();
    }

    // -------------------------------------------------------------- glisser et flèches

    function onPinDown(ev, id, pin) {
      if (ev.button > 0) return; // seul le bouton principal (ou le doigt) saisit la pastille
      ev.preventDefault();
      const sheet = r.pins; // repère des positions : la feuille du plan (x, y sont en % de l'image)
      const startX = ev.clientX;
      const startY = ev.clientY;
      const from = { x: byId2(id)?.x ?? 50, y: byId2(id)?.y ?? 50 };
      let moved = false;
      pin.setPointerCapture(ev.pointerId);

      const move = (e) => {
        if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
        if (!moved) pin.classList.add('is-dragging'); // la pastille « se soulève » sous le doigt
        moved = true;
        drag.active = true;
        const rect = sheet.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        pin.style.left = `${Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100))}%`;
        pin.style.top = `${Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100))}%`;
      };
      const detach = () => {
        pin.removeEventListener('pointermove', move);
        pin.removeEventListener('pointerup', up);
        pin.removeEventListener('pointercancel', cancel);
        pin.removeEventListener('lostpointercapture', lost);
      };
      // Capture perdue sans relâchement (écran quitté, pastille retirée) : le glissement est abandonné, rien n'est enregistré.
      const lost = () => {
        detach();
        drag.active = false;
        renderPlan();
      };
      const up = async () => {
        detach();
        pin.classList.remove('is-dragging');
        if (!moved) {
          drag.active = false;
          chooseFromPin(id);
          return;
        }
        const x = Math.round(parseFloat(pin.style.left) * 10) / 10;
        const y = Math.round(parseFloat(pin.style.top) * 10) / 10;
        const item = byId2(id);
        if (item) Object.assign(item, { x, y });
        drag.active = false;
        renderPlan();
        focusPin(id);
        try {
          await api(`/api/patrols/checkpoints/${id}`, { method: 'PATCH', body: { x, y } });
          say('Position enregistrée.');
        } catch (err) {
          toast(`Le point n’a pas été déplacé : ${sentence(err.message)}`);
          const cur = byId2(id);
          if (cur) Object.assign(cur, from); // refusé : la pastille revient où le serveur l'a gardée
          renderPlan();
        }
      };
      // Geste interrompu par le navigateur (le doigt fait défiler la page) : un glissement commencé est enregistré, un simple appui n'est pas pris pour un clic.
      const cancel = () => {
        if (moved) return up();
        detach();
        drag.active = false;
      };
      pin.addEventListener('pointermove', move);
      pin.addEventListener('pointerup', up);
      pin.addEventListener('pointercancel', cancel);
      pin.addEventListener('lostpointercapture', lost);
    }

    /** Flèches : 0,5 % du plan (2 % avec Maj). La pastille bouge tout de suite ; la position part au serveur quand on s'arrête. */
    function onPinKey(ev, id) {
      const step = ev.shiftKey ? 2 : 0.5;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
      const cp = byId2(id);
      if (!delta || !cp || ev.altKey || ev.ctrlKey || ev.metaKey) return;
      ev.preventDefault();
      if (nudge.id !== id) {
        flushNudge();
        Object.assign(nudge, { id, x: cp.x, y: cp.y, from: { x: cp.x, y: cp.y } });
      }
      nudge.x = Math.round(Math.min(100, Math.max(0, nudge.x + delta[0])) * 10) / 10;
      nudge.y = Math.round(Math.min(100, Math.max(0, nudge.y + delta[1])) * 10) / 10;
      Object.assign(cp, { x: nudge.x, y: nudge.y });
      renderPlan(); // la pastille recréée retrouve le focus (même identifiant)
      clearTimeout(nudge.timer);
      nudge.timer = setTimeout(flushNudge, NUDGE_MS);
    }

    async function flushNudge() {
      clearTimeout(nudge.timer);
      const { id, x, y, from } = nudge;
      nudge.id = null;
      if (!id) return;
      try {
        await api(`/api/patrols/checkpoints/${id}`, { method: 'PATCH', body: { x, y } });
        say('Position enregistrée.');
      } catch (err) {
        toast(`Le point n’a pas été déplacé : ${sentence(err.message)}`);
        const cp = byId2(id);
        if (cp && from) Object.assign(cp, from);
        renderPlan();
      }
    }

    // -------------------------------------------------------------- liste

    function renderList() {
      const items = sortedItems();
      const key = focusKeyIn(r.listBody);
      r.count.textContent = items.length ? plural(items.length, 'point') : '';
      r.listAdd.hidden = items.length === 0;
      if (!items.length) {
        r.listBody.replaceChildren(
          h(
            'div',
            { class: 'empty' },
            icon('pin'),
            h('strong', { text: 'Aucun point de contrôle' }),
            h('span', { text: 'Un point de contrôle est un endroit que l’agent doit atteindre pendant sa ronde : le portail, le parking, le local technique… On y colle une étiquette (QR code ou NFC) que l’agent scanne avec son téléphone.' }),
            h('button', { class: 'btn btn-primary', type: 'button', onclick: () => r.addName.focus() }, icon('plus'), 'Ajouter un point'),
          ),
        );
        return;
      }
      const row = (cp) => {
        const pick = h('input', { type: 'checkbox', 'aria-label': `Imprimer l’étiquette de ${cp.name}`, dataset: { key: `pick:${cp.id}` } });
        pick.checked = st.picks.has(cp.id);
        pick.addEventListener('change', () => {
          if (pick.checked) st.picks.add(cp.id);
          else st.picks.delete(cp.id);
          renderSheet();
        });
        const edit = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': `Modifier le point ${cp.name}`, dataset: { key: `edit:${cp.id}` } }, icon('pencil'), 'Modifier');
        edit.addEventListener('click', async () => {
          if (!(await select(cp.id))) return;
          r.edName.focus();
          r.edBody.scrollIntoView({ block: 'nearest' });
        });
        return h(
          'tr',
          { class: cp.id === st.selectedId ? 'is-selected' : '' },
          h('td', { 'data-label': 'Point' }, h('strong', { class: 'pt-cell-name', text: cp.name || `Point n° ${cp.id}` })),
          h('td', { 'data-label': 'Zone', text: cp.zone || '—' }),
          h('td', { 'data-label': 'Étage', text: floorName(cp.floorId) }),
          h('td', { 'data-label': 'Code' }, h('code', { class: 'pt-code', text: cp.code || '—' })),
          h('td', { 'data-label': 'Étiquette' }, checkRow(pick, 'À imprimer')),
          h('td', { class: 'adm-actions-cell' }, h('div', { class: 'actions' }, edit)),
        );
      };
      r.listBody.replaceChildren(
        h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            { class: 'data adm-stack pt-table' },
            h('caption', { class: 'sr-only', text: plural(items.length, 'point de contrôle', 'points de contrôle') }),
            h('thead', {}, h('tr', {}, th('Point'), th('Zone'), th('Étage'), th('Code'), th('Étiquette'), h('th', { scope: 'col' }, h('span', { class: 'sr-only', text: 'Actions' })))),
            h('tbody', {}, ...items.map(row)),
          ),
        ),
      );
      restoreFocus(r.listBody, key, r.listTitle);
    }

    // -------------------------------------------------------------- planche d'étiquettes

    function setPicks(ids) {
      st.picks = new Set(ids);
      for (const box of r.listBody.querySelectorAll('input[type="checkbox"]')) {
        box.checked = st.picks.has(Number(box.dataset.key?.split(':')[1]));
      }
      renderSheet();
    }

    /** Une étiquette découpable : QR, nom, zone, code en clair (saisie de secours) et le mode d'emploi. */
    function labelCard(cp) {
      const key = `${cp.id}|${cp.code}|${cp.name}|${cp.zone}`;
      let el = labelCards.get(key);
      if (el) return el;
      // Le code dans l'adresse de l'image : après un « Nouveau code », le navigateur ne ressert jamais l'ancien QR.
      const img = h('img', { class: 'pt-label-qr', src: `/api/patrols/checkpoints/${cp.id}/qr.svg?v=${encodeURIComponent(cp.code)}`, alt: `QR code du point ${cp.name}` });
      const box = h('div', { class: 'pt-label-qrbox' }, img);
      img.addEventListener('error', () => box.replaceChildren(h('p', { class: 'pt-label-fail', text: 'QR indisponible, utilisez le code' })));
      el = h(
        'article',
        { class: 'pt-label' },
        box,
        h('p', { class: 'pt-label-name', text: cp.name || `Point n° ${cp.id}` }),
        cp.zone ? h('p', { class: 'pt-label-zone', text: cp.zone }) : null,
        h('p', { class: 'pt-label-code' }, 'Saisie de secours : ', h('code', { text: cp.code || '—' })),
        h('p', { class: 'pt-label-hint', text: 'Scannez avec l’application des agents (ou approchez le téléphone si l’étiquette est NFC)' }),
      );
      labelCards.set(key, el);
      return el;
    }

    const picked = () => sortedItems().filter((c) => st.picks.has(c.id));

    function renderSheet() {
      const chosen = picked();
      const alive = new Set(st.items.map((c) => `${c.id}|${c.code}|${c.name}|${c.zone}`));
      for (const key of labelCards.keys()) if (!alive.has(key)) labelCards.delete(key);
      r.sheetCount.textContent = st.items.length ? (chosen.length === 0 ? 'Aucune étiquette choisie' : `${plural(chosen.length, 'étiquette choisie', 'étiquettes choisies')}`) : '';
      r.printBtn.disabled = chosen.length === 0;
      r.pickAll.disabled = st.items.length === 0 || chosen.length === st.items.length;
      r.pickNone.disabled = chosen.length === 0;
      r.sheetEmpty.hidden = chosen.length > 0;
      if (chosen.length === 0) {
        r.sheetEmpty.replaceChildren(icon('printer'), h('strong', { text: st.items.length ? 'Aucune étiquette choisie' : 'Pas encore d’étiquette' }), h('span', { text: st.items.length ? 'Cochez « À imprimer » dans la liste des points, ou cliquez sur « Tout choisir ».' : 'Ajoutez d’abord des points de contrôle : leurs étiquettes apparaîtront ici.' }));
      }
      syncChildren(r.sheetGrid, chosen.map(labelCard));
    }

    /** « Imprimer son étiquette » : la planche ne contient que ce point, prête à imprimer. */
    function printOne() {
      const cp = selected();
      if (!cp) return;
      setPicks([cp.id]);
      r.printBtn.scrollIntoView({ block: 'center' });
      r.printBtn.focus({ preventScroll: true });
      say(`La planche ne contient que l’étiquette de « ${cp.name} ». Appuyez sur « Imprimer la planche ».`);
    }

    /** Attend le chargement des QR (ou leur échec) : une planche imprimée ne doit pas avoir de trous. */
    function imagesSettled(container, timeoutMs = 8000) {
      const pending = [...container.querySelectorAll('img')].filter((i) => !i.complete);
      if (!pending.length) return Promise.resolve();
      return new Promise((resolve) => {
        let left = pending.length;
        const timer = setTimeout(resolve, timeoutMs);
        const one = () => {
          left -= 1;
          if (left <= 0) {
            clearTimeout(timer);
            resolve();
          }
        };
        for (const i of pending) {
          i.addEventListener('load', one, { once: true });
          i.addEventListener('error', one, { once: true });
        }
      });
    }

    function endPrint() {
      document.body.classList.remove('pt-printing');
      window.removeEventListener('afterprint', endPrint);
      printCleanup = null;
    }

    async function printSheet() {
      if (!picked().length || printWaiting) return;
      endPrint(); // reste d'une impression précédente dont « afterprint » n'est jamais venu
      printWaiting = true;
      document.body.classList.add('pt-printing'); // le CSS d'impression ne garde que la planche
      printCleanup = endPrint;
      window.addEventListener('afterprint', endPrint);
      await imagesSettled(r.sheetGrid);
      printWaiting = false;
      if (!printCleanup) return; // l'écran a été quitté pendant l'attente
      window.print();
    }

    // -------------------------------------------------------------- cycle de vie

    async function load() {
      if (!built) build();
      const my = ++req;
      if (!st.loaded) sh.loading();
      try {
        const data = await api('/api/patrols/checkpoints');
        if (my !== req) return; // réponse tardive d'un onglet quitté : on ne touche à rien
        const first = !st.loaded;
        const list = listOf(data, 'checkpoints').map(normCheckpoint).filter((c) => Number.isFinite(c.id) && !c.archived);
        for (const c of list) if (nudge.id === c.id) Object.assign(c, { x: nudge.x, y: nudge.y }); // un déplacement aux flèches en attente reste
        st.items = list;
        if (first) st.picks = new Set(list.map((c) => c.id));
        else st.picks = new Set([...st.picks].filter((id) => list.some((c) => c.id === id)));
        if (st.selectedId !== null && !byId2(st.selectedId)) {
          st.selectedId = null;
          st.base = null;
        }
        st.loaded = true;
        sh.ready();
        renderAll();
      } catch (err) {
        if (my !== req) return;
        sh.fail('Les points de contrôle n’ont pas pu être lus.', err, load, st.loaded);
      }
    }

    function stopPrint() {
      if (printCleanup) endPrint();
    }

    return {
      activate: load,
      /** Les étages du site ont changé ou viennent d'arriver : on redessine seulement s'ils diffèrent de ceux déjà dessinés. */
      refreshFloors() {
        if (built && st.loaded && !drag.active && drawnFloors !== floorsSignature()) renderAll();
      },
      deactivate() {
        req += 1;
        flushNudge();
        stopPrint();
      },
      hide() {
        req += 1;
        flushNudge();
        stopPrint();
        drag.active = false;
      },
      reset() {
        req += 1;
        clearTimeout(nudge.timer);
        nudge.id = null;
        drag.active = false;
        stopPrint();
        Object.assign(st, { items: [], loaded: false, floorId: null, selectedId: null, picks: new Set(), base: null, addFloorTouched: false });
        labelCards.clear();
        built = false;
        printWaiting = false;
        Object.assign(sh, shell(rootEl));
      },
    };
  }

  // ================================================================ Circuits

  function createRoutes(rootEl) {
    const sh = shell(rootEl);
    const st = { items: [], points: [], agents: [], agentsFailed: false, loaded: false, editing: null, form: null, baseKey: '', opener: null };
    const f = {};
    const cards = new Map();
    let slotRefs = [];
    let built = false;
    let req = 0;
    let agentsReq = 0;

    const pointOf = (id) => st.points.find((p) => p.id === id) ?? null;
    const pointName = (id) => pointOf(id)?.name || `Point n° ${id}`;
    const agentName = (u) => st.agents.find((a) => a.username === u)?.displayName ?? u;
    const floors = () => (Array.isArray(getFloors?.()) ? getFloors() : []);
    const floorName = (id) => floors().find((fl) => fl?.id === id)?.name ?? '';
    const ctx = () => ({ checkpointIds: new Set(st.points.map((p) => p.id)), agentNames: st.agentsFailed ? null : new Set(st.agents.map((a) => a.username)) });
    const isDirty = () => st.form !== null && routeFormKey(st.form) !== st.baseKey;
    const sortedPoints = () => {
      const order = floors().map((fl) => fl.id);
      const rank = (p) => (order.includes(p.floorId) ? order.indexOf(p.floorId) : order.length);
      return [...st.points].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'fr') || a.id - b.id);
    };

    /** Choix à une grande cible : l'option choisie est cernée ET cochée (comme dans l'écran Règles). */
    const choice = (input, label, hint) => h('label', { class: 'pt-choice' }, input, h('span', { class: 'pt-choice-text' }, h('span', { class: 'pt-choice-label', text: label }), hint ? h('span', { class: 'hint', text: hint }) : null));

    // -------------------------------------------------------------- construction du formulaire (une seule fois)

    function build() {
      built = true;
      const idn = ui.uid('pt-form');
      f.title = h('h2', { id: `${idn}-title`, tabindex: '-1' });
      f.notice = h('div', { class: 'notice is-warning', role: 'status', hidden: true }, icon('state-warning'), h('span', { text: 'Le circuit que vous modifiiez a été supprimé entre-temps : « Enregistrer » le recrée.' }));

      f.name = h('input', { type: 'text', autocomplete: 'off', required: true });
      const nameB = fieldBlock('Nom du circuit', f.name, 'Par exemple « Ronde de nuit ».');

      // Points à contrôler : cases à cocher, puis la liste ordonnée de ceux qui sont choisis.
      f.pickBox = h('div', { class: 'pt-picks' });
      f.pickAll = h('button', { class: 'btn btn-sm', type: 'button', text: 'Tout choisir', onclick: () => setAllPoints(true) });
      f.pickNone = h('button', { class: 'btn btn-sm', type: 'button', text: 'Aucun', onclick: () => setAllPoints(false) });
      f.orderHead = h('h4', { text: 'Ordre de passage' });
      f.orderHint = h('p', { class: 'hint', text: 'Utilisez « Monter » et « Descendre » pour mettre les points dans l’ordre où l’agent doit les atteindre.' });
      f.orderList = h('ol', { class: 'pt-order' });
      f.live = h('p', { class: 'sr-only', 'aria-live': 'polite' });
      f.pointsErr = h('p', { class: 'form-error', id: ui.uid('pt-err'), 'aria-live': 'polite' });
      const pointsBox = h(
        'fieldset',
        { class: 'pt-box' },
        h('legend', { text: 'Points à contrôler' }),
        h('p', { class: 'hint', text: 'Cochez les points que l’agent doit atteindre pendant la ronde.' }),
        h('div', { class: 'actions' }, f.pickAll, f.pickNone),
        f.pickBox,
        f.orderHead,
        f.orderHint,
        f.orderList,
        f.pointsErr,
        f.live,
      );

      // Ordre : dans l'ordre indiqué, ou n'importe lequel.
      const orderName = ui.uid('pt-ordered');
      f.orderedYes = h('input', { type: 'radio', name: orderName });
      f.orderedNo = h('input', { type: 'radio', name: orderName });
      f.orderedYes.addEventListener('change', () => setOrdered(true));
      f.orderedNo.addEventListener('change', () => setOrdered(false));
      const orderBox = h(
        'fieldset',
        { class: 'pt-box' },
        h('legend', { text: 'Ordre' }),
        h('div', { class: 'pt-choices' }, choice(f.orderedYes, 'Dans l’ordre indiqué', 'Un point scanné trop tôt ne compte pas.'), choice(f.orderedNo, 'Dans n’importe quel ordre', 'Seul compte le fait que tous les points soient scannés.')),
      );

      f.max = h('input', { type: 'number', inputmode: 'numeric', min: '1', max: String(MAX_ROUTE_MINUTES), step: '1', required: true });
      const maxB = fieldBlock('Durée maximale (en minutes)', f.max, 'La ronde doit être finie dans ce délai après son début.');

      // Quand : plages horaires.
      f.slots = h('ul', { class: 'pt-slots' });
      f.slotsEmpty = h('p', { class: 'hint', text: 'Aucune plage pour l’instant : ajoutez-en au moins une.' });
      f.addSlot = h('button', { class: 'btn', type: 'button', onclick: addSlot }, icon('plus'), 'Ajouter une plage');
      f.slotsMax = h('p', { class: 'hint', hidden: true, text: `${MAX_WINDOWS} plages au plus : regroupez les jours qui ont les mêmes heures.` });
      f.scheduleErr = h('p', { class: 'form-error', id: ui.uid('pt-err'), 'aria-live': 'polite' });
      const whenBox = h(
        'fieldset',
        { class: 'pt-box' },
        h('legend', { text: 'Quand' }),
        h('p', { class: 'hint', text: 'L’heure de début est celle où la ronde doit commencer. Une plage de nuit (22:00 → 06:00) commence les jours choisis.' }),
        f.slotsEmpty,
        f.slots,
        h('div', { class: 'pt-add' }, f.addSlot, f.slotsMax),
        f.scheduleErr,
      );

      // Agents concernés.
      const agentsName = ui.uid('pt-agents');
      f.agentsAll = h('input', { type: 'radio', name: agentsName });
      f.agentsSome = h('input', { type: 'radio', name: agentsName });
      f.agentsAll.addEventListener('change', () => setAgentsMode('all'));
      f.agentsSome.addEventListener('change', () => setAgentsMode('some'));
      f.agentsList = h('div', { class: 'pt-agents', hidden: true });
      f.agentsErr = h('p', { class: 'form-error', id: ui.uid('pt-err'), 'aria-live': 'polite' });
      const agentsBox = h(
        'fieldset',
        { class: 'pt-box' },
        h('legend', { text: 'Agents concernés' }),
        h('div', { class: 'pt-choices' }, choice(f.agentsAll, 'Tout agent en service', 'La ronde est attendue de celui qui est en service.'), choice(f.agentsSome, 'Certains agents seulement', 'Seuls les agents cochés peuvent la faire.')),
        f.agentsList,
        f.agentsErr,
      );

      f.grace = h('input', { type: 'number', inputmode: 'numeric', min: '0', max: String(MAX_GRACE), step: '1', required: true });
      const graceB = fieldBlock('Délai avant alarme critique (en minutes)', f.grace, 'Si une ronde reste incomplète, l’alerte devient critique après ce délai.');

      f.enabled = h('input', { type: 'checkbox' });
      f.enabled.addEventListener('change', () => (st.form.enabled = f.enabled.checked));
      f.sentence = h('p', { class: 'pt-sentence-text' });

      f.errs = { name: nameB.err, checkpoints: f.pointsErr, maxMinutes: maxB.err, schedule: f.scheduleErr, agents: f.agentsErr, graceMinutes: graceB.err };
      f.error = h('p', { class: 'form-error pt-form-error', role: 'alert' });
      f.save = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('check'), 'Enregistrer le circuit');
      f.cancel = h('button', { class: 'btn', type: 'button', text: 'Annuler', onclick: cancelForm });

      for (const [input, key] of [[f.name, 'name'], [f.max, 'maxMinutes'], [f.grace, 'graceMinutes']]) {
        input.addEventListener('input', () => {
          if (!st.form) return;
          st.form[key] = input.value;
          clearField(key, input);
          drawSentence();
        });
      }

      f.form = h(
        'form',
        { class: 'pt-form pt-route-form', novalidate: true, onsubmit: save },
        f.notice,
        nameB.el,
        pointsBox,
        orderBox,
        maxB.el,
        whenBox,
        agentsBox,
        graceB.el,
        h('label', { class: 'check pt-enable' }, f.enabled, h('span', { text: 'Circuit actif : les rondes sont attendues et signalées si elles ne sont pas faites' })),
        h('div', { class: 'pt-sentence' }, h('h3', { text: 'Ce que dira le circuit' }), f.sentence),
        f.error,
        h('div', { class: 'actions pt-form-foot' }, f.save, f.cancel),
      );
      f.slot = h('section', { class: 'panel pt-route-form-panel', 'aria-labelledby': f.title.id, hidden: true }, h('div', { class: 'panel-head' }, f.title), h('div', { class: 'panel-body' }, f.form));

      // Liste des circuits.
      f.count = h('p', { class: 'pt-count' });
      f.listNew = h('button', { class: 'btn btn-primary is-apart', type: 'button', hidden: true }, icon('plus'), 'Créer un circuit');
      f.listNew.addEventListener('click', () => openForm(null, f.listNew));
      f.emptyNew = h('button', { class: 'btn btn-primary', type: 'button' }, icon('plus'), 'Créer un circuit');
      f.emptyNew.addEventListener('click', () => openForm(null, f.emptyNew));
      f.empty = h(
        'div',
        { class: 'empty', hidden: true },
        icon('list'),
        h('strong', { text: 'Aucun circuit pour l’instant' }),
        h('span', { text: 'Un circuit dit quels points l’agent doit contrôler, dans quel ordre, en combien de temps et à quelle heure. Exemple : « 8 points, dans l’ordre, à finir en 45 min, du lundi au vendredi à 22:00 ».' }),
        f.emptyNew,
      );
      f.list = h('ul', { class: 'pt-routes', 'aria-label': 'Circuits enregistrés', hidden: true });
      const listPanel = h('section', { class: 'panel pt-routes-panel', 'aria-labelledby': 'pt-routes-title' }, h('div', { class: 'panel-head' }, h('h2', { id: 'pt-routes-title', tabindex: '-1' }, icon('list'), 'Vos circuits'), f.count, f.listNew), h('div', { class: 'panel-body' }, f.empty, f.list));
      f.listTitle = listPanel.querySelector('h2');
      sh.content.replaceChildren(f.slot, listPanel);
    }

    // -------------------------------------------------------------- erreurs

    function clearField(key, control) {
      const e = f.errs[key];
      if (e) e.textContent = '';
      control?.removeAttribute('aria-invalid');
      f.error.textContent = '';
    }

    function target(key) {
      if (key.startsWith('schedule:')) {
        const ref = slotRefs[Number(key.slice(9))];
        return ref ? { control: ref.firstDay, err: ref.err } : null;
      }
      switch (key) {
        case 'name': return { control: f.name, err: f.errs.name };
        case 'checkpoints': return { control: f.pickBox.querySelector('input') ?? f.pickAll, err: f.errs.checkpoints };
        case 'maxMinutes': return { control: f.max, err: f.errs.maxMinutes };
        case 'schedule': return { control: f.addSlot, err: f.errs.schedule };
        case 'agents': return { control: f.agentsList.querySelector('input') ?? f.agentsSome, err: f.errs.agents };
        case 'graceMinutes': return { control: f.grace, err: f.errs.graceMinutes };
        default: return null;
      }
    }

    // -------------------------------------------------------------- dessin du formulaire

    function syncForm() {
      const form = st.form;
      f.name.value = form.name;
      f.max.value = form.maxMinutes;
      f.grace.value = form.graceMinutes;
      f.enabled.checked = form.enabled;
      f.orderedYes.checked = form.ordered;
      f.orderedNo.checked = !form.ordered;
      f.agentsAll.checked = form.agentsMode === 'all';
      f.agentsSome.checked = form.agentsMode === 'some';
      drawPicks();
      drawOrder();
      drawSlots();
      drawAgents();
      drawSentence();
    }

    function setOrdered(on) {
      st.form.ordered = on;
      drawSentence();
    }

    function setAgentsMode(mode) {
      st.form.agentsMode = mode;
      clearField('agents', null);
      drawAgents();
      drawSentence();
    }

    function setAllPoints(on) {
      st.form.checkpoints = on ? [...st.form.checkpoints, ...sortedPoints().map((p) => p.id).filter((id) => !st.form.checkpoints.includes(id))] : [];
      clearField('checkpoints', null);
      drawPicks();
      drawOrder();
      drawSentence();
    }

    function drawPicks() {
      const key = focusKeyIn(f.pickBox);
      const points = sortedPoints();
      f.pickAll.disabled = points.length === 0;
      f.pickNone.disabled = points.length === 0;
      if (points.length === 0) {
        f.pickBox.replaceChildren(
          h('div', { class: 'notice is-warning' }, icon('state-warning'), h('span', {}, 'Aucun point de contrôle pour l’instant. ', h('button', { class: 'btn btn-sm', type: 'button', text: 'Ajouter des points', onclick: () => selectTab('points', { focus: true }) }))),
        );
        return;
      }
      f.pickBox.replaceChildren(
        ...points.map((p) => {
          const input = h('input', { type: 'checkbox', dataset: { key: `pick:${p.id}` } });
          input.checked = st.form.checkpoints.includes(p.id);
          input.addEventListener('change', () => {
            const list = st.form.checkpoints;
            st.form.checkpoints = input.checked ? (list.includes(p.id) ? list : [...list, p.id]) : list.filter((id) => id !== p.id);
            clearField('checkpoints', null);
            drawOrder();
            drawSentence();
          });
          return h('label', { class: 'pt-pick' }, input, h('span', { class: 'pt-pick-text' }, h('span', { class: 'pt-pick-name', text: p.name }), h('span', { class: 'pt-pick-note', text: `${p.zone || 'Sans zone'} · ${floorName(p.floorId) || 'étage inconnu'}` })));
        }),
      );
      restoreFocus(f.pickBox, key, null);
    }

    function move(id, delta) {
      const list = st.form.checkpoints;
      const i = list.indexOf(id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      drawOrder();
      const btn = (k) => f.orderList.querySelector(`[data-key="${k}:${id}"]:not(:disabled)`);
      (btn(delta < 0 ? 'up' : 'down') ?? btn(delta < 0 ? 'down' : 'up'))?.focus();
      sayIn(f.live, `${pointName(id)} : position ${j + 1} sur ${list.length}.`);
    }

    function dropPoint(id) {
      const list = st.form.checkpoints;
      const i = list.indexOf(id);
      if (i < 0) return;
      st.form.checkpoints = list.filter((x) => x !== id);
      const box = f.pickBox.querySelector(`[data-key="pick:${id}"]`);
      if (box) box.checked = false;
      clearField('checkpoints', null);
      drawOrder();
      drawSentence();
      const next = st.form.checkpoints[Math.min(i, st.form.checkpoints.length - 1)];
      (next !== undefined ? f.orderList.querySelector(`[data-key="drop:${next}"]`) : f.pickBox.querySelector('input'))?.focus();
      sayIn(f.live, `${pointName(id)} retiré du circuit.`);
    }

    function drawOrder() {
      const ids = st.form.checkpoints;
      const empty = ids.length === 0;
      f.orderHead.hidden = empty;
      f.orderHint.hidden = empty;
      f.orderList.hidden = empty;
      f.orderList.replaceChildren(
        ...ids.map((id, i) => {
          const known = pointOf(id);
          const name = known ? known.name : `Point n° ${id} (retiré)`;
          const btn = (k, label, aria, ico, onclick, disabled) => h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': aria, dataset: { key: `${k}:${id}` }, disabled, onclick }, icon(ico), label);
          return h(
            'li',
            { class: `pt-order-item${known ? '' : ' is-missing'}` },
            h('span', { class: 'pt-order-name' }, h('strong', { text: name }), known && known.zone ? h('span', { class: 'pt-order-zone', text: known.zone }) : null),
            h(
              'span',
              { class: 'pt-order-actions' },
              btn('up', 'Monter', `Monter ${name}`, 'chevron-up', () => move(id, -1), i === 0),
              btn('down', 'Descendre', `Descendre ${name}`, 'chevron-down', () => move(id, 1), i === ids.length - 1),
              btn('drop', 'Retirer', `Retirer ${name} du circuit`, 'trash', () => dropPoint(id), false),
            ),
          );
        }),
      );
    }

    function addSlot() {
      if (st.form.schedule.length >= MAX_WINDOWS) return;
      st.form.schedule.push(SUGGESTED_WINDOW());
      clearField('schedule', f.addSlot);
      drawSlots();
      drawSentence();
      slotRefs.at(-1)?.firstDay.focus();
    }

    /** Une plage horaire : jours en boutons bascule, de / à, note de plage de nuit, retrait. (L'éditeur de rules.js reste enfermé dans sa vue.) */
    function slotEl(w, i) {
      const n = i + 1;
      const err = h('p', { class: 'form-error pt-slot-err', id: ui.uid('pt-slot-err'), 'aria-live': 'polite' });
      const note = h('p', { class: 'hint pt-slot-note' });
      const from = h('input', { type: 'time', value: w.from, required: true, 'aria-describedby': err.id });
      const to = h('input', { type: 'time', value: w.to, required: true, 'aria-describedby': err.id });
      const check = () => {
        const problem = windowProblem(w);
        err.textContent = problem ?? '';
        const badTime = Boolean(problem) && w.days.length > 0;
        from.setAttribute('aria-invalid', String(badTime));
        to.setAttribute('aria-invalid', String(badTime));
        note.textContent = nightNote(w);
      };
      const days = DAY_ORDER.map((d) => {
        const b = h('button', { class: 'btn btn-sm pt-day', type: 'button', 'aria-pressed': String(w.days.includes(d)), 'aria-label': DAY_LONG[d], text: DAY_SHORT[d] });
        b.addEventListener('click', () => {
          w.days = w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d];
          b.setAttribute('aria-pressed', String(w.days.includes(d)));
          clearField('schedule', null);
          check();
          drawSentence();
        });
        return b;
      });
      for (const [input, key] of [[from, 'from'], [to, 'to']]) {
        input.addEventListener('input', () => {
          w[key] = input.value;
          clearField('schedule', null);
          check();
          drawSentence();
        });
      }
      const drop = h('button', { class: 'btn btn-sm btn-ghost pt-remove', type: 'button' }, icon('trash'), 'Retirer', h('span', { class: 'sr-only', text: ` la plage ${n}` }));
      drop.addEventListener('click', () => {
        st.form.schedule.splice(i, 1);
        drawSlots();
        drawSentence();
        // Le focus va à la plage qui prend la place, sinon à « Ajouter une plage ».
        const next = slotRefs[i] ?? slotRefs[i - 1];
        (next ? next.firstDay : f.addSlot).focus();
      });
      check();
      slotRefs[i] = { firstDay: days[0], err };
      return h(
        'li',
        { class: 'pt-slot' },
        h(
          'fieldset',
          {},
          h('legend', { text: `Plage ${n}` }),
          h('div', { class: 'pt-days', role: 'group', 'aria-label': `Jours où commence la plage ${n}` }, ...days),
          h('div', { class: 'pt-hours' }, h('label', { class: 'field' }, h('span', { text: 'De' }), from), h('label', { class: 'field' }, h('span', { text: 'À' }), to), drop),
          note,
          err,
        ),
      );
    }

    function drawSlots() {
      slotRefs = [];
      const list = st.form.schedule;
      f.slots.replaceChildren(...list.map(slotEl));
      f.slotsEmpty.hidden = list.length > 0;
      f.addSlot.disabled = list.length >= MAX_WINDOWS;
      f.slotsMax.hidden = list.length < MAX_WINDOWS;
    }

    function drawAgents() {
      const form = st.form;
      const some = form.agentsMode === 'some';
      f.agentsList.hidden = !some;
      if (!some) return;
      const key = focusKeyIn(f.agentsList);
      if (st.agentsFailed) {
        f.agentsList.replaceChildren(
          h('div', { class: 'notice is-warning' }, icon('state-warning'), h('span', {}, 'La liste des agents n’a pas pu être lue. « Tout agent en service » reste possible. ', h('button', { class: 'btn btn-sm', type: 'button', text: 'Réessayer', onclick: loadAgents }))),
        );
        return;
      }
      const known = new Set(st.agents.map((a) => a.username));
      const rows = [...st.agents, ...form.agents.filter((u) => !known.has(u)).map((u) => ({ username: u, displayName: u, unknown: true }))];
      if (!rows.length) {
        f.agentsList.replaceChildren(h('p', { class: 'hint', text: 'Aucun agent pour l’instant : créez-en dans la rubrique « Agents ».' }));
        return;
      }
      f.agentsList.replaceChildren(
        ...rows.map((a) => {
          const input = h('input', { type: 'checkbox', dataset: { key: `agent:${a.username}` } });
          input.checked = form.agents.includes(a.username);
          input.addEventListener('change', () => {
            const list = st.form.agents;
            st.form.agents = input.checked ? (list.includes(a.username) ? list : [...list, a.username]) : list.filter((u) => u !== a.username);
            clearField('agents', null);
            drawSentence();
          });
          return h('label', { class: 'pt-pick' }, input, h('span', { class: 'pt-pick-text' }, h('span', { class: 'pt-pick-name', text: a.displayName || a.username }), h('span', { class: 'pt-pick-note', text: a.unknown ? `${a.username} · compte absent de la liste` : a.username })));
        }),
      );
      restoreFocus(f.agentsList, key, null);
    }

    function drawSentence() {
      f.sentence.textContent = describeRoute(buildRoutePayload(st.form), { checkpointName: pointName, agentName });
    }

    // -------------------------------------------------------------- ouvrir, fermer, enregistrer

    const confirmDiscard = () =>
      dialogs.confirm({
        heading: 'Modifications non enregistrées',
        message: 'Vous avez commencé à remplir le formulaire du circuit sans l’enregistrer. Abandonner cette saisie ?',
        confirmLabel: 'Abandonner ma saisie',
        danger: false,
      });

    async function openForm(route, opener) {
      const wanted = route ? route.id : 'new';
      if (st.editing === wanted) {
        f.name.focus();
        return;
      }
      if (st.editing !== null && isDirty() && !(await confirmDiscard())) return;
      st.opener = opener ?? null;
      st.editing = wanted;
      st.form = route ? formFromRoute(route) : defaultRouteForm();
      st.baseKey = routeFormKey(st.form);
      f.title.textContent = route ? `Modifier le circuit « ${route.name} »` : 'Nouveau circuit';
      clearErrors(f.form, [...Object.values(f.errs), f.error]);
      f.notice.hidden = true;
      syncForm();
      f.slot.hidden = false;
      f.name.focus();
    }

    function closeForm() {
      st.editing = null;
      st.form = null;
      st.baseKey = '';
      f.slot.hidden = true;
    }

    async function cancelForm() {
      if (isDirty() && !(await confirmDiscard())) return;
      const back = st.opener;
      closeForm();
      (back?.isConnected && !back.hidden ? back : f.listNew.hidden ? f.emptyNew : f.listNew).focus();
    }

    async function save(ev) {
      ev.preventDefault();
      if (!st.form || f.save.disabled) return;
      clearErrors(f.form, [...Object.values(f.errs), f.error]);
      for (const ref of slotRefs) ref.err.textContent = '';
      const problems = routeProblems(st.form, ctx());
      if (problems.length) {
        f.error.textContent = problems.length === 1 ? 'Une chose est à corriger avant d’enregistrer.' : `${problems.length} choses sont à corriger avant d’enregistrer.`;
        return showProblems(problems, target);
      }
      const body = buildRoutePayload(st.form);
      const editing = st.editing;
      ui.setBusy(f.save, true);
      let id = typeof editing === 'number' ? editing : null;
      try {
        const res = editing === 'new' ? await api('/api/patrols/routes', { method: 'POST', body }) : await api(`/api/patrols/routes/${editing}`, { method: 'PATCH', body });
        const created = normRoute(isObject(res) && isObject(res.route) ? res.route : res);
        if (Number.isFinite(created.id)) id = created.id;
      } catch (err) {
        ui.setBusy(f.save, false);
        f.error.textContent = `Le circuit n’a pas été enregistré : ${sentence(err.message)}`;
        f.save.focus();
        return;
      }
      ui.setBusy(f.save, false);
      toast(`Circuit « ${body.name} » enregistré`, 'ok');
      closeForm();
      await load();
      const card = id !== null ? cards.get(id) : null;
      (card ? card.el.querySelector('.pt-route-name') : f.listNew.hidden ? f.emptyNew : f.listNew)?.focus();
    }

    // -------------------------------------------------------------- cartes des circuits

    function createCard(id) {
      const c = { id, route: null };
      const nameEl = h('h3', { class: 'pt-route-name', tabindex: '-1', dataset: { key: `name:${id}` } });
      const inactive = h('span', { class: 'tag is-dashed', hidden: true }, icon('state-offline', 'icon-sm'), 'Inactif');
      const toggle = h('input', { type: 'checkbox', role: 'switch', class: 'pt-switch-input', dataset: { key: `toggle:${id}` } });
      const stateIcon = h('span', { class: 'pt-switch-icon' });
      const stateWord = h('span', { class: 'pt-switch-word', id: ui.uid('pt-state') });
      toggle.setAttribute('aria-describedby', stateWord.id);
      const switchEl = h('label', { class: 'pt-switch' }, toggle, h('span', { class: 'pt-switch-track', 'aria-hidden': 'true' }, h('i')), stateIcon, stateWord);
      const phrase = h('p', { class: 'pt-phrase' });
      const meta = h('p', { class: 'hint pt-route-meta' });
      const edit = h('button', { class: 'btn btn-sm', type: 'button', dataset: { key: `edit:${id}` } }, icon('pencil'), 'Modifier');
      const remove = h('button', { class: 'btn btn-sm btn-danger', type: 'button', dataset: { key: `del:${id}` } }, icon('trash'), 'Supprimer');
      const actionError = h('p', { class: 'form-error', role: 'alert' });
      c.el = h('li', { class: 'panel pt-route' }, h('div', { class: 'pt-route-head' }, nameEl, inactive, switchEl), phrase, meta, h('div', { class: 'actions pt-route-actions' }, edit, remove), actionError);

      c.set = (route) => {
        c.route = route;
        nameEl.textContent = route.name || `Circuit n° ${route.id}`;
        phrase.textContent = describeRoute(route, { checkpointName: pointName, agentName });
        const names = uniqueIds(route.checkpoints).map(pointName);
        meta.textContent = names.length ? `Points : ${names.join(route.ordered ? ' puis ' : ', ')}.` : 'Aucun point choisi.';
        c.el.classList.toggle('is-inactive', !route.enabled);
        inactive.hidden = route.enabled;
        toggle.checked = route.enabled;
        toggle.setAttribute('aria-label', `Circuit « ${route.name} » actif`);
        stateIcon.replaceChildren(icon(route.enabled ? 'state-ok' : 'state-offline'));
        stateWord.textContent = route.enabled ? 'Actif' : 'Inactif';
      };

      toggle.addEventListener('change', async () => {
        const on = toggle.checked;
        toggle.disabled = true;
        actionError.textContent = '';
        try {
          await api(`/api/patrols/routes/${id}`, { method: 'PATCH', body: { enabled: on } });
          c.route.enabled = on;
        } catch (err) {
          toggle.checked = !on;
          actionError.textContent = `Le circuit n’a pas été modifié : ${sentence(err.message)}`;
        }
        toggle.disabled = false;
        c.set(c.route);
        toggle.focus();
      });
      edit.addEventListener('click', () => openForm(c.route, edit));
      remove.addEventListener('click', async () => {
        const route = c.route;
        const ok = await dialogs.confirm({
          heading: 'Supprimer le circuit',
          message: `Supprimer le circuit « ${route.name} » ? Il disparaît de la liste et aucune ronde n’est plus attendue.`,
          details: 'L’historique des rondes déjà faites est conservé dans le journal.',
          confirmLabel: 'Supprimer le circuit',
          onConfirm: () => api(`/api/patrols/routes/${id}`, { method: 'DELETE' }),
        });
        if (!ok) return;
        st.items = st.items.filter((r) => r.id !== id);
        cards.delete(id);
        if (st.editing === id) closeForm();
        toast(`Circuit « ${route.name} » supprimé`, 'ok');
        renderList();
        (f.list.querySelector('.pt-route-name') ?? (f.listNew.hidden ? f.emptyNew : f.listNew)).focus();
      });
      return c;
    }

    const uniqueIds = (ids) => [...new Set(ids)];

    function renderList() {
      const items = [...st.items].sort((a, b) => a.name.localeCompare(b.name, 'fr') || a.id - b.id);
      f.count.textContent = items.length ? plural(items.length, 'circuit') : '';
      f.empty.hidden = items.length > 0;
      f.list.hidden = items.length === 0;
      f.listNew.hidden = items.length === 0;
      const wanted = items.map((route) => {
        let c = cards.get(route.id);
        if (!c) {
          c = createCard(route.id);
          cards.set(route.id, c);
        }
        c.set(route);
        return c.el;
      });
      for (const id of [...cards.keys()]) if (!items.some((r) => r.id === id)) cards.delete(id);
      syncChildren(f.list, wanted);
    }

    // -------------------------------------------------------------- chargement

    async function loadAgents() {
      const my = ++agentsReq;
      try {
        const data = await api('/api/agents');
        if (my !== agentsReq) return;
        st.agents = listOf(data, 'agents').map(normAgent).filter((a) => a.username !== '');
        st.agentsFailed = false;
      } catch {
        if (my !== agentsReq) return;
        st.agentsFailed = true; // « Tout agent en service » reste possible
      }
      if (!built) return;
      renderList();
      if (st.form) {
        drawAgents();
        drawSentence();
      }
    }

    async function load() {
      if (!built) build();
      const my = ++req;
      if (!st.loaded) sh.loading();
      loadAgents();
      try {
        const [routes, points] = await Promise.all([api('/api/patrols/routes'), api('/api/patrols/checkpoints')]);
        if (my !== req) return; // réponse tardive d'un onglet quitté : on ne touche à rien
        st.items = listOf(routes, 'routes').map(normRoute).filter((r) => Number.isFinite(r.id) && !r.archived);
        st.points = listOf(points, 'checkpoints').map(normCheckpoint).filter((c) => Number.isFinite(c.id) && !c.archived);
        st.loaded = true;
        sh.ready();
        // Le circuit modifié a disparu : le brouillon reste, « Enregistrer » le recrée.
        if (typeof st.editing === 'number' && !st.items.some((r) => r.id === st.editing)) {
          st.editing = 'new';
          f.title.textContent = 'Nouveau circuit';
          f.notice.hidden = false;
        }
        renderList();
        if (st.form) {
          drawPicks();
          drawOrder();
          drawAgents();
          drawSentence();
        }
      } catch (err) {
        if (my !== req) return;
        sh.fail('Les circuits n’ont pas pu être lus.', err, load, st.loaded);
      }
    }

    return {
      activate: load,
      deactivate() {
        req += 1;
        agentsReq += 1;
      },
      hide() {
        req += 1;
        agentsReq += 1;
      },
      reset() {
        req += 1;
        agentsReq += 1;
        Object.assign(st, { items: [], points: [], agents: [], agentsFailed: false, loaded: false, editing: null, form: null, baseKey: '', opener: null });
        cards.clear();
        slotRefs = [];
        built = false;
        Object.assign(sh, shell(rootEl));
      },
    };
  }

  // ================================================================ Journal : rondes et main courante

  /** Pastille d'état d'une ronde : forme + icône + mot, jamais la couleur seule. */
  const RUN_UI = {
    done: ['is-ok', 'state-ok'],
    incomplete: ['is-warning', 'state-warning'],
    missed: ['is-alarm', 'state-alarm'],
    active: ['is-info', 'play'],
    pending: ['is-offline is-dashed', 'clock'],
  };
  const CATEGORY_UI = { anomaly: ['is-warning', 'state-warning'], damage: ['is-alarm', 'wrench'], visitor: ['is-info', 'user'], other: ['', 'chat'] };

  function createJournal(rootEl) {
    const sh = shell(rootEl);
    const jr = {
      period: 'today',
      routeId: '',
      username: '',
      runs: [],
      entries: [],
      ok: { runs: false, log: false },
      routeOpts: new Map(),
      agentOpts: new Set(),
      opened: new Set(),
      sig: { runs: '', log: '' },
      routeCps: new Map(),
      cpNames: new Map(),
      names: new Map(),
      infoLoaded: false,
      loaded: false,
    };
    const f = {};
    let built = false;
    let req = 0;
    let timer = 0;

    const agentLabel = (username, displayName = '') => displayName || jr.names.get(username) || username || 'Agent inconnu';

    // -------------------------------------------------------------- construction

    function build() {
      built = true;
      f.periodBtns = PERIODS.map((p) => h('button', { type: 'button', 'aria-pressed': String(p.key === jr.period), dataset: { period: p.key }, text: p.label, onclick: () => setPeriod(p.key) }));
      f.period = h('div', { class: 'segmented pt-period', role: 'group', 'aria-label': 'Période' }, ...f.periodBtns);
      f.route = h('select');
      f.agent = h('select');
      f.route.addEventListener('change', () => setFilters());
      f.agent.addEventListener('change', () => setFilters());
      f.refresh = h('button', { class: 'btn', type: 'button', onclick: () => load() }, icon('refresh'), 'Actualiser');
      f.updated = h('p', { class: 'hint pt-updated' });
      const bar = h(
        'section',
        { class: 'panel pt-filter', 'aria-label': 'Filtres du journal' },
        h(
          'div',
          { class: 'panel-body' },
          h('div', { class: 'pt-filter-row' }, h('div', { class: 'pt-filter-period' }, h('span', { class: 'label', text: 'Période' }), f.period), ui.field(h, 'Circuit', f.route), ui.field(h, 'Agent', f.agent), f.refresh),
          h('div', { class: 'pt-filter-foot' }, f.updated, h('p', { class: 'hint', text: 'Les filtres Circuit et Agent ne concernent que les rondes.' })),
        ),
      );

      f.runsCount = h('p', { class: 'pt-count' });
      f.runsStatus = h('div', { class: 'pt-block-status' });
      f.runsBody = h('div', { class: 'pt-block-body' });
      const runsPanel = h('section', { class: 'panel pt-runs-panel', 'aria-labelledby': 'pt-runs-title' }, h('div', { class: 'panel-head' }, h('h2', { id: 'pt-runs-title' }, icon('history'), 'Rondes'), f.runsCount), h('div', { class: 'panel-body' }, f.runsStatus, f.runsBody));

      f.logCount = h('p', { class: 'pt-count' });
      f.logStatus = h('div', { class: 'pt-block-status' });
      f.logBody = h('div', { class: 'pt-block-body' });
      const logPanel = h('section', { class: 'panel pt-log-panel', 'aria-labelledby': 'pt-log-title' }, h('div', { class: 'panel-head' }, h('h2', { id: 'pt-log-title' }, icon('doc'), 'Main courante'), f.logCount), h('div', { class: 'panel-body' }, f.logStatus, f.logBody));
      sh.content.replaceChildren(bar, runsPanel, logPanel);
      fillSelects();
    }

    function fillSelect(select, options, current, allLabel) {
      const key = JSON.stringify([options, current]);
      if (select.dataset.key === key) return;
      select.dataset.key = key;
      select.replaceChildren(h('option', { value: '', text: allLabel }), ...options.map(([value, label]) => h('option', { value, text: label })));
      select.value = current;
    }

    function fillSelects() {
      if (jr.routeId && !jr.routeOpts.has(Number(jr.routeId))) jr.routeOpts.set(Number(jr.routeId), `Circuit n° ${jr.routeId}`);
      if (jr.username) jr.agentOpts.add(jr.username);
      const routes = [...jr.routeOpts].sort((a, b) => a[1].localeCompare(b[1], 'fr')).map(([id, name]) => [String(id), name]);
      const agentsOpts = [...jr.agentOpts].sort((a, b) => agentLabel(a).localeCompare(agentLabel(b), 'fr')).map((u) => [u, agentLabel(u)]);
      fillSelect(f.route, routes, jr.routeId, 'Tous les circuits');
      fillSelect(f.agent, agentsOpts, jr.username, 'Tous les agents');
    }

    function setPeriod(key) {
      if (key === jr.period) return;
      jr.period = key;
      jr.routeOpts = new Map();
      jr.agentOpts = new Set();
      jr.ok = { runs: false, log: false };
      jr.sig = { runs: '', log: '' };
      for (const b of f.periodBtns) b.setAttribute('aria-pressed', String(b.dataset.period === key));
      fillSelects();
      load();
    }

    function setFilters() {
      jr.routeId = f.route.value;
      jr.username = f.agent.value;
      jr.ok.runs = false;
      jr.sig.runs = '';
      load();
    }

    // -------------------------------------------------------------- les rondes

    const lookup = () => ({ routeCheckpoints: jr.routeCps, checkpointName: (id) => jr.cpNames.get(id) ?? '' });

    function detailBody(run) {
      const meta = [];
      if (run.startedAt !== null) meta.push(`Commencée à ${clockText(run.startedAt)}${run.startedBy ? ` par ${agentLabel(run.startedBy)}` : ''}`);
      if (run.finishedAt !== null) meta.push(`terminée à ${clockText(run.finishedAt)}`);
      const scans = [...run.scans].sort((a, b) => (a.phoneAt ?? a.serverAt ?? 0) - (b.phoneAt ?? b.serverAt ?? 0));
      return h(
        'div',
        { class: 'pt-detail' },
        meta.length ? h('p', { class: 'hint', text: `${cap(meta.join(', '))}.` }) : null,
        scans.length === 0
          ? h('p', { class: 'muted', text: 'Aucun passage enregistré pour cette ronde.' })
          : h(
              'ul',
              { class: 'pt-scans', 'aria-label': `Passages de la ronde ${run.routeName}` },
              ...scans.map((s) => {
                const ok = s.verdict === 'ok';
                const name = s.checkpointName || jr.cpNames.get(s.checkpointId) || (Number.isFinite(s.checkpointId) ? `Point n° ${s.checkpointId}` : 'Point inconnu');
                return h(
                  'li',
                  { class: 'pt-scan' },
                  h(
                    'div',
                    { class: 'pt-scan-head' },
                    h('strong', { class: 'pt-scan-name', text: name }),
                    h('span', { class: `tag ${ok ? 'is-ok' : 'is-warning'}` }, icon(ok ? 'check' : 'state-warning', 'icon-sm'), verdictLabel(s.verdict)),
                    s.deferred ? h('span', { class: 'tag is-dashed' }, icon('clock', 'icon-sm'), 'reçu en différé') : null,
                  ),
                  h('p', { class: 'hint pt-scan-meta', text: `${agentLabel(s.username)} · téléphone ${clockSec(s.phoneAt)} · serveur ${clockSec(s.serverAt)} · ${methodLabel(s.method)}` }),
                );
              }),
            ),
      );
    }

    function runRows(run, now) {
      const expected = expectedPoints(run, lookup());
      const prog = runProgress(run, expected);
      const open = jr.opened.has(run.id);
      const detailId = `pt-run-${run.id}`;
      const [cls, ico] = RUN_UI[run.status] ?? ['is-offline is-dashed', 'state-unknown'];
      const sr = `la ronde ${run.routeName || 'sans nom'} de ${whenText(run.dueStart, now)}`;
      const btn = h('button', { class: 'btn btn-sm', type: 'button', 'aria-expanded': String(open), 'aria-controls': detailId, dataset: { key: `detail:${run.id}` } });
      const paint = (isOpen) => btn.replaceChildren(icon(isOpen ? 'chevron-up' : 'chevron-down'), 'Détail', h('span', { class: 'sr-only', text: ` de ${sr}` }));
      paint(open);
      const late = prog.total !== null && prog.missed.length > 0 && run.dueEnd !== null && run.dueEnd < now;
      const agentsText = runAgents(run).map((u) => agentLabel(u)).join(', ');
      const row = h(
        'tr',
        { class: `pt-run${open ? ' is-open' : ''}` },
        h('td', { 'data-label': 'Prévue' }, h('span', { class: 'pt-when', text: whenText(run.dueStart, now) })),
        h('td', { 'data-label': 'Circuit' }, h('strong', { text: run.routeName || (Number.isFinite(run.routeId) ? `Circuit n° ${run.routeId}` : 'Circuit inconnu') })),
        h('td', { 'data-label': 'État' }, h('span', { class: `pill ${cls}` }, icon(ico), statusLabel(run.status))),
        h('td', { 'data-label': 'Agent', text: agentsText || '—' }),
        h(
          'td',
          { 'data-label': 'Avancement' },
          h(
            'div',
            { class: 'pt-progress' },
            h('span', { text: progressText(prog) }),
            late ? h('p', { class: 'pt-missed' }, icon('state-warning', 'icon-sm'), `Points manqués : ${prog.missed.map((p) => p.name).join(', ')}.`) : null,
          ),
        ),
        h('td', { class: 'adm-actions-cell' }, h('div', { class: 'actions' }, btn)),
      );
      const detail = h('tr', { class: 'pt-run-detail', id: detailId, hidden: !open }, h('td', { colspan: '6' }, detailBody(run)));
      btn.addEventListener('click', () => {
        const next = detail.hidden;
        detail.hidden = !next;
        row.classList.toggle('is-open', next);
        btn.setAttribute('aria-expanded', String(next));
        paint(next);
        if (next) jr.opened.add(run.id);
        else jr.opened.delete(run.id);
      });
      return [row, detail];
    }

    function renderRuns() {
      const now = Date.now();
      const runs = sortRuns(jr.runs);
      const sig = JSON.stringify([jr.ok.runs, jr.runs, Math.floor(now / 60_000), [...jr.names], [...jr.cpNames], [...jr.routeCps]]);
      f.runsCount.textContent = jr.ok.runs ? plural(runs.length, 'ronde') : '';
      if (sig === jr.sig.runs) return; // rien n'a changé : l'écran, le focus et le détail ouvert restent tels quels
      jr.sig.runs = sig;
      const key = focusKeyIn(f.runsBody);
      if (!jr.ok.runs) {
        f.runsBody.replaceChildren();
        return;
      }
      if (runs.length === 0) {
        f.runsBody.replaceChildren(
          h('div', { class: 'empty' }, icon('history'), h('strong', { text: 'Aucune ronde sur cette période' }), h('span', { text: 'Une ronde apparaît ici à l’heure prévue de son circuit, même si personne ne la fait : c’est ainsi qu’une ronde oubliée se voit. Vérifiez aussi les filtres.' })),
        );
        return;
      }
      // On ne garde « ouvert » que les détails de rondes encore affichées.
      const shown = new Set(runs.map((r) => r.id));
      for (const id of [...jr.opened]) if (!shown.has(id)) jr.opened.delete(id);
      f.runsBody.replaceChildren(
        h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            { class: 'data adm-stack pt-runs' },
            h('caption', { class: 'sr-only', text: plural(runs.length, 'ronde') }),
            h('thead', {}, h('tr', {}, th('Prévue'), th('Circuit'), th('État'), th('Agent'), th('Avancement'), h('th', { scope: 'col' }, h('span', { class: 'sr-only', text: 'Détail' })))),
            h('tbody', {}, ...runs.flatMap((r) => runRows(r, now))),
          ),
        ),
      );
      restoreFocus(f.runsBody, key, null);
    }

    // -------------------------------------------------------------- la main courante

    /** Photo agrandie dans la loupe existante : la fermeture est gérée ailleurs ; le focus revient à la miniature. */
    function openPhoto(entry, opener) {
      const box = byId('lightbox');
      const img = byId('lightbox-img');
      const cap2 = byId('lightbox-caption');
      const close = byId('lightbox-close');
      if (!box || !img || !close) return;
      const who = agentLabel(entry.username, entry.displayName);
      const caption = `Main courante, ${whenText(entry.phoneAt ?? entry.serverAt)} : ${who}`;
      img.src = `/api/patrols/logbook/${entry.id}/photo`;
      img.alt = `Photo jointe à l’entrée de ${who}`;
      if (cap2) cap2.textContent = caption;
      box.hidden = false;
      close.focus();
      const watcher = new MutationObserver(() => {
        if (!box.hidden) return;
        watcher.disconnect();
        (opener?.isConnected ? opener : f.refresh).focus();
      });
      watcher.observe(box, { attributes: true, attributeFilter: ['hidden'] });
    }

    async function makeIncident(entry, btn) {
      const who = agentLabel(entry.username, entry.displayName);
      let res = null;
      const ok = await dialogs.confirm({
        heading: 'En faire un incident',
        message: 'Le chef de poste est prévenu comme pour une alarme de niveau préalarme.',
        details: `Entrée de ${who} : ${entry.text.length > 160 ? `${entry.text.slice(0, 160)}…` : entry.text || '(sans texte)'}`,
        confirmLabel: 'Ouvrir l’incident',
        danger: false,
        onConfirm: async () => {
          res = await api(`/api/patrols/logbook/${entry.id}/incident`, { method: 'POST' });
        },
      });
      if (!ok) return;
      const id = positiveId(isObject(res) ? Number(res.incidentId ?? res.id) : Number.NaN);
      entry.incidentId = id;
      toast(id ? `Incident n° ${id} ouvert` : 'Incident ouvert', 'ok');
      jr.sig.log = '';
      renderLog();
      (f.logBody.querySelector(`[data-key="incident:${entry.id}"]`) ?? btn)?.focus?.();
    }

    function entryCard(e, now) {
      const [cls, ico] = CATEGORY_UI[e.category] ?? CATEGORY_UI.other;
      const who = agentLabel(e.username, e.displayName);
      const at = e.phoneAt ?? e.serverAt;
      const pointName2 = e.checkpointName || (e.checkpointId ? jr.cpNames.get(e.checkpointId) || `Point n° ${e.checkpointId}` : '');
      let photo = null;
      if (e.hasPhoto && Number.isFinite(e.id)) {
        const img = h('img', { class: 'pt-photo-img', src: `/api/patrols/logbook/${e.id}/photo`, alt: `Photo jointe à l’entrée de ${who}`, loading: 'lazy' });
        const open = h('button', { class: 'pt-photo', type: 'button', 'aria-label': `Agrandir la photo de l’entrée de ${who}`, dataset: { key: `photo:${e.id}` } }, img);
        open.addEventListener('click', () => openPhoto(e, open));
        img.addEventListener('error', () => open.replaceWith(h('p', { class: 'pt-photo-fail muted', text: 'Photo indisponible' })));
        photo = open;
      }
      let incident = null;
      if (e.incidentId) incident = h('a', { class: 'pt-incident-link tag is-info', href: '#/alarmes', dataset: { key: `incident:${e.id}` } }, icon('bell', 'icon-sm'), `Incident n° ${e.incidentId}`);
      else if (Number.isFinite(e.id)) {
        incident = h('button', { class: 'btn btn-sm', type: 'button', dataset: { key: `incident:${e.id}` } }, icon('megaphone'), 'En faire un incident');
        incident.addEventListener('click', () => makeIncident(e, incident));
      }
      return h(
        'li',
        { class: 'panel pt-entry' },
        h(
          'div',
          { class: 'pt-entry-head' },
          h('strong', { class: 'pt-entry-when', text: whenText(at, now) }),
          h('span', { class: 'pt-entry-who', text: who }),
          h('span', { class: `tag ${cls}` }, icon(ico, 'icon-sm'), categoryLabel(e.category)),
          pointName2 ? h('span', { class: 'tag' }, icon('pin', 'icon-sm'), pointName2) : null,
          e.deferred ? h('span', { class: 'tag is-dashed' }, icon('clock', 'icon-sm'), 'reçu en différé') : null,
        ),
        h('p', { class: 'pt-entry-text', text: e.text || '(sans texte)' }),
        e.deferred && e.serverAt !== null ? h('p', { class: 'hint', text: `Écrit à ${clockSec(e.phoneAt)} sur le téléphone, reçu à ${clockSec(e.serverAt)}.` }) : null,
        photo || incident ? h('div', { class: 'pt-entry-foot' }, photo, incident) : null,
      );
    }

    function renderLog() {
      const now = Date.now();
      const entries = sortEntries(jr.entries);
      const sig = JSON.stringify([jr.ok.log, jr.entries, Math.floor(now / 60_000), [...jr.names], [...jr.cpNames]]);
      f.logCount.textContent = jr.ok.log ? plural(entries.length, 'entrée') : '';
      if (sig === jr.sig.log) return;
      jr.sig.log = sig;
      const key = focusKeyIn(f.logBody);
      if (!jr.ok.log) {
        f.logBody.replaceChildren();
        return;
      }
      if (entries.length === 0) {
        f.logBody.replaceChildren(h('div', { class: 'empty' }, icon('doc'), h('strong', { text: 'Aucune entrée sur cette période' }), h('span', { text: 'Ce que les agents écrivent depuis leur téléphone (anomalie, dégradation, visiteur…) apparaît ici, avec sa photo s’il y en a une.' })));
        return;
      }
      f.logBody.replaceChildren(h('ul', { class: 'pt-entries', 'aria-label': 'Entrées de la main courante' }, ...entries.map((e) => entryCard(e, now))));
      restoreFocus(f.logBody, key, null);
    }

    // -------------------------------------------------------------- chargement et rafraîchissement

    function renderStatus(box, title, err) {
      box.replaceChildren(...(err ? [loadError(title, err, () => load())] : []));
    }

    async function load({ silent = false } = {}) {
      if (!built) build();
      const my = ++req;
      const range = periodRange(jr.period, Date.now());
      const common = new URLSearchParams({ from: String(range.from), to: String(range.to) });
      const runsQuery = new URLSearchParams(common);
      if (jr.routeId) runsQuery.set('routeId', jr.routeId);
      if (jr.username) runsQuery.set('username', jr.username);
      if (!jr.loaded) sh.loading();
      else if (!silent) f.updated.textContent = 'Actualisation…';
      const wantInfo = state.role === 'admin' && !jr.infoLoaded;
      const [runsR, logR, routesR, cpsR] = await Promise.allSettled([
        api(`/api/patrols/runs?${runsQuery}`),
        api(`/api/patrols/logbook?${common}`),
        wantInfo ? api('/api/patrols/routes') : Promise.resolve(null),
        wantInfo ? api('/api/patrols/checkpoints') : Promise.resolve(null),
      ]);
      if (my !== req) return; // réponse tardive d'un onglet quitté ou d'un filtre changé depuis : on ne touche à rien

      if (wantInfo && routesR.status === 'fulfilled' && cpsR.status === 'fulfilled') {
        const routes = listOf(routesR.value, 'routes').map(normRoute).filter((r) => Number.isFinite(r.id));
        jr.routeCps = new Map(routes.map((r) => [r.id, r.checkpoints]));
        jr.cpNames = new Map(listOf(cpsR.value, 'checkpoints').map(normCheckpoint).filter((c) => Number.isFinite(c.id)).map((c) => [c.id, c.name]));
        jr.infoLoaded = true;
      }
      if (runsR.status === 'fulfilled') {
        jr.runs = listOf(runsR.value, 'runs').map(normRun).filter((r) => Number.isFinite(r.id));
        jr.ok.runs = true;
        for (const r of jr.runs) {
          if (Number.isFinite(r.routeId)) jr.routeOpts.set(r.routeId, r.routeName || jr.routeOpts.get(r.routeId) || `Circuit n° ${r.routeId}`);
          for (const u of runAgents(r)) jr.agentOpts.add(u);
        }
      }
      if (logR.status === 'fulfilled') {
        jr.entries = listOf(logR.value, 'entries').map(normEntry).filter((e) => Number.isFinite(e.id));
        jr.ok.log = true;
        for (const e of jr.entries) if (e.displayName) jr.names.set(e.username, e.displayName);
      }
      if (runsR.status === 'rejected' && logR.status === 'rejected' && !jr.loaded) {
        sh.fail('Le journal n’a pas pu être lu.', runsR.reason, () => load(), false);
        return;
      }
      jr.loaded = true;
      sh.ready();
      fillSelects();
      renderStatus(f.runsStatus, 'Les rondes n’ont pas pu être lues.', runsR.status === 'rejected' ? runsR.reason : null);
      renderStatus(f.logStatus, 'La main courante n’a pas pu être lue.', logR.status === 'rejected' ? logR.reason : null);
      renderRuns();
      renderLog();
      if (runsR.status === 'fulfilled' || logR.status === 'fulfilled') f.updated.textContent = `Mis à jour à ${clockSec(Date.now())}`;
      else f.updated.textContent = 'Actualisation impossible pour le moment.';
    }

    function stop() {
      clearInterval(timer);
      timer = 0;
      document.removeEventListener('visibilitychange', onVisible);
    }

    // Retour sur la page après un long moment : on rafraîchit tout de suite plutôt que d'attendre le prochain tour.
    function onVisible() {
      if (!document.hidden && state.visible && state.tab === 'journal') load({ silent: true });
    }

    return {
      activate() {
        stop();
        load();
        timer = setInterval(() => {
          if (document.hidden || !state.visible || state.tab !== 'journal') return;
          load({ silent: true });
        }, REFRESH_MS);
        document.addEventListener('visibilitychange', onVisible);
      },
      deactivate() {
        req += 1;
        stop();
      },
      hide() {
        req += 1;
        stop();
      },
      reset() {
        req += 1;
        stop();
        Object.assign(jr, {
          period: 'today',
          routeId: '',
          username: '',
          runs: [],
          entries: [],
          ok: { runs: false, log: false },
          routeOpts: new Map(),
          agentOpts: new Set(),
          opened: new Set(),
          sig: { runs: '', log: '' },
          routeCps: new Map(),
          cpNames: new Map(),
          names: new Map(),
          infoLoaded: false,
          loaded: false,
        });
        built = false;
        Object.assign(sh, shell(rootEl));
      },
    };
  }

  // ================================================================ onglets, affichage, remise à zéro

  function buildTabs() {
    if (!els.tabs) return;
    els.tabs.replaceChildren(
      ...tabsFor(state.role).map((t) =>
        h('button', {
          type: 'button',
          role: 'tab',
          id: `pt-tab-${t.key}`,
          'aria-controls': `pt-panel-${t.key}`,
          'aria-selected': 'false',
          tabindex: '-1',
          dataset: { tab: t.key },
          text: t.label,
          onclick: () => selectTab(t.key),
        }),
      ),
    );
  }

  /** Met l'adresse à `#/rondes/<clé>` sans déclencher le routeur. */
  function writeHash(key) {
    const next = `#/rondes/${key}`;
    if (location.hash === next) return;
    try {
      history.replaceState(history.state, '', next);
    } catch {
      /* l'adresse reste telle quelle : sans conséquence */
    }
  }

  /** Affiche une rubrique. `focus` : le focus reste sur l'onglet (pattern WAI-ARIA des onglets). `force` : recharger même si c'est déjà la rubrique affichée. */
  function selectTab(key, { focus = false, force = false } = {}) {
    const known = tabsFor(state.role).map((t) => t.key);
    const next = known.includes(key) ? key : defaultTab(state.role);
    const changed = state.tab !== next;
    if (changed && state.tab) modules[state.tab]?.deactivate?.();
    state.tab = next;
    for (const t of TABS) {
      const button = els.tabs?.querySelector(`[data-tab="${t.key}"]`);
      if (button) {
        const on = t.key === next;
        button.setAttribute('aria-selected', String(on));
        button.tabIndex = on ? 0 : -1;
      }
      const panel = els.panel[t.key];
      if (panel) panel.hidden = t.key !== next;
    }
    if (focus) els.tabs?.querySelector(`[data-tab="${next}"]`)?.focus();
    if (state.visible) writeHash(next);
    if (!changed && !force) return;
    if (next === 'agents') agents?.loadAgents?.();
    else if (next === 'phones') agents?.loadPhones?.();
    else modules[next]?.activate();
  }

  els.tabs?.addEventListener('keydown', (e) => {
    const keys = tabsFor(state.role).map((t) => t.key);
    const i = keys.indexOf(state.tab);
    if (i < 0) return;
    const target = { ArrowRight: keys[(i + 1) % keys.length], ArrowLeft: keys[(i - 1 + keys.length) % keys.length], Home: keys[0], End: keys.at(-1) }[e.key];
    if (!target || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    selectTab(target, { focus: true });
  });

  function ensureModules() {
    if (modules.points) return;
    if (els.panel.points) modules.points = createPoints(els.panel.points);
    if (els.panel.routes) modules.routes = createRoutes(els.panel.routes);
    if (els.panel.journal) modules.journal = createJournal(els.panel.journal);
  }

  function reset() {
    hide();
    for (const m of Object.values(modules)) m.reset();
    els.tabs?.replaceChildren();
    for (const t of TABS) if (els.panel[t.key]) els.panel[t.key].hidden = true;
    state.role = null;
    state.tab = null;
  }

  function show() {
    ensureModules();
    const role = getMe?.()?.role === 'admin' ? 'admin' : 'operator';
    if (state.role !== role) {
      // Un autre compte (ou un autre rôle) : rien de l'ancien ne reste à l'écran.
      for (const m of Object.values(modules)) m.reset();
      state.role = role;
      state.tab = null;
      buildTabs();
    }
    state.visible = true;
    const wanted = tabFromHash(location.hash, role) ?? (state.tab && tabsFor(role).some((t) => t.key === state.tab) ? state.tab : defaultTab(role));
    selectTab(wanted, { force: true });
  }

  function hide() {
    state.visible = false;
    for (const m of Object.values(modules)) m.hide();
    agents?.hide?.();
  }

  /** Appelé à chaque état reçu du serveur : les étages arrivent parfois après l'ouverture de l'écran. */
  function refresh() {
    if (state.visible) modules.points?.refreshFloors?.();
  }

  return { show, hide, reset, refresh };
}
