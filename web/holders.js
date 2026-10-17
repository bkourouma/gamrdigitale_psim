/**
 * Écran « Titulaires » (opérateur et administrateur) : qui a un badge, quelles portes il ouvre, et si les contrôleurs
 * le savent. Cinq onglets :
 *  - Titulaires : recherche, fiche (photo, validité, groupes, badges, synchronisation par contrôleur, passages) ;
 *  - Visiteurs : badge remis au poste de garde avec une heure de fin écrite en clair, liste des visites en cours ;
 *  - Groupes et horaires : groupes, plages horaires, jours fériés (lecture seule pour l'opérateur) ;
 *  - Import (administrateur) : fichier CSV, vérification à blanc, puis import pour de bon ;
 *  - Synchronisation : un état par contrôleur, clé de la passerelle (montrée une seule fois), suppressions à confirmer.
 *
 * Contrat : docs/ACCES.md § 12 (routes, formes JSON). Les calculs et les textes sont dans holdersfmt.js (fonctions pures,
 * testées sans navigateur) ; ce fichier ne fait que le DOM et les appels au serveur.
 *
 * Règles tenues ici :
 *  - tout texte passe par h() / textContent : jamais d'HTML construit, jamais de style en ligne (holders.css) ;
 *  - aucun nom, matricule ou numéro de badge dans l'adresse de la page ; les identifiants numériques seuls vont dans les
 *    appels à l'API ; la recherche est un paramètre d'appel, jamais une adresse de navigation ;
 *  - un geste durable (désactiver ou rendre un badge, supprimer, importer, renouveler une clé) demande une confirmation
 *    qui dit ce qui va se passer ; l'opérateur ne voit aucun bouton d'écriture hors visiteurs ;
 *  - un état se dit par un mot ET une icône ; les écrans sont masqués, jamais détruits (un formulaire commencé reste) ;
 *  - le rafraîchissement de la synchronisation (10 s) s'arrête dès que l'écran ou l'onglet est masqué.
 */
import { emit } from './core.js';
import { copyButton, setBusy, uid, markInvalid, clearInvalid, field } from './account.js';
import * as F from './holdersfmt.js';

const SYNC_REFRESH_MS = 10_000;
const VISITORS_REFRESH_MS = 60_000;
const SEARCH_DELAY_MS = 300;

const TABS = [
  { id: 'holders', label: 'Titulaires', icon: 'badge' },
  { id: 'visitors', label: 'Visiteurs', icon: 'user' },
  { id: 'groups', label: 'Groupes et horaires', icon: 'layers' },
  { id: 'import', label: 'Import', icon: 'upload', admin: true },
  { id: 'sync', label: 'Synchronisation', icon: 'refresh' },
];

const VISIT_STATE = {
  present: { label: 'En cours', icon: 'state-ok', tone: 'is-ok' },
  upcoming: { label: 'À venir', icon: 'clock', tone: 'is-info' },
  ended: { label: 'Terminée', icon: 'check', tone: 'is-offline' },
};

export function createHoldersView({ api, h, icon, toast, dialogs, getMe }) {
  const root = document.getElementById('holders-root');
  const isAdmin = () => getMe()?.role === 'admin';
  const now = () => Date.now();

  let shown = false;
  let builtFor = null; // rôle pour lequel les onglets ont été construits
  let activeTab = 'holders';
  const timers = { sync: 0, visitors: 0, endline: 0 };
  const tabs = {}; // id -> { panel, enter, leave, reset, roleChanged }
  const tabButtons = {};

  // ---------------------------------------------------------------- petits outils

  /** Focus après une fenêtre : tant qu'elle se referme, le reste de la page est encore inerte (app.js). On réessaie. */
  const focusSoon = (el) => {
    el?.focus();
    if (el && document.activeElement !== el) setTimeout(() => el.isConnected && el.focus(), 0);
  };

  const pill = (info, prefix = '') => h('span', { class: `pill ${info.tone}` }, icon(info.icon), prefix ? h('span', { class: 'sr-only', text: prefix }) : null, h('span', { text: info.label }));

  const button = (text, { ic = null, cls = 'btn', onClick = null, fk = null, title = null, label = null, hidden = false } = {}) => {
    const b = h('button', { class: cls, type: 'button', title, 'aria-label': label, 'data-fk': fk, hidden }, ic ? icon(ic) : null, h('span', { text }));
    if (onClick) b.addEventListener('click', () => onClick(b));
    return b;
  };

  const noticeBox = (tone, iconName, ...content) => h('div', { class: `notice ${tone}`, role: tone === 'is-alarm' ? 'alert' : null }, icon(iconName), h('div', { class: 'hd-notice-text' }, ...content));

  const emptyBox = (title, text, ...actions) => h('div', { class: 'empty' }, icon('badge'), h('strong', { text: title }), text ? h('span', { text }) : null, ...actions);

  /** Exécute une action sur un bouton occupé ; l'erreur du serveur est affichée telle quelle. */
  async function run(btn, fn) {
    setBusy(btn, true);
    try {
      return await fn();
    } catch (err) {
      toast(err.message);
      return undefined;
    } finally {
      setBusy(btn, false);
    }
  }

  /** Appel avec un corps brut (photo, fichier CSV) : api() ne sait envoyer que du JSON. Même gestion de la session. */
  async function rawRequest(path, { method, body, contentType }) {
    const res = await fetch(path, { method, body, credentials: 'same-origin', headers: { 'Content-Type': contentType } });
    if (res.status === 401) {
      emit('unauthorized');
      throw new Error('Session expirée, reconnectez-vous');
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? `Erreur ${res.status}`);
    return data;
  }

  const asList = (data, key) => (Array.isArray(data) ? data : (data?.[key] ?? data?.items ?? []));

  /** Mémorise le champ qui a le focus dans `container`, exécute `render`, rend le focus au même champ s'il existe encore. */
  function keepFocus(container, render) {
    const key = document.activeElement instanceof HTMLElement && container.contains(document.activeElement) ? document.activeElement.getAttribute('data-fk') : null;
    render();
    if (key) {
      for (const el of container.querySelectorAll('[data-fk]')) {
        if (el.getAttribute('data-fk') === key) {
          el.focus({ preventScroll: true });
          break;
        }
      }
    }
  }

  /** Fenêtre à formulaire : validation sur place, bouton occupé, erreur du serveur (409 compris) affichée sans rien effacer. */
  function openFormDialog({ heading, lead = null, children, submitLabel, submitIcon = null, danger = false, validate = null, onSubmit, formClass = '' }) {
    return new Promise((resolve) => {
      let busy = false;
      const error = h('p', { class: 'form-error', role: 'alert' });
      const submit = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'submit' }, submitIcon ? icon(submitIcon) : null, h('span', { text: submitLabel }));
      const cancel = h('button', { class: 'btn', type: 'button', text: 'Annuler' });
      cancel.addEventListener('click', () => {
        resolve(null);
        dialogs.close();
      });
      const form = h('form', { class: `dialog-form hd-form ${formClass}`.trim(), novalidate: true }, lead ? h('p', { class: 'dialog-lead', text: lead }) : null, ...children, error, h('div', { class: 'actions dialog-actions' }, cancel, submit));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy) return;
        clearInvalid(form, error);
        const problem = validate?.();
        if (problem) return markInvalid(problem.input ?? null, error, problem.message);
        busy = true;
        setBusy(submit, true);
        try {
          const result = await onSubmit();
          resolve(result ?? true);
          dialogs.close();
        } catch (err) {
          error.textContent = err.message;
          error.scrollIntoView?.({ block: 'nearest' }); // l'erreur du serveur reste visible dans une fenêtre longue
        } finally {
          busy = false;
          setBusy(submit, false);
        }
      });
      dialogs.open(heading, form, { onClose: () => resolve(null) });
    });
  }

  const textInput = (value = '', attrs = {}) => h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', value, ...attrs });

  // ---------------------------------------------------------------- données de référence (groupes, plages, portes, fériés)

  const ref = { groups: [], schedules: [], doors: [], holidays: [], loaded: false };
  let refSeq = 0;

  /** Relit groupes, plages, portes et jours fériés. Renvoie le message d'erreur (une seule source en échec garde l'ancienne valeur). */
  async function loadRef() {
    const n = ++refSeq;
    const [groups, schedules, doors, holidays] = await Promise.allSettled([
      api('/api/access/groups'),
      api('/api/access/schedules'),
      api('/api/access/doors'),
      api('/api/access/holidays'),
    ]);
    if (n !== refSeq) return null;
    let failure = null;
    const take = (result, key, listKey) => {
      if (result.status === 'fulfilled') ref[key] = asList(result.value, listKey);
      else failure ??= result.reason;
    };
    take(groups, 'groups', 'groups');
    take(schedules, 'schedules', 'schedules');
    take(doors, 'doors', 'doors');
    take(holidays, 'holidays', 'holidays');
    ref.loaded = !failure || ref.loaded;
    return failure ? failure.message : null;
  }

  // ================================================================= onglet Titulaires

  function createHoldersTab() {
    const st = { q: '', status: '', items: [], next: null, total: 0, loaded: false, selectedId: null, detail: null, listSeq: 0, detailSeq: 0 };
    const photoVersion = new Map();
    const photoUrl = (id) => `/api/access/holders/${id}/photo?v=${photoVersion.get(id) ?? 0}`;
    let searchTimer = 0;

    const search = h('input', { type: 'search', placeholder: 'Nom, matricule ou badge', autocomplete: 'off', spellcheck: 'false', maxlength: '64' });
    const statusSel = h('select', {}, h('option', { value: '', text: 'Tous les statuts' }), h('option', { value: 'active', text: 'Actifs' }), h('option', { value: 'suspended', text: 'Suspendus' }));
    const newBtn = button('Nouveau titulaire', { ic: 'plus', cls: 'btn btn-primary hd-new', onClick: () => openHolderForm(null), hidden: true });
    const count = h('p', { class: 'hd-count', role: 'status', 'aria-live': 'polite' });
    const list = h('ul', { class: 'hd-list', 'aria-label': 'Titulaires' });
    const listMsg = h('div', { class: 'hd-list-msg' });
    const more = button('Voir plus', { ic: 'chevron-down', cls: 'btn hd-more', hidden: true, onClick: (b) => run(b, () => loadList({ append: true })) });
    const detail = h('aside', { class: 'hd-detail panel', 'aria-labelledby': 'hd-detail-title', hidden: true });
    const detailBody = h('div', { class: 'hd-detail-body' });
    detail.append(detailBody);
    // Échap ferme la fiche (une fenêtre ouverte par-dessus se ferme d'abord : elle est hors de la fiche).
    detail.addEventListener('keydown', (e) => e.key === 'Escape' && !e.defaultPrevented && closeDetail());

    const listCol = h('div', { class: 'hd-listcol' }, listMsg, list, more);
    const panel = h(
      'div',
      { class: 'hd-holders' },
      h('div', { class: 'hd-toolbar' }, field(h, 'Recherche', search), field(h, 'Statut', statusSel), newBtn),
      count,
      h('div', { class: 'hd-split' }, listCol, detail),
    );

    // -- recherche : 300 ms après la dernière frappe (ou Entrée), sans mettre le texte dans l'adresse de la page
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applySearch, SEARCH_DELAY_MS);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(searchTimer);
        applySearch();
      }
    });
    statusSel.addEventListener('change', applySearch);
    function applySearch() {
      st.q = search.value.trim();
      st.status = statusSel.value;
      loadList();
    }

    // -- liste

    function rowEl(item) {
      const selected = item.id === st.selectedId;
      const avatar = h('span', { class: 'hd-avatar' }, item.hasPhoto ? h('img', { src: photoUrl(item.id), alt: '', loading: 'lazy', width: '40', height: '40' }) : icon('user'));
      const main = h(
        'span',
        { class: 'hd-row-main' },
        h('strong', { class: 'hd-name', text: item.displayName }),
        h('span', { class: 'hd-sub', text: item.externalRef ? `Matricule ${item.externalRef}` : 'Sans matricule' }),
        h('span', { class: 'hd-sub', text: `Badges : ${F.activeBadgesText(item)}` }),
      );
      const states = h('span', { class: 'hd-row-states' }, pill(F.holderStatusInfo(item), 'Statut : '), item.syncState ? pill(F.holderSyncInfo(item.syncState), 'Synchronisation : ') : null);
      const b = h('button', { class: 'hd-row', type: 'button', 'data-id': String(item.id), 'aria-current': selected ? 'true' : null }, avatar, main, states);
      b.addEventListener('click', () => openDetail(item.id));
      return h('li', { class: 'hd-item' }, b);
    }

    function renderList() {
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement.closest('.hd-row')?.getAttribute('data-id') : null;
      list.replaceChildren(...st.items.map(rowEl));
      if (focused) list.querySelector(`.hd-row[data-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
      count.textContent = F.listCountText(st.items.length, st.total);
      more.hidden = !st.next;
      list.hidden = st.items.length === 0;
      if (st.items.length === 0) {
        const filtered = Boolean(st.q || st.status);
        listMsg.replaceChildren(
          filtered
            ? emptyBox('Aucun résultat', 'Essayez un autre nom, un autre matricule ou un autre numéro de badge, ou retirez le filtre de statut.')
            : emptyBox(
                'Aucun titulaire pour l’instant',
                isAdmin() ? 'Créez un titulaire, ou importez un fichier (onglet Import), pour lui donner un badge et des portes.' : 'Un administrateur doit d’abord créer les titulaires.',
                isAdmin() ? button('Créer un titulaire', { ic: 'plus', cls: 'btn btn-primary', onClick: () => openHolderForm(null) }) : null,
              ),
        );
      } else listMsg.replaceChildren();
    }

    function listError(err) {
      listMsg.replaceChildren(noticeBox('is-alarm', 'state-alarm', h('strong', { text: 'La liste n’a pas pu être lue. ' }), F.sentence(err.message), ' ', button('Réessayer', { cls: 'btn btn-sm', ic: 'refresh', onClick: (b) => run(b, () => loadList()) })));
    }

    async function loadList({ append = false } = {}) {
      const n = ++st.listSeq;
      if (!st.loaded && !append) listMsg.replaceChildren(h('p', { class: 'muted', role: 'status', text: 'Lecture des titulaires…' }));
      list.setAttribute('aria-busy', 'true');
      try {
        const data = await api(`/api/access/holders?${F.holdersQuery({ q: st.q, status: st.status, cursor: append ? st.next : null })}`);
        if (n !== st.listSeq) return;
        st.items = append ? [...st.items, ...data.items] : data.items;
        st.next = data.nextCursor ?? null;
        st.total = data.total ?? st.items.length;
        st.loaded = true;
        renderList();
      } catch (err) {
        if (n === st.listSeq) {
          if (append) toast(err.message);
          else listError(err);
        }
      } finally {
        if (n === st.listSeq) list.removeAttribute('aria-busy');
      }
    }

    // -- fiche

    function markSelected() {
      for (const row of list.querySelectorAll('.hd-row')) {
        if (row.getAttribute('data-id') === String(st.selectedId)) row.setAttribute('aria-current', 'true');
        else row.removeAttribute('aria-current');
      }
    }

    function openDetail(id) {
      st.selectedId = id;
      markSelected();
      panel.classList.add('has-detail');
      detail.hidden = false;
      if (!st.detail || st.detail.id !== id) {
        st.detail = null;
        detailBody.replaceChildren(h('p', { class: 'muted', role: 'status', text: 'Lecture de la fiche…' }));
      }
      return loadDetail(true);
    }

    function closeDetail() {
      const id = st.selectedId;
      st.selectedId = null;
      st.detail = null;
      st.detailSeq++;
      detail.hidden = true;
      panel.classList.remove('has-detail');
      markSelected();
      focusSoon(list.querySelector(`.hd-row[data-id="${CSS.escape(String(id))}"]`) ?? search);
    }

    async function loadDetail(focus) {
      const n = ++st.detailSeq;
      const id = st.selectedId;
      if (id === null) return;
      try {
        const d = await api(`/api/access/holders/${id}`);
        if (n !== st.detailSeq || id !== st.selectedId) return;
        st.detail = d;
        renderDetail();
        if (focus) focusSoon(detailBody.querySelector('#hd-detail-title'));
      } catch (err) {
        if (n !== st.detailSeq) return;
        detailBody.replaceChildren(
          noticeBox('is-alarm', 'state-alarm', h('strong', { text: 'La fiche n’a pas pu être lue. ' }), F.sentence(err.message)),
          h('div', { class: 'actions' }, button('Réessayer', { ic: 'refresh', cls: 'btn btn-sm', onClick: (b) => run(b, () => loadDetail(true)) }), button('Fermer la fiche', { ic: 'close', cls: 'btn btn-sm', onClick: closeDetail })),
        );
        if (focus) focusSoon(detailBody.querySelector('button'));
      }
    }

    /** Relit la fiche et la liste après une écriture. */
    const refreshAll = () => Promise.all([loadDetail(false), loadList()]);

    function photoEl(d) {
      if (d.hasPhoto) return h('img', { class: 'hd-photo', src: photoUrl(d.id), alt: `Photo de ${d.displayName}`, width: '96', height: '96' });
      return h('span', { class: 'hd-photo is-empty', role: 'img', 'aria-label': 'Pas de photo' }, icon('user'));
    }

    function renderDetail() {
      const d = st.detail;
      const admin = isAdmin();
      const name = d.displayName;
      const controllers = F.controllerCount(d.sync);
      const fact = (label, ...value) => [h('dt', { text: label }), h('dd', {}, ...value)];

      // en-tête : photo, identité, état
      const head = h(
        'header',
        { class: 'hd-detail-head' },
        photoEl(d),
        h(
          'div',
          { class: 'hd-detail-id' },
          h('h3', { id: 'hd-detail-title', tabindex: '-1', text: name }),
          h('p', { class: 'muted', text: d.externalRef ? `Matricule ${d.externalRef}` : 'Pas de matricule' }),
          h('div', { class: 'hd-pills' }, pill(F.holderStatusInfo(d), 'Statut : ')),
        ),
        button('Fermer la fiche', { ic: 'close', cls: 'btn btn-sm hd-close', onClick: closeDetail }),
      );

      // validité et groupes
      const groupItems = d.groups.map((g) => {
        const full = ref.groups.find((x) => x.id === g.id);
        return h('li', {}, h('strong', { text: g.name }), h('span', { class: 'muted', text: full ? ` : ${F.groupDoorsText(full)}` : '' }));
      });
      const identity = h(
        'section',
        { class: 'hd-section' },
        h('h4', { text: 'Validité et portes' }),
        h('dl', { class: 'hd-facts' }, ...fact('Validité', F.validityText(d.validFrom, d.validTo)), d.visitor ? fact('Accompagnateur', d.visitor.host) : null, d.visitor?.reason ? fact('Motif', d.visitor.reason) : null),
        groupItems.length
          ? h('div', {}, h('p', { class: 'hd-label', text: 'Groupes et portes qu’ils donnent' }), h('ul', { class: 'hd-plain' }, ...groupItems))
          : h('p', { class: 'muted', text: 'Aucun groupe : ce titulaire n’ouvre aucune porte.' }),
      );

      // badges
      const badgeItems = d.badges.map((b) => {
        const actions = [];
        if (admin && b.state === 'active') {
          actions.push(button('Désactiver le badge', { ic: 'lock', cls: 'btn btn-sm btn-danger', label: `Désactiver le badge ${b.number}`, onClick: () => deactivateBadge(b, d) }));
          actions.push(button('Rendre le badge', { ic: 'check', cls: 'btn btn-sm', label: `Rendre le badge ${b.number}`, onClick: () => changeBadge(b, d, 'returned') }));
        } else if (admin && (b.state === 'disabled' || b.state === 'lost')) {
          actions.push(button('Réactiver le badge', { ic: 'unlock', cls: 'btn btn-sm', label: `Réactiver le badge ${b.number}`, onClick: () => changeBadge(b, d, 'active') }));
          actions.push(button('Rendre le badge', { ic: 'check', cls: 'btn btn-sm', label: `Rendre le badge ${b.number}`, onClick: () => changeBadge(b, d, 'returned') }));
        }
        if (admin && (b.state === 'returned' || b.state === 'lost')) {
          actions.push(button('Supprimer de la fiche', { ic: 'trash', cls: 'btn btn-sm', label: `Supprimer le badge ${b.number} de la fiche`, onClick: () => removeBadgeRow(b, d) }));
        }
        return h(
          'li',
          { class: 'hd-badge' },
          h('code', { class: 'hd-badge-number', text: b.number }),
          pill(F.badgeInfo(b.state), 'État du badge : '),
          h('span', { class: 'hd-sub', text: `${F.badgeInfo(b.state).label === 'Actif' ? 'Depuis' : 'Depuis le'} ${F.dateTimeText(b.stateAt, now())}` }),
          actions.length ? h('span', { class: 'hd-badge-actions' }, ...actions) : null,
        );
      });
      const addInput = textInput('', { maxlength: '32', 'aria-required': 'true' });
      const addError = h('p', { class: 'form-error', role: 'alert' });
      const addForm = admin
        ? h('form', { class: 'hd-addbadge', novalidate: true }, field(h, 'Ajouter un badge (numéro)', addInput, 'Lettres, chiffres, tiret ; 32 caractères au plus.'), button('Ajouter le badge', { ic: 'plus', cls: 'btn' }), addError)
        : null;
      if (addForm) {
        addForm.querySelector('button').type = 'submit';
        addForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          clearInvalid(addForm, addError);
          const number = addInput.value.trim();
          if (!number) return markInvalid(addInput, addError, 'Indiquez le numéro du badge.');
          const problem = F.badgeProblem(number);
          if (problem) return markInvalid(addInput, addError, problem);
          const btn = addForm.querySelector('button');
          setBusy(btn, true);
          try {
            await api(`/api/access/holders/${d.id}/badges`, { method: 'POST', body: { number } });
            toast(`Badge ${number} ajouté à ${name}`, 'ok');
            await refreshAll();
            focusSoon(detailBody.querySelector('.hd-addbadge input'));
          } catch (err) {
            markInvalid(addInput, addError, err.message);
          } finally {
            setBusy(btn, false);
          }
        });
      }
      const badges = h(
        'section',
        { class: 'hd-section' },
        h('h4', { text: 'Badges' }),
        badgeItems.length ? h('ul', { class: 'hd-badges' }, ...badgeItems) : h('p', { class: 'muted', text: 'Aucun badge pour l’instant.' }),
        addForm,
      );

      // synchronisation par contrôleur
      const syncItems = (d.sync ?? []).map((s) => {
        const advice = F.holderSyncAdvice(s.state);
        return h(
          'li',
          { class: 'hd-sync-row' },
          h('div', { class: 'hd-sync-head' }, h('strong', { text: s.controllerName }), pill(F.holderSyncInfo(s.state), 'Synchronisation : ')),
          s.message ? h('p', { class: 'hd-sub', text: F.sentence(s.message) }) : null,
          s.state !== 'synced' && advice ? h('p', { class: 'hd-sub', text: `Que faire : ${advice}` }) : null,
        );
      });
      const sync = h(
        'section',
        { class: 'hd-section' },
        h('h4', { text: 'Synchronisation avec les contrôleurs' }),
        syncItems.length ? h('ul', { class: 'hd-plain hd-sync-list' }, ...syncItems) : h('p', { class: 'muted', text: 'Aucune porte : aucun contrôleur n’attend ce titulaire. Ajoutez-le à un groupe qui donne des portes.' }),
      );

      // derniers passages
      const passages = h(
        'section',
        { class: 'hd-section' },
        h('h4', { text: '10 derniers passages' }),
        d.recentPassages?.length
          ? h(
              'ul',
              { class: 'hd-plain hd-passages' },
              ...d.recentPassages.map((p) =>
                h(
                  'li',
                  {},
                  h('span', { class: 'hd-sub', text: F.dateTimeText(p.atDevice, now()) }),
                  h('span', { text: ` ${p.doorName ?? 'Porte retirée'}` }),
                  h('span', { class: `hd-result ${p.result === 'granted' ? 'is-ok' : 'is-alarm'}` }, icon(p.result === 'granted' ? 'state-ok' : 'state-alarm'), h('span', { text: p.resultLabel })),
                ),
              ),
            )
          : h('p', { class: 'muted', text: 'Aucun passage enregistré pour ce titulaire.' }),
      );

      // administration : photo, modifier, supprimer
      let adminBar = null;
      if (admin) {
        const file = h('input', { type: 'file', accept: 'image/*', class: 'sr-only', 'aria-label': 'Choisir une photo' });
        file.addEventListener('change', () => {
          const f = file.files?.[0];
          file.value = '';
          if (f) setPhoto(d, f);
        });
        const choose = h('label', { class: 'btn btn-sm hd-file' }, icon('image'), h('span', { text: d.hasPhoto ? 'Changer la photo' : 'Choisir une photo' }), file);
        adminBar = h(
          'section',
          { class: 'hd-section hd-admin' },
          h('h4', { text: 'Administration' }),
          h(
            'div',
            { class: 'actions' },
            button('Modifier', { ic: 'pencil', cls: 'btn', onClick: () => openHolderForm(d) }),
            choose,
            d.hasPhoto ? button('Retirer la photo', { ic: 'trash', cls: 'btn btn-sm', onClick: () => removePhoto(d) }) : null,
            button('Supprimer le titulaire', { ic: 'trash', cls: 'btn btn-danger', onClick: () => deleteHolder(d, controllers) }),
          ),
        );
      }

      // replaceChildren écrirait « null » pour un élément absent (l'opérateur n'a pas la barre d'administration).
      detailBody.replaceChildren(...[head, identity, badges, sync, passages, adminBar].filter(Boolean));
    }

    // -- actions sur les badges

    async function afterBadge(message, d) {
      toast(message, 'ok');
      await refreshAll();
      focusSoon(detailBody.querySelector('#hd-detail-title'));
    }

    /** « Désactiver le badge » : dit ce qui va se passer, propose Désactivé (réversible) ou Perdu (numéro réservé). */
    function deactivateBadge(badge, d) {
      let choice = 'disabled';
      const name = d.displayName;
      const lead = h('p', { class: 'dialog-lead', text: F.deactivateBadgeText({ number: badge.number, name, controllers: F.controllerCount(d.sync) }) });
      const group = uid('badge-choice');
      const confirmText = h('span', { text: 'Désactiver le badge' });
      const radios = F.BADGE_CHOICES.map((c, i) => {
        const input = h('input', { type: 'radio', name: group, value: c.value, checked: i === 0 });
        input.addEventListener('change', () => {
          if (!input.checked) return;
          choice = c.value;
          confirmText.textContent = c.value === 'lost' ? 'Déclarer le badge perdu' : 'Désactiver le badge';
        });
        return h('label', { class: 'hd-choice' }, input, h('span', { class: 'hd-choice-text' }, h('strong', { text: c.label }), h('span', { class: 'hint', text: c.hint })));
      });
      const error = h('p', { class: 'form-error', role: 'alert' });
      const ok = h('button', { class: 'btn btn-danger', type: 'button' }, icon('lock'), confirmText);
      const cancel = h('button', { class: 'btn', type: 'button', text: 'Annuler', 'data-autofocus': '' });
      cancel.addEventListener('click', () => dialogs.close());
      ok.addEventListener('click', async () => {
        error.textContent = '';
        setBusy(ok, true);
        try {
          await api(`/api/access/badges/${badge.id}`, { method: 'PATCH', body: { state: choice } });
          dialogs.close();
          await afterBadge(choice === 'lost' ? `Badge ${badge.number} déclaré perdu` : `Badge ${badge.number} désactivé`, d);
        } catch (err) {
          error.textContent = err.message;
        } finally {
          setBusy(ok, false);
        }
      });
      dialogs.open(
        'Désactiver le badge',
        h('div', { class: 'dialog-form hd-form' }, lead, h('fieldset', { class: 'hd-choices' }, h('legend', { text: 'Que devient ce badge ?' }), ...radios), error, h('div', { class: 'actions dialog-actions' }, cancel, ok)),
      );
    }

    async function changeBadge(badge, d, state) {
      const args = { number: badge.number, name: d.displayName, controllers: F.controllerCount(d.sync) };
      const texts = {
        active: { heading: 'Réactiver le badge', message: F.reactivateBadgeText(args), label: 'Réactiver le badge', done: `Badge ${badge.number} réactivé`, danger: false },
        returned: { heading: 'Rendre le badge', message: F.returnBadgeText(args), label: 'Rendre le badge', done: `Badge ${badge.number} rendu`, danger: true },
      }[state];
      const ok = await dialogs.confirm({
        heading: texts.heading,
        message: texts.message,
        confirmLabel: texts.label,
        danger: texts.danger,
        onConfirm: () => api(`/api/access/badges/${badge.id}`, { method: 'PATCH', body: { state } }),
      });
      if (ok) await afterBadge(texts.done, d);
    }

    /** Retire un vieux badge (rendu ou perdu) de la fiche : un titulaire garde 12 badges au plus, tous états confondus. */
    async function removeBadgeRow(badge, d) {
      const ok = await dialogs.confirm({
        heading: 'Supprimer le badge de la fiche',
        message: F.removeBadgeText({ number: badge.number, name: d.displayName, state: badge.state }),
        confirmLabel: 'Supprimer de la fiche',
        onConfirm: () => api(`/api/access/badges/${badge.id}`, { method: 'DELETE' }),
      });
      if (ok) await afterBadge(`Badge ${badge.number} supprimé de la fiche`, d);
    }

    // -- photo

    /** Image choisie -> carré de 192 px en JPEG (qualité 0,8, moins si le fichier dépasse la limite du serveur). */
    async function squareJpeg(file) {
      let bitmap;
      try {
        bitmap = await createImageBitmap(file);
      } catch {
        throw new Error('Ce fichier n’a pas pu être lu comme une image. Choisissez une photo JPEG, PNG ou WebP.');
      }
      const { sx, sy, side } = F.squareCrop(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = F.PHOTO_SIZE;
      canvas.height = F.PHOTO_SIZE;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; // une photo transparente (PNG) ne devient pas noire
      ctx.fillRect(0, 0, F.PHOTO_SIZE, F.PHOTO_SIZE);
      ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, F.PHOTO_SIZE, F.PHOTO_SIZE);
      bitmap.close?.();
      for (const quality of F.PHOTO_QUALITIES) {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (blob && blob.size <= F.PHOTO_MAX_BYTES) return blob;
      }
      throw new Error('La photo reste trop lourde (plus de 64 Ko) même réduite. Choisissez une autre photo.');
    }

    async function setPhoto(d, file) {
      if (!file.type.startsWith('image/')) {
        toast('Ce fichier n’est pas une image. Choisissez une photo JPEG, PNG ou WebP.');
        return;
      }
      try {
        const blob = await squareJpeg(file);
        await rawRequest(`/api/access/holders/${d.id}/photo`, { method: 'PUT', body: blob, contentType: 'image/jpeg' });
        photoVersion.set(d.id, (photoVersion.get(d.id) ?? 0) + 1);
        toast(`Photo de ${d.displayName} enregistrée`, 'ok');
        await refreshAll();
        focusSoon(detailBody.querySelector('#hd-detail-title'));
      } catch (err) {
        toast(err.message);
      }
    }

    async function removePhoto(d) {
      const ok = await dialogs.confirm({
        heading: 'Retirer la photo',
        message: `La photo de ${d.displayName} sera supprimée du PSIM. Elle n’a jamais quitté le PSIM : aucun contrôleur ne la détient.`,
        confirmLabel: 'Retirer la photo',
        onConfirm: () => api(`/api/access/holders/${d.id}/photo`, { method: 'DELETE' }),
      });
      if (!ok) return;
      photoVersion.set(d.id, (photoVersion.get(d.id) ?? 0) + 1);
      toast('Photo retirée', 'ok');
      await refreshAll();
      focusSoon(detailBody.querySelector('#hd-detail-title'));
    }

    async function deleteHolder(d, controllers) {
      const ok = await dialogs.confirm({
        heading: 'Supprimer le titulaire',
        message: F.deleteHolderText({ name: d.displayName, controllers }),
        confirmLabel: 'Supprimer le titulaire',
        onConfirm: () => api(`/api/access/holders/${d.id}`, { method: 'DELETE' }),
      });
      if (!ok) return;
      toast(`${d.displayName} supprimé`, 'ok');
      st.selectedId = null;
      st.detail = null;
      detail.hidden = true;
      panel.classList.remove('has-detail');
      await loadList();
      focusSoon(list.querySelector('.hd-row') ?? search);
    }

    // -- formulaire de création et de modification (administrateur)

    async function openHolderForm(existing) {
      const creating = !existing;
      await loadRef(); // la liste des groupes est celle d'aujourd'hui, pas celle d'il y a une heure
      const lastName = textInput(existing?.lastName ?? '', { maxlength: '40', 'aria-required': 'true' });
      const firstName = textInput(existing?.firstName ?? '', { maxlength: '40' });
      const externalRef = textInput(existing?.externalRef ?? '', { maxlength: '32' });
      const status = h('select', {}, h('option', { value: 'active', text: 'Actif' }), h('option', { value: 'suspended', text: 'Suspendu : il ne peut plus ouvrir aucune porte' }));
      status.value = existing?.status ?? 'active';
      const validFrom = h('input', { type: 'date', value: F.dateToInput(existing?.validFrom) });
      const validTo = h('input', { type: 'date', value: F.dateToInput(existing?.validTo) });
      const badges = creating ? textInput('', { placeholder: 'Ex. 0012345, 0012346' }) : null;

      const own = new Set((existing?.groups ?? []).map((g) => g.id));
      const choosable = ref.groups.filter((g) => !g.forVisitors || own.has(g.id));
      const boxes = choosable.map((g) => ({ g, input: h('input', { type: 'checkbox', value: String(g.id), checked: own.has(g.id) }) }));
      const groups = h(
        'fieldset',
        { class: 'hd-choices' },
        h('legend', { text: 'Groupes (ils décident des portes et des horaires)' }),
        boxes.length
          ? boxes.map(({ g, input }) => h('label', { class: 'check hd-group-check' }, input, h('span', {}, h('strong', { text: g.name }), h('span', { class: 'hint', text: ` ${F.groupDoorsText(g)}` }))))
          : h('p', { class: 'muted', text: 'Aucun groupe n’existe. Sans groupe, ce titulaire n’ouvrira aucune porte : créez-en dans « Groupes et horaires ».' }),
      );

      const formValues = () => ({
        lastName: lastName.value,
        firstName: firstName.value,
        externalRef: externalRef.value,
        status: status.value,
        validFrom: validFrom.value,
        validTo: validTo.value,
        groupIds: boxes.filter((b) => b.input.checked).map((b) => b.g.id),
        badges: badges?.value ?? '',
      });

      const result = await openFormDialog({
        heading: creating ? 'Nouveau titulaire' : `Modifier ${existing.displayName}`,
        children: [
          h('div', { class: 'form-grid' }, field(h, 'Nom de famille', lastName), field(h, 'Prénom (facultatif)', firstName)),
          field(h, 'Matricule (facultatif)', externalRef, 'Numéro interne, unique. Il sert aussi à mettre à jour la fiche par un import.'),
          field(h, 'Statut', status),
          h('div', { class: 'form-grid' }, field(h, 'Valable à partir du', validFrom, 'Vide : sans limite.'), field(h, 'Valable jusqu’au (inclus)', validTo, 'Vide : sans limite.')),
          badges ? field(h, 'Badges (facultatif)', badges, '4 au plus, séparés par une virgule ou un espace. Ils sont créés actifs.') : null,
          groups,
        ],
        submitLabel: creating ? 'Créer le titulaire' : 'Enregistrer',
        submitIcon: 'check',
        validate: () => {
          const message = F.holderFormProblem(formValues(), { creating });
          return message ? { message, input: !lastName.value.trim() ? lastName : null } : null;
        },
        onSubmit: () => {
          const body = F.holderBody(formValues(), { creating });
          return creating ? api('/api/access/holders', { method: 'POST', body }) : api(`/api/access/holders/${existing.id}`, { method: 'PUT', body });
        },
      });
      if (!result) return;
      toast(creating ? `${result.displayName ?? 'Titulaire'} créé` : 'Modifications enregistrées', 'ok');
      if (creating && result.id) {
        await loadList();
        await openDetail(result.id);
      } else {
        await refreshAll();
        focusSoon(detailBody.querySelector('#hd-detail-title'));
      }
    }

    return {
      panel,
      async enter() {
        newBtn.hidden = !isAdmin();
        if (!ref.loaded) await loadRef();
        await loadList();
        // Une fiche ouverte est relue, sauf si un numéro de badge y est en cours de saisie.
        if (st.selectedId !== null && !detailBody.querySelector('.hd-addbadge input')?.value) await loadDetail(false);
      },
      leave() {},
      reset() {
        st.items = [];
        st.next = null;
        st.total = 0;
        st.loaded = false;
        st.selectedId = null;
        st.detail = null;
        st.detailSeq++;
        detail.hidden = true;
        panel.classList.remove('has-detail');
        list.replaceChildren();
        listMsg.replaceChildren();
        newBtn.hidden = !isAdmin();
      },
      /** Un import vient de modifier les titulaires. */
      stale() {
        st.loaded = false;
      },
    };
  }

  // ================================================================= onglet Visiteurs

  function createVisitorsTab() {
    const st = { visitors: [], showRecent: false, loaded: false, seq: 0 };

    const lastName = textInput('', { maxlength: '40', 'aria-required': 'true', autocomplete: 'off' });
    const firstName = textInput('', { maxlength: '40' });
    const host = textInput('', { maxlength: '64', 'aria-required': 'true' });
    const reason = textInput('', { maxlength: '120' });
    const badge = textInput('', { maxlength: '32', 'aria-required': 'true', inputmode: 'text' });
    const groupSel = h('select', { 'aria-required': 'true' });
    const customMinutes = h('input', { type: 'text', inputmode: 'numeric', maxlength: '5', autocomplete: 'off' });
    const customField = field(h, 'Durée en minutes', customMinutes, 'De 15 à 44 640 (31 jours).');
    customField.hidden = true;
    const endline = h('p', { class: 'hd-endline', role: 'status', 'aria-live': 'polite' });
    const formError = h('p', { class: 'form-error', role: 'alert' });
    const submit = button('Enregistrer la visite', { ic: 'check', cls: 'btn btn-primary' });
    submit.type = 'submit';

    let duration = '1h';
    const durationName = uid('visit-duration');
    const durationInputs = F.VISITOR_DURATIONS.map((d) => {
      const input = h('input', { type: 'radio', name: durationName, value: d.id, checked: d.id === duration });
      input.addEventListener('change', () => {
        if (!input.checked) return;
        duration = d.id;
        customField.hidden = d.id !== 'custom';
        if (d.id === 'custom') customMinutes.focus();
        updateEndline();
      });
      return { d, label: h('label', { class: 'hd-choice hd-choice-sm' }, input, h('span', { text: d.label })) };
    });
    customMinutes.addEventListener('input', updateEndline);

    const noGroup = emptyBox('Aucun groupe n’est prévu pour les visiteurs.', 'Demandez à un administrateur d’en créer un dans Groupes et horaires.');
    noGroup.hidden = true;

    const form = h(
      'form',
      { class: 'hd-visit-form', novalidate: true },
      h('div', { class: 'form-grid' }, field(h, 'Nom du visiteur', lastName), field(h, 'Prénom (facultatif)', firstName)),
      h('div', { class: 'form-grid' }, field(h, 'Accompagnateur', host, 'La personne de la maison ou de l’entreprise qui reçoit.'), field(h, 'Motif (facultatif)', reason)),
      h('div', { class: 'form-grid' }, field(h, 'Numéro du badge remis', badge), field(h, 'Groupe du visiteur', groupSel)),
      h('fieldset', { class: 'hd-choices' }, h('legend', { text: 'Durée de la visite' }), h('div', { class: 'hd-choice-row' }, ...durationInputs.map((x) => x.label)), customField),
      endline,
      formError,
      h('div', { class: 'actions' }, submit),
    );

    const recentBox = h('input', { type: 'checkbox' });
    const count = h('p', { class: 'hd-count', role: 'status', 'aria-live': 'polite' });
    const list = h('ul', { class: 'hd-visits', 'aria-label': 'Visites' });
    const listMsg = h('div', { class: 'hd-list-msg' });

    const panel = h(
      'div',
      { class: 'hd-visitors' },
      h('section', { class: 'panel hd-card' }, h('div', { class: 'panel-head' }, h('h3', { text: 'Nouveau visiteur' })), h('div', { class: 'panel-body' }, noGroup, form)),
      h(
        'section',
        { class: 'panel hd-card' },
        h('div', { class: 'panel-head' }, h('h3', { text: 'Visiteurs en cours' }), h('label', { class: 'check hd-apart' }, recentBox, h('span', { text: 'Afficher aussi les visites terminées depuis moins de 24 h' }))),
        h('div', { class: 'panel-body' }, count, listMsg, list),
      ),
    );

    function currentEnd() {
      return F.visitorEnd({ now: now(), choice: duration, customMinutes: customMinutes.value });
    }

    function updateEndline() {
      const end = currentEnd();
      endline.classList.toggle('is-problem', !end.ok);
      endline.textContent = end.ok ? F.endSentence(end.endsAt, now()) : end.problem;
    }

    /** Remplit la liste des groupes « visiteurs » sans perdre le choix en cours. */
    function syncGroups() {
      const groups = ref.groups.filter((g) => g.forVisitors);
      const previous = groupSel.value;
      groupSel.replaceChildren(...(groups.length === 1 ? [] : [h('option', { value: '', text: 'Choisir un groupe…' })]), ...groups.map((g) => h('option', { value: String(g.id), text: g.name })));
      if (groups.some((g) => String(g.id) === previous)) groupSel.value = previous;
      else if (groups.length === 1) groupSel.value = String(groups[0].id);
      const none = groups.length === 0;
      noGroup.hidden = !none;
      form.hidden = none;
      if (none) {
        const hint = noGroup.querySelector('span');
        if (hint) hint.textContent = isAdmin() ? 'Créez-en un dans l’onglet Groupes et horaires, en cochant « Pour les visiteurs ».' : 'Demandez à un administrateur d’en créer un dans Groupes et horaires.';
      }
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearInvalid(form, formError);
      const end = currentEnd();
      const out = F.visitorBody({ lastName: lastName.value, firstName: firstName.value, host: host.value, reason: reason.value, badge: badge.value, groupId: groupSel.value }, end);
      if (out.problem) {
        const target = { lastName, host, reason, badge, groupId: groupSel, duration: duration === 'custom' ? customMinutes : null }[out.field];
        return markInvalid(target ?? null, formError, out.problem);
      }
      setBusy(submit, true);
      try {
        const visit = await api('/api/access/visitors', { method: 'POST', body: out.body });
        toast(`Visite enregistrée. ${F.endSentence(visit.endsAt, now())}`, 'ok');
        for (const input of [lastName, firstName, host, reason, badge, customMinutes]) input.value = '';
        updateEndline();
        await load();
        lastName.focus();
      } catch (err) {
        formError.textContent = err.message;
      } finally {
        setBusy(submit, false);
      }
    });

    recentBox.addEventListener('change', () => {
      st.showRecent = recentBox.checked;
      load();
    });

    function visitEl(v) {
      const state = VISIT_STATE[v.state] ?? VISIT_STATE.ended;
      const name = v.holder.displayName;
      const number = F.visitorBadgeNumber(v.holder);
      const rows = [
        ['Accompagnateur', v.host],
        v.reason ? ['Motif', v.reason] : null,
        ['Badge', number ? h('code', { text: number }) : '—'],
        F.visitTimeRow(v, now()),
        ['Dernier passage', F.lastPassageText(v.lastPassage, now())],
      ].filter(Boolean);
      const dl = h('dl', { class: 'hd-facts' }, ...rows.flatMap(([k, val]) => [h('dt', { text: k }), h('dd', {}, val)]));
      const actions =
        v.state === 'ended'
          ? null
          : h('div', { class: 'actions' }, button('Rendre le badge', { ic: 'check', cls: 'btn btn-sm', label: `Rendre le badge de ${name}`, fk: `end-${v.holder.id}`, onClick: () => endVisit(v) }));
      return h('li', { class: `hd-visit${v.state === 'ended' ? ' is-ended' : ''}` }, h('div', { class: 'hd-visit-head' }, h('strong', { class: 'hd-name', text: name }), pill(state, 'État de la visite : ')), dl, actions);
    }

    async function endVisit(v) {
      const name = v.holder.displayName;
      const ok = await dialogs.confirm({
        heading: 'Rendre le badge',
        message: F.endVisitText({ number: F.visitorBadgeNumber(v.holder), name }),
        confirmLabel: 'Rendre le badge',
        onConfirm: () => api(`/api/access/visitors/${v.holder.id}/end`, { method: 'POST' }),
      });
      if (!ok) return;
      toast(`Visite de ${name} terminée, badge rendu`, 'ok');
      await load();
      focusSoon(list.querySelector('button') ?? lastName);
    }

    function renderList() {
      keepFocus(list, () => list.replaceChildren(...st.visitors.map(visitEl)));
      const active = st.visitors.filter((v) => v.state !== 'ended').length;
      count.textContent = st.visitors.length === 0 ? '' : `${F.plural(active, 'visite en cours', 'visites en cours')}${st.visitors.length > active ? `, ${st.visitors.length - active} terminée${st.visitors.length - active > 1 ? 's' : ''}` : ''}`;
      list.hidden = st.visitors.length === 0;
      listMsg.replaceChildren(
        ...(st.visitors.length === 0
          ? [emptyBox('Aucune visite en cours', 'Quand un visiteur arrive, remplissez le formulaire ci-dessus : son badge s’arrête tout seul à l’heure de fin.')]
          : []),
      );
    }

    async function load() {
      const n = ++st.seq;
      try {
        const data = await api(`/api/access/visitors?scope=${st.showRecent ? 'recent' : 'current'}`);
        if (n !== st.seq) return;
        st.visitors = asList(data, 'visitors');
        st.loaded = true;
        renderList();
      } catch (err) {
        if (n !== st.seq) return;
        listMsg.replaceChildren(noticeBox('is-alarm', 'state-alarm', h('strong', { text: 'Les visites n’ont pas pu être lues. ' }), F.sentence(err.message), ' ', button('Réessayer', { cls: 'btn btn-sm', ic: 'refresh', onClick: (b) => run(b, load) })));
      }
    }

    updateEndline();
    return {
      panel,
      async enter() {
        updateEndline();
        if (!ref.loaded) await loadRef();
        syncGroups();
        await load();
      },
      leave() {},
      refreshTick() {
        updateEndline();
      },
      reload: load,
      reset() {
        st.visitors = [];
        st.loaded = false;
        list.replaceChildren();
        listMsg.replaceChildren();
      },
    };
  }

  // ================================================================= onglet Groupes et horaires

  function createGroupsTab() {
    const groupsBox = h('div', { class: 'hd-box' });
    const schedulesBox = h('div', { class: 'hd-box' });
    const holidaysBox = h('div', { class: 'hd-box' });
    const loadMsg = h('div', { class: 'hd-list-msg' });
    const readOnly = noticeBox('is-info', 'info', 'Vous pouvez consulter les groupes, les horaires et les jours fériés. Seul un administrateur peut les modifier.');
    readOnly.hidden = true;
    const newGroup = button('Nouveau groupe', { ic: 'plus', cls: 'btn btn-primary hd-apart', onClick: () => openGroupForm(null), hidden: true });
    const newSchedule = button('Nouvelle plage horaire', { ic: 'plus', cls: 'btn btn-primary hd-apart', onClick: () => openScheduleForm(null), hidden: true });
    const section = (title, intro, add, box) => h('section', { class: 'panel hd-card' }, h('div', { class: 'panel-head' }, h('h3', { text: title }), add), h('div', { class: 'panel-body' }, h('p', { class: 'muted', text: intro }), box));
    const panel = h(
      'div',
      { class: 'hd-groups' },
      readOnly,
      loadMsg,
      section('Groupes', 'Un groupe donne des portes, chacune avec une plage horaire. Un titulaire a les portes de tous ses groupes.', newGroup, groupsBox),
      section('Plages horaires', 'Les jours et les heures où une porte s’ouvre pour un groupe.', newSchedule, schedulesBox),
      section('Jours fériés', 'Les plages réglées sur « Fermé les jours fériés » ne s’ouvrent pas ces jours-là.', null, holidaysBox),
    );

    // -- groupes

    function renderGroups() {
      const admin = isAdmin();
      if (!ref.groups.length) {
        groupsBox.replaceChildren(emptyBox('Aucun groupe pour l’instant', admin ? 'Créez un groupe (par exemple « Personnel »), choisissez ses portes, puis mettez-y des titulaires.' : 'Un administrateur doit créer les groupes.'));
        return;
      }
      groupsBox.replaceChildren(
        h(
          'ul',
          { class: 'hd-cards' },
          ...ref.groups.map((g) =>
            h(
              'li',
              { class: 'hd-gcard' },
              h('div', { class: 'hd-gcard-head' }, h('strong', { class: 'hd-name', text: g.name }), g.forVisitors ? h('span', { class: 'tag is-info', text: 'Pour les visiteurs' }) : null, h('span', { class: 'hd-sub', text: F.plural(g.holderCount, 'titulaire') })),
              g.description ? h('p', { class: 'muted', text: g.description }) : null,
              h('p', {}, h('span', { class: 'hd-label', text: 'Portes : ' }), F.groupDoorsText(g)),
              admin
                ? h(
                    'div',
                    { class: 'actions' },
                    button('Modifier', { ic: 'pencil', cls: 'btn btn-sm', label: `Modifier le groupe ${g.name}`, fk: `ge-${g.id}`, onClick: () => openGroupForm(g) }),
                    button('Supprimer', { ic: 'trash', cls: 'btn btn-sm btn-danger', label: `Supprimer le groupe ${g.name}`, fk: `gd-${g.id}`, onClick: () => deleteGroup(g) }),
                  )
                : null,
            ),
          ),
        ),
      );
    }

    async function deleteGroup(g) {
      const ok = await dialogs.confirm({
        heading: 'Supprimer le groupe',
        message: F.deleteGroupText({ name: g.name, holders: g.holderCount }),
        confirmLabel: 'Supprimer le groupe',
        onConfirm: () => api(`/api/access/groups/${g.id}`, { method: 'DELETE' }),
      });
      if (!ok) return;
      toast(`Groupe « ${g.name} » supprimé`, 'ok');
      await reload();
    }

    async function openGroupForm(existing) {
      const name = textInput(existing?.name ?? '', { maxlength: '60', 'aria-required': 'true' });
      const description = textInput(existing?.description ?? '', { maxlength: '200' });
      const forVisitors = h('input', { type: 'checkbox', checked: Boolean(existing?.forVisitors) });
      const builtin = ref.schedules.find((s) => s.builtin) ?? ref.schedules[0];
      const owned = new Map((existing?.doors ?? []).map((d) => [d.doorId, d]));
      const knownIds = new Set(ref.doors.map((d) => d.detectorId));
      // Les portes déclarées, puis celles que le groupe cite encore alors qu'elles n'existent plus (à décocher).
      const rows = [
        ...ref.doors.map((d) => ({ doorId: d.detectorId, label: d.name, sub: d.controllerName ?? '' })),
        ...[...owned.values()].filter((d) => !knownIds.has(d.doorId)).map((d) => ({ doorId: d.doorId, label: 'Porte non déclarée', sub: `identifiant ${d.doorId}` })),
      ].map((r) => {
        const cur = owned.get(r.doorId);
        const check = h('input', { type: 'checkbox', checked: Boolean(cur) });
        const sel = h('select', { 'aria-label': `Plage horaire de la porte ${r.label}`, disabled: !cur }, ...ref.schedules.map((s) => h('option', { value: String(s.id), text: s.name })));
        sel.value = String(cur?.scheduleId ?? builtin?.id ?? '');
        check.addEventListener('change', () => (sel.disabled = !check.checked));
        return { ...r, check, sel, el: h('div', { class: 'hd-doorrow' }, h('label', { class: 'check' }, check, h('span', {}, h('strong', { text: r.label }), r.sub ? h('span', { class: 'hint', text: ` ${r.sub}` }) : null)), sel) };
      });
      const doorsField = h(
        'fieldset',
        { class: 'hd-choices' },
        h('legend', { text: 'Portes autorisées et plage horaire de chacune' }),
        rows.length ? rows.map((r) => r.el) : h('p', { class: 'muted', text: 'Aucune porte n’est déclarée pour l’instant. Déclarez les portes du contrôle d’accès, puis revenez ici.' }),
      );
      const chosen = () => rows.filter((r) => r.check.checked).map((r) => ({ doorId: r.doorId, scheduleId: r.sel.value }));
      const done = await openFormDialog({
        heading: existing ? `Modifier le groupe ${existing.name}` : 'Nouveau groupe',
        children: [field(h, 'Nom du groupe', name), field(h, 'Description (facultatif)', description), h('label', { class: 'check' }, forVisitors, h('span', { text: 'Pour les visiteurs (l’opérateur peut le donner depuis le poste de garde)' })), doorsField],
        submitLabel: existing ? 'Enregistrer' : 'Créer le groupe',
        submitIcon: 'check',
        validate: () => {
          const message = F.groupProblem({ name: name.value, doors: chosen() });
          return message ? { message, input: !name.value.trim() ? name : null } : null;
        },
        onSubmit: () => {
          const body = F.groupBody({ name: name.value, description: description.value, forVisitors: forVisitors.checked, doors: chosen() });
          return existing ? api(`/api/access/groups/${existing.id}`, { method: 'PUT', body }) : api('/api/access/groups', { method: 'POST', body });
        },
      });
      if (!done) return;
      toast(existing ? 'Groupe enregistré' : 'Groupe créé', 'ok');
      await reload();
    }

    // -- plages horaires

    function renderSchedules() {
      const admin = isAdmin();
      if (!ref.schedules.length) {
        schedulesBox.replaceChildren(emptyBox('Aucune plage horaire', 'La plage « Tout le temps » apparaît ici dès que le serveur l’a créée.'));
        return;
      }
      schedulesBox.replaceChildren(
        h(
          'ul',
          { class: 'hd-cards' },
          ...ref.schedules.map((s) =>
            h(
              'li',
              { class: 'hd-gcard' },
              h(
                'div',
                { class: 'hd-gcard-head' },
                h('strong', { class: 'hd-name', text: s.name }),
                s.builtin ? h('span', { class: 'tag', text: 'Plage du système, non modifiable' }) : null,
                s.closedOnHolidays ? h('span', { class: 'tag is-warning', text: 'Fermé les jours fériés' }) : null,
                h('span', { class: 'hd-sub', text: `Utilisée par ${F.plural(s.groupCount, 'groupe')}` }),
              ),
              h('p', { text: F.scheduleSummary(s) }),
              admin && !s.builtin
                ? h(
                    'div',
                    { class: 'actions' },
                    button('Modifier', { ic: 'pencil', cls: 'btn btn-sm', label: `Modifier la plage ${s.name}`, fk: `se-${s.id}`, onClick: () => openScheduleForm(s) }),
                    button('Supprimer', { ic: 'trash', cls: 'btn btn-sm btn-danger', label: `Supprimer la plage ${s.name}`, fk: `sd-${s.id}`, onClick: () => deleteSchedule(s) }),
                  )
                : null,
            ),
          ),
        ),
      );
    }

    async function deleteSchedule(s) {
      const ok = await dialogs.confirm({
        heading: 'Supprimer la plage horaire',
        message: s.groupCount > 0 ? `La plage « ${s.name} » est utilisée par ${F.plural(s.groupCount, 'groupe')} : le serveur refusera de la supprimer tant qu’un groupe s’en sert.` : `La plage « ${s.name} » sera supprimée. Cette action ne peut pas être annulée.`,
        confirmLabel: 'Supprimer la plage',
        onConfirm: () => api(`/api/access/schedules/${s.id}`, { method: 'DELETE' }),
      });
      if (!ok) return;
      toast(`Plage « ${s.name} » supprimée`, 'ok');
      await reload();
    }

    async function openScheduleForm(existing) {
      const name = textInput(existing?.name ?? '', { maxlength: '60', 'aria-required': 'true' });
      const closed = h('input', { type: 'checkbox', checked: Boolean(existing?.closedOnHolidays) });
      const draft = (existing?.windows ?? [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }]).map((w) => ({ days: [...w.days], from: w.from, to: w.to }));
      const slots = h('ol', { class: 'hd-slots' });
      const add = button('Ajouter une plage', { ic: 'plus', cls: 'btn btn-sm', onClick: () => addSlot() });
      const limit = h('p', { class: 'hint', text: `${F.MAX_WINDOWS} plages au plus.` });

      const slotEl = (w, i) => {
        const n = i + 1;
        const err = h('p', { class: 'form-error', role: 'alert' });
        const from = h('input', { type: 'time', value: w.from, 'aria-required': 'true' });
        const to = h('input', { type: 'time', value: w.to, 'aria-required': 'true' });
        const check = () => (err.textContent = w.days.length === 0 || (from.value && to.value && from.value === to.value) ? (F.windowProblem(w) ?? '') : '');
        const days = F.DAY_ORDER.map((d) => {
          const b = h('button', { class: 'btn btn-sm hd-day', type: 'button', 'aria-pressed': String(w.days.includes(d)), 'aria-label': F.DAY_LONG[d], text: F.DAY_SHORT[d] });
          b.addEventListener('click', () => {
            w.days = w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d];
            b.setAttribute('aria-pressed', String(w.days.includes(d)));
            check();
          });
          return b;
        });
        from.addEventListener('input', () => ((w.from = from.value), check()));
        to.addEventListener('input', () => ((w.to = to.value), check()));
        const drop = h('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, icon('trash'), h('span', { text: 'Retirer' }), h('span', { class: 'sr-only', text: ` la plage ${n}` }));
        drop.addEventListener('click', () => {
          draft.splice(i, 1);
          drawSlots();
          (slots.children[i] ?? slots.children[i - 1])?.querySelector('.hd-day')?.focus();
          if (draft.length === 0) add.focus();
        });
        return h(
          'li',
          { class: 'hd-slot' },
          h('fieldset', {}, h('legend', { text: `Plage ${n}` }), h('div', { class: 'hd-days', role: 'group', 'aria-label': `Jours de la plage ${n}` }, ...days), h('div', { class: 'hd-hours' }, field(h, 'De', from), field(h, 'À', to), drop), h('p', { class: 'hint', text: 'Pour aller jusqu’à minuit, indiquez 00:00. Une fin avant le début se termine le lendemain.' }), err),
        );
      };
      function drawSlots() {
        slots.replaceChildren(...draft.map(slotEl));
        add.disabled = draft.length >= F.MAX_WINDOWS;
      }
      function addSlot() {
        draft.push({ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' });
        drawSlots();
        slots.lastElementChild?.querySelector('.hd-day')?.focus();
      }
      drawSlots();

      const done = await openFormDialog({
        heading: existing ? `Modifier la plage ${existing.name}` : 'Nouvelle plage horaire',
        children: [
          field(h, 'Nom de la plage', name, 'Exemples : « Heures de bureau », « Nuit et week-end ».'),
          h('div', { class: 'hd-slots-box' }, h('p', { class: 'hd-label', text: 'Jours et heures où la porte s’ouvre' }), slots, add, limit),
          h('label', { class: 'check' }, closed, h('span', { text: 'Fermé les jours fériés' })),
        ],
        submitLabel: existing ? 'Enregistrer' : 'Créer la plage',
        submitIcon: 'check',
        validate: () => {
          const message = F.scheduleProblem({ name: name.value, windows: draft });
          return message ? { message, input: !name.value.trim() ? name : null } : null;
        },
        onSubmit: () => {
          const body = F.scheduleBody({ name: name.value, windows: draft, closedOnHolidays: closed.checked });
          return existing ? api(`/api/access/schedules/${existing.id}`, { method: 'PUT', body }) : api('/api/access/schedules', { method: 'POST', body });
        },
      });
      if (!done) return;
      toast(existing ? 'Plage enregistrée' : 'Plage créée', 'ok');
      await reload();
    }

    // -- jours fériés : liste de dates, enregistrée en un seul PUT

    let draftHolidays = [];
    let holidaysDirty = false;
    const holidayRows = h('ul', { class: 'hd-holidays' });
    const holidayError = h('p', { class: 'form-error', role: 'alert' });
    const addHoliday = button('Ajouter un jour férié', { ic: 'plus', cls: 'btn btn-sm', onClick: () => addHolidayRow() });
    const saveHolidays = button('Enregistrer les jours fériés', { ic: 'check', cls: 'btn btn-primary', onClick: () => doSaveHolidays() });
    const holidayEmpty = h('p', { class: 'muted', text: 'Aucun jour férié enregistré. Les plages « Fermé les jours fériés » n’ont alors aucun effet.' });
    const holidayView = h('div', { class: 'hd-readonly' });
    const holidayEdit = h('div', { class: 'hd-edit' }, holidayEmpty, holidayRows, holidayError, h('div', { class: 'actions' }, addHoliday, saveHolidays));
    holidaysBox.append(holidayView, holidayEdit);

    function resetHolidays() {
      draftHolidays = ref.holidays.map((x) => ({ date: x.date, label: x.label ?? '' }));
      holidaysDirty = false;
    }

    function holidayRowEl(entry, i) {
      const date = h('input', { type: 'date', value: entry.date, 'aria-label': `Date du jour férié ${i + 1}`, 'data-fk': `hdate-${i}` });
      const label = textInput(entry.label, { maxlength: '60', placeholder: 'Libellé (ex. Fête nationale)', 'aria-label': `Libellé du jour férié ${i + 1}` });
      const edit = (key, input) =>
        input.addEventListener('input', () => {
          entry[key] = input.value;
          holidaysDirty = true;
          holidayError.textContent = '';
        });
      edit('date', date);
      edit('label', label);
      const drop = button('Retirer', { ic: 'trash', cls: 'btn btn-sm btn-ghost', label: `Retirer le jour férié ${i + 1}`, onClick: () => {
        draftHolidays.splice(i, 1);
        holidaysDirty = true;
        drawHolidays();
        (holidayRows.children[i] ?? holidayRows.children[i - 1])?.querySelector('button')?.focus();
        if (draftHolidays.length === 0) addHoliday.focus();
      } });
      return h('li', { class: 'hd-holiday' }, date, label, drop);
    }

    function drawHolidays() {
      holidayRows.replaceChildren(...draftHolidays.map(holidayRowEl));
      holidayEmpty.hidden = draftHolidays.length > 0;
      holidayRows.hidden = draftHolidays.length === 0;
      addHoliday.disabled = draftHolidays.length >= F.MAX_HOLIDAYS;
    }

    function addHolidayRow() {
      draftHolidays.push({ date: '', label: '' });
      holidaysDirty = true;
      drawHolidays();
      holidayRows.lastElementChild?.querySelector('input')?.focus();
    }

    async function doSaveHolidays() {
      holidayError.textContent = '';
      const problem = F.holidaysProblem(draftHolidays);
      if (problem) {
        holidayError.textContent = problem;
        return;
      }
      setBusy(saveHolidays, true);
      try {
        const saved = await api('/api/access/holidays', { method: 'PUT', body: F.holidaysBody(draftHolidays) });
        ref.holidays = asList(saved, 'holidays');
        resetHolidays();
        drawHolidays();
        toast('Jours fériés enregistrés', 'ok');
      } catch (err) {
        holidayError.textContent = err.message;
      } finally {
        setBusy(saveHolidays, false);
      }
    }

    function renderHolidays() {
      const admin = isAdmin();
      holidayEdit.hidden = !admin;
      holidayView.hidden = admin;
      if (admin) {
        if (!holidaysDirty) resetHolidays();
        if (!holidaysDirty || holidayRows.children.length !== draftHolidays.length) drawHolidays();
        return;
      }
      holidayView.replaceChildren(
        ref.holidays.length
          ? h('ul', { class: 'hd-plain' }, ...ref.holidays.map((x) => {
              const ms = F.dateInputToStart(x.date);
              return h('li', {}, h('strong', { text: ms === null ? x.date : `${F.DAY_LONG[new Date(ms).getDay()]} ${F.dateText(ms)}` }), x.label ? h('span', { class: 'muted', text: ` : ${x.label}` }) : null);
            }))
          : h('p', { class: 'muted', text: 'Aucun jour férié enregistré.' }),
      );
    }

    function renderAll() {
      const admin = isAdmin();
      readOnly.hidden = admin;
      newGroup.hidden = !admin;
      newSchedule.hidden = !admin;
      keepFocus(groupsBox, renderGroups);
      keepFocus(schedulesBox, renderSchedules);
      renderHolidays();
    }

    async function reload() {
      const error = await loadRef();
      loadMsg.replaceChildren(
        ...(error ? [noticeBox('is-alarm', 'state-alarm', h('strong', { text: 'Toutes les données n’ont pas pu être lues. ' }), F.sentence(error), ' ', button('Réessayer', { cls: 'btn btn-sm', ic: 'refresh', onClick: (b) => run(b, reload) }))] : []),
      );
      renderAll();
    }

    return {
      panel,
      enter: reload,
      leave() {},
      reset() {
        draftHolidays = [];
        holidaysDirty = false;
        holidayRows.replaceChildren();
        renderAll();
      },
    };
  }

  // ================================================================= onglet Import

  function createImportTab() {
    const st = { file: null, verifiedKey: '', report: null, busy: false };

    const fileInput = h('input', { type: 'file', accept: '.csv,text/csv,text/plain' });
    const fileHint = h('p', { class: 'hint', text: 'Aucun fichier choisi.' });
    const verify = button('Vérifier', { ic: 'search', cls: 'btn btn-primary', onClick: () => doVerify() });
    verify.disabled = true;
    const commit = button('Importer pour de bon', { ic: 'upload', cls: 'btn', onClick: () => doImport() });
    commit.disabled = true;
    const gate = h('p', { class: 'hint', text: 'Vérifiez d’abord le fichier : l’import n’est possible qu’après une vérification du même fichier.' });
    const reportBox = h('div', { class: 'hd-report', 'aria-live': 'polite' });
    const errorBox = h('div', { class: 'hd-list-msg' });

    const download = button('Télécharger le modèle', { ic: 'download', cls: 'btn', onClick: downloadTemplate });

    const columns = h(
      'dl',
      { class: 'hd-columns' },
      ...F.IMPORT_COLUMNS.flatMap((c) => [h('dt', {}, h('code', { text: c.name }), c.required ? h('span', { class: 'tag is-alarm', text: 'obligatoire' }) : null), h('dd', { text: c.text })]),
    );

    const panel = h(
      'div',
      { class: 'hd-import' },
      h(
        'section',
        { class: 'panel hd-card' },
        h('div', { class: 'panel-head' }, h('h3', { text: 'Importer des titulaires depuis un fichier' })),
        h(
          'div',
          { class: 'panel-body' },
          h('p', { text: 'Un fichier CSV (Excel, enregistré au format CSV) avec une ligne par personne. La première ligne donne le nom des colonnes. 1 Mo et 5 000 lignes au plus.' }),
          columns,
          h('p', { class: 'muted', text: 'Une ligne invalide est ignorée et signalée avec sa raison ; les autres sont appliquées. Les groupes cités doivent déjà exister. Avec un matricule connu, la fiche est mise à jour ; sinon elle est créée. Les visiteurs ne s’importent pas.' }),
          h('div', { class: 'actions' }, download),
        ),
      ),
      h(
        'section',
        { class: 'panel hd-card' },
        h('div', { class: 'panel-head' }, h('h3', { text: 'Vérifier puis importer' })),
        h('div', { class: 'panel-body' }, field(h, 'Fichier CSV', fileInput), fileHint, h('div', { class: 'actions' }, verify, commit), gate, errorBox, reportBox),
      ),
    );

    function downloadTemplate() {
      const blob = new Blob([F.templateCsv()], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: F.TEMPLATE_FILENAME });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }

    function syncButtons() {
      const same = st.file && F.fileKey(st.file) === st.verifiedKey;
      verify.disabled = !st.file || st.busy;
      const doable = same && st.report && !st.report.fatal && st.report.created + st.report.updated > 0;
      commit.disabled = !doable || st.busy;
      gate.textContent = !st.file
        ? 'Choisissez un fichier, puis vérifiez-le.'
        : !same
          ? 'Vérifiez d’abord le fichier : l’import n’est possible qu’après une vérification du même fichier.'
          : doable
            ? 'La vérification est faite. Vous pouvez importer pour de bon.'
            : 'Rien à importer dans ce fichier : corrigez-le puis vérifiez-le de nouveau.';
    }

    fileInput.addEventListener('change', () => {
      st.file = fileInput.files?.[0] ?? null;
      st.verifiedKey = '';
      st.report = null;
      reportBox.replaceChildren();
      errorBox.replaceChildren();
      fileHint.textContent = st.file ? `${st.file.name} — ${Math.max(1, Math.round(st.file.size / 1024))} Ko` : 'Aucun fichier choisi.';
      syncButtons();
    });

    function fileProblem() {
      if (!st.file) return 'Choisissez d’abord un fichier.';
      if (st.file.size === 0) return 'Ce fichier est vide.';
      if (st.file.size > 1024 * 1024) return 'Ce fichier dépasse 1 Mo. Découpez-le en plusieurs fichiers.';
      return null;
    }

    function renderReport(report) {
      const stat = (n, label, info) => h('li', { class: `hd-stat ${info.tone}` }, icon(info.icon), h('strong', { class: 'num', text: String(n) }), h('span', { text: label }));
      const rows = F.reportRowsToShow(report);
      const head = h(
        'div',
        { class: 'hd-report-head', tabindex: '-1' },
        noticeBox(report.fatal ? 'is-alarm' : report.errors ? 'is-warning' : 'is-ok', report.fatal ? 'state-alarm' : report.errors ? 'state-warning' : 'state-ok', h('strong', { text: F.importHeadline(report) }), report.fatal ? h('span', { text: ` ${F.sentence(report.fatal)}` }) : null),
      );
      if (report.fatal) {
        reportBox.replaceChildren(head);
        return;
      }
      reportBox.replaceChildren(
        ...[
        head,
        h('ul', { class: 'hd-stats' }, stat(report.created, 'créés', F.outcomeInfo('created')), stat(report.updated, 'modifiés', F.outcomeInfo('updated')), stat(report.unchanged, 'inchangés', F.outcomeInfo('unchanged')), stat(report.errors, 'en erreur', F.outcomeInfo('error'))),
        h('p', { class: 'muted', text: `${F.plural(report.lines, 'ligne lue', 'lignes lues')}. ${F.encodingText(report.encoding)} Séparateur : ${F.delimiterText(report.delimiter)}.` }),
        rows.length
          ? h(
              'div',
              {},
              h('h4', { text: 'Lignes à regarder' }),
              h(
                'ul',
                { class: 'hd-rows' },
                ...rows.map((r) =>
                  h(
                    'li',
                    { class: 'hd-rowitem' },
                    h('span', { class: 'hd-rowline num', text: `Ligne ${r.line}` }),
                    h('strong', { class: 'hd-name', text: r.name ?? 'Nom inconnu' }),
                    pill(F.outcomeInfo(r.outcome), 'Résultat : '),
                    h('span', { class: 'hd-reasons' }, ...r.errors.map((e) => h('span', { class: 'hd-reason is-error', text: F.sentence(e) })), ...r.warnings.map((w) => h('span', { class: 'hd-reason', text: `Remarque : ${F.sentence(w)}` }))),
                  ),
                ),
              ),
            )
          : h('p', { class: 'muted', text: 'Aucune ligne en erreur ni avec remarque.' }),
        report.truncated ? h('p', { class: 'muted', text: 'Le rapport est tronqué : seules les premières lignes sont détaillées.' }) : null,
        ].filter(Boolean), // replaceChildren écrirait « null » pour un élément absent
      );
    }

    async function send(dryRun) {
      const problem = fileProblem();
      if (problem) {
        errorBox.replaceChildren(noticeBox('is-alarm', 'state-alarm', problem));
        return null;
      }
      errorBox.replaceChildren();
      const file = st.file;
      st.busy = true;
      syncButtons();
      try {
        return await rawRequest(`/api/access/import${dryRun ? '?dryRun=1' : ''}`, { method: 'POST', body: file, contentType: 'text/csv' });
      } catch (err) {
        errorBox.replaceChildren(noticeBox('is-alarm', 'state-alarm', h('strong', { text: dryRun ? 'La vérification a échoué. ' : 'L’import a échoué. ' }), F.sentence(err.message)));
        return null;
      } finally {
        st.busy = false;
        syncButtons();
      }
    }

    async function doVerify() {
      setBusy(verify, true);
      const report = await send(true);
      setBusy(verify, false);
      if (!report) {
        syncButtons();
        return;
      }
      st.report = report;
      st.verifiedKey = F.fileKey(st.file);
      renderReport(report);
      syncButtons();
      focusSoon(reportBox.querySelector('.hd-report-head'));
    }

    async function doImport() {
      if (!st.report || F.fileKey(st.file) !== st.verifiedKey) return;
      const ok = await dialogs.confirm({ heading: 'Importer pour de bon', message: F.importConfirmText(st.report), confirmLabel: 'Importer pour de bon', danger: false });
      if (!ok) {
        focusSoon(commit);
        return;
      }
      setBusy(commit, true);
      const report = await send(false);
      setBusy(commit, false);
      if (!report) {
        syncButtons();
        return;
      }
      st.report = report;
      st.verifiedKey = ''; // le fichier est importé : pour recommencer, il faut vérifier de nouveau
      renderReport(report);
      syncButtons();
      focusSoon(reportBox.querySelector('.hd-report-head'));
      toast(report.fatal ? 'Import refusé' : `Import terminé : ${report.created} créé(s), ${report.updated} modifié(s)`, report.fatal ? 'error' : 'ok');
      tabs.holders.stale();
      loadRef();
    }

    syncButtons();
    return {
      panel,
      enter() {},
      leave() {},
      reset() {
        st.file = null;
        st.verifiedKey = '';
        st.report = null;
        fileInput.value = '';
        fileHint.textContent = 'Aucun fichier choisi.';
        reportBox.replaceChildren();
        errorBox.replaceChildren();
        syncButtons();
      },
    };
  }

  // ================================================================= onglet Synchronisation

  function createSyncTab() {
    const cards = new Map(); // controllerId -> { el, sig, expanded, detail }
    let seq = 0;
    let loaded = false;
    const list = h('ul', { class: 'hd-sync-cards', 'aria-label': 'Contrôleurs' });
    const msg = h('div', { class: 'hd-list-msg' });
    const updated = h('p', { class: 'hd-count', role: 'status' });
    const intro = h('p', { class: 'muted', text: 'Le PSIM envoie aux contrôleurs, par la passerelle, les titulaires, les plages horaires et les jours fériés. Cet écran se met à jour tout seul toutes les 10 secondes.' });
    const panel = h('div', { class: 'hd-sync' }, intro, updated, msg, list);

    const ctlPath = (c) => `/api/access/sync/controllers/${encodeURIComponent(c.controllerId)}`;

    function cardContent(c, entry) {
      const admin = isAdmin();
      const info = F.controllerSyncInfo(c.state);
      const parts = [];
      parts.push(h('div', { class: 'hd-sync-title' }, h('h3', { text: c.controllerName }), pill(info, 'État : ')));
      parts.push(h('p', { class: 'hd-hint', text: c.hint }));
      const facts = [
        ['Éléments', F.syncCountsText(c.counts)],
        ['Passerelle', c.transportReady ? 'Connectée' : 'Non connectée'],
        ['Accusés', F.lastAckText(c.lastAckAt, now())],
        ['Clé', c.enabled ? `Créée ${c.keyCreatedAt ? F.dateTimeText(c.keyCreatedAt, now()) : ''}`.trim() : 'Pas de clé : synchronisation non activée'],
      ];
      parts.push(h('dl', { class: 'hd-facts' }, ...facts.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])));
      if (c.enabled && !c.transportReady) parts.push(noticeBox('is-warning', 'state-warning', 'La passerelle n’est pas connectée. Rien n’est perdu : tout partira dès qu’elle le sera.'));
      if (c.lastProblem) parts.push(noticeBox('is-warning', 'state-warning', h('strong', { text: `Dernier incident (${F.dateTimeText(c.lastProblem.at, now())}) : ` }), F.sentence(c.lastProblem.message)));
      if (c.awaitingConfirmation?.count) {
        const n = c.awaitingConfirmation.count;
        parts.push(
          noticeBox(
            'is-info',
            'lock',
            h('strong', { text: `${F.plural(n, 'suppression')} de titulaire${n > 1 ? 's' : ''} à confirmer. ` }),
            `Le PSIM a retenu ces retraits parce qu’il y en a beaucoup d’un coup (${c.awaitingConfirmation.refs.join(', ')}${n > c.awaitingConfirmation.refs.length ? '…' : ''}). ${admin ? 'Un administrateur doit les confirmer.' : 'Demandez à un administrateur de les confirmer.'}`,
          ),
        );
      }
      if (!c.enabled && !admin) parts.push(h('p', { class: 'muted', text: 'Demandez à un administrateur d’activer la synchronisation de ce contrôleur.' }));

      const actions = [];
      actions.push(button(entry.expanded ? 'Masquer le détail' : 'Voir le détail', { ic: entry.expanded ? 'chevron-up' : 'chevron-down', cls: 'btn btn-sm', fk: 'detail', label: `${entry.expanded ? 'Masquer' : 'Voir'} le détail de ${c.controllerName}`, onClick: () => toggleDetail(c) }));
      if (admin) {
        if (!c.enabled) actions.push(button('Activer la synchronisation', { ic: 'key', cls: 'btn btn-sm btn-primary', fk: 'key', label: `Activer la synchronisation de ${c.controllerName}`, onClick: () => issueKey(c) }));
        else actions.push(button('Renouveler la clé', { ic: 'key', cls: 'btn btn-sm', fk: 'key', label: `Renouveler la clé de ${c.controllerName}`, onClick: () => issueKey(c) }));
        if (c.awaitingConfirmation?.count) actions.push(button(`Confirmer les suppressions (${c.awaitingConfirmation.count})`, { ic: 'check', cls: 'btn btn-sm btn-danger', fk: 'confirm', label: `Confirmer les suppressions sur ${c.controllerName}`, onClick: () => confirmDeletions(c) }));
        if (c.counts?.failed > 0 || c.state === 'failed') actions.push(button('Réessayer', { ic: 'refresh', cls: 'btn btn-sm', fk: 'retry', label: `Réessayer sur ${c.controllerName}`, onClick: (b) => retry(c, b) }));
      }
      parts.push(h('div', { class: 'actions' }, ...actions));

      if (entry.expanded) {
        const items = entry.detail?.items;
        parts.push(
          h(
            'div',
            { class: 'hd-sync-detail' },
            h('h4', { text: 'Éléments non synchronisés' }),
            !entry.detail && entry.detailError
              ? noticeBox('is-alarm', 'state-alarm', h('strong', { text: 'Le détail n’a pas pu être lu. ' }), F.sentence(entry.detailError), ' ', button('Réessayer', { cls: 'btn btn-sm', ic: 'refresh', fk: 'detail-retry', onClick: (b) => run(b, () => loadDetail(entry)) }))
              : !entry.detail
              ? h('p', { class: 'muted', role: 'status', text: 'Lecture du détail…' })
              : items.length === 0
                ? h('p', { class: 'muted', text: 'Tout est synchronisé : aucun élément en attente ni en échec.' })
                : h(
                    'ul',
                    { class: 'hd-plain hd-items' },
                    ...items.map((it) =>
                      h('li', {}, h('div', { class: 'hd-sync-head' }, h('strong', { text: F.syncItemText(it) }), pill(F.holderSyncInfo(it.state), 'État : ')), it.message ? h('p', { class: 'hd-sub', text: F.sentence(it.message) }) : null, h('p', { class: 'hd-sub', text: `Depuis ${F.dateTimeText(it.since, now())}` })),
                    ),
                  ),
          ),
        );
      }
      return parts;
    }

    function paint(c, entry) {
      const sig = JSON.stringify([c, entry.expanded, entry.detail?.items, entry.detailError, isAdmin()]);
      if (sig === entry.sig) return;
      entry.sig = sig;
      keepFocus(entry.el, () => entry.el.replaceChildren(...cardContent(c, entry)));
    }

    async function toggleDetail(c) {
      const entry = cards.get(c.controllerId);
      if (!entry) return;
      entry.expanded = !entry.expanded;
      if (entry.expanded) {
        entry.detail = null;
        entry.detailError = '';
        paint(entry.status, entry);
        await loadDetail(entry);
      } else paint(entry.status, entry);
    }

    async function loadDetail(entry) {
      try {
        entry.detail = await api(ctlPath(entry.status));
        entry.detailError = '';
        entry.sig = '';
        paint(entry.status, entry);
      } catch (err) {
        // sans cela, « Lecture du détail… » resterait affiché indéfiniment
        entry.detailError = err.message || 'Erreur inconnue';
        entry.sig = '';
        paint(entry.status, entry);
      }
    }

    async function refresh() {
      const n = ++seq;
      try {
        const status = asList(await api('/api/access/sync'), 'controllers');
        if (n !== seq) return;
        const expanded = [...cards.values()].filter((e) => e.expanded);
        const details = await Promise.allSettled(expanded.map((e) => api(ctlPath(e.status))));
        if (n !== seq) return;
        details.forEach((r, i) => {
          if (r.status === 'fulfilled') {
            expanded[i].detail = r.value;
            expanded[i].detailError = '';
          } else if (!expanded[i].detail) expanded[i].detailError = r.reason?.message || 'Erreur inconnue';
        });
        loaded = true;
        msg.replaceChildren();
        const seen = new Set();
        for (const c of status) {
          seen.add(c.controllerId);
          let entry = cards.get(c.controllerId);
          if (!entry) {
            entry = { el: h('li', { class: 'hd-sync-card panel' }), sig: '', expanded: false, detail: null, detailError: '', status: c };
            cards.set(c.controllerId, entry);
          }
          entry.status = c;
          paint(c, entry);
        }
        for (const [id, entry] of cards) {
          if (!seen.has(id)) {
            entry.el.remove();
            cards.delete(id);
          }
        }
        // l'ordre du serveur est conservé sans toucher aux cartes déjà en place
        const wanted = status.map((c) => cards.get(c.controllerId).el);
        if (wanted.some((el, i) => list.children[i] !== el)) list.replaceChildren(...wanted);
        updated.textContent = status.length ? `Mis à jour à ${F.timeText(now())}.` : '';
        if (status.length === 0) msg.replaceChildren(emptyBox('Aucun contrôleur déclaré', 'Déclarez un contrôleur dans l’écran du contrôle d’accès : sa synchronisation apparaîtra ici.'));
      } catch (err) {
        if (n !== seq) return;
        msg.replaceChildren(
          noticeBox('is-alarm', 'state-alarm', h('strong', { text: 'L’état de la synchronisation n’a pas pu être lu. ' }), F.sentence(err.message), loaded ? ' Les dernières données connues restent affichées.' : '', ' ', button('Réessayer', { cls: 'btn btn-sm', ic: 'refresh', onClick: (b) => run(b, refresh) })),
        );
      }
    }

    // -- actions d'administration

    async function issueKey(c) {
      const renew = c.enabled;
      let result = null;
      const typed = await dialogs.ask({
        heading: renew ? 'Renouveler la clé de synchronisation' : 'Activer la synchronisation',
        message: renew
          ? `Une nouvelle clé va remplacer l’ancienne pour « ${c.controllerName} ». L’ancienne cesse de fonctionner tout de suite : tant que la passerelle n’a pas la nouvelle, rien n’est synchronisé. Confirmez avec votre mot de passe.`
          : `Une clé va être créée pour « ${c.controllerName} ». Elle s’affichera une seule fois. Confirmez avec votre mot de passe.`,
        confirmLabel: renew ? 'Renouveler la clé' : 'Activer',
        danger: renew,
        autocomplete: 'current-password',
        onSubmit: async (reauth) => {
          result = await api(`${ctlPath(c)}/key`, { method: 'POST', body: { reauth } });
        },
      });
      if (typed && result) await new Promise((resolve) => showKey(c, result, resolve));
      await refresh();
      // la carte a été redessinée : le focus revient au bouton de clé, pas à la page
      if (typed) focusSoon(cards.get(c.controllerId)?.el.querySelector('[data-fk="key"]'));
    }

    /** La clé n'existe que dans cette fenêtre (éléments <code>, jamais un champ de formulaire) ; elle ne se ferme que par son bouton. */
    function showKey(c, result, done) {
      const keyEl = h('code', { class: 'hd-key', text: result.key });
      const close = h('button', { class: 'btn btn-primary', type: 'button' }, icon('check'), h('span', { text: 'J’ai recopié la clé, fermer' }));
      close.addEventListener('click', () => dialogs.close());
      dialogs.open(
        `Clé de synchronisation de « ${c.controllerName} »`,
        h(
          'div',
          { class: 'hd-keybox' },
          noticeBox('is-warning', 'state-warning', h('strong', { text: 'Montrée une seule fois.' })),
          keyEl,
          h('div', { class: 'actions' }, copyButton(h, { label: 'Copier la clé', text: result.key, select: () => keyEl, small: false })),
          h('ul', { class: 'hd-plain hd-keywarn' }, ...F.KEY_WARNINGS.map((t) => h('li', { text: t }))),
          h('div', { class: 'actions dialog-actions' }, close),
        ),
        { dismissible: false, onClose: done },
      );
    }

    async function confirmDeletions(c) {
      const n = c.awaitingConfirmation?.count ?? 0;
      let confirmed = null;
      const typed = await dialogs.ask({
        heading: 'Confirmer les suppressions',
        message: `${F.plural(n, 'titulaire')} ${n > 1 ? 'seront retirés' : 'sera retiré'} de « ${c.controllerName} » (${c.awaitingConfirmation?.refs.join(', ') ?? ''}${n > (c.awaitingConfirmation?.refs.length ?? 0) ? '…' : ''}) : ils ne pourront plus ouvrir les portes de ce contrôleur. La confirmation vaut pour cette liste seulement. Confirmez avec votre mot de passe.`,
        confirmLabel: 'Confirmer les suppressions',
        danger: true,
        autocomplete: 'current-password',
        onSubmit: async (reauth) => {
          confirmed = await api(`${ctlPath(c)}/confirm-deletions`, { method: 'POST', body: { reauth } });
        },
      });
      if (typed) toast(`${F.plural(confirmed?.confirmed ?? n, 'suppression confirmée', 'suppressions confirmées')}`, 'ok');
      await refresh();
      if (typed) focusSoon(cards.get(c.controllerId)?.el.querySelector('[data-fk="detail"]'));
    }

    async function retry(c, btn) {
      await run(btn, async () => {
        const out = await api(`${ctlPath(c)}/retry`, { method: 'POST', body: {} });
        toast(out?.requeued ? `${F.plural(out.requeued, 'élément remis', 'éléments remis')} en file : nouvel essai immédiat` : 'Rien à réessayer pour l’instant', 'ok');
      });
      await refresh();
    }

    return {
      panel,
      async enter() {
        await refresh();
      },
      leave() {},
      refresh,
      reset() {
        seq++;
        cards.clear();
        list.replaceChildren();
        msg.replaceChildren();
        updated.textContent = '';
        loaded = false;
      },
    };
  }

  // ================================================================= onglets, minuteurs, entrée et sortie

  function stopTimers() {
    for (const k of Object.keys(timers)) {
      clearInterval(timers[k]);
      timers[k] = 0;
    }
  }

  /** Les minuteurs ne tournent que si l'écran, l'onglet et la page sont visibles. */
  function syncTimers() {
    stopTimers();
    if (!shown || document.visibilityState === 'hidden') return;
    if (activeTab === 'sync') timers.sync = setInterval(() => tabs.sync.refresh(), SYNC_REFRESH_MS);
    if (activeTab === 'visitors') {
      timers.visitors = setInterval(() => tabs.visitors.reload(), VISITORS_REFRESH_MS);
      timers.endline = setInterval(() => tabs.visitors.refreshTick(), 15_000);
    }
  }

  function visibleTabs() {
    return TABS.filter((t) => !t.admin || isAdmin());
  }

  function selectTab(id, { focus = false } = {}) {
    if (!visibleTabs().some((t) => t.id === id)) id = 'holders';
    const previous = activeTab;
    activeTab = id;
    for (const t of TABS) {
      const selected = t.id === id;
      tabButtons[t.id].setAttribute('aria-selected', String(selected));
      tabButtons[t.id].tabIndex = selected ? 0 : -1;
      tabs[t.id].panel.closest('[role="tabpanel"]').hidden = !selected;
    }
    tabButtons[id].scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); // sur téléphone, l'onglet choisi reste visible dans la rangée
    if (focus) tabButtons[id].focus();
    if (previous !== id) tabs[previous]?.leave();
    if (shown) tabs[id].enter();
    syncTimers();
  }

  function onTabKey(e) {
    const order = visibleTabs().map((t) => t.id);
    const i = order.indexOf(activeTab);
    let next = null;
    if (e.key === 'ArrowRight') next = order[(i + 1) % order.length];
    else if (e.key === 'ArrowLeft') next = order[(i - 1 + order.length) % order.length];
    else if (e.key === 'Home') next = order[0];
    else if (e.key === 'End') next = order.at(-1);
    if (!next) return;
    e.preventDefault();
    selectTab(next, { focus: true });
  }

  function build() {
    const list = h('div', { class: 'hd-tablist', role: 'tablist', 'aria-label': 'Sections de l’écran Titulaires' });
    const panels = [];
    tabs.holders = createHoldersTab();
    tabs.visitors = createVisitorsTab();
    tabs.groups = createGroupsTab();
    tabs.import = createImportTab();
    tabs.sync = createSyncTab();
    for (const t of TABS) {
      const b = h('button', { class: 'hd-tab', type: 'button', role: 'tab', id: `hd-tab-${t.id}`, 'aria-controls': `hd-panel-${t.id}`, 'aria-selected': 'false', tabindex: '-1' }, icon(t.icon), h('span', { text: t.label }));
      b.addEventListener('click', () => selectTab(t.id));
      b.addEventListener('keydown', onTabKey);
      tabButtons[t.id] = b;
      list.append(b);
      panels.push(h('div', { class: 'hd-tabpanel', role: 'tabpanel', id: `hd-panel-${t.id}`, 'aria-labelledby': `hd-tab-${t.id}`, tabindex: '0', hidden: true }, tabs[t.id].panel));
    }
    root.replaceChildren(list, ...panels);
  }

  function applyRole() {
    const role = getMe()?.role ?? null;
    const changed = builtFor !== null && builtFor !== role;
    builtFor = role;
    tabButtons.import.hidden = !isAdmin();
    if (changed) for (const t of TABS) tabs[t.id].reset(); // autre compte : on repart de zéro
    if (!isAdmin() && activeTab === 'import') activeTab = 'holders';
  }

  build();
  document.addEventListener('visibilitychange', () => {
    if (!shown) return;
    syncTimers();
    if (document.visibilityState === 'visible') {
      if (activeTab === 'sync') tabs.sync.refresh();
      if (activeTab === 'visitors') tabs.visitors.reload();
    }
  });

  return {
    /** Entrée dans l'écran : relit l'onglet affiché ; ne détruit jamais un formulaire commencé. */
    show() {
      shown = true;
      applyRole();
      selectTab(activeTab);
    },
    /** Sortie : les minuteurs s'arrêtent, l'écran reste en mémoire. */
    hide() {
      shown = false;
      stopTimers();
    },
  };
}
