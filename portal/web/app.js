/**
 * Portail « Suivi de vos sites » : la coquille (connexion, rail, tiroir, thème), le routeur et les écrans.
 *
 * Lecture seule, langage courant. Tout texte venu des sites (noms, zones, équipements) passe par textContent (h) :
 * jamais d'HTML injecté. Les chiffres se rafraîchissent chaque minute SANS vider l'écran : l'ancien contenu reste
 * jusqu'à l'arrivée du nouveau, le focus clavier et la bascule graphique / tableau sont conservés.
 *
 * Routes : #/ (vue d'ensemble), #/site/<id>/<onglet>?days=7|30|90 (onglets : synthese, securite, equipements,
 * incidents, disponibilite). Un compte qui ne voit qu'un site arrive directement sur son site.
 */
import {
  $, h, icon, NB, fmtPct, fmtAvail, fmtDur, relTime, fmtDateTime, fmtClock, fmtDayText, plural, timeEl,
  SITE_STATE, SITE_ORDER, DEVICE_ORDER, CATEGORY, ROLE, qualificationLabel,
  pill, sitePill, devicePill, dataTable, emptyBlock, notice, panel, facts,
} from './ui.js';
import { createRing, createThermometer, createTube, BANDS } from './gauge.js';
import { disposeCharts, downtimeChart, riskTrend } from './charts.js';

const DAY_MS = 86_400_000;
const PERIODS = [7, 30, 90];
const TABS = [
  { id: 'synthese', label: 'Synthèse', icon: 'grid', usesPeriod: true },
  { id: 'securite', label: 'Sécurité', icon: 'gauge', usesPeriod: true },
  { id: 'equipements', label: 'Équipements', icon: 'signal', usesPeriod: false },
  { id: 'incidents', label: 'Incidents', icon: 'bell', usesPeriod: true },
  { id: 'disponibilite', label: 'Disponibilité', icon: 'chart', usesPeriod: true },
];
const TAB_IDS = TABS.map((t) => t.id);

const main = $('main');

const state = {
  me: null,
  /** Cartes des sites visibles (GET /api/sites), pour le rail et la vue d'ensemble. */
  sites: [],
  /** Écran affiché : { kind: 'home' } ou { kind: 'site', id, tab, days }. */
  page: null,
  /** Bascules « Voir en tableau », gardées d'un rafraîchissement à l'autre. */
  prefs: { downtime: false, risk: false },
  timer: null,
  seq: 0,
  loadedAt: 0,
  /** Écran d'entrée affiché : 'login', 'password', 'password-forced', ou null (le suivi est affiché). */
  gate: null,
};

// ------------------------------------------------------------------ appels

class SessionLost extends Error {}

async function api(path, init) {
  let res;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
  } catch {
    throw Object.assign(new Error('Le portail ne répond pas. Vérifiez la connexion à internet, puis réessayez.'), { network: true });
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* corps vide */
  }
  // Un écran lance plusieurs appels ensemble : seul le premier refus affiche la page de connexion (avec son message).
  // Les suivants la trouvent déjà là et ne la remplacent pas par un formulaire vierge.
  if (res.status === 401 && path !== '/api/login' && path !== '/api/me') {
    if (state.me !== null) showLogin(`Votre session a pris fin. Reconnectez-vous pour continuer.`);
    throw new SessionLost('session');
  }
  if (res.status === 403 && body?.error === 'password_change_required') {
    if (state.gate !== 'password-forced') showPassword(true);
    throw new SessionLost('password');
  }
  if (!res.ok) throw Object.assign(new Error(body?.error ?? `Erreur ${res.status}`), { status: res.status });
  return body;
}

// ------------------------------------------------------------------ connexion et mot de passe (le « portail d'entrée »)

/** Champ étiqueté : libellé visible, aide liée par aria-describedby. */
function field(name, label, type, { hint, ...attrs } = {}) {
  const hintId = hint ? `${name}-hint` : undefined;
  return h('label', { class: 'field' }, h('span', null, label), h('input', { name, id: name, type, required: true, 'aria-describedby': hintId, ...attrs }), hint && h('span', { class: 'hint', id: hintId }, hint));
}

function showGate(kind, content, title) {
  stopRefresh();
  state.gate = kind;
  // En revenant au suivi, l'écran sera « nouveau » : le focus ira sur son titre, pas sur un champ masqué.
  state.page = null;
  closeDrawer({ restoreFocus: false });
  disposeCharts();
  $('app').hidden = true;
  $('skip').hidden = true;
  // Un seul <main> visible à la fois : celui de la feuille de connexion ou celui du suivi.
  main.hidden = true;
  $('gate-main').hidden = false;
  $('gate').hidden = false;
  $('gate-body').replaceChildren(content);
  document.title = `${title} · GAMR-DIGITALE`;
}

function showLogin(message) {
  state.me = null;
  state.sites = [];
  state.page = null;
  const error = h('p', { class: 'form-error', role: 'alert', hidden: !message }, message ?? '');
  const submit = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, 'Se connecter');
  const form = h(
    'form',
    { class: 'gate-form' },
    h('div', { class: 'gate-intro' }, h('h1', null, 'Suivi de vos sites'), h('p', null, 'Connectez-vous pour voir l’état de la protection de vos sites : alarmes, équipements, indice de sécurité.')),
    field('username', 'Identifiant', 'text', { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' }),
    field('password', 'Mot de passe', 'password', { autocomplete: 'current-password' }),
    error,
    submit,
    h('p', { class: 'panel-note' }, 'Mot de passe oublié ou identifiant inconnu ? Contactez votre prestataire de sécurité.'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    submit.classList.add('is-busy');
    error.hidden = true;
    try {
      state.me = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: form.username.value, password: form.password.value }) });
      if (state.me.mustChangePassword) showPassword(true);
      else enterApp();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      submit.disabled = false;
      submit.classList.remove('is-busy');
      form.password.value = '';
      form.password.setAttribute('aria-invalid', 'true');
      form.password.focus();
    }
  });
  showGate('login', form, 'Connexion');
  form.username.focus();
}

function showPassword(forced) {
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, 'Enregistrer le nouveau mot de passe');
  const form = h(
    'form',
    { class: 'gate-form' },
    h(
      'div',
      { class: 'gate-intro' },
      h('h1', null, forced ? 'Choisissez votre mot de passe' : 'Changer de mot de passe'),
      h('p', null, forced ? 'Le mot de passe provisoire qui vous a été remis ne sert qu’à cette première connexion. Choisissez maintenant le vôtre.' : 'Vous resterez connecté après le changement.'),
    ),
    field('current', forced ? 'Mot de passe provisoire' : 'Mot de passe actuel', 'password', { autocomplete: 'current-password' }),
    field('next', 'Nouveau mot de passe', 'password', { autocomplete: 'new-password', minlength: '12', hint: '12 caractères au minimum, sans votre identifiant ni un mot courant.' }),
    field('again', 'Nouveau mot de passe, une seconde fois', 'password', { autocomplete: 'new-password' }),
    error,
    submit,
    h(
      'div',
      { class: 'gate-alt' },
      forced
        ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: logout }, icon('logout'), 'Se déconnecter')
        : h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => enterApp() }, icon('chevron-left'), 'Annuler et revenir au suivi'),
    ),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    form.again.removeAttribute('aria-invalid');
    if (form.next.value !== form.again.value) {
      error.textContent = 'Les deux nouveaux mots de passe ne sont pas identiques. Tapez-les de nouveau.';
      error.hidden = false;
      form.again.setAttribute('aria-invalid', 'true');
      form.again.focus();
      return;
    }
    submit.disabled = true;
    submit.classList.add('is-busy');
    try {
      state.me = await api('/api/password', { method: 'POST', body: JSON.stringify({ current: form.current.value, next: form.next.value }) });
      enterApp();
    } catch (err) {
      if (err instanceof SessionLost) return;
      error.textContent = err.message;
      error.hidden = false;
      submit.disabled = false;
      submit.classList.remove('is-busy');
    }
  });
  showGate(forced ? 'password-forced' : 'password', form, forced ? 'Choisissez votre mot de passe' : 'Changer de mot de passe');
  form.current.focus();
}

async function logout() {
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
  } catch {
    /* déjà déconnecté */
  }
  // La personne suivante ne repart pas sur le site ouvert par la précédente (il peut lui être « introuvable »).
  history.replaceState(null, '', '#/');
  showLogin();
}

// ------------------------------------------------------------------ coquille : compte, thème, tiroir

function enterApp({ fresh = false } = {}) {
  state.gate = null;
  $('gate').hidden = true;
  $('gate-main').hidden = true;
  main.hidden = false;
  $('app').hidden = false;
  $('skip').hidden = false;
  $('who-name').textContent = state.me.displayName || state.me.username;
  $('who-role').textContent = ROLE[state.me.role] ?? '';
  startRefresh();
  route({ fresh });
}

const THEMES = [
  { key: null, label: 'Automatique', icon: 'contrast' },
  { key: 'day', label: 'Jour', icon: 'sun' },
  { key: 'night', label: 'Nuit', icon: 'moon' },
];

function currentTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  return THEMES.find((x) => x.key === t) ?? THEMES[0];
}

function paintThemeButton() {
  const t = currentTheme();
  $('theme-label').textContent = `Thème${NB}: ${t.label}`;
  $('theme-icon').setAttribute('href', `icons.svg#${t.icon}`);
}

$('btn-theme').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  if (next.key) document.documentElement.setAttribute('data-theme', next.key);
  else document.documentElement.removeAttribute('data-theme');
  try {
    if (next.key) localStorage.setItem('portal.theme', next.key);
    else localStorage.removeItem('portal.theme');
  } catch {
    /* stockage indisponible : le choix vaut pour cette page */
  }
  paintThemeButton();
  // Les graphiques lisent leurs couleurs dans les jetons CSS : rien à redessiner.
});
paintThemeButton();

// Impression : toujours sur feuille claire, quel que soit le thème à l'écran.
let themeBeforePrint;
window.addEventListener('beforeprint', () => {
  themeBeforePrint = document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme', 'day');
});
window.addEventListener('afterprint', () => {
  if (themeBeforePrint) document.documentElement.setAttribute('data-theme', themeBeforePrint);
  else document.documentElement.removeAttribute('data-theme');
});

// Lien d'évitement : « #main » changerait la route (le routeur lit l'ancre) ; on déplace seulement le focus.
$('skip').addEventListener('click', (e) => {
  e.preventDefault();
  main.focus();
});
$('btn-password').addEventListener('click', () => showPassword(false));
$('btn-logout').addEventListener('click', logout);

/** Tiroir (≤ 1023 px) : voile derrière, Échap ferme, la feuille devient inerte tant qu'il est ouvert. */
const drawerQuery = window.matchMedia('(max-width: 1023px)');
function openDrawer() {
  if (!drawerQuery.matches) return;
  $('app').classList.add('is-drawer-open');
  $('scrim').hidden = false;
  // Tout ce qui est derrière le voile devient inerte, y compris le lien d'évitement (il viserait une feuille inerte).
  $('workspace').inert = true;
  $('skip').inert = true;
  $('menu-btn').setAttribute('aria-expanded', 'true');
  ($('rail').querySelector('[aria-current="page"]') ?? $('rail').querySelector('a, button'))?.focus();
}
function closeDrawer({ restoreFocus = true } = {}) {
  if (!$('app').classList.contains('is-drawer-open')) return;
  $('app').classList.remove('is-drawer-open');
  $('scrim').hidden = true;
  $('workspace').inert = false;
  $('skip').inert = false;
  $('menu-btn').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('menu-btn').focus();
}
$('menu-btn').addEventListener('click', openDrawer);
$('rail-close').addEventListener('click', () => closeDrawer());
$('scrim').addEventListener('click', () => closeDrawer());
// Choisir dans le tiroir l'écran déjà ouvert ne change pas l'adresse (pas de « hashchange », donc pas de route()) :
// on ferme quand même le tiroir et on rend la main à la page.
$('rail').addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a || a.getAttribute('href') !== location.hash || !$('app').classList.contains('is-drawer-open')) return;
  closeDrawer({ restoreFocus: false });
  main.querySelector('h1')?.focus({ preventScroll: true });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('app').classList.contains('is-drawer-open')) closeDrawer();
});
drawerQuery.addEventListener('change', () => closeDrawer({ restoreFocus: false }));

// ------------------------------------------------------------------ rail : la liste des sites

function siteHref(id, tab = 'synthese', days = 30) {
  return `#/site/${encodeURIComponent(id)}/${tab}?days=${days}`;
}

function renderRail(r) {
  const multi = state.sites.length > 1;
  const home = $('nav-home');
  home.hidden = !multi;
  if (r.kind === 'home') home.setAttribute('aria-current', 'page');
  else home.removeAttribute('aria-current');
  $('nav-sites-title').textContent = multi ? 'Vos sites' : 'Votre site';
  const homeHref = multi || state.sites.length === 0 ? '#/' : siteHref(state.sites[0].id);
  $('rail-brand').setAttribute('href', homeHref);
  $('topbar-brand').setAttribute('href', homeHref);
  $('rail-brand').setAttribute('aria-label', `GAMR-DIGITALE, suivi des sites${NB}: accueil`);
  $('topbar-brand').setAttribute('aria-label', `GAMR-DIGITALE, suivi des sites${NB}: accueil`);

  // Ordre alphabétique et stable : un menu qui se réordonne à chaque rafraîchissement désoriente.
  const sorted = [...state.sites].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  // Le prestataire voit plusieurs clients : on regroupe ses sites par organisation.
  const orgs = [...new Set(sorted.map((c) => c.organization))].sort((a, b) => a.localeCompare(b, 'fr'));
  const grouped = state.me?.role === 'admin' && orgs.length > 1;
  const tab = r.kind === 'site' ? r.tab : 'synthese';
  const days = r.kind === 'site' ? r.days : 30;
  const link = (c) => {
    const st = SITE_STATE[c.status.level] ?? SITE_STATE.unknown;
    const current = r.kind === 'site' && r.id === c.id;
    // Le mot de l'état est dans le nom du lien (texte .sr-only) ; l'infobulle le montre au survol. Elle est posée sur
    // l'icône (masquée aux lecteurs d'écran) et sur le nom, pas sur le lien : sinon le nom et l'état seraient lus deux fois.
    const tip = `${c.name}${NB}: ${c.status.label}`;
    return h(
      'li',
      null,
      h(
        'a',
        { class: 'nav-item nav-site', href: siteHref(c.id, tab, days), 'aria-current': current ? 'page' : null, 'data-key': `nav-site-${c.id}` },
        h('span', { class: `nav-state is-${st.tone}`, 'aria-hidden': 'true', title: tip }, icon(st.icon)),
        h('span', { class: 'nav-label', title: tip }, c.name),
        h('span', { class: 'sr-only' }, `${NB}: ${c.status.label}`),
      ),
    );
  };
  const blocks = grouped
    ? orgs.map((org) => h('div', { class: 'nav-org' }, h('p', { class: 'nav-org-title' }, org), h('ul', { class: 'nav-list', 'aria-label': org }, sorted.filter((c) => c.organization === org).map(link))))
    : [h('ul', { class: 'nav-list', 'aria-labelledby': 'nav-sites-title' }, sorted.map(link))];
  $('nav-sites').replaceChildren(...blocks);
}

// ------------------------------------------------------------------ routeur

function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  const asked = Number(new URLSearchParams(query).get('days'));
  const days = PERIODS.includes(asked) ? asked : 30;
  const m = path.match(/^\/site\/([^/]+)(?:\/([a-z]+))?\/?$/);
  if (!m) return { kind: 'home', days };
  let id = m[1];
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    /* identifiant mal encodé : tel quel, le serveur répondra « introuvable » */
  }
  return { kind: 'site', id, tab: TAB_IDS.includes(m[2]) ? m[2] : 'synthese', days };
}

async function route({ quiet = false, fresh = false } = {}) {
  if (!state.me) return;
  const seq = ++state.seq;
  const r = parseRoute();
  const prev = state.page;
  const samePage = prev && prev.kind === r.kind && prev.id === r.id;
  const active = document.activeElement;
  const focusInMain = active !== main && main.contains(active);
  const focusKey = active?.closest?.('[data-key]')?.getAttribute('data-key') ?? null;
  const drawerWasOpen = $('app').classList.contains('is-drawer-open');
  const scrollY = window.scrollY;
  if (!quiet) main.classList.add('is-loading');
  try {
    let content;
    if (r.kind === 'home') {
      const [overview, sites] = await Promise.all([api('/api/overview'), api('/api/sites')]);
      if (seq !== state.seq) return;
      state.sites = sites;
      // Un seul site : pas de vue d'ensemble, le site directement.
      if (sites.length === 1) return void location.replace(siteHref(sites[0].id, 'synthese', r.days));
      content = overviewPage(overview, sites);
    } else {
      const [detail, sites] = await Promise.all([
        api(`/api/sites/${encodeURIComponent(r.id)}?days=${r.days}`).catch((err) => (err.status === 404 ? null : Promise.reject(err))),
        api('/api/sites'),
      ]);
      if (seq !== state.seq) return;
      state.sites = sites;
      content = detail ? sitePage(detail, r) : notFoundPage();
    }
    state.loadedAt = Date.now();
    disposeCharts();
    renderRail(r);
    const nodes = content.filter(Boolean);
    // Même écran (rafraîchissement, onglet, période) et en-tête inchangé : on le garde en place, seule l'heure de mise à
    // jour change. Le focus qui y est (titre, « Imprimer ») n'est pas perdu, et le titre n'est pas relu chaque minute.
    const oldHead = samePage ? main.querySelector(':scope > .page-head') : null;
    if (oldHead && nodes[0]?.classList?.contains('page-head') && oldHead.dataset.sig === nodes[0].dataset.sig) {
      oldHead.querySelector('.updated')?.replaceWith(nodes[0].querySelector('.updated'));
      for (const child of [...main.children]) if (child !== oldHead) child.remove();
      oldHead.after(...nodes.slice(1));
    } else main.replaceChildren(...nodes);
    state.page = r;
    if (drawerWasOpen && !quiet) closeDrawer({ restoreFocus: false });

    // Le focus : rafraîchissement, ou changement d'onglet / de période depuis une commande qui existe encore → on le rend
    // à la même commande, sans bouger la page ; sinon (nouvel écran, lien vers un autre onglet) → au titre, en haut de page.
    // Les graphiques se dessinent au microtask suivant (il leur faut leur largeur) : on passe après eux, sinon le
    // graphique qu'on lisait au clavier n'existe pas encore et le focus tomberait sur la page.
    queueMicrotask(() => {
      if (seq !== state.seq) return;
      const again = focusKey ? document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`) : null;
      if (quiet || (samePage && !drawerWasOpen && again)) {
        if (again && again !== document.activeElement) again.focus({ preventScroll: true });
        // Commande disparue (sans repère) : le focus revient au titre plutôt qu'au début du document.
        else if (!again && focusInMain && !main.contains(document.activeElement)) main.querySelector('h1')?.focus({ preventScroll: true });
        if (quiet && window.scrollY !== scrollY) window.scrollTo(0, scrollY);
      } else {
        window.scrollTo(0, 0);
        if (!fresh) main.querySelector('h1')?.focus({ preventScroll: true });
      }
    });
  } catch (err) {
    if (seq !== state.seq || err instanceof SessionLost) return;
    if (quiet && main.childElementCount) {
      // Pas de réseau pendant un rafraîchissement : on garde l'écran et on dit de quand datent les chiffres.
      const note = notice('warning', 'state-offline', `Mise à jour impossible pour le moment. Les chiffres affichés datent de ${fmtClock(state.loadedAt)}${NB}; nouvel essai dans une minute.`);
      note.id = 'stale-note';
      note.setAttribute('role', 'status');
      $('stale-note')?.remove();
      main.prepend(note);
    } else {
      disposeCharts();
      document.title = 'Chargement impossible · Suivi des sites';
      main.replaceChildren(
        h('h1', { tabindex: '-1', class: 'sr-only' }, 'Chargement impossible'),
        h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, h('div', { class: 'state-block is-offline', role: 'alert' }, icon('state-offline'), h('div', null, h('p', { class: 'state-title' }, 'Impossible de charger les données pour le moment'), h('p', { class: 'state-detail' }, err.network ? err.message : 'Le portail n’a pas pu répondre. Réessayez dans un instant.'))), h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => route() }, icon('refresh'), 'Réessayer')))),
      );
    }
  } finally {
    if (seq === state.seq) main.classList.remove('is-loading');
  }
}

function stopRefresh() {
  clearInterval(state.timer);
  state.timer = null;
}
function startRefresh() {
  stopRefresh();
  // Les chiffres bougent : on les rafraîchit chaque minute, sans vider l'écran (l'ancien reste jusqu'au nouveau).
  state.timer = setInterval(() => {
    if (document.visibilityState === 'visible' && state.me && !$('app').hidden) route({ quiet: true });
  }, 60_000);
}
document.addEventListener('visibilitychange', () => {
  // Retour sur l'onglet après une longue absence : on ne laisse pas des chiffres vieux de plusieurs minutes.
  if (document.visibilityState === 'visible' && state.me && !$('app').hidden && Date.now() - state.loadedAt > 60_000) route({ quiet: true });
});
window.addEventListener('hashchange', () => route());

// ------------------------------------------------------------------ éléments communs des écrans

const isAdmin = () => state.me?.role === 'admin';

function printButton() {
  return h('button', { type: 'button', class: 'btn btn-ghost btn-sm no-print', 'data-key': 'print', onclick: () => window.print() }, icon('printer'), 'Imprimer');
}

function pageHead({ title, crumb, sub, after }) {
  const head = h(
    'header',
    { class: 'page-head' },
    crumb,
    h('div', { class: 'page-title-row' }, h('h1', { tabindex: '-1', 'data-key': 'page-title' }, title), h('div', { class: 'page-tools' }, h('p', { class: 'updated' }, icon('refresh', 'icon icon-sm'), `Mis à jour à ${fmtClock(Date.now())}`), printButton())),
    sub && h('p', { class: 'page-sub' }, sub),
    after,
  );
  // Signature de l'en-tête sans l'heure de mise à jour : identique, il est gardé tel quel au rafraîchissement (route()).
  const sig = head.cloneNode(true);
  sig.querySelector('.updated')?.remove();
  head.dataset.sig = sig.textContent;
  return head;
}

/**
 * Jauge GAMR d'un site, dans un tableau ou une liste : tube + « 24/60 Élevé », ou « À évaluer » (aucune zone évaluée),
 * ou « Indice non transmis » (le site ne l'envoie pas). Jamais de chiffre inventé.
 */
function riskInline(risk, { stale = false } = {}) {
  const tube = createTube();
  tube.set(risk?.index ?? null);
  // Le texte à côté dit déjà tout : le tube est décoratif ici.
  tube.el.setAttribute('aria-hidden', 'true');
  tube.el.removeAttribute('role');
  tube.el.removeAttribute('aria-label');
  const read =
    risk?.index != null
      ? h('span', { class: 'risk-read' }, h('span', { class: 'risk-num' }, String(risk.index), h('small', null, '/60')), h('span', { class: `level-word lvl-${risk.level}` }, risk.levelLabel))
      : h('span', { class: 'risk-read is-none' }, risk ? 'À évaluer' : 'Indice non transmis');
  return h('div', { class: 'risk-inline' }, tube.el, read, stale && risk?.index != null && h('span', { class: 'risk-stale' }, 'dernier indice connu'));
}

// ------------------------------------------------------------------ vue d'ensemble

/**
 * Du plus préoccupant au plus serein : l'état d'abord ; à état égal, les incidents en cours (un site injoignable dont le
 * dernier état connu est une alarme passe avant les autres), puis les équipements hors service, puis l'indice.
 */
function worstFirst(a, b) {
  return (
    SITE_ORDER[a.status.level] - SITE_ORDER[b.status.level] ||
    (b.openIncidents ?? 0) - (a.openIncidents ?? 0) ||
    (b.devicesDown ?? 0) - (a.devicesDown ?? 0) ||
    (b.risk?.index ?? -1) - (a.risk?.index ?? -1) ||
    a.name.localeCompare(b.name, 'fr')
  );
}

function overviewPage(ov, sites) {
  document.title = 'Vos sites · Suivi des sites';
  if (sites.length === 0) {
    return [pageHead({ title: 'Vos sites' }), emptyBlock('building', 'Aucun site n’est encore rattaché à votre compte.', `Votre prestataire rattache les sites à votre compte${NB}: contactez-le si un site manque.`)];
  }
  const chips = h(
    'ul',
    { class: 'state-row', 'aria-label': 'Vos sites par état' },
    ['alarm', 'unreachable', 'degraded', 'recent', 'unknown', 'ok']
      .filter((level) => ov.counts[level] > 0)
      .map((level) => {
        const st = SITE_STATE[level];
        const n = ov.counts[level];
        return h('li', null, pill(st.pill, st.icon, `${plural(n, 'site', 'sites')} ${st.count[n > 1 ? 1 : 0]}`));
      }),
  );

  const rows = [...sites].sort(worstFirst).map((c) => {
    const href = siteHref(c.id);
    const tr = h(
      'tr',
      { class: `is-clickable is-${(SITE_STATE[c.status.level] ?? SITE_STATE.unknown).tone}` },
      h('th', { scope: 'row', class: 'cell-site' }, h('a', { class: 'site-link', href, 'data-key': `row-${c.id}` }, c.name), isAdmin() && h('span', { class: 'site-org' }, c.organization)),
      h('td', null, h('div', { class: 'state-cell' }, sitePill(c.status), h('span', { class: 'state-detail' }, c.status.detail))),
      h('td', null, riskInline(c.risk, { stale: c.status.level === 'unreachable' })),
      h('td', { class: 'num' }, fmtAvail(c.availability30, c.availability30DownS ?? 0)),
      h('td', null, c.lastReceivedAt ? timeEl(c.lastReceivedAt, relTime(c.lastReceivedAt)) : h('span', { class: 'faint' }, 'Aucun signal reçu')),
    );
    // Toute la ligne s'ouvre au pointeur ; le lien du nom reste la cible au clavier et pour les lecteurs d'écran.
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a, button') || String(window.getSelection?.() ?? '')) return;
      location.hash = href;
    });
    return tr;
  });

  const table = panel(
    { title: 'Tous vos sites', iconName: 'building' },
    h('p', { class: 'panel-note' }, `Du plus préoccupant au plus serein${NB}: l’état d’abord, puis les incidents en cours, puis l’indice de sécurité. Touchez un site pour l’ouvrir.`),
    dataTable([['Site'], ['État'], ['Indice de sécurité'], [`Disponibilité (30${NB}j)`, true], ['Dernier signal']], rows, { caption: 'Vos sites, du plus préoccupant au plus serein' }),
  );
  table.querySelector('table')?.classList.add('sites-table');

  // La fréquence d'envoi se règle sur chaque site : on ne promet pas un chiffre, on dit ce que fait cette page.
  return [pageHead({ title: 'Vos sites', sub: `${plural(sites.length, 'site suivi', 'sites suivis')}. Chaque site envoie ses chiffres régulièrement${NB}; cette page se met à jour toute seule chaque minute.`, after: chips }), table, h('div', { class: 'grid-2' }, monthPanel(ov), exposurePanel(ov, sites))];
}

/** Les 30 derniers jours en phrases : protection, incidents, en cours, prise en charge. */
function monthPanel(ov) {
  const inc = ov.incidents30;
  const line = (iconName, ...text) => h('li', { class: `is-${iconName}` }, icon(iconName), h('p', null, ...text));
  const strong = (t) => h('strong', null, t);
  return panel(
    { title: 'Les 30 derniers jours', iconName: 'history' },
    h(
      'ul',
      { class: 'lines' },
      ov.availability30 === null
        ? line('shield', 'La protection de vos sites n’a pas encore pu être mesurée.')
        : line('shield', 'Vos équipements ont assuré la protection ', strong(`${fmtAvail(ov.availability30, ov.availability30DownS ?? 0)} du temps`), ' (moyenne de vos sites, pondérée par la durée observée).'),
      inc.total === 0
        ? line('bell', 'Aucun incident sur vos sites.')
        : line('bell', strong(plural(inc.total, 'incident', 'incidents')), `${NB}: ${plural(inc.real, 'événement réel', 'événements réels')}, ${plural(inc.falseAlarms, 'fausse alarme', 'fausses alarmes')}${inc.open ? `, ${inc.open} en cours` : ''}.`),
      ov.openNow > 0 ? line('state-alarm', strong(plural(ov.openNow, 'incident encore en cours', 'incidents encore en cours')), `${NB}: à suivre en priorité.`) : line('state-ok', 'Aucun incident en cours.'),
      inc.ackMedianS !== null && line('clock', 'Prise en charge en ', strong(fmtDur(inc.ackMedianS)), ' en général (délai médian entre l’alerte et sa prise en charge).'),
    ),
  );
}

/** Le site le plus exposé (indice GAMR le plus haut), sur le thermomètre de l'affiche. */
function exposurePanel(ov, sites) {
  const risk = ov.risk;
  const title = 'Site le plus exposé';
  if (!risk || risk.scoredSites === 0 || !risk.worst) {
    return panel({ title, iconName: 'gauge' }, emptyBlock('gauge', 'Aucun de vos sites n’a encore d’indice de sécurité.', 'L’indice apparaît quand les zones d’un site ont été évaluées, puis transmises par son système de surveillance.'));
  }
  const w = risk.worst;
  const thermo = createThermometer({ height: 116 });
  thermo.set(w.index);
  const card = sites.find((c) => c.id === w.siteId);
  return panel(
    { title, iconName: 'gauge' },
    h(
      'div',
      { class: 'exposure' },
      h('div', { class: 'exposure-thermo' }, thermo.el),
      h(
        'div',
        { class: 'exposure-text' },
        h('a', { class: 'exposure-site', href: siteHref(w.siteId, 'securite'), 'data-key': 'worst-site' }, w.siteName),
        h('p', { class: 'exposure-value' }, h('span', { class: 'risk-num is-lg' }, String(w.index), h('small', null, '/60')), h('span', { class: `level-word lvl-${w.level}` }, `Niveau ${w.levelLabel.toLowerCase()}`)),
        w.worstZone && h('p', null, `Zone la plus exposée${NB}: `, h('strong', null, w.worstZone)),
        card?.status.level === 'unreachable' && h('p', { class: 'risk-stale' }, `Site injoignable${NB}: dernier indice connu, calculé ${relTime(w.at)}.`),
        h('p', { class: 'hint' }, risk.scoredSites < sites.length ? `Indice connu pour ${risk.scoredSites} de vos ${sites.length} sites.` : 'Indice connu pour tous vos sites.', ' Plus il est bas, mieux le site est protégé.'),
      ),
    ),
  );
}

// ------------------------------------------------------------------ page d'un site

function notFoundPage() {
  document.title = 'Site introuvable · Suivi des sites';
  return [
    pageHead({ title: 'Site introuvable', crumb: state.sites.length > 1 && crumbLink() }),
    emptyBlock('search', 'Ce site est introuvable.', state.sites.length ? 'Vérifiez le lien, ou choisissez un site dans le menu.' : 'Aucun site n’est rattaché à votre compte.'),
  ];
}

function crumbLink() {
  return h('a', { class: 'crumb', href: '#/', 'data-key': 'crumb' }, icon('chevron-left', 'icon icon-sm'), 'Tous les sites');
}

/** Onglets disponibles : un site qui ne mesure encore rien n'a ni disponibilité ni incidents chiffrés à montrer. */
function tabsFor(d) {
  return d.status.level === 'unknown' ? ['synthese', 'securite', 'equipements'] : TAB_IDS;
}

/** Alarme en cours : depuis quand, et si quelqu’un l’a prise en charge (sans avoir à ouvrir l’onglet Incidents). */
function openSince(d) {
  if (d.status.level !== 'alarm') return null;
  const open = d.incidents.filter((i) => i.status !== 'closed');
  if (!open.length) return null;
  const oldest = Math.min(...open.map((i) => i.openedAt));
  const waiting = open.filter((i) => i.status !== 'acknowledged').length;
  const age = fmtDur(Math.max(0, Math.round((Date.now() - oldest) / 1000)));
  const care = waiting === 0 ? 'déjà prise en charge' : waiting === open.length ? 'pas encore prise en charge' : `${waiting} sur ${open.length} sans prise en charge`;
  return `Ouverte depuis ${age}, ${care}.`;
}

function siteBanner(d) {
  const st = SITE_STATE[d.status.level] ?? SITE_STATE.unknown;
  const since = openSince(d);
  return h(
    'section',
    { class: `site-banner is-${st.tone}`, 'aria-label': 'État du site' },
    h('div', { class: `state-block is-${st.tone === 'unknown' ? 'unknown' : st.tone}` }, icon(st.icon), h('div', null, h('p', { class: 'state-title' }, d.status.label), h('p', { class: 'state-detail' }, d.status.detail), since && h('p', { class: 'state-detail' }, since))),
    d.lastReceivedAt && h('p', { class: 'last-signal' }, icon('signal', 'icon icon-sm'), `Dernier signal du site ${relTime(d.lastReceivedAt)}`),
  );
}

function sitePage(d, r) {
  const multi = state.sites.length > 1;
  const available = tabsFor(d);
  const tab = available.includes(r.tab) ? r.tab : 'synthese';
  // Onglet absent pour ce site (rien de mesuré) : l'adresse suit l'onglet réellement affiché, sans nouvel historique.
  if (tab !== r.tab) history.replaceState(null, '', siteHref(d.site.id, tab, r.days));
  const tabInfo = TABS.find((t) => t.id === tab);
  document.title = `${d.site.name} · ${tabInfo.label} · Suivi des sites`;
  const head = pageHead({
    title: d.site.name,
    crumb: multi && crumbLink(),
    sub: isAdmin() && d.site.organization !== d.site.name ? d.site.organization : null,
  });

  // Rien reçu : aucun chiffre. « 0 incident » et « aucun arrêt » se liraient comme une bonne nouvelle alors que rien n'est mesuré.
  // (Un site qui a envoyé un résumé sans aucun équipement passe par les onglets : il peut avoir un indice à montrer.)
  if (d.lastReceivedAt === null) {
    return [
      head,
      siteBanner(d),
      panel({ title: `Et ensuite${NB}?`, iconName: 'info' }, h('p', null, 'Les chiffres, les graphiques, l’indice de sécurité et la liste des équipements apparaîtront ici dès que le système de surveillance de ce site aura envoyé son premier résumé, quelques minutes après sa mise en route ou son redémarrage.')),
    ];
  }

  const tabs = h(
    'nav',
    { class: 'tabs no-print', 'aria-label': 'Rubriques du site' },
    TABS.filter((t) => available.includes(t.id)).map((t) => h('a', { href: siteHref(d.site.id, t.id, r.days), 'aria-current': t.id === tab ? 'page' : null, 'data-key': `tab-${t.id}` }, icon(t.icon), t.label)),
  );
  // La période ne s'affiche que si elle change quelque chose : sur l'onglet Sécurité, elle ne sert qu'à la courbe.
  const period = tabInfo.usesPeriod && !(tab === 'synthese' && d.status.level === 'unknown') && !(tab === 'securite' && !hasTrend(d))
    ? h(
        'div',
        { class: 'period no-print' },
        h('span', { class: 'period-label', id: 'period-label' }, 'Période'),
        h(
          'div',
          { class: 'segmented', role: 'group', 'aria-labelledby': 'period-label' },
          PERIODS.map((n) => h('button', { type: 'button', 'aria-pressed': String(n === r.days), 'data-key': `days-${n}`, onclick: () => (location.hash = siteHref(d.site.id, tab, n)) }, `${n} jours`)),
        ),
      )
    : null;
  const printLine = h('p', { class: 'print-only' }, `${tabInfo.label}${tabInfo.usesPeriod ? ` · ${r.days} derniers jours` : ''} · imprimé le ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date())}`);

  const body = { synthese: tabSynthese, securite: tabSecurite, equipements: tabEquipements, incidents: tabIncidents, disponibilite: tabDisponibilite }[tab](d, r);
  return [
    head,
    siteBanner(d),
    h('div', { class: 'toolbar' }, tabs, period),
    printLine,
    h('div', { class: 'tab-body', id: `tab-${tab}` }, ...[body].flat().filter(Boolean)),
    h('p', { class: 'page-foot' }, icon('clock', 'icon icon-sm'), 'Heures à l’heure locale du site. Les chiffres arrivent à chaque envoi du site, et cette page se met à jour toute seule chaque minute.'),
  ];
}

/** Courbe de l'indice possible : un indice transmis, et au moins une zone évaluée ou un historique. */
function hasTrend(d) {
  return Boolean(d.risk && (d.risk.index !== null || d.riskHistory.length));
}

/** Le site ne répond plus : ce qu'on montre date de son dernier signal (« il y a 4 h »). */
function staleSince(d) {
  return d.status.level === 'unreachable' && d.lastReceivedAt ? relTime(d.lastReceivedAt) : null;
}

/**
 * Incidents ouverts AVANT la période et toujours en cours : le serveur les liste (d.incidents) sans les compter dans
 * les statistiques de la période (d.incidentStats). On les compte ici pour ne jamais écrire « aucun incident » à côté.
 */
function incidentSummary(d) {
  const st = d.incidentStats;
  const openNow = d.incidents.filter((i) => i.status !== 'closed').length;
  const older = Math.max(0, openNow - st.open);
  // Site injoignable : « en cours » vaut au dernier signal, pas maintenant.
  const when = staleSince(d) ? ' au dernier signal' : '';
  const period = st.total
    ? `${plural(st.real, 'événement réel', 'événements réels')}, ${plural(st.falseAlarms, 'fausse alarme', 'fausses alarmes')}${st.open ? `, ${st.open} en cours${when}` : ''}.`
    : '';
  const verb = when ? (older > 1 ? 'étaient encore en cours au dernier signal' : 'était encore en cours au dernier signal') : older > 1 ? 'sont toujours en cours' : 'est toujours en cours';
  const before = older ? `${plural(older, 'incident ouvert', 'incidents ouverts')} avant la période ${verb}.` : '';
  return { st, openNow, older, period, before };
}

/** Durée réelle d'arrêt du système du site sur la période (périodes connues : 35 derniers jours au plus). */
function blindSeconds(d, r) {
  const since = Date.now() - r.days * DAY_MS;
  return Math.round(d.blindPeriods.reduce((sum, b) => sum + Math.max(0, b.to - Math.max(b.from, since)), 0) / 1000);
}

function periodTitle(d, r) {
  const first = d.daily[0]?.day;
  return d.daily.length < r.days && first ? `Depuis le ${fmtDayText(first)}` : `Sur les ${r.days} derniers jours`;
}

/** Anneau GAMR avec son niveau, pour la synthèse. */
function riskSummary(d) {
  const risk = d.risk;
  const ring = createRing({ size: 168, caption: 'Indice de sécurité du site' });
  ring.set(risk?.index ?? null);
  const link = h('a', { class: 'btn btn-sm', href: siteHref(d.site.id, 'securite', d.days), 'data-key': 'go-securite' }, 'Comprendre l’indice', icon('chevron-right'));
  let text;
  if (!risk) text = [h('p', { class: 'level-big lvl-text-none' }, 'Non transmis'), h('p', null, 'Ce site n’envoie pas encore son indice de sécurité (PSIM à mettre à jour).')];
  else if (risk.index === null) text = [h('p', { class: 'level-big lvl-text-none' }, 'À évaluer'), h('p', null, 'Aucune zone n’est encore évaluée sur ce site.')];
  else
    text = [
      h('p', { class: `level-big lvl-text-${risk.level}` }, `Niveau ${risk.levelLabel.toLowerCase()}`),
      risk.worstZone && h('p', null, `Zone la plus exposée${NB}: `, h('strong', null, risk.worstZone)),
      d.status.level === 'unreachable' && h('p', { class: 'risk-stale' }, `Dernier indice connu${NB}: le site ne répond plus.`),
    ];
  return panel({ title: 'Indice de sécurité', iconName: 'gauge' }, h('div', { class: 'risk-summary' }, ring.el, h('div', { class: 'risk-summary-text' }, ...text, link)));
}

// ---- onglet Synthèse

function tabSynthese(d, r) {
  const monitored = d.devices.filter((x) => x.monitored);
  const down = monitored.filter((x) => x.status === 'fault' || x.status === 'offline');
  // Site injoignable : l'état des équipements est celui du dernier signal. On l'écrit au passé et daté, jamais au présent.
  const since = staleSince(d);
  let equipNote;
  if (d.devices.length === 0) equipNote = 'Le site est relié au portail, mais aucun équipement n’y est encore déclaré.';
  else if (monitored.length === 0) equipNote = `Aucun n’est encore mesuré${NB}: rien ne permet de dire qu’ils fonctionnent.`;
  else if (since) {
    equipNote = down.length
      ? `Au dernier signal du site (${since}), ${down.length} hors service sur ${monitored.length} suivis. Leur état actuel n’est pas connu.`
      : `Au dernier signal du site (${since}), les ${monitored.length} équipements suivis répondaient. Leur état actuel n’est pas connu.`;
  } else equipNote = down.length ? `${plural(down.length, 'hors service', 'hors service')} sur ${monitored.length} suivis.` : `Les ${monitored.length} équipements suivis répondent.`;
  const equipment = ['Équipements', d.devices.length ? plural(d.devices.length, 'équipement', 'équipements') : 'Aucun déclaré', equipNote];
  if (d.status.level === 'unknown') {
    return h('div', { class: 'grid-2' }, panel({ title: 'En bref', iconName: 'list' }, facts([equipment]), notice('info', 'info', 'La disponibilité et le temps d’arrêt apparaîtront quand l’état des équipements sera mesuré.')), riskSummary(d));
  }
  const a = d.availability;
  const inc = incidentSummary(d);
  const st = inc.st;
  const blindS = blindSeconds(d, r);
  const protectionNote = [
    'Part du temps où les équipements suivis étaient en état de détecter.',
    a.unmonitoredS > 0 && (blindS ? `Les arrêts du système du site (${fmtDur(blindS)} au total) ne sont pas comptés.` : 'Les arrêts du système du site ne sont pas comptés.'),
    since && `Mesurée jusqu’au dernier signal du site (${since}).`,
  ];
  const list = facts([
    ['Protection assurée', a.pct === null ? 'Pas encore mesurée' : `${fmtAvail(a.pct, a.downS)} du temps`, protectionNote.filter(Boolean).join(' ')],
    ['Temps d’arrêt cumulé', a.downS ? fmtDur(a.downS) : 'Aucun', `${plural(d.outages.length, 'panne d’équipement', 'pannes d’équipement')}${a.downS ? ', durées additionnées équipement par équipement' : ''}.`],
    [
      'Incidents',
      st.total ? plural(st.total, 'incident', 'incidents') : inc.older ? 'Aucun nouveau' : 'Aucun',
      [inc.period, inc.before].filter(Boolean).join(' ') || (since ? 'Aucune alarme connue sur la période, jusqu’au dernier signal du site.' : 'Aucune alarme sur la période.'),
    ],
    ['Prise en charge', st.ackMedianS === null ? 'Rien à mesurer' : fmtDur(st.ackMedianS), 'Délai médian entre l’alerte et sa prise en charge.'],
    equipment,
  ]);
  return [
    h('div', { class: 'grid-2' }, panel({ title: periodTitle(d, r), iconName: 'list' }, list), riskSummary(d)),
    downtimeChart(d.daily, { prefs: state.prefs, title: 'Arrêts par jour', stale: Boolean(since), blind: { periods: d.blindPeriods, offsetMin: d.utcOffsetMin } }),
  ];
}

// ---- onglet Sécurité

/** L'échelle de 1 à 60 (l'axe part de 0) : un grand tube à la valeur du site, les seuils, les quatre niveaux nommés. */
function scaleExplainer(risk) {
  const tube = createTube({ label: 'Indice du site' });
  tube.set(risk?.index ?? null);
  tube.el.classList.add('is-lg');
  const ranges = { faible: 'de 1 à 8', modere: 'de 9 à 20', eleve: 'de 21 à 36', critique: 'de 37 à 60' };
  return h(
    'div',
    { class: 'scale' },
    tube.el,
    h('div', { class: 'scale-ticks', 'aria-hidden': 'true' }, [0, 8, 20, 36, 60].map((v) => h('span', null, String(v)))),
    h('ol', { class: 'scale-bands', 'aria-label': 'Les quatre niveaux' }, BANDS.map((b) => h('li', { class: `band-${b.level}` }, h('span', { class: `level-word lvl-${b.level}` }, b.label), h('span', { class: 'scale-range' }, ranges[b.level])))),
  );
}

function tabSecurite(d, r) {
  const risk = d.risk;
  const off = d.utcOffsetMin;
  const unreachable = d.status.level === 'unreachable';
  const ring = createRing({ size: 200, caption: 'Indice de sécurité du site' });
  ring.set(risk?.index ?? null);

  const text = [h('h2', null, 'Indice de sécurité du site')];
  if (!risk) {
    text.push(h('p', { class: 'level-big lvl-text-none' }, 'Non transmis'), notice('info', 'info', 'Ce site n’envoie pas encore son indice de sécurité (PSIM à mettre à jour).'));
  } else if (risk.index === null) {
    text.push(h('p', { class: 'level-big lvl-text-none' }, 'À évaluer'), h('p', null, 'Aucune zone n’est encore évaluée sur ce site.'), h('p', { class: 'hint' }, `${plural(risk.totalZones, 'zone', 'zones')} à évaluer. L’indice apparaîtra dès que la première zone sera évaluée.`));
  } else {
    text.push(
      h('p', { class: `level-big lvl-text-${risk.level}` }, `Niveau ${risk.levelLabel.toLowerCase()}`),
      risk.worstZone && h('p', null, `Zone la plus exposée${NB}: `, h('strong', null, risk.worstZone)),
      h('p', null, `${plural(risk.assessedZones, 'zone évaluée', 'zones évaluées')} sur ${risk.totalZones}.`),
    );
    if (risk.assessedZones < risk.totalZones) {
      const missing = risk.totalZones - risk.assessedZones;
      text.push(notice('warning', 'state-warning', `${plural(missing, 'zone n’est', 'zones ne sont')} pas encore ${missing > 1 ? 'évaluées' : 'évaluée'}${NB}: l’indice ne tient compte que des zones évaluées.`));
    }
    const stale = d.riskZones.filter((z) => z.stale).length;
    if (stale) text.push(notice('warning', 'clock', `${plural(stale, 'évaluation date', 'évaluations datent')} de plus d’un an${NB}: ${stale > 1 ? 'elles sont' : 'elle est'} à revoir.`));
  }
  if (risk) text.push(h('p', { class: 'risk-at' }, icon('clock', 'icon icon-sm'), h('span', null, 'Calculé le ', timeEl(risk.at, fmtDateTime(risk.at, off))), unreachable && risk.index !== null && h('span', { class: 'tag is-dashed' }, 'dernier indice connu')));
  if (unreachable && risk) text.push(notice('warning', 'state-offline', risk.index !== null ? `Le site ne répond plus${NB}: voici le dernier indice connu. Il a pu changer depuis.` : `Le site ne répond plus${NB}: ces informations datent de son dernier signal.`));

  // Le panneau est le conteneur mesuré (portal.css) : sa grille intérieure passe en une colonne quand il est étroit.
  const hero = h('section', { class: 'panel risk-hero', 'aria-label': 'Indice de sécurité du site' }, h('div', { class: 'risk-hero-body' }, h('div', { class: 'risk-hero-ring' }, ring.el), h('div', { class: 'risk-hero-text' }, ...text)));

  const explain = panel(
    { title: 'Comment lire l’indice', iconName: 'info' },
    scaleExplainer(risk),
    h('p', null, 'L’indice va de 1 à 60. ', h('strong', null, 'Plus il est bas, mieux le site est protégé.')),
    h('p', null, `Chaque zone du site reçoit trois notes, multipliées entre elles${NB}:`),
    h(
      'ul',
      { class: 'formula' },
      h('li', null, h('strong', null, 'la probabilité'), ` qu’un départ de feu s’y produise, de 1 à 3${NB};`),
      h('li', null, h('strong', null, 'la vulnérabilité'), `, ce qui la protège mal, de 1 à 4${NB};`),
      h('li', null, h('strong', null, 'les répercussions'), ' qu’aurait un sinistre, de 1 à 5.'),
    ),
    h('p', { class: 'hint' }, 'L’indice du site est celui de sa zone la plus exposée. Il suit l’état réel des équipements : un détecteur hors service ou une zone sans caméra rend la zone plus vulnérable.'),
  );

  const zones = d.riskZones.length
    ? panel(
        { title: 'Risque par zone', iconName: 'pin' },
        h('p', { class: 'panel-note' }, 'De la zone la plus exposée à la moins exposée.'),
        h(
          'ul',
          { class: 'zone-list' },
          d.riskZones.map((z) => {
            const tube = createTube();
            tube.set(z.index);
            tube.el.setAttribute('aria-hidden', 'true');
            tube.el.removeAttribute('role');
            tube.el.removeAttribute('aria-label');
            return h(
              'li',
              { class: 'zone-row' },
              h('span', { class: 'zone-name' }, z.zone),
              tube.el,
              z.index === null ? h('span', { class: 'risk-read is-none' }, 'À évaluer') : h('span', { class: 'risk-read' }, h('span', { class: 'risk-num' }, String(z.index), h('small', null, '/60')), h('span', { class: `level-word lvl-${z.level}` }, z.levelLabel)),
              z.stale ? h('span', { class: 'tag is-warning', title: `Évaluation de plus d’un an${NB}: à revoir.` }, icon('clock', 'icon icon-sm'), 'À revoir') : h('span', { class: 'zone-tag-slot' }),
            );
          }),
        ),
      )
    : null;

  // Sans aucune zone évaluée ni historique, une courbe « à venir » n'apprendrait rien : la liste des zones suffit.
  const trend = hasTrend(d) ? riskTrend(d.riskHistory, { prefs: state.prefs, days: r.days }) : null;
  return [h('div', { class: 'grid-2 is-even is-stretch' }, hero, explain), (zones || trend) && h('div', { class: 'grid-2 is-even' }, zones, trend)];
}

// ---- onglet Équipements

/** « 10 en service, 1 en défaut, 5 non mesurés » : les mots du décompte, au singulier et au pluriel. */
const COUNT_WORD = {
  normal: ['en service', 'en service'],
  alarm: ['en alarme', 'en alarme'],
  prealarm: ['en préalarme', 'en préalarme'],
  fault: ['en défaut', 'en défaut'],
  offline: ['ne répond plus', 'ne répondent plus'],
  unmonitored: ['non mesuré', 'non mesurés'],
};

function tabEquipements(d) {
  const avail = new Map(d.deviceAvailability.map((a) => [a.deviceId, a]));
  const key = (x) => (x.monitored ? x.status : 'unmonitored');
  const devices = [...d.devices].sort((a, b) => (DEVICE_ORDER[key(a)] ?? 5) - (DEVICE_ORDER[key(b)] ?? 5) || a.name.localeCompare(b.name, 'fr'));
  const counts = {};
  for (const x of devices) counts[key(x)] = (counts[key(x)] ?? 0) + 1;
  const parts = ['normal', 'alarm', 'prealarm', 'fault', 'offline', 'unmonitored'].filter((k) => counts[k]).map((k) => `${counts[k]} ${COUNT_WORD[k][counts[k] > 1 ? 1 : 0]}`);
  const rows = devices.map((x) => {
    const cat = x.kind === 'camera' ? { label: 'Caméra', icon: 'camera' } : (CATEGORY[x.category] ?? { label: x.category, icon: 'info' });
    const a = avail.get(x.id);
    return h(
      'tr',
      null,
      h('th', { scope: 'row' }, x.name),
      h('td', null, h('span', { class: 'with-icon' }, icon(cat.icon, 'icon icon-sm'), cat.label)),
      h('td', null, [x.zone, x.floor].filter(Boolean).join(' · ') || '—'),
      h('td', null, devicePill(x)),
      h('td', { class: 'num' }, x.monitored && a ? fmtAvail(a.pct, a.downS) : '—'),
    );
  });
  // Site injoignable : ces états sont ceux du dernier signal ; on le dit avant la liste, et dans la phrase d'introduction.
  const since = staleSince(d);
  const lead = since
    ? `${plural(d.devices.length, 'équipement déclaré', 'équipements déclarés')}. Au dernier signal du site (${since})${NB}: ${parts.join(', ')}.`
    : `${plural(d.devices.length, 'équipement déclaré', 'équipements déclarés')}${NB}: ${parts.join(', ')}. Les équipements à surveiller en premier sont en tête.`;
  return [
    panel(
      { title: 'Équipements', iconName: 'signal' },
      since && d.devices.length > 0 && notice('warning', 'state-offline', `Site injoignable${NB}: ces états datent de son dernier signal (${since}). L’état actuel des équipements n’est pas connu.`),
      d.devices.length > 0 && h('p', { class: 'lead' }, lead),
      dataTable([['Équipement'], ['Type'], ['Emplacement'], ['État'], ['Disponibilité (35 j)', true]], rows, { empty: 'Aucun équipement déclaré sur ce site.', caption: 'Équipements du site' }),
      cameraNote(d.devices),
    ),
  ];
}

/** Ce que veut dire l'état d'une caméra, et pourquoi certaines n'ont pas de chiffre. */
function cameraNote(devices) {
  const cameras = devices.filter((x) => x.kind === 'camera');
  if (cameras.length === 0) return null;
  const notes = [];
  if (cameras.some((x) => x.monitored)) notes.push(`Pour une caméra, «${NB}En service${NB}» veut dire que l’appareil répond sur le réseau (vérifié régulièrement)${NB}; cela ne garantit pas que l’image est nette ou bien cadrée.`);
  if (cameras.some((x) => !x.monitored)) notes.push(`Les caméras «${NB}Non mesuré${NB}» ne sont pas encore testées${NB}: aucun pourcentage n’est annoncé pour elles.`);
  return notice(null, 'camera', notes.join(' '));
}

// ---- onglet Incidents

function incidentState(i) {
  if (i.status === 'closed') return pill('is-ok', 'check', 'Clos');
  if (i.status === 'acknowledged') return pill('is-warning', 'clock', 'Pris en charge');
  return i.severity === 'critical' ? pill('is-solid-alarm', 'state-alarm', 'Ouvert') : pill('is-solid-warning', 'state-warning', 'Ouvert');
}

function tabIncidents(d, r) {
  const off = d.utcOffsetMin;
  const inc = incidentSummary(d);
  const st = inc.st;
  const rows = d.incidents.map((i) => {
    const cat = CATEGORY[i.category] ?? { label: i.category, icon: 'info' };
    const q = qualificationLabel(i.category, i.qualification);
    return h(
      'tr',
      null,
      h('td', null, timeEl(i.openedAt, fmtDateTime(i.openedAt, off))),
      h('th', { scope: 'row' }, i.deviceName, i.zone && h('span', { class: 'cell-sub' }, i.zone)),
      h('td', null, h('span', { class: 'with-icon' }, icon(cat.icon, 'icon icon-sm'), cat.label)),
      h('td', null, incidentState(i)),
      h('td', null, q ? h('span', { class: `tag${i.qualification === 'fire' ? ' is-alarm' : ''}` }, q) : h('span', { class: 'faint' }, '—')),
      h('td', { class: 'num' }, i.ackedAt ? fmtDur(Math.round((i.ackedAt - i.openedAt) / 1000)) : '—'),
    );
  });
  // Sans aucune ligne, le bloc vide dit tout : pas de phrase d'introduction qui le répéterait.
  const summary = !rows.length
    ? null
    : st.total > 0
      ? [`${plural(st.total, 'incident', 'incidents')} sur la période${NB}: ${inc.period}`, inc.before].filter(Boolean).join(' ')
      : `Aucun nouvel incident sur cette période${NB}; ${inc.before.charAt(0).toLowerCase()}${inc.before.slice(1)}`;
  const windowNote = r.days > 35 ? ` Historique transmis${NB}: 35 derniers jours au plus.` : '';
  const delays = [st.ackMedianS !== null && `prise en charge en ${fmtDur(st.ackMedianS)}`, st.closeMedianS !== null && `clôture en ${fmtDur(st.closeMedianS)}`].filter(Boolean);
  const n = d.notifications;
  return [
    panel(
      { title: 'Incidents', iconName: 'bell' },
      summary && h('p', { class: 'lead' }, summary, delays.length ? ` En général (délai médian)${NB}: ${delays.join(', ')}.` : '', windowNote),
      dataTable([['Ouverture'], ['Équipement'], ['Type'], ['État'], ['Conclusion'], ['Prise en charge', true]], rows, {
        empty: [staleSince(d) ? 'Aucun incident connu sur cette période.' : 'Aucun incident sur cette période.', 'Les alarmes de ce site apparaîtront ici, avec leur prise en charge et leur conclusion.'],
        caption: 'Incidents du site',
      }),
      // Envoyés et en échec sont deux comptes distincts (un message en échec n'est pas compté parmi les envoyés).
      n && h('p', { class: 'panel-note' }, `Messages d’alerte aux personnes prévenues, sur les 35 derniers jours${NB}: ${plural(n.sent, 'envoyé', 'envoyés')}${n.failed ? `, ${n.failed} en échec` : ''}.`),
    ),
  ];
}

// ---- onglet Disponibilité

function tabDisponibilite(d, r) {
  const off = d.utcOffsetMin;
  const a = d.availability;
  const first = d.daily[0]?.day;
  const since = Date.now() - r.days * DAY_MS;
  const blind = d.blindPeriods.filter((b) => b.to >= since);
  const staleAt = staleSince(d);
  // Les périodes d'arrêt du système ne sont transmises que pour les 35 derniers jours (fenêtre de l'instantané du site).
  const beyondWindow = r.days > 35;
  const blindS = blindSeconds(d, r);
  let blindFact;
  if (!a.unmonitoredS) blindFact = ['Surveillance interrompue', 'Jamais', staleAt ? `Le système du site a fonctionné sans interruption, jusqu’à son dernier signal (${staleAt}).` : 'Le système du site a fonctionné sans interruption.'];
  else
    blindFact = [
      'Surveillance interrompue',
      blindS ? fmtDur(blindS) : 'Durée non connue',
      `Le système du site était arrêté${NB}: rien n’était surveillé. Ce temps ne compte ni comme disponible, ni comme en panne.${beyondWindow ? ' Durée connue sur les 35 derniers jours seulement.' : ''}`,
    ];
  const list = facts([
    ['Protection assurée', a.pct === null ? 'Pas encore mesurée' : `${fmtAvail(a.pct, a.downS)} du temps`, `Temps où les équipements suivis étaient en service, divisé par le temps observé.${staleAt ? ` Mesurée jusqu’au dernier signal du site (${staleAt}).` : ''}`],
    ['Temps d’arrêt cumulé', a.downS ? fmtDur(a.downS) : 'Aucun', `${plural(d.outages.length, 'panne d’équipement', 'pannes d’équipement')}${a.downS ? ', durées additionnées équipement par équipement' : ''}.`],
    blindFact,
    d.daily.length < r.days && first && ['Mesures disponibles', `depuis le ${fmtDayText(first)}`, 'Aucun jour manquant n’est inventé.'],
  ]);

  const zoneRows = d.zones.map((z) => h('tr', null, h('th', { scope: 'row' }, z.zone || 'Hors zone'), h('td', { class: 'num' }, String(z.devices)), h('td', { class: 'num' }, fmtAvail(z.pct, z.downS)), h('td', { class: 'num' }, z.downS ? fmtDur(z.downS) : '0')));
  const outageRows = d.outages.map((o) =>
    h(
      'tr',
      null,
      h('th', { scope: 'row' }, o.deviceName),
      h('td', null, o.zone || '—'),
      h('td', null, timeEl(o.from, fmtDateTime(o.from, off))),
      h('td', { class: 'num' }, fmtDur(o.durationS)),
      h('td', null, o.to === null ? pill('is-fault', 'wrench', 'En cours') : h('span', { class: 'with-icon' }, icon(o.cause === 'fault' ? 'wrench' : 'state-offline', 'icon icon-sm'), o.cause === 'fault' ? 'Défaut signalé' : 'Ne répondait plus')),
    ),
  );
  const blindRows = [...blind].reverse().map((b) => h('tr', null, h('td', null, timeEl(b.from, fmtDateTime(b.from, off))), h('td', null, timeEl(b.to, fmtDateTime(b.to, off))), h('td', { class: 'num' }, fmtDur(Math.round((b.to - b.from) / 1000)))));

  // Zones et pannes l'une sous l'autre : côte à côte, leurs tableaux (4 et 5 colonnes) débordaient de leur demi-panneau.
  return [
    panel({ title: periodTitle(d, r), iconName: 'list' }, list),
    downtimeChart(d.daily, { prefs: state.prefs, stale: Boolean(staleAt), blind: { periods: d.blindPeriods, offsetMin: off } }),
    panel({ title: 'Pannes d’équipement', iconName: 'wrench' }, dataTable([['Équipement'], ['Zone'], ['Début'], ['Durée', true], ['Cause']], outageRows, { empty: 'Aucune panne sur cette période.', caption: 'Pannes d’équipement' })),
    panel({ title: 'Zones', iconName: 'pin' }, h('p', { class: 'panel-note' }, 'Sur les 35 derniers jours.'), dataTable([['Zone'], ['Équipements', true], ['Disponibilité', true], ['Arrêt cumulé', true]], zoneRows, { empty: 'Aucune zone déclarée.', caption: 'Disponibilité par zone' })),
    panel(
      { title: 'Surveillance interrompue', iconName: 'state-offline' },
      h('p', { class: 'panel-note' }, `Périodes où le système de surveillance du site était arrêté${NB}: rien n’y était surveillé. Sur les 35 derniers jours au plus.`),
      dataTable([['Du'], ['Au'], ['Durée', true]], blindRows, {
        empty: beyondWindow ? 'Aucune interruption sur les 35 derniers jours (au-delà, pas de relevé).' : 'Aucune interruption sur cette période.',
        caption: 'Surveillance interrompue',
      }),
    ),
  ];
}

// ------------------------------------------------------------------ démarrage

(async () => {
  try {
    state.me = await api('/api/me');
    if (state.me.mustChangePassword) showPassword(true);
    else enterApp({ fresh: true });
  } catch (err) {
    if (!(err instanceof SessionLost)) showLogin(err.network ? err.message : undefined);
  }
})();
