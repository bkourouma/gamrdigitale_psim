/**
 * Écran « Rondes », rubriques Agents et Téléphones (administrateur).
 *
 * Agents : gardiens et rondiers (comptes de rôle « agent »). Liste avec l'état de service, la dernière position, les
 * zones et le verrou du code, création (avec un code personnel de 4 à 6 chiffres), modification, déverrouillage, fin de
 * service forcée, retrait.
 * Téléphones : un téléphone doit être appairé au site avant qu'un agent s'y connecte. On l'ajoute, on affiche le QR code
 * du certificat puis celui d'appairage, et on voit l'appairage aboutir sans rien recharger. Un téléphone perdu se révoque
 * en un clic.
 *
 * Règles tenues ici :
 *  - Aucun secret n'est conservé. Le code personnel d'un agent n'existe que dans son champ (vidé après l'envoi) et, une
 *    seule fois, dans la fenêtre « Agent créé » (non fermable d'un clic à côté, vidée à la fermeture). Le code d'appairage
 *    (dans l'adresse d'appairage) n'existe que dans la fenêtre d'appairage. Ni stockage du navigateur, ni attribut, ni
 *    console, ni message à l'écran. La clé d'un téléphone n'existe pas côté navigateur : le serveur la dépose dans un
 *    cookie HttpOnly.
 *  - Les formulaires de création sont construits une seule fois : un rafraîchissement ne les efface jamais. Un éditeur
 *    d'agent ouvert garde sa saisie à travers un rechargement (ses éléments sont conservés), et le rafraîchissement
 *    automatique attend la fin d'une saisie dans l'éditeur.
 *  - Les réponses tardives (numéro de requête) et celles qui arrivent après une déconnexion (génération) sont ignorées.
 *
 * Le fichier ne fait aucun import et ne touche pas à `document` au chargement : les fonctions pures ci-dessous
 * (validation, libellés, durées) s'exécutent sous Node pour les tests.
 */

// ---------------------------------------------------------------- règles et fonctions pures

/** Identifiant d'un agent : même règle que le serveur (et que l'écran des comptes). */
export const AGENT_USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const MAX_NAME = 80;
export const MAX_PHONE_LABEL = 60;
export const DEFAULT_SHIFT_HOURS = 12;
const MIN_SHIFT_HOURS = 1;
const MAX_SHIFT_HOURS = 24;

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const pad = (n) => String(n).padStart(2, '0');
const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

/** Heure en millisecondes epoch valide (un nombre fini, dans l'intervalle que `Date` sait lire). */
const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15;
const text = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const clock = (ts) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const dayStart = (ts) => {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
/** Nombre de jours calendaires entre deux instants (a - b). */
const dayDiff = (a, b) => Math.round((dayStart(a) - dayStart(b)) / 86400000);
const dateLabel = (ts, now) => {
  const d = new Date(ts);
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `le ${d.getDate() === 1 ? '1er' : d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
};

/** Liste reçue du serveur : tableau nu ou enveloppé (`{ agents: [...] }`). Toute autre forme donne une liste vide. */
export function listOf(data, key) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Array.isArray(data[key])) return data[key];
  return [];
}

/** « aujourd'hui à 17:42 », « hier à 08:10 », « le 3 octobre à 14:05 » (l'année si ce n'est pas la même). */
export function whenText(ts, now = Date.now()) {
  if (!isTime(ts)) return '';
  const days = dayDiff(now, ts);
  if (days === 0) return `aujourd’hui à ${clock(ts)}`;
  if (days === 1) return `hier à ${clock(ts)}`;
  return `${dateLabel(ts, now)} à ${clock(ts)}`;
}

/** Âge d'un évènement : « à l'instant », « il y a 4 min », « il y a 2 h », « il y a 3 jours », « jamais ». */
export function phoneAgo(ts, now = Date.now()) {
  if (!isTime(ts)) return 'jamais';
  const seconds = Math.floor((now - ts) / 1000);
  if (seconds < 60) return "à l'instant"; // aussi pour une heure légèrement dans le futur (horloges décalées)
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  return `il y a ${days} ${days > 1 ? 'jours' : 'jour'}`;
}

/** Suite du texte d'un service en cours : « depuis 22:04, fin prévue à 10:04 ». Vide si hors service. */
export function shiftDetail(shift, now = Date.now()) {
  if (!shift || typeof shift !== 'object' || !isTime(shift.startedAt)) return '';
  const days = dayDiff(now, shift.startedAt);
  const from = days === 0 || days === 1 ? clock(shift.startedAt) : `${dateLabel(shift.startedAt, now)} à ${clock(shift.startedAt)}`;
  let out = `depuis ${from}`;
  if (isTime(shift.endsAt)) {
    const span = dayDiff(shift.endsAt, shift.startedAt);
    const until = span === 0 || span === 1 ? clock(shift.endsAt) : `${dateLabel(shift.endsAt, now)} à ${clock(shift.endsAt)}`;
    out += `, fin prévue à ${until}`;
  }
  return out;
}

/** « En service depuis 22:04, fin prévue à 10:04 » ou « Hors service ». */
export function shiftText(shift, now = Date.now()) {
  if (!shift || typeof shift !== 'object') return 'Hors service';
  const detail = shiftDetail(shift, now);
  return detail ? `En service ${detail}` : 'En service';
}

/** Dernière position connue : « Arrière-cour, il y a 4 min », ou « — ». */
export function positionText(position, now = Date.now()) {
  if (!position || typeof position !== 'object') return '—';
  const name = text(position.name).trim();
  if (!name) return '—';
  return isTime(position.at) ? `${name}, ${phoneAgo(position.at, now)}` : name;
}

/** Durée maximale d'un service : « 12 h », « 1 h 30 », « 45 min », « — » si inconnue. */
export function hoursText(minutes) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return '—';
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} h` : `${h} h ${pad(m)}`;
}

/** Heures saisies → minutes (entier), ou null si la valeur n'est pas une durée de 1 à 24 heures. */
export function shiftMinutes(hours) {
  let n;
  if (typeof hours === 'number') n = hours;
  else if (typeof hours === 'string' && /^\s*\d+(?:[.,]\d+)?\s*$/.test(hours)) n = Number(hours.trim().replace(',', '.'));
  else return null;
  if (!Number.isFinite(n) || n < MIN_SHIFT_HOURS || n > MAX_SHIFT_HOURS) return null;
  return Math.round(n * 60);
}

/** Minutes → texte d'un champ d'heures (« 12 », « 1.5 »). */
export const hoursInput = (minutes) =>
  typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? String(Math.round((minutes / 60) * 100) / 100) : String(DEFAULT_SHIFT_HOURS);

/** Code personnel : 4 à 6 chiffres exactement. Renvoie le message à afficher, ou null si le code est valide. */
export function pinProblem(pin) {
  if (typeof pin !== 'string' || pin === '') return 'Choisissez un code personnel de 4 à 6 chiffres.';
  if (!/^[0-9]+$/.test(pin)) return 'Le code personnel ne contient que des chiffres : ni lettre, ni espace.';
  if (pin.length < 4) return `Le code personnel est trop court : il faut 4 chiffres au moins (vous en avez saisi ${pin.length}).`;
  if (pin.length > 6) return 'Le code personnel est trop long : 6 chiffres au plus.';
  return null;
}

const normalizeUsername = (v) => text(v).trim().toLowerCase();
const cleanZones = (zones) => [...new Set((Array.isArray(zones) ? zones : []).filter((z) => typeof z === 'string').map((z) => z.trim()).filter(Boolean))];
/** « Toutes les zones » : demandé expressément, ou aucune zone listée (le serveur lit `[]` comme « toutes »). */
const wantsAllZones = (form) => (form.allZones === undefined ? cleanZones(form.zones).length === 0 : Boolean(form.allZones));

/**
 * Problèmes d'un formulaire d'agent : `[{ key, message }]`, dans l'ordre des champs (nom, identifiant, code, zones,
 * durée). `edit` : modification (pas d'identifiant, code facultatif : vide = inchangé).
 * Forme du formulaire : `{ username, displayName, pin, allZones, zones, hours }`.
 */
export function agentProblems(form, { edit = false } = {}) {
  const f = form && typeof form === 'object' ? form : {};
  const out = [];
  const name = text(f.displayName).trim();
  if (!name) out.push({ key: 'displayName', message: 'Indiquez le nom de l’agent, tel qu’on le verra dans la liste.' });
  else if (name.length > MAX_NAME) out.push({ key: 'displayName', message: `Le nom est trop long : ${MAX_NAME} caractères au plus.` });
  if (!edit) {
    const id = normalizeUsername(f.username);
    if (!id) out.push({ key: 'username', message: 'Indiquez un identifiant (ex. marie.dupont).' });
    else if (!AGENT_USERNAME.test(id)) out.push({ key: 'username', message: 'Identifiant invalide : 3 à 32 caractères, lettres minuscules sans accent, chiffres, point ou tiret (ex. marie.dupont).' });
  }
  const pin = f.pin === null || f.pin === undefined ? '' : typeof f.pin === 'string' ? f.pin : String(f.pin);
  if (!edit || pin !== '') {
    const problem = pinProblem(pin);
    if (problem) out.push({ key: 'pin', message: problem });
  }
  if (!wantsAllZones(f) && cleanZones(f.zones).length === 0) out.push({ key: 'zones', message: 'Cochez au moins une zone, ou « Toutes les zones ».' });
  if (shiftMinutes(f.hours) === null) out.push({ key: 'hours', message: `Indiquez une durée de ${MIN_SHIFT_HOURS} à ${MAX_SHIFT_HOURS} heures.` });
  return out;
}

/**
 * Corps à envoyer au serveur. Création : `{ username, displayName, pin, zones, maxShiftMinutes }`. Modification :
 * `{ displayName, zones, maxShiftMinutes }`, plus `pin` seulement s'il est saisi. `zones: []` veut dire « toutes ».
 * Ne valide rien : l'appelant passe d'abord par `agentProblems`.
 */
export function buildAgentPayload(form, { edit = false } = {}) {
  const f = form && typeof form === 'object' ? form : {};
  const body = {};
  if (!edit) body.username = normalizeUsername(f.username);
  body.displayName = text(f.displayName).trim();
  if (!edit) body.pin = text(f.pin);
  else if (text(f.pin) !== '') body.pin = text(f.pin);
  body.zones = wantsAllZones(f) ? [] : cleanZones(f.zones);
  body.maxShiftMinutes = shiftMinutes(f.hours) ?? DEFAULT_SHIFT_HOURS * 60;
  return body;
}

/** Nom d'un téléphone : de 1 à 60 caractères. Renvoie le message, ou null. */
export function phoneLabelProblem(label) {
  const name = text(label).trim();
  if (!name) return 'Donnez un nom au téléphone, pour le reconnaître dans la liste (ex. « Téléphone du portail »).';
  if (name.length > MAX_PHONE_LABEL) return `Le nom est trop long : ${MAX_PHONE_LABEL} caractères au plus.`;
  return null;
}

/** État d'un téléphone : `{ key: 'pending'|'paired'|'revoked'|'expired', label }`. */
export function phoneState(phone, now = Date.now()) {
  const p = phone && typeof phone === 'object' ? phone : {};
  if (isTime(p.revokedAt)) return { key: 'revoked', label: 'Révoqué' };
  if (isTime(p.pairedAt)) return { key: 'paired', label: 'Appairé' };
  if (p.pending === false) return { key: 'expired', label: 'Code expiré' }; // ni appairé ni en attente : le code n'est plus valable
  if (isTime(p.expiresAt) && p.expiresAt <= now) return { key: 'expired', label: 'Code expiré' };
  return { key: 'pending', label: 'En attente d’appairage' };
}

/** Compte à rebours d'un code d'appairage : « Valable encore 12 min », « Valable encore 45 s », ou l'invitation à recommencer. */
export function countdownText(expiresAt, now = Date.now()) {
  if (!isTime(expiresAt)) return '';
  const left = expiresAt - now;
  if (left <= 0) return 'Code expiré : ajoutez le téléphone de nouveau';
  const seconds = Math.ceil(left / 1000);
  if (seconds < 60) return `Valable encore ${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `Valable encore ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `Valable encore ${m === 0 ? `${h} h` : `${h} h ${pad(m)}`}`;
}

/**
 * Palier à annoncer aux lecteurs d'écran (pas chaque seconde) : `{ level, message }` quand il reste 5 minutes ou
 * moins, 1 minute ou moins, ou quand le code a expiré ; null sinon.
 */
export function countdownStage(expiresAt, now = Date.now()) {
  if (!isTime(expiresAt)) return null;
  const left = expiresAt - now;
  if (left <= 0) return { level: 'expired', message: 'Code expiré : ajoutez le téléphone de nouveau.' };
  if (left <= 60000) return { level: 'm1', message: 'Plus que 1 minute pour appairer ce téléphone.' };
  if (left <= 300000) return { level: 'm5', message: 'Plus que 5 minutes pour appairer ce téléphone.' };
  return null;
}

// Codes triviaux (0000, 1234, 4321) : un code tiré au hasard n'en est pas un, on retire une fois de plus.
const isTrivialPin = (pin) => pin.length >= 4 && (/^(.)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin));
const PIN_LIMIT = 4294967290; // plus grand multiple de 10 sous 2^32 : on rejette au-delà pour éviter tout biais

/** Code au hasard fait de chiffres, tiré par `crypto.getRandomValues` (jamais `Math.random`). */
export function randomPin(length = 6) {
  const n = Number.isInteger(length) && length > 0 ? Math.min(length, 12) : 6;
  const random = globalThis.crypto;
  if (!random || typeof random.getRandomValues !== 'function') throw new Error('Le navigateur ne sait pas tirer un code au hasard.');
  const buffer = new Uint32Array(1);
  let pin = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    pin = '';
    for (let tries = 0; pin.length < n && tries < 1000; tries++) {
      random.getRandomValues(buffer);
      if (buffer[0] >= PIN_LIMIT && tries < 999) continue;
      pin += String(buffer[0] % 10);
    }
    if (!isTrivialPin(pin)) break;
  }
  return pin;
}

/** Agent tel que le serveur le décrit, ramené à une forme sûre (champ absent ou hostile : valeur par défaut). */
export function normalizeAgent(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.username !== 'string' || raw.username === '') return null;
  const shift = raw.shift && typeof raw.shift === 'object' ? { startedAt: isTime(raw.shift.startedAt) ? raw.shift.startedAt : null, endsAt: isTime(raw.shift.endsAt) ? raw.shift.endsAt : null } : null;
  const position = raw.position && typeof raw.position === 'object' && text(raw.position.name).trim() ? { name: text(raw.position.name).trim(), at: isTime(raw.position.at) ? raw.position.at : null } : null;
  return {
    username: raw.username,
    displayName: text(raw.displayName).trim() || raw.username,
    zones: cleanZones(raw.zones),
    locked: raw.locked === true,
    maxShiftMinutes: typeof raw.maxShiftMinutes === 'number' && raw.maxShiftMinutes > 0 ? raw.maxShiftMinutes : null,
    shift,
    position,
  };
}

/** Téléphone tel que le serveur le décrit, ramené à une forme sûre. */
export function normalizePhone(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!(typeof raw.id === 'number' && Number.isFinite(raw.id)) && !(typeof raw.id === 'string' && raw.id !== '')) return null;
  const pairedAt = isTime(raw.pairedAt) ? raw.pairedAt : null;
  const revokedAt = isTime(raw.revokedAt) ? raw.revokedAt : null;
  return {
    id: String(raw.id),
    label: text(raw.label).trim() || 'Téléphone sans nom',
    pairedAt,
    revokedAt,
    lastSeenAt: isTime(raw.lastSeenAt) ? raw.lastSeenAt : null,
    pending: raw.pending === undefined ? !pairedAt && !revokedAt : raw.pending === true,
    expiresAt: isTime(raw.expiresAt) ? raw.expiresAt : null,
  };
}

const AUTO_REFRESH_MS = 30000;
const PAIR_POLL_MS = 3000;
const PAIR_POLL_GRACE_MS = 30000; // on cherche encore un peu après l'échéance : les horloges ne sont pas d'accord à la seconde
const frSort = (a, b) => a.localeCompare(b, 'fr');

// ---------------------------------------------------------------- écran

export function createAgentsAdmin({ api, h, icon, toast, dialogs, ui, getMe = () => null, getZones = () => [], now: nowFn = () => Date.now() }) {
  const { field, setBusy, markInvalid, clearInvalid, copyButton, uid } = ui;
  const agentsPanel = document.getElementById('pt-panel-agents') ?? h('section');
  const phonesPanel = document.getElementById('pt-panel-phones') ?? h('section');

  /** Génération : change à chaque `reset()`. Une réponse partie avant ne doit rien afficher après. */
  let epoch = 0;
  let owner = null;
  const knownZones = () => [...new Set((() => {
    try {
      const zones = getZones();
      return Array.isArray(zones) ? zones.filter((z) => typeof z === 'string' && z.trim() !== '') : [];
    } catch {
      return [];
    }
  })())].sort(frSort);

  const th = (label) => h('th', { scope: 'col', text: label });
  const loadError = (title, err, retry) =>
    h('div', { class: 'notice is-alarm' }, icon('state-alarm'), h('span', {}, h('strong', { text: `${title} ` }), `${err.message}. `, h('button', { class: 'btn btn-sm', type: 'button', text: 'Réessayer', onclick: retry })));
  const isShown = (el) => el.isConnected && !el.closest('[hidden]');
  /** Seul l'administrateur crée, modifie et retire un agent ; le chef de poste déverrouille et termine un service. */
  const isAdmin = () => getMe()?.role === 'admin';

  /** Nœud <time> (date complète en infobulle) ; « — » si l'heure est absente. */
  function timeNode(ts, label = whenText(ts, nowFn())) {
    if (!isTime(ts)) return h('span', { class: 'faint', text: '—' });
    const d = new Date(ts);
    return h('time', { datetime: d.toISOString(), title: d.toLocaleString('fr-FR'), text: label });
  }

  // ---------------------------------------------------------------- focus après un rechargement

  /**
   * Garde le focus à travers la reconstruction d'une liste (principe de users.js) : la commande qui l'avait est
   * retrouvée par sa clé `data-key` ; si elle a disparu (ligne retirée), le focus va au titre du panneau.
   */
  function focusKeeper(container, fallbackId) {
    let pending = null; // commande qui vient d'agir : désactivée pendant l'envoi, le navigateur lui a retiré le focus
    return {
      mark(key) {
        pending = key;
      },
      take() {
        const a = document.activeElement;
        const key = a && container.contains(a) && a.dataset.key ? a.dataset.key : !a || a === document.body ? pending : null;
        pending = null;
        return key;
      },
      restore(key) {
        if (!key) return;
        const el = container.querySelector(`[data-key="${CSS.escape(key)}"]`);
        (el && !el.disabled ? el : document.getElementById(fallbackId))?.focus({ preventScroll: Boolean(el) });
      },
    };
  }

  /** Fenêtre commune : une seule à la fois. On retient la nôtre pour la fermer à la déconnexion ou au changement d'écran. */
  let ownedDialog = 0;
  let silentClose = false;
  function openOwned(heading, content, { dismissible = true, onClose } = {}) {
    const token = ++ownedDialog;
    dialogs.open(heading, content, {
      dismissible,
      onClose: () => {
        if (ownedDialog === token) ownedDialog = 0;
        onClose?.(silentClose);
      },
    });
  }
  /** Ferme notre fenêtre sans rien relancer ni déplacer le focus (déconnexion, changement d'écran). */
  function closeOwned() {
    if (!ownedDialog) return;
    silentClose = true;
    try {
      dialogs.close();
    } finally {
      silentClose = false;
      ownedDialog = 0;
    }
  }

  // ---------------------------------------------------------------- éléments communs : code personnel et zones

  /**
   * Champ « code personnel » : masqué, avec la case « Afficher » et le tirage d'un code au hasard (affiché, pour que
   * l'administrateur le voie). `required` : champ obligatoire (création) ou facultatif (modification).
   */
  function pinField({ label, hint, keyBase, required = false }) {
    const id = uid('ag-pin');
    const hintId = uid('ag-hint');
    const input = h('input', { id, type: 'password', inputmode: 'numeric', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '6', required, 'aria-describedby': hintId, 'data-key': `${keyBase}:pin` });
    const show = h('input', { type: 'checkbox', 'data-key': `${keyBase}:pin-show` });
    const reveal = (visible) => {
      show.checked = visible;
      input.type = visible ? 'text' : 'password';
    };
    show.addEventListener('change', () => reveal(show.checked));
    const random = h('button', { class: 'btn', type: 'button', 'data-key': `${keyBase}:pin-random` }, icon('refresh'), 'Choisir un code au hasard');
    random.addEventListener('click', () => {
      input.value = randomPin(4);
      input.removeAttribute('aria-invalid');
      reveal(true);
      input.focus();
      input.select();
    });
    return {
      el: h(
        'div',
        { class: 'field ag-pin-field' },
        h('label', { for: id, text: label }),
        h('span', { class: 'adm-input-row' }, input, random),
        h('span', { class: 'hint', id: hintId, text: hint }),
        h('label', { class: 'check' }, show, h('span', { text: 'Afficher le code' })),
      ),
      input,
      value: () => input.value,
      /** Vide le champ et le remasque : le code ne doit rien laisser derrière lui. */
      clear() {
        input.value = '';
        input.removeAttribute('aria-invalid');
        reveal(false);
      },
    };
  }

  /**
   * Choix des zones d'un agent : « Toutes les zones » (cochée par défaut), sinon une case par zone connue. Les zones
   * déjà données à l'agent et qui n'ont plus de détecteur restent visibles (à décocher), comme dans users.js.
   */
  function zonePicker({ initial = [], legend, keyBase }) {
    const listId = uid('ag-zones');
    const hintId = uid('ag-hint');
    const all = h('input', { type: 'checkbox', 'data-key': `${keyBase}:zones-all`, 'aria-controls': listId, 'aria-describedby': hintId });
    all.checked = initial.length === 0;
    const list = h('div', { class: 'adm-zone-list', id: listId, role: 'group', 'aria-label': legend });
    let signature = '';

    function fill(checked) {
      const current = knownZones();
      const known = [...new Set([...checked, ...current])].sort(frSort);
      signature = current.join('\u0000');
      list.replaceChildren(
        ...(known.length
          ? known.map((zone) => {
              const box = h('input', { type: 'checkbox', value: zone, 'data-key': `${keyBase}:zone:${zone}` });
              box.checked = checked.includes(zone);
              return h('label', { class: 'check' }, box, h('span', { text: zone }), current.length === 0 || current.includes(zone) ? null : h('span', { class: 'tag is-warning', text: 'aucun détecteur' }));
            })
          : [h('span', { class: 'muted', text: 'Aucune zone n’est encore connue : donnez d’abord une zone aux détecteurs, dans « Équipements et plan ».' })]),
      );
      // Sans zone connue, « Toutes les zones » est le seul choix possible.
      all.disabled = known.length === 0 && all.checked;
    }
    const sync = () => (list.hidden = all.checked);
    fill(initial);
    sync();
    all.addEventListener('change', sync);
    const value = () => ({ all: all.checked, zones: [...list.querySelectorAll('input:checked')].map((i) => i.value) });
    return {
      el: h(
        'fieldset',
        { class: 'adm-zone-picker ag-zones' },
        h('legend', { text: legend }),
        h('label', { class: 'check' }, all, h('span', { text: 'Toutes les zones' })),
        list,
        h('span', { class: 'hint', id: hintId, text: 'Décochez pour ne montrer à l’agent que les alarmes de certaines zones.' }),
      ),
      value,
      firstInput: () => (all.checked || all.disabled ? all : (list.querySelector('input') ?? all)),
      /** Zones des détecteurs changées : la liste suit (seulement si elles ont changé), les cases cochées restent cochées. */
      refresh() {
        if (knownZones().join('\u0000') !== signature) fill(value().zones);
      },
      reset() {
        all.checked = true;
        fill([]);
        sync();
      },
    };
  }

  // ================================================================ rubrique Agents

  const agentsFocus = focusKeeper(agentsPanel, 'ag-list-title');
  let agentsReq = 0;
  let agentsTimer = 0;
  let agentsLoaded = false; // une liste est affichée
  const editors = new Map(); // identifiant → éditeur ouvert (conservé tel quel à travers un rechargement)

  const agentsBox = h('div', { class: 'ag-list' }, h('p', { class: 'muted', text: 'Chargement…' }));
  const agentsUpdated = h('span', { class: 'hint ag-updated' });
  const agentsRefresh = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': 'Actualiser la liste des agents', 'data-key': 'ag:refresh' }, icon('refresh'), 'Actualiser');
  agentsRefresh.addEventListener('click', () => loadAgents());

  function stopAgentsTimer() {
    clearInterval(agentsTimer);
    agentsTimer = 0;
  }

  /** Rafraîchissement automatique (état de service, position) tant que l'onglet est visible. */
  function armAgentsTimer() {
    if (agentsTimer) return;
    agentsTimer = setInterval(() => {
      if (!isShown(agentsPanel)) return stopAgentsTimer(); // l'onglet n'est plus affiché : on s'arrête seul
      if (document.hidden) return;
      loadAgents({ background: true });
    }, AUTO_REFRESH_MS);
  }

  async function loadAgents({ background = false } = {}) {
    resetIfOtherAccount();
    if (createPanel) createPanel.hidden = !isAdmin();
    armAgentsTimer();
    const req = ++agentsReq;
    const ep = epoch;
    try {
      const data = await api('/api/agents');
      if (req !== agentsReq || ep !== epoch) return; // réponse tardive
      renderAgents(listOf(data, 'agents').map(normalizeAgent).filter(Boolean), { background });
      createForm.zones.refresh();
    } catch (err) {
      if (req !== agentsReq || ep !== epoch) return;
      if (agentsLoaded && (background || editors.size > 0)) {
        // La liste affichée reste : on ne la remplace pas par une erreur (un éditeur ouvert ou une liste lisible valent mieux).
        agentsUpdated.textContent = `Mise à jour impossible (${err.message}). Nouvel essai dans 30 s.`;
      } else {
        agentsLoaded = false;
        agentsUpdated.textContent = '';
        agentsBox.replaceChildren(loadError('Liste des agents illisible.', err, () => loadAgents()));
      }
    }
  }

  /** Vrai si l'administrateur est en train de taper dans un éditeur : le rafraîchissement automatique attend. */
  const typingInEditor = () => {
    const a = document.activeElement;
    return Boolean(a && agentsBox.contains(a) && a.closest('.ag-editor') && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
  };

  function renderAgents(list, { background }) {
    const now = nowFn();
    if (background && typingInEditor()) return; // l'état affiché est un peu ancien ; la saisie en cours passe avant
    agentsUpdated.textContent = `Mis à jour à ${clock(now)}`;
    agentsLoaded = true;
    if (createPanel) createPanel.hidden = !isAdmin(); // la création est réservée à l'administrateur
    const key = agentsFocus.take();
    // En service d'abord (c'est ce qu'on cherche), puis par nom.
    const sorted = [...list].sort((a, b) => Number(Boolean(b.shift)) - Number(Boolean(a.shift)) || frSort(a.displayName, b.displayName));
    const present = new Set(sorted.map((a) => a.username));
    for (const username of [...editors.keys()]) if (!present.has(username)) editors.delete(username); // agent retiré ailleurs

    if (sorted.length === 0) {
      agentsBox.replaceChildren(
        h(
          'div',
          { class: 'empty' },
          icon('users'),
          h('strong', { text: 'Aucun agent pour l’instant.' }),
          h('span', { text: 'Un agent est un gardien ou un rondier. Il se connecte sur un téléphone appairé avec son code personnel.' }),
          isAdmin() ? h('button', { class: 'btn btn-primary', type: 'button', 'data-key': 'ag:empty-add', onclick: () => createForm.focus() }, icon('plus'), 'Ajouter un agent') : null,
        ),
      );
    } else {
      agentsBox.replaceChildren(
        h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            { class: 'data adm-stack ag-table' },
            h('caption', { class: 'sr-only', text: plural(sorted.length, 'agent') }),
            h('thead', {}, h('tr', {}, th('Agent'), th('Service'), th('Dernière position'), th('Zones'), th('Code personnel'), th('Durée maximale'), h('th', { scope: 'col' }, h('span', { class: 'sr-only', text: 'Actions' })))),
            h('tbody', {}, ...sorted.flatMap((a) => agentRows(a, now))),
          ),
        ),
        isAdmin()
          ? h('p', { class: 'panel-note' }, 'Un agent se connecte sur un téléphone déjà appairé : voir l’', h('a', { href: '#/rondes/phones', text: 'onglet Téléphones' }), '.')
          : h('p', { class: 'panel-note', text: 'Chef de poste : vous pouvez déverrouiller le code d’un agent et terminer son service. Le reste se règle avec un compte administrateur.' }),
      );
    }
    agentsFocus.restore(key);
  }

  /** Ligne d'un agent, suivie de son éditeur s'il est ouvert. */
  function agentRows(a, now) {
    const path = `/api/agents/${encodeURIComponent(a.username)}`;
    const k = (what) => `a:${a.username}:${what}`;
    const name = a.displayName;
    const current = knownZones();

    // Service
    const service = a.shift
      ? h('span', { class: 'ag-service' }, h('span', { class: 'pill is-ok' }, icon('state-ok'), 'En service'), h('span', { class: 'ag-detail', text: shiftDetail(a.shift, now) }))
      : h('span', { class: 'pill is-offline is-dashed' }, icon('state-offline'), 'Hors service');

    // Zones
    const zones =
      a.zones.length === 0
        ? h('span', { text: 'Toutes les zones' })
        : h('span', { class: 'adm-zones-line' }, ...a.zones.map((zone) => h('span', { class: current.length === 0 || current.includes(zone) ? 'tag' : 'tag is-warning', text: current.length === 0 || current.includes(zone) ? zone : `${zone} (aucun détecteur)` })));

    // Verrou du code
    let lock;
    if (a.locked) {
      const unlock = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': `Déverrouiller ${name}`, 'data-key': k('unlock') }, icon('unlock'), 'Déverrouiller');
      unlock.addEventListener('click', async () => {
        const ep = epoch;
        agentsFocus.mark(k('unlock'));
        setBusy(unlock, true);
        try {
          await api(`${path}/unlock`, { method: 'POST' });
          if (ep !== epoch) return;
          toast(`Code de ${name} déverrouillé`, 'ok');
        } catch (err) {
          toast(err.message);
        }
        loadAgents();
      });
      lock = h('span', { class: 'ag-lock' }, h('span', { class: 'pill is-alarm' }, icon('lock'), 'Code verrouillé après 5 essais'), unlock);
    } else {
      lock = h('span', { class: 'faint', text: 'Non verrouillé' });
    }

    // Actions
    // Le chef de poste (operator) lit la liste, déverrouille un code et termine un service : ni modification ni retrait.
    const admin = isAdmin();
    const editBtn = admin ? h('button', { class: 'btn btn-sm', type: 'button', 'aria-expanded': 'false', 'aria-label': `Modifier ${name}`, 'data-key': k('edit') }, icon('pencil'), 'Modifier') : null;
    const actions = editBtn ? [editBtn] : [];
    if (a.shift) {
      const end = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': `Terminer son service : ${name}`, 'data-key': k('end') }, icon('logout'), 'Terminer son service');
      end.addEventListener('click', async () => {
        const ok = await dialogs.confirm({
          heading: `Terminer le service de ${name}`,
          message: 'Son service s’arrête tout de suite ; il devra se reconnecter et reprendre son service.',
          details: `${shiftText(a.shift, nowFn())}.`,
          confirmLabel: 'Terminer le service',
          danger: false,
          onConfirm: () => api(`${path}/end-shift`, { method: 'POST' }),
        });
        if (!ok) return;
        toast(`Service de ${name} terminé`, 'ok');
        agentsFocus.mark(k('end'));
        loadAgents();
      });
      actions.push(end);
    }
    const retire = h('button', { class: 'btn btn-sm btn-danger', type: 'button', 'aria-label': `Retirer ${name}`, 'data-key': k('retire') }, icon('trash'), 'Retirer');
    retire.addEventListener('click', async () => {
      const ok = await dialogs.confirm({
        heading: `Retirer ${name}`,
        message: `${name} ne pourra plus se connecter. Le compte est désactivé. L’historique des rondes et de la main courante est conservé.`,
        confirmLabel: 'Retirer l’agent',
        onConfirm: () => api(path, { method: 'DELETE' }),
      });
      if (!ok) return;
      toast(`${name} est retiré`, 'ok');
      editors.delete(a.username);
      loadAgents();
    });
    if (admin) actions.push(retire);

    const row = h(
      'tr',
      { class: a.shift ? 'is-in-service' : '' },
      h('td', { 'data-label': 'Agent', class: 'adm-who' }, h('span', { class: 'adm-who-name' }, h('strong', { text: name })), h('span', { class: 'adm-who-sub adm-mono', text: a.username })),
      h('td', { 'data-label': 'Service' }, service),
      h('td', { 'data-label': 'Dernière position', text: positionText(a.position, now) }),
      h('td', { 'data-label': 'Zones' }, zones),
      h('td', { 'data-label': 'Code personnel' }, lock),
      h('td', { 'data-label': 'Durée maximale', text: hoursText(a.maxShiftMinutes) }),
      h('td', { class: 'adm-actions-cell' }, h('div', { class: 'actions' }, ...actions)),
    );
    if (!editBtn) return [row];

    editBtn.addEventListener('click', () => {
      const existing = editors.get(a.username);
      if (existing) return existing.close(true);
      const editor = createEditor(a);
      editors.set(a.username, editor);
      editor.bind(a, row, editBtn);
      row.after(editor.row);
      editor.focus();
    });

    const open = editors.get(a.username);
    if (!open) return [row];
    open.bind(a, row, editBtn); // l'éditeur ouvert est conservé tel quel : il se raccroche à la ligne reconstruite
    return [row, open.row];
  }

  /**
   * Éditeur d'un agent (ligne dépliée sous la sienne) : nom, zones, durée, nouveau code facultatif. Ses éléments sont
   * créés une fois ; un rechargement de la liste les remet en place sans toucher à la saisie.
   */
  function createEditor(initial) {
    const username = initial.username;
    const path = `/api/agents/${encodeURIComponent(username)}`;
    const k = (what) => `a:${username}:${what}`;
    let ctx = { agent: initial, row: null, btn: null };
    let busy = false;

    const nameInput = h('input', { maxlength: String(MAX_NAME), autocomplete: 'off', required: true, 'data-key': k('name') });
    nameInput.value = initial.displayName;
    const hours = h('input', { type: 'number', min: String(MIN_SHIFT_HOURS), max: String(MAX_SHIFT_HOURS), step: 'any', inputmode: 'decimal', autocomplete: 'off', 'data-key': k('hours') });
    hours.value = hoursInput(initial.maxShiftMinutes);
    const picker = zonePicker({ initial: initial.zones, legend: `Zones de ${initial.displayName}`, keyBase: k('edit') });
    const pin = pinField({ label: 'Nouveau code personnel (facultatif)', hint: 'Laissez vide pour garder le code actuel. 4 à 6 chiffres : communiquez-le à l’agent de vive voix.', keyBase: k('edit') });
    const error = h('p', { class: 'form-error', role: 'alert' });
    const save = h('button', { class: 'btn btn-sm btn-primary', type: 'submit', 'data-key': k('save') }, 'Enregistrer');
    const cancel = h('button', { class: 'btn btn-sm', type: 'button', text: 'Annuler', 'data-key': k('cancel') });
    const targets = { displayName: nameInput, hours, pin: pin.input };

    const form = h(
      'form',
      { class: 'adm-form ag-editor', novalidate: true, 'aria-label': `Modifier ${initial.displayName}` },
      h('div', { class: 'form-grid adm-grid' }, field(h, 'Nom affiché', nameInput), field(h, 'Durée maximale d’un service (heures)', hours, 'Au bout de ce temps, la session de l’agent se ferme d’elle-même.')),
      picker.el,
      pin.el,
      error,
      h('div', { class: 'actions' }, save, cancel),
    );
    const cell = h('td', { colspan: '7' }, h('div', { class: 'adm-zone-editor' }, form));
    const rowEl = h('tr', { class: 'adm-zone-row ag-edit-row', id: uid('ag-edit') }, cell);

    const editor = {
      row: rowEl,
      bind(agent, row, btn) {
        ctx = { agent, row, btn };
        row.classList.add('is-editing');
        btn.setAttribute('aria-expanded', 'true');
        btn.setAttribute('aria-controls', rowEl.id);
      },
      focus: () => nameInput.focus(),
      close(focusButton = true) {
        pin.clear();
        rowEl.remove();
        ctx.row?.classList.remove('is-editing');
        ctx.btn?.setAttribute('aria-expanded', 'false');
        editors.delete(username);
        if (focusButton) ctx.btn?.focus();
      },
    };

    cancel.addEventListener('click', () => editor.close(true));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      clearInvalid(form, error);
      const zones = picker.value();
      const values = { displayName: nameInput.value, hours: hours.value, pin: pin.value(), allZones: zones.all, zones: zones.zones };
      const problems = agentProblems(values, { edit: true });
      if (problems.length) {
        const [first] = problems;
        return markInvalid(first.key === 'zones' ? picker.firstInput() : targets[first.key], error, first.message);
      }
      busy = true;
      setBusy(save, true);
      const ep = epoch;
      try {
        await api(path, { method: 'PATCH', body: buildAgentPayload(values, { edit: true }) });
        pin.clear(); // le code saisi ne reste nulle part une fois envoyé
        if (ep !== epoch) return;
        toast(`${nameInput.value.trim()} est enregistré`, 'ok');
        agentsFocus.mark(k('edit'));
        editor.close(false);
        loadAgents();
      } catch (err) {
        if (ep === epoch) markInvalid(/code|pin/i.test(err.message) ? pin.input : /nom/i.test(err.message) ? nameInput : /dur|heure|minute/i.test(err.message) ? hours : null, error, err.message);
      } finally {
        busy = false;
        setBusy(save, false);
      }
    });
    return editor;
  }

  // ---------------------------------------------------------------- créer un agent

  /** Formulaire construit une fois : jamais effacé par un rafraîchissement de la liste. */
  function buildCreateForm() {
    const displayName = h('input', { maxlength: String(MAX_NAME), autocomplete: 'off', required: true, placeholder: 'ex. Marie Dupont', 'data-key': 'ag:new:name' });
    const username = h('input', { maxlength: '32', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', required: true, placeholder: 'ex. marie.dupont', 'data-key': 'ag:new:username' });
    const pin = pinField({ required: true, label: 'Code personnel', hint: 'L’agent le tape pour ouvrir sa session. Communiquez-le-lui de vive voix. 4 à 6 chiffres.', keyBase: 'ag:new' });
    const picker = zonePicker({ legend: 'Zones', keyBase: 'ag:new' });
    const hours = h('input', { type: 'number', min: String(MIN_SHIFT_HOURS), max: String(MAX_SHIFT_HOURS), step: 'any', inputmode: 'decimal', autocomplete: 'off', 'data-key': 'ag:new:hours' });
    hours.value = String(DEFAULT_SHIFT_HOURS);
    const error = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit', 'data-key': 'ag:new:submit' }, icon('plus'), 'Ajouter l’agent');
    const targets = { displayName, username, pin: pin.input, hours };
    let busy = false;

    const clearAll = () => {
      displayName.value = '';
      username.value = '';
      pin.clear();
      picker.reset();
      hours.value = String(DEFAULT_SHIFT_HOURS);
    };

    const form = h(
      'form',
      {
        class: 'adm-form',
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          if (busy) return;
          clearInvalid(form, error);
          const zones = picker.value();
          const values = { username: username.value, displayName: displayName.value, pin: pin.value(), allZones: zones.all, zones: zones.zones, hours: hours.value };
          const problems = agentProblems(values);
          if (problems.length) {
            const [first] = problems;
            return markInvalid(first.key === 'zones' ? picker.firstInput() : targets[first.key], error, first.message);
          }
          busy = true;
          setBusy(submit, true);
          const ep = epoch;
          try {
            await api('/api/agents', { method: 'POST', body: buildAgentPayload(values) });
            if (ep !== epoch) return;
            const created = { name: values.displayName.trim(), code: values.pin };
            clearAll(); // le code est rappelé une seule fois, dans la fenêtre ci-dessous : plus nulle part ensuite
            values.pin = '';
            busy = false;
            setBusy(submit, false);
            submit.focus(); // sinon la fenêtre ne saurait pas à quelle commande rendre le focus
            toast(`Agent ${created.name} ajouté`, 'ok');
            loadAgents();
            showCreated(created.name, created.code);
          } catch (err) {
            if (ep === epoch) {
              const m = err.message;
              const target = /identifiant/i.test(m) ? username : /code|pin/i.test(m) ? pin.input : /dur|heure|minute/i.test(m) ? hours : /nom/i.test(m) ? displayName : null;
              markInvalid(target, error, m);
            }
          } finally {
            busy = false;
            setBusy(submit, false);
          }
        },
      },
      h(
        'div',
        { class: 'form-grid adm-grid' },
        field(h, 'Nom affiché', displayName, 'Tel qu’on le verra dans la liste et dans le journal des rondes.'),
        field(h, 'Identifiant', username, 'Minuscules, chiffres, point, tiret ; sert à le reconnaître, pas à se connecter.'),
      ),
      pin.el,
      picker.el,
      h('div', { class: 'form-grid adm-grid' }, field(h, 'Durée maximale d’un service (heures)', hours, 'De 1 à 24 heures. Au bout de ce temps, la session de l’agent se ferme d’elle-même.')),
      error,
      h('div', { class: 'actions' }, submit),
    );

    /** Fenêtre « Agent créé » : le code n'y est montré qu'une fois. */
    function showCreated(name, code) {
      const codeEl = h('code', { class: 'ag-pin adm-mono', text: code });
      const done = h('button', { class: 'btn btn-primary', type: 'button', 'data-autofocus': '' }, icon('check'), 'J’ai noté le code, fermer');
      done.addEventListener('click', () => dialogs.close());
      openOwned(
        'Agent créé',
        h(
          'div',
          { class: 'ag-reveal' },
          h('p', { class: 'dialog-lead', text: `${name} est ajouté. Il peut ouvrir sa session sur un téléphone appairé avec le code ci-dessous.` }),
          h('div', { class: 'notice is-warning', role: 'alert' }, icon('state-warning'), h('span', {}, h('strong', { text: 'Notez-le ou dites-le à l’agent : il ne sera plus affiché. ' }), 'Le PSIM n’en garde qu’une empreinte et ne peut pas le retrouver. En cas d’oubli, donnez-lui un nouveau code avec « Modifier ».')),
          h('div', { class: 'ag-block' }, h('h3', { text: `Code personnel de ${name}` }), codeEl),
          h('div', { class: 'actions dialog-actions' }, done),
        ),
        {
          dismissible: false, // un code jamais réaffiché : on ne ferme que par le bouton
          onClose: (silent) => {
            codeEl.textContent = '';
            if (!silent && isShown(agentsPanel)) displayName.focus();
          },
        },
      );
    }

    return {
      el: form,
      zones: picker,
      focus: () => displayName.focus(),
      reset() {
        clearAll();
        clearInvalid(form, error);
        busy = false;
        setBusy(submit, false);
      },
    };
  }

  const createForm = buildCreateForm();
  let createPanel = null;
  agentsPanel.replaceChildren(
    h(
      'div',
      { class: 'ag-stack' },
      h(
        'section',
        { class: 'panel', 'aria-labelledby': 'ag-list-title' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'ag-list-title', tabindex: '-1' }, icon('users'), 'Agents'), h('div', { class: 'actions ag-refresh' }, agentsUpdated, agentsRefresh)),
        h('div', { class: 'panel-body' }, agentsBox),
      ),
      (createPanel = h(
        'section',
        { class: 'panel', 'aria-labelledby': 'ag-create-title' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'ag-create-title' }, icon('plus'), 'Ajouter un agent')),
        h('div', { class: 'panel-body' }, createForm.el),
      )),
    ),
  );

  // ================================================================ rubrique Téléphones

  const phonesFocus = focusKeeper(phonesPanel, 'ph-list-title');
  let phonesReq = 0;
  let phonesTimer = 0;

  const phonesBox = h('div', { class: 'ag-list' }, h('p', { class: 'muted', text: 'Chargement…' }));
  const phonesUpdated = h('span', { class: 'hint ag-updated' });
  const phonesRefresh = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': 'Actualiser la liste des téléphones', 'data-key': 'ph:refresh' }, icon('refresh'), 'Actualiser');
  phonesRefresh.addEventListener('click', () => loadPhones());
  let phonesLoaded = false;

  function stopPhonesTimer() {
    clearInterval(phonesTimer);
    phonesTimer = 0;
  }

  function armPhonesTimer() {
    if (phonesTimer) return;
    phonesTimer = setInterval(() => {
      if (!isShown(phonesPanel)) return stopPhonesTimer();
      if (document.hidden) return;
      loadPhones({ background: true });
    }, AUTO_REFRESH_MS);
  }

  async function loadPhones({ background = false } = {}) {
    resetIfOtherAccount();
    armPhonesTimer();
    const req = ++phonesReq;
    const ep = epoch;
    try {
      const data = await api('/api/agent-phones');
      if (req !== phonesReq || ep !== epoch) return;
      renderPhones(listOf(data, 'phones').map(normalizePhone).filter(Boolean));
    } catch (err) {
      if (req !== phonesReq || ep !== epoch) return;
      if (phonesLoaded && background) {
        phonesUpdated.textContent = `Mise à jour impossible (${err.message}). Nouvel essai dans 30 s.`;
      } else {
        phonesLoaded = false;
        phonesUpdated.textContent = '';
        phonesBox.replaceChildren(loadError('Liste des téléphones illisible.', err, () => loadPhones()));
      }
    }
  }

  const STATE_ORDER = { pending: 0, paired: 1, expired: 2, revoked: 3 };

  function renderPhones(list) {
    const now = nowFn();
    phonesLoaded = true;
    phonesUpdated.textContent = `Mis à jour à ${clock(now)}`;
    const key = phonesFocus.take();
    const sorted = list
      .map((p) => ({ p, state: phoneState(p, now) }))
      .sort((a, b) => STATE_ORDER[a.state.key] - STATE_ORDER[b.state.key] || frSort(a.p.label, b.p.label));
    if (sorted.length === 0) {
      phonesBox.replaceChildren(
        h(
          'div',
          { class: 'empty' },
          icon('phone'),
          h('strong', { text: 'Aucun téléphone pour l’instant.' }),
          h('span', { text: 'Ajoutez le téléphone que l’agent emportera en ronde : le PSIM affiche un QR code à scanner pour l’appairer au site.' }),
          h('button', { class: 'btn btn-primary', type: 'button', 'data-key': 'ph:empty-add', onclick: () => addForm.focus() }, icon('plus'), 'Ajouter un téléphone'),
        ),
      );
    } else {
      phonesBox.replaceChildren(
        h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            { class: 'data adm-stack ag-table ag-phones' },
            h('caption', { class: 'sr-only', text: plural(sorted.length, 'téléphone') }),
            h('thead', {}, h('tr', {}, th('Téléphone'), th('État'), th('Appairé le'), th('Vu pour la dernière fois'), h('th', { scope: 'col' }, h('span', { class: 'sr-only', text: 'Actions' })))),
            h('tbody', {}, ...sorted.map(({ p, state }) => phoneRow(p, state, now))),
          ),
        ),
      );
    }
    phonesFocus.restore(key);
  }

  function phoneRow(p, state, now) {
    const k = (what) => `ph:${p.id}:${what}`;
    const revoked = state.key === 'revoked';

    let stateCell;
    if (state.key === 'pending') {
      stateCell = h('span', { class: 'ag-state' }, h('span', { class: 'pill is-warning is-dashed' }, icon('clock'), state.label), p.expiresAt ? h('span', { class: 'ag-detail', text: countdownText(p.expiresAt, now) }) : null);
    } else if (state.key === 'paired') {
      stateCell = h('span', { class: 'pill is-ok' }, icon('state-ok'), state.label);
    } else if (state.key === 'revoked') {
      stateCell = h('span', { class: 'ag-state' }, h('span', { class: 'pill is-offline is-dashed' }, icon('state-offline'), state.label), h('span', { class: 'ag-detail' }, timeNode(p.revokedAt)));
    } else {
      stateCell = h('span', { class: 'ag-state' }, h('span', { class: 'pill is-offline is-dashed' }, icon('state-offline'), state.label), h('span', { class: 'ag-detail', text: 'Ajoutez le téléphone de nouveau.' }));
    }

    const actions = [];
    if (state.key === 'pending') {
      const qr = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': `Afficher le QR code de ${p.label}`, 'data-key': k('qr') }, icon('grid'), 'Afficher le QR');
      // Rouvre la fenêtre d'appairage SANS créer de nouveau code : l'adresse n'est plus connue, seul le QR est affiché.
      qr.addEventListener('click', () => openPairing({ id: p.id, label: p.label, pairUrl: null, expiresAt: p.expiresAt, originKey: k('qr') }));
      actions.push(qr);
    }
    if (!revoked) {
      const revoke = h('button', { class: 'btn btn-sm btn-danger', type: 'button', 'aria-label': `Révoquer ${p.label}`, 'data-key': k('revoke') }, icon('lock'), 'Révoquer');
      revoke.addEventListener('click', async () => {
        const waiting = state.key !== 'paired';
        const ok = await dialogs.confirm({
          heading: `Révoquer ${p.label}`,
          message: waiting
            ? `${p.label} n’est pas appairé : son code d’appairage est annulé. Un téléphone révoqué ne peut plus être réutilisé : il faudra l’ajouter de nouveau.`
            : `${p.label} sera déconnecté tout de suite, et le service de l’agent connecté dessus est fermé. Un téléphone révoqué ne peut plus être réutilisé : il faut le réappairer.`,
          confirmLabel: 'Révoquer le téléphone',
          onConfirm: () => api(`/api/agent-phones/${encodeURIComponent(p.id)}/revoke`, { method: 'POST' }),
        });
        if (!ok) return;
        toast(`${p.label} est révoqué`, 'ok');
        loadPhones();
      });
      actions.push(revoke);
    }

    return h(
      'tr',
      { class: revoked ? 'is-inactive ag-revoked' : '' },
      h('td', { 'data-label': 'Téléphone', class: 'adm-who' }, h('span', { class: 'adm-who-name' }, h('strong', { class: 'ag-phone-name', text: p.label }))),
      h('td', { 'data-label': 'État' }, stateCell),
      h('td', { 'data-label': 'Appairé le' }, p.pairedAt ? timeNode(p.pairedAt) : h('span', { class: 'faint', text: '—' })),
      h('td', { 'data-label': 'Vu pour la dernière fois' }, p.lastSeenAt ? timeNode(p.lastSeenAt, phoneAgo(p.lastSeenAt, now)) : h('span', { class: 'faint', text: phoneAgo(null) })),
      actions.length
        ? h('td', { class: 'adm-actions-cell' }, h('div', { class: 'actions' }, ...actions))
        : h('td', { class: 'adm-actions-cell ag-no-actions' }, h('span', { class: 'sr-only', text: 'Aucune action : un téléphone révoqué ne peut plus être utilisé.' })),
    );
  }

  // ---------------------------------------------------------------- ajouter un téléphone

  function buildAddForm() {
    const label = h('input', { id: 'ph-add-label', maxlength: String(MAX_PHONE_LABEL), autocomplete: 'off', required: true, placeholder: 'ex. Téléphone du portail', 'data-key': 'ph:add:label' });
    const error = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit', 'data-key': 'ph:add:submit' }, icon('plus'), 'Ajouter et afficher le QR code');
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
          const problem = phoneLabelProblem(label.value);
          if (problem) return markInvalid(label, error, problem);
          const name = label.value.trim();
          busy = true;
          setBusy(submit, true);
          const ep = epoch;
          try {
            const made = await api('/api/agent-phones', { method: 'POST', body: { label: name } });
            if (ep !== epoch) return;
            const id = made && (typeof made.id === 'number' || (typeof made.id === 'string' && made.id !== '')) ? String(made.id) : null;
            if (id === null) throw new Error('Réponse inattendue du PSIM : le téléphone n’a pas pu être préparé');
            label.value = '';
            busy = false;
            setBusy(submit, false);
            submit.focus();
            loadPhones();
            openPairing({ id, label: name, pairUrl: typeof made.pairUrl === 'string' && made.pairUrl ? made.pairUrl : null, expiresAt: isTime(made.expiresAt) ? made.expiresAt : null, originKey: 'ph:add:submit' });
          } catch (err) {
            if (ep === epoch) markInvalid(/nom/i.test(err.message) ? label : null, error, err.message);
          } finally {
            busy = false;
            setBusy(submit, false);
          }
        },
      },
      h('div', { class: 'form-grid adm-grid' }, field(h, 'Nom du téléphone', label, 'Pour le reconnaître dans la liste, par exemple l’endroit où il reste.')),
      error,
      h('div', { class: 'actions' }, submit),
    );
    return {
      el: form,
      focus: () => label.focus(),
      reset() {
        label.value = '';
        clearInvalid(form, error);
        busy = false;
        setBusy(submit, false);
      },
    };
  }

  const addForm = buildAddForm();
  phonesPanel.replaceChildren(
    h(
      'div',
      { class: 'ag-stack' },
      h(
        'section',
        { class: 'panel', 'aria-labelledby': 'ph-list-title' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'ph-list-title', tabindex: '-1' }, icon('phone'), 'Téléphones'), h('div', { class: 'actions ag-refresh' }, phonesUpdated, phonesRefresh)),
        h(
          'div',
          { class: 'panel-body' },
          h('div', { class: 'notice is-info' }, icon('info'), h('span', { text: 'Un téléphone doit être appairé au site avant qu’un agent puisse s’y connecter. Si le téléphone perd la confiance du PSIM (perdu, volé), révoquez-le : il est déconnecté tout de suite.' })),
          phonesBox,
        ),
      ),
      h(
        'section',
        { class: 'panel', 'aria-labelledby': 'ph-add-title' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'ph-add-title' }, icon('plus'), 'Ajouter un téléphone')),
        h('div', { class: 'panel-body' }, addForm.el),
      ),
    ),
  );

  // ---------------------------------------------------------------- fenêtre d'appairage

  /** Appairage en cours (fenêtre ouverte) : minuteurs et élément portant l'adresse d'appairage. Un seul à la fois. */
  let pairing = null;

  function stopPairing() {
    if (!pairing) return;
    clearInterval(pairing.countTimer);
    clearInterval(pairing.pollTimer);
    pairing.urlEl?.replaceChildren(); // le code d'appairage ne reste pas dans la page
    pairing = null;
  }

  /**
   * Ouvre la fenêtre d'appairage d'un téléphone : étape 1 le certificat (une fois par téléphone), étape 2 le QR code
   * d'appairage avec son compte à rebours. Tant qu'elle est ouverte, la liste des téléphones est interrogée toutes les
   * 3 s ; dès que ce téléphone est appairé, la fenêtre l'annonce. `pairUrl` est connue à la création seulement.
   */
  function openPairing({ id, label, pairUrl, expiresAt, originKey }) {
    stopPairing();
    const urlEl = pairUrl ? h('code', { class: 'ag-url adm-mono', text: pairUrl }) : null;
    const session = { id: String(id), urlEl, countTimer: 0, pollTimer: 0 };
    pairing = session;
    const encoded = encodeURIComponent(String(id));

    // Étape 1 : certificat. Sans HTTPS le serveur répond 404 : l'image tombe en erreur et tout le contenu de l'étape
    // (consigne, QR code, lien) cède la place à une phrase : il n'y a rien à installer. L'étape 2 n'est pas bloquée.
    const certBody = h(
      'div',
      { class: 'ag-step-body' },
      h('p', { text: 'Scannez ce QR code avec le téléphone, ouvrez le fichier, nommez-le “PSIM”, validez. À faire une seule fois par téléphone.' }),
      h(
        'div',
        { class: 'ag-media' },
        h('img', {
          class: 'ag-qr',
          src: '/api/agent-cert.svg',
          alt: 'QR code du certificat du PSIM : à scanner avec le téléphone pour télécharger le certificat',
          width: '176',
          height: '176',
          onerror: () => certBody.replaceChildren(h('p', { class: 'notice is-info' }, icon('info'), h('span', { text: 'Le PSIM n’est pas servi en HTTPS : aucun certificat à installer.' }))),
        }),
        h('a', { class: 'btn btn-sm', href: '/api/agent-cert', download: 'psim.crt' }, icon('download'), 'Télécharger le certificat'),
      ),
    );
    const step1 = h('section', { class: 'ag-step', 'aria-labelledby': 'ag-step1' }, h('h3', { id: 'ag-step1', text: 'Étape 1 : installer le certificat' }), certBody);

    // Étape 2 : appairage.
    const pairMedia = h(
      'div',
      { class: 'ag-media' },
      h('img', {
        class: 'ag-qr',
        src: `/api/agent-phones/${encoded}/pair.svg`,
        alt: `QR code d’appairage de ${label} : à scanner avec l’appareil photo du téléphone`,
        width: '176',
        height: '176',
        onerror: () => pairMedia.replaceChildren(h('p', { class: 'notice is-warning' }, icon('state-warning'), h('span', { text: 'Ce QR code n’est plus disponible : le code a expiré ou le téléphone est déjà appairé. Ajoutez le téléphone de nouveau si besoin.' }))),
      }),
    );
    const countdown = h('p', { class: 'ag-countdown' });
    const announce = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' }); // paliers seulement, pas chaque seconde
    const copy = urlEl ? copyButton(h, { label: 'Copier l’adresse', done: 'Adresse copiée', text: () => urlEl.textContent, select: () => urlEl }) : null;
    const urlBlock = urlEl
      ? h('div', { class: 'ag-url-block' }, h('p', { class: 'hint', text: 'Ou ouvrez cette adresse sur le téléphone :' }), urlEl, h('div', { class: 'actions' }, copy))
      : null;
    const step2 = h(
      'section',
      { class: 'ag-step', 'aria-labelledby': 'ag-step2' },
      h('h3', { id: 'ag-step2', text: 'Étape 2 : appairer le téléphone' }),
      h('p', { text: 'Scannez ce QR code avec l’appareil photo du téléphone : l’application de l’agent s’ouvre et le téléphone est appairé. Le code ne sert qu’une fois.' }),
      pairMedia,
      urlBlock,
      countdown,
      announce,
    );

    const closeBtn = h('button', { class: 'btn', type: 'button', text: 'Fermer', onclick: () => dialogs.close() });
    const body = h('div', { class: 'ag-pair' }, h('p', { class: 'dialog-lead', text: 'Deux étapes, sur le téléphone de l’agent.' }), step1, step2);
    const wrap = h('div', { class: 'ag-pair-wrap' }, body, h('div', { class: 'actions dialog-actions' }, closeBtn));

    // Compte à rebours : lisible chaque seconde, annoncé aux paliers seulement.
    let stage = null;
    let expired = false;
    const tick = () => {
      const now = nowFn();
      countdown.textContent = countdownText(expiresAt, now);
      const next = countdownStage(expiresAt, now);
      if (next && next.level !== stage) {
        stage = next.level;
        announce.textContent = next.message;
      }
      if (next?.level === 'expired' && !expired) {
        expired = true;
        // Un QR code expiré ne doit plus inviter à scanner : on le retire, avec l'adresse et sa copie.
        pairMedia.replaceChildren(h('p', { class: 'notice is-warning' }, icon('state-warning'), h('span', { text: 'Code expiré : ajoutez le téléphone de nouveau.' })));
        urlBlock?.remove();
        session.urlEl?.replaceChildren();
        countdown.classList.add('is-expired');
      }
    };
    if (isTime(expiresAt)) {
      tick();
      session.countTimer = setInterval(() => (pairing === session ? tick() : null), 1000);
    }

    // Interrogation : le téléphone a-t-il fini de s'appairer ?
    let polling = false;
    session.pollTimer = setInterval(async () => {
      if (pairing !== session || polling) return;
      if (isTime(expiresAt) && nowFn() > expiresAt + PAIR_POLL_GRACE_MS) {
        clearInterval(session.pollTimer);
        return;
      }
      polling = true;
      try {
        const data = await api('/api/agent-phones');
        if (pairing !== session) return;
        const found = listOf(data, 'phones').map(normalizePhone).find((x) => x && x.id === session.id);
        if (found?.pairedAt && !found.revokedAt) {
          showPaired();
        } else if (found?.revokedAt) {
          stopPairing();
          wrap.replaceChildren(
            h('div', { class: 'notice is-warning', role: 'status' }, icon('state-warning'), h('span', { text: `${label} a été révoqué : il ne peut plus être appairé.` })),
            h('div', { class: 'actions dialog-actions' }, h('button', { class: 'btn', type: 'button', text: 'Fermer', onclick: () => dialogs.close() })),
          );
          loadPhones();
        }
      } catch {
        // Réseau coupé ou session expirée : on réessaie au prochain passage ; la fenêtre reste utilisable.
      } finally {
        polling = false;
      }
    }, PAIR_POLL_MS);

    function showPaired() {
      stopPairing();
      const close = h('button', { class: 'btn btn-primary', type: 'button', 'data-autofocus': '', onclick: () => dialogs.close() }, icon('check'), 'Fermer');
      wrap.replaceChildren(
        h('div', { class: 'ag-paired', role: 'status' }, icon('state-ok'), h('div', {}, h('strong', { text: `${label} est appairé` }), h('p', { text: 'Un agent peut maintenant ouvrir sa session sur ce téléphone, avec son code personnel.' }))),
        h('div', { class: 'actions dialog-actions' }, close),
      );
      close.focus();
      toast(`${label} est appairé`, 'ok');
      loadPhones();
    }

    openOwned(`Appairer ${label}`, wrap, {
      onClose: (silent) => {
        if (pairing === session) stopPairing();
        if (silent) return;
        loadPhones();
        // La liste a pu être reconstruite pendant que la fenêtre était ouverte : le focus retourne à la commande d'origine.
        const origin = originKey ? phonesPanel.querySelector(`[data-key="${CSS.escape(originKey)}"]`) : null;
        if (origin && !origin.disabled) origin.focus({ preventScroll: true });
      },
    });
  }

  // ---------------------------------------------------------------- changement de compte, masquage, remise à zéro

  /** Un autre administrateur sur ce poste : rien du précédent ne doit rester dans les formulaires. */
  function resetIfOtherAccount() {
    const me = getMe()?.username ?? null;
    if (owner === me) return;
    const previous = owner;
    owner = me;
    if (previous !== null) reset();
  }

  /** Arrête les minuteurs (interrogation, rafraîchissements, compte à rebours) et ferme notre fenêtre. */
  function hide() {
    stopAgentsTimer();
    stopPhonesTimer();
    closeOwned();
    stopPairing();
  }

  /** Déconnexion : listes et formulaires vidés, aucune réponse en vol ne sera affichée, aucun code ne reste. */
  function reset() {
    epoch++;
    agentsReq++;
    phonesReq++;
    hide();
    for (const editor of editors.values()) editor.close(false);
    editors.clear();
    agentsLoaded = false;
    phonesLoaded = false;
    agentsUpdated.textContent = '';
    phonesUpdated.textContent = '';
    agentsBox.replaceChildren(h('p', { class: 'muted', text: 'Chargement…' }));
    phonesBox.replaceChildren(h('p', { class: 'muted', text: 'Chargement…' }));
    createForm.reset();
    addForm.reset();
  }

  return { loadAgents, loadPhones, hide, reset };
}
