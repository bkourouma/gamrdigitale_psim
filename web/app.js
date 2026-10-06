/**
 * Démarrage du PSIM : connexion (deux étapes), temps réel (WebSocket), routeur des écrans, état du cadre (calme,
 * préalarme, alarme), alerte sonore, compteurs, thème, tiroir du menu et jauge du rail.
 *
 * Règles de sécurité tenues ici : une nouvelle alarme (ou une aggravation) ramène sur Surveillance et sur l'étage
 * concerné ; le son continue tant qu'un incident n'est pas acquitté ; les écrans ne sont jamais détruits, seulement
 * masqués (un formulaire commencé est retrouvé intact) ; un compte restreint ne voit que « Mon compte ».
 */
import { createAccountUi, createDialogs } from './account.js';
import { createArmingView } from './arming.js';
import { createThermometer, levelOf } from './gauge.js';
import { createReportsView } from './reports.js';
import { createRiskView } from './risk.js';
import { createUsersAdmin } from './users.js';
import { $, h, icon, api, toast, S, on, go, setRouter, render, activeIncidents, devicesOf, followAlarm, floorName, hasUnsavedInput, setCounterText, STATUS_LABEL } from './core.js';
import { renderPlan } from './plan.js';
import { renderWall, stopTiles } from './wall.js';
import { renderIncidents, tickIncidents, ariaTable } from './incidents.js';
import { renderJournal } from './journal.js';
import { loadSystem } from './system.js';
import { initNotifications, loadNotifStatus } from './notifications.js';
import { renderAdmin } from './equipment.js';

// ---------------------------------------------------------------- thème (Jour, Nuit, Automatique)

const THEMES = {
  auto: { label: 'Automatique', icon: 'contrast', next: 'day' },
  day: { label: 'Jour', icon: 'sun', next: 'night' },
  night: { label: 'Nuit', icon: 'moon', next: 'auto' },
};

function readTheme() {
  try {
    const saved = localStorage.getItem('psim.theme');
    return saved === 'day' || saved === 'night' ? saved : 'auto';
  } catch {
    return 'auto'; // stockage indisponible : on suit le système
  }
}

function applyTheme(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const t = THEMES[theme];
  $('theme').replaceChildren(icon(t.icon), h('span', { class: 'sr-only', text: 'Thème : ' }), h('span', { text: t.label }));
  $('theme').title = `Thème : ${t.label}. Changer pour « ${THEMES[t.next].label} »`;
}

let theme = readTheme();
applyTheme(theme);
$('theme').addEventListener('click', () => {
  theme = THEMES[theme].next;
  try {
    if (theme === 'auto') localStorage.removeItem('psim.theme');
    else localStorage.setItem('psim.theme', theme);
  } catch {
    // stockage indisponible : le choix vaut pour cette page seulement
  }
  applyTheme(theme);
});

// ---------------------------------------------------------------- modules d'écran

const dialogs = createDialogs({ h });
const logout = async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  if ($('login').hidden) showLogin(); // une session déjà perdue a affiché la connexion (401) : on ne la réinitialise pas deux fois
};
const refreshMe = async () => {
  S.me = await api('/api/me');
};
const reportsView = createReportsView({ h, getMe: () => S.me, api, toast });
const armingView = createArmingView({ api, h, toast, getMe: () => S.me, onZones: showArmingEntry });
const account = createAccountUi({ api, h, toast, dialogs, getMe: () => S.me, refreshMe, logout });
const usersAdmin = createUsersAdmin({
  api,
  h,
  toast,
  dialogs,
  getMe: () => S.me,
  onRecipientsChanged: () => loadNotifStatus({ recipients: true }), // après un ajout, une modification : la liste est rechargée
  getZones: () => [...new Set([...S.devices.values()].filter((d) => d.kind === 'detector' && d.zone).map((d) => d.zone))],
});
initNotifications({ loadRecipients: () => usersAdmin.loadRecipients() });
const riskView = createRiskView({ api, h, toast, getMe: () => S.me, dialogs });

// Session perdue : l'écran de connexion. S'il est déjà affiché, un minuteur oublié ne doit pas l'effacer (mot de passe
// tapé, étape du code de double authentification en cours).
on('unauthorized', () => $('login').hidden && showLogin());
on('restricted', () => account.openAccount());
on('incident', (incident) => onIncident(incident));
on('snapshot', (snap) => applySnapshot(snap));

$('whoami').addEventListener('click', () => account.openAccount());
$('logout').addEventListener('click', logout);

/** Armement : l'entrée du menu n'existe que s'il y a des zones d'intrusion. */
function showArmingEntry(count) {
  S.armingZones = count;
  $('nav-armement').hidden = count === 0;
  $('arming-empty').hidden = count > 0;
}

// ---------------------------------------------------------------- routeur

const ROUTES = {
  surveillance: { title: 'Surveillance', sub: 'Plan du site, alarmes en cours et caméras' },
  alarmes: { title: 'Alarmes', sub: 'Alarmes en cours et clôturées récemment' },
  cameras: { title: 'Caméras', sub: 'Choisissez les caméras à afficher sur le mur' },
  armement: { title: 'Armement', sub: "Zones d'intrusion : armement, désarmement et planning" },
  risques: { title: 'Risques', sub: "Indice de sécurité GAMR par zone et priorités d'action" },
  rapports: { title: 'Rapports', sub: 'Rapports imprimables, exports et envoi automatique' },
  journal: { title: 'Journal', sub: 'Toutes les actions, des personnes et du système' },
  equipements: { title: 'Équipements et plan', sub: 'Placer, régler et ajouter les détecteurs et les caméras', admin: true },
  notifications: { title: 'Personnes prévenues', sub: "Qui reçoit les alarmes hors de l'écran, et par quel canal", admin: true },
  utilisateurs: { title: 'Utilisateurs', sub: 'Comptes, rôles et accès', admin: true },
  systeme: { title: 'Système', sub: 'Santé du PSIM, sauvegardes et intégrité du journal', admin: true },
  simulateur: { title: 'Simulateur', sub: 'Essais : chaque bouton agit comme un vrai détecteur', admin: true, sim: true },
};

const planPanel = document.querySelector('.c-plan');
const videoPanel = document.querySelector('.c-video');

function viewFromHash() {
  const m = /^#\/([a-z]+)/.exec(location.hash);
  return m && ROUTES[m[1]] ? m[1] : 'surveillance';
}

/** Garde d'accès : écran d'administration pour un opérateur, Simulateur sans simulateur -> Surveillance. */
function allowed(name) {
  const r = ROUTES[name];
  if (!r) return false;
  if (r.admin && S.me?.role !== 'admin') return false;
  if (r.sim && !S.me?.simEnabled) return false;
  return true;
}

/** Sortie d'un écran : le plan et le mur reprennent leur place dans Surveillance. L'éditeur d'équipement n'est pas
 *  vidé : une saisie interrompue (par une alarme, par exemple) est retrouvée au retour. */
function leave(view) {
  if (view === 'equipements') {
    S.editMode = false;
    // Une pastille en cours de glissement est abandonnée (rien n'est enregistré) : déplacer le panneau libère la capture
    // du pointeur, son relâchement ne serait jamais reçu et le plan resterait figé (ni étage de l'alarme, ni pastilles).
    S.dragging = false;
    $('plan-home').append(planPanel);
    renderPlan();
    renderAdmin();
  } else if (view === 'cameras') {
    $('video-home').append(videoPanel);
  } else if (view === 'risques') {
    riskView.hide();
    loadRailGauge(); // une évaluation vient peut-être de changer l'indice
  }
}

/** Entrée dans un écran. Armement n'est pas rechargé ici : la liste reconstruite effacerait un planning modifié et pas
 *  encore enregistré ; son état est relu à chaque changement publié par le serveur (applySnapshot). */
function enter(view) {
  if (view === 'equipements') {
    S.editMode = true;
    $('equip-plan-slot').append(planPanel);
    renderPlan();
    renderAdmin();
  } else if (view === 'cameras') {
    $('cameras-video-slot').append(videoPanel);
    renderWall();
  } else if (view === 'risques') {
    // show() attend le serveur avant de lancer son rafraîchissement périodique : si l'écran a été quitté entre-temps
    // (alarme, autre onglet touché), on l'arrête aussitôt.
    riskView.show().then(() => S.view !== 'risques' && riskView.hide());
    loadRailGauge();
  } else if (view === 'utilisateurs') {
    usersAdmin.loadUsers();
  } else if (view === 'notifications') {
    // L'état des canaux est relu à chaque entrée ; la liste des destinataires seulement si aucun formulaire n'y est
    // commencé (elle est de toute façon rechargée après chaque ajout ou modification).
    loadNotifStatus({ recipients: !hasUnsavedInput($('recipients-box')) });
  } else if (view === 'systeme') {
    loadSystem();
  } else if (view === 'simulateur') {
    renderAdmin();
  } else if (view === 'alarmes') {
    renderIncidents();
  } else if (view === 'journal') {
    renderJournal();
  }
}

function route(requested) {
  if (!S.me || S.me.restricted) return;
  let name = requested;
  if (!allowed(name)) {
    name = 'surveillance';
    history.replaceState(null, '', '#/surveillance');
  }
  closeDrawer(false);
  const previous = S.view;
  if (previous === name) return;
  S.view = name;
  if (previous) leave(previous);
  $('lightbox').hidden = true; // l'image agrandie appartient à l'écran quitté (une alarme ne reste pas cachée dessous)
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${name}`;
  for (const link of document.querySelectorAll('[data-view]')) {
    if (link.dataset.view === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  $('view-title').textContent = ROUTES[name].title;
  $('view-sub').textContent = ROUTES[name].sub;
  enter(name);
  updateAlarmState(); // titre du document
  $('workspace').scrollTop = 0;
  // Le focus ne reste pas dans un écran masqué : il revient au titre (annoncé par les lecteurs d'écran). Sauf si une
  // fenêtre est ouverte (Mon compte, mot de passe demandé) : le focus y reste, la fenêtre est toujours là.
  if (previous && $('dialog').hidden) $('view-title').focus({ preventScroll: true });
}

setRouter(route);
// Seules les adresses « #/écran » sont des routes (le lien d'évitement « #main » n'en est pas une).
window.addEventListener('hashchange', () => (location.hash === '' || location.hash.startsWith('#/')) && route(viewFromHash()));
document.querySelector('.skip').addEventListener('click', (e) => {
  e.preventDefault();
  $('main').focus();
});

/** Remet les écrans à zéro (déconnexion) : le plan et le mur reprennent leur place. */
function resetViews() {
  if (S.view) leave(S.view);
  S.view = null;
}

// ---------------------------------------------------------------- tiroir du menu (tablette, téléphone)

const narrow = matchMedia('(max-width: 1023px)');
const drawerOpen = () => $('app').classList.contains('drawer-open');
let drawerOpener = null; // bouton qui a ouvert le tiroir (en haut, ou l'onglet Menu) : il retrouve le focus à la fermeture

const modalOpen = () => !$('dialog').hidden || !$('lightbox').hidden;

/**
 * Le tiroir et les fenêtres (dialogue, image agrandie) sont modaux : derrière eux, le menu, la feuille et les onglets
 * sortent de l'ordre de tabulation et de l'arbre d'accessibilité (inert), pas seulement du regard.
 */
function syncInert() {
  const drawer = drawerOpen();
  const modal = modalOpen();
  $('workspace').inert = drawer || modal;
  document.querySelector('.tabbar').inert = drawer || modal;
  $('rail').inert = modal;
}

// La fenêtre rend le focus à sa commande d'origine pendant sa fermeture, alors que cette commande est encore inerte :
// le focus serait perdu. On le rend ici, une fois l'inertie levée.
let lastOutside = null;
document.addEventListener('focusin', (e) => {
  if (!e.target.closest?.('#dialog, #lightbox')) lastOutside = e.target;
});
const modalObserver = new MutationObserver(() => {
  syncInert();
  if (!modalOpen() && (!document.activeElement || document.activeElement === document.body) && lastOutside?.isConnected && !$('app').hidden) {
    lastOutside.focus({ preventScroll: true });
  }
});
for (const id of ['dialog', 'lightbox']) modalObserver.observe($(id), { attributes: true, attributeFilter: ['hidden'] });

function setDrawer(open) {
  $('app').classList.toggle('drawer-open', open);
  $('scrim').hidden = !open;
  syncInert();
  for (const id of ['menu-btn', 'tab-menu']) $(id).setAttribute('aria-expanded', String(open));
}

function openDrawer(e) {
  drawerOpener = e?.currentTarget ?? $('menu-btn');
  setDrawer(true);
  ($('rail').querySelector('[aria-current="page"]') ?? $('rail').querySelector('.nav-item'))?.focus();
}

function closeDrawer(restoreFocus = true) {
  if (!drawerOpen()) return;
  setDrawer(false);
  if (restoreFocus) (drawerOpener ?? $('menu-btn')).focus();
  drawerOpener = null;
}

$('menu-btn').addEventListener('click', openDrawer);
$('tab-menu').addEventListener('click', openDrawer);
$('drawer-close').addEventListener('click', () => closeDrawer());
$('scrim').addEventListener('click', () => closeDrawer());
// Choisir un écran ferme le tiroir, même l'écran déjà affiché : dans ce cas (aucun changement d'adresse, pas de
// routeur), le focus va au titre plutôt que de rester sur un lien du tiroir refermé.
for (const link of document.querySelectorAll('#rail a')) {
  link.addEventListener('click', () => {
    const same = drawerOpen() && link.getAttribute('href') === `#/${S.view}`;
    closeDrawer(false);
    if (same) $('view-title').focus({ preventScroll: true });
  });
}
narrow.addEventListener('change', () => closeDrawer(false));
// Échap ferme le tiroir, sauf si une fenêtre ou l'image agrandie est par-dessus : c'est elle qui se ferme. Écouté en
// phase de capture, avant le gestionnaire de la fenêtre, pour lire son état AVANT qu'elle ne se referme.
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && drawerOpen() && $('dialog').hidden && $('lightbox').hidden) closeDrawer();
  },
  true,
);

// ---------------------------------------------------------------- temps réel

/**
 * Ramène la feuille en haut : si l'opérateur est déjà sur Surveillance, le routeur ne fait rien (même écran) et la fiche
 * de l'alarme, ou son bouton Acquitter, resterait hors de l'écran, plus bas ou plus haut dans la feuille défilée.
 */
function showAlarmSheet() {
  $('workspace').scrollTop = 0;
}
$('alarm-counter').addEventListener('click', showAlarmSheet);

function applySnapshot(snap) {
  const before = S.incidents;
  S.site = snap.site;
  S.floors = snap.floors ?? [];
  if (!S.floors.some((f) => f.id === S.floorId)) S.floorId = S.floors[0]?.id ?? null;
  // Plans de tous les étages chargés d'avance : la bascule vers l'étage d'une alarme est immédiate.
  for (const f of S.floors) if (f.hasPlan) new Image().src = `/api/floors/${f.id}/plan?v=${f.planVersion}`;
  S.devices = new Map(snap.devices.map((d) => [d.id, d]));
  S.links = snap.links;
  S.arming = snap.arming ?? {};
  armingView.load(); // état détaillé des zones d'intrusion (planning, dérogations)
  S.incidents = new Map(snap.incidents.map((i) => [i.id, i]));
  S.audit = snap.audit;
  // Premier état reçu (connexion) : une alarme non acquittée impose son étage, quel que soit le dernier choisi.
  // Reconnexion après une coupure : une alarme ouverte (ou aggravée) pendant la coupure fait de même.
  const pending = activeIncidents().filter((i) => i.status === 'open');
  const fresh = S.loaded ? pending.filter((i) => !before.has(i.id) || before.get(i.id).status !== 'open' || before.get(i.id).severity !== i.severity) : pending;
  if (fresh.length) {
    if (S.loaded) {
      S.focusIncidentId = fresh[0].id;
      S.manualCams = [];
    }
    // Surveillance d'abord : l'annonce de l'étage (followAlarm) part quand l'écran est déjà affiché. Jamais une alarme à
    // acquitter cachée derrière un autre écran, même au rechargement.
    go('surveillance');
    followAlarm(fresh[0]);
    showAlarmSheet();
  }
  S.loaded = true;
  if (S.selectedId && !S.devices.has(S.selectedId)) S.selectedId = null;
  if (S.editId && !S.devices.has(S.editId)) S.editId = null;
  S.manualCams = S.manualCams.filter((id) => S.devices.has(id));
  renderAll(true);
}

function onIncident(incident) {
  const previous = S.incidents.get(incident.id);
  S.incidents.set(incident.id, incident);
  // Nouvelle alarme (ou aggravation) : l'opérateur voit tout de suite les caméras concernées, l'étage concerné à plat,
  // et revient sur Surveillance depuis n'importe quel écran (une alarme n'est jamais cachée derrière une autre vue).
  if (incident.status === 'open' && (!previous || previous.status !== 'open' || previous.severity !== incident.severity)) {
    S.focusIncidentId = incident.id;
    S.manualCams = [];
    go('surveillance'); // d'abord l'écran, puis l'étage : l'annonce aux lecteurs d'écran part d'une page affichée
    followAlarm(incident);
    showAlarmSheet();
  }
  renderPlan();
  renderWall();
  renderIncidents();
  renderAdmin(); // les libellés d'édition (« Remplacer le plan de ... ») suivent l'étage affiché
  updateAlarmState();
}

function onMessage(msg) {
  switch (msg.type) {
    case 'snapshot':
      applySnapshot(msg);
      break;
    case 'config':
      api('/api/state').then(applySnapshot).catch((e) => toast(e.message));
      break;
    case 'device':
      S.devices.set(msg.device.id, msg.device);
      renderPlan();
      renderWall();
      renderIncidents();
      renderAdmin();
      updateAlarmState();
      break;
    case 'incident':
      onIncident(msg.incident);
      break;
    case 'audit':
      S.audit.unshift(msg.entry);
      S.audit.length = Math.min(S.audit.length, 100);
      renderJournal();
      break;
  }
}

function connect() {
  clearTimeout(connect.timer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => {
    S.wsDelay = 1000;
    setConn(true);
  };
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data));
    } catch (err) {
      console.error(err);
    }
  };
  ws.onclose = async () => {
    setConn(false);
    if (!S.me) return;
    try {
      await api('/api/me');
    } catch {
      // Session perdue (401) : l'écran de connexion est déjà affiché, on s'arrête. Toute autre erreur (réseau coupé,
      // serveur qui redémarre, 5xx) n'est pas une raison de renoncer : l'alarme doit pouvoir revenir sans recharger.
    }
    if (!S.me) return;
    connect.timer = setTimeout(connect, S.wsDelay);
    S.wsDelay = Math.min(S.wsDelay * 2, 10000);
  };
}

function setConn(online) {
  const el = $('conn');
  el.className = `conn ${online ? 'is-online' : 'is-offline'}`;
  el.querySelector('span').textContent = online ? 'Temps réel' : 'Hors ligne';
  el.title = online ? 'Les alarmes arrivent en temps réel.' : "Le PSIM ne répond plus : nouvelle tentative en cours. Les alarmes n'arrivent plus sur cet écran.";
}

// ---------------------------------------------------------------- connexion utilisateur (deux étapes)

async function loadDemoAccounts() {
  try {
    const res = await fetch('/api/demo-accounts', { credentials: 'same-origin' });
    if (!res.ok) return; // mode démo désactivé : la page reste inchangée
    const accounts = await res.json();
    $('demo-buttons').replaceChildren(
      ...accounts.map((a) =>
        h(
          'button',
          {
            class: 'btn btn-sm',
            type: 'button',
            onclick: () => {
              $('login-user').value = a.username;
              $('login-pass').value = a.password;
              $('login-error').textContent = '';
              $('login-submit').focus();
            },
          },
          icon('user'),
          `${a.label} (${a.username})`,
        ),
      ),
    );
    $('demo-accounts').hidden = accounts.length === 0;
  } catch {
    // indisponible : on ignore
  }
}

function showLogin() {
  S.me = null;
  S.loaded = false;
  S.incidents = new Map();
  clearTimeout(connect.timer); // une reconnexion déjà planifiée n'ouvrirait qu'un canal inutile derrière l'écran de connexion
  S.ws?.close();
  stopTiles();
  dialogs.close();
  closeDrawer(false);
  resetViews();
  clearAccountTraces();
  $('app').hidden = true;
  document.querySelector('.skip').hidden = true; // « Aller au contenu » viserait la page masquée
  $('login').hidden = false;
  $('login-pass').value = '';
  resetLoginStep();
  loadDemoAccounts();
}

/**
 * Rien du compte précédent ne reste dans la page pour le suivant : compteur Système et contenu des écrans
 * d'administration (masqués et gardés par le routeur, mais encore dans le document). Vider l'éditeur d'équipement
 * arrête aussi le suivi de la source d'un détecteur (une requête toutes les 10 s tant que l'éditeur est dans la page).
 */
function clearAccountTraces() {
  $('system-counter').hidden = true;
  $('nav-count-systeme').hidden = true;
  for (const id of ['users-list', 'notif-status', 'sys-status']) $(id).replaceChildren(h('p', { class: 'muted', text: 'Chargement…' }));
  for (const id of ['recipients-box', 'notif-results', 'sys-warnings']) $(id).replaceChildren();
  const editor = $('device-editor');
  editor.replaceChildren();
  delete editor.dataset.for;
  S.selectedId = null;
  S.editId = null;
  S.focusIncidentId = null;
  S.manualCams = [];
}

let challenge = null;

function resetLoginStep() {
  challenge = null;
  $('login-2fa').hidden = true;
  $('login-back').hidden = true;
  $('login-code').value = '';
  for (const id of ['login-user', 'login-pass']) $(id).closest('label').hidden = false;
  $('login-submit').textContent = 'Se connecter';
  $('demo-accounts').classList.remove('is-off');
}

function showCodeStep(token) {
  challenge = token;
  for (const id of ['login-user', 'login-pass']) $(id).closest('label').hidden = true;
  $('demo-accounts').classList.add('is-off');
  $('login-2fa').hidden = false;
  $('login-back').hidden = false;
  $('login-submit').textContent = 'Valider le code';
  $('login-code').focus();
}

$('login-back').addEventListener('click', () => {
  resetLoginStep();
  $('login-error').textContent = '';
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  ensureAudio();
  try {
    const reply = challenge
      ? await api('/api/login/2fa', { method: 'POST', body: { challenge, code: $('login-code').value } })
      : await api('/api/login', { method: 'POST', body: { username: $('login-user').value, password: $('login-pass').value } });
    if (reply.twoFactor) return showCodeStep(reply.challenge); // mot de passe correct : il faut encore le code
    resetLoginStep();
    S.me = await api('/api/me');
    showApp();
  } catch (err) {
    $('login-error').textContent = err.message;
    if (challenge && err.data?.expired) resetLoginStep(); // défi expiré ou épuisé : repartir du mot de passe ; sinon on peut réessayer
    else if (challenge) $('login-code').select();
  }
});

function showApp() {
  $('login').hidden = true;
  document.querySelector('.skip').hidden = Boolean(S.me.restricted); // compte restreint : seule la fenêtre Mon compte
  if (S.me.restricted) {
    // Une étape est requise (mot de passe à changer, double authentification à activer) : rien d'autre n'est accessible avant.
    $('app').hidden = true;
    account.openAccount();
    return;
  }
  $('app').hidden = false;
  const admin = S.me.role === 'admin';
  $('nav-admin').hidden = !admin;
  $('nav-simulateur').hidden = !S.me.simEnabled;
  $('who-name').textContent = S.me.displayName || S.me.username;
  $('who-role').textContent = admin ? 'Administrateur' : 'Opérateur';
  loadSystem(false);
  reportsView.draw();
  loadRailGauge();
  route(viewFromHash());
  connect();
}

// ---------------------------------------------------------------- état du cadre, compteurs, alerte sonore

const downDetectors = () => devicesOf('detector').filter((d) => d.status === 'offline' || d.status === 'fault');

function updateAlarmState() {
  const active = activeIncidents();
  const unacked = active.filter((i) => i.status === 'open');
  // Cadre : rouge tant qu'une alarme est ouverte (pulsation tant qu'elle n'est pas acquittée), ambre-brun pour une
  // préalarme, marine au calme. La couleur n'est jamais seule : le compteur et les fiches disent la même chose en mots.
  const app = $('app');
  app.dataset.frame = active.some((i) => i.severity === 'critical') ? 'alarm' : active.length ? 'warning' : 'calm';
  app.toggleAttribute('data-pending', unacked.length > 0);

  const counter = $('alarm-counter');
  counter.classList.toggle('is-calm', unacked.length === 0); // à 0 : neutre, et visible seulement sur téléphone
  counter.classList.toggle('is-solid-alarm', unacked.length > 0);
  counter.classList.toggle('is-ok', unacked.length === 0);
  setCounterText(counter, `${unacked.length} à acquitter`);
  for (const id of ['nav-count-alarmes', 'tab-count-alarmes']) {
    $(id).hidden = unacked.length === 0;
    $(id).textContent = String(unacked.length);
  }
  document.title = unacked.length ? `(${unacked.length}) ALARME - PSIM` : `${S.view ? `${ROUTES[S.view].title} - ` : ''}GAMR-DIGITALE PSIM`;

  // Détecteurs hors service (muets, hors ligne ou en défaut) : jamais silencieux pour l'opérateur,
  // un détecteur qui ne surveille plus laisse sa zone sans protection.
  // Le compteur ouvre la liste en clair (touché au doigt ou au clavier : une infobulle ne s'y lit pas).
  const down = downDetectors();
  const badge = $('offline-counter');
  badge.hidden = down.length === 0;
  setCounterText(badge, `${down.length} détecteur${down.length > 1 ? 's' : ''} hors service`, `${down.length} hors service`);
  badge.title = `${down.map((d) => `${d.id} ${d.name} : ${STATUS_LABEL[d.status]}`).join('\n')}\nTouchez pour la liste.`;
}

/** Liste des détecteurs hors service, lisible pendant un incident aussi (le bloc « Tout est calme » est alors masqué). */
$('offline-counter').addEventListener('click', () => {
  const opener = $('offline-counter');
  const down = downDetectors();
  const close = h('button', { class: 'btn btn-primary', type: 'button', text: 'Fermer', onclick: () => dialogs.close() });
  dialogs.open(
    down.length > 1 ? `${down.length} détecteurs hors service` : 'Détecteur hors service',
    [
      h('p', { text: down.length > 1 ? 'Leur zone n’est plus surveillée : prévenez le technicien.' : 'Sa zone n’est plus surveillée : prévenez le technicien.' }),
      h(
        'ul',
        { class: 'down-list' },
        ...down.map((d) => {
          const floor = S.floors.length > 1 && floorName(d.floorId) ? `, ${floorName(d.floorId)}` : '';
          return h('li', {}, h('strong', { text: `${d.id} ${d.name}` }), ` - ${d.zone || 'sans zone'}${floor} : ${STATUS_LABEL[d.status]}`);
        }),
      ),
      h(
        'div',
        { class: 'actions' },
        close,
        S.me?.role === 'admin' ? h('a', { class: 'btn', href: '#/equipements', onclick: () => dialogs.close() }, icon('plan'), 'Ouvrir l’inventaire') : null,
      ),
    ],
    { onClose: () => opener.focus() },
  );
  close.focus();
});

render.alarmState = updateAlarmState;

let audio = null;
function ensureAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
  } catch {
    audio = null;
  }
}

function beep(freq, duration) {
  if (!audio || audio.state !== 'running') return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = freq;
  osc.type = 'square';
  gain.gain.value = 0.05;
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + duration);
}

setInterval(() => {
  if (!S.me) return;
  const unacked = activeIncidents().filter((i) => i.status === 'open');
  if (unacked.length && !S.muted) {
    if (unacked.some((i) => i.severity === 'critical' && i.confirmedAt !== null)) {
      beep(1175, 0.15); // alarme confirmée : double bip aigu
      setTimeout(() => beep(1175, 0.15), 220);
    } else beep(unacked.some((i) => i.severity === 'critical') ? 880 : 520, 0.3);
  }
  tickIncidents();
}, 1000);

function showMute() {
  $('mute').replaceChildren(icon(S.muted ? 'volume-off' : 'volume'), h('span', { text: S.muted ? 'Son coupé' : 'Son activé' }));
  $('mute').title = S.muted ? "L'alerte sonore est coupée : touchez pour la rétablir." : "Couper l'alerte sonore (les alarmes restent affichées).";
}
$('mute').addEventListener('click', () => {
  S.muted = !S.muted;
  showMute();
  ensureAudio();
});
showMute();
document.addEventListener('click', ensureAudio);

// ---------------------------------------------------------------- jauge du rail (indice de sécurité du site)

const thermo = createThermometer();
$('rail-gauge').prepend(thermo.el);

function showRailGauge(site) {
  const level = levelOf(site.index);
  thermo.set(site.index);
  $('rail-index').textContent = level ? String(site.index) : '—';
  $('rail-of').hidden = !level;
  const word = $('rail-level');
  word.textContent = level ? (site.levelLabel ?? level.label) : 'À évaluer';
  word.className = `rail-level ${level ? `lvl-${level.level}` : 'is-none'}`;
  const worst = level && site.worstZone ? `Zone la plus exposée : ${site.worstZone}` : `${site.assessedZones} zone(s) évaluée(s) sur ${site.totalZones}`;
  $('rail-worst').textContent = worst;
  $('rail-worst').title = worst;
  $('rail-gauge').setAttribute(
    'aria-label',
    level ? `Indice de sécurité : ${site.index} sur 60, niveau ${word.textContent.toLowerCase()}. Ouvrir Risques.` : 'Indice de sécurité : à évaluer. Ouvrir Risques.',
  );
}

async function loadRailGauge() {
  if (!S.me || S.me.restricted) return;
  try {
    showRailGauge((await api('/api/risk')).site);
  } catch {
    // indisponible : la jauge garde sa dernière valeur
  }
}
setInterval(loadRailGauge, 60000);
on('risk', (d) => d?.site && S.me && !S.me.restricted && showRailGauge(d.site)); // une évaluation enregistrée met le rail à jour tout de suite

// ---------------------------------------------------------------- rendu global et démarrage

function renderAll(force = false) {
  renderPlan();
  renderWall();
  renderIncidents();
  renderJournal();
  renderAdmin(force);
  updateAlarmState();
}

(async () => {
  try {
    S.me = await api('/api/me');
    showApp();
  } catch {
    if ($('login').hidden) showLogin(); // sans session, le 401 l'a déjà affichée ; ici : serveur injoignable
  }
})();

// Tableaux d'administration repliés en fiches sous 640 px : les rôles gardent leur sens de tableau pour les lecteurs d'écran.
{
  let queued = false;
  const apply = () => {
    queued = false;
    for (const t of document.querySelectorAll('table.adm-stack:not([role])')) ariaTable(t);
  };
  new MutationObserver(() => {
    if (!queued) { queued = true; setTimeout(apply, 50); }
  }).observe(document.getElementById('main') ?? document.body, { childList: true, subtree: true });
}
