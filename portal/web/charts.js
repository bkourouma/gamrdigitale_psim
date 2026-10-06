/**
 * Graphiques du portail : temps d'arrêt par jour (colonnes) et évolution de l'indice de sécurité GAMR (courbe sur
 * l'échelle 0 à 60, bandes pâles des niveaux en fond).
 *
 * Accessibles : chaque graphique se lit au pointeur ET au clavier (flèches gauche / droite, Début, Fin, Échap), décrit
 * son contenu en une phrase (aria-label) et se bascule en tableau qui donne les mêmes valeurs. Dessinés en SVG à la
 * largeur disponible, redessinés quand elle change (rotation du téléphone, fenêtre).
 */
import { h, s, icon, dataTable, dayTime, fmtAvail, fmtDay, fmtDayText, fmtDur, nf, shortDay, NB } from './ui.js';
import { BANDS, levelOf } from './gauge.js';

const DAY_MS = 86_400_000;
const observers = new Set();

/** Avant de remplacer un écran : on débranche les observateurs de taille des graphiques qui disparaissent. */
export function disposeCharts() {
  for (const o of observers) o.disconnect();
  observers.clear();
  hideTip();
}

// ------------------------------------------------------------------ bulle d'information (#tooltip) et annonce (#chart-live)

/**
 * La bulle (#tooltip) est visuelle seulement (aria-hidden) : réécrite à chaque mouvement du pointeur, elle saturerait
 * un lecteur d'écran. Au clavier, la valeur lue est annoncée une fois dans #chart-live, région toujours présente.
 */
function setTip(nodes) {
  const tip = document.getElementById('tooltip');
  if (!tip) return;
  tip.replaceChildren(...nodes.filter(Boolean));
  tip.hidden = false;
}

function placeTip(x, y) {
  const tip = document.getElementById('tooltip');
  if (!tip || tip.hidden) return;
  const w = tip.offsetWidth;
  const ht = tip.offsetHeight;
  // Position par le CSSOM (la politique de sécurité interdit l'attribut style, pas element.style).
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x + 14))}px`;
  tip.style.top = `${Math.max(8, Math.min(window.innerHeight - ht - 8, y - ht - 12))}px`;
}

export function hideTip() {
  const tip = document.getElementById('tooltip');
  if (tip) tip.hidden = true;
}

function announce(nodes) {
  const live = document.getElementById('chart-live');
  if (live) live.textContent = nodes.filter(Boolean).map((n) => n.textContent).join('. ');
}

/** Parcours d'un graphique au pointeur et au clavier : un seul index « courant », une seule bulle. */
function scrub(svg, { W, H, count, indexAt, anchor, mark, unmark, tip }) {
  let current = -1;
  const show = (i, clientX, clientY, { speak = false } = {}) => {
    i = Math.max(0, Math.min(count - 1, i));
    // Même jour sous le pointeur : on ne fait que déplacer la bulle (pas de contenu réécrit à chaque pixel).
    if (i !== current) {
      if (current >= 0) unmark(current);
      current = i;
      mark(i);
      const nodes = tip(i);
      setTip(nodes);
      if (speak) announce(nodes);
    }
    const [ax, ay] = anchor(i);
    const box = svg.getBoundingClientRect();
    placeTip(clientX ?? box.left + (ax / W) * box.width, clientY ?? box.top + (ay / H) * box.height);
  };
  const hide = () => {
    if (current >= 0) unmark(current);
    current = -1;
    hideTip();
  };
  const fromPointer = (e) => {
    const box = svg.getBoundingClientRect();
    show(indexAt(((e.clientX - box.left) / box.width) * W), e.clientX, e.clientY);
  };
  svg.addEventListener('pointermove', fromPointer);
  svg.addEventListener('pointerdown', fromPointer);
  // Au doigt, le navigateur envoie « pointerleave » dès que le doigt se lève : la bulle resterait invisible. Elle reste
  // donc affichée jusqu'au toucher suivant ailleurs (le graphique perd alors le focus : « blur »).
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'touch') hide();
  });
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      show(current < 0 ? count - 1 : current + (e.key === 'ArrowRight' ? 1 : -1), undefined, undefined, { speak: true });
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      show(e.key === 'Home' ? 0 : count - 1, undefined, undefined, { speak: true });
    } else if (e.key === 'Escape') hide();
  });
}

const svgText = (attrs, text) => s('text', attrs, text);

/**
 * Cadre commun : titre, bascule « Voir en tableau » / « Voir le graphique » (mémorisée dans `prefs[key]` pour survivre
 * au rafraîchissement de la minute), dessin à la largeur disponible.
 */
function chartPanel({ key, title, iconName, prefs, lead, note, draw, tableView, canToggle = true }) {
  const wrap = h('div', { class: 'chart-wrap' });
  const toggle = h('button', { class: 'btn btn-ghost btn-sm no-print', type: 'button', 'data-key': `toggle-${key}` });
  let lastW = 0;
  function render() {
    hideTip();
    const asTable = canToggle && prefs[key];
    toggle.replaceChildren(icon(asTable ? 'chart' : 'list'), asTable ? 'Voir le graphique' : 'Voir en tableau');
    if (asTable) return void wrap.replaceChildren(tableView());
    lastW = Math.round(wrap.clientWidth);
    draw(wrap, Math.max(300, lastW || 640));
  }
  toggle.addEventListener('click', () => {
    prefs[key] = !prefs[key];
    render();
  });
  queueMicrotask(render);
  const ro = new ResizeObserver(() => {
    const w = Math.round(wrap.clientWidth);
    if (w && Math.abs(w - lastW) > 4 && !(canToggle && prefs[key])) requestAnimationFrame(render);
  });
  ro.observe(wrap);
  observers.add(ro);
  return h(
    'section',
    { class: 'panel chart-panel' },
    h('div', { class: 'panel-head' }, h('h2', null, iconName && icon(iconName), title), canToggle && h('div', { class: 'actions' }, toggle)),
    h('div', { class: 'panel-body' }, lead, wrap, note && h('p', { class: 'panel-note' }, note)),
  );
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

// ------------------------------------------------------------------ temps d'arrêt par jour

/**
 * Durée réelle d'arrêt du système du site pendant un jour local (« AAAA-MM-JJ »), d'après les périodes transmises
 * (35 derniers jours au plus). `null` si le jour est plus ancien que ces périodes : la durée n'est pas connue.
 * Le champ `unmonitoredS` du jour, lui, additionne équipement par équipement (40 min × 11 équipements = 7 h 20).
 */
function blindOnDay(day, blind) {
  if (!blind) return null;
  const start = dayTime(day) - blind.offsetMin * 60_000;
  if (start + DAY_MS < Date.now() - 35 * DAY_MS) return null;
  const end = start + DAY_MS;
  return Math.round(blind.periods.reduce((sum, b) => sum + Math.max(0, Math.min(b.to, end) - Math.max(b.from, start)), 0) / 1000);
}

/**
 * Colonnes du temps d'arrêt par jour, depuis zéro (une disponibilité de 99,x % sur un axe tronqué serait trompeuse).
 * Un jour sans mesure (surveillance arrêtée) est un petit trait : ni disponible, ni en panne.
 * `stale` : le site ne répond plus ; ces jours s'arrêtent à son dernier signal, rien n'est affirmé au-delà.
 * `blind` : { periods, offsetMin } pour dire combien de temps la surveillance a été interrompue chaque jour.
 */
export function downtimeChart(daily, { prefs, title = 'Temps d’arrêt par jour', stale = false, blind = null } = {}) {
  const days = daily.length;
  const maxDown = Math.max(0, ...daily.map((d) => d.downS));
  const total = daily.reduce((a, d) => a + d.downS, 0);
  const longest = daily.reduce((a, d) => (d.downS > a.downS ? d : a), { downS: 0, day: '' });
  // Jours sans mesure (surveillance arrêtée) : ils se dessinent même sans aucun arrêt, pour ne pas laisser croire que
  // tout a fonctionné ces jours-là.
  const gaps = daily.filter((d) => d.pct === null).length;
  const interrupted = (d) => {
    if (!(d.unmonitoredS > 0)) return null;
    const real = blindOnDay(d.day, blind);
    return real ? fmtDur(real) : 'Oui';
  };

  const tableView = () =>
    dataTable(
      [['Jour'], ['Arrêt', true], ['Disponibilité', true], ['Surveillance interrompue', true]],
      [...daily].reverse().map((d) => h('tr', null, h('th', { scope: 'row' }, fmtDay(d.day, true)), h('td', { class: 'num' }, d.downS ? fmtDur(d.downS) : '0'), h('td', { class: 'num' }, fmtAvail(d.pct, d.downS)), h('td', { class: 'num' }, interrupted(d) ?? '—'))),
      { empty: 'Aucune mesure sur cette période.', caption: title },
    );

  function draw(wrap, W) {
    if (days === 0 || (maxDown === 0 && gaps === 0)) {
      const text =
        days === 0
          ? 'Pas encore de mesure sur cette période.'
          : stale
            ? `Aucun temps d’arrêt jusqu’au dernier signal du site${NB}; son état depuis n’est pas connu.`
            : `Aucun temps d’arrêt sur cette période${NB}: tous les équipements suivis ont fonctionné.`;
      wrap.replaceChildren(h('p', { class: 'chart-empty' }, icon(days === 0 || stale ? 'state-unknown' : 'state-ok'), text));
      return;
    }
    const H = 220;
    const unit = maxDown >= 7200 ? { div: 3600, label: 'h' } : { div: 60, label: 'min' };
    const top = niceMax(maxDown / unit.div);
    const axis = (v) => (v === 0 ? '0' : `${nf(v, 1)}${NB}${unit.label}`);
    // Marge gauche à la mesure du plus long libellé de l'axe (« 100 min » ne doit pas être rogné).
    const m = { l: Math.max(40, Math.max(...[top / 2, top].map((v) => axis(v).length)) * 7 + 14), r: 12, t: 12, b: 28 };
    const plotW = W - m.l - m.r;
    const plotH = H - m.t - m.b;
    const slot = plotW / days;
    const bw = Math.min(24, Math.max(2, slot * 0.62));
    const y = (v) => m.t + plotH - (v / unit.div / top) * plotH;
    const svg = s('svg', {
      viewBox: `0 0 ${W} ${H}`,
      width: W,
      height: H,
      class: 'chart-svg',
      role: 'img',
      tabindex: 0,
      'data-key': 'chart-downtime',
      'aria-label': `Temps d’arrêt par jour sur ${days} jours. Total ${fmtDur(total)}${longest.downS ? `, jour le plus long${NB}: ${fmtDay(longest.day)} (${fmtDur(longest.downS)})` : ''}${gaps ? `, ${gaps} ${gaps > 1 ? 'jours' : 'jour'} sans mesure` : ''}. Flèches gauche et droite pour lire chaque jour${NB}; le tableau donne les mêmes valeurs.`,
    });
    for (const v of [0, top / 2, top]) {
      const yy = m.t + plotH - (v / top) * plotH;
      svg.append(s('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy, class: v === 0 ? 'base' : 'grid' }), svgText({ x: m.l - 8, y: yy + 4, 'text-anchor': 'end' }, axis(v)));
    }
    const marks = [];
    daily.forEach((d, i) => {
      const x = m.l + i * slot + (slot - bw) / 2;
      if (d.downS > 0) {
        const hgt = Math.max(2, m.t + plotH - y(d.downS));
        const r = Math.min(4, hgt, bw / 2);
        const yy = m.t + plotH - hgt;
        const bar = s('path', { class: 'bar', d: `M${x},${yy + r} a${r},${r} 0 0 1 ${r},${-r} h${bw - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${hgt - r} h${-bw} z` });
        marks.push(bar);
        svg.append(bar);
      } else if (d.pct === null) {
        const tick = s('rect', { class: 'nodata', x, y: m.t + plotH - 5, width: bw, height: 3, rx: 1.5 });
        marks.push(tick);
        svg.append(tick);
      } else marks.push(null);
    });
    // Un repère de date tous les `every` jours, en partant du dernier : le plus récent est toujours nommé.
    const every = Math.max(1, Math.ceil(days / Math.max(2, Math.floor(plotW / 62))));
    for (let i = days - 1; i >= 0; i -= every) {
      const cx = m.l + i * slot + slot / 2;
      const atEdge = cx + 18 > W;
      svg.append(svgText({ x: atEdge ? W - 2 : cx, y: H - 8, 'text-anchor': atEdge ? 'end' : 'middle' }, shortDay(daily[i].day)));
    }
    const cross = s('line', { class: 'cross', y1: m.t, y2: m.t + plotH, visibility: 'hidden' });
    svg.append(cross);
    const cx = (i) => m.l + i * slot + slot / 2;
    scrub(svg, {
      W,
      H,
      count: days,
      // La zone sensible couvre toute la colonne du jour : jamais un pointeur à viser à 2 px près.
      indexAt: (vx) => Math.floor((vx - m.l) / slot),
      anchor: (i) => [cx(i), m.t],
      mark: (i) => {
        marks[i]?.classList.add('hot');
        cross.setAttribute('x1', cx(i));
        cross.setAttribute('x2', cx(i));
        cross.setAttribute('visibility', 'visible');
      },
      unmark: (i) => {
        marks[i]?.classList.remove('hot');
        cross.setAttribute('visibility', 'hidden');
      },
      tip: (i) => {
        const d = daily[i];
        const cut = interrupted(d);
        return [
          h('div', { class: 't-date' }, fmtDay(d.day, true)),
          h('div', { class: 't-value' }, d.downS ? `Arrêt${NB}: ${fmtDur(d.downS)}` : d.pct === null ? 'Pas de mesure' : 'Aucun arrêt'),
          d.pct !== null && h('div', { class: 't-sub' }, `Disponibilité${NB}: ${fmtAvail(d.pct, d.downS)}`),
          cut && h('div', { class: 't-sub' }, cut === 'Oui' ? 'Surveillance interrompue ce jour-là' : `Surveillance interrompue${NB}: ${cut}`),
        ];
      },
    });
    wrap.replaceChildren(svg);
  }

  return chartPanel({
    key: 'downtime',
    title,
    iconName: 'chart',
    prefs,
    draw,
    tableView,
    canToggle: days > 0,
    // La note n'a de sens que s'il y a des jours sans mesure à repérer.
    note: gaps ? `${gaps > 1 ? `Les ${gaps} jours` : 'Le jour'} sans mesure (surveillance arrêtée) ${gaps > 1 ? 'ne comptent' : 'ne compte'} ni comme ${gaps > 1 ? 'disponibles' : 'disponible'}, ni comme en panne${NB}; sur le graphique, ${gaps > 1 ? 'ils sont marqués' : 'il est marqué'} d’un petit trait gris.` : null,
  });
}

// ------------------------------------------------------------------ évolution de l'indice GAMR

/**
 * Lecture en mots de la tendance : un indice qui baisse veut dire un site MIEUX protégé. Le début et la fin ne
 * suffisent pas : un passage plus haut (au niveau critique, par exemple) ou plus bas entre les deux est dit aussi.
 */
function trendSentence(history) {
  const first = history[0].index;
  const last = history[history.length - 1].index;
  const values = history.map((p) => p.index);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const since = fmtDayText(history[0].day);
  if (max === min) return `Stable à ${last} sur 60 depuis le ${since}.`;
  const diff = last - first;
  const pts = `${Math.abs(diff)} point${Math.abs(diff) > 1 ? 's' : ''}`;
  const lead =
    diff === 0
      ? `De nouveau à ${last} sur 60, comme le ${since}.`
      : diff < 0
        ? `En baisse de ${pts} depuis le ${since} (de ${first} à ${last})${NB}: le site est mieux protégé qu’au début de la période.`
        : `En hausse de ${pts} depuis le ${since} (de ${first} à ${last})${NB}: le site est plus exposé qu’au début de la période.`;
  const extra = [];
  if (max > Math.max(first, last)) {
    const peak = history.find((p) => p.index === max);
    extra.push(`Au plus haut${NB}: ${max} (niveau ${levelOf(max).label.toLowerCase()}) le ${fmtDayText(peak.day)}.`);
  }
  if (min < Math.min(first, last)) {
    const low = history.find((p) => p.index === min);
    extra.push(`Au plus bas${NB}: ${min} (niveau ${levelOf(min).label.toLowerCase()}) le ${fmtDayText(low.day)}.`);
  }
  return [lead, ...extra].join(' ');
}

/**
 * Courbe de l'indice du site, un point par jour, sur l'échelle fixe 0 à 60 (jamais d'axe resserré : 30 doit toujours
 * avoir l'air de 30). Avec moins de deux points, une phrase le dit au lieu d'un graphique vide.
 */
export function riskTrend(history, { prefs, days }) {
  const title = 'Évolution de l’indice';
  if (history.length < 2) {
    const text =
      history.length === 0
        ? 'Pas encore d’historique de l’indice pour ce site : la courbe apparaîtra après quelques jours de calcul.'
        : `Un seul jour d’indice connu pour l’instant (${history[0].index} sur 60, le ${fmtDayText(history[0].day)})${NB}: la courbe apparaîtra dès le deuxième jour.`;    return h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, icon('history'), title)), h('div', { class: 'panel-body' }, h('p', { class: 'chart-empty' }, icon('state-unknown'), text)));
  }
  const n = history.length;
  const t0 = dayTime(history[0].day);
  const t1 = dayTime(history[n - 1].day);
  const span = Math.max(1, t1 - t0);
  const values = history.map((p) => p.index);
  const max = Math.max(...values);
  const min = Math.min(...values);

  const tableView = () =>
    dataTable(
      [['Jour'], ['Indice', true], ['Niveau']],
      [...history].reverse().map((p) => {
        const lvl = levelOf(p.index);
        return h('tr', null, h('th', { scope: 'row' }, fmtDay(p.day, true)), h('td', { class: 'num' }, `${p.index}/60`), h('td', null, h('span', { class: `level-word lvl-${lvl.level}` }, lvl.label)));
      }),
      { caption: title },
    );

  function draw(wrap, W) {
    const H = 230;
    const m = { l: 34, r: 34, t: 14, b: 28 };
    const plotW = W - m.l - m.r;
    const plotH = H - m.t - m.b;
    const x = (i) => m.l + ((dayTime(history[i].day) - t0) / span) * plotW;
    const y = (v) => m.t + plotH - (v / 60) * plotH;
    const svg = s('svg', {
      viewBox: `0 0 ${W} ${H}`,
      width: W,
      height: H,
      class: 'chart-svg trend',
      role: 'img',
      tabindex: 0,
      'data-key': 'chart-risk',
      'aria-label': `${title} du ${fmtDayText(history[0].day)} au ${fmtDayText(history[n - 1].day)}, sur l’échelle de 0 à 60${NB}: ${values[0]} au début, ${values[n - 1]} à la fin${NB}; au plus haut ${max}, au plus bas ${min}. Flèches gauche et droite pour lire chaque jour${NB}; le tableau donne les mêmes valeurs.`,
    });
    // Bandes pâles des quatre niveaux, en fond : on voit dans quel niveau se trouve chaque jour.
    let from = 0;
    for (const band of BANDS) {
      svg.append(s('rect', { class: `band ${band.level}`, x: m.l, y: y(band.max), width: plotW, height: y(from) - y(band.max) }));
      from = band.max;
    }
    for (const v of [0, 8, 20, 36, 60]) {
      svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v === 0 ? 'base' : 'grid' }), svgText({ x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, String(v)));
    }
    // Un jour manquant (site arrêté) coupe la courbe : on ne relie pas ce qu'on n'a pas mesuré.
    let d = '';
    history.forEach((p, i) => {
      const gap = i > 0 && dayTime(p.day) - dayTime(history[i - 1].day) > 86_400_000 * 1.5;
      d += `${i === 0 || gap ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.index).toFixed(1)} `;
    });
    svg.append(s('path', { class: 'line', d: d.trim() }));
    const showDots = n <= 14;
    const dots = history.map((p, i) => (showDots || i === 0 || i === n - 1 ? s('circle', { class: 'dot', cx: x(i), cy: y(p.index), r: 3.5 }) : null));
    for (const dot of dots) if (dot) svg.append(dot);
    const cursor = s('circle', { class: 'dot hot', r: 5, visibility: 'hidden' });
    svg.append(cursor);
    // Première et dernière valeurs écrites, au bout de la courbe.
    svg.append(svgText({ x: x(0) + 6, y: y(values[0]) - 10, 'text-anchor': 'start', class: 'end-label' }, String(values[0])));
    svg.append(svgText({ x: x(n - 1) + 8, y: y(values[n - 1]) + 5, 'text-anchor': 'start', class: 'end-label' }, String(values[n - 1])));
    // Repères de date : le premier, le dernier, et quelques-uns entre les deux s'il y a la place.
    const slots = Math.max(1, Math.min(n - 1, Math.floor(plotW / 70)));
    const labelled = new Set([0, n - 1]);
    for (let k = 1; k < slots; k++) labelled.add(Math.round((k * (n - 1)) / slots));
    for (const i of labelled) {
      const cx = x(i);
      const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      svg.append(svgText({ x: i === n - 1 ? Math.min(cx + 4, W - 2) : cx, y: H - 8, 'text-anchor': anchor }, shortDay(history[i].day)));
    }
    const cross = s('line', { class: 'cross', y1: m.t, y2: m.t + plotH, visibility: 'hidden' });
    svg.insertBefore(cross, svg.querySelector('.line'));
    scrub(svg, {
      W,
      H,
      count: n,
      indexAt: (vx) => {
        let best = 0;
        for (let i = 1; i < n; i++) if (Math.abs(x(i) - vx) < Math.abs(x(best) - vx)) best = i;
        return best;
      },
      anchor: (i) => [x(i), y(values[i])],
      mark: (i) => {
        cursor.setAttribute('cx', x(i));
        cursor.setAttribute('cy', y(values[i]));
        cursor.setAttribute('visibility', 'visible');
        cross.setAttribute('x1', x(i));
        cross.setAttribute('x2', x(i));
        cross.setAttribute('visibility', 'visible');
      },
      unmark: () => {
        cursor.setAttribute('visibility', 'hidden');
        cross.setAttribute('visibility', 'hidden');
      },
      tip: (i) => {
        const lvl = levelOf(values[i]);
        return [h('div', { class: 't-date' }, fmtDay(history[i].day, true)), h('div', { class: 't-value' }, `Indice ${values[i]} sur 60`), h('div', { class: `t-sub level-word lvl-${lvl.level}` }, `Niveau ${lvl.label.toLowerCase()}`)];
      },
    });
    wrap.replaceChildren(svg);
  }

  return chartPanel({
    key: 'risk',
    title,
    iconName: 'history',
    prefs,
    draw,
    tableView,
    lead: h('p', { class: 'trend-sentence' }, trendSentence(history)),
    note: n < days ? `Indice connu depuis le ${fmtDayText(history[0].day)}${NB}: un point par jour de calcul.` : `Un point par jour${NB}: l’indice du site tel qu’il a été calculé ce jour-là.`,
  });
}
