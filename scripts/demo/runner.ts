import { AUTO_SEQUENCE, DEMO_CAMERAS, DEMO_DETECTORS, SCENARIOS, lastStepAt } from './scenarios.ts';
import type { DetectorState, Scenario } from './scenarios.ts';

export interface RunnerDeps {
  /** Publie l'etat d'un detecteur (MQTT). */
  publish: (detectorId: string, state: DetectorState) => void | Promise<void>;
  /** Fixe ce que les cameras d'une zone "voient". */
  setFire: (zone: string, level: 0 | 1 | 2) => void;
  log: (message: string) => void;
  /** Facteur de vitesse (2 = deux fois plus vite). Utile pour les tests. */
  speed?: number;
}

export function findScenario(idOrNumber: string): Scenario | undefined {
  const n = Number(idOrNumber);
  if (Number.isInteger(n) && n >= 1 && n <= SCENARIOS.length) return SCENARIOS[n - 1];
  return SCENARIOS.find((s) => s.id === idOrNumber);
}

export function createRunner(deps: RunnerDeps) {
  const speed = deps.speed ?? 1;
  let timers: NodeJS.Timeout[] = [];
  let running: string | null = null;
  let autoStop = false;
  // Un detecteur reel emet un signal de vie periodique : on rejoue donc l'etat courant de chacun.
  const states = new Map<string, DetectorState>(DEMO_DETECTORS.map((id) => [id, 'normal']));
  const muted = new Set<string>();
  let heartbeatTimer: NodeJS.Timeout | null = null;

  function cancel(): void {
    for (const t of timers) clearTimeout(t);
    timers = [];
    running = null;
  }

  function later(seconds: number, fn: () => void): void {
    timers.push(setTimeout(fn, (seconds * 1000) / speed));
  }

  function publish(detectorId: string, state: DetectorState): void {
    states.set(detectorId, state);
    if (muted.has(detectorId)) return; // un detecteur muet n'emet rien du tout
    Promise.resolve(deps.publish(detectorId, state)).catch((err) => deps.log(`  ! publication ${detectorId} : ${err.message}`));
  }

  /** Lance un scenario ; `onDone` est appele apres son dernier evenement. */
  function run(scenario: Scenario, onDone?: () => void): void {
    cancel();
    muted.clear(); // un silence laisse par un scenario interrompu ne doit pas survivre
    running = scenario.id;
    deps.log(`\n> Scenario : ${scenario.title}`);
    deps.log(`  ${scenario.description}`);
    for (const step of scenario.steps) {
      later(step.at, () => {
        if (step.fire) deps.setFire(step.fire.zone, step.fire.level);
        if (step.detector && step.mute !== undefined) {
          if (step.mute) muted.add(step.detector);
          else {
            muted.delete(step.detector);
            publish(step.detector, states.get(step.detector) ?? 'normal'); // reprend et le dit tout de suite
          }
        }
        if (step.detector && step.state) publish(step.detector, step.state);
        if (step.note) deps.log(`  [${step.at.toString().padStart(3)} s] ${step.note}`);
      });
    }
    later(lastStepAt(scenario) + 0.05, () => {
      running = null;
      onDone?.();
    });
  }

  /** Tout revient au calme : plus de feu, tous les detecteurs a la normale. */
  function reset(quiet = false): void {
    cancel();
    muted.clear();
    for (const camera of DEMO_CAMERAS) deps.setFire(camera.zone, 0);
    for (const id of DEMO_DETECTORS) publish(id, 'normal');
    if (!quiet) deps.log('\n> Retour au calme : feu eteint, detecteurs a la normale');
  }

  /** Enchaine les scenarios en boucle (presentation). S'arrete avec stopAuto(). */
  async function auto(pauseSeconds = 15): Promise<void> {
    autoStop = false;
    deps.log('\n> Mode automatique : les scenarios s\'enchainent en boucle (Ctrl+C pour arreter)');
    while (!autoStop) {
      for (const id of AUTO_SEQUENCE) {
        if (autoStop) return;
        const scenario = SCENARIOS.find((s) => s.id === id);
        if (!scenario) continue;
        await new Promise<void>((resolve) => run(scenario, resolve));
        await sleep(scenario.holdSeconds / speed);
        if (autoStop) return;
        reset();
        await sleep(pauseSeconds / speed);
      }
    }
  }

  function sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, seconds * 1000);
      timers.push(t);
    });
  }

  /** Signal de vie : toutes les `periodSeconds`, chaque detecteur non muet repete son etat courant. */
  function startHeartbeat(periodSeconds: number): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      for (const [id, state] of states) if (!muted.has(id)) publish(id, state);
    }, (periodSeconds * 1000) / speed);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  return {
    run,
    reset,
    startHeartbeat,
    stopHeartbeat,
    isMuted: (id: string) => muted.has(id),
    auto,
    cancel,
    stopAuto: () => {
      autoStop = true;
      cancel();
    },
    isRunning: () => running,
  };
}
