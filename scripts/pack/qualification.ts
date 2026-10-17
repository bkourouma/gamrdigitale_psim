/**
 * Qualification des modeles d'un pack : le registre de l'atelier (qualification/registry.json, lu par l'API de
 * qualification/registry.ts) fait foi. Un modele n'est « qualifie » que si le registre le dit ; le statut declare dans le
 * pack n'est qu'une indication (une contradiction est signalee, le registre l'emporte).
 *
 *   - modele a qualifier, ou absent du registre : plan possible, `apply` exige `--allow-unqualified` ;
 *   - modele rejete par l'atelier : le pack est refuse (il ne doit entrer dans aucun pack) ;
 *   - registre absent, illisible ou invalide : le pack est refuse (echec ferme, jamais ouvert).
 */
import { RegistryError, checkPackModels } from '../../qualification/registry.ts';
import type { ModelVerdict, Status } from '../../qualification/registry.ts';
import type { Pack } from './schema.ts';

export interface UnqualifiedDevice {
  deviceId: string;
  /** Modele tel qu'il est ecrit dans le pack. */
  model: string;
  /** Statut au registre ('unknown' : modele absent du registre). */
  status: Status | 'unknown';
}

export interface QualificationReport {
  /** Equipements dont le modele n'est pas qualifie au registre (a qualifier, inconnu ou rejete). */
  unqualified: UnqualifiedDevice[];
  warnings: string[];
  /** Raison de refuser le pack (registre inutilisable, modele rejete), sinon null. */
  blocking: string | null;
  /** Statut effectif de chaque equipement d'apres le registre (identifiant d'equipement -> qualifie ou non). */
  effective: Map<string, 'qualified' | 'to_qualify'>;
}

/**
 * Confronte les modeles du pack au registre. `dir` : dossier de qualification (par defaut qualification/ du depot).
 * Ne leve jamais : un registre inutilisable donne `blocking` et tous les equipements a qualifier.
 */
export function qualify(pack: Pack, dir?: string): QualificationReport {
  const warnings: string[] = [];
  const effective = new Map<string, 'qualified' | 'to_qualify'>();
  let verdicts: ModelVerdict[];
  try {
    verdicts = checkPackModels([...new Set(pack.devices.map((d) => d.model))], dir);
  } catch (err) {
    const msg = err instanceof RegistryError ? err.message.split('\n')[0] : (err as Error).message;
    for (const d of pack.devices) effective.set(d.id, 'to_qualify');
    return {
      unqualified: pack.devices.map((d) => ({ deviceId: d.id, model: d.model, status: 'unknown' })),
      warnings,
      blocking: `registre de qualification inutilisable (${msg}) : aucun modele ne peut etre considere comme qualifie (npm run qualify -- verify)`,
      effective,
    };
  }
  const byName = new Map(verdicts.map((v) => [v.name, v]));
  const unqualified: UnqualifiedDevice[] = [];
  const rejected = new Set<string>();
  const told = new Set<string>();
  for (const d of pack.devices) {
    const v = byName.get(d.model)!;
    effective.set(d.id, v.ok ? 'qualified' : 'to_qualify');
    if (!v.ok) unqualified.push({ deviceId: d.id, model: d.model, status: v.status });
    if (told.has(d.model)) continue;
    told.add(d.model);
    if (!v.entry) warnings.push(`modele ${d.model} absent du registre de qualification : traite comme a qualifier (l'atelier doit d'abord l'inscrire et le qualifier)`);
    else if (v.status === 'rejected') rejected.add(d.model);
    if (v.entry && !v.ok && d.qualification === 'qualified') warnings.push(`modele ${d.model} declare « qualified » dans le pack, mais « ${v.status} » dans le registre : le registre fait foi`);
    if (v.ok && d.qualification !== 'qualified') warnings.push(`modele ${d.model} declare « ${d.qualification} » dans le pack, mais qualifie au registre (portee : ${v.entry!.scope}) : le registre fait foi`);
  }
  const blocking = rejected.size ? `modele(s) rejete(s) par l'atelier, interdit(s) dans un pack : ${[...rejected].join(', ')}` : null;
  return { unqualified, warnings, blocking, effective };
}

/** Le pack avec, pour chaque equipement, le statut de qualification du registre (celui qui est enregistre a l'application). */
export function withRegistryStatus(pack: Pack, q: QualificationReport): Pack {
  return { ...pack, devices: pack.devices.map((d) => ({ ...d, qualification: q.effective.get(d.id) ?? 'to_qualify' })) };
}
