/**
 * Portail de suivi : petits outils partagés par les écrans (construction du DOM, icônes, dates, durées, états).
 *
 * Tout texte venu des sites (noms, zones, équipements) passe par textContent (fonction h) : jamais d'HTML injecté.
 * Aucune valeur de style dans le HTML : la politique de sécurité l'interdit ; les valeurs dynamiques passent par le CSSOM.
 */

export const $ = (id) => document.getElementById(id);

/** Élément HTML : `h('a', { class, href, onclick }, enfants…)`. Les valeurs false / null / undefined sont ignorées. */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Élément SVG (graphiques). */
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Icône du sprite (icons.svg) : décorative, le mot qui l'accompagne porte le sens. */
export function icon(name, cls = 'icon') {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('class', cls);
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `icons.svg#${name}`);
  el.append(use);
  return el;
}

// ------------------------------------------------------------------ nombres, durées, dates

/** Espace insécable : avant « : ; ! ? % » en typographie française. */
export const NB = ' ';

export const nf = (n, max = 2, min = 0) => n.toLocaleString('fr-FR', { minimumFractionDigits: min, maximumFractionDigits: max });
export const fmtPct = (p) => (p === null || p === undefined ? '—' : `${nf(p, 2, 1)}${NB}%`);
/**
 * Disponibilité : le serveur arrondit au centième (99,996 devient 100). « 100 % » à côté d'une panne serait une
 * contradiction ; avec un temps d'arrêt, on écrit « plus de 99,99 % ».
 */
export const fmtAvail = (p, downS) => (p === 100 && downS > 0 ? `plus de 99,99${NB}%` : fmtPct(p));
export const plural = (n, one, many) => `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`;

/** « 45 s », « 12 min », « 3 h 05 », « 2 j 4 h » : une durée lisible, arrondie. */
export function fmtDur(sec) {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return `${sec}${NB}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}${NB}min`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  if (hours < 48) return rest ? `${hours}${NB}h${NB}${String(rest).padStart(2, '0')}` : `${hours}${NB}h`;
  return `${Math.floor(hours / 24)}${NB}j ${hours % 24}${NB}h`;
}

export function relTime(ms) {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (min < 1) return 'à l’instant';
  if (min < 60) return `il y a ${min}${NB}min`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `il y a ${hours}${NB}h`;
  return `il y a ${Math.round(hours / 24)} jours`;
}

/** Heure LOCALE DU SITE (le portail reçoit le décalage horaire du site avec chaque résumé). */
export function fmtDateTime(ms, offsetMin = 0) {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms + offsetMin * 60_000));
}

/** Heure du navigateur (« mis à jour à 14:05 »). */
export const fmtClock = (ms) => new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

const dayDate = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
export const dayTime = (day) => dayDate(day).getTime();

/** « 5 oct. » ou « dimanche 5 octobre » pour un jour « AAAA-MM-JJ » (jour local du site). */
export function fmtDay(day, long = false) {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: long ? 'long' : undefined, day: 'numeric', month: long ? 'long' : 'short' }).format(dayDate(day));
}
/** « 6 septembre », « 1er octobre » : dans une phrase (pas d'abréviation qui ferait « sept.. »). */
export function fmtDayText(day) {
  const text = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(dayDate(day));
  return text.replace(/^1 /, '1er ');
}
export const shortDay = (day) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

/** Balise <time> : chiffres alignés, date lisible par les machines. */
export const timeEl = (ms, text) => h('time', { datetime: new Date(ms).toISOString() }, text);

// ------------------------------------------------------------------ états : forme + icône + mot

/** État d'un site (niveau calculé par le serveur) : classe de pastille, icône, mot pour les compteurs. */
export const SITE_STATE = {
  alarm: { pill: 'is-solid-alarm', tone: 'alarm', icon: 'state-alarm', count: ['en alarme', 'en alarme'] },
  unreachable: { pill: 'is-offline', tone: 'offline', icon: 'state-offline', count: ['injoignable', 'injoignables'] },
  degraded: { pill: 'is-fault', tone: 'fault', icon: 'wrench', count: ['à surveiller', 'à surveiller'] },
  // « Sans mesure » vaut pour les deux cas de cet état : rien reçu, ou reçu sans aucun équipement mesuré.
  unknown: { pill: 'is-dashed is-unknown', tone: 'unknown', icon: 'state-unknown', count: ['sans mesure', 'sans mesure'] },
  ok: { pill: 'is-ok', tone: 'ok', icon: 'state-ok', count: ['en bon état', 'en bon état'] },
};
export const SITE_ORDER = { alarm: 0, unreachable: 1, degraded: 2, unknown: 3, ok: 4 };

export const DEVICE_STATE = {
  normal: { pill: 'is-ok', icon: 'state-ok', word: 'En service', help: 'Fonctionne et surveille sa zone.' },
  prealarm: { pill: 'is-warning', icon: 'state-warning', word: 'Préalarme', help: 'Mesure inhabituelle, pas encore une alarme.' },
  alarm: { pill: 'is-solid-alarm', icon: 'state-alarm', word: 'Alarme', help: 'Cet équipement signale une alarme.' },
  fault: { pill: 'is-fault', icon: 'wrench', word: 'En défaut', help: 'L’équipement signale une panne : sa zone n’est plus surveillée par lui.' },
  offline: { pill: 'is-offline', icon: 'state-offline', word: 'Ne répond plus', help: 'Ne répond plus : cet équipement ne surveille plus sa zone.' },
  unmonitored: { pill: 'is-dashed is-unknown', icon: 'state-unknown', word: 'Non mesuré', help: 'L’état de cet équipement n’est pas encore mesuré : aucun chiffre n’est annoncé.' },
};
export const DEVICE_ORDER = { alarm: 0, fault: 1, offline: 1, prealarm: 2, normal: 3, unmonitored: 4 };

export const CATEGORY = {
  fire: { label: 'Incendie', icon: 'fire' },
  intrusion: { label: 'Intrusion', icon: 'intrusion' },
  access: { label: 'Contrôle d’accès', icon: 'door' },
  environment: { label: 'Environnement', icon: 'drop' },
};

/** La qualification « fire » veut dire « événement réel » pour toutes les catégories (mêmes mots que le PSIM). */
const REAL_LABEL = { fire: 'Feu confirmé', intrusion: 'Intrusion avérée', access: 'Accès anormal avéré', environment: 'Incident avéré' };
export function qualificationLabel(category, qualification) {
  if (qualification === 'false_alarm') return 'Fausse alarme';
  if (qualification === 'fire') return REAL_LABEL[category] ?? REAL_LABEL.fire;
  return '';
}

export const ROLE = { admin: 'Prestataire', director: 'Direction', site_manager: 'Responsable de site' };

/** Pastille d'état : icône + mot, jamais la couleur seule. */
export function pill(cls, iconName, text, title) {
  return h('span', { class: `pill ${cls}`, title }, icon(iconName), text);
}

export function sitePill(status) {
  const st = SITE_STATE[status.level] ?? SITE_STATE.unknown;
  return pill(st.pill, st.icon, status.label);
}

export function devicePill(device) {
  const st = !device.monitored ? DEVICE_STATE.unmonitored : (DEVICE_STATE[device.status] ?? DEVICE_STATE.unmonitored);
  return pill(st.pill, st.icon, st.word, st.help);
}

// ------------------------------------------------------------------ blocs communs

/**
 * Tableau de données. `head` : [[titre, numérique?], …] ; chaque ligne est un <tr>. Sur téléphone, `stacked` le replie
 * en fiches (une ligne = une fiche, chaque cellule précédée de son en-tête) : les rôles ARIA gardent la lecture de tableau.
 */
export function dataTable(head, rows, { empty, stacked = true, caption } = {}) {
  // `empty` : une phrase, ou [phrase, explication] pour un vide qui apprend quelque chose.
  if (rows.length === 0) return emptyBlock('info', ...[empty ?? 'Rien à afficher.'].flat());
  const table = h(
    'table',
    { class: `data${stacked ? ' is-stacked' : ''}` },
    caption && h('caption', { class: 'sr-only' }, caption),
    h('thead', null, h('tr', null, head.map(([t, num]) => h('th', { class: num ? 'num' : null, scope: 'col' }, t)))),
    h('tbody', null, rows),
  );
  if (stacked) {
    table.setAttribute('role', 'table');
    for (const g of table.querySelectorAll('thead, tbody')) g.setAttribute('role', 'rowgroup');
    for (const tr of table.querySelectorAll('tr')) {
      tr.setAttribute('role', 'row');
      [...tr.children].forEach((cell, i) => {
        const isHead = cell.tagName === 'TH';
        cell.setAttribute('role', isHead ? (tr.parentElement.tagName === 'THEAD' ? 'columnheader' : 'rowheader') : 'cell');
        if (tr.parentElement.tagName === 'TBODY' && head[i]) cell.setAttribute('data-label', head[i][0]);
      });
    }
  }
  return h('div', { class: 'table-scroll' }, table);
}

/** Vide qui apprend : ce qui manque, et comment l'obtenir. */
export function emptyBlock(iconName, title, text) {
  return h('div', { class: 'empty' }, icon(iconName), h('strong', null, title), text && h('p', null, text));
}

export function notice(kind, iconName, ...content) {
  return h('div', { class: `notice${kind ? ` is-${kind}` : ''}` }, icon(iconName), h('div', null, ...content));
}

/** Panneau : titre (h2) avec icône facultative, actions à droite, corps. */
export function panel({ title, iconName, actions, cls, id, label } = {}, ...body) {
  const titleId = id ? `${id}-title` : undefined;
  return h(
    'section',
    { class: `panel${cls ? ` ${cls}` : ''}`, id, 'aria-labelledby': titleId, 'aria-label': titleId ? undefined : label },
    title && h('div', { class: 'panel-head' }, h('h2', { id: titleId }, iconName && icon(iconName), title), actions && h('div', { class: 'actions' }, actions)),
    h('div', { class: 'panel-body' }, ...body),
  );
}

/** Liste de faits lisible (<dl> en grille) : un libellé, une valeur, une phrase qui l'explique. */
export function facts(items) {
  return h(
    'dl',
    { class: 'facts' },
    items.filter(Boolean).map(([term, value, note]) => h('div', { class: 'fact' }, h('dt', null, term), h('dd', { class: 'fact-value' }, value), note && h('dd', { class: 'fact-note' }, note))),
  );
}
