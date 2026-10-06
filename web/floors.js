/**
 * Étages (duplex, immeuble) : barre des étages avec l'état de chaque niveau, vue éclatée en perspective (tous les niveaux
 * empilés) et gestion des étages par l'administrateur.
 *
 * Sécurité : une alarme sur un étage que l'opérateur ne regarde pas reste visible (onglet dont le cadre clignote, avec le
 * nombre d'alarmes), et l'ouverture d'un incident amène l'écran sur l'étage concerné (voir app.js, onIncident).
 * Les boutons et plateaux sont mis à jour SUR PLACE à chaque message d'équipement : les recréer ferait perdre un clic
 * commencé (appui puis relâchement sur un nouvel élément) et le focus clavier, au pire moment (pendant une alarme).
 */

const FIRING = new Set(['alarm', 'prealarm']);
const DOWN = new Set(['offline', 'fault']);

const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

/** État d'un étage en forme + icône + mot : la puce des onglets et des cartes de la vue éclatée. */
const LEVEL_LOOK = {
  normal: { pill: 'is-ok', icon: 'state-ok' },
  alarm: { pill: 'is-solid-alarm', icon: 'state-alarm' },
  prealarm: { pill: 'is-solid-warning', icon: 'state-warning' },
  down: { pill: 'is-fault', icon: 'wrench' },
};

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

export function createFloorsUi({ h, api, toast, icon, dialogs }) {
  /** Contenu d'une puce d'état (icône + mot), réécrit seulement quand le texte change. */
  function fillState(el, level, text) {
    if (el.dataset.text === `${level}|${text}`) return;
    el.dataset.text = `${level}|${text}`;
    el.replaceChildren(icon(LEVEL_LOOK[level]?.icon ?? 'state-unknown'), h('span', { text }));
  }

  /**
   * Barre des étages : un onglet par niveau (du plus bas au plus haut, boutons segmentés avec leur puce d'état), puis la
   * bascule vers la vue éclatée. Masquée s'il n'y a qu'un étage, sauf en édition (on y voit l'étage modifié).
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
          { type: 'button', class: 'floor-tab', 'aria-pressed': 'false', dataset: { floor: String(f.id) }, onclick: () => onSelect(f.id) },
          h('span', { class: 'floor-name', text: f.name }),
          // Lu « Étage : 1 alarme » et non « Étage 1 alarme » (le nom et l'état se suivent sans ponctuation à l'écran).
          h('span', { class: 'sr-only floor-sep', text: ' : ' }),
          h('span', { class: 'floor-state' }),
        ),
      );
      const stack = many
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm stack-toggle',
              'aria-pressed': 'false',
              title: 'Tous les étages empilés en perspective, avec leur état',
              onclick: () => onMode(bar.dataset.mode === 'stack' ? 'floor' : 'stack'),
            },
            icon('layers'),
            h('span', { text: 'Vue éclatée' }),
          )
        : null;
      bar.replaceChildren(h('div', { class: 'segmented floor-tabs', role: 'group', 'aria-label': 'Étages' }, ...buttons), ...(stack ? [stack] : []));
    }
    // Mise à jour sur place : classes, état, étage affiché.
    bar.dataset.mode = mode;
    for (const button of bar.querySelectorAll('.floor-tab')) {
      const f = floors.find((x) => String(x.id) === button.dataset.floor);
      if (!f) continue;
      const s = floorSummary(f.id, devices, incidents);
      const current = mode === 'floor' && f.id === currentId;
      button.className = `floor-tab lvl-${s.level}${current ? ' current' : ''}`;
      button.setAttribute('aria-pressed', String(current));
      button.title = `${f.name} : ${s.text}${f.hasPlan ? '' : ' (pas encore de plan)'}${current ? '' : '. Touchez pour l’afficher.'}`;
      const state = button.querySelector('.floor-state');
      const quiet = s.level === 'normal';
      state.hidden = quiet;
      button.querySelector('.floor-sep').hidden = quiet;
      state.className = `floor-state lvl-${s.level}`;
      if (!quiet) fillState(state, s.level, s.text);
    }
    const toggle = bar.querySelector('.stack-toggle');
    if (toggle) toggle.setAttribute('aria-pressed', String(mode === 'stack'));
  }

  /**
   * Vue éclatée : chaque étage est un plateau incliné, empilé au-dessus du précédent (le plus haut en haut). Les détecteurs
   * qui sonnent se dressent au-dessus de leur plateau ; les plateaux AU-DESSUS d'un étage en alarme deviennent
   * transparents pour ne pas le cacher. Un clic sur un plateau (ou sur sa carte dans la liste) l'ouvre à plat.
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
      // La liste dit la même chose en texte : lisible au lecteur d'écran, et on touche une carte sans viser un plateau.
      const list = h(
        'ol',
        { class: 'stack-list', 'aria-label': 'État des étages, du plus haut au plus bas' },
        ...[...floors].reverse().map((f) =>
          h(
            'li',
            { dataset: { floor: String(f.id) } },
            h(
              'button',
              { type: 'button', class: 'stack-open', onclick: () => onOpen(f.id), title: `Afficher le plan de ${f.name}` },
              h('span', { class: 'stack-open-head' }, h('strong', { class: 'stack-open-name', text: f.name }), icon('chevron-right')),
              h('span', { class: 'pill floor-pill' }),
              h('span', { class: 'firing-ids' }),
              h('span', { class: 'stack-counts' }),
            ),
          ),
        ),
      );
      const side = h('div', { class: 'stack-side' }, h('p', { class: 'hint', text: 'Touchez un étage pour l’afficher à plat.' }), list);
      view.replaceChildren(scene, side);
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
      const pill = li.querySelector('.floor-pill');
      pill.className = `pill floor-pill ${LEVEL_LOOK[s.level]?.pill ?? ''}`;
      fillState(pill, s.level, s.text);
      const firing = li.querySelector('.firing-ids');
      firing.hidden = s.firing.length === 0;
      firing.textContent = s.firing.length ? `${s.firing.length > 1 ? 'Détecteurs qui sonnent' : 'Détecteur qui sonne'} : ${s.firing.join(', ')}` : '';
      li.querySelector('.stack-counts').textContent = `${plural(s.detectors, 'détecteur', 'détecteurs')} · ${plural(s.cameras, 'caméra', 'caméras')}${f.hasPlan ? '' : ' · pas de plan'}`;
    }
  }

  /** Gestion des étages (administrateur, mode édition) : ajouter, renommer, monter / descendre, supprimer. */
  function renderAdmin(box, { floors, devices, currentId, rerender }) {
    // Reconstruit seulement si les étages ou leur contenu changent : un message d'équipement ne doit pas voler le focus.
    const counts = floors.map((f) => devices.filter((d) => d.floorId === f.id).length);
    const key = JSON.stringify([floors.map((f) => [f.id, f.name, f.position, f.hasPlan]), counts, currentId]);
    if (box.dataset.key === key) return;
    // Jamais pendant une saisie : un nom modifié et pas encore enregistré (ou un nouvel étage commencé) n'est pas écrasé,
    // que le champ ait encore le focus ou non (une alarme a pu emmener l'opérateur ailleurs entre-temps).
    const dirty = [...box.querySelectorAll('input')].some((el) => el.value !== (el.dataset.original ?? ''));
    if (dirty) return;
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
      // Rangée compacte : le champ est libellé pour les lecteurs d'écran (aria-label « Nom de l'étage … »), sans libellé visible répété par rangée.
      const name = h('input', { value: f.name, maxlength: '40', 'aria-label': `Nom de l'étage ${f.name}`, dataset: { original: f.name } });
      const rename = h('button', { class: 'btn btn-sm', type: 'button', disabled: true }, icon('pencil'), h('span', { text: 'Renommer' }));
      name.addEventListener('input', () => {
        rename.disabled = name.value.trim() === f.name;
        name.removeAttribute('aria-invalid');
      });
      const save = () => {
        const value = name.value.trim();
        if (!value) {
          name.setAttribute('aria-invalid', 'true');
          name.focus();
          return toast("Le nom de l’étage ne peut pas être vide : écrivez un nom, ou remettez l'ancien");
        }
        if (value === f.name) return;
        rename.classList.add('is-busy');
        call(`/api/floors/${f.id}`, { method: 'PATCH', body: { name: value } }, 'Étage renommé').then((ok) => {
          rename.classList.remove('is-busy');
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
        { class: `floor-row actions${f.id === currentId ? ' current' : ''}` },
        name,
        rename,
        h(
          'button',
          {
            class: 'btn btn-sm btn-icon',
            type: 'button',
            title: 'Monter d’un niveau',
            'aria-label': `Monter ${f.name} d’un niveau`,
            disabled: f.position >= floors.length - 1,
            onclick: () => call(`/api/floors/${f.id}`, { method: 'PATCH', body: { position: f.position + 1 } }),
          },
          icon('chevron-up'),
        ),
        h(
          'button',
          {
            class: 'btn btn-sm btn-icon',
            type: 'button',
            title: 'Descendre d’un niveau',
            'aria-label': `Descendre ${f.name} d’un niveau`,
            disabled: f.position === 0,
            onclick: () => call(`/api/floors/${f.id}`, { method: 'PATCH', body: { position: f.position - 1 } }),
          },
          icon('chevron-down'),
        ),
        // La raison d'un refus est écrite, pas seulement au survol d'un bouton désactivé (tablette, clavier, lecteur d'écran).
        h('span', { class: 'muted small floor-row-note', text: `${plural(count, 'équipement', 'équipements')}${f.hasPlan ? '' : ', pas de plan'}${blocked ? ` - ${blocked}` : ''}` }),
        // Geste grave : en contour, repoussé à l'écart (.actions > .btn-danger), confirmé en mots simples.
        h(
          'button',
          {
            class: 'btn btn-sm btn-danger',
            type: 'button',
            disabled: Boolean(blocked),
            'aria-label': blocked ? `Supprimer ${f.name} : impossible, ${blocked}` : `Supprimer ${f.name}`,
            onclick: async () => {
              const ok = await dialogs.confirm({ heading: `Supprimer l’étage « ${f.name} » ?`, message: 'Son plan est supprimé avec lui. Cette action est définitive.', confirmLabel: 'Supprimer l’étage' });
              if (ok) call(`/api/floors/${f.id}`, { method: 'DELETE' }, 'Étage supprimé');
            },
          },
          icon('trash'),
          h('span', { text: 'Supprimer' }),
        ),
      );
    });
    const newName = h('input', { placeholder: 'ex. Étage 1', maxlength: '40' });
    const addButton = h('button', { class: 'btn btn-sm', type: 'submit' }, icon('plus'), h('span', { text: 'Ajouter un étage' }));
    const add = h(
      'form',
      {
        class: 'floor-add',
        onsubmit: (e) => {
          e.preventDefault();
          const value = newName.value.trim();
          if (!value) {
            newName.setAttribute('aria-invalid', 'true');
            newName.focus();
            return toast("Donnez un nom à l’étage avant de l'ajouter");
          }
          addButton.classList.add('is-busy');
          call('/api/floors', { method: 'POST', body: { name: value } }, `Étage « ${value} » ajouté au-dessus des autres`).then((ok) => {
            addButton.classList.remove('is-busy');
            if (!ok) return;
            newName.value = '';
            rerender();
          });
        },
      },
      h('label', { class: 'field' }, h('span', { text: 'Nouvel étage' }), newName),
      addButton,
    );
    newName.addEventListener('input', () => newName.removeAttribute('aria-invalid'));
    box.replaceChildren(
      h('p', { class: 'small muted', text: 'Étages, du plus haut au plus bas. Chaque étage a son plan ; un équipement et une zone appartiennent à un seul étage.' }),
      ...rows,
      add,
    );
  }

  return { renderBar, renderStack, renderAdmin };
}
