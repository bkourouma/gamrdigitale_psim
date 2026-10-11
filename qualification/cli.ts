/**
 * Commandes de `npm run qualify` (voir scripts/qualify.ts et docs/QUALIFICATION.md). Separe du script pour pouvoir etre
 * appele par les tests avec des dossiers temporaires et une sortie capturee.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeFileAtomic } from './atomic.ts';
import { QUALIF_DIR, loadFiches, renderFicheDoc, renderHtml, renderMarkdown } from './fiches.ts';
import type { SheetModel } from './fiches.ts';
import { FAMILIES, FAMILY_LABEL, STATUSES, checkPackModels, loadRegistry } from './registry.ts';
import type { Entry, Status } from './registry.ts';
import { PromotionRefused, auditRegistry, contextFor, emptyInput, promote, recordResult, resultsDir, setStatus } from './results.ts';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const STATUS_LABEL: Record<Status | 'unknown', string> = {
  qualified: 'QUALIFIE',
  to_qualify: 'A QUALIFIER',
  rejected: 'REJETE',
  unknown: 'INCONNU',
};

export const USAGE = `Usage : npm run qualify -- <commande> [options]

  list [--family F] [--status S] [--fiche F] [--json]   statuts de qualification (S : ${STATUSES.join(', ')})
  show <id>                                          detail d'un modele : portee, essais, fiche
  sheet <id> [--out <dossier>] [--format html|md|both]  fiche de recette vierge, imprimable (HTML) et Markdown
  record <id> --template                             modele de saisie vide (JSON) a remplir
  record <id> --file <saisie.json>                   enregistre un resultat dans qualification/results/ (ne change pas le statut)
  promote <id> --result <fichier> --by <nom> --scope "<texte>" [--not-covered "<texte>"]
                                                     qualifie si TOUTES les etapes obligatoires sont pass sur materiel reel
  set-status <id> <to_qualify|rejected> --by <nom> --reason "<texte>"
  check-pack <pack.json> [--strict]                  liste les modeles d'un pack, signale ceux qui ne sont pas qualifies
  docs [--check]                                     regenere docs/qualification/*.md (--check : echoue si obsolete)
  verify                                             controle la coherence du registre, des resultats et des fiches

Option commune : --dir <dossier qualification> (essais ; par defaut qualification/ du depot).`;

function parse(args: string[]): { pos: string[]; opt: Map<string, string | true> } {
  const pos: string[] = [];
  const opt = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opt.set(a, next);
        i += 1;
      } else opt.set(a, true);
    } else pos.push(a);
  }
  return { pos, opt };
}

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

function modelOf(e: Entry): SheetModel {
  const conn = e.connection.type === 'gateway' ? `passerelle : module ${e.connection.module}` : e.connection.type === 'existing' ? 'existant' : 'à développer';
  const t = e.last_trial;
  return {
    id: e.id,
    fabricant: e.manufacturer,
    modele: e.model,
    famille: FAMILY_LABEL[e.family],
    raccordement: `${conn} (${e.connection.detail})`,
    statut: STATUS_LABEL[e.status],
    portee: e.scope,
    derniere_reference: t ? `${t.date} — ${t.reference} — ${t.real_hardware ? 'matériel réel' : 'simulé'}` : undefined,
  };
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/** Execute une commande. Renvoie le code de sortie : 0 succes, 1 refus ou echec, 2 mauvais usage. */
export async function runCli(argv: string[], io: Io): Promise<number> {
  const { pos, opt } = parse(argv);
  const [cmd, ...rest] = pos;
  if (!cmd || opt.has('--help') || cmd === 'help') {
    io.out(USAGE);
    return cmd || opt.has('--help') ? 0 : 2;
  }
  const dir = resolve(str(opt.get('--dir')) ?? QUALIF_DIR);
  const repoRoot = resolve(dir, '..');
  try {
    switch (cmd) {
      case 'list': {
        const reg = loadRegistry(dir);
        const family = str(opt.get('--family'));
        const status = str(opt.get('--status'));
        const fiche = str(opt.get('--fiche'));
        if (family && !(FAMILIES as readonly string[]).includes(family)) throw new Usage(`famille inconnue : ${family} (${FAMILIES.join(', ')})`);
        if (status && !(STATUSES as readonly string[]).includes(status)) throw new Usage(`statut inconnu : ${status} (${STATUSES.join(', ')})`);
        const rows = reg.entries.filter((e) => (!family || e.family === family) && (!status || e.status === status) && (!fiche || e.fiche === fiche));
        if (opt.has('--json')) {
          io.out(JSON.stringify(rows.map((e) => ({ id: e.id, status: e.status, family: e.family, fiche: e.fiche, profile: e.profile, manufacturer: e.manufacturer, model: e.model })), null, 2));
          return 0;
        }
        io.out(`${pad('IDENTIFIANT', 38)}${pad('STATUT', 14)}${pad('FAMILLE', 15)}${pad('FICHE / PROFIL', 34)}MODELE`);
        for (const e of rows) io.out(`${pad(e.id, 38)}${pad(STATUS_LABEL[e.status], 14)}${pad(e.family, 15)}${pad(`${e.fiche}${e.profile ? ` / ${e.profile}` : ''}`, 34)}${e.manufacturer} ${e.model}`);
        const count = (s: Status) => rows.filter((e) => e.status === s).length;
        io.out(`\n${rows.length} modele(s) : ${count('qualified')} qualifie(s), ${count('to_qualify')} a qualifier, ${count('rejected')} rejete(s).`);
        return 0;
      }

      case 'show': {
        const id = need(rest[0], 'identifiant du modele');
        const reg = loadRegistry(dir);
        const { entry, fiche, steps } = contextFor(reg, id, dir);
        io.out(`${entry.manufacturer} ${entry.model}  (${entry.id})`);
        io.out(`  famille        : ${FAMILY_LABEL[entry.family]}${entry.kind === 'generic' ? ' (entree de famille)' : ''}`);
        io.out(`  statut         : ${STATUS_LABEL[entry.status]}`);
        io.out(`  raccordement   : ${entry.connection.type === 'gateway' ? `passerelle, module ${entry.connection.module}` : entry.connection.type === 'existing' ? 'existant' : 'à développer'} — ${entry.connection.detail}`);
        io.out(`  fiche          : ${fiche.id}${entry.profile ? ` / profil ${entry.profile}` : ''} (version ${fiche.version}, ${steps.length} etapes dont ${steps.filter((s) => s.obligatoire).length} obligatoires)`);
        io.out(`  portee validee : ${entry.scope}`);
        if (entry.not_covered) io.out(`  non couvert    : ${entry.not_covered}`);
        const t = entry.last_trial;
        if (t) {
          io.out(`  dernier essai  : ${t.date} — ${t.reference}`);
          io.out(`                   ${t.real_hardware ? 'MATERIEL REEL' : 'simule'} ; PSIM ${t.psim_version}${t.gateway_version ? ` ; passerelle ${t.gateway_version}` : ''}${t.legacy ? ' ; constat historique, sans fiche signee' : ''}`);
          io.out(`                   ${t.conditions}`);
        } else io.out('  dernier essai  : aucun essai sur materiel reel');
        if (entry.simulated_tests.length) io.out(`  essais simules : ${entry.simulated_tests.join(', ')} (ne qualifient pas)`);
        if (entry.aliases.length) io.out(`  autres noms    : ${entry.aliases.join(', ')}`);
        if (entry.notes) io.out(`  remarques      : ${entry.notes}`);
        const rdir = resultsDir(dir);
        const files = existsSync(rdir) ? readdirSync(rdir).filter((f) => f.startsWith(`${entry.id}-`) && f.endsWith('.json')) : [];
        io.out(`  resultats      : ${files.length ? files.join(', ') : 'aucun fichier'}`);
        for (const h of entry.history) io.out(`  historique     : ${h.at} ${h.by} : ${h.from ?? '-'} -> ${h.to} (${h.reason})`);
        return 0;
      }

      case 'sheet': {
        const id = need(rest[0], 'identifiant du modele');
        const reg = loadRegistry(dir);
        const { entry, fiche } = contextFor(reg, id, dir);
        const format = str(opt.get('--format')) ?? 'both';
        if (!['html', 'md', 'both'].includes(format)) throw new Usage('--format : html, md ou both');
        const outDir = resolve(str(opt.get('--out')) ?? '.');
        mkdirSync(outDir, { recursive: true });
        const model = modelOf(entry);
        if (format !== 'md') {
          const f = join(outDir, `fiche-${entry.id}.html`);
          writeFileAtomic(f, renderHtml(fiche, entry.profile, model, dir));
          io.out(`fiche HTML (a imprimer) : ${f}`);
        }
        if (format !== 'html') {
          const f = join(outDir, `fiche-${entry.id}.md`);
          writeFileAtomic(f, renderMarkdown(fiche, entry.profile, model, dir));
          io.out(`fiche Markdown          : ${f}`);
        }
        return 0;
      }

      case 'record': {
        const id = need(rest[0], 'identifiant du modele');
        const reg = loadRegistry(dir);
        if (opt.has('--template')) {
          const { steps } = contextFor(reg, id, dir);
          io.out(JSON.stringify(emptyInput(steps), null, 2));
          return 0;
        }
        const file = str(opt.get('--file'));
        if (!file) throw new Usage('--file <saisie.json> ou --template obligatoire');
        let input: unknown;
        try {
          input = JSON.parse(readFileSync(resolve(file), 'utf8'));
        } catch (err) {
          throw new Usage(`saisie illisible (${file}) : ${(err as Error).message}`);
        }
        const { file: written, result } = recordResult(id, input, { dir });
        io.out(`resultat enregistre : ${written}`);
        io.out(`  materiel reel : ${result.conditions.real_hardware ? 'oui' : 'NON (essai simule : ne pourra pas qualifier)'} ; le statut du registre n'a PAS ete modifie.`);
        io.out(`  etape suivante : npm run qualify -- promote ${id} --result ${written} --by "<responsable>" --scope "<portee>"`);
        return 0;
      }

      case 'promote': {
        const id = need(rest[0], 'identifiant du modele');
        const result = str(opt.get('--result'));
        if (!result) throw new Usage('--result <fichier> obligatoire');
        const updated = promote({ id, resultFile: result, by: str(opt.get('--by')) ?? '', scope: str(opt.get('--scope')) ?? '', notCovered: str(opt.get('--not-covered')) }, { dir });
        io.out(`${updated.id} est maintenant QUALIFIE (essai du ${updated.last_trial?.date}, valide par ${updated.history[updated.history.length - 1].by}).`);
        io.out(`Portee : ${updated.scope}`);
        return 0;
      }

      case 'set-status': {
        const id = need(rest[0], 'identifiant du modele');
        const to = need(rest[1], 'nouveau statut (to_qualify ou rejected)');
        if (to !== 'to_qualify' && to !== 'rejected') throw new Usage('le statut doit etre to_qualify ou rejected (seule `promote` qualifie)');
        const updated = setStatus(id, to, str(opt.get('--by')) ?? '', str(opt.get('--reason')) ?? '', { dir });
        io.out(`${updated.id} : ${STATUS_LABEL[updated.status]}`);
        return 0;
      }

      case 'check-pack': {
        const file = need(rest[0], 'fichier du pack (.json)');
        let pack: unknown;
        try {
          pack = JSON.parse(readFileSync(resolve(file), 'utf8'));
        } catch (err) {
          throw new Usage(`pack illisible (${file}) : ${(err as Error).message}`);
        }
        const devices = typeof pack === 'object' && pack !== null && Array.isArray((pack as { devices?: unknown }).devices) ? ((pack as { devices: unknown[] }).devices) : [];
        const names: string[] = [];
        let withoutModel = 0;
        for (const d of devices) {
          const m = typeof d === 'object' && d !== null ? (d as { model?: unknown }).model : undefined;
          if (typeof m === 'string' && m.trim()) names.push(m.trim());
          else withoutModel += 1;
        }
        io.out(`Pack ${file} : ${devices.length} appareil(s), ${names.length} avec un modele declare.`);
        if (!devices.length) io.out('ATTENTION : aucun appareil (devices[]) dans ce pack : rien a controler.');
        const verdicts = checkPackModels(names, dir);
        for (const v of verdicts) {
          io.out(`  ${v.ok ? 'OK  ' : 'NON '} ${pad(STATUS_LABEL[v.status], 13)} ${v.name}${v.entry ? ` -> ${v.entry.id}` : ' : modele absent du registre'} (x${v.count})${v.ok ? ` — portee : ${v.entry?.scope}` : ''}`);
        }
        if (withoutModel) io.out(`ATTENTION : ${withoutModel} appareil(s) sans modele declare : non controle(s)${opt.has('--strict') ? ' (refuse en mode --strict)' : ''}.`);
        const bad = verdicts.filter((v) => !v.ok);
        if (bad.length) {
          io.err(`REFUSE : ${bad.length} modele(s) non qualifie(s) : ${bad.map((v) => v.name).join(', ')}. Aucune reference n'entre dans un pack sans recette en atelier.`);
          return 1;
        }
        if (withoutModel && opt.has('--strict')) {
          io.err('REFUSE (--strict) : des appareils n\'ont pas de modele declare.');
          return 1;
        }
        io.out(verdicts.length ? 'Tous les modeles du pack sont qualifies.' : 'Aucun modele a controler.');
        return 0;
      }

      case 'docs': {
        const outDir = join(repoRoot, 'docs', 'qualification');
        let stale = 0;
        mkdirSync(outDir, { recursive: true });
        for (const fiche of loadFiches(dir).fiches) {
          const file = join(outDir, `${fiche.id}.md`);
          const content = renderFicheDoc(fiche, dir);
          const current = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
          if (opt.has('--check')) {
            if (current !== content) {
              stale += 1;
              io.err(`obsolete ou absent : docs/qualification/${fiche.id}.md`);
            }
          } else if (current !== content) {
            writeFileAtomic(file, content);
            io.out(`ecrit : docs/qualification/${fiche.id}.md`);
          }
        }
        if (opt.has('--check')) {
          if (stale) {
            io.err('Relancer : npm run qualify -- docs');
            return 1;
          }
          io.out('docs/qualification/*.md a jour.');
        }
        return 0;
      }

      case 'verify': {
        const reg = loadRegistry(dir);
        const problems = auditRegistry(dir, repoRoot);
        for (const e of reg.entries) {
          if (!existsSync(join(repoRoot, 'docs', 'qualification', `${e.fiche}.md`))) problems.push(`${e.id} : la fiche docs/qualification/${e.fiche}.md est absente`);
        }
        if (problems.length) {
          for (const p of problems) io.err(`PROBLEME : ${p}`);
          return 1;
        }
        const q = reg.entries.filter((e) => e.status === 'qualified');
        io.out(`Registre coherent : ${reg.entries.length} modeles, ${q.length} qualifie(s) (${q.map((e) => e.id).join(', ') || 'aucun'}).`);
        return 0;
      }

      default:
        io.err(`commande inconnue : ${cmd}`);
        io.out(USAGE);
        return 2;
    }
  } catch (err) {
    if (err instanceof Usage) {
      io.err(`Usage : ${err.message}`);
      return 2;
    }
    if (err instanceof PromotionRefused) {
      io.err(err.message);
      return 1;
    }
    io.err(`ERREUR : ${(err as Error).message}`);
    return 1;
  }
}

class Usage extends Error {}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Usage(`${what} manquant`);
  return v;
}
