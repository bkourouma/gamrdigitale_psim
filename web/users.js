/**
 * Administration des personnes : comptes des utilisateurs (écran Utilisateurs) et destinataires des alarmes hors de
 * l'écran (écran Personnes prévenues ; l'état des envois et le message de test sont dans notifications.js).
 *
 * Protections : les formulaires de création (compte, destinataire) sont construits une seule fois, jamais par un
 * rafraîchissement ; une liste rechargée rend le focus à la même commande et rouvre l'éditeur de zones qui était ouvert,
 * avec les choix en cours. Les gestes graves (supprimer, retirer, désactiver) sont confirmés en mots simples.
 */
import { icon, hasUnsavedInput } from './core.js';
import { randomPassword, setBusy, field, markInvalid, clearInvalid, copyButton } from './account.js';
import { CHANNEL, channelTag } from './notifications.js';
import { timeEl } from './system.js';

const ROLE_LABEL = { operator: 'Opérateur', admin: 'Administrateur' };
const ROLE_HINT = {
  operator: 'Surveille le site, traite les alarmes, arme ou désarme les zones, consulte les rapports et le journal.',
  admin: "Tout ce que fait l’opérateur, plus les réglages : équipements et plan, personnes prévenues, comptes et système.",
};
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/; // même règle que le serveur (server/users.ts)
const MIN_PASSWORD = 12;
const ADDRESS = {
  whatsapp: { placeholder: '+2250700000000', hint: "Numéro au format international, sans espace : « + », puis l’indicatif du pays et le numéro." },
  email: { placeholder: 'agent@exemple.ci', hint: "Adresse e-mail de la personne, ou d’une liste de diffusion." },
  telegram: { placeholder: '123456789 ou @canal', hint: 'Numéro de la conversation Telegram (chiffres), ou nom du canal commençant par @.' },
  webhook: { placeholder: 'https://…', hint: "Adresse (« webhook ») d’un autre logiciel — main courante, télésurveillance — qui reçoit chaque alarme automatiquement." },
};
const ADD_CHANNELS = ['whatsapp', 'email', 'telegram', 'webhook'];
const LEVEL_LABEL = { 1: 'Niveau 1 : tout de suite', 2: 'Niveau 2 : en renfort' };
const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

export function createUsersAdmin({ api, h, toast, dialogs, getMe, onRecipientsChanged, getZones = () => [] }) {
  const usersBox = document.getElementById('users-list');
  const createBox = document.getElementById('users-create');
  const recipientsBox = document.getElementById('recipients-box');
  const addBox = document.getElementById('recipient-add');
  const recipientsChanged = () => (onRecipientsChanged ? onRecipientsChanged() : loadRecipients());

  // ---------------------------------------------------------------- focus après un rechargement

  // Commande qui vient d'agir alors qu'elle est désactivée le temps de l'envoi (le navigateur lui retire le focus).
  let pendingKey = null;

  /** Clé (data-key) de la commande qui a le focus dans la liste, à lui rendre une fois la liste reconstruite. */
  function focusKeyIn(container) {
    const a = document.activeElement;
    const key = a && container.contains(a) && a.dataset.key ? a.dataset.key : !a || a === document.body ? pendingKey : null;
    pendingKey = null;
    return key;
  }

  /** Rend le focus à la commande de même clé ; si elle a disparu (ligne supprimée), au titre du panneau. */
  function restoreFocus(container, key, fallbackId) {
    if (!key) return;
    const el = container.querySelector(`[data-key="${CSS.escape(key)}"]`);
    (el && !el.disabled ? el : document.getElementById(fallbackId))?.focus({ preventScroll: Boolean(el) });
  }

  const th = (text) => h('th', { scope: 'col', text });
  const loadError = (title, err, retry) =>
    h('div', { class: 'notice is-alarm' }, icon('state-alarm'), h('span', {}, h('strong', { text: `${title} ` }), `${err.message}. `, h('button', { class: 'btn btn-sm', type: 'button', text: 'Réessayer', onclick: retry })));

  // ---------------------------------------------------------------- utilisateurs

  async function loadUsers() {
    resetIfOtherAccount();
    try {
      renderUsers(await api('/api/users'));
    } catch (err) {
      usersBox.replaceChildren(loadError('Liste des comptes illisible.', err, loadUsers));
    }
  }

  function renderUsers(list) {
    const me = getMe();
    const key = focusKeyIn(usersBox);
    // Votre compte d'abord : c'est celui qu'on cherche le plus souvent, et il a ses propres règles.
    const sorted = [...list].sort((a, b) => (b.username === me.username) - (a.username === me.username));
    usersBox.replaceChildren(
      h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          { class: 'data adm-stack adm-users' },
          h('caption', { class: 'sr-only', text: `${plural(list.length, 'compte')}` }),
          h('thead', {}, h('tr', {}, th('Compte'), th('Rôle'), th('Double authentification'), th('Dernière connexion'), th('Actif'), h('th', { scope: 'col' }, h('span', { class: 'sr-only', text: 'Actions' })))),
          h('tbody', {}, ...sorted.map((u) => userRow(u, u.username === me.username))),
        ),
      ),
    );
    restoreFocus(usersBox, key, 'users-title');
  }

  function userRow(u, self) {
    const path = `/api/users/${encodeURIComponent(u.username)}`;
    const k = (what) => `u:${u.username}:${what}`;

    const role = h('select', { class: 'input-sm', 'aria-label': `Rôle de ${u.username}`, 'data-key': k('role') }, ...['operator', 'admin'].map((r) => h('option', { value: r, text: ROLE_LABEL[r] })));
    role.value = u.role;
    role.addEventListener('change', async () => {
      const next = role.value;
      const word = ROLE_LABEL[next].toLowerCase();
      const ok = await dialogs.confirm({
        heading: `Rôle de ${u.username}`,
        message: self
          ? `Vous deviendrez ${word}. Votre session sera fermée : vous devrez vous reconnecter.`
          : `${u.username} devient ${word}. Ses sessions ouvertes seront fermées : une nouvelle connexion lui sera demandée.`,
        details: ROLE_HINT[next],
        confirmLabel: `Passer ${word}`,
        danger: self,
        onConfirm: () => api(path, { method: 'PATCH', body: { role: next } }),
      });
      if (!ok) {
        role.value = u.role;
        return;
      }
      toast(`${u.username} est maintenant ${word}`, 'ok');
      loadUsers();
    });

    const active = h('input', { type: 'checkbox', 'aria-label': `Compte ${u.username} actif`, 'data-key': k('active') });
    active.checked = u.active;
    active.disabled = self;
    active.addEventListener('change', async () => {
      if (!active.checked) {
        const ok = await dialogs.confirm({
          heading: 'Désactiver le compte',
          message: `${u.username} ne pourra plus se connecter, et sa session ouverte est fermée tout de suite.`,
          details: 'Le compte et son historique sont conservés : vous pourrez le réactiver en recochant « Actif ».',
          confirmLabel: 'Désactiver le compte',
          onConfirm: () => api(path, { method: 'PATCH', body: { active: false } }),
        });
        if (!ok) {
          active.checked = true;
          return;
        }
        toast(`Compte ${u.username} désactivé`, 'ok');
        return loadUsers();
      }
      pendingKey = k('active');
      active.disabled = true;
      try {
        await api(path, { method: 'PATCH', body: { active: true } });
        toast(`Compte ${u.username} réactivé`, 'ok');
      } catch (err) {
        toast(err.message);
      }
      loadUsers();
    });

    let twoFactor;
    if (u.totpEnabled) {
      const reset = self
        ? null
        : h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': `Réinitialiser la double authentification de ${u.username}`, title: 'Téléphone perdu ou changé : retire la double authentification de ce compte', 'data-key': k('2fa') }, 'Réinitialiser');
      reset?.addEventListener('click', async () => {
        const ok = await dialogs.confirm({
          heading: 'Réinitialiser la double authentification',
          message: `Téléphone perdu ou changé ? La double authentification est retirée du compte ${u.username}, et ses sessions ouvertes sont fermées.`,
          details: 'À sa prochaine connexion, le mot de passe suffira ; la personne pourra (ou devra, si elle est imposée) la réactiver depuis « Mon compte ».',
          confirmLabel: 'Réinitialiser',
          onConfirm: () => api(`${path}/reset-2fa`, { method: 'POST' }),
        });
        if (!ok) return;
        toast(`Double authentification de ${u.username} réinitialisée`, 'ok');
        loadUsers();
      });
      twoFactor = h('div', { class: 'adm-2fa' }, h('span', { class: 'pill is-ok' }, icon('lock'), 'Activée'), h('span', { class: 'muted', text: `${plural(u.recoveryLeft, 'code')} de secours` }), reset);
    } else {
      twoFactor = h('span', { class: 'pill is-offline is-dashed' }, icon('unlock'), 'Non activée');
    }

    let actions;
    if (self) {
      // Votre propre compte se règle dans « Mon compte » (un administrateur ne peut ni se supprimer ni se désactiver).
      actions = [h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'data-key': k('me'), onclick: () => document.getElementById('whoami')?.click() }, icon('user'), 'Ouvrir Mon compte')];
    } else {
      const pw = h('button', { class: 'btn btn-sm', type: 'button', 'data-key': k('pw') }, icon('key'), 'Nouveau mot de passe');
      pw.addEventListener('click', async () => {
        const value = await dialogs.ask({
          heading: `Nouveau mot de passe pour ${u.username}`,
          message: 'Mot de passe temporaire : la personne devra le changer à sa prochaine connexion, et ses sessions ouvertes sont fermées. Communiquez-le-lui par un canal sûr, de vive voix par exemple.',
          label: 'Mot de passe temporaire',
          generate: true,
          confirmLabel: 'Enregistrer le mot de passe',
          onSubmit: (password) => api(`${path}/reset-password`, { method: 'POST', body: { password } }),
        });
        if (value === null) return;
        toast(`Mot de passe de ${u.username} remplacé`, 'ok');
        loadUsers();
      });
      const del = h('button', { class: 'btn btn-sm btn-danger', type: 'button', 'data-key': k('del') }, icon('trash'), 'Supprimer');
      del.addEventListener('click', async () => {
        const ok = await dialogs.confirm({
          heading: 'Supprimer le compte',
          message: `Supprimer définitivement le compte ${u.username}${u.displayName ? ` (${u.displayName})` : ''} ? La personne ne pourra plus se connecter. Le journal garde la trace de ses actions.`,
          details: 'Pour une absence, décochez plutôt « Actif » : le compte pourra être réactivé.',
          confirmLabel: 'Supprimer le compte',
          onConfirm: () => api(path, { method: 'DELETE' }),
        });
        if (!ok) return;
        toast(`Compte ${u.username} supprimé`, 'ok');
        loadUsers();
      });
      actions = [pw, del];
    }

    return h(
      'tr',
      { class: u.active ? '' : 'is-inactive' },
      h(
        'td',
        { 'data-label': 'Compte', class: 'adm-who' },
        h('span', { class: 'adm-who-name' }, h('strong', { text: u.username }), self ? h('span', { class: 'tag is-info', text: 'Vous' }) : null, u.active ? null : h('span', { class: 'tag is-dashed', text: 'Désactivé' })),
        u.displayName ? h('span', { class: 'adm-who-sub', text: u.displayName }) : null,
        u.mustChangePassword ? h('span', { class: 'tag is-warning', text: 'Mot de passe à changer' }) : null,
      ),
      h('td', { 'data-label': 'Rôle' }, role),
      h('td', { 'data-label': 'Double authentification' }, twoFactor),
      h('td', { 'data-label': 'Dernière connexion' }, u.lastLoginAt ? timeEl(u.lastLoginAt) : h('span', { class: 'muted', text: 'Jamais' })),
      h('td', { 'data-label': 'Actif' }, h('label', { class: 'check', title: self ? 'Vous ne pouvez pas désactiver votre propre compte' : null }, active, h('span', { text: 'Actif' }))),
      h('td', { class: 'adm-actions-cell' }, h('div', { class: 'actions' }, ...actions)),
    );
  }

  // Formulaire « Créer un compte » : construit une fois, jamais effacé par un rafraîchissement de la liste.
  const createForm = buildCreateForm();
  createBox.replaceChildren(createForm.el);

  function buildCreateForm() {
    const username = h('input', { maxlength: '32', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', required: true, placeholder: 'ex. marie.dupont' });
    const displayName = h('input', { maxlength: '80', autocomplete: 'off', placeholder: 'ex. Marie Dupont' });
    const role = h('select', {}, ...['operator', 'admin'].map((r) => h('option', { value: r, text: ROLE_LABEL[r] })));
    const roleField = field(h, 'Rôle', role, ROLE_HINT.operator);
    role.addEventListener('change', () => (roleField.querySelector('.hint').textContent = ROLE_HINT[role.value]));
    const password = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', required: true, class: 'adm-mono' });
    const generate = h('button', { class: 'btn', type: 'button' }, icon('refresh'), 'Générer');
    generate.addEventListener('click', () => {
      password.value = randomPassword();
      password.dispatchEvent(new Event('input', { bubbles: true })); // compte comme une saisie
      password.removeAttribute('aria-invalid');
      clearInvalid(form, error);
      password.focus();
      password.select();
    });
    const error = h('p', { class: 'form-error', role: 'alert' });
    const result = h('div', { class: 'adm-result', role: 'status' });
    window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/utilisateurs')) result.replaceChildren(); });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('plus'), 'Créer le compte');
    let busy = false;

    const form = h(
      'form',
      {
        class: 'adm-form',
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          if (busy) return;
          clearInvalid(form, error);
          result.replaceChildren();
          const id = username.value.trim().toLowerCase();
          if (!USERNAME.test(id)) return markInvalid(username, error, 'Identifiant invalide : 3 à 32 caractères, lettres minuscules sans accent, chiffres, point, tiret ou tiret bas (ex. marie.dupont).');
          if (password.value.length < MIN_PASSWORD) return markInvalid(password, error, `Le mot de passe temporaire doit compter ${MIN_PASSWORD} caractères au moins : touchez « Générer ».`);
          busy = true;
          setBusy(submit, true);
          const temp = password.value;
          try {
            await api('/api/users', { method: 'POST', body: { username: id, displayName: displayName.value, role: role.value, password: temp } });
            form.reset();
            roleField.querySelector('.hint').textContent = ROLE_HINT.operator;
            const code = h('code', { class: 'adm-mono', text: temp });
            result.replaceChildren(
              h(
                'div',
                { class: 'notice is-ok' },
                icon('state-ok'),
                h(
                  'div',
                  { class: 'adm-result-text' },
                  h('strong', { text: `Compte ${id} créé.` }),
                  h('p', {}, 'Communiquez-lui son mot de passe temporaire par un canal sûr : ', code, ". Il lui sera demandé d’en choisir un autre à sa première connexion."),
                  h('div', { class: 'actions' }, copyButton(h, { label: 'Copier le mot de passe', done: 'Mot de passe copié', text: temp, select: code })),
                ),
              ),
            );
            loadUsers();
          } catch (err) {
            const target = /identifiant/i.test(err.message) ? username : /mot de passe/i.test(err.message) ? password : /nom/i.test(err.message) ? displayName : null;
            markInvalid(target, error, err.message);
          } finally {
            busy = false;
            setBusy(submit, false);
          }
        },
      },
      h(
        'div',
        { class: 'form-grid adm-grid' },
        field(h, 'Identifiant', username, 'Pour se connecter : lettres minuscules, chiffres, point ou tiret.'),
        field(h, 'Nom affiché (facultatif)', displayName, 'Montré dans le menu du PSIM.'),
        roleField,
      ),
      h(
        'label',
        { class: 'field' },
        h('span', { text: 'Mot de passe temporaire' }),
        h('span', { class: 'adm-input-row' }, password, generate),
        h('span', { class: 'hint', id: 'users-create-pw-hint', text: `${MIN_PASSWORD} caractères au moins. La personne le changera à sa première connexion.` }),
      ),
      error,
      h('div', { class: 'actions' }, submit),
      result,
    );
    password.setAttribute('aria-describedby', 'users-create-pw-hint');
    // Une nouvelle saisie efface le message du compte précédent (et son mot de passe affiché).
    form.addEventListener('input', () => result.replaceChildren());
    return {
      el: form,
      /** Liste des canaux illisible : on le dit, au lieu de laisser un bouton grisé sans explication. */
      setUnreadable() {
        if (known) return;
        unavailable.hidden = false;
        unavailable.querySelector('span').textContent = "La liste des canaux n’a pas pu être lue : réessayez ci-dessus avant d’ajouter un destinataire.";
      },
      reset() {
        form.reset();
        clearInvalid(form, error);
        result.replaceChildren();
        roleField.querySelector('.hint').textContent = ROLE_HINT.operator;
      },
    };
  }

  // ---------------------------------------------------------------- destinataires de notification

  let pickerCount = 0;

  /**
   * Choix des alarmes d'un destinataire : toutes (et les messages généraux : redémarrage, sécurité), ou seulement
   * certaines zones (un gardien : la zone Portail). `value()` : null = toutes, sinon la liste des zones cochées.
   */
  function zonePicker(initial, legend) {
    const name = `zones-mode-${++pickerCount}`;
    const all = h('input', { type: 'radio', name, value: 'all' });
    const some = h('input', { type: 'radio', name, value: 'some' });
    all.checked = initial === null;
    some.checked = initial !== null;
    const list = h('div', { class: 'adm-zone-list', role: 'group', 'aria-label': 'Zones' });

    function fill(checked) {
      const current = new Set(getZones());
      const known = [...new Set([...checked, ...current])].sort((a, b) => a.localeCompare(b, 'fr'));
      list.replaceChildren(
        ...(known.length
          ? known.map((zone) => {
              const box = h('input', { type: 'checkbox', value: zone });
              box.checked = checked.includes(zone);
              // Zone qui n'a plus de détecteur (renommée) : à décocher, sinon le destinataire ne reçoit plus rien d'elle.
              return h('label', { class: 'check' }, box, h('span', { text: zone }), current.has(zone) ? null : h('span', { class: 'tag is-warning', text: 'aucun détecteur' }));
            })
          : [h('span', { class: 'muted', text: "Aucune zone : donnez d’abord une zone aux détecteurs, dans « Équipements et plan »." })]),
      );
      some.disabled = known.length === 0 && all.checked;
    }
    fill(initial ?? []);
    const sync = () => (list.hidden = all.checked);
    all.addEventListener('change', sync);
    some.addEventListener('change', () => {
      sync();
      list.querySelector('input')?.focus();
    });
    sync();
    const value = () => (all.checked ? null : [...list.querySelectorAll('input:checked')].map((i) => i.value));
    return {
      el: h(
        'fieldset',
        { class: 'adm-zone-picker' },
        h('legend', { text: legend }),
        h('label', { class: 'check' }, all, h('span', { text: 'Toutes les alarmes, et les messages généraux (redémarrage, sécurité)' })),
        h('label', { class: 'check' }, some, h('span', { text: 'Seulement les alarmes de certaines zones' })),
        list,
      ),
      value,
      focus: () => (all.checked ? all : some).focus(),
      /** Zones des détecteurs changées : la liste suit, les cases cochées restent cochées. */
      refresh: () => fill(value() ?? []),
      reset() {
        all.checked = true;
        some.checked = false;
        fill([]);
        sync();
      },
    };
  }

  const zonesText = (zones) => (zones === null ? 'Toutes les alarmes' : `Zones : ${zones.join(', ')}`);
  /** Une zone du destinataire n'a plus de détecteur : il ne reçoit plus rien d'elle. */
  const staleZones = (zones) => (zones ?? []).filter((z) => !getZones().includes(z));
  const whoText = (r) => `${CHANNEL[r.channel]?.label ?? r.channel} ${r.display}${r.label ? ` (${r.label})` : ''}`;

  async function loadRecipients() {
    resetIfOtherAccount();
    try {
      renderRecipients(await api('/api/notifications/recipients'));
    } catch (err) {
      recipientsBox.replaceChildren(loadError('Liste des destinataires illisible.', err, loadRecipients));
      addForm.setUnreadable();
    }
  }

  // Éditeurs de zones ouverts (par destinataire) : rouverts après un rechargement, avec les choix en cours.
  const editors = new Map();

  function renderRecipients({ recipients, available }) {
    addForm.setAvailable(available);
    if (!hasUnsavedInput(addForm.zonesEl)) addForm.refreshZones();
    const key = focusKeyIn(recipientsBox);
    const reopen = new Map([...editors].filter(([, e]) => e.isOpen()).map(([id, e]) => [id, e.value()]));
    editors.clear();

    // Destinataire d'un canal sans réglage (jeton, serveur) : il ne recevrait rien, on le dit sur sa ligne.
    const unconfigured = (id) => (id in available && !available[id] && id !== 'callmebot' ? h('span', { class: 'tag is-warning', text: 'Canal non réglé : ne reçoit rien' }) : null);
    const fromDb = recipients.filter((r) => r.source !== 'env');
    const fromEnv = recipients.filter((r) => r.source === 'env');

    const parts = [];
    if (recipients.length === 0) {
      parts.push(
        h(
          'div',
          { class: 'empty' },
          icon('megaphone'),
          h('strong', { text: "Personne n’est encore prévenu hors de cet écran." }),
          h('span', { text: "Ajoutez la personne d’astreinte (gardien, responsable sécurité) avec le formulaire « Ajouter un destinataire » : elle recevra chaque alarme par message, même loin du poste de garde." }),
        ),
      );
    }
    if (fromDb.length) {
      parts.push(
        h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            { class: 'data adm-stack adm-recipients' },
            h('caption', { class: 'sr-only', text: `${plural(fromDb.length, 'destinataire')} ajouté${fromDb.length > 1 ? 's' : ''} ici` }),
            h('thead', {}, h('tr', {}, th('Canal'), th('Adresse'), th('Libellé'), th('Niveau'), th('Alarmes reçues'), th('Actif'), h('th', { scope: 'col' }, h('span', { class: 'sr-only', text: 'Retirer' })))),
            h('tbody', {}, ...fromDb.flatMap((r) => recipientRows(r, unconfigured(r.channel), reopen.get(r.id)))),
          ),
        ),
        h('p', { class: 'hint' }, h('strong', { text: 'Niveau 1 : ' }), "prévenu dès qu’une alarme s’ouvre. ", h('strong', { text: 'Niveau 2 : ' }), "prévenu en renfort si personne n’acquitte l’alarme à temps (escalade)."),
      );
    } else if (fromEnv.length) {
      parts.push(h('p', { class: 'muted', text: 'Aucun destinataire ajouté ici : seuls ceux du fichier de réglages, ci-dessous, sont prévenus.' }));
    }
    if (fromEnv.length) {
      parts.push(
        h(
          'section',
          { class: 'adm-env', 'aria-labelledby': 'recipients-env-title' },
          h('h3', { id: 'recipients-env-title' }, icon('lock', 'icon-sm'), 'Inscrits dans le fichier de réglages'),
          h(
            'p',
            { class: 'hint' },
            'Ces destinataires sont écrits dans le fichier de réglages du PSIM (',
            h('code', { text: '.env' }),
            ", sur le PC du PSIM). Ils reçoivent toutes les alarmes et ne se modifient pas ici : un technicien change ce fichier, puis redémarre le PSIM. Les destinataires WhatsApp par CallMeBot (canal d’essai) ne se déclarent que là.",
          ),
          h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              { class: 'data adm-stack adm-env-table' },
              h('thead', {}, h('tr', {}, th('Canal'), th('Adresse'), th('Niveau'), th('Alarmes reçues'))),
              h(
                'tbody',
                {},
                ...fromEnv.map((r) =>
                  h(
                    'tr',
                    {},
                    h('td', { 'data-label': 'Canal' }, h('span', { class: 'adm-cell-stack' }, channelTag(r.channel), unconfigured(r.channel))),
                    h('td', { 'data-label': 'Adresse', class: 'adm-address', text: r.display }),
                    h('td', { 'data-label': 'Niveau', text: LEVEL_LABEL[r.level] ?? `Niveau ${r.level}` }),
                    h('td', { 'data-label': 'Alarmes reçues', text: 'Toutes les alarmes' }),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }
    recipientsBox.replaceChildren(...parts);
    restoreFocus(recipientsBox, key, 'recipients-title');
  }

  /** Ligne d'un destinataire ajouté ici, et la ligne de son éditeur de zones (masquée tant qu'il est fermé). */
  function recipientRows(r, unconfiguredTag, reopenWith) {
    const path = `/api/notifications/recipients/${r.id}`;
    const k = (what) => `r:${r.id}:${what}`;
    const who = whoText(r);

    const level = h('select', { class: 'input-sm', 'aria-label': `Niveau de ${who}`, 'data-key': k('level') }, ...[1, 2].map((n) => h('option', { value: String(n), text: LEVEL_LABEL[n] })));
    level.value = String(r.level);
    level.addEventListener('change', async () => {
      pendingKey = k('level');
      level.disabled = true;
      try {
        await api(path, { method: 'PATCH', body: { level: Number(level.value) } });
        toast(`${who} : ${LEVEL_LABEL[level.value].toLowerCase()}`, 'ok');
      } catch (err) {
        toast(err.message);
      }
      recipientsChanged();
    });

    const active = h('input', { type: 'checkbox', 'aria-label': `${who} actif`, 'data-key': k('active') });
    active.checked = r.active;
    active.addEventListener('change', async () => {
      if (!active.checked) {
        const ok = await dialogs.confirm({
          heading: 'Ne plus prévenir ce destinataire',
          message: `${who} ne recevra plus aucune alarme tant qu’il n’est pas réactivé.`,
          details: 'Ses réglages (niveau, zones) sont conservés : recochez « Actif » pour le prévenir de nouveau.',
          confirmLabel: 'Ne plus le prévenir',
          onConfirm: () => api(path, { method: 'PATCH', body: { active: false } }),
        });
        if (!ok) {
          active.checked = true;
          return;
        }
        toast(`${who} n’est plus prévenu`, 'ok');
        return recipientsChanged();
      }
      pendingKey = k('active');
      active.disabled = true;
      try {
        await api(path, { method: 'PATCH', body: { active: true } });
        toast(`${who} est de nouveau prévenu`, 'ok');
      } catch (err) {
        toast(err.message);
      }
      recipientsChanged();
    });

    const remove = h('button', { class: 'btn btn-sm btn-danger', type: 'button', 'aria-label': `Retirer ${who}`, 'data-key': k('remove') }, icon('trash'), 'Retirer');
    remove.addEventListener('click', async () => {
      const ok = await dialogs.confirm({
        heading: 'Retirer le destinataire',
        message: `Retirer ${who} de la liste ? Il ne recevra plus aucune alarme.`,
        details: 'Pour une pause (congés, remplacement), décochez plutôt « Actif » : ses réglages seront gardés.',
        confirmLabel: 'Retirer',
        onConfirm: () => api(path, { method: 'DELETE' }),
      });
      if (!ok) return;
      toast(`${who} retiré`, 'ok');
      recipientsChanged();
    });

    // Zones : lues sur la ligne, modifiées dans un éditeur qui s'ouvre dessous (une limite s'enregistre explicitement).
    const editorCell = h('td', { colspan: '7' });
    const editorRow = h('tr', { class: 'adm-zone-row', id: `recipient-zones-${r.id}`, hidden: true }, editorCell);
    const zonesBtn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-expanded': 'false', 'aria-controls': editorRow.id, 'aria-label': `Modifier les alarmes reçues par ${who}`, 'data-key': k('zones') }, icon('pencil'), 'Modifier');
    const row = h(
      'tr',
      { class: r.active ? '' : 'is-inactive' },
      h('td', { 'data-label': 'Canal' }, h('span', { class: 'adm-cell-stack' }, channelTag(r.channel), unconfiguredTag)),
      h('td', { 'data-label': 'Adresse', class: 'adm-address', text: r.display }),
      h('td', { 'data-label': 'Libellé' }, r.label ? r.label : h('span', { class: 'faint', text: '—' })),
      h('td', { 'data-label': 'Niveau' }, level),
      h(
        'td',
        { 'data-label': 'Alarmes reçues' },
        h(
          'span',
          { class: 'adm-cell-stack' },
          h('span', { class: 'adm-zones-line' }, h('span', { text: zonesText(r.zones) }), zonesBtn),
          staleZones(r.zones).length && r.active ? h('span', { class: 'tag is-warning', text: `Ne reçoit plus rien de : ${staleZones(r.zones).join(', ')} (aucun détecteur)` }) : null,
        ),
      ),
      h('td', { 'data-label': 'Actif' }, h('label', { class: 'check' }, active, h('span', { text: 'Actif' }))),
      h('td', { class: 'adm-actions-cell' }, h('div', { class: 'actions' }, remove)),
    );

    function closeEditor(focusButton = true) {
      editorCell.replaceChildren(); // aucune case touchée ne reste : l'écran peut de nouveau se rafraîchir
      editorRow.hidden = true;
      row.classList.remove('is-editing');
      zonesBtn.setAttribute('aria-expanded', 'false');
      if (focusButton) zonesBtn.focus();
    }

    function openEditor(initial, focus = true) {
      const picker = zonePicker(initial, `Alarmes envoyées à ${who}`);
      const error = h('p', { class: 'form-error', role: 'alert' });
      const save = h('button', { class: 'btn btn-sm btn-primary', type: 'button' }, 'Enregistrer les zones');
      save.addEventListener('click', async () => {
        error.textContent = '';
        const zones = picker.value();
        if (zones !== null && zones.length === 0) {
          error.textContent = 'Cochez au moins une zone, ou choisissez « Toutes les alarmes ».';
          return picker.focus();
        }
        setBusy(save, true);
        try {
          await api(path, { method: 'PATCH', body: { zones } });
          toast(`Alarmes de ${who} enregistrées`, 'ok');
          pendingKey = k('zones');
          closeEditor(false);
          recipientsChanged();
        } catch (err) {
          error.textContent = err.message;
          setBusy(save, false);
        }
      });
      editorCell.replaceChildren(h('div', { class: 'adm-zone-editor' }, picker.el, error, h('div', { class: 'actions' }, save, h('button', { class: 'btn btn-sm', type: 'button', text: 'Annuler', onclick: () => closeEditor() }))));
      editorRow.hidden = false;
      row.classList.add('is-editing');
      zonesBtn.setAttribute('aria-expanded', 'true');
      editors.set(r.id, { isOpen: () => !editorRow.hidden && editorRow.isConnected, value: picker.value });
      if (focus) picker.focus();
    }

    zonesBtn.addEventListener('click', () => (editorRow.hidden ? openEditor(r.zones) : closeEditor()));
    if (reopenWith !== undefined) openEditor(reopenWith, false);
    return [row, editorRow];
  }

  // Formulaire « Ajouter un destinataire » : construit une fois (une saisie commencée survit à tout rechargement).
  const addForm = buildAddForm();
  addBox.replaceChildren(addForm.el);

  function buildAddForm() {
    const channel = h('select', {}, ...ADD_CHANNELS.map((id) => h('option', { value: id, text: CHANNEL[id].label })));
    const address = h('input', { maxlength: '500', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', required: true });
    const addressField = field(h, 'Adresse', address, '');
    const addressHint = h('span', { class: 'hint', id: 'recipient-add-address-hint' });
    addressField.append(addressHint);
    address.setAttribute('aria-describedby', addressHint.id);
    const level = h('select', {}, h('option', { value: '1', text: 'Niveau 1 : prévenu tout de suite' }), h('option', { value: '2', text: 'Niveau 2 : prévenu en renfort (escalade)' }));
    const label = h('input', { maxlength: '80', autocomplete: 'off', placeholder: 'ex. Astreinte, Gardien de nuit' });
    const zones = zonePicker(null, 'Alarmes envoyées à ce destinataire');
    const error = h('p', { class: 'form-error', role: 'alert' });
    const unavailable = h('div', { class: 'notice is-warning', hidden: true }, icon('state-warning'), h('span', { text: "Aucun canal n’est réglé sur ce PSIM : un technicien doit d’abord en régler un dans le fichier de réglages." }));
    const result = h('div', { class: 'adm-result', role: 'status' });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit', disabled: true }, icon('plus'), 'Ajouter le destinataire');
    let busy = false;
    let known = false; // canaux disponibles reçus du serveur

    const syncChannel = () => {
      const a = ADDRESS[channel.value];
      address.placeholder = a.placeholder;
      addressHint.textContent = a.hint;
    };
    channel.addEventListener('change', syncChannel);
    syncChannel();

    const form = h(
      'form',
      {
        class: 'adm-form',
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          if (busy || !known) return;
          clearInvalid(form, error);
          result.replaceChildren();
          if (!address.value.trim()) return markInvalid(address, error, "Saisissez l’adresse du destinataire.");
          const chosen = zones.value();
          if (chosen !== null && chosen.length === 0) {
            error.textContent = 'Cochez au moins une zone, ou choisissez « Toutes les alarmes ».';
            return zones.focus();
          }
          busy = true;
          setBusy(submit, true);
          try {
            const added = await api('/api/notifications/recipients', {
              method: 'POST',
              body: { channel: channel.value, address: address.value.trim(), level: Number(level.value), label: label.value, zones: chosen },
            });
            address.value = '';
            label.value = '';
            zones.reset();
            result.replaceChildren(
              h('div', { class: 'notice is-ok' }, icon('state-ok'), h('span', {}, h('strong', { text: `${whoText(added)} ajouté. ` }), "Il est prévenu dès maintenant. Vérifiez qu’il reçoit bien les messages avec « Envoyer un message de test », plus bas.")),
            );
            recipientsChanged();
          } catch (err) {
            markInvalid(/adresse|numero|identifiant|webhook|destinataire/i.test(err.message) ? address : null, error, err.message);
          } finally {
            busy = false;
            setBusy(submit, !known);
          }
        },
      },
      unavailable,
      h('div', { class: 'form-grid adm-grid' }, field(h, 'Canal', channel), addressField, field(h, 'Niveau', level), field(h, 'Libellé (facultatif)', label, 'Rôle de la personne, pour la reconnaître dans la liste.')),
      zones.el,
      error,
      h('div', { class: 'actions' }, submit),
      h('p', { class: 'hint' }, 'Prise en compte immédiate, sans redémarrage. Les secrets des canaux (mot de passe de la messagerie, jeton Telegram ou WhatsApp) restent dans le fichier de réglages du PSIM, jamais ici.'),
      result,
    );
    form.addEventListener('input', () => result.replaceChildren());

    return {
      el: form,
      zonesEl: zones.el,
      refreshZones: zones.refresh,
      /** Canaux réglés sur le serveur : les autres restent visibles mais ne peuvent pas être choisis. */
      setAvailable(available) {
        known = true;
        for (const opt of channel.options) {
          opt.disabled = !available[opt.value];
          opt.textContent = CHANNEL[opt.value].label + (available[opt.value] ? '' : ' (non réglé)');
        }
        if (channel.selectedOptions[0]?.disabled) {
          const first = [...channel.options].find((o) => !o.disabled);
          if (first) channel.value = first.value;
          syncChannel();
        }
        const none = ![...channel.options].some((o) => !o.disabled);
        unavailable.querySelector('span').textContent = "Aucun canal n’est réglé sur ce PSIM : un technicien doit d’abord en régler un dans le fichier de réglages.";
        unavailable.hidden = !none;
        if (!busy) submit.disabled = none;
      },
      reset() {
        form.reset();
        clearInvalid(form, error);
        result.replaceChildren();
        zones.reset();
        syncChannel();
      },
    };
  }

  // ---------------------------------------------------------------- changement de compte

  // Les formulaires construits une fois gardent leur saisie : un autre administrateur qui se connecte sur ce poste ne
  // doit pas y trouver celle du précédent (mot de passe temporaire, adresse).
  let owner = null;
  function resetIfOtherAccount() {
    const me = getMe()?.username ?? null;
    if (owner === me) return;
    if (owner !== null) {
      createForm.reset();
      addForm.reset();
    }
    owner = me;
  }

  return { loadUsers, loadRecipients };
}
