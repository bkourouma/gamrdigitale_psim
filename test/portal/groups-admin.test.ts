import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { runCommand } from '../../portal/scripts/cli.ts';
import { addGroup, addOrganization, addSite, assignSite, limitUser, listAll, removeGroup, renameGroup, unlimitUser } from '../../portal/server/admin.ts';
import { openPortalDb } from '../../portal/server/db.ts';
import { NOW, addUser } from './helpers.ts';

const audit = (db: ReturnType<typeof openPortalDb>) => (db.prepare('SELECT actor, action, details FROM audit ORDER BY id').all() as { actor: string; action: string; details: string }[]).map((a) => `${a.action}: ${a.details}`);

function fresh() {
  const db = openPortalDb(':memory:');
  addOrganization(db, 'Banque', NOW);
  addOrganization(db, 'Autre', NOW);
  addSite(db, 'Banque', 'agence-un', 'Agence Un', NOW);
  addSite(db, 'Autre', 'boutique-un', 'Boutique Un', NOW);
  return db;
}

describe('administration des groupes (fonctions)', () => {
  it('cree un groupe, puis un sous-groupe qui reste dans la meme organisation ; journalise', () => {
    const db = fresh();
    addGroup(db, 'Banque', 'region-nord', '  Région   Nord ', null, NOW);
    addGroup(db, null, 'agences-kaloum', 'Agences de Kaloum', 'region-nord', NOW);
    const rows = db.prepare('SELECT g.code, g.name, g.parent_id, o.name AS org FROM site_group g JOIN organization o ON o.id = g.org_id ORDER BY g.id').all() as { code: string; name: string; parent_id: number | null; org: string }[];
    assert.deepEqual(rows.map((r) => [r.code, r.name, r.org, r.parent_id === null]), [['region-nord', 'Région Nord', 'Banque', true], ['agences-kaloum', 'Agences de Kaloum', 'Banque', false]]);
    assert.deepEqual(audit(db).filter((a) => a.startsWith('group_')).map((a) => a.split(':')[0]), ['group_created', 'group_created']);
    assert.ok(audit(db).some((a) => a.includes('agences-kaloum') && a.includes('sous region-nord')));
  });

  it('refuse trois niveaux (un sous-groupe n a pas de sous-groupe), par la commande ET par la base', () => {
    const db = fresh();
    addGroup(db, 'Banque', 'region-nord', 'Région Nord', null, NOW);
    addGroup(db, null, 'agences-kaloum', 'Agences', 'region-nord', NOW);
    assert.throws(() => addGroup(db, null, 'petit-groupe', 'Trop profond', 'agences-kaloum', NOW), /deux niveaux au plus/);
    // Meme en SQL direct : le garde-fou est dans la base.
    const sub = (db.prepare("SELECT id, org_id FROM site_group WHERE code = 'agences-kaloum'").get() as { id: number; org_id: number });
    assert.throws(() => db.prepare("INSERT INTO site_group (org_id, code, name, parent_id, created_at) VALUES (?, 'profond', 'Profond', ?, 1)").run(sub.org_id, sub.id), /deux niveaux au plus/);
    const top = (db.prepare("SELECT id FROM site_group WHERE code = 'region-nord'").get() as { id: number }).id;
    assert.throws(() => db.prepare("UPDATE site_group SET parent_id = ? WHERE code = 'region-nord'").run(sub.id), /deux niveaux au plus/, 'un groupe qui a des enfants ne peut pas devenir enfant');
    assert.throws(() => db.prepare('UPDATE site_group SET parent_id = id WHERE id = ?').run(top), /propre parent/);
  });

  it('refuse un sous-groupe dans l organisation d un autre, un code mal forme ou deja pris, un nom en double', () => {
    const db = fresh();
    addGroup(db, 'Banque', 'region-nord', 'Région Nord', null, NOW);
    assert.throws(() => addGroup(db, 'Autre', 'sous-autre', 'Sous', 'region-nord', NOW), /n'appartient pas a cette organisation/);
    assert.throws(() => addGroup(db, 'Banque', 'Region Nord', 'X Y', null, NOW), /code de groupe invalide/);
    assert.throws(() => addGroup(db, 'Banque', 'ab', 'Court', null, NOW), /code de groupe invalide/);
    assert.throws(() => addGroup(db, 'Banque', 'region-nord', 'Autre nom', null, NOW), /deja utilise/);
    assert.throws(() => addGroup(db, 'Banque', 'region-bis', 'région nord', null, NOW), /existe deja/, 'meme nom, sans tenir compte de la casse');
    assert.throws(() => addGroup(db, null, 'sans-org', 'Sans organisation', null, NOW), /indiquer l'organisation/);
    assert.throws(() => addGroup(db, 'Inconnue', 'orphelin', 'Orphelin', null, NOW), /organisation introuvable/);
    assert.throws(() => addGroup(db, 'Banque', 'nom-vide', ' ', null, NOW), /2 a 80 caracteres/);
    // Le meme nom est possible dans une autre organisation, et sous deux groupes differents.
    addGroup(db, 'Autre', 'region-nord-autre', 'Région Nord', null, NOW);
  });

  it('renomme un groupe (journalise, nom unique au meme niveau)', () => {
    const db = fresh();
    addGroup(db, 'Banque', 'region-nord', 'Région Nord', null, NOW);
    addGroup(db, 'Banque', 'region-sud', 'Région Sud', null, NOW);
    renameGroup(db, 'region-nord', 'Grand Nord', NOW);
    assert.equal((db.prepare("SELECT name FROM site_group WHERE code = 'region-nord'").get() as { name: string }).name, 'Grand Nord');
    assert.throws(() => renameGroup(db, 'region-sud', 'grand nord', NOW), /existe deja/);
    assert.throws(() => renameGroup(db, 'inconnu', 'Nom', NOW), /groupe introuvable : inconnu/);
    assert.ok(audit(db).includes('group_renamed: region-nord : « Région Nord » -> « Grand Nord »'));
  });

  it('range un site, le deplace, le sort du groupe ; refuse un groupe d une autre organisation ; journalise chaque geste', () => {
    const db = fresh();
    addGroup(db, 'Banque', 'region-nord', 'Région Nord', null, NOW);
    addGroup(db, 'Banque', 'region-sud', 'Région Sud', null, NOW);
    addGroup(db, 'Autre', 'groupe-autre', 'Groupe Autre', null, NOW);
    const code = () => (db.prepare('SELECT g.code FROM site s LEFT JOIN site_group g ON g.id = s.group_id WHERE s.id = ?').get('agence-un') as { code: string | null }).code;
    assert.equal(code(), null, 'au depart : sans groupe');
    assignSite(db, 'agence-un', 'region-nord', NOW);
    assert.equal(code(), 'region-nord');
    assignSite(db, 'agence-un', 'region-sud', NOW);
    assert.equal(code(), 'region-sud');
    assert.throws(() => assignSite(db, 'agence-un', 'groupe-autre', NOW), /meme organisation/);
    assert.throws(() => assignSite(db, 'agence-inconnue', 'region-sud', NOW), /site introuvable/);
    assert.throws(() => assignSite(db, 'agence-un', 'groupe-inconnu', NOW), /groupe introuvable/);
    assignSite(db, 'agence-un', null, NOW);
    assert.equal(code(), null);
    const lines = audit(db).filter((a) => a.startsWith('site_group_'));
    assert.deepEqual(lines, ['site_group_assigned: agence-un : sans groupe -> region-nord', 'site_group_assigned: agence-un : region-nord -> region-sud', 'site_group_cleared: agence-un : region-sud -> sans groupe']);
    // La base refuse aussi un rattachement entre organisations.
    assert.throws(() => db.prepare("UPDATE site SET group_id = (SELECT id FROM site_group WHERE code = 'groupe-autre') WHERE id = 'agence-un'").run(), /propre organisation/);
  });

  it('supprime un groupe vide ; refuse un groupe avec des sites (meme desactives), des sous-groupes ou des comptes limites', () => {
    const db = fresh();
    addGroup(db, 'Banque', 'region-nord', 'Région Nord', null, NOW);
    addGroup(db, null, 'agences-un', 'Agences', 'region-nord', NOW);
    assignSite(db, 'agence-un', 'agences-un', NOW);
    assert.throws(() => removeGroup(db, 'region-nord'), /groupe non vide : 1 sous-groupe\(s\) \(agences-un\)/);
    assert.throws(() => removeGroup(db, 'agences-un'), /groupe non vide : 1 site\(s\) \(agence-un\)/);
    db.prepare("UPDATE site SET active = 0 WHERE id = 'agence-un'").run();
    assert.throws(() => removeGroup(db, 'agences-un'), /groupe non vide : 1 site\(s\)/, 'un site desactive compte aussi');
    assignSite(db, 'agence-un', null, NOW);
    const org = (db.prepare("SELECT id FROM organization WHERE name = 'Banque'").get() as { id: number }).id;
    const gid = (db.prepare("SELECT id FROM site_group WHERE code = 'agences-un'").get() as { id: number }).id;
    addUser(db, { username: 'dir-regional', role: 'director', orgId: org, groupIds: [gid] });
    assert.throws(() => removeGroup(db, 'agences-un'), /utilise par 1 compte\(s\) limite\(s\) \(dir-regional\)/);
    unlimitUser(db, 'dir-regional', NOW);
    removeGroup(db, 'agences-un', NOW);
    removeGroup(db, 'region-nord', NOW);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM site_group').get() as { n: number }).n, 0);
    assert.throws(() => removeGroup(db, 'region-nord'), /groupe introuvable/);
    assert.deepEqual(audit(db).filter((a) => a.startsWith('group_removed')), ['group_removed: agences-un (Agences)', 'group_removed: region-nord (Région Nord)']);
  });

  it('limite un directeur a un ou plusieurs groupes, change sa limite, la leve ; refuse les autres roles et les groupes d une autre organisation', () => {
    const db = fresh();
    addGroup(db, 'Banque', 'region-nord', 'Région Nord', null, NOW);
    addGroup(db, 'Banque', 'region-sud', 'Région Sud', null, NOW);
    addGroup(db, 'Autre', 'groupe-autre', 'Groupe Autre', null, NOW);
    const org = (db.prepare("SELECT id FROM organization WHERE name = 'Banque'").get() as { id: number }).id;
    addUser(db, { username: 'dir-banque', role: 'director', orgId: org });
    addUser(db, { username: 'prestataire', role: 'admin' });
    addUser(db, { username: 'resp-agence', role: 'site_manager', orgId: org, siteId: 'agence-un' });
    const scope = () => (db.prepare('SELECT g.code FROM portal_user_group ug JOIN site_group g ON g.id = ug.group_id WHERE ug.username = ? ORDER BY g.code').all('dir-banque') as { code: string }[]).map((r) => r.code);
    const limited = () => (db.prepare("SELECT group_limited AS l FROM portal_user WHERE username = 'dir-banque'").get() as { l: number }).l;
    assert.deepEqual([scope(), limited()], [[], 0]);
    limitUser(db, 'dir-banque', ['region-nord', 'region-sud'], NOW);
    assert.deepEqual([scope(), limited()], [['region-nord', 'region-sud'], 1]);
    limitUser(db, 'dir-banque', ['region-sud'], NOW);
    assert.deepEqual(scope(), ['region-sud'], 'la nouvelle limite REMPLACE l ancienne');
    assert.throws(() => limitUser(db, 'dir-banque', ['groupe-autre'], NOW), /son organisation/);
    assert.deepEqual(scope(), ['region-sud'], 'un refus ne change rien (transaction)');
    assert.throws(() => limitUser(db, 'dir-banque', ['groupe-inconnu'], NOW), /groupe introuvable/);
    assert.throws(() => limitUser(db, 'dir-banque', [], NOW), /au moins un groupe/);
    assert.throws(() => limitUser(db, 'prestataire', ['region-sud'], NOW), /seul un directeur/);
    assert.throws(() => limitUser(db, 'resp-agence', ['region-sud'], NOW), /seul un directeur/);
    assert.throws(() => limitUser(db, 'fantome', ['region-sud'], NOW), /compte introuvable/);
    unlimitUser(db, 'dir-banque', NOW);
    assert.deepEqual([scope(), limited()], [[], 0]);
    assert.deepEqual(audit(db).filter((a) => a.startsWith('user_')).slice(-3), ['user_limited: dir-banque : region-nord, region-sud', 'user_limited: dir-banque : region-sud', 'user_unlimited: dir-banque']);
  });

  it('un compte cree directement avec ses groupes : tout ou rien (transaction)', () => {
    const db = fresh();
    addGroup(db, 'Banque', 'region-nord', 'Région Nord', null, NOW);
    addGroup(db, 'Autre', 'groupe-autre', 'Groupe Autre', null, NOW);
    const org = (db.prepare("SELECT id FROM organization WHERE name = 'Banque'").get() as { id: number }).id;
    const gid = (code: string) => (db.prepare('SELECT id FROM site_group WHERE code = ?').get(code) as { id: number }).id;
    assert.throws(() => addUser(db, { username: 'dir-faux', role: 'director', orgId: org, groupIds: [gid('region-nord'), gid('groupe-autre')] }), /son organisation/);
    assert.equal(db.prepare("SELECT 1 FROM portal_user WHERE username = 'dir-faux'").get(), undefined, 'aucun compte a moitie cree');
    assert.throws(() => addUser(db, { username: 'admin-faux', role: 'admin', groupIds: [gid('region-nord')] }), /seul un directeur/);
    assert.throws(() => addUser(db, { username: 'dir-zero', role: 'director', orgId: org, groupIds: [] }), /au moins un groupe/);
    addUser(db, { username: 'dir-ok', role: 'director', orgId: org, groupIds: [gid('region-nord')] });
    assert.equal((db.prepare("SELECT group_limited AS l FROM portal_user WHERE username = 'dir-ok'").get() as { l: number }).l, 1);
  });

  it('« list » montre les groupes, leurs sites, les sites sans groupe et la limite de chaque compte', () => {
    const db = fresh();
    addGroup(db, 'Banque', 'region-nord', 'Région Nord', null, NOW);
    addGroup(db, null, 'agences-un', 'Agences', 'region-nord', NOW);
    addSite(db, 'Banque', 'siege-social', 'Siège', NOW);
    assignSite(db, 'agence-un', 'agences-un', NOW);
    const org = (db.prepare("SELECT id FROM organization WHERE name = 'Banque'").get() as { id: number }).id;
    addUser(db, { username: 'dir-nord', role: 'director', orgId: org });
    limitUser(db, 'dir-nord', ['region-nord'], NOW);
    addUser(db, { username: 'dir-vide', role: 'director', orgId: org });
    db.prepare("UPDATE portal_user SET group_limited = 1 WHERE username = 'dir-vide'").run();
    const text = listAll(db);
    assert.match(text, /groupe region-nord — Région Nord\n    groupe agences-un — Agences\n      site agence-un/);
    assert.match(text, /sans groupe :\n    site siege-social/);
    assert.match(text, /compte dir-nord — director \(limite a : region-nord\)/);
    assert.match(text, /compte dir-vide — director \(limite, AUCUN groupe : ne voit rien\)/);
    assert.match(text, /Organisation : Autre\n  site boutique-un/, 'une organisation sans groupe s affiche comme avant');
  });
});

describe('commandes « portal:admin » (executees sans processus)', () => {
  const db = openPortalDb(':memory:');
  const run = (...args: string[]) => {
    try {
      const r = runCommand(db, Buffer.alloc(32, 9), args[0], args.slice(1), 'https://suivi.exemple.com');
      return { code: r.unknown ? 1 : 0, out: r.out, err: '' };
    } catch (err) {
      return { code: 1, out: '', err: `Erreur : ${(err as Error).message}` };
    }
  };

  it('deroule une installation complete : groupes, sous-groupes, sites, comptes limites', () => {
    assert.equal(run('add-org', 'Banque du Fouta').code, 0);
    assert.equal(run('add-site', 'Banque du Fouta', 'agence-labe', 'Agence de Labé').code, 0);
    assert.equal(run('add-site', 'Banque du Fouta', 'agence-pita', 'Agence de Pita').code, 0);
    assert.equal(run('add-site', 'Banque du Fouta', 'siege-conakry', 'Siège de Conakry').code, 0);

    const region = run('add-group', 'moyenne-guinee', 'Moyenne', 'Guinée', '--org', 'Banque du Fouta');
    assert.equal(region.code, 0, region.err);
    assert.match(region.out, /Groupe « Moyenne Guinée » \(moyenne-guinee\) créé/);
    const sub = run('add-group', 'agences-labe', 'Agences de Labé', '--parent', 'moyenne-guinee');
    assert.equal(sub.code, 0, sub.err);
    assert.match(sub.out, /Sous-groupe « Agences de Labé » \(agences-labe\) créé/);

    assert.match(run('assign-site', 'agence-labe', 'agences-labe').out, /Site agence-labe rangé dans le groupe agences-labe/);
    assert.equal(run('assign-site', 'agence-pita', 'moyenne-guinee').code, 0);

    const user = run('add-user', 'dir-region', 'director', '--org', 'Banque du Fouta', '--name', 'Directeur régional', '--groups', 'moyenne-guinee');
    assert.equal(user.code, 0, user.err);
    assert.match(user.out, /Compte dir-region créé \(limité aux groupes : moyenne-guinee\)/);
    assert.match(user.out, /Mot de passe provisoire/);
    assert.equal(run('add-user', 'dir-general', 'director', '--org', 'Banque du Fouta').code, 0);

    const list = run('list');
    assert.match(list.out, /groupe moyenne-guinee — Moyenne Guinée\n    site agence-pita/);
    assert.match(list.out, /groupe agences-labe — Agences de Labé\n      site agence-labe/);
    assert.match(list.out, /sans groupe :\n    site siege-conakry/);
    assert.match(list.out, /compte dir-region — director \(limite a : moyenne-guinee\)/);
    assert.match(list.out, /compte dir-general — director\n/);

    assert.match(run('rename-group', 'moyenne-guinee', 'Région', 'Moyenne-Guinée').out, /Groupe moyenne-guinee renommé « Région Moyenne-Guinée »/);
    assert.match(run('unassign-site', 'agence-pita').out, /Site agence-pita sorti de son groupe/);
    assert.match(run('limit-user', 'dir-general', 'agences-labe').out, /Compte dir-general limité aux groupes : agences-labe/);
    assert.match(run('unlimit-user', 'dir-general').out, /limite levée/);
  });

  it('refuse en francais, avec un code de sortie 1 et sans rien changer', () => {
    const refusals: [string[], RegExp][] = [
      [['remove-group', 'moyenne-guinee'], /^Erreur : groupe non vide : 1 sous-groupe\(s\) \(agences-labe\)/],
      [['remove-group', 'agences-labe'], /^Erreur : groupe non vide : 1 site\(s\) \(agence-labe\)/],
      [['add-group', 'sous-sous', 'Trop profond', '--parent', 'agences-labe'], /^Erreur : « Agences de Labé » est deja un sous-groupe : deux niveaux au plus/],
      [['add-group', 'sans-org', 'Sans organisation'], /^Erreur : indiquer l'organisation/],
      [['assign-site', 'agence-labe', 'groupe-inconnu'], /^Erreur : groupe introuvable : groupe-inconnu/],
      [['assign-site', 'site-inconnu', 'agences-labe'], /^Erreur : site introuvable : site-inconnu/],
      [['limit-user', 'dir-general'], /^Erreur : indiquer au moins un groupe/],
      [['limit-user', 'fantome', 'agences-labe'], /^Erreur : compte introuvable/],
      [['add-user', 'resp-labe', 'site_manager', '--site', 'agence-labe', '--groups', 'agences-labe'], /^Erreur : --groups ne concerne que les directeurs/],
      [['add-user', 'dir-vide', 'director', '--org', 'Banque du Fouta', '--groups'], /^Erreur : --groups attend au moins un code de groupe/],
    ];
    for (const [args, expected] of refusals) {
      const r = run(...args);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err.trim(), expected, args.join(' '));
      assert.equal(r.out, '', args.join(' '));
    }
    const list = run('list').out;
    assert.match(list, /groupe agences-labe/, 'rien n a ete supprime');
    assert.ok(!list.includes('resp-labe') && !list.includes('dir-vide'), 'aucun compte cree par une commande refusee');
  });

  it('une fois vide, le groupe se supprime ; tout est dans le journal du portail', () => {
    assert.equal(run('unassign-site', 'agence-labe').code, 0);
    assert.equal(run('remove-group', 'agences-labe').code, 0);
    const blocked = run('remove-group', 'moyenne-guinee');
    assert.equal(blocked.code, 1, 'le directeur regional est encore limite a ce groupe');
    assert.match(blocked.err, /Erreur : groupe utilise par 1 compte\(s\) limite\(s\) \(dir-region\)/);
    assert.equal(run('unlimit-user', 'dir-region').code, 0);
    assert.equal(run('remove-group', 'moyenne-guinee').code, 0);
    assert.equal(run('remove-group', 'moyenne-guinee').code, 1);
    const actions = (db.prepare("SELECT action FROM audit WHERE action LIKE 'group_%' OR action LIKE 'site_group_%' OR action LIKE 'user_%limited' ORDER BY id").all() as { action: string }[]).map((a) => a.action);
    assert.deepEqual(actions, ['group_created', 'group_created', 'site_group_assigned', 'site_group_assigned', 'group_renamed', 'site_group_cleared', 'user_limited', 'user_unlimited', 'site_group_cleared', 'group_removed', 'user_unlimited', 'group_removed']);
  });

  it('l aide liste les nouvelles commandes', () => {
    const r = run();
    assert.match(r.out, /add-group, rename-group, remove-group, assign-site, unassign-site, limit-user, unlimit-user/);
  });
});

describe('commande « portal:admin » (processus reel)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portail-admin-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const root = resolve(import.meta.dirname, '..', '..');
  const spawn = (...args: string[]) => {
    const r = spawnSync(process.execPath, ['portal/scripts/admin.ts', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PORTAL_DATA_DIR: dir, PORTAL_MASTER_KEY: 'ab'.repeat(32), PORTAL_ENV: '' } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it('cree un groupe sur une vraie base, le liste, refuse en francais avec le code de sortie 1', () => {
    assert.equal(spawn('add-org', 'Banque du Fouta').code, 0);
    assert.equal(spawn('add-site', 'Banque du Fouta', 'agence-labe', 'Agence de Labé').code, 0);
    const created = spawn('add-group', 'moyenne-guinee', 'Moyenne', 'Guinée', '--org', 'Banque du Fouta');
    assert.equal(created.code, 0, created.err);
    assert.match(created.out, /Groupe « Moyenne Guinée » \(moyenne-guinee\) créé/);
    assert.equal(spawn('assign-site', 'agence-labe', 'moyenne-guinee').code, 0);
    assert.match(spawn('list').out, /groupe moyenne-guinee — Moyenne Guinée\n    site agence-labe/);
    const refused = spawn('remove-group', 'moyenne-guinee');
    assert.equal(refused.code, 1);
    assert.match(refused.err, /Erreur : groupe non vide : 1 site\(s\) \(agence-labe\)/);
    assert.equal(spawn('commande-inconnue').code, 1);
  });
});
