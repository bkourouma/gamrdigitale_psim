import { startSimCamera } from './camera.js';
import { startLiveCamera } from './live.js';
import { createAccountUi, createDialogs } from './account.js';
import { createRiskView } from './risk.js';
import { CATEGORIES, CATEGORY_GLYPH, CATEGORY_LABEL, buildSensorForm, createSimControls, formatValue, qualificationLabel, realEventLabel } from './sources.js';
import { createArmingView } from './arming.js';
import { createReportsView } from './reports.js';
import { createUsersAdmin } from './users.js';

// ---------------------------------------------------------------- outils

const $ = (id) => document.getElementById(id);

/** Cree un element DOM. Tout le texte passe par textContent : jamais d'HTML injecte. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child) el.append(child);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const time = (ts) => new Date(ts).toLocaleTimeString('fr-FR');
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function elapsed(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)} h ${mm} min` : `${mm}:${ss}`;
}

function toast(message, kind = 'error') {
  const el = h('div', { class: `toast ${kind}`, role: 'status', text: message });
  $('toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}

const STATUS_LABEL = { normal: 'Normal', prealarm: 'Préalarme', alarm: 'ALARME', fault: 'Défaut', offline: 'Hors ligne' };
const ACTION_LABEL = {
  device_state: 'Changement d\'état',
  incident_opened: 'Incident ouvert',
  incident_escalated: 'Incident aggravé',
  incident_confirmed: 'Incident confirmé',
  incident_hint: 'Indice : fausse alarme probable',
  incident_acked: 'Incident acquitté',
  incident_closed: 'Incident clôturé',
  login: 'Connexion',
  plan_updated: 'Plan remplacé',
  device_created: 'Équipement ajouté',
  device_updated: 'Équipement modifié',
  device_deleted: 'Équipement supprimé',
  links_updated: 'Caméras associées modifiées',
  sim_trigger: 'Simulation',
  detector_silent: 'Détecteur muet',
  supervision_gap: 'Période sans surveillance',
  journal_integrity_failed: 'JOURNAL ALTÉRÉ',
  journal_integrity_recovered: 'Journal de nouveau cohérent',
  journal_verified: 'Journal vérifié',
  heartbeat_failing: 'Supervision externe en échec',
  heartbeat_recovered: 'Supervision externe rétablie',
  zone_armed: 'Zone armée',
  report_exported: 'Export / rapport',
  zone_disarmed: 'Zone désarmée',
  arming_schedule: "Planning d'armement",
  intrusion_ignored: 'Intrusion ignorée (zone désarmée)',
  risk_assessed: 'Risque évalué',
  snapshot_failed: 'Image non prise',
  notification_failed: 'Notification en échec',
  notification_escalated: 'Escalade (niveau 2 prévenu)',
  notification_reminder: 'Rappel envoyé',
  notification_test: 'Test de notification',
  login_failed: 'Connexion refusée',
  user_created: 'Compte créé',
  user_updated: 'Compte modifié',
  user_deleted: 'Compte supprimé',
  password_changed: 'Mot de passe changé',
  password_reset: 'Mot de passe réinitialisé',
  totp_enabled: '2FA activée',
  totp_disabled: '2FA désactivée',
  totp_reset: '2FA réinitialisée',
  recovery_regenerated: 'Codes de secours régénérés',
  recovery_code_used: 'Code de secours utilisé',
  recipient_added: 'Destinataire ajouté',
  recipient_updated: 'Destinataire modifié',
  recipient_removed: 'Destinataire retiré',
  backup_failed: 'Sauvegarde en échec',
  backup_manual: 'Sauvegarde manuelle',
  camera_source_updated: 'Source vidéo modifiée',
};

async function api(path, { method = 'GET', body } = {}) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 401 && path !== '/api/login' && path !== '/api/login/2fa') {
    showLogin();
    throw new Error('Session expirée, reconnectez-vous');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 403 && data?.restricted && S.me && !S.me.restricted) {
    S.me.restricted = data.restricted;
    account.openAccount(); // une etape est requise sur le compte (mot de passe, 2FA)
  }
  if (!res.ok) {
    const error = new Error(data?.error ?? `Erreur ${res.status}`);
    error.data = data; // le detail (ex. defi expire) reste disponible pour l'appelant
    throw error;
  }
  return data;
}

// ---------------------------------------------------------------- vues (supervision / risques)

let riskView = null;

function showView(name) {
  const risk = name === 'risk';
  riskView ??= createRiskView({ api, h, toast, getMe: () => S.me });
  document.querySelector('.layout').hidden = risk;
  $('nav-risk').setAttribute('aria-pressed', String(risk));
  $('nav-risk').textContent = risk ? 'Supervision' : 'Risques';
  if (risk) riskView.show();
  else riskView.hide();
}

$('nav-risk').addEventListener('click', () => showView(riskView?.isOpen() ? 'supervision' : 'risk'));

// ---------------------------------------------------------------- état

const S = {
  arming: {},
  me: null,
  site: { name: '', hasPlan: false, planVersion: 0 },
  devices: new Map(),
  links: {},
  incidents: new Map(),
  audit: [],
  selectedId: null,
  focusIncidentId: null,
  manualCams: [],
  editMode: false,
  dragging: false,
  muted: false,
  ws: null,
  wsDelay: 1000,
};

const devicesOf = (kind) => [...S.devices.values()].filter((d) => d.kind === kind);
const isActive = (i) => i.status !== 'closed';
const isFiring = (d) => d && (d.status === 'alarm' || d.status === 'prealarm');

function activeIncidents() {
  return [...S.incidents.values()]
    .filter(isActive)
    .sort(
      (a, b) =>
        (b.severity === 'critical') - (a.severity === 'critical') ||
        (b.confirmedAt !== null) - (a.confirmedAt !== null) ||
        b.openedAt - a.openedAt,
    );
}

function focusedIncident() {
  const chosen = S.incidents.get(S.focusIncidentId);
  return chosen && isActive(chosen) ? chosen : (activeIncidents()[0] ?? null);
}

function applySnapshot(snap) {
  S.site = snap.site;
  S.devices = new Map(snap.devices.map((d) => [d.id, d]));
  S.links = snap.links;
  S.arming = snap.arming ?? {};
  armingView.load(); // etat detaille des zones d'intrusion (planning, derogations)
  S.incidents = new Map(snap.incidents.map((i) => [i.id, i]));
  S.audit = snap.audit;
  if (S.selectedId && !S.devices.has(S.selectedId)) S.selectedId = null;
  S.manualCams = S.manualCams.filter((id) => S.devices.has(id));
  renderAll(true);
}

function onIncident(incident) {
  const previous = S.incidents.get(incident.id);
  // Securite : une nouvelle alarme ramene l'operateur sur l'ecran de supervision, jamais cachee derriere une autre vue.
  if (incident.status === 'open' && !previous) showView('supervision');
  S.incidents.set(incident.id, incident);
  // Nouvelle alarme (ou aggravation) : l'operateur voit tout de suite les cameras concernees.
  if (incident.status === 'open' && (!previous || previous.status !== 'open' || previous.severity !== incident.severity)) {
    S.focusIncidentId = incident.id;
    S.manualCams = [];
  }
  renderPlan();
  renderWall();
  renderIncidents();
  updateAlarmState();
}

function onMessage(msg) {
  switch (msg.type) {
    case 'snapshot':
      applySnapshot(msg);
      break;
    case 'config':
      api('/api/state').then(applySnapshot).catch((e) => toast(e.message));
      break;
    case 'device':
      S.devices.set(msg.device.id, msg.device);
      renderPlan();
      renderWall();
      renderIncidents();
      renderAdmin();
      updateAlarmState();
      break;
    case 'incident':
      onIncident(msg.incident);
      break;
    case 'audit':
      S.audit.unshift(msg.entry);
      S.audit.length = Math.min(S.audit.length, 100);
      renderJournal();
      break;
  }
}

// ---------------------------------------------------------------- connexion

function connect() {
  clearTimeout(connect.timer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => {
    S.wsDelay = 1000;
    setConn(true);
  };
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data));
    } catch (err) {
      console.error(err);
    }
  };
  ws.onclose = async () => {
    setConn(false);
    if (!S.me) return;
    try {
      await api('/api/me');
    } catch {
      return; // session perdue : l'ecran de connexion est deja affiche
    }
    connect.timer = setTimeout(connect, S.wsDelay);
    S.wsDelay = Math.min(S.wsDelay * 2, 10000);
  };
}

function setConn(online) {
  const el = $('conn');
  el.className = `conn ${online ? 'online' : 'offline'}`;
  el.querySelector('span').textContent = online ? 'Temps réel connecté' : 'Connexion perdue…';
}

// ---------------------------------------------------------------- connexion utilisateur

async function loadDemoAccounts() {
  try {
    const res = await fetch('/api/demo-accounts', { credentials: 'same-origin' });
    if (!res.ok) return; // mode demo desactive : la page reste inchangee
    const accounts = await res.json();
    $('demo-buttons').replaceChildren(
      ...accounts.map((a) =>
        h('button', {
          class: 'btn small',
          type: 'button',
          text: `${a.label} (${a.username})`,
          onclick: () => {
            $('login-user').value = a.username;
            $('login-pass').value = a.password;
            $('login-error').textContent = '';
            $('login-form').querySelector('button[type="submit"]').focus();
          },
        }),
      ),
    );
    $('demo-accounts').hidden = accounts.length === 0;
  } catch {
    // indisponible : on ignore
  }
}

function showLogin() {
  S.me = null;
  S.ws?.close();
  stopTiles();
  dialogs.close();
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-pass').value = '';
  resetLoginStep();
  loadDemoAccounts();
}

// ---------------------------------------------------------------- comptes (mot de passe, 2FA, utilisateurs)

const dialogs = createDialogs({ h });
const logout = async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
};
const refreshMe = async () => {
  S.me = await api('/api/me');
};
const reportsView = createReportsView({ h, getMe: () => S.me });
const armingView = createArmingView({ api, h, toast, getMe: () => S.me });
const account = createAccountUi({ api, h, toast, dialogs, getMe: () => S.me, refreshMe, logout });
const admin = createUsersAdmin({ api, h, toast, dialogs, getMe: () => S.me, onRecipientsChanged: () => loadNotifStatus() });
$('whoami').addEventListener('click', () => account.openAccount());
$('users-box').addEventListener('toggle', () => $('users-box').open && admin.loadUsers());

// ---------------------------------------------------------------- connexion en deux etapes

let challenge = null;

function resetLoginStep() {
  challenge = null;
  $('login-2fa').hidden = true;
  $('login-back').hidden = true;
  $('login-code').value = '';
  for (const id of ['login-user', 'login-pass']) $(id).closest('label').hidden = false;
  $('login-submit').textContent = 'Se connecter';
  $('demo-accounts').style.display = '';
}

function showCodeStep(token) {
  challenge = token;
  for (const id of ['login-user', 'login-pass']) $(id).closest('label').hidden = true;
  $('demo-accounts').style.display = 'none';
  $('login-2fa').hidden = false;
  $('login-back').hidden = false;
  $('login-submit').textContent = 'Valider le code';
  $('login-code').focus();
}
$('login-back').addEventListener('click', () => {
  resetLoginStep();
  $('login-error').textContent = '';
});

function showApp() {
  $('login').hidden = true;
  if (S.me.restricted) {
    // Une etape est requise (mot de passe a changer, 2FA a activer) : rien d'autre n'est accessible avant.
    $('app').hidden = true;
    account.openAccount();
    return;
  }
  $('app').hidden = false;
  loadSystem(false);
  reportsView.draw();
  $('whoami').textContent = `${S.me.displayName || S.me.username} (${S.me.role === 'admin' ? 'administrateur' : 'opérateur'})`;
  $('admin').hidden = S.me.role !== 'admin';
  $('sim-box').hidden = !S.me.simEnabled;
  connect();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  ensureAudio();
  try {
    const reply = challenge
      ? await api('/api/login/2fa', { method: 'POST', body: { challenge, code: $('login-code').value } })
      : await api('/api/login', { method: 'POST', body: { username: $('login-user').value, password: $('login-pass').value } });
    if (reply.twoFactor) return showCodeStep(reply.challenge); // mot de passe correct : il faut encore le code
    resetLoginStep();
    S.me = await api('/api/me');
    showApp();
  } catch (err) {
    $('login-error').textContent = err.message;
    if (challenge && err.data?.expired) resetLoginStep(); // defi expire ou epuise : repartir du mot de passe ; sinon on peut reessayer
    else if (challenge) $('login-code').select();
  }
});

$('logout').addEventListener('click', logout);

// ---------------------------------------------------------------- plan

function pinClass(d) {
  return `pin ${d.kind} ${d.kind === 'detector' ? `${d.status} cat-${d.category}${d.category === 'intrusion' && S.arming[d.zone] === false ? ' disarmed' : ''}` : ''}${S.selectedId === d.id ? ' selected' : ''}${
    S.editMode ? ' editable' : ''
  }${wallCameraIds().includes(d.id) ? ' on-wall' : ''}`;
}

function renderPlan() {
  if (S.dragging) return;
  const img = $('plan-img');
  $('plan-empty').hidden = S.site.hasPlan;
  $('plan-stage').hidden = !S.site.hasPlan;
  $('site-name').textContent = S.site.name;
  const src = `/api/plan?v=${S.site.planVersion}`;
  if (S.site.hasPlan && !img.src.endsWith(src)) img.src = src;

  const pins = $('plan-pins');
  pins.replaceChildren(
    ...[...S.devices.values()].map((d) => {
      const pin = h(
        'button',
        {
          type: 'button',
          class: pinClass(d),
          title: `${d.name} - ${d.zone || 'sans zone'}${d.category === 'intrusion' && S.arming[d.zone] === false ? ' - zone DÉSARMÉE' : ''}${
            d.kind === 'detector'
              ? ` - ${CATEGORY_LABEL[d.category]}${d.lastValue !== null ? ` - ${formatValue(d.lastValue, d.valueUnit)}` : ''} - ${STATUS_LABEL[d.status] ?? d.status} - dernier message : ${d.lastSeen ? time(d.lastSeen) : 'aucun depuis le démarrage'}`
              : ''
          }`,
          dataset: { id: d.id },
        },
        h('span', { class: 'pin-glyph', text: d.kind === 'detector' ? CATEGORY_GLYPH[d.category] : 'C' }),
        h('span', { class: 'pin-label', text: d.id }),
      );
      pin.style.left = `${d.x}%`;
      pin.style.top = `${d.y}%`;
      pin.addEventListener('pointerdown', (ev) => onPinDown(ev, d.id, pin));
      return pin;
    }),
  );

  // Traits detecteur -> cameras associees (detecteur selectionne ou en incident).
  const svg = $('plan-links');
  svg.replaceChildren();
  const shown = new Set(activeIncidents().map((i) => i.detectorId));
  if (S.selectedId) shown.add(S.selectedId);
  for (const detectorId of shown) {
    const det = S.devices.get(detectorId);
    if (det?.kind !== 'detector') continue;
    for (const camId of S.links[detectorId] ?? []) {
      const cam = S.devices.get(camId);
      if (!cam) continue;
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
  const stage = $('plan-stage');
  const startX = ev.clientX;
  const startY = ev.clientY;
  let moved = false;
  pin.setPointerCapture(ev.pointerId);

  const move = (e) => {
    if (!S.editMode) return;
    if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
    moved = true;
    S.dragging = true;
    const rect = stage.getBoundingClientRect();
    pin.style.left = `${clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100)}%`;
    pin.style.top = `${clamp(((e.clientY - rect.top) / rect.height) * 100, 0, 100)}%`;
  };
  const up = async () => {
    pin.removeEventListener('pointermove', move);
    pin.removeEventListener('pointerup', up);
    pin.removeEventListener('pointercancel', up);
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
  pin.addEventListener('pointermove', move);
  pin.addEventListener('pointerup', up);
  pin.addEventListener('pointercancel', up);
}

function onPinClick(id) {
  const d = S.devices.get(id);
  if (!d) return;
  S.selectedId = S.selectedId === id && !S.editMode ? null : id;
  if (d.kind === 'camera') {
    // Ajoute la camera au mur video (4 max, la plus ancienne sort).
    S.manualCams = S.manualCams.includes(id) ? S.manualCams.filter((c) => c !== id) : [...S.manualCams, id].slice(-4);
  } else {
    const incident = activeIncidents().find((i) => i.detectorId === id);
    if (incident) {
      S.focusIncidentId = incident.id;
      S.manualCams = [];
    }
  }
  renderPlan();
  renderWall();
  renderAdmin();
}

// ---------------------------------------------------------------- mur video

const tiles = new Map(); // idCamera -> { el, stop }

// `fireOnly` : la camera simulee ne dessine fumee et flammes que pour un detecteur d'incendie.
function fireLevelFor(camera, fireOnly = false) {
  let level = 0;
  for (const d of devicesOf('detector')) {
    if (!camera.zone || d.zone !== camera.zone) continue;
    if (fireOnly && d.category !== 'fire') continue;
    if (d.status === 'alarm') return 2;
    if (d.status === 'prealarm') level = 1;
  }
  return level;
}

function wallCameraIds() {
  if (S.manualCams.length) return S.manualCams;
  const incident = focusedIncident();
  const ids = incident ? incident.cameraIds : devicesOf('camera').map((c) => c.id);
  return ids.filter((id) => S.devices.has(id)).slice(0, 4);
}

function makeTile(camera) {
  const canvas = h('canvas', { class: 'tile-canvas' });
  const caption = h('div', { class: 'tile-caption' });
  const status = h('div', { class: 'tile-status', role: 'status' });
  status.hidden = true;
  const el = h('div', { class: 'tile' }, canvas, status, caption);
  const live = camera.streamKind === 'onvif' || camera.streamKind === 'rtsp';
  canvas.setAttribute('aria-label', `${live ? 'Flux vidéo' : 'Flux simulé'} ${camera.name}`);
  const stop = live
    ? startLiveCamera(canvas, {
        cameraId: camera.id,
        onStatus: (message) => {
          status.hidden = !message;
          status.textContent = message ?? '';
        },
      })
    : startSimCamera(canvas, {
        label: camera.id,
        zone: camera.zone,
        getFire: () => fireLevelFor(S.devices.get(camera.id) ?? camera, true),
      });
  return { el, stop, caption, kind: camera.streamKind };
}

function stopTiles() {
  for (const t of tiles.values()) t.stop();
  tiles.clear();
  $('wall').replaceChildren();
}

function renderWall() {
  const wall = $('wall');
  const ids = wallCameraIds();
  const incident = S.manualCams.length ? null : focusedIncident();

  $('wall-mode').textContent = S.manualCams.length
    ? 'Sélection manuelle'
    : incident
      ? `Incident n°${incident.id} - ${incident.detectorName}`
      : 'Vue générale';
  $('wall-auto').hidden = S.manualCams.length === 0;

  for (const [id, tile] of tiles) {
    if (!ids.includes(id)) {
      tile.stop();
      tile.el.remove();
      tiles.delete(id);
    }
  }
  ids.forEach((id, index) => {
    const camera = S.devices.get(id);
    let tile = tiles.get(id);
    if (tile && tile.kind !== camera.streamKind) {
      // La source de la camera a change (simulee <-> reelle) : on reconstruit la vignette.
      tile.stop();
      tile.el.remove();
      tiles.delete(id);
      tile = undefined;
    }
    if (!tile) {
      tile = makeTile(camera);
      tiles.set(id, tile);
    }
    tile.caption.textContent = `${camera.name}${camera.zone ? ` - ${camera.zone}` : ''}`;
    tile.el.classList.toggle('alert', fireLevelFor(camera) > 0);
    if (wall.children[index] !== tile.el) wall.insertBefore(tile.el, wall.children[index] ?? null);
  });
  wall.className = `wall n${Math.max(ids.length, 1)}`;
  if (ids.length === 0) wall.replaceChildren(h('p', { class: 'empty', text: 'Aucune caméra configurée.' }));
}

$('wall-auto').addEventListener('click', () => {
  S.manualCams = [];
  renderPlan();
  renderWall();
});

// ---------------------------------------------------------------- incidents

const cards = new Map(); // idIncident -> { el, refs }

const SHOT_REASON = { opened: "à l'ouverture", escalated: "à l'aggravation", confirmed: 'à la confirmation' };

function shotCaption(shot) {
  const camera = S.devices.get(shot.cameraId);
  return `${camera?.name ?? shot.cameraId} - ${SHOT_REASON[shot.reason] ?? shot.reason} - ${time(shot.takenAt)}`;
}

/** Miniatures des images prises au moment de l'incident (reconstruites seulement si la liste change). */
function renderShots(container, incident, mini = false) {
  const key = incident.snapshots.map((s) => s.id).join(',');
  if (container.dataset.key === key) return;
  container.dataset.key = key;
  container.classList.toggle('mini', mini);
  container.hidden = incident.snapshots.length === 0;
  container.replaceChildren(
    ...incident.snapshots.map((shot) => {
      const img = h('img', { src: `/api/snapshots/${shot.id}?t=${shot.takenAt}`, alt: shotCaption(shot), draggable: 'false' });
      return h('button', { type: 'button', class: 'shot', title: shotCaption(shot), onclick: () => openLightbox(shot) }, img);
    }),
  );
}

function openLightbox(shot) {
  $('lightbox-img').src = `/api/snapshots/${shot.id}?t=${shot.takenAt}`;
  $('lightbox-caption').textContent = shotCaption(shot);
  $('lightbox').hidden = false;
}
$('lightbox').addEventListener('click', () => ($('lightbox').hidden = true));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('lightbox').hidden = true;
});

function confirmationText(reason) {
  if (reason?.startsWith('neighbor:')) {
    const id = reason.slice('neighbor:'.length);
    const d = S.devices.get(id);
    return `détecteur voisin ${id}${d ? ` (${d.name})` : ''} déclenché`;
  }
  if (reason === 'persistence') return "l'alarme persiste";
  return reason ?? '';
}

function hintText(details) {
  const m = /en (\d+) s/.exec(details ?? '');
  return m ? `revenu à la normale en ${m[1]} s, sans détecteur voisin.` : (details ?? '');
}

function whereText(incident) {
  return `${incident.zone || 'Zone non renseignée'} - ouvert à ${time(incident.openedAt)} - depuis ${elapsed(incident.openedAt)}`;
}

function buildCard(incident) {
  const refs = {};
  refs.badge = h('span', { class: 'badge' });
  refs.chip = h('span', { class: 'chip' });
  refs.conf = h('p', { class: 'small conf-line' });
  refs.advice = h('p', { class: 'small advice' });
  refs.shots = h('div', { class: 'shots' });
  refs.status = h('p', { class: 'small' });
  refs.ack = h('button', { class: 'btn small', type: 'button', text: 'Acquitter', onclick: () => act(() => api(`/api/incidents/${incident.id}/ack`, { method: 'POST' })) });
  refs.cams = h('button', {
    class: 'btn small',
    type: 'button',
    text: 'Voir les caméras',
    onclick: () => {
      S.focusIncidentId = incident.id;
      S.manualCams = [];
      renderPlan();
      renderWall();
    },
  });
  refs.comment = h('textarea', { rows: '2', maxlength: '500', placeholder: 'Commentaire (facultatif)', 'aria-label': 'Commentaire' });
  const close = (qualification) => () =>
    act(() => api(`/api/incidents/${incident.id}/close`, { method: 'POST', body: { qualification, comment: refs.comment.value } }));
  refs.fire = h('button', { class: 'btn small danger', type: 'button', text: realEventLabel(incident.category), onclick: close('fire') });
  refs.type = h('span', { class: 'chip type' });
  refs.false = h('button', { class: 'btn small', type: 'button', text: 'Fausse alarme', onclick: close('false_alarm') });
  refs.hint = h('p', { class: 'small hint', text: 'Clôture possible quand le détecteur est revenu à la normale.' });

  const el = h(
    'article',
    { class: 'incident' },
    h('header', {}, refs.badge, refs.type, refs.chip, h('strong', { class: 'inc-title' }), h('span', { class: 'muted small inc-num', text: `n°${incident.id}` })),
    h('p', { class: 'small inc-where' }),
    refs.status,
    refs.conf,
    refs.advice,
    refs.shots,
    h('div', { class: 'row wrap' }, refs.cams, refs.ack),
    refs.comment,
    h('div', { class: 'row wrap' }, refs.fire, refs.false),
    refs.hint,
  );
  return { el, refs };
}

function updateCard({ el, refs }, incident) {
  const detector = S.devices.get(incident.detectorId);
  const critical = incident.severity === 'critical';
  const confirmed = incident.confirmedAt !== null;
  el.className = `incident ${critical ? 'critical' : 'warning'} ${incident.status} ${confirmed ? 'confirmed' : 'unconfirmed'}${focusedIncident()?.id === incident.id ? ' focused' : ''}`;
  refs.badge.textContent = critical ? 'ALARME' : 'PRÉALARME';
  refs.type.textContent = CATEGORY_LABEL[incident.category];
  refs.type.hidden = incident.category === 'fire'; // l'incendie reste le cas par défaut : on ne répète pas
  refs.fire.textContent = realEventLabel(incident.category);
  refs.chip.textContent = confirmed ? 'CONFIRMÉE' : 'À CONFIRMER';
  refs.chip.className = `chip ${confirmed ? 'confirmed' : 'unconfirmed'}`;
  // Une alarme « à confirmer » reste une alarme à traiter : on le dit pour qu'elle ne soit jamais prise a la legere.
  refs.conf.textContent = confirmed
    ? `Confirmée : ${confirmationText(incident.confirmationReason)}.`
    : "À confirmer : rien ne la corrobore pour l'instant. Elle reste à traiter.";
  renderShots(refs.shots, incident);
  refs.advice.hidden = !incident.hint;
  refs.advice.textContent = incident.hint ? `Probable fausse alarme : ${hintText(incident.hintDetails)} À vérifier : l'incident reste ouvert.` : '';
  el.querySelector('.inc-title').textContent = incident.detectorName;
  el.querySelector('.inc-where').textContent = whereText(incident) + (incident.lastValue !== null ? ` - mesure : ${formatValue(incident.lastValue, incident.valueUnit)}` : '');
  refs.status.textContent =
    incident.status === 'open'
      ? 'Non acquitté'
      : `Acquitté par ${incident.ackedBy} à ${time(incident.ackedAt)}`;
  refs.status.classList.toggle('unacked', incident.status === 'open');
  refs.ack.hidden = incident.status !== 'open';
  const blocked = isFiring(detector);
  refs.fire.disabled = blocked;
  refs.false.disabled = blocked;
  refs.hint.hidden = !blocked;
}

async function act(fn) {
  try {
    const result = await fn();
    if (result?.id) onIncident(result);
  } catch (err) {
    toast(err.message);
  }
}

function renderIncidents() {
  const list = activeIncidents();
  $('no-incident').hidden = list.length > 0;
  const container = $('incidents');

  for (const [id, card] of cards) {
    if (!list.some((i) => i.id === id)) {
      card.el.remove();
      cards.delete(id);
    }
  }
  list.forEach((incident, index) => {
    let card = cards.get(incident.id);
    if (!card) {
      card = buildCard(incident);
      cards.set(incident.id, card);
    }
    updateCard(card, incident);
    if (container.children[index] !== card.el) container.insertBefore(card.el, container.children[index] ?? null);
  });

  const closed = [...S.incidents.values()].filter((i) => !isActive(i)).sort((a, b) => b.closedAt - a.closedAt).slice(0, 10);
  $('closed-list').replaceChildren(
    ...closed.map((i) =>
      h(
        'li',
        {},
        h('strong', { text: `n°${i.id} ${i.detectorName}` }),
        h('a', { class: 'small', href: `/api/reports/incidents/${i.id}`, target: '_blank', rel: 'noopener', text: 'fiche', title: "Fiche détaillée de l'incident (imprimable)" }),
        h('span', { class: `tag ${i.qualification}`, text: qualificationLabel(i.category, i.qualification) }),
        h('span', { class: 'muted small', text: `clôturé à ${time(i.closedAt)} par ${i.closedBy}${i.comment ? ` - ${i.comment}` : ''}` }),
        i.snapshots.length ? (() => { const box = h('div', { class: 'shots mini' }); renderShots(box, i, true); return box; })() : null,
      ),
    ),
  );
}

// ---------------------------------------------------------------- journal

function describe(entry) {
  const parts = [];
  if (entry.deviceId) parts.push(S.devices.get(entry.deviceId)?.name ?? entry.deviceId);
  if (entry.incidentId) parts.push(`incident n°${entry.incidentId}`);
  if (entry.details) {
    parts.push(
      entry.action === 'detector_silent'
        ? entry.details.replace(/etait : (\w+)/, (_, s) => `était : ${STATUS_LABEL[s] ?? s}`)
        : entry.action === 'incident_confirmed'
          ? `par ${confirmationText(entry.details)}`
          : entry.action === 'incident_hint'
            ? hintText(entry.details)
            : entry.action === 'device_state'
        ? entry.details.replace(/\w+/g, (w) => STATUS_LABEL[w] ?? w)
        : entry.details === 'fire' || entry.details === 'false_alarm' ? qualificationLabel(S.devices.get(entry.deviceId)?.category, entry.details) : entry.details,
    );
  }
  return parts.join(' - ');
}

function renderJournal() {
  $('journal').replaceChildren(
    ...S.audit.slice(0, 60).map((e) =>
      h(
        'li',
        {},
        h('time', { text: time(e.ts) }),
        h('span', { class: 'j-action', text: ACTION_LABEL[e.action] ?? e.action }),
        h('span', { class: 'muted', text: describe(e) }),
        h('span', { class: 'muted small j-actor', text: e.actor }),
      ),
    ),
  );
}

// ---------------------------------------------------------------- alerte sonore et compteur

let audio = null;
function ensureAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
  } catch {
    audio = null;
  }
}

function beep(freq, duration) {
  if (!audio || audio.state !== 'running') return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = freq;
  osc.type = 'square';
  gain.gain.value = 0.05;
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + duration);
}

function updateAlarmState() {
  const unacked = activeIncidents().filter((i) => i.status === 'open');
  const counter = $('alarm-counter');
  counter.hidden = unacked.length === 0;
  counter.textContent = `${unacked.length} à acquitter`;
  document.title = unacked.length ? `(${unacked.length}) ALARME - PSIM` : 'GAMRdigitale PSIM';

  // Detecteurs hors service (muets, hors ligne ou en defaut) : jamais silencieux pour l'operateur,
  // un detecteur qui ne surveille plus laisse sa zone sans protection.
  const down = devicesOf('detector').filter((d) => d.status === 'offline' || d.status === 'fault');
  const badge = $('offline-counter');
  badge.hidden = down.length === 0;
  badge.textContent = `${down.length} détecteur${down.length > 1 ? 's' : ''} hors service`;
  badge.title = down.map((d) => `${d.id} ${d.name} : ${STATUS_LABEL[d.status]}`).join('\n');
}

setInterval(() => {
  if (!S.me) return;
  const unacked = activeIncidents().filter((i) => i.status === 'open');
  if (unacked.length && !S.muted) {
    if (unacked.some((i) => i.severity === 'critical' && i.confirmedAt !== null)) {
      beep(1175, 0.15); // alarme confirmee : double bip aigu
      setTimeout(() => beep(1175, 0.15), 220);
    } else beep(unacked.some((i) => i.severity === 'critical') ? 880 : 520, 0.3);
  }
  for (const [id, card] of cards) {
    const incident = S.incidents.get(id);
    if (incident) card.el.querySelector('.inc-where').textContent = whereText(incident);
  }
}, 1000);

$('mute').addEventListener('click', () => {
  S.muted = !S.muted;
  $('mute').textContent = S.muted ? 'Son coupé' : 'Son activé';
  ensureAudio();
});
document.addEventListener('click', ensureAudio);

// ---------------------------------------------------------------- administration

const simRow = createSimControls({ api, h, toast });

const fmtBytes = (n) => (n == null ? '—' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} Go` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);
const fmtDuration = (s) => (s >= 86400 ? `${Math.floor(s / 86400)} j ${Math.floor((s % 86400) / 3600)} h` : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min`);

/** Etat du PSIM lui-meme (administrateur) : alimente le panneau « Systeme » et le badge d'alerte du haut. */
// Continuité : dernière période sans surveillance, et état du signal de supervision externe.
function journalText(sys) {
  const j = sys.journal;
  if (!j) return 'Journal : pas encore vérifié.';
  const when = new Date(j.at).toLocaleString('fr-FR');
  return j.ok ? `Journal : intégrité vérifiée le ${when} (${j.checked} entrées protégées).` : `JOURNAL ALTÉRÉ (vérifié le ${when}) : voir « Vérifier le journal » et npm run verify-journal.`;
}

function continuityText(sys) {
  const gap = sys.continuity?.lastGap;
  const hb = sys.heartbeat;
  const parts = [];
  parts.push(
    gap
      ? `Dernière période sans surveillance : ${fmtDuration(Math.round(gap.durationMs / 1000))} le ${new Date(gap.from).toLocaleString('fr-FR')} (${gap.clean ? 'arrêt volontaire' : 'arrêt INATTENDU'}).`
      : 'Aucune période sans surveillance enregistrée.',
  );
  parts.push(
    hb?.configured
      ? `Supervision externe : signal toutes les ${hb.everyS} s vers ${hb.host}${hb.consecutiveFailures > 0 ? ` - ${hb.consecutiveFailures} échec(s) (${hb.lastError})` : hb.lastOkAt ? `, dernier succès à ${time(hb.lastOkAt)}` : ''}.`
      : "Supervision externe : non configurée (si le PSIM s'arrête, personne n'est prévenu).",
  );
  return parts.join(' ');
}

async function loadSystem(render = true) {
  if (S.me?.role !== 'admin') return;
  try {
    const sys = await api('/api/system');
    const badge = $('system-counter');
    const critical = sys.warnings.filter((w) => w.level === 'critique').length;
    badge.hidden = critical === 0;
    badge.textContent = `Système : ${critical} alerte${critical > 1 ? 's' : ''}`;
    badge.title = sys.warnings.filter((w) => w.level === 'critique').map((w) => w.message).join('\n');
    if (!render) return;
    const b = sys.backup;
    $('sys-status').className = 'small';
    $('sys-status').textContent =
      `PSIM ${sys.version} (Node ${sys.node}) - en marche depuis ${fmtDuration(sys.uptimeS)} - santé : ${sys.health.ok ? 'bonne' : sys.health.reason}. ` +
      `Base : ${fmtBytes(sys.database.bytes)} - images : ${fmtBytes(sys.snapshotsBytes)} - disque libre : ${fmtBytes(sys.disk?.freeBytes)} - ` +
      `passerelles MQTT connectées : ${sys.brokerClients}. ` +
      `Sauvegardes : ${b.everyH > 0 ? `automatiques toutes les ${b.everyH} h` : 'automatiques désactivées'}, ${b.count} conservée(s)` +
      `${b.at ? `, dernière ${b.ok ? 'réussie' : 'EN ÉCHEC'} le ${new Date(b.at).toLocaleString('fr-FR')}` : ', aucune pour l\'instant'} (${b.dir}). ` +
      continuityText(sys) +
      ` ${journalText(sys)}`;
    $('sys-warnings').replaceChildren(
      ...(sys.warnings.length
        ? sys.warnings.map((w) => h('li', { class: w.level === 'critique' ? 'bad' : 'warn', text: `${w.level === 'critique' ? 'CRITIQUE' : 'Attention'} : ${w.message}` }))
        : [h('li', { class: 'good', text: 'Aucun avertissement.' })]),
    );
  } catch (err) {
    if (render) $('sys-status').textContent = err.message;
  }
}

$('sys-box').addEventListener('toggle', () => {
  if ($('sys-box').open) loadSystem();
});
$('sys-journal').addEventListener('click', async () => {
  $('sys-journal').disabled = true;
  try {
    const r = await api('/api/system/journal/verify', { method: 'POST' });
    toast(r.ok ? `Journal intègre (${r.checked} entrées vérifiées)` : `JOURNAL ALTÉRÉ : ${r.problems.length} problème(s), première entrée n°${r.problems[0].id} (${r.problems[0].reason})`, r.ok ? 'ok' : 'error');
    loadSystem();
  } catch (err) {
    toast(err.message);
  } finally {
    $('sys-journal').disabled = false;
  }
});
$('sys-backup').addEventListener('click', async () => {
  $('sys-backup').disabled = true;
  try {
    const result = await api('/api/system/backup', { method: 'POST' });
    toast(result.ok ? `Sauvegarde ${result.name} réussie` : `Sauvegarde en échec : ${result.error}`, result.ok ? 'ok' : 'error');
    loadSystem();
  } catch (err) {
    toast(err.message);
  } finally {
    $('sys-backup').disabled = false;
  }
});
setInterval(() => {
  if (S.me?.role === 'admin') loadSystem($('sys-box').open);
}, 60000);

const KIND_LABEL = { opened: 'ouverture', escalated: 'aggravation', confirmed: 'confirmation', unacked: 'escalade', reminder: 'rappel', silent: 'détecteur muet', restart: 'redémarrage', test: 'test' };

async function loadNotifStatus() {
  try {
    const st = await api('/api/notifications/status');
    const box = $('notif-status');
    admin.loadRecipients();
    if (st.activeChannels === 0) {
      box.textContent = "Aucun canal configuré : les alarmes ne préviennent personne hors de cet écran. Voir .env.example (PSIM_SMTP_*, PSIM_TELEGRAM_TOKEN, PSIM_NOTIFY_*).";
      box.className = 'small error';
      return;
    }
    box.className = 'small muted';
    box.textContent =
      `${st.channels.map((c) => `${c.label} : ${c.level1} destinataire(s) niveau 1, ${c.level2} niveau 2`).join(' - ')}. ` +
      `Escalade ${st.escalateAfterS > 0 ? `après ${st.escalateAfterS} s sans acquittement, puis rappel toutes les ${st.reminderS} s (${st.maxReminders} max)` : 'désactivée'}. ` +
      `24 h : ${st.sentLast24h} envoyé(s), ${st.failedLast24h} en échec.`;
  } catch (err) {
    $('notif-status').textContent = err.message;
  }
}

$('notif-box').addEventListener('toggle', () => {
  if ($('notif-box').open) loadNotifStatus();
});

$('notif-test').addEventListener('click', async () => {
  const list = $('notif-results');
  list.replaceChildren(h('li', { class: 'muted', text: 'Envoi en cours…' }));
  try {
    const results = await api('/api/notifications/test', { method: 'POST' });
    list.replaceChildren(
      ...(results.length
        ? results.map((r) => h('li', { class: r.ok ? 'good' : 'bad', text: `${r.ok ? 'OK ' : 'ÉCHEC'} ${r.channel} niveau ${r.level} - ${r.recipient}${r.error ? ` : ${r.error}` : ''}` }))
        : [h('li', { class: 'bad', text: 'Aucun destinataire configuré.' })]),
    );
    loadNotifStatus();
  } catch (err) {
    list.replaceChildren(h('li', { class: 'bad', text: err.message }));
  }
});

function renderAdmin(force = false) {
  if (S.me?.role !== 'admin') return;
  if (S.me.simEnabled) {
    $('sim-list').replaceChildren(
      ...devicesOf('detector').map(simRow),
    );
  }
  $('edit-tools').hidden = !S.editMode;
  renderDeviceEditor(force);
}

function renderDeviceEditor(force = false) {
  const box = $('device-editor');
  const d = S.selectedId ? S.devices.get(S.selectedId) : null;
  box.hidden = !d || !S.editMode;
  if (!d || !S.editMode) return;
  // Meme equipement : on ne reconstruit que sur demande, et jamais pendant une saisie.
  if (box.dataset.for === d.id && (!force || box.contains(document.activeElement))) return;

  const name = h('input', { value: d.name, maxlength: '80', 'aria-label': 'Nom' });
  const zone = h('input', { value: d.zone, maxlength: '80', 'aria-label': 'Zone' });
  const children = [
    h('strong', { text: `${d.id} (${d.kind === 'detector' ? `détecteur - ${CATEGORY_LABEL[d.category]}` : 'caméra'})` }),
    h(
      'div',
      { class: 'row wrap' },
      name,
      zone,
      h('button', {
        class: 'btn small',
        type: 'button',
        text: 'Enregistrer',
        onclick: () =>
          api(`/api/devices/${encodeURIComponent(d.id)}`, { method: 'PATCH', body: { name: name.value, zone: zone.value } })
            .then(() => toast('Enregistré', 'ok'))
            .catch((e) => toast(e.message)),
      }),
      h('button', {
        class: 'btn small danger',
        type: 'button',
        text: 'Supprimer',
        onclick: () => {
          if (!confirm(`Supprimer ${d.id} - ${d.name} ?`)) return;
          S.selectedId = null;
          api(`/api/devices/${encodeURIComponent(d.id)}`, { method: 'DELETE' }).catch((e) => toast(e.message));
        },
      }),
    ),
  ];
  if (d.kind === 'camera') children.push(buildSourceForm(d));
  if (d.kind === 'detector') {
    const linked = new Set(S.links[d.id] ?? []);
    children.push(
      buildSensorForm(d, { api, h, toast }),
      h('p', { class: 'small muted', text: 'Caméras affichées quand ce détecteur déclenche :' }),
      h(
        'div',
        { class: 'row wrap' },
        ...devicesOf('camera').map((c) =>
          h(
            'label',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              checked: linked.has(c.id),
              onchange: (e) => {
                e.target.checked ? linked.add(c.id) : linked.delete(c.id);
                api(`/api/devices/${encodeURIComponent(d.id)}/links`, { method: 'PUT', body: { cameraIds: [...linked] } }).catch((err) => toast(err.message));
              },
            }),
            ` ${c.id} ${c.name}`,
          ),
        ),
      ),
    );
  }
  box.dataset.for = d.id;
  box.replaceChildren(...children);
}

// ---- Source video d'une camera (ONVIF / RTSP) ----

S.sourceMsg = {};

function setSourceMsg(cameraId, text, kind = '') {
  S.sourceMsg[cameraId] = { text, kind };
  const el = document.getElementById('source-msg');
  if (el && el.dataset.for === cameraId) {
    el.textContent = text;
    el.className = `small ${kind}`;
  }
}

function buildSourceForm(d) {
  const wrap = h('div', { class: 'source-form' }, h('p', { class: 'small muted', text: 'Chargement de la source vidéo…' }));
  const url = `/api/cameras/${encodeURIComponent(d.id)}`;
  api(`${url}/source`)
    .then((src) => wrap.replaceChildren(...sourceFields(d, src, url)))
    .catch((err) => wrap.replaceChildren(h('p', { class: 'error', text: err.message })));
  return wrap;
}

function sourceFields(d, src, url) {
  const kind = h(
    'select',
    { 'aria-label': 'Type de source vidéo' },
    h('option', { value: 'simulated', text: 'Simulée (démonstration)' }),
    h('option', { value: 'onvif', text: 'Caméra ONVIF' }),
    h('option', { value: 'rtsp', text: 'Flux RTSP direct' }),
  );
  kind.value = src.kind;
  const host = h('input', { value: src.host ?? '', placeholder: 'Adresse IP (ex. 192.168.1.64)', maxlength: '253', 'aria-label': 'Adresse de la caméra' });
  const port = h('input', { value: src.port ?? '', type: 'number', min: '1', max: '65535', 'aria-label': 'Port', class: 'narrow' });
  const path = h('input', { value: src.rtspPath ?? '', placeholder: 'Chemin RTSP (ex. /Streaming/Channels/102)', maxlength: '200', 'aria-label': 'Chemin RTSP' });
  const user = h('input', { value: src.username ?? '', placeholder: 'Utilisateur', maxlength: '64', autocomplete: 'off', 'aria-label': 'Utilisateur de la caméra' });
  const pass = h('input', {
    type: 'password',
    placeholder: src.hasPassword ? 'Mot de passe (vide = inchangé)' : 'Mot de passe',
    maxlength: '128',
    autocomplete: 'new-password',
    'aria-label': 'Mot de passe de la caméra',
  });
  const found = h('div', { class: 'found' });
  const previous = S.sourceMsg[d.id];
  const msg = h('p', { id: 'source-msg', class: `small ${previous?.kind ?? ''}`, role: 'status', dataset: { for: d.id }, text: previous?.text ?? '' });

  const netFields = [host, port, user, pass];
  const sync = () => {
    const k = kind.value;
    for (const el of netFields) el.hidden = k === 'simulated';
    path.hidden = k !== 'rtsp';
    discover.hidden = k !== 'onvif';
    testBtn.hidden = k === 'simulated';
    port.placeholder = k === 'rtsp' ? 'Port (554)' : 'Port (80)';
    found.replaceChildren();
  };

  const save = async (thenTest) => {
    setSourceMsg(d.id, 'Enregistrement…');
    try {
      await api(`${url}/source`, {
        method: 'PUT',
        body: {
          kind: kind.value,
          host: host.value.trim(),
          port: port.value === '' ? undefined : Number(port.value),
          rtspPath: path.value.trim(),
          username: user.value,
          password: pass.value,
        },
      });
      pass.value = '';
      if (thenTest && kind.value !== 'simulated') {
        setSourceMsg(d.id, "Test en cours (jusqu'à 15 secondes)…");
        const result = await api(`${url}/test`, { method: 'POST' });
        setSourceMsg(d.id, `Connexion réussie : ${result.message}`, 'ok');
      } else {
        setSourceMsg(d.id, 'Source enregistrée', 'ok');
      }
    } catch (err) {
      setSourceMsg(d.id, err.message, 'error');
    }
  };

  const discover = h('button', {
    class: 'btn small',
    type: 'button',
    text: 'Rechercher sur le réseau',
    onclick: async () => {
      found.replaceChildren(h('span', { class: 'small muted', text: 'Recherche en cours (4 secondes)…' }));
      try {
        const cameras = await api('/api/onvif/discover');
        found.replaceChildren(
          ...(cameras.length
            ? cameras.map((c) =>
                h('button', {
                  class: 'btn small',
                  type: 'button',
                  text: `${c.host}:${c.port}${c.name ? ` - ${c.name}` : ''}${c.hardware ? ` (${c.hardware})` : ''}`,
                  onclick: () => {
                    host.value = c.host;
                    port.value = c.port;
                    found.replaceChildren();
                  },
                }),
              )
            : [h('span', { class: 'small muted', text: 'Aucune caméra trouvée (pare-feu, ou caméra sur un autre réseau ?). Saisissez son adresse à la main.' })]),
        );
      } catch (err) {
        found.replaceChildren(h('span', { class: 'small error', text: err.message }));
      }
    },
  });
  const testBtn = h('button', { class: 'btn small primary', type: 'button', text: 'Enregistrer et tester', onclick: () => save(true) });
  const saveBtn = h('button', { class: 'btn small', type: 'button', text: 'Enregistrer', onclick: () => save(false) });

  kind.addEventListener('change', sync);
  sync();
  return [
    h('p', { class: 'small muted', text: 'Source vidéo de cette caméra :' }),
    h('div', { class: 'row wrap' }, kind, discover),
    found,
    h('div', { class: 'row wrap' }, host, port),
    path,
    h('div', { class: 'row wrap' }, user, pass),
    h('div', { class: 'row wrap' }, testBtn, saveBtn),
    msg,
  ];
}

$('edit-mode').addEventListener('change', (e) => {
  S.editMode = e.target.checked;
  $('device-editor').dataset.for = '';
  renderPlan();
  renderAdmin();
});

$('plan-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const res = await fetch('/api/plan', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': file.type }, body: file });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? `Erreur ${res.status}`);
    toast('Plan remplacé', 'ok');
    const snap = await api('/api/state');
    applySnapshot(snap);
  } catch (err) {
    toast(err.message);
  }
});

for (const c of CATEGORIES) $('add-category').append(h('option', { value: c, text: CATEGORY_LABEL[c] }));
$('add-kind').addEventListener('change', () => ($('add-category').hidden = $('add-kind').value !== 'detector'));

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const created = await api('/api/devices', {
      method: 'POST',
      body: {
        kind: $('add-kind').value,
        id: $('add-id').value.trim(),
        name: $('add-name').value,
        zone: $('add-zone').value,
        ...($('add-kind').value === 'detector' ? { category: $('add-category').value } : {}),
      },
    });
    S.selectedId = created.id;
    $('add-id').value = '';
    $('add-name').value = '';
    toast(`${created.id} ajouté au centre du plan : glissez-le à sa place`, 'ok');
  } catch (err) {
    toast(err.message);
  }
});

// ---------------------------------------------------------------- rendu global et demarrage

function renderAll(force = false) {
  renderPlan();
  renderWall();
  renderIncidents();
  renderJournal();
  renderAdmin(force);
  updateAlarmState();
}

(async () => {
  try {
    S.me = await api('/api/me');
    showApp();
  } catch {
    showLogin();
  }
})();
