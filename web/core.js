/**
 * Socle partagé de l'interface du PSIM : outils DOM, appels à l'API, état, sélecteurs, navigation et petit bus
 * d'évènements. Chaque module d'écran l'importe ; aucun ne réimplémente ces outils.
 *
 * Les modules d'écran se rafraîchissent les uns les autres par `render` (registre rempli par chacun à son chargement) :
 * le plan, le mur vidéo et l'éditeur d'équipement se citent mutuellement, le registre évite les imports croisés.
 */

// ---------------------------------------------------------------- DOM

export const $ = (id) => document.getElementById(id);
export const SVG_NS = 'http://www.w3.org/2000/svg';

/** Crée un élément DOM. Tout le texte passe par textContent : jamais d'HTML injecté. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child) el.append(child);
  return el;
}

/** Icône du sprite icons.svg. Jamais un caractère Unicode en guise d'icône : le sens est porté par le texte voisin. */
export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls ? `icon ${cls}` : 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `icons.svg#${name}`);
  svg.append(use);
  return svg;
}

export const time = (ts) => new Date(ts).toLocaleTimeString('fr-FR');
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Durée écoulée lisible d'un coup d'œil : « 02:14 », puis « 1 h 05 min ». */
export function elapsed(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)} h ${mm} min` : `${mm}:${ss}`;
}

// Champs touchés par l'utilisateur (frappe, case cochée, choix dans une liste). Un module qui reconstruit son formulaire
// après un enregistrement crée des champs neufs, donc « propres ».
const touched = new WeakSet();
for (const type of ['input', 'change']) document.addEventListener(type, (e) => touched.add(e.target), true);

/**
 * Vrai si un champ du conteneur a été modifié par l'utilisateur et pas encore enregistré. Sert à ne pas reconstruire un
 * formulaire commencé quand on revient sur un écran. Seuls les champs touchés comptent (une case cochée par le code n'est
 * pas une saisie) ; une case ou une liste touchée compte toujours : mieux vaut une liste un peu ancienne qu'un choix effacé.
 */
export function hasUnsavedInput(container) {
  for (const el of container.querySelectorAll('input, textarea, select')) {
    if (!touched.has(el)) continue;
    if (el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT' || el.value !== el.defaultValue) return true;
  }
  return false;
}

/** Texte d'un compteur de la barre du haut : complet, et court sur téléphone. Le nom lu reste toujours le texte complet. */
export function setCounterText(el, long, short = long) {
  el.querySelector('.counter-long').textContent = long;
  el.querySelector('.counter-short').textContent = short;
  el.setAttribute('aria-label', long);
}

/**
 * Message éphémère. `kind` : 'error' (défaut) ou 'ok'. Un succès est annoncé poliment (role=status) et part après 5 s.
 * Une erreur est annoncée tout de suite (role=alert), reste 12 s, s'arrête au survol et au focus, et se ferme à la main :
 * un échec d'acquittement ou d'envoi ne doit pas passer inaperçu.
 */
export function toast(message, kind = 'error') {
  const isError = kind !== 'ok';
  const el = h('div', { class: `toast ${kind}`, role: isError ? 'alert' : 'status' }, icon(isError ? 'state-alarm' : 'state-ok'), h('span', { text: message }));
  const remaining = { ms: isError ? 12000 : 5000 };
  let timer = null;
  let started = 0;
  const start = () => {
    started = Date.now();
    clearTimeout(timer);
    timer = setTimeout(() => el.remove(), remaining.ms);
  };
  const pause = () => {
    clearTimeout(timer);
    remaining.ms = Math.max(2000, remaining.ms - (Date.now() - started));
  };
  if (isError) {
    const close = h('button', { class: 'btn btn-ghost btn-icon btn-sm toast-close', type: 'button', 'aria-label': 'Fermer le message', onclick: () => el.remove() }, icon('close'));
    el.append(close);
    el.addEventListener('mouseenter', pause);
    el.addEventListener('mouseleave', start);
    el.addEventListener('focusin', pause);
    el.addEventListener('focusout', start);
  }
  $('toasts').append(el);
  start();
}

// ---------------------------------------------------------------- libellés

export const STATUS_LABEL = { normal: 'Normal', prealarm: 'Préalarme', alarm: 'ALARME', fault: 'Défaut', offline: 'Hors ligne' };

export const ACTION_LABEL = {
  device_state: "Changement d'état",
  incident_opened: 'Incident ouvert',
  incident_escalated: 'Incident aggravé',
  incident_confirmed: 'Incident confirmé',
  incident_hint: 'Indice : fausse alarme probable',
  incident_acked: 'Incident acquitté',
  incident_closed: 'Incident clôturé',
  login: 'Connexion',
  plan_updated: 'Plan remplacé',
  floor_created: 'Étage ajouté',
  floor_updated: 'Étage modifié',
  floor_deleted: 'Étage supprimé',
  device_created: 'Équipement ajouté',
  device_updated: 'Équipement modifié',
  device_deleted: 'Équipement supprimé',
  links_updated: 'Caméras associées modifiées',
  sim_trigger: 'Simulation',
  detector_silent: 'Détecteur muet',
  camera_offline: 'Caméra injoignable',
  camera_online: 'Caméra de nouveau joignable',
  supervision_gap: 'Période sans surveillance',
  journal_integrity_failed: 'JOURNAL ALTÉRÉ',
  journal_integrity_recovered: 'Journal de nouveau cohérent',
  journal_verified: 'Journal vérifié',
  heartbeat_failing: 'Supervision externe en échec',
  heartbeat_recovered: 'Supervision externe rétablie',
  zone_armed: 'Zone armée',
  report_exported: 'Export / rapport',
  report_schedule_updated: 'Rapport automatique réglé',
  report_email_sent: 'Rapport envoyé par e-mail',
  report_email_failed: "Échec d'envoi du rapport",
  zone_disarmed: 'Zone désarmée',
  arming_schedule: "Planning d'armement",
  intrusion_ignored: 'Intrusion ignorée (zone désarmée)',
  risk_assessed: 'Risque évalué',
  snapshot_failed: 'Image non prise',
  notification_failed: 'Notification en échec',
  notification_escalated: 'Escalade (niveau 2 prévenu)',
  notification_reminder: 'Rappel envoyé',
  notification_test: 'Test de notification',
  login_failed: 'Connexion refusée',
  user_created: 'Compte créé',
  user_updated: 'Compte modifié',
  user_deleted: 'Compte supprimé',
  password_changed: 'Mot de passe changé',
  password_reset: 'Mot de passe réinitialisé',
  totp_enabled: 'Double authentification activée',
  totp_disabled: 'Double authentification désactivée',
  totp_reset: 'Double authentification réinitialisée',
  recovery_regenerated: 'Codes de secours régénérés',
  recovery_code_used: 'Code de secours utilisé',
  recipient_added: 'Destinataire ajouté',
  recipient_updated: 'Destinataire modifié',
  recipient_removed: 'Destinataire retiré',
  backup_failed: 'Sauvegarde en échec',
  backup_manual: 'Sauvegarde manuelle',
  camera_source_updated: 'Source vidéo modifiée',
  detector_source_updated: 'Source du détecteur modifiée',
  detector_source_removed: 'Source du détecteur retirée',
};

// ---------------------------------------------------------------- bus d'évènements

const listeners = new Map();

/** Abonnement à un évènement de l'application ('unauthorized', 'restricted', 'incident', 'snapshot', 'view'). */
export function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, []);
  listeners.get(name).push(fn);
}

export function emit(name, ...args) {
  for (const fn of listeners.get(name) ?? []) fn(...args);
}

// ---------------------------------------------------------------- API

export async function api(path, { method = 'GET', body } = {}) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 401 && path !== '/api/login' && path !== '/api/login/2fa') {
    emit('unauthorized'); // app.js affiche l'écran de connexion
    throw new Error('Session expirée, reconnectez-vous');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 403 && data?.restricted && S.me && !S.me.restricted) {
    S.me.restricted = data.restricted;
    emit('restricted'); // une étape est requise sur le compte (mot de passe, double authentification)
  }
  if (!res.ok) {
    const error = new Error(data?.error ?? `Erreur ${res.status}`);
    error.data = data; // le détail (ex. défi expiré) reste disponible pour l'appelant
    throw error;
  }
  return data;
}

// ---------------------------------------------------------------- état

export const S = {
  arming: {},
  armingZones: 0, // nombre de zones d'intrusion (l'entrée Armement du menu n'existe que s'il y en a)
  me: null,
  view: null, // écran affiché (route sans « #/ »)
  site: { name: '', hasPlan: false, planVersion: 0 },
  floors: [],
  floorId: null, // étage affiché à plat
  planMode: 'floor', // 'floor' (un étage à plat) ou 'stack' (vue éclatée)
  devices: new Map(),
  links: {},
  incidents: new Map(),
  audit: [],
  loaded: false,
  selectedId: null, // équipement choisi sur Surveillance (traits vers ses caméras)
  editId: null, // équipement ouvert dans l'éditeur (Équipements et plan) : rien d'autre ne le change
  focusIncidentId: null,
  manualCams: [],
  editMode: false, // vrai sur l'écran Équipements et plan : les pastilles se glissent
  dragging: false,
  muted: false,
  ws: null,
  wsDelay: 1000,
  wallKey: null,
  wallPage: 0,
  wallPages: 1,
  sourceMsg: {},
};

/**
 * Rendus des modules, branchés par chacun à son chargement. Un module qui doit rafraîchir un autre écran passe par
 * ici (ex. le clic sur une pastille rafraîchit le mur et l'éditeur).
 */
export const render = {
  plan() {},
  wall() {},
  incidents() {},
  journal() {},
  admin() {},
  alarmState() {},
};

// ---------------------------------------------------------------- sélecteurs

export const devicesOf = (kind) => [...S.devices.values()].filter((d) => d.kind === kind);
export const isActive = (i) => i.status !== 'closed';
export const isFiring = (d) => d && (d.status === 'alarm' || d.status === 'prealarm');

/** Incidents ouverts ou acquittés, du plus grave au plus récent. */
export function activeIncidents() {
  return [...S.incidents.values()]
    .filter(isActive)
    .sort(
      (a, b) =>
        (b.severity === 'critical') - (a.severity === 'critical') ||
        (b.confirmedAt !== null) - (a.confirmedAt !== null) ||
        b.openedAt - a.openedAt,
    );
}

/** Incident suivi : celui choisi par l'opérateur s'il est encore actif, sinon le plus urgent. */
export function focusedIncident() {
  const chosen = S.incidents.get(S.focusIncidentId);
  return chosen && isActive(chosen) ? chosen : (activeIncidents()[0] ?? null);
}

export const floorOf = (deviceId) => S.devices.get(deviceId)?.floorId ?? null;
export const floorName = (floorId) => S.floors.find((f) => f.id === floorId)?.name ?? '';

export function currentFloor() {
  return S.floors.find((f) => f.id === S.floorId) ?? S.floors[0] ?? null;
}

// Étage et vue choisis : simple confort par poste (le navigateur peut refuser le stockage : on s'en passe).
function loadPlanPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem('psim.plan') ?? 'null');
    if (saved && typeof saved === 'object') {
      if (Number.isInteger(saved.floorId)) S.floorId = saved.floorId;
      if (saved.mode === 'stack' || saved.mode === 'floor') S.planMode = saved.mode;
    }
  } catch {
    // stockage indisponible
  }
}

export function savePlanPrefs() {
  try {
    localStorage.setItem('psim.plan', JSON.stringify({ floorId: S.floorId, mode: S.planMode }));
  } catch {
    // stockage indisponible
  }
}
loadPlanPrefs();

/** Bascule vers l'étage d'une alarme (ouverture, aggravation, reconnexion), annoncée aux lecteurs d'écran. */
export function followAlarm(incident) {
  const floorId = floorOf(incident.detectorId);
  if (floorId === null) return;
  const moved = floorId !== S.floorId || S.planMode !== 'floor';
  S.floorId = floorId;
  S.planMode = 'floor';
  if (moved) savePlanPrefs();
  if (moved && S.floors.length > 1) $('floor-announce').textContent = `Plan affiché : ${floorName(floorId)}, alarme ${incident.detectorName}.`;
}

// ---------------------------------------------------------------- navigation

let router = () => {};

/** Branché par app.js : affiche un écran (garde d'accès comprise). */
export function setRouter(fn) {
  router = fn;
}

/**
 * Ouvre un écran (`#/<vue>`). Synchrone : une alarme ramène sur Surveillance tout de suite, pas au prochain tour de la
 * boucle d'évènements. pushState ne déclenche pas « hashchange » : le routeur n'est pas appelé deux fois.
 */
export function go(view) {
  if (location.hash !== `#/${view}`) history.pushState(null, '', `#/${view}`);
  router(view);
}
