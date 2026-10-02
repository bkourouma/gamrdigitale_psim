import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createRunner, findScenario } from '../scripts/demo/runner.ts';
import { HEIGHT, Scene, WIDTH } from '../scripts/demo/scene.ts';
import { AUTO_SEQUENCE, DEMO_CAMERAS, DEMO_DETECTORS, DEMO_HEARTBEAT_S, DEMO_SILENT_TIMEOUT_S, SCENARIOS, lastStepAt } from '../scripts/demo/scenarios.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { DEMO_DEVICES } from '../server/seed.ts';

describe('scenarios de demonstration', () => {
  it('ne referencent que des equipements et des zones du site de demonstration', () => {
    const detectors = new Set(DEMO_DEVICES.filter((d) => d.kind === 'detector').map((d) => d.id));
    const zones = new Set(DEMO_DEVICES.map((d) => d.zone));
    assert.deepEqual([...detectors].sort(), [...DEMO_DETECTORS].sort());
    for (const camera of DEMO_CAMERAS) {
      const seeded = DEMO_DEVICES.find((d) => d.id === camera.id);
      assert.equal(seeded?.kind, 'camera', camera.id);
      assert.equal(seeded?.zone, camera.zone, `zone de ${camera.id}`);
    }
    for (const scenario of SCENARIOS) {
      for (const step of scenario.steps) {
        if (step.detector) assert.ok(detectors.has(step.detector), `${scenario.id} : ${step.detector}`);
        if (step.fire) assert.ok(zones.has(step.fire.zone), `${scenario.id} : zone ${step.fire.zone}`);
        assert.ok(step.at >= 0);
      }
    }
    for (const id of AUTO_SEQUENCE) assert.ok(SCENARIOS.some((s) => s.id === id), id);
    assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length, 'identifiants uniques');
  });

  it('se retrouvent par numero ou par identifiant', () => {
    assert.equal(findScenario('1'), SCENARIOS[0]);
    assert.equal(findScenario('incendie-atelier')?.id, 'incendie-atelier');
    assert.equal(findScenario('99'), undefined);
    assert.equal(findScenario('nimporte'), undefined);
  });
});

/** Rejoue les scenarios (acceleres) contre le vrai moteur d'incidents. */
async function play(id: string) {
  const db = openDb(':memory:');
  const { seedDemo } = await import('../server/seed.ts');
  seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
  const engine = createEngine(db, () => {});
  const fire = new Map<string, number>();
  const logs: string[] = [];
  const runner = createRunner({
    publish: (detector, state) => engine.handleDetectorMessage(detector, { state }),
    setFire: (zone, level) => fire.set(zone, level),
    log: (m) => logs.push(m),
    speed: 2000,
  });
  const scenario = findScenario(id)!;
  await new Promise<void>((resolve) => runner.run(scenario, resolve));
  return { engine, fire, logs, runner, scenario };
}

describe('execution des scenarios', () => {
  it("fausse alarme : un incident d'avertissement, sans flammes a l'image", async () => {
    const { engine, fire } = await play('fausse-alarme-vapeur');
    const incidents = engine.getSnapshot().incidents;
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].severity, 'warning');
    assert.equal(engine.getDevice('D-01')?.status, 'normal');
    assert.equal(fire.get('Accueil'), 0, 'la vapeur s\'est dissipee');
  });

  it("incendie : deux incidents critiques (atelier puis entrepot), flammes dans les deux zones", async () => {
    const { engine, fire } = await play('incendie-atelier');
    const incidents = engine.getSnapshot().incidents;
    assert.deepEqual(incidents.map((i) => [i.detectorId, i.severity]).sort(), [['D-05', 'critical'], ['D-06', 'critical']]);
    assert.equal(fire.get('Atelier'), 2);
    assert.equal(fire.get('Entrepot'), 2);
    // Le feu de l'atelier est devant celui de l'entrepot dans le temps.
    const atelier = incidents.find((i) => i.detectorId === 'D-06')!;
    const entrepot = incidents.find((i) => i.detectorId === 'D-05')!;
    assert.ok(atelier.openedAt <= entrepot.openedAt);
  });

  it("alarme directe en salle serveurs : un seul incident critique, avec ses cameras", async () => {
    const { engine } = await play('surchauffe-serveurs');
    const [incident, ...rest] = engine.getSnapshot().incidents;
    assert.equal(rest.length, 0);
    assert.equal(incident.severity, 'critical');
    assert.ok(incident.cameraIds.includes('C-03'));
  });

  it("defaut et perte de contact : le statut change, aucun incident n'est cree", async () => {
    for (const id of ['defaut-detecteur', 'detecteur-hors-ligne']) {
      const { engine } = await play(id);
      assert.equal(engine.getSnapshot().incidents.length, 0, id);
      const actions = engine.listAudit(20).map((a) => a.action);
      assert.ok(actions.includes('device_state'));
    }
  });

  it('reset : feu eteint et tous les detecteurs a la normale, meme apres un incendie', async () => {
    const { engine, fire, runner } = await play('incendie-atelier');
    runner.reset(true);
    assert.ok([...fire.values()].every((level) => level === 0));
    for (const id of DEMO_DETECTORS) assert.equal(engine.getDevice(id)?.status, 'normal', id);
  });

  it('un nouveau scenario annule le precedent', async () => {
    const published: string[] = [];
    const runner = createRunner({ publish: (d, s) => void published.push(`${d}:${s}`), setFire: () => {}, log: () => {}, speed: 100 });
    runner.run(findScenario('incendie-atelier')!);
    runner.run(findScenario('defaut-detecteur')!);
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!published.some((p) => p.startsWith('D-06')), 'les evenements de l\'ancien scenario ne doivent plus partir');
    assert.ok(published.includes('D-04:fault'));
  });

  it('chaque scenario a une duree finie et coherente', () => {
    for (const scenario of SCENARIOS) assert.ok(lastStepAt(scenario) > 0 && lastStepAt(scenario) < 120, scenario.id);
  });
});

describe('rendu des images de camera', () => {
  const mean = (frame: Buffer, channel: number) => {
    let sum = 0;
    for (let i = channel; i < frame.length; i += 3) sum += frame[i];
    return sum / (frame.length / 3);
  };
  const settle = (scene: Scene) => {
    let frame = scene.render(1_000_000);
    for (let i = 0; i < 80; i++) frame = scene.render(1_000_000 + i * 125);
    return frame;
  };

  it('produit des images RGB24 de la bonne taille', () => {
    const frame = new Scene('C-99', 'Test', () => 0).render(Date.now());
    assert.equal(frame.length, WIDTH * HEIGHT * 3);
  });

  it('montre de la fumee (plus clair) puis des flammes (plus rouge) selon le niveau', () => {
    const calm = settle(new Scene('C-99', 'Test', () => 0));
    const smoke = settle(new Scene('C-99', 'Test', () => 1));
    const flames = settle(new Scene('C-99', 'Test', () => 2));
    assert.ok(mean(smoke, 1) > mean(calm, 1) + 10, 'la fumee eclaircit l\'image');
    assert.ok(mean(flames, 0) > mean(smoke, 0) + 20, 'les flammes rougissent l\'image');
    // Orange : rouge > vert > bleu (mesure : R 97, V 73, B 57 ; l'image calme est neutre, R 30, V 40, B 36).
    assert.ok(mean(flames, 0) > mean(flames, 1) + 15 && mean(flames, 1) > mean(flames, 2) + 8, 'dominante orange');
    assert.ok(mean(calm, 1) >= mean(calm, 0), 'l\'image calme n\'est pas orangee');
  });

  it('le niveau affiche suit la consigne progressivement, sans a-coup', () => {
    let target = 0;
    const scene = new Scene('C-99', 'Test', () => target);
    scene.render(0);
    target = 2;
    scene.render(125);
    assert.ok(scene.displayedFire > 0 && scene.displayedFire < 0.5, 'monte doucement');
    for (let i = 0; i < 100; i++) scene.render(250 + i * 125);
    assert.ok(scene.displayedFire > 1.95);
  });
});

describe('signal de vie et detecteur muet (demo)', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('le signal de vie rejoue periodiquement l\'etat courant de chaque detecteur', async () => {
    const seen: string[] = [];
    const runner = createRunner({ publish: (d, st) => void seen.push(`${d}:${st}`), setFire: () => {}, log: () => {}, speed: 200 });
    runner.startHeartbeat(8); // 40 ms reelles
    await wait(150);
    runner.stopHeartbeat();
    for (const id of DEMO_DETECTORS) assert.ok(seen.filter((x) => x === `${id}:normal`).length >= 2, `${id} emet regulierement`);
  });

  it('un detecteur muet n\'emet plus rien, et reprend en le signalant tout de suite', async () => {
    const seen: string[] = [];
    const runner = createRunner({ publish: (d, st) => void seen.push(`${d}:${st}`), setFire: () => {}, log: () => {}, speed: 200 });
    runner.startHeartbeat(8);
    runner.run(findScenario('detecteur-muet')!); // silence de 0 a 50 s = 250 ms reelles
    await wait(150);
    assert.ok(runner.isMuted('D-02'));
    assert.equal(seen.filter((x) => x.startsWith('D-02')).length, 0, 'rien de D-02 pendant le silence');
    assert.ok(seen.filter((x) => x.startsWith('D-01')).length >= 2, 'les autres continuent');
    await wait(250);
    runner.stopHeartbeat();
    assert.ok(!runner.isMuted('D-02'));
    assert.ok(seen.includes('D-02:normal'), 'D-02 reprend');
  });

  it('changer de scenario ou faire un reset leve tout silence en cours', () => {
    // 500x : le silence de 50 s dure 100 ms reelles, assez pour le constater avant sa fin.
    const runner = createRunner({ publish: () => {}, setFire: () => {}, log: () => {}, speed: 500 });
    runner.run(findScenario('detecteur-muet')!);
    return wait(30).then(() => {
      assert.ok(runner.isMuted('D-02'));
      runner.run(findScenario('defaut-detecteur')!);
      assert.ok(!runner.isMuted('D-02'), 'le nouveau scenario repart d\'un etat sain');
      runner.run(findScenario('detecteur-muet')!);
      return wait(30).then(() => {
        assert.ok(runner.isMuted('D-02'));
        runner.reset(true);
        assert.ok(!runner.isMuted('D-02'));
      });
    });
  });

  it('le silence du scenario depasse le delai de la demo, avec de la marge', () => {
    const scenario = findScenario('detecteur-muet')!;
    const mute = scenario.steps.find((st) => st.mute === true)!;
    const resume = scenario.steps.find((st) => st.mute === false)!;
    assert.equal(mute.detector, resume.detector);
    assert.ok(resume.at - mute.at >= DEMO_SILENT_TIMEOUT_S + 10, 'le PSIM a le temps de le declarer muet avant qu\'il ne reprenne');
    assert.ok(DEMO_HEARTBEAT_S * 3 < DEMO_SILENT_TIMEOUT_S, 'plusieurs signaux de vie manques avant de conclure');
  });

  it("de bout en bout : le moteur declare le detecteur hors ligne pendant le silence, puis il revient", async () => {
    const SPEED = 50;
    const start = Date.now();
    const virtualNow = () => 1_000_000_000_000 + (Date.now() - start) * SPEED; // temps acceleré
    const db = openDb(':memory:');
    const { seedDemo } = await import('../server/seed.ts');
    seedDemo(db, mkdtempSync(join(tmpdir(), 'psim-')), join(import.meta.dirname, '..', 'seed'));
    const engine = createEngine(db, () => {}, virtualNow, { silentTimeoutMs: DEMO_SILENT_TIMEOUT_S * 1000 });
    const runner = createRunner({
      publish: (d, st) => engine.handleDetectorMessage(d, { state: st }),
      setFire: () => {},
      log: () => {},
      speed: SPEED,
    });
    runner.reset(true);
    runner.startHeartbeat(DEMO_HEARTBEAT_S);
    const watcher = setInterval(() => engine.checkSilentDetectors(), 20);

    runner.run(findScenario('detecteur-muet')!); // 50 s virtuelles = 1 s reelle
    await wait(750); // ~37 s virtuelles : au-dela des 30 s de delai
    const during = Object.fromEntries(DEMO_DETECTORS.map((id) => [id, engine.getDevice(id)?.status]));
    await wait(550); // ~65 s virtuelles : le detecteur a repris
    const after = engine.getDevice('D-02')?.status;
    clearInterval(watcher);
    runner.stopHeartbeat();
    runner.cancel();

    assert.equal(during['D-02'], 'offline', 'le detecteur muet est declare hors ligne');
    for (const id of DEMO_DETECTORS.filter((d) => d !== 'D-02')) assert.equal(during[id], 'normal', `${id} continue d'emettre`);
    assert.equal(after, 'normal', 'il redevient normal en reprenant');
    const actions = engine.listAudit(100).filter((a) => a.deviceId === 'D-02').map((a) => a.action);
    assert.ok(actions.includes('detector_silent'));
  });
});
