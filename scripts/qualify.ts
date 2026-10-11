/**
 * Qualification en atelier du materiel du catalogue.
 *
 *   npm run qualify -- list [--family F] [--status S] [--fiche F]
 *   npm run qualify -- show <id>
 *   npm run qualify -- sheet <id> [--out dossier]        fiche de recette vierge (HTML imprimable + Markdown)
 *   npm run qualify -- record <id> --template            modele de saisie vide
 *   npm run qualify -- record <id> --file saisie.json    enregistre un resultat d'essai (ne change pas le statut)
 *   npm run qualify -- promote <id> --result <fichier> --by <nom> --scope "<texte>"
 *   npm run qualify -- check-pack packs/mon-pack.json    signale les modeles non qualifies d'un pack
 *   npm run qualify -- docs [--check]                    regenere docs/qualification/*.md
 *   npm run qualify -- verify                            coherence registre / resultats / fiches
 *
 * Voir docs/QUALIFICATION.md. Code de sortie : 0 succes, 1 refus ou echec, 2 mauvais usage.
 */
import { runCli } from '../qualification/cli.ts';

process.exitCode = await runCli(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) });
