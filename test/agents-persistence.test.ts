import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { createAgents, isVirtualDetector, releaseAcknowledged } from '../server/agents.ts';
import { createUser, setSessionValidator, useSessionStore } from '../server/auth.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import type { EngineOptions } from '../server/engine.ts';
import { createUsersService } from '../server/users.ts';
import type { Incident } from '../server/types.ts';

/**
 * Les detecteurs virtuels des agents (`A-<identifiant>`, `A-phone-<n>`) et des circuits (`P-<n>`) ne subissent aucune regle
 * anti-fausses alarmes : ni confirmation par persistance, ni confirmation par voisin, ni indice « probable fausse alarme ».
 *
 * Defaut d'origine : `confirm` fait repasser « non acquitte » un incident acquitte. Un SOS acquitte par l'exploitation, dont le
 * detecteur sonnait encore (liberation par `releaseAcknowledged` pas encore passee, ou voisin en alarme), redevenait « non acquitte »
 * des que `persistMs` (120 s) s'etait ecoule depuis le debut de l'alarme.
 */

const T0 = 1_800_000_000_000;
const S = 1000;
const KEY = Buffer.alloc(32, 5);
const RULES = { confirmWindowMs: 60 * S, persistMs: 120 * S, hintMs: 30 * S };

function setup(options: EngineOptions = RULES, wired = true) {
  const db = openDb(':memory:');
  const clock = { t: T0 };
  const hooks: { id: number; kind: string }[] = [];
  const engine = createEngine(db, () => {}, () => clock.t, {
    ...options,
    ...(wired ? { virtualDetector: (id: string) => isVirtualDetector(db, id) } : {}), // comme main.ts
    onIncidentEvent: (incident, kind) => void hooks.push({ id: incident.id, kind }),
  });
  const users = createUsersService({ db, key: KEY, now: () => clock.t, audit: (actor, action, ref) => engine.audit(actor, action, ref) });
  createUser(db, 'admin', 'admin', 'Mot-de-passe-admin-1', clock.t);
  useSessionStore(db);
  setSessionValidator(users.validateSession);
  const agents = createAgents({ db, engine, users, now: () => clock.t, certPath: null, readSnapshot: () => null, liveStream: () => {} });
  const phoneId = agents.pairPhone(agents.createPhone('admin', 'Poste 1').code).phone.id;
  let sosCount = 0;
  const h = {
    db,
    clock,
    engine,
    agents,
    phoneId,
    hooks,
    makeAgent: (username: string) => agents.createAgent('admin', { username, displayName: `Agent ${username}`, pin: '90817', zones: [] }),
    /** SOS d'un agent (`username`) ou d'un telephone sans agent identifie (`null`). */
    sos: (username: string | null): number => agents.sos(username, phoneId, { clientId: `sos-test-${String(++sosCount).padStart(4, '0')}`, phoneAt: clock.t, discreet: false }).incidentId,
    /** Ce que fait main.ts chaque seconde : moteur, puis agents, puis rondes (liberation des `P-`). */
    tick: (release = true) => {
      h.engine.tick();
      if (release) {
        agents.tick();
        releaseAcknowledged(db, engine, 'P-');
      }
    },
    /** Avance seconde par seconde jusqu'a `T0 + seconds` (une seconde apres l'autre, comme la boucle du serveur). */
    runTo: (seconds: number, release = true, at?: Record<number, () => void>) => {
      for (let s = Math.floor((clock.t - T0) / S) + 1; s <= seconds; s++) {
        clock.t = T0 + s * S;
        at?.[s]?.();
        h.tick(release);
      }
    },
    view: (id: number): Incident => engine.incidentView(id),
    audited: (action: string) => engine.listAudit(500).filter((a) => a.action === action),
    circuit: (n: number) => engine.createDevice('admin', { id: `P-${n}`, kind: 'detector', name: `Ronde ${n}`, category: 'people', heartbeatS: 0 }),
  };
  return h;
}
type Harness = ReturnType<typeof setup>;

function assertQuiet(h: Harness, id: number, why: string): void {
  const i = h.view(id);
  assert.equal(i.status, 'acknowledged', `${why} : reste acquitte`);
  assert.equal(i.confirmedAt, null, `${why} : jamais confirme`);
  assert.equal(i.confirmationReason, null);
  assert.ok(i.ackedAt !== null && i.ackedBy !== null, `${why} : acquittement conserve`);
  assert.equal(h.audited('incident_confirmed').length, 0, `${why} : aucune confirmation journalisee`);
  assert.ok(!h.hooks.some((e) => e.kind === 'confirmed'), `${why} : aucune renotification « confirme »`);
}

// ================================================================== reproduction

describe('SOS acquitté : jamais confirmé par persistance', () => {
  it("cas normal : acquitté à 10 s, la libération passe chaque seconde, 5 min plus tard l'incident est toujours acquitté", () => {
    const h = setup();
    h.makeAgent('moussa');
    const id = h.sos('moussa');
    h.runTo(300, true, { 10: () => h.engine.acknowledge(id, 'oscar') });
    assertQuiet(h, id, 'A-moussa');
    assert.equal(h.engine.getDevice('A-moussa')!.status, 'normal', 'libere par releaseAcknowledged');
  });

  it("défaut d'origine : le détecteur sonne encore à persistMs (libération absente ou en retard) -> l'incident n'est PAS rouvert", () => {
    const h = setup();
    h.makeAgent('moussa');
    const id = h.sos('moussa');
    h.runTo(300, false, { 10: () => h.engine.acknowledge(id, 'oscar') }); // moteur seul : le detecteur reste en alarme 5 min
    assert.equal(h.engine.getDevice('A-moussa')!.status, 'alarm', 'toujours en alarme : le cas qui declenchait la persistance');
    assertQuiet(h, id, 'A-moussa sans liberation');
  });

  it("sans correctif (moteur non câblé), le même scénario rouvre bien l'incident à persistMs : la reproduction est réelle", () => {
    const h = setup(RULES, false);
    h.makeAgent('moussa');
    const id = h.sos('moussa');
    h.runTo(119, false, { 10: () => h.engine.acknowledge(id, 'oscar') });
    assert.equal(h.view(id).status, 'acknowledged');
    h.runTo(120, false);
    const i = h.view(id);
    assert.equal(i.status, 'open', 'repasse « non acquitte » exactement a persistMs');
    assert.equal(i.confirmationReason, 'persistence');
    assert.equal(i.ackedAt, null);
  });

  it("course d'une seconde : acquitté juste avant l'instant persistMs, le moteur passe AVANT la libération du même tick", () => {
    const h = setup();
    h.makeAgent('moussa');
    const id = h.sos('moussa');
    h.runTo(119);
    h.clock.t = T0 + 119_500;
    h.engine.acknowledge(id, 'oscar');
    h.runTo(130); // tick a 120 s : engine.tick (persistance) puis agents.tick (liberation)
    assertQuiet(h, id, 'course a 120 s');
  });

  it("A-phone-<n> (SOS d'un téléphone sans agent identifié) : même garantie", () => {
    const h = setup();
    const id = h.sos(null);
    const device = `A-phone-${h.phoneId}`;
    assert.equal(h.view(id).detectorId, device);
    h.runTo(300, false, { 15: () => h.engine.acknowledge(id, 'oscar') });
    assert.equal(h.engine.getDevice(device)!.status, 'alarm');
    assertQuiet(h, id, device);
    const h2 = setup();
    const id2 = h2.sos(null);
    h2.runTo(300, true, { 15: () => h2.engine.acknowledge(id2, 'oscar') });
    assertQuiet(h2, id2, `${device} avec liberation`);
    assert.equal(h2.engine.getDevice(device)!.status, 'normal');
  });

  it("un SOS que personne n'acquitte n'est pas « confirmé » non plus (pas de renotification à 2 min), il reste ouvert", () => {
    const h = setup();
    h.makeAgent('moussa');
    const id = h.sos('moussa');
    h.runTo(400);
    const i = h.view(id);
    assert.equal(i.status, 'open');
    assert.equal(i.confirmedAt, null);
    assert.deepEqual(h.hooks, [{ id, kind: 'opened' }]);
  });

  it("circuit P-<n> : ronde manquée acquittée, jamais rouverte (avec ou sans libération)", () => {
    for (const release of [true, false]) {
      const h = setup();
      h.circuit(7);
      h.engine.handleDetectorMessage('P-7', { event: 'patrol_missed', detail: 'aucun point scanne (3 points)' });
      const id = h.engine.getSnapshot().incidents[0].id;
      h.runTo(300, release, { 20: () => h.engine.acknowledge(id, 'oscar') });
      assertQuiet(h, id, `P-7 (liberation : ${release})`);
      assert.equal(h.engine.getDevice('P-7')!.status, release ? 'normal' : 'alarm');
    }
  });

  it("ronde incomplète (préalarme) puis manquée (alarme) : l'aggravation légitime rouvre l'alerte, mais jamais la persistance", () => {
    const h = setup();
    h.circuit(2);
    h.engine.handleDetectorMessage('P-2', { event: 'patrol_incomplete' });
    const id = h.engine.getSnapshot().incidents[0].id;
    h.runTo(30, false, { 5: () => h.engine.acknowledge(id, 'oscar') });
    assert.equal(h.view(id).status, 'acknowledged');
    h.engine.handleDetectorMessage('P-2', { event: 'patrol_missed' });
    assert.equal(h.view(id).status, 'open', 'escalade warning -> critical : alerte relancee (comportement voulu, inchange)');
    assert.equal(h.audited('incident_escalated').length, 1);
    h.engine.acknowledge(id, 'oscar');
    h.runTo(400, false);
    assertQuiet(h, id, 'P-2 apres escalade');
  });

  it("voisinage : deux agents dans la même zone, le SOS du second ne rouvre pas le SOS acquitté du premier", () => {
    const h = setup();
    h.makeAgent('moussa');
    h.makeAgent('fanta');
    h.db.prepare("UPDATE device SET zone = 'Parking' WHERE id IN ('A-moussa', 'A-fanta')").run();
    const first = h.sos('moussa');
    h.runTo(30, true, { 5: () => h.engine.acknowledge(first, 'oscar') });
    const second = h.sos('fanta');
    h.runTo(100);
    assertQuiet(h, first, 'voisin en alarme');
    assert.equal(h.view(second).status, 'open', 'le second est bien ouvert');
    assert.equal(h.view(second).confirmedAt, null, 'et non confirme par le voisin');
  });

  it("indice « probable fausse alarme » : jamais sur un SOS acquitté puis libéré en moins de hintMs", () => {
    const h = setup();
    h.makeAgent('moussa');
    const id = h.sos('moussa');
    h.runTo(40, true, { 8: () => h.engine.acknowledge(id, 'oscar') });
    assert.equal(h.engine.getDevice('A-moussa')!.status, 'normal');
    assert.equal(h.view(id).hint, null);
    assert.equal(h.audited('incident_hint').length, 0);
  });
});

// ================================================================== vrais détecteurs : inchangés

describe('vrais détecteurs : confirmation par persistance, voisinage et indice inchangés', () => {
  it("un détecteur du site nommé A-01 (contrôle d'accès) ou P-01 est confirmé par persistance, même acquitté (alerte relancée)", () => {
    for (const [id, category] of [['A-01', 'access'], ['P-01', 'energy']] as const) {
      const h = setup();
      h.makeAgent('moussa'); // des agents existent : le prefixe seul ne doit pas suffire
      h.engine.createDevice('admin', { id, kind: 'detector', name: 'Equipement du site', category });
      h.engine.handleDetectorMessage(id, { state: 'alarm' });
      const incident = h.engine.getSnapshot().incidents.find((i) => i.detectorId === id)!;
      h.runTo(60, true, { 10: () => h.engine.acknowledge(incident.id, 'oscar') });
      assert.equal(h.view(incident.id).status, 'acknowledged', `${id} : acquitte avant persistMs`);
      h.runTo(119);
      assert.equal(h.view(incident.id).status, 'acknowledged');
      h.runTo(120);
      const after = h.view(incident.id);
      assert.equal(after.confirmationReason, 'persistence', `${id} : confirme par persistance`);
      assert.equal(after.status, 'open', `${id} : l'alerte repart (non acquitte)`);
      assert.equal(h.engine.getDevice(id)!.status, 'alarm', `${id} : jamais libere par le module des agents`);
    }
  });

  it("deux vrais détecteurs de personnes de la même zone (agents présents) continuent de se confirmer par voisinage", () => {
    const h = setup();
    h.makeAgent('moussa');
    h.engine.createDevice('admin', { id: 'F-01', kind: 'detector', name: 'Detecteur de chute', category: 'people', zone: 'Hall' });
    h.engine.createDevice('admin', { id: 'F-02', kind: 'detector', name: 'Detecteur de chute 2', category: 'people', zone: 'Hall' });
    h.engine.handleDetectorMessage('F-01', { state: 'alarm' });
    h.engine.handleDetectorMessage('F-02', { state: 'alarm' });
    const byDetector = new Map(h.engine.getSnapshot().incidents.map((i) => [i.detectorId, i.confirmationReason]));
    assert.equal(byDetector.get('F-01'), 'neighbor:F-02');
    assert.equal(byDetector.get('F-02'), 'neighbor:F-01');
  });

  it("indice « probable fausse alarme » inchangé pour un vrai détecteur isolé revenu à la normale en moins de hintMs", () => {
    const h = setup();
    h.makeAgent('moussa');
    h.engine.createDevice('admin', { id: 'D-1', kind: 'detector', name: 'Fumee', category: 'fire', zone: 'Hall' });
    h.engine.handleDetectorMessage('D-1', { state: 'alarm' });
    h.clock.t += 10 * S;
    h.engine.handleDetectorMessage('D-1', { state: 'normal' });
    const i = h.engine.getSnapshot().incidents.find((x) => x.detectorId === 'D-1')!;
    assert.equal(i.hint, 'false_alarm_likely');
  });
});

// ================================================================== cycle de vie d'un SOS

describe('cycle de vie : acquittement, libération, clôture, nouveau SOS', () => {
  it("l'acquittement d'un SOS suivi de la clôture par l'exploitation fonctionne toujours (flux releaseAcknowledged)", () => {
    const h = setup();
    h.makeAgent('moussa');
    const id = h.sos('moussa');
    h.runTo(3);
    assert.throws(() => h.engine.close(id, 'oscar', 'fire', 'vrai SOS'), /toujours en alarme/);
    h.engine.acknowledge(id, 'oscar');
    h.runTo(4);
    assert.equal(h.engine.getDevice('A-moussa')!.status, 'normal');
    // Meme apres plusieurs minutes, la cloture reste possible et l'incident n'a jamais ete rouvert.
    h.runTo(500);
    assertQuiet(h, id, 'avant cloture');
    const closed = h.engine.close(id, 'oscar', 'fire', 'vrai SOS');
    assert.equal(closed.status, 'closed');
    assert.equal(closed.confirmedAt, null);
    h.runTo(700);
    assert.equal(h.view(id).status, 'closed');
  });

  it("un NOUVEAU SOS après la clôture du premier ouvre un nouvel incident (non acquitté), lui aussi à l'abri de la persistance", () => {
    const h = setup();
    h.makeAgent('moussa');
    const first = h.sos('moussa');
    h.runTo(5, true, { 2: () => h.engine.acknowledge(first, 'oscar') });
    h.engine.close(first, 'oscar', 'false_alarm', 'essai');
    h.runTo(200);
    const second = h.sos('moussa');
    assert.notEqual(second, first);
    assert.equal(h.view(second).status, 'open');
    assert.equal(h.view(second).detectorId, 'A-moussa');
    assert.equal(h.engine.getDevice('A-moussa')!.status, 'alarm');
    h.runTo(260, false, { 215: () => h.engine.acknowledge(second, 'oscar') }); // acquitte, detecteur encore en alarme > persistMs
    h.runTo(500, false);
    assert.equal(h.view(second).status, 'acknowledged');
    assert.equal(h.view(second).confirmedAt, null);
    assert.equal(h.view(first).status, 'closed');
    assert.equal(h.engine.getSnapshot().incidents.filter((i) => i.detectorId === 'A-moussa' && i.status !== 'closed').length, 1, 'un seul incident ouvert par detecteur');
  });

  it("un agent qui acquitte le SOS d'un collègue : même garantie (l'acteur n'y change rien)", () => {
    const h = setup();
    h.makeAgent('moussa');
    h.makeAgent('fanta');
    const id = h.sos('moussa');
    h.runTo(20, false, { 12: () => h.agents.ackAlarm('fanta', id) });
    h.runTo(300, false);
    assertQuiet(h, id, 'acquitte par un agent');
    assert.equal(h.view(id).ackedBy, 'fanta');
  });
});

// ================================================================== prédicat et option du moteur

describe('isVirtualDetector et option virtualDetector', () => {
  it("reconnaît les détecteurs de ce module, jamais ceux du site portant le même préfixe", () => {
    const h = setup();
    h.makeAgent('moussa');
    h.sos(null);
    h.engine.createDevice('admin', { id: 'A-01', kind: 'detector', name: 'Porte', category: 'access' });
    h.engine.createDevice('admin', { id: 'P-01', kind: 'detector', name: 'Onduleur', category: 'energy' });
    h.circuit(3);
    h.engine.createDevice('admin', { id: 'P-3b', kind: 'detector', name: 'Autre', category: 'energy' });
    h.engine.createDevice('admin', { id: 'P-30x', kind: 'detector', name: 'Autre 2', category: 'energy' });
    const check = (id: string) => isVirtualDetector(h.db, id);
    assert.equal(check('A-moussa'), true);
    assert.equal(check(`A-phone-${h.phoneId}`), true);
    assert.equal(check('P-3'), true);
    assert.equal(check('A-01'), false, 'detecteur d\'acces du site');
    assert.equal(check('P-01'), false, 'zero devant : jamais un circuit (numerotes depuis 1)');
    assert.equal(check('P-3b'), false);
    assert.equal(check('P-30x'), false);
    assert.equal(check('A-phone-99'), false, 'telephone inconnu');
    assert.equal(check('A-inconnu'), false);
    assert.equal(check('D-HALL'), false);
    assert.equal(check("A-moussa' OR 1=1 --"), false, 'paramètre lie, jamais concatene');
  });

  it("releaseAcknowledged partage le même critère : un P-01 du site n'est plus libéré, un circuit P-1 l'est", () => {
    const h = setup();
    h.circuit(1);
    h.engine.createDevice('admin', { id: 'P-01', kind: 'detector', name: 'Onduleur', category: 'energy' });
    h.engine.handleDetectorMessage('P-1', { event: 'patrol_missed' });
    h.engine.handleDetectorMessage('P-01', { state: 'alarm' });
    for (const i of h.engine.getSnapshot().incidents) h.engine.acknowledge(i.id, 'oscar');
    assert.equal(releaseAcknowledged(h.db, h.engine, 'P-'), 1);
    assert.equal(h.engine.getDevice('P-1')!.status, 'normal');
    assert.equal(h.engine.getDevice('P-01')!.status, 'alarm');
  });

  it("sans l'option (moteur seul, démos, autres tests) : comportement d'avant, tout détecteur est confirmable", () => {
    const h = setup(RULES, false);
    h.makeAgent('moussa');
    const id = h.sos('moussa');
    h.runTo(121, false);
    assert.equal(h.view(id).confirmationReason, 'persistence');
  });

  it("un prédicat qui lève une exception vaut « non virtuel » : l'alarme n'est jamais retardée ni perdue", () => {
    const errors = mock.method(console, 'error', () => {});
    try {
      const h = setup({ ...RULES, virtualDetector: () => { throw new Error('boum'); } }, false);
      h.engine.createDevice('admin', { id: 'D-1', kind: 'detector', name: 'Fumee', category: 'fire' });
      h.engine.handleDetectorMessage('D-1', { state: 'alarm' });
      assert.equal(h.engine.getSnapshot().incidents.length, 1, "l'incident est bien ouvert");
      h.runTo(121, false);
      assert.equal(h.engine.getSnapshot().incidents[0].confirmationReason, 'persistence');
      assert.ok(errors.mock.calls.length > 0, 'journalise');
    } finally {
      errors.mock.restore();
    }
  });
});
