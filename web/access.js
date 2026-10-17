/**
 * Écran « Accès » (lot AC3) : journal des passages, état des portes, fiche d'une porte et déclaration des contrôleurs et
 * des portes (administrateur). L'API est celle de docs/ACCES.md (§ 3) ; le contrat commun, celui de docs/CONTROLE-ACCES.md.
 *
 * Principes tenus ici :
 *  - le contrôleur décide d'ouvrir, le PSIM enregistre et supervise : cet écran ne commande rien (l'ouverture à distance
 *    est un emplacement, `data-slot="remote-open"`, rempli par un composant externe qui écoute l'évènement
 *    `psim:door-card` émis après chaque rendu de la fiche) ;
 *  - le vocabulaire est celui des agents de garde : « boîtier de contrôle d'accès (contrôleur) » à la première apparition
 *    visible de chaque écran, « contrôleur » ensuite ; « reçu après coupure » (le mot `late` ne vit que dans l'API) ;
 *  - un état = une forme + une icône + un mot, et chaque état dit quoi faire (texte du serveur, `stateHint`) ;
 *  - tout ce qui vient du serveur (noms, numéros de badge) est hostile : texte seulement (`textContent` via h()), jamais
 *    d'HTML construit, jamais de style en ligne (CSP stricte) ;
 *  - aucune donnée personnelle dans l'adresse de la page (la sous-route ne porte que porte, résultat et « reçu après coupure ») ;
 *  - « Voir la vidéo » montre l'ENREGISTREMENT du passage (10 s avant, 20 s après) quand une caméra liée est une voie
 *    d'enregistreur Dahua que le PSIM sait relire (GET /api/cameras/replayable) ; sinon l'image EN DIRECT, et l'interface
 *    dit toujours laquelle des deux elle montre, et pourquoi (docs/ACCES.md § 5) ;
 *  - une alarme ne se cache jamais : quand l'écran est quitté (hide), tout ce qu'il a ouvert (fenêtre vidéo, flux des
 *    caméras, écouteur du clavier) est fermé ;
 *  - les identifiants des contrôleurs sont en écriture seule : jamais préremplis, jamais relus.
 *
 * Le haut du fichier est PUR (sans page, testé par test/access-ui.test.ts) ; `createAccessView` charge core.js et
 * account.js à la première ouverture pour que ces fonctions restent importables sans navigateur.
 */
import { startLiveCamera } from './live.js';
import { startSimCamera } from './camera.js';

// ================================================================================================ constantes

export const PAGE_SIZE = 50;
export const MAX_HOLDER = 64;
export const MAX_CREDENTIAL = 32;
export const MAX_NAME = 80;
export const MAX_MODEL = 40;
export const MAX_SECRET = 128;
export const EXPORT_MAX_ROWS = 100_000;
export const TOTAL_CAP = 10_000;
export const CLOCK_WARN_MS = 120_000; // écart d'horloge signalé comme défaut au-delà de 2 minutes (docs/ACCES.md § 6)
export const HELD_MIN_S = 10;
export const HELD_MAX_S = 86_400;
export const HELD_DEFAULT_S = 300;
export const RETENTION_MIN = 7;
export const RETENTION_MAX = 3650;

/** Même motif que les identifiants de détecteurs et de contrôleurs du serveur. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** Même motif que HOST_PATTERN de server/video.ts (adresse IPv4 ou nom de machine, sans http:// ni chemin). */
export const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
/** Même interdit que server/text.ts : caractères de contrôle, séparateurs de ligne, caractères de format invisibles. */
const FORBIDDEN_CHAR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u;

export const TABS = [
  { id: 'journal', label: 'Journal', icon: 'list' },
  { id: 'portes', label: 'Portes', icon: 'door' },
  { id: 'declaration', label: 'Déclaration', icon: 'sliders', admin: true },
];

export const PRESETS = [
  { id: 'today', label: 'Aujourd’hui' },
  { id: 'last24', label: 'Dernières 24 h' },
  { id: 'yesterday', label: 'Hier' },
  { id: 'week', label: '7 derniers jours' },
];

export const RESULT_CHOICES = [
  { id: '', label: 'Tous' },
  { id: 'granted', label: 'Acceptés' },
  { id: 'denied', label: 'Refusés' },
];

export const BRANDS = [
  { id: 'dahua', label: 'Dahua' },
  { id: 'zkteco', label: 'ZKTeco' },
  { id: 'relay', label: 'Contact sec (relais IP)' },
];

export const DOOR_KINDS = [
  { id: 'door', label: 'Porte' },
  { id: 'gate', label: 'Portail' },
  { id: 'barrier', label: 'Barrière' },
  { id: 'turnstile', label: 'Tourniquet' },
];

/** Du plus grave au moins grave : la porte forcée passe avant la porte fermée (tri de la liste, résumé). */
export const DOOR_ORDER = ['forced', 'held_open', 'offline', 'fault', 'unknown', 'open', 'closed'];

const STATE_WORDS = {
  forced: ['forcée', 'forcées'],
  held_open: ['maintenue ouverte', 'maintenues ouvertes'],
  offline: ['hors ligne', 'hors ligne'],
  fault: ['en défaut', 'en défaut'],
  unknown: ['d’état inconnu', 'd’état inconnu'],
  open: ['ouverte', 'ouvertes'],
  closed: ['fermée', 'fermées'],
};

/**
 * Phrase du serveur (`stateHint`) dont la première mention de « contrôleur » est expliquée : sur la fiche, ce texte est
 * le premier à l'écran, avant la liste des informations. `explained` dit que c'est fait (le libellé de la liste reste court).
 */
export function explainController(text) {
  const raw = String(text ?? '');
  if (/boîtier de contrôle/i.test(raw) || !/contrôleur/i.test(raw)) return { text: raw, explained: false };
  return { text: raw.replace(/contrôleur/i, (m) => (m[0] === 'C' ? capFirst(CONTROLLER_LONG) : CONTROLLER_LONG)), explained: true };
}

/** Secours si le serveur ne donne pas de `stateHint` : ce que l'état signifie et ce qu'il faut faire. */
export const STATE_HINT = {
  closed: 'La porte est fermée. Rien à faire.',
  open: 'Un passage est en cours. Rien à faire.',
  forced: 'La porte s’est ouverte sans autorisation. Regardez la caméra, puis traitez l’alarme.',
  held_open: 'Quelqu’un retient la porte ouverte. Si elle reste ouverte, l’alarme sonnera.',
  offline: 'Le PSIM n’a plus de nouvelles de cette porte. Les badges fonctionnent toujours sur place : faites vérifier l’alimentation et le réseau.',
  fault: 'L’équipement signale une panne. Prévenez le technicien.',
  unknown: 'Aucun message reçu pour l’instant : l’état de la porte n’est pas connu.',
};

export const EXPORT_TRUNCATED_TEXT = 'Export limité à 100 000 lignes, réduisez la période.';
export const JOURNAL_NOTE = 'Les recherches par nom ou par badge et les exports sont notés dans le journal des actions du PSIM.';
/** Première apparition de « contrôleur » sur un écran : on dit ce que c'est. */
export const CONTROLLER_LONG = 'boîtier de contrôle d’accès (contrôleur)';
export const LATE_LABEL = 'Reçu après coupure';
export const LATE_HELP = `Passages récupérés dans la mémoire du ${CONTROLLER_LONG} après une coupure.`;
export const LATE_TITLE = 'Passage récupéré après une coupure de liaison. L’heure affichée est celle de la porte.';
export const PERIOD_HINT = 'Heure affichée : celle de la porte.';
export const SEARCH_HINT = 'Appuyez sur Entrée ou sur Rechercher.';
export const EXPORT_LABEL = 'Exporter (tableur)';
export const EXPORT_HELP = 'Fichier lisible dans Excel.';
export const MORE_FILTERS_LABEL = 'Plus de filtres';
/** Carte « Ouverture à distance » quand aucun composant ne l'a remplie (contrat de l'évènement `psim:door-card`). */
export const REMOTE_FALLBACK_TEXT = 'Ouverture à distance : aucune serrure ou barrière n’est reliée à cette porte.';
export const REMOTE_ADMIN_HINT = 'Reliez-en une dans ';
/** Nom de l'évènement émis sur `document` après chaque rendu de la fiche d'une porte. */
export const DOOR_CARD_EVENT = 'psim:door-card';
export const BACK_LABELS = { portes: 'Retour aux portes', journal: 'Retour au journal', plan: 'Retour au plan' };
export const UNDECLARED_TEXT = 'Ce détecteur n’est rattaché à aucun contrôleur : ses passages seront enregistrés mais la porte n’a pas d’état.';

// ================================================================================================ dates et heures

const pad = (n) => String(n).padStart(2, '0');
const DAY_MS = 86_400_000;
const validTs = (ts) => typeof ts === 'number' && Number.isFinite(ts) && !Number.isNaN(new Date(ts).getTime());

/** Minuit local du jour de `ts`, décalé de `offsetDays` jours (sans se tromper d'une heure lors d'un changement d'heure). */
export function dayStart(ts, offsetDays = 0) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays).getTime();
}

export function formatClock(ts) {
  if (!validTs(ts)) return '';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatClockSeconds(ts) {
  if (!validTs(ts)) return '';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDate(ts) {
  if (!validTs(ts)) return '';
  const d = new Date(ts);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** « aujourd’hui », « hier », « le 12/10/2026 ». */
export function dayWord(ts, now) {
  const days = Math.round((dayStart(now) - dayStart(ts)) / DAY_MS);
  if (days === 0) return 'aujourd’hui';
  if (days === 1) return 'hier';
  return `le ${formatDate(ts)}`;
}

export const capFirst = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : '');

/** « aujourd’hui à 14:32 », « hier à 08:10 », « le 12/10/2026 à 17:05 » (avec les secondes si demandé). */
export function formatWhen(ts, now, { seconds = false } = {}) {
  if (!validTs(ts)) return '';
  return `${dayWord(ts, now)} à ${seconds ? formatClockSeconds(ts) : formatClock(ts)}`;
}

/** Date et heure d'un passage en deux morceaux (le tableau les met sur deux lignes). */
export function passageStamp(ts, now) {
  if (!validTs(ts)) return { day: '', time: '' };
  const word = dayWord(ts, now);
  return { day: word.startsWith('le ') ? word.slice(3) : capFirst(word), time: formatClockSeconds(ts) };
}

/** Valeur d'un champ date + heure (`datetime-local`) pour un instant, à la minute près, heure locale. */
export function toInputValue(ts) {
  if (!validTs(ts)) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Instant (ms) d'une valeur de champ `datetime-local` (heure locale), ou null si elle n'est pas une date valide. */
export function fromInputValue(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const [y, mo, d, hh, mi, ss] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  const date = new Date(y, mo - 1, d, hh, mi, ss);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== hh || date.getMinutes() !== mi) return null;
  return date.getTime();
}

const isoOrEmpty = (ts) => (validTs(ts) ? new Date(ts).toISOString() : '');

/**
 * Raccourcis de période, en valeurs de champs. « Au » est INCLUS à la minute près (le serveur reçoit la minute suivante,
 * il exclut sa borne) : « Aujourd’hui » va donc de 00:00 à 23:59. « Dernières 24 h » va de la minute d'il y a 24 heures
 * à la minute présente : elle englobe la ronde de nuit, que « Aujourd’hui » (depuis minuit) laisse de côté le matin.
 */
export function quickRange(id, now) {
  const endOfDay = (offset) => dayStart(now, offset) - 60_000;
  if (id === 'today') return { from: toInputValue(dayStart(now)), to: toInputValue(endOfDay(1)) };
  if (id === 'last24') return { from: toInputValue(now - DAY_MS), to: toInputValue(now) };
  if (id === 'yesterday') return { from: toInputValue(dayStart(now, -1)), to: toInputValue(endOfDay(0)) };
  if (id === 'week') return { from: toInputValue(dayStart(now, -6)), to: toInputValue(endOfDay(1)) };
  return null;
}

/** « Dernières 24 h » glisse avec l'horloge : on la reconnaît à sa largeur (24 h pile) et à une fin récente. */
const ROLLING_TOLERANCE_MS = 10 * 60_000;

/**
 * Raccourci qui correspond à la période saisie, sinon null (il reste « enfoncé » tant que les dates collent). Les 24
 * dernières heures restent reconnues pendant dix minutes, le temps de lire la liste.
 */
export function matchPreset(filters, now) {
  for (const p of PRESETS) {
    if (p.id === 'last24') {
      const from = fromInputValue(filters.from);
      const to = fromInputValue(filters.to);
      if (from !== null && to !== null && to - from === DAY_MS && to <= now && now - to < ROLLING_TOLERANCE_MS) return p.id;
      continue;
    }
    const r = quickRange(p.id, now);
    if (r && r.from === filters.from && r.to === filters.to) return p.id;
  }
  return null;
}

/** Durée lisible : « 45 s », « 1 min 12 s », « 2 h 05 min ». */
export function durationText(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s ? `${m} min ${s} s` : `${m} min`;
  }
  const hh = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${hh} h ${pad(m)} min`;
}

// ================================================================================================ nombres et libellés

/** Entier avec une espace insécable entre les milliers : « 1 234 ». */
export function formatInt(n) {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v)) return '';
  return String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ').replace(/^/, v < 0 ? '-' : '');
}

export const plural = (n, one, many = `${one}s`) => `${formatInt(n)} ${n > 1 ? many : one}`;

/** « 1 234 passages », « plus de 10 000 passages », « Aucun passage », « 1 passage ». */
export function totalText(total, capped = false) {
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return '';
  if (capped) return `plus de ${formatInt(total)} passages`;
  if (total === 0) return 'Aucun passage';
  if (total === 1) return '1 passage';
  return `${formatInt(total)} passages`;
}

/** « Passages 51 à 100 sur 1 234 » (page 0 = la plus récente). Vide s'il n'y a rien à montrer. */
export function rangeText(pageIndex, limit, itemCount, total, capped = false) {
  if (!itemCount) return '';
  const start = pageIndex * limit + 1;
  const end = start + itemCount - 1;
  const base = `Passages ${formatInt(start)} à ${formatInt(end)}`;
  if (typeof total !== 'number' || !Number.isFinite(total)) return base;
  return capped ? `${base} sur plus de ${formatInt(total)}` : `${base} sur ${formatInt(total)}`;
}

export function directionLabel(direction) {
  if (direction === 'in') return 'Entrée';
  if (direction === 'out') return 'Sortie';
  return 'Non précisé';
}

export function holderLine(p) {
  const name = typeof p?.holderName === 'string' ? p.holderName.trim() : '';
  if (name) return name;
  // Une ouverture par le bouton de sortie ou à distance n'a pas de titulaire : ce n'est pas « un inconnu ».
  if (p?.method === 'exit_button') return 'Sans badge (bouton de sortie)';
  if (p?.method === 'remote') return 'Sans badge (ouverture à distance)';
  return 'Titulaire inconnu';
}

export function badgeLine(p) {
  const badge = typeof p?.credential === 'string' ? p.credential.trim() : '';
  return badge ? `Badge ${badge}` : '';
}

/** Le résultat en clair : le libellé du serveur (« Refusé — badge expiré »), sinon un mot de secours. */
export function resultLabelOf(p) {
  if (typeof p?.resultLabel === 'string' && p.resultLabel.trim()) return p.resultLabel;
  return p?.result === 'granted' ? 'Accepté' : 'Refusé';
}

/** Ton visuel du résultat : l'icône et le mot portent le sens, jamais la couleur seule. */
export function resultTone(p) {
  return p?.result === 'granted' ? 'ok' : 'warning';
}

/**
 * Le résultat en deux morceaux pour l'écran : le mot court de la pastille (« Refusé ») et la raison, écrite à côté, hors
 * de la pastille (« Badge inconnu »). `full` (« Refusé — badge inconnu ») reste le nom lu par les lecteurs d'écran.
 */
export function resultParts(p) {
  const full = resultLabelOf(p);
  const fallback = p?.result === 'granted' ? 'Accepté' : 'Refusé';
  const cut = full.indexOf('—');
  if (cut < 0) return { word: full.trim() || fallback, reason: '', full };
  return { word: full.slice(0, cut).trim() || fallback, reason: capFirst(full.slice(cut + 1).trim()), full };
}

/** Icône du résultat : coche pour un passage accepté, croix pour un refus (jamais un cadenas, qui dit « fermé »). */
export const resultIcon = (p) => (resultTone(p) === 'ok' ? 'state-ok' : 'state-denied');

/**
 * L'incident EN COURS (ouvert ou acquitté) du détecteur d'une porte qui sonne, pour le bouton « Aller à l'alarme ».
 * Rien si la porte ne sonne pas (ni forcée, ni maintenue ouverte, ni détecteur en alarme ou préalarme) ou s'il n'y a pas
 * d'incident ouvert : pas de bouton qui mène nulle part. Le plus urgent d'abord : non acquitté, puis le plus récent.
 */
export function incidentForDoor(door, incidents) {
  if (!door || typeof door.detectorId !== 'string') return null;
  const sounding = door.state === 'forced' || door.state === 'held_open' || door.deviceStatus === 'alarm' || door.deviceStatus === 'prealarm';
  if (!sounding) return null;
  const list = incidents instanceof Map ? [...incidents.values()] : Array.isArray(incidents) ? incidents : [];
  const mine = list.filter((i) => i && i.detectorId === door.detectorId && i.status !== 'closed');
  mine.sort((a, b) => (b.status === 'open') - (a.status === 'open') || (Number(b.openedAt) || 0) - (Number(a.openedAt) || 0));
  return mine[0] ?? null;
}

/** « KONAN Yao — Accepté, aujourd’hui à 14:32 » : le dernier passage d'une porte en une phrase. */
export function lastPassageSentence(p, now) {
  if (!p) return '';
  return `${holderLine(p)} — ${resultLabelOf(p)}, ${formatWhen(p.atDevice, now)}`;
}

/** Armement de la porte lu sur la réponse du serveur ; `null` si le serveur est ancien (pas de champ `arming`). */
export function doorArming(door) {
  const a = door?.arming;
  if (!a || typeof a !== 'object') return null;
  return { enabled: Boolean(a.enabled), zone: typeof a.zone === 'string' ? a.zone.trim() : '', zoneArmable: a.zoneArmable !== false, armedNow: typeof a.armedNow === 'boolean' ? a.armedNow : null };
}

/** Ce que la case « Armer cette porte avec sa zone » peut faire pour une zone donnée : active, ou désactivée avec son explication. */
export function armingFieldInfo({ zone = '', zoneArmable = true, enabled = false } = {}) {
  const name = String(zone ?? '').trim();
  const help = `Quand ${name ? `la zone « ${name} »` : 'la zone de la porte'} est armée (écran Armement), toute ouverture de cette porte donne une pré-alarme, même avec un badge accepté, sauf pour un titulaire dont le groupe a un droit à cette heure. Une porte forcée reste une alarme.`;
  // Une porte déjà rattachée reste décochable, même si sa zone a disparu depuis.
  if (!name && !enabled) return { disabled: true, help, reason: 'Cette porte n’est dans aucune zone : choisissez-en une dans sa fiche d’équipement.' };
  if (!zoneArmable && !enabled) return { disabled: true, help, reason: 'Cette zone n’a pas d’armement : ajoutez-y un détecteur d’intrusion ou réglez-la dans l’écran Armement.' };
  return { disabled: false, help, reason: '' };
}

/** Ligne « Armement avec la zone » de la fiche : { text, attached, armed } ; `null` si le serveur ne fournit pas l’information. */
export function armingFactInfo(door) {
  const a = doorArming(door);
  if (!a) return null;
  if (!a.enabled) return { text: 'Non rattachée', attached: false, armed: null };
  const zone = a.zone ? `« ${a.zone} »` : 'de la porte';
  if (a.armedNow === true) return { text: `Rattachée à la zone ${zone} — armée maintenant`, attached: true, armed: true };
  if (a.armedNow === false) return { text: `Rattachée à la zone ${zone} — désarmée maintenant`, attached: true, armed: false };
  return { text: `Rattachée à la zone ${zone}`, attached: true, armed: null };
}

/** Note d’armement d’un passage : { text, authorized } ou `null` (pas de note, ou serveur ancien). */
export function armingNoteOf(p) {
  const a = p?.arming;
  if (!a || typeof a !== 'object') return null;
  const authorized = Boolean(a.authorized);
  const label = typeof a.label === 'string' && a.label.trim() ? a.label.trim() : `Ouverture pendant l’armement : ${authorized ? 'autorisée' : 'non autorisée'}`;
  return { text: label, authorized };
}

export function kindLabel(kind) {
  return DOOR_KINDS.find((k) => k.id === kind)?.label ?? 'Porte';
}

export function brandLabel(brand) {
  return BRANDS.find((b) => b.id === brand)?.label ?? String(brand ?? '');
}

/** Où se trouve la porte : la zone, puis l'étage s'il est connu. */
export function doorPlaceText(door, floorName = '') {
  const zone = typeof door?.zone === 'string' && door.zone.trim() ? door.zone.trim() : 'Zone non renseignée';
  return floorName ? `${zone} · ${floorName}` : zone;
}

/** « Image en direct, pas l’enregistrement de 14:32. » (ou « du 12/10/2026 à 14:32 » si le passage n'est pas d'aujourd'hui). */
export function videoNoteText(ts, now) {
  if (!validTs(ts)) return 'Image en direct, pas l’enregistrement du passage.';
  const same = dayStart(ts) === dayStart(now);
  return same ? `Image en direct, pas l’enregistrement de ${formatClock(ts)}.` : `Image en direct, pas l’enregistrement du ${formatDate(ts)} à ${formatClock(ts)}.`;
}

// ---- Vidéo d'un passage : enregistrement (relecture) ou image en direct -------------------------------------------------

export const PLAYBACK_BEFORE_S = 10;
export const PLAYBACK_AFTER_S = 20;
/** Image vide (GIF 1x1) : y remplacer la source d'un flux le coupe côté serveur. */
const BLANK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Adresse de la relecture d'une caméra à l'heure du passage (le navigateur ne fournit que l'heure, en ms) ; null si invalide. */
export function playbackSrc(cameraId, ts) {
  if (typeof cameraId !== 'string' || cameraId === '' || !validTs(ts)) return null;
  const at = Math.trunc(ts);
  if (!Number.isSafeInteger(at) || at <= 0) return null;
  return `/api/cameras/${encodeURIComponent(cameraId)}/playback?at=${at}`;
}

/** « Enregistrement du 16/10/2026 à 14:32:05 (10 s avant à 20 s après). » */
export function playbackNoteText(ts) {
  const when = validTs(ts) ? ` du ${formatDate(ts)} à ${formatClockSeconds(ts)}` : ' du passage';
  return `Enregistrement${when} (${PLAYBACK_BEFORE_S} s avant à ${PLAYBACK_AFTER_S} s après).`;
}

/** Pourquoi on montre l'image en direct plutôt que l'enregistrement. */
export const LIVE_REASONS = {
  unsupported: 'Cette caméra ne permet pas la relecture depuis le PSIM.',
  unverified: 'Le PSIM n’a pas pu vérifier si cette caméra se relit : vous voyez la caméra telle qu’elle est maintenant.',
  'no-time': 'L’heure du passage n’est pas connue : la relecture est impossible.',
  failed: 'L’enregistrement n’a pas pu être lu : vous voyez la caméra telle qu’elle est maintenant.',
};

/** Message quand la relecture échoue (image en erreur) : aucun enregistrement à cette heure, ou enregistreur injoignable. */
export const PLAYBACK_FAILED_TEXT = 'L’enregistrement n’a pas pu être lu : aucun enregistrement à cette heure, ou l’enregistreur ne répond pas.';

export function liveReasonText(reason) {
  return LIVE_REASONS[reason] ?? LIVE_REASONS.unsupported;
}

/**
 * Ce que la fenêtre vidéo montrera pour chaque caméra liée à la porte : l'enregistrement (`replay`) si le serveur la
 * dit relisible (`replayableIds`, null = liste illisible) et si l'heure du passage est connue, sinon le direct avec sa
 * raison. `start` : la première caméra relisible (celle qu'on ouvre d'abord), sinon la première.
 */
export function planVideo(cameras, replayableIds, ts) {
  const known = Array.isArray(replayableIds) ? new Set(replayableIds.filter((id) => typeof id === 'string')) : null;
  const timeOk = playbackSrc('x', ts) !== null;
  const items = (Array.isArray(cameras) ? cameras : []).map((cam) => {
    const replay = known !== null && timeOk && known.has(cam.id);
    const reason = replay ? null : known === null ? 'unverified' : !timeOk ? 'no-time' : 'unsupported';
    return { ...cam, replay, reason };
  });
  const first = items.findIndex((c) => c.replay);
  return { items, start: first < 0 ? 0 : first };
}

/**
 * Bandeau de la fenêtre vidéo : ce qui est à l'écran et pourquoi. `mode` : « playback » (enregistrement), « live »
 * (direct, avec la raison) ou « failed » (la relecture a échoué).
 */
export function videoBanner(mode, reason, ts, now) {
  if (mode === 'playback') return { kind: 'info', title: playbackNoteText(ts), detail: 'Image relue depuis l’enregistreur de la caméra ; elle peut mettre quelques secondes à apparaître.' };
  if (mode === 'failed') return { kind: 'warning', title: 'Enregistrement indisponible.', detail: PLAYBACK_FAILED_TEXT };
  return { kind: 'warning', title: videoNoteText(ts, now), detail: liveReasonText(reason) };
}

// ================================================================================================ filtres du journal

export function defaultFilters(now) {
  return { ...quickRange('today', now), door: '', holder: '', credential: '', result: '', late: false };
}

/** Vrai si un filtre autre que la période est posé (état vide : « aucun passage ne correspond »). */
export function hasNarrowingFilter(filters) {
  return Boolean(filters.door || filters.holder?.trim() || filters.credential?.trim() || filters.result || filters.late);
}

/** Vrai si la recherche porte sur une personne : le serveur l'inscrit au journal infalsifiable. */
export function hasPersonalFilter(filters) {
  return Boolean(filters.holder?.trim() || filters.credential?.trim());
}

/** Nombre de filtres posés dans le bloc « Plus de filtres » (nom, badge, reçus après coupure) : signalé sur son bouton. */
export function hiddenFilterCount(filters) {
  return Number(Boolean(filters.holder?.trim())) + Number(Boolean(filters.credential?.trim())) + Number(Boolean(filters.late));
}

/** « Plus de filtres » ou « Plus de filtres (2) ». */
export function moreFiltersText(count) {
  return count > 0 ? `${MORE_FILTERS_LABEL} (${count})` : MORE_FILTERS_LABEL;
}

/**
 * Ce qui empêche la recherche : [{ field, message }], dans l'ordre de l'écran. Vide = tout va bien. Une date vide (ou
 * incomplète : le champ ne rend alors rien) est refusée : chercher sans borne relirait tout le journal.
 */
export function filterProblems(filters) {
  const problems = [];
  const from = filters.from ? fromInputValue(filters.from) : null;
  const to = filters.to ? fromInputValue(filters.to) : null;
  if (!filters.from && !filters.to) problems.push({ field: 'from', message: 'Les dates de début et de fin sont vides : choisissez la période à chercher.' });
  else if (!filters.from) problems.push({ field: 'from', message: 'La date de début est vide ou incomplète : choisissez un jour et une heure.' });
  else if (!filters.to) problems.push({ field: 'to', message: 'La date de fin est vide ou incomplète : choisissez un jour et une heure.' });
  if (filters.from && from === null) problems.push({ field: 'from', message: 'La date de début n’est pas valide : choisissez un jour et une heure.' });
  if (filters.to && to === null) problems.push({ field: 'to', message: 'La date de fin n’est pas valide : choisissez un jour et une heure.' });
  if (from !== null && to !== null && from > to) problems.push({ field: 'from', message: 'La date de début est après la date de fin : corrigez l’une des deux.' });
  if (filters.door && !ID_PATTERN.test(filters.door)) problems.push({ field: 'door', message: 'Porte inconnue : choisissez une porte dans la liste.' });
  if ((filters.holder ?? '').trim().length > MAX_HOLDER) problems.push({ field: 'holder', message: `Le nom cherché est trop long : ${MAX_HOLDER} caractères au plus.` });
  if ((filters.credential ?? '').trim().length > MAX_CREDENTIAL) problems.push({ field: 'credential', message: `Le numéro de badge est trop long : ${MAX_CREDENTIAL} caractères au plus.` });
  if (filters.result && filters.result !== 'granted' && filters.result !== 'denied') problems.push({ field: 'result', message: 'Résultat inconnu : choisissez Tous, Acceptés ou Refusés.' });
  return problems;
}

/**
 * Chaîne de requête de `GET /api/access/events` (et, sans `limit`, `cursor` ni `count`, de `events.csv`). Les champs vides
 * sont omis ; « Au » est inclus à la minute près, le serveur exclut sa borne. Ne produit rien d'invalide : filterProblems
 * dit pourquoi une saisie est refusée avant d'en arriver là.
 */
export function buildEventsQuery(filters, { limit = null, cursor = null, count = false } = {}) {
  const q = new URLSearchParams();
  const from = fromInputValue(filters.from);
  const to = fromInputValue(filters.to);
  if (from !== null) q.set('from', String(from));
  if (to !== null) q.set('to', String(to + 60_000));
  if (filters.door && ID_PATTERN.test(filters.door)) q.set('door', filters.door);
  const holder = (filters.holder ?? '').trim().slice(0, MAX_HOLDER);
  if (holder) q.set('holder', holder);
  const credential = (filters.credential ?? '').trim().slice(0, MAX_CREDENTIAL);
  if (credential) q.set('credential', credential);
  if (filters.result === 'granted' || filters.result === 'denied') q.set('result', filters.result);
  if (filters.late) q.set('late', '1');
  if (Number.isInteger(limit) && limit >= 1 && limit <= 200) q.set('limit', String(limit));
  if (typeof cursor === 'string' && cursor) q.set('cursor', cursor);
  if (count) q.set('count', '1');
  return q.toString();
}

// ================================================================================================ pagination par curseur

/**
 * Pile des curseurs du journal. Le serveur ne sait avancer que vers les passages plus anciens (`nextCursor`) : pour
 * revenir en arrière, l'écran garde les curseurs des pages déjà vues. Page 0 = la plus récente (curseur null).
 */
export function createCursorStack() {
  const past = []; // curseurs des pages vues avant la page courante
  let current = null;
  let next = null;
  return {
    get current() {
      return current;
    },
    get next() {
      return next;
    },
    get depth() {
      return past.length;
    },
    /** Retient le curseur de la page suivante rendu par le serveur (null sur la dernière page). */
    setNext(cursor) {
      next = typeof cursor === 'string' && cursor ? cursor : null;
    },
    canOlder: () => next !== null,
    canNewer: () => past.length > 0,
    /** Passe à la page des passages plus anciens ; renvoie son curseur (inchangé s'il n'y en a pas). */
    older() {
      if (next === null) return current;
      past.push(current);
      current = next;
      next = null;
      return current;
    },
    /** Revient à la page des passages plus récents ; renvoie son curseur. */
    newer() {
      if (past.length === 0) return current;
      current = past.pop();
      next = null;
      return current;
    },
    /** Retour à la première page (nouveaux filtres, actualisation complète). */
    reset() {
      past.length = 0;
      current = null;
      next = null;
    },
  };
}

// ================================================================================================ export CSV

export function exportFileName(now) {
  const d = new Date(now);
  return `passages-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
}

/** Nom de fichier proposé par le serveur (`Content-Disposition`), seulement s'il est sûr ; sinon null. */
export function fileNameFromDisposition(header) {
  const m = /filename\*?=(?:UTF-8'')?"?([A-Za-z0-9._-]{1,80})"?\s*(?:;|$)/i.exec(String(header ?? ''));
  return m && !m[1].startsWith('.') ? m[1] : null;
}

export function exportDoneText(rows, truncated) {
  if (truncated) return EXPORT_TRUNCATED_TEXT;
  if (Number.isFinite(rows) && rows >= 0) return rows === 0 ? 'Fichier enregistré, mais aucun passage ne correspond à ces filtres.' : `${plural(rows, 'passage exporté', 'passages exportés')} : le fichier est dans le dossier Téléchargements.`;
  return 'Le fichier est dans le dossier Téléchargements.';
}

// ================================================================================================ sous-route

/**
 * Lit la sous-route de l'écran (ce qui suit « #/acces/ ») : `journal?door=P1&result=denied&late=1`, `portes`, `portes/P1`
 * ou `declaration`. Tolère les entrées bizarres (jamais d'exception) ; ne rend que des valeurs sûres.
 */
export function parseRoute(sub) {
  let text = String(sub ?? '').trim();
  text = text.replace(/^#/, '').replace(/^\/+/, '').replace(/^acces(\/|$)/, '');
  const cut = text.indexOf('?');
  const path = cut < 0 ? text : text.slice(0, cut);
  const query = cut < 0 ? '' : text.slice(cut + 1);
  const segments = path.split('/').filter(Boolean);
  const tab = TABS.find((t) => t.id === segments[0])?.id ?? (segments[0] === 'porte' ? 'portes' : null);
  const route = { tab, doorId: null, filters: {} };
  if (tab === 'portes' && segments[1] && ID_PATTERN.test(segments[1])) route.doorId = segments[1];
  let params;
  try {
    params = new URLSearchParams(query);
  } catch {
    params = new URLSearchParams();
  }
  const door = params.get('door');
  if (door && ID_PATTERN.test(door)) route.filters.door = door;
  const result = params.get('result');
  if (result === 'granted' || result === 'denied') route.filters.result = result;
  if (params.get('late') === '1') route.filters.late = true;
  return route;
}

/** Sous-route à afficher dans l'adresse. Jamais de nom ni de numéro de badge : seulement porte, résultat et « reçu après coupure ». */
export function buildRoute({ tab, doorId = null, filters = null }) {
  if (tab === 'portes') return doorId && ID_PATTERN.test(doorId) ? `portes/${doorId}` : 'portes';
  if (tab === 'declaration') return 'declaration';
  const q = new URLSearchParams();
  if (filters?.door && ID_PATTERN.test(filters.door)) q.set('door', filters.door);
  if (filters?.result === 'granted' || filters?.result === 'denied') q.set('result', filters.result);
  if (filters?.late) q.set('late', '1');
  const text = q.toString();
  return text ? `journal?${text}` : 'journal';
}

// ================================================================================================ portes

/** Rang d'une porte pour le tri : alarme en cours d'abord, puis l'ordre de gravité des états. */
export function doorRank(door) {
  if (door?.deviceStatus === 'alarm') return -1;
  const i = DOOR_ORDER.indexOf(door?.state);
  return i < 0 ? DOOR_ORDER.indexOf('unknown') : i;
}

/** Portes triées du plus urgent au plus calme (forcée, maintenue ouverte, hors ligne... fermée), puis par nom. */
export function sortDoors(doors) {
  return [...doors].sort((a, b) => doorRank(a) - doorRank(b) || String(a.name ?? a.detectorId).localeCompare(String(b.name ?? b.detectorId), 'fr') || String(a.detectorId).localeCompare(String(b.detectorId)));
}

/** « 4 portes : 1 forcée, 1 hors ligne, 2 fermées ». */
export function doorsSummary(doors) {
  if (doors.length === 0) return 'Aucune porte déclarée';
  const counts = new Map();
  for (const d of doors) {
    const key = DOOR_ORDER.includes(d.state) ? d.state : 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = DOOR_ORDER.filter((s) => counts.has(s)).map((s) => `${counts.get(s)} ${counts.get(s) > 1 ? STATE_WORDS[s][1] : STATE_WORDS[s][0]}`);
  return `${doors.length} ${doors.length > 1 ? 'portes' : 'porte'} : ${parts.join(', ')}`;
}

/** Nombre de portes qui demandent de l'attention (tout sauf fermée et ouverte). */
export function doorsNeedingAttention(doors) {
  return doors.filter((d) => d.deviceStatus === 'alarm' || ['forced', 'held_open', 'offline', 'fault'].includes(d.state)).length;
}

/** Détecteurs de catégorie `access` qu'aucune porte ne déclare : leurs passages sont reçus, mais la porte n'a pas d'état. */
export function undeclaredAccessDetectors(devices, doors) {
  const declared = new Set(Array.isArray(doors) ? doors.map((d) => d.detectorId) : [...doors.keys()]);
  return [...devices].filter((d) => d && d.kind === 'detector' && d.category === 'access' && !declared.has(d.id)).map((d) => ({ id: d.id, name: d.name ?? d.id, zone: d.zone ?? '' }));
}

/** « 5 minutes », « 90 secondes », « 1 h 30 min » : le délai de la porte, dit comme on le dirait. */
export function secondsText(s) {
  const n = Math.round(Number(s));
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 60) return `${n} ${n > 1 ? 'secondes' : 'seconde'}`;
  if (n < 3600) {
    const m = Math.floor(n / 60);
    const r = n % 60;
    if (r === 0) return `${m} ${m > 1 ? 'minutes' : 'minute'}`;
    return `${m} min ${r} s`;
  }
  const hh = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  return m === 0 ? `${hh} ${hh > 1 ? 'heures' : 'heure'}` : `${hh} h ${pad(m)} min`;
}

/** Délai « maintenue ouverte » saisi en minutes (« 5 », « 0,5 », « 1.5 ») -> secondes, ou le message qui explique. */
export function parseHeldDelay(text) {
  const t = String(text ?? '').trim();
  if (!/^\d+(?:[.,]\d+)?$/.test(t)) return { ok: false, message: 'Écrivez le délai en minutes, par exemple 5 (cinq minutes) ou 0,5 (trente secondes).' };
  const seconds = Math.round(Number(t.replace(',', '.')) * 60);
  if (seconds < HELD_MIN_S) return { ok: false, message: `Délai trop court : ${HELD_MIN_S} secondes au moins.` };
  if (seconds > HELD_MAX_S) return { ok: false, message: 'Délai trop long : 24 heures (1 440 minutes) au plus.' };
  return { ok: true, seconds };
}

/** Secondes -> minutes pour le champ (300 -> « 5 », 30 -> « 0,5 »). */
export function minutesInput(seconds) {
  const m = Math.round((Number(seconds) / 60) * 100) / 100;
  return Number.isFinite(m) ? String(m).replace('.', ',') : '';
}

/** Écart d'horloge d'un contrôleur (heure du contrôleur - heure du PSIM, en ms) : texte et ton. */
export function clockOffsetInfo(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return { tone: 'muted', warn: false, text: 'Pas encore mesuré', hint: 'Mesuré au premier passage reçu en direct.' };
  const abs = Math.abs(ms);
  if (abs < 1000) return { tone: 'ok', warn: false, text: 'À l’heure', hint: '' };
  const text = `${durationText(abs)} ${ms > 0 ? 'en avance' : 'en retard'}`;
  if (abs > CLOCK_WARN_MS) return { tone: 'warning', warn: true, text, hint: 'Plus de 2 minutes d’écart : faites régler l’heure du contrôleur.' };
  return { tone: 'ok', warn: false, text, hint: '' };
}

// ================================================================================================ formulaires de déclaration

export function emptyControllerForm() {
  return { id: '', name: '', brand: 'dahua', model: '', host: '', gatewayId: '', username: '', password: '' };
}

/** Formulaire d'un contrôleur existant : jamais d'identifiants (ils ne sont pas relus par le serveur). */
export function controllerFormFrom(c) {
  return { id: c.id ?? '', name: c.name ?? '', brand: c.brand ?? 'dahua', model: c.model ?? '', host: c.host ?? '', gatewayId: c.gatewayId ?? '', username: '', password: '' };
}

export function controllerProblems(form, { editing = false } = {}) {
  const problems = [];
  const name = form.name.trim();
  if (!editing && !ID_PATTERN.test(form.id.trim())) problems.push({ field: 'id', message: 'Identifiant invalide : 1 à 32 caractères, lettres, chiffres, - et _ (par exemple CTL-1).' });
  if (!name) problems.push({ field: 'name', message: 'Donnez un nom au contrôleur, pour le reconnaître (par exemple « Contrôleur entrée »).' });
  else if (name.length > MAX_NAME) problems.push({ field: 'name', message: `Nom trop long : ${MAX_NAME} caractères au plus.` });
  else if (FORBIDDEN_CHAR.test(name)) problems.push({ field: 'name', message: 'Le nom contient un caractère interdit (caractère de contrôle ou invisible).' });
  if (!BRANDS.some((b) => b.id === form.brand)) problems.push({ field: 'brand', message: 'Choisissez la marque du contrôleur.' });
  if (form.model.trim().length > MAX_MODEL) problems.push({ field: 'model', message: `Modèle trop long : ${MAX_MODEL} caractères au plus.` });
  else if (FORBIDDEN_CHAR.test(form.model)) problems.push({ field: 'model', message: 'Le modèle contient un caractère interdit.' });
  const host = form.host.trim();
  if (host && !HOST_PATTERN.test(host)) problems.push({ field: 'host', message: 'Adresse invalide : une adresse IP ou un nom de machine, sans http:// ni chemin (par exemple 192.168.1.50).' });
  const gw = form.gatewayId.trim();
  if (gw && !ID_PATTERN.test(gw)) problems.push({ field: 'gatewayId', message: 'Identifiant de passerelle invalide : lettres, chiffres, - et _ (32 caractères au plus).' });
  const hasUser = form.username !== '';
  const hasPass = form.password !== '';
  if (hasUser !== hasPass) problems.push({ field: hasUser ? 'password' : 'username', message: 'Renseignez l’identifiant ET le mot de passe du contrôleur, ou laissez les deux vides.' });
  else if (hasUser && (form.username.length > MAX_SECRET || form.password.length > MAX_SECRET)) problems.push({ field: form.username.length > MAX_SECRET ? 'username' : 'password', message: `Identifiants trop longs : ${MAX_SECRET} caractères au plus.` });
  return problems;
}

/**
 * Corps de la requête. Création : tous les champs renseignés. Modification : seulement ce qui a changé (« champs absents =
 * inchangés »), un champ facultatif vidé part en `null`. Les identifiants partent seulement s'ils sont saisis (remplacement).
 */
export function controllerBody(form, { editing = false, original = null } = {}) {
  const body = {};
  const name = form.name.trim();
  const model = form.model.trim();
  const host = form.host.trim();
  const gatewayId = form.gatewayId.trim();
  if (!editing) {
    body.id = form.id.trim();
    body.name = name;
    body.brand = form.brand;
    if (model) body.model = model;
    if (host) body.host = host;
    if (gatewayId) body.gatewayId = gatewayId;
  } else {
    if (name !== (original?.name ?? '')) body.name = name;
    if (form.brand !== original?.brand) body.brand = form.brand;
    if (model !== (original?.model ?? '')) body.model = model || null;
    if (host !== (original?.host ?? '')) body.host = host || null;
    if (gatewayId !== (original?.gatewayId ?? '')) body.gatewayId = gatewayId || null;
  }
  if (form.username !== '' && form.password !== '') body.credentials = { username: form.username, password: form.password };
  return body;
}

export function emptyDoorForm() {
  return { detectorId: '', controllerId: '', doorNo: '1', kind: 'door', emergencyExit: false, heldMinutes: minutesInput(HELD_DEFAULT_S), armWithZone: false };
}

export function doorFormFrom(door) {
  return {
    detectorId: door.detectorId ?? '',
    controllerId: door.controllerId ?? '',
    doorNo: String(door.doorNo ?? 1),
    kind: door.kind ?? 'door',
    emergencyExit: Boolean(door.emergencyExit),
    heldMinutes: minutesInput(door.heldAlarmAfterS ?? HELD_DEFAULT_S),
    armWithZone: Boolean(door.arming?.enabled),
  };
}

export function doorProblems(form, { editing = false, controllerIds = null } = {}) {
  const problems = [];
  if (!editing && !ID_PATTERN.test(form.detectorId)) problems.push({ field: 'detectorId', message: 'Choisissez le détecteur de la porte (catégorie « Contrôle d’accès »).' });
  if (!ID_PATTERN.test(form.controllerId) || (controllerIds && !controllerIds.includes(form.controllerId))) problems.push({ field: 'controllerId', message: 'Choisissez le contrôleur de la porte.' });
  const no = Number(form.doorNo);
  if (!Number.isInteger(no) || no < 1 || no > 4) problems.push({ field: 'doorNo', message: 'Le numéro de porte va de 1 à 4.' });
  if (!DOOR_KINDS.some((k) => k.id === form.kind)) problems.push({ field: 'kind', message: 'Choisissez le type : porte, portail, barrière ou tourniquet.' });
  const held = parseHeldDelay(form.heldMinutes);
  if (!held.ok) problems.push({ field: 'heldMinutes', message: held.message });
  return problems;
}

export function doorBody(form, { editing = false, original = null } = {}) {
  const held = parseHeldDelay(form.heldMinutes);
  const seconds = held.ok ? held.seconds : HELD_DEFAULT_S;
  const full = { controllerId: form.controllerId, doorNo: Number(form.doorNo), kind: form.kind, emergencyExit: Boolean(form.emergencyExit), heldAlarmAfterS: seconds };
  const arm = Boolean(form.armWithZone);
  if (!editing) return { detectorId: form.detectorId, ...full, ...(arm ? { armWithZone: true } : {}) };
  const body = {};
  if (arm !== Boolean(original?.armWithZone)) body.armWithZone = arm;
  if (full.controllerId !== original?.controllerId) body.controllerId = full.controllerId;
  if (full.doorNo !== original?.doorNo) body.doorNo = full.doorNo;
  if (full.kind !== original?.kind) body.kind = full.kind;
  if (full.emergencyExit !== Boolean(original?.emergencyExit)) body.emergencyExit = full.emergencyExit;
  if (full.heldAlarmAfterS !== original?.heldAlarmAfterS) body.heldAlarmAfterS = full.heldAlarmAfterS;
  return body;
}

/** Durée de conservation saisie -> jours, ou le message qui explique. */
export function parseRetention(text) {
  const t = String(text ?? '').trim();
  if (!/^\d{1,5}$/.test(t)) return { ok: false, message: `Écrivez un nombre entier de jours, de ${RETENTION_MIN} à ${formatInt(RETENTION_MAX)}.` };
  const days = Number(t);
  if (days < RETENTION_MIN) return { ok: false, message: `Trop court : ${RETENTION_MIN} jours au moins.` };
  if (days > RETENTION_MAX) return { ok: false, message: `Trop long : ${formatInt(RETENTION_MAX)} jours au plus (10 ans).` };
  return { ok: true, days };
}

/** Phrase sur la dernière purge : « Le 14/10/2026 à 03:00 : 4 200 passages supprimés. » */
export function lastPurgeText(purge, now) {
  if (!purge || !validTs(purge.at)) return 'Aucune purge pour l’instant.';
  const n = Number(purge.deleted);
  const what = Number.isFinite(n) ? (n === 0 ? 'aucun passage supprimé' : `${plural(n, 'passage supprimé', 'passages supprimés')}`) : 'purge effectuée';
  return `${capFirst(formatWhen(purge.at, now))} : ${what}.`;
}

// ================================================================================================ la vue

/**
 * @param {object} deps
 * @param {(path: string, opts?: object) => Promise<any>} deps.api  appel à l'API (core.js)
 * @param {Function} deps.h  créateur d'éléments (core.js) : tout le texte passe par textContent
 * @param {(message: string, kind?: string) => void} deps.toast  message éphémère
 * @param {() => ({ role: string, username?: string } | null)} deps.getMe  compte connecté
 * @param {object} deps.dialogs  fenêtre commune (account.js)
 * @param {((incident: object) => void) | null} [deps.goToAlarm]
 *   « Aller à l'alarme » : ouvre l'incident en cours sur Surveillance (app.js : même chemin qu'une nouvelle alarme).
 * @param {(() => void) | null} [deps.goToPlan]
 *   « Retour au plan » : ramène sur Surveillance, là où la porte a été choisie.
 * @returns {{ show: (container: HTMLElement, subRoute?: string) => Promise<void>, hide: () => void, openDoor: (id: string, o?: { origin?: string }) => void, reset: () => void }}
 */
export function createAccessView({ api, h, toast, getMe, dialogs, goToAlarm = null, goToPlan = null }) {
  let core = null; // core.js et account.js, chargés à la première ouverture (ils touchent à la page)
  let acc = null;
  let modulesPromise = null;
  const loadModules = () =>
    (modulesPromise ??= Promise.all([import('./core.js'), import('./account.js')])
      .then(([c, a]) => {
        core = c;
        acc = a;
      })
      .catch((err) => {
        modulesPromise = null; // une nouvelle ouverture réessaie
        throw err;
      }));

  const ico = (name, cls) => core.icon(name, cls);
  const isAdmin = () => getMe()?.role === 'admin';
  const now = () => Date.now();

  /** Tout ce que l'écran garde en mémoire. */
  const state = {
    visible: false,
    ready: false,
    builtFor: null,
    container: null,
    ui: null,
    tab: 'journal',
    pendingDoor: null,
    filters: null,
    journal: { stack: createCursorStack(), items: [], total: null, capped: false, loading: false, loaded: false, error: null, token: 0, loadedAt: 0 },
    doorsError: null,
    doorsLoadedAt: 0,
    settings: null,
    fiche: { id: null, data: null, error: null, loading: false, token: 0, version: 0, trigger: null, backTab: 'portes', loadedFor: null, cameraKey: '', viewer: null },
    last: new Map(), // idPorte -> { at, passage } : dernier passage, lu dans la fiche de la porte
    lastBusy: new Set(),
    decl: { controllers: null, controllersError: null, settingsError: null, form: null },
    videoOpen: false,
    videoEl: null,
    videoViewer: null,
    videoToken: 0, // numéro de la fenêtre vidéo : une réponse tardive d'une fenêtre fermée n'écrit rien
    showing: false, // show() est en cours (chargement des modules)
    lastAnnounced: null,
  };
  const viewers = new Set(); // flux de caméras ouverts par l'écran : tous arrêtés à la sortie
  let wired = false;
  let keyBound = false;
  let scrollBefore = 0;

  // ---------------------------------------------------------------------------------------------- petits outils

  const errText = (err) => {
    const m = String(err?.message ?? 'Erreur inconnue').trim();
    return /[.!?…]$/.test(m) ? m : `${m}.`;
  };

  function announce(text) {
    if (state.ui) state.ui.announce.textContent = text;
  }

  function errorNotice(title, err, retry) {
    const children = [h('p', {}, h('strong', { text: `${title} ` }), errText(err))];
    if (retry) children.push(h('div', { class: 'actions' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: retry }, ico('refresh'), 'Réessayer')));
    return h('div', { class: 'notice is-alarm acc-notice', role: 'alert' }, ico('state-alarm'), h('div', { class: 'acc-notice-body' }, ...children));
  }

  function infoNotice(kind, ...children) {
    const iconName = kind === 'warning' ? 'state-warning' : kind === 'ok' ? 'state-ok' : kind === 'alarm' ? 'state-alarm' : 'info';
    return h('div', { class: `notice is-${kind} acc-notice` }, ico(iconName), h('div', { class: 'acc-notice-body' }, ...children));
  }

  /** Ligne d'état (message d'action) : icône + mot, annoncée poliment. */
  function setStatus(el, kind, text) {
    if (!text) {
      el.replaceChildren();
      el.className = 'acc-status';
      return;
    }
    const iconName = kind === 'ok' ? 'state-ok' : kind === 'warning' ? 'state-warning' : kind === 'alarm' ? 'state-alarm' : 'info';
    el.className = `acc-status is-${kind}`;
    el.replaceChildren(ico(iconName, 'icon-sm'), h('span', { text }));
  }

  /**
   * Remplace le contenu d'un conteneur seulement si sa clé a changé. Les relevés réguliers (portes toutes les 15 s) ne
   * refont donc ni un message d'erreur (annoncé de nouveau à chaque fois), ni un bouton qui a le focus.
   */
  function setKeyed(el, key, build) {
    if (el.dataset.key === key) return false;
    el.dataset.key = key;
    el.replaceChildren(...[build()].flat().filter(Boolean));
    return true;
  }

  const stateInfo = (door) => core.DOOR_STATE[door?.state] ?? core.DOOR_STATE.unknown;
  const toneToPill = (tone) => ({ ok: 'is-ok', info: 'is-info', warning: 'is-warning', alarm: 'is-solid-alarm', muted: 'is-offline' })[tone] ?? 'is-offline';
  const toneToBlock = (tone) => ({ ok: 'is-ok', info: 'is-info', warning: 'is-warning', alarm: 'is-alarm', muted: 'is-offline' })[tone] ?? 'is-offline';

  function statePill(door) {
    const info = stateInfo(door);
    return h('span', { class: `pill ${toneToPill(info.tone)}` }, ico(info.icon), door?.stateLabel || info.label);
  }

  /** Pastille d'état du détecteur quand elle ajoute une information que l'état de la porte ne dit pas. */
  function alarmPill(door) {
    if (door?.deviceStatus === 'alarm' && door.state !== 'forced') return h('span', { class: 'pill is-solid-alarm' }, ico('state-alarm'), 'Alarme en cours');
    return null;
  }

  /**
   * « Aller à l'alarme » : pour une porte qui sonne (forcée, maintenue ouverte, détecteur en alarme) dont l'incident est en
   * cours. Le clic ouvre cet incident sur Surveillance, comme une nouvelle alarme (étage, caméras). Pas d'incident en
   * cours : pas de bouton qui ne mène nulle part.
   */
  function alarmButton(door, incident) {
    if (!incident) return null;
    const button = h('button', { class: 'btn btn-primary acc-alarm-go', type: 'button', 'aria-label': `Aller à l’alarme de la porte ${doorName(door)}` }, ico('state-alarm'), 'Aller à l’alarme');
    button.addEventListener('click', () => {
      // L'alarme a pu se clore depuis l'affichage : on relit l'incident au moment du clic.
      const live = incidentForDoor(core.S.doors.get(door.detectorId) ?? door, core.S.incidents);
      if (!live) {
        toast('Cette alarme n’est plus en cours.', 'ok');
        if (state.fiche.id) renderFiche();
        return;
      }
      if (goToAlarm) goToAlarm(live);
      else core.go('surveillance');
    });
    return button;
  }

  function floorNameOf(door) {
    const floors = core.S.floors ?? [];
    return floors.length > 1 && door?.floorId != null ? (floors.find((f) => f.id === door.floorId)?.name ?? '') : '';
  }

  const doorName = (door) => door?.name || door?.detectorId || '';
  const allDoors = () => [...core.S.doors.values()];
  const isDisplayed = (el) => Boolean(el && el.isConnected && el.getClientRects().length > 0);

  function field(label, control, hint = '') {
    return acc.field(h, label, control, hint);
  }

  function checkRow(control, label, hint = '') {
    const id = acc.uid('acc-hint');
    if (hint) control.setAttribute('aria-describedby', id);
    return h('div', { class: 'acc-check' }, h('label', { class: 'check' }, control, h('span', { text: label })), hint ? h('span', { class: 'hint', id, text: hint }) : null);
  }

  function select(options, value = '') {
    const el = h('select', {}, ...options.map((o) => h('option', { value: o.id, text: o.label })));
    el.value = value;
    return el;
  }

  // ---------------------------------------------------------------------------------------------- caméras en direct

  /**
   * Visionneuse : image en direct (composant caméra existant : live.js pour une caméra réelle, camera.js pour la
   * simulée) ou, pour une caméra marquée `replay` avec l'heure du passage (`atDevice`), enregistrement relu par le
   * serveur (`<img>` sur /api/cameras/<id>/playback). Un seul flux à la fois ; si la porte a plusieurs caméras, des
   * boutons choisissent laquelle regarder. `onMode({ mode, reason, cam })` prévient la fenêtre de ce qui est montré
   * (mode « playback », « live » ou « failed » : relecture en échec, le bouton « Voir l’image en direct » est proposé).
   */
  function createViewer(cameras, { atDevice = null, start = 0, onMode = null } = {}) {
    const canvas = h('canvas', { class: 'acc-viewer-canvas', role: 'img' });
    const img = h('img', { class: 'acc-viewer-canvas', alt: '' });
    img.hidden = true;
    const status = h('p', { class: 'acc-viewer-status', role: 'status' });
    status.hidden = true;
    const caption = h('p', { class: 'hint acc-viewer-caption' });
    const liveButton = h('button', { class: 'btn btn-sm', type: 'button' }, ico('camera', 'icon-sm'), 'Voir l’image en direct');
    const fallback = h('div', { class: 'actions' }, liveButton);
    fallback.hidden = true;
    const buttons = [];
    const forcedLive = new Set(); // caméras dont la relecture a échoué : on reste sur le direct
    let stop = null;
    let index = 0;
    let closed = false;

    function stopStream() {
      if (stop) {
        stop();
        viewers.delete(stop);
        stop = null;
      }
    }

    function showStatus(message, isError = false) {
      status.hidden = !message;
      status.textContent = message ?? '';
      status.classList.toggle('is-error', Boolean(message) && isError);
    }

    /** Relecture : le navigateur lit le flux multipart du serveur ; le couper = vider la source de l'image. */
    function startPlayback(cam, src) {
      canvas.hidden = true;
      img.hidden = false;
      img.setAttribute('alt', `Enregistrement : ${cam.name}`);
      let live = true;
      img.addEventListener('error', () => {
        if (!live) return;
        live = false;
        img.hidden = true;
        fallback.hidden = false;
        showStatus(PLAYBACK_FAILED_TEXT, true);
        onMode?.({ mode: 'failed', reason: 'failed', cam });
      });
      img.setAttribute('src', src);
      stop = () => {
        live = false;
        img.setAttribute('src', BLANK_IMAGE); // la source remplacée coupe la connexion au serveur (et donc ffmpeg)
      };
      viewers.add(stop);
    }

    function startLive(cam, device) {
      img.hidden = true;
      canvas.hidden = false;
      const onStatus = (message) => showStatus(message, /tentative/.test(message ?? ''));
      const isLive = device.streamKind === 'onvif' || device.streamKind === 'rtsp';
      stop = isLive ? startLiveCamera(canvas, { cameraId: cam.id, onStatus }) : startSimCamera(canvas, { label: cam.id, zone: device.zone, getFire: () => 0 });
      viewers.add(stop);
    }

    function play(i) {
      stopStream();
      if (closed) return;
      index = i;
      const cam = cameras[i];
      buttons.forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
      fallback.hidden = true;
      showStatus(null);
      const device = core.S.devices.get(cam.id);
      const src = cam.replay && !forcedLive.has(i) ? playbackSrc(cam.id, atDevice) : null;
      if (src && device) {
        caption.textContent = `Enregistrement de « ${cam.name} » (${PLAYBACK_BEFORE_S} s avant, ${PLAYBACK_AFTER_S} s après le passage).`;
        canvas.setAttribute('aria-label', `Enregistrement : ${cam.name}`);
        startPlayback(cam, src);
        onMode?.({ mode: 'playback', reason: null, cam });
        return;
      }
      const reason = forcedLive.has(i) ? 'failed' : (cam.reason ?? 'unsupported');
      caption.textContent = `Image en direct de « ${cam.name} ».`;
      canvas.setAttribute('aria-label', `Image en direct : ${cam.name}`);
      img.hidden = true;
      if (!device) {
        canvas.hidden = false;
        showStatus('Cette caméra n’existe plus dans le PSIM.');
        onMode?.({ mode: 'live', reason, cam });
        return;
      }
      startLive(cam, device);
      onMode?.({ mode: 'live', reason, cam });
    }

    liveButton.addEventListener('click', () => {
      forcedLive.add(index);
      play(index);
    });

    let picker = null;
    if (cameras.length > 1) {
      picker = h('div', { class: 'segmented acc-viewer-picker', role: 'group', 'aria-label': 'Caméra à regarder' });
      cameras.forEach((cam, i) => {
        const b = h('button', { type: 'button', 'aria-pressed': 'false', title: cam.replay ? 'Enregistrement du passage' : 'Image en direct' }, ico('camera', 'icon-sm'), h('span', { text: cam.name }));
        b.addEventListener('click', () => play(i));
        buttons.push(b);
        picker.append(b);
      });
    }
    const el = h('div', { class: 'acc-viewer' }, picker, h('div', { class: 'acc-viewer-stage' }, canvas, img, status), fallback, caption);
    play(Math.min(Math.max(Math.trunc(start) || 0, 0), cameras.length - 1));
    return {
      el,
      stop() {
        closed = true;
        stopStream();
      },
      get index() {
        return index;
      },
    };
  }

  function stopAllViewers() {
    for (const stop of [...viewers]) stop();
    viewers.clear();
  }

  /**
   * Fenêtre « Voir la vidéo » du journal. Elle s'ouvre tout de suite, demande au serveur quelles caméras se relisent
   * (une fois par ouverture), puis montre l'enregistrement du passage pour une caméra liée relisible, sinon l'image en
   * direct avec la raison. Le bandeau dit toujours ce qui est à l'écran.
   */
  async function openVideo(passage, cameras, opener) {
    const token = ++state.videoToken;
    const door = passage.doorName || passage.doorId;
    const banner = h('div', { class: 'notice is-info acc-notice', role: 'status' });
    const showBanner = ({ kind, title, detail }) => {
      banner.className = `notice is-${kind} acc-notice`;
      banner.replaceChildren(ico(kind === 'warning' ? 'state-warning' : 'info'), h('div', { class: 'acc-notice-body' }, h('p', {}, h('strong', { text: title })), detail ? h('p', { text: detail }) : null));
    };
    showBanner({ kind: 'info', title: 'Recherche de l’enregistrement du passage…', detail: '' });
    const actions = h('div', { class: 'actions dialog-actions' }, h('button', { class: 'btn btn-primary', type: 'button', 'data-autofocus': '', onclick: () => dialogs.close() }, 'Fermer'));
    const content = h('div', { class: 'acc-video' }, banner, actions);
    state.videoOpen = true;
    state.videoEl = content;
    state.videoViewer = null;
    dialogs.open(`Passage de ${formatClock(passage.atDevice)} — ${door}`, content, {
      onClose: () => {
        state.videoOpen = false;
        state.videoToken++;
        state.videoViewer?.stop();
        state.videoViewer = null;
        if (opener?.isConnected) opener.focus({ preventScroll: true });
      },
    });

    let replayableIds = null; // illisible : on le dit et on montre le direct
    try {
      const data = await api('/api/cameras/replayable');
      if (Array.isArray(data?.ids)) replayableIds = data.ids;
    } catch {
      replayableIds = null;
    }
    if (token !== state.videoToken || !state.videoOpen) return; // fermée (ou remplacée) pendant la lecture
    const plan = planVideo(cameras, replayableIds, passage.atDevice);
    const viewer = createViewer(plan.items, {
      atDevice: passage.atDevice,
      start: plan.start,
      onMode: ({ mode, reason }) => showBanner(videoBanner(mode, reason, passage.atDevice, now())),
    });
    state.videoViewer = viewer;
    content.insertBefore(viewer.el, actions);
  }

  // ---------------------------------------------------------------------------------------------- lecture des portes

  /** Relit les portes et prévient les autres écrans (même événement que core.loadDoors). Dit pourquoi si ça échoue. */
  async function readDoors() {
    try {
      const data = await api('/api/access/doors');
      const list = Array.isArray(data) ? data : (data?.doors ?? data?.items);
      if (!Array.isArray(list)) throw new Error('Réponse inattendue du PSIM');
      core.S.doors = new Map(list.map((d) => [d.detectorId, d]));
      state.doorsError = null;
      state.doorsLoadedAt = now();
      core.emit('doors', list);
      core.render.plan?.();
    } catch (err) {
      state.doorsError = err;
      if (state.visible) {
        renderDoors();
        renderDoorsError();
      }
    }
  }

  // ---------------------------------------------------------------------------------------------- construction

  function visibleTabs() {
    return TABS.filter((t) => !t.admin || isAdmin());
  }

  function build() {
    state.builtFor = getMe()?.username ?? null;
    const ui = { panes: {}, tabs: {}, j: {}, d: {}, f: {}, c: {} };
    state.ui = ui;
    ui.announce = h('p', { class: 'sr-only', 'aria-live': 'polite', role: 'status' });

    const tabList = h('div', { class: 'segmented acc-tabs', role: 'tablist', 'aria-label': 'Sections de l’écran Accès' });
    for (const tab of visibleTabs()) {
      const btn = h('button', { type: 'button', role: 'tab', id: `acc-tab-${tab.id}`, 'aria-controls': `acc-pane-${tab.id}`, 'aria-selected': 'false', tabindex: '-1' }, ico(tab.icon), h('span', { text: tab.label }));
      btn.addEventListener('click', () => selectTab(tab.id));
      btn.addEventListener('keydown', onTabKey);
      ui.tabs[tab.id] = btn;
      tabList.append(btn);
    }
    ui.tabList = tabList;

    ui.panes.journal = buildJournal();
    ui.panes.portes = buildDoors();
    if (isAdmin()) ui.panes.declaration = buildDeclaration();
    for (const [id, pane] of Object.entries(ui.panes)) {
      pane.id = `acc-pane-${id}`;
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', `acc-tab-${id}`);
      pane.classList.add('acc-pane');
      pane.hidden = true;
    }
    ui.fiche = buildFicheShell();
    ui.fiche.hidden = true;

    ui.root = h('div', { class: 'acc-root' }, ui.announce, tabList, ...Object.values(ui.panes), ui.fiche);
    state.filters = defaultFilters(now());
    writeForm(state.filters);
  }

  function onTabKey(e) {
    const ids = visibleTabs().map((t) => t.id);
    const at = ids.indexOf(state.tab);
    let to = null;
    if (e.key === 'ArrowRight') to = ids[(at + 1) % ids.length];
    else if (e.key === 'ArrowLeft') to = ids[(at - 1 + ids.length) % ids.length];
    else if (e.key === 'Home') to = ids[0];
    else if (e.key === 'End') to = ids[ids.length - 1];
    if (!to) return;
    e.preventDefault();
    selectTab(to);
    state.ui.tabs[to].focus();
  }

  // ---------------------------------------------------------------------------------------------- onglets et adresse

  /** Écrit la sous-route dans l'adresse, sans recharger ni empiler d'historique (jamais de donnée personnelle). */
  function syncRoute() {
    if (!state.visible || !location.hash.startsWith('#/acces')) return;
    const sub = buildRoute({ tab: state.tab, doorId: state.fiche.id, filters: state.filters });
    const target = `#/acces/${sub}`;
    if (location.hash !== target) history.replaceState(null, '', target);
  }

  function selectTab(id, { fromRoute = false } = {}) {
    const ui = state.ui;
    if (!ui.panes[id]) id = 'journal'; // onglet réservé ou inconnu
    if (state.fiche.id) closeFiche({ focus: false, tab: id });
    state.tab = id;
    for (const [tabId, btn] of Object.entries(ui.tabs)) {
      const on = tabId === id;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      ui.panes[tabId].hidden = !on;
    }
    if (id === 'journal') {
      const stale = !state.journal.loaded || now() - state.journal.loadedAt > 30_000;
      if (stale && !state.journal.loading && !fromRoute) loadJournal();
    } else if (id === 'portes') {
      renderDoors();
    } else if (id === 'declaration') {
      loadDeclaration();
    }
    syncRoute();
  }

  // ================================================================================================ onglet JOURNAL

  /** Largeur « téléphone » : le bloc « Plus de filtres » y est fermé par défaut, ouvert au-dessus. */
  const isPhone = () => {
    try {
      return Boolean(globalThis.matchMedia?.('(max-width: 600px)').matches);
    } catch {
      return false;
    }
  };

  function buildJournal() {
    const j = state.ui.j;
    j.from = h('input', { type: 'datetime-local', id: 'acc-from', step: '60' });
    j.to = h('input', { type: 'datetime-local', id: 'acc-to', step: '60' });
    j.door = h('select', { id: 'acc-door' });
    j.holder = h('input', { id: 'acc-holder', type: 'text', maxlength: String(MAX_HOLDER), autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search', placeholder: 'ex. Konan' });
    j.credential = h('input', { id: 'acc-credential', type: 'text', maxlength: String(MAX_CREDENTIAL), autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search', placeholder: 'ex. 0012345' });
    j.late = h('input', { type: 'checkbox', id: 'acc-late' });
    j.error = h('p', { class: 'form-error', role: 'alert' });
    j.periodError = h('p', { class: 'form-error', role: 'alert' }); // sous les dates : le message est là où l'on corrige
    j.result = ''; // résultat choisi : '' (tous), 'granted' ou 'denied'

    j.presetButtons = PRESETS.map((p) => {
      const b = h('button', { type: 'button', 'aria-pressed': 'false', 'data-preset': p.id, text: p.label });
      b.addEventListener('click', () => {
        const r = quickRange(p.id, now());
        j.from.value = r.from;
        j.to.value = r.to;
        applyFilters();
      });
      return b;
    });
    j.resultButtons = RESULT_CHOICES.map((c) => {
      const b = h('button', { type: 'button', 'aria-pressed': 'false', 'data-result': c.id, text: c.label });
      b.addEventListener('click', () => {
        j.result = c.id;
        applyFilters();
      });
      return b;
    });

    j.door.addEventListener('change', () => applyFilters());
    j.late.addEventListener('change', () => {
      updateMoreSummary();
      applyFilters();
    });
    // Une date modifiée relance la recherche (sans voler le focus : la personne est peut-être en train de saisir l'autre).
    for (const input of [j.from, j.to]) input.addEventListener('change', () => applyFilters({ focus: false }));
    // Nom et badge attendent « Rechercher » (ou Entrée) : chaque frappe n'envoie rien, et la recherche est inscrite au journal.
    for (const input of [j.holder, j.credential]) input.addEventListener('input', () => updateMoreSummary());

    j.exportHint = h('p', { class: 'hint acc-export-help', id: 'acc-export-help', text: `${EXPORT_LABEL} : ${EXPORT_HELP.charAt(0).toLowerCase()}${EXPORT_HELP.slice(1)}` });
    j.exportBtn = h('button', { class: 'btn', type: 'button', title: EXPORT_HELP, 'aria-describedby': 'acc-export-help' }, ico('download'), EXPORT_LABEL);
    j.exportBtn.addEventListener('click', () => exportCsv());
    j.refreshBtn = h('button', { class: 'btn btn-ghost', type: 'button' }, ico('refresh'), 'Actualiser');
    j.refreshBtn.addEventListener('click', () => {
      applyFilters();
    });
    j.clearBtn = h('button', { class: 'btn btn-ghost', type: 'button' }, ico('close'), 'Effacer les filtres');
    j.clearBtn.addEventListener('click', () => {
      writeForm(defaultFilters(now()));
      applyFilters();
      j.from.focus();
    });
    j.searchBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, ico('search'), 'Rechercher');

    // « Plus de filtres » : un vrai <details> (clavier : Tab, Entrée, Espace), fermé sur téléphone. Un filtre actif caché
    // dans le bloc fermé est signalé sur son titre : « Plus de filtres (2) ».
    j.moreText = h('span', { text: MORE_FILTERS_LABEL });
    j.more = h(
      'details',
      { class: 'acc-more' },
      h('summary', { class: 'acc-more-summary' }, ico('chevron-right', 'acc-more-chevron'), j.moreText),
      h(
        'div',
        { class: 'acc-more-body' },
        h('div', { class: 'acc-fields' }, field('Titulaire (nom)', j.holder, `Une partie du nom suffit. ${SEARCH_HINT}`), field('Numéro de badge', j.credential, `Le début du numéro suffit. ${SEARCH_HINT}`)),
        checkRow(j.late, 'Seulement les passages reçus après coupure', LATE_HELP),
      ),
    );
    j.more.open = !isPhone();

    const form = h(
      'form',
      { class: 'acc-filters', 'aria-label': 'Filtres du journal des passages', novalidate: true },
      h(
        'div',
        { class: 'acc-filter-group', role: 'group', 'aria-labelledby': 'acc-period-title' },
        h('h3', { id: 'acc-period-title', text: 'Période' }),
        h('div', { class: 'segmented acc-presets', role: 'group', 'aria-label': 'Raccourcis de période' }, ...j.presetButtons),
        h('div', { class: 'acc-fields' }, field('Du', j.from), field('Au (inclus)', j.to)),
        j.periodError,
        h('p', { class: 'hint', text: PERIOD_HINT }),
      ),
      h(
        'div',
        { class: 'acc-filter-group', role: 'group', 'aria-labelledby': 'acc-what-title' },
        h('h3', { id: 'acc-what-title', text: 'Porte et résultat' }),
        h(
          'div',
          { class: 'acc-fields acc-fields-inline' },
          field('Porte', j.door),
          h('div', { class: 'field' }, h('span', { id: 'acc-result-label', text: 'Résultat' }), h('div', { class: 'segmented', role: 'group', 'aria-labelledby': 'acc-result-label' }, ...j.resultButtons)),
        ),
      ),
      j.more,
      j.error,
      h('div', { class: 'actions' }, j.searchBtn, j.clearBtn, h('span', { class: 'acc-spacer' }), j.refreshBtn, j.exportBtn),
      j.exportHint,
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      applyFilters();
    });
    j.form = form;

    j.status = h('p', { class: 'acc-status', role: 'status' });
    j.note = h('p', { class: 'panel-note acc-privacy' }, ico('lock', 'icon-sm'), h('span', { text: JOURNAL_NOTE }));
    j.retention = h('span', { class: 'acc-retention' });
    j.note.append(j.retention);

    j.total = h('p', { class: 'acc-total', tabindex: '-1' });
    j.range = h('p', { class: 'acc-range' });
    j.loadedAt = h('p', { class: 'hint acc-loaded-at' });
    j.head = h('div', { class: 'acc-results-head' }, h('div', { class: 'acc-results-count' }, j.total, j.range), j.loadedAt);
    j.tbody = h('tbody');
    j.table = h(
      'table',
      { class: 'data acc-stack acc-journal-table' },
      h('caption', { class: 'sr-only', text: 'Passages enregistrés par les boîtiers de contrôle d’accès, du plus récent au plus ancien' }),
      h('thead', {}, h('tr', {}, ...['Date et heure', 'Porte', 'Entrée / sortie', 'Titulaire', 'Moyen d’accès', 'Résultat', 'Vidéo'].map((t) => h('th', { scope: 'col', text: t })))),
      j.tbody,
    );
    j.tableWrap = h('div', { class: 'table-scroll acc-tablewrap' }, j.table);
    j.message = h('div', { class: 'acc-message' });
    j.newer = h('button', { class: 'btn', type: 'button' }, ico('chevron-left'), 'Plus récents');
    j.older = h('button', { class: 'btn', type: 'button' }, 'Plus anciens', ico('chevron-right'));
    j.pageText = h('span', { class: 'acc-page-text' });
    j.newer.addEventListener('click', () => changePage('newer'));
    j.older.addEventListener('click', () => changePage('older'));
    j.pager = h('nav', { class: 'acc-pager', 'aria-label': 'Pages du journal' }, j.newer, j.pageText, j.older);
    j.results = h('div', { class: 'acc-results', 'aria-busy': 'false' }, j.head, j.message, j.tableWrap, j.pager);

    return h('section', { class: 'panel acc-panel', 'aria-label': 'Journal des passages' }, h('div', { class: 'panel-body' }, h('h2', { class: 'sr-only', text: 'Journal des passages' }), form, j.note, j.status, j.results));
  }

  /** Titre du bloc « Plus de filtres » : le nombre de filtres posés s'y lit même quand le bloc est fermé. */
  function updateMoreSummary() {
    const j = state.ui?.j;
    if (!j?.moreText) return;
    j.moreText.textContent = moreFiltersText(hiddenFilterCount(readForm()));
  }

  /** Remplit le formulaire à partir d'un objet de filtres. */
  function writeForm(filters) {
    const j = state.ui.j;
    j.from.value = filters.from ?? '';
    j.to.value = filters.to ?? '';
    fillDoorSelect(filters.door ?? '');
    j.holder.value = filters.holder ?? '';
    j.credential.value = filters.credential ?? '';
    j.result = filters.result ?? '';
    j.late.checked = Boolean(filters.late);
    updateResultButtons();
    updatePresetButtons();
    updateMoreSummary();
  }

  function readForm() {
    const j = state.ui.j;
    return { from: j.from.value, to: j.to.value, door: j.door.value, holder: j.holder.value, credential: j.credential.value, result: j.result, late: j.late.checked };
  }

  function updateResultButtons() {
    const j = state.ui.j;
    for (const b of j.resultButtons) b.setAttribute('aria-pressed', String(b.dataset.result === j.result));
  }

  function updatePresetButtons() {
    const j = state.ui.j;
    const active = matchPreset(readForm(), now());
    for (const b of j.presetButtons) b.setAttribute('aria-pressed', String(b.dataset.preset === active));
  }

  /** Liste des portes du filtre : celles du PSIM, plus la porte demandée par l'adresse si elle n'y est plus. */
  function fillDoorSelect(value = null) {
    const j = state.ui.j;
    const keep = value ?? j.door.value;
    const doors = allDoors().sort((a, b) => String(doorName(a)).localeCompare(String(doorName(b)), 'fr'));
    const options = [h('option', { value: '', text: 'Toutes les portes' }), ...doors.map((d) => h('option', { value: d.detectorId, text: doorName(d) }))];
    if (keep && !doors.some((d) => d.detectorId === keep)) options.push(h('option', { value: keep, text: `${keep} (porte retirée)` }));
    j.door.replaceChildren(...options);
    j.door.value = keep;
  }

  /**
   * Valide, mémorise les filtres, revient à la première page et relit le journal. Refusée, la recherche dit pourquoi
   * (message annoncé) ; avec `focus: false`, le focus ne va pas au champ fautif (une date modifiée pendant la saisie).
   */
  function applyFilters({ focus = true } = {}) {
    const j = state.ui.j;
    updateResultButtons();
    updatePresetButtons();
    updateMoreSummary();
    const filters = readForm();
    const problems = filterProblems(filters);
    for (const el of j.form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
    j.periodError.textContent = '';
    j.error.textContent = '';
    if (problems.length) {
      const first = problems[0];
      (first.field === 'from' || first.field === 'to' ? j.periodError : j.error).textContent = first.message;
      const target = { from: j.from, to: j.to, door: j.door, holder: j.holder, credential: j.credential }[first.field];
      if (target) {
        target.setAttribute('aria-invalid', 'true');
        if (j.more.contains(target)) j.more.open = true; // le champ fautif ne reste pas caché dans le bloc fermé
        if (focus) target.focus();
      }
      return false;
    }
    state.filters = filters;
    state.journal.stack.reset();
    updatePresetButtons();
    syncRoute();
    loadJournal();
    return true;
  }

  async function loadJournal() {
    const jr = state.journal;
    const stack = jr.stack;
    const token = ++jr.token;
    jr.loading = true;
    jr.error = null;
    renderJournal();
    const countPage = stack.depth === 0;
    try {
      const query = buildEventsQuery(state.filters, { limit: PAGE_SIZE, cursor: stack.current, count: countPage });
      const data = await api(`/api/access/events?${query}`);
      if (token !== jr.token) return; // une recherche plus récente (ou la sortie de l'écran) a pris la main
      jr.items = Array.isArray(data?.items) ? data.items : [];
      stack.setNext(data?.nextCursor);
      if (countPage) {
        jr.total = typeof data?.total === 'number' ? data.total : null;
        jr.capped = Boolean(data?.totalCapped);
      }
      jr.loaded = true;
      jr.loadedAt = now();
    } catch (err) {
      if (token !== jr.token) return;
      jr.error = err;
    }
    jr.loading = false;
    renderJournal();
    const total = totalText(jr.total, jr.capped);
    if (!jr.error) announce(jr.items.length ? `${total ? `${total}. ` : ''}${rangeText(stack.depth, PAGE_SIZE, jr.items.length, jr.total, jr.capped)}.` : 'Aucun passage pour ces filtres.');
  }

  function changePage(direction) {
    const stack = state.journal.stack;
    if (direction === 'older') stack.older();
    else stack.newer();
    loadJournal().then(() => {
      const j = state.ui.j;
      const active = document.activeElement;
      if (!active || active === document.body || active.disabled) j.total.focus({ preventScroll: true });
      j.head.scrollIntoView?.({ block: 'nearest' });
    });
  }

  /**
   * Résultat d'un passage : une pastille courte (forme + icône + mot : « Refusé »), la raison à côté, hors de la pastille
   * (« Badge inconnu »), et « Reçu après coupure » s'il y a lieu. Le nom lu par les lecteurs d'écran est le libellé complet
   * du serveur (« Refusé — badge inconnu ») ; le visible est masqué pour eux afin de ne pas se répéter.
   */
  function resultBlock(p) {
    const parts = resultParts(p);
    return h(
      'div',
      { class: 'acc-cell-stack' },
      h('span', { class: `pill ${resultTone(p) === 'ok' ? 'is-ok' : 'is-warning'}`, 'aria-hidden': 'true' }, ico(resultIcon(p)), parts.word),
      parts.reason ? h('span', { class: 'acc-sub acc-reason', 'aria-hidden': 'true', text: parts.reason }) : null,
      h('span', { class: 'sr-only', text: parts.full }),
      p.late ? h('span', { class: 'tag is-info', title: LATE_TITLE }, ico('clock', 'icon-sm'), LATE_LABEL) : null,
    );
  }

  function passageRow(p) {
    const t = now();
    const stamp = passageStamp(p.atDevice, t);
    const door = core.S.doors.get(p.doorId);
    const cameras = Array.isArray(door?.cameraIds) ? door.cameraIds : [];
    // Le nom de la porte mène à ses détails (retour au journal) quand la porte existe encore.
    let doorCell = h('strong', { text: p.doorName || p.doorId || '—' });
    if (door && ID_PATTERN.test(String(p.doorId))) {
      const link = h('button', { class: 'acc-door-link', type: 'button', 'aria-label': `Détails de la porte ${p.doorName || p.doorId}` }, h('strong', { text: p.doorName || p.doorId }));
      link.addEventListener('click', () => openFiche(p.doorId, { trigger: link, backTab: 'journal' }));
      doorCell = link;
    }
    const resultCell = h('td', { 'data-label': 'Résultat', class: 'acc-result' }, resultBlock(p), armingNoteEl(p));
    let videoCell;
    if (cameras.length) {
      // Bouton discret : « Vidéo » à l'écran, la phrase complète pour les lecteurs d'écran ; la fenêtre dit laquelle des deux
      // images (enregistrement ou direct) elle montre.
      const opener = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': `Voir la vidéo du passage de ${formatClock(p.atDevice)}`, title: 'Enregistrement du passage si la caméra le permet, sinon image en direct' }, ico('camera'), 'Vidéo');
      opener.addEventListener('click', () => {
        const ids = core.S.doors.get(p.doorId)?.cameraIds ?? cameras; // les caméras liées ont pu changer depuis l'affichage
        openVideo(p, ids.map((id) => ({ id, name: core.S.devices.get(id)?.name ?? id })), opener);
      });
      videoCell = h('td', { 'data-label': 'Vidéo', class: 'acc-video-cell' }, opener);
    } else {
      videoCell = h(
        'td',
        { 'data-label': 'Vidéo', class: 'acc-video-cell' },
        h('div', { class: 'acc-cell-stack' }, h('span', { class: 'muted', text: door ? 'Pas de caméra liée' : 'Porte retirée : pas de caméra' }), door && isAdmin() ? h('a', { class: 'acc-link', href: '#/equipements' }, 'Lier une caméra') : null),
      );
    }
    return h(
      'tr',
      { 'data-passage': String(p.id ?? '') },
      h(
        'td',
        { 'data-label': 'Date et heure', class: 'acc-when' },
        h('time', { datetime: isoOrEmpty(p.atDevice), title: `Heure de la porte. Reçu par le PSIM ${formatWhen(p.atReceived, t, { seconds: true })}.` }, h('strong', { text: stamp.time }), h('span', { class: 'acc-sub', text: stamp.day })),
      ),
      h('td', { 'data-label': 'Porte' }, h('div', { class: 'acc-cell-stack' }, doorCell, p.doorName ? null : h('span', { class: 'tag is-dashed', text: 'Porte retirée' }))),
      h('td', { 'data-label': 'Entrée / sortie', text: directionLabel(p.direction) }),
      h(
        'td',
        { 'data-label': 'Titulaire' },
        h('div', { class: 'acc-cell-stack' }, h('strong', { class: p.holderName ? '' : 'muted', text: holderLine(p) }), badgeLine(p) ? h('span', { class: 'acc-sub mono', text: badgeLine(p) }) : null, p.holderRef ? h('span', { class: 'acc-sub', text: `N° de personne ${p.holderRef}` }) : null),
      ),
      h('td', { 'data-label': 'Moyen d’accès', text: p.methodLabel || '—' }),
      resultCell,
      videoCell,
    );
  }

  function renderJournal() {
    const j = state.ui?.j;
    if (!j || !j.tbody) return;
    const jr = state.journal;
    j.results.setAttribute('aria-busy', String(jr.loading));
    j.results.classList.toggle('is-loading', jr.loading && jr.loaded);
    const has = jr.items.length > 0;
    const showTable = has && !jr.error;

    // Le total vient de la première page ; sans lui (réponse sans `total`), une première page incomplète se compte seule.
    const known = jr.total ?? (jr.stack.depth === 0 && !jr.stack.canOlder() && jr.loaded ? jr.items.length : null);
    j.total.textContent = jr.error ? '' : jr.loading ? 'Recherche en cours…' : jr.loaded ? totalText(known, jr.total !== null && jr.capped) : '';
    j.range.textContent = jr.error || jr.loading ? '' : rangeText(jr.stack.depth, PAGE_SIZE, jr.items.length, known, jr.total !== null && jr.capped);
    j.loadedAt.textContent = jr.loadedAt ? `Liste lue à ${formatClockSeconds(jr.loadedAt)}.` : '';

    if (jr.error) {
      setKeyed(j.message, `erreur|${jr.error.message}`, () => errorNotice('Le journal n’a pas pu être lu.', jr.error, () => loadJournal()));
    } else if (jr.loaded && !has && !jr.loading) {
      setKeyed(j.message, `vide|${hasNarrowingFilter(state.filters)}|${isAdmin()}`, () => emptyJournal());
    } else if (!jr.loaded) {
      setKeyed(j.message, `attente|${jr.loading}`, () => h('p', { class: 'muted', text: jr.loading ? 'Chargement des passages…' : '' }));
    } else {
      setKeyed(j.message, 'rien', () => null);
    }
    j.tableWrap.hidden = !showTable;
    j.pager.hidden = !showTable && !jr.stack.canNewer();
    // Les lignes ne sont reconstruites que si la liste a changé, ou si les caméras liées aux portes ont changé (« Voir la
    // vidéo » en dépend et les portes peuvent arriver après le journal) : pas à chaque relevé, le focus reste en place.
    const cameraKey = jr.items.map((p) => (core.S.doors.get(p.doorId)?.cameraIds ?? []).join(',')).join('|');
    if (showTable && (j.renderedItems !== jr.items || j.renderedCameras !== cameraKey)) {
      j.renderedItems = jr.items;
      j.renderedCameras = cameraKey;
      j.tbody.replaceChildren(...jr.items.map(passageRow));
    }
    j.newer.disabled = !jr.stack.canNewer() || jr.loading;
    j.older.disabled = !jr.stack.canOlder() || jr.loading;
    j.pageText.textContent = showTable ? `Page ${jr.stack.depth + 1}` : '';
  }

  function emptyJournal() {
    const narrowed = hasNarrowingFilter(state.filters);
    const actions = [];
    if (narrowed) {
      const clear = h('button', { class: 'btn btn-sm', type: 'button' }, ico('close'), 'Effacer les filtres');
      clear.addEventListener('click', () => {
        writeForm(defaultFilters(now()));
        applyFilters();
      });
      actions.push(clear);
    } else if (isAdmin()) {
      const go = h('button', { class: 'btn btn-sm', type: 'button' }, ico('sliders'), 'Ouvrir la déclaration');
      go.addEventListener('click', () => selectTab('declaration'));
      actions.push(go);
    }
    return h(
      'div',
      { class: 'empty' },
      ico('list'),
      h('strong', { text: narrowed ? 'Aucun passage ne correspond à ces filtres.' : 'Aucun passage sur cette période.' }),
      h('span', { text: narrowed ? 'Élargissez la période ou retirez un filtre, puis relancez la recherche.' : isAdmin() ? 'Les passages arrivent des boîtiers de contrôle d’accès déclarés dans l’onglet Déclaration.' : 'Les passages arrivent des boîtiers de contrôle d’accès du site. Un administrateur les déclare.' }),
      actions.length ? h('div', { class: 'actions' }, ...actions) : null,
    );
  }

  /** Export CSV : mêmes filtres que la liste ; le serveur l'inscrit au journal. Dit si le fichier a été tronqué. */
  async function exportCsv() {
    const j = state.ui.j;
    if (!applyFilters()) return;
    const btn = j.exportBtn;
    acc.setBusy(btn, true);
    setStatus(j.status, 'info', 'Préparation du fichier…');
    try {
      const res = await fetch(`/api/access/events.csv?${buildEventsQuery(state.filters)}`, { credentials: 'same-origin' });
      if (res.status === 401) {
        core.emit('unauthorized');
        throw new Error('Session expirée, reconnectez-vous');
      }
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Erreur ${res.status}`);
      }
      const rowsHeader = res.headers.get('X-Export-Rows');
      const rows = rowsHeader === null ? Number.NaN : Number(rowsHeader);
      const truncated = res.headers.get('X-Export-Truncated') === '1';
      const blob = await res.blob();
      const name = fileNameFromDisposition(res.headers.get('Content-Disposition')) ?? exportFileName(now());
      const url = URL.createObjectURL(blob);
      const link = h('a', { href: url, download: name });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setStatus(j.status, truncated ? 'warning' : 'ok', exportDoneText(rows, truncated));
      if (truncated) toast(EXPORT_TRUNCATED_TEXT);
    } catch (err) {
      setStatus(j.status, 'alarm', `L’export n’a pas pu être fait : ${errText(err)}`);
    } finally {
      acc.setBusy(btn, false);
    }
  }

  // ================================================================================================ onglet PORTES

  function buildDoors() {
    const d = state.ui.d;
    d.summary = h('p', { class: 'acc-doors-summary' }); // annoncé par la zone vocale de l'écran (announce), une fois par changement
    d.updated = h('p', { class: 'hint acc-doors-updated' });
    d.refresh = h('button', { class: 'btn btn-ghost', type: 'button' }, ico('refresh'), 'Actualiser');
    d.refresh.addEventListener('click', async () => {
      acc.setBusy(d.refresh, true);
      await readDoors();
      acc.setBusy(d.refresh, false);
      renderDoors();
    });
    d.list = h('ul', { class: 'acc-doors', 'aria-label': 'Portes, les plus urgentes d’abord' });
    d.message = h('div', { class: 'acc-message' });
    d.cards = new Map();
    return h(
      'section',
      { class: 'acc-doors-pane', 'aria-label': 'Portes' },
      h('h2', { class: 'sr-only', text: 'Portes' }),
      h('div', { class: 'acc-doors-head' }, h('div', {}, d.summary, d.updated), d.refresh),
      // Dit une fois pour toutes ce qu'est le contrôleur, avant la première carte qui en parle.
      h('p', { class: 'panel-note' }, ico('info', 'icon-sm'), h('span', { text: `Le ${CONTROLLER_LONG} décide seul d’ouvrir la porte pour un badge. Le PSIM enregistre les passages et surveille l’état des portes.` })),
      d.message,
      d.list,
    );
  }

  function renderDoorsError() {
    const d = state.ui?.d;
    if (!d || !d.message) return;
    if (state.doorsError) setKeyed(d.message, `erreur|${state.doorsError.message}`, () => errorNotice('L’état des portes n’a pas pu être lu.', state.doorsError, async () => { await readDoors(); renderDoors(); }));
    else setKeyed(d.message, 'rien', () => null);
  }

  /** Une carte par porte. Mise à jour sur place (le focus clavier reste sur le bouton), ordre du plus urgent au plus calme. */
  function renderDoors() {
    const d = state.ui?.d;
    if (!d || !d.list) return;
    const doors = sortDoors(allDoors());
    const summary = doorsSummary(doors);
    if (d.summary.textContent !== summary) d.summary.textContent = summary;
    d.updated.textContent = state.doorsLoadedAt ? `État relevé à ${formatClockSeconds(state.doorsLoadedAt)}.` : '';
    renderDoorsError();

    if (doors.length === 0) {
      for (const card of d.cards.values()) card.li.remove();
      d.cards.clear();
      if (!state.doorsError) setKeyed(d.message, `vide|${isAdmin()}|${undeclaredAccessDetectors(core.S.devices.values(), core.S.doors).length}`, () => emptyDoors());
      return;
    }
    const seen = new Set();
    doors.forEach((door, i) => {
      seen.add(door.detectorId);
      let card = d.cards.get(door.detectorId);
      if (!card) {
        card = createDoorCard(door);
        d.cards.set(door.detectorId, card);
      }
      updateDoorCard(card, door);
      if (d.list.children[i] !== card.li) d.list.insertBefore(card.li, d.list.children[i] ?? null);
    });
    for (const [id, card] of [...d.cards]) {
      if (!seen.has(id)) {
        card.li.remove();
        d.cards.delete(id);
      }
    }
    ensureLastPassages(doors);
  }

  function emptyDoors() {
    const admin = isAdmin();
    const undeclared = undeclaredAccessDetectors(core.S.devices.values(), core.S.doors);
    const go = admin ? h('button', { class: 'btn btn-sm btn-primary', type: 'button' }, ico('sliders'), 'Ouvrir la déclaration') : null;
    go?.addEventListener('click', () => selectTab('declaration'));
    return h(
      'div',
      { class: 'empty' },
      ico('door'),
      h('strong', { text: 'Aucune porte déclarée pour l’instant.' }),
      h('span', { text: admin ? 'Déclarez d’abord un contrôleur, puis chaque porte, dans l’onglet Déclaration. Les détecteurs de catégorie « Contrôle d’accès » se créent dans Équipements et plan.' : 'Un administrateur déclare les contrôleurs et les portes dans l’onglet Déclaration.' }),
      undeclared.length ? h('span', { text: `${plural(undeclared.length, 'détecteur de contrôle d’accès attend', 'détecteurs de contrôle d’accès attendent')} d’être rattaché${undeclared.length > 1 ? 's' : ''} à un contrôleur.` }) : null,
      go,
    );
  }

  function createDoorCard(door) {
    const title = h('h3', { class: 'acc-door-title' });
    const states = h('div', { class: 'acc-door-states' });
    const hint = h('p', { class: 'acc-door-hint' });
    const facts = h('dl', { class: 'acc-facts' });
    const open = h('button', { class: 'btn', type: 'button', 'data-door-trigger': door.detectorId }, ico('door'), 'Détails de la porte');
    open.addEventListener('click', () => openFiche(door.detectorId, { trigger: open, backTab: 'portes' }));
    const passages = h('button', { class: 'btn btn-ghost', type: 'button' }, ico('list'), 'Voir les passages');
    passages.addEventListener('click', () => showJournalForDoor(door.detectorId));
    const li = h('li', { class: 'acc-door', 'data-door': door.detectorId }, h('div', { class: 'acc-door-head' }, title, states), hint, facts, h('div', { class: 'actions' }, open, passages));
    return { li, title, states, hint, facts, open, passages, sig: '' };
  }

  function fact(label, ...value) {
    return [h('dt', { text: label }), h('dd', {}, ...value)];
  }

  /** Ligne « Armement avec la zone » de la fiche (rien si le serveur ne fournit pas l'information). */
  function armingFact(door) {
    const info = armingFactInfo(door);
    if (!info) return [];
    const mark = info.attached ? h('span', { class: `tag ${info.armed === true ? 'is-warning' : 'is-info'} acc-arming-tag` }, ico('shield', 'icon-sm'), info.armed === true ? 'Armée' : info.armed === false ? 'Désarmée' : 'Rattachée') : null;
    return fact('Armement avec la zone', h('span', { class: 'acc-arming-fact' }, mark, h('span', { text: info.text }), info.attached ? h('a', { class: 'acc-link', href: '#/armement' }, 'Ouvrir l’écran Armement') : null));
  }

  /** Note d'armement d'un passage (journal et fiche de porte) : « autorisée » en ton normal, « non autorisée » en avertissement. */
  function armingNoteEl(p) {
    const note = armingNoteOf(p);
    if (!note) return null;
    return h('span', { class: `acc-arming-note ${note.authorized ? 'is-ok' : 'is-warning'}` }, ico(note.authorized ? 'shield' : 'state-warning', 'icon-sm'), h('span', { text: note.text }));
  }

  function updateDoorCard(card, door) {
    const last = state.last.get(door.detectorId);
    const sig = JSON.stringify([door.name, door.zone, door.floorId, door.controllerName, door.controllerId, door.doorNo, door.kind, door.emergencyExit, door.state, door.stateLabel, door.stateHint, door.deviceStatus, door.lastPassageAt, last?.passage?.id ?? null, (core.S.floors ?? []).length, dayStart(now())]);
    if (card.sig === sig) return;
    card.sig = sig;
    const info = stateInfo(door);
    card.li.className = `acc-door tone-${info.tone}`;
    card.title.textContent = doorName(door);
    card.states.replaceChildren(...[statePill(door), alarmPill(door)].filter(Boolean));
    card.hint.textContent = door.stateHint || STATE_HINT[door.state] || STATE_HINT.unknown;
    const lastText = !door.lastPassageAt ? 'Aucun passage enregistré' : last?.passage ? lastPassageSentence(last.passage, now()) : `${capFirst(formatWhen(door.lastPassageAt, now()))}`;
    card.facts.replaceChildren(
      ...fact('Où', doorPlaceText(door, floorNameOf(door))),
      ...fact('Contrôleur', `${door.controllerName || door.controllerId || '—'} · porte n° ${door.doorNo ?? '?'}`),
      ...fact('Type', door.emergencyExit ? `${kindLabel(door.kind)} · issue de secours` : kindLabel(door.kind)),
      ...fact('Dernier passage', lastText),
    );
    card.open.setAttribute('aria-label', `Détails de la porte ${doorName(door)}`);
    card.passages.setAttribute('aria-label', `Voir les passages de la porte ${doorName(door)}`);
  }

  /** Qui est passé en dernier, pour chaque porte : lu dans sa fiche, seulement quand son dernier passage a changé. */
  function ensureLastPassages(doors) {
    // La fiche ouverte lit déjà sa porte : pas de seconde lecture pour la même.
    const todo = doors.filter((d) => d.lastPassageAt && state.last.get(d.detectorId)?.at !== d.lastPassageAt && !state.lastBusy.has(d.detectorId) && state.fiche.id !== d.detectorId);
    for (const d of todo) state.lastBusy.add(d.detectorId); // déjà en file : un second appel ne les redemande pas
    let running = 0;
    const next = () => {
      while (running < 3 && todo.length) {
        const door = todo.shift();
        const id = door.detectorId;
        running++;
        api(`/api/access/doors/${encodeURIComponent(id)}`)
          .then((data) => {
            state.last.set(id, { at: door.lastPassageAt, passage: Array.isArray(data?.lastPassages) ? (data.lastPassages[0] ?? null) : null });
          })
          .catch(() => {
            state.last.set(id, { at: door.lastPassageAt, passage: null }); // on réessaiera au prochain nouveau passage
          })
          .finally(() => {
            state.lastBusy.delete(id);
            running--;
            if (state.visible && state.ready) renderDoors();
            next();
          });
      }
    };
    next();
  }

  /** « Voir les passages » d'une porte : le journal filtré sur cette porte, sur les 7 derniers jours. */
  function showJournalForDoor(id) {
    state.filters = { ...defaultFilters(now()), ...quickRange('week', now()), door: id };
    selectTab('journal', { fromRoute: true });
    writeForm(state.filters);
    applyFilters();
    state.ui.tabs.journal.focus();
  }

  // ================================================================================================ FICHE d'une porte

  function buildFicheShell() {
    const f = state.ui.f;
    // Le bouton de retour dit d'où l'on vient (le plan, la liste des portes ou le journal) et y ramène.
    f.backText = h('span', { text: BACK_LABELS.portes });
    f.back = h('button', { class: 'btn', type: 'button' }, ico('chevron-left'), f.backText);
    f.back.addEventListener('click', () => backFromFiche());
    f.title = h('h2', { id: 'acc-fiche-title', class: 'acc-fiche-title', tabindex: '-1' });
    f.stateBlock = h('div', { class: 'state-block acc-fiche-state' });
    f.message = h('div', { class: 'acc-message' });
    f.facts = h('dl', { class: 'acc-facts acc-facts-wide' });
    f.remote = h('div', { class: 'acc-remote', 'data-slot': 'remote-open' });
    f.passages = h('div', { class: 'acc-fiche-passages' });
    f.allPassages = h('button', { class: 'btn btn-sm', type: 'button' }, ico('list'), 'Voir tous les passages de cette porte');
    f.allPassages.addEventListener('click', () => state.fiche.id && showJournalForDoor(state.fiche.id));
    f.cameras = h('div', { class: 'acc-fiche-cameras' });
    const panel = (id, icon, title, ...body) => h('section', { class: 'panel acc-fiche-panel', 'aria-labelledby': id }, h('div', { class: 'panel-head' }, h('h3', { id }, ico(icon), title)), h('div', { class: 'panel-body' }, ...body));
    return h(
      'section',
      { class: 'acc-fiche', 'aria-labelledby': 'acc-fiche-title' },
      h('div', { class: 'acc-fiche-top' }, f.back),
      f.title,
      f.stateBlock,
      f.message,
      h(
        'div',
        { class: 'acc-fiche-grid' },
        // La caméra d'abord : devant une porte forcée, c'est ce que le texte « que faire » demande de regarder.
        panel('acc-fiche-cams', 'camera', 'Caméras de la porte', f.cameras),
        panel('acc-fiche-info', 'info', 'Informations', f.facts),
        panel('acc-fiche-last', 'history', '10 derniers passages', f.passages, h('div', { class: 'actions' }, f.allPassages)),
        panel('acc-fiche-remote', 'unlock', 'Ouverture à distance', f.remote),
      ),
    );
  }

  /** Ouvre la fiche d'une porte (depuis la liste, le plan ou le journal) ; le focus est rendu au déclencheur à la fermeture.
   *  `backTab` : d'où l'on vient (« portes », « journal » ou « plan ») ; il décide du bouton de retour. */
  function openFiche(id, { trigger = null, backTab = 'portes' } = {}) {
    if (!ID_PATTERN.test(String(id))) return;
    const ui = state.ui;
    const fiche = state.fiche;
    if (fiche.id && fiche.id !== id) stopFicheViewer();
    scrollBefore = document.getElementById('workspace')?.scrollTop ?? 0;
    fiche.id = id;
    fiche.trigger = trigger instanceof HTMLElement && trigger !== document.body ? trigger : null;
    fiche.backTab = BACK_LABELS[backTab] ? backTab : 'portes';
    ui.f.backText.textContent = BACK_LABELS[fiche.backTab];
    // La carte « Ouverture à distance » repart de zéro à chaque ouverture : jamais les boutons d'une autre porte.
    ui.f.remote.replaceChildren();
    ui.f.remote.removeAttribute('data-filled');
    ui.f.remote.removeAttribute('data-key');
    fiche.data = null;
    fiche.error = null;
    fiche.loadedFor = null;
    fiche.cameraKey = '';
    fiche.version++;
    ui.tabList.hidden = true;
    for (const pane of Object.values(ui.panes)) pane.hidden = true;
    ui.fiche.hidden = false;
    state.tab = 'portes';
    renderFiche();
    loadFiche();
    ui.f.title.focus({ preventScroll: true });
    document.getElementById('workspace')?.scrollTo?.(0, 0);
    syncRoute();
    announce(`Détails de la porte ${doorName(core.S.doors.get(id)) || id}.`);
  }

  function stopFicheViewer() {
    state.fiche.viewer?.stop();
    state.fiche.viewer = null;
    state.fiche.cameraKey = '';
  }

  /** Ferme la fiche et rend le focus au bouton qui l'avait ouverte (ou, à défaut, à la carte de la porte). */
  function closeFiche({ focus = true, tab = null } = {}) {
    const fiche = state.fiche;
    const ui = state.ui;
    if (!fiche.id) return;
    const id = fiche.id;
    stopFicheViewer();
    fiche.token++;
    fiche.id = null;
    ui.fiche.hidden = true;
    ui.tabList.hidden = false;
    const target = tab ?? (fiche.backTab === 'journal' ? 'journal' : 'portes'); // « plan » : la fiche se range sur les portes
    const trigger = fiche.trigger;
    fiche.trigger = null;
    state.tab = target;
    for (const [tabId, btn] of Object.entries(ui.tabs)) {
      const on = tabId === target;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      ui.panes[tabId].hidden = !on;
    }
    if (target === 'portes') renderDoors();
    document.getElementById('workspace')?.scrollTo?.(0, scrollBefore);
    syncRoute();
    if (!focus) return;
    const card = ui.d.cards.get(id)?.open;
    const back = [trigger, card, ui.tabs[target]].find((el) => isDisplayed(el));
    back?.focus({ preventScroll: true });
  }

  /**
   * Bouton « Retour… » et touche Échap : on revient d'où l'on vient. Du plan : sur Surveillance (la porte y reste choisie) ;
   * des portes ou du journal : sur cet onglet, le focus rendu au bouton qui avait ouvert la fiche.
   */
  function backFromFiche() {
    if (!state.fiche.id) return;
    if (state.fiche.backTab === 'plan') {
      closeFiche({ focus: false });
      if (goToPlan) goToPlan();
      else core.go('surveillance');
      return;
    }
    closeFiche({ focus: true });
  }

  async function loadFiche() {
    const fiche = state.fiche;
    const id = fiche.id;
    if (!id) return;
    const token = ++fiche.token;
    fiche.loading = true;
    try {
      const data = await api(`/api/access/doors/${encodeURIComponent(id)}`);
      if (token !== fiche.token || fiche.id !== id) return;
      fiche.data = data;
      fiche.version++;
      fiche.error = null;
      fiche.loadedFor = data?.door?.lastPassageAt ?? null;
      if (data?.door) core.S.doors.set(id, data.door);
      const first = Array.isArray(data?.lastPassages) ? (data.lastPassages[0] ?? null) : null;
      state.last.set(id, { at: data?.door?.lastPassageAt ?? null, passage: first });
    } catch (err) {
      if (token !== fiche.token || fiche.id !== id) return;
      fiche.error = err;
    }
    fiche.loading = false;
    renderFiche();
  }

  /** Le temps réel (`doors`) rafraîchit l'état tout de suite ; la liste des passages est relue si un passage est arrivé. */
  function refreshFicheFromDoors() {
    const fiche = state.fiche;
    if (!fiche.id) return;
    renderFiche();
    const door = core.S.doors.get(fiche.id);
    if (door && !fiche.loading && fiche.data && (door.lastPassageAt ?? null) !== fiche.loadedFor) loadFiche();
  }

  function renderFiche() {
    const fiche = state.fiche;
    const f = state.ui.f;
    const id = fiche.id;
    if (!id) return;
    const door = core.S.doors.get(id) ?? fiche.data?.door ?? null;
    const notFound = fiche.error && /introuvable|non déclarée|404/i.test(String(fiche.error.message)) && !door;
    f.title.textContent = door ? doorName(door) : id;

    if (!door) {
      f.stateBlock.className = 'state-block is-offline acc-fiche-state';
      f.stateBlock.replaceChildren(ico('state-unknown'), h('div', {}, h('p', { class: 'state-title', text: fiche.loading || !fiche.error ? 'Lecture de la porte…' : notFound ? 'Porte introuvable' : 'La porte n’a pas pu être lue' }), h('p', { class: 'state-detail', text: fiche.error ? (notFound ? 'Cette porte n’est pas déclarée (ou ne l’est plus). Retournez à la liste des portes.' : '') : '' })));
      if (fiche.error && !notFound) setKeyed(f.message, `erreur|${fiche.error.message}`, () => errorNotice('Les détails de la porte n’ont pas pu être lus.', fiche.error, () => loadFiche()));
      else setKeyed(f.message, 'rien', () => null);
      f.facts.replaceChildren();
      f.facts.dataset.key = '';
      f.passages.replaceChildren();
      f.passages.dataset.key = '';
      f.cameras.replaceChildren();
      stopFicheViewer();
      if (f.remote.dataset.filled !== '1') {
        f.remote.replaceChildren(h('p', { class: 'muted', text: REMOTE_FALLBACK_TEXT }));
        f.remote.dataset.key = '';
      }
      return;
    }

    const info = stateInfo(door);
    const day = dayStart(now());
    const incident = incidentForDoor(door, core.S.incidents);
    const hint = explainController(door.stateHint || STATE_HINT[door.state] || STATE_HINT.unknown);
    f.stateBlock.className = `state-block ${toneToBlock(info.tone)} acc-fiche-state`;
    setKeyed(f.stateBlock, JSON.stringify([id, door.state, door.stateLabel, door.stateHint, door.stateSince, door.deviceStatus, day, incident?.id ?? null, incident?.status ?? null]), () => [
      ico(info.icon),
      h(
        'div',
        {},
        h('p', { class: 'state-title', text: door.stateLabel || info.label }),
        h('p', { class: 'state-detail', text: hint.text }),
        door.stateSince ? h('p', { class: 'hint', text: `Depuis ${formatWhen(door.stateSince, now(), { seconds: false })}.` }) : null,
        alarmPill(door),
        alarmButton(door, incident),
      ),
    ]);
    if (fiche.error) setKeyed(f.message, `erreur|${fiche.error.message}`, () => errorNotice('Les détails de la porte n’ont pas pu être mis à jour.', fiche.error, () => loadFiche()));
    else setKeyed(f.message, 'rien', () => null);

    setKeyed(f.facts, JSON.stringify([door, (core.S.floors ?? []).length, day, hint.explained]), () => [
      ...fact('Où', doorPlaceText(door, floorNameOf(door))),
      ...fact('Détecteur', h('span', { class: 'mono', text: door.detectorId })),
      ...fact(hint.explained ? 'Contrôleur' : capFirst(CONTROLLER_LONG), door.controllerName || door.controllerId || '—'),
      ...fact('Numéro de porte', `n° ${door.doorNo ?? '?'} sur le contrôleur`),
      ...fact('Type', kindLabel(door.kind)),
      ...fact('Issue de secours', door.emergencyExit ? 'Oui : cette porte ne se verrouille jamais à distance.' : 'Non'),
      ...fact('Alarme si la porte reste ouverte', door.heldAlarmAfterS ? `Après ${secondsText(door.heldAlarmAfterS)} d’ouverture` : '—'),
      ...armingFact(door),
      ...fact('Dernier signe de vie', door.lastSeen ? capFirst(formatWhen(door.lastSeen, now(), { seconds: true })) : 'Aucun depuis le démarrage du PSIM'),
    ]);

    renderFichePassages();
    renderFicheCameras(door);
    renderFicheRemote(door);
  }

  function renderFichePassages() {
    const fiche = state.fiche;
    const f = state.ui.f;
    const key = `${fiche.id}|${fiche.version}|${Boolean(fiche.data)}|${Boolean(fiche.error)}|${dayStart(now())}`;
    if (f.passages.dataset.key === key) return;
    f.passages.dataset.key = key;
    if (!fiche.data) {
      f.passages.replaceChildren(h('p', { class: 'muted', text: fiche.error ? 'Passages indisponibles.' : 'Chargement des passages…' }));
      return;
    }
    const list = Array.isArray(fiche.data.lastPassages) ? fiche.data.lastPassages : [];
    if (list.length === 0) {
      f.passages.replaceChildren(h('div', { class: 'empty' }, ico('history'), h('strong', { text: 'Aucun passage enregistré pour cette porte.' }), h('span', { text: 'Les passages apparaissent ici dès que le contrôleur en envoie.' })));
      return;
    }
    const t = now();
    const rows = list.map((p) => {
      const stamp = passageStamp(p.atDevice, t);
      return h(
        'tr',
        {},
        h('td', { 'data-label': 'Date et heure', class: 'acc-when' }, h('time', { datetime: isoOrEmpty(p.atDevice) }, h('strong', { text: stamp.time }), h('span', { class: 'acc-sub', text: stamp.day }))),
        h('td', { 'data-label': 'Titulaire' }, h('div', { class: 'acc-cell-stack' }, h('strong', { class: p.holderName ? '' : 'muted', text: holderLine(p) }), badgeLine(p) ? h('span', { class: 'acc-sub mono', text: badgeLine(p) }) : null)),
        h('td', { 'data-label': 'Moyen d’accès' }, h('div', { class: 'acc-cell-stack' }, h('span', { text: p.methodLabel || '—' }), h('span', { class: 'acc-sub', text: directionLabel(p.direction) }))),
        h('td', { 'data-label': 'Résultat', class: 'acc-result' }, resultBlock(p), armingNoteEl(p)),
      );
    });
    f.passages.replaceChildren(
      h(
        'div',
        { class: 'table-scroll acc-tablewrap' },
        h('table', { class: 'data acc-stack acc-mini-table' }, h('caption', { class: 'sr-only', text: `${list.length} derniers passages de la porte, du plus récent au plus ancien` }), h('thead', {}, h('tr', {}, ...['Date et heure', 'Titulaire', 'Moyen d’accès', 'Résultat'].map((x) => h('th', { scope: 'col', text: x })))), h('tbody', {}, ...rows)),
      ),
    );
  }

  /** Les caméras liées, en direct. Le flux n'est pas relancé à chaque rafraîchissement : seulement si la liste change. */
  function renderFicheCameras(door) {
    const fiche = state.fiche;
    const f = state.ui.f;
    const fromServer = Array.isArray(fiche.data?.cameras) ? fiche.data.cameras : null;
    const ids = Array.isArray(door.cameraIds) ? door.cameraIds : [];
    const cameras = fromServer ?? ids.map((cid) => ({ id: cid, name: core.S.devices.get(cid)?.name ?? cid }));
    const key = JSON.stringify(cameras.map((c) => [c.id, c.name]));
    if (fiche.cameraKey === key && (fiche.viewer || cameras.length === 0)) return;
    stopFicheViewer();
    fiche.cameraKey = key;
    if (cameras.length === 0) {
      f.cameras.replaceChildren(
        h(
          'div',
          { class: 'empty' },
          ico('camera'),
          h('strong', { text: 'Aucune caméra n’est liée à cette porte.' }),
          h('span', { text: isAdmin() ? 'Liez une caméra à ce détecteur pour voir l’image de la porte ici et dans le journal des passages.' : 'Un administrateur peut lier une caméra à ce détecteur pour voir l’image de la porte ici.' }),
          isAdmin() ? h('a', { class: 'btn btn-sm', href: '#/equipements' }, ico('plan'), 'Ouvrir Équipements et plan') : null,
        ),
      );
      return;
    }
    fiche.viewer = createViewer(cameras.map((c) => ({ id: c.id, name: c.name || c.id })));
    f.cameras.replaceChildren(fiche.viewer.el);
  }

  /**
   * Carte « Ouverture à distance ». Cet écran ne commande rien : après CHAQUE rendu de la fiche il émet
   * `psim:door-card` ({ slot, door }) et un composant externe remplit l'emplacement `[data-slot="remote-open"]`. Tant qu'aucun
   * ne l'a pris en main, la carte dit qu'aucune serrure ou barrière n'est reliée (et, à l'administrateur, où la relier).
   * Un composant qui pose `slot.dataset.filled = '1'` garde sa carte : le rendu ne la reconstruit pas, il ré-émet seulement.
   */
  function renderFicheRemote(door) {
    const slot = state.ui.f.remote;
    const key = `${door.detectorId}|${isAdmin()}`;
    if (slot.dataset.filled !== '1' && slot.dataset.key !== key) {
      slot.dataset.key = key;
      slot.replaceChildren(
        ...[
          h('p', { class: 'acc-remote-text', text: REMOTE_FALLBACK_TEXT }),
          isAdmin() ? h('p', { class: 'acc-remote-text' }, REMOTE_ADMIN_HINT, h('a', { class: 'acc-link', href: '#/acces/declaration' }, 'Déclaration'), '.') : null,
        ].filter(Boolean),
      );
    }
    slot.dataset.door = door.detectorId;
    document.dispatchEvent(new CustomEvent(DOOR_CARD_EVENT, { detail: { slot, door } }));
  }

  // ================================================================================================ onglet DÉCLARATION

  function buildDeclaration() {
    const c = state.ui.c;
    c.undeclared = h('div', { class: 'acc-undeclared' });
    c.ctlHead = h('div', { class: 'panel-head' });
    c.ctlForm = h('div', { class: 'acc-form-slot' });
    c.ctlList = h('div', { class: 'acc-message' });
    c.doorForm = h('div', { class: 'acc-form-slot' });
    c.doorList = h('div', { class: 'acc-message' });
    c.settings = h('div', { class: 'acc-settings' });
    c.retentionInput = null;

    c.addController = h('button', { class: 'btn btn-primary', type: 'button' }, ico('plus'), 'Ajouter un contrôleur');
    c.addController.addEventListener('click', () => openControllerForm(null, c.addController));
    c.addDoor = h('button', { class: 'btn btn-primary', type: 'button' }, ico('plus'), 'Déclarer une porte');
    c.addDoor.addEventListener('click', () => openDoorForm(null, c.addDoor));

    const panel = (id, icon, title, headExtra, ...body) =>
      h('section', { class: 'panel acc-panel', 'aria-labelledby': id }, h('div', { class: 'panel-head' }, h('h2', { id, tabindex: '-1' }, ico(icon), title), headExtra ? h('div', { class: 'actions is-apart' }, headExtra) : null), h('div', { class: 'panel-body' }, ...body));
    return h(
      'div',
      { class: 'acc-decl' },
      infoNotice('info', h('p', { text: `Le ${CONTROLLER_LONG} décide d’ouvrir la porte pour un badge. Le PSIM enregistre les passages et surveille l’état des portes : il ne prend jamais part à l’ouverture par badge.` }), h('p', { text: 'Déclarez d’abord le contrôleur, puis chacune de ses portes (un détecteur de catégorie « Contrôle d’accès » par porte, créé dans Équipements et plan).' })),
      c.undeclared,
      panel('acc-ctl-title', 'server', 'Contrôleurs', c.addController, c.ctlForm, c.ctlList),
      panel('acc-door-title', 'door', 'Portes déclarées', c.addDoor, c.doorForm, c.doorList),
      panel('acc-ret-title', 'history', 'Conservation des passages', null, c.settings),
    );
  }

  async function loadDeclaration() {
    if (!isAdmin() || !state.ui.c.ctlList) return;
    const c = state.ui.c;
    if (!state.decl.controllers) c.ctlList.replaceChildren(h('p', { class: 'muted', text: 'Lecture des contrôleurs…' }));
    await Promise.all([loadControllers(), loadSettings(), readDoors()]);
    if (!state.visible) return;
    renderDeclaration();
  }

  async function loadControllers() {
    try {
      const data = await api('/api/access/controllers');
      state.decl.controllers = Array.isArray(data) ? data : (data?.controllers ?? data?.items ?? []);
      state.decl.controllersError = null;
    } catch (err) {
      state.decl.controllersError = err;
    }
  }

  async function loadSettings() {
    try {
      state.settings = await api('/api/access/settings');
      state.decl.settingsError = null;
    } catch (err) {
      state.decl.settingsError = err;
    }
  }

  function renderDeclaration() {
    const c = state.ui?.c;
    if (!c || !c.ctlList) return;
    renderUndeclared();
    renderControllers();
    renderDeclDoors();
    renderSettings();
  }

  function renderUndeclared() {
    const c = state.ui.c;
    const list = undeclaredAccessDetectors(core.S.devices.values(), core.S.doors);
    if (list.length === 0) {
      c.undeclared.replaceChildren();
      return;
    }
    const items = list.map((d) => {
      const declare = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': `Déclarer la porte du détecteur ${d.name}` }, ico('plus'), 'Déclarer la porte');
      declare.addEventListener('click', () => openDoorForm(null, declare, d.id));
      return h('li', { class: 'acc-undeclared-item' }, h('div', {}, h('strong', { text: d.name }), h('span', { class: 'acc-sub', text: `${d.id}${d.zone ? ` · ${d.zone}` : ''}` })), declare);
    });
    c.undeclared.replaceChildren(
      h('div', { class: 'notice is-warning acc-notice', role: 'group', 'aria-label': 'Détecteurs de contrôle d’accès non rattachés' }, ico('state-warning'), h('div', { class: 'acc-notice-body' }, h('p', {}, h('strong', { text: `${plural(list.length, 'détecteur de contrôle d’accès n’est pas rattaché', 'détecteurs de contrôle d’accès ne sont pas rattachés')} à un contrôleur. ` }), UNDECLARED_TEXT), h('ul', { class: 'acc-undeclared-list' }, ...items))),
    );
  }

  // ---- contrôleurs

  function renderControllers() {
    const c = state.ui.c;
    const d = state.decl;
    if (d.controllersError && !d.controllers) {
      c.ctlList.replaceChildren(errorNotice('La liste des contrôleurs n’a pas pu être lue.', d.controllersError, loadDeclaration));
      return;
    }
    const list = d.controllers ?? [];
    if (list.length === 0) {
      c.ctlList.replaceChildren(h('div', { class: 'empty' }, ico('server'), h('strong', { text: 'Aucun contrôleur déclaré.' }), h('span', { text: 'Ajoutez le contrôleur d’accès du site (marque, adresse, passerelle). Les identifiants sont facultatifs : le PSIM les range scellés et ne les réaffiche jamais.' })));
      return;
    }
    const t = now();
    const rows = list.map((ctl) => {
      const clock = clockOffsetInfo(ctl.clockOffsetMs);
      const edit = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': `Modifier le contrôleur ${ctl.name}` }, ico('pencil'), 'Modifier');
      edit.addEventListener('click', () => openControllerForm(ctl, edit));
      const remove = h('button', { class: 'btn btn-sm btn-danger', type: 'button', 'aria-label': `Supprimer le contrôleur ${ctl.name}` }, ico('trash'), 'Supprimer');
      remove.addEventListener('click', () => removeController(ctl, remove));
      return h(
        'tr',
        { 'data-controller': ctl.id },
        h('td', { 'data-label': 'Contrôleur', class: 'acc-who' }, h('strong', { text: ctl.name }), h('span', { class: 'acc-sub mono', text: ctl.id })),
        h('td', { 'data-label': 'Marque et modèle' }, h('div', { class: 'acc-cell-stack' }, h('span', { text: brandLabel(ctl.brand) }), ctl.model ? h('span', { class: 'acc-sub', text: ctl.model }) : null)),
        h('td', { 'data-label': 'Adresse' }, ctl.host ? h('span', { class: 'mono', text: ctl.host }) : h('span', { class: 'muted', text: 'Non renseignée' })),
        h('td', { 'data-label': 'Passerelle' }, ctl.gatewayId ? h('span', { class: 'mono', text: ctl.gatewayId }) : h('span', { class: 'muted', text: 'Aucune' })),
        h('td', { 'data-label': 'Identifiants enregistrés' }, ctl.hasCredentials ? h('span', { class: 'pill is-ok' }, ico('lock'), 'Oui') : h('span', { class: 'pill is-offline is-dashed' }, ico('unlock'), 'Non')),
        h('td', { 'data-label': 'Heure du contrôleur' }, h('div', { class: 'acc-cell-stack' }, h('span', { class: `pill ${clock.tone === 'warning' ? 'is-warning' : clock.tone === 'ok' ? 'is-ok' : 'is-offline'}` }, ico(clock.warn ? 'state-warning' : clock.tone === 'ok' ? 'clock' : 'state-unknown'), clock.text), clock.hint ? h('span', { class: 'acc-sub', text: clock.hint }) : null)),
        h('td', { 'data-label': 'Vu pour la dernière fois' }, ctl.lastSeen ? capFirst(formatWhen(ctl.lastSeen, t)) : h('span', { class: 'muted', text: 'Jamais' })),
        h('td', { 'data-label': 'Portes', class: 'num', text: String(ctl.doorCount ?? 0) }),
        h('td', { class: 'acc-actions-cell' }, h('div', { class: 'actions' }, edit, remove)),
      );
    });
    c.ctlList.replaceChildren(
      d.controllersError ? errorNotice('La liste n’a pas pu être mise à jour.', d.controllersError, loadDeclaration) : '',
      h(
        'div',
        { class: 'table-scroll acc-tablewrap' },
        h(
          'table',
          { class: 'data acc-stack acc-decl-table' },
          h('caption', { class: 'sr-only', text: plural(list.length, 'contrôleur déclaré', 'contrôleurs déclarés') }),
          h('thead', {}, h('tr', {}, ...['Contrôleur', 'Marque et modèle', 'Adresse', 'Passerelle', 'Identifiants enregistrés', 'Heure du contrôleur', 'Vu pour la dernière fois', 'Portes'].map((x) => h('th', { scope: 'col', text: x })), h('th', { scope: 'col' }, h('span', { class: 'sr-only', text: 'Actions' })))),
          h('tbody', {}, ...rows),
        ),
      ),
    );
  }

  function closeControllerForm(focusEl = null) {
    state.ui.c.ctlForm.replaceChildren();
    state.decl.form = null;
    focusEl?.focus({ preventScroll: false });
  }

  /** Formulaire d'ajout (controller = null) ou de modification d'un contrôleur. Identifiants en écriture seule. */
  function openControllerForm(controller, opener) {
    const c = state.ui.c;
    const editing = Boolean(controller);
    const start = controller ? controllerFormFrom(controller) : emptyControllerForm();
    const inputs = {
      id: h('input', { maxlength: '32', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none', placeholder: 'ex. CTL-1', required: true, readonly: editing }),
      name: h('input', { maxlength: String(MAX_NAME), autocomplete: 'off', placeholder: 'ex. Contrôleur entrée', required: true }),
      brand: select(BRANDS, start.brand),
      model: h('input', { maxlength: String(MAX_MODEL), autocomplete: 'off', placeholder: 'ex. ASC1204B' }),
      host: h('input', { maxlength: '253', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none', placeholder: 'ex. 192.168.1.50' }),
      gatewayId: h('input', { maxlength: '32', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none', placeholder: 'ex. gw-site' }),
      username: h('input', { type: 'text', maxlength: String(MAX_SECRET), autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none', 'data-lpignore': 'true' }),
      password: h('input', { type: 'password', maxlength: String(MAX_SECRET), autocomplete: 'new-password', spellcheck: 'false', 'data-lpignore': 'true' }),
    };
    for (const key of ['id', 'name', 'model', 'host', 'gatewayId']) inputs[key].value = start[key];
    const error = h('p', { class: 'form-error', role: 'alert' });
    const titleId = acc.uid('acc-ctl-form');
    const title = h('h3', { id: titleId, tabindex: '-1', text: editing ? `Modifier le contrôleur « ${controller.name} »` : 'Ajouter un contrôleur' });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, ico('check'), editing ? 'Enregistrer' : 'Ajouter le contrôleur');
    const cancel = h('button', { class: 'btn', type: 'button', text: 'Annuler' });

    const credentialBlock = h(
      'fieldset',
      { class: 'acc-secret' },
      h('legend', { text: 'Identifiants du contrôleur (facultatif)' }),
      h('p', { class: 'hint', text: 'Écriture seule : le PSIM les range scellés et ne les réaffiche jamais. Laissez les deux champs vides pour ne rien changer.' }),
      h('div', { class: 'acc-fields' }, field('Identifiant de connexion', inputs.username), field('Mot de passe', inputs.password)),
    );
    if (editing && controller.hasCredentials) {
      const clear = h('button', { class: 'btn btn-sm btn-danger', type: 'button' }, ico('trash'), 'Effacer les identifiants');
      clear.addEventListener('click', () => clearCredentials(controller, clear, () => closeControllerForm(opener)));
      credentialBlock.append(h('div', { class: 'acc-secret-state' }, h('span', { class: 'pill is-ok' }, ico('lock'), 'Des identifiants sont enregistrés'), clear));
    } else if (editing) {
      credentialBlock.append(h('div', { class: 'acc-secret-state' }, h('span', { class: 'pill is-offline is-dashed' }, ico('unlock'), 'Aucun identifiant enregistré')));
    }

    const form = h(
      'form',
      { class: 'acc-form', novalidate: true, autocomplete: 'off', 'aria-labelledby': titleId },
      title,
      h(
        'div',
        { class: 'acc-fields' },
        field('Identifiant du contrôleur', inputs.id, editing ? 'Il ne change pas après la création.' : 'Lettres, chiffres, - et _ (32 caractères au plus). Il sert aux messages de la passerelle.'),
        field('Nom', inputs.name, 'Pour le reconnaître, par exemple « Contrôleur entrée ».'),
        field('Marque', inputs.brand, 'Dahua est la marque prioritaire ; le contact sec convient à une porte simple sans gestion de badges.'),
        field('Modèle', inputs.model, 'Facultatif.'),
        field('Adresse sur le réseau', inputs.host, 'Adresse IP ou nom de machine, sans http:// ni chemin. Facultative.'),
        field('Passerelle', inputs.gatewayId, 'Identifiant de la passerelle GAMR qui relaie ce contrôleur (voir Clés et passerelles). Facultatif.'),
      ),
      credentialBlock,
      error,
      h('div', { class: 'actions' }, submit, cancel),
    );
    let busy = false;
    cancel.addEventListener('click', () => closeControllerForm(opener));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const values = { ...Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])) };
      acc.clearInvalid(form, error);
      const problems = controllerProblems(values, { editing });
      if (problems.length) return acc.markInvalid(inputs[problems[0].field], error, problems[0].message);
      const body = controllerBody(values, { editing, original: controller });
      if (editing && Object.keys(body).length === 0) return acc.markInvalid(null, error, 'Aucun changement à enregistrer.');
      busy = true;
      acc.setBusy(submit, true);
      try {
        if (editing) await api(`/api/access/controllers/${encodeURIComponent(controller.id)}`, { method: 'PUT', body });
        else await api('/api/access/controllers', { method: 'POST', body });
        toast(editing ? `Contrôleur « ${values.name.trim()} » enregistré` : `Contrôleur « ${values.name.trim()} » ajouté`, 'ok');
        inputs.password.value = '';
        closeControllerForm(null);
        await loadControllers();
        renderDeclaration();
        state.ui.c.addController.focus();
      } catch (err) {
        const target = /identifiant|id\b/i.test(err.message) && !editing ? inputs.id : null;
        acc.markInvalid(target, error, err.message);
      } finally {
        busy = false;
        acc.setBusy(submit, false);
      }
    });
    c.ctlForm.replaceChildren(form);
    state.decl.form = 'controller';
    (editing ? inputs.name : inputs.id).focus();
    form.scrollIntoView?.({ block: 'nearest' });
  }

  async function clearCredentials(ctl, trigger, onDone) {
    const ok = await dialogs.confirm({
      heading: `Effacer les identifiants de « ${ctl.name} »`,
      message: 'Le PSIM oubliera l’identifiant et le mot de passe de ce contrôleur. Les badges et les portes continuent de fonctionner : seul le PSIM ne pourra plus se connecter au contrôleur.',
      details: 'Pour en remettre, saisissez-les de nouveau dans ce formulaire. Cette action est inscrite au journal.',
      confirmLabel: 'Effacer les identifiants',
      onConfirm: () => api(`/api/access/controllers/${encodeURIComponent(ctl.id)}`, { method: 'PUT', body: { credentials: null } }),
    });
    if (!ok) return;
    toast('Identifiants effacés', 'ok');
    onDone();
    await loadControllers();
    renderDeclaration();
    state.ui.c.ctlList.querySelector(`tr[data-controller="${CSS.escape(ctl.id)}"] button`)?.focus();
  }

  async function removeController(ctl, trigger) {
    const ok = await dialogs.confirm({
      heading: `Supprimer le contrôleur « ${ctl.name} »`,
      message: ctl.doorCount > 0 ? `Ce contrôleur a encore ${plural(ctl.doorCount, 'porte')}. Le PSIM refusera de le supprimer tant qu’elles sont déclarées : retirez-les d’abord.` : 'Le PSIM ne saura plus rien de ce contrôleur (adresse, identifiants). Les passages déjà enregistrés sont conservés jusqu’à la purge.',
      details: 'Cette action est inscrite au journal.',
      confirmLabel: 'Supprimer le contrôleur',
      onConfirm: () => api(`/api/access/controllers/${encodeURIComponent(ctl.id)}`, { method: 'DELETE' }),
    });
    if (!ok) {
      if (trigger.isConnected) trigger.focus();
      return;
    }
    toast(`Contrôleur « ${ctl.name} » supprimé`, 'ok');
    await loadControllers();
    renderDeclaration();
    document.getElementById('acc-ctl-title')?.focus();
  }

  // ---- portes déclarées

  function renderDeclDoors() {
    const c = state.ui.c;
    const doors = sortDoors(allDoors());
    const noController = (state.decl.controllers ?? []).length === 0;
    c.addDoor.disabled = noController;
    c.addDoor.title = noController ? 'Déclarez d’abord un contrôleur.' : '';
    if (state.doorsError && doors.length === 0) {
      c.doorList.replaceChildren(errorNotice('La liste des portes n’a pas pu être lue.', state.doorsError, loadDeclaration));
      return;
    }
    if (doors.length === 0) {
      c.doorList.replaceChildren(h('div', { class: 'empty' }, ico('door'), h('strong', { text: 'Aucune porte déclarée.' }), h('span', { text: noController ? 'Déclarez d’abord un contrôleur, puis rattachez-lui chaque porte.' : 'Choisissez un détecteur de catégorie « Contrôle d’accès », le contrôleur et le numéro de porte. Le détecteur se crée dans Équipements et plan.' })));
      return;
    }
    const rows = doors.map((door) => {
      const edit = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': `Modifier la porte ${doorName(door)}` }, ico('pencil'), 'Modifier');
      edit.addEventListener('click', () => openDoorForm(door, edit));
      const remove = h('button', { class: 'btn btn-sm btn-danger', type: 'button', 'aria-label': `Retirer la porte ${doorName(door)}` }, ico('trash'), 'Retirer');
      remove.addEventListener('click', () => removeDoor(door, remove));
      const cams = Array.isArray(door.cameraIds) ? door.cameraIds.length : 0;
      return h(
        'tr',
        { 'data-door-row': door.detectorId },
        h('td', { 'data-label': 'Porte', class: 'acc-who' }, h('strong', { text: doorName(door) }), h('span', { class: 'acc-sub mono', text: door.detectorId }), door.arming?.enabled ? h('span', { class: 'tag is-info acc-arming-tag', title: `Rattachée à l’armement de la zone « ${door.arming.zone || door.zone || ''} »` }, ico('shield', 'icon-sm'), 'Armée avec sa zone') : null),
        h('td', { 'data-label': 'Contrôleur' }, h('div', { class: 'acc-cell-stack' }, h('span', { text: door.controllerName || door.controllerId || '—' }), h('span', { class: 'acc-sub', text: `Porte n° ${door.doorNo ?? '?'}` }))),
        h('td', { 'data-label': 'Type', text: kindLabel(door.kind) }),
        h('td', { 'data-label': 'Issue de secours' }, door.emergencyExit ? h('span', { class: 'tag is-warning' }, ico('door', 'icon-sm'), 'Issue de secours') : h('span', { class: 'muted', text: 'Non' })),
        h('td', { 'data-label': 'Alarme si la porte reste ouverte', text: door.heldAlarmAfterS ? `Après ${secondsText(door.heldAlarmAfterS)}` : '—' }),
        h('td', { 'data-label': 'Caméras liées' }, cams ? `${cams}` : h('span', { class: 'muted', text: 'Aucune' })),
        h('td', { class: 'acc-actions-cell' }, h('div', { class: 'actions' }, edit, remove)),
      );
    });
    c.doorList.replaceChildren(
      h(
        'div',
        { class: 'table-scroll acc-tablewrap' },
        h(
          'table',
          { class: 'data acc-stack acc-decl-table' },
          h('caption', { class: 'sr-only', text: plural(doors.length, 'porte déclarée', 'portes déclarées') }),
          h('thead', {}, h('tr', {}, ...['Porte', 'Contrôleur', 'Type', 'Issue de secours', 'Alarme si la porte reste ouverte', 'Caméras liées'].map((x) => h('th', { scope: 'col', text: x })), h('th', { scope: 'col' }, h('span', { class: 'sr-only', text: 'Actions' })))),
          h('tbody', {}, ...rows),
        ),
      ),
    );
  }

  function closeDoorForm(focusEl = null) {
    state.ui.c.doorForm.replaceChildren();
    if (state.decl.form === 'door') state.decl.form = null;
    focusEl?.focus({ preventScroll: false });
  }

  /** Formulaire de déclaration (door = null) ou de modification d'une porte. `presetDetector` : détecteur déjà choisi. */
  function openDoorForm(door, opener, presetDetector = '') {
    const c = state.ui.c;
    const editing = Boolean(door);
    const controllers = state.decl.controllers ?? [];
    if (controllers.length === 0) {
      toast('Déclarez d’abord un contrôleur.');
      return;
    }
    const start = door ? doorFormFrom(door) : { ...emptyDoorForm(), detectorId: presetDetector, controllerId: controllers.length === 1 ? controllers[0].id : '' };
    const free = undeclaredAccessDetectors(core.S.devices.values(), core.S.doors);
    const inputs = {
      detectorId: select([{ id: '', label: free.length ? 'Choisir un détecteur…' : 'Aucun détecteur disponible' }, ...free.map((d) => ({ id: d.id, label: `${d.name} (${d.id})${d.zone ? ` · ${d.zone}` : ''}` }))], start.detectorId),
      controllerId: select([{ id: '', label: 'Choisir un contrôleur…' }, ...controllers.map((x) => ({ id: x.id, label: `${x.name} (${x.id})` }))], start.controllerId),
      doorNo: select([1, 2, 3, 4].map((n) => ({ id: String(n), label: `Porte n° ${n}` })), start.doorNo),
      kind: select(DOOR_KINDS, start.kind),
      emergencyExit: h('input', { type: 'checkbox' }),
      armWithZone: h('input', { type: 'checkbox' }),
      heldMinutes: h('input', { type: 'text', inputmode: 'decimal', maxlength: '8', autocomplete: 'off', spellcheck: 'false' }),
    };
    inputs.emergencyExit.checked = start.emergencyExit;
    inputs.armWithZone.checked = start.armWithZone;
    // Case d'armement : la zone est celle du détecteur de la porte (lue sur la porte, ou sur le détecteur choisi à la déclaration).
    const armHint = h('span', { class: 'hint' });
    const armReason = h('span', { class: 'hint acc-arming-reason' });
    const armHintId = acc.uid('acc-hint');
    armHint.id = armHintId;
    inputs.armWithZone.setAttribute('aria-describedby', armHintId);
    const refreshArming = () => {
      const a = door ? doorArming(door) : null;
      const zone = door ? (a?.zone || door.zone || '') : (core.S.devices.get(inputs.detectorId.value)?.zone ?? '');
      const info = armingFieldInfo({ zone, zoneArmable: door ? a?.zoneArmable !== false : true, enabled: start.armWithZone });
      inputs.armWithZone.disabled = info.disabled;
      if (info.disabled) inputs.armWithZone.checked = false;
      armHint.textContent = info.help;
      armReason.textContent = info.reason;
    };
    refreshArming();
    if (!editing) inputs.detectorId.addEventListener('change', refreshArming);
    // Un ancien serveur ne connaît pas l'armement : on ne propose pas la case pour une porte existante.
    const armRow = editing && !doorArming(door) ? null : h('div', { class: 'acc-check' }, h('label', { class: 'check' }, inputs.armWithZone, h('span', { text: 'Armer cette porte avec sa zone' })), armHint, armReason);
    inputs.heldMinutes.value = start.heldMinutes;
    const error = h('p', { class: 'form-error', role: 'alert' });
    const titleId = acc.uid('acc-door-form');
    const title = h('h3', { id: titleId, tabindex: '-1', text: editing ? `Modifier la porte « ${doorName(door)} »` : 'Déclarer une porte' });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, ico('check'), editing ? 'Enregistrer' : 'Déclarer la porte');
    const cancel = h('button', { class: 'btn', type: 'button', text: 'Annuler' });
    const noDetector = !editing && free.length === 0;

    const detectorField = editing
      ? h('div', { class: 'field' }, h('span', { text: 'Détecteur' }), h('p', { class: 'acc-readonly' }, h('strong', { text: doorName(door) }), ' ', h('span', { class: 'mono', text: door.detectorId })), h('span', { class: 'hint', text: 'Le nom, la zone, l’étage et les caméras de la porte se règlent dans Équipements et plan.' }))
      : field('Détecteur de la porte', inputs.detectorId, 'Un détecteur de catégorie « Contrôle d’accès » pas encore déclaré. Le nom, la zone et les caméras restent ceux du détecteur (Équipements et plan).');
    const form = h(
      'form',
      { class: 'acc-form', novalidate: true, autocomplete: 'off', 'aria-labelledby': titleId },
      title,
      noDetector ? infoNotice('warning', h('p', { text: 'Aucun détecteur de catégorie « Contrôle d’accès » n’est libre. Créez-en un dans Équipements et plan (catégorie « Contrôle d’accès »), puis revenez ici.' }), isAdmin() ? h('a', { class: 'btn btn-sm', href: '#/equipements' }, ico('plan'), 'Ouvrir Équipements et plan') : null) : null,
      h(
        'div',
        { class: 'acc-fields' },
        detectorField,
        field('Contrôleur', inputs.controllerId),
        field('Numéro de porte sur le contrôleur', inputs.doorNo, 'De 1 à 4. Deux portes d’un même contrôleur n’ont pas le même numéro.'),
        field('Type', inputs.kind),
        field('Alarme si la porte reste ouverte plus de (minutes)', inputs.heldMinutes, 'Au bout de ce délai, une porte restée ouverte déclenche l’alarme. Par exemple 5, ou 0,5 pour trente secondes (de 10 secondes à 24 heures).'),
      ),
      checkRow(inputs.emergencyExit, 'Cette porte est une issue de secours', 'Une issue de secours ne se verrouille jamais à distance, quoi qu’il arrive. Cochez-la pour toute porte qui doit rester libre à la sortie.'),
      armRow,
      error,
      h('div', { class: 'actions' }, submit, cancel),
    );
    let busy = false;
    cancel.addEventListener('click', () => closeDoorForm(opener));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const values = { detectorId: editing ? door.detectorId : inputs.detectorId.value, controllerId: inputs.controllerId.value, doorNo: inputs.doorNo.value, kind: inputs.kind.value, emergencyExit: inputs.emergencyExit.checked, heldMinutes: inputs.heldMinutes.value, armWithZone: inputs.armWithZone.checked };
      acc.clearInvalid(form, error);
      const problems = doorProblems(values, { editing, controllerIds: controllers.map((x) => x.id) });
      if (problems.length) return acc.markInvalid(inputs[problems[0].field] ?? null, error, problems[0].message);
      const original = door ? { controllerId: door.controllerId, doorNo: door.doorNo, kind: door.kind, emergencyExit: Boolean(door.emergencyExit), heldAlarmAfterS: door.heldAlarmAfterS, armWithZone: Boolean(door.arming?.enabled) } : null;
      const body = doorBody(values, { editing, original });
      if (editing && Object.keys(body).length === 0) return acc.markInvalid(null, error, 'Aucun changement à enregistrer.');
      busy = true;
      acc.setBusy(submit, true);
      try {
        if (editing) await api(`/api/access/doors/${encodeURIComponent(door.detectorId)}`, { method: 'PUT', body });
        else await api('/api/access/doors', { method: 'POST', body });
        toast(editing ? 'Porte enregistrée' : 'Porte déclarée', 'ok');
        closeDoorForm(null);
        await Promise.all([loadControllers(), readDoors()]);
        renderDeclaration();
        state.ui.c.addDoor.focus();
      } catch (err) {
        // Refus d'armement (zone vide ou sans armement) : le message s'affiche près de la case.
        acc.markInvalid(body.armWithZone === true && /zone|armement/i.test(String(err.message)) ? inputs.armWithZone : null, error, err.message);
      } finally {
        busy = false;
        acc.setBusy(submit, false);
      }
    });
    c.doorForm.replaceChildren(form);
    state.decl.form = 'door';
    (editing ? inputs.controllerId : inputs.detectorId).focus();
    form.scrollIntoView?.({ block: 'nearest' });
  }

  async function removeDoor(door, trigger) {
    const ok = await dialogs.confirm({
      heading: `Retirer la porte « ${doorName(door)} »`,
      message: 'La porte n’aura plus d’état dans le PSIM. Le détecteur reste dans Équipements et plan, et l’historique des passages est conservé jusqu’à la purge.',
      details: 'Cette action est inscrite au journal.',
      confirmLabel: 'Retirer la porte',
      onConfirm: () => api(`/api/access/doors/${encodeURIComponent(door.detectorId)}`, { method: 'DELETE' }),
    });
    if (!ok) {
      if (trigger.isConnected) trigger.focus();
      return;
    }
    toast(`Porte « ${doorName(door)} » retirée`, 'ok');
    state.last.delete(door.detectorId);
    await Promise.all([loadControllers(), readDoors()]);
    renderDeclaration();
    document.getElementById('acc-door-title')?.focus();
  }

  // ---- conservation

  function renderSettings() {
    const c = state.ui.c;
    const s = state.settings;
    if (state.decl.settingsError && !s) {
      c.settings.replaceChildren(errorNotice('Le réglage de conservation n’a pas pu être lu.', state.decl.settingsError, loadDeclaration));
      return;
    }
    if (!s) {
      c.settings.replaceChildren(h('p', { class: 'muted', text: 'Lecture du réglage…' }));
      return;
    }
    const t = now();
    if (c.retentionInput && c.settings.contains(c.retentionInput)) {
      // Formulaire déjà là : on met à jour les faits sans toucher à la saisie en cours.
      c.stats.replaceChildren(...settingsFacts(s, t));
      c.retentionHint.textContent = `Valeur d’origine : ${s.defaultDays ?? 90} jours.`;
      if (document.activeElement !== c.retentionInput && c.retentionInput.value === c.retentionSaved) {
        c.retentionInput.value = String(s.retentionDays ?? '');
      }
      c.retentionSaved = String(s.retentionDays ?? '');
      return;
    }
    c.retentionInput = h('input', { type: 'text', inputmode: 'numeric', maxlength: '5', autocomplete: 'off', spellcheck: 'false', id: 'acc-retention' });
    c.retentionInput.value = String(s.retentionDays ?? '');
    c.retentionSaved = c.retentionInput.value;
    c.retentionHint = h('span', { class: 'hint', text: `Valeur d’origine : ${s.defaultDays ?? 90} jours.` });
    c.stats = h('dl', { class: 'acc-facts acc-facts-wide' }, ...settingsFacts(s, t));
    const error = h('p', { class: 'form-error', role: 'alert' });
    const save = h('button', { class: 'btn btn-primary', type: 'submit' }, ico('check'), 'Enregistrer');
    const label = h('label', { class: 'acc-retention-row', for: 'acc-retention' }, h('span', { text: 'Conserver les passages pendant' }), c.retentionInput, h('span', { text: 'jours' }));
    c.retentionInput.setAttribute('aria-describedby', 'acc-retention-help');
    const form = h(
      'form',
      { class: 'acc-form', novalidate: true },
      label,
      h('p', { class: 'hint', id: 'acc-retention-help', text: `De ${RETENTION_MIN} à ${formatInt(RETENTION_MAX)} jours.` }),
      c.retentionHint,
      infoNotice('info', h('p', { text: 'La suppression est automatique : passé ce délai, le PSIM efface les passages (noms et numéros de badge compris). Chaque purge est inscrite au journal. Un fichier exporté garde les passages au-delà de cette durée : conservez-le avec les mêmes précautions.' })),
      error,
      h('div', { class: 'actions' }, save),
    );
    let busy = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      acc.clearInvalid(form, error);
      const parsed = parseRetention(c.retentionInput.value);
      if (!parsed.ok) return acc.markInvalid(c.retentionInput, error, parsed.message);
      const current = state.settings?.retentionDays;
      if (Number.isFinite(current) && parsed.days === current) return acc.markInvalid(null, error, 'Aucun changement à enregistrer.');
      busy = true;
      try {
        // Raccourcir la durée supprime des passages à la prochaine purge, sans retour possible : on le fait confirmer.
        if (Number.isFinite(current) && parsed.days < current) {
          const ok = await dialogs.confirm({
            heading: 'Réduire la durée de conservation',
            message: `Les passages de plus de ${parsed.days} jours (au lieu de ${current}) seront supprimés définitivement à la prochaine purge automatique, avec les noms et les numéros de badge.`,
            details: 'Cette action est inscrite au journal. Pour garder ces passages, exportez-les d’abord avec « Exporter (tableur) », dans l’onglet Journal.',
            confirmLabel: 'Réduire la durée',
          });
          if (!ok) {
            busy = false;
            c.retentionInput.focus();
            return;
          }
        }
        acc.setBusy(save, true);
        const saved = await api('/api/access/settings', { method: 'PUT', body: { retentionDays: parsed.days } });
        state.settings = { ...state.settings, ...(saved && typeof saved === 'object' ? saved : {}), retentionDays: parsed.days };
        toast(`Les passages seront conservés ${parsed.days} jours`, 'ok');
        c.retentionSaved = String(parsed.days);
        c.retentionInput.value = c.retentionSaved;
        c.stats.replaceChildren(...settingsFacts(state.settings, now()));
        refreshRetentionNote();
      } catch (err) {
        acc.markInvalid(c.retentionInput, error, err.message);
      } finally {
        busy = false;
        acc.setBusy(save, false);
      }
    });
    c.settings.replaceChildren(form, c.stats);
  }

  function settingsFacts(s, t) {
    return [
      ...fact('Passages enregistrés', Number.isFinite(s.eventCount) ? formatInt(s.eventCount) : '—'),
      ...fact('Passage le plus ancien', s.oldestAt ? capFirst(formatWhen(s.oldestAt, t)) : 'Aucun'),
      ...fact('Dernière purge', lastPurgeText(s.lastPurge, t)),
    ];
  }

  /** Mention de conservation sous le journal (lisible par tous : les personnes concernées ont le droit de savoir). */
  async function refreshRetentionNote() {
    const el = state.ui?.j?.retention;
    if (!el) return;
    if (!state.settings) {
      try {
        state.settings = await api('/api/access/settings');
      } catch {
        return; // mention facultative
      }
    }
    const days = state.settings?.retentionDays;
    el.textContent = Number.isFinite(days) ? ` Les passages sont conservés ${days} jours, puis supprimés automatiquement.` : '';
  }

  // ================================================================================================ entrée et sortie

  function onDoorsEvent() {
    if (!state.visible || !state.ready) return;
    if (state.fiche.id) refreshFicheFromDoors();
    renderDoors();
    fillDoorSelect();
    if (state.tab === 'journal' && !state.fiche.id) renderJournal();
    const c = state.ui.c;
    if (c?.ctlList && state.tab === 'declaration') {
      renderUndeclared();
      renderDeclDoors();
    }
    if (state.tab === 'portes' && !state.fiche.id) {
      const summary = doorsSummary(sortDoors(allDoors()));
      if (state.lastAnnounced !== summary) {
        state.lastAnnounced = summary;
        announce(summary);
      }
    }
  }

  function onKey(e) {
    if (e.key !== 'Escape' || !state.visible || !state.fiche.id) return;
    // Une fenêtre ouverte (vidéo, confirmation) ou l'image agrandie se ferme d'abord : Échap ne ferme pas deux choses.
    const shown = (id) => {
      const el = document.getElementById(id);
      return Boolean(el) && !el.hidden;
    };
    if (shown('dialog') || shown('lightbox')) return;
    e.preventDefault();
    backFromFiche();
  }

  /**
   * Applique une sous-route (adresse ou appel de l'application) : onglet, filtres de l'adresse, fiche de porte. Appelable
   * plusieurs fois (retour sur l'écran, adresse changée à la main) : l'interface construite n'est jamais refaite.
   */
  function applyRoute(sub, { initial = false } = {}) {
    const route = parseRoute(sub);
    const fromAddress = Object.keys(route.filters).length > 0;
    if (fromAddress) {
      state.filters = { ...defaultFilters(now()), ...route.filters };
      writeForm(state.filters);
      state.journal.stack.reset();
    }
    let tab = route.tab ?? (initial ? state.tab : null);
    if (tab === 'declaration' && !isAdmin()) tab = 'journal';
    if (tab) selectTab(tab, { fromRoute: true });
    if (route.doorId) {
      openFiche(route.doorId, { backTab: 'portes' });
    } else if (tab === 'journal') {
      const jr = state.journal;
      if (fromAddress || !jr.loaded || now() - jr.loadedAt > 30_000) loadJournal();
    }
  }

  async function show(container, subRoute = '') {
    state.visible = true;
    state.showing = true;
    try {
      try {
        await loadModules();
      } catch (err) {
        if (state.visible) container.replaceChildren(errorNotice('L’écran Accès n’a pas pu se charger.', err, () => show(container, subRoute)));
        return;
      }
      if (!state.visible) return; // l'écran a été quitté pendant le chargement
      const user = getMe()?.username ?? null;
      if (!state.ready || state.container !== container || state.builtFor !== user) {
        resetState();
        state.container = container;
        build();
        container.replaceChildren(state.ui.root);
        state.ready = true;
        if (!wired) {
          wired = true;
          core.on('doors', onDoorsEvent); // un seul abonnement pour toute la vie de la page ; il ne fait rien écran masqué
        }
      }
      if (!keyBound) {
        document.addEventListener('keydown', onKey);
        keyBound = true;
      }
      state.doorsError = null;
      fillDoorSelect();
      refreshRetentionNote();
      applyRoute(subRoute, { initial: true });
      renderDoors();
      readDoors().then(() => {
        if (!state.visible || !state.ready) return;
        fillDoorSelect();
        renderDoors();
        if (state.fiche.id) refreshFicheFromDoors();
      });
      if (state.pendingDoor) {
        const { id, origin } = state.pendingDoor;
        state.pendingDoor = null;
        openFiche(id, { backTab: origin });
      }
    } finally {
      state.showing = false;
    }
  }

  function hide() {
    state.visible = false;
    state.pendingDoor = null;
    if (keyBound) {
      document.removeEventListener('keydown', onKey);
      keyBound = false;
    }
    stopAllViewers();
    state.videoToken++;
    if (state.videoOpen) {
      // Une fenêtre vidéo ne reste pas ouverte sur un autre écran (alarme) ; une autre fenêtre ouverte depuis (Mon compte)
      // n'est pas la nôtre : on ne la ferme pas.
      if (state.videoEl?.isConnected) dialogs.close();
      else state.videoViewer?.stop();
      state.videoOpen = false;
    }
    // Un mot de passe de contrôleur tapé et pas envoyé ne reste pas dans la page masquée.
    for (const input of state.ui?.root?.querySelectorAll('input[type="password"]') ?? []) input.value = '';
    state.fiche.viewer = null;
    state.fiche.cameraKey = '';
    // Une réponse qui arrive après la sortie n'écrit plus rien, et un chargement interrompu ne reste pas « en cours ».
    state.journal.token++;
    state.journal.loading = false;
    state.fiche.token++;
    state.fiche.loading = false;
  }

  /** Oublie tout ce que l'écran montrait (autre compte sur ce poste, déconnexion). */
  function resetState() {
    stopAllViewers();
    state.journal = { stack: createCursorStack(), items: [], total: null, capped: false, loading: false, loaded: false, error: null, token: state.journal.token + 1, loadedAt: 0 };
    state.fiche = { id: null, data: null, error: null, loading: false, token: state.fiche.token + 1, version: 0, trigger: null, backTab: 'portes', loadedFor: null, cameraKey: '', viewer: null };
    state.last = new Map();
    state.lastBusy = new Set();
    state.decl = { controllers: null, controllersError: null, settingsError: null, form: null };
    state.settings = null;
    state.doorsError = null;
    state.tab = 'journal';
    state.ui = null;
    state.ready = false;
    state.lastAnnounced = null;
  }

  function reset() {
    hide();
    resetState();
    state.container?.replaceChildren();
    state.container = null;
    state.builtFor = null;
  }

  /** Ouvre la fiche d'une porte demandée de l'extérieur : le plan (« Retour au plan ») sauf mention contraire. */
  function openDoor(detectorId, { origin = 'plan' } = {}) {
    if (!ID_PATTERN.test(String(detectorId ?? ''))) return;
    // show() est asynchrone (l'application l'appelle juste avant) : tant qu'il n'a pas fini, la fiche attend son tour.
    if (state.ready && state.visible && !state.showing) openFiche(detectorId, { trigger: document.activeElement, backTab: origin });
    else state.pendingDoor = { id: detectorId, origin };
  }

  /** Une alarme a changé ailleurs (incident ouvert, acquitté, clos) : la fiche ouverte redit si elle a une alarme à ouvrir. */
  function refresh() {
    if (state.visible && state.ready && state.fiche.id) renderFiche();
  }

  return { show, hide, openDoor, reset, refresh };
}
