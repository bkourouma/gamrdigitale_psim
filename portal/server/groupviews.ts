/**
 * Vues « direction » : organisation -> groupes (regions, agences) -> sites.
 *
 * Toutes les fonctions partent du COMPTE (jamais d'un parametre du navigateur) : les sites et les groupes viennent de
 * `visibleSites` / `visibleGroups` (accounts.ts), qui appliquent le perimetre du compte a chaque appel. Un total, une moyenne
 * ou un classement ne contient donc jamais un site hors perimetre : on n'agrege que ce qu'on a le droit de montrer.
 *
 * Regle d'honnetete (celle de views.ts) : on ne conclut jamais « normal » faute de savoir.
 *  - la disponibilite d'un groupe est le temps en service ÷ le temps observe, sites mesures seulement ; un site non mesure
 *    ne compte PAS comme 100 %. Rien de mesure : pas de pourcentage. On dit sur combien de sites elle repose ;
 *  - un site muet (plus de resume recent) ou qui n'a jamais rien envoye est compte et nomme a part, pas range dans « bon etat » ;
 *  - les incidents encore ouverts d'un site muet sont le DERNIER etat connu : comptes a part, jamais melanges aux autres ;
 *  - un groupe vide n'a ni etat ni indice : « aucun site », pas « tout va bien ».
 */
import type { DatabaseSync } from 'node:sqlite';
import type { SiteSummary } from '../../server/portal.ts';
import { levelOf } from '../../server/risklevels.ts';
import type { RiskLevel } from '../../server/risklevels.ts';
import { visibleGroup, visibleGroups, visibleSites } from './accounts.ts';
import type { GroupRow, Principal, VisibleSite } from './accounts.ts';
import { DAY_MS, SEVERITY_ORDER, availabilityOfDays, incidentRows, incidentStats, loadSummary, recentDays, siteCard } from './views.ts';
import type { IncidentStats, Level } from './views.ts';

type SiteCard = ReturnType<typeof siteCard>;

/** Un site avec tout ce dont l'agregation a besoin (lu une seule fois). */
interface Fact {
  site: VisibleSite;
  card: SiteCard;
  summary: SiteSummary | null;
  days: ReturnType<typeof recentDays>;
  incidents: ReturnType<typeof incidentRows>;
}

export interface GroupStats {
  /** Sites actifs du groupe (sous-groupes compris). */
  sites: number;
  /** Nombre de sites par etat (les memes etats que sur la fiche d'un site). */
  states: Record<Level, number>;
  /** Le pire etat parmi les sites ; `null` si le groupe n'a aucun site. */
  worstLevel: Level | null;
  /** Sites muets : ils ont deja envoye, mais plus rien depuis trop longtemps. Les plus anciens silences d'abord. */
  silent: { count: number; sites: { id: string; name: string; lastReceivedAt: number }[] };
  /** Sites qui n'ont jamais rien envoye. */
  neverSeen: number;
  /** Sites qui envoient mais ne mesurent encore aucun equipement. */
  unmeasured: number;
  availability30: { pct: number | null; downS: number; unmonitoredS: number; measuredSites: number };
  devicesDown: number;
  incidents: {
    /** En cours sur les sites qui repondent. */
    open: number;
    openCritical: number;
    openByCategory: Record<string, number>;
    /** En cours d'apres le DERNIER etat connu de sites muets : a verifier, pas confirmes. */
    openUnverified: number;
    last30: IncidentStats;
  };
  /**
   * Controle d'acces (F28), comptes seulement. `sites`, `doors`, `offline`, `fault` : sites qui repondent et qui transmettent
   * leurs portes. `unverifiedDown` : portes hors ligne ou en defaut d'apres le DERNIER etat connu de sites muets (a verifier,
   * comptees a part, comme les incidents).
   */
  access: { sites: number; doors: number; offline: number; fault: number; unverifiedDown: number };
  risk: {
    scoredSites: number;
    /** Sites sans indice (zones non evaluees, ou indice non transmis). */
    unscoredSites: number;
    /** Moyenne des indices connus (une decimale), `null` si aucun. Les sites muets y comptent avec leur dernier indice connu. */
    mean: number | null;
    meanLevel: RiskLevel | null;
    meanLevelLabel: string | null;
    worst: { siteId: string; siteName: string; index: number; level: RiskLevel | null; levelLabel: string | null; worstZone: string | null; at: number; stale: boolean } | null;
    fromSilentSites: number;
  };
  lastReceivedAt: number | null;
}

const LEVELS: Level[] = ['alarm', 'unreachable', 'degraded', 'recent', 'unknown', 'ok'];
const SILENT_LIST_MAX = 50;

export function statsOf(facts: Fact[], now: number): GroupStats {
  const states = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>;
  for (const f of facts) states[f.card.status.level]++;
  const worstLevel = facts.length === 0 ? null : LEVELS.reduce<Level | null>((w, l) => (states[l] > 0 && (w === null || SEVERITY_ORDER[l] < SEVERITY_ORDER[w]) ? l : w), null);

  const silent = facts.filter((f) => f.card.status.level === 'unreachable' && f.card.lastReceivedAt !== null).sort((a, b) => a.card.lastReceivedAt! - b.card.lastReceivedAt!);

  const rows = facts.flatMap((f) => f.days);
  const avail = availabilityOfDays(rows);
  const measured = facts.filter((f) => f.days.some((d) => d.up_s + d.down_s > 0)).length;

  const reachable = facts.filter((f) => f.card.status.level !== 'unreachable');
  const openOf = (f: Fact) => f.summary?.incidents.filter((i) => i.status !== 'closed') ?? [];
  const openByCategory: Record<string, number> = {};
  let open = 0;
  let openCritical = 0;
  for (const f of reachable)
    for (const i of openOf(f)) {
      open++;
      if (i.severity === 'critical') openCritical++;
      openByCategory[i.category] = (openByCategory[i.category] ?? 0) + 1;
    }
  const openUnverified = facts.filter((f) => f.card.status.level === 'unreachable').reduce((n, f) => n + openOf(f).length, 0);

  const doorSites = reachable.filter((f) => f.summary?.access);
  const doorsDownOf = (f: Fact) => (f.summary?.access?.states.offline ?? 0) + (f.summary?.access?.states.fault ?? 0);

  const since = now - 30 * DAY_MS;
  const incidents30 = facts.flatMap((f) => f.incidents.filter((r) => r.opened_at >= since));

  const scored = facts.filter((f) => f.card.risk?.index != null);
  const sum = scored.reduce((s, f) => s + f.card.risk!.index!, 0);
  const mean = scored.length === 0 ? null : Math.round((sum / scored.length) * 10) / 10;
  const named = mean === null ? null : levelOf(Math.round(mean));
  // Le site le plus expose : indice le plus haut ; a egalite, le nom (l'ordre ne depend pas de l'ordre de lecture).
  const worst = scored.reduce<Fact | null>((w, f) => (w === null || f.card.risk!.index! > w.card.risk!.index! || (f.card.risk!.index === w.card.risk!.index && f.card.name.localeCompare(w.card.name, 'fr') < 0) ? f : w), null);

  return {
    sites: facts.length,
    states,
    worstLevel,
    silent: { count: silent.length, sites: silent.slice(0, SILENT_LIST_MAX).map((f) => ({ id: f.card.id, name: f.card.name, lastReceivedAt: f.card.lastReceivedAt! })) },
    neverSeen: facts.filter((f) => f.card.lastReceivedAt === null).length,
    unmeasured: facts.filter((f) => f.card.status.level === 'unknown' && f.card.lastReceivedAt !== null).length,
    availability30: { pct: avail.pct, downS: avail.downS, unmonitoredS: avail.unmonitoredS, measuredSites: measured },
    devicesDown: reachable.reduce((n, f) => n + f.card.devicesDown, 0),
    incidents: { open, openCritical, openByCategory, openUnverified, last30: incidentStats(incidents30) },
    access: {
      sites: doorSites.length,
      doors: doorSites.reduce((n, f) => n + f.summary!.access!.doors, 0),
      offline: doorSites.reduce((n, f) => n + f.summary!.access!.states.offline, 0),
      fault: doorSites.reduce((n, f) => n + f.summary!.access!.states.fault, 0),
      unverifiedDown: facts.filter((f) => f.card.status.level === 'unreachable').reduce((n, f) => n + doorsDownOf(f), 0),
    },
    risk: {
      scoredSites: scored.length,
      unscoredSites: facts.length - scored.length,
      mean,
      meanLevel: named?.level ?? null,
      meanLevelLabel: named?.label ?? null,
      worst: worst ? { siteId: worst.card.id, siteName: worst.card.name, index: worst.card.risk!.index!, level: worst.card.risk!.level, levelLabel: worst.card.risk!.levelLabel, worstZone: worst.card.risk!.worstZone, at: worst.card.risk!.at, stale: worst.card.status.level === 'unreachable' } : null,
      fromSilentSites: scored.filter((f) => f.card.status.level === 'unreachable').length,
    },
    lastReceivedAt: facts.reduce<number | null>((m, f) => (f.card.lastReceivedAt !== null && (m === null || f.card.lastReceivedAt > m) ? f.card.lastReceivedAt : m), null),
  };
}

export interface GroupCard {
  id: number;
  code: string;
  name: string;
  /** 0 : groupe, 1 : sous-groupe. */
  depth: 0 | 1;
  /** Le parent, seulement s'il est lui-meme visible par ce compte. */
  parentId: number | null;
  organizationId: number;
  stats: GroupStats;
  /** Les sites rattaches directement a ce groupe (les autres sont dans ses sous-groupes). */
  siteIds: string[];
  children: GroupCard[];
}

export interface OrganizationNode {
  id: number;
  name: string;
  stats: GroupStats;
  groups: GroupCard[];
  /** Sites de l'organisation qui ne sont dans aucun groupe (et que ce compte a le droit de voir). */
  ungrouped: { stats: GroupStats; siteIds: string[] } | null;
}

/**
 * Du plus preoccupant au plus serein : le pire etat d'un site du groupe d'abord, puis le nombre de sites en alarme, muets, a
 * surveiller, les incidents en cours, l'indice le plus haut ; enfin le nom. Un groupe sans site passe en dernier.
 */
export function worstFirst(a: { stats: GroupStats; name: string }, b: { stats: GroupStats; name: string }): number {
  const order = (s: GroupStats) => (s.worstLevel === null ? 99 : SEVERITY_ORDER[s.worstLevel]);
  return (
    order(a.stats) - order(b.stats) ||
    b.stats.states.alarm - a.stats.states.alarm ||
    b.stats.states.unreachable - a.stats.states.unreachable ||
    b.stats.states.degraded - a.stats.states.degraded ||
    b.stats.incidents.open - a.stats.incidents.open ||
    (b.stats.risk.worst?.index ?? -1) - (a.stats.risk.worst?.index ?? -1) ||
    a.name.localeCompare(b.name, 'fr')
  );
}

function collect(db: DatabaseSync, p: Principal, now: number, staleAfterMs: number): { facts: Fact[]; groups: GroupRow[] } {
  const since = now - 30 * DAY_MS;
  const facts = visibleSites(db, p).map((site): Fact => {
    const snap = loadSummary(db, site.id);
    return { site, card: siteCard(db, site, now, staleAfterMs, snap), summary: snap?.summary ?? null, days: recentDays(db, site.id, 30, now), incidents: incidentRows(db, site.id, since) };
  });
  return { facts, groups: visibleGroups(db, p) };
}

/** Le groupe et sa ligne de parents VISIBLES (le parent d'un compte limite a un sous-groupe reste invisible), racine d'abord. */
function chainOf(byId: Map<number, GroupRow>, id: number | null): GroupRow[] {
  const chain: GroupRow[] = [];
  let cur = id === null ? undefined : byId.get(id);
  // Deux niveaux au plus (garanti par la base) ; la borne protege quand meme d'une base alteree a la main.
  for (let i = 0; cur && i < 4; i++) {
    chain.unshift(cur);
    cur = cur.parent_id === null ? undefined : byId.get(cur.parent_id);
  }
  return chain;
}

function buildTree(facts: Fact[], groups: GroupRow[], now: number) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const direct = new Map<number | null, Fact[]>();
  for (const f of facts) {
    // Un site dont le groupe n'est pas visible n'existe pas pour ce compte : il n'est classe nulle part (ne peut arriver que
    // si la base est alteree ; le filtre des sites suit celui des groupes).
    const key = f.site.group_id;
    if (key !== null && !byId.has(key)) continue;
    direct.set(key, [...(direct.get(key) ?? []), f]);
  }
  const childrenOf = new Map<number, GroupRow[]>();
  for (const g of groups) if (g.parent_id !== null && byId.has(g.parent_id)) childrenOf.set(g.parent_id, [...(childrenOf.get(g.parent_id) ?? []), g]);

  const factsUnder = (g: GroupRow): Fact[] => [...(direct.get(g.id) ?? []), ...(childrenOf.get(g.id) ?? []).flatMap(factsUnder)];
  const cardOf = (g: GroupRow): GroupCard => ({
    id: g.id,
    code: g.code,
    name: g.name,
    depth: g.parent_id !== null && byId.has(g.parent_id) ? 1 : 0,
    parentId: g.parent_id !== null && byId.has(g.parent_id) ? g.parent_id : null,
    organizationId: g.org_id,
    stats: statsOf(factsUnder(g), now),
    siteIds: (direct.get(g.id) ?? []).map((f) => f.site.id),
    children: (childrenOf.get(g.id) ?? []).map(cardOf).sort(worstFirst),
  });
  const roots = groups.filter((g) => g.parent_id === null || !byId.has(g.parent_id));
  return { byId, direct, cardOf, roots };
}

/** Tout ce qu'un compte voit au niveau des groupes : organisations, groupes classes pire-d'abord, sites sans groupe. */
export function groupsOverview(db: DatabaseSync, p: Principal, now: number, staleAfterMs: number) {
  const { facts, groups } = collect(db, p, now, staleAfterMs);
  const { direct, cardOf, roots } = buildTree(facts, groups, now);

  const orgs = new Map<number, string>();
  for (const f of facts) orgs.set(f.site.org_id, f.site.org_name);
  for (const g of groups) orgs.set(g.org_id, g.org_name);

  const organizations: OrganizationNode[] = [...orgs]
    .map(([id, name]) => {
      const mine = facts.filter((f) => f.site.org_id === id);
      const top = roots.filter((g) => g.org_id === id).map(cardOf).sort(worstFirst);
      const loose = (direct.get(null) ?? []).filter((f) => f.site.org_id === id);
      return {
        id,
        name,
        stats: statsOf(mine, now),
        groups: top,
        ungrouped: loose.length > 0 ? { stats: statsOf(loose, now), siteIds: loose.map((f) => f.site.id) } : null,
      };
    })
    .sort(worstFirst);
  return { hasGroups: groups.length > 0, scoped: p.role === 'director' && p.groupScope !== null, organizations, total: statsOf(facts, now) };
}

/** Un groupe : ses chiffres, ses sous-groupes, ses sites (classes pire-d'abord). `null` s'il est hors perimetre ou n'existe pas. */
export function groupDetail(db: DatabaseSync, p: Principal, id: number, now: number, staleAfterMs: number) {
  const group = visibleGroup(db, p, id);
  if (!group) return null;
  const { facts, groups } = collect(db, p, now, staleAfterMs);
  const { byId, direct, cardOf } = buildTree(facts, groups, now);
  const card = cardOf(group);
  const chain = chainOf(byId, group.id);
  const sites = (direct.get(group.id) ?? []).map((f) => ({ ...f.card, groupPath: chain.map((g) => ({ id: g.id, name: g.name })) }));
  sites.sort((a, b) => SEVERITY_ORDER[a.status.level] - SEVERITY_ORDER[b.status.level] || b.openIncidents - a.openIncidents || b.devicesDown - a.devicesDown || (b.risk?.index ?? -1) - (a.risk?.index ?? -1) || a.name.localeCompare(b.name, 'fr'));
  return {
    group: { id: card.id, code: card.code, name: card.name, depth: card.depth, parentId: card.parentId },
    organization: { id: group.org_id, name: group.org_name },
    path: chain.slice(0, -1).map((g) => ({ id: g.id, name: g.name })),
    stats: card.stats,
    children: card.children,
    sites,
  };
}

/** Ajoute a chaque fiche de site le chemin de groupes que ce compte voit (racine d'abord), pour le fil d'Ariane. */
export function withGroupPaths<T extends { groupId: number | null }>(db: DatabaseSync, p: Principal, cards: T[]): (T & { groupPath: { id: number; name: string }[] })[] {
  const byId = new Map(visibleGroups(db, p).map((g) => [g.id, g]));
  return cards.map((c) => ({ ...c, groupPath: chainOf(byId, c.groupId).map((g) => ({ id: g.id, name: g.name })) }));
}

/** Les groupes auxquels le compte est limite (noms), pour lui dire de quoi se compose son perimetre. */
export function scopeOf(db: DatabaseSync, p: Principal): { id: number; name: string }[] {
  if (p.groupScope === null) return [];
  const mine = new Set(p.groupScope);
  return visibleGroups(db, p).filter((g) => mine.has(g.id)).map((g) => ({ id: g.id, name: g.name }));
}
