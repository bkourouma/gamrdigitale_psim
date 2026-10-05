// Portail de suivi : interface cliente. Tout texte venu des sites (noms, zones) est insere avec textContent, jamais en HTML.
const main = document.getElementById('main');
const topbar = document.getElementById('topbar');
const tooltip = document.getElementById('tooltip');

const state = { me: null, siteCount: 0, chartAsTable: false, timer: null };

// ------------------------------------------------------------------ petits outils

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v);
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}

/** Une forme PAR etat (cercle, triangle, octogone...) : l'icone et le texte portent le sens, la couleur ne fait que l'appuyer. */
function icon(level) {
  const common = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' };
  switch (level) {
    case 'ok': return s('svg', common, s('circle', { cx: 12, cy: 12, r: 9 }), s('path', { d: 'M8 12.5l3 3 5-6' }));
    case 'degraded': return s('svg', common, s('path', { d: 'M12 3.5l9.5 16.5h-19z' }), s('path', { d: 'M12 10v4' }), s('path', { d: 'M12 17.2h.01' }));
    case 'unreachable': return s('svg', common, s('circle', { cx: 12, cy: 12, r: 9 }), s('path', { d: 'M5.6 5.6l12.8 12.8' }));
    case 'alarm': return s('svg', common, s('polygon', { points: '8.3,3 15.7,3 21,8.3 21,15.7 15.7,21 8.3,21 3,15.7 3,8.3' }), s('path', { d: 'M12 7.5v5' }), s('path', { d: 'M12 16h.01' }));
    default: return s('svg', common, s('circle', { cx: 12, cy: 12, r: 9, 'stroke-dasharray': '3 3' }), s('path', { d: 'M12 7v5l3 2' }));
  }
}

const nf = (n, max = 2, min = 0) => n.toLocaleString('fr-FR', { minimumFractionDigits: min, maximumFractionDigits: max });
const fmtPct = (p) => (p === null || p === undefined ? '—' : `${nf(p, 2, 1)} %`);

function fmtDur(sec) {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return `${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  if (hours < 48) return rest ? `${hours} h ${String(rest).padStart(2, '0')}` : `${hours} h`;
  return `${Math.floor(hours / 24)} j ${hours % 24} h`;
}

function relTime(ms) {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} jours`;
}

/** Heure LOCALE DU SITE (le portail recoit le decalage horaire du site avec chaque resume). */
function fmtDateTime(ms, offsetMin = 0) {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms + offsetMin * 60_000));
}
function fmtDay(day, long = false) {
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: long ? 'long' : undefined, day: 'numeric', month: long ? 'long' : 'short' }).format(new Date(Date.UTC(y, m - 1, d)));
}
const shortDay = (day) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

const CATEGORY = { fire: 'Incendie', intrusion: 'Intrusion', access: 'Accès', environment: 'Environnement' };
const DEVICE_STATE = {
  normal: ['ok', 'En service'],
  prealarm: ['degraded', 'Préalarme'],
  alarm: ['alarm', 'Alarme'],
  fault: ['degraded', 'En défaut'],
  offline: ['unreachable', 'Ne répond plus'],
};
const QUALIFICATION = { fire: 'Événement réel', false_alarm: 'Fausse alarme' };
const INCIDENT_STATE = { open: 'Ouvert', acknowledged: 'Pris en charge', closed: 'Clos' };
const ROLE = { admin: 'Prestataire', director: 'Direction', site_manager: 'Responsable de site' };
const LEVEL_CHIP = { alarm: ['en alarme', 'en alarme'], unreachable: ['injoignable', 'injoignables'], degraded: ['à surveiller', 'à surveiller'], unknown: ['en attente', 'en attente'], ok: ['en bon état', 'en bon état'] };

/** Remplissage d'une jauge : par CSSOM (la politique de securite interdit l'attribut style). */
function meterFill(pct) {
  const el = document.createElement('i');
  el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  return el;
}

const pill = (level, text) => h('span', { class: `pill lvl-${level}` }, icon(level), text);

// ------------------------------------------------------------------ appels

async function api(path, init) {
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* corps vide */
  }
  if (res.status === 401 && path !== '/api/login') {
    state.me = null;
    showLogin();
    throw new Error('session');
  }
  if (res.status === 403 && body?.error === 'password_change_required') {
    showPassword(true);
    throw new Error('password');
  }
  if (!res.ok) throw Object.assign(new Error(body?.error ?? `Erreur ${res.status}`), { status: res.status });
  return body;
}

// ------------------------------------------------------------------ connexion et compte

function setChrome() {
  topbar.hidden = !state.me;
  document.getElementById('who').textContent = state.me ? `${state.me.displayName} · ${ROLE[state.me.role] ?? ''}` : '';
}

function field(id, label, type, { hint, ...attrs } = {}) {
  return h('div', { class: 'field' }, h('label', { for: id }, label), h('input', { id, name: id, type, required: true, ...attrs }), hint && h('span', { class: 'hint' }, hint));
}

function showLogin() {
  stopRefresh();
  setChrome();
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Se connecter');
  const form = h(
    'form',
    {
      class: 'card form-card',
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        error.hidden = true;
        try {
          state.me = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: form.username.value, password: form.password.value }) });
          start();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          submit.disabled = false;
          form.password.value = '';
          form.password.focus();
        }
      },
    },
    h('h1', null, 'Suivi de vos sites'),
    h('p', { class: 'sub' }, 'Connectez-vous pour voir l’état de votre protection.'),
    field('username', 'Identifiant', 'text', { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' }),
    field('password', 'Mot de passe', 'password', { autocomplete: 'current-password' }),
    error,
    submit,
  );
  main.replaceChildren(form);
  form.username.focus();
}

function showPassword(forced) {
  stopRefresh();
  setChrome();
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Enregistrer le nouveau mot de passe');
  const form = h(
    'form',
    {
      class: 'card form-card',
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        if (form.next.value !== form.again.value) {
          error.textContent = 'Les deux nouveaux mots de passe ne sont pas identiques.';
          error.hidden = false;
          return;
        }
        submit.disabled = true;
        try {
          state.me = await api('/api/password', { method: 'POST', body: JSON.stringify({ current: form.current.value, next: form.next.value }) });
          start();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          submit.disabled = false;
        }
      },
    },
    h('h1', null, forced ? 'Choisissez votre mot de passe' : 'Changer de mot de passe'),
    h('p', { class: 'sub' }, forced ? 'Le mot de passe provisoire qui vous a été remis ne sert qu’à cette première connexion.' : 'Vous resterez connecté après le changement.'),
    field('current', forced ? 'Mot de passe provisoire' : 'Mot de passe actuel', 'password', { autocomplete: 'current-password' }),
    field('next', 'Nouveau mot de passe', 'password', { autocomplete: 'new-password', minlength: '12', hint: '12 caractères au minimum, sans votre identifiant ni un mot courant.' }),
    field('again', 'Nouveau mot de passe, une seconde fois', 'password', { autocomplete: 'new-password' }),
    error,
    submit,
    !forced && h('button', { type: 'button', class: 'btn ghost mt-s', onclick: () => route() }, 'Annuler'),
  );
  main.replaceChildren(form);
  form.current.focus();
}

document.getElementById('btn-logout').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
  } catch {
    /* deja deconnecte */
  }
  state.me = null;
  showLogin();
});
document.getElementById('btn-password').addEventListener('click', () => showPassword(false));

// ------------------------------------------------------------------ elements communs

function statusBlock(status, extra) {
  return h('div', { class: `status lvl-${status.level}` }, icon(status.level), h('div', null, h('p', { class: 'label' }, status.label), h('p', { class: 'detail' }, status.detail), extra));
}

function tile(name, value, note) {
  return h('div', { class: 'card tile' }, h('p', { class: 'name' }, name), h('p', { class: 'value' }, value), note && h('p', { class: 'note' }, note));
}

function hero(label, pct, note) {
  const text = pct === null ? '—' : nf(pct, 2, 1);
  return h('div', { class: 'card hero' }, h('p', { class: 'sub' }, label), h('p', { class: 'figure' }, text, pct !== null && h('small', null, ' %')), note && h('p', { class: 'note sub mt-xs' }, note));
}

const table = (head, rows, empty) =>
  rows.length === 0
    ? h('p', { class: 'none' }, empty)
    : h('div', { class: 'table-scroll' }, h('table', null, h('thead', null, h('tr', null, head.map(([t, num]) => h('th', { class: num ? 'num' : '', scope: 'col' }, t)))), h('tbody', null, rows)));

// ------------------------------------------------------------------ accueil

async function renderHome() {
  const [overview, sites] = await Promise.all([api('/api/overview'), api('/api/sites')]);
  state.siteCount = sites.length;
  if (sites.length === 1) return void location.replace(`#/site/${encodeURIComponent(sites[0].id)}`);

  const chips = h('div', { class: 'chips home-chips', 'aria-label': 'Répartition de vos sites par état' });
  for (const level of ['alarm', 'unreachable', 'degraded', 'unknown', 'ok']) {
    const n = overview.counts[level];
    if (n > 0) chips.append(h('span', { class: `chip lvl-${level}` }, icon(level), `${n} ${n > 1 ? 'sites' : 'site'} ${LEVEL_CHIP[level][n > 1 ? 1 : 0]}`));
  }
  const inc = overview.incidents30;
  const summary = h(
    'div',
    { class: 'summary home-summary' },
    hero('Protection assurée sur 30 jours', overview.availability30, 'Moyenne de tous vos sites, pondérée par le temps observé.'),
    tile('Incidents sur 30 jours', String(inc.total), `${inc.real} réel${inc.real > 1 ? 's' : ''} · ${inc.falseAlarms} fausse${inc.falseAlarms > 1 ? 's' : ''} alarme${inc.falseAlarms > 1 ? 's' : ''}`),
    tile('Incidents en cours', String(overview.openNow), overview.openNow ? 'À suivre en priorité' : 'Aucun pour le moment'),
    tile('Prise en charge', fmtDur(inc.ackMedianS), 'Délai médian entre l’alerte et sa prise en charge'),
  );
  const list = h(
    'div',
    { class: 'sites home-sites' },
    sites.map((c) =>
      h(
        'a',
        { class: 'site', href: `#/site/${encodeURIComponent(c.id)}` },
        h('div', null, h('p', { class: 'name' }, c.name), state.me.role === 'admin' && h('p', { class: 'org' }, c.organization)),
        statusBlock(c.status),
        h('p', { class: 'meta' }, h('span', null, 'Disponibilité (30 j) : ', h('strong', null, fmtPct(c.availability30))), h('span', null, c.lastReceivedAt ? `Dernier signal ${relTime(c.lastReceivedAt)}` : 'Aucun signal reçu')),
      ),
    ),
  );
  return [h('h1', { class: 'page-title' }, 'Vos sites'), chips, summary, sites.length ? list : h('p', { class: 'none' }, 'Aucun site n’est rattaché à votre compte.')];
}

// ------------------------------------------------------------------ detail d'un site

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** Colonnes du temps d'arret par jour : depuis zero (une disponibilite de 99,x % sur un axe tronque serait trompeuse). */
function chartSection(daily, offsetMin) {
  const days = daily.length;
  const maxDown = Math.max(0, ...daily.map((d) => d.downS));
  const total = daily.reduce((a, d) => a + d.downS, 0);
  const longest = daily.reduce((a, d) => (d.downS > a.downS ? d : a), { downS: 0, day: '' });
  const wrap = h('div', { class: 'chart-wrap' });
  const toggle = h('button', { class: 'btn ghost', type: 'button', 'aria-pressed': String(state.chartAsTable), onclick: () => { state.chartAsTable = !state.chartAsTable; draw(); } });

  function tableView() {
    return table(
      [['Jour'], ['Arrêt', true], ['Disponibilité', true], ['Non surveillé', true]],
      [...daily].reverse().map((d) => h('tr', null, h('td', null, fmtDay(d.day, true)), h('td', { class: 'num' }, d.downS ? fmtDur(d.downS) : '0'), h('td', { class: 'num' }, fmtPct(d.pct)), h('td', { class: 'num' }, d.unmonitoredS ? fmtDur(d.unmonitoredS) : '—'))),
      'Aucune mesure sur cette période.',
    );
  }

  function draw() {
    toggle.textContent = state.chartAsTable ? 'Voir le graphique' : 'Voir en tableau';
    toggle.setAttribute('aria-pressed', String(state.chartAsTable));
    hideTip();
    if (state.chartAsTable) return void wrap.replaceChildren(tableView());
    if (days === 0 || maxDown === 0) return void wrap.replaceChildren(h('p', { class: 'empty-chart' }, days === 0 ? 'Pas encore de mesure sur cette période.' : 'Aucun temps d’arrêt sur cette période.'));

    const W = Math.max(300, Math.round(wrap.clientWidth || 640));
    const H = 220;
    const m = { l: 46, r: 14, t: 10, b: 28 };
    const unit = maxDown >= 7200 ? { div: 3600, label: 'h' } : { div: 60, label: 'min' };
    const top = niceMax(maxDown / unit.div);
    const plotW = W - m.l - m.r;
    const plotH = H - m.t - m.b;
    const slot = plotW / days;
    const bw = Math.min(24, Math.max(2, slot * 0.62));
    const y = (v) => m.t + plotH - (v / unit.div / top) * plotH;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', tabindex: '0', class: 'chart', 'aria-label': `Temps d’arrêt par jour sur ${days} jours. Total ${fmtDur(total)}${longest.downS ? `, jour le plus long : ${fmtDay(longest.day)} (${fmtDur(longest.downS)})` : ''}. Le tableau donne les mêmes valeurs.` });

    for (const v of [0, top / 2, top]) {
      const yy = m.t + plotH - (v / top) * plotH;
      svg.append(s('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy, class: v === 0 ? 'base' : 'grid' }), (() => { const t = s('text', { x: m.l - 8, y: yy + 4, 'text-anchor': 'end' }); t.textContent = v === 0 ? '0' : `${nf(v, 1)} ${unit.label}`; return t; })());
    }
    const bars = [];
    daily.forEach((d, i) => {
      const x = m.l + i * slot + (slot - bw) / 2;
      if (d.downS > 0) {
        const hgt = Math.max(2, m.t + plotH - y(d.downS));
        const r = Math.min(4, hgt, bw / 2);
        const yy = m.t + plotH - hgt;
        const bar = s('path', { class: 'bar', d: `M${x},${yy + r} a${r},${r} 0 0 1 ${r},${-r} h${bw - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${hgt - r} h${-bw} z` });
        bars.push(bar);
        svg.append(bar);
      } else if (d.pct === null) {
        const tick = s('rect', { class: 'nodata', x, y: m.t + plotH - 5, width: bw, height: 3, rx: 1.5 });
        bars.push(tick);
        svg.append(tick);
      } else bars.push(null);
    });
    // Un repere de date tous les `every` jours, en partant du dernier jour : le plus recent est toujours nomme.
    const every = Math.max(1, Math.ceil(days / Math.max(2, Math.floor(plotW / 62))));
    for (let i = days - 1; i >= 0; i -= every) {
      // Le dernier repere ne doit pas deborder du cadre : il s'aligne vers l'interieur s'il est trop pres du bord.
      const cx = m.l + i * slot + slot / 2;
      const atEdge = cx + 18 > W;
      const t = s('text', { x: atEdge ? W - 2 : cx, y: H - 8, 'text-anchor': atEdge ? 'end' : 'middle' });
      t.textContent = shortDay(daily[i].day);
      svg.append(t);
    }
    const cross = s('line', { class: 'cross', y1: m.t, y2: m.t + plotH, visibility: 'hidden' });
    svg.append(cross);

    let current = -1;
    const show = (i, clientX, clientY) => {
      i = Math.max(0, Math.min(days - 1, i));
      if (current >= 0) bars[current]?.classList.remove('hot');
      current = i;
      bars[i]?.classList.add('hot');
      const cx = m.l + i * slot + slot / 2;
      cross.setAttribute('x1', cx);
      cross.setAttribute('x2', cx);
      cross.setAttribute('visibility', 'visible');
      const d = daily[i];
      const box = svg.getBoundingClientRect();
      showTip(d, offsetMin, clientX ?? box.left + (cx / W) * box.width, clientY ?? box.top + (m.t / H) * box.height);
    };
    const hide = () => {
      if (current >= 0) bars[current]?.classList.remove('hot');
      current = -1;
      cross.setAttribute('visibility', 'hidden');
      hideTip();
    };
    // La zone sensible couvre toute la colonne du jour (pas seulement la barre) : jamais un pointeur a viser a 2 px pres.
    svg.addEventListener('pointermove', (e) => {
      const box = svg.getBoundingClientRect();
      show(Math.floor((((e.clientX - box.left) / box.width) * W - m.l) / slot), e.clientX, e.clientY);
    });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        show(current < 0 ? days - 1 : current + (e.key === 'ArrowRight' ? 1 : -1));
      } else if (e.key === 'Escape') hide();
    });
    wrap.replaceChildren(svg);
  }

  const card = h('section', { class: 'card chart' }, h('div', { class: 'chart-head' }, h('h2', null, 'Temps d’arrêt par jour'), toggle), wrap, h('p', { class: 'note-box' }, 'Les jours sans mesure (surveillance arrêtée) sont marqués d’un petit trait gris : ils ne comptent ni comme disponibles, ni comme en panne.'));
  // Le graphique se redessine quand la largeur change (rotation du telephone, fenetre).
  queueMicrotask(draw);
  let last = 0;
  new ResizeObserver(() => {
    const w = Math.round(wrap.clientWidth);
    if (w && Math.abs(w - last) > 4 && !state.chartAsTable) {
      last = w;
      requestAnimationFrame(draw);
    }
  }).observe(wrap);
  return card;
}

function showTip(d, offsetMin, x, y) {
  const lines = [
    h('div', { class: 't-date' }, fmtDay(d.day, true)),
    h('div', { class: 't-row' }, h('span', { class: 't-key' }), h('span', { class: 't-value' }, d.downS ? `Arrêt : ${fmtDur(d.downS)}` : d.pct === null ? 'Pas de mesure' : 'Aucun arrêt')),
    d.pct !== null && h('div', { class: 't-sub' }, `Disponibilité : ${fmtPct(d.pct)}`),
    d.unmonitoredS > 0 && h('div', { class: 't-sub' }, `Non surveillé : ${fmtDur(d.unmonitoredS)}`),
  ];
  tooltip.replaceChildren(...lines.filter(Boolean));
  tooltip.hidden = false;
  const w = tooltip.offsetWidth;
  const hgt = tooltip.offsetHeight;
  tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x + 14))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(window.innerHeight - hgt - 8, y - hgt - 10))}px`;
}
function hideTip() {
  tooltip.hidden = true;
}

function equipmentTable(detail) {
  const avail = new Map(detail.deviceAvailability.map((a) => [a.deviceId, a]));
  const rows = detail.devices.map((d) => {
    const [level, label] = d.kind === 'camera' ? ['unknown', 'Non mesuré'] : (DEVICE_STATE[d.status] ?? ['unknown', d.status]);
    const a = avail.get(d.id);
    return h('tr', null, h('td', null, d.name), h('td', null, d.kind === 'camera' ? 'Caméra' : (CATEGORY[d.category] ?? d.category)), h('td', null, [d.zone, d.floor].filter(Boolean).join(' · ') || '—'), h('td', null, pill(level, label)), h('td', { class: 'num' }, a ? fmtPct(a.pct) : '—'));
  });
  return h('section', { class: 'card' }, h('h2', null, 'Équipements'), table([['Équipement'], ['Type'], ['Emplacement'], ['État'], ['Disponibilité (35 j)', true]], rows, 'Aucun équipement déclaré.'), detail.devices.some((d) => d.kind === 'camera') && h('p', { class: 'note-box' }, 'L’état des caméras n’est pas mesuré en continu : aucun pourcentage n’est annoncé pour elles.'));
}

function zonesTable(detail) {
  const rows = detail.zones.map((z) =>
    h('tr', null, h('td', null, z.zone || 'Hors zone'), h('td', { class: 'num' }, String(z.devices)), h('td', null, h('span', null, fmtPct(z.pct)), z.pct !== null && h('span', { class: 'meter', 'aria-hidden': 'true' }, meterFill(z.pct))), h('td', { class: 'num' }, z.downS ? fmtDur(z.downS) : '0')),
  );
  return h('section', { class: 'card' }, h('h2', null, 'Zones'), h('p', { class: 'sub lead' }, 'Sur les 35 derniers jours'), table([['Zone'], ['Équipements', true], ['Disponibilité'], ['Arrêt cumulé', true]], rows, 'Aucune zone déclarée.'));
}

function outagesTable(detail) {
  const off = detail.utcOffsetMin;
  const rows = detail.outages.map((o) =>
    h('tr', null, h('td', null, o.deviceName), h('td', null, o.zone || '—'), h('td', null, fmtDateTime(o.from, off)), h('td', { class: 'num' }, fmtDur(o.durationS)), h('td', null, o.to === null ? pill('degraded', 'En cours') : o.cause === 'fault' ? 'Défaut signalé' : 'Ne répondait plus')),
  );
  return h('section', { class: 'card' }, h('h2', null, 'Pannes d’équipement'), table([['Équipement'], ['Zone'], ['Début'], ['Durée', true], ['Cause']], rows, 'Aucune panne sur cette période.'));
}

function incidentsTable(detail) {
  const off = detail.utcOffsetMin;
  const st = detail.incidentStats;
  const rows = detail.incidents.map((i) => {
    const level = i.status === 'closed' ? 'ok' : i.severity === 'critical' ? 'alarm' : 'degraded';
    return h('tr', null, h('td', null, fmtDateTime(i.openedAt, off)), h('td', null, i.deviceName, i.zone && h('div', { class: 'sub' }, i.zone)), h('td', null, CATEGORY[i.category] ?? i.category), h('td', null, pill(level, i.status === 'closed' ? (QUALIFICATION[i.qualification] ?? 'Clos') : INCIDENT_STATE[i.status])), h('td', { class: 'num' }, i.ackedAt ? fmtDur(Math.round((i.ackedAt - i.openedAt) / 1000)) : '—'));
  });
  return h(
    'section',
    { class: 'card' },
    h('h2', null, 'Incidents'),
    st.total > 0 && h('p', { class: 'sub lead' }, `${st.total} sur la période : ${st.real} réel${st.real > 1 ? 's' : ''}, ${st.falseAlarms} fausse${st.falseAlarms > 1 ? 's' : ''} alarme${st.falseAlarms > 1 ? 's' : ''}${st.open ? `, ${st.open} en cours` : ''}.`),
    table([['Ouverture'], ['Équipement'], ['Type'], ['État'], ['Prise en charge', true]], rows, 'Aucun incident sur cette période.'),
  );
}

async function renderSite(id, days) {
  let d;
  try {
    d = await api(`/api/sites/${encodeURIComponent(id)}?days=${days}`);
  } catch (err) {
    if (err.status === 404) return [h('a', { class: 'crumb', href: '#/' }, '← Tous les sites'), h('p', { class: 'none' }, 'Ce site est introuvable.')];
    throw err;
  }
  if (!state.siteCount) state.siteCount = (await api('/api/sites')).length;
  // Rien recu : aucun chiffre. « 0 incident » et « aucun arret » se liraient comme une bonne nouvelle alors que rien n'est mesure.
  if (d.status.level === 'unknown' && d.devices.length === 0) {
    return [
      state.siteCount > 1 && h('a', { class: 'crumb', href: '#/' }, '← Tous les sites'),
      h('div', null, h('h1', { class: 'page-title' }, d.site.name), state.me.role === 'admin' && d.site.organization !== d.site.name && h('p', { class: 'sub' }, d.site.organization)),
      h('section', { class: 'card banner lvl-unknown' }, statusBlock(d.status)),
      h('section', { class: 'card' }, h('h2', null, 'Et ensuite ?'), h('p', { class: 'sub' }, 'Les chiffres, le graphique et la liste des équipements apparaîtront ici dès que le système de surveillance de ce site aura envoyé son premier résumé, quelques minutes après sa mise en route ou son redémarrage.')),
    ];
  }
  // Des equipements recus mais aucun detecteur : on les montre, sans chiffre de disponibilite (il n'y a rien a mesurer).
  if (d.status.level === 'unknown') {
    return [
      state.siteCount > 1 && h('a', { class: 'crumb', href: '#/' }, '← Tous les sites'),
      h('div', null, h('h1', { class: 'page-title' }, d.site.name), state.me.role === 'admin' && d.site.organization !== d.site.name && h('p', { class: 'sub' }, d.site.organization)),
      h('section', { class: 'card banner lvl-unknown' }, statusBlock(d.status, h('p', { class: 'detail mt-xs' }, d.lastReceivedAt ? `Dernier signal du site ${relTime(d.lastReceivedAt)}.` : ''))),
      equipmentTable(d),
    ];
  }
  const a = d.availability;
  const first = d.daily[0]?.day;
  const notes = [];
  if (a.unmonitoredS > 0) notes.push(`${fmtDur(a.unmonitoredS)} sans surveillance, non comptées.`);
  if (d.daily.length < days && first) notes.push(`Mesures disponibles depuis le ${fmtDay(first)}.`);

  const filters = h('div', { class: 'filters' }, h('div', { class: 'seg', role: 'group', 'aria-label': 'Période affichée' }, [7, 30, 90].map((n) => h('button', { type: 'button', 'aria-pressed': String(n === days), onclick: () => (location.hash = `#/site/${encodeURIComponent(id)}?days=${n}`) }, `${n} jours`))));
  const st = d.incidentStats;
  const blind = d.blindPeriods;

  return [
    state.siteCount > 1 && h('a', { class: 'crumb', href: '#/' }, '← Tous les sites'),
    h('div', null, h('h1', { class: 'page-title' }, d.site.name), state.me.role === 'admin' && d.site.organization !== d.site.name && h('p', { class: 'sub' }, d.site.organization)),
    h('section', { class: `card banner lvl-${d.status.level}` }, statusBlock(d.status, h('p', { class: 'detail mt-xs' }, d.lastReceivedAt ? `Dernier signal du site ${relTime(d.lastReceivedAt)}.` : ''))),
    filters,
    h(
      'div',
      { class: 'summary' },
      hero(`Protection assurée sur ${days} jours`, a.pct, notes.join(' ') || 'Part du temps où les équipements étaient en état de détecter.'),
      tile('Temps d’arrêt cumulé', a.downS ? fmtDur(a.downS) : 'Aucun', `${d.outages.length} panne${d.outages.length > 1 ? 's' : ''} d’équipement`),
      tile('Incidents', String(st.total), `${st.real} réel${st.real > 1 ? 's' : ''} · ${st.falseAlarms} fausse${st.falseAlarms > 1 ? 's' : ''} alarme${st.falseAlarms > 1 ? 's' : ''}`),
      tile('Prise en charge', fmtDur(st.ackMedianS), 'Délai médian entre l’alerte et sa prise en charge'),
    ),
    chartSection(d.daily, d.utcOffsetMin),
    h('div', { class: 'two' }, zonesTable(d), outagesTable(d)),
    equipmentTable(d),
    incidentsTable(d),
    blind.length > 0 && h('section', { class: 'card' }, h('h2', null, 'Surveillance interrompue'), h('p', { class: 'sub lead' }, 'Périodes où le système de surveillance du site était arrêté. Rien n’y était surveillé.'), table([['Du'], ['Au'], ['Durée', true]], [...blind].reverse().map((b) => h('tr', null, h('td', null, fmtDateTime(b.from, d.utcOffsetMin)), h('td', null, fmtDateTime(b.to, d.utcOffsetMin)), h('td', { class: 'num' }, fmtDur(Math.round((b.to - b.from) / 1000))))), '')),
    d.notifications && h('p', { class: 'sub' }, `Alertes envoyées sur 35 jours : ${d.notifications.sent}${d.notifications.failed ? ` (${d.notifications.failed} en échec)` : ''}. Les chiffres se mettent à jour toutes les quelques minutes ; heures affichées à l’heure locale du site.`),
  ];
}

// ------------------------------------------------------------------ navigation

async function route(quiet = false) {
  if (!state.me) return showLogin();
  setChrome();
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const match = path.match(/^\/site\/([^/]+)$/);
  main.classList.add('loading');
  try {
    const content = match ? await renderSite(decodeURIComponent(match[1]), Number(new URLSearchParams(query).get('days')) || 30) : await renderHome();
    if (!content) return; // redirection en cours
    main.replaceChildren(...content.filter(Boolean));
    if (!quiet) window.scrollTo(0, 0);
  } catch (err) {
    if (!['session', 'password'].includes(err.message)) {
      main.replaceChildren(h('section', { class: 'card' }, h('p', { class: 'error', role: 'alert' }, 'Impossible de charger les données pour le moment.'), h('button', { class: 'btn ghost', type: 'button', onclick: () => route() }, 'Réessayer')));
    }
  } finally {
    main.classList.remove('loading');
  }
}

function stopRefresh() {
  clearInterval(state.timer);
  state.timer = null;
}
function start() {
  setChrome();
  stopRefresh();
  // Les chiffres bougent : on les rafraichit chaque minute, sans vider l'ecran (l'ancien reste, attenue, jusqu'au nouveau).
  state.timer = setInterval(() => {
    if (document.visibilityState === 'visible' && state.me) route(true);
  }, 60_000);
  route();
}

window.addEventListener('hashchange', () => route());

(async () => {
  try {
    state.me = await api('/api/me');
    if (state.me.mustChangePassword) showPassword(true);
    else start();
  } catch {
    showLogin();
  }
})();
