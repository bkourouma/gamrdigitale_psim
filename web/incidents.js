/**
 * Alarmes : fiches des incidents actifs (panneau « Alarmes en cours » de Surveillance), bloc « Tout est calme », écran
 * Alarmes (en cours et clôturées récemment), images prises (vignettes, loupe).
 *
 * L’alarme prend la scène : la fiche suivie est dépliée en tête du panneau (attente qui se voit, trois étapes numérotées) ;
 * les autres alarmes sont des lignes compactes, qu'un clic fait suivre.
 *
 * Sécurité : on ne clôture pas un incident tant que son détecteur sonne (boutons désactivés, raison écrite). Les fiches
 * sont mises à jour SUR PLACE, jamais recréées (l'attente l'est chaque seconde) : un commentaire en cours de saisie garde
 * son texte et son focus. Une fiche où l'on écrit reste dépliée quand une autre alarme prend la main.
 */
import { CATEGORY_LABEL, formatValue, qualificationLabel, realEventLabel } from './sources.js';
import { CATEGORY_ICON } from './plan.js';
import { $, h, icon, api, toast, S, time, elapsed, emit, go, activeIncidents, focusedIncident, followAlarm, isActive, isFiring, devicesOf, STATUS_LABEL, render } from './core.js';

/** L'attente se lit sur une barre qui se remplit en 5 minutes (un repère par minute). */
const WAIT_SCALE_MS = 5 * 60 * 1000;

const narrow = matchMedia('(max-width: 1023px)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const cards = new Map(); // idIncident -> { el, refs }
let cardsOwner; // compte pour lequel les fiches existent : un brouillon de commentaire ne passe jamais au compte suivant
let announced = null; // incidents déjà annoncés aux lecteurs d'écran (id -> gravité) ; null avant le premier état reçu
let shownFollow = null; // alarme dépliée au dernier rendu (une pastille du plan peut en suivre une autre entre deux rendus)

// ---------------------------------------------------------------- images prises, loupe

const SHOT_REASON = { opened: "à l’ouverture", escalated: "à l’aggravation", confirmed: 'à la confirmation' };

export function shotCaption(shot) {
  const camera = S.devices.get(shot.cameraId);
  return `${camera?.name ?? shot.cameraId} · ${SHOT_REASON[shot.reason] ?? shot.reason} · ${time(shot.takenAt)}`;
}

/** Miniatures des images prises au moment de l'incident (reconstruites seulement si la liste change). */
export function renderShots(container, incident, mini = false) {
  const key = incident.snapshots.map((s) => s.id).join(',');
  if (container.dataset.key === key) return;
  container.dataset.key = key;
  container.classList.toggle('mini', mini);
  container.hidden = incident.snapshots.length === 0;
  container.replaceChildren(
    ...incident.snapshots.map((shot) => {
      const caption = shotCaption(shot);
      const img = h('img', { src: `/api/snapshots/${shot.id}?t=${shot.takenAt}`, alt: '', draggable: 'false', loading: 'lazy' });
      return h('button', { type: 'button', class: 'shot', title: caption, 'aria-label': `Agrandir l’image : ${caption}`, onclick: () => openLightbox(shot) }, img);
    }),
  );
}

// Image agrandie : le focus y entre (bouton Fermer) et revient ensuite sur la vignette qui l'a ouverte.
let lightboxOpener = null;

export function openLightbox(shot) {
  lightboxOpener = document.activeElement;
  $('lightbox-img').src = `/api/snapshots/${shot.id}?t=${shot.takenAt}`;
  $('lightbox-img').alt = shotCaption(shot);
  $('lightbox-caption').textContent = shotCaption(shot);
  $('lightbox').hidden = false;
  $('lightbox-close').focus();
}

function closeLightbox() {
  if ($('lightbox').hidden) return;
  $('lightbox').hidden = true;
  if (lightboxOpener?.isConnected) lightboxOpener.focus();
  lightboxOpener = null;
}
$('lightbox').addEventListener('click', closeLightbox); // un clic n'importe où (ou sur Fermer) referme
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'Tab' && !$('lightbox').hidden) {
    e.preventDefault(); // fenêtre modale : la tabulation ne part pas vers la page cachée sous le voile
    $('lightbox-close').focus();
  }
});

// ---------------------------------------------------------------- textes

/** Ce qui a confirmé l'alarme, en mots. */
export function confirmationText(reason) {
  if (reason?.startsWith('neighbor:')) {
    const id = reason.slice('neighbor:'.length);
    const d = S.devices.get(id);
    return `détecteur voisin ${id}${d ? ` (${d.name})` : ''} déclenché`;
  }
  if (reason === 'persistence') return "l’alarme persiste";
  return reason ?? '';
}

export function hintText(details) {
  const m = /en (\d+) s/.exec(details ?? '');
  return m ? `revenu à la normale en ${m[1]} s, sans détecteur voisin.` : (details ?? '');
}

/** Où : la zone, et l'étage s'il y en a plusieurs (une même zone peut exister à chaque niveau). */
export function placeText(incident) {
  const zone = incident.zone || 'Zone non renseignée';
  return S.floors.length > 1 && incident.floor ? `${zone} · ${incident.floor}` : zone;
}

/** Quand : l'heure d'ouverture (l'attente est affichée à part, rafraîchie chaque seconde). */
export const whenText = (incident) => `ouverte à ${time(incident.openedAt)}`;

/** Heure seule pour aujourd'hui ; date et heure au-delà (journal, alarmes clôturées). */
export function dateTime(ts) {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString()
    ? time(ts)
    : d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const levelWord = (incident) => (incident.severity === 'critical' ? 'Alarme' : 'Préalarme');

/** Pastille de niveau (forme + icône + mot). Reconstruite seulement quand le niveau change. */
function setLevel(el, critical, upper = true) {
  const key = `${critical}:${upper}`;
  if (el.dataset.level === key) return;
  el.dataset.level = key;
  el.className = `pill ${critical ? 'is-solid-alarm' : 'is-solid-warning'}`;
  const word = critical ? 'Alarme' : 'Préalarme';
  el.replaceChildren(icon(critical ? 'state-alarm' : 'state-warning'), upper ? word.toUpperCase() : word);
}

/** Remplace le contenu d'un élément seulement si sa clé change (pas de nœuds recréés à chaque message). */
function fill(el, key, ...children) {
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.replaceChildren(...children.flat().filter(Boolean));
}

// ---------------------------------------------------------------- actions

/** Suit un incident (fiche dépliée, caméras, étage). */
function follow(incident) {
  S.focusIncidentId = incident.id;
  S.manualCams = [];
  followAlarm(incident);
  render.plan();
  render.wall();
  renderIncidents();
  render.admin();
}

/** Fait défiler la feuille juste assez pour montrer un élément (sous la barre du haut, qui reste collée). */
function bringIntoView(el) {
  const sheet = $('workspace');
  if (!sheet || !el?.isConnected) return;
  const bar = sheet.querySelector('.topbar')?.offsetHeight ?? 0;
  const box = el.getBoundingClientRect();
  const view = sheet.getBoundingClientRect();
  const top = view.top + bar;
  if (box.top >= top && box.bottom <= view.bottom) return;
  const delta = box.top < top || box.height > view.bottom - top ? box.top - top - 12 : box.bottom - view.bottom + 12;
  sheet.scrollBy({ top: delta, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

/** Suit l'alarme et y amène le regard et le focus (ligne compacte, bouton « Traiter »). */
function followAndShow(incident) {
  follow(incident);
  const card = cards.get(incident.id);
  if (!card) return;
  bringIntoView(card.el);
  card.refs.title.focus({ preventScroll: true });
}

/** « Voir les caméras » : le mur revient aux caméras de cette alarme ; sur tablette et téléphone il est sous le plan,
 *  on l'amène à l'écran. */
function showCameras(incident) {
  follow(incident);
  const wall = document.querySelector('#view-surveillance .c-video');
  if (wall && narrow.matches) bringIntoView(wall);
}

/**
 * Acquitter, clôturer : le résultat (l'incident à jour) est appliqué tout de suite, sans attendre le temps réel. Le bouton
 * passe « occupé » pendant la demande (un second appui est ignoré). Renvoie vrai si le serveur a accepté.
 */
export async function act(fn, button = null) {
  if (button?.classList.contains('is-busy')) return false;
  button?.classList.add('is-busy');
  button?.setAttribute('aria-busy', 'true');
  try {
    const result = await fn();
    if (result?.id) emit('incident', result);
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  } finally {
    button?.classList.remove('is-busy');
    button?.removeAttribute('aria-busy');
  }
}

/** Le focus a été perdu (élément masqué ou retiré) : on peut le replacer sans gêner l'opérateur. */
const focusLost = () => !document.activeElement || document.activeElement === document.body;

// ---------------------------------------------------------------- fiche

const STEP_STATE = { done: 'Fait : ', current: 'À faire : ', next: 'Ensuite : ' };

function makeStep(n, title) {
  const state = h('span', { class: 'sr-only' });
  const head = h('p', { class: 'step-title', tabindex: '-1' }, state, title);
  const body = h('div', { class: 'step-body' }, head);
  const li = h('li', { class: 'step' }, h('span', { class: 'step-num', 'aria-hidden': 'true' }, h('span', { class: 'step-digit', text: String(n) }), icon('check', 'step-check')), body);
  return { li, body, head, state };
}

function setStep(step, state) {
  step.li.className = state === 'next' ? 'step' : `step is-${state}`;
  step.state.textContent = STEP_STATE[state];
}

function buildCard(incident) {
  const id = incident.id;
  const current = () => S.incidents.get(id) ?? incident;
  const refs = {};

  // Ligne compacte : une alarme qui n'est pas suivie. Un clic la fait suivre (elle se déplie en tête).
  refs.rowBadge = h('span', { class: 'pill' });
  refs.rowName = h('strong', { class: 'inc-row-name' });
  refs.rowPlace = h('span', { class: 'inc-row-place' });
  refs.rowState = h('span', { class: 'inc-row-state' });
  refs.rowWait = h('span', { class: 'inc-row-wait num' });
  refs.row = h(
    'button',
    { type: 'button', class: 'inc-row', onclick: () => followAndShow(current()) },
    h('span', { class: 'sr-only', text: 'Suivre cette alarme : ' }),
    refs.rowBadge,
    h('span', { class: 'inc-row-main' }, refs.rowName, refs.rowPlace),
    h('span', { class: 'inc-row-side' }, refs.rowState, refs.rowWait),
    icon('chevron-right', 'inc-row-go'),
  );

  // En-tête, titre, lieu et heure, attente.
  refs.badge = h('span', { class: 'pill' });
  refs.type = h('span', { class: 'tag inc-cat' });
  refs.chip = h('span', { class: 'tag inc-conf' });
  refs.title = h('h3', { class: 'inc-title', tabindex: '-1' });
  refs.place = h('span', { class: 'inc-place' });
  refs.opened = h('span');
  refs.measureText = h('span');
  refs.measure = h('span', { class: 'inc-measure' }, icon('signal', 'icon-sm'), refs.measureText);
  refs.waitLine = h('p', { class: 'inc-wait-line' });
  refs.waitClock = h('span', { class: 'inc-wait-clock num' });
  refs.bar = h('span', { class: 'inc-bar', 'aria-hidden': 'true' }, h('span', { class: 'inc-bar-fill' }));
  refs.escalated = h('p', { class: 'inc-escalated' }, icon('megaphone', 'icon-sm'), h('span'));

  // Ce qui qualifie l'alarme : confirmation, conseil, images.
  refs.conf = h('p', { class: 'inc-conf-line' });
  refs.advice = h('div', { class: 'notice is-info inc-advice' }, icon('info'), h('span'));
  refs.shots = h('div', { class: 'shots' });
  refs.shotsBlock = h('div', { class: 'inc-shots' }, h('p', { class: 'inc-label', text: 'Images prises' }), refs.shots);

  // Étape 1 : les caméras.
  const s1 = makeStep(1, 'Regardez les caméras');
  refs.camsText = h('p', { class: 'step-detail' });
  refs.cams = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => showCameras(current()) }, icon('camera'), 'Voir les caméras');
  refs.camsActions = h('div', { class: 'actions' }, refs.cams);
  s1.body.append(refs.camsText, refs.camsActions);

  // Étape 2 : acquitter (arrête le son ; l'incident reste ouvert).
  const s2 = makeStep(2, "Acquittez l’alarme");
  refs.ackText = h('p', { class: 'step-detail' });
  refs.ack = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => acknowledge() }, icon('check'), 'Acquitter');
  refs.ackActions = h('div', { class: 'actions' }, refs.ack);
  s2.body.append(refs.ackText, refs.ackActions);

  // Étape 3 : clôturer, avec la qualification. Le geste grave (événement réel) est à l'écart et se confirme.
  const s3 = makeStep(3, 'Clôturez après vérification');
  const reasonId = `inc-reason-${id}`;
  refs.reason = h('p', { class: 'step-reason', id: reasonId });
  refs.comment = h('textarea', { rows: '2', maxlength: '500', placeholder: 'Ex. fumée de cuisson, porte mal fermée, ronde faite…' });
  refs.false = h('button', { class: 'btn', type: 'button', 'aria-describedby': reasonId, text: 'Fausse alarme', onclick: () => closeAs('false_alarm', refs.false) });
  refs.fire = h('button', { class: 'btn btn-danger', type: 'button', 'aria-describedby': reasonId, onclick: () => askReal() });
  refs.closeActions = h('div', { class: 'actions inc-close' }, refs.false, refs.fire);
  refs.confirmText = h('p');
  refs.confirmNo = h('button', { class: 'btn', type: 'button', text: 'Annuler', onclick: () => cancelReal(true) });
  refs.confirmYes = h('button', { class: 'btn btn-danger is-solid', type: 'button', onclick: () => closeAs('fire', refs.confirmYes) });
  refs.confirm = h(
    'div',
    { class: 'inc-confirm', role: 'group', 'aria-label': 'Confirmer un événement réel' },
    icon('state-alarm'),
    h('div', { class: 'inc-confirm-body' }, refs.confirmText, h('div', { class: 'actions' }, refs.confirmNo, refs.confirmYes)),
  );
  refs.confirm.hidden = true;
  refs.confirm.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancelReal(true);
  });
  s3.body.append(h('label', { class: 'field inc-comment' }, h('span', { text: 'Commentaire (facultatif)' }), refs.comment), refs.reason, refs.closeActions, refs.confirm);

  refs.steps = { s1, s2, s3 };

  refs.body = h(
    'div',
    { class: 'inc-body' },
    h(
      'div',
      { class: 'inc-top' },
      h('header', { class: 'inc-head' }, refs.badge, refs.type, refs.chip, h('span', { class: 'inc-num num', text: `n° ${id}` })),
      refs.title,
      h('p', { class: 'inc-meta' }, h('span', {}, icon('pin', 'icon-sm'), refs.place), h('span', {}, icon('clock', 'icon-sm'), refs.opened), refs.measure),
      h('div', { class: 'inc-wait' }, refs.waitLine, refs.bar, refs.escalated),
    ),
    h('div', { class: 'inc-main' }, refs.conf, refs.advice, refs.shotsBlock, h('ol', { class: 'steps', 'aria-label': 'Traitement de cette alarme' }, s1.li, s2.li, s3.li)),
  );

  async function acknowledge() {
    const ok = await act(() => api(`/api/incidents/${id}/ack`, { method: 'POST' }), refs.ack);
    // Le bouton a disparu : le focus passe à l'étape suivante, celle qu'il reste à faire. (Le navigateur ne rend pas
    // toujours le focus d'un bouton masqué tout de suite : on teste aussi sa rangée.)
    if (ok && (focusLost() || refs.ackActions.contains(document.activeElement)) && !refs.body.hidden) s3.head.focus();
  }

  function askReal() {
    const inc = current();
    const label = realEventLabel(inc.category);
    refs.confirmText.textContent =
      `Vous déclarez un événement réel. L’alarme sera clôturée et enregistrée comme « ${label} » dans le journal et les rapports.` +
      (inc.category === 'fire' ? " Elle sera prise en compte dans l’indice de sécurité de la zone." : '');
    refs.confirmYes.textContent = `Oui, ${label.toLowerCase()}`;
    refs.closeActions.hidden = true;
    refs.confirm.hidden = false;
    refs.confirmNo.focus(); // le choix sans conséquence d'abord : deux appuis sur Entrée n’engagent rien
  }

  function cancelReal(restoreFocus) {
    if (refs.confirm.hidden) return;
    const had = refs.confirm.contains(document.activeElement);
    refs.confirm.hidden = true;
    refs.closeActions.hidden = false;
    if (restoreFocus || had) (refs.fire.disabled ? s3.head : refs.fire).focus();
  }
  refs.cancelReal = cancelReal;

  async function closeAs(qualification, button) {
    const ok = await act(
      () => api(`/api/incidents/${id}/close`, { method: 'POST', body: { qualification, comment: refs.comment.value.trim() } }),
      button,
    );
    if (!ok || !focusLost()) return;
    // La fiche a disparu : le focus va à l'alarme suivie suivante, ou au bloc « Tout est calme ».
    const next = focusedIncident();
    (next ? cards.get(next.id)?.refs.title : $('no-incident'))?.focus();
  }

  const el = h('article', { class: 'incident', 'aria-labelledby': `inc-title-${id}` }, refs.row, refs.body);
  refs.title.id = `inc-title-${id}`;
  return { el, refs };
}

/** Attente : « En attente depuis 02:14 » et la barre ; une fois acquittée, qui, quand, après combien d'attente. */
function updateWait({ el, refs }, incident) {
  const open = incident.status === 'open';
  const end = !open && incident.ackedAt ? incident.ackedAt : Date.now();
  const waited = Math.max(0, end - incident.openedAt);
  refs.bar.style.setProperty('--p', String(Math.min(1, waited / WAIT_SCALE_MS)));
  el.classList.toggle('is-overdue', open && waited >= WAIT_SCALE_MS);
  if (open) {
    fill(refs.waitLine, 'open', 'En attente depuis ', refs.waitClock);
    refs.waitClock.textContent = elapsed(incident.openedAt);
  } else {
    fill(
      refs.waitLine,
      `acked:${incident.ackedAt}:${incident.ackedBy}`,
      `Acquittée par ${incident.ackedBy ?? 'un utilisateur inconnu'} à `,
      h('time', { datetime: new Date(incident.ackedAt ?? end).toISOString(), text: time(incident.ackedAt ?? end) }),
      `, après ${elapsed(Date.now() - waited)} d’attente`,
    );
  }
  refs.rowWait.textContent = `depuis ${elapsed(incident.openedAt)}`;

  // Escalade : si le serveur a prévenu le niveau 2 (personnes prévenues), on le dit, d'après le journal reçu.
  const escalation = S.audit.find((e) => e.action === 'notification_escalated' && e.incidentId === incident.id);
  refs.escalated.hidden = !escalation;
  if (escalation) refs.escalated.lastChild.textContent = `Personnes prévenues de niveau 2 alertées à ${time(escalation.ts)}.`;
}

/** Étape 1 : elle dépend aussi du mur (sélection manuelle choisie ailleurs) : relue chaque seconde. */
function updateCameraStep({ refs }, incident, followed) {
  const open = incident.status === 'open';
  const hasCams = incident.cameraIds.length > 0;
  const onWall = followed && S.manualCams.length === 0;
  const key = `${hasCams}:${onWall}:${open}`;
  if (refs.camsText.dataset.key === key) return;
  refs.camsText.dataset.key = key;
  if (!hasCams) {
    setStep(refs.steps.s1, open ? 'next' : 'done');
    refs.camsText.textContent = "Aucune caméra n’est associée à ce détecteur : allez vérifier sur place.";
  } else if (onWall) {
    setStep(refs.steps.s1, 'done');
    refs.camsText.textContent = `${incident.cameraIds.length > 1 ? 'Les caméras de la zone sont affichées' : 'La caméra de la zone est affichée'} sur le mur.`;
  } else {
    setStep(refs.steps.s1, 'next');
    refs.camsText.textContent = followed ? 'Le mur montre une autre sélection de caméras.' : 'Le mur montre les caméras d’une autre alarme.';
  }
  refs.camsActions.hidden = !hasCams;
}

/** Ce que fait le détecteur, et donc si la clôture est possible. */
function closeReason(detector) {
  if (!detector) return { cls: 'is-ready', icon: 'info', text: "Le détecteur n’existe plus : vous pouvez clôturer." };
  if (isFiring(detector)) return { cls: 'is-blocked', icon: 'lock', text: 'Le détecteur sonne encore : « Fausse alarme » et « Feu confirmé » seront disponibles quand il sera revenu à la normale.' };
  if (detector.status === 'offline') return { cls: 'is-down', icon: 'state-offline', text: 'Le détecteur ne répond plus : vérifiez sur place avant de clôturer.' };
  if (detector.status === 'fault') return { cls: 'is-down', icon: 'wrench', text: 'Le détecteur est en défaut : vérifiez sur place avant de clôturer.' };
  return { cls: 'is-ready', icon: 'state-ok', text: 'Le détecteur est revenu à la normale : vous pouvez clôturer.' };
}

function updateCard(card, incident, followed) {
  const { el, refs } = card;
  const detector = S.devices.get(incident.detectorId);
  const critical = incident.severity === 'critical';
  const open = incident.status === 'open';
  const confirmed = incident.confirmedAt !== null;
  const blocked = isFiring(detector);
  // Dépliée : la fiche suivie, et toute fiche où l'opérateur est en train d'agir (focus, commentaire commencé,
  // confirmation ouverte) : une nouvelle alarme ne lui retire pas son texte des yeux.
  const busy = refs.body.contains(document.activeElement) || refs.comment.value.trim() !== '' || !refs.confirm.hidden;
  const expanded = followed || busy;

  el.className = [
    'incident',
    critical ? 'is-critical' : 'is-warning',
    open ? 'is-open' : 'is-acked',
    confirmed ? 'is-confirmed' : '',
    expanded ? 'is-expanded' : 'is-compact',
    followed ? 'is-followed' : '',
    el.classList.contains('is-overdue') ? 'is-overdue' : '',
  ].filter(Boolean).join(' ');
  refs.row.hidden = expanded;
  refs.body.hidden = !expanded;

  // Ligne compacte
  setLevel(refs.rowBadge, critical, false);
  refs.rowName.textContent = incident.detectorName;
  refs.rowPlace.textContent = placeText(incident);
  const rowReason = closeReason(detector);
  const rowCls = open ? ' is-open' : rowReason.cls === 'is-ready' ? ' is-ready' : rowReason.cls === 'is-blocked' ? ' is-blocked' : ' is-down';
  refs.rowState.className = `inc-row-state${rowCls}`;
  const rowText = open ? 'À acquitter' : rowReason.cls === 'is-ready' ? 'À clôturer : détecteur revenu à la normale' : rowReason.cls === 'is-blocked' ? 'Acquittée : le détecteur sonne encore' : 'Acquittée : à vérifier sur place';
  fill(refs.rowState, rowText, icon(open ? 'bell' : rowReason.cls === 'is-ready' ? 'state-ok' : 'check', 'icon-sm'), rowText);

  // En-tête
  setLevel(refs.badge, critical);
  fill(refs.type, incident.category, icon(CATEGORY_ICON[incident.category] ?? 'fire', 'icon-sm'), CATEGORY_LABEL[incident.category] ?? CATEGORY_LABEL.fire);
  refs.chip.textContent = confirmed ? 'Confirmée' : 'À confirmer';
  refs.chip.className = `tag inc-conf ${confirmed ? 'is-confirmed' : 'is-dashed'}`;
  refs.title.textContent = incident.detectorName;
  refs.place.textContent = placeText(incident);
  fill(refs.opened, String(incident.openedAt), 'ouverte à ', h('time', { datetime: new Date(incident.openedAt).toISOString(), text: time(incident.openedAt) }));
  refs.measure.hidden = incident.lastValue === null;
  refs.measureText.textContent = incident.lastValue !== null ? `Mesure : ${formatValue(incident.lastValue, incident.valueUnit)}` : '';
  updateWait(card, incident);

  // Une alarme « à confirmer » reste une alarme à traiter : on le dit pour qu'elle ne soit jamais prise à la légère.
  refs.conf.textContent = confirmed
    ? `Confirmée : ${confirmationText(incident.confirmationReason)}.`
    : 'Rien ne confirme encore le feu. Traitez-la comme une vraie alarme.';
  refs.conf.hidden = !confirmed && !open && !blocked;
  refs.advice.hidden = !incident.hint;
  refs.advice.lastChild.textContent = incident.hint ? `Fausse alarme probable : ${hintText(incident.hintDetails)} À vérifier : l’incident reste ouvert.` : '';
  renderShots(refs.shots, incident);
  refs.shotsBlock.hidden = incident.snapshots.length === 0;

  // Étapes
  updateCameraStep(card, incident, followed);
  setStep(refs.steps.s2, open ? 'current' : 'done');
  // Le son s'arrête quand plus rien n'attend d'être acquitté : on ne promet pas le silence s'il reste une autre alarme.
  const othersPending = activeIncidents().some((i) => i.id !== incident.id && i.status === 'open');
  refs.ackText.textContent = open
    ? "Le son s’arrête ; l’alarme reste ouverte."
    : `Acquittée par ${incident.ackedBy ?? 'un utilisateur inconnu'}. ${othersPending ? 'Le son continue : une autre alarme attend d’être acquittée.' : 'Le son est arrêté ; l’alarme reste ouverte jusqu’à sa clôture.'}`;
  refs.ackActions.hidden = !open;
  setStep(refs.steps.s3, open ? 'next' : 'current');

  const reason = closeReason(detector);
  refs.reason.className = `step-reason ${reason.cls}`;
  fill(refs.reason, reason.text, icon(reason.icon, 'icon-sm'), h('span', { text: reason.text }));
  refs.fire.textContent = realEventLabel(incident.category);
  refs.false.disabled = blocked;
  refs.fire.disabled = blocked;
  refs.confirmYes.disabled = blocked;
  if (blocked) refs.cancelReal(false); // le détecteur sonne de nouveau : la confirmation n'a plus lieu d'être
}

// ---------------------------------------------------------------- panneau « Alarmes en cours »

/** Nouvelles alarmes et aggravations annoncées aux lecteurs d'écran (le son et le cadre rouge ne leur disent rien). */
function announce(list) {
  if (!S.loaded) return;
  const seen = new Map(list.map((i) => [i.id, i.severity]));
  if (announced) {
    const fresh = list.filter((i) => i.status === 'open' && (!announced.has(i.id) || (announced.get(i.id) === 'warning' && i.severity === 'critical')));
    const region = $('incidents-announce');
    if (fresh.length && region) {
      const message = fresh.map((i) => `${levelWord(i)} : ${i.detectorName}, ${placeText(i)}.`).join(' ');
      region.textContent = ''; // vidée puis réécrite au tick suivant : une phrase identique est relue
      requestAnimationFrame(() => { region.textContent = message; });
    }
  }
  announced = seen;
}

/** Panneau « Alarmes en cours » (Surveillance) et écran Alarmes. */
export function renderIncidents() {
  // Changement de compte : les fiches (et un commentaire commencé) du compte précédent ne sont pas reprises.
  const owner = S.me?.username ?? null;
  if (owner !== cardsOwner) {
    for (const card of cards.values()) card.el.remove();
    cards.clear();
    cardsOwner = owner;
    announced = null;
  }

  const list = activeIncidents();
  const followed = focusedIncident();
  shownFollow = followed?.id ?? null;
  // La fiche suivie d'abord (elle prend la scène), puis les autres de la plus urgente à la moins urgente.
  const ordered = followed ? [followed, ...list.filter((i) => i.id !== followed.id)] : list;
  const unacked = list.filter((i) => i.status === 'open').length;

  $('no-incident').hidden = list.length > 0;
  const panel = $('incidents').closest('.c-incidents');
  panel?.classList.toggle('has-alarm', list.length > 0);
  panel?.classList.toggle('has-pending', unacked > 0);
  const count = $('incidents-count');
  if (count) {
    count.hidden = list.length === 0;
    const toClose = list.filter((i) => i.status !== 'open' && closeReason(S.devices.get(i.detectorId)).cls === 'is-ready').length;
    count.textContent = [`${list.length} en cours`, unacked ? `${unacked} à acquitter` : '', toClose ? `${toClose} à clôturer` : ''].filter(Boolean).join(' · ');
  }

  const container = $('incidents');
  for (const [id, card] of cards) {
    if (!list.some((i) => i.id === id)) {
      card.el.remove();
      cards.delete(id);
    }
  }
  ordered.forEach((incident, index) => {
    let card = cards.get(incident.id);
    if (!card) {
      card = buildCard(incident);
      cards.set(incident.id, card);
    }
    updateCard(card, incident, incident.id === followed?.id);
    // Seules les fiches mal placées bougent : celle où l'on écrit n'est jamais retirée du document (focus gardé).
    if (container.children[index] !== card.el) container.insertBefore(card.el, container.children[index] ?? null);
  });
  if (list.length === 0) renderCalm();
  announce(list);
  renderAlarmsView(list);
}

/** « Tout est calme » : ce qui surveille, et ce qui ne surveille plus (jamais passé sous silence). */
function renderCalm() {
  const detectors = devicesOf('detector');
  const down = detectors.filter((d) => d.status === 'offline' || d.status === 'fault');
  const working = detectors.length - down.length;
  const cameras = devicesOf('camera').length;
  const disarmed = Object.entries(S.arming ?? {}).filter(([, armed]) => armed === false).map(([zone]) => zone);
  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

  const facts = [];
  if (detectors.length === 0) {
    facts.push(h('li', {}, icon('info'), "Aucun détecteur installé : seules les caméras surveillent le site."));
  } else {
    facts.push(h('li', {}, icon('state-ok'), `${plural(working, 'détecteur', 'détecteurs')} en service`));
  }
  facts.push(h('li', {}, icon('camera'), plural(cameras, 'caméra', 'caméras')));
  if (disarmed.length) {
    facts.push(h('li', {}, icon('unlock'), `${disarmed.length > 1 ? `${disarmed.length} zones désarmées` : 'Zone désarmée'} : ${disarmed.join(', ')}`));
  }
  $('calm-summary').replaceChildren(...facts);

  const notice = $('calm-down');
  notice.hidden = down.length === 0;
  const text = notice.querySelector('.calm-down-text') ?? notice.querySelector(':scope > span');
  if (!down.length) return text.replaceChildren();
  text.replaceChildren(
    h('p', {}, h('strong', { text: down.length > 1 ? `${down.length} détecteurs hors service` : '1 détecteur hors service' }), ` : ${down.length > 1 ? 'leur zone n’est plus surveillée' : 'sa zone n’est plus surveillée'}. Prévenez le technicien.`),
    h(
      'ul',
      { class: 'calm-down-list' },
      ...down.map((d) => h('li', {}, h('strong', { text: `${d.id} ${d.name}` }), ` · ${d.zone || 'sans zone'} : ${STATUS_LABEL[d.status]}`)),
    ),
  );
}

// ---------------------------------------------------------------- écran Alarmes

/** Sous 640 px les tableaux sont affichés en fiches (CSS) : les rôles gardent leur sens de tableau pour les lecteurs d'écran. */
export function ariaTable(table) {
  if (!table) return;
  table.setAttribute('role', 'table');
  for (const [selector, role] of [['thead, tbody', 'rowgroup'], ['tr', 'row'], ['th', 'columnheader'], ['td', 'cell']]) {
    for (const el of table.querySelectorAll(selector)) el.setAttribute('role', role);
  }
}

let activeKey = '';
let closedKey = '';

function activeRow(i, floors, primary) {
  const critical = i.severity === 'critical';
  const open = i.status === 'open';
  return h(
    'tr',
    { dataset: { id: String(i.id) }, class: open ? 'is-open' : '' },
    h('td', { 'data-label': 'Niveau' }, h('span', { class: `pill ${critical ? 'is-solid-alarm' : 'is-solid-warning'}` }, icon(critical ? 'state-alarm' : 'state-warning'), levelWord(i))),
    h('td', { class: 'num', 'data-label': 'N°', text: `n° ${i.id}` }),
    h('td', { class: 'cell-main', 'data-label': 'Équipement' }, h('strong', { text: i.detectorName }), h('span', { class: 'cell-sub', text: `${i.detectorId} · ${CATEGORY_LABEL[i.category] ?? CATEGORY_LABEL.fire}` })),
    h('td', { 'data-label': 'Zone', text: i.zone || '—' }),
    floors ? h('td', { 'data-label': 'Étage', text: i.floor || '—' }) : null,
    h('td', { class: 'num alarm-since', 'data-label': 'Depuis', text: elapsed(i.openedAt) }),
    h(
      'td',
      { 'data-label': 'État' },
      open
        ? h('span', { class: 'pill is-alarm' }, icon('bell'), 'À acquitter')
        : [h('span', { class: 'pill is-ok' }, icon('check'), 'Acquittée'), h('span', { class: 'cell-sub', text: `par ${i.ackedBy ?? 'un utilisateur inconnu'} à ${time(i.ackedAt)}` })],
    ),
    h(
      'td',
      { class: 'cell-action' },
      h(
        'button',
        { class: `btn btn-sm${primary ? ' btn-primary' : ''}`, type: 'button', 'aria-label': `Traiter l’alarme n° ${i.id}, ${i.detectorName}`, onclick: () => treat(i.id) },
        'Traiter',
        icon('chevron-right'),
      ),
    ),
  );
}

function closedRow(i) {
  const real = i.qualification === 'fire';
  const shots = h('div', { class: 'shots mini' });
  renderShots(shots, i, true);
  return h(
    'tr',
    {},
    h('td', { class: 'num', 'data-label': 'N°', text: `n° ${i.id}` }),
    h('td', { class: 'cell-main', 'data-label': 'Équipement' }, h('strong', { text: i.detectorName }), h('span', { class: 'cell-sub', text: `${i.zone || 'Zone non renseignée'} · ${levelWord(i)}` })),
    h(
      'td',
      { 'data-label': 'Qualification' },
      h('span', { class: `tag${real ? ' is-alarm' : ''}` }, real ? icon('state-alarm', 'icon-sm') : null, qualificationLabel(i.category, i.qualification) || '—'),
    ),
    h('td', { class: 'num', 'data-label': 'Clôturée' }, h('time', { datetime: new Date(i.closedAt).toISOString(), text: dateTime(i.closedAt) })),
    h('td', { 'data-label': 'Par', text: i.closedBy ?? '—' }),
    h('td', { class: `closed-comment${i.comment ? '' : ' is-empty'}`, 'data-label': 'Commentaire', text: i.comment || '—' }),
    h('td', { class: 'closed-shots', 'data-label': 'Images' }, i.snapshots.length ? shots : h('span', { class: 'faint', text: '—' })),
    h(
      'td',
      { class: 'cell-action' },
      h(
        'a',
        { class: 'btn btn-sm btn-ghost', href: `/api/reports/incidents/${i.id}`, target: '_blank', rel: 'noopener', 'aria-label': `Fiche imprimable de l’incident n° ${i.id} (nouvel onglet)` },
        'Fiche',
        icon('external', 'icon-sm'),
      ),
    ),
  );
}

function renderAlarmsView(list) {
  // En cours : reconstruit seulement quand la liste change (le bouton « Traiter » garde le focus) ; l'attente est
  // rafraîchie chaque seconde par tickIncidents.
  const floors = S.floors.length > 1;
  const key = JSON.stringify([floors, list.map((i) => [i.id, i.status, i.severity, i.detectorName, i.zone, i.floor, i.ackedBy, i.ackedAt, i.category])]);
  if (key !== activeKey) {
    activeKey = key;
    $('alarms-empty').hidden = list.length > 0;
    $('alarms-table').hidden = list.length === 0;
    const floorCol = $('alarms-floor-col');
    if (floorCol) floorCol.hidden = !floors;
    $('alarms-rows').replaceChildren(...(() => { const firstOpen = list.findIndex((i) => i.status === 'open'); return list.map((i, n) => activeRow(i, floors, n === firstOpen)); })());
    ariaTable($('alarms-rows').closest('table'));
  }

  // Clôturées : idem, reconstruit seulement si la liste change (sinon les images seraient rechargées à chaque message).
  const closed = [...S.incidents.values()].filter((i) => !isActive(i)).sort((a, b) => b.closedAt - a.closedAt).slice(0, 10);
  const ckey = JSON.stringify([new Date().toDateString(), closed.map((i) => [i.id, i.qualification, i.comment, i.closedBy, i.closedAt, i.snapshots.length])]);
  if (ckey === closedKey) return;
  closedKey = ckey;
  $('closed-empty').hidden = closed.length > 0;
  $('closed-table').hidden = closed.length === 0;
  $('closed-rows').replaceChildren(...closed.map(closedRow));
  ariaTable($('closed-rows').closest('table'));
}

/** « Traiter » : suit l'incident et ouvre Surveillance, le focus sur sa fiche. */
function treat(id) {
  const incident = S.incidents.get(id);
  if (!incident) return;
  go('surveillance');
  followAndShow(incident);
}

/** Chaque seconde : l'attente des fiches (texte et barre) et du tableau des alarmes. Rien n'est reconstruit. */
export function tickIncidents() {
  const followed = focusedIncident();
  // Alarme suivie changée ailleurs (pastille du plan) sans rendu du panneau : on le refait, une fois.
  if ((followed?.id ?? null) !== shownFollow) return renderIncidents();
  for (const [id, card] of cards) {
    const incident = S.incidents.get(id);
    if (!incident) continue;
    updateWait(card, incident);
    updateCameraStep(card, incident, incident.id === followed?.id);
  }
  for (const row of $('alarms-rows').children) {
    const incident = S.incidents.get(Number(row.dataset.id));
    const cell = row.querySelector('.alarm-since');
    if (incident && cell) cell.textContent = elapsed(incident.openedAt);
  }
}

render.incidents = renderIncidents;
