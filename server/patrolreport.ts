import type { DatabaseSync } from 'node:sqlite';
import type { Express, RequestHandler, Request, Response } from 'express';
import { EARLY_SCAN_MS } from './patrolmachine.ts';
import { dayString, esc, MAX_CSV_ROWS, parseRange, toCsv } from './reports.ts';
import type { Range, Reports } from './reports.ts';

/**
 * Rapport de rondes (F15 de docs/AGENTS-RONDES.md, lot S4) : taux de rondes faites et de points controles a l'heure,
 * par jour, par circuit et par agent ; export CSV et section « Rondes » du rapport e-mail. Lecture seule : rien ici ne
 * modifie la base, et le module n'a besoin que des tables du contrat (`patrol_run`, `patrol_route`, `patrol_scan`,
 * `agent_profile`) — il ne depend pas de server/patrols.ts, ce qui lui permet de lire une base sans l'application des
 * agents (rapport vide) sans jamais planter.
 *
 * Definitions (une seule, partagee par l'ecran, le CSV et l'e-mail) :
 *  - une ronde est rattachee a la periode par son `due_start` (heure locale du serveur, comme le reste de reports.ts) :
 *    une ronde de 22 h a 2 h du matin appartient au JOUR de 22 h ;
 *  - `done`, `incomplete`, `missed` : ses statuts finaux ; `pending` regroupe `pending` et `active` (a venir ou en cours) :
 *    ces rondes comptent dans `planned` mais jamais dans les taux ;
 *  - `doneRate` = done / (done + incomplete + missed), null si aucune ronde n'est echue ;
 *  - `expectedPoints` = points du circuit pour chaque ronde echue ; `onTimePoints` = points de ces rondes qui ont un
 *    passage `ok` dont l'HEURE EFFECTIVE tombe dans `[due_start - 15 min ; due_end]`. L'heure effective est celle que
 *    la machine des rondes utilise pour la meme fenetre : l'heure du telephone si le passage a ete recu en differe,
 *    sinon celle du serveur. Un point scanne pendant le delai de grace (ronde `incomplete`) est valide pour la ronde
 *    mais n'est PAS « a l'heure » ;
 *  - l'agent d'une ronde est `started_by` (premier passage valide) ; une ronde sans agent est rattachee a « (personne) »
 *    dans `rows` et ecartee de `byAgent`.
 */

export const NO_AGENT = '(personne)';

/** Compteurs communs a tous les agregats. */
export interface PatrolCounters {
  planned: number;
  done: number;
  incomplete: number;
  missed: number;
  /** A venir ou en cours : exclues des taux. */
  pending: number;
  expectedPoints: number;
  onTimePoints: number;
  /** Part des points attendus controles a l'heure (null si aucun point attendu). */
  onTimeRate: number | null;
  /** done / rondes echues (null si aucune n'est echue). */
  doneRate: number | null;
}

export interface PatrolDayStats extends PatrolCounters {
  day: string;
}
export interface PatrolRouteStats extends PatrolCounters {
  routeId: number;
  name: string;
  archived: boolean;
}
export interface PatrolAgentStats extends PatrolCounters {
  username: string;
  name: string;
}
export interface PatrolRow extends PatrolCounters {
  day: string;
  routeId: number;
  route: string;
  /** null : ronde sans agent. */
  username: string | null;
  agent: string;
}

export interface PatrolReport {
  from: string;
  to: string;
  fromDay: string;
  toDay: string;
  /** Heure d'etablissement (ms epoch). */
  generatedAt: number;
  totals: PatrolCounters;
  byDay: PatrolDayStats[];
  byRoute: PatrolRouteStats[];
  byAgent: PatrolAgentStats[];
  rows: PatrolRow[];
}

type Row = Record<string, unknown>;
type Acc = Pick<PatrolCounters, 'planned' | 'done' | 'incomplete' | 'missed' | 'pending' | 'expectedPoints' | 'onTimePoints'>;

const blank = (): Acc => ({ planned: 0, done: 0, incomplete: 0, missed: 0, pending: 0, expectedPoints: 0, onTimePoints: 0 });

function finish(a: Acc): PatrolCounters {
  const due = a.done + a.incomplete + a.missed;
  return { ...a, onTimeRate: a.expectedPoints === 0 ? null : a.onTimePoints / a.expectedPoints, doneRate: due === 0 ? null : a.done / due };
}

const byName = (a: string, b: string) => a.localeCompare(b, 'fr');
const percent = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)} %`);
/** Pourcentage pour un CSV francais : une decimale au plus, virgule decimale (« 87,5 »), vide si inconnu. */
const csvPercent = (r: number | null) => (r === null ? '' : String(Math.round(r * 1000) / 10).replace('.', ','));

/** Identifiants de points d'un circuit lus dans le JSON de la base (jamais de confiance : une valeur invalide est ecartee). */
function pointsOf(json: unknown): number[] {
  try {
    const parsed: unknown = JSON.parse(String(json ?? '[]'));
    return Array.isArray(parsed) ? [...new Set(parsed.filter((n): n is number => Number.isSafeInteger(n)))] : [];
  } catch {
    return [];
  }
}

export function createPatrolReport(deps: { db: DatabaseSync; now?: () => number }) {
  const { db } = deps;
  const now = deps.now ?? Date.now;

  const hasTable = (name: string): boolean => db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  const hasPatrolTables = (): boolean => hasTable('patrol_route') && hasTable('patrol_run') && hasTable('patrol_scan');

  /** Y a-t-il au moins un circuit (non archive) ? Faux sans l'application des agents. */
  function hasRoutes(): boolean {
    try {
      return hasTable('patrol_route') && db.prepare('SELECT 1 AS x FROM patrol_route WHERE archived_at IS NULL LIMIT 1').get() !== undefined;
    } catch {
      return false;
    }
  }

  function build(range: Range): PatrolReport {
    const head = { from: range.fromDay, to: range.toDay, fromDay: range.fromDay, toDay: range.toDay, generatedAt: now() };
    const empty = (): PatrolReport => ({ ...head, totals: finish(blank()), byDay: [], byRoute: [], byAgent: [], rows: [] });
    if (!hasPatrolTables()) return empty();

    const profiles = hasTable('agent_profile');
    const runs = db
      .prepare(
        `SELECT r.id, r.route_id, r.due_start, r.due_end, r.status, r.started_by,
                pr.name AS route_name, pr.checkpoints AS route_points, pr.archived_at AS route_archived
                ${profiles ? ', ap.display_name AS agent_name' : ''}
           FROM patrol_run r
           LEFT JOIN patrol_route pr ON pr.id = r.route_id
           ${profiles ? 'LEFT JOIN agent_profile ap ON ap.username = r.started_by' : ''}
          WHERE r.due_start >= ? AND r.due_start < ?
          ORDER BY r.due_start, r.id`,
      )
      .all(range.from, range.to) as Row[];

    // Passages `ok` des rondes de la periode, a l'heure effective (telephone si recu en differe, sinon serveur).
    const okByRun = new Map<number, Map<number, number>>();
    const scans = db
      .prepare(
        `SELECT s.run_id, s.checkpoint_id, CASE WHEN s.deferred = 1 THEN s.phone_at ELSE s.server_at END AS at
           FROM patrol_scan s JOIN patrol_run r ON r.id = s.run_id
          WHERE r.due_start >= ? AND r.due_start < ? AND s.verdict = 'ok'`,
      )
      .all(range.from, range.to) as Row[];
    for (const s of scans) {
      const runId = s.run_id as number;
      let list = okByRun.get(runId);
      if (!list) okByRun.set(runId, (list = new Map()));
      const cp = s.checkpoint_id as number;
      const t = s.at as number;
      // Un point scanne plusieurs fois (rondes qui se chevauchent) : le passage le plus ancien compte.
      if (!list.has(cp) || t < list.get(cp)!) list.set(cp, t);
    }

    const totals = blank();
    const days = new Map<string, Acc>();
    const routes = new Map<number, { acc: Acc; name: string; archived: boolean }>();
    const agents = new Map<string, { acc: Acc; name: string }>();
    const rows = new Map<string, { acc: Acc; day: string; routeId: number; route: string; username: string | null; agent: string }>();
    const slot = <K, V>(map: Map<K, V>, key: K, make: () => V): V => {
      let v = map.get(key);
      if (v === undefined) map.set(key, (v = make()));
      return v;
    };

    for (const r of runs) {
      const status = r.status as string;
      if (status !== 'pending' && status !== 'active' && status !== 'done' && status !== 'incomplete' && status !== 'missed') continue;
      const dueStart = r.due_start as number;
      const dueEnd = r.due_end as number;
      const routeId = r.route_id as number;
      const routeName = typeof r.route_name === 'string' && r.route_name.trim() !== '' ? (r.route_name as string) : `Circuit n°${routeId}`;
      const username = typeof r.started_by === 'string' && r.started_by !== '' ? (r.started_by as string) : null;
      const agentName = username === null ? NO_AGENT : typeof r.agent_name === 'string' && r.agent_name.trim() !== '' ? (r.agent_name as string) : username;
      const day = dayString(dueStart);

      const passes = okByRun.get(r.id as number) ?? new Map<number, number>();
      const due = status === 'done' || status === 'incomplete' || status === 'missed';
      // Points attendus : ceux du circuit (a defaut de circuit connu, ceux de la ronde elle-meme).
      const expectedSet = r.route_name === null && r.route_points === null ? [...passes.keys()] : pointsOf(r.route_points);
      let expected = 0;
      let onTime = 0;
      if (due) {
        expected = expectedSet.length;
        for (const cp of expectedSet) {
          const t = passes.get(cp);
          if (t !== undefined && t >= dueStart - EARLY_SCAN_MS && t <= dueEnd) onTime++;
        }
      }

      const targets: Acc[] = [
        totals,
        slot(days, day, blank),
        slot(routes, routeId, () => ({ acc: blank(), name: routeName, archived: r.route_archived !== null && r.route_archived !== undefined })).acc,
        slot(rows, `${day}\u0000${routeId}\u0000${username ?? ''}`, () => ({ acc: blank(), day, routeId, route: routeName, username, agent: agentName })).acc,
      ];
      if (username !== null) targets.push(slot(agents, username, () => ({ acc: blank(), name: agentName })).acc);
      for (const a of targets) {
        a.planned++;
        if (status === 'pending' || status === 'active') a.pending++;
        else a[status]++;
        a.expectedPoints += expected;
        a.onTimePoints += onTime;
      }
    }

    return {
      ...head,
      totals: finish(totals),
      byDay: [...days].map(([day, acc]) => ({ day, ...finish(acc) })).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
      byRoute: [...routes].map(([routeId, v]) => ({ routeId, name: v.name, archived: v.archived, ...finish(v.acc) })).sort((a, b) => byName(a.name, b.name) || a.routeId - b.routeId),
      byAgent: [...agents].map(([username, v]) => ({ username, name: v.name, ...finish(v.acc) })).sort((a, b) => byName(a.name, b.name) || byName(a.username, b.username)),
      rows: [...rows.values()]
        .map(({ acc, ...key }) => ({ ...key, ...finish(acc) }))
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || byName(a.route, b.route) || a.routeId - b.routeId || byName(a.agent, b.agent)),
    };
  }

  /** CSV pour Excel en francais (voir `toCsv`) : une ligne par jour, circuit et agent. */
  function csv(report: PatrolReport): string {
    return toCsv(
      ['Jour', 'Circuit', 'Agent', 'Rondes prévues', 'Faites', 'Incomplètes', 'Non faites', 'À venir ou en cours', 'Points attendus', 'Points à l’heure', 'Taux à l’heure (%)'],
      report.rows.slice(0, MAX_CSV_ROWS).map((r) => [r.day, r.route, r.agent, r.planned, r.done, r.incomplete, r.missed, r.pending, r.expectedPoints, r.onTimePoints, csvPercent(r.onTimeRate)]),
    );
  }

  /** Section « Rondes » du rapport imprimable et du rapport e-mail (classes du rapport existant, aucun style ni script). */
  /** Section du rapport e-mail : totaux par jour et par circuit SEULEMENT (la performance individuelle reste a l'ecran et au CSV). */
  function sectionHtml(report: PatrolReport): string {
    const t = report.totals;
    const stat = (label: string, value: string, note = '') => `<div class="stat"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div>${note ? `<div class="n">${esc(note)}</div>` : ''}</div>`;
    const table = (head: string[], body: string[][]) =>
      `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    const cells = (c: PatrolCounters) => [String(c.planned), String(c.done), String(c.incomplete), String(c.missed), String(c.pending), esc(percent(c.doneRate)), esc(percent(c.onTimeRate))];
    const head = ['Rondes prévues', 'Faites', 'Incomplètes', 'Non faites', 'À venir ou en cours', 'Taux de rondes faites', 'Points à l’heure'];
    return `<h2>Rondes</h2>
<section class="stats">
${stat('Rondes prévues', String(t.planned), t.pending > 0 ? `dont ${t.pending} à venir ou en cours` : '')}
${stat('Faites', String(t.done), `taux : ${percent(t.doneRate)} des rondes échues`)}
${stat('Incomplètes', String(t.incomplete))}
${stat('Non faites', String(t.missed))}
${stat('Points contrôlés à l’heure', percent(t.onTimeRate), `${t.onTimePoints} sur ${t.expectedPoints} points attendus`)}
</section>
${
  t.planned === 0
    ? '<p class="empty">Aucune ronde prévue sur cette période.</p>'
    : `<div class="cols"><div><h2>Rondes par circuit</h2>${table(['Circuit', ...head], report.byRoute.map((r) => [esc(r.name), ...cells(r)]))}</div>
<div><h2>Rondes par jour</h2>${table(['Jour', ...head], report.byDay.map((d) => [esc(d.day), ...cells(d)]))}</div></div>`
}`;
  }

  return { hasRoutes, build, csv, sectionHtml };
}

export type PatrolReportService = ReturnType<typeof createPatrolReport>;

export interface PatrolReportMount {
  reports: Pick<Reports, 'addSection'>;
  report: PatrolReportService;
  /** Administrateur ou operateur (401 / 403 sinon). */
  staff: RequestHandler;
  /** Journal d'audit (`engine.audit`). */
  audit: (actor: string, action: string, ref?: { incidentId?: number; deviceId?: string; details?: string }) => void;
  actorOf: (req: Request) => string;
  now?: () => number;
}

/**
 * Monte `GET /api/patrols/report` (JSON) et `/api/patrols/report.csv`, et enregistre la section « Rondes » du rapport
 * d'incidents. A appeler AVANT le 404 de `/api`. La lecture est journalisee (`patrol_history_read`) : un rapport par agent
 * expose la performance individuelle.
 */
export function mountPatrolReport(app: Express, deps: PatrolReportMount): void {
  const { reports, report, staff, audit, actorOf } = deps;
  const now = deps.now ?? Date.now;

  const noStore = (res: Response): void => void res.setHeader('Cache-Control', 'no-store');

  app.get('/api/patrols/report', staff, (req, res) => {
    const range = parseRange(req.query, now());
    audit(actorOf(req), 'patrol_history_read', { details: `rapport de rondes du ${range.fromDay} au ${range.toDay}` });
    noStore(res);
    res.json(report.build(range));
  });
  app.get('/api/patrols/report.csv', staff, (req, res) => {
    const range = parseRange(req.query, now());
    audit(actorOf(req), 'patrol_history_read', { details: `export CSV du rapport de rondes du ${range.fromDay} au ${range.toDay}` });
    const csv = report.csv(report.build(range));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="patrouilles_${range.fromDay}_${range.toDay}.csv"`);
    noStore(res);
    res.send(csv);
  });

  reports.addSection((range) => {
    // Un rapport filtre sur une categorie d'equipements autre que « personnes » ne parle pas des rondes.
    if (range.category !== null && range.category !== 'people') return null;
    const built = report.build(range);
    return report.hasRoutes() || built.totals.planned > 0 ? report.sectionHtml(built) : null;
  });
}
