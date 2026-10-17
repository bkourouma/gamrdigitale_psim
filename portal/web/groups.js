/**
 * Portail : le niveau « groupe » (organisation → groupes → sous-groupes → sites). Les écrans de direction, le fil d'Ariane et
 * l'arbre du menu. Rien n'est calculé ici : les chiffres (états, disponibilité, indice, incidents) viennent du serveur, qui
 * ne les calcule que sur les sites que le compte a le droit de voir. Cette page ne fait que les montrer, en langage courant,
 * et dit toujours sur combien de sites ils reposent : jamais « tout va bien » faute de savoir.
 *
 * Les fonctions reçoivent `ctx` (état de l'application et quelques outils de app.js) pour ne pas dépendre de lui.
 */
import { h, icon, NB, nf, fmtAvail, fmtDur, relTime, plural, timeEl, SITE_STATE, CATEGORY, pill, dataTable, emptyBlock, panel } from './ui.js';
import { createTube, createThermometer } from './gauge.js';

export const groupHref = (id) => `#/group/${id}`;
export const orgHref = (id, multiOrg) => (multiOrg ? `#/org/${id}` : '#/');

const LEVELS = ['alarm', 'unreachable', 'degraded', 'recent', 'unknown', 'ok'];

// Ce qu'on appelle un incident ouvert, par catégorie (mêmes mots que l'état d'un site côté serveur).
const OPEN_WORD = {
  fire: ['incendie', 'incendies'],
  intrusion: ['intrusion', 'intrusions'],
  access: ['alerte d’accès', 'alertes d’accès'],
  environment: ['alerte environnement', 'alertes environnement'],
  energy: ['alerte énergie', 'alertes énergie'],
  people: ['alerte personne', 'alertes personne'],
};
const CATEGORY_ORDER = ['fire', 'intrusion', 'access', 'environment', 'energy', 'people'];

/** « 2 incendies, 1 alerte énergie » : les incidents ouverts, par catégorie. */
function categoryParts(byCategory) {
  return CATEGORY_ORDER.filter((c) => byCategory[c] > 0).map((c) => ({ key: c, n: byCategory[c], text: plural(byCategory[c], ...(OPEN_WORD[c] ?? [c, c])), icon: CATEGORY[c]?.icon ?? 'info' }));
}

// ------------------------------------------------------------------ fil d'Ariane

/** Fil d'Ariane : une liste de liens, le dernier élément (la page) n'y figure pas, c'est le titre. */
export function crumbs(items) {
  if (!items.length) return null;
  return h(
    'nav',
    { class: 'crumbs', 'aria-label': 'Fil d’Ariane' },
    h('ol', null, items.map((c, i) => h('li', null, h('a', { href: c.href, 'data-key': `crumb-${i}` }, i === 0 && icon('chevron-left', 'icon icon-sm'), c.label)))),
  );
}

/** Le début du fil : le client (ou « Tous les clients » > le client pour un prestataire). Vide si la page d'accueil est déjà le groupe. */
export function orgTrail(ctx, orgId, orgName) {
  const g = ctx.state.groups;
  if (!g) return [];
  const multi = g.organizations.length > 1;
  if (soloGroupId(g) !== null) return [];
  return [...(multi ? [{ label: 'Tous les clients', href: '#/' }] : []), { label: orgName, href: orgHref(orgId, multi) }];
}

/** Compte limité à un seul groupe racine : son accueil est ce groupe, il n'a pas de « niveau organisation » au-dessus. */
export function soloGroupId(groups) {
  if (!groups?.scoped || groups.organizations.length !== 1) return null;
  const org = groups.organizations[0];
  return org.groups.length === 1 && !org.ungrouped ? org.groups[0].id : null;
}

// ------------------------------------------------------------------ petites briques

/** Un compteur d'état par niveau présent, du plus grave au plus serein. */
export function stateChips(stats, label = 'Sites par état') {
  const items = LEVELS.filter((l) => stats.states[l] > 0);
  if (!items.length) return null;
  return h(
    'ul',
    { class: 'state-row', 'aria-label': label },
    items.map((level) => {
      const st = SITE_STATE[level];
      const n = stats.states[level];
      return h('li', null, pill(st.pill, st.icon, `${plural(n, 'site', 'sites')} ${st.count[n > 1 ? 1 : 0]}`));
    }),
  );
}

/** La répartition d'un groupe dans un tableau : un compteur par état, ou « Aucun site » (jamais une pastille verte par défaut). */
function stateCell(stats) {
  if (stats.sites === 0) return h('div', { class: 'state-cell' }, pill('is-dashed is-unknown', 'state-unknown', 'Aucun site'));
  const total = stats.sites;
  const chips = LEVELS.filter((l) => stats.states[l] > 0).map((level) => {
    const st = SITE_STATE[level];
    const n = stats.states[level];
    return pill(st.pill, st.icon, `${n}${NB}${st.count[n > 1 ? 1 : 0]}`);
  });
  return h('div', { class: 'state-cell' }, ...chips, h('span', { class: 'state-detail' }, `sur ${plural(total, 'site', 'sites')}`));
}

function availabilityCell(stats) {
  const a = stats.availability30;
  if (a.pct === null) return h('span', { class: 'faint' }, stats.sites ? 'Pas encore mesurée' : '—');
  const partial = a.measuredSites < stats.sites;
  return h('div', { class: 'state-cell' }, h('span', null, fmtAvail(a.pct, a.downS)), partial && h('span', { class: 'state-detail' }, `mesurée sur ${a.measuredSites} des ${stats.sites} sites`));
}

function riskLine({ index, level, levelLabel }, { label, stale = false } = {}) {
  const tube = createTube();
  tube.set(index);
  tube.el.setAttribute('aria-hidden', 'true');
  tube.el.removeAttribute('role');
  tube.el.removeAttribute('aria-label');
  return h('div', { class: 'risk-inline' }, tube.el, h('span', { class: 'risk-read' }, h('span', { class: 'risk-num' }, nf(index, 1), h('small', null, '/60')), h('span', { class: `level-word lvl-${level}` }, levelLabel)), stale && h('span', { class: 'risk-stale' }, label));
}

function riskCell(stats) {
  const r = stats.risk;
  if (r.mean === null) return h('span', { class: 'risk-read is-none' }, stats.sites ? 'À évaluer' : '—');
  return h(
    'div',
    { class: 'state-cell' },
    riskLine({ index: r.mean, level: r.meanLevel, levelLabel: r.meanLevelLabel }),
    h('span', { class: 'state-detail' }, `moyenne de ${plural(r.scoredSites, 'site évalué', 'sites évalués')}${r.worst ? `${NB}; le plus exposé : ${r.worst.siteName} (${r.worst.index})` : ''}`),
  );
}

function incidentCell(stats) {
  const i = stats.incidents;
  const parts = categoryParts(i.openByCategory);
  if (i.open === 0 && i.openUnverified === 0) return h('div', { class: 'state-cell' }, h('span', null, 'Aucun'), stats.silent.count > 0 && h('span', { class: 'state-detail' }, 'sans compter les sites muets'));
  return h(
    'div',
    { class: 'state-cell' },
    i.open > 0 && h('span', null, h('strong', null, String(i.open)), ` en cours${i.openCritical ? `, dont ${i.openCritical} critique${i.openCritical > 1 ? 's' : ''}` : ''}`),
    parts.length > 0 && h('span', { class: 'state-detail' }, parts.map((p) => p.text).join(', ')),
    i.openUnverified > 0 && h('span', { class: 'state-detail' }, `+ ${plural(i.openUnverified, 'incident connu', 'incidents connus')} sur des sites muets (à vérifier)`),
  );
}

/**
 * Un tableau de lignes « groupe » (ou « client »), déjà classées du plus préoccupant au plus serein par le serveur.
 * `items` : [{ href, name, sub, stats, key }].
 */
export function groupsTable(items, { first = 'Groupe', caption }) {
  const rows = items.map((it) => {
    const tr = h(
      'tr',
      { class: `is-clickable is-${it.stats.worstLevel ? (SITE_STATE[it.stats.worstLevel] ?? SITE_STATE.unknown).tone : 'unknown'}` },
      h('th', { scope: 'row', class: 'cell-site' }, h('a', { class: 'site-link', href: it.href, 'data-key': it.key }, it.name), it.sub && h('span', { class: 'site-org' }, it.sub)),
      h('td', null, stateCell(it.stats)),
      h('td', { class: 'num' }, availabilityCell(it.stats)),
      h('td', null, riskCell(it.stats)),
      h('td', null, incidentCell(it.stats)),
      h('td', null, it.stats.lastReceivedAt ? timeEl(it.stats.lastReceivedAt, relTime(it.stats.lastReceivedAt)) : h('span', { class: 'faint' }, it.stats.sites ? 'Aucun signal reçu' : '—')),
    );
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a, button') || String(window.getSelection?.() ?? '')) return;
      location.hash = it.href;
    });
    return tr;
  });
  const table = dataTable([[first], ['État des sites'], [`Disponibilité (30${NB}j)`, true], ['Indice de sécurité'], ['Incidents en cours'], ['Dernier signal']], rows, { caption });
  table.querySelector('table')?.classList.add('sites-table', 'groups-table');
  return table;
}

const subLine = (card) => {
  const sub = card.children?.length ?? 0;
  return `${plural(card.stats.sites, 'site', 'sites')}${sub ? ` · ${plural(sub, 'sous-groupe', 'sous-groupes')}` : ''}`;
};

// ------------------------------------------------------------------ « à vérifier » : sites muets, jamais vus, non mesurés

/** Ce qu'il faut regarder en premier : les sites qui ne parlent plus ou ne mesurent rien. `null` s'il n'y a rien à signaler. */
export function attentionPanel(ctx, stats) {
  const line = (iconName, ...text) => h('li', { class: `is-${iconName}` }, icon(iconName), h('p', null, ...text));
  const lines = [];
  if (stats.silent.count > 0) {
    const shown = stats.silent.sites.slice(0, 5);
    lines.push(
      line(
        'state-offline',
        h('strong', null, plural(stats.silent.count, 'site ne répond plus', 'sites ne répondent plus')),
        `${NB}: `,
        shown.flatMap((s, i) => [i > 0 && ', ', h('a', { href: ctx.siteHref(s.id), 'data-key': `silent-${s.id}` }, s.name), ` (dernier signal ${relTime(s.lastReceivedAt)})`]),
        stats.silent.count > shown.length ? ` et ${plural(stats.silent.count - shown.length, 'autre', 'autres')}` : '',
        stats.silent.count > 1 ? '. Leur état affiché est celui de leur dernier signal.' : '. Son état affiché est celui de son dernier signal.',
      ),
    );
  }
  if (stats.neverSeen > 0) lines.push(line('state-unknown', h('strong', null, plural(stats.neverSeen, 'site n’a', 'sites n’ont')), ` encore rien envoyé au portail : rien ne permet de dire ${stats.neverSeen > 1 ? 'qu’ils sont protégés' : 'qu’il est protégé'}.`));
  if (stats.unmeasured > 0) lines.push(line('state-unknown', h('strong', null, plural(stats.unmeasured, 'site envoie', 'sites envoient')), ` des données mais aucun équipement n’y est mesuré : rien ne permet de dire que ${stats.unmeasured > 1 ? 'leurs équipements fonctionnent' : 'ses équipements fonctionnent'}.`));
  if (stats.incidents.openUnverified > 0) lines.push(line('state-alarm', h('strong', null, plural(stats.incidents.openUnverified, 'incident', 'incidents')), ` ${stats.incidents.openUnverified > 1 ? 'étaient' : 'était'} en cours au dernier signal ${stats.silent.count > 1 ? 'de sites muets' : 'd’un site muet'}${NB}: à vérifier.`));
  if (stats.access.unverifiedDown > 0) lines.push(line('state-warning', h('strong', null, plural(stats.access.unverifiedDown, 'porte', 'portes')), ` ${stats.access.unverifiedDown > 1 ? 'étaient hors service' : 'était hors service'} (hors ligne ou en défaut) au dernier signal ${stats.silent.count > 1 ? 'de sites muets' : 'd’un site muet'}${NB}: à vérifier.`));
  if (!lines.length) return null;
  return panel({ title: 'À vérifier', iconName: 'state-warning', cls: 'panel-attention' }, h('ul', { class: 'lines' }, lines));
}

// ------------------------------------------------------------------ les 30 derniers jours et l'indice, agrégés

/**
 * Les portes du contrôle d'accès, en une ligne : combien, et combien sont hors ligne ou en défaut (sites qui répondent seulement ;
 * le dernier état connu des sites muets est dit à part, dans « À vérifier »). Aucune porte transmise : pas de ligne.
 */
function accessLine(access, line, strong) {
  if (!access || access.sites === 0) return null;
  const down = access.offline + access.fault;
  const where = `dans ${plural(access.sites, 'site équipé', 'sites équipés')}`;
  if (down === 0) return line('door', 'Contrôle d’accès', `${NB}: `, strong(plural(access.doors, 'porte', 'portes')), ` ${where}, aucune hors ligne ni en défaut.`);
  const detail = [access.offline && `${access.offline} hors ligne`, access.fault && `${access.fault} en défaut`].filter(Boolean).join(', ');
  return line('state-warning', 'Contrôle d’accès', `${NB}: `, strong(plural(down, 'porte hors service', 'portes hors service')), ` (${detail}) sur ${plural(access.doors, 'porte', 'portes')} ${where}. ${down > 1 ? 'Ces portes ne sont' : 'Cette porte n’est'} plus suivie${down > 1 ? 's' : ''} normalement.`);
}

/** « Les 30 derniers jours » d'un ensemble de sites : protection, incidents, en cours, prise en charge. */
export function monthPanel(stats, noun) {
  const inc = stats.incidents.last30;
  const a = stats.availability30;
  const line = (iconName, ...text) => h('li', { class: `is-${iconName}` }, icon(iconName), h('p', null, ...text));
  const strong = (t) => h('strong', null, t);
  const open = categoryParts(stats.incidents.openByCategory);
  return panel(
    { title: 'Les 30 derniers jours', iconName: 'history' },
    h(
      'ul',
      { class: 'lines' },
      a.pct === null
        ? line('shield', `La protection ${noun} n’a pas encore pu être mesurée.`)
        : line(
            'shield',
            `Les équipements ont assuré la protection `,
            strong(`${fmtAvail(a.pct, a.downS)} du temps`),
            a.measuredSites < stats.sites ? ` sur ${plural(a.measuredSites, 'site mesuré', 'sites mesurés')} (${stats.sites - a.measuredSites > 1 ? `${stats.sites - a.measuredSites} ne le sont pas encore ou n’ont` : '1 ne l’est pas encore ou n’a'} rien envoyé ce mois-ci).` : ' (moyenne pondérée par la durée observée de chaque site).',
          ),
      inc.total === 0
        ? line('bell', `Aucun incident ${noun}.`)
        : line('bell', strong(plural(inc.total, 'incident', 'incidents')), `${NB}: ${plural(inc.real, 'événement réel', 'événements réels')}, ${plural(inc.falseAlarms, 'fausse alarme', 'fausses alarmes')}.`),
      stats.incidents.open > 0
        ? line('state-alarm', strong(plural(stats.incidents.open, 'incident encore en cours', 'incidents encore en cours')), `${NB}: ${open.map((p) => p.text).join(', ')}. À suivre en priorité.`)
        : line('state-ok', stats.silent.count > 0 ? 'Aucun incident en cours sur les sites qui répondent.' : 'Aucun incident en cours.'),
      inc.ackMedianS !== null && line('clock', 'Prise en charge en ', strong(fmtDur(inc.ackMedianS)), ' en général (délai médian entre l’alerte et sa prise en charge).'),
      accessLine(stats.access, line, strong),
    ),
  );
}

/** L'indice de sécurité GAMR d'un ensemble de sites : la moyenne, et le site le plus exposé (jamais un 0 pour un site non évalué). */
export function riskPanel(ctx, stats, noun) {
  const r = stats.risk;
  const title = 'Indice de sécurité';
  if (r.scoredSites === 0 || r.mean === null) return panel({ title, iconName: 'gauge' }, emptyBlock('gauge', `Aucun site ${noun} n’a encore d’indice de sécurité.`, 'L’indice apparaît quand les zones d’un site ont été évaluées, puis transmises par son système de surveillance.'));
  const w = r.worst;
  const thermo = createThermometer({ height: 116 });
  thermo.set(w.index);
  return panel(
    { title, iconName: 'gauge' },
    h(
      'div',
      { class: 'exposure' },
      h('div', { class: 'exposure-thermo' }, thermo.el),
      h(
        'div',
        { class: 'exposure-text' },
        h('p', { class: 'hint' }, 'Moyenne'),
        h('p', { class: 'exposure-value' }, h('span', { class: 'risk-num is-lg' }, nf(r.mean, 1), h('small', null, '/60')), h('span', { class: `level-word lvl-${r.meanLevel}` }, `Niveau ${r.meanLevelLabel.toLowerCase()}`)),
        h('p', { class: 'hint' }, 'Site le plus exposé'),
        h('a', { class: 'exposure-site', href: ctx.siteHref(w.siteId, 'securite'), 'data-key': 'worst-site' }, w.siteName),
        h('p', null, h('strong', null, `${w.index}/60`), ` · niveau ${w.levelLabel.toLowerCase()}`, w.worstZone ? `${NB}; zone la plus exposée${NB}: ${w.worstZone}` : ''),
        w.stale && h('p', { class: 'risk-stale' }, `Site muet${NB}: dernier indice connu, calculé ${relTime(w.at)}.`),
        h(
          'p',
          { class: 'hint' },
          `Moyenne de ${plural(r.scoredSites, 'site évalué', 'sites évalués')} sur ${stats.sites}${r.unscoredSites ? ` (${plural(r.unscoredSites, 'site sans indice n’y compte pas', 'sites sans indice n’y comptent pas')})` : ''}.`,
          r.fromSilentSites ? ` ${plural(r.fromSilentSites, 'site muet y compte', 'sites muets y comptent')} avec son dernier indice connu.` : '',
          ' Plus il est bas, mieux c’est protégé.',
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------ écrans

const countGroups = (groups) => groups.reduce((n, g) => n + 1 + (g.children?.length ?? 0), 0);

/** Accueil d'un prestataire qui suit plusieurs clients : un tableau, le client le plus préoccupant en premier. */
export function clientsPage(ctx, groups) {
  document.title = 'Vos clients · Suivi des sites';
  const items = groups.organizations.map((o) => ({
    href: orgHref(o.id, true),
    name: o.name,
    sub: `${plural(o.stats.sites, 'site', 'sites')}${o.groups.length ? ` · ${plural(countGroups(o.groups), 'groupe', 'groupes')}` : ''}`,
    stats: o.stats,
    key: `org-${o.id}`,
  }));
  const total = groups.total;
  return [
    ctx.pageHead({ title: 'Vos clients', sub: `${plural(groups.organizations.length, 'client suivi', 'clients suivis')}, ${plural(total.sites, 'site', 'sites')} au total. Du plus préoccupant au plus serein.`, after: stateChips(total) }),
    attentionPanel(ctx, total),
    panel({ title: 'Tous vos clients', iconName: 'building' }, h('p', { class: 'panel-note' }, `L’état d’abord, puis les incidents en cours, puis l’indice de sécurité. Touchez un client pour voir ses groupes et ses sites.`), groupsTable(items, { first: 'Client', caption: 'Vos clients, du plus préoccupant au plus serein' })),
    h('div', { class: 'grid-2' }, monthPanel(total, 'de vos clients'), riskPanel(ctx, total, 'de vos clients')),
  ];
}

/** Page d'une organisation : ses groupes classés pire-d'abord, ses sites sans groupe, ses chiffres agrégés. */
export function orgPage(ctx, node) {
  const g = ctx.state.groups;
  const multi = g.organizations.length > 1;
  const scoped = g.scoped;
  const limitedTo = ctx.state.me?.scopeGroups ?? [];
  const nGroups = countGroups(node.groups);
  const noun = scoped ? 'de votre périmètre' : `de ${node.name}`;
  document.title = `${node.name} · Suivi des sites`;
  const items = node.groups.map((c) => ({ href: groupHref(c.id), name: c.name, sub: subLine(c), stats: c.stats, key: `group-${c.id}` }));
  const looseIds = new Set(node.ungrouped?.siteIds ?? []);
  const loose = ctx.state.sites.filter((s) => looseIds.has(s.id));
  const sub = scoped
    ? `Votre périmètre${NB}: ${limitedTo.map((x) => x.name).join(', ') || 'aucun groupe'}. ${plural(node.stats.sites, 'site suivi', 'sites suivis')}.`
    : `${plural(node.stats.sites, 'site suivi', 'sites suivis')}${nGroups ? `, rangés dans ${plural(nGroups, 'groupe', 'groupes')}` : ''}. Cette page se met à jour toute seule chaque minute.`;
  const out = [ctx.pageHead({ title: node.name, crumb: crumbs(multi ? [{ label: 'Tous les clients', href: '#/' }] : []), sub, after: stateChips(node.stats) })];
  if (node.stats.sites === 0) {
    out.push(emptyBlock('building', 'Aucun site pour le moment.', 'Les groupes existent mais aucun site n’y est encore rangé. Votre prestataire range les sites dans les groupes : contactez-le si un site manque.'));
    if (items.length) out.push(panel({ title: 'Groupes', iconName: 'layers' }, groupsTable(items, { caption: 'Groupes' })));
    return out;
  }
  out.push(attentionPanel(ctx, node.stats));
  if (items.length) out.push(panel({ title: 'Groupes', iconName: 'layers' }, h('p', { class: 'panel-note' }, `Du plus préoccupant au plus serein${NB}: l’état d’abord, puis les incidents en cours, puis l’indice de sécurité. Touchez un groupe pour voir ses sous-groupes et ses sites.`), groupsTable(items, { caption: 'Groupes, du plus préoccupant au plus serein' })));
  if (loose.length) out.push(ctx.sitesPanel({ title: items.length ? 'Sites sans groupe' : 'Vos sites', iconName: 'building', note: items.length ? 'Ces sites ne sont rangés dans aucun groupe. Ils ne sont visibles que des comptes qui voient toute l’organisation.' : null, sites: loose }));
  out.push(h('div', { class: 'grid-2' }, monthPanel(node.stats, noun), riskPanel(ctx, node.stats, noun)));
  return out;
}

/** Page d'un groupe : ses sous-groupes, ses sites, ses chiffres agrégés. */
export function groupPage(ctx, d) {
  const stats = d.stats;
  const isSub = d.group.depth === 1;
  const noun = `de ${isSub ? 'ce sous-groupe' : 'ce groupe'}`;
  document.title = `${d.group.name} · Suivi des sites`;
  const trail = [...orgTrail(ctx, d.organization.id, d.organization.name), ...d.path.map((p) => ({ label: p.name, href: groupHref(p.id) }))];
  const items = d.children.map((c) => ({ href: groupHref(c.id), name: c.name, sub: subLine(c), stats: c.stats, key: `group-${c.id}` }));
  const sub = `${plural(stats.sites, 'site suivi', 'sites suivis')}${d.children.length ? ` dans ce groupe et ses ${plural(d.children.length, 'sous-groupe', 'sous-groupes')}` : ` dans ${isSub ? 'ce sous-groupe' : 'ce groupe'}`}.`;
  const out = [ctx.pageHead({ title: d.group.name, crumb: crumbs(trail), sub, after: stateChips(stats) })];
  if (stats.sites === 0) {
    out.push(emptyBlock('building', 'Aucun site dans ce groupe pour le moment.', 'Votre prestataire range les sites dans les groupes : contactez-le si un site manque.'));
    if (items.length) out.push(panel({ title: 'Sous-groupes', iconName: 'layers' }, groupsTable(items, { first: 'Sous-groupe', caption: 'Sous-groupes' })));
    return out;
  }
  out.push(attentionPanel(ctx, stats));
  if (items.length) out.push(panel({ title: 'Sous-groupes', iconName: 'layers' }, h('p', { class: 'panel-note' }, `Du plus préoccupant au plus serein${NB}: touchez un sous-groupe pour voir ses sites.`), groupsTable(items, { first: 'Sous-groupe', caption: 'Sous-groupes, du plus préoccupant au plus serein' })));
  if (d.sites.length) out.push(ctx.sitesPanel({ title: items.length ? 'Sites rattachés directement à ce groupe' : 'Sites du groupe', iconName: 'building', note: null, sites: d.sites, sorted: true }));
  out.push(h('div', { class: 'grid-2' }, monthPanel(stats, noun), riskPanel(ctx, stats, noun)));
  return out;
}

// ------------------------------------------------------------------ menu : l'arbre des groupes

/**
 * L'arbre du menu : les groupes de chaque organisation, et seulement les sites du groupe ouvert (et de ses parents) : un
 * réseau de cent agences reste lisible. `link(card)` est le lien d'un site (fourni par app.js).
 */
export function railTree(ctx, r, link) {
  const g = ctx.state.groups;
  const multi = g.organizations.length > 1;
  // Ordre alphabétique et stable : un menu qui se réordonne à chaque rafraîchissement désoriente.
  const byName = (a, b) => a.name.localeCompare(b.name, 'fr');
  const cards = [...ctx.state.sites].sort(byName);
  const byId = new Map();
  for (const o of g.organizations) for (const top of o.groups) for (const c of [top, ...top.children]) byId.set(c.id, c);

  // Les groupes ouverts : ceux de la page affichée (le groupe lui-même et ses parents, ou le chemin du site).
  const open = new Set();
  if (r.kind === 'group') for (let c = byId.get(r.id); c; c = c.parentId === null ? undefined : byId.get(c.parentId)) open.add(c.id);
  if (r.kind === 'site') for (const p of cards.find((x) => x.id === r.id)?.groupPath ?? []) open.add(p.id);

  const groupItem = (c, depth) => {
    const worst = c.stats.worstLevel ? (SITE_STATE[c.stats.worstLevel] ?? SITE_STATE.unknown) : SITE_STATE.unknown;
    const current = r.kind === 'group' && r.id === c.id;
    const tip = `${c.name}${NB}: ${plural(c.stats.sites, 'site', 'sites')}${c.stats.worstLevel ? `, ${worst.count[1]}` : ''}`;
    const mine = cards.filter((s) => s.groupId === c.id);
    const expanded = open.has(c.id);
    return h(
      'li',
      { class: depth ? 'nav-nested' : null },
      h(
        'a',
        { class: 'nav-item nav-site nav-group-item', href: groupHref(c.id), 'aria-current': current ? 'page' : null, 'aria-expanded': mine.length || c.children.length ? String(expanded) : null, 'data-key': `nav-group-${c.id}` },
        h('span', { class: `nav-state is-${worst.tone}`, 'aria-hidden': 'true', title: tip }, icon('layers')),
        h('span', { class: 'nav-label', title: tip }, c.name),
        h('span', { class: 'nav-count', 'aria-hidden': 'true' }, String(c.stats.sites)),
        h('span', { class: 'sr-only' }, `${NB}: ${plural(c.stats.sites, 'site', 'sites')}`),
      ),
      expanded && (mine.length || c.children.length) > 0 && h('ul', { class: 'nav-list nav-nested-list', 'aria-label': c.name }, mine.map(link), [...c.children].sort(byName).map((k) => groupItem(k, depth + 1))),
    );
  };

  return g.organizations.map((o) => {
    const looseIds = new Set(o.ungrouped?.siteIds ?? []);
    const loose = cards.filter((s) => looseIds.has(s.id));
    const showLoose = loose.length > 0 && (loose.length <= 8 || loose.some((s) => r.kind === 'site' && s.id === r.id));
    return h(
      'div',
      { class: 'nav-org' },
      multi && h('p', { class: 'nav-org-title' }, o.name),
      h(
        'ul',
        { class: 'nav-list', 'aria-label': multi ? o.name : 'Groupes' },
        [...o.groups].sort(byName).map((c) => groupItem(c, 0)),
        loose.length > 0 &&
          h(
            'li',
            null,
            h('p', { class: 'nav-org-title nav-loose' }, o.groups.length ? 'Sans groupe' : 'Sites'),
            showLoose ? h('ul', { class: 'nav-list', 'aria-label': 'Sites sans groupe' }, loose.map(link)) : h('a', { class: 'nav-item', href: orgHref(o.id, multi) }, h('span', { class: 'nav-label' }, `${plural(loose.length, 'site', 'sites')} sans groupe`)),
          ),
      ),
    );
  });
}

