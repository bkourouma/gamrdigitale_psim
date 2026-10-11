/**
 * Administration du portail : npm run portal:admin -- <commande> ...
 *
 *   add-org <nom>
 *   add-site <organisation> <identifiant> <nom du site>   -> affiche les 3 lignes a mettre dans le .env du PSIM du site
 *   site-env <identifiant>                                 -> les reaffiche
 *   rotate-site-key <identifiant>                          -> nouvelle cle (l'ancienne cesse de marcher)
 *   disable-site <identifiant> | enable-site <identifiant>
 *   add-group <code> <nom du groupe> --org <organisation>          -> groupe (region, agence, branche) d'une organisation
 *   add-group <code> <nom du sous-groupe> --parent <code du groupe> -> sous-groupe (deux niveaux au plus)
 *   rename-group <code> <nouveau nom>
 *   remove-group <code>                                    -> refuse si le groupe contient des sites, des sous-groupes ou limite des comptes
 *   assign-site <identifiant du site> <code du groupe>     -> range le site dans ce groupe (meme organisation)
 *   unassign-site <identifiant du site>                    -> « Sans groupe »
 *   limit-user <compte> <code> [<code> ...]                -> limite un directeur a ces groupes (directeur regional)
 *   unlimit-user <compte>                                  -> le directeur revoit toute son organisation
 *   add-user <compte> <admin|director|site_manager> [--org <organisation>] [--site <identifiant>] [--name <nom affiche>] [--groups <code> [<code> ...]]
 *   reset-password <compte>                                -> nouveau mot de passe provisoire (a changer a la connexion)
 *   disable-user <compte> | enable-user <compte>
 *   list
 *
 * Les mots de passe provisoires sont generes et affiches UNE fois ; aucun mot de passe n'est passe en argument.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../server/config.ts';
import { openPortalDb } from '../server/db.ts';
import { loadMasterKey } from '../server/keys.ts';
import { runCommand } from './cli.ts';

const dataDir = resolve(import.meta.dirname, '..', '..', config.dataDir);
// Premier lancement : le dossier n'existe pas encore (seul le portail le creait).
mkdirSync(dataDir, { recursive: true });
const db = openPortalDb(join(dataDir, 'portal.db'));
const master = loadMasterKey(dataDir, config.masterKey);
const [command, ...rest] = process.argv.slice(2);
const portalUrl = process.env.PORTAL_PUBLIC_URL ?? `http://${config.host}:${config.port}`;

try {
  const result = runCommand(db, master, command, rest, portalUrl);
  console.log(result.out);
  if (result.unknown) process.exitCode = command ? 1 : 0;
} catch (err) {
  console.error(`Erreur : ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
