/**
 * Plan du site : étage affiché à plat ou vue éclatée, pastilles des équipements, glisser-déposer (écran Équipements et
 * plan), traits détecteur -> caméras associées.
 *
 * Le panneau du plan (.c-plan) est UN seul élément : app.js le déplace entre Surveillance et Équipements et plan.
 * Sécurité : les pastilles d'un étage ne sont jamais dessinées sur le plan d'un autre (fond neutre pendant le chargement).
 */
import { createFloorsUi } from './floors.js';
import { createDialogs } from './account.js';
import { CATEGORY_LABEL, formatValue } from './sources.js';
import { $, h, icon, api, toast, S, SVG_NS, STATUS_LABEL, time, clamp, activeIncidents, currentFloor, isFiring, savePlanPrefs, render } from './core.js';
import { wallCameraIds, toggleCamera } from './wall.js';

export const floorsUi = createFloorsUi({ h, api, toast, icon, dialogs: createDialogs({ h }) });

/** Pictogramme de la pastille : la catégorie du détecteur, ou la caméra. */
export const CATEGORY_ICON = { fire: 'fire', intrusion: 'intrusion', access: 'door', environment: 'drop' };

/** État lu par les lecteurs d'écran (le libellé STATUS_LABEL écrit « ALARME » en capitales pour l'œil). */
const STATE_WORD = { normal: 'normal', prealarm: 'préalarme', alarm: 'alarme', fault: 'en défaut', offline: 'hors ligne' };

/** Équipement mis en avant sur le plan : celui de l'éditeur sur l'écran Équipements, la sélection de Surveillance ailleurs. */
const highlighted = () => (S.editMode ? S.editId : S.selectedId);

const isDisarmed = (d) => d.category === 'intrusion' && S.arming[d.zone] === false;

function pinClass(d, onWall, unacked) {
  const parts = ['pin', d.kind];
  if (d.kind === 'detector') {
    parts.push(d.status, `cat-${d.category}`);
    if (isDisarmed(d)) parts.push('disarmed');
    if (unacked.has(d.id)) parts.push('unacked'); // double anneau pulsant tant que l'alarme n'est pas acquittée
  }
  if (highlighted() === d.id) parts.push('selected');
  if (S.editMode) parts.push('editable');
  if (onWall.includes(d.id)) parts.push('on-wall');
  return parts.join(' ');
}

function pinTitle(d) {
  const disarmed = isDisarmed(d) ? ' - zone DÉSARMÉE' : '';
  if (d.kind !== 'detector') return `${d.id} ${d.name} - ${d.zone || 'sans zone'} - caméra`;
  const value = d.lastValue !== null ? ` - ${formatValue(d.lastValue, d.valueUnit)}` : '';
  const seen = d.lastSeen ? time(d.lastSeen) : 'aucun depuis le démarrage';
  return `${d.id} ${d.name} - ${d.zone || 'sans zone'}${disarmed} - ${CATEGORY_LABEL[d.category]}${value} - ${STATUS_LABEL[d.status] ?? d.status} - dernier message : ${seen}`;
}

/** Nom court d'une pastille pour les lecteurs d'écran : identifiant, nom, état ; le détail reste dans l'infobulle. */
function pinLabel(d, onWall, unacked) {
  if (d.kind !== 'detector') return `Caméra ${d.id}, ${d.name}${onWall.includes(d.id) ? ', affichée au mur' : ''}`;
  const state = STATE_WORD[d.status] ?? d.status;
  return `${CATEGORY_LABEL[d.category] ?? 'Détecteur'} ${d.id}, ${d.name} : ${state}${unacked.has(d.id) ? ', à acquitter' : ''}${isDisarmed(d) ? ', zone désarmée' : ''}`;
}

/** Affiche un étage à plat (onglet, plateau de la vue éclatée, incident, inventaire). */
export function showFloor(floorId) {
  S.floorId = floorId;
  S.planMode = 'floor';
  savePlanPrefs();
  renderPlan();
  render.wall(); // vue générale : les caméras de l'étage affiché
  render.admin();
}

export function setPlanMode(mode) {
  S.planMode = mode;
  savePlanPrefs();
  renderPlan();
  render.wall();
}

/**
 * Message posé sur le fond du plan quand l'image n'est pas affichée : chargement, échec, ou pas encore de plan. Il dit
 * quoi faire, et n'est réécrit que s'il change (la scène est redessinée à chaque message d'équipement).
 */
function showPlanMessage(state, floor) {
  const box = $('plan-empty');
  const many = S.floors.length > 1 && floor;
  const key = `${state}|${floor?.id ?? ''}|${floor?.name ?? ''}|${S.editMode}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.dataset.state = state;
  const card = (...children) => box.replaceChildren(h('div', { class: 'plan-none-card' }, ...children));
  if (state === 'loading') {
    card(h('span', { class: 'plan-spinner', 'aria-hidden': 'true' }), h('strong', { text: 'Chargement du plan…' }));
  } else if (state === 'error') {
    card(
      icon('state-offline'),
      h('strong', { text: 'Le plan n’a pas pu être chargé.' }), h('span', { text: 'Vérifiez le réseau ; les équipements restent affichés et à jour.' }),
      h('button', { class: 'btn btn-sm', type: 'button', text: 'Réessayer', onclick: () => { const img = $('plan-img'); img.dataset.src = ''; img.dataset.failed = ''; box.dataset.key = ''; renderPlan(); } }),
    );
  } else {
    card(
      icon('plan'),
      h('strong', { text: `Pas encore de plan${many ? ` pour « ${floor.name} »` : ''}.` }),
      h('span', {
        text: S.editMode
          ? 'Téléversez-le avec « Remplacer le plan » (panneau Étages et plans). Les équipements se placent déjà sur cette grille.'
          : 'Un administrateur peut en téléverser un dans « Équipements et plan ». Les équipements restent affichés.',
      }),
    );
  }
}

export function renderPlan() {
  if (S.dragging) return;
  $('site-name').textContent = S.site.name;
  const floor = currentFloor();
  S.floorId = floor?.id ?? null;
  const stack = S.planMode === 'stack' && S.floors.length > 1;
  const devices = [...S.devices.values()];
  const incidents = activeIncidents();
  floorsUi.renderBar($('floor-bar'), {
    floors: S.floors,
    currentId: S.floorId,
    mode: stack ? 'stack' : 'floor',
    devices,
    incidents,
    editMode: S.editMode,
    onSelect: showFloor,
    onMode: setPlanMode,
  });
  $('stack-view').hidden = !stack;
  $('plan-stage').hidden = stack;
  $('plan-stage').classList.toggle('is-editing', S.editMode);
  if (stack) {
    floorsUi.renderStack($('stack-view'), { floors: S.floors, devices, incidents, statusLabel: STATUS_LABEL, onOpen: showFloor });
    return;
  }

  // Un étage sans plan reste affiché (fond neutre) : ses équipements doivent rester visibles et déplaçables.
  // Pendant le chargement du plan d'un autre étage, fond neutre aussi : jamais les pastilles d'un étage sur le dessin d'un autre.
  const img = $('plan-img');
  const hasPlan = Boolean(floor?.hasPlan);
  const src = floor ? `/api/floors/${floor.id}/plan?v=${floor.planVersion}` : '';
  if (hasPlan && img.dataset.src !== src) {
    img.dataset.src = src;
    img.dataset.ready = '';
    img.dataset.failed = '';
    img.onload = () => {
      if (img.dataset.src === src) {
        img.dataset.ready = '1';
        renderPlan();
      }
    };
    img.onerror = () => {
      if (img.dataset.src !== src) return;
      img.dataset.failed = '1';
      renderPlan();
    };
    img.src = src;
  }
  const planShown = hasPlan && img.dataset.ready === '1';
  $('plan-stage').classList.toggle('no-plan', !planShown);
  $('plan-empty').hidden = planShown;
  if (!planShown) showPlanMessage(!hasPlan ? 'none' : img.dataset.failed === '1' ? 'error' : 'loading', floor);
  img.hidden = !planShown;
  img.alt = floor ? `Plan : ${floor.name}` : 'Plan du site';

  const onWall = wallCameraIds();
  const unacked = new Set(incidents.filter((i) => i.status === 'open').map((i) => i.detectorId));
  const here = devices.filter((d) => d.floorId === S.floorId);
  // Les pastilles sont recréées : celle qui avait le focus clavier le retrouve (sinon il tombe sur la page, au pire
  // moment : un message d'équipement arrive pendant qu'on parcourt le plan au clavier).
  const focusedId = $('plan-pins').contains(document.activeElement) ? document.activeElement.dataset.id : null;
  $('plan-pins').replaceChildren(
    ...here.map((d) => {
      const pin = h(
        'button',
        { type: 'button', class: pinClass(d, onWall, unacked), title: pinTitle(d), 'aria-label': pinLabel(d, onWall, unacked), dataset: { id: d.id } },
        h('span', { class: 'pin-glyph' }, icon(d.kind === 'detector' ? (CATEGORY_ICON[d.category] ?? 'fire') : 'camera')),
        h('span', { class: 'pin-label', text: d.kind === 'detector' && unacked.has(d.id) && d.zone ? `${d.id} · ${d.zone}` : d.id }),
      );
      pin.style.left = `${d.x}%`;
      pin.style.top = `${d.y}%`;
      // Étiquette : sous la pastille, sauf près du bord du plan (à gauche de la pastille à droite, à droite à gauche, au-dessus en bas),
      // pour ne pas couvrir le bord ni le nom de zone dessiné sous les pastilles. Coordonnées enregistrées inchangées.
      const side = d.x > 86 ? 'lbl-left' : d.x < 14 ? 'lbl-right' : d.y > 84 ? 'lbl-top' : '';
      if (side) pin.classList.add(side);
      pin.addEventListener('pointerdown', (ev) => onPinDown(ev, d.id, pin));
      // Clavier (Entrée, Espace) : un « click » sans pointeur (detail 0) ; le clic souris est déjà traité au relâchement.
      pin.addEventListener('click', (ev) => ev.detail === 0 && onPinClick(d.id));
      if (S.editMode) pin.addEventListener('keydown', (ev) => onPinKey(ev, d.id));
      return pin;
    }),
  );
  if (focusedId) $('plan-pins').querySelector(`[data-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });

  // Traits détecteur -> caméras associées (détecteur sélectionné ou en incident), sur l'étage affiché seulement.
  const svg = $('plan-links');
  svg.replaceChildren();
  const shown = new Set(incidents.map((i) => i.detectorId));
  if (highlighted()) shown.add(highlighted());
  for (const detectorId of shown) {
    const det = S.devices.get(detectorId);
    if (det?.kind !== 'detector' || det.floorId !== S.floorId) continue;
    for (const camId of S.links[detectorId] ?? []) {
      const cam = S.devices.get(camId);
      if (!cam || cam.floorId !== S.floorId) continue;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', det.x);
      line.setAttribute('y1', det.y);
      line.setAttribute('x2', cam.x);
      line.setAttribute('y2', cam.y);
      line.setAttribute('class', `link ${isFiring(det) ? 'firing' : ''}`);
      svg.append(line);
    }
  }
}

function onPinDown(ev, id, pin) {
  ev.preventDefault();
  // Repère des positions : la feuille du plan (les x, y enregistrés sont en % de l'image), pas le verre autour.
  const sheet = $('plan-pins');
  const startX = ev.clientX;
  const startY = ev.clientY;
  let moved = false;
  pin.setPointerCapture(ev.pointerId);

  const move = (e) => {
    if (!S.editMode) return;
    if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
    if (!moved) pin.classList.add('is-dragging'); // la pastille « se soulève » sous le doigt
    moved = true;
    S.dragging = true;
    const rect = sheet.getBoundingClientRect();
    pin.style.left = `${clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100)}%`;
    pin.style.top = `${clamp(((e.clientY - rect.top) / rect.height) * 100, 0, 100)}%`;
  };
  const detach = () => {
    pin.removeEventListener('pointermove', move);
    pin.removeEventListener('pointerup', up);
    pin.removeEventListener('pointercancel', cancel);
    pin.removeEventListener('lostpointercapture', lost);
  };
  // Capture perdue sans relâchement (le plan a quitté l'écran d'édition sur une alarme, la pastille a été retirée) :
  // le glissement est abandonné, rien n'est enregistré, et le plan n'est plus figé.
  const lost = () => {
    detach();
    S.dragging = false;
    renderPlan();
  };
  const up = async () => {
    detach();
    pin.classList.remove('is-dragging');
    if (moved) {
      const x = Math.round(parseFloat(pin.style.left) * 10) / 10;
      const y = Math.round(parseFloat(pin.style.top) * 10) / 10;
      S.dragging = false;
      try {
        await api(`/api/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: { x, y } });
      } catch (err) {
        toast(err.message);
        renderPlan();
      }
    } else {
      S.dragging = false;
      onPinClick(id);
    }
  };
  // Geste interrompu par le navigateur (le doigt fait défiler la page) : un glissement commencé est enregistré comme
  // avant, mais un simple appui n'est pas pris pour un clic (la pastille ne se sélectionne pas toute seule).
  const cancel = () => {
    if (moved) return up();
    detach();
    S.dragging = false;
  };
  pin.addEventListener('pointermove', move);
  pin.addEventListener('pointerup', up);
  pin.addEventListener('pointercancel', cancel);
  pin.addEventListener('lostpointercapture', lost);
}

/**
 * Mode édition, au clavier : les flèches déplacent la pastille qui a le focus (pas de 0,5 % du plan, 2 % avec Maj), pour
 * placer un équipement sans souris. La pastille bouge tout de suite ; la position part au serveur quand on s'arrête
 * (un seul enregistrement par série d'appuis), comme au relâchement d'un glisser.
 */
const nudge = { id: null, x: 0, y: 0, from: null, timer: 0 };

function onPinKey(ev, id) {
  const step = ev.shiftKey ? 2 : 0.5;
  const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
  const d = S.devices.get(id);
  if (!delta || !d || !S.editMode || ev.altKey || ev.ctrlKey || ev.metaKey) return;
  ev.preventDefault();
  if (nudge.id !== id) {
    flushNudge();
    Object.assign(nudge, { id, x: d.x, y: d.y, from: { x: d.x, y: d.y } });
  }
  nudge.x = Math.round(clamp(nudge.x + delta[0], 0, 100) * 10) / 10;
  nudge.y = Math.round(clamp(nudge.y + delta[1], 0, 100) * 10) / 10;
  Object.assign(d, { x: nudge.x, y: nudge.y });
  renderPlan(); // la pastille recréée retrouve le focus (même identifiant)
  clearTimeout(nudge.timer);
  nudge.timer = setTimeout(flushNudge, 500);
}

async function flushNudge() {
  clearTimeout(nudge.timer);
  const { id, x, y, from } = nudge;
  nudge.id = null;
  if (!id) return;
  try {
    await api(`/api/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: { x, y } });
  } catch (err) {
    toast(err.message);
    const d = S.devices.get(id);
    if (d && from) Object.assign(d, from); // refusé : la pastille revient où le serveur l'a gardée
    renderPlan();
  }
}

function onPinClick(id) {
  const d = S.devices.get(id);
  if (!d) return;
  // Écran Équipements : la pastille touchée s'ouvre dans l'éditeur. Sur Surveillance, un clic ne change jamais
  // l'équipement en cours de modification : une saisie laissée dans l'éditeur est retrouvée au retour.
  if (S.editMode) S.editId = id;
  // Caméra : ajoutée au mur vidéo (4 au plus, la plus ancienne sort).
  if (d.kind === 'camera') return toggleCamera(id);
  if (!S.editMode) S.selectedId = S.selectedId === id ? null : id;
  const incident = activeIncidents().find((i) => i.detectorId === id);
  if (incident) {
    S.focusIncidentId = incident.id;
    S.manualCams = [];
  }
  renderPlan();
  render.wall();
  render.admin();
}

render.plan = renderPlan;

// Légende : ouverte sur grand écran, repliée sur téléphone (contenu de formation, il ne doit pas séparer le plan du mur de caméras).
try {
  if (window.matchMedia('(max-width: 599px)').matches) $('plan-legend')?.removeAttribute('open');
} catch {
  /* ouverte par défaut */
}
