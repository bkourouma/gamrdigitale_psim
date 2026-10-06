/**
 * Écran « Risques » : l'indice de sécurité GAMR du site et de chacune de ses zones, de 1 à 60
 * (probabilité 1-3 × vulnérabilité 1-4 × répercussions 1-5), la tendance, les priorités d'action chiffrées.
 * Lecture pour tous ; l'évaluation d'une zone est réservée à l'administrateur.
 *
 * Rien n'est inventé : une zone non évaluée n'a pas de chiffre (jauge vide en pointillé, « À évaluer »).
 *
 * Une saisie n'est jamais écrasée :
 * - tant qu'une évaluation est ouverte, ni le rafraîchissement (20 s) ni le retour sur l'écran ne relisent le serveur ;
 * - le formulaire est un seul élément, gardé d'un rendu à l'autre (jamais reconstruit avec les valeurs du serveur) ;
 * - un rafraîchissement sans changement ne reconstruit rien, et une reconstruction rend le focus au même bouton.
 */
import { icon, emit, clamp, hasUnsavedInput, SVG_NS } from './core.js';
import { BANDS, createRing, createTube, levelOf } from './gauge.js';

const REFRESH_MS = 20000;
const NB = ' '; // espace insécable : typographie française (« : », « 36 sur 60 »)

const P_LABEL = { 1: 'Improbable', 2: 'Possible', 3: 'Probable' };
const R_LABEL = { 1: 'Négligeable', 2: 'Limité', 3: 'Sérieux', 4: 'Grave', 5: 'Catastrophique' };
const HORIZONS = [
  { id: 'court', title: 'Court terme', sub: 'à faire maintenant', empty: "Rien d'urgent pour l'instant." },
  { id: 'moyen', title: 'Moyen terme', sub: 'à planifier', empty: "Rien à planifier pour l'instant." },
  { id: 'long', title: 'Long terme', sub: 'travaux', empty: "Aucuns travaux à prévoir pour l'instant." },
];
// Les trois répercussions : les mots du serveur (« image, économie, humaines »), expliqués entre parenthèses.
const IMPACTS = [
  { key: 'image', name: 'impactImage', label: 'Image (réputation)' },
  { key: 'economy', name: 'impactEconomy', label: 'Économie (pertes, arrêt)' },
  { key: 'human', name: 'impactHuman', label: 'Humaines (blessés)' },
];

// ---------------------------------------------------------------- textes et dates

/** « 1 zone », « 3 zones » (en français, 0 et 1 restent au singulier). */
const plural = (n, one, many) => `${n}${NB}${n > 1 ? many : one}`;

/** Quelques noms, puis « et 2 autres » : un avertissement reste court. */
function someNames(items, max = 3) {
  const names = items.map((z) => z.zone);
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} et ${plural(names.length - max, 'autre', 'autres')}`;
}

/** Jour « AAAA-MM-JJ » de l'historique (heure locale du PSIM, comme le serveur). */
function dayDate(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const shortDay = (day) => (day === todayKey() ? "aujourd'hui" : dayDate(day).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }));
const onDay = (day) => (day === todayKey() ? "aujourd'hui" : `le ${dayDate(day).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`);
const longDate = (ts) => new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

/** Raison d'un échec en mots simples (une coupure réseau arrive en anglais du navigateur). */
const reasonOf = (err) => {
  if (err instanceof TypeError) return 'le PSIM ne répond pas';
  const r = String(err?.message ?? 'erreur inconnue').replace(/\.$/, '');
  // Minuscule initiale (la raison suit deux-points), sauf sigle ou nom en capitales.
  return /^[A-ZÉÈÀ][a-zàâçéèêëîïôûùü]/.test(r) ? r.charAt(0).toLowerCase() + r.slice(1) : r;
};

/** Phrase de tendance : sens, ampleur, depuis quand ; « en hausse » veut dire que le risque augmente. */
function trendSentence(points) {
  const first = points[0];
  const last = points[points.length - 1];
  const diff = last.index - first.index;
  const since = onDay(first.day);
  if (diff === 0) return `Stable depuis ${since}${NB}: ${last.index} sur 60.`;
  return `En ${diff > 0 ? 'hausse' : 'baisse'} de ${plural(Math.abs(diff), 'point', 'points')} depuis ${since}${NB}: le risque ${diff > 0 ? 'augmente' : 'diminue'}.`;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

// ---------------------------------------------------------------- écran

export function createRiskView({ api, h, toast, getMe, dialogs }) {
  const root = document.getElementById('risk-view');
  let data = null; // dernière réponse de /api/risk
  let lastJson = ''; // pour ne pas reconstruire l'écran quand rien n'a changé
  let renderedFor = ''; // compte pour lequel l'écran a été dessiné (boutons d'administration ou non)
  let loadedAt = 0;
  let timer = null;
  let seq = 0; // une réponse plus ancienne que la dernière demande est ignorée
  let editor = null; // { zone, user, el, first } : l'évaluation ouverte, un seul élément gardé d'un rendu à l'autre
  let editorSeq = 0;
  const openCalc = new Set(); // zones dont le détail du calcul est déplié

  // Avertissement de mise à jour : élément permanent (role=status), annoncé sans voler le focus.
  const statusEl = h('div', { class: 'risk-status', role: 'status' });

  const isAdmin = () => getMe()?.role === 'admin';
  const viewerKey = () => `${getMe()?.username ?? ''}/${getMe()?.role ?? ''}`;
  const notice = (kind, iconName, text) => h('div', { class: `notice is-${kind}` }, icon(iconName), h('span', { text }));

  // ------------------------------------------------------------ lecture

  async function refresh({ force = false } = {}) {
    const mine = ++seq;
    try {
      const next = await api('/api/risk');
      if (mine !== seq) return;
      loadedAt = Date.now();
      setStatus(null);
      emit('risk', next); // la jauge du rail peut suivre sans attendre sa propre lecture
      // Une évaluation ouverte entre-temps : on ne touche à rien (le formulaire perdrait le focus en pleine frappe).
      if (editor && !force) return;
      const json = JSON.stringify(next);
      if (!force && data && json === lastJson && viewerKey() === renderedFor) return;
      data = next;
      lastJson = json;
      render();
    } catch (err) {
      if (mine !== seq) return;
      if (data) setStatus(err); // les chiffres déjà affichés restent, avec leur heure
      else renderError(err);
    }
  }

  function setStatus(err) {
    if (!err) {
      statusEl.replaceChildren();
      return;
    }
    const at = new Date(loadedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    statusEl.replaceChildren(
      notice('warning', 'state-warning', `Mise à jour impossible${NB}: ${reasonOf(err)}. Les chiffres affichés datent de ${at}${NB}; nouvel essai automatique dans 20 secondes.`),
    );
  }

  function renderLoading() {
    root.replaceChildren(h('p', { class: 'risk-loading', role: 'status', text: "Chargement de l'indice de sécurité…" }));
  }

  function renderError(err) {
    const retry = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: () => {
          retry.classList.add('is-busy');
          retry.setAttribute('aria-busy', 'true');
          refresh();
        },
      },
      icon('refresh'),
      h('span', { text: 'Réessayer' }),
    );
    root.replaceChildren(
      h(
        'div',
        { class: 'notice is-alarm risk-failed', role: 'alert' },
        icon('state-alarm'),
        h(
          'div',
          { class: 'risk-failed-text' },
          h('p', {}, h('strong', { text: `Impossible d'afficher l'indice de sécurité${NB}: ${reasonOf(err)}.` })),
          h('p', { text: `${err instanceof TypeError ? 'Vérifiez que le PSIM est joignable, puis réessayez.' : 'Réessayez, ou contactez un administrateur si cela dure.'} Un nouvel essai est fait toutes les 20 secondes.` }),
          h('div', { class: 'actions' }, retry),
        ),
      ),
    );
  }

  // ------------------------------------------------------------ tendance

  /**
   * Courbe d'un indice (un relevé par jour) : bandes pâles des quatre niveaux en fond, axe 0 à 60, première et dernière
   * valeurs écrites. Le tracé est un SVG étiré sur la largeur (traits non déformés) ; chiffres, dates et points sont en
   * HTML placés en pourcentage : ils gardent leur vraie taille à toutes les largeurs d'écran.
   */
  function trendChart(points, { compact = false, subject }) {
    const first = points[0];
    const last = points[points.length - 1];
    const t0 = dayDate(first.day).getTime();
    const span = Math.max(1, dayDate(last.day).getTime() - t0);
    const xOf = (p) => ((dayDate(p.day).getTime() - t0) / span) * 100;
    const yOf = (v) => ((60 - clamp(v, 0, 60)) / 60) * 100; // pourcentage depuis le haut

    const drawing = svg('svg', { viewBox: '0 0 100 60', preserveAspectRatio: 'none', class: 'trend-svg', 'aria-hidden': 'true', focusable: 'false' });
    let from = 0;
    for (const band of BANDS) {
      drawing.append(svg('rect', { x: 0, y: 60 - band.max, width: 100, height: band.max - from, class: `trend-band ${band.level}` }));
      from = band.max;
    }
    for (const t of [8, 20, 36]) drawing.append(svg('line', { x1: 0, x2: 100, y1: 60 - t, y2: 60 - t, class: 'trend-rule' }));
    drawing.append(svg('polyline', { class: 'trend-line', points: points.map((p) => `${xOf(p).toFixed(2)},${(60 - clamp(p.index, 0, 60)).toFixed(2)}`).join(' ') }));

    const plot = h('div', { class: 'trend-plot' }, drawing);
    for (const [p, end] of [
      [first, 'is-first'],
      [last, 'is-last'],
    ]) {
      const dot = h('span', { class: `trend-dot lvl-${levelOf(p.index)?.level ?? 'faible'}` });
      const value = h('span', { class: `trend-val ${end}${p.index > 46 ? ' is-below' : ''}`, text: String(p.index) });
      for (const node of [dot, value]) {
        node.style.setProperty('--x', `${xOf(p)}%`);
        node.style.setProperty('--y', `${yOf(p.index)}%`);
      }
      plot.append(dot, value);
    }
    const axis = h('div', { class: 'trend-axis' });
    for (const t of compact ? [60, 36, 20, 0] : [60, 36, 20, 8, 0]) {
      const tick = h('span', { text: String(t) });
      tick.style.setProperty('--y', `${yOf(t)}%`);
      axis.append(tick);
    }
    const values = points.map((p) => p.index);
    const longDay = (day) => dayDate(day).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
    const period = `du ${longDay(first.day)} ${last.day === todayKey() ? "à aujourd'hui" : `au ${longDay(last.day)}`}`;
    const label =
      `Courbe de l'indice ${subject} ${period}${NB}: de ${first.index} à ${last.index} sur 60, ` +
      `plus bas ${Math.min(...values)}, plus haut ${Math.max(...values)}, ${plural(points.length, 'relevé', 'relevés')}.`;
    return h(
      'div',
      { class: `trend-chart${compact ? ' is-compact' : ''}`, role: 'img', 'aria-label': label },
      axis,
      plot,
      h('div', { class: 'trend-dates' }, h('time', { datetime: first.day, text: shortDay(first.day) }), h('time', { datetime: last.day, text: shortDay(last.day) })),
    );
  }

  /** Bloc « tendance » : la courbe et sa phrase, ou la phrase qui explique pourquoi il n'y a pas encore de courbe. */
  function trendBlock(points, { title, subject, compact = false, hasIndex = true }) {
    const heading = h(compact ? 'h4' : 'h3', { class: 'risk-trend-title' }, icon('chart', 'icon-sm'), title);
    if (hasIndex && points.length >= 2) {
      return h('div', { class: `risk-trend${compact ? ' is-compact' : ''}` }, heading, h('p', { class: 'risk-trend-sum', text: trendSentence(points) }), trendChart(points, { compact, subject }));
    }
    let text;
    if (!hasIndex) {
      const older = (data?.history?.__site__ ?? []).length > 0;
      text = `La courbe apparaîtra quand une zone sera évaluée${older ? `${NB}: les relevés antérieurs à la remise à zéro des évaluations ne sont pas tracés` : ''}. L'indice est ensuite relevé une fois par jour.`;
    }
    else if (points.length === 1) text = `Un seul relevé pour l'instant (${points[0].index} sur 60, ${onDay(points[0].day)}). La courbe apparaîtra au deuxième${NB}: l'indice est relevé une fois par jour.`;
    else text = `Pas encore de relevé${NB}: l'indice est relevé une fois par jour, la courbe apparaîtra au deuxième.`;
    return h('div', { class: `risk-trend is-empty${compact ? ' is-compact' : ''}` }, heading, h('p', { class: 'risk-trend-sum', text }));
  }

  // ------------------------------------------------------------ indice du site

  function scaleLegend(current) {
    const bands = data.bands?.length ? data.bands : BANDS;
    return h(
      'div',
      { class: 'risk-scale' },
      h(
        'ul',
        { class: 'risk-bands', 'aria-label': "Échelle de l'indice, de 1 à 60" },
        ...bands.map((b, i) =>
          h(
            'li',
            { class: `risk-band lvl-${b.level}${b.level === current ? ' is-current' : ''}`, title: `Niveau ${b.label.toLowerCase()} : indice de ${i === 0 ? 1 : bands[i - 1].max + 1} à ${b.max}` },
            h('i', { 'aria-hidden': 'true' }),
            h('span', { text: `${b.label} ≤${NB}${b.max}` }),
            b.level === current ? h('span', { class: 'sr-only', text: ' (niveau actuel du site)' }) : null,
          ),
        ),
      ),
      h(
        'p',
        { class: 'risk-formula' },
        `Indice${NB}= `,
        h('b', { text: 'Probabilité' }),
        ` (P, 1 à 3) × `,
        h('b', { text: 'Vulnérabilité' }),
        ` (V, 1 à 4) × `,
        h('b', { text: 'Répercussions' }),
        ` (R, 1 à 5). Plus il est bas, mieux le site est protégé. L'indice du site est celui de sa zone la plus exposée${NB}; il suit l'état réel des détecteurs et des caméras.`,
      ),
    );
  }

  function sitePanel(admin) {
    const s = data.site;
    const level = levelOf(s.index);
    const zones = data.zones;
    const missing = zones.filter((z) => !z.assessed);
    const stale = zones.filter((z) => z.stale);

    const ring = createRing({ size: 200, caption: 'Indice de sécurité du site' });
    ring.set(s.index);

    const summary = h('div', { class: 'risk-site-summary' }, h('h2', { id: 'risk-site-title', class: 'risk-site-title' }, 'Indice de sécurité du site'));
    if (level) {
      summary.append(
        h('p', { class: `risk-site-level lvl-${level.level}`, text: `Niveau ${(s.levelLabel ?? level.label).toLowerCase()}` }),
        h(
          'ul',
          { class: 'risk-facts' },
          h('li', {}, icon('pin'), h('span', {}, `Zone la plus exposée${NB}: `, h('strong', { text: s.worstZone ?? '' }))),
          h('li', {}, icon('check'), h('span', { text: `${plural(s.assessedZones, 'zone évaluée', 'zones évaluées')} sur ${s.totalZones}` })),
        ),
      );
      if (missing.length) {
        summary.append(notice('warning', 'state-warning', `${plural(missing.length, 'zone', 'zones')} à évaluer (${someNames(missing)})${NB}: leur risque est inconnu, aucune note n'est supposée. L'indice du site ne tient compte que des zones évaluées.`));
      }
      if (stale.length) {
        summary.append(notice('warning', 'history', `${stale.length > 1 ? `${stale.length} évaluations ont` : 'Une évaluation a'} plus d'un an (${someNames(stale)})${NB}: à revoir.`));
      }
    } else if (zones.length) {
      summary.append(
        h('p', { class: 'risk-site-level is-none', text: 'À évaluer' }),
        h('p', { class: 'risk-site-lead', text: `Aucune zone n'est encore évaluée${NB}: le risque du site est inconnu. Aucun chiffre n'est supposé.` }),
        h('p', { class: 'hint', text: `${plural(zones.length, 'zone attend', 'zones attendent')} une évaluation (${someNames(zones)}).` }),
        admin
          ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', dataset: { key: 'first' }, onclick: () => openEditor(missing[0].zone) }, icon('pencil'), h('span', { text: 'Évaluer la première zone' })))
          : h('p', { class: 'hint', text: `Un administrateur évalue chaque zone${NB}: probabilité d'un départ de feu, lignes de défense en place, répercussions.` }),
      );
    } else {
      summary.append(
        h('p', { class: 'risk-site-level is-none', text: 'À évaluer' }),
        h('p', { class: 'risk-site-lead', text: `Aucune zone n'est encore définie${NB}: l'indice du site ne peut pas être calculé.` }),
        h('p', { class: 'hint', text: 'Les zones viennent des équipements : chaque détecteur et chaque caméra porte un nom de zone (« Cuisine », « Entrepôt »…).' }),
        admin ? h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/equipements' }, icon('plan'), h('span', { text: 'Ouvrir Équipements et plan' }))) : null,
      );
    }

    return h(
      'section',
      { class: `panel risk-site${level ? ` lvl-${level.level}` : ' is-none'}`, 'aria-labelledby': 'risk-site-title' },
      h(
        'div',
        { class: 'risk-site-body' },
        summary,
        h('div', { class: 'risk-ring' }, ring.el),
        trendBlock(data.history?.__site__ ?? [], { title: 'Tendance sur 60 jours', subject: 'du site', hasIndex: Boolean(level) }),
        scaleLegend(level?.level),
      ),
    );
  }

  // ------------------------------------------------------------ risque par zone

  /** Puce P, V ou R : la lettre et la note ; l'infobulle et le texte lu disent ce qu'elle veut dire. */
  function factor(letter, value, text) {
    return h('span', { class: 'risk-factor', title: text }, h('span', { 'aria-hidden': 'true' }, h('b', { text: letter }), `${NB}${value}`), h('span', { class: 'sr-only', text: `${text}.` }));
  }

  function calcDetail(z, id) {
    const inPlace = data.defenses.filter((d) => z.defenses.includes(d.id)).map((d) => d.label);
    const absent = data.defenses.filter((d) => !z.defenses.includes(d.id)).map((d) => d.label);
    const column = (title, value, max, word, reasons, ...extra) =>
      h(
        'section',
        { class: 'risk-calc-col' },
        h('h4', {}, h('span', { text: title }), h('span', { class: 'risk-calc-score num', text: `${value} sur ${max}` })),
        word ? h('p', { class: 'risk-calc-word', text: word }) : null,
        h('ul', {}, ...reasons.map((t) => h('li', { text: t }))),
        ...extra,
      );
    return h(
      'div',
      { class: 'risk-calc', id, hidden: !openCalc.has(z.zone) },
      h(
        'div',
        { class: 'risk-calc-cols' },
        column('Probabilité', z.p.value, 3, P_LABEL[z.p.value], z.p.reasons),
        column(
          'Vulnérabilité',
          z.v.value,
          4,
          'Plus elle est haute, moins la zone est protégée',
          z.v.reasons,
          inPlace.length ? h('p', { class: 'hint', text: `En place${NB}: ${inPlace.join(', ')}.` }) : null,
          absent.length ? h('p', { class: 'hint', text: `Manquantes${NB}: ${absent.join(', ')}.` }) : null,
        ),
        column('Répercussions', z.r.value, 5, R_LABEL[z.r.value], z.r.reasons, h('p', { class: 'hint', text: `Image ${z.r.image} · Économie ${z.r.economy} · Humaines ${z.r.human} (sur 5)` })),
      ),
      h('p', { class: `risk-calc-formula lvl-${z.level}` }, `Indice${NB}= ${z.p.value} × ${z.v.value} × ${z.r.value} = `, h('strong', { text: String(z.index) }), ` sur 60, niveau ${z.levelLabel.toLowerCase()}.`),
      h('p', { class: 'hint', text: `Évaluée par ${z.assessedBy} le ${longDate(z.assessedAt)}.` }),
      z.notes ? h('p', { class: 'risk-calc-notes' }, h('b', { text: `Notes${NB}: ` }), z.notes) : null,
      trendBlock(data.history?.[z.zone] ?? [], { title: 'Évolution sur 60 jours', subject: `de la zone ${z.zone}`, compact: true }),
    );
  }

  function zoneItem(z, i, admin) {
    const editing = editor?.zone === z.zone;
    const li = h('li', { class: `risk-zone${z.assessed ? '' : ' is-none'}${editing ? ' is-editing' : ''}` });

    const name = h('div', { class: 'risk-zone-name' }, h('h3', { text: z.zone }));
    if (z.stale) name.append(h('span', { class: 'tag is-warning is-dashed', title: "Évaluée il y a plus d'un an : à refaire." }, icon('history', 'icon-sm'), 'À revoir'));
    const down = z.facts?.detectorsDown ?? [];
    if (down.length) {
      name.append(
        h(
          'span',
          { class: 'tag risk-down', title: "Détecteur d'incendie hors service : la vulnérabilité de la zone est augmentée tant qu'il n'est pas remis en service." },
          icon('wrench', 'icon-sm'),
          `${down.join(', ')} hors service`,
        ),
      );
    }

    // Le tube est l'image du chiffre écrit à côté : les lecteurs d'écran lisent le chiffre et le niveau, une seule fois.
    const tube = createTube({ label: z.zone });
    tube.set(z.assessed ? z.index : null);
    tube.el.removeAttribute('role');
    tube.el.removeAttribute('aria-label');
    tube.el.setAttribute('aria-hidden', 'true');

    const score = z.assessed
      ? h(
          'p',
          { class: `risk-zone-score lvl-${z.level}` },
          h('span', { class: 'risk-zone-num', text: String(z.index) }),
          h('span', { class: 'sr-only', text: ` sur 60, niveau${NB}` }),
          h('span', { class: 'risk-zone-level', text: z.levelLabel }),
        )
      : h('p', { class: 'risk-zone-score is-none' }, h('span', { class: 'risk-zone-num', 'aria-hidden': 'true', text: '—' }), h('span', { class: 'risk-zone-level', text: 'À évaluer' }));

    const factors = z.assessed
      ? h(
          'div',
          { class: 'risk-factors' },
          factor('P', z.p.value, `Probabilité${NB}: ${z.p.value} sur 3 (${P_LABEL[z.p.value].toLowerCase()}), la chance qu'un feu se déclare dans la zone`),
          factor('V', z.v.value, `Vulnérabilité${NB}: ${z.v.value} sur 4, plus elle est haute, moins la zone est protégée`),
          factor('R', z.r.value, `Répercussions${NB}: ${z.r.value} sur 5 (${R_LABEL[z.r.value].toLowerCase()}), la gravité des conséquences d'un incendie`),
        )
      : h('p', { class: 'risk-factors hint', text: admin ? 'Aucun chiffre supposé' : 'Évaluation à faire par un administrateur' });

    const actions = h('div', { class: 'risk-zone-actions' });
    let detail = null;
    if (z.assessed) {
      const detailId = `risk-calc-${i}`;
      detail = calcDetail(z, detailId);
      const open = openCalc.has(z.zone);
      const word = h('span', { text: open ? 'Masquer le calcul' : 'Voir le calcul' });
      actions.append(
        h(
          'button',
          {
            class: 'btn btn-ghost btn-sm risk-calc-btn',
            type: 'button',
            'aria-expanded': String(open),
            'aria-controls': detailId,
            dataset: { key: `calc:${z.zone}` },
            onclick: (e) => {
              // Déplié sur place, sans reconstruire l'écran : une évaluation ouverte plus loin garde sa saisie et son focus.
              const show = !openCalc.has(z.zone);
              if (show) openCalc.add(z.zone);
              else openCalc.delete(z.zone);
              e.currentTarget.setAttribute('aria-expanded', String(show));
              word.textContent = show ? 'Masquer le calcul' : 'Voir le calcul';
              detail.hidden = !show;
            },
          },
          icon('chevron-down'),
          word,
          h('span', { class: 'sr-only', text: ` de «${NB}${z.zone}${NB}»` }),
        ),
      );
    }
    if (admin) {
      actions.append(
        h(
          'button',
          {
            class: 'btn btn-sm',
            type: 'button',
            'aria-expanded': String(editing),
            'aria-label': `${z.assessed ? "Modifier l'évaluation de" : 'Évaluer'} la zone « ${z.zone} »`,
            dataset: { key: `edit:${z.zone}` },
            onclick: () => openEditor(z.zone),
          },
          icon('pencil'),
          h('span', { text: z.assessed ? 'Modifier' : 'Évaluer' }),
        ),
      );
    }

    li.append(h('div', { class: 'risk-zone-row' }, name, tube.el, score, factors, actions));
    if (detail) li.append(detail);
    if (editing) li.append(editor.el);
    return li;
  }

  function zonesPanel(admin) {
    const zones = data.zones;
    const body = h('div', { class: 'panel-body' });
    if (!zones.length) {
      body.append(
        h(
          'div',
          { class: 'empty' },
          icon('pin'),
          h('strong', { text: "Aucune zone pour l'instant." }),
          h('span', { text: "Chaque détecteur et chaque caméra porte un nom de zone : dès qu'un équipement en a un, sa zone apparaît ici, prête à être évaluée." }),
          admin ? h('a', { href: '#/equipements', text: 'Nommer les zones dans « Équipements et plan »' }) : null,
        ),
      );
    } else {
      body.append(
        h('div', { class: 'risk-zone-cols', 'aria-hidden': 'true' }, h('span', { text: 'Zone' }), h('span', { text: 'Indice, de 1 à 60' }), h('span', { text: 'Niveau' }), h('span', { text: 'P × V × R' }), h('span')),
        h('ul', { class: 'risk-zone-list', 'aria-labelledby': 'risk-zones-title' }, ...zones.map((z, i) => zoneItem(z, i, admin))),
      );
    }
    return h(
      'section',
      { class: 'panel risk-zones', 'aria-labelledby': 'risk-zones-title' },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', { id: 'risk-zones-title' }, icon('pin'), 'Risque par zone'),
        zones.length ? h('p', { class: 'panel-note is-apart', text: `${plural(zones.length, 'zone', 'zones')}, de la plus exposée à la moins exposée` }) : null,
      ),
      body,
    );
  }

  // ------------------------------------------------------------ priorités d'action

  function priorityItem(p, admin) {
    const zone = data.zones.find((z) => z.zone === p.zone);
    const gain = p.gain
      ? h(
          'span',
          { class: 'prio-gain is-gain', title: `Si la mesure est réalisée, l'indice de « ${p.zone} » baisse de ${plural(p.gain, 'point', 'points')}.` },
          h('span', { class: 'sr-only', text: 'Gain : ' }),
          `−${plural(p.gain, 'point', 'points')}`,
        )
      : h(
          'span',
          { class: 'prio-gain is-none', title: zone && !zone.assessed ? "Le gain sera connu après l'évaluation." : "Effet réel mais qu'on ne peut pas chiffrer." },
          h('span', { class: 'sr-only', text: 'Gain : ' }),
          'non chiffré',
        );
    return h(
      'li',
      { class: 'prio' },
      gain,
      h(
        'div',
        { class: 'prio-text' },
        h('p', { class: 'prio-title', text: p.title }),
        h('p', { class: 'prio-why', text: p.why }),
        admin && zone && !zone.assessed
          ? h('button', { class: 'btn btn-sm', type: 'button', dataset: { key: `prio:${p.zone}` }, onclick: () => openEditor(p.zone) }, icon('pencil'), h('span', { text: 'Évaluer cette zone' }))
          : null,
      ),
    );
  }

  function prioritiesPanel(admin) {
    const items = data.priorities ?? [];
    const head = h(
      'div',
      { class: 'panel-head' },
      h('h2', { id: 'risk-prio-title' }, icon('check'), "Priorités d'action"),
    );
    const body = h('div', { class: 'panel-body' });
    if (!items.length) {
      body.append(
        h(
          'div',
          { class: 'empty' },
          icon('state-ok'),
          h('strong', { text: 'Aucune mesure à proposer.' }),
          h('span', {
            text: data.zones.length
              ? 'Les zones évaluées sont à un niveau de risque faible et correctement équipées. Revenez ici après chaque évaluation ou changement d’équipement.'
              : 'Les mesures apparaîtront quand des zones seront définies et évaluées.',
          }),
        ),
      );
    } else {
      body.append(
        h('p', { class: 'panel-note', text: "Ce qu'il faut faire pour baisser l'indice, du plus urgent aux travaux. Le gain est la baisse de l'indice de la zone une fois la mesure réalisée. Chaque gain est calculé seul : ils ne s'additionnent pas, et l'indice ne descend jamais sous 1." }),
        h(
          'div',
          { class: 'risk-horizons' },
          ...HORIZONS.map((hz) => {
            const group = items.filter((p) => p.horizon === hz.id);
            const titleId = `risk-hz-${hz.id}`;
            return h(
              'section',
              { class: `risk-horizon hz-${hz.id}`, 'aria-labelledby': titleId },
              h(
                'div',
                { class: 'risk-horizon-head' },
                h('h3', { id: titleId, text: hz.title }),
                h('span', { class: 'hint', text: hz.sub }),
                group.length ? h('span', { class: 'tag is-apart', text: plural(group.length, 'mesure', 'mesures') }) : null,
              ),
              group.length ? h('ol', { class: 'prio-list' }, ...group.map((p) => priorityItem(p, admin))) : h('p', { class: 'risk-horizon-empty hint', text: hz.empty }),
            );
          }),
        ),
      );
    }
    return h('section', { class: 'panel risk-prio', 'aria-labelledby': 'risk-prio-title' }, head, body);
  }

  // ------------------------------------------------------------ évaluation (administrateur)

  function buildEditor(z) {
    const n = ++editorSeq;
    const fid = (name) => `risk-f${n}-${name}`;
    const titleId = fid('title');

    const field = (labelText, control, hintText) => {
      const hint = hintText ? h('span', { class: 'hint', id: `${control.id}-hint`, text: hintText }) : null;
      if (hint) control.setAttribute('aria-describedby', hint.id);
      return h('div', { class: 'field' }, h('label', { for: control.id, text: labelText }), control, hint);
    };
    const select = (name, labels, max, value) => {
      const el = h('select', { id: fid(name), name });
      for (let v = 1; v <= max; v++) el.append(h('option', { value: String(v), text: `${v} – ${labels[v]}` }));
      el.value = String(value);
      return el;
    };

    const probability = select('probability', P_LABEL, 3, z.p?.base ?? 2);
    const boxes = data.defenses.map((d) => {
      const input = h('input', { type: 'checkbox', name: 'defenses', value: d.id });
      input.checked = z.defenses.includes(d.id);
      return { d, input };
    });
    const impacts = IMPACTS.map((it) => ({ ...it, el: select(it.name, R_LABEL, 5, z.r?.[it.key] ?? 2) }));
    const notes = h('textarea', { id: fid('notes'), name: 'notes', rows: '3', maxlength: '500' });
    notes.value = z.notes ?? '';
    const notesHint = h('span', { class: 'hint', id: `${notes.id}-hint` });
    const countNotes = () => {
      notesHint.textContent = `Contexte, sources, hypothèses. ${notes.value.length} sur 500 caractères.`;
    };
    countNotes();
    notes.setAttribute('aria-describedby', notesHint.id);
    notes.addEventListener('input', countNotes);

    const errorBox = h('div', { class: 'notice is-alarm risk-form-error', role: 'alert' });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('check'), h('span', { text: "Enregistrer l'évaluation" }));
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => closeEditor(z.zone) }, h('span', { text: 'Annuler' }));
    let saving = false;
    const setBusy = (busy) => {
      saving = busy;
      submit.classList.toggle('is-busy', busy);
      if (busy) submit.setAttribute('aria-busy', 'true');
      else submit.removeAttribute('aria-busy');
      cancel.disabled = busy;
    };

    // Messages du serveur (server/risk.ts) -> champ concerné.
    const invalidField = (message) => {
      if (/^Notes/.test(message)) return notes;
      if (/probabilit/i.test(message)) return probability;
      if (/image/i.test(message)) return impacts[0].el;
      if (/économique/i.test(message)) return impacts[1].el;
      if (/humain/i.test(message)) return impacts[2].el;
      if (/défense/i.test(message)) return boxes[0]?.input ?? null;
      return null;
    };
    const clearInvalid = () => {
      for (const el of [probability, notes, ...impacts.map((it) => it.el), ...boxes.map((b) => b.input)]) el.removeAttribute('aria-invalid');
    };

    const impactsHelp = h('p', { class: 'hint', id: fid('impacts-hint'), text: 'Notez chacune de 1 (négligeable) à 5 (catastrophique). La plus grave des trois est retenue.' });
    const defensesHelp = h('p', { class: 'hint', id: fid('defenses-hint'), text: "Cochez seulement ce qui existe vraiment aujourd'hui dans la zone." });

    const form = h(
      'form',
      {
        class: 'risk-form',
        'aria-labelledby': titleId,
        onsubmit: async (e) => {
          e.preventDefault();
          if (saving) return;
          setBusy(true);
          errorBox.replaceChildren();
          clearInvalid();
          try {
            const result = await api(`/api/risk/zones/${encodeURIComponent(z.zone)}`, {
              method: 'PUT',
              body: {
                probability: Number(probability.value),
                defenses: boxes.filter((b) => b.input.checked).map((b) => b.d.id),
                impactImage: Number(impacts[0].el.value),
                impactEconomy: Number(impacts[1].el.value),
                impactHuman: Number(impacts[2].el.value),
                notes: notes.value,
              },
            });
            toast(`« ${z.zone} » évaluée${NB}: indice ${result.index} sur 60, niveau ${String(result.levelLabel).toLowerCase()}.`, 'ok');
            closeEditor(z.zone, true);
          } catch (err) {
            setBusy(false);
            errorBox.replaceChildren(icon('state-alarm'), h('span', { text: `L'évaluation n'est pas enregistrée${NB}: ${reasonOf(err)}. Corrigez si besoin, puis enregistrez à nouveau.` }));
            // Le champ que le serveur refuse est signalé et reçoit le focus (le message est lu par role=alert).
            const bad = invalidField(String(err?.message ?? ''));
            if (bad) {
              bad.setAttribute('aria-invalid', 'true');
              bad.focus();
            }
          }
        },
      },
      h(
        'div',
        { class: 'risk-form-grid' },
        h(
          'div',
          { class: 'risk-form-col' },
          field("Probabilité d'un départ de feu", probability, "Selon l'environnement et l'activité de la zone. Les incendies confirmés la relèvent d'eux-mêmes."),
          h(
            'fieldset',
            { 'aria-describedby': defensesHelp.id },
            h('legend', { text: 'Lignes de défense en place' }),
            defensesHelp,
            h('div', { class: 'risk-checks' }, ...boxes.map((b) => h('label', { class: 'check' }, b.input, h('span', { text: b.d.label })))),
          ),
        ),
        h(
          'div',
          { class: 'risk-form-col' },
          h(
            'fieldset',
            { 'aria-describedby': impactsHelp.id },
            h('legend', { text: "Répercussions d'un incendie dans cette zone" }),
            impactsHelp,
            h('div', { class: 'risk-impacts' }, ...impacts.map((it) => field(it.label, it.el))),
          ),
          h('div', { class: 'field' }, h('label', { for: notes.id, text: 'Notes (facultatif)' }), notes, notesHint),
        ),
      ),
      notice('info', 'info', "Le PSIM corrige lui-même la vulnérabilité selon l'état réel de la zone (détecteur absent ou hors service, aucune caméra) et la probabilité selon les incendies confirmés : ces corrections ne se saisissent pas."),
      errorBox,
      h('div', { class: 'actions' }, submit, cancel),
    );

    const el = h(
      'section',
      { class: 'risk-editor', id: 'risk-edit', 'aria-labelledby': titleId },
      h(
        'div',
        { class: 'risk-editor-head' },
        h('h4', { id: titleId }, icon('pencil'), z.assessed ? `Modifier l'évaluation de « ${z.zone} »` : `Évaluer la zone « ${z.zone} »`),
        h('p', { class: 'hint', text: "Trois questions : la chance qu'un feu se déclare, les protections en place, la gravité des conséquences. Le PSIM calcule l'indice." }),
      ),
      form,
    );
    return { zone: z.zone, user: getMe()?.username ?? '', el, first: probability };
  }

  async function openEditor(zone) {
    if (!isAdmin() || !data) return;
    if (editor?.zone === zone) {
      editor.el.scrollIntoView({ block: 'nearest' });
      editor.first.focus({ preventScroll: true });
      return;
    }
    if (editor && hasUnsavedInput(editor.el)) {
      const ok = await dialogs.confirm({ heading: 'Abandonner l’évaluation ?', message: `L’évaluation commencée pour « ${editor.zone} » n’est pas enregistrée. Ce qui a été saisi sera perdu.`, confirmLabel: 'Abandonner' });
      if (!ok) return;
      if (!data) return;
    }
    const z = data.zones.find((x) => x.zone === zone);
    if (!z) return;
    editor = buildEditor(z);
    render();
    editor.el.scrollIntoView({ block: 'start' });
    editor.first.focus({ preventScroll: true });
  }

  /** Ferme l'évaluation et rend le focus au bouton de la zone ; après un enregistrement, relit les chiffres. */
  function closeEditor(zone, saved = false) {
    editor = null;
    render();
    focusKey(`edit:${zone}`);
    refresh({ force: saved }); // après Annuler aussi : les chiffres reçus pendant l'évaluation n'avaient pas été rendus
  }

  // ------------------------------------------------------------ rendu

  function focusKey(key) {
    if (!key) return false;
    for (const el of root.querySelectorAll('[data-key]')) {
      if (el.dataset.key === key) {
        el.focus({ preventScroll: true });
        return true;
      }
    }
    return false;
  }

  function render() {
    if (!data) return;
    const active = document.activeElement;
    const key = root.contains(active) ? active.dataset?.key : undefined;
    const keepInEditor = editor?.el.contains(active) ? active : null;
    const admin = isAdmin();
    if (!admin) editor = null;
    root.replaceChildren(statusEl, sitePanel(admin), zonesPanel(admin), prioritiesPanel(admin));
    renderedFor = viewerKey();
    // La reconstruction ne fait pas perdre sa place au clavier.
    if (keepInEditor && editor?.el.contains(keepInEditor)) keepInEditor.focus({ preventScroll: true });
    else focusKey(key);
  }

  return {
    async show() {
      root.hidden = false;
      // Une évaluation laissée par un autre compte (déconnexion, puis autre connexion) ne survit pas.
      if (editor && (!isAdmin() || getMe()?.username !== editor.user)) editor = null;
      clearInterval(timer);
      if (!data) renderLoading();
      // Évaluation en cours : on réaffiche tel quel, sans relire (la saisie et sa zone restent intactes).
      if (!editor) await refresh();
      if (root.hidden) return; // écran quitté pendant la lecture (alarme, autre écran) : pas de minuterie
      clearInterval(timer);
      timer = setInterval(() => {
        if (!editor) refresh(); // pas de rechargement pendant une saisie
      }, REFRESH_MS);
    },
    hide() {
      root.hidden = true;
      clearInterval(timer);
      timer = null;
    },
    isOpen: () => !root.hidden,
  };
}
