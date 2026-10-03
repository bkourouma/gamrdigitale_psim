/**
 * Verifie l'integrite du journal (chaine d'empreintes), sans demarrer le PSIM et sans rien modifier.
 *
 *   npm run verify-journal
 *   npm run verify-journal -- --db backups/psim-2026-02-10/psim.db
 *   npm run verify-journal -- --anchor 1234:ab12...   (empreinte conservee AILLEURS : rapport e-mail, autre copie)
 *   npm run verify-journal -- --manifest backups/psim-2026-02-10/manifest.json   (ancre enregistree avec la sauvegarde)
 *
 * Code de sortie 0 : chaine intacte ; 1 : alteration constatee ; 2 : erreur d'usage.
 * Sans ancre externe, la verification ne detecte pas une chaine entierement recalculee par quelqu'un qui a un acces
 * complet a la base : comparez avec une empreinte gardee hors de la machine (voir README, « Journal infalsifiable »).
 */
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { formatAnchor, parseAnchor, verify } from '../server/auditchain.ts';
import type { Anchor } from '../server/auditchain.ts';

export function readManifestAnchor(path: string): Anchor | null {
  const m = JSON.parse(readFileSync(path, 'utf8')) as { auditHead?: Anchor | null };
  return m.auditHead && Number.isInteger(m.auditHead.id) && typeof m.auditHead.hash === 'string' ? m.auditHead : null;
}

/** Renvoie le code de sortie (sans process.exit : sous Windows, une sortie immediate peut interrompre l'ecriture). */
export async function main(args: string[]): Promise<number> {
  const { config } = await import('../server/config.ts');
  const values = (flag: string): string[] => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
  const dbPath = values('--db')[0] ?? join(resolve(import.meta.dirname, '..', config.dataDir), 'psim.db');
  if (!existsSync(dbPath)) {
    console.error(`Base introuvable : ${dbPath}`);
    return 2;
  }
  const anchors: Anchor[] = [];
  for (const text of values('--anchor')) {
    const a = parseAnchor(text);
    if (!a) {
      console.error(`Ancre invalide « ${text} » (forme attendue : 1234:<64 caracteres hexadecimaux>)`);
      return 2;
    }
    anchors.push(a);
  }
  for (const file of values('--manifest')) {
    try {
      const a = readManifestAnchor(file);
      if (a) anchors.push(a);
      else console.log(`(le manifeste ${file} ne contient pas d'ancre de journal)`);
    } catch {
      console.error(`Manifeste illisible : ${file}`);
      return 2;
    }
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const result = verify(db, anchors);
  db.close();
  console.log(`Journal : ${result.checked} entree(s) protegee(s) verifiee(s)${result.unprotected ? `, ${result.unprotected} anterieure(s) au mecanisme (non protegee(s))` : ''}${anchors.length ? `, ${anchors.length} ancre(s) externe(s) comparee(s)` : ''}.`);
  if (result.head) console.log(`Ancre actuelle (a conserver hors de cette machine) : ${formatAnchor(result.head)}`);
  if (result.ok) {
    console.log(anchors.length ? 'INTEGRE : chaine intacte et conforme aux ancres fournies.' : 'INTEGRE : chaine intacte (non comparee a une ancre externe).');
    return 0;
  }
  console.log('ALTERE :');
  for (const p of result.problems) console.log(`  entree n°${p.id} : ${p.reason}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main(process.argv.slice(2));
}
