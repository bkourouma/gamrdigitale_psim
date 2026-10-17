// Application des agents : SOS (appel a l'aide).
//
// Deux couches, comme le reste de l'application :
//  - des parties PURES (aucun acces au DOM, dependances injectees) importees par les tests de node:test :
//    holdProgress (progression de l'appui maintenu), createHoldGesture (le geste), createSosMachine (envoi et essais) ;
//  - l'interface (createSos) : bouton a appui maintenu, bandeau d'etat, ecran de l'onglet SOS, mode discret.
//
// Regle d'or : un SOS ne se perd JAMAIS en silence. Tant qu'il n'est pas parti, l'etat reste « non transmis »
// (jamais « repos ») et un nouvel essai a lieu toutes les 10 secondes, sans jamais abandonner, meme si l'ecran change.

import { append, fmtClock, h, local, uuid } from './util.js';
import { beep, unlockAudio, vibrate } from './sound.js';

/** Duree de l'appui maintenu qui declenche le SOS (evite les faux appuis dans la poche). */
export const HOLD_MS = 2000;
/** Delai entre deux essais d'envoi. */
export const RETRY_MS = 10000;
/** Duree pendant laquelle « SOS envoye » reste visible. */
export const SENT_VISIBLE_MS = 60000;
/** Au-dela, un essai qui ne repond pas est compte comme echoue (la file a deja son propre delai de 10 s). */
export const ATTEMPT_TIMEOUT_MS = 25000;
/** Cle localStorage du mode discret (conservee apres la fin de service). */
export const DISCREET_KEY = 'psim-agent-discreet';

// ---------------------------------------------------------------------------------------------------------------
// Parties pures
// ---------------------------------------------------------------------------------------------------------------

/** Progression (0 a 1) d'un appui maintenu depuis `elapsedMs`. Bornee ; toute valeur invalide donne 0. */
export function holdProgress(elapsedMs, holdMs = HOLD_MS) {
  if (typeof elapsedMs !== 'number' || Number.isNaN(elapsedMs)) return 0;
  if (typeof holdMs !== 'number' || Number.isNaN(holdMs) || holdMs <= 0) return elapsedMs > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, elapsedMs / holdMs));
}

/** Secondes restantes avant le prochain essai (arrondi au-dessus, jamais negatif). */
export function retryCountdown(nextRetryAt, nowMs) {
  if (typeof nextRetryAt !== 'number' || Number.isNaN(nextRetryAt)) return 0;
  return Math.max(0, Math.ceil((nextRetryAt - nowMs) / 1000));
}

/** Ne garde que les elements « sos » d'une liste d'attente (la coquille y met aussi scans et main courante). */
export function sosItems(items) {
  return Array.isArray(items) ? items.filter((item) => item && item.kind === 'sos' && typeof item.clientId === 'string') : [];
}

/**
 * Le geste d'appui maintenu, sans DOM : `now` donne l'heure (idealement monotone), `tick()` est appele a chaque image
 * d'animation. Complete UNE seule fois ; `cancel()` remet la progression a zero ; un nouvel appui repart de zero.
 */
export function createHoldGesture({ holdMs = HOLD_MS, now, onProgress, onComplete }) {
  let startedAt = null;
  return {
    get active() {
      return startedAt !== null;
    },
    start() {
      if (startedAt !== null) return false;
      startedAt = now();
      onProgress?.(0);
      return true;
    },
    tick() {
      if (startedAt === null) return 0;
      const progress = holdProgress(now() - startedAt, holdMs);
      onProgress?.(progress);
      if (progress >= 1) {
        startedAt = null;
        onComplete?.();
      }
      return progress;
    },
    cancel() {
      if (startedAt === null) return false;
      startedAt = null;
      onProgress?.(0);
      return true;
    },
  };
}

function errorText(error, fallback = '') {
  const text = typeof error === 'string' ? error : error && typeof error.message === 'string' ? error.message : '';
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 160);
  return clean || fallback;
}

function blankState(previous) {
  return {
    phase: 'idle',
    discreet: false,
    clientId: null,
    phoneAt: null,
    startedAt: null,
    sentAt: null,
    attempts: 0,
    trying: false,
    nextRetryAt: null,
    error: null,
    rejected: false,
    lastSentAt: previous?.lastSentAt ?? null,
    lastSentDiscreet: previous?.lastSentDiscreet ?? false,
  };
}

/**
 * La machine d'envoi du SOS : idle -> sending -> sent | failed, avec essais toutes les 10 s.
 *
 * Dependances (toutes injectees, rien de reel dans ce fichier) :
 *  - submit(payload) : envoie un SOS { clientId, phoneAt, discreet } ; resout { sent, rejected?, error? }
 *    (c'est `queue.submit('sos', …)` : l'element est ecrit dans la file AVANT l'envoi) ;
 *  - flush() : retente les envois en attente (`queue.flush({ kinds: ['sos'] })`) ; resout { sent, remaining } ;
 *  - pending() : les elements « sos » encore dans la file ;
 *  - newId(), now(), setTimer(fn, ms) -> poignee, clearTimer(poignee), onState(instantane, evenement).
 *
 * Evenements : 'sending' (appui valide), 'trying' (un essai demarre), 'failed' (premier echec de ce SOS),
 * 'failing' (echec suivant), 'sent', 'idle' (retour au repos), 'resumed' (SOS retrouve au demarrage).
 *
 * Cas particuliers :
 *  - rejet (4xx : heure du telephone decalee…) : l'element est retire de la file par le serveur de file ; chaque essai
 *    suivant envoie donc un NOUVEAU SOS (nouveau clientId, phoneAt = maintenant), sans jamais abandonner ;
 *  - ecriture impossible dans la file (submit leve) : on garde le SOS en memoire et on le renvoie tel quel ;
 *  - un second appui pendant « sending » ou « failed » ne cree rien (trigger renvoie started: false) ;
 *  - un essai qui ne repond pas apres `attemptTimeoutMs` compte comme echoue ; sa reponse tardive est quand meme
 *    prise en compte si elle est positive.
 */
export function createSosMachine(deps) {
  const { submit, flush, pending, newId, now = Date.now, setTimer, clearTimer, onState } = deps;
  const retryMs = deps.retryMs ?? RETRY_MS;
  const sentMs = deps.sentMs ?? SENT_VISIBLE_MS;
  const attemptTimeoutMs = deps.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;

  let state = blankState(null);
  // Interne (hors instantane) : l'element est-il dans la file ? faut-il un nouveau SOS (apres rejet) ? deja un echec ?
  let inner = { queued: false, needNew: false, failedOnce: false };
  let epoch = 0; // change a chaque nouveau SOS : les reponses tardives d'un ancien SOS sont ignorees
  let running = false;
  let retryTimer = null;
  let sentTimer = null;

  const snapshot = () => ({ ...state });
  const emit = (event) => {
    try {
      onState?.(snapshot(), event);
    } catch {
      // l'affichage ne doit jamais casser l'envoi
    }
  };
  const stop = (handle) => {
    if (handle === null) return;
    try {
      clearTimer(handle);
    } catch {
      // rien
    }
  };
  const clearRetry = () => {
    stop(retryTimer);
    retryTimer = null;
  };
  const clearSent = () => {
    stop(sentTimer);
    sentTimer = null;
  };
  const busy = () => state.phase === 'sending' || state.phase === 'failed';

  /** Envoi par la file : renvoie un resultat normalise { sent, rejected?, error?, queued?, needNew? }. */
  async function viaSubmit(payload) {
    try {
      const result = await submit(payload);
      if (result?.sent) return { sent: true };
      if (result?.rejected) return { sent: false, rejected: true, queued: false, needNew: true, error: errorText(result.error, 'SOS refusé') };
      return { sent: false, queued: true, error: errorText(result?.error, 'Pas de réseau') };
    } catch (error) {
      // la file elle-meme a echoue (IndexedDB indisponible…) : rien n'est stocke, on gardera le SOS en memoire
      return { sent: false, queued: false, error: errorText(error, 'File d’envoi indisponible') };
    }
  }

  /** Essai d'un SOS deja present dans la file : on vide, puis on regarde ce qu'il est devenu. */
  async function viaFlush(payload) {
    let flushed = null;
    try {
      flushed = await flush();
    } catch {
      // on regardera quand meme la file
    }
    let items;
    try {
      items = sosItems(await pending());
    } catch {
      return { sent: false, error: 'File d’envoi illisible' };
    }
    const mine = items.find((item) => item.clientId === payload.clientId);
    if (mine) return { sent: false, error: errorText(mine.lastError, 'Pas de réseau') };
    if ((flushed?.sent ?? 0) > 0) return { sent: true };
    // Plus dans la file sans que ce vidage l'ait envoye (envoye par la vidange periodique de la file, ou retire apres
    // un rejet) : on le re-soumet tel quel. Le serveur est idempotent sur clientId, la reponse dira ce qu'il en est.
    return viaSubmit(payload);
  }

  /** Attend un essai, au plus attemptTimeoutMs. Une reponse tardive positive est rattrapee par `late`. */
  function guarded(promise, late) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimer(() => {
        if (settled) return;
        settled = true;
        resolve({ sent: false, error: 'Pas de réponse' });
      }, attemptTimeoutMs);
      promise.then(
        (result) => {
          if (settled) {
            late(result);
            return;
          }
          settled = true;
          stop(timer);
          resolve(result);
        },
        () => {
          if (settled) return;
          settled = true;
          stop(timer);
          resolve({ sent: false, error: 'Erreur inattendue' });
        },
      );
    });
  }

  function succeed() {
    clearRetry();
    clearSent();
    state.phase = 'sent';
    state.trying = false;
    state.nextRetryAt = null;
    state.error = null;
    state.rejected = false;
    state.sentAt = now();
    state.lastSentAt = state.sentAt;
    state.lastSentDiscreet = state.discreet;
    sentTimer = setTimer(toIdle, sentMs);
    emit('sent');
  }

  function toIdle() {
    sentTimer = null;
    if (state.phase !== 'sent') return;
    state = blankState(state);
    emit('idle');
  }

  function fail(outcome) {
    state.phase = 'failed';
    state.trying = false;
    state.error = outcome.error ?? null;
    state.rejected = outcome.rejected === true;
    state.nextRetryAt = now() + retryMs;
    clearRetry();
    retryTimer = setTimer(() => {
      retryTimer = null;
      void attempt();
    }, retryMs);
    const first = !inner.failedOnce;
    inner.failedOnce = true;
    emit(first ? 'failed' : 'failing');
  }

  /** Un essai d'envoi (le premier, ou un des essais espaces de 10 s). Jamais deux en meme temps. */
  async function attempt() {
    if (running || !busy()) return;
    clearRetry();
    running = true;
    const myEpoch = epoch;
    state.attempts += 1;
    state.trying = true;
    state.nextRetryAt = null;
    if (state.phase === 'failed') emit('trying');
    if (inner.needNew) {
      // apres un rejet : nouvel SOS (nouveau clientId, heure du telephone a jour)
      state.clientId = newId();
      state.phoneAt = now();
      inner.needNew = false;
      inner.queued = false;
    }
    const payload = { clientId: state.clientId, phoneAt: state.phoneAt, discreet: state.discreet };
    const apply = (outcome) => {
      if (outcome.queued !== undefined) inner.queued = outcome.queued;
      if (outcome.needNew !== undefined) inner.needNew = outcome.needNew;
    };
    const work = inner.queued ? viaFlush(payload) : viaSubmit(payload);
    const outcome = await guarded(work, (late) => {
      // reponse arrivee apres le delai : si elle est positive et que ce SOS est toujours en cause, c'est parti
      if (myEpoch === epoch && late?.sent && busy() && state.clientId === payload.clientId) succeed();
    });
    running = false;
    if (myEpoch !== epoch || !busy()) return;
    apply(outcome);
    if (outcome.sent) succeed();
    else fail(outcome);
  }

  return {
    /** Appui valide (2 s tenues). Sans effet si un SOS est deja en cours. */
    trigger({ discreet = false } = {}) {
      if (busy()) return { started: false, done: Promise.resolve() };
      clearSent();
      clearRetry();
      epoch += 1;
      const startedAt = now();
      state = { ...blankState(state), phase: 'sending', discreet: discreet === true, clientId: newId(), phoneAt: startedAt, startedAt };
      inner = { queued: false, needNew: false, failedOnce: false };
      emit('sending');
      return { started: true, done: attempt() };
    },

    /** « Reessayer maintenant » : un essai tout de suite, sans attendre les 10 s. */
    async retryNow() {
      if (state.phase !== 'failed' || running) return false;
      await attempt();
      return true;
    },

    /**
     * Au demarrage de l'application : s'il reste un SOS dans la file (l'application a ete fermee avant l'envoi),
     * on repasse en « non transmis » et on reprend les essais tout de suite.
     */
    async resume() {
      if (state.phase !== 'idle') return true;
      let items;
      try {
        items = sosItems(await pending());
      } catch {
        return false;
      }
      if (items.length === 0) return false;
      if (state.phase !== 'idle') return true; // un appui a eu lieu pendant la lecture
      const item = items.reduce((a, b) => ((b.createdAt ?? 0) >= (a.createdAt ?? 0) ? b : a));
      const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};
      const created = Number.isFinite(item.createdAt) ? item.createdAt : now();
      clearSent();
      clearRetry();
      epoch += 1;
      state = {
        ...blankState(state),
        phase: 'failed',
        discreet: payload.discreet === true,
        clientId: item.clientId,
        phoneAt: Number.isFinite(payload.phoneAt) ? payload.phoneAt : created,
        startedAt: created,
        error: errorText(item.lastError) || null,
      };
      inner = { queued: true, needNew: false, failedOnce: false };
      emit('resumed');
      await attempt();
      return true;
    },

    snapshot,

    /** Arrete les minuteurs (tests, demontage). */
    dispose() {
      epoch += 1;
      clearRetry();
      clearSent();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------------------------------------------

const ARIA_LABEL = 'SOS : maintenez 2 secondes pour appeler à l’aide';
const HINT_IDLE = 'Maintenez 2 secondes';
const SVG_NS = 'http://www.w3.org/2000/svg';
const HOLD_KEYS = new Set([' ', 'Enter', 'Spacebar']);
const BUTTON_HINT = { idle: HINT_IDLE, sending: 'Envoi en cours…', sent: 'SOS envoyé ✓', failed: 'Non transmis ✖' };
const DOT_LABEL = { sending: 'SOS en cours d’envoi', sent: 'SOS envoyé', failed: 'SOS non transmis' };
const DOT_GLYPH = { sending: '…', sent: '✓', failed: '✖' };

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {})) el.setAttribute(key, String(value));
  return el;
}

/** Horloge monotone pour l'appui maintenu (un changement d'heure du telephone ne doit pas le raccourcir). */
const holdClock = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/** Ce que dit l'interface d'un instantane de la machine : message, detail, ton, icone. */
function describe(snap, nowMs) {
  if (snap.phase === 'sending') return { tone: 'sending', icon: '…', message: 'SOS en cours d’envoi…', detail: '' };
  if (snap.phase === 'sent') return { tone: 'sent', icon: '✓', message: `SOS envoyé ✓ à ${fmtClock(snap.sentAt ?? nowMs)}`, detail: '' };
  if (snap.phase === 'failed') {
    const wait = snap.trying
      ? `Essai n° ${snap.attempts} en cours…`
      : `Essai n° ${snap.attempts + 1} dans ${retryCountdown(snap.nextRetryAt, nowMs)} s`;
    if (snap.rejected) {
      return {
        tone: 'failed',
        icon: '✖',
        message: 'SOS non transmis — appelez le poste de garde',
        detail: `Le serveur a refusé : ${snap.error ?? 'raison inconnue'}. ${wait}`,
      };
    }
    return { tone: 'failed', icon: '✖', message: 'SOS non transmis — nouvel essai…', detail: wait };
  }
  return null;
}

/**
 * Cree le SOS. Rien ne touche au DOM avant cet appel. `queue` = file hors ligne (queue.js), `getUser` = nom de l'agent
 * connecte, `toast` = petit message de la coquille.
 */
export function createSos({ queue, getUser, toast }) {
  const views = new Set();
  let ticker = null;

  const machine = createSosMachine({
    submit: (payload) => queue.submit('sos', payload, { username: getUser() ?? '' }),
    flush: () => queue.flush({ kinds: ['sos'] }),
    pending: async () => sosItems(await queue.pending()),
    newId: uuid,
    now: Date.now,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle),
    onState: (snap, event) => {
      effects(snap, event);
      render(snap);
    },
  });

  const isDiscreet = () => local.get(DISCREET_KEY, false) === true;

  /** Sons et vibrations : aucun son en mode discret, une vibration courte (ou trois si non transmis). */
  function effects(snap, event) {
    if (snap.discreet) {
      if (event === 'sent') vibrate(80);
      else if (event === 'failed') vibrate([80, 100, 80, 100, 80]);
      return;
    }
    if (event === 'sending') {
      vibrate(200);
      beep('alarm');
    } else if (event === 'sent') {
      vibrate(120);
      beep('ok');
    } else if (event === 'failed') {
      vibrate([200, 100, 200]);
      beep('error');
    }
  }

  // --- Bandeau d'etat (visible sur tous les ecrans tant que le SOS n'est pas au repos, sauf en mode discret) ---
  const statusIcon = h('span', { class: 'sos-status-icon', 'aria-hidden': 'true' });
  const statusMessage = h('strong', { class: 'sos-status-message' });
  // Le decompte change chaque seconde : il est cache aux lecteurs d'ecran pour ne pas etre relu en boucle.
  const statusDetail = h('span', { class: 'sos-status-detail', 'aria-hidden': 'true' });
  const retryButton = h('button', { type: 'button', class: 'btn sos-status-retry', text: 'Réessayer maintenant', hidden: true, onclick: onRetryClick });
  const statusEl = h(
    'div',
    { class: 'sos-status', role: 'status', 'aria-live': 'assertive', 'aria-atomic': 'true', hidden: true },
    statusIcon,
    h('div', { class: 'sos-status-body' }, statusMessage, statusDetail),
    retryButton,
  );

  function onRetryClick() {
    void machine.retryNow();
  }

  function renderStatus(snap) {
    const info = describe(snap, Date.now());
    const visible = info !== null && !snap.discreet;
    statusEl.hidden = !visible;
    if (!visible) {
      statusEl.dataset.tone = 'none';
      return;
    }
    statusEl.dataset.tone = info.tone;
    statusIcon.textContent = info.icon;
    statusMessage.textContent = info.message;
    statusDetail.textContent = info.detail;
    statusDetail.hidden = info.detail === '';
    const canRetry = snap.phase === 'failed';
    retryButton.hidden = !canRetry;
    retryButton.disabled = snap.trying;
    retryButton.textContent = snap.trying ? 'Essai en cours…' : 'Réessayer maintenant';
  }

  // --- Ecran de l'onglet SOS ---
  const lastEl = h('p', { class: 'sos-last' });
  const discreetInput = h('input', { type: 'checkbox', role: 'switch', class: 'sos-switch-input', id: 'sos-discreet' });
  const discreetState = h('span', { class: 'sos-switch-state' });

  function renderDiscreetSwitch() {
    const on = isDiscreet();
    discreetInput.checked = on;
    discreetInput.setAttribute('aria-checked', on ? 'true' : 'false');
    discreetState.textContent = on ? 'Activé' : 'Désactivé';
  }
  discreetInput.addEventListener('change', () => {
    local.set(DISCREET_KEY, discreetInput.checked);
    renderDiscreetSwitch();
  });

  function renderLast(snap) {
    const info = describe(snap, Date.now());
    let text;
    if (info && !snap.discreet) text = `État : ${info.message}`;
    else if (info) text = ''; // SOS discret en cours : rien ne s'affiche (voir la pastille du bouton)
    else if (snap.lastSentAt !== null && !snap.lastSentDiscreet) text = `Dernier SOS envoyé à ${fmtClock(snap.lastSentAt)}.`;
    else text = 'Aucun SOS envoyé pour le moment.';
    lastEl.textContent = text;
    lastEl.hidden = text === '';
  }

  const screen = h(
    'section',
    { class: 'screen sos-screen', 'aria-labelledby': 'sos-title' },
    h('h2', { class: 'screen-title', id: 'sos-title', text: 'SOS' }),
    h('p', { class: 'sos-explain', text: 'Maintenez le bouton 2 secondes. Le poste de garde reçoit votre nom et votre dernier point de contrôle.' }),
    h('div', { class: 'sos-stage' }, holdButton({ variant: 'large' })),
    lastEl,
    h(
      'label',
      { class: 'sos-switch card', for: 'sos-discreet' },
      discreetInput,
      h(
        'span',
        { class: 'sos-switch-text' },
        h('strong', { class: 'sos-switch-title', text: 'Mode SOS discret' }),
        h('span', { class: 'sos-switch-hint', text: 'Sans son et sans message à l’écran. Une courte vibration confirme l’envoi.' }),
      ),
      discreetState,
    ),
  );

  // --- Boutons ---
  function holdButton({ variant = 'compact' } = {}) {
    const large = variant === 'large';
    const progress = svg('circle', { class: 'sos-ring-progress', cx: 50, cy: 50, r: 46, pathLength: 100 });
    const ring = svg('svg', { class: 'sos-ring', viewBox: '0 0 100 100', 'aria-hidden': 'true', focusable: 'false' });
    ring.append(svg('circle', { class: 'sos-ring-track', cx: 50, cy: 50, r: 46 }), progress);
    const hint = large ? h('span', { class: 'sos-btn-hint', text: HINT_IDLE }) : null;
    const dotGlyph = h('span', { class: 'sos-dot-glyph', 'aria-hidden': 'true' });
    const dot = h('span', { class: 'sos-dot', role: 'img', 'aria-label': '' }, dotGlyph);
    const button = h(
      'button',
      {
        type: 'button',
        class: `sos-btn ${large ? 'sos-btn-large' : 'sos-btn-compact'}`,
        'aria-label': ARIA_LABEL,
        dataset: { sosState: 'idle', discreet: 'false' },
      },
      ring,
      h('span', { class: 'sos-disc' }, h('span', { class: 'sos-btn-label', text: 'SOS' }), hint),
      dot,
    );

    const view = { button, progress, hint, dot, dotGlyph, large, seen: false, raf: 0, gesture: null };
    view.gesture = createHoldGesture({
      now: holdClock,
      onProgress: (p) => progress.style.setProperty('--sos-p', String(p)),
      onComplete: () => {
        endHold(view);
        fire();
      },
    });
    views.add(view);
    wire(view);
    paint(view, machine.snapshot());
    return button;
  }

  function loop(view) {
    cancelAnimationFrame(view.raf);
    view.raf = requestAnimationFrame(() => {
      view.raf = 0;
      view.gesture.tick();
      if (view.gesture.active) loop(view);
    });
  }

  /** Un appui commence (doigt, souris ou clavier). Pendant un SOS en cours : on montre l'etat, on ne duplique pas. */
  function beginHold(view) {
    const snap = machine.snapshot();
    if (snap.phase === 'sending' || snap.phase === 'failed') {
      onBusyPress(snap);
      return false;
    }
    unlockAudio();
    if (!view.gesture.start()) return false;
    view.button.classList.add('is-holding');
    loop(view);
    return true;
  }

  function endHold(view) {
    cancelAnimationFrame(view.raf);
    view.raf = 0;
    view.gesture.cancel();
    view.button.classList.remove('is-holding');
    view.progress.style.setProperty('--sos-p', '0');
  }

  function fire() {
    const result = machine.trigger({ discreet: isDiscreet() });
    if (!result.started) onBusyPress(machine.snapshot());
  }

  function onBusyPress(snap) {
    if (!snap.discreet) {
      const info = describe(snap, Date.now());
      if (info) toast?.(`SOS déjà en cours. ${info.message}`);
    }
    if (snap.phase === 'failed') void machine.retryNow();
  }

  function wire(view) {
    const { button } = view;
    let pointerId = null;

    button.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      if (!beginHold(view)) return;
      pointerId = event.pointerId;
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        // sans capture, pointerleave annule l'appui
      }
    });
    const release = () => {
      pointerId = null;
      endHold(view);
    };
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('pointerleave', release);
    button.addEventListener('lostpointercapture', release);
    // Doigt qui glisse hors du bouton : on annule (la capture empeche pointerleave de se produire).
    button.addEventListener('pointermove', (event) => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      const rect = button.getBoundingClientRect();
      const margin = 12;
      if (event.clientX < rect.left - margin || event.clientX > rect.right + margin || event.clientY < rect.top - margin || event.clientY > rect.bottom + margin) release();
    });

    // Clavier : Espace ou Entree maintenus 2 s.
    button.addEventListener('keydown', (event) => {
      if (!HOLD_KEYS.has(event.key)) return;
      event.preventDefault(); // pas de clic synthetique, pas de defilement
      if (event.repeat) return;
      beginHold(view);
    });
    button.addEventListener('keyup', (event) => {
      if (HOLD_KEYS.has(event.key)) endHold(view);
    });
    button.addEventListener('blur', () => endHold(view));

    // Pas de menu contextuel, de selection ni de glisser-deposer au long appui.
    for (const name of ['contextmenu', 'selectstart', 'dragstart']) button.addEventListener(name, (event) => event.preventDefault());

    // Un clic sans appui maintenu (lecteur d'ecran, clic synthetique) n'envoie rien : on explique comment faire.
    button.addEventListener('click', (event) => {
      event.preventDefault();
      if (machine.snapshot().phase === 'idle') toast?.('Pour appeler à l’aide, maintenez le bouton SOS 2 secondes.');
    });
  }

  // Un appui interrompu par la perte de visibilite ou de focus de la page est annule (jamais d'envoi a moitie voulu).
  const cancelAll = () => {
    for (const view of views) endHold(view);
  };
  const onVisibility = () => {
    if (document.hidden) cancelAll();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('blur', cancelAll);
  window.addEventListener('pagehide', cancelAll);

  // --- Affichage ---
  function paint(view, snap) {
    const active = snap.phase !== 'idle';
    const quiet = active && snap.discreet;
    view.button.dataset.sosState = snap.phase;
    view.button.dataset.discreet = quiet ? 'true' : 'false';
    view.button.setAttribute('aria-busy', snap.phase === 'sending' ? 'true' : 'false');
    if (view.hint) view.hint.textContent = quiet ? HINT_IDLE : (BUTTON_HINT[snap.phase] ?? HINT_IDLE);
    if (quiet) {
      view.dot.setAttribute('aria-label', DOT_LABEL[snap.phase] ?? '');
      view.dotGlyph.textContent = DOT_GLYPH[snap.phase] ?? '';
    } else {
      view.dot.setAttribute('aria-label', '');
      view.dotGlyph.textContent = '';
    }
  }

  function render(snap) {
    for (const view of [...views]) {
      if (view.button.isConnected) view.seen = true;
      else if (view.seen) {
        endHold(view);
        views.delete(view);
        continue;
      }
      paint(view, snap);
    }
    renderStatus(snap);
    renderLast(snap);
    // Le decompte du prochain essai avance chaque seconde.
    if (snap.phase === 'failed' && ticker === null) {
      ticker = setInterval(() => render(machine.snapshot()), 1000);
    } else if (snap.phase !== 'failed' && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  renderDiscreetSwitch();
  render(machine.snapshot());

  return {
    screen,
    statusEl,
    holdButton,
    resume: async () => {
      await machine.resume();
    },
    state: () => machine.snapshot().phase,
    /**
     * Demontage (deconnexion, changement d'agent) : plus aucun essai, plus d'ecouteur. Un SOS non parti reste dans la file
     * du telephone et reprend (resume) a la prochaine connexion de ce meme agent ; il ne part jamais sous un autre nom.
     */
    dispose: () => {
      machine.dispose();
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
      cancelAll();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', cancelAll);
      window.removeEventListener('pagehide', cancelAll);
    },
  };
}
