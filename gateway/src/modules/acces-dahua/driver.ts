/**
 * Pilote Dahua d'une porte (`DoorDriver` du code commun) : ouverture a distance, mode « toujours ouverte », retour au mode normal.
 *
 *  - impulsion : `accessControl.cgi?action=openDoor&channel=<porte>&Type=Remote` (CONFIRME [A] : `channel` = numero de porte,
 *    A PARTIR DE 1 ; `UserID` facultatif, omis sauf `remoteUserId` configure) ; reponse attendue : corps `OK` ;
 *  - toujours ouverte : mode `OpenAlways` de la porte, par `configManager.cgi?action=setConfig&AccessControl[<porte-1>].State=...`
 *    (valeurs vues dans la documentation de l'API HTTP : Normal, CloseAlways, OpenAlways ; A QUALIFIER sur materiel : indice de
 *    table, presence de la cle) ;
 *  - retour a la normale : mode `Normal` PUIS `accessControl.cgi?action=closeDoor&channel=<porte>` (CONFIRME [A]). Jamais
 *    « CloseAlways » : voir acces-commun/actuator.ts.
 * La configuration est d'abord LUE : seule la cle `State` de la porte visee est ecrite (rien d'autre n'est reecrit), et rien n'est
 * ecrit si le mode est deja le bon.
 * Chaque appel ne se resout que si le controleur a repondu `OK`. Les ordres visant la meme porte sont serialises (file par porte).
 */
import { ActuatorFailure } from '../acces-commun/actuator.ts';
import type { DoorDriver } from '../acces-commun/actuator.ts';
import type { LogFn } from '../acces-commun/commun.ts';
import { DahuaAuthError, DahuaHttpError } from './http.ts';
import type { HttpResult } from './http.ts';
import { parseDoorMode } from './protocol.ts';
import type { DoorMode } from './protocol.ts';

export interface HttpGetter {
  get(path: string): Promise<HttpResult>;
}

export interface DriverOptions {
  /** Identifiant d'utilisateur transmis avec `openDoor` / `closeDoor` (facultatif). */
  remoteUserId?: number | null;
  log?: LogFn;
  /**
   * Appele APRES un changement de mode reussi (`holdOpen`, `restoreNormal`) avec le mode que le controleur vient de confirmer :
   * le module en tire le mode de porte (F19) sans attendre la relecture periodique. Une exception est sans effet.
   */
  onMode?: (doorNo: number, mode: DoorMode) => void;
}

/** Erreur reseau / HTTP -> echec d'ordre avec un code court (`unreachable`, `timeout`, `refused_by_device`). */
export function failure(err: unknown): ActuatorFailure {
  if (err instanceof ActuatorFailure) return err;
  if (err instanceof DahuaAuthError) return new ActuatorFailure('refused_by_device', 'identifiants refuses par le controleur');
  if (err instanceof DahuaHttpError) {
    if (err.code === 'timeout') return new ActuatorFailure('timeout', 'le controleur ne repond pas');
    if (err.code === 'http') return new ActuatorFailure('refused_by_device', 'reponse HTTP refusee par le controleur');
    return new ActuatorFailure('unreachable', 'controleur injoignable');
  }
  return new ActuatorFailure('unreachable', 'controleur injoignable');
}

export class DahuaDoorDriver implements DoorDriver {
  private readonly http: HttpGetter;
  private readonly remoteUserId: number | null;
  private readonly log: LogFn;
  private readonly onMode: ((doorNo: number, mode: DoorMode) => void) | null;
  /** Dernier ordre en cours par porte : le suivant attend sa fin (reussie ou non). */
  private readonly chains = new Map<number, Promise<unknown>>();

  constructor(http: HttpGetter, opts: DriverOptions = {}) {
    this.http = http;
    this.remoteUserId = opts.remoteUserId ?? null;
    this.log = opts.log ?? (() => undefined);
    this.onMode = opts.onMode ?? null;
  }

  pulse(doorNo: number): Promise<void> {
    return this.serial(doorNo, async () => {
      await this.command(`/cgi-bin/accessControl.cgi?action=openDoor&channel=${this.channel(doorNo)}${this.user()}&Type=Remote`);
    });
  }

  holdOpen(doorNo: number): Promise<void> {
    return this.serial(doorNo, () => this.setMode(doorNo, 'OpenAlways'));
  }

  restoreNormal(doorNo: number): Promise<void> {
    return this.serial(doorNo, async () => {
      await this.setMode(doorNo, 'Normal');
      await this.command(`/cgi-bin/accessControl.cgi?action=closeDoor&channel=${this.channel(doorNo)}${this.user()}&Type=Remote`);
    });
  }

  // `stop` : absent. Un controleur de portes ne sait pas arreter une barriere en mouvement (refused / not_supported).

  /** Numero de canal : la porte N est le canal N [A]. */
  private channel(doorNo: number): number {
    if (!Number.isInteger(doorNo) || doorNo < 1 || doorNo > 64) throw new ActuatorFailure('refused_by_device', 'numero de porte invalide');
    return doorNo;
  }

  private user(): string {
    return this.remoteUserId === null ? '' : `&UserID=${this.remoteUserId}`;
  }

  private serial(doorNo: number, job: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(doorNo) ?? Promise.resolve();
    const run = previous.then(job, job);
    const tail = run.catch(() => undefined);
    this.chains.set(doorNo, tail);
    // La file ne grossit pas : une fois la queue terminee et toujours la derniere, on l'oublie.
    void tail.then(() => {
      if (this.chains.get(doorNo) === tail) this.chains.delete(doorNo);
    });
    return run.catch((err: unknown) => {
      throw failure(err);
    });
  }

  /** Commande `OK` attendue ; tout le reste est un refus du controleur. */
  private async command(path: string): Promise<void> {
    const res = await this.http.get(path);
    if (res.status !== 200) throw new ActuatorFailure('refused_by_device', `reponse HTTP ${res.status}`);
    if (!/^\s*OK\s*$/i.test(res.body.slice(0, 64))) throw new ActuatorFailure('refused_by_device', 'reponse inattendue du controleur');
  }

  /** Lit la configuration, ne change que le mode de la porte visee. */
  private async setMode(doorNo: number, mode: DoorMode): Promise<void> {
    const index = this.channel(doorNo) - 1;
    const read = await this.http.get('/cgi-bin/configManager.cgi?action=getConfig&name=AccessControl');
    if (read.status !== 200) throw new ActuatorFailure('refused_by_device', `lecture de la configuration refusee (HTTP ${read.status})`);
    const current = parseDoorMode(read.body, index);
    if (current === null) throw new ActuatorFailure('refused_by_device', 'mode de la porte introuvable dans la configuration du controleur');
    if (current !== mode) {
      this.log('info', `porte ${doorNo} : mode ${current} -> ${mode}`);
      await this.command(`/cgi-bin/configManager.cgi?action=setConfig&AccessControl[${index}].State=${mode}`);
    }
    // Le controleur vient de confirmer ce mode (ecrit, ou deja le bon) : mode de porte (F19) a jour tout de suite.
    try {
      this.onMode?.(doorNo, mode);
    } catch {
      // un rappel defaillant ne change pas l'accuse de l'ordre
    }
  }
}
