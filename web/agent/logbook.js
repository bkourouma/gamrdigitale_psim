// Application des agents : main courante (observation libre, categorie, point de ronde, photo facultative).
// Aucun acces au DOM a l'import : ce fichier est aussi importe par les tests de node:test.
import { h, setChildren, uuid } from './util.js';
import { reducePhoto } from './photo.js';

export const CATEGORIES = [
  { id: 'anomaly', label: 'Anomalie' },
  { id: 'damage', label: 'Dégradation' },
  { id: 'visitor', label: 'Visiteur' },
  { id: 'other', label: 'Autre' },
];
export const MAX_TEXT = 1000;
export const MIN_TEXT = 3;

/**
 * Partie pure : valide la saisie et construit le corps de POST /api/agent/logbook.
 * Retourne { ok: true, payload } ou { ok: false, error } (message en francais).
 */
export function buildLogbookPayload({ category, text, checkpointId, photoBase64, clientId, now } = {}) {
  if (!CATEGORIES.some((c) => c.id === category)) return { ok: false, error: 'Choisissez d’abord le type de la main courante.' };
  const clean = typeof text === 'string' ? text.trim() : '';
  if (clean.length < MIN_TEXT) return { ok: false, error: `Écrivez au moins ${MIN_TEXT} caractères.` };
  if (clean.length > MAX_TEXT) return { ok: false, error: `Le texte est trop long (${MAX_TEXT} caractères au plus).` };
  const payload = {
    clientId: clientId || uuid(),
    category,
    text: clean,
    phoneAt: now ?? Date.now(),
  };
  if (typeof checkpointId === 'string' && checkpointId !== '') payload.checkpointId = checkpointId;
  else if (typeof checkpointId === 'number') payload.checkpointId = checkpointId;
  if (typeof photoBase64 === 'string' && photoBase64 !== '') payload.photo = photoBase64;
  return { ok: true, payload };
}

/** Fabrique l'ecran « Main courante » : { el, open({ checkpoint }), close() }. */
export function createLogbook({ queue, toast, getUser, getLastCheckpoint }) {
  let category = null;
  let checkpoint = null; // { id, name } propose
  let attach = true; // rattache au point ?
  let photo = null; // { base64, previewUrl }
  let reducing = false;
  let sending = false;
  let photoToken = 0;
  let confirming = false;

  const choiceInputs = [];
  const choices = CATEGORIES.map((c) => {
    const input = h('input', { type: 'radio', name: 'lb-category', value: c.id, class: 'lb-radio', onChange: () => { category = c.id; render(); } });
    choiceInputs.push(input);
    return h('label', { class: 'lb-choice' }, input, h('span', { class: 'lb-mark', 'aria-hidden': 'true' }), h('span', { class: 'lb-choice-text', text: c.label }));
  });

  const textarea = h('textarea', { class: 'input lb-text', rows: '5', maxlength: String(MAX_TEXT), placeholder: 'Que s’est-il passé ? Où ?', 'aria-label': 'Description', onInput: () => render() });
  const counter = h('div', { class: 'lb-counter muted', 'aria-live': 'off' });
  const errorBox = h('div', { class: 'lb-error', role: 'alert', hidden: true });
  const attachBox = h('div', { class: 'lb-attach' });
  const photoBox = h('div', { class: 'lb-photo' });
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'lb-file', tabindex: '-1', 'aria-hidden': 'true', onChange: () => onFile() });
  const actions = h('div', { class: 'lb-actions' });

  const sheet = h('div', { class: 'sheet lb-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lb-title' },
    h('h2', { class: 'screen-title', id: 'lb-title', text: 'Main courante' }),
    h('div', { class: 'lb-group', role: 'radiogroup', 'aria-label': 'Type' }, choices),
    attachBox,
    h('div', { class: 'field' }, textarea, counter),
    photoBox,
    fileInput,
    errorBox,
    actions);
  const el = h('div', { class: 'overlay lb-root', hidden: true }, sheet);

  function showError(message) {
    errorBox.hidden = !message;
    errorBox.textContent = message ?? '';
  }

  function revokePhoto() {
    if (photo?.previewUrl) URL.revokeObjectURL(photo.previewUrl);
    photo = null;
  }

  async function onFile() {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    const token = ++photoToken;
    reducing = true;
    showError(null);
    render();
    try {
      const result = await reducePhoto(file);
      if (token !== photoToken) {
        URL.revokeObjectURL(result.previewUrl);
        return;
      }
      revokePhoto();
      photo = { base64: result.base64, previewUrl: result.previewUrl };
    } catch (err) {
      if (token === photoToken) showError(err?.message ?? 'Photo illisible.');
    } finally {
      if (token === photoToken) {
        reducing = false;
        render();
      }
    }
  }

  function render() {
    const len = textarea.value.length;
    counter.textContent = `${len} / ${MAX_TEXT}`;

    setChildren(attachBox, checkpoint
      ? h('label', { class: 'lb-attach-label' },
          h('input', { type: 'checkbox', class: 'lb-check', checked: attach, onChange: (e) => { attach = e.target.checked; render(); } }),
          h('span', { text: attach ? `Au point : ${checkpoint.name}` : `Ne pas rattacher à « ${checkpoint.name} »` }))
      : null);

    setChildren(photoBox,
      photo ? h('img', { class: 'lb-preview', src: photo.previewUrl, alt: 'Photo jointe' }) : null,
      reducing ? h('div', { class: 'lb-status', role: 'status', text: 'Préparation de la photo…' }) : null,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn grow', disabled: reducing || sending, onClick: () => fileInput.click(), text: photo ? 'Reprendre la photo' : 'Prendre une photo' }),
        photo ? h('button', { type: 'button', class: 'btn btn-quiet', disabled: sending, onClick: () => { revokePhoto(); render(); }, text: 'Retirer la photo' }) : null));

    if (confirming) {
      setChildren(actions,
        h('p', { class: 'lb-confirm', text: 'Abandonner ce que vous avez écrit ?' }),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn btn-danger grow', onClick: close, text: 'Oui, abandonner' }),
          h('button', { type: 'button', class: 'btn grow', onClick: () => { confirming = false; render(); }, text: 'Non, continuer' })));
      return;
    }
    const ready = category !== null && textarea.value.trim().length >= MIN_TEXT;
    setChildren(actions, h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn grow', disabled: sending, onClick: onCancel, text: 'Annuler' }),
      h('button', { type: 'button', class: 'btn btn-primary grow', disabled: reducing || sending || !ready, onClick: onSend, text: sending ? 'Envoi…' : 'Envoyer' })));
  }

  function onCancel() {
    if (textarea.value.trim() !== '' || photo) {
      confirming = true;
      render();
    } else {
      close();
    }
  }

  async function onSend() {
    if (sending || reducing) return;
    const built = buildLogbookPayload({
      category,
      text: textarea.value,
      checkpointId: checkpoint && attach ? checkpoint.id : undefined,
      photoBase64: photo?.base64,
    });
    if (!built.ok) {
      showError(built.error);
      return;
    }
    showError(null);
    sending = true;
    render();
    try {
      const res = await queue.submit('logbook', built.payload, { username: getUser() });
      if (res?.rejected) {
        showError(res.error || 'Le serveur a refusé cette main courante.');
      } else if (res?.sent) {
        toast('Main courante enregistrée ✓');
        close();
      } else {
        toast('Enregistrée sur le téléphone : envoi dès que le réseau revient');
        close();
      }
    } catch {
      showError('Envoi impossible pour le moment. Votre texte est conservé, réessayez.');
    } finally {
      sending = false;
      if (!el.hidden) render();
    }
  }

  function open({ checkpoint: given } = {}) {
    photoToken++;
    revokePhoto();
    reducing = false;
    sending = false;
    confirming = false;
    category = null;
    for (const input of choiceInputs) input.checked = false;
    textarea.value = '';
    checkpoint = given ?? getLastCheckpoint?.() ?? null;
    attach = true;
    showError(null);
    render();
    el.hidden = false;
    textarea.scrollTop = 0;
  }

  function close() {
    photoToken++;
    revokePhoto();
    reducing = false;
    confirming = false;
    el.hidden = true;
  }

  return { el, open, close };
}
