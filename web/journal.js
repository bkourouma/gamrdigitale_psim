/**
 * Écran Journal : les dernières actions des personnes et du système (50 à l'ouverture, puis les nouvelles au fil de
 * l'eau, 100 au plus), filtrées par famille. Les entrées graves (journal altéré, notification ou sauvegarde en échec,
 * période sans surveillance) se détachent par la couleur ET une icône ET un mot lu (« Important »).
 */
import { qualificationLabel } from './sources.js';
import { $, h, icon, S, ACTION_LABEL, STATUS_LABEL, render } from './core.js';
import { confirmationText, hintText, dateTime, ariaTable } from './incidents.js';

/** Actions écrites par le serveur qui n'ont pas encore de libellé partagé (core.js). */
const MORE_LABEL = {
  logout: 'Déconnexion',
  login_locked: 'Connexion bloquée (trop d’essais)',
  login_2fa_failed: 'Code de double authentification refusé',
  device_flapping: 'Équipement instable',
  secret_key_mismatch: 'Clés de double authentification illisibles',
};
const actionLabel = (action) => ACTION_LABEL[action] ?? MORE_LABEL[action] ?? action;

/** Auteurs techniques écrits par le serveur, dits en français. */
const ACTOR_LABEL = { systeme: 'Système', detecteur: 'Détecteur' };

/** Famille de chaque action, pour le filtre segmenté. */
function groupOf(action) {
  if (/^(incident_|intrusion_ignored|snapshot_failed|notification_)/.test(action)) return 'alarms';
  if (/^(device_|floor_|plan_|links_|camera_|detector_|sim_trigger|zone_|arming_|risk_)/.test(action)) return 'equipment';
  if (/^(login|logout|user_|password_|totp_|recovery_|recipient_)/.test(action)) return 'accounts';
  return 'system';
}

/** Ce que chaque filtre montre : sert au message quand il n'y a rien (un vide qui apprend). */
const FILTERS = {
  all: { name: '', shows: 'Les alarmes, les équipements, les connexions et les contrôles du système s’inscrivent ici au fil de l’eau.' },
  alarms: { name: 'Alarmes', shows: 'Ouvertures, acquittements et clôtures d’alarmes, et alertes envoyées aux personnes prévenues.' },
  equipment: { name: 'Équipements', shows: 'Changements d’état des détecteurs, équipements ajoutés ou modifiés, armement des zones, évaluations de risque.' },
  accounts: { name: 'Comptes', shows: 'Connexions, comptes créés ou modifiés, mots de passe et double authentification.' },
  system: { name: 'Système', shows: 'Sauvegardes, contrôles du journal, supervision externe, rapports et périodes sans surveillance.' },
};

const GRAVE = new Set(['journal_integrity_failed', 'notification_failed', 'backup_failed', 'supervision_gap', 'report_email_failed', 'heartbeat_failing', 'secret_key_mismatch']);

let filter = 'all';

/** Détail d'un essai du simulateur (JSON du serveur) en français ; le texte brut est gardé s'il est illisible. */
function simText(raw) {
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return raw;
    const out = [];
    if (typeof p.state === 'string') out.push(`envoi de l’état ${STATUS_LABEL[p.state] ?? p.state}`);
    if (typeof p.event === 'string') out.push(`envoi de l’événement ${p.event}`);
    if (p.value !== undefined && p.value !== null) out.push(`envoi de la mesure ${p.value}`);
    return out.length ? out.join(', ') : raw;
  } catch {
    return raw;
  }
}

export function describe(entry) {
  const parts = [];
  if (entry.deviceId) parts.push(S.devices.get(entry.deviceId)?.name ?? entry.deviceId);
  if (entry.incidentId) parts.push(`incident n°${entry.incidentId}`);
  if (entry.details) {
    let text = entry.details;
    if (entry.action === 'detector_silent') text = entry.details.replace(/etait : (\w+)/, (_, s) => `était : ${STATUS_LABEL[s] ?? s}`);
    else if (entry.action === 'sim_trigger') text = simText(entry.details);
    else if (entry.action === 'incident_confirmed') text = `par ${confirmationText(entry.details)}`;
    else if (entry.action === 'incident_hint') text = hintText(entry.details);
    else if (entry.action === 'incident_opened') text = entry.details.replace(/(critical|warning)/g, (w) => (w === 'critical' ? 'critique' : 'avertissement'));
    else if (entry.action === 'device_state') text = entry.details.replace(/\w+/g, (w) => STATUS_LABEL[w] ?? w);
    else if (entry.details === 'fire' || entry.details === 'false_alarm') text = qualificationLabel(S.devices.get(entry.deviceId)?.category, entry.details);
    parts.push(text);
  }
  return parts.join(' · ');
}

function row(e) {
  const grave = GRAVE.has(e.action);
  return h(
    'tr',
    { class: grave ? 'is-grave' : '' },
    h('td', { class: 'num j-time', 'data-label': 'Heure' }, h('time', { datetime: new Date(e.ts).toISOString(), text: dateTime(e.ts) })),
    h(
      'td',
      { class: 'j-action', 'data-label': 'Action' },
      grave ? [icon('state-alarm', 'icon-sm'), h('span', { class: 'sr-only', text: 'Important : ' })] : null,
      h('span', { text: actionLabel(e.action) }),
    ),
    h('td', { class: 'j-detail', 'data-label': 'Détail', text: describe(e) || '—' }),
    h('td', { class: 'j-actor', 'data-label': 'Par', text: ACTOR_LABEL[e.actor] ?? e.actor }),
  );
}

export function renderJournal() {
  const entries = S.audit.filter((e) => filter === 'all' || groupOf(e.action) === filter);
  const empty = entries.length === 0;
  $('journal-empty').hidden = !empty;
  const table = $('journal-table');
  if (table) table.hidden = empty;
  if (empty) {
    const f = FILTERS[filter] ?? FILTERS.all;
    const what = f.name ? `Aucune action « ${f.name} »` : 'Aucune action';
    const among = S.audit.length ? ` parmi les ${S.audit.length} dernières.` : ' pour l’instant.';
    const text = $('journal-empty-text');
    if (text) text.replaceChildren(h('strong', { text: `${what}${among}` }), h('span', { text: f.shows }));
    else $('journal-empty').textContent = `${what}${among}`;
  }
  $('journal').replaceChildren(...entries.map(row));
  ariaTable($('journal').closest('table'));
}

for (const button of document.querySelectorAll('#journal-filter button')) {
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    for (const b of document.querySelectorAll('#journal-filter button')) b.setAttribute('aria-pressed', String(b === button));
    renderJournal();
  });
}

render.journal = renderJournal;
