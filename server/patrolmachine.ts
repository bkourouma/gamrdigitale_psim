import type { Window } from './arming.ts';

/**
 * Machine des rondes (lot S1, contrat docs/AGENTS-RONDES.md, « Machine des rondes »).
 *
 * Machine a etats PURE, sur le modele de `createRuleMachine` (server/rules.ts) : aucune E/S, aucune horloge, aucune
 * dependance a la base ou au moteur. Le temps lui est TOUJOURS donne en argument (ms epoch). Le service
 * (server/patrols.ts) persiste les `PatrolAction` qu'elle renvoie et la reconstruit au demarrage par `load`. C'est ce qui
 * garantit qu'un meme historique rejoue donne les memes decisions.
 *
 * Une machine par circuit. Cycle d'une ronde (« run ») :
 *  - creee `pending` a chaque debut de plage du planning (heure LOCALE du serveur, comme `inSchedule`), echeance
 *    `dueEnd = dueStart + maxMinutes` ;
 *  - premier scan valide : `active` ; tous les points scannes : `done` ;
 *  - a l'echeance : `missed` (rien scanne, evenement `patrol_missed`) ou `incomplete` (evenement `patrol_incomplete`),
 *    puis `missed` (`patrol_missed`) si la ronde n'est pas completee pendant `graceMinutes` ;
 *  - une ronde en alerte (`incomplete`, ou `missed` rattrapee par des scans differes) qui est completee renvoie `clear`.
 *
 * Precisions par rapport au document de conception (S1, section 3.1), signatures inchangees :
 *  1. Creation des runs. La plage creee par un `tick` va de `max(now0 - catchUp, dernier tick + 1, now - borne)` a `now`,
 *     ou `borne = max(catchUp, (maxMinutes + graceMinutes), 24 h)`. Le dernier terme protege d'une avalanche de rondes
 *     « ratees » si l'horloge du serveur saute de plusieurs jours en avant ; 24 h restent rattrapees (une alarme de ronde
 *     ratee pendant un blocage du serveur n'est pas perdue). `catchUpMs` est borne a 31 jours.
 *  2. Scan AVANT le debut d'une ronde (fenetre `dueStart - 15 min`) : la ronde n'existe pas encore (le `tick` ne la cree
 *     qu'a `dueStart`). Le scan la considere quand meme ; s'il est `ok`, la machine la cree (action `create`) avant de la
 *     passer `active`. Un verdict non `ok` sur une ronde pas encore creee renvoie `dueStart: null`. Le `tick` qui atteint
 *     ensuite ce debut ne la recree pas.
 *  3. Fenetre d'un scan : `[dueStart - 15 min, dueEnd]` sur l'heure effective `at` ; prolongee jusqu'a
 *     `dueEnd + grace` (exclu) quand la ronde est `incomplete` ou a deja un point scanne avant `dueEnd` (c'est-a-dire
 *     quand elle serait `incomplete` a l'echeance). Ainsi : un scan non differe pendant la grace est accepte (document),
 *     y compris si le `tick` de l'echeance n'est pas encore passe, et un scan DIFFERE fait pendant la grace l'est aussi.
 *     Un scan non differe n'est jamais accepte par une ronde `missed` ; un scan differe peut la rattraper (document).
 *  4. Plusieurs rondes candidates : le meilleur verdict (`ok` > `duplicate` > `out_of_order` > `out_of_route`), a egalite
 *     la plus ancienne. Le document disait « la plus ancienne » : sans cette precision, un point deja scanne dans une ronde
 *     qui deborde sur la suivante serait refuse (`duplicate`) pour la nouvelle.
 *  5. `clear` : emis quand une ronde en alerte est completee, SAUF si une autre ronde du circuit est encore `incomplete`
 *     (sa pre-alarme doit rester ; son propre achevement ou son passage a `missed` dira la suite), et sauf si la machine a
 *     deja renvoye `clear` depuis la derniere alerte (pas de doublon). `release` renvoie `clear` si une alerte de la machine
 *     n'a pas ete suivie d'un `clear` ; apres `load`, toute ronde chargee `incomplete` ou `missed` compte comme alerte
 *     levee (la machine ne sait pas si l'operateur l'a acquittee : un `clear` en trop est sans danger).
 *  6. `finishedAt` d'une ronde `done` = l'heure du scan le plus tardif (egale a `at` du dernier scan, sauf scans differes
 *     arrives dans le desordre). `startedAt` / `startedBy` = le scan `ok` le plus ancien (un scan differe plus ancien les
 *     corrige, action `status`). `finishedAt` reste `null` pour `incomplete` / `missed`.
 *  7. Un point present en double dans le circuit n'est compte qu'une fois (le service devrait refuser ce cas). Une
 *     specification invalide (aucun point, durees non numeriques...) leve une `RangeError` a la creation.
 *  8. Apres `release`, la machine est inerte : `tick` -> `[]`, `scan` -> `no_run`.
 *  9. Memoire bornee : `tick` oublie les rondes definitivement closes (`done`, `missed`) dont `dueEnd + grace` date de
 *     plus de 48 h (le service refuse deja un scan differe de plus de 24 h ; elles ne peuvent plus changer). Elles restent
 *     en base ; `runs()` ne renvoie que les rondes recentes. Un debut oublie n'est jamais recree.
 */

export type RunStatus = 'pending' | 'active' | 'done' | 'incomplete' | 'missed';
export type ScanVerdict = 'ok' | 'out_of_route' | 'out_of_order' | 'no_run' | 'duplicate';

export interface PatrolSpec {
  routeId: number;
  /** Ids des points de controle, dans l'ordre du circuit. */
  checkpoints: number[];
  ordered: boolean;
  maxMinutes: number;
  graceMinutes: number;
  /** Plages du planning : seule l'heure de DEBUT (`from`) compte, la duree est `maxMinutes`. */
  schedule: Window[];
  /** Comptes agent autorises ; vide = tout agent. */
  agents: string[];
}

export interface RunState {
  dueStart: number;
  dueEnd: number;
  status: RunStatus;
  startedBy: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** Scans `ok` pris en compte (un par point). */
  done: { checkpointId: number; at: number; username: string }[];
}

export type PatrolAction =
  | { kind: 'create'; dueStart: number; dueEnd: number }
  | { kind: 'status'; dueStart: number; status: RunStatus; startedBy: string | null; startedAt: number | null; finishedAt: number | null }
  /** `missed` = ids des points non scannes (ordre du circuit) ; vide pour `clear`. */
  | { kind: 'event'; dueStart: number; event: 'patrol_incomplete' | 'patrol_missed' | 'clear'; missed: number[] };

export interface PatrolScan {
  checkpointId: number;
  username: string;
  /** Heure effective du scan : celle du serveur, ou celle du telephone si `deferred`. */
  at: number;
  deferred: boolean;
}

export interface PatrolScanResult {
  verdict: ScanVerdict;
  /** Ronde concernee (null si `no_run`, ou si la ronde n'existe pas encore et que le scan n'est pas `ok`). */
  dueStart: number | null;
  actions: PatrolAction[];
}

export interface PatrolMachine {
  load(runs: RunState[]): void;
  runs(): RunState[];
  tick(now: number): PatrolAction[];
  scan(now: number, s: PatrolScan): PatrolScanResult;
  release(now: number): PatrolAction[];
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Un scan est accepte jusqu'a 15 min avant le debut de la ronde. */
export const EARLY_SCAN_MS = 15 * MINUTE_MS;
const MAX_CATCH_UP_MS = 31 * DAY_MS;
/** Duree pendant laquelle une ronde close reste en memoire (precision 9). */
const RETAIN_MS = 2 * DAY_MS;
/** Garde-fou de `windowStarts` : au-dela, l'appel est une erreur de programmation. */
const MAX_SPAN_MS = 366 * DAY_MS;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const STATUSES: ReadonlySet<string> = new Set<RunStatus>(['pending', 'active', 'done', 'incomplete', 'missed']);
const RANK: Record<Exclude<ScanVerdict, 'no_run'>, number> = { ok: 4, duplicate: 3, out_of_order: 2, out_of_route: 1 };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Instants de debut de plage (heure LOCALE du serveur) compris dans `[from, to]` (bornes incluses), tries, sans doublon.
 *
 * Pour chaque jour civil local et chaque plage dont `days` contient ce jour (0 = dimanche), l'heure `from` de ce jour.
 * L'heure de fin `to` des plages n'est pas utilisee. Une plage a cheval sur minuit commence le jour de `days`.
 * Les jours sont parcourus par le calendrier (annee, mois, jour), jamais par pas de 24 h : un changement d'heure ne
 * decale ni ne double rien. Une heure qui n'existe pas (passage a l'heure d'ete) est celle que donne `Date` (decalee
 * d'une heure en avant) ; une heure qui existe deux fois (retour a l'heure d'hiver) n'est comptee qu'une fois.
 * Plages mal formees ignorees (le planning est valide par `parseSchedule` a l'enregistrement).
 */
export function windowStarts(schedule: Window[], from: number, to: number): number[] {
  if (!Array.isArray(schedule) || !isNum(from) || !isNum(to) || to < from) return [];
  if (to - from > MAX_SPAN_MS) throw new RangeError('windowStarts : intervalle trop long (366 jours maximum)');
  const plans: { days: Set<number>; hour: number; minute: number }[] = [];
  for (const w of schedule as unknown[]) {
    if (typeof w !== 'object' || w === null) continue;
    const { days, from: start } = w as Partial<Window>;
    const match = typeof start === 'string' ? TIME.exec(start) : null;
    if (!match || !Array.isArray(days)) continue;
    const valid = new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
    if (valid.size === 0) continue;
    plans.push({ days: valid, hour: Number(match[1]), minute: Number(match[2]) });
  }
  if (plans.length === 0) return [];
  const found = new Set<number>();
  const first = new Date(from);
  let y = first.getFullYear();
  let m = first.getMonth();
  let d = first.getDate();
  for (;;) {
    // Minuit peut ne pas exister (fuseaux qui changent d'heure a minuit) : `Date` le decale, la comparaison reste juste.
    if (new Date(y, m, d, 0, 0).getTime() > to) break;
    const weekday = new Date(y, m, d, 12, 0).getDay();
    for (const p of plans) {
      if (!p.days.has(weekday)) continue;
      const ts = new Date(y, m, d, p.hour, p.minute).getTime();
      if (ts >= from && ts <= to) found.add(ts);
    }
    const next = new Date(y, m, d + 1, 12, 0); // midi : jamais touche par un changement d'heure
    y = next.getFullYear();
    m = next.getMonth();
    d = next.getDate();
  }
  return [...found].sort((a, b) => a - b);
}

interface Route {
  checkpoints: number[];
  set: ReadonlySet<number>;
  ordered: boolean;
  maxMs: number;
  graceMs: number;
  schedule: Window[];
  agents: string[];
}

/** Copie defensive et verification de la specification (les donnees viennent de la base : on ne leur fait pas confiance). */
function normalizeSpec(spec: PatrolSpec): Route {
  if (typeof spec !== 'object' || spec === null) throw new RangeError('circuit invalide');
  if (!Array.isArray(spec.checkpoints) || spec.checkpoints.length === 0) throw new RangeError('circuit sans point de controle');
  if (spec.checkpoints.some((id) => !Number.isSafeInteger(id))) throw new RangeError('circuit : identifiant de point invalide');
  if (!isNum(spec.maxMinutes) || spec.maxMinutes <= 0) throw new RangeError('circuit : duree maximale invalide');
  if (!isNum(spec.graceMinutes) || spec.graceMinutes < 0) throw new RangeError('circuit : delai de grace invalide');
  if (!Array.isArray(spec.schedule)) throw new RangeError('circuit : planning invalide');
  if (!Array.isArray(spec.agents) || spec.agents.some((a) => typeof a !== 'string')) throw new RangeError('circuit : liste d\'agents invalide');
  const checkpoints = [...new Set(spec.checkpoints)];
  return {
    checkpoints,
    set: new Set(checkpoints),
    ordered: spec.ordered === true,
    maxMs: spec.maxMinutes * MINUTE_MS,
    graceMs: spec.graceMinutes * MINUTE_MS,
    schedule: spec.schedule.map((w) => (typeof w === 'object' && w !== null ? { ...w, days: Array.isArray(w.days) ? [...w.days] : [] } : w)),
    agents: [...spec.agents],
  };
}

const copyRun = (r: RunState): RunState => ({ ...r, done: r.done.map((x) => ({ ...x })) });

/**
 * Machine d'un circuit. `now` = instant de creation (origine du rattrapage) ; `opts.catchUpMs` : rattrapage des debuts de
 * plage passes, par defaut `(maxMinutes + graceMinutes)` (la ronde en cours pendant un arret du serveur est creee et
 * evaluee) ; 0 pour un circuit qui vient d'etre cree ou modifie.
 */
export function createPatrolMachine(spec: PatrolSpec, now: number, opts: { catchUpMs?: number } = {}): PatrolMachine {
  if (!isNum(now)) throw new RangeError('createPatrolMachine : instant invalide');
  const route = normalizeSpec(spec);
  const fullCatchUp = route.maxMs + route.graceMs;
  const catchUp = isNum(opts.catchUpMs) ? Math.min(Math.max(0, opts.catchUpMs), MAX_CATCH_UP_MS) : fullCatchUp;
  /** Plus ancien debut de plage que la machine creera jamais. */
  const floor = now - catchUp;
  /** Un saut d'horloge en avant ne rattrape pas plus que cela. */
  const jumpLimit = Math.max(catchUp, fullCatchUp, DAY_MS);

  const state = new Map<number, RunState>();
  /** Dernier `now` traite par `tick` (les debuts de plage jusqu'a lui sont crees ou volontairement ignores). */
  let cursor: number | null = null;
  /** Ronde de la derniere alerte non suivie d'un `clear` (null : rien a lever). */
  let alertRun: number | null = null;
  let released = false;

  const sorted = (): RunState[] => [...state.values()].sort((a, b) => a.dueStart - b.dueStart);
  const isDone = (run: RunState, id: number): boolean => run.done.some((x) => x.checkpointId === id);
  const missingOf = (run: RunState): number[] => route.checkpoints.filter((id) => !isDone(run, id));

  const statusAction = (run: RunState): PatrolAction => ({
    kind: 'status',
    dueStart: run.dueStart,
    status: run.status,
    startedBy: run.startedBy,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  });

  function alert(run: RunState, event: 'patrol_incomplete' | 'patrol_missed', out: PatrolAction[]): void {
    out.push({ kind: 'event', dueStart: run.dueStart, event, missed: missingOf(run) });
    alertRun = run.dueStart;
  }

  /** Bas de la plage de creation pour un appel a l'instant `now` (voir precision 1). */
  const creationLower = (at: number): number => Math.max(floor, cursor === null ? -Infinity : cursor + 1, at - jumpLimit);

  /** Tous les points sont scannes : `done`, et `clear` si la ronde etait en alerte (precision 5). */
  function complete(run: RunState, out: PatrolAction[]): void {
    const wasAlert = run.status === 'incomplete' || run.status === 'missed';
    run.status = 'done';
    run.finishedAt = Math.max(...run.done.map((x) => x.at));
    out.push(statusAction(run));
    if (!wasAlert || alertRun === null) return;
    const stillIncomplete = sorted().filter((r) => r !== run && r.status === 'incomplete');
    if (stillIncomplete.length > 0) {
      alertRun = stillIncomplete[stillIncomplete.length - 1].dueStart;
      return;
    }
    out.push({ kind: 'event', dueStart: run.dueStart, event: 'clear', missed: [] });
    alertRun = null;
  }

  /** Echeances d'une ronde a l'instant `now`. Chaque transition n'a lieu qu'une fois : un seul evenement par transition. */
  function settle(run: RunState, now: number, out: PatrolAction[]): void {
    if (run.status === 'done' || run.status === 'missed') return;
    // Tous les points deja faits (circuit raccourci depuis le chargement) : la ronde est terminee.
    if (run.done.length > 0 && missingOf(run).length === 0) {
      complete(run, out);
      return;
    }
    if (run.status === 'pending' || run.status === 'active') {
      if (now < run.dueEnd) return;
      if (run.done.length === 0) {
        run.status = 'missed';
        out.push(statusAction(run));
        alert(run, 'patrol_missed', out);
        return;
      }
      run.status = 'incomplete';
      out.push(statusAction(run));
      alert(run, 'patrol_incomplete', out);
    }
    if (run.status === 'incomplete' && now >= run.dueEnd + route.graceMs) {
      run.status = 'missed';
      out.push(statusAction(run));
      alert(run, 'patrol_missed', out);
    }
  }

  function tick(now: number): PatrolAction[] {
    if (released || !isNum(now)) return [];
    const out: PatrolAction[] = [];
    const lower = creationLower(now);
    for (const start of windowStarts(route.schedule, lower, now)) {
      if (state.has(start)) continue;
      const run: RunState = { dueStart: start, dueEnd: start + route.maxMs, status: 'pending', startedBy: null, startedAt: null, finishedAt: null, done: [] };
      state.set(start, run);
      out.push({ kind: 'create', dueStart: run.dueStart, dueEnd: run.dueEnd });
    }
    cursor = cursor === null ? now : Math.max(cursor, now);
    for (const run of sorted()) {
      if ((run.status === 'done' || run.status === 'missed') && run.dueEnd + route.graceMs + RETAIN_MS < now) state.delete(run.dueStart);
      else settle(run, now, out);
    }
    return out;
  }

  /** La ronde peut-elle prendre en compte un scan d'heure effective `at` ? (precision 3) */
  function accepts(run: RunState, at: number, deferred: boolean): boolean {
    if (run.status === 'done') return false;
    if (run.status === 'missed' && !deferred) return false;
    if (at < run.dueStart - EARLY_SCAN_MS) return false;
    if (at <= run.dueEnd) return true;
    const graceApplies = run.status === 'incomplete' || run.done.some((x) => x.at <= run.dueEnd);
    return graceApplies && at < run.dueEnd + route.graceMs;
  }

  function verdictFor(run: RunState, checkpointId: number): Exclude<ScanVerdict, 'no_run'> {
    if (!route.set.has(checkpointId)) return 'out_of_route';
    if (isDone(run, checkpointId)) return 'duplicate';
    if (route.ordered && missingOf(run)[0] !== checkpointId) return 'out_of_order';
    return 'ok';
  }

  function scan(now: number, s: PatrolScan): PatrolScanResult {
    const none: PatrolScanResult = { verdict: 'no_run', dueStart: null, actions: [] };
    if (released || !isNum(now) || typeof s !== 'object' || s === null) return none;
    const { checkpointId, username, at } = s;
    if (!isNum(at) || typeof username !== 'string') return none;
    // Agent non autorise : comme si le circuit n'existait pas pour lui.
    if (route.agents.length > 0 && !route.agents.includes(username)) return none;
    const deferred = s.deferred === true;

    const candidates: { run: RunState; virtual: boolean }[] = [];
    for (const run of state.values()) if (accepts(run, at, deferred)) candidates.push({ run, virtual: false });
    // Rondes que le `tick` n'a pas encore creees (scan jusqu'a 15 min avant le debut, ou tick en retard) : precision 2.
    const lower = Math.max(creationLower(now), at - route.maxMs);
    const upper = at + EARLY_SCAN_MS;
    if (lower <= upper) {
      for (const start of windowStarts(route.schedule, lower, upper)) {
        if (state.has(start) || (cursor !== null && start <= cursor)) continue;
        const run: RunState = { dueStart: start, dueEnd: start + route.maxMs, status: 'pending', startedBy: null, startedAt: null, finishedAt: null, done: [] };
        if (accepts(run, at, deferred)) candidates.push({ run, virtual: true });
      }
    }
    if (candidates.length === 0) return none;

    // Meilleur verdict, a egalite la ronde la plus ancienne (precision 4).
    candidates.sort((a, b) => a.run.dueStart - b.run.dueStart);
    let best = candidates[0];
    let verdict = verdictFor(best.run, checkpointId);
    for (const c of candidates.slice(1)) {
      const v = verdictFor(c.run, checkpointId);
      if (RANK[v] > RANK[verdict]) {
        best = c;
        verdict = v;
      }
    }
    // Un scan refuse ne modifie jamais l'etat.
    if (verdict !== 'ok') return { verdict, dueStart: best.virtual ? null : best.run.dueStart, actions: [] };

    const out: PatrolAction[] = [];
    const run = best.run;
    if (best.virtual) {
      state.set(run.dueStart, run);
      out.push({ kind: 'create', dueStart: run.dueStart, dueEnd: run.dueEnd });
    }
    run.done.push({ checkpointId, at, username });
    let changed = false;
    if (run.startedAt === null || at < run.startedAt) {
      run.startedAt = at;
      run.startedBy = username;
      changed = true;
    }
    if (run.status === 'pending') {
      run.status = 'active';
      changed = true;
    }
    if (missingOf(run).length === 0) complete(run, out);
    else if (changed) out.push(statusAction(run));
    return { verdict: 'ok', dueStart: run.dueStart, actions: out };
  }

  /** Recharge des rondes persistees (au demarrage). Les entrees invalides sont ignorees, les scans hors circuit ecartes. */
  function load(runs: RunState[]): void {
    if (!Array.isArray(runs)) return;
    let latestAlert: number | null = null;
    for (const raw of runs as unknown[]) {
      if (typeof raw !== 'object' || raw === null) continue;
      const r = raw as Partial<RunState>;
      if (!isNum(r.dueStart) || !isNum(r.dueEnd) || r.dueEnd < r.dueStart) continue;
      if (typeof r.status !== 'string' || !STATUSES.has(r.status)) continue;
      const seen = new Set<number>();
      const done: RunState['done'] = [];
      for (const x of Array.isArray(r.done) ? (r.done as unknown[]) : []) {
        if (typeof x !== 'object' || x === null) continue;
        const { checkpointId, at, username } = x as Partial<RunState['done'][number]>;
        if (typeof checkpointId !== 'number' || !route.set.has(checkpointId) || seen.has(checkpointId)) continue;
        if (!isNum(at) || typeof username !== 'string') continue;
        seen.add(checkpointId);
        done.push({ checkpointId, at, username });
      }
      const run: RunState = {
        dueStart: r.dueStart,
        dueEnd: r.dueEnd,
        status: r.status as RunStatus,
        startedBy: typeof r.startedBy === 'string' ? r.startedBy : null,
        startedAt: isNum(r.startedAt) ? r.startedAt : null,
        finishedAt: isNum(r.finishedAt) ? r.finishedAt : null,
        done,
      };
      state.set(run.dueStart, run);
      // Une ronde chargee en alerte a deja donne son evenement : seule la suite (grace, achevement) en donnera d'autres.
      if ((run.status === 'incomplete' || run.status === 'missed') && (latestAlert === null || run.dueStart > latestAlert)) latestAlert = run.dueStart;
    }
    if (latestAlert !== null && (alertRun === null || latestAlert > alertRun)) alertRun = latestAlert;
  }

  function release(_now: number): PatrolAction[] {
    if (released) return [];
    released = true;
    if (alertRun === null) return [];
    const out: PatrolAction[] = [{ kind: 'event', dueStart: alertRun, event: 'clear', missed: [] }];
    alertRun = null;
    return out;
  }

  return {
    load,
    runs: () => sorted().map(copyRun),
    tick,
    scan,
    release,
  };
}
