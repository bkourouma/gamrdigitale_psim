import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Principal } from '../../portal/server/accounts.ts';
import { addGroup, addOrganization, addSite, assignSite } from '../../portal/server/admin.ts';
import { groupDetail, groupsOverview, worstFirst } from '../../portal/server/groupviews.ts';
import { openPortalDb } from '../../portal/server/db.ts';
import { parseSummary, storeSummary } from '../../portal/server/ingest.ts';
import { siteStatus } from '../../portal/server/views.ts';
import type { SiteSummary } from '../../server/portal.ts';
// @ts-ignore ui.js est un module du navigateur (aucune declaration de types) ; seules ses constantes sont lues ici.
import { CATEGORY, qualificationLabel } from '../../portal/web/ui.js';
import { HOUR, NOW, makeSummary } from './helpers.ts';

const STALE = 15 * 60_000;
const ADMIN: Principal = { username: 'prestataire', role: 'admin', orgId: null, siteId: null, displayName: 'P', mustChangePassword: false, groupScope: null };

type Db = ReturnType<typeof openPortalDb>;

/** Le portail a un groupe-test : on y range des sites dont on maitrise l'etat, les mesures et l'indice. */
function world() {
  const db = openPortalDb(':memory:');
  addOrganization(db, 'Banque', NOW);
  return db;
}

interface SiteSpec {
  id: string;
  group?: string;
  /** Resume du site ; absent : le site n'a jamais rien envoye. */
  summary?: SiteSummary;
  /** Il y a combien de temps le resume a ete recu (defaut : a l'instant). */
  silentForMs?: number;
  /** Jours de mesure, exacts (remplacent ceux du resume) : [jour, secondes en service, secondes en panne]. */
  days?: [string, number, number][];
  /** Indice GAMR impose (null : zones non evaluees). `undefined` : celui du resume. */
  risk?: number | null;
}

function addSiteTo(db: Db, spec: SiteSpec): void {
  addSite(db, 'Banque', spec.id, `Site ${spec.id}`, NOW);
  if (spec.group) assignSite(db, spec.id, spec.group, NOW);
  if (!spec.summary) return;
  const summary: SiteSummary = structuredClone(spec.summary);
  if (spec.risk !== undefined) summary.risk = { index: spec.risk, worstZone: spec.risk === null ? null : 'Zone A', assessedZones: spec.risk === null ? 0 : 1, totalZones: 1, zones: [], history: [] };
  const received = NOW - (spec.silentForMs ?? 0);
  storeSummary(db, spec.id, { ...summary, generatedAt: received }, received);
  if (spec.days) {
    db.prepare('DELETE FROM site_day WHERE site_id = ?').run(spec.id);
    for (const [day, up, down] of spec.days) db.prepare('INSERT INTO site_day (site_id, day, pct, up_s, down_s, unmonitored_s) VALUES (?, ?, ?, ?, ?, 0)').run(spec.id, day, up + down > 0 ? (up / (up + down)) * 100 : null, up, down);
  }
}

const ok = () => makeSummary('x', { risk: true });
const alarm = () => makeSummary('x', { risk: true, mutate: (e, goTo) => (goTo(NOW - HOUR), e.handleDetectorMessage('D-01', { state: 'alarm' })) });
const fault = () => makeSummary('x', { risk: true, mutate: (e, goTo) => (goTo(NOW - HOUR), e.handleDetectorMessage('D-02', { state: 'fault' })) });

const overview = (db: Db) => groupsOverview(db, ADMIN, NOW, STALE);
const groupByCode = (db: Db, code: string) => {
  const id = (db.prepare('SELECT id FROM site_group WHERE code = ?').get(code) as { id: number }).id;
  return groupDetail(db, ADMIN, id, NOW, STALE)!;
};

describe('tableau de bord par groupe', () => {
  it('compte les sites par etat et donne le pire etat du groupe', () => {
    const db = world();
    addGroup(db, 'Banque', 'region-a', 'Région A', null, NOW);
    addSiteTo(db, { id: 'a-ok', group: 'region-a', summary: ok() });
    addSiteTo(db, { id: 'a-panne', group: 'region-a', summary: fault() });
    addSiteTo(db, { id: 'a-alarme', group: 'region-a', summary: alarm() });
    const g = groupByCode(db, 'region-a');
    assert.equal(g.stats.sites, 3);
    assert.deepEqual({ ok: g.stats.states.ok, degraded: g.stats.states.degraded, alarm: g.stats.states.alarm }, { ok: 1, degraded: 1, alarm: 1 });
    assert.equal(g.stats.worstLevel, 'alarm');
    assert.equal(g.stats.devicesDown, 1);
    assert.deepEqual(g.sites.map((s) => s.id), ['a-alarme', 'a-panne', 'a-ok'], 'les sites du groupe aussi : pire d abord');
  });

  it('classe les groupes pire-d abord : alarme, muet, a surveiller, sans mesure, en bon etat, et le groupe vide en dernier', () => {
    const db = world();
    for (const [code, name] of [['g-vide', 'Vide'], ['g-ok', 'Bon'], ['g-inconnu', 'Inconnu'], ['g-panne', 'Panne'], ['g-muet', 'Muet'], ['g-alarme', 'Alarme']]) addGroup(db, 'Banque', code, name, null, NOW);
    addSiteTo(db, { id: 's-ok', group: 'g-ok', summary: ok() });
    addSiteTo(db, { id: 's-inconnu', group: 'g-inconnu' });
    addSiteTo(db, { id: 's-panne', group: 'g-panne', summary: fault() });
    addSiteTo(db, { id: 's-muet', group: 'g-muet', summary: ok(), silentForMs: 3 * HOUR });
    addSiteTo(db, { id: 's-alarme', group: 'g-alarme', summary: alarm() });
    assert.deepEqual(overview(db).organizations[0].groups.map((g) => g.code), ['g-alarme', 'g-muet', 'g-panne', 'g-inconnu', 'g-ok', 'g-vide']);
  });

  it('a etat egal : le plus de sites en alarme, puis d incidents ouverts, puis l indice le plus haut, puis le nom', () => {
    const db = world();
    addGroup(db, 'Banque', 'g-un', 'Un site en alarme', null, NOW);
    addGroup(db, 'Banque', 'g-deux', 'Deux sites en alarme', null, NOW);
    addSiteTo(db, { id: 'un-un', group: 'g-un', summary: alarm() });
    addSiteTo(db, { id: 'un-deux', group: 'g-un', summary: ok() });
    addSiteTo(db, { id: 'de-un', group: 'g-deux', summary: alarm() });
    addSiteTo(db, { id: 'de-deux', group: 'g-deux', summary: alarm() });
    assert.deepEqual(overview(db).organizations[0].groups.map((g) => g.code), ['g-deux', 'g-un']);
    const stats = overview(db).organizations[0].groups[0].stats;
    assert.equal(worstFirst({ stats, name: 'a' }, { stats, name: 'b' }) < 0, true, 'a egalite parfaite : par le nom');
  });

  it('un groupe de sites jamais mesures n est jamais « en bon etat » ni « 100 % »', () => {
    const db = world();
    addGroup(db, 'Banque', 'g-neuf', 'Neuf', null, NOW);
    addSiteTo(db, { id: 'neuf-un', group: 'g-neuf' });
    addSiteTo(db, { id: 'neuf-deux', group: 'g-neuf' });
    const s = groupByCode(db, 'g-neuf').stats;
    assert.equal(s.worstLevel, 'unknown');
    assert.equal(s.states.ok, 0);
    assert.equal(s.neverSeen, 2);
    assert.equal(s.availability30.pct, null);
    assert.equal(s.availability30.measuredSites, 0);
    assert.equal(s.risk.mean, null);
    assert.equal(s.risk.worst, null);
    assert.equal(s.incidents.open, 0);
  });

  it('un groupe vide : aucun site, aucun etat, aucun chiffre (pas « tout va bien »)', () => {
    const db = world();
    addGroup(db, 'Banque', 'g-vide', 'Vide', null, NOW);
    const s = groupByCode(db, 'g-vide').stats;
    assert.equal(s.sites, 0);
    assert.equal(s.worstLevel, null);
    assert.equal(s.availability30.pct, null);
    assert.equal(s.risk.mean, null);
    assert.deepEqual(groupByCode(db, 'g-vide').sites, []);
  });

  it('les sous-groupes remontent dans le groupe parent ; les sites directs restent a part', () => {
    const db = world();
    addGroup(db, 'Banque', 'reg', 'Région', null, NOW);
    addGroup(db, null, 'ag-1', 'Agence 1', 'reg', NOW);
    addGroup(db, null, 'ag-2', 'Agence 2', 'reg', NOW);
    addSiteTo(db, { id: 'direct', group: 'reg', summary: ok() });
    addSiteTo(db, { id: 'ag-un', group: 'ag-1', summary: alarm() });
    addSiteTo(db, { id: 'ag-deux', group: 'ag-2', summary: ok() });
    const reg = groupByCode(db, 'reg');
    assert.equal(reg.stats.sites, 3);
    assert.equal(reg.stats.states.alarm, 1);
    assert.deepEqual(reg.sites.map((s) => s.id), ['direct']);
    assert.deepEqual(reg.children.map((c) => c.code), ['ag-1', 'ag-2'], 'l agence en alarme d abord');
    assert.equal(reg.children[0].stats.sites, 1);
    assert.deepEqual(reg.path, []);
    assert.deepEqual(groupByCode(db, 'ag-1').path.map((p) => p.name), ['Région']);
    assert.deepEqual(groupByCode(db, 'ag-1').sites.map((s) => s.groupPath.map((g) => g.name)), [['Région', 'Agence 1']]);
  });

  it('les sites sans groupe forment « Sans groupe », a part, comptes dans l organisation', () => {
    const db = world();
    addGroup(db, 'Banque', 'reg', 'Région', null, NOW);
    addSiteTo(db, { id: 'range', group: 'reg', summary: ok() });
    addSiteTo(db, { id: 'siege', summary: alarm() });
    const org = overview(db).organizations[0];
    assert.equal(org.stats.sites, 2);
    assert.deepEqual(org.ungrouped?.siteIds, ['siege']);
    assert.equal(org.ungrouped?.stats.states.alarm, 1);
    assert.equal(org.groups[0].stats.states.alarm, 0, 'l alarme du siege n est pas dans la region');
  });
});

describe('disponibilite d un groupe : honnete', () => {
  // 30 jours avant NOW (15 juin 2026) : les 10 et 11 juin sont dans la fenetre.
  it('ponderee par le temps observe, et un site non mesure ne compte PAS comme 100 %', () => {
    const db = world();
    addGroup(db, 'Banque', 'grp', 'Groupe test', null, NOW);
    // A : 10 jours observes, jamais en panne. B : 2 h observees dont 1 h en panne. C : jamais mesure. D : jamais rien envoye.
    addSiteTo(db, { id: 'site-a', group: 'grp', summary: ok(), days: [['2026-06-10', 864_000, 0]] });
    addSiteTo(db, { id: 'site-b', group: 'grp', summary: ok(), days: [['2026-06-14', 3600, 3600]] });
    addSiteTo(db, { id: 'site-c', group: 'grp', summary: ok(), days: [] });
    addSiteTo(db, { id: 'site-d', group: 'grp' });
    const a = groupByCode(db, 'grp').stats.availability30;
    // (864 000 + 3 600) / (864 000 + 7 200) = 99,5868 % ; moyenne simple des sites 75 % ; en comptant C et D a 100 % : 87,5 %.
    assert.equal(a.pct, 99.59);
    assert.equal(a.measuredSites, 2);
    assert.equal(a.downS, 3600);
    assert.equal(groupByCode(db, 'grp').stats.sites, 4);
  });

  it('seul le mois ecoule compte : un site muet depuis des mois ne presente pas de vieilles mesures comme celles du mois', () => {
    const db = world();
    addGroup(db, 'Banque', 'grp', 'Groupe test', null, NOW);
    addSiteTo(db, { id: 'vieux', group: 'grp', summary: ok(), silentForMs: 90 * 24 * HOUR, days: [['2026-03-01', 3600, 3600]] });
    addSiteTo(db, { id: 'frais', group: 'grp', summary: ok(), days: [['2026-06-14', 7200, 0]] });
    const a = groupByCode(db, 'grp').stats.availability30;
    assert.equal(a.pct, 100);
    assert.equal(a.measuredSites, 1);
    assert.equal(a.downS, 0);
  });

  it('rien d observe : pas de pourcentage', () => {
    const db = world();
    addGroup(db, 'Banque', 'grp', 'Groupe test', null, NOW);
    addSiteTo(db, { id: 'site-a', group: 'grp', summary: ok(), days: [] });
    assert.equal(groupByCode(db, 'grp').stats.availability30.pct, null);
  });
});

describe('sites muets', () => {
  it('un site qui ne parle plus est compte et nomme a part, jamais range parmi les bons', () => {
    const db = world();
    addGroup(db, 'Banque', 'grp', 'Groupe test', null, NOW);
    addSiteTo(db, { id: 'vivant', group: 'grp', summary: ok() });
    addSiteTo(db, { id: 'muet-1h', group: 'grp', summary: ok(), silentForMs: HOUR });
    addSiteTo(db, { id: 'muet-5h', group: 'grp', summary: ok(), silentForMs: 5 * HOUR });
    addSiteTo(db, { id: 'jamais', group: 'grp' });
    const s = groupByCode(db, 'grp').stats;
    assert.equal(s.silent.count, 2);
    assert.deepEqual(s.silent.sites.map((x) => x.id), ['muet-5h', 'muet-1h'], 'le silence le plus long d abord');
    assert.equal(s.neverSeen, 1);
    assert.equal(s.states.ok, 1);
    assert.equal(s.states.unreachable, 2);
    assert.equal(s.worstLevel, 'unreachable');
  });

  it('au seuil exact un site parle encore ; une seconde de plus et il est muet', () => {
    const db = world();
    addGroup(db, 'Banque', 'grp', 'Groupe test', null, NOW);
    addSiteTo(db, { id: 'pile', group: 'grp', summary: ok(), silentForMs: STALE });
    addSiteTo(db, { id: 'juste-apres', group: 'grp', summary: ok(), silentForMs: STALE + 1000 });
    const s = groupByCode(db, 'grp').stats;
    assert.deepEqual(s.silent.sites.map((x) => x.id), ['juste-apres']);
  });

  it('les incidents ouverts d un site muet sont comptes a part (dernier etat connu), pas melanges aux incidents confirmes', () => {
    const db = world();
    addGroup(db, 'Banque', 'grp', 'Groupe test', null, NOW);
    addSiteTo(db, { id: 'vivant-alarme', group: 'grp', summary: alarm() });
    addSiteTo(db, { id: 'muet-alarme', group: 'grp', summary: alarm(), silentForMs: 4 * HOUR });
    const i = groupByCode(db, 'grp').stats.incidents;
    assert.equal(i.open, 1);
    assert.equal(i.openUnverified, 1);
  });

  it('un site muet garde son dernier indice connu dans la moyenne, et le groupe le dit', () => {
    const db = world();
    addGroup(db, 'Banque', 'grp', 'Groupe test', null, NOW);
    addSiteTo(db, { id: 'vivant', group: 'grp', summary: ok(), risk: 10 });
    addSiteTo(db, { id: 'muet', group: 'grp', summary: ok(), risk: 30, silentForMs: 5 * HOUR });
    const r = groupByCode(db, 'grp').stats.risk;
    assert.equal(r.mean, 20);
    assert.equal(r.fromSilentSites, 1);
    assert.equal(r.worst?.stale, true);
  });
});

describe('indice de securite GAMR agrege', () => {
  it('moyenne et pire site ; les sites sans indice sont comptes a part, pas comptes comme 0', () => {
    const db = world();
    addGroup(db, 'Banque', 'grp', 'Groupe test', null, NOW);
    addSiteTo(db, { id: 'bas', group: 'grp', summary: ok(), risk: 10 });
    addSiteTo(db, { id: 'moyen', group: 'grp', summary: ok(), risk: 30 });
    addSiteTo(db, { id: 'haut', group: 'grp', summary: ok(), risk: 50 });
    addSiteTo(db, { id: 'non-evalue', group: 'grp', summary: ok(), risk: null });
    addSiteTo(db, { id: 'jamais', group: 'grp' });
    const r = groupByCode(db, 'grp').stats.risk;
    assert.equal(r.scoredSites, 3);
    assert.equal(r.unscoredSites, 2);
    assert.equal(r.mean, 30);
    assert.equal(r.meanLevel, 'eleve');
    assert.equal(r.worst?.siteId, 'haut');
    assert.equal(r.worst?.index, 50);
    assert.equal(r.worst?.levelLabel, 'Critique');
    assert.equal(r.worst?.worstZone, 'Zone A');
  });

  it('une moyenne a decimale est arrondie au dixieme et nommee par les seuils du PSIM', () => {
    const db = world();
    addGroup(db, 'Banque', 'grp', 'Groupe test', null, NOW);
    addSiteTo(db, { id: 'site-a', group: 'grp', summary: ok(), risk: 8 });
    addSiteTo(db, { id: 'site-b', group: 'grp', summary: ok(), risk: 9 });
    addSiteTo(db, { id: 'site-c', group: 'grp', summary: ok(), risk: 9 });
    const r = groupByCode(db, 'grp').stats.risk;
    assert.equal(r.mean, 8.7);
    assert.equal(r.meanLevel, 'modere', '8,7 arrondi a 9 : modere (faible <= 8)');
  });

  it('aucun site evalue : ni moyenne ni pire site', () => {
    const db = world();
    addGroup(db, 'Banque', 'grp', 'Groupe test', null, NOW);
    addSiteTo(db, { id: 'site-a', group: 'grp', summary: ok(), risk: null });
    const r = groupByCode(db, 'grp').stats.risk;
    assert.equal(r.mean, null);
    assert.equal(r.worst, null);
  });
});

describe('modules du navigateur', () => {
  it('chaque module de portal/web a une syntaxe valide (app.js ne peut pas etre charge hors navigateur)', async () => {
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    for (const file of ['app.js', 'groups.js', 'ui.js', 'gauge.js', 'charts.js']) {
      const r = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(`../../portal/web/${file}`, import.meta.url))], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${file} : ${r.stderr}`);
    }
  });

  it('groups.js se charge et fournit les ecrans de groupe', async () => {
    // @ts-ignore module du navigateur sans declaration de types
    const groups = await import('../../portal/web/groups.js');
    for (const name of ['groupHref', 'orgHref', 'crumbs', 'orgTrail', 'soloGroupId', 'clientsPage', 'orgPage', 'groupPage', 'railTree']) assert.equal(typeof groups[name], 'function', name);
    assert.equal(groups.groupHref(7), '#/group/7');
    assert.equal(groups.orgHref(3, true), '#/org/3');
    assert.equal(groups.orgHref(3, false), '#/');
    const one = { scoped: true, organizations: [{ groups: [{ id: 5 }], ungrouped: null }] };
    assert.equal(groups.soloGroupId(one), 5, 'un directeur regional a un seul groupe arrive sur ce groupe');
    assert.equal(groups.soloGroupId({ ...one, scoped: false }), null, 'un compte non limite n est pas redirige');
    assert.equal(groups.soloGroupId({ scoped: true, organizations: [{ groups: [{ id: 5 }], ungrouped: { siteIds: ['x'] } }] }), null);
  });
});

describe('categories energie et personnes', () => {
  /** Un resume dont les incidents ouverts sont d une categorie donnee (le PSIM de l'etape 2 en envoie de ces categories). */
  function withOpen(category: 'energy' | 'people' | 'fire', severity: 'warning' | 'critical' = 'critical'): SiteSummary {
    const s = structuredClone(alarm());
    for (const i of s.incidents) {
      i.category = category;
      i.severity = severity;
    }
    for (const d of s.devices) if (s.incidents.some((i) => i.deviceId === d.id)) d.category = category;
    return s;
  }

  it('le portail accepte ces categories a la reception et les conserve', () => {
    for (const category of ['energy', 'people'] as const) {
      const parsed = parseSummary(JSON.parse(JSON.stringify(withOpen(category))));
      assert.equal(parsed.ok, true, category);
      if (parsed.ok) assert.ok(parsed.summary.incidents.every((i) => i.category === category));
    }
    assert.equal(parseSummary({ ...JSON.parse(JSON.stringify(withOpen('energy'))), incidents: [{ ...withOpen('energy').incidents[0], category: 'inconnue' }] }).ok, false, 'une categorie inconnue reste refusee');
  });

  it('les incidents ouverts du groupe sont ventiles par categorie, energie et personnes comprises', () => {
    const db = world();
    addGroup(db, 'Banque', 'grp', 'Groupe test', null, NOW);
    addSiteTo(db, { id: 'courant', group: 'grp', summary: withOpen('energy') });
    addSiteTo(db, { id: 'detresse', group: 'grp', summary: withOpen('people') });
    addSiteTo(db, { id: 'feu', group: 'grp', summary: withOpen('fire', 'warning') });
    const i = groupByCode(db, 'grp').stats.incidents;
    assert.deepEqual(i.openByCategory, { energy: 1, people: 1, fire: 1 });
    assert.equal(i.open, 3);
    assert.equal(i.openCritical, 2);
  });

  it('l etat du site nomme la categorie (alerte energie, alerte personne)', () => {
    const energy = withOpen('energy', 'warning');
    const st = siteStatus(energy, NOW, NOW, STALE);
    assert.equal(st.level, 'alarm');
    assert.equal(st.label, 'Alerte en cours');
    // Une fois traite, l incident recent porte le mot de sa categorie.
    const handled = structuredClone(energy);
    for (const i of handled.incidents) Object.assign(i, { status: 'closed', closedAt: NOW - HOUR, ackedAt: NOW - HOUR + 1000, qualification: 'fire' });
    assert.match(siteStatus(handled, NOW, NOW, STALE).label, /^Alerte énergie /);
    const people = structuredClone(handled);
    for (const i of people.incidents) i.category = 'people';
    assert.match(siteStatus(people, NOW, NOW, STALE).label, /^Alerte personne /);
  });

  it('l interface a un libelle, une icone et une qualification pour ces categories', async () => {
    assert.equal(CATEGORY.energy.label, 'Énergie');
    assert.equal(CATEGORY.people.label, 'Personnes');
    const { readFileSync } = await import('node:fs');
    const sprite = readFileSync(new URL('../../portal/web/icons.svg', import.meta.url), 'utf8');
    for (const c of Object.values(CATEGORY) as { icon: string }[]) assert.match(sprite, new RegExp(`id="${c.icon}"`), `icone ${c.icon}`);
    assert.equal(qualificationLabel('energy', 'fire'), 'Panne avérée');
    assert.equal(qualificationLabel('people', 'fire'), 'Détresse avérée');
    assert.equal(qualificationLabel('people', 'false_alarm'), 'Fausse alarme');
  });
});
