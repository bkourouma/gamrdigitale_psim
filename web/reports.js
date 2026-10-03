// Rapports et exports : formulaire de période, liens vers le rapport imprimable et les exports CSV.
import { CATEGORIES, CATEGORY_LABEL } from './sources.js';

const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function createReportsView({ h, getMe }) {
  const box = document.getElementById('reports-box');
  const today = new Date();
  const monthAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29);

  const from = h('input', { type: 'date', value: day(monthAgo), 'aria-label': 'Du' });
  const to = h('input', { type: 'date', value: day(today), 'aria-label': 'Au' });
  const category = h('select', { 'aria-label': 'Catégorie' }, h('option', { value: '', text: 'Toutes les catégories' }), ...CATEGORIES.map((c) => h('option', { value: c, text: CATEGORY_LABEL[c] })));
  const links = h('div', { class: 'row wrap' });

  function href(path) {
    const q = new URLSearchParams({ from: from.value, to: to.value });
    if (category.value) q.set('category', category.value);
    return `${path}?${q}`;
  }

  // Liens (et non fetch) : le navigateur ouvre le rapport ou télécharge le fichier, avec le cookie de session.
  function draw() {
    const admin = getMe()?.role === 'admin';
    const link = (path, text, title) => h('a', { class: 'btn small', href: href(path), target: '_blank', rel: 'noopener', text, title });
    links.replaceChildren(
      link('/api/reports/incidents', 'Rapport imprimable', 'S’ouvre dans un nouvel onglet : Imprimer, puis Enregistrer au format PDF'),
      link('/api/reports/incidents.csv', 'Incidents (CSV)', 'Fichier pour Excel (séparateur « ; », UTF-8)'),
      admin ? link('/api/reports/audit.csv', 'Journal complet (CSV)', 'Toutes les actions des utilisateurs et du système (administrateur)') : null,
    );
  }

  for (const el of [from, to, category]) el.addEventListener('change', draw);
  box.replaceChildren(
    h('p', { class: 'muted small', text: "Pour la direction, un assureur ou un audit : synthèse chiffrée, détail des incidents et fiche de chaque incident (chronologie, alertes, images). Heure du serveur." }),
    h('div', { class: 'row wrap' }, h('label', { class: 'small' }, 'Du ', from), h('label', { class: 'small' }, 'au ', to), category),
    links,
  );
  draw();
  return { draw };
}
