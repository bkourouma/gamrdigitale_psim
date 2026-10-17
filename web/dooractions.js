/**
 * Ouverture a distance d'une porte (F17), mode de porte (F19) et « Tout ouvrir » (F20) : composant reutilisable insere
 * dans la fiche d'une porte et dans la fiche d'un incident d'acces. Conception : docs/PRD-CONTROLE-ACCES.md (F17-F20, P2).
 *
 * Securite : le serveur decide de tout (droits, raison, mot de passe, bornes de duree, issue de secours, liaison). Ici
 * on rend ces regles lisibles AVANT l'envoi et on n'affiche jamais « ouverte » sans accuse de l'equipement.
 * Tout ordre passe par POST /api/actuators/:id/commands (mecanique de commands.js : boite de confirmation, raison, mot de
 * passe, accuse en direct), sauf « Tout ouvrir » qui passe par POST /api/access/evacuation (le serveur traite alors
 * chaque porte par le meme service des commandes).
 *
 * Le module ne touche pas au DOM a l'import et n'importe rien en statique : les fonctions PURES (plan des boutons,
 * durees, libelles, bilan d'evacuation) s'executent telles quelles dans les essais ; core.js, commands.js et account.js
 * sont charges a la demande par le composant.
 */

// ---------------------------------------------------------------- fonctions pures

export const EVACUATION_PHRASE = 'TOUT OUVRIR';
export const EVACUATION_WARNING = 'Cela ne remplace jamais le déverrouillage matériel par la centrale incendie. Les issues de secours doivent s’ouvrir par ce dispositif matériel.';
export const EMERGENCY_NOTE = 'Issue de secours : le PSIM ne la verrouille jamais.';

const MODE_LABEL = {
  normal: 'Mode normal : les badges fonctionnent',
  always_open: 'Ouverte en permanence (réglée dans le contrôleur)',
  always_closed: 'Verrouillée en permanence (réglée dans le contrôleur)',
};

/** Mode de porte (F19) : texte a afficher et date du message, ou « non communique » tant que rien n'est arrive. */
export function doorModeText(door) {
  const label = door?.doorModeLabel ?? MODE_LABEL[door?.doorMode] ?? null;
  if (!label) return { known: false, text: 'Mode de la porte : non communiqué par le contrôleur', at: null };
  return { known: true, text: label, at: typeof door.doorModeAt === 'number' ? door.doorModeAt : null };
}

/** Duree de l'impulsion : 5 s au plus, jamais plus que le maximum de l'action ni moins que son minimum. Null si non bornee. */
export function pulseDurationS(cfg) {
  if (!cfg || typeof cfg.maxS !== 'number') return null;
  return Math.max(cfg.minS ?? 1, Math.min(5, cfg.maxS));
}

/** « Ouvrir N minutes » : possible seulement si l'action admet au moins une minute (maxS est en secondes). */
export function minutesLimit(cfg, role = 'operator') {
  if (!cfg || typeof cfg.maxS !== 'number') return { ok: false, maxMinutes: 0, reason: 'Cet équipement ne permet pas d’ouverture temporisée.' };
  const maxMinutes = Math.floor(cfg.maxS / 60);
  if (maxMinutes < 1) return { ok: false, maxMinutes: 0, reason: `Durée maximale de cet équipement : ${cfg.maxS} s, soit moins d’une minute : « Ouvrir N minutes » est indisponible. ${role === 'admin' ? 'Pour l’activer : relever maxS de l’action unlock dans le PSIM (Équipements, Actionneurs, Actions) ET dans la section actuators de la passerelle.' : 'Demandez à un administrateur.'} En attendant, utilisez l’ouverture par impulsion.` };
  return { ok: true, maxMinutes, reason: null };
}

/** Minutes saisies -> secondes pour l'API, bornees par maxS ; null si la saisie n'est pas un entier valide. */
export function minutesToSeconds(minutes, cfg) {
  const limit = minutesLimit(cfg);
  const n = typeof minutes === 'string' ? (minutes.trim() === '' ? NaN : Number(minutes)) : minutes;
  if (!limit.ok || !Number.isInteger(n) || n < 1 || n > limit.maxMinutes) return null;
  return n * 60;
}

export const minutesLabel = (n) => `Ouvrir ${n} minute${n > 1 ? 's' : ''}`;

/**
 * Ce que la fiche propose, selon la porte, son lien, l'actionneur tel que ce compte le voit (GET /api/actuators) et le
 * mode maintenance. Renvoie { state: 'unavailable' | 'not_allowed' | 'ready', message, blocked, notes, buttons, minutes }.
 * `blocked` (texte) desactive tous les boutons : maintenance, actionneur inactif, liaison coupee.
 */
export function doorActionPlan({ door, remote, actuator, maintenance = false, role = 'operator' }) {
  const plan = { state: 'ready', message: null, blocked: null, notes: [], buttons: [], minutes: null };
  if (!remote || remote.available !== true) {
    plan.state = 'unavailable';
    plan.message = remote?.reason ?? 'L’ouverture à distance n’est pas disponible pour cette porte.';
    return plan;
  }
  const allowed = actuator?.allowed ?? [];
  if (!actuator || allowed.length === 0) {
    plan.state = 'not_allowed';
    plan.message = 'Votre compte n’a pas le droit de commander l’équipement de cette porte. Demandez à un responsable ou à un administrateur.';
    return plan;
  }
  if (maintenance) plan.blocked = 'Les commandes sont verrouillées (mode maintenance) : aucun ordre ne peut partir.';
  else if (actuator.active === false) plan.blocked = 'L’actionneur de cette porte est désactivé : aucun ordre ne peut partir.';
  else if (actuator.linkUp === false) plan.blocked = 'Liaison coupée avec l’équipement de cette porte : aucun ordre ne peut partir. Vérifiez la passerelle.';

  const emergency = Boolean(actuator.emergencyExit || door?.emergencyExit);
  const type = remote.actuatorType ?? actuator.type;
  const can = (a) => allowed.includes(a) && actuator.actions?.[a] !== undefined;
  const add = (key, action, label, extra = {}) => plan.buttons.push({ key, action, label, safe: action === actuator.safeAction, ...extra });

  if (type === 'lock') {
    if (can('unlock')) {
      const cfg = actuator.actions.unlock;
      add('unlock_pulse', 'unlock', 'Ouvrir (impulsion)', { durationS: pulseDurationS(cfg) });
      const limit = minutesLimit(cfg, role);
      plan.minutes = { ...limit, action: 'unlock', cfg, defaultMinutes: limit.ok ? Math.min(5, limit.maxMinutes) : null };
    }
    if (can('lock')) {
      if (emergency) plan.notes.push(EMERGENCY_NOTE);
      else add('lock', 'lock', 'Verrouiller');
    } else if (emergency) plan.notes.push(EMERGENCY_NOTE);
  } else if (type === 'gate') {
    if (can('open')) add('open', 'open', 'Ouvrir');
    if (can('close')) add('close', 'close', 'Fermer');
    if (can('stop')) add('stop', 'stop', 'Arrêter');
  }
  if (plan.buttons.length === 0 && !plan.minutes) {
    plan.state = 'not_allowed';
    plan.message = 'Votre compte ne peut envoyer aucun ordre d’ouverture à cette porte.';
  }
  return plan;
}

/** Type d'actionneur attendu pour une porte selon son genre (meme regle que le serveur : door -> lock, le reste -> gate). */
export const actuatorTypeForKind = (kind) => (kind === 'door' ? 'lock' : kind === 'gate' || kind === 'barrier' || kind === 'turnstile' ? 'gate' : null);

/**
 * Actionneurs proposables a l'administrateur pour lier une porte : type coherent avec le genre, meme issue de secours que la
 * porte, pas deja lies a une AUTRE porte (le serveur reverifie tout et reste juge : 400 / 409 affiches tels quels).
 */
export function compatibleActuators({ door, actuators, doors }) {
  const type = actuatorTypeForKind(door?.kind);
  if (!type) return [];
  const taken = new Set((doors ?? []).filter((d) => d.detectorId !== door.detectorId && d.actuatorId).map((d) => d.actuatorId));
  return (actuators ?? []).filter((a) => a.type === type && Boolean(a.emergencyExit) === Boolean(door.emergencyExit) && !taken.has(a.id));
}

/** Etat d'une commande, tel que le service des commandes le rapporte (jamais « fait » sans accuse). */
export function commandStateText(c) {
  if (!c) return 'Envoyée — accusé attendu';
  let text;
  switch (c.state) {
    case 'pending': text = 'En attente d’envoi'; break;
    case 'sent': text = 'Envoyée — accusé attendu'; break;
    case 'acked': text = c.ackKind === 'http' ? 'Reçue par le relais (HTTP 2xx) : exécution non confirmée' : 'Accusée par l’équipement'; break;
    case 'refused': text = 'Refusée par l’équipement'; break;
    case 'failed': text = c.uncertain ? 'Échec : aucun accusé — l’ordre a pu être exécuté' : c.ack ? `Échec : ${c.ack}` : 'Échec'; break;
    case 'expired': text = 'Expirée (jamais renvoyée)'; break;
    case 'cancelled': text = 'Annulée'; break;
    default: text = String(c.state);
  }
  if (c.lateAck) text += ` · accusé tardif « ${c.lateAck} »`;
  return text;
}

/** Classe de pastille d'une commande (le texte porte toujours le sens, la couleur n'est qu'un renfort). */
export function commandTone(c) {
  switch (c?.state) {
    case 'acked': return 'is-ok';
    case 'refused':
    case 'failed': return 'is-alarm';
    case 'expired':
    case 'cancelled': return 'is-dashed';
    default: return 'is-warning';
  }
}

/** « Tout ouvrir » : la phrase de confirmation doit etre saisie telle quelle (espaces autour ignores). */
export const evacuationPhraseOk = (text) => typeof text === 'string' && text.trim() === EVACUATION_PHRASE;

/** Corps du POST /api/access/evacuation, ou la liste des champs manquants. */
export function evacuationPayload({ reason, phrase, password }) {
  const missing = [];
  if (!String(reason ?? '').trim()) missing.push('la raison');
  if (!evacuationPhraseOk(phrase)) missing.push(`la phrase ${EVACUATION_PHRASE}`);
  if (!password) missing.push('votre mot de passe');
  if (missing.length) return { ok: false, missing };
  return { ok: true, body: { reason: String(reason).trim(), password, confirm: true, confirmPhrase: EVACUATION_PHRASE } };
}

/** Apercu (GET /api/access/evacuation) : combien de portes seraient ouvertes, lesquelles ne sont pas pretes. */
export function evacuationPreview(doors) {
  const list = Array.isArray(doors) ? doors : [];
  const ready = list.filter((d) => d.ready);
  const full = ready.filter((d) => d.action === 'evacuate');
  const brief = ready.filter((d) => d.action !== 'evacuate');
  const timed = full.map((d) => d.maxDurationS).filter((n) => typeof n === 'number');
  return { total: list.length, ready: ready.length, notReady: list.filter((d) => !d.ready), canGo: ready.length > 0, full: full.length, brief: brief.length, evacuationS: timed.length ? Math.max(...timed) : null, warned: list.filter((d) => d.warning).length };
}

const plural = (n, one, many) => (n > 1 ? many : one);
const durationText = (s) => (s % 60 === 0 ? `${s / 60} minute${s / 60 > 1 ? 's' : ''}` : `${s} s`);

/** Resume de l'apercu : combien de portes restent ouvertes toute l'evacuation, combien ne s'ouvrent que brievement. */
export function evacuationSummary(preview) {
  const parts = [];
  if (preview.full > 0) {
    const d = preview.evacuationS ? ` (${durationText(preview.evacuationS)} puis reverrouillage automatique)` : '';
    parts.push(`${preview.full} porte${plural(preview.full, '', 's')} s’ouvri${plural(preview.full, 'ra', 'ront')} pour toute la durée d’évacuation${d}`);
  }
  if (preview.brief > 0) parts.push(`${preview.brief} ne s’ouvri${plural(preview.brief, 'ra', 'ront')} que brièvement`);
  return parts.length ? `${parts.join(', ')}.` : 'Aucune porte ne recevra d’ordre.';
}

/** Phrase de la premiere confirmation : la duree reelle, pas une valeur supposee. */
export function evacuationDurationText(preview) {
  const lock = preview.evacuationS ? `les serrures restent ouvertes ${durationText(preview.evacuationS)} puis se reverrouillent seules` : 'la durée est fixée par chaque équipement';
  return `Ce geste ouvre toutes les portes prêtes de la liste : ${lock} ; les portails et barrières restent ouverts jusqu’à leur fermeture sur place. Il est journalisé à votre nom.`;
}

/**
 * Etat d'une porte apres l'envoi : `result` = ligne du POST, `cmd` = derniere version temps reel de sa commande.
 * `open` n'est vrai que pour un accuse (jamais pour « envoye »).
 */
export function evacuationRowState(result, cmd) {
  const state = rowState(result, cmd);
  const warning = result?.warning ? String(result.warning) : null;
  return { ...state, warning };
}

function rowState(result, cmd) {
  const err = result?.error ? String(result.error) : '';
  switch (result?.status) {
    case 'no_gateway': return { key: 'no_gateway', label: 'Sans passerelle', detail: err || 'Aucune passerelle n’écoute : rien n’a été envoyé. Ouvrir sur place.', open: false, final: true, tone: 'is-alarm' };
    case 'refused': return { key: 'refused', label: 'Refusé', detail: err || 'Refusé par le service des commandes.', open: false, final: true, tone: 'is-alarm' };
    case 'error': return { key: 'error', label: 'Erreur', detail: err || 'Erreur imprévue : rien ne prouve que la porte est ouverte.', open: false, final: true, tone: 'is-alarm' };
    case 'sent': break;
    default: return { key: 'unknown', label: 'Inconnu', detail: 'État inconnu : vérifier sur place.', open: false, final: false, tone: 'is-warning' };
  }
  if (!cmd) return { key: 'sent', label: 'Envoyé', detail: 'Envoyée — accusé attendu', open: false, final: false, tone: 'is-warning' };
  switch (cmd.state) {
    case 'acked': return { key: 'acked', label: 'Accusé', detail: commandStateText(cmd), open: true, final: true, tone: 'is-ok' };
    case 'failed': return { key: 'failed', label: 'Échec', detail: commandStateText(cmd), open: false, final: true, tone: 'is-alarm' };
    case 'refused': return { key: 'refused', label: 'Refusé', detail: commandStateText(cmd), open: false, final: true, tone: 'is-alarm' };
    case 'expired':
    case 'cancelled': return { key: 'expired', label: cmd.state === 'expired' ? 'Expiré' : 'Annulé', detail: commandStateText(cmd), open: false, final: true, tone: 'is-dashed' };
    default: return { key: 'sent', label: 'Envoyé', detail: commandStateText(cmd), open: false, final: false, tone: 'is-warning' };
  }
}

/** Bilan « N portes sur M ouvertes » : seules les portes accusees comptent. */
export function evacuationBilan(states) {
  const total = states.length;
  const opened = states.filter((s) => s.open).length;
  const pending = states.filter((s) => !s.final).length;
  const text = `${opened} porte${opened > 1 ? 's' : ''} sur ${total} ouverte${opened > 1 ? 's' : ''}`;
  return { opened, total, pending, text, complete: pending === 0, allOpen: total > 0 && opened === total };
}

// ---------------------------------------------------------------- chargement a la demande

let depsPromise = null;
/** core.js, commands.js, account.js : charges au premier usage (ils touchent au DOM des leur import). */
function deps() {
  depsPromise ??= Promise.all([import('./core.js'), import('./commands.js'), import('./account.js')]).then(([core, cmds, account]) => ({ core, cmds, account }));
  return depsPromise;
}

const EMPTY = Object.freeze([]);

// ---------------------------------------------------------------- composant : fiche de porte

/** Affiche la camera dans le mur video (sans reimplementer le flux : wall.js et live.js s'en chargent). */
async function showCamera(cameraId) {
  const { core } = await deps();
  const { S, render, go } = core;
  S.manualCams = [...S.manualCams.filter((c) => c !== cameraId), cameraId].slice(-4);
  if (S.view !== 'surveillance' && S.view !== 'cameras') go('cameras');
  render.plan?.();
  const wall = await import('./wall.js');
  wall.renderWall();
  document.querySelector('#wall')?.scrollIntoView?.({ block: 'nearest' });
}

/**
 * Bloc « Ouverture a distance » d'une porte.
 * door : DoorView ; detail : reponse de GET /api/access/doors/:id ({ remote, cameras, lastPassages }) ;
 * opts : { incidentId?, zone?, onChange?(commande) }. Renvoie un element a inserer ; son contenu se complete ensuite.
 */
export function doorActions(door, detail, opts = {}) {
  const root = document.createElement('section');
  root.className = 'dooract';
  root.setAttribute('aria-label', `Ouverture à distance : ${door?.name ?? 'porte'}`);
  deps()
    .then((d) => build(root, door, detail ?? {}, opts, d))
    .catch((err) => {
      const p = document.createElement('p');
      p.className = 'notice is-alarm';
      p.setAttribute('role', 'alert');
      p.textContent = `Ouverture à distance indisponible : ${err.message}`;
      root.replaceChildren(p);
    });
  return root;
}

// ---------------------------------------------------------------- branchement dans la fiche de porte de l'ecran Acces

/**
 * Contrat avec web/access.js : apres chaque rendu de la fiche de porte, l'ecran emet `psim:door-card` avec { slot, door } ;
 * `slot` est l'emplacement `data-slot="remote-open"`, `door` le DoorView. Ce module y pose le composant ci-dessus (boutons selon
 * l'actionneur lie et les droits, mode de porte), sans que access.js l'importe.
 */
export async function fillDoorCard(slot, door) {
  if (!slot || !door?.detectorId) return;
  const token = `${door.detectorId}:${Date.now()}`;
  slot.dataset.dooractToken = token;
  try {
    const { core } = await deps();
    const detail = await core.api(`/api/access/doors/${encodeURIComponent(door.detectorId)}`);
    // La fiche a ete re-rendue ou a change de porte pendant la lecture : cette reponse est perimee.
    if (!slot.isConnected || slot.dataset.dooractToken !== token) return;
    slot.replaceChildren(doorActions(detail.door ?? door, detail, {}));
  } catch {
    // Echec de lecture : le texte de l'ecran Acces reste en place, la fiche n'est jamais bloquee.
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('psim:door-card', (e) => {
    const d = e.detail ?? {};
    void fillDoorCard(d.slot, d.door);
  });
}

async function build(root, door, detail, opts, { core, cmds }) {
  const { h, icon, time } = core;
  const remote = detail.remote ?? null;
  const cameras = Array.isArray(detail.cameras) ? detail.cameras : EMPTY;

  root.dooractUnwatch?.(); // reconstruction (liaison changee) : l'ancien abonnement s'arrete
  const isAdmin = core.S.me?.role === 'admin';
  let actuator = null;
  let maintenance = false;
  let list = null;
  if (remote?.available || isAdmin) {
    try {
      const res = await cmds.listActuators();
      list = res.actuators;
      actuator = remote?.available ? res.actuators.find((a) => a.id === remote.actuatorId) ?? null : null;
      maintenance = res.lock.locked;
    } catch (err) {
      root.replaceChildren(h('p', { class: 'notice is-alarm', role: 'alert', text: `Impossible de lire les droits sur l’équipement : ${err.message}` }));
      return;
    }
  }
  const plan = doorActionPlan({ door, remote, actuator, maintenance, role: core.S.me?.role });
  const mode = doorModeText(door);

  // ---- etat de la porte, mode, actionneur
  const head = h(
    'div',
    { class: 'dooract-facts' },
    h('p', { class: 'dooract-state' }, h('span', { class: 'tag', text: door.stateLabel ?? 'État inconnu' }), door.stateHint ? h('span', { class: 'hint', text: ` ${door.stateHint}` }) : null),
    h('p', { class: `dooract-mode${mode.known ? '' : ' is-unknown'}` }, h('strong', { text: mode.text }), mode.at ? h('span', { class: 'hint', text: ` — message de ${time(mode.at)}` }) : null),
    remote?.actuatorName ? h('p', { class: 'hint', text: `Actionneur lié : ${remote.actuatorName}${remote.actuatorType === 'gate' ? ' (portail / barrière)' : remote.actuatorType === 'lock' ? ' (serrure / gâche)' : ''}` }) : null,
  );

  // ---- cameras
  const camBox = cameras.length
    ? h(
        'div',
        { class: 'dooract-cams' },
        h('p', { class: 'hint', text: 'Regardez avant d’ouvrir :' }),
        h('div', { class: 'actions' }, cameras.map((c) => h('button', { class: 'btn', type: 'button', onclick: () => void showCamera(c.id).catch(() => {}) }, icon('camera'), h('span', { text: `Voir la caméra : ${c.name}${c.status && c.status !== 'normal' ? ` (${c.status})` : ''}` })))),
      )
    : null;

  // ---- etat des commandes envoyees depuis ce bloc
  const sent = [];
  const status = h('div', { class: 'dooract-status', 'aria-live': 'polite' });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const renderStatus = () => {
    if (!root.isConnected) return;
    status.replaceChildren(
      ...sent.slice(0, 3).flatMap((entry) => {
        const c = cmds.liveCommand(entry.cmdId) ?? entry.command;
        return [
          c.returnUnconfirmed === true ? h('p', { class: 'notice is-alarm', role: 'alert', text: 'Retour à l’état sûr NON CONFIRMÉ : vérifier l’équipement sur place' }) : null,
          h('p', { class: 'dooract-cmd' }, h('span', { class: `tag ${commandTone(c)}`, text: commandStateText(c) }), h('span', { class: 'hint', text: ` ${cmds.actionLabel(entry.action)}${c.durationS ? ` ${c.durationS} s` : ''} — demandée à ${time(c.requestedAt ?? entry.at)}` })),
        ];
      }),
    );
  };
  let unwatch = null;
  root.dooractUnwatch = () => unwatch?.();
  const onSent = (command) => {
    if (!sent.some((s) => s.cmdId === command.cmdId)) sent.unshift({ cmdId: command.cmdId, action: command.action, command, at: Date.now() });
    renderStatus();
    opts.onChange?.(command);
  };
  const ctx = { incidentId: opts.incidentId, zone: opts.zone, onSent };
  const run = async (action, extra = {}) => {
    error.textContent = '';
    try {
      await cmds.commandAction(remote.actuatorId, action, { ...ctx, ...extra });
    } catch (err) {
      error.textContent = err.message;
    }
  };

  // ---- boutons
  const controls = h('div', { class: 'dooract-controls' });
  const whyId = `dooract-why-${door.detectorId ?? Math.random().toString(36).slice(2, 8)}`;
  if (plan.state !== 'ready') {
    controls.append(h('p', { class: `notice${plan.state === 'unavailable' ? '' : ' is-warning'}`, text: plan.message }));
  } else {
    const off = plan.blocked !== null;
    if (off) controls.append(h('p', { class: 'notice is-warning', id: whyId, text: plan.blocked }));
    const buttons = plan.buttons.map((b) =>
      h('button', { class: `btn${b.safe ? '' : ' btn-primary'}`, type: 'button', disabled: off, 'aria-describedby': off ? whyId : false, onclick: () => void run(b.action, b.durationS ? { durationS: b.durationS } : {}) }, icon(b.action === 'lock' || b.action === 'close' ? 'lock' : 'unlock'), h('span', { text: b.label })),
    );
    controls.append(h('div', { class: 'actions' }, buttons));
    if (plan.minutes) {
      if (!plan.minutes.ok) {
        controls.append(h('p', { class: 'hint', text: plan.minutes.reason }));
      } else {
        const input = h('input', { type: 'number', min: '1', max: String(plan.minutes.maxMinutes), step: '1', value: String(plan.minutes.defaultMinutes), inputmode: 'numeric', 'aria-label': `Durée d’ouverture en minutes (1 à ${plan.minutes.maxMinutes})`, disabled: off });
        const label = h('span', { text: minutesLabel(plan.minutes.defaultMinutes) });
        const go = h('button', {
          class: 'btn btn-primary',
          type: 'button',
          disabled: off,
          onclick: () => {
            const seconds = minutesToSeconds(input.value, plan.minutes.cfg);
            if (seconds === null) return void (error.textContent = `Saisissez un nombre entier de minutes, de 1 à ${plan.minutes.maxMinutes}.`);
            void run('unlock', { durationS: seconds });
          },
        }, icon('unlock'), label);
        input.addEventListener('input', () => {
          const n = Number(input.value);
          label.textContent = Number.isInteger(n) && n >= 1 ? minutesLabel(n) : 'Ouvrir N minutes';
        });
        controls.append(h('div', { class: 'dooract-minutes' }, h('label', { class: 'field' }, h('span', { text: `Durée (minutes, 1 à ${plan.minutes.maxMinutes})` }), input), go));
      }
    }
    for (const note of plan.notes) controls.append(h('p', { class: 'notice is-warning', text: note }));
    controls.append(h('p', { class: 'hint', text: 'Une raison et votre mot de passe sont demandés pour ouvrir. « Envoyée » ne veut pas dire « ouverte » : attendez l’accusé de l’équipement.' }));
  }

  // ---- liaison porte <-> actionneur (administrateur seulement ; la route PUT ne demande pas de mot de passe)
  let linkBox = null;
  if (isAdmin) {
    const linkError = h('p', { class: 'form-error', role: 'alert' });
    const doors = await core.api('/api/access/doors').catch(() => null);
    const options = doors ? compatibleActuators({ door, actuators: list, doors }) : [];
    const select = h('select', { id: `dooract-link-${door.detectorId}` }, h('option', { value: '' }, '— choisir un actionneur —'), options.map((a) => h('option', { value: a.id, selected: a.id === remote?.actuatorId }, a.name)));
    const save = async (button, actuatorId) => {
      linkError.textContent = '';
      button.disabled = true;
      try {
        await core.api(`/api/access/doors/${encodeURIComponent(door.detectorId)}`, { method: 'PUT', body: { actuatorId } });
        const fresh = await core.api(`/api/access/doors/${encodeURIComponent(door.detectorId)}`);
        opts.onLinkChange?.(fresh);
        await build(root, fresh.door ?? door, fresh, opts, { core, cmds });
      } catch (err) {
        linkError.textContent = err.message;
        button.disabled = false;
      }
    };
    const link = h('button', { class: 'btn', type: 'button', disabled: !doors || options.length === 0, onclick: (e) => (select.value ? void save(e.currentTarget, select.value) : void (linkError.textContent = 'Choisissez d’abord un actionneur dans la liste.')) }, icon('lock'), h('span', { text: 'Lier' }));
    const unlink = remote?.actuatorId || door.actuatorId ? h('button', { class: 'btn', type: 'button', onclick: (e) => void save(e.currentTarget, null) }, h('span', { text: 'Délier' })) : null;
    linkBox = h(
      'div',
      { class: 'dooract-link' },
      h('label', { class: 'field' }, h('span', { text: 'Actionneur lié' }), select),
      h('div', { class: 'actions' }, link, unlink),
      doors && options.length === 0 ? h('p', { class: 'hint', text: `Aucun actionneur compatible n’est libre (il faut un${actuatorTypeForKind(door.kind) === 'gate' ? ' portail / une barrière' : 'e serrure / gâche'}, ${door.emergencyExit ? 'déclaré issue de secours' : 'non déclaré issue de secours'}, et pas déjà lié à une autre porte).` }) : null,
      linkError,
    );
  }

  root.replaceChildren(h('h3', { class: 'dooract-title', text: 'Ouverture à distance' }), head, camBox, controls, error, status, linkBox);
  unwatch = cmds.watchCommands(() => {
    if (!root.isConnected) return void unwatch?.();
    renderStatus();
  });
}

// ---------------------------------------------------------------- « Tout ouvrir » (F20)

/** Bouton de l'administration des actionneurs ; masque tant qu'on ignore que le compte est administrateur. */
export function evacuationButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-danger dooract-evac';
  button.hidden = true;
  button.textContent = 'Tout ouvrir…';
  deps().then((d) => {
    if (d.core.S.me?.role !== 'admin') return;
    button.hidden = false;
    button.replaceChildren(d.core.icon('unlock'), d.core.h('span', { text: 'Tout ouvrir' }));
    button.addEventListener('click', () => void startEvacuation(d));
  }).catch(() => {});
  return button;
}

async function startEvacuation({ core, cmds, account }) {
  const { h, api, icon, time } = core;
  const dialogs = account.createDialogs({ h });
  const close = () => dialogs.close();
  let busy = false;

  // 1. apercu : rien n'est envoye
  dialogs.open('Tout ouvrir : portes concernées', h('p', { class: 'muted', text: 'Chargement…' }));
  let doors;
  try {
    doors = (await api('/api/access/evacuation')).doors;
  } catch (err) {
    dialogs.open('Tout ouvrir', h('div', {}, h('p', { class: 'form-error', role: 'alert', text: err.message }), h('div', { class: 'actions dialog-actions' }, h('button', { class: 'btn', type: 'button', text: 'Fermer', onclick: close }))));
    return;
  }
  showPreview(doors);

  function showPreview(fresh) {
    const p = evacuationPreview(fresh);
    const table = h(
      'div',
      { class: 'table-scroll' },
      h(
        'table',
        { class: 'data dooract-table' },
        h('thead', {}, h('tr', {}, ['Porte', 'Équipement', 'Action', 'État'].map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', {}, fresh.map((d) =>
          h(
            'tr',
            { class: d.ready ? '' : 'is-notready' },
            h('td', {}, h('strong', { text: d.doorName })),
            h('td', { text: d.actuatorName ?? d.actuatorId }),
            h('td', { text: `${cmds.actionLabel(d.action)}${d.maxDurationS ? ` (${d.maxDurationS} s au plus)` : ''}` }, d.warning ? h('p', { class: 'dooract-warn' }, h('span', { class: 'tag is-warning', text: 'Attention' }), h('span', { text: ` ${d.warning}` })) : null),
            h('td', {}, d.ready ? h('span', { class: 'tag is-ok', text: 'Prête' }) : h('span', { class: 'tag is-alarm' }, icon('state-alarm', 'icon-sm'), h('span', { text: `Non prête : ${d.problem ?? 'problème inconnu'}` }))),
          ),
        )),
      ),
    );
    dialogs.open(
      'Tout ouvrir : portes concernées',
      h(
        'div',
        { class: 'dooract-evac-box' },
        p.ready ? h('p', { class: 'notice is-warning', text: evacuationSummary(p) }) : null,
        h('p', { class: 'dialog-lead', text: p.total ? `${p.ready} porte${p.ready > 1 ? 's' : ''} sur ${p.total} ${p.ready > 1 ? 'seraient ouvertes' : 'serait ouverte'}. Rien n’est encore envoyé.` : 'Aucune porte n’est liée à un actionneur : il n’y a rien à ouvrir.' }),
        p.total ? table : null,
        p.notReady.length ? h('p', { class: 'notice is-alarm', role: 'alert', text: `${p.notReady.length} porte${p.notReady.length > 1 ? 's' : ''} ne ${p.notReady.length > 1 ? 'recevront' : 'recevra'} aucun ordre : à ouvrir sur place.` }) : null,
        h('div', { class: 'actions dialog-actions' }, h('button', { class: 'btn', type: 'button', text: 'Annuler', onclick: close }), p.canGo ? h('button', { class: 'btn btn-danger', type: 'button', text: 'Continuer', onclick: () => showFirstConfirm(p) }) : null),
      ),
    );
  }

  // 2. premiere confirmation
  function showFirstConfirm(p) {
    dialogs.open(
      'Tout ouvrir : première confirmation',
      h(
        'div',
        { class: 'dooract-evac-box' },
        h('p', { class: 'notice is-alarm' }, h('strong', { text: EVACUATION_WARNING })),
        h('p', { text: evacuationDurationText(p) }),
        h('div', { class: 'actions dialog-actions' }, h('button', { class: 'btn', type: 'button', text: 'Annuler', onclick: close }), h('button', { class: 'btn btn-danger', type: 'button', text: 'J’ai compris, continuer', onclick: showSecondConfirm })),
      ),
    );
  }

  // 3. seconde confirmation : raison, phrase, mot de passe
  function showSecondConfirm() {
    const reason = h('textarea', { rows: '2', maxlength: '200', required: true, 'data-autofocus': true });
    const phrase = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', required: true, placeholder: EVACUATION_PHRASE });
    const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const error = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { class: 'btn btn-danger', type: 'submit' }, icon('send'), h('span', { text: 'Ouvrir toutes les portes' }));
    const form = h(
      'form',
      {
        class: 'dialog-form',
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          if (busy) return;
          error.textContent = '';
          const payload = evacuationPayload({ reason: reason.value, phrase: phrase.value, password: password.value });
          if (!payload.ok) return void (error.textContent = `Il manque : ${payload.missing.join(', ')}.`);
          busy = true;
          account.setBusy(submit, true);
          submit.disabled = true;
          try {
            const res = await api('/api/access/evacuation', { method: 'POST', body: payload.body });
            busy = false;
            showResults(res);
          } catch (err) {
            busy = false;
            error.textContent = err.message;
            password.value = '';
            account.setBusy(submit, false);
            submit.disabled = false;
          }
        },
      },
      h('p', { class: 'notice is-alarm' }, h('strong', { text: EVACUATION_WARNING })),
      account.field(h, 'Raison (obligatoire)', reason, 'Elle est écrite dans le journal.'),
      account.field(h, `Tapez ${EVACUATION_PHRASE} pour confirmer`, phrase),
      account.field(h, 'Votre mot de passe', password),
      error,
      h('div', { class: 'actions dialog-actions' }, h('button', { class: 'btn', type: 'button', text: 'Annuler', onclick: close }), submit),
    );
    dialogs.open('Tout ouvrir : seconde confirmation', form);
  }

  // 4. resultats porte par porte, mis a jour par les evenements `command`
  function showResults(res) {
    const body = h('tbody');
    const bilan = h('p', { class: 'dooract-bilan', 'aria-live': 'polite' });
    const render = () => {
      if (!body.isConnected) return void unwatch?.();
      const states = res.results.map((r) => evacuationRowState(r, r.cmdId ? cmds.liveCommand(r.cmdId) : null));
      body.replaceChildren(...res.results.map((r, i) => {
        const s = states[i];
        return h(
          'tr',
          {},
          h('td', {}, h('strong', { text: r.doorName ?? r.doorId })),
          h('td', {}, h('span', { class: `tag ${s.tone}`, text: s.label })),
          h('td', {}, h('span', { text: `${s.detail}${r.durationS ? ` (${r.durationS} s demandées)` : ''}` }), s.warning ? h('p', { class: 'dooract-warn' }, h('span', { class: 'tag is-warning', text: 'Attention' }), h('span', { text: ` ${s.warning}` })) : null),
        );
      }));
      const b = evacuationBilan(states);
      bilan.className = `dooract-bilan${b.allOpen ? ' is-ok' : b.complete ? ' is-bad' : ''}`;
      bilan.textContent = `${b.text}${b.pending ? ` — ${b.pending} accusé${b.pending > 1 ? 's' : ''} attendu${b.pending > 1 ? 's' : ''}` : ''}. ${b.allOpen ? '' : 'Les portes non accusées sont à ouvrir ou à vérifier sur place.'}`.trim();
    };
    const unwatch = cmds.watchCommands(render);
    dialogs.open(
      'Tout ouvrir : état des portes',
      h(
        'div',
        { class: 'dooract-evac-box' },
        bilan,
        h('div', { class: 'table-scroll' }, h('table', { class: 'data dooract-table' }, h('thead', {}, h('tr', {}, ['Porte', 'État', 'Détail'].map((t) => h('th', { scope: 'col', text: t })))), body)),
        h('p', { class: 'hint', text: `Demande faite à ${time(res.at)}. Une porte n’est comptée « ouverte » qu’après l’accusé de son équipement.` }),
        h('div', { class: 'actions dialog-actions' }, h('button', { class: 'btn', type: 'button', text: 'Fermer', onclick: close })),
      ),
      { onClose: () => unwatch() },
    );
    render();
  }
}
