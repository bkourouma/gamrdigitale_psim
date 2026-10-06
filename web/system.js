/**
 * Écran Système (administrateur) : santé du PSIM lui-même, stockage, sauvegardes et « qui surveille le surveillant »
 * (supervision externe, périodes sans surveillance, intégrité du journal), en faits courts groupés plutôt qu'en un long
 * paragraphe. Les avertissements du serveur passent en tête, un message par problème (critique = alarme).
 * Alimente aussi le compteur « Système : n alertes » de la barre du haut et la pastille du menu.
 */
import { $, h, icon, api, S, setCounterText } from './core.js';
import { setBusy } from './account.js';

export const fmtBytes = (n) => (n == null ? '—' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} Go` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);
export const fmtDuration = (s) => (s >= 86400 ? `${Math.floor(s / 86400)} j ${Math.floor((s % 86400) / 3600)} h` : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min`);
const fullDate = (ts) => new Date(ts).toLocaleString('fr-FR');

/** Date lisible d'un coup d'œil : « aujourd'hui à 17:42 », « hier à 08:10 », « 3 octobre à 14:05 » (année si autre). */
export function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86400000);
  if (days === 0) return `aujourd’hui à ${hm}`;
  if (days === 1) return `hier à ${hm}`;
  const date = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
  return `le ${date} à ${hm}`;
}

/** Élément <time> : texte lisible, date complète en infobulle et pour les machines. */
export function timeEl(ts, text = fmtWhen(ts)) {
  return h('time', { datetime: new Date(ts).toISOString(), title: fullDate(ts), text });
}

/** Texte du serveur : ce qui est entre accents graves (commande à lancer) s'affiche en police de code. */
function richText(message) {
  return message.split('`').map((part, i) => (i % 2 ? h('code', { text: part }) : part));
}

const STATE_ICON = { ok: 'state-ok', warn: 'state-warning', bad: 'state-alarm' };
const GB = 1024 ** 3;

// ---------------------------------------------------------------- faits

function heartbeatFact(hb) {
  const label = 'Supervision externe';
  if (!hb?.configured) return { label, value: 'Non configurée', state: 'warn', note: "Si le PSIM s’arrête, personne n’est prévenu : un service extérieur doit recevoir son signal régulier." };
  const every = `signal toutes les ${hb.everyS} s vers ${hb.host}`;
  if (hb.consecutiveFailures > 0) return { label, value: `${hb.consecutiveFailures} signal${hb.consecutiveFailures > 1 ? 'aux' : ''} en échec d’affilée`, state: hb.consecutiveFailures >= 3 ? 'bad' : 'warn', note: `${hb.lastError ?? 'erreur'} · ${every}` };
  return { label, value: hb.lastOkAt ? ['Dernier signal reçu ', timeEl(hb.lastOkAt)] : 'Configurée : premier signal en attente', state: hb.lastOkAt ? 'ok' : null, note: every };
}

function portalFact(p) {
  const label = 'Portail de suivi des sites';
  if (!p?.configured) return { label, value: 'Non relié', note: "Ce site n’envoie pas son résumé au portail de suivi à distance." };
  const every = `résumé toutes les ${fmtDuration(p.everyS)} vers ${p.host}`;
  if (p.consecutiveFailures > 0) return { label, value: `${p.consecutiveFailures} envoi${p.consecutiveFailures > 1 ? 's' : ''} en échec d’affilée`, state: p.consecutiveFailures >= 3 ? 'bad' : 'warn', note: `${p.lastError ?? 'erreur'} · ${every}` };
  return { label, value: p.lastOkAt ? ['Dernier résumé envoyé ', timeEl(p.lastOkAt)] : 'Relié : premier envoi en attente', state: p.lastOkAt ? 'ok' : null, note: every };
}

function camerasFact(c) {
  const label = 'Caméras (test de connexion)';
  if (!c?.enabled) return { label, value: 'Test désactivé' };
  if (c.measured === 0) return { label, value: 'Aucune caméra réelle à tester', note: 'Seules les caméras reliées à une source vidéo sont testées.' };
  if (c.offline.length === 0) return { label, value: c.measured > 1 ? `Les ${c.measured} répondent` : 'La caméra répond', state: 'ok' };
  return { label, value: `${c.offline.length} sur ${c.measured} ne répondent plus`, state: 'warn', note: c.offline.join(', ') };
}

function factGroups(sys) {
  const b = sys.backup;
  const free = sys.disk?.freeBytes;
  const gap = sys.continuity?.lastGap;
  const j = sys.journal;
  return [
    {
      title: 'Fonctionnement',
      icon: 'server',
      facts: [
        { label: 'Santé', value: sys.health.ok ? 'Bonne' : `Dégradée : ${sys.health.reason}`, state: sys.health.ok ? 'ok' : 'bad', note: sys.health.ok ? 'La base répond et la surveillance tourne.' : null },
        { label: 'En marche depuis', value: fmtDuration(sys.uptimeS), note: ['Démarré ', timeEl(Date.now() - sys.uptimeS * 1000)] },
        { label: 'Version', value: `PSIM ${sys.version}`, note: `Node ${sys.node}` },
        { label: 'Passerelles des détecteurs', value: sys.brokerClients === 0 ? 'Aucune connectée' : `${sys.brokerClients} connectée${sys.brokerClients > 1 ? 's' : ''}`, note: 'Relais (MQTT) entre les détecteurs et le PSIM.' },
        sys.cameras ? camerasFact(sys.cameras) : null,
      ],
    },
    {
      title: 'Stockage',
      icon: 'layers',
      facts: [
        { label: 'Disque libre', value: free == null ? 'Inconnu' : `${fmtBytes(free)}${sys.disk?.totalBytes ? ` sur ${fmtBytes(sys.disk.totalBytes)}` : ''}`, state: free == null ? null : free < GB / 2 ? 'bad' : free < 2 * GB ? 'warn' : null },
        { label: 'Base de données', value: fmtBytes(sys.database.bytes) },
        { label: 'Images des incidents', value: fmtBytes(sys.snapshotsBytes) },
      ],
    },
    {
      title: 'Sauvegardes',
      icon: 'download',
      facts: [
        { label: 'Sauvegarde automatique', value: b.everyH > 0 ? `Toutes les ${b.everyH} h` : 'Désactivée', state: b.everyH > 0 ? null : 'warn', note: b.everyH > 0 ? null : ['À planifier sur le PC du PSIM : ', h('code', { text: 'npm run backup' }), '.'] },
        {
          label: 'Dernière sauvegarde',
          value: b.at ? [b.ok ? 'Réussie ' : 'En échec ', timeEl(b.at)] : "Aucune pour l’instant",
          state: b.at ? (b.ok ? 'ok' : 'bad') : 'warn',
          note: b.at ? (b.ok ? [b.name, b.bytes ? ` · ${fmtBytes(b.bytes)}` : ''].join('') : b.error) : null,
        },
        { label: 'Sauvegardes conservées', value: String(b.count), note: b.dir ? ['Dossier : ', h('code', { class: 'sys-path', text: b.dir })] : null },
      ],
    },
    {
      title: 'Surveillance du PSIM',
      icon: 'shield',
      facts: [
        heartbeatFact(sys.heartbeat),
        sys.portal ? portalFact(sys.portal) : null,
        {
          label: 'Dernière période sans surveillance',
          value: gap ? `${fmtDuration(Math.round(gap.durationMs / 1000))}, ${gap.clean ? 'arrêt volontaire' : 'arrêt inattendu'}` : 'Aucune enregistrée',
          state: gap && !gap.clean ? 'warn' : gap ? null : 'ok',
          note: gap ? ['Commencée ', timeEl(gap.from)] : null,
        },
        {
          label: 'Journal',
          value: !j ? 'Pas encore vérifié' : j.ok ? 'Intègre' : 'ALTÉRÉ',
          state: !j ? null : j.ok ? 'ok' : 'bad',
          note: !j ? 'Lancez « Vérifier le journal » ci-dessous.' : j.ok ? [`${j.checked} entrées protégées, vérifié `, timeEl(j.at)] : ['Vérifié ', timeEl(j.at), ' : traitez-le comme un incident de sécurité.'],
        },
      ],
    },
  ];
}

function renderFacts(sys) {
  return h(
    'div',
    { class: 'sys-groups' },
    ...factGroups(sys).map((g) =>
      h(
        'section',
        { class: 'sys-group', 'aria-label': g.title },
        h('h3', { class: 'sys-group-title' }, icon(g.icon, 'icon-sm'), g.title),
        h(
          'dl',
          { class: 'facts' },
          ...g.facts.filter(Boolean).map((f) =>
            h(
              'div',
              { class: `fact${f.state ? ` is-${f.state}` : ''}` },
              h('dt', { text: f.label }),
              h(
                'dd',
                {},
                h('span', { class: 'fact-value' }, f.state ? icon(STATE_ICON[f.state], 'icon-sm') : null, h('span', {}, ...[f.value].flat())),
                f.note ? h('span', { class: 'fact-note' }, ...[f.note].flat()) : null,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function renderWarnings(warnings) {
  if (!warnings.length) {
    return [h('div', { class: 'notice is-ok' }, icon('state-ok'), h('span', {}, h('strong', { text: 'Aucun avertissement. ' }), 'Le PSIM fonctionne normalement.'))];
  }
  const sorted = [...warnings].sort((a, b) => (b.level === 'critique') - (a.level === 'critique'));
  return sorted.map((w) => {
    const critical = w.level === 'critique';
    return h('div', { class: `notice ${critical ? 'is-alarm' : 'is-warning'}` }, icon(critical ? 'state-alarm' : 'state-warning'), h('span', {}, h('strong', { text: critical ? 'Critique : ' : 'À vérifier : ' }), ...richText(w.message)));
  });
}

let shownFor = null; // compte pour lequel l'écran a été rempli

/** Charge l'état du système ; `show` : remplit aussi l'écran (sinon seulement les compteurs). */
export async function loadSystem(show = true) {
  if (S.me?.role !== 'admin') return;
  try {
    const sys = await api('/api/system');
    const critical = sys.warnings.filter((w) => w.level === 'critique');
    const badge = $('system-counter');
    badge.hidden = critical.length === 0;
    setCounterText(badge, `Système : ${critical.length} alerte${critical.length > 1 ? 's' : ''}`, `Système (${critical.length})`);
    badge.title = critical.map((w) => w.message).join('\n');
    const navCount = $('nav-count-systeme');
    navCount.hidden = critical.length === 0;
    navCount.textContent = String(critical.length);
    if (!show) return;

    // Résultats d'actions d'un autre compte (session précédente sur ce poste) : effacés.
    if (shownFor !== S.me.username) {
      shownFor = S.me.username;
      for (const id of ['sys-backup-result', 'sys-journal-result']) $(id).replaceChildren();
    }
    $('sys-status').replaceChildren(renderFacts(sys));
    $('sys-warnings').replaceChildren(...renderWarnings(sys.warnings));
    $('sys-updated').replaceChildren('Relevé ', timeEl(Date.now(), new Date().toLocaleTimeString('fr-FR')));
  } catch (err) {
    if (!show) return;
    $('sys-warnings').replaceChildren();
    $('sys-updated').replaceChildren();
    $('sys-status').replaceChildren(
      h(
        'div',
        { class: 'notice is-alarm' },
        icon('state-alarm'),
        h('span', {}, h('strong', { text: "Impossible de lire l’état du PSIM. " }), `${err.message}. `, h('button', { class: 'btn btn-sm', type: 'button', text: 'Réessayer', onclick: () => loadSystem() })),
      ),
    );
  }
}

// ---------------------------------------------------------------- sauvegarde et vérification du journal

/** Résultat d'une action, à côté de son bouton : pastille (réussi / échec) et détail en mots. */
function showResult(el, ok, word, ...detail) {
  el.replaceChildren(h('span', { class: `pill ${ok ? 'is-ok' : 'is-alarm'}` }, icon(ok ? 'state-ok' : 'state-alarm'), word), h('span', { class: 'sys-result-text' }, ...detail));
}

async function runTask(button, resultEl, task) {
  shownFor = S.me?.username ?? null;
  setBusy(button, true);
  resultEl.replaceChildren(h('span', { class: 'muted', text: 'En cours…' }));
  try {
    await task();
  } catch (err) {
    showResult(resultEl, false, 'Échec', err.message);
  } finally {
    setBusy(button, false);
    loadSystem();
  }
}

$('sys-backup')?.addEventListener('click', () =>
  runTask($('sys-backup'), $('sys-backup-result'), async () => {
    const r = await api('/api/system/backup', { method: 'POST' });
    if (r.ok) showResult($('sys-backup-result'), true, 'Réussie', `${r.name}${r.bytes ? ` · ${fmtBytes(r.bytes)}` : ''} · `, timeEl(r.at ?? Date.now()));
    else showResult($('sys-backup-result'), false, 'Échec', `${r.error ?? 'erreur inconnue'}. Vérifiez la place libre sur le disque et le dossier des sauvegardes.`);
  }),
);

$('sys-journal')?.addEventListener('click', () =>
  runTask($('sys-journal'), $('sys-journal-result'), async () => {
    const r = await api('/api/system/journal/verify', { method: 'POST' });
    if (r.ok) showResult($('sys-journal-result'), true, 'Intègre', `${r.checked} entrée${r.checked > 1 ? 's' : ''} vérifiée${r.checked > 1 ? 's' : ''} : aucune n’a été modifiée ni effacée.`);
    else {
      const first = r.problems[0];
      showResult(
        $('sys-journal-result'),
        false,
        'ALTÉRÉ',
        `${r.problems.length} problème${r.problems.length > 1 ? 's' : ''}${first ? `, à partir de l'entrée n° ${first.id} (${first.reason})` : ''}. Traitez-le comme un incident de sécurité : prévenez le responsable, puis lancez `,
        h('code', { text: 'npm run verify-journal' }),
        ' sur le PC du PSIM.',
      );
    }
  }),
);

$('sys-refresh')?.addEventListener('click', async () => {
  setBusy($('sys-refresh'), true);
  await loadSystem();
  setBusy($('sys-refresh'), false);
});

// Compteur du haut tenu à jour pour l'administrateur ; l'écran seulement s'il est affiché.
setInterval(() => {
  if (S.me?.role === 'admin') loadSystem(S.view === 'systeme');
}, 60000);
