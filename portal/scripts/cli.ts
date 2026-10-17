/**
 * Les commandes d'administration du portail (voir admin.ts pour la liste). Separees du point d'entree pour pouvoir etre
 * essayees sans lancer un processus : `runCommand` renvoie le texte a afficher, ou leve une erreur en francais.
 */
import type { DatabaseSync } from 'node:sqlite';
import { createUser, generatePassword, setActive, setPassword } from '../server/accounts.ts';
import type { Role } from '../server/accounts.ts';
import { addGroup, addOrganization, addSite, assignSite, groupIdsByCodes, limitUser, listAll, organizationId, removeGroup, renameGroup, rotateSiteKey, setSiteActive, siteEnvLines, unlimitUser } from '../server/admin.ts';

export const COMMANDS = ['add-org', 'add-site', 'site-env', 'rotate-site-key', 'disable-site', 'enable-site', 'add-group', 'rename-group', 'remove-group', 'assign-site', 'unassign-site', 'limit-user', 'unlimit-user', 'add-user', 'reset-password', 'disable-user', 'enable-user', 'list'];

export function runCommand(db: DatabaseSync, master: Buffer, command: string | undefined, rest: string[], portalUrl: string): { out: string; unknown: boolean } {
  /**
   * Valeur d'une option : tous les mots jusqu'a la prochaine option. Sous Windows, npm retire les guillemets
   * (`--name "Baba K"` arrive en `--name Baba K`) : un nom compose ne doit pas etre tronque.
   */
  const option = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const words: string[] = [];
    for (const w of rest.slice(i + 1)) {
      if (w.startsWith('--')) break;
      words.push(w);
    }
    return words.join(' ') || undefined;
  };
  // Les arguments positionnels s'arretent a la premiere option (les valeurs d'options ne sont pas des positionnels).
  const firstOption = rest.findIndex((a) => a.startsWith('--'));
  const positional = firstOption < 0 ? rest : rest.slice(0, firstOption);
  const say = (out: string) => ({ out, unknown: false });

  switch (command) {
    case 'add-org':
      addOrganization(db, positional.join(' '));
      return say(`Organisation « ${positional.join(' ')} » créée.`);
    case 'add-site': {
      const [org, id, ...name] = positional;
      addSite(db, org, id, name.join(' '));
      return say(`Site « ${name.join(' ')} » créé. À mettre dans le .env du PSIM de ce site :\n\n${siteEnvLines(db, master, id, portalUrl)}\n\n(PSIM_PORTAL_URL : adresse PUBLIQUE du portail, en https:// ; définir PORTAL_PUBLIC_URL pour qu'elle soit affichée correctement.)`);
    }
    case 'site-env':
      return say(siteEnvLines(db, master, positional[0], portalUrl));
    case 'rotate-site-key': {
      const version = rotateSiteKey(db, positional[0]);
      return say(`Nouvelle clé (version ${version}). L'ancienne ne fonctionne plus : mettre à jour le .env du site.\n\n${siteEnvLines(db, master, positional[0], portalUrl)}`);
    }
    case 'disable-site':
    case 'enable-site':
      setSiteActive(db, positional[0], command === 'enable-site');
      return say(`Site ${positional[0]} ${command === 'enable-site' ? 'réactivé' : 'désactivé (ses envois sont refusés, il disparaît des écrans)'}.`);
    case 'add-group': {
      const [code, ...name] = positional;
      const parent = option('parent');
      addGroup(db, option('org') ?? null, code ?? '', name.join(' '), parent ?? null);
      return say(`${parent ? 'Sous-groupe' : 'Groupe'} « ${name.join(' ')} » (${code}) créé. Pour y ranger un site : assign-site <site> ${code}`);
    }
    case 'rename-group':
      renameGroup(db, positional[0] ?? '', positional.slice(1).join(' '));
      return say(`Groupe ${positional[0]} renommé « ${positional.slice(1).join(' ')} ».`);
    case 'remove-group':
      removeGroup(db, positional[0] ?? '');
      return say(`Groupe ${positional[0]} supprimé.`);
    case 'assign-site':
      assignSite(db, positional[0] ?? '', positional[1] ?? '');
      return say(`Site ${positional[0]} rangé dans le groupe ${positional[1]}.`);
    case 'unassign-site':
      assignSite(db, positional[0] ?? '', null);
      return say(`Site ${positional[0]} sorti de son groupe (« Sans groupe »). Seuls les comptes non limités à des groupes le voient.`);
    case 'limit-user':
      limitUser(db, positional[0] ?? '', positional.slice(1));
      return say(`Compte ${positional[0]} limité aux groupes : ${positional.slice(1).join(', ')} (leurs sous-groupes compris). Effet immédiat.`);
    case 'unlimit-user':
      unlimitUser(db, positional[0] ?? '');
      return say(`Compte ${positional[0]} : limite levée, il revoit toute son organisation (sites sans groupe compris). Effet immédiat.`);
    case 'add-user': {
      const [username, role] = positional;
      if (!['admin', 'director', 'site_manager'].includes(role)) throw new Error('rôle : admin, director ou site_manager');
      const orgName = option('org');
      const siteId = option('site');
      const groupCodes = (option('groups') ?? '').split(/\s+/).filter(Boolean);
      if (rest.includes('--groups') && groupCodes.length === 0) throw new Error('--groups attend au moins un code de groupe');
      if (groupCodes.length > 0 && role !== 'director') throw new Error('--groups ne concerne que les directeurs');
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
      createUser(db, { username, role: role as Role, orgId, siteId: role === 'site_manager' ? siteId : null, displayName: option('name'), ...(groupCodes.length > 0 ? { groupIds: groupIdsByCodes(db, groupCodes) } : {}) }, password);
      return say(`Compte ${username} créé${groupCodes.length > 0 ? ` (limité aux groupes : ${groupCodes.join(', ')})` : ''}.\nMot de passe provisoire (affiché une seule fois, à changer à la première connexion) :\n\n${password}`);
    }
    case 'reset-password': {
      const password = generatePassword();
      setPassword(db, positional[0], password, true);
      return say(`Nouveau mot de passe provisoire pour ${positional[0]} (affiché une seule fois) :\n\n${password}`);
    }
    case 'disable-user':
    case 'enable-user':
      setActive(db, positional[0], command === 'enable-user');
      return say(`Compte ${positional[0]} ${command === 'enable-user' ? 'réactivé' : 'désactivé (ses sessions sont coupées)'}.`);
    case 'list':
      return say(listAll(db));
    default:
      return { out: `Commandes : ${COMMANDS.join(', ')}`, unknown: true };
  }
}
