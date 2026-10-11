/**
 * Qualification des modeles : un modele « qualifie » est passe par l'atelier (essai sur materiel reel). Le registre
 * `qualification/registry.json` (tenu a part) fait foi s'il existe et connait le modele ; sinon on s'en tient au statut
 * declare dans le pack. Un modele a qualifier n'empeche pas de faire un plan, mais `apply` exige `--allow-unqualified`.
 *
 * Formes acceptees du registre (lecture tolerante, le format est fixe par ailleurs) :
 *   { "models": { "<modele>": { "status": "qualified" } } }
 *   { "models": [ { "id": "<modele>", "status": "qualified" } ] }      (ou "model" au lieu de "id")
 *   [ { "id": "<modele>", "status": "qualified" } ]
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Pack } from './schema.ts';

const QUALIFIED = new Set(['qualified', 'qualifie', 'valide', 'validated']);

export interface Registry {
  path: string;
  models: Map<string, string>;
}

export function readRegistry(path: string): { registry: Registry | null; warning: string | null } {
  if (!existsSync(path)) return { registry: null, warning: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8').trimStart());
  } catch (err) {
    return { registry: null, warning: `registre de qualification illisible (${path} : ${(err as Error).message}) : statuts declares dans le pack utilises` };
  }
  const models = new Map<string, string>();
  const list = Array.isArray(raw) ? raw : (raw as { models?: unknown } | null)?.models;
  if (Array.isArray(list)) {
    for (const e of list) {
      const entry = e as { id?: unknown; model?: unknown; status?: unknown } | null;
      const id = typeof entry?.id === 'string' ? entry.id : typeof entry?.model === 'string' ? entry.model : null;
      if (id && typeof entry?.status === 'string') models.set(id.toLowerCase(), entry.status.toLowerCase());
    }
  } else if (list && typeof list === 'object') {
    for (const [id, e] of Object.entries(list as Record<string, unknown>)) {
      const status = typeof e === 'string' ? e : (e as { status?: unknown } | null)?.status;
      if (typeof status === 'string') models.set(id.toLowerCase(), status.toLowerCase());
    }
  } else {
    return { registry: null, warning: `registre de qualification sans liste « models » (${path}) : statuts declares dans le pack utilises` };
  }
  return { registry: { path, models }, warning: null };
}

export interface QualificationReport {
  /** Equipements dont le modele n'est pas qualifie. */
  unqualified: { deviceId: string; model: string; source: 'registre' | 'pack' }[];
  warnings: string[];
}

export function qualify(pack: Pack, registry: Registry | null): QualificationReport {
  const unqualified: QualificationReport['unqualified'] = [];
  const warnings: string[] = [];
  const contradicted = new Set<string>();
  for (const d of pack.devices) {
    const fromRegistry = registry?.models.get(d.model);
    if (fromRegistry !== undefined) {
      const ok = QUALIFIED.has(fromRegistry);
      if (!ok) unqualified.push({ deviceId: d.id, model: d.model, source: 'registre' });
      if (!ok && d.qualification === 'qualified' && !contradicted.has(d.model)) {
        contradicted.add(d.model);
        warnings.push(`modele ${d.model} declare « qualified » dans le pack, mais « ${fromRegistry} » dans le registre : le registre fait foi`);
      }
    } else if (d.qualification !== 'qualified') {
      unqualified.push({ deviceId: d.id, model: d.model, source: 'pack' });
    }
  }
  return { unqualified, warnings };
}
