import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { principalFor, resetThrottles, visibleGroups, visibleSites } from '../../portal/server/accounts.ts';
import type { Principal } from '../../portal/server/accounts.ts';
import { addGroup, addOrganization, assignSite, groupIdsByCodes, limitUser, removeGroup, unlimitUser } from '../../portal/server/admin.ts';
import { siteKey } from '../../portal/server/keys.ts';
import { HOUR, MASTER, NOW, addUser, get, login, makeSummary, post, provision, startPortal } from './helpers.ts';
import type { Portal } from './helpers.ts';

/**
 * Perimetre par GROUPE. Une banque (« Banque ») a deux regions, dont l'une a deux agences, et un siege sans groupe ; un autre
 * client (« Autre ») a son propre groupe. Un directeur limite a un groupe ne doit obtenir AUCUNE donnee d'un autre groupe, par
 * aucune route : ni fiche de site, ni incident, ni serie, ni total, ni nom, ni numero de groupe devine.
 */
describe('perimetre par groupe', () => {
  let portal: Portal;
  const ids: Record<string, number> = {};

  // Site -> [organisation, groupe (code) ou null, nom]
  const SITES: Record<string, [string, string | null, string]> = {
    'nord-direct': ['Banque', 'region-nord', 'Caisse centrale Nord'],
    'nord-un': ['Banque', 'agence-nord-un', 'Agence Nord Un'],
    'nord-deux': ['Banque', 'agence-nord-deux', 'Agence Nord Deux'],
    'sud-un': ['Banque', 'region-sud', 'Agence Sud Un'],
    'sud-deux': ['Banque', 'region-sud', 'Agence Sud Deux'],
    siege: ['Banque', null, 'Siege social'],
    'autre-un': ['Autre', 'groupe-autre', 'Boutique Autre Un'],
  };

  before(async () => {
    portal = await startPortal();
    for (const org of ['Banque', 'Autre']) addOrganization(portal.db, org, NOW);
    addGroup(portal.db, 'Banque', 'region-nord', 'Région Nord', null, NOW);
    addGroup(portal.db, null, 'agence-nord-un', 'Agences Un', 'region-nord', NOW);
    addGroup(portal.db, null, 'agence-nord-deux', 'Agences Deux', 'region-nord', NOW);
    addGroup(portal.db, 'Banque', 'region-sud', 'Région Sud', null, NOW);
    addGroup(portal.db, 'Autre', 'groupe-autre', 'Groupe Autre', null, NOW);
    for (const code of ['region-nord', 'agence-nord-un', 'agence-nord-deux', 'region-sud', 'groupe-autre']) ids[code] = groupIdsByCodes(portal.db, [code])[0];

    for (const [id, [org, group, name]] of Object.entries(SITES)) {
      provision(portal.db, org, id, name);
      if (group) assignSite(portal.db, id, group, NOW);
      // Chaque site a son etat : une alarme chez nord-un, un equipement en panne chez sud-un, le reste va bien.
      const summary = makeSummary(id, {
        risk: true,
        mutate: (e, goTo) => {
          if (id === 'nord-un') (goTo(NOW - HOUR), e.handleDetectorMessage('D-01', { state: 'alarm' }));
          if (id === 'sud-un') (goTo(NOW - HOUR), e.handleDetectorMessage('D-02', { state: 'fault' }));
        },
      });
      assert.equal((await post(portal, { siteId: id, key: siteKey(MASTER, id, 1), body: JSON.stringify(summary) })).status, 200, id);
    }

    const org = (name: string) => (portal.db.prepare('SELECT id FROM organization WHERE name = ?').get(name) as { id: number }).id;
    addUser(portal.db, { username: 'prestataire', role: 'admin' });
    addUser(portal.db, { username: 'dir-banque', role: 'director', orgId: org('Banque') });
    addUser(portal.db, { username: 'dir-nord', role: 'director', orgId: org('Banque'), groupIds: [ids['region-nord']] });
    addUser(portal.db, { username: 'dir-agence', role: 'director', orgId: org('Banque'), groupIds: [ids['agence-nord-un']] });
    addUser(portal.db, { username: 'dir-sud', role: 'director', orgId: org('Banque'), groupIds: [ids['region-sud']] });
    addUser(portal.db, { username: 'dir-deux', role: 'director', orgId: org('Banque'), groupIds: [ids['agence-nord-deux'], ids['region-sud']] });
    addUser(portal.db, { username: 'dir-autre', role: 'director', orgId: org('Autre') });
    addUser(portal.db, { username: 'resp-nord-un', role: 'site_manager', orgId: org('Banque'), siteId: 'nord-un' });
    // Limite sans aucun groupe : ne doit rien voir (jamais « toute l'organisation » par defaut).
    addUser(portal.db, { username: 'dir-vide', role: 'director', orgId: org('Banque') });
    portal.db.prepare("UPDATE portal_user SET group_limited = 1 WHERE username = 'dir-vide'").run();
  });
  after(() => portal.close());
  beforeEach(() => resetThrottles());

  const siteIds = (cards: { id: string }[]) => cards.map((c) => c.id).sort();
  const sites = async (who: string) => siteIds((await get(portal, '/api/sites', await login(portal, who))).json);

  /** Tout ce qu'un compte peut lire, par toutes les routes, y compris avec des parametres trafiques et des identifiants devines. */
  async function everything(who: string): Promise<{ allowedSites: string[]; text: string }> {
    const cookie = await login(portal, who);
    const out: unknown[] = [];
    const all = [
      '/api/me', '/api/overview', '/api/sites', '/api/groups',
      '/api/sites?org=1&group=1&groupId=2', '/api/groups?org=1&group=1', '/api/overview?group=3&role=admin',
    ];
    for (const path of all) out.push((await get(portal, path, cookie)).json);
    for (const id of Object.keys(SITES)) for (const days of [7, 30, 90]) out.push((await get(portal, `/api/sites/${id}?days=${days}`, cookie)).json);
    for (let g = 0; g <= 12; g++) out.push((await get(portal, `/api/groups/${g}`, cookie)).json);
    for (const guess of ['abc', '-1', '1e3', '2%20OR%201=1', '99999999999999', '1.5', '%00']) out.push((await get(portal, `/api/groups/${guess}`, cookie)).json);
    const allowed = siteIds((await get(portal, '/api/sites', cookie)).json);
    return { allowedSites: allowed, text: JSON.stringify(out) };
  }

  describe('qui voit quoi', () => {
    it('sans limite : toute l organisation, siege sans groupe compris ; le prestataire voit tout', async () => {
      assert.deepEqual(await sites('dir-banque'), ['nord-deux', 'nord-direct', 'nord-un', 'siege', 'sud-deux', 'sud-un']);
      assert.deepEqual(await sites('prestataire'), Object.keys(SITES).sort());
      assert.deepEqual(await sites('dir-autre'), ['autre-un']);
    });

    it('limite a un groupe : ses sites et ceux de ses sous-groupes, rien d autre (ni le siege, ni l autre region)', async () => {
      assert.deepEqual(await sites('dir-nord'), ['nord-deux', 'nord-direct', 'nord-un']);
      assert.deepEqual(await sites('dir-sud'), ['sud-deux', 'sud-un']);
    });

    it('limite a un sous-groupe : ce sous-groupe seul, pas son groupe parent ni son voisin', async () => {
      assert.deepEqual(await sites('dir-agence'), ['nord-un']);
    });

    it('limite a plusieurs groupes : leur reunion', async () => {
      assert.deepEqual(await sites('dir-deux'), ['nord-deux', 'sud-deux', 'sud-un']);
    });

    it('limite sans aucun groupe : ne voit rien, ni site, ni groupe, ni total (ferme par defaut)', async () => {
      const cookie = await login(portal, 'dir-vide');
      assert.deepEqual((await get(portal, '/api/sites', cookie)).json, []);
      const groups = (await get(portal, '/api/groups', cookie)).json;
      assert.equal(groups.hasGroups, false);
      assert.deepEqual(groups.organizations, []);
      assert.equal(groups.total.sites, 0);
      assert.equal((await get(portal, '/api/overview', cookie)).json.sites, 0);
    });

    it('un responsable de site ne voit aucun groupe, meme celui de son site', async () => {
      const cookie = await login(portal, 'resp-nord-un');
      assert.deepEqual(await sites('resp-nord-un'), ['nord-un']);
      assert.equal((await get(portal, '/api/groups', cookie)).json.hasGroups, false);
      for (const id of Object.values(ids)) assert.equal((await get(portal, `/api/groups/${id}`, cookie)).status, 404);
      const detail = (await get(portal, '/api/sites/nord-un', cookie)).json;
      assert.deepEqual(detail.groupPath, []);
    });

    it('la limite est relue a chaque requete : changer le perimetre ou deplacer un site agit aussitot sur la session ouverte', async () => {
      const cookie = await login(portal, 'dir-sud');
      assert.deepEqual(siteIds((await get(portal, '/api/sites', cookie)).json), ['sud-deux', 'sud-un']);
      assignSite(portal.db, 'sud-deux', 'region-nord', NOW);
      assert.deepEqual(siteIds((await get(portal, '/api/sites', cookie)).json), ['sud-un'], 'le site deplace disparait aussitot');
      assert.equal((await get(portal, '/api/sites/sud-deux', cookie)).status, 404);
      assignSite(portal.db, 'sud-deux', 'region-sud', NOW);

      limitUser(portal.db, 'dir-sud', ['agence-nord-deux']);
      assert.deepEqual(siteIds((await get(portal, '/api/sites', cookie)).json), ['nord-deux'], 'nouvelle limite, meme session');
      limitUser(portal.db, 'dir-sud', ['region-sud']);
      assert.deepEqual(siteIds((await get(portal, '/api/sites', cookie)).json), ['sud-deux', 'sud-un']);

      unlimitUser(portal.db, 'dir-sud');
      assert.equal(siteIds((await get(portal, '/api/sites', cookie)).json).length, 6, 'limite levee : toute l organisation');
      limitUser(portal.db, 'dir-sud', ['region-sud']);
    });

    it('un sous-groupe cree plus tard dans un groupe auquel le compte est limite lui est visible', async () => {
      addGroup(portal.db, null, 'agence-sud-neuve', 'Agence neuve', 'region-sud', NOW);
      const cookie = await login(portal, 'dir-sud');
      const names = ((await get(portal, '/api/groups', cookie)).json.organizations[0].groups[0].children as { code: string }[]).map((c) => c.code);
      assert.deepEqual(names, ['agence-sud-neuve']);
      removeGroup(portal.db, 'agence-sud-neuve');
    });
  });

  describe('aucune fuite, par aucune route', () => {
    // Pour chaque compte : (sites autorises, groupes autorises). Tout le reste ne doit apparaitre NULLE PART.
    const CASES: Record<string, { sites: string[]; groups: string[] }> = {
      'dir-nord': { sites: ['nord-deux', 'nord-direct', 'nord-un'], groups: ['region-nord', 'agence-nord-un', 'agence-nord-deux'] },
      'dir-agence': { sites: ['nord-un'], groups: ['agence-nord-un'] },
      'dir-sud': { sites: ['sud-deux', 'sud-un'], groups: ['region-sud'] },
      'dir-deux': { sites: ['nord-deux', 'sud-deux', 'sud-un'], groups: ['agence-nord-deux', 'region-sud'] },
      'dir-autre': { sites: ['autre-un'], groups: ['groupe-autre'] },
      'dir-vide': { sites: [], groups: [] },
      'resp-nord-un': { sites: ['nord-un'], groups: [] },
    };
    const NAMES: Record<string, string> = { 'region-nord': 'Région Nord', 'agence-nord-un': 'Agences Un', 'agence-nord-deux': 'Agences Deux', 'region-sud': 'Région Sud', 'groupe-autre': 'Groupe Autre' };

    for (const [who, expected] of Object.entries(CASES)) {
      it(`${who} : ne lit rien des sites ni des groupes hors de son perimetre`, async () => {
        const { allowedSites, text } = await everything(who);
        assert.deepEqual(allowedSites, expected.sites);
        for (const [id, [, , name]] of Object.entries(SITES)) {
          if (expected.sites.includes(id)) continue;
          assert.ok(!text.includes(`"${id}"`), `identifiant « ${id} » visible par ${who}`);
          assert.ok(!text.includes(name), `nom « ${name} » visible par ${who}`);
        }
        for (const code of Object.keys(NAMES)) {
          if (expected.groups.includes(code)) continue;
          assert.ok(!text.includes(`"${code}"`), `code « ${code} » visible par ${who}`);
          assert.ok(!text.includes(NAMES[code]), `groupe « ${NAMES[code]} » visible par ${who}`);
        }
      });

      it(`${who} : un identifiant de groupe ou de site devine donne « introuvable », comme un identifiant qui n existe pas`, async () => {
        const cookie = await login(portal, who);
        const absent = await get(portal, '/api/groups/9999', cookie);
        assert.equal(absent.status, 404);
        for (const [code, gid] of Object.entries(ids)) {
          const r = await get(portal, `/api/groups/${gid}`, cookie);
          if (expected.groups.includes(code)) assert.equal(r.status, 200, code);
          else {
            assert.equal(r.status, 404, `${code} devine`);
            assert.deepEqual(r.json, absent.json);
          }
        }
        const missing = await get(portal, '/api/sites/nexiste-pas', cookie);
        for (const id of Object.keys(SITES)) {
          if (expected.sites.includes(id)) continue;
          const r = await get(portal, `/api/sites/${id}`, cookie);
          assert.equal(r.status, 404, `${id} devine`);
          assert.deepEqual(r.json, missing.json);
        }
      });
    }

    it('les totaux ne contiennent que le perimetre : ni compte, ni etat, ni indice, ni incident d un autre groupe', async () => {
      // nord-un est en alarme, sud-un en panne : chacun ne le sait que s il le voit.
      const nord = (await get(portal, '/api/groups', await login(portal, 'dir-nord'))).json;
      const sud = (await get(portal, '/api/groups', await login(portal, 'dir-sud'))).json;
      assert.equal(nord.total.sites, 3);
      assert.equal(nord.total.states.alarm, 1);
      assert.equal(nord.total.states.degraded, 0);
      assert.equal(sud.total.sites, 2);
      assert.equal(sud.total.states.alarm, 0, 'l alarme de la region nord n existe pas pour le directeur sud');
      assert.equal(sud.total.states.degraded, 1);
      assert.equal(sud.total.incidents.open, 0);
      const ov = (await get(portal, '/api/overview', await login(portal, 'dir-sud'))).json;
      assert.equal(ov.sites, 2);
      assert.equal(ov.openNow, 0);
      assert.ok(!JSON.stringify(sud).includes('nord'), 'rien de la region nord');
      // L'indice le plus expose et la moyenne ne viennent que du perimetre.
      for (const who of ['dir-nord', 'dir-sud']) {
        const body = (await get(portal, '/api/groups', await login(portal, who))).json;
        const worstId = body.total.risk.worst.siteId as string;
        assert.ok(worstId.startsWith(who === 'dir-nord' ? 'nord' : 'sud'), `${who} : site le plus expose ${worstId}`);
      }
    });

    it('les parametres envoyes par le navigateur ne changent rien (ni en-tete, ni requete)', async () => {
      const cookie = await login(portal, 'dir-sud');
      const res = await fetch(`${portal.base}/api/groups?group=${ids['region-nord']}&groupId=${ids['region-nord']}`, { headers: { cookie, 'x-group': String(ids['region-nord']), 'x-role': 'admin' } });
      const text = JSON.stringify(await res.json());
      assert.ok(!text.includes('region-nord') && !text.includes('nord-un'));
    });

    it('le perimetre du compte est lu en base avec sa session (jamais fourni par le navigateur)', async () => {
      const cookie = await login(portal, 'dir-agence');
      assert.deepEqual(siteIds((await get(portal, '/api/sites', cookie)).json), ['nord-un']);
      const p = principalFor(portal.db, cookie.split('=')[1], NOW) as Principal;
      assert.deepEqual(p.groupScope, [ids['agence-nord-un']]);
    });
  });

  describe('le niveau groupe ne casse pas les comptes existants', () => {
    it('un directeur sans limite et un responsable de site gardent exactement leur perimetre d avant', () => {
      const direct = { username: 'x', role: 'director', orgId: 1, siteId: null, displayName: 'x', mustChangePassword: false, groupScope: null } as Principal;
      assert.deepEqual(visibleSites(portal.db, direct).map((s) => s.id).sort(), ['nord-deux', 'nord-direct', 'nord-un', 'siege', 'sud-deux', 'sud-un']);
      const manager = { ...direct, role: 'site_manager', orgId: 1, siteId: 'siege' } as Principal;
      assert.deepEqual(visibleSites(portal.db, manager).map((s) => s.id), ['siege']);
      assert.deepEqual(visibleGroups(portal.db, manager), []);
    });

    it('la limite est refusee par la base elle-meme : groupe d une autre organisation, ou compte qui n est pas directeur', () => {
      assert.throws(() => portal.db.prepare("INSERT INTO portal_user_group (username, group_id) VALUES ('dir-banque', ?)").run(ids['groupe-autre']), /son organisation/);
      assert.throws(() => portal.db.prepare("INSERT INTO portal_user_group (username, group_id) VALUES ('prestataire', ?)").run(ids['region-sud']), /seul un directeur/);
      assert.throws(() => portal.db.prepare("INSERT INTO portal_user_group (username, group_id) VALUES ('resp-nord-un', ?)").run(ids['region-sud']), /seul un directeur/);
    });

    it('un groupe qui limite un compte ne peut pas etre supprime, meme en SQL direct (le perimetre ne s elargit pas en silence)', () => {
      const gid = addGroup(portal.db, 'Banque', 'groupe-vide-limite', 'Groupe vide', null, NOW);
      const org = (portal.db.prepare("SELECT id FROM organization WHERE name = 'Banque'").get() as { id: number }).id;
      addUser(portal.db, { username: 'dir-temporaire', role: 'director', orgId: org, groupIds: [gid] });
      assert.throws(() => portal.db.prepare('DELETE FROM site_group WHERE id = ?').run(gid), /FOREIGN KEY/);
      assert.throws(() => removeGroup(portal.db, 'groupe-vide-limite'), /utilise par 1 compte\(s\) limite\(s\) \(dir-temporaire\)/);
      unlimitUser(portal.db, 'dir-temporaire');
      removeGroup(portal.db, 'groupe-vide-limite');
    });
  });
});
