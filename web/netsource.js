/**
 * Supervision réseau d’un équipement d’infrastructure (routeur 4G, switch PoE, passerelle, point d’accès, serveur…) : le PSIM
 * ouvre régulièrement une connexion vers l’adresse et le port indiqués, sans rien envoyer. Après 3 échecs de suite, l’équipement
 * est « hors ligne » (daté du premier échec) ; il revient dès qu’il répond. Un essai immédiat montre si l’adresse répond avant
 * d’enregistrer.
 */
import { createDialogs } from './account.js';
import { h, icon, api, toast, time } from './core.js';
import { field, setFieldError, clearFieldErrors, statusLine, setStatus, withBusy } from './sources.js';

/** Ports courants proposés ; tout port de 1 à 65535 est accepté. */
const COMMON_PORTS = [
  [80, 'web (HTTP)'],
  [443, 'web (HTTPS)'],
  [22, 'SSH'],
  [161, 'SNMP'],
  [8080, 'web (autre)'],
];

const portOk = (v) => /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;

export function buildNetworkTarget(d) {
  const box = h('div', { class: 'source-box' }, h('p', { class: 'hint', text: 'Chargement de la supervision réseau…' }));
  if (d.category !== 'environment') {
    box.replaceChildren(h('p', { class: 'hint', text: 'Réservé aux équipements de catégorie « Environnement » : changez d’abord la catégorie dans les réglages ci-dessus.' }));
    return box;
  }
  const url = `/api/devices/${encodeURIComponent(d.id)}/network`;
  // Résultat d’un essai affiché : le rafraîchissement de l’état ne l’efface pas.
  let pinned = false;

  /** État mesuré, en mots. Jamais « normal » pour un équipement pas encore testé. */
  function stateText(t) {
    if (!t) return { kind: 'info', text: 'Pas de supervision réseau : cet équipement n’est pas testé.' };
    if (t.state === 'normal') return { kind: 'ok', text: `L’équipement répond (depuis ${time(t.since)}).` };
    if (t.state === 'offline') return { kind: 'error', text: `L’équipement ne répond plus (depuis ${time(t.since)}).` };
    return { kind: 'info', text: 'Pas encore testé : le premier résultat arrive dans la minute qui suit l’enregistrement.' };
  }

  const load = () =>
    api(url)
      .then(render)
      .catch((err) => {
        const status = statusLine();
        setStatus(status, 'error', `Supervision illisible : ${err.message}`);
        box.replaceChildren(status);
      });

  function render(target) {
    pinned = false;
    const host = h('input', { type: 'text', maxlength: '253', autocomplete: 'off', spellcheck: 'false', placeholder: '192.168.1.1', value: target?.host ?? '' });
    const portList = h('datalist', { id: `net-ports-${d.id}` }, ...COMMON_PORTS.map(([p, label]) => h('option', { value: String(p), label })));
    const port = h('input', { type: 'number', min: '1', max: '65535', inputmode: 'numeric', class: 'input-narrow', list: portList.id, value: target ? String(target.port) : '80' });
    const line = statusLine({ dataset: { role: 'state' } });
    const s = stateText(target);
    setStatus(line, s.kind, s.text);

    const valid = () => {
      const hostOk = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host.value.trim());
      if (!hostOk) setFieldError(host, 'Adresse IPv4 ou nom de machine, sans http:// ni chemin.');
      if (!portOk(port.value)) setFieldError(port, 'Port de 1 à 65535.');
      if (!hostOk) host.focus();
      else if (!portOk(port.value)) port.focus();
      return hostOk && portOk(port.value);
    };
    host.addEventListener('input', () => setFieldError(host));
    port.addEventListener('input', () => portOk(port.value) && setFieldError(port));

    const save = h('button', { class: 'btn btn-primary', type: 'button', text: 'Enregistrer' });
    save.addEventListener('click', async () => {
      clearFieldErrors(box);
      if (!valid()) return;
      setStatus(line, 'busy', 'Enregistrement…');
      try {
        const saved = await withBusy(save, () => api(url, { method: 'PUT', body: { host: host.value.trim(), port: Number(port.value) } }));
        toast(`${d.id} : supervision réseau enregistrée`, 'ok');
        render(saved);
      } catch (e) {
        setStatus(line, 'error', e.message);
      }
    });

    const test = h('button', { class: 'btn', type: 'button' }, icon('play'), 'Tester maintenant');
    test.addEventListener('click', async () => {
      clearFieldErrors(box);
      if (!valid()) return;
      setStatus(line, 'busy', 'Essai en cours…');
      pinned = true;
      try {
        const r = await withBusy(test, () => api('/api/network/test', { method: 'POST', body: { host: host.value.trim(), port: Number(port.value) } }));
        setStatus(line, r.ok ? 'ok' : 'error', r.message);
      } catch (e) {
        setStatus(line, 'error', e.message);
      }
    });

    const remove = target ? h('button', { class: 'btn btn-danger', type: 'button' }, icon('trash'), 'Retirer la supervision') : null;
    remove?.addEventListener('click', async () => {
      const ok = await createDialogs({ h }).confirm({
        heading: `Retirer la supervision de ${d.id}`,
        message: `Le PSIM ne testera plus ${d.id} : s’il tombe en panne, personne ne le saura.`,
        confirmLabel: 'Ne plus tester',
        danger: true,
      });
      if (!ok) return;
      try {
        await withBusy(remove, () => api(url, { method: 'DELETE' }));
        toast(`${d.id} : supervision réseau retirée`, 'ok');
        load();
      } catch (e) {
        setStatus(line, 'error', e.message);
      }
    });

    box.replaceChildren(
      ...[
        h('p', {
          class: 'hint',
          text: 'Le PSIM ouvre une connexion vers l’adresse et le port indiqués (rien n’est envoyé), et prévient dans l’écran Système après 3 échecs de suite. Cela prouve que l’équipement répond, pas qu’il rend tout son service.',
        }),
        h('div', { class: 'eq-grid' }, field('Adresse', host, 'Adresse IP ou nom de machine de l’équipement.'), field('Port à tester', port, 'Un port que l’équipement écoute : 80 ou 443 (page web), 22 (SSH), 161 (SNMP).')),
        portList,
        h('div', { class: 'actions' }, save, test, remove),
        line,
      ].filter(Boolean),
    );
  }

  load();
  // État mesuré rafraîchi tant que l’éditeur est affiché ; rien n’est demandé quand l’écran est masqué ou qu’on saisit.
  const timer = setInterval(() => {
    if (!box.isConnected) return clearInterval(timer);
    if (pinned || box.closest('[hidden]') || box.contains(document.activeElement)) return;
    api(url)
      .then((target) => {
        const line = box.querySelector('[data-role="state"]');
        if (!line || line.classList.contains('is-busy') || box.contains(document.activeElement)) return;
        const s = stateText(target);
        setStatus(line, s.kind, s.text);
      })
      .catch(() => {});
  }, 15_000);
  return box;
}
