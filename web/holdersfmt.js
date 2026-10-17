/**
 * Écran « Titulaires » : fonctions PURES (formatage, calculs, textes, corps des requêtes). Aucun import, aucun accès au DOM
 * ni à l'horloge cachée : l'heure est toujours passée en paramètre, ce qui permet de les tester sans navigateur
 * (test/holders-ui.test.ts). holders.js les utilise ; le serveur reste la référence des règles (il revérifie tout).
 *
 * Les dates sont lues et écrites à l'heure locale du navigateur (celle du poste de garde, qui est aussi celle du site).
 */

// ---------------------------------------------------------------- constantes (mêmes bornes que docs/ACCES.md § 10)

export const MAX_WINDOWS = 8;
export const MAX_HOLIDAYS = 400;
export const MAX_ACTIVE_BADGES = 4;
export const MIN_VISIT_MINUTES = 15;
export const MAX_VISIT_MINUTES = 44_640; // 31 jours
export const MAX_NAME = 40;
export const MAX_HOST = 64;
export const MAX_REASON = 120;
export const BADGE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const REF_PATTERN = /^[A-Za-z0-9._/-]{1,32}$/;
export const PHOTO_SIZE = 192;
export const PHOTO_QUALITY = 0.8;
export const PHOTO_MAX_BYTES = 64 * 1024;

export const DAY_SHORT = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
export const DAY_LONG = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // la semaine commence le lundi
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const pad2 = (n) => String(n).padStart(2, '0');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

/** Message du serveur en phrase : majuscule au début, point à la fin. */
export function sentence(s) {
  const t = cap(String(s ?? '').trim());
  if (!t) return '';
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

// ---------------------------------------------------------------- dates, heures, durées

/** « 12/10/2026 » (heure locale). */
export function dateText(ts) {
  const d = new Date(ts);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** « 17:30 » (heure locale). */
export function timeText(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const dayStart = (ts) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Jour et heure lisibles d'un coup d'œil : « aujourd'hui à 14:05 », « hier à 09:12 », « 12/10/2026 à 14:05 ». */
export function dateTimeText(ts, now) {
  const gap = Math.round((dayStart(now) - dayStart(ts)) / 86_400_000);
  const when = gap === 0 ? "aujourd'hui" : gap === 1 ? 'hier' : gap === -1 ? 'demain' : dateText(ts);
  return `${when} à ${timeText(ts)}`;
}

/** Validité d'un titulaire : « du 12/10/2026 au 30/06/2027 », « à partir du … », « jusqu'au … » ou « sans limite ». */
export function validityText(from, to) {
  const hasFrom = Number.isFinite(from) && from !== null;
  const hasTo = Number.isFinite(to) && to !== null;
  if (hasFrom && hasTo) return `du ${dateText(from)} au ${dateText(to)}`;
  if (hasFrom) return `à partir du ${dateText(from)}`;
  if (hasTo) return `jusqu'au ${dateText(to)}`;
  return 'sans limite';
}

/** Temps restant : « moins d'une minute », « 42 min », « 2 h 05 », « 3 j 4 h ». */
export function remainingText(ms) {
  if (!(ms > 0)) return 'terminée';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "moins d'une minute";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ${pad2(minutes % 60)}`;
  return `${Math.floor(minutes / 1440)} j ${Math.floor((minutes % 1440) / 60)} h`;
}

/** « 2026-10-12 » (champ date) -> ms à 00:00 locale, ou null si vide ou impossible (30 février). */
export function dateInputToStart(value) {
  return dateInputTo(value, 0, 0, 0);
}
/** « 2026-10-12 » (champ date) -> ms à 23:59 locale, ou null (comme l'import : la fin vaut jusqu'à 23:59). */
export function dateInputToEnd(value) {
  return dateInputTo(value, 23, 59, 0);
}
function dateInputTo(value, hh, mm, ss) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm, ss, 0);
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d.getTime();
}
/** ms -> « 2026-10-12 » pour un champ date (vide si pas de date). */
export function dateToInput(ts) {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ---------------------------------------------------------------- visiteurs : durée et heure de fin

export const VISITOR_DURATIONS = [
  { id: '1h', label: '1 heure', minutes: 60 },
  { id: '2h', label: '2 heures', minutes: 120 },
  { id: '4h', label: '4 heures', minutes: 240 },
  { id: 'day', label: "Jusqu'à la fin de la journée", minutes: null },
  { id: 'custom', label: 'Personnalisée', minutes: null },
];

/**
 * Fin d'une visite d'après le choix de l'opérateur. `now` en ms. Renvoie `{ ok: true, minutes, endsAt }` ou
 * `{ ok: false, problem }`. « Fin de la journée » = 23:59 aujourd'hui (au moins 15 minutes, comme le serveur).
 */
export function visitorEnd({ now, choice, customMinutes }) {
  let minutes;
  if (choice === 'day') {
    const end = new Date(now);
    end.setHours(23, 59, 0, 0);
    minutes = Math.ceil((end.getTime() - now) / 60_000);
    if (minutes < MIN_VISIT_MINUTES) return { ok: false, problem: "Il reste moins de 15 minutes avant la fin de la journée : choisissez plutôt une durée en heures." };
  } else if (choice === 'custom') {
    const text = String(customMinutes ?? '').trim();
    if (!/^\d{1,5}$/.test(text)) return { ok: false, problem: 'Indiquez la durée en minutes, en chiffres (de 15 à 44 640, soit 31 jours).' };
    minutes = Number(text);
    if (minutes < MIN_VISIT_MINUTES || minutes > MAX_VISIT_MINUTES) return { ok: false, problem: 'La durée doit être de 15 minutes à 44 640 minutes (31 jours).' };
  } else {
    const fixed = VISITOR_DURATIONS.find((d) => d.id === choice && d.minutes);
    if (!fixed) return { ok: false, problem: 'Choisissez une durée de visite.' };
    minutes = fixed.minutes;
  }
  return { ok: true, minutes, endsAt: now + minutes * 60_000 };
}

/** « Le badge cessera de fonctionner à 17:30. » (« demain à 03:10 », « le 18/10/2026 à 03:10 » si ce n'est pas aujourd'hui). */
export function endSentence(endsAt, now) {
  const gap = Math.round((dayStart(endsAt) - dayStart(now)) / 86_400_000);
  const when = gap === 0 ? `à ${timeText(endsAt)}` : gap === 1 ? `demain à ${timeText(endsAt)}` : `le ${dateText(endsAt)} à ${timeText(endsAt)}`;
  return `Le badge cessera de fonctionner ${when}.`;
}

/** Numéro du badge remis à un visiteur : celui qui n'est pas rendu, sinon le dernier connu. */
export function visitorBadgeNumber(holder) {
  const badges = holder?.badges ?? [];
  return (badges.find((b) => b.state !== 'returned') ?? badges[0])?.number ?? '';
}

/** Ligne « temps » d'une visite : [libellé, valeur]. En cours : temps restant et heure de fin ; à venir : début ; terminée : fin. */
export function visitTimeRow(v, now) {
  if (v.state === 'ended') return ['Terminée', v.holder?.visitor?.endedAt ? dateTimeText(v.holder.visitor.endedAt, now) : dateTimeText(v.endsAt, now)];
  if (v.state === 'upcoming') return ['Commence', dateTimeText(v.startsAt ?? v.endsAt, now)];
  return ['Temps restant', `${remainingText(v.endsAt - now)} (fin à ${timeText(v.endsAt)})`];
}

/** Dernier passage d'un visiteur, en une ligne. */
export function lastPassageText(p, now) {
  if (!p) return 'Aucun passage pour l’instant';
  return `${dateTimeText(p.atDevice, now)} · ${p.doorName ?? 'Porte retirée'} · ${p.resultLabel}`;
}

// ---------------------------------------------------------------- états : mot, icône, teinte (jamais la couleur seule)

const UNKNOWN_STATE = { label: 'État inconnu', icon: 'state-unknown', tone: 'is-offline' };

/** Statut d'un titulaire (suspendu, expiré, pas encore valide ou actif). */
export function holderStatusInfo(holder) {
  if (holder?.status === 'suspended') return { label: 'Suspendu', icon: 'state-warning', tone: 'is-warning' };
  if (holder?.phase === 'expired') return { label: 'Expiré', icon: 'state-offline', tone: 'is-offline' };
  if (holder?.phase === 'upcoming') return { label: 'Pas encore valide', icon: 'clock', tone: 'is-info' };
  return { label: 'Actif', icon: 'state-ok', tone: 'is-ok' };
}

const BADGE_INFO = {
  active: { label: 'Actif', icon: 'state-ok', tone: 'is-ok' },
  disabled: { label: 'Désactivé', icon: 'state-offline', tone: 'is-offline' },
  lost: { label: 'Perdu', icon: 'state-warning', tone: 'is-warning' },
  returned: { label: 'Rendu', icon: 'check', tone: 'is-offline is-dashed' },
};
export const badgeInfo = (state) => BADGE_INFO[state] ?? UNKNOWN_STATE;

const HOLDER_SYNC = {
  synced: { label: 'Synchronisé', icon: 'state-ok', tone: 'is-ok' },
  pending: { label: 'En attente', icon: 'clock', tone: 'is-warning' },
  failed: { label: 'Échec', icon: 'state-alarm', tone: 'is-alarm' },
  blocked: { label: 'Suppression à confirmer', icon: 'lock', tone: 'is-fault' },
  none: { label: 'Aucune porte', icon: 'state-offline', tone: 'is-offline is-dashed' },
};
/** État de synchronisation d'un titulaire (liste : `syncState` ; fiche : état par contrôleur). */
export const holderSyncInfo = (state) => HOLDER_SYNC[state] ?? UNKNOWN_STATE;

/** Ce que l'opérateur doit savoir ou faire selon l'état d'un titulaire sur un contrôleur. */
export function holderSyncAdvice(state) {
  switch (state) {
    case 'synced':
      return 'Le contrôleur a confirmé : il est à jour.';
    case 'pending':
      return "Le contrôleur n'a pas encore confirmé. Si cela dure plus de quelques minutes, vérifiez la passerelle dans l'onglet Synchronisation.";
    case 'failed':
      return "Le contrôleur n'a pas pris ce titulaire en compte. Ouvrez l'onglet Synchronisation pour voir la raison et réessayer.";
    case 'blocked':
      return "Le retrait de ce titulaire attend l'accord d'un administrateur (onglet Synchronisation).";
    default:
      return '';
  }
}

const CTL_SYNC = {
  ok: { label: 'À jour', icon: 'state-ok', tone: 'is-ok' },
  pending: { label: 'En attente', icon: 'clock', tone: 'is-warning' },
  failed: { label: 'Échec', icon: 'state-alarm', tone: 'is-alarm' },
  blocked: { label: 'Suppressions à confirmer', icon: 'lock', tone: 'is-fault' },
  disabled: { label: 'Non activée', icon: 'state-offline', tone: 'is-offline is-dashed' },
};
/** État de synchronisation d'un contrôleur. */
export const controllerSyncInfo = (state) => CTL_SYNC[state] ?? UNKNOWN_STATE;

/** Compteurs d'un contrôleur en une phrase : « 12 à jour, 2 en attente, 1 en échec, 3 suppressions à confirmer ». */
export function syncCountsText(counts) {
  const c = counts ?? {};
  const parts = [`${c.synced ?? 0} à jour`];
  if (c.pending) parts.push(`${c.pending} en attente`);
  if (c.failed) parts.push(`${c.failed} en échec`);
  if (c.blocked) parts.push(`${plural(c.blocked, 'suppression')} à confirmer`);
  return parts.join(', ');
}

/** Dernier accusé reçu d'un contrôleur. */
export function lastAckText(ts, now) {
  return ts ? `Dernier accusé : ${dateTimeText(ts, now)}` : 'Aucun accusé reçu pour l’instant';
}

const KIND_LABEL = { holder: 'Titulaire', schedule: 'Plage horaire', holidays: 'Jours fériés' };
/** Un élément non synchronisé : « Titulaire H12 : suppression en attente (3 essais) ». */
export function syncItemText(item) {
  const what = `${KIND_LABEL[item.kind] ?? 'Élément'}${item.kind === 'holidays' ? '' : ` ${item.ref}`}`;
  const op = item.op === 'delete' ? 'suppression' : 'envoi';
  const state = item.state === 'failed' ? 'en échec' : item.state === 'blocked' ? 'à confirmer' : 'en attente';
  const tries = item.attempts > 1 ? ` (${item.attempts} essais)` : '';
  return `${what} : ${op} ${state}${tries}`;
}

/** Avertissements montrés avec une clé de synchronisation (affichée une seule fois). */
export const KEY_WARNINGS = [
  'Cette clé ne sera plus jamais affichée : copiez-la maintenant.',
  'Recopiez-la dans la configuration de la passerelle, sinon les contrôleurs ne recevront rien.',
  'Si cette clé en remplace une autre, l’ancienne clé cesse de fonctionner tout de suite.',
];

// ---------------------------------------------------------------- confirmations (ce qui va se passer, en phrases)

/** Choix proposés quand on retire un badge de la circulation. */
export const BADGE_CHOICES = [
  { value: 'disabled', label: 'Désactivé', hint: 'Le badge peut être réactivé plus tard.' },
  { value: 'lost', label: 'Perdu', hint: 'Le numéro reste réservé : il ne peut pas être donné à une autre personne.' },
];

/** Nombre de contrôleurs où le titulaire est attendu (ou a été envoyé) d'après la synchronisation de sa fiche. */
export const controllerCount = (sync) => (Array.isArray(sync) ? sync.length : 0);

/** Confirmation de « Désactiver le badge » : ce qui va se passer sur le terrain. */
export function deactivateBadgeText({ number, name, controllers }) {
  const n = Number(controllers) || 0;
  if (n === 0) return `Le badge ${number} de ${name} n'est sur aucun contrôleur pour l'instant. Il sera retiré de la circulation dans le PSIM et ne pourra plus servir ensuite.`;
  return `Le badge ${number} de ${name} sera retiré de ${plural(n, 'contrôleur')}. Un passage avec ce badge sera refusé dans les secondes qui suivent.`;
}

/** Confirmation de « Réactiver le badge ». */
export function reactivateBadgeText({ number, name, controllers }) {
  const n = Number(controllers) || 0;
  if (n === 0) return `Le badge ${number} de ${name} redeviendra actif. Aucun contrôleur n'attend ce titulaire pour l'instant.`;
  return `Le badge ${number} de ${name} sera de nouveau envoyé à ${plural(n, 'contrôleur')}. Il rouvrira les portes du titulaire dans les secondes qui suivent.`;
}

/** Confirmation de « Rendre le badge » (carte restituée : le numéro redevient disponible). */
export function returnBadgeText({ number, name, controllers }) {
  const n = Number(controllers) || 0;
  const where = n === 0 ? '' : `Il sera retiré de ${plural(n, 'contrôleur')} et un passage sera refusé dans les secondes qui suivent. `;
  return `Le badge ${number} de ${name} sera marqué comme rendu. ${where}Le numéro pourra être donné à quelqu'un d'autre.`;
}

/** Confirmation de la suppression d'un vieux badge (rendu ou perdu) de la fiche. */
export function removeBadgeText({ number, name, state }) {
  const reserved = state === 'lost' ? ' Le numéro ne sera plus réservé : il pourra être donné à quelqu’un d’autre.' : '';
  return `Le badge ${number} sera retiré de la fiche de ${name}. Il ne servait déjà plus à ouvrir une porte.${reserved} Cette action ne peut pas être annulée.`;
}

/** Confirmation de « Rendre le badge » d'un visiteur (fin de visite immédiate). */
export function endVisitText({ number, name }) {
  return `La visite de ${name} se termine maintenant. Le badge ${number} sera rendu et retiré des contrôleurs : un passage avec ce badge sera refusé dans les secondes qui suivent.`;
}

/** Confirmation de la suppression d'un titulaire. */
export function deleteHolderText({ name, controllers }) {
  const n = Number(controllers) || 0;
  const where = n === 0 ? '' : ` Il sera retiré de ${plural(n, 'contrôleur')} dans les secondes qui suivent.`;
  return `${name} et ses badges seront supprimés.${where} Cette action ne peut pas être annulée.`;
}

/** Confirmation de la suppression d'un groupe (ses titulaires perdent les portes qu'il donne). */
export function deleteGroupText({ name, holders }) {
  if (holders > 0) return `Le groupe « ${name} » compte ${plural(holders, 'titulaire')} : le serveur refusera de le supprimer tant qu'il en reste. Retirez-les d'abord du groupe.`;
  return `Le groupe « ${name} » sera supprimé. Cette action ne peut pas être annulée.`;
}

/** Confirmation de l'import pour de bon. */
export function importConfirmText(report) {
  const parts = [];
  if (report.created) parts.push(plural(report.created, 'titulaire créé', 'titulaires créés'));
  if (report.updated) parts.push(plural(report.updated, 'titulaire modifié', 'titulaires modifiés'));
  const doing = parts.length ? parts.join(' et ') : 'aucun changement';
  const skipped = report.errors ? ` ${plural(report.errors, 'ligne en erreur sera ignorée', 'lignes en erreur seront ignorées')}.` : '';
  return `Cet import fera : ${doing}.${skipped} Les contrôleurs seront mis à jour dans les secondes qui suivent.`;
}

// ---------------------------------------------------------------- corps des requêtes

/** Numéros de badges saisis dans un champ libre (séparés par espaces, virgules ou points-virgules), sans doublon. */
export function parseBadgeNumbers(text) {
  return [...new Set(String(text ?? '').split(/[\s,;]+/).filter(Boolean))];
}

/** Problème d'un numéro de badge, en mots, ou null. */
export function badgeProblem(number) {
  if (!BADGE_PATTERN.test(number)) return `Le numéro « ${number} » n'est pas valable : lettres, chiffres, tiret et tiret bas seulement, 32 caractères au plus.`;
  return null;
}

/**
 * Formulaire d'un titulaire -> problème (en mots) ou null. `form` : { lastName, firstName, externalRef, validFrom, validTo
 * (champs date), badges (texte, à la création) }.
 */
export function holderFormProblem(form, { creating = false } = {}) {
  const last = String(form.lastName ?? '').trim();
  if (!last) return 'Indiquez le nom de famille.';
  if (last.length > MAX_NAME || String(form.firstName ?? '').trim().length > MAX_NAME) return `Le nom et le prénom font ${MAX_NAME} caractères au plus.`;
  const ref = String(form.externalRef ?? '').trim();
  if (ref && !REF_PATTERN.test(ref)) return 'Le matricule contient des caractères non permis (lettres, chiffres, point, barre oblique, tiret ; 32 au plus).';
  const from = dateInputToStart(form.validFrom);
  const to = dateInputToEnd(form.validTo);
  if (form.validFrom && from === null) return "La date de début n'est pas une date valable.";
  if (form.validTo && to === null) return "La date de fin n'est pas une date valable.";
  if (from !== null && to !== null && to < from) return 'La date de fin est avant la date de début.';
  if (creating) {
    const numbers = parseBadgeNumbers(form.badges);
    if (numbers.length > MAX_ACTIVE_BADGES) return `Un titulaire a ${MAX_ACTIVE_BADGES} badges actifs au plus.`;
    for (const n of numbers) {
      const p = badgeProblem(n);
      if (p) return p;
    }
  }
  return null;
}

/** Corps `HolderInput` d'après le formulaire (dates vides = null : valable sans limite). */
export function holderBody(form, { creating = false } = {}) {
  const body = {
    lastName: String(form.lastName ?? '').trim(),
    firstName: String(form.firstName ?? '').trim(),
    externalRef: String(form.externalRef ?? '').trim() || null,
    status: form.status === 'suspended' ? 'suspended' : 'active',
    validFrom: dateInputToStart(form.validFrom),
    validTo: dateInputToEnd(form.validTo),
    groupIds: [...new Set((form.groupIds ?? []).map(Number).filter(Number.isInteger))],
  };
  if (creating) body.badges = parseBadgeNumbers(form.badges);
  return body;
}

/** Corps `VisitorInput` ; renvoie `{ body }` ou `{ problem }`. */
export function visitorBody(form, end) {
  const lastName = String(form.lastName ?? '').trim();
  const host = String(form.host ?? '').trim();
  const badge = String(form.badge ?? '').trim();
  if (!lastName) return { problem: 'Indiquez le nom du visiteur.', field: 'lastName' };
  if (lastName.length > MAX_NAME || String(form.firstName ?? '').trim().length > MAX_NAME) return { problem: `Le nom et le prénom font ${MAX_NAME} caractères au plus.`, field: 'lastName' };
  if (!host) return { problem: 'Indiquez qui accompagne le visiteur.', field: 'host' };
  if (host.length > MAX_HOST) return { problem: `Le nom de l'accompagnateur fait ${MAX_HOST} caractères au plus.`, field: 'host' };
  if (String(form.reason ?? '').trim().length > MAX_REASON) return { problem: `Le motif fait ${MAX_REASON} caractères au plus.`, field: 'reason' };
  if (!badge) return { problem: 'Indiquez le numéro du badge remis.', field: 'badge' };
  const bp = badgeProblem(badge);
  if (bp) return { problem: bp, field: 'badge' };
  if (!Number.isInteger(Number(form.groupId)) || Number(form.groupId) <= 0) return { problem: 'Choisissez le groupe du visiteur.', field: 'groupId' };
  if (!end?.ok) return { problem: end?.problem ?? 'Choisissez une durée de visite.', field: 'duration' };
  return {
    body: {
      lastName,
      firstName: String(form.firstName ?? '').trim(),
      host,
      reason: String(form.reason ?? '').trim(),
      badge,
      groupId: Number(form.groupId),
      durationMinutes: end.minutes,
    },
  };
}

// ---------------------------------------------------------------- plages horaires, groupes, jours fériés

const minutesOf = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const sortedDays = (days) => [...new Set(days)].sort((a, b) => a - b);
const clock = (t) => (t === '00:00' ? 'minuit' : t);

/** « du lundi au vendredi », « samedi et dimanche », « tous les jours », « le mercredi ». */
export function daysText(days) {
  const set = new Set(days);
  if (set.size === 7) return 'tous les jours';
  const order = DAY_ORDER.filter((d) => set.has(d));
  const pos = order.map((d) => DAY_ORDER.indexOf(d));
  if (order.length >= 3 && pos.every((p, i) => i === 0 || p === pos[i - 1] + 1)) return `du ${DAY_LONG[order[0]]} au ${DAY_LONG[order.at(-1)]}`;
  const names = order.map((d) => DAY_LONG[d]);
  if (names.length === 0) return 'aucun jour';
  return names.length === 1 ? `le ${names[0]}` : `${names.slice(0, -1).join(', ')} et ${names.at(-1)}`;
}

/** Une plage en clair : « Du lundi au vendredi, de 08:00 à 18:00 ». */
export function windowText(w) {
  const night = minutesOf(w.to) < minutesOf(w.from);
  return `${cap(daysText(w.days))}, de ${clock(w.from)} à ${clock(w.to)}${night && w.to !== '00:00' ? ' le lendemain' : ''}`;
}

/** Problème d'une plage, en mots, ou null. */
export function windowProblem(w) {
  if (!w.days.length) return 'Choisissez au moins un jour.';
  if (!TIME.test(w.from) || !TIME.test(w.to)) return "Indiquez l'heure de début et l'heure de fin.";
  if (w.from === w.to) return 'Le début et la fin sont identiques : choisissez deux heures différentes.';
  return null;
}

/** Résumé d'une plage horaire pour une carte : plages en clair, ou « Tout le temps » (plage du système). */
export function scheduleSummary(schedule) {
  if (schedule.builtin) return 'Tous les jours, à toute heure';
  const lines = schedule.windows.map(windowText);
  return lines.length ? lines.join(' ; ') : 'Aucune plage';
}

/** Problème d'une plage horaire entière (nom + plages), ou null. */
export function scheduleProblem({ name, windows }) {
  if (!String(name ?? '').trim()) return 'Donnez un nom à la plage horaire.';
  if (!windows.length) return 'Ajoutez au moins une plage de jours et d’heures.';
  if (windows.length > MAX_WINDOWS) return `Une plage horaire compte ${MAX_WINDOWS} plages au plus.`;
  for (const [i, w] of windows.entries()) {
    const p = windowProblem(w);
    if (p) return `Plage ${i + 1} : ${p}`;
  }
  return null;
}

/** Corps `ScheduleInput`. */
export function scheduleBody({ name, windows, closedOnHolidays }) {
  return {
    name: String(name ?? '').trim(),
    windows: windows.map((w) => ({ days: sortedDays(w.days), from: w.from, to: w.to })),
    closedOnHolidays: Boolean(closedOnHolidays),
  };
}

/** Corps `GroupInput` ; `doors` : [{ doorId, scheduleId }] des portes cochées. */
export function groupBody({ name, description, forVisitors, doors }) {
  return {
    name: String(name ?? '').trim(),
    description: String(description ?? '').trim(),
    forVisitors: Boolean(forVisitors),
    doors: doors.map((d) => ({ doorId: d.doorId, scheduleId: Number(d.scheduleId) })),
  };
}

/** Problème d'un groupe, en mots, ou null. */
export function groupProblem({ name, doors }) {
  if (!String(name ?? '').trim()) return 'Donnez un nom au groupe.';
  for (const d of doors) if (!Number.isInteger(Number(d.scheduleId)) || Number(d.scheduleId) <= 0) return 'Choisissez une plage horaire pour chaque porte cochée.';
  return null;
}

/** Les portes d'un groupe, en une phrase : « Entrée (Tout le temps), Parking (Heures de bureau) » ou « Aucune porte ». */
export function groupDoorsText(group) {
  if (!group.doors.length) return 'Aucune porte';
  return group.doors.map((d) => `${d.doorName ?? 'Porte retirée'} (${d.scheduleName})`).join(', ');
}

/** Problème de la liste des jours fériés (entrées { date, label }), ou null. */
export function holidaysProblem(entries) {
  if (entries.length > MAX_HOLIDAYS) return `La liste compte ${MAX_HOLIDAYS} dates au plus.`;
  const seen = new Set();
  for (const e of entries) {
    if (dateInputToStart(e.date) === null) return 'Une des dates est vide ou impossible : complétez-la ou retirez la ligne.';
    if (seen.has(e.date)) return `La date ${dateText(dateInputToStart(e.date))} est en double.`;
    seen.add(e.date);
  }
  return null;
}

/** Corps de `PUT /api/access/holidays`, trié par date. */
export function holidaysBody(entries) {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { entries: sorted.map((e) => ({ date: e.date, label: String(e.label ?? '').trim() })) };
}

// ---------------------------------------------------------------- import CSV

/** Colonnes du fichier d'import (docs/ACCES.md § 10.5), pour l'explication à l'écran. */
export const IMPORT_COLUMNS = [
  { name: 'nom', required: true, text: 'Nom de famille (40 caractères au plus).' },
  { name: 'prenom', required: false, text: 'Prénom.' },
  { name: 'matricule', required: false, text: 'Numéro interne. Il sert à retrouver la personne : s’il existe déjà, la fiche est mise à jour.' },
  { name: 'badge1 à badge4', required: false, text: 'Numéros de badges (4 au plus).' },
  { name: 'groupe', required: false, text: 'Noms de groupes qui existent déjà, séparés par « | ». Ils remplacent les groupes actuels.' },
  { name: 'debut, fin', required: false, text: 'Dates de validité, au format 2026-10-12 ou 12/10/2026.' },
  { name: 'statut', required: false, text: '« actif » (par défaut) ou « suspendu ».' },
];

const TEMPLATE_HEADER = ['nom', 'prenom', 'matricule', 'badge1', 'badge2', 'badge3', 'badge4', 'groupe', 'debut', 'fin', 'statut'];
const TEMPLATE_ROWS = [
  ['KONAN', 'Yao', 'M0012', '0012345', '', '', '', '', '2026-10-12', '2027-06-30', 'actif'],
  ['TRAORE', 'Aminata', 'M0013', '0012346', '', '', '', '', '', '', 'actif'],
];
export const TEMPLATE_FILENAME = 'modele-import-titulaires.csv';

/** Modèle CSV téléchargeable : UTF-8 avec BOM (Excel), séparateur « ; », fins de ligne Windows, deux lignes d'exemple. */
export function templateCsv() {
  return `﻿${[TEMPLATE_HEADER, ...TEMPLATE_ROWS].map((row) => row.join(';')).join('\r\n')}\r\n`;
}

/** Encodage lu, en mots. */
export function encodingText(encoding) {
  if (encoding === 'windows-1252') return 'Fichier lu en Windows-1252 (Excel en français). Vérifiez que les accents sont corrects dans le tableau ci-dessous.';
  return 'Fichier lu en UTF-8.';
}

/** Séparateur détecté, en mots. */
export function delimiterText(delimiter) {
  if (delimiter === '\t') return 'tabulation';
  return delimiter === ',' ? 'virgule' : 'point-virgule';
}

/** Titre du rapport d'import. */
export function importHeadline(report) {
  if (report.fatal) return 'Le fichier ne peut pas être importé.';
  const parts = [plural(report.created, 'créé'), plural(report.updated, 'modifié'), `${report.unchanged} inchangé${report.unchanged > 1 ? 's' : ''}`, plural(report.errors, 'ligne en erreur', 'lignes en erreur')];
  return report.dryRun ? `Vérification terminée, rien n'a été modifié : ${parts.join(', ')}.` : `Import terminé : ${parts.join(', ')}.`;
}

const OUTCOME = {
  created: { label: 'Créé', icon: 'plus', tone: 'is-ok' },
  updated: { label: 'Modifié', icon: 'pencil', tone: 'is-info' },
  unchanged: { label: 'Inchangé', icon: 'check', tone: 'is-offline' },
  error: { label: 'Ignorée', icon: 'state-alarm', tone: 'is-alarm' },
};
export const outcomeInfo = (outcome) => OUTCOME[outcome] ?? UNKNOWN_STATE;

/** Lignes du rapport à détailler : celles en erreur ou avec remarque. */
export function reportRowsToShow(report) {
  return (report.items ?? []).filter((it) => it.errors?.length || it.warnings?.length);
}

/** Même fichier qu'à la vérification ? (nom, taille et date de modification). */
export const fileKey = (file) => (file ? `${file.name}|${file.size}|${file.lastModified}` : '');

// ---------------------------------------------------------------- photo

/** Carré centré à découper dans une image `w` x `h` : { sx, sy, side }. */
export function squareCrop(w, h) {
  const side = Math.min(w, h);
  return { sx: Math.floor((w - side) / 2), sy: Math.floor((h - side) / 2), side };
}

/** Qualités à essayer pour que la photo tienne dans la limite du serveur (64 Ko). */
export const PHOTO_QUALITIES = [PHOTO_QUALITY, 0.65, 0.5];

// ---------------------------------------------------------------- liste des titulaires

/** Paramètres de `GET /api/access/holders` (jamais mis dans l'adresse de la page, seulement dans l'appel). */
export function holdersQuery({ q, status, cursor }) {
  const p = new URLSearchParams({ kind: 'staff', limit: '50' });
  if (String(q ?? '').trim()) p.set('q', String(q).trim());
  if (status === 'active' || status === 'suspended') p.set('status', status);
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

/** Les badges actifs d'un titulaire, en texte : « 0012345, 0012346 » ou « Aucun badge actif ». */
export function activeBadgesText(holder) {
  const numbers = (holder.badges ?? []).filter((b) => b.state === 'active').map((b) => b.number);
  return numbers.length ? numbers.join(', ') : 'Aucun badge actif';
}

/** Comptage de la liste, annoncé aux lecteurs d'écran. */
export function listCountText(shown, total) {
  if (total === 0 || shown === 0) return 'Aucun titulaire trouvé';
  if (total > shown) return `${shown} titulaires affichés sur ${total}`;
  return plural(shown, 'titulaire');
}
