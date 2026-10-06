/**
 * Fenêtre commune (#dialog) et fenêtre « Mon compte » : mot de passe, double authentification (QR code, codes de secours).
 *
 * La fenêtre commune sert à tous les écrans : afficher un contenu (open), demander une valeur (ask), faire confirmer un
 * geste grave en mots simples (confirm). Elle retient le focus tant qu'elle est ouverte et le rend ensuite à la commande
 * qui l'a ouverte. Un clic à côté ne la ferme pas si une saisie y est commencée (un mot de passe tapé n'est pas perdu
 * sur un geste maladroit) ; Échap et le bouton Fermer restent des gestes volontaires.
 */
import { icon, hasUnsavedInput } from './core.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let uidCount = 0;
/** Identifiant unique d'élément (liens libellé / aide / erreur des champs créés en JavaScript). */
export const uid = (prefix = 'f') => `${prefix}-${++uidCount}`;

/** Bouton occupé : roue à la place du texte, nom lu inchangé, double clic sans effet. */
export function setBusy(button, busy) {
  button.classList.toggle('is-busy', busy);
  button.toggleAttribute('aria-busy', busy);
  button.disabled = busy;
}

/** Champ libellé (base.css `.field`) avec aide et zone d'erreur reliées au champ pour les lecteurs d'écran. */
export function field(h, label, input, hintText = '') {
  const hint = hintText ? h('span', { class: 'hint', id: uid('hint'), text: hintText }) : null;
  if (hint) input.setAttribute('aria-describedby', hint.id);
  return h('label', { class: 'field' }, h('span', { text: label }), input, hint);
}

/** Erreur posée sur un champ : bordure rouge, message relié, focus sur le champ à corriger. */
export function markInvalid(input, errorEl, message) {
  errorEl.textContent = message;
  if (!input) return;
  input.setAttribute('aria-invalid', 'true');
  if (!errorEl.id) errorEl.id = uid('err');
  const ids = new Set((input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean));
  ids.add(errorEl.id);
  input.setAttribute('aria-describedby', [...ids].join(' '));
  input.focus();
}

export function clearInvalid(form, errorEl) {
  errorEl.textContent = '';
  for (const el of form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
}

/**
 * Copie un texte dans le presse-papiers. Sans presse-papiers (navigateur ancien, page non sécurisée), le texte affiché
 * dans `fallbackEl` est sélectionné : il reste à appuyer sur Ctrl+C. Renvoie vrai si la copie a réussi.
 */
export async function copyText(text, fallbackEl) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (fallbackEl instanceof HTMLInputElement) {
      fallbackEl.focus();
      fallbackEl.select();
    } else if (fallbackEl) {
      const range = document.createRange();
      range.selectNodeContents(fallbackEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return false;
  }
}

/** Bouton « Copier » qui dit ce qui s'est passé (copié, ou texte sélectionné à copier soi-même). */
export function copyButton(h, { label, done = 'Copié', text, select, small = true }) {
  const btn = h('button', { class: `btn${small ? ' btn-sm' : ''}`, type: 'button' }, h('span', { text: label }));
  let timer = 0;
  btn.addEventListener('click', async () => {
    const ok = await copyText(typeof text === 'function' ? text() : text, typeof select === 'function' ? select() : select);
    clearTimeout(timer);
    btn.replaceChildren(icon(ok ? 'check' : 'info'), h('span', { text: ok ? done : 'Sélectionné : appuyez sur Ctrl+C' }));
    timer = setTimeout(() => btn.replaceChildren(h('span', { text: label })), 4000);
  });
  return btn;
}

let sharedDialogs = null;

/** Une seule fenêtre dans la page : les appels suivants renvoient la même instance (équipements, sources, comptes). */
export function createDialogs({ h }) {
  if (sharedDialogs) return sharedDialogs;
  const root = document.getElementById('dialog');
  const card = root.querySelector('.dialog-card');
  const title = document.getElementById('dialog-title');
  const body = document.getElementById('dialog-body');
  let onClose = null;
  let dismissible = true;
  let opener = null; // commande qui a ouvert la fenêtre : elle retrouve le focus à la fermeture

  // Bouton Fermer : posé une fois dans la carte, à droite du titre ; masqué quand la fenêtre ne peut pas être fermée
  // (compte restreint, codes de secours à ranger).
  const closeBtn = h('button', { class: 'btn btn-ghost btn-icon dialog-close', type: 'button', 'aria-label': 'Fermer la fenêtre', title: 'Fermer' }, icon('close'));
  closeBtn.addEventListener('click', () => dismissible && close());
  title.after(closeBtn);

  function setDismissible(value) {
    dismissible = value;
    closeBtn.hidden = !value;
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    body.replaceChildren();
    const cb = onClose;
    onClose = null;
    const back = opener;
    opener = null;
    cb?.();
    // Le focus revient à la commande d'origine, sauf si la suite (rappel onClose) l'a déjà placé ailleurs.
    const lost = !document.activeElement || document.activeElement === document.body || root.contains(document.activeElement);
    if (back?.isConnected && lost) back.focus({ preventScroll: true });
  }

  function open(heading, content, options = {}) {
    if (root.hidden) opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    setDismissible(options.dismissible !== false);
    onClose = options.onClose ?? null;
    title.textContent = heading;
    body.replaceChildren(...[content].flat().filter(Boolean));
    root.hidden = false;
    card.scrollTop = 0;
    (body.querySelector('[data-autofocus]') ?? [...body.querySelectorAll(FOCUSABLE)].find((el) => el.getClientRects().length > 0) ?? closeBtn).focus();
  }

  root.addEventListener('click', (e) => {
    if (e.target === root && dismissible && !hasUnsavedInput(body)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden && dismissible) close();
  });
  // Le focus reste dans la fenêtre : Tab et Maj+Tab tournent entre ses commandes.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || root.hidden) return;
    const items = [...card.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !card.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  /**
   * Demande un mot de passe (ou une valeur masquée) ; renvoie la valeur, ou null si annulé. Avec `onSubmit(valeur)`, la
   * fenêtre reste ouverte pendant l'envoi (bouton occupé) et affiche l'erreur du serveur sur place, sans tout ressaisir.
   */
  function ask({ heading, message, label = 'Mot de passe', confirmLabel = 'Valider', generate = false, danger = false, onSubmit = null, autocomplete = 'new-password' }) {
    return new Promise((resolve) => {
      let settled = false;
      let busy = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
        close();
      };
      const input = h('input', { type: 'password', autocomplete, spellcheck: 'false', autocapitalize: 'none', required: true });
      const error = h('p', { class: 'form-error', role: 'alert' });
      const show = h('input', { type: 'checkbox' });
      show.addEventListener('change', () => (input.type = show.checked ? 'text' : 'password'));
      const copy = generate ? copyButton(h, { label: 'Copier', text: () => input.value }) : null;
      if (copy) copy.hidden = true;
      const submit = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'submit' }, confirmLabel);
      const form = h(
        'form',
        {
          class: 'dialog-form',
          novalidate: true,
          onsubmit: async (e) => {
            e.preventDefault();
            if (busy) return;
            clearInvalid(form, error);
            if (!input.value) return markInvalid(input, error, `Saisissez le ${label.toLowerCase()}.`);
            if (!onSubmit) return done(input.value);
            busy = true;
            setBusy(submit, true);
            try {
              await onSubmit(input.value);
              done(input.value);
            } catch (err) {
              markInvalid(input, error, err.message);
            } finally {
              busy = false;
              setBusy(submit, false);
            }
          },
        },
        message ? h('p', { class: 'dialog-lead', text: message }) : null,
        field(h, label, input),
        h(
          'div',
          { class: 'dialog-tools' },
          h('label', { class: 'check' }, show, h('span', { text: 'Afficher' })),
          generate
            ? h('button', {
                class: 'btn btn-sm',
                type: 'button',
                text: 'Générer un mot de passe solide',
                onclick: () => {
                  input.value = randomPassword();
                  input.dispatchEvent(new Event('input', { bubbles: true })); // compte comme une saisie (fenêtre protégée)
                  show.checked = true;
                  input.type = 'text';
                  copy.hidden = false;
                  input.focus();
                  input.select();
                },
              })
            : null,
          copy,
        ),
        error,
        h('div', { class: 'actions dialog-actions' }, h('button', { class: 'btn', type: 'button', text: 'Annuler', onclick: () => done(null) }), submit),
      );
      open(heading, form, { onClose: () => done(null) });
      input.focus();
    });
  }

  /**
   * Fait confirmer un geste en mots simples ; renvoie vrai si confirmé. « Annuler » a le focus : Entrée ne détruit rien.
   * Avec `onConfirm()`, l'action part pendant que la fenêtre est ouverte et son erreur s'affiche sur place.
   */
  function confirm({ heading, message, details = null, confirmLabel = 'Confirmer', danger = true, onConfirm = null }) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
        close();
      };
      const error = h('p', { class: 'form-error', role: 'alert' });
      const ok = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button' }, confirmLabel);
      ok.addEventListener('click', async () => {
        if (!onConfirm) return done(true);
        error.textContent = '';
        setBusy(ok, true);
        try {
          await onConfirm();
          done(true);
        } catch (err) {
          error.textContent = err.message;
          setBusy(ok, false);
          ok.focus();
        }
      });
      open(
        heading,
        [
          h('p', { class: 'dialog-lead', text: message }),
          details ? h('div', { class: 'dialog-details' }, details) : null,
          error,
          h('div', { class: 'actions dialog-actions' }, h('button', { class: 'btn', type: 'button', text: 'Annuler', onclick: () => done(false) }), ok),
        ],
        { onClose: () => done(false) },
      );
    });
  }

  sharedDialogs = { open, close, ask, confirm, setDismissible };
  return sharedDialogs;
}

/** Mot de passe aléatoire de 20 caractères (alphabet sans caractères ambigus), en groupes de 5. */
export function randomPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return chars.match(/.{5}/g).join('-');
}

const ROLE_LABEL = { operator: 'Opérateur', admin: 'Administrateur' };
const MIN_PASSWORD = 12; // même règle que le serveur (server/auth.ts)

const RESTRICTION = {
  password: {
    title: 'Choisissez votre mot de passe',
    text: 'Votre mot de passe actuel a été donné par un administrateur. Choisissez-en un nouveau, que vous seul connaissez, avant de continuer.',
  },
  '2fa': {
    title: 'Activez la double authentification',
    text: "L’administration l’impose sur ce compte : à chaque connexion, un code à 6 chiffres affiché par votre téléphone vous sera demandé en plus du mot de passe. Suivez les trois étapes ci-dessous.",
  },
};

export function createAccountUi({ api, h, toast, dialogs, getMe, refreshMe, logout }) {
  /** Ouvre (ou redessine) la fenêtre. Compte restreint : la seule étape exigée, et pas de fermeture possible. */
  async function openAccount() {
    try {
      await refreshMe();
    } catch (err) {
      toast(err.message);
      return;
    }
    const me = getMe();
    const forced = me.restricted ?? null;
    const content = h(
      'div',
      { class: 'account' },
      identity(me),
      forced ? restrictedNotice(forced) : null,
      forced === '2fa' ? null : passwordSection(me, forced),
      forced === 'password' ? null : twoFactorSection(forced),
    );
    dialogs.open('Mon compte', content, { dismissible: !forced });
  }

  function identity(me) {
    const name = me.displayName || me.username;
    return h(
      'div',
      { class: 'account-who' },
      h('span', { class: 'account-avatar' }, icon('user')),
      h('div', { class: 'account-who-text' }, h('strong', { text: name }), h('span', { class: 'muted', text: `${me.displayName ? `${me.username} · ` : ''}${ROLE_LABEL[me.role] ?? me.role}` })),
    );
  }

  function restrictedNotice(kind) {
    const r = RESTRICTION[kind] ?? { title: 'Une étape est requise', text: 'Une étape est requise sur votre compte avant de continuer.' };
    return h(
      'div',
      { class: 'notice is-warning account-restricted', role: 'alert' },
      icon('state-warning'),
      h(
        'div',
        { class: 'account-restricted-text' },
        h('strong', { text: r.title }),
        h('p', { text: r.text }),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: logout }, icon('logout'), 'Se déconnecter'),
      ),
    );
  }

  function sectionHead(id, title, extra = null) {
    return h('div', { class: 'account-section-head' }, h('h3', { id, text: title }), extra);
  }

  // ---------------------------------------------------------------- mot de passe

  function passwordSection(me, forced) {
    const headId = uid('acc');
    const current = h('input', { type: 'password', autocomplete: 'current-password', required: true, spellcheck: 'false' });
    const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, spellcheck: 'false' });
    const again = h('input', { type: 'password', autocomplete: 'new-password', required: true, spellcheck: 'false' });
    const show = h('input', { type: 'checkbox' });
    show.addEventListener('change', () => {
      for (const input of [current, next, again]) input.type = show.checked ? 'text' : 'password';
    });
    const error = h('p', { class: 'form-error', role: 'alert' });
    const success = h('div', { class: 'notice is-ok', role: 'status', hidden: true }, icon('state-ok'), h('span', { text: 'Mot de passe changé. Vos autres sessions ouvertes ont été fermées : reconnectez-vous sur les autres postes.' }));
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, forced ? 'Enregistrer mon nouveau mot de passe' : 'Changer le mot de passe');
    let busy = false;

    const form = h(
      'form',
      {
        class: 'account-form',
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          if (busy) return;
          clearInvalid(form, error);
          success.hidden = true;
          if (!current.value) return markInvalid(current, error, 'Saisissez votre mot de passe actuel.');
          if (next.value.length < MIN_PASSWORD) return markInvalid(next, error, `Le nouveau mot de passe doit compter ${MIN_PASSWORD} caractères au moins.`);
          if (next.value !== again.value) return markInvalid(again, error, 'Les deux saisies du nouveau mot de passe sont différentes : retapez-le.');
          busy = true;
          setBusy(submit, true);
          try {
            await api('/api/me/password', { method: 'POST', body: { current: current.value, next: next.value } });
            toast('Mot de passe changé', 'ok');
            if (forced) return void (await afterStep(forced));
            form.reset();
            success.hidden = false;
          } catch (err) {
            markInvalid(/actuel/i.test(err.message) ? current : /tentatives/i.test(err.message) ? null : next, error, err.message);
          } finally {
            busy = false;
            setBusy(submit, false);
          }
        },
      },
      // Identifiant du compte, invisible : un gestionnaire de mots de passe sait ainsi à quel compte rattacher le nouveau.
      h('input', { type: 'text', name: 'username', autocomplete: 'username', value: me.username, readonly: true, hidden: true, tabindex: '-1' }),
      field(h, 'Mot de passe actuel', current),
      h(
        'div',
        { class: 'account-pair' },
        field(h, 'Nouveau mot de passe', next, `${MIN_PASSWORD} caractères au moins. Une phrase de plusieurs mots est facile à retenir et difficile à deviner.`),
        field(h, 'Confirmer le nouveau mot de passe', again),
      ),
      h('label', { class: 'check' }, show, h('span', { text: 'Afficher les mots de passe' })),
      error,
      h('div', { class: 'actions' }, submit),
      success,
    );
    if (forced) current.dataset.autofocus = '';
    return h('section', { class: 'account-section', 'aria-labelledby': headId }, sectionHead(headId, 'Mot de passe'), form);
  }

  /** Après une étape exigée (compte restreint) : plus aucune restriction, l'application repart d'un état propre. */
  async function afterStep(forced) {
    try {
      await refreshMe();
    } catch (err) {
      toast(err.message);
      return;
    }
    if (forced && !getMe().restricted) {
      dialogs.close();
      location.reload(); // temps réel, droits et écrans démarrent avec le compte libéré
    } else openAccount();
  }

  // ---------------------------------------------------------------- double authentification

  function twoFactorSection(forced) {
    const headId = uid('acc');
    const pill = h('span', { class: 'pill' });
    const body = h('div', { class: 'account-2fa' });
    const swap = (...nodes) => body.replaceChildren(...nodes.filter(Boolean)); // ignore les éléments absents (null)
    const section = h('section', { class: 'account-section', 'aria-labelledby': headId }, sectionHead(headId, 'Double authentification', pill), body);

    const setPill = (on) => {
      pill.className = `pill ${on ? 'is-ok' : 'is-offline is-dashed'}`;
      pill.replaceChildren(icon(on ? 'lock' : 'unlock'), on ? 'Activée' : 'Non activée');
    };

    function showStatus() {
      const m = getMe();
      setPill(m.totpEnabled);
      dialogs.setDismissible(!forced);
      if (m.totpEnabled) {
        const few = m.recoveryLeft <= 2;
        swap(
          h('p', { text: 'À chaque connexion, un code à 6 chiffres affiché par votre téléphone vous est demandé en plus du mot de passe.' }),
          few
            ? h(
                'div',
                { class: 'notice is-warning' },
                icon('state-warning'),
                h('span', { text: m.recoveryLeft === 0 ? "Vous n’avez plus de code de secours : si vous perdez votre téléphone, vous ne pourrez plus vous connecter. Générez-en de nouveaux." : `Il ne vous reste que ${m.recoveryLeft} code${m.recoveryLeft > 1 ? 's' : ''} de secours. Générez-en de nouveaux et rangez-les en lieu sûr.` }),
              )
            : h('p', { class: 'muted', text: `${m.recoveryLeft} codes de secours restants, pour vous connecter si vous perdez votre téléphone.` }),
          h(
            'div',
            { class: 'actions' },
            h('button', { class: 'btn', type: 'button', onclick: () => askPassword('regenerate') }, icon('refresh'), 'Nouveaux codes de secours'),
            h('button', { class: 'btn btn-danger', type: 'button', onclick: () => askPassword('disable') }, 'Désactiver'),
          ),
        );
      } else {
        const start = h('button', { class: 'btn btn-primary', type: 'button' }, icon('shield'), 'Activer la double authentification');
        start.addEventListener('click', () => enroll(start));
        if (forced) start.dataset.autofocus = '';
        swap(
          forced ? null : h('p', { text: 'Un mot de passe volé suffirait pour se connecter à votre place. Avec la double authentification, il faut aussi un code à 6 chiffres que seul votre téléphone affiche.' }),
          h('div', { class: 'actions' }, start),
        );
      }
    }

    async function enroll(button) {
      setBusy(button, true);
      let setup;
      try {
        setup = await api('/api/me/2fa/setup', { method: 'POST' });
      } catch (err) {
        setBusy(button, false);
        toast(err.message);
        return;
      }
      const key = setup.secret.match(/.{1,4}/g).join(' ');
      const keyEl = h('code', { class: 'account-secret', text: key });
      const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '7', placeholder: '123456', required: true, class: 'account-code', spellcheck: 'false' });
      const error = h('p', { class: 'form-error', role: 'alert' });
      const verify = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Vérifier et activer');
      let busy = false;
      const form = h(
        'form',
        {
          class: 'account-code-form',
          novalidate: true,
          onsubmit: async (e) => {
            e.preventDefault();
            if (busy) return;
            clearInvalid(form, error);
            if (!/^\d{6}$/.test(code.value.replace(/\s/g, ''))) return markInvalid(code, error, "Saisissez les 6 chiffres affichés par l’application.");
            busy = true;
            setBusy(verify, true);
            try {
              const done = await api('/api/me/2fa/enable', { method: 'POST', body: { code: code.value.replace(/\s/g, '') } });
              setPill(true);
              showCodes(done.recoveryCodes, 'Double authentification activée.', true);
            } catch (err) {
              markInvalid(code, error, err.message);
              code.select();
            } finally {
              busy = false;
              setBusy(verify, false);
            }
          },
        },
        h('div', { class: 'account-code-row' }, field(h, 'Code à 6 chiffres', code, 'Le code change toutes les 30 secondes : saisissez celui affiché à cet instant.'), verify),
        error,
      );
      swap(
        h(
          'ol',
          { class: 'account-steps' },
          step(1, "Installez une application d’authentification", h('p', { class: 'hint', text: 'Sur votre téléphone : Google Authenticator, Microsoft Authenticator, Aegis ou FreeOTP, par exemple. Elles sont gratuites.' })),
          step(
            2,
            "Scannez ce QR code avec l’application",
            h('img', { class: 'account-qr', alt: "QR code à scanner avec votre application d’authentification", src: `data:image/svg+xml;base64,${btoa(setup.qrSvg)}`, width: '200', height: '200' }),
            h('p', { class: 'hint', text: "Impossible de scanner ? Dans l’application, choisissez la saisie manuelle et tapez cette clé :" }),
            h('div', { class: 'account-key' }, keyEl, copyButton(h, { label: 'Copier la clé', done: 'Clé copiée', text: setup.secret, select: keyEl })),
          ),
          step(3, "Saisissez le code affiché par l’application", form),
        ),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-ghost', type: 'button', text: 'Annuler', onclick: () => showStatus() })),
      );
      code.focus();
    }

    function step(n, title, ...content) {
      return h('li', { class: 'account-step' }, h('span', { class: 'account-step-num', 'aria-hidden': 'true', text: String(n) }), h('div', { class: 'account-step-body' }, h('strong', { text: `${title}` }), ...content));
    }

    /**
     * Codes de secours : montrés une seule fois. La fenêtre ne se ferme pas tant que la personne n'a pas dit les avoir
     * rangés (un Échap ou un clic à côté les perdrait pour de bon).
     */
    function showCodes(codes, heading, enabledNow = false) {
      dialogs.setDismissible(false);
      const list = h('ol', { class: 'account-codes', 'aria-label': 'Codes de secours' }, ...codes.map((c) => h('li', { text: c })));
      const kept = h('input', { type: 'checkbox' });
      const finish = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Terminer');
      kept.addEventListener('change', () => (finish.disabled = !kept.checked));
      finish.addEventListener('click', async () => {
        setBusy(finish, true);
        if (enabledNow) toast('Double authentification activée', 'ok');
        await afterStep(forced);
      });
      swap(
        h('div', { class: 'notice is-ok', role: 'status' }, icon('state-ok'), h('strong', { text: heading })),
        h('h4', { class: 'account-codes-title', text: 'Vos codes de secours' }),
        h('p', { text: 'Si vous perdez votre téléphone, chaque code permet une seule connexion. Rangez-les en lieu sûr (gestionnaire de mots de passe, papier sous clé) : ils ne seront plus jamais affichés.' }),
        list,
        h('div', { class: 'actions' }, copyButton(h, { label: 'Copier les codes', done: 'Codes copiés', text: codes.join('\n'), select: list, small: false })),
        h('label', { class: 'check account-kept' }, kept, h('span', { text: "J’ai rangé ces codes en lieu sûr" })),
        h('div', { class: 'actions' }, finish),
      );
      list.scrollIntoView({ block: 'nearest' });
    }

    /** Geste sensible sur la double authentification : le mot de passe est redemandé, sur place. */
    function askPassword(kind) {
      const regenerate = kind === 'regenerate';
      const password = h('input', { type: 'password', autocomplete: 'current-password', required: true, spellcheck: 'false' });
      const error = h('p', { class: 'form-error', role: 'alert' });
      const submit = h('button', { class: `btn ${regenerate ? 'btn-primary' : 'btn-danger'}`, type: 'submit' }, regenerate ? 'Générer de nouveaux codes' : 'Désactiver la double authentification');
      let busy = false;
      const form = h(
        'form',
        {
          class: 'account-form',
          novalidate: true,
          onsubmit: async (e) => {
            e.preventDefault();
            if (busy) return;
            clearInvalid(form, error);
            if (!password.value) return markInvalid(password, error, 'Saisissez votre mot de passe.');
            busy = true;
            setBusy(submit, true);
            try {
              if (regenerate) {
                const r = await api('/api/me/2fa/recovery', { method: 'POST', body: { password: password.value } });
                showCodes(r.recoveryCodes, 'Nouveaux codes créés : les anciens ne fonctionnent plus.');
              } else {
                await api('/api/me/2fa/disable', { method: 'POST', body: { password: password.value } });
                toast('Double authentification désactivée', 'ok');
                openAccount();
              }
            } catch (err) {
              markInvalid(password, error, err.message);
            } finally {
              busy = false;
              setBusy(submit, false);
            }
          },
        },
        h(
          'p',
          {
            text: regenerate
              ? 'Les codes de secours actuels cesseront de fonctionner. Saisissez votre mot de passe pour confirmer.'
              : 'Votre compte ne sera plus protégé que par son mot de passe. Saisissez-le pour confirmer.',
          },
        ),
        field(h, 'Votre mot de passe', password),
        error,
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', text: 'Annuler', onclick: () => showStatus() }), submit),
      );
      body.replaceChildren(form);
      password.focus();
    }

    showStatus();
    return section;
  }

  return { openAccount };
}
