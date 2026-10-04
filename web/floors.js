/**
 * Étages (duplex, immeuble) : barre des étages avec l'état de chaque niveau, vue éclatée en perspective (tous les niveaux
 * empilés) et gestion des étages par l'administrateur.
 *
 * Sécurité : une alarme sur un étage que l'opérateur ne regarde pas reste visible (bouton rouge clignotant, avec le
 * nombre d'alarmes), et l'ouverture d'un incident amène l'écran sur l'étage concerné (voir app.js, onIncident).
 * Les boutons et plateaux sont mis à jour SUR PLACE à chaque message d'équipement : les recréer ferait perdre un clic
 * commencé (appui puis relâchement sur un nouvel élément) et le focus clavier, au pire moment (pendant une alarme).
 */

const FIRING = new Set(['alarm', 'prealarm']);
const DOWN = new Set(['offline', 'fault']);

const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

/** État d'un étage : ce qui y sonne, ce qui y est hors service, ce qui attend un acquittement. */
export function floorSummary(floorId, devices, activeIncidents) {
  const here = devices.filter((d) => d.floorId === floorId);
  const detectors = here.filter((d) => d.kind === 'detector');
  const ids = new Set(detectors.map((d) => d.id));
  const incidents = activeIncidents.filter((i) => ids.has(i.detectorId));
  const alarm = detectors.filter((d) => d.status === 'alarm').length;
  const prealarm = detectors.filter((d) => d.status === 'prealarm').length;
  const down = detectors.filter((d) => DOWN.has(d.status)).length;
  const unacked = incidents.filter((i) => i.status === 'open').length;
  // Un incident critique encore ouvert compte comme une alarme, même si le détecteur est revenu au calme.
  const critical = alarm > 0 || incidents.some((i) => i.severity === 'critical');
  const level = critical ? 'alarm' : prealarm > 0 || incidents.length > 0 ? 'prealarm' : down > 0 ? 'down' : 'normal';
  const parts = [];
  if (alarm) parts.push(plural(alarm, 'alarme', 'alarmes'));
  if (prealarm) parts.push(plural(prealarm, 'préalarme', 'préalarmes'));
  if (!alarm && !prealarm && incidents.length) parts.push(plural(incidents.length, 'incident en cours', 'incidents en cours'));
  if (unacked) parts.push(`${unacked} à acquitter`);
  if (down) parts.push(plural(down, 'hors service', 'hors service'));
  return {
    level,
    text: parts.length ? parts.join(', ') : 'Normal',
    firing: detectors.filter((d) => FIRING.has(d.status)).map((d) => d.id),
    detectors: detectors.length,
    cameras: here.length - detectors.length,
    incidents: incidents.length,
  };
}

/** Écart entre deux plateaux de la vue éclatée : tout l'empilement tient dans le cadre, jusqu'à 20 étages. */
export function stackGap(n) {
  return n <= 1 ? 150 : Math.max(24, Math.min(150, Math.round(420 / (n - 1))));
}

export function createFloorsUi({ h, api, toast }) {
  /**
   * Barre des étages : un bouton par niveau (du plus bas au plus haut), puis la bascule vers la vue éclatée.
   * Masquée s'il n'y a qu'un étage, sauf en édition (pour en ajouter un).
   */
  function renderBar(bar, { floors, currentId, mode, devices, incidents, editMode, onSelect, onMode }) {
    const many = floors.length > 1;
    bar.hidden = !many && !editMode;
    if (bar.hidden) {
      bar.replaceChildren();
      bar.dataset.key = '';
      return;
    }
    const key = JSON.stringify([floors.map((f) => [f.id, f.name]), many]);
    if (bar.dataset.key !== key) {
      bar.dataset.key = key;
      const buttons = floors.map((f) =>
        h(
          'button',
          { type: 'button', class: 'floor-tab', dataset: { floor: String(f.id) }, onclick: () => onSelect(f.id) },
          h('span', { class: 'floor-name', text: f.name }),
          h('span', { class: 'floor-state' }),
        ),
      );
      const stack = many
        ? h('button', { type: 'button', class: 'btn small stack-toggle', title: 'Tous les étages empilés en perspective, avec leur état', text: 'Vue éclatée', onclick: () => onMode(bar.dataset.mode === 'stack' ? 'floor' : 'stack') })
        : null;
      bar.replaceChildren(h('div', { class: 'floor-tabs', role: 'group', 'aria-label': 'Étages' }, ...buttons), stack);
    }
    // Mise à jour sur place : classes, état, étage affiché.
    bar.dataset.mode = mode;
    for (const button of bar.querySelectorAll('.floor-tab')) {
      const f = floors.find((x) => String(x.id) === button.dataset.floor);
      if (!f) continue;
      const s = floorSummary(f.id, devices, incidents);
      const current = mode === 'floor' && f.id === currentId;
      button.className = `floor-tab lvl-${s.level}${current ? ' current' : ''}`;
      if (current) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
      button.title = `${f.name} : ${s.text}${f.hasPlan ? '' : ' (pas encore de plan)'}`;
      const state = button.querySelector('.floor-state');
      state.hidden = s.level === 'normal';
      state.className = `floor-state lvl-${s.level}`;
      state.textContent = s.level === 'normal' ? '' : s.text;
    }
    const toggle = bar.querySelector('.stack-toggle');
    if (toggle) {
      toggle.classList.toggle('active', mode === 'stack');
      toggle.setAttribute('aria-pressed', String(mode === 'stack'));
    }
  }

  /**
   * Vue éclatée : chaque étage est un plateau incliné, empilé au-dessus du précédent (le plus haut en haut). Les détecteurs
   * qui sonnent se dressent au-dessus de leur plateau ; les plateaux AU-DESSUS d'un étage en alarme deviennent
   * transparents pour ne pas le cacher. Un clic sur un plateau (ou sur sa ligne dans la liste) l'ouvre à plat.
   */
  function renderStack(view, { floors, devices, incidents, statusLabel, onOpen }) {
    const n = floors.length;
    const key = JSON.stringify(floors.map((f) => [f.id, f.name, f.planVersion, f.hasPlan]));
    if (view.dataset.key !== key) {
      view.dataset.key = key;
      const gap = stackGap(n);
      const layers = floors.map((f, i) => {
        const layer = h('div', { class: 'layer', dataset: { floor: String(f.id) } });
        layer.style.setProperty('--i', String(i));
        const surface = f.hasPlan
          ? h('img', { class: 'layer-plan', src: `/api/floors/${f.id}/plan?v=${f.planVersion}`, alt: '', draggable: 'false' })
          : h('div', { class: 'layer-plan none', text: 'Pas de plan' });
        // Le plateau prend les proportions de son plan : les pastilles (en % du plan) tombent juste.
        if (f.hasPlan) {
          surface.addEventListener('load', () => {
            if (surface.naturalWidth && surface.naturalHeight) layer.style.setProperty('--ratio', `${surface.naturalWidth} / ${surface.naturalHeight}`);
          });
        }
        layer.append(surface, h('div', { class: 'layer-dots' }), h('span', { class: 'layer-name', text: f.name }));
        layer.addEventListener('click', () => onOpen(f.id));
        return layer;
      });
      const stack = h('div', { class: 'stack' }, ...layers);
      const scene = h('div', { class: 'stack-scene', 'aria-hidden': 'true' }, stack);
      for (const el of [stack, scene]) {
        el.style.setProperty('--n', String(n));
        el.style.setProperty('--gap', `${gap}px`);
      }
      // La liste dit la même chose en texte : lisible au lecteur d'écran, cliquable sans viser un plateau.
      const list = h(
        'ol',
        { class: 'stack-list', 'aria-label': 'État des étages, du plus haut au plus bas' },
        ...[...floors].reverse().map((f) =>
          h(
            'li',
            { dataset: { floor: String(f.id) } },
            h(
              'button',
              { type: 'button', class: 'stack-open', onclick: () => onOpen(f.id), title: `Ouvrir le plan de ${f.name}` },
              h('strong', { text: f.name }),
              h('span', { class: 'floor-state' }),
              h('span', { class: 'firing-ids small' }),
              h('span', { class: 'muted small counts' }),
            ),
          ),
        ),
      );
      view.replaceChildren(scene, list);
    }

    // Mise à jour sur place : état des plateaux, pastilles, transparence au-dessus d'une alarme, liste.
    const summaries = new Map(floors.map((f) => [f.id, floorSummary(f.id, devices, incidents)]));
    const lowestAlarm = floors.findIndex((f) => summaries.get(f.id).level === 'alarm' || summaries.get(f.id).firing.length > 0);
    for (const layer of view.querySelectorAll('.layer')) {
      const index = floors.findIndex((f) => String(f.id) === layer.dataset.floor);
      const f = floors[index];
      if (!f) continue;
      const s = summaries.get(f.id);
      layer.className = `layer lvl-${s.level}${lowestAlarm >= 0 && index > lowestAlarm ? ' see-through' : ''}`;
      layer.querySelector('.layer-dots').replaceChildren(
        ...devices
          .filter((d) => d.floorId === f.id)
          .map((d) => {
            const firing = d.kind === 'detector' && FIRING.has(d.status);
            const dot = h('span', {
              class: `dot3 ${d.kind} ${d.kind === 'detector' ? d.status : ''}${firing ? ' firing' : ''}`,
              title: `${d.id} ${d.name}${d.kind === 'detector' ? ` - ${statusLabel[d.status] ?? d.status}` : ''}`,
            });
            dot.style.left = `${d.x}%`;
            dot.style.top = `${d.y}%`;
            // Détecteur qui sonne : une balise dressée vers l'observateur, lisible malgré l'inclinaison du plateau.
            if (firing) dot.append(h('span', { class: 'beacon', text: d.id }));
            return dot;
          }),
      );
    }
    for (const li of view.querySelectorAll('.stack-list li')) {
      const f = floors.find((x) => String(x.id) === li.dataset.floor);
      if (!f) continue;
      const s = summaries.get(f.id);
      li.className = `lvl-${s.level}`;
      const state = li.querySelector('.floor-state');
      state.className = `floor-state lvl-${s.level}`;
      state.textContent = s.text;
      const firing = li.querySelector('.firing-ids');
      firing.hidden = s.firing.length === 0;
      firing.textContent = s.firing.length ? `En alarme : ${s.firing.join(', ')}` : '';
      li.querySelector('.counts').textContent = `${plural(s.detectors, 'détecteur', 'détecteurs')}, ${plural(s.cameras, 'caméra', 'caméras')}${f.hasPlan ? '' : ' - pas de plan'}`;
    }
  }

  /** Gestion des étages (administrateur, mode édition) : ajouter, renommer, monter / descendre, supprimer. */
  function renderAdmin(box, { floors, devices, currentId, rerender }) {
    // Reconstruit seulement si les étages ou leur contenu changent : un message d'équipement ne doit pas voler le focus.
    const counts = floors.map((f) => devices.filter((d) => d.floorId === f.id).length);
    const key = JSON.stringify([floors.map((f) => [f.id, f.name, f.position, f.hasPlan]), counts, currentId]);
    if (box.dataset.key === key) return;
    // Jamais pendant une saisie : un nom en cours de modification n'est pas écrasé par un rafraîchissement.
    const typing = box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.value !== (document.activeElement.dataset.original ?? '');
    if (typing) return;
    box.dataset.key = key;
    const call = (path, init, okText) =>
      api(path, init)
        .then(() => {
          if (okText) toast(okText, 'ok');
          return true;
        })
        .catch((e) => {
          toast(e.message);
          return false;
        });
    const rows = [...floors].reverse().map((f) => {
      const count = counts[floors.indexOf(f)];
      const name = h('input', { value: f.name, maxlength: '40', 'aria-label': `Nom de l'étage ${f.name}`, dataset: { original: f.name } });
      const rename = h('button', { class: 'btn tiny', type: 'button', text: 'Renommer', disabled: true });
      name.addEventListener('input', () => {
        rename.disabled = name.value.trim() === f.name;
        name.removeAttribute('aria-invalid');
      });
      const save = () => {
        const value = name.value.trim();
        if (!value) {
          name.setAttribute('aria-invalid', 'true');
          name.focus();
          return toast("Le nom de l'étage ne peut pas être vide");
        }
        if (value === f.name) return;
        call(`/api/floors/${f.id}`, { method: 'PATCH', body: { name: value } }, 'Étage renommé').then((ok) => {
          if (!ok) return;
          name.dataset.original = name.value; // enregistré : la liste peut de nouveau se rafraîchir
          rerender();
        });
      };
      rename.addEventListener('click', save);
      name.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), save()));
      const blocked = floors.length <= 1 ? 'seul étage : il en faut au moins un' : count > 0 ? 'à déplacer ou supprimer avant de supprimer l’étage' : '';
      return h(
        'div',
        { class: `floor-row${f.id === currentId ? ' current' : ''}` },
        name,
        rename,
        h('button', {
          class: 'btn tiny',
          type: 'button',
          text: '▲',
          title: 'Monter d’un niveau',
          'aria-label': `Monter ${f.name} d'un niveau`,
          disabled: f.position >= floors.length - 1,
          onclick: () => call(`/api/floors/${f.id}`, { method: 'PATCH', body: { position: f.position + 1 } }),
        }),
        h('button', {
          class: 'btn tiny',
          type: 'button',
          text: '▼',
          title: 'Descendre d’un niveau',
          'aria-label': `Descendre ${f.name} d'un niveau`,
          disabled: f.position === 0,
          onclick: () => call(`/api/floors/${f.id}`, { method: 'PATCH', body: { position: f.position - 1 } }),
        }),
        // La raison d'un refus est écrite, pas seulement au survol d'un bouton désactivé (tablette, clavier, lecteur d'écran).
        h('span', { class: 'muted small', text: `${plural(count, 'équipement', 'équipements')}${f.hasPlan ? '' : ', pas de plan'}${blocked && count > 0 ? ` - ${blocked}` : ''}` }),
        h('button', {
          class: 'btn tiny danger',
          type: 'button',
          text: 'Supprimer',
          disabled: Boolean(blocked),
          'aria-label': blocked ? `Supprimer ${f.name} : impossible, ${blocked}` : `Supprimer ${f.name}`,
          onclick: () => confirm(`Supprimer l'étage « ${f.name} » et son plan ?`) && call(`/api/floors/${f.id}`, { method: 'DELETE' }, 'Étage supprimé'),
        }),
      );
    });
    const newName = h('input', { placeholder: 'Nom du nouvel étage (ex. Étage)', maxlength: '40', 'aria-label': 'Nom du nouvel étage' });
    const add = h(
      'form',
      {
        class: 'row wrap',
        onsubmit: (e) => {
          e.preventDefault();
          const value = newName.value.trim();
          if (!value) {
            newName.focus();
            return toast("Donnez un nom à l'étage");
          }
          call('/api/floors', { method: 'POST', body: { name: value } }, `Étage « ${value} » ajouté au-dessus des autres`).then((ok) => {
            if (!ok) return;
            newName.value = '';
            rerender();
          });
        },
      },
      newName,
      h('button', { class: 'btn small', type: 'submit', text: 'Ajouter un étage' }),
    );
    box.replaceChildren(
      h('p', { class: 'small muted', text: 'Étages, du plus haut au plus bas. Chaque étage a son plan ; un équipement et une zone appartiennent à un seul étage.' }),
      ...rows,
      add,
    );
  }

  return { renderBar, renderStack, renderAdmin };
}
