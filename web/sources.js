/**
 * Sources d'alarme autres que l'incendie : intrusion, contrôle d'accès, environnement. Libellés partagés, réglages de
 * mesure d'un détecteur (éditeur de l'écran Équipements et plan) et commandes du Simulateur.
 *
 * On y trouve aussi les petits outils de formulaire communs aux panneaux de l'écran Équipements (champ étiqueté avec
 * aide et erreur, message d'état, bouton occupé, champs « modifiés et pas encore enregistrés ») : equipment.js et
 * detsource.js s'en servent, ils ne s'importent pas l'un l'autre.
 */
import { h, icon, api, toast } from './core.js';

export const CATEGORIES = ['fire', 'intrusion', 'access', 'environment'];

export const CATEGORY_LABEL = {
  fire: 'Incendie',
  intrusion: 'Intrusion',
  access: "Contrôle d’accès",
  environment: 'Environnement',
};

// La qualification « fire » est stockée telle quelle pour toutes les catégories : elle veut dire « événement réel ».
const REAL_LABEL = {
  fire: 'Feu confirmé',
  intrusion: 'Intrusion avérée',
  access: 'Accès anormal avéré',
  environment: 'Incident avéré',
};

export function qualificationLabel(category, qualification) {
  if (qualification === 'false_alarm') return 'Fausse alarme';
  if (qualification === 'fire') return REAL_LABEL[category] ?? REAL_LABEL.fire;
  return '';
}

export const realEventLabel = (category) => REAL_LABEL[category] ?? REAL_LABEL.fire;

export function formatValue(value, unit) {
  if (value === null || value === undefined) return '';
  const rounded = Math.round(value * 100) / 100;
  return `${rounded.toLocaleString('fr-FR')}${unit ? ` ${unit}` : ''}`;
}

// ---------------------------------------------------------------- outils de formulaire (écran Équipements)

let uid = 0;

/**
 * Champ étiqueté : libellé visible, aide facultative et emplacement d'erreur, reliés au champ (aria-describedby).
 * Un <div> et non un <label> englobant : sinon l'aide et l'erreur feraient partie du nom lu du champ.
 */
export function field(label, input, hint) {
  if (!input.id) input.id = `eq-field-${++uid}`;
  const hintEl = hint ? h('span', { class: 'hint', id: `${input.id}-hint` }, hint) : null;
  const error = h('span', { class: 'form-error', id: `${input.id}-error`, hidden: true });
  input.setAttribute('aria-describedby', [hintEl?.id, error.id].filter(Boolean).join(' '));
  return h('div', { class: 'field' }, h('label', { for: input.id, text: label }), input, hintEl, error);
}

/** Erreur d'un champ : écrite sous le champ, annoncée, le champ marqué invalide. Sans message : l'erreur est effacée. */
export function setFieldError(input, message = '') {
  const error = document.getElementById(`${input.id}-error`);
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
}

export function clearFieldErrors(root) {
  for (const el of root.querySelectorAll('[aria-invalid="true"]')) setFieldError(el);
}

const STATUS_ICON = { ok: 'state-ok', error: 'state-alarm', info: 'info' };

/** Ligne d'état d'une section (en cours, réussi, échec) : icône + texte, lue par les lecteurs d'écran. */
export function statusLine(attrs = {}) {
  return h('p', { class: 'form-status', role: 'status', ...attrs });
}

/** kind : 'busy' (en cours), 'ok', 'error', 'info' ; texte vide : la ligne disparaît. */
export function setStatus(el, kind, text = '') {
  el.className = `form-status${kind ? ` is-${kind}` : ''}`;
  // Espace insécable avant « : » : la ligne ne se coupe pas juste avant les deux-points.
  const shown = text.replace(/ :/g, ' :');
  el.replaceChildren(...(text && STATUS_ICON[kind] ? [icon(STATUS_ICON[kind], 'icon-sm')] : []), ...(text ? [h('span', { text: shown })] : []));
}

/**
 * Bouton occupé le temps d'une requête : roue à la place du texte, second clic impossible. `aria-busy` sert aussi de
 * signal à l'éditeur : on ne le reconstruit pas tant qu'une opération y est en cours.
 */
export async function withBusy(button, task) {
  if (button.classList.contains('is-busy')) return undefined;
  button.classList.add('is-busy');
  button.setAttribute('aria-busy', 'true');
  try {
    return await task();
  } finally {
    button.classList.remove('is-busy');
    button.removeAttribute('aria-busy');
  }
}

/** Choix d'une liste, retenu comme valeur « enregistrée » (référence pour savoir si l'utilisateur l'a changé). */
export function pick(select, value) {
  select.value = value;
  for (const option of select.options) option.defaultSelected = option.selected;
}

/** Vrai si un champ du conteneur diffère de sa valeur enregistrée (frappe, case cochée, autre choix). */
export function isDirty(root) {
  for (const el of root.querySelectorAll('input, select, textarea')) {
    if (el.closest('[data-transient]')) continue; // champs d'essai (mesure du simulateur, voie proposée…)
    if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked !== el.defaultChecked) return true;
    } else if (el.tagName === 'SELECT') {
      const saved = [...el.options].find((o) => o.defaultSelected) ?? el.options[0];
      if (saved && el.value !== saved.value) return true;
    } else if (el.type !== 'file' && el.value !== el.defaultValue) return true;
  }
  return false;
}

/** Après un enregistrement réussi : les valeurs affichées deviennent la référence (plus rien « en cours »). */
export function markSaved(root) {
  for (const el of root.querySelectorAll('input, select, textarea')) {
    if (el.type === 'checkbox' || el.type === 'radio') el.defaultChecked = el.checked;
    else if (el.tagName === 'SELECT') for (const option of el.options) option.defaultSelected = option.selected;
    else if (el.type !== 'file') el.defaultValue = el.value;
  }
}

/** Nombre saisi « à la française » (virgule acceptée) ; vide -> null ; illisible -> NaN. */
const numberOrNull = (text) => (text.trim() === '' ? null : Number(text.trim().replace(',', '.')));

// ---------------------------------------------------------------- simulateur

// Boutons du simulateur : ce qu'un équipement réel de cette catégorie enverrait.
const SIM_EVENTS = {
  intrusion: [
    ['motion', 'Mouvement'],
    ['tamper', 'Sabotage'],
    ['clear', 'Calme'],
  ],
  access: [
    ['door_held_open', 'Porte ouverte'],
    ['door_forced', 'Porte forcée'],
    ['door_closed', 'Porte fermée'],
  ],
  environment: [
    ['leak', 'Fuite'],
    ['dry', 'Sec'],
  ],
};

const SIM_STATES = [
  ['normal', 'Normal'],
  ['prealarm', 'Préalarme'],
  ['alarm', 'Alarme'],
  ['fault', 'Défaut'],
];

/**
 * Commandes du simulateur pour un détecteur : les états (incendie) ou les événements (autres catégories) qu'un vrai
 * détecteur enverrait, et une mesure à envoyer s'il a un seuil d'alarme. Rend un élément à placer dans sa ligne.
 */
export function createSimControls() {
  const send = (button, id, body) =>
    withBusy(button, () => api(`/api/sim/detectors/${encodeURIComponent(id)}`, { method: 'POST', body })).catch((e) => toast(`${id} : ${e.message}`));

  return function simControls(d) {
    const buttons = [];
    if (d.category === 'fire') {
      for (const [state, label] of SIM_STATES) {
        const b = h('button', {
          class: 'btn btn-sm',
          type: 'button',
          text: label,
          'aria-pressed': String(d.status === state),
          title: `Envoie l’état « ${label} », comme le ferait le détecteur ${d.id}.`,
          dataset: { action: `state-${state}` },
        });
        b.addEventListener('click', () => send(b, d.id, { state }));
        buttons.push(b);
      }
    } else {
      for (const [event, label] of SIM_EVENTS[d.category] ?? []) {
        const b = h('button', { class: 'btn btn-sm', type: 'button', text: label, title: `Envoie l’événement « ${label} », comme le ferait le détecteur ${d.id}.`, dataset: { action: `event-${event}` } });
        b.addEventListener('click', () => send(b, d.id, { event }));
        buttons.push(b);
      }
    }
    const group = h('div', { class: 'sim-buttons', role: 'group', 'aria-label': `${d.category === 'fire' ? 'État' : 'Événement'} à envoyer pour ${d.id}` }, ...buttons);
    if (d.alarmAt === null) return h('div', { class: 'sim-controls' }, group);

    // Capteur à mesure : une valeur à envoyer (le seuil d'alarme est rappelé pour savoir quoi saisir).
    const input = h('input', {
      class: 'input-sm sim-value',
      inputmode: 'decimal',
      autocomplete: 'off',
      id: `sim-value-${d.id}`,
      placeholder: String(d.alarmAt).replace('.', ','),
      dataset: { action: 'value' },
    });
    const sendValue = h('button', { class: 'btn btn-sm', type: 'button', text: 'Envoyer', dataset: { action: 'send-value' } });
    const go = () => {
      const value = numberOrNull(input.value);
      if (value === null || Number.isNaN(value)) {
        input.setAttribute('aria-invalid', 'true');
        input.addEventListener('input', () => input.removeAttribute('aria-invalid'), { once: true });
        input.focus();
        return toast(`Saisissez une mesure pour ${d.id}, par exemple ${formatValue(d.alarmAt, d.valueUnit)}`);
      }
      input.removeAttribute('aria-invalid');
      send(sendValue, d.id, { value });
    };
    sendValue.addEventListener('click', go);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), go()));
    return h(
      'div',
      { class: 'sim-controls' },
      group,
      h(
        'div',
        { class: 'sim-measure' },
        h('label', { for: input.id, text: `Mesure${d.valueUnit ? ` (${d.valueUnit})` : ''}` }),
        input,
        sendValue,
        h('span', { class: 'hint', text: `alarme à ${formatValue(d.alarmAt, d.valueUnit)}${d.warnAt !== null ? `, préalarme à ${formatValue(d.warnAt, d.valueUnit)}` : ''}` }),
      ),
    );
  };
}

// ---------------------------------------------------------------- réglages de mesure d'un détecteur

export const CATEGORY_HINT = {
  fire: 'Alarme à toute heure. Pastille ronde sur le plan.',
  intrusion: "Suit l’armement de sa zone (planning de nuit). Peut lire la détection d’un enregistreur vidéo Dahua.",
  access: 'Porte forcée ou restée ouverte : alarme à toute heure.',
  environment: 'Fuite, température… : alarme à toute heure, avec des seuils si le capteur envoie une mesure.',
};

/**
 * Réglages d'un détecteur dans l'éditeur : catégorie, mesure (unité, sens, seuils) et délai de silence avant
 * « hors ligne ». Vérifiés ici avec les mêmes règles que le serveur, pour dire tout de suite quel champ corriger.
 */
export function buildSensorForm(d) {
  const category = h('select', {}, ...CATEGORIES.map((c) => h('option', { value: c, text: CATEGORY_LABEL[c] })));
  pick(category, d.category);
  const categoryHint = h('span', { text: CATEGORY_HINT[d.category] ?? '' });
  category.addEventListener('change', () => (categoryHint.textContent = CATEGORY_HINT[category.value] ?? ''));
  const unit = h('input', { value: d.valueUnit ?? '', maxlength: '12', placeholder: '°C, %…', autocomplete: 'off' });
  const direction = h('select', {}, h('option', { value: 'above', text: 'Trop haute (ex. température)' }), h('option', { value: 'below', text: 'Trop basse (ex. pression)' }));
  pick(direction, d.direction);
  const warn = h('input', { value: d.warnAt === null ? '' : String(d.warnAt).replace('.', ','), inputmode: 'decimal', placeholder: 'aucune', autocomplete: 'off' });
  const alarm = h('input', { value: d.alarmAt === null ? '' : String(d.alarmAt).replace('.', ','), inputmode: 'decimal', placeholder: 'aucune', autocomplete: 'off' });
  const heartbeat = h('input', { value: d.heartbeatS === null ? '' : String(d.heartbeatS), inputmode: 'numeric', placeholder: 'délai général', autocomplete: 'off' });
  const status = statusLine();
  const submit = h('button', { class: 'btn', type: 'submit', text: 'Enregistrer les réglages' });

  const form = h(
    'form',
    { class: 'sensor-form', novalidate: true },
    field('Catégorie', category, categoryHint),
    h(
      'fieldset',
      { class: 'eq-fieldset' },
      h('legend', { text: 'Mesure (facultatif)' }),
      h('p', { class: 'hint', text: 'Pour un capteur qui envoie une valeur. Sans seuil, la mesure est seulement affichée.' }),
      h(
        'div',
        { class: 'eq-grid' },
        field('Unité', unit),
        field('Alarme quand la mesure est', direction),
        field('Préalarme à', warn),
        field('Alarme à', alarm),
      ),
    ),
    field(
      'Hors ligne après un silence de (secondes)',
      heartbeat,
      "Vide : délai général du PSIM. 0 : jamais (un contact de porte n’envoie rien tant qu’elle reste fermée).",
    ),
    h(
      'details',
      { class: 'eq-details' },
      h('summary', { text: 'Pour l’installateur : comment ce détecteur envoie ses messages' }),
      h(
        'p',
        { class: 'hint' },
        'Le détecteur, ou sa passerelle, écrit au PSIM de deux façons : par MQTT (la messagerie des objets connectés) sur le sujet ',
        h('code', { text: `psim/detectors/${d.id}/state` }),
        ', ou par une requête HTTP vers ',
        h('code', { text: `/api/ingest/${d.id}` }),
        '. Trois messages sont compris : « state » (un état), « event » (un événement) et « value » (une mesure).',
      ),
    ),
    h('div', { class: 'actions' }, submit, status),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.classList.contains('is-busy')) return; // Entrée pendant l'envoi : un seul enregistrement
    clearFieldErrors(form);
    setStatus(status, '');
    const warnAt = numberOrNull(warn.value);
    const alarmAt = numberOrNull(alarm.value);
    const hb = heartbeat.value.trim();
    const problems = [];
    if (Number.isNaN(warnAt)) problems.push([warn, 'Nombre attendu, par exemple 30 ou 30,5.']);
    if (Number.isNaN(alarmAt)) problems.push([alarm, 'Nombre attendu, par exemple 38 ou 38,5.']);
    if (!Number.isNaN(warnAt) && warnAt !== null && alarmAt === null) problems.push([alarm, "Indiquez aussi le seuil d’alarme : une préalarme seule n’est pas possible."]);
    if (warnAt !== null && alarmAt !== null && !Number.isNaN(warnAt) && !Number.isNaN(alarmAt)) {
      const above = direction.value === 'above';
      if (above ? warnAt > alarmAt : warnAt < alarmAt) problems.push([warn, `La préalarme vient avant l’alarme : un seuil ${above ? 'inférieur ou égal' : 'supérieur ou égal'} à ${alarm.value.trim()}.`]);
    }
    if (hb !== '' && !(/^\d+$/.test(hb) && Number(hb) <= 604800)) problems.push([heartbeat, 'Nombre entier de secondes (0 à 604 800), ou vide.']);
    if (problems.length) {
      for (const [el, message] of problems) setFieldError(el, message);
      problems[0][0].focus();
      return;
    }
    setStatus(status, 'busy', 'Enregistrement…');
    try {
      await withBusy(submit, () =>
        api(`/api/devices/${encodeURIComponent(d.id)}`, {
          method: 'PATCH',
          body: { category: category.value, valueUnit: unit.value.trim() || null, direction: direction.value, warnAt, alarmAt, heartbeatS: hb === '' ? null : Number(hb) },
        }),
      );
      markSaved(form);
      setStatus(status, 'ok', 'Réglages enregistrés.');
    } catch (err) {
      setStatus(status, 'error', err.message);
    }
  });
  return form;
}
