// Rapports et exports : formulaire de période, liens vers le rapport imprimable et les exports CSV.
import { CATEGORIES, CATEGORY_LABEL } from './sources.js';

const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

export function createReportsView({ h, getMe, api, toast }) {
  const box = document.getElementById('reports-box');
  const today = new Date();
  const monthAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29);

  const from = h('input', { type: 'date', value: day(monthAgo), 'aria-label': 'Du' });
  const to = h('input', { type: 'date', value: day(today), 'aria-label': 'Au' });
  const category = h('select', { 'aria-label': 'Catégorie' }, h('option', { value: '', text: 'Toutes les catégories' }), ...CATEGORIES.map((c) => h('option', { value: c, text: CATEGORY_LABEL[c] })));
  const links = h('div', { class: 'row wrap' });

  function href(path) {
    const q = new URLSearchParams({ from: from.value, to: to.value });
    if (category.value) q.set('category', category.value);
    return `${path}?${q}`;
  }

  // Liens (et non fetch) : le navigateur ouvre le rapport ou télécharge le fichier, avec le cookie de session.
  function draw() {
    const admin = getMe()?.role === 'admin';
    const link = (path, text, title) => h('a', { class: 'btn small', href: href(path), target: '_blank', rel: 'noopener', text, title });
    links.replaceChildren(
      ...[
      link('/api/reports/incidents', 'Rapport imprimable', 'S’ouvre dans un nouvel onglet : Imprimer, puis Enregistrer au format PDF'),
      link('/api/reports/incidents.csv', 'Incidents (CSV)', 'Fichier pour Excel (séparateur « ; », UTF-8)'),
      admin ? link('/api/reports/audit.csv', 'Journal complet (CSV)', 'Toutes les actions des utilisateurs et du système (administrateur)') : null,
      ].filter(Boolean),
    );
  }

  // ---- Rapport periodique par e-mail (administrateur) ----
  const scheduleBox = h('div', { class: 'schedule-mail' });

  async function loadSchedule() {
    if (getMe()?.role !== 'admin') {
      scheduleBox.replaceChildren();
      return;
    }
    try {
      renderSchedule(await api('/api/reports/schedule'));
    } catch (err) {
      scheduleBox.replaceChildren(h('p', { class: 'small error', text: err.message }));
    }
  }

  function renderSchedule(s) {
    const frequency = h('select', { 'aria-label': 'Fréquence' }, h('option', { value: 'off', text: 'Désactivé' }), h('option', { value: 'weekly', text: 'Chaque semaine' }), h('option', { value: 'monthly', text: 'Chaque mois' }));
    frequency.value = s.frequency;
    const weekday = h('select', { 'aria-label': 'Jour de la semaine' }, ...WEEKDAYS.map((d, i) => h('option', { value: String(i), text: d })));
    weekday.value = String(s.weekday);
    const dayOfMonth = h('input', { type: 'number', min: '1', max: '28', value: String(s.dayOfMonth), 'aria-label': 'Jour du mois' });
    const hour = h('input', { type: 'number', min: '0', max: '23', value: String(s.hour), 'aria-label': 'Heure' });
    const recipients = h('textarea', { rows: '3', 'aria-label': 'Destinataires (un par ligne)', placeholder: 'direction@exemple.fr\nqhse@exemple.fr' });
    recipients.value = s.recipients.join('\n');
    const msg = h('p', { class: 'small', role: 'status' });
    const sync = () => {
      weekday.parentElement.hidden = frequency.value !== 'weekly';
      dayOfMonth.parentElement.hidden = frequency.value !== 'monthly';
      hour.parentElement.hidden = frequency.value === 'off';
    };

    const body = () => ({
      frequency: frequency.value,
      weekday: Number(weekday.value),
      dayOfMonth: Number(dayOfMonth.value),
      hour: Number(hour.value),
      recipients: recipients.value.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean),
    });
    const fail = (err) => {
      msg.textContent = err.message;
      msg.className = 'small error';
    };

    scheduleBox.replaceChildren(
      ...[
      h('h4', { text: 'Rapport automatique par e-mail' }),
      s.smtpConfigured ? null : h('p', { class: 'small warn', text: "Aucun serveur SMTP configuré (PSIM_SMTP_HOST, PSIM_SMTP_FROM dans .env) : le rapport ne peut pas partir." }),
      h('div', { class: 'row wrap' }, frequency, h('label', { class: 'small' }, 'le ', weekday), h('label', { class: 'small' }, 'le ', dayOfMonth, ' du mois'), h('label', { class: 'small' }, 'à ', hour, ' h')),
      recipients,
      h('p', { class: 'small muted', text: s.frequency === 'off' ? "Hebdomadaire : les 7 jours entiers précédents. Mensuel : le mois précédent. Heure du serveur. L'activation n'envoie rien d'arrière." : `Prochain envoi : ${s.nextSendAt ? new Date(s.nextSendAt).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' }) : '—'}${s.lastSentAt ? ` — dernier envoi : ${new Date(s.lastSentAt).toLocaleString('fr-FR')}` : ''}${s.lastError ? ` — DERNIÈRE ERREUR : ${s.lastError}` : ''}` }),
      h(
        'div',
        { class: 'row wrap' },
        h('button', { class: 'btn small primary', type: 'button', text: 'Enregistrer', onclick: () => api('/api/reports/schedule', { method: 'PUT', body: body() }).then((r) => (toast('Rapport automatique enregistré', 'ok'), renderSchedule(r)), fail) }),
        h('button', {
          class: 'btn small',
          type: 'button',
          text: 'Envoyer le dernier rapport maintenant',
          title: 'Envoie tout de suite le rapport de la dernière période complète aux destinataires enregistrés',
          onclick: (e) => {
            e.target.disabled = true;
            api('/api/reports/schedule/send-now', { method: 'POST' })
              .then((r) => (toast(`Rapport du ${r.from} au ${r.to} envoyé à ${r.recipients} destinataire(s)`, 'ok'), loadSchedule()), fail)
              .finally(() => (e.target.disabled = false));
          },
        }),
      ),
      msg,
      ].filter(Boolean),
    );
    frequency.addEventListener('change', sync);
    sync();
  }

  for (const el of [from, to, category]) el.addEventListener('change', draw);
  box.replaceChildren(
    h('p', { class: 'muted small', text: "Pour la direction, un assureur ou un audit : synthèse chiffrée, détail des incidents et fiche de chaque incident (chronologie, alertes, images). Heure du serveur." }),
    h('div', { class: 'row wrap' }, h('label', { class: 'small' }, 'Du ', from), h('label', { class: 'small' }, 'au ', to), category),
    links,
    scheduleBox,
  );
  draw();
  return { draw: () => (draw(), loadSchedule()) };
}
