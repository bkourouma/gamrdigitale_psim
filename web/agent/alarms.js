// Application des agents : onglet Alarmes (F5, F6, F8). Principe du produit : une alarme ne se cache jamais.
// Le son et la vibration continuent tant qu'une alarme n'est acquittee par PERSONNE, quel que soit l'onglet affiche,
// et il n'existe volontairement aucun bouton « couper le son » : on acquitte, ou ca sonne.
// Ce fichier ne touche pas au DOM a l'import : les parties pures du haut sont testees par node:test.

import { h, setChildren, fmtAgo, fmtClock } from './util.js';
import { beep, vibrate, audioReady, unlockAudio } from './sound.js';
import { startLiveStream } from './live.js';

const POLL_VISIBLE_MS = 4000;
const POLL_HIDDEN_MS = 30000;
const SIGNAL_EVERY_MS = 2500;
const TICK_MS = 5000;
const VIBRATION = [300, 150, 300];

// ---------------------------------------------------------------------------------------------------------------
// Parties pures

/** Delai avant la prochaine interrogation : 4 s au premier plan, 30 s quand l'onglet est masque. */
export function pollInterval(visible) {
  return visible ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
}

/** Resume pour la coquille (pastille de l'onglet) : total, non acquittees, gravite maximale, premiere non acquittee. */
export function summarize(alarms) {
  const list = Array.isArray(alarms) ? alarms : [];
  const unacked = list.filter((a) => a.acknowledged === false);
  let worst = null;
  for (const a of list) {
    if (a.severity === 'critical') {
      worst = 'critical';
      break;
    }
    if (a.severity === 'warning') worst = 'warning';
  }
  return { total: list.length, unacked: unacked.length, worst, firstUnackedId: unacked.length > 0 ? unacked[0].id : null };
}

/**
 * Age de l'alarme en ms, corrige de l'ecart d'horloge entre le telephone et le serveur :
 * age au moment de la reponse = serverAt - openedAt (deux heures du serveur), puis temps ecoule localement.
 */
export function alarmAgeMs(alarm, serverAt, receivedAt, now) {
  const atResponse = Number(serverAt) - Number(alarm.openedAt);
  const sinceResponse = Number(now) - Number(receivedAt);
  const age = (Number.isFinite(atResponse) ? atResponse : 0) + (Number.isFinite(sinceResponse) ? Math.max(0, sinceResponse) : 0);
  return Math.max(0, age);
}

/** Qui se deplace : « Kouassi y va », « Kouassi est sur place » (un seul etat par agent : le plus recent). */
export function describeDispatch(alarm) {
  const latest = new Map();
  for (const d of alarm?.dispatch ?? []) {
    const previous = latest.get(d.username);
    if (!previous || d.at >= previous.at) latest.set(d.username, d);
  }
  return [...latest.values()]
    .sort((a, b) => a.at - b.at)
    .map((d) => {
      const name = d.displayName || d.username;
      return { username: d.username, status: d.status, name, text: d.status === 'on_site' ? `${name} est sur place` : `${name} y va` };
    });
}

/** Le signal sonore doit-il tourner ? Oui tant qu'une alarme n'est acquittee par personne. */
export function shouldSound(alarms) {
  return Array.isArray(alarms) && alarms.some((a) => a.acknowledged === false);
}

// ---------------------------------------------------------------------------------------------------------------
// Petites aides d'affichage

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** Icones : une FORME par gravite (octogone = critique, triangle = alerte), en plus de la couleur et du mot. */
function icon(kind) {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', class: 'al-icon', 'aria-hidden': 'true', focusable: 'false' });
  if (kind === 'critical') {
    svg.append(svgEl('polygon', { points: '8,2 16,2 22,8 22,16 16,22 8,22 2,16 2,8', class: 'al-icon-shape' }));
    svg.append(svgEl('path', { d: 'M12 7v6M12 16.5v.01', class: 'al-icon-mark' }));
  } else if (kind === 'warning') {
    svg.append(svgEl('polygon', { points: '12,3 22,20 2,20', class: 'al-icon-shape' }));
    svg.append(svgEl('path', { d: 'M12 9.5v5M12 17.5v.01', class: 'al-icon-mark' }));
  } else if (kind === 'bell') {
    svg.append(svgEl('path', { d: 'M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6zM10 19a2 2 0 0 0 4 0', class: 'al-icon-shape' }));
  } else {
    svg.append(svgEl('polyline', { points: '5,13 10,18 19,7', class: 'al-icon-mark' }));
  }
  return svg;
}

const SEVERITY = {
  critical: { word: 'CRITIQUE', pill: 'pill pill-alarm al-sev al-sev-critical', card: 'al-card-critical' },
  warning: { word: 'ALERTE', pill: 'pill pill-warn al-sev al-sev-warning', card: 'al-card-warning' },
};

function severityPill(severity) {
  const s = SEVERITY[severity] ?? SEVERITY.warning;
  return h('span', { class: s.pill }, icon(severity === 'critical' ? 'critical' : 'warning'), h('span', { text: s.word }));
}

function placeOf(alarm) {
  return [alarm.zone, alarm.floorName].filter(Boolean).join(' · ');
}

function ackBlock(alarm) {
  if (alarm.acknowledged === false) {
    return h('span', { class: 'al-ack al-ack-none' }, icon('bell'), h('span', { text: 'Personne n’a acquitté' }));
  }
  const who = alarm.acknowledgedBy ? `Acquittée par ${alarm.acknowledgedBy}` : 'Acquittée';
  return h('span', { class: 'al-ack al-ack-done' }, icon('ok'), h('span', { text: who }));
}

function dispatchPills(alarm) {
  const items = describeDispatch(alarm);
  if (items.length === 0) return null;
  return h(
    'span',
    { class: 'al-dispatch' },
    items.map((d) =>
      h(
        'span',
        { class: d.status === 'on_site' ? 'pill pill-ok al-disp' : 'pill pill-warn al-disp' },
        h('span', { class: 'al-sym', 'aria-hidden': 'true', text: d.status === 'on_site' ? '✔' : '➜' }),
        h('span', { text: d.text }),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Onglet Alarmes

/**
 * @param {{ api: Function, toast: (message: string, kind?: string) => void, onSummary?: (s: object) => void }} ctx
 */
export function createAlarms({ api, toast, onSummary }) {
  let running = false;
  let active = false;
  let alarms = [];
  let serverAt = 0;
  let receivedAt = 0;
  let lastOkAt = 0;
  let failed = false;
  let loaded = false;
  let knownIds = new Set();
  let inflight = null;
  let again = false;
  let pollTimer = null;
  let soundTimer = null;
  let tickTimer = null;
  let lastSig = '';

  // ---- Structure fixe de l'ecran
  const banners = h('div', { class: 'al-banners' });
  const list = h('div', { class: 'al-list' });
  const head = h('div', { class: 'al-head' }, h('h2', { class: 'screen-title', text: 'Alarmes' }));
  const el = h('section', { class: 'screen al-screen', 'aria-label': 'Alarmes' }, head, banners, list);

  // ---- Signal sonore et vibration (F6)
  function signal() {
    beep('alarm');
    vibrate(VIBRATION);
  }

  function syncSound(immediate) {
    if (!running || !shouldSound(alarms)) {
      if (soundTimer) {
        clearInterval(soundTimer);
        soundTimer = null;
      }
      return;
    }
    if (!soundTimer) {
      signal();
      soundTimer = setInterval(signal, SIGNAL_EVERY_MS);
    } else if (immediate) {
      signal();
      clearInterval(soundTimer);
      soundTimer = setInterval(signal, SIGNAL_EVERY_MS);
    }
  }

  // ---- Affichage de la liste
  function ageText(alarm, now) {
    return fmtAgo(now - alarmAgeMs(alarm, serverAt, receivedAt, now), now);
  }

  function card(alarm, now) {
    const s = SEVERITY[alarm.severity] ?? SEVERITY.warning;
    const place = placeOf(alarm);
    return h(
      'button',
      {
        type: 'button',
        class: `card al-card ${s.card}${alarm.acknowledged === false ? ' al-card-unacked' : ''}`,
        onClick: () => openDetail(alarm.id),
      },
      h('span', { class: 'al-card-top' }, severityPill(alarm.severity), h('span', { class: 'al-age', text: ageText(alarm, now) })),
      h('span', { class: 'al-title', text: alarm.title }),
      place ? h('span', { class: 'al-place', text: place }) : null,
      ackBlock(alarm),
      dispatchPills(alarm),
    );
  }

  function render(force = false) {
    const now = Date.now();
    const ready = audioReady();
    const sig = JSON.stringify([
      ready,
      failed,
      loaded,
      lastOkAt ? fmtClock(lastOkAt) : '',
      alarms.map((a) => [a.id, a.severity, a.title, a.zone, a.floorName, a.acknowledged, a.acknowledgedBy, describeDispatch(a).map((d) => d.text), ageText(a, now)]),
    ]);
    if (!force && sig === lastSig) return;
    lastSig = sig;

    const bannerNodes = [];
    if (!ready) {
      bannerNodes.push(
        h('button', { type: 'button', class: 'al-banner al-banner-audio', onClick: onAudioTap }, h('span', { text: 'Touchez ici pour activer le son' })),
      );
    }
    if (failed) {
      const text = lastOkAt ? `Connexion perdue — dernière mise à jour à ${fmtClock(lastOkAt)}` : 'Connexion perdue — aucune alarme reçue pour le moment';
      bannerNodes.push(h('p', { class: 'al-banner al-banner-net', role: 'status', text }));
    }
    setChildren(banners, bannerNodes);

    if (!loaded) {
      setChildren(list, h('p', { class: 'empty al-empty', text: failed ? 'Impossible de lire les alarmes pour le moment. Nouvelle tentative en cours.' : 'Chargement des alarmes…' }));
    } else if (alarms.length === 0) {
      setChildren(
        list,
        h(
          'div',
          { class: 'empty al-empty al-calm' },
          h('p', { class: 'al-calm-title', text: 'Aucune alarme. Tout est calme.' }),
          h('p', { class: 'muted', text: `Dernière mise à jour à ${fmtClock(lastOkAt)}` }),
        ),
      );
    } else {
      setChildren(
        list,
        alarms.map((a) => card(a, now)),
        h('p', { class: 'muted al-updated', text: `Dernière mise à jour à ${fmtClock(lastOkAt)}` }),
      );
    }
  }

  function onAudioTap() {
    unlockAudio();
    setTimeout(() => render(), 300);
  }

  // ---- Interrogation du serveur
  function summary() {
    return summarize(alarms);
  }

  async function fetchOnce() {
    const res = await api('/api/agent/alarms', { timeoutMs: 8000 });
    if (!running) return;
    if (res.status === 401) {
      // Session terminee : la coquille (gestionnaire global) s'en occupe ; on arrete simplement nos minuteurs.
      stop();
      return;
    }
    const data = res.data;
    if (res.ok && data && Array.isArray(data.alarms)) {
      const fresh = data.alarms.filter((a) => !knownIds.has(a.id));
      alarms = data.alarms;
      serverAt = Number(data.serverAt) || Date.now();
      receivedAt = Date.now();
      lastOkAt = receivedAt;
      failed = false;
      const firstLoad = !loaded;
      loaded = true;
      knownIds = new Set(alarms.map((a) => a.id));
      const newlyUnacked = !firstLoad && fresh.some((a) => a.acknowledged === false);
      if (!firstLoad && fresh.length > 0) {
        toast(fresh.length === 1 ? `Nouvelle alarme : ${fresh[0].title}` : `${fresh.length} nouvelles alarmes`, 'alarm');
      }
      syncSound(newlyUnacked);
      updateDetail();
    } else {
      failed = true;
    }
    render();
    try {
      onSummary?.(summary());
    } catch {
      // un defaut de la coquille ne doit jamais arreter la surveillance
    }
  }

  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (!running) return;
    pollTimer = setTimeout(() => void refresh(), pollInterval(document.visibilityState === 'visible'));
  }

  /** Interroge tout de suite. Jamais deux requetes en meme temps : un appel pendant une requete en demande une autre juste apres. */
  function refresh() {
    if (!running) return Promise.resolve();
    clearTimeout(pollTimer);
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      do {
        again = false;
        await fetchOnce();
      } while (again && running);
    })().finally(() => {
      inflight = null;
      schedule();
    });
    return inflight;
  }

  function onVisibility() {
    if (!running) return;
    if (document.visibilityState === 'visible') {
      void refresh();
      render();
    } else if (!inflight) {
      schedule();
    }
  }

  // ---- Detail d'une alarme
  const detail = {
    id: null,
    overlay: null,
    refs: null,
    stopLive: null,
    busy: false,
    liveOn: false,
  };

  function currentAlarm() {
    return alarms.find((a) => a.id === detail.id) ?? null;
  }

  function stopLive() {
    detail.stopLive?.();
    detail.stopLive = null;
  }

  function startLive() {
    const r = detail.refs;
    if (!r || !detail.liveOn || detail.stopLive) return;
    const id = detail.id;
    detail.stopLive = startLiveStream(r.canvas, {
      url: `/api/agent/alarms/${encodeURIComponent(String(id))}/live`,
      onStatus: (message) => {
        r.liveStatus.textContent = message ?? '';
        r.liveStatus.hidden = !message;
      },
    });
  }

  function openDetail(id) {
    const alarm = alarms.find((a) => a.id === id);
    if (!alarm) return;
    closeDetail();
    detail.id = id;
    detail.liveOn = false;
    detail.busy = false;

    const refs = {};
    refs.title = h('h3', { class: 'al-d-title' });
    refs.sev = h('div', { class: 'al-d-sev' });
    refs.place = h('p', { class: 'al-d-place' });
    refs.reason = h('p', { class: 'al-d-reason' });
    refs.device = h('p', { class: 'muted al-d-device' });
    refs.state = h('div', { class: 'al-d-state' });
    refs.error = h('p', { class: 'al-error', role: 'alert', hidden: true });
    refs.snap = h('div', { class: 'al-snap-box' });
    refs.canvas = h('canvas', { class: 'al-live-canvas', role: 'img', 'aria-label': 'Vidéo en direct de la caméra liée à l’alarme' });
    refs.liveStatus = h('p', { class: 'al-live-status', role: 'status', hidden: true });
    refs.liveBox = h('div', { class: 'al-live', hidden: true }, refs.canvas, refs.liveStatus);
    refs.ack = h('button', { type: 'button', class: 'btn btn-danger al-act', onClick: () => act('ack', undefined, 'Alarme acquittée ✓') }, 'Acquitter');
    refs.go = h('button', { type: 'button', class: 'btn btn-primary al-act', onClick: () => act('dispatch', { status: 'en_route' }, 'C’est noté : vous y allez ✓') }, 'J’y vais');
    refs.here = h('button', { type: 'button', class: 'btn btn-ok al-act', onClick: () => act('dispatch', { status: 'on_site' }, 'C’est noté : vous êtes sur place ✓') }, 'Sur place');
    refs.live = h('button', { type: 'button', class: 'btn btn-quiet al-act', onClick: toggleLive }, 'Voir en direct');
    refs.back = h('button', { type: 'button', class: 'btn btn-quiet al-back', onClick: closeDetail }, '‹ Retour');
    detail.refs = refs;

    // Image de l'incident : un toucher l'agrandit ou la reduit ; si elle ne charge pas, on le dit.
    if (alarm.hasSnapshot) {
      const img = h('img', {
        class: 'al-snap',
        src: `/api/agent/alarms/${encodeURIComponent(String(id))}/snapshot?t=${alarm.openedAt ?? Math.round(Date.now() / 60000) * 60000}`,
        alt: `Dernière image de la caméra pour l’alarme « ${alarm.title} »`,
      });
      const zoom = h('button', { type: 'button', class: 'al-snap-btn', 'aria-label': 'Agrandir ou réduire l’image', onClick: () => zoom.classList.toggle('al-snap-big') }, img);
      img.addEventListener('error', () => {
        setChildren(refs.snap, h('p', { class: 'al-snap-missing', text: 'Image indisponible' }));
      });
      setChildren(refs.snap, zoom);
    } else {
      refs.snap.hidden = true;
    }
    refs.live.hidden = !alarm.hasLive;

    const sheet = h(
      'div',
      { class: 'sheet al-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Détail de l’alarme' },
      refs.back,
      refs.sev,
      refs.title,
      refs.place,
      refs.reason,
      refs.device,
      refs.state,
      refs.snap,
      refs.liveBox,
      refs.error,
      h('div', { class: 'stack al-actions' }, refs.ack, refs.go, refs.here, refs.live),
    );
    detail.overlay = h('div', { class: 'overlay al-overlay' }, sheet);
    detail.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDetail();
    });
    el.append(detail.overlay);
    updateDetail(true);
    refs.back.focus();
  }

  function closeDetail() {
    stopLive();
    detail.overlay?.remove();
    detail.overlay = null;
    detail.refs = null;
    detail.id = null;
    detail.liveOn = false;
  }

  /** Remet le detail d'accord avec la derniere reponse ; l'alarme a disparu = elle est cloturee : on le dit et on ferme. */
  function updateDetail() {
    if (detail.id === null || !detail.refs) return;
    const alarm = currentAlarm();
    if (!alarm) {
      closeDetail();
      toast('Cette alarme est clôturée.', 'info');
      return;
    }
    const r = detail.refs;
    setChildren(r.sev, severityPill(alarm.severity));
    r.title.textContent = alarm.title;
    r.place.textContent = placeOf(alarm);
    r.place.hidden = !placeOf(alarm);
    r.reason.textContent = alarm.detail ?? '';
    r.reason.hidden = !alarm.detail;
    r.device.textContent = alarm.deviceName ? `Équipement : ${alarm.deviceName}` : '';
    r.device.hidden = !alarm.deviceName;
    const now = Date.now();
    setChildren(r.state, h('p', { class: 'al-age', text: ageText(alarm, now) }), ackBlock(alarm), dispatchPills(alarm));
    r.ack.hidden = alarm.acknowledged !== false;
    r.live.hidden = !alarm.hasLive;
    for (const b of [r.ack, r.go, r.here, r.live]) b.disabled = detail.busy && b !== r.live;
  }

  function toggleLive() {
    const r = detail.refs;
    if (!r) return;
    detail.liveOn = !detail.liveOn;
    r.liveBox.hidden = !detail.liveOn;
    r.live.textContent = detail.liveOn ? 'Arrêter la vidéo' : 'Voir en direct';
    if (detail.liveOn) startLive();
    else stopLive();
  }

  async function act(action, body, okMessage) {
    const r = detail.refs;
    const id = detail.id;
    if (!r || id === null || detail.busy) return;
    detail.busy = true;
    r.error.hidden = true;
    updateDetail();
    const res = await api(`/api/agent/alarms/${encodeURIComponent(String(id))}/${action}`, { method: 'POST', body, timeoutMs: 10000 });
    detail.busy = false;
    if (res.ok) {
      toast(okMessage, 'ok');
      await refresh();
    } else if (detail.refs === r) {
      r.error.textContent = res.network ? 'Pas de réseau : l’action n’a pas été envoyée. Réessayez.' : res.error;
      r.error.hidden = false;
    }
    updateDetail();
  }

  // ---- Cycle de vie
  function start() {
    if (running) return;
    running = true;
    document.addEventListener('visibilitychange', onVisibility);
    tickTimer = setInterval(() => {
      render();
      updateDetail();
    }, TICK_MS);
    render(true);
    void refresh();
  }

  function stop() {
    running = false;
    document.removeEventListener('visibilitychange', onVisibility);
    clearTimeout(pollTimer);
    clearInterval(tickTimer);
    clearInterval(soundTimer);
    pollTimer = tickTimer = soundTimer = null;
    closeDetail();
    // On oublie tout : le telephone peut passer a un autre agent.
    alarms = [];
    knownIds = new Set();
    loaded = false;
    failed = false;
    lastOkAt = 0;
    again = false;
    lastSig = '';
  }

  function setActive(value) {
    const next = Boolean(value);
    if (next === active) return;
    active = next;
    if (!detail.refs) return;
    if (active) startLive();
    else stopLive(); // onglet change : on libere la connexion video, elle reprend au retour
    if (active && running) void refresh();
  }

  return { el, start, stop, setActive, refresh };
}
