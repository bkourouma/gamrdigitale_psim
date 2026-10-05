/**
 * Administration du portail : npm run portal:admin -- <commande> ...
 *
 *   add-org <nom>
 *   add-site <organisation> <identifiant> <nom du site>   -> affiche les 3 lignes a mettre dans le .env du PSIM du site
 *   site-env <identifiant>                                 -> les reaffiche
 *   rotate-site-key <identifiant>                          -> nouvelle cle (l'ancienne cesse de marcher)
 *   disable-site <identifiant> | enable-site <identifiant>
 *   add-user <compte> <admin|director|site_manager> [--org <organisation>] [--site <identifiant>] [--name <nom affiche>]
 *   reset-password <compte>                                -> nouveau mot de passe provisoire (a changer a la connexion)
 *   disable-user <compte> | enable-user <compte>
 *   list
 *
 * Les mots de passe provisoires sont generes et affiches UNE fois ; aucun mot de passe n'est passe en argument.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createUser, generatePassword, setActive, setPassword } from '../server/accounts.ts';
import type { Role } from '../server/accounts.ts';
import { addOrganization, addSite, listAll, organizationId, rotateSiteKey, setSiteActive, siteEnvLines } from '../server/admin.ts';
import { config } from '../server/config.ts';
import { openPortalDb } from '../server/db.ts';
import { loadMasterKey } from '../server/keys.ts';

const dataDir = resolve(import.meta.dirname, '..', '..', config.dataDir);
// Premier lancement : le dossier n'existe pas encore (seul le portail le creait).
mkdirSync(dataDir, { recursive: true });
const db = openPortalDb(join(dataDir, 'portal.db'));
const master = loadMasterKey(dataDir, config.masterKey);
const [command, ...rest] = process.argv.slice(2);

/**
 * Valeur d'une option : tous les mots jusqu'a la prochaine option. Sous Windows, npm retire les guillemets
 * (`--name "Baba K"` arrive en `--name Baba K`) : un nom compose ne doit pas etre tronque.
 */
function option(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const words: string[] = [];
  for (const w of rest.slice(i + 1)) {
    if (w.startsWith('--')) break;
    words.push(w);
  }
  return words.join(' ') || undefined;
}
// Les arguments positionnels s'arretent a la premiere option (les valeurs d'options ne sont pas des positionnels).
const firstOption = rest.findIndex((a) => a.startsWith('--'));
const positional = firstOption < 0 ? rest : rest.slice(0, firstOption);
const portalUrl = process.env.PORTAL_PUBLIC_URL ?? `http://${config.host}:${config.port}`;

try {
  switch (command) {
    case 'add-org':
      addOrganization(db, positional.join(' '));
      console.log(`Organisation « ${positional.join(' ')} » créée.`);
      break;
    case 'add-site': {
      const [org, id, ...name] = positional;
      addSite(db, org, id, name.join(' '));
      console.log(`Site « ${name.join(' ')} » créé. À mettre dans le .env du PSIM de ce site :\n\n${siteEnvLines(db, master, id, portalUrl)}\n\n(PSIM_PORTAL_URL : adresse PUBLIQUE du portail, en https:// ; définir PORTAL_PUBLIC_URL pour qu'elle soit affichée correctement.)`);
      break;
    }
    case 'site-env':
      console.log(siteEnvLines(db, master, positional[0], portalUrl));
      break;
    case 'rotate-site-key': {
      const version = rotateSiteKey(db, positional[0]);
      console.log(`Nouvelle clé (version ${version}). L'ancienne ne fonctionne plus : mettre à jour le .env du site.\n\n${siteEnvLines(db, master, positional[0], portalUrl)}`);
      break;
    }
    case 'disable-site':
    case 'enable-site':
      setSiteActive(db, positional[0], command === 'enable-site');
      console.log(`Site ${positional[0]} ${command === 'enable-site' ? 'réactivé' : 'désactivé (ses envois sont refusés, il disparaît des écrans)'}.`);
      break;
    case 'add-user': {
      const [username, role] = positional;
      if (!['admin', 'director', 'site_manager'].includes(role)) throw new Error('rôle : admin, director ou site_manager');
      const orgName = option('org');
      const siteId = option('site');
      let orgId: number | null = null;
      if (role === 'director') {
        if (!orgName) throw new Error('un directeur est rattaché à une organisation : --org <organisation>');
        orgId = organizationId(db, orgName);
      }
      if (role === 'site_manager') {
        if (!siteId) throw new Error('un responsable de site est rattaché à un site : --site <identifiant>');
        if (!db.prepare('SELECT 1 FROM site WHERE id = ?').get(siteId)) throw new Error(`site introuvable : ${siteId}`);
      }
      const password = generatePassword();
      createUser(db, { username, role: role as Role, orgId, siteId: role === 'site_manager' ? siteId : null, displayName: option('name') }, password);
      console.log(`Compte ${username} créé.\nMot de passe provisoire (affiché une seule fois, à changer à la première connexion) :\n\n${password}`);
      break;
    }
    case 'reset-password': {
      const password = generatePassword();
      setPassword(db, positional[0], password, true);
      console.log(`Nouveau mot de passe provisoire pour ${positional[0]} (affiché une seule fois) :\n\n${password}`);
      break;
    }
    case 'disable-user':
    case 'enable-user':
      setActive(db, positional[0], command === 'enable-user');
      console.log(`Compte ${positional[0]} ${command === 'enable-user' ? 'réactivé' : 'désactivé (ses sessions sont coupées)'}.`);
      break;
    case 'list':
      console.log(listAll(db));
      break;
    default:
      console.log('Commandes : add-org, add-site, site-env, rotate-site-key, disable-site, enable-site, add-user, reset-password, disable-user, enable-user, list');
      process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  console.error(`Erreur : ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
