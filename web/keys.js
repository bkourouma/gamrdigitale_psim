/**
 * Ecran « Cles et passerelles » (administrateur) :
 *  - passerelles : liaison de chaque compte de passerelle (connectee ou non, depuis quand, dernier message, capteurs non
 *    surveilles), lue dans /api/system (supervision de gatewaylink.ts) ;
 *  - cles d'equipement : liste, creation, remplacement (rotation avec delai de grace) et revocation (/api/device-keys).
 *
 * Regles de securite tenues ici : la valeur d'une cle n'existe que dans la fenetre d'affichage, le temps de la copier.
 * Elle n'est ni dans la page, ni dans une adresse, ni dans le stockage du navigateur, ni dans un champ de formulaire (le
 * navigateur pourrait le retenir) : elle est ecrite dans des elements <code> de la fenetre, retires a sa fermeture. La
 * fenetre ne se ferme que par son bouton (un clic a cote ou Echap ne doit pas faire perdre une cle jamais reaffichee).
 * Un formulaire de creation commence n'est jamais efface par un rafraichissement des listes.
 */
import { icon } from './core.js';
import { setBusy, field, markInvalid, clearInvalid, copyButton } from './account.js';
import { timeEl } from './system.js';
import { MAX_PATTERNS, curlExample, exampleDevice, keyState, patternProblem } from './keysdata.js';

const SHOWN_IDS = 6; // detecteurs cites en toutes lettres pour une passerelle

const GRACE_CHOICES = [
  { minutes: 0, label: 'Tout de suite : l’ancienne clé s’arrête immédiatement' },
  { minutes: 15, label: '15 minutes' },
  { minutes: 60, label: '1 heure' },
  { minutes: 240, label: '4 heures' },
  { minutes: 1440, label: '24 heures' },
];

const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

export function createKeysAdmin({ api, h, toast, dialogs, getMe, getDevices = () => [] }) {
  const gwBox = document.getElementById('gw-list');
  const gwUpdated = document.getElementById('gw-updated');
  const keysBox = document.getElementById('keys-list');
  const createBox = document.getElementById('keys-create');
  const datalist = document.getElementById('keys-device-options');
  let gwTimer = 0;
  let shownFor = null;

  const th = (text) => h('th', { scope: 'col', text });
  const loadError = (title, err, retry) =>
    h('div', { class: 'notice is-alarm' }, icon('state-alarm'), h('span', {}, h('strong', { text: `${title} ` }), `${err.message}. `, h('button', { class: 'btn btn-sm', type: 'button', text: 'Réessayer', onclick: retry })));

  // ---------------------------------------------------------------- passerelles

  function gatewayLink(g) {
    if (g.down) return { pill: h('span', { class: 'pill is-alarm' }, icon('state-alarm'), 'Liaison coupée'), since: ['Coupée depuis ', timeEl(g.since)] };
    if (!g.connected) return { pill: h('span', { class: 'pill is-warning' }, icon('state-warning'), 'Déconnectée'), since: ['Depuis ', timeEl(g.since)] };
    return { pill: h('span', { class: 'pill is-ok' }, icon('state-ok'), 'Connectée'), since: ['Depuis ', timeEl(g.since)] };
  }

  function gatewayRow(g) {
    const link = gatewayLink(g);
    const ids = g.represents ?? [];
    const declared = g.detectors ?? [];
    const represents =
      ids.length === 0
        ? [h('span', { class: 'muted', text: 'Aucun détecteur du PSIM pour l’instant' }), h('span', { class: 'hint' }, 'Ajoutez-les dans ', h('a', { href: '#/equipements', text: 'Équipements et plan' }), '.')]
        : [
            h('strong', { text: plural(ids.length, 'détecteur') }),
            h('span', { class: 'keys-ids', text: ids.slice(0, SHOWN_IDS).join(', ') + (ids.length > SHOWN_IDS ? ` et ${ids.length - SHOWN_IDS} autre${ids.length - SHOWN_IDS > 1 ? 's' : ''}` : '') }),
          ];
    return h(
      'tr',
      {},
      h('td', { 'data-label': 'Passerelle', class: 'adm-who' }, h('strong', { text: g.user }), h('span', { class: 'adm-who-sub' }, 'Autorisée pour : ', ...declared.flatMap((d, i) => [i ? ' ' : '', h('code', { class: 'keys-pattern', text: d })]))),
      h('td', { 'data-label': 'Détecteurs représentés' }, h('div', { class: 'adm-cell-stack' }, ...represents)),
      h('td', { 'data-label': 'Liaison' }, h('div', { class: 'adm-cell-stack' }, link.pill, h('span', { class: 'hint' }, ...link.since))),
      h(
        'td',
        { 'data-label': 'Dernier message reçu' },
        g.lastMessageAt ? timeEl(g.lastMessageAt) : h('span', { class: 'muted', title: 'Le PSIM ne garde pas cette date au-delà de son redémarrage.', text: 'Aucun depuis le démarrage du PSIM' }),
      ),
      h(
        'td',
        { 'data-label': 'Capteurs non surveillés' },
        g.unmonitored > 0
          ? h('div', { class: 'adm-cell-stack' }, h('span', { class: 'tag is-alarm', text: plural(g.unmonitored, 'capteur') }), h('span', { class: 'hint', text: 'Ils redeviennent surveillés au retour de la passerelle.' }))
          : h('span', { class: 'muted', text: 'Aucun' }),
      ),
    );
  }

  function renderGateways(list) {
    if (list.length === 0) {
      gwBox.replaceChildren(
        h(
          'div',
          { class: 'empty' },
          icon('signal'),
          h('strong', { text: 'Aucune passerelle déclarée' }),
          h('span', { text: 'Une passerelle relaie vers le PSIM les capteurs qui ne parlent pas directement MQTT (Zigbee, Modbus, LoRaWAN…). Chaque passerelle a son propre compte, déclaré dans les réglages du PSIM (PSIM_MQTT_GATEWAYS) avant un redémarrage. Voir docs/PASSERELLE.md.' }),
        ),
      );
      return;
    }
    const cut = list.filter((g) => g.down);
    gwBox.replaceChildren(
      cut.length
        ? h(
            'div',
            { class: 'notice is-alarm' },
            icon('state-alarm'),
            h(
              'span',
              {},
              h('strong', { text: `${plural(cut.length, 'passerelle coupée', 'passerelles coupées')}. ` }),
              cut.some((g) => g.unmonitored > 0) ? 'Les capteurs qu’elle relaie ne sont plus surveillés tant qu’elle ne répond pas : ' : 'Elle ne répond plus : ',
              'vérifiez son alimentation et sa liaison (4G, réseau).',
            ),
          )
        : null,
      h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          { class: 'data adm-stack keys-table' },
          h('caption', { class: 'sr-only', text: plural(list.length, 'passerelle') }),
          h('thead', {}, h('tr', {}, th('Passerelle'), th('Détecteurs représentés'), th('Liaison'), th('Dernier message reçu'), th('Capteurs non surveillés'))),
          h('tbody', {}, ...list.map(gatewayRow)),
        ),
      ),
    );
  }

  async function loadGateways() {
    try {
      const sys = await api('/api/system');
      renderGateways(sys.gateways ?? []);
      gwUpdated.replaceChildren('Relevé ', timeEl(Date.now(), new Date().toLocaleTimeString('fr-FR')));
    } catch (err) {
      gwUpdated.replaceChildren();
      gwBox.replaceChildren(loadError('État des passerelles illisible.', err, loadGateways));
    }
  }

  // ---------------------------------------------------------------- cles : liste

  /** Etat lisible d'une cle (pastille + precision), jamais la couleur seule. */
  function stateCell(k) {
    const state = keyState(k);
    if (state === 'active') return h('div', { class: 'adm-cell-stack' }, h('span', { class: 'pill is-ok' }, icon('state-ok'), 'Active'));
    if (state === 'rotating') {
      return h(
        'div',
        { class: 'adm-cell-stack' },
        h('span', { class: 'pill is-warning' }, icon('state-warning'), 'En rotation'),
        k.replacedBy ? h('span', { class: 'hint', text: `Remplacée par la clé n° ${k.replacedBy}` }) : null,
        h('span', { class: 'hint' }, 'Valable encore jusqu’à ', timeEl(k.revokedAt)),
      );
    }
    return h(
      'div',
      { class: 'adm-cell-stack' },
      h('span', { class: 'pill is-offline' }, icon('state-offline'), 'Révoquée'),
      k.replacedBy ? h('span', { class: 'hint', text: `Remplacée par la clé n° ${k.replacedBy}` }) : null,
      h('span', { class: 'hint' }, timeEl(k.revokedAt), k.revokedBy ? ` par ${k.revokedBy}` : ''),
    );
  }

  function keyRow(k) {
    const state = keyState(k);
    const name = `« ${k.label} » (n° ${k.id})`;
    const actions = [];
    if (state === 'active') {
      const rotate = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': `Remplacer la clé ${name}` }, icon('refresh'), 'Remplacer');
      rotate.addEventListener('click', () => openRotate(k));
      actions.push(rotate);
    }
    if (state !== 'revoked') {
      const revoke = h('button', { class: 'btn btn-sm btn-danger', type: 'button', 'aria-label': `${state === 'rotating' ? 'Révoquer maintenant' : 'Révoquer'} la clé ${name}` }, icon('lock'), state === 'rotating' ? 'Révoquer maintenant' : 'Révoquer');
      revoke.addEventListener('click', () => openRevoke(k));
      actions.push(revoke);
    }
    return h(
      'tr',
      { class: state === 'revoked' ? 'is-inactive' : '', tabindex: '-1', 'aria-label': `Clé « ${k.label} » n° ${k.id}`, 'data-key-id': String(k.id) },
      h('td', { 'data-label': 'Clé', class: 'adm-who' }, h('strong', { text: k.label }), h('span', { class: 'adm-who-sub', text: `n° ${k.id}` })),
      h('td', { 'data-label': 'Équipements' }, h('div', { class: 'keys-chips-inline' }, ...k.devices.map((d) => h('code', { class: 'keys-pattern', text: d })))),
      h('td', { 'data-label': 'Créée' }, timeEl(k.createdAt), h('span', { class: 'adm-who-sub', text: `par ${k.createdBy}` })),
      h('td', { 'data-label': 'Dernière utilisation' }, k.lastUsedAt ? timeEl(k.lastUsedAt) : h('span', { class: 'muted', text: 'Jamais utilisée' })),
      h('td', { 'data-label': 'État' }, stateCell(k)),
      h('td', { class: 'adm-actions-cell' }, actions.length ? h('div', { class: 'actions' }, ...actions) : null),
    );
  }

  function keysTable(list, caption) {
    return h(
      'div',
      { class: 'table-scroll' },
      h(
        'table',
        { class: 'data adm-stack keys-table' },
        h('caption', { class: 'sr-only', text: caption }),
        h('thead', {}, h('tr', {}, th('Clé'), th('Équipements'), th('Créée'), th('Dernière utilisation'), th('État'), h('th', { scope: 'col' }, h('span', { class: 'sr-only', text: 'Actions' })))),
        h('tbody', {}, ...list.map(keyRow)),
      ),
    );
  }

  function renderKeys(list) {
    const live = list.filter((k) => k.active).sort((a, b) => b.id - a.id);
    const revoked = list.filter((k) => !k.active).sort((a, b) => b.id - a.id);
    const parts = [];
    if (list.length === 0) {
      parts.push(
        h(
          'div',
          { class: 'empty' },
          icon('key'),
          h('strong', { text: 'Aucune clé pour l’instant' }),
          h('span', { text: 'Une clé permet à un équipement (une caméra 4G par exemple) d’envoyer ses images et ses messages au PSIM. Créez-en une ci-dessous : une clé par équipement, pour pouvoir la retirer sans toucher aux autres.' }),
        ),
      );
    } else {
      if (live.length) parts.push(keysTable(live, plural(live.length, 'clé active', 'clés actives')));
      else parts.push(h('p', { class: 'muted', text: 'Aucune clé active.' }));
      if (revoked.length) {
        parts.push(
          h(
            'details',
            { class: 'adm-recent' },
            h('summary', {}, icon('chevron-right', 'icon-sm adm-chevron'), icon('lock', 'icon-sm'), `Clés révoquées (${revoked.length})`),
            keysTable(revoked, plural(revoked.length, 'clé révoquée', 'clés révoquées')),
          ),
        );
      }
    }
    keysBox.replaceChildren(...parts);
  }

  async function loadKeys(focusId = null) {
    try {
      renderKeys(await api('/api/device-keys'));
      if (focusId !== null) keysBox.querySelector(`tr[data-key-id="${CSS.escape(String(focusId))}"]`)?.focus({ preventScroll: false });
    } catch (err) {
      keysBox.replaceChildren(loadError('Liste des clés illisible.', err, loadKeys));
    }
  }

  // ---------------------------------------------------------------- cle affichee une seule fois

  /**
   * Fenetre d'affichage de la cle. `secret` n'est tenu que par cette fonction et par les deux elements <code> de la
   * fenetre ; a la fermeture, les elements sont vides et la reference lachee.
   */
  function showSecret({ heading, lead, view, secret, extra = null, onDone }) {
    let key = secret;
    const keyEl = h('code', { class: 'keys-secret', text: key });
    const cmdEl = h('code', { class: 'keys-cmd', text: curlExample(location.origin, exampleDevice(view.devices), key) });
    let copied = false; // une copie (ou une selection) a ete demandee : fermer sans rien copier demande une seconde confirmation
    const copyKey = copyButton(h, { label: 'Copier la clé', done: 'Clé copiée', text: () => keyEl.textContent, select: () => keyEl, small: false });
    copyKey.dataset.autofocus = '';
    const copyCmd = copyButton(h, { label: 'Copier la commande', done: 'Commande copiée', text: () => cmdEl.textContent, select: () => cmdEl });
    for (const b of [copyKey, copyCmd]) b.addEventListener('click', () => (copied = true));
    const unsaved = h('p', { class: 'form-error', role: 'alert' });
    const done = h('button', { class: 'btn btn-primary', type: 'button' }, icon('check'), 'J’ai copié la clé, fermer');
    done.addEventListener('click', () => {
      if (!copied && !unsaved.textContent) {
        // Premier clic sans copie : on prévient, le second ferme (la clé ne se réaffiche jamais).
        unsaved.textContent = 'Vous n’avez pas encore copié la clé, et elle ne pourra plus être affichée. Copiez-la, ou touchez de nouveau le bouton pour fermer quand même.';
        done.replaceChildren(icon('state-warning'), 'Fermer sans avoir copié');
        return;
      }
      dialogs.close();
    });
    const content = h(
      'div',
      { class: 'keys-reveal' },
      h('p', { class: 'dialog-lead', text: lead }),
      h(
        'div',
        { class: 'notice is-warning', role: 'alert' },
        icon('state-warning'),
        h('span', {}, h('strong', { text: 'Copiez cette clé maintenant. ' }), 'Elle ne sera plus jamais affichée : le PSIM n’en garde qu’une empreinte et ne peut pas la retrouver. Si vous la perdez, il faudra la remplacer par une nouvelle.'),
      ),
      extra,
      h('div', { class: 'keys-block' }, h('h3', { text: `Clé « ${view.label} » (n° ${view.id})` }), h('div', { class: 'keys-secret-row' }, keyEl, copyKey)),
      h(
        'div',
        { class: 'keys-block' },
        h('h3', { text: 'Exemple : envoyer une image' }),
        h('pre', { class: 'keys-pre' }, cmdEl),
        h('div', { class: 'actions' }, copyCmd),
        h('p', { class: 'hint' }, 'Remplacez ', h('code', { text: location.origin }), ' par l’adresse du PSIM que l’équipement utilise, ', h('code', { text: exampleDevice(view.devices) }), ' par son identifiant et ', h('code', { text: 'photo.jpg' }), ' par le fichier à envoyer. Sous Windows PowerShell, écrivez ', h('code', { text: 'curl.exe' }), ' au lieu de ', h('code', { text: 'curl' }), '.'),
      ),
      unsaved,
      h('div', { class: 'actions dialog-actions' }, done),
    );
    // Fenetre non fermable d'un clic a cote ou par Echap : une cle perdue ne se reaffiche pas.
    dialogs.open(heading, content, {
      dismissible: false,
      onClose: () => {
        key = null;
        keyEl.textContent = '';
        cmdEl.textContent = '';
        onDone?.();
      },
    });
  }

  // ---------------------------------------------------------------- rotation et revocation

  function openRotate(k) {
    const grace = h('select', { id: 'keys-grace' }, ...GRACE_CHOICES.map((c) => h('option', { value: String(c.minutes), text: c.label })));
    grace.value = '60';
    const error = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('refresh'), 'Remplacer la clé');
    let busy = false;
    const form = h(
      'form',
      {
        class: 'dialog-form',
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          if (busy) return;
          busy = true;
          error.textContent = '';
          setBusy(submit, true);
          try {
            const made = await api(`/api/device-keys/${k.id}/rotate`, { method: 'POST', body: { graceMinutes: Number(grace.value) } });
            const { key, ...view } = made;
            const minutes = Number(grace.value);
            loadKeys();
            showSecret({
              heading: 'Nouvelle clé',
              lead: `La clé n° ${k.id} « ${k.label} » est remplacée par la clé n° ${view.id}, pour les mêmes équipements.`,
              view,
              secret: key,
              extra: h('p', { class: 'hint', text: minutes === 0 ? 'L’ancienne clé ne fonctionne plus : reconfigurez l’équipement avec la nouvelle.' : `L’ancienne clé fonctionne encore ${GRACE_CHOICES.find((c) => c.minutes === minutes)?.label ?? `${minutes} min`} : reconfigurez l’équipement avec la nouvelle avant ce délai.` }),
              onDone: () => loadKeys(view.id),
            });
          } catch (err) {
            error.textContent = err.message;
            busy = false;
            setBusy(submit, false);
          }
        },
      },
      h('p', { class: 'dialog-lead', text: `Une nouvelle clé est créée pour les mêmes équipements (${k.devices.join(', ')}). Elle s’affichera une seule fois.` }),
      field(h, 'L’ancienne clé reste valable', grace, 'Le temps de reconfigurer l’équipement sur le terrain. Passé ce délai, elle s’arrête toute seule.'),
      error,
      h('div', { class: 'actions dialog-actions' }, h('button', { class: 'btn', type: 'button', text: 'Annuler', onclick: () => dialogs.close() }), submit),
    );
    dialogs.open(`Remplacer la clé « ${k.label} »`, form);
  }

  async function openRevoke(k) {
    const rotating = keyState(k) === 'rotating';
    const ok = await dialogs.confirm({
      heading: `Révoquer la clé « ${k.label} »`,
      message: rotating
        ? `La clé n° ${k.id} est en cours de remplacement. La révoquer maintenant l’arrête tout de suite, sans attendre la fin du délai.`
        : `L’équipement qui utilise la clé n° ${k.id} ne pourra plus envoyer d’images ni de messages, tout de suite.`,
      details: `Équipements concernés : ${k.devices.join(', ')}. Cette clé ne pourra pas être réactivée : pour reprendre, créez-en une nouvelle.`,
      confirmLabel: 'Révoquer la clé',
      onConfirm: () => api(`/api/device-keys/${k.id}`, { method: 'DELETE' }),
    });
    if (!ok) return;
    toast(`Clé n° ${k.id} révoquée`, 'ok');
    loadKeys();
    document.getElementById('keys-title')?.focus();
  }

  // ---------------------------------------------------------------- creation

  const createForm = buildCreateForm();
  createBox.replaceChildren(createForm.el);

  function buildCreateForm() {
    const patterns = [];
    const label = h('input', { maxlength: '80', autocomplete: 'off', required: true, placeholder: 'ex. Caméra 4G portail' });
    const input = h('input', { id: 'keys-device-input', list: 'keys-device-options', maxlength: '64', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'ex. I-01 ou D-*' });
    const add = h('button', { class: 'btn', type: 'button' }, icon('plus'), 'Ajouter');
    const chips = h('ul', { class: 'keys-chips', 'aria-label': 'Équipements choisis' });
    const error = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('key'), 'Créer la clé');
    let busy = false;

    const known = () => getDevices();
    const nameOf = (id) => known().find((d) => d.id === id)?.name ?? null;
    const matches = (pattern) => known().filter((d) => (pattern.endsWith('*') ? d.id.startsWith(pattern.slice(0, -1)) : d.id === pattern));

    function renderChips() {
      chips.replaceChildren(
        ...patterns.map((p) => {
          const found = matches(p);
          const note = p.endsWith('*')
            ? found.length
              ? plural(found.length, 'équipement connu', 'équipements connus')
              : 'Aucun équipement connu pour l’instant'
            : (nameOf(p) ?? 'Inconnu du PSIM pour l’instant');
          const remove = h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': `Retirer ${p}` }, icon('close'));
          remove.addEventListener('click', () => {
            patterns.splice(patterns.indexOf(p), 1);
            renderChips();
            input.focus();
          });
          return h('li', { class: 'keys-chip' }, h('code', { class: 'keys-pattern', text: p }), h('span', { class: `keys-chip-note${(p.endsWith('*') ? found.length === 0 : !nameOf(p)) ? ' is-unknown' : ''}`, text: note }), remove);
        }),
      );
      chips.hidden = patterns.length === 0;
    }
    renderChips();

    /** Ajoute ce qui est saisi (un ou plusieurs identifiants separes par espace, virgule ou point-virgule). Faux si refuse. */
    function addTyped() {
      const tokens = input.value.split(/[\s,;]+/).filter(Boolean);
      for (const t of tokens) {
        const problem = patternProblem(t);
        if (problem) {
          markInvalid(input, error, problem);
          return false;
        }
        if (patterns.length >= MAX_PATTERNS && !patterns.includes(t)) {
          markInvalid(input, error, `${MAX_PATTERNS} équipements au plus par clé : créez une autre clé.`);
          return false;
        }
      }
      for (const t of tokens) if (!patterns.includes(t)) patterns.push(t);
      input.value = '';
      clearInvalid(form, error);
      renderChips();
      return true;
    }
    add.addEventListener('click', () => {
      clearInvalid(form, error);
      if (input.value.trim()) addTyped();
      input.focus();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); // Entree ajoute l'identifiant, elle n'envoie pas le formulaire
      clearInvalid(form, error);
      if (input.value.trim()) addTyped();
    });

    const form = h(
      'form',
      {
        class: 'adm-form',
        novalidate: true,
        autocomplete: 'off',
        onsubmit: async (e) => {
          e.preventDefault();
          if (busy) return;
          clearInvalid(form, error);
          if (!label.value.trim()) return markInvalid(label, error, 'Donnez un nom à la clé, pour la reconnaître plus tard (ex. « Caméra 4G portail »).');
          if (input.value.trim() && !addTyped()) return;
          if (patterns.length === 0) return markInvalid(input, error, 'Choisissez au moins un équipement : saisissez son identifiant, puis « Ajouter ».');
          busy = true;
          setBusy(submit, true);
          try {
            const made = await api('/api/device-keys', { method: 'POST', body: { label: label.value.trim(), devices: [...patterns] } });
            const { key, ...view } = made;
            form.reset();
            patterns.length = 0;
            renderChips();
            loadKeys();
            showSecret({ heading: 'Clé créée', lead: `La clé « ${view.label} » est créée pour : ${view.devices.join(', ')}.`, view, secret: key, onDone: () => loadKeys(view.id) });
          } catch (err) {
            const target = /label|nom de la cle/i.test(err.message) ? label : /devices|identifiant|prefixe/i.test(err.message) ? input : null;
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
        field(h, 'Nom de la clé', label, 'Pour la reconnaître : l’équipement ou l’endroit où elle sert.'),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'keys-device-input' }, h('span', { text: 'Équipements concernés' })),
          h('span', { class: 'adm-input-row' }, input, add),
          h('span', { class: 'hint', id: 'keys-device-hint', text: 'Un identifiant exact (I-01) ou un début d’identifiant terminé par « * » (D-* pour tous ceux qui commencent par D-). Appuyez sur Entrée pour l’ajouter.' }),
        ),
      ),
      chips,
      error,
      h('div', { class: 'actions' }, submit),
    );
    input.setAttribute('aria-describedby', 'keys-device-hint');
    return {
      el: form,
      refreshKnown: renderChips,
      reset() {
        form.reset();
        patterns.length = 0;
        renderChips();
        clearInvalid(form, error);
      },
    };
  }

  function fillDatalist() {
    datalist.replaceChildren(...getDevices().map((d) => h('option', { value: d.id, label: d.name })));
    createForm.refreshKnown();
  }

  // ---------------------------------------------------------------- entree et sortie de l'ecran

  document.getElementById('gw-refresh')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setBusy(btn, true);
    await Promise.all([loadGateways(), loadKeys()]);
    setBusy(btn, false);
  });

  function show() {
    if (getMe()?.role !== 'admin') return;
    // Un autre compte sur ce poste : rien de la session precedente ne reste (formulaire, listes).
    if (shownFor !== getMe().username) {
      shownFor = getMe().username;
      createForm.reset();
    }
    fillDatalist();
    loadGateways();
    loadKeys();
    clearInterval(gwTimer);
    gwTimer = setInterval(loadGateways, 15000); // la liaison change vite ; cette liste n'a aucune commande a perdre
  }

  function hide() {
    clearInterval(gwTimer);
    gwTimer = 0;
  }

  return { show, hide };
}
