/**
 * Jauge GAMR : l'indice de sécurité (1 à 60) dessiné comme sur l'affiche, en thermomètre, en tube ou en anneau.
 * Une seule échelle partout : seuils 8 (faible), 20 (modéré), 36 (élevé), 60 (critique), les mêmes que le serveur
 * (server/risklevels.ts). Rien n'est inventé : sans indice, la jauge se montre vide et en pointillé (« À évaluer »).
 *
 * Les éléments sont construits avec createElement / createElementNS (jamais d'HTML injecté) ; la valeur passe par la
 * propriété CSS --v (la politique de sécurité interdit l'attribut style dans le HTML, pas le CSSOM).
 */

export const BANDS = [
  { level: 'faible', max: 8, label: 'Faible' },
  { level: 'modere', max: 20, label: 'Modéré' },
  { level: 'eleve', max: 36, label: 'Élevé' },
  { level: 'critique', max: 60, label: 'Critique' },
];

/** Niveau d'un indice, ou `null` quand il n'y en a pas. */
export function levelOf(index) {
  if (index === null || index === undefined || !Number.isFinite(index)) return null;
  return BANDS.find((b) => index <= b.max) ?? BANDS[BANDS.length - 1];
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

const clampIndex = (index) => Math.max(0, Math.min(60, Number(index) || 0));

/**
 * Thermomètre vertical : tube de verre, colonne aux couleurs des bandes montée jusqu'à l'indice, bulbe à la couleur du
 * niveau, graduations 8 / 20 / 36 / 60. `set(index)` le met à jour (la colonne glisse vers sa nouvelle valeur).
 */
export function createThermometer({ height } = {}) {
  const root = el('span', 'thermo is-none');
  root.setAttribute('aria-hidden', 'true');
  if (height) root.style.setProperty('--h', `${height}px`);
  const tube = el('span', 'thermo-tube');
  tube.append(el('span', 'thermo-fill'));
  const ticks = el('span', 'thermo-ticks');
  for (const t of [60, 36, 20, 8]) ticks.append(el('i', null, String(t)));
  root.append(tube, el('span', 'thermo-bulb'), ticks);
  return {
    el: root,
    set(index) {
      const level = levelOf(index);
      root.style.setProperty('--v', String(level ? clampIndex(index) : 0));
      root.className = `thermo ${level ? `lvl-${level.level}` : 'is-none'}`;
    },
  };
}

/** Tube horizontal (une zone, un site) : même verre, mêmes repères de seuils que le thermomètre. */
export function createTube({ label } = {}) {
  const root = el('span', 'tube is-none');
  root.append(el('span', 'tube-fill'));
  root.setAttribute('role', 'img');
  return {
    el: root,
    set(index) {
      const level = levelOf(index);
      root.style.setProperty('--v', String(level ? clampIndex(index) : 0));
      root.className = `tube ${level ? `lvl-${level.level}` : 'is-none'}`;
      root.setAttribute('aria-label', level ? `${label ? `${label} : ` : ''}indice ${index} sur 60, niveau ${level.label.toLowerCase()}` : `${label ? `${label} : ` : ''}pas encore évalué`);
    },
  };
}

/* Anneau : arc de 240°, ouvert en bas, comme le symbole du logo (et la jauge du téléphone de l'affiche). */
const CX = 50;
const CY = 54;
const R = 38;
const START = 150; // degrés, sens horaire à l'écran
const SWEEP = 240;

function point(angle) {
  const a = (angle * Math.PI) / 180;
  return [CX + R * Math.cos(a), CY + R * Math.sin(a)];
}

function arc(fromDeg, toDeg) {
  const [x0, y0] = point(fromDeg);
  const [x1, y1] = point(toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const angleOf = (value) => START + (SWEEP * value) / 60;

/**
 * Anneau de l'indice : quatre bandes pâles (les seuils), l'arc de la valeur à la couleur de son niveau, le chiffre au
 * centre. `size` en pixels. `set(index)` le met à jour.
 */
export function createRing({ size = 168, caption = 'Indice de sécurité' } = {}) {
  const root = svg('svg', { viewBox: '0 0 100 100', width: size, height: size, class: 'ring is-none', role: 'img' });
  let from = 0;
  for (const band of BANDS) {
    const gap = band.max === 60 ? 0 : 1.2; // fin interstice entre deux bandes
    root.append(svg('path', { d: arc(angleOf(from) + (from ? 0.6 : 0), angleOf(band.max) - gap / 2), class: `ring-track band ${band.level}` }));
    from = band.max;
  }
  const value = svg('path', { class: 'ring-value', d: arc(START, START + 0.01) });
  const num = svg('text', { x: CX, y: 57, 'text-anchor': 'middle', class: 'ring-num' });
  const of = svg('text', { x: CX, y: 70, 'text-anchor': 'middle', class: 'ring-of' });
  of.textContent = 'sur 60';
  root.append(value, num, of);
  return {
    el: root,
    set(index) {
      const level = levelOf(index);
      root.setAttribute('class', `ring ${level ? `lvl-${level.level}` : 'is-none'}`);
      if (level) {
        const v = clampIndex(index);
        value.setAttribute('d', arc(START, angleOf(Math.max(v, 0.6))));
        value.removeAttribute('visibility');
        num.textContent = String(index);
      } else {
        value.setAttribute('visibility', 'hidden');
        num.textContent = '—';
      }
      root.setAttribute('aria-label', level ? `${caption} : ${index} sur 60, niveau ${level.label.toLowerCase()}` : `${caption} : pas encore évalué`);
    },
  };
}
