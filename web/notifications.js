/**
 * Écran Personnes prévenues (administrateur) : état des envois (canaux, escalade, problèmes, derniers envois) et message
 * de test. Un message par problème, en tête : une zone sans destinataire, un destinataire qui ne reçoit plus rien…
 * La liste des destinataires et le formulaire d'ajout sont tenus par users.js.
 */
import { $, h, icon, api, hasUnsavedInput } from './core.js';
import { setBusy } from './account.js';
import { timeEl } from './system.js';

let loadRecipients = () => {};

/** Branche le chargement de la liste des destinataires (users.js), rafraîchie avec l'état des canaux. */
export function initNotifications(deps) {
  loadRecipients = deps.loadRecipients;
}

/**
 * Canaux d'envoi : un mot et une icône. Le sprite n'a pas encore d'enveloppe ni de bulle : e-mail et WhatsApp prennent
 * en attendant une icône proche (le mot porte le sens).
 */
export const CHANNEL = {
  email: { label: 'E-mail', icon: 'mail' },
  telegram: { label: 'Telegram', icon: 'send' },
  whatsapp: { label: 'WhatsApp', icon: 'chat' },
  callmebot: { label: 'WhatsApp (CallMeBot)', icon: 'chat' },
  webhook: { label: 'Autre logiciel', icon: 'external' },
};
const MAIN_CHANNELS = ['whatsapp', 'email', 'telegram', 'webhook'];

/** Canal : icône + mot. Accepte l'identifiant (« email ») ou le libellé du serveur (« E-mail »). */
export function channelTag(idOrLabel) {
  const c = CHANNEL[idOrLabel] ?? Object.values(CHANNEL).find((x) => x.label === idOrLabel) ?? { label: idOrLabel, icon: 'send' };
  return h('span', { class: 'adm-channel' }, icon(c.icon, 'icon-sm'), h('span', { text: c.label }));
}

const KIND_LABEL = {
  opened: 'Alarme',
  escalated: 'Alarme aggravée',
  confirmed: 'Alarme confirmée',
  unacked: 'Escalade : non acquittée',
  reminder: 'Rappel',
  silent: 'Détecteur muet',
  restart: 'Redémarrage du PSIM',
  integrity: 'Intégrité du journal',
  security: 'Alerte de sécurité',
  test: 'Message de test',
};

/** Durée courte en mots : « 45 s », « 3 min », « 1 min 30 s ». */
const fmtSeconds = (s) => (s < 60 ? `${s} s` : s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)} min ${s % 60} s`);
const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

/** Message en ligne : une icône, un titre court, une explication. */
function notice(kind, title, text = '') {
  const glyph = { alarm: 'state-alarm', warning: 'state-warning', ok: 'state-ok', info: 'info' }[kind];
  return h('div', { class: `notice is-${kind}` }, icon(glyph), h('span', {}, h('strong', { text: `${title}${text ? ' ' : ''}` }), text));
}

// ---------------------------------------------------------------- état des envois

function channelList(st) {
  const configured = new Map(st.channels.map((c) => [c.id, c]));
  const ids = [...MAIN_CHANNELS, ...(configured.has('callmebot') ? ['callmebot'] : [])];
  return h(
    'ul',
    { class: 'adm-channels', 'aria-label': 'Canaux' },
    ...ids.map((id) => {
      const c = configured.get(id);
      let state;
      if (!c) state = [h('span', { class: 'pill is-offline is-dashed' }, 'Non réglé'), h('span', { class: 'muted', text: 'à régler sur le PC du PSIM' })];
      else if (c.level1 + c.level2 === 0) state = [h('span', { class: 'pill is-dashed' }, 'Sans destinataire'), h('span', { class: 'muted', text: 'prêt à servir' })];
      else state = [h('span', { class: 'pill is-ok' }, icon('state-ok'), 'Actif'), h('span', { text: `${plural(c.level1, 'destinataire')} au niveau 1, ${c.level2} au niveau 2` })];
      return h('li', {}, channelTag(id), h('span', { class: 'adm-channel-state' }, ...state));
    }),
  );
}

function escalationText(st) {
  if (!(st.escalateAfterS > 0)) return "Escalade désactivée : le niveau 2 n’est jamais prévenu.";
  const reminders = st.maxReminders > 0 ? `, puis un rappel part toutes les ${fmtSeconds(st.reminderS)}, ${st.maxReminders} fois au plus` : '';
  return `Escalade : si une alarme n’est pas acquittée au bout de ${fmtSeconds(st.escalateAfterS)}, le niveau 2 est prévenu à son tour${reminders}.`;
}

let recentOpen = false; // « Derniers envois » reste ouvert d'un rafraîchissement à l'autre

function recentSends(list) {
  const details = h(
    'details',
    { class: 'adm-recent' },
    h('summary', {}, icon('chevron-right', 'icon-sm adm-chevron'), icon('history', 'icon-sm'), `Derniers envois (${list.length})`),
    h(
      'div',
      { class: 'table-scroll' },
      h(
        'table',
        { class: 'data adm-stack' },
        h('thead', {}, h('tr', {}, ...['Heure', 'Message', 'Canal', 'Destinataire', 'Niveau', 'Résultat'].map((t) => h('th', { text: t, scope: 'col' })))),
        h(
          'tbody',
          {},
          ...list.map((r) =>
            h(
              'tr',
              {},
              h('td', { 'data-label': 'Heure' }, timeEl(r.at)),
              h('td', { 'data-label': 'Message', text: KIND_LABEL[r.kind] ?? r.kind }),
              h('td', { 'data-label': 'Canal' }, channelTag(r.channel)),
              h('td', { 'data-label': 'Destinataire', class: 'adm-address', text: r.recipient }),
              h('td', { 'data-label': 'Niveau', class: 'num', text: String(r.level) }),
              h(
                'td',
                { 'data-label': 'Résultat' },
                r.status === 'sent'
                  ? h('span', { class: 'pill is-ok' }, icon('state-ok'), 'Envoyé')
                  : r.status === 'failed'
                    ? h('span', { class: 'adm-failed' }, h('span', { class: 'pill is-alarm' }, icon('state-alarm'), 'Échec'), r.error ? h('span', { class: 'adm-error', text: r.error }) : null)
                    : h('span', { class: 'pill is-dashed' }, 'En cours'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  details.open = recentOpen;
  details.addEventListener('toggle', () => (recentOpen = details.open));
  return details;
}

/**
 * État des canaux, et liste des destinataires avec lui. `recipients` : recharger aussi la liste ; par défaut seulement si
 * aucun formulaire n'y est commencé (un destinataire en cours de saisie n'est jamais effacé).
 */
export async function loadNotifStatus({ recipients = !hasUnsavedInput($('recipients-box')) } = {}) {
  const box = $('notif-status');
  if (recipients) loadRecipients(); // en parallèle : la liste s'affiche même si l'état des envois ne se lit pas
  try {
    const st = await api('/api/notifications/status');
    const problems = [];
    setTestAvailable(st.activeChannels > 0);
    if (st.activeChannels === 0) {
      problems.push(notice('alarm', "Personne n’est prévenu hors de cet écran.", "Aucun destinataire actif : une alarme sonne ici mais n’envoie aucun message. Ajoutez-en un, ou réactivez-en un, ci-dessous."));
    }
    // Une zone dont tous les destinataires sont limités à d'autres zones : ses alarmes partent à tous (repli), pas à la
    // bonne personne.
    if (st.uncoveredZones?.length) {
      const many = st.uncoveredZones.length > 1;
      problems.push(notice('warning', `${many ? 'Zones' : 'Zone'} sans destinataire attitré : ${st.uncoveredZones.join(', ')}.`, `Aucun destinataire de niveau 1 n’y est affecté : ${many ? 'leurs' : 'ses'} alarmes partiront à tous les destinataires.`));
    }
    if (st.generalFallback) {
      problems.push(notice('warning', 'Aucun destinataire ne reçoit « toutes les alarmes ».', 'Redémarrages, alertes de sécurité et détecteurs sans zone partiront donc à tous les destinataires.'));
    }
    // Destinataire limité à une zone qui n'a plus de détecteur (zone renommée) : il ne reçoit plus rien d'elle.
    for (const o of st.orphanRecipientZones ?? []) {
      problems.push(notice('warning', `${o.recipient} ne reçoit plus rien de : ${o.zones.join(', ')}.`, `Aucun détecteur n’est dans ${o.zones.length > 1 ? 'ces zones' : 'cette zone'} (zone renommée ?). Modifiez ses zones dans le tableau des destinataires.`));
    }
    if (st.failedLast24h > 0) {
      problems.push(notice('warning', `${plural(st.failedLast24h, 'message')} n'${st.failedLast24h > 1 ? 'ont' : 'a'} pas pu partir ces dernières 24 h.`, 'Le détail est dans « Derniers envois », plus bas.'));
    }
    const unconfigured = MAIN_CHANNELS.some((id) => !st.channels.some((c) => c.id === id));
    box.replaceChildren(
      ...[
      ...problems,
      channelList(st),
      unconfigured
        ? h('p', { class: 'hint' }, 'Un canal « non réglé » se règle dans le fichier de réglages du PSIM (', h('code', { text: '.env' }), ' : PSIM_SMTP_*, PSIM_TELEGRAM_TOKEN, PSIM_WHATSAPP_*, voir .env.example), puis le PSIM est redémarré.')
        : null,
      h('p', { class: 'adm-facts-line' }, icon('clock', 'icon-sm'), escalationText(st)),
      h('p', { class: 'adm-facts-line' }, icon('history', 'icon-sm'), `Dernières 24 h : ${plural(st.sentLast24h, 'message envoyé', 'messages envoyés')}, ${st.failedLast24h} en échec.`),
      st.recent?.length ? recentSends(st.recent) : null,
      ].filter(Boolean),
    );
  } catch (err) {
    box.replaceChildren(
      h(
        'div',
        { class: 'notice is-alarm' },
        icon('state-alarm'),
        h('span', {}, h('strong', { text: 'État des envois illisible. ' }), `${err.message}. `, h('button', { class: 'btn btn-sm', type: 'button', text: 'Réessayer', onclick: () => loadNotifStatus() })),
      ),
    );
  }
}

// ---------------------------------------------------------------- message de test

function renderTest(results) {
  const list = $('notif-results');
  const at = h('p', { class: 'hint' }, 'Test lancé ', timeEl(Date.now()), '.');
  if (results.length === 0) {
    list.replaceChildren(notice('warning', "Personne n’a été prévenu :", 'aucun destinataire actif. Ajoutez un destinataire, puis recommencez.'), at);
    return;
  }
  const failed = results.filter((r) => !r.ok).length;
  const summary =
    failed === 0
      ? notice('ok', results.length > 1 ? `Les ${results.length} messages sont partis.` : 'Le message est parti.', "Vérifiez auprès de chaque destinataire qu’il l’a bien reçu.")
      : notice('alarm', `${failed} message${failed > 1 ? 's' : ''} sur ${results.length} n'${failed > 1 ? 'ont' : 'a'} pas pu partir.`, "Corrigez l’adresse du destinataire, ou le réglage du canal sur le PC du PSIM, puis recommencez.");
  // Échecs d'abord : c'est ce qu'il faut corriger.
  const sorted = [...results].sort((a, b) => a.ok - b.ok);
  list.replaceChildren(
    summary,
    h(
      'ul',
      { class: 'adm-test-list' },
      ...sorted.map((r) =>
        h(
          'li',
          {},
          r.ok ? h('span', { class: 'pill is-ok' }, icon('state-ok'), 'Envoyé') : h('span', { class: 'pill is-alarm' }, icon('state-alarm'), 'Échec'),
          channelTag(r.channel),
          h('span', { class: 'adm-address', text: r.recipient }),
          h('span', { class: 'tag', text: `Niveau ${r.level}` }),
          r.error ? h('span', { class: 'adm-error', text: r.error }) : null,
        ),
      ),
    ),
    at,
  );
}

// Sans destinataire actif, le test ne peut rien envoyer : le bouton le dit avant le clic, avec la raison à côté.
let testAvailable = true;
function setTestAvailable(available) {
  testAvailable = available;
  const button = $('notif-test');
  if (!button) return;
  if (!button.hasAttribute('aria-busy')) button.disabled = !available;
  let why = $('notif-test-why');
  if (!available && !why) {
    why = h('p', { class: 'hint', id: 'notif-test-why', text: 'Ajoutez d’abord un destinataire actif : sans lui, le test n’a personne à qui écrire.' });
    button.closest('.actions').after(why);
    button.setAttribute('aria-describedby', 'notif-test-why');
  }
  if (available && why) {
    why.remove();
    button.removeAttribute('aria-describedby');
  }
}

$('notif-test')?.addEventListener('click', async () => {
  const button = $('notif-test');
  setBusy(button, true);
  $('notif-results').replaceChildren(h('p', { class: 'muted', text: 'Envoi en cours : quelques secondes au plus par destinataire…' }));
  try {
    renderTest(await api('/api/notifications/test', { method: 'POST' }));
    loadNotifStatus();
  } catch (err) {
    $('notif-results').replaceChildren(notice('alarm', "Le test n’a pas pu être lancé.", err.message));
  } finally {
    setBusy(button, false);
    if (!testAvailable) button.disabled = true;
  }
});
