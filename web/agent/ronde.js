// Application des agents : onglet « Ronde ».
// Montre la ronde en cours (progression, points, delai), enregistre les passages (NFC, QR, saisie du code) et
// affiche une confirmation plein ecran. Tout marche hors reseau : les passages partent dans la file (queue.js).
// Aucun acces au DOM a l'import : les calculs purs en tete de fichier sont testes par node:test.

import { beep, vibrate } from './sound.js';
import { nfcSupported, parseCheckpointCode, qrSupported, startNfcScan, startQrScan } from './scan.js';
import { fmtClock, fmtDuration, h, local, setChildren, uuid } from './util.js';

const RUNS_KEY = 'psim-agent-runs';
const POLL_FAST_MS = 5000; // onglet Ronde affiche
const POLL_SLOW_MS = 15000; // autre onglet
const TICK_MS = 5000; // rythme du minuteur interne (affichage des delais + decision d'interroger)
const OPEN_BEFORE_MS = 15 * 60000; // la plage d'une ronde s'ouvre 15 min avant son debut
const URGENT_MS = 10 * 60000; // « presque en retard » sous 10 min
const REPEAT_MS = 3000; // les lecteurs repetent : meme code ignore pendant 3 s
const CONFIRM_MS = 2500; // duree de l'ecran de confirmation

// ---------------------------------------------------------------------------------------------------------------
// Parties pures
// ---------------------------------------------------------------------------------------------------------------

/**
 * Ronde a mettre en avant : celle en cours (`active`) ; sinon une `pending` dont la plage est ouverte
 * (de 15 min avant le debut jusqu'a l'echeance) ; sinon la prochaine a venir. null s'il n'y en a aucune.
 */
export function pickCurrentRun(runs, now) {
  const list = Array.isArray(runs) ? runs : [];
  const byStart = (a, b) => a.dueStart - b.dueStart;
  const active = list.filter((r) => r.status === 'active').sort(byStart);
  if (active.length > 0) return active[0];
  const pending = list.filter((r) => r.status === 'pending').sort(byStart);
  const open = pending.find((r) => now >= r.dueStart - OPEN_BEFORE_MS && now <= r.dueEnd);
  if (open) return open;
  return pending.find((r) => r.dueStart > now) ?? null;
}

/** Avancement d'une ronde : { done, total, percent } (percent entier 0..100, 0 si la ronde est vide). */
export function runProgress(run) {
  const points = Array.isArray(run?.checkpoints) ? run.checkpoints : [];
  const total = points.length;
  const done = points.filter((c) => c.done).length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done * 100) / total) };
}

/** Prochain point du circuit : le premier non fait, dans l'ordre. null si tout est fait (ou circuit vide). */
export function nextCheckpoint(run) {
  const points = Array.isArray(run?.checkpoints) ? run.checkpoints : [];
  return points.find((c) => !c.done) ?? null;
}

/** « dans 12 min », « dans 1 h 05 », « dans moins d’une minute », « dépassé de 3 min ». */
export function timeLeftLabel(dueEnd, now) {
  const diff = dueEnd - now;
  if (diff < 0) {
    return Math.round(-diff / 60000) < 1 ? 'dépassé à l’instant' : `dépassé de ${fmtDuration(-diff)}`;
  }
  if (Math.round(diff / 60000) < 1) return 'dans moins d’une minute';
  return `dans ${fmtDuration(diff)}`;
}

/** Vrai quand il reste moins de 10 min avant l'echeance, ou quand elle est depassee. */
export function isUrgent(dueEnd, now) {
  return dueEnd - now < URGENT_MS;
}

/** Le meme code relu moins de 3 s apres le precedent est ignore (les lecteurs NFC/QR repetent). */
export function shouldIgnoreRepeat(lastCode, lastAt, code, now) {
  return lastCode !== null && lastCode !== undefined && lastCode === code && now - lastAt < REPEAT_MS;
}

/**
 * Message affiche pour le verdict du serveur : { tone: 'ok' | 'warn', text }.
 * `next` : prochain point de la ronde (objet avec `name`, ou nom), utile pour « hors ordre ».
 */
export function describeVerdict(verdict, { next } = {}) {
  const nextName = typeof next === 'string' ? next : next?.name;
  switch (verdict) {
    case 'ok':
      return { tone: 'ok', text: 'Point validé' };
    case 'out_of_route':
      return { tone: 'warn', text: 'Ce point n’est pas dans votre ronde' };
    case 'out_of_order':
      return {
        tone: 'warn',
        text: nextName
          ? `Hors ordre : ce point ne compte pas — allez d’abord à ${nextName}`
          : 'Hors ordre : ce point ne compte pas',
      };
    case 'no_run':
      return { tone: 'warn', text: 'Aucune ronde en cours : passage noté' };
    case 'duplicate':
      return { tone: 'warn', text: 'Point déjà validé' };
    default:
      return { tone: 'warn', text: 'Passage noté' };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Ecran
// ---------------------------------------------------------------------------------------------------------------

const STATUS_WORDS = { done: 'Terminée', incomplete: 'Incomplète', missed: 'Manquée' };
const STATUS_PILL = { done: 'pill-ok', incomplete: 'pill-warn', missed: 'pill-alarm' };
const STATUS_ICON = { done: '✓', incomplete: '!', missed: '✕' };

/**
 * @param {{ api: Function, queue: any, toast: Function, getUser: () => string | null,
 *           openLogbook: (opts: { checkpoint?: { id: number, name: string } | null }) => void }} ctx
 */
export function createRonde({ api, queue, toast, getUser, openLogbook }) {
  let runs = [];
  let runsAt = 0; // heure de la derniere liste recue (ou lue dans la copie locale)
  let offline = false;
  let loadError = null;
  let inflight = null;
  let lastFetchAt = 0;
  let pendingScans = 0;
  let active = false;
  let timer = null;
  let lastCode = null;
  let lastCodeAt = 0;
  let last = null; // dernier point valide { id, name }
  let confirmEl = null;
  let confirmTimer = null;
  let scanOverlay = null; // { el, controller }
  let sheetEl = null;

  const nfcOk = nfcSupported();
  const qrOk = qrSupported();

  const body = h('div', { class: 'rd-body stack' });
  const actions = h('div', { class: 'rd-actions' });
  const el = h('section', { class: 'screen rd-screen', 'aria-label': 'Ronde' }, body, actions);

  // ---- Affichage de la ronde ----------------------------------------------------------------------------------

  function pointRow(run, point, index, next) {
    const isNext = run.ordered && next !== null && next.id === point.id;
    const state = point.done
      ? h('span', { class: 'rd-state rd-state-done' },
          h('span', { class: 'rd-icon', 'aria-hidden': 'true', text: '✓' }),
          point.doneAt ? `Fait à ${fmtClock(point.doneAt)}` : 'Fait')
      : h('span', { class: 'rd-state rd-state-todo' },
          h('span', { class: 'rd-icon', 'aria-hidden': 'true', text: '○' }),
          'À faire');
    return h('li', { class: `rd-point${point.done ? ' rd-point-done' : ''}${isNext ? ' rd-point-next' : ''}` },
      run.ordered ? h('span', { class: 'rd-num', 'aria-hidden': 'true', text: String(index + 1) }) : null,
      h('span', { class: 'rd-point-main' },
        h('span', { class: 'rd-point-name', text: point.name }),
        isNext ? h('span', { class: 'rd-point-tag', text: 'Prochain point' }) : null),
      state);
  }

  function runCard(run, now) {
    const { done, total, percent } = runProgress(run);
    const next = nextCheckpoint(run);
    const upcoming = run.status === 'pending' && now < run.dueStart - OPEN_BEFORE_MS;
    const urgent = !upcoming && isUrgent(run.dueEnd, now);
    const overdue = run.dueEnd < now;

    const bar = h('div', { class: 'rd-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total,
      'aria-valuenow': done, 'aria-label': `${done} sur ${total} points` },
      h('div', { class: 'rd-bar-fill' }));
    bar.style.setProperty('--p', `${percent}%`);

    const due = upcoming
      ? h('p', { class: 'rd-due' }, `Prochaine ronde à ${fmtClock(run.dueStart)} : ${run.name}`)
      : h('p', { class: `rd-due${urgent ? (overdue ? ' rd-due-late' : ' rd-due-soon') : ''}` },
          urgent ? h('span', { class: 'rd-icon', 'aria-hidden': 'true', text: '!' }) : null,
          `À finir avant ${fmtClock(run.dueEnd)} (${timeLeftLabel(run.dueEnd, now)})`);

    return h('article', { class: 'card rd-run' },
      h('h2', { class: 'card-title rd-run-name', text: upcoming ? 'Ronde à venir' : run.name }),
      due,
      h('div', { class: 'rd-progress' },
        h('p', { class: 'rd-progress-text', text: `${done} / ${total} points` }),
        bar),
      run.ordered && next
        ? h('p', { class: 'rd-next' }, 'Prochain point : ', h('strong', { text: next.name }))
        : null,
      total === 0
        ? h('p', { class: 'muted', text: 'Cette ronde n’a pas encore de point.' })
        : h('ol', { class: 'rd-points' }, run.checkpoints.map((c, i) => pointRow(run, c, i, next))));
  }

  function finishedLine(run) {
    const { done, total } = runProgress(run);
    const word = STATUS_WORDS[run.status];
    const detail = run.status === 'missed' ? 'aucun point validé' : `${done} / ${total} points`;
    return h('li', { class: 'rd-finished-item' },
      h('span', { class: `pill ${STATUS_PILL[run.status]}` }, `${STATUS_ICON[run.status]} ${word}`),
      h('span', { class: 'rd-finished-text', text: `${run.name} (${fmtClock(run.dueStart)}) : ${detail}` }));
  }

  function render() {
    const now = Date.now();
    const current = pickCurrentRun(runs, now);
    const others = runs.filter((r) => r.status === 'pending' && r !== current && r.dueStart > now)
      .sort((a, b) => a.dueStart - b.dueStart);
    const finished = runs.filter((r) => STATUS_WORDS[r.status]);

    const parts = [];
    if (offline && runsAt > 0) {
      parts.push(h('p', { class: 'pill pill-off rd-offline', text: `Liste du ${fmtClock(runsAt)} (hors réseau)` }));
    } else if (loadError) {
      parts.push(h('p', { class: 'pill pill-warn rd-offline', text: `! ${loadError}` }));
    }
    if (pendingScans > 0) {
      parts.push(h('p', { class: 'pill pill-warn rd-pending',
        text: pendingScans === 1 ? '! 1 passage enregistré, envoi en attente'
          : `! ${pendingScans} passages enregistrés, envoi en attente` }));
    }
    if (current) {
      parts.push(runCard(current, now));
    } else {
      parts.push(h('p', { class: 'empty',
        text: 'Pas de ronde prévue. Vous pouvez quand même scanner un point : il sera enregistré.' }));
    }
    if (others.length > 0) {
      parts.push(h('ul', { class: 'rd-upcoming' }, others.map((r) =>
        h('li', { text: `Prochaine ronde à ${fmtClock(r.dueStart)} : ${r.name}` }))));
    }
    if (finished.length > 0) {
      parts.push(h('ul', { class: 'rd-finished' }, finished.map(finishedLine)));
    }
    setChildren(body, parts);
  }

  // ---- Boutons d'action (toujours en bas) ----------------------------------------------------------------------

  function buildActions() {
    const buttons = [];
    if (!nfcOk && !qrOk) {
      buttons.push(h('p', { class: 'rd-nosupport',
        text: 'Ce téléphone ne lit ni les étiquettes NFC ni les QR codes. Saisissez le code de l’étiquette.' }));
    }
    if (nfcOk) {
      buttons.push(h('button', { class: 'btn btn-primary rd-btn', type: 'button', onclick: openNfc },
        'Scanner une étiquette NFC'));
    }
    if (qrOk) {
      buttons.push(h('button', { class: `btn ${nfcOk ? '' : 'btn-primary '}rd-btn`, type: 'button', onclick: openQr },
        'Scanner un QR code'));
    }
    buttons.push(h('button', { class: `btn ${nfcOk || qrOk ? '' : 'btn-primary '}rd-btn`, type: 'button',
      onclick: openManual }, 'Saisir le code'));
    buttons.push(h('button', { class: 'btn btn-quiet rd-btn', type: 'button',
      onclick: () => openLogbook({ checkpoint: last }) }, 'Main courante'));
    setChildren(actions, buttons);
  }

  // ---- Interrogation du serveur ----------------------------------------------------------------------------------

  async function updatePending() {
    try {
      const items = await queue.pending();
      const count = items.filter((i) => i.kind === 'scan').length;
      if (count !== pendingScans) {
        pendingScans = count;
        render();
      }
    } catch {
      // la file n'est pas lisible : on garde le dernier chiffre
    }
  }

  function refresh() {
    if (inflight) return inflight;
    lastFetchAt = Date.now();
    inflight = (async () => {
      const res = await api('/api/agent/runs');
      if (res.ok && Array.isArray(res.data?.runs)) {
        runs = res.data.runs;
        runsAt = Date.now();
        offline = false;
        loadError = null;
        local.set(RUNS_KEY, { runs, at: runsAt });
      } else if (res.network) {
        offline = true;
      } else if (res.status !== 401) {
        loadError = res.error ?? 'Liste des rondes indisponible';
      }
      render();
      await updatePending();
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function tick() {
    const every = active ? POLL_FAST_MS : POLL_SLOW_MS;
    if (Date.now() - lastFetchAt >= every - 100) void refresh();
    else {
      render();
      void updatePending();
    }
  }

  function start() {
    stop();
    const saved = local.get(RUNS_KEY, null);
    if (saved && Array.isArray(saved.runs)) {
      runs = saved.runs;
      runsAt = Number(saved.at) || 0;
    }
    buildActions();
    render();
    timer = setInterval(tick, TICK_MS);
    void refresh();
  }

  function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    closeScan();
    closeSheet();
    closeConfirm();
  }

  function setActive(value) {
    const was = active;
    active = Boolean(value);
    if (active && !was) void refresh();
  }

  // ---- Confirmation plein ecran ----------------------------------------------------------------------------------

  function closeConfirm() {
    if (confirmTimer !== null) clearTimeout(confirmTimer);
    confirmTimer = null;
    confirmEl?.remove();
    confirmEl = null;
  }

  /** tone : 'ok' | 'warn' | 'error'. */
  function showConfirm({ tone, title, point, detail }) {
    closeConfirm();
    const icon = tone === 'ok' ? '✓' : tone === 'warn' ? '!' : '✕';
    confirmEl = h('div', {
      class: `overlay rd-confirm rd-confirm-${tone}`, role: 'alertdialog', 'aria-live': 'assertive',
      'aria-label': title, tabindex: '-1', onclick: closeConfirm,
    },
    h('div', { class: 'rd-confirm-icon', 'aria-hidden': 'true', text: icon }),
    h('p', { class: 'rd-confirm-title', text: title }),
    point ? h('p', { class: 'rd-confirm-point', text: point }) : null,
    detail ? h('p', { class: 'rd-confirm-detail', text: detail }) : null,
    h('p', { class: 'rd-confirm-hint', text: 'Touchez pour fermer' }));
    document.body.append(confirmEl);
    confirmTimer = setTimeout(closeConfirm, CONFIRM_MS);
  }

  // ---- Enregistrer un passage --------------------------------------------------------------------------------------

  async function submitCode(code, method) {
    const clean = parseCheckpointCode(code);
    if (!clean) {
      toast('Code non reconnu : 10 lettres et chiffres', 'error');
      return;
    }
    const now = Date.now();
    if (shouldIgnoreRepeat(lastCode, lastCodeAt, clean, now)) return;
    lastCode = clean;
    lastCodeAt = now;

    let result;
    try {
      result = await queue.submit('scan', { clientId: uuid(), code: clean, method, phoneAt: now },
        { username: getUser() });
    } catch {
      result = { sent: false, error: 'Enregistrement impossible' };
    }

    const scan = result.sent ? result.response?.scan : null;
    if (result.sent && scan) {
      const point = scan.checkpoint?.name ?? '';
      const prog = scan.run ? runProgress(scan.run) : null;
      const verdict = describeVerdict(scan.verdict, { next: scan.run ? nextCheckpoint(scan.run) : null });
      if (scan.checkpoint && (scan.verdict === 'ok' || scan.verdict === 'duplicate')) {
        last = { id: scan.checkpoint.id, name: scan.checkpoint.name };
      }
      if (verdict.tone === 'ok') {
        vibrate([120]);
        beep('ok');
      } else {
        vibrate([80, 60, 80]);
        beep('warning');
      }
      showConfirm({
        tone: verdict.tone,
        title: verdict.text,
        point: scan.verdict === 'out_of_order' ? '' : point,
        detail: prog && prog.total > 0 && scan.verdict === 'ok' ? `${prog.done} / ${prog.total}` : '',
      });
    } else if (result.sent) {
      // reponse sans detail (serveur ancien) : le passage est parti, on le dit simplement
      vibrate([120]);
      beep('ok');
      showConfirm({ tone: 'ok', title: 'Passage envoyé' });
    } else if (result.rejected) {
      beep('error');
      showConfirm({ tone: 'error', title: result.error || 'Passage refusé' });
    } else {
      vibrate([120]);
      beep('ok');
      showConfirm({ tone: 'ok', title: 'Enregistré — sera envoyé dès que le réseau revient' });
    }
    void refresh();
  }

  // ---- Scan NFC / QR ---------------------------------------------------------------------------------------------

  function closeScan() {
    if (!scanOverlay) return;
    scanOverlay.controller.abort(); // coupe la camera / l'ecoute NFC
    scanOverlay.el.remove();
    scanOverlay = null;
  }

  function openScanOverlay(kind) {
    closeScan();
    closeSheet();
    const controller = new AbortController();
    const message = h('p', { class: 'rd-scan-text', 'aria-live': 'polite',
      text: kind === 'nfc' ? 'Approchez le téléphone de l’étiquette' : 'Placez le QR code dans le cadre' });
    const video = kind === 'qr' ? h('video', { class: 'rd-video', playsinline: true, muted: true, autoplay: true }) : null;
    if (video) video.muted = true; // l'attribut seul ne suffit pas partout
    const cancel = h('button', { class: 'btn rd-btn rd-scan-cancel', type: 'button', onclick: closeScan }, 'Annuler');
    const overlay = h('div', { class: `overlay rd-scan rd-scan-${kind}`, role: 'dialog', 'aria-modal': 'true',
      'aria-label': kind === 'nfc' ? 'Lecture NFC' : 'Lecture du QR code' },
    video,
    kind === 'qr' ? h('div', { class: 'rd-frame', 'aria-hidden': 'true' }) : h('div', { class: 'rd-nfc-wave', 'aria-hidden': 'true', text: 'NFC' }),
    message,
    cancel);
    scanOverlay = { el: overlay, controller };
    document.body.append(overlay);

    const onCode = (code) => {
      if (controller.signal.aborted) return;
      closeScan();
      void submitCode(code, kind);
    };
    const onError = (err) => {
      if (controller.signal.aborted) return;
      message.textContent = kind === 'nfc'
        ? 'Lecture NFC impossible. Essayez la saisie du code.'
        : 'Caméra indisponible. Autorisez-la, ou saisissez le code.';
      if (err) message.dataset.detail = String(err?.message ?? err);
    };
    const params = kind === 'nfc' ? { onCode, onError, signal: controller.signal }
      : { video, onCode, onError, signal: controller.signal };
    const starter = kind === 'nfc' ? startNfcScan : startQrScan;
    Promise.resolve(starter(params)).catch(onError);
  }

  function openNfc() {
    openScanOverlay('nfc');
  }
  function openQr() {
    openScanOverlay('qr');
  }

  // ---- Saisie du code -------------------------------------------------------------------------------------------

  function closeSheet() {
    sheetEl?.remove();
    sheetEl = null;
  }

  function openManual() {
    closeSheet();
    const error = h('p', { class: 'rd-error', role: 'alert', text: '' });
    const input = h('input', { class: 'input rd-code', type: 'text', inputmode: 'text', maxlength: 11,
      autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Code de l’étiquette',
      placeholder: 'ABCDE 23456' });
    const form = h('form', { class: 'sheet rd-sheet stack', novalidate: true,
      onsubmit: (ev) => {
        ev.preventDefault();
        const code = parseCheckpointCode(input.value);
        if (!code) {
          error.textContent = 'Code non reconnu : 10 lettres et chiffres';
          input.focus();
          return;
        }
        closeSheet();
        void submitCode(code, 'manual');
      } },
    h('h2', { class: 'card-title', text: 'Saisir le code' }),
    h('label', { class: 'field' },
      h('span', { text: 'Code imprimé sur l’étiquette (10 lettres et chiffres)' }),
      input),
    error,
    h('div', { class: 'stack' },
      h('button', { class: 'btn btn-primary rd-btn', type: 'submit' }, 'Valider le passage'),
      h('button', { class: 'btn rd-btn', type: 'button', onclick: closeSheet }, 'Annuler')));
    sheetEl = h('div', { class: 'overlay rd-sheet-wrap', role: 'dialog', 'aria-modal': 'true',
      'aria-label': 'Saisie du code' }, form);
    document.body.append(sheetEl);
    input.focus();
  }

  return {
    el,
    start,
    stop,
    setActive,
    refresh,
    submitCode,
    lastCheckpoint: () => (last ? { ...last } : null),
  };
}
