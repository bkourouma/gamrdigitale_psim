/**
 * Point d'entree du PSIM (tache planifiee, service, npm start) : charge server/main.ts.
 *
 * Une erreur AU CHARGEMENT (configuration invalide : numero mal ecrit, valeur hors bornes...) se produit avant
 * l'installation du journal. Lancee par une tache planifiee, sans console, elle serait invisible : elle est donc aussi
 * ecrite dans <dossier de donnees>/logs/psim.log, la ou l'exploitant regarde. Ces messages ne contiennent jamais de secret
 * (la configuration cite la position d'une entree fautive, pas son contenu).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

try {
  await import('./main.ts');
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  try {
    const dir = join(resolve(import.meta.dirname, '..', process.env.PSIM_DATA_DIR ?? 'data'), 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'psim.log'), `${new Date().toISOString()} ERROR [psim] Demarrage impossible : ${message}\n`);
  } catch {
    // dossier de donnees inaccessible : il reste la sortie d'erreur
  }
  console.error(`[psim] Demarrage impossible : ${message}`);
  process.exitCode = 1;
}
