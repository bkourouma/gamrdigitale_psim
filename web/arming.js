// Armement des zones d'intrusion : état, désarmement à durée limitée (opérateur), planning hebdomadaire (administrateur).
//
// Chaque zone est une carte gardée d'un rafraîchissement à l'autre. Le serveur republie l'état à chaque changement
// (désarmement, planning, début ou fin d'une plage), même quand un autre écran est affiché : la carte est mise à jour
// sur place, et un planning en cours de saisie n'est jamais remplacé (ni par un rafraîchissement, ni par un changement
// d'écran, ni par une modification faite depuis un autre poste, qui est signalée).
import { icon } from './core.js';

const DAY_SHORT = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const DAY_LONG = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // la semaine commence le lundi
const DURATIONS = [1, 4, 12, 24]; // désarmement : durées proposées, en heures (24 h au plus côté serveur)
const ARM_HOURS = 12; // « Armer maintenant » : réglage manuel de 12 h, puis le planning reprend
const MAX_WINDOWS = 14; // comme server/arming.ts
const DAY_MIN = 24 * 60;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const suggestion = () => ({ days: [1, 2, 3, 4, 5], from: '19:00', to: '07:00' });

const minutesOf = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const clone = (windows) => (windows ?? []).map((w) => ({ days: [...w.days], from: w.from, to: w.to }));
const sortedDays = (days) => [...new Set(days)].sort((a, b) => a - b);
/** Forme comparable d'un planning : sert à savoir s'il reste des modifications à enregistrer. */
const keyOf = (windows) => JSON.stringify((windows ?? []).map((w) => [sortedDays(w.days), w.from, w.to]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** Message du serveur en phrase : majuscule au début, point à la fin. */
const sentence = (s) => {
  const t = cap(String(s ?? '').trim());
  return /[.!?…]$/.test(t) ? t : `${t}.`;
};

/** Problème d'une plage du planning, en mots, ou null. Mêmes règles que le serveur. */
function slotProblem(w) {
  if (!w.days.length) return 'Choisissez au moins un jour.';
  if (!TIME.test(w.from) || !TIME.test(w.to)) return "Indiquez l'heure de début et l'heure de fin.";
  if (w.from === w.to) return 'Le début et la fin sont identiques : choisissez deux heures différentes.';
  return null;
}

/** « du lundi au vendredi », « samedi et dimanche », « tous les jours », « le mercredi ». */
function daysText(days) {
  const set = new Set(days);
  if (set.size === 7) return 'tous les jours';
  const order = DAY_ORDER.filter((d) => set.has(d));
  const pos = order.map((d) => DAY_ORDER.indexOf(d));
  if (order.length >= 3 && pos.every((p, i) => i === 0 || p === pos[i - 1] + 1)) return `du ${DAY_LONG[order[0]]} au ${DAY_LONG[order.at(-1)]}`;
  const names = order.map((d) => DAY_LONG[d]);
  return names.length === 1 ? `le ${names[0]}` : `${names.slice(0, -1).join(', ')} et ${names.at(-1)}`;
}

const clock = (t) => (t === '00:00' ? 'minuit' : t);

/** Une plage en clair : « Du lundi au vendredi, de 19:00 à 07:00 le lendemain ». */
function windowText(w) {
  const night = minutesOf(w.to) < minutesOf(w.from);
  return `${cap(daysText(w.days))}, de ${clock(w.from)} à ${clock(w.to)}${night && w.to !== '00:00' ? ' le lendemain' : ''}`;
}

/** Échéance lisible d'un coup d'œil : « 15:42 » (aujourd'hui), « demain 07:00 », « lundi 07:00 ». */
function when(ts) {
  const d = new Date(ts);
  const hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const n = Math.round((day - today) / 86_400_000);
  if (n === 0) return hm;
  if (n === 1) return `demain ${hm}`;
  if (n > 1 && n < 7) return `${DAY_LONG[d.getDay()]} ${hm}`;
  return `${d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}, ${hm}`;
}

/** Moment passé : « à 11:42 » (aujourd'hui), « hier à 22:10 », « le 3 octobre à 08:00 ». */
function since(ts) {
  const d = new Date(ts);
  const hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (ts >= today.getTime()) return `à ${hm}`;
  if (ts >= today.getTime() - 86_400_000) return `hier à ${hm}`;
  return `le ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })} à ${hm}`;
}

/** Temps restant : « dans 12 min », « dans 3 h 05 ». */
function inTime(ts) {
  const min = Math.ceil((ts - Date.now()) / 60_000);
  if (min <= 1) return "dans moins d'une minute";
  if (min < 60) return `dans ${min} min`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  if (hours < 48) return rest ? `dans ${hours} h ${String(rest).padStart(2, '0')}` : `dans ${hours} h`;
  return `dans ${Math.round(hours / 24)} jours`;
}

/**
 * Plages armées de la semaine, jour par jour (0 = dimanche) : intervalles [début, fin) en minutes, fusionnés.
 * Une plage de nuit (19:00 -> 07:00) déborde sur le lendemain, comme le calcule le serveur ; celle du dimanche
 * déborde sur le lundi. Sans planning (null), la zone est armée jour et nuit.
 */
function weekSegments(windows) {
  const days = Array.from({ length: 7 }, () => []);
  if (windows === null) {
    for (const list of days) list.push([0, DAY_MIN]);
    return days;
  }
  for (const w of windows) {
    if (slotProblem(w)) continue; // une plage incomplète (aperçu en cours de saisie) n'est pas dessinée
    const from = minutesOf(w.from);
    const to = minutesOf(w.to);
    for (const d of new Set(w.days)) {
      if (from < to) days[d].push([from, to]);
      else {
        days[d].push([from, DAY_MIN]);
        if (to > 0) days[(d + 1) % 7].push([0, to]);
      }
    }
  }
  return days.map((list) =>
    list
      .sort((a, b) => a[0] - b[0])
      .reduce((out, [a, b]) => {
        const last = out.at(-1);
        if (last && a <= last[1]) last[1] = Math.max(last[1], b);
        else out.push([a, b]);
        return out;
      }, []),
  );
}

/** Réglage manuel en cours, de maintenant à son échéance (24 h au plus) : morceaux par jour pour la frise. */
function overridePieces(o) {
  const pieces = [];
  const minuteOf = (d) => d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  let t = Math.max(Date.now(), o.at);
  while (t < o.until && pieces.length < 3) {
    const d = new Date(t);
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const stop = Math.min(o.until, midnight);
    pieces.push({ day: d.getDay(), a: minuteOf(d), b: stop === midnight ? DAY_MIN : minuteOf(new Date(stop)) });
    t = stop;
  }
  return pieces;
}

export function summarizeSchedule(windows) {
  return windows.map(windowText).join(' ; ');
}

export function createArmingView({ api, h, toast, getMe, onZones }) {
  const section = document.getElementById('arming-card');
  const list = document.getElementById('arming-list');
  const loading = document.getElementById('arming-loading');
  const errorBox = document.getElementById('arming-error');
  const summary = document.getElementById('arming-summary');
  const emptyLink = document.getElementById('arming-empty-link');
  let zones = [];
  let loaded = false;
  let loadSeq = 0;
  const cards = new Map(); // zone -> carte, gardée d'un rendu à l'autre
  let seq = 0; // identifiants uniques (aria-controls, aria-labelledby)

  const put = (zone, path, body) => api(`/api/arming/${encodeURIComponent(zone)}/${path}`, { method: 'PUT', body });

  async function load() {
    const n = ++loadSeq; // des rafraîchissements rapprochés : seule la dernière réponse compte
    let data;
    try {
      data = await api('/api/arming');
    } catch (err) {
      if (n === loadSeq) showLoadError(err);
      return;
    }
    if (n !== loadSeq) return;
    zones = data;
    loaded = true;
    errorBox.hidden = true;
    render();
  }

  function showLoadError(err) {
    loading.hidden = true;
    const retry = h('button', { class: 'btn btn-sm', type: 'button' }, icon('refresh'), 'Réessayer');
    retry.addEventListener('click', async () => {
      retry.classList.add('is-busy');
      retry.disabled = true;
      await load();
      retry.classList.remove('is-busy');
      retry.disabled = false;
      // Le focus ne doit pas rester sur un bouton caché ou remplacé.
      const title = document.getElementById('arming-title');
      if (errorBox.hidden && title) {
        title.setAttribute('tabindex', '-1');
        title.focus();
      } else errorBox.querySelector('button')?.focus();
    });
    errorBox.replaceChildren(
      icon('state-alarm'),
      h(
        'div',
        { class: 'arm-error-text' },
        h('p', {}, h('strong', { text: "L'état des zones n'a pas pu être lu. " }), sentence(err.message)),
        h('p', { text: loaded ? 'Les cartes ci-dessous montrent le dernier état connu.' : 'Vérifiez que le PSIM est joignable, puis réessayez.' }),
        retry,
      ),
    );
    errorBox.hidden = false;
  }

  /** Remplace l'état d'une zone par celui renvoyé par le serveur (sans attendre son message de changement). */
  function replaceZone(next) {
    zones = zones.map((z) => (z.zone === next.zone ? next : z));
    render();
  }

  function render() {
    loading.hidden = true;
    section.hidden = zones.length === 0;
    onZones?.(zones.length); // l'entrée Armement du menu n'existe que s'il y a des zones d'intrusion
    const me = getMe();
    const admin = me?.role === 'admin';
    const user = me?.username ?? '';
    if (emptyLink) emptyLink.hidden = !admin;
    const order = [];
    const seen = new Set();
    for (const z of zones) {
      let card = cards.get(z.zone);
      // Autre compte (ou autre rôle) : la carte est refaite, rien de la saisie du compte précédent ne reste.
      if (card && (card.admin !== admin || card.user !== user)) card = null;
      if (!card) {
        card = createCard(z.zone, admin, user);
        cards.set(z.zone, card);
      }
      card.update(z);
      seen.add(z.zone);
      order.push(card.el);
    }
    for (const zone of [...cards.keys()]) if (!seen.has(zone)) cards.delete(zone);
    // On ne déplace les cartes que si leur ordre a changé : un élément déplacé perd le focus.
    const current = [...list.children];
    if (current.length !== order.length || current.some((el, i) => el !== order[i])) list.replaceChildren(...order);
    renderSummary();
  }

  function renderSummary() {
    const off = zones.filter((z) => !z.armed).length;
    if (!zones.length) summary.replaceChildren();
    else if (off === 0) {
      summary.replaceChildren(h('span', { class: 'pill is-ok' }, icon('lock'), zones.length === 1 ? 'La zone est armée' : `Les ${zones.length} zones sont armées`));
    } else {
      summary.replaceChildren(h('span', { class: 'pill is-warning is-dashed' }, icon('unlock'), off === 1 ? (zones.length === 1 ? 'La zone est désarmée' : '1 zone désarmée') : `${off} zones désarmées`));
    }
  }

  // ------------------------------------------------------------------ carte d'une zone

  function createCard(name, admin, user) {
    const id = `arm-${++seq}`;
    const c = { name, admin, user, z: null, busy: false, sig: null, editor: null };

    const pill = h('span', { class: 'pill' });
    const stateMain = h('span', { class: 'arm-state-main' });
    const stateRel = h('span', { class: 'arm-state-rel' });
    const stateTitle = h('p', { class: 'arm-state-title', tabindex: '-1' }, stateMain, ' ', stateRel);
    const stateWhy = h('p', { class: 'arm-state-why' });
    const actions = h('div', { class: 'actions arm-actions', role: 'group', 'aria-label': `Commandes de la zone ${name}` });
    const actionHint = h('p', { class: 'hint arm-hint' });
    const actionError = h('p', { class: 'form-error arm-error', role: 'alert' });
    const week = h('div', { class: 'arm-week', 'aria-hidden': 'true' });
    const legend = h('ul', { class: 'arm-legend', 'aria-hidden': 'true' });
    const planLead = h('p', { class: 'arm-plan-lead' });
    const planList = h('ul', { class: 'arm-plan-list' });
    const dirtyTag = h('span', { class: 'tag is-warning is-dashed', hidden: true }, icon('pencil', 'icon-sm'), 'Modifications non enregistrées');
    const planHead = h('div', { class: 'arm-plan-head' }, h('h4', { id: `${id}-plan`, text: 'Planning de la semaine' }), dirtyTag);

    c.el = h(
      'article',
      { class: 'panel arm-zone', 'aria-labelledby': `${id}-name` },
      h('header', { class: 'arm-head' }, h('h3', { class: 'arm-name', id: `${id}-name` }, icon('intrusion'), h('span', { text: name })), pill),
      h(
        'div',
        { class: 'arm-body' },
        h('div', { class: 'arm-now' }, h('div', { class: 'arm-state' }, stateTitle, stateWhy), actions, actionHint, actionError),
        h('section', { class: 'arm-plan', 'aria-labelledby': `${id}-plan` }, planHead, week, legend, planLead, planList),
      ),
    );

    function whyText(z) {
      const o = z.override;
      if (o) {
        const manual = `${o.mode === 'armed' ? 'Armée' : 'Désarmée'} à la main par ${o.by}`;
        // Le planning prolonge l'état choisi : l'échéance affichée n'est pas celle du réglage manuel.
        if (z.schedule && Math.floor(z.nextChange / 60000) !== Math.floor(o.until / 60000)) return `${manual} jusqu'à ${when(o.until)}, puis selon le planning.`;
        const after = z.schedule ? 'Ensuite, le planning reprend.' : o.mode === 'armed' ? 'Ensuite, elle reste armée : aucun planning.' : 'Ensuite, elle se réarme toute seule.';
        return `${manual} ${since(o.at)}. ${after}`;
      }
      if (z.schedule) return z.armed ? 'Selon le planning de la semaine.' : 'Selon le planning : la zone est en dehors de ses plages armées.';
      return 'Aucun planning : la zone reste armée jour et nuit.';
    }

    function drawState() {
      const z = c.z;
      const word = z.armed ? 'Armée' : 'Désarmée';
      if (z.nextChange) {
        stateMain.replaceChildren(`${word} jusqu'à `, h('time', { datetime: new Date(z.nextChange).toISOString(), text: when(z.nextChange) }));
        stateRel.textContent = `(${inTime(z.nextChange)})`;
      } else {
        stateMain.textContent = z.armed ? 'Armée en permanence' : 'Désarmée';
        stateRel.textContent = '';
      }
      stateWhy.textContent = whyText(z);
    }

    function button(cls, content, onclick, attrs = {}) {
      const b = h('button', { class: cls, type: 'button', ...attrs }, ...content);
      b.addEventListener('click', () => onclick(b));
      return b;
    }

    /** Commandes : reconstruites seulement quand l'état change (une commande touchée garde sinon son focus). */
    function drawActions(force = false) {
      const z = c.z;
      const sig = `${z.armed}|${Boolean(z.override)}|${Boolean(z.schedule)}`;
      if (!force && sig === c.sig) return;
      c.sig = sig;
      const items = [];
      if (z.armed) {
        const label = h('span', { class: 'arm-dur-label', id: `${id}-dur` }, icon('unlock'), 'Désarmer pendant');
        items.push(
          h(
            'div',
            { class: 'arm-durations', role: 'group', 'aria-labelledby': `${id}-dur` },
            label,
            ...DURATIONS.map((hours) =>
              button('btn arm-dur', [`${hours} h`], (b) => run(b, () => put(name, 'override', { mode: 'disarmed', hours }), `${name} : désarmée pour ${hours} h`), {
                'aria-label': `Désarmer pendant ${hours} h`,
                title: `Désarme la zone ${name} pendant ${hours} h : elle se réarme toute seule ensuite`,
              }),
            ),
          ),
        );
      } else {
        items.push(button('btn btn-primary', [icon('lock'), 'Armer maintenant'], (b) => run(b, () => put(name, 'override', { mode: 'armed', hours: ARM_HOURS }), `${name} : armée`)));
      }
      if (z.override) {
        const label = z.schedule ? 'Reprendre le planning' : 'Annuler le réglage manuel';
        items.push(
          button('btn', [icon('history'), label], (b) => run(b, () => api(`/api/arming/${encodeURIComponent(name)}/override`, { method: 'DELETE' }), z.schedule ? `${name} : planning repris` : `${name} : réglage manuel annulé`), {
            title: z.schedule ? 'Annule le réglage manuel : la zone suit de nouveau son planning' : 'Annule le réglage manuel : sans planning, la zone est armée jour et nuit',
          }),
        );
      }
      actions.replaceChildren(...items);
      const hints = [];
      if (z.armed) hints.push(z.override?.mode === 'armed' ? 'Elle reste armée.' : 'Elle se réarme toute seule à la fin de la durée choisie.');
      else hints.push(`« Armer maintenant » l'arme tout de suite${z.schedule ? ` ; le planning reprend au plus tard dans ${ARM_HOURS} h` : ''}.`);
      if (z.override) hints.push(z.schedule ? '« Reprendre le planning » annule le réglage manuel.' : '« Annuler le réglage manuel » la remet armée jour et nuit.');
      actionHint.textContent = hints.join(' ');
    }

    /** Une commande : bouton occupé, les autres en attente ; ensuite le nouvel état (annoncé : le focus y va). */
    async function run(btn, request, success) {
      if (c.busy) return;
      c.busy = true;
      actionError.textContent = '';
      const all = [...actions.querySelectorAll('button')];
      for (const b of all) b.disabled = true;
      btn.classList.add('is-busy');
      btn.setAttribute('aria-busy', 'true');
      try {
        const next = await request();
        c.busy = false;
        toast(success, 'ok');
        replaceZone(next);
        drawActions(true);
        stateTitle.focus();
      } catch (err) {
        c.busy = false;
        for (const b of all) b.disabled = false;
        btn.classList.remove('is-busy');
        btn.removeAttribute('aria-busy');
        actionError.textContent = `Commande non prise en compte : ${sentence(err.message)} Réessayez dans un instant.`;
        if (btn.isConnected) btn.focus();
        drawActions(); // un état reçu pendant l'attente
      }
    }

    function seg(cls, a, b) {
      const el = h('i', { class: cls });
      el.style.setProperty('--a', String(a / DAY_MIN));
      el.style.setProperty('--b', String(b / DAY_MIN));
      return el;
    }

    /** Frise de la semaine (7 jours x 24 h) : le planning enregistré, ou l'aperçu de celui en cours de saisie. */
    function drawWeek() {
      const z = c.z;
      const preview = Boolean(c.editor?.isOpen() && c.editor.isDirty());
      const windows = preview ? c.editor.draft() : z.schedule;
      const segments = weekSegments(windows);
      const now = new Date();
      const today = now.getDay();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const manual = !preview && z.override ? overridePieces(z.override) : [];
      week.classList.toggle('is-preview', preview);
      week.replaceChildren(
        h('div', { class: 'arm-row arm-axis' }, h('span'), h('span', { class: 'arm-scale' }, ...['0 h', '6 h', '12 h', '18 h', '24 h'].map((t) => h('i', { text: t })))),
        ...DAY_ORDER.map((d) =>
          h(
            'div',
            { class: `arm-row${d === today ? ' is-today' : ''}` },
            h('span', { class: 'arm-day-name', text: DAY_SHORT[d] }),
            h(
              'span',
              { class: 'arm-track' },
              ...segments[d].map(([a, b]) => seg('arm-seg', a, b)),
              ...manual.filter((p) => p.day === d).map((p) => seg(`arm-manual is-${z.override.mode}`, p.a, p.b)),
              d === today ? seg('arm-now-mark', nowMin, nowMin) : null,
            ),
          ),
        ),
      );
      legend.replaceChildren(...[
        h('li', {}, h('i', { class: 'arm-key is-on' }), 'Armée'),
        h('li', {}, h('i', { class: 'arm-key' }), 'Désarmée'),
        manual.length ? h('li', {}, h('i', { class: `arm-key is-manual is-${z.override.mode}` }), `${z.override.mode === 'armed' ? 'Armée' : 'Désarmée'} à la main`) : null,
        h('li', {}, h('i', { class: 'arm-key is-now' }), 'Maintenant'),
      ].filter(Boolean));
      // Version texte (la frise est un dessin) : lue par tous, et par les lecteurs d'écran.
      const valid = windows === null ? null : windows.filter((w) => !slotProblem(w));
      if (valid === null) {
        planLead.textContent = 'Aucun planning : armée jour et nuit, tous les jours.';
        planList.replaceChildren();
      } else if (!valid.length) {
        planLead.textContent = preview ? 'Aperçu : aucune plage complète pour le moment.' : 'Aucune plage.';
        planList.replaceChildren();
      } else {
        planLead.textContent = preview ? 'Aperçu, pas encore enregistré. La zone serait armée :' : 'Selon le planning, la zone est armée (heure du serveur) :';
        planList.replaceChildren(...valid.map((w) => h('li', { text: windowText(w) })));
      }
    }

    c.update = (z) => {
      c.z = z;
      c.el.classList.toggle('is-disarmed', !z.armed);
      pill.className = z.armed ? 'pill is-ok' : 'pill is-warning is-dashed';
      pill.replaceChildren(icon(z.armed ? 'lock' : 'unlock'), z.armed ? 'Armée' : 'Désarmée');
      drawState();
      if (!c.busy) drawActions();
      c.editor?.sync(z.schedule);
      drawWeek();
    };
    c.tick = () => {
      if (!c.z) return;
      drawState();
      drawWeek();
    };
    c.refreshWeek = drawWeek;
    c.setDirtyTag = (dirty) => (dirtyTag.hidden = !dirty);
    c.focusState = () => stateTitle.focus();

    if (admin) {
      c.editor = createEditor(c, id);
      planHead.append(c.editor.toggle);
      c.el.append(c.editor.box);
    }
    return c;
  }

  // ------------------------------------------------------------------ éditeur du planning (administrateur)

  function createEditor(c, id) {
    const name = c.name;
    let open = false;
    let draft = []; // plages en cours de saisie
    let base = null; // planning enregistré dont la saisie est partie (clé)
    let conflict = false;

    const toggle = h('button', { class: 'btn btn-sm btn-ghost arm-edit-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': `${id}-editor` });
    const title = h('h4', { class: 'arm-editor-title', id: `${id}-ed-title`, tabindex: '-1', text: `Modifier le planning de « ${name} »` });
    const conflictNote = h(
      'div',
      { class: 'notice is-warning', hidden: true },
      icon('state-warning'),
      h('p', { text: "Ce planning vient d'être modifié depuis un autre poste. « Enregistrer le planning » remplacera cette version par la vôtre ; « Annuler les modifications » reprend la version enregistrée." }),
    );
    const empty = h('div', { class: 'empty arm-empty' });
    const slots = h('ol', { class: 'arm-slots' });
    const add = h('button', { class: 'btn btn-sm', type: 'button' }, icon('plus'), 'Ajouter une plage');
    const addHint = h('p', { class: 'hint', hidden: true, text: `${MAX_WINDOWS} plages au plus : regroupez les jours qui ont les mêmes heures.` });
    const formError = h('p', { class: 'form-error', role: 'alert' });
    const savedNote = h('p', { class: 'arm-saved', role: 'status' });
    const save = h('button', { class: 'btn btn-primary', type: 'button' }, icon('check'), 'Enregistrer le planning');
    const cancel = h('button', { class: 'btn btn-ghost', type: 'button', hidden: true }, 'Annuler les modifications');
    const remove = h('button', { class: 'btn btn-danger', type: 'button', hidden: true }, icon('trash'), 'Supprimer le planning');
    const confirmText = h('p', { id: `${id}-confirm-text` });
    const confirmYes = h('button', { class: 'btn btn-danger', type: 'button' }, icon('trash'), 'Oui, supprimer le planning');
    const confirmNo = h('button', { class: 'btn', type: 'button', text: 'Garder le planning' });
    const confirm = h(
      'div',
      { class: 'notice is-warning arm-confirm', role: 'group', tabindex: '-1', 'aria-labelledby': `${id}-confirm-text`, hidden: true },
      icon('state-warning'),
      h('div', { class: 'arm-confirm-body' }, confirmText, h('div', { class: 'actions' }, confirmNo, confirmYes)),
    );
    const box = h(
      'div',
      { class: 'arm-editor', id: `${id}-editor`, hidden: true },
      title,
      h('p', { class: 'hint', text: "Indiquez les plages pendant lesquelles la zone est armée, à l'heure du serveur ; en dehors, elle est désarmée. Une plage commence les jours choisis : une plage de nuit (19:00 à 07:00) se termine le lendemain matin." }),
      conflictNote,
      empty,
      slots,
      h('div', { class: 'arm-add' }, add, addHint),
      formError,
      h('div', { class: 'actions arm-editor-foot' }, save, cancel, remove),
      confirm,
      savedNote,
    );

    const isDirty = () => keyOf(draft) !== keyOf(c.z.schedule);

    function setBusy(btn, busy) {
      btn.classList.toggle('is-busy', busy);
      btn.toggleAttribute('aria-busy', busy);
      for (const b of box.querySelectorAll('button')) b.disabled = busy;
      if (!busy) refresh();
    }

    /** Boutons, étiquette « non enregistré » et aperçu de la frise, après chaque changement. */
    function refresh() {
      const dirty = isDirty();
      save.disabled = !dirty;
      cancel.hidden = !dirty;
      remove.hidden = c.z.schedule === null;
      add.disabled = draft.length >= MAX_WINDOWS;
      addHint.hidden = draft.length < MAX_WINDOWS;
      conflictNote.hidden = !conflict;
      c.setDirtyTag(dirty);
      empty.hidden = draft.length > 0;
      empty.replaceChildren(
        icon('clock'),
        c.z.schedule === null
          ? h('strong', { text: 'Aucun planning : la zone est armée jour et nuit.' })
          : h('strong', { text: 'Aucune plage.' }),
        h('span', {
          text:
            c.z.schedule === null
              ? 'Ajoutez les plages où elle doit être armée, par exemple la nuit du lundi au vendredi : en dehors, elle sera désarmée automatiquement. Pour armer jusqu’à minuit, indiquez 00:00 comme heure de fin ; pour armer toute la journée, supprimez le planning.'
              : 'Ajoutez une plage, ou supprimez le planning pour armer la zone jour et nuit.',
        }),
      );
      c.refreshWeek();
    }

    function changed() {
      savedNote.textContent = '';
      formError.textContent = '';
      refresh();
    }

    function field(label, input) {
      return h('label', { class: 'field' }, h('span', { text: label }), input);
    }

    function slotEl(w, i) {
      const n = i + 1;
      const errId = `${id}-s${n}-err`;
      const err = h('p', { class: 'form-error', id: errId });
      const note = h('p', { class: 'hint arm-slot-note' });
      const from = h('input', { type: 'time', value: w.from, required: true, 'aria-describedby': errId });
      const to = h('input', { type: 'time', value: w.to, required: true, 'aria-describedby': errId });
      const check = () => {
        const problem = slotProblem(w);
        err.textContent = problem ?? '';
        const badTime = problem && w.days.length > 0;
        from.setAttribute('aria-invalid', String(Boolean(badTime)));
        to.setAttribute('aria-invalid', String(Boolean(badTime)));
        note.textContent = !problem && minutesOf(w.to) < minutesOf(w.from) && w.to !== '00:00' ? `Plage de nuit : elle se termine le lendemain à ${w.to}.` : '';
      };
      const days = DAY_ORDER.map((d) => {
        const b = h('button', { class: 'btn btn-sm arm-day', type: 'button', 'aria-pressed': String(w.days.includes(d)), 'aria-label': DAY_LONG[d], text: DAY_SHORT[d] });
        b.addEventListener('click', () => {
          w.days = w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d];
          b.setAttribute('aria-pressed', String(w.days.includes(d)));
          check();
          changed();
        });
        return b;
      });
      for (const [input, key] of [
        [from, 'from'],
        [to, 'to'],
      ]) {
        input.addEventListener('input', () => {
          w[key] = input.value;
          check();
          changed();
        });
      }
      const drop = h('button', { class: 'btn btn-sm btn-ghost arm-remove', type: 'button' }, icon('trash'), 'Retirer', h('span', { class: 'sr-only', text: ` la plage ${n}` }));
      drop.addEventListener('click', () => {
        draft.splice(i, 1);
        drawSlots();
        changed();
        // Le focus va à la plage qui prend la place, sinon à « Ajouter une plage ».
        const target = (slots.children[i] ?? slots.children[i - 1])?.querySelector('.arm-day');
        (target ?? add).focus();
      });
      check();
      return h(
        'li',
        { class: 'arm-slot' },
        h(
          'fieldset',
          {},
          h('legend', { text: `Plage ${n}` }),
          h('div', { class: 'arm-days', role: 'group', 'aria-label': `Jours où commence la plage ${n}` }, ...days),
          h('div', { class: 'arm-hours' }, field('Armée à partir de', from), field("Jusqu'à", to), drop),
          note,
          err,
        ),
      );
    }

    function drawSlots() {
      slots.replaceChildren(...draft.map(slotEl));
    }

    /** Repart du planning enregistré. */
    function reset() {
      draft = clone(c.z.schedule);
      base = keyOf(c.z.schedule);
      conflict = false;
      drawSlots();
    }

    toggle.addEventListener('click', () => {
      open = !open;
      box.hidden = !open;
      c.el.classList.toggle('is-editing', open);
      drawToggle();
      c.refreshWeek();
      if (open) title.focus();
    });

    function drawToggle() {
      toggle.setAttribute('aria-expanded', String(open));
      toggle.replaceChildren(icon(open ? 'close' : 'pencil'), open ? "Fermer l'éditeur" : 'Modifier le planning');
    }

    add.addEventListener('click', () => {
      if (draft.length >= MAX_WINDOWS) return;
      draft.push(suggestion());
      drawSlots();
      changed();
      slots.lastElementChild?.querySelector('.arm-day')?.focus();
    });

    cancel.addEventListener('click', () => {
      reset();
      changed();
      title.focus();
    });

    save.addEventListener('click', async () => {
      if (!draft.length) {
        formError.textContent = 'Aucune plage : ajoutez-en une. Pour armer la zone jour et nuit, utilisez plutôt « Supprimer le planning ».';
        add.focus();
        return;
      }
      const bad = draft.findIndex((w) => slotProblem(w));
      if (bad >= 0) {
        formError.textContent = `La plage ${bad + 1} est incomplète : ${slotProblem(draft[bad]).toLowerCase()}`;
        slots.children[bad]?.querySelector('.arm-day, input')?.focus();
        return;
      }
      formError.textContent = '';
      setBusy(save, true);
      try {
        const schedule = draft.map((w) => ({ days: sortedDays(w.days), from: w.from, to: w.to }));
        const next = await put(name, 'schedule', { schedule });
        draft = clone(next.schedule);
        base = keyOf(next.schedule);
        conflict = false;
        replaceZone(next);
        drawSlots();
        savedNote.textContent = `Planning enregistré à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.`;
        toast(`${name} : planning enregistré`, 'ok');
        setBusy(save, false);
        title.focus();
      } catch (err) {
        setBusy(save, false);
        formError.textContent = `Le planning n'a pas été enregistré : ${sentence(err.message)}`;
        save.focus();
      }
    });

    remove.addEventListener('click', () => {
      confirmText.textContent = `Supprimer le planning de « ${name} » ? La zone sera armée jour et nuit, sans interruption, jusqu'à l'enregistrement d'un nouveau planning.`;
      confirm.hidden = false;
      confirm.focus();
    });
    confirmNo.addEventListener('click', () => {
      confirm.hidden = true;
      remove.focus();
    });
    confirmYes.addEventListener('click', async () => {
      setBusy(confirmYes, true);
      try {
        const next = await put(name, 'schedule', { schedule: null });
        confirm.hidden = true;
        draft = [];
        base = keyOf(null);
        conflict = false;
        replaceZone(next);
        drawSlots();
        savedNote.textContent = 'Planning supprimé : la zone est armée jour et nuit.';
        toast(`${name} : planning supprimé, zone armée jour et nuit`, 'ok');
        setBusy(confirmYes, false);
        title.focus();
      } catch (err) {
        setBusy(confirmYes, false);
        confirm.hidden = true;
        formError.textContent = `Le planning n'a pas été supprimé : ${sentence(err.message)}`;
        remove.focus();
      }
    });

    drawToggle();

    return {
      toggle,
      box,
      isOpen: () => open,
      isDirty,
      draft: () => draft,
      /**
       * Planning enregistré reçu du serveur. Une saisie commencée (ou un champ en cours de frappe) est gardée telle
       * quelle : si la version enregistrée a changé entre-temps, on le signale au lieu de l'écraser.
       */
      sync(saved) {
        const key = keyOf(saved);
        if (base === null) reset();
        else if (key !== base) {
          const wasDirty = keyOf(draft) !== base;
          const typing = box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
          base = key;
          if (!wasDirty && !typing) reset();
          else conflict = keyOf(draft) !== key;
        }
        refresh();
      },
    };
  }

  // Échéances (« dans 3 h 05 ») et repère « maintenant » de la frise : remis à jour chaque minute, écran affiché.
  setInterval(() => {
    if (document.hidden || section.closest('[hidden]') || section.hidden) return;
    for (const card of cards.values()) card.tick();
  }, 30_000);

  return { load, render };
}
