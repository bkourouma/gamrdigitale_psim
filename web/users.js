// Administration : comptes utilisateurs et destinataires de notification.
import { randomPassword } from './account.js';

const ROLE_LABEL = { operator: 'Opérateur', admin: 'Administrateur' };
const CHANNEL_LABEL = { email: 'E-mail', telegram: 'Telegram', whatsapp: 'WhatsApp', webhook: 'Webhook' };
const ADDRESS_HINT = { email: 'agent@exemple.fr', telegram: 'numéro de conversation ou @canal', webhook: 'https://…' };

export function createUsersAdmin({ api, h, toast, dialogs, getMe, onRecipientsChanged }) {
  const usersBox = document.getElementById('users-list');
  const createBox = document.getElementById('users-create');
  const recipientsBox = document.getElementById('recipients-box');

  const when = (ts) => (ts ? new Date(ts).toLocaleString('fr-FR') : 'jamais');

  // ---------------------------------------------------------------- utilisateurs

  async function loadUsers() {
    try {
      renderUsers(await api('/api/users'));
    } catch (err) {
      usersBox.replaceChildren(h('p', { class: 'error', text: err.message }));
    }
  }

  async function act(fn, success) {
    try {
      await fn();
      if (success) toast(success, 'ok');
    } catch (err) {
      toast(err.message);
    }
    loadUsers();
  }

  function renderUsers(list) {
    const me = getMe();
    usersBox.replaceChildren(
      ...list.map((u) => {
        const self = u.username === me.username;
        const role = h('select', { 'aria-label': `Rôle de ${u.username}` }, ...['operator', 'admin'].map((r) => h('option', { value: r, text: ROLE_LABEL[r] })));
        role.value = u.role;
        role.addEventListener('change', () => act(() => api(`/api/users/${encodeURIComponent(u.username)}`, { method: 'PATCH', body: { role: role.value } }), 'Rôle modifié (ses sessions sont fermées)'));
        const active = h('input', { type: 'checkbox', 'aria-label': `Compte ${u.username} actif` });
        active.checked = u.active;
        active.disabled = self;
        active.addEventListener('change', () => act(() => api(`/api/users/${encodeURIComponent(u.username)}`, { method: 'PATCH', body: { active: active.checked } }), active.checked ? 'Compte réactivé' : 'Compte désactivé : sa session est fermée'));
        return h(
          'div',
          { class: `user-row${u.active ? '' : ' inactive'}` },
          h(
            'div',
            { class: 'user-id' },
            h('strong', { text: u.username }),
            h('span', { class: 'muted small', text: u.displayName ? ` — ${u.displayName}` : '' }),
            self ? h('span', { class: 'tag', text: 'vous' }) : null,
            u.mustChangePassword ? h('span', { class: 'tag warn', text: 'mot de passe à changer' }) : null,
            !u.active ? h('span', { class: 'tag', text: 'désactivé' }) : null,
          ),
          h('div', { class: 'user-meta small muted', text: `Dernière connexion : ${when(u.lastLoginAt)} — 2FA : ${u.totpEnabled ? `activée (${u.recoveryLeft} code(s) de secours)` : 'non'}` }),
          h(
            'div',
            { class: 'row wrap' },
            role,
            h('label', { class: 'check small' }, active, ' actif'),
            h('button', {
              class: 'btn tiny',
              type: 'button',
              text: 'Nouveau mot de passe',
              onclick: async () => {
                const password = await dialogs.ask({ heading: `Mot de passe de ${u.username}`, message: "Mot de passe temporaire : l'utilisateur devra le changer à sa prochaine connexion, et ses sessions ouvertes sont fermées. Communiquez-le par un canal sûr.", label: 'Mot de passe temporaire', generate: true, confirmLabel: 'Réinitialiser' });
                if (password !== null) act(() => api(`/api/users/${encodeURIComponent(u.username)}/reset-password`, { method: 'POST', body: { password } }), 'Mot de passe réinitialisé');
              },
            }),
            u.totpEnabled
              ? h('button', {
                  class: 'btn tiny',
                  type: 'button',
                  text: 'Réinitialiser la 2FA',
                  title: 'Téléphone perdu : retire la double authentification de ce compte',
                  onclick: () => confirm(`Retirer la double authentification de ${u.username} ? Ses sessions seront fermées.`) && act(() => api(`/api/users/${encodeURIComponent(u.username)}/reset-2fa`, { method: 'POST' }), '2FA réinitialisée'),
                })
              : null,
            self
              ? null
              : h('button', {
                  class: 'btn tiny danger',
                  type: 'button',
                  text: 'Supprimer',
                  onclick: () => confirm(`Supprimer définitivement le compte ${u.username} ?`) && act(() => api(`/api/users/${encodeURIComponent(u.username)}`, { method: 'DELETE' }), 'Compte supprimé'),
                }),
          ),
        );
      }),
    );
  }

  function buildCreateForm() {
    const username = h('input', { placeholder: 'identifiant (ex. marie.dupont)', maxlength: '32', autocomplete: 'off', 'aria-label': 'Identifiant', required: true });
    const displayName = h('input', { placeholder: 'Nom affiché (facultatif)', maxlength: '80', autocomplete: 'off', 'aria-label': 'Nom affiché' });
    const role = h('select', { 'aria-label': 'Rôle' }, ...['operator', 'admin'].map((r) => h('option', { value: r, text: ROLE_LABEL[r] })));
    const password = h('input', { type: 'text', placeholder: 'Mot de passe temporaire', autocomplete: 'off', 'aria-label': 'Mot de passe temporaire', required: true });
    const msg = h('p', { class: 'small', role: 'status' });
    createBox.replaceChildren(
      h(
        'form',
        {
          class: 'dialog-form',
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await api('/api/users', { method: 'POST', body: { username: username.value, displayName: displayName.value, role: role.value, password: password.value } });
              toast(`Compte ${username.value.toLowerCase()} créé : communiquez-lui son mot de passe temporaire par un canal sûr`, 'ok');
              username.value = displayName.value = password.value = '';
              msg.textContent = '';
              loadUsers();
            } catch (err) {
              msg.textContent = err.message;
              msg.className = 'small error';
            }
          },
        },
        h('h4', { text: 'Créer un compte' }),
        h('div', { class: 'row wrap' }, username, displayName, role),
        h(
          'div',
          { class: 'row wrap' },
          password,
          h('button', { class: 'btn small', type: 'button', text: 'Générer', onclick: () => (password.value = randomPassword()) }),
          h('button', { class: 'btn small primary', type: 'submit', text: 'Créer' }),
        ),
        h('p', { class: 'small muted', text: "L'utilisateur devra changer ce mot de passe à sa première connexion (12 caractères minimum)." }),
        msg,
      ),
    );
  }

  // ---------------------------------------------------------------- destinataires de notification

  async function loadRecipients() {
    try {
      renderRecipients(await api('/api/notifications/recipients'));
    } catch (err) {
      recipientsBox.replaceChildren(h('p', { class: 'error', text: err.message }));
    }
  }

  async function actRecipient(fn, success) {
    try {
      await fn();
      if (success) toast(success, 'ok');
    } catch (err) {
      toast(err.message);
    }
    // Le statut des canaux (nombre de destinataires par niveau) change aussi : on rafraichit les deux.
    if (onRecipientsChanged) onRecipientsChanged();
    else loadRecipients();
  }

  function renderRecipients({ recipients, available }) {
    const channel = h('select', { 'aria-label': 'Canal' });
    for (const id of ['email', 'telegram', 'webhook']) {
      const opt = h('option', { value: id, text: CHANNEL_LABEL[id] + (available[id] ? '' : ' (non configuré)') });
      opt.disabled = !available[id];
      channel.append(opt);
    }
    channel.value = available.email ? 'email' : available.telegram ? 'telegram' : 'webhook';
    const address = h('input', { placeholder: ADDRESS_HINT[channel.value], maxlength: '500', autocomplete: 'off', 'aria-label': 'Adresse', required: true });
    channel.addEventListener('change', () => (address.placeholder = ADDRESS_HINT[channel.value]));
    const level = h('select', { 'aria-label': 'Niveau' }, h('option', { value: '1', text: 'Niveau 1 (dès l\'ouverture)' }), h('option', { value: '2', text: 'Niveau 2 (escalade)' }));
    const label = h('input', { placeholder: 'Libellé (ex. Astreinte)', maxlength: '80', autocomplete: 'off', 'aria-label': 'Libellé' });

    // replaceChildren(null) insererait le texte « null » : on ecarte les valeurs vides.
    const children = [
      recipients.length === 0 ? h('p', { class: 'small muted', text: "Aucun destinataire : une alarme ne prévient personne hors de l'écran du PSIM." }) : null,
      ...recipients.map((r) => {
        if (r.source === 'env') {
          return h('div', { class: 'recipient-row' }, h('span', { class: 'tag', text: '.env' }), h('span', { text: `${CHANNEL_LABEL[r.channel]} — ${r.display}` }), h('span', { class: 'muted small', text: `niveau ${r.level} (défini dans .env : non modifiable ici)` }));
        }
        const lv = h('select', { 'aria-label': `Niveau de ${r.display}` }, h('option', { value: '1', text: 'Niveau 1' }), h('option', { value: '2', text: 'Niveau 2' }));
        lv.value = String(r.level);
        lv.addEventListener('change', () => actRecipient(() => api(`/api/notifications/recipients/${r.id}`, { method: 'PATCH', body: { level: Number(lv.value) } })));
        const on = h('input', { type: 'checkbox', 'aria-label': `${r.display} actif` });
        on.checked = r.active;
        on.addEventListener('change', () => actRecipient(() => api(`/api/notifications/recipients/${r.id}`, { method: 'PATCH', body: { active: on.checked } })));
        return h(
          'div',
          { class: `recipient-row${r.active ? '' : ' inactive'}` },
          h('span', { text: `${CHANNEL_LABEL[r.channel]} — ${r.display}${r.label ? ` (${r.label})` : ''}` }),
          lv,
          h('label', { class: 'check small' }, on, ' actif'),
          h('button', { class: 'btn tiny danger', type: 'button', text: 'Retirer', onclick: () => confirm(`Retirer ${r.display} ?`) && actRecipient(() => api(`/api/notifications/recipients/${r.id}`, { method: 'DELETE' }), 'Destinataire retiré') }),
        );
      }),
      h(
        'form',
        {
          class: 'dialog-form',
          onsubmit: async (e) => {
            e.preventDefault();
            await actRecipient(() => api('/api/notifications/recipients', { method: 'POST', body: { channel: channel.value, address: address.value, level: Number(level.value), label: label.value } }), 'Destinataire ajouté');
          },
        },
        h('h4', { text: 'Ajouter un destinataire' }),
        h('div', { class: 'row wrap' }, channel, address, level, label),
        h('button', { class: 'btn small primary', type: 'submit', text: 'Ajouter' }),
        h('p', { class: 'small muted', text: "Prise en compte immédiate, sans redémarrage. Les secrets des canaux (mot de passe SMTP, jeton Telegram) se règlent dans le fichier .env. Utilisez « Envoyer un message de test » pour vérifier." }),
      ),
    ];
    recipientsBox.replaceChildren(...children.filter(Boolean));
  }

  buildCreateForm();
  return { loadUsers, loadRecipients };
}
