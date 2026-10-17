/**
 * Écran « Règles » (administrateur) : dire au PSIM de vous prévenir quand quelqu'un est vu par une caméra.
 *
 * Une règle se lit en cinq cases : Qui, Où, Quand, Si, Alors (+ un « repos » avant un nouveau signalement). L'écran
 * montre la liste des règles (une phrase en français, un interrupteur actif / inactif), un formulaire à cinq cases avec
 * la phrase qui se compose en direct, et un essai sur le passé AVANT d'enregistrer (il ne modifie rien).
 *
 * « Qui » : n'importe qui (présence), une personne d'une liste de visages ou un visage inconnu (reconnaissance faciale de
 * l'enregistreur). Une règle visage ne se déclenche qu'à l'apparition d'un visage et reste prudente (avertissement).
 * Une zone « Décrivez la règle en une phrase » (si l'assistant est configuré) REMPLIT le formulaire : elle n'enregistre jamais.
 *
 * Ce fichier n'importe rien : ses fonctions pures (construction de la règle depuis le formulaire, vérification, phrase,
 * formatage des déclenchements d'un essai) se testent sans navigateur. Le serveur (server/rules.ts) reste la référence :
 * mêmes bornes, même formulation de la phrase ; il revérifie tout à l'enregistrement.
 *
 * Règles tenues ici :
 *  - le formulaire est un brouillon : ni un rafraîchissement de la liste, ni un changement d'écran ne le remplacent ;
 *    une modification faite ailleurs sur la même règle est signalée au lieu d'écraser la saisie ;
 *  - une carte de règle est mise à jour sur place (une confirmation ouverte n'est jamais perdue) ;
 *  - un état se dit par une icône ET un mot ; les noms (règles, caméras, zones) passent par textContent.
 */

// ---------------------------------------------------------------- constantes (mêmes bornes que server/rules.ts)

export const MAX_WINDOWS = 14;
export const MAX_MINUTES = 1440;
export const MAX_NAME = 80;
export const MAX_PLACES = 50;
export const DEFAULT_COOLDOWN = 10;
export const TRIAL_DAYS = [1, 3, 7, 14, 30];
export const DEFAULT_TRIAL_DAYS = 7;
/** Identité de visage : mêmes bornes que server/rules.ts. */
export const MAX_FACE_ID = 64;
export const MAX_FACE_NAME = 80;
/** Assistant : phrase d'origine et tours renvoyés au serveur (mêmes bornes que server/rules.ts et server/ruleassist.ts). */
export const MAX_SOURCE_TEXT = 1000;
export const MAX_ASSIST_TURN = 500;
export const MAX_ASSIST_HISTORY = 10;

// Textes autour de la reconnaissance faciale (gravité prudente, aucune liste, durée impossible).
export const RELIABILITY_NOTE = 'recommandé tant que l’essai de fiabilité n’est pas terminé';
export const CAUTION_NOTE = 'une reconnaissance peut se tromper : un humain doit vérifier avant d’agir';
export const NO_LIST_NOTE = 'Aucune liste de visages : ajoutez une caméra à reconnaissance faciale et créez-y une base.';
export const STAYS_FACE_NOTE = 'Pas proposé pour un visage : un visage est vu à un instant, pas pendant une durée.';
// Règle de liste ou de personne enregistrée sans caméra source (ou dont la caméra a disparu) : elle ne se déclenche plus.
export const REVIEW_NOTE = 'Cette règle doit être réenregistrée : choisissez à nouveau la liste.';
export const REVIEW_PERSON_NOTE = 'Cette règle doit être réenregistrée : choisissez à nouveau la caméra qui connaît cette personne.';
export const UNSPECIFIED_CAMERA = '(caméra non précisée)';

const DAY_SHORT = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const DAY_LONG = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // la semaine commence le lundi
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SUGGESTED_WINDOW = () => ({ days: [0, 1, 2, 3, 4, 5, 6], from: '19:00', to: '07:00' });

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
/** Message du serveur en phrase : majuscule au début, point à la fin. */
const sentence = (s) => {
  const t = cap(String(s ?? '').trim());
  return /[.!?…]$/.test(t) ? t : `${t}.`;
};
/** Entier écrit en chiffres (« 5 »), sinon NaN : « 5,5 », « 1e2 », « » et « -3 » ne sont pas des durées. */
const asInt = (v) => {
  const s = String(v ?? '').trim();
  return /^\d{1,6}$/.test(s) ? Number(s) : Number.NaN;
};
const intIn = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

// ---------------------------------------------------------------- le formulaire : état, règle, phrase (fonctions pures)

/** Formulaire d'une règle neuve : rien de choisi pour « Où », le reste a une valeur raisonnable. */
export function defaultForm() {
  return {
    name: '',
    // { type: 'anyone' | 'unknown' } | { type: 'list', cameraId, listId, listName } | { type: 'person', cameraId, personId, personName }
    // `cameraId` : la caméra du PSIM par laquelle la base est lue (les numéros de liste et de personne sont propres à chaque appareil).
    who: { type: 'anyone' },
    whereMode: 'cameras', // 'cameras' | 'zones'
    cameras: [],
    zones: [],
    whenMode: 'always', // 'always' | 'windows' | 'armed'
    windows: [],
    triggerMode: 'appears', // 'appears' | 'stays'
    minutes: '5', // texte saisi : « reste plus de N minutes »
    severity: 'warning', // 'warning' | 'critical'
    cooldown: String(DEFAULT_COOLDOWN), // texte saisi, en minutes
    enabled: true, // seulement à la création
  };
}

const cloneWindows = (windows) => (windows ?? []).map((w) => ({ days: [...w.days], from: w.from, to: w.to }));

// -- Qui : n'importe qui ou une identité de visage

const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u;
/** Texte d'identité comme le serveur le range : NFC, espaces rognés et réduits à un seul. */
const faceText = (v) => String(v ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ');

/** Vrai pour une règle de reconnaissance faciale (liste, personne, visage inconnu). */
export const isFaceWho = (who) => ['list', 'person', 'unknown'].includes(who?.type);

/** Vrai pour une identité numérotée par appareil (liste, personne) : elle porte la caméra par laquelle la base est lue. */
export const isDeviceWho = (who) => who?.type === 'list' || who?.type === 'person';

/** Copie d'un « Qui » (jamais partagée avec le formulaire). Une forme inconnue vaut « n'importe qui ». */
export function cloneWho(who) {
  switch (who?.type) {
    case 'list':
      return { type: 'list', cameraId: String(who.cameraId ?? ''), listId: String(who.listId ?? ''), listName: String(who.listName ?? '') };
    case 'person':
      return { type: 'person', cameraId: String(who.cameraId ?? ''), personId: String(who.personId ?? ''), personName: String(who.personName ?? '') };
    case 'unknown':
      return { type: 'unknown' };
    default:
      return { type: 'anyone' };
  }
}

/** Le « Qui » envoyé au serveur : textes d'identité rangés comme lui (il les normalise de la même façon). */
export function buildWho(who) {
  const w = cloneWho(who);
  // L'identifiant de caméra part tel quel : c'est celui du PSIM, que le serveur compare sans le retoucher.
  if (w.type === 'list') return { type: 'list', cameraId: w.cameraId, listId: faceText(w.listId), listName: faceText(w.listName) };
  if (w.type === 'person') return { type: 'person', cameraId: w.cameraId, personId: faceText(w.personId), personName: faceText(w.personName) };
  return w;
}

/** « Qui » d'une règle à réenregistrer : la liste (ou la caméra de la personne) est à choisir à nouveau, rien d'autre n'est repris. */
export function whoToReview(who) {
  const w = cloneWho(who);
  if (w.type === 'list') return { type: 'list', cameraId: '', listId: '', listName: '' };
  if (w.type === 'person') return { ...w, cameraId: '' };
  return w;
}

/** Message d'une règle à réenregistrer (liste ou personne), ou '' pour les autres. */
export const reviewNote = (who) => (who?.type === 'list' ? REVIEW_NOTE : who?.type === 'person' ? REVIEW_PERSON_NOTE : '');

/**
 * État d'une règle pour la liste : une règle « à revoir » (liste ou personne sans caméra source valable) ne se déclenche pas,
 * même si elle est « activée » en base. { running, review, word, title } ; `running` = ce que l'interrupteur doit montrer.
 */
export function ruleState(rule) {
  if (rule?.needsReview === true) {
    return { running: false, review: true, word: 'À revoir', title: 'À revoir : la règle ne se déclenche pas. Touchez « Modifier » pour la réenregistrer.' };
  }
  if (rule?.enabled) return { running: true, review: false, word: 'Active', title: 'Active : touchez pour la désactiver' };
  return { running: false, review: false, word: 'Inactive', title: 'Inactive : touchez pour la réactiver' };
}

/**
 * Un message du serveur sur une case : « Qui : camera inconnue … » -> la case « Qui », « Ou : aucune camera choisie … » -> la case
 * « Où ». { key, box, text } ; `key` est null pour tout autre message (il reste en bas du formulaire). Le texte perd son préfixe.
 */
export function serverProblem(message) {
  const raw = String(message ?? '').trim();
  const m = /^(Qui|Ou|Où)\s*:\s*([\s\S]+)$/u.exec(raw);
  if (!m) return { key: null, box: '', text: raw ? sentence(raw) : 'Le serveur n’a donné aucune explication.' };
  return m[1] === 'Qui' ? { key: 'who', box: 'Qui', text: sentence(m[2]) } : { key: 'where', box: 'Où', text: sentence(m[2]) };
}

/** « Si » après un changement de « Qui » : pour un visage, « reste plus de N minutes » n'existe pas, on revient à « apparaît ». */
export function triggerForWho(who, triggerMode) {
  const changed = isFaceWho(who) && triggerMode === 'stays';
  return { triggerMode: changed ? 'appears' : triggerMode, changed };
}

/**
 * Gravité après un changement de « Qui ». Elle ne bouge que si l'utilisateur vient de passer de « n'importe qui » à un
 * visage sans avoir touché à la gravité : un signalement (avertissement) plutôt qu'une alarme, tant que l'essai de
 * fiabilité n'est pas terminé. Les règles « n'importe qui » gardent leur gravité.
 */
export function severityForWho({ from, to, severity, touched }) {
  const changed = from === 'anyone' && ['list', 'person', 'unknown'].includes(to) && !touched && severity === 'critical';
  return { severity: changed ? 'warning' : severity, changed };
}

/**
 * Retour à « n'importe qui » : ce que l'écran avait changé tout seul au passage à un visage est remis comme avant
 * (« reste plus de N », gravité), sauf la gravité que l'utilisateur a choisie entre-temps.
 * `autoTrigger` : vrai si « reste plus de N » avait été ramené à « apparaît » ; `autoSeverity` : la gravité d'avant, ou null.
 */
export function restoreForAnyone({ triggerMode, severity, autoTrigger, autoSeverity, touched }) {
  return {
    triggerMode: autoTrigger && triggerMode === 'appears' ? 'stays' : triggerMode,
    severity: autoSeverity && !touched ? autoSeverity : severity,
  };
}

/** Explications des deux gravités, selon qu'il s'agit d'un visage ou non. */
export function severityTexts(face) {
  if (!face) return { warning: 'Une alerte à regarder, moins urgente.', critical: 'Une alarme rouge, la plus urgente : à traiter tout de suite.' };
  return {
    warning: `Un signalement à vérifier par une personne : ${RELIABILITY_NOTE}.`,
    critical: `Une alarme rouge, la plus urgente. Attention, ${CAUTION_NOTE}.`,
  };
}

/** Libellé et explication de « Si … apparaît » selon le « Qui ». */
export function appearsTexts(who) {
  switch (who?.type) {
    case 'unknown':
      return { label: 'Un visage est vu', desc: 'Dès qu’un visage que l’enregistreur ne reconnaît pas est vu.' };
    case 'list':
      return { label: 'Un visage est vu', desc: 'Dès qu’une personne de la liste choisie est reconnue.' };
    case 'person':
      return { label: 'Un visage est vu', desc: 'Dès que cette personne est reconnue.' };
    default:
      return { label: 'Quelqu’un apparaît', desc: 'Dès qu’une personne est vue.' };
  }
}

/**
 * Les caméras du PSIM lues par le même appareil que la liste : `deviceCameraIds` (la caméra représentante `cameraId` comprise).
 * Une ancienne réponse du serveur sans ce champ : la seule caméra représentante.
 */
function deviceCameras(list) {
  const own = list?.cameraId === undefined || list?.cameraId === null ? '' : String(list.cameraId);
  const ids = Array.isArray(list?.deviceCameraIds) ? list.deviceCameraIds.filter((c) => typeof c === 'string' && c !== '') : [];
  if (own !== '' && !ids.includes(own)) ids.push(own);
  return ids;
}

/**
 * LA comparaison entre une liste lue sur un appareil et une règle : même numéro de liste, ET la caméra de la règle est lue par
 * cet appareil (la règle a pu être créée depuis une autre voie du même enregistreur que la caméra représentante). Deux listes
 * de même numéro sur deux appareils ne se confondent donc jamais. `list` : { id, cameraId, deviceCameraIds? } ; `who` : { listId, cameraId }.
 */
export function listMatches(list, who) {
  const cameraId = String(who?.cameraId ?? '');
  const listId = String(who?.listId ?? '');
  if (cameraId === '' || listId === '' || list?.id === undefined || list?.id === null || String(list.id) !== listId) return false;
  return deviceCameras(list).includes(cameraId);
}

/**
 * Entrées du menu des listes de visages. `lists` : [{ id, name, cameraId, cameraName, deviceCameraIds? }] lues sur les enregistreurs
 * (une entrée par appareil et par liste, avec UNE caméra représentante `cameraId`, stable).
 * Les numéros de liste sont propres à chaque appareil : deux appareils peuvent chacun avoir une liste « 1 ». Une entrée est donc
 * le COUPLE (caméra, liste) ; elle n'est jamais confondue avec une autre qui n'a que le même numéro.
 * Dès qu'il y a plusieurs sources (au moins deux caméras différentes, ou deux entrées de même nom), l'étiquette dit d'où vient
 * la liste : « Famille — caméra Portail ». Avec une seule source, c'est le nom seul.
 * `whos` : le choix en cours et la liste enregistrée avec la règle ; une liste qui n'est plus dans la lecture reste proposée
 * (« Liste non retrouvée ») avec son nom enregistré. `cameraName(id)` donne le nom d'une caméra quand la lecture ne le dit pas.
 * Entrée : { key, id, cameraId, deviceCameraIds, cameraName, name, label, note, missing }.
 */
export function listChoices(lists, whos = [], cameraName = (id) => id) {
  const items = [];
  for (const l of Array.isArray(lists) ? lists : []) {
    if (l === null || typeof l !== 'object' || l.id === undefined || l.id === null) continue;
    const cameraId = String(l.cameraId ?? '');
    items.push({ id: String(l.id), cameraId, deviceCameraIds: deviceCameras(l), cameraName: String(l.cameraName || (cameraId ? cameraName(cameraId) : '') || cameraId), name: String(l.name || l.id), note: '', missing: false });
  }
  for (const who of Array.isArray(whos) ? whos : [whos]) {
    if (who?.type !== 'list' || !who.listId || !who.cameraId) continue;
    if (items.some((i) => listMatches(i, who))) continue;
    items.push({ id: who.listId, cameraId: who.cameraId, deviceCameraIds: [who.cameraId], cameraName: String(cameraName(who.cameraId) || who.cameraId), name: who.listName || who.listId, note: 'Liste non retrouvée', missing: true });
  }
  const several = new Set(items.map((i) => i.cameraId)).size > 1 || new Set(items.map((i) => i.name)).size < items.length;
  for (const i of items) i.label = several ? `${i.name} — caméra ${i.cameraName || i.cameraId || 'inconnue'}` : i.name;
  // Même nom sur la même caméra : le numéro de la liste les distingue.
  const labels = items.map((i) => i.label);
  for (const i of items) if (labels.filter((l) => l === i.label).length > 1) i.label = `${i.label} (n° ${i.id})`;
  for (const i of items) i.key = `${i.cameraId}|${i.id}`;
  return items;
}

/** Index de l'entrée choisie dans `items` : l'appareil de la caméra ET l'identifiant de la liste (jamais l'identifiant seul), ou -1. */
export function selectedListIndex(items, who) {
  if (who?.type !== 'list' || !who.listId || !who.cameraId) return -1;
  return items.findIndex((i) => listMatches(i, who));
}

/** Ce que montre la zone des listes : lecture en cours, erreur, aucune liste, ou le menu. `faces` : { status, lists, notes }. */
export function facesView(faces, who, stored = null, cameraName = (id) => id) {
  const items = listChoices(faces.lists ?? [], [who, stored], cameraName);
  const notes = (faces.notes ?? []).filter((n) => typeof n === 'string' && n.trim() !== '');
  if (faces.status === 'loading' || (faces.status === 'idle' && items.length === 0)) return { kind: 'loading', items, notes: [] };
  if (faces.status === 'error') return { kind: 'error', items, notes: [] };
  if (items.length === 0) return { kind: 'empty', items, notes };
  return { kind: 'select', items, notes };
}

/** Caméras proposées pour une personne précise (elle se lit par l'appareil d'une caméra). Une caméra enregistrée qui a disparu reste visible. */
export function personCameraChoices(cameras, current) {
  const items = cameras.map((c) => ({ id: c.id, label: c.zone ? `${c.name || c.id} (${c.zone})` : c.name || c.id, missing: false }));
  if (current && !cameras.some((c) => c.id === current)) items.push({ id: current, label: `${current} (caméra introuvable)`, missing: true });
  return items;
}

/**
 * Formulaire prérempli depuis une règle enregistrée (Modifier). Une règle « à revoir » (`needsReview`) rouvre avec la liste (ou la
 * caméra de la personne) vide : elle est à choisir à nouveau, l'ancien choix ne se déclenchait plus.
 */
export function formFromRule(rule) {
  const s = rule.spec;
  const form = defaultForm();
  form.name = rule.name;
  form.enabled = rule.enabled;
  form.who = rule.needsReview === true ? whoToReview(s.who) : cloneWho(s.who);
  if ('zones' in s.where) {
    form.whereMode = 'zones';
    form.zones = [...s.where.zones];
  } else form.cameras = [...s.where.cameras];
  form.whenMode = s.when.type;
  form.windows = s.when.type === 'windows' ? cloneWindows(s.when.windows) : [];
  form.triggerMode = s.trigger.type;
  if (s.trigger.type === 'stays') form.minutes = String(s.trigger.minutes);
  form.severity = s.then.severity;
  form.cooldown = String(s.cooldownMinutes);
  return form;
}

/**
 * La règle (RuleSpec) décrite par le formulaire. À n'appeler que pour un formulaire sans problème : un nombre mal écrit
 * donne NaN (la phrase et l'essai refusent d'abord de partir d'un formulaire incomplet, voir formProblems).
 */
export function buildSpec(form) {
  const where = form.whereMode === 'zones' ? { zones: [...form.zones] } : { cameras: [...form.cameras] };
  let when;
  if (form.whenMode === 'windows') {
    when = { type: 'windows', windows: form.windows.map((w) => ({ days: [...new Set(w.days)].sort((a, b) => a - b), from: w.from, to: w.to })) };
  } else when = { type: form.whenMode === 'armed' ? 'armed' : 'always' };
  const trigger = form.triggerMode === 'stays' ? { type: 'stays', minutes: asInt(form.minutes) } : { type: 'appears' };
  return { who: buildWho(form.who), where, when, trigger, then: { severity: form.severity === 'critical' ? 'critical' : 'warning' }, cooldownMinutes: asInt(form.cooldown) };
}

/** Forme comparable d'un formulaire : sert à savoir s'il reste des modifications à enregistrer. */
export function formKey(form) {
  return JSON.stringify({ name: form.name.trim(), spec: buildSpec(form), enabled: form.enabled });
}

/** Problème d'une plage horaire, en mots, ou null. Mêmes règles que le serveur (server/arming.ts). */
export function windowProblem(w) {
  if (!w.days.length) return 'Choisissez au moins un jour.';
  if (!TIME.test(w.from) || !TIME.test(w.to)) return "Indiquez l'heure de début et l'heure de fin.";
  if (w.from === w.to) return 'Le début et la fin sont identiques : choisissez deux heures différentes.';
  return null;
}

const minutesOf = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/** Explication d'une plage qui passe minuit, ou ''. Les jours sont ceux du DÉBUT de la plage. */
export function nightNote(w) {
  if (windowProblem(w) || minutesOf(w.to) >= minutesOf(w.from)) return '';
  if (w.to === '00:00') return '';
  return `Plage de nuit : elle commence les jours choisis à ${w.from} et se termine le lendemain à ${w.to}.`;
}

/**
 * Tout ce qui empêche d'enregistrer, dans l'ordre de l'écran : [{ key, message }].
 * key : 'name', 'who', 'where', 'windows', 'window:<n>' (n à partir de 0), 'trigger', 'minutes', 'cooldown'.
 * `ctx` (facultatif) : { cameraIds: Set, zones: Set } pour refuser un choix qui n'existe plus.
 */
export function formProblems(form, ctx = null) {
  const out = [];
  const name = form.name.trim();
  if (!name) out.push({ key: 'name', message: 'Donnez un nom à la règle, pour la retrouver dans la liste.' });
  else if (name.length > MAX_NAME) out.push({ key: 'name', message: `Le nom est trop long : ${MAX_NAME} caractères au plus.` });

  const who = cloneWho(form.who);
  if (who.type === 'list' || who.type === 'person') {
    const [id, label] = who.type === 'list' ? [faceText(who.listId), 'la liste'] : [faceText(who.personId), 'la personne'];
    const shownName = faceText(who.type === 'list' ? who.listName : who.personName);
    if (!id) out.push({ key: 'who', message: who.type === 'list' ? 'Choisissez une liste de visages.' : 'Choisissez une personne.' });
    else if (id.length > MAX_FACE_ID || shownName.length > MAX_FACE_NAME || !shownName) out.push({ key: 'who', message: `Le nom ou l’identifiant de ${label} est invalide (${MAX_FACE_NAME} caractères au plus pour le nom).` });
    else if (FORBIDDEN_CHARS.test(id) || FORBIDDEN_CHARS.test(shownName)) out.push({ key: 'who', message: `Le nom de ${label} contient un caractère invisible : choisissez-la à nouveau.` });
    // La caméra par laquelle la base est lue : les numéros sont propres à chaque appareil, sans elle la règle ne correspond à rien.
    else if (who.cameraId === '') out.push({ key: 'who', message: who.type === 'list' ? 'Choisissez à nouveau la liste : la caméra qui la lit n’est pas précisée.' : 'Choisissez la caméra qui connaît cette personne.' });
    else if (ctx && !ctx.cameraIds.has(who.cameraId)) out.push({ key: 'who', message: who.type === 'list' ? `La caméra de la liste n’existe plus (« ${who.cameraId} ») : choisissez à nouveau la liste.` : `La caméra de la personne n’existe plus (« ${who.cameraId} ») : choisissez-en une autre.` });
  }

  const zones = form.whereMode === 'zones';
  const chosen = zones ? form.zones : form.cameras;
  if (chosen.length === 0) out.push({ key: 'where', message: zones ? 'Choisissez au moins une zone.' : 'Choisissez au moins une caméra.' });
  else if (chosen.length > MAX_PLACES) out.push({ key: 'where', message: `${MAX_PLACES} ${zones ? 'zones' : 'caméras'} au plus : créez une autre règle pour le reste.` });
  else if (ctx) {
    const known = zones ? ctx.zones : ctx.cameraIds;
    const gone = chosen.filter((id) => !known.has(id));
    if (gone.length) out.push({ key: 'where', message: `${zones ? 'Zone' : 'Caméra'} introuvable : ${gone.map((g) => `« ${g} »`).join(', ')}. Décochez-la.` });
  }

  if (form.whenMode === 'windows') {
    if (form.windows.length === 0) out.push({ key: 'windows', message: 'Ajoutez au moins une plage horaire.' });
    else if (form.windows.length > MAX_WINDOWS) out.push({ key: 'windows', message: `${MAX_WINDOWS} plages au plus : regroupez les jours qui ont les mêmes heures.` });
    form.windows.forEach((w, i) => {
      const p = windowProblem(w);
      if (p) out.push({ key: `window:${i}`, message: `Plage ${i + 1} : ${p.charAt(0).toLowerCase()}${p.slice(1)}` });
    });
  }

  if (form.triggerMode === 'stays' && isFaceWho(who)) {
    out.push({ key: 'trigger', message: 'Pour un visage, seul « un visage est vu » est possible : choisissez cette condition.' });
  } else if (form.triggerMode === 'stays' && !intIn(asInt(form.minutes), 1, MAX_MINUTES)) {
    out.push({ key: 'minutes', message: `Indiquez un nombre entier de minutes, entre 1 et ${MAX_MINUTES}.` });
  }
  if (!intIn(asInt(form.cooldown), 0, MAX_MINUTES)) {
    out.push({ key: 'cooldown', message: `Indiquez un nombre entier de minutes, entre 0 et ${MAX_MINUTES} (0 : pas d'attente).` });
  }
  return out;
}

// -- phrase : même formulation que describeRule (server/rules.ts) ; le serveur reste la référence.

const joinAnd = (items) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} et ${items.at(-1)}`);
const joinOr = (items) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ou ${items.at(-1)}`);

/** « du lundi au vendredi », « le samedi et le dimanche », « tous les jours ». Trois jours de suite ou plus : « du … au … ». */
export function describeDays(days) {
  const set = new Set(days);
  if (set.size === 7) return 'tous les jours';
  const parts = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) parts.push(`du ${DAY_LONG[run[0]]} au ${DAY_LONG[run.at(-1)]}`);
    else for (const d of run) parts.push(`le ${DAY_LONG[d]}`);
    run = [];
  };
  for (const d of DAY_ORDER) {
    if (set.has(d)) run.push(d);
    else flush();
  }
  flush();
  return joinAnd(parts);
}

/** 5 -> « 5 min », 60 -> « 1 h », 90 -> « 1 h 30 ». */
export function minutesText(m) {
  if (m < 60) return `${m} min`;
  if (m % 60 === 0) return `${m / 60} h`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

export function windowText(w) {
  return `de ${w.from} à ${w.to}${w.from > w.to ? ' le lendemain' : ''}, ${describeDays(w.days)}`;
}

/** « (caméra « Portail ») » ; sans caméra : « (caméra non précisée) », comme le serveur. */
const faceCameraPhrase = (cameraId, cameraName) => (typeof cameraId === 'string' && cameraId !== '' ? `(caméra « ${cameraName(cameraId)} »)` : UNSPECIFIED_CAMERA);

/** La phrase d'une règle (RuleSpec), comme le serveur l'écrit. `cameraName(id)` donne le nom d'une caméra. */
export function describeSpec(spec, cameraName = (id) => id) {
  const action = spec.then.severity === 'critical' ? 'Prévenir (alerte critique)' : 'Prévenir (avertissement)';
  let cause;
  if (spec.who?.type === 'unknown') cause = 'si un visage inconnu est vu';
  else if (spec.who?.type === 'list') cause = `si une personne de la liste « ${spec.who.listName} » ${faceCameraPhrase(spec.who.cameraId, cameraName)} est reconnue`;
  else if (spec.who?.type === 'person') cause = `si la personne « ${spec.who.personName} » ${faceCameraPhrase(spec.who.cameraId, cameraName)} est reconnue`;
  else cause = spec.trigger.type === 'appears' ? "si quelqu'un apparaît" : `si quelqu'un reste au moins ${minutesText(spec.trigger.minutes)}`;
  let where;
  if ('cameras' in spec.where) {
    const names = spec.where.cameras.map((id) => `« ${cameraName(id)} »`);
    where = names.length === 1 ? `devant la caméra ${names[0]}` : `devant les caméras ${joinOr(names)}`;
  } else {
    const names = spec.where.zones.map((z) => `« ${z} »`);
    where = names.length === 1 ? `dans la zone ${names[0]}` : `dans les zones ${joinOr(names)}`;
  }
  let when;
  if (spec.when.type === 'always') when = 'à toute heure';
  else if (spec.when.type === 'armed') when = 'uniquement quand la zone est armée';
  else when = `uniquement ${spec.when.windows.map(windowText).join(' ou ')}`;
  const rest = spec.cooldownMinutes > 0 ? `ensuite, attendre ${minutesText(spec.cooldownMinutes)} avant de signaler à nouveau` : 'ensuite, signaler à nouveau sans attendre';
  return `${action} ${cause} ${where}, ${when} ; ${rest}.`;
}

/** La phrase en direct sous le formulaire, ou null tant que les cinq cases ne sont pas complètes (le nom n'y compte pas). */
export function liveSentence(form, cameraName = (id) => id) {
  if (formProblems(form).some((p) => p.key !== 'name')) return null;
  return describeSpec(buildSpec(form), cameraName);
}

// ---------------------------------------------------------------- choix de l'écran « Où »

/**
 * Cases à cocher de « Où » : les caméras (nom, zone) ou les zones (nombre de caméras). Un choix enregistré qui n'existe
 * plus reste affiché (coché, « introuvable ») pour pouvoir être décoché.
 * `cameras` : [{ id, name, zone }].
 */
export function placeItems(cameras, form) {
  const byZone = (z) => cameras.filter((c) => c.zone === z).length;
  if (form.whereMode === 'zones') {
    const zones = [...new Set(cameras.map((c) => c.zone).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
    const items = zones.map((z) => ({ id: z, label: z, note: plural(byZone(z), 'caméra'), missing: false }));
    for (const z of form.zones) if (!zones.includes(z)) items.push({ id: z, label: z, note: 'Zone introuvable', missing: true });
    return items;
  }
  const items = cameras.map((c) => ({ id: c.id, label: c.name || c.id, note: c.zone || '', missing: false }));
  for (const id of form.cameras) if (!cameras.some((c) => c.id === id)) items.push({ id, label: id, note: 'Caméra introuvable', missing: true });
  return items;
}

/** Les caméras que regarde une règle (par caméra, ou par zone). */
export function scopeCameras(spec, cameras) {
  if ('cameras' in spec.where) return spec.where.cameras;
  return cameras.filter((c) => spec.where.zones.includes(c.zone)).map((c) => c.id);
}

// ---------------------------------------------------------------- assistant : proposition -> formulaire, échange

const quoted = (items) => items.map((i) => `« ${i} »`).join(', ');

/**
 * Le formulaire que décrit une proposition de l'assistant ({ name, spec, summary }), et ce qui n'a pas pu être repris :
 * { form, issues }. Les cases sont celles du formulaire : une caméra, une zone ou une liste que cet écran ne connaît pas n'est
 * PAS reprise (la case reste à compléter) et `issues` le dit en français. `ctx` : { cameraIds: Set, zones: Set,
 * lists: [{ id, name, cameraId, deviceCameraIds? }] | null } ; une valeur absente (ou lists à null : listes pas encore lues) désactive la vérification.
 * Le choix « activer dès l'enregistrement » n'est jamais celui de l'assistant (à la charge de l'appelant).
 */
export function formFromProposal(proposal, ctx = {}) {
  const spec = proposal?.spec ?? {};
  const issues = [];
  const form = defaultForm();
  form.name = faceText(proposal?.name).slice(0, MAX_NAME);

  form.who = cloneWho(spec.who);
  // Une liste se retrouve par sa caméra ET son numéro : le même numéro sur un autre appareil est une autre liste.
  if (form.who.type === 'list' && form.who.cameraId === '') {
    issues.push(`La proposition ne dit pas de quelle caméra vient la liste « ${form.who.listName} ». Choisissez-la dans la case « Qui ».`);
    form.who = { type: 'list', cameraId: '', listId: '', listName: '' };
  } else if (form.who.type === 'list' && Array.isArray(ctx.lists) && !ctx.lists.some((l) => listMatches(l, form.who))) {
    issues.push(`La liste « ${form.who.listName} » n’existe pas dans les listes lues sur l’enregistreur. Choisissez-la dans la case « Qui ».`);
    form.who = { type: 'list', cameraId: '', listId: '', listName: '' };
  } else if (form.who.type === 'person' && form.who.cameraId === '') {
    issues.push(`La proposition ne dit pas de quelle caméra vient la personne « ${form.who.personName} ». Choisissez la caméra dans la case « Qui ».`);
  }

  const where = spec.where ?? {};
  if (Array.isArray(where.zones)) {
    form.whereMode = 'zones';
    const known = ctx.zones ? where.zones.filter((z) => ctx.zones.has(z)) : [...where.zones];
    const gone = where.zones.filter((z) => !known.includes(z));
    form.zones = known;
    if (gone.length) issues.push(`${gone.length > 1 ? 'Zones inconnues' : 'Zone inconnue'} sur cet écran : ${quoted(gone)}. Choisissez les zones dans la case « Où ».`);
  } else {
    const wanted = Array.isArray(where.cameras) ? where.cameras : [];
    const known = ctx.cameraIds ? wanted.filter((c) => ctx.cameraIds.has(c)) : [...wanted];
    const gone = wanted.filter((c) => !known.includes(c));
    form.cameras = known;
    if (gone.length) issues.push(`${gone.length > 1 ? 'Caméras inconnues' : 'Caméra inconnue'} sur cet écran : ${quoted(gone)}. Choisissez les caméras dans la case « Où ».`);
  }

  const when = spec.when ?? {};
  if (when.type === 'windows') {
    form.whenMode = 'windows';
    form.windows = cloneWindows(when.windows);
  } else form.whenMode = when.type === 'armed' ? 'armed' : 'always';

  const trigger = spec.trigger ?? {};
  form.triggerMode = trigger.type === 'stays' ? 'stays' : 'appears';
  if (trigger.type === 'stays') form.minutes = String(trigger.minutes);
  form.severity = spec.then?.severity === 'critical' ? 'critical' : 'warning';
  form.cooldown = String(spec.cooldownMinutes ?? DEFAULT_COOLDOWN);
  return { form, issues };
}

/** Les derniers tours de l'échange, tels que le serveur les reçoit (borne de longueur et de nombre comme lui). */
export function historyForAssist(turns) {
  return (turns ?? [])
    .filter((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string' && t.text.trim() !== '')
    .slice(-MAX_ASSIST_HISTORY)
    .map((t) => ({ role: t.role, text: t.text.trim().slice(0, MAX_ASSIST_TURN) }));
}

/** La phrase d'origine gardée avec la règle : ce que l'utilisateur a écrit durant l'échange (≤ 1000 caractères). */
export function sourceTextOf(turns) {
  return (turns ?? [])
    .filter((t) => t.role === 'user')
    .map((t) => t.text.trim())
    .filter(Boolean)
    .join(' — ')
    .slice(0, MAX_SOURCE_TEXT);
}

/**
 * Suite d'un échange avec l'assistant : `turns` (tours précédents), `sent` (ce que l'utilisateur vient d'envoyer),
 * `result` (réponse du serveur). Une question prolonge l'échange ; une règle ou un refus le termine.
 * Renvoie { turns, sourceText } (sourceText : seulement pour une règle).
 */
export function nextAssistTurns(turns, sent, result) {
  const user = { role: 'user', text: String(sent ?? '') };
  if (result?.kind === 'question') return { turns: [...(turns ?? []), user, { role: 'assistant', text: String(result.question ?? '') }], sourceText: '' };
  if (result?.kind === 'rule') return { turns: [], sourceText: sourceTextOf([...(turns ?? []), user]) };
  return { turns: [], sourceText: '' };
}

// ---------------------------------------------------------------- essai sur le passé : formatage

const pad2 = (n) => String(n).padStart(2, '0');
/** « 22:10 » (heure locale, 24 h). */
export const clockText = (ts) => `${pad2(new Date(ts).getHours())}:${pad2(new Date(ts).getMinutes())}`;
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const dayNumber = (ts) => {
  const d = new Date(ts);
  return Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000);
};
/** « lundi 12 octobre ». */
export const dayText = (ts) => new Date(ts).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

/** Durée écrite : « moins d'une minute », « 31 min », « 2 h 05 ». */
export function durationText(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "moins d'une minute";
  return minutesText(min);
}

/**
 * Un déclenchement de l'essai, en mots : { day, time, until, duration, ongoing, camera }.
 * until : « jusqu'à 22:41 », « jusqu'à 00:05 le lendemain », « jusqu'au 14 octobre à 06:00 » ou « toujours en cours ».
 */
export function describeTrigger(t, cameraName = (id) => id) {
  const ongoing = t.endedAt === null || t.endedAt === undefined;
  let until = 'toujours en cours';
  let duration = '';
  if (!ongoing) {
    duration = durationText(Math.max(0, t.endedAt - t.at));
    if (sameDay(t.at, t.endedAt)) until = `jusqu'à ${clockText(t.endedAt)}`;
    else if (dayNumber(t.endedAt) - dayNumber(t.at) === 1) until = `jusqu'à ${clockText(t.endedAt)} le lendemain`;
    else until = `jusqu'au ${new Date(t.endedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })} à ${clockText(t.endedAt)}`;
  }
  return { day: dayText(t.at), time: clockText(t.at), until, duration, ongoing, camera: cameraName(t.cameraId) };
}

/** « sur les 7 derniers jours », « sur les dernières 24 heures ». */
export const periodText = (days) => (days === 1 ? 'sur les dernières 24 heures' : `sur les ${days} derniers jours`);

/** Texte du bouton d'essai. */
export const trialButtonText = (days) => (days === 1 ? 'Essayer sur les dernières 24 heures' : `Essayer sur les ${days} derniers jours`);

/** Titre du résultat d'un essai. */
export function trialHeadline(count, days) {
  if (count === 0) return 'Elle ne se serait jamais déclenchée sur cette période.';
  return `Cette règle aurait déclenché ${count} fois ${periodText(days)}.`;
}

export const ARMED_NOTE = "L'armement des zones d'autrefois n'est pas conservé : l'essai utilise l'armement d'aujourd'hui pour toute la période.";

// ---------------------------------------------------------------- l'écran

export function createRulesView({ api, h, icon, toast, getMe, getDevices = () => [], dialogs }) {
  const section = document.getElementById('rules-card');
  const list = document.getElementById('rules-list');
  const loading = document.getElementById('rules-loading');
  const errorBox = document.getElementById('rules-error');
  const deniedBox = document.getElementById('rules-denied');
  const intro = document.getElementById('rules-intro');
  const emptyBox = document.getElementById('rules-empty');
  const formSlot = document.getElementById('rules-form-slot');
  const countEl = document.getElementById('rules-count');
  const newButtons = [document.getElementById('rules-new'), document.getElementById('rules-empty-new')];

  let rules = [];
  let presence = {}; // { [cameraId]: { since } }
  let loaded = false;
  let loadSeq = 0;
  let timer = 0;
  let shownFor = null;
  let seq = 0;
  const cards = new Map(); // id -> carte, gardée d'un rendu à l'autre
  // Listes de visages lues sur les caméras (en mémoire pour la session de l'écran) et état de l'assistant (null : pas encore su).
  const freshFaces = () => ({ status: 'idle', lists: [], notes: [], hosts: 0, error: '', at: 0 });
  const FACES_FRESH_MS = 5 * 60_000;
  let faces = freshFaces();
  let facesSeq = 0;
  let facesPending = null;
  let assistConfigured = null;
  let assistProbing = false;

  const isAdmin = () => getMe()?.role === 'admin';
  /**
   * Focus après une fenêtre de confirmation : tant qu'elle se referme, le reste de la page est encore inerte (app.js) et
   * le focus tomberait dans le vide. On réessaie une fois la fenêtre refermée.
   */
  const focusSoon = (el) => {
    el?.focus();
    if (el && document.activeElement !== el) setTimeout(() => el.isConnected && el.focus(), 0);
  };
  const cameras = () => getDevices();
  const cameraName = (id) => cameras().find((c) => c.id === id)?.name || id;
  const ctx = () => ({ cameraIds: new Set(cameras().map((c) => c.id)), zones: new Set(cameras().map((c) => c.zone).filter(Boolean)) });
  const dateText = (ts) => `${new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })} à ${clockText(ts)}`;
  const busy = (button, on) => {
    button.classList.toggle('is-busy', on);
    button.toggleAttribute('aria-busy', on);
    button.disabled = on;
  };

  // ------------------------------------------------------------ chargement

  async function load() {
    const n = ++loadSeq; // des rafraîchissements rapprochés : seule la dernière réponse compte
    let data;
    let now = null;
    try {
      [data, now] = await Promise.all([api('/api/rules'), api('/api/presence').catch(() => null)]);
    } catch (err) {
      if (n === loadSeq) showLoadError(err);
      return;
    }
    if (n !== loadSeq) return;
    rules = data;
    if (now) presence = now;
    loaded = true;
    errorBox.hidden = true;
    render();
    form.sync();
    form.showPresence();
  }

  function showLoadError(err) {
    loading.hidden = true;
    const retry = h('button', { class: 'btn btn-sm', type: 'button' }, icon('refresh'), 'Réessayer');
    retry.addEventListener('click', async () => {
      busy(retry, true);
      await load();
      busy(retry, false);
      if (!errorBox.hidden) errorBox.querySelector('button')?.focus();
      else document.getElementById('rules-title')?.focus();
    });
    errorBox.replaceChildren(
      icon('state-alarm'),
      h(
        'div',
        { class: 'rl-error-text' },
        h('p', {}, h('strong', { text: 'Les règles n’ont pas pu être lues. ' }), sentence(err.message)),
        h('p', { text: loaded ? 'La liste ci-dessous montre les dernières règles connues.' : 'Vérifiez que le PSIM est joignable, puis réessayez.' }),
        retry,
      ),
    );
    errorBox.hidden = false;
  }

  // ------------------------------------------------------------ liste

  function render() {
    loading.hidden = true;
    const admin = isAdmin();
    deniedBox.hidden = admin;
    intro.hidden = !admin;
    section.hidden = !admin;
    if (!admin) {
      formSlot.hidden = true;
      return;
    }
    emptyBox.hidden = rules.length > 0;
    list.hidden = rules.length === 0;
    const running = rules.filter((r) => ruleState(r).running).length;
    const review = rules.filter((r) => ruleState(r).review).length;
    countEl.textContent = rules.length ? `${plural(rules.length, 'règle')}, dont ${running} active${running > 1 ? 's' : ''}${review ? ` et ${review} à revoir` : ''}` : '';
    newButtons[0].hidden = rules.length === 0; // l'état vide a son propre bouton
    const order = [];
    const seen = new Set();
    for (const rule of rules) {
      let card = cards.get(rule.id);
      if (!card) {
        card = createCard(rule.id);
        cards.set(rule.id, card);
      }
      card.update(rule);
      seen.add(rule.id);
      order.push(card.el);
    }
    for (const id of [...cards.keys()]) if (!seen.has(id)) cards.delete(id);
    // On ne déplace les cartes que si leur ordre a changé : un élément déplacé perd le focus.
    const current = [...list.children];
    if (current.length !== order.length || current.some((el, i) => el !== order[i])) list.replaceChildren(...order);
  }

  /** Remplace (ou ajoute) une règle par celle renvoyée par le serveur, sans attendre le prochain rafraîchissement. */
  function upsert(rule) {
    const i = rules.findIndex((r) => r.id === rule.id);
    if (i >= 0) rules = rules.map((r) => (r.id === rule.id ? rule : r));
    else rules = [...rules, rule];
    render();
    form.sync();
  }

  function createCard(id) {
    const c = { id, rule: null, busy: false };
    const uid = `rl-card-${++seq}`;
    const nameEl = h('h3', { class: 'rl-name', id: `${uid}-name`, tabindex: '-1' });
    const phrase = h('p', { class: 'rl-phrase' });
    const meta = h('p', { class: 'hint rl-meta' });
    const live = h('p', { class: 'rl-live', hidden: true });
    const editingTag = h('span', { class: 'tag is-info', hidden: true }, icon('pencil', 'icon-sm'), 'En cours de modification');
    // Règle de liste ou de personne à réenregistrer : elle ne se déclenche pas, on le dit en mots (pas seulement par une couleur).
    const reviewTag = h('span', { class: 'tag is-warning', hidden: true }, icon('state-warning', 'icon-sm'), 'À revoir');
    const reviewText = h('p');
    const reviewBox = h('div', { class: 'notice is-warning', role: 'status', hidden: true }, icon('state-warning'), reviewText);

    const toggle = h('input', { type: 'checkbox', role: 'switch', class: 'rl-switch-input', 'aria-describedby': `${uid}-state` });
    const stateIcon = h('span', { class: 'rl-switch-icon' });
    const stateWord = h('span', { class: 'rl-switch-word', id: `${uid}-state` });
    const toggleLabel = h('label', { class: 'rl-switch' }, toggle, h('span', { class: 'rl-switch-track', 'aria-hidden': 'true' }, h('i')), stateIcon, stateWord);

    const edit = h('button', { class: 'btn btn-sm', type: 'button' }, icon('pencil'), 'Modifier');
    const remove = h('button', { class: 'btn btn-sm btn-danger', type: 'button' }, icon('trash'), 'Supprimer');
    const actionError = h('p', { class: 'form-error', role: 'alert' });

    const confirmText = h('p', { id: `${uid}-confirm-text` });
    const confirmActions = h('div', { class: 'actions' });
    const confirm = h(
      'div',
      { class: 'notice is-warning rl-confirm', role: 'group', tabindex: '-1', 'aria-labelledby': `${uid}-confirm-text`, hidden: true },
      icon('state-warning'),
      h('div', { class: 'rl-confirm-body' }, confirmText, confirmActions),
    );

    c.el = h(
      'li',
      { class: 'panel rl-rule' },
      h('div', { class: 'rl-rule-head' }, nameEl, reviewTag, editingTag, toggleLabel),
      phrase,
      reviewBox,
      live,
      meta,
      h('div', { class: 'actions rl-rule-actions' }, edit, remove),
      actionError,
      confirm,
    );

    function closeConfirm(focus) {
      confirm.hidden = true;
      if (focus) remove.focus();
    }

    function askDelete() {
      const r = c.rule;
      confirmText.textContent = `Supprimer la règle « ${r.name} » ? Elle disparaît de la liste et ne préviendra plus personne. Cette action est définitive.`;
      const keep = h('button', { class: 'btn', type: 'button', text: 'Garder la règle' });
      const yes = h('button', { class: 'btn btn-danger', type: 'button' }, icon('trash'), 'Oui, supprimer la règle');
      keep.addEventListener('click', () => closeConfirm(true));
      yes.addEventListener('click', () => doDelete(yes));
      confirmActions.replaceChildren(keep, yes);
      confirm.hidden = false;
      keep.focus();
    }

    /** La règle a déjà déclenché des alertes : le serveur refuse de la supprimer. On le dit, et on propose de la désactiver. */
    function cannotDelete() {
      const r = c.rule;
      confirmText.textContent = r.enabled
        ? `La règle « ${r.name} » ne peut pas être supprimée : elle a déjà déclenché des alertes, qui restent dans l’historique. Vous pouvez la désactiver : elle ne préviendra plus personne.`
        : `La règle « ${r.name} » ne peut pas être supprimée : elle a déjà déclenché des alertes, qui restent dans l’historique. Elle est déjà désactivée : elle ne préviendra plus personne.`;
      const close = h('button', { class: 'btn', type: 'button', text: 'Fermer' });
      close.addEventListener('click', () => closeConfirm(true));
      const items = [close];
      if (r.enabled) {
        const off = h('button', { class: 'btn btn-primary', type: 'button' }, icon('lock'), 'Désactiver la règle');
        off.addEventListener('click', async () => {
          busy(off, true);
          const ok = await setEnabled(false);
          busy(off, false);
          if (ok) {
            closeConfirm(false);
            toggle.focus();
          } else off.focus();
        });
        items.unshift(off);
      }
      confirmActions.replaceChildren(...items);
      confirm.focus();
    }

    async function doDelete(yes) {
      if (c.busy) return;
      c.busy = true;
      busy(yes, true);
      try {
        await api(`/api/rules/${c.id}`, { method: 'DELETE' });
        const name = c.rule.name;
        rules = rules.filter((r) => r.id !== c.id);
        render();
        form.sync();
        toast(`Règle « ${name} » supprimée`, 'ok');
        (rules.length ? list.querySelector('.rl-name') : newButtons[1])?.focus();
      } catch (err) {
        c.busy = false;
        busy(yes, false);
        // Le serveur refuse quand la règle a déjà déclenché des incidents (409) : « … la désactiver plutôt que la supprimer ».
        if (/d[ée]sactiv/i.test(err.message)) cannotDelete();
        else {
          actionError.textContent = `La règle n’a pas été supprimée : ${sentence(err.message)}`;
          yes.focus();
        }
        return;
      }
      c.busy = false;
    }

    /** Active ou désactive la règle. Renvoie vrai si le serveur l'a pris en compte. */
    async function setEnabled(on) {
      if (c.busy) return false;
      c.busy = true;
      actionError.textContent = '';
      toggle.disabled = true;
      try {
        const next = await api(`/api/rules/${c.id}`, { method: 'PUT', body: { enabled: on } });
        c.busy = false;
        toggle.disabled = ruleState(next).review;
        upsert(next);
        toast(on ? `Règle « ${next.name} » activée` : `Règle « ${next.name} » désactivée`, 'ok');
        return true;
      } catch (err) {
        c.busy = false;
        toggle.disabled = ruleState(c.rule).review;
        toggle.checked = ruleState(c.rule).running; // l'interrupteur dit ce que fait vraiment la règle
        actionError.textContent = `Le changement n’a pas été pris en compte : ${sentence(err.message)}`;
        toggle.focus();
        return false;
      }
    }

    toggle.addEventListener('change', () => setEnabled(toggle.checked));
    edit.addEventListener('click', () => requestOpen(c.rule, edit));
    remove.addEventListener('click', askDelete);

    c.update = (rule) => {
      c.rule = rule;
      nameEl.textContent = rule.name;
      phrase.textContent = rule.summary;
      // Une règle à revoir n'est jamais montrée « active » (elle ne se déclenche pas) et son interrupteur est verrouillé : le
      // serveur refuserait de l'activer tant qu'elle n'est pas réenregistrée (« Modifier »).
      const state = ruleState(rule);
      c.el.classList.toggle('is-inactive', !state.running);
      if (!c.busy) {
        toggle.checked = state.running;
        toggle.disabled = state.review;
      }
      stateIcon.replaceChildren(icon(state.review ? 'state-warning' : state.running ? 'state-ok' : 'state-offline'));
      stateWord.textContent = state.word;
      toggleLabel.setAttribute('title', state.title);
      reviewTag.hidden = !state.review;
      reviewBox.hidden = !state.review;
      reviewText.textContent = state.review ? `${reviewNote(rule.spec?.who) || REVIEW_NOTE} Elle ne se déclenche pas tant que ce n’est pas fait : touchez « Modifier ».` : '';
      toggle.setAttribute('aria-label', `Règle « ${rule.name} »`);
      const created = `Créée par ${rule.createdBy} le ${dateText(rule.createdAt)}`;
      meta.textContent = rule.updatedAt > rule.createdAt + 1000 ? `${created}. Modifiée par ${rule.updatedBy} le ${dateText(rule.updatedAt)}.` : `${created}.`;
      edit.setAttribute('aria-label', `Modifier la règle « ${rule.name} »`);
      remove.setAttribute('aria-label', `Supprimer la règle « ${rule.name} »`);
      c.showPresence();
      editingTag.hidden = !(form.isOpen() && form.editingId() === rule.id);
    };
    c.showPresence = () => {
      const rule = c.rule;
      if (!rule) return;
      const ids = scopeCameras(rule.spec, cameras()).filter((id) => presence[id]);
      live.hidden = !ruleState(rule).running || ids.length === 0;
      if (live.hidden) return;
      const since = Math.min(...ids.map((id) => presence[id].since));
      live.replaceChildren(icon('user', 'icon-sm'), `Quelqu’un est vu en ce moment (depuis ${clockText(since)}).`);
    };
    c.markEditing = (on) => {
      editingTag.hidden = !on;
    };
    c.focusName = () => nameEl.focus();
    return c;
  }

  // ------------------------------------------------------------ ouverture du formulaire (avec le brouillon en cours)

  async function requestOpen(rule, opener) {
    if (form.isOpen() && form.isDirty()) {
      if (form.editingId() === (rule?.id ?? null)) {
        form.focus();
        return;
      }
      const ok = await dialogs.confirm({
        heading: 'Abandonner la saisie en cours ?',
        message: 'Une règle est en cours de saisie et n’est pas enregistrée. Si vous continuez, ce que vous avez saisi sera perdu.',
        confirmLabel: 'Abandonner la saisie',
        danger: false,
      });
      if (!ok) {
        form.focus();
        return;
      }
    }
    form.open(rule, opener);
  }

  for (const b of newButtons) b?.addEventListener('click', () => requestOpen(null, b));

  // ------------------------------------------------------------ formulaire « cinq cases »

  function buildForm() {
    const id = `rl-f${++seq}`;
    let state = defaultForm();
    let editing = null; // { id, updatedAt } de la règle ouverte, ou null (création)
    let baseKey = '';
    let open = false;
    let opener = null;
    let saving = false;
    let showErrors = false; // après un premier refus, les messages suivent la saisie
    let placesKey = '';
    let trialSeq = 0;
    let trialStale = false;
    const liveTags = new Map(); // caméra -> étiquette « vu en ce moment »
    // « Qui » : la liste et la personne d'avant restent disponibles quand on change de choix (rien ne se perd en tâtonnant).
    let lastList = null;
    let storedList = null; // la liste enregistrée avec la règle ouverte (ou reprise d'une proposition)
    let keptPerson = null;
    let reviewWho = false; // la règle ouverte est « à revoir » : sa liste (ou la caméra de sa personne) est à choisir à nouveau
    let severityTouched = false; // la gravité a été choisie à la main (ou par une proposition de l'assistant)
    let autoTrigger = false; // « reste plus de N » ramené à « apparaît » par le passage à un visage (à remettre au retour)
    let autoSeverity = null; // gravité d'avant le passage automatique à « avertissement »
    // Assistant : tours de l'échange, phrase d'origine à transmettre à la création, dernière saisie remplie par une proposition.
    let assistTurns = [];
    let assistBusy = false;
    let assistSeq = 0;
    let proposalSource = null;
    let appliedKey = null;

    const field = (label, input, hint, err) => {
      const hintEl = hint ? h('span', { class: 'hint', id: `${input.id}-hint`, text: hint }) : null;
      input.setAttribute('aria-describedby', [hintEl?.id, err?.id].filter(Boolean).join(' '));
      return h('div', { class: 'field' }, h('label', { for: input.id, text: label }), input, hintEl, err);
    };

    /** Choix (radio) avec son libellé, et si besoin une explication. */
    const choice = (group, value, label, { desc = null, glyph = null } = {}) => {
      const input = h('input', { type: 'radio', name: group, value });
      const name = h('span', { class: 'rl-choice-name', text: label });
      const hint = desc ? h('span', { class: 'hint', text: desc }) : null;
      const el = h('label', { class: 'rl-choice' }, input, h('span', { class: 'rl-choice-text' }, h('span', { class: 'rl-choice-label' }, glyph ? icon(glyph) : null, name), hint));
      return { el, input, name, hint };
    };

    // -- titre, avertissements
    const title = h('h2', { id: `${id}-title`, tabindex: '-1' });
    const dirtyTag = h('span', { class: 'tag is-warning is-dashed', hidden: true }, icon('pencil', 'icon-sm'), 'Modifications non enregistrées');
    const conflictText = h('p');
    const conflictNote = h('div', { class: 'notice is-warning', role: 'status', hidden: true }, icon('state-warning'), conflictText);

    // -- nom
    const nameErr = h('p', { class: 'form-error', id: `${id}-name-err` });
    const nameInput = h('input', { id: `${id}-name`, maxlength: String(MAX_NAME), autocomplete: 'off', required: true, placeholder: 'ex. Cour de nuit' });
    const nameField = field('Nom de la règle', nameInput, 'Pour la retrouver dans la liste et dans le journal.', nameErr);

    // -- Assistant : « Décrivez la règle en une phrase » (zone affichée seulement si l'assistant est configuré)
    const assistText = h('textarea', { id: `${id}-assist`, rows: '3', maxlength: String(MAX_SOURCE_TEXT), placeholder: 'ex. Me prévenir si un visage inconnu est vu devant le portail la nuit', 'aria-describedby': `${id}-assist-count ${id}-assist-hint` });
    const assistCount = h('span', { class: 'hint rl-assist-count', id: `${id}-assist-count`, text: `0 / ${MAX_SOURCE_TEXT}` });
    const assistSend = h('button', { class: 'btn btn-primary', type: 'button' }, icon('rules'), 'Proposer une règle');
    const assistError = h('p', { class: 'form-error', role: 'alert' });
    const assistQuestionText = h('p', { class: 'rl-assist-question', id: `${id}-assist-q`, tabindex: '-1' });
    const assistAnswer = h('input', { id: `${id}-assist-a`, maxlength: String(MAX_ASSIST_TURN), autocomplete: 'off', 'aria-describedby': `${id}-assist-q`, placeholder: 'Votre réponse' });
    const assistReply = h('button', { class: 'btn btn-primary', type: 'button', text: 'Répondre' });
    const assistAsk = h(
      'div',
      { class: 'notice is-info rl-assist-ask', role: 'group', 'aria-label': 'Question de l’assistant', hidden: true },
      icon('chat'),
      h('div', { class: 'rl-assist-ask-body' }, assistQuestionText, h('div', { class: 'field' }, h('label', { for: assistAnswer.id, text: 'Votre réponse' }), h('div', { class: 'rl-assist-reply' }, assistAnswer, assistReply))),
    );
    const assistRefusedText = h('p');
    const assistRefused = h('div', { class: 'notice is-warning', role: 'status', hidden: true }, icon('state-warning'), assistRefusedText);
    const assistProposalIssues = h('ul', { class: 'rl-assist-issues' });
    const assistProposalSummary = h('p', { class: 'rl-assist-summary' });
    const assistProposal = h(
      'div',
      { class: 'notice is-info rl-assist-proposal', role: 'status', tabindex: '-1', hidden: true },
      icon('info'),
      h('div', { class: 'rl-assist-proposal-body' }, h('p', {}, h('strong', { text: 'Proposition de l’assistant : relisez chaque case, puis enregistrez.' })), assistProposalSummary, assistProposalIssues),
    );
    const assistBox = h(
      'section',
      { class: 'rl-assist', 'aria-labelledby': `${id}-assist-title`, hidden: true },
      h('h3', { id: `${id}-assist-title` }, icon('rules'), h('label', { for: assistText.id, text: 'Décrivez la règle en une phrase' })),
      assistText,
      h('p', { class: 'hint', id: `${id}-assist-hint`, text: 'L’assistant propose une règle, il ne l’enregistre jamais : vous relisez chaque case, puis vous enregistrez. Votre phrase et les noms de vos caméras, zones et listes de visages sont envoyés à un service d’intelligence artificielle ; aucune image n’est envoyée.' }),
      h('div', { class: 'rl-assist-row' }, assistSend, assistCount),
      assistError,
      assistAsk,
      assistRefused,
      assistProposal,
    );

    // -- Qui
    const whoGroup = `${id}-who`;
    const whoAnyone = choice(whoGroup, 'anyone', 'N’importe qui', { desc: 'Toute personne vue par la caméra, reconnue ou non.' });
    const whoList = choice(whoGroup, 'list', 'Une personne de la liste…', { desc: 'Une personne dont le visage est enregistré dans une liste de l’enregistreur.' });
    const whoUnknown = choice(whoGroup, 'unknown', 'Un visage inconnu', { desc: 'Un visage que l’enregistreur ne reconnaît pas.' });
    const whoPerson = choice(whoGroup, 'person', 'Une personne précise', { desc: 'Cette règle vise une personne précise. Elle s’affiche telle qu’elle a été enregistrée ; elle ne se choisit pas depuis cet écran.' });
    whoPerson.el.hidden = true;
    whoAnyone.input.checked = true;
    const whoErr = h('p', { class: 'form-error', id: `${id}-who-err` });
    // La liste de visages : menu, lecture en cours, erreur avec « Réessayer », ou « aucune liste ».
    const facesSelect = h('select', { id: `${id}-faces`, 'aria-describedby': whoErr.id });
    const facesLoading = h('p', { class: 'hint rl-faces-status', role: 'status', hidden: true, text: 'Lecture des listes de visages sur les caméras…' });
    const facesFailText = h('p');
    const facesRetry = h('button', { class: 'btn btn-sm', type: 'button' }, icon('refresh'), 'Réessayer');
    const facesFail = h('div', { class: 'notice is-warning', role: 'alert', hidden: true }, icon('state-warning'), h('div', { class: 'rl-faces-fail-body' }, facesFailText, facesRetry));
    const facesEmpty = h('div', { class: 'notice is-warning', hidden: true }, icon('state-warning'), h('p', { text: NO_LIST_NOTE }));
    const facesNotes = h('ul', { class: 'hint rl-faces-notes', hidden: true });
    const facesReload = h('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, icon('refresh'), 'Relire les listes');
    const facesField = h('div', { class: 'field rl-faces-field' }, h('label', { for: facesSelect.id, text: 'Liste de visages' }), facesSelect);
    const facesBox = h('div', { class: 'rl-faces', hidden: true }, facesField, facesLoading, facesFail, facesEmpty, facesNotes, facesReload);
    const whoCaution = h('p', { class: 'hint rl-who-caution', hidden: true, text: 'Un visage reconnu est une présomption, pas une preuve : un humain doit vérifier avant d’agir.' });
    // Règle « à revoir » : tant que la liste n'est pas rechoisie, le même message que sur la carte de la règle.
    const whoReviewText = h('p');
    const whoReview = h('div', { class: 'notice is-warning', role: 'status', hidden: true }, icon('state-warning'), whoReviewText);
    // Personne précise : ses numéros sont ceux d'un appareil, on garde donc la caméra par laquelle on la lit (à choisir si elle manque).
    const personSelect = h('select', { id: `${id}-person-camera`, 'aria-describedby': `${id}-person-camera-hint ${whoErr.id}` });
    const personField = h(
      'div',
      { class: 'field rl-faces-field' },
      h('label', { for: personSelect.id, text: 'Caméra qui connaît cette personne' }),
      personSelect,
      h('span', { class: 'hint', id: `${id}-person-camera-hint`, text: 'Les personnes sont numérotées par enregistreur : indiquez une caméra branchée sur celui où cette personne est enregistrée.' }),
    );
    const personBox = h('div', { class: 'rl-faces', hidden: true }, personField);
    const whoBox = box('who', 'Qui', 'Qui est concerné ?', h('div', { class: 'rl-choices is-column' }, whoAnyone.el, whoList.el, whoUnknown.el, whoPerson.el), whoReview, facesBox, personBox, whoCaution, whoErr);

    // -- Où
    const whereGroup = `${id}-where`;
    const whereCams = choice(whereGroup, 'cameras', 'Des caméras');
    const whereZones = choice(whereGroup, 'zones', 'Des zones');
    const picks = h('div', { class: 'rl-picks', role: 'group', 'aria-label': 'Choix à cocher' });
    const pickAll = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'Tout choisir' });
    const pickNone = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'Ne rien choisir' });
    const pickActions = h('div', { class: 'actions rl-pick-actions' }, pickAll, pickNone);
    const whereErr = h('p', { class: 'form-error', id: `${id}-where-err` });
    const whereBox = box('where', 'Où', 'Où quelqu’un doit-il être vu ?', h('div', { class: 'rl-choices' }, whereCams.el, whereZones.el), picks, pickActions, whereErr);

    // -- Quand
    const whenGroup = `${id}-when`;
    const whenAlways = choice(whenGroup, 'always', 'À toute heure');
    const whenWindows = choice(whenGroup, 'windows', 'Certaines heures', { desc: 'Par exemple la nuit, ou le week-end.' });
    const whenArmed = choice(whenGroup, 'armed', 'Quand la zone est armée', { desc: 'Seulement quand la zone de la caméra est armée (écran Armement).' });
    const slots = h('ol', { class: 'rl-slots' });
    const addWindow = h('button', { class: 'btn btn-sm', type: 'button' }, icon('plus'), 'Ajouter une plage');
    const addHint = h('p', { class: 'hint', hidden: true, text: `${MAX_WINDOWS} plages au plus : regroupez les jours qui ont les mêmes heures.` });
    const windowsErr = h('p', { class: 'form-error', id: `${id}-windows-err` });
    const windowsBox = h(
      'div',
      { class: 'rl-windows', hidden: true },
      h('p', { class: 'hint', text: 'La règle ne marche que pendant ces plages (heure du serveur). Une plage commence les jours choisis : une plage de nuit (19:00 à 07:00) se termine le lendemain matin.' }),
      slots,
      h('div', { class: 'rl-add' }, addWindow, addHint),
      windowsErr,
    );
    const whenBox = box('when', 'Quand', 'À quel moment la règle marche-t-elle ?', h('div', { class: 'rl-choices is-column' }, whenAlways.el, whenWindows.el, whenArmed.el), windowsBox);

    // -- Si
    const ifGroup = `${id}-if`;
    const ifAppears = choice(ifGroup, 'appears', 'Quelqu’un apparaît', { desc: 'Dès qu’une personne est vue.' });
    const minutesErr = h('p', { class: 'form-error', id: `${id}-minutes-err` });
    const minutesInput = h('input', { id: `${id}-minutes`, type: 'number', inputmode: 'numeric', min: '1', max: String(MAX_MINUTES), step: '1', class: 'rl-num', 'aria-label': 'Nombre de minutes', 'aria-describedby': minutesErr.id });
    const ifStaysInput = h('input', { type: 'radio', name: ifGroup, value: 'stays' });
    const STAYS_HINT = 'Seulement si la personne est encore là après ce délai. Une absence de moins d’une minute ne compte pas.';
    const staysHint = h('span', { class: 'hint', text: STAYS_HINT });
    const ifStays = {
      input: ifStaysInput,
      el: h('label', { class: 'rl-choice' }, ifStaysInput, h('span', { class: 'rl-choice-text' }, h('span', { class: 'rl-choice-label rl-inline' }, 'Quelqu’un reste plus de', h('span', { class: 'rl-num-wrap' }, minutesInput), 'minutes'), staysHint)),
    };
    const ifNote = h('p', { class: 'hint rl-change-note', role: 'status' });
    const ifBox = box('if', 'Si', 'Quelle condition ?', h('div', { class: 'rl-choices is-column' }, ifAppears.el, ifStays.el), ifNote, minutesErr);

    // -- Alors
    const thenGroup = `${id}-then`;
    const thenWarn = choice(thenGroup, 'warning', 'Avertissement', { glyph: 'state-warning', desc: 'Une alerte à regarder, moins urgente.' });
    const thenCrit = choice(thenGroup, 'critical', 'Alerte critique', { glyph: 'state-alarm', desc: 'Une alarme rouge, la plus urgente : à traiter tout de suite.' });
    const thenNote = h('p', { class: 'hint rl-change-note', role: 'status' });
    const thenBox = box('then', 'Alors', 'Que fait le PSIM ?', h('div', { class: 'rl-choices is-column' }, thenWarn.el, thenCrit.el), thenNote);

    // -- repos
    const cooldownErr = h('p', { class: 'form-error', id: `${id}-cooldown-err` });
    const cooldownInput = h('input', { id: `${id}-cooldown`, type: 'number', inputmode: 'numeric', min: '0', max: String(MAX_MINUTES), step: '1', class: 'rl-num' });
    const cooldownField = field('Repos, en minutes', cooldownInput, 'Après un signalement, la règle attend ce délai avant d’en faire un nouveau. 0 : elle n’attend pas.', cooldownErr);
    cooldownField.classList.add('rl-cooldown');

    function box(key, word, lead, ...children) {
      return h('fieldset', { class: `rl-box rl-box-${key}` }, h('legend', {}, h('span', { class: 'rl-box-word', text: word }), h('span', { class: 'rl-box-lead', text: lead })), ...children);
    }

    // -- phrase en direct
    const sentenceText = h('p', { class: 'rl-sentence-text' });
    const sentenceBox = h(
      'section',
      { class: 'rl-sentence', 'aria-labelledby': `${id}-sentence-title` },
      h('h3', { id: `${id}-sentence-title`, text: 'Ce que fera cette règle' }),
      sentenceText,
    );

    // -- essai sur le passé
    const trialDays = h('select', { id: `${id}-days` }, ...TRIAL_DAYS.map((d) => h('option', { value: String(d), text: d === 1 ? '1 jour' : `${d} jours` })));
    trialDays.value = String(DEFAULT_TRIAL_DAYS);
    const trialButton = h('button', { class: 'btn', type: 'button' }, icon('play'));
    const trialLabel = h('span');
    trialButton.append(trialLabel);
    const trialStatus = h('p', { class: 'form-status', role: 'status' });
    const trialError = h('p', { class: 'form-error', role: 'alert' });
    const trialStaleNote = h('div', { class: 'notice is-warning', hidden: true }, icon('state-warning'), h('p', { text: 'Vous avez modifié la règle depuis cet essai : relancez-le pour voir le résultat à jour.' }));
    const trialResult = h('div', { class: 'rl-result', tabindex: '-1', hidden: true });
    const trialBox = h(
      'section',
      { class: 'rl-trial', 'aria-labelledby': `${id}-trial-title` },
      h('h3', { id: `${id}-trial-title` }, icon('history'), 'Essayer avant d’enregistrer'),
      h('p', { class: 'hint', text: 'Le PSIM rejoue les présences déjà vues par les caméras pour dire quand la règle se serait déclenchée. L’essai ne modifie rien : aucune alerte n’est créée, rien n’est enregistré, personne n’est prévenu.' }),
      h('div', { class: 'rl-trial-row' }, h('div', { class: 'field rl-trial-days' }, h('label', { for: trialDays.id, text: 'Période' }), trialDays), trialButton, trialStatus),
      trialError,
      trialStaleNote,
      trialResult,
    );

    // -- actions
    const formError = h('p', { class: 'form-error rl-form-error', role: 'alert' });
    const enabledInput = h('input', { type: 'checkbox', id: `${id}-enabled` });
    const enabledField = h('label', { class: 'check rl-enable' }, enabledInput, 'Activer la règle dès l’enregistrement');
    const save = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('check'), 'Enregistrer la règle');
    const cancel = h('button', { class: 'btn btn-ghost', type: 'button', text: 'Annuler' });

    const el = h(
      'form',
      { class: 'panel rl-form', novalidate: true, autocomplete: 'off', 'aria-labelledby': title.id, hidden: true },
      h('div', { class: 'panel-head' }, title, dirtyTag),
      h(
        'div',
        { class: 'panel-body' },
        conflictNote,
        assistBox,
        nameField,
        h('p', { class: 'hint rl-boxes-lead', text: 'Une règle se lit en cinq cases : Qui, Où, Quand, Si, Alors.' }),
        h('div', { class: 'rl-boxes' }, whoBox, whereBox, whenBox, ifBox, thenBox),
        cooldownField,
        sentenceBox,
        trialBox,
        formError,
        h('div', { class: 'actions rl-form-foot' }, save, cancel, enabledField),
      ),
    );
    formSlot.replaceChildren(el);
    formSlot.hidden = true;

    // ---------------------------------------------------------- état -> écran

    const targets = () => ({
      name: { input: nameInput, err: nameErr },
      who: { input: state.who.type === 'list' ? facesSelect : state.who.type === 'person' ? personSelect : whoAnyone.input, err: whoErr },
      trigger: { input: ifAppears.input, err: minutesErr },
      where: { input: picks.querySelector('input') ?? (state.whereMode === 'zones' ? whereZones.input : whereCams.input), err: whereErr },
      windows: { input: addWindow, err: windowsErr },
      minutes: { input: minutesInput, err: minutesErr },
      cooldown: { input: cooldownInput, err: cooldownErr },
    });

    function clearErrors() {
      for (const t of Object.values(targets())) {
        t.err.textContent = '';
        t.input.removeAttribute('aria-invalid');
      }
      formError.textContent = '';
    }

    /** Pose les messages ; le focus va au premier champ à corriger (sauf pendant la frappe). */
    function showProblems(problems, { focus = true } = {}) {
      showErrors = true;
      clearErrors();
      const t = targets();
      let first = null;
      for (const p of problems) {
        let target = t[p.key];
        if (p.key.startsWith('window:')) {
          const slot = slots.children[Number(p.key.slice(7))];
          target = slot ? { input: slot.querySelector('.rl-day'), err: slot.querySelector('.rl-slot-err') } : t.windows;
        }
        if (!target) continue;
        target.err.textContent = p.message;
        target.input?.setAttribute('aria-invalid', 'true');
        first ??= target.input;
      }
      if (problems.length) formError.textContent = problems.length === 1 ? 'Un point est à corriger avant de continuer.' : `${problems.length} points sont à corriger avant de continuer.`;
      if (focus) first?.focus();
    }

    const problemsNow = () => formProblems(state, ctx());

    function drawSentence() {
      const text = liveSentence(state, cameraName);
      sentenceText.textContent = text ?? 'La phrase de la règle apparaît ici dès que les cases Où, Quand et Si sont complètes.';
      sentenceText.classList.toggle('is-empty', text === null);
    }

    function drawTrialButton() {
      trialLabel.textContent = trialButtonText(Number(trialDays.value));
    }

    function drawDirty() {
      const dirty = open && isDirty();
      dirtyTag.hidden = !dirty;
    }

    /** Après chaque saisie : phrase, étiquette « non enregistré », essai à refaire, messages à jour. */
    function changed() {
      drawSentence();
      drawDirty();
      formError.textContent = showErrors ? formError.textContent : '';
      if (showErrors) showProblems(problemsNow(), { focus: false });
      if (!trialResult.hidden) {
        trialStale = true;
        trialStaleNote.hidden = false;
      }
    }

    const isDirty = () => formKey(state) !== baseKey;

    // -- Où : cases à cocher
    function drawPlaces(force = false) {
      const items = placeItems(cameras(), state);
      const key = state.whereMode + JSON.stringify(items);
      if (!force && key === placesKey) return;
      placesKey = key;
      liveTags.clear();
      const zones = state.whereMode === 'zones';
      picks.setAttribute('aria-label', zones ? 'Zones à surveiller' : 'Caméras à surveiller');
      pickActions.hidden = items.length < 2;
      if (items.length === 0) {
        picks.replaceChildren(
          h(
            'div',
            { class: 'notice is-warning' },
            icon('state-warning'),
            h('span', {}, zones ? 'Aucune zone de caméra pour l’instant. ' : 'Aucune caméra n’est installée pour l’instant. ', 'Ajoutez-en dans ', h('a', { href: '#/equipements', text: 'Équipements et plan' }), '.'),
          ),
        );
        return;
      }
      const selected = zones ? state.zones : state.cameras;
      picks.replaceChildren(
        ...items.map((item) => {
          const input = h('input', { type: 'checkbox', value: item.id });
          input.checked = selected.includes(item.id);
          input.addEventListener('change', () => {
            const current = zones ? state.zones : state.cameras;
            const next = items.filter((i) => (i.id === item.id ? input.checked : current.includes(i.id))).map((i) => i.id);
            if (zones) state.zones = next;
            else state.cameras = next;
            changed();
          });
          const live = h('span', { class: 'tag is-info rl-pick-live', hidden: true });
          if (!zones) liveTags.set(item.id, live);
          return h(
            'label',
            { class: `rl-pick${item.missing ? ' is-missing' : ''}` },
            input,
            h('span', { class: 'rl-pick-text' }, h('span', { class: 'rl-pick-name', text: item.label }), item.note ? h('span', { class: 'rl-pick-note', text: item.note }) : null, live),
          );
        }),
      );
      showPresence();
    }

    function showPresence() {
      for (const [camera, tag] of liveTags) {
        const here = presence[camera];
        tag.hidden = !here;
        if (here) tag.replaceChildren(icon('user', 'icon-sm'), `Quelqu’un est vu en ce moment (depuis ${clockText(here.since)})`);
      }
      for (const card of cards.values()) card.showPresence();
    }

    function setAllPlaces(on) {
      const ids = on ? placeItems(cameras(), state).filter((i) => !i.missing).map((i) => i.id) : [];
      if (state.whereMode === 'zones') state.zones = ids;
      else state.cameras = ids;
      for (const input of picks.querySelectorAll('input')) input.checked = ids.includes(input.value);
      changed();
    }
    pickAll.addEventListener('click', () => setAllPlaces(true));
    pickNone.addEventListener('click', () => setAllPlaces(false));

    // -- Quand : plages
    function slotEl(w, i) {
      const n = i + 1;
      const err = h('p', { class: 'form-error rl-slot-err', id: `${id}-s${i}-err`, 'aria-live': 'polite' });
      const note = h('p', { class: 'hint rl-slot-note' });
      const from = h('input', { type: 'time', value: w.from, required: true, 'aria-describedby': err.id });
      const to = h('input', { type: 'time', value: w.to, required: true, 'aria-describedby': err.id });
      const check = () => {
        const problem = windowProblem(w);
        err.textContent = problem ?? '';
        const badTime = Boolean(problem) && w.days.length > 0;
        from.setAttribute('aria-invalid', String(badTime));
        to.setAttribute('aria-invalid', String(badTime));
        note.textContent = nightNote(w);
      };
      const days = DAY_ORDER.map((d) => {
        const b = h('button', { class: 'btn btn-sm rl-day', type: 'button', 'aria-pressed': String(w.days.includes(d)), 'aria-label': DAY_LONG[d], text: DAY_SHORT[d] });
        b.addEventListener('click', () => {
          w.days = w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d];
          b.setAttribute('aria-pressed', String(w.days.includes(d)));
          check();
          changed();
        });
        return b;
      });
      for (const [input, key] of [[from, 'from'], [to, 'to']]) {
        input.addEventListener('input', () => {
          w[key] = input.value;
          check();
          changed();
        });
      }
      const drop = h('button', { class: 'btn btn-sm btn-ghost rl-remove', type: 'button' }, icon('trash'), 'Retirer', h('span', { class: 'sr-only', text: ` la plage ${n}` }));
      drop.addEventListener('click', () => {
        state.windows.splice(i, 1);
        drawSlots();
        changed();
        // Le focus va à la plage qui prend la place, sinon à « Ajouter une plage ».
        const next = (slots.children[i] ?? slots.children[i - 1])?.querySelector('.rl-day');
        (next ?? addWindow).focus();
      });
      check();
      return h(
        'li',
        { class: 'rl-slot' },
        h(
          'fieldset',
          {},
          h('legend', { text: `Plage ${n}` }),
          h('div', { class: 'rl-days', role: 'group', 'aria-label': `Jours où commence la plage ${n}` }, ...days),
          h('div', { class: 'rl-hours' }, h('label', { class: 'field' }, h('span', { text: 'De' }), from), h('label', { class: 'field' }, h('span', { text: 'À' }), to), drop),
          note,
          err,
        ),
      );
    }

    function drawSlots() {
      slots.replaceChildren(...state.windows.map(slotEl));
      addWindow.disabled = state.windows.length >= MAX_WINDOWS;
      addHint.hidden = state.windows.length < MAX_WINDOWS;
    }

    addWindow.addEventListener('click', () => {
      if (state.windows.length >= MAX_WINDOWS) return;
      state.windows.push(SUGGESTED_WINDOW());
      drawSlots();
      changed();
      slots.lastElementChild?.querySelector('.rl-day')?.focus();
    });

    // -- saisie des autres champs
    nameInput.addEventListener('input', () => {
      state.name = nameInput.value;
      changed();
    });
    for (const [c, mode] of [[whereCams, 'cameras'], [whereZones, 'zones']]) {
      c.input.addEventListener('change', () => {
        state.whereMode = mode;
        drawPlaces();
        changed();
      });
    }
    for (const [c, mode] of [[whenAlways, 'always'], [whenWindows, 'windows'], [whenArmed, 'armed']]) {
      c.input.addEventListener('change', () => {
        state.whenMode = mode;
        if (mode === 'windows' && state.windows.length === 0) state.windows.push(SUGGESTED_WINDOW());
        drawWhen();
        changed();
      });
    }
    function drawWhen() {
      windowsBox.hidden = state.whenMode !== 'windows';
      drawSlots();
    }
    for (const [c, mode] of [[ifAppears, 'appears'], [ifStays, 'stays']]) {
      c.input.addEventListener('change', () => {
        state.triggerMode = mode;
        ifNote.textContent = '';
        changed();
      });
    }
    minutesInput.addEventListener('input', () => {
      state.minutes = minutesInput.value;
      if (state.triggerMode !== 'stays') {
        state.triggerMode = 'stays';
        ifStays.input.checked = true;
      }
      changed();
    });
    for (const [c, severity] of [[thenWarn, 'warning'], [thenCrit, 'critical']]) {
      c.input.addEventListener('change', () => {
        state.severity = severity;
        severityTouched = true;
        thenNote.textContent = '';
        changed();
      });
    }

    // -- Qui : le choix, la liste de visages, ce qui en découle dans « Si » et « Alors »
    const WHO_CHOICES = [[whoAnyone, 'anyone'], [whoList, 'list'], [whoUnknown, 'unknown'], [whoPerson, 'person']];

    /** Mémorise la liste et la personne de la règle ouverte, pour les retrouver si on change puis revient. */
    function rememberWho() {
      lastList = state.who.type === 'list' && state.who.listId ? cloneWho(state.who) : null;
      storedList = lastList ? cloneWho(lastList) : null;
      keptPerson = state.who.type === 'person' ? cloneWho(state.who) : null;
    }

    /** « Si » et « Alors » suivent le « Qui » : textes, choix possibles, explications. */
    function drawWhoEffects() {
      const face = isFaceWho(state.who);
      const appears = appearsTexts(state.who);
      ifAppears.name.textContent = appears.label;
      ifAppears.hint.textContent = appears.desc;
      ifStays.input.disabled = face;
      minutesInput.disabled = face;
      ifStays.el.classList.toggle('is-disabled', face);
      staysHint.textContent = face ? STAYS_FACE_NOTE : 'Seulement si la personne est encore là après ce délai. Une absence de moins d’une minute ne compte pas.';
      ifAppears.input.checked = state.triggerMode === 'appears';
      ifStays.input.checked = state.triggerMode === 'stays';
      const texts = severityTexts(face);
      thenWarn.hint.textContent = texts.warning;
      thenCrit.hint.textContent = texts.critical;
      thenWarn.input.checked = state.severity === 'warning';
      thenCrit.input.checked = state.severity === 'critical';
    }

    /** La zone des listes de visages : menu, lecture en cours, erreur avec « Réessayer », ou « aucune liste ». */
    function drawFaces() {
      const isList = state.who.type === 'list';
      facesBox.hidden = !isList;
      if (!isList) return;
      const view = facesView(faces, state.who, storedList, cameraName);
      const index = selectedListIndex(view.items, state.who);
      facesSelect.replaceChildren(
        h('option', { value: '', text: 'Choisissez une liste…' }),
        ...view.items.map((item, i) => h('option', { value: String(i), text: item.note ? `${item.label} (${item.note})` : item.label })),
      );
      facesSelect.value = index >= 0 ? String(index) : '';
      facesSelect.disabled = view.kind === 'loading' || (view.kind === 'empty');
      facesField.hidden = view.kind === 'empty' || (view.kind === 'error' && view.items.length === 0);
      facesLoading.hidden = view.kind !== 'loading';
      facesFail.hidden = view.kind !== 'error';
      if (view.kind === 'error') facesFailText.replaceChildren(h('strong', { text: 'Les listes de visages n’ont pas pu être lues. ' }), sentence(faces.error));
      facesEmpty.hidden = view.kind !== 'empty';
      facesNotes.replaceChildren(...view.notes.map((n) => h('li', { text: n })));
      facesNotes.hidden = view.notes.length === 0;
      facesReload.hidden = view.kind !== 'select' && view.kind !== 'empty';
      facesSelect.toggleAttribute('aria-busy', view.kind === 'loading');
    }

    /** Lit les listes de visages sur les caméras (en mémoire quelques minutes). Ne lève jamais : l'échec est affiché. */
    function loadFaces(force = false) {
      if (faces.status === 'loading' && facesPending) return facesPending;
      if (!force && faces.status === 'ok' && Date.now() - faces.at < FACES_FRESH_MS) return Promise.resolve();
      const n = ++facesSeq;
      faces = { ...faces, status: 'loading', error: '' };
      drawFaces();
      facesPending = (async () => {
        try {
          const data = await api('/api/faces/lists');
          if (n !== facesSeq) return;
          faces = { status: 'ok', lists: Array.isArray(data?.lists) ? data.lists : [], notes: Array.isArray(data?.notes) ? data.notes : [], hosts: Number(data?.hosts) || 0, error: '', at: Date.now() };
        } catch (err) {
          if (n !== facesSeq) return;
          faces = { ...faces, status: 'error', error: err?.message || 'Le PSIM n’a pas pu interroger les caméras' };
        }
        facesPending = null;
        drawFaces();
      })();
      return facesPending;
    }

    function drawWho() {
      const type = state.who.type;
      for (const [c, t] of WHO_CHOICES) c.input.checked = type === t;
      whoPerson.el.hidden = !(type === 'person' || keptPerson);
      if (!whoPerson.el.hidden) {
        const person = keptPerson ?? state.who;
        whoPerson.name.textContent = `Une personne précise : « ${person.personName} »`;
      }
      whoCaution.hidden = type === 'anyone';
      drawFaces();
      drawPersonCamera();
      drawWhoReview();
      drawWhoEffects();
    }

    /** Caméra d'une personne précise : le menu n'existe que pour ce choix, et garde la caméra enregistrée même disparue. */
    function drawPersonCamera() {
      const isPerson = state.who.type === 'person';
      personBox.hidden = !isPerson;
      if (!isPerson) return;
      const items = personCameraChoices(cameras(), state.who.cameraId);
      personSelect.replaceChildren(h('option', { value: '', text: 'Choisissez une caméra…' }), ...items.map((i) => h('option', { value: i.id, text: i.label })));
      personSelect.value = state.who.cameraId;
    }

    /** Message « à réenregistrer » : tant que la règle ouverte attend une nouvelle liste (ou caméra de personne). */
    function drawWhoReview() {
      const t = state.who.type;
      const pending = reviewWho && ((t === 'list' && !state.who.listId) || (t === 'person' && !state.who.cameraId));
      whoReview.hidden = !pending;
      whoReviewText.textContent = pending ? reviewNote(state.who) : '';
    }

    function chooseWho(type) {
      const prev = state.who.type;
      if (type === prev) return;
      if (prev === 'list' && state.who.listId) lastList = cloneWho(state.who);
      const next = type === 'list' ? (lastList ? cloneWho(lastList) : { type: 'list', cameraId: '', listId: '', listName: '' }) : type === 'person' ? cloneWho(keptPerson) : { type };
      state.who = next;
      const trigger = triggerForWho(next, state.triggerMode);
      state.triggerMode = trigger.triggerMode;
      if (trigger.changed) {
        autoTrigger = true;
        ifNote.textContent = 'La condition est passée à « un visage est vu » : « reste plus de N minutes » n’existe pas pour un visage.';
      }
      const sev = severityForWho({ from: prev, to: type, severity: state.severity, touched: severityTouched });
      if (sev.changed) {
        autoSeverity = state.severity;
        thenNote.textContent = `La gravité est passée à « avertissement » pour un visage (${RELIABILITY_NOTE}). Vous pouvez la changer.`;
      }
      state.severity = sev.severity;
      if (type === 'anyone') {
        const back = restoreForAnyone({ triggerMode: state.triggerMode, severity: state.severity, autoTrigger, autoSeverity, touched: severityTouched });
        state.triggerMode = back.triggerMode;
        state.severity = back.severity;
        autoTrigger = false;
        autoSeverity = null;
        ifNote.textContent = '';
        thenNote.textContent = '';
      }
      drawWho();
      changed();
      if (type === 'list') loadFaces();
    }
    for (const [c, t] of WHO_CHOICES) c.input.addEventListener('change', () => chooseWho(t));

    facesSelect.addEventListener('change', () => {
      const view = facesView(faces, state.who, storedList, cameraName);
      const item = view.items[Number(facesSelect.value)];
      // Le choix est le couple (caméra, liste) de l'entrée : la caméra par laquelle l'enregistreur la lit part avec la règle.
      state.who = item && facesSelect.value !== '' ? { type: 'list', cameraId: item.cameraId, listId: item.id, listName: item.name } : { type: 'list', cameraId: '', listId: '', listName: '' };
      lastList = state.who.listId ? cloneWho(state.who) : lastList;
      drawWhoReview();
      changed();
    });
    personSelect.addEventListener('change', () => {
      if (state.who.type !== 'person') return;
      state.who = { ...state.who, cameraId: personSelect.value };
      keptPerson = cloneWho(state.who);
      drawWhoReview();
      changed();
    });
    facesRetry.addEventListener('click', async () => {
      busy(facesRetry, true);
      await loadFaces(true);
      busy(facesRetry, false);
      (facesFail.hidden ? facesSelect : facesRetry).focus();
    });
    facesReload.addEventListener('click', async () => {
      busy(facesReload, true);
      await loadFaces(true);
      busy(facesReload, false);
      facesReload.focus();
    });
    cooldownInput.addEventListener('input', () => {
      state.cooldown = cooldownInput.value;
      changed();
    });
    enabledInput.addEventListener('change', () => {
      state.enabled = enabledInput.checked;
      changed();
    });
    trialDays.addEventListener('change', drawTrialButton);

    // ---------------------------------------------------------- assistant : une phrase -> une proposition à relire

    const assistParts = [assistError, assistAsk, assistRefused, assistProposal];

    /** La zone n'existe que si le serveur dit que l'assistant est configuré ; sinon elle reste masquée, sans bruit. */
    function drawAssist() {
      assistBox.hidden = assistConfigured !== true;
    }

    /** Lit une fois (par session de l'écran) si l'assistant est configuré ; un échec masque la zone, on réessaiera à l'ouverture suivante. */
    async function ensureAssist() {
      if (assistConfigured !== null || assistProbing) return;
      assistProbing = true;
      try {
        const res = await api('/api/rules/assist');
        assistConfigured = res?.configured === true;
      } catch {
        assistConfigured = null;
      }
      assistProbing = false;
      drawAssist();
    }

    function clearAssistMessages() {
      assistError.textContent = '';
      for (const part of assistParts) if (part !== assistError) part.hidden = true;
    }

    /** Nouvelle saisie ou formulaire fermé : l'échange recommence à zéro et une réponse en route n'est plus affichée. */
    function resetAssist() {
      assistSeq++;
      assistTurns = [];
      assistBusy = false;
      proposalSource = null;
      appliedKey = null;
      assistText.value = '';
      assistAnswer.value = '';
      assistCount.textContent = `0 / ${MAX_SOURCE_TEXT}`;
      busy(assistSend, false);
      busy(assistReply, false);
      clearAssistMessages();
    }

    function setAssistBusy(on) {
      assistBusy = on;
      busy(assistSend, on);
      busy(assistReply, on);
      assistText.readOnly = on;
      assistAnswer.readOnly = on;
    }

    /** Remplit le formulaire avec la proposition. Rien n'est enregistré : l'utilisateur relit, puis enregistre. */
    async function applyProposal(res, sourceText, n) {
      if (res.spec?.who?.type === 'list') await loadFaces();
      if (n !== assistSeq) return;
      const known = ctx();
      const { form: next, issues } = formFromProposal(res, { cameraIds: known.cameraIds, zones: known.zones, lists: faces.status === 'ok' ? faces.lists : null });
      const dirty = formKey(state) !== (appliedKey ?? baseKey);
      if (dirty) {
        const ok = await dialogs.confirm({
          heading: 'Remplacer votre saisie par la proposition ?',
          message: 'La proposition de l’assistant remplace toutes les cases du formulaire. Ce que vous avez saisi à la main sera perdu.',
          confirmLabel: 'Utiliser la proposition',
          danger: false,
        });
        if (n !== assistSeq) return;
        if (!ok) {
          assistRefusedText.textContent = 'Proposition non utilisée : votre saisie est conservée.';
          assistRefused.hidden = false;
          focusSoon(assistText);
          return;
        }
      }
      next.enabled = state.enabled; // l'activation immédiate reste le choix de l'utilisateur
      state = next;
      rememberWho();
      severityTouched = true; // la gravité vient de la proposition : aucun changement automatique par-dessus
      autoTrigger = false;
      autoSeverity = null;
      ifNote.textContent = '';
      thenNote.textContent = '';
      proposalSource = editing ? null : sourceText || null; // le serveur n'accepte la phrase d'origine qu'à la création
      showErrors = false;
      clearErrors();
      paint();
      appliedKey = formKey(state);
      changed();
      assistProposalSummary.textContent = res.summary ?? '';
      assistProposalSummary.hidden = !res.summary;
      assistProposalIssues.replaceChildren(...issues.map((text) => h('li', { text })));
      assistProposalIssues.hidden = issues.length === 0;
      assistProposal.hidden = false;
      if (state.who.type === 'list') loadFaces();
      focusSoon(assistProposal);
    }

    /** Envoie une phrase (ou une réponse à une question) à l'assistant et affiche ce qu'il répond. */
    async function askAssistant(text, isAnswer) {
      if (assistBusy) return;
      const phrase = text.trim();
      clearAssistMessages();
      if (!phrase) {
        assistError.textContent = isAnswer ? 'Écrivez votre réponse.' : 'Écrivez d’abord une phrase qui décrit la règle.';
        (isAnswer ? assistAnswer : assistText).focus();
        return;
      }
      if (!isAnswer) assistTurns = [];
      const n = ++assistSeq;
      setAssistBusy(true);
      try {
        const body = { text: phrase };
        const history = historyForAssist(assistTurns);
        if (history.length) body.history = history;
        const res = await api('/api/rules/assist', { method: 'POST', body });
        if (n !== assistSeq) return;
        const next = nextAssistTurns(assistTurns, phrase, res);
        assistTurns = next.turns;
        setAssistBusy(false);
        if (res?.kind === 'question') {
          assistQuestionText.textContent = String(res.question ?? '');
          assistAnswer.value = '';
          assistAsk.hidden = false;
          focusSoon(assistAnswer);
        } else if (res?.kind === 'refused') {
          assistRefusedText.textContent = sentence(res.reason);
          assistRefused.hidden = false;
        } else if (res?.kind === 'rule') {
          await applyProposal(res, next.sourceText, n);
        } else assistError.textContent = 'L’assistant a donné une réponse que l’écran ne comprend pas. Reformulez votre phrase.';
      } catch (err) {
        if (n !== assistSeq) return;
        setAssistBusy(false);
        assistError.textContent = err?.message ? sentence(err.message) : 'L’assistant n’a pas pu répondre. Réessayez dans un instant.';
      }
    }

    assistText.addEventListener('input', () => {
      assistCount.textContent = `${assistText.value.length} / ${MAX_SOURCE_TEXT}`;
    });
    assistText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        assistSend.click();
      }
    });
    assistAnswer.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault(); // Entrée envoie la réponse, elle n'enregistre pas la règle
        assistReply.click();
      }
    });
    assistSend.addEventListener('click', () => askAssistant(assistText.value, false));
    assistReply.addEventListener('click', () => askAssistant(assistAnswer.value, true));

    /** Tous les champs reprennent la valeur de l'état. */
    function paint() {
      nameInput.value = state.name;
      whereCams.input.checked = state.whereMode === 'cameras';
      whereZones.input.checked = state.whereMode === 'zones';
      whenAlways.input.checked = state.whenMode === 'always';
      whenWindows.input.checked = state.whenMode === 'windows';
      whenArmed.input.checked = state.whenMode === 'armed';
      minutesInput.value = state.minutes;
      cooldownInput.value = state.cooldown;
      enabledInput.checked = state.enabled;
      enabledField.hidden = editing !== null;
      drawWho();
      drawAssist();
      drawPlaces(true);
      drawWhen();
      drawSentence();
      drawTrialButton();
    }

    // ---------------------------------------------------------- essai sur le passé

    function resetTrial() {
      trialSeq++;
      trialResult.hidden = true;
      trialResult.replaceChildren();
      trialStaleNote.hidden = true;
      trialStale = false;
      trialError.textContent = '';
      setTrialBusy(false);
    }

    /** Pendant l'essai : bouton occupé et désactivé, et un mot pour le dire. */
    function setTrialBusy(on) {
      busy(trialButton, on);
      trialStatus.classList.toggle('is-busy', on);
      trialStatus.textContent = on ? 'Essai en cours…' : '';
    }

    function showTrial(res, days) {
      const hits = [...(res.triggers ?? [])].sort((a, b) => b.at - a.at); // du plus récent au plus ancien
      const items = hits.map((t) => describeTrigger(t, cameraName));
      const shown = h('ol', { class: 'rl-hits' });
      const PAGE = 20;
      let count = 0;
      const more = h('button', { class: 'btn btn-sm', type: 'button' });
      const drawMore = () => {
        for (const it of items.slice(count, count + PAGE)) {
          shown.append(
            h(
              'li',
              { class: 'rl-hit' },
              h('p', { class: 'rl-hit-when' }, h('strong', { text: `${cap(it.day)} à ${it.time}` })),
              h('p', { class: 'rl-hit-detail' }, icon(it.ongoing ? 'state-warning' : 'clock', 'icon-sm'), it.duration ? `${it.until} (${it.duration})` : it.until),
              h('p', { class: 'rl-hit-cam' }, icon('camera', 'icon-sm'), it.camera),
            ),
          );
        }
        count = Math.min(items.length, count + PAGE);
        more.hidden = count >= items.length;
        more.textContent = `Voir les ${Math.min(PAGE, items.length - count)} suivants (${items.length - count} restants)`;
      };
      more.addEventListener('click', drawMore);
      drawMore();
      // replaceChildren écrit « null » pour un null : on ne lui donne que des éléments.
      const parts = [
        h('div', { class: `rl-result-head${items.length ? '' : ' is-quiet'}` }, icon(items.length ? 'bell' : 'info'), h('p', { class: 'rl-result-title', text: trialHeadline(items.length, res.days ?? days) })),
        res.summary ? h('p', { class: 'rl-result-rule' }, h('strong', { text: 'Règle essayée : ' }), res.summary) : null,
        res.armedNote ? h('div', { class: 'notice is-info' }, icon('info'), h('p', { text: ARMED_NOTE })) : null,
        items.length ? h('p', { class: 'hint', text: 'Du plus récent au plus ancien.' }) : null,
        items.length ? shown : null,
        items.length ? more : null,
        h('p', { class: 'hint', text: 'Le PSIM ne garde les présences que 30 jours, et seulement depuis qu’il les enregistre. Cet essai n’a rien modifié.' }),
      ];
      trialResult.replaceChildren(...parts.filter(Boolean));
      trialResult.hidden = false;
      trialStaleNote.hidden = true;
      trialStale = false;
      trialResult.focus();
    }

    trialButton.addEventListener('click', async () => {
      if (trialButton.classList.contains('is-busy')) return;
      const problems = problemsNow().filter((p) => p.key !== 'name');
      if (problems.length) {
        showProblems(problems);
        trialError.textContent = `Complétez d’abord la règle (${problems[0].message.charAt(0).toLowerCase()}${problems[0].message.slice(1)})`;
        return;
      }
      trialError.textContent = '';
      const n = ++trialSeq;
      const days = Number(trialDays.value);
      const startKey = formKey(state);
      setTrialBusy(true);
      try {
        const res = await api('/api/rules/simulate', { method: 'POST', body: { spec: buildSpec(state), days } });
        if (n !== trialSeq) return;
        setTrialBusy(false);
        showTrial(res, days);
        if (formKey(state) !== startKey) {
          trialStale = true; // la règle a changé pendant l'essai
          trialStaleNote.hidden = false;
        }
      } catch (err) {
        if (n !== trialSeq) return;
        setTrialBusy(false);
        const problem = serverProblem(err.message);
        if (problem.key) {
          showProblems([{ key: problem.key, message: problem.text }]);
          trialError.textContent = `L’essai n’a pas pu avoir lieu : corrigez la case « ${problem.box} ».`;
        } else trialError.textContent = `L’essai n’a pas pu avoir lieu : ${problem.text}`;
      }
    });

    // ---------------------------------------------------------- enregistrer, annuler

    el.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (saving) return;
      const problems = problemsNow();
      if (problems.length) {
        showProblems(problems);
        return;
      }
      showErrors = false;
      clearErrors();
      saving = true;
      busy(save, true);
      for (const b of el.querySelectorAll('button')) if (b !== save) b.disabled = true;
      const body = { name: state.name.trim(), spec: buildSpec(state) };
      // La phrase d'origine (zone de l'assistant) accompagne la création seulement : le serveur ne l'accepte pas à la modification.
      const created = { ...body, enabled: state.enabled, ...(proposalSource ? { sourceText: proposalSource } : {}) };
      try {
        const saved = editing ? await api(`/api/rules/${editing.id}`, { method: 'PUT', body }) : await api('/api/rules', { method: 'POST', body: created });
        saving = false;
        for (const b of el.querySelectorAll('button')) b.disabled = false;
        busy(save, false);
        close(false);
        upsert(saved);
        toast(`Règle « ${saved.name} » enregistrée`, 'ok');
        cards.get(saved.id)?.focusName();
      } catch (err) {
        saving = false;
        for (const b of el.querySelectorAll('button')) b.disabled = false;
        busy(save, false);
        const problem = serverProblem(err.message);
        if (problem.key) {
          // Refus du serveur sur une case (« Qui : … », « Où : … ») : le message est posé sur la case, qui reçoit le focus.
          showProblems([{ key: problem.key, message: problem.text }]);
          formError.textContent = `La règle n’a pas été enregistrée : corrigez la case « ${problem.box} ».`;
        } else {
          formError.textContent = `La règle n’a pas été enregistrée : ${problem.text}`;
          save.focus();
        }
      }
    });

    cancel.addEventListener('click', async () => {
      if (isDirty()) {
        const ok = await dialogs.confirm({
          heading: 'Abandonner la saisie ?',
          message: editing ? 'Les modifications de cette règle ne seront pas enregistrées.' : 'La règle en cours de saisie ne sera pas enregistrée.',
          confirmLabel: 'Abandonner la saisie',
          danger: false,
        });
        if (!ok) {
          focusSoon(nameInput);
          return;
        }
      }
      close(true);
    });

    // ---------------------------------------------------------- ouvrir, fermer

    function open_(rule, from) {
      editing = rule ? { id: rule.id, updatedAt: rule.updatedAt } : null;
      state = rule ? formFromRule(rule) : defaultForm();
      if (!rule && cameras().length === 1) state.cameras = [cameras()[0].id]; // une seule caméra : déjà choisie
      baseKey = formKey(state);
      opener = from ?? null;
      open = true;
      showErrors = false;
      clearErrors();
      resetTrial();
      resetAssist();
      rememberWho();
      reviewWho = Boolean(rule?.needsReview) && isDeviceWho(rule?.spec?.who);
      severityTouched = false;
      autoTrigger = false;
      autoSeverity = null;
      ifNote.textContent = '';
      thenNote.textContent = '';
      conflictNote.hidden = true;
      title.textContent = rule ? `Modifier la règle « ${rule.name} »` : 'Nouvelle règle';
      paint();
      drawDirty();
      el.hidden = false;
      formSlot.hidden = false;
      for (const card of cards.values()) card.markEditing(Boolean(rule) && card.id === rule.id);
      ensureAssist();
      if (state.who.type === 'list') loadFaces();
      focusSoon(title);
      el.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    }

    function close(restoreFocus) {
      open = false;
      editing = null;
      reviewWho = false;
      el.hidden = true;
      formSlot.hidden = true;
      resetTrial();
      resetAssist();
      showErrors = false;
      clearErrors();
      for (const card of cards.values()) card.markEditing(false);
      const target = opener;
      opener = null;
      if (restoreFocus) focusSoon(target?.isConnected && !target.closest('[hidden]') ? target : newButtons.find((b) => b && !b.closest('[hidden]')));
    }

    return {
      el,
      open: open_,
      close,
      isOpen: () => open,
      isDirty: () => open && isDirty(),
      editingId: () => (open && editing ? editing.id : null),
      focus: () => focusSoon(title),
      showPresence,
      refreshChoices: () => {
        if (!open) return;
        drawPlaces();
        drawPersonCamera();
      },
      /**
       * La liste vient d'être relue : si la règle ouverte a changé ailleurs (ou disparu), on le dit, la saisie reste intacte.
       */
      sync() {
        if (!open || !editing) return;
        const now = rules.find((r) => r.id === editing.id);
        if (!now) {
          conflictText.textContent = 'Cette règle n’existe plus : elle a été supprimée depuis un autre poste. Enregistrer échouera ; fermez le formulaire avec « Annuler ».';
          conflictNote.hidden = false;
        } else if (now.updatedAt !== editing.updatedAt) {
          // La saisie n'est pas remplacée. « Enregistrer » écrasera la version enregistrée ailleurs : on le dit.
          conflictText.textContent = `Cette règle vient d’être modifiée par ${now.updatedBy} depuis un autre poste. Enregistrer remplacera cette version par la vôtre ; « Annuler » reprend la version enregistrée.`;
          conflictNote.hidden = false;
        } else conflictNote.hidden = true;
      },
      reset() {
        if (open) close(false);
        state = defaultForm();
        editing = null;
        reviewWho = false;
        resetAssist();
        rememberWho();
        severityTouched = false;
        autoTrigger = false;
        autoSeverity = null;
        ifNote.textContent = '';
        thenNote.textContent = '';
        paint();
      },
    };
  }

  const form = buildForm();

  // ------------------------------------------------------------ entrée et sortie de l'écran

  function show() {
    if (!isAdmin()) {
      render();
      return;
    }
    // Un autre compte sur ce poste : rien de la session précédente ne reste (formulaire, liste).
    if (shownFor !== getMe().username) {
      shownFor = getMe().username;
      reset();
    }
    if (!loaded) loading.hidden = false;
    load();
    clearInterval(timer);
    // Un nouvel état de la liste toutes les 30 s (règle changée depuis un autre poste, présence du moment). Le formulaire
    // n'est pas touché : seul son avertissement « modifiée ailleurs » peut apparaître.
    timer = setInterval(() => !document.hidden && load(), 30_000);
  }

  function hide() {
    clearInterval(timer);
    timer = 0;
  }

  function reset() {
    // Rien de la session précédente : ni les listes de visages lues, ni le « configuré » de l'assistant.
    faces = freshFaces();
    facesSeq++;
    facesPending = null;
    assistConfigured = null;
    assistProbing = false;
    form.reset();
    rules = [];
    presence = {};
    loaded = false;
    loadSeq++;
    cards.clear();
    list.replaceChildren();
    emptyBox.hidden = true;
    loading.hidden = false;
    errorBox.hidden = true;
  }

  return { show, hide, reset, refreshChoices: () => form.refreshChoices(), isDirty: () => form.isDirty() };
}
