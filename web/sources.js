// Sources d'alarme autres que l'incendie : intrusion, contrôle d'accès, environnement.
// Libellés, simulateur et réglages d'un capteur (catégorie, seuils, supervision).

export const CATEGORIES = ['fire', 'intrusion', 'access', 'environment'];

export const CATEGORY_LABEL = {
  fire: 'Incendie',
  intrusion: 'Intrusion',
  access: "Contrôle d'accès",
  environment: 'Environnement',
};

/** Lettre affichée sur la pastille du plan. */
export const CATEGORY_GLYPH = { fire: 'D', intrusion: 'I', access: 'A', environment: 'E' };

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

// Boutons du simulateur : ce qu'un équipement réel de cette catégorie enverrait.
const SIM_EVENTS = {
  intrusion: [
    ['motion', 'Mouvement'],
    ['tamper', 'Sabotage'],
    ['clear', 'Calme'],
  ],
  access: [
    ['door_held_open', 'Porte ouverte'],
    ['door_forced', 'Forcée'],
    ['door_closed', 'Fermée'],
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

export function createSimControls({ api, h, toast }) {
  const send = (id, body) => api(`/api/sim/detectors/${encodeURIComponent(id)}`, { method: 'POST', body }).catch((e) => toast(e.message));

  /** Une ligne du simulateur pour un détecteur. */
  return function simRow(d) {
    const controls = [];
    if (d.category === 'fire') {
      for (const [state, label] of SIM_STATES) {
        controls.push(h('button', { class: `btn tiny${d.status === state ? ' active' : ''}`, type: 'button', text: label, onclick: () => send(d.id, { state }) }));
      }
    } else {
      for (const [event, label] of SIM_EVENTS[d.category] ?? []) {
        controls.push(h('button', { class: 'btn tiny', type: 'button', text: label, title: `Événement « ${event} »`, onclick: () => send(d.id, { event }) }));
      }
      if (d.alarmAt !== null) {
        const input = h('input', { type: 'number', step: 'any', class: 'sim-value', 'aria-label': `Mesure de ${d.id}`, placeholder: d.valueUnit || 'valeur' });
        controls.push(
          input,
          h('button', {
            class: 'btn tiny',
            type: 'button',
            text: 'Mesure',
            onclick: () => (input.value === '' ? toast('Saisissez une valeur') : send(d.id, { value: Number(input.value) })),
          }),
        );
      }
    }
    return h(
      'div',
      { class: 'sim-row' },
      h('span', { class: `dot ${d.status}` }),
      h('span', { class: 'sim-name', text: `${d.id} ${d.name}${d.lastValue !== null ? ` (${formatValue(d.lastValue, d.valueUnit)})` : ''}` }),
      ...controls,
    );
  };
}

const numberOrNull = (text) => (text.trim() === '' ? null : Number(text.replace(',', '.')));

/**
 * Réglages d'un détecteur dans l'éditeur d'inventaire : catégorie, mesure (unité, seuils, sens),
 * supervision. `onSaved` est rappelé après un enregistrement réussi.
 */
export function buildSensorForm(d, { api, h, toast }) {
  const category = h('select', { 'aria-label': 'Catégorie' }, ...CATEGORIES.map((c) => h('option', { value: c, text: CATEGORY_LABEL[c] })));
  category.value = d.category;
  const unit = h('input', { value: d.valueUnit ?? '', maxlength: '12', placeholder: 'Unité (°C, %…)', 'aria-label': 'Unité de mesure' });
  const direction = h('select', { 'aria-label': 'Sens du dépassement' }, h('option', { value: 'above', text: 'Alarme si trop haut' }), h('option', { value: 'below', text: 'Alarme si trop bas' }));
  direction.value = d.direction;
  const warn = h('input', { value: d.warnAt ?? '', inputmode: 'decimal', placeholder: 'Seuil de préalarme', 'aria-label': 'Seuil de préalarme' });
  const alarm = h('input', { value: d.alarmAt ?? '', inputmode: 'decimal', placeholder: "Seuil d'alarme", 'aria-label': "Seuil d'alarme" });
  const heartbeat = h('input', {
    value: d.heartbeatS === null ? '' : String(d.heartbeatS),
    inputmode: 'numeric',
    placeholder: 'général',
    'aria-label': 'Supervision en secondes',
    title: "Secondes sans message avant « hors ligne ». Vide : délai général. 0 : non supervisé (un contact de porte n'émet qu'aux changements).",
  });
  const msg = h('p', { class: 'small', role: 'status' });

  const save = async () => {
    try {
      const hb = heartbeat.value.trim();
      await api(`/api/devices/${encodeURIComponent(d.id)}`, {
        method: 'PATCH',
        body: {
          category: category.value,
          valueUnit: unit.value.trim() || null,
          direction: direction.value,
          warnAt: numberOrNull(warn.value),
          alarmAt: numberOrNull(alarm.value),
          heartbeatS: hb === '' ? null : Number(hb),
        },
      });
      msg.textContent = '';
      toast('Réglages enregistrés', 'ok');
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'small error';
    }
  };

  return h(
    'div',
    { class: 'sensor-form' },
    h('p', { class: 'small muted', text: 'Ce que surveille ce détecteur, et comment lire ses mesures :' }),
    h('div', { class: 'row wrap' }, category, unit, direction),
    h('div', { class: 'row wrap' }, h('label', { class: 'small' }, 'Préalarme à ', warn), h('label', { class: 'small' }, 'Alarme à ', alarm)),
    h(
      'label',
      { class: 'small' },
      'Signe de vie attendu toutes les (s) ',
      heartbeat,
    ),
    h('p', { class: 'small muted', text: "Sans seuil, les mesures sont seulement affichées. Seuls les messages « state », « event » ou « value » sont acceptés (MQTT psim/detectors/<id>/state, ou HTTP /api/ingest/<id>)." }),
    h('button', { class: 'btn small', type: 'button', text: 'Enregistrer les réglages', onclick: save }),
    msg,
  );
}
