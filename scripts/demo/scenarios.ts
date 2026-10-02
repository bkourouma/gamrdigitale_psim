/**
 * Scenarios de demonstration. Chaque scenario est une suite d'evenements dates (en secondes) :
 *  - `detector` + `state` : message MQTT publie comme le ferait un vrai detecteur ;
 *  - `fire` : ce que les cameras de la zone "voient" (0 rien, 1 fumee, 2 flammes).
 * La realite (le feu) et les detecteurs sont volontairement separes : une fausse alarme, c'est
 * un detecteur qui declenche alors que les cameras ne montrent pas de flammes.
 */

export type DetectorState = 'normal' | 'prealarm' | 'alarm' | 'fault' | 'offline';

export interface Step {
  at: number;
  detector?: string;
  state?: DetectorState;
  fire?: { zone: string; level: 0 | 1 | 2 };
  note?: string;
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  /** Mode automatique : duree de maintien avant l'extinction (laisse le temps d'agir). */
  holdSeconds: number;
  steps: Step[];
}

/** Doit rester coherent avec le site de demonstration (server/seed.ts). */
export const DEMO_DETECTORS = ['D-01', 'D-02', 'D-03', 'D-04', 'D-05', 'D-06', 'D-07'];
export const DEMO_CAMERAS = [
  { id: 'C-01', zone: 'Accueil' },
  { id: 'C-02', zone: 'Couloir' },
  { id: 'C-03', zone: 'Salle serveurs' },
  { id: 'C-04', zone: 'Entrepot' },
  { id: 'C-05', zone: 'Atelier' },
];

export const SCENARIOS: Scenario[] = [
  {
    id: 'fausse-alarme-vapeur',
    title: 'Fausse alarme : vapeur a l\'accueil',
    description: 'Le detecteur de l\'accueil se declenche, mais la camera ne montre qu\'un voile de vapeur. A qualifier : fausse alarme.',
    holdSeconds: 25,
    steps: [
      { at: 0, fire: { zone: 'Accueil', level: 1 }, note: 'De la vapeur envahit l\'accueil' },
      { at: 4, detector: 'D-01', state: 'prealarm', note: 'Le detecteur de l\'accueil passe en prealarme' },
      { at: 18, fire: { zone: 'Accueil', level: 0 }, note: 'La vapeur se dissipe' },
      { at: 24, detector: 'D-01', state: 'normal', note: 'Le detecteur revient a la normale' },
    ],
  },
  {
    id: 'incendie-atelier',
    title: 'Incendie : depart de feu a l\'atelier qui se propage a l\'entrepot',
    description: 'Prealarme puis alarme a l\'atelier, flammes visibles ; le feu gagne ensuite l\'entrepot voisin. A qualifier : feu confirme.',
    holdSeconds: 45,
    steps: [
      { at: 0, fire: { zone: 'Atelier', level: 1 }, note: 'De la fumee apparait a l\'atelier' },
      { at: 4, detector: 'D-06', state: 'prealarm', note: 'Prealarme a l\'atelier' },
      { at: 12, fire: { zone: 'Atelier', level: 2 }, note: 'Des flammes se developpent' },
      { at: 14, detector: 'D-06', state: 'alarm', note: 'ALARME a l\'atelier' },
      { at: 30, fire: { zone: 'Entrepot', level: 1 }, note: 'La fumee gagne l\'entrepot' },
      { at: 34, detector: 'D-05', state: 'prealarm', note: 'Prealarme a l\'entrepot' },
      { at: 45, fire: { zone: 'Entrepot', level: 2 }, note: 'Le feu atteint l\'entrepot' },
      { at: 47, detector: 'D-05', state: 'alarm', note: 'ALARME a l\'entrepot' },
    ],
  },
  {
    id: 'surchauffe-serveurs',
    title: 'Alarme immediate : surchauffe en salle serveurs',
    description: 'Alarme directe (sans prealarme) en salle serveurs, flammes visibles. Cas critique a traiter en priorite.',
    holdSeconds: 35,
    steps: [
      { at: 0, fire: { zone: 'Salle serveurs', level: 2 }, note: 'Un equipement prend feu' },
      { at: 2, detector: 'D-03', state: 'alarm', note: 'ALARME en salle serveurs' },
    ],
  },
  {
    id: 'defaut-detecteur',
    title: 'Defaut technique : detecteur du couloir',
    description: 'Le detecteur du couloir signale un defaut puis revient : aucun incident ne doit etre cree, seul le statut change.',
    holdSeconds: 5,
    steps: [
      { at: 0, detector: 'D-04', state: 'fault', note: 'Defaut sur le detecteur du couloir' },
      { at: 25, detector: 'D-04', state: 'normal', note: 'Le detecteur revient a la normale' },
    ],
  },
  {
    id: 'detecteur-hors-ligne',
    title: 'Perte de contact : detecteur du stockage',
    description: 'Le detecteur du stockage annonce qu\'il est hors ligne, puis revient.',
    holdSeconds: 5,
    steps: [
      { at: 0, detector: 'D-07', state: 'offline', note: 'Le detecteur du stockage ne repond plus' },
      { at: 25, detector: 'D-07', state: 'normal', note: 'Le detecteur est de nouveau en ligne' },
    ],
  },
];

/** Ordre du mode automatique (presentation en boucle). */
export const AUTO_SEQUENCE = ['fausse-alarme-vapeur', 'defaut-detecteur', 'surchauffe-serveurs', 'incendie-atelier'];

export function lastStepAt(scenario: Scenario): number {
  return Math.max(...scenario.steps.map((s) => s.at));
}
