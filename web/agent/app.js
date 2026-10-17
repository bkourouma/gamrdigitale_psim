// Application des agents : la coquille. Routeur d'écrans (boot -> pair | login | service | main), session, onglets,
// en-tête, bandeau d'alarme, fin de service. Les écrans (alarmes, ronde, SOS, main courante) sont des modules à part.
import { h, setChildren, api, local, fmtClock, setAuthLostHandler, setNetworkHandler } from './util.js';
import { installAudioUnlock } from './sound.js';
import { createQueue, idbStore, makeSend } from './queue.js';
import { createSos } from './sos.js';
import { createAlarms } from './alarms.js';
import { createRonde } from './ronde.js';
import { createLogbook } from './logbook.js';

const KEY_ME = 'psim-agent-me';
const KEY_DISCREET = 'psim-agent-discreet';
const KEY_PAIRED = 'psim-agent-paired'; // ce téléphone est appairé (le SOS est alors proposé dès l'écran de connexion)
const KEY_LAST = 'psim-agent-last'; // dernier agent connecté ici : le SOS le nomme même sans session
const KEY_REJECTS = 'psim-agent-rejets'; // journal local des envois refusés pour de bon (compte rendu)
const KEY_PREFIX = 'psim-agent-';
// Réglages du téléphone, pas des données de l'agent : la fin de service ne les efface pas.
const KEEP_AT_END = new Set([KEY_DISCREET, KEY_PAIRED, KEY_LAST, KEY_REJECTS]);
const SS_TAB = 'psim-agent-tab';
const SS_CP = 'psim-agent-cp';
const TABS = ['alarms', 'ronde', 'sos'];

// ----------------------------------------------------------------------------------------------------- état global
let root = null;
let toastRegion = null;
let state = 'boot'; // boot | pair | login | service | main
let me = null; // AgentMe courant
let agents = []; // agents proposés par ce téléphone
let netOk = true; // dernier appel réussi ?
let bootedOffline = false; // entré en mode principal sans réseau
let endingService = false; // fin de service en cours (un 401 est alors attendu)
let loggingOut = false;
let cleanupScreen = null; // retire les écouteurs de l'écran affiché
let core = null; // { queue, sos } : vivent tant que la page est ouverte, avec ou sans session (un SOS ne s'arrête jamais)
let services = null; // { alarms, ronde, logbook } : seulement en service
let shell = null; // éléments de l'écran principal
let summary = { total: 0, unacked: 0 };
let activeTab = 'alarms';
let monitorTimer = null;
let monitorTicks = 0;
let hadShift = false;

// ----------------------------------------------------------------------------------------------------- messages
/** Message éphémère : role="status", 4 s (erreurs 8 s). */
export function toast(message, kind = 'info') {
  if (!toastRegion) return;
  const el = h('div', { class: `toast${kind === 'error' ? ' toast-error' : kind === 'ok' ? ' toast-ok' : ''}`, text: message });
  toastRegion.append(el);
  while (toastRegion.children.length > 3) toastRegion.firstElementChild?.remove();
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

const plural = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

function svgIcon(...paths) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

const ICONS = {
  alarms: () => svgIcon('M6 9a6 6 0 0 1 12 0c0 6 2 7 2 8H4c0-1 2-2 2-8Z', 'M10 20a2 2 0 0 0 4 0'),
  ronde: () => svgIcon('M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11Z', 'M12 8.5v3', 'M12 10h.01'),
  sos: () => svgIcon('M12 3 2 20h20Z', 'M12 10v5', 'M12 18h.01'),
};

const TAB_LABEL = { alarms: 'Alarmes', ronde: 'Ronde', sos: 'SOS' };

// ----------------------------------------------------------------------------------------------------- affichage
function show(node) {
  if (cleanupScreen) {
    cleanupScreen();
    cleanupScreen = null;
  }
  root.replaceChildren(node);
  window.scrollTo(0, 0);
}

function brandBlock() {
  return h(
    'div',
    { class: 'sh-brand' },
    h('img', { src: 'icon.svg', alt: '', width: 48, height: 48 }),
    h('div', { class: 'sh-brand-text' }, h('div', { class: 'sh-brand-name', text: 'GAMR-DIGITALE' }), h('div', { class: 'sh-brand-sub', text: 'Application des agents' })),
    // Le SOS est là dès que le téléphone est appairé, même sans agent connecté (Avenant 1).
    phonePaired() && core ? core.sos.holdButton({ variant: 'compact' }) : null,
  );
}

function page(...children) {
  // Le bandeau d'état du SOS (« non transmis, nouvel essai… ») suit l'agent d'un écran à l'autre.
  return h('main', { class: 'sh-page' }, brandBlock(), phonePaired() && core ? core.sos.statusEl : null, ...children);
}

const phonePaired = () => local.get(KEY_PAIRED, false) === true;
const setPaired = (value) => (value ? local.set(KEY_PAIRED, true) : local.remove(KEY_PAIRED));
const lastAgent = () => {
  const last = local.get(KEY_LAST);
  return typeof last?.username === 'string' ? last.username : null;
};

function showLoading(text = 'Chargement…') {
  state = 'boot';
  show(page(h('p', { class: 'sh-lead', role: 'status', text })));
}

function showNoNetwork(detail) {
  state = 'boot';
  show(
    page(
      h('h1', { class: 'sh-title', text: 'Pas de réseau' }),
      h('p', { class: 'sh-lead', text: detail ?? 'Le téléphone ne joint pas le serveur du PSIM. Vérifiez le Wi-Fi ou les données mobiles, puis réessayez.' }),
      h('button', { class: 'btn btn-primary', type: 'button', text: 'Réessayer', onClick: () => void checkSession() }),
    ),
  );
}

// ----------------------------------------------------------------------------------------------------- démarrage
async function boot() {
  showLoading();
  const pairMessage = await readHash();
  await checkSession(pairMessage);
}

/** Lit #pair= et #cp= puis efface le hash. Renvoie un message d'erreur d'appairage éventuel. */
async function readHash() {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  let message = null;
  const cp = params.get('cp');
  if (cp) {
    try {
      sessionStorage.setItem(SS_CP, cp);
    } catch {
      // stockage interdit : le code sera perdu, tant pis
    }
  }
  const pair = params.get('pair');
  history.replaceState(null, '', window.location.pathname + window.location.search);
  if (pair) {
    const r = await api('/api/agent/pair', { method: 'POST', body: { code: pair } });
    if (!r.ok) message = r.network ? 'Pas de réseau : l’appairage n’a pas pu se faire. Réessayez.' : r.error;
  }
  return message;
}

async function loadPhone() {
  const r = await api('/api/agent/phone');
  if (r.ok) {
    agents = Array.isArray(r.data?.agents) ? r.data.agents : [];
    setPaired(true);
  } else if (r.status === 401 || r.status === 403) {
    setPaired(false);
  }
  return r;
}

/** Quel écran afficher ? Appairage, connexion, prise de service ou écran principal. */
async function checkSession(pairMessage = null) {
  showLoading();
  const phone = await loadPhone();
  if (phone.status === 401 || phone.status === 403) return showPair(pairMessage);
  if (phone.network) return offlineStart();
  if (!phone.ok) return showNoNetwork(phone.error);
  netOk = true;
  const r = await api('/api/agent/me');
  if (r.network) return offlineStart();
  if (r.ok && r.data?.me) return applyMe(r.data.me);
  return showLogin(pairMessage);
}

/** Pas de réseau au démarrage : on reprend avec le dernier profil connu, s'il y en a un en service. */
function offlineStart() {
  netOk = false;
  const saved = local.get(KEY_ME);
  if (saved?.username && saved.shift) {
    me = saved;
    bootedOffline = true;
    void enterMain();
    return;
  }
  showNoNetwork();
}

function applyMe(next) {
  me = next;
  local.set(KEY_ME, me);
  local.set(KEY_LAST, { username: me.username, at: Date.now() });
  if (me.shift) void enterMain();
  else showService();
}

// ----------------------------------------------------------------------------------------------------- appairage
function showPair(message = null) {
  state = 'pair';
  me = null;
  const error = h('p', { class: 'sh-error', role: 'alert', text: message ?? '' });
  const input = h('input', { id: 'sh-pair-code', class: 'input', type: 'text', autocapitalize: 'none', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go' });
  const button = h('button', { class: 'btn btn-primary', type: 'submit', text: 'Appairer ce téléphone' });
  const form = h(
    'form',
    { class: 'stack' },
    h('label', { class: 'field', for: 'sh-pair-code' }, 'Code d’appairage', input),
    error,
    button,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let code = input.value.trim();
    const found = /pair=([^&\s]+)/i.exec(code);
    if (found) code = found[1];
    if (!code) {
      error.textContent = 'Saisissez le code d’appairage.';
      return;
    }
    button.disabled = true;
    error.textContent = '';
    const r = await api('/api/agent/pair', { method: 'POST', body: { code } });
    button.disabled = false;
    if (r.ok) return checkSession();
    error.textContent = r.network ? 'Pas de réseau. Réessayez dans un instant.' : r.error;
  });
  show(
    page(
      h('h1', { class: 'sh-title', text: 'Appairer ce téléphone' }),
      h('p', { class: 'sh-lead', text: 'Demandez au responsable le QR d’appairage et scannez-le avec l’appareil photo du téléphone.' }),
      h('p', { class: 'sh-lead', text: 'Vous pouvez aussi saisir le code à la main :' }),
      form,
    ),
  );
}

// ----------------------------------------------------------------------------------------------------- connexion
async function showLogin(message = null) {
  state = 'login';
  me = null;
  hadShift = false;
  local.remove(KEY_ME);
  bootedOffline = false;
  stopMonitor();
  const phone = await loadPhone();
  if (state !== 'login') return;
  if (phone.status === 401 || phone.status === 403) return showPair();
  if (phone.ok) netOk = true;
  renderAgentList(message, phone.network ? 'Pas de réseau : la liste peut ne pas être à jour.' : null);
}

function renderAgentList(message, warning) {
  const items = agents.map((agent) => {
    const locked = Boolean(agent.locked);
    return h(
      'button',
      { class: 'btn sh-agent', type: 'button', disabled: locked, onClick: () => renderKeypad(agent) },
      h('span', { text: agent.displayName || agent.username }),
      locked ? h('span', { class: 'sh-agent-note', text: 'Compte verrouillé : voyez le chef de poste' }) : null,
    );
  });
  show(
    page(
      h('h1', { class: 'sh-title', text: 'Qui êtes-vous ?' }),
      message ? h('p', { class: 'sh-notice', role: 'status', text: message }) : null,
      warning ? h('p', { class: 'sh-lead', text: warning }) : null,
      agents.length
        ? h('div', { class: 'stack' }, items)
        : h('p', { class: 'empty', text: 'Aucun agent n’est déclaré sur ce téléphone. Voyez le chef de poste.' }),
      h('button', { class: 'btn btn-quiet', type: 'button', text: 'Actualiser la liste', onClick: () => void showLogin() }),
    ),
  );
}

function renderKeypad(agent) {
  let pin = '';
  let busy = false;
  const MAX = 6;
  const dots = h('div', { class: 'sh-dots', 'aria-hidden': 'true' });
  const dotsText = h('p', { class: 'sr-only', role: 'status' });
  const error = h('p', { class: 'sh-error', role: 'alert' });
  const validate = h('button', { class: 'btn btn-primary sh-key sh-key-small', type: 'button', text: 'Valider', disabled: true });

  const refresh = () => {
    setChildren(dots, Array.from({ length: MAX }, (_, i) => h('span', { class: `sh-dot${i < pin.length ? ' sh-dot-on' : ''}` })));
    dotsText.textContent = plural(pin.length, 'chiffre saisi', 'chiffres saisis');
    validate.disabled = busy || pin.length < 4;
  };
  const press = (digit) => {
    if (busy || pin.length >= MAX) return;
    pin += digit;
    error.textContent = '';
    refresh();
  };
  const erase = () => {
    if (busy) return;
    pin = pin.slice(0, -1);
    refresh();
  };
  const submit = async () => {
    if (busy || pin.length < 4) return;
    busy = true;
    refresh();
    const r = await api('/api/agent/login', { method: 'POST', body: { username: agent.username, pin } });
    busy = false;
    if (r.ok && r.data?.me) {
      if (cleanupScreen) {
        cleanupScreen();
        cleanupScreen = null;
      }
      return applyMe(r.data.me);
    }
    pin = '';
    if (r.status === 423) {
      agent.locked = true;
      return renderAgentList('Compte verrouillé : voyez le chef de poste.', null);
    }
    error.textContent = r.network ? 'Pas de réseau. Réessayez dans un instant.' : r.status === 401 ? 'Code incorrect' : r.error;
    refresh();
  };

  const keyButton = (label, onClick, extra = '') => h('button', { class: `btn sh-key${extra}`, type: 'button', text: label, onClick });
  const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => keyButton(String(d), () => press(String(d))));
  validate.addEventListener('click', () => void submit());
  const pad = h('div', { class: 'sh-keypad' }, keys, keyButton('Effacer', erase, ' sh-key-small'), keyButton('0', () => press('0')), validate);

  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[0-9]$/.test(e.key)) {
      press(e.key);
      e.preventDefault();
    } else if (e.key === 'Backspace') {
      erase();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      void submit();
      e.preventDefault();
    }
  };

  show(
    page(
      h('h1', { class: 'sh-title', text: `Bonjour ${agent.displayName || agent.username}` }),
      h('p', { class: 'sh-lead', text: 'Entrez votre code personnel (4 à 6 chiffres).' }),
      dots,
      dotsText,
      error,
      pad,
      h('button', { class: 'btn btn-quiet', type: 'button', text: 'Ce n’est pas moi', onClick: () => renderAgentList(null, null) }),
    ),
  );
  document.addEventListener('keydown', onKey);
  cleanupScreen = () => document.removeEventListener('keydown', onKey);
  refresh();
}

// ----------------------------------------------------------------------------------------------------- prise de service
function showService(message = null) {
  state = 'service';
  hadShift = false;
  stopMonitor();
  const error = h('p', { class: 'sh-error', role: 'alert' });
  const start = h('button', { class: 'btn btn-ok sh-start', type: 'button', text: 'Je prends mon service' });
  start.addEventListener('click', async () => {
    start.disabled = true;
    error.textContent = '';
    const r = await api('/api/agent/shift/start', { method: 'POST' });
    start.disabled = false;
    if (r.ok && r.data?.me) return applyMe(r.data.me);
    if (state !== 'service') return;
    error.textContent = r.network ? 'Pas de réseau. Réessayez dans un instant.' : r.error;
  });
  const zones = Array.isArray(me?.zones) ? me.zones : [];
  show(
    page(
      h('h1', { class: 'sh-title', text: `Bonjour ${me?.displayName ?? ''}`.trim() }),
      message ? h('p', { class: 'sh-notice', role: 'status', text: message }) : null,
      h('div', { class: 'card' }, h('h2', { class: 'card-title', text: 'Vos zones' }), zones.length ? h('div', { class: 'sh-zones' }, zones.map((z) => h('span', { class: 'pill pill-ok', text: z }))) : h('p', { class: 'muted', text: 'Toutes les zones du site.' })),
      error,
      start,
      h('button', { class: 'btn btn-quiet', type: 'button', text: 'Ce n’est pas moi', onClick: () => void notMe() }),
    ),
  );
}

async function notMe() {
  loggingOut = true;
  const r = await api('/api/agent/logout', { method: 'POST' });
  loggingOut = false;
  if (r.network) return toast('Pas de réseau : impossible de changer d’agent maintenant.', 'error');
  void showLogin();
}

// ----------------------------------------------------------------------------------------------------- services (modules)
/** Une session existe-t-elle ? Sans elle, seuls les SOS peuvent partir (cookie du téléphone seul). */
const hasSession = () => state === 'main' || state === 'service';

/** Un envoi refusé pour de bon : on le dit, et on le garde dans le journal local (30 derniers). */
function logRejected(item, response) {
  const message = response?.error ?? item?.lastError ?? 'erreur inconnue';
  const journal = local.get(KEY_REJECTS, []);
  journal.push({ at: Date.now(), kind: item?.kind ?? '?', username: item?.username ?? null, clientId: item?.clientId ?? null, message: String(message).slice(0, 200) });
  local.set(KEY_REJECTS, journal.slice(-30));
  toast(`Envoi refusé : ${message}`, 'error');
}

/** Ce qui vit tant que la page est ouverte : la file d'envois et le SOS (jamais arrêtés par une déconnexion). */
function buildCore() {
  const queue = createQueue({
    store: idbStore(),
    send: makeSend(api),
    onChange: (info) => updatePending(info?.count ?? 0),
    onResult: (item, outcome, response) => {
      if (outcome === 'rejected') logRejected(item, response);
    },
  });
  // Même sans connexion, le SOS porte le nom du dernier agent connecté ici (le serveur vérifie qu'il est récent).
  const getUser = () => me?.username ?? lastAgent();
  const sos = createSos({ queue, getUser, toast });
  return { queue, sos };
}

function buildServices() {
  const { queue } = core;
  const getUser = () => me?.username ?? null;
  const alarms = createAlarms({ api, toast, onSummary: onAlarmSummary });
  const logbook = createLogbook({
    queue,
    toast,
    getUser,
    getLastCheckpoint: () => ronde.lastCheckpoint() ?? (me?.position ? { id: me.position.checkpointId, name: me.position.name } : null),
  });
  const ronde = createRonde({ api, queue, toast, getUser, openLogbook: (opts) => logbook.open(opts) });
  return { alarms, ronde, logbook };
}

/** Arrête ce qui n'a de sens qu'en service. La file et le SOS continuent : un SOS non parti doit rester visible et réessayer. */
function teardown() {
  stopMonitor();
  if (services) {
    for (const stop of [() => services.alarms.stop(), () => services.ronde.stop()]) {
      try {
        stop();
      } catch {
        // un module qui ne s'arrête pas ne doit pas bloquer la déconnexion
      }
    }
    try {
      services.logbook.close();
    } catch {
      // rien
    }
  }
  services = null;
  shell = null;
  summary = { total: 0, unacked: 0 };
}

// ----------------------------------------------------------------------------------------------------- écran principal
async function enterMain() {
  state = 'main';
  if (services) teardown();
  services = buildServices();
  const { alarms, ronde } = services;
  buildShell();
  show(shell.el);
  renderHeader();
  updateOnline();
  updatePending(core.queue.count());
  setTab(readSavedTab());
  // La session existe maintenant : on vide tout de suite ce que l'agent précédent a laissé (chaque envoi porte son auteur).
  void core.queue.flush().catch(() => {});
  alarms.start();
  ronde.start();
  hadShift = Boolean(me.shift);
  startMonitor();
  void consumePendingCode();
}

function readSavedTab() {
  try {
    const t = sessionStorage.getItem(SS_TAB);
    return TABS.includes(t) ? t : 'alarms';
  } catch {
    return 'alarms';
  }
}

function buildShell() {
  const { alarms, ronde, logbook } = services;
  const { sos } = core;
  const netDot = h('span', { class: 'sh-net', role: 'img', 'aria-label': 'En ligne', text: '●' });
  const whoName = h('span', { class: 'sh-who-name' });
  const whoService = h('span', { class: 'sh-who-service' });
  const who = h('button', { class: 'sh-who', type: 'button', 'aria-haspopup': 'dialog', onClick: openAccountSheet }, h('span', { class: 'sh-who-line' }, whoName, netDot), whoService);
  const online = h('span', { class: 'pill pill-ok', text: 'En ligne' });
  const badge = h('button', { class: 'sh-badge', type: 'button', hidden: true, onClick: () => void flushNow() });
  // La ligne d'état ne prend de la place que si quelque chose est à dire : hors ligne ou envois en attente.
  const statusRow = h('div', { class: 'sh-header-status', hidden: true }, online, badge);
  const bannerText = h('span');
  const banner = h(
    'button',
    { class: 'sh-alarm-banner', type: 'button', hidden: true, onClick: () => setTab('alarms') },
    bannerText,
    h('span', { class: 'sh-banner-go', text: 'Voir' }),
  );

  const panes = {
    alarms: h('div', { hidden: true }, alarms.el),
    ronde: h('div', { hidden: true }, ronde.el),
    sos: h('div', { hidden: true }, sos.screen, accountCard()),
  };
  const tabs = {};
  const counts = {};
  const nav = h('nav', { class: 'sh-tabs', 'aria-label': 'Écrans de l’application' });
  for (const name of TABS) {
    const count = h('span', { class: 'sh-tab-count', hidden: true });
    counts[name] = count;
    const tab = h('button', { class: 'sh-tab', type: 'button', onClick: () => setTab(name) }, ICONS[name](), h('span', { text: TAB_LABEL[name] }), count);
    tabs[name] = tab;
    nav.append(tab);
  }

  const el = h(
    'div',
    { class: 'sh-main' },
    h('header', { class: 'sh-header' }, h('div', { class: 'sh-header-top' }, who, sos.holdButton({ variant: 'compact' })), statusRow),
    sos.statusEl,
    banner,
    h('div', { class: 'sh-panes' }, panes.alarms, panes.ronde, panes.sos),
    nav,
    logbook.el,
  );
  shell = { el, whoName, whoService, online, netDot, statusRow, pendingCount: 0, badge, banner, bannerText, panes, tabs, counts };
}

function renderHeader() {
  if (!shell || !me) return;
  shell.whoName.textContent = me.displayName || me.username;
  shell.whoService.textContent = me.shift ? `Service depuis ${fmtClock(me.shift.startedAt)} · fin prévue ${fmtClock(me.shift.endsAt)}` : 'Hors service';
}

function updateOnline() {
  if (!shell) return;
  const ok = navigator.onLine && netOk;
  shell.online.textContent = ok ? 'En ligne' : 'Hors ligne';
  shell.online.className = `pill ${ok ? 'pill-ok' : 'pill-warn'}`;
  shell.netDot.className = `sh-net${ok ? '' : ' sh-net-off'}`;
  shell.netDot.setAttribute('aria-label', ok ? 'En ligne' : 'Hors ligne');
  updateStatusRow();
}

function updateStatusRow() {
  if (!shell) return;
  shell.statusRow.hidden = navigator.onLine && netOk && shell.pendingCount <= 0;
}

function updatePending(count) {
  if (!shell) return;
  shell.pendingCount = count;
  shell.badge.hidden = count <= 0;
  shell.badge.textContent = `${plural(count, 'envoi', 'envois')} en attente`;
  updateStatusRow();
}

async function flushNow() {
  if (!services) return;
  const { queue } = core;
  shell.badge.disabled = true;
  try {
    await queue.flush();
    if (queue.count() === 0) toast('Tout est envoyé.', 'ok');
    else toast(`${plural(queue.count(), 'envoi n’a pas pu partir', 'envois n’ont pas pu partir')}. Nouvel essai bientôt.`, 'error');
  } finally {
    if (shell) shell.badge.disabled = false;
  }
}

function onAlarmSummary(next) {
  summary = next ?? { total: 0, unacked: 0 };
  updateAlarmUi();
}

function updateAlarmUi() {
  if (!shell) return;
  const n = summary.unacked > 0 ? summary.unacked : 0;
  shell.counts.alarms.hidden = n === 0;
  shell.counts.alarms.textContent = String(n);
  shell.counts.alarms.setAttribute('aria-label', `${plural(n, 'alarme non acquittée', 'alarmes non acquittées')}`);
  const showBanner = n > 0 && activeTab !== 'alarms';
  shell.banner.hidden = !showBanner;
  shell.bannerText.textContent = plural(n, 'alarme non acquittée', 'alarmes non acquittées');
}

function setTab(name) {
  if (!shell || !TABS.includes(name)) return;
  activeTab = name;
  try {
    sessionStorage.setItem(SS_TAB, name);
  } catch {
    // rien
  }
  for (const t of TABS) {
    shell.panes[t].hidden = t !== name;
    if (t === name) shell.tabs[t].setAttribute('aria-current', 'page');
    else shell.tabs[t].removeAttribute('aria-current');
  }
  services.alarms.setActive(name === 'alarms');
  services.ronde.setActive(name === 'ronde');
  updateAlarmUi();
  window.scrollTo(0, 0);
}

// ----------------------------------------------------------------------------------------------------- compte
function accountButtons(afterAction) {
  return [
    h('button', { class: 'btn', type: 'button', text: 'Changer d’agent', onClick: () => void changeAgent(afterAction) }),
    h('button', { class: 'btn btn-danger', type: 'button', text: 'Terminer mon service', onClick: () => void openEndSheet(afterAction) }),
  ];
}

function accountCard() {
  return h('section', { class: 'card sh-account' }, h('h2', { class: 'card-title', text: 'Mon compte' }), h('div', { class: 'stack' }, accountButtons(null)));
}

function openSheet(...children) {
  const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'sheet' }, ...children));
  const previous = document.activeElement;
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (previous instanceof HTMLElement) previous.focus();
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  overlay.querySelector('button')?.focus();
  return { overlay, close };
}

function openAccountSheet() {
  if (!me) return;
  const sheet = openSheet(
    h('h2', { class: 'screen-title', text: me.displayName || me.username }),
    me.shift ? h('p', { class: 'muted', text: `Service depuis ${fmtClock(me.shift.startedAt)} · fin prévue ${fmtClock(me.shift.endsAt)}` }) : null,
    h('div', { class: 'sh-sheet-actions' }, accountButtons(() => sheet.close()), h('button', { class: 'btn btn-quiet', type: 'button', text: 'Fermer', onClick: () => sheet.close() })),
  );
}

/** Change d'agent : la session de cet agent se ferme, le service continue. */
async function changeAgent(afterAction) {
  loggingOut = true;
  const r = await api('/api/agent/logout', { method: 'POST' });
  loggingOut = false;
  if (r.network) return toast('Pas de réseau : impossible de changer d’agent maintenant.', 'error');
  afterAction?.();
  teardown();
  void showLogin();
}

async function openEndSheet(afterAction) {
  afterAction?.();
  const message = h('p', { class: 'muted', text: 'Vous ne recevrez plus d’alarmes sur ce téléphone et les données locales seront effacées.' });
  const error = h('p', { class: 'sh-error', role: 'alert' });
  const confirm = h('button', { class: 'btn btn-danger', type: 'button', text: 'Oui, je termine mon service' });
  const cancel = h('button', { class: 'btn', type: 'button', text: 'Non, je continue' });
  const sheet = openSheet(h('h2', { class: 'screen-title', text: 'Terminer mon service ?' }), message, error, h('div', { class: 'sh-sheet-actions' }, confirm, cancel));
  cancel.addEventListener('click', () => sheet.close());
  let warned = false;
  confirm.addEventListener('click', async () => {
    endingService = true;
    try {
      await confirmEnd();
    } finally {
      endingService = false;
    }
  });
  const confirmEnd = async () => {
    if (!services) return sheet.close();
    const { queue } = core;
    confirm.disabled = true;
    cancel.disabled = true;
    error.textContent = '';
    if (queue.count() > 0) {
      message.textContent = 'Envoi des données en attente…';
      try {
        await queue.flush();
      } catch {
        // on regarde ce qui reste
      }
      message.textContent = '';
      const left = queue.count();
      if (left > 0 && !warned) {
        warned = true;
        error.textContent = `${plural(left, 'envoi n’a pas pu partir', 'envois n’ont pas pu partir')} : ${left > 1 ? 'ils seront perdus' : 'il sera perdu'}.`;
        confirm.textContent = 'Terminer quand même';
        confirm.disabled = false;
        cancel.disabled = false;
        return;
      }
    }
    const r = await api('/api/agent/shift/end', { method: 'POST' });
    if (r.network) {
      error.textContent = 'Pas de réseau : votre service n’est pas terminé. Rien n’a été effacé.';
      confirm.disabled = false;
      cancel.disabled = false;
      return;
    }
    if (r.ok || r.status === 401) {
      sheet.close();
      await wipeAndLeave();
      return;
    }
    error.textContent = r.error;
    confirm.disabled = false;
    cancel.disabled = false;
  };
}

/** Fin de service réussie : plus rien de l'agent ne reste sur le téléphone, sauf les réglages du téléphone et un SOS pas encore parti. */
async function wipeAndLeave() {
  try {
    await core?.queue.clear({ keepKinds: ['sos'] });
  } catch {
    // rien
  }
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    for (const key of keys) if (key?.startsWith(KEY_PREFIX) && !KEEP_AT_END.has(key)) localStorage.removeItem(key);
  } catch {
    // rien
  }
  try {
    sessionStorage.clear();
  } catch {
    // rien
  }
  teardown();
  me = null;
  void showLogin();
}

// ----------------------------------------------------------------------------------------------------- surveillance
function startMonitor() {
  stopMonitor();
  monitorTicks = 0;
  monitorTimer = setInterval(() => {
    monitorTicks += 1;
    if (bootedOffline || monitorTicks % 4 === 0) void checkMe();
  }, 15000);
}

function stopMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}

/** Relit /me : confirme la session, met à jour l'en-tête, détecte la fin du service. */
async function checkMe() {
  if (state !== 'main') return;
  const r = await api('/api/agent/me');
  if (state !== 'main') return;
  if (r.network) {
    netOk = false;
    updateOnline();
    return;
  }
  netOk = true;
  updateOnline();
  if (!r.ok || !r.data?.me) return; // 401 : traité par le gestionnaire de session perdue
  bootedOffline = false;
  me = r.data.me;
  local.set(KEY_ME, me);
  renderHeader();
  if (hadShift && !me.shift) await shiftEnded();
}

async function shiftEnded() {
  if (services) {
    try {
      await core.queue.flush();
    } catch {
      // la file reste sur le téléphone
    }
  }
  teardown();
  showService('Votre service est terminé.');
}

/** Un 401 : « Téléphone non appairé » renvoie à l'appairage, « Session terminée » à la connexion (Avenant 1, art. 3). */
function onAuthLost(res) {
  if (/non appair/i.test(String(res?.error ?? ''))) {
    if (state === 'pair' || state === 'boot') return; // le démarrage et l'appairage traitent eux-mêmes leur réponse
    teardown();
    setPaired(false);
    void showPair('Ce téléphone n’est plus appairé. Demandez un nouveau QR d’appairage au responsable.');
    return;
  }
  onSessionLost();
}

function onSessionLost() {
  if (state !== 'main' && state !== 'service') return;
  if (endingService || loggingOut) return;
  teardown();
  void showLogin('Votre session est terminée. Reconnectez-vous.');
}

// ----------------------------------------------------------------------------------------------------- code d'étiquette (#cp=)
async function consumePendingCode() {
  if (state !== 'main' || !services) return;
  let code = null;
  try {
    code = sessionStorage.getItem(SS_CP);
    if (code) sessionStorage.removeItem(SS_CP);
  } catch {
    // rien
  }
  if (!code) return;
  setTab('ronde');
  await services.ronde.submitCode(code, 'nfc');
}

function onHashChange() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const cp = params.get('cp');
  if (!cp) return;
  try {
    sessionStorage.setItem(SS_CP, cp);
  } catch {
    // rien
  }
  history.replaceState(null, '', window.location.pathname + window.location.search);
  void consumePendingCode();
}

// ----------------------------------------------------------------------------------------------------- lancement
function start() {
  root = document.getElementById('app');
  if (!root) return;
  toastRegion = h('div', { class: 'sh-toasts', role: 'status', 'aria-live': 'polite' });
  document.body.append(toastRegion);
  installAudioUnlock();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {
      // pas de service worker : l'application marche, sans mode hors ligne
    });
  }
  setAuthLostHandler(onAuthLost);
  // File d'envois et SOS : créés une fois, jamais arrêtés. Sans session, seuls les SOS partent (cookie du téléphone).
  core = buildCore();
  core.queue.start({ intervalMs: 15000, kinds: () => (hasSession() ? null : ['sos']) });
  void core.sos.resume();
  // La pastille « En ligne / Hors ligne » suit les vrais appels (alarmes, rondes, envois), pas seulement le Wi-Fi.
  setNetworkHandler((ok) => {
    netOk = ok;
    updateOnline();
  });
  window.addEventListener('online', () => {
    netOk = true;
    updateOnline();
    if (state === 'main') void checkMe();
  });
  window.addEventListener('offline', () => {
    updateOnline();
  });
  window.addEventListener('hashchange', onHashChange);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkMe();
  });
  void boot();
}

if (typeof document !== 'undefined') start();
