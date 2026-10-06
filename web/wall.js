/**
 * Mur vidéo et écran Caméras. Le mur (#wall, dans le panneau .c-video) est UN seul élément : app.js déplace le panneau
 * entre Surveillance et Caméras. Aucun flux n'est ouvert en double : une vignette par caméra affichée, arrêtée dès
 * qu'elle quitte le mur.
 *
 * Source du mur : sélection manuelle (4 au plus), sinon les caméras de l'incident suivi, sinon la vue générale.
 */
import { startSimCamera } from './camera.js';
import { startLiveCamera } from './live.js';
import { $, h, icon, toast, S, devicesOf, focusedIncident, currentFloor, floorName, render } from './core.js';

const tiles = new Map(); // idCamera -> { el, stop, caption, alert, status, kind }

/** Flux affichés à la fois : le serveur en sert 6 au plus, et il en faut de reste pour les images jointes aux incidents. */
export const WALL_SIZE = 4;

/** Niveau de feu dans la zone d'une caméra : 0 rien, 1 préalarme, 2 alarme. `fireOnly` : la caméra simulée ne dessine
 *  fumée et flammes que pour un détecteur d'incendie. */
export function fireLevelFor(camera, fireOnly = false) {
  let level = 0;
  for (const d of devicesOf('detector')) {
    if (!camera.zone || d.zone !== camera.zone) continue;
    if (fireOnly && d.category !== 'fire') continue;
    if (d.status === 'alarm') return 2;
    if (d.status === 'prealarm') level = 1;
  }
  return level;
}

/** Caméras du mur : sélection manuelle, caméras de l'incident suivi, ou vue générale (caméras de l'étage affiché). */
export function wallSource() {
  if (S.manualCams.length) return { key: 'manual', kind: 'manual', ids: S.manualCams, label: 'Sélection manuelle' };
  const incident = focusedIncident();
  if (incident) return { key: `incident:${incident.id}`, kind: 'incident', ids: incident.cameraIds, label: `Caméras de l’alarme n°${incident.id} : ${incident.detectorName}` };
  const floor = S.floors.length > 1 && S.planMode === 'floor' ? currentFloor() : null;
  const here = floor ? devicesOf('camera').filter((c) => c.floorId === floor.id) : [];
  if (floor && here.length) return { key: `floor:${floor.id}`, kind: 'general', ids: here.map((c) => c.id), label: `Vue générale : ${floor.name}` };
  return { key: 'all', kind: 'general', ids: devicesOf('camera').map((c) => c.id), label: floor ? `Vue générale (aucune caméra à « ${floor.name} »)` : 'Vue générale' };
}

/** Caméras de la page affichée ; on feuillette par 4 (boutons du mur), et on revient à la page 1 quand la source change. */
export function wallCameraIds() {
  const source = wallSource();
  if (S.wallKey !== source.key) {
    S.wallKey = source.key;
    S.wallPage = 0;
  }
  const ids = source.ids.filter((id) => S.devices.has(id));
  S.wallPages = Math.max(1, Math.ceil(ids.length / WALL_SIZE));
  S.wallPage = Math.min(Math.max(0, S.wallPage ?? 0), S.wallPages - 1);
  return ids.slice(S.wallPage * WALL_SIZE, (S.wallPage + 1) * WALL_SIZE);
}

const MODE_ICON = { manual: 'pin', incident: 'bell', general: 'grid' };

function makeTile(camera) {
  const canvas = h('canvas', { class: 'tile-canvas' });
  const caption = h('div', { class: 'tile-caption' });
  const statusText = h('span');
  const status = h('div', { class: 'tile-status', role: 'status' }, h('span', { class: 'tile-status-mark', 'aria-hidden': 'true' }), icon('state-offline'), statusText);
  status.hidden = true;
  const alert = h('span', { class: 'pill tile-alert' });
  alert.hidden = true;
  const el = h('div', { class: 'tile', role: 'button', tabindex: '0', dataset: { id: camera.id } }, canvas, status, alert, caption);
  el.addEventListener('click', () => zoomCamera(camera.id));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      zoomCamera(camera.id);
    }
  });
  const live = camera.streamKind === 'onvif' || camera.streamKind === 'rtsp';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${live ? 'Flux vidéo' : 'Flux simulé'} ${camera.name}`);
  const stop = live
    ? startLiveCamera(canvas, {
        cameraId: camera.id,
        // Deux sortes de messages : « en cours » (connexion) et « en échec » (la vraie cause, puis nouvelle tentative).
        onStatus: (message) => {
          status.hidden = !message;
          statusText.textContent = message ?? '';
          status.classList.toggle('is-error', Boolean(message) && /tentative/.test(message));
        },
      })
    : startSimCamera(canvas, {
        label: camera.id,
        zone: camera.zone,
        getFire: () => fireLevelFor(S.devices.get(camera.id) ?? camera, true),
      });
  return { el, stop, caption, alert, level: -1, kind: camera.streamKind };
}

export function stopTiles() {
  for (const t of tiles.values()) t.stop();
  tiles.clear();
  $('wall').replaceChildren();
}

/** Ligne au-dessus du mur : d'où viennent les caméras affichées (forme + mot), et la page. Réécrite seulement si elle change. */
function renderMode(source, ids) {
  const pages = S.wallPages;
  const first = S.wallPage * WALL_SIZE + 1;
  const total = source.ids.filter((id) => S.devices.has(id)).length;
  const last = first + ids.length - 1;
  const span = ids.length <= 1 ? `caméra ${first}` : ids.length === 2 ? `caméras ${first} et ${last}` : `caméras ${first} à ${last}`;
  const range = pages > 1 ? ` · ${span} sur ${total}` : '';
  const text = `${source.label}${range}`;
  const box = $('wall-mode');
  if (box.dataset.text === text) return;
  box.dataset.text = text;
  box.className = `wall-mode is-${source.kind}`;
  box.replaceChildren(icon(MODE_ICON[source.kind] ?? 'grid', 'icon-sm'), h('span', { text }));
}

/** Mur vide : dire pourquoi, et comment y mettre des caméras. */
function emptyWall(source) {
  if (!devicesOf('camera').length) {
    return h('div', { class: 'empty' }, icon('camera'), h('strong', { text: 'Aucune caméra configurée.' }), h('span', { text: 'Un administrateur ajoute les caméras dans « Équipements et plan ».' }));
  }
  if (source.kind === 'incident') {
    return h(
      'div',
      { class: 'empty' },
      icon('camera'),
      h('strong', { text: 'Aucune caméra n’est liée à ce détecteur.' }),
      h('span', { text: `${S.view === 'cameras' ? 'Choisissez une caméra dans la liste ci-dessus' : 'Touchez une caméra sur le plan, ou ouvrez l’écran Caméras'}, pour regarder la zone. Un administrateur peut lier des caméras au détecteur dans « Équipements et plan ».` }),
    );
  }
  return h('div', { class: 'empty' }, icon('camera'), h('strong', { text: 'Aucune caméra à afficher.' }), h('span', { text: `Choisissez des caméras ${S.view === 'cameras' ? 'dans la liste ci-dessus' : 'dans l’écran Caméras'}${S.manualCams.length ? ', ou touchez « Retour automatique »' : ''}.` }));
}

export function renderWall() {
  const wall = $('wall');
  const ids = wallCameraIds();
  const source = wallSource();
  const pages = S.wallPages;
  renderMode(source, ids);
  $('wall-page').textContent = `${S.wallPage + 1} / ${pages}`;
  $('wall-page').title = `Page ${S.wallPage + 1} sur ${pages}`;
  $('wall-pager').hidden = pages <= 1;
  $('wall-prev').disabled = S.wallPage === 0;
  $('wall-next').disabled = S.wallPage >= pages - 1;
  $('wall-auto').hidden = S.manualCams.length === 0;

  for (const [id, tile] of tiles) {
    if (!ids.includes(id)) {
      tile.stop();
      tile.el.remove();
      tiles.delete(id);
    }
  }
  // Le message « aucune caméra » d'un mur vide doit disparaître dès qu'une caméra arrive.
  if (ids.length > 0) for (const stale of [...wall.children]) if (stale.classList.contains('empty')) stale.remove();
  ids.forEach((id, index) => {
    const camera = S.devices.get(id);
    let tile = tiles.get(id);
    if (tile && tile.kind !== camera.streamKind) {
      // La source de la caméra a changé (simulée <-> réelle) : on reconstruit la vignette.
      tile.stop();
      tile.el.remove();
      tiles.delete(id);
      tile = undefined;
    }
    if (!tile) {
      tile = makeTile(camera);
      tiles.set(id, tile);
    }
    // Plusieurs étages : la légende dit où est la caméra (elle peut filmer un autre étage que celui affiché).
    const floor = S.floors.length > 1 && floorName(camera.floorId) ? ` (${floorName(camera.floorId)})` : '';
    tile.caption.textContent = `${camera.name}${camera.zone ? ` — ${camera.zone}` : ''}${floor}`;
    tile.caption.title = tile.caption.textContent;
    // Vignette cliquable : elle passe en vue unique pleine largeur, et un second appui rend le mur d'avant.
    const single = ids.length === 1 && S.manualCams.length === 1 && zoomed === id;
    tile.el.setAttribute('aria-label', `${single ? 'Revenir à la vue d’ensemble' : 'Agrandir la caméra'} : ${tile.caption.textContent}`);
    tile.el.classList.toggle('is-zoomed', single);
    // Zone en alarme : contour rouge et puce « Alarme dans la zone » ; en préalarme : ambre et « Préalarme dans la zone ».
    const level = fireLevelFor(camera);
    if (tile.level !== level) {
      tile.level = level;
      tile.el.classList.toggle('alert', level === 2);
      tile.el.classList.toggle('warn', level === 1);
      tile.alert.hidden = level === 0;
      tile.alert.className = `pill tile-alert ${level === 2 ? 'is-solid-alarm' : 'is-solid-warning'}`;
      if (level) tile.alert.replaceChildren(icon(level === 2 ? 'state-alarm' : 'state-warning'), level === 2 ? 'Alarme dans la zone' : 'Préalarme dans la zone');
    }
    if (wall.children[index] !== tile.el) wall.insertBefore(tile.el, wall.children[index] ?? null);
  });
  wall.className = `wall n${Math.max(ids.length, 1)}`;
  if (ids.length === 0) {
    const key = `${source.key}|${devicesOf('camera').length > 0}`;
    if (wall.dataset.empty !== key || !wall.querySelector('.empty')) {
      wall.dataset.empty = key;
      wall.replaceChildren(emptyWall(source));
    }
  } else delete wall.dataset.empty;
  renderCameraPicker(ids);
}

let zoomed = null; // caméra agrandie par un appui sur sa vignette
let beforeZoom = []; // sélection manuelle d'avant l'agrandissement

/** Appui sur une vignette : cette caméra seule, pleine largeur ; un second appui rétablit la sélection d'avant. */
function zoomCamera(id) {
  if (zoomed === id && S.manualCams.length === 1 && S.manualCams[0] === id) {
    S.manualCams = beforeZoom;
    zoomed = null;
  } else {
    if (zoomed === null || S.manualCams.length !== 1) beforeZoom = S.manualCams;
    S.manualCams = [id];
    zoomed = id;
  }
  render.plan();
  renderWall();
}

/**
 * Pastille d'une caméra touchée sur le plan : ajoutée à la sélection manuelle du mur ou retirée (4 au plus, la plus
 * ancienne sort). Sur Surveillance, elle devient aussi la sélection du plan ; sur l'écran Équipements, c'est plan.js qui
 * l'ouvre dans l'éditeur.
 */
export function toggleCamera(id) {
  if (!S.editMode) S.selectedId = S.selectedId === id ? null : id;
  zoomed = null;
  S.manualCams = S.manualCams.includes(id) ? S.manualCams.filter((c) => c !== id) : [...S.manualCams, id].slice(-WALL_SIZE);
  render.plan();
  renderWall();
  render.admin();
}

/**
 * Puce de l'écran Caméras : « enfoncée » veut dire « affichée au mur », et la toucher bascule exactement cet état. On part
 * de ce qui est affiché : pendant une alarme, une caméra ajoutée rejoint celles de l'incident au lieu de les remplacer.
 * Ne touche ni à la sélection du plan ni à l'éditeur d'équipement.
 */
function pickCamera(id) {
  zoomed = null;
  const base = S.manualCams.length ? S.manualCams : wallCameraIds();
  S.manualCams = base.includes(id) ? base.filter((c) => c !== id) : [...base, id].slice(-WALL_SIZE);
  if (!S.manualCams.length) toast('Plus de sélection : retour à l’affichage automatique', 'ok');
  render.plan(); // liseré « à l'écran » des pastilles
  renderWall();
}

/**
 * Écran Caméras : une puce-bouton par caméra (enfoncée si elle est au mur). Reconstruite seulement quand la liste des
 * caméras change, sinon mise à jour sur place (le focus clavier reste sur la puce touchée).
 */
function renderCameraPicker(onWall) {
  const box = $('camera-picker');
  const cameras = devicesOf('camera');
  const many = S.floors.length > 1;
  const key = JSON.stringify([cameras.map((c) => [c.id, c.name, c.zone, c.floorId]), many && S.floors.map((f) => [f.id, f.name])]);
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.replaceChildren(
      ...(cameras.length
        ? cameras.map((c) => {
            const floor = many && floorName(c.floorId) ? ` · ${floorName(c.floorId)}` : '';
            return h(
              'button',
              { type: 'button', class: 'cam-chip', dataset: { id: c.id }, 'aria-pressed': 'false', onclick: () => pickCamera(c.id) },
              h('span', { class: 'cam-chip-glyph' }, icon('camera')),
              h('span', { class: 'cam-chip-text' }, h('strong', { text: `${c.id} · ${c.name}`, title: `${c.id} · ${c.name}` }), h('small', { text: `${c.zone || 'Sans zone'}${floor}` })),
              // Zone en alarme : dit en mots sur la puce (choisir la bonne caméra pendant une alarme).
              h('span', { class: 'cam-chip-alert', hidden: true }, icon('state-alarm', 'icon-sm'), h('span', { text: 'Alarme' })),
              // « Affichée » : l'état enfoncé se lit aussi en mots et en forme, pas seulement à la couleur.
              h('span', { class: 'cam-chip-on', 'aria-hidden': 'true' }, icon('check', 'icon-sm'), 'Affichée'),
            );
          })
        : [h('div', { class: 'empty' }, icon('camera'), h('strong', { text: 'Aucune caméra configurée.' }), h('span', { text: 'Un administrateur ajoute les caméras dans « Équipements et plan ».' }))]),
    );
  }
  for (const chip of box.querySelectorAll('.cam-chip')) {
    const camera = S.devices.get(chip.dataset.id);
    chip.setAttribute('aria-pressed', String(onWall.includes(chip.dataset.id)));
    const level = camera ? fireLevelFor(camera) : 0;
    const alert = chip.querySelector('.cam-chip-alert');
    alert.hidden = level === 0;
    alert.classList.toggle('is-warning', level === 1);
    alert.lastChild.textContent = level === 1 ? 'Préalarme' : 'Alarme';
    chip.classList.toggle('is-alert', level > 0);
  }
  const count = $('camera-count');
  const src = wallSource();
  const n = `${onWall.length} caméra${onWall.length > 1 ? 's' : ''}`;
  count.textContent = !cameras.length ? '' : src.kind === 'manual' ? `Votre sélection : ${onWall.length} sur ${WALL_SIZE}` : src.kind === 'incident' ? `Alarme n°${src.key.split(':')[1]} : ${n}` : `Vue générale : ${n}`;
}

// Le bouton touché disparaît (Retour automatique) ou se désactive (dernière page) : le focus clavier ne doit pas tomber
// sur la page. Il va à la ligne qui dit ce que montre le mur, ou au bouton de page opposé.
$('wall-mode').tabIndex = -1;
$('wall-auto').addEventListener('click', () => {
  zoomed = null;
  S.manualCams = [];
  render.plan();
  renderWall();
  $('wall-mode').focus();
});
for (const [id, step, other] of [['wall-prev', -1, 'wall-next'], ['wall-next', 1, 'wall-prev']]) {
  $(id).addEventListener('click', () => {
    S.wallPage = (S.wallPage ?? 0) + step;
    renderWall();
    render.plan(); // le liseré « à l'écran » des pastilles suit la page
    if ($(id).disabled) $(other).focus();
  });
}

render.wall = renderWall;
