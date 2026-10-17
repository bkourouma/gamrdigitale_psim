/**
 * Module `acces-dahua` : controleurs d'acces Dahua (ASC1204, ASC2xxx, terminaux ASI...) vers le PSIM.
 *
 * Par controleur : flux d'evenements HTTP (Digest) -> passages (badge, code, empreinte, visage, bouton, ouverture a distance),
 * etat des portes (ouverte, fermee, forcee, maintenue ouverte), sabotage du boitier, signes de vie, hors ligne, derive d'horloge,
 * refus repetes ; recuperation des passages manques pendant une coupure (F8) ; ouverture a distance par le canal de commande signe
 * (actionneurs `lock` / `gate`). Voir docs/CONTROLE-ACCES.md et gateway/docs/acces-dahua.md.
 *
 * Le controleur decide TOUJOURS de l'ouverture d'une porte par badge : ce module ne fait que lire et rapporter.
 */
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import type { GatewayModule, ModuleContext, ModuleFactory } from '../../module.ts';
import { makeActuatorHandler, registerActuator } from '../acces-commun/actuator.ts';
import { CursorStore } from '../acces-commun/commun.ts';
import type { Emitter } from '../acces-commun/commun.ts';
import { AccessController } from './controller.ts';
import type { ControllerDeps, Timers } from './controller.ts';
import { parseConfig } from './config.ts';
import type { DahuaAccessConfig } from './config.ts';
import type { openEventStream } from '../../../../server/dahua.ts';

/** Dossier de la passerelle (gateway/) : base des chemins relatifs et du dossier d'etat par defaut. */
const GATEWAY_DIR = fileURLToPath(new URL('../../../', import.meta.url));
export const DEFAULT_STATE_DIR = resolve(GATEWAY_DIR, 'data', 'acces');

/** Reglages internes (essais seulement) : jamais lus depuis la configuration. */
export interface Internals {
  /** Periode du `tick` (1 s par defaut) ; `null` = pas de minuterie, l'essai appelle `tick()` lui-meme. */
  tickMs?: number | null;
  timers?: Timers;
  open?: typeof openEventStream;
  httpTimeoutMs?: number;
}

export class AccesDahuaModule implements GatewayModule {
  readonly name = 'acces-dahua';
  private readonly config: DahuaAccessConfig;
  private readonly internals: Internals;
  private controllers: AccessController[] = [];
  private cursors: CursorStore | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopping: Promise<void> | null = null;

  constructor(config: Record<string, unknown>, internals: Internals = {}) {
    this.config = parseConfig(config);
    this.internals = internals;
  }

  /** Controleurs (essais). */
  get all(): readonly AccessController[] {
    return this.controllers;
  }

  async start(ctx: ModuleContext): Promise<void> {
    if (this.started) return;
    this.started = true;
    const stateDir = this.config.stateDir === null ? DEFAULT_STATE_DIR : isAbsolute(this.config.stateDir) ? this.config.stateDir : resolve(GATEWAY_DIR, this.config.stateDir);
    const log = (level: 'info' | 'warn' | 'error', text: string) => {
      try {
        ctx.log(level, text);
      } catch {
        // un journal defaillant ne doit rien casser
      }
    };
    const cursors = new CursorStore({ dir: stateDir, now: () => ctx.now(), log });
    this.cursors = cursors;
    const emit: Emitter = (deviceId, msg) => ctx.emit(deviceId, msg) as boolean | void;

    for (const cfg of this.config.controllers) {
      const deps: ControllerDeps = {
        cfg,
        thresholds: this.config.thresholds,
        reconnect: this.config.reconnect,
        emit,
        now: () => ctx.now(),
        log,
        cursors,
        open: this.internals.open,
        timers: this.internals.timers,
        httpTimeoutMs: this.internals.httpTimeoutMs,
      };
      const controller = new AccessController(deps);
      this.controllers.push(controller);
      for (const [actuatorId, spec] of cfg.actuators) {
        const handler = makeActuatorHandler({ kind: spec.type, doorNo: spec.door }, controller.driver, { longUnlockS: this.config.thresholds.longUnlockS, log });
        if (!registerActuator(ctx, actuatorId, handler)) {
          log('warn', `ouverture a distance indisponible pour « ${actuatorId} » : le canal de commande n'est pas installe dans cette passerelle`);
        }
      }
    }
    for (const c of this.controllers) c.start();
    const tickMs = this.internals.tickMs === undefined ? 1000 : this.internals.tickMs;
    if (tickMs !== null) {
      this.timer = setInterval(() => this.tick(), tickMs);
      this.timer.unref?.();
    }
    log('info', `${this.controllers.length} controleur(s) d'acces Dahua suivi(s)`);
  }

  /** Un tour de surveillance (appele chaque seconde). */
  tick(): void {
    for (const c of this.controllers) c.tick();
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      await Promise.all(this.controllers.map((c) => c.stop().catch(() => undefined)));
      this.cursors?.flush();
    })();
    return this.stopping;
  }
}

export const create: ModuleFactory = (config) => new AccesDahuaModule(config);
export const createModule = (config: Record<string, unknown>, internals?: Internals): AccesDahuaModule => new AccesDahuaModule(config, internals);
