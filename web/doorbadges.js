/**
 * Pastilles d'état de porte du plan : calcul PUR (sans page, testé par test/access-ui.test.ts) du décalage qui les empêche
 * de se recouvrir entre elles ou de masquer une pastille voisine. plan.js mesure les rectangles à l'écran, appelle
 * `placeDoorBadges`, puis pose le décalage rendu sur chaque pastille (propriété CSS `translate`).
 *
 * Règles, par ordre d'importance :
 *  1. deux pastilles de porte ne se recouvrent jamais (tant que le plan a la place de les ranger) ;
 *  2. une pastille reste dans le plan ;
 *  3. elle ne masque ni la forme ni l'étiquette d'un équipement voisin ;
 *  4. elle reste au plus près de sa porte : en place si rien ne gêne, sinon décalée d'un rang vers le bas ou le haut, ou
 *     de côté (jamais très loin : elle doit se lire comme appartenant à sa porte).
 * La pastille la plus urgente (la première de la liste) est placée la première : c'est elle qui garde sa place.
 */

/** Espace laissé entre deux pastilles, en pixels. */
export const BADGE_GAP = 3;

const overlaps = (a, b, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

const finite = (r) => r && [r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && Number.isFinite(n)) && r.w >= 0 && r.h >= 0;

/**
 * Coût d'un candidat : une pastille de porte recouverte pèse sans comparaison ; un équipement masqué ou la sortie du plan
 * coûtent à peu près un rang de décalage (sur un petit plan tout est voisin : mieux vaut rester près de sa porte que
 * fuir loin de chaque forme, et la pastille ne doit jamais sembler appartenir à une autre porte).
 */
const COST = { badge: 1000, outside: 10, obstacle: 2.5 };

/**
 * @param {{ id: string, x: number, y: number, w: number, h: number }[]} badges
 *   pastilles de porte à leur place naturelle (pixels, même repère que les obstacles), la plus urgente d'abord
 * @param {{ x: number, y: number, w: number, h: number, owner?: string }[]} [obstacles]
 *   ce qu'elles ne doivent pas recouvrir (pastilles, étiquettes) ; `owner` : identifiant de la pastille de porte à qui
 *   l'obstacle appartient (ignoré à la place naturelle, où ses propres pièces se touchent par construction)
 * @param {{ x: number, y: number, w: number, h: number } | null} [bounds]  zone du plan
 * @returns {Map<string, { dx: number, dy: number }>}  décalage (en pixels entiers) de chaque pastille
 */
export function placeDoorBadges(badges, obstacles = [], bounds = null, { gap = BADGE_GAP, rows = 3 } = {}) {
  const out = new Map();
  const fixed = (Array.isArray(obstacles) ? obstacles : []).filter(finite);
  const placed = [];
  for (const badge of Array.isArray(badges) ? badges : []) {
    if (!badge || typeof badge.id !== 'string' || !finite(badge)) continue;
    const step = Math.max(1, badge.h + gap);
    const side = Math.max(1, Math.round(badge.w * 0.5));
    // Candidats, du plus proche de la place naturelle au plus lointain (en rangs de hauteur de pastille ; le bas se lit
    // mieux que le haut, le côté coûte un peu plus qu'un rang).
    const candidates = [];
    for (let r = -rows; r <= rows; r++) {
      for (let c = -2; c <= 2; c++) {
        const distance = (r >= 0 ? r : -r * 1.3) + (Math.abs(c * side) / step) * 0.8;
        candidates.push({ dx: c * side, dy: r * step, distance });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance || b.dy - a.dy);
    let best = null;
    for (const cand of candidates) {
      let dx = cand.dx;
      if (bounds) {
        // Gardée dans la largeur du plan (un décalage de côté se rabat contre le bord).
        const left = badge.x + dx;
        if (left < bounds.x) dx += bounds.x - left;
        const over = badge.x + dx + badge.w - (bounds.x + bounds.w);
        if (over > 0) dx -= over;
      }
      const rect = { x: badge.x + dx, y: badge.y + cand.dy, w: badge.w, h: badge.h };
      const natural = cand.dx === 0 && cand.dy === 0;
      let penalty = 0;
      if (bounds && (rect.y < bounds.y - 2 || rect.y + rect.h > bounds.y + bounds.h + 2)) penalty += COST.outside;
      for (const o of fixed) if ((!natural || o.owner !== badge.id) && overlaps(rect, o)) penalty += COST.obstacle;
      for (const p of placed) if (overlaps(rect, p, gap)) penalty += COST.badge;
      const cost = penalty + cand.distance;
      if (best === null || cost < best.cost) best = { dx, dy: cand.dy, cost, rect };
      if (penalty === 0) break; // rien ne gêne : la plus proche gagne, pas besoin de chercher plus loin
    }
    placed.push(best.rect);
    out.set(badge.id, { dx: Math.round(best.dx), dy: Math.round(best.dy) });
  }
  return out;
}
