// Vue « Gestion des risques » : indice par zone (probabilite x vulnerabilite x repercussions, 1 a 60),
// priorites d'action chiffrees, tendances. Lecture pour tous, evaluation reservee a l'administrateur.

const LEVEL_NAME = { faible: 'Faible', modere: 'Modéré', eleve: 'Élevé', critique: 'Critique' };
const HORIZON = {
  court: ['Court terme', 'à faire maintenant'],
  moyen: ['Moyen terme', 'à planifier'],
  long: ['Long terme', 'travaux structurels'],
};
const P_LABEL = { 1: 'Improbable', 2: 'Possible', 3: 'Probable' };
const R_LABEL = { 1: 'Négligeable', 2: 'Limité', 3: 'Sérieux', 4: 'Grave', 5: 'Catastrophique' };
const SVG_NS = 'http://www.w3.org/2000/svg';

function sparkline(points, level) {
  if (!points || points.length < 2) return null;
  const w = 90;
  const hgt = 26;
  const xs = (i) => (i / (points.length - 1)) * (w - 4) + 2;
  const ys = (v) => hgt - 2 - (v / 60) * (hgt - 4);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  svg.setAttribute('class', `spark lvl-${level ?? 'faible'}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Tendance sur ${points.length} jours : de ${points[0].index} à ${points[points.length - 1].index}`);
  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', points.map((p, i) => `${xs(i).toFixed(1)},${ys(p.index).toFixed(1)}`).join(' '));
  svg.append(line);
  return svg;
}

export function createRiskView({ api, h, toast, getMe }) {
  const root = document.getElementById('risk-view');
  let data = null;
  let timer = null;
  let editingZone = null;
  const open = new Set(); // zones dont le detail est deplie

  async function refresh() {
    try {
      data = await api('/api/risk');
      render();
    } catch (err) {
      toast(err.message);
    }
  }

  const chip = (value, label, level) => h('span', { class: `risk-chip${level ? ` lvl-${level}` : ''}`, title: label, text: value });

  function siteCard() {
    const s = data.site;
    const stale = data.zones.filter((z) => z.stale).length;
    const missing = s.totalZones - s.assessedZones;
    return h(
      'section',
      { class: `card risk-site lvl-${s.level ?? 'none'}` },
      h(
        'div',
        { class: 'risk-gauge' },
        s.index === null ? h('span', { class: 'risk-big none', text: '—' }) : h('span', { class: 'risk-big', text: String(s.index) }),
        h('span', { class: 'risk-scale', text: '/ 60' }),
      ),
      h(
        'div',
        { class: 'risk-site-text' },
        h('h2', { text: 'Indice de sécurité du site' }),
        s.index === null
          ? h('p', { text: "Aucune zone évaluée : le risque du site est inconnu." })
          : h('p', {}, h('strong', { text: `Niveau ${LEVEL_NAME[s.level]}` }), ` — zone la plus exposée : ${s.worstZone}`),
        h('p', { class: 'small muted', text: `${s.assessedZones} zone(s) évaluée(s) sur ${s.totalZones}. L'indice du site est celui de sa zone la plus exposée.` }),
        missing > 0 ? h('p', { class: 'small warn', text: `${missing} zone(s) à évaluer : leur risque est inconnu, aucune note n'est supposée.` }) : null,
        stale > 0 ? h('p', { class: 'small warn', text: `${stale} évaluation(s) de plus d'un an : à revoir.` }) : null,
      ),
      sparkline(data.history.__site__, s.level) ?? h('span', { class: 'small muted', text: "Tendance : pas encore d'historique (un point par jour)." }),
    );
  }

  function zoneRow(z) {
    const admin = getMe()?.role === 'admin';
    const row = h('div', { class: `risk-row${z.assessed ? '' : ' unassessed'}` });
    const head = h('div', { class: 'risk-row-head' });
    head.append(h('strong', { class: 'risk-zone', text: z.zone }));
    if (!z.assessed) {
      head.append(h('span', { class: 'risk-none', text: 'À évaluer' }));
    } else {
      head.append(
        chip(`P ${z.p.value}`, `Probabilité ${z.p.value}/3 : ${P_LABEL[z.p.value]}`),
        chip(`V ${z.v.value}`, `Vulnérabilité ${z.v.value}/4`),
        chip(`R ${z.r.value}`, `Répercussions ${z.r.value}/5 : ${R_LABEL[z.r.value]}`),
        h(
          'span',
          { class: 'risk-bar', title: `Indice ${z.index} sur 60` },
          h('i', { class: `lvl-${z.level}`, style: undefined }),
        ),
        h('strong', { class: `risk-index lvl-${z.level}`, text: String(z.index) }),
        h('span', { class: `risk-level lvl-${z.level}`, text: z.levelLabel }),
      );
      const trend = sparkline(data.history[z.zone], z.level);
      if (trend) head.append(trend);
      if (z.stale) head.append(h('span', { class: 'risk-stale', text: 'à revoir', title: "Évaluation de plus d'un an" }));
    }
    const actions = h('span', { class: 'risk-actions' });
    if (z.assessed) {
      actions.append(
        h('button', {
          class: 'btn tiny',
          type: 'button',
          text: open.has(z.zone) ? 'Masquer le calcul' : 'Voir le calcul',
          onclick: () => (open.has(z.zone) ? open.delete(z.zone) : open.add(z.zone), render()),
        }),
      );
    }
    if (admin) {
      actions.append(
        h('button', { class: 'btn tiny', type: 'button', text: z.assessed ? 'Modifier' : 'Évaluer', onclick: () => ((editingZone = z.zone), render(), root.querySelector('#risk-edit')?.scrollIntoView({ block: 'center' })) }),
      );
    }
    head.append(actions);
    row.append(head);
    // la largeur de la barre est posee par le DOM (CSP : pas de style en ligne dans le HTML)
    const fill = head.querySelector('.risk-bar i');
    if (fill) fill.style.width = `${(z.index / 60) * 100}%`;

    if (z.assessed && open.has(z.zone)) {
      const list = (title, items) => h('div', {}, h('h4', { text: title }), h('ul', {}, ...items.map((t) => h('li', { text: t }))));
      row.append(
        h(
          'div',
          { class: 'risk-detail' },
          list(`Probabilité : ${z.p.value} / 3`, z.p.reasons),
          list(`Vulnérabilité : ${z.v.value} / 4`, z.v.reasons),
          list(`Répercussions : ${z.r.value} / 5`, [...z.r.reasons, `Image ${z.r.image} · Économie ${z.r.economy} · Humaines ${z.r.human}`]),
          h('p', { class: 'small muted', text: `Indice = ${z.p.value} × ${z.v.value} × ${z.r.value} = ${z.index}. Évalué par ${z.assessedBy} le ${new Date(z.assessedAt).toLocaleDateString('fr-FR')}.${z.notes ? ` Notes : ${z.notes}` : ''}` }),
        ),
      );
    }
    return row;
  }

  function priorities() {
    const groups = ['court', 'moyen', 'long'].map((hz) => ({ hz, items: data.priorities.filter((p) => p.horizon === hz) }));
    return h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: "Priorités d'action" })),
      data.priorities.length === 0 ? h('p', { class: 'empty', text: 'Aucune mesure à proposer : les zones évaluées sont à un niveau de risque faible et correctement équipées.' }) : null,
      ...groups
        .filter((g) => g.items.length)
        .map((g) =>
          h(
            'div',
            { class: `prio-group hz-${g.hz}` },
            h('h3', {}, HORIZON[g.hz][0], h('span', { class: 'muted small', text: ` — ${HORIZON[g.hz][1]}` })),
            h(
              'ul',
              { class: 'prio-list' },
              ...g.items.map((p) =>
                h(
                  'li',
                  {},
                  h('span', { class: 'prio-gain' + (p.gain ? ' good' : ''), text: p.gain ? `−${p.gain}` : 'non chiffré', title: p.gain ? `Baisse de l'indice de « ${p.zone} » si la mesure est réalisée` : "Effet qualitatif, non chiffrable" }),
                  h('div', {}, h('strong', { text: p.title }), h('p', { class: 'small muted', text: p.why })),
                ),
              ),
            ),
          ),
        ),
    );
  }

  function editForm() {
    const z = data.zones.find((x) => x.zone === editingZone);
    if (!z) return null;
    const select = (name, labels, value, max) => {
      const el = h('select', { name, 'aria-label': name });
      for (let i = 1; i <= max; i++) el.append(h('option', { value: String(i), text: `${i} — ${labels[i]}` }));
      el.value = String(value);
      return el;
    };
    const p = select('probability', P_LABEL, z.p?.base ?? 2, 3);
    const image = select('impactImage', R_LABEL, z.r?.image ?? 2, 5);
    const economy = select('impactEconomy', R_LABEL, z.r?.economy ?? 2, 5);
    const human = select('impactHuman', R_LABEL, z.r?.human ?? 2, 5);
    const boxes = data.defenses.map((d) => {
      const input = h('input', { type: 'checkbox', value: d.id });
      input.checked = z.defenses.includes(d.id);
      return { d, input };
    });
    const notes = h('textarea', { rows: '2', maxlength: '500', placeholder: 'Notes (facultatif) : contexte, sources, hypothèses…', 'aria-label': 'Notes' });
    notes.value = z.notes ?? '';
    const msg = h('p', { class: 'small', role: 'status' });
    const form = h(
      'form',
      {
        class: 'risk-form',
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const result = await api(`/api/risk/zones/${encodeURIComponent(z.zone)}`, {
              method: 'PUT',
              body: {
                probability: Number(p.value),
                defenses: boxes.filter((b) => b.input.checked).map((b) => b.d.id),
                impactImage: Number(image.value),
                impactEconomy: Number(economy.value),
                impactHuman: Number(human.value),
                notes: notes.value,
              },
            });
            toast(`« ${z.zone} » : indice ${result.index} (${result.levelLabel})`, 'ok');
            editingZone = null;
            refresh();
          } catch (err) {
            msg.textContent = err.message;
            msg.className = 'small error';
          }
        },
      },
      h('label', {}, 'Probabilité de départ de feu (environnement, activité)', p),
      h('fieldset', {}, h('legend', { text: 'Lignes de défense en place' }), ...boxes.map((b) => h('label', { class: 'check' }, b.input, ` ${b.d.label}`))),
      h('p', { class: 'small muted', text: "Répercussions possibles d'un incendie dans cette zone (la plus grave des trois est retenue) :" }),
      h('div', { class: 'row wrap' }, h('label', {}, 'Image', image), h('label', {}, 'Économie', economy), h('label', {}, 'Humaines', human)),
      notes,
      h('div', { class: 'row wrap' }, h('button', { class: 'btn primary small', type: 'submit', text: 'Enregistrer' }), h('button', { class: 'btn small', type: 'button', text: 'Annuler', onclick: () => ((editingZone = null), render()) })),
      h('p', { class: 'small muted', text: "La vulnérabilité est aussi corrigée automatiquement par l'état réel du PSIM (détecteur absent ou hors service, zone sans caméra) et la probabilité par l'historique d'incendies : ces corrections ne se saisissent pas." }),
      msg,
    );
    return h('section', { class: 'card', id: 'risk-edit' }, h('div', { class: 'card-head' }, h('h2', { text: `Évaluer la zone « ${z.zone} »` })), form);
  }

  function render() {
    if (!data) return;
    const legend = h(
      'p',
      { class: 'small muted' },
      'Indice = Probabilité (1-3) × Vulnérabilité (1-4) × Répercussions (1-5), de 1 à 60. Niveaux : ',
      ...data.bands.map((b, i) => h('span', { class: `risk-chip lvl-${b.level}`, text: `${b.label} ≤ ${b.max}`, title: `${i === 0 ? 1 : data.bands[i - 1].max + 1} à ${b.max}` })),
    );
    root.replaceChildren(
      siteCard(),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: 'Risque par zone' })), legend, ...data.zones.map(zoneRow)),
      priorities(),
      editForm(),
    );
  }

  return {
    async show() {
      root.hidden = false;
      await refresh();
      clearInterval(timer);
      timer = setInterval(() => {
        if (!editingZone) refresh(); // pas de rechargement pendant une saisie
      }, 20000);
    },
    hide() {
      root.hidden = true;
      clearInterval(timer);
    },
    isOpen: () => !root.hidden,
  };
}
