// Rapports et exports : période (raccourcis, dates, catégorie), les trois documents du PSIM expliqués, et le rapport
// automatique par e-mail (administrateur).
//
// Les documents sont des liens, pas des appels fetch : le navigateur ouvre le rapport (ou télécharge le fichier) dans un
// nouvel onglet avec le cookie de session, et le PSIM reste affiché. Le réglage de l'envoi automatique est construit une
// seule fois : un rafraîchissement ne remplace jamais une saisie commencée.
import { CATEGORIES, CATEGORY_LABEL } from './sources.js';
import { icon } from './core.js';

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // la semaine commence le lundi
const MAX_RANGE_DAYS = 366; // comme server/reports.ts
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const pad = (n) => String(n).padStart(2, '0');
const dayString = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const today = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};
function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const sentence = (s) => {
  const t = cap(String(s ?? '').trim());
  return /[.!?…]$/.test(t) ? t : `${t}.`;
};
/** « 1er octobre », « 5 octobre 2026 » (l'année seulement si demandée). */
function dateText(d, year) {
  const text = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', ...(year ? { year: 'numeric' } : {}) });
  return text.replace(/^1 /, '1er ');
}
const longDate = (ts) => {
  const d = new Date(ts);
  return `${cap(d.toLocaleDateString('fr-FR', { weekday: 'long' }))} ${dateText(d, true)} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
};
const hourText = (hr) => `${hr} h`;

const PRESETS = [
  { id: '7d', label: '7 derniers jours', range: (t) => [addDays(t, -6), t] },
  { id: '30d', label: '30 derniers jours', range: (t) => [addDays(t, -29), t] },
  { id: 'month', label: 'Mois en cours', range: (t) => [new Date(t.getFullYear(), t.getMonth(), 1), t] },
  { id: 'last-month', label: 'Mois dernier', range: (t) => [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0)] },
];

const OUTPUTS = [
  {
    path: '/api/reports/incidents',
    icon: 'printer',
    title: 'Rapport imprimable',
    label: 'Ouvrir le rapport imprimable',
    primary: true,
    text: 'Synthèse chiffrée de la période, tableau des incidents et fiche de chaque incident : chronologie, alertes envoyées, images. L’indice de sécurité et les priorités d’action n’y figurent pas (ils se consultent dans Risques). Il s’ouvre dans un nouvel onglet ; pour le garder ou l’envoyer, choisissez Imprimer puis « Enregistrer au format PDF ».',
    done: 'Le rapport s’ouvre dans un nouvel onglet.',
  },
  {
    path: '/api/reports/incidents.csv',
    icon: 'download',
    title: 'Tableau des incidents',
    label: 'Incidents pour Excel (CSV)',
    text: 'Une ligne par incident, à ouvrir dans Excel ou LibreOffice : heures d’ouverture, d’acquittement et de clôture, qualification, commentaire.',
    done: 'Le tableau des incidents se télécharge : retrouvez-le dans le dossier Téléchargements.',
  },
  {
    path: '/api/reports/audit.csv',
    icon: 'download',
    title: 'Journal complet',
    label: 'Journal complet (CSV)',
    admin: true,
    text: 'Toutes les actions des personnes et du système sur la période (connexions, réglages, acquittements…), pour un audit. La catégorie ne s’applique pas à ce fichier.',
    done: 'Le journal se télécharge : retrouvez-le dans le dossier Téléchargements.',
  },
];

// Mêmes calculs que server/reportmail.ts (heure du PSIM) : aperçu du prochain envoi avant d'enregistrer, et période
// du rapport envoyé par « Envoyer le dernier rapport maintenant ».
function latestSendMoment(s, now) {
  if (s.frequency === 'off') return null;
  const n = new Date(now);
  if (s.frequency === 'weekly') {
    const back = (n.getDay() - s.weekday + 7) % 7;
    let t = new Date(n.getFullYear(), n.getMonth(), n.getDate() - back, s.hour).getTime();
    if (t > now) t = new Date(n.getFullYear(), n.getMonth(), n.getDate() - back - 7, s.hour).getTime();
    return t;
  }
  let t = new Date(n.getFullYear(), n.getMonth(), s.dayOfMonth, s.hour).getTime();
  if (t > now) t = new Date(n.getFullYear(), n.getMonth() - 1, s.dayOfMonth, s.hour).getTime();
  return t;
}
function nextSendMoment(s, now) {
  const last = latestSendMoment(s, now);
  if (last === null) return null;
  const d = new Date(last);
  return s.frequency === 'weekly' ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7, s.hour).getTime() : new Date(d.getFullYear(), d.getMonth() + 1, s.dayOfMonth, s.hour).getTime();
}
function lastPeriod(s, now) {
  const frequency = s.frequency === 'off' ? 'weekly' : s.frequency;
  const d = new Date(latestSendMoment({ ...s, frequency }, now));
  const from = frequency === 'weekly' ? new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7) : new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const to = frequency === 'weekly' ? new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1) : new Date(d.getFullYear(), d.getMonth(), 0);
  return { from, to };
}
const periodText = (from, to) => (from.getFullYear() === to.getFullYear() ? `du ${dateText(from)} au ${dateText(to, true)}` : `du ${dateText(from, true)} au ${dateText(to, true)}`);

export function createReportsView({ h, getMe, api, toast }) {
  const box = document.getElementById('reports-box');
  const view = document.getElementById('view-rapports');
  const mailCard = document.getElementById('reports-mail-card');
  const mailBox = document.getElementById('reports-mail');
  const mailState = document.getElementById('reports-mail-state');

  // ------------------------------------------------------------------ période

  let preset = '30d'; // raccourci choisi : ses dates suivent le jour courant (écran resté ouvert plusieurs jours)
  const presetButtons = PRESETS.map((p) => {
    const b = h('button', { type: 'button', 'aria-pressed': 'false', text: p.label });
    b.addEventListener('click', () => {
      preset = p.id;
      applyPreset();
      draw();
    });
    return b;
  });
  const from = h('input', { type: 'date', id: 'rep-from', required: true, 'aria-describedby': 'rep-period-error' });
  const to = h('input', { type: 'date', id: 'rep-to', required: true, 'aria-describedby': 'rep-period-error' });
  const category = h('select', { id: 'rep-category' }, h('option', { value: '', text: 'Toutes les catégories' }), ...CATEGORIES.map((c) => h('option', { value: c, text: CATEGORY_LABEL[c] })));
  const periodError = h('p', { class: 'form-error', id: 'rep-period-error', role: 'alert' });
  const periodSummary = h('p', { class: 'rep-period-summary' });
  const status = h('p', { class: 'rep-status', role: 'status' });
  let statusTimer = null;

  function applyPreset() {
    const p = PRESETS.find((x) => x.id === preset);
    if (!p) return;
    const [a, b] = p.range(today());
    from.value = dayString(a);
    to.value = dayString(b);
  }

  for (const input of [from, to]) {
    input.addEventListener('input', () => {
      // Dates saisies à la main : on garde le raccourci qui y correspond exactement, sinon aucun.
      preset = PRESETS.find((p) => p.range(today()).map(dayString).join() === `${from.value},${to.value}`)?.id ?? null;
      draw();
    });
  }
  category.addEventListener('change', () => draw());

  function period() {
    const a = parseDay(from.value);
    const b = parseDay(to.value);
    if (!a || !b) return { error: 'Choisissez une date de début (« Du ») et une date de fin (« Au »).' };
    if (a > b) return { error: 'La date de début est après la date de fin : corrigez l’une des deux.' };
    const days = Math.round((b - a) / 86_400_000) + 1;
    if (days > MAX_RANGE_DAYS) return { error: `Période trop longue : ${MAX_RANGE_DAYS} jours au plus. Raccourcissez-la.` };
    return { a, b, days };
  }

  function href(path) {
    const q = new URLSearchParams({ from: from.value, to: to.value });
    if (category.value && path !== '/api/reports/audit.csv') q.set('category', category.value);
    return `${path}?${q}`;
  }

  const outputs = OUTPUTS.map((o, i) => {
    const descId = `rep-out-${i}`;
    const link = h('a', { class: `btn${o.primary ? ' btn-primary' : ''} rep-output-action`, target: '_blank', rel: 'noopener', 'aria-describedby': descId }, icon(o.icon), o.label);
    link.addEventListener('click', (e) => {
      if (link.getAttribute('aria-disabled') === 'true') {
        e.preventDefault();
        return;
      }
      clearTimeout(statusTimer);
      status.textContent = o.done;
      statusTimer = setTimeout(() => (status.textContent = ''), 8000);
    });
    const row = h(
      'li',
      { class: `rep-output${o.primary ? ' is-main' : ''}` },
      h('span', { class: 'rep-output-icon' }, icon(o.icon)),
      h('div', { class: 'rep-output-text' }, h('h4', {}, o.title, o.admin ? h('span', { class: 'tag', text: 'Administrateur' }) : null), h('p', { id: descId, text: o.text })),
      link,
    );
    return { o, row, link };
  });
  const outputList = h('ul', { class: 'rep-outputs' }, ...outputs.map((x) => x.row));

  function draw() {
    const admin = getMe()?.role === 'admin';
    const p = period();
    const ok = !p.error;
    periodError.textContent = p.error ?? '';
    for (const input of [from, to]) input.setAttribute('aria-invalid', String(!ok));
    for (const [i, pr] of PRESETS.entries()) presetButtons[i].setAttribute('aria-pressed', String(pr.id === preset));
    if (ok) {
      const scope = category.value ? `catégorie ${CATEGORY_LABEL[category.value]}` : 'toutes les catégories';
      const range = p.days === 1 ? `Le ${dateText(p.a, true)}` : cap(periodText(p.a, p.b));
      periodSummary.textContent = `${range} : ${p.days} jour${p.days > 1 ? 's' : ''}, ${scope}. À l’heure du serveur.`;
    } else periodSummary.textContent = '';
    for (const { o, row, link } of outputs) {
      row.hidden = Boolean(o.admin && !admin);
      if (ok) {
        link.href = href(o.path);
        link.removeAttribute('aria-disabled');
        link.removeAttribute('aria-describedby');
        link.title = '';
      } else {
        link.removeAttribute('href');
        link.setAttribute('aria-disabled', 'true');
        link.setAttribute('role', 'link');
        link.setAttribute('aria-describedby', 'rep-period-error');
        link.title = 'Corrigez d’abord la période';
      }
    }
  }

  box.replaceChildren(
    h('p', { class: 'rep-lead', text: 'Pour la direction, un assureur ou un audit : choisissez la période, puis le document. Chaque ouverture est inscrite au journal.' }),
    h(
      'section',
      { class: 'rep-period', 'aria-labelledby': 'rep-period-title' },
      h('h3', { id: 'rep-period-title', text: 'Période' }),
      h('div', { class: 'segmented rep-presets', role: 'group', 'aria-label': 'Raccourcis de période' }, ...presetButtons),
      h(
        'div',
        { class: 'rep-fields' },
        h('label', { class: 'field' }, h('span', { text: 'Du' }), from),
        h('label', { class: 'field' }, h('span', { text: 'Au' }), to),
        h('label', { class: 'field' }, h('span', { text: 'Catégorie' }), category),
      ),
      periodSummary,
      periodError,
    ),
    h('section', { class: 'rep-docs', 'aria-labelledby': 'rep-docs-title' }, h('h3', { id: 'rep-docs-title', text: 'Documents' }), outputList, status),
  );
  applyPreset();

  // Écran rouvert (ou onglet revenu au premier plan) : un raccourci suit la date du jour.
  const refreshDates = () => {
    if (preset && !view.hidden) {
      applyPreset();
      draw();
    }
  };
  new MutationObserver(refreshDates).observe(view, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', () => !document.hidden && refreshDates());

  // ------------------------------------------------------------------ rapport automatique par e-mail (administrateur)

  let saved = null; // réglage enregistré (vue du serveur)
  let form = null; // formulaire construit une fois par session

  function mailPill(s) {
    if (s.lastError) return h('span', { class: 'pill is-alarm' }, icon('state-alarm'), 'Dernier envoi en échec');
    if (s.frequency === 'off') return h('span', { class: 'pill is-dashed' }, icon('clock'), 'Désactivé');
    const rhythm = s.frequency === 'weekly' ? `Chaque ${WEEKDAYS[s.weekday]}` : `Le ${s.dayOfMonth === 1 ? '1er' : s.dayOfMonth} du mois`;
    return h('span', { class: 'pill is-ok' }, icon('state-ok'), `${rhythm}, ${hourText(s.hour)}`);
  }

  function buildForm() {
    const f = {};
    f.frequency = 'off';
    f.freqButtons = [
      ['off', 'Désactivé'],
      ['weekly', 'Chaque semaine'],
      ['monthly', 'Chaque mois'],
    ].map(([value, text]) => {
      const b = h('button', { type: 'button', 'aria-pressed': 'false', text });
      b.dataset.value = value;
      b.addEventListener('click', () => {
        f.frequency = value;
        changed();
      });
      return b;
    });
    f.weekday = h('select', { id: 'rep-weekday' }, ...WEEK_ORDER.map((d) => h('option', { value: String(d), text: cap(WEEKDAYS[d]) })));
    f.dayOfMonth = h('select', { id: 'rep-daymonth', 'aria-describedby': 'rep-daymonth-hint' }, ...Array.from({ length: 28 }, (_, i) => h('option', { value: String(i + 1), text: i === 0 ? '1er' : String(i + 1) })));
    f.hour = h('select', { id: 'rep-hour' }, ...Array.from({ length: 24 }, (_, i) => h('option', { value: String(i), text: hourText(i) })));
    f.recipients = h('textarea', { id: 'rep-recipients', rows: '4', spellcheck: 'false', autocomplete: 'off', placeholder: 'direction@exemple.ci\nqhse@exemple.ci', 'aria-describedby': 'rep-recipients-hint rep-recipients-error' });
    f.recipientsError = h('p', { class: 'form-error', id: 'rep-recipients-error' });
    f.weekdayField = h('label', { class: 'field' }, h('span', { text: 'Jour d’envoi' }), f.weekday);
    f.dayField = h('label', { class: 'field' }, h('span', { text: 'Jour du mois' }), f.dayOfMonth, h('span', { class: 'hint', id: 'rep-daymonth-hint', text: 'Du 1er au 28 : tous les mois en ont autant.' }));
    f.hourField = h('label', { class: 'field' }, h('span', { text: 'Heure d’envoi' }), f.hour);
    f.when = h('div', { class: 'rep-mail-when' }, f.weekdayField, f.dayField, f.hourField);
    f.notices = h('div', { class: 'rep-mail-notices' });
    f.next = h('dd');
    f.last = h('dd');
    f.facts = h('dl', { class: 'rep-facts' }, h('dt', { text: 'Prochain envoi' }), f.next, h('dt', { text: 'Dernier envoi réussi' }), f.last);
    f.error = h('p', { class: 'form-error', role: 'alert' });
    f.saved = h('p', { class: 'rep-saved', role: 'status' });
    f.save = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('check'), 'Enregistrer');
    f.send = h('button', { class: 'btn', type: 'button', 'aria-describedby': 'rep-send-hint' }, icon('send'), 'Envoyer le dernier rapport maintenant');
    f.sendHint = h('p', { class: 'hint', id: 'rep-send-hint' });
    f.confirmText = h('p', { id: 'rep-send-confirm-text' });
    f.confirmYes = h('button', { class: 'btn btn-primary', type: 'button' }, icon('send'), 'Envoyer maintenant');
    f.confirmNo = h('button', { class: 'btn', type: 'button', text: 'Annuler' });
    f.confirm = h(
      'div',
      { class: 'notice is-info rep-confirm', role: 'group', tabindex: '-1', 'aria-labelledby': 'rep-send-confirm-text', hidden: true },
      icon('send'),
      h('div', { class: 'rep-confirm-body' }, f.confirmText, h('div', { class: 'actions' }, f.confirmYes, f.confirmNo)),
    );

    for (const el of [f.weekday, f.dayOfMonth, f.hour]) el.addEventListener('change', changed);
    f.recipients.addEventListener('input', () => {
      f.recipientsError.textContent = '';
      f.recipients.removeAttribute('aria-invalid');
      changed();
    });

    f.el = h(
      'form',
      { class: 'rep-mail-form', novalidate: true },
      f.notices,
      h('p', { class: 'rep-lead', text: 'Le PSIM envoie tout seul le rapport de la période écoulée : la semaine précédente (7 jours entiers) ou le mois précédent, avec le rapport imprimable et le tableau des incidents en pièces jointes. L’activation n’envoie rien pour les périodes déjà passées.' }),
      h('fieldset', { class: 'rep-freq' }, h('legend', { text: 'Fréquence' }), h('div', { class: 'segmented' }, ...f.freqButtons)),
      f.when,
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'rep-recipients', text: 'Destinataires' }),
        f.recipients,
        h('span', { class: 'hint', id: 'rep-recipients-hint', text: 'Une adresse e-mail par ligne (20 au plus).' }),
        f.recipientsError,
      ),
      f.facts,
      f.error,
      h('div', { class: 'actions' }, f.save, f.send),
      f.sendHint,
      f.confirm,
      f.saved,
    );
    f.el.addEventListener('submit', (e) => {
      e.preventDefault();
      saveSchedule();
    });
    f.send.addEventListener('click', askSend);
    f.confirmNo.addEventListener('click', () => {
      f.confirm.hidden = true;
      f.send.focus();
    });
    f.confirmYes.addEventListener('click', sendNow);
    return f;
  }

  const recipientList = () =>
    form.recipients.value
      .split(/[\n,;]+/)
      .map((x) => x.trim())
      .filter(Boolean);

  function draft() {
    return {
      frequency: form.frequency,
      weekday: Number(form.weekday.value),
      dayOfMonth: Number(form.dayOfMonth.value),
      hour: Number(form.hour.value),
      recipients: recipientList(),
    };
  }

  function isDirty() {
    if (!saved || !form) return false;
    const d = draft();
    return (
      d.frequency !== saved.frequency ||
      d.weekday !== saved.weekday ||
      d.dayOfMonth !== saved.dayOfMonth ||
      d.hour !== saved.hour ||
      d.recipients.map((r) => r.toLowerCase()).join('\n') !== saved.recipients.join('\n')
    );
  }

  /** Remplit le formulaire avec le réglage enregistré. */
  function fill(s) {
    form.frequency = s.frequency;
    form.weekday.value = String(s.weekday);
    form.dayOfMonth.value = String(s.dayOfMonth);
    form.hour.value = String(s.hour);
    form.recipients.value = s.recipients.join('\n');
    form.recipientsError.textContent = '';
    form.recipients.removeAttribute('aria-invalid');
  }

  /** Avertissements, prochain envoi, boutons : suivent la saisie et le réglage enregistré. */
  function refresh() {
    const s = saved;
    const d = draft();
    const dirty = isDirty();
    for (const b of form.freqButtons) b.setAttribute('aria-pressed', String(b.dataset.value === d.frequency));
    form.when.hidden = d.frequency === 'off';
    form.weekdayField.hidden = d.frequency !== 'weekly';
    form.dayField.hidden = d.frequency !== 'monthly';

    const notices = [];
    if (!s.smtpConfigured) {
      notices.push(
        h(
          'div',
          { class: 'notice is-warning' },
          icon('state-warning'),
          h('div', {}, h('p', {}, h('strong', { text: 'Aucun serveur d’envoi d’e-mails n’est réglé : le rapport ne peut pas partir.' })), h('p', { class: 'rep-tech', text: 'Pour le technicien : renseigner PSIM_SMTP_HOST et PSIM_SMTP_FROM dans le fichier .env du PSIM, puis le redémarrer.' })),
        ),
      );
    }
    if (s.lastError) {
      notices.push(
        h(
          'div',
          { class: 'notice is-alarm' },
          icon('state-alarm'),
          h('div', {}, h('p', {}, h('strong', { text: 'Le dernier envoi a échoué. ' }), sentence(s.lastError)), h('p', { text: 'Vérifiez les adresses et le serveur d’envoi, puis essayez « Envoyer le dernier rapport maintenant ».' })),
        ),
      );
    }
    form.notices.replaceChildren(...notices);
    form.notices.hidden = notices.length === 0;

    if (d.frequency === 'off') form.next.textContent = 'Aucun : l’envoi automatique est désactivé.';
    else if (dirty) {
      const t = nextSendMoment(d, Date.now());
      form.next.textContent = t ? `${longDate(t)} (après enregistrement)` : '—';
    } else form.next.textContent = s.nextSendAt ? longDate(s.nextSendAt) : '—';
    form.last.textContent = s.lastSentAt ? longDate(s.lastSentAt) : 'Jamais';

    // « Envoyer maintenant » part avec le réglage ENREGISTRÉ : pas pendant une modification non enregistrée.
    const reason = !s.smtpConfigured
      ? 'Indisponible : aucun serveur d’envoi n’est réglé.'
      : !s.recipients.length
        ? 'Indisponible : enregistrez d’abord au moins un destinataire.'
        : dirty
          ? 'Enregistrez d’abord vos modifications : l’envoi utilise le réglage enregistré.'
          : `Envoie tout de suite le rapport de la dernière période complète à ${s.recipients.length} adresse${s.recipients.length > 1 ? 's' : ''}.`;
    form.send.disabled = !s.smtpConfigured || !s.recipients.length || dirty;
    form.sendHint.textContent = reason;
    if (form.send.disabled) form.confirm.hidden = true;
    form.save.disabled = !dirty;
    mailState.replaceChildren(mailPill(s));
  }

  function changed() {
    form.saved.textContent = '';
    form.error.textContent = '';
    refresh();
  }

  /** Réglage reçu du serveur : le formulaire n'est rempli que s'il n'y a pas de saisie en cours (ou s'il est neuf). */
  function applySaved(s, { reset = false } = {}) {
    const keep = !reset && isDirty();
    saved = s;
    if (!keep) fill(s);
    refresh();
  }

  function setBusy(btn, busy) {
    btn.classList.toggle('is-busy', busy);
    btn.toggleAttribute('aria-busy', busy);
    for (const b of form.el.querySelectorAll('button')) b.disabled = busy;
    if (!busy) refresh();
  }

  function validate(d) {
    const bad = d.recipients.filter((r) => !EMAIL.test(r));
    if (bad.length) return { field: true, text: `Adresse${bad.length > 1 ? 's' : ''} à corriger : ${bad.join(', ')}. Une adresse par ligne, sous la forme nom@domaine.ci.` };
    const max = saved?.maxRecipients ?? 20;
    if (d.recipients.length > max) return { field: true, text: `${max} destinataires au plus : retirez-en ${d.recipients.length - max}.` };
    if (d.frequency !== 'off' && !d.recipients.length) return { field: true, text: 'Ajoutez au moins un destinataire avant d’activer l’envoi automatique.' };
    if (d.frequency !== 'off' && !saved.smtpConfigured) return { text: 'Aucun serveur d’envoi n’est réglé : l’envoi automatique ne peut pas être activé. Laissez « Désactivé », ou demandez au technicien de régler le serveur d’envoi.' };
    return null;
  }

  async function saveSchedule() {
    if (!isDirty()) return;
    const d = draft();
    const problem = validate(d);
    if (problem) {
      if (problem.field) {
        form.recipientsError.textContent = problem.text;
        form.recipients.setAttribute('aria-invalid', 'true');
        form.recipients.focus();
      } else form.error.textContent = problem.text;
      return;
    }
    form.error.textContent = '';
    setBusy(form.save, true);
    try {
      const s = await api('/api/reports/schedule', { method: 'PUT', body: d });
      setBusy(form.save, false);
      applySaved(s, { reset: true });
      form.saved.textContent = s.frequency === 'off' ? 'Réglage enregistré : l’envoi automatique est désactivé.' : `Réglage enregistré. Prochain envoi : ${longDate(s.nextSendAt)}.`;
      toast('Rapport automatique enregistré', 'ok');
    } catch (err) {
      setBusy(form.save, false);
      form.error.textContent = `Le réglage n’a pas été enregistré : ${sentence(err.message)}`;
      form.save.focus();
    }
  }

  function askSend() {
    const { from: a, to: b } = lastPeriod(saved, Date.now());
    const n = saved.recipients.length;
    form.confirmText.textContent = `Le rapport ${periodText(a, b)} part tout de suite à ${n} adresse${n > 1 ? 's' : ''} : ${saved.recipients.join(', ')}. Envoyer ?`;
    form.confirm.hidden = false;
    form.confirm.focus();
  }

  async function sendNow() {
    setBusy(form.confirmYes, true);
    try {
      const r = await api('/api/reports/schedule/send-now', { method: 'POST' });
      setBusy(form.confirmYes, false);
      form.confirm.hidden = true;
      const a = parseDay(r.from);
      const b = parseDay(r.to);
      const what = a && b ? `Rapport ${periodText(a, b)}` : `Rapport du ${r.from} au ${r.to}`;
      form.saved.textContent = `${what} envoyé à ${r.recipients} adresse${r.recipients > 1 ? 's' : ''}.`;
      toast(`${what} envoyé`, 'ok');
      form.send.focus();
      loadSchedule();
    } catch (err) {
      setBusy(form.confirmYes, false);
      form.confirm.hidden = true;
      form.error.textContent = `L’envoi a échoué : ${sentence(err.message)} Vérifiez les adresses et le serveur d’envoi, puis réessayez.`;
      form.send.focus();
    }
  }

  async function loadSchedule({ reset = false } = {}) {
    const admin = getMe()?.role === 'admin';
    mailCard.hidden = !admin;
    if (!admin) {
      // Rien du réglage (adresses des destinataires) ne reste dans la page pour un opérateur.
      mailBox.replaceChildren();
      mailState.replaceChildren();
      form = null;
      saved = null;
      return;
    }
    if (reset || !form) {
      form = null;
      saved = null;
      mailBox.replaceChildren(h('p', { class: 'muted', text: 'Lecture du réglage…' }));
    }
    try {
      const s = await api('/api/reports/schedule');
      if (!form) {
        form = buildForm();
        mailBox.replaceChildren(form.el);
        applySaved(s, { reset: true });
      } else applySaved(s);
    } catch (err) {
      if (form) {
        form.error.textContent = `Le réglage n’a pas pu être relu : ${sentence(err.message)}`;
        return;
      }
      const retry = h('button', { class: 'btn btn-sm', type: 'button' }, icon('refresh'), 'Réessayer');
      retry.addEventListener('click', () => loadSchedule());
      mailBox.replaceChildren(
        h('div', { class: 'notice is-alarm' }, icon('state-alarm'), h('div', { class: 'rep-error' }, h('p', {}, h('strong', { text: 'Le réglage n’a pas pu être lu. ' }), sentence(err.message)), retry)),
      );
      mailState.replaceChildren();
    }
  }

  draw();
  // Appelé à chaque connexion : la période suit le jour, le réglage est relu pour le nouveau compte.
  return {
    draw: () => {
      if (preset) applyPreset();
      draw();
      return loadSchedule({ reset: true });
    },
  };
}
