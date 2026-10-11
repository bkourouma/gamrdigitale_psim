/**
 * Banc d'essai SIMULE : rejoue, sans materiel, la sequence d'une fiche de recette contre un PSIM de demonstration, pour
 * verifier la FICHE elle-meme (une fiche impossible a derouler est un defaut). Ce n'est jamais un essai materiel : il ne
 * cree aucun resultat et ne touche pas au registre.
 *
 *   npm run bench -- --all                       toutes les fiches, tous les profils
 *   npm run bench -- <fiche> [--profile <profil>]  une fiche (profils : voir docs/qualification/<fiche>.md)
 *   npm run bench -- <id-du-modele>              la fiche du modele du registre
 *   options : --json (rapport JSON, avec real_hardware: false)
 *
 * Code de sortie 1 si au moins une etape rejouable echoue (fiche a corriger).
 */
import { formatBench, runBench } from '../qualification/bench.ts';
import type { BenchReport } from '../qualification/bench.ts';
import { getFiche, loadFiches } from '../qualification/fiches.ts';
import { findEntry, loadRegistry } from '../qualification/registry.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--profile');

const jobs: { fiche: string; profile: string | null }[] = [];
if (flag('--all')) {
  for (const f of loadFiches().fiches) {
    const profiles = Object.keys(f.profils);
    for (const p of profiles.length ? profiles : [null]) jobs.push({ fiche: f.id, profile: p });
  }
} else if (target) {
  const entry = findEntry(loadRegistry(), target);
  if (entry) jobs.push({ fiche: entry.fiche, profile: entry.profile });
  else {
    const f = getFiche(target);
    if (!f) {
      console.error(`Ni fiche ni modele nomme « ${target} ». Usage : npm run bench -- --all | <fiche> [--profile p] | <id-du-modele>`);
      process.exit(2);
    }
    const profiles = Object.keys(f.profils);
    const wanted = value('--profile');
    if (profiles.length && !wanted) for (const p of profiles) jobs.push({ fiche: f.id, profile: p });
    else jobs.push({ fiche: f.id, profile: wanted ?? null });
  }
} else {
  console.error('Usage : npm run bench -- --all | <fiche> [--profile p] | <id-du-modele> [--json]');
  process.exit(2);
}

const reports: BenchReport[] = [];
for (const j of jobs) {
  try {
    reports.push(await runBench(getFiche(j.fiche)!, j.profile));
  } catch (err) {
    console.error(`${j.fiche}${j.profile ? `[${j.profile}]` : ''} : ${(err as Error).message}`);
    process.exit(2);
  }
}
if (flag('--json')) console.log(JSON.stringify(reports, null, 2));
else {
  for (const r of reports) console.log(`${formatBench(r)}\n`);
  const failed = reports.filter((r) => !r.ok).length;
  console.log(`${reports.length} fiche(s)/profil(s) rejoue(s) : ${failed === 0 ? 'toutes derouleables' : `${failed} A CORRIGER`}. Rappel : un banc simule ne qualifie aucun materiel.`);
}
process.exitCode = reports.every((r) => r.ok) ? 0 : 1;
