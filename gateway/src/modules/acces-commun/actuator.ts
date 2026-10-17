/**
 * Gestionnaire d'actionneur COMMUN aux modules d'acces (docs/CONTROLE-ACCES.md, § 3) : la traduction des ordres du canal de
 * commande (`unlock`, `lock`, `open`, `close`, `stop`) en operations sur une porte est la meme pour toutes les marques ; chaque
 * marque ne fournit que `DoorDriver` (comment faire une impulsion, tenir ouverte, revenir au mode normal).
 *
 * Regles de securite :
 *  - `lock` = retour au mode NORMAL du controleur (les badges fonctionnent) et refermeture immediate. Jamais « toujours
 *    fermee » : une porte verrouillee a distance qui refuse les badges enfermerait ou exclurait du monde (issue de secours) ;
 *  - `unlock` sans duree longue = une impulsion (la duree d'ouverture reste celle du controleur) ; avec `durationS` au-dela du
 *    seuil = mode « toujours ouverte » (le socle rappelle `lock` a la fin de la duree : retour local au repos) ;
 *  - ce que le materiel ne sait pas faire est REFUSE (`refused` / `not_supported`), jamais simule ;
 *  - une erreur du controleur ou du reseau est `error` : l'accuse n'est donne que si le controleur a confirme.
 * Le socle (AC0) a deja verifie signature, fraicheur, anti-rejeu et plafonds : le module n'execute que.
 */
import type { ActuatorHandler, ActuatorOutcome, ActuatorRequest, ModuleContext } from '../../module.ts';

// Les types du contrat (§ 3) appartiennent a gateway/src/module.ts ; reexportes ici pour les modules de marque.
export type { ActuatorHandler, ActuatorOutcome, ActuatorRequest };

/** Type d'actionneur declare dans la configuration d'un controleur. */
export type ActuatorKind = 'lock' | 'gate';

/** Au-dela de cette duree (secondes), `unlock` / `open` devient le mode « toujours ouverte ». */
export const DEFAULT_LONG_UNLOCK_S = 60;

/** Ce que sait faire un controleur sur UNE porte. Chaque methode ne se resout que si le controleur a CONFIRME. */
export interface DoorDriver {
  /** Impulsion d'ouverture : la porte s'ouvre pour la duree reglee dans le controleur. */
  pulse(doorNo: number): Promise<void>;
  /** Mode « toujours ouverte » (jusqu'a `restoreNormal`). */
  holdOpen(doorNo: number): Promise<void>;
  /** Mode normal (les badges fonctionnent) ET refermeture immediate. */
  restoreNormal(doorNo: number): Promise<void>;
  /** Arret d'une barriere en mouvement ; absent = le materiel ne sait pas. */
  stop?(doorNo: number): Promise<void>;
}

/** Echec d'une operation : `code` court (sans espace) renvoye dans l'accuse, `message` pour le journal. */
export class ActuatorFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ActuatorSpec {
  kind: ActuatorKind;
  /** Numero de porte du controleur (1 a 4). */
  doorNo: number;
}

export interface HandlerOptions {
  /** Seuil de la duree longue (secondes). */
  longUnlockS?: number;
  log?: (level: 'info' | 'warn' | 'error', text: string) => void;
}

const refused = (code: string): ActuatorOutcome => ({ result: 'refused', code });

/** Construit le gestionnaire d'un actionneur. Ne leve jamais : toute erreur devient `{ result: 'error' }`. */
export function makeActuatorHandler(spec: ActuatorSpec, driver: DoorDriver, opts: HandlerOptions = {}): ActuatorHandler {
  const longS = opts.longUnlockS ?? DEFAULT_LONG_UNLOCK_S;
  const open = (req: ActuatorRequest): Promise<void> =>
    req.durationS !== undefined && req.durationS > longS ? driver.holdOpen(spec.doorNo) : driver.pulse(spec.doorNo);

  return async (req) => {
    try {
      const action = req.action;
      if (spec.kind === 'lock') {
        if (action === 'unlock') await open(req);
        else if (action === 'lock') await driver.restoreNormal(spec.doorNo);
        else return refused('not_supported');
      } else if (action === 'open') await open(req);
      else if (action === 'close') await driver.restoreNormal(spec.doorNo);
      else if (action === 'stop') {
        if (!driver.stop) return refused('not_supported');
        await driver.stop(spec.doorNo);
      } else return refused('not_supported');
      return { result: 'done' };
    } catch (err) {
      const code = err instanceof ActuatorFailure && /^[a-z0-9_]{1,32}$/.test(err.code) ? err.code : 'error';
      try {
        opts.log?.('warn', `ordre ${String(req.action).slice(0, 16)} refuse par le controleur (porte ${spec.doorNo}) : ${code}`);
      } catch {
        // un journal defaillant ne change pas l'accuse
      }
      return { result: 'error', code };
    }
  };
}

/**
 * Declare le gestionnaire aupres du socle. Le socle LEVE une erreur quand l'actionneur n'est pas declare dans la section
 * `actuators` de la passerelle pour ce module (ou deja pris) : une erreur de configuration des COMMANDES ne doit JAMAIS
 * couper la remontee des passages. L'erreur est donc attrapee et journalisee clairement, et le module continue sans ce
 * gestionnaire (surveillance seule, ouverture a distance indisponible). Renvoie vrai si le gestionnaire est enregistre.
 */
export function registerActuator(ctx: ModuleContext, actuatorId: string, handler: ActuatorHandler): boolean {
  try {
    ctx.onActuator(actuatorId, handler);
    return true;
  } catch (err) {
    const why = err instanceof Error ? err.message : 'erreur inconnue';
    try {
      ctx.log('warn', `actionneur « ${String(actuatorId).slice(0, 40)} » non enregistre : ouverture a distance indisponible, surveillance seule (${why.slice(0, 200)})`);
    } catch {
      // un journal defaillant ne doit pas faire echouer le module
    }
    return false;
  }
}
