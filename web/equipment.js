/**
 * Écran Équipements et plan (administrateur) : éditeur de l'équipement sélectionné (identité, étage, réglages de mesure,
 * détection Dahua, caméras liées, source vidéo), ajout, étages et plans, inventaire ; et le tableau du Simulateur.
 *
 * L'équipement de l'éditeur est S.editId, posé seulement ici (inventaire, ajout) et par un clic sur une pastille en
 * mode édition : la sélection de Surveillance ou de l'écran Caméras ne le change jamais.
 *
 * Le plan est déplacé ici par app.js, en mode édition (S.editMode) : les pastilles se glissent, un clic sélectionne.
 * Une saisie en cours n'est jamais écrasée : l'éditeur n'est reconstruit que si ce qu'il montre a changé, et jamais
 * tant qu'un champ y est modifié et pas enregistré, qu'il a le focus ou qu'une opération y est en cours. Changer
 * d'équipement avec des modifications en attente demande confirmation.
 */
import { buildDetectorSource } from './detsource.js';
import {
  CATEGORIES,
  CATEGORY_LABEL,
  CATEGORY_HINT,
  formatValue,
  buildSensorForm,
  createSimControls,
  field,
  setFieldError,
  clearFieldErrors,
  statusLine,
  setStatus,
  withBusy,
  pick,
  isDirty,
  markSaved,
} from './sources.js';
import { createDialogs } from './account.js';
import { $, h, icon, api, toast, S, emit, time, devicesOf, currentFloor, floorName, STATUS_LABEL, render } from './core.js';
import { CATEGORY_ICON, floorsUi, showFloor } from './plan.js';

const simControls = createSimControls();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---------------------------------------------------------------- états, pictogrammes

/** État d'un détecteur : forme, icône et mot. */
const STATE_PILL = {
  normal: ['is-ok', 'state-ok'],
  prealarm: ['is-warning', 'state-warning'],
  alarm: ['is-alarm', 'state-alarm'],
  fault: ['is-fault', 'wrench'],
  offline: ['is-offline', 'state-offline'],
};

export function statePill(status) {
  const [cls, name] = STATE_PILL[status] ?? ['is-dashed', 'state-unknown'];
  return h('span', { class: `pill ${cls}` }, icon(name), STATUS_LABEL[status] ?? status);
}

/** Source vidéo d'une caméra, en mots (l'écran ne mesure pas l'état d'une caméra : il dit d'où vient l'image). */
const STREAM_LABEL = { simulated: 'Image de démonstration', onvif: 'Caméra réseau', rtsp: 'Flux vidéo direct' };
const streamTag = (c) => h('span', { class: `tag${c.streamKind === 'onvif' || c.streamKind === 'rtsp' ? ' is-info' : ' is-dashed'}` }, icon('camera', 'icon-sm'), STREAM_LABEL[c.streamKind] ?? 'Source à régler');

/** Ce que veut dire un état anormal, et quoi faire (l'éditeur l'écrit sous l'en-tête). */
function stateAdvice(d) {
  const seen = d.lastSeen ? `dernier message à ${time(d.lastSeen)}` : 'aucun message depuis le démarrage';
  switch (d.status) {
    case 'alarm':
      return ['is-alarm', 'state-alarm', 'En alarme : traitez-la depuis l’écran Surveillance (acquitter, puis clôturer).'];
    case 'prealarm':
      return ['is-warning', 'state-warning', 'Préalarme : à vérifier sur place, une alarme peut suivre.'];
    case 'fault':
      return ['is-fault', 'wrench', 'Défaut : le détecteur signale une panne, sa zone n’est plus surveillée correctement. Prévenez le technicien.'];
    case 'offline':
      return ['is-offline', 'state-offline', `Hors ligne : ce détecteur ne surveille plus sa zone (${seen}). Vérifiez son alimentation et sa liaison.`];
    default:
      return null;
  }
}

/** Pictogramme d'un équipement, à la forme de sa pastille sur le plan ; coloré par l'état si `state`. */
function glyph(d, { state = false, small = false } = {}) {
  const shape = d.kind === 'camera' ? 'is-camera' : `cat-${d.category}`;
  const color = state && d.kind === 'detector' ? ` st-${d.status}` : '';
  // Deux étages : la forme (tournée pour le losange et la goutte) et, par-dessus, le trait « barré » qui ne tourne pas.
  return h('span', { class: `eq-glyph ${shape}${color}${small ? ' is-sm' : ''}`, 'aria-hidden': 'true' }, h('span', { class: 'eq-shape' }, icon(d.kind === 'detector' ? (CATEGORY_ICON[d.category] ?? 'fire') : 'camera')));
}

const typeLabel = (d) => (d.kind === 'detector' ? CATEGORY_LABEL[d.category] : 'Caméra');
const byId = (a, b) => a.id.localeCompare(b.id, 'fr', { numeric: true });

// ---------------------------------------------------------------- rendu de l'écran

/** `force` (état complet reçu) est accepté pour l'appel d'app.js : l'éditeur décide seul s'il doit être refait. */
export function renderAdmin(force = false) {
  if (S.me?.role !== 'admin') return;
  if (S.me.simEnabled) renderSim();
  if (S.editMode) {
    const floor = currentFloor();
    const many = S.floors.length > 1 && floor;
    // L'étage visé est celui ÉCRIT sur le bouton au moment du clic, pas celui affiché au moment de l'envoi.
    $('plan-file').dataset.floor = floor ? String(floor.id) : '';
    $('add-submit').dataset.floor = floor ? String(floor.id) : '';
    $('add-submit-text').textContent = 'Ajouter au centre du plan';
    $('add-where').textContent = `L’équipement apparaît au centre du plan${many ? ` de « ${floor.name} »` : ''} : glissez-le ensuite à sa place.`;
    renderPlanUpload(floor);
    renderZoneList();
    updateIdPlaceholder();
    floorsUi.renderAdmin($('floor-admin'), { floors: S.floors, devices: [...S.devices.values()], currentId: S.floorId, rerender: () => renderAdmin() });
    renderInventory();
  }
  renderDeviceEditor();
}

/** Zones existantes proposées en saisie (une zone mal orthographiée serait une autre zone : armement, risques…). */
let zonesKey = '';
function renderZoneList() {
  const zones = [...new Set([...S.devices.values()].map((d) => d.zone).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
  const key = zones.join('\n');
  if (key === zonesKey) return;
  zonesKey = key;
  $('eq-zones').replaceChildren(...zones.map((z) => h('option', { value: z })));
}

// ---------------------------------------------------------------- éditeur de l'équipement sélectionné

/** Ce que montre l'éditeur (hors état, mesure et position, mis à jour sur place) : s'il change, l'éditeur est refait. */
function editorKey(d) {
  const cameras = d.kind === 'detector' ? devicesOf('camera').map((c) => [c.id, c.name, c.zone, c.floorId, c.streamKind]) : null;
  return JSON.stringify([
    d.id, d.kind, d.name, d.zone, d.floorId, d.category, d.valueUnit, d.warnAt, d.alarmAt, d.direction, d.heartbeatS, d.streamKind,
    S.floors.map((f) => [f.id, f.name]), cameras, d.kind === 'detector' ? (S.links[d.id] ?? []) : null,
  ]);
}

// Sections dépliées ou repliées : gardées d'un équipement à l'autre (l'installateur règle souvent la même chose).
const openSections = new Map([['sensor', false], ['dahua', true], ['links', true], ['video', true]]);

function renderDeviceEditor() {
  const box = $('device-editor');
  const d = S.editId ? S.devices.get(S.editId) : null;
  if (!d) {
    if (box.dataset.for) {
      // Équipement supprimé (ici ou depuis un autre poste) : le contenu part, et avec lui le suivi de sa source.
      if (isDirty(box) && !S.devices.has(box.dataset.for)) toast(`${box.dataset.for} a été supprimé : les modifications en cours sont perdues`);
      box.replaceChildren();
      delete box.dataset.for;
      delete box.dataset.key;
    }
    box.hidden = true;
    $('device-empty').hidden = false;
    return;
  }
  // Écran quitté (alarme, autre écran) : rien n'est vidé, la saisie interrompue est retrouvée au retour.
  if (!S.editMode) return;
  box.hidden = false;
  $('device-empty').hidden = true;

  const same = box.dataset.for === d.id;
  if (!same && needsLeaveConfirm(d.id)) {
    // On reste d'abord sur l'équipement en cours (sa pastille reste mise en avant), puis on demande dans la fenêtre du PSIM.
    S.editId = box.dataset.for;
    render.plan();
    renderInventory();
    confirmLeave(d.id).then((ok) => {
      if (!ok || !S.devices.has(d.id)) return;
      S.editId = d.id;
      showFloor(d.floorId);
    });
    return;
  }
  const key = editorKey(d);
  if (same) {
    updateHead(box, d);
    if (box.dataset.key === key) return;
    // Changé ailleurs (enregistrement, autre poste) : refait seulement quand plus rien n'y est en cours.
    if (isDirty(box) || box.contains(document.activeElement) || box.querySelector('[aria-busy="true"]')) return;
  }
  buildEditor(box, d, key);
  if (!same) {
    $('editor-announce').textContent = `${d.id}, ${d.name} : ouvert dans l’éditeur.`;
    if (revealOnOpen) revealEditor(false);
  }
}

// Un équipement qu'on vient d'ajouter s'ouvre dans l'éditeur sans faire défiler l'écran : on reste sur le formulaire.
let revealOnOpen = true;

/** Faut-il demander avant d'ouvrir `nextId` ? Vrai si l'éditeur montre un autre équipement dont des champs sont modifiés. */
function needsLeaveConfirm(nextId) {
  const box = $('device-editor');
  const current = box.dataset.for;
  return Boolean(current && current !== nextId && S.devices.has(current) && isDirty(box));
}

/** Avant de quitter un équipement dont des champs sont modifiés : on demande, dans la fenêtre du PSIM. Vrai si on peut changer. */
async function confirmLeave(nextId) {
  if (!needsLeaveConfirm(nextId)) return true;
  const box = $('device-editor');
  const current = box.dataset.for;
  const ok = await createDialogs({ h }).confirm({
    heading: `Modifications de ${current} non enregistrées`,
    message: `Les modifications de ${current} ne sont pas enregistrées. Les abandonner et ouvrir ${nextId} ?`,
    confirmLabel: 'Abandonner les modifications',
    danger: true,
  });
  if (!ok) return false;
  box.replaceChildren(); // abandon accepté : plus rien à protéger
  delete box.dataset.for;
  return true;
}

/** Amène l'éditeur à l'écran s'il en est sorti (colonne unique, panneau défilé) ; le focus va au nom si demandé. */
function revealEditor(focus) {
  const panel = $('editor-panel');
  const top = panel.getBoundingClientRect().top;
  const sheet = $('workspace').getBoundingClientRect();
  if (top < sheet.top + 60 || top > sheet.bottom - 160) panel.scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  if (focus) $('device-editor').querySelector('.editor-name')?.focus({ preventScroll: true });
}

// Focus sorti de l'éditeur : s'il attendait d'être mis à jour (enregistrement, autre poste), c'est le moment.
$('device-editor').addEventListener('focusout', () =>
  setTimeout(() => {
    const box = $('device-editor');
    if (S.editMode && !box.contains(document.activeElement)) renderDeviceEditor();
  }),
);

function buildEditor(box, d, key) {
  const children = [
    h(
      'div',
      { class: 'editor-head' },
      h('span', { class: 'editor-glyph' }),
      h('div', { class: 'editor-id' }, h('h3', { class: 'editor-name', tabindex: '-1' }), h('p', { class: 'editor-sub' })),
      h('span', { class: 'editor-pill' }),
    ),
    h('p', { class: 'editor-facts hint' }),
    h('div', { class: 'editor-advice notice', hidden: true }),
    identityForm(d),
  ];
  if (S.floors.length > 1) children.push(moveForm(d));
  if (d.kind === 'camera') children.push(section('video', 'Source vidéo', 'camera', buildSourceForm(d)));
  if (d.kind === 'detector') {
    children.push(section('sensor', 'Réglages de mesure', 'sliders', buildSensorForm(d)));
    if (d.category === 'intrusion') children.push(section('dahua', "Détection par l’enregistreur vidéo", 'intrusion', buildDetectorSource(d, { cameras: () => devicesOf('camera') })));
    children.push(section('links', 'Caméras liées', 'camera', linksForm(d)));
  }
  children.push(dangerZone(d));
  box.dataset.for = d.id;
  box.dataset.key = key;
  box.replaceChildren(...children);
  updateHead(box, d);
}

/** En-tête : nom enregistré, type, étage, état et sa signification. Mis à jour sur place à chaque message (sans champ). */
function updateHead(box, d) {
  const head = box.querySelector('.editor-head');
  if (!head) return;
  head.querySelector('.editor-glyph').replaceChildren(glyph(d, { state: true }));
  head.querySelector('.editor-name').textContent = d.name;
  const where = S.floors.length > 1 && floorName(d.floorId) ? ` · ${floorName(d.floorId)}` : '';
  head.querySelector('.editor-sub').textContent = `${d.id} · ${d.kind === 'detector' ? `Détecteur ${CATEGORY_LABEL[d.category].toLowerCase()}` : 'Caméra'} · ${d.zone || 'sans zone'}${where}`;
  head.querySelector('.editor-pill').replaceChildren(d.kind === 'detector' ? statePill(d.status) : streamTag(d));
  const facts = box.querySelector('.editor-facts');
  if (d.kind === 'detector') {
    const parts = [d.lastSeen ? `Dernier message reçu à ${time(d.lastSeen)}` : 'Aucun message reçu depuis le démarrage du PSIM'];
    if (d.lastValue !== null) parts.push(`mesure : ${formatValue(d.lastValue, d.valueUnit)}`);
    facts.textContent = `${parts.join(' · ')}.`;
  } else facts.textContent = '';
  facts.hidden = !facts.textContent;
  const advice = box.querySelector('.editor-advice');
  const a = stateAdvice(d);
  advice.hidden = !a;
  if (a) {
    advice.className = `editor-advice notice ${a[0]}`;
    advice.replaceChildren(icon(a[1]), h('span', { text: a[2] }));
  }
}

/** Section repliable de l'éditeur, son état (déplié / replié) retenu. */
function section(id, title, iconName, ...content) {
  const details = h('details', { class: 'editor-section', open: openSections.get(id) }, h('summary', {}, icon(iconName), h('h4', { text: title }), icon('chevron-down', 'editor-chevron')), h('div', { class: 'editor-section-body' }, ...content));
  details.addEventListener('toggle', () => openSections.set(id, details.open));
  return details;
}

/** Nom et zone. */
function identityForm(d) {
  const name = h('input', { value: d.name, maxlength: '80', autocomplete: 'off', required: true });
  const zone = h('input', { value: d.zone, maxlength: '80', autocomplete: 'off', list: 'eq-zones' });
  const save = h('button', { class: 'btn', type: 'submit', text: 'Enregistrer' });
  const status = statusLine();
  const form = h(
    'form',
    { class: 'editor-identity', novalidate: true },
    h('div', { class: 'eq-grid' }, field('Nom', name), field('Zone', zone, 'Sert à l’armement, aux personnes prévenues et à l’indice de risque. Reprenez une zone existante pour regrouper.')),
    h('div', { class: 'actions' }, save, status),
  );
  name.addEventListener('input', () => name.value.trim() && setFieldError(name));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (save.classList.contains('is-busy')) return; // Entrée pendant l'envoi : un seul enregistrement
    clearFieldErrors(form);
    if (!name.value.trim()) {
      setFieldError(name, 'Donnez un nom à l’équipement (ex. Couloir nord).');
      return name.focus();
    }
    setStatus(status, 'busy', 'Enregistrement…');
    try {
      await withBusy(save, () => api(`/api/devices/${encodeURIComponent(d.id)}`, { method: 'PATCH', body: { name: name.value.trim(), zone: zone.value.trim() } }));
      name.value = name.value.trim();
      zone.value = zone.value.trim();
      markSaved(form);
      setStatus(status, 'ok', 'Enregistré.');
      document.dispatchEvent(new CustomEvent('psim:zone-saved', { detail: { id: d.id, zone: zone.value } }));
    } catch (err) {
      setStatus(status, 'error', err.message);
    }
  });
  return form;
}

/** Changer d'étage : l'équipement garde sa position (en % du plan) et l'écran suit vers son nouvel étage. */
function moveForm(d) {
  const floorSelect = h('select', {}, ...[...S.floors].reverse().map((f) => h('option', { value: String(f.id), text: f.name })));
  pick(floorSelect, String(d.floorId));
  let savedFloor = d.floorId;
  // Rien ne part au simple changement de choix (les flèches du clavier en déclenchent un à chaque pas) : bouton explicite.
  const move = h('button', { class: 'btn', type: 'button', disabled: true }, icon('layers'), 'Déplacer vers cet étage');
  const status = statusLine();
  floorSelect.addEventListener('change', () => {
    move.disabled = Number(floorSelect.value) === savedFloor;
    setStatus(status, '');
  });
  move.addEventListener('click', async () => {
    const floorId = Number(floorSelect.value);
    setStatus(status, 'busy', 'Déplacement…');
    try {
      await withBusy(move, () => api(`/api/devices/${encodeURIComponent(d.id)}`, { method: 'PATCH', body: { floorId } }));
      markSaved(floorSelect.parentElement);
      savedFloor = floorId;
      move.disabled = true;
      setStatus(status, 'ok', `Déplacé vers « ${floorName(floorId)} » : placez-le sur ce plan.`);
      showFloor(floorId);
    } catch (err) {
      setStatus(status, 'error', err.message);
    }
  });
  return h('div', { class: 'editor-move' }, field('Étage', floorSelect, 'Il garde sa place relative sur le plan du nouvel étage.'), h('div', { class: 'actions' }, move, status));
}

/** Caméras affichées d'elles-mêmes quand ce détecteur déclenche. Chaque case s'enregistre aussitôt. */
function linksForm(d) {
  const cameras = devicesOf('camera').sort((a, b) => (a.floorId === d.floorId ? 0 : 1) - (b.floorId === d.floorId ? 0 : 1) || byId(a, b));
  if (!cameras.length) {
    return h(
      'div',
      { class: 'empty' },
      icon('camera'),
      h('strong', { text: 'Aucune caméra pour l’instant' }),
      h('span', { text: 'Ajoutez-en une avec « Ajouter un équipement », puis cochez-la ici : elle s’affichera dès que ce détecteur déclenche.' }),
    );
  }
  const linked = new Set(S.links[d.id] ?? []);
  const status = statusLine();
  const list = h('ul', { class: 'eq-checks', 'aria-label': `Caméras liées à ${d.id}` });
  let seq = 0;
  const save = async (input) => {
    const ids = [...list.querySelectorAll('input:checked')].map((el) => el.value);
    const mine = ++seq; // seule la dernière demande décide du message et de l'état occupé
    list.setAttribute('aria-busy', 'true');
    setStatus(status, 'busy', 'Enregistrement…');
    try {
      await api(`/api/devices/${encodeURIComponent(d.id)}/links`, { method: 'PUT', body: { cameraIds: ids } });
      if (mine !== seq) return;
      markSaved(list);
      setStatus(status, 'ok', ids.length ? `Enregistré : ${ids.join(', ')} s’afficheront quand ${d.id} déclenche.` : `Enregistré : aucune caméra ne s’affichera pour ${d.id}.`);
    } catch (err) {
      if (mine !== seq) return;
      input.checked = !input.checked; // l'état affiché redevient l'état enregistré
      setStatus(status, 'error', err.message);
    } finally {
      if (mine === seq) list.removeAttribute('aria-busy');
    }
  };
  for (const c of cameras) {
    const input = h('input', { type: 'checkbox', value: c.id, checked: linked.has(c.id) });
    input.addEventListener('change', () => save(input));
    const where = [c.zone || 'sans zone', S.floors.length > 1 ? floorName(c.floorId) : ''].filter(Boolean).join(' · ');
    list.append(h('li', {}, h('label', { class: 'check' }, input, glyph(c, { small: true }), h('span', { class: 'eq-check-text' }, h('strong', { text: c.id }), ` ${c.name}`, h('span', { class: 'muted', text: ` — ${where}` })))));
  }
  return h('div', { class: 'eq-links' }, h('p', { class: 'hint', text: 'Elles s’affichent d’elles-mêmes sur le mur vidéo quand ce détecteur déclenche, et un trait les relie à lui sur le plan.' }), list, h('div', { class: 'actions' }, status));
}

/** Geste grave : isolé en bas, confirmé en mots simples. */
function dangerZone(d) {
  const remove = h('button', { class: 'btn btn-danger', type: 'button' }, icon('trash'), 'Supprimer cet équipement');
  const status = statusLine();
  remove.addEventListener('click', async () => {
    const ok = await createDialogs({ h }).confirm({
      heading: `Supprimer ${d.id}`,
      message: `${d.id} « ${d.name} » disparaît du plan et de l’inventaire. Cette action ne peut pas être annulée.`,
      confirmLabel: 'Supprimer définitivement',
      danger: true,
    });
    if (!ok) return;
    setStatus(status, 'busy', 'Suppression…');
    try {
      await withBusy(remove, () => api(`/api/devices/${encodeURIComponent(d.id)}`, { method: 'DELETE' }));
      toast(`${d.id} supprimé`, 'ok');
      if (S.editId === d.id) S.editId = null;
      const box = $('device-editor');
      box.replaceChildren(); // plus rien à protéger : l'équipement n'existe plus
      delete box.dataset.for;
      render.plan();
      renderAdmin();
      $('device-empty').focus(); // le bouton touché a disparu : le focus va au message qui le remplace
    } catch (err) {
      setStatus(status, 'error', err.message);
    }
  });
  return h(
    'div',
    { class: 'editor-danger' },
    h(
      'p',
      { class: 'hint', text: d.kind === 'detector' ? 'Le détecteur disparaît du plan et de l’inventaire. Impossible s’il a déjà eu des alarmes : son historique est conservé.' : 'La caméra disparaît du plan, de l’inventaire et des détecteurs qui l’affichaient.' },
    ),
    h('div', { class: 'actions' }, status, remove),
  );
}

// ---------------------------------------------------------------- source vidéo d'une caméra

/** Message de la source vidéo d'une caméra : gardé si l'éditeur est refait (un test dure jusqu'à 15 s). */
function setSourceMsg(cameraId, kind, text) {
  S.sourceMsg[cameraId] = { kind, text };
  const el = document.getElementById('source-msg');
  if (el && el.dataset.for === cameraId) setStatus(el, kind, text);
}

function buildSourceForm(d) {
  const wrap = h('div', { class: 'source-form' });
  const url = `/api/cameras/${encodeURIComponent(d.id)}`;
  const load = () => {
    const wait = statusLine();
    setStatus(wait, 'busy', 'Chargement de la source vidéo…');
    wrap.replaceChildren(wait);
    api(`${url}/source`)
      .then((src) => wrap.replaceChildren(sourceFields(d, src, url)))
      .catch((err) => {
        const failed = statusLine();
        setStatus(failed, 'error', `Source vidéo illisible : ${err.message}`);
        const retry = h('button', { class: 'btn btn-sm', type: 'button', onclick: load }, icon('refresh'), 'Réessayer');
        wrap.replaceChildren(failed, h('div', { class: 'actions' }, retry));
      });
  };
  load();
  return wrap;
}

const KIND_HINT = {
  simulated: "Image produite par le PSIM pour la démonstration : aucune caméra n’est branchée.",
  onvif: 'ONVIF est la langue commune des caméras réseau : avec l’adresse de la caméra et son compte, le PSIM trouve seul son flux vidéo.',
  rtsp: 'RTSP est l’adresse directe d’un flux vidéo : utile pour un enregistreur ou une caméra qui ne répond pas en ONVIF. Le chemin figure dans la notice de l’appareil.',
};
const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

function sourceFields(d, src, url) {
  const kind = h(
    'select',
    {},
    h('option', { value: 'simulated', text: 'Démonstration (image simulée)' }),
    h('option', { value: 'onvif', text: 'Caméra réseau' }),
    h('option', { value: 'rtsp', text: 'Flux vidéo direct' }),
  );
  pick(kind, src.kind);
  const kindHint = h('span');
  const host = h('input', { value: src.host ?? '', placeholder: 'ex. 192.168.1.64', maxlength: '253', autocomplete: 'off', spellcheck: 'false' });
  const port = h('input', { value: src.port ?? '', type: 'number', min: '1', max: '65535', inputmode: 'numeric', class: 'input-narrow' });
  const path = h('input', { value: src.rtspPath ?? '', placeholder: 'ex. /Streaming/Channels/102', maxlength: '200', autocomplete: 'off', spellcheck: 'false' });
  const user = h('input', { value: src.username ?? '', maxlength: '64', autocomplete: 'off', spellcheck: 'false' });
  const pass = h('input', { type: 'password', maxlength: '128', autocomplete: 'new-password' });
  const passHint = h('span', { text: src.hasPassword ? 'Un mot de passe est enregistré : laissez vide pour le garder.' : 'Celui du compte de la caméra (il n’est jamais réaffiché).' });
  // Format de l'image : « Automatique » redresse les images d'enregistreur compressées en largeur (704x576, 1440x1620...).
  const aspect = h(
    'select',
    {},
    h('option', { value: 'auto', text: 'Automatique (recommandé)' }),
    h('option', { value: '16:9', text: '16:9 (écran large)' }),
    h('option', { value: '4:3', text: '4:3 (ancienne caméra, image plus carrée)' }),
    h('option', { value: 'source', text: 'Tel que reçu (sans correction)' }),
  );
  pick(aspect, src.aspect ?? 'auto');

  const hostField = field('Adresse de la caméra', host, 'Son adresse IP sur le réseau du site. Vous pouvez aussi coller une adresse complète « rtsp://… » : elle sera découpée.');
  const portHint = h('span');
  const portField = field('Port', port, portHint);
  const pathField = field('Chemin du flux', path, 'Commence par « / ». Indiqué dans la notice de la caméra ou de l’enregistreur.');
  const userField = field('Utilisateur', user);
  const passField = field('Mot de passe', pass, passHint);
  const aspectField = field("Format de l’image", aspect, 'Personnes trop minces sur l’image : choisissez 16:9. Trop larges ou trapues : choisissez 4:3 (ancienne caméra analogique).');

  const found = h('div', { class: 'found', 'aria-label': 'Caméras trouvées sur le réseau', role: 'group' });
  found.hidden = true;
  const previous = S.sourceMsg[d.id];
  const msg = statusLine({ id: 'source-msg', dataset: { for: d.id } });
  if (previous) setStatus(msg, previous.kind, previous.text);

  const discover = h('button', { class: 'btn', type: 'button' }, icon('search'), 'Rechercher sur le réseau');
  const discoverRow = h('div', { class: 'actions' }, discover, h('span', { class: 'hint', text: 'Les caméras réseau du site répondent en quelques secondes.' }));
  const testBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('play'), 'Enregistrer et tester');
  const saveBtn = h('button', { class: 'btn', type: 'button', text: 'Enregistrer' });
  const netFields = [hostField, portField, userField, passField, aspectField];

  const sync = () => {
    const k = kind.value;
    kindHint.textContent = KIND_HINT[k] ?? '';
    for (const el of netFields) el.hidden = k === 'simulated';
    pathField.hidden = k !== 'rtsp';
    discoverRow.hidden = k !== 'onvif';
    testBtn.hidden = k === 'simulated';
    // Une seule action principale : « Enregistrer et tester » pour une vraie caméra, « Enregistrer » sinon.
    saveBtn.classList.toggle('btn-primary', k === 'simulated');
    portHint.textContent = `Laissez vide : ${k === 'rtsp' ? '554' : '80'}, la valeur habituelle.`;
    port.placeholder = k === 'rtsp' ? '554' : '80';
    found.hidden = true;
    found.replaceChildren();
  };

  // Adresse complète collée (« rtsp://admin:…@192.168.1.10:554/cam/realmonitor?channel=1 ») : découpée dans les champs.
  host.addEventListener('change', () => {
    const value = host.value.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return;
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return;
    }
    clearFieldErrors(form);
    host.value = parsed.hostname;
    if (parsed.port) port.value = parsed.port;
    if (parsed.username) user.value = decodeURIComponent(parsed.username);
    if (parsed.password) pass.value = decodeURIComponent(parsed.password);
    if (parsed.protocol === 'rtsp:') {
      kind.value = 'rtsp';
      sync();
      path.value = `${parsed.pathname}${parsed.search}`;
    }
    setSourceMsg(d.id, 'info', 'Adresse complète découpée : vérifiez les champs ci-dessous avant d’enregistrer.');
  });

  /** Vérifie avant l'envoi, avec des mots qui disent quoi corriger. */
  const check = () => {
    clearFieldErrors(form);
    if (kind.value === 'simulated') return true;
    const problems = [];
    if (!host.value.trim()) problems.push([host, 'Indiquez l’adresse de la caméra (ex. 192.168.1.64).']);
    else if (!HOST_PATTERN.test(host.value.trim())) problems.push([host, 'Adresse IP ou nom de machine seulement, sans « http:// » ni chemin (ex. 192.168.1.64).']);
    if (port.value !== '' && !(Number.isInteger(Number(port.value)) && Number(port.value) >= 1 && Number(port.value) <= 65535)) problems.push([port, 'Port de 1 à 65535, ou vide.']);
    if (kind.value === 'rtsp' && path.value.trim() && !path.value.trim().startsWith('/')) path.value = `/${path.value.trim()}`;
    for (const [el, message] of problems) setFieldError(el, message);
    problems[0]?.[0].focus();
    return problems.length === 0;
  };

  const save = async (button, thenTest) => {
    if (button.classList.contains('is-busy') || !check()) return;
    setSourceMsg(d.id, 'busy', 'Enregistrement…');
    await withBusy(button, async () => {
      try {
        const saved = await api(`${url}/source`, {
          method: 'PUT',
          body: {
            kind: kind.value,
            host: host.value.trim(),
            port: port.value === '' ? undefined : Number(port.value),
            rtspPath: path.value.trim(),
            username: user.value,
            password: pass.value,
            aspect: aspect.value,
          },
        });
        pass.value = '';
        markSaved(form);
        if (saved?.hasPassword) passHint.textContent = 'Un mot de passe est enregistré : laissez vide pour le garder.';
        if (thenTest && kind.value !== 'simulated') {
          setSourceMsg(d.id, 'busy', "Test de la connexion en cours (jusqu’à 15 secondes)…");
          const result = await api(`${url}/test`, { method: 'POST' });
          setSourceMsg(d.id, 'ok', `Connexion réussie : ${result.message}`);
        } else {
          setSourceMsg(d.id, 'ok', kind.value === 'simulated' ? 'Enregistré : la caméra montre l’image de démonstration.' : 'Source enregistrée (non testée).');
        }
      } catch (err) {
        setSourceMsg(d.id, 'error', /v[ée]rifi/i.test(err.message) ? err.message : `${err.message}. Vérifiez l’adresse, le port, l’utilisateur et le mot de passe, et que la caméra est allumée sur le même réseau.`);
      }
    });
  };

  discover.addEventListener('click', async () => {
    found.hidden = true;
    setSourceMsg(d.id, 'busy', 'Recherche des caméras sur le réseau (4 secondes)…');
    try {
      const cameras = await withBusy(discover, () => api('/api/onvif/discover'));
      if (!cameras) return;
      if (!cameras.length) {
        setSourceMsg(d.id, 'info', 'Aucune caméra n’a répondu (pare-feu, ou caméra sur un autre réseau ?). Saisissez son adresse à la main.');
        return;
      }
      setSourceMsg(d.id, 'ok', `${cameras.length} caméra${cameras.length > 1 ? 's trouvées' : ' trouvée'} : touchez celle à utiliser.`);
      found.hidden = false;
      found.replaceChildren(
        ...cameras.map((c) =>
          h(
            'button',
            {
              class: 'btn btn-sm found-item',
              type: 'button',
              onclick: () => {
                host.value = c.host;
                port.value = c.port;
                found.hidden = true;
                found.replaceChildren();
                setSourceMsg(d.id, 'info', `Adresse ${c.host} reprise : complétez l’utilisateur et le mot de passe, puis « Enregistrer et tester ».`);
                user.focus();
              },
            },
            icon('camera'),
            h('span', { class: 'mono', text: `${c.host}:${c.port}` }),
            c.name || c.hardware ? h('span', { class: 'found-name', text: [c.name, c.hardware].filter(Boolean).join(' · ') }) : null,
          ),
        ),
      );
    } catch (err) {
      setSourceMsg(d.id, 'error', err.message);
    }
  });
  saveBtn.addEventListener('click', () => save(saveBtn, false));

  const form = h(
    'form',
    { class: 'source-fields', novalidate: true },
    field('Type de source', kind, kindHint),
    discoverRow,
    found,
    h('div', { class: 'eq-grid' }, hostField, portField, pathField, userField, passField),
    aspectField,
    h('div', { class: 'actions' }, testBtn, saveBtn, msg),
  );
  // Une erreur disparaît dès que le champ est corrigé (le prochain envoi revérifie tout).
  form.addEventListener('input', (e) => e.target.getAttribute?.('aria-invalid') && setFieldError(e.target));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (kind.value === 'simulated') save(saveBtn, false);
    else save(testBtn, true);
  });
  kind.addEventListener('change', () => {
    sync();
    clearFieldErrors(form);
  });
  sync();
  return form;
}

// ---------------------------------------------------------------- inventaire

let inventoryKey = '';
const fold = (text) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** Texte où cherche l'inventaire : identifiant, nom, zone, étage, type et état en mots (« hors ligne », « caméra »…). */
function haystack(d) {
  const state = d.kind === 'detector' ? `${STATUS_LABEL[d.status] ?? ''} ${d.status === 'fault' || d.status === 'offline' ? 'hors service' : ''}` : (STREAM_LABEL[d.streamKind] ?? '');
  return fold([d.id, d.name, d.zone, floorName(d.floorId), d.kind === 'detector' ? 'détecteur' : 'caméra', typeLabel(d), state].join(' '));
}

/** Tableau de tous les équipements ; un clic sélectionne l'équipement et affiche son étage. */
function renderInventory() {
  const all = [...S.devices.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'detector' ? -1 : 1) || byId(a, b));
  const query = $('inventory-search').value.trim();
  const words = fold(query).split(/\s+/).filter(Boolean);
  const devices = words.length ? all.filter((d) => words.every((w) => haystack(d).includes(w))) : all;
  const many = S.floors.length > 1;
  const key = JSON.stringify([all.map((d) => [d.id, d.kind, d.category, d.name, d.zone, d.floorId, d.status, d.streamKind]), S.editId, S.floors.map((f) => [f.id, f.name]), query]);
  if (key === inventoryKey) return;
  inventoryKey = key;

  const detectors = all.filter((d) => d.kind === 'detector').length;
  $('inventory-count').textContent = !all.length
    ? ''
    : words.length
      ? `${devices.length} sur ${all.length}`
      : `${detectors} détecteur${detectors > 1 ? 's' : ''}, ${all.length - detectors} caméra${all.length - detectors > 1 ? 's' : ''}`;
  $('inventory-search-row').hidden = all.length === 0;
  $('inventory-table').hidden = devices.length === 0;
  const empty = $('inventory-empty');
  empty.hidden = devices.length > 0;
  if (!all.length) {
    empty.replaceChildren(icon('list'), h('strong', { text: 'Aucun équipement pour l’instant' }), h('span', { text: 'Ajoutez le premier avec « Ajouter un équipement » : il apparaît au centre du plan, glissez-le ensuite à sa place.' }));
  } else if (!devices.length) {
    const clear = h('button', { class: 'btn btn-sm', type: 'button', text: 'Effacer la recherche', onclick: () => clearSearch() });
    empty.replaceChildren(icon('search'), h('strong', { text: `Aucun équipement ne correspond à « ${query} »` }), h('span', { text: 'Cherchez un identifiant (D-05), un nom, une zone, ou un état comme « hors ligne ».' }), clear);
  }

  $('inventory-floor-col').hidden = !many;
  const focused = document.activeElement?.closest?.('#inventory-rows tr')?.dataset.id;
  $('inventory-rows').replaceChildren(
    ...devices.map((d) => {
      const selected = S.editId === d.id;
      const open = h('button', { class: 'inv-open', type: 'button', 'aria-pressed': String(selected), 'aria-label': `Modifier ${d.id}, ${d.name}` }, selected ? icon('pencil', 'icon-sm') : null, d.id);
      open.addEventListener('click', () => openFromInventory(d.id, true));
      const row = h(
        'tr',
        { class: selected ? 'is-selected' : '', dataset: { id: d.id } },
        h('td', { class: 'c-type' }, h('span', { class: 'inv-type' }, glyph(d, { small: true }), typeLabel(d))),
        h('td', { class: 'c-id' }, open),
        h('td', { class: 'c-name', text: d.name }),
        h('td', { class: 'c-zone', 'data-label': 'Zone' }, d.zone ? d.zone : h('span', { class: 'faint', text: 'sans zone' })),
        many ? h('td', { class: 'c-floor', 'data-label': 'Étage', text: floorName(d.floorId) || '—' }) : null,
        h('td', { class: 'c-state' }, d.kind === 'detector' ? statePill(d.status) : streamTag(d)),
      );
      // Toute la ligne se touche (doigt, souris) ; le bouton de l'identifiant porte le clavier et le lecteur d'écran.
      row.addEventListener('click', (e) => !e.target.closest('button') && openFromInventory(d.id, false));
      return row;
    }),
  );
  if (focused) $('inventory-rows').querySelector(`tr[data-id="${CSS.escape(focused)}"] button`)?.focus({ preventScroll: true });
}

async function openFromInventory(id, focus) {
  const d = S.devices.get(id);
  if (!d) return;
  if (S.editId !== id) {
    if (!(await confirmLeave(id))) return;
    S.editId = id;
    showFloor(d.floorId); // affiche son étage, met sa pastille en avant, et ouvre l'éditeur (render.admin)
  }
  revealEditor(focus);
}

function clearSearch() {
  $('inventory-search').value = '';
  renderInventory();
  $('inventory-search').focus();
}

$('inventory-search').addEventListener('input', () => renderInventory());
$('inventory-search').addEventListener('keydown', (e) => e.key === 'Escape' && $('inventory-search').value && (e.preventDefault(), clearSearch()));

// ---------------------------------------------------------------- simulateur

/**
 * Tableau du simulateur. Mis à jour ligne par ligne : une ligne n'est refaite que si son détecteur a changé, le bouton
 * touché retrouve le focus, et une mesure en cours de saisie n'est jamais effacée.
 */
function renderSim() {
  const body = $('sim-list');
  const detectors = devicesOf('detector').sort(byId);
  $('sim-empty').hidden = detectors.length > 0;
  $('sim-table').hidden = detectors.length === 0;
  const many = S.floors.length > 1;
  const existing = new Map([...body.children].map((tr) => [tr.dataset.id, tr]));
  const rows = detectors.map((d) => {
    const key = JSON.stringify([d.name, d.zone, d.category, d.status, d.lastValue, d.valueUnit, d.alarmAt, d.warnAt, many ? floorName(d.floorId) : '']);
    const old = existing.get(d.id);
    if (old?.dataset.key === key) return old;
    const typing = old?.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
    if (old && typing) {
      old.querySelector('.c-state')?.replaceChildren(...simState(d)); // l'état suit, la saisie reste
      return old;
    }
    const row = simRow(d, key);
    const action = old?.contains(document.activeElement) ? document.activeElement.dataset.action : null;
    if (action) queueMicrotask(() => row.querySelector(`[data-action="${CSS.escape(action)}"]`)?.focus({ preventScroll: true }));
    return row;
  });
  // Même liste, même ordre : on remplace seulement les lignes changées (déplacer une ligne lui ferait perdre le focus).
  const sameOrder = rows.length === body.children.length && rows.every((tr, i) => body.children[i].dataset.id === tr.dataset.id);
  if (sameOrder) rows.forEach((tr, i) => body.children[i] !== tr && body.children[i].replaceWith(tr));
  else body.replaceChildren(...rows);
}

function simState(d) {
  return [statePill(d.status), d.lastValue !== null ? h('span', { class: 'sim-reading', text: `Mesure : ${formatValue(d.lastValue, d.valueUnit)}` }) : null].filter(Boolean);
}

function simRow(d, key) {
  const where = [d.zone || 'sans zone', S.floors.length > 1 ? floorName(d.floorId) : ''].filter(Boolean).join(' · ');
  return h(
    'tr',
    { dataset: { id: d.id, key } },
    h('th', { class: 'c-dev', scope: 'row' }, h('span', { class: 'sim-dev' }, glyph(d, { small: true }), h('span', {}, h('strong', { text: d.id }), h('span', { class: 'sim-dev-name', text: d.name })))),
    h('td', { class: 'c-zone', 'data-label': 'Zone', text: where }),
    h('td', { class: 'c-state' }, ...simState(d)),
    h('td', { class: 'c-send' }, simControls(d)),
  );
}

// ---------------------------------------------------------------- plan d'un étage

function renderPlanUpload(floor) {
  const many = S.floors.length > 1 && floor;
  $('plan-upload-title').textContent = many ? `Plan de « ${floor.name} »` : 'Plan du site';
  $('plan-file-text').textContent = floor?.hasPlan ? (many ? `Remplacer le plan de « ${floor.name} »` : 'Remplacer le plan') : 'Choisir le plan';
  $('plan-state').textContent = floor?.hasPlan
    ? 'Un plan est en place. Un nouveau le remplace ; les équipements gardent leur place, en proportion du dessin.'
    : 'Pas encore de plan : les équipements s’affichent sur un quadrillage. Choisissez l’image du plan.';
}

const PLAN_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const MAX_PLAN_BYTES = 10 * 1024 * 1024;

// Étage visé, figé au moment où l'administrateur ouvre le choix du fichier (une alarme peut changer l'étage affiché entre-temps).
let planTarget = null;
$('plan-file').addEventListener('click', () => (planTarget = Number($('plan-file').dataset.floor) || null));
$('plan-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const status = $('plan-status');
  const label = $('plan-file').closest('label');
  const floor = S.floors.find((f) => f.id === planTarget);
  const many = S.floors.length > 1;
  if (!floor) return setStatus(status, 'error', "L’étage visé n’existe plus : choisissez de nouveau le fichier.");
  if (!PLAN_TYPES.includes(file.type)) return setStatus(status, 'error', `« ${file.name} » n’est pas une image PNG, JPEG, WEBP ou SVG : exportez le plan dans l’un de ces formats.`);
  if (file.size > MAX_PLAN_BYTES) {
    return setStatus(status, 'error', `« ${file.name} » fait ${(file.size / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo : 10 Mo au plus. Réduisez l’image ou exportez-la en SVG.`);
  }
  setStatus(status, 'busy', `Envoi du plan${many ? ` de « ${floor.name} »` : ''}…`);
  label.classList.add('is-busy');
  label.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch(`/api/floors/${floor.id}/plan`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': file.type }, body: file });
    const data = await res.json().catch(() => null);
    if (res.status === 401) emit('unauthorized');
    if (!res.ok) throw new Error(data?.error ?? `Erreur ${res.status}`);
    setStatus(status, 'ok', many ? `Plan de « ${floor.name} » remplacé.` : 'Plan remplacé.');
    emit('snapshot', await api('/api/state'));
  } catch (err) {
    setStatus(status, 'error', `Plan non remplacé : ${err.message}`);
  } finally {
    label.classList.remove('is-busy');
    label.removeAttribute('aria-busy');
  }
});

// ---------------------------------------------------------------- ajout d'un équipement

const PREFIX = { camera: 'C', fire: 'D', intrusion: 'I', access: 'A', environment: 'E' };

/** Premier identifiant libre de la série du type choisi (D-08, C-06…) : proposé en exemple, jamais imposé. */
function nextFreeId() {
  const prefix = PREFIX[$('add-kind').value === 'camera' ? 'camera' : $('add-category').value] ?? 'D';
  const pattern = new RegExp(`^${prefix}-(\\d+)$`, 'i');
  const max = Math.max(0, ...[...S.devices.keys()].map((id) => Number(pattern.exec(id)?.[1] ?? 0)));
  return `${prefix}-${String(max + 1).padStart(2, '0')}`;
}

function updateIdPlaceholder() {
  $('add-id').placeholder = `ex. ${nextFreeId()}`;
}

for (const c of CATEGORIES) $('add-category').append(h('option', { value: c, text: CATEGORY_LABEL[c] }));
$('add-kind').addEventListener('change', () => {
  $('add-category-field').hidden = $('add-kind').value !== 'detector';
  updateIdPlaceholder();
});
$('add-category').addEventListener('change', () => {
  $('add-category-hint').textContent = CATEGORY_HINT[$('add-category').value] ?? '';
  updateIdPlaceholder();
});
$('add-category-hint').textContent = CATEGORY_HINT[$('add-category').value] ?? '';
for (const id of ['add-id', 'add-name']) $(id).addEventListener('input', () => setFieldError($(id)));

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('add-submit').classList.contains('is-busy')) return; // Entrée pendant l'envoi : un seul ajout
  const form = $('add-form');
  const status = $('add-status');
  clearFieldErrors(form);
  setStatus(status, '');
  const id = $('add-id').value.trim();
  const name = $('add-name').value.trim();
  const problems = [];
  if (!id) problems.push([$('add-id'), `Donnez un identifiant court (ex. ${nextFreeId()}).`]);
  else if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) problems.push([$('add-id'), 'Lettres sans accent, chiffres, - et _ seulement (32 au plus), sans espace.']);
  else if (S.devices.has(id)) problems.push([$('add-id'), `${id} existe déjà : choisissez un autre identifiant (ex. ${nextFreeId()}).`]);
  if (!name) problems.push([$('add-name'), 'Donnez un nom à l’équipement (ex. Couloir nord).']);
  if (problems.length) {
    for (const [el, message] of problems) setFieldError(el, message);
    return problems[0][0].focus();
  }
  setStatus(status, 'busy', 'Ajout…');
  try {
    const created = await withBusy($('add-submit'), () =>
      api('/api/devices', {
        method: 'POST',
        body: {
          kind: $('add-kind').value,
          id,
          name,
          zone: $('add-zone').value.trim(),
          ...($('add-submit').dataset.floor ? { floorId: Number($('add-submit').dataset.floor) } : {}),
          ...($('add-kind').value === 'detector' ? { category: $('add-category').value } : {}),
        },
      }),
    );
    if (!created) return;
    // Le type, la catégorie et la zone restent : on ajoute souvent plusieurs équipements de suite dans la même zone.
    $('add-id').value = '';
    $('add-name').value = '';
    const where = S.floors.length > 1 ? ` de « ${floorName(created.floorId)} »` : '';
    setStatus(status, 'ok', `${created.id} ajouté au centre du plan${where} : glissez sa pastille à sa place.`);
    // Ouvert tout de suite dans l'éditeur (l'état complet suit par le temps réel).
    if (await confirmLeave(created.id)) {
      S.devices.set(created.id, created);
      S.editId = created.id;
      revealOnOpen = false;
      try {
        if (S.editMode && created.floorId !== S.floorId) showFloor(created.floorId);
        else {
          render.plan();
          renderAdmin();
        }
      } finally {
        revealOnOpen = true;
      }
    }
    updateIdPlaceholder();
    $('add-id').focus({ preventScroll: true });
  } catch (err) {
    const target = /identifiant/i.test(err.message) ? $('add-id') : /zone/i.test(err.message) ? $('add-zone') : null;
    if (target) setFieldError(target, err.message);
    setStatus(status, 'error', `Équipement non ajouté : ${err.message}`);
  }
});

render.admin = renderAdmin;
