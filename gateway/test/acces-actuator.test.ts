/** Gestionnaire d'actionneur commun aux modules d'acces : traduction des ordres en operations sur une porte. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModuleContext } from '../src/module.ts';
import { ActuatorFailure, makeActuatorHandler, registerActuator } from '../src/modules/acces-commun/actuator.ts';
import type { ActuatorRequest, DoorDriver } from '../src/modules/acces-commun/actuator.ts';

function fakeDriver(over: Partial<DoorDriver> = {}) {
  const calls: string[] = [];
  const driver: DoorDriver = {
    pulse: async (d) => void calls.push(`pulse:${d}`),
    holdOpen: async (d) => void calls.push(`hold:${d}`),
    restoreNormal: async (d) => void calls.push(`normal:${d}`),
    ...over,
  };
  return { driver, calls };
}
const req = (action: string, durationS?: number): ActuatorRequest => ({ actuatorId: 'A-1', cmdId: 'c1', action, ...(durationS === undefined ? {} : { durationS }) });

describe("gestionnaire d'actionneur des modules d'acces", () => {
  it('lock : unlock sans duree = impulsion', async () => {
    const { driver, calls } = fakeDriver();
    const h = makeActuatorHandler({ kind: 'lock', doorNo: 2 }, driver);
    assert.deepEqual(await h(req('unlock')), { result: 'done' });
    assert.deepEqual(calls, ['pulse:2']);
  });

  it('lock : unlock de courte duree = impulsion, de longue duree = toujours ouverte (seuil reglable)', async () => {
    const { driver, calls } = fakeDriver();
    const h = makeActuatorHandler({ kind: 'lock', doorNo: 1 }, driver);
    await h(req('unlock', 10));
    await h(req('unlock', 60));
    await h(req('unlock', 61));
    await h(req('unlock', 600));
    assert.deepEqual(calls, ['pulse:1', 'pulse:1', 'hold:1', 'hold:1']);
    const other = fakeDriver();
    await makeActuatorHandler({ kind: 'lock', doorNo: 1 }, other.driver, { longUnlockS: 5 })(req('unlock', 6));
    assert.deepEqual(other.calls, ['hold:1']);
  });

  it('lock : « lock » revient au mode normal (jamais « toujours fermee ») et ne fait rien d\'autre', async () => {
    const { driver, calls } = fakeDriver();
    const h = makeActuatorHandler({ kind: 'lock', doorNo: 3 }, driver);
    assert.deepEqual(await h(req('lock')), { result: 'done' });
    assert.deepEqual(calls, ['normal:3']);
  });

  it("lock : open / close / stop / inconnu = refuses (not_supported), rien n'est execute", async () => {
    const { driver, calls } = fakeDriver({ stop: async () => void 0 });
    const h = makeActuatorHandler({ kind: 'lock', doorNo: 1 }, driver);
    for (const a of ['open', 'close', 'stop', 'explode', '']) assert.deepEqual(await h(req(a)), { result: 'refused', code: 'not_supported' }, a);
    assert.deepEqual(calls, []);
  });

  it('gate : open / close, et stop refuse si le materiel ne sait pas', async () => {
    const { driver, calls } = fakeDriver();
    const h = makeActuatorHandler({ kind: 'gate', doorNo: 1 }, driver);
    assert.deepEqual(await h(req('open')), { result: 'done' });
    assert.deepEqual(await h(req('open', 300)), { result: 'done' });
    assert.deepEqual(await h(req('close')), { result: 'done' });
    assert.deepEqual(await h(req('stop')), { result: 'refused', code: 'not_supported' });
    assert.deepEqual(await h(req('unlock')), { result: 'refused', code: 'not_supported' });
    assert.deepEqual(calls, ['pulse:1', 'hold:1', 'normal:1']);
  });

  it('gate : stop execute quand le materiel sait', async () => {
    const calls: string[] = [];
    const { driver } = fakeDriver({ stop: async (d) => void calls.push(`stop:${d}`) });
    const h = makeActuatorHandler({ kind: 'gate', doorNo: 2 }, driver);
    assert.deepEqual(await h(req('stop')), { result: 'done' });
    assert.deepEqual(calls, ['stop:2']);
  });

  it('echec du controleur : error avec un code court ; erreur inattendue : error', async () => {
    const logs: string[] = [];
    const { driver } = fakeDriver({
      pulse: async () => {
        throw new ActuatorFailure('unreachable', 'controleur injoignable 192.168.1.50 mot de passe x');
      },
      restoreNormal: async () => {
        throw new Error('boum');
      },
      holdOpen: async () => {
        throw new ActuatorFailure('Code Invalide !', 'x');
      },
    });
    const h = makeActuatorHandler({ kind: 'lock', doorNo: 1 }, driver, { log: (_l, t) => void logs.push(t) });
    assert.deepEqual(await h(req('unlock')), { result: 'error', code: 'unreachable' });
    assert.deepEqual(await h(req('lock')), { result: 'error', code: 'error' });
    assert.deepEqual(await h(req('unlock', 600)), { result: 'error', code: 'error' });
    assert.equal(logs.length, 3);
    assert.ok(logs.every((t) => !/192\.168|mot de passe|boum/.test(t)), 'le journal ne reprend ni adresse ni texte du controleur');
  });

  it("un journal defaillant ne change pas l'accuse", async () => {
    const { driver } = fakeDriver({ pulse: async () => Promise.reject(new Error('x')) });
    const h = makeActuatorHandler({ kind: 'lock', doorNo: 1 }, driver, {
      log: () => {
        throw new Error('journal');
      },
    });
    assert.deepEqual(await h(req('unlock')), { result: 'error', code: 'error' });
  });

  it('registerActuator : appelle onActuator du socle et renvoie vrai', () => {
    const seen: string[] = [];
    const ctx = { onActuator: (id: string) => void seen.push(id), log: () => undefined } as unknown as ModuleContext;
    assert.equal(registerActuator(ctx, 'A-1', async () => ({ result: 'done' })), true);
    assert.deepEqual(seen, ['A-1']);
  });

  it("registerActuator : actionneur non declare dans « actuators » (le socle leve) = journal clair, faux, jamais d'exception", () => {
    const logs: { level: string; text: string }[] = [];
    const ctx = {
      onActuator: () => {
        throw new Error('actionneur « A-9 » non declare dans la section « actuators » de la configuration de la passerelle');
      },
      log: (level: string, text: string) => void logs.push({ level, text }),
    } as unknown as ModuleContext;
    assert.equal(registerActuator(ctx, 'A-9', async () => ({ result: 'done' })), false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.level, 'warn');
    assert.match(logs[0]!.text, /A-9/);
    assert.match(logs[0]!.text, /non declare dans la section « actuators »/);
    assert.match(logs[0]!.text, /ouverture a distance indisponible/);
  });

  it('registerActuator : une erreur inattendue ou un journal defaillant ne remontent pas', () => {
    const throwing = (): never => {
      throw 'texte brut';
    };
    assert.equal(registerActuator({ onActuator: throwing, log: throwing } as unknown as ModuleContext, 'A-1', async () => ({ result: 'done' })), false);
    // contexte sans onActuator (essai mal forme) : faux, sans exception
    assert.equal(registerActuator({ log: () => undefined } as unknown as ModuleContext, 'A-1', async () => ({ result: 'done' })), false);
  });
});
