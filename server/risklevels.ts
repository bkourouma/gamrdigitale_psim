/**
 * Niveaux de l'indice de sécurité GAMR (1 à 60), partagés par le PSIM (gestion des risques) et le portail de suivi :
 * les deux côtés nomment un indice de la même façon, sans dépendre du moteur.
 */
export type RiskLevel = 'faible' | 'modere' | 'eleve' | 'critique';

/** Seuils de l'indice (1-60). */
export const LEVELS: { level: RiskLevel; max: number; label: string }[] = [
  { level: 'faible', max: 8, label: 'Faible' },
  { level: 'modere', max: 20, label: 'Modéré' },
  { level: 'eleve', max: 36, label: 'Élevé' },
  { level: 'critique', max: 60, label: 'Critique' },
];

export const levelOf = (index: number): { level: RiskLevel; label: string } => {
  const found = LEVELS.find((l) => index <= l.max) ?? LEVELS[LEVELS.length - 1];
  return { level: found.level, label: found.label };
};
