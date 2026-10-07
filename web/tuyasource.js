/**
 * Source d'un détecteur incendie : un détecteur de fumée WiFi Tuya / Smart Life. Le PSIM lit son état dans le cloud Tuya
 * (le compte Tuya est réglé une fois pour tout le site, dans le fichier .env du serveur) ; ici, on indique seulement
 * l'identifiant de l'appareil. Un essai lit l'appareil une fois et montre ce que le cloud en dit, avant d'enregistrer.
 */
import { createDialogs } from './account.js';
import { h, icon, api, toast, time } from './core.js';
import { field, setFieldError, clearFieldErrors, statusLine, setStatus, withBusy } from './sources.js';

const ID_OK = /^[A-Za-z0-9]{8,64}$/;

export function buildTuyaSource(d) {
  const box = h('div', { class: 'source-box' }, h('p', { class: 'hint', text: 'Chargement de la source…' }));
  if (d.category !== 'fire') {
    box.replaceChildren(h('p', { class: 'hint', text: 'Réservé aux détecteurs incendie : changez d’abord la catégorie dans les réglages ci-dessus.' }));
    return box;
  }
  const url = `/api/detectors/${encodeURIComponent(d.id)}/tuya`;
  // Résultat d'un essai affiché : le rafraîchissement de l'état ne l'efface pas.
  let pinned = false;
  const load = () =>
    api(url)
      .then(render)
      .catch((err) => {
        const status = statusLine();
        setStatus(status, 'error', `Source illisible : ${err.message}`);
        box.replaceChildren(status);
      });

  /** État de la lecture du cloud, en mots : ce que cela veut dire pour la surveillance. */
  function connectionText(src) {
    if (!src.tuyaId) return { kind: 'info', text: 'Pas de source : ce détecteur attend ses messages d’une autre façon (voir « Pour l’installateur » ci-dessus).' };
    const c = src.connection;
    if (!c || c.state === 'connecting') return { kind: 'busy', text: 'Première lecture du cloud Tuya en cours…' };
    if (c.state === 'error') return { kind: 'error', text: `Lecture impossible : ${c.error ?? 'raison inconnue'}. Si cela dure, le détecteur passe « hors ligne ».` };
    const when = c.lastPoll ? ` Dernière lecture à ${time(c.lastPoll)}.` : '';
    if (c.reading === 'alarm') return { kind: 'error', text: `Le détecteur signale de la fumée.${when}` };
    if (c.reading === 'silent') return { kind: 'error', text: `Appareil connu de Tuya mais ${c.reason}. Le détecteur passera « hors ligne » s’il ne revient pas.${when}` };
    if (c.reading === 'fault') return { kind: 'error', text: `Défaut : ${c.reason}.${when}` };
    return { kind: 'ok', text: `Le PSIM lit le détecteur dans le cloud Tuya : aucune fumée, appareil en ligne.${when}` };
  }

  function render(src) {
    pinned = false;
    const tuyaId = h('input', { type: 'text', value: src.tuyaId ?? '', maxlength: '64', autocomplete: 'off', spellcheck: 'false', class: 'mono', placeholder: 'ex. 6c1234abcd5678efghijkl' });
    const line = statusLine({ dataset: { role: 'connection' } });
    const c = connectionText(src);
    setStatus(line, c.kind, c.text);
    const results = h('ul', { class: 'source-events', 'aria-label': 'Données reçues pendant l’essai' });
    results.hidden = true;

    const idOk = () => ID_OK.test(tuyaId.value.trim());
    tuyaId.addEventListener('input', () => idOk() && setFieldError(tuyaId));

    const save = h('button', { class: 'btn btn-primary', type: 'button', text: 'Enregistrer la source', disabled: !src.configured });
    save.addEventListener('click', async () => {
      clearFieldErrors(box);
      if (!idOk()) return void (setFieldError(tuyaId, 'Identifiant de 8 à 64 lettres ou chiffres, tel qu’affiché dans la console Tuya.'), tuyaId.focus());
      setStatus(line, 'busy', 'Enregistrement…');
      try {
        const saved = await withBusy(save, () => api(url, { method: 'PUT', body: { deviceId: tuyaId.value.trim() } }));
        toast(`${d.id} : source enregistrée, le PSIM lit le détecteur`, 'ok');
        render(saved);
      } catch (e) {
        setStatus(line, 'error', e.message);
      }
    });

    const test = h('button', { class: 'btn', type: 'button', disabled: !src.configured }, icon('play'), 'Tester la lecture');
    test.addEventListener('click', async () => {
      clearFieldErrors(box);
      if (!idOk()) return void (setFieldError(tuyaId, 'Identifiant de 8 à 64 lettres ou chiffres, tel qu’affiché dans la console Tuya.'), tuyaId.focus());
      pinned = true;
      results.hidden = true;
      setStatus(line, 'busy', 'Lecture de l’appareil dans le cloud Tuya…');
      try {
        const r = await withBusy(test, () => api('/api/tuya/test', { method: 'POST', body: { deviceId: tuyaId.value.trim() } }));
        const name = r.name ? ` (« ${r.name} »)` : '';
        setStatus(line, r.ok ? 'ok' : 'error', `${r.message}${name}`);
        results.hidden = r.data.length === 0;
        results.replaceChildren(...r.data.map((e) => h('li', {}, h('span', { class: 'mono', text: `${e.code} = ${e.value}` }))));
      } catch (e) {
        setStatus(line, 'error', e.message);
      }
    });

    const remove = src.tuyaId ? h('button', { class: 'btn btn-danger', type: 'button' }, icon('trash'), 'Retirer la source') : null;
    remove?.addEventListener('click', async () => {
      const ok = await createDialogs({ h }).confirm({
        heading: `Retirer la source de ${d.id}`,
        message: `Le détecteur ${d.id} ne recevra plus l’état du détecteur de fumée Tuya.`,
        confirmLabel: 'Ne plus lire le détecteur',
        danger: true,
      });
      if (!ok) return;
      try {
        await withBusy(remove, () => api(url, { method: 'DELETE' }));
        toast(`${d.id} : source retirée`, 'ok');
        load();
      } catch (e) {
        setStatus(line, 'error', e.message);
      }
    });

    box.replaceChildren(
      ...[
        h('p', {
          class: 'hint',
          text: 'Pour un détecteur de fumée WiFi de l’application Smart Life (Tuya). Le PSIM lit son état dans le cloud Tuya toutes les minutes environ : la sirène du détecteur sonne seule, sur place, sans attendre le PSIM.',
        }),
        src.configured
          ? null
          : h(
              'p',
              { class: 'notice is-warning' },
              icon('state-warning'),
              h('span', { text: 'Le compte Tuya n’est pas encore réglé sur le serveur : renseignez PSIM_TUYA_ACCESS_ID et PSIM_TUYA_ACCESS_SECRET dans le fichier .env, puis redémarrez le PSIM (voir docs/TUYA.md).' }),
            ),
        h('div', { class: 'eq-grid' }, field('Identifiant de l’appareil Tuya', tuyaId, 'Dans la console Tuya (iot.tuya.com), projet, onglet « Appareils » : colonne « Device ID ».')),
        h('div', { class: 'actions' }, save, test, remove),
        line,
        results,
      ].filter(Boolean),
    );
  }

  load();
  // État de la lecture rafraîchi tant que l'éditeur est affiché : rien n'est demandé quand l'écran est masqué.
  const timer = setInterval(() => {
    if (!box.isConnected) return clearInterval(timer);
    if (pinned || box.closest('[hidden]')) return;
    api(url)
      .then((src) => {
        const line = box.querySelector('[data-role="connection"]');
        if (!line || pinned || !src.tuyaId) return;
        const c = connectionText(src);
        setStatus(line, c.kind, c.text);
      })
      .catch(() => {});
  }, 15_000);
  return box;
}
