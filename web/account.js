// Fenetre « Mon compte » : mot de passe, double authentification (QR code, codes de secours).
// Fournit aussi la boite de dialogue commune (mot de passe demande a l'administrateur, etc.).

export function createDialogs({ h }) {
  const root = document.getElementById('dialog');
  const title = document.getElementById('dialog-title');
  const body = document.getElementById('dialog-body');
  let onClose = null;
  let dismissible = true;

  function close() {
    root.hidden = true;
    body.replaceChildren();
    const cb = onClose;
    onClose = null;
    cb?.();
  }

  function open(heading, content, options = {}) {
    dismissible = options.dismissible !== false;
    onClose = options.onClose ?? null;
    title.textContent = heading;
    body.replaceChildren(...[content].flat());
    root.hidden = false;
    root.querySelector('input, button')?.focus();
  }

  root.addEventListener('click', (e) => {
    if (e.target === root && dismissible) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden && dismissible) close();
  });

  /** Demande un mot de passe (ou une valeur masquee) dans une petite fenetre ; renvoie la valeur ou null si annule. */
  function ask({ heading, message, label = 'Mot de passe', confirmLabel = 'Valider', generate = false }) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
        close();
      };
      const input = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': label, required: true });
      const form = h(
        'form',
        {
          class: 'dialog-form',
          onsubmit: (e) => {
            e.preventDefault();
            done(input.value);
          },
        },
        message ? h('p', { class: 'small muted', text: message }) : null,
        h('label', {}, label, input),
        generate
          ? h('button', {
              class: 'btn small',
              type: 'button',
              text: 'Générer un mot de passe solide',
              onclick: () => {
                input.type = 'text';
                input.value = randomPassword();
              },
            })
          : null,
        h('div', { class: 'row wrap' }, h('button', { class: 'btn primary small', type: 'submit', text: confirmLabel }), h('button', { class: 'btn small', type: 'button', text: 'Annuler', onclick: () => done(null) })),
      );
      open(heading, form, { onClose: () => done(null) });
    });
  }

  return { open, close, ask };
}

/** Mot de passe aleatoire de 20 caracteres (alphabet sans caracteres ambigus), en groupes de 5. */
export function randomPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return chars.match(/.{5}/g).join('-');
}

const RESTRICTION_TEXT = {
  password: 'Votre mot de passe a été défini par un administrateur : vous devez le changer avant de continuer.',
  '2fa': "L'administration impose la double authentification : vous devez l'activer avant de continuer.",
};

export function createAccountUi({ api, h, toast, dialogs, getMe, refreshMe, logout }) {
  async function openAccount() {
    await refreshMe();
    const me = getMe();
    const forced = Boolean(me.restricted);
    const content = h('div', { class: 'account' });

    if (forced) {
      content.append(
        h('p', { class: 'warn', role: 'alert', text: RESTRICTION_TEXT[me.restricted] }),
        h('button', { class: 'btn small', type: 'button', text: 'Se déconnecter', onclick: logout }),
      );
    }
    content.append(passwordSection(me), twoFactorSection(me));
    dialogs.open(`Mon compte — ${me.displayName || me.username}`, content, { dismissible: !forced });
  }

  function passwordSection(me) {
    const current = h('input', { type: 'password', autocomplete: 'current-password', required: true, 'aria-label': 'Mot de passe actuel' });
    const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, 'aria-label': 'Nouveau mot de passe' });
    const confirm = h('input', { type: 'password', autocomplete: 'new-password', required: true, 'aria-label': 'Confirmer le nouveau mot de passe' });
    const msg = h('p', { class: 'small', role: 'status' });
    return h(
      'section',
      {},
      h('h3', { text: 'Mot de passe' }),
      h(
        'form',
        {
          class: 'dialog-form',
          onsubmit: async (e) => {
            e.preventDefault();
            if (next.value !== confirm.value) {
              msg.textContent = 'Les deux saisies du nouveau mot de passe diffèrent.';
              msg.className = 'small error';
              return;
            }
            try {
              await api('/api/me/password', { method: 'POST', body: { current: current.value, next: next.value } });
              toast('Mot de passe modifié', 'ok');
              await afterStep();
            } catch (err) {
              msg.textContent = err.message;
              msg.className = 'small error';
            }
          },
        },
        h('label', {}, 'Mot de passe actuel', current),
        h('label', {}, 'Nouveau mot de passe (12 caractères minimum)', next),
        h('label', {}, 'Confirmer', confirm),
        h('button', { class: 'btn small primary', type: 'submit', text: 'Changer le mot de passe' }),
        msg,
      ),
    );
  }

  /** Apres une etape reussie : si plus aucune restriction, on libere l'utilisateur. */
  async function afterStep() {
    await refreshMe();
    if (!getMe().restricted) {
      dialogs.close();
      location.reload(); // repart d'un etat propre (temps reel, droits)
    } else openAccount();
  }

  function twoFactorSection(me) {
    const section = h('section', {}, h('h3', { text: 'Double authentification' }));
    const body = h('div', { class: 'dialog-form' });
    section.append(body);

    const showStatus = () => {
      const m = getMe();
      body.replaceChildren(
        h('p', { class: m.totpEnabled ? 'good' : 'small muted', text: m.totpEnabled ? `Activée — ${m.recoveryLeft} code(s) de secours restant(s).` : "Non activée. Un mot de passe volé suffirait pour se connecter à votre place : l'activer ajoute un code temporaire, généré par votre téléphone." }),
        m.totpEnabled
          ? h(
              'div',
              { class: 'row wrap' },
              h('button', { class: 'btn small', type: 'button', text: 'Nouveaux codes de secours', onclick: regenerate }),
              h('button', { class: 'btn small danger', type: 'button', text: 'Désactiver', onclick: disable }),
            )
          : h('button', { class: 'btn small primary', type: 'button', text: 'Activer la double authentification', onclick: enroll }),
      );
    };

    async function enroll() {
      try {
        const setup = await api('/api/me/2fa/setup', { method: 'POST' });
        const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '7', placeholder: '123456', 'aria-label': 'Code à 6 chiffres', required: true });
        const msg = h('p', { class: 'small', role: 'status' });
        body.replaceChildren(
          h('p', { class: 'small', text: "1. Installez une application d'authentification (Google Authenticator, Microsoft Authenticator, Aegis, FreeOTP…) puis scannez ce QR code :" }),
          h('img', { class: 'qr', alt: 'QR code de la double authentification', src: `data:image/svg+xml;base64,${btoa(setup.qrSvg)}`, width: '220', height: '220' }),
          h('p', { class: 'small muted' }, 'Impossible de scanner ? Saisissez cette clé : ', h('code', { class: 'secret', text: setup.secret.match(/.{1,4}/g).join(' ') })),
          h('p', { class: 'small', text: '2. Saisissez le code à 6 chiffres affiché par l\'application :' }),
          h(
            'form',
            {
              class: 'row wrap',
              onsubmit: async (e) => {
                e.preventDefault();
                try {
                  const done = await api('/api/me/2fa/enable', { method: 'POST', body: { code: code.value } });
                  showRecovery(done.recoveryCodes);
                } catch (err) {
                  msg.textContent = err.message;
                  msg.className = 'small error';
                }
              },
            },
            code,
            h('button', { class: 'btn small primary', type: 'submit', text: 'Vérifier et activer' }),
          ),
          msg,
        );
        code.focus();
      } catch (err) {
        toast(err.message);
      }
    }

    function showRecovery(codes) {
      const saved = h('input', { type: 'checkbox' });
      const finish = h('button', { class: 'btn small primary', type: 'button', text: 'Terminer', disabled: true, onclick: () => afterStep() });
      saved.addEventListener('change', () => (finish.disabled = !saved.checked));
      body.replaceChildren(
        h('p', { class: 'good', text: 'Double authentification activée.' }),
        h('p', { class: 'small', text: "Codes de secours : si vous perdez votre téléphone, chacun permet UNE connexion. Conservez-les dans un endroit sûr (gestionnaire de mots de passe, coffre) : ils ne seront plus affichés." }),
        h('pre', { class: 'recovery', text: codes.join('\n') }),
        h('button', { class: 'btn small', type: 'button', text: 'Copier les codes', onclick: () => navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('Codes copiés', 'ok')) }),
        h('label', { class: 'check' }, saved, " J'ai conservé ces codes"),
        finish,
      );
    }

    async function regenerate() {
      const password = await dialogs.ask({ heading: 'Nouveaux codes de secours', message: 'Les anciens codes cesseront de fonctionner. Saisissez votre mot de passe pour confirmer.', confirmLabel: 'Générer' });
      if (password === null) return openAccount();
      try {
        const r = await api('/api/me/2fa/recovery', { method: 'POST', body: { password } });
        await openAccount();
        // La fenetre est reconstruite : on affiche les codes dans la section 2FA fraichement creee.
        document.querySelector('#dialog .account section:last-child .dialog-form')?.replaceChildren(
          h('p', { class: 'small', text: 'Nouveaux codes de secours (les anciens sont invalides) :' }),
          h('pre', { class: 'recovery', text: r.recoveryCodes.join('\n') }),
          h('button', { class: 'btn small', type: 'button', text: 'Copier', onclick: () => navigator.clipboard?.writeText(r.recoveryCodes.join('\n')) }),
          h('button', { class: 'btn small', type: 'button', text: 'Fermer', onclick: () => openAccount() }),
        );
      } catch (err) {
        toast(err.message);
        openAccount();
      }
    }

    async function disable() {
      const password = await dialogs.ask({ heading: 'Désactiver la double authentification', message: 'Votre compte ne sera plus protégé que par son mot de passe. Saisissez-le pour confirmer.', confirmLabel: 'Désactiver' });
      if (password === null) return openAccount();
      try {
        await api('/api/me/2fa/disable', { method: 'POST', body: { password } });
        toast('Double authentification désactivée', 'ok');
      } catch (err) {
        toast(err.message);
      }
      openAccount();
    }

    showStatus();
    return section;
  }

  return { openAccount };
}
