/**
 * Commandes des equipements (sirene, projecteur, relais, gache, portail, haut-parleur) : panneau « Commandes » ouvert
 * depuis la fiche d'un incident (boite de confirmation explicite, etat en direct, historique) et configuration des
 * actionneurs dans l'ecran Equipements et plan (administrateur). Conception : docs/COMMANDES.md.
 *
 * Securite : le serveur decide de tout (droits, bornes de duree, raison, mot de passe, liaison, mode maintenance) ;
 * l'interface rend ces regles lisibles avant l'envoi. Jamais « fait » sans accuse : l'etat affiche est celui du serveur,
 * mis a jour en direct, y compris « envoyee, accuse non recu : l'ordre a pu etre execute ».
 */
import { $, h, icon, api, toast, S, on, time } from './core.js';
import { createDialogs, field, setBusy, copyButton } from './account.js';
import { withReauth, reauthField } from './reauth.js';

const TYPE_LABEL = { siren: 'Sirène', light: 'Projecteur', relay: 'Relais', lock: 'Serrure / gâche', gate: 'Portail / barrière', speaker: 'Haut-parleur' };
const ACTION_LABEL = { on: 'Déclencher', off: 'Arrêter', pulse: 'Impulsion', unlock: 'Déverrouiller', lock: 'Verrouiller', open: 'Ouvrir', close: 'Fermer', stop: 'Arrêter', play: 'Diffuser un message' };
const STATE_LABEL = {
  pending: 'En attente d’envoi',
  sent: 'Envoyée — accusé attendu',
  acked: 'Accusée par l’équipement',
  refused: 'Refusée par l’équipement',
  failed: 'Échec',
  expired: 'Expirée (jamais renvoyée)',
  cancelled: 'Annulée',
};
const STATE_TAG = { pending: 'is-warning', sent: 'is-warning', acked: 'is-ok', refused: 'is-alarm', failed: 'is-alarm', expired: 'is-dashed', cancelled: 'is-dashed' };

let actuators = null; // GET /api/actuators : liste visible par ce compte (avec les actions permises)
let lock = { locked: false };
const live = new Map(); // cmdId -> derniere version recue (temps reel)
const watchers = new Set(); // rendus a rappeler quand la liste ou une commande change

const dialogs = () => createDialogs({ h });
/** Enfants sans les absents : replaceChildren(null) ecrirait « null » a l ecran. */
const nodes = (...xs) => xs.flat().filter(Boolean);
const notify = () => {
  for (const fn of [...watchers]) fn();
};

async function loadList() {
  const res = await api('/api/actuators');
  actuators = res.actuators;
  lock = res.lock;
  notify();
}

// Une reponse d'API peut arriver APRES l'evenement temps reel de la meme commande : jamais revenir a un etat anterieur.
const RANK = { pending: 0, sent: 1 };
function remember(c) {
  const prev = live.get(c.cmdId);
  if (!prev || (RANK[c.state] ?? 2) >= (RANK[prev.state] ?? 2)) live.set(c.cmdId, c);
}

on('command', (c) => {
  const before = live.get(c.cmdId);
  remember(c);
  if (live.size > 300) live.delete(live.keys().next().value);
  // Un echec ou un accuse tardif ne doit pas passer inapercu, meme fenetre fermee.
  if (c.state === 'failed' && before?.state !== 'failed') toast(`Commande « ${ACTION_LABEL[c.action] ?? c.action} » sur ${nameOf(c.actuatorId)} : ${c.uncertain ? 'aucun accusé, l’ordre a pu être exécuté' : c.ack ?? 'échec'}`);
  if (c.lateAck && !before?.lateAck) toast(`Accusé tardif (${c.lateAck}) pour « ${ACTION_LABEL[c.action] ?? c.action} » sur ${nameOf(c.actuatorId)}`);
  notify();
});
on('actuators', () => void loadList().catch(() => {}));

const nameOf = (id) => actuators?.find((a) => a.id === id)?.name ?? id;

/** Texte d'etat d'une commande, sans rien supposer : un 2xx HTTP n'est qu'une reception par le relais. */
export function stateText(c) {
  let text = STATE_LABEL[c.state] ?? c.state;
  if (c.state === 'acked' && c.ackKind === 'http') text = 'Reçue par le relais (HTTP 2xx)';
  if (c.state === 'failed' && c.uncertain) text = 'Échec : aucun accusé — l’ordre a pu être exécuté';
  else if (c.state === 'failed' && c.ack) text = `Échec : ${c.ack}`;
  if (c.lateAck) text += ` · accusé tardif « ${c.lateAck} » à ${time(c.lateAckAt)}`;
  if (c.cancelledAt) text += ` · arrêtée par ${c.cancelledBy}`;
  return text;
}

/** Avertissement rouge : le retour a l'etat sur (verrouiller, arreter...) n'a pas ete confirme par l'equipement. */
const unconfirmedWarning = (c) =>
  c.returnUnconfirmed === true ? h('p', { class: 'notice is-alarm', role: 'alert', text: 'Retour à l’état sûr NON CONFIRMÉ : vérifier l’équipement sur place' }) : null;

function commandLine(c) {
  return h(
    'li',
    { class: 'cmd-line' },
    unconfirmedWarning(c),
    h('span', { class: `tag ${STATE_TAG[c.state] ?? ''}`, text: stateText(c) }),
    h('span', { text: ` ${ACTION_LABEL[c.action] ?? c.action}${c.durationS ? ` ${c.durationS} s` : ''} — ${nameOf(c.actuatorId)} — ${c.requestedBy}${c.auto ? ' (retour automatique)' : ''} — ${time(c.requestedAt)}` }),
    c.reason ? h('span', { class: 'muted', text: ` — « ${c.reason} »` }) : null,
  );
}

// ---------------------------------------------------------------- envoi d'une commande

const timed = (a, action) => a.actions[action]?.maxS !== undefined;
const needsReason = (a, action) => a.sensitive && action !== a.safeAction;
const needsPassword = (a, action) => a.confirm === 'reauth' && action !== a.safeAction;

/** Boite de confirmation explicite : actionneur, action, duree, raison (et mot de passe pour une serrure ou un portail). */
function askCommand(a, action, ctx) {
  const cfg = a.actions[action];
  const label = ACTION_LABEL[action] ?? action;
  const error = h('p', { class: 'form-error', role: 'alert' });
  const duration = timed(a, action)
    ? h('input', { type: 'number', min: String(cfg.minS), max: String(cfg.maxS), step: '1', value: String(Math.min(cfg.maxS, Math.max(cfg.minS, 10))), required: !cfg.unbounded, 'data-autofocus': true })
    : null;
  const clip = action === 'play' ? h('input', { type: 'text', maxlength: '32', pattern: '[A-Za-z0-9_-]{1,32}', required: true, spellcheck: 'false' }) : null;
  const reason = h('textarea', { rows: '2', maxlength: '200', required: needsReason(a, action) });
  const password = needsPassword(a, action) ? h('input', { type: 'password', autocomplete: 'current-password', required: true }) : null;
  const sure = h('input', { type: 'checkbox', required: true });
  const sureText = h('span');
  const updateSure = () => {
    const d = duration?.value ? ` pendant ${duration.value} s` : duration ? ' SANS LIMITE DE DURÉE' : '';
    sureText.textContent = `Je confirme : ${label.toLowerCase()} « ${a.name} »${d}.`;
  };
  duration?.addEventListener('input', updateSure);
  updateSure();
  const submit = h('button', { class: 'btn btn-danger', type: 'submit' }, icon('send'), h('span', { text: 'Envoyer la commande' }));
  const form = h(
    'form',
    {
      class: 'dialog-form',
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        if (!sure.checked) return void (error.textContent = 'Cochez la confirmation.');
        const params = {};
        if (duration && duration.value !== '') params.durationS = Number(duration.value);
        if (clip) params.clip = clip.value.trim();
        setBusy(submit, true);
        try {
          const res = await api(`/api/actuators/${encodeURIComponent(a.id)}/commands`, {
            method: 'POST',
            body: { action, params, reason: reason.value.trim() || undefined, confirm: true, incidentId: ctx.incidentId ?? undefined, password: password?.value || undefined },
          });
          remember(res.command);
          if (res.deduplicated) toast('Commande identique déjà en cours : rien n’a été renvoyé.', 'ok');
          showStatus(a, res.command.cmdId, ctx);
        } catch (err) {
          error.textContent = err.message;
          setBusy(submit, false);
        }
      },
    },
    h('p', { class: 'dialog-lead', text: `${TYPE_LABEL[a.type] ?? a.type} « ${a.name} »${a.zone ? `, zone ${a.zone}` : ''} : ${label.toLowerCase()}.` }),
    a.emergencyExit ? h('p', { class: 'notice is-warning', text: 'Issue de secours : le PSIM ne la verrouille jamais.' }) : null,
    duration ? field(h, `Durée (secondes, ${cfg.minS} à ${cfg.maxS})`, duration, cfg.unbounded ? 'Vide : sans limite, jusqu’à l’ordre « arrêter ».' : 'L’équipement s’arrête seul à la fin, même si la liaison tombe.') : null,
    clip ? field(h, 'Message préenregistré (identifiant)', clip) : null,
    field(h, needsReason(a, action) ? 'Raison (obligatoire)' : 'Raison (facultative)', reason),
    password ? field(h, 'Votre mot de passe (redemandé pour cette commande)', password) : null,
    h('label', { class: 'check' }, sure, sureText),
    error,
    h('div', { class: 'actions dialog-actions' }, h('button', { class: 'btn', type: 'button', text: 'Annuler', onclick: () => openPanel(ctx) }), submit),
  );
  dialogs().open(`${label} : ${a.name}`, form);
}

/** Etat en direct de la commande envoyee (mis a jour par le temps reel), avec l'arret anticipe si elle est en cours. */
function showStatus(a, cmdId, ctx) {
  const box = h('div', { class: 'cmd-status', 'aria-live': 'polite' });
  const render = () => {
    if (!box.isConnected) return void watchers.delete(render);
    const c = live.get(cmdId);
    if (!c) return;
    const running = (c.state === 'sent' || c.state === 'acked') && a.safeAction && c.action !== a.safeAction && !c.cancelledAt && (c.durationS === null || (c.offDueAt && !c.offCmdId));
    box.replaceChildren(...nodes(
      unconfirmedWarning(c),
      h('p', {}, h('span', { class: `tag ${STATE_TAG[c.state] ?? ''}`, text: stateText(c) })),
      h('p', { class: 'muted', text: `Commande ${cmdId.slice(0, 8)} — ${ACTION_LABEL[c.action] ?? c.action}${c.durationS ? ` ${c.durationS} s` : ''} — demandée à ${time(c.requestedAt)}` }),
      c.offDueAt && !c.offCmdId ? h('p', { class: 'hint', text: `Retour automatique à « ${ACTION_LABEL[a.safeAction] ?? a.safeAction} » prévu à ${time(c.offDueAt)}.` }) : null,
      h(
        'div',
        { class: 'actions dialog-actions' },
        h('button', { class: 'btn', type: 'button', text: 'Retour aux commandes', onclick: () => openPanel(ctx) }),
        running
          ? h('button', {
              class: 'btn btn-danger',
              type: 'button',
              text: 'Arrêter maintenant',
              onclick: async (e) => {
                setBusy(e.currentTarget, true);
                try {
                  const res = await api(`/api/actuators/commands/${cmdId}/cancel`, { method: 'POST' });
                  remember(res.command);
                  if (res.stop) remember(res.stop);
                  notify();
                } catch (err) {
                  toast(err.message);
                }
              },
            })
          : null,
      ),
    ));
  };
  watchers.add(render);
  dialogs().open('Commande envoyée', box, { onClose: () => watchers.delete(render) });
  render();
}

/** Panneau des commandes : actionneurs (ceux de la zone de l'incident d'abord), actions permises, dernieres commandes. */
async function openPanel(ctx = {}) {
  const content = h('div', { class: 'cmd-panel' }, h('p', { class: 'muted', text: 'Chargement…' }));
  dialogs().open('Commandes des équipements', content);
  try {
    await loadList();
  } catch (err) {
    content.replaceChildren(h('p', { class: 'form-error', text: err.message }));
    return;
  }
  const mine = actuators.filter((a) => a.allowed.length > 0).sort((x, y) => (y.zone === ctx.zone) - (x.zone === ctx.zone) || x.name.localeCompare(y.name, 'fr'));
  const history = h('ul', { class: 'cmd-history' });
  const rows = mine.map((a) =>
    h(
      'li',
      { class: 'cmd-actuator' },
      h('p', {}, h('strong', { text: a.name }), h('span', { class: 'muted', text: ` — ${TYPE_LABEL[a.type] ?? a.type}${a.zone ? `, zone ${a.zone}` : ''}` })),
      !a.active ? h('p', { class: 'tag is-dashed', text: 'Désactivé' }) : a.linkUp === false ? h('p', { class: 'tag is-alarm', text: 'Liaison coupée : commande impossible' }) : null,
      h(
        'div',
        { class: 'actions' },
        a.allowed.map((action) =>
          h('button', { class: `btn btn-sm${action === a.safeAction ? '' : ' btn-primary'}`, type: 'button', disabled: lock.locked || !a.active || a.linkUp === false, onclick: () => askCommand(a, action, ctx) }, ACTION_LABEL[action] ?? action),
        ),
      ),
    ),
  );
  content.replaceChildren(...nodes(
    lock.locked ? h('p', { class: 'notice is-warning', text: `Commandes verrouillées (maintenance) par ${lock.by ?? '?'}${lock.reason ? ` : ${lock.reason}` : ''}.` }) : null,
    mine.length ? h('ul', { class: 'cmd-actuators' }, rows) : h('p', { class: 'empty', text: 'Aucun équipement commandable pour votre compte.' }),
    h('h3', { text: 'Dernières commandes' }),
    history,
  ));
  const recent = [];
  for (const a of mine.slice(0, 10)) {
    try {
      recent.push(...(await api(`/api/actuators/${encodeURIComponent(a.id)}/commands?limit=5`)));
    } catch {
      // un historique illisible n'empeche pas de commander
    }
  }
  for (const c of recent) if (!live.has(c.cmdId)) live.set(c.cmdId, c);
  const renderHistory = () => {
    if (!history.isConnected) return void watchers.delete(renderHistory);
    const ids = new Set(mine.map((a) => a.id));
    const list = [...live.values()].filter((c) => ids.has(c.actuatorId)).sort((x, y) => y.requestedAt - x.requestedAt).slice(0, 15);
    history.replaceChildren(...(list.length ? list.map(commandLine) : [h('li', { class: 'muted', text: 'Aucune commande récente.' })]));
  };
  watchers.add(renderHistory);
  renderHistory();
}

/** Bouton « Commandes » de la fiche d'un incident : visible seulement si ce compte peut commander quelque chose. */
export function commandsButton(getIncident) {
  const button = h('button', { class: 'btn btn-sm inc-commands', type: 'button', hidden: true, onclick: () => openPanel({ zone: getIncident().zone, incidentId: getIncident().id }) }, icon('bolt'), h('span', { text: 'Commandes' }));
  watchers.add(() => {
    button.hidden = !(actuators ?? []).some((a) => a.allowed.length > 0) || getIncident().status === 'closed';
  });
  if (actuators === null && S.me) loadList().catch(() => {});
  else notify();
  return button;
}

// ---------------------------------------------------------------- configuration (administrateur)

function showKeyOnce(id, key) {
  dialogs().open('Clé de signature de l’actionneur', [
    h('p', { class: 'dialog-lead', text: `Clé de « ${id} » : elle n’est affichée qu’une fois. Copiez-la dans la configuration de la passerelle (pilote) qui commande cet équipement.` }),
    h('p', { class: 'adm-mono', text: key }),
    copyButton(h, { label: 'Copier la clé', text: () => key }),
    h('div', { class: 'actions dialog-actions' }, h('button', { class: 'btn btn-primary', type: 'button', text: 'C’est noté', onclick: () => dialogs().close() })),
  ]);
}

function jsonField(value) {
  return h('textarea', { rows: '5', spellcheck: 'false', class: 'adm-mono' }, value ? JSON.stringify(value, null, 2) : '');
}

function parseJson(text, label) {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} : JSON invalide`);
  }
}

/** Formulaire de creation / modification. Les regles (plafonds, issue de secours, SSRF) sont verifiees par le serveur. */
function editActuator(existing) {
  const id = h('input', { type: 'text', maxlength: '32', value: existing?.id ?? '', disabled: Boolean(existing), spellcheck: 'false', 'data-autofocus': true });
  const name = h('input', { type: 'text', maxlength: '80', value: existing?.name ?? '' });
  const type = h('select', { disabled: Boolean(existing) }, Object.entries(TYPE_LABEL).map(([v, l]) => h('option', { value: v, selected: existing?.type === v }, l)));
  const zone = h('input', { type: 'text', maxlength: '60', value: existing?.zone ?? '' });
  const transport = h('select', {}, h('option', { value: 'mqtt', selected: existing?.transport !== 'http' }, 'MQTT (passerelle, ordres signés)'), h('option', { value: 'http', selected: existing?.transport === 'http' }, 'HTTP (relais IP)'));
  const actions = jsonField(existing?.actions);
  const http = jsonField(existing?.http ? { requests: existing.http.requests, contentType: existing.http.contentType, secretHeader: existing.http.secretHeader } : null);
  const secret = h('input', { type: 'password', autocomplete: 'off', placeholder: existing?.http?.hasSecret ? 'inchangé' : '' });
  const ack = h('input', { type: 'number', min: '1', max: '30', value: String(existing?.ackTimeoutS ?? 5) });
  const emergency = h('input', { type: 'checkbox', checked: existing?.emergencyExit ?? false });
  const active = h('input', { type: 'checkbox', checked: existing?.active ?? true });
  // La boite de dialogue est unique : le mot de passe est demandé dans le formulaire pour ne pas perdre la saisie.
  const reauth = reauthField(existing ? `modifier l’actionneur « ${existing.name} »` : 'créer un actionneur');
  const error = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit', text: existing ? 'Enregistrer' : 'Créer l’actionneur' });
  const form = h(
    'form',
    {
      class: 'dialog-form',
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        if (!reauth.input.value) {
          error.textContent = 'Saisissez le mot de passe de votre compte pour valider.';
          reauth.input.focus();
          return;
        }
        setBusy(submit, true);
        try {
          const body = { reauth: reauth.input.value, name: name.value.trim(), zone: zone.value.trim(), transport: transport.value, ackTimeoutS: Number(ack.value), emergencyExit: emergency.checked, active: active.checked };
          const a = parseJson(actions.value, 'Actions');
          if (a !== undefined) body.actions = a;
          if (transport.value === 'http') {
            body.http = parseJson(http.value, 'HTTP') ?? {};
            if (secret.value) body.http.secretValue = secret.value;
          }
          if (existing) {
            await api(`/api/actuators/${encodeURIComponent(existing.id)}`, { method: 'PATCH', body });
            dialogs().close();
          } else {
            const res = await api('/api/actuators', { method: 'POST', body: { ...body, id: id.value.trim(), type: type.value } });
            showKeyOnce(res.actuator.id, res.key);
          }
          await loadActuatorsAdmin();
        } catch (err) {
          // 403 (mot de passe incorrect), 429 (trop d'essais) : le formulaire et sa saisie restent en place.
          error.textContent = err.message;
          reauth.input.value = '';
          setBusy(submit, false);
          if (/mot de passe|essais/i.test(err.message)) reauth.input.focus();
        }
      },
    },
    h('div', { class: 'form-grid adm-grid' }, field(h, 'Identifiant', id, 'Lettres, chiffres, - et _ (32 au plus). Ne change plus.'), field(h, 'Nom', name), field(h, 'Type', type), field(h, 'Zone', zone), field(h, 'Transport', transport), field(h, 'Délai d’accusé (s)', ack)),
    field(h, 'Actions (JSON, facultatif)', actions, 'Ex. {"on":{"maxS":60,"roles":["operator","admin"]}} — vide : actions du type avec leurs durées par défaut. « unbounded » : sans limite (administrateur, journalisé).'),
    field(h, 'Requêtes HTTP (JSON, transport HTTP)', http, 'Ex. {"requests":{"on":{"method":"GET","url":"http://192.168.1.50/relay/0?turn=on&timer={durationS}"},"off":{...}},"secretHeader":"Authorization"}'),
    field(h, 'Valeur de l’en-tête secret (HTTP)', secret, 'Chiffrée, jamais réaffichée.'),
    h('label', { class: 'check' }, emergency, h('span', { text: 'Issue de secours (serrure) : jamais verrouillée par le PSIM' })),
    h('label', { class: 'check' }, active, h('span', { text: 'Actif' })),
    reauth.el,
    error,
    h('div', { class: 'actions dialog-actions' }, h('button', { class: 'btn', type: 'button', text: 'Annuler', onclick: () => dialogs().close() }), submit),
  );
  dialogs().open(existing ? `Modifier « ${existing.name} »` : 'Nouvel actionneur', form);
}

/** Ecran Equipements et plan : liste des actionneurs, verrou global, creation, cle, suppression (administrateur). */
export async function loadActuatorsAdmin() {
  const box = $('actuators-admin');
  if (!box || S.me?.role !== 'admin') return;
  try {
    await loadList();
  } catch (err) {
    box.replaceChildren(h('p', { class: 'form-error', text: err.message }));
    return;
  }
  const toggleLock = async () => {
    if (lock.locked) {
      await withReauth('rétablir les commandes (fin du mode maintenance)', (reauth) => api('/api/actuator-lock', { method: 'PUT', body: { locked: false, reauth } })).catch((e) => toast(e.message));
      return loadActuatorsAdmin();
    }
    const reason = h('input', { type: 'text', maxlength: '200', 'data-autofocus': true });
    const reauth = reauthField('verrouiller les commandes');
    const ok = await dialogs().confirm({
      heading: 'Verrouiller toutes les commandes',
      message: 'Plus aucune commande ne partira (mode maintenance), retours automatiques compris : les équipements s’arrêtent seuls à la fin de leur durée.',
      details: [field(h, 'Raison (obligatoire)', reason), reauth.el],
      confirmLabel: 'Verrouiller',
      onConfirm: () => api('/api/actuator-lock', { method: 'PUT', body: { locked: true, reason: reason.value.trim(), reauth: reauth.input.value } }),
    });
    if (ok) loadActuatorsAdmin();
  };
  const rows = actuators.map((a) =>
    h(
      'tr',
      {},
      h('td', { class: 'adm-mono', text: a.id }),
      h('td', {}, h('strong', { text: a.name }), a.emergencyExit ? h('span', { class: 'tag is-warning', text: ' Issue de secours' }) : null),
      h('td', { text: TYPE_LABEL[a.type] ?? a.type }),
      h('td', { text: a.zone || '—' }),
      h('td', { text: `${a.transport.toUpperCase()}${a.linkUp === false ? ' — liaison coupée' : a.linkUp ? ' — à l’écoute' : ''}` }),
      h('td', { text: Object.entries(a.actions).map(([k, c]) => `${ACTION_LABEL[k] ?? k}${c.maxS ? ` ≤ ${c.maxS} s` : ''}${c.unbounded ? ' (sans limite permis)' : ''}`).join(', ') }),
      h('td', { text: a.active ? 'Actif' : 'Désactivé' }),
      h(
        'td',
        { class: 'actions' },
        h('button', { class: 'btn btn-sm', type: 'button', text: 'Modifier', onclick: () => editActuator(a) }),
        h('button', {
          class: 'btn btn-sm',
          type: 'button',
          text: 'Nouvelle clé',
          onclick: async () => {
            const ok = await dialogs().confirm({ heading: 'Nouvelle clé de signature', message: `L’ancienne clé de « ${a.name} » cesse immédiatement : la passerelle devra recevoir la nouvelle.`, confirmLabel: 'Renouveler' });
            if (!ok) return;
            try {
              const done = await withReauth(`renouveler la clé de « ${a.name} »`, (reauth) => api(`/api/actuators/${encodeURIComponent(a.id)}/key`, { method: 'POST', body: { reauth } }));
              if (done) showKeyOnce(a.id, done.value.key);
            } catch (err) {
              toast(err.message);
            }
          },
        }),
        h('button', {
          class: 'btn btn-sm btn-danger',
          type: 'button',
          text: 'Supprimer',
          onclick: async () => {
            const ok = await dialogs().confirm({ heading: 'Supprimer l’actionneur', message: `« ${a.name} » ne pourra plus être commandé. Son historique de commandes est conservé.`, confirmLabel: 'Supprimer' });
            if (!ok) return;
            const done = await withReauth(`supprimer l’actionneur « ${a.name} »`, (reauth) => api(`/api/actuators/${encodeURIComponent(a.id)}`, { method: 'DELETE', body: { reauth } })).catch((e) => void toast(e.message));
            if (done) loadActuatorsAdmin();
          },
        }),
      ),
    ),
  );
  box.replaceChildren(...nodes(
    lock.locked
      ? h('p', { class: 'notice is-warning', text: `Commandes verrouillées (maintenance) par ${lock.by ?? '?'}${lock.reason ? ` : ${lock.reason}` : ''}.` })
      : h('p', { class: 'hint', text: 'Sirènes, projecteurs, relais, gâches, portails et haut-parleurs commandés par le PSIM. Chaque commande est confirmée, bornée dans le temps et journalisée.' }),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => editActuator(null) }, icon('plus'), h('span', { text: 'Nouvel actionneur' })),
      h('button', { class: `btn${lock.locked ? '' : ' btn-danger'}`, type: 'button', onclick: toggleLock }, icon(lock.locked ? 'unlock' : 'lock'), h('span', { text: lock.locked ? 'Rétablir les commandes' : 'Verrouiller toutes les commandes' })),
      h('button', { class: 'btn', type: 'button', onclick: () => openPanel({}) }, icon('bolt'), h('span', { text: 'Commander…' })),
    ),
    actuators.length
      ? h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            { class: 'data adm-stack' },
            h('thead', {}, h('tr', {}, ['Identifiant', 'Nom', 'Type', 'Zone', 'Transport', 'Actions permises', 'État', ''].map((t) => h('th', { scope: 'col', text: t })))),
            h('tbody', {}, rows),
          ),
        )
      : h('p', { class: 'empty', text: 'Aucun actionneur déclaré.' }),
  ));
}
