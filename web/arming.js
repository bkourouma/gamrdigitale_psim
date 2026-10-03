// Armement des zones d'intrusion : état, désarmement à durée limitée (opérateur), planning (administrateur).

const DAY_LABEL = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // la semaine commence le lundi
const DURATIONS = [
  [1, '1 h'],
  [4, '4 h'],
  [12, '12 h'],
];

const fmt = (ts) =>
  new Date(ts).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export function summarizeSchedule(windows) {
  return windows.map((w) => `${w.days.map((d) => DAY_LABEL[d]).join(' ')} ${w.from} → ${w.to}`).join(' ; ');
}

export function createArmingView({ api, h, toast, getMe }) {
  const card = document.getElementById('arming-card');
  const list = document.getElementById('arming-list');
  let zones = [];
  const openEditors = new Set(); // plannings en cours de consultation : on ne les referme pas a chaque rafraichissement

  async function load() {
    try {
      zones = await api('/api/arming');
    } catch (err) {
      toast(err.message);
      return;
    }
    render();
  }

  async function act(fn, success) {
    try {
      await fn();
      if (success) toast(success, 'ok');
    } catch (err) {
      toast(err.message);
    }
    load();
  }

  const put = (zone, path, body) => api(`/api/arming/${encodeURIComponent(zone)}/${path}`, { method: 'PUT', body });

  function statusText(z) {
    if (z.override) {
      return `${z.armed ? 'Armée' : 'Désarmée'} par ${z.override.by} jusqu'à ${fmt(z.override.until)}`;
    }
    if (z.schedule) {
      return `${z.armed ? 'Armée' : 'Désarmée'} (planning)${z.nextChange ? ` — ${z.armed ? 'désarmement' : 'armement'} ${fmt(z.nextChange)}` : ''}`;
    }
    return 'Armée en permanence (aucun planning)';
  }

  function row(z) {
    const admin = getMe()?.role === 'admin';
    const buttons = [];
    if (z.armed) {
      for (const [hours, label] of DURATIONS) {
        buttons.push(
          h('button', {
            class: 'btn tiny',
            type: 'button',
            text: `Désarmer ${label}`,
            title: `Désarme ${z.zone} pendant ${label} : la zone se réarme toute seule ensuite`,
            onclick: () => act(() => put(z.zone, 'override', { mode: 'disarmed', hours }), `${z.zone} désarmée pour ${label}`),
          }),
        );
      }
    } else {
      buttons.push(h('button', { class: 'btn tiny danger', type: 'button', text: 'Armer maintenant', onclick: () => act(() => put(z.zone, 'override', { mode: 'armed', hours: 12 }), `${z.zone} armée`) }));
    }
    if (z.override) {
      buttons.push(h('button', { class: 'btn tiny', type: 'button', text: 'Reprendre le planning', onclick: () => act(() => api(`/api/arming/${encodeURIComponent(z.zone)}/override`, { method: 'DELETE' }), 'Planning repris') }));
    }
    return h(
      'div',
      { class: `arming-row${z.armed ? ' armed' : ' disarmed'}` },
      h('div', { class: 'arming-head' }, h('strong', { text: z.zone }), h('span', { class: `tag ${z.armed ? 'armed' : 'disarmed'}`, text: z.armed ? 'ARMÉE' : 'DÉSARMÉE' })),
      h('p', { class: 'small muted', text: statusText(z) }),
      h('div', { class: 'row wrap' }, ...buttons),
      z.schedule ? h('p', { class: 'small', text: `Planning : armée ${summarizeSchedule(z.schedule)}` }) : null,
      admin ? scheduleEditor(z) : null,
    );
  }

  function scheduleEditor(z) {
    const windows = z.schedule ? z.schedule.map((w) => ({ ...w, days: [...w.days] })) : [{ days: [1, 2, 3, 4, 5], from: '19:00', to: '07:00' }];
    const box = h('div', { class: 'schedule-editor' });
    const msg = h('p', { class: 'small', role: 'status' });

    function draw() {
      box.replaceChildren(
        ...windows.map((w, i) => {
          const from = h('input', { type: 'time', value: w.from, 'aria-label': 'Début' });
          const to = h('input', { type: 'time', value: w.to, 'aria-label': 'Fin' });
          from.addEventListener('change', () => (w.from = from.value));
          to.addEventListener('change', () => (w.to = to.value));
          return h(
            'div',
            { class: 'row wrap window' },
            ...DAY_ORDER.map((d) => {
              const cb = h('input', { type: 'checkbox', 'aria-label': DAY_LABEL[d] });
              cb.checked = w.days.includes(d);
              cb.addEventListener('change', () => (w.days = cb.checked ? [...new Set([...w.days, d])] : w.days.filter((x) => x !== d)));
              return h('label', { class: 'check small' }, cb, ` ${DAY_LABEL[d]}`);
            }),
            h('span', { class: 'small muted', text: 'armée de' }),
            from,
            h('span', { class: 'small muted', text: 'à' }),
            to,
            h('button', { class: 'btn tiny', type: 'button', text: 'Retirer', onclick: () => (windows.splice(i, 1), draw()) }),
          );
        }),
        h(
          'div',
          { class: 'row wrap' },
          h('button', { class: 'btn tiny', type: 'button', text: 'Ajouter une plage', onclick: () => (windows.push({ days: [1, 2, 3, 4, 5], from: '19:00', to: '07:00' }), draw()) }),
          h('button', {
            class: 'btn tiny primary',
            type: 'button',
            text: 'Enregistrer le planning',
            onclick: async () => {
              try {
                await put(z.zone, 'schedule', { schedule: windows.length ? windows : null });
                msg.textContent = '';
                toast('Planning enregistré', 'ok');
                load();
              } catch (err) {
                msg.textContent = err.message;
                msg.className = 'small error';
              }
            },
          }),
          z.schedule ? h('button', { class: 'btn tiny', type: 'button', text: 'Supprimer (armée en permanence)', onclick: () => act(() => put(z.zone, 'schedule', { schedule: null }), 'Planning supprimé') }) : null,
        ),
        msg,
      );
    }
    draw();
    const details = h('details', { class: 'small' }, h('summary', { text: 'Planning hebdomadaire' }), h('p', { class: 'small muted', text: "Plages pendant lesquelles la zone est ARMÉE, à l'heure du serveur. Une plage de nuit (19:00 → 07:00) se termine le lendemain matin. En dehors des plages, la zone est désarmée." }), box);
    details.open = openEditors.has(z.zone);
    details.addEventListener('toggle', () => (details.open ? openEditors.add(z.zone) : openEditors.delete(z.zone)));
    return details;
  }

  function render() {
    card.hidden = zones.length === 0;
    // On ne reconstruit pas pendant une saisie (planning en cours d'édition).
    if (list.contains(document.activeElement) && document.activeElement.tagName !== 'BUTTON') return;
    list.replaceChildren(...zones.map(row));
  }

  return { load, render };
}
