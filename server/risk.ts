/**
 * Gestion des risques par zone (couches 1 a 3 du document d'architecture).
 *
 *   Indice = Probabilite (1-3) x Vulnerabilite (1-4) x Repercussions (1-5)   -> echelle 1 a 60
 *
 * - Probabilite  : base saisie par l'evaluateur, relevee par l'historique d'incendies confirmes.
 * - Vulnerabilite : base issue des lignes de defense cochees, majoree par l'etat reel du PSIM
 *                   (pas de detecteur, detecteur hors service, pas de camera).
 * - Repercussions : la plus grave des trois notes (image, economie, humaines) : une zone ou des
 *                   personnes sont exposees ne peut pas etre masquee par un faible impact economique.
 *
 * Une zone non evaluee n'a AUCUNE note : on ne fabrique pas de chiffre faute d'information.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Engine } from './engine.ts';
import { PsimError } from './engine.ts';
import { LEVELS, levelOf } from './risklevels.ts';
import type { RiskLevel } from './risklevels.ts';

export { LEVELS, levelOf };
export type { RiskLevel };

export const DEFENSES = [
  { id: 'extincteurs', label: 'Extincteurs adaptés et vérifiés', horizon: 'moyen' },
  { id: 'consignes', label: "Consignes et plan d'évacuation affichés", horizon: 'moyen' },
  { id: 'personnel', label: 'Personnel formé (rondes, intervention incendie)', horizon: 'moyen' },
  { id: 'compartimentage', label: 'Compartimentage / portes coupe-feu', horizon: 'long' },
  { id: 'desenfumage', label: 'Désenfumage / ventilation maîtrisée', horizon: 'long' },
] as const;

export type Horizon = 'court' | 'moyen' | 'long';

export interface Assessment {
  probability: number; // 1-3
  defenses: string[];
  impactImage: number; // 1-5
  impactEconomy: number;
  impactHuman: number;
  notes: string;
  assessedBy: string;
  assessedAt: number;
}

export interface ZoneFacts {
  detectors: number;
  cameras: number;
  detectorsDown: string[]; // identifiants des detecteurs hors ligne / en defaut
  fires: number; // incendies confirmes sur la periode (qualification « feu » + incidents confirmes en cours)
}

export interface Score {
  value: number;
  base: number;
  reasons: string[];
}

export interface ZoneRisk {
  zone: string;
  assessed: boolean;
  p: Score | null;
  v: Score | null;
  r: { value: number; image: number; economy: number; human: number; reasons: string[] } | null;
  index: number | null;
  level: RiskLevel | null;
  levelLabel: string | null;
  defenses: string[];
  facts: ZoneFacts;
  notes: string;
  assessedBy: string | null;
  assessedAt: number | null;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Vulnerabilite de base selon le nombre de lignes de defense en place. */
export function baseVulnerability(checked: number): number {
  if (checked <= 1) return 4;
  if (checked === 2) return 3;
  if (checked <= 4) return 2;
  return 1;
}

export function computeProbability(a: Assessment, facts: ZoneFacts): Score {
  const reasons = [`Évaluée à ${a.probability}/3 (environnement, activité)`];
  let uplift = 0;
  if (facts.fires >= 3) uplift = 2;
  else if (facts.fires >= 1) uplift = 1;
  if (uplift > 0) reasons.push(`+${uplift} : ${facts.fires} incendie(s) confirmé(s) dans la zone sur la période`);
  return { value: clamp(a.probability + uplift, 1, 3), base: a.probability, reasons };
}

export function computeVulnerability(a: Assessment, facts: ZoneFacts): Score {
  const checked = a.defenses.filter((d) => DEFENSES.some((x) => x.id === d)).length;
  const base = baseVulnerability(checked);
  const reasons = [`${checked}/${DEFENSES.length} lignes de défense en place`];
  let penalty = 0;
  if (facts.detectors === 0) {
    penalty++;
    reasons.push('+1 : aucun détecteur dans la zone');
  }
  if (facts.detectorsDown.length > 0) {
    penalty++;
    reasons.push(`+1 : détecteur hors service (${facts.detectorsDown.join(', ')})`);
  }
  if (facts.cameras === 0) {
    penalty++;
    reasons.push('+1 : aucune caméra ne couvre la zone');
  }
  return { value: clamp(base + penalty, 1, 4), base, reasons };
}

export function computeImpact(a: Assessment): NonNullable<ZoneRisk['r']> {
  const value = Math.max(a.impactImage, a.impactEconomy, a.impactHuman);
  const axes = [
    ['image', a.impactImage],
    ['économie', a.impactEconomy],
    ['humaines', a.impactHuman],
  ] as const;
  const worst = axes.filter(([, v]) => v === value).map(([n]) => n);
  return { value, image: a.impactImage, economy: a.impactEconomy, human: a.impactHuman, reasons: [`Retenue : la plus grave des trois (${worst.join(', ')} : ${value}/5)`] };
}

export function computeZone(zone: string, assessment: Assessment | null, facts: ZoneFacts): ZoneRisk {
  if (!assessment) {
    return { zone, assessed: false, p: null, v: null, r: null, index: null, level: null, levelLabel: null, defenses: [], facts, notes: '', assessedBy: null, assessedAt: null };
  }
  const p = computeProbability(assessment, facts);
  const v = computeVulnerability(assessment, facts);
  const r = computeImpact(assessment);
  const index = p.value * v.value * r.value;
  const { level, label } = levelOf(index);
  return { zone, assessed: true, p, v, r, index, level, levelLabel: label, defenses: assessment.defenses, facts, notes: assessment.notes, assessedBy: assessment.assessedBy, assessedAt: assessment.assessedAt };
}

// ---------------------------------------------------------------- priorites d'action

export interface Priority {
  horizon: Horizon;
  zone: string;
  title: string;
  why: string;
  /** Baisse d'indice attendue si la mesure est realisee (null = non chiffrable). */
  gain: number | null;
}

const HORIZON_ORDER: Record<Horizon, number> = { court: 0, moyen: 1, long: 2 };

function withAssessment(a: Assessment, change: Partial<Assessment>): Assessment {
  return { ...a, ...change };
}

/**
 * Mesures proposees pour faire baisser le risque, chiffrees : « gain » = baisse de l'indice si la mesure est faite.
 * Regles volontairement simples et explicables (pas de boite noire).
 */
export function buildPriorities(zones: ZoneRisk[], assessments: Map<string, Assessment>): Priority[] {
  const out: Priority[] = [];
  for (const z of zones) {
    const a = assessments.get(z.zone);
    if (!z.assessed || !a) {
      out.push({ horizon: 'court', zone: z.zone, title: `Évaluer la zone « ${z.zone} »`, why: "Aucune évaluation : le risque est inconnu. Renseigner probabilité, lignes de défense et répercussions.", gain: null });
      continue;
    }
    const idx = z.index!;
    const lvl = LEVELS.findIndex((l) => l.level === z.level);

    // Mesures sur l'etat reel de la zone
    if (z.facts.detectorsDown.length > 0) {
      const fixed = computeZone(z.zone, a, { ...z.facts, detectorsDown: [] }).index!;
      out.push({ horizon: 'court', zone: z.zone, title: `Remettre en service ${z.facts.detectorsDown.join(', ')}`, why: 'Un détecteur hors service laisse la zone sans surveillance fiable.', gain: idx - fixed });
    }
    if (z.facts.detectors === 0 && lvl >= 1) {
      const fixed = computeZone(z.zone, a, { ...z.facts, detectors: 1 }).index!;
      out.push({ horizon: 'court', zone: z.zone, title: `Installer un détecteur dans « ${z.zone} »`, why: 'Aucun détecteur : un départ de feu ne serait vu par personne.', gain: idx - fixed });
    }
    if (z.facts.cameras === 0 && lvl >= 1) {
      const fixed = computeZone(z.zone, a, { ...z.facts, cameras: 1 }).index!;
      out.push({ horizon: 'moyen', zone: z.zone, title: `Couvrir « ${z.zone} » par une caméra`, why: "Sans caméra, l'opérateur ne peut pas lever le doute à distance.", gain: idx - fixed });
    }
    if (z.facts.detectors === 1 && lvl >= 2) {
      out.push({ horizon: 'moyen', zone: z.zone, title: `Ajouter un second détecteur voisin dans « ${z.zone} »`, why: "Zone à risque élevé couverte par un seul détecteur : deux détecteurs voisins permettent la confirmation par coïncidence (moins de fausses alarmes, alarmes mieux priorisées).", gain: null });
    }
    if (z.facts.fires >= 2) {
      out.push({ horizon: 'moyen', zone: z.zone, title: `Analyser les causes des incendies répétés dans « ${z.zone} »`, why: `${z.facts.fires} incendies confirmés sur la période : traiter la cause, pas seulement l'effet.`, gain: null });
    }

    // Lignes de defense manquantes (zones a partir du niveau « modere »)
    if (lvl >= 1) {
      for (const d of DEFENSES) {
        if (a.defenses.includes(d.id)) continue;
        const better = computeZone(z.zone, withAssessment(a, { defenses: [...a.defenses, d.id] }), z.facts).index!;
        const gain = idx - better;
        if (gain <= 0 && d.horizon === 'moyen') continue; // ne propose pas ce qui ne change rien
        const structural = d.horizon === 'long' && z.r!.value >= 4;
        if (d.horizon === 'long' && !structural && gain <= 0) continue;
        out.push({ horizon: d.horizon, zone: z.zone, title: `${d.label} — « ${z.zone} »`, why: gain > 0 ? "Ligne de défense manquante : la mettre en place réduit la vulnérabilité de la zone." : 'Répercussions graves possibles : à prévoir structurellement.', gain: gain > 0 ? gain : null });
      }
    }
  }
  return out.sort(
    (a, b) =>
      HORIZON_ORDER[a.horizon] - HORIZON_ORDER[b.horizon] ||
      (b.gain ?? -1) - (a.gain ?? -1) ||
      a.zone.localeCompare(b.zone),
  );
}

// ---------------------------------------------------------------- service

type Row = Record<string, unknown>;

export interface RiskOptions {
  now?: () => number;
  /** Periode (jours) retenue pour l'historique d'incendies. */
  fireWindowDays?: number;
  /** Evaluation « a revoir » apres ce nombre de mois. */
  staleMonths?: number;
}

export function createRiskService(db: DatabaseSync, engine: Engine, options: RiskOptions = {}) {
  const now = options.now ?? Date.now;
  const windowDays = options.fireWindowDays ?? 180;
  const staleMs = (options.staleMonths ?? 12) * 30 * 86_400_000;

  function assessments(): Map<string, Assessment> {
    const map = new Map<string, Assessment>();
    for (const r of db.prepare('SELECT * FROM risk_zone').all() as Row[]) {
      map.set(r.zone as string, {
        probability: r.probability as number,
        defenses: JSON.parse((r.defenses as string) || '[]') as string[],
        impactImage: r.impact_image as number,
        impactEconomy: r.impact_economy as number,
        impactHuman: r.impact_human as number,
        notes: (r.notes as string) ?? '',
        assessedBy: r.assessed_by as string,
        assessedAt: r.assessed_at as number,
      });
    }
    return map;
  }

  function zoneNames(): string[] {
    return (db.prepare("SELECT DISTINCT zone FROM device WHERE zone <> '' ORDER BY zone").all() as Row[]).map((r) => r.zone as string);
  }

  function facts(zone: string): ZoneFacts {
    const detectors = db.prepare("SELECT id, status FROM device WHERE kind = 'detector' AND category = 'fire' AND zone = ?").all(zone) as Row[];
    const cameras = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT c.id) AS n FROM device c
            WHERE c.kind = 'camera' AND (c.zone = ?
              OR c.id IN (SELECT l.camera_id FROM device_link l JOIN device d ON d.id = l.detector_id WHERE d.zone = ?))`,
        )
        .get(zone, zone) as { n: number }
    ).n;
    const since = now() - windowDays * 86_400_000;
    const fires = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM incident i JOIN device d ON d.id = i.detector_id
            WHERE d.zone = ? AND d.category = 'fire' AND ((i.qualification = 'fire' AND i.closed_at >= ?) OR (i.status <> 'closed' AND i.confirmed_at IS NOT NULL))`,
        )
        .get(zone, since) as { n: number }
    ).n;
    return {
      detectors: detectors.length,
      cameras,
      detectorsDown: detectors.filter((d) => d.status === 'offline' || d.status === 'fault').map((d) => d.id as string),
      fires,
    };
  }

  function compute(): { zones: ZoneRisk[]; map: Map<string, Assessment> } {
    const map = assessments();
    const zones = zoneNames().map((z) => computeZone(z, map.get(z) ?? null, facts(z)));
    return { zones, map };
  }

  function siteIndex(zones: ZoneRisk[]) {
    const scored = zones.filter((z) => z.assessed);
    const worst = scored.reduce<ZoneRisk | null>((w, z) => (w === null || z.index! > w.index! ? z : w), null);
    const index = worst?.index ?? null;
    return { index, ...(index === null ? { level: null, levelLabel: null } : { level: levelOf(index).level, levelLabel: levelOf(index).label }), worstZone: worst?.zone ?? null, assessedZones: scored.length, totalZones: zones.length };
  }

  function dayKey(t: number): string {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** Un point par jour et par zone (le premier de la journee) : sert aux tendances. */
  function recordHistory(): number {
    const day = dayKey(now());
    if (db.prepare('SELECT 1 AS x FROM risk_history WHERE day = ? LIMIT 1').get(day)) return 0;
    const { zones } = compute();
    const insert = db.prepare('INSERT OR IGNORE INTO risk_history (day, zone, probability, vulnerability, impact, idx) VALUES (?, ?, ?, ?, ?, ?)');
    let n = 0;
    for (const z of zones) {
      if (!z.assessed) continue;
      insert.run(day, z.zone, z.p!.value, z.v!.value, z.r!.value, z.index!);
      n++;
    }
    const site = siteIndex(zones);
    if (site.index !== null) insert.run(day, '', 0, 0, 0, site.index);
    return n;
  }

  function history(days = 60): Record<string, { day: string; index: number }[]> {
    const since = dayKey(now() - days * 86_400_000);
    const out: Record<string, { day: string; index: number }[]> = {};
    for (const r of db.prepare('SELECT day, zone, idx FROM risk_history WHERE day >= ? ORDER BY day').all(since) as Row[]) {
      (out[(r.zone as string) || '__site__'] ??= []).push({ day: r.day as string, index: r.idx as number });
    }
    return out;
  }

  function overview() {
    const { zones, map } = compute();
    const t = now();
    return {
      site: siteIndex(zones),
      bands: LEVELS,
      defenses: DEFENSES,
      fireWindowDays: windowDays,
      zones: zones
        .map((z) => ({ ...z, stale: z.assessedAt !== null && t - z.assessedAt > staleMs }))
        .sort((a, b) => (b.index ?? -1) - (a.index ?? -1) || a.zone.localeCompare(b.zone)),
      priorities: buildPriorities(zones, map),
      history: history(),
    };
  }

  function validInt(value: unknown, min: number, max: number, field: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new PsimError(400, `${field} doit être un entier entre ${min} et ${max}`);
    }
    return value;
  }

  function assess(actor: string, zone: string, input: Record<string, unknown>): ZoneRisk {
    if (!zoneNames().includes(zone)) throw new PsimError(404, 'Zone inconnue (aucun équipement ne porte ce nom de zone)');
    const probability = validInt(input.probability, 1, 3, 'La probabilité');
    const impactImage = validInt(input.impactImage, 1, 5, "L'impact image");
    const impactEconomy = validInt(input.impactEconomy, 1, 5, "L'impact économique");
    const impactHuman = validInt(input.impactHuman, 1, 5, "L'impact humain");
    if (!Array.isArray(input.defenses) || input.defenses.some((d) => typeof d !== 'string' || !DEFENSES.some((x) => x.id === d))) {
      throw new PsimError(400, 'Lignes de défense invalides');
    }
    const defenses = [...new Set(input.defenses as string[])];
    const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
    if (notes.length > 500) throw new PsimError(400, 'Notes trop longues (500 caractères max)');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(notes)) throw new PsimError(400, 'Notes invalides (caractères de contrôle interdits)');

    db.prepare(
      `INSERT INTO risk_zone (zone, probability, defenses, impact_image, impact_economy, impact_human, notes, assessed_by, assessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(zone) DO UPDATE SET probability = excluded.probability, defenses = excluded.defenses, impact_image = excluded.impact_image,
         impact_economy = excluded.impact_economy, impact_human = excluded.impact_human, notes = excluded.notes,
         assessed_by = excluded.assessed_by, assessed_at = excluded.assessed_at`,
    ).run(zone, probability, JSON.stringify(defenses), impactImage, impactEconomy, impactHuman, notes, actor, now());
    const result = computeZone(zone, assessments().get(zone)!, facts(zone));
    engine.audit(actor, 'risk_assessed', { details: `${zone} : indice ${result.index} (${result.levelLabel})` });
    return result;
  }

  return { overview, assess, recordHistory, compute };
}

export type RiskService = ReturnType<typeof createRiskService>;
